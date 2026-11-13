import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  DpcCore,
  HandoffCoordinator,
  InMemoryHandoffStore,
  WranglerKvEffectRuntime,
  InMemoryActionLedger,
  InMemoryClaimAuthority,
  InMemoryPlanSource,
  InMemoryProfile,
} from "../dist/index.js";

const enabled = process.env.DPC_CLOUDFLARE_LIVE === "1";
const required = ["CLOUDFLARE_KV_NAMESPACE_ID"];

const id = (value) => value;

test("T7 Cloudflare KV action performs a real write, readback, duplicate check, and cleanup", {
  skip: !enabled || required.some((name) => !process.env[name]),
}, async () => {
  const action = {
    actionId: id("cloudflare-kv-write"),
    actionType: "cloudflare.kv.put",
    target: {
      key: `dpc-t7/${Date.now()}-${randomUUID()}`,
      value: `DPC T7 acceptance ${randomUUID()}`,
    },
    metrics: ["kv-readback"],
    authorization: { reference: "cloudflare-t7-test", scopes: ["kv-write"] },
    stopConditions: ["readback-confirmed"],
    waitConditions: [],
    dependencies: [],
  };
  const plan = {
    programId: id("program-cloudflare-t7"),
    planId: id("plan-cloudflare-t7"),
    revision: id("r1"),
    profileInput: {},
  };
  const runtime = new WranglerKvEffectRuntime({
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
  });
  const source = new InMemoryPlanSource(plan);
  let executeCalls = 0;
  const actionRuntime = {
    execute: async (request) => {
      executeCalls += 1;
      await runtime.execute(request);
      return { status: "UNKNOWN", evidence: [], identity: request.identity };
    },
    readback: (request) => runtime.readback(request),
  };
  const core = new DpcCore({
    plans: source,
    ledger: new InMemoryActionLedger(),
    nf: actionRuntime,
    recovery: actionRuntime,
    profile: new InMemoryProfile([action]),
    claims: new InMemoryClaimAuthority(60_000),
  });
  const request = {
    programId: plan.programId,
    planId: plan.planId,
    eventKey: id(`cloudflare-event-${randomUUID()}`),
  };

  try {
    const dispatched = await core.dispatch(request);
    assert.equal(dispatched.status, "DISPATCHED");
    assert.equal(dispatched.receipt.businessStatus, "UNKNOWN");

    let recovered;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      recovered = await core.recover(request.eventKey);
      if (recovered.status === "RECOVERED") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(recovered.status, "RECOVERED");
    assert.equal(recovered.receipt.nfStatus, "DONE");
    assert.equal(recovered.receipt.businessStatus, "COMPLETED");
    assert.equal(executeCalls, 1);

    const handoff = new HandoffCoordinator({
      store: new InMemoryHandoffStore(),
    });
    const bundle = await handoff.create({
      programId: plan.programId,
      planId: plan.planId,
      planRevision: plan.revision,
      actionId: action.actionId,
      eventKey: request.eventKey,
      sourceHarness: "claude",
      sourceRun: "cloudflare-t7-run",
      currentStatus: "COMPLETED",
      completedScope: ["Cloudflare KV write and readback"],
      remainingScope: [],
      acceptanceReferences: ["T7"],
      authorizationReferences: ["cloudflare-t7-test"],
      evidenceReferences: recovered.receipt.evidence.map((entry) => entry.reference),
      lastCheckpoint: "cloudflare-readback",
      nextAction: "stop",
      unknownExternalResult: "NONE",
      workspace: { mode: "read-only", state: "CLEAN" },
      checkpointConfirmed: true,
      deliveryState: "CONFIRMED",
    });
    const continued = await handoff.readForContinuation(
      bundle.handoffId,
      "codex",
      plan.revision,
      action.actionId,
    );
    assert.equal(continued.status, "ACCEPTED");
    assert.equal(continued.acceptedBy, "codex");

    const duplicate = await core.dispatch(request);
    assert.equal(duplicate.status, "DUPLICATE");
    assert.equal(executeCalls, 1);
  } finally {
    await runtime.cleanup(action);
  }
});
