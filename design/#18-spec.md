# SPEC-EXECUTION-DEEPENING-V1

## 来源与状态

- 类型：Issue #18 follow-up SPEC；candidate 1 与 candidate 2 作为一个相互独立但可组合的 execution deepening 交付。
- 来源：architecture review after Issue #17 (`ExecutionStore` lease seam deepening)。
- 状态：`to-spec-to-done`。
- 主题：集中 execution identity 不变量，并将 Core 的 plan selection read 由逐项查询深化为一次 plan-scoped read。
- 前置成果：Issue #10 durable persistence 与 Issue #17 execution seam 已合入 `master`。
- 最高测试 seam：`DpcCore.dispatch/recover`；InMemory/PostgreSQL durable behavior 继续通过共享 contract suite 验证。

## Problem Statement

Issue #17 已经让 `DpcCore` 使用一个 normalized `ExecutionStore` seam，但两个架构摩擦仍然存在：

1. `ExecutionIdentity` 的 full identity（包含 `claimFence`）和 stable identity（排除 `claimFence`）比较逻辑分散在 Core、legacy compatibility adapter、InMemory store、PostgreSQL adapter 以及外部 effect adapters 中。`claimFence` 是协调 ownership 的字段，不是 external effect identity 的字段；这一不变量目前依赖多个私有实现各自保持一致。
2. `DpcCore.selectAction()` 对每个 action 调用 `findLatestForAction()`，并对每个 dependency 调用 `hasBusinessCompletion()`。一个 plan selection 因而会产生 O(N + M) 个异步 store read，并在 dispatch 的多个路径重复这个 fan-out。调用方知道了过多的 storage read 粒度，执行 read seam 没有提供足够的 depth。

这两个问题不改变已经验收的 durable semantics：receipt/lifecycle/outbox atomicity、claim fencing、event-key idempotency、UNKNOWN readback-only recovery 和现有 legacy construction path 都必须保持。

## Solution

### Candidate 1 — execution identity module

新增一个 Core 内部的 identity module，集中提供两种明确的比较语义：

- full execution identity：比较 `ExecutionIdentity` 的全部字段，包括 `claimFence`；
- stable execution identity：比较除 `claimFence` 外的 execution identity 字段。

Core、legacy adapter、InMemory execution/claim modules、PostgreSQL adapter 和 external effect adapters 使用该 module。PostgreSQL claim row 的 SQL 比较继续保留在 SQL transaction 内，因为数据库必须在 row lock/CAS seam 中完成 stale-write enforcement；这不是可移除的 TypeScript duplication。`HandoffContinuationIdentity` 是不同的 5-field domain identity，不使用 execution identity helpers。

该 module 不改变 `ExecutionIdentity` 字段、不改变 claim fence 规则，也不要求 schema migration。

### Candidate 2 — plan-scoped latest execution read

扩展 Core-facing `ExecutionStore`，增加一次返回指定 `(programId, planId, actionId[])` 范围内每个 action 最新 `ExecutionRecord` 的 read capability。返回值是按 `ActionId` 索引的只读 map；没有 execution record 的 action 不出现在 map 中。

`DpcCore.selectAction()` 在每次 selection 开始时取得一次 map，然后在内存中执行既有的 descriptor order、lifecycle、time window、dependency 和 profile domain-gate 规则。`hasBusinessCompletion()` 的语义保持为该 action 最新 record 的 lifecycle 是否为 `COMPLETED`。

- Native InMemory/PostgreSQL adapters 使用一次 plan-scoped read。
- Legacy `{ ledger, claims }` path 由 `LegacyExecutionStoreAdapter` 通过既有 `ActionLedger.findLatestForAction()` 逐项 fallback，保持外部 legacy implementor 不必新增方法；新的 Core seam 仍然只有一个 `ExecutionStore`。
- PostgreSQL 使用 `DISTINCT ON (action_id)` 和既有 action index，保持与 `findLatestForAction()` 相同的 latest ordering（`run_generation DESC, created_at DESC`）。本 SPEC 不增加 speculative schema index 或 schema version；现有 index 已覆盖该 read 的 `(program_id, plan_id, action_id, run_generation)` 前缀。

两个 candidate 可以并存，但作为两个逻辑变更验证：identity module 是内部 invariant deepening；plan-scoped read 是 execution seam 的 read-capability deepening。

## User Stories

