# SPEC-PLAN-EXECUTION-NF-BOUNDARY-V1

## 来源与状态

- 来源：GitHub Issue [#1](https://github.com/williamxhero/DPC/issues/1)
- 架构输入：[执行报告](#1-reprot.md)
- 版本：`plan-execution-nf-boundary-v2`
- 本地状态：`to-spec` 已完成；T1–T6 已实现并通过验证；T7 provider-side-effect preflight 与真实 Needs Forever unknown-recovery acceptance 已完成；父 SPEC exit gate 证据已具备，待 tracker 关闭。
- 目标仓库：`williamxhero/DPC`
- 外部拥有者：Needs Forever / NF Action Runtime（本 SPEC 不直接修改）

## 问题

DPC 需要把长期计划继续执行为可恢复、可审计的 action 流程，同时让 NF 只负责当前 action 的执行与监督。计划目标、plan revision、业务 action、外部副作用证据、claim/fence、Harness handoff 和 wake 必须保持明确的权责分离；任何未确认的外部结果只能进入 recovery/readback，不能被推断为成功或被盲目重试。

仓库目前是 greenfield：没有代码、提交、运行时或测试基线。因此第一阶段必须先建立一个可替换 adapter 的 DPC Core 合约和可执行的 in-memory 验收闭环，再逐步接入持久化、Coordinator、Harness 和真实副作用。不能把尚未取得的真实 NF 或 provider 证据写成“已完成”。

## 第一阶段目标

贯通一条最小纵向闭环：

```text
读取正式 plan/revision 与业务 ledger
  -> 选择一个合格 action
  -> 通过 NF adapter 执行 A-B-C
  -> 写 evidence receipt / 业务结果
  -> 重新读取当前 plan revision
  -> 选择下一个 action
```

闭环必须同时证明：

- DPC Core 统一处理 lifecycle、identity、claim/fencing、generation、retry、unknown recovery、receipt、stale-write rejection；
- profile 只提供 descriptor、domain gate、result interpreter 和可选 advisory plan-change；
- NF `DONE` 不等于业务完成；
- plan revision 只影响有效范围内尚未开始的 action；
- 重复 event/action identity 不产生重复业务执行；
- handoff、wake、projection 和 authority 的接口可以在后续 adapter 中复用。

## 不在本阶段

- 通用计划 DSL、DAG 编辑器、自动 planner、第二套 queue/scheduler/ledger/event bus；
- Quant profile、平台级业务规则和 NF C 的战略规划；
- 修改 Needs Forever 或其他外部仓库；
- 自动批准 `plan_change_proposal`；
- 在没有授权 provider、真实外部 action 和 readback 证据时宣称 SPEC exit gate 通过；
- 推送远程、关闭父 SPEC 或合并未验证分支。

## 模块与 seam

### DPC Core module

对调用者提供一个窄的 `continue/dispatch` seam。它隐藏 action lifecycle、identity 生成/校验、依赖与时间门、claim/fence、generation、重复投递保护、unknown recovery、receipt 及 post-action plan readback。调用者不需要了解内部状态机或存储布局。

### Profile interface

Profile 只提供：

- action descriptor（目标、指标、授权、时间窗、停止/等待条件、依赖）；
- `check_domain_gate`；
- `interpret_result`（区分继续、业务完成、等待外部、失败和未知）；
- 可选 `propose_plan_change`，只能生成 advisory receipt。

Profile 不得实现 claim、scheduler、generation、handoff、wake、retry 或 unknown recovery。

### Adapter seams

所有计划、业务 ledger、Claim Authority、Coordinator/scheduler、NF runtime、GitHub projection 和 Harness 都是注入的 adapter。第一阶段至少提供 in-memory adapter 与一个明确的外部副作用 adapter seam；生产 adapter 不能在 Core 内部实例化。

### 权责隔离

- GitHub：正式 plan 与 plan revision 来源、可审计 projection；
- 业务 ledger：action、外部效果、原始 evidence、receipt；
- Claim Authority：claim、lease、fence、owner；
- Coordinator：run、handoff、wake、delivery/liveness；
- NF：worker、judge、generation、本地恢复和执行运行态；
- projection：只读派生视图，drift 不得改变业务事实或执行权。

## 稳定 identity 与不变量

每个 action execution 都必须携带并可核对：

`program_id`、`plan_id`、`plan_revision`、`action_id`、`event_key`、`nf_task_id`、`run_generation`、claim fence。

核心不变量：

1. 同一 action/resource 只能有一个有效 claim owner；旧 fence 不能写回。
2. 已开始、冻结、已提交或已产生外部效果的 action 不接受后续 revision 的上下文覆盖。
3. 相同 event key、trigger 或 action identity 至多产生一次业务执行/receipt/timer。
4. 外部提交结果为 unknown 时，只允许 recovery/readback；在确认前不允许重试可能造成副作用的提交。
5. action 完成后必须重新读取当前 plan revision，禁止沿用旧上下文选择后续 action。
6. NF `DONE` 只表示 NF runtime 完成，业务完成须由 evidence 与 domain gate 判断。
7. `WAIT_EXTERNAL` 只能表示真实外部等待路径，不能兜底普通内部失败。

## Ticket frontier

Tickets 会按下列依赖顺序发布到 GitHub。每个 ticket 必须有行为、owner、阻塞关系和可独立验证的验收标准。

1. **T1 — DPC Core continuation seam 与稳定 identity**（无阻塞）
   - 建立 greenfield 最小运行时和测试基线；完成正常 action 的选择、NF 调用、receipt、plan readback。
2. **T2 — claim fencing、run generation、stale-write rejection 与 unknown recovery**（阻塞于 T1）
   - 强制单 owner、旧 owner/旧 generation/旧 revision 拒绝写回，未知提交只进入 recovery/readback。
3. **T3 — plan revision、evidence receipt、domain gate 与 advisory plan change**（阻塞于 T1）
   - 明确 revision 有效范围、证据解释和 C 的 bounded tactical exploration；proposal 不得直接改计划/授权/scheduler。
4. **T4 — 统一 wake intent 与 pull-first Coordinator seam**（阻塞于 T2）
   - 手工、timer、evidence、revision、handoff、recovery 共享 wake identity 和 dedupe；提供 resolve/claim/read/ack/writeback。
5. **T5 — Harness handoff checkpoint 与 workspace unknown**（阻塞于 T2、T4）
   - Claude Stop 生成可核对 bundle，Codex/Grok 可继续同一 action；未确认 checkpoint、dirty workspace、未知 delivery 均为 blocked/unknown。
6. **T6 — Standard Kit conformance 与 authority/projection isolation**（阻塞于 T1–T5）
   - 统一 profile conformance tests、GitHub read-only projection 和 Claim Authority isolation，证明 projection drift 不改变业务事实。
7. **T7 — 一个真实外部副作用 action 的端到端验收**（阻塞于 T1–T6，并需要外部授权/运行环境）
   - 真实 NF A-B-C、evidence writeback、重复 dispatch、handoff、unknown recovery 和重新选取 action；没有真实副作用证据时保持 blocked。

## 实施顺序与完成证据

每个 ticket 以外部行为测试为 test surface，不测试实现内部结构。每次 pass 要检查 diff、运行 focused tests，再运行完整可用的 lint/type/build/integration checks。测试替身必须模拟：重复 dispatch、旧 fence、旧 generation、旧 revision、late result、unknown commit、dirty workspace、wake dedupe 和 projection drift。

SPEC exit gate 只有在下列证据全部可读回时才通过：

- T1–T6 的实现、测试和审计结果；
- T7 的真实外部副作用 action 标识、receipt、readback 和恢复证据；
- 所有稳定 identity 与 claim fence 可核对；
- 未确认 Stop、dirty workspace、unknown delivery/result 未被伪装为成功；
- DPC 仓库没有第二套业务 ledger、queue、scheduler 或 planner；
- 外部 NF 仓库未被本仓库直接修改。

## T1 实施证据

- 运行时：TypeScript 编译到 Node.js ESM；测试使用 Node 内置 test runner；仅增加 TypeScript 开发依赖。
- 公开 seam：`DpcCore.dispatch`，每次最多推进一个 action occurrence，并在 receipt 写回后重新读取当前 plan revision。
- 适配器：`PlanSource`、`ActionLedger`、`NfActionRuntime` 和 `Profile` 均通过依赖注入；提供 in-memory 实现。
- 行为测试：覆盖顺序 action、依赖/时间门、revision readback、重复 event key、NF `DONE` 与业务完成分离、NF adapter 错误、claim fencing、旧 identity 拒绝、unknown recovery-only。
- T2 增加 `ClaimAuthority` 与 `RecoveryAdapter` seam；旧 fence/generation/revision/task identity 被拒绝，unknown 只允许 readback。
- T3 增加 revision scope、advisory `plan_change_proposal` 和 tactical route no-progress classification，且不提供任何计划写入器。
- T4 增加统一 `WakeIntent`、dedupe、lease/fence、pull-first resolve/claim/ack/writeback 和单一 canonical schedule seam。
- T5 增加 provider-neutral handoff bundle、checkpoint mode、workspace/Stop/delivery blocked/unknown 状态和同 action readback。
- T6 增加 Standard Kit profile conformance checks、只读 projection adapter 与 drift report；Claim Authority 不暴露业务 ledger/projection 写接口。
- 验证：`npm test` 通过（38 passed，2 skipped；共 40 tests）；`npm run check` 通过。Cloudflare 与 Needs Forever live acceptance 均需显式启用，并分别保存 provider-side-effect 与真实 NF unknown-recovery 证据。
- 增加 `LocalFileEffectRuntime` 作为安全的本机真实副作用前置 adapter：临时目录写入、幂等 marker、readback、cleanup、路径越界拒绝；本机测试验证真实写入、重复 dispatch 和 unknown readback recovery。
- 增加 `CloudflareKvEffectRuntime` 与使用本机 Wrangler OAuth 的 `WranglerKvEffectRuntime`；opt-in live test 使用唯一 KV key、完整稳定 identity envelope、unknown readback recovery、duplicate dispatch、同 action handoff checkpoint 和 finally cleanup readback。Wrangler 已认证，专用 `DPC_T7_ACCEPTANCE` namespace 的 provider-side-effect preflight 已通过，测试后 namespace 为空。
- 增加 `NeedsForeverLocalFileRuntime` 与 `tests/needs-forever-live.test.js`；通过本机已认证的 `needs-forever` `control.mjs` 启动真实 disposable independent-worker NF path，在独立临时 workspace 产生真实文件副作用，DPC 以观测超时记录 `UNKNOWN`，再通过 readback 确认结果而不重新启动 NF，验证 duplicate dispatch、same-action handoff、next-action selection 与 cleanup。该测试未使用 simulated fixture，也未修改 Needs Forever 仓库。
- 当前工作树的前一基线已提交并推送；本次真实 NF acceptance 变更需在验证完成后提交并推送。父 SPEC exit gate 的真实副作用、receipt、readback、recovery、duplicate、handoff 和 next-action 证据已形成，准备更新 tracker。

## 当前阻塞与决策记录

- 仓库没有既有技术栈；T1 选择 TypeScript/Node，并在 README 中记录理由。
- Issue #1 没有提供可调用的真实 NF adapter、真实 action、测试数据、scheduler cadence 或外部授权；T7 在这些输入可读回前不能完成。
- GitHub `ready-for-agent` 标签在本次分解中创建；ticket 发布若遇网络/API 故障，必须保留本地 spec，并在 tracker 可用后补发与读回。
