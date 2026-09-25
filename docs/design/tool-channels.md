%% @trace
	id: hopjit-tool-channels
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-12T01:30+0800
	note: 工具调用通道总览（2026-08-12 作者要求"tool use/tool call 的接口总结一下，形成文档"）。工具相关条款散在 act-body/exec-engine/shared-providers/tools/step-dispatcher 五份文档——各自权威留原锚点原位，本文是通道地图：哪条路径、谁执行、什么协议面、哪里拦截，一张表看全
%%

# 工具调用通道总览

> 家族分工（接口标准/通道地图/装配层/具体工具四切面）见 [[tools]] 开头"工具设计面地图"节——本文管"工具怎么被步骤消费"这一面。

> **模块版本**：tool-channels `v0.3.0`（枢纽文档——本文只汇总不定义，各通道条款权威在原锚点；冲突以权威为准）。v0.3.0（2026-08-31）——⑥的服务面收窄：非内建件缺省走 caller 原生能力，⑥退为兜底（作者定"复用模式下应该用 agent 自己的 web search"，权威=prompt-assembler ^anc-exec-tool-manifest-source 第 4 条）。演进史归 git log。

## 文档结构与内容分级

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 背景、对照、评估 | 与契约一致即可 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 六条通道一张表 | 契约 | `anc-exec-tool-channels` |
| 横切拦截：requires_commit | 说明（权威在他处） | — |
| 相邻但不是工具通道的东西 | 说明 | — |

---

## 六条通道一张表【契约】 ^anc-exec-tool-channels

"spec 里的一步要用工具"在 hopjit 里共有五条物理路径。**选路规则**：act/commit 有 hop_python body → 走 ①②③（确定性面）；无 body → 走 ④（LLM 兜底面）。⑤ 是独立模式的缺省工具实体，被 ①-④ 消费。

