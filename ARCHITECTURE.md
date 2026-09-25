%% @trace
	id: hopjit-design
	source: [[HopAnt概念-双态组件模型]], [[HopSpec V3核心规范]], [[HopType体系]], [[HopSpec V3配套HopJIT运行时能力]]
	source_id: cyant-concept, hopspec-v3-core, hoptype-system, hopjit-runtime
	type: intent
	last_sync: 2026-07-31T18:03+0800
%%

# HopJIT 架构设计

> 用 struct/impl/Spec 体系描述 HopJIT 自身的架构

## 定位

> **本文在主线中的位置（第 4 站·架构）**：前置=第 3 站 [[docs/concepts/HopType体系]]——本文通篇用 HopType 语言（struct/trait/impl、双态分布）描述架构，未读它先补；后继=第 5 站 [[docs/design/module-principles]]（模块规范）与 [[Doctree]]「模块索引」（第 6 站，模块清单的家）。

HopJIT 是 hoplogic 项目里的 HopSpec 执行引擎（TypeScript 实现）。TS 引擎核心（确定性流控）+ 两种驱动模式（概念定义见 [[../HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]]）：

| | 复用模式（reuse） | 独立模式（standalone） |
|---|---------|---------|
| 推理智能 | Caller（CC / 上层 agent） | StepDispatcher 直调 LLM API |
| 执行能力 | Caller 的工具集 | ToolProvider |
| 入口 | hopjit CLI（init/next/done/fail） | `runSpec()` 进程内 API |
| 状态生命周期 | 跨进程，文件持久化 | 进程内，内存为主 |
| 典型场景 | `/hopspec run`（CC 是大脑） | HopAnt `run_spec`（无人值守） |

> 工具调用的五条物理通道（body 内置/非内置双模式/LLM 循环/缺省文件工具）与拦截规则总览：[[docs/design/tool-channels]]

**复用模式下 Claude Code 全程驱动**：CC 读 spec、调 `hopjit next` 获取步骤上下文、自己推理/执行、用 `hopjit done/fail` 回写结果。引擎是纯流控器。

**独立模式选择直调 API 而非套 CC SDK/Subagent 的理由**：
- CC Subagent 无 HITL 能力、无法续跑、纯文本单次返回——hopjit 需要自己的持久化和调度
- CC SDK 的增量价值是工具生态和上下文管理，hopjit 已有自己的工具实现（解析/验证/状态机/prompt 组装），不需要 CC 的工具链
- 直调 API 带来模型自由（Opus/Sonnet/Gemini/GPT）、确定性控制和清晰的组件边界

## 架构分层

HopJIT 分为引擎核心 + 两个驱动适配层，通过 Provider 接口解耦。**模块判据/依赖方向规则/拆分触发判据/物理边界演进**见 [[docs/design/module-principles]]（模块工作的原则权威，动模块结构前必读）：

**引擎核心（模式无关）**——纯逻辑，两种模式共享，可移植到任何语言/平台：

| 组件 | 职责 |
|------|------|
| SpecParser | Spec markdown → AST，35 条验证规则 |
| ExecutionEngine | 状态机、变量作用域、retry/adaptive、None 传播 |
| PromptAssembler | 6 层 context 组装、token 预算管理 |
| BodyInterpreter（act-body 模块） | hop_python 受限编排语言：parser/解释器/内置函数，确定性执行零 LLM |
| PySandbox（py-sandbox 模块） | Python 语法沙箱：模型写出的产物脚本按白名单静态审查,审过才由独立 python3 子进程执行（可叠加系统沙箱） |
| 错误模型（shared-errors 模块） | 错误码枚举与分类——全组件共享词汇（共享层） |

**复用模式适配**——CLI 进程壳 + 文件持久化：

| 组件 | 职责 | 环境依赖 |
|------|------|---------|
| HopCLI | CLI 命令路由（薄壳，不含业务逻辑） | 进程/stdout |
| FilePersistence | EngineSnapshot ↔ .hopstate/ 文件 | 文件系统 |

