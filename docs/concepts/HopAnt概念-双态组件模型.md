%% @trace
	id: cyant-concept
	type: intent
	note: 2026-08-08 作者定名 HopAnt（曾用名 CyAnt，归队 Hop 全家桶；蚁的意象=小组件各司其职经 HopSpec 编排协作涌现复杂能力，是架构承诺非装饰比喻）。同日作者定：HopAnt 有两个具体部署形态——HopSkill 与 HopAgent。id 与锚点 ID 保持 cyant 不动（追溯链稳定优先）
%%

# HopAnt（智蚁）：双态组件模型

> 概念探索阶段

## 两个部署形态【决策：原则性，2026-08-08 作者定】 ^anc-struct-hopant-deploy-forms

HopAnt 是组件模型（是什么、有什么能力、持有什么状态），部署到运行环境时有两个具体形态：

- **HopSkill**：部署为宿主 agent 的技能——复用模式，宿主（CC/Codex 等）是推理大脑与执行躯干，HopAnt 以 skill 形态（SKILL.md + spec + 资产）寄生于宿主会话。`hopjit pack` 产出的具名 skill（`/coffee-week`、`$coffee-week`）即此形态。
- **HopAgent**：部署为自主运行的 agent——独立模式，HopJIT 引擎直调 LLM API（standalone MCP server / dispatcher），不依赖宿主会话，可无人值守、可路由低成本模型。

两形态共享同一 HopAnt 定义与同一 Spec（Spec 不感知部署形态——绑到哪个形态是部署配置的事，不是语法的事，见"Spec 保持独立"）。命名忠实：HopSkill 之所以叫 skill=它确实是宿主的技能；HopAgent 之所以叫 agent=它确实自主运行。二者是**部署形态**而非组件类别——同一 HopAnt 可先以 HopSkill 形态在宿主内验证，再以 HopAgent 形态无人值守部署（渐进固化路径）。

## 动机

HopSpec 解决了"做什么、怎么做"——是 agent 时代的 `impl`（行为定义）。但缺少 `struct`——**组件本身的定义**：它是什么、有什么能力、持有什么状态。[[HopType体系]] 填补了这个缺口，提供 struct/impl/HopTrait 的类型与组合机制（Hop 概念三件套定位见该文）。

HopAnt（智蚁）是 HopType 体系下的基本组件单元——一个具体的 struct 应用。小组件各司其职，通过 HopSpec 编排协作，涌现出复杂能力。

## 核心洞察：双态融合在组件级别

HopSpec 本身就是双态融合的载体：Steps 中的 `act` 是确定性代码执行，`reason` 和 `check` 是 LLM 推理节点。**双态融合 = 用 HopSpec 的确定性结构化代码控制 LLM 的非确定性智能节点。** 这个模式在组件级别同样成立：

- 一个 HopAnt 可以是**传统代码组件**（Python class、TypeScript module、Java service）——所有 Spec 的 Steps 只用 `act`
- 一个 HopAnt 可以是**LLM Agent**（拥有工具、知识域、推理能力）——Steps 以 `reason`/`check` 为主
- 一个 HopAnt 可以是**混合体**——部分 Spec 由代码实现（纯 `act`），部分靠 LLM 推理（`reason`/`check`）

调用方只 `call` Spec，不关心对面是代码还是 LLM。**HopSpec 是组件间的通用接口语言。**

## 组件模型 ^anc-struct-cyant

**HopSpec 定义逻辑（做什么、怎么做），HopAnt 提供能力和记忆（用什么做、状态存在哪）。**

HopAnt 是 Spec 的运行基座：
- **提供能力**：工具集、API、知识库、推理能力——Spec 中的 `act`/`call` 实际调用的是 HopAnt 提供的能力
- **记录状态**：跨 Spec 执行的持久状态（记忆、配置、累积数据），实例各自持有

`struct` 定义（类型）= 能力声明 + 状态字段（Fields）+ 绑定的 Spec 清单。HopAnt（实例）= 具体的能力实现 + 自己的状态副本。

**Spec 保持独立**：Spec 层面不感知 HopAnt，照常写 Goal/Inputs/Outputs/Steps。HopJIT 执行时知道当前 Spec 运行在哪个 HopAnt 实例上，隐式注入能力和状态上下文。Spec 本身是独立的、可复用的，绑到哪个 HopAnt 上是部署配置的事，不是语法的事。

