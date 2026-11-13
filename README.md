# DPC

Durable Plan Continuation (DPC) is the plan-execution kernel described by SPEC #1. T1–T6 are implemented and verified, the T7 Cloudflare provider-side-effect preflight has passed, and the real Needs Forever unknown-recovery acceptance has passed through the injected NF seam. Durable persistence remains future work.

## Runtime choice

T1 uses TypeScript compiled to Node.js ESM. The repository was greenfield, so this choice provides a small runtime with explicit contracts for the adapter seams and strict compile-time checking without adding a production dependency. Tests use Node's built-in test runner; only the TypeScript compiler is a development dependency.

## Public module interface

`DpcCore.dispatch(request)` is the external seam. One call advances at most one action occurrence:

1. Read the current `PlanSnapshot` from the injected `PlanSource`.
2. Ask the injected `Profile` for descriptors and evaluate deterministic eligibility in descriptor order.
3. Derive stable execution identity from the caller's `eventKey` and selected action.
4. Record a started execution through the injected `ActionLedger` before invoking the injected `NfActionRuntime`.
5. Interpret the NF result through the profile, write one `Receipt`, then read the plan again.
6. Select and return the next eligible action from the current revision; it is not executed in the same call.

The Core never constructs a production adapter and never exposes storage layout, lifecycle mutation, or profile-specific state to callers.

## Contract and ordering

- `eventKey` is the caller's stable trigger identity. Repeating it is idempotent in the in-memory ledger.
- `nfTaskId` is derived as `nf:<eventKey>:<actionId>`. `runGeneration` starts at `1` for the first occurrence; the injected `ClaimAuthority` replaces the provisional fence with a monotonically increasing claim fence. T1-only tests may explicitly use `NoopClaimAuthority`; the Core never creates a production adapter.
- Action selection is deterministic: profile descriptor order, then time window, dependencies, and the domain gate.
- An action is eligible only when its time window is open, all dependencies have a business `COMPLETED` receipt, and the profile gate accepts it.
- T1 records `NF DONE` separately from business `COMPLETED`. A profile can return `CONTINUE`, `WAIT_EXTERNAL`, `FAILED`, or `UNKNOWN` even after NF runtime completion.
- Receipt writeback happens before the second plan read. A plan revision observed after the action is the only context used to choose the returned `nextAction`.
- T1 handles one action occurrence per dispatch. It does not drain a plan or automatically retry an uncertain external submission.

## Error behavior

- `DpcAdapterError` wraps plan, NF, profile, and ledger adapter failures. A failed NF call is recorded as a failed receipt before the error is surfaced.
- `ClaimConflictError` reports an active owner; `StaleWriteError` rejects old fence/generation/revision/task/event identities. Claims are required dependencies of the Core, so ownership cannot be silently disabled.
- `InvalidPlanError` is raised for duplicate action IDs or dependencies that reference no descriptor.
- A valid plan with no eligible action returns `NO_ELIGIBLE_ACTION`; this is normal control flow, not an exception.
- A repeated `eventKey` returns `DUPLICATE` and does not invoke NF again.

## Local real-side-effect adapter

`LocalFileEffectRuntime` is the safe pre-T7 adapter. It writes only below a caller-provided temporary root, rejects path traversal, records an idempotency marker per `nfTaskId`, supports readback, and exposes cleanup. The integration tests use a real temporary file: the Core records a real write, duplicate dispatch does not invoke it twice, and an ambiguous submission is resolved by readback without re-execution. This validates the seam locally but does not replace the required authorized remote/provider acceptance.

## Cloudflare KV acceptance adapter

`CloudflareKvEffectRuntime` is available for API-token integrations, and `WranglerKvEffectRuntime` is used for the local authenticated CLI acceptance path. The Wrangler adapter writes one disposable identity envelope to a dedicated KV namespace, refuses conflicting identities, supports readback and cleanup, and never stores OAuth/API credentials in a receipt or handoff.

The live test is opt-in and requires local Wrangler authentication (`wrangler whoami` succeeds), plus:

- `DPC_CLOUDFLARE_LIVE=1`
- `CLOUDFLARE_KV_NAMESPACE_ID`

Run only against a disposable namespace:

```bash
npm run test:cloudflare
```

The test creates a unique key, writes it, forces an `UNKNOWN` result, resolves it by Cloudflare readback without re-executing the write, verifies duplicate dispatch, accepts the same-action handoff checkpoint, deletes the key in a `finally` block, and verifies remote readback is absent afterward. This is provider-side-effect preflight evidence, not real NF A-B-C T7 evidence. A skipped test is not current provider evidence; the live run must succeed and the namespace readback must confirm cleanup.

## Needs Forever NF acceptance

`NeedsForeverLocalFileRuntime` is the DPC-side adapter for the locally installed `needs-forever` control path. It launches a real disposable independent-worker task through an injected absolute `control.mjs` path, confines the action to a per-task temporary workspace, returns `UNKNOWN` when observation times out, and proves the external file effect through `readback` without starting a second NF task. Cleanup pauses the disposable NF task and removes only the adapter-owned workspace. The NF repository is not modified.

The opt-in acceptance test requires:

- `DPC_NF_LIVE=1`
- `DPC_NF_CONTROL_PATH` pointing to the locally installed Needs Forever `scripts/control.mjs`

