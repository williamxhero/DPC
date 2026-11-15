/**
 * Shared atomic inbox transition contract suite.
 *
 * The seam under test is DurableExecutionStore.processInboxOccurrence().
 * Callers provide an external occurrence key, an owned execution lease, and
 * the receipt transition; no database transaction client crosses the seam.
 */

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  InMemoryDurableStore,
  InMemoryInboxStore,
  PostgresExecutionStore,
  PostgresInboxStore,
  StaleWriteError,
} from "../dist/index.js";
import { id, makeDescriptor } from "./helpers.js";

const { Pool } = pg;
const connectionString = process.env.DPC_POSTGRES_URL;

function makeStore(implementation, options = {}) {
  if (implementation === "InMemory") {
    const store = new InMemoryDurableStore(options);
    return {
      store,
      inbox: store.inbox,
      cleanup: async () => {},
      // In-memory state is intentionally retained for the shared semantic
      // assertions; a fresh instance would not represent a restart.
      restart: async () => ({
        store,
        inbox: store.inbox,
        cleanup: async () => {},
      }),
    };
  }
  const pool = new Pool({ connectionString });
  const store = new PostgresExecutionStore({ ...options, pool });
  const inbox = new PostgresInboxStore({ pool });
  let closed = false;
  const cleanup = async () => {
    if (!closed) {
      closed = true;
      await pool.end();
    }
  };
  return {
    store,
    inbox,
    cleanup,
    restart: async () => {
      await cleanup();
      const restartedPool = new Pool({ connectionString });
      const restartedStore = new PostgresExecutionStore({ ...options, pool: restartedPool });
      const restartedInbox = new PostgresInboxStore({ pool: restartedPool });
      let restartedClosed = false;
      return {
        store: restartedStore,
        inbox: restartedInbox,
        cleanup: async () => {
          if (!restartedClosed) {
            restartedClosed = true;
            await restartedPool.end();
          }
        },
      };
    },
  };
}

function makeContext(label) {
  const ts = Date.now();
  const identity = {
    programId: id(`inbox-transition-program-${label}-${ts}`),
    planId: id(`inbox-transition-plan-${label}`),
    planRevision: id("r1"),
    actionId: id(`inbox-transition-action-${label}`),
    eventKey: id(`inbox-transition-event-${label}-${ts}`),
    nfTaskId: id(`inbox-transition-task-${label}-${ts}`),
    runGeneration: 1,
    claimFence: 0,
  };
  const descriptor = makeDescriptor(identity.actionId, [], "inbox-transition");
  const provider = "github";
  const externalEventId = `external-${label}-${ts}`;
  const processedAt = ts + 10;
  return {
    identity,
    descriptor,
    provider,
    externalEventId,
    processedAt,
    payload: { runId: identity.eventKey, conclusion: "success" },
  };
}

async function prepare(label, implementation, storeOptions = {}, acquireAt = undefined) {
  const context = makeContext(`${implementation}-${label}`);
  const { store, inbox, cleanup, restart } = makeStore(implementation, storeOptions);
  await store.migrate();
  const lease = await store.acquire(
    context.identity,
    "inbox-transition-owner",
    acquireAt ?? context.processedAt,
  );
  await store.startExecution(lease, context.descriptor);
  await inbox.putOrIgnore(
    context.provider,
    context.externalEventId,
    "check_run.completed",
    context.payload,
  );
  const receipt = {
    identity: lease.identity,
    actionType: context.descriptor.actionType,
    nfStatus: "DONE",
    businessStatus: "COMPLETED",
    evidence: [],
    recordedAt: context.processedAt,
  };
  return { ...context, store, inbox, lease, receipt, cleanup, restart };
}

function injectFailure(store, implementation, kind) {
  if (implementation === "InMemory") {
    const target = store.ledger;
    const method = kind === "receipt" ? "appendReceiptWithClaim" : "recordOutbox";
    const original = target[method].bind(target);
    if (kind === "outbox") {
      target[method] = (...args) => {
        original(...args);
        throw new Error(`injected ${kind} failure`);
      };
    } else {
      target[method] = async (...args) => {
        const result = await original(...args);
        throw new Error(`injected ${kind} failure`);
      };
    }
    return;
  }
  const method = kind === "receipt" ? "insertReceipt" : "insertOutbox";
  const original = store[method].bind(store);
  store[method] = async (...args) => {
    const result = await original(...args);
    throw new Error(`injected ${kind} failure`);
  };
}

