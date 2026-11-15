# SPEC-EXECUTION-TRANSITIONS-V1

## 来源与状态

- 类型：architecture deepening follow-up SPEC；候选 1、2、4 作为一个组合交付规划，作为三个相互独立但可组合的 deep module 实现。
- 来源：Issue #18 完成后的 architecture review。
- 状态：`to-spec`；本次只完成 SPEC 与 issue 发布，不开始实现。
- 主题：深化 execution identity、receipt lifecycle，以及 inbox/receipt/outbox 原子 transition。
- 前置成果：Issue #10 durable persistence、Issue #17 ExecutionStore lease seam、Issue #18 execution identity comparison 与 plan-scoped selection read 已合入 `master`。
- 组合交付顺序：execution identity → receipt lifecycle → atomic inbox transition。
- 最高测试 seam：`DpcCore.dispatch/recover` 保持为 execution identity 与 receipt lifecycle 的最高行为 seam；inbox 原子性通过 durable execution transition seam 验证，不把数据库 transaction client 泄漏给调用方。

## Problem Statement

DPC 当前已经具备 durable execution、claim fencing、append-only receipts、transactional outbox、UNKNOWN readback-only recovery 和 external inbox dedupe，但三个相邻的不变量仍然分散在不同的 module 与 adapter 中。

1. **Execution identity 的语义仍主要依赖调用方选择。** Issue #18 已集中 full execution identity 与 stable execution identity 的比较函数，但调用方仍必须记住何时包含 `claimFence`、何时排除 `claimFence`。Core、InMemory execution/claim module、PostgreSQL adapter 和 external effect adapters 对身份的使用目的不同；如果未来新增 identity 字段或新的 adapter，错误选择比较语义仍可能通过类型检查。

2. **Receipt lifecycle 规则仍有重复实现。** `BusinessStatus` 到 `ActionLifecycle` 的映射在 InMemory 与 PostgreSQL implementation 中重复；append-only receipt、首次 append、UNKNOWN replacement、claim-aware stale-write rejection 分散在 Core 与 durable adapters 中。规则的实现位置不同，但它们表达的是同一个 receipt lifecycle 不变量。

3. **Inbox 与 business receipt 的原子性知识泄漏给调用方。** `InboxStore.markProcessed()` 可以接收可选 transaction client，调用方必须知道如何把 inbox status update 放进 execution receipt/outbox transaction。当前接口明确承认自身不能强制 inbox 与 business receipt 的 atomicity。这样会让同一 external occurrence 可能先变为 `PROCESSED`、但对应 receipt 或 outbox 没有提交，或者让不同调用方采用不同 transaction 编排。

这三个问题属于同一条 execution transition，但不应被揉成一个大 module：identity 负责身份，lifecycle 负责状态规则，atomic transition 负责持久化编排。它们需要一个组合交付的依赖顺序，同时保留三个清晰的 interface、seam、implementation 和 test surface。

## Solution

以一个组合 SPEC 交付三个独立的 deep module：

1. **Execution identity module**
   - 让 fenced execution identity 与 stable execution identity 成为可区分的内部概念。
   - 提供一个明确、受约束的 stable identity 转换路径。
   - 让 lease、claim、receipt write、stale-write validation 使用 fenced identity 语义；让 external effect marker、readback 和 cleanup 使用 stable identity 语义。
   - `HandoffContinuationIdentity` 继续是独立的 handoff domain identity，不使用 execution identity module。
   - PostgreSQL row-lock/CAS 内的 SQL identity comparison 继续留在 transaction implementation 中，因为那是 stale-write enforcement 的 persistence seam。

2. **Receipt lifecycle module**
   - 集中 `BusinessStatus` 到 `ActionLifecycle` 的映射。
   - 集中首次 receipt append、append-only history、UNKNOWN replacement 和不合法 transition 的判断。
   - 保持 `UNKNOWN` 只能通过 readback recovery 被替换，recovery 不得重新执行 NF external effect。
   - Core 继续负责 dispatch/recover orchestration；durable adapters 继续负责 claim validation、receipt persistence、lifecycle pointer、outbox 和 claim release 的原子提交。

3. **Atomic inbox transition module**
   - 提供一个语义级 transition，使 external inbox occurrence 的 `PROCESSED` 状态、business receipt、execution lifecycle 和 transactional outbox event 在同一个 durable transaction 中提交或全部回滚。
   - 调用方只表达 external occurrence 与 execution transition，不持有或传递 PostgreSQL transaction client。
   - PostgreSQL implementation 隐藏 transaction client、row lock、conditional update 与 rollback；InMemory implementation 提供相同的 observable atomic behavior。
   - 重复 external occurrence、重复 processing、stale execution lease 和已存在 receipt 必须保持幂等或明确拒绝，不能产生部分成功。

