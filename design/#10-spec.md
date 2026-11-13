# SPEC-DURABLE-PERSISTENCE-V1-REVISED

## 来源与状态

- 类型：单个 SPEC（无子 SPEC；后续通过 `/to-tickets` 拆分 implementation tickets）。
- 状态：`to-spec` 阶段；本次只发布规格，不启动实现、测试、拆票、commit、push 或关闭 Issue。
- 主题：第一版 durable persistence。
- 测试 seam：最高端到端 seam 为 `DpcCore.dispatch/recover`；共享 `DurableExecutionStore` contract suite 覆盖 InMemory 与 PostgreSQL adapter。
- 规格组织：单个 SPEC 足以描述并验收本阶段目标，不另建总 SPEC。

## Problem Statement

DPC 当前能够在进程内完成 action selection、claim/fencing、receipt、unknown recovery、wake 和 handoff，但这些 execution facts 不能在进程重启、owner 崩溃、lease 过期、外部提交结果未知或 outbox 投递中断后可靠恢复。

用户需要一个 durable execution store，使同一个 execution identity 在进程生命周期之外仍然可核对，并保证：

- 同一 plan scope 内的 event key 不会产生重复业务 execution；
- 旧 owner、旧 generation、旧 revision 和旧 fence 不能写回；
- claim validation、receipt、lifecycle 与 outbox 不会在 crash window 中分裂；
- UNKNOWN 外部结果不会被盲目重新执行；
- wake、handoff 和 reconciliation 在进程重启后仍可继续；
- PostgreSQL adapter 与现有 in-memory adapter 的行为保持一致。

当前需要的是第一版 durable execution contract，而不是一次性完成所有生产数据库运维能力。

## Solution

以 PostgreSQL 作为第一版唯一 durable execution store，DPC Core 通过一个深的 `DurableExecutionStore` seam 使用它。GitHub 继续作为正式 plan/revision authority；NF 继续只负责当前 action 的执行；PostgreSQL 记录 execution context、claim、receipt、wake、handoff、outbox、inbox dedupe 和 reconciliation candidate。

第一版方案包含：

1. P1：durable persistence ADR 与 PostgreSQL schema；
2. P2：`DurableExecutionStore` interface；
3. PostgreSQL transaction runner；
4. claim、receipt、lifecycle、outbox 的 atomic write；
5. 按 `program_id + plan_id + event_key` scoped event-key idempotency；
6. durable wake、handoff、inbox dedupe；
7. reconciliation candidate discovery；
8. InMemory 与 PostgreSQL adapter 的共享 contract suite；
9. Core `dispatch/recover` 端到端验收与第一阶段 exit gate。

## User Stories