Run from PowerShell:

```powershell
$env:DPC_NF_LIVE="1"
$env:DPC_NF_CONTROL_PATH="D:\\WILL\\TOOLS\\needs-forever\\plugins\\needs-forever\\scripts\\control.mjs"
npm run test:needs-forever
```

The live path starts the real NF worker/controller/judge control process, performs one disposable file side effect, forces an observation `UNKNOWN`, recovers by DPC readback without re-execution, verifies duplicate dispatch, same-action handoff, and selection of the next action. The test does not use a simulated fixture and does not persist credentials or absolute workspace paths in receipts or handoffs.

## Durable persistence

The first durable persistence slice uses PostgreSQL as the single execution store. `PostgresExecutionStore` implements the durable action ledger and claim authority together so claim/fence validation, receipt append/replace, lifecycle update, outbox insertion and claim release can share one transaction. `PostgresWakeStore` and `PostgresHandoffStore` persist the existing WakeIntent and HandoffBundle seams, while `ReconciliationRunner` exposes durable reconciliation candidates without retrying an external side effect.

The schema includes executions, append-only receipts, claims, transactional outbox events, wake intents, handoff bundles, inbox dedupe and migration tracking. Event idempotency is scoped by `programId + planId + eventKey`; stale fences are rejected by conditional transaction checks. PostgreSQL remains an adapter behind the Core seam; GitHub remains plan authority.

The PostgreSQL integration tests are opt-in and require a disposable PostgreSQL database:

```powershell
$env:DPC_POSTGRES_URL="<local-postgres-connection-string>"
npm run test:postgres
```

The integration suite verifies durable UNKNOWN recovery, event dedupe, append-only receipt behavior, outbox creation, wake lease/dedupe/writeback and full-identity handoff acceptance. The normal `npm test` command skips these tests unless `DPC_POSTGRES_URL` is set.

## Standard Kit and projection isolation

`inspectProfileConformance` applies shared descriptor checks to every profile; profile code does not implement Core lifecycle or execution safety. `ClaimAuthority` exposes only execution-right operations. `ProjectionAdapter` can publish/read a derived view and report drift against an authoritative snapshot, but it has no plan, ledger, claim, or scheduler write operation.

## Wake intent and pull-first coordination

`WakeCoordinator` normalizes manual, timer, evidence, revision, handoff, and recovery triggers into one `WakeIntent` identity. `dedupeKey` is immutable; the same key returns `DUPLICATE` instead of creating another schedule. `resolve`, `claim`, `acknowledgeDelivery`, and `writeResult` are the pull-first seam. A stale wake fence is rejected, and an unknown delivery remains `UNKNOWN` until a later claim resolves it. Push/native launch is not required and no second scheduler is created.

## Plan revision and tactical exploration

`PlanRevisionRecord` carries source, evidence references, approval reference, scope, effective time, and lineage. `revisionCanAffectAction` returns true only for a scoped, not-started, unfrozen action with no external effect after the revision becomes effective. Started/frozen/effected actions retain their original execution identity and evidence.

`createAdvisoryPlanChange` creates an `ADVISORY` proposal only; it has no plan writer and cannot change authorization, scheduler, cadence, or action eligibility. `TacticalRoute` records expected evidence/signals, risks, fallback, success conditions, and stop conditions. `assessTacticalRoute` marks a repeated route as `NO_PROGRESS`.

## Claim and recovery rules

T2 adds an injected `ClaimAuthority` seam. A production implementation will own leases and fencing; `InMemoryClaimAuthority` provides the same observable contract for tests. A successful claim replaces the provisional fence with a monotonically increasing fence. Receipt writeback first validates the current fence, and a runtime result may echo its full identity; an old generation, revision, task, or fence is rejected as `StaleWriteError` rather than accepted as success.

An NF result of `UNKNOWN` is recorded as an unknown business receipt. `DpcCore.recover({ programId, planId, eventKey })` calls only the injected `RecoveryAdapter.readback` seam and never calls `NfActionRuntime.execute`. An absent readback remains `STILL_UNKNOWN`; a confirmed readback replaces the unknown receipt under a fresh fence, then rereads the current plan revision before selecting a next action. Receipt append/replace uses a claim-aware compare-and-write seam so a claim expiring during the write cannot leave a committed receipt with a stale result. This keeps recovery separate from potentially duplicate side-effecting execution.

## Test surface

Tests exercise the public `DpcCore.dispatch` and scoped `recover` seams with in-memory, PostgreSQL and real-side-effect adapters. The current local suite has 42 tests: 38 pass and four opt-in live/integration tests are skipped unless explicitly enabled. Coverage includes normal sequential selection, dependency and time gates, post-action plan revision readback, scoped duplicate dispatch, separation of NF and business outcomes, observable adapter failure, single-owner fencing, stale identity rejection, claim-aware receipt writes, recovery-only unknown handling, wake lease reclamation, handoff identity isolation, adapter ownership checks, local reparse-point confinement, the real Needs Forever adapter seam, and PostgreSQL durable execution/wake/handoff contracts. Crash-window reconciliation remains a bounded first-version seam; production database operations remain future work.

## Commands

```bash
npm install
npm test
```
