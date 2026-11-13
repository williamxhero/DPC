# SPEC-DURABLE-PERSISTENCE-V1

## 来源与状态

- 来源：[GitHub Issue #9](https://github.com/williamxhero/DPC/issues/9)
- 父 SPEC：[GitHub Issue #1](https://github.com/williamxhero/DPC/issues/1)
- 状态：`to-spec` 已完成；第一阶段实现按 dependency frontier 推进。
- 范围：第一版 durable execution persistence，不扩展为完整生产运维平台。
- 选定测试 seam：`DpcCore.dispatch/recover` + 共享 `DurableExecutionStore` contract suite。

## Problem Statement

DPC 当前的 execution ledger、claim/fence、receipt、wake 和 handoff 主要由 in-memory adapter 提供。进程崩溃或重启后，已提交、未知提交、租约过期、旧 owner 写回和 outbox 缺失无法以 durable execution identity 恢复。

第一版 durable persistence 必须在不替换 GitHub plan authority、不修改外部 NF 仓库、不引入第二套业务 ledger/queue/scheduler 的前提下，使一次 DPC execution 的 claim、receipt、unknown recovery 和 crash-window reconciliation 可恢复、可审计、可拒绝 stale write。

## Solution

使用 PostgreSQL 作为唯一 durable execution store。DPC Core 通过深的 `DurableExecutionStore` seam 使用持久化实现；SQL、transaction、lease、CAS、outbox、inbox、wake 和 handoff 存储均隐藏在 adapter 内。

第一阶段包含：

- durable `(program_id, plan_id, event_key)` idempotency；
- durable execution identity 与 append-only receipts；
- claim、lease、monotonic fence；
- claim validation 与 receipt/lifecycle/outbox 同 transaction 写入；
- transactional outbox；
- durable WakeIntent、HandoffBundle、inbox dedupe；
- unknown readback-only recovery；
- crash-window reconciliation；
- in-memory 与 PostgreSQL adapter 共享 contract tests。

## User Stories

1. As a DPC caller, I want repeated event keys to remain idempotent after restart, so that one trigger cannot create two business executions.
2. As a DPC caller, I want event-key uniqueness scoped by program and plan, so that independent plans do not collide.
3. As an execution owner, I want leases and fences to survive restart, so that another owner can safely reclaim expired work.
4. As an auditor, I want every execution and recovery receipt preserved, so that UNKNOWN is not erased by later recovery.
5. As a recovery coordinator, I want UNKNOWN to create a durable recovery wake, so that recovery survives process restart.
6. As a recovery coordinator, I want readback-only recovery, so that uncertain external effects are never blindly retried.
7. As a plan executor, I want current plan revision reread after receipt commit, so that next-action selection uses current plan authority.
8. As a coordinator, I want wake dedupe, handoff identity and inbox dedupe to survive restart.
9. As an outbox dispatcher, I want state transition and outbound notification recorded atomically.
10. As an operator, I want reconciliation candidates for STARTED, UNKNOWN, expired claim and pending outbox states.
11. As a maintainer, I want the same behavior contract for in-memory and PostgreSQL adapters.
12. As a security reviewer, I want secrets, provider tokens, private transcripts and absolute temporary paths excluded from durable records.
13. As a release reviewer, I want crash-window fault evidence rather than only happy-path evidence.

## Implementation Decisions

- PostgreSQL is the first durable implementation and the single authoritative execution store.
- GitHub remains the formal plan/revision authority. Persistence stores execution context and evidence references, not a second plan authority.
- `DpcCore.dispatch` and scoped `DpcCore.recover` remain the highest public seams.
- Add a deep `DurableExecutionStore` interface hiding SQL, transaction, claim, receipt, outbox and reconciliation details.
- Do not implement production claims and ledger as independent database adapters. Atomic claim validation, receipt mutation, lifecycle update, claim release and outbox insertion belong to one transaction-aware implementation.
- Persist executions with unique `(program_id, plan_id, event_key)` occurrence identity and stable identity fields.
- Persist receipts append-only and retain a current receipt pointer on the execution row.
- Persist claims by `(program_id, plan_id, action_id)` with owner, lease and monotonic fence.
- Use conditional affected-row checks for stale-write rejection.
- Never call an external NF/provider while holding a database transaction.
- Use transactional outbox for coordination/projection notifications; it is not a second ledger or scheduler.
- Persist wakes, handoffs and inbox occurrence IDs in the same database.
- Treat uncertain external submission as UNKNOWN and route it to readback-only recovery.
- Reconciliation scans STARTED, UNKNOWN, expired claims, pending outbox and incomplete inbox processing.
- Add versioned schema migrations and explicit statement/transaction timeouts.
- Use parameterized SQL and structured domain errors.
- No dual-write between in-memory and PostgreSQL stores; one adapter is authoritative per run.

## Testing Decisions

- Test external behavior through `DpcCore.dispatch/recover`.
- Run a shared `DurableExecutionStore` contract suite against in-memory and PostgreSQL adapters.
- Do not test SQL helper internals as the primary seam.
- Add PostgreSQL integration tests from an empty database after migrations.
- Add concurrency tests for two owners and duplicate event keys.
- Add lease/fence tests for active claim, expired reclaim and stale late write.
- Add atomicity tests for claim validation + receipt + lifecycle + outbox.
- Add unknown recovery tests proving `NfActionRuntime.execute` is never called during recovery.
- Add wake/handoff/inbox restart and dedupe tests.
- Add fault injection after claim commit, after external submission begins, before receipt commit, after receipt commit and before outbox delivery.
- Exit gate requires the Core suite, both store contract suites, migration tests and crash-window acceptance suite.

## Out of Scope

- Replacing GitHub as plan authority.
- A generic plan DSL, planner, DAG editor or second scheduler.
- Redis, Kafka, Temporal or another external queue.
- Modifying Needs Forever or another external repository.
- Automatic retry of an UNKNOWN external side effect.
- Multi-region consensus, sharding, replication or production database operations.
- Full deployment, backup and capacity-planning runbooks.

## Implementation Status

- `PostgresExecutionStore` implements durable ActionLedger + ClaimAuthority in one transaction-aware adapter.
- `PostgresWakeStore` and `PostgresHandoffStore` implement durable WakeStore and HandoffStore seams.
- PostgreSQL schema includes executions, append-only receipts, claims, outbox, wakes, handoffs, inbox dedupe and migration tracking.
- `ReconciliationRunner` exposes durable reconciliation candidates for UNKNOWN receipts, STARTED executions without receipts and expired claims.
- PostgreSQL integration tests pass with a disposable PostgreSQL 16 database.
- Normal suite: 38 passed, 4 opt-in integration/live tests skipped without environment configuration.
- Remaining work is production database operations, not the first persistence contract or adapter behavior.

## Further Notes

Implementation order:

1. ADR and schema.
2. `DurableExecutionStore` interface.
3. PostgreSQL transaction runner.
4. Atomic claim/receipt/lifecycle/outbox write.
5. Event-key idempotency.
6. Durable wake, outbox, handoff and inbox.
7. Reconciliation.
8. Crash-window acceptance suite.

The first durable phase is complete only when claim, execution identity, receipt, unknown recovery and reconciliation survive process failure without creating a second side-effecting execution.