三个 module 作为一个 integration delivery 验证，但保持独立职责：identity module 不拥有 lifecycle；lifecycle module 不拥有数据库 transaction；atomic transition module 不重新定义 identity 或 handoff policy。

## User Stories

1. As an execution module maintainer, I want fenced and stable execution identities to be distinct concepts, so that coordination ownership is not confused with external effect identity.
2. As a Core maintainer, I want lease and claim operations to use the complete execution identity, so that stale writes cannot pass because only a subset of fields matched.
3. As an external effect adapter maintainer, I want effect markers and readback to use stable identity, so that a new claim fence does not look like a new external effect.
4. As a recovery adapter maintainer, I want readback identity to exclude only coordination fence state, so that recovery can recognize the original effect without weakening event, plan, action, task, or generation identity.
5. As a future adapter author, I want the intended identity kind to be evident from the module contract, so that choosing the wrong comparison is difficult to compile or test successfully.
6. As a PostgreSQL adapter maintainer, I want SQL row-lock and compare-and-write checks to remain inside the transaction implementation, so that database enforcement is not replaced by an application-level pre-check.
7. As a handoff maintainer, I want `HandoffContinuationIdentity` to remain independent, so that handoff acceptance does not accidentally inherit claim-fence semantics.
8. As an execution maintainer, I want one mapping from business result status to action lifecycle, so that InMemory and PostgreSQL cannot diverge when a new business status is introduced.
9. As a Core maintainer, I want legal receipt transitions to be explicit, so that the distinction between first append, UNKNOWN replacement, and stale write rejection is local and reviewable.
10. As a durable-store maintainer, I want append-only receipt history to remain intact, so that recovery adds evidence instead of overwriting the original UNKNOWN receipt.
11. As a recovery operator, I want an UNKNOWN receipt to be replaceable only after readback, so that the system never retries a potentially completed external side effect by executing it again.
12. As a dispatch caller, I want a completed, waiting, failed, or unknown execution to remain blocked according to the existing lifecycle rules, so that lifecycle deepening does not change action selection semantics.
13. As an InMemory adapter maintainer, I want the same lifecycle and identity behavior as PostgreSQL, so that local tests predict durable behavior.
14. As a PostgreSQL adapter maintainer, I want receipt, lifecycle pointer, outbox insertion, and claim release to remain one atomic durable transition, so that a committed receipt cannot be missing its coordination notification or leave an active claim behind.
15. As an external event consumer, I want `(provider, externalEventId)` dedupe to remain immutable, so that repeated delivery cannot overwrite the original payload or change its meaning.
16. As an external event consumer, I want inbox processing and the corresponding business receipt to commit together, so that `PROCESSED` never claims success when the business transition rolled back.
17. As an external event consumer, I want a failed atomic transition to leave the inbox occurrence retryable, so that a later delivery can safely resume processing.
18. As an external event consumer, I want a repeated processing attempt to return an explicit idempotent result or stale-write error, so that the same occurrence cannot produce two business receipts.
19. As a caller, I want to use a semantic transition operation rather than a database transaction client, so that PostgreSQL transaction mechanics do not leak through the inbox interface.
20. As an InMemory test author, I want rollback and duplicate behavior to be observable through the same transition seam, so that tests do not pass merely because the fake ignores transaction composition.
21. As a contract-test author, I want identity, lifecycle, and atomic transition invariants exercised against both InMemory and PostgreSQL adapters, so that the execution seam remains replaceable.
22. As a Core test author, I want `DpcCore.dispatch()` and `DpcCore.recover()` to remain the highest behavior tests for identity and lifecycle, so that implementation details do not become the primary test surface.
23. As an adapter test author, I want the atomic inbox transition to be tested with commit and rollback cases, so that partial persistence is explicitly rejected.
24. As a maintainer, I want the three modules to be delivered in dependency order, so that identity semantics are settled before lifecycle and atomic transition work depend on them.
25. As a legacy caller, I want the `{ ledger, claims }` construction path and existing `ActionLedger` implementors to remain source-compatible, so that this deepening does not require a flag-day migration.
26. As a durable-store caller, I want existing claim fencing, run-generation, event-key idempotency, plan revision, wake, handoff, reconciliation, outbox, and schema behavior preserved, so that the combined delivery improves locality without changing durable semantics.
27. As a security-conscious operator, I want inbox payload rules to continue excluding provider tokens, credentials, private transcripts, and absolute temporary paths, so that atomic processing does not expand sensitive data retention.
28. As a reviewer, I want one combined completion record with three independently verified modules, so that the delivery can be audited without hiding unrelated responsibilities inside one implementation.

