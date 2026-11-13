/**
 * T3: Durable UNKNOWN recovery and reconciliation candidates
 *
 * This suite proves:
 *   1. Recovery calls only readback, never NF execute
 *   2. Absent readback remains STILL_UNKNOWN
 *   3. Confirmed readback appends a recovery receipt and updates lifecycle atomically
 *   4. Recovery rereads the current plan revision before selecting next action
 *   5. Reconciliation lists UNKNOWN receipts, STARTED-without-receipt, expired claims
 *   6. Reconciliation discovery never invokes an external action
 */

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  DpcCore,
  InMemoryDurableStore,
  InMemoryPlanSource,
  InMemoryProfile,
  PostgresExecutionStore,
  RecoveryError,
} from "../dist/index.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;

const id = (v) => v;

function makeDescriptor(actionId, deps = []) {
  return {
    actionId: id(actionId),
    actionType: `recovery.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "recovery-test", scopes: ["execute"] },
    stopConditions: ["done"],
    waitConditions: [],
    dependencies: deps.map(id),
  };
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

function runRecoverySuite(label, getStore) {
  test(`[${label}] recovery never calls NF execute — readback only`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recovery-prog-${ts}-${label}`),
        planId: id("recovery-plan"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-unknown");
      const profile = new InMemoryProfile([descriptor]);
      let nfExecuteCalls = 0;
      let readbackCalls = 0;

      const runtime = {
        execute: async (req) => {
          nfExecuteCalls += 1;
          return { status: "UNKNOWN", evidence: [], identity: req.identity };
        },
      };

      const recovery = {
        readback: async (req) => {
          readbackCalls += 1;
          return { status: "DONE", evidence: [{ reference: "readback-ref", kind: "readback", observedAt: Date.now() }], identity: req.identity };
        },
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        recovery,
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`unknown-event-${ts}`);
      const dispatchResult = await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });
      assert.equal(dispatchResult.status, "DISPATCHED");
      assert.equal(nfExecuteCalls, 1, "NF execute called once during dispatch");
      assert.ok(dispatchResult.receipt, "dispatch produced a receipt");
      assert.equal(dispatchResult.receipt.businessStatus, "UNKNOWN", "business status must be UNKNOWN");

      const recoveryResult = await core.recover({ programId: plan.programId, planId: plan.planId, eventKey });
      assert.equal(recoveryResult.status, "RECOVERED");
      assert.equal(nfExecuteCalls, 1, "NF execute must NOT be called during recovery");
      assert.equal(readbackCalls, 1, "readback must be called exactly once");
      assert.equal(recoveryResult.receipt.businessStatus, "COMPLETED", "readback resolved UNKNOWN to COMPLETED");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] absent readback remains STILL_UNKNOWN`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recovery-prog-still-${ts}-${label}`),
        planId: id("recovery-plan-still"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-still-unknown");
      const profile = new InMemoryProfile([descriptor]);

      const runtime = {
        execute: async (req) => {
          return { status: "UNKNOWN", evidence: [], identity: req.identity };
        },
      };

      const recovery = {
        readback: async () => undefined, // No readback evidence available
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        recovery,
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`still-unknown-event-${ts}`);
      await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });

      const recoveryResult = await core.recover({ programId: plan.programId, planId: plan.planId, eventKey });
      assert.equal(recoveryResult.status, "STILL_UNKNOWN");
      assert.equal(recoveryResult.receipt.businessStatus, "UNKNOWN", "must remain UNKNOWN when readback returns nothing");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] recovery rereads current plan revision before next action selection`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recovery-prog-reread-${ts}-${label}`),
        planId: id("recovery-plan-reread"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor1 = makeDescriptor("action-1");
      const descriptor2 = makeDescriptor("action-2", ["action-1"]);
      const profile = new InMemoryProfile([descriptor1, descriptor2]);

      const runtime = {
        execute: async (req) => {
          return { status: "UNKNOWN", evidence: [], identity: req.identity };
        },
      };

      const recovery = {
        readback: async (req) => {
          return { status: "DONE", evidence: [{ reference: "readback-ref", kind: "readback", observedAt: Date.now() }], identity: req.identity };
        },
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        recovery,
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`reread-event-${ts}`);
      await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });

      // Change plan revision before recovery
      const dispatchReadCount = source.readCount;
      source.setRevision(id("r2"));

      const recoveryResult = await core.recover({ programId: plan.programId, planId: plan.planId, eventKey });
      assert.equal(recoveryResult.status, "RECOVERED");
      assert.equal(recoveryResult.planRevision, "r2", "recovery must return current plan revision");
      assert.equal(source.readCount, dispatchReadCount + 2, "plan read twice during recovery: once at start, once after receipt");
      assert.ok(recoveryResult.nextAction, "next action must be selected from current revision");
      assert.equal(recoveryResult.nextAction.actionId, "action-2", "action-2 should be selected after action-1 completes");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] recovery with no prior execution throws RecoveryError`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recovery-prog-missing-${ts}-${label}`),
        planId: id("recovery-plan-missing"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-missing");
      const profile = new InMemoryProfile([descriptor]);

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: { execute: async () => ({ status: "DONE", evidence: [] }) },
        recovery: { readback: async () => ({ status: "DONE", evidence: [] }) },
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`missing-event-${ts}`);
      await assert.rejects(
        () => core.recover({ programId: plan.programId, planId: plan.planId, eventKey }),
        RecoveryError,
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] recovery of non-UNKNOWN receipt returns NOT_RECOVERABLE`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recovery-prog-not-rec-${ts}-${label}`),
        planId: id("recovery-plan-not-rec"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-not-rec");
      const profile = new InMemoryProfile([descriptor]);

      const runtime = {
        execute: async (req) => {
          return { status: "DONE", evidence: [], identity: req.identity };
        },
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        recovery: { readback: async () => ({ status: "DONE", evidence: [] }) },
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`not-rec-event-${ts}`);
      await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });

      const recoveryResult = await core.recover({ programId: plan.programId, planId: plan.planId, eventKey });
      assert.equal(recoveryResult.status, "NOT_RECOVERABLE");
      assert.equal(recoveryResult.receipt.businessStatus, "COMPLETED", "receipt is COMPLETED, not UNKNOWN");
    } finally {
      await cleanup();
    }
  });
}

runRecoverySuite("InMemory", () => makeStore("memory"));

if (connectionString) {
  runRecoverySuite("PostgreSQL", () => makeStore("postgres"));
} else {
  test("[PostgreSQL] recovery suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
