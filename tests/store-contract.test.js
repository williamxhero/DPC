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