| # | 通道 | 谁执行 | 接口形状 | 协议面 | 权威 |
|---|---|---|---|---|---|
| ① | **body 白名单内置** | 引擎（BodyInterpreter）纯计算 | hop_python 直接调用：`len(x)`/`split(s, ",")` 等 28 个 + `work_zone_path()` 实例上下文内置 | 无——不出进程 | [[act-body#^anc-exec-act-body-interp]]（白名单清单在 act-builtins.ts） |
| ② | **body 非内置工具·独立模式** | 引擎直调宿主注入的 ToolProvider | `ToolProvider.execute(tool_name, tool_args) → ToolResult`——body 撞到非内置调用名即经 provider 执行（独立模式 dispatcher 自持全量 provider 全部直执;provider 外的调用名=TOOL_EXEC_ERROR 未知工具,封闭名单不外发——2026-09-06 review 抓本行曾被误刷进③的复用模式分派判据文字后改回） | 无 LLM 参与 | [[shared-providers#^anc-provider-tool]] |
| ③ | **body 非内置工具·复用模式** | caller（CC/Codex） | 引擎吐 `tool_request` 介入点响应（`{tool, args, tool_call_seq, output_path, work_zone}`，args 已求值、超阈值 $file 卸载〔2026-09-04〕），caller 执行后 `--tool-result` 回注；结果入 tool_journal，**跨进程确定性重放**（重放撞第 N 个调用查 journal[N-1]，有则代入,无则按分派判据处置(引擎 provider 命中直执入账,不命中再吐——2026-09-05 执行主体原则;直执面=内置∪hopjit.yaml 注册件,0076 补齐注入 2026-09-06)） | CLI JSON 往返 | [[exec-engine#^anc-exec-tool-request]] |
| ④ | **无 body act 的 LLM 工具循环** | LLM 自选工具（executeActWithTools） | Anthropic tool_use/tool_result 消息往返（IR）,ToolProvider.list() 注入 tools 数组，maxToolIterations 封顶 | **anthropic 与 openai-responses 两协议承载**（responses 的 function_call/function_call_output typed items 与 IR 一一映射,0020 批实装）;openai-chat 协议 provider 入口 fail-fast（PROTOCOL_TOOL_LOOP_UNSUPPORTED 指路,含"改配 openai-responses"选项） | [[step-dispatcher#^anc-exec-protocol-adapter]]（工具循环协议边界）+ dispatcher.ts executeActWithTools |
| ⑤ | **DefaultToolProvider 内置文件工具** | 引擎内置实体（宿主不注入时的缺省） | read/write/listdir/exists/create/append/edit_file/makedirs/move/remove 十个文件工具，全部过 sandbox 路径校验 | 无 | [[tools/file-tools#^anc-exec-builtin-file-tools]] + [[sandbox]] 拦截规则 |
| ⑥ | **复用模式特殊工具直调（`hopjit tool-call`）** | caller agent（CC/Codex 的 act free 执行期主动调） | `hopjit tool-call <名> --args '<json>'`（大参数 `--args @file`）——CLI 直达 CompositeToolProvider 全量注册面执行一件工具，无实例无状态；`requires_commit=true` 恒拒（与 body 闸同一分界——不可逆动作不许经无实例通道绕过 commit 步授权） | CLI JSON 单发单收 | cli.ts tool-call（@a: anc-step-tool-grant）；L4 清单通道指引档教 caller 用它（[[prompt-assembler#^anc-exec-tool-manifest-source]]） |

**架构方向**（概念权威 [[../docs/concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]）：④ 是无 body act 的兜底窗口，不是架构必需品——工具编排应在 body 里确定性表达（①②③），"body 在场即唯一执行体"。openai-chat 不做 ④ 映射的依据即此（兜底窗口不值得做 chat 的多层报文映射）;openai-responses 例外实装（0020 批）——其 typed items 与 IR 结构同构映射成本低,且 OpenAI 官方生态的工具调用正路已迁 responses,不做=官方生态整体失能。

**③⑥ 分工判据**（同为复用模式，两条通道不重叠）：

- ③是 **body 执行期**引擎撞到引擎 provider 外的调用名(2026-09-05 执行主体原则——provider 内的直执不吐)吐 `tool_request` 介入点、caller 执行后回注、结果入 tool_journal 跨进程重放——引擎驱动、有实例有账；
- ⑥是 **act free 执行期** caller 按 L4 清单主动调引擎内建特殊件（树编辑族等）——caller 驱动、无实例无 journal（结果由 caller 消化进它对该步的产出，审计归 caller 生态）；
- **非内建件缺省不走⑥**（2026-08-31 作者定"复用模式下应该用 agent 自己的 web search"，将 0054 的"按族分道"收窄到位）：清单指引档对 web_search/browser_* 等非内建具名件教"优先用 caller 环境里**语义等价的原生能力**落实（同名注册 MCP 件或 caller 自带的检索/抓取工具都算），没有等价能力才经⑥兜底"——caller 原生面零进程往返、零引擎侧凭证依赖、在 caller 生态可见可审计；⑥的主责恒是引擎内建特殊族（树编辑族等引擎实现即唯一语义源的件）。

**通道间不变量**：
- 同一工具名在 ②③④⑥ 里指同一**语义契约**（签名+语义），执行实体按模式分（2026-08-31 随"非内建件原生能力优先"口径修正——原文"指同一实体（ToolProvider 单一事实源）"在复用模式已不成立）：
  - standalone（②④）=环境注册面的 ToolProvider 实体是唯一执行体；
  - 复用模式（③⑥/act free）=caller 以语义等价能力落实（③按 tool_request 的最小语义纪律回注、act free 按 L4 指引档原生优先）——名字锚语义，实体可换，spec 作者两模式无感知；
  - 工具签名归环境注册表不进 spec（[[todo/0027_工具一等公民三件_open|工具一等公民三件]] 已立项待做，做成前执行方按 ToolDef.input_schema + 最小语义纪律）；
- ②③ 的选择由运行模式决定，spec 作者无感知（同一 body 两模式语义等价）；
- ③ 的 journal 记的是**结果**不是过程——重试/重跑清本步 journal（重跑工具是预期语义）。

## 横切拦截：requires_commit【说明】

权威 [[shared-providers#^anc-provider-tool]]（ToolDef.requires_commit）：工具注册时自我声明"有不可逆副作用"，act 步骤在 ②③④ 全部通道自动拦截该类工具（COMMIT_REQUIRED），仅 commit 步骤放行——"工具危险与否"钉在工具定义处，不信调用点申报。

## 两模式工具面现状与缺口定位【说明】

（2026-08-12 作者定调：复用模式 tool use 已完备；与 standalone 的区别在于**没有原子颗粒度的 IO**。）

- **复用模式已完备**：③ 承载 body 工具，无 body act 整步交 caller——caller 的原生工具面（Read/Write/Bash/搜索/MCP）本身就是一套**原子颗粒度 IO**：每次调用可见、可审计、可拦截；
- **standalone 的缺口是原子 IO 实体，不是协议**：⑤ 只有文件十一件——网络（http_get）、搜索、数据库等原子一概没有。④ 的协议映射不是瓶颈（LLM 循环本就是兜底窗口）；
- **server-side search 是能力捷径、不是原子 IO**：搜索融合在模型服务端单次调用里——黑盒，无逐调用 HopLog 审计、无 journal 重放、不过 sandbox 拦截。它能快速给 standalone 补"检索融合"能力，但补不了"原子网络 IO"这个结构缺口；
- **补原子 IO 的正路**：扩充 ToolProvider 实体（http_get 等）——每个原子过 sandbox（NetworkSandbox trusted_hosts 已留位）、进 HopLog 审计、入 journal 重放、按 requires_commit 分级。与 [[todo/0027_工具一等公民三件_open|工具一等公民三件]]（签名注册表）同一盘棋：原子多起来之前先立签名契约。

## 相邻但不是工具通道的东西【说明】

- **server-side search**（Anthropic `web_search` server tool / 百炼 `enable_search` 参数）：搜索在**模型服务端**执行、单次 API 请求内完成，客户端零工具循环——不属于上表任何通道，不触碰 ④ 的协议边界。评估中（2026-08-12），若落地则是协议适配层（^anc-exec-protocol-adapter）的请求映射增量，spec 作者面一个声明位、协议差异压进适配器；
- **MCP 工具**（如百炼 WebSearch MCP）：复用模式下属宿主自己的工具面（CC/Codex 挂 MCP，hopjit 无感知）；standalone 引擎当 MCP client 已实装（tool-interface ^anc-exec-mcp-binding,2026-08-12——本行原文"未立项"过时随更）；
- **call 子 spec**：不是工具是子程序（[[exec-engine]] Call 执行模型）——工具无自身执行状态，call 有完整实例生命周期。