function runContractSuite(implementation) {
  test(`[${implementation}] first external occurrence is durably created as RECEIVED`, async () => {
    const context = makeContext("first-occurrence");
    const { store, inbox, cleanup } = makeStore(implementation);
    try {
      await store.migrate();
      const first = await inbox.putOrIgnore(
        context.provider,
        context.externalEventId,
        "check_run.completed",
        context.payload,
      );
      assert.equal(first.created, true);
      assert.equal(first.occurrence.status, "RECEIVED");
      const reloaded = await inbox.get(context.provider, context.externalEventId);
      assert.equal(reloaded.status, "RECEIVED");
      assert.deepEqual(reloaded.payload, context.payload);
    } finally {
      await cleanup();
    }
  });

  test(`[${implementation}] atomic inbox transition commits inbox, receipt, lifecycle, outbox, and claim release`, async () => {
    const prepared = await prepare("success", implementation);
    try {
      const result = await prepared.store.processInboxOccurrence({
        provider: prepared.provider,
        externalEventId: prepared.externalEventId,
        lease: prepared.lease,
        receipt: prepared.receipt,
        processedAt: prepared.processedAt,
      });

      assert.equal(result.occurrence.status, "PROCESSED");
      assert.equal(result.occurrence.processedAt, prepared.processedAt);
      assert.equal(result.record.receipt.businessStatus, "COMPLETED");
      assert.equal(result.record.lifecycle, "COMPLETED");
      assert.equal((await prepared.inbox.get(prepared.provider, prepared.externalEventId)).status, "PROCESSED");
      assert.equal((await prepared.store.listReceipts(
        prepared.identity.programId,
        prepared.identity.planId,
        prepared.identity.eventKey,
      )).length, 1);
      const outbox = (await prepared.store.pendingOutbox())
        .filter((event) => event.dedupeKey.includes(prepared.identity.eventKey));
      assert.equal(outbox.length, 1);
      await assert.rejects(
        () => prepared.store.assertValid(prepared.lease.identity, prepared.processedAt),
        StaleWriteError,
        "successful transition must release the owned claim",
      );
    } finally {
      await prepared.cleanup();
    }
  });

  test(`[${implementation}] lease validation uses adapter time rather than processedAt`, async () => {
    // The receipt timestamp is deliberately far beyond the short lease. The
    // adapter clock still owns the lease, so caller event metadata must not
    // be used as the current time for ownership validation.
    const prepared = await prepare("adapter-clock", implementation, {
      clock: () => 0,
      leaseDurationMs: 100,
    }, 0);
    try {
      const result = await prepared.store.processInboxOccurrence({
        provider: prepared.provider,
        externalEventId: prepared.externalEventId,
        lease: prepared.lease,
        receipt: prepared.receipt,
        processedAt: prepared.processedAt,
      });
      assert.equal(result.occurrence.status, "PROCESSED");
    } finally {
      await prepared.cleanup();
    }
  });

  test(`[${implementation}] external occurrence payload is immutable and duplicate delivery is deduplicated`, async () => {
    const prepared = await prepare("dedupe", implementation);
    try {
      const duplicate = await prepared.inbox.putOrIgnore(
        prepared.provider,
        prepared.externalEventId,
        "check_run.completed",
        { conclusion: "tampered" },
      );
      assert.equal(duplicate.created, false);
      assert.deepEqual(duplicate.occurrence.payload, prepared.payload);
      await prepared.store.processInboxOccurrence({
        provider: prepared.provider,
        externalEventId: prepared.externalEventId,
        lease: prepared.lease,
        receipt: prepared.receipt,
        processedAt: prepared.processedAt,
      });
      await assert.rejects(
        () => prepared.store.processInboxOccurrence({
          provider: prepared.provider,
          externalEventId: prepared.externalEventId,
          lease: prepared.lease,
          receipt: prepared.receipt,
          processedAt: prepared.processedAt + 1,
        }),
        StaleWriteError,
        "repeated processing must be explicit rather than creating a second fact",
      );
      assert.equal((await prepared.store.listReceipts(
        prepared.identity.programId,
        prepared.identity.planId,
        prepared.identity.eventKey,
      )).length, 1);
    } finally {
      await prepared.cleanup();
    }
  });

  for (const failureKind of ["receipt", "outbox"]) {
    test(`[${implementation}] ${failureKind} failure rolls back every transition side effect`, async () => {
      const prepared = await prepare(`rollback-${failureKind}`, implementation);
      try {
        injectFailure(prepared.store, implementation, failureKind);
        await assert.rejects(
          () => prepared.store.processInboxOccurrence({
            provider: prepared.provider,
            externalEventId: prepared.externalEventId,
            lease: prepared.lease,
            receipt: prepared.receipt,
            processedAt: prepared.processedAt,
          }),
          /injected/,
        );
        const occurrence = await prepared.inbox.get(prepared.provider, prepared.externalEventId);
        assert.equal(occurrence.status, "RECEIVED", "failed transition must remain retryable");
        const record = await prepared.store.findByEventKey(
          prepared.identity.programId,
          prepared.identity.planId,
          prepared.identity.eventKey,
        );
        assert.equal(record.receipt, undefined, "failed transition must not expose a receipt");
        assert.equal((await prepared.store.listReceipts(
          prepared.identity.programId,
          prepared.identity.planId,
          prepared.identity.eventKey,
        )).length, 0);
        assert.equal((await prepared.store.pendingOutbox())
          .filter((event) => event.dedupeKey.includes(prepared.identity.eventKey)).length, 0);
        await prepared.store.assertValid(prepared.lease.identity, prepared.processedAt);
      } finally {
        await prepared.cleanup();
      }
    });
  }

  test(`[${implementation}] stale lease cannot process a received occurrence`, async () => {
    const prepared = await prepare("stale", implementation);
    try {
      await prepared.store.releaseExecution(prepared.lease);
      await assert.rejects(
        () => prepared.store.processInboxOccurrence({
          provider: prepared.provider,
          externalEventId: prepared.externalEventId,
          lease: prepared.lease,
          receipt: prepared.receipt,
          processedAt: prepared.processedAt,
        }),
        StaleWriteError,
      );
      assert.equal((await prepared.inbox.get(prepared.provider, prepared.externalEventId)).status, "RECEIVED");
      assert.equal((await prepared.store.findByEventKey(
        prepared.identity.programId,
        prepared.identity.planId,
        prepared.identity.eventKey,
      )).receipt, undefined);
    } finally {
      await prepared.cleanup();
    }
  });

  if (implementation === "PostgreSQL") {
    test(`[${implementation}] validates receipt lifecycle before marking inbox processed`, async () => {
      const prepared = await prepare("ordering", implementation);
      const order = [];
      try {
        const appendReceipt = prepared.store.appendReceiptInTransaction.bind(prepared.store);
        const markInboxProcessed = prepared.store.markInboxProcessedInTransaction.bind(prepared.store);
        prepared.store.appendReceiptInTransaction = async (...args) => {
          order.push("receipt");
          return appendReceipt(...args);
        };
        prepared.store.markInboxProcessedInTransaction = async (...args) => {
          order.push("inbox");
          return markInboxProcessed(...args);
        };

        await prepared.store.processInboxOccurrence({
          provider: prepared.provider,
          externalEventId: prepared.externalEventId,
          lease: prepared.lease,
          receipt: prepared.receipt,
          processedAt: prepared.processedAt,
        });
        assert.deepEqual(order, ["receipt", "inbox"]);
      } finally {
        await prepared.cleanup();
      }
    });
  }

  test(`[${implementation}] concurrent processing has exactly one committed result`, async () => {
    const prepared = await prepare("concurrent", implementation);
    try {
      const attempts = await Promise.allSettled([
        prepared.store.processInboxOccurrence({
          provider: prepared.provider,
          externalEventId: prepared.externalEventId,
          lease: prepared.lease,
          receipt: prepared.receipt,
          processedAt: prepared.processedAt,
        }),
        prepared.store.processInboxOccurrence({
          provider: prepared.provider,
          externalEventId: prepared.externalEventId,
          lease: prepared.lease,
          receipt: prepared.receipt,
          processedAt: prepared.processedAt,
        }),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
      assert.equal((await prepared.store.listReceipts(
        prepared.identity.programId,
        prepared.identity.planId,
        prepared.identity.eventKey,
      )).length, 1);
      assert.equal((await prepared.inbox.get(prepared.provider, prepared.externalEventId)).status, "PROCESSED");
    } finally {
      await prepared.cleanup();
    }
  });

  test(`[${implementation}] committed transition is readable after adapter restart`, async () => {
    const prepared = await prepare("restart", implementation);
    let restarted;
    try {
      await prepared.store.processInboxOccurrence({
        provider: prepared.provider,
        externalEventId: prepared.externalEventId,
        lease: prepared.lease,
        receipt: prepared.receipt,
        processedAt: prepared.processedAt,
      });
      restarted = await prepared.restart();
      const reloaded = await restarted.inbox.get(prepared.provider, prepared.externalEventId);
      assert.equal(reloaded.status, "PROCESSED");
      const execution = await restarted.store.findByEventKey(
        prepared.identity.programId,
        prepared.identity.planId,
        prepared.identity.eventKey,
      );
      assert.equal(execution.receipt.businessStatus, "COMPLETED");
      assert.equal((await restarted.store.pendingOutbox())
        .filter((event) => event.dedupeKey.includes(prepared.identity.eventKey)).length, 1);
    } finally {
      await restarted?.cleanup();
      await prepared.cleanup();
    }
  });
}

runContractSuite("InMemory");

if (connectionString) {
  runContractSuite("PostgreSQL");
} else {
  test("[PostgreSQL] atomic inbox transition contract suite skipped — set DPC_POSTGRES_URL to enable", { skip: true }, () => {});
}
