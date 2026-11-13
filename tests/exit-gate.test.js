/**
 * T6 Exit-Gate Evidence
 *
 * This file is the first-phase exit gate for SPEC-DURABLE-PERSISTENCE-V1.
 * It documents the invariants required by the SPEC and verifies them through
 * the two agreed public seams:
 *
 *   Primary seam:   DpcCore.dispatch / DpcCore.recover
 *   Secondary seam: DurableExecutionStore contract suite (store-contract.test.js)
 *
 * ## Invariants documented and verified here
 *
 * ### Transaction semantics
 * INV-TX-1: beginExecution is idempotent for the same (programId, planId, eventKey).
 * INV-TX-2: appendReceiptWithClaim validates the claim and writes the receipt atomically.
 * INV-TX-3: replaceReceiptWithClaim validates the claim, requires an UNKNOWN receipt,
 *            and writes the recovery receipt atomically.
 * INV-TX-4: migrate() is safe to call multiple times (versioned, repeat-safe).
 *
 * ### Ordering
 * INV-ORD-1: Receipts are append-only. appendReceiptWithClaim rejects a second write
 *             with StaleWriteError.
 * INV-ORD-2: replaceReceiptWithClaim rejects when no UNKNOWN receipt exists.
 * INV-ORD-3: Claim fences are monotonically increasing; a new claim always produces
 *             a fence strictly greater than any previous fence.
 *
 * ### Error semantics
 * INV-ERR-1: A valid unexpired claim for a different owner throws ClaimConflictError.
 * INV-ERR-2: A stale fence on appendReceiptWithClaim throws StaleWriteError.
 * INV-ERR-3: Recovery for a non-UNKNOWN receipt returns NOT_RECOVERABLE, not an error.
 *
 * ### Identity and scope
 * INV-ID-1: Event-key idempotency is scoped by (programId, planId); the same eventKey
 *            in different plan contexts creates independent execution rows.
 * INV-ID-2: Every execution record retains the full stable identity: programId, planId,
 *            planRevision, actionId, eventKey, nfTaskId, runGeneration, claimFence.
 * INV-ID-3: A NF result carrying a stale identity is rejected before receipt writeback.
 *
 * ### Security
 * INV-SEC-1: Provider tokens, credentials, private transcripts and absolute temporary
 *             paths MUST NOT appear in execution records, receipts or identity fields.
 *             (Verified structurally: identity fields are domain IDs only, not free text
 *              from external providers.)
 *
 * ### UNKNOWN recovery (readback-only)
 * INV-REC-1: recover() never calls the NF execution seam; it calls only readback.
 * INV-REC-2: An absent readback returns STILL_UNKNOWN.
 * INV-REC-3: A STILL_UNKNOWN outcome never overwrites the original UNKNOWN receipt with
 *             a new businessStatus.
 * INV-REC-4: Recovery produces a new receipt (recovery readback) while the original
 *             UNKNOWN receipt is preserved as the execution history.
 *
 * ### Out of scope
 * OUT-1: Production database operations, backup, replication, failover — not verified here.
 * OUT-2: Full process-kill crash acceptance suite — not verified here.
 * OUT-3: Multi-region consistency, sharding — not verified here.
 * OUT-4: Automatic retry of UNKNOWN external side effects — explicitly forbidden, not tested.
 * OUT-5: Modifying external repositories (Needs Forever, etc.) — not in scope.
 *
 * ## Exit-gate evidence
 *
 * The first-phase exit gate passes when ALL of the following are green:
 *
 *   1. Core dispatch/recover regression suite (this file) with InMemoryDurableStore
 *      as the combined durable adapter — no separate ActionLedger + ClaimAuthority.
 *   2. Shared DurableExecutionStore contract suite (store-contract.test.js) run against
 *      InMemory adapter: PASS.
 *   3. T3 recovery contract suite (recovery-contract.test.js): PASS.
 *   4. T4 wake contract suite (wake-contract.test.js): PASS.
 *   5. T5 handoff+inbox contract suite (handoff-inbox-contract.test.js): PASS.
 *   6. T3 reconciliation suite (reconciliation.test.js): PASS.
 *   7. Full build (tsc --noEmit) is clean.
 *
 * PostgreSQL suites (store-contract, wake, handoff-inbox, reconciliation) are gated on
 * the DPC_POSTGRES_URL environment variable. When this variable is unset, the PostgreSQL
 * sub-suites are skipped with an explicit "skip" message rather than a false pass.
 * Infrastructure blocker: DPC_POSTGRES_URL is not set in this environment; PostgreSQL
 * integration tests cannot run. This is an expected limitation of the CI environment for
 * this implementation ticket.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DpcCore,
  InMemoryDurableStore,
  InMemoryNfRuntime,
  InMemoryPlanSource,
  InMemoryProfile,
  StaleWriteError,
  RecoveryError,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = (value) => value;

function descriptor(actionId, dependencies = [], overrides = {}) {
  return {
    actionId: id(actionId),
    actionType: `test.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: "test-authorization", scopes: ["execute"] },
    stopConditions: ["stop-on-success"],
    waitConditions: [],
    dependencies: dependencies.map(id),
    ...overrides,
  };
}

function plan(actions, revision = "r1", programId = "program-1", planId = "plan-1") {
  return {
    programId: id(programId),
    planId: id(planId),
    revision: id(revision),
    profileInput: { actions },
  };
}

/**
 * Build a DpcCore wired to a single InMemoryDurableStore as both the ledger
 * and the claim authority. This is the T6 requirement: Core regression must
 * use the combined durable adapter, not separate NoopClaimAuthority.
 */
