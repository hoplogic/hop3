%% @trace
	id: hopjit-shared-providers
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-22T20:02+0800
	note: shared-providers 模块设计——Provider 三件套接口(Tool/Knowledge/Identity+Persistence/Spec) + 宿主配置类型(HostConfig/Sandbox/ModelEngine/ResourceLimits)。引擎内核↔宿主的契约边界。2026-07-02 从 shared-types.md 抽出独立成文。
%%

# shared-providers 模块设计

引擎内核↔宿主环境的**契约边界**（`provider-types.ts`）——Provider 三件套接口（Tool/Knowledge/Identity + Persistence/Spec）+ 宿主配置类型（HostConfig/SandboxConfig/ResourceLimits/ModelEngine）。只声明契约形状，实现分散在 tools/persistence/dispatcher。被 engine/dispatcher/cli/tools/persistence 全员消费。

HopAnt 作为典型使用方：CapabilityLayer → ToolProvider，KnowledgeLayer → KnowledgeProvider，IdentityLayer → IdentityProvider。

> **里程碑分期（v2 计划，非债）**：概念层 HopAnt 四维度（Knowledge/Capability/Data/Identity）在 v1 落地为 3 个 Provider（ToolProvider/KnowledgeProvider/IdentityProvider）。DataLayer 由 vars.json 扁平 KV 隐式承担，v2 拆分为独立 DataProvider（[[roadmap#v2-2 HopAnt 第四维度]]）；authenticate/audit_log 标 v2。
>
> 这是计划内的能力分期（非设计↔代码不一致），判据见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-milestone]]。

## 关键决策【决策】

本模块涉及的不可推演人为决策集中于此，逐个接口章节为这些决策的契约化落地。

**Provider 三件套作为引擎内核↔宿主环境的契约边界**：HopJIT 引擎内核（Engine/Dispatcher）不直接触碰外部系统，一律经 ToolProvider（能力）/ KnowledgeProvider（知识）/ IdentityProvider（身份）三个接口与宿主交互。

这是概念层 HopAnt 四维度在 v1 的落地选择——三件套划定了"引擎内核"与"宿主环境"的责任分界，使 HopJIT 既能默认独立运行（DefaultToolProvider + 环境变量身份），又能被 HopAnt 等宿主注入完整能力。DataLayer 维度 v1 由 vars.json 隐式承担，v2+ 拆分为独立 DataProvider。

**DefaultToolProvider 只提供 Read/Write，不含 bash**：默认实现刻意不暴露 bash——bash 是高危工具（任意命令执行、不可控副作用），仅 commit 步骤可用，且必须由宿主注入的 ToolProvider 显式提供并自行实现 runtime 白名单校验。这道边界保证"开箱即用"的 HopJIT 不会因默认能力过宽而在 act 步骤产生不可逆后果。

**requires_commit 作为工具副作用声明**：工具注册时通过 `requires_commit: boolean` 声明自身是否有不可逆副作用，而非由调用方猜测。这把"工具是否危险"的判断从分散的调用点收敛到工具定义处。StepDispatcher 在 act 步骤自动拦截 `requires_commit=true` 的工具，commit 步骤放行——安全性由 Spec 流程（可叠加 confirm 保护）保障。

---

## shared-providers 模块定位【契约】 ^anc-struct-shared-providers

> **模块版本**：shared-providers `v0.14.0`（2026-09-20）。本版=ProviderEntry 新增可选 thinking 键（provider 级思考缺省显式化——端点缺省互相相反且不可见,同 spec 换模型思考行为静默翻转;作者定'统一'的落点=配置层显式化,0100 批;env 键 {SERVICE_ID}_THINKING 同披,两处清单义务同批履行）。
>
> - 上版 v0.13.0（2026-09-18）=schema 权威补账两键+auth 生效面契约。工程链 review 面一/面二/面四三面同抓:ProviderEntry struct 补 auth 行〔含 defaultClient 生效面与 bearer 双臂关键逻辑——原实装只罩显式路由,缺省 provider 路径漏装同批代码修复〕/StandaloneConfig struct 补 revision_prompt 行/"八节"清单句升十节与配置参考对齐。
>   struct 自称唯一定义处而字段漏登,是 v0.12.1 同型病第三犯,本版起新增顶层键两处清单同批改列为本句执行义务；
> - 上版（v0.12.2）=出口表补 ENGINE_DEFAULT_MODEL 常量（0086 续账:缺省模型单一事实源,两消费点同改）；
> - 上版（v0.12.1）0084 批一随批:struct StandaloneConfig 补 resource_limits（九键全列含 max_concurrent_runs）与 language 两权威键（review 面一抓实改未升号,补记）；
> - 0.x 未承诺稳定。Provider 三件套接口 + HostConfig/Sandbox 是宿主契约——引擎内核↔宿主的边界，破坏影响所有 caller/宿主注入。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。

**① 自身定位**：shared-providers（`provider-types.ts`）定义**引擎内核↔宿主环境的契约边界**——Provider 三件套接口（Tool/Knowledge/Identity + Persistence/Spec）+ 宿主配置类型（HostConfig/SandboxConfig/ResourceLimits/ModelEngine）。
它只声明**契约形状**，不含实现（DefaultToolProvider 等实现在 tools 模块，FilePersistence 等在 persistence 模块）。被 engine/dispatcher/cli/tools/persistence 全员消费。

**② 边界**：**负责** Provider 接口 + Config 类型的纯声明；**不碰** 任何实现/运行时行为（实现分散在 tools/persistence/dispatcher）。

**③ 对外接口清单【封闭】** ^anc-struct-shared-providers-exports：