## Implementation Decisions

### Combined delivery and module placement

- This is one combined delivery and one issue-level completion unit, not three unrelated changes.
- The implementation must contain three independent deep modules:
  1. execution identity;
  2. receipt lifecycle;
  3. atomic inbox transition.
- The modules may share domain types and an internal execution seam, but each has one primary responsibility and one independently testable interface.
- The implementation order is identity first, lifecycle second, atomic transition third. A later module may consume an earlier module's semantics but must not duplicate them.
- The existing `DpcCore.dispatch/recover` interface remains the highest behavior seam for execution. The new atomic inbox transition is tested at the highest durable transition seam available because current Core dispatch/recovery does not directly ingest provider inbox occurrences.

### Execution identity module

- Distinguish complete fenced execution identity from stable execution identity inside the module's contract and implementation.
- Complete identity includes all current execution fields, including `claimFence`; stable identity includes all current effect identity fields except `claimFence`.
- Provide one explicit, one-way conversion or projection from complete identity to stable identity. Callers must not reconstruct stable identity by repeating field lists.
- All applicable TypeScript comparisons in Core, legacy compatibility, InMemory execution/claim code, PostgreSQL adapter-facing checks, and external effect adapters use the module's semantics.
- External effect marker formats remain backward-compatible with the current stable fields. No marker format migration is required by this SPEC.
- PostgreSQL SQL comparisons in claim locking, stale validation, and claim deletion remain in the database transaction implementation. The module must not pretend that a TypeScript comparison replaces row-lock/CAS enforcement.
- `HandoffContinuationIdentity` remains a separate five-field identity and is not converted to or compared as an execution identity.
- No change to execution identity fields, claim-fence allocation, run-generation allocation, event-key scope, or lease semantics.

### Receipt lifecycle module

- Define one source of truth for mapping `BusinessStatus` to `ActionLifecycle`.
- Define the legal transition categories needed by current behavior: first receipt append, UNKNOWN receipt replacement after readback, and stale/duplicate rejection.
- Preserve append-only receipt history. Recovery must append a recovery receipt and update the current receipt pointer rather than mutate historical receipt data.
- Preserve the rule that an NF `UNKNOWN` outcome remains a business `UNKNOWN` outcome even if a profile would otherwise interpret it differently.
- Preserve current selection semantics: `COMPLETED` satisfies dependencies; `STARTED` without a receipt, `WAITING`, `FAILED`, and `UNKNOWN` retain their existing blocking behavior.
- Keep claim validation, transaction ordering, outbox insertion, and claim release in the durable adapter. The lifecycle module decides policy; it does not perform persistence.
- Keep Core responsible for invoking the profile gate/interpreter and for the dispatch/recovery flow. The lifecycle module must not become a second Core orchestrator.
- Do not change receipt JSON shape, receipt ordering, business status values, or error category meanings unless a verification result proves the current contract cannot express the policy.

### Atomic inbox transition module

- Replace caller knowledge of an optional transaction client with a semantic transition at the durable execution seam.
- The transition must be able to associate one received external occurrence with the corresponding execution receipt/lifecycle/outbox write.
- The transition must validate the current execution lease and expected receipt state before changing inbox status, so stale owners cannot mark an occurrence processed.
- The successful transition commits all of the following together: inbox status `RECEIVED → PROCESSED`, business receipt append or valid lifecycle update, current receipt pointer/lifecycle state, transactional outbox event, and claim release when the execution path owns the claim.
- Any error before commit rolls back all of those changes. The inbox remains `RECEIVED` and retryable; no business receipt or outbox event from the failed transition is observable.
- Repeated external occurrence delivery remains deduplicated by provider and external event ID. A repeated processing attempt must not overwrite the original payload or create a second business fact.
- The InMemory implementation must model commit/rollback and duplicate behavior at the semantic seam; it must not silently ignore the atomicity contract merely because it has no database transaction.
- PostgreSQL implementation keeps transaction client ownership, row locks, conditional updates, and rollback inside the adapter. Callers do not receive a PoolClient or equivalent structural transaction object.
- The existing outbox dedupe semantics remain in force. The transition must not create a second outbox event for the same receipt occurrence.
- Payload sanitization remains a caller responsibility, and the transition must not persist credentials or private runtime context.

### Compatibility and schema