**驱动载体多态（driver/）** ^anc-driver-carrier-polymorphism：复用模式下外层 LLM（CC/Codex/OpenCode…）当推理引擎，通过一套**驱动指令**编排介入点/执行段/并发。**引擎与 CLI 载体中立**（纯 JSON in/out，不假设工具执行能力——概念层 `^anc-exec-mode-invariants`），故每个载体只需一套等价 driver：
- `driver/hopspec-skill.md`（+ `skills/hopbuild/`）——**CC 载体**（SKILL.md 格式，Agent 工具起 subagent，AskUserQuestion 问人）。
- `driver/codex/`——**Codex 载体**（`.agents/skills/hopspec/` skill 布局）：有 subagent 能力时，`SKILL.md` 承载 main orchestrator，`agents/segment-driver.md` 与 `agents/parallel-worker.md` 分别承载两类执行 agent；宿主不暴露 subagent 时，Main 按同一角色文件 inline 降级。Codex 专属 references 定义批式 fan-out、串行降级与执行规则。完整契约见 [[docs/design/codex-driver-carrier]]。
- `driver/references/`——CC 继续使用的现有 references；Codex 安装仅复用真正载体中立的 `cli-discovery.md`，其余执行/发现规则由 `driver/codex/references/` 自包含，避免把 `AskUserQuestion`、task-notification、`node <CLI>` 等 CC 原语带入 Codex。
- **同语义、分载体实现**：CC 与 Codex 的执行规则都对齐 `^anc-exec-mode-invariants` / `^anc-exec-advance-to-caller` / `^anc-exec-work-zone` 等同一组设计锚点；允许调用原语与并发交互不同，不允许步骤语义静默漂移。Codex 载体的角色、降级与验收契约见 [[docs/design/codex-driver-carrier]]。

**独立模式适配**——LLM 调用 + 工具执行：

| 组件 | 职责 | 环境依赖 |
|------|------|---------|
| StepDispatcher | LLM 调用循环、模型路由、凭证解析 | Anthropic SDK / 网络 |
| MCP server（hopjit-mcp） | standalone 对外协议壳——五工具（start/status/resume/list/stop）包 StepDispatcher，run 注册表 + job 式异步 + HITL 同进程 resume（见 [[docs/design/mcp-server]]；standalone 整体约束与审查见 [[docs/design/standalone-mode]]） | MCP SDK / stdio |
| DefaultToolProvider | Read/Write 工具实现、沙箱拦截 | 文件系统 |
| SandboxConfig | 四维度安全边界（filesystem/network/runtime/database） | OS 级资源 |
| ModelEngine | 多模型配置、客户端池 | LLM 服务商 API |
| MemoryPersistence | 进程内快照（默认） | 无 |

**契约边界**（Provider 接口）：

| 接口 | 引擎核心使用方 | 适配层实现方 |
|------|-------------|----------------|
| PersistenceProvider | ExecutionEngine 状态快照 | FilePersistence（复用模式）/ MemoryPersistence（独立模式） |
| ToolProvider | Engine 通过 Dispatcher 调用 | DefaultToolProvider 或宿主注入 |
| KnowledgeProvider | PromptAssembler L2 知识注入 | 宿主注入（RAG/向量库等） |
| IdentityProvider | Dispatcher 获取凭证 | 宿主注入或 DefaultIdentityProvider |

引擎核心不直接碰文件系统、网络、数据库、LLM API——所有外部交互通过 Provider 接口。

**例外（有意保留）**：HopLog 执行轨迹日志直接落盘，不走 Provider。理由：执行轨迹的可还原性是两种模式的共同原则（见概念层模式无关原则），日志写入是 HopLog 的本质职责而非可替换的环境适配。

### PersistenceProvider 接口

```typescript
interface PersistenceProvider {
  init(instanceId: string, spec: SpecAST): void;   // 创建实例存储空间
  saveSnapshot(snapshot: EngineSnapshot): void;    // 状态+变量原子保存
  loadSnapshot(): EngineSnapshot;                  // 恢复（resume 用）
  exists(): boolean;                               // 是否有可恢复状态
}

interface EngineSnapshot {
  spec: SpecAST;
  state: StateFile;     // step_states / retry_counters / loop_counters / adaptive_needed_subtask / hoplog_run_dir
  vars: VarsFile;
}
```

设计要点：
- **快照原子性**：`saveSnapshot` 一次保存完整状态。FilePersistence 实现需保证 state.json + vars.json 的写入一致性（当前分两次 writeAtomic，崩溃窗口存在——v2 合并为单文件快照）
- **职责边界**：Provider 只管快照的存与取。crash recovery 的状态修复逻辑（running→pending 重置、branch 选择保留）属于 Engine 业务，留在 `ExecutionEngine.resume()`
- **默认行为**：Engine 构造时不传 Provider → MemoryPersistence（独立模式零配置）；CLI 显式构造 FilePersistence（复用模式跨进程）

