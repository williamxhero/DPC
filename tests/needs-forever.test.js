import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NeedsForeverLocalFileRuntime } from "../dist/index.js";

const id = (value) => value;

function action(relativePath = "result.txt") {
  return {
    actionId: id("nf-file-write"),
    actionType: "needs-forever.local.file.write",
    target: { relativePath, content: "DPC NF T7 acceptance\n" },
    metrics: ["file-exists"],
    authorization: { reference: "dpc-nf-t7-local", scopes: ["write-disposable-workspace"] },
    stopConditions: ["verify-passed"],
    waitConditions: [],
    dependencies: [],
  };
}

function request(effectAction = action()) {
  return {
    identity: {
      programId: id("program-nf"),
      planId: id("plan-nf"),
      planRevision: id("r1"),
      actionId: effectAction.actionId,
      eventKey: id("nf-event-1"),
      nfTaskId: id("nf:nf-event-1:nf-file-write"),
      runGeneration: 1,
      claimFence: 1,
    },
    plan: { programId: id("program-nf"), planId: id("plan-nf"), revision: id("r1"), profileInput: {} },
    action: effectAction,
  };
}

test("Needs Forever adapter returns UNKNOWN without re-executing and recovers by readback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-nf-adapter-"));
  const calls = [];
  try {
    const runtime = new NeedsForeverLocalFileRuntime({
      rootDir: root,
      controlPath: "C:/needs-forever/scripts/control.mjs",
      timeoutMs: 5,
      pollIntervalMs: 1,
      runner: async (args, cwd) => {
        calls.push({ args, cwd });
        if (args[0] === "start") return JSON.stringify({ launched: true, status: "ACTIVE", state_path: path.join(cwd, "state.json") });
        if (args[0] === "status") return JSON.stringify({ status: "ACTIVE", phase: "WORKER" });
        if (args[0] === "pause") return JSON.stringify({ paused: true, status: "PAUSED" });
        throw new Error(`Unexpected control command: ${args[0]}`);
      },
    });
    const original = request();
    const unknown = await runtime.execute(original);
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(calls.filter((call) => call.args[0] === "start").length, 1);
    const foreign = {
      ...original,
      identity: { ...original.identity, programId: "foreign-program" },
    };
    assert.equal(await runtime.readback(foreign), undefined);

    const workspace = path.join(root, encodeURIComponent(original.identity.nfTaskId));
    await writeFile(path.join(workspace, "result.txt"), "DPC NF T7 acceptance\n", "utf8");
    const recovered = await runtime.readback(original);
    assert.equal(recovered.status, "DONE");
    assert.equal(calls.filter((call) => call.args[0] === "start").length, 1);

    await runtime.cleanup(original.action, original.identity);
    await assert.rejects(() => readFile(workspace, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Needs Forever adapter rejects traversal targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dpc-nf-adapter-"));
  try {
    const runtime = new NeedsForeverLocalFileRuntime({
      rootDir: root,
      controlPath: "C:/needs-forever/scripts/control.mjs",
      runner: async () => JSON.stringify({ launched: true, status: "ACTIVE" }),
    });
    await assert.rejects(
      () => runtime.execute(request(action("../outside.txt"))),
      /escapes the disposable workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
