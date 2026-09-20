%% @trace
	id: hopjit-mcp-server
	source: [[step-dispatcher]], [[shared-providers]], [[../concepts/HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-step-dispatcher, hopjit-shared-providers, hopjit-runtime
	type: extend
	last_sync: 2026-08-22T20:02+0800
	note: standalone 执行的 MCP server 形态设计（2026-08-06 作者拍板 MCP 方案）。薄壳包 StepDispatcher 进程内 API，常驻进程解开 HITL 跨进程死结。一期=server 独立可验；二期=Codex 能力门三层分派接入。
%%

# MCP Server 设计规范（standalone 执行面）

> **回答一个问题**：复用模式之外，HopJIT 如何以独立模式（standalone，Dispatcher 直调 LLM API）对外提供执行能力？答案：**MCP server 常驻进程**——CC/Codex 原生可调、执行状态活在进程内存（HITL 不跨进程）、key 隔离在服务进程环境。CLI `hopjit standalone` 命令**缓做**（见决策 2）。

## 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|---|---|---|
| 定位（四要素） | 契约 | `anc-struct-mcp-server` |
| 关键决策 | 决策 | — |
| 工具面契约 | 契约 | `anc-mcp-tools` |
| stop_run 中止细则 | 契约 | `anc-mcp-stop-run` |
| HITL 与运行生命周期 | 契约 | `anc-mcp-run-lifecycle` |
| server 重启后 run 恢复 | 契约 | `anc-mcp-run-restore` |
| 配置与凭证 | 契约 | `anc-mcp-config`（schema 权威在 [[shared-providers#^anc-config-standalone-schema]]） |
| 安全边界 | 契约 | `anc-mcp-key-isolation` |
| 载体注册与三层分派（二期） | 契约 | `anc-mcp-carrier-integration` |

## 定位【契约】 ^anc-struct-mcp-server

> **模块版本**：mcp-server `v0.16.1`（2026-09-18）。本版=工程链 review 补账（多 provider env 注入键名单补 `_AUTH` 与 `_MAX_OUTPUT_TOKENS、`{SERVICE_ID}_THINKING`（provider 级思考缺省,0100 批——2026-09-20 review 批补登）` 两键;auth/revision_prompt 两新配置键的 schema 权威在 [[shared-providers#^anc-config-standalone-schema]]、行为权威各在其锚,本文档只登键名单——1cc47f7b 自称'mcp-server v 随批'未兑现的账本版清）。上版 v0.16.0（2026-09-10）。本版 0084 批一四件（M1 并发 run 上限配置化/M2 合并补 language+文法核/M3 restore 补装 model_engine〔与 startRun 公共化真同源〕/M4 restore env 换重读面）。0.x 未承诺稳定。**MCP 工具名+输入/输出 schema 是对外稳定面**——载体注册配置依赖之，破坏即破坏已注册用户。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
> **根锚点继承**（`^anc-meta-module-design-artifacts` 必备件①，本模块为首个样板）：
> - 概念前提：[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]]（双模式驱动——本模块是独立模式的对外协议壳，模式语义变更须重核本文）；[[../concepts/HopSpec V3核心规范#^anc-exec-hitl-presentation]]（HITL 介入点表达——paused 载荷与"不替答"纪律的上游）
> - 元规范义务：[[../concepts/工程实现链规范#^anc-meta-module-design-artifacts]]（四必备件）；[[../concepts/工程实现链规范#^anc-meta-module-evolution]]（版本纪律，G9 互锁）；[[../concepts/工程实现链规范#^anc-meta-guard-self-trust]]（fail-fast/禁静默跳过——本模块启动与配置加载行为的依据）
> - 配置事实权威：[[shared-providers#^anc-config-standalone-schema]]（StandaloneConfig 的唯一定义处——本文所有配置表述是其投影，冲突以彼为准）
>

**① 自身定位**：MCP server 是 StepDispatcher 的**协议壳**——把 MCP 工具调用翻译为 Dispatcher 进程内 API 调用，管理多个 run 的生命周期注册表。它**不含执行逻辑**：步骤推进、LLM 调用、retry、HITL 暂停语义全在 Dispatcher/Engine（见 [[step-dispatcher]]）。与 hop-cli 的关系是**平行的两个协议面**：hop-cli 服务复用模式（caller=外层 LLM，逐步应答），mcp-server 服务独立模式（caller 只管启动/介入/收终态，推理在 Dispatcher 内）。（解释性类比：hop-cli 像数据库的逐条 SQL 客户端，mcp-server 像存储过程执行器——提交整个任务，中途只在需要授权时回来。）

**② 与其他 HopType 的关系**：
- **StepDispatcher 的薄封装**：每个 MCP 工具对应 Dispatcher/注册表的一次操作（start_run→new StepDispatcher + runSpec、resume_run→dispatcher.resume、run_status→注册表查询）。进程内直调，不经 CLI 子进程（沿 [[step-dispatcher]] 决策 2"热路径不经 CLI"）
- **与 hop-cli 零耦合**：不 import cli.ts，不共享输出分流逻辑（MCP 有自己的结构化响应通道）；共享的是 cli-types 的响应类型词汇（ExecutionPaused 等）
- **持久化沿用 FilePersistence**：run 状态内存为主（常驻进程），FilePersistence 快照照旧落 `.hopstate/`——server 崩溃后的恢复能力即既有 durable resume 能力，不新增持久化机制
- **HopLog 恒开且缺省 debug 级**（2026-08-07 G11 落实补定；级别条款 2026-08-22 作者定方案③——实撞：info 级不记 prompt 全文，L2c 重试反馈在不在、LLM 每攻实际看见什么外部无从核验，走查被误导为"重试无记忆"）：start_run 一律带 logDir（`<state_dir>/../.hoplog`，同复用模式 driver 惯例），**日志级别缺省 `debug`**——standalone 的执行内幕（LLM 调用/工具执行）全在 server 进程内，**执行日志是外部核验过程轨迹的唯一通道**（e2e"核真过程"原则 `^anc-meta-layer-test` 的本模块落点），info 级只记 model/tokens 不记 prompt 正文，"唯一通道"名存实亡。个人开发场景日志体积可承受；嫌大经配置口降级：StandaloneConfig 新增 `log_level` 字段（debug|info|warn，两级合并项目级赢，schema 权威 [[shared-providers#^anc-config-standalone-schema]]）。与复用模式缺省 info 的分野：复用模式 CC 即推理 LLM、caller 生态自有观测面；standalone 没有第二通道
- **transport 可扩展**【决策注记】：server 核心（工具 handler）与 transport 分离——v1 仅 stdio（MCP SDK 标准），将来需要非 agent 消费方（curl/CI）时同一核外挂 HTTP transport，不重写（2026-08-06 方案对比结论：MCP 为主，HTTP daemon 为记录在案的演进出口）

**②b 对外接口清单【封闭】** ^anc-struct-mcp-server-exports：

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| MCP 工具 `start_run` / `run_status` / `resume_run` / `list_runs` / `stop_run` | 协议工具 | mcp-server.ts（bin 入口 `hopjit-mcp`） | 载体注册配置（.mcp.json / config.toml）——**对外稳定面** | provisional |
| `loadStandaloneConfig` / `providerToHostConfig` / `collectSpecTools` / `preflightProviderKeys` / `HopjitMcpCore` / `buildServer` | 函数/类 | mcp-server.ts | **仅测试消费**（mcp-server.test.ts）——非跨模块出口，不承诺稳定；跨模块 import 即边界违规 | internal-testable |
| `mergeConfigs` | 函数 | mcp-server.ts | 两级配置逐节合并（测试直测合并语义——0005 server 同名替换语义著文配套） | stable |
| `buildEnvSnapshot` | 函数 | mcp-server.ts | run 级 env 快照构造单点（测试直测键集契约——0008③ 封闭集下键集即契约,startRun/restore 同函数） | stable |
| `ProviderEntry` / `StandaloneConfig` | 类型 | mcp-server.ts | 仅测试消费（同上）；schema 语义权威在 [[shared-providers#^anc-config-standalone-schema]]，此处是其 TS 形态 | internal-testable |

> **内部（表外即内部）**：run 注册表私有方法、transport 装配（serve）。**对外稳定面是 MCP 协议工具，不是 TS export**——TS 符号出口仅为测试可达（"不为测试暴露私有"判据的例外形态：模块以协议面对外，TS 面天然无跨模块消费方，export 是测试边界对齐的最小代价，如实登记不冒充稳定接口）。

**③ 主要 traits 与主要成员**：

Fields：
- `runs: Map<run_id, RunEntry>`——运行注册表。RunEntry = { dispatcher, state: running|paused|completed|failed|aborted, pausedPayload?, startedAt, specPath }
- `config: StandaloneConfig`——启动时从 `~/.hopjit/config.yaml` 加载（`HOPJIT_CONFIG` 环境变量可覆盖路径——测试/多环境用，2026-08-08 审计回写）；出现明文 key 即启动失败

trait：
- `serve`——装配 MCP SDK server + stdio transport，注册五工具，进入服务循环
- `dispatchTool`——工具调用路由：校验入参 schema → 操作注册表/Dispatcher → 组装结构化响应

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl start_run（异步启动）
1. [act] 校验 spec_path 存在 + parseSpec/validate 过闸（坏 spec 即拒，不建 run）
2. [act] 预检工具面：spec 所需非内置工具 ⊆ 装配后 CompositeToolProvider 并集（内置组∪注册件——0084 批三随实况勘正,原文写 DefaultToolProvider 是组合化前旧型），不满足即拒（错误列缺口清单）
3. [act] new StepDispatcher(config 解析出的 HostConfig) + 注册表登记 run_id
4. [act] 异步启动 runSpec()（不 await）——完成/暂停/失败时更新注册表
5. [act] 立即返回 { run_id, status: 'running' }
```

### 核心要求

1. **薄壳**：执行语义零重复——暂停判定、answer 规范化、审计全在 Engine/Dispatcher（`^anc-exec-confirm-answer` 模式无关）
2. **job 式异步**：start_run 立即返回，不阻塞 MCP 工具调用（整 spec 执行分钟级，同步调用会顶爆 host 超时）
3. **fail-fast 启动**：配置缺失/schema 非法/出现任何明文 `api_key` → server 启动即失败并说明改用 `api_key_env`
4. **单 server 多 run**：一个 server 进程可并存多个 run（注册表隔离），run_id 由 server 生成（复用引擎 instance_id）

### 不是什么

- 不是第二个执行引擎——只是 Dispatcher 的协议壳
- 不是复用模式的替代——两模式并存，消费方按需选（见二期三层分派）
- 不是远程服务——v1 stdio 仅本机；网络暴露需另立安全设计，明确禁止裸挂公网

## 关键决策【决策】

### 决策 1：MCP server 形态，而非 CLI 一次性进程【决策：原则性，2026-08-06 作者拍板】

**候选**：① CLI `hopjit standalone <spec>`（一次性进程）；② CLI + 自建后台 job daemon；③ MCP server（本案）；④ 本地 HTTP daemon；⑤ Unix socket 私有协议。

**选 ③**。决定性判据：**状态常驻**——HITL（confirm/ask）暂停后执行状态活在 server 进程内存，resume 是同进程操作，**DEBT-05/08（host_config 恢复/跨进程 resumeSpec）从 v1 前置依赖降级为崩溃恢复的二期加固**；**载体原生可调**——CC/Codex 都原生说 MCP，注册即用，carrier 零胶水；**key 隔离**——key 住 server 进程环境，结构上不经过 prompt/CLI 参数/状态文件。①的 HITL 死结（跨进程恢复压三笔债，v1 只能预检拒绝阉割）与"缺省 standalone 劫持复用模式 run"冲突（driver 模板需加 --reuse 补丁）在 ③ 下均不存在。④ 是超集场景方案（非 agent 消费方），留作 transport 演进出口；②⑤ 自建通信层两头不占。

### 决策 2：CLI `hopjit standalone` 缓做【决策：依赖驱动】

TODO 原完成判据 1 写的是 CLI 形态。MCP 方案下它的真实用户只剩"人工调试 Dispatcher"，而两个协议面（CLI+MCP）= 两份 parity 维护（driver 双载体 parity 的教训现成）。**缓做**：一期不提供；确有人工调试需求时再立项，且届时实现为 MCP 工具的命令行客户端（单一事实源在 server），不是第二套执行入口。

### 决策 3：opt-in 信号 = MCP server 已注册【决策：原则性，2026-08-06 作者定向】

作者原意"有独立 LLM 配置时缺省用 standalone"。MCP 形态下落为：**用户在载体里注册了 hopjit MCP server 即 opt-in**——注册动作本身就是"我要用 standalone"的显式声明，费用授权原则（TODO 安全约束"禁止静默产生 API 费用"）天然满足；`~/.hopjit/config.yaml` 存在与否只决定 server 能否启动，不劫持任何既有命令语义（复用模式 `hopjit run` 零影响）。

### 决策 4：HITL v1 完整支持【决策：依赖驱动——常驻进程使然】

CLI 路线曾倾向"预检拒绝 confirm/ask"（避免跨进程恢复三笔债 + 子进程等 stdin 会挂死 carrier）。MCP 常驻进程下两个障碍都不存在：paused 是注册表状态 + 结构化载荷（不是等 stdin），resume 是同进程注入。**v1 不阉割 HITL**。paused 载荷 = 既有 ExecutionPaused 结构（question/output_schema/default_value/present_inputs），呈现纪律沿 `^anc-exec-hitl-presentation`——由调用方（carrier/人）负责问真人，server 不替答。


## run_status 在飞视图【契约】 ^anc-mcp-run-status-inflight

> 统一模型收口件（2026-08-11，^todo-call-parallel 最后一项）：并行 run 的观测面——纯读账面呈现，
> 零执行语义变化。

**能力契约（HopSpec 契约）**：

```
# Spec: run_status_inflight_view
Goal: running 态的 run_status 响应携带在飞子实例视图——外部观测者不翻 HopLog 即知
      主线在哪一步、几个活在飞/被杀、各自派发时刻。
Inputs: RunEntry（注册表项，engine 在手）
Outputs: current_step（主线当前 running 步）、inflight[]（账面全量：child/step/status/dispatched_at）
Constraints:
  - 纯读引擎账面（getInflight/getStatus）——不触发对账/收割/超时判定等任何写动作（readOnlyHint 忠实）
  - 无并行的 run 零新字段（inflight 缺席而非空数组——响应形状向后兼容）
  - killed 项如实呈现（观测不粉饰账面）
  - 终态 run 不携带 inflight（收齐后账面本就排空；killed 残账属失败诊断信息，failure 已含 kill_list）
```

**类型约定（HopType）**——响应增量字段：

- `current_step?: string`——主线当前 running 步（engine.getStatus().current_step 透传）；
- `inflight?: Array<{ child: string; step: string; status: 'inflight' | 'killed'; dispatched_at: string }>`——账面全量投影（InflightCall 四字段裁剪，host_container/iter 不出——观测者用 child id 已可定位）。

**串行 call 链投影（2026-08-30,todo/0011 ①半边清账——run 主线卡在 call 步时 run_status 只回 running,递归子树烧到第几层外部全不可见,看护进度行整段 step=?;在飞视图当年只做 parallel 形态,串行 call 以"事后翻账可定位"缓做,实时看护拿不到 child id）**：running 态且主线在 call 步时,响应增量字段 `call_chain?: Array<{ step: string; spec: string; current_step?: string }>`——逐层下钻 activeCallChildren（stop_run 修复新增的在飞 call 登记表,层层 getEngine().getStatus() 取 spec id 与当前步）,如 `[{step:'5.1',spec:'split-node',current_step:'2.1.1'},{step:'2.1.1',spec:'split-structure',current_step:'3.3'}]`。纯读账面零写动作（readOnlyHint 忠实同 inflight 先例）;无在飞 call 字段缺席（向后兼容）;深度即数组长度,防环由 call depth 上限天然兜底。

**token 统计透出（2026-08-30,todo/0023 清账——账早记全〔HopLog llm 块+state.json cumulative_tokens+BUDGET_EXCEEDED 消费〕但 run_status 不透出,长跑中途看烧了多少只能翻 HopLog）**：run_status 各态响应增量字段 `cumulative_tokens?: number`——纯暴露非新记账,与 inflight 视图同纪律（纯读引擎账面/响应形状向后兼容:0 值缺席不出字段）。取值双源:注册表命中=engine.getCumulativeTokens()（内存实时）;注册表不中走快照兜底=state.json 的 cumulative_tokens（盘上账,跨进程恢复态不归零）。终态响应同带（跑完知总账）。

**关键逻辑（HopSop）**：

```
1. [act] runStatus 组装响应时：entry.state == 'running' 且 engine.getInflight() 非空
  → 附 current_step + inflight 投影
2. 其余状态照旧（paused/completed/failed 响应形状零变化）
```

## 工具面契约【契约】 ^anc-mcp-tools

五工具，输入/输出均 JSON schema 锁定（MCP SDK inputSchema）：

| 工具 | 入参 | 返回 | 语义 |
|---|---|---|---|
| `start_run` | `spec_path`(必)、`params`(可,object)、`state_dir`(可,默认 `.hopstate`;**相对路径锚 workspace_dir**——与 spec_path 同款解析规则,2026-08-25 修 work_zone 双基准劈裂:原实现相对 state_dir 原样下传,快照 mkdir 按 server 进程 cwd 落盘、act body 的 write 按 workspace_dir 锚解析同一相对路径,work_zone 目录两头对不上 ENOENT〔coffee/ppt 首发两 run 同死实撞〕;快照/hoplog/work_zone 三产物单一基准=workspace_dir。返回值携带解析后的 `state_dir` 绝对路径——server 重启后 run_status/resume_run 快照兜底据此传参,不必猜锚点)、`workspace_dir`(可,默认 server cwd——**作业对象根显式化**,2026-08-20 作者定目录三层归位：spec 目录=自包含单元/workspace=作业对象根〔业务材料读+产出写+沙箱锚〕/work_zone=引擎内务。server cwd 由注册时会话定、常≠作业对象,MCP 无 cd 通道故开参数;只接绝对路径或相对 server cwd 显式路径,不存在即拒——与 spec_path 同款焊死原则) | `{ run_id, status: 'running', state_dir: <解析后绝对路径> }` 或错误（spec 非法/工具面不足/配置缺失） | validate 闸门 → 工具面预检（**遍历须覆盖全部表达式形态含 field 链**——review P2：`tool(...).field` 曾绕过预检）→ 异步启动。**同一 server 并发 run 数上限可配置**（`resource_limits.max_concurrent_runs`,缺省 4——超限即拒,防失控烧费的保守默认;批量驱动场景显式调大=知情授权烧费。2026-09-10 todo/0084 M1:原为源码裸常量,任何配置途径改不了,批量语料验证第 5 个 run 被拒实撞——同文件同语义的 max_concurrent_workers 走 resource_limits 全通道,双重标准收敛。上限是 server 级判定,读启动期合并后配置——与 providers 快照同理由,不入每 run 重读面） |
| `run_status` | `run_id`(可——省略且**活跃**（running/paused）run 恰一个时取之；终态 run 不参与计数——2026-08-07 review 收紧：原按全部历史 run 计数，终态永久保留下简写几乎只能首用)、`state_dir`(可,缺省 .hopstate——**快照兜底用,2026-08-25 0028;相对路径按 server cwd 解析**——本工具无 workspace_dir 参数锚不了作业根,run 以 workspace_dir 启动时须传 start_run 返回的 state_dir 绝对路径,review 抓同名参数双锚语义只写在生产侧) | `{ run_id, status: running\|paused\|completed\|failed\|aborted, paused?: ExecutionPaused, paused_queue?: [{child_instance,...ExecutionPaused}], outputs?, failure?, current_step?, inflight? }` | 注册表查询。paused 时携带完整介入载荷；completed 携带全部 outputs；running 时携带在飞视图（见 ^anc-mcp-run-status-inflight）。**注册表不中时快照兜底（0028,detach 场景跨进程取问题卡）**：`<state_dir>/<run_id>/paused.json` 在场**且卡的 step_id 在 state.json 里仍是 running**（陈卡对账,31 轮 review——删卡与 persist 间崩溃/异常路径可残留卡,卡是递送件非状态源,失配以状态源为准报 NOT_FOUND 指路完整恢复;state.json 缺席跳过对账〔容手工卡/老快照〕） → 返回 `{run_id, status:'paused', paused:<卡全文>, restored_from_snapshot:true}`——**纯读**（不建 RunEntry/不构造 Dispatcher/零凭证需求,readOnlyHint 忠实;与 resume_run 的完整恢复分工:看卡零成本,注入答案才走 restoreRun）;aborted 墓碑在场 → status:'aborted';**状态权威序=墓碑>终态>等人卡**（40 轮 review——completed 快照+残留死卡并存时卡分支先行会让陈卡对账挡住真终态;删卡与 persist 非原子,残卡窗口真实存在）;**terminal_state 在场（0043 终局有据）→ completed 携 outputs（header.outputs 声明变量按 vars.json v2 root scope 现值收集,与进程内 collectOutputs 同判据;只收声明键）/failed 携 terminal_failure——纯读直判,原'快照不存 run 级终态'注记随 0043 作废**;无卡无终态有 state.json → 仍 RUN_NOT_FOUND:先下钻 calls/*/、parallel/*/ 找嵌套子实例卡,有则报文点名卡路径（人可直接读看问题;不冒充顶层 paused——嵌套暂停经 resume_run 重跑 call,恢复边界照旧）,无则注明非 HITL 暂停（运行中崩溃/网络暂停/旧版产物）指路 resume_run;两者皆无 → RUN_NOT_FOUND |
| `resume_run` | `run_id`、`step_id`、`answer`(object)、`state_dir`(可,同左——相对路径按 server cwd 解析,workspace 锚定的 run 须回传 start_run 返回的绝对路径)、`child_instance`(可——**子实例 HITL 队列应答路由**,携=答队列里那张卡,缺省=顶层/call_path 既有路由,见 [[parallel-execution#^anc-exec-parallel-hitl-queue]]) | `{ run_id, status: 'running' }` 或错误 | 透传 dispatcher.resume（answer 规范化在 Engine，`^anc-exec-confirm-answer`）。**与 start_run 同为 job 式异步**——注入后立即返回，后续进度轮询 run_status（resume 后是多次 LLM 调用，分钟级，同步等待必顶爆 MCP 工具超时——2026-08-06 真机验收实撞后改定）。对非 paused run 调用 → 错误不推进 |
| `list_runs` | — | `{ runs: [{run_id, status, spec_path, started_at}] }` | 注册表快照，供 carrier 崩溃后重认领 |
| `stop_run` | `run_id`(必) | `{ run_id, status }`（受理后即回;终态 run 幂等返回现状） | **主动中止 run**（2026-08-22 作者定"hopjit 应该能自己杀自己的子任务"——此前失控 run 只能杀 server 重启会话止损,两次实撞）。语义：running → 调该 run dispatcher 的 `requestAbortCascade()`（协作式中断:步间检查生效,不打断执行中的单步——与 parallel 杀活同一 aborted 标志机制,级联面见 [[step-dispatcher#^anc-struct-step-dispatcher-exports]] 调度组）——**级联 abort 全部在飞子 dispatcher**（parallel worker/暂停 call 帧/执行中的串行 call 子层三张表,深递归/并行都停,不留孤儿继续烧钱）;paused → 直接标 aborted（无在飞活动）;completed/failed/aborted → 幂等返回现状不报错;未知 run_id → RUN_NOT_FOUND。中止落账：run 状态记 `aborted`（终态,list_runs/run_status 可见）+ 实例目录落墓碑标记 `aborted.json`（跨重启终局——restore 见标记即拒 RUN_ABORTED）,引擎快照照常落盘——aborted run 的 .hopstate 保留,可人工检视,不支持 resume（中止是终局不是暂停,同进程注册表拒 + 跨重启墓碑拒双防线,细则见 ^anc-mcp-stop-run）。注解 `readOnlyHint: false, destructiveHint: true`（丢弃在飞进度,如实标破坏性） |

### stop_run 中止细则【契约】 ^anc-mcp-stop-run

上表 stop_run 行的语义细化，五条实施契约（1-3 首版；4-5 系 2026-08-22 review 二缺陷修：级联够不着在飞串行 call 子层 / aborted 不落盘重启后可被 resume 复活）：

1. **级联中止**：`stopRun` 对 running run 调 dispatcher 的 `requestAbortCascade()`（不是单点 `requestAbort()`）——在飞子 dispatcher 分布在**三张表**：inflightDispatchers（parallel worker 与 call parallel 形态）、callFrames（暂停中的 call 子帧）、activeCallChildren（**正在执行中的串行 call 子层**——handleCallStep 的 `await childDispatcher.runSpec()` 期间既不在 inflightDispatchers 也不在 callFrames，首版只遍历前两张表，串行 call 子树会烧到自然终态才停,review 实抓）。级联递归遍历三张表逐个下发，深递归/并行都停，不留孤儿继续调 LLM 烧钱。级联实现归 [[step-dispatcher#^anc-struct-step-dispatcher-exports]] 调度组；
2. **aborted 钉住（迟到结果竞态）**：stop_run 受理后立即把注册表状态置 `aborted` 并返回，不等执行循环真正停下（协作式中断是步间生效的，在飞的那步会跑完）。此后**任何**迟到回调都不得改写 aborted——覆盖三个回写口：applyResult（正常终态）、startRun 的异常 catch、resumeRun 的异常 catch（后两处直写 `entry.state = 'failed'`，首版漏堵——异常迟到会把 aborted 改成 failed，终态间失真，review 实抓）。三处一律：见 aborted 先行返回，只做资源收尾（关闭 tool provider，close 幂等可重入）。中止意图先于执行结果，否则用户看到"已停止"的 run 又自己变回 failed；
3. **终态幂等**：对 completed/failed/aborted 的 run 重复调用返回现状不报错（`idempotentHint: true` 的兑现）；未知 run_id → RUN_NOT_FOUND；
4. **aborted 落盘（跨重启终局）**：stopRun 在该 run 的实例目录写标记文件 `aborted.json`（内容：中止时刻 + reason——非引擎状态机的一部分，是 server 协议层的墓碑标记，不改 state.json 语义）。`restoreRun` 恢复前先查此标记，**在场即拒**（错误码 `RUN_ABORTED`，消息说明该 run 已被主动中止、快照仅供人工检视）。不落盘则"中止是终局"只在内存成立：server 重启后注册表清空，resume_run 未命中走 restoreRun 会把 aborted run 从快照复活成 paused 一路跑到自然终态**含 commit 不可逆操作**（review 实抓）。写标记失败不阻塞中止（stop 的主职责是停内存里的执行，落盘是加固；失败记 stderr 留痕）。**问题卡随墓碑同拍清除（34 轮 review）**：stop_run 是 paused→终局的转移,等人窗口随之关闭——卡是一等实物、文件级消费方可直接读,残卡会误导它们（API 面有墓碑优先兜着,文件面没有;[[exec-engine#^anc-exec-pause-persist]] 卡生命周期=等人窗口的中止侧兑现）；
5. **工具通道收口分道**：stopRun 当场 close tool provider **仅限 paused run**（无在飞循环，不会再有回调收尾）；running run 的收口归钉住回调（applyResult / 两处 catch 的 aborted 分支）——在迟到结果到达时收。首版对 running 也当场 close，在飞那步的下一次工具调用会撞"已随 run 终态关停"拒绝，违反第 2 条"在飞的那步会跑完"的承诺，且 commit 步可能被掐成半拉子留部分不可逆副作用（review 实抓）。

错误响应统一 `{ error: { code, message } }`。**错误码域**：MCP 协议面自有码域（`RUN_LIMIT`/`SPEC_NOT_FOUND`/`SPEC_INVALID`/`TOOLS_UNAVAILABLE`/`TOOLS_FILE_INVALID`/`TOOLS_NAME_CONFLICT`/`TOOLS_ASSEMBLY_FAILED`〔装配兜底档——识别按 tools-composite 报文前缀,前缀漂移时降级为兜底码不丢结构化,九审注〕/`HOP_ENV_CREDENTIAL_REJECTED`/`CONFIG_INVALID`〔每 run 重读的项目级配置在场但非法——文法/凭证违规响亮拒,十二审〕/`INIT_FAILED`/`RUN_NOT_FOUND`/`RUN_ABORTED`〔restore 撞 aborted 墓碑标记——已主动中止的 run 拒绝复活,^anc-mcp-stop-run 第4条〕——后五码 2026-08-17 0004/0005/0007 批补登,TOOLS_FILE_INVALID 系实装早于登记的存量欠账同批清）+ 复用 [[shared-errors]] 的 `INVALID_STATE`——run 生命周期与协议入参错误是本模块的关注点、不进引擎错误码表（塞进 shared-errors 会稀释引擎码域语义；2026-08-07 review 改口：原"不新造错误体系"表述与实现不符，以实现为准修订设计）。

**工具注解（ToolAnnotations，2026-08-10 真机实撞补定）**：全部工具必须携带 MCP 标准注解——`list_runs`/`run_status` 标 `readOnlyHint: true`；`start_run`/`resume_run` 标 `readOnlyHint: false, destructiveHint: false, openWorldHint: false`（启动/推进 run 是有副作用但非破坏性、非开放世界动作）；`stop_run` 标 `readOnlyHint: false, destructiveHint: true, idempotentHint: true`（丢弃在飞进度=破坏性；对终态 run 重复调用幂等返回现状）。**无注解 = 载体按最坏情况对待**：Codex exec 非交互下对无注解 MCP 工具的调用会被审批层自动取消（实撞：`user cancelled MCP tool call`，模型侧真调用已发出、被 app 配置层拒），`default_tools_approval_mode = "auto"` 也救不回。注解是载体审批分级的判据输入，不是文档装饰。

## HITL 与运行生命周期【契约】 ^anc-mcp-run-lifecycle

```
start_run → running → (completed | failed | paused)
paused → resume_run → running → …（可多次暂停）
running | paused → stop_run → aborted（终态,不可 resume）
```

- **resume 入参校验在状态变更前（2026-08-07 review P1 补定）**：`step_id` 与 paused 载荷的 step_id 不一致 → INVALID_STATE 错误返回且 **run 保持 paused**——可恢复状态不因坏输入被毁（实撞：错误 step_id 曾先回 running 随后永久 failed）；
- **paused 不是终态**：run 停在注册表里等 resume，server 不超时自动推进（无超时概念，[[step-dispatcher#^anc-exec-pause-timeout]]）；
- **server 重启后 paused run 可恢复**【契约】——见下节 `^anc-mcp-run-restore`。
- **终态领取**：completed/failed 的 run 保留在注册表至 server 退出（v1 不做清理策略——单会话用量下无压力，出现压力再立项）。
- **驱动通道落账与跨通道拒**（2026-08-27 两模式并存三改的安全半边,权威 [[exec-engine#^anc-exec-driver-channel]]——本节只记 MCP 侧接线）：`startRun` 建 run 落 `driver_channel: 'mcp'`;`resumeRun`/`stopRun` 恢复快照后核通道——撞 `cli` 建的 run → 结构化错误 `DRIVER_CHANNEL_MISMATCH` 指路 `hopjit submit_and_fetch_next`,不改状态;`run_status`/`list_runs` 只读不拦（跨通道可观测恰是排查双执行的手段);字段缺席（旧 run）宽容并由首个推进入口认领。
- **宿主断开即退出（进程生命周期收口,四十七审——孤儿 server 实撞:两个历史会话的 server 挂了两天,谁都不负责杀它）** ^anc-mcp-shutdown-on-disconnect：stdio 传输的 server 生命随宿主——宿主会话退出关闭管道后 server 没有存在意义（paused run 有快照落盘,下个 server 经 ^anc-mcp-run-restore 恢复——孤儿进程反而零价值）。契约三条：①`transport.onclose`（宿主正常断开）与 `process.stdin` 的 `end`/`close`（管道关闭）都挂退出钩,触发即 `process.exit(0)`——在飞 run 的中断即崩溃中断,快照落盘由既有 persist 时机保证,不做优雅收尾（等在飞完成=不确定时长的僵尸期,退出语义要干脆）;②退出前 stderr 一行留痕（"宿主断开,server 退出;在飞/暂停 run 可经 resume_run 恢复"）;③**uncaughtException 兜底不救断连**——既有"不 exit"承诺限运行期异常（run 隔离条款）,断连钩的 exit 不经该路径（直接 process.exit,不是抛异常）。根因记档：原 serve() 只 connect 不挂任何断开钩,Node 事件循环有活跃 handle（在飞 promise/SDK 计时器）即不自然退出;uncaughtException 兜底又把"借异常死掉"的路也堵了——防炸设计的副作用把"该死的时候"也防住。
- **run 隔离不变量（server 侧落点）**：上游权威 [[../ARCHITECTURE#^anc-run-isolation]]（单机版架构总条款,通道表/取舍/守卫全在彼——本节只列 server 自己的实施件,不复制）：
  - `serve` 装 `unhandledRejection`/`uncaughtException` 兜底：记 stderr、计数留痕、**不 exit**——**不承诺关联 run**（回调无 runId 可依,关联职责归池尾 catch;漏网 run 停 running 由超时/对账/观测/重启 restore 兜住。作者拍板 2026-08-14"活"；取舍全文见主锚）；
  - `startRun`/`restoreRun` 是**组合根**：`process.cwd()`/env 在此一次读取折进该 run 的 HostConfig（env_snapshot），内核不再触进程状态；
  - `startRun` 对 `this.config` 派生物（tool_servers 等）**按 run 深拷贝**再交 HostConfig——server 持有的配置对象不被任何 run 变异；
  - 材料根参数（hopkb 需求）=组合根锚换取值来源的后续批,机制先行参数后至；
  - **实施注（2026-08-14 随批销账两暗病）**：①原 startRun 把 provider 凭证/端点/协议**写进 process.env** 供 dispatcher 读——进程环境当全局注册表的反模式实例（多 run 共享可变槽+凭证泄进程环境）,改走 env_snapshot 后进程 env 零写入（守卫一律禁 env 写,含组合根）；②原 restoreRun **不写 env**——非默认 service 凭证隐性依赖"此前某 startRun 写过的残留",server 重启直 restore 即缺,随快照统一后消除；③深拷贝分发首版实施漏（review 抓）——parseToolServers 传共享引用,下游变异条目即跨 run 污染,structuredClone 补齐。

### server 重启后 run 恢复【契约】 ^anc-mcp-run-restore

`resume_run` 的 runId 不在内存注册表时**不直接拒绝**，先走恢复路径。这是 DEBT-08"跨进程 resumeSpec"的实装形态：不做抽象自由函数，恢复逻辑落 server 的 `resumeRun` 未命中分支（真实消费方唯一，抽象留到第二个消费方出现）。

**能力契约**（HopSpec 契约）：

```
# Spec: 从快照恢复 paused run
Id: restore_run
Goal: server 重启后,把 .hopstate/<runId>/ 快照重建为注册表内可 resume 的 run
Inputs:
- run_id: line           # 待恢复实例 id
- state_dir: line        # 快照目录（缺省 .hopstate,resume_run 工具可选参数;相对路径按 server cwd 解析——workspace 锚定的 run 传 start_run 返回的绝对路径,与工具表 run_status/resume_run 行同口径）
Outputs:
- entry: yaml            # 重建的 RunEntry（state=paused）,或结构化错误
Constraints:
- 快照不存在 → RUN_NOT_FOUND（真不存在,不误恢复）
- 快照损坏/凭证缺失/Dispatcher 构造失败 → RESTORE_FAILED（结构化返回,不炸 server;快照未动,修好可重试）
- Provider 是运行时对象不可序列化——完整 HostConfig 恢复=用 server 当前 config.yaml 重新注入,
  凭证链在新 Dispatcher 构造时重走（DEBT-05 收口形态）
- **配置读取根随快照钉住（BUG-I 修,2026-08-15 hopkb 现场认领嫌疑①）**：host_context 增
  config_project_dir（run 启动时的项目根=当时 process.cwd()）;restoreRun 按它重读**项目级 hopjit.yaml**并与 server 当前配置
  mergeConfigs 合并（项目级赢,与启动期两级合并同一语义）——**providers/凭证不被重读换掉**
  （preflight 启动期已过,恢复期换 provider=凭证链重走引入新失败面且违背本节'用 server 当前
  config 重新注入'契约;BUG-I 丢的本就只是项目级工具面）。配置仍是活的（改 hopjit.yaml 恢复
  即生效）,钉住的只有"从哪读项目级配置"这一个事实。根因:项目级 hopjit.yaml 按 server 进程 cwd 找,重启后 cwd 由宿主会话定、非项目根时
  tool_servers 整节缺席——restoreRun 装配代码在场但装了个空面（"疑缺装配"考古已证不成立）
- **恢复后工具面预检（B 闸,与 A 叠加）**：restoreRun 装配后复用 startRun 的 collectSpecTools
  预检——spec 所需 ⊆ 装配面,缺了报 TOOLS_UNAVAILABLE 结构化拒绝恢复（快照未动配好可重试）,
  不再让残废 run 活到下一次工具调用才 TOOL_EXEC_ERROR（静默残废→响亮失败）
- **模型路由随恢复同装（M3,2026-09-10 todo/0084——原 restore 只装工具面/命令面/资源限制,
  漏装 model_engine〔routing_rules/default_model〕,恢复的 run 模型路由静默回落 providers[0].model:
  该分档的不分档,烧错钱且无提示,":274 startRun/restore 同一套判定"承诺失实）**：model_engine
  构造提公共私有方法（buildModelEngine——startRun 与 restoreRun 同调,真同源不留漂移副本）,
  restore 用重读合并后的配置调它,与工具面装配同用重读面
- **env 打底口径归一（M4,同批——原同函数内 tool_servers/commands/resource_limits 用重读面、
  env 用启动期 this.config.env,三节两种口径;且缺 hop_env_language 打底）**：env 换重读合并后
  配置的 env 节,hop_env_language 打底行与 startRun 对齐
- 恢复后注入的 step_id 必须指向本 spec 的 confirm/ask 步骤——坏输入拒于状态变更前（INVALID_STATE,
  run 保持 paused）
- **运行中崩溃恢复（2026-08-27 #52,dr20 实撞:server 死时 run 正在 call 推进中,state.json
  running=[5,5.1,5.1.1],原预检只认 confirm/ask/网络暂停三停点——纯崩溃态无入口,8.5 小时快照
  只能弃;CLI 侧 hopjit resume 本有同语义〔ExecutionEngine.recover 悬空 running→pending 幂等
  重跑,^anc-exec-crash-recovery〕,MCP 建的 run 被 driver_channel 硬闸拦在 CLI 外——通道能力
  不对称）**：恢复的 run（无 paused 载荷）且 step_id 既非 confirm/ask 也非网络暂停步时,
  **加判一条**:step_id 在快照 stepStates 里为 running（悬空崩溃步——机械判据,state.json 可核）
  → 走崩溃恢复分支:引擎悬空 running 重置 pending（复用 recover 语义,含 scope 掩码/branch
  已选保留豁免）→ dispatcher.resumeSpec() 异步续跑（job 式,与 start_run 同）;answer 参数
  忽略（崩溃恢复无问题在答——设计如此,报文不拒）。三停点判据全不中才 INVALID_STATE。
```

**类型约定**（HopType）：无新类型——复用 `RunEntry`（注册表条目）。恢复的 entry 与 startRun 建的差别仅两点：`paused` 载荷为空（重启后内存丢失，step_id 校验改按 spec 结构预检）；`specPath` 从引擎快照恢复（`engine.getSpecPath()`，无则占位）。引擎侧新增两访问器支撑：`getSpecPath()`（重建 DirSpecProvider 的基准目录）、`setHostConfig()`（load 只恢复 host_context 子集，完整 HostConfig 重接）。

**关键逻辑**（HopSop）：

```
restoreRun(run_id, state_dir):
1. [条件(<state_dir>/<run_id>/state.json 不存在)] 返回 RUN_NOT_FOUND
2. [act] ExecutionEngine.load(instanceDir) 重建引擎
   > load 保留 running——paused 的 confirm/ask 步骤即 running 态（[[exec-engine#^anc-exec-pause-persist]]）
   > 损坏即 RESTORE_FAILED
3. [act] 用 server 当前 config.yaml 重建 HostConfig + 按 getSpecPath 所在目录重建缺省 DirSpecProvider
   → engine.setHostConfig 重接
4. [act] 新建 StepDispatcher（构造时从引擎回填 cumulative_tokens——预算跨重启延续）
5. [act] 注册回内存注册表（state=paused）→ resumeRun 照常注入答案续跑

resumeRun 未命中分支:
[条件(runId 不在注册表)] restoreRun → 错误则原样返回,成功则继续
[条件(恢复的 entry 无 paused 载荷)] step_id 按 spec 结构预检（须为 confirm/ask,否则 INVALID_STATE 拒且保持 paused）
```

**恢复边界**：仅 paused 实例可恢复为可 resume 的 run（其余中断按崩溃恢复语义另论）；嵌套 call 的挂起帧（CallFrame 内存对象）不随快照恢复——load 后父实例 call 步骤重置重跑整个子调用（call=事务边界，重跑合法），指向嵌套暂停的 step_id 被预检拒绝并提示；`list_runs` 仍只列内存注册表（不扫盘——列表是会话视图，恢复按需触发）。

## 通知挂点（终态/停点推送）【契约】 ^anc-mcp-notify-hook

todo/0052 通知半边引擎侧。作者三拍（2026-08-30）：**配置驱动不塞 LLM**（"执行时也应该是可以配置的，不要一股脑塞给 llm"——终态/paused 是状态机确定事件,发不发由参数与配置定,LLM 全程不参与判断）;**用户要了才发**（"你都没说钉钉通知,为啥会通知"——per-run 参数为主,环境变量/配置在场也不擅自发）;**卡片渲染归引擎**（"现在的内容还很丑"——渲染在挂点侧组装,通道工具只收文本,见 [[tools/dingtalk-notify]]）。

**能力契约（HopTrait）**：

```
trait: RunNotifyHook
  Id: mcp-notify-hook
  Constraints:
  - 挂点=HopjitMcpCore.applyResult（曾用名 RunManager——review 面二抓设计类名与实名脱钩,2026-08-31 全改实名;验收阅卷再抓改错句自指笔误后勘正）（终态 completed/failed 与 paused 汇此处——engine.finalizeTerminal 不挂:同步函数且子实例也触发,辨顶层成本高;本挂点天然只见顶层 run）+ **三条异常失败 catch 路径同挂**（startRun 的 runSpec catch/崩溃恢复 catch/resumeRun catch——它们绕过 applyResult 直写 entry.state='failed',挂点必须逐处补上,否则"failed 恒发"对 throw 终态失实——阅卷实抓后补）;notifyRequested 是会话内存标志不随快照,server 重启恢复的 run 不再发通知（如实边界:恢复场景操作者已在场,通知价值低,不为它做持久化）
  - 触发三与门:①run 级开关 notify=true（start_run 的 params 顶层旁路键 hop_notify:true——与 hop_env_* 同款命名空间摘取,不进 spec Inputs）②config notify: 节声明了通道。门①②缺任一**静默跳过**（不发不记不问——没被要求的通知=替用户做主）;③该通道凭证环境变量——它不是前置判定而是发送期自查（sendDingtalk 缺凭证回失败值）,**走到发送而失败的一律记 server 日志一行**（含凭证缺席——用户明确要了通知却发不出,无声吞掉=用户以为会响的手机永远不响,该可见）
  - 事件面:completed/failed 恒发（要了通知的 run）;paused 同发（等人停点正是通知价值最大处,卡片带 ⏸️ 徽记）;**aborted 恒不发**（stop_run 主动中止=操作者此刻在场亲手停的,通知一个自己刚做的动作=骚扰——2026-08-31 review 抓行为在文字缺席后著文）
  - 发送经通道工具的发送执行体直调（sendDingtalk——进程内函数调用,不绕工具 execute 的 requires_commit 闸:挂点是引擎自身行为不是 spec 步骤,commit 语境约束不适用;一份发送实现两个消费口）
  - 卡片组装:标题=终态徽记(✅ 完成/❌ 失败/⏸️ 等你确认)+spec 标题;正文=进度(完成/总步数)+当前步/停点问题+run_id 尾段——数据同源 run_status 投影
  - 通知失败恒不影响 run 本身:发送异常吞掉记一行 server 日志（通知是旁路,不许反向拖垮主流程）
```

**config schema（StandaloneConfig 新顶层键——mergeConfigs 必须同步逐键展开,commands 键漏写合并的前车之鉴）**：

```
struct: NotifyConfig
  Id: notify-config
  Fields:
    - channel: line     # 通道枚举,现只 dingtalk;将来 wechat/mail 扩员
# 凭证不进配置——通道自己读约定环境变量（dingtalk=DINGTALK_WEBHOOK/DINGTALK_SECRET）,
# config 只声明"用哪个通道"。两级合并=项目级赢（逐键覆盖,与 env 同律）。
```

**关键逻辑（HopSop）**：

```
挂点四处（applyResult 尾部+三条异常失败 catch 路径——startRun 的 runSpec catch/崩溃恢复 catch/resumeRun catch,各一行 maybeNotify(entry);流程图只画主路 applyResult,三 catch 是同一函数的旁路调用点,review 面一抓"trait 点名但不入流程"后此处明写）。applyResult(entry, r) 尾部追加:
1. [条件(entry.notifyRequested 真 且 config.notify?.channel 在场)] 组卡片
   1.1 status=paused → 标题 '⏸️ 等你确认 '+spec 标题;正文含停点问题摘要
   1.2 completed → '✅ 完成';failed → '❌ 失败'+失败步
   1.3 正文尾附 run_id 尾段（多 run 并存时人能对上号）
2. [条件(通道=dingtalk)] sendDingtalk({text, title}) —— fire-and-forget,await 但 catch 吞,
   失败记 server 日志一行
3. notifyRequested 的来源: startRun 时从 params 摘 hop_notify（真值即置,摘取后不透传给 spec——
   与 hop_env_* 摘取同位同款）
```

**测试正反例**：正例——hop_notify:true+config 通道在场+假 webhook 环境变量,run 到 completed 时 fetch 桩收到 markdown 报文含 ✅ 与 spec 标题;paused 停点收到 ⏸️ 卡片。反例——hop_notify 缺席（config/凭证齐全）零发送;config notify 节缺席零发送;发送 fetch 抛异常 run 照常 completed（通知旁路不拖垮主流程）。

**复用模式挂点（2026-08-31 落地——0830 批"不挂待真需求"的真需求次日到场:作者定"给/hop 加一个钉钉通知功能"）**：契约归 [[hop-cli#^anc-cli-notify-reuse]]（三点差异:开关跨进程入 EngineSnapshot/挂点=CLI 公共出口五命令统一/配置经 readProjectNotify 单键;三与门/事件面/失败旁路与本节同款,卡片渲染抽 composeRunCard 共享——本节 maybeNotify 的组装段随迁该函数,两挂点同源）。

## 配置与凭证【契约】 ^anc-mcp-config

配置文件 `~/.hopjit/config.yaml` 只保存 `api_key_env` 名称。顶层或 provider 内出现 `api_key` 立即拒绝；不做文件权限检查，因为文件不含秘密。

**fail-fast 启动预检（2026-08-07 review P2 补定）**：server 启动时**逐 provider** 解引用 `api_key_env`——任一缺失即启动失败并报变量名（此前首次 start_run 才暴露，违反 fail-fast 契约且不走结构化错误）。

**配置核心直接调用同样 fail-fast**：`HopjitMcpCore.startRun` 在写任何派生路由 env 前一次性读取并快照全部 provider key；任一缺失立即拒绝。必须先全读后全写，禁止边读 `api_key_env` 边写 `{SERVICE}_API_KEY`——源变量可能与另一个 provider 的派生目标同名，顺序写会把后者凭证静默串成前者。

**多 provider 的 v1 语义（2026-08-07 review P1 补定——原设计未言，代码静默只吃 providers[0]）**：`providers[0]` 为默认执行 provider（HostConfig 主体 + ModelEngine.default_service_id）；**全部条目**在启动时注入本进程路由环境（`{SERVICE_ID大写}_API_KEY` / `_BASE_URL` / `_PROTOCOL` / `_AUTH`（第四项 2026-09-18 随 auth:bearer 档加入,仅 bearer 时写键——getClientForService 按它选鉴权头形态,schema 权威 [[shared-providers#^anc-config-standalone-schema]] auth 行）/ `_MAX_OUTPUT_TOKENS`（输出预算解析链第 3 级,前批既有本行漏登随批补）——`_PROTOCOL` 2026-08-12 随 openai 协议加入，getClientForService 按它选适配器，缺省 anthropic；即 [[step-dispatcher]] getClientForService 的多服务约定）——spec 的 `service/model` 引用按 service_id 命中对应后端，不静默回退默认 client（错后端=烧错钱）。`default_model` 映射 ModelEngine.default_model（缺省 providers[0].model）。key 始终只在本进程 env，不出进程（隔离纪律不变）。**v1 边界（v2 复审点）**：路由走进程 env 意味着同 server 全部 run 共享一套 provider 集合——v1 单配置文件下语义一致无冲突；若将来出现"不同 run 用不同 provider 集合"的需求（多配置/每 run 覆写），env 通道会串台，须改为显式传 ModelEngine 路由表（依赖驱动决策，触发即复审）。

## 安全边界【契约】 ^anc-mcp-key-isolation

1. **key 不出 server 进程**：配置文件只存 env 名，key 不进 MCP 响应、不进 HopLog、不进 `.hopstate/`；错误消息只给环境变量名不给值；
2. **spec_path 不做全库搜索**：只接绝对路径或相对 server cwd 的显式路径（"焊死"原则——server 无对话上下文，猜路径=在错误的 spec 上烧钱）；
3. **stdio 仅本机**：transport 网络化前必须补鉴权设计，v1 结构性排除远程调用。

## 载体注册与薄协议（二期）【契约】 ^anc-mcp-carrier-integration

- 注册：CC 项目 `.mcp.json` / Codex `~/.codex/config.toml [mcp_servers]`，命令 `hopjit-mcp`（包 bin 第二入口）。**`install-skill --mcp` 同步注册**（2026-08-16 作者定——装壳+注册一个动作;显式 flag 即授权,原『不代注册』的越权论据消解）：CC 合并写 `<cwd>/.mcp.json`（保留既有其他 server）;Codex 追加 `[mcp_servers.hopjit]` 块（含 `env_vars` 凭证名透传——值不落盘只写名,干净环境实撞防线）;已有 hopjit 条目跳过（--force 亦不覆盖注册——配置是用户资产,提示自查）；
- standalone 是**独立薄协议、不在降级链上**（2026-08-10 作者拍板，契约见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]）：hopjit MCP 工具面在会话可见（决策 3：注册即 opt-in）即选定 standalone——main 走 start_run → 轮询 run_status → HITL 经 resume_run → YAML 终态四步薄壳，全程零 hopjit CLI、零 subagent、零运行时环境判定。工具面不可见时才是 spawn 能力门的 delegated→inline 两层世界，两种形态互斥、无运行时交叉；
- 执行体唯一性沿 TODO 原约束：**server 侧已有 run 即已有状态写入，禁止转 CLI/subagent 重跑**。

## 实施切期【说明】

- **一期**（本设计范围）：mcp-server 模块 + config schema（shared-providers）+ 工具面/生命周期/安全测试 + 真机验收（DeepSeek Anthropic endpoint 跑 coffee-week 到 completed、doc-review 到 paused→resume→completed、key 不落盘扫描）；
- **二期**：Codex 能力门三层分派 + carrier-live-e2e 新场景（codex:standalone 从"恒 exit 2"转正）+ 崩溃恢复（注册表重建，衔接 DEBT-05/08）。
