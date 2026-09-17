%% @trace
	id: hopjit-exec-engine
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-09T09:11+0800
	note: ExecutionEngine 设计规范——执行状态机。内容分级（决策/契约/说明）+ 关键设计决策 + 契约锚点 + impl 逻辑
%%

# ExecutionEngine 设计规范

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、格式演示、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（四要素） | 契约 | `anc-struct-exec-engine` |
| 关键设计决策 | 决策 | — |
| 变量作用域 | 契约 | `anc-exec-variable-store` |
| 失败语义（函数级 fail） | 契约 | `anc-exec-none-propagation` |
| 分层重试与自适应 | 契约 | `anc-exec-retry-adaptive` / `anc-exec-commit-anneal` |
| 动态 spec 准入门 | 决策+契约 | `anc-exec-dynamic-spec-gate` |
| subtask free 到步展开 | 决策+契约 | `anc-exec-subtask-free-expand` |
| 主动 replan | 决策+契约 | `anc-exec-replan-proactive` |
| 任务卡镜像写回 | 决策+契约 | `anc-exec-specfile-writeback` |
| check 升层分派 | 决策+契约 | `anc-exec-check-escalate` |
| 完整性约束 | 契约 | `anc-exec-completeness` |
| 容器聚合 | 契约 | `anc-exec-container-output` |
| DFS 遍历 | 契约 | `anc-exec-dfs-traversal` |
| 完成级联 | 契约 | `anc-exec-completion-cascade` |
| act body 执行模型 | 契约 | `anc-exec-act-body-interp` |
| 输出 schema 校验 | 契约 | `anc-exec-output-schema-check` |
| check 判定 | 契约 | `anc-exec-check-verdict` |
| 完成并推进到 caller 介入点 | 契约 | `anc-exec-advance-to-caller` |
| tool_request 介入点与确定性重放 | 契约 | `anc-exec-tool-request` |
| 推进面执行序不变式 | 契约 | `anc-exec-advance-order-invariant` |
| 动态失败兜底（无兜底失败介入点化,设计稿待拍） | 契约 | `anc-exec-dynamic-onfail` |
| impl next_step / complete_step / select_branch / fail_step | 说明 | — |
| Parallel 真并行 | 契约 | `anc-exec-parallel-batch` / `anc-exec-parallel-subinstance` / `anc-exec-parallel-join-merge` / `anc-exec-parallel-canfanout` / `anc-exec-parallel-one-layer` / `anc-exec-parallel-child-params` / `anc-exec-parallel-worker-prompt` |
| 执行策略（Call/Adaptive/熔断） | 说明（决策点已上提） | — |
| Tools 段 init 对账 | 契约 | `anc-exec-tools-reconcile` |
| 实例主动中止 | 决策+契约 | `anc-exec-abort` |
| 崩溃恢复 / 状态持久化 | 契约 | `anc-exec-crash-recovery` / `anc-exec-state-persistence` / `anc-exec-driver-channel`（双执行硬闸） |
| 暂停态持久化与恢复 | 契约 | `anc-exec-pause-persist` |

## 定位【契约】 ^anc-struct-exec-engine

> **模块版本**：exec-engine `v0.40.2-draft`（2026-09-09）。本版=review 修复批（版本行假账修正+首层收尾如实化+恒不删例外注+0074 章 RESET 通道歧义句统一）。上版（v0.40.1-draft）=0073 重试反馈受众收窄条款+动态失败兜底设计稿章(^anc-exec-dynamic-onfail,hopissues/0074——**设计稿待作者拍定,零实现**:无兜底失败停成介入点向 caller 要兜底计划,四种应答/独立模式延迟恢复窄门/审计封顶/恒不动四账;实现批另开)。上版（v0.39.1,2026-09-08）=todo/0080 break/continue 出圈收尾补执行路径容器终态化（控制流状态转换条款两处扩——嵌套命中 case 残留 running 致后继 commit 被执行序不变量误拦,hopbuild2 probe 实撞;exit 无此病〔全树一律 skipped 且无后继〕）。上版（v0.39.0,2026-09-07）=retry/collect 语义线四批（0072 空响应误杀双点修/retry 三板〔=初值重灌新锚 ^anc-exec-output-init-reentry+replan 清账+空响应全口径〕/collect 进入即清收敛〔清空点归 loop 入口,来路补丁删除〕/两批 review 修复〔replan 清场不筛 default+scope 缺席句改收窄+守卫罩两笔〕）;上版（v0.38.1,2026-09-06）=review 三笔账面修（条款①字面参数化视角归位/HopType 补 loadProjectToolRegistry 签名与空文档分叉/接口三件改四件）;上版（v0.38.0）=三组批次 review 修复批（^anc-exec-advance-order-invariant HopSop 补两实质分叉〔祖先容器豁免/commit 不在树上〕+独立模式点名 ADVANCE_ORDER_VIOLATION 码字面并登记 shared-errors 表+makeReplayToolProvider HopType 补 allowCommit 字段与第二道闸条款+tool_journal 类型注记改两形态归一）;前版 v0.37.0=0076 批（注册件入直执面,分派判据条款扩注册件装配四条款）;前版 v0.36.0 引擎两笔（0075 批）：①tool_journal 语义修正——journal 元素两形态并存（caller 交 ToolResult 信封/引擎直执裸值）,重放侧按形态归一剥壳,body 恒拿裸结果值（^anc-exec-tool-request 剥壳条款——实撞:caller 按契约类型注记交信封被再包一层,parse_json 炸"期望 JSON 文本,实际: object"）;②新契约节"推进面执行序不变式"（^anc-exec-advance-order-invariant——dfs running 容器两种 none 区分〔0049 同层挡板的嵌套半边〕+commit 执行入口动态核两模式两入口;探针 stp2b/stp2c 实证裸 advance 也乱序,病在推进面 replan 只是入口）。上版（v0.35.0）直执批 review 修复十一项（requires_commit 第二道闸+设计如实化+HopType/HopSop 补全——2026-09-06 review 抓收编解算时本槽曾被误挂 v0.34.x 的 line 空串内容,直执批沿革蒸发,勘正归位）。再前（v0.34.x） line 空串恒拦迁约束标注（^anc-exec-line-single 改判,B 案——判据迁 checkValue,completeStep 特判删）。上版 commit 退火判据重构为重跑范围判（作者裁定架构迷糊——记账带祖先 loop 轮次快照永续不清,判定按边界祖先 loop 轮次比对;同治 0061 焊死与 CA-1 外层重放,撤 v0.33.0 清除案）。上版新增 line 空串拦截（^anc-exec-line-single 追条款,todo/0043——无 body 步 line 型空串/全空白 SCHEMA_MISMATCH 打回,body 步豁免〔显式空串是作者意图〕）。上版新增顶层 run 必填 Inputs 闸（^anc-exec-init-required-inputs,call 子实例闸孪生半边——deep-validate 批,九坑之坑 3）。上版三处:auto-map 悬空 from warn 落账/子 init 必填闸账实差实装（窄化 call 子实例链）/parallel 汇聚全灭 warn。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
**① 自身定位**：ExecutionEngine 是 HopJIT 的执行状态机——驱动 HopSpec 规约从初始化到终态的核心。管理四件事：
+ 步骤状态机（pending→running→done/failed/skipped）
+ 扁平变量命名空间（实例边界隔离）
+ retry/adaptive 重试配额
+ 失败升级（函数级 fail）

它是环境无关的纯逻辑组件——不碰 LLM API、不碰网络、不碰具体工具实现，只决定"下一步执行什么、状态如何流转、失败如何处理"。

**② 与其他 HopType 的关系**：
- **SpecParser 的下游**：消费 `SpecParser.parse_spec` 产出的 SpecAST 作为执行蓝图
- **StepDispatcher 的上游**：Dispatcher 通过进程内 API（`next_step`/`complete_step`/`fail_step`）驱动 Engine，Engine 不主动调用 Dispatcher——它只返回"下一步是什么"，由 Dispatcher 决定怎么执行
- **PromptAssembler 的调用方**：`next_step` 返回 StepReady 前调用 PromptAssembler 组装 6 层 context
- **HopLog 的持有方**：每次状态变更调 HopLog 的 record* 方法写执行轨迹（见 [[spec-observability]]）
- **不碰 Provider 抽象**：Engine 属于引擎内核中不触外部系统的部分，ToolProvider/KnowledgeProvider 由 Dispatcher 持有

**②b 对外接口清单【封闭】** ^anc-struct-exec-engine-exports：