> 出口文件 = `provider-types.ts`。表外即内部。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `ToolProvider` / `ToolDef` / `ToolResult` / `WriteScope` | 类型 | provider-types.ts | 工具能力接口（engine/dispatcher/tools 消费;WriteScope=写域分域信号,2026-08-28） | stable |
| `KnowledgeProvider` / `KnowledgeFragment` | 类型 | provider-types.ts | 知识检索接口（prompt/dispatcher 消费） | stable |
| `PersistenceProvider` | 类型 | provider-types.ts | 快照存取接口（engine/persistence 消费） | stable |
| `HostConfig` | 类型 | provider-types.ts | 宿主环境配置（engine/cli/dispatcher 注入） | stable |
| `SandboxConfig` | 类型 | provider-types.ts | 沙箱配置（tools/dispatcher/doc-ref 消费） | stable |
| `ModelEngine` / `ModelRoute` | 类型 | provider-types.ts | 模型路由配置（dispatcher 消费） | provisional |
| `RoutingCategory` / `ROUTING_CATEGORIES` | 类型+常量 | provider-types.ts | 模型路由类别（act/commit/reason/check/replan——类型与运行期闸同源,消 ModelRoute 类型与类别枚举双向失配） | provisional |
| `ENGINE_DEFAULT_MODEL` | 常量 | provider-types.ts | 引擎缺省模型单一事实源（dispatcher 路由兜底+install-skill CC 缺省两消费点——0086 续账修:原各写死字面量,引擎升缺省 install 侧静默旧值） | provisional |
| `SpecProvider` / `SpecSource` | 类型 | provider-types.ts | call 子 spec 解析接口与源结构（dispatcher 独立模式 call 递归消费,缺省实现 DirSpecProvider 在 dispatcher——DEBT-04 实装时从"内部"转正,本表漏随更） | stable |
| `credentialLikeHopEnvKey` | 函数 | provider-types.ts | hop_env 凭证形态键名闸（覆盖链三级共用——mcp-server 配置/params 级、cli params 级、engine ask 级;0004） | stable |
| `ENGINE_BUILTIN_SPECIAL_TOOL_NAMES` | 常量 | provider-types.ts | 引擎内建特殊工具族名单（树编辑四件+validate_spec+read_spec_tree——prompt 层1 L4 通道分道消费,名单住共享层 0 层向依赖才合法;与 DefaultToolProvider 注册面同源性由 tools.test.ts 钉住,9332adaf 定层时漏登本表,审计 symbol_not_public 抓后补） | provisional |
| `hopEnvCredentialError` | 函数 | provider-types.ts | 三级共用拒收报文（响亮+指路 api_key_env） | stable |

> **内部（表外即内部）**：`IdentityProvider`/`Credential`/`ServiceEntry`/`SpecEntry`（接口形状已定但暂无跨模块 import——v1 未实装）、`FilesystemSandbox`/`NetworkSandbox`/`RuntimeSandbox`/`DatabaseSandbox`/`ResourceLimits`（经 HostConfig/SandboxConfig 暴露，不单独 import）。

> **PersistenceProvider 接口**在下方定义（`^anc-provider-persistence-iface`），其实现模块见 [[persistence]]。

### ToolProvider 接口 ^anc-provider-tool

> **注**：`ToolProvider` 接口定义在本模块（provider-types.ts）；此锚点是该**成员接口**的行为锚点（区别于模块身份锚点 `^anc-struct-shared-providers`）。tools 模块的 `DefaultToolProvider` 是它的实现（见 [[tools]]）。

**能力契约（HopTrait）**：

```
# Spec: 工具执行
Id: tool-provider-execute
Goal: 按名执行一次工具调用，返回结构化结果
Inputs:
- tool_name: line
- tool_args: yaml
- write_scope: enum(work_zone,workspace)  # 可选。调用方步骤语境的写域声明（act/check→work_zone,commit→workspace;缺省按 work_zone 窄域处理,信号缺席不静默放宽）——内置文件工具写侧六件消费,外部/宿主工具自然忽略。见 [[tools/file-tools#^anc-exec-builtin-file-tools]] 分域条款(2026-08-28)
Outputs:
- result: ToolResult

# Spec: 工具清单
Id: tool-provider-list
Goal: 列出本 Provider 注册的全部工具定义（引擎注入 prompt/校验用）
Outputs:
- tools: [ToolDef]
```

```
struct: ToolResult
  Id: tool-result
  Fields:
    - result: yaml        # 字符串或结构化对象——为对象时序列化传入 API messages 统一为 JSON 字符串
    - content_type: line  # 可选。枚举 text/json，默认 text——仅供消费端决定是否 JSON.parse 还原
    - success: bool
    - audit: yaml         # 可选。审计元信息随 HopLog tool: 块（^anc-obs-audit）：server（外部归属,Composite 装配层填）/duration_ms（耗时）/discarded_text_blocks（多 text 块取首块的丢弃计数,binding 层填——0006 留痕;十一审补登:audit 字段实装于工具接口批,struct 漏登存量欠+0006 新字段一并清）

struct: ToolDef
  Id: tool-def
  Fields:
    - name: line
    - description: line
    - input_schema: yaml     # JSON Schema 格式
    - requires_commit: bool  # true = 有不可逆副作用，仅 commit 步骤可调用
    - category: line         # basic | special（缺省 special——basic=基础文件族零声明恒可用,special=须节点 `- 工具:` 声明才对无 body 的 act 可用;分档语义权威 [[tool-interface]] v0.6.0,0054 批引入本表补登）
    - returns: line          # 可选。返回值形状一句话人读描述（L4 清单渲染"返回:"行的料源——内置件逐件如实写;外挂件不用此字段,其形状归注册面 output_schema。^anc-exec-tool-manifest-supply）
```

（TS 形态是代码层投影，在 src/provider-types.ts——设计以本 HopType 为准；下同，本文其余接口不再逐个注记。）

工具安全模型：工具注册时通过 `requires_commit` 声明副作用级别。StepDispatcher 在 act 步骤中自动拦截 `requires_commit=true` 的工具调用。commit 步骤可调用所有工具，安全性由 Spec 流程保障（Spec 作者可选择 confirm 保护）。 ^anc-exec-requires-commit