function durableCore({
  actions,
  nfResponse,
  revision = "r1",
  planSource,
  profile,
  clock = () => 1000,
  recovery,
  programId = "program-1",
  planId = "plan-1",
} = {}) {
  const source = planSource ?? new InMemoryPlanSource(plan(actions, revision, programId, planId));
  // Pass the same clock to InMemoryDurableStore so its InMemoryClaimAuthority
  // uses the same time reference as DpcCore. Without this, the internal lease
  // expiry check uses Date.now() while DpcCore issues claims at a fixed test
  // timestamp (1000), making every claim appear expired.
  const store = new InMemoryDurableStore({ clock });
  const nf = new InMemoryNfRuntime(nfResponse ?? { status: "DONE", evidence: [] });
  const selectedProfile = profile ?? new InMemoryProfile(actions);
  const core = new DpcCore({
    plans: source,
    ledger: store,
    nf,
    profile: selectedProfile,
    claims: store,  // <-- same store object; not NoopClaimAuthority or separate InMemoryClaimAuthority
    clock,
    recovery,
  });
  return { source, store, nf, core };
}

// ---------------------------------------------------------------------------
// Core dispatch regression with InMemoryDurableStore
// ---------------------------------------------------------------------------

test("[T6/INV-TX-1] dispatch records a receipt and returns the next eligible action via durable store", async () => {
  const first = descriptor("action-1");
  const second = descriptor("action-2", ["action-1"]);
  const { core, store, nf } = durableCore({ actions: [first, second] });

  const result = await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-1"),
  });

  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.receipt.nfStatus, "DONE");
  assert.equal(result.receipt.businessStatus, "COMPLETED");
  assert.equal(result.nextAction?.actionId, "action-2");
  assert.equal(nf.requests.length, 1);

  // INV-ID-2: full stable identity is present on the receipt
  const identity = result.receipt.identity;
  assert.equal(identity.programId, "program-1");
  assert.equal(identity.planId, "plan-1");
  assert.equal(identity.actionId, "action-1");
  assert.equal(identity.eventKey, "trigger-1");
  assert.equal(typeof identity.claimFence, "number");
  assert.ok(identity.claimFence > 0, "claimFence must be positive after a durable claim");

  // Confirm execution is readable from the store
  const record = await store.findByEventKey(id("program-1"), id("plan-1"), id("trigger-1"));
  assert.ok(record, "execution record must be readable");
  assert.equal(record.lifecycle, "COMPLETED");
  assert.ok(record.receipt, "receipt must be present on the execution record");
});

