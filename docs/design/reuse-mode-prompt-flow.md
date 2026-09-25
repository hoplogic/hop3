%% @trace
	id: hopjit-reuse-mode-prompt-flow
	source: [[../concepts/HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-runtime
	type: extend
	last_sync: 2026-08-28T13:21+0800
	note: 复用模式 prompt 完整场景——skill 常驻指令层 + engine 每步 context 层如何叠加驱动 CC；engine 每步进出的进程模型；三个要害风险（skill 不可压缩、context 跨步重复、compact 不可自管只能状态外置复位）+ 两个 context 治理（minimal 精简治标、subagent driver 治因）。综合 hop-cli / prompt-assembler / spec-observability 的复用模式侧。
		2026-08-27 +四之补三 ^anc-exec-reuse-verdict-outsource：/hop 自驱阅卷分权（出题/答题留主对话,check final 判定恒外移 fresh subagent——作者三分叉拍定 F1 只final/F2 恒外移/F3 内联高频+指路全量）+知识供给两面（任务上下文落卡必做/构建知识不吝啬token）——abort批review 三处失守 meta-review 的机制化对治,落点 driver 两载体。
		2026-08-28 +四之补四 ^anc-exec-reuse-distill：/hop 提纯与现货复用一对机制（distill 干完的活→hop_tasks/specs/ 成品 spec,四动作参数化/结构固化/把关强化/语境泛化;查现货=开活前扫存量,同类复用差一截作底稿）——触发从宽"有总结的意思就主动",引擎零改动,落点 driver 两载体;同日生命周期走查改定:命中恒底稿实例化不直接跑（缝一）+"直接开"跳查口子（作者留）+修订同过目（缝二）+原料两形态（对话直干的活同可提纯,步骤类型现判验证面降档）。
		2026-08-30 +四之补五 ^anc-exec-reuse-worktree-act：改仓库文件的活的 act/commit 分界兑现（作者抓"不应该是 act/commit 所强保证的么"——修复标 act free 直改共享区=偷渡 commit;改动阶段进 worktree=act 可逆物理兑现,合入归 commit,P8 把关链完整）
%%

# 复用模式 Prompt 完整场景（skill 层 × engine 层）

> **为什么要这份文档**：复用模式下 CC 收到的"有效提示"不是单一来源，而是**两层叠加**——常驻的 hopspec skill（driver 操作手册）+ engine 每步吐出的 step_ready.context（当步数据）。二者分属不同进程、不同生命周期，必须合起来看才理解 CC 实际在什么提示下工作。本文档也记录由此暴露的**三个要害风险**：skill 不可被压缩、engine 跨步 context 重复、compact 不可由 driver 自管（Claude Code 架构缺陷，只能靠状态外置复位）。
>
> **⚠️ 本文档锚点的落点性质（2026-08-01 anchor-audit 澄清）**：本文各 `^anc-exec-reuse-*` 契约约束的是 **driver/skill 的行为**（怎么读 status 分派、什么不能压缩、compact 后怎么复位、执行段何时外包 subagent），**落点在 `driver/*.md` 与 driver 静态 lint，不在 `src/*.ts`**——引擎侧对应的只是"每命令一进程、状态全外置"这一既有实现（`^anc-cli-state-load` / `^anc-exec-durable-resume` 已各自追溯）。
>
> 故 anchor-audit 的"设计→代码（`src/`）覆盖"维度对本文档锚点报缺失属**预期**，非追溯断链；审计应看 driver 侧是否遵守（`scripts/check-driver-carriers.mjs` 承担 Codex carrier 侧的静态纪律检查）。

## 一、两层提示叠加【说明】 ^anc-exec-reuse-prompt-layers

复用模式下 CC 作为 driver + 推理 LLM，它每一步的"有效提示" = 两层合成：

| 层 | 来源 | 生命周期 | 承载 |
|---|---|---|---|
| **常驻指令层** | `driver/hopspec-skill.md`（部署副本 `.claude/skills/hopspec/SKILL.md`）| **CC 主对话全程常驻** | CC 作为 driver 的"操作手册/行为宪法"：怎么读 `status` 分派、reason/check 自己推理、act 按 body 执行、**HITL 必须问人**、Bash 纪律、parallel fan-out 规则 |
| **每步数据层** | engine 的 `step_ready.context`（`AssembledContext` 6 层）| **每个 CLI 命令一个进程，吐完即退** | 当前步的具体数据：L1 Spec 契约+骨架、L3 执行链、L4 输入、L5 指令、L6 输出约束（+ 可选 L2 知识/L2d doc-ref/L2c 重试反馈/L3b 迭代历史） |

**关键**：engine **只产出第二层**（结构化 context），**从不产出也从不看见第一层**——skill 是 CC 侧常驻大脑，engine 是每步进出的状态机。CC 在自己进程内把两层合成为实际推理 prompt。这就是 [[spec-observability#^anc-obs-mode-boundary]]"推理内幕归 caller"的物理根源：合成发生在 CC 进程，engine 记不到（hoplog 只能记它交付的第二层，见 [[spec-observability#^anc-obs-debug-context]]）。

## 二、engine 每步进出的进程模型【契约】 ^anc-exec-reuse-process-model

复用模式下 **engine 不常驻**。每个 CLI 命令（`init` / `submit_and_fetch_next` / `resume` …）是**独立进程**：起进程 → 读 `.hopstate/` 快照重建 engine → 推进一步 → 写快照 → **进程退出**（见 [[persistence#^anc-provider-persistence]] FilePersistence："CLI 每个命令是独立进程，状态必须外置存活"）。

**一步的完整交接**（以 reason 步为例，真实抓自 data-quality 执行）：

```
CC（常驻，挂 skill）                         engine（每步一个进程）
  │
  │  submit_and_fetch_next 1 --output {profile}
  ├──────────────────────────────────────────▶ 进程A 起
  │                                             读快照 → completeStep(1) → nextStep
  │                                             算出 step 2，组 AssembledContext
  │   ◀────────────────────────────────────────  吐 step_ready{step2, context}
  │                                             写快照 → 【进程A 退出】
  │
  │  CC 用 skill 手册分派：status=step_ready, step_type=reason
  │  → skill §2「CC 自身就是推理 LLM，依据 context 推理」
  │  → CC 在自己进程内合成（skill 角色约束 + context 数据）→ 推理出 fix_strategy
  │
  │  submit_and_fetch_next 2 --output {fix_strategy}
  ├──────────────────────────────────────────▶ 进程B 起（engine 全新重建）…
```

**engine 在步 1 与步 2 之间完全不在**。跨步连续性 100% 靠 `.hopstate/` 快照 + CC 常驻。

**推论——HITL 时 engine 必然不在场**：confirm/ask 暂停时 engine 吐 `paused` 就退出（与 step_ready 同样退出，HITL 不是特例）。CC 靠 skill §2 硬约束「必须 AskUserQuestion 问人、禁止自答」收集决策，人答完再起新进程 `submit_and_fetch_next <id> --answer` 注入。**等人期间没有任何 engine 进程存活**——这是复用模式跨进程 resume 天然工作的原因（每步本就跨进程），与独立模式（engine 常驻内存等 resume）相反。

## 三、要害风险一：skill 不可被压缩【契约】 ^anc-exec-reuse-skill-integrity

**风险**：skill（`hopspec-skill.md`，271 行）是复用模式**唯一**的 driver 行为规范。它不在 engine 里、不在 context 里——CC 若把它压缩/摘要/遗忘，driver 行为即失控，且 **engine 无法察觉**（engine 看不见 skill）。

**具体后果**（skill 被压缩会丢的硬约束）：
- **HITL 问人**（skill §2 confirm/ask）：压缩掉 → CC 自己替人拍板 confirm/ask，违反 CITL 语义（作者显式介入点被架空）。
- **present_inputs 完整 dump**（skill §2 ask 呈交硬约束）：压缩掉 → 用户没看全内容就被要求拍板。
- **Bash 纪律**（每命令一件事、禁管道/链式）：压缩掉 → 触发 pipe_guard 弹窗打断执行流。
- **parallel fan-out 规则**（subagent 模板、worker 文件名唯一化）：压缩掉 → 并发 worker 串台、内容覆盖（历史实证 bug）。
- **act body 严格执行**（有 hop_python 逐行执行、不自由发挥）：压缩掉 → CC 在执行期"自由发挥"，破坏确定性。

**约束**：
- skill 是**行为宪法级**的常驻上下文，**部署/运行时不得压缩、摘要、截断**。宿主（Claude Code）加载 skill 应保证全文注入。
- skill 本身的编写应控制在**必要指令**内（当前 271 行），避免膨胀到易被上下文管理策略牺牲——**"不可压缩"的前提是"本身足够精简到值得全驻"**。
- 与 engine 侧的 `formatPromptText` 覆盖守护（[[spec-observability#^anc-obs-debug-context]]）互补：一个保 engine 交付层完整，一个保 skill 指令层完整——两层都不能残缺，CC 才在完整提示下工作。

> **v0 现状**：skill 完整性依赖宿主（CC）的 skill 加载机制，HopJIT 引擎无从校验（引擎看不见 skill）。这是复用模式的固有边界，非引擎可修的债——但必须在 driver 部署约定里明写"skill 全文常驻，不可压缩"。

## 四、要害风险二：engine 跨步 context 重复【契约：已登记债】 ^anc-exec-reuse-context-repetition

**风险**：engine 每步吐的 `step_ready.context` 里，**大段内容跨步几乎不变、每步全量重发**——复用模式下每步是独立 API 往返（CC 每步重新读一遍 context），重复段直接放大 token 成本。

**实测重复段**（data-quality 相邻两步 L1 完全相同）：

| context 部分 | 跨步变化？ | 重复代价 |
|---|---|---|
| **L1 task_context**：Goal + Constraints + Types + **完整步骤骨架** | ❌ 全程不变 | 每步全量重发（骨架越大越贵） |
| 角色前缀（若 CC 拼进 prompt） | ❌ 不变 | — |
| L2 知识 / L2d doc-ref | 多数步相同（spec 级 doc-ref 对所有步可见） | 每步重解析重发 |
| **L3 progress_summary** | ✅ 每步增长（追加上一步产出） | 合理增量 |
| L4 inputs / L5 instruction / L6 schema | ✅ 每步不同 | 合理 |

**判断**：L1（尤其完整骨架）+ spec 级 doc-ref 是**真重复**。对 N 步 spec，L1 被重发 N 次。当前靠 L1"选择性展示"部分缓解（[[todo/0004_DEBT-10-L1-执行树选择性展示_open|DEBT-10]] L3 侧），但 **L1 骨架本身每步全量**未优化。

**为什么 v0 尚可接受**：
- 复用模式下 CC 就是推理 LLM，**无双重收费**（reason/check 不额外调 API，见 skill 约束）——重复的是 CC 自己上下文窗口的占用，非额外 API 账单。
- 但仍占 CC 有限的上下文预算，大 spec（步骤多、骨架大、doc-ref 多）会明显挤压。

**优化方向（不在 v1 强制，登记待评估）**：
- L1 骨架跨步稳定部分可考虑"首步全量 + 后续增量/引用"，但需权衡：复用模式每步独立往返，CC 无跨步记忆保证，"引用前步"未必省（CC 可能已忘）。
- 归入 token 预算管理策略（[[roadmap]] v2-3 运行时基础设施 / [[todo/0004_DEBT-10-L1-执行树选择性展示_open|DEBT-10]] 同域），**实测大 spec token 压力后再定**，避免过早优化。

> **登记状态**：本项为复用模式 context 效率的**待评估优化**，非阻塞 v1 正确性（重复不影响执行正确，只影响 token 效率）。触发条件：真实大 spec 出现 CC 上下文窗口压力时。

## 四之补：上下文耗尽与 compact——为何 driver 无法自管，只能靠状态外置复位【契约】 ^anc-exec-reuse-compact-resilience

复用模式长 spec 跑下来，CC 对话历史（step_ready.context 每步累积 + §四 跨步重复）会涨向上下文上限，触发 **compact**（摘要压缩历史）。这对 driver 有两个威胁：① compact 可能摘掉"我正在 hopspec 循环中"，CC 丢线以为 skill 结束；② compact 摘掉 skill 指令体（见 §三，skill 落在对话历史里、非常驻）。

**本可用"执行前查余额、快满时主动 compact"预防——但当前 Claude Code 架构下 driver（CC/agent）做不到。三条已核实的机制事实**：

1. **agent 无法读自己的 context 余额**：token 用量只在 CLI 交互层 `/context` 以终端文本呈现，**不是 agent 工具循环能读回的结构化数据**。skill 写"检查余额再决定"无法可靠执行。
2. **agent 无法调用 `/context` / `/compact`**：二者是 **CLI 交互层 slash command（人机层），非 agent tool**。本环境无 `SlashCommand` 工具；实测 agent 执行 `/context` → shell `exit 127`（当成文件路径找不到）。**compact 只能用户手敲 `/compact` 或 harness 自动阈值触发，agent 无从发起**。
3. **compact 无 agent 可见的原生标记**：compact 后 CC 静默继承摘要，不知自己被压缩过。唯一可靠感知靠 **hook**（PreCompact 落盘 / SessionStart[source=compact] 重注入），而非 agent 自省。

> **定性：这是当前 Claude Code 的架构缺陷**——agent 层（Bash/Read/Write/Task…）与 CLI 交互层（`/context`/`/compact`/`/model`…）严格隔离、不交叉。"上下文管理"能力只在人机层，**driver agent 无法自我感知余额、无法自我 compact，只能用户自己 compact**。HopJIT 无法在 skill 里修补此缺陷（无对应机制）。

**HopJIT 的对治——不防 compact，而是让 compact 无损**（复用模式"状态外置"哲学的天然红利）：

- **状态全在 `.hopstate`**（[[persistence#^anc-provider-persistence]]），CC 是哑应答体——compact 丢了对话历史，**执行状态一点不丢**。
- **复位契约**：compact / 上下文重置 / 换进程后，driver 靠 **`hopjit status`**（读 `.hopstate` 吐当前进度）+ **`hopjit resume`** 重新定向，接着应答循环。这与窗口多大、能否自查余额**全无关**——是复用模式跨进程模型（[[#^anc-exec-reuse-process-model]]，engine 本就每步进出）的自然延伸。
- **关键约束的抗 compact 归属**：真正不能丢的 driver 硬约束（HITL 必问人、Bash 纪律、"循环中"身份）应放**每请求重注入的 CLAUDE.md**（唯一确认抗 compact 的层），而非仅靠 skill 对话历史（会被摘要）。skill 侧则应写明"compact 后见 status 复位"的自救指令。

> **窗口澄清（避免误判紧迫性）**：Opus 4.8 等模型 **1M 上下文默认开启**（`1m-context` 能力，无需 opt-in），autocompact 按真实窗口 ~83.5% 触发。故中小 spec 远未触顶——本节风险主要面向**超长 spec** 或**小窗口 runtime 驱动 hopspec** 的场景。`/context` 有时显示 200k 分母是已知显示 bug，不代表真实窗口。

> **登记状态**：复位契约（status/.hopstate 重定向）属 **v1-1 健壮性**收尾（[[roadmap]]）——机制成立、与窗口无关。"driver 自管 context"因架构缺陷**不可做**，登记为 Claude Code 平台限制，非 HopJIT 债。

## 四之补二：顶层 driver 用 subagent 隔离主上下文【契约】 ^anc-exec-reuse-subagent-driver

上文的 context 精简（[[#^anc-exec-reuse-context-repetition]] minimal 模式）**治标**——省单个上下文内的 token；本节的 subagent driver **治因**——不让执行段污染主上下文。二者叠加：subagent 拿独立窗口，minimal 再省它自己的预算。

**姿态**：`/hopspec run` 下，**主 agent 只当编排者，全程不进执行链**——处理引擎的介入点（paused 问人、parallel fan-out、adaptive replan、终态）；**纯执行段**（连续 reason/check/act/commit 的 run→submit 循环）**外包给 driver subagent**（独立 context 窗口）跑。执行段每步的 step_ready.context 累积在 subagent 里，跑到介入点/终态只把结果 + 一行摘要返回主 agent。主上下文只留介入点，不被逐步执行污染。

> **主 agent 连 `run` 都不自己跑**（run 交首个 subagent）：`run` = init + advanceToCaller，advance 到首个 step_ready 时**已 recordStepStart**（记 start + prompt）。若主 agent 跑 run 只为探路（拿 step_ready 就起 subagent、自己不执行），就**抢记了首步 start**，subagent 接管后再执行同一步 → hoplog 首步出现两个块（时间戳不同，像跑了两次）。
>
> 故 run 亦归首个 subagent——"探路的人 = 执行的人"，首个 recordStepStart 由真正执行者触发，无抢跑。instance_id 由 run 生成、subagent 回报主 agent 供后续介入点注入。（治本在驱动姿态，非给 recordStepStart 打幂等补丁。）

**为何安全（全部现成机制）**：
- **subagent 范式已存在**：parallel worker 就是驱动一棵 child 子树的 subagent（[[parallel-execution#^anc-exec-parallel-fanout-model]]）。本姿态 = 把它推广到顶层执行段。driver subagent（顶层）与 parallel worker（child 子树）是同范式两种粒度。
- **HITL 冒泡**：subagent 遇 paused/parallel_ready/adaptive_needed **立即返回**该 JSON，介入点归主 agent。paused 归主 agent 天然满足"subagent 无权问真人"。与 [[parallel-execution#^anc-exec-parallel-confirm-exclude]]（含 confirm 子树引擎排除、留主循环）同哲学。
- **状态外置 = subagent 退出无损**：状态全在 `.hopstate/<instance_id>`（[[#^anc-exec-reuse-process-model]] engine 本就每步进出），主 agent 起新 subagent 用同一 instance_id 无缝接续（跨进程 resume 天然成立）。这与 §四之补的复位契约同源。
- **唯一 fan-out 编排者**：driver subagent 遇 parallel_ready 冒泡回主 agent 处理，不自己再起 worker——避免 subagent→subagent 深层嵌套。

**续接交接契约（在手响应随交接转移）**：主 agent 在介入点注入（`--answer`/`--replan`）后拿到的返回 JSON **就是下一个待执行动作**（通常 step_ready）——引擎的介入点响应**只发一次，不可重取**（`submit_and_fetch_next` 必须先交一份步骤结果才能领下一步，续接者手里没有可交的；`status` 只报位置不含执行上下文）。

- 因此起续接 subagent 时**必须把这份未消费的响应 JSON 原样完整传入**（`<PENDING>`），续接 subagent 从执行它开始进循环——消费权随交接转移，不允许"只传 instance_id 让续接者自己领"（洞：续接者无协议通道取回在手响应，只能盲驱或读源码猜，真机实撞 2026-08-13 cc:adaptive 超时）；
- Codex 载体同款纪律=交接信封的 `current_response 原样完整传递,不摘要`——两载体同一契约，CC 侧载体原语为 `<PENDING>`；
- 兜底：续接 subagent 未收到 `<PENDING>` 时不得盲驱，按 DRIVER_PROTOCOL_ERROR 返回主 agent 报交接缺件。

**权衡**：执行段进度不再逐步显示在主对话（在 subagent 窗口内），主 agent 在介入点粒度报进度 + 转述 subagent 摘要。这正是隔离主上下文的代价与目的。

> 驱动指令落点：[[../driver/hopspec-skill]] §1-§2（主 agent 编排循环 + §2a driver subagent 模板）。纯 skill 层，零引擎改动。

## 四之补三：/hop 自驱的阅卷分权与知识供给【决策+契约】 ^anc-exec-reuse-verdict-outsource

**为什么（2026-08-27 作者定"这个应该如何分拆合适"——abort 批 review 三处失守的 meta-review 定性）**：/hop 恒复用模式主对话自驱，把 **spec 作者、执行者、check 判定者**压进同一个 LLM——自己出题、自己答题、自己阅卷。

- 实撞（abort批review 任务，2026-08-27）：check final 判据被写进"或标注未核"后门（出题人给自己留的）、执行时以"同构采信"走了后门（答题人自我豁免）、被打断后判定干脆没走（阅卷可以被跳过）；
- 定性：**知识供给决定语义松动的下限（有明文就不好意思绕），角色分离决定上限（不分离总有能绕的缝）**——引擎强制的是结构（把关点存在、顺序、契约对账），判据的严格性与判定的诚实性在引擎视野之外，须由 driver 层分权补齐。

**三权分拆契约（HopTrait——driver 行为能力面，Spec without Steps）**：

```markdown
# Spec: hop阅卷分权
Id: hop-verdict-split
Goal: check final 判定权外移至无执行语境的独立判定者,出题/答题仍留主对话

## Inputs
- 待判产出物: text      # check final 的 ← 输入全文
- 判据原文: text        # spec 里该 check 步的核对条目
- 任务卡叙事节: markdown # 背景/参考(口径与语境)——不含执行过程叙事

## Outputs
- ok: bool   # 判定
- note: text # 理由/缺口——主对话哑搬运给引擎,不改判不软化
```

**分权表（HopType——三权字段逐条）**：

| 权 | 归属 | 时机与约束 |
|---|---|---|
| 出题（写 spec 含 check 判据） | 主对话 | 写卡时刻——上下文最全且尚无交付压力;判据受编写纪律约束（下）;run 起后 check final 引擎禁改（^anc-exec-replan-proactive 闸口继承）——"出题时刻锁死" |
| 答题（执行各步） | 主对话 | /hop 立身之本（上下文在场）;过程 check（非 final）自判保反馈速度,判 false 引擎 retry 兜 |
| 阅卷（check final 判定） | **fresh subagent** | 恒外移（F2 作者拍定 2026-08-27:有 spawn 即外移,零自由裁量——裁量权留给执行者=留给答题人）;无 spawn 载体降级=判据硬化自判 |

**行为契约（逐条,验证面）**：

1. **阅卷人供给面 = 产出物全文 + 判据原文 + 任务卡叙事节（背景/参考）**，**不含执行过程叙事**——判定对着产出与判据，不被"我为什么这么做"说服（无沉没成本是外移的价值本体）;任务卡"计划+语境同体"的既有设施恰是给阅卷人的完整供给包;
2. **主对话哑搬运判定**：subagent 回 ok/note，主对话原样 submit——不改判、不软化 note;不服判定的合法出路是修产出重交，禁"换个说法再问一遍"（重派必须产出物有实变）;
3. **判据编写纪律（出题侧,治下限）**：判据必须是执行者不能单方面满足的形态——具体、可核对、指向产出物本身;禁"或标注即可"式后门;采信他人结论必须逐条给采信理由，"同构/同理"不算理由;
4. **范围 = 仅 check final**（F1 作者拍定:过程 check 留主对话自判——终检是交付把关外移收益最大，过程判错有引擎 retry 兜，全外移伤随手感）;
5. **中途废弃的交付标注**：任务 abort/废弃但已有半成品要交付时，交付物须标注"未过终检"——把关消失这件事对用户可见（实撞:abort 后报告在对话里裸交付,终检静默蒸发）。

**知识供给三面（作者定 2026-08-27"都要充分供给,不能吝啬token";2026-08-28 补第三面）**：

- **任务上下文面**：对话结晶落卡从"可选的好习惯"升格为**必做**——口径、材料指针、已拍的板全文写进任务卡背景/参考节。判据：新会话/subagent 读卡即接手零追问。这同时是阅卷人供给面（契约1）的原料——语境不落卡，阅卷人就只能盲判或找执行者要（要来的就是执行叙事，污染独立性）;
- **构建知识面**：skill 本体内联高频坑速查（F3 作者拍定:狗粮实撞坑系统化展开不吝啬字数——C7 把关后无干活步/check 双槽/P8 commit 前置闸/P11 产出链），复杂 spec 指路引擎包内语法参考全量。纯指路不可取——"用时再读"在赶进度时最先被跳过，等于退回隐性供给;
- **表达形态面（2026-08-28 作者定,否掉"给机器可以用简写"的直觉）**：给 subagent/LLM 的一切文字——派活 prompt、任务卡、spec 步骤说明、阅卷包判据——**全部用完整的话写,零压缩黑话零会话内自造代号**。
  - 为什么对 LLM 受众更要如此：LLM 对压缩表述的理解比人更容易出错且非常不稳定——人读不懂会反问,LLM 不会反问、按猜的理解直接执行且不出声,误解指令的执行者会带着错误理解跑完全程（实撞:看护 subagent 把"返回即下班"这类压缩表述理解成可中途交卷,两次误收工;各班监视口径靠代号传递发生漂移）;
  - 判据与说人话铁律同一条:没跟过过程的读者一遍读懂。派活 prompt 里的判据、停止条件、命令逐条写全,不用"停点3""严判>N"这类只有写的人自己懂的缩写。

**阅卷流程（HopSop）**：

```markdown
1. [act] 走到 check final,组阅卷包
   - 产出物全文（← 输入变量的真实值）+ 判据原文（spec 该步条目）+ 任务卡背景/参考节
2. [branch] 按 spawn 能力分派
   1. [case(有 spawn)] 派 fresh 阅卷 subagent（零执行语境）,收 ok/note
   2. [case(else)] 降级自判——判据硬化是唯一防线,逐条对照判据核产出
3. [act] 哑搬运:submit ok/note 原样入引擎
4. [case(判 false)] 引擎 retry 重跑——修产出重交,不换说法重问
```

**与相邻契约分工**：本节=判定权归属与供给面（driver 行为）;把关点存在性归引擎（P8/check final 禁改跳——结构面已有闸）;subagent 派活范式复用 §四之补二（同款 fresh 窗口/冒泡哲学,粒度不同:那是执行段外包,这是判定点外包——方向恰反:执行外包保注意力,判定外移夺裁量权）;落点=driver/hop-skill.md + driver/codex/hop-skill.md（两载体同步,零引擎改动——引擎对"谁判的"零感知,它只收 ok/note）。

## 四之补四：/hop 提纯与现货复用【决策+契约】 ^anc-exec-reuse-distill

**为什么（2026-08-28 作者两连定："把一个刚完成的工作总结成可复用的 hopspec" + "同样的，已有的，哪些可以复用"）**：/hop 的任务卡是一次性的——参数写死这一次的值、背景写这一次的语境，跑通即归档。但跑通的流程本身是**被实战验证过的资产**：步骤结构经过引擎强制走完、check 判据经过打回修正、坑都撞过了。

- 不提纯，这份资产随归档沉底；只提纯不消费（下次开活仍从头写），提纯就是白做。所以是**一对机制**：提纯（distill，生产半边）把干完的活升格为可复用成品 spec；查现货（生产的消费半边）在开新活时先扫存量，有同类就复用；
- 两半边都归 driver 层——引擎零改动（提纯产物就是普通 HopSpec 文件，查现货就是开活前的一次目录扫描）。

**能力契约（HopTrait——driver 行为面，Spec without Steps）**：

```markdown
# Spec: hop提纯
Id: hop-distill
Goal: 把一个跑通的 /hop 任务提纯为可复用的成品 spec,落 hop_tasks/specs/,经用户过目确认后落定

## Inputs
- 任务卡终态: markdown   # Steps=replan 写回的生效版(不是开工初版);背景/处置记录供泛化判断
- 引擎账展开物: yaml     # [subtask free] 到步展开的实际子步(status/hoplog,复盘场景可读)

## Outputs
- 提纯件: markdown       # hop_tasks/specs/<语义名>.md——validate 0 error+开头 [[原任务]] 回指
```

**要素表（HopType——四动作字段逐条）**：

| 动作 | 输入 | 输出 | 判据 |
|---|---|---|---|
| 参数化 | 这一次的具体值（对象/路径/日期/阈值） | `Inputs` 声明+示范参数（注释或 sample 文件） | 换参数即可跑同类活 |
| 结构固化 | 展开物+这次没走到的分支 | 稳定形态固化为显式子步/本质随机的保留 free;未走到的分支标"未经实跑验证" | 验证面如实——不冒充全验证 |
| 把关强化 | 这次 check 打回抓过的缺口 | 缺口写死进判据;缺 check 的段落补上 | 成品把关只高不低——实战教训变引擎强制 |
| 语境泛化 | 背景节（本次专有语境） | 通用使用说明（干什么/输入怎么备/适用边界） | 剥离"这一次",内容章节缺省供给面写的是未来每次的口径 |

**行为契约（逐条，验证面）**：

1. **触发从宽（作者定 2026-08-28"有总结的意思就可以主动调用"）**：用户话语含"总结/沉淀/固化/下次还要干"即主动提纯，不等 `distill` 子命令或"可复用"精确措辞；子命令 `/hop distill <n>` 是指定对象的显式形态。歧义封口：对**没干完**的活说"总结"→ 给进展汇报，不误触提纯（没跑通的流程无"实战验证"可言）；
2. **原料两形态——hop 任务与对话直干的活都可提纯（作者定 2026-08-28"不只是针对跑过的hop任务"）**：
   - **hop 任务**（有引擎账）：原料拿终态不拿初版——Steps 读 replan 写回后的文件现状（^anc-exec-specfile-writeback 的消费方）；展开物读引擎账（此场景属"用户要求复盘"，hoplog 可读——输出纪律的既有豁免口）；
   - **对话直干的活**（没走 /hop，在对话里做完的）：原料=对话里的实际执行轨迹——真实走过的步骤序、中途撞过的坑与修正、已拍的口径。四动作照做，外加一条 hop 任务提纯没有的活：**步骤类型要现判**（对话轨迹没有 act/reason/check/commit 标注——哪步是不可逆动作必须标 commit、哪里该补 check，全靠此刻判；判据同升格要点）。
     - 验证面如实降档：对话直干没有引擎强制的把关记录，提纯件里的 check 是"该有"而非"验过"——诚实标注，不冒充与 hop 任务同级的实战验证；
     - 对象话语点名即从之（"把刚才这个 PR 审查流程总结一下"），缺省仍指最近干完的活（hop 或对话直干，就近认）；
3. **落盘与验收**：
   - 产物落 `hop_tasks/specs/<语义名>.md`（作者定 2026-08-28"项目根再开目录太污染"否掉根级 hop_specs/——/hop 的一切住 hop_tasks/ 一个家：活跃活/archive//specs/ 三分区；specs/ 下无同名卡目录，list 的"活跃区同名卡"判据天然不会把它误列成活；用户指定别处则从之）；
   - `validate` 0 error；开头一行 `[[<原任务名>]]` 回指（出处可溯，归档目录躺着完整实跑原料）；
   - **用户过目确认才落定**——提纯是发布性质动作（从此被反复跑，写错被反复复制），此一眼比任务内任何 check 都值。原任务目录照常归档不动；
   - hop_tasks/ 整目录在 .gitignore（过程材料不入库），提纯件随之不入 git——它的持久保障是盘上文件+用户确认过目，跨项目/入库分发是另一档需求（真出现再议，不预设）；
4. **查现货前置（作者定 2026-08-28"同样的，已有的，哪些可以复用"）**：开新活的升格流程插一步——分流、消歧之后、从头写 spec 之前，扫 `hop_tasks/specs/` 各件 `# Spec:` 标题+Goal（一行一件，轻扫描）。
   - **动手扫之前先给用户一行提示**（作者定同日"中间应该给用户提示"）："我先看看已有的任务流程里有没有可复用的——想跳过就说'直接开'"——查现货不该是静默动作：用户看得见才知道 agent 在干什么、才知道有跳过的口子（口子不提示=形同没留）；
   - 命中（同类或大体同类）→ 告诉用户有现货并**恒以现货为底稿实例化一张新任务卡**（完全同类=零改动照抄+填参，差一截=底稿上改）——不直接跑提纯件本身（生命周期走查抓的缝：直接跑=无任务卡/list 不列/current 不指,与"进 /hop 的活恒享全套"冲突；用户自己明说要 /hopspec run 提纯件的，从之——那是成品 spec 的既有正路）；无现货才从头升格；
   - 用户问"哪些可以复用"→ 列清单（名字+Goal 一行一件）。`hop_tasks/specs/` 不存在 = 还没提纯过，静默跳过零仪式；
5. **"直接开"跳查口子（作者定 2026-08-28"如果说 /hop 直接开 ... 就不查已有 spec"）**：用户话语带"直接开"（或同义的"直接建/别查现货/从头来"）→ 跳过查现货，径直从头升格建卡——用户比 agent 清楚这活是不是新东西，明示直开就不拿现货清单打断；分流与消歧两闸不随之跳（该不该进 /hop、输入缺不缺，与查不查现货无关）；
6. **提纯件修订同过目**：改既有提纯件（复用中发现要改、或用户要求更新）与首次落定同律——改完 validate 0 error + 用户过目确认才生效（"发布性质"覆盖修订：改坏同样被反复复制）。提纯件不入 git（随 hop_tasks/），改坏无版本回滚是已知代价——挂账不建机制，真撞了再议；
7. **出口提示**：收干完的活时顺口带一句"要不要提纯成可复用的？"——一句话不强推，用户没接话只归档（动作提示挂流程出口，与"终态后顺手归档"同律）。

**提纯流程（HopSop）**：

```markdown
1. [act] 收原料:任务卡终态(Steps+背景+处置记录)+引擎账展开物
2. [reason] 四动作:参数化→结构固化→把关强化→语境泛化,产提纯件草稿
3. [check] validate 提纯件——0 error 才呈递(报错拿代号对语法参考改)
4. [ask require_human] 用户过目:计划结构+参数面+判据,确认才落定
5. [act] 落盘 hop_tasks/specs/<语义名>.md,回指原任务;原任务照常归档
```

**与相邻契约分工**：本节=driver 行为（提纯的原料/动作/验收+查现货的时机/分派），引擎零感知——提纯件是普通 spec 文件，跑它走 /hopspec 既有全套。

- 任务卡结构与内容章节供给归 ^anc-rule-narrative-sections（提纯件的"通用使用说明"正是写进其缺省供给面）；Steps 终态可信性归 ^anc-exec-specfile-writeback（镜像写回是"原料拿终态"的前提）；
- hopbuild 是"NL skill → spec"的翻译器（输入是别人写的自然语言技能文档），本节是"实跑轨迹 → spec"的提纯器（输入是自己跑通的任务），同产成品 spec 不同原料，互不替代；
- 落点=driver/hop-skill.md + driver/codex/hop-skill.md（两载体同步）；守卫=check-driver-carriers 动作面 parity（六动作 token 两载体齐备）。

## 四之补五：改仓库文件的活——act 语义的 worktree 兑现【决策+契约】 ^anc-exec-reuse-worktree-act

**为什么（2026-08-30 作者抓"但这个不应该是 act/commit 所强保证的么"——工程链 review 提纯件首次狗粮后的对账）**：act/commit 分界是语言的核心保障——act 必须可逆（概念权威=语法参考"必须无不可逆外部副作用（仅无副作用计算 + 沙箱/临时区操作）";教程 03 的对照表把"改正式文件"明列 commit 侧不可逆例——review 抓原引文逐字出处是教程非 concepts,标注修准），commit 前必须站着把关（P8 引擎强拦）。

- 但 /hop 的活常常要**修改仓库里的正式文件**（修 bug、补测试、改设计），实跑形态是把这些步骤标成 `[act free]` 直接改共享工作区——**"改正式文件"恰在概念层 act 可逆清单之外，这是把 commit 的事标成 act 混过把关**（升格要点点名的第一大坑，提纯件自己犯了：步骤 5 修复标 act free 直改主区，与并行会话共享工作区，靠"git add 只加自己的"软纪律兜底；尾部 [commit] 只剩 git push 一下，不可逆面被切碎前段冒充 act）；
- 复用模式下引擎管不到 CC 怎么写文件（执行在 caller 侧），本条款是 driver 层把语言保障接续到操作面的桥。

**能力契约（HopTrait——driver 行为面）**：

```
# Spec: 改仓库文件的活的类型分界兑现
Id: hop-worktree-act
Goal: 修改仓库正式文件的活,改动阶段在 worktree 内进行(act 可逆的物理兑现),合入主区归 commit——语言的 act/commit 分界在操作面成立

## Inputs
- 活的改动面: text   # 这个活要改哪些仓库正式文件
## Outputs
- 隔离出口: text     # worktree 里的成品经 check final 验收后由 commit 步合入主区,或弃区零后果
```

**分界表（HopType——动代码的两种性质,物理形态逐条）**：

| 性质 | 步骤类型 | 物理形态 | 出口 |
|---|---|---|---|
| 变异/试验（改完就扔） | act | worktree 内改,跑完弃区（git worktree remove --force,路径恒用建区变量） | 无出口——弃区即零后果,这就是"可逆" |
| 修复/产出（要留下来） | act（改动阶段）+ commit（合入阶段） | act 步在 worktree 内改+跑测试;check final 对着 worktree 里的成品验收;commit 步把改动合入主区（git -C 主区 cherry-pick/apply 或 worktree 内 commit 后 merge）+推送 | 合入=不可逆动作,commit 语义+P8 前置把关罩住 |

**行为契约（逐条,验证面）**：

1. **判据=改不改仓库正式文件**：活的步骤要写仓库里会留下来的文件（src/docs/tests/……）→ 改动阶段进 worktree;只写 work_zone/临时区/对话产物的活照旧（act 本义已覆盖,不加仪式）。
   - **中间地带——持久但不入 git 的文件**（review 抓判据两头不沾:hop_tasks/ 提纯件为实例,"要留下来"但 gitignored,worktree 检出里物理不存在合入通道也没有）：归"照旧"侧——worktree 机制对 gitignored 文件物理不可用,其误伤面也天然小（不入 git=并行会话冲突不经 git 合并放大,坏了没有版本回滚本就是该类文件的已知代价〔distill 条款既有声明〕）;写这类文件的步骤守既有软纪律（改前后过目）即可;
2. **worktree 是 act"可逆"对改文件场景的物理兑现,不是新纪律**——主工作区物理未被碰:并行会话撞车面消失、弃区即完全回滚、"git add 只加自己的"从唯一防线降为 commit 步的常规操作;
3. **check final 验 worktree 里的成品**（改完+测试绿的完整形态),把关过了 commit 才把改动请出隔离区——不可逆动作(合入共享区+push)整体落在 commit 步,P8 前置把关链完整;
4. **弃的路径恒为建区时的同一变量,不手打**（提纯件面三既有条款升格为通则——删错兄弟 worktree 是唯一真危险,变量复用物理掐掉）;
5. **工程偏差（v1 如实）**：本条款约束力=driver skill 文字,复用模式引擎管不到 CC 写哪里——与阅卷分权同档（知识供给决定下限）;将来 act body 走 subprocess.run 白名单形态时,worktree 建弃可升为引擎强制（todo/0033 消费方半边）。

**操作序（HopSop）**：

```
改仓库文件的活:
1. [act] 建区:WT=<观测目录>/wt(路径存变量);git worktree add "$WT" <基线>——基线是当前已检出分支名时 git 拒"already checked out",用 commit 号(detached)或 -b 新分支;软链 node_modules
2. [act] 改动+自测全在 $WT 内(主区零接触;并行会话在主区的活动与本活无交集)
3. [check final] 对 $WT 里的成品验收(测试数字/改动清单)
4. [commit] 合入主区(git -C 主区 用 $WT 的提交或补丁)+推送;主区脏且碰同文件时 cherry-pick/apply 会拒——这不是故障是并行提示:先与主区改动核对(谁的批先落),按"只提交自己的工作"纪律协调后再合,不 force;然后弃区 git worktree remove --force "$WT"
5. [弃路] check 不过且不再修 → 直接弃区,主区从头到尾未被碰,零残留
```

**与相邻契约分工**：act/commit 语义权威=概念层核心创新;P8 把关链归引擎;变异核证的 worktree 用法归工程链 review 提纯件面三（本条款是其通则化——同一隔离,变异出口=弃,修复出口=commit 合入）;subprocess.run 白名单是将来的引擎强制通道（todo/0033）。落点=driver/hop-skill.md 两载体升格要点 + hop_tasks/specs/ 提纯件修订。

## 五、两层与可观测性的关系【说明】

完整复盘一次复用模式执行需三个数据源（[[spec-observability#^anc-obs-mode-boundary]]）：
1. **engine 侧 hoplog**：每步 `llm.prompt` = engine 交付的 context 渲染（第二层，可观测、有覆盖守护）。
2. **skill**：CC 的常驻指令（第一层，静态文件，不进 hoplog——但"不可压缩"保证它对 CC 生效）。
3. **CC 会话记录**（caller 生态，如 ccglass）：CC 把两层合成的实际 prompt + 推理内幕（engine 够不到）。

engine 侧只能、也已经忠实记录第二层；第一层靠 skill 完整性约束；第三层归 caller。三者通过 instance_id 关联。

> **引用**
> - [[hop-cli#^anc-cli-response-types]] §StepReady — engine 吐给 CC 的 step_ready 结构（第二层载体）
> - [[prompt-assembler#^anc-exec-prompt-assembly]] — AssembledContext 6 层组装（第二层内容）
> - [[persistence#^anc-provider-persistence]] — FilePersistence 跨进程快照（每步进出的存活机制）
> - [[spec-observability#^anc-obs-mode-boundary]] — 双模式记录分界（三数据源归属）
> - [[../driver/hopspec-skill]] — 常驻指令层全文（第一层）
> - [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]] — 双模式概念权威
