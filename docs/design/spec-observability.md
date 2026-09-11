%% @trace
	id: hopjit-observability
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extend
	last_sync: 2026-08-22T20:02+0800
	note: HopLog 设计规范——执行轨迹日志组件。内容分级（决策/契约/说明）+ 10 个契约锚点。三级日志、审计性字段、流式单文件输出。2026-07-02 修正 ^anc-obs-mode-boundary：复用模式 llm.prompt 非空（记引擎交付的 context 渲染，CC 即 llm），只有 response/tokens/tool 归 caller
%%

# HopLog 设计规范

> **与可观测性的关系**：可观测性是 HopJIT 的整体能力（执行轨迹、状态查询、进度展示、caller 侧记录），HopLog 是其中**执行轨迹记录**这一职责的组件实现。状态查询（`hopjit status`/`vars`）见 [[hop-cli]]，进度展示属 CLI/Skill 层，caller 侧记录见本文"双模式记录分界"。
>
> **概念权威**：本文是 YAMLL 日志格式的**设计实现**（缩进/字段/方法级契约）。其概念级命题——为什么 YAMLL、格式不变量、保证的可观测性属性、跨载体一致性——在概念层 [[HopSpec V3扩展-可观测性与YAMLL日志格式]]，本文各 `^anc-obs-*` 锚点是其向下推演。概念是源、本文是 `extend` 派生。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、格式演示、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节             | 分级               | 锚点                                                                                    |
| -------------- | ---------------- | ------------------------------------------------------------------------------------- |
| 定位（四要素）        | 契约               | `anc-obs-hoplog`                                                                      |
| 双模式记录分界        | 决策+契约            | `anc-obs-mode-boundary`                                                               |
| 文件组织           | 契约               | `anc-obs-file-layout`                                                                 |
| 日志级别           | 契约               | `anc-obs-log-levels`                                                                  |
| 主文件结构          | 说明（示例）           | —                                                                                     |
| 容器步骤特殊记录       | 契约               | `anc-obs-nested-tree`                                                       |
| 步骤块键解析单一事实源 | 契约               | `anc-obs-step-keys`                                                         |
| 卫星文件结构         | 说明（未实现见 [[todo/0003_DEBT-09-HopLog-llm-response未记录_open|DEBT-09]]）   | —                                                                            |
| HITL 记录规范      | 契约               | `anc-obs-hitl-record`                                                                 |
| 审计性字段规范        | 决策+契约            | `anc-obs-audit` / `anc-obs-replan-audit`                                              |
| info 精简形态      | 说明               | —                                                                                     |
| 时间戳规则          | 契约               | `anc-obs-timestamp`                                                                   |
| 与 HopSpec 概念对应 | 契约               | `anc-obs-step-mapping`                                                                |
| 实现约束           | 契约               | `anc-obs-execution-log-absorption` / `anc-obs-hoplog-flush` / `anc-obs-hoplog-resume` |
| debug 上下文记录   | 契约               | `anc-obs-debug-context` |
| trace_id 继承     | 契约               | `anc-obs-trace-inherit` |
| v1 实现偏差        | 说明               | —                                                                                     |

## 定位【契约】 ^anc-obs-hoplog

> **模块版本**：hoplog `v0.4.0`（2026-09-02。本版新增 recordRuminationSuspect 文档级留档方法（^anc-exec-thinking-exhausted 二批,hopissues/0060）。0.x 未承诺稳定。日志 YAML 格式是半稳契约——人/agent 复盘读,格式破坏影响既有日志解析；此定位锚点即 hoplog 模块的归属锚点）

**① 自身定位**：HopLog 是 HopJIT 的执行轨迹日志组件——只追加、实时落盘的完整执行历史，**给人和 agent 排查深层次 bug 用的**。当 Spec 执行出现预期外结果（LLM 幻觉、数据异常、策略失败、retry 耗尽）时，HopLog 提供足够信息**还原完整的决策链路**：每一步什么时候开始、输入什么、产出什么、调了什么工具、谁批准了 commit、为什么失败。（解释性类比：类似飞行记录仪——事后复盘用，不参与飞行控制。）

**② 与其他 HopType 的关系**：
- **ExecutionEngine 持有并调用**——每次步骤状态变更时由 Engine 调 record* 方法写入
- **与状态快照（PersistenceProvider）职责互补**：快照是"让执行能继续"（每次覆盖、引擎自读），HopLog 是"让人能复盘"（只追加、人和 agent 读）。快照可在执行完成后清理，HopLog 有长期保留价值
- **StepDispatcher 经 Engine 写入执行内幕**（独立模式的 tool/llm/commit_audit 字段）
- **不走 PersistenceProvider 抽象**——落盘是 HopLog 的本质职责，非可替换的环境适配

**②b 对外接口清单【封闭】** ^anc-obs-hoplog-exports：

> 本表是 hoplog 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `hoplog.ts`。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `HopLog` | 类 | hoplog.ts | 执行轨迹日志组件（engine 持有并调 record*） | stable |
| `LogLevel` | 类型 | hoplog.ts | 日志级别枚举（engine/cli 配置最低记录级别） | stable |
| `timestamp` | 函数 | hoplog.ts | 生成带时区偏移的毫秒精度本地时间戳（YAMLL 各事件的时间字段单点来源；engine 记 join/dispatch 时刻复用，保证与日志内时间同源同格式）。2026-08-01 补登 | stable |
| `extractHopLogStepKeys` | 函数 | hoplog.ts | 从真实 YAMLL `execution:` 下提取精确步骤块键（HopLog resume / carrier-live-e2e G11 消费） | stable |

> **内部（表外即内部）**：`StepRecord`/`HitlRecord` 等日志条目结构、各 record* 方法的参数类型——它们是 HopLog 类的实现细节，外部只经 `HopLog` 实例方法交互。

**③ 主要 traits 与主要成员**：

Fields：

- `level: LogLevel`——本次 run 的最低记录级别（`debug | info | warn`，默认 `debug`——权威条款见下方日志级别章节 ^anc-obs-log-levels，2026-08-23 作者定）。构造时设定，run 期间不变。控制非审计字段的裁剪深度（见日志级别章节）；审计性字段不受其控制
- `runDir: string`——本次 run 的输出目录路径（`.hoplog/{spec_id}-{run_id}/`）。构造时按命名规则生成并创建目录；`getRunDir()` 暴露给 Engine 持久化到 state.json（resume 用）
- `filePath: string`——main.yaml 的完整路径（`{runDir}/main.yaml`）。所有 record* 方法的 append 目标；`getFilePath()` 暴露给测试和事后分析定位文件
- `startedSteps: Set<string>`——本进程内已调用过 `recordStepStart` 的步骤 ID 集合。**孤儿字段守卫**：步骤未 start 时收到 done/failed/meta/warn 调用，说明 Engine 调用序列有 bug——向文件写入错误标记（`# ERROR: orphan ...` 注释行）暴露问题，然后丢弃该写入（否则字段会错位挂到上一个步骤块下破坏 YAML）。不抛异常——日志组件无权打断执行主流程，但 bug 必须在复盘时可见
- **无内存镜像**——唯一信息源是 main.yaml 文件本身。不维护文件内容的内存副本（冗余即漂移之源：镜像与文件可能不一致，resume 后镜像必然是假象）。查询已记录内容一律读文件

trait（按职责分三组）：

**步骤记录组**——run 执行期间的核心写入路径，全部受孤儿守卫（步骤未 start 时写 ERROR 标记后丢弃）：