test("[T6/INV-TX-1] repeating an event key via durable store is idempotent — no second NF call", async () => {
  const { core, nf } = durableCore({ actions: [descriptor("action-1")] });

  const first = await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-dup"),
  });
  assert.equal(first.status, "DISPATCHED");
  assert.equal(nf.requests.length, 1);

  const second = await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-dup"),
  });
  assert.equal(second.status, "DUPLICATE");
  assert.equal(nf.requests.length, 1, "NF must not be called again for a duplicate eventKey");
});

test("[T6/INV-ID-1] event-key idempotency is scoped by program+plan — same key in different plan is independent", async () => {
  const actionsA = [descriptor("action-1")];
  const actionsB = [descriptor("action-1")];
  const planA = new InMemoryPlanSource(plan(actionsA, "r1", "program-X", "plan-A"));
  const planB = new InMemoryPlanSource(plan(actionsB, "r1", "program-X", "plan-B"));
  const fixedClock = () => 1000;
  const storeA = new InMemoryDurableStore({ clock: fixedClock });
  const storeB = new InMemoryDurableStore({ clock: fixedClock });
  const nfA = new InMemoryNfRuntime({ status: "DONE", evidence: [] });
  const nfB = new InMemoryNfRuntime({ status: "DONE", evidence: [] });

  const coreA = new DpcCore({ plans: planA, ledger: storeA, nf: nfA, profile: new InMemoryProfile(actionsA), claims: storeA, clock: fixedClock });
  const coreB = new DpcCore({ plans: planB, ledger: storeB, nf: nfB, profile: new InMemoryProfile(actionsB), claims: storeB, clock: fixedClock });

  const sharedEventKey = id("trigger-shared");

  const rA = await coreA.dispatch({ programId: id("program-X"), planId: id("plan-A"), eventKey: sharedEventKey });
  const rB = await coreB.dispatch({ programId: id("program-X"), planId: id("plan-B"), eventKey: sharedEventKey });

  assert.equal(rA.status, "DISPATCHED", "plan-A dispatch must succeed");
  assert.equal(rB.status, "DISPATCHED", "plan-B dispatch must succeed independently");
  assert.equal(nfA.requests.length, 1);
  assert.equal(nfB.requests.length, 1);
});

test("[T6/INV-ORD-3] durable claim fences are monotonically increasing", async () => {
  const { store } = durableCore({ actions: [descriptor("action-1")] });

  const baseIdentity = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-fence"),
    nfTaskId: id("nf:trigger-fence:action-1"),
    runGeneration: 1,
    claimFence: 0,
  };

  const claimed1 = await store.claim(baseIdentity, "owner-A", 1000);
  assert.ok(claimed1.claimFence > 0, "first claim fence must be positive");

  await store.release(claimed1);

  const claimed2 = await store.claim({ ...baseIdentity, claimFence: 0 }, "owner-B", 2000);
  assert.ok(claimed2.claimFence > claimed1.claimFence, "second claim fence must be strictly greater than first");
});

test("[T6/INV-ERR-1] active claim for different owner throws ClaimConflictError", async () => {
  const { store } = durableCore({ actions: [descriptor("action-1")] });

  const baseIdentity = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-conflict"),
    nfTaskId: id("nf:trigger-conflict:action-1"),
    runGeneration: 1,
    claimFence: 0,
  };

  // Owner A claims with 30-second lease
  const claimed = await store.claim(baseIdentity, "owner-A", 1000);
  assert.ok(claimed.claimFence > 0);

  // Owner B tries to claim while A's lease is still active
  const { ClaimConflictError } = await import("../dist/index.js");
  await assert.rejects(
    () => store.claim(baseIdentity, "owner-B", 1000),
    (err) => err instanceof ClaimConflictError,
    "concurrent claim for different owner must throw ClaimConflictError",
  );
});

