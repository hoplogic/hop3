%% @trace
	id: hopjit-hop-cli
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-09T00:18+0800
	note: HopCLI 组件定义 + CLI 命令表 + CLI 响应类型。2026-07-31 收窄 Codex install-skill 展开契约：安装 main/agents/Codex references，仅复用公共 cli-discovery，不改变 CC 分支。
%%

# HopCLI 设计规范

> **与 ExecutionEngine 的关系**：HopCLI 是 ExecutionEngine 对外的命令行薄壳——每个命令对应一个 Engine 方法，自身不含业务逻辑。热路径（StepDispatcher↔Engine 的 next→execute→done 循环）走进程内 API（见 [[exec-engine]] 决策 1），CLI 仅用于外部人工交互、调试和 HITL 介入。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 命令表、JSON 示例、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（四要素） | 契约 | `anc-struct-hop-cli` |
| 关键决策 | 决策 | — |
| CLI 命令表 | 说明 | — |
| 命令契约 | 契约 | `anc-cli-dispatch` / `anc-cli-instance-resolve` / `anc-cli-state-load` / `anc-cli-list` / `anc-cli-pack` / `anc-cli-install-skill` / `anc-cli-carrier-home-resolution` / `anc-cli-notify-reuse` / `anc-cli-abort` |
| CLI 响应类型 | 契约 | `anc-cli-response-types`（组标题）/ `anc-cli-init-response` / `anc-cli-validate-response` / `anc-cli-list-response` / `anc-cli-next-response` / `anc-cli-step-ready` / `anc-cli-execution-paused` / `anc-cli-command-response` / `anc-cli-vars-response` / `anc-cli-status-response` / `anc-cli-abort-response` / `anc-cli-replan-response` / `anc-cli-branch-request` |
| JSON I/O 约定 | 契约 | `anc-cli-json-io` / `anc-cli-file-arg-safety` |
| JSON 交互示例 | 说明 | — |

## 定位【契约】 ^anc-struct-hop-cli

> **模块版本**：hop-cli `v0.28.0`（2026-09-11）。本版=0086 语义审计修复批（abort 契约句独立带锚/HopLog 恒开条款带锚/分级表补四锚/响应类型章补 InstallSkillResponse+PackResponse/出口清单勘误四符号/@file 清单补 --tool-result/CALL_PROTOCOL_MISUSE 闸回写/work_zone 固定名同步/install rmSync 条款/计数句去数字改指权威/钝感句容错两分/debug_step 入双执行闸枚举）。上版（v0.27.3）=0081 批（StatusResponse/VarsResponse 枚举补 paused+status 两摘要字段+VarsResponse 存量漏 aborted 修）。0.x 未承诺稳定。**CLI 命令+参数+JSON 响应结构是包级对外稳定面**——driver 依赖,破坏即破坏 driver,按 `^anc-meta-module-evolution` 属包级 MAJOR 候选；cli-types 子文件即此对外契约。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
>
> **`--version` 单一事实源 = package.json【契约】** ^anc-cli-version-single-source：`program.version()` **不硬编码字面量**，在构建期从包 `package.json` 的 `version` 字段读取——`hopjit --version` 输出恒等于已安装包版本，杜绝"发版忘同步 CLI 字面量"的脱节（0.1.1 发布时 CLI 仍自报 0.1.0 即此病）。读取方式：编译产物 `dist/cli.js` 相对定位包根 `package.json`（`fileURLToPath(import.meta.url)` → 上溯 `dist/../package.json`），读失败则回退字符串常量兜底（不阻断 CLI 启动）。

**① 自身定位**：HopCLI 是 ExecutionEngine 的命令行路由薄壳——把命令行参数解析为对 Engine 方法的一次调用，再按输出分流契约序列化结果（缺省 YAML，机器调用显式 `--json`）。它**不含任何业务逻辑**：步骤调度、状态机、变量作用域、重试策略全在 Engine 内（见 [[exec-engine]]）。CLI 的全部职责是「解析参数 → 路由到一个 Engine 方法 → 序列化结果」。（解释性类比：类似数据库的命令行客户端——只做协议转换，不做查询规划。）