`call` 的目标从"一个独立 Spec Id"扩展为"某个 HopAnt 实例的某个 Spec"。

一个 HopAnt 需要回答四个问题：去哪找知识？能用什么工具？数据存在哪？以谁的身份执行？这四个问题关注点分离，因此拆为四个独立 struct。

> **Knowledge vs Data 判定原则**：只要是**知识**（术语、术语关系、Spec 逻辑、文档语义），走 KnowledgeLayer；不是知识的**结构化信息**（数据库表、API 返回、配置状态），走 DataLayer。四个维度不是严格正交（Knowledge 和 Data 在数据源层面可能重叠），而是关注点分离——检索语义 vs 查询结构。v1 聚焦三类知识：术语、术语关系、Spec 逻辑。

## HopAnt 组合

```
struct: HopAnt
  Id: cyant
  Fields:
    - knowledge: KnowledgeLayer    # 知识检索能力
    - capability: CapabilityLayer  # 工具与执行环境
    - data: DataLayer              # 数据访问
    - identity: IdentityLayer      # 身份与权限
  Specs:
    - run_spec    # 通过 ExecutionEngine 执行 HopSpec
    - introspect  # 返回自身能力摘要（可用工具/知识域/权限范围）
```

HopAnt 由四个独立维度组合而成，每个维度是独立的 struct（可带 trait）：

**HopAnt 核心 trait**：

```
# Spec: 执行 HopSpec
Id: run_spec
Goal: 在当前 HopAnt 实例的能力和权限上下文中执行指定 Spec，支持 HITL 挂起/恢复

Inputs:
- spec_id: line            # 要执行的 Spec 标识
- inputs: yaml             # Spec 的输入参数
- execution_id: line       # 恢复执行时传入（首次执行为空）
- options: yaml            # 执行选项（超时/重试/日志级别，可选）

Outputs:
- execution_id: line       # 本次执行标识（用于恢复）
- status: enum(completed, waiting_human, failed, timeout)
- result: yaml             # completed 时：Spec 执行结果（Outputs 的值）
- checkpoint: yaml         # waiting_human 时：当前步骤、等待的 check 内容、已有上下文
- trace: yaml              # 执行轨迹摘要（步骤序列/耗时/工具调用记录）

Constraints:
- Spec 必须已注册或可解析
- 执行受当前 IdentityLayer 的权限约束
- 执行环境受 CapabilityLayer.sandbox 约束（沙箱由宿主环境注入，见下）
- 超时由 options 或 CapabilityLayer.resource_limits 决定
- waiting_human 时执行状态必须可序列化持久化，凭 execution_id 可恢复
- completed / failed / timeout 为终态，不可恢复
```

```
# Spec: 自省能力
Id: introspect
Goal: 返回当前 HopAnt 实例的能力摘要，供其他 HopAnt 发现和选择协作对象

Inputs:
- scope: enum(all, knowledge, capability, data, identity)  # 查询范围（默认 all）

Outputs:
- specs: [line]            # 可执行的 Spec 列表
- tools: [line]            # 可用工具列表
- knowledge_domains: [line] # 知识域标识列表
- permissions: yaml        # 权限摘要

Constraints:
- 只返回当前身份有权查看的信息
- 不泄露内部实现细节（如 API key、内部路径）
```

| 维度 | 职责 | 核心问题 |
|------|------|---------|
| **KnowledgeLayer** | 知识检索与积累 | 步骤执行时去哪里找上下文知识？ |
| **CapabilityLayer** | 工具与执行环境 | 能用什么工具、在什么沙箱内？ |
| **DataLayer** | 数据访问与持久化 | 结构化数据从哪来、往哪存？ |
| **IdentityLayer** | 身份与权限 | 谁在执行、以谁的身份调 API、边界在哪？ |

### HopAnt 与执行基础设施的关系

HopAnt 是主体，执行基础设施是它的内部工具：