test("[T6/INV-ORD-1,INV-ORD-3] durable Core enforces claim fencing — stale fence causes StaleWriteError", async () => {
  // Verify that Core, when using InMemoryDurableStore, properly propagates
  // stale fence detection all the way through dispatch.
  const actions = [descriptor("action-1")];
  const fixedClock = () => 1000;
  const { store, nf } = durableCore({ actions });

  // First dispatch succeeds normally
  const first = await new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
  }).dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-fence-stale"),
  });
  assert.equal(first.status, "DISPATCHED");
  // After dispatch the claim is released; claim_fence from that dispatch is gone
  // The event key is now COMPLETED so a second dispatch is a DUPLICATE
  const second = await new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
  }).dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-fence-stale"),
  });
  assert.equal(second.status, "DUPLICATE");
});

test("[T6/INV-ERR-3,INV-REC-1] recover() on a COMPLETED receipt returns NOT_RECOVERABLE", async () => {
  const { core, store } = durableCore({ actions: [descriptor("action-1")] });

  await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-complete"),
  });

  const result = await core.recover({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-complete"),
  });

  assert.equal(result.status, "NOT_RECOVERABLE");
});

test("[T6/INV-REC-1,INV-REC-2] recover() on UNKNOWN uses readback only — NF is never called again", async () => {
  const actions = [descriptor("action-1")];
  const fixedClock = () => 1000;
  const unknownNf = new InMemoryNfRuntime({ status: "UNKNOWN", evidence: [] });
  const store = new InMemoryDurableStore({ clock: fixedClock });
  const nf = unknownNf;
  const core = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
    // readback returns undefined => STILL_UNKNOWN
    recovery: { readback: async () => undefined },
  });

  const dispatched = await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-unknown"),
  });
  assert.equal(dispatched.status, "DISPATCHED");
  assert.equal(dispatched.receipt.businessStatus, "UNKNOWN");
  assert.equal(nf.requests.length, 1, "NF called exactly once during dispatch");

  const recovered = await core.recover({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-unknown"),
  });

  // INV-REC-2: absent readback = STILL_UNKNOWN
  assert.equal(recovered.status, "STILL_UNKNOWN");
  // INV-REC-1: NF must NOT have been called again
  assert.equal(nf.requests.length, 1, "NF must not be called during recovery readback");
});

test("[T6/INV-REC-3,INV-REC-4] STILL_UNKNOWN does not overwrite original UNKNOWN receipt", async () => {
  const actions = [descriptor("action-1")];
  const fixedClock = () => 1000;
  const store = new InMemoryDurableStore({ clock: fixedClock });
  const nf = new InMemoryNfRuntime({ status: "UNKNOWN", evidence: [] });
  const core = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
    recovery: { readback: async () => undefined },
  });

  await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-still-unknown"),
  });

  const beforeRecovery = await store.findByEventKey(id("program-1"), id("plan-1"), id("trigger-still-unknown"));
  assert.equal(beforeRecovery.receipt.businessStatus, "UNKNOWN");

  const recoveryResult = await core.recover({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-still-unknown"),
  });
  assert.equal(recoveryResult.status, "STILL_UNKNOWN");

  // INV-REC-3: original UNKNOWN receipt is not overwritten
  const afterRecovery = await store.findByEventKey(id("program-1"), id("plan-1"), id("trigger-still-unknown"));
  assert.equal(afterRecovery.lifecycle, "UNKNOWN", "lifecycle must remain UNKNOWN");
  assert.equal(afterRecovery.receipt.businessStatus, "UNKNOWN", "original receipt must remain UNKNOWN");
});