> 本表是 exec-engine **对外依赖面的封闭集**——表内符号是允许被其它模块跨模块 import 的公开接口，**表外一切符号即内部实现**。外部 import 表外符号、或从非出口文件深入 import，均为边界违规（机检拦截，见 [[anchor-audit-knowledge#模块边界接口校验]]）。
>
> **出口文件集**：exec-engine 是多文件模块，出口 = `engine.ts` / `runtime-types.ts` 两者。`runtime-types.ts` 是引擎的**公开运行时类型面**（响应/快照/事件的类型契约，被 cli/persistence 消费），类比 spec-ast 的 ast-types。`engine-traverse.ts` 现为**纯引擎私有遍历**（dfs/collectParallelBatch 等仅 engine.ts 同模块调用），对外零符号、非出口文件。清单列每个符号从哪个出口导出。
>
> **迁移注（2026-07-02）**：原在此清单的 `VariableStore`/`VariableScope`/`StepStatus`/`getWriteScope`/`isTruthy` 已归位 spec-ast（`ast-runtime.ts`）——它们被 prompt/act-body 多方调用、只依赖 spec-ast,是语言运行时基础能力而非引擎私有。`engine-vars.ts` 已删除。详见 spec-ast 模块定位节的对外接口清单。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `ExecutionEngine` | 类 | engine.ts | 执行状态机主入口（dispatcher/cli 驱动） | stable |
| `EngineOptions` | 类型 | engine.ts | 引擎构造选项（cli 建实例/子实例需要）;字段含 upstreamFeedback?: string——父层修正意见注入口（D41 call 边界:standalone 进程内传/复用模式经 init --upstream-feedback 选项转入,两模式汇同一口）;**specPath?: string**——spec 文件绝对路径（doc-ref 首级解析目录与 call_protocol 拼装的路径身份,run/init 两入口都传——hopissues/0076 实撞 init 漏传两消费点连带失效）;**cliAbsPath?: string**——CLI 自身绝对路径（call_protocol init_command 拼装用,与 specPath 任一缺席 buildCallProtocol 返 undefined） | provisional |
| `ExecEvent` | 类型 | runtime-types.ts | 执行事件流元素（prompt 重建 L3、persistence 落盘） | provisional |
| `FailKind` | 类型 | runtime-types.ts | 失败类别（lack_of_info/error/deterministic/tool_failure——第三值 2026-08-23 增 ^anc-exec-deterministic-no-retry;第四值 2026-09-01 增 [[step-dispatcher#^anc-exec-tool-failure-report]]——reason+无 body act 工具故障自报,容器阶梯走缺省重试路径） | provisional |
| `StepFailRecord` | 类型 | runtime-types.ts | 步骤失败记录 | provisional |
| `RetryRecord` | 类型 | runtime-types.ts | 重试记录（cli 响应、adaptive replan 消费） | provisional |
| `AssembledContext` | 类型 | runtime-types.ts | 组装后的 6 层 context（cli NextResponse 内嵌） | provisional |
| `StateFile` | 类型 | runtime-types.ts | state.json 结构（persistence 消费） | provisional |
| `VarsFile` | 类型 | runtime-types.ts | vars.json 结构 | provisional |
| `EngineSnapshot` | 类型 | runtime-types.ts | 引擎快照（persistence save/load） | provisional |

> **内部实现（明确不对外，表外即内部）**：`dfsNextStep` / `collectParallelBatch` / `propagateCompletion`（执行遍历，仅 engine 自用）、`evaluateCondition` / `subtreeContainsPausePoint` / `collectDescendants`（遍历辅助）、`TraversalState` / `TraversalResult`（遍历状态类型）、`handleBranchEntry` / `handleBreak` / `handleContinue` / `handleExit` / `ensureScope`（私有 handler）、runtime-types 的内部类型。这些是引擎调度机制，跨模块 import 即违规。
>
> **注**：`getParentStepId`（step_id 纯字符串寻址）曾在 engine-traverse，因其是无状态 AST 寻址（非引擎调度职责），已归位 spec-ast（见 [[spec-ast#^anc-struct-spec-ast]]），不在本模块出口。

**③ 主要 traits 与主要成员**：

Fields（按职责分组）：

**蓝图组**——执行的不变输入：
- `instance_id: string`——执行实例标识（即 HopAnt run_spec trait 的 execution_id）。init 时生成，run 期间不变
- `host_config: HostConfig`——宿主环境配置（定义见 [[shared-types]]）。提供 resource_limits、sandbox 等约束
- `spec: SpecAST`——解析后的规约。执行蓝图，replan 时局部替换 subtask children

**状态组**——run 期间演进的执行状态，全部持久化到 state.json：
- `step_states: Record<string, StepStatus>`——step_id → pending|running|done|failed|skipped 的扁平映射。状态机的核心
- `variables: VariableStore`——实例扁平命名空间的变量存储（见变量命名空间章节）。持久化到 vars.json
- `retry_counters: Record<string, number>`——subtask_id → 剩余重试次数。仅记录有 retry 配置的 subtask
- `loop_counters: Record<string, number>`——loop_id → 当前迭代轮次。crash recovery 时可从 done children 轮次推算
- `replan_counters: Record<string, number>`——subtask_id → 已 replan 次数。熔断用（上限 3）
- `retry_history: Record<string, RetryRecord[]>`——subtask_id → 历次失败记录（失败原因 + steps_tried）。adaptive replan 时作为 AdaptiveNeeded.retry_history 交给规划方，也是 L2c 带反馈重跑的来源。**持久化到 state.json**（#90 起；复用模式跨进程的 L2c 重跑需读到）
- `last_replan_children: Record<string, StepSummary[]>`——subtask_id → 最近一次 replan 提交的新 children 摘要。重复提交检测（REPLAN_DUPLICATE）用。**持久化到 state.json**（可选字段）——重复检测在两模式都跨进程（复用模式每命令独立进程：submit --replan 与下次 replan 是两个进程；独立模式 paused-resume 跨进程），不落盘则检测静默失效
- `step_fail_reasons: Record<string, string>`——step_id → 该步失败原因（人类可读字符串）。`get_failure_reason` 的唯一来源——按 step_id 直读，不再从事件流 find。覆盖**所有**失败步骤（含顶层非 subtask 步骤、MISSING_INPUT、output-never-assigned 等 retry_history 够不到的），与 retry_history（subtask 容器级重试档案）正交：前者 step 级诊断、后者 subtask 那次重试的聚合。**持久化到 state.json**
- `adaptive_needed_subtask: string | null`——当前处于 adaptive_needed 状态的 subtask_id（同一时刻至多一个）。持久化到 state.json（可选字段），resume 后继续等待 replan
- `upstream_feedback: string | null`——父层修正意见（D41 call 边界传入,EngineOptions.upstreamFeedback 注入）。**持久化到 state.json（可选字段）并在 load 恢复**——复用模式 init 与 advance 是两个进程，内存值活不过 init（同 notify_channel 先例"每条 CLI 命令新进程"）；不落盘则 `init --upstream-feedback` 的载荷在 advance 进程里为空，H2 复用半边跨进程断链（2026-09-01 补测试批变异核证实锤：删 cli.ts 透传行全量照绿，深挖出此欠账）

**观测组**——执行轨迹记录与运行时事件：
- `hoplog: HopLog | null`——执行轨迹日志组件（持久化，为人复盘服务）。每次状态变更调 record* 写入；无 logDir 时为 null（不落盘）
- `execEvents: ExecEvent[]`——**执行事件流**（执行历史原料，非日志）。一维带时序的步骤事件序列（step_start/done/failed/retry/branch_select…），供 PromptAssembler 重建 L3 执行链上下文（`iteration_history` 按 step_start 切分 loop 迭代、`subtaskProgress` 列子步状态）。**持久化到 state.json**——它是组装 prompt 必需的执行历史，复用模式每命令独立进程，不落盘则跨进程为空、L3 上下文断裂。与 HopLog 职责分离：HopLog 为人复盘（按步组织、可能很大）、execEvents 为引擎重组 prompt（扁平时序、轻量）；两者在步骤状态变更时各自独立写入，不互为数据源

**工作区组**——每个执行单元的**独占工作区**（work_zone；driver/worker 临时文件的唯一合法存放点）： ^anc-exec-work-zone
- `work_zone: string`——该执行单元独占工作区目录的绝对路径。`initExecution` 时由 `PersistenceProvider.init()` 创建（含 `vars/` 子目录），所有 NextResponse 携带此路径。**命名忠实**：叫"工作区"（不是"草稿 scratch"）——它是执行单元**独占、强制、自包含**的工作领地，临时文件**只**写这里，禁写 /tmp 或自选绝对路径。
- **目录路径编码 child 身份**：顶层实例用 `<instanceDir>/work_zone/`；parallel/call 子实例的实例目录本身按 child 分道（`<父instanceDir>/parallel/<child_step_id>/` 或 `calls/<child_step_id>/`），work_zone 恒为实例目录下的固定名 `work_zone/`——不同 child 的完整路径天然不同，从路径层消除撞车（2026-08-30 语义审计勘误：原文"work_zone_<child_step_id>"后缀命名与 persistence 实际布局〔getWorkZone=<instanceDir>/work_zone 固定名〕不符——真实的身份区分在实例目录层级，不在 work_zone 目录名）
- **work_zone 根注册进写域判定面（0066）**：`getWorkZone()` 把 work_zone 根经 `registerWorkZoneRoot` 注册进 tools 写域判定的第三支（注册根前缀——state-dir 名不含 `.hopstate` 字面时前两支全不中）。**原始形态与 realpath 形态都注册**（src/persistence.ts:172-173）：两个消费点各吃一种形态——`resolvePath` 拿 `work_zone_path()` 原始产物判、`validateFileAccess` 拿 resolveReal 后的判，只注册一种另一点失配（0066 probe 重放实抓：只注册 realpath 时 /tmp 原始形态在 resolvePath 处照拒）；目录未建时 realpath 炸则只注册原始形态。
- **MemoryPersistence 惰性建 work_zone（有意偏差,2026-08-10 作者定）**：MemoryPersistence 的 `init` 不建 work_zone,**首次 `getWorkZone()` 调用时**才在 tmpdir 下 `mkdtempSync` 自建（含 vars/ 子目录同建,src/persistence.ts:235-245）——依据是"body 内 `work_zone_path()` 需要真实目录"。独立模式不向外部 driver 暴露 work_zone（dispatcher 进程内直跑,无 @file 跨进程交换需求）,NextResponse 仍透传空串,由 dispatcher 兜（空串形态的下游边界见 [[doc-ref#^anc-exec-doc-ref-resolve]] deflate 步防御性留置注记）。
- **确切 output_path**：step_ready 除给 `work_zone` 目录外，直接给本步 output 文件的**确切路径** `output_path`（含 child 区分）。worker 照此路径写、`--output "@<output_path>"` 提交，零拼名自由度且兼容含空格路径——消除"parallel 内层 step_id 恒为模板 id、worker 拼名易撞"的出错点。
- **提交越界校验**：`submit_and_fetch_next --output @<path>` 时引擎校验 `<path>` 落在本执行单元 work_zone 内，越界（如 /tmp）→ 拒绝提交并报错。引擎唯一能真拦的点（复用模式 act 由 CC 执行、写入不过引擎，只能提交时校验）。见 [[hop-cli#^anc-cli-parallel-file-isolation]]。
- **大内容阈值传递**（`deflateValues`）：^anc-exec-deflate — 引擎返回 NextResponse 前，对 inputs/params_for_child/outputs/presented_data.context 中的每个值检查 `JSON.stringify(value).length > DEFLATE_THRESHOLD`（4096 字节）。超阈值的值写入 `work_zone/vars/<var_name>.json`，响应中替换为 `{"$file": "<abs_path>"}` 指针。driver 遇到 `$file` 指针时 Read 文件获取真实值。阈值常量 `DEFLATE_THRESHOLD = 4096` 定义在 [[shared-types#^anc-exec-deflate]]

trait（按职责分组）：

**生命周期组**——实例的创建、加载、崩溃恢复：
- `init_execution(specMarkdown, hostConfig, options?)`——解析验证 markdown，创建状态目录，初始化所有状态。前置校验 resource_limits（context+output tokens ≤ 模型窗口）。**已登记债：前置校验未实现**——预算超限由 Dispatcher 运行时 checkBudget 拦截（BUDGET_EXCEEDED），init 不预检，见 [[todo/0001_DEBT-01-init期resource_limits前置校验未实现_open|DEBT-01]]。**Tools 段对账（#49,概念权威 ^anc-tool-two-faces;review 修复批 2026-08-25 改静态法双调用点）** ^anc-exec-tools-reconcile：对账逻辑收进静态公共判定面 `ExecutionEngine.reconcileTools(needs, available)`,**两处调用**——①init 期（hostConfig.tool_provider 在场时,早失败面）;②**dispatcher.runSpec 装配后**（生产主通道:MCP standalone 的外部工具经 tool_registry 装配进 CompositeToolProvider,init 期 hostConfig 里看不见——review D1 实抓"init 对账在生产通道不生效",装配后对最终工具面复核,不过即 failed 不进首步,failure.step_id='(init)'）。四判：①工具名（或 tool_id）在清单内;②spec 声明的参数名集合 ⊆ 注册面参数名集合（子集容忍——spec 可只用部分参数;超集=声明了注册面没有的参数,报错）;③requires_commit 一致性——spec 侧"注明"按**独立注记 token 判**（`(requires_commit)` 或分隔符间独立出现;含"并非/不是/非/not requires_commit"字样的否定语境判未注明——review D4:原子串 includes 会把否定句误判为注明）：注明而注册面 false=声明失实报错;反向=spec 漏注 warn 不拦（安全语义以注册面为权威,调用位拦截照常生效）;④spec 侧参数/输出**类型词汇表核**（HopSpec 原子+`[原子]`,表外报错——review D6:词表此前零校验;归对账不归 parser,parser 只收结构）。任一不过 → INIT_FAILED 带逐条明细。无 Tools 段/无工具面零对账（向后兼容）
- `static load(instanceDir)`——**加载续执行**：从快照重建 step_states/counters/vars + 从 hoplog_run_dir 恢复 HopLog，**保留 running 状态**。**instanceId/stateDir 从 instanceDir 切分时用平台 path API**（`path.basename`/`path.dirname`,不硬编码 `split('/')`）——win32 绝对路径（`E:\...`）里没有 `/`,硬编码切分拿整条路径当裸 id,父实例经 load 恢复后派发 parallel child 时 launch_command 的 `--parallel-parent` 传出整条绝对路径,child 侧 join 出鬼路径 mkdir ENOENT（0058 实撞:Windows 用户 parallel child 启动全灭,手动改裸 id 才通）。复用模式日常推进与查询（next/done/fail/status/vars/branch/replan）的入口——running 是"已交付 caller、正等回写"的合法持久态（概念见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-durable-resume]]）
- `static recover(instanceDir)`——**崩溃恢复**：在 load 基础上，按"崩溃时正在执行的节点重做,落盘的决定不动"极性处置 running 步骤——可执行叶子与未做入口决策的容器重置 pending 重跑,其余容器保留（判据与分支全款见 ^anc-exec-crash-recovery 极性条款——本行 2026-09-04 review 抓旧黑名单口径残留后对齐,改契约须同文件通查同构表述）。仅 `hopjit resume` 命令使用
- **load vs recover 的分界由调用入口决定，非引擎自判**：引擎无法仅凭 running 状态区分"已交付待回写"与"崩溃悬空"，故 CLI 命令显式选择——日常命令调 load，崩溃恢复命令调 recover（见 [[hop-cli]] 命令状态加载契约）
- **实例目录定位由 `splitInstanceDir` 承载**：instanceDir → {id, parent} 的切分统一走该函数（平台无关——用 `path.basename`/`path.dirname`，不硬编码 `split('/')`；0058 沿革：win32 路径硬编码切分致 parallel child 启动全灭），load/recover 及一切从目录反推实例身份的场景共用此单一入口 ^anc-exec-durable-resume

**调度组**——run 主循环的核心，由 Dispatcher 驱动：
- `next_step()`——DFS 遍历步骤树找下一个可执行节点，组装 context 返回 NextResponse（5 种形状之一）。容器步骤自动展开，branch 内部评估条件
- `complete_step(stepId, output)`——记录步骤完成，output_schema 校验，写变量，检查容器级联完成
- `fail_step(stepId, reason, failKind?)`——处理失败：输出设 None，按 retry/adaptive/传播策略决定下一步。`failKind` 默认 `'error'`，`'lack_of_info'` 时 driver 可据此机检分流（知识补充/上传父层）。failKind 记入 HopLog 步骤字段 + state.json 的 `step_fail_reasons`（序列化为 `{reason, fail_kind}`）
- `select_branch(stepId, selectedCase, reason?)`——记录 branch 选择（CLI 手动覆盖用，正常由 next_step 内部评估）
- `submit_replan(subtaskId, newStepsMarkdown)`——adaptive 重规划后验证并替换 children

**访问器组**——无副作用查询：
- `get_status()`——返回执行进度（total/completed/failed/pending）
- `get_vars()`——返回所有变量

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl 主循环（由 Dispatcher 驱动）
1. [act] init_execution：解析验证 → 创建状态 → 所有步骤 pending
2. [loop] 主循环直到终态
  2.1. [act] next_step：DFS 找下一个可执行节点
  2.2. [branch] 按 NextResponse.status 分派
    - step_ready → Dispatcher 执行 → complete_step / fail_step
    - adaptive_needed → Dispatcher replan → submit_replan
    - paused → 暂停等 caller 决策
    - completed / failed → 退出循环
3. [exit] 返回 outputs
```

---

## 关键设计决策【决策】

以下是存在多个合法选项、由人拍板的设计选择。改动需重新权衡，不能从概念层自动推演。

### 决策 1：Dispatcher↔Engine 走进程内 API，而非 CLI 子进程 IPC

**候选**：① 每步通过 `hopjit next/done` 子进程 IPC（进程隔离）；② 进程内直接 TypeScript 函数调用。

**选 ②**。热路径（next→execute→done 循环）作为直接函数调用，零进程边界开销。CLI 命令（`hopjit init/next/done`）退化为 Engine API 的薄封装层，仅用于外部人工交互和调试。

**理由**：进程内 API 消除每步 2 次进程派生 + 4-5 次文件 I/O，对 40 步的典型 Spec 节省约 80 次进程创建和 160 次文件操作。代价是 Dispatcher 和 Engine 必须同进程（不能跨语言/跨机器分布），但 v1 不需要分布式执行。

### 决策 2：变量体系用扁平命名空间（Python 函数级），实例边界隔离

**候选**：① 一次执行一个扁平命名空间（容器是控制流块，同 Python 函数内的 for/if）；② 树状词法作用域（读向上查找、写隔离到最近容器 scope）。

**原选 ②，2026-08-09 作者裁决翻转为 ①**。② 的"防泄漏"收益是幻觉：V2 已禁重名，命名空间本就无冲突可防；而"写隔离到最近容器"制造了 Python 不存在的隐式影子变量（深层写落中间容器、容器外读不到），三份实跑报告全部撞上（hopkb 三连撞/8k primer 自引用崩溃/primer-H 累加器误杀）。① 与"同名=同一变量"（V2）自洽，与 Python 心智模型零偏差。隔离需求由真实边界承担：call 子实例=函数调用、parallel worker=独立进程——它们本来就是独立实例。详见变量命名空间章节。

### 决策 3：每步原子写 state.json，而非批量/定期快照

**候选**：① 每步执行后立即原子写 state.json（crash safe，I/O 多）；② 定期/批量快照（I/O 少，crash 丢数据）。

**选 ①**。每次 complete_step/fail_step 后 write-to-temp-then-rename 原子写入，state.json 是提交点。

**理由**：HopSpec 的 act/commit 步骤可能有副作用，crash 后必须能精确恢复到最后一个完成的步骤，不能丢状态。代价是每步 fsync，但 vars.json 合并为单文件（非每变量一文件）已将 I/O 放大降到每步 2 次写入。详见崩溃恢复章节。

### 决策 4：Parallel 渐进升维——v1 顺序模拟 → v2 复用模式真并行 → v2-1 独立模式真并行 → v3 统一派发模型

**候选**：① v1 直接实现真并行（Agent 工具启动并发子任务）；② v1 顺序模拟，v2+ 升维真并行。

**选 ②，渐进升维**。parallel 标注步骤在语义上满足"与容器内其他步骤无数据依赖"约束（validator S12 强制），此约束保证**顺序模拟与真并行结果等价**——这是渐进升维的正确性基石（同一论证覆盖 v3 的"批量 vs 渐进派发"与"配 1 全串行"）。

**v3（2026-08-10 概念定形；2026-08-11 P0 交付——独立模式 call parallel 通道，详见 parallel-execution §U7）**：概念层升级为**统一派发模型**（[[../concepts/HopSpec V3核心规范#^anc-exec-gather]]）——parallel 翻转为 subtask/call 的 callee 申报，执行=主线到标注步骤异步派发、容器边界收齐；静态 fan-out/循环头 parallel 两旧形态废除归约。设计权威移至 [[parallel-execution#§U 统一模型（现行权威，2026-08-10）]]：在飞记账（`^anc-exec-parallel-inflight`）、收割/收齐（`^anc-exec-parallel-reap-drain`）、主线失败杀活（`^anc-exec-parallel-kill`）、推进条件放宽（`^anc-exec-parallel-advance`，唯一引擎新机制——完成条件不动）。下文 v2 三机制在迁移期内仍是现行代码的运行方式。

**落地状态**：
- **v1（已交付）**：顺序模拟——`dfsNextStep` 按声明顺序依次返回每个 pending child，`hopjit next/submit` 串行驱动。
- **v2（本次，复用模式真并行）**：CC driver 经 fan-out 并发执行各 child 容器。引擎只负责"批量吐就绪 children（[[#^anc-exec-parallel-batch]]）+ join barrier + merge（[[#^anc-exec-parallel-join-merge]]）"，**怎么并发跑由 driver 适配层（CC/Codex）实现，引擎不绑任何并发原语**。
- **独立模式（2026-08-10 v2-1 落地）**：真并行——Dispatcher 复用引擎同一套三机制（`nextParallelBatch` 批量吐 children / worker 子实例隔离 / `joinParallel` 单点 merge），并发原语=进程内 Promise 池（每 child 一个内存态子引擎+子 Dispatcher，窗口上限 `max_concurrent_workers`）。契约在 [[step-dispatcher#^anc-exec-standalone-parallel]]。与复用模式的差别仅在"worker 是什么"（CC subagent 子进程 vs 进程内 Promise）与状态介质（文件子目录 vs 内存）——批收集/排除/join 语义全同一套引擎 API。

**真并行的三条落地规则**（概念 `^anc-step-parallel` 本就是"children 同时启动"，v2 是回归概念本意）：
1. **一层并行**：只有最外层 parallel 扇出；嵌套在 parallel 子树里的 parallel 在 worker 子实例内**退化为顺序模拟**（不报错）。S12 保证等价，且并发上界锁死在"一个 parallel 的直接 children 数"，不嵌套爆炸。
2. **每 child 独立子实例目录**：每个 parallel child 容器在 `.hopstate/<inst>/parallel/<child_step_id>/` 独立状态目录跑（类比 call 子实例 `calls/`），N 个 worker 各写各的子目录，跨进程天然无竞争（[[#^anc-exec-parallel-subinstance]]）。
3. **一次性 join**：N 个 worker 全部完成后，由**单进程** `join_parallel` 命令收集各子实例输出 merge 回父 scope——规避 N 个进程并发写父 state.json/vars.json 的丢更新风险。

**理由**：真并行需要并发状态管理、竞态处理；v1 优先保证语义正确和可调试。v2 用"独立子实例目录 + 单进程 join"把并发安全问题降维为"各写各的目录 + 单点 merge"，复用既有 call 子实例机制，不引入文件锁或跨进程同步原语。

**并发上限**：`ResourceLimits.max_concurrent_workers`（缺省 5，见熔断常量表）。引擎只透传上限给 driver，**排队（信号量）由 driver 适配层实现**。

### 决策 5：熔断常量

以下魔数由人拍板，防止资源耗尽：

| 常量 | 值 | 理由 |
|------|-----|------|
| replan 尝试上限 | 3 次 | adaptive 失败 3 次仍无解，大概率是 subtask 契约本身有问题，升级 HITL 或 fail |
| subtask retry 默认 | 3 次 | 平衡瞬时故障重试与无限循环 |
| loop max_iterations 默认 | 100 | 防止无终止条件的 loop 失控 |
| call 深度默认上限 | 10 层 | 防止递归调用爆栈 |
| parallel 并发上限默认 | 5 | `max_concurrent_workers`：**含主线的总并发路数**（2026-08-10 作者定，主线自算一路——配 N=主线 1 路+最多 N−1 个在飞；配 1=全串行调试口子）。平衡并行加速与资源/上下文窗口占用 |

---

## 接口契约

所有 CLI 响应类型、ErrorCode、SpecError、辅助类型（OutputDecl、StepSummary、RetryRecord）集中定义于 [[shared-types]]。本文件仅描述 Engine 的行为语义。

---

## impl next_step【说明】

```
# Spec: 返回下一步执行上下文
Id: next_step
Goal: 遍历步骤树，找到下一个待执行的步骤，组装上下文返回

Inputs:
- instance_id: line      # 执行实例 ID
- spec                   # Field
- step_states            # Field
- variables              # Field

Outputs:
- response: yaml         # NextResponse（5 种形状之一）

## Steps
1. [act] 检查执行状态：是否所有顶层步骤已完成/失败/跳过
  - ← step_states, spec
  + → execution_finished: bool
  + → has_failed_steps: bool
  > 遍历 spec.steps（顶层），若全部状态为 done/failed/skipped 则 finished = true

2. [branch] 按执行状态分派
  + → response

  2.1. [case] execution_finished = true 且无 failed
    2.1.1. [act] 构造 ExecutionCompleted 响应
      - ← variables, spec
      + → response
      > 收集 spec.header.outputs 声明的变量值，返回 { status: 'completed', outputs }

  2.2. [case] execution_finished = true 且有 failed
    2.2.1. [act] 构造 ExecutionFailed 响应
      - ← step_states, variables, spec
      + → response
      > 找到最后一个 failed 步骤，收集 partial_outputs（含 null 值）

  2.3. [case] execution_finished = false
    2.3.1. [act] DFS 遍历步骤树，找到第一个可执行节点
      - ← spec, step_states
      + → target_step: yaml  # { step_id, step_type, node } 或 null
      > 深度优先前序遍历（DFS pre-order）： ^anc-exec-dfs-traversal
      > - pending 的可执行步骤（7 种 ExecutableStepType——reason/act/check/confirm/ask/commit/call）→ 命中，标记为 running
      > - pending 的容器步骤 → 标记为 running，进入其 children 继续遍历
      > - running 的容器步骤 → 进入其 children 继续遍历（resume 场景）
      > - running 的非容器叶子步 → 停止扫描返回 none（"已派出待回写"的活跃态，引擎 WAITING_WRITEBACK 防线接手——0049，详见下 ^anc-exec-stale-resubmit 相邻 dfs 条款）
      > - done/failed/skipped → 跳过，继续同级下一个兄弟
      > 容器进入条件：
      >   subtask: 标记 running，进入 children
      >   parallel: 标记 running，按声明顺序依次进入每个 pending child
      >   loop: 标记 running，进入 children 执行一轮迭代
      >   branch: 标记为 running，内部评估 case 条件选择匹配的 case：
      >     遍历 children（CaseStep），对每个 case.condition 做变量表达式求值：
      >       `{var}` → 变量值 truthy 检查（非 null / 非 false / 非空字符串 / 非 0）
      >       condition = hop_python 纯表达式（2026-08-09 升格）：字面量/变量/字段/下标/
      >         比较 == != < > <= >=（数值语义,经 looseEq/toNumber——修字符串化比较的 '9'>'10' 坑）/
      >         and·or·not（短路）/算术/括号/裸变量真值/内置 pure 函数（evalExprSync 直接执行 ACT_BUILTINS，非 pure 调用折计算异常）。禁工具调用（有副作用）、禁赋值（只读）。
      >         求值=act-body-parser.parseExpression 解析 + 解释器 evalExpr 同步化（无工具分支）
      >       空条件 → default case（始终匹配，必须为最后一个 case）
      >     评估顺序：从上到下，首个匹配命中
      >     选中 case → 标记为 running，其余 case 及其 children（递归）标记为 skipped
      >     全不匹配且无 default → 静默跳过：标记 branch 为 done，所有 case 标记为 skipped（输出即"声明未产出"，值空间不写入）
      >     如果需要 LLM 推理来决定走哪个分支，应在 branch 前置 reason 步骤产出分类变量
      > loop 退出判定：
      >   当前迭代所有 children done → 检查 max，未达到则重置 children 为 pending 开始新迭代
      >   max 达到 → 标记 loop 为 done
      >   max=0 → 跳过循环体，直接标记 loop 为 done，所有 children 标记为 skipped。loop 输出变量保持 null（未赋值）
      >   max=1 → 执行一轮后自动 done（等效于 subtask 但保留 loop_index 隐式变量）
      >   遇到 break → 标记 loop 为 done，保留已赋值变量（包括第一轮第一步即触发 break 的情况）
      >   遇到 continue → 跳过当前迭代剩余步骤，直接开始新迭代
      >   遇到 exit → 触发 Spec 提前退出（见 exit 终止传播）
      > 控制流步骤（break/continue/exit）的状态转换：
      >   Engine 检测到控制流步骤时直接 pending→done（不经过 running 中间状态）
      >   break: 标记自身 done，标记目标循环为 done（target_loop 指定的祖先循环;缺省=最近 loop 祖先），该循环内其余 pending children 标记为 skipped;**执行路径上的 running 后代容器（命中的 branch/case 链——它们执行到了 break，不是被跳过）逐层标记为 done，递归全深度**（递归层只转容器类型;running 非容器叶子不动——那是等回写的真工作，不过 break 同步消化语义下该形态不可达〔自己就是执行点,旁系在飞由收齐门先于收尾挡〕,判据保守防御,**现行不可达故无测试钉**〔死代码场景不配钉,与收集账守卫同律〕。**一层收尾（loop 直接子级）是存量行为无类型判据**——直接子级 running 在此场景实为命中的 branch/case 容器,在飞 call 已被收齐门挡在收尾之前,行为面等价;文字如实分记两层防读者误以为全深度统一判据。2026-09-08 todo/0080 实撞:一层收尾只转 loop 直接子级，嵌套命中 case 残留 running，loop done 后 DFS 不再下钻，唯一撞到它的是 commit 执行序预检——质检全过的产物死在交付步）。若无 loop 祖先（validator C3 应拦截此情况）→ INVALID_STATE 错误
      >   continue: 标记自身 done，目标循环（缺省=最近 loop 祖先）当前迭代剩余 pending children 标记为 skipped;**执行路径上的 running 后代容器同 break 逐层 done 递归全深度**（非末轮时新迭代 resetChildrenToPending 会重置子树掩盖此病，**末轮 continue 后 loop 耗尽路径无人救**——todo/0080 批实跑重现同报文），完成传播从目标循环的直接子节点起（从 continue 步自身起会让中间层嵌套循环抢先推进迭代——targeted continue 实撞）。若无 loop 祖先 → INVALID_STATE 错误
      >   exit: 标记自身 done，触发 exit 终止传播
      > exit 终止传播：
      >   递归标记所有祖先容器为 done，从 exit 所在容器逐层向上直到 Spec Root
      >   每个容器标记 done 时，其所有 pending/running 的 children 标记为 skipped
      >   parallel 内 exit：当前 parallel child 触发 exit，parallel 内其余 pending children 标记为 skipped，parallel 自身标记为 done
      >   exit_outputs（若有）写入变量后触发向上终止传播，ExecutionCompleted 携带 exit_outputs 返回
      >   exit_outputs 的 key 必须与 header.outputs 完全一致（validator P4，不能多也不能少）；未在 exit_outputs 显式给值的 output 变量取 vars.json 中的当前值
      >
      > **条件求值规则**（branch case.condition 的完整语义）：
      > - **解析**：`{var}=={literal}` 和 `{var}!={literal}` 中 `==` / `!=` 两侧的空格由解析器 trim（`{var} == {literal}` 等价于 `{var}=={literal}`）
      > - **变量解析**：`{var}` 从当前 scope 向上查找（同变量作用域规则），未找到 → INVALID_STATE 错误
      > - **成员访问（dotted path，类似 JSON 路径）**：`{var}` 支持 `obj.field.subfield` 点号路径——先按整名 `obj.field` 向上查找（兼容真有此名的扁平变量），未命中则取首段 `obj` 为根变量、逐段下钻。对象段按 key 取字段、数组段按数字下标取（`items.0.name` 与 `items[0].name` 等价，`[i]` 归一化为 `.i`）。用于 for-each 元素按字段/下标分流（如 `{point.type} == "fact"`，point 是 `{id,type,claim,...}` 对象元素）。中途某段无法下钻（非对象/数组、下标越界或非整数、字段缺失）→ undefined（比较即不匹配，非报错）
      > - **比较语义**：所有 `==` / `!=` 比较统一为**字符串比较**——变量值先 `String()` 转换再比较。不做类型强制转换。`"42" == 42` → `"42" == "42"` → true。`null == "null"` → `"null" == "null"` → true
      > - **truthy 判定**（`{var}` 形式）：以下值为 falsy，其余均为 truthy：
      >   - `null` / `undefined`
      >   - `false`（布尔值）
      >   - `""` （空字符串）
      >   - `0`（数字零）
      >   - `[]`（空数组）/ `{}`（空对象）——**Python 对齐**（2026-08-20 作者拍板:真值面唯一未对齐 Python 处;yaml 值模型改结构后空列表形态大增,裸真值判空须全类型工作）
      >   - 注：`"false"`（字符串）为 **truthy**，`"0"`（字符串）为 **truthy**（字符串真值只看空不空——bool 型的归一在输出边界,见 ^anc-exec-output-coerce）
      > - **literal 边界**：literal 为 `==` / `!=` 右侧的原始文本，不含 `{}`。解析器从 `==`/`!=` 后取到行尾（trim 前后空格）。literal 中含 `==` / `!=` / `{` / `}` 为未定义行为——v1 不校验，建议作者避免

    2.3.2. [branch] 按 target_step 结果分派
      + → response

      2.3.2.1. [case] target_step 为 adaptive_needed 信号
        2.3.2.1.1. [act] 构造 AdaptiveNeeded 响应
          - ← target_step, variables, step_states
          + → response
          > 组装 failure 信息、subtask_contract、original_children、retry_history

      2.3.2.2. [case] target_step 为 paused 步骤
        2.3.2.2.1. [act] 构造 ExecutionPaused 响应
          - ← target_step
          + → response
          > 返回暂停步骤的 presented_data 和 response_options

      2.3.2.3. [case] target_step 为可执行步骤
        2.3.2.3.1. [act] 组装上下文并返回 StepReady
          - ← target_step, variables, spec
          + → response
          > 调用 PromptAssembler.assemble_*_context 组装 AssembledContext
          > 返回 { status: 'step_ready', step_id, step_type, summary, context }

3. [exit] 返回响应
  + → response
```

---

---

> **act-body 模块已抽出**：hop_python 微语言(解析/AST/解释/内置函数)+ 执行模型契约 `^anc-struct-act-body` / `^anc-exec-act-body-interp` 已独立成 [[act-body]]（被 parser/engine/prompt/validator 多方调,应独立模块独立文档）。exec-engine 独立模式经 `BodyInterpreter` 执行 body,是本模块对 act-body 的**调用方**,契约在 act-body.md。

## 输出 schema 校验【契约】 ^anc-exec-output-schema-check

`completeStep(stepId, outputs)` 在写入 variables **之前**，按步骤 `+→` 声明（`OutputDecl[]`）逐字段校验 `outputs` 的**值**是否匹配声明类型。这是模式无关的语义（独立/复用模式共用同一处校验，对齐 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）。**豁免**：confirm/ask 的输出经引擎 answer 规范化写入（bool 映射/值落变量），不走 caller 提交路径，schema 校验豁免（代码先行，2026-08-08 审计回写）。

- **校验位置**：`completeStep` 内、`writeOutputs` 之前。校验失败则**不写 vars、不标 done**，返回 `{ status: 'error', code: 'SCHEMA_MISMATCH', message }`
- **null=未产出**（2026-08-19 二十九审实撞——LLM 高频答 `key: null`〔多输出 YAML 主路径解析出真 null〕,原缺键拒/null 过是空子:header_final=null 一路通过校验直达呈审〔人看到 null〕与下游规划步。合法 null 面核尽——confirm/ask 豁免 schema、叶子 `+→=Null` 初值走 default 通道、branch 未命中不写值,不存在'LLM 交 null'的合法形态）：显式 null/undefined 与缺键同判 SCHEMA_MISMATCH,reason 指路『每个 + → 声明都必须给出真值,不要输出 null』
- **边界归一转换（2026-08-11 作者定，配套等值严格化；2026-08-20 作者定 yaml 扩员）**：校验通过后、写 vars 前，按声明类型**归一值形态**——声明 `int/float/number` 收到数字串转数字（`int` 再截断）、声明 `bool` 收到 `"true"/"false"` 转布尔、声明 `line` 值 trim、**声明 `yaml` 收到字符串 parse 成结构**（对象/列表入变量空间——概念 [[../concepts/HopSpec V3核心规范#^anc-type-yaml-structured]] 值模型：yaml=结构化数据非文本块；实撞：expand-node 1.3 `[i.name for i in header_final.inputs]` 对文本型 yaml 取字段 undefined 确定性死，subtask retry 三轮白烧）。**yaml parse 语义**：字符串先剥围栏（复用恢复阶梯同款）再 yamlLoad——解出对象/列表采用；解出标量（纯散文 yamlLoad 会得字符串）或 parse 失败 = 归一不了，**校验层拒**（checkValue 对 yaml 收紧为"值须是结构或可 parse 成结构的字符串"——SCHEMA_MISMATCH 带反馈重做，接算子自循环，不静默存文本）。声明类型是权威：LLM 执行步产出 `"3"` 时变量空间落 `3`，语言内部（`==`/`< >`/`in`）由此零跨类型特例（hop_python 宽松等值随之删除，见 [[act-body#^anc-exec-ordered-compare]]）。`coerceOutputValues(decls, outputs, typeDecls?)` 与 `validateOutputValues` 同文件相邻（validator.ts），校验与转换两函数分立（校验纯判定零副作用的既定原则不破）。**归一与校验同判据面递归**（三十七审抓漏——校验层 [T] 元素级核/TypeDecl 字段核 0014 已递归,归一层只看顶层类型:`[yaml]` 元素、TypeDecl 的 yaml/line/int 字段以原始串入库,"变量空间不存跨类型值"不变量在嵌套位破防）：[T] 逐元素、TypeDecl 声明字段逐个递归归一（多余键原样,与校验层同一容忍口径）。**LLM 消费边界的逆转换**：prompt 渲染层遇结构值序列化为 YAML 文本给 LLM 看（yaml 型变量 LLM 两头见到的都是 YAML 文本，心智不变；渲染归 prompt.ts 既有对象值通道） ^anc-exec-output-coerce
- **围栏输出恢复阶梯（BUG-C 修，2026-08-13）**：校验**之前**对"字段值为字符串且该值过不了声明类型检查"的字段跑三步恢复——①剥代码围栏（\`\`\`yaml/\`\`\`json 头尾）②YAML 解析（JSON 是其子集一并覆盖）③解析结果若为 `{该字段名: 值}` 单键嵌套再剥一层；**解出的值必须重过类型检查才采用**——终审门（checkValue,带 typeDecls 与校验层同判据面——0014 八审:不穿则 TypeDecl 声明的围栏串被'未声明类型非空即过'挡在阶梯外自愈失效）是唯一守卫：解析失败、或解析结果仍过不了类型检查，原值原样进校验、照常 SCHEMA_MISMATCH（不预设"解析结果为字符串即弃"——enum 等字符串标量剥围栏后的合法值该恢复；[T] 声明字符串永过不了终审门，安全性不依赖预筛）。**结构已解出档**（0014 八审补——递归字段核后终审门可能拒'形态对但字段缺'的解出物:若不采用,原围栏串进校验报'非对象'指错方向〔弱模型会改形态而不是补字段〕）：解析结果为**对象/数组**（结构已解出）而终审门拒于字段/元素细节时,**仍采用解出值**——类型细节交校验层报字段级准确明细;纯串/标量解出物维持不采用（@file 指针串回归钉不破——指针串解析后仍是字符串非结构）。触发面=deepseek/qwen/glm 系把结构化输出写成围栏文本塞字段值的稳定习惯（standalone 直调高频踩；CC 复用模式 driver 自修不踩），盲重试同因必死（hopkb 级二联测 3 实例全灭实撞）。**与下条"禁止宽松接受"的分界**：那条禁的是"字符串当单元素/待解析放行"的静默容错——谎报值漂过校验；恢复阶梯是**解出真数组才放行，解不出照拒**——@file 指针串解析后仍是字符串、过不了 [T] 终审门，照拒不救，原实证不破。**结构值的单键自嵌套同剥**（四十三审 flash 实录抓漏——原阶梯只对**字符串**值触发,LLM 直接交结构 `{test_params: {真值}}`〔echo 变量名作顶键〕时值已是结构直过 checkValue,自嵌套壳原样入库:下游 `test_params.unread_emails` 取不到〔多包一层〕,消费面靠 LLM 自适应才没炸——同族第 4 形态:围栏串/键前缀文本/围栏+散文都有防线,唯独结构形态漏〕：值为**恰单键对象且键名=字段名**时剥一层,**循环剥至不动点**（2026-08-22 hopbuild2 ppt 轮实抓:deepseek 交三层 `{hf:{hf:{hf:真值}}}`,剥一次剩双层原样入库,下游机械关按键取值恒空四轮退死——同键自嵌套无合法语义,剥净为止;字符串档③解析后的同剥同循环;与字符串档③同判据;剥后无类型终审——结构已在,细节归校验层）；**列表元素位的单键自嵌套同剥**（hopissues/0053,2026-08-31——家族第 5 马甲:壳长在列表**元素位**而非值顶层。`[line]` 声明收到 `[{"字段名": ["真值"]}]`:值是列表过了"是结构"关,列表本身不是单键对象,顶层剥不触发,元素内的壳无人剥,SCHEMA_MISMATCH 三轮同因盲死〔hopkb r15 批 32 子会话 8 个灭于此,25%〕。判据与顶层同源收紧:值为**数组**且**每个元素**都是"恰单键对象且键名=字段名"时,逐元素剥壳;**剥出物为数组则拼平、否则就地替换**〔`[{f:["a","b"]}]`→`["a","b"]`,`[{f:"a"},{f:"b"}]`→`["a","b"]`——两形态都是"元素被同键壳包住"的变体〕;元素循环剥至不动点〔多层同病〕;**任一元素键名≠字段名即整列表不碰**〔混合形态说明列表语义真是对象列表,不是壳——照拒不救,probe 反例钉此〕;剥后无类型终审,细节归校验层〔与结构档同理〕）；恢复在 `recoverOutputValues`（validator.ts，与校验/转换两函数相邻，三函数分立：恢复改值形态、校验纯判定、归一转换）。**不动点归一**（2026-08-24 作者定"又是 json-yaml,这个还不能自动解决么"——结构病:recover/coerce 单趟接力各管一种壳,LLM 的包裹会嵌套组合〔JSON 壳装 YAML 串/围栏装 JSON/同键嵌套装围栏〕,剥出的新值不回炉就漏;历史四马甲:dr9 围栏/BUG-C 单键嵌套/ppt 三层自嵌套/coffee3 JSON 包 YAML 串〔coerce 解 JSON 壳→recover 剥同键嵌套→露出 YAML 串无人再看,字符串入库下游机械关炸,引擎错误灌修订工单四轮烧尽〕）：`normalizeOutputsToFixpoint(decls,outputs,typeDecls)` 循环 recover+coerce 至值稳定（上限 8 轮防御,正常 2-3 轮收敛;每步变换确定性无震荡）。**不变式：值能经有限次确定性变换到达声明类型,引擎必达之;到不了才 SCHEMA_MISMATCH**。completeStep 与 subtask 收割两站点同用;宽容形态不宽容内容照旧（纯散文 parse 不出结构照拒）;留痕照旧（每层剥壳 warn）；恢复即留痕（declared-or-flagged：恢复采用的字段随步落 HopLog warn 一条——静默改值不可无痕,审计读出"LLM 给了围栏、引擎剥的"）；重试反馈半边——mismatch 值含围栏痕迹时 message 追加"直接返回值本身，不要代码围栏不要外层变量名键"（独立模式算子重试与复用模式 done 打回同享）。**覆盖面=全部输出边界**（2026-08-13 BUG-D 补口——同族最后一处）：①completeStep（步骤输出,原装点）；②**call 边界输出映射**（`mapCallOutputs` 取值时逐值经 `recoverFencedValue` 剥壳原语——剥围栏→YAML 解析→按**来源键**剥单键嵌套;无围栏/解不出原样返回,幂等。为什么不是'按父声明过阶梯'：call 的 +→ 是输出映射非 OutputDecl〔parser 清空 call.outputs〕,父侧无逐字段类型声明可依,收窄点在 collect listVar 的 [T]——故 call 边界只剥壳不做类型终审,类型核归下游消费。病灶：子实例输出声明宽松标量〔yaml 过检查,恢复阶梯在子端不触发〕,围栏串跨边界原样漂进父空间;reapParallelCall 喂 collect 缓冲不经 completeStep 零恢复——hopkb 级二实撞:outcomes 收集列表全丢）。completeCallStep 路径经 completeStep 二次覆盖无害（恢复幂等）；③**subtask 收割**（`reapParallelSubtask` 直写 collect 缓冲/兄弟位 root,同样不经 completeStep——按标注步骤 outputs 声明过**带声明档阶梯+边界归一**（recover 后接 coerce 与 completeStep 同序：数字串/'true' 跨收割边界破"变量空间不存跨类型值"不变量〔^anc-exec-output-coerce 等值严格化前提〕,下游算术计算异常）,review 抓漏 2026-08-13 同族第 4/5 处;至此全谱 `variables.write` 调用点核尽:completeStep 内/两收割函数/两 collect 缓冲喂点,值跨边界写入全部有恢复覆盖。**collect finalize 与 call 边界不加 coerce 的理由**：子实例端 completeStep 已按子声明归一——跨边界值已是真类型;仅"子声明宽松父期待收窄"的声明失配形态会漏,那不该静默救〔类型核归下游消费〕）。正反例：围栏 yaml 列表/围栏 json/单键嵌套三形态解出；真散文照拒；@file 指针串照拒（回归钉）；text/markdown 声明的合法围栏内容不被碰（字符串过标量检查即跳过阶梯）；enum 围栏值剥出合法枚举成员（字符串标量恢复面）；call 边界围栏串按父声明解出真值进 collect（BUG-D 形态）。 ^anc-exec-output-fence-recovery
- **v1 校验策略**（值层面，非类型声明合法性——后者由 V7 在解析期管）：
  - 内置基础类型：`bool` 须真值、`number/int/float` 须可转数、`enum(a,b,c)` 值须在列举内、`[T]` 列表**须为数组**——逐项查值
  - **列表类型 `[T]` 严格要求数组，字符串一律拒绝**（`SCHEMA_MISMATCH`）：列表的语义就是数组，收到字符串 = 类型谎报。**禁止"宽松接受非空字符串当单元素/待解析"**——那是静默容错，会让谎报值漂过校验、污染下游（实证：reason 步 `+ → pages: [text]` 收到 `@file` 指针字符串被放行，到 for-each join 才 `Array.isArray` 失败、期望 child 数算成 0、聚合全空，故障漂离源头两个 step 且伪装成"join 丢输出"）。契约违反须在校验层当场炸——SCHEMA_MISMATCH 触发带反馈重试，driver 自然改出真数组。文本转列表若确有需要，是**提交层**的显式解析职责，不是校验层的宽松放行（校验保持纯判定、无副作用）
  - **列表型显式 null 归一空列表**（2026-08-23 作者定"自动归一成 [] 收下，要有宽容度"——dr10 实撞：骨架步两个列表产出 sub_nodes/log_notes 本轮恰好无条目，flash 连交三轮 null，算子级重试全烧尽整步失败，内容全对败在空值形态；对"没有条目"这一合法语义，null 与 `[]` 的差别是表示法而非语义，拒收是把表示法偏好当契约执行）：声明 `[T]` 且**字段键在场、值为 null/undefined** → 恢复层归一为 `[]` 采用，随步落 HopLog warn 留痕（declared-or-flagged，与围栏恢复同则——审计读出"LLM 给了 null，引擎归的"）。**宽容边界从紧**：仅列表型享此待遇——`yaml`/标量声明收 null 照拒（对象缺失没有"空对象=没有"的天然语义）；**字段键整个缺失照拒**（键都不写=可能忘了整个产出，与"写了键、值为空"是两种失败，前者该打回）；恢复层落位 `recoverOutputValues`（改值形态归恢复层，校验纯判定不破）。落位后 `[T]` 的 SCHEMA_MISMATCH 只剩"缺键/真类型谎报"两形态
  - **自定义 TypeDecl 递归字段核**（2026-08-17 hopissues/hoplogic3/0014——原实现只查非空,连设计本行原文'字段名存在性'都没做到:缺 claim 的占位 Cand 全过,十八讲 78 候选跑成占位+null 弃点潮,修复动作离故障源头两三步）：值须为对象（非数组/null）且**声明字段全部在场且非 null/undefined**（空串合法——"空串=占位无效点下游过滤"是 spec 作者的显式设计,不越权拒）;字段值再按字段类型递归 checkValue（text 族自然宽松,bool/number 字段真核）;**多余键容忍**（LLM 附注/额外字段无害,拒了反催重试浪费）。失配 reason 带字段级明细（"缺字段 claim"/"字段 x 期望 bool"）——算子重试反馈定向修正靠它
  - **`[T]` 元素级核**（同批——原只查 Array.isArray,元素形态零核对,'逐项查值'四字设计承诺此前未兑现）：数组在场后逐元素按 T 递归 checkValue（T 为 TypeDecl 走上条字段核;内置标量走各自值核）;失配 reason 带元素下标（"元素[2] 缺字段 claim"）
  - **`line` 多行折叠归一**（v2 2026-08-25 取代 2026-08-19『拒斥+反馈自愈』旧口径——旧口径靠 SCHEMA_MISMATCH 打回 LLM 自愈,dr16 实撞证明治不住:修错步 `fix_note: line` 两轮各重试 3 次全交多行 markdown 小结,一个记账字段烧掉容器三条命里的两条、直接参与整树推倒重跑;模型对『总结一句』天然爱写多行,语义引导失效的交给确定性归一——与『列表型 null 归一空列表』同款宽容哲学。现行规则:归一层（coerceValue）对 line 值 trim 后把换行折叠为空格（`\s*\n\s*`→` `）,内容零丢失、机器可入单行;校验层不再对多行拒斥（非字符串值照拒不变）。旧口径的病例（路径埋多行散文）折叠后成『路径+散文』单行——仍是脏值但可被下游 check 语义关按内容判,不再在类型关烧重试。**line 空串拦截——恒拦已迁约束标注（todo/0043 立,2026-09-02 作者拍 B 案改判:"倾向于 step 约束里说明,否则这个概念是分裂的"）**：v1 形态（2026-09-01,无 body 步 line 空串恒拦+body 豁免）被裁定为概念分裂——恒拦=把"非空"焊死成类型级语义,与 body/初值豁免并存即同一类型两套语义;立卡依据"空串对 line 没有合法场景"被存量作者约定证伪（hop-deep-research `cross_source: line # 无 → 空串` 等"注释约定缺席"是合法形态）;真实事故（doc-review 步 20 全空响应）已由响应级闸 [[step-dispatcher#^anc-exec-output-empty-loud]] 罩住,值级恒拦名下零独立实撞。**现行形态=声明处 opt-in 约束标注**（概念权威 [[../concepts/HopSpec V3核心规范#^anc-type-constraint-annotation]]）：`line(nonempty)` 标注槽的空串/全空白由 checkValue 判 mismatch（报文教"答不出走失败通道,不要交空串或占位字样"）,**body 有无不再是判据**——标注是作者显式意图,body 步交空串同拦;裸 `line` 空串恒合法（引擎零特判,completeStep 恒拦块已删）。"line 多行折叠归一"半边不变,`line(nonempty)` 同罩折叠（约束只管空判）。 ^anc-exec-line-single
  - **宽松项收窄**：`text/markdown/prompt/HopSpec` 接受任意字符串值（标量宽松不变）;**`yaml` 须为结构或可 parse 成结构的字符串**（2026-08-20 值模型改判随归一条款,概念权威 [[../concepts/HopSpec V3核心规范#^anc-type-yaml-structured]]——原"拒纯围栏串"条款被本条覆盖收编:围栏串剥壳后能 parse 出结构即过〔归一层采用〕,纯散文/parse 出标量=拒,SCHEMA_MISMATCH 反馈指路"返回结构本身"。text/markdown 声明的围栏内容是合法正文不受此限。checkValue 与 coerceOutputValues 共用 parseYamlStructure 同一判据面;init 入口 params 按 Inputs 声明同规归一。**文本化三面**〔三十六审探针补——概念承诺自动序列化,实装两面违约:str(结构) 产 "[object Object]" 丢数据、write(content:结构) 裸断言 as string 抛 TypeError 炸穿〕:str(x) = YAML 块式序列化（act-builtins）;写侧工具 write/create/append 的 content 收结构 = YAML 块式落盘（tools contentToText 归一）;f-string 插值 = 紧凑单行 JSON 形（插值位多行毁排版,维持既有）） ^anc-type-yaml-structured
- **message 必含**（供算子级重试构造反馈）：字段名 + 声明类型 + 实际值（截断）+ 不匹配原因；**失配涉及自定义 TypeDecl 时追加该类型的字段级定义行**（`类型定义: Candidate={claim:text, ranges:[text], kind_hint:line}`——0017:原反馈只说'缺 kind_hint'不给完整形,LLM 逐轮微调仍在猜,3 轮同因全灭;定义行让重试反馈自包含,与 prompt L1 Types 字段级同源同一份 TypeDecl。涉及类型=失配字段声明类型的 TypeDecl 闭包〔[T] 取 T,嵌套字段类型递归收集〕,每类型一行去重）
- **幂等/状态校验先于 schema 校验**：already-done 返回 ALREADY_DONE、非 running 返回 INVALID_STATE（见下方 impl 与 [[shared-types#^anc-cli-idempotency]]），通过后才做 schema 校验
- **幂等重发与错位递交分流（hopissues/0049,2026-08-31——静默毁账链下游半边）**：向已 done 步递交时**先比对内容再定待遇**——不带 outputs、或 outputs 与已存值相同 → ALREADY_DONE（status:'ok',真幂等照旧）。**比对在归一后进行**：递交值先走与写入侧同一套归一（recoverOutputValues+coerceOutputValues）再逐字段深比对——已存值是归一后的形态,拿原始递交值直比会把"逐字节重发同一响应"误判成不同内容（声明 int/bool/yaml 或围栏形态下,原始串与归一后结构必不等,真幂等承诺就塌了）。**confirm/ask 的 HITL 应答同律**（2026-09-01 review F5 钉实撞——confirm 重发 `{value:"approve"}` 与已存映射值 `{approved:true}` 键名不同,直比误判 STALE_RESUBMIT,幂等承诺对 HITL 应答塌）:比对前先走与写入侧同一套应答映射——confirm 提取 decision,approve 形态经 mapConfirmOutputs 映射后再比（reject 形态不映射——向已 approve 的 confirm 重发 reject 是冲突递交,照 STALE_RESUBMIT 拒）;ask 经 mapAskOutputs 映射后再比（approve 快捷读的是当前变量值,天然等于已存）；**带不同内容 → status:'error' code:INVALID_STATE**,报文指明"该步已完成且本次内容与已存值不同——引擎在等步 X 的回写"（X=当前 running **叶子**——容器 running 时报其内的 running 叶子不报容器号;查无 running 则报先序第一个 pending 步号——两形态都点名具体步号,driver 步号错位正是本病的事故形态,报文点名即纠错线索）。原形态 ALREADY_DONE 恒 ok 使 completeAndAdvance 放行推进:内容静默丢弃+指针照推+两步同时 running 三害并发,失败点与真因相距任意远（8 迭代长任务真机实撞,连环三次错位递交推到 exit 全 skipped 终态 failed）。**幂等重发不进 advance（hopissues/0056,2026-09-01 作者拍 B 案——0049 修法②的连带效应收尾）**：completeAndAdvance 撞 ALREADY_DONE 时**直接返回结构化成功响应,不调 advanceToCaller**——报文"步骤 X 已完成（本次为幂等重发,未做任何变更）;引擎当前在等步骤 Y 的回写"（Y 的点名口径与 STALE_RESUBMIT 同源——**经公共体 findWritebackTarget 两处共用**〔review F3 抓复制份假同源后合一〕:running 叶子优先、查无则先序第一个 pending、都无则第三兜底"请查询 status 获取当前进度"〔实例已全终态时的防御形态〕）。语义依据:幂等重发零状态变化,"推进"无从谈起——原借道形态让引擎用推进词汇表（step_ready/failed/completed）回答非推进问题（driver 问"我这次递交怎么样了"不是"下一步是什么"）,词表无合适的词只好借 WAITING_WRITEBACK 的 failed 壳,status:"failed" 配报文"不是失败"自相矛盾,driver 按"failed=终态"教条会误伤合法幂等重发。A 案（新增 waiting status）判死:waiting 描述引擎全局状态不是这次递交的结局,与 failed 壳同一范畴错误。status 回答请求自身的结局,"引擎在等步 Y"是指引信息归报文。WAITING_WRITEBACK 留给原生场景（resume 时有在飞 running 步——那里 driver 问的确实是"下一步是什么",回答对题） ^anc-exec-stale-resubmit
- **dfsNextStep 撞 running 叶子=WAITING_WRITEBACK,不再透明跳过（0049 同批）**：running 的**叶子**步是"已派出待回写"的活跃态,DFS 撞到它应停止扫描（返回 none,引擎既有 WAITING_WRITEBACK 防线接手）——原形态 continue 扫向后继兄弟,使防线只在"恰好无后继"时可达（两步 spec 安全三步就漏,0049 负向对照实证）。容器类 running 照旧下降;并行派发的宿主步不受本条影响——机制是派发即入账标 done（异步收割靠 inflight 在飞账而非步骤态（命名忠实:实体字段名 inflight,2026-09-04 review 抓原文"pending_children"零实体对应）,call 型宿主且不在容器类型集）,拦截条件"running 且非容器"对它天然不成立;tool_request 挂起时两种误调分道（2026-09-04 review 面二抓原句语义反,G5 钉实装的分道回写）：误调 **nextStep**（纯推进入口）→ WAITING_WRITEBACK 点名挂起步指路,不 finalize;误调 **advanceToCaller**（恢复入口,findSuspendedBodyStep 接手）→ 同 seq 重发同一 tool_request 载荷续跑——两个入口两种正确信号,driver 撞哪个都不迷路

> SCHEMA_MISMATCH 触发算子级重试，机制见 [[step-dispatcher#^anc-exec-operator-retry]]（独立模式引擎内重做、复用模式 done 打回 CC）。

## check 判定【契约】 ^anc-exec-check-verdict

`check` 步骤是内置验证算子，固定输出签名（恰好 `bool`+`text` 两槽，由 [[../concepts/HopSpec V3核心规范#^anc-rule-p11]] 在解析期强制）。`completeStep` 对 check 步骤在 schema 校验通过**之后**、写 vars **之前**做判定——**判定与产出方式解耦**：两槽值来自 LLM 判（无 body,caller 提交）或引擎消化 hop_python body（纯机械判定,零 LLM）皆走本判定,语义零分叉：

- **按类型定位判定槽**：`declNode.outputs.find(o => o.type === 'bool')`，读 `outputs[boolDecl.name]` 的值——与用户变量名无关（用户可命名 effective/quality_ok/valid…），系统语义不占用用户命名空间
- **`false` → check 失败**：不走 done，改走 `failStep(stepId, reason)`。`reason = "CHECK_FAILED: " + outputs[textDecl.name]`（text 槽即失败说明）。failStep 接 [[#^anc-exec-retry-adaptive]] 升级阶梯——首次带反馈重跑（text 作反馈源）、再失败 adaptive 重规划
- **失败前先写更新模式输出**：check 判 false 时，其更新模式输出（如回填祖先 `last_err` 的显式反馈通道）在 failStep **之前**落值——重跑步 `←` 才读得到本轮失败说明。（原 `^anc-exec-failstep-skip-update` 的存续半边——"failStep 置 None 跳过更新模式"的另半边已随"fail 不碰值空间"废除，见 [[#^anc-exec-none-propagation]]） ^anc-exec-failstep-skip-update
- **非 `false`（含 `true`/字符串 `'false'` 以外的值）→ 通过**：照常 done，text 槽不被读取（通过时无意义）
- **v1 边界**：verdict 缺失/null 不特判（由 schema 校验 P11 + bool 值校验兜底）；字符串 `'false'`（独立模式 parseStepOutput 可能返回字符串）也判失败
- **模式无关**：判定在 completeStep 一处（复用模式 CLI `done`→completeStep；独立模式 dispatcher→completeStep 共用），dispatcher 不重复判定

**escalatable 升层分派（2026-08-26 作者定,loop engineering 批——"失败自己声明处置"家族第三成员,与 OUTPUT_TRUNCATED 前缀/fail_kind=deterministic 同模式）** ^anc-exec-check-escalate：

背景：探索循环（策略 spec 的 Reflect 步）里,check 判 fail 恒入 retry 反馈环——但有一类缺口本层怎么迭代都够不着（要人给口径/要权限/要更强判断）,烧完 retry 才上浮既浪费预算又把"要方向"淹没在"没做完"里。升层出口不进判定值域（bool 零动——三值化议过撤了,理由链见概念层裁定记录）,**进失败说明的结构**：

- **授权前提**：check 步骤声明 `escalatable` 属性（作者授权此判定点可升层——升层是把本层缺口上交给上层注意力,**接收端是人还是上层 caller 由拓扑定**〔概念层"要什么由判定者说,谁来给由拓扑定"条款;原措辞"转人的注意力/打扰人"把接收端绑死在人上,与拓扑条款自相矛盾,2026-08-27 作者纠偏〕,哪里允许上交必须作者显式设计,与 confirm/ask 介入点哲学同构;属性未声明的 check 走既有路径,gap schema 无 escalate 字段,存量零波动）;
- **分派判据（机械四条件,不嗅探文本——tools-mcp 'timeout 字样误归'同族教训）**：`ok=false` ∧ 步骤声明 escalatable ∧ 说明槽值为结构化对象 ∧ `escalate === true`（严格判 true 非 truthy）→ 不入 failStep/retry,走升层暂停;四条件任一不满足 → 既有 failStep 路径原样;
- **升层暂停（复用 ask 暂停通道,作者拍板 A 2026-08-26）**：引擎从 gap 机械组装暂停卡——`question ← gap.need`,`context ← gap 全文 + retry_history`,`output_schema ← guidance: text`;`pause_reason` 用**新值 `escalate`**（呈现面区分"spec 作者要你确认/填数"与"循环在问路要方向"——driver 呈现语义不同）;进既有冒泡/子实例 HITL 队列（[[parallel-execution#^anc-exec-parallel-hitl-queue]]——HITL 与 CITL 是同一条上浮链的不同接收端,谁在上层谁应答）;
- **应答回注（含机械对接条款,review P1-⑥补——原缺对接细节,朴素复用 ask resume 路径会撞 mapAskOutputs 分支②把 guidance 灌满 check 双槽污染 bool 判定槽）**：escalate 应答**不走 mapAskOutputs 声明匹配**（宿主 check 步声明恒为双槽,guidance 键永远配不上声明名）——引擎按 pause_reason=escalate 分派专用消化路:guidance 值直写重试反馈通道（retry_feedback,与 last_err 同源供给面）,不碰 check 双槽变量;**本次升层不扣 retry 预算**（问路不是失败）;**gap 比较基线重置**（人给了新方向,旧的"无进展"计数清零——下一轮起重新累计）;
- **说明槽结构化前提**：escalatable 的 check 说明槽须声明为 `yaml`（结构化缺口——轮间可比较的进展指纹载体,`escalate/need` 为保留字段;概念层说明槽 text→text|yaml 扩类,^anc-step-check 升格半边）;
- **validator 两规则**（parser/validator 侧,正反成对）：①escalatable 而说明槽非 yaml → E1 error 指路;②非 escalatable 的 check,gap 结构里写了 `escalate: true` → **运行期 warn**（声明缺席字段无效——防"判定者诚实被静默吞",declared-or-flagged;静态半边管不了运行期值,warn 落在引擎分派处）。

**实装接线（2026-08-27 落地,0006 批次一）**：分派点=engine.completeStep check 判定块（四条件命中 → pauseForEscalation:步骤保持 running+escalate 卡落盘+escalatePending 持久化〔StateFile,跨进程〕）;nextStep 短路（待答期不重派发起步,原样重放卡）;消化路三通道——dispatcher.resume（独立模式,getEscalatePending 判据先于 confirm/ask 预检）/CLI submit --answer（复用模式,同判据）/MCP resumeRun（恢复预检 isEscalatePaused 放行）,guidance 经 resumeFromEscalation 写入最近祖先重试容器的 retryHistory（【升层指引】前缀,L2c/L7 同源供给面可见——**挂账位=最近 subtask/case 祖先**,getWriteScope 是变量作用域函数不是容器定位,首版误用当场测红）,不扣 retry 预算（不动 retryCounters/不记 retry 事件）,发起步回 pending 重跑。**无 retry 祖先容器的边界口径**：发起步不在任何 subtask/case 祖先内（顶层裸 check）时,`nearestRetryContainerId` 查无,指引兜底挂**发起步自身 id**（`?? stepId`,src/engine.ts:624）——反馈通道按步 id 记账照常被重跑轮的反馈收集读到,升层指引不因拓扑缺容器而丢失。

**check body 引擎消化**（2026-08-19 作者拍板 A，概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-check-body]]）：check 可带 hop_python body（与 act 同文法同解释器）——**两模式都归解释器**：复用模式 `isCallerActionPoint` 判非介入点归消化循环；独立模式 dispatcher `executeStep` 的 check 分派按 body 有无分档（有 body → executeActBody 解释器直执,无 body → executeReasonOrCheck LLM 判——四十一审 flash 实录抓漏:原分派一律 LLM,check body 独立模式整个失效,LLM 对着 body 文本猜输出交 null 双槽 SCHEMA_MISMATCH 假失败）。body 直赋两槽变量后经上方同一判定路径（bool false → CHECK_FAILED 照常容器 retry，判定语义零分叉）；含工具 body 同权 tool_request 挂起恢复（ToolRequest.step_type 扩 `'check'`）；无 body 照旧 LLM 判（语义面核验的正当形态）。 ^anc-step-check-body

## 完成并推进到 caller 介入点【契约】 ^anc-exec-advance-to-caller

**执行节奏归引擎**（概念 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 原则 6）。引擎提供 `completeAndAdvance(stepId, outputs?): NextResponse`——driver 交活与领取下一指令的**一次原子往返**：回写本步结果，然后引擎自己推进、消化中间步，直到下一个 **caller 介入点**或终态，返回 NextResponse。节奏（推进时机、消化粒度、停在哪）由引擎定，driver 无选择权。

**caller 介入点**（引擎遇此停下交 driver，是唯一权威定义；引擎内部判定 `isCallerActionPoint(step)`）：
- `reason` / **无 body 的** `check`——需 LLM 推理（check 带 body 时归引擎消化,见下——2026-08-19 作者拍板 A,概念 ^anc-step-check-body）
- `confirm`——需审批决策（→ paused，approve/reject）
- `ask`——需 caller 提供数据值（→ paused，自包含介入请求，见 [[../concepts/HopSpec V3核心规范#^anc-exec-hitl-presentation]]）
- act/commit/check body 内的**引擎 provider 外的单个工具调用**——引擎解释 body 撞到 provider 够不着的工具（caller 会话专属:MCP/宿主能力）才发 `tool_request`（工具名+已求值命名参数），caller 只执行这一个工具（provider 内的文件工具等由引擎直执不外发——2026-09-05 执行主体原则改定,分派判据权威见 `^anc-exec-tool-request`;body 编排恒在引擎手里——2026-08-04 概念层收紧，caller 不再见 body 全文）
- 无 body 的 act/commit——自然语言描述整步交 driver（无结构可解释，维持整步介入）
- 终态：completed / failed / adaptive_needed

**引擎自己消化（不交 driver）**：**全部 act/commit/check body 的解释执行**（BodyInterpreter 两种模式共用）——纯计算 body 整段消化；含工具 body 逐行推进、仅工具调用点暂停、工具结果代入后续跑、`+→` 输出由引擎组装。**check body 消化后走同一判定路径**（body 产出经 completeStep 双槽判定:bool 槽 false → CHECK_FAILED 照常触发容器 retry——body 只是两槽的产出方式,判定语义零分叉;机械判定〔判空/比阈值〕零 LLM 化,hopbuild 对齐门/意见闸类机械闸即消费面）。另有容器进入/推进、分支条件评估、loop 迭代等纯状态机转移。

**tool_request 介入点与确定性重放【契约】** ^anc-exec-tool-request：
- **分派判据=执行主体原则（2026-09-05 作者定『act free/reason/check 这些如果是 agent 在跑的,就由 agent 执行,其他是引擎在跑的就是 jit 引擎来执行,这个在设计层面明确』——对焦史:切片 review 实跑撞 commit body 的 write 停 tool_request,2265 字符全文过 agent 上下文纯搬运;第一版『复用模式引擎不该有独立行动权』解释被作者驳〔"独立模式和复用模式下也没区别啊"——subprocess.run 复用模式恒引擎直执证伪〕,write 交 caller 的真实原因只是通道统一性优先的设计选择非必然）**：body 是引擎解释执行的（^anc-exec-mode-invariants 原则 6 两模式同款）,body 内工具调用就由引擎执行——消化路径撞 journal 外的工具调用时,先查**引擎自有 provider**（lazy 构造的 CompositeToolProvider——直执面=内置两成员〔builtin-file+builtin-notify〕**∪ hopjit.yaml tool_servers 注册件**〔2026-09-06 作者拍『你不要等着这个坑把人坑了再填吧』将 review 待议转正,todo/0076:此前实现缺注入半边,用户注册了工具 body 里不生效且无提示——契约债非新功能;沿革:2026-09-05 review 抓初版'注册件同享'宣称超实曾如实化为'内置两成员+待议',本批补齐注入后宣称与实况归一〕）。**注册件装配四条款**：①**注入落点=组合根工厂函数内现读**——工厂构造 CompositeToolProvider 前调公共函数 loadProjectToolRegistry（**住 tools-registry.ts**,签名吃 baseDir 参数读 `<baseDir>/hopjit.yaml` 的 tool_servers 节——cwd 只在组合根读一次传入,函数体零 process.cwd()（run 隔离不变量,函数纯化;2026-09-06 review 抓原字面'读 process.cwd()/hopjit.yaml'与参数化真身视角混写——照字面实现会把 cwd 读进函数内,正是守卫要拦的形态）→enrichParamsComments→parseToolServers,与 tool-call 命令同一条解析链;无文件/无节返 undefined 即纯内置面;返回真类型 ToolServerEntry[]——2026-09-06 review 面一面二双抓初版账实差后真收敛:初版该函数住 cli.ts 只有 CLI 调,mcp-server 与测试各抄同构闭包,'三份同构副本是漂移温床'的 0076 立项动机在 load 半边原样留存且条款字面超实;挪 tools-registry 后 cli/mcp-server/测试三处同 import,load 与工厂构造体两半边全收敛）,工厂构造体收敛单份（makeEngineToolProviderFactory）,engine 层零感知（分层纪律不破）;②**现读语义**——注册表按装配期现读,在途实例改 hopjit.yaml 下一条命令进程生效（与 default_model/routing_rules『每 run 装配期重读』同款语义）;**每 ExecutionEngine 实例**首次消化含工具 body 时现读一次、实例级缓存（2026-09-06 review 措辞校准:原『同一进程内一次』在多实例常驻进程〔mcp-server〕下与实况不等价——该进程消化路径当前零消费面无实害,量词按实况写）,单命令进程一命令一实例,生命周期内表恒一致,重放一致性天然成立;构造抛错不入缓存,重试步重新现读（与『修 hopjit.yaml 后重试』文案自洽）;③**配置错误折步骤 fail 不炸进程**——注册件撞内置名（TOOLS_NAME_CONFLICT）或 tool_servers 节格式坏（TOOLS_FILE_INVALID）在工厂构造时抛,消化路径的构造调用点包 try 折 failStep 走升级链,报错文案带修法『工具注册表装配失败(修 hopjit.yaml 后重试)』（原 lazy 构造点在 try 块外的穿透口同批修——直执批 review 挂账缺陷转正）;④**MCP 绑定件直执边界**——引擎进程能连的 server（stdio 子进程/可达 http）直执;连不上=execute 失败折步骤 fail（分派判据是 list() 命中与否,命中后执行失败就是失败,不退回 tool_request——用户注册了引擎够不着的 server 得到明确失败而非静默绕行）。standalone 模式 dispatcher 自持全量 provider 本就直执不经此路：`list()` 命中 → **直执**,结果**先追加 tool_journal 并持久化再返回**（先入账后续跑——崩溃安全与回填路径同款账本语义,cmdJournal 双证先例）;不命中 → 才发 tool_request 交 caller（剩余存在面=工具本体只活在 caller 会话里:caller 的 MCP 工具/宿主能力,引擎物理够不着的部分）。write_scope 经解释器 allowCommit 既有链路传,写域闸（WORK_ZONE_ONLY）恒由引擎机械强制;requires_commit 闸随直执从『复用模式退化为契约』实化为真拦（fallback 是真 provider,list() 带真 requires_commit——act body 调 notify 类恒拒,与独立模式同款）。无 body 步骤（act free/reason/check）执行主体是 agent,工具归 agent 自己的工具面,引擎只收产出——此半边为现状升格为原则,实现面零改动。
- **直执接口四件（HopType,2026-09-05 review 抓字段约定缺席后补;2026-09-06 review 抓 makeEngineToolProviderFactory 缺席扩三件）**：
  - `loadProjectToolRegistry(baseDir: string): ToolServerEntry[] | undefined`——项目工具注册表现读公共件（住 tools-registry.ts）;baseDir=调用方所在组合根读好的 cwd,函数体零 process.cwd()（run 隔离不变量）;无 hopjit.yaml/无 tool_servers 节/空文档或纯注释文档（js-yaml load 返 null 先判——2026-09-06 review 实撞真边界:空文档曾抛 expected a document 未兜,所有含工具 body 步骤 fail,先判后解析修一处三消费位同愈）→ 返 undefined 即纯内置面;格式坏抛 TOOLS_FILE_INVALID 不吞（2026-09-06 review 补登——签名此前无 HopType 落点）;
  - `makeEngineToolProviderFactory(loadRegistry: () => ToolServerEntry[] | undefined): (hostConfig) => ToolProvider`（tools-composite.ts）——直执面工厂构造体单一权威,组合根与测试同 import;loadRegistry 返 undefined=纯内置面,返表=注入 tool_registry 构造;解析/撞名错误任其抛出不吞（消化路径 catch 折步骤 fail,条款③）;
  - `makeReplayToolProvider(journal: unknown[], direct?: { fallback: ToolProvider; onDirectResult: (result: unknown) => void; allowCommit?: boolean })`——direct 缺席=纯重放旧形态（journal 外恒挂起）;fallback=引擎自有 provider（分派判据的"命中"按其 `list()` 判）;onDirectResult=入账回调,**仅工具执行成功时调**（journal 元素语义=成功结果值,重放代入恒包 success:true;失败由解释器抛 TOOL_EXEC_ERROR 转步骤 fail,journal 随 retry 清账重跑）;allowCommit=requires_commit 工具的语境放行开关,调用方按 `step_type === 'commit'` 传（缺席按 act/check 语境拒——2026-09-06 review 抓字段漏登后补:该字段 5031c6b5 批与第二道闸同批实装,HopType 清单当批未逐到）。**直执分支带第二道 requires_commit 闸（闸与执行同源）**：execute 按 fallback 真定义 Map 再判一次 requires_commit——解释器侧第一道闸依赖 `list()`,执行依赖 fallback 命中判据,两来源独立时 list() 回归即闸被绕过（2026-09-05 review 变异实锤:删 list() 半边五钉全绿而 act body 的 dingtalk_notify 真发送）;第二道闸使 list() 无论怎么坏,act 语境的 requires_commit 工具恒拒;
  - `ExecutionEngine.setEngineToolProviderFactory(f: (hostConfig) => ToolProvider)` 静态工厂——组合根（cli.ts/mcp-server.ts 模块加载时）注册,engine（层1）不 import tools-composite（层2）的分层兑现（module-principles §2,check:fast 分层守卫实拦后的正形）;配套 `resetEngineToolProviderFactory()` 测试专用注销（静态位跨测试组泄漏的对治）。
- **分派流程两条补充分叉（HopSop 补全,2026-09-05 review 抓分叉缺席后补）**：
  - **直执失败折 failStep**：直执工具失败经解释器包 `TOOL_EXEC_ERROR:` 前缀抛出、requires_commit 拦截抛 `COMMIT_REQUIRED:`——消化循环 catch 按前缀折 failStep 走升级链（与同循环的 SCHEMA_MISMATCH 处置同款,不穿透进程）。实际到达形态只有这两种：内置文件工具的 WORK_ZONE_ONLY 拒写在 provider 层即折 success:false、恒以 TOOL_EXEC_ERROR 包裹到达（catch 正则保留 WORK_ZONE_ONLY 前缀属防御性冗余,非第三条活路径——2026-09-05 review 双向变异实锤）;
  - **工厂缺席退化**：工厂未注册或 hostConfig 缺席（嵌入/单测场景不经组合根）→ getEngineToolProvider 返 null → direct 参数缺席 → 全部工具挂起 tool_request 的旧形态,零破坏。
- **响应形状**：`{ status:'tool_request', instance_id, step_id, step_type, tool, args, tool_call_seq, output_path, work_zone }`——`instance_id` 实例定位（跨进程注入用）;`step_type` 为 act|commit|check（caller 据此判 write_scope 语境）;`args` 是引擎已求值的命名参数 Record（含从变量代入的实际值，超阈值走 $file 卸载协议——卸载落 `work_zone/vars/tool_<step_id>_<seq>/<参数名>.json`,namespace 子目录按步+调用序号隔离防同名参数跨调用互踩,2026-09-04 0040 批兑现）；`tool_call_seq` 是本步内工具调用序号（从 1 起，重放定位用）;`output_path` 是给 caller 回写工具结果的建议落盘路径（`work_zone/tool_<step_id>_<seq>.json`,大结果写此文件后 `--tool-result @<路径>` 提交;work_zone 缺席〔独立模式内存态〕时本字段缺席,caller 小结果内联提交即可）。
- **caller 义务**：只执行 `tool` 这一个工具，结果 JSON 经 `submit_and_fetch_next <step_id> --tool-result` 交回；不解释 body、不组装输出、不做多余计算（最小语义在结构上强制）。
- **载荷一次性——禁用 resume 重取（caller 纪律，2026-08-30 真机实撞后补）**：tool_request 响应只发一次，caller 必须从收到的那个响应里捕获 `tool`/`args`/`output_path`（响应大就先落盘存副本，后续用时读副本）。**`resume` 不是查询命令**——它走 recover 语义，把悬空 running 步骤重置为 pending，body 从头重放（journal 不清，见上条重放契约：已入账的工具结果直接代入；**尚未提交结果的那次工具调用不在账上，会重新发起、对着当前的文件系统重新执行**）。执行中途调 resume "重新看一眼载荷"的后果正出在这半边：若流程后段已改变现场（如变异核证里恢复步已把文件 checkout 回原样），未入账调用的重执行结果就是对着已改变现场算出来的错值，随后覆盖首轮的正确记录（examples/mutation-verify 真机实撞：首轮 applied=true 变异后测试变红=pinned 的正确记录，被 resume 触发的重跑轮 applied=false 冲掉，点位误判 point_invalid）。resume 的正当场景只有一个：进程/会话真死了之后接续实例。
- **确定性重放（跨进程恢复）**：state 持久化 `tool_journal: { [step_id]: unknown[] }`——本步已获结果按 seq 追加;元素两形态并存（caller 信封/直执裸值）,形态判据与归一见下条剥壳条款（2026-09-06 review 抓本行旧注记 `ToolResult[]` 与剥壳条款相邻矛盾后改——0075 批自称收口只加了新条款漏改本行）。每个进程对当前 act 步从头重放 body：撞第 N 个工具调用查 journal[N-1]，有则代入继续，无则按分派判据处置（引擎 provider 命中直执入账续跑,不命中发 tool_request 并落盘挂起——2026-09-05 执行主体原则改定,原『无则恒发 tool_request』废）。body 除工具调用外纯确定性 → 重放零副作用、崩溃安全（进程死在任何点，重放收敛到同一位置）。步骤完成/失败/重试时清本步 journal（retry 重跑工具是预期语义——工具幂等性归 spec 作者声明副作用等级管理）。
- **journal 元素形态与重放剥壳**：journal 实际存两种形态并存——caller 经 `submitToolResult` 交回的 **ToolResult 信封**（`{result, success}` 对象,原样入账）与引擎直执侧 `onDirectResult` 入账的**裸结果值**（`r.result`,不带信封）。**重放侧按形态归一**：journal 元素判定为信封（对象且带 `success`〔bool〕与 `result` 两键）→ 剥壳取 `.result` 交 body,`success` 随信封透传（信封自报失败照走 TOOL_EXEC_ERROR 折步骤 fail,不静默转成功）；非信封裸值 → 直传。**body 拿到的恒是裸结果值**——与引擎直执模式逐值一致。沿革：2026-09-05 0075 批实撞——caller 按本条款类型注记交 ToolResult 信封,重放侧曾对 journal 元素再包一层 `{success:true, result:元素}`,body 的 `parse_json` 拿到信封对象即炸『期望 JSON 文本,实际: object』；类型注记（ToolResult[]）与旧注释『journal 元素语义=成功结果值』互相矛盾,本条款以剥壳归一收口。
- **内置函数不发 tool_request**：`ACT_BUILTINS`（len/split/trim…）引擎直接求值——很多含工具 body 的 caller 往返次数不升反降。

**advance 循环**：`completeStep`（或对应应答方法）成功 → `nextStep` → 若结果是可消化 body（act/commit 无工具）则 BodyInterpreter 跑完 `completeStep` → 继续；遇 `isCallerActionPoint` 或终态则返回该 NextResponse。

**引擎消化 body 的 SCHEMA_MISMATCH → 直接 failStep（不交 caller）**：由独立模式既定语义推演（`^anc-exec-operator-retry`"body 确定性，schema 不匹配不改 prompt 重做"）——消化路径的 body 是**引擎自己执行**的，产出不匹配交还 caller 毫无意义（caller 重跑同一确定性 body 得同一不匹配，只能 `--failure` 提交自由文本转述，违反失败记录机器通道原则）。故消化循环中 `completeStep` 返回 SCHEMA_MISMATCH 且当前步含 body → 引擎直接 `failStep(校验明细 + "act body 确定性，schema 不匹配转容器级 retry")` 走升级链，与独立模式同一分支同一措辞。"错误不推进交 caller"（`^anc-exec-output-schema-check`）仍适用于 **caller 产出**的校验失败（done/submit 打回重做——LLM 产出改 prompt 重做有意义）。

**错误不推进**：若回写方法返回错误（SCHEMA_MISMATCH 要 driver 重做 / INVALID_STATE / ALREADY_DONE），原样返回错误码，**停在原步骤不推进**——"重做本步"也是一种"下一步指令"，driver 据错误码重做。

**归属**：此前 `consumeToolFreeBodies` 的消化逻辑落在 CLI 自由函数（破坏 CLI 薄壳分层），现上收为引擎语义。`run` 与各应答命令（[[hop-cli#^anc-cli-dispatch]]）共用 completeAndAdvance，两模式统一节奏。

## 推进面执行序不变式【契约】 ^anc-exec-advance-order-invariant

**不变式**：引擎推进永不越过"文档序在前、尚未终态"的步骤去执行后继步骤——文档序是执行序的下界（parallel 派发是唯一声明豁免:派发即 done,结果收割另账）。本契约管两道防线：DFS 遍历面（不越过阻塞容器）与 commit 执行入口面（执行前动态核前序全终态）。

**防线一：dfsNextStep 对 running 容器的两种 none 必须区分**。running 容器子树递归返 none 有两种成因,处置相反：
- **子树内存在 running 的非容器叶子**（已派出等回写的执行步）→ **推进阻塞**——整个 dfs 立即返 none（引擎折 WAITING_WRITEBACK/drain 防线接手）,不得 continue 扫该容器的后继兄弟；
- **子树全终态**（容器只是还没被完成级联闭合）→ 容器待闭合,continue 扫后继兄弟合法。

沿革：hopissues/0049 修了**同层**半边（running 非容器叶子在 dfs 当层撞到即返 none,不再透明跳过）,但 running 叶子嵌在 running 容器内时,容器分支的递归返 none 被无条件 continue——嵌套半边漏了。后果=机械步消化循环连锁直执到 commit：2026-09-05 0075 批探针实证——stp2b（proactive replan 落地后 2.1 reason 仍 running,advanceToCaller 把 3/3.1/3.2/4 全部机械直执,4 的 commit 写盘 `published:staged:undefined`——milestone 没产出就发布了）;stp2c（同局面不 replan,裸 advance 同样乱序——**病在推进面本身,replan 只是常见触发入口**）。

**防线二：commit 执行入口动态核（两模式两入口）**。commit 是不可逆操作,静态排布检查（[[spec-parser#^anc-rule-p8]] 把关前置）管不了运行期乱序,执行入口处必须动态核：**"文档序先于本步的全部步骤已终态（done/skipped/failed）"**——遍历 spec 文档序,遇本步之前存在 pending/running 步骤即拒执行。两入口同一判定公共件：
- **复用模式**（engine 消化循环,BodyInterpreter 构造前,step_type=commit 时）：拒的形态=WAITING_WRITEBACK 同族响应,带未终态步骤点名（"commit 步 X 之前步骤 Y 尚未终态"）,不执行 body、步骤不动等回写；
- **独立模式**（dispatcher.executeCommit 内）：抛 `ADVANCE_ORDER_VIOLATION: commit 步 'X' 之前的步骤 'Y' 尚未终态…` 经 executeStep 统一 catch 折 failStep 走升级链——码字面是 failure_reason 里库外可见的前缀码,登记于 [[shared-errors]] 错误码表（2026-09-06 review 抓码字面全文档面零登记后补——设计不点名自家码,将来改字面测试红但设计无对照面）。

HopSop（判定公共件 findNonTerminalBefore,经 engine 门面方法 findNonTerminalBeforeStep 供两入口共用——防模块边界直穿）：
1. 取 spec 全步骤文档序展开（含嵌套子孙）；
2. 逐一检查排在目标 commit 步之前的步骤状态——**含两条实质分叉**（2026-09-06 review 抓设计漏写后补,此前只活在代码注释,照三步直译实现会把嵌套 commit 全部误拦）：
   - **祖先 running 容器豁免**：目标 commit 步嵌在容器内时,其祖先容器在 commit 执行期恒为 running（执行流正在其内推进到本步）——这是结构状态不是"活没干完",判据=目标步 id 以该容器 id 加点为前缀（startsWith(容器id + '.')）即祖先,放行；**非祖先的 running 容器（旁系）照拦**——旁系 running 意味着其内仍有步骤未走完；
   - **目标 commit 步不在树上 → 返"无未终态"不拦**：call 子实例收窄等形态下目标步可能不在当前 spec 树里,执行序归调用方状态机管,本闸不越权；
3. 全部为终态（done/skipped/failed）→ 放行；存在 pending/running（按上述分叉判后）→ 拒,报文点名第一个未终态步骤。

静态半边归 [[spec-parser#^anc-rule-p8]]（排布检查）,运行期执行序归本条款——互指。

## 动态失败兜底——无兜底失败的介入点化【契约,设计稿待作者拍定后实现】 ^anc-exec-dynamic-onfail

**一句话**：步骤失败、重试烧尽、又没有 spec 里写好的 `[on fail]` 兜底时,引擎不再直接判死实例,而是**停成一个介入点向 caller 要兜底计划**——本质是运行时动态补挂 fail handler,与 `[subtask free]` 到步展开同族（计划不足时停下来要计划,这次要的是兜底计划）。

**为什么（hopissues/0074 实撞）**：长 run 末段一步 schema 错、无重试容器可退,整个实例判死。现场完好（变量/半成品/几十步的账都在盘上）,但引擎零受控恢复入口——resume 只管崩溃悬空,submit 对 failed 报 INVALID_STATE。用户被逼手改 state.json,多字段耦合不变量(step_states×loopCounters×committedSteps)手改必坏账——实测:手术后实例误标 completed、后续整段 skipped、交付空。作者定性（2026-09-09）:"不是一个命令的问题,是完整的流程问题"——不做"事后改账复位"（那要对着坏账做外科手术）,做"事前不落账"（失败在落成终局之前先问人）。

**触发点（单点,机械判据）**：failStep 升级链 3.1 分支（无事务边界祖先的未捕获失败,含全部边界被 commit 退火）——现行为=置 terminalFailure 判死。新行为:**先查有没有 caller 可问**,有则停成介入点;真无人可问才照旧判死。3.4 的"预算耗尽且无 on_fail"路径（markSubtaskFailed 上浮到顶后同样落 3.1）天然经同一单点。**其余升级链档位一律不动**——retry/adaptive/静态 on_fail/D69 烧尽问人全部照旧,本机制只接"最后一跳"（原判死点）。

**介入点形态**：复用 adaptive_needed 响应族,新 reason=`no_fail_handler`（与 `initial_plan` 并列——两者都是"结构不足停下来要计划",initial_plan 要首计划,本条要兜底计划）。载荷=完整失败现场：failure（失败步/原因/attempt 全额)/该步声明输入的实际值（deflate 卸载,同 expansion_context 形态）/retry_history 全量/subtask_contract=失败步所在容器的输出契约（无容器时=失败步自身的输出声明）。**诊断视图不另设命令**——介入点载荷就是诊断视图（一次给全,caller 不用翻 vars.json/hoplog）。

**caller 的四种应答（同一提交通道 submitReplan,按提交物分流）**：

1. **原步重跑**（环境修好了/网络恢复了）：提交空兜底指令（约定形态:replan 内容为保留字 `RETRY`）——引擎把失败步复位 pending、失败容器链复位,照常重跑一轮;不新建任何步骤;
2. **人工代交产出**（人把正确产出写好直接交）：`RESET` 保留字同经 submitReplan 通道提交（与四应答"同一提交通道"一致——载荷=保留字,不是兜底计划）,引擎动作=失败步复位后停在 step_ready,caller 再用既有 submit_and_fetch_next 交产出（复用模式本来就是外部交产出,人代 LLM 交是同一通道零新机制）;
3. **补真兜底计划**（记档/降级/换路）：提交 `[on fail]` 块内容的步骤 markdown——引擎把它作为失败容器的动态 on_fail 子树挂载（无容器的顶层失败步:引擎先给它套一个隐式壳容器再挂——与 case 就是 subtask 同构的推演）,按既有 on_fail 激活语义执行（接住语义:兜底走完容器按 done 收场）。**展开纪律沿用 subtask free 两条**:必含 check（运行时计划无人预审）/禁 commit（不可逆必须写卡时声明）;
4. **放弃**：既有 abort 通道（不是新应答——abort 本来就能对停点用）。

**判死收窄后的口径**：terminalFailure 只在三种情形落账——caller 显式放弃（abort）/无 caller 可问（见下独立模式分叉）/动态兜底自身失败（与静态 on_fail"兜底失败不再兜"同律）。

**独立模式分叉（无人值守跑到底的场景）**：standalone dispatcher 是自己的 caller——它对 no_fail_handler 介入点的处置=**照旧判死**（机器无权替人定兜底策略;dispatcher 的 LLM 自答兜底=把"问人"偷换成"机器替人答"）。但**判死后快照保留完整失败现场**,事后人来了用 MCP resume_run/CLI resume 到这个介入点再处置——即独立模式的动态兜底是"延迟到人回来"不是"没有"。恢复路径:failed 实例 resume 时若终局原因是 no_fail_handler 形态（terminalFailure.reason 带约定前缀）,复活为介入点等应答——这是唯一一处"failed 可回头"的窄门,判据机械（前缀匹配）,与手改 state.json 的区别=引擎自己按不变量做复位。

**审计与防滥用**：每次动态兜底应答记 hoplog 事件（谁/何时/第几次/应答形态）;同一失败点动态兜底次数入账封顶（缺省 3——防反复 RETRY 硬闯把关的无限循环）,烧尽照旧判死。

**恒不动的账（四种应答共守的不变量,报告方 probe 三断言的超集）**：committedSteps 逐字节不动（commit 防重放照旧生效——恢复后重走不会二次提交,退火判定照常）;loopCounters 不动（迭代态）;全部用户变量不动（失败步与前序的产出=重试轮修复素材,fail 不碰值空间既有契约）;retryHistory 不清（历史是账——0073 卡的污染问题另案,其修法与本条不冲突:那是"跨步注入受众错位",不是"账该删"）。

**与相邻机制的分工**：静态 `[on fail]`=作者写卡时预置的兜底（有它永远优先,本机制根本不触发）;D69/D71 烧尽问人=hopbuild2 等 spec 用 ask 自建的问人回路（spec 级方案,依赖作者写了）;本机制=引擎级最后防线（没写兜底的失败也有官方出路）;`[subtask free]` 到步展开=同族机制的"事前半边"（计划没写完停下来要）,本条是"事后半边"（计划走砸了停下来要）。/hop 场景是首要消费者——主对话天然在场,失败即呈现场问人,四种应答对应人的四种直觉("再试一次"/"我来改"/"补个降级"/"算了")。

**上游另案**：判死规则本身要不要松（步级可修复失败不直接进 3.1——commit 退火 scope 分层,报告方 A1）是事务边界语义改动,不搭车,概念层决策另立卡。

**实现落点预划（实现批展开,此处只钉边界）**：engine.ts failStep 3.1 分支前插 caller 探测与介入点吐出;submitReplan 扩 no_fail_handler 应答分流（RETRY/RESET/兜底块三形态）;动态 on_fail 挂载复用 parseFragment+attachOnFail（新私有方法）;resume 复活窄门在 restoreRun/recover 侧;cli-types 响应类型扩 reason 枚举;MCP resume_run 同步。测试面:四应答各正反例/独立模式判死与延迟恢复/封顶烧尽/committedSteps 三断言（报告方 probe 脚本纳入）/与静态 on_fail 优先级。

## impl complete_step【说明】

```
# Spec: 记录步骤完成
Id: complete_step
Goal: 记录步骤执行结果，更新变量，检查容器完成状态

Inputs:
- step_id: line          # 完成的步骤 ID
- output: yaml           # 步骤输出（key-value）
- spec                   # Field
- step_states            # Field
- variables              # Field

Outputs:
- result: yaml           # CommandResponse

## Steps
1. [act] 验证步骤状态
  - ← step_id, step_states
  + → valid: bool
  > 步骤必须处于 running 状态，否则返回 INVALID_STATE
  > 若步骤已 done，先比对内容再定待遇（^anc-exec-stale-resubmit 分流）：不带 outputs 或内容与已存值归一后相同 → { status: 'ok', code: 'ALREADY_DONE' }（真幂等）；带不同内容 → { status: 'error', code: 'INVALID_STATE' }（STALE_RESUBMIT 拒收）

2. [branch] 按验证结果处理
  + → result

  2.1. [case] valid = false
    2.1.1. [act] 返回错误
      + → result

  2.2. [case] valid = true
    2.2.1. [act] output_schema 类型校验
      - ← step_id, output, spec
      + → schema_valid: bool
      + → schema_errors: [line]
      > 取步骤的 + → 声明（OutputDecl[]），逐字段校验 output 是否匹配
      > v1 校验策略：基础类型（text/bool/line/[line]）做值类型检查；自定义 TypeDecl 仅验证字段名存在性（Record.keys 子集检查），不做递归类型匹配
      > 校验失败 → 返回 { status: 'error', code: 'SCHEMA_MISMATCH', message: schema_errors }

    2.2.2. [act] 合并输出到 variables（先写 vars.json）
      - ← step_id, output, variables
      + → updated_vars: yaml
      > merge 策略：output 的 key-value 合并到当前 scope 的 variables 中，同名覆盖
      > 原子写入 vars.json

    2.2.3. [act] 标记步骤为 done，检查容器完成（写 state.json）
      - ← step_id, step_states, spec
      + → result
      > 标记 step_id 状态为 done
      > 检查父容器：若所有 children 状态为 done/failed/skipped → 容器自动完成
      > 容器聚合判定： ^anc-exec-container-output
      >   subtask: 所有 children done → subtask done；任何 child failed → 取决于 retry 配额（由 fail_step 处理）
      >   parallel: 所有 children done 或 failed → parallel done；聚合成功 children 的 outputs——失败 child 不贡献收集元素（列表变短，不填 None），部分结果可否接受由消费方裁量
      >   loop: 当前迭代所有 children done → 检查循环条件（见 next_step 的 loop 退出判定）
      >   case: case 是 branch 下的 subtask（开自己的作用域、声明与 branch **同名**的 `+ →` 聚合输出——互斥 case 的同名变量天生是同一个东西）。所有 children done → case done；**case 层汇聚**：case children 产出提升到 case scope。case failed（子步骤 retry 耗尽）→ case failed → branch failed（仅一个 case 被激活，该 case 失败即 branch 失败）
      >   branch: 声明 `+ →` 聚合输出作为统一接口名，各 case 用同名填充。**branch 层汇聚**：branch done 时命中 case scope 的同名输出提升到 branch scope，再由通用提升逻辑提升到 branch 外层 scope（两级提升）。无 case 命中 → branch done、**值空间不写入**（与 §分支静默跳过条目一致）
      > 递归向上检查：容器完成可能触发祖先容器完成 ^anc-exec-completion-cascade
      > 原子写入 state.json（提交点）
      > 返回 { status: 'ok' }

3. [exit] 返回结果
  + → result
```

---

## impl select_branch【说明】

```
# Spec: 记录 branch 分支选择
Id: select_branch
Goal: 激活选中的 case，跳过未选中 case。由 Engine 内部条件评估调用，也可通过 CLI 手动覆盖（调试/HITL 介入用）

Inputs:
- step_id: line          # branch 步骤 ID
- selected_case_id: line    # 选中的 case 步骤 ID
- reason: text           # 选择理由（可选，用于日志）
- spec                   # Field
- step_states            # Field

Outputs:
- result: yaml           # CommandResponse

## Steps
1. [act] 验证参数
  - ← step_id, selected_case_id, spec, step_states
  + → valid: bool
  + → error_code: line
  > 验证 step_id 指向一个 branch 步骤且状态为 running
  > 验证 selected_case_id 是该 branch 的直接 case child
  > 若 selected_case_id 不在 branch 的 children 中 → error_code = INVALID_STEP_ID

2. [branch] 按验证结果处理
  + → result

  2.1. [case] valid = false
    2.1.1. [act] 返回错误
      + → result
      > 返回 { status: 'error', code: error_code }

  2.2. [case] valid = true
    2.2.1. [act] 激活选中 case，跳过其余
      - ← step_id, selected_case_id, spec, step_states
      + → result
      > 选中的 case：标记为 running，其所有 children 标记为 pending
      > 未选中的 case：标记为 skipped，其所有 children（递归）标记为 skipped
      > 记录 reason 到 HopLog（branch 的 taken 字段）
      > 原子写入 state.json
      > 返回 { status: 'ok' }

3. [exit] 返回结果
  + → result
```

---

## impl fail_step【说明】

```
# Spec: 处理步骤失败
Id: fail_step
Goal: 处理步骤失败，沿升级链决定下一步行为——就近事务边界重试阶梯，未捕获则实例终止（函数级 fail） ^anc-exec-retry-adaptive

Inputs:
- step_id: line          # 失败的步骤 ID
- failure_reason: text   # 失败原因（人类可读）
- fail_kind: line        # 结构化失败分类：'lack_of_info' | 'error'（默认 'error'）。driver 据此机检分流（lack_of_info → 知识补充/上传父层；error → retry/adaptive）
- spec                   # Field
- step_states            # Field
- retry_counters         # Field
- hoplog                 # Field（失败原因记录到 HopLog）

Outputs:
- action: line  # 失败处理决策：retry | adaptive_replan | propagate | abort
- next_context: yaml  # 下一步所需上下文（仅 retry/adaptive 时有值）

## Steps
1. [act] 标记步骤为 failed，失败记录（FailRecord）落档。**fail 不碰值空间**（2026-08-09 作者定，函数级 fail 定稿）：不置 None、不清理、不回滚——失败步骤与同轮前序步骤已写下的变量原样保留（重试轮修复素材）；残留处置归 spec 作者（`= Null` 初值、重跑覆盖、rollback 扩展）。原"输出置 None + 更新模式豁免（DEBT-13/^anc-exec-failstep-skip-update）"整体废除——豁免是给置 None 规则打的补丁，规则删豁免亡。**None 闸已删**：None 是普通值（= Null 重置 / 声明未产出），引擎不设"消费 None 自动 fail"闸。**计算异常也是 fail**：body 算错→本步 fail、条件算错→branch fail（同日"折 None+log"中间态废）。 ^anc-exec-none-propagation
  - ← step_id, failure_reason, fail_kind
  + → fail_record: yaml  # FailRecord{failed_step, reason, fail_kind, attempt}——概念层四字段承载体（轮次=attempt，同一事务边界内第几次失败）；逐轮累积进 retry_history，跨 call 加壳内核原封

2. [act] 查找最近的重试容器祖先（subtask 或 case）及其 retry 配置
  - ← step_id
  + → parent_subtask: yaml  # { id, retry_max, retry_remaining, adaptive } 或 null
  > 由概念层「case 就是 branch 下的 subtask」推演：retry 祖先查找同时匹配 subtask 和 case 容器。
  > case 命中时按其 retry（缺省 3）/adaptive 重置 children 重跑，语义与 subtask 完全相同。
  > **commit 退火跳级（2026-08-20 作者定,概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-commit]] 退火条;2026-09-02 判据重构——作者裁定"架构设计上的迷糊"后按重跑范围判据归一）** ^anc-exec-commit-anneal
> **判据=边界 retry 的重跑范围是否盖到某次已执行的 commit**——盖到则该边界退火（不入选,继续向上找下一边界;等价于该边界 retry/adaptive 全档位失效）,盖不到则照常入选。这是退火目的句"防止 commit 被整组重跑再次执行"的直接形式化;此前两版实现各错一边:v1"只增不清"把前轮记录当本轮判,loop 轮 2 失败被轮 1 的 commit 焊死全部边界（hopissues/0061,批量构建 8/100 实例报废）;v2"按轮清除"救了轮内塌了轮外,外层包 loop 的边界看不见前轮 commit,整组重跑重放（review CA-1 探针实证甲落盘 3 次）。病根=一份无轮次记录背两个判定职责,清除与否都顾此失彼。
> **记账形态**：`committedSteps: Map<stepId, 祖先loop轮次快照>`——commit done 登记时取该步全部祖先 loop 的当前轮次（`{loopId: iter}`）;同 stepId 多轮 commit 最新覆盖（轮内判定只需最新一条,外层判定存在任意记录即中——最新对两判定都充分）。**记录永续不清除**（v2 的迭代推进清理撤除——退火失效改由轮次比对承担,"新迭代全新事务"清单回到两项:retry 预算+兜底激活）。
> **判定规则**（hasCommitInRetryScope,原 subtreeHasCommitted 改名）：候选边界 c 触发退火 ⇔ 存在记录 (stepId,快照)：stepId 在 c 子树内（前缀匹配含自身）,**且对 c 的每个祖先 loop L：快照[L]==当前轮次**。推演:c 的祖先 loop 的 retry 只发生在其当前轮内（引擎不重跑过去轮）→前轮记录轮次不等→不在 c 的重跑范围;c 子树内的 loop 被 c 的 retry 整体重置从轮 1 重跑→其轮次天然不比对（它们不是 c 的祖先）→任意轮记录都算盖到。快照缺键（旧格式恢复/异常）保守视为相等（宁多拦不重放）。
> **三行为矩阵**（测试正反例的规范来源）：
> | 场景 | 边界位置 | 判定 | 结果 |
> |---|---|---|---|
> | 轮 2 失败,轮 1 有 commit | loop 体内（单项容器） | 快照轮 1≠当前轮 2 | 不退火,retry 照常（0061 效果保住） |
> | 轮 2 耗尽上浮,轮 1 有 commit | loop 外（外层 subtask） | 该 loop 非其祖先,前缀命中即中 | 退火,不重放（CA-1 堵住） |
> | 同轮 commit 后同轮失败 | loop 体内 | 快照==当前轮 | 退火（防重放本义） |
> **持久化**：state.json `committed_steps` 新形态 `[{step_id, iters}]`;load 兼容旧 `string[]`（无快照→iters 空→判定恒命中=旧 v1 行为,保守方向正确）。**call 子实例的 commit 同界记账**：子实例含已执行 commit 时（子状态 committed_steps 非空——收割/完成路径读得到）,父侧把该 call 步登记进父 committedSteps——重跑 call=重跑整个子 spec,子内 commit 必重放,故 call 边界同守;登记时快照分两路（review B1-1——收割是异步的,渐进派发下宿主 loop 派发即推进,收割时刻的 loopCounters 可能已走到后面的轮）:串行 call=消化时同步登记,当前轮次即 commit 发生轮次（call 步 running 期父 loop 不可推进,时序一致）;并行收割三点（reapParallelCall/reapParallelSubtask/killInflight）=宿主 loop 键用在飞账 entry.iter（派发时刻真值）,其余祖先 loop 用当前值（子实例在飞期它们不会推进）。**并行收割三形态全传播（2026-08-20 作者定——成功/失败/强杀收割都要传播）**：reapParallelCall/reapParallelSubtask 入口按 outcome.committed 登记派发步 id（先于 killed 早返回——强杀的 child 内 commit 同样已发生）。committed 凭据按模式取：独立模式=worker 终态回调 hasCommittedSteps;复用模式=reapFromChildDir 读子 state.json;killInflight 强杀就地读盘登记,两通道并存登记幂等。已清账迟到收割（findIndex<0）丢弃——
  > 那次收割已传播过。
  > 全部祖先边界都退火/无边界 → 3.1 未捕获失败,实例终止（reason 注明退火——诊断可读）。

3. [branch] 按 subtask 配置决定失败处理策略
  + → action, next_context

  3.1. [case] 无事务边界祖先（未捕获失败,**含全部边界被 commit 退火**）
    3.1.1. [act] 标记 action = abort：**实例立即终止、判 failed、上报 caller**（函数级 fail，2026-08-09 作者定——与未捕获异常终止函数同构，后续步骤不再执行；原"有下游让 None 传播继续跑 / 无下游才 abort"两分支废除）
      + → action, next_context
      > 终止时值空间不清理；caller 拿到 failed + FailRecord + 失败点之前的部分产出（partial_outputs）。
      > parallel 部分失败是唯一例外，但那不走本分支——child fail 在 worker 子实例内走该实例自己的升级链，join 侧按集合语义处理（失败 child 不贡献收集元素），见 parallel 执行节。退化窗口（串行驱动）该例外同样成立（B 裁决 2026-08-11：调度形态不得改变语义）：parallel 标注步骤重试耗尽在 markSubtaskFailed/failCallStep 就地按集合语义消化（不贡献元素、主线继续），不升级宿主——见 [[parallel-execution#^anc-exec-parallel-reap-drain]] 失败路径同语义条款。

  3.1b. [case] 确定性失败——本步免扣预算,容器不提前兜底（^anc-exec-deterministic-no-retry,2026-08-23 作者令彻查 dr7 后立;**2026-09-04 作者拍乙案改定**〔决策档案 todo/decision/20260904-确定性错误免预算不提前兜底.md〕——0037 实撞:修错步撞 OUTPUT_TRUNCATED 时预算剩 2,旧形态"视同配额耗尽直达兜底"提前激活,随后兄弟步正常重试把激活标记冲掉,两机制打架;关键澄清:**确定性是步级瞬态非事务级**——它只证明"那一步拿那一次输入重跑必同败",下一轮反馈工单变了输入就变,墙就不在了。0037 环一后续靠继续修活下来是实证） ^anc-exec-deterministic-no-retry
    3.1b.1. [act] fail_kind='deterministic' 或 reason 前缀命中确定性口袋 → **本次失败不消耗容器 retry 预算**,记"deterministic failure—免扣预算"事件后照走 3.2/3.3 重试路径（下一轮输入含新的失败反馈,非同因重放）;预算真耗尽时照走 3.4 正门（兜底问人恒等预算耗尽——单入口,不存在提前激活等着被冲掉的状态）
      + → action, next_context
      > **确定性口袋（前缀匹配,封闭清单——新增须过本表,防散落判定）**：`DEPTH_EXCEEDED:`（深度是结构属性,重跑不变）/`CalleeFailure:`（子实例自己的 retry 已在子层烧尽——父层重跑=对同一失败再赌一轮,子层若有随机性它自己的 retry 已经试过了）/`SCHEMA_MISMATCH`+body 确定性档（既有:act body 同输入同产出,已在 dispatcher 侧转容器级——本条把容器级的重试也掐掉归并到此）/`CONTEXT_OVERFLOW:`（0070 四连撞实撞:压缩降级后仍超模型窗,重发必然同因且更大——每轮重试追加失败反馈,请求 1.05M→1.08M 只增不减;降级机制见 [[step-dispatcher#^anc-exec-toolloop-ctx-degrade]]）。
      > **免预算不免重试的语义（乙案本体）**：旧形态"跳过重试档位视同耗尽直达兜底"把步级确定性外推成事务级死刑——同容器其他步骤的失败仍可能靠重试修好,提前兜底=机器还能自愈的局面被升级成问人（人不在场 run 空挂无上界）。新形态:确定性失败的那一轮不烧预算（重试同因是浪费这半边保留）,但容器事务继续走——attemptsUsed 不动,下轮带新反馈重跑;预算耗尽才激活兜底。
      > **免预算的有界化（推演补洞——乙案拍板依据"代价有上界",裸免预算会破它）**：同一步骤同一确定性前缀,**首次免扣、复发起照常扣预算**（deterministicWaived 按 step_id×前缀记账,随快照持久）。理由:首次免=给"下轮新反馈换新输入"一次机会（步级瞬态假设);复发=输入变了墙还在,瞬态假设对本事务被证伪,再免就是无限循环（预算永不减,兜底 ask 永不到,比旧形态更糟）。有界性恢复:最坏 = 每个确定性前缀多送一轮,总轮数仍被 retry 预算封顶。
      > **口袋逐个归类（判据=失败根因在"本轮输入"还是在"结构/子层"——前者步级瞬态走免预算重试,后者事务级仍直达兜底不随乙案改）**：**事务级（直达兜底）**=`DEPTH_EXCEEDED:`（深度是结构属性重跑不变）/`CalleeFailure:`（子层 retry 已在子层烧尽,父层任何一轮重跑都是对同一死锁再赌）/`CONTEXT_OVERFLOW:`（0070 实撞:压缩降级后仍超窗,重试追加反馈请求只增不减——根因是材料总量非本轮生成选择）/`fail_kind==='deterministic'` 枚举（产错方显式标记,含 SCHEMA_MISMATCH 确定性档——body 同输入同产出）。**步级瞬态（乙案免预算重试）**=`OUTPUT_TRUNCATED:`（0037 本案:输出超长绑定本轮的生成选择,下轮反馈工单变了输入就变——"禁整篇重写"教条正是下轮的新输入）/`THINKING_EXHAUSTED:`（反刍绑定本轮输入形态,下轮带新反馈输入已变）。
      > **fail_kind 域扩枚举**：'lack_of_info' | 'error' | 'deterministic'——渐进迁移:先前缀口袋兜住存量,产错方逐步改标 deterministic（新错误产生点用枚举,前缀是存量过渡）。
      > **adaptive 不豁免**：重规划改的是结构,DEPTH_EXCEEDED 这类资源墙不因结构微调而消失;CalleeFailure 的根因在子 spec 内,父层重规划够不着。真要换法子=人工改 spec,不是烧 API。

  3.2. [case] subtask 有 retry 配额，且（无 adaptive，或 adaptive 但为首次失败）
    3.2.1. [act] 消耗一次 retry，重置 subtask 所有 children 为 pending（带反馈重跑）
      - ← parent_subtask, failure_reason
      + → action, next_context
      > action = 'retry'，next_context 含重置后的 subtask 状态。
      > **升级阶梯首级**（见 [[../concepts/HopSpec V3核心规范#^anc-exec-retry-adaptive]]）：`retry=N` 是总失败预算。
      > 无 adaptive → 每次失败都走本级（机械重跑相同结构）。
      > 有 adaptive → **仅第 1 次失败**走本级（带反馈重跑：重跑相同结构，但失败说明经 L2c 注入重跑上下文，见 [[prompt-assembler#^anc-exec-l2c-retry-feedback]]），第 2 次起升级到 3.3。判级依据=已用次数（attemptsUsed = retry_max − retry_remaining）：首次失败时 attemptsUsed==0。
      > **变量策略（Python 语义，2026-07-04 改；2026-09-07 补两例外）**：重置 children 为 pending 时**不清空 child 输出变量**——变量自然保留（见规则 6）。重跑步骤会用新产出覆盖旧值（complete_step 同名 merge）；需在重跑前确保清空的量，由作者在子步骤显式 `+ → x = Null`。两个例外（都不是用户变量语义的破口）：**带 `= 初值` 声明的容器重灌**（重跑=重新进入,初值按字面重新执行——见规则 [[#^anc-exec-output-init-reentry]]，作者显式写了初值即声明"每次进入从初值开始"）；**引擎收集账随 loop 进入清空**（collect 列表与 `__reaped_` 缓冲,清空点在 loop 入口不在重置路径——见 [[#^anc-exec-collect-ledger-reset]]）。原"清空 subtask scope 所有 child 输出"逻辑已从 `resetSubtaskForRetry` 删除（它与 loop 二分同源，属已废除的引擎隐式清空）。
> **重试反馈受众收窄（hopissues/0073,2026-09-09——治 stale 工单污染后续步骤,单管:只收窄注入受众不删账）**：实撞=step 1.1 一次重试成功后,同容器 1.6.1/1.8.1 等首跑步骤的 prompt 全带"此前已被打回过的意见"stale 工单——受众错位（重试反馈的语义是"重做的活要保持已落实的修正",首次执行的步骤没有旧活可保持）。**注入侧受众判据**——getActiveRetryFeedback 只对"重跑参与者"注入:本步 step_start 事件≥2 次（失败轮+重跑轮,含容器重置连带重跑的兄弟步）,或本步自己有失败记录（首轮失败当轮反馈）,或本步有 escalate 升层史（人给的指引正是重跑要吃的——升层反馈借道本通道,豁免防误伤）;三者皆无=纯首跑,返 undefined 不注入。**retryHistory 账本身恒不删**（修复批曾试"容器成功清账"纵深管,全量回归撞 D39 跨层反馈钉红后裁定删除——外层意见轮失败重跑时,内层容器已成功收场的旧机械史正是反馈里的"别再犯清单",清账即断 D39 分层通路;失败史上浮给 caller 的诊断料〔exportFailState〕同赖此账。**既有例外一处**:串行退化 parallel 的就地消化路径按"预算按迭代独立"清该容器账——那是迭代边界的预算语义,不是本条款管的反馈生命周期）。与 0072 批的分工:resetSubtaskForRetry（重试路径）与 loop 入口清（收集账）都不动——本条只动注入侧受众判据,账的生命周期零改动。
> **收集账进入即清（2026-09-07 作者拍"loop 一旦执行,其 collect 操作是清空初值的"收敛定稿——取代原'聚合账例外'的来路枚举式条款）**：collect 收集账两本——collect 列表私有缓冲（串行轮次收）与 `__reaped_<listVar>` 收割缓冲（parallel 派发收）——**都不是用户变量,是引擎按结构代管的账**。清空点恒为 **loop 入口一处**：loop 每次进入执行,两本账一并置空,首跑/retry 重跑/replan 换结构重跑/外层轮进重入一律如此,不区分来路。收敛史:0072 批曾在 resetSubtaskForRetry 打来路补丁、三板批在 submitReplan 再打一个（各治了实撞:G244 收割残账在 finalize 归并 1→2→4 逐轮翻倍,check 拒重复账而重复正是重试注入的,自激死锁）,作者点破来路设卡的病——语义要枚举来路陈述,新增重跑路漏打补丁即下一个 G244;入口清一处兑现后,原三条边界自然消失（on_fail 豁免:兜底 loop 被重新进入账当然从空开始,没被重新进入没人动它的账;scope 缺席边界在入口清模型下**不可达**——扁平命名空间重构（2026-08-09）后 getWriteScope 恒 root,ensureScope 的父 scope 判据恒成立,loop 进入必建 scope（两批 review 实测核证:worker 窄执行下收集照常走,ensureScope 注释里"父容器 scope 不建"是重构前旧文）;入口清仍带 hasScope 守卫但定性为**防御性冗余**——它防的是 write 落点"scope 缺席回退 root"的机制性风险面（ast-runtime write 的 ?? root 回退是真实语义,将来 scope 创建时序若变,无守卫即静默覆写 root 同名变量+泄漏引擎键）,现行不可达故无测试钉（死代码场景不配钉,配了是假绿）——两笔清账同守卫;两条重跑路枚举:不再需要）。入口清比来路清更严:晚到的旧轮收割喂账（重置之后、重新进入之前落账的）来路补丁罩不住,入口清天然罩。用户变量照旧保留,两账界线=是否由引擎聚合机制写入。 ^anc-exec-collect-ledger-reset

  3.3. [case] subtask 有 retry 配额，adaptive，且非首次失败（attemptsUsed ≥ 1）
    3.3.1. [act] 消耗一次 retry，组装 adaptive 上下文（重规划结构）
      - ← parent_subtask, failure_reason
      + → action, next_context
      > action = 'adaptive_replan'，next_context 含 subtask 契约、原 children、失败历史。
      > **升级阶梯次级**：第 1 次带反馈重跑（3.2）仍失败后，第 2 次起换结构重规划。便宜的先试、贵的后上。

  3.4. [case] subtask retry 配额耗尽
    3.4.0. [branch] 先看失败兜底（[on fail],概念 [[../concepts/HopSpec V3核心规范#^anc-step-on-fail]],2026-08-21 作者立;**2026-09-04 激活语义三处改定**〔0037 实撞取证:兜底两次被"激活"但一步未执行,8h 整树重建——死法①激活被兄弟步正常重试的 resetSubtaskForRetry 冲掉/死法②"已激活"被误判"已兜过底"拒绝二次激活直接上浮;决策档案 20260904-确定性错误免预算不提前兜底.md 联动〕） ^anc-exec-on-fail
      > **激活条件**：容器声明了 on_fail 子节点（末位）且**尚未消耗**（onFailConsumed 持久化集判——**激活≠消耗**:激活=执行流转入兜底,消耗=兜底子树真实走完;旧形态单集 onFailActive 身兼两职,"已激活未执行"被当"已用过"拒绝再激活,兜底一步没跑就被判用完〔死法②〕。已激活未消耗时重复激活幂等返回 true——执行流本就该在兜底里）。
      > **激活动作四样（第四样 2026-09-04 补——"执行流转入"的机械兑现）**：on_fail 子树置 pending、登记 onFailActive、容器保持 running、**容器内 on_fail 之前仍 pending 的常规子步全部标 skipped**——旧形态只做前三样,"转入"押在 DFS 顺序上,失败点在中位步时 DFS 先跑其后的 pending 常规兄弟步（0037 实况:激活后先跑 .3/.4/.5,兄弟步再败触发正常重试反把激活冲掉〔死法①〕）;标 skipped 后 DFS 下一步必达兜底首步。失败步自身保持 failed 不动;后续容器若重试,resetSubtaskForRetry 整树置 pending 照常复活 skipped 步,与既有重试语义自洽。
      > **重试清理的兜底豁免（死法①根修）**：resetSubtaskForRetry 的嵌套预算/激活标记复位遍历,**跳过本容器直属的 on_fail**（只清嵌套边界的——外层重跑给子树全新一轮,内层容器的兜底标记该清;本容器自己的激活/消耗状态由本容器的失败处置链管,兄弟步重试无权动它）。原注释"本容器自身的兜底标记不清"语义正确,代码遍历从 children 起未设防——本条为注释的机械兑现。
      > **兜底步失败上下文供给**：激活态 on_fail 子树内步骤的上下文多一段失败记录（哪步/几轮/原因）——供给契约归 [[prompt-assembler#^anc-exec-onfail-context]]（todo/0078,激活语义本节不因它改动）。
      > **接住语义（2026-08-21 作者定:on fail 后 fail 不再向父传播）**：兜底块正常走完 → 容器按 done
      > 收场（propagate 对含 failed 常规子步但 on_fail done 的容器判完成）、主线继续;块内 + → 给容器
      > 输出赋兜底值。**兜底块自身失败 → 不再兜**（无嵌套 catch）:容器 markSubtaskFailed 直接上浮。
      > **正常路径零成本**：常规执行流遇未激活 on_fail 节点整树标 skipped（dfs 跳过——它不是顺序步骤,
      > 是失败路径专用块）。
      > **与 commit 退火的交互**：退火边界 retry/adaptive 失效,但**兜底照走**（退火拦"重跑重放",兜底是
      > 善后不重放）——退火边界的失败跳过 retry 阶梯直达兜底激活;兜底也没有/已用 → 照旧穿透上浮。
      > 祖先查找配套：findNearestSubtaskAncestor 的退火跳级只跳"无未激活兜底"的退火边界。
    3.4.1. [act] 无兜底（或兜底已用）→ 标记 subtask 为 failed（值空间不动——fail 不碰值空间）
      - ← parent_subtask
      + → action, next_context
      > 递归触发 fail_step 处理 subtask 本身（容器作为"一个步骤"找外层事务边界；嵌套内层 retry 计数随外层重跑复位）。递归到顶仍无边界 → 3.1 未捕获失败，实例终止。
      > action = 'propagate'，next_context 含 subtask 的 FailRecord

4. [exit] 返回失败处理决策
  + → action, next_context
```

---

## 变量命名空间【契约】

HopSpec 变量对标 **Python 函数级作用域**（概念 [[../concepts/HopSpec V3核心规范#^anc-exec-loop-var-scope]]，2026-08-09 作者定）：**一份 spec 的一次执行 = 一次函数调用 = 一个扁平命名空间**。subtask/loop/branch/case 是控制流块不是作用域——块内 `+ →` 就是写实例命名空间里的那一个变量，嵌套深度不影响落点。**同名 = 同一个变量**（V2 唯一性）。 ^anc-exec-variable-store

> **历史修订（2026-08-09，块级作用域废除）**：原设计"每个容器创建子 scope、写落最近容器、读自底向上"是引擎的过度设计——它引入了 Python 没有的块作用域，制造"隐式影子变量"（深层写悄悄落中间容器、容器外读不到），与 V2"同名=同一变量"自相矛盾。三份实跑报告（hopkb construct 三连撞 / 8k primer B1 自引用崩溃 / primer-H for-each 累加器误杀）全部源于此。废除后 getWriteScope/树状 scope 链/V3 遮蔽检测一并退役。

### 命名空间边界（仅两处，对应 Python 既有概念）

| 边界 | Python 对应 | 数据传递 |
|---|---|---|
| `call` 子 spec | 函数调用 | param_mapping 传参（父→子）、output_mapping 接返回值（子→父）；查找不穿透 |
| `parallel` worker 子实例 | 独立进程 | params_for_child 显式传入；join 收集同名输出为列表落父空间 |

### 规则

1. **读写同一张表**：`← var` 直接读实例命名空间；`+ → var` 直接写同一张表。无链式查找、无提升、无遮蔽。
2. **容器头 `+ →` = 导出契约（纯静态）**：约束"外部只引用容器声明的输出"（validator/文档视角的接口纪律），**不是存储隔离**——运行时无"提升"动作（值本来就在唯一命名空间里）。branch 统一接口、case 同名填充语义不变（同名本就是同一变量）。
3. **for-each 收集（引擎归并操作，collect 子句驱动）**：**判据是 `LoopStep.collect` 子句**（`collect <unitVar> into <listVar>`，2026-08-09 作者定显式化——原类型驱动判据"头 [T] 无初值"存在同名异型裂缝，同日废除）。引擎在命名空间里为 `listVar` init `[]`，每轮结束把 `unitVar` 槽的本轮值 append 进 `listVar`、`unitVar` 槽复位 null（防 skipped 轮重收；传送带语义：child 产出放上、引擎运走）——显式归并，不是作用域提升。break/failed 得部分列表。**collect 之外的容器头输出一律普通变量**：末值导出（同 subtask，引擎零动作）或累加器（带 `= 初值`，init-once + 更新模式）。三种导出并存，并行形态仅收集（S13）。
4. **parallel 汇聚只有收集列表一种语义**：join 读各 worker 子实例的容器同名输出，按 child 声明序组装列表落父空间；**失败 child 不贡献元素**（2026-08-09 作者定：列表本就乱序、槽位无归属，填 None 也不知道是谁的——部分失败 = 列表变短）。**parallel 容器头声明累加器（带 `= 初值` 输出）为静态错误**（新规则 S13）——workers 无共享空间可累加，要 reduce 在 join 后自己写。**全灭 warn（2026-09-01 补,可见性不改行为）**：并行 for-each 收口时派发数 > 0 且成功收集数 = 0 → recordWarn 落账（"[collect] 派发 N 全部失败,收集列表为空——下游按空列表继续"）——集合语义照旧（作者显式接受的"列表变短"极端形态就是空表）,但 5/5 全灭与 0 派发在账面上原不可分辨（doc-review 第十六次实撞:launch_receipts=[] 静默收编,步 27 照记 done,下游步 28 才诚实判出 0 可用——引擎账早一步可见,排障少烧一轮）。落点=settleHostAfterReap 收口单点。
5. **retry = Python 循环的简化写法**（`for attempt in range(N)` 语法糖）：重跑在同一命名空间自然覆写，上轮残留可读——如何利用错误经验（读残留/带反馈重做）是 spec 作者的表达空间，引擎不清不滚。
6. **`= 初值` 求值时机** ^anc-exec-output-init：
   - **容器节点**带 default → **每次块进入时 init**（hopissues/0050,2026-08-31 作者拍 A——"容器进入时求值写入"按字面兑现）。三种时刻的边界逐一说清：
     - **同一 loop 自己的轮间**：不重灌（轮不是"进入"——累加器跨迭代保值,这正是累加器语义本体）;
     - **任何"重新进入"都重灌**（判据一句话:容器从头再跑=新的一次进入,带 `= 初值` 声明的按字面重新 init）。三种进入形态同判:**外层容器轮进导致的重入**（0050 批修,hopkb 实撞:上一外层项残值静默漂进下一项污染落盘）/**subtask retry 带反馈重跑**（2026-09-07 作者拍"=初值 就是进入循环时执行"定性修 bug——原特判"重试是同一次进入的重做不是新进入"删除:探针实证 retry=2 内 loop 头 `findings=[]` 不重灌,第一轮 2 条重跑攒到 4 条,与 collect 翻倍同病;跨重试想留值=不写 `= 初值` 靠自然保留,失败反馈正道=check note 经 L2c 注入）/**adaptive replan 换结构重跑**（换了结构更是新进入,与板二聚合账清理同批）。机制统一:三条重置路径（外层轮进 resetChildrenToPending / retry resetSubtaskForRetry / replan submitReplan）都保证带 `= 初值` 声明的容器在重新进入时重灌——外层轮进与 retry 两路删**子树内带 default 容器**的 scope（清的是子树,容器自身的重灌归处理它失败的外层管;不带 default 的容器 scope 不碰——写初值即表达"每次进入从初值开始"的意图,其余变量 Python 自然保留大原则一律不动）;**replan 路清场更宽:对旧 children 一律删 scope 不筛 default**（2026-09-07 两批 review 面二实抓同号残 scope 压制:旧结构不带 default 的容器执行过即有 scope〔ensureScope 对一切容器建 scope 不看 default〕,replan 后新结构同位容器必然同号,若新容器带 = 初值,残 scope 让 init-once 判据误判"已进入过",初值永不写——旧结构退场即整体清场,残 scope 本无人消费,删了才是干净退场;清场须在旧 children 摘除前做,定位靠旧结构）。**跨进程 resume 不重灌**（vars.json 恢复=同一次进入的续跑,不是重新进入）。**on_fail 子树的重灌边界随路径分叉（各有法理,不是统一豁免）**：retry 与 replan 两条重跑路对 on_fail 子树**豁免**（不下钻不删 scope——兜底是本容器失败处置链的资产,其内累积归兜底自身的激活/消耗链管,主链重跑不碰,与聚合账清零的 on_fail 豁免同规）;外层轮进路径**不豁免**（新一圈连兜底激活/消耗标记都重置为全新可用,兜底内旧累积对新圈无意义,带 default 的照删照重灌——与该路径清嵌套层兜底标记同法理）。 ^anc-exec-output-init-reentry
   - **叶子步骤**带 default → 该步**每次 becomes-running 时**写入（loop 内每轮执行即每轮重置，Python `x=None` 语义）。
7. **变量自然保留** ^anc-exec-loop-var-scope：跨迭代、跨重试不自动清空（落地概念同名锚点）。`continue`/`break`/`exit` 仅控制流转不清变量。残留由作者 `= 初值` 显式管理。唯一例外=引擎收集账（collect 列表私有缓冲与 `__reaped_` 收割缓冲,随 loop 进入清空——不是用户变量,清空点在 loop 入口不在任何重置路径,见收集账进入即清条款 [[#^anc-exec-collect-ledger-reset]]）。
8. **隐式变量**：`instance_id`（init 写入）、`parent_instance_id`（仅 call 子实例）、`step_id`/`loop_index`（仅内存，随 context 注入不落盘）。

### 存储实现

`VariableStore` 退化为按边界分实例：每个执行实例（顶层/call 子实例/parallel worker）持一张扁平 Map；vars.json v2 的 scope 树格式保留兼容读取，写侧收敛为单 root scope（历史多 scope 文件 resume 时合并展平，同名以最深层为准——它是最后写入者）。

## 执行策略【说明】

> 本章描述 Parallel/Call/Adaptive 的执行细节。其中的关键决策（Parallel v1 顺序模拟、熔断常量）已上提到"关键设计决策"章。

### 串行 for-each 执行（loop for-each 无 parallel 属性）【契约】 ^anc-exec-foreach-serial

概念层 `^anc-step-loop` 定义 for-each 为 loop 的驱动形态、parallel 为正交属性——**串行 for-each（去掉 parallel）是合法形态**，引擎按列表长度驱动（区别于条件循环按 max_iterations 驱动；2026-08-07 review 抓出该形态"校验绿但不可执行"后补实现）：

- **入口**（dfsNextStep 标 loop running 时）：从 root 读 `listVar` 全列表；**收集账两本一并置空**——collect 列表私有缓冲 init 为 `[]` 写 loop scope、`__reaped_<listVar>` 收割缓冲同点清 null（2026-09-07 进入即清收敛,[[#^anc-exec-collect-ledger-reset]]——此前收割缓冲不在入口清,靠 retry/replan 来路补丁,漏路即翻倍;两笔清账带 hasScope 守卫——防御性冗余,现行不可达〔进入必建 scope〕,防 write 落点 ?? root 回退的机制性风险面）；单项槽哨兵复位；空列表 → loop 直接 done、children 全 skipped、root 收集列表为空；否则 `loopCounters=1`、`itemVar = list[0]` 写入 root。
- **迭代推进**（propagateCompletion loop 分支）：本轮 children 全 done/skipped → 把本轮单项值 **append 进 loop scope 私有缓冲**（进行式收集,终态经 finalizeForEachCollect 与收割缓冲归并写回 root——2026-08-09 扁平重构后的实况,原"父 scope"措辞随本批校准），未耗尽则 `itemVar = list[i]`、loop scope 收集槽写 null 复位（防 skipped 轮把上轮残值再收一遍）、children 重置 pending；耗尽 → loop done。**children 重置=新迭代全新事务（2026-08-21 补配,与派发路径『重试预算按迭代独立』〔[[parallel-execution]] 三条实现契约③,2026-08-11〕同语义——串行路径此前漏配,二次复审探针实抓:轮 1 耗掉的预算漂进轮 2 首败即死）**：复位子树 retry 预算（retryCounters 清）+ 清子树 on_fail 兜底激活标记（轮 1 用过兜底,轮 2 耗尽重新可兜——[[#^anc-exec-on-fail]]）;resetChildrenToPending 单点承载,条件循环迭代同享。**commit 退火记录不在此清单**（2026-09-02 判据重构撤除 0061 批的清理项——记录永续,轮内边界不被前轮记录焊死改由轮次比对承担,外层边界对前轮 commit 照样退火,见 [[#^anc-exec-commit-anneal]]）。**读取本轮输出值必须只读 loop scope 本地（`readLocal`），禁止沿作用域链上溯**——本地无值（如中间容器未声明同名输出、提升链断）→ 收 `null`；上溯读会在嵌套同名累加器场景撞到父 scope 收集列表自身，`acc.push(acc)` 自引用后 JSON 持久化炸 circular、递归遍历炸栈溢出（2026-08-09 hopkb construct 实撞 B1/B2 同源：break 退出路径炸 circular、迭代耗尽续轮路径炸 stack overflow）。push 前另有同引用兜底防御（`v === collected → null`）。
- **进行式收集的理由**（缓冲住 loop scope、终态写回 root——原标题"落父 scope"是 2026-08-09 扁平重构前旧文,随本批校准）：①进行式收集使 **break 天然得到部分列表**（概念 `^anc-step-loop`：串行中途 break 时为已完成迭代的部分列表）——终态时不需要"从迭代历史重建列表"；②跨进程 resume 靠 vars.json 恢复即续收，**无新增持久化状态**。代价：propagateCompletion 的通用容器输出提升对串行 for-each **跳过**（loop scope 里是最后一轮的单值，通用提升会覆写列表——代码有显式排除）。
- **itemVar 作用域**：绑定在 loop scope（子可见、外不可见），与 parallel 形态的 params_for_child 注入语义等价（S12 保证串/并等价的前提在串行侧的对应物）。
- **branch 静默跳过的级联**（本实现撞出的既有缺陷，两形态共享修复）：branch 无 case 命中静默 done 后**必须 propagateCompletion 并让 dfs 返回 retry 重遍历**——否则 branch 为容器最后一个 child 时父容器永不完成（loop 不迭代、泄漏执行后续步骤）；且级联可能已推进 loop 下一轮并重置兄弟步骤，当前遍历栈继续下钻会用新一轮变量误评估，必须重遍历。

### Parallel 执行（v1 顺序模拟 / v2 复用模式真并行）【契约】

#### 底层语义（两模式共用）

`parallel` 容器进入 running 后，所有 children 标记为 pending。child fail 时：标记该 child failed + 输出 None，**不阻塞其余 children**（符合核心规范 parallel 语义）。全部 children 终态（done 或 failed）后 parallel 容器完成，聚合输出。

**fail_step 与 parallel 的交互**：parallel 容器内 child fail 触发 fail_step 时，fail_step 不查找 subtask 祖先（parallel 不是 subtask），而是将该 child 标记为 failed + 输出 None，其余 children 继续。只有在 parallel 容器自身完成后（所有 children 终态），如果 parallel 被包含在某个 subtask 内，由 subtask 级别判断是否触发 retry——取决于后续步骤能否容忍部分 None 输入。

#### v1 顺序模拟（独立模式 / 复用模式 parallelMode 关闭）

`dfsNextStep` 按声明顺序依次返回每个 pending child，每个 child 完成后返回下一个。`nextStep` 默认行为，**不受 v2 改动影响**——这是独立模式 dispatcher 的零回归保证。

#### v2 复用模式真并行【契约】

仅当 `EngineOptions.parallelMode=true`（CLI `run`/`submit_and_fetch_next` 置）时启用。三个机制锚点：

**① 批量就绪** ^anc-exec-parallel-batch

> **废止注记（P0.5 旧通道退役，本段保留作沿革）**：本段描述的 fan-out 探测通道已从代码删除——`collectParallelBatch`/`nextParallelBatch` 均不复存在（src/engine-traverse.ts:286 与 src/engine.ts:1657 的注释自陈删除；engine.ts:1522-1523 记录 advanceToCaller 不再先探批）。现行并行派发机制见 [[parallel-execution]] §U7 统一派发门：`unifiedDispatch` 开启时由 `nextStep` 产 `dispatch_ready` 交 driver、派发即入账（inflight 名册）。复用模式在 P0.5→P2 之间的该窗口内 parallel 标注退化为串行下钻——S12（children 无依赖）保证串/并等价，退化不影响正确性。

复用模式下，引擎经 `collectParallelBatch` 识别**最外层 running/pending parallel**，一次性批量吐出其所有 pending 直接 children（容器），封装为 `parallel_ready` 响应（[[hop-cli#^anc-cli-parallel-ready]]），附各 child 的子实例目录、引擎自动解析的入参、并发上限。**前置守卫**：parallel 容器的前序 sibling 必须全部终态才 fan-out（防前序未完时提前扇出、child 读到半成品输入——代码先行，2026-08-08 审计回写）。独立模式不产出此响应（`parallel_ready` 仅 `can_fanout` 路径出现；`nextStep`/`dfsNextStep` 默认仍单步串行返回，保护 dispatcher `executionLoop` switch 不落空）。

**④ 一层并行/嵌套退化** ^anc-exec-parallel-one-layer

DFS 下行携带 `inParallelContext` 标志——遇 running/pending parallel 且 `!inParallelContext` 即最外层，批量收集其 children 返回；进入该子树后置 `inParallelContext=true`，内层再遇 parallel **不扇出**（退化顺序模拟）。S12 保证 children 无依赖→串/并等价，退化不影响正确性。嵌套 parallel 不报错、不需新 validator 规则。

**⑤ child 入参自动解析** ^anc-exec-parallel-child-params

引擎从父 scope 按 child 容器子树全部后代的 `← ` 输入声明解析出 `params_for_child`（收集子树外部依赖的变量值，同名取值），放入 `ParallelReady.children[].params_for_child`。driver 无需构造——节奏归引擎，控制流不归 LLM。子树内部产出的名字排除（来自内部步骤，非外部入参）。

**同步落盘供 worker 回填**：fan-out 时引擎除把 `params_for_child` 放进响应（agent 通道，worker LLM 可看到任务入参，经 deflate 命名空间隔离，见 [[shared-types#^anc-exec-deflate]]）外，还把每个 child 的完整 `params_for_child`（**内部真值，不 deflate**）写到该 child 的 subinstance 目录 `parallel/<child_step_id>/params.json`。worker 起 `run --parallel-parent <pid> --parallel-child <cid>` 时其子实例目录即此路径，init 按自己的 cid 读取文件，把全部缺失键注入 root scope；显式 `--params` 键优先。静态 parallel 的外部输入与 for-each 的 itemVar 均走这条统一通道（见 [[parallel-execution#^anc-exec-parallel-foreach-worker]]）——**driver 无需透传 `--params`**。这是"节奏与数据归引擎、driver 是哑搬运体"的贯彻：连搬运都省了，引擎直接备料到 worker 的落点。

**② 子实例隔离** ^anc-exec-parallel-subinstance

每个 parallel child 容器在 `.hopstate/<inst>/parallel/<child_step_id>/` 独立子实例运行（类比 call 子实例 `calls/<call-step-id>/`）：

- 子实例 instanceId = child_step_id（如 `2.1`），`parentInstanceId` = 父 inst，trace_id 继承父 run。
- worker 内部是**完整的串行子驱动循环**（标准 run → submit_and_fetch_next）——因 parallel child 一定是容器（决策 6），worker 顺序跑完整个容器子树，产出容器聚合输出。
- N 个 worker 各写各自子目录的 state.json/vars.json，**跨进程天然无竞争**。
- **scope 掩码**（`executeSubtreeOnly`）：worker 子实例持有同一份父 spec，init 时子树+祖先链以外的步骤全预标 skipped，祖先标 running，子树保持 pending。引擎从 running 祖先递归进入子树，只为子树步骤组装上下文、发 StepReady。
- **未赋值声明输出=完备性违约判 failed**（2026-08-17 概念层改判随落,hopissues/hoplogic3/0001——原 warn 照发 completed:"completed 零产出"假绿混进全链强信号,下游〔driver FINAL/台账/批量收割〕每层被骗,父层 reap 才炸 CALL_OUTPUT_MISSING 离病灶隔一层）：终态收尾 `collectOutputs` 读到声明输出为 null/undefined 且非 subtreeRoot → run 判 **failed**,failure_reason=`Output "X" declared in Outputs but never assigned`（多个缺失全列）,partial_outputs 照常携带已产出部分（fail 不碰值空间既有语义）。**两豁免**：①worker 子实例（`subtreeRoot` 有值）——只负责子树,父 spec 顶层 Outputs 由父实例 join 后检查;②**无 Steps 的能力声明 spec**（HopTrait 形态）——与静态闸 P10 同律豁免:没有步骤就没有兑现义务,Outputs 是能力接口声明非执行承诺。 ^anc-exec-output-completeness

**⑥ can_fanout 环境标识** ^anc-exec-parallel-canfanout

`can_fanout` 是持久化的 **agent 环境属性**（进 StateFile），标识当前 agent 是否允许 fan-out：
- 顶层实例 `can_fanout=true` → `advanceToCaller` 探最外层 parallel、吐 ParallelReady
- worker 子实例 `can_fanout=false` → 不探 parallel，内层 parallel 退化串行（一层并行约束自动满足）
- 独立模式 dispatcher 不置（可执行循环 switch 无 parallel_ready 分支）

替代原"每命令 parallelMode flag"——worker submit 从 StateFile 恢复 can_fanout=false，不会误置 true 导致内层 fan-out。语义上是通用 agent 环境标识，未来无依赖子步骤自动并行化时复用。

**③ join barrier + merge** ^anc-exec-parallel-join-merge

全部 worker 子实例终态（completed/failed）后，由**单进程** `join_parallel <parallel-step-id>` 命令触发父引擎收集 merge（规避 N 进程并发写父态的丢更新）：

- 遍历 `parallel/<child_id>/` 各子实例 vars，按 parallel 容器声明的 `+ →` 聚合输出**同名提升** merge 回 parallel scope（照搬 `completeCallStep` 模式，差异：N 个子实例 + 按容器声明同名取值 vs 单 call 子实例 + output_mapping）。
- child 子实例 failed → 该聚合输出名写 None（沿用底层 fail 语义）。
- 全部处理后 `propagateCompletion` 标 parallel done，聚合输出提升到父 scope，继续 `advanceToCaller` 推进到下一个 caller 介入点。
- **for-each 分支**（[[parallel-execution#^anc-exec-parallel-foreach-join]]）：for-each parallel 的 children 是运行时合成 ID（`{P}.1`…`{P}.N`），spec 里只有一个模板。join **必须遍历 childResults 全部合成 ID**（不是 `getChildren` 的单个模板），按 parallel 列表输出 `+→ X: [T]` 收集各 child 的同名 `X: T` 成列表（按序号），全部合成 ID 标终态。漏遍历会导致只 join 第一个 child + 列表类型破坏。

**join 前置不变量（健壮性硬校验，非 driver 自觉）** ^anc-exec-parallel-join-preconditions

join 把 worker 子实例结果 merge 回父态——若收集到的结果不可信（worker 还在跑、状态文件损坏），merge 出的父态就是脏的。这三条前置不变量从"靠 driver 等齐、靠文件总是合规"的软假设升级为引擎/CLI 硬校验。**载体沿革（2026-09-12 0088 批如实注）**：三判据原实现载体 join_parallel CLI 命令已随 P0.5 统一派发模型退役——现行承载:判据 1 的期望集核验由 inflight 派发账面替代（引擎按账收割,不再事后算期望集;listVar 非数组的响亮报错前移到派发期）,判据 2 由 reapFromChildDir 经 readState/readVars 的 parseChecked 承载（原样有效）,判据 3 的单 child 隔离由 reap 逐 child 收割形态天然承载（单 child 收割失败合成 failed 不连累兄弟）。判据语义三条全部存续,承载点位随 P0.5 迁移：

1. **完整性 + 终态校验**：join 收集前先算**期望 child 集**——for-each 是 `listVar` 长度对应的全部合成 ID（`{P}.1`…`{P}.N`），静态 parallel 是 spec children。对期望集逐一核验：(a) 子实例**缺失**（for-each worker 未启动，连子目录都没有）或 (b) 子实例存在但含 `running` 步骤 → 拒绝 join，返回 `INVALID_STATE`。**关键**：未启动的 for-each worker 没有子目录，单靠"扫已存在目录"会**静默漏掉**它们让 join 残缺 merge——必须按期望集核验而非只扫现存目录。这把"driver 必须等所有 worker 返回才 join"（[[parallel-execution#^anc-exec-parallel-fanout-model]] §8a 的 driver 协议软约束）变成 CLI 硬拦截——driver 提前/漏 join 不再产生残缺 merge，而是响亮失败。与 `completeStep` 的 `state === 'running'` 前置校验同philosophy。（静态 parallel 的 child 因含 confirm 退串行而无子实例目录属合法缺失，跳过不拒绝——其状态在父 state 串行推进。）
   - **`listVar` 非数组必须响亮报错，不静默算 0**（纵深防御）：算期望 child 数时读 `listVar` 值，**若它不是数组**（如被 deflate 成 `@file`/`$file` 指针字符串、或上游谎报）→ 拒绝 join，返回 `INVALID_STATE` 并指明 listVar 名与实际类型。**禁止 `Array.isArray(v) ? v.length : 0` 的静默降级**——那会把"listVar 坏了"伪装成"0 个 child"、产出空 join，故障漂离源头。虽然上游列表类型校验（[[#^anc-exec-output-schema-check]]）已在源头挡住谎报，此处仍独立硬校验（不同进程、不同层，纵深防御，绝不靠单点）。
2. **状态文件格式校验**：`readState`/`readVars` 读子实例 state.json/vars.json 时校验 `format_version`（state 按 [1] 白名单；vars 按 [1,2]——v2 即 scopes 树迁移后形态,见 [[persistence]] 迁移记）+ 关键字段存在（state 须有 `step_states` 对象、vars 须有 `variables` 或 `scopes` 对象——多候选键与版本白名单系 v1|v2 兼容细化,parseChecked 公共件承载;2026-09-12 0088 批判据字面随实况归一,原文停在 vars v1 时代）。不符 → 抛带文件路径的明确错误（`CORRUPT_STATE_FILE: <path>`），而非裸 `JSON.parse(...) as StateFile` 后续 `Object.values(undefined)` 的晦涩 TypeError。版本化文件契约（types.ts `format_version: 1`）从"写了没人读"变成"读时强制比对"。
3. **单 child 读失败隔离**：CLI join 收集阶段对**每个** child 的读取用 try/catch 包裹——单个子实例目录损坏/文件不可读 → 该 child 标 `failed`（聚合输出写 None，沿用底层 fail 语义），**不连累其余 child**，不让一个坏文件炸掉整个 join。与"worker failed 不阻塞其余"同构。

> 三条共同保证：join 的输入要么是全部可信的终态结果，要么是定位清晰的失败（拒绝/标 failed），**不会出现"脏数据静默 merge 进父态"**。

**⑦ worker 提示词组装** ^anc-exec-parallel-worker-prompt

worker 子实例走**现有 PromptAssembler 同一套 L1-L6**（不发明新组装器），但 task_context 因 `subtreeRoot` 做两处裁剪：
- **L1 骨架裁到子树视图**（`buildSubtreeSkeleton`）：只渲染 worker 负责的 child 子树 + 父 parallel 一行身份标注（"你负责 X 分支，与其它分支并行执行，无需关心兄弟"）。兄弟分支被 skip 且 S12 禁止跨分支引用，给 worker 看是噪声。
- **task_context 头部显式承载子任务目标契约**：child subtask 的 summary + 聚合输出声明 `+→`（即"你要交付什么"） + 继承的 spec constraints。
- L3/L4/L5/L6：因 step_states 子树外全 skipped，自然只为子树内步骤组装——**无需额外处理**。

> **实装状态（2026-06-16）**：v2 复用模式真并行。新增 `collectParallelBatch`（engine-traverse）/`nextParallelBatch`/`joinParallel`（engine）；CLI `run`/`submit_and_fetch_next` 置 parallelMode、`init --parallel-parent <id> --parallel-child <stepId>` 建子实例于 `parallel/`、新命令 `join_parallel`。fan-out 与 worker 池排队由 driver 适配层（hopspec-skill.md / AGENTS.md）实现，引擎不绑并发原语。
> **里程碑分期（v2 计划，非债）**：(1) 独立模式真并行未做——dispatcher 保持顺序模拟，经 parallelMode flag 隔离（属 `v2 计划`：独立模式能力，[[roadmap#v2-1 独立模式（引擎自驱）]]；判据见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-milestone]]）；(2) worker 内 lack_of_info 因隔离边界当时只能 fail，由 driver 在 join 阶段按 fail_kind 拢起→HITL 补充→重派；(3) 嵌套子实例目录寻址（worker 内子树再嵌容器）由决策 3 一层并行削减，worker 内 call 走子实例目录。

### Parallel 子实例目录布局【契约】

v2 复用模式真并行中，每个 parallel child 容器在独立子实例目录运行（[[#^anc-exec-parallel-subinstance]]），布局类比 call 子实例：

```
.hopstate/<inst>/
  state.json, vars.json, spec.json        # 父实例
  parallel/                                # parallel 子实例根（类比 calls/）
    2.1/                                   # child_step_id=2.1 的子实例
      state.json, vars.json, spec.json
    2.2/                                   # child_step_id=2.2 的子实例
      state.json, vars.json, spec.json
  calls/                                   # call 子实例（已有）
    <call-step-id>/ ...
```

**与 calls/ 的差异**：
| 维度 | `calls/<call-step-id>/` | `parallel/<child-step-id>/` |
|------|------------------------|----------------------------|
| 子实例数 | 单个（一个 call 步骤一个子实例） | N 个（一个 parallel 的每个 child 一个） |
| 创建时机 | call 步骤执行时 | 批量就绪后 driver fan-out 时 |
| 输出回填 | 按 `output_mapping`（子output→父var） | 按容器声明 `+ →` 同名提升 |
| 回填命令 | `submit --child-instance`（单步） | `join_parallel`（单进程批量 merge） |

### Call 执行模型（子 Spec 调用） ^anc-exec-call-protocol-payload

Agent 收到 `step_type: 'call'` 的 StepReady 后，**照抄载荷命令驱动，零手拼**（2026-08-14 立项：cc:call-fail 实撞根治——driver 手拼 init 参数是误用面的源头,命令拼装权收归引擎,与 dispatch_ready 的 launch_command 同一纪律"引擎拼好、driver 照抄禁改参"）：

1. StepReady 附 `call_protocol` 载荷（**复用模式 CLI 通道专属**——engine 持有 cliAbsPath+specPath 才拼得出;独立模式 call 走 dispatcher 进程内递归不消费本载荷;载荷缺席时退旧手拼协议,报文见 driver 指令）：
   - `init_command`：完整 init 命令——`node "<cli>" --json init "<CALLEE_SPEC_PATH:id>" --parent <inst> --step <call-step-id> --params '<auto-map json>' --state-dir "<顶层STATE>" --trace <trace> [--upstream-feedback <文本>] [--log-dir ... --log-level ...]`（--upstream-feedback=父层修正意见,重跑轮才带——D41 复用半边,见 [[step-dispatcher#^anc-exec-call-recursion]]）。callee 路径用 `<CALLEE_SPEC_PATH:id>` 占位（寻址归 caller,同 dispatch_ready 先例）；params=引擎 auto-map 快照（^anc-exec-call-auto-map 取值方一律引擎）并入 hop_env 透传；log-dir/级别继承同 buildDispatchLaunchCommand 卫星日志约定
   - `child_state_dir`：子实例驱动循环的 `--state-dir` 值（`<顶层STATE>/<inst>/calls`）；`child_instance`：子实例 ID（=call step id,确定性）；`child_advance`：循环起步命令（init 建的子实例未推进,advance 领首个介入点——起步动作不留给 driver 猜）
   - `report_completed` / `report_failed`：两条回报命令全文（`submit_and_fetch_next <step> --child-instance/--failure-child <子ID> --state-dir <顶层STATE> --instance <inst>`）
   - **载荷内路径一律绝对**（2026-08-14 review 实抓）：命令是跨进程照抄执行的——driver Bash 命令间 cwd 会重置,相对 state-dir 换 cwd 即落错目录（双重嵌套事故同族土壤）。引擎侧保证=instanceDir 构造期已绝对化（init/run 两 CLI 入口 stateDir 均 resolve,对称）;launch_command/stale_launch 同受益
2. Agent 照抄 `init_command`（只填占位符）建子实例
   - Engine 创建子实例：`.hopstate/<parent-id>/calls/<call-step-id>/`
   - 参数映射：caller 变量值注入 callee Inputs（已在 init_command 内,driver 零参与）
   - trace_id 继承：子实例的 trace_id = 父 run 的 trace_id（用于跨 run 关联,已在命令内）
3. Agent 对子实例执行标准 next → execute → done/fail 循环（`--state-dir` 用 `child_state_dir`、`--instance` 用 `child_instance`,均照抄）
4. 子实例 completed：Agent 照抄 `report_completed`（机器通道 `--child-instance`）
   - Engine 将 callee Outputs 映射回 caller step 的 `+ →`
5. 子实例 failed：Agent 照抄 `report_failed`（`--failure-child`,对称于 done 的机器通道，2026-08-09）
   - 引擎读子实例失败记录，组装结构化 CalleeFailure（callee spec_id/失败步骤/真因/fail_kind/child_instance 引用），作为 call 步骤的失败原因入档——非驱动方自由文本转述
   - **内核提取=首个带失败明细的 failed 步骤，不是文档序首个 failed**（^anc-exec-callee-kernel,2026-08-23 dr7 彻查修——原按文档序取首个 failed 常取到**容器**:容器只有状态位、无 stepFailReasons 记录（明细在叶子）,内核落占位文案"缺失败明细,仅状态位",叶子的真根因（CHECK_FAILED 全文/嵌套 CalleeFailure）被丢——深链每过一层剥一次,两层后父层看到的只剩状态位,重试决策全盲、走查诊断无据（dr7 实录:ae01 层只见"callee step '2' failed",最内层"轮次目录/自动修复汇聚无落点"的定向反馈全程不可见）。规则：文档序遍历 failed 步骤,**首个在 stepFailReasons 有记录者**为内核;全部无记录才回退首个 failed（占位文案保留——这形态只剩协议异常一种可能）。**嵌套失败单跳摘要（D42,2026-08-23 作者定"call fail 原因上传应该只保留一层——step 只有本 spec 的逻辑骨干,根本不知道孙 call 的逻辑;由子 call 把错误原因总结上升",废同日首版"内核原封透传根因链全息"——错在抽象层次:父层只认识直接子的接口面〔Inputs/Outputs/步骤骨架〕,孙层的 step_id/变量名/判据文案对父层是陌生词汇,原文逐层堆叠给父层重试/重规划 LLM 的是一堆读不懂的名词）**：内核 reason 若自身是 CalleeFailure（本子实例调孙失败）,组装本层 CalleeFailure 时把它**消化成一跳摘要**——`调用 <孙spec> 失败于其步骤 <X>（已试 N 次）：<孙层 reason 截 200 字>`,再以本层视角包装上升;归纳保证:每层上传的 reason 恒是"直接子的语言"单跳文本,不出现二层以上嵌套 JSON。全链细节诊断归 hoplog 卫星目录（每层子日志各有自己的完整内核,走查按 calls/ 树逐层读——上传通道管决策可读,日志通道管全息追溯,两通道分工）。外层 `CalleeFailure:` 前缀保留（确定性不重试口袋的判据不破） ^anc-exec-callee-kernel
   - **无失败记录=拒收不降级（2026-08-14 e2e 实撞补定）**：子实例 state 里查无 failed 步骤 → INVALID_STATE 结构化拒、父步保持 running——"报败但子没败"只有两种可能：驱动方跑错了子实例目录（协议 A `init --parent` 与协议 B `run --call-parent` 混用致 state-dir 双重嵌套,失败落在野目录官方目录仍 pending）,或子实例还没跑。原兜底"no fail record found"CalleeFailure 是把可诊断的协议误用静默洗成业务失败、**父实例被错误终态化不可恢复**（与 resume"坏输入拒于状态变更前"同一原则）。拒收报文指明自查方向（子实例目录/两协议区别）
   - fail_kind 跨界继承（lack_of_info → caller 侧先走知识补充路径，不烧重试预算）
   - 触发 caller 视角的 fail_step（升级链照常）；`--reason` 仍可用（无子实例的裸失败场景）

**映射来源缺键=响亮失败,不静默 null（2026-08-14 BUG-G 补定）**：mapCallOutputs 对 childVars 里**键缺失**的映射来源（子实例 completed 但查无该输出名——映射写错/子 spec 改版脱节）抛错走 call 步失败链,报缺的键名与子实例实有键清单——undefined 静默流出经 JSON 变 null 入 collect,"null 元素两头不靠"（既非值也非缺席,部分失败语义是列表变短不是 null 占位）。子输出值本身为 null（真 None 产出）照常传递——缺键与 null 值是两回事。

**状态隔离**：子实例完全独立的状态目录，变量空间不交叉。仅通过 Inputs/Outputs 映射传递数据。

**深度限制**：默认 10 层，`--max-depth` 配置。超限时 `hopjit init` 返回 error。

**engine 侧 Inputs 自动映射【契约】** ^anc-exec-call-auto-map

param_mapping 的取值方一律是**引擎**，不是驱动方——驱动方（CC/Dispatcher）只报告"执行这个 call"，映射语义由引擎解释（映射规则改版不用改各载体 driver）。

能力契约（HopSpec 契约）：

```
# Spec: 解析 call 步骤的子 Inputs 实参
Id: resolve_call_params
Goal: 按 param_mapping 从父变量空间取值,构造子实例 init 的 params
Inputs:
- call_step_id: line     # 父 spec 内的 call 步骤 id
Outputs:
- params: yaml           # 子 Input 名 → 父变量值
Constraints:
- 父值缺失（声明未产出）的项不注入,同时 warn 落账（2026-09-01 补——原纯静默,doc-review 第十六次实撞:点路径 from 查不到被无声跳过,5/5 子实例拿 undefined 全灭后账面无一丝痕迹;点路径写法本身已由 V12 静态拒,warn 兜静态拦不住的悬空 from）
- 子 init 校验必填缺失即拒（**2026-09-01 账实差修复实装**——本句自 2026-08-27 立约以来一直是纸面承诺,initExecution 实际对缺失 Inputs 预放 undefined 照跑,INIT_FAILED 仅 Tools 对账一个触发源;实撞:子实例 reviewer_prompt=None 不自报缺信息,自造角色跑完全程审查,产出像样但角色与派单不符。实装口径:**闸只落 call 子实例创建链**〔initExecution 携 parentInstanceId+callStepId 且**无 subtreeRoot** 的形态——subtreeRoot 在场=parallel worker 子实例,不受此闸:worker 执行同 spec 子树,Inputs 靠 params_for_child 部分回填是常态,itemVar 缺失已有 MISSING_INPUT 专闸;实装首版漏此边界,4 个 worker 测试红当场收窄〕;判据=callee Inputs 声明的每个名在实参里缺席或值为 undefined → INIT_FAILED 点名缺哪些。"必填"定义:VarDecl 无 default 字段,全部 Inputs 视为必填——原句"缺省语义接管"在无缺省载体的现文法下是空指涉,随本次改定删除）
- **顶层 run 必填 Inputs 同闸（2026-09-01 deep-validate 批立规,call 子实例闸的孪生半边——原句"顶层 run 缺参照旧宽容〔参数仪式归 driver 层,收紧属另一决策〕"的那个另一决策本日作者拍定收紧:anchor-audit standalone 化九坑之坑 3 实撞,漏传 scripts_dir 起 run,None 静默灌下游到 subprocess.run 拼出坏 argv 才炸,病灶离症状隔几步）**：顶层 initExecution（无 parentInstanceId 的形态——含 CLI init、MCP start_run、dispatcher runSpec 三入口,引擎单点实装三入口同享）对 spec 声明的每个 Inputs 名,实参缺席或值为 undefined → INIT_FAILED,报文逐个点名缺哪些参数并指路（"start_run/init 的 params 须提供: <名>: <类型>  # <说明>"——名/类型/说明照抄 VarDecl,让补参零翻查）。与 call 子实例闸同一"必填"定义（VarDecl 无 default 载体,全部 Inputs 视为必填）、同一判据（缺席或 undefined）、同一错误码（INIT_FAILED）——两闸是同一条完整性原则的两半边,报文措辞按受众分:子实例闸指向父层映射,顶层闸指向起 run 的调用方。parallel worker 子实例（subtreeRoot 在场）照旧不受闸（params_for_child 部分回填是常态）。Inputs 文法现无初值载体（VarDecl 只有 name/type/description 三字段——`= 初值` 是步骤输出位的文法,不是 Inputs 的）,将来若 Inputs 收初值,带初值项自然不缺席、判据无需改。 ^anc-exec-init-required-inputs
- **engine_min_version 版本闸（版本兼容性原则,todo/0093——作者定 2026-09-15"开始执行版本兼容性原则"）**：Config 段约定键 `engine_min_version: <semver>` 声明本 spec 需要的引擎最低版本（写入面=pack 自动注入打包时引擎版本,作者可手写放宽——知道自己没用新语法时）。init 期比对：键在场且**引擎自身版本 < engine_min_version → INIT_FAILED 响亮拒**,报文带两出路（升级命令 `npm i -g @hoplogic/hopjit@latest` / 确认兼容后删除该键）;**键缺席=零比对零提示**（存量 spec 零破坏,渐进采纳）。比对语义=semver 三段数值逐段比（非字符串比——"0.10.0" > "0.9.0"）,非法格式值按缺席处理并 warn 留痕（配置钝感写错不炸,但不静默）。反方向（spec 旧引擎新）不设闸——由破坏性收严三义务守（决策交代/validate 报文带修法/迁移知识进 hopfix 供给面,权威归 [[release-engineering]] 版本兼容原则节）。引擎自身版本读取失败（dist 上溯包根不可得）→ **跳过比对（fail-open,与键缺席同路径）**——版本读取问题是宿主装置故障,不该拒用户的 spec（第十一轮 review 抓获:原实装兜底 0.0.0 落进数值比恒小于一切声明值,读失败时带键 spec 全被误拒,与"永不因版本读取问题拒 spec"的本意正相反）。与顶层必填 Inputs 闸同为 init 期硬闸,判序在其前（版本不足时 Inputs 报文可能基于新语法,先判版本）;call 子实例必填闸（^anc-exec-init-required-inputs call 半边）是 2026-09-01 既有结构,恒在版本闸之前——其报文受众是写 call 映射的 spec 作者而非 run 用户,版本闸主要服务顶层 pack 产物场景,两序并存如实记（第十一轮 review 裁定:不调序,调序须重验老闸得不偿失）。 ^anc-exec-engine-min-version-gate
- **requires_commands 命令预检闸（hopissues/0090 P3 槽位半边,作者拍 2026-09-15"加槽+顺带做 INIT 预检"）**：Config 段约定键 `requires_commands: [<命令名>...]` 声明本 spec 的 subprocess.run body 依赖哪些本地命令（写入面=hopbuild 翻译期从产物 body 抽取写入,作者也可手写;落位与 engine_min_version 同为 Config 约定键——同族"spec 自声明运行前提",零 parser 改动 serializer 免费回写）。init 期对账：键在场且为字符串列表 → 逐个与宿主命令白名单（hostConfig.sandbox.runtime.available）比对,**有缺失 → INIT_FAILED 响亮拒**,报文点名缺哪些命令并带修法指路（"把 <命令> 加进项目根 hopjit.yaml 的 commands: 列表后重跑"——与运行期拒报文同措辞,hopissues/0090 指路条款）;**键缺席=零比对**（存量 spec 零破坏,渐进采纳——未声明的 spec 仍靠运行期拒兜底）;非法格式（非列表/含非字符串项）warn 按缺席处理（配置钝感写错不炸,但不静默）。判序=engine_min_version 闸后、顶层必填 Inputs 闸前（版本都不足时命令报文没意义;命令都不齐时补参没意义——三闸从"环境层"到"参数层"递进）。**与 act-body 运行期拒的分工**：本闸只对账"声明了的"（声明是下界不是上界——body 实际调用未声明的命令仍由运行期白名单核权威兜底,见 [[act-body#^anc-exec-subprocess-run]]）;INIT 读的 hostConfig 与运行期是同一份装配（复用模式 CLI buildHostConfig 在 init 前读 hopjit.yaml,MCP 每 run 重读）,不存在"validate 期 sandbox ≠ 运行期"的时差错位——这正是本闸落 INIT 而非 validate 的理由（act-body 工程偏差③拒的是 validate 期静态预检,本闸不翻那个案,是把运行期拒的时间点前提到进 body 之前）。 ^anc-exec-requires-commands-gate
- 非 call 步骤返回空映射（不抛错,调用方自判）
```

关键逻辑（HopSop）：

```
resolveCallParams(call_step_id):
1. [loop for-each m in call_step.param_mapping] 逐映射项取值
   1.1. [条件(m.literal_value 在场——字面量项,2026-08-27 hopissues/0044)] params[m.to] = m.literal_value（直传,不查父变量——原实装只走 1.2,字面量被当不存在的父变量静默丢弃,子实例拿 None）
   1.2. [条件(父vars 含 m.from 且非 undefined)] params[m.to] = 父vars[m.from]
   1.3. [条件(其他)] 跳过该项（不注入）+ recordWarn 落账（"[call-param] 映射来源 '<from>' 在父变量空间不存在——该参数未注入子实例（整名变量才可映射,字段路径不解析）"——2026-09-01 补,原纯静默）
2. 消费点分派（各消费形态共用同一方法——"取值方一律引擎"对全部消费点成立）:
   [条件(独立模式 spec callee)] Dispatcher executeCall 递归前调用,结果直接作子 initExecution 的 params
   [条件(独立模式工具 callee)] Dispatcher executeCallTool 单次 execute 前调用,结果作工具实参（字面量项对工具 call 同等生效）
   [条件(复用模式)] CLI init --parent --step 时引擎自动调用,merge 进 --params——显式 --params 项优先（caller 可覆盖,信任 caller）
   [条件(协议/派发快照)] buildCallProtocol 的 init_command params 与 parallel call 派发时的 params_for_child 快照,同方法取值
```

**运行时 call-depth 检查【契约】** ^anc-exec-call-depth-check

能力契约（HopSpec 契约）：

```
# Spec: call 深度检查
Goal: 建子实例前拦截超深调用链,防递归失控
Inputs:
- depth: number          # 本次调用的深度（两模式计法见下）
Outputs:
- verdict: bool          # 超限=拒
Constraints:
- 上限 = resource_limits.max_call_depth（缺省 10,常量表）
- 超限返回 DEPTH_EXCEEDED 且不建子实例——父层按步骤失败走升级链
- 与 parser 的 64 层步骤嵌套检查（单 spec 内结构深度,纯输入防护量级）正交,两者独立生效——10 层资源限制的语义本体在本闸（call 链深度）,2026-08-17 作者判定
```

关键逻辑（HopSop）——检查在**建子实例处**，深度计法分模式：

```
[条件(复用模式 init --parent)] depth = --state-dir 参数内 calls/ 路径段数 + 1
   > 目录层级即调用链深度,无需新状态字段;只数 stateDir 参数内的段,不数 cwd 绝对路径
[条件(独立模式 executeCall)] depth = 本 Dispatcher.callDepth + 1
   > callDepth 构造入参逐帧 +1（[[step-dispatcher#^anc-exec-call-recursion]]）
[条件(depth > max_call_depth)] fail DEPTH_EXCEEDED,不建子实例
[条件(run --call-parent 且 --state-dir 尾段已是 <call-parent>/calls)] 启动即拒,报 CALL_PROTOCOL_MISUSE
   > 两协议混用闸（2026-08-14 e2e 实撞,src/cli.ts:544-552）：驱动方把协议 A（init --parent 后对
   > <STATE>/<INST>/calls 走标准循环）的目录喂给了协议 B 入口（run --call-parent 自拼 <parent>/calls/）
   > ——再喂即双重嵌套,子实例跑死野目录。报文含两协议二选一指路,不静默建嵌套目录
```

> **实装状态（2026-06-13，2026-08-10 补全）**：复用模式 call 已实装。CLI `init --parent <id> --step <call-step-id> --trace` 创建子实例于 `.hopstate/<parent>/calls/<call-step-id>/`（engine EngineOptions.parentInstanceId/callStepId/traceId）；`done <call-step-id> --child-instance <id>` 读子实例 vars 经 `completeCallStep` 按 output_mapping 回填父变量。双向冒号映射（`- ← 子参数: 父变量`/`+ → 父变量: 子输出`）由 parser 解析为 param_mapping/output_mapping。confirm 在复用模式天然到顶层（CC 全程驱动），无需 confirm 传递栈。2026-08-10 随 v2-1 补全三项（原 DEBT-04,已还清）：engine 侧 Inputs 自动映射（`^anc-exec-call-auto-map`）、运行时 depth 检查（`^anc-exec-call-depth-check`）、独立模式 call 递归（Dispatcher 嵌套递归 + SpecProvider + confirm 经 call_path 直达，契约在 [[step-dispatcher#^anc-exec-call-recursion]]）。

- **子实例 re-init 净室（2026-08-31 hopissues/0047 修——串行 for-each loop 体内的 [call] 无迭代命名,各迭代复用同一 `calls/<call步骤号>/` 目录;原 init 只覆盖顶层 spec.json/state.json/vars.json 不清 `calls/` 嵌套子目录,上一迭代的嵌套 call 残留被下一迭代静默读到,用错数据无报错。同日 review 面二抓触发面账实差后条款重述）** ^anc-exec-call-reinit-clean：`initExecution` 在子实例场景（EngineOptions 带 **parentInstanceId+callStepId+stateDir 三者齐全**——stateDir 缺席时无盘面可清,纯内存形态自然豁免）发现目标实例目录已存在时,**先读取父引擎备料再整目录删除重建**——次序锁死：`readChildParams` 取走父引擎派发时落盘的 params.json（^anc-exec-parallel-child-params 备料通道）**先于** rmSync,读到的值供后续 Inputs 回填;然后整目录删除（含 `calls/` 嵌套子目录与 work_zone 残留）再重建。**触发面明写（review 面二抓账实差后收准）**：三条件对 **call 子实例与 parallel worker 子实例都成立**——净室对两者都生效是**有意行为**（parallel worker 的 stale 重建语义=「重新 init 从头跑」,清掉上一次的半跑残留正确;先读后清保证 0020 修复的盘面备料通道不被打死）。语义安全依据：串行 for-each 的迭代账（collect 累积/loopCounters 递增/元素重绑）全在**父实例**账上做（completeCallStep 收割时的 loop 级联）,一轮收完才起下一轮——执行结果保持 Python for 循环语义（顺序/单飞/逐轮累积）;子实例目录只是单轮作业本,收割入父账后对语义零贡献。顶层实例 init（无 parentInstanceId）不触发净室——顶层每 run 新 id 不复用目录,撞已有目录的语义归 parallel-execution.md「重新 init 从头跑」条款。不走 per-iteration 后缀命名的理由：改动大（牵动 completeCallStep 步骤映射/目录寻址/driver 调用约定）,且串行场景的审计价值本就残缺——真要审计完整性走 parallel 标注（各迭代天然独立目录）。

### 动态 spec 准入门【决策+契约】 ^anc-exec-dynamic-spec-gate

**定位**：运行时生成的 HopSpec 文本要成为可执行物，必须过同一道准入门。这是"探索的中间表示 = HopSpec 自身"（概念 [[../concepts/HopSpec V3扩展-有序思考与渐进固化]] 总原则）的引擎面兑现——**门是通用的，门后各走各的执行形态**：

| 用户 | 生成物去向 | 执行形态 |
|---|---|---|
| adaptive replan（首个用户,收编——下方协议节即其专属细则） | 原地拼接进本实例树（children 替换） | 共享本实例变量空间 |
| 动态 callee（loop engineering 试跑通道,2026-08-26 作者定 D1/D2） | 起子实例 | call 边界隔离,只经 ←/+→ 映射 |

两者统一的**不是执行形态,是准入判据**。四件：

```
# Spec: 动态 spec 准入
Id: dynamic-spec-gate
Goal: 运行时生成的 HopSpec 文本经同一道门成为可执行物——文法坏/含不可逆动作/越预算在门口拒,不漂运行期
Inputs:
- generated_md: markdown   # 运行时生成的 spec/片段文本（LLM 产物）
- context: yaml            # 准入语境（父实例 work_zone/预算余量/call 深度）
Outputs:
- admitted_path: line      # 过门产物的落盘路径（拒绝时无）
```

1. **落盘先行（D1 作者定 2026-08-26;适用范围修订同日——review 抓 D1 与 replan 既有内联提交协议次序矛盾〔先落盘 vs 先消费后落盘〕,裁定 **D1 只约束动态 callee**:replan 维持内联提交+验证通过后沉淀落盘的成熟协议,门的"统一"收窄为 validate/禁 commit/预算三件,D1 是动态 callee 专属件）**：生成文本先落盘再消费,变量空间只传**路径**不传全文——落盘即候选记录（渐进固化的原料）,审计有实物,大文本不在变量空间流动。**目录与命名规范**：
   - 运行位：`<state_dir>/<instance_id>/work_zone/dynamic/<step_id>.v<n>.md`——work_zone 是探索期文件唯一合法领地（教程 03 既有纪律）,随实例隔离/清理;`<step_id>`=生成它的步骤号,`v<n>`=该步第几版;
   - 沉淀位：`<spec 同目录>/<spec基名>.replan/`（replan 候选文件既有位置**不动**——面向人离线审核）;运行位与沉淀位是同一份内容的两个身份,@trace 头格式统一；
   - **@trace 四元组头**（与 replan 候选文件同款）：`id: dynamic-<spec_id>-<step_id>-v<n>` + 生成步骤 + 生成时间 + 触发原因——固化管线（候选入库）直接消费此头;
   - **路径逃逸闸**：动态 callee 的路径必须落在本实例 work_zone 内（引擎核路径前缀,resolve 后判）——防生成物引用实例外文件逃逸沙箱;
2. **validate 必过**：submitReplan 既有验证闸（parse → 完整性约束〔输出覆盖/变量引用/check final 不可改〕→ 替换或拒）升格为通用门——动态 callee 的产物过同一 validateSpec（片段/整文按形态选档）,不过即结构化 error 携明细（拒因留痕纪律,0030 同款——`submit_rejected` 通道对动态 callee 同样生效）;
3. **禁 commit 静态硬闸（D2 作者定 2026-08-26——replan/动态构建的明确要求）**：动态产物 validate 时含 commit 步即 error,报文指路『动态生成的计划不得含不可逆动作——需要 commit 的路径经人审沉淀为静态 spec 后调用』。配合"act 的身份=可安全重跑"（作者定 2026-08-13）,过门产物试跑天然无不可逆副作用,无需 dry-run 执行期新闸。**生成侧同令**：replan 生成段 prompt 与 hopbuild2 对齐门判据同步明令（少产废品,门是兜底不是唯一防线）;
4. **预算与深度继承（推演,非决策）**：动态 callee 的子实例 token 跨界累计入父预算（BUDGET_EXCEEDED 既有机制）,call 深度计入 MAX call depth（既有上限）——动态不豁免任何资源护栏。

**签名静态、实现动态**（数据流分析不破的关键条款）：`[call {candidate_path}]` 步骤的 `←` 输入与 `+ →` 输出映射**仍静态写在父 spec 里**——S12/V1 静态可查"这步吃什么产什么",动态的只是 callee 内部怎么做。动态 callee 的语言面写法（callee 位允许变量引用）触概念层 `^anc-step-call`,升格实装时需概念层改判——本节先立引擎门,语言面挂点归批次二。

**与相邻契约分工**：本节=准入判据（能不能成为可执行物）;下方 Adaptive Replan 协议=首个用户的交互流程（怎么提交、拒了怎么办）;[[step-dispatcher#^anc-exec-adaptive-pipeline]]=生成侧（怎么想出来）。三节各管一段,门在中间。

### subtask free 到步展开【决策+契约】 ^anc-exec-subtask-free-expand

**为什么（2026-08-27 作者三轮定形）**：①"占位步等 driver 自觉想起 replan"是纪律挂流程外的同族病——"本质上是到这步以后,做一个本步的 plan-do-check-retry-pass 展开"：到步索计划不该靠自觉,该是引擎停点;②"应该用 subtask,但加一个新属性 subtask free"——与 act free 对称（执行自由/规划自由）;③"关键是 replan 可以基于执行时的上下文来构建,这个输入要 feed 给 replan"——到步展开的价值本体=拿着真产出定计划。概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-subtask-free]]。

**能力契约（HopTrait）**：

```markdown
# Spec: 到步展开
Id: engine-subtask-free-expand
Goal: 空的 subtask free 到步时不执行、停下向 caller 索计划——请求携执行时上下文,展开物过闸后接续执行

## Inputs
- 容器契约: yaml   # subtask free 的 ← 输入名+→ 交付声明+描述
- 执行时上下文: yaml # ← 输入变量此刻的实际值(deflate 后)——盲规划禁止

## Outputs
- 展开请求: yaml   # adaptive_needed 形态,reason='initial_plan'
```

**类型约定（HopType,字段逐条）**：

- `SubtaskStep.free?: boolean`——AST 面（parser 归属 [[spec-parser#^anc-rule-b7]] 两宿主条款）;
- `AdaptiveNeeded.reason?: 'initial_plan'`——**分辨字段**（F2 作者拍定复用通道:缺席=既有失败驱动语义〔向后兼容,老 driver 零感知〕;'initial_plan'=首规划——driver 措辞面据此区分。单值枚举:失败驱动以字段缺席表达,不设 'retry_exhausted' 字面〔review 抓设计幻影——声明了代码永不产的值〕）;
- `AdaptiveNeeded.expansion_context?: Record<string, unknown>`——**执行时上下文**（仅 initial_plan 在场）：容器 `- ←` 声明的输入变量的**实际值**（经 deflate 大值卸载,与 ask 人通道同律）;failure 字段 initial_plan 时置空形态（attempt=0,reason=''——没有失败,是首规划）；
- `SpecConfig['expansion_max']?: number`——**展开总数上限**（2026-08-29 作者定"不应该写死"可配化）：spec 头部 `## Config` 键,正整数;缺席/非法按缺省 `DEFAULT_EXPANSION_MAX = 20`（作者定"实例级 10 可能少了"——渐进细化多洞多轮要给跑道）;validator 对非法值 warn（rule='config'）,运行时静默回缺省（配置钝感双面:validate 时点早看见+运行时不炸 spec）；
- `submitReplan opts.extendExpansion?: boolean`——**超限续批授权标志**（2026-08-29 作者定"耗尽不硬烧,展示情况问人"）：达限提交缺席此标志 → 拒 EXPANSION_LIMIT（报文自带问人指引——拒绝响应即介入点,零新 HITL 通道）;在场 → 放行这一次（照常计数,下次超限重新问——一次授权放行一次,防"批一次等于无限批"）。CLI 面 `--extend-expansion` 挂参;授权决策归**真人**（driver 无权替答——预算是人给的,追加须人批）。**standalone 续批通道（2026-08-29 作者定"关键特性不应该等所谓的真需求再补"——工程偏差当日销账）**：dispatcher 的 initial_plan 分流提交撞 EXPANSION_LIMIT 时**不烧 replanAttempts 不失败**,改走升层暂停问人——复用 ^anc-exec-check-escalate 的既有设施（pause_reason='escalate' 暂停卡/escalatePending 持久化/nextStep 短路重放/三通道消化路——问人-应答-跨进程全套现成,零新 HITL 通道,与"拒绝报文即介入点"同一哲学的 standalone 形态）：
  - **暂停卡语义**：question="已展开 N 次达上限 M,任务还要继续展开——继续还是收手?",context 携当前展开计数/上限/被拒计划全文;output_schema 仍 guidance（应答语义=授权与方向合一:人答"继续"或给方向 → 视为续批授权）;
  - **应答续批**：guidance 回注后发起容器仍处 initial_plan 等待态,dispatcher 下一轮重新生成计划并携 extendExpansion 提交（授权消费一次——重新生成而非重交原计划:人若给了方向,新计划该吸收它;人只说"继续"则生成物自然趋同）;
  - **判据**：dispatcher 识别拒因=EXPANSION_LIMIT（结构化 rule='expansion' 且 message 前缀,不嗅探自由文本）→ 走暂停;其它拒因照旧烧 replanAttempts;
  - **复用模式不受影响**：CLI 路径撞限仍走拒绝报文+--extend-expansion 重交（driver 有对话面直接问人,不需要暂停卡）。

**行为契约（逐条,验证面——2026-08-27 三轮 review 后整段修订:27 项发现的契约面归位,修订注記随条）**：

1. **到步停点与语义状态化**：DFS 走到 children 为空的 `subtask free` → 不吐 step_ready、置 adaptiveNeededSubtask 吐 `adaptive_needed{reason:'initial_plan', expansion_context}`。**"这是首规划"是可判定的状态事实（目标容器 free 且 children 空）,不是一次性组装**——等待态的**全部出口**（首吐/幂等再吐/crash-resume 重取）共用同一判定同一组装（review P0 实锤:再吐曾退化为 attempt 3/3 空原因的假失败形态——恰是被禁止的盲规划）;
2. **上下文供给**：expansion_context = 容器 `- ←` 输入名 → 变量实际值（deflate）。**缺值输入显式 null 占位**,并附 `missing_inputs` 清单（review 实锤:缺值静默缺席,规划方分不清"值缺失该规划取数步"与"没这个输入"）;
3. **展开物强制 check**（F1）：无 check 步拒（EXPANSION_NO_CHECK）。**check 须在主干**（埋在 branch 死支里的不算——可能永不执行）;**展开物全量过 fragment 模式 validateSpec**（knownVars=父作用域变量——坏签名 check/P11 等规则面运行时补位,replan 原有 parse-only 是盲区）;
4. **展开物禁 commit——free 容器终身闸**：`free===true` 容器的**一切** replan 提交（首展开与展开后的失败驱动重规划）都拒 commit（EXPANSION_HAS_COMMIT）。**作用域从"首次展开"扩为"容器终身"**（review 实锤:展开后 check 判 false 耗尽 retry 进 adaptive,重规划提交含 commit 曾放行——第二次运行时计划同样无人预审,"不可逆不藏在运行时计划里"不因展开过一次而失效）;
5. **展开后照常**：children 落地即普通 subtask 语义——retry/adaptive 照挂,熔断计数不占 adaptive 池（首规划不是失败重规划;终检实锤已修）。**候选文件版本号用文件探测递增**（契约5豁免使计数恒0,恒写 v1 互相覆盖——首计划是提报沉淀价值最高的样本,不许丢）。镜像写回随 ^anc-exec-specfile-writeback 实装后同享（该机制现未实装——原"照走"表述失实,review 抓）;
6. **非空 free 不触发**：预填 children → 到步照常执行。**loop 体内=首轮展开一次,后续迭代复用该计划**（展开是 AST 变异,迭代复位只复位状态不清 children——按首轮上下文定的计划跑后续轮;要逐轮重规划用 adaptive 失败驱动,review 抓文档零字);
7. **嵌套 free 合法,全实例展开总数熔断**（review 实锤:套娃+完整交付链放行且各池独立计数,3 次熔断对"计划里再要计划"整体失效）：展开物里允许再放 subtask free（渐进细化是设计哲学）,但**全实例累计展开次数有上限**（独立计数器 expansionCount,持久化;超限拒 EXPANSION_LIMIT——与熔断常量族同模式,防 LLM 无限套娃）。**上限可配（作者定 2026-08-29"不应该写死"）**：spec 头部 `## Config` 键 `expansion_max: N`,**缺省 20**（作者定"实例级 10 可能少了"——渐进细化多洞多轮的正常形态要给跑道;写死 10 的初版是保险丝思维,可配后缺省放宽）。挂点为什么是 Config 不是容器头属性/不是 retry：量纲对齐——计数器是**实例级**一本总账（容器头属性是容器级声明,嵌套时哪个 max 说了算说不清;retry 是容器级失败重试配额,且契约5已定"展开不是失败",一词两义互踩）;词用 max 族（探索预算=loop max 语义复用,2026-08-13 既定）,位置在实例级的位置。合法值正整数;非法值（0/负/非数）按缺省并 warn 不拒（配置钝感——写错不该炸整份 spec）。**耗尽不硬烧,问人续批（作者定 2026-08-29"不应该硬性烧毁,应该展示情况,并询问是否继续执行"）**：达限后的展开提交拒收（EXPANSION_LIMIT）,但拒绝报文携**问人指引**（当前展开次数/上限/续批协议）——拒绝响应本身就是介入点,不需要步骤外的新 HITL 通道;caller 把情况呈给**真人**（"已展开 N 次达上限,任务还要继续展开——继续还是收手?",driver 无权替答——预算是人给的,追加也须人批）,人批继续 → 同一提交携 `extend_expansion` 授权标志重交,引擎放行**这一次**（一次授权放行一次,不永久抬限——每次超限都重新问,防"批一次等于无限批"）;人不批 → 计划外收口（改计划收敛/abort）。授权放行照常计数（expansionCount 继续涨,下次超限再问）;
8. **free×parallel 互斥**（新增——review 实锤:dispatch 门在 expand 门前,空 free parallel 被整棵派发,索计划请求落到孙进程,规划方收不到）：validator 拒 `[subtask free parallel]` 组合（V 级 error）——规划请求必须到达有规划权的 caller,worker 是哑执行者;消费方出现时再议放开;
9. **等待态出口纪律**（新增）：submitReplan 补 abort 墓碑门（aborted 实例拒收展开——expand 长驻等待态使旧家族洞窗口常态化）;expand 置槽时槽已被失败驱动占用 → 失败优先、expand 排队（单槽挤占 review 抓——失败是既发事实,首规划可等）;展开提交接受时 recordStepStart 落 hoplog 骨架（原零记录,执行树凭空缺节点）。
10. **standalone 消费分流**（新增——review 抓 dispatcher 误消费:handleAdaptive 原不读 reason,三段流水线第一段强制归因不存在的失败）：dispatcher 收到 `reason:'initial_plan'` 时**绕开三段流水线**（失败分析/改动策略/定向编辑都以"有一次失败"为前提,首规划无此前提）,按 assembleAdaptiveContext 的 initial_plan 指令 + expansion_context（附 missing_inputs 提示）**单段生成**并提交;拒收留痕（0030 同款）且计入 replanAttempts 熔断（拒收也是一攻,防无限重试）。三段流水线契约本体归 [[step-dispatcher#^anc-exec-adaptive-pipeline]],本条是其 initial_plan 旁路。

**到步展开流程（HopSop）**：

```markdown
1. [case(children 为空)] 到步索计划
   1. [act] 组展开请求:容器契约+执行时上下文(← 输入实际值 deflate)
   2. [act] 吐 adaptive_needed{reason:'initial_plan'},置 adaptiveNeededSubtask
2. [act] 收展开提交(submitReplan 既有入口)
   - 既有闸全套(parse/validate/交付契约/check final) + 展开物强制 check + 禁 commit
3. [case(过闸)] children 落地,persist(spec.json;任务卡镜像随 ^anc-exec-specfile-writeback 实装后同享),接续 DFS——展开物首步即下一 step_ready
4. [case(拒-普通)] 结构化报错,adaptiveNeededSubtask 保持——重交或 abort
5. [case(拒-EXPANSION_LIMIT)] 耗尽问人,按模式分形态（同一"预算是人给的"两种拓扑）
   1. [case(复用模式/CLI)] 报文携问人指引——driver 呈真人"继续还是收手?";批 → 同一提交携 --extend-expansion 重交放行一次;不批 → 改计划收敛或 abort
   2. [case(standalone)] 引擎转 escalate 暂停卡（pauseForExpansionExtend）,run 停 paused;应答分两路——**收手词面（收手/停止/不继续/stop/abort 精确短语,答案语面是协议面非嗅探）→ failStep deterministic 收口**（确定性失败不进 retry 阶梯——普通 fail 会重展开再问一遍,刚说收手又被问是骚扰;initial_plan 等待态容器字面 pending,failStep 放行此形态并清等待槽——不清则失败被等待态复活）;其余 → guidance 入 dispatcher 授权账,下轮重生成携 extendExpansion 提交,**展开真放行才清账**（提交被其它拒因拒时授权保留重生成再试——立即清=生成物踩闸即浪费授权,刚批过的人再被问）
```

**与相邻契约分工**：本节=到步停点与展开物闸;提交通道复用 submitReplan（[[#^anc-exec-retry-adaptive]] 步骤6 候选文件照走;任务卡镜像随 ^anc-exec-specfile-writeback 实装后同享）;动态 spec 准入门（[[#^anc-exec-dynamic-spec-gate]]）的 D2 禁 commit 在此收编第二消费方;S5 空容器豁免归 [[spec-parser#^anc-rule-s5]]。driver 面：/hop skill 占位节整段简化为"写 `[subtask free]`,到步引擎自己停下来要计划"。

### 主动 replan（不经失败的计划编辑）【决策+契约】 ^anc-exec-replan-proactive

**定位（2026-08-26 作者定,/hop 随手化批）**：随手工作是边干边改的——干到第 3 步发现后面计划不对,要能改未执行部分。现 replan 仅 adaptive 失败触发;本节放开**主动入口**——不经失败、任意时点提交计划编辑。本质=把"随时可 replan"立为机制,其安全性由既有闸口体系定价（作者定:"随时可改计划的自由,靠把关点不可动来定价"）。

**入口语义**：

- `submitReplan(subtaskId, stepsMd, { proactive: true })`——放开"必须处于 adaptive_needed 状态"的门禁;非 proactive 调用行为零变化（存量不波动）;
- CLI/MCP 面：`submit_and_fetch_next <subtask-id> --replan '<md>' --proactive` / `resume_run` 同款可选参——具体挂点归 hop-cli/mcp-server 随批;
- **编辑范围=A 边界（作者拍板 2026-08-26）**：只能编辑**未执行**的步骤——已执行的是历史（产出在变量空间、账在 hoplog,改历史=造假）;**正在执行的步骤不可动,编辑在其跑完后生效**（复用模式下"正在执行"就是驱动 LLM 自己在干的活——发现方向错自然是不提交、改完计划再继续,"废当前步"的效果由"不提交+改计划"天然达成;残余场景用 --failure 显式放弃,入账留痕）。引擎判据：编辑序列引用了已终态/执行中步骤的 replace/delete → 结构化拒（报文点名哪步已不可编辑）。

**验证面继承（review 批修订 2026-08-26——原"既有全套原样继承零新闸"表述失真:继承的闸带错语义〔相似度处决〕、承诺的闸不在路径〔拒因留痕〕、新输入面需要新闸〔核型/递归比对〕。修订为逐闸声明语义）**：

1. **check final 不可改写或跳过**（^anc-exec-completeness 既有条款——作者点名确认 2026-08-26）——计划再流动,把关面钉死;
2. 交付契约 `+ →` 覆盖验证——改路径不改目标;
3. **相似度闸语义分派**（review P0——处决语义是 adaptive 专属:防 LLM 死循环烧钱;proactive 是人在场的主动编辑,重发/相似编辑是正常操作〔CLI 瞬断重试即逐字重发〕）:**proactive 完全退出相似度闸——不读不写 lastReplanChildren 基线**。不写=防污染 adaptive 基线（编辑后的真故障重规划若结构接近现行计划会被误杀）;不读=重复提交**天然幂等**（前缀照过、尾部替换为同内容,结果状态同一——对 CLI 瞬断重试,幂等 ok 比拒收更友好;实装首版曾写'命中只拒收',与不写基线自相矛盾——不写基线则永不命中,校正为退出闸）。防抖由分池上限 10 兜底;
4. **熔断分池**（review P1-④,作者倾向批准 2026-08-26）:proactive 用**独立计数器**（proactiveReplanCounters,上限 10 防失控）,**不占 adaptive 的 3 次故障恢复额度**——人在场的编辑不是故障,不该吃救命预算;
5. **目标核型**（review P1-①——门放开后新输入面）:proactive 目标必须是 subtask/case 容器,叶子步/其他类型结构化拒（原实装核态不核型,叶子步目标致未捕获崩溃）;
6. **前缀比对递归 children**（review P1-②）:已执行前缀的比对递归到子树——running 容器的内部编辑 v1 结构化拒点名（不静默丢弃不谎报 ok;"真放行内层未执行段"是后话,拒了至少诚实）;
7. **拒因留痕在 engine 侧**（review P1-③——原表述指望 dispatcher 路径,proactive 从 CLI 直达 engine 不经过）:submitReplan 各拒收分支自记 submit_rejected（HopLog 审计通道）,不依赖调用方。

**commit 政策分界（与动态 spec 准入门 D2 的关系,防两"动态"打架）**：

| 场景 | 人在不在场 | commit 政策 |
|---|---|---|
| 动态 callee（探索循环试跑,无人看管生成） | 不在 | 禁 commit（D2 硬闸——无人的生成物不许碰真实世界） |
| 主动 replan（/hop 边跑边改,用户在对话里） | 在 | **允许 commit,由既有把关链管**：P8（commit 前必有 check final/confirm）+ check final 不可改写跳过 + commit 退火 |

判据一句话：**无人生成的计划禁 commit;有人在场的计划,commit 由把关链管**。

**与 commit 退火的交互（显式推演,不留给读者猜）**：边界内已有 commit 成功执行 → 该边界退火（retry 不可用,^anc-exec-commit-anneal）。主动编辑该边界的**未执行部分**仍合法——编辑产生的新步骤是"向前走"不是"重跑",已执行的 commit 不在编辑范围（A 边界保证）、也不会被重放（退火语义保证 retry 路径关闭）;两个既有机制拼合即完备,零新约束。

**与相邻契约分工**：本节=入口与边界;验证归 ^anc-exec-completeness（原样）;生成侧无涉（主动 replan 的新计划由驱动 LLM 在对话里写,不经三段流水线——那是 adaptive 失败驱动的生成管线）;首个消费方=/hop 随手命令（driver 面 `driver/hop-skill.md`——恒复用模式主对话自驱,与 /hopspec 分工:成品 spec 重编排保护注意力/随手活轻自驱保留上下文）。

### 任务卡镜像写回【决策+契约】 ^anc-exec-specfile-writeback

**定位（2026-08-26 作者三连定向,/hop 任务卡批）**：任务卡=计划+语境同体（spec 段落+叙事段落〔背景/参考/处置记录〕一文件——作者定"类似于 hopissues"）。replan 改的是引擎真身（AST/spec.json）,盘上任务卡的 Steps 节随之变陈——半新半陈的文件看起来整体可信,放大误导。**镜像同步是真身持有者（引擎）的义务,不是 driver 的自觉**（作者定"核心问题是 hopjit 引擎需要适配"——driver 改文件违哑搬运契约,且自行 serialize 必与引擎漂移）。

```
# Spec: 任务卡镜像写回
Id: specfile-writeback
Goal: replan 改树后把源文件的 spec 段同步为新计划——叙事段字节原样,写回经校验才算数,失败可回滚不伤源文件
Inputs:
- spec_path: line     # 源文件路径（内存态实例无此项即跳过——与候选文件同判据）
- new_ast: yaml       # 引擎真身（replan 后的 AST）
Outputs:
- written: bool       # 写回成败（失败不拦 replan——镜像滞后可容忍,真身错误不可容忍）
```

四件套（作者定 2026-08-26,"直接写回不合适,需要备份"）：

1. **写回前快照**：源文件整文 copy 入 `.hopstate/<instance>/specfile_backups/<n>.md`——**进 .hopstate 不进 hop_tasks/**（备份是机器兜底不是人的工作史,任务目录不见 .bak——尤其 Obsidian 场景;随实例生命周期同域清理;计划的**版本史**另有账——replan 候选文件 `.replan/*.v<n>.md` 就是,本快照只管"被覆盖前整文件"的事故保险）;
2. **节边界替换写回**：按 parser Section 定位,只替换 spec 段（Steps 及 replan 触及的节）为 serializeSpec 产物对应节——**叙事段（背景/参考/处置记录等引擎不识别的节）字节原样**;节序纪律（spec 段在前、叙事段在后、处置记录恒居末——hop-skill 五稿卡结构约定）使"替换中段保住尾部"机械安全;写用既有 writeAtomic;
3. **回读校验（写回算数的判据——比备份更硬:备份是出错能救,校验是出错当场知道）**：写回后回读重 parse,AST 投影与引擎真身一致才算成;不一致=节边界 bug 实锤 → 从快照回滚 + HopLog warn 留痕 + 本次写回放弃（replan 本身不受影响）;
4. **外部改动检测**：写回前核文件与上次引擎读取时的内容 hash——不一致=用户手编过任务卡,**不覆盖**、warn 留痕交 driver 呈报（用户意图优先,引擎不抢写）。

**触发面**：submitReplan 成功路径（proactive 与 adaptive 同享）,与 spec.json 持久化、候选文件落盘同站点;**只在 replan 改树时触发**——正常执行不碰源文件（文件是计划镜像不是进度镜像,进度归 status）。**失败语义**：四件任一失败 → written=false + warn 留痕,replan 照常生效（尽力而为,与候选文件落盘同款）;下次写回自愈。

**与相邻契约分工**：真身持久化=spec.json（^anc-exec-state-persistence,机器账恒写不受本节失败影响）;版本史=replan 候选文件（^anc-exec-retry-adaptive 步骤6）;本节=人读镜像的同步。实装归 /hop 批次一（todo/0007）。

### Adaptive Replan 协议

**定位（降级阶梯）**：replan 是 adaptive 降级阶梯的第 3/4 档——运行时生成（[[../concepts/HopSpec V3核心规范#^anc-exec-retry-adaptive]]）。前两档（带反馈重跑、选预声明备用链路）优先；replan 是它们不可用时的兜底，**故任何 replan 产物都须提报沉淀**（见下步骤 6）。第 2 档备用链路库属档 B（待 Spec 库协议），本协议描述档 A 的运行时生成+提报。

Agent-Engine 交互流程：

1. **Engine → Agent**：`hopjit next` 返回 `{ status: 'adaptive_needed', ... }`
   - 含 `spec_id`（沉淀绑定需要——提报记录要标明是哪个 spec 的）
   - 含 `failure`（失败原因 + 第几次重试）
   - 含 `subtask_contract`（不可变的 `+ →` 和 Constraints）
   - 含 `original_children`（原步骤结构供参考）
   - 含 `retry_history`（之前每次尝试的摘要）

2. **Agent 职责**：
   - 分析失败原因和重试历史
   - 基于 subtask_contract 设计新的 children 步骤
   - 生成 HopSpec Steps markdown 片段（仅 children 部分）

3. **Agent → Engine**：`hopjit submit_and_fetch_next <subtask-id> --replan '<markdown>'`（命令面收窄后,replan 是 submit 的一个参数,见 [[hop-cli#^anc-cli-dispatch]]）

4. **Engine 验证**： ^anc-exec-completeness
   - 解析新 children markdown（调用 SpecParser）
   - 验证新 children 输出覆盖 subtask 的 `+ →` 声明（Output schema 验"全"）
   - 验证新 children 不引用不存在的变量（Inputs + 前序步骤输出）——实装形态:fragment validateSpec（knownVars=当前变量表全键）对**一切 replan 提交**生效,error 级即拒（2026-09-11 语义审计抓漏修:原实装该闸只挂在 [subtask free] 展开分支,普通 replan 是 parse-only,坏变量引用静默落树到运行时才 MISSING_INPUT 晚炸;闸挪出 free 块两路同过）
   - `[check final]` 不可改写或跳过——若原 children 含 `[check final]`，新 children 必须原样保留（check final 验"质"）
   - 普通 `[check]` 可被 adaptive 改写（调整验证策略以适配新执行步骤）
   - 通过 → 替换 children，重置状态，**持久化 spec.json（AST 改了，必须落盘——否则跨进程 load 丢失新 children，见 [[#^anc-exec-state-persistence]]）**，返回 `{ status: 'ok' }`
   - 不通过 → 返回 `{ status: 'error', errors: [...] }`

5. **失败回退**：Agent 收到 replan error 可重试（最多 3 次 replan 尝试）。放弃则调 `submit_and_fetch_next <subtask-id> --failure`，触发上层 retry 链。

6. **提报沉淀（运行时生成必沉淀）**：replan 验证通过后，Engine 发 HopLog `replan_audit` 审计事件，绑定四元组 `(spec_id, step_id, 错误原因, 生成的 children)`（见 [[spec-observability#^anc-obs-replan-audit]]），并把产物落 spec 源同目录候选文件（`<spec 基名>.replan/<step_id>.v<n>.md`——n=本 subtask 第几次 replan〔计数器值〕；内容=提交的 children markdown 原文＋头部 @trace 注释块绑定四元组与时间，供离线审核直接读）。运维离线消费 → 审核 → 晋升为预声明备用链路（下次命中第 2 档）。**这是降级阶梯"运行时生成必沉淀"的落点**——学习在离线经审迭代，不在运行时。写入语义：尽力而为不拦 replan（沉淀是离线学习通道非执行链——写失败 HopLog warn 留痕,replan 照常生效）；specPath 缺席（内存态引擎/测试）跳过——无源目录即无沉淀位。spec 目录候选文件写入属档 A;备用链路库的检索协议属档 B（待 Spec 库协议）。

**约束验证指引**：Engine 验证 replan 时除检查输出覆盖和变量引用外，将 subtask_contract.constraints 作为文本附加到新 children 的验证上下文中。约束本身是自然语言，Engine 无法程序化校验——由后续 check 步骤在执行时验证。Engine 的职责是保证约束被传递到新步骤的执行上下文中不丢失。

### 熔断机制

防止 adaptive replan 无限循环消耗 API 资源：

1. **replan 尝试上限**：同一 subtask 最多 3 次 replan 尝试（已有，见步骤 5）
2. **相似度检测**：连续两次 replan 生成的 children 进行结构对比——若步骤数量相同、步骤类型分布一致且 summary 文本相似度 > 80%，判定为"重复尝试"，直接 fail subtask 而非再试
3. **退化检测**：每次 replan 的 children 步骤数不应递增超过 2x。若新 children 步骤数为上一次的 2 倍以上，标记为"计划膨胀"，警告但仍接受（不自动拒绝——LLM 可能在合理情况下生成更细粒度的计划）
4. **HITL 升级路径**：3 次 replan 全部失败后，若父 spec 有 HITL 能力（存在 confirm 步骤模板），将失败上下文以暂停信号形式提交人工决策，而非直接 propagate。人工可选择：(a) 手动编写新 children，(b) 跳过 subtask，(c) 终止执行。

---

## 实例主动中止【决策+契约】 ^anc-exec-abort

**为什么（todo/0007 第 3 项,2026-08-26 作者两轮拍定）**：误开的任务被 driver 归档后，实例永远停在 running——账上留一个假活着的实例（status 谎报进行中、hoplog 无终章、未完成实例扫描的永久噪声）。用户面语汇已定：只有"收起来"一个动作,未完成的活 driver 问一句"不要了还是回头再干"——答"不要了"时 driver 需要一根**把实例转终态的暗管**。standalone 侧这根管已有（mcp-server `stop_run`→aborted,^anc-mcp-stop-run）;复用模式（CLI 逐命令跨进程）没有——本节补齐引擎面与 CLI 面。

**能力契约（HopTrait——Spec without Steps）**：

```markdown
# Spec: 实例主动中止
Id: engine-abort
Goal: 把一个非终态实例标记为主动中止的终态,跨进程持久,幂等,历史全保留

## Inputs
- reason: text  # 中止原因（人话,如"用户放弃"——入账供事后追溯,可省缺省 '(user abort)'）

## Outputs
- 终态: text  # 恒 'aborted'——status/账面自此如实呈现,不再谎报 running
```

**类型约定（HopType,字段逐条）**：

- `terminalState: 'completed' | 'failed' | 'aborted' | null`——引擎终态标记**三值扩展**（原双值);
- `state.json.terminal_state: 'aborted'`——持久化同扩展（既有 `terminal_state` 键,零新键;跨进程 load 恢复照旧走 `stateData.terminal_state` 赋回）;
- `state.json.abort_reason?: text`——中止原因（仅 aborted 时在场;人话原因入账,与 terminal_failure 的结构化失败区分——中止不是失败,是意图）;
- `StatusResponse.execution_status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted'`——status/vars 响应同扩展（cli-types 双处;paused 档 2026-09-09 0081 批补——停驻如实转述,判定三源与边界见 [[hop-cli#^anc-cli-status-response]]）;
- `AbortResponse = { status:'ok', instance_id, execution_status:'aborted', abort_reason }`——abort 命令响应。

**行为契约（逐条,验证面）**：

1. **非终态实例 abort → aborted**：running/pending 任意中间态均可中止;置 `terminalState='aborted'` + `abort_reason` + persist（走既有 finalizeTerminal 同款收口路径——终局有据 0043 同律）;hoplog 记 `execution_aborted` 事件后 close（有终章）;
2. **幂等**：已 aborted 的实例再 abort → 原响应重放（ok+aborted）,不重写不报错（与 stop_run "已终态幂等返回现状"同款）;
3. **已 completed/failed 的实例 abort → 拒**：`ABORT_TERMINAL_CONFLICT` 错误——干完的活不能被追改成"放弃"（账的真实性:completed 是事实,中止是意图,意图不覆盖事实。与幂等条界线:同态重放合法,异态改写非法）;
4. **aborted 是终局,不可恢复**：`resume`/`submit_and_fetch_next`/`debug_step` 等一切推进命令对 aborted 实例 → `RUN_ABORTED` 拒（与 mcp-server 墓碑门同语义:中止是终局不是暂停;快照/hoplog 保留仅供检视）;
5. **status 如实**：`determineExecutionStatus` 先查 `terminalState==='aborted'` 即返 aborted——凌驾步骤态推导（步骤还停在 running/pending,但实例已死,账不谎报）;
6. **中间步骤不追改**：abort 只置实例级终态,不把 running/pending 步骤改成 failed——步骤态是"中止那一刻的现场"，保真供检视（与 stop_run 协作式语义一致:不打断、不伪造步骤结果）。

**中止流程（HopSop）**：

```markdown
1. [check] 实例终态检查
   - terminalState 为 null → 放行
   - 已 aborted → 幂等重放,返回
   - 已 completed/failed → ABORT_TERMINAL_CONFLICT,返回
2. [act] 置终态
   - terminalState = 'aborted'; abortReason = reason ?? '(user abort)'
3. [act] 落账
   - persist（state.json 带 terminal_state + abort_reason）
   - hoplog 记 execution_aborted 事件,close('aborted')
4. [exit] 返回 AbortResponse
```

**CLI 面**：`hopjit abort [--instance id] [--reason text]`——一命令一方法（^anc-cli-dispatch）,路由 `ExecutionEngine.abort(reason?)`;加载走 `load`（保留现场,不是 recover——中止不需要重置悬空步骤）。命令表与响应类型登记归 [[hop-cli#^anc-cli-abort]]。

**与相邻契约分工**：standalone 的 stop_run（^anc-mcp-stop-run）是 server 层协作式中止（步间生效、级联在飞、注册表态)——本节是引擎/CLI 层的**同语义对应物**,两层终态字面统一 `aborted`;driver 怎么用这根管（归档问句、零行话）归 hop-skill,引擎零感知。parallel 在飞子实例:复用模式 fan-out 的在飞 worker 是独立进程实例,父 abort 不级联（v1 简化——worker 由 driver 自然放弃,子实例各自留账;standalone 的级联歼灭是 dispatcher 进程内能力,跨进程无把手。工程偏差当场标注,消费方出现时再议）。

## 崩溃恢复【契约】 ^anc-exec-crash-recovery

### 原子写入

所有状态文件写入采用 write-to-temp-then-rename 模式：

```
writeAtomic(path, data):
  write to ${path}.tmp
  fsync
  rename ${path}.tmp → ${path}   // POSIX rename() 是原子操作
```

保证状态文件始终完整——要么是旧版本，要么是新版本，不会出现半写入。

### 多文件写入顺序

`hopjit done` 一次操作涉及两个文件（vars.json + state.json）。写入顺序：

1. **先写 vars.json**（更新变量值）
2. **再写 state.json**（标记步骤完成 + 更新 retry 计数器 + children 状态）

**state.json 是提交点**：如果先写 vars.json 后 crash，崩溃恢复（recover）发现步骤仍为 running → 重置为 pending → 重跑（vars 被覆盖，安全）。如果反过来先写 state.json，步骤标记为 done 但变量缺失 → 携带错误数据继续执行。

> **注意**：running 重置只发生在崩溃恢复（recover）。复用模式日常 next→done 之间也跨进程，但走 load（保留 running），不重置——否则 done 进程读到 pending、无法回写。区分见生命周期组 load/recover。

retry 计数器和 children 状态同在 state.json 中，单次原子写入保证一致性。

### iCloud 环境说明

`.hopstate/` 默认位于 `~/.hopstate/`（`$XDG_STATE_HOME/hopjit/` 或 `~/.hopstate/`），避开项目目录的 iCloud Drive 同步问题。通过 `--state-dir` 参数可覆盖为项目目录或其他路径。

### hopjit resume 命令

```
hopjit resume [--instance id]
```

**这是唯一走 recover 语义的命令**（崩溃恢复）——其余命令（next/done/fail/status/vars/branch/replan）走 load（保留 running，见生命周期组）。

**能力契约**（HopSpec 契约）：

```
# Spec: 崩溃恢复
Id: recover
Goal: 把崩溃中断实例的悬空 running 步骤重置为 pending 幂等重跑,不破坏刻意持有 running 的结构状态
Inputs:
- instance_dir: line     # 实例快照目录
Outputs:
- engine: yaml           # 可继续 next 循环的引擎实例
Constraints:
- **默认极性=只重跑最后干活的节点**（2026-09-03 作者拍"2 还用问么"反转——原极性"凡 running 一律回 pending,撞坑再逐个豁免"是黑名单式:每新增带状态的容器类型默认先被误重置,撞了才补〔0050 loop 事故正是此模式产物,branch 豁免长期零测试裸奔同源〕。新极性白名单式:可执行叶子重置重跑,容器默认保留——容器 running 是"这段结构走到一半"的结构状态,里面记着选路/圈数/位置等不可重来的决策,重置=决策作废重做与既成事实打架;新容器类型天然安全零豁免维护）
- 容器重置两形态不是例外,是同一原则的另一半（2026-09-04 作者纠框架:"有啥例外了,这些也都是正在执行最后的节点啊"）——重置判据统一为**崩溃时正在执行的节点**:叶子在干活干到一半要重做;**未决策的 branch**（全部直接 children 均 pending——判据=任一直接 child 已离开 pending——**skipped/running/done/failed 四态皆决策已发生的凭据**〔选路在 handleBranchEntry 同步原子完成后 persist,不存在半选中间态〕;不能只认 skipped:单 case 形态〔C2 合法 if-then〕命中置 running 无兄弟可 skip,2026-09-04 review 实抓旧判据恒 false 误判）与**未进圈的 loop**（loop_counters 无账）被重置是因为引擎正执行到它们的**入口决策**,它们就是那一刻的"最后节点";已选路/已进圈的容器不重置,因为它们的活（入口决策）早已干完落盘,running 只剩结构语境。一句话:**没落盘的工作重做,落盘的决定不动**。**worker 子实例的 scope 掩码祖先先于此两判**（实装首轮测试实抓:掩码祖先可以是 loop,其圈数账在父实例不在 worker 自己账上——"无账"判据在 worker 视角恒真,误杀路标。掩码祖先的入口决策活在父账,worker 无从判也无权判,恒保留）
- 非容器非叶子（break/continue/exit 及未知步 id）照旧重置——它们在 pending 态被引擎同步消化,不该有持久 running 形态;残留 running 若保留,DFS 撞 running 非容器即返 none,run 挂死
- 安全前提=落盘原子性:vars.json 先写、state.json 为提交点（本节原子写入条款）——盘上 running 容器的入口决策（branch 选路 skipped 标记/loop 计数/scope）恒已同快照在盘,"容器 running 而决策没记"的中间态在盘上不存在
- state.json 损坏 → error,人工介入（不猜不修）
```

**关键逻辑**（HopSop）——恢复流程与 running 处置极性（叶子重跑/容器默认保留）：

```
recover(instance_dir):
1. [act] load 快照重建引擎（保留全部状态）
2. [loop for-each 步骤 in running 步骤] 逐个按新极性判（可执行叶子重跑,容器默认保留）:
   [条件(可执行叶子类型(reason/act/check/confirm/ask/commit/call))] 重置 pending
     > "最后一个节点重跑"的本体——崩溃时真在干活的就是它,结果没回写只能重做（act 语义
     > 本就可安全重做）;串行下任意时刻活跃叶子至多一个
   [条件(worker 子实例(subtree_root 非空) 且 步骤 ∈ 子树根祖先链)] 保留 running
     > scope 掩码路标,先于下两判——祖先可以是 loop/branch,其入口决策账在父实例,worker
     > 账上"无账"恒真会误杀（实装首轮测试实抓）;掩码语义与原豁免同,现为显式优先判
   [条件(branch 且 全部直接 children 均 pending)] 重置 pending
     > 崩溃时正在执行入口决策（条件评估）的 branch——它就是那一刻的"最后节点",决策没
     > 落盘照原则重做;保留会让 DFS 下钻直落首个 pending case 绕过评估。已选路的落
     > "其他"保留（决策已落盘,running 只剩结构语境）
   [条件(loop 且 loop_counters 无该步计数)] 重置 pending
     > 同上:正在执行入口初始化的 loop——保留会让 DFS 进体内而 itemVar 未绑定。已进圈
     > 的落"其他"保留（hopissues/0050 期望行为:圈数与收集账不动,体内悬空叶子重做本轮）
   [条件(非容器非叶子(break/continue/exit)或未知步 id)] 重置 pending
     > 它们本该在 pending 态被引擎同步消化,持久 running 是异常残留;保留则 DFS 撞
     > running 非容器返 none,run 挂死
   [条件(其他)] 保留 running（容器默认保留——subtask/case/on_fail/已选路 branch/已进圈 loop;
     > worker 子实例的 scope 掩码祖先天然在内〔它们全是容器〕,原独立豁免条款被本极性收编）
3. [act] 清误判终态残留:terminal_state==='failed' 且两类失败凭据全缺席(terminal_failure/任一步骤态 failed)→ 清标记（误终局读侧防线,判据详见 ^anc-exec-state-persistence 两防线条款——真失败凭据任在其一即不清）
4. [act] persist 落盘
5. [act] HITL 暂停上下文经 step_states 恢复 + 介入载荷重算（见 ^anc-exec-pause-persist——无独立快照文件）
6. [act] HostConfig 恢复：读取 host_config.json（不得含 key）,重走活动凭证加载链（环境变量或
   StandaloneConfig 的 api_key_env 解引用）——恢复时必须从活动环境重新取得 key,不能从快照或
   配置明文恢复
7. [exit] 后续等价于继续 hopjit next 循环
```

> 步 6 已登记债：host_config.json 完整写入/恢复未实现——resume 后的 Engine 不持有完整 HostConfig（hostConfig=null），复用模式下凭证由 caller 进程环境提供，不受影响；doc-ref 必需的非敏感子集已针对性收口（见 `^anc-exec-host-context-persist`）；独立模式 resume 的完整 HostConfig 重注入已收口（原 DEBT-05）——server 重启恢复经 restoreRun 用当前 config.yaml 重建注入,见 [[mcp-server#^anc-mcp-run-restore]]。

如果 `state.json` 损坏（原子写入失败极小概率）→ 返回 error，需人工介入。

---

## 状态持久化【契约】 ^anc-exec-state-persistence

```
.hopstate/                         # 目录权限 0700
└── <instance-id>/
    ├── spec.json        # 当前执行的运行时 AST 快照（init 写入；adaptive replan 改 AST 后须重写——反映当前执行逻辑）
    ├── state.json       # step_states + retry_counters + loop_counters + hoplog_run_dir（提交点）+ host_context 非敏感子集
    ├── vars.json        # 所有变量值（单文件，先于 state.json 写入）
    └── calls/           # call 子实例（状态隔离）
        └── <call-step-id>/
            ├── spec.json
            ├── state.json
            ├── vars.json
            └── calls/   # 支持递归嵌套
```

所有 `.json` 文件权限 0600，写入使用原子写入（见崩溃恢复章节）。vars.json 合并所有变量为单文件，避免每步骤 N 次 fsync 的 I/O 放大。写入顺序：vars.json → state.json。

**spec.json 是运行时 AST 快照、随 replan 演化**（[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-durable-resume]] 实例状态含可变 AST）：常态下 AST init 后不变，每步只改 state/vars，spec.json 无需重写（性能：避免每步序列化整树）。**v1 实况**：FilePersistence.saveSnapshot 恒重写 spec.json（正确性优先、不漏写——replan 后忘写的风险大于每步整树序列化的开销,spec 通常不大）,"仅 replan 触发重写"的脏标记优化归 v2（2026-09-12 0088 批补记——此前该 v1 简化只在代码注释有账,设计正文写的是相反的"引擎区分"）。但 **adaptive replan 替换 subtask children 后改了 AST**——此时 `saveSnapshot` 必须**重写 spec.json**，否则跨进程 load 读到的 AST 不含 replan 的新 children（执行逻辑回退，此前的真实 bug）——v1 恒重写天然覆盖此要求;v2 上脏标记优化时 replan 路径必须置脏。注意区分 **spec 源文件不可变**（SSR，[[../concepts/HopSpec V3核心规范#^anc-exec-adaptive-fallback]]）vs 此运行时 AST 快照可变——两者不同。

**终态落盘（2026-08-26,hopissues/hoplogic3/0043——"暂停有卡,终局有据"的终局半边）**：run 转 completed/failed 时终态必须随快照落盘——原四条终态出口（allTerminal completed/failed、exit completed/failed）返回前零 persist,dfs 里的状态转移（exit 步标 done/全体 pending→skipped）只活在内存,跨进程读快照永远"差最后一步"（hopkb 实撞:探针绿 run 的快照 exit 步恒 pending,盯环判 running 永不转完,Stalled 误报三连;terminal_failure 有字段而 completed 完全靠内存——覆盖不对称）。修法：`StateFile` 增 `terminal_state?: 'completed' | 'failed'`（与 terminal_failure 平级）,四条终态出口统一经 `finalizeTerminal(status)` 收口=置标记+persist（此刻内存状态转移已完成,persist 带全量步骤状态——exit 步 done/skipped 一并落盘）;幂等（nextStep 重入时标记已在场不重写）。**消费面**：`runStatus` 快照兜底对 `terminal_state==='completed'` 返回 `{status:'completed', outputs}`（outputs=header.outputs 声明变量按 vars.json 现值收集——与进程内 collectOutputs 同判据）;failed 同理携 terminal_failure。**init 后失败同律（todo/0058,2026-09-01——0043 的漏网半边）**：dispatcher.runSpec 装配后 Tools 对账失败（^anc-exec-tools-reconcile 第二调用点）原直接 return failed 零落账——state.json 停在 init persist 的全 pending,快照消费者（CLI status/跨进程看护/list 扫描）对死 run 恒见 running（实撞:看护 subagent 按 CLI status 空轮询 12 分钟,经 MCP 交叉核实才发现 run 早死）。修法：该失败出口返回前调 `engine.markInitFailed(reason)`——置 terminal_failure（stepId='(init)'）+finalizeTerminal('failed')落盘,快照与进程内响应一致。engine.initExecution 自身的失败返回（parse/validate/必填缺失——发生在 persistence 建立前）无快照可写,不涉本条:那些失败没有实例目录,消费者不会对不存在的实例轮询;有目录才有恒 running 病,病面恰=init 成功落盘后、首步前的失败窗口。

**误终局两防线（2026-08-27 狗粮实撞 bc32179f 补——乱序回写场景:driver 先收 3.2 step_ready 却回头交 3.1〔乱序但合法,3.1 确实 running〕,交付后 DFS 重遍历产 none〔3.2 已 running 不重发是既有语义〕,原直落 'No executable step found' finalize failed——3.2 正等 caller 交结果,是等待不是死局）**：

1. **finalize 前置检查（写侧防线）**：kind=none 且 inflight 空且顶层非全终态时,**先扁平扫 stepStates——存在执行类型步骤（EXECUTABLE_STEP_TYPES）处于 running 即不 finalize**,返回 `WAITING_WRITEBACK` 结构化错误（携 running 步清单——driver 收到即知"有步骤等交付,交它";不复用 drain_wait:那是 parallel 在飞语义,混用则消费方误走 reap 收割）。容器类 running 不算在等（容器 running 是结构状态,子孙全终态时由级联收口——只有执行类叶子的 running 才是"等 caller 回写"）;
2. **recover 清理（读侧防线,兜历史残留）**：`recoverDanglingRunning` 重置悬空 running 后,若 `terminalState==='failed'` 且**两类失败凭据全缺席**——①`terminal_failure` 字段（函数级 fail 写）②盘面任一步骤态 failed（allTerminal-hasFailed 路径的可再推导凭据）→ 清 terminalState 并 persist。**判据必须查两类**（review 亲核抓:finalizeTerminal('failed') 五出口里 hasFailed 与完备性闸两出口不写 terminal_failure——只查它会把真失败终局洗白）;误判残留的特征恰是"全 done/running 无一 failed"。完备性闸形态（全终态无 failed 缺产出）被清无害:下次 advance 重走闸自愈重 finalize。**0043 边界自此精确化：任一凭据在场的终局不可逆;双凭据全无的 failed 标记是误判残留,resume 即清**。completed/aborted 恒不清（aborted 是显式意图墓碑;completed 不清的理由 2026-09-15 随 hopissues/0093 修订——见下条）。

**completed 标记与步骤态不一致的显式报告（hopissues/0093,2026-09-15 作者定"该修的修彻底"）** ^anc-exec-completed-consistency：报告方实锤一份病态快照——`terminal_state: completed` 而顶层收尾步还停 pending（执行事件零记录）,引擎读侧只信标记不回看步骤集,照报 completed 且无任何不一致信号。引擎正常盖印路径产不出这种快照（盖 completed 的两条出口都要求顶层全终态或 exit 步走到）,病态来源最可能是盘外写入/回放重建——但读侧对它不设防=下次实质没跑完的错标快照会静默漏交付。修法三条：

1. **检测判据**：`terminal_state === 'completed'` 且顶层步骤存在非终态（pending/running——isTerminalStatus 之外;worker 子实例不误伤:子树外步骤被 executeSubtreeOnly 标 skipped 是终态）= 完成标记与步骤态不一致;
2. **全读取面显式报告,不留静默通道**：①引擎进程内 `getStatus`——返回补 `inconsistency` 字段（文字四件说全:不一致是什么/疑什么来源/建议什么动作/为什么不擅自改）;②MCP `runStatus` 快照兜底路径（注册表 miss 纯读盘——0093 probe 实走通路）同判据同字段;③MCP `runStatus` 注册表命中路径（entry.state=completed 时直调引擎检测器——阅卷抓设计只声明两面实装有三面,补齐声明）;④`getVars`（经 CLI vars 命令对外,同带 execution_status——阅卷抓此面静默报 completed,同补）。status 本身各面都仍返回 completed（见 3）;
3. **报告不擅改**：检测到不一致时**不清标记、不翻 running**——自动翻 running 的副作用:病态快照若实质已跑完（如崩溃窗口半写）,翻 running 后 nextStep 会重派 journal 已清的步骤=重复执行;来源不明时报告让调用方决策,比擅自恢复稳。与 failed 侧 recover 清残留（上条防线 2）不对称是有意的:failed 误判残留有双凭据判据可机械裁,completed 病态无等价凭据（"全终态"恰是被违反的那个前提）。

原"completed 无误判形态"假设自此修正:正路径无误判,病态快照（盘外来源）有——读侧检测防的是后者。

**驱动通道落账与跨通道拒（双执行硬闸）** ^anc-exec-driver-channel

（2026-08-27 作者定"复用与 MCP 并存"三改的安全半边——决策权威 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]。两模式并存后,原"两壳互斥同位"的物理防串台消失,防双执行〔同一 run 被 CLI 与 MCP server 两条通道各推一遍——最高危事故:状态互踩、步骤重复执行、commit 重复提交〕必须从 NL 纪律降为引擎机制）：

- **落账**：`StateFile` 增 `driver_channel?: 'cli' | 'mcp'`——run 建立时由入口写入（CLI `run`/`init` 落 `cli`;mcp-server `startRun` 落 `mcp`）,随快照持久,run 生命周期不变;
- **拒判**：推进类入口（改状态的——CLI 的 submit_and_fetch_next/reap_and_fetch_next/advance/resume/abort/replan/**debug_step**〔调试命令同样直调 nextStep 改状态,2026-09-11 语义审计抓漏:原枚举与实现双缺,双执行硬闸存可绕口——调试入口不豁免,豁免=最高危事故类留后门〕;MCP 的 resumeRun/stopRun）加载快照后核 `driver_channel`——与本入口通道不符 → **响亮拒**（错误码 `DRIVER_CHANNEL_MISMATCH`,报文点明该 run 属哪条通道并指路正确入口:CLI 撞 mcp run 指 `mcp__hopjit__resume_run`,MCP 撞 cli run 指 `hopjit submit_and_fetch_next`）,不推进、不改状态;
- **只读入口不拦**（status/vars/validate/list;MCP 的 run_status/list_runs）——看账无害,跨通道可观测恰是排查双执行的手段;
- **缺席宽容**（字段不在场=旧版建的 run）：不拒——存量 run 升级引擎后照常驱动,首个推进入口**补写**本通道值（从此有账;两通道谁先来谁认领,竞态窗口=旧 run 首次推进一次,可接受）;
- **子实例继承**：call/parallel 子实例随父通道（`init --parent` 落 cli;MCP 进程内子实例落 mcp）——一棵执行树恒单通道,收割/应答跨通道同拒。

> 完整 HostConfig 恢复不走独立文件——Provider 是运行时对象不可序列化，由宿主 resume 时重新注入（原 DEBT-05 已收口,实装形态见 [[mcp-server#^anc-mcp-run-restore]]）；doc-ref 必需的非敏感子集经 `host_context` 入 state.json（`^anc-exec-host-context-persist`）。

**host_context 持久化（doc-ref 跨进程必需）** ^anc-exec-host-context-persist：「resume 后 Engine 不持有完整 HostConfig（hostConfig=null）」（原 DEBT-05,已收口）对纯凭证场景无害（复用模式凭证由 caller 进程环境提供）。但 **doc-ref [[文档路径#章节名]] 解析在每步 context 组装时需要 `workspace_dir` + `sandbox`**（见 [[doc-ref#^anc-exec-doc-ref-resolve]]），而复用模式每个 `submit_and_fetch_next` 是 fresh process 走 `ExecutionEngine.load`——若 hostConfig 不恢复，doc-ref 在主路径恒失效（此前真实 bug）。故 `StateFile` 增 `host_context: { workspace_dir, sandbox, hop_env?, config_project_dir? }`（HostConfig 的可序列化最小子集，**不含 api_key 等凭证**——凭证仍由 caller 环境提供，不落盘）：`init_execution` 写入，`load` 重建 `engine.hostConfig`。字段演进：hop_env（2026-08-14 覆盖链下游产物随快照,^anc-config-hop-env）;**config_project_dir（2026-08-15 BUG-I 修）**——run 启动时的项目根（组合根一次读取的 cwd）,server 重启恢复时以它为 loadStandaloneConfig 的 projectDir 重读项目级配置（配置仍活,钉住的只有读取根;消费面见 [[mcp-server#^anc-mcp-run-restore]] 恢复契约）。这是上述 host_config.json 偏差的**针对性收口**：不实现完整 host_config.json，只持久化 doc-ref 必需的非敏感子集进 state.json。

### state.json 结构示例

```json
{
  "format_version": 1,
  "step_states": {
    "1": "done",
    "2": "running",
    "2.1": "done",
    "2.2": "pending",
    "3": "pending"
  },
  "retry_counters": {
    "2": 2
  },
  "loop_counters": {},
  "step_fail_reasons": {
    "2.1": "格式探测失败：无法识别分隔符"
  },
  "exec_events": [
    { "at": "2026-06-16T01:00:00Z", "step_id": "1", "event": "step_start" },
    { "at": "2026-06-16T01:00:01Z", "step_id": "1", "event": "step_done" },
    { "at": "2026-06-16T01:00:02Z", "step_id": "2.1", "event": "step_failed", "detail": "格式探测失败：无法识别分隔符" }
  ],
  "log_dir": ".hoplog",
  "hoplog_run_dir": ".hoplog/my-spec-20260612T161400-a1b2"
}
```

`step_states` 为扁平 `Record<string, StepStatus>` 映射（step_id → 状态），不嵌套。`retry_counters` 仅记录有 retry 配置的 subtask，key 为 subtask step_id，value 为剩余重试次数。`loop_counters` 记录 loop 当前迭代轮次。`step_fail_reasons` 记录失败步骤的人类可读原因（step_id → 字符串），`get_failure_reason` 直读，跨进程稳定（仅有失败步骤时存在）。`exec_events` 为带时序的扁平事件流，供 PromptAssembler 重建 L3 上下文（仅非空时存在）。`hoplog_run_dir` 持久化 HopLog 的 run 目录，resume 时据此恢复 HopLog 实例。`adaptive_needed_subtask` 为可选字段——subtask 进入 adaptive_needed 状态时写入，resume 后继续等待 replan 提交。`format_version` 为整数，v1 固定为 `1`，用于后续版本升级时的格式识别。

### 执行历史进 state.json，与 HopLog 分工【决策】

state.json 保存崩溃恢复与**重组 prompt** 所需的状态：step_states + counters + retry_history + step_fail_reasons + exec_events + hoplog_run_dir。其中 `exec_events`（事件时序）与 `step_fail_reasons`（失败原因）是**执行历史**——PromptAssembler 重建 L3 上下文、`get_failure_reason` 取失败原因都依赖它们。复用模式下每个 CLI 命令是独立进程，这些数据若只在内存，跨进程即蒸发：L3 的 `iteration_history`/`subtaskProgress` 变空、失败原因显示 "Unknown"。故**执行历史必须持久化到 state.json**。

> **历史决策修订（2026-06-16）**：早期设计曾规定「执行轨迹（事件、失败原因、retry 历史）不进 state.json，只走 HopLog，以免日志增长拖累每步原子写入」。该决策已**废除**——理由有二：① retry_history 自 #90 起已破例进 state.json（L2c 跨进程重跑需要），性能顾虑已被实践否定；② 把"重组 prompt 必需的执行历史"挡在持久化外，直接导致复用模式 L3 上下文跨进程断裂（本次修复的根因）。执行历史是执行状态的一部分，与 step_states 平级持久化。

**与 HopLog 的分工不变**：HopLog 写 `.hoplog/<run>/main.yaml`，为**人复盘**服务——按步骤结构组织、可能很大、含完整审计。`exec_events` 为**引擎重组 prompt** 服务——扁平带时序、轻量、只够还原 loop 跨轮顺序与子步状态。两者各自独立写入，不互为数据源（HopLog 按步组织取不出 loop 跨轮时序，故引擎不读 HopLog 重建上下文）。state.json 仍每步原子写（write-temp-then-rename）；exec_events 是有界的步骤事件流（非无限增长的日志），I/O 可接受。

**vars.json scope 隔离（format_version=2）【契约】** ^anc-exec-vars-scope-persist：vars.json **落盘完整 scope 树**，跨进程按结构重建，scope 隔离持久化保真。结构为 `{ format_version: 2, scopes: { <scopeId>: { parent: <父scopeId>|null, variables: {…} } } }`——每个 scope 记其 parent id 与本层变量，`root` 的 parent 为 null。`fromJSON` 两遍重建：先建所有空 scope 进 map、再按 parent id 连指针、再灌各 scope 变量（保证建 child 前 parent 已存在）。

> **为何不能扁平（历史错误假设修订，2026-07-04）**：早期设计（本段原文）曾规定「vars.json 扁平、scope 隔离仅内存，依赖 V3 规则保证无命名冲突」。**该假设已证伪**——V3 只拦"子与祖先同名"（纵向遮蔽），**不拦兄弟 scope 同名**（横向）：两个平级 subtask 各产出 `x`，validator 零 error 放行。扁平序列化会把两个 `x` 后写覆盖先写，跨进程 resume 后两个 subtask 读到同一错值——**静默数据损坏**。故 scope 树必须完整落盘，不能靠"无同名"的错误前提拍平。

**v1→v2 迁移**：`fromJSON` 按 `format_version` 分支——v2 走 scope 树重建；v1（或无版本字段的旧 vars.json）走旧路径（扁平变量全塞 root），保证已在跑的旧实例不破。新实例一律写 v2。

call 子实例有独立的 vars.json（在 `calls/<step-id>/` 下），天然隔离。

### 暂停态的持久化与恢复（暂停即产问题卡 paused.json）【契约】 ^anc-exec-pause-persist

**2026-08-25 作者拍板 B（hopissues/hoplogic3/0028）收窄 2026-08-10「载荷不落盘」裁决**：HITL 请求离开发起进程（detach run/定时批——人不在进程里）时必须是自足实物,否则跨进程不可得（hopkb 实撞:批裁决被呈成截 200 字符半句话/盯环按退化去重键空转 54 分钟）。原裁决的陈旧论据在 paused 场景不成立——paused 期间引擎停着,变量空间不变,replan 只能发生在非 paused 时,陈旧窗口实际不存在。

- **暂停即产卡**：nextStep 组装 ExecutionPaused 载荷（confirm/ask 两分支）后,把问题卡全文（`step_id`＋`pause_reason`＋`presented_data` 全文＋`response_options`＋`output_schema`＋`work_zone`）写 `<instanceDir>/paused.json`——与返回 caller 的载荷同源同一份,先落盘后返回（事实边界:盘上卡=真递送件）。无 instanceDir（纯内存实例）静默跳过;
- **答案消化即删卡**：completeStep 对 confirm/ask 步骤**成功**消化答案后删除 paused.json（卡的生命周期=等人窗口;拒收〔SCHEMA_MISMATCH 等〕不删——run 仍 paused 卡仍有效）。步骤重置 pending 重进暂停时新卡覆写旧卡（写即覆盖,无叠层）;
- **暂停态编码不变**：confirm/ask 步骤标 `running` 随 state.json 持久化,"类型 confirm/ask + running + 无输出回写"仍是暂停判据——paused.json 是**递送件**非状态源,状态判定不依赖它（卡缺席只影响跨进程取载荷,不影响 resume 注入答案的恢复路①）;
- **恢复两条路保留**：①caller 带答案回来——completeStep 直接消化;②重看介入请求（resume/recover）——步骤重置 pending,下一次 nextStep 重算并**重新落卡**（重算恒按当下变量空间,卡随之刷新——重算仍是载荷权威,盘上卡是它的落地件）;**recover 重置时旧卡当场清除**（32 轮 review——回置 pending 后旧卡即陈卡,不清则兜底的陈卡对账替源头擦屁股;已知产陈卡路径在源头治理）;**等人窗口的全部关闭路径都删卡**：答案消化/confirm reject/recover 重置/stop_run 中止（墓碑同拍,[[mcp-server#^anc-mcp-stop-run]] 第4条）;~~PARALLEL_HITL_TODO 判 failed~~（35 轮临时路径,**0013 兑现即撤 2026-08-25**——子实例 paused 保卡入队,见 [[parallel-execution#^anc-exec-parallel-hitl-queue]];removePausedCard 保持 public——杀活连坐清卡仍用）;
- **嵌套 call 的卡在子实例目录**：暂停发生在哪个引擎,卡落哪个引擎的 instanceDir（calls/<child>/paused.json）——恢复边界照旧（CallFrame 不随快照恢复,见 [[mcp-server#^anc-mcp-run-restore]]）;parallel 子实例同理,天然多卡并存（0013 队列化的铺路形态:一卡一文件一目录,可寻址=instanceDir+step_id）;
- **对齐 HopAnt trait**：`run_spec` 的 `checkpoint: yaml` 输出 = ExecutionPaused 载荷本身——paused.json 即它的持久形。


### 状态映射（与 HopAnt run_spec trait）

| HopJIT NextResponse.status | HopAnt run_spec.status | 说明 |
|------------------------------|----------------------|------|
| `completed` | `completed` | 终态，result = outputs |
| `failed` | `failed` | 终态，result = partial_outputs |
| `paused` (confirm/ask/waiting_human) | `waiting_human` | 暂停态经 state.json 编码,介入载荷重算（`^anc-exec-pause-persist`） |
| `step_ready` / `adaptive_needed` | （内部状态） | 不暴露给 run_spec 调用方 |

`instance_id` 即 HopAnt `run_spec` trait 的 `execution_id`——同一标识符，两种语境。