1. As an execution module maintainer, I want full and stable identity rules in one module, so that a new identity field cannot silently diverge across adapters.
2. As an effect adapter, I want the stable execution identity rule without claim-fence semantics, so that ownership fencing is not confused with external effect idempotency.
3. As DpcCore, I want one plan-scoped latest execution read per selection, so that action selection does not fan out storage calls.
4. As a legacy caller, I want the `{ ledger, claims }` construction form and `ActionLedger` method set to remain usable, so that this deepening does not create a flag-day migration.
5. As a PostgreSQL adapter, I want the same latest-record ordering as the old per-action read, so that selection behavior changes only in read granularity, not domain semantics.
6. As a test author, I want InMemory and PostgreSQL contract coverage for the new read and identity invariants, so that the execution seam remains replaceable.

## Implementation Decisions

- Add `sameExecutionIdentity()` and `sameStableExecutionIdentity()` to a non-public `src/core/identity.ts` module. Do not conflate them with handoff identity comparison.
- Replace duplicated TypeScript field comparisons in `src/core/kernel.ts`, `src/core/in-memory.ts`, `src/adapters/postgres/execution-store.ts`, `src/adapters/local-file.ts`, `src/adapters/needs-forever.ts`, `src/adapters/cloudflare-kv.ts`, and `src/adapters/wrangler-kv.ts`.
- Preserve PostgreSQL SQL-level claim validation comparisons in `lockClaim`, `assertValid`, and `deleteClaim`; the database transaction remains the enforcement seam.
- Add the plan-scoped read capability to `ExecutionStore` only. Do not add it to `ActionLedger`, preserving existing third-party legacy implementors.
- Name the capability around latest records for a supplied set of action IDs, so the Core can bound the read to the current descriptor set and the legacy adapter can provide a correct fallback.
- Return `ReadonlyMap<ActionId, ExecutionRecord>` with at most one latest record per requested action.
- Implement the native InMemory adapter from its existing action index; implement PostgreSQL with one `DISTINCT ON` query and the existing action index.
- Refactor `DpcCore.selectAction()` to use the map for both current-action blocking and dependency completion, without changing descriptor order or profile gate calls.
- Keep `findLatestForAction()` and `hasBusinessCompletion()` available for legacy and operational callers; this SPEC changes only the Core selection path.
- No database schema migration is required.

## Out of Scope

- Changing `ExecutionIdentity` fields, claim fence semantics, run generation rules, or effect marker formats.
- Replacing the `HandoffContinuationIdentity` comparison or redesigning handoff.
- Removing `ActionLedger`, `ClaimAuthority`, or legacy receipt methods.
- Changing wake, inbox, reconciliation, outbox, plan revision, or external NF behavior.
- Adding a generic query builder, scheduler, planner, or workflow engine.
- Adding an index without measured need.
- Modifying another repository or the external Needs Forever implementation.

## Testing Decisions

- Add focused identity helper tests covering full identity rejection/acceptance and stable identity ignoring only `claimFence`.
- Extend `tests/store-contract.test.js` for both InMemory and PostgreSQL with:
  - empty requested action set;
  - multiple actions in one plan and no cross-plan leakage;
  - latest-record selection for repeated generations;
  - dependency completion behavior through the Core selection path;
  - stable/full identity behavior remaining unchanged.
- Add a Core regression assertion that selection uses the plan-scoped capability while preserving descriptor order and dependency gating.
- Keep legacy `{ ledger, claims }` Core tests and direct `ActionLedger` tests unchanged as compatibility coverage.
- Run `npm run check`.
- Run default `npm test` with no external service.
- When a disposable PostgreSQL instance is available, run the full suite with `DPC_POSTGRES_URL` and `npm run test:postgres`.
- Run `git diff --check` and review the complete final diff before completion.

## Completion Criteria

1. The identity module is used by all applicable execution identity comparisons; handoff identity and SQL row-lock validation remain intentionally separate.
2. `ExecutionStore` exposes the plan-scoped latest-record read, and all Core-facing adapters implement it.
3. `DpcCore.selectAction()` performs one store read per selection and uses an in-memory map for current records and dependencies.
4. Legacy `ActionLedger` implementors remain source-compatible because the new capability is not added to that interface.
5. Shared InMemory/PostgreSQL contract tests and Core tests pass without weakening or skipping existing assertions.
6. `npm run check` passes.
7. Default and PostgreSQL-backed test suites pass with zero failures when PostgreSQL is enabled.
8. An implementation/completion comment is posted to the GitHub issue before the issue is closed.
9. The final commit is pushed and local `HEAD` equals `origin/master`.

## Verification Evidence

- `npm run check`: passed (`tsc -p tsconfig.json`).
- `npm test`: passed — 119 tests, 110 passed, 9 skipped, 0 failed.
- PostgreSQL-backed `npm test`: passed — 172 tests, 170 passed, 2 skipped, 0 failed.
- `npm run test:postgres`: passed — 2 tests, 2 passed, 0 skipped, 0 failed.
- `git diff --check`: passed.
- Implementation commit SHA: `6266ded06360937158e75662b85c693d109107ca`.
