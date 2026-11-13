import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DpcCore,
  InMemoryActionLedger,
  InMemoryClaimAuthority,
  InMemoryPlanSource,
  InMemoryProfile,
  LocalFileEffectRuntime,
} from "../dist/index.js";

const id = (value) => value;

function localAction() {
  return {
    actionId: id("local-write"),
    actionType: "local.file.write",
    target: { relativePath: "evidence/result.txt", content: "DPC local side effect\n" },
    metrics: ["file-exists"],
    authorization: { reference: "local-test", scopes: ["write-temp-file"] },
    stopConditions: ["file-written"],
    waitConditions: [],
    dependencies: [],
  };
}

function localPlan(action) {
  return {
    programId: id("program-local"),
    planId: id("plan-local"),
    revision: id("r1"),
    profileInput: {},
  };
}

test("local file adapter performs a real write, readback, idempotent replay, and cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-local-effect-"));
  try {
    const runtime = new LocalFileEffectRuntime(root);
    const action = localAction();
    const identity = {
      programId: id("program-local"),
      planId: id("plan-local"),
      planRevision: id("r1"),
      actionId: id("local-write"),
      eventKey: id("local-event"),
      nfTaskId: id("nf:local-event:local-write"),
      runGeneration: 1,
      claimFence: 1,
    };
    const request = { identity, plan: localPlan(action), action };

    const first = await runtime.execute(request);
    const repeated = await runtime.execute(request);
    const readback = await runtime.readback(request);
    const target = path.join(root, "evidence", "result.txt");

    assert.equal(first.status, "DONE");
    assert.equal(repeated.status, "DONE");
    assert.equal(readback.status, "DONE");
    assert.equal(await readFile(target, "utf8"), "DPC local side effect\n");
    assert.equal(first.identity.eventKey, "local-event");

    await runtime.cleanup(action);
    await assert.rejects(() => readFile(target, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DPC recovers an unknown local submission through readback without executing again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-local-recovery-"));
  try {
    const action = localAction();
    const source = new InMemoryPlanSource(localPlan(action));
    const ledger = new InMemoryActionLedger();
    const sideEffect = new LocalFileEffectRuntime(root);
    let executeCalls = 0;
    const runtime = {
      execute: async (request) => {
        executeCalls += 1;
        await sideEffect.execute(request);
        return { status: "UNKNOWN", evidence: [], identity: request.identity };
      },
      readback: (request) => sideEffect.readback(request),
    };
    const core = new DpcCore({
      plans: source,
      ledger,
      nf: runtime,
      recovery: runtime,
      profile: new InMemoryProfile([action]),
      claims: new InMemoryClaimAuthority(30_000, () => 1000),
      clock: () => 1000,
    });
    const request = {
      programId: id("program-local"),
      planId: id("plan-local"),
      eventKey: id("local-unknown-event"),
    };

    const first = await core.dispatch(request);
    const recovered = await core.recover(request.eventKey);
    const target = path.join(root, "evidence", "result.txt");

    assert.equal(first.receipt.businessStatus, "UNKNOWN");
    assert.equal(recovered.status, "RECOVERED");
    assert.equal(recovered.receipt.businessStatus, "COMPLETED");
    assert.equal(executeCalls, 1);
    assert.equal(await readFile(target, "utf8"), "DPC local side effect\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DPC dispatch records the real local side effect and prevents duplicate dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-local-dispatch-"));
  try {
    const action = localAction();
    const source = new InMemoryPlanSource(localPlan(action));
    const ledger = new InMemoryActionLedger();
    const runtime = new LocalFileEffectRuntime(root);
    const core = new DpcCore({
      plans: source,
      ledger,
      nf: runtime,
      profile: new InMemoryProfile([action]),
      claims: new InMemoryClaimAuthority(30_000, () => 1000),
      clock: () => 1000,
    });
    const request = {
      programId: id("program-local"),
      planId: id("plan-local"),
      eventKey: id("dispatch-local-event"),
    };

    const first = await core.dispatch(request);
    const duplicate = await core.dispatch(request);
    const target = path.join(root, "evidence", "result.txt");

    assert.equal(first.status, "DISPATCHED");
    assert.equal(first.receipt.nfStatus, "DONE");
    assert.equal(duplicate.status, "DUPLICATE");
    assert.equal(await readFile(target, "utf8"), "DPC local side effect\n");
    assert.equal(ledger.records().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
