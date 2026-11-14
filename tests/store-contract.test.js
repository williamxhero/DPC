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
  InMemoryClaimAuthority,
  InMemoryDurableStore,
  InMemoryPlanSource,
  InMemoryProfile,
  PostgresExecutionStore,
  StaleWriteError,
} from "../dist/index.js";
import { id, makeDescriptor as makeSharedDescriptor } from "./helpers.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDescriptor(actionId, deps = []) {
  return makeSharedDescriptor(actionId, deps, "contract");
}

function makeStore(impl) {
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
    store,
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
        store,
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
        return new DpcCore({ plans: source, store, nf: runtime, profile, clock: () => Date.now() });
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
      const attempts = await Promise.allSettled([
        store.claim(identity, "owner-a", now),
        store.claim(identity, "owner-b", now),
      ]);
      const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
      const failures = attempts.filter((attempt) => attempt.status === "rejected");
      assert.equal(successes.length, 1, "exactly one concurrent claimer must win");
      assert.equal(failures.length, 1, "exactly one concurrent claimer must lose");
      assert.ok(successes[0].value.claimFence > 0, "winning fence must be positive");
      assert.ok(failures[0].reason instanceof ClaimConflictError, "loser must receive ClaimConflictError");
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
      const core = new DpcCore({ plans: source, store, nf: runtime, profile, clock: () => Date.now() });

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
      const core = new DpcCore({ plans: source, store, nf: runtime, profile, clock: () => Date.now() });

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

  test(`[${label}] T2: appendReceiptWithClaim rejects receipt with stale stable identity`, async () => {
    // INV-ID-3: a NF result carrying a stale identity (wrong planRevision or runGeneration)
    // must be rejected by appendReceiptWithClaim before any receipt is committed.
    const { store, cleanup } = getStore("stale-identity");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-si-${ts}-${label}`);
      const planId = id("contract-plan-si");
      const actionId = id("action-si");
      const eventKey = id("si-event");
      const planRevision = id("r1");
      const nfTaskId = id(`nf-si-${ts}`);
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };
      const descriptor = makeDescriptor(actionId);

      await store.beginExecution(identity, descriptor);
      const claimed = await store.claim(identity, "owner-si", Date.now());

      // Receipt that claims a different planRevision than the stored row
      const staleReceipt = {
        identity: { ...claimed, planRevision: id("stale-rev") },
        actionType: `contract.${actionId}`,
        nfStatus: "DONE",
        businessStatus: "COMPLETED",
        evidence: [],
        recordedAt: Date.now(),
      };

      await assert.rejects(
        () => store.appendReceiptWithClaim(staleReceipt, store, Date.now()),
        StaleWriteError,
        "receipt with stale planRevision must throw StaleWriteError",
      );

      // No partial write: record must still have no receipt
      const after = await store.findByEventKey(programId, planId, eventKey);
      assert.ok(after, "record must still exist");
      assert.equal(after.receipt, undefined, "no partial receipt must have been committed");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] T2: recovery retains receipt history and exact current pointer`, async () => {
    const { store, cleanup } = getStore("receipt-history");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-rh-${ts}-${label}`);
      const planId = id("contract-plan-rh");
      const actionId = id("action-rh");
      const eventKey = id(`receipt-history-event-${ts}`);
      const planRevision = id("r1");
      const nfTaskId = id(`nf-rh-${ts}`);
      const descriptor = makeDescriptor(actionId);
      const provisional = {
        programId,
        planId,
        planRevision,
        actionId,
        eventKey,
        nfTaskId,
        runGeneration: 1,
        claimFence: 0,
      };

      const recordedAt = ts;
      const firstClaim = await store.claim(provisional, "owner-rh-a", recordedAt);
      await store.beginExecution(firstClaim, descriptor);
      const unknownReceipt = {
        identity: firstClaim,
        actionType: descriptor.actionType,
        nfStatus: "UNKNOWN",
        businessStatus: "UNKNOWN",
        evidence: [],
        recordedAt,
      };
      await store.appendReceiptWithClaim(unknownReceipt, store, recordedAt);
      const afterUnknown = await store.findByEventKey(programId, planId, eventKey);
      assert.equal(afterUnknown?.receipt?.businessStatus, "UNKNOWN");
      await store.release(firstClaim);

      const recoveryClaim = await store.claim(provisional, "owner-rh-b", recordedAt + 1);
      const recoveryReceipt = {
        ...unknownReceipt,
        identity: recoveryClaim,
        nfStatus: "DONE",
        businessStatus: "COMPLETED",
        recordedAt,
      };
      await store.replaceReceiptWithClaim(firstClaim, recoveryReceipt, store, recordedAt + 1);

      const current = await store.findByEventKey(programId, planId, eventKey);
      assert.equal(current?.receipt?.businessStatus, "COMPLETED");
      assert.equal(current?.receipt?.identity.claimFence, recoveryClaim.claimFence);
      const history = await store.listReceipts(programId, planId, eventKey);
      assert.equal(history.length, 2, "the UNKNOWN receipt must remain in append-only history");
      assert.deepEqual(
        new Set(history.map((receipt) => receipt.businessStatus)),
        new Set(["UNKNOWN", "COMPLETED"]),
      );
      assert.ok(history.some((receipt) => receipt.identity.claimFence === firstClaim.claimFence));
      assert.ok(history.some((receipt) => receipt.identity.claimFence === recoveryClaim.claimFence));

      const outbox = (await store.pendingOutbox()).filter((event) => event.dedupeKey.includes(eventKey));
      assert.deepEqual(
        new Set(outbox.map((event) => event.eventType)),
        new Set(["RECEIPT_RECORDED", "RECOVERY_RESOLVED"]),
        "receipt and recovery outbox events must both be observable",
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] T2: recovery rejects replacement receipt with stale stable identity`, async () => {
    const { store, cleanup } = getStore("recovery-stable-identity");
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`contract-prog-rsi-${ts}-${label}`);
      const planId = id("contract-plan-rsi");
      const actionId = id("action-rsi");
      const eventKey = id(`recovery-stable-event-${ts}`);
      const provisional = {
        programId,
        planId,
        planRevision: id("r1"),
        actionId,
        eventKey,
        nfTaskId: id(`nf-rsi-${ts}`),
        runGeneration: 1,
        claimFence: 0,
      };
      const descriptor = makeDescriptor(actionId);
      const firstClaim = await store.claim(provisional, "owner-rsi-a", ts);
      await store.beginExecution(firstClaim, descriptor);
      const unknownReceipt = {
        identity: firstClaim,
        actionType: descriptor.actionType,
        nfStatus: "UNKNOWN",
        businessStatus: "UNKNOWN",
        evidence: [],
        recordedAt: ts,
      };
      await store.appendReceiptWithClaim(unknownReceipt, store, ts);
      await store.release(firstClaim);
      const recoveryClaim = await store.claim(provisional, "owner-rsi-b", ts + 1);
      const staleReceipt = {
        ...unknownReceipt,
        identity: { ...recoveryClaim, planRevision: id("stale-revision") },
        nfStatus: "DONE",
        businessStatus: "COMPLETED",
      };

      await assert.rejects(
        () => store.replaceReceiptWithClaim(firstClaim, staleReceipt, store, ts + 1),
        StaleWriteError,
        "replacement receipts must preserve the full stable execution identity",
      );
      const after = await store.findByEventKey(programId, planId, eventKey);
      assert.equal(after?.receipt?.businessStatus, "UNKNOWN");
      await store.release(recoveryClaim);
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
      const core = new DpcCore({ plans: source, store, nf: runtime, profile, clock: () => Date.now() });

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
runContractSuite("InMemory", () => makeStore("memory"));

// ---------------------------------------------------------------------------
// InMemoryClaimAuthority.listExpiredClaims — the public seam used by
// InMemoryDurableStore.listReconciliationCandidates (Finding 1).
// Previously the durable store reached into the private claims map via
// this.claims["claims"]; this test pins the new public method directly.
// ---------------------------------------------------------------------------
test("[InMemory] listExpiredClaims returns only expired entries, not active ones", async () => {
  const fixedClock = () => 1000;
  const authority = new InMemoryClaimAuthority(5_000, fixedClock); // 5s lease
  const now = fixedClock();

  const identity = {
    programId: id("program-exp"),
    planId: id("plan-exp"),
    planRevision: id("r1"),
    actionId: id("action-exp"),
    eventKey: id("event-exp"),
    nfTaskId: id("nf-exp"),
    runGeneration: 1,
    claimFence: 0,
  };

  // Claim at t=1000; lease expires at t=6000
  await authority.claim(identity, "owner-a", now);

  // At t=5000 the lease is still active — no expired claims
  const beforeExpiry = authority.listExpiredClaims(5000);
  assert.equal(beforeExpiry.length, 0, "must return no expired claims while lease is active");

  // At t=6000 the lease has expired (<= comparison) — the claim appears
  const atExpiry = authority.listExpiredClaims(6000);
  assert.equal(atExpiry.length, 1, "must return the expired claim at exactly the expiry time");
  assert.equal(atExpiry[0].identity.eventKey, "event-exp");

  // Well past expiry
  const afterExpiry = authority.listExpiredClaims(99_999);
  assert.equal(afterExpiry.length, 1, "must still return the expired claim long after expiry");
});

test("[InMemory] listExpiredClaims returns empty for a store with no claims", () => {
  const authority = new InMemoryClaimAuthority(30_000, () => Date.now());
  assert.equal(authority.listExpiredClaims(Date.now()).length, 0);
});

test("[InMemory] listExpiredClaims returns multiple expired claims, excludes active ones", async () => {
  const fixedClock = () => 1000;
  const authority = new InMemoryClaimAuthority(5_000, fixedClock);

  const makeIdentity = (actionId, eventKey) => ({
    programId: id("program-multi"),
    planId: id("plan-multi"),
    planRevision: id("r1"),
    actionId: id(actionId),
    eventKey: id(eventKey),
    nfTaskId: id(`nf-${eventKey}`),
    runGeneration: 1,
    claimFence: 0,
  });

  // Two claims that will both be expired at t=6000
  await authority.claim(makeIdentity("action-a", "event-a"), "owner-a", 1000);
  await authority.claim(makeIdentity("action-b", "event-b"), "owner-b", 1000);

  // Third claim at t=6000 with 5s lease → expires at 11000, active at 6000
  await authority.claim(makeIdentity("action-c", "event-c"), "owner-c", 6000);

  const expiredAt7000 = authority.listExpiredClaims(7000);
  assert.equal(expiredAt7000.length, 2, "must return exactly the two expired claims, not the active one");
  const expiredKeys = new Set(expiredAt7000.map((e) => e.identity.eventKey));
  assert.ok(expiredKeys.has("event-a"));
  assert.ok(expiredKeys.has("event-b"));
  assert.ok(!expiredKeys.has("event-c"), "active claim must not appear in expired set");
});

// ---------------------------------------------------------------------------
// Run suite against PostgresExecutionStore (skipped if no connection string)
// ---------------------------------------------------------------------------
if (connectionString) {
  runContractSuite("PostgreSQL", () => makeStore("postgres"));

  test("[PostgreSQL] concurrent migrate calls are repeat-safe", async () => {
    const firstPool = new Pool({ connectionString });
    const secondPool = new Pool({ connectionString });
    try {
      await Promise.all([
        new PostgresExecutionStore({ pool: firstPool }).migrate(),
        new PostgresExecutionStore({ pool: secondPool }).migrate(),
      ]);
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });
} else {
  test("[PostgreSQL] contract suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