- Existing `ExecutionStore`, `ActionLedger`, `ClaimAuthority`, `InboxStore`, receipt history, outbox, wake, handoff, reconciliation, and external effect seams remain compatible unless a narrower internal seam is required behind an adapter.
- Legacy `{ ledger, claims }` construction and third-party `ActionLedger` implementations remain source-compatible.
- No database schema migration is planned. Existing execution, receipt, outbox, claim, and inbox tables must support the transition. Any proposed migration must be separately justified and must not be smuggled into this delivery.
- No changes to GitHub plan authority, external NF repository, provider authentication, scheduler ownership, or production database operations.

## Testing Decisions

- Tests cross the highest available interface, not private helper functions, except for focused pure identity/lifecycle tests where the module's interface is itself the behavior under test.
- `DpcCore.dispatch()` and `DpcCore.recover()` remain the primary behavior seam for execution identity, receipt lifecycle, UNKNOWN recovery, claim fencing, selection blocking, and returned results.
- The identity module receives focused tests for complete equality, stable equality, fence-only differences, every stable-field difference, conversion behavior, and misuse-resistant type/compile checks where the repository's toolchain supports them.
- The receipt lifecycle module receives focused tests for every current business status, every legal transition category, append-only history, UNKNOWN replacement, and rejection of duplicate or stale transitions.
- The shared execution contract suite runs identity/lifecycle behavior against InMemory and PostgreSQL-backed stores where the behavior is durable-store observable.
- The inbox transition contract suite runs against InMemory and PostgreSQL adapters and covers:
  - first external occurrence creation;
  - repeated occurrence dedupe and immutable payload;
  - successful atomic processing;
  - rollback after a receipt or outbox failure;
  - inbox remaining `RECEIVED` after rollback;
  - no receipt or outbox event after rollback;
  - second processing rejection or explicit idempotent result;
  - stale lease rejection;
  - concurrent processing behavior;
  - restart readback of the committed result.
- PostgreSQL tests use a disposable database when available and verify transaction rollback with a real transaction, not only an InMemory approximation.
- Existing contract tests for durable UNKNOWN recovery, append-only receipts, outbox creation, claim fencing, wake, handoff, and legacy construction remain unchanged unless an assertion must be extended to cover the new semantic transition.
- No test may be deleted, weakened, skipped, or changed merely to accommodate the implementation.
- Verification for the future implementation includes type checking, default tests, PostgreSQL-backed tests when available, PostgreSQL-specific tests, diff whitespace checks, and a final complete diff review.
- The final implementation must include evidence that all three modules were verified independently and that the combined transition preserves existing durable semantics.

## Out of Scope

- Changing `ExecutionIdentity` field names, claim-fence allocation, run-generation rules, event-key idempotency scope, or lease duration semantics.
- Treating `HandoffContinuationIdentity` as an execution identity or redesigning handoff acceptance.
- Changing wake lifecycle semantics, scheduler ownership, plan revision authority, reconciliation candidate meaning, or external NF execution behavior.
- Retrying an external side effect during UNKNOWN recovery.
- Changing external effect marker formats, provider APIs, Cloudflare/Wrangler behavior, or the external Needs Forever repository.
- Adding a generic workflow engine, query builder, transaction framework, scheduler, or event bus.
- Introducing a speculative database index or schema migration.
- Making inbox payloads authoritative business facts without a successful atomic transition.
- Requiring all inbox consumers to migrate in a flag day; compatibility adapters may remain while the new semantic seam is adopted.
- Modifying another repository or production infrastructure.
- Implementing the feature in this SPEC-only phase.

## Further Notes

- The three candidates are related by execution transition but are not alternatives. Identity is the foundational invariant; lifecycle is the state-policy module; atomic inbox transition is the persistence orchestration module.
- The implementation should use the deletion test at each step: deleting identity should recreate field comparisons across many callers; deleting lifecycle should recreate status and transition rules in Core and adapters; deleting atomic transition should force callers to manage database transaction composition.
- ADR-002 is reinforced by the identity distinction and by keeping the Core-facing execution seam small. ADR-001 is intentionally revisited only at the inbox transaction-client seam: the current structural transaction client was a valid first slice, but this SPEC proposes hiding it if the combined transition can preserve the same atomic guarantees.
- The issue is ready for agent work after this SPEC is published, but the current user instruction is SPEC-only. `/to-spec-to-done` implementation work is intentionally deferred until a later explicit implementation approval.
- Completion of the future implementation requires one combined issue completion record, three independently reviewed module changes, contract evidence for InMemory/PostgreSQL parity, and verification that local `HEAD` equals `origin/master` after publication.