## 组件设计文档

模块清单与每模块的完整链（锚点→概念上游→设计→src→测试）**统一维护在 [[Doctree]]「模块索引」**，本文不重复列表（架构总览与模块索引分工：本文管分层与交互，Doctree 管清单与收链入口）。设计文档在 `docs/design/`，每份开头自带内容分级表。

## 分层桥接点

引擎核心对适配层的直接依赖现状：

本表是**已核准桥接的封闭集**——G8 层向 lint（`scripts/check-layer-imports.mjs`）的豁免名单与本表一一对应，新增桥接必须先登记本表再写代码（[[docs/design/module-principles]] §2）。

| 引擎核心组件 | 依赖（适配层/共享层之外） | 状态 |
|-----------|---------|------|
| ExecutionEngine | persistence.ts：`FilePersistence/MemoryPersistence`（EngineOptions 缺省实例化）+ `writeChildParams/readChildParams`（for-each worker 参数通道，fan-out 按 cid 落盘，见 [[docs/design/parallel-execution]]）+ `stateExists/readState`（fanout 顾问读 child 终态） | **有意保留（2026-08-04 核准）**——曾声明"已重构不再直调自由函数"（2026-06-13），07 月 for-each 参数通道按设计加回；worker 参数通道与 child 状态读取是并行调度的本质职责，经 Provider 绕行只增间接层不减耦合 |
| ExecutionEngine | cli-types.ts（NextResponse 等响应类型，type-only） | **有意保留**——这些 JSON 结构是引擎方法的返回形状，物理归属 hop-cli 模块（对外契约），引擎产出它们是职责本身 |
| doc-ref | tools.ts：`readSandboxedFile/resolveWorkspacePath` | **有意保留**——doc-ref 读 workspace 文件必须过 sandbox 校验，复用 tools 的路径链是安全一致性要求（自造第二套校验更坏） |
| shared-providers（provider-types） | ast-types/runtime-types（type-only） | **有意保留**——Provider 接口签名天然引用 SpecAST/EngineSnapshot 等类型；type-only、无运行时依赖 |
| ExecutionEngine | HopLog (hoplog.ts) | **有意保留**——执行轨迹可还原是模式无关原则，落盘是其本质职责（hoplog 属核心层，此条实为层内依赖，留表作历史记录） |
| ExecutionEngine | node:crypto (randomUUID) | 可接受——标准库，无平台耦合 |
| PromptAssembler | hoplog.ts (LogEvent type) | 可接受——层内 type import |

这些桥接点不影响引擎核心的逻辑可移植性——状态机、变量作用域、retry/adaptive、None 传播等纯逻辑不依赖任何适配层实现。

## 组件交互

### 复用模式（CC 全程驱动）

```
用户: /hopspec run spec.md
  ↓
CC（推理 + 工具执行，全程在场）
  ├→ hopjit init <spec.md> --params '<json>'
  │     └→ SpecParser.parse → validate → Engine.init（FilePersistence 落盘）
  │     ← 返回 instance_id
  │
  ├→ loop
  │    ├→ hopjit next
  │    │    └→ Engine.next_step → PromptAssembler 组装 6 层 context
  │    │    ← NextResponse { status, step_type, step_id, summary, context }
  │    │
  │    ├─ CC 按 step_type 自己处理:
  │    │    ├─ reason/check → CC 直接推理（context 即 prompt 素材）
  │    │    ├─ act          → CC 用自己的工具执行（遵守 SandboxConfig 契约）
  │    │    ├─ confirm      → CC 向用户展示，收集回复
  │    │    └─ commit       → CC 向用户确认后执行不可逆操作
  │    │
  │    ├→ hopjit done <id> --output/--answer / hopjit fail <id> --reason
  │    │    └→ Engine.complete_step / fail_step（每命令后落盘）
  │    │
  │    └─ adaptive_needed 时: CC 分析失败 → hopjit replan <subtask-id> --steps @new.md
  │
  └→ next 返回 completed: CC 展示 Outputs
```

### 独立模式（runSpec 委托执行）

