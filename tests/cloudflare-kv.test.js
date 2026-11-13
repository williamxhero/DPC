import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareKvEffectRuntime } from "../dist/index.js";

function response(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("Cloudflare KV adapter uses identity envelopes and idempotent replay", async () => {
  const values = new Map();
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(url.split("/").at(-1));
    if (init.method === "GET") return values.has(key) ? response(200, values.get(key)) : response(404);
    if (init.method === "PUT") {
      values.set(key, init.body);
      return response(200, JSON.stringify({ success: true }));
    }
    if (init.method === "DELETE") {
      values.delete(key);
      return response(204);
    }
    return response(405);
  };
  const runtime = new CloudflareKvEffectRuntime({
    accountId: "account",
    namespaceId: "namespace",
    apiToken: "test-only-token",
    baseUrl: "https://example.test/api",
  }, fetcher);
  const action = {
    actionId: "kv-write",
    actionType: "cloudflare.kv.put",
    target: { key: "dpc-test/key-1", value: "safe test value" },
    metrics: [],
    authorization: { reference: "test", scopes: ["kv-write"] },
    stopConditions: [],
    waitConditions: [],
    dependencies: [],
  };
  const request = {
    identity: {
      programId: "program",
      planId: "plan",
      planRevision: "r1",
      actionId: "kv-write",
      eventKey: "event-1",
      nfTaskId: "nf:event-1:kv-write",
      runGeneration: 1,
      claimFence: 1,
    },
    plan: { programId: "program", planId: "plan", revision: "r1", profileInput: {} },
    action,
  };

  const first = await runtime.execute(request);
  const replay = await runtime.execute(request);
  const readback = await runtime.readback(request);
  assert.equal(first.status, "DONE");
  assert.equal(replay.status, "DONE");
  assert.equal(readback.status, "DONE");
  assert.equal(values.size, 1);

  await runtime.cleanup(action);
  assert.equal(values.size, 0);
});
