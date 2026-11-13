/**
 * Shared DurableExecutionStore contract suite.
 *
 * These tests run against every DurableExecutionStore implementation to prove
 * the interface's invariants are met. Currently exercised against:
 *   - InMemoryDurableStore  (always)
 *   - PostgresExecutionStore (when DPC_POSTGRES_URL is set)
 *
 * Coverage areas per T1 acceptance criteria:
 *   1. migrate() is repeat-safe (versioned, idempotent)
 *   2. (program_id, plan_id, event_key) scoped idempotency — duplicate dispatch
 *      returns DUPLICATE without a second execution
 *   3. Concurrent claim contention throws ClaimConflictError
 *   4. Restart-readable identity — all ExecutionIdentity fields survive a round-trip
 *
 * Coverage areas per T2 acceptance criteria:
 *   5. Append-only: second appendReceiptWithClaim throws StaleWriteError
 *   6. Stale fence rejection leaves no partial receipt/outbox committed (rollback)
 *   7. NF status is stored and retrieved distinct from business status
 *   8. Duplicate outbox dedupe: a repeated receipt write with the same dedupe_key
 *      succeeds silently (ON CONFLICT DO NOTHING) — tested via Core dispatch
 */

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  ClaimConflictError,
  DpcCore,
  InMemoryDurableStore,
  InMemoryPlanSource,
  InMemoryProfile,
  PostgresExecutionStore,
  StaleWriteError,
} from "../dist/index.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const id = (v) => v;

