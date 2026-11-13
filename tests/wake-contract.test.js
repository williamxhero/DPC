/**
 * Shared WakeStore contract suite — T4.
 *
 * These tests run against every WakeStore implementation to prove the
 * interface's invariants are met. Currently exercised against:
 *   - InMemoryWakeStore  (always)
 *   - PostgresWakeStore  (when DPC_POSTGRES_URL is set)
 *
 * Coverage areas per T4 acceptance criteria:
 *   1. One WakeIntent shape for all six trigger types
 *   2. Immutable dedupe: same dedupeKey → one canonical wake across restart
 *   3. Active lease contention throws ClaimConflictError
 *   4. Expired lease reclaim with monotonically increasing fence
 *   5. Stale owner rejection for acknowledgeDelivery and writeResult
 *   6. Durable UNKNOWN delivery — UNKNOWN status is claimable after expiry
 *   7. PostgreSQL restart: new store instance reads same intent from same DB
 */

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  ClaimConflictError,
  InMemoryWakeStore,
  PostgresExecutionStore,
  PostgresWakeStore,
  StaleWriteError,
  WakeCoordinator,
} from "../dist/index.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;
const id = (v) => v;

// ---------------------------------------------------------------------------
// Trigger types under T4
// ---------------------------------------------------------------------------
const ALL_TRIGGER_TYPES = ["MANUAL", "TIMER", "EVIDENCE", "PLAN_REVISION", "HANDOFF", "RECOVERY"];

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------
function makeInMemoryWakeStore(leaseDurationMs = 30_000, clock = () => 1000) {
  return {
    store: new InMemoryWakeStore(leaseDurationMs, clock),
    cleanup: async () => {},
    supportsRestart: false,
    makeSecondStore: null,
  };
}

function makePostgresWakeStore(pool, leaseDurationMs = 30_000, clock = () => Date.now()) {
  return {
    store: new PostgresWakeStore({ pool, leaseDurationMs, clock }),
    cleanup: async () => {},
    supportsRestart: true,
    makeSecondStore: () => new PostgresWakeStore({ pool, leaseDurationMs, clock }),
  };
}