```
调用方（HopAnt run_spec / 脚本 / 服务）
  └→ runSpec(specMarkdown, inputs, hostConfig)
        └→ StepDispatcher
             ├→ Engine.init（MemoryPersistence，默认）
             ├→ loop
             │    ├→ Engine.next_step → AssembledContext
             │    ├─ execute_step（按 step_type 分派）
             │    │    ├─ reason/check → 直调 LLM API（模型路由 + 客户端池）
             │    │    ├─ act          → LLM tool_use loop（ToolProvider.execute，
             │    │    │                 requires_commit=true 自动拦截，沙箱强制）
             │    │    ├─ confirm/commit → 返回 paused 状态给调用方（CITL 暂停点）
             │    │    └─ call         → 递归 runSpec（子 spec）
             │    │    注: branch/loop 等结构步骤由 Engine 条件评估自动处理
             │    ├→ Engine.complete_step / fail_step
             │    └─ adaptive_needed: Dispatcher 直调 LLM 生成新步骤 → Engine.submitReplan
             │
             └→ 返回 { status: completed | failed | paused, outputs / failure / pause }
```

## 双态分布

| struct | 层 | 实现 | 说明 |
|--------|-----|------|------|
| SpecParser | 引擎核心 | TypeScript | 确定性解析，纯函数 |
| ExecutionEngine | 引擎核心 | TypeScript | 状态机，持久化经 PersistenceProvider |
| PromptAssembler | 引擎核心 | TypeScript | 模板化组装，确定性 |
| HopCLI | 复用模式适配 | TypeScript | 命令路由，JSON I/O |
| StepDispatcher | 独立模式适配 | TypeScript | 调度循环 + 直调 LLM API（tool_use loop） |
| HopjitMcpCore | 独立模式适配 | TypeScript | MCP 工具面路由 + run 注册表（薄壳，零执行逻辑） |

复用模式下推理智能是 CC（LLM 在 caller 侧）；独立模式下推理智能在 StepDispatcher（LLM 在引擎侧）。引擎核心 3 组件在两种模式下行为完全一致。

## 字符串转义规范【契约·强制】 ^anc-string-escape

**跨组件强制不变量：任何"引擎生成、交给外部再解析"的字符串，其中的外部来源值必须转义。违反即缺陷。**

引擎产出的字符串有多条"出境"通道，各有再解析层，转义责任不可省：