默认实现（`DefaultToolProvider`，见 [[tools]]）：
- `execute`：支持内置文件/目录工具组十一件（read/listdir/exists/search_file/write/create/append/edit_file/makedirs/move/remove，全表与约束见 [[tools/file-tools#^anc-exec-builtin-file-tools]]；无 bash——bash 属高危工具，仅 commit 步骤可用）
- `list`：返回十工具定义，全部 requires_commit=false（不可逆分界=是否出沙箱，非操作类型）——写侧由 SandboxConfig.filesystem.workspace_dir 约束+禁 `.hopstate/`
- 宿主注入的 ToolProvider 可注册 requires_commit=true 的工具（如发邮件、写生产库、调用外部付费 API 等），act 步骤中自动拦截

### KnowledgeProvider ^anc-provider-knowledge

**能力契约（HopTrait）**：

```
# Spec: 知识检索
Id: knowledge-provider-retrieve
Goal: 按 query 检索宿主知识片段，供 prompt L2 注入
Inputs:
- query: line
- max_results: number
Outputs:
- fragments: [KnowledgeFragment]
```

```
struct: KnowledgeFragment
  Id: knowledge-fragment
  Fields:
    - source_id: line
    - content: text
    - relevance: line  # 枚举 high/medium/low
```

默认实现：无（不提供时 PromptAssembler 跳过知识注入层，L1 恢复全部 token 预算）。

### PersistenceProvider 接口 ^anc-provider-persistence-iface

> **实现模块见 [[persistence]]**（persistence.ts，模块锚点 `^anc-provider-persistence`）。本节是 PersistenceProvider 接口契约（引擎状态快照存取抽象，支撑双模式驱动）。

**能力契约（HopTrait）**——五个方法：`init(instanceId, spec)` 创建实例存储空间 / `saveSnapshot(snapshot)` 状态+变量原子保存 / `loadSnapshot()` 恢复（resume 用）/ `exists()` 是否有可恢复状态 / `getWorkZone()` 实例 work_zone 绝对路径（driver @file 临时文件区；Memory 实现返回空串=无文件区）。

```
struct: EngineSnapshot
  Id: engine-snapshot
  Fields:
    - spec: SpecAST    # replan 演化后的现行 AST
    - state: StateFile # 执行态全集（步骤状态/重试/循环计数/在飞记账等）——字段权威见 runtime-types.ts StateFile 与 [[exec-engine#^anc-exec-state-persistence]]，此处不复制清单
    - vars: VarsFile   # 变量空间（v2 scope 树）
```

- **FilePersistence**（复用模式）：快照 ↔ `.hopstate/<instance_id>/` 文件。CLI 每个命令是独立进程，状态必须外置存活
- **MemoryPersistence**（独立模式，默认）：进程内快照。Dispatcher 驱动完整生命周期，无需跨进程

职责边界：Provider 只管快照存取。crash recovery 的状态修复逻辑（running→pending 重置、branch 选择保留）属于 Engine 业务，留在 `ExecutionEngine.resume()`。实现要点与实装状态见 [[persistence]]。

### IdentityProvider ^anc-provider-identity

**能力契约（HopTrait）**——两个方法：`get_credential(service_id)` 取外部服务凭证（无则 null）/ `list_services()` 列出可用服务。

```
struct: Credential
  Id: credential
  Fields:
    - type: line    # 枚举 api_key/ak_sk/bearer_token/oauth
    - values: yaml  # 键值对——如 { api_key: 'xxx' } 或 { access_key: 'xxx', secret_key: 'yyy' }

struct: ServiceEntry
  Id: service-entry
  Fields:
    - service_id: line   # 如 tavily / openai / anthropic
    - description: line
```

IdentityProvider 为外部服务调用提供身份凭证（API key、ak/sk、token 等）。StepDispatcher 在调用外部服务前通过 `get_credential(service_id)` 获取凭证。

默认实现（`DefaultIdentityProvider`）：从环境变量继承宿主凭证。解析顺序：`ANTHROPIC_AUTH_TOKEN`（bearer_token）> `ANTHROPIC_API_KEY`（api_key）> `HostConfig.api_key`（仅 programmatic 内存注入）。

- 配置文件只保存 `api_key_env` 名称，由配置加载器解引用后注入 HostConfig；禁止读取配置文件中的明文 key。多服务按 `{SERVICE_ID}_API_KEY` + `{SERVICE_ID}_BASE_URL` 模式扫描环境变量自动注册；
- provider 可选 `auth: bearer` 档（2026-09-18——anthropic 协议客户端缺省发 x-api-key〔SDK apiKey 通道,authToken:null 切断隐式 Bearer〕,只认 Authorization: Bearer 的网关〔实测百炼 claude-code-proxy〕经此档走 SDK authToken 通道;路由 env 键 `{SERVICE_ID}_AUTH=bearer` 传递,与 _PROTOCOL 同披）。

> **里程碑分期（v2 计划，非债）**：`IdentityProvider` 当前仅定义接口形状（`provider-types.ts` 的 `interface IdentityProvider` + `HostConfig.identity_provider` 注入位），`DefaultIdentityProvider` 实现类、`get_credential`/`list_services` 行为、多服务环境变量扫描**均未实装**。
>
> - 原因：当前引擎的执行步骤（reason/check/act/confirm/commit）只走 LLM 调用与 ToolProvider，**没有"调用外部命名服务"的执行路径**，故无 `get_credential(service_id)` 触发点。LLM API 密钥解析由 [[step-dispatcher]] `resolveCredential`（锚点 `anc-exec-model-resolve`）独立承担，与本接口是不同关注点；
> - 完整实装随 v2 外部服务调用能力 / HopAnt 宿主注入落地（[[roadmap#v2-1 独立模式（引擎自驱）]]）——属计划内能力分期，判据见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-milestone]]。

### SpecProvider ^anc-provider-spec

**能力契约（HopTrait）**——两个方法：`resolve(spec_id)` 按 callee_spec_id 解析子 spec 源（找不到返回 null → 引擎 fail UNKNOWN_SPEC）/ `list()` 可选，列出可用 spec（与 IdentityProvider.list_services 同构）。

```
struct: SpecSource
  Id: spec-source
  Fields:
    - spec_id: line
    - source: markdown  # HopSpec 全文
    - version: line     # 可选。引擎只透传/审计（记入 HopLog callee 旁），不内置版本解析

struct: SpecEntry
  Id: spec-entry
  Fields:
    - spec_id: line
    - description: line
```

`SpecProvider` 为 `call` 步骤解析被调子 spec——`callee_spec_id`（裸名字，如 `text-normalize`）经此定位具体 spec 源。寻址逻辑（版本策略、来源校验、同名消歧）归宿主 Provider，引擎不硬编码（npm 式：registry 决定解析，lockfile 是宿主的事）。`resolve` 应是确定性的（同一 id 解析到同一 spec）。

**强制力分级（与沙箱同构，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）——SpecProvider 仅独立模式必需**：
- **复用模式**（CC 驱动）：引擎只在 prompt 给出 `callee_spec_id` 文本（[[prompt-assembler]] call 指令），**CC 自行从其 Spec 库定位子 spec**——寻址是 caller 的事，引擎不解析，SpecProvider 非必需（同沙箱"复用模式=契约"）。
- **独立模式**（引擎驱动递归）：引擎必须拿到子 spec 内容才能嵌套执行 → 调 `spec_provider.resolve(callee_spec_id)` 获取，null 则 fail。SpecProvider 是独立模式 call 递归的前置件（同沙箱"独立模式=Provider 强制"）。

**缺省实现 DirSpecProvider【决策：原则性，作者拍板 2026-08-10】** ^anc-provider-spec-default

standalone 场景（MCP server / 测试）Spec 作者写 `[call text-normalize]` 时，引擎自带的缺省 Provider 按**调用方 spec 同目录**寻址：`<caller spec 所在目录>/<callee_spec_id>.md`。

- 选择理由=语言设计第一原则（普通人易于理解，不必要不增加复杂度）——零配置、所见即所得；不够用时宿主注入自定义 SpecProvider 替换（备选"config.yaml spec_dirs 搜索链"因引入新配置项被排除）；
- 安全约束：callee_spec_id 含路径分隔符或 `..` 一律拒绝（防路径穿越）——名字就是名字，不是路径；
- 实现类落 [[step-dispatcher]] 模块（独立模式专属件，`dispatcher.ts` 出口 `DirSpecProvider`）；挂载=宿主构造 HostConfig 时未注入 `spec_provider` 则由 standalone 入口（mcp-server startRun）以 spec 文件所在目录构造缺省实例。

> **实装状态（2026-08-10）**：SpecProvider 已随「独立模式 call 递归」实装（原 DEBT-04,2026-08-10 还清）——接口消费点在 [[step-dispatcher#^anc-exec-call-recursion]]，null 返回 → `UNKNOWN_SPEC` fail。
>
> 复用模式 call 不依赖它——CC 自行解析 callee。子实例 id 由引擎算出（不在 loop 里=call 步骤号,在 loop 里带轮次后缀;幂等、落 `calls/<子实例ID>/`，见 [[exec-engine#^anc-exec-call-child-iter-id]]）。早期探索稿 `rounds/call-addressing-specprovider-草案.md` 已被本节与 step-dispatcher 正文取代。

### ModelEngine ^anc-config-model-engine

多模型路由配置，由 IdentityLayer 持有：

```
struct: ModelEngine
  Id: model-engine
  Fields:
    - default_service_id: line     # 默认 LLM 服务标识（如 anthropic）
    - default_model: line          # 默认模型
    - routing_rules: [ModelRoute]  # 可选。按步骤类型/标注路由

struct: ModelRoute
  Id: model-route
  Fields:
    - match: yaml       # 匹配条件——当前仅 step_type（RoutingCategory：act/commit/reason/check/replan——路由类别=可执行步骤类别∪replan 元编程档;confirm/ask 是介入点无 LLM、call 是引擎递归,均不路由。宿主直注（不经 StandaloneConfig 加载闸）由本类型编译期约束,JS 宿主绕过类型面时责任在宿主——运行期未知类别永不匹配,不设第二道闸）
    - service_id: line  # 目标服务标识
    - model: line       # 目标模型名
```

路由优先级（从高到低）：步骤 `@model` 标注 > Spec `Config.models[类别]`（两层分档 2026-08-13——spec 层逐类别继承,commit 无专键吃 act 键） > Spec `Config.model` > `routing_rules` step_type 匹配 > `ModelEngine.default_model` > 宿主 `ANTHROPIC_MODEL` fallback > `HostConfig.model` > 硬编码默认。
（八级——权威解析链 [[step-dispatcher#^anc-exec-model-resolve]],对外表述 [[../reference/配置参考]]。）显式 ModelEngine 默认高于环境继承，防 standalone 的 `service/model` 被宿主环境静默改回 default service。

### StandaloneConfig（~/.hopjit/config.yaml 完整 schema） ^anc-config-standalone-schema

**standalone 配置的实现行为契约**（加载/两级合并/校验逻辑——**对外文法权威已迁 [[../reference/配置参考#^anc-ref-config-contract]]**,2026-08-13 作者定:对外契约的权威属对外文档;本节字段结构与之同步,用户面语义以彼为准）。**统一配置两级形态**（作者定 2026-08-13——原 config.yaml/hoptools.yaml 双文件合并为同一 schema 两个作用域）：

```
~/.hopjit/config.yaml    系统级（跟人走——providers/凭证引用通常在此）
<项目根>/hopjit.yaml      项目级（跟项目走可进仓库——tool_servers 通常在此;可选）
```

```
# Spec: 配置加载与两级合并
Id: standalone-config-load
Goal: 从系统级 ~/.hopjit/config.yaml 与项目级 <项目根>/hopjit.yaml 两文件装出一份合法 StandaloneConfig——文法坏/引用坏在加载期响亮拒,不漂运行期
Inputs:
- config_path: line   # 可选。HOPJIT_CONFIG 显式指定=单文件语义（只用它不合并）
- project_dir: line   # 项目根（组合根 cwd;查找焊死不逐级向上搜）
Outputs:
- config: StandaloneConfig   # 合并后配置（跨节引用已核）
```

**加载合并校验（HopSop）**：

```
1. [branch] 按 config_path 分派：
  1.1. [case(config_path)] 显式单文件：parseConfigFile(必在) → 核 providers 非空 → validateMergedRefs → 返回
  1.2. [case(else)] 两级形态 → 2
2. [act] 逐文件读取+文法核（单文件自含的错当场拒）：parseConfigFile(系统级,存在才读) / parseConfigFile(项目级,存在才读)
  > 文法核=各节形状（providers/routing_rules/resource_limits/commands/notify/log_level/language/env——0084 批三随实况勘正,原"五节"旧账）/step_type ∈ ROUTING_CATEGORIES/明文 api_key 拒/hop_env_ 前缀与凭证形态键拒/~ 归一
  > 两级全缺席 → STANDALONE_CONFIG_MISSING fail
3. [act] mergeConfigs 逐节合并（项目级赢）：providers 按 service_id 键合并 / routing_rules 按 step_type 键合并 / env 逐键合并 / resource_limits 逐键合并 / tool_servers 取名并集（同名 server 项目级整体替换;工具名跨级判重归装配层）/ **commands 并集去重**（review F1:原返回体无此键,双文件部署 commands 整键蒸发恒关死——并集条款首次兑现）/ default_model、notify、log_level、language 各自在场即赢（language 曾漏合并——0084 M2 修,commands 前车同型复发;本列节 0084 批三随实况补全,原文只列 6 节——实况 10 节(盘点时点 9 节,M2 补 language 后 10)）
4. [check] 合并后校验（BUG-E 时点条款——引用核只能对合并后 providers 做）：
  > providers 非空;routing_rules[].model 与 default_model 引用的 service 都在合并后 providers 内,拼错即拒
```

**每 run 重读（reloadProjectConfig,与上同一套文法/引用核）**：数据面节重读项目级赢、providers 恒启动期快照——语义四条与实撞史见下方"项目根定义与每 run 重读"条款。

- **routing_rules 条目可选 `thinking: enabled|disabled`**（形态 B 2026-08-20——权威 [[step-dispatcher#^anc-exec-thinking-routing]],此处 schema 登记）；
- **两文件同一 schema，十节全部可选**：providers / default_model / routing_rules / tool_servers / env（hop_env_* 环境参数）/ **resource_limits** / **commands**（subprocess.run 白名单,并集合并） / log_level / **language** / **revision_prompt**。
  - 十节清单与配置参考 §零 清单同源——两处此前各漏各的,review 面一抓成员不同后统一;2026-09-18 review 再抓同型复发〔配置参考先改十节本句停八节〕,新增顶层键两处清单同批改是本句的执行义务
- **逐节合并，项目级赢**：providers 按 service_id 合并（项目可加私有后端/覆盖同名）;routing_rules 按 step_type 合并;tool_servers 取并集、工具名跨两级判重 fail-fast（同名不覆盖不遮蔽——Composite 装配同款纪律）;default_model 项目级在场即赢。合并哲学与 spec Config.models 逐键继承同源：项目只写差异；
  - **跨节引用的校验时点=合并后**（2026-08-13 BUG-E 实撞钉死）：routing_rules/default_model 的"引用 service 必须在 providers 内"只能对**合并后**的 providers 核——项目级文件合法形态就是只有 routing_rules+tool_servers（providers 归系统级），逐文件核引用必然把合法形态误拒〔实撞:providers undefined 直接崩 server 启动〕。逐文件仍核**文法**（step_type 枚举/条目形状/明文 key 拒绝——单文件自含的错），引用核延后；
- **查找焊死**：两个确定位置都可缺省,不逐级向上搜;`HOPJIT_CONFIG` env 为显式覆盖（指定后只用它不合并——e2e 语义不变）;两级全缺席且要 startRun → STANDALONE_CONFIG_MISSING 照旧；
- **项目根定义与每 run 重读**（2026-08-17 hopissues/0007②+0012 并单——原设计只写"查找焊死"未定义项目根怎么来,是设计留白）：
  - **项目根 = 该 run 的组合根 cwd**（startRun 时 process.cwd() 一次读取,即 `config_project_dir` 钉进快照的同一值——与 restore 钉根重读对称,startRun/restore 同一套判定）;
  - **项目级 hopjit.yaml 每 run 装配期重读**（数据面节 tool_servers/env/routing_rules 与 server 启动期配置 mergeConfigs 合并项目级赢——个人版迭代场景配置常变,改工具白名单下一个 start_run 即见,不再重启宿主会话;hopkb tidy 四工具注册实撞）;
  - **providers/凭证保持启动期语义**（key 安全面不动——providers 节即使项目级文件写了也以启动期快照为准:凭证解引用发生在 serve 启动期 snapshotProviderKeys,重读换 provider=凭证链重走引入新失败面）;
  - **重读收敛为单一函数**（十四审矩阵审计后结构性根治——startRun/restore 两处手写重读三审两审各撞缺陷,'同一语义多路径实现'是缺陷温床:reloadProjectConfig 单函数,两调用点零逻辑）;
  - **合并后引用核照跑**（十四审矩阵格②——项目级 routing_rules 引用拼错的 service 原漂到运行期才炸,BUG-E'加载期核'承诺在重读路径缺位;重读合并后跑 validateMergedRefs,引用核对合并后 providers=启动期快照）;
  - **providers 语义分层著文**（矩阵格③——同一 hopjit.yaml 的 providers 节:server 从项目根**启动**时经两级合并生效〔项目可加私有后端,既有条款〕;server 已跑后**改文件**下一 run 不生效〔恒启动期快照,凭证解引用时点约束〕——用户可见分叉:改 providers 要重启 server,改数据面节不用）;
  - **文件缺席跳过;在场但非法响亮拒**（十二审修正——原'损坏回退'措辞让 0004 凭证闸在重读路径被 catch 吞成静默:项目 env 节塞凭证键,闸抛错被回退吃掉,用户零反馈且同文件合法配置整体丢弃;文件在场=用户意图在场,静默忽略其配置编辑正是 0012 要治的病的倒置——parseConfigFile 抛错〔文法/凭证违规〕转结构化 error CONFIG_INVALID 拒 run,只有文件不存在才跳过重读）;
- **tools_file 指针字段与独立 hoptools.yaml 形态退役**（0.x 干净改）：tool_servers 就是配置的一节,文法权威仍归 [[tool-interface#^anc-config-tool-registry]]（只是宿主文件变了）;in-process `module:` 相对路径改为**相对所在配置文件目录**解析（项目级配置里的模块路径相对项目根——语义自然）。
**配置文件绝不保存 key**：ProviderEntry 只允许 `api_key_env` 环境变量名，顶层或 provider 内出现 `api_key` 均 fail-fast 拒绝。文件不含秘密，因此不实施 0600 权限检查；真正的 key 只存在于 MCP server 继承的进程环境与运行期 HostConfig 内存。

```
struct: StandaloneConfig
  Id: standalone-config
  Fields:
    - providers: [ProviderEntry]  # 至少 1 条；首条为默认 provider
    - default_model: line         # 可选。全局默认模型——"service/model" 两段式或裸 model
    - tool_servers: yaml          # 可选。外部工具注册（原独立 hoptools.yaml 整节收编——文法权威 [[tool-interface#^anc-config-tool-registry]] 不变）
    - commands: [line]            # 可选。subprocess.run 命令白名单（人话名"允许哪些命令",装入 sandbox.runtime.available——执行契约 [[act-body#^anc-exec-subprocess-run]],对外文法 [[../reference/配置参考#^anc-ref-commands]]）;两级合并=并集去重;形状=非空字符串列表(加载期核,标量/混型 fail-fast——review F4:零核时标量退化子串白名单)
    - env: yaml                   # 可选。spec 环境参数（hop_env_* 命名空间,概念权威 [[../concepts/HopSpec V3核心规范#^anc-config-hop-env]]）——全名键值映射（hop_env_kb_root: /path）;两级逐键合并项目级赢;键必须 hop_env_ 前缀（文法闸:非前缀键拒——防业务配置混入）;值禁凭证形态（键名**以 `_key/_token/_secret/_password` 结尾**即拒——尾锚定非'含':`hop_env_keyring_path`〔含 key 语义是路径〕这类键'含'判会误杀,凭证键名习惯是后缀位;2026-08-17 hopissues/hoplogic3/0004 口径裁定,原'含'表述随代码修正。**闸为共用纯函数 `credentialLikeHopEnvKey`（provider-types.ts）,覆盖链三级〔配置 env 节/params 传入/ask 回填〕同判**——原实现只堵配置一级,params 与 ask 两路凭证照收且随 host_context 落盘,概念层:614'或经 params 传入'承诺落空;对外文法权威 [[../reference/配置参考#^anc-ref-hop-env]]）
    - routing_rules: yaml         # 可选。系统层按类别路由（两层配置的系统半边——spec 层 Config.models 逐类别继承本层,见 [[step-dispatcher#^anc-exec-model-resolve]]）。列表项 {step_type, model}——step_type ∈ act/commit/reason/check/replan,model 为 service/model 引用或裸 model;解析入 ModelEngine.routing_rules
    - log_level: line             # 可选。HopLog 记录级别 debug|info|warn——standalone 缺省 debug（2026-08-22 作者定:执行日志是 standalone 唯一核验通道,info 不记 prompt 正文即黑箱,条款权威 [[mcp-server#^anc-struct-mcp-server]] HopLog 恒开条）;两级合并项目级赢;非法值加载期拒（同 resource_limits 文法核姿势——静默漂过=级别悄悄错档）
    - resource_limits: yaml       # 可选。资源限制逐键映射（RL_KEYS 白名单文法核,未知键拒;两级逐键合并项目级赢;env HOPJIT_MAX_OUTPUT_TOKENS 仍最高）。九键:max_tool_iterations/max_context_tokens/max_output_tokens/max_replan_attempts/max_concurrent_workers/max_call_depth/timeout_seconds/parallel_child_timeout_seconds/**max_concurrent_runs**（2026-09-10 todo/0084 M1 新增——server 级并发 run 上限,缺省 4:防失控烧费的保守默认,批量场景显式调大=知情授权;server 级判定读启动期合并后配置,不入每 run 重读面——与 providers 快照同理由;原为 mcp-server 源码裸常量,批量验证第 5 run 被拒实撞后配置化）
    - language: line              # 可选。关键词语言 en|zh（缺省 en;概念权威 i18n 设计）;两级合并项目级赢（与 log_level 同规则——2026-09-10 todo/0084 M2 补:此前 mergeConfigs 漏本键,项目级 zh 在 MCP 侧静默蒸发落 en 与 CLI 劈叉,dist 实跑实证;同批补文法核:非 en|zh 加载期响亮拒,不静默当 en）
    - revision_prompt: line       # 可选。修订供给档 standard|short,缺省 standard（弱模型档打回重试轮换短卷——行为权威 [[prompt-assembler#^anc-exec-revision-short-weak]],本表只登 schema 户口;两级合并项目级赢〔0084 M2 同款——新顶层键必须同步 mergeConfigs〕;文法核坏值加载期响亮拒;env HOPJIT_REVISION_PROMPT 每 run 可覆盖;最终户口=model-gearbox 档案 adapt.revision_prompt,档案消费链落地后本键降为人工覆盖位）
    - notify: yaml                # 可选。通知渠道声明 {channel: dingtalk}——三与门第二门(per-run hop_notify×本节×凭证env),权威 [[mcp-server#^anc-mcp-notify-hook]];两级合并项目级赢(0084 批三补记——struct 此前漏列本键,实况 mcp-server.ts StandaloneConfig.notify 与文法核 :304 俱在)

struct: ProviderEntry
  Id: provider-entry
  Fields:
    - service_id: line   # 路由标识；[A-Za-z_][A-Za-z0-9_]*，大小写归一后全局唯一，default 为保留字
    - protocol: line     # wire 报文格式枚举（作者定拆 2026-08-13——'openai'一词罩两套报文用户会疑惑）：anthropic=Messages API 兼容 / openai-chat=OpenAI chat/completions 兼容 / openai-responses=OpenAI Responses API 兼容（0020 批实装 2026-09-20——OpenAI 官方生态工具循环正路,OpenAI/DeepSeek `/v1/responses`/xAI/vLLM/Azure 原生支持;此前系枚举预留）。0.x 干净拆不留 'openai' 旧值——留着旧值歧义就还在。三档工具循环能力:anthropic/openai-responses 原生支持,openai-chat 不支持（fail-fast 指路）,见 [[step-dispatcher#^anc-exec-protocol-adapter]]
    - base_url: line     # API 端点（如 https://api.deepseek.com/anthropic）
    - model: line        # 该 provider 的默认模型
    - api_key_env: line  # 环境变量名引用——唯一合法凭证形态；[A-Za-z_][A-Za-z0-9_]*
    - max_output_tokens: int  # 可选。该 provider 模型的输出上限（2026-08-27 作者定"按 LLM 的上限去设置,Ln 门限自己控制"——引擎缺省按模型能力发满,产出多大归 spec 输出声明约束,不由全局池一刀切;缺省落解析链下级）
    - auth: line         # 可选。鉴权头形态枚举 api-key|bearer,缺省 api-key（x-api-key 头,与既有逐字节同）;bearer=Authorization: Bearer 头,走 SDK authToken 通道且 apiKey 置 null 防双头（只认 Bearer 的网关实测百炼 claude-code-proxy 对 x-api-key 报 InvalidApiKey）。生效面=显式 service 路由与缺省 provider（defaultClient）两路（2026-09-18 工程链 review 抓缺省路径漏装后补齐——原实装只罩显式路由,唯一 provider 配 bearer 不写路由时静默发错头）;路由 env 键 {SERVICE_ID}_AUTH=bearer,与 _PROTOCOL 同披;文法核坏值加载期响亮拒。对外文法 [[../reference/配置参考#^anc-ref-config-contract]] auth 行
    - thinking: line     # 可选。该 provider 的思考缺省枚举 enabled|disabled——配了就对每个走该 provider 的请求恒显式发 thinking 参数,不配落引擎内建步骤类型缺省（五级链第 5 级——恒发参数,详见 [[step-dispatcher#^anc-exec-thinking-routing]];"不发参数吃端点缺省"形态已随五级链退场）。动因（2026-09-20 作者问"ling 和 ds 缺省思考状态不一样,以后是不是需要统一"）:各端点的思考缺省互相相反（deepseek 缺省开/antchat 缺省关）且对调用方不可见——同一份 spec 换模型跑,思考行为静默翻转,度量与费用两头被隐式差坑（实撞:Ling 全部历史 G1 数据是思考关档,复测才知推理档被低估三倍位数）。本键把"缺省"从端点的私有事实变成配置里可审计的显式事实——统一的落点在我们的配置层,不在端点。优先级=思考决策链第 4 级（记名册/步骤标注/routing_rules 全压过它,五级链见 [[step-dispatcher#^anc-exec-thinking-routing]]）;路由 env 键 {SERVICE_ID}_THINKING,与 _AUTH 同披;文法核坏值加载期响亮拒 ^anc-exec-thinking-provider-default
```

**配置样例（~/.hopjit/config.yaml，两协议各一条——百炼两形态端点做对照）**【说明】：

```yaml
providers:
  - service_id: bailian_cc          # 百炼 Anthropic 兼容端点（Claude Code 同款通道）
    protocol: anthropic
    base_url: https://coding.dashscope.aliyuncs.com/apps/anthropic   # 写到 /apps/anthropic 为止,不带 /v1 尾巴
    model: qwen3.7-plus
    api_key_env: DASHSCOPE_API_KEY
  - service_id: bailian_oai         # 百炼 OpenAI 兼容端点（模型面更全）
    protocol: openai-chat
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen3.7-max
    api_key_env: DASHSCOPE_API_KEY
routing_rules:                      # 系统层分档（spec 没配的类别继承这里;对外权威样例见 reference/配置参考——本例演百炼单家分档形态）
  - step_type: act                  # 执行类（含 commit,除非另写 commit 条）——轻量档
    model: bailian_cc/qwen3.7-flash
  - step_type: reason               # 推理——中强档
    model: bailian_cc/qwen3.7-plus
  - step_type: replan               # 重规划=元编程,须会写 HopSpec——最强档
    model: bailian_cc/qwen3.8-max
default_model: bailian_oai/qwen3.7-max
```

注意：百炼 Anthropic 端点只有 /v1/messages 无模型列表接口——探测类工具报 404 属预期，引擎不探测不受影响。

（TS 形态是代码层投影，在 mcp-server.ts `StandaloneConfig`/`ProviderEntry`——设计以本 HopType 为准。）

- **与 HostConfig 的关系**：StandaloneConfig 是**文件形态的宿主配置源**——消费方（mcp-server）加载后解析为 HostConfig + ModelEngine 注入 Dispatcher；HostConfig 仍是进程内契约，两者不重复（file→memory 单向构建）；
- **key 解析**：本 schema 的 `api_key_env` 在构建 HostConfig 时解引用；env 缺失即 provider 不可用，错误只报变量名、不报值；
- **default_model 解析**：裸 model 归 `providers[0]`；`service/model` 两片都必须非空，service 按大小写归一匹配 providers 并采用其声明时的规范拼写；空片段或未知 service 均 fail-fast；
- **非 YAML 拒绝**：`config.json` 不识别（文件不存在同等报错指向 config.yaml）；YAML 是 JSON 超集，用户误写 JSON 语法进 config.yaml 仍可解析，不构成第二格式。

### hop_env 覆盖链合成（组合根契约） ^anc-config-hop-env

概念权威 [[../concepts/HopSpec V3核心规范#^anc-config-hop-env]]（命名空间/只读/凭证禁入的语义源）。本节定**设计层的合成责任**：

- **组合根合成（每模式一处,不散落）**：standalone=mcp-server startRun/restoreRun;复用=cli extractHopEnvIntoHostConfig（init/run 两命令入口）。顺序=配置 env 节（已两级逐键合并）→ params 里 `hop_env_*` 键覆盖并**从业务 params 摘除**（它是环境参数不是 spec 输入,混入会污染 Inputs 校验）→ 运行期 ask 回填由 engine completeStep 并入（覆盖链末级）;
- **restore 特则**：server 重启恢复时以**快照恢复表**（host_context 持久化的,含原 run params 覆盖与 ask 回填）覆盖配置重合成——快照是覆盖链更下游产物,配置打底快照赢;
- **声明即授权**：合成时值为绝对路径的键同步扩入 sandbox `read_access.allowed`（详见 [[doc-ref#^anc-exec-doc-ref-hop-env]]）;**ask 末级并入同款授权**（engine completeStep 并入表时同步扩——问人补的绝对根不授权则随后 doc-ref 展开即被拒,末级形同虚设）;`~/` 前缀在配置文法闸归一为 home 绝对路径（YAML 不经 shell,不归一按 workspace 相对解析必错）;
- **子实例透传**：复用模式派发（buildDispatchLaunchCommand）把父表并进 launch_command params,worker/call 子进程各自组合根摘出重建同一张表;独立模式子实例复用同一 HostConfig 引用零动作;
- **持久化**：hop_env 随 StateFile.host_context 落盘（复用模式 next/done 独立进程,doc-ref 展开/L2e/ask 回填须同表）。

**正反例**：params 摘出覆盖配置且业务键无扰/restore 快照表赢/绝对根入白名单相对值不入/~ 归一/子实例拿到父表。

### HostConfig ^anc-config-host

实例化时由宿主环境注入，贯穿整个执行生命周期：

```
struct: HostConfig
  Id: host-config
  Fields:
    - workspace_dir: line              # 工作目录（必填）——DefaultToolProvider 的 cwd
    - sandbox: SandboxConfig           # act 步骤资源边界（四维度）
    - tool_provider: ToolProvider      # 可选。不提供则用 DefaultToolProvider
    - knowledge_provider: KnowledgeProvider  # 可选。不提供则无知识注入
    - identity_provider: IdentityProvider    # 可选。不提供则从环境变量/YAML 自动构建
    - api_key: line                    # LLM API key（最简配置的 fallback）
    - base_url: line                   # 可选。API 代理网关（如 https://zenmux.ai/api/anthropic）
    - model: line                      # 可选。全局默认模型——model_name 或 service/model 两段式
    - model_engine: ModelEngine        # 可选。多模型路由配置——不提供则从 api_key+base_url 构建单服务
    - resource_limits: ResourceLimits  # 可选。单步资源上限
    - spec_provider: SpecProvider      # 可选。call 子 spec 解析注入位（独立模式 call 递归消费）
    - protocol: line                   # 可选。LLM wire 协议枚举 anthropic/openai-chat/openai-responses（三值现役,0020 批撤预留），缺省 anthropic——复用模式与存量注入零变化；standalone 由 provider 条目带入
    - tool_registry: [ToolServerEntry] # 可选。外部工具注册条目（hoptools.yaml 加载产物,文法权威 [[tool-interface#^anc-config-tool-registry]]）——CompositeToolProvider 装配消费；缺省无外部工具
    - env_snapshot: yaml               # 可选。进程环境快照（run 隔离不变量,权威 [[../ARCHITECTURE#^anc-run-isolation]]）：组合根构造 HostConfig 时把运行期会消费的 env 键一次性冻结——**快照是封闭集,键集即契约**（0008③:漏键=该环境变量 standalone 下静默失效,原'等'字含糊致实装只冻 providers 三键）。键集两类=providers 派生六键（{SERVICE}_API_KEY/_BASE_URL/_PROTOCOL 恒派;_AUTH/_THINKING/_MAX_OUTPUT_TOKENS 配了才派——2026-09-20 review 批清账:三个条件键随各自特性批入码,本清单漏更）+固定透传六键（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY/HOPJIT_ANTHROPIC_API_KEY/ANTHROPIC_MODEL/HOPJIT_MAX_OUTPUT_TOKENS——dispatcher envOf 固定键消费点全集,新增消费点必须同步透传表;CLAUDE_CODE_MAX_OUTPUT_TOKENS 已摘,0084 批三随实况勘正——该键语义属 CC 宿主,引擎捡它=跨受众误配,^anc-exec-output-budget 摘除记录）;构造单点 buildEnvSnapshot,startRun/restore 同函数;引擎内核运行期只查快照禁直读 process.env——外部/它 run 改 env 不再影响在飞 run。缺省未提供时内核回退直读（存量兼容,组合根逐个收编后收紧）
    - hop_env: yaml                    # 可选。spec 环境参数表（组合根按覆盖链合成:配置两级→params 覆盖;ask 回填运行时并入——doc-ref 展开/body 只读注入/prompt 值表三消费面,概念权威 ^anc-config-hop-env。与 env_snapshot 分立:那是进程环境快照〔含凭证,不落盘〕,这是 spec 环境参数〔非密,可落盘〕。组合根合成表时同步把值为绝对路径的声明根扩入 sandbox read allowed——写配置即授权,授权面与声明面同一动作,见 [[doc-ref#^anc-exec-doc-ref-hop-env]]）

struct: SandboxConfig
  Id: sandbox-config
  Fields:
    - filesystem: FilesystemSandbox
    - network: NetworkSandbox
    - runtime: RuntimeSandbox
    - database: DatabaseSandbox        # 可选

struct: FilesystemSandbox
  Id: filesystem-sandbox
  Fields:
    - workspace_dir: line              # 工作区根目录——内部可自由写、删、试验
    - read_access: yaml                # 三清单：allowed（可自由读的路径/glob）/ denied（绝对禁读——密钥凭证类）/ confirm_required（需 confirm 步骤后才能读）

struct: NetworkSandbox
  Id: network-sandbox
  Fields:
    - trusted_hosts: [line]            # 可信域名白名单

struct: RuntimeSandbox
  Id: runtime-sandbox
  Fields:
    - available: [line]                # 可用运行时声明（如 python / node / uv / pdf / ocr）

struct: DatabaseSandbox
  Id: database-sandbox
  Fields:
    - temp_databases: [line]           # 临时库——act 可读写（重做安全，可重建）
    - readonly_databases: [line]       # 可选。只读库——act 只能查询，写入需 commit

struct: ResourceLimits
  Id: resource-limits
  Fields:
    - max_tool_iterations: number      # 默认 20
    - max_context_tokens: number       # PromptAssembler 上下文预算，缺省 10000（prompt.ts BUDGET_DEFAULT——0084 批三勘正:原文写"4000/有 KnowledgeProvider 时 4400"是旧账,预算已不随 KnowledgeProvider 切换）。兼作工具循环模型窗预检线（×0.8 触发压缩降级，见 [[step-dispatcher#^anc-exec-toolloop-ctx-degrade]]）——不配则无预检，只保留撞墙补救
    - max_output_tokens: number        # API max_tokens 参数，缺省 32768（dispatcher DEFAULT_MAX_OUTPUT_TOKENS,2026-08-27 自 16384 抬升——0084 批三勘正旧账 4096）
    - max_replan_attempts: number      # 默认 3
    - max_concurrent_workers: number   # 可选。parallel 并发名额（含主线），默认 5。见 [[parallel-execution#^anc-exec-parallel-dispatch-model]]
    - max_call_depth: number           # 可选。call 嵌套深度上限，默认 10——运行时超限 fail DEPTH_EXCEEDED（独立模式 Dispatcher 递归前检、复用模式 init --parent 按 calls/ 目录层数检）
    - timeout_seconds: number          # 可选。单步超时（默认无限）
    - parallel_child_timeout_seconds: number  # 可选。parallel 在飞子实例活性上限——缺省不超时，显式配置才生效（超时管 running 卡死，不管等人）。见 [[parallel-execution#^anc-exec-parallel-timeout]]
```

（TS 形态是代码层投影，在 provider-types.ts——设计以本 HopType 为准。）

SandboxConfig 定义 act 步骤能安全触及的资源边界。核心原则：**act 步骤内一切操作可安全重做**——失败时 subtask retry 不会产生不可逆后果。 ^anc-config-sandbox

四种资源类型的拦截规则、实现状态与典型场景，**权威定义在 [[sandbox]]**——本文件只承载类型定义（HopType），语义规则不在此重复：

- filesystem：[[sandbox#^anc-config-sandbox-filesystem]]
- network：[[sandbox#^anc-config-sandbox-network]]
- runtime：[[sandbox#^anc-config-sandbox-runtime]]
- database：[[sandbox#^anc-config-sandbox-database]]

ResourceLimits 定义单步执行的资源上限（token 预算、工具调用上限、超时） ^anc-config-resource-limits

HostConfig 未来持久化到 `.hopstate/<instance_id>/host_config.json` 时只写非敏感绑定信息，**不得包含 api_key 字段**；crash recovery 后重新解引用环境变量恢复 Provider。