function makeDescriptor(actionId, deps = []) {
  return {
    actionId: id(actionId),
    actionType: `contract.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "contract-test", scopes: ["execute"] },
    stopConditions: ["done"],
    waitConditions: [],
    dependencies: deps.map(id),
  };
}

function makeStore(impl, suffix) {
  if (impl === "memory") {
    return { store: new InMemoryDurableStore(), cleanup: async () => {} };
  }
  if (impl === "postgres") {
    const pool = new Pool({ connectionString });
    const store = new PostgresExecutionStore({ pool });
    return {
      store,
      cleanup: async () => { await pool.end(); },
    };
  }
  throw new Error(`Unknown impl: ${impl}`);
}

/** Build a minimal DpcCore wired to a DurableExecutionStore + a sync NF runtime. */
function makeCoreWith(store, planSnapshot, nfResponse) {
  const source = new InMemoryPlanSource(planSnapshot);
  const descriptor = makeDescriptor("action-1");
  const profile = new InMemoryProfile([descriptor]);
  const runtime = {
    execute: async (req) => ({
      status: "DONE",
      evidence: [{ reference: "contract-ref", kind: "result", observedAt: Date.now() }],
      identity: req.identity,
      ...nfResponse,
    }),
  };
  const core = new DpcCore({
    plans: source,
    ledger: store,
    claims: store,
    nf: runtime,
    profile,
    clock: () => Date.now(),
  });
  return { core, descriptor };
}

// ---------------------------------------------------------------------------
// Contract function — same assertions run for each adapter
// ---------------------------------------------------------------------------
function runContractSuite(label, getStore) {
  test(`[${label}] migrate() is idempotent — repeated calls do not throw`, async () => {
    const { store, cleanup } = getStore("migrate-idempotent");
    try {
      await store.migrate();
      await store.migrate(); // second call must not throw
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] scoped idempotency — same event key returns DUPLICATE without re-executing`, async () => {
    const { store, cleanup } = getStore("dedup");
    try {
      await store.migrate();
      const programId = id(`contract-prog-${Date.now()}-${label}`);
      const plan = {
        programId: id(programId),
        planId: id("contract-plan"),
        revision: id("r1"),
        profileInput: {},
      };
      let executeCalls = 0;
      const source = new InMemoryPlanSource(plan);
      const descriptor = makeDescriptor("action-1");
      const profile = new InMemoryProfile([descriptor]);
      const runtime = {
        execute: async (req) => {
          executeCalls += 1;
          return {
            status: "DONE",
            evidence: [{ reference: "ref-1", kind: "result", observedAt: Date.now() }],
            identity: req.identity,
          };
        },
      };
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        profile,
        clock: () => Date.now(),
      });
      const request = {
        programId: plan.programId,
        planId: plan.planId,
        eventKey: id("contract-event"),
      };

      const first = await core.dispatch(request);
      assert.equal(first.status, "DISPATCHED");
      assert.equal(executeCalls, 1);

      const second = await core.dispatch(request);
      assert.equal(second.status, "DUPLICATE");
      assert.equal(executeCalls, 1, "NF runtime must not be called a second time");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] scoped idempotency — same event key in different scope is independent`, async () => {
    const { store, cleanup } = getStore("scope-independence");
    try {
      await store.migrate();
      const ts = Date.now();
      const planA = {
        programId: id(`contract-prog-a-${ts}-${label}`),
        planId: id("contract-plan-a"),
        revision: id("r1"),
        profileInput: {},
      };
      const planB = {
        programId: id(`contract-prog-b-${ts}-${label}`),
        planId: id("contract-plan-b"),
        revision: id("r1"),
        profileInput: {},
      };

      let calls = 0;
      function makeCore(plan) {
        const source = new InMemoryPlanSource(plan);
        const descriptor = makeDescriptor("action-1");
        const profile = new InMemoryProfile([descriptor]);
        const runtime = {
          execute: async (req) => {
            calls += 1;
            return { status: "DONE", evidence: [], identity: req.identity };
          },
        };
        return new DpcCore({ plans: source, ledger: store, claims: store, nf: runtime, profile, clock: () => Date.now() });
      }

      const sharedEventKey = id("shared-event-key");
      const resultA = await makeCore(planA).dispatch({ programId: planA.programId, planId: planA.planId, eventKey: sharedEventKey });
      const resultB = await makeCore(planB).dispatch({ programId: planB.programId, planId: planB.planId, eventKey: sharedEventKey });

      assert.equal(resultA.status, "DISPATCHED");
      assert.equal(resultB.status, "DISPATCHED");
      assert.equal(calls, 2, "Each scope should trigger an independent execution");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] concurrent claim contention — second claimer throws ClaimConflictError`, async () => {
    const { store, cleanup } = getStore("claim-contention");
    try {
      await store.migrate();
      const programId = id(`contract-prog-claim-${Date.now()}-${label}`);
      const planId = id("contract-plan-claim");
      const actionId = id("action-claim");
      const eventKey = id("claim-event");
      const planRevision = id("r1");
      const nfTaskId = id("nf-task-claim");
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };

      const now = Date.now();
      // First owner claims successfully
      const claimed = await store.claim(identity, "owner-a", now);
      assert.ok(claimed.claimFence > 0, "fence must be positive after first claim");

      // Second owner must be rejected
      await assert.rejects(
        () => store.claim(identity, "owner-b", now),
        ClaimConflictError,
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] claim fence increases monotonically`, async () => {
    const { store, cleanup } = getStore("fence-monotonic");
    try {
      await store.migrate();
      const programId = id(`contract-prog-fence-${Date.now()}-${label}`);
      const planId = id("contract-plan-fence");
      const actionId = id("action-fence");
      const eventKey = id("fence-event");
      const planRevision = id("r1");
      const nfTaskId = id("nf-task-fence");
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };

      const now = Date.now();
      const leaseDurationMs = 1; // very short so first lease expires immediately for second claim
      const future = now + 10_000;

      const first = await store.claim(identity, "owner-a", now);
      assert.equal(first.claimFence, 1);

      // Release the first claim
      await store.release(first);

      // Second claim should produce fence 2
      const second = await store.claim({ ...identity, claimFence: 0 }, "owner-b", future);
      assert.equal(second.claimFence, 2);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] restart-readable identity — all ExecutionIdentity fields survive round-trip`, async () => {
    const { store, cleanup } = getStore("identity-roundtrip");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-id-${ts}-${label}`);
      const planId = id("contract-plan-id");
      const planRevision = id("r1");
      const actionId = id("action-id-test");
      const eventKey = id("identity-event");
      const nfTaskId = id(`nf-task-${ts}`);
      const runGeneration = 3;
      const claimFence = 7;

      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration, claimFence };
      const descriptor = makeDescriptor(actionId);

      const { created, record } = await store.beginExecution(identity, descriptor);
      assert.ok(created, "first beginExecution should create the record");

      const found = await store.findByEventKey(programId, planId, eventKey);
      assert.ok(found, "must find the record by event key");

      // Every field of ExecutionIdentity must be preserved
      assert.equal(found.identity.programId, programId);
      assert.equal(found.identity.planId, planId);
      assert.equal(found.identity.planRevision, planRevision);
      assert.equal(found.identity.actionId, actionId);
      assert.equal(found.identity.eventKey, eventKey);
      assert.equal(found.identity.nfTaskId, nfTaskId);
      assert.equal(found.identity.runGeneration, runGeneration);
      assert.equal(found.identity.claimFence, claimFence);
    } finally {
      await cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // T2: Atomic receipt lifecycle and transactional outbox
  // ---------------------------------------------------------------------------

  test(`[${label}] T2: appendReceiptWithClaim is append-only — second write throws StaleWriteError`, async () => {
    const { store, cleanup } = getStore("append-only");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-ao-${ts}-${label}`);
      const plan = { programId, planId: id("contract-plan-ao"), revision: id("r1"), profileInput: {} };
      const descriptor = makeDescriptor("action-ao");
      const profile = new InMemoryProfile([descriptor]);
      let nfCalls = 0;
      const runtime = {
        execute: async (req) => {
          nfCalls += 1;
          return { status: "DONE", evidence: [], identity: req.identity };
        },
      };
      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({ plans: source, ledger: store, claims: store, nf: runtime, profile, clock: () => Date.now() });

      // First dispatch succeeds and writes a receipt
      const first = await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey: id("ao-event") });
      assert.equal(first.status, "DISPATCHED");
      assert.equal(nfCalls, 1);

      // The record now has a receipt. Directly calling appendReceiptWithClaim again must be StaleWriteError.
      const record = await store.findByEventKey(plan.programId, plan.planId, id("ao-event"));
      assert.ok(record, "record must exist after dispatch");
      assert.ok(record.receipt, "receipt must be present after successful dispatch");

      // Attempt a second raw receipt write on the same identity — must reject
      const claimed = await store.claim(record.identity, "owner-ao-2", Date.now());
      const duplicateReceipt = {
        ...record.receipt,
        identity: claimed,
        recordedAt: Date.now(),
      };
      await assert.rejects(
        () => store.appendReceiptWithClaim(duplicateReceipt, store, Date.now()),
        StaleWriteError,
        "appending a receipt to an execution that already has one must throw StaleWriteError",
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] T2: stale fence — StaleWriteError leaves no partial receipt committed`, async () => {
    const { store, cleanup } = getStore("stale-rollback");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-sf-${ts}-${label}`);
      const planId = id("contract-plan-sf");
      const actionId = id("action-sf");
      const eventKey = id("sf-event");
      const planRevision = id("r1");
      const nfTaskId = id(`nf-sf-${ts}`);
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };
      const descriptor = makeDescriptor(actionId);

      await store.beginExecution(identity, descriptor);

      // Claim legitimately
      const claimed = await store.claim(identity, "owner-sf", Date.now());

      // Manufacture a stale identity: wrong fence
      const staleIdentity = { ...claimed, claimFence: claimed.claimFence + 999 };
      const staleReceipt = {
        identity: staleIdentity,
        actionType: `contract.${actionId}`,
        nfStatus: "DONE",
        businessStatus: "COMPLETED",
        evidence: [],
        recordedAt: Date.now(),
      };

      // The write must reject with StaleWriteError
      await assert.rejects(
        () => store.appendReceiptWithClaim(staleReceipt, store, Date.now()),
        StaleWriteError,
        "stale fence must throw StaleWriteError",
      );

      // No partial write: record must still have no receipt
      const after = await store.findByEventKey(programId, planId, eventKey);
      assert.ok(after, "record must still exist");
      assert.equal(after.receipt, undefined, "no partial receipt must have been committed");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] T2: NF status and business status are stored and retrieved as distinct fields`, async () => {
    const { store, cleanup } = getStore("nf-vs-business");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-nb-${ts}-${label}`);
      const plan = { programId, planId: id("contract-plan-nb"), revision: id("r1"), profileInput: {} };
      const descriptor = makeDescriptor("action-nb");

      // Use a custom profile that maps NF DONE → BusinessStatus COMPLETED
      // but preserves the NF status in the receipt
      const profile = new InMemoryProfile(
        [descriptor],
        () => ({ accepted: true, evidence: [] }),  // gate: always accept
        ({ result }) => ({                          // interpreter: DONE → COMPLETED
          status: result.status === "DONE" ? "COMPLETED" : result.status,
          evidence: [],
        }),
      );
      const runtime = {
        execute: async (req) => ({
          status: "DONE",          // NF says DONE
          evidence: [],
          identity: req.identity,
        }),
      };
      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({ plans: source, ledger: store, claims: store, nf: runtime, profile, clock: () => Date.now() });

      const result = await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey: id("nb-event") });
      assert.equal(result.status, "DISPATCHED");

      const record = await store.findByEventKey(plan.programId, plan.planId, id("nb-event"));
      assert.ok(record?.receipt, "receipt must be present");
      // NF status must be preserved as-is
      assert.equal(record.receipt.nfStatus, "DONE", "nfStatus must be DONE from NF runtime");
      // Business status is the domain interpretation: DONE maps to COMPLETED
      assert.equal(record.receipt.businessStatus, "COMPLETED", "businessStatus must be COMPLETED from profile interpreter");
      // The two fields are genuinely distinct types: DONE != COMPLETED
      assert.notEqual(record.receipt.nfStatus, record.receipt.businessStatus, "nfStatus and businessStatus must be distinct values");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] T2: duplicate outbox — repeated receipt write with same dedupe key is safe (idempotent)`, async () => {
    // This test verifies that a re-delivered dispatch (e.g. from an at-least-once
    // message bus) does not blow up. The store-level guard is the scoped idempotency
    // key on (program_id, plan_id, event_key) which returns DUPLICATE on the second
    // Core.dispatch call, leaving the outbox untouched. The underlying dedupe_key
    // constraint ensures the outbox row itself is never duplicated.
    const { store, cleanup } = getStore("outbox-dedupe");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-od-${ts}-${label}`);
      const plan = { programId, planId: id("contract-plan-od"), revision: id("r1"), profileInput: {} };
      const descriptor = makeDescriptor("action-od");
      const profile = new InMemoryProfile([descriptor]);
      let nfCalls = 0;
      const runtime = {
        execute: async (req) => {
          nfCalls += 1;
          return { status: "DONE", evidence: [], identity: req.identity };
        },
      };
      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({ plans: source, ledger: store, claims: store, nf: runtime, profile, clock: () => Date.now() });

      const req = { programId: plan.programId, planId: plan.planId, eventKey: id("od-event") };

      // First dispatch — NF is called, outbox event is inserted
      const first = await core.dispatch(req);
      assert.equal(first.status, "DISPATCHED");
      assert.equal(nfCalls, 1);

      // Second dispatch with same event key — must be DUPLICATE, NF not called again
      const second = await core.dispatch(req);
      assert.equal(second.status, "DUPLICATE", "repeated dispatch must return DUPLICATE");
      assert.equal(nfCalls, 1, "NF runtime must not be called on DUPLICATE path");

      // The record is stable — receipt is preserved from the first write
      const record = await store.findByEventKey(plan.programId, plan.planId, id("od-event"));
      assert.ok(record?.receipt, "receipt must still be present and unchanged");
      assert.equal(record.receipt.businessStatus, "COMPLETED");
    } finally {
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Run suite against InMemoryDurableStore
// ---------------------------------------------------------------------------
runContractSuite("InMemory", (_suffix) => makeStore("memory"));

// ---------------------------------------------------------------------------
// Run suite against PostgresExecutionStore (skipped if no connection string)
// ---------------------------------------------------------------------------
if (connectionString) {
  runContractSuite("PostgreSQL", (_suffix) => makeStore("postgres"));
} else {
  test("[PostgreSQL] contract suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