```
HopAnt（智蚁实例）
  ├─ KnowledgeLayer   ← PromptAssembler 从这里动态检索知识
  ├─ CapabilityLayer  ← StepDispatcher 从这里获取工具和沙箱
  ├─ DataLayer        ← ExecutionEngine 从这里读写数据
  ├─ IdentityLayer    ← 所有 API 调用以这里的身份进行
  │
  └─ .run_spec()      → ExecutionEngine + StepDispatcher + PromptAssembler
                        （执行基础设施是 HopAnt 调用 Engine 的内部实现）
```

HopJIT 执行引擎由 5 个组件构成，是 HopAnt 调用 `run_spec` 时的内部实现：

- **SpecParser**：将 HopSpec 文本解析为 AST，校验验证规则 ^anc-struct-spec-parser
- **ExecutionEngine**：执行状态机——管理步骤状态、变量命名空间、retry/adaptive、失败升级（函数级 fail） ^anc-struct-exec-engine
- **PromptAssembler**：为 reason/check 步骤组装 6 层 prompt context（L1 Spec 契约 → L6 输出约束） ^anc-struct-prompt-assembler
- **StepDispatcher**：步骤分派——按类型路由执行（reason→调 LLM、act→调工具、confirm→暂停等待） ^anc-struct-step-dispatcher
- **HopCLI**：Agent 与执行引擎的交互接口（init / next / done / fail / status） ^anc-struct-hop-cli

## 四维度定义

### KnowledgeLayer（知识） ^anc-layer-knowledge

**HopTrait（Hop契约）**：

```
# Spec: 检索相关知识
Id: retrieve
Goal: 根据查询从已注册知识源中检索相关片段

Types:
  KnowledgeFragment:
    - source_id: line              # 来自哪个知识源
    - content: text                # 片段内容
    - relevance: enum(high, medium, low)  # 相关度

Inputs:
- query: text              # 检索查询
- max_results: int      # 最大返回条数（默认 10）

Outputs:
- fragments: [KnowledgeFragment]   # 检索结果列表

Constraints:
- 按相关度降序排列
- 去重（同一来源同一段落不重复）
```

**struct**：

```
struct: KnowledgeLayer
  Id: knowledge-layer
  Types:
    KnowledgeSource:
      - id: line                     # 知识源标识
      - type: enum(file_glob, grep, rag)  # v1 三种知识源类型
      - config: yaml                 # 类型相关配置（路径/endpoint/索引名）
  Fields:
    - sources: [KnowledgeSource]   # 已注册的知识源
  Specs:
    - retrieve     # impl trait
```

v1 最小集：一个 `retrieve` trait 就够。知识源的类型和检索策略由 KnowledgeSource 自身决定——注册时声明，retrieve 时路由。