- `recordStepStart(stepId, type, summary, inputs?, promptText?)`——**步骤进入 running 时调用（含容器）**。写入步骤骨架（`"id":` 条目 + type/summary/at）。**debug 级别写入 `llm.prompt` = 完整自包含 prompt 文本**：叶子步骤由 `formatPromptText` 生成（角色说明+6层内容）；parallel 容器的批量渲染函数 formatParallelPromptText 已随 P0.5 旧通道退役删除（现行 dispatch_ready 逐个派发,2026-08-30 review 标注）。info 级 inputs 真实值（截断到 200 字符），warn 级不记录值。将 stepId 加入 startedSteps。一般容器（subtask/loop/branch）只记骨架；parallel children 记录骨架 + inputs（params_for_child） ^anc-obs-debug-context
- `recordStepDone(stepId, outputs?)`——步骤完成。追加 outputs（按级别裁剪）+ `status: completed` + `completed_at`
- `recordStepFailed(stepId, reason)`——步骤失败。追加 `status: failed` + `failed_at` + `reason`（脱敏后）
- `recordRuminationSuspect(where, outputTokens, content)`——疑似反刍留档（^anc-exec-thinking-exhausted 消费,hopissues/0060 二批）:**文档级顶层块**（`rumination_suspect:` 键+where/output_tokens/content 子字段——三字段全过 toYaml,'?' 类回退值裸插会写出 YAML 保留指示符破坏整档）,**不过孤儿守卫**（命中时点在截断抛错前,步级归属不可靠——recordWarn 空 stepId 顶层块同先例）;content 经 sanitizeFull 抹密钥**不截断**（全文是留档价值本体,llm.prompt 全文核验通道同理）;无视日志级别恒写（审计性——线下判"是不是反刍"的唯一证据）。**已知权衡:多份留档=顶层同名键重复**（≤5 份封顶下常态可现）——库内 YAMLL 消费是行式正则解析（extractHopLogStepKeys 族）天然容忍,文档级 `warn:` 先例同病同对称;外部 strict YAML 工具整档 load 会拒,线下分析用文本工具或逐块切读（review C1-3 判权衡记账,不改键形态——破坏 warn 对称性且库内消费零收益）。
- `recordStepMeta(stepId, meta: StepMeta)`——步骤特有字段。按字段分类决定写入：审计性字段（tool/commit_audit/hitl/callee_spec_id）无视级别始终写入；流控字段（knowledge/retry/taken/condition/llm/tokens_used）info 级写入
- `recordWarn(stepId, message)`——告警附注。warn 级以下写入，消息脱敏。**stepId 非空 = step 级**（warn 作该 step 块字段）；**stepId 为空 `''` = 文档级**（如"Output 声明却从未赋值"，不归属任何 step）→ 落顶层 `warn:` 独立块，不过 guardOrphan/blockHeader（空 id 无 step 归属，若走守卫会被误当孤儿写成 `# ERROR: orphan` 而正文丢失）。**组装期告警暂存（2026-08-25 修 #29）**：step 级 warn 在该 step 尚未 start 时**不走 guardOrphan 丢弃,暂存入 pendingWarns**——`recordStepStart` 写完 start 块后冲账为该 step 的 warn 块。机理:prompt 组装（含 [context-compress] 压缩告警）发生在 recordStepStart 实参求值期,时序天然早于 start——这不是调用序列 bug 而是组装期的合法告警,guardOrphan 一行标记吃掉正文等于压缩观测通道在最常见路径（大样触发压缩）上失聪（ppt 走查实锤 orphan recordWarn(4.2)）;参照 doc-ref meta 的 flushDocRefMeta 暂存先例。暂存判据两半（review 探针补齐）:未 start（首轮组装期）**∪ 上轮已终态**（loop 新轮组装期——此刻轮次计数未 +1,直写会把告警落上一轮块键归错轮;暂存到新轮 start 后冲账恰落 #N 块）。已知权衡:暂存是纯内存,暂存窗口内 crash 正文丢（context-compress 路径窗口极小可接受）;[cond-eval] 指向永不 start 步骤的告警滞留到 close 兜底,run 中途 crash 即丢——close 兜底只对正常终态生效。判据外延警示（二审实抓回归后立规）:"上轮已终态"半边会把**同轮终态后的验尸型告警**（先 recordStepFailed 再 recordWarn 同一步骤）也捕进暂存——hoplog API 层分不出"新轮组装期"与"终态后验尸",**引擎侧调用纪律:终态后的附注告警必须挂仍 running 的宿主容器,不挂已终态步骤自身**（0018 orphan 同修先例;markSubtaskFailed 串行退化 warn 实撞归错轮后改挂宿主）。close 兜底前缀两形态:从未 start 记 `[step X 未start]`,start 过但终态后未再 start 记 `[step X 终态后]`——前缀不撒谎。到 `close()` 仍未等到 start 的暂存项以文档级 warn 兜底落账（`[step <id> 未start] <正文>` 前缀）——真调用序列 bug 正文也不丢,复盘可见。guardOrphan 对 done/failed/meta 语义不变

**步骤块键解析单一事实源**：YAMLL 的步骤记录不是 `step: <id>` 字段，而是 `execution:` 下按步骤深度缩进的块键：`  "1":`、`    "1.1":`，loop 后续轮可带 `#N`。任何需要核验步骤是否在日志出现的消费者必须调用 `extractHopLogStepKeys`，不得用子串匹配另造格式；精确块键解析同时避免步骤 `1` 误命中 `10`。 ^anc-obs-step-keys

**start 触发点设计**：`recordStepStart` 在 pending→running 各路径调用（本段行尾锚定）：①`nextStep()` 消费 `dfsNextStep` 返回的 `newlyRunning[]` 为容器记录骨架；②`nextStep()` 对叶子步骤标 running 后调用（含完整 AssembledContext）；③`nextParallelBatch()` 对 parallel 容器及 children 标 running 时调用（含调度信息）。**branch 的选中 case 也走 newlyRunning**——`handleBranchEntry` 评估命中后把选中的 case 节点 push 进 `state.newlyRunning`（连同 branch 自身），由 nextStep 统一记录骨架；未选中的 case 走 skipped 不记 start。**派发门例外（统一模型）**：选中 case 被判定为 dispatchable（`unifiedDispatch` 开 ∧ case 带 parallel 标注,src/engine-traverse.ts:554-562）时**不 push newlyRunning**——case 留 pending 交派发门（直接标 running 会绕过派发门退化串行下钻），本路径的 start 记录归统一模型派发路径：子实例派发时 `dispatchParallelSubtask`/`dispatchParallelCall` 经 `recordParallelDispatch` 落 dispatch 事件（src/engine.ts:1896、2333），子树内步骤的 start 由 worker 子实例自己的 hoplog 记。覆盖全路径，不与返回逻辑耦合。 ^anc-obs-step-start-timing

