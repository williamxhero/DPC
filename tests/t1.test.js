import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaimConflictError,
  DpcAdapterError,
  DpcCore,
  assessTacticalRoute,
  createAdvisoryPlanChange,
  revisionCanAffectAction,
  InMemoryActionLedger,
  HandoffBlockedError,
  HandoffCoordinator,
  InMemoryClaimAuthority,
  InMemoryHandoffStore,
  InMemoryNfRuntime,
  InMemoryPlanSource,
  InMemoryProfile,
  InMemoryProjectionAdapter,
  inspectProfileConformance,
  InMemoryWakeStore,
  NoopClaimAuthority,
  StaleWriteError,
  WakeCoordinator,
} from "../dist/index.js";

const id = (value) => value;

function descriptor(actionId, dependencies = [], overrides = {}) {
  return {
    actionId: id(actionId),
    actionType: `test.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "test-authorization", scopes: ["execute"] },
    stopConditions: ["stop-on-success"],
    waitConditions: [],
    dependencies: dependencies.map(id),
    ...overrides,
  };
}

function plan(actions, revision = "r1") {
  return {
    programId: id("program-1"),
    planId: id("plan-1"),
    revision: id(revision),
    profileInput: { actions },
  };
}

function core({ actions, nfResponse, revision = "r1", planSource, profile } = {}) {
  const source = planSource ?? new InMemoryPlanSource(plan(actions, revision));
  const ledger = new InMemoryActionLedger();
  const nf = new InMemoryNfRuntime(nfResponse ?? { status: "DONE", evidence: [] });
  const selectedProfile = profile ?? new InMemoryProfile(actions);
  return {
    source,
    ledger,
    nf,
    core: new DpcCore({ plans: source, ledger, nf, profile: selectedProfile, claims: new NoopClaimAuthority(), clock: () => 1000 }),
  };
}

test("dispatches one action, records a receipt, and returns the next eligible action", async () => {
  const first = descriptor("action-1");
  const second = descriptor("action-2", ["action-1"]);
  const setup = core({ actions: [first, second] });

  const result = await setup.core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-1"),
  });

  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.receipt.nfStatus, "DONE");
  assert.equal(result.receipt.businessStatus, "COMPLETED");
  assert.equal(result.nextAction.actionId, "action-2");
  assert.equal(setup.nf.requests.length, 1);
  assert.equal(setup.nf.requests[0].nfTaskId, "nf:trigger-1:action-1");
  assert.equal(setup.nf.requests[0].runGeneration, 1);
  assert.equal(setup.nf.requests[0].claimFence, 0);
});

test("does not execute an ineligible action when its time window has not opened", async () => {
  const setup = core({
    actions: [descriptor("future", [], { timeWindow: { notBefore: 2000 } })],
  });

  const result = await setup.core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-future"),
    now: 1000,
  });

  assert.equal(result.status, "NO_ELIGIBLE_ACTION");
  assert.equal(setup.nf.requests.length, 0);
});

test("re-reads the plan after receipt writeback before selecting the next action", async () => {
  const first = descriptor("action-1");
  const second = descriptor("action-2", ["action-1"]);
  const source = new InMemoryPlanSource(plan([first, second], "r1"));
  const ledger = new InMemoryActionLedger();
  const nf = new InMemoryNfRuntime(() => {
    source.setRevision(id("r2"));
    return { status: "DONE", evidence: [] };
  });
  const coreUnderTest = new DpcCore({
    plans: source,
    ledger,
    nf,
    profile: new InMemoryProfile([first, second]),
    claims: new NoopClaimAuthority(),
    clock: () => 1000,
  });

  const result = await coreUnderTest.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-revision"),
  });

  assert.equal(source.readCount, 2);
  assert.equal(result.planRevision, "r2");
  assert.equal(result.identity.planRevision, "r1");
  assert.equal(result.receipt.identity.planRevision, "r1");
  assert.equal(result.nextAction.actionId, "action-2");
});

test("repeating an event key is a duplicate and does not execute the NF adapter twice", async () => {
  const setup = core({ actions: [descriptor("action-1")] });
  const request = {
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("same-trigger"),
  };

  const first = await setup.core.dispatch(request);
  const second = await setup.core.dispatch(request);

  assert.equal(first.status, "DISPATCHED");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(second.identity.eventKey, first.identity.eventKey);
  assert.equal(setup.nf.requests.length, 1);
});

test("keeps NF DONE distinct from business completion when the domain gate continues", async () => {
  const action = descriptor("action-1");
  const profile = new InMemoryProfile(
    [action],
    () => ({ accepted: true, evidence: [] }),
    ({ result }) => ({
      status: result.status === "DONE" ? "CONTINUE" : result.status,
      evidence: [],
    }),
  );
  const setup = core({ actions: [action], profile });

  const result = await setup.core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-continue"),
  });

  assert.equal(result.receipt.nfStatus, "DONE");
  assert.equal(result.receipt.businessStatus, "CONTINUE");
  assert.equal(result.nextAction.actionId, "action-1");
});

test("surfaces NF adapter errors and records the failed attempt", async () => {
  const setup = core({
    actions: [descriptor("action-1")],
    nfResponse: () => {
      throw new Error("provider unavailable");
    },
  });

  await assert.rejects(
    () => setup.core.dispatch({
      programId: id("program-1"),
      planId: id("plan-1"),
      eventKey: id("trigger-error"),
    }),
    (error) => error instanceof DpcAdapterError && error.message.includes("NF adapter failed"),
  );

  const record = setup.ledger.records()[0];
  assert.equal(record.lifecycle, "FAILED");
  assert.equal(record.receipt.nfStatus, "FAILED");
  assert.equal(record.receipt.error, "provider unavailable");
});

test("fencing allows one active owner and rejects the old fence", async () => {
  const claims = new InMemoryClaimAuthority(1000);
  const identity = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-claim"),
    nfTaskId: id("nf:trigger-claim:action-1"),
    runGeneration: 1,
    claimFence: 0,
  };

  const first = await claims.claim(identity, "owner-a", 1000);
  await assert.rejects(() => claims.claim(identity, "owner-b", 1000), ClaimConflictError);
  await claims.release(first);
  const second = await claims.claim({ ...identity, runGeneration: 2 }, "owner-b", 1000);

  assert.equal(first.claimFence, 1);
  assert.equal(second.claimFence, 2);
  await assert.rejects(() => claims.assertValid(first, 1000), StaleWriteError);
  await claims.assertValid(second, 1000);
});

test("claim enforcement prevents concurrent events from executing one action twice", async () => {
  const action = descriptor("action-1");
  let releaseRuntime;
  const runtimeReleased = new Promise((resolve) => { releaseRuntime = resolve; });
  const source = new InMemoryPlanSource(plan([action]));
  const ledger = new InMemoryActionLedger();
  const nf = new InMemoryNfRuntime(async () => {
    await runtimeReleased;
    return { status: "DONE", evidence: [] };
  });
  const coreUnderTest = new DpcCore({
    plans: source,
    ledger,
    nf,
    profile: new InMemoryProfile([action]),
    claims: new InMemoryClaimAuthority(30_000, () => 1000),
    ownerId: "owner-a",
    clock: () => 1000,
  });

  const first = coreUnderTest.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-concurrent-a"),
  });
  const second = coreUnderTest.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-concurrent-b"),
  });
  await assert.rejects(second, ClaimConflictError);
  releaseRuntime();
  const firstResult = await first;

  assert.equal(firstResult.status, "DISPATCHED");
  assert.equal(nf.requests.length, 1);
});

test("core rejects a runtime result carrying an old identity", async () => {
  const action = descriptor("action-1");
  const setup = core({
    actions: [action],
    nfResponse: (request) => ({
      status: "DONE",
      evidence: [],
      identity: { ...request.identity, claimFence: request.identity.claimFence - 1 },
    }),
  });
  const claims = new InMemoryClaimAuthority(30_000, () => 1000);
  const coreWithClaims = new DpcCore({
    plans: setup.source,
    ledger: setup.ledger,
    nf: setup.nf,
    profile: new InMemoryProfile([action]),
    claims,
    ownerId: "owner-a",
    clock: () => 1000,
  });

  await assert.rejects(
    () => coreWithClaims.dispatch({
      programId: id("program-1"),
      planId: id("plan-1"),
      eventKey: id("trigger-stale"),
    }),
    StaleWriteError,
  );
  assert.equal(setup.ledger.records()[0].receipt, undefined);
});

test("unknown results are recovery-only and recovery uses readback without re-executing NF", async () => {
  const action = descriptor("action-1");
  const source = new InMemoryPlanSource(plan([action]));
  const ledger = new InMemoryActionLedger();
  const claims = new InMemoryClaimAuthority(30_000, () => 1000);
  const nf = new InMemoryNfRuntime((request) => ({
    status: "UNKNOWN",
    evidence: [],
    identity: request.identity,
  }));
  let readbackCalls = 0;
  const coreUnderTest = new DpcCore({
    plans: source,
    ledger,
    nf,
    profile: new InMemoryProfile([action]),
    claims,
    recovery: {
      readback: async (request) => {
        readbackCalls += 1;
        return readbackCalls === 1 ? undefined : {
          status: "DONE",
          evidence: [{ reference: "provider-readback", kind: "readback", observedAt: 1000 }],
          identity: request.identity,
        };
      },
    },
    clock: () => 1000,
  });

  const dispatched = await coreUnderTest.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-unknown"),
  });
  assert.equal(dispatched.receipt.businessStatus, "UNKNOWN");
  assert.equal(nf.requests.length, 1);

  const stillUnknown = await coreUnderTest.recover(id("trigger-unknown"));
  assert.equal(stillUnknown.status, "STILL_UNKNOWN");
  assert.equal(nf.requests.length, 1);

  const recovered = await coreUnderTest.recover(id("trigger-unknown"));
  assert.equal(recovered.status, "RECOVERED");
  assert.equal(recovered.receipt.businessStatus, "COMPLETED");
  assert.equal(nf.requests.length, 1);
  assert.equal(readbackCalls, 2);
});

test("core cannot turn an unknown NF outcome into business completion", async () => {
  const action = descriptor("action-1");
  const setup = core({
    actions: [action],
    nfResponse: (request) => ({ status: "UNKNOWN", evidence: [], identity: request.identity }),
    profile: new InMemoryProfile(
      [action],
      () => ({ accepted: true, evidence: [] }),
      () => ({ status: "COMPLETED", evidence: [] }),
    ),
  });

  const result = await setup.core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-unknown-profile"),
  });

  assert.equal(result.receipt.nfStatus, "UNKNOWN");
  assert.equal(result.receipt.businessStatus, "UNKNOWN");
});

test("revision scope changes only eligible not-started actions", () => {
  const revision = {
    planId: id("plan-1"),
    revision: id("r2"),
    previousRevision: id("r1"),
    source: "evidence-review",
    evidenceReferences: ["evidence-1"],
    scope: { actionIds: [id("action-2")] },
    effectiveAt: 2000,
    createdAt: 1000,
  };

  assert.equal(revisionCanAffectAction(revision, {
    actionId: id("action-2"),
    lifecycle: "NOT_STARTED",
    frozen: false,
    hasExternalEffect: false,
  }, 1999), false);
  assert.equal(revisionCanAffectAction(revision, {
    actionId: id("action-2"),
    lifecycle: "NOT_STARTED",
    frozen: false,
    hasExternalEffect: false,
  }, 2000), true);
  assert.equal(revisionCanAffectAction(revision, {
    actionId: id("action-2"),
    lifecycle: "STARTED",
    frozen: false,
    hasExternalEffect: false,
  }, 2000), false);
  assert.equal(revisionCanAffectAction(revision, {
    actionId: id("action-2"),
    lifecycle: "NOT_STARTED",
    frozen: true,
    hasExternalEffect: false,
  }, 2000), false);
});

test("plan changes are advisory and tactical route repetition is no progress", () => {
  const request = {
    planId: id("plan-1"),
    baseRevision: id("r1"),
    source: "nf-supervisor",
    evidenceReferences: ["evidence-route"],
    requestedChanges: ["increase evidence window"],
    impactedActionIds: [id("action-2")],
    rationale: "The current route has insufficient evidence",
  };
  const proposal = createAdvisoryPlanChange(request, 1000);
  assert.equal(proposal.status, "ADVISORY");
  assert.equal(proposal.baseRevision, "r1");
  assert.equal(proposal.requestedChanges[0], "increase evidence window");

  const route = {
    routeKey: "route-a",
    expectedEvidence: ["signal-a"],
    expectedSignals: ["signal-b"],
    risks: ["quota"],
    fallback: "stop",
    successConditions: ["signal-a"],
    stopConditions: ["unknown"],
  };
  assert.equal(assessTacticalRoute(route, new Set()).status, "NEW");
  assert.equal(assessTacticalRoute(route, new Set(["route-a"])).status, "NO_PROGRESS");
});

test("wake intent dedupe provides one canonical schedule and pull-first delivery", async () => {
  const store = new InMemoryWakeStore(10, () => 1000);
  const coordinator = new WakeCoordinator({ store, clock: () => 1000 });
  const request = {
    dedupeKey: id("daily:program-1:2026-11-12"),
    programId: id("program-1"),
    planId: id("plan-1"),
    actionId: id("action-1"),
    planRevision: id("r1"),
    triggerType: "TIMER",
    notBefore: 1000,
    preferredHarness: "codex",
    fallbackPolicy: "manual",
  };

  const scheduled = await coordinator.schedule(request);
  const duplicate = await coordinator.schedule(request);
  assert.equal(scheduled.status, "SCHEDULED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(scheduled.intent.wakeId, duplicate.intent.wakeId);
  assert.equal((await coordinator.resolve(1000)).length, 1);

  const firstClaim = await coordinator.claim(scheduled.intent.wakeId, "owner-a", 1000);
  const delivered = await coordinator.acknowledgeDelivery(firstClaim, {
    status: "UNKNOWN",
    deliveryId: "delivery-a",
  });
  assert.equal(delivered.status, "UNKNOWN");

  const secondClaim = await coordinator.claim(scheduled.intent.wakeId, "owner-b", 1011);
  await assert.rejects(
    () => coordinator.writeResult(firstClaim, { status: "COMPLETED", evidenceReferences: [] }),
    StaleWriteError,
  );
  const completed = await coordinator.writeResult(secondClaim, {
    status: "COMPLETED",
    evidenceReferences: ["receipt-1"],
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal((await coordinator.resolve(1011)).length, 0);
});

test("handoff transfers a verified checkpoint without changing action identity", async () => {
  const coordinator = new HandoffCoordinator({
    store: new InMemoryHandoffStore(),
    clock: () => 1000,
  });
  const input = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-handoff"),
    sourceHarness: "claude",
    sourceRun: "run-1",
    currentStatus: "RUNNING",
    completedScope: ["collect evidence"],
    remainingScope: ["interpret evidence"],
    acceptanceReferences: ["acceptance-1"],
    authorizationReferences: ["authorization-1"],
    evidenceReferences: ["evidence-1"],
    lastCheckpoint: "checkpoint-1",
    nextAction: "interpret evidence",
    unknownExternalResult: "NONE",
    workspace: { mode: "artifact", state: "CLEAN", reference: "artifact-1" },
    checkpointConfirmed: true,
    deliveryState: "CONFIRMED",
  };

  const created = await coordinator.create(input);
  const continued = await coordinator.readForContinuation(
    created.handoffId,
    "codex",
    id("r1"),
    id("action-1"),
  );

  assert.equal(created.status, "READY");
  assert.equal(continued.status, "ACCEPTED");
  assert.equal(continued.acceptedBy, "codex");
  assert.equal(continued.actionId, "action-1");
  assert.equal(continued.eventKey, "trigger-handoff");
});

test("unconfirmed, dirty, and unknown handoffs are blocked from continuation", async () => {
  const coordinator = new HandoffCoordinator({ store: new InMemoryHandoffStore(), clock: () => 1000 });
  const base = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-blocked"),
    sourceHarness: "claude",
    sourceRun: "run-blocked",
    currentStatus: "RUNNING",
    completedScope: [],
    remainingScope: ["continue"],
    acceptanceReferences: [],
    authorizationReferences: [],
    evidenceReferences: [],
    lastCheckpoint: "checkpoint-unknown",
    unknownExternalResult: "NONE",
    workspace: { mode: "read-only", state: "DIRTY" },
    checkpointConfirmed: false,
    deliveryState: "UNKNOWN",
  };
  const blocked = await coordinator.create(base);
  assert.equal(blocked.status, "BLOCKED");
  await assert.rejects(
    () => coordinator.readForContinuation(blocked.handoffId, "grok", id("r1"), id("action-1")),
    HandoffBlockedError,
  );
});

test("the Standard Kit applies the same profile conformance checks to two profiles", () => {
  const action = descriptor("action-1");
  const currentPlan = plan([action]);
  const first = inspectProfileConformance(new InMemoryProfile([action]), currentPlan, "profile-a");
  const second = inspectProfileConformance(new InMemoryProfile([action]), currentPlan, "profile-b");

  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
  assert.deepEqual(first.checks.map((check) => check.name), second.checks.map((check) => check.name));
});

test("projection drift is observable without changing the authoritative view", async () => {
  const projection = new InMemoryProjectionAdapter();
  const original = {
    planId: id("plan-1"),
    revision: id("r1"),
    authoritativeDigest: "digest-r1",
    actionSummaries: ["action-1"],
    evidenceReferences: ["evidence-1"],
  };
  await projection.publish(original);
  const authoritative = { ...original, revision: id("r2"), authoritativeDigest: "digest-r2" };
  const drift = await projection.compare(authoritative);

  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.fields, ["revision", "authoritativeDigest"]);
  assert.deepEqual(await projection.read(id("plan-1")), original);
});