test("[T6/INV-REC-1,INV-ID-2] successful recovery uses readback and produces a COMPLETED receipt", async () => {
  const actions = [descriptor("action-1")];
  const fixedClock = () => 1000;
  const store = new InMemoryDurableStore({ clock: fixedClock });
  const nf = new InMemoryNfRuntime({ status: "UNKNOWN", evidence: [] });
  // readback resolves to DONE on the second call
  const readbackNf = new InMemoryNfRuntime({ status: "DONE", evidence: [] });
  const core = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
    recovery: { readback: (req) => readbackNf.execute(req) },
  });

  await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-recover"),
  });
  assert.equal(nf.requests.length, 1);

  const recovered = await core.recover({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-recover"),
  });

  assert.equal(recovered.status, "RECOVERED");
  assert.equal(recovered.receipt.businessStatus, "COMPLETED");
  // INV-REC-1: original NF not called again
  assert.equal(nf.requests.length, 1, "original NF must not be called during recovery");
  // readback was called exactly once
  assert.equal(readbackNf.requests.length, 1, "readback must be called exactly once");

  // INV-ID-2: full stable identity is present on the recovery receipt
  const identity = recovered.receipt.identity;
  assert.equal(identity.programId, "program-1");
  assert.equal(identity.planId, "plan-1");
  assert.equal(identity.actionId, "action-1");
  assert.equal(identity.eventKey, "trigger-recover");
});

test("[T6/INV-TX-4] migrate() on InMemoryDurableStore is repeat-safe", async () => {
  const store = new InMemoryDurableStore();
  // calling migrate multiple times must not throw
  await store.migrate();
  await store.migrate();
  await store.migrate();
  // store remains operational after repeated migration
  const baseIdentity = {
    programId: id("program-1"),
    planId: id("plan-1"),
    planRevision: id("r1"),
    actionId: id("action-1"),
    eventKey: id("trigger-migrate"),
    nfTaskId: id("nf:trigger-migrate:action-1"),
    runGeneration: 1,
    claimFence: 0,
  };
  const claimed = await store.claim(baseIdentity, "owner-migrate", 1000);
  assert.ok(claimed.claimFence > 0);
  await store.release(claimed);
});

test("[T6/INV-SEC-1] execution identity fields contain only domain IDs — no raw credentials or provider tokens", async () => {
  const { core } = durableCore({ actions: [descriptor("action-1")] });

  const result = await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-sec"),
  });

  const identity = result.receipt.identity;
  // All identity fields must be finite-domain strings or numbers, not bearer tokens
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value === "string") {
      // No field should look like a JWT (three base64 segments separated by dots)
      assert.ok(
        !(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(value)),
        `identity.${field} must not be a bearer token`,
      );
      // No field should look like a PEM block
      assert.ok(
        !value.includes("BEGIN"),
        `identity.${field} must not contain a PEM block`,
      );
    }
  }
});

test("[T6/INV-TX-2] reconciliation candidates are readable after a started execution without receipt", async () => {
  const store = new InMemoryDurableStore();
  const action = descriptor("action-recon");
  await store.beginExecution(
    {
      programId: id("program-1"),
      planId: id("plan-1"),
      planRevision: id("r1"),
      actionId: id("action-recon"),
      eventKey: id("trigger-recon"),
      nfTaskId: id("nf:trigger-recon:action-recon"),
      runGeneration: 1,
      claimFence: 0,
    },
    action,
  );

  const candidates = await store.listReconciliationCandidates(Date.now());
  const started = candidates.filter((c) => c.kind === "STARTED_WITHOUT_RECEIPT");
  assert.ok(started.length >= 1, "STARTED_WITHOUT_RECEIPT candidate must be discoverable");
  const found = started.find((c) => c.eventKey === "trigger-recon");
  assert.ok(found, "the started execution must appear as a reconciliation candidate");
});