1. As a DPC caller, I want the same `(program_id, plan_id, event_key)` to remain idempotent after restart, so that one trigger cannot create two business executions.
2. As a DPC caller, I want event-key uniqueness scoped by program and plan, so that independent plan contexts do not collide.
3. As an execution owner, I want a durable claim lease, so that ownership survives process restart.
4. As an execution owner, I want monotonically increasing claim fences, so that a new owner can invalidate every late write from an old owner.
5. As a DPC Core, I want a stale fence to become a typed stale-write error, so that callers cannot mistake an old write for business success.
6. As an auditor, I want each action occurrence to retain its complete stable identity, so that program, plan, revision, action, event, NF task, generation and fence remain independently verifiable.
7. As an auditor, I want action receipts to be append-only, so that an original UNKNOWN receipt is not destroyed by later recovery.
8. As an auditor, I want recovery readback to create a new receipt linked to the original execution, so that the recovery decision is traceable.
9. As a recovery coordinator, I want UNKNOWN results to create durable recovery work, so that recovery survives a supervisor restart.
10. As a recovery coordinator, I want recovery to call only readback, so that an uncertain side effect is never blindly submitted again.
11. As a recovery coordinator, I want an absent readback to remain STILL_UNKNOWN, so that missing evidence is not converted to success or ordinary failure.
12. As a recovery coordinator, I want a conflicting readback to remain a conflict, so that another execution’s external effect cannot be accepted as this execution’s effect.
13. As a plan executor, I want the current plan revision reread after receipt commit, so that next-action selection uses current plan authority.
14. As a plan executor, I want a started action to retain its original plan revision context, so that a later revision cannot rewrite an in-flight external execution.
15. As a coordinator, I want wake dedupe to survive process restart, so that repeated timer, evidence, revision, handoff and recovery triggers produce one canonical intent.
16. As a coordinator, I want an expired wake lease to be reclaimable with a new fence, so that a crashed coordinator does not permanently block progress.
17. As a harness, I want handoff bundles to survive restart, so that another harness can continue the same action checkpoint.
18. As a harness, I want handoff acceptance to validate complete stable identity, so that a bundle from another program, plan or event cannot be accepted.
19. As an outbox dispatcher, I want a committed state transition and its outbound notification recorded atomically, so that a committed receipt is not silently lost before coordination.
20. As an outbox dispatcher, I want duplicate delivery to be safe, so that at-least-once delivery cannot create duplicate business execution.
21. As an inbox consumer, I want external occurrence IDs deduplicated durably, so that repeated callbacks cannot create repeated business receipts.
22. As an operator, I want to list STARTED executions without receipts, so that crash-window reconciliation is observable.
23. As an operator, I want to list UNKNOWN receipts and expired claims, so that recovery work can be scheduled without guessing.
24. As a reconciliation runner, I want candidate discovery to be read-only with respect to external side effects, so that discovery cannot accidentally retry an action.
25. As a persistence maintainer, I want all state transitions to use explicit transaction boundaries, so that rollback behavior is predictable.
26. As a persistence maintainer, I want SQL and locking details hidden behind the store seam, so that Core remains independent of storage layout.
27. As a test author, I want the same store contract suite to run against InMemory and PostgreSQL, so that adapter replacement does not change observable behavior.
28. As a test author, I want Core tests to exercise dispatch and recover rather than private SQL helpers, so that tests protect user-visible behavior.
29. As a security reviewer, I want provider tokens, credentials, private transcripts and absolute temporary paths excluded from durable records, so that persistence cannot become an accidental secret store.
30. As a release reviewer, I want migration, concurrency, stale-write, unknown-recovery, wake and handoff evidence, so that a green happy path is not mistaken for a durable exit gate.
31. As a schema maintainer, I want migrations to be versioned and repeatable-safe, so that a restart cannot reinterpret old rows silently.
32. As a future adapter author, I want transaction, ordering, error and performance behavior documented in the store interface, so that another durable implementation can be evaluated against the same contract.

## Implementation Decisions

- PostgreSQL is the first durable implementation and the single durable execution store for this SPEC.
- GitHub remains the formal plan and plan-revision authority. Durable persistence stores the revision context used by an execution but does not replace plan authority.
- The highest public test seam remains `DpcCore.dispatch` and scoped `DpcCore.recover`.
- Add a deep `DurableExecutionStore` interface that hides action execution rows, append-only receipts, claims, fences, leases, transaction boundaries, outbox insertion and reconciliation queries.
- The PostgreSQL execution adapter implements the durable ledger and claim authority together. Production behavior must not be split between two independent database adapters that cannot share an atomic transaction.
- Persist action occurrences with a unique `(program_id, plan_id, event_key)` identity and stable execution identity fields.
- Persist receipts append-only and keep a current-receipt pointer on the execution row for efficient reads.
- Persist claims by `(program_id, plan_id, action_id)` with owner, lease expiry, execution event and monotonic fence.
- Use conditional affected-row checks for stale-write rejection.
- Claim validation, receipt append/replace, lifecycle update, outbox insertion and claim release must be one database transaction.
- External NF/provider invocation must never happen while a database transaction is open.
- Use a transactional outbox for durable coordination notifications. It is not a second business ledger, queue or scheduler.
- Persist WakeIntent with immutable dedupe key, trigger type, not-before, status, owner, lease and fence.
- Persist HandoffBundle with full program, plan, revision, action and event identity, and accept it with a conditional write.
- Persist inbox occurrence IDs only for external dedupe; an inbox row is not a business fact until processed through an execution transaction.
- Treat uncertain external submission as UNKNOWN and route it to readback-only recovery. This SPEC does not authorize automatic side-effect retries.
- Add reconciliation candidate discovery for UNKNOWN receipts, STARTED executions without receipts and expired claims. Candidate discovery must not execute an external action.
- Add versioned migrations and explicit transaction/statement timeout configuration.
- Use parameterized SQL and structured domain errors.
- Keep the existing InMemory adapter as the behavior reference adapter; no dual-write between InMemory and PostgreSQL is allowed.
- The initial migration includes execution, receipt, claim, wake, handoff, outbox, inbox and migration-tracking relations, with indexes for scoped lookup and ready work.
- The transaction runner owns begin, commit, rollback, connection release and failure propagation. Core never receives a database client.

