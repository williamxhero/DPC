import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareKvEffectRuntime } from "../dist/index.js";

function response(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("Cloudflare KV adapter rejects unsafe token destinations", () => {
  const config = {
    accountId: "account",
    namespaceId: "namespace",
    apiToken: "test-only-token",
  };
  assert.throws(
    () => new CloudflareKvEffectRuntime({ ...config, baseUrl: "http://third-party.test" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new CloudflareKvEffectRuntime({ ...config, baseUrl: "https://third-party.test" }),
    /official API origin/,
  );
});

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

  await runtime.cleanup(action, request.identity);
  assert.equal(values.size, 0);
});

test("Cloudflare KV adapter rejects cross-context replay and foreign cleanup", async () => {
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
    target: { key: "dpc-test/cross-context", value: "safe test value" },
    metrics: [],
    authorization: { reference: "test", scopes: ["kv-write"] },
    stopConditions: [],
    waitConditions: [],
    dependencies: [],
  };
  const request = {
    identity: {
      programId: "program-a",
      planId: "plan-a",
      planRevision: "r1",
      actionId: "kv-write",
      eventKey: "event-a",
      nfTaskId: "nf:event-a:kv-write",
      runGeneration: 1,
      claimFence: 1,
    },
    plan: { programId: "program-a", planId: "plan-a", revision: "r1", profileInput: {} },
    action,
  };
  const foreign = {
    ...request,
    identity: {
      ...request.identity,
      programId: "program-b",
      planId: "plan-b",
      planRevision: "r2",
    },
    plan: { programId: "program-b", planId: "plan-b", revision: "r2", profileInput: {} },
  };

  await runtime.execute(request);
  await assert.rejects(() => runtime.execute(foreign), /conflicts/);
  await assert.rejects(() => runtime.cleanup(action, foreign.identity), /unowned/);
  await runtime.cleanup(action, request.identity);
  assert.equal(values.size, 0);
});

test("Cloudflare KV adapter never overwrites an occupied unrecognized value", async () => {
  const values = new Map([["dpc-test/occupied", "legacy-value"]]);
  let putCalls = 0;
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(url.split("/").at(-1));
    if (init.method === "GET") return values.has(key) ? response(200, values.get(key)) : response(404);
    if (init.method === "PUT") {
      putCalls += 1;
      values.set(key, init.body);
      return response(200, JSON.stringify({ success: true }));
    }
    return response(204);
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
    target: { key: "dpc-test/occupied", value: "new value" },
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
      eventKey: "event-occupied",
      nfTaskId: "nf:event-occupied:kv-write",
      runGeneration: 1,
      claimFence: 1,
    },
    plan: { programId: "program", planId: "plan", revision: "r1", profileInput: {} },
    action,
  };

  await assert.rejects(() => runtime.execute(request), /unrecognized value/);
  assert.equal(putCalls, 0);
  assert.equal(values.get("dpc-test/occupied"), "legacy-value");
});
