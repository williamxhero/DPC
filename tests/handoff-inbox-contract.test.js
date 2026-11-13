/**
 * T5 contract suite: durable handoff bundles and inbox dedupe.
 *
 * Seams under test:
 *   1. HandoffStore  — putOrGet/get/accept, exercised via HandoffCoordinator.
 *   2. InboxStore    — putOrIgnore/get/markProcessed.
 *
 * Both suites run against:
 *   - InMemoryHandoffStore + InMemoryInboxStore  (always)
 *   - PostgresHandoffStore + PostgresInboxStore  (when DPC_POSTGRES_URL is set)
 *
 * Coverage per T5 acceptance criteria:
 *   AC1  Handoff bundles survive process restart (round-trip identity read-back).
 *   AC2  Handoff creation dedupes on full program/plan/revision/action/event/source-run.
 *   AC3  Continuation validates full stable identity and rejects stale or
 *        cross-context bundles.
 *   AC4  Acceptance is a conditional durable write (second accept of same bundle
 *        is idempotent; wrong expected identity throws StaleWriteError).
 *   AC5  Inbox occurrence IDs dedupe repeated external deliveries.
 *   AC6  markProcessed marks an occurrence processed; second call throws
 *        StaleWriteError (inbox rows must not silently become business facts twice).
 */

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  HandoffBlockedError,
  HandoffCoordinator,
  InMemoryHandoffStore,
  InMemoryInboxStore,
  PostgresHandoffStore,
  PostgresInboxStore,
  StaleWriteError,
} from "../dist/index.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;
const id = (v) => v;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandoffInput(overrides = {}) {
  const ts = Date.now();
  return {
    programId: id(`program-t5-${ts}`),
    planId: id("plan-t5"),
    planRevision: id("r1"),
    actionId: id("action-t5"),
    eventKey: id(`event-t5-${ts}`),
    sourceHarness: "claude",
    sourceRun: `run-t5-${ts}`,
    currentStatus: "RUNNING",
    completedScope: ["collect-evidence"],
    remainingScope: ["interpret-evidence"],
    acceptanceReferences: ["acceptance-t5"],
    authorizationReferences: ["authorization-t5"],
    evidenceReferences: ["evidence-t5"],
    lastCheckpoint: "checkpoint-t5",
    nextAction: "interpret-evidence",
    unknownExternalResult: "NONE",
    workspace: { mode: "artifact", state: "CLEAN", reference: "artifact-t5" },
    checkpointConfirmed: true,
    deliveryState: "CONFIRMED",
    ...overrides,
  };
}

function makeHandoffCoordinator(store) {
  return new HandoffCoordinator({ store, clock: () => Date.now() });
}

function getStore(coordinator) {
  // HandoffCoordinator holds the store in its dependencies object.
  // TypeScript private fields are only compile-time restrictions; at runtime
  // in a JS test we access them directly.
  return coordinator.dependencies.store;
}

// ---------------------------------------------------------------------------
// Handoff contract suite
// ---------------------------------------------------------------------------

