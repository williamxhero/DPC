# SPEC-EXECUTION-SEAM-V1

## 来源与状态

- 类型：单个 follow-up SPEC；不拆分为独立子 SPEC。
- 来源：Issue #10 durable persistence 完成后的 codebase-design 结果。
- 状态：`to-spec-to-done`；本次规格与实现一起交付。
- 主题：以 `ExecutionLease` 加深 durable execution seam，同时保留 legacy ledger/claim 兼容路径。
- 前置成果：Issue #10 及其 T1–T6 已合入 `master`。
- 最高测试 seam：`DpcCore.dispatch/recover`；Adapter 行为仍通过共享 durable contract suite 验证。

## Problem Statement

Issue #10 已经把 PostgreSQL 的 claim、receipt、lifecycle、outbox 和 reconciliation 行为集中到一个 durable Adapter 中，但 `DpcCore` 仍然在类型和实现上把这个 Adapter 拆成两个旧角色：`ActionLedger` 与 `ClaimAuthority`。

当前 receipt 写入接口还要求调用者传入另一个 claim 对象：

```ts
appendReceiptWithClaim(receipt, claims, now)
replaceReceiptWithClaim(expectedIdentity, receipt, claims, now)
```

这造成三个问题：

- durable store 的单一事务 seam 没有在类型层面完整表达；
- `DpcCore` 仍然必须了解 ledger/claim 的内部拆分；
- receipt 写入模块需要验证调用者传入的 claim authority 是否就是自身，尤其 PostgreSQL Adapter 还必须依赖 `claims === this`。

同时，receipt history、outbox 和 reconciliation 是面向不同调用者的读取能力，却都与 Core execution 操作放在一个宽接口中。

本 SPEC 不改变已经验收的 durable 行为，而是把已存在的事务与 fencing 复杂度集中到更清晰的 seam 后面。

## Solution

引入一个面向 Core 的 `ExecutionStore` interface，并使用不可变的 `ExecutionLease` 表示一次已取得的 durable claim。

`DpcCore` 的 durable path 只依赖一个 execution module：

```text
DpcCore
  └── ExecutionStore
        ├── ExecutionLease / claim fencing
        ├── execution lifecycle
        ├── atomic receipt write
        ├── UNKNOWN replacement
        └── claim release
```

新的 Core-facing 写入操作不再接收外部 `ClaimAuthority`：

```ts
acquire(identity, ownerId, now): Promise<ExecutionLease>
startExecution(lease, action): Promise<...>
appendReceipt(lease, receipt, now): Promise<void>
replaceUnknownReceipt(lease, expectedIdentity, receipt, now): Promise<void>
withValidLease(lease, operation): Promise<T>
releaseExecution(lease): Promise<void>
```

`PostgresExecutionStore` 和 `InMemoryDurableStore` 继续作为 Adapter 实现同一套 `ExecutionStore` 行为。PostgreSQL 的事务 runner 仍然负责 claim validation、receipt append/replace、lifecycle、outbox 和 claim release 的 atomicity；外部 NF invocation 仍然在数据库事务之外。

`DpcCore` 的旧 `{ ledger, claims }` 构造方式继续可用，但只通过一个内部 compatibility Adapter 转换为 `ExecutionStore`。旧的 `ActionLedger` 与 `ClaimAuthority` interface 及其具体方法保留，避免破坏非 durable Adapter 和既有调用方；Core 主流程不再直接使用这两个旧角色。

诊断读取能力按调用者需要形成窄 interface：

- `ReceiptHistoryReader.listReceipts()`；
- `OutboxReader.pendingOutbox()`；
- `ReconciliationReader.listReconciliationCandidates()`。

同一个 durable Adapter 可以实现这些读取 interface，但 `DpcCore` 不需要依赖它们。

## User Stories

1. As a DPC Core, I want one execution store dependency, so that claim and receipt atomicity are owned by one seam.
2. As an execution owner, I want a lease object that carries the fenced execution identity, so that stale writes cannot be confused with current ownership.
3. As a persistence adapter, I want receipt writes to validate their own lease, so that callers cannot inject a different claim authority into an atomic write.
4. As a legacy caller, I want the existing `ActionLedger` and `ClaimAuthority` construction path to keep working, so that non-durable adapters do not require a breaking migration.
5. As a PostgreSQL adapter, I want the same transaction runner to own claim validation, receipt/lifecycle/outbox writeback and lease release, so that the existing durable invariants remain unchanged.
6. As an audit reader, I want receipt history, outbox and reconciliation reads to remain available without making Core depend on those operational queries.
7. As a test author, I want Core tests to exercise the new `ExecutionStore` seam while the shared contract suite continues to verify both InMemory and PostgreSQL Adapters.

## Implementation Decisions