| 出境通道 | 再解析层 | 转义手段 | 落点 |
|---|---|---|---|
| shell 命令（launch_command/init_command/stale_launch，交 agent 照抄进 Bash） | shell 分词与展开 | 路径 `"${x}"` 双引号包裹;**数据值（参数表、反馈文本）不进命令行**——引擎写进父实例目录 `cmd_args/` 下的文件,命令里只放 `"@<路径>"`（双引号内 shell 照样解释反引号与 `$`,JSON 转义管不住,hopissues/0097 实撞） | engine.ts buildDispatchLaunchCommand/buildCallProtocol（数据值落文件=cmdArgValue,[[docs/design/exec-engine#^anc-exec-cmd-args-file]]） |
| hoplog YAMLL 写盘（main.yaml） | YAML 解析 | 过 `toYaml()`（引号/block scalar） | hoplog.ts 所有值字段 |
| CLI 响应（返 driver 的 JSON） | JSON 解析 | `JSON.stringify`（禁手拼 JSON 串） | cli.ts output() |
| prompt 注入（给 LLM 的 context） | LLM 读取 | 结构化分区/围栏，防截断混淆 | prompt.ts |
| params.json 落盘（fan-out 子实例入参，供 worker 进程再解析） | JSON 解析 | `JSON.stringify` 写 / `JSON.parse` 读（禁手拼） | persistence.ts writeChildParams/readChildParams |

**判据是"值的来源"，不是"当前值恰好安全"**（核心原则）：
- **外部来源值**（用户在 spec 写的 `Id:`/字段、工作区路径（常含空格如 iCloud `Mobile Documents`）、caller 传入的 trace_id、用户数据/文件名）→ **必须转义**。哪怕当前测试值恰好无特殊字符，来源不可控即须转义——`buildWorkerLaunchCommand` 的空格路径拆参 bug 正是"当前值恰好…直到路径含空格就崩"的反例。
- **内部生成值**（runId 固定格式 `YYYYMMDDTHHMMSS-hex`、step_type/status 枚举、instanceId UUID）→ 可裸写，且**有意保持裸写**以清晰标示"受控内部值"。不过度转义——过度转义会模糊"哪些是真需要防的外部值"。

新增任何"生成→交外部执行/解析"的字符串路径时，必须按此表选转义手段、按来源判据决定是否转义。审计见 anchor-audit（本锚点全量校验各出境通道）。

## run 隔离不变量【契约·强制】（单机版架构） ^anc-run-isolation

> **架构适用域（2026-08-14 作者定）**：本节是**单机单进程形态**下的任务间保障架构——当前 HopJIT 的全部执行形态（CLI 单 run 进程 / MCP server 常驻多 run 单进程）都在此域内。将来若升多进程/分布式，本不变量**文字不变**（它执行形态无关），实现形态列整列换写（进程/机器边界免费实现大半通道），届时另立形态设计。

**跨组件强制不变量：并发的 run 之间，除显式声明的共享资源外，不允许有任何相互影响通道——既禁一个 run 的异常波及其它 run（沉船），也禁一个 run 的状态被另一 run 读到/改到（串台）。违反即缺陷。**

实撞背景（2026-08-14）：多 run 并发崩 server（一个 run 的池 promise 异常逃逸 → unhandledRejection → Node 默认杀进程，N-1 个健康 run 陪葬）+ cwd 串台（run 级材料根被进程 cwd 承载，多 run 互相偷换解析根）——同病两症：**run 级的东西住在进程级槽位上**。

| 相互影响通道 | 违反形态 | 堵法 | 落点 |
|---|---|---|---|
| 异常传播 | 火后不管的池 promise reject 无人接 → 进程崩全船沉 | **结构防线（两形态共用）**=池 promise 尾接终极 catch——它在 run 上下文内、知道自己是谁，run 标 failed 在此完成（收割自身失败只记 warn+run failed，吞不再抛）；**进程兜底（仅 server）**=装 `unhandledRejection`/`uncaughtException`——职责如实：记 stderr+计数留痕+**不 exit**，**不承诺关联 run**（回调只有 reason 无 runId，进程内无上下文链——承诺关联即 launch_command 式空头支票；漏网 run 的驱动链断了停在 running，由超时/对账/run_status 观测或重启 restore 兜住）。作者拍板 2026-08-14"活"：真状态全在盘上 durable resume 兜底；死则一个意外杀 N-1 个健康 run。**CLI 进程不装兜底**（unifiedDispatch 下主+子实例同进程但同属一个 run——崩即该 run 崩，语义本来就对；结构防线照有：子实例炸应是 failed 终态非进程炸）。兜底是止血非豁免——每次触发=结构防线漏网，留痕必修 | dispatcher.ts 池尾 ×2（两形态共用）；mcp-server.ts serve（兜底） |
| cwd | run 级解析锚被进程 cwd 硬编码；任何 chdir 全体串台 | 组合根（startRun/CLI 命令入口）一次读取折进该 run 的 HostConfig；内核禁 `process.cwd`/`process.chdir` | mcp-server.ts startRun/restoreRun |
| env | 凭证/模型/行为开关运行期直读 `process.env`——外部或它 run 改动即影响在飞 run | HostConfig 构造期一次性 **env 快照**（`env_snapshot`，见 [[docs/design/shared-providers#^anc-config-host]]）；内核运行期只查快照。**两类例外（登记不收编）**：①`env_passthrough`/`auth_env` 是给 stdio 工具子进程的透传——装配期（惰性连接时）解引用属组合根延伸语义（连接是 run 内一次性动作;快照它反而改变"起子进程时的当下环境"这个用户可感语义）；②`HOPJIT_CONFIG`/`HOME`/`HOPJIT_OUTPUT` 是进程身份级配置（server/CLI 启动期消费）,天然组合根不属快照面 | dispatcher 8 处/engine 1 处收编；tools-mcp-binding 3 处=例外① |
| 共享可变对象 | server 的 `config`（tool_servers `_base_dir` 变异）被多 run 触碰 | startRun 按 run 深拷贝分发（现状幂等靠巧合，改为结构保证） | mcp-server.ts startRun |
| 模块级可变全局 | `_stepMapCache`（ast-runtime 顶层 `let`）——run 级缓存住进程级槽，跨 run 互踢；照此模式再写一个按内容键控的缓存即正确性 bug | 缓存搬引擎实例（`buildStepMap` 回纯函数）；**src 内核零可变模块顶层状态**成为可机检断言。**豁免=组合根文件+登记制**：`cli.ts` 的 `FORCE_JSON`（进程输出模式,真进程级语义）是现存豁免首例——豁免只许出现在组合根白名单文件且逐个登记于守卫脚本,内核文件零豁免 | ast-runtime.ts/engine 实例 |

**显式共享登记（有意共享，不算违反，动它须过本表）**：`MAX_CONCURRENT_RUNS` 并发闸（server 级费用防线）；provider 限速/费用（进程共享 API key——全局费用闸挂观察账）；`runs` 注册表（server 的本职状态）；`.hopstate` 盘面（run 各有子目录，天然隔离）。

**守卫**：`check-process-state.mjs`（内核禁 `process.env/cwd/chdir`+模块顶层可变状态，组合根白名单豁免，见 [[docs/design/chain-enforcement]]）+ 崩溃回归（故障 run 并发健康 run：健康 run 走完、server 存活、故障 run 记 failed）+ 串台回归（两 run 各自 HostConfig，解析根/凭证互不可见）。

> 各模块落点细节：server 侧=[[docs/design/mcp-server#^anc-mcp-run-lifecycle]]；env 快照字段=[[docs/design/shared-providers#^anc-config-standalone-schema]]；缓存归属=[[docs/design/spec-ast]]。本节是唯一权威，各处引用不复制。

## Provider 接口

HopJIT 通过 Provider 接口与外部系统集成。不提供 Provider 时使用默认实现（Read/Write 受控工具 + SandboxConfig 四维度约束），保证 HopJIT 可独立运行。

```
HostConfig（实例化时注入，贯穿执行生命周期）
  ├─ workspace_dir: string                   # 工作目录（必填）
  ├─ sandbox: SandboxConfig                  # 四维度沙箱（filesystem/network/runtime/database）
  ├─ tool_provider?: ToolProvider            # 工具执行抽象（默认 = Read/Write 受控工具）
  ├─ knowledge_provider?: KnowledgeProvider  # 知识检索抽象（默认 = 无）
  ├─ identity_provider?: IdentityProvider    # 凭证管理（默认 = 环境变量/YAML 自动构建）
  ├─ api_key: string                         # LLM API key（最简配置 fallback）
  ├─ base_url?: string                       # API 代理网关
  ├─ model?: string                          # 全局默认模型
  ├─ model_engine?: ModelEngine              # 多模型路由配置
  └─ resource_limits?: ResourceLimits        # 执行预算

ToolProvider 接口:
  async execute(tool_name, tool_args) → Promise<ToolResult>
  list() → ToolDef[]    # ToolDef.requires_commit 声明副作用级别

KnowledgeProvider 接口:
  async retrieve(query, max_results) → Promise<KnowledgeFragment[]>

IdentityProvider 接口:
  async get_credential(service_id) → Promise<Credential | null>
  list_services() → ServiceEntry[]

PersistenceProvider 接口:
  init(instanceId, spec) / saveSnapshot(snapshot) / loadSnapshot() / exists()
```

**HopAnt 作为典型使用方**：CapabilityLayer → ToolProvider，KnowledgeLayer → KnowledgeProvider，IdentityLayer → IdentityProvider。但 HopJIT 不依赖 HopAnt——默认 Provider 实现覆盖全部独立运行功能。

**注入点**：
- **ExecutionEngine**：构造时接收 HostConfig，持久化到 `.hopstate/<id>/host_config.json`（api_key 脱敏）
- **StepDispatcher**：构造时接收 HostConfig + ExecutionEngine 实例，工具调用走 ToolProvider
- **PromptAssembler**：构造时接收 ExecutionEngine 接口 + KnowledgeProvider?（可选）

接口详细定义见 [[shared-types]]。

## 技术选型（行业对标）

| 模块 | 决策 | 依赖 | 理由 |
|------|------|------|------|
| **解析器** | 手写逐行解析器 | 零依赖 | remark 已评估并弃用——嵌套缩进、`+→` 输出、blockquote 指令均与 mdast 阻抗失配，手写 line-by-line 解析器（~680 行）更直接 |
| **状态机** | 自己写轻量版 | 零依赖 | XState v5 成熟但过重——HopSpec 步骤树是动态可变的（adaptive replan），XState 的 statechart 是静态定义的。实际需求是树遍历 + 状态标记 + retry 计数器，几百行自己写比引入 XState 更合适 |
| **Prompt 组装** | 自己写 | 零依赖 | 6 层 context 组装是 HopSpec 特有设计（祖先链、知识注入、全局进度摘要、迭代历史），无现成库可复用 |
| **LLM 调用** | Anthropic API（直调） | 零依赖 | hopjit 只需 tool_use loop（~400-500 行）+ ToolProvider 抽象，无需 CC SDK 的工具生态；模型自由、确定性控制、组件边界清晰 |
| **CLI** | commander.js | `commander` | 标准 CLI 框架，成熟稳定 |
| **CC Skill /hopspec** | 源 `driver/hopspec-skill.md`（@trace 派生自配套运行时，git 跟踪），部署副本 `.claude/skills/hopspec/SKILL.md` 开发期软链回源 | 无代码依赖 | 纯 markdown 驱动指令，复用模式驱动入口——CC 用 run + submit_and_fetch_next 应答循环驱动引擎（节奏归引擎）。**driver/ 是复用模式驱动指令的归属目录**，与 docs/design//examples//src/ 平级；Codex 等其他 runtime 载体将来并列于此。源↔副本：开发期软链（改源即生效）；分发期改实体+同步脚本 |
| **Codex Skill /hopspec** | `driver/codex/SKILL.md` + `agents/` + Codex references，安装到 `.agents/skills/hopspec/` | Codex Skill 机制；subagent 能力可选 | 有 subagent 时 main/segment-driver/parallel-worker 按主体拆分并批式 fan-out；无 subagent 时 Main inline 执行同一角色协议、parallel 串行降级，barrier/HITL/状态语义不变。正常交接直接传 NextResponse，不用 crash resume。见 [[docs/design/codex-driver-carrier]] |
| **Obsidian 插件** | `editors/obsidian/`（manifest+main.ts+styles,独立 esbuild 构建） | 零引擎依赖（识别器按语法参考独立实现,一致性测试对齐） | HopSpec 可视化：任意深度步骤折叠（markdown 6 级标题上限之上）/步骤大纲/落点四色高亮;`# Spec:` 头激活,普通 markdown 零打扰。见 [[docs/design/obsidian-plugin]] |
| **测试** | vitest | `vitest` | TS 原生，快速，兼容 Jest API |

### 排除项及理由

| 候选 | 排除理由 |
|------|---------|
| **XState v5** | actor 模型和 statechart 对静态状态图很强，但 HopSpec 步骤树是动态的（adaptive 可重写 children），用 XState 需要频繁重建状态图，反而增加复杂度 |
| **Mastra** | TS 原生 agent workflow 框架，设计模式值得参考（step retry、branch、suspend/resume），但有自己的 workflow DSL，和 HopSpec 语法不兼容，无法直接集成 |
| **LangGraph** | 面向 Python 生态，TS SDK 较薄；graph-based 编排与 HopSpec 的树状步骤结构有阻抗失配 |
| **DSPy** | 面向 prompt 优化而非 workflow 编排，解决的是不同层面的问题。但其 declarative prompting 理念与 HopSpec 的"锁定目标，放开路径"有精神共鸣，未来 prompt 组装优化时可参考 |
| **Claude Agent SDK** | SDK 解决的是"如何在代码里嵌入 Claude Code"，不是"如何精确控制 LLM 执行"。hopjit 需要的是 tool_use loop + 模型自由 + 确定性调度，~200 行直调 API 完全覆盖，SDK 的工具生态和上下文管理对 hopjit 无增量价值 |
| **Temporal / Inngest** | durable execution 核心场景（状态持久化 + crash recovery + HITL 暂停恢复）与 HopJIT 高度匹配，但引入 Go/JVM runtime + server 部署，对本地 CLI 工具过重。`.hopstate/` 目录以更轻量的方式覆盖了相同需求 |

### 参考但不直接依赖

- **Mastra 的模式**：step-level retry、workflow 状态管理、suspend/resume（对应 confirm）的实现思路
- **DSPy 的理念**：declarative prompting、自动优化——未来 PromptAssembler 的演进方向
- **XState + Restate**：durable execution 模式——未来 HopJIT 需要跨进程持久化时的参考方案

## 待细化

### 已解决（Run 1 + Run 2 Review）

- [x] hopjit next 返回的 JSON 结构 → [[exec-engine]] 接口契约
- [x] parallel 步骤的执行策略 → [[exec-engine]] 执行策略
- [x] 组件间通信协议 → [[exec-engine]] + [[hop-cli]] 接口契约
- [x] fail_step 完整 Spec → [[exec-engine]] impl fail_step
- [x] 崩溃恢复机制 → [[exec-engine]] 崩溃恢复
- [x] adaptive replan Agent-Engine 接口 → [[exec-engine]] 执行策略
- [x] call 子 Spec 执行模型 → [[exec-engine]] 执行策略
- [x] 验证失败行为链 → [[spec-parser]] SpecError + InitResponse
- [x] token budget 管理 → [[prompt-assembler]] Token Budget 管理
- [x] 多文件写入顺序 → [[exec-engine]] 崩溃恢复
- [x] Branch/Vars/Replan 响应类型 → [[exec-engine]] + [[hop-cli]] 接口契约
- [x] ErrorCode 分类 → [[exec-engine]] 接口契约
- [x] fail_step + parallel 交互 → [[exec-engine]] 执行策略
- [x] PromptAssembler 依赖注入 → [[prompt-assembler]]
- [x] PromptAssembler KnowledgeProvider 注入 + L1b 知识层 → [[prompt-assembler]]
- [x] vars/ 合并为 vars.json → [[exec-engine]] 状态持久化
- [x] iCloud 环境风险 → [[exec-engine]] 崩溃恢复

### 待实现时细化

- [x] SpecAST 的具体 TypeScript 类型定义 → [[spec-ast]]（Phase 1，已完成）
- [x] HITL 暂停协议：暂停信号 JSON 结构 + 回复注入机制 → [[shared-types]] + [[step-dispatcher]] + [[hop-cli]]（已完成）
- [x] commit 步骤 approve=false 时的结果类型 → approval 命名已统一（已完成）
- [ ] None 传播的变量依赖图数据结构（Phase 3）
- [ ] execution_log 被 .hoplog 吸收（Phase 3）→ .hoplog 写入器实现后 state.json 去掉 execution_log 字段，见 [[spec-observability]]
- [x] state.json 版本字段 + 格式迁移（Phase 1）→ [[exec-engine]] state.json 结构（format_version: 1）
- [ ] .hopstate/ 清理/GC 机制（Phase 5）
- [ ] call 环路检测（Spec ID 栈）（Phase 3）
- [x] CC Skill 职责：复用模式全程驱动（/hopspec run 完整执行循环）→ `.claude/skills/hopspec/SKILL.md`
- [x] StepDispatcher 的 tool_use loop 实现——直调 Anthropic API + ToolProvider 调度（Phase 5）→ [[step-dispatcher]]
- [ ] .hopstate/ 默认路径：本地文件系统（~/.hopstate/）以规避 iCloud rename 原子性问题 + CC worktree 隔离穿透（Phase 1）
- [x] LLM API 错误处理（rate-limit/auth/timeout）→ ErrorCode 扩展 + retry/backoff 策略 → [[step-dispatcher]] API 错误处理（Phase 5 前）
- [x] API 密钥管理规范（环境变量加载 + 安全约束）→ [[step-dispatcher]] API 密钥管理（Phase 5 前）
- [x] 成本护栏：tool_use 迭代上限 + token 预算 + adaptive replan 熔断 → [[step-dispatcher]] 成本护栏（Phase 5 前）
- [x] Provider 接口：ToolProvider/KnowledgeProvider/HostConfig/SandboxConfig → [[shared-types]]（HopAnt 对齐）
- [x] HostConfig 注入 + HITL checkpoint + 状态映射 → [[exec-engine]]（HopAnt 对齐）
- [x] 35 条验证规则枚举（spec-parser.md 验证规则章，已完成）（Phase 2 前）
- [x] 变量作用域规则（跨 call/subtask 边界）→ [[exec-engine]] 变量作用域（Phase 3 前）
- [x] StepDispatcher-to-Engine 通信模型决策（CLI-IPC vs 进程内 API）→ [[step-dispatcher]] 进程内 API 调用（Phase 3 前）
- [x] 解析器实现路线已定：采用手写 line-by-line parser（src/parser.ts），未使用 remark AST——HopSpec 的 `← →` `>` `[type]` 语法与缩进嵌套用逐行解析更直接可控
