import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  DpcCore,
  HandoffCoordinator,
  InMemoryPlanSource,
  InMemoryProfile,
  PostgresExecutionStore,
  PostgresHandoffStore,
  PostgresWakeStore,
  WakeCoordinator,
} from "../dist/index.js";

const { Pool } = pg;

const connectionString = process.env.DPC_POSTGRES_URL;
const id = (value) => value;

function descriptor(actionId, dependencies = []) {
  return {
    actionId: id(actionId),
    actionType: `postgres.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "postgres-test", scopes: ["execute"] },
    stopConditions: ["done"],
    waitConditions: [],
    dependencies: dependencies.map(id),
  };
}

test("PostgreSQL durable execution survives UNKNOWN recovery and dedupe", {
  skip: !connectionString,
}, async () => {
  const store = new PostgresExecutionStore({ connectionString, leaseDurationMs: 60_000 });
  await store.migrate();
  const first = descriptor("action-1");
  const second = descriptor("action-2", ["action-1"]);
  const plan = {
    programId: id(`postgres-program-${Date.now()}`),
    planId: id("postgres-plan"),
    revision: id("r1"),
    profileInput: {},
  };
  const source = new InMemoryPlanSource(plan);
  let executeCalls = 0;
  const runtime = {
    execute: async (request) => {
      executeCalls += 1;
      return { status: "UNKNOWN", evidence: [], identity: request.identity };
    },
    readback: async (request) => ({
      status: "DONE",
      evidence: [{ reference: "postgres-readback", kind: "readback", observedAt: Date.now() }],
      identity: request.identity,
    }),
  };
  const core = new DpcCore({
    plans: source,
    store,
    nf: runtime,
    recovery: runtime,
    profile: new InMemoryProfile([first, second]),
    clock: () => Date.now(),
  });
  const request = {
    programId: plan.programId,
    planId: plan.planId,
    eventKey: id("postgres-event"),
  };

  try {
    const dispatched = await core.dispatch(request);
    assert.equal(dispatched.receipt.businessStatus, "UNKNOWN");
    assert.ok((await store.listReconciliationCandidates(Date.now())).some((candidate) => candidate.kind === "UNKNOWN_RECEIPT"));
    const recovered = await core.recover(request);
    assert.equal(recovered.status, "RECOVERED");
    assert.equal(recovered.receipt.businessStatus, "COMPLETED");
    assert.equal(recovered.nextAction.actionId, "action-2");

    const duplicate = await core.dispatch(request);
    assert.equal(duplicate.status, "DUPLICATE");
    assert.equal(executeCalls, 1);
    assert.ok((await store.pendingOutbox()).length >= 2);
  } finally {
    await store.close();
  }
});

test("PostgreSQL wake and handoff stores preserve dedupe, leases, and identity", {
  skip: !connectionString,
}, async () => {
  const pool = new Pool({ connectionString });
  const execution = new PostgresExecutionStore({ pool });
  await execution.migrate();
  const wake = new PostgresWakeStore({ pool, leaseDurationMs: 10, clock: () => 1000 });
  const wakeCoordinator = new WakeCoordinator({ store: wake, clock: () => 1000 });
  const request = {
    dedupeKey: id(`postgres-wake-${Date.now()}`),
    programId: id("postgres-program-wake"),
    planId: id("postgres-plan-wake"),
    actionId: id("postgres-action-wake"),
    planRevision: id("r1"),
    triggerType: "RECOVERY",
    notBefore: 1000,
    fallbackPolicy: "manual",
  };
  const scheduled = await wakeCoordinator.schedule(request);
  const duplicate = await wakeCoordinator.schedule(request);
  assert.equal(scheduled.status, "SCHEDULED");
  assert.equal(duplicate.status, "DUPLICATE");
  const claim = await wakeCoordinator.claim(scheduled.intent.wakeId, "owner-a", 1000);
  const delivered = await wakeCoordinator.acknowledgeDelivery(claim, { status: "ACKNOWLEDGED", deliveryId: "delivery-1" });
  assert.equal(delivered.status, "DELIVERED");
  const completed = await wakeCoordinator.writeResult(claim, { status: "COMPLETED", evidenceReferences: ["receipt-1"] });
  assert.equal(completed.status, "COMPLETED");

  const handoff = new HandoffCoordinator({ store: new PostgresHandoffStore({ pool }), clock: () => 1000 });
  const input = {
    programId: id("postgres-program-handoff"),
    planId: id("postgres-plan-handoff"),
    planRevision: id("r1"),
    actionId: id("postgres-action-handoff"),
    eventKey: id("postgres-event-handoff"),
    sourceHarness: "claude",
    sourceRun: "postgres-run",
    currentStatus: "RUNNING",
    completedScope: [],
    remainingScope: ["continue"],
    acceptanceReferences: [],
    authorizationReferences: [],
    evidenceReferences: [],
    lastCheckpoint: "checkpoint-1",
    nextAction: "continue",
    unknownExternalResult: "NONE",
    workspace: { mode: "read-only", state: "CLEAN" },
    checkpointConfirmed: true,
    deliveryState: "CONFIRMED",
  };
  const bundle = await handoff.create(input);
  const accepted = await handoff.readForContinuation(bundle.handoffId, "codex", {
    programId: input.programId,
    planId: input.planId,
    planRevision: input.planRevision,
    actionId: input.actionId,
    eventKey: input.eventKey,
  });
  assert.equal(accepted.status, "ACCEPTED");
  await pool.end();
});