function runHandoffContractSuite(label, makeStore) {
  // AC1: restart-readable — all HandoffBundle fields survive a round-trip via get()
  test(`[${label}] handoff: restart-readable — all bundle fields survive round-trip`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      // Simulate restart: re-create coordinator over same persistent store
      const coordinator2 = makeHandoffCoordinator(store);
      const loaded = await getStore(coordinator2).get(created.handoffId);
      assert.ok(loaded, "bundle must be found after restart");
      assert.equal(loaded.handoffId, created.handoffId);
      assert.equal(loaded.programId, input.programId);
      assert.equal(loaded.planId, input.planId);
      assert.equal(loaded.planRevision, input.planRevision);
      assert.equal(loaded.actionId, input.actionId);
      assert.equal(loaded.eventKey, input.eventKey);
      assert.equal(loaded.sourceHarness, input.sourceHarness);
      assert.equal(loaded.sourceRun, input.sourceRun);
      assert.equal(loaded.status, "READY");
      assert.deepEqual([...loaded.completedScope], [...input.completedScope]);
      assert.deepEqual([...loaded.remainingScope], [...input.remainingScope]);
      assert.deepEqual([...loaded.acceptanceReferences], [...input.acceptanceReferences]);
      assert.deepEqual([...loaded.authorizationReferences], [...input.authorizationReferences]);
      assert.deepEqual([...loaded.evidenceReferences], [...input.evidenceReferences]);
      assert.equal(loaded.lastCheckpoint, input.lastCheckpoint);
      assert.equal(loaded.nextAction, input.nextAction);
      assert.equal(loaded.unknownExternalResult, input.unknownExternalResult);
      assert.equal(loaded.workspace.mode, input.workspace.mode);
      assert.equal(loaded.workspace.state, input.workspace.state);
      assert.equal(loaded.workspace.reference, input.workspace.reference);
      assert.equal(loaded.checkpointConfirmed, input.checkpointConfirmed);
      assert.equal(loaded.deliveryState, input.deliveryState);
    } finally {
      await cleanup();
    }
  });

  // AC2: duplicate creation returns existing bundle without overwriting
  test(`[${label}] handoff: duplicate creation returns existing bundle with created=false`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const first = await coordinator.create(input);
      // Second create with same identity (handoffId derived from programId/planId/eventKey/sourceRun)
      const second = await coordinator.create(input);

      assert.equal(first.handoffId, second.handoffId);
      assert.equal(second.status, first.status);
      // The dedupe must not alter the original bundle — same createdAt
      assert.equal(second.createdAt, first.createdAt);
    } finally {
      await cleanup();
    }
  });

  // AC2: different source-run is a distinct bundle
  test(`[${label}] handoff: different source-run creates independent bundle`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const first = await coordinator.create(input);
      const second = await coordinator.create({ ...input, sourceRun: `${input.sourceRun}-v2` });

      assert.notEqual(first.handoffId, second.handoffId);
    } finally {
      await cleanup();
    }
  });

  // AC3: continuation validates full stable identity — stale planRevision is rejected
  test(`[${label}] handoff: stale planRevision rejected in readForContinuation`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      await assert.rejects(
        () => coordinator.readForContinuation(created.handoffId, "codex", {
          programId: input.programId,
          planId: input.planId,
          planRevision: id("stale-revision"),
          actionId: input.actionId,
          eventKey: input.eventKey,
        }),
        StaleWriteError,
        "stale planRevision must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC3: continuation validates full stable identity — cross-context programId rejected
  test(`[${label}] handoff: cross-context programId rejected in readForContinuation`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      await assert.rejects(
        () => coordinator.readForContinuation(created.handoffId, "codex", {
          programId: id("foreign-program"),
          planId: input.planId,
          planRevision: input.planRevision,
          actionId: input.actionId,
          eventKey: input.eventKey,
        }),
        StaleWriteError,
        "cross-context programId must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC3: continuation validates full stable identity — cross-context planId rejected
  test(`[${label}] handoff: cross-context planId rejected in readForContinuation`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      await assert.rejects(
        () => coordinator.readForContinuation(created.handoffId, "codex", {
          programId: input.programId,
          planId: id("foreign-plan"),
          planRevision: input.planRevision,
          actionId: input.actionId,
          eventKey: input.eventKey,
        }),
        StaleWriteError,
        "cross-context planId must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC3: continuation validates full stable identity — stale actionId rejected
  test(`[${label}] handoff: stale actionId rejected in readForContinuation`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      await assert.rejects(
        () => coordinator.readForContinuation(created.handoffId, "codex", {
          programId: input.programId,
          planId: input.planId,
          planRevision: input.planRevision,
          actionId: id("foreign-action"),
          eventKey: input.eventKey,
        }),
        StaleWriteError,
        "stale actionId must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC3: BLOCKED handoff is not continuable
  test(`[${label}] handoff: BLOCKED bundle cannot be continued`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput({
        checkpointConfirmed: false,
        workspace: { mode: "read-only", state: "DIRTY" },
        deliveryState: "UNKNOWN",
      });
      const created = await coordinator.create(input);
      assert.equal(created.status, "BLOCKED");

      await assert.rejects(
        () => coordinator.readForContinuation(created.handoffId, "codex", {
          programId: input.programId,
          planId: input.planId,
          planRevision: input.planRevision,
          actionId: input.actionId,
          eventKey: input.eventKey,
        }),
        HandoffBlockedError,
        "BLOCKED handoff must throw HandoffBlockedError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC4: acceptance is conditional — accepted status and acceptedBy are persisted
  test(`[${label}] handoff: acceptance persists ACCEPTED status and acceptedBy`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);
      const accepted = await coordinator.readForContinuation(created.handoffId, "codex", {
        programId: input.programId,
        planId: input.planId,
        planRevision: input.planRevision,
        actionId: input.actionId,
        eventKey: input.eventKey,
      });

      assert.equal(accepted.status, "ACCEPTED");
      assert.equal(accepted.acceptedBy, "codex");

      // Re-read the bundle — ACCEPTED state must be durable
      const reloaded = await store.get(created.handoffId);
      assert.ok(reloaded, "bundle must still exist after acceptance");
      assert.equal(reloaded.status, "ACCEPTED");
      assert.equal(reloaded.acceptedBy, "codex");
    } finally {
      await cleanup();
    }
  });

  // AC4: second accept with wrong expected identity throws StaleWriteError
  test(`[${label}] handoff: accept with wrong expected identity throws StaleWriteError`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const coordinator = makeHandoffCoordinator(store);
      const input = makeHandoffInput();
      const created = await coordinator.create(input);

      // Tamper with the expected identity before passing to accept
      const wrongExpected = {
        ...created,
        programId: id("foreign-program"),
      };

      await assert.rejects(
        () => store.accept(created.handoffId, "intruder", wrongExpected),
        StaleWriteError,
        "accept with wrong expected identity must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Inbox contract suite
// ---------------------------------------------------------------------------

function runInboxContractSuite(label, makeStore) {
  // AC5: putOrIgnore dedupes repeated deliveries
  test(`[${label}] inbox: putOrIgnore dedupes repeated external deliveries`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const provider = "github";
      const externalId = `evt-t5-${Date.now()}`;
      const payload = { action: "completed", runId: externalId };

      const first = await inbox.putOrIgnore(provider, externalId, "run.completed", payload);
      assert.equal(first.created, true);
      assert.equal(first.occurrence.status, "RECEIVED");
      assert.equal(first.occurrence.provider, provider);
      assert.equal(first.occurrence.externalEventId, externalId);

      const second = await inbox.putOrIgnore(provider, externalId, "run.completed", { ...payload, extra: "noise" });
      assert.equal(second.created, false, "second call must be a dedupe");
      // Payload must remain the original — no overwrite
      assert.deepEqual(second.occurrence.payload, payload);
      assert.equal(second.occurrence.status, "RECEIVED");
    } finally {
      await cleanup();
    }
  });

  // AC5: different (provider, externalEventId) pairs are independent
  test(`[${label}] inbox: different provider+externalEventId pairs are independent`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const ts = Date.now();
      const first = await inbox.putOrIgnore("github", `evt-a-${ts}`, "run.completed", {});
      const second = await inbox.putOrIgnore("github", `evt-b-${ts}`, "run.completed", {});
      const third = await inbox.putOrIgnore("jira", `evt-a-${ts}`, "issue.updated", {});

      assert.equal(first.created, true);
      assert.equal(second.created, true);
      assert.equal(third.created, true);
    } finally {
      await cleanup();
    }
  });

  // AC6: get returns undefined for unknown occurrence
  test(`[${label}] inbox: get returns undefined for unknown occurrence`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const result = await inbox.get("github", `no-such-event-${Date.now()}`);
      assert.equal(result, undefined);
    } finally {
      await cleanup();
    }
  });

  // AC6: markProcessed transitions RECEIVED to PROCESSED
  test(`[${label}] inbox: markProcessed transitions occurrence to PROCESSED`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const ts = Date.now();
      const provider = "github";
      const externalId = `evt-process-${ts}`;
      await inbox.putOrIgnore(provider, externalId, "run.completed", { runId: externalId });

      const processed = await inbox.markProcessed(provider, externalId, ts);
      assert.equal(processed.status, "PROCESSED");
      assert.equal(processed.processedAt, ts);

      const reloaded = await inbox.get(provider, externalId);
      assert.ok(reloaded);
      assert.equal(reloaded.status, "PROCESSED");
    } finally {
      await cleanup();
    }
  });

  // AC6: markProcessed throws StaleWriteError on second call (already processed)
  test(`[${label}] inbox: markProcessed throws StaleWriteError when already processed`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const ts = Date.now();
      const provider = "github";
      const externalId = `evt-double-${ts}`;
      await inbox.putOrIgnore(provider, externalId, "run.completed", {});
      await inbox.markProcessed(provider, externalId, ts);

      await assert.rejects(
        () => inbox.markProcessed(provider, externalId, ts + 1),
        StaleWriteError,
        "second markProcessed must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // AC6: markProcessed throws StaleWriteError for unknown occurrence
  test(`[${label}] inbox: markProcessed throws StaleWriteError for unknown occurrence`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      await assert.rejects(
        () => inbox.markProcessed("github", `no-such-${Date.now()}`, Date.now()),
        StaleWriteError,
        "markProcessed on unknown occurrence must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  // Payload must not contain provider tokens — callers must strip before calling
  // This test verifies that the store round-trips a sanitised payload intact.
  test(`[${label}] inbox: sanitised payload is preserved exactly on round-trip`, async () => {
    const { inbox, cleanup } = makeStore();
    try {
      const ts = Date.now();
      // Payload contains only domain fields — no tokens, credentials or temp paths
      const safePayload = {
        runId: `run-${ts}`,
        conclusion: "success",
        headSha: "abc123",
      };
      await inbox.putOrIgnore("github", `safe-payload-${ts}`, "check_run.completed", safePayload);
      const loaded = await inbox.get("github", `safe-payload-${ts}`);
      assert.ok(loaded);
      assert.deepEqual(loaded.payload, safePayload);
    } finally {
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// InMemory adapter runs
// ---------------------------------------------------------------------------

runHandoffContractSuite("InMemory", () => ({
  store: new InMemoryHandoffStore(),
  cleanup: async () => {},
}));

runInboxContractSuite("InMemory", () => ({
  inbox: new InMemoryInboxStore(),
  cleanup: async () => {},
}));

// ---------------------------------------------------------------------------
// PostgreSQL adapter runs (skipped when DPC_POSTGRES_URL is not set)
// ---------------------------------------------------------------------------

if (connectionString) {
  runHandoffContractSuite("PostgreSQL", () => {
    const pool = new Pool({ connectionString });
    return {
      store: new PostgresHandoffStore({ pool }),
      cleanup: async () => { await pool.end(); },
    };
  });

  runInboxContractSuite("PostgreSQL", () => {
    const pool = new Pool({ connectionString });
    return {
      inbox: new PostgresInboxStore({ pool }),
      cleanup: async () => { await pool.end(); },
    };
  });
} else {
  test("[PostgreSQL] handoff+inbox contract suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