function wakeRequest(overrides = {}) {
  const ts = Date.now();
  return {
    dedupeKey: id(`contract-wake-${ts}-${Math.random().toString(36).slice(2)}`),
    programId: id("contract-program"),
    planId: id("contract-plan"),
    planRevision: id("r1"),
    triggerType: "TIMER",
    notBefore: 1000,
    fallbackPolicy: "manual",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------
function runWakeContractSuite(label, getAdapter) {
  test(`[${label}] all six trigger types use one WakeIntent shape`, async () => {
    const { store, cleanup } = getAdapter(1000, () => 1000);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => 1000 });
      for (const triggerType of ALL_TRIGGER_TYPES) {
        const req = wakeRequest({ triggerType });
        const result = await coordinator.schedule(req);
        assert.equal(result.status, "SCHEDULED", `${triggerType} should schedule`);
        assert.equal(result.intent.triggerType, triggerType);
        assert.equal(result.intent.status, "PENDING");
        assert.equal(result.intent.attempt, 0);
        assert.ok(result.intent.wakeId, `${triggerType} wakeId must be truthy`);
        assert.ok(result.intent.dedupeKey, `${triggerType} dedupeKey must be truthy`);
        assert.equal(result.intent.programId, req.programId);
        assert.equal(result.intent.planId, req.planId);
        assert.equal(result.intent.planRevision, req.planRevision);
        assert.equal(result.intent.notBefore, req.notBefore);
        assert.equal(result.intent.fallbackPolicy, req.fallbackPolicy);
      }
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] immutable dedupe — same dedupeKey returns DUPLICATE with same wakeId`, async () => {
    const { store, cleanup } = getAdapter(30_000, () => 1000);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => 1000 });
      const req = wakeRequest();
      const first = await coordinator.schedule(req);
      const second = await coordinator.schedule(req);
      assert.equal(first.status, "SCHEDULED");
      assert.equal(second.status, "DUPLICATE");
      assert.equal(second.intent.wakeId, first.intent.wakeId);
      assert.equal(second.intent.dedupeKey, first.intent.dedupeKey);
      assert.equal(second.intent.triggerType, first.intent.triggerType);
      assert.equal(second.intent.programId, first.intent.programId);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] active lease contention — concurrent claim throws ClaimConflictError`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(30_000, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));
      // owner-a claims first
      await coordinator.claim(intent.wakeId, "owner-a", 1000);
      // owner-b must be rejected while owner-a's lease is active
      await assert.rejects(
        () => coordinator.claim(intent.wakeId, "owner-b", 1000),
        ClaimConflictError,
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] expired lease reclaim — fence increments monotonically`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(10, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));

      const first = await coordinator.claim(intent.wakeId, "owner-a", 1000);
      assert.equal(first.fence, 1, "first claim fence must be 1");

      // advance clock past lease expiry (leaseDurationMs = 10)
      now = 1011;
      const second = await coordinator.claim(intent.wakeId, "owner-b", 1011);
      assert.equal(second.fence, 2, "second claim fence must be 2 (monotonically greater)");
      assert.equal(second.ownerId, "owner-b");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] stale owner rejected for acknowledgeDelivery after reclaim`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(10, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));

      const firstClaim = await coordinator.claim(intent.wakeId, "owner-a", 1000);
      now = 1011;
      // owner-b reclaims after expiry
      await coordinator.claim(intent.wakeId, "owner-b", 1011);
      // owner-a's stale claim must be rejected
      await assert.rejects(
        () => coordinator.acknowledgeDelivery(firstClaim, { status: "ACKNOWLEDGED", deliveryId: "d-1" }),
        StaleWriteError,
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] stale owner rejected for writeResult after reclaim`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(10, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));

      const firstClaim = await coordinator.claim(intent.wakeId, "owner-a", 1000);
      now = 1011;
      await coordinator.claim(intent.wakeId, "owner-b", 1011);
      await assert.rejects(
        () => coordinator.writeResult(firstClaim, { status: "COMPLETED", evidenceReferences: [] }),
        StaleWriteError,
      );
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] UNKNOWN delivery status makes intent claimable again after expiry`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(10, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));

      const claim = await coordinator.claim(intent.wakeId, "owner-a", 1000);
      // Acknowledge delivery as UNKNOWN (delivery failed / uncertain)
      const afterAck = await coordinator.acknowledgeDelivery(claim, { status: "UNKNOWN", deliveryId: "d-unknown" });
      assert.equal(afterAck.status, "UNKNOWN");

      // Advance past lease expiry — UNKNOWN + expired lease → claimable again
      now = 1011;
      const secondClaim = await coordinator.claim(intent.wakeId, "owner-b", 1011);
      assert.equal(secondClaim.fence, 2, "fence must increase on UNKNOWN reclaim");

      // Complete the second attempt
      const done = await coordinator.writeResult(secondClaim, { status: "COMPLETED", evidenceReferences: ["ref-1"] });
      assert.equal(done.status, "COMPLETED");
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] completed wake is not in listReady`, async () => {
    let now = 1000;
    const { store, cleanup } = getAdapter(30_000, () => now);
    try {
      const coordinator = new WakeCoordinator({ store, clock: () => now });
      const req = wakeRequest({ notBefore: 1000 });
      const { intent } = (await coordinator.schedule(req));

      assert.equal((await coordinator.resolve(1000)).length, 1);

      const claim = await coordinator.claim(intent.wakeId, "owner-a", 1000);
      await coordinator.acknowledgeDelivery(claim, { status: "ACKNOWLEDGED", deliveryId: "d-1" });
      await coordinator.writeResult(claim, { status: "COMPLETED", evidenceReferences: [] });

      assert.equal((await coordinator.resolve(1000)).length, 0);
    } finally {
      await cleanup();
    }
  });

  test(`[${label}] get returns undefined for unknown wakeId`, async () => {
    const { store, cleanup } = getAdapter(30_000, () => 1000);
    try {
      const result = await store.get(id("wake:nonexistent-id"));
      assert.equal(result, undefined);
    } finally {
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Restart-durability test (PostgreSQL only — data must survive a new store instance)
// ---------------------------------------------------------------------------
function runWakeRestartTest(label, pool) {
  test(`[${label}] intent survives store restart — new instance reads same data`, {
    skip: !connectionString,
  }, async () => {
    // Store A: schedule an intent
    const storeA = new PostgresWakeStore({ pool, leaseDurationMs: 30_000, clock: () => Date.now() });
    const coordinatorA = new WakeCoordinator({ store: storeA, clock: () => Date.now() });

    const req = {
      dedupeKey: id(`restart-${Date.now()}`),
      programId: id("restart-program"),
      planId: id("restart-plan"),
      planRevision: id("r1"),
      triggerType: "RECOVERY",
      notBefore: 1000,
      fallbackPolicy: "manual",
    };
    const { intent: original } = (await coordinatorA.schedule(req));
    assert.equal(original.status, "PENDING");

    // Store B: a brand-new instance sharing the same pool (simulates process restart)
    const storeB = new PostgresWakeStore({ pool, leaseDurationMs: 30_000, clock: () => Date.now() });
    const restored = await storeB.get(original.wakeId);
    assert.ok(restored, "get() must find the intent after restart");
    assert.equal(restored.wakeId, original.wakeId);
    assert.equal(restored.dedupeKey, original.dedupeKey);
    assert.equal(restored.triggerType, original.triggerType);
    assert.equal(restored.programId, original.programId);
    assert.equal(restored.planId, original.planId);
    assert.equal(restored.planRevision, original.planRevision);
    assert.equal(restored.fallbackPolicy, original.fallbackPolicy);
    assert.equal(restored.status, "PENDING");

    // Duplicate schedule via Store B must still return DUPLICATE
    const coordinatorB = new WakeCoordinator({ store: storeB, clock: () => Date.now() });
    const dup = await coordinatorB.schedule(req);
    assert.equal(dup.status, "DUPLICATE");
    assert.equal(dup.intent.wakeId, original.wakeId);
  });

  test(`[${label}] claim and result survive restart — new instance observes final status`, {
    skip: !connectionString,
  }, async () => {
    const now = Date.now();
    const storeA = new PostgresWakeStore({ pool, leaseDurationMs: 30_000, clock: () => now });
    const coordinatorA = new WakeCoordinator({ store: storeA, clock: () => now });

    const req = {
      dedupeKey: id(`restart-claim-${now}`),
      programId: id("restart-program"),
      planId: id("restart-plan"),
      planRevision: id("r1"),
      triggerType: "HANDOFF",
      notBefore: now,
      fallbackPolicy: "manual",
    };
    const { intent } = (await coordinatorA.schedule(req));
    const claim = await coordinatorA.claim(intent.wakeId, "owner-restart", now);
    await coordinatorA.acknowledgeDelivery(claim, { status: "ACKNOWLEDGED", deliveryId: "d-restart" });
    await coordinatorA.writeResult(claim, { status: "COMPLETED", evidenceReferences: ["ref-restart"] });

    // New instance reads the final COMPLETED status
    const storeB = new PostgresWakeStore({ pool, leaseDurationMs: 30_000, clock: () => now });
    const final = await storeB.get(intent.wakeId);
    assert.ok(final, "intent must be found after claim+complete");
    assert.equal(final.status, "COMPLETED");
  });
}

// ---------------------------------------------------------------------------
// Run InMemory suite (always)
// ---------------------------------------------------------------------------
runWakeContractSuite("InMemory", (leaseDurationMs, clock) => makeInMemoryWakeStore(leaseDurationMs, clock));

// ---------------------------------------------------------------------------
// Run PostgreSQL suite (skipped if no connection string)
// ---------------------------------------------------------------------------
if (connectionString) {
  const pool = new Pool({ connectionString });

  // Migrate first (wake store shares the execution store schema)
  test("[PostgreSQL-Wake] migrate() is idempotent for wake schema", async () => {
    const execStore = new PostgresExecutionStore({ pool });
    await execStore.migrate();
    await execStore.migrate(); // second call must not throw
  });

  runWakeContractSuite("[PostgreSQL-Wake]", (leaseDurationMs, clock) => makePostgresWakeStore(pool, leaseDurationMs, clock));
  runWakeRestartTest("PostgreSQL-Wake-Restart", pool);

  // Close pool after all tests
  test("[PostgreSQL-Wake] teardown — close pool", async () => {
    await pool.end();
  });
} else {
  test("[PostgreSQL-Wake] contract suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
