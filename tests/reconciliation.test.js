/**
 * T3: Reconciliation candidate discovery
 *
 * Proves:
 *   1. listReconciliationCandidates lists UNKNOWN receipts
 *   2. listReconciliationCandidates lists STARTED executions without receipts
 *   3. listReconciliationCandidates lists expired claims
 *   4. Reconciliation discovery never invokes an external action
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
  ReconciliationRunner,
} from "../dist/index.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;

const id = (v) => v;

function makeDescriptor(actionId, deps = []) {
  return {
    actionId: id(actionId),
    actionType: `reconciliation.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "reconciliation-test", scopes: ["execute"] },
    stopConditions: ["done"],
    waitConditions: [],
    dependencies: deps.map(id),
  };
}

function makeStore(impl) {
  if (impl === "memory") {
    return { store: new InMemoryDurableStore({ leaseDurationMs: 1000 }), cleanup: async () => {} };
  }
  if (impl === "postgres") {
    const pool = new Pool({ connectionString });
    const store = new PostgresExecutionStore({ pool, leaseDurationMs: 1000 });
    return {
      store,
      cleanup: async () => { await pool.end(); },
    };
  }
  throw new Error(`Unknown impl: ${impl}`);
}

function runReconciliationSuite(label, getStore) {
  test(`[${label}] reconciliation lists UNKNOWN receipts`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recon-prog-unknown-${ts}-${label}`),
        planId: id("recon-plan-unknown"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-unknown");
      const profile = new InMemoryProfile([descriptor]);

      const runtime = {
        execute: async (req) => {
          return { status: "UNKNOWN", evidence: [], identity: req.identity };
        },
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`unknown-event-${ts}`);
      await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });

      const runner = new ReconciliationRunner(store);
      const candidates = await runner.scan(Date.now());

      const unknown = candidates.filter((c) => c.kind === "UNKNOWN_RECEIPT");
      assert.ok(unknown.length > 0, "must discover at least one UNKNOWN receipt");
      const candidate = unknown.find((c) => c.eventKey === eventKey);
      assert.ok(candidate, "must discover the UNKNOWN receipt we just created");
      assert.equal(candidate.programId, plan.programId);
      assert.equal(candidate.planId, plan.planId);
      assert.equal(candidate.actionId, descriptor.actionId);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] reconciliation lists STARTED executions without receipts`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`recon-prog-started-${ts}-${label}`);
      const planId = id("recon-plan-started");
      const actionId = id("action-started");
      const eventKey = id(`started-event-${ts}`);
      const planRevision = id("r1");
      const nfTaskId = id(`nf-task-${ts}`);

      // Create a STARTED execution without a receipt by bypassing Core
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };
      const descriptor = makeDescriptor(actionId);
      const claimed = await store.claim(identity, "owner-a", Date.now());
      await store.beginExecution(claimed, descriptor);
      // Do NOT append a receipt — leave it in STARTED state

      const runner = new ReconciliationRunner(store);
      const candidates = await runner.scan(Date.now());

      const started = candidates.filter((c) => c.kind === "STARTED_WITHOUT_RECEIPT");
      assert.ok(started.length > 0, "must discover at least one STARTED without receipt");
      const candidate = started.find((c) => c.eventKey === eventKey);
      assert.ok(candidate, "must discover the STARTED execution we just created");
      assert.equal(candidate.programId, programId);
      assert.equal(candidate.planId, planId);
      assert.equal(candidate.actionId, actionId);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] reconciliation lists expired claims`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const programId = id(`recon-prog-expired-${ts}-${label}`);
      const planId = id("recon-plan-expired");
      const actionId = id("action-expired");
      const eventKey = id(`expired-event-${ts}`);
      const planRevision = id("r1");
      const nfTaskId = id(`nf-task-expired-${ts}`);

      // Create a claim that expires immediately
      const identity = { programId, planId, planRevision, actionId, eventKey, nfTaskId, runGeneration: 1, claimFence: 0 };
      const descriptor = makeDescriptor(actionId);
      const claimed = await store.claim(identity, "owner-a", ts);
      await store.beginExecution(claimed, descriptor);

      // Wait for the claim to expire (lease duration is 1000ms for InMemory)
      const futureNow = ts + 2000;

      const runner = new ReconciliationRunner(store);
      const candidates = await runner.scan(futureNow);

      const expired = candidates.filter((c) => c.kind === "EXPIRED_CLAIM");
      assert.ok(expired.length > 0, "must discover at least one expired claim");
      const candidate = expired.find((c) => c.eventKey === eventKey);
      assert.ok(candidate, "must discover the expired claim we just created");
      assert.equal(candidate.programId, programId);
      assert.equal(candidate.planId, planId);
      assert.equal(candidate.actionId, actionId);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] reconciliation scan never invokes NF execute`, async () => {
    const { store, cleanup } = getStore();
    try {
      await store.migrate();
      const ts = Date.now();
      const plan = {
        programId: id(`recon-prog-noinvoke-${ts}-${label}`),
        planId: id("recon-plan-noinvoke"),
        revision: id("r1"),
        profileInput: {},
      };
      const descriptor = makeDescriptor("action-noinvoke");
      const profile = new InMemoryProfile([descriptor]);

      let nfExecuteCalls = 0;
      const runtime = {
        execute: async (req) => {
          nfExecuteCalls += 1;
          return { status: "UNKNOWN", evidence: [], identity: req.identity };
        },
      };

      const source = new InMemoryPlanSource(plan);
      const core = new DpcCore({
        plans: source,
        ledger: store,
        claims: store,
        nf: runtime,
        profile,
        clock: () => Date.now(),
      });

      const eventKey = id(`noinvoke-event-${ts}`);
      await core.dispatch({ programId: plan.programId, planId: plan.planId, eventKey });
      const executeBefore = nfExecuteCalls;

      const runner = new ReconciliationRunner(store);
      await runner.scan(Date.now());

      assert.equal(nfExecuteCalls, executeBefore, "reconciliation scan must NOT call NF execute");
    } finally {
      await cleanup();
    }
  });
}

runReconciliationSuite("InMemory", () => makeStore("memory"));

if (connectionString) {
  runReconciliationSuite("PostgreSQL", () => makeStore("postgres"));
} else {
  test("[PostgreSQL] reconciliation suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
