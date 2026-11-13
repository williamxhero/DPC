import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DpcCore,
  HandoffCoordinator,
  InMemoryActionLedger,
  InMemoryClaimAuthority,
  InMemoryHandoffStore,
  InMemoryPlanSource,
  InMemoryProfile,
  NeedsForeverLocalFileRuntime,
} from "../dist/index.js";

const enabled = process.env.DPC_NF_LIVE === "1";
const controlPath = process.env.DPC_NF_CONTROL_PATH;
const id = (value) => value;

test("T7 real Needs Forever action performs side effect, unknown recovery, duplicate dispatch, and handoff", {
  skip: !enabled || !controlPath,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-nf-live-"));
  const action = {
    actionId: id("nf-file-write"),
    actionType: "needs-forever.local.file.write",
    target: { relativePath: "result.txt", content: "DPC NF T7 acceptance\n" },
    metrics: ["file-exists"],
    authorization: { reference: "dpc-nf-t7-local", scopes: ["write-disposable-workspace"] },
    stopConditions: ["verify-passed"],
    waitConditions: [],
    dependencies: [],
  };
  const nextAction = {
    ...action,
    actionId: id("nf-next-action"),
    target: { relativePath: "next.txt", content: "next action remains unexecuted\n" },
    dependencies: [action.actionId],
  };
  const plan = {
    programId: id("program-nf-live"),
    planId: id("plan-nf-live"),
    revision: id("r1"),
    profileInput: {},
  };
  const source = new InMemoryPlanSource(plan);
  const ledger = new InMemoryActionLedger();
  const runtime = new NeedsForeverLocalFileRuntime({
    controlPath,
    rootDir: root,
    timeoutMs: 1_000,
    pollIntervalMs: 250,
    maxWorkerTurns: 8,
    maxMinutes: 5,
  });
  const claims = new InMemoryClaimAuthority(600_000);
  const core = new DpcCore({
    plans: source,
    ledger,
    nf: runtime,
    recovery: runtime,
    profile: new InMemoryProfile([action, nextAction]),
    claims,
    clock: () => Date.now(),
  });
  const request = {
    programId: plan.programId,
    planId: plan.planId,
    eventKey: id(`nf-live-${Date.now()}`),
  };
  let identity;
  try {
    const dispatched = await core.dispatch(request);
    identity = dispatched.identity;
    assert.equal(dispatched.status, "DISPATCHED");
    assert.equal(dispatched.receipt.businessStatus, "UNKNOWN");

    let recovered;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      recovered = await core.recover(request);
      if (recovered.status === "RECOVERED") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.equal(recovered.status, "RECOVERED");
    identity = recovered.identity;
    assert.equal(recovered.receipt.nfStatus, "DONE");
    assert.equal(recovered.receipt.businessStatus, "COMPLETED");
    assert.equal(recovered.nextAction.actionId, "nf-next-action");

    const handoff = new HandoffCoordinator({ store: new InMemoryHandoffStore() });
    const bundle = await handoff.create({
      programId: plan.programId,
      planId: plan.planId,
      planRevision: plan.revision,
      actionId: action.actionId,
      eventKey: request.eventKey,
      sourceHarness: "claude",
      sourceRun: "needs-forever-live",
      currentStatus: "COMPLETED",
      completedScope: ["Needs Forever worker side effect and readback"],
      remainingScope: [],
      acceptanceReferences: ["T7"],
      authorizationReferences: ["dpc-nf-t7-local"],
      evidenceReferences: recovered.receipt.evidence.map((entry) => entry.reference),
      lastCheckpoint: "nf-readback",
      nextAction: "stop",
      unknownExternalResult: "NONE",
      workspace: { mode: "read-only", state: "CLEAN" },
      checkpointConfirmed: true,
      deliveryState: "CONFIRMED",
    });
    const continued = await handoff.readForContinuation(bundle.handoffId, "codex", {
      programId: plan.programId,
      planId: plan.planId,
      planRevision: plan.revision,
      actionId: action.actionId,
      eventKey: request.eventKey,
    });
    assert.equal(continued.status, "ACCEPTED");

    const duplicate = await core.dispatch(request);
    assert.equal(duplicate.status, "DUPLICATE");
  } finally {
    if (identity) await runtime.cleanup(action, identity);
    await rm(root, { recursive: true, force: true });
  }
});
