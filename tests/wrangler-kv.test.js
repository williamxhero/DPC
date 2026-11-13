import assert from "node:assert/strict";
import test from "node:test";
import { WranglerKvEffectRuntime } from "../dist/index.js";

function action(key = "dpc-test/wrangler") {
  return {
    actionId: "kv-write",
    actionType: "cloudflare.kv.put",
    target: { key, value: "test-value" },
    metrics: [],
    authorization: { reference: "test", scopes: ["kv-write"] },
    stopConditions: [],
    waitConditions: [],
    dependencies: [],
  };
}

function request(effectAction = action()) {
  return {
    identity: {
      programId: "program",
      planId: "plan",
      planRevision: "r1",
      actionId: "kv-write",
      eventKey: "event-wrangler",
      nfTaskId: "nf:event-wrangler:kv-write",
      runGeneration: 1,
      claimFence: 1,
    },
    plan: { programId: "program", planId: "plan", revision: "r1", profileInput: {} },
    action: effectAction,
  };
}

test("Wrangler adapter rejects shell metacharacters in the package version", () => {
  assert.throws(
    () => new WranglerKvEffectRuntime({
      namespaceId: "namespace",
      wranglerVersion: "4.160.1 & echo INJECTED",
    }),
    /safe semantic wranglerVersion/,
  );
});

test("Wrangler adapter rejects an occupied unrecognized value", async () => {
  let puts = 0;
  const runtime = new WranglerKvEffectRuntime({
    namespaceId: "namespace",
    runner: async (args) => {
      if (args.includes("get")) return "legacy-value";
      if (args.includes("put")) {
        puts += 1;
        return "";
      }
      return "";
    },
  });

  await assert.rejects(() => runtime.execute(request()), /unrecognized value/);
  assert.equal(puts, 0);
});

test("Wrangler adapter only treats the exact remote missing-key response as absent", async () => {
  const key = "dpc-test/missing";
  const missing = new Error("wrangler failed");
  missing.stderr = `Failed to fetch https://api.cloudflare.com/client/v4/accounts/account/storage/kv/namespaces/namespace/values/${encodeURIComponent(key)} - 404: Not Found`;
  const runtime = new WranglerKvEffectRuntime({
    namespaceId: "namespace",
    runner: async (args) => {
      if (args.includes("get")) throw missing;
      return "";
    },
  });

  const result = await runtime.readback(request(action(key)));
  assert.equal(result, undefined);

  const ambiguous = new Error("provider failed");
  ambiguous.stderr = "404 Not Found from package registry";
  const unsafe = new WranglerKvEffectRuntime({
    namespaceId: "namespace",
    runner: async () => { throw ambiguous; },
  });
  await assert.rejects(() => unsafe.readback(request(action("dpc-test/ambiguous"))), /provider failed/);
});