**done 触发点设计**（^anc-obs-step-done-timing）：`recordStepDone`/`recordStepFailed` 在 pending/running→终态各路径调用——叶子步骤由 `completeStep`/`failStep` 直接记录；容器 done 由 `propagateCompletion` 级联触发时记录:**TraversalState 暴露可选 `newlyDone: StepNode[]` 通道**,propagateCompletion 把进入终态的容器（subtask/loop/branch/case + 选中分支链）push 进去；调用方（`completeStep`/`joinParallel`/`handleFailStepRetry`/`selectBranch` 等）在 propagateCompletion 返回后消费 newlyDone，对每个容器调 recordStepDone（含容器声明的 `+→` 聚合输出，从父 scope 读取）或 recordStepFailed（branch 选中 case 失败→branch failed）。**parallel 容器**done 仍由 `joinParallel` 直接调（已在 v2 实装,不走此通道）。这保证 hoplog 里所有容器有完整 start→done 生命周期,审计可重建容器级耗时与 scope 边界。**嵌套树缩进（见 [[#^anc-obs-nested-tree]]）**：容器 done 以容器自身深度缩进（status 在 `2d+2`）续写在子树之后——子步已写更深缩进，YAML 据缩进闭合子 mapping、status 归容器，无需重写 key 头、无重复 key。这依赖 propagateCompletion 保证"容器 done 必在其所有子步 done 之后"（本时序不变）。**worker 掩码祖先豁免（2026-08-30,todo/0022 清账）**：worker 子实例（subtreeRoot 非空）里,子树根祖先链上的容器是 executeSubtreeOnly 设的 **scope 掩码——结构状态非执行态,worker 内从未 recordStepStart**;失败/完成终态化沿祖先链 propagate 时,newlyDone 会包含这些掩码祖先,对它们调 recordStepDone/Failed 必触发孤儿守卫写 `# ERROR: orphan…caller sequence bug` 假标记（守卫本身按设计工作,但文案指控的"调用序列 bug"不成立——这是 worker 结构的固有形态,真实 hoplog 反复出现误导复盘）。修法=propagateAndRecord 消费 newlyDone 时**跳过掩码祖先**（subtreeRoot 的真祖先,判据与 recoverDanglingRunning 的 maskAncestors 同一集合）——不记 done 也不触发守卫;真孤儿（非掩码祖先的未 start done）仍须标记,守卫语义不变。 ^anc-obs-step-done-timing

**parallel 执行流事件**（parallel 步骤的子字段，按步骤深度缩进嵌入 execution 树，补充记录 fan-out/join 结构化信息）：

> **⚠️ 缩进契约（修订，^anc-obs-nested-tree）**：`fanout`/`join` **不是顶格根级事件**——它们是所属 parallel 步骤（如 4.3）的 body 子字段，缩进 `2d+2`（与该步的 type/summary/at 并列，`d` = parallel 步骤深度）。**曾误实现为顶格 0 缩进**：在 fan-out/join 时（execution 深缩进流中途）append 一个顶格键，会提前闭合整个 `execution:` mapping → 其后步骤全部错位、YAML 不可解析，违反 §609「任何时刻都是合法 YAML」。修正为随步骤深度缩进后，fanout/join 作为该步的 body 字段自然嵌在其子树内。

> **⚠️ parallel child 生命周期归子 hoplog（方案 A）** ^anc-obs-parallel-child-satellite：父 hoplog 的 parallel 步骤（4.3）子树里 **不写 child 的 start/done**——每个 child 有独立子 hoplog（`parallel/<child_id>/log/.../main.yaml`，目录嵌套即关联），start/done/prompt/outputs 全在那里。**父记 5 类 body 事件**（YAMLL 各自成块，块头都是 `"4.3":`，均在 `2d+2`）：① `type/summary/at`（4.3 start）② `fanout`（children 全集 + max_concurrent + started_at，"开始持续派发"的锚点）③ **`dispatch`（每派发一个 child 一条，带 `child`/`dispatched_at`/`log`，其独立契约段见下）** ④ `join`（各 child 终态 + 各自 `log` 子日志路径 + started_at/ended_at）⑤ `status/completed_at`（4.3 done）。
> **为何流式必需**：child 的 start（fan-out 时）与 done（join 时）被两个远隔时刻撕裂，中间穿插 fanout 与兄弟 child——流式 append 无法让同一 child mapping 字段连续写完（曾致深缩进 child-done 接浅缩进 fanout、YAML 非法）。归子 hoplog 后，父 parallel 子树只剩同层 body 事件块，YAMLL 下块块独立、天然合法。
> **兼收"冗余即漂移之源"**（^anc-obs 无内存镜像原则）：child 详情本就在子 hoplog，父再记一遍是重复源。父留 fanout/dispatch/join 的 child_ids + 派发时刻 + 终态 + 子日志路径即够重建"派了谁、各自何时起、各自成败、去哪看详情"，child 内部步骤不在父重复。

> **⚠️ dispatch 事件——如实记录"持续派发过程"（2026-07-09）** ^anc-obs-parallel-dispatch：满额滑动窗口下 N 个 worker 是**增量、跨进程、随空位陆续派发**的（fanout-plan 起初始批、fanout-next 每完成一个补一个），**不是 fanout 那一瞬间同时启动**。若只有 fanout 块，日志会把"9 个 child 持续派发"塌缩成"一个时刻一批"，丢失真实节奏。故每次引擎决定派发一个 child（`fanoutSchedule` 把它纳入 `toLaunch`）就**流式 append 一条 dispatch 事件**到父 hoplog：`child`（cid）+ `dispatched_at`（引擎决定派发的时刻，即"引擎动作时刻"——不是 worker 进程真正 exec 的时刻，那在无句柄的 subagent 里不可得）+ `log`（该 child 子日志目录，确定性算出）。9 个 child = 9 条 dispatch 块、时刻各异 → 持续过程如实体现。**跨进程可行性**：fanout-plan/fanout-next 是 `ExecutionEngine.load` 起的顾问进程，load 会 `HopLog.resume(hoplog_run_dir)` 重建父 hoplog 句柄（父 run 目录跨进程持久在 state），故顾问进程能流式 append 父日志。

- `recordParallelFanout(parallelStepId, childIds[], maxConcurrent)`——parallel 批量就绪时记录（父 run 展开、`nextParallelBatch` 时一次）。在 parallel 步骤 body 内写 `fanout:` 块（缩进 `2d+2`，`d` = `stepDepth(parallelStepId)` 从 step-id 点号自算，**不新增签名参数**）：**字段序 `max_concurrent` → `children` → `started_at`**（max_concurrent 先行，是窗口容量、比 children 列表更该先看到；`started_at` 表"开始持续派发"，parallel 阶段的"结束"由 join 的 `ended_at` 承载，fanout 不强做二元起止）。始终记录、无视级别。**前提：该 parallel 容器已经过 recordStepStart**
- `recordParallelDispatch(parallelStepId, childId, logDir)`——每派发一个 child 一次（统一模型：dispatchParallelCall/Subtask 派发点逐个调），流式 append 一条 `dispatch:` 块（缩进 `2d+2`）：`child` + `dispatched_at`（=调用时刻，引擎动作时刻）+ `log`（子日志目录）。始终记录。见 ^anc-obs-parallel-dispatch。
- **`reap:`/`settle:` 块（P1，2026-08-11 设计定形）** ^anc-obs-parallel-reap：`recordParallelReap(hostId, childId, status)` 随到随收逐条流式（child/status/reaped_at——对称 dispatch 块）；`recordParallelSettle(hostId, reaped)` 容器终态化一条（settled_at + 已收清单）。记录点=引擎 reapParallelCall/Subtask 与 settleHostAfterReap（两模式共用）。理由：派发入轨而收割不入轨=G11 对收割段全盲。契约细节见 [[parallel-execution#^anc-exec-parallel-reap-log]]。
- `recordParallelJoin(parallelStepId, childResults, startedAt)`——join 完成时记录（join_parallel 单进程）。在 parallel 步骤 body 内写 `join:` 块（缩进 `2d+2`，`stepDepth` 自算）：`children`（各 child 终态 completed/failed **+ 各自 `log` 子日志路径**，join 时本就逐个读了 child 子实例、顺手带出定位线索）+ `started_at`（进入 join 的时刻，由 engine 在 join 起始捕获传入）+ `ended_at`（merge 完的时刻，方法内 `timestamp()`）。**join 阶段同时触发 children + parallel 容器自身的 recordStepDone/recordStepFailed**——engine `joinParallel()` 负责：每个 child 标终态时调 recordStepDone（含聚合输出）或 recordStepFailed，parallel 容器完成后调 recordStepDone（含容器声明的全部聚合输出）。这保证容器在 hoplog 中有完整的 start→done 生命周期。**事件顺序**：fanout 块 → 若干 dispatch 块（时序穿插在 worker 陆续起停之间）→ join 块 → parallel 容器 done，YAMLL 各自成块、块头都是 `"4.3":`、块块独立合法

**生命周期组**——run 的创建、收尾与跨进程续写：

- `constructor(options)`——创建 run 目录，立即写入 header（spec_id/run_id/trace_id/level/spec/inputs）+ `execution:` 标记。**header 中外部来源值（spec_id=用户 Id、trace_id=调用方传入）须过 `toYaml` 转义**（含空格/冒号即破 header YAML）；run_id/level 是内部生成/枚举可裸写。这是 [[../ARCHITECTURE#^anc-string-escape]]（字符串转义规范·强制）hoplog 通道的落点——所有写进 main.yaml 的值字段均过 toYaml，仅 step_type/status 等内部枚举有意裸写。
- `close(status)`——run 收尾。追加顶层 `status:`（completed/failed/cancelled）+ `ended_at`。close 后不应再有写入
- `static resume(runDir, level?)`——跨进程续写。不解析历史内容（文件已有完整记录），返回可继续写入的实例。startedSteps 从空开始。**resume marker 不立即 append**——见下「resume marker 的延迟结构化写入」。startedSteps 从空开始

**访问器组**——无副作用：

- `getRunDir()` / `getFilePath()`——输出位置查询（Engine 持久化 runDir 到 state.json；测试和事后分析定位文件）
- `flush()`——no-op。所有写入已通过 appendFileSync 实时完成，保留仅为 API 兼容

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl record_step（步骤生命周期记录）
1. [act] 步骤启动时写入骨架（type/summary/at），inputs 按级别裁剪后追加
2. [act] 执行过程中经 recordStepMeta 追加步骤特有字段
   > 审计性字段（tool/commit_audit/hitl/callee_spec_id）无视级别始终写入
   > 流控字段（knowledge/retry/taken/condition/llm）info 级写入
3. [act] 步骤完成/失败时追加 outputs+status / reason+status
   > 每次写入都是 appendFileSync 实时落盘，任何时刻文件都是合法 YAML
```

### 核心要求

1. **完整性**：每步的输入、输出、LLM 交互（model/tokens）、工具调用（name/result）、失败原因全部记录
2. **可追溯**：事件按时间顺序排列，step_start/step_done/step_failed 配对，容器完成级联可见
3. **安全审计**：审计性字段（tool/commit_audit/hitl/callee_spec_id）始终记录，不受日志级别限制
4. **分级控制**：debug 记录完整值（含 LLM prompt/response），info 记录脱敏+截断值（inputs 真实值截 200 字符，API key 类 pattern 抹除——2026-08-08 审计修正：原文"记名不记值"为 2026-06-17 前旧语义，与 ^anc-obs-debug-context 及代码不符），warn 只记录异常
5. **resume 支持**：跨进程恢复时以「延迟结构化写入」记 resume marker（`resumed_at` 字段，见实现约束 4），不破坏已有块标量、marker 不丢失，已有记录天然保留

### 不是什么

- 不是进度条——进度展示由 CLI/Skill 层负责
- 不是运行时状态文件——状态由 state.json 管理，HopLog 是只追加的审计日志
- 不是性能监控——token 用量附带记录但不是主要用途

### 双模式下的记录分界【决策+契约】 ^anc-obs-mode-boundary

由概念层原则 2 推演（记录分界 = 执行能力归属，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）：

由概念层原则 2 推演。关键区分：**引擎侧交付的 prompt** 与 **caller 侧的推理内幕** 是两回事，记录归属不同：

| 记录内容 | 独立模式 | 复用模式 |
|---------|---------|---------|
| 引擎侧事件（步骤状态、变量 I/O、暂停决策、audit） | HopLog | HopLog |
| **引擎交付的 prompt**（`llm.prompt` = `formatPromptText` 渲染的 AssembledContext——引擎组装、交给推理 agent 的完整原料；旧 formatParallelPromptText 半边已随 P0.5 退役） | HopLog（debug 级） | **HopLog（debug 级）** |
| 推理内幕（LLM 实际 response/tokens、工具调用明细、CC 脑内最终拼装的 prompt 措辞） | HopLog（Dispatcher 执行时记录） | **caller 生态观测工具**（如 ccglass 记录 CC 会话），不经 HopLog |

**关于复用模式 `llm.prompt`（曾误述为"自然为空"，已修正）**：复用模式下引擎不调 LLM，**CC 自己就是那个推理 LLM**——引擎能记、也确实记的是它**交给 CC 的完整 context 渲染**（`llm.prompt`，debug 级），这是引擎侧可观测的"交付物"，非缺陷、非空。引擎够不到的是 **CC 脑内实际拼装的最终措辞 + LLM 真实 response/tokens**——这部分归 caller 生态（引擎是纯流控器，不侵入 caller 推理过程，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）。复用模式 `tool:` / `llm.response` / `llm.tokens` 块为空是这层归属的正确体现。完整还原决策链路 = HopLog（流控轨迹 + 引擎交付的 prompt）+ caller 侧记录（推理内幕），通过 instance_id 关联。HopJIT 不实现 caller 内幕上报通道。

### 记录点选址：事实边界，不在意图层【决策+契约】 ^anc-obs-record-at-boundary

**原则（作者定 2026-08-24"hoplog 的位置有严重问题，不能再犯那么蠢的问题"）**：任何观测字段的记录点必须位于**被记录事实真正发生的架构位置**——谁把载荷发出边界，谁在发出的那一刻从**实际越过边界的对象**抄录；禁止在上游意图层记"打算发的东西"。

**事故背景（本条的实撞来源）**：`llm.prompt` 原记录点在 engine `recordStepStart`（意图层——把 `formatPromptText` 渲染件当 prompt 落账），而独立模式的真实 API 请求由 dispatcher 在发送口另拼（buildSystemPrompt+buildMessages，**不含修正指令段、不含角色段**）。同一 `llm:` 块里 response 记在发送口（DEBT-09，从 API 返回对象抄）是真的、prompt 记在意图层是假的——假 prompt 骗过十几轮走查，三次"模型锚定"定罪全部建立在模型从未收到过的 prompt 上，D58/D46/L2c 三个修复修在无人消费的渲染线上。prompt.ts 旧注释"本函数不代表独立模式实际发送内容（独立模式 llm.prompt 记录属 v2）"是登记过的已知偏差，爆炸半径被严重低估。

**落点（按模式各归其边界）**：

| 模式 | 发送边界 | llm.prompt 记录点 | 来源对象 |
|------|---------|------------------|---------|
| 独立模式 | dispatcher API 调用处 | `callLlmWithRetry` 发起前（与 response 同点成对） | **实际 request 对象**（system+messages 序列化） |
| 复用模式 | engine 交付 step_ready 给 caller 处 | `recordStepStart`（现状保留——formatPromptText 产物就是实际交付物） | step_ready 载荷渲染 |

**不变式**：`llm.prompt` = 越过边界的字节，`llm.response` = 边界回来的字节，同一记录点成对落账。任何"渲染了但未发送"的内容（body 直执步的组装件、被丢弃的中间渲染）一律不得进 `llm:` 块——"日志有 llm 块 = 真实发生了 LLM 调用，其 prompt/response 与线上字节一致"。独立模式下 engine `recordStepStart` **不再传 prompt 参数**（履历归 dispatcher 边界记录）；带 body 的 act/commit 步不经 LLM，任何模式都无 llm.prompt。

**正反例**：独立模式 hoplog llm.prompt 与 mock 抓到的实发 request 序列化逐字一致=正；engine 步骤开始时记了一份含修正指令段、而实发请求无该段=反（本次事故形态）；body 直执步日志出现 llm.prompt=反。

### 设计目标（实现层面）

1. **Debug 能力**：定位 LLM 交互问题，记录工作流实际运行结果，支持并行分支快速关联和 HITL 审查
2. **分级过滤**：三级日志（debug ⊇ info ⊇ warn），审计性字段无视级别始终记录
3. **单文件输出**：main.yaml（人和 agent 共读），任何时刻都是合法 YAML
4. **步骤类型特化**：reason 记录 `llm:`，act 记录 `tool:`，confirm 记录 `hitl:`，commit 记录 `commit_audit:`——审计信息是步骤字段，无独立事件流

---

## 文件组织【契约】 ^anc-obs-file-layout

### 存储位置

`.hoplog/` 目录，与 spec 文件同级：

```
specs/
  review.md
  .hoplog/
    review-20260530T003215-a1b2/           # 父 run 目录
      main.yaml                            # 父主日志
      parallel/                            # parallel worker 子日志（嵌套目录）
        1.1/review-20260530T003220-c3d4/   # child 1.1 的 run 目录
          main.yaml
        1.2/review-20260530T003221-e5f6/   # child 1.2 的 run 目录
          main.yaml
```

**parallel worker 子日志嵌套**：worker 的 `--log-dir` = `<parent_log_dir>/parallel/<child_step_id>`，hoplog 在该路径下按标准规则建 `{spec_id}-{run_id}/main.yaml`。目录结构本身即父子关联键——无需 grep trace_id 即可定位某次执行的全部日志。`ParallelReady` 响应携带 `parent_log_dir` 字段，driver 据此构造 worker 的 log-dir。

### 命名规则

- **Run ID**：`{YYYYMMDD}T{HHMMSS}-{4hex}`，4 位 hex 防止同秒冲突
- **Trace ID**：`trace_id` 统一使用 `instance_id`（UUID）——顶层 run 的 `trace_id` = 自己的 `instance_id`；call/parallel worker 子实例继承父的 `instance_id` 作为 `trace_id`。这保证**同一个 trace_id 串起所有关联 run**（父+子），grep 一个 trace_id 就能找到整棵执行树的全部日志。`run_id`（时间戳格式）标识单个 run，`trace_id`（UUID）标识关联的执行树 ^anc-obs-trace-inherit
- **Run 目录**：`.hoplog/{spec_id}-{run_id}/`
- **主文件**：`{run_dir}/main.yaml`——唯一输出文件，人和 agent 共用，流式追加，任何时刻都是合法 YAML
- **卫星文件**：`{run_dir}/{step_id}.yaml`（parallel/call 并发分支）

### 文件输出

`main.yaml` 单文件输出——每个 record* 方法实时 `appendFileSync`，无内部状态文件。resume 不需要解析历史（向文件追加 marker 后继续），事后分析用任意 YAML 解析器读取。

### 主文件 vs 子实例日志

| | 父主文件 | 子实例日志（parallel worker） |
|---|------|---------|
| 数量 | 1 per run | 0-N per run（每个 parallel child 一个） |
| 产生条件 | 每次运行 | parallel fan-out 的每个 child worker |
| 内容 | 完整执行树骨架 + fan-out/join 审计事件 + join 后续步骤 | 单个 child 子树的完整执行记录（独立 header/execution/status） |
| 位置 | `{parent_run_dir}/main.yaml` | `{parent_run_dir}/parallel/{child_step_id}/{spec_id}-{run_id}/main.yaml` |
| 关联方式 | 目录嵌套即关联 + `parallel_fanout.children` 列出 child_ids | `trace_id` 继承父 instance_id + `parent_instance_id` 字段 |

---

## 日志级别【契约】 ^anc-obs-log-levels

三级，**向下包含**：debug ⊇ info ⊇ warn。运行时设最低级别（**默认 `debug`**——2026-08-23 作者定"把缺省日志全部调成 debug 级"，原默认 info 废。两撞定案：①standalone 侧 info 不记 prompt 正文，L2c 反馈在不在外部无从核验，走查误判"重试无记忆"；②dr9 走查被 info 级 inputs 200 字截断制造观测幻象——skeleton 真值 7 步、日志显示 2 步带 `[TRUNCATED]`，闸门被误判失灵追查数轮。日志是核验通道，缺省就该全息；体积敏感场景显式降级：MCP 配置 `log_level` / CLI `--log-level` / EngineOptions.logLevel）。**call/parallel 子实例继承父级别**（同批修——原进程内 handleCallStep/launchParallelCallChild 建子引擎不传 logLevel，顶层 debug 而递归全 info：构建类 spec 的真正主体在递归层，恰好是黑箱；CLI 派发路径的 `--log-level debug` 继承先例已有，进程内路径对齐）。

| 级别 | 记录内容 | 典型用途 |
|------|---------|---------|
| `debug` | LLM 完整 prompt/response/tokens、步骤完整 I/O 值、工具调用参数和返回值、流控轨迹字段 | LLM 调试、数据流追踪 |
| `info` | 步骤进入/完成/失败 + 时间戳 + summary、**I/O 真实值**（sanitize API key）、流控轨迹字段 | 运行监控、执行回顾、结果审查 |
| `warn` | 步骤骨架（type/summary/at/status）+ 审计性字段。**不记录变量值**（inputs/outputs 不出现） | 异常追踪、最小日志 |

> **2026-06-17 修订**：原 info 级别只记录变量名（值为 null），实际使用中极度误导（看起来步骤产出了 null 而非真值）。改为 info 记录真实值（与 debug 相同的 sanitize 策略），warn 级完全不记录变量值。debug 与 info 的区别收窄为 LLM prompt/response 细节。

**审计性字段不受级别控制，始终记录**（见审计性字段规范）——原"audit 级别"被此规则取代，audit 不再是级别枚举值。

### 级别标注规则

每个步骤条目不标注级别——由字段是否存在隐含。规则：

- `llm:` 的 prompt/response 仅在 `debug` 级别写入（model/tokens 属流控轨迹，info 级写入）。**response = LLM 原始回复全文**（解析前的 text content 拼接），与 outputs（解析后）分立——排查"解析歧义/输出被判不合规"必须能对照原始回复（2026-08-24 兑现 DEBT-09，实撞：dr16 对齐门修订轮被判"逐字相同"，但该轮首次输出因 SCHEMA_MISMATCH 被丢弃重做且零落账，"LLM 究竟改没改"无从对证——定罪链断在观测层）。写入位置：`recordStepMeta` 的 `llm.response` 子字段，级别裁剪在 recordStepMeta 内做（debug 写全文，info 剥离 response 只留 model/tokens）
- **算子级 SCHEMA_MISMATCH 重试的每一轮尝试都独立落账**（`llm:` 块一轮一块，含被丢弃轮）——重做丢弃的输出是"模型当轮真实行为"的唯一物证，只记终轮=把中间轮蒸发成不可知（同上 dr16 实撞）。act 工具循环的多轮对话同理：每轮 API 返回各记一块（response 含该轮 text 推理与 tool_use 意图摘要——此前 act free 步零 llm 块，coffee 修错步三轮"无错未动"的判断依据无从对证）；**工具循环首轮 llm 块同时记 prompt**（发送口抄实际 request，与 reason/check 路径同源 serializeRequestPrompt——2026-08-31 补：act 路径此前只记 response 不记 prompt，"L4 工具清单有没有真进请求"在 hoplog 上无从对证〔工具清单料源修复的验证半边被此挡住〕；后续轮不重复记 prompt——每轮完整对话含全部前轮与工具结果，逐轮全文落账是 20 倍冗余，首轮已含组装上下文全文，后续增量在 tool: 块与各轮 response 里可复原） ^anc-obs-llm-response
- `retry_feedback:` 属流控轨迹字段，info 级写入（2026-08-22 补——L2c 重试反馈是"上一攻为什么失败"的决策链关键环：它只藏在 debug 级 prompt 全文里时，info 级日志会让走查者误判"重试无记忆"（ppt11 走查实撞）。体量小（单条失败说明）、价值高（还原重跑决策依据），与 retry/knowledge 同级落账；带反馈重跑的步骤在 recordStepMeta 记入，首跑无此字段）
- `inputs:` / `outputs:` 在 `debug` 和 `info` 写真实值（sanitize API key 等敏感 pattern），`warn` 级不记录
- `warn:` 字段记录告警信息
- 审计性字段（`tool:` / `commit_audit:` / `hitl:` / `callee_spec_id:`）任何级别都写入

---

## 主文件结构【说明：示例】

```yaml
# ===== Run 元数据（run 开始时写入） =====
spec_id: doc-review
run_id: "20260530T003215-a1b2"
trace_id: "305a0ec4-b479-4d16-bdc5-93c818bb708c"  # 跨 run 关联；顶层 run 的 trace_id = 自己的 instance_id（UUID）
level: debug                         # 本次运行的最低记录级别
started_at: "2026-05-30 00:32:15+08:00"

# Spec 快照（不含 Steps，仅 header 关键字段）
spec:
  title: 方案评审流程
  goal: 对方案文档进行多视角评审

# ===== Run 输入（debug: 完整值；info: 仅列名） =====
inputs:
  document: |                        # debug 级别：全量
    # 某某方案
    ## 背景
    ...
  mode: auto_fix

# ===== 执行树 =====
execution:

  "1":
    type: reason
    summary: 分析文档特征与脆弱点
    at: "2026-05-30 00:32:15+08:00"
    inputs:                          # debug: 完整值或引用
      document: {from: run.inputs.document}
    llm:                             # debug only
      model: claude-opus-4-6
      system: |
        你是一个文档分析专家。
      prompt: |
        请分析以下文档的特征和脆弱点：

        ---
        # 某某方案
        ...
        ---
      response: |
        ## 分析结果
        - 文档类型：技术架构方案
        - 核心主张：...
      tokens_in: 3456
      tokens_out: 892
    outputs:
      doc_analysis: |
        文档类型：技术架构方案
        核心主张：采用微服务改造
    status: completed

  "2":
    type: confirm
    summary: 确认评审模式
    at: "2026-05-30 00:34:28+08:00"
    hitl:
      shown: 确认评审模式   # =summary（问题面;#34 受众分流——选项归 response_options,instruction 归 paused 卡整卡）
      response: manual_confirm
      responder: human
    outputs:
      confirmed_mode: manual_confirm
    status: completed

  "3":
    type: subtask
    summary: 设计审查员角色
    at: "2026-05-30 00:34:30+08:00"
    children:
      "3.1":
        type: reason
        summary: 设计审查员五要素
        at: "2026-05-30 00:34:31+08:00"
        llm:
          model: claude-opus-4-6
          prompt: |
            ...
          response: |
            ...
          tokens_in: 2100
          tokens_out: 1350
        outputs:
          role_designs: |
            ...
        status: completed
      "3.2":
        type: act
        summary: 写入审查员模板文件
        at: "2026-05-30 00:35:45+08:00"
        outputs:
          template_paths: |
            ...
        status: completed
    retry: {max: 2, attempt: 1}
    outputs:
      reviewer_templates: |
        - name: 逻辑一致性审查员
          stance: 偏向怀疑
        ...
    status: completed

# ===== Run 收尾（run 结束时追加） =====
status: completed                    # completed | failed | cancelled
ended_at: "2026-05-30 00:45:23+08:00"
```

### 容器步骤的特殊记录【契约】 ^anc-obs-nested-tree

**v3 实现（YAMLL 格式，2026-07-09 落地——取代 v2 嵌套树）**：hoplog 是 **YAMLL**（YAML Lines，类比 JSONL）——**每个 record 事件是一个独立块，块内合法 YAML，全文不追求单一 YAML 树**。这是根本转向：v2 执念于"任何时刻全文是一棵合法 YAML 树"，逼着每次 append 都要维持嵌套闭合（resumed_at/fanout/join 落哪层、会不会劈断父 mapping）——实测在 resume/recover/多次续等组合下反复失败（顶格截断、深浅缩进相邻、重复 key、劈断子步）。**YAMLL 消除这一整类问题**：块之间互不依赖，不存在"劈断父结构"。

**块格式**：每个事件写成
```
<2d>"<step-id>":            # 块头，缩进 = step 深度 d（供折叠/阅读层级），d = id.split('.').length
<2d+2>字段: 值              # 块体，缩进 2d+2；字段值的 YAML 以 2d+2 为基线（多行 block scalar 内容 ≥ 2d+4）
```
关键规则（每个 record 方法独立成块、自带 step-id、缩进自算）：
1. **缩进基线 = 本事件所属 step 的深度**，由**写这个块的 record 方法自己算**（`2*stepDepth(stepId)`），不依赖前后文、不依赖"下一次调用"。resume marker（resumed_at）也自成一块 `<2d>"<step>":` + `<2d+2>resumed_at:`——**resume 时就知道自己续的是哪个 step（state.json 里 running 的那个），块头即用它**。
2. **同一 step 的多个事件（start / meta / done / resumed）各自成块，块头重复 step-id 是合法的**（YAMLL 不要求全文 key 唯一——每块独立解析）。不再需要"把 done 续写进 start 的 mapping"这种跨调用拼接。
3. **块内 YAML 必须合法**（供人读、供折叠、供单块解析）；**块间不要求合法**（全文不是一棵树）。想机器读时按块切分（每个 `<2d>"id":` 块头起一块）再逐块 parse。
4. **折叠**：编辑器按缩进折叠，块头 `2d` 缩进天然给出 step 层级视图（4.3 的块比 4 的块深一级）。这是本格式的**首要目的**——方便作者阅读，而非全文可解析。

**三处与旧示例的偏差（有意）**：
1. **省 `children:` 包裹键**——纯缩进已无歧义表达层级；流式 append + 无内存镜像下 `children:` 键的收尾回退无法维护。
2. **key 用完整 step-id**（`4.3.1` 非相对 `1`）——step-id 是铁钉，完整 id + 缩进双重锁定父子关系，resume 重建/guardOrphan/engine 调用全用完整 id、无需反算父链。
3. **loop 多轮用 `<id>#<iter>` key，非 `iterations: - seq:` 数组**——见下。

#### loop：多轮迭代用 `#iter` 后缀区分

同一 loop 多轮迭代的子步 step-id 重复（`4.1` 每轮同名），嵌套后成同层重复 key（YAML 非法）。**解**：hoplog 维护 `iterCounts: Map<stepId, number>`（展示态计数，与 `startedSteps` Set 同性质，**不碰 step-id 铁钉、不违反无内存镜像**）——检测"已**终态**（done/failed）的 step 又 start"= 新轮次（2026-08-10 语义修准：loop 迭代与 **retry 失败重跑**是同一"新轮"概念——原文只写 done，failed 重跑轮同样是新轮）、计数 +1，hoplog **key** 写 `4.1#2`（`#iter` 仅是 hoplog 展示 key，depth 仍按 stepId 点号算、不受 `#` 影响）。**新轮判定的同时必须清 `startedSteps`**——否则新轮 start 落 resume 去重分支被吞成 resumed 标记、start 块不写（cc:repair e2e 实撞：失败重跑三轮全记同名键）。跨进程 resume 从文件已有 `#N` 重建计数（每 stepId 取最大 N）。

```yaml
  "4":
    type: loop
    summary: 评审轮次
    at: "2026-05-30 00:36:00+08:00"
    max_iterations: 3
    "4.1#1":                          # 第 1 轮子步（depth=2，key 4 空格）
      type: check
      status: completed
    "4.1#2":                          # 第 2 轮同一子步，#iter 区分、无重复 key
      type: check
      status: completed
    status: completed                 # loop done，容器缩进 2d+2=4
```

（loop `iterations: - seq:` 数组形态不实现——`#iter` key 更简、且流式可维护。）

#### branch：记录选中的 case（纯缩进嵌套）

```yaml
  "5":
    type: branch
    summary: 根据评审模式分支
    at: "2026-05-30 00:40:00+08:00"
    taken: "5.2"                      # 选中的 case step_id（meta 字段）
    "5.2":                            # 选中的 case，depth=2、key 4 空格缩进（纯缩进，无 children: 键）
      type: case
      condition: "confirmed_mode == manual_confirm"
      "5.2.1":                        # depth=3、key 6 空格
        type: reason
        status: completed
      status: completed               # case done，缩进 6（2d+2, d=2）
    status: completed                 # branch done，缩进 4（d=1）
```
（未选中的 case 走 skipped、不记 start，缺席于树。）

#### parallel：父记 fanout/dispatch/join 事件块，child 详情归子 hoplog

YAMLL 下 parallel 步骤（如 `4.3`）名下有多个**独立块**，块头都是 `"4.3":`（块间重复合法），按流式时序 append：fanout 块 → 若干 dispatch 块（随 worker 陆续派发，`dispatched_at` 各异）→ join 块 → parallel done 块。child 的 start/done 不在父、在各自子 hoplog。

```yaml
  "4.3":                              # ① fanout 块（父 run 展开时，一次）
    fanout:
      max_concurrent: 5               # 窗口容量先行（比 children 列表更该先看到）
      children: ["4.3.1", "4.3.2", "4.3.3"]
      started_at: "2026-07-09 12:17:18+08:00"   # 开始持续派发的锚点
  "4.3":                              # ② dispatch 块（每派发一个 child 一条，时刻各异）
    dispatch:
      child: "4.3.1"
      dispatched_at: "2026-07-09 12:17:18+08:00"   # 引擎决定派发的时刻
      log: ".hoplog/.../parallel/4.3.1/log"        # 该 child 子日志目录
  "4.3":
    dispatch:
      child: "4.3.6"                  # 补位派发——晚于初始批，dispatched_at 更晚（体现持续过程）
      dispatched_at: "2026-07-09 12:22:33+08:00"
      log: ".hoplog/.../parallel/4.3.6/log"
  "4.3":                              # ③ join 块（join_parallel 单进程，一次）
    join:
      children:
        "4.3.1": {status: completed, log: ".hoplog/.../parallel/4.3.1/log/.../main.yaml"}
        "4.3.6": {status: completed, log: ".hoplog/.../parallel/4.3.6/log/.../main.yaml"}
      started_at: "2026-07-09 12:25:44+08:00"   # 进入 join
      ended_at: "2026-07-09 12:25:45+08:00"     # merge 完
  "4.3":                              # ④ parallel 容器 done 块
    status: completed
    completed_at: "2026-07-09 12:25:45+08:00"
```
（缩进按 `stepDepth("4.3")=2` → 块头 `2d=4` 空格、body `2d+2=6` 空格；上示为简化示意。）

#### subtask retry：记录重试

日志中 `retry:` 展开为对象 `{max, attempt}`，其中 `max` 对应 SpecAST 的 `SubtaskStep.retry`（标量），`attempt` 是运行时产生的当前尝试序号。

```yaml
  "3":
    type: subtask
    summary: 设计审查员角色
    at: "2026-05-30 00:34:30+08:00"
    children: ...
    retry: {max: 2, attempt: 1}      # 首次成功
    status: completed
```

失败重试时：

```yaml
  "3":
    type: subtask
    summary: 设计审查员角色
    at: "2026-05-30 00:34:30+08:00"
    attempts:
      - seq: 1
        at: "2026-05-30 00:34:30+08:00"
        children: ...
        warn: "LLM returned incomplete role design"
        status: failed
      - seq: 2
        at: "2026-05-30 00:35:10+08:00"
        children: ...
        status: completed
    retry: {max: 2, attempt: 2}      # 第二次才成功
    status: completed
```

---

## 卫星文件结构【说明：v1 未实现】

自包含，可独立分析，同时可关联回主文件：

```yaml
# ===== 关联信息 =====
parent_run: "review-20260530T003215-a1b2"  # run 目录名
parent_step: "4.1"                   # parallel 步骤的 step_id
trace_id: "305a0ec4-b479-4d16-bdc5-93c818bb708c"  # 继承自顶层 run 的 instance_id（UUID）

# ===== 本分支执行 =====
step_id: "4.1.1"
type: call
callee_spec_id: reviewer_agent
summary: 发射逻辑一致性审查员
at: "2026-05-30 00:36:02+08:00"

inputs:
  document: {from: run.inputs.document}

llm:
  model: claude-opus-4-6
  system: |
    你是一个专家评审团中的逻辑一致性审查员。
    审查立场：偏向怀疑。
    ...
  prompt: |
    请对以下文档进行逻辑一致性审查：
    ...
  response: |
    # 逻辑一致性审查报告
    ...
  tokens_in: 8234
  tokens_out: 1567

outputs:
  report: |
    # 逻辑一致性审查报告
    **总体评估：** 方案存在 2 处逻辑跳跃...

callee_spec_id: reviewer_agent          # 审计性字段：call 步骤的被调方
status: completed
```

---

## HITL 记录规范【契约】 ^anc-obs-hitl-record

confirm 与 ask 步骤产生 HITL 记录（`hitl:` 是审计性字段，任何级别都写入；2026-08-09 扩 ask——ask 同是人的介入点，人给的数据值与 confirm 的批复同为审计对象。实撞：coffee-week 首步 ask 确认目标，e2e hitl 深核断言红——引擎只记 confirm，ask 决策不入轨=介入审计有洞）。**shown 字段定义（2026-08-26 随 #34 受众分流对齐——二审抓"权威锚零改动,对齐句只落在别的模块文档"）**：shown=展示给人的**问题面**，与 paused 载荷 question 同源（=步骤 summary）。instruction 是驱动侧作业指引不进人眼，审计再记它="还原人当时看到了什么"失真（观测记录点必须在事实边界）；结构化选项归 response_options 字段；完整呈现载荷的审计痕=paused 问题卡整卡（writePausedCard 落全载荷）。对齐 [[step-dispatcher#^anc-exec-hitl-presentation]] 受众分流条款。

**response 取值规则（记应答原文——审计块必须能还原"谁答了什么"）**：

- 应答规范化后**恰一个输出值且为原始类型**（string/number/bool）→ 直接记该值；
- 其余一律记 **JSON 原文**（`JSON.stringify` 整个 outputs）——含三种形态：值为 undefined（原实现 `String(undefined)` 记成字面 `'undefined'`）、值为数组/对象（`String()` 出 `'[object Object]'`）、多键应答。两撞皆真机实抓（hopissues/0031：`response: undefined` 与 `[object Object]×3`）——**审计块记不出原文等于没记**，字符串化捷径在非原始类型上全是谎报。

```yaml
hitl:
  shown: 确认方案完整性缺口处置        # 展示给人的问题面——=summary,与 paused 载荷 question 同源
                                      # （#34 受众分流 2026-08-26 对齐:instruction 不进人眼,审计再记
                                      # 它="还原人当时看到了什么"失真;选项归 response_options,
                                      # 完整呈现载荷的审计痕=paused 问题卡整卡。对齐
                                      # step-dispatcher ^anc-exec-hitl-presentation 受众分流条款）
  response_options:                   # 结构化选项（如有）
    - value: gap
      label: 确认真缺口
    - value: supplement
      label: 需补充文档
    - value: dismiss
      label: 驳回
  response: gap                      # 人的选择（取值规则见上方"response 取值规则"）
  responder: human                   # human | caller
  at: "2026-05-30 00:42:15+08:00"
```

---

## 审计性字段规范【决策+契约】 ^anc-obs-audit

**审计不是独立事件流，而是步骤行为的属性**——一次工具调用必然发生在某个 act 步骤里，一次人工决策必然属于某个 confirm 步骤。审计信息记录为对应步骤的字段，不设独立的 audits 数组/文件。

**始终记录规则**：审计性字段无视日志级别，任何级别下都写入。级别裁剪范围：warn 不记录 inputs/outputs 值和流控字段；debug/info 记录真实值（sanitize 敏感 pattern）；LLM prompt/response 仅 debug 记录。

### 审计性字段清单（按步骤类型）

审计范畴 = **不可逆/敏感操作的追责记录**。只读操作（知识检索）不属于审计，归流控轨迹字段。

| 步骤类型 | 审计性字段 | 内容 |
| ------- | --------- | ---- |
| act | `tool: [{name, result, at, server?, duration_ms?, discarded_text_blocks?}]` | 每次工具调用的名称、成败、时间；外部工具（mcp 绑定）另记 server 逻辑名与耗时——外部调用出引擎进程,归属与延迟是审计必需（2026-08-12 hopkb 五点需求⑤兑现）；discarded_text_blocks=多 text 块取首块的丢弃计数（0006 留痕——审计读出"server 发了 N+1 块引擎取了首块",declared-or-flagged） |
| commit | `commit_audit: {target, authorized_by, result, at}` | 不可逆操作的目标、授权来源、结果 |
| confirm | `hitl: {response, responder, at}` | 决策内容、决策者（human / caller——引擎绝不替 caller 决策，无超时默认值） |
| call | `callee_spec_id` | 被调 Spec 的 ID（子 run 经 trace_id 继承关联，见命名规则） |
| subtask（replan 时） | `replan_audit: {spec_id, step_id, error_reason, generated_children, base, at}` | adaptive 降级阶梯第 3/4 档运行时生成的提报记录——供离线沉淀为预声明备用链路 |

非审计的流控轨迹字段（info 级）：`knowledge: [{source_id, at}]`（只读知识检索）、`retry` / `taken` / `condition` / `llm`。

审计审查方式：`grep` main.yaml 中的审计性字段即可提取完整审计链（如 `grep -A3 'commit_audit:'`）——无需独立审计文件。

**错误凭证类字段不入流控通道**（P2 review 对齐裁定 2026-08-25——作者抓归类悖论："warn 不应该比 info 更敏感么？为什么 info 都记的信息 warn 里没落"）：级别是阈值语义（设置级=只记严重度≥此级），流控字段（taken/condition/tokens_used 等**轨迹类**）严重度=info、warn 级被裁剪是正确行为；但**失败凭证**（如 replan 的 `submit_rejected` 拒因数组）严重度本就 ≥ warn——"只想看出了什么事"的 warn 级用户恰恰最该看到它，挂流控通道=归类错误。归类判据：**记录的是"出了什么事/谁拍的板"→ 审计通道恒写；记录的是"过程走到哪"→ 流控通道 info 级**。实现上 hoplog 字段分级仅两档（AUDIT 恒写/FLOW info 级），错误凭证挂 AUDIT——三档设置下均落盘，机械效果等价"warn 级字段"，不为单字段新造第三档。`submit_rejected` 从 replan_pipeline 流控块拆出为独立审计字段。

**replan_audit 审计事件** ^anc-obs-replan-audit：adaptive 的运行时生成（降级阶梯第 3/4 档，[[../concepts/HopSpec V3核心规范#^anc-exec-retry-adaptive]]）属"运行时 LLM 生成、可信度低、必须沉淀"的操作——记为审计事件（始终记录，无视日志级别）。绑定四元组 `(spec_id, step_id, error_reason, generated_children)` + `base`（scratch=从零第4档 / fallback=基于备用链路第3档）。运维离线 `grep 'replan_audit:'` 提取介入记录 → 审核 → 晋升为预声明备用链路（渐进固化"动态→候选→沉淀"，对接 [[../concepts/HopSpec V3扩展-有序思考与渐进固化]] L87）。结构 `ReplanAudit` 见 [[hop-cli#anc-obs-replan-audit]]。

---

## info 级别的精简形态【说明：示例】

运行级别为 `info` 时，同一个步骤的记录精简为骨架：

```yaml
  "1":
    type: reason
    summary: 分析文档特征与脆弱点
    at: "2026-05-30 00:32:15+08:00"
    inputs:
      document:
    outputs:
      doc_analysis:
    # llm: 块不记录
    status: completed
```

对比 debug 级别：

```yaml
  "1":
    type: reason
    summary: 分析文档特征与脆弱点
    status: completed
    at: "2026-05-30 00:32:15+08:00"
    inputs:
      document: {from: run.inputs.document}
    llm:
      model: claude-opus-4-6
      prompt: |
        ...
      response: |
        ...
      tokens_in: 3456
      tokens_out: 892
    outputs:
      doc_analysis: |
        文档类型：技术架构方案...
```

---

## 时间戳规则【契约】 ^anc-obs-timestamp

- 格式：`YYYY-MM-DD HH:MM:SS.mmm+HH:MM`（本地时区，ISO 8601 兼容，毫秒段 `.mmm` 三位零填充）
- 精度：**毫秒级**（2026-07-09 从秒级升级）。理由：秒级下亚秒事件不可分辨——同批 fan-out 的多条 `dispatched_at` 落同一秒、`join` 的 `started_at`/`ended_at` 在单进程内间隔不足 1s 显示相同（见 ^anc-obs-parallel-dispatch）。毫秒段让同批派发顺序、join 起止微小间隔均可见。跨秒的持续过程（如补位派发晚数分钟）秒级本就可见，毫秒是补足亚秒分辨率、不改变跨秒可读性。
- 字段名：`at:`（步骤**开始**时间戳）、`started_at:` / `ended_at:`（run 级 + parallel fanout/join）、`dispatched_at:`（parallel dispatch，见 ^anc-obs-parallel-dispatch）、`completed_at:`（步骤完成）

---

## 与 HopSpec 概念的对应关系【契约】 ^anc-obs-step-mapping

| HopSpec 步骤 | 日志特有字段 | 说明 |
|-------------|-----------|------|
| reason | `llm:` | LLM 推理的完整交互 |
| act | `tool:` (如有 ToolProvider) | 工具调用参数和返回 |
| check | `llm:` / `result:` | 验证过程和通过/失败判定 |
| confirm | `hitl:` | 人工交互的完整记录（审计性字段） |
| commit | `commit_audit:` + `llm:` | 不可逆操作的审计记录（审计性字段） |
| call | `callee_spec_id:` + `satellite:` 或内联 | 被调用 spec 的执行记录 |
| subtask | `retry:` + `attempts:` (如有重试) | 重试历史 |
| 重试容器内带反馈重跑的步骤 | `retry_feedback:` | L2c 注入的上次失败说明（attempt + reason，info 级流控字段） |
| loop | `iterations:` | 每次迭代的独立记录 |
| branch | `taken:` | 选中的 case |
| case | `condition:` | 分支条件（仅在选中时展开记录） |
| parallel | `satellites:` | 并发分支的卫星文件引用 |
| break/continue/exit | (无特有字段) | 仅记录 type + at |

---

## 实现约束【契约】

**单一信息源**：步骤行为（含审计性字段）全部记录在 `execution:` 区的步骤条目内。不设独立的 events 数组、audits 数组或 execution_log 模块——步骤级事件（start/done/failed 时间戳）就是步骤字段（`at`/`completed_at`/`failed_at`），跨步骤流控（retry/replan/loop 迭代）记录为对应容器步骤的字段（`retry:`/`iterations:`）。冗余即漂移之源 ^anc-obs-execution-log-absorption

1. **实时流式写入**：每个 record* 方法直接 `appendFileSync` 写入 main.yaml。不缓冲、不批量——发生即持久化，中途崩溃不丢已有记录。**多行值的块标量续行缩进必须与字段行同档**——toYaml 的 indent 参数按字段行深度传（字段行缩 2d+2 格即传 d+1 档），漏传=续行比字段行浅、块标量提前终止整文非法（2026-08-31 作者对 hoplog 现场实抓：recordStepFailed 的 reason 未传 indent，check note 首次写出多行失败原因即炸 yaml.safe_load；同方法 summary/fail_kind 同病未炸是值恰无换行） ^anc-obs-hoplog-flush
2. **文件结构 = 合法 YAML（嵌套树）**：run 开始写元数据头 → `execution:` 标记 → 每步字段按 step-id 深度缩进追加（见 [[#^anc-obs-nested-tree]]：key `2d`、body `2d+2`、子块值 `2d+4`）→ close 追加顶层 `status`/`ended_at`。**任何时刻文件都是合法 YAML**——叶子 step 的字段在其完成前连续写完；容器 step 的子步嵌在更深缩进、容器 done 以自身缩进续写在子树之后（流式 append 先进后出 = YAML 嵌套闭合），无 section 交错、无重复 key

   **多行字符串的块标量安全条件（2026-08-25 修 #41）**：`toYaml` 对多行字符串缺省用 `|` 块标量（可读性首选），但**首个内容行自带前导空白的字符串必须回退 JSON 双引号单行**（`\n` 转义）。原因：无缩进指示符的块标量由首个非空行定缩进基线——值首行若带 4 空格缩进（如 LLM response 里嵌的 spec 片段文本），基线被抬高到"发出前缀+4"，后续缩进较浅的行提前终止块标量、被误读成错层 mapping key，整份 main.yaml 非法（dr16-6 r7 实锤两例：child_fragment 值以缩进步骤文本开头,`tier:` 行炸档）。不用 `|n` 显式指示符：n 上限 9、且语义是相对父节点列位的偏移,toYaml 不掌握调用方拼接的列位,深嵌套下不可静态定值。回退判据三形态（review 二修补齐——YAML 8.1.1.1 对 leading empty lines 另有独立约束）:①首个非空行以空白开头;②首个非空行之前存在**非零长度的纯空白行**（发出后比基线深同样炸档;真空行 '' 发出后恰等于基线合法不回退）;③全空白多行串。后续行缩进只深不浅是合法的,不触发回退——正常多行文本仍走块标量,可读性不受损
3. **级别裁剪只作用于非审计字段**：审计性字段（tool/commit_audit/hitl/callee_spec_id）无视级别始终写入
4. **跨进程 resume**：Engine.resume() 从 state.json 的 `hoplog_run_dir` 恢复 HopLog 实例。resume 不加载历史记录到内存。**resume marker 采用「延迟结构化写入」**——见下 ^anc-obs-hoplog-resume

   **resume 恢复的是「上一步的完成阶段」——resumed_at 是那个 step 的收尾字段，非游离事件**。理清 resume 究竟恢复到哪个点：跨进程 reason/act 步时，进程 A `recordStepStart` 写完骨架 + `llm.prompt`（debug 级）后返回 step_ready、进程退出（step 处于 running）；进程 B `resume()` 后 `completeStep` → `recordStepDone` 补 `llm.response` + `outputs/status`。**resume 点精确落在「同一个 step 的 start 与 done 之间」——resume 恢复的就是这一步的完成**。故 resume marker 语义上从属于**正在完成的那个 step**，标记「此步跨进程完成」，应作它的**收尾字段**（与 `status`/`completed_at` 并列），而非硬插进 step 内部的独立事件。

   旧实现的 bug：`resume()` 无条件 append `  # resumed at ...`（2 空格裸注释），跨进程续 reason/act 步时砸进**未闭合的 `prompt: |` 块标量中间**（prompt 已写、response 未写），提前终止 8 空格块标量且缩进错层，破坏 YAML，违反上条「任何时刻文件都是合法 YAML」。实测一份 run 10 marker 8 命中。深层原因：把 marker 当成游离于 step 之外、要找缝硬插的独立事件，而非从属于当前 step 的字段。

   修法（延迟结构化写入，落在 step 收尾）：
   - `resume()` **不立即 append**，只把时间戳存入实例字段 `pendingResume`（`string | null`）。
   - 私有 `flushResume(topLevel)`：若 `pendingResume` 非空则 append `resumed_at: <t>`（`topLevel=true` 顶层 0 空格 / `false` step 子字段 4 空格）后清空。
   - **续同一步的 `recordStepDone`/`recordStepFailed`**：在写完 `response`（llm 块闭合）+ `outputs`/`status`/`completed_at` **之后**调 `flushResume(false, stepId)`——`resumed_at` 作 step 收尾字段（缩进 `2d+2`，随 step 深度、与 status 并列；嵌套树见 [[#^anc-obs-nested-tree]]），**在 llm 块彻底闭合后**，绝不切断 `llm:` 的 prompt→response 连续性。
   - **step 中途字段 `recordStepMeta`/`recordWarn` 不 flush**——marker 归 done/failed 收尾承载（中途字段不背 resume 语义）。
   - **顶层事件 `recordStepStart`（新 step）/`recordParallelFanout`/`recordParallelJoin`/`recordReplanAudit`/`close`**：在 append 自身内容前调 `flushResume(true)`——resume 后若开新 step 或直接终态，marker 落顶层（进程切换发生在 step 之间）。`close` 也 flush 保证 resume→续完末步→close 不丢 marker。
   - 效果：marker **永不落进块标量/llm 块中间**、**永不丢失**、语义精确（标记所属 step 跨进程完成或进程在 step 间切换）。从「注释」升级为「可被 YAML 解析器读取的结构化字段」`resumed_at`。
5. **L3 上下文数据源**：PromptAssembler 构建 L3 执行链上下文用 **Engine 的执行事件流**（`execEvents`——执行历史原料，持久化到 state.json 的 `exec_events`，跨进程续上 loop 迭代时序，见 [[exec-engine]]「执行历史进 state.json」）+ stepStates + 变量存储。HopLog 不提供事件查询接口（无内存镜像，唯一信息源是 main.yaml 文件）——HopLog 为人复盘（按步组织）、execEvents 为引擎重组 prompt（扁平时序），职责分离、不互为数据源
6. 日志写入使用 `appendFileSync`（同步），小量文本延迟 <1ms，不阻塞执行
7. `.hoplog/` 目录应加入 `.gitignore`
8. 卫星文件在并发分支启动时创建
9. run 失败或取消时，主文件已有记录天然保留（流式写入），close 标记 failed/cancelled
10. YAML 使用 block style（`|`）记录多行字符串

---

## HopLog 观测记录简化（已登记债）【说明】

见 [[todo/0003_DEBT-09-HopLog-llm-response未记录_open|DEBT-09]]。HopLog 已实现核心日志框架（三级日志、审计性字段、流式 YAML 输出、脱敏），但以下设计特性做了简化：

| 设计特性 | v1 实现 | 说明 |
|---------|--------|------|
| ~~嵌套执行树~~ | **v2 已实现**：纯缩进嵌套（缩进=step-id 深度）+ loop `#iter` key，见 [[#^anc-obs-nested-tree]] | ~~v1 扁平平铺~~ 已修（省 children 键、完整 id、不用 iterations 数组） |
| `llm:` 块的 system/prompt/response | 仅 model/tokens | LLM 完整交互记录待 v2 |
| 卫星文件（parallel/call 并发分支） | 未实现 | 全部记录在主文件 |
| `knowledge:` 流控字段（reason 知识访问） | 未实现 | KnowledgeProvider 访问记录待补 |