**② 与其他 HopType 的关系**：
- **ExecutionEngine 的薄封装层**：每个命令对应且仅对应一个 Engine 方法（`init`→`init_execution`、`submit_and_fetch_next`→`completeAndAdvance`、`debug_step`→`next_step`……）。CLI 不组合多个 Engine 调用、不含业务逻辑、不在命令间维护状态。**节奏与消化逻辑已全部归引擎**（[[exec-engine#^anc-exec-advance-to-caller]]）——CLI 是真正的纯薄壳，无任何业务逻辑例外
- **热路径不经 CLI**：StepDispatcher↔Engine 的循环走进程内 TypeScript API（[[exec-engine]] 决策 1），零进程边界开销。CLI 子进程 IPC 仅用于外部人工交互、调试、HITL 介入
- **面向 Agent 与人双消费**：缺省 YAML 供人在终端阅读；外部脚本/Agent 显式传全局 `--json` 取得单行 JSON
- **不碰 Provider 抽象、不碰持久化**：CLI 不持有 ToolProvider/KnowledgeProvider，不直接读写 state.json——状态由 Engine 经 `state_dir` 管理，CLI 只传 `state_dir` 路径

> **历史说明**：早期版本曾在 CLI 层用自由函数 `consumeToolFreeBodies` 消化纯计算 body（曾标注为"唯一业务逻辑例外"，破坏薄壳分层选择）。task #96 把该逻辑上收为引擎语义 [[exec-engine#^anc-exec-advance-to-caller]]，CLI 薄壳**分层契约**（设计层取舍，非宪法级原则）重新自洽——这条曾被迫的破例已消除。原锚点 `anc-cli-next-drives-body` 废止，语义迁移至引擎侧 advance。

**节奏归引擎，driver 哑应答**【契约】：复用模式 driver（CC）通过 `submit_and_fetch_next` 交活 + 领取下一指令（一次原子往返），引擎决定推进节奏、消化哪些中间步、停在哪个 caller 介入点。caller 介入点（reason/check/confirm/含工具 body act-commit）+ 消化规则的唯一权威定义见 [[exec-engine#^anc-exec-advance-to-caller]]——CLI 不重复判定，只转发 `completeAndAdvance` 的返回。

**`hopjit run`** 是 `init` + 首个 `completeAndAdvance` 推进的便利合并：一条命令建实例并推进到首个 caller 介入点或终态（纯计算 spec 一条直达 completed）。返回 NextResponse（附 instance_id 供后续 submit_and_fetch_next）。run 不引入新流控——复用引擎 advance。

**②b 对外接口清单【封闭】** ^anc-struct-hop-cli-exports：

> 本表是 hop-cli 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `cli-types.ts`（响应/请求 JSON 契约，是 driver 依赖的包级对外稳定面）。`cli.ts` 是可执行入口薄壳，**但并非零导出**（原文"无被 import 的对外符号"与实况不符,2026-09-11 审计勘误）——实况四个测试面导出符号：`program`（`export { program }`,src/cli.ts:1666,消费方=tests——tests/cli.test.ts:19 直接 import 用 `program.parseAsync` 进程内驱动命令）、`bootstrapStandaloneConfig`/`readStandaloneCredentialNames`/`detectCcHopjitRegistration`（src/cli.ts:923/1010/1029,export 面在场,面向测试可达性导出;当前测试经 program 进程内路由间接覆盖,无静态 import 点）。另有 resolveParam/assertOutputInWorkZone 等 CLI 参数处理 helper 同被 tests 直接 import——这些是测试可达面,不是跨模块业务出口,生产代码跨模块 import cli.ts 仍违规（guard-scripts 越层检查在案）。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `InitResponse` | 类型 | cli-types.ts | init 响应（engine 返回类型） | stable |
| `NextResponse` | 类型 | cli-types.ts | 推进响应联合（engine advance 返回，7 形态——2026-08-11 +DrainWait/+DispatchReady，−ParallelReady〔P1 清理〕） | stable |
| `StepReady` | 类型 | cli-types.ts | 步骤就绪形态（engine 组装） | stable |
| `ExecutionCompleted` / `ExecutionFailed` / `ExecutionPaused` | 类型 | cli-types.ts | 终态/暂停形态（engine 返回） | stable |
| `DrainWait` | 类型 | cli-types.ts | 收齐等待形态（统一模型：主线走完等在飞收割，step-dispatcher 消费；P2 复用模式 driver 消费）。2026-08-11 随 P0 新增，见 [[parallel-execution#^anc-exec-parallel-reap-drain]] | provisional |
| `DispatchReady` | 类型 | cli-types.ts | 派发信号形态（统一模型 subtask parallel：子树异步派发为子实例，step-dispatcher 消费；P2 复用模式 driver 消费）。2026-08-11 随 P0.5 新增 | provisional |
| `AdaptiveNeeded` | 类型 | cli-types.ts | adaptive replan 请求（engine 返回） | stable |
| `CommandResponse` | 类型 | cli-types.ts | done/fail/branch/answer 通用响应（engine 返回） | stable |
| `VarsResponse` / `StatusResponse` / `ReplanResponse` | 类型 | cli-types.ts | vars/status/replan 命令响应（engine 返回） | stable |
| `AbortResponse` | 类型 | cli-types.ts | abort 命令响应（实例主动中止,2026-08-26 随 [[exec-engine#^anc-exec-abort]] 新增） | provisional |

> **内部（表外即内部）**：`InitSuccess`/`InitError`/`ReplanSuccess`/`ReplanError` 等联合成员（经 InitResponse/ReplanResponse 暴露，不单独跨模块 import）、`BranchRequest`、`cli.ts` 的 dispatch 私有逻辑。

**③ 主要 traits 与主要成员**：

Fields：
- `state_dir: line`——`.hopstate/` 状态目录路径。构造时设定，传给 Engine 用于实例定位与持久化；`--instance` 省略时在此目录下解析最近实例（见命令契约）

trait：
- `dispatch`——唯一入口。解析命令行（commander.js）→ 按子命令路由到对应 Engine 方法 → 将返回值序列化为单行 JSON 写 stdout。运行时错误（参数非法、IO 失败）写 stderr，业务错误（如 INVALID_STATE）作为 JSON 写 stdout

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl dispatch（命令路由）
1. [act] 解析 argv：子命令名 + 选项（--instance/--output/--answer/--reason/--steps…）
2. [act] 解析 --instance：省略则取 state_dir 下最新实例目录
3. [act] 内联参数安全检查：LLM 生成内容（--output/--steps/--reason）强制 @file 路径
4. [branch] 按子命令路由到对应 Engine 方法（init/next/done/fail/status/vars/branch/replan/resume/abort）
5. [act] 序列化返回值为单行 JSON 写 stdout；运行时错误写 stderr
```

### 核心要求

1. **薄壳**：每个命令一个 Engine 方法，零业务逻辑——业务变更改 Engine 不改 CLI
2. **结构化 I/O**：成功/业务错误单行 JSON 写 stdout，运行时错误写 stderr，便于 Agent 解析
3. **注入安全**：LLM 生成内容经 `@file` 传递，路径受目录穿越约束
4. **实例可省略**：单实例场景下命令免传 `--instance`，取最近实例

### 不是什么

- 不是执行引擎——状态机、调度、重试全在 Engine
- 不是热路径——StepDispatcher 走进程内 API，不通过 CLI 子进程
- 不是持久化层——state.json 由 Engine 管理，CLI 只传目录路径

---

## 关键决策【决策】

以下是存在多个合法选项、由人拍板的设计选择。改动需重新权衡，不能从概念层自动推演。

### 决策 1：CLI 是 Engine API 的薄壳，业务逻辑全在 Engine

**候选**：① CLI 承载部分编排逻辑（命令间组合 Engine 调用、维护跨命令状态）；② CLI 严格一命令一 Engine 方法，零业务逻辑。

**选 ②**。每个 CLI 命令解析参数后只调一个 Engine 方法，立即序列化返回。命令间不共享状态（状态全在 Engine 经 `state_dir` 持久化）。

**理由**：业务逻辑单一归属 Engine，CLI 与进程内 API 调用同一套方法，避免「CLI 路径」和「进程内路径」行为分叉。业务演进只改 Engine，CLI 自动跟随。代价是 CLI 无法做跨命令优化（如批量），但 CLI 本就只服务于低频的人工/调试场景，热路径走进程内 API（见 [[exec-engine]] 决策 1）。

### 决策 2：JSON 单行 I/O，stdout/stderr 分流

**候选**：① 人类可读的多行格式化输出；② 单行 JSON 结构化输出，运行时错误与业务结果分流到 stderr/stdout。

**选 ②**。所有命令输出单行 JSON 到 stdout（含业务错误如 `INVALID_STATE`）；运行时错误（参数非法、IO 失败）输出到 stderr。

**理由**：CLI 主消费方是 Agent（StepDispatcher）和外部脚本，单行 JSON 一行一解析最稳。业务错误属于「调用成功但语义失败」，作为 JSON 数据返回让调用方统一处理；运行时错误属于「调用本身没成立」，走 stderr 与 exit code，符合 Unix 惯例。代价是人直接读终端时不如格式化友好，但排查时可经 `jq` 美化。

### 决策 3：LLM 生成内容强制 @file 传递，防 shell 注入

**候选**：① LLM 输出直接作为内联 shell 参数；② LLM 生成内容（`--output`/`--steps`/`--reason`）强制走 `@file` 路径。

**选 ②**。检测到 StepDispatcher 调用来源时，CLI 拒绝内联模式，强制 `@file`；`@file` 路径受目录约束（仅 `.hopstate/` 或 cwd 内，拒绝绝对路径和 `..` 穿越）。

**理由**：LLM 输出含不可控文本，作为内联 shell 参数有元字符注入风险，且受 shell 参数长度限制。`@file` 既消除注入面又突破长度限制。代价是调用方需先落盘临时文件，但 Dispatcher 本就在受控目录内操作。

---

**commands 配置通路（2026-08-30 属地登记,二轮 review 抓零字）**：`buildHostConfig` 经 `readProjectCommands` 读项目级 `hopjit.yaml` 的 `commands` 键装入 `sandbox.runtime.available`——复用模式的配置加载面为三个单键分别读取（commands 本条+language〔readProjectLanguage,^anc-i18n-language-config〕+tool_servers〔loadProjectToolRegistry,0076 批〕,不引入完整配置合并）,**容错档位两分**（2026-09-11 review 修复批勘正——原并称"钝感读"对 tool_servers 文实相反）:commands 与 language 钝感（文件缺席/坏 YAML/形状不符回缺省——空名单/en,不炸 CLI）;tool_servers 响亮（坏 YAML 直接抛、坏节 parseToolServers 拒,折 CONFIG_ERROR 退出码 1——工具注册错配静默回空会让声明的工具悄然缺席,拒载好过带病跑）。执行契约权威 [[act-body#^anc-exec-subprocess-run]]。

## CLI 命令表【说明】

所有命令输出 JSON，面向 Agent（StepDispatcher）消费。

| 命令 | 路由到 | 响应类型 |
|------|--------|---------|
| `hopjit run <spec.md> [--params json] [--context-mode full\|minimal] [--parallel-parent id --parallel-child cid] [--call-parent id --call-step ci]` | init_execution + completeAndAdvance 推进到首个 caller 介入点/终态。统一模型 worker 双入口（launch_command 拼装）：--parallel-* = subtask 子树收窄子实例（parallel/<ci>/）；--call-* = callee 全量子实例（calls/<ci>/，含 calls/ 段数深度检查 ^anc-exec-call-depth-check）——两入口 unifiedDispatch 门不开（嵌套退化）。**--call-* 误用闸（2026-08-14 e2e 实撞）**：--state-dir 尾段已是 `<call-parent-id>/calls` 形态（驱动方把协议 A〔init --parent 后对 `<STATE>/<INST>/calls` 走标准循环〕的目录喂给了协议 B 入口——本入口自拼 `<parent>/calls/`,再喂即双重嵌套,子实例跑死野目录而官方 calls/<ci>/ 恒 pending）→ 启动即拒,报 `CALL_PROTOCOL_MISUSE`,报文含两协议二选一指路（init --parent 建的子实例用标准循环驱动 vs run --call-parent 只用于引擎派发的 launch_command——src/cli.ts:551）,不静默建嵌套目录。**--notify <渠道> 通知开关（^anc-cli-notify-reuse）**：flag 值=渠道名（现枚举只 dingtalk,非法值启动即拒）,记入实例 state 的 notify_channel（跨进程持久——复用模式每条命令新进程,内存标志活不过一条命令）,终态/停点经通知挂点二与门发送（渠道随话语走零配置文件,2026-08-31 作者定）。**HopLog 恒开**：`--log-dir` 缺省 `<state-dir>/../.hoplog`（轨迹=G11 核真过程凭证，不依赖 driver LLM 记得传参——2026-08-08 E2E 实撞 subagent 漏抄参数即无轨迹；对齐 mcp-server 恒开先例），显式传参可改址 | NextResponse（含 instance_id） |
| `hopjit submit_and_fetch_next <step-id> --<参数>` | 按参数路由回写方法 → completeAndAdvance | NextResponse（成功）/ CommandResponse 错误码（不推进） |
| `hopjit reap_and_fetch_next <child-instance> --status completed\|failed` | 统一模型收割——**仅服务带 parallel 标注的派发**（引擎 dispatch_ready 吐出的 child,依赖派发时登记的在飞名册;无 parallel 标注的 [call] 用 `submit --child-instance`,分工判据见 [[parallel-execution#^anc-exec-reap-scope]]）：引擎读子实例目录取输出/FailRecord（reapParallelSubtask/Call）→ advanceToCaller;对从未派发过的 child 响亮拒 REAP_NOT_PARALLEL（^anc-exec-reap-misuse-reject） | NextResponse |
| `hopjit advance` | dispatch_ready 后续推主线（advanceToCaller 薄壳,仅渐进派发场景） | NextResponse |
| `hopjit debug_step [--instance id]` | ExecutionEngine.next_step（**调试用**，纯推进一步、不消化、不 advance） | NextResponse |
| `hopjit validate <spec.md> [--fragment] [--known-vars a,b]` | SpecParser.parse/parseFragment + validate_spec（不创建实例;片段模式见 ^anc-cli-validate-response 片段条款） | ValidateResponse |
| `hopjit tool-call <名> [--args '<json>'\|--args @file]` | CompositeToolProvider 全量注册面直调一件工具（复用模式 act free 的特殊工具执行通道——通道⑥,契约见 [[tool-channels#^anc-exec-tool-channels]]）:无实例无状态;requires_commit=true 恒拒;未知名报 UNKNOWN_TOOL 附注册面清单指路 | 工具结果 JSON（{success, result, ...}） |
| `hopjit list <dir>` | 扫目录 + parseSpec 解析 + 判定可执行 spec（不创建实例、无状态） | ListResponse |
| `hopjit init <spec.md> [--params json] [--parent id] [--step call-step-id] [--trace id] [--upstream-feedback text] [--state-dir dir]` | ExecutionEngine.init_execution（**调试用**，正常启动用 run）。**路径身份两字段（specPath/cliAbsPath）与 run 入口对称传入**——漏传即 doc-ref 首级解析目录错位到 cwd（跨目录 init 报 P15 文件未找到）+嵌套 call 响应缺 call_protocol（buildCallProtocol 两字段任一缺席返 undefined），hopissues/0076 实撞 | InitSuccess \| InitError |
| `hopjit status [--instance id]` | ExecutionEngine.get_status | StatusResponse |
| `hopjit vars [--instance id]` | ExecutionEngine.get_vars | VarsResponse |
| `hopjit resume [--instance id]` | ExecutionEngine.recover → completeAndAdvance | NextResponse |
| `hopjit abort [--instance id] [--reason text]` | ExecutionEngine.abort（实例主动中止,契约 [[exec-engine#^anc-exec-abort]]:非终态→aborted 持久幂等/completed·failed 拒改写/aborted 后一切推进命令墓碑拒;加载走 load 保留现场） | AbortResponse |
| `hopjit install-skill [--dir <目标>] [--carrier cc\|codex\|cfuse-cc\|cfuse-codex] [--demo]` | 从包内 `driver/` 展开 skill 到目标——目标按 carrier 解析（`--dir` 覆盖；`cc`/`codex` 读官方环境变量 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 自动适配当前环境,`cfuse-cc`/`cfuse-codex` 固定 cfuse home,详见 ^anc-cli-carrier-home-resolution）；`--demo` 附装演示集（**demo 恒项目级**落 cwd `.agents/skills`）；Codex 旧项目级残留检测→`legacy_note`；不涉引擎状态 | InstallSkillResponse |
| `hopjit pack <spec.md> [--carrier cc\|codex\|cfuse-cc\|cfuse-codex] [--dir <目标>] [--name <skill名>] [--assets <逗号分隔文件>] [--force]` | 把一个 hopskill spec 打包成载体对应的**独立具名 skill**（CC 系 `/skill`；Codex 系 `$skill`；`cfuse-*` 复用对应原生系的包装模板,仅目标 home 不同） | PackResponse |

**`submit_and_fetch_next` 的互斥参数**（driver 主循环唯一应答命令，提交内容由参数区分）：
- `--output <json>` — reason/check/act 结果回写 → complete_step
- `--answer <json>` — confirm 决策注入 → complete_step（confirm 规范化）
- `--child-instance <id>` — call 子实例回填 → complete_call_step。**无 parallel 标注 [call] 的设计期望收割命令**——普通 call 与串行 for-each loop 体内的 call 都用它（loop 场景由 completeStep 级联做 collect 累积与迭代推进）;带 parallel 标注的派发才用 reap_and_fetch_next（分工判据 [[parallel-execution#^anc-exec-reap-scope]]）
- `--failure <reason>` — 步骤失败 → fail_step（自由文本，非 call 场景）
- `--failure-child <id>` — call 子实例失败 → fail_call_step（2026-08-09 与 done 对称的机器通道：引擎读子实例失败记录组装结构化 CalleeFailure、继承 fail_kind——驱动方从"总结失败"退化为"报告子实例 ID"）
- `--branch <case-id>` — 分支选择 → select_branch
- `--replan <md>` — 重规划 children → submit_replan

各参数互斥（一次提交一种）。回写成功 → completeAndAdvance 推进返回 NextResponse；返回错误（SCHEMA_MISMATCH/INVALID_STATE）→ 原样返回不推进；**ALREADY_DONE 是 ok 回执即终点**（hopissues/0056——幂等重发直返结构化成功报文〔含"引擎在等步 Y"欠账指引〕不推进，不是错误形态；契约见 [[shared-types#^anc-cli-idempotency]]）。

**`hopjit abort` 契约**：加载走 load 保留现场（中止不需要 recover 的悬空重置）→ claimDriverChannel 双执行硬闸 → ExecutionEngine.abort(reason)。中止不可逆，快照与 hoplog 保留可检视；终态语义契约见 [[exec-engine#^anc-exec-abort]]。 ^anc-cli-abort

**HopLog 恒开契约**：CLI 侧 hoplog 不设开关——缺省落址 `resolve(<state-dir>/../.hoplog)`，`--log-dir` 显式传参可改址，但无论是否传参轨迹恒记录。轨迹是 G11 核真过程的凭证，不能依赖 driver LLM 记得传参（2026-08-08 E2E 实撞：subagent 漏抄模板参数即无轨迹假红；对齐 mcp-server 恒开先例）。 ^anc-obs-hoplog-always-on

**`hopjit list <dir>` 契约** ^anc-cli-list：扫描单个目录的直接 `.md` 文件（不递归），对每个文件 `parseSpec` 后判定是否为**可执行 spec**，输出清单。无状态、不创建实例、纯函数（同一 dir → 同一输出，便于测试与跨 runtime 复用）。
- **可执行 spec 判定**（三条全满足）：① `ast.header.goal` 非空；② `ast.steps` 非空（有 Steps）；③ **排除设计文档**——原文含 `%% @trace` 头、或路径段含 `design/`、或含 `## impl ` 段（这些的 Steps 是 impl 伪码示例，非可执行 spec）。解析失败（parseErrors）的文件跳过、不计入。
- **输出 ListResponse**：`{ status:'ok', dir, specs: [{ file, id, goal }] }`——`file` 为文件名（非全路径），`id`=`ast.header.id`（缺省用 title），`goal`=Goal 首句。排序由 caller（skill）按 recent-dirs 决定，引擎按文件名稳定排序即可。
- **recent-dirs 不归引擎**：LRU 偏好记录（`.hopspec/recent-dirs.json`）+ 首次"问用户搜哪个目录"的交互留 skill。引擎不假设 `.hopspec/` 布局——只接收一个明确 dir、吐该 dir 的 spec 清单（对齐概念层"引擎核心不假设文件系统布局" [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 推论）。

**`hopjit install-skill` 契约** ^anc-cli-install-skill：把包内 `driver/` 的 skill 源展开到用户项目的 `.claude/skills/`（CC 载体）或指定目录，解决"包内布局 ≠ CC skill 发现布局"的错配（包内主文件 `hopspec-skill.md`，CC 要 `<name>/SKILL.md`）。**不涉引擎状态、纯文件拷贝**。
- **包根定位**：用 `import.meta.url` 解析 cli.js 自身路径 → 包根 = `dist/../`（不依赖 cwd，全局/本地装都对）。
- **两载体清单对等：构建工具随装（hopissues/0052,2026-08-31——实现遗漏修正）**：`hopbuild`/`hopbuild2` 两件住包内 `skills/` 聚合目录,**载体中立**（构建工具非载体驱动件——cli.ts 拷贝点注释自始明示）,CC 与 Codex 分支**都装**。修前 Codex 分支漏拷两件（同一命令两载体能力不对等,Codex 用户装完无 /hopbuild 可用——报告方实撞）。版本戳口径:与 CC 分支同源对齐——copyDir 拷入后对两件的 SKILL.md 走 stampSkill 注版本戳（CC 分支 2026-08-25 起即如此,对齐=清单与戳都齐;设计首稿误记"CC 不注戳",4.2 实现时对码纠正）。正例:codex 载体装出 hopbuild/hopbuild2 两目录;反例回归:CC 载体清单不因本修变化。
- **目标按 carrier 解析（`--dir` 覆盖；2026-09-02 加 cfuse 载体 + 读官方环境变量,见 ^anc-cli-carrier-home-resolution）**：`--dir` 显式指定 skills 根目录时直接用;缺席时按 `--carrier` 映射到对应载体 home 下的 `skills/`——`cc`→`$CLAUDE_CONFIG_DIR/skills`、`codex`→`$CODEX_HOME/skills`、`cfuse-cc`→`~/.codefuse/engine/cc/skills`、`cfuse-codex`→`~/.codefuse/engine/codex/skills`;`cc`/`codex` 的环境变量缺席时回落 `~/.claude`/`~/.codex`（原生默认,与 2026-08-27 作者定"codex 和 cc 看齐=用户级"一致）。

- **载体 home 解析（2026-09-02 作者定:cfuse 内置载体适配）** ^anc-cli-carrier-home-resolution：hopjit install-skill 原硬编码 `~/.claude/skills` 与 `~/.codex/skills`,在 cfuse 环境下装错位置——cfuse 内置的 Claude Code / Codex 通过官方环境变量 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 把 home 重定向到 `~/.codefuse/engine/{cc,codex}/`,skill 从重定向后的 home 读。两条安装路径必须都覆盖:
  - **场景一:在目标 agent 会话里跑 install-skill**（最常见——hoplogic3 是 agent 工具,用户在 cc/codex 会话里让 agent 装）。此时进程继承目标 agent 注入的环境变量,`--carrier cc`/`codex` 读 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 即自动装到目标 agent 的 home（原生或 cfuse 重定向均可）。用户视角:cfuse 内置窗口表现为原生载体,按该载体的原生命令跑即可,无需特殊 cfuse 命令。
  - **场景二:裸终端跑 install-skill,目标 agent 未启动**。此时无环境变量,且 hopjit 无从知道用户接下来要启动哪个 agent——环境变量只能反映"当前在哪",不能反映"装给谁",信息缺失。`--carrier cc`/`codex` 缺席环境变量时回落 `~/.claude`/`~/.codex`（原生默认）,若用户其实要装给 cfuse 内置载体就装错。
  - **解法:carrier 扩展为 `cc | codex | cfuse-cc | cfuse-codex`**。`cc`/`codex` 读官方环境变量（场景一自动适配当前环境）;`cfuse-cc`/`cfuse-codex` **不读环境变量**,固定 `~/.codefuse/engine/{cc,codex}/skills`（场景二裸终端显式指定 cfuse 目标）。读环境变量会与"裸终端指定 cfuse"的意图冲突——用户显式选了 cfuse carrier 就是声明目标,不该被当前进程环境（可能空、可能恰好是别的 home）覆盖。
  - **driver 源复用,不新写**:`cfuse-cc` 与 `cc` 共用 CC driver 源（`driver/hopspec-skill.md` 等）,`cfuse-codex` 与 `codex` 共用 Codex driver 源（`driver/codex/` 等）——cfuse 内置载体是 CC/Codex 本体套壳,skill 格式完全一致,仅 home 不同。代码层用 `carrierFamily(carrier)` 派生 driver 源系别（`cc`|`codex`）。
  - **`~/.codefuse` 硬编码可接受**:与硬编码 `~/.claude`/`~/.codex` 同性质（该工具的约定默认 home）;若 cfuse 未来提供 home 环境变量,`resolveCarrierHome` 的 cfuse 分支顺带读它。
  - **适用范围**:本条款的 home 解析同样适用于 `--mcp` 配置自举（CC 系读 `<home>/settings.json`、Codex 系读 `<home>/config.toml`）、MCP 注册（Codex 系写 `<home>/config.toml`）、`detectCcHopjitRegistration`（CC 系读 `<home>/.claude.json`）——所有按载体 home 定位的路径统一走 `resolveCarrierHome(carrier)`,不各自硬编码。
  - 正例:cfuse 用户在 cfuse 内置 cc 会话里 `hopjit install-skill`（零参数）→ 读 `CLAUDE_CONFIG_DIR` 装到 `~/.codefuse/engine/cc/skills`;裸终端 `hopjit install-skill --carrier cfuse-cc` → 装到 `~/.codefuse/engine/cc/skills`。反例:裸终端 `hopjit install-skill`（零参数,无环境变量）→ 回落 `~/.claude/skills`,cfuse 内置 cc 读不到（用户须显式 `--carrier cfuse-cc` 或在 cfuse 会话里跑）。
- **展开动作**（CC 载体，`--carrier cc` 默认）：
  - `driver/hopspec-skill.md` → `<目标>/hopspec/SKILL.md`（**改名**为 SKILL.md）
  - `skills/hopbuild/` → `<目标>/hopbuild/`（整目录，其 SKILL.md 已对名）
  - **旧名目录清理（rename 残留清理）**：CC 分支尾部检查 `<目标>/hopskill-build/`（hopbuild 的改名前旧目录名）——存在即 `rmSync` 整目录删除，并在 `installed` 清单记一条"旧名残留已清理"（src/cli.ts:1239-1241）。定性：这不是受管目录 manifest 清理（那套只删自己 manifest 里的 `.md`），而是 hopskill-build→hopbuild 一次性改名的残留兜底——旧名 skill 残留会与新名双触发。
  - `driver/references/` → `<目标>/hopspec/references/`（**随 skill 拷贝**，使 skill 自包含，不依赖 `<PKG>` 探测能否回指 node_modules——用户可能只装 skill 未装包，或全局装路径探测失败。拷贝后 skill 内 `<PKG>/driver/references/` 引用由自举探测解析：探到包→引包内；探不到→引 `.claude/skills/hopspec/references/` 本地副本作兜底）。references/ 是受管目录，`--force` 时清除源里已不存在的残留 `.md`（条款见下方 Codex 段"受管目录清理"——两载体同一契约）。
  - `--carrier codex`：按 [[codex-driver-carrier#^anc-driver-codex-install-layout]] 展开**按 agent 主体拆分**的 Codex skill：
    - `driver/codex/SKILL.md` → `<目标>/.agents/skills/hopspec/SKILL.md`
    - `driver/codex/agents/` → `<目标>/.agents/skills/hopspec/agents/`
    - `driver/codex/references/` → `<目标>/.agents/skills/hopspec/references/`
    - `driver/references/cli-discovery.md` → `<目标>/.agents/skills/hopspec/references/cli-discovery.md`
    - **不复制**公共 `driver-subagent.md` / `parallel-worker.md` / `step-execution-rules.md` / `discovery.md`；这些文件含 CC 载体原语，Codex 使用自己的 agent 与 reference 文件。
    - **受管目录清理（2026-08-13 立实撞销账;2026-08-24 hopissues/0022 改判据为自有安装清单——方案甲作者拍板）**：`references/`（CC/Codex）与 `agents/`（Codex）是**受管目录**。**受管的边界=清单不是目录**：安装器每次装机在受管目录落 `.hopjit-manifest.json`（本次写入的 `.md` 文件名列表+版本戳）;`--force` 清理**只删"上次 manifest 里有、本次源里已没有"的文件**——自己上版装的陈旧残留照删（2026-08-13 立意完整保留:parallel-worker.md 残留喂废协议致真机 41s 读废文档、健康活被 dispatch-lost 误杀）,**用户/别的工具放的文件天然豁免**（不在任何 manifest 里=不是我写的=无权删。原判据"源目录补集"把'受管目录'误解成'目录里所有 .md 都归我管'——probe 实证用户笔记 my-note.md 被无声 rmSync,且 dev-install.sh 缺省带 --force 让日常装机天然走此档;同一个 --force 同时表达'覆盖我的同名文件'与'删除我的非同名文件'两种强度悬殊的授权,后者现在收窄到零越权面）。**manifest 缺席（首次装/旧版装机）按空清单处理=零删除**,本次装机落新 manifest 后下次清理恢复正常——存量残留经一次正常装机周期自然进入清单管辖。响应 `removed` 字段列出实删项;非 force 不删（与"存在即跳过"对称）。清理只限受管目录、只删 manifest 内 `.md`——SKILL.md 顶层与用户其它 skill 不碰。
    - **【决策：依赖驱动】为什么不再装 AGENTS.md（2026-07-17 改定，由 Codex 官方 skills 机制查证触发）**：早期方案把驱动指令装为项目根 `AGENTS.md`，有三重错配——① AGENTS.md 是用户的项目级常驻指令（等位 CC 的 CLAUDE.md），驱动指令只是一个可选能力，占顶层身份即鸠占鹊巢，且与用户已有 AGENTS.md 冲突不可调和（跳过=装不上，--force=毁用户文件）；② AGENTS.md 每会话全文常驻（32 KiB 硬限），驱动指令常驻浪费用户注意力预算；③ Codex 官方明确"可复用 workflow 属 Skills 不属 AGENTS.md"，skills 描述常驻、正文按需加载（渐进式），且支持隐式触发（按 SKILL.md frontmatter description 匹配任务）。skill 布局三者全解。此决策随 Codex skills 机制演进复审。
- **`--mcp`：装 MCP 变体壳并同步注册 MCP server（2026-08-16 作者定——模式选定装配时化,见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]）**：
  - 壳：CC 装 `driver/hopspec-skill-mcp.md` → `<目标>/hopspec/SKILL.md`（同名 hopspec,与复用变体互斥同位——环境里恒一个变体）；Codex 装 `driver/codex/SKILL-mcp.md`；两变体共享 `references/discovery.md`（§0 spec 定位与参数组装是模式无关的人机前置）；
  - 注册：CC 合并写 `<cwd>/.mcp.json` 的 `mcpServers.hopjit = {command: "hopjit-mcp"}`（JSON 合并保留其他 server;项目作用域——.mcp.json 是 CC 项目级注册位）。**CC 跨 scope 已注册感知（2026-08-20 实撞立——开发库 local 级注册在场时 install 又写 project 级,CC 报同名多 scope 冲突诊断且新注册被窄 scope 盖住）**：写 .mcp.json 前先查 `<CC home>/.claude.json`（home 按 ^anc-cli-carrier-home-resolution 解析,原生=`~/.claude.json`）的 user 级（顶层 `mcpServers.hopjit`）与本 cwd 的 local 级（`projects["<cwd>"].mcpServers.hopjit`），任一在场即跳过不写、note 指明所在 scope——"已有条目跳过"原则的检测面补全:CC 注册面是三 scope 一体,只查 .mcp.json 看不见另两个;`~/.claude.json` 缺席/解析失败照常走 .mcp.json 判定（best-effort,CC 内部格式演进不拦装）；Codex 追加 `<Codex home>/config.toml`（home 按 ^anc-cli-carrier-home-resolution 解析,原生=`~/.codex`）的 `[mcp_servers.hopjit]`（command + `env_vars` 凭证名透传——Codex 干净环境启动 stdio server 实撞防线,值不落盘）。**env_vars 凭证名联动 standalone 配置（2026-08-20 实撞立——原硬编码 ANTHROPIC 对,standalone 配置用 DEEPSEEK_API_KEY 等其他凭证名时 server 拿不到凭证=启动即缺凭证,透传目的落空）**：取系统级 `~/.hopjit/config.yaml` providers 的 `api_key_env` 并集（含本次自举刚写的——自举先于注册执行）;读不到（配置缺席/坏文件/空表）回落缺省对 `["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]`。已有 hopjit 条目一律跳过并提示（注册配置是用户资产,--force 不覆盖注册面——force 只管壳文件）；
  - 响应 `mcp_registered` 字段（写入的配置路径,跳过时 null+原因）；
  - **配置自举（2026-08-17 作者定——没有已有配置时把主 agent 的 LLM 配置学习为 standalone 缺省模型,并向用户明示）**：仅当两级 standalone 配置（`~/.hopjit/config.yaml` 与 `<cwd>/hopjit.yaml`）**全缺席**时执行——已有配置是用户资产零触碰（与注册面同款纪律）。学习源按载体：**CC** = 两级链——①进程环境 `ANTHROPIC_*` 族；②环境缺席时读 **CC settings 文件族**（`<CC home>/settings.json`（home 按 ^anc-cli-carrier-home-resolution 解析,原生=`~/.claude`）与 `<cwd>/.claude/settings.json`/`settings.local.json` 的 `env` 块同名变量 + 顶层 `model` 字段,项目级>用户级——覆盖『在普通终端跑装配』的形态:settings env 块只在 CC 会话内注入子进程,终端环境是干净的;而运行期 MCP server 由 CC 拉起必继承 env 块,故凭证名引用仍有效）。凭证名 AUTH_TOKEN 优先、API_KEY 次之,**只写名不写值**〔standalone 不变量第 1 条——settings 里读到的也只取『哪个名字被配了』不抄值〕;BASE_URL 缺省 `https://api.anthropic.com`,MODEL 缺省引擎缺省模型;protocol=anthropic。两级链都空（如 OAuth 订阅登录——凭证在 keychain 无 env 名,且订阅凭证本不可复用给独立 server）→ 不写文件,note 如实明示需自建并配 API key；**Codex** = `<Codex home>/config.toml`（home 按 ^anc-cli-carrier-home-resolution 解析,原生=`~/.codex`）的 `model`+`model_provider`→`[model_providers.<id>]` 的 `base_url`+`env_key`（env_key 缺省 OPENAI_API_KEY 惯例;protocol 一律学为 **openai-chat**——openai-responses 适配器系枚举预留未实装,学它=交付启动即炸的配置,引擎自身报错文案即指路 openai-chat）。写入**系统级** `~/.hopjit/config.yaml`（providers 归系统级——跟人走）,`service_id=<carrier>_host`（命名忠实:值是宿主后端）,文件头注释注明学习来源与时间,**providers 节经 YAML 序列化器输出**（值来自宿主配置不可控——裸模板拼接遇 `: `/`#` 类字符产物即炸自家加载器,二审探针实抓）;学习源缺失（CC 无凭证 env / Codex 无 config.toml 或缺 model/base_url）→ **不写文件**,note 明示需自建;响应 `+mcp_config_bootstrapped`（写入路径,未自举 null）`+mcp_config_note`（明示学了什么——模型/端点/凭证名,或未学习原因）。
- **`--demo`：附装全部演示 skill（2026-08-11 作者改定：装所有 demo + 名字统一防冲突污染；2026-08-06 原定默认不装不变）**：带 `--demo` 时在装完 driver skill 后，内部走 carrier-aware pack，装入**demo 集全部成员**，skill 名一律 **`demo-` 前缀**（pack 传 `name` 参数；spec 自身 `Id` 不改——Id 牵动 call 引用与 hoplog spec_id）。前缀是命名空间：用户一眼识别哪些是演示件、可整批删除，且绝不与用户自己的 skill 名撞车。当前 demo 集：
  | skill 名 | 源 spec | 资产 | 演示什么 |
  |---|---|---|---|
  | `demo-coffee-week` | `examples/coffee-week.md` | `coffee-sales.json` | 入门：ask 确认 + act 纯计算 + reason 判断 + check 核验 |
  | `demo-fact-check` | `examples/fact-check-demo.md` | `fact-check-sample.md` | 实战：for-each 并行核查一级事实（fact-check 完整版的适度简化——只核可直接查证的事实断言，不做推演审查/自查回路） |
  | `demo-rename` | `examples/syntax/confirm-commit.md` | — | 探索提交分离：批量重命名——act 探索 → confirm 人审 → commit 不可逆（幂等设计；教程 03 主角） |
  CC 入口 `/demo-*`，Codex 入口 `$demo-*`（也可经 `/skills` 选择）。均依赖同载体 hopspec driver，不复制驱动协议。默认不装：demo 不该未经请求占用户的 skills 目录。InstallSkillResponse 的 `installed` 含各 demo 路径；任一 demo 安装失败记 note 不中断其余。
- **`--plus`：附装进阶研究件并自动落位工具配置（2026-08-30 作者定"install-skill --plus 这样比较简单的"——进阶件不进缺省〔缺省件铁律=零配置可跑,这两件依赖外部工具注册,不配即死;deep-research 另有费用时长面〕,但值得一开关到位）** ^anc-cli-install-skill-plus：带 `--plus` 时做三件：
  1. **装 plus 集**（carrier-aware pack,与 --demo 同机制;名字即 spec Id 不加前缀——这两件本就带 hop- 前缀命名空间）：
  | skill 名 | 源 spec | 资产 | 是什么 |
  |---|---|---|---|
  | `hop-fact-check` | `examples/hop-fact-check.md` | `fact-check-sample.md` | 事实核查完整版（断言提取+并行检索验证+推演审查+可信度分级报告） |
  | `hop-deep-research` | `examples/hop-deep-research/hop-deep-research.md` | `hop-deep-research-sample.md` | 深度研究（子问题分解+双语检索+对抗式验证+引用报告+落盘交付） |
  安装位=正式件同点（CC 用户级 `~/.claude/skills`,Codex 项目级）;已存在跳过,`--force` 覆盖——与既有防覆盖口径一致。
  2. **工具配置自动落位**：把 `examples/hoptools-websearch.yaml` 与 `examples/hoptools-playwright.yaml` 的 `tool_servers` 条目**合并写入系统级 `~/.hopjit/config.yaml`**——按 server `name` 判重（`bailian_search`/`playwright`）,已有同名条目跳过不覆盖（用户资产纪律,与 --mcp 注册面同款）;config.yaml 缺席则新建只含 tool_servers 节;YAML 经序列化器输出不裸拼。响应 `plus_tools_merged` 字段（写入的 server 名列表,全跳过时空表+note 说明）。
  3. **打印剩余人工动作**（自动化替代不了的一步）：note 明示"export DASHSCOPE_API_KEY=<百炼key>（web_search 凭证;Playwright 首跑自动下载浏览器 ~150MB）"。
  npm 包前提：`files` 白名单补 `examples/hop-fact-check.md`、`examples/hop-deep-research/`（目录含 spec+sample）、两份 hoptools-*.yaml。默认不装：与 --demo 同理,进阶件不该未经请求占用户目录与配置。
- **版本可见性（2026-08-04 补，2026-08-05 修正 frontmatter 顺序）**：①响应带 `driver_version`（=包 package.json version）与 `driver_source`（=包根绝对路径）——用户一眼看出"装的是哪个版本、从哪来的源"（全局包 vs 本库开发源）；②展开的 `<skill>/SKILL.md` 在 YAML frontmatter 闭合线后注入一行 HTML 注释版本戳 `<!-- driver: @hoplogic/hopjit v{version} ({source}) installed {ISO时间} -->`——已装副本自身可查（`head -5` 即见），不依赖当初的安装响应。Codex 要求 `SKILL.md` 第一行必须是 `---`，版本戳不得前置。
- **输出 InstallSkillResponse**：`{ status:'ok', carrier, driver_version, driver_source, installed: [路径…], target }`；`--mcp` 时另带 `mcp_registered`/`mcp_note`/`mcp_config_bootstrapped`/`mcp_config_note`（配置自举明示——学了什么模型/端点/凭证名,或未学习原因）；失败 `{ status:'error', message }`。
- **为何随包发 driver 是前提**：install-skill 从 `node_modules/@hoplogic/hopjit/driver/` 读源——`files` 白名单必含 `driver/`（已含）。
- **入门 examples 随包（2026-08-04 作者定；2026-08-05 收平路径——作者指出别让新手多敲字）**：入门四件（`data-quality.md`+`doc-review.md`+`demo-data.json`+`GETTING-STARTED.md`）直接放 `examples/` 根随包（files 白名单按文件挑），**仓库路径与包内路径同形**——新手命令恒为 `run examples/data-quality.md`，无论 clone 仓库还是纯 npm 全局装都一次命中（getting-started 子目录曾致命令变长+两处路径不同形，已废）。全量 22 个 spec 仍只在仓库。

**`hopjit pack` 契约** ^anc-cli-pack：把一个 hopskill spec 打包成**独立具名 skill**——用户视角是"装了一个叫 doc-review 的能力"，HopSpec/hopjit/通用 driver 全部成为实现细节。**validate 闸门含 doc-ref 解析上下文**（hopissues/0077——原恒缺席 P15 空转:知识文件/章节缺失 validate 报 error 而 pack 照 ok 写产物,打包假绿;pack 是交付时点知识闭合是产物硬要求,不用 validate 命令的 lenient 跨目录降级——error 即拒不写产物;知识文档收集面缺失同响亮拒,静默跳过=产物装上即 P15）。默认 `--carrier cc` 保持既有行为；`--carrier codex` 生成 Codex 项目 skill；`--carrier cfuse-cc`/`cfuse-codex` 复用对应原生系的包装模板（CC 系 `/skill` 或 Codex 系 `$skill`）。pack 的 `--dir` 缺省是项目级（`.claude/skills` / `.agents/skills`,按 carrierFamily）——与 install-skill 不同,pack 产物跟项目走;cfuse 用户要装到 cfuse home 用 `--dir` 显式指定（如 `--dir ~/.codefuse/engine/cc/skills`）。pack 产物薄包装的前置段按 carrier 生成装驱动命令/位置（cfuse-* 指引 `--carrier cfuse-*`,不硬编码原生 `~/.claude`/`~/.codex`）。用户要的是具名能力，spec 是能力实现。

- **name 覆盖时 Id 随名改写（2026-08-11 作者指出"Id 不动会干扰目标环境"后补定）**：`--name`（或内部 name 参数）与 spec 自身 `Id` 不一致时，打包**副本**的 `Id:` 行改写为 name——Id 是运行痕迹的命名根（hoplog 目录 `<spec_id>-<时间戳>`、状态元数据、call 寻址），skill 名与 Id 不一致会让 demo-rename 的运行留下 confirm-commit-* 日志，且可能与用户同 Id spec 的痕迹混淆。**源文件不动**（改的是 skill 内副本）；不传 name 时零改写（原样打包，既有行为不变）。⚠️ 副本 Id 改写后，其它 spec 若按旧 Id `call` 该副本会找不到——demo 场景无此耦合；将来出现"打包被 call 依赖的 spec"需求时复审。

- **输入**：spec 文件路径。先 `parseSpec` 校验（validate 闸门，error 即拒——pack 不放行坏 spec），并从 AST 取 `id`（默认 skill 名）与 `goal`（生成触发描述）。
- **目标与展开布局**：
  - CC：目标默认 `.claude/skills/`，显式入口 `/<skill名>`；
  - Codex：目标默认当前项目根下 `.agents/skills/`，显式入口 `$<skill名>`；Codex 会从当前目录到仓库根扫描 `.agents/skills`。
  - 两者均展开为 `<skill根>/<skill名>/SKILL.md + spec.md + references/assets`。
  - `SKILL.md`——**生成的薄包装**（见下），frontmatter `name`=skill 名、`description`=由 goal 生成的触发描述（含中文任务动词，CC 隐式触发靠它）；
  - `spec.md`——spec 文件原样拷入（改名 spec.md，skill 目录即自包含）；
  - spec 引用的**知识文档**（doc-ref `[[X#…]]` 提到的同目录 .md）逐个拷入——doc-ref 按 cwd 相对解析，spec 与知识文档必须同目录（同 hopbuild 的知识文档同住约定）；
  - **数据资产**（`--assets <逗号分隔文件名>`，2026-08-06 补；**2026-09-04 扩目录形态**——hopissues/0069 多文件 skill 语料实锤：成熟 skill 的附属资产是 `references/`、`scripts/` 整目录，逐文件点名既繁琐又易漏）：spec 运行依赖的非 .md 资产（演示数据 JSON/CSV、引用文档目录、脚本目录等）逐个从 spec 同目录拷入 skill 目录——条目是文件即拷文件，是**目录即整树递归拷入**（保持相对路径结构，产物内指针原样可解析）；skill 目录即自包含可分发单元，装完即可跑、不依赖用户现场备数据（作者原则："数据集当然应该现场准备好"）。资产不存在即 error 拒 pack（防呆：不产出一个装上就跑不了的 skill）。
    - 【决策：依赖驱动】为什么走 `--assets` 参数而非 spec 头部 `Assets:` 声明：后者是 spec 文法（语言面）改动，权威在概念层，而 `docs/concepts/` 是库内只读快照——本库无权加语言特性。`--assets` 落在适配层职权内，零文法改动。若概念层将来引入资产声明，此参数降级为覆盖手段，随之复审。
- **🔴 用户注意力原则（pack 产物的第一设计约束，2026-08-04 作者定）**：hopskill 是**给非程序员用户**用的，非 debug 模式——**注意力是最宝贵的资源，不要浪费**。落为三条硬要求：①包装 SKILL.md 指示执行 LLM **不向用户展示内务**（CLI 探测、路径解析、状态目录、JSON 结构等命令行细节一律不进对话，只报"在做什么"级别的一行进度）；②面向用户的语言**零行话**（不说 spec/引擎/介入点/subagent，说"步骤/任务/需要你确认"）；③用户看到的只有三类内容——**要收集的输入、必须拍板的暂停点、最终交付物**。debug 视角是 /hopspec 技术用户的事，不是 pack 产物的事。
- **前置段版本声明（hopissues/0051,2026-08-31 作者拍定"只提示+给升级命令"——低版本场景的指路责任）** ^anc-cli-pack-version-floor：两载体薄包装 SKILL.md 的前置段第 1 条从静态句改为**带打包时版本的精确句**——"hopjit 引擎已安装且版本 >= X.Y.Z（本 skill 由该版本打包;`hopjit --version` 可验证,低于则先升级:`npm i -g @hoplogic/hopjit@latest`）"。X.Y.Z 取 `readPackageVersion()`（版本单一事实源 ^anc-cli-version-single-source——不写第二份真值,报告卡拍板点②直采）。**为什么闸长在包装层不在引擎**：低版本场景里执行 parse 的正是旧引擎——旧引擎不认识新语法才报语法错误,让它"识别新语法并改报版本过低"等于它已经不旧,逻辑死结;spec 文件自身加版本字段属概念层文法权威,本库快照无权改。故前置检查的执行位=薄包装的指引文字（caller agent 读到版本要求会跑 `hopjit --version` 比对,低则按指引先升级——**只提示不默认升级**:`npm i -g` 改全局环境是不可逆外向动作,默认做违背"不可逆须授权"一贯口径,且可能破坏用户其它项目的版本依赖;提示文案自带命令,升级代价=一次确认〔2026-08-31 作者拍 A〕）。正例:pack 产物前置段含当前包版本号与升级命令;反例:版本号写死字面量（第二真值——包升版后 pack 产物仍写旧版即谎报）。

- **薄包装 SKILL.md 的内容契约（壳层原则,2026-08-15 作者定单立——hopbuild 自举实撞三连沉淀,适用一切 pack 产物的壳）** ^anc-cli-pack-shell：
  - **参数引导只列用户真有信息的参数**：agent 自供参数（探测值/环境值）不进参数表——执行 agent 装了 /hopspec 就已按驱动协议持有 CLI 等环境事实,列出来=把内务当参数问用户;
  - **内务零披露**：不罗列知识文档/注入机制/spec 内部结构——引擎 doc-ref 自动注入,agent 无需知道这些文件存在;写出来=诱导预读后在会话里手工执行判据,绕开引擎强制（自举要消灭的旁路）;
  - **@trace note 只写定位句**：演进史归 git log,不塞流水账（每个读壳的 agent 都要吞一遍 note）;
  - **交付段**（2026-08-15 作者抓'壳的输出还没对上'——三段式漏的第四段）：列 spec `## Outputs` 各交付物+呈现口径（触发 agent 拿到终态后照此向用户交付,与 spec Outputs **严格对齐**——壳的参数段对齐 Inputs,交付段对齐 Outputs,两头都不悬空）;有后续动作指引（如 pack）写在此段;
  - 四段式（触发/参数/执行委托/交付），总量控制在一屏内，禁止混用载体原语——
  1. 触发说明：这个 skill 做什么（goal 原文）、什么时候用；
  2. 参数引导：列 spec `## Inputs` 各参数名+类型+注释，指示 CC 用对话/AskUserQuestion 向用户收集（缺省值按 spec 声明）；
  3. 执行委托：CC 包装委托 `/hopspec`；Codex 包装读取同级 `../hopspec/SKILL.md` 并按该 driver 执行本目录 `spec.md`。pack 不内嵌整套驱动协议：驱动逻辑单一权威在 hopspec skill，内嵌即第二真值。
- **依赖关系（显式）**：pack 产物**依赖 hopspec skill 已安装**（驱动协议）与 hopjit CLI 可探测（引擎）。SKILL.md 包装内写明这两个前置及自检指引。
- **幂等/覆盖**：同 install-skill——存在不覆盖，`--force` 覆盖。
- **输出 PackResponse**：`{ status:'ok', carrier, skill_name, target, installed:[…], knowledge_docs:[…], assets:[…] }`；未知 carrier、spec 校验失败或资产缺失返回 error。
- **与 hopbuild 的闭环**：自然语言 skill →（/hopbuild 翻译）→ spec →（pack）→ 更可靠的同名具名 skill。用户视角是"skill 升级了"，用法零变化。hopbuild 翻译完成的交付提示中加 pack 指引。

**状态加载语义**：init / validate / list 不加载已有实例（list 无状态）；其余命令调业务方法前先从快照加载，分两种语义（见「状态加载契约」）：
- **load（保留 running）**：submit_and_fetch_next / debug_step / status / vars —— 日常推进与查询，running 是合法持久态
- **recover（重置悬空 running）**：仅 resume —— 崩溃恢复

**`--branch` / `--replan`**：正常流程中 branch 由 Engine 内部条件评估自动处理（见 [[exec-engine]] next_step），`--branch` 仅手动覆盖/调试/HITL 介入时用；`--replan` 应答 `adaptive_needed`。

所有响应类型（InitResponse、NextResponse、CommandResponse、VarsResponse、StatusResponse、ReplanResponse）定义于本文档「CLI 响应类型」章（原在 shared-types.md，2026-07-02 归位 hop-cli——它们是 CLI 命令的对外 JSON 契约，属 hop-cli 模块）。

---

## 命令契约【契约】

**一命令一 Engine 方法（薄壳分层契约）** ^anc-cli-dispatch
每个 CLI 命令解析参数后**恰好调用一个** Engine 方法并序列化其返回值，命令间不组合多个 Engine 调用、不维护跨命令状态。命令↔方法映射见 CLI 命令表的「路由到」列。CLI 不实现任何业务逻辑（调度/状态机/重试/变量作用域/**节奏与消化**全在 Engine）——这保证 CLI 路径与进程内 API 路径行为一致。

> 这是**设计层的分层选择**（取舍：逻辑归引擎换取两路径行为一致），非宪法级原则。`submit_and_fetch_next` 虽含多种提交参数，仍是"一命令一方法"——按参数选**一个**回写方法 + completeAndAdvance（后者是引擎单一方法）。节奏消化逻辑归引擎（[[exec-engine#^anc-exec-advance-to-caller]]）后，CLI 再无业务逻辑例外。

**实例解析** ^anc-cli-instance-resolve
`--instance` 省略时，CLI 取 `state_dir` 下最新（按目录 mtime 或 run_id 时间戳排序）的实例目录作为目标。显式传 `--instance id` 时直接定位该实例，**且先做目录在场校验**（2026-09-01 作者令"按工程链修"——live:core codex:parallel 实撞：driver 手抄实例号丢一字符，缺校验时错号一路走到 persistence 读 spec.json 撞 ENOENT，报 `CORRUPT_STATE_FILE`"状态文件损坏"——两种病一张脸：收报文的 driver/人不会想到是自己把号抄错了，排障方向被误导。LLM driver 手抄 UUID 是常态误差面，报文必须让它能自纠）：目录不存在 → 报 `INSTANCE_NOT_FOUND: 实例 <id> 在 <state_dir> 下不存在——若实例号是手抄的请核对有无抄错`（提醒句是报文的一部分——报文的读者常是抄错号的 LLM driver，直接点破最常见成因），**并列出该 state_dir 下真实存在的实例目录名**（按 mtime 新前旧后，最多 5 个——指路：抄错号的一眼能对出正确的号；空目录如实说"目录下无任何实例"；state_dir 本身不可读时如实报"state_dir 本身不可读"——指路失败不掩主错误）。**校验覆盖 CLI 全部实例定位通路**（2026-09-01 review 面二抓：初版只在 --instance 参数通路，`run --call-parent` 的父实例定位直调 load 绕过校验，错号父实例仍报旧病——收纯是全称承诺，凡 CLI 收外部实例号的入口同经 resolveInstance）。`CORRUPT_STATE_FILE` 语义随之收纯：目录在而状态文件缺/坏（崩溃半写、真损坏）才是它。**半初始化子实例目录再收窄一档**（0059 实撞:父已写 params.json 但 child 未 init,目录在场而 spec/state/vars 三件全缺——按上句口径报 CORRUPT_STATE_FILE"spec.json 不可读",报文教人往"文件损坏"方向排障,而病是"子实例从未完成初始化"）:实例定位命中目录后、交 Engine.load 前,**探测 state.json 在场性**——缺席且目录内无 spec.json → 报 `INSTANCE_NOT_INITIALIZED: 子实例 <id> 目录在场但未完成初始化（无 state.json/spec.json——常见成因:child 启动失败留下的半截目录）。删除该目录后重新派发即可`;state.json 在场而内容坏才是 CORRUPT_STATE_FILE 的地盘。三档语义排开:目录不在=INSTANCE_NOT_FOUND / 目录在而未初始化=INSTANCE_NOT_INITIALIZED / 初始化过而文件坏=CORRUPT_STATE_FILE——每档报文指路各自的处置。校验只在显式 `--instance` 分支——省略分支取的就是真实存在的目录，天然无此病。CLI 自身不读写实例内状态文件，仅把解析出的实例标识/目录传给 Engine。

**状态加载契约** ^anc-cli-state-load
除 init（新建实例）外，每个命令先用 `ExecutionEngine.load(dir)` 或 `recover(dir)` 从快照重建引擎实例，再调一个业务方法。**加载是前置构造，不计入「一命令一 Engine 方法」**——它产出引擎实例而非业务结果。两个加载入口的语义差异是关键契约（概念见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-durable-resume]]）：
- **load**——保留 running。日常命令（submit_and_fetch_next/debug_step/status/vars）用。复用模式下 running 是"已交付 caller、正等回写"的合法持久态，重置会打断 run→submit 跨进程流
- **recover**——重置悬空 running 为 pending（branch 已选 case 特例除外）。仅 `hopjit resume` 用。崩溃时的 running 无回写记录，是悬空的
- **为何由命令显式选**：引擎无法仅凭 running 状态区分"已交付待回写"与"崩溃悬空"，故加载语义由调用入口（命令）决定

**通知挂点·复用模式（2026-08-31 作者定"给/hop 加一个钉钉通知功能"——0052'复用模式不挂待真需求'预留的真需求到场）** ^anc-cli-notify-reuse

standalone 挂点契约（[[mcp-server#^anc-mcp-notify-hook]]——三与门/事件面/卡片规格/失败旁路）在复用模式的对称落地。与 standalone 的三点差异是本节的全部内容,其余同款不复述：

**能力契约（HopTrait）**：

```
trait: CliNotifyReuse
  Id: cli-notify-reuse
  Constraints:
  - 开关跨进程:run 命令 --notify <渠道> flag → **StateFile.notify_channel** 持久（字段实况落 state.json 的 StateFile,src/runtime-types.ts:105——EngineSnapshot 经其 state 成员携带该字段落盘,持久化语义等价;terminal_state 先例同款:置值入 state,load 恢复——复用模式每条命令新进程,内存标志无效;存渠道名不存布尔——命名忠实:字段装的是"用哪个渠道",不是"要不要"）
  - 挂点=CLI 公共出口:outputWithNotify(result, engine)——五个可达终态/停点的命令（run/submit_and_fetch_next/reap_and_fetch_next/advance/resume）拿到 NextResponse 后、output() 前统一过此函数（一处实现五处调用,不逐命令散挂）
  - 二与门（2026-08-31 作者定"每次 hop 时说,否则太烦"——渠道随话语走,零配置文件）:①state.notify_channel 在场（run --notify dingtalk 置入,渠道值来自用户话语——"跑完钉钉通知我"点名了渠道,driver 只翻译不判断;flag 值非法渠道启动即拒响亮报可用渠道枚举）②凭证 sendDingtalk 自查。缺门①静默跳过,走到发送而失败记 stderr 一行。**与 standalone 三与门的分道**:standalone（MCP server 长活进程,^anc-mcp-notify-hook）保留 config notify 节声明通道——server 场景配置一次多 run 共享合理;复用模式每 run 都是用户现场一句话,再要配置文件=说了通知还得先配文件手机才响,正是"太烦"本体。原设计的门②（hopjit.yaml notify 节+readProjectNotify）随本条退役不实装
  - paused 同发（与 standalone 对称——复用模式长活同样有"用户走开"场景:driver 停在 confirm 等人时用户可能已离开对话;且门①已是"用户要了才发",要了通知的用户想被叫回来）
  - 卡片渲染共享:composeRunCard（tools-notify.ts,与 sendDingtalk 并列——一份渲染两处挂点〔mcp-server.maybeNotify 与本挂点〕同调,消两处组装漂移面;渲染函数住通知模块=代码归置,调用责任仍在挂点侧,sendDingtalk 仍只收文本,与"工具只收文本"口径不冲突）
  - 通知失败恒不拖垮:发送 await 但带 5s 超时兜底（**短命进程条款——与 standalone 的 fire-and-forget 分道**:CLI 每命令一进程,fire-and-forget 会被进程退出掐死〔实测:发送尝试竞态丢失〕;"不拖垮"在短命进程形态=不无限等,不是不等——发送最多拖住进程 5s,超时/失败记 stderr 一行放行）,output() 恒执行
```

**类型约定（HopType）**：

```
struct: EngineSnapshotNotifyExt    # StateFile 新字段（代码实况落 src/runtime-types.ts StateFile.notify_channel:105——快照经 EngineSnapshot.state 携带同一字段持久化,等价;terminal_state 同款可选形态。struct 名保留历史命名,字段归属以本注为准）
  Id: engine-snapshot-notify-ext
  Fields:
    - notify_channel: line     # 可选,缺省缺席=不通知——run --notify <渠道> 置渠道名持久（现枚举只 dingtalk）,load 恢复;子实例不继承（通知归顶层 run,worker 不发）

struct: RunCardInput               # composeRunCard 入参（两挂点共用的数据面）
  Id: run-card-input
  Fields:
    - spec_title: line       # 卡片名（人读的"这活叫什么"——恒取 spec 标题,不用文件名）
    - state: line            # completed | failed | paused（徽记三态映射 ✅/❌/⏸️）
    - completed_steps: int   # 进度分子
    - total_steps: int       # 进度分母
    - current_step: line     # 可选,当前步/失败步
    - paused_question: text  # 可选,停点问题摘要（paused 卡片正文）
    - run_id_tail: line      # 实例 id 尾段（多 run 并存对号）
# 返回 {title: line, text: markdown}——text 是 markdown 卡片正文,喂 sendDingtalk
```

**关键逻辑（HopSop）**：

```
outputWithNotify(result, engine):
1. [条件(result.status ∈ {completed, failed, paused} 且 engine state.notify_channel === 'dingtalk')] 走通知支路,否则直接 output(result)
2. composeRunCard(从 engine.getStatus()+getSpec().header.title+result 组数据) → {title, text}
3. await Promise.race([sendDingtalk({title, text}), 5s 超时])——失败/超时记 stderr 一行（短命进程条款:见 Trait 末条）
4. output(result) 恒执行（通知是旁路,主流程响应先行无阻塞语义变化）
```

测试正反例：--notify dingtalk 记入 state 且跨进程可见（run 后另起命令读快照）;终态发送 fetch 桩收 ✅ 卡片含 spec 标题;未 --notify 零发送;--notify 带非法渠道启动即拒;发送异常 output 照常返回;paused 停点发 ⏸️ 卡片。composeRunCard 三态渲染单测归 tools.test.ts。driver 接线口径：用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ /hop 建卡后 run 命令带 --notify dingtalk（发不发判断恒归引擎门,driver 只翻译意图不自作主张——没点名渠道就不带 flag）;MCP 载体=start_run params 带 hop_notify:true（standalone 侧契约不随本条变,分道理由见 Trait 二与门条款）。

**~~通知推送 notify~~（已退役,2026-08-30 当日立当日撤——作者定"tools 不再直接通过 hopjit cli 外露"）** ^anc-cli-notify

同日三连纠后收口：①"不是做一个 hopjit cli 给人用,是给 hopspec 和 hop 用的"→②"没说钉钉通知为啥会通知"→③"hopjit 阉割=tools 不再直接通过 hopjit cli 外露"。CLI 不承载工具能力外露——工具能力恒经工具面（ToolProvider 装配）,通知的正式形态=注册工具模块+引擎终态/停点配置驱动挂点（归 todo/0052 后续批次:设计归口 docs/design/tools/ 子目录）。notify 命令与 NotifyResponse 当日实装当日移除,实现史归 git log。

**本条与 tool-call 命令的分界（2026-08-31 作者定"hopjit cli 应该是工具的标准出口了,因为要被复用模式调用"——两条裁决不冲突,消费方不同）**：本条封的是**给人的命令面**——把工具做成 `hopjit notify` 这类面向终端用户的独立命令,导向"普通人直接用 hopjit"的错误定位。`hopjit tool-call`（通道⑥,[[tool-channels#^anc-exec-tool-channels]]）是**给复用模式 driver 的机器通道**——caller agent 在 act free 执行期按 L4 清单调引擎内建工具,引擎实现是唯一语义源,driver 不用 Bash 模仿。判据一句话:命令的预期使用者是人=违反本条;是 driver 按清单指引的机器调用=通道⑥职权。tool-call 因此是复用模式的工具标准出口,不是本条的翻案。

**实现**：TypeScript（代码侧），文件 `src/cli.ts`（commander.js）。

---

## CLI 响应类型【契约】 ^anc-cli-response-types

> 各 CLI 命令序列化到 stdout 的 JSON 响应结构。2026-07-02 从 shared-types.md 归位——它们是 hop-cli 模块的对外 JSON 契约（driver 依赖），属 CLI 命令表「响应类型」列的类型定义。`SpecError`/`ErrorCode` 见 [[shared-errors]]，`OutputDecl`/`StepSummary`/`RetryRecord`/`ExecEvent` 见 [[shared-types#^anc-type-auxiliary]]，`$file`/`preview` 卸载见 [[shared-types#^anc-exec-deflate]]。

### InitResponse（hopjit init） ^anc-cli-init-response

```
struct: InitSuccess
  Id: init-success
  Fields:
    - status: line           # 恒为 'ok'
    - instance_id: line      # 新建实例 ID
    - warnings: [SpecError]  # 可选。warn 级校验结果（不阻断 init，但透传供作者修复）

struct: InitError
  Id: init-error
  Fields:
    - status: line         # 恒为 'error'
    - errors: [SpecError]  # ParseError 或 ValidationError（仅 error 级）
```

（TS 形态是代码层投影，在 src/cli-types.ts——设计以本 HopType 为准。）

init 跑完整校验：**error 级阻断**（不创建实例、不写状态目录），**warn 级不阻断但透传**到 `InitSuccess.warnings`——警告被吞掉等于不存在（见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-validation]]）。

### ValidateResponse（hopjit validate） ^anc-cli-validate-response

**片段模式 `validate <file> --fragment [--known-vars a,b,c]`**（hopbuild 单轮核查用——逐节点展开的 spec 片段无完整头部）：**parser 原生吃裸片段**（parseFragment:输入=裸步骤序列,无 `# 标题`/`## Steps` 节头也直接解析——不是内部拼假头骗过整文验证器;原生解析的实利:报错行号=片段文件真实行,拼头会整体偏移）,validator 只验**片段自身的合法性**,豁免整文完备性类规则（S8 goal 必备/S10 头部结构/exit 交付完整性/P10 输出无产出 warn——片段天然不完整,报了全是噪声）;`--known-vars` 逗号分隔的上层已知变量名,注入 V1 可追溯来源（片段引用上层变量不误报凭空引用;类型未知按通配匹配——类型核对归整文 validate）。片段仍全量执行的面:步骤文法/容器结构（C 族）/片段内变量流（V 族,含 known-vars 扩展来源）/特殊步骤规则（P 族除 P10）。**片段编号从 1 起**（相对编号——片段是自足局部,`3.2.1.` 类绝对路径起头会因祖先不在场被树装配拒;调用方并入全文时自行改写编号）。响应结构与整文模式同形。


```
struct: ValidateResponse
  Id: validate-response
  Fields:
    - status: line           # 'ok' 或 'error'——error = 存在 error 级违规（spec 不可执行）；ok = 无 error（可能有 warn）
    - errors: [SpecError]    # error 级违规（空 = 结构合法）
    - warnings: [SpecError]  # warn 级违规（建议修复）
```

`validate` 与 init 共用同一套校验规则（规则集权威与条数归 [[spec-parser]]——本处不复记具体数字,历史上此处写死"35 条"后随批加规则失配），区别在于：validate 只读（不创建实例、不写状态）、且 error 与 warn **全集返回**（不阻断——它本就是给作者看的检查报告）。纯结构校验，不需要 params。

### ListResponse（hopjit list） ^anc-cli-list-response

```
struct: ListResponse
  Id: list-response
  Fields:
    - status: line   # 恒为 'ok'
    - dir: line      # 被扫描的目录
    - specs: [yaml]  # 每项 { file: 文件名（非全路径）、id: ast.header.id（缺省用 title）、goal: Goal 首句 }；按文件名稳定排序，排序偏好（recent 优先）由 skill 决定。可执行判定规则见 [[hop-cli#^anc-cli-list]]
```

`list` 对目录内每个 `.md` 做 `parseSpec` 后判定可执行 spec（goal 非空 + steps 非空 + 排除设计文档），解析失败的跳过。无状态纯函数（同 dir → 同输出），便于测试与跨 runtime 复用。recent-dirs LRU 与首次目录交互留 skill，引擎不假设 `.hopspec/` 布局。

### InstallSkillResponse（hopjit install-skill）

```
struct: InstallSkillResponse
  Id: install-skill-response
  Fields:
    - status: line                    # 'ok' 或 'error'
    - carrier: line                   # 本次安装的载体（cc/codex/cfuse-cc/cfuse-codex）
    - driver_version: line            # 包 package.json version（装的是哪个版本）
    - driver_source: line             # 包根绝对路径（从哪个源装的）
    - target: line                    # 展开目标 skills 目录
    - installed: [line]               # 本次写入的文件/目录路径清单（含 demo/plus 附装项与"旧名残留已清理"记录）
    - removed: [line]                 # 可选。受管目录清理实删项（--force 档才出现）
    - demo_note: line                 # 可选。--demo 附装说明（已存在跳过/某 demo 安装失败）
    - plus_note: line                 # 可选。--plus 附装说明（含剩余人工动作提示）
    - plus_tools_merged: [line]       # 可选。--plus 合并进 config.yaml 的 tool server 名列表
    - legacy_note: line               # 可选。Codex 旧项目级残留检测提示
    - mcp_registered: line            # 可选(--mcp 时恒带,可为 null)。写入的注册配置路径,跳过时 null
    - mcp_note: line                  # 可选。注册跳过原因（已有条目/scope 冲突指路）
    - mcp_config_bootstrapped: line   # 可选(--mcp 时恒带,可为 null)。配置自举写入路径,未自举 null
    - mcp_config_note: line           # 可选。自举明示——学了什么模型/端点/凭证名,或未学习原因
    - note: line                      # 可选。零写入提示（目标已存在,用 --force 覆盖）
```

（代码实况：本响应无独立 TS 类型——形状在 `cli.ts` install-skill 命令的 output 字面量（src/cli.ts:1390-1405），可选字段按条件展开。失败形态 `{ status:'error', message }` 经 errorExit 走 stderr。）

### PackResponse（hopjit pack）

```
struct: PackResponse
  Id: pack-response
  Fields:
    - status: line          # 'ok' 或 'error'
    - carrier: line         # 打包目标载体
    - skill_name: line      # 最终 skill 名（--name 覆盖或 spec Id）
    - target: line          # 产物落点目录
    - installed: [line]     # 本次写入的文件路径清单
    - knowledge_docs: [line] # 随包收集的知识文档清单（doc-ref 闭合面）
    - assets: [line]        # 随包资产文件清单（--assets）
    - note: line            # 可选。零写入提示（目标已存在,用 --force 覆盖）

struct: PackError
  Id: pack-error
  Fields:
    - status: line          # 恒为 'error'
    - message: line         # 错因（spec 不存在/解析失败/校验失败/资产缺失）
    - errors: [line]        # 可选。parse/validate 逐条错误
```

（代码实况：TS 形态是 `cli.ts` 内部 `PackResult` 联合类型（src/cli.ts:1419-1421）——pack 命令与 install-skill --demo/--plus 共用 `packSpec()` 返回同型。）

### NextResponse（hopjit next） ^anc-cli-next-response

NextResponse 是联合类型，8 形态由 `status` 字段区分：StepReady / AdaptiveNeeded / ExecutionCompleted / ExecutionFailed / ExecutionPaused / ToolRequest / DrainWait / DispatchReady（后三者形状权威见 [[exec-engine#^anc-exec-tool-request]] 与 [[parallel-execution#^anc-exec-parallel-reap-drain]]）。

```
struct: StepReady
  Id: step-ready
  Fields:
    - status: line                # 恒为 'step_ready'
    - instance_id: line           # 所属实例 ID
    - step_id: line               # 步骤 ID，如 "2.1.3"
    - step_type: line             # 枚举 reason/act/check/confirm/ask/commit/call（ExecutableStepType）
    - summary: line               # 摘要行描述
    - context: AssembledContext   # 装配好的执行上下文
    - work_zone: line             # 实例 work_zone 工作区绝对路径（driver 写临时文件用，见 [[exec-engine#^anc-exec-work-zone]]）
    - output_path: line           # 本步输出文件确切路径（<work_zone>/out_<step_id>.json，^anc-exec-work-zone 权威）
    - call_protocol: CallProtocol # 可选。仅 step_type=call 且复用模式 CLI 通道（engine 持 cliAbsPath+specPath）——命令拼装权归引擎,driver 照抄零手拼（语义权威 [[exec-engine#^anc-exec-call-protocol-payload]]）

struct: CallProtocol
  Id: call-protocol
  Fields:
    - init_command: line          # 完整 init 命令,callee 路径 <CALLEE_SPEC_PATH:id> 占位（寻址归 caller,同 DispatchReady.launch_command 先例）;params=引擎 auto-map 快照+hop_env 透传;trace/log-dir/级别继承已折入;父层有修正意见时另拼 --upstream-feedback（重跑轮才有,D41 复用半边）
    - child_state_dir: line       # 子实例驱动循环的 --state-dir 值（<顶层STATE>/<inst>/calls）
    - child_instance: line        # 子实例 ID（=call step id,确定性）
    - child_advance: line         # 循环起步命令全文（init 建的子实例是未推进态,advance 领首个介入点——cc:call 真机实撞:未给起步命令则 driver 翻 CLI 源码反推,8 轮侧查顶过超时线;照抄纪律不许有"你自己想第一步"的洞）
    - report_completed: line      # 成功回报命令全文（--child-instance 机器通道）
    - report_failed: line         # 失败回报命令全文（--failure-child 机器通道）
```

StepReady 是 agent 主循环的正常推进信号，返回待执行步骤的上下文 ^anc-cli-step-ready

（ParallelReady 类型块与契约段已删——P1 清理：旧通道类型随 driver 面归零删除，见 v0.10.0 版本行；渐进派发形态见 DispatchReady/DrainWait。）

ExecutionPaused 是 CITL 介入点（confirm 审批 / ask 数据收集）触发的暂停信号——自包含介入请求（question + output_schema + default_value + options），caller 拿到即知"看什么/给什么/怎么给"。confirm 答审批（approve/reject）、ask 答数据值，引擎按 pause_reason 解析 answer。见 [[../concepts/HopSpec V3核心规范#^anc-exec-hitl-presentation]] ^anc-cli-execution-paused

### CommandResponse（done/fail/branch/answer 通用） ^anc-cli-command-response

```
struct: CommandResponse
  Id: command-response
  Fields:
    - status: line      # 'ok' 或 'error'
    - code: ErrorCode   # 可选。错误时必填
    - message: line     # 可选。错误说明
```

### VarsResponse（hopjit vars） ^anc-cli-vars-response

```
struct: VarsResponse
  Id: vars-response
  Fields:
    - status: line             # 恒为 'ok'
    - instance_id: line        # 实例 ID
    - execution_status: line   # 枚举 running/paused/completed/failed/aborted（与 StatusResponse 同源同口径——两响应共用引擎同一状态推导;paused/aborted 语义见 StatusResponse 节。2026-09-09 前此行漏写 aborted 且缺 paused,存量文实偏差随 0081 批齐修）
    - variables: yaml          # var_name → value，null = None
    - pending_outputs: [line]  # Outputs 中尚未赋值的变量名
```

### StatusResponse（hopjit status） ^anc-cli-status-response

```
struct: StatusResponse
  Id: status-response
  Fields:
    - status: line            # 恒为 'ok'
    - instance_id: line       # 实例 ID
    - execution_status: line  # 枚举 running/paused/completed/failed/aborted（aborted=主动中止,[[exec-engine#^anc-exec-abort]];paused=停驻等外部应答——todo/0081:此前枚举缺 paused,停驻被报 running,看护方接此通道感知不到"引擎在等人",停点挂死〔2026-09-09 实撞挂 30+ 分钟〕）
    - total_steps: number     # 步骤总数
    - completed: number       # 已完成步骤数
    - failed: number          # 已失败步骤数
    - pending: number         # 待执行步骤数
    - current_step: line      # 可选。当前 running 的步骤 ID（无则已结束;paused 时与 paused_step_id 同指停驻步——暂停态由 running 编码,^anc-exec-pause-persist）
    - pause_reason: line      # 可选。仅 paused 时在场——停驻原因摘要（confirm/waiting_human/ask/escalate;畸形卡兜底 unknown——卡在场但 pause_reason 字段非字符串时的防御值,引擎自产卡恒带 reason 正常不出现）,看护方判"该叫人了"用;问题卡全文不在本响应（归 resume/run_status 通道,status 不膨胀）
    - paused_step_id: line    # 可选。仅 paused 时在场——停驻步骤 ID
```

**paused 判定三源（引擎侧,状态源优先不依赖递送件;判定位置=终态凌驾之后、步骤态推导之前——aborted 凌驾〔[[exec-engine#^anc-exec-abort]] 第5条〕与 failed/completed 终态标记凌驾〔todo/0058〕两条既有决策不被扰动:实例已终态时纵有残卡也恒报终态）**：①escalate 停驻=state.json `escalate_pending` 在场;②confirm/ask 停驻=某 running 态步骤的 step_type∈{confirm,ask}（暂停态由 running 编码,[[exec-engine#^anc-exec-pause-persist]]）;③盘上问题卡 paused.json 在场且经陈卡对账（卡的 step_id 在步骤账里仍是 running 才认——卡是递送件非状态源,崩溃路径可残留陈卡,对账纪律与 MCP run_status 兜底路同款）。pause_reason 优先取卡内值（卡有完整 reason）,无卡时按判源推。**陈卡对账边缘分叉（记档）**：卡缺 step_id 时引擎侧弃卡落状态源（源①②接力）,MCP run_status 兜底侧认卡返回 paused+卡全文——核心判据（卡 step_id 须仍 running）两侧同款,此边缘各自语境合理（引擎有状态源可接力,MCP 兜底无内存账宁信卡）,不强求归一。**已知边界（显式不覆盖）**：network 暂停（网络中断自动重连停点）由 dispatcher 内存组装、不落卡、步骤回置 pending——CLI 快照侧结构性判不出,且它是非人工停点（resume 即续）,不在"主 agent 感知等人停驻"的痛点面。

### AbortResponse（hopjit abort） ^anc-cli-abort-response

```
struct: AbortResponse
  Id: abort-response
  Fields:
    - status: line            # 恒为 'ok'（幂等重放同形态;异态改写走 error 面 ABORT_TERMINAL_CONFLICT）
    - instance_id: line       # 实例 ID
    - execution_status: line  # 恒为 'aborted'
    - abort_reason: text      # 中止原因（入账值——显式传入或缺省 '(user abort)'）
```

### ReplanResponse（hopjit replan） ^anc-cli-replan-response

ReplanResponse 是联合类型，成员 ReplanSuccess / ReplanError，由 `status` 区分：

```
struct: ReplanSuccess
  Id: replan-success
  Fields:
    - status: line                 # 恒为 'ok'
    - new_children: [StepSummary]  # 替换后的新步骤摘要

struct: ReplanError
  Id: replan-error
  Fields:
    - status: line         # 恒为 'error'
    - code: ErrorCode      # 错误码
    - errors: [SpecError]  # 解析或验证错误
```

### ~~driver-mode~~（已废止,2026-08-27 四改） 

三改引入的模式读出命令与 DriverModeResponse 随双名双壳形态废止——模式编码进 skill 名（`/hopspec`=复用,`/hopspec-mcp`=MCP）,运行时无判定即无读出需求。决策与演进史见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]] 四改条款。`^anc-cli-driver-mode` 锚废止。

### BranchRequest（hopjit branch 请求体，手动覆盖用） ^anc-cli-branch-request

```
struct: BranchRequest
  Id: branch-request
  Fields:
    - step_id: line           # branch 步骤 ID（如 "2.3"）
    - selected_case_id: line  # 选中的 case 步骤 ID（如 "2.3.1"）
    - reason: line            # 可选。Agent 选择该 case 的理由（用于日志/调试）
```

响应复用 CommandResponse。

---

## JSON I/O 约定【契约】

**tool_request 通道（2026-08-04，随引擎 `^anc-exec-tool-request` 新增）**：NextResponse 联合类型增 `ToolRequest` 分支（形状见 [[exec-engine#^anc-exec-tool-request]]）；`submit_and_fetch_next` 增 `--tool-result '<json>'|@file` 参数（与 --output/--answer 互斥三选一）——应答 tool_request 专用，注入单工具结果后引擎续解释 body。对非 tool_request 状态使用返回 INVALID_STATE。

**输出分流** ^anc-cli-json-io
- **缺省输出 YAML**（多行块状，人可读——2026-08-06 作者拍板："缺省都是 yaml，除非用 --json 强制"；锚点 ID 保留历史名不改，契约以本文为准）；`--json` 全局 flag 或环境变量 `HOPJIT_OUTPUT=json` 强制单行 JSON（优先级：`--json` flag 或 `HOPJIT_OUTPUT=json` 任一即 JSON（实现为 env 恒优先——现实用况两者无分歧））
- **机器消费方显式走 `--json`**：driver（CC/Codex skill 全部命令模板）、测试，以及 HopJIT 生成后交给 driver 原样执行的 `launch_command` / `join command` 统一带全局 `--json`（位置在子命令前）——协议行为与历史完全一致；人裸跑 install-skill/pack/validate/list/status 等命令直接得 YAML
- 错误输出到 stderr（非 JSON），成功/业务错误输出到 stdout（YAML 或 JSON 按上述规则）
- `--output` 和 `--answer` 互斥：正常步骤用 `--output`，HITL 回复用 `--answer`
- `--answer`：仅用于 HITL 暂停后注入用户回复。接受 JSON 字符串 `'{"value": "approve", "reason": "..."}'`。value 必须匹配 ExecutionPaused.response_options 中的某个 value。对非暂停步骤使用 `--answer` 返回 INVALID_STATE 错误
- `--output` 和 `--steps` 接受 JSON 字符串或 `@file` 路径（避免 shell 参数长度限制）
- 由关键决策 2 推演：单行 JSON + stdout/stderr 分流

**文件参数与 work_zone 工作区** ^anc-cli-file-arg-safety
- `@file` 路径：`--output`/`--answer`/`--params`/`--replan`/`--tool-result` 的值以 `@` 开头时从文件读取内容。**推荐并鼓励用响应给出的确切路径**（step_ready 的 `output_path` / `work_zone` 目录下）。
- **提交越界校验**：`submit_and_fetch_next --output "@<path>"` 与 `--tool-result "@<path>"` 时，引擎校验 `<path>` 落在本执行单元的 `work_zone` 内，**越界（如 /tmp、项目根、兄弟 child 的 work_zone）→ 拒绝提交并报错**（提示改写本单元 work_zone 路径；两入口同款 `assertOutputInWorkZone`，src/cli.ts:687 与 :681）。**前缀判定用平台分隔符**（`path.sep`,不硬编码 `'/'`）——win32 下 `resolve` 产反斜杠路径,硬编码前斜杠使 work_zone 内的合法路径永不匹配、`@file` 提交全废（0057 实撞:Windows 用户 parallel 场景 @file 全被误拒,而 @file 恰是 worker 输出提交的设计形态）。整个 `@<path>` 必须作为一个双引号参数，兼容含空格的工作区；`@` 位于参数值首字符，CLI 才会读文件。这是引擎唯一能真拦的点——复用模式 act 由 CC/worker 的 Bash/Write 执行、写入不过引擎，无法在"写入那一刻"拦，只能在"提交那一刻"校验。硬边界的极限即此（不做 OS 级沙箱）。
- **并行 worker 隔离（消除串台）** ^anc-cli-parallel-file-isolation：parallel fan-out 多个 worker subagent 共享 cwd。三重保险消除串台（实证 bug：ppt-html 多页并行，worker 共用 `/tmp/out_4.3.1.1.json` 互相覆盖、s5 变 s4）：
  - **① work_zone 路径带 child 身份（身份在实例目录层级，不在目录名）**：parallel/call 子实例的实例目录本身按 child 分道（`<父instanceDir>/parallel/<child_step_id>/` 或 `calls/<child_step_id>/`），work_zone 恒为实例目录下的**固定名** `work_zone/`（persistence `getWorkZone` = `<instanceDir>/work_zone`，src/persistence.ts:165-167）——不同 child 的完整路径天然不同。原文"目录名带后缀 `work_zone_<child_step_id>`"与实现不符，[[exec-engine#^anc-exec-work-zone]] 2026-08-30 已勘误，本处同步。
  - **② 响应给确切 output_path**：step_ready 直接给本步 output 文件确切路径（含 child 区分），worker 照写、不拼名。
  - **③ 裸文件名重定向**：worker 若用裸相对名（`@out.json`，不含 `/`、非绝对），CLI 重定向到本 child work_zone（`resolveFileArgBase`）。两 worker 入口都覆盖：submit（`--instance` 含 `/parallel/`）、run 启动（`--parallel-parent`+`--parallel-child`）。
- **work_zone 工作区**：每个执行单元（顶层实例 + parallel/call 子实例）的独占工作区目录在 `initExecution` 时自动创建。所有 `NextResponse` 携带 `work_zone`（绝对路径），临时文件统一写此目录。见 [[exec-engine#^anc-exec-work-zone]]
- **`$file` 指针**：引擎返回的 inputs/params_for_child/outputs 中，单个变量值超 4KB 时自动写入 `work_zone/vars/<var_name>.json`，响应中替换为 `{"$file": "<abs_path>"}`。driver 遇 `$file` 指针时 Read 文件取真实值。见 [[shared-types#^anc-exec-deflate]]
- 由关键决策 3 推演：LLM 生成内容推荐 `@file` 传递，防 shell 注入

**Context 模式配置（`--context-mode` / `HOPJIT_CONTEXT_MODE`）**
- `run --context-mode <full|minimal>`：定 context 精简档，`run` 时 persist 进 StateFile；缺省 `full`。语义与 minimal 非首步砍什么/保什么见 [[prompt-assembler#^anc-exec-context-mode]]。
- `HOPJIT_CONTEXT_MODE` 环境变量：任一命令进程（含 `submit_and_fetch_next`）读取，**覆盖**持久化值——操作者可临时调档。精度：env > StateFile.context_mode > 默认 `full`。
- **opt-in 语义**：`minimal` 假设 CC 连续会话（不 compact/不跨进程 resume）。长 spec / 需 resume 用默认 `full`（每步自包含，永不断链）。见 [[prompt-assembler#^anc-exec-context-mode]] caveat。

---

## JSON 交互示例【说明】

`hopjit run` 启动并返回首个 caller 介入点（单行 JSON，下例为可读性换行）：

```json
{"status":"step_ready","step_id":"3.1","step_type":"reason","summary":"分析文档特征","context":{"...":"..."}}
```

`hopjit submit_and_fetch_next` 提交步骤输出 + 领取下一步（LLM 内容经 @file）：

```bash
hopjit submit_and_fetch_next 3.1 --output @.hopstate/inst-a1b2/tmp/3.1.out.json
# stdout（推进后的下一步指令，而非 {status:ok}）:
# {"status":"step_ready","step_id":"3.2","step_type":"act","summary":"...","context":{"...":"..."}}
```

`hopjit submit_and_fetch_next` 注入 HITL 回复（confirm 暂停步骤）：

```bash
hopjit submit_and_fetch_next 2 --answer '{"value":"approve"}'
# stdout: 推进后的下一步（step_ready/completed/...）；reject 则返回 failed
```

业务错误（对非暂停步骤用 --answer）作为 JSON 写 stdout：

```json
{"status":"error","code":"INVALID_STATE","message":"step 3.1 is not paused"}
```

运行时错误（实例不存在）写 stderr，非 JSON，exit code 非 0：

```
Error: instance 'inst-xxxx' not found in .hopstate/
```