## Testing Decisions

- A good test crosses an agreed public seam and asserts external behavior: status, receipt, identity, next action, duplicate result, stale-write error, recovery result, wake state or handoff state.
- The primary seam is `DpcCore.dispatch/recover`.
- The secondary seam is the shared `DurableExecutionStore` contract suite, executed against both InMemory and PostgreSQL adapters.
- SQL helper functions and private repository methods are not primary behavior tests.
- Prior art includes current tests for duplicate dispatch, claim fencing, stale identity, unknown recovery, plan revision reread, wake dedupe, handoff validation, projection isolation and real side-effect adapters.
- PostgreSQL integration tests start from a clean migrated database and verify execution/recovery, scoped idempotency, append-only receipt behavior, outbox creation, wake lease/dedupe/writeback, handoff acceptance and reconciliation candidates.
- Concurrency tests cover two owners racing for one action and two dispatches racing for one event key.
- Lease tests cover active conflict, expired reclaim, fence increment and stale late writes.
- Atomicity tests cover rollback when claim validation fails and verify that no receipt or outbox row remains committed.
- Unknown tests prove recovery invokes readback only and never calls the side-effecting NF execution seam again.
- Migration tests cover fresh schema application and repeat-safe migration invocation.
- The first-phase exit gate requires the full Core regression suite, the shared store contract suite, PostgreSQL integration tests, migration verification, and readable reconciliation evidence. Full process-kill acceptance is explicitly outside this SPEC.

## Out of Scope

- Production database operations, backup, replication, failover, capacity planning and on-call runbooks.
- Multi-region consistency, sharding and cross-region consensus.
- A complete process-kill crash acceptance suite.
- Replacing GitHub as the formal plan/revision authority.
- Generic plan DSL, planner, DAG editor, automatic strategy engine or second scheduler.
- Redis, Kafka, Temporal or another external queue.
- Modifying Needs Forever or another external repository.
- Automatic retry of an UNKNOWN external side effect.
- Full production deployment and database performance tuning.
- Removing existing InMemory, local-file, Cloudflare or Needs Forever preflight adapters.
- Implementing future production retention, archival or data deletion policy.

## Further Notes

This SPEC is a clean rewrite of the durable persistence proposal. It is intentionally a specification-only publication. Implementation is a later workflow entered through `/to-tickets` and `$implement-spec`; this invocation does not start implementation or Git delivery.

The dependency order for future tickets is:

1. ADR and schema;
2. DurableExecutionStore interface;
3. PostgreSQL transaction runner;
4. atomic claim/receipt/lifecycle/outbox transition;
5. scoped event-key idempotency;
6. durable wake, handoff and inbox;
7. reconciliation candidates;
8. Core + store contract and first-phase exit gate.

使用 `/to-tickets` 将本 SPEC 拆为具有明确依赖关系的子 tickets，再使用 [$implement-spec](C:/Users/will/.cc-switch/skills/implement-spec/SKILL.md) 完成本 SPEC 及全部子 tickets。实现、测试和代码审查全部通过后，将任务分支的成果汇入 SPEC 集成分支，再合并到仓库主干。逐一确认待清理分支的成果均已纳入主干，且对应 worktree 无未保存改动后，移除本次创建的 worktree 并删除对应已合并分支。最后 push 主干，核验本地与远端一致。以“验收通过、主干已合并、临时资源已清理、远端已同步”为完成条件。任一步失败则停止后续步骤，保留未交付成果并报告阻塞；不强制删除或强推。
