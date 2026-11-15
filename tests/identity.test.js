import assert from "node:assert/strict";
import test from "node:test";
import {
  readStableExecutionIdentity,
  sameExecutionIdentity,
  sameStableExecutionIdentity,
  toStableExecutionIdentity,
} from "../dist/core/identity.js";
import { id } from "./helpers.js";

function makeIdentity() {
  return {
    programId: id("identity-program"),
    planId: id("identity-plan"),
    planRevision: id("r1"),
    actionId: id("identity-action"),
    eventKey: id("identity-event"),
    nfTaskId: id("identity-task"),
    runGeneration: 1,
    claimFence: 7,
  };
}

test("stable projection excludes coordination fence and preserves stable identity", () => {
  const identity = makeIdentity();
  const stable = toStableExecutionIdentity(identity);

  assert.deepEqual(stable, {
    programId: identity.programId,
    planId: identity.planId,
    planRevision: identity.planRevision,
    actionId: identity.actionId,
    eventKey: identity.eventKey,
    nfTaskId: identity.nfTaskId,
    runGeneration: identity.runGeneration,
  });
  assert.equal(Object.hasOwn(stable, "claimFence"), false);
  assert.equal(
    sameStableExecutionIdentity(stable, toStableExecutionIdentity({ ...identity, claimFence: 99 })),
    true,
  );
});

test("stable marker decoding ignores a legacy claim fence", () => {
  const identity = makeIdentity();
  const decoded = readStableExecutionIdentity({ ...identity, claimFence: 42 });

  assert.deepEqual(decoded, toStableExecutionIdentity(identity));
  assert.equal(Object.hasOwn(decoded, "claimFence"), false);
});

test("execution identity helpers distinguish full and stable identity", () => {
  const identity = makeIdentity();
  assert.equal(sameExecutionIdentity(identity, { ...identity }), true);
  assert.equal(sameStableExecutionIdentity(toStableExecutionIdentity(identity), toStableExecutionIdentity({ ...identity, claimFence: 99 })), true);
  assert.equal(sameExecutionIdentity(identity, { ...identity, claimFence: 99 }), false);

  for (const field of [
    "programId",
    "planId",
    "planRevision",
    "actionId",
    "eventKey",
    "nfTaskId",
    "runGeneration",
  ]) {
    const changed = { ...identity, [field]: field === "runGeneration" ? 2 : `changed-${field}` };
    assert.equal(sameStableExecutionIdentity(toStableExecutionIdentity(identity), toStableExecutionIdentity(changed)), false, `${field} must be stable identity`);
  }
});