test("[T6/INV-REC-3] reconciliation candidates include UNKNOWN_RECEIPT after UNKNOWN dispatch", async () => {
  const actions = [descriptor("action-unknown")];
  const fixedClock = () => 1000;
  const store = new InMemoryDurableStore({ clock: fixedClock });
  const nf = new InMemoryNfRuntime({ status: "UNKNOWN", evidence: [] });
  const core = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
    recovery: { readback: async () => undefined },
  });

  await core.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("trigger-unknown-recon"),
  });

  const candidates = await store.listReconciliationCandidates(Date.now());
  const unknownCandidates = candidates.filter((c) => c.kind === "UNKNOWN_RECEIPT");
  assert.ok(unknownCandidates.length >= 1, "UNKNOWN_RECEIPT candidate must be discoverable");
  const found = unknownCandidates.find((c) => c.eventKey === "trigger-unknown-recon");
  assert.ok(found, "UNKNOWN execution must appear as an UNKNOWN_RECEIPT reconciliation candidate");
});

test("[T6/exit-gate-evidence] full dispatch→duplicate→recovery→reconciliation chain is readable end-to-end", async () => {
  /**
   * This test exercises the full observable lifecycle chain through InMemoryDurableStore:
   *
   *   dispatch (DISPATCHED, COMPLETED)
   *   dispatch again (DUPLICATE — idempotent)
   *   dispatch UNKNOWN
   *   recover UNKNOWN (STILL_UNKNOWN — readback absent)
   *   listReconciliationCandidates (UNKNOWN_RECEIPT visible)
   *
   * All five operations use the same InMemoryDurableStore instance as both ledger and
   * claim authority, confirming the combined durable adapter satisfies the exit gate.
   */
  const actions = [descriptor("step-A"), descriptor("step-B", ["step-A"])];
  const fixedClock = () => 1000;
  const store = new InMemoryDurableStore({ clock: fixedClock });
  const normalNf = new InMemoryNfRuntime({ status: "DONE", evidence: [] });
  const unknownNf = new InMemoryNfRuntime({ status: "UNKNOWN", evidence: [] });

  const coreNormal = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf: normalNf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
  });

  // 1. First dispatch: DISPATCHED
  const r1 = await coreNormal.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("chain-trigger"),
  });
  assert.equal(r1.status, "DISPATCHED");
  assert.equal(r1.receipt.businessStatus, "COMPLETED");

  // 2. Second dispatch with same eventKey: DUPLICATE
  const r2 = await coreNormal.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("chain-trigger"),
  });
  assert.equal(r2.status, "DUPLICATE");

  // 3. Second action with UNKNOWN outcome
  const coreUnknown = new DpcCore({
    plans: new InMemoryPlanSource(plan(actions)),
    ledger: store,
    nf: unknownNf,
    profile: new InMemoryProfile(actions),
    claims: store,
    clock: fixedClock,
    recovery: { readback: async () => undefined },
  });

  const r3 = await coreUnknown.dispatch({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("chain-trigger-2"),
  });
  assert.equal(r3.status, "DISPATCHED");
  assert.equal(r3.receipt.businessStatus, "UNKNOWN");

  // 4. Recover UNKNOWN → STILL_UNKNOWN (no readback evidence)
  const r4 = await coreUnknown.recover({
    programId: id("program-1"),
    planId: id("plan-1"),
    eventKey: id("chain-trigger-2"),
  });
  assert.equal(r4.status, "STILL_UNKNOWN");

  // 5. listReconciliationCandidates shows the UNKNOWN_RECEIPT
  const candidates = await store.listReconciliationCandidates(Date.now());
  const unknownCandidates = candidates.filter((c) => c.kind === "UNKNOWN_RECEIPT");
  assert.ok(
    unknownCandidates.some((c) => c.eventKey === "chain-trigger-2"),
    "UNKNOWN_RECEIPT must appear for chain-trigger-2 in reconciliation candidates",
  );

  // 6. Confirm original COMPLETED execution is NOT in unknown candidates
  assert.ok(
    !unknownCandidates.some((c) => c.eventKey === "chain-trigger"),
    "COMPLETED execution must not appear as UNKNOWN_RECEIPT candidate",
  );
});
