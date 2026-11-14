import assert from "node:assert/strict";
import test from "node:test";
import { sameExecutionIdentity, sameStableExecutionIdentity } from "../dist/core/identity.js";
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

test("execution identity helpers distinguish full and stable identity", () => {
  const identity = makeIdentity();
  assert.equal(sameExecutionIdentity(identity, { ...identity }), true);
  assert.equal(sameStableExecutionIdentity(identity, { ...identity, claimFence: 99 }), true);
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
    assert.equal(sameStableExecutionIdentity(identity, changed), false, `${field} must be stable identity`);
  }
});