- Add `ExecutionLease` with the current `ExecutionIdentity` as its public identity.
- Add `ExecutionStore` for the Core-facing execution operations.
- Keep `ActionLedger` and `ClaimAuthority` as legacy interfaces for compatibility; do not remove or silently change their existing method signatures in this SPEC.
- Extend `DurableExecutionStore` with the Core-facing `ExecutionStore` operations while retaining the legacy methods as compatibility surface.
- Make `DpcCore` normalize both dependency forms into one private `ExecutionStore` field.
- Implement the legacy normalization with a private compatibility Adapter inside the Core module; it delegates to the supplied ledger and claim authority and contains no PostgreSQL-specific behavior.
- `acquire()` creates a new fenced lease through the existing claim implementation.
- `startExecution()` begins the execution row using the lease identity.
- `appendReceipt()` performs the same atomic compare-and-write semantics as the existing `appendReceiptWithClaim()` operation.
- `replaceUnknownReceipt()` performs the same append-only recovery semantics as the existing `replaceReceiptWithClaim()` operation.
- `withValidLease()` preserves the existing pre/post claim validation around receipt construction without exposing `ClaimAuthority` to Core.
- `releaseExecution()` preserves conditional lease release and monotonic fence behavior.
- Existing receipt history, outbox and reconciliation behavior must remain byte-for-byte compatible at the observable domain level, except for the method used to reach it.
- No database schema migration is required; this is an interface and composition refinement over the Issue #10 schema.
- No external NF call may happen while a PostgreSQL transaction is open.
- UNKNOWN recovery remains readback-only and must never call the side-effecting NF execution seam.
- The existing InMemory and PostgreSQL Adapter instances remain the only durable implementations; no dual-write is introduced.

## Testing Decisions

- `npm run check` must pass with strict TypeScript compilation.
- The existing `DpcCore.dispatch/recover` tests must run through the normalized `ExecutionStore` path for durable construction.
- The legacy `{ ledger, claims }` path must continue to pass the Core regression tests.
- The shared durable contract suite must cover the new lease operations against InMemory and PostgreSQL when `DPC_POSTGRES_URL` is set.
- New or updated contract assertions must cover:
  - acquire and positive claim fence;
  - active claim conflict;
  - lease release and monotonic fence increment;
  - start execution using a lease;
  - append receipt with no caller-supplied claim authority;
  - stale lease rejection with no partial receipt or outbox write;
  - UNKNOWN replacement using a recovery lease;
  - append-only receipt history and current receipt pointer;
  - stable identity rejection;
  - unchanged outbox and reconciliation observations.
- Existing PostgreSQL integration tests must continue to run against a clean migrated database.
- Existing legacy tests that directly exercise `ActionLedger` and `ClaimAuthority` remain in place as compatibility coverage.
- No private SQL helper is a primary test seam.
- The final exit gate is the full default suite, `npm run check`, and PostgreSQL-backed tests when a disposable PostgreSQL instance is available.

## Out of Scope

- Changing execution identity fields, claim fence rules, lease duration or database schema.
- Removing `ActionLedger`, `ClaimAuthority`, `appendReceiptWithClaim` or `replaceReceiptWithClaim` compatibility methods.
- Redesigning wake, handoff, inbox or plan revision modules.
- Replacing GitHub as plan/revision authority.
- Automatic retry of UNKNOWN external side effects.
- Production database operations, deployment, failover, retention or archival policy.
- A generic planner, scheduler or workflow engine.
- Modifying external repositories or live provider Adapters.

## Further Notes

This SPEC deliberately chooses the seam-preserving deepening design rather than the higher-risk execution-session rewrite. The external `DpcCore.dispatch/recover` seam remains stable, while durable claim ownership becomes explicit in `ExecutionLease` and durable receipt writes stop accepting a sibling claim dependency.

The implementation is intentionally one coherent change: interface additions, Core normalization, both durable Adapter implementations, contract coverage, ADR documentation and this SPEC. No schema migration or process-kill acceptance is required.

完成条件为：规格已发布到 GitHub Issue，代码实现、Core 回归、共享 InMemory/PostgreSQL contract suite、TypeScript 检查和可用的 PostgreSQL 集成验证全部通过；随后将完成说明评论到 Issue 并关闭 Issue，最后 push `master` 并核验本地与远端 SHA 一致。

## Verification Evidence

- `npm run check`：通过。
- `npm test`（无外部服务）：106 passed，9 skipped，0 failed（共 115 tests）。
- `DPC_POSTGRES_URL=postgres://postgres:postgres@localhost:55433/postgres npm test`：164 passed，2 skipped，0 failed（共 166 tests）；包含 InMemory/PostgreSQL contract、Core recovery/reconciliation、wake、handoff 和 inbox 验证。
- `DPC_POSTGRES_URL=postgres://postgres:postgres@localhost:55433/postgres npm run test:postgres`：2 passed，0 failed。
- `git diff --check`：通过。
- PostgreSQL 使用一次性本地 `postgres:16` 容器验证；未引入 schema migration。