**HopJIT 映射**：PromptAssembler 的 L2 知识上下文层由 KnowledgeLayer 驱动，双路径注入：主动路径（Spec `@knowledge` 声明预检索）和被动路径（`lack_of_info` 触发补充检索，标注来源步骤）。详见 [[HopSpec V3核心规范#^anc-exec-prompt-assembly]]。

### CapabilityLayer（能力） ^anc-layer-capability

**HopTrait（Hop契约）**：

```
# Spec: 执行工具调用
Id: execute_tool
Goal: 在沙箱约束内执行指定工具

Inputs:
- tool_name: line          # 工具名称
- tool_args: yaml          # 工具参数

Outputs:
- result: text             # 执行结果
- success: bool            # 是否成功

Constraints:
- 工具必须在已注册列表中
- 执行受沙箱策略约束（路径/命令/网络）
- 超过 resource_limits 时拒绝执行
```

**struct**：

```
struct: CapabilityLayer
  Id: capability-layer
  Fields:
    - tools: [ToolDef]             # 可用工具注册表（待细化）
    - sandbox: SandboxConfig       # 沙箱配置（由宿主环境注入，见下）
    - api_clients: [ApiClient]     # LLM 和外部 API 客户端（待细化）
    - resource_limits: yaml        # 资源限制（token 预算/工具调用上限/超时）
  Specs:
    - execute_tool    # impl trait
    - list_tools      # 返回当前可用工具及其 schema
    - register_tool   # 动态注册新工具
```

**HopJIT 映射**：替代 StepDispatcher 硬编码的 Bash/Read/Write 工具——act 步骤通过 `CapabilityLayer.execute_tool()` 调用注册的工具，工具副作用级别由 `requires_commit` 声明，执行范围由沙箱配置约束。

**沙箱与宿主环境**：sandbox 由宿主环境（如 Claude Code）在 HopAnt 实例化时注入，定义 act 步骤能安全触及的资源边界。沙箱覆盖四种资源类型： ^anc-config-sandbox-model

**① 受控文件目录（filesystem）**： ^anc-config-sandbox-filesystem
- workspace_dir：宿主分配的工作区子目录，act 步骤可自由写、删、试验
- read_access：三级读取控制——allowed（可自由读）、denied（禁止，如密钥文件）、confirm_required（需 confirm 后读取）
- workspace 外的写/删/移动 = commit 级别

**② 网络访问（network）**： ^anc-config-sandbox-network
- web search / fetch 按域名可信分级，宿主配置可信域名白名单
- 可信域名内的只读查询（search/fetch）= act 级别
- 不可信域名或有副作用的网络操作（POST/PUT/发邮件）= commit 级别

**③ 已安装库与工具（runtime）**： ^anc-config-sandbox-runtime
- 声明当前环境可用的运行时能力：uv python / TypeScript / PDF 解析 / OCR 等
- act 步骤可调用已声明的库执行本地计算（在 workspace 内）
- 安装新库、修改系统依赖 = commit 级别

**④ 数据库（database）**： ^anc-config-sandbox-database
- 临时库（temp_databases）：act 步骤可自由读写——临时库可重建，重做安全
- 只读库（readonly_databases）：act 步骤可查询，写入需 commit
- 未声明的数据库：全部禁止访问
- schema 变更（CREATE/DROP/ALTER）：始终需要 commit
- 典型场景：agent 在临时库做数据清洗（act），验证通过后写入生产库（commit）

**工具副作用声明**：每个工具注册时声明 `requires_commit`——标记该工具是否有不可逆副作用。act 步骤中 `requires_commit=true` 的工具调用被 StepDispatcher 自动拦截。Spec 作者可选择在 commit 前放置 confirm 步骤来保护不可逆操作。 ^anc-exec-requires-commit

安全模型的核心原则：**act 步骤内一切操作可安全重做**（workspace 内自由试验 + 只读外部访问 + 本地计算），commit 步骤的安全性由 Spec 流程保障（作者显式设计 confirm 保护），而非运行时自动审批。 ^anc-exec-sandbox-principle

### DataLayer（数据） ^anc-layer-data

**HopTrait（Hop契约）**：

```
# Spec: 查询数据
Id: query_data
Goal: 从已注册数据源执行结构化查询

Inputs:
- source_id: line          # 目标数据源
- query: text              # 查询表达式（SQL / 文件路径 / API 请求）

Outputs:
- rows: yaml               # 查询结果
- row_count: int        # 结果行数

Constraints:
- 只读操作，不修改数据源
- 查询超时由 DataSource 配置决定
```

**struct**：

```
struct: DataLayer
  Id: data-layer
  Fields:
    - connections: [DataSource]    # 数据源注册（待细化）
    - schema_cache: yaml           # 已知数据结构缓存（待细化）
    - state_dir: line              # .hopstate/ 路径
  Specs:
    - query_data   # impl trait
    - persist      # 持久化执行产物（超越 vars.json 的 KV）
    - discover     # 发现数据源 schema
```

**HopJIT 映射**：替代 vars.json 的扁平 KV——步骤可查询数据库、读写结构化文件、与外部数据服务交互。

### IdentityLayer（身份） ^anc-layer-identity

**HopTrait（Hop契约）**：

```
# Spec: 获取服务凭证
Id: get_credential
Goal: 按服务标识获取身份凭证（API key、ak/sk、token 等）

Inputs:
- service_id: line         # 目标服务标识（'tavily' / 'openai' / 'anthropic' 等）

Outputs:
- credential: yaml         # 凭证信息（type + values）

Constraints:
- 凭证不可日志明文输出
- 未注册服务返回 null，调用方决定是否 fail
```

**struct**：

```
struct: IdentityLayer
  Id: identity-layer
  Fields:
    - credentials: yaml            # 服务凭证注册表（service_id → Credential）
    - llm: ModelEngine             # LLM 绑定配置 ^anc-config-model-engine
  Specs:
    - get_credential  # impl trait：按 service_id 查找凭证
    - list_services  # 列出已注册的可用服务
    - authenticate   # 验证身份（API key 有效性/用户 session）（v2+）
    - audit_log      # 记录操作审计日志（谁/何时/做了什么/以谁的身份）（v2+）
```

**ModelEngine 细化**：

```
- ModelEngine:  # LLM 多模型绑定配置
  - default_service: line  # 默认 LLM 服务标识（如 'anthropic'）
  - default_model: line  # 默认模型（如 'claude-sonnet-4-6'）
  - routing_rules: [ModelRoute]  # 按步骤类型/标注路由到不同模型

- ModelRoute:  # 模型路由规则
  - match: line  # 匹配条件：step_type 值（reason/check/act）
  - service: line  # 目标服务标识
  - model: line  # 目标模型名
```

**路由优先级**（从高到低）： ^anc-exec-model-routing

1. 步骤级 `@model` 标注——步骤 `>` 指令区声明 `@model service/model`，最高优先级
2. Spec 级 `Config.model`——整个 Spec 的默认模型
3. `ModelEngine.routing_rules`——按 step_type 匹配的全局规则（如 reason→DeepSeek, check→Claude）
4. `ModelEngine.default_model`——兜底默认

典型场景：reason 步骤用 DeepSeek V4 Pro 做主推理（成本低、速度快），check 步骤用 Claude 做独立核验（交叉验证，避免模型自我一致性偏差）。

**HopJIT 映射**：替代 config.json 的单 api_key 硬编码——步骤调用外部服务（搜索 API、外部 LLM 等）时通过 `get_credential(service_id)` 获取凭证。工具的副作用级别由 ToolDef.requires_commit 声明，act 步骤中自动拦截不可逆工具，IdentityLayer 专注凭证管理。ModelEngine 管理 LLM 调用的模型选择和路由。

**凭证传递**：HopJIT 以 CLI 子进程方式被宿主启动，通过继承环境变量获取凭证——`ANTHROPIC_AUTH_TOKEN`（CC 本地代理） 或 `ANTHROPIC_API_KEY`（直连），加 `ANTHROPIC_BASE_URL`（代理网关）和 `ANTHROPIC_MODEL`（当前模型）。多服务路由时按 `{SERVICE_ID}_API_KEY` + `{SERVICE_ID}_BASE_URL` 模式扩展。YAML 配置文件（`~/.hopjit/config.yaml`）作为 fallback 和路由规则存储。

## 待探索

### 需要设计方向的阻塞项

- [ ] **HopAnt 实例化机制**：配置文件驱动（YAML 声明四个 Layer 的绑定）vs 代码构造（TypeScript/Python API）。倾向配置驱动——与 HopSpec 的声明式风格一致
- [ ] **call 寻址语法**：`call` 目标从"Spec Id"扩展为"HopAnt 实例的 Spec"。需要 SpecParser 语法扩展，初步方向：`call cyant_id.spec_id`（点号分隔，与字段访问一致）
- [ ] **Layer 间错误传播**：`get_credential()` 返回 null（未注册服务）→ 调用方决定 fail 或降级；`retrieve()` 失败 → 降级执行（无知识上下文），不阻塞步骤；act 步骤调用 requires_commit 工具 → COMMIT_REQUIRED 错误；Layer 初始化失败 → 阻塞 HopAnt 实例化，fail-fast


### 后续细化

- [ ] 四维度 struct 的 Fields 类型细化（ToolDef / DataSource / UserProfile / AgentProfile / SandboxConfig 等）
- [x] ModelEngine 细化（多模型路由配置 + ModelRoute + 路由优先级）
- [ ] HopAnt 的生命周期管理（创建/暂停/恢复/销毁）
- [ ] 多 HopAnt 协作模式（不只是 parallel，还有协商、竞争、委托）
- [ ] Knowledge 与 RAG 的集成方案
- [ ] Identity 的权限模型细化（RBAC vs ABAC vs 简单白名单）
- [ ] Data 的事务语义（跨步骤的数据一致性）
- [x] 四维度的 trait 抽象——每个 Layer 一个同名 trait，定义最小 Spec 契约（Inputs/Outputs/Constraints）
- [x] HopAnt 顶层 trait（run_spec / introspect）
