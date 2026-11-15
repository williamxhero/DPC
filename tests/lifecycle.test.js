import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReceiptTransition,
  mapBusinessStatusToActionLifecycle,
} from "../dist/core/lifecycle.js";
import {
  DpcCore,
  InMemoryDurableStore,
  InMemoryPlanSource,
  InMemoryProfile,
  StaleWriteError,
} from "../dist/index.js";

const identity = {
  programId: "program-lifecycle",
  planId: "plan-lifecycle",
  planRevision: "r1",
  actionId: "action-lifecycle",
  eventKey: "event-lifecycle",
  nfTaskId: "nf-lifecycle",
  runGeneration: 1,
  claimFence: 3,
};

function receipt(overrides = {}) {
  return {
    identity,
    actionType: "test.lifecycle",
    nfStatus: "DONE",
    businessStatus: "COMPLETED",
    evidence: [],
    recordedAt: 1000,
    ...overrides,
  };
}

function execution(overrides = {}) {
  return {
    identity,
    action: {
      actionId: identity.actionId,
      actionType: "test.lifecycle",
      target: {},
      metrics: [],
      authorization: { reference: "test", scopes: [] },
      stopConditions: [],
      waitConditions: [],
      dependencies: [],
    },
    lifecycle: "STARTED",
    ...overrides,
  };
}

test("receipt lifecycle maps every business status to its action lifecycle", () => {
  assert.deepEqual(
    Object.fromEntries([
      "CONTINUE",
      "COMPLETED",
      "WAIT_EXTERNAL",
      "FAILED",
      "UNKNOWN",
    ].map((status) => [status, mapBusinessStatusToActionLifecycle(status)])),
    {
      CONTINUE: "STARTED",
      COMPLETED: "COMPLETED",
      WAIT_EXTERNAL: "WAITING",
      FAILED: "FAILED",
      UNKNOWN: "UNKNOWN",
    },
  );
});

test("receipt lifecycle accepts first append and returns its mapped lifecycle", () => {
  const result = evaluateReceiptTransition({
    kind: "FIRST_APPEND",
    execution: execution(),
    receipt: receipt({ businessStatus: "WAIT_EXTERNAL" }),
  });

  assert.deepEqual(result, { lifecycle: "WAITING" });
});

test("receipt lifecycle rejects duplicate or stale first appends", () => {
  assert.throws(
    () => evaluateReceiptTransition({
      kind: "FIRST_APPEND",
      execution: execution({ receipt: receipt() }),
      receipt: receipt(),
    }),
    StaleWriteError,
  );

  assert.throws(
    () => evaluateReceiptTransition({
      kind: "FIRST_APPEND",
      execution: execution(),
      receipt: receipt({ identity: { ...identity, planRevision: "stale" } }),
    }),
    StaleWriteError,
  );
});

test("receipt lifecycle accepts UNKNOWN replacement after readback without changing stable identity", () => {
  const result = evaluateReceiptTransition({
    kind: "UNKNOWN_REPLACEMENT",
    execution: execution({ receipt: receipt({ nfStatus: "UNKNOWN", businessStatus: "UNKNOWN" }) }),
    expectedIdentity: identity,
    receipt: receipt({
      identity: { ...identity, claimFence: 9 },
      businessStatus: "COMPLETED",
    }),
  });

  assert.deepEqual(result, { lifecycle: "COMPLETED" });
});

test("receipt lifecycle rejects non-UNKNOWN, duplicate, and stale replacements", () => {
  assert.throws(
    () => evaluateReceiptTransition({
      kind: "UNKNOWN_REPLACEMENT",
      execution: execution({ receipt: receipt() }),
      expectedIdentity: identity,
      receipt: receipt({ identity: { ...identity, claimFence: 9 } }),
    }),
    StaleWriteError,
  );

  const unknownExecution = execution({
    receipt: receipt({ nfStatus: "UNKNOWN", businessStatus: "UNKNOWN" }),
  });
  assert.throws(
    () => evaluateReceiptTransition({
      kind: "UNKNOWN_REPLACEMENT",
      execution: unknownExecution,
      expectedIdentity: { ...identity, claimFence: identity.claimFence + 1 },
      receipt: receipt({ identity: { ...identity, claimFence: 9 }, businessStatus: "COMPLETED" }),
    }),
    StaleWriteError,
  );

  assert.throws(
    () => evaluateReceiptTransition({
      kind: "UNKNOWN_REPLACEMENT",
      execution: unknownExecution,
      expectedIdentity: identity,
      receipt: receipt({ identity: { ...identity, actionId: "other-action", claimFence: 9 } }),
    }),
    StaleWriteError,
  );

  assert.throws(
    () => evaluateReceiptTransition({
      kind: "UNKNOWN_REPLACEMENT",
      execution: unknownExecution,
      expectedIdentity: { ...identity, eventKey: "other-event" },
      receipt: receipt({ identity: { ...identity, claimFence: 9 } }),
    }),
    StaleWriteError,
  );
});

test("Core receipt lifecycle preserves mapping and selection blocking at the behavior seam", async () => {
  const cases = [
    ["CONTINUE", "STARTED", false],
    ["COMPLETED", "COMPLETED", true],
    ["WAIT_EXTERNAL", "WAITING", true],
    ["FAILED", "FAILED", true],
    ["UNKNOWN", "UNKNOWN", true],
  ];

  for (const [businessStatus, expectedLifecycle, blocksSelection] of cases) {
    const action = {
      actionId: `action-${businessStatus}`,
      actionType: "test.lifecycle",
      target: {},
      metrics: [],
      authorization: { reference: "test", scopes: [] },
      stopConditions: [],
      waitConditions: [],
      dependencies: [],
    };
    const plan = {
      programId: "program-core-lifecycle",
      planId: `plan-${businessStatus}`,
      revision: "r1",
      profileInput: {},
    };
    const store = new InMemoryDurableStore({ clock: () => 1000 });
    const core = new DpcCore({
      plans: new InMemoryPlanSource(plan),
      store,
      nf: { execute: async (request) => ({ status: "DONE", evidence: [], identity: request.identity }) },
      profile: new InMemoryProfile(
        [action],
        undefined,
        () => ({ status: businessStatus, evidence: [] }),
      ),
      clock: () => 1000,
    });

    const first = await core.dispatch({
      programId: plan.programId,
      planId: plan.planId,
      eventKey: `event-${businessStatus}`,
    });
    assert.equal(first.status, "DISPATCHED");
    const record = await store.findByEventKey(plan.programId, plan.planId, `event-${businessStatus}`);
    assert.equal(record?.lifecycle, expectedLifecycle);

    const second = await core.dispatch({
      programId: plan.programId,
      planId: plan.planId,
      eventKey: `event-${businessStatus}-second`,
    });
    assert.equal(second.status === "NO_ELIGIBLE_ACTION", blocksSelection);
  }
});
