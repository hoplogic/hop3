%% @trace
	id: hopjit-mcp-server
	source: [[step-dispatcher]], [[shared-providers]], [[../concepts/HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-step-dispatcher, hopjit-shared-providers, hopjit-runtime
	type: extend
	last_sync: 2026-10-11T13:45+0800
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
| run_approved_command 执行细则 | 契约 | `anc-mcp-run-command` |
| 复用模式驱动工具（七件） | 契约 | `anc-mcp-reuse-driver-tools` |
| commit 批准工具 approve_commit | 契约 | `anc-mcp-commit-approve` |
| dirs 批准工具 approve_dirs 与 start_run dirs 参数 | 契约 | `anc-mcp-dirs-approve` |
| 管理工具面（八件：doctor / ant_*） | 契约 | `anc-mcp-admin-tools` |
| 配置能力状态与 server_status | 契约 | `anc-mcp-server-status` |
| HITL 与运行生命周期 | 契约 | `anc-mcp-run-lifecycle` |
| server 重启后 run 恢复 | 契约 | `anc-mcp-run-restore` |
| 配置与凭证 | 契约 | `anc-mcp-config`（schema 权威在 [[shared-providers#^anc-config-standalone-schema]]） |
| 安全边界 | 契约 | `anc-mcp-key-isolation` |
| 载体注册与三层分派（二期） | 契约 | `anc-mcp-carrier-integration` |

## 定位【契约】 ^anc-struct-mcp-server

> **模块版本**：mcp-server `v0.28.9`（2026-10-12 todo/0168：^anc-mcp-reuse-driver-tools 的 submit_and_fetch_next 八种提交形态改七种——撤 `branch` / `reason` 字段,选路只由引擎按 case 条件求值（作者定"不存在外部选路场景,branch / case 都是显性条件",契约 exec-engine ^anc-exec-branch-select-internal）,HopSop driverSubmit 原 4.4 分支删、值契约 branch 句删;同批 ^anc-mcp-config 装配线契约 workspace_dir "三处同锚"改"四处"补项目级配置 hopjit.yaml 重读根,0164 变异实测暴露的漏列）。上版 v0.28.8（2026-10-11 todo/0164：^anc-mcp-config 加"组合根装配线逐条契约"六条——routing_rules 的 thinking 透传、裸模型名引用的 service 归一、providers[0].auth 贯穿 HostConfig.auth、沙箱缺省拒读基线六项、显式 workspace_dir 三处同锚、tool_servers 注册文法错经 start_run / restoreRun 返回 TOOLS_FILE_INVALID,每条写明可观察面;^anc-mcp-run-restore M3 条补一句"恢复的 run 上同样成立"。设计只补契约句,代码零变化,测试补"删一行必红"正例）。上版 v0.28.7（2026-10-11 todo/0163：^anc-mcp-reuse-driver-tools 的 driverSubmit 签名补八种提交形态各自的值契约——child_instance / failure_child 此前只有形态名没写值是子实例号、从父实例 calls/<子实例号>/ 读;HopSop 第 1 步"至多一个"改"恰好一个"并写明一个都不给时的去向（落 4.7 按无产出 output 提交,有输出槽的步骤由引擎产出校验拒）,与表行、工具说明、代码三处对齐;接口零变化）。上版 v0.28.5（2026-10-11 hopissues/0128：run_approved_command 的 `timeout_sec` 上限 3600 → 1500——低于 Claude Code 对 MCP 工具 1800 秒静默上限留余量,超限截断照跑不拒收,分段等待是正路;进度通知归将来）。上版 v0.28.4（2026-10-11 语义审计 0156 C 类：^anc-mcp-run-restore HopSop 补 5.1 步"作业对象根从快照 getRestoredWorkspaceDir 取,旧快照缺席回退 server cwd";start_run 的 hop_env_* params 摘取补写"非字符串值摘除不进表不报错";^anc-mcp-run-command 补"模式归属=复用模式驱动面,不依赖独立模式"口径条款,standalone-mode 同批跟改）。上版 v0.28.3（2026-10-11 语义审计 0156 B5：^anc-mcp-stop-run 第 2 条 aborted 钉住的回写口三处→四处——补登 resumeRun 的 rejected 回调,代码该分支 aborted 时同样 close tool provider）。上版 v0.28.2（2026-10-10 0154+0155 工程链 review 修复：AdminContext 约束条款写明 git 用户名的例外与 cwd 纪律;两个引擎注册闭包去掉 `|| process.cwd()` 兜底——引擎传空串只在 hostConfig 缺席时发生,直传 antRoots 等价只查用户级,少一处未登记的进程 cwd 读点）。上版 v0.28.1（2026-10-10 todo/0155 HopAnt 两级根：`ant_install` 加 `scope`（user | project,缺省 user）,`ant_remove` 加可选 `scope`,`ant_list` 两级合并每行带 scope,`ant_adapt` / `ant_bootstrap` / `ant_share` 按 id 两级找（项目级先）;AdminContext 加 `roots`（由 home 与 workspace_dir 算）;缺省 DirSpecProvider 与批准账闭包改用两级根（项目根=本 run 的 workspace_dir）——[[hopant]] 决策 1 / 9）。上版 v0.28.0（2026-10-10 todo/0154 新增管理工具面八件 `doctor` / `ant_list` / `ant_install` / `ant_adapt` / `ant_remove` / `ant_bootstrap` / `ant_pack` / `ant_share`——hop 自己的体检与 HopAnt 生命周期动作此前没有 MCP 工具,/hop 封 HopAnt 落到载体 Bash 弹窗与文件沙盒;业务体从 cli.ts 搬进 hop-cli 模块的出口文件 hop-admin.ts,两个组合根各套薄壳,机器侧事实经 AdminContext 传入;八件进 HOPJIT_ALLOWED_TOOLS,setup 不进;^anc-mcp-admin-tools）。上版 v0.26.1（2026-10-09 commit 安全分析批次工程链 review 修复：resolveCommitAnalyzerProvider 签名补参数类型与返回说明,HopSop 补"provider 找不到"一支（抛 STANDALONE_CONFIG_INVALID,加载期已拦,此处是防线）;approve_commit 的 fingerprint 参数说明在代码侧与本设计对齐为"body 的指纹";缺陷 D41:approve_commit 的工具说明补一句"引擎判过安全、模型判过安全或人批准过的步骤记进批准账,以后同一步（body 没改）先查账、账上有就直接执行"）。上版 v0.26.0（2026-10-08 commit 批准改为安全分析（作者定"主要出自于安全性判断，而不是正确性判断"）:serve 注册的函数改为 resolveCommitAnalyzerProvider + makeCommitAnalyzer;approve_commit 的指纹只覆盖 body,scope=once 改为本次运行内有效,task 的选项文字改为"这一步以后都通过";呈现协议改为先用大白话讲安全分析的结论、代码在用户要求时才贴;停点只在有需要人确认的动作时出现）。上版 v0.25.1（2026-10-08 发版前八项修复批工程链 review 修复：出口表 `ProviderEntry` / `StandaloneConfig` 行改 deprecated-reexport（与 mergeConfigs 行同口径——v0.25.0 一行写"已迁出"一行写"在此定义");根锚点继承与正文的 StandaloneConfig 主名加 HopConfig 括注;复用模式 run 的工具工厂项目根改按 HostConfig.workspace_dir 取,不读 process.cwd()）。上版 v0.25.0（2026-10-08 todo/0131：parseConfigFile / mergeConfigs / validateMergedRefs / StandaloneConfig 挪出到 config-load 模块,`loadStandaloneConfig` 改薄包装（算路径 → loadHopConfig requireProviders）,`StandaloneConfig` 作 `HopConfig` 别名再导出一版;独立模式行为零变化）。上版 v0.24.0（2026-10-08 commit 批准改为自动研判优先（作者定"自动研判,拿不准转人工，但是依然要给人选项，这个任务以后一律通过"）:serve 在配置可用时按 resolveCommitReviewerProvider 注册研判函数;approve_commit 参数 body_hash 改 fingerprint、新增必填 scope（once/task）。上版 v0.23.2（2026-10-07 todo/0146 工程链 review 修复批次：设计层补齐与代码对齐——七件驱动工具、approve_commit、ServerCapabilityStatus 改写成 HopType 成员函数签名 + HopSop 函数体;submit_and_fetch_next 的 output/answer 不是 JSON 对象时报 INVALID_ARG（与 CLI 同一检查）;approve_commit/approve_dirs 显式传的 workspace_dir 不存在报 WORKSPACE_NOT_FOUND、抛错经 driverErrorOf 转结构化错误;serve 配置加载与 classifyConfigError 四类修法写成 HopSop;ServerStatus/StandaloneStatus/ConfigError 三个 HopSchema;resumeRun 按代码顺序写成十步;restoreRun 补墓碑与独立模式能力闸两道门;自有码清单补 INVALID_ARG/WORKSPACE_NOT_FOUND;COMMIT_NOT_APPROVED 报文两处同源。工具名与 schema 不变）。上版 v0.23.1（2026-10-07 dirs 批工程链 review 修复：start_run 的 dirs 对账挪进引擎 initExecution（作为 EngineOptions.dirsGrant 传入,缺即 INIT_FAILED 不建实例;对账键取真实路径）。上版 v0.23.0（2026-10-07 todo/0148：新工具 `approve_dirs`（与 approve_commit 同模型：人同意由 driver 在对话里问,进放行清单）;`start_run` 加 `dirs` 参数（独立模式唯一授权面,与 spec 声明对账）;复用驱动 `run` 加 `approve_dirs`——^anc-mcp-dirs-approve）。上版 v0.22.0（commit 的人批准改在对话里问:driver 贴 body、用载体提问工具问同不同意,用户同意后调 approve_commit 记账;approve_commit 和其他工具一样由 setup 放行,撤掉 v0.21.1 加的强制确认标记。来由:作者纠正"需要审批的时候在对话里问",载体弹窗频繁、用户习惯性点过,不能当批准闸（^anc-mcp-commit-approve「为什么不用载体弹窗当批准闸」）。上版 v0.21.1（2026-10-07）。上版 v0.21.0（2026-10-07）。上版内容=三件（todo/0146,驱动改走 hopjit MCP 工具、减少载体弹窗）:①新增七个复用模式驱动工具 `run`/`submit_and_fetch_next`/`reap_and_fetch_next`/`status`/`resume`/`abort`/`validate`,一个 CLI 子命令对一个工具,参数结构化、工具本身不调 LLM（^anc-mcp-reuse-driver-tools）;②新增 `approve_commit`——commit 每句只批一次的批准入口,是 setup 唯一不放行的 hopjit 工具（^anc-mcp-commit-approve）;③配置缺失、providers 为空、配置非法、凭证环境变量缺失都不再阻止 server 启动,改记为能力状态:复用驱动工具照常可用,start_run 与独立模式 run 的 resume_run 返回 `STANDALONE_UNAVAILABLE`（原因+修法）,新增只读工具 `server_status` 报告该状态（^anc-mcp-server-status）。上版 v0.20.1（2026-10-07）。上版内容=缺省 DirSpecProvider 两处挂载（startRun 与重启恢复）加第二参 `antsRoot(homedir())`,独立模式 `call <ant-id>` 能找到已装 HopAnt（寻址规则 [[shared-providers#^anc-provider-spec-default]],todo/0142 子卡 B）。上版 v0.20.0（2026-10-04）。本版=stop_run 加可选 `state_dir` 参数,注册表查不到时按快照兜底:快照是 paused（或进程崩溃时停在 running）就写墓碑 aborted.json、删问题卡,返回 aborted 并带 restored_from_snapshot:true;已终态幂等返回不写墓碑;快照正被另一个活着的进程持有时拒 RUN_OWNED_ELSEWHERE;墓碑写不进去报 STOP_WRITE_FAILED（hopissues/0117,见 ^anc-mcp-stop-run 第 6 条）。上版 v0.19.1（2026-10-01 工程链 review 修复：run_approved_command 细则六处对齐代码——state_dir 可选/返回加 duration_ms 与 account_error/HopSop 按代码顺序重排并补命中支/timeout 三钳命名常量/cwd 相对路径与 ws 缺席落点/hoplog 目录已删与账写失败两分支;工具面表行归位;自有码清单补登四码;删死码 STATE_READ_FAILED）。上版 v0.19.0（2026-09-30）新增第六个工具 `run_approved_command`——在某个 run 的上下文里执行一条命令：授权只认该 run 的任务卡《已批准命令》前缀清单（不认 hopjit.yaml 项目级白名单）,执行经 runWhitelistedCommand 原语（hopjit 恒拒/shell:false/失败分辨继承）,账追加进该 run 的 hoplog;纯读盘不重建 engine（todo/0132 承接 hopissues/0114——/hop 复用模式 driver 每条命令过载体权限闸反复弹窗;作者定按任务批准、账归 run、"就是执行一步而已"）。上版 v0.18.1（2026-09-27）配置加载认 provider 新键 thinking_disable_unsupported本版=配置加载认 provider 新键 thinking_disable_unsupported（只认布尔,非 anthropic 协议写 true 拒）,env 快照在其为 true 时派 `{SERVICE_ID}_THINKING_DISABLE_UNSUPPORTED=true`,多 provider env 注入键名单同批补登（todo/0118）
> - 上版 v0.18.0（2026-09-26）=resume_run/stop_run 在通道核对之前预检 state.json 写入序号,本进程注册项的账已被另一个进程写得更新时返回 STATE_STALE、不改状态,非 running 的过时注册项移出注册表（todo/0114）。
> - 上版 v0.17.0（2026-09-25）=resume_run 带 child_instance 时在状态翻转之前同步核对待答队列,核对不中当场返回 CHILD_NOT_IN_QUEUE、run 保持 paused（todo/0105 缺陷 B,兑现 hopissues/0094 期望行为第 ② 条）。
> - 上版 v0.16.1（2026-09-18）=工程链 review 补账。补账内容:多 provider env 注入键名单补 `_AUTH` 与 `_MAX_OUTPUT_TOKENS、`{SERVICE_ID}_THINKING`（provider 级思考缺省,0100 批次——2026-09-20 review 批补登）` 两键;auth/revision_prompt 两新配置键的 schema 权威在 [[shared-providers#^anc-config-standalone-schema]]、行为权威各在其锚,本文档只登键名单——1cc47f7b 自称'mcp-server v 随批'未兑现的账本版清。
> - 上版 v0.16.0（2026-09-10）,内容为 0084 批一四件（M1 并发 run 上限配置化/M2 合并补 language+文法核/M3 restore 补装 model_engine〔与 startRun 公共化真同源〕/M4 restore env 换重读面）。
> - 0.x 未承诺稳定。**MCP 工具名+输入/输出 schema 是对外稳定面**——载体注册配置依赖之，破坏即破坏已注册用户。
> - **逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
> **根锚点继承**（`^anc-meta-module-design-artifacts` 必备件①，本模块为首个样板）：
> - 概念前提：[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]]（双模式驱动——本模块是独立模式的对外协议壳，模式语义变更须重核本文）；[[../concepts/HopSpec V3核心规范#^anc-exec-hitl-presentation]]（HITL 介入点表达——paused 载荷与"不替答"纪律的上游）
> - 元规范义务：[[../concepts/工程实现链规范#^anc-meta-module-design-artifacts]]（四必备件）；[[../concepts/工程实现链规范#^anc-meta-module-evolution]]（版本纪律，G9 互锁）；[[../concepts/工程实现链规范#^anc-meta-guard-self-trust]]（fail-fast/禁静默跳过——本模块启动与配置加载行为的依据）
> - 配置事实权威：[[shared-providers#^anc-config-standalone-schema]]（两级配置 schema 的唯一定义处——本文所有配置表述是其投影，冲突以彼为准;TS 形态是 [[config-load]] 的 `HopConfig`,本文沿用的 `StandaloneConfig` 是它的别名）
>

**① 自身定位**：MCP server 是 StepDispatcher 的**协议壳**——把 MCP 工具调用翻译为 Dispatcher 进程内 API 调用，管理多个 run 的生命周期注册表。它**不含执行逻辑**：步骤推进、LLM 调用、retry、HITL 暂停语义全在 Dispatcher/Engine（见 [[step-dispatcher]]）。

- 与 hop-cli 的关系是**平行的两个协议面**：hop-cli 服务复用模式（caller=外层 LLM，逐步应答），mcp-server 服务独立模式（caller 只管启动/介入/收终态，推理在 Dispatcher 内）。
- （解释性类比：hop-cli 像数据库的逐条 SQL 客户端，mcp-server 像存储过程执行器——提交整个任务，中途只在需要授权时回来。）

**② 与其他 HopType 的关系**：
- **StepDispatcher 的薄封装**：每个 MCP 工具对应 Dispatcher/注册表的一次操作（start_run→new StepDispatcher + runSpec、resume_run→dispatcher.resume、run_status→注册表查询）。进程内直调，不经 CLI 子进程（沿 [[step-dispatcher]] 决策 2"热路径不经 CLI"）
- **与 hop-cli 零耦合**：不 import cli.ts，不共享输出分流逻辑（MCP 有自己的结构化响应通道）；共享的是 cli-types 的响应类型词汇（ExecutionPaused 等）与 hop-admin.ts 的管理面业务体（doctor / ant 七动作——hop-cli 模块的出口文件,两个组合根各自套薄壳,^anc-mcp-admin-tools）
- **持久化沿用 FilePersistence**：run 状态内存为主（常驻进程），FilePersistence 快照照旧落 `.hopstate/`——server 崩溃后的恢复能力即既有 durable resume 能力，不新增持久化机制
- **HopLog 恒开、缺省 info 级、保留上限缺省 3 个 run**（2026-08-07 G11 落实补定;级别缺省 2026-09-30 todo/0127 作者定 debug→info 并加 `log_retention.max_runs` 缺省 3——对外分发后防塞爆硬盘,权威 [[spec-observability#^anc-obs-log-levels]] / [[spec-observability#^anc-obs-log-retention]];2026-08-22 曾定缺省 debug,前提"个人开发场景体积可承受"已变）：start_run 一律带 logDir（`<state_dir>/../.hoplog`，同复用模式 driver 惯例）。
  - 理由:standalone 的执行内幕（LLM 调用/工具执行）全在 server 进程内，**执行日志是外部核验过程轨迹的唯一通道**（e2e"核真过程"原则 `^anc-meta-layer-test` 的本模块落点），info 级只记 model/tokens 不记 prompt 正文，"唯一通道"名存实亡;
  - 排障要全息经配置口升级：StandaloneConfig `log_level: debug`（debug|info|warn，两级合并项目级赢，schema 权威 [[shared-providers#^anc-config-standalone-schema]]）;保留数经 `log_retention: { max_runs: N }` 调;
  - 与复用模式缺省 info 的分野：复用模式 CC 即推理 LLM、caller 生态自有观测面；standalone 没有第二通道
- **transport 可扩展**【决策注记】：server 核心（工具 handler）与 transport 分离——v1 仅 stdio（MCP SDK 标准），将来需要非 agent 消费方（curl/CI）时同一核外挂 HTTP transport，不重写（2026-08-06 方案对比结论：MCP 为主，HTTP daemon 为记录在案的演进出口）

**②b 对外接口清单【封闭】** ^anc-struct-mcp-server-exports：

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| MCP 工具 `start_run` / `run_status` / `resume_run` / `list_runs` / `stop_run` / `run_approved_command` / `server_status` / `approve_commit` / `approve_dirs` / 复用驱动七件 `run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `status` / `resume` / `abort` / `validate` | 协议工具 | mcp-server.ts（bin 入口 `hopjit-mcp`） | 载体注册配置（.mcp.json / config.toml）——**对外稳定面** | provisional |
| `loadStandaloneConfig` / `providerToHostConfig` / `collectSpecTools` / `preflightProviderKeys` / `HopjitMcpCore`（含 `runCommand` 方法——run_approved_command 工具的可单测本体） / `buildServer` | 函数/类 | mcp-server.ts | **仅测试消费**（mcp-server.test.ts）——非跨模块出口，不承诺稳定；跨模块 import 即边界违规 | internal-testable |
| `resolveCommitAnalyzerProvider` | 函数 | mcp-server.ts | commit 安全分析用哪个模型（routing_rules 的 commit 规则,否则默认模型）——serve 注册分析函数前调;测试直测取法（2026-10-08 由 resolveCommitReviewerProvider 改名） | internal-testable |
| ~~`mergeConfigs`~~ | 函数 | mcp-server.ts → config-load.ts | **已迁出**（2026-10-08 todo/0131）——读取/合并/引用核三函数与 `HopConfig` 类型归 [[config-load]] 出口表;mcp-server 再导出 `mergeConfigs` 与 `StandaloneConfig` 别名一版供既有测试 import,新代码从 config-load 取 | deprecated-reexport |
| `buildEnvSnapshot` | 函数 | mcp-server.ts | run 级 env 快照构造单点（测试直测键集契约——0008③ 封闭集下键集即契约,startRun/restore 同函数） | stable |
| ~~`ProviderEntry` / `StandaloneConfig`~~ | 类型 | mcp-server.ts → config-load.ts | **已迁出**（2026-10-08 todo/0131）——真身是 [[config-load]] 的 `ProviderEntry` / `HopConfig`;mcp-server 以 `StandaloneConfig = HopConfig` 别名再导出一版供既有测试 import,新代码从 config-load 取。schema 语义权威在 [[shared-providers#^anc-config-standalone-schema]] | deprecated-reexport |

> **内部（表外即内部）**：run 注册表私有方法、transport 装配（serve）。**对外稳定面是 MCP 协议工具，不是 TS export**——TS 符号出口仅为测试可达（"不为测试暴露私有"判据的例外形态：模块以协议面对外，TS 面天然无跨模块消费方，export 是测试边界对齐的最小代价，如实登记不冒充稳定接口）。

**③ 主要 traits 与主要成员**：

Fields：
- `runs: Map<run_id, RunEntry>`——运行注册表。RunEntry = { dispatcher, state: running|paused|completed|failed|aborted, pausedPayload?, startedAt, specPath }
- `config: StandaloneConfig | null`（`StandaloneConfig` = config-load 的 `HopConfig` 别名,下同）——启动时从 `~/.hopjit/config.yaml` 加载（`HOPJIT_CONFIG` 环境变量可覆盖路径——测试/多环境用，2026-08-08 审计回写）；加载失败或预检不过时为 null
- `configError: { reason % text, fix % text } | null`——独立模式不可用的原因与修法（配置文件缺失/providers 为空/文法或明文 key 违规/凭证环境变量缺失）;null=独立模式可用。见 [[#^anc-mcp-server-status]]

trait：
- `serve`——加载配置并把结果记为能力状态（不因配置问题退出）,装配 MCP SDK server + stdio transport，注册全部工具（独立模式六件+server_status+approve_commit+approve_dirs+复用驱动七件），进入服务循环。配置加载流程见 [[#^anc-mcp-server-status]] 的 serve 配置加载 HopSop
- `dispatchTool`——工具调用路由：校验入参 schema → 操作注册表/Dispatcher → 组装结构化响应

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl start_run（异步启动）
0. [check] 独立模式能力闸:config 为 null → 返回 standaloneUnavailable() 的 STANDALONE_UNAVAILABLE 错误体,不建 run（^anc-mcp-server-status）
1. [act] 校验 spec_path 存在 + parseSpec/validate 过闸（坏 spec 即拒，不建 run）
2. [act] 预检工具面：spec 所需非内置工具 ⊆ 装配后 CompositeToolProvider 并集（内置组∪注册件——0084 批三随实况勘正,原文写 DefaultToolProvider 是组合化前旧型），不满足即拒（错误列缺口清单）
3. [act] new StepDispatcher(config 解析出的 HostConfig) + 注册表登记 run_id（HostConfig.hop_env 的合成顺序见 [[shared-providers#^anc-config-hop-env]]:配置 env 节打底,params 里 `hop_env_*` 键覆盖并从 params 摘除——凭证形态键名返回 HOP_ENV_CREDENTIAL_REJECTED;非字符串值的 hop_env_* 键同样被摘除但不进表、不报错,hop_env 表只收字符串）
4. [act] 异步启动 runSpec()（不 await）——完成/暂停/失败时更新注册表
5. [act] 立即返回 { run_id, status: 'running' }
```

### 核心要求

1. **薄壳**：执行语义零重复——暂停判定、answer 规范化、审计全在 Engine/Dispatcher（`^anc-exec-confirm-answer` 模式无关）
2. **job 式异步**：start_run 立即返回，不阻塞 MCP 工具调用（整 spec 执行分钟级，同步调用会顶爆 host 超时）
3. **配置问题不阻止启动,记为能力状态**（2026-10-07 todo/0146 改定,原为 fail-fast 启动）：配置缺失/schema 非法/出现明文 `api_key`/凭证环境变量缺失 → server 照常启动,独立模式标为不可用并记下原因与修法（明文 key 的修法仍是改用 `api_key_env`）;复用驱动工具与 run_approved_command 不依赖独立配置,照常可用。改定理由:驱动工具改走 MCP 后,server 起不来等于 /hop 整个不能驱动——一个只影响独立模式的配置问题不应拖垮复用模式。细则见 [[#^anc-mcp-server-status]]
4. **单 server 多 run**：一个 server 进程可并存多个 run（注册表隔离），run_id 由 server 生成（复用引擎 instance_id）

### 不是什么

- 不是第二个执行引擎——只是 Dispatcher 的协议壳
- 不是复用模式的替代——两模式并存，消费方按需选（见二期三层分派）
- 不是远程服务——v1 stdio 仅本机；网络暴露需另立安全设计，明确禁止裸挂公网

## 关键决策【决策】

### 决策 1：MCP server 形态，而非 CLI 一次性进程【决策：原则性，2026-08-06 作者拍板】

**候选**：① CLI `hopjit standalone <spec>`（一次性进程）；② CLI + 自建后台 job daemon；③ MCP server（本案）；④ 本地 HTTP daemon；⑤ Unix socket 私有协议。

**选 ③**。决定性判据：

- **状态常驻**——HITL（confirm/ask）暂停后执行状态活在 server 进程内存，resume 是同进程操作，**DEBT-05/08（host_config 恢复/跨进程 resumeSpec）从 v1 前置依赖降级为崩溃恢复的二期加固**；
- **载体原生可调**——CC/Codex 都原生说 MCP，注册即用，carrier 零胶水；
- **key 隔离**——key 住 server 进程环境，结构上不经过 prompt/CLI 参数/状态文件。

落选方案的病灶：①的 HITL 死结（跨进程恢复压三笔债，v1 只能预检拒绝阉割）与"缺省 standalone 劫持复用模式 run"冲突（driver 模板需加 --reuse 补丁）在 ③ 下均不存在。④ 是超集场景方案（非 agent 消费方），留作 transport 演进出口；②⑤ 自建通信层两头不占。

### 决策 2：CLI `hopjit standalone` 缓做【决策：依赖驱动】

TODO 原完成判据 1 写的是 CLI 形态。MCP 方案下它的真实用户只剩"人工调试 Dispatcher"，而两个协议面（CLI+MCP）= 两份 parity 维护（driver 双载体 parity 的教训现成）。**缓做**：一期不提供；确有人工调试需求时再立项，且届时实现为 MCP 工具的命令行客户端（单一事实源在 server），不是第二套执行入口。

### 决策 3：opt-in 信号 = MCP server 已注册【决策：原则性，2026-08-06 作者定向】

作者原意"有独立 LLM 配置时缺省用 standalone"。MCP 形态下落为：**用户在载体里注册了 hopjit MCP server 即 opt-in**——注册动作本身就是"我要用 standalone"的显式声明，费用授权原则（TODO 安全约束"禁止静默产生 API 费用"）天然满足；`~/.hopjit/config.yaml` 存在与否只决定 server 能否启动，不劫持任何既有命令语义（复用模式 `hopjit run` 零影响）。

### 决策 4：HITL v1 完整支持【决策：依赖驱动——常驻进程使然】

CLI 路线曾倾向"预检拒绝 confirm/ask"（避免跨进程恢复三笔债 + 子进程等 stdin 会挂死 carrier）。MCP 常驻进程下两个障碍都不存在：paused 是注册表状态 + 结构化载荷（不是等 stdin），resume 是同进程注入。**v1 不阉割 HITL**。

- paused 载荷 = 既有 ExecutionPaused 结构（question/output_schema/default_value/present_inputs），呈现纪律沿 `^anc-exec-hitl-presentation`——由调用方（carrier/人）负责问真人，server 不替答。


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

**串行 call 链投影（2026-08-30,todo/0011 ①半边清账）**：running 态且主线在 call 步时,响应增量字段 `call_chain?: Array<{ step: string; spec: string; current_step?: string }>`——逐层下钻 activeCallChildren（stop_run 修复新增的在飞 call 登记表,层层 getEngine().getStatus() 取 spec id 与当前步）。

- 形态示例:`[{step:'5.1',spec:'split-node',current_step:'2.1.1'},{step:'2.1.1',spec:'split-structure',current_step:'3.3'}]`。

- 病灶来历:run 主线卡在 call 步时 run_status 只回 running,递归子树烧到第几层外部全不可见,看护进度行整段 step=?;在飞视图当年只做 parallel 形态,串行 call 以"事后翻账可定位"缓做,实时看护拿不到 child id;
- 纯读账面零写动作（readOnlyHint 忠实同 inflight 先例）;无在飞 call 字段缺席（向后兼容）;深度即数组长度,防环由 call depth 上限天然兜底。

**token 统计透出（2026-08-30,todo/0023 清账——账早记全〔HopLog llm 块+state.json cumulative_tokens+BUDGET_EXCEEDED 消费〕但 run_status 不透出,长跑中途看烧了多少只能翻 HopLog）**：run_status 各态响应增量字段 `cumulative_tokens?: number`——纯暴露非新记账,与 inflight 视图同纪律（纯读引擎账面/响应形状向后兼容:0 值缺席不出字段）。

- 取值双源:注册表命中=engine.getCumulativeTokens()（内存实时）;注册表不中走快照兜底=state.json 的 cumulative_tokens（盘上账,跨进程恢复态不归零）。终态响应同带（跑完知总账）。

**关键逻辑（HopSop）**：

```
1. [act] runStatus 组装响应时：entry.state == 'running' 且 engine.getInflight() 非空
  → 附 current_step + inflight 投影
2. 其余状态照旧（paused/completed/failed 响应形状零变化）
```

## 工具面契约【契约】 ^anc-mcp-tools

独立模式六工具如下表；另有复用驱动七件（^anc-mcp-reuse-driver-tools）、`approve_commit`（^anc-mcp-commit-approve）、`approve_dirs`（^anc-mcp-dirs-approve）、管理八件 `doctor` / `ant_*`（^anc-mcp-admin-tools）、`server_status`（^anc-mcp-server-status）各见专节。输入/输出均 JSON schema 锁定（MCP SDK inputSchema）：

| 工具 | 入参 | 返回 | 语义 |
|---|---|---|---|
| `start_run` | `dirs`(可,`{read?: [line], readwrite?: [line]}` 绝对路径——独立模式 Config.dirs 的唯一授权面,^anc-mcp-dirs-approve)、`spec_path`(必)、`params`(可,object)、`state_dir`(可,默认 `.hopstate`;**相对路径锚 workspace_dir**——与 spec_path 同款解析规则,2026-08-25 修 work_zone 双基准劈裂:原实现相对 state_dir 原样下传,快照 mkdir 按 server 进程 cwd 落盘、act body 的 write 按 workspace_dir 锚解析同一相对路径,work_zone 目录两头对不上 ENOENT〔coffee/ppt 首发两 run 同死实撞〕;快照/hoplog/work_zone 三产物单一基准=workspace_dir。返回值携带解析后的 `state_dir` 绝对路径——server 重启后 run_status/resume_run 快照兜底据此传参,不必猜锚点)、`workspace_dir`(可,默认 server cwd——**作业对象根显式化**,2026-08-20 作者定目录三层归位：spec 目录=自包含单元/workspace=作业对象根〔业务材料读+产出写+沙箱锚〕/work_zone=引擎内务。server cwd 由注册时会话定、常≠作业对象,MCP 无 cd 通道故开参数;只接绝对路径或相对 server cwd 显式路径,不存在即拒——与 spec_path 同款焊死原则) | `{ run_id, status: 'running', state_dir: <解析后绝对路径>, warnings?: [line] }`（warnings 只随起跑返回一次——如 start_run.dirs 多传了 spec 没声明的目录,不授权的提示）或错误（spec 非法/工具面不足/配置缺失/Config.dirs 对账缺） | validate 闸门 → 工具面预检（**遍历须覆盖全部表达式形态含 field 链**——review P2：`tool(...).field` 曾绕过预检）→ 异步启动。**同一 server 并发 run 数上限可配置**（`resource_limits.max_concurrent_runs`,缺省 4——超限即拒,防失控烧费的保守默认;批量驱动场景显式调大=知情授权烧费。2026-09-10 todo/0084 M1:原为源码裸常量,任何配置途径改不了,批量语料验证第 5 个 run 被拒实撞——同文件同语义的 max_concurrent_workers 走 resource_limits 全通道,双重标准收敛。上限是 server 级判定,读启动期合并后配置——与 providers 快照同理由,不入每 run 重读面） |
| `run_status` | `run_id`(可——省略且**活跃**（running/paused）run 恰一个时取之；终态 run 不参与计数——2026-08-07 review 收紧：原按全部历史 run 计数，终态永久保留下简写几乎只能首用)、`state_dir`(可,缺省 .hopstate——**快照兜底用,2026-08-25 0028;相对路径按 server cwd 解析**——本工具无 workspace_dir 参数锚不了作业根,run 以 workspace_dir 启动时须传 start_run 返回的 state_dir 绝对路径,review 抓同名参数双锚语义只写在生产侧) | `{ run_id, status: running\|paused\|completed\|failed\|aborted, paused?: ExecutionPaused, paused_queue?: [{child_instance,...ExecutionPaused}], outputs?, failure?, current_step?, inflight? }` | 注册表查询。paused 时携带完整介入载荷；completed 携带全部 outputs；running 时携带在飞视图（见 ^anc-mcp-run-status-inflight）。**注册表不中时快照兜底（0028,detach 场景跨进程取问题卡）**：`<state_dir>/<run_id>/paused.json` 在场**且卡的 step_id 在 state.json 里仍是 running**（陈卡对账,31 轮 review——删卡与 persist 间崩溃/异常路径可残留卡,卡是递送件非状态源,失配以状态源为准报 NOT_FOUND 指路完整恢复;state.json 缺席跳过对账〔容手工卡/老快照〕） → 返回 `{run_id, status:'paused', paused:<卡全文>, restored_from_snapshot:true}`——**纯读**（不建 RunEntry/不构造 Dispatcher/零凭证需求,readOnlyHint 忠实;与 resume_run 的完整恢复分工:看卡零成本,注入答案才走 restoreRun）;aborted 墓碑在场 → status:'aborted';**状态权威序=墓碑>终态>等人卡**（40 轮 review——completed 快照+残留死卡并存时卡分支先行会让陈卡对账挡住真终态;删卡与 persist 非原子,残卡窗口真实存在）;**terminal_state 在场（0043 终局有据）→ completed 携 outputs（header.outputs 声明变量按 vars.json v2 root scope 现值收集,与进程内 collectOutputs 同判据;只收声明键）/failed 携 terminal_failure——纯读直判,原'快照不存 run 级终态'注记随 0043 作废**;无卡无终态有 state.json → 仍 RUN_NOT_FOUND:先下钻 calls/*/、parallel/*/ 找嵌套子实例卡,有则报文点名卡路径（人可直接读看问题;不冒充顶层 paused——嵌套暂停经 resume_run 重跑 call,恢复边界照旧）,无则注明非 HITL 暂停（运行中崩溃/网络暂停/旧版产物）指路 resume_run;两者皆无 → RUN_NOT_FOUND |
| `resume_run` | `run_id`、`step_id`、`answer`(object)、`state_dir`(可,同左——相对路径按 server cwd 解析,workspace 锚定的 run 须回传 start_run 返回的绝对路径)、`child_instance`(可——**子实例 HITL 队列应答路由**,携=答队列里那张卡,缺省=顶层/call_path 既有路由,见 [[parallel-execution#^anc-exec-parallel-hitl-queue]]) | `{ run_id, status: 'running' }` 或错误 | 透传 dispatcher.resume（answer 规范化在 Engine，`^anc-exec-confirm-answer`）。**带 child_instance 时先同步核对再受理（todo/0105,2026-09-25）**：状态核对之后、step_id 预检与状态翻转之前,查 dispatcher 待答队列与引擎在飞账——队列里没有这张卡、在飞账上也没有该 child_instance 的 paused 项,当场返回 `{ error: { code: 'CHILD_NOT_IN_QUEUE', message } }`,run 状态/暂停载荷/失败记录一概不动（仍是 paused,载荷可再取）;跨进程恢复路（队列空但在飞账有该 child 的 paused 项）照旧放行。此前实现先置 running 并同步回 `{status:'running'}`,dispatcher 异步拒收后才复原 paused——调用方只看得见假 running。判定流程与拒因文字单一来源见 [[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 4 条。**与 start_run 同为 job 式异步**——注入后立即返回，后续进度轮询 run_status（resume 后是多次 LLM 调用，分钟级，同步等待必顶爆 MCP 工具超时——2026-08-06 真机验收实撞后改定）。对非 paused run 调用 → 错误不推进 |
| `list_runs` | — | `{ runs: [{run_id, status, spec_path, started_at}] }` | 注册表快照，供 carrier 崩溃后重认领 |
| `stop_run` | `run_id`(必)、`state_dir`(可,缺省 .hopstate——**快照兜底用,2026-10-04 0117**;相对路径按 server cwd 解析,run 以 workspace_dir 启动时须传 start_run 返回的 state_dir 绝对路径) | `{ run_id, status, restored_from_snapshot? }`（受理后即回;终态 run 幂等返回现状;快照兜底路径带 `restored_from_snapshot: true`） | **主动中止 run**（2026-08-22 作者定"hopjit 应该能自己杀自己的子任务"——此前失控 run 只能杀 server 重启会话止损,两次实撞）。语义：running → 调该 run dispatcher 的 `requestAbortCascade()`（协作式中断:步间检查生效,不打断执行中的单步——与 parallel 杀活同一 aborted 标志机制,级联面见 [[step-dispatcher#^anc-struct-step-dispatcher-exports]] 调度组）——**级联 abort 全部在飞子 dispatcher**（parallel worker/暂停 call 帧/执行中的串行 call 子层三张表,深递归/并行都停,不留孤儿继续烧钱）;paused → 直接标 aborted（无在飞活动）;completed/failed/aborted → 幂等返回现状不报错;**注册表查不到 → 按 `<state_dir>/<run_id>/` 快照兜底**（server 重启前停在 paused 的 run 也能正规中止,细则 ^anc-mcp-stop-run 第 6 条）,快照也没有才 RUN_NOT_FOUND。中止落账：run 状态记 `aborted`（终态,list_runs/run_status 可见）+ 实例目录落墓碑标记 `aborted.json`（跨重启终局——restore 见标记即拒 RUN_ABORTED）,引擎快照照常落盘——aborted run 的 .hopstate 保留,可人工检视,不支持 resume（中止是终局不是暂停,同进程注册表拒 + 跨重启墓碑拒双防线,细则见 ^anc-mcp-stop-run）。注解 `readOnlyHint: false, destructiveHint: true`（丢弃在飞进度,如实标破坏性） |
| `run_approved_command` | `state_dir`(可,缺省 `.hopstate` 按 server cwd 解析——与 run_status 同款,起跑时用了 workspace_dir 的 run 须传绝对路径)、`instance_id`(必)、`argv`(必,string[] 非空)、`cwd`(可,缺省该 run 的 workspace_dir;相对路径按 workspace_dir 解析;任意目录——worktree / 临时区都行,2026-10-09 撤越界闸)、`timeout_sec`(可,缺省 300 上限 **1500** 下限 1——上限低于 Claude Code 对 MCP 工具的 1800 秒静默上限,留 300 秒余量;超限传入按上限截断照跑,更长的等待由调用方分段,每段 ≤1500;hopissues/0128)、`caller_step`(可,只写进账) | `{ returncode, stdout, stderr, duration_ms, truncated: { stdout, stderr }, account_error? }` 或结构化错 INSTANCE_NOT_FOUND / CORRUPT_STATE_FILE / APPROVAL_REQUIRED / COMMAND_FAILED（CWD_OUTSIDE_WORKSPACE 2026-10-09 已撤） | **在该 run 的上下文里执行一条已批准命令**（2026-09-30 todo/0132）：授权=该 run 任务卡《已批准命令》段的 argv 前缀逐项相等（[[spec-parser#^anc-rule-approved-commands]]）,**不看 hopjit.yaml commands:**;执行经 runWhitelistedCommand（hopjit 恒拒优先/shell:false/失败三类分辨）;账进该 run 的 hoplog 顶层 `command:` 块。纯读盘（readSpec/readState）+ spawn + append,不重建 engine、不碰注册表——run 在不在本 server 里都能调。注解 `readOnlyHint: false, destructiveHint: false, openWorldHint: true`（命令可联网,如实标）。细则见下文「run_approved_command 执行细则」节 |

### run_approved_command 执行细则【契约】 ^anc-mcp-run-command

**来由**：/hop 复用模式下 driver 干活全走载体自己的 Bash,每条命令过 Claude Code 权限闸——manual 模式前缀规则遇 `cd X;`/管道/参数变动即失配逐条弹窗;联网命令要逐条关沙箱;auto 模式分类器对同类动作时放时拒（hopissues/0114,用户原话"这么做每次都要授权,太蠢了"）。引擎已有更合适的管控原语 [[act-body#^anc-exec-command-primitive]],只是复用模式 driver 碰不到。作者三句定形：批准的单位是任务不是命令名（不放项目级大口子）;命令在该 run 的上下文里执行、账归该 run;"就是执行一步而已"——不重建 engine。与 [[../../hopissues 0071]]"/hop 禁调 start_run"并列不冲突：走 MCP 的只是命令这一口,run 的驱动与推理仍在主对话。

```
contract: RunCommand
  Id: mcp-run-command
  Goal: 在指定 run 的上下文里执行一条命令——授权来自该 run 的任务卡,执行经引擎命令原语,账进该 run 的 hoplog;载体只需一次性放行本工具,此后逐条执行零弹窗
  Constraints:
  - 授权只认该 run 任务卡的《已批准命令》清单（header.approved_commands,从 <state_dir>/<instance_id>/spec.json 经 readSpec 取——0130 内容寻址引用形态只此一读口）。匹配=某条前缀的每个词元与 argv 对应位相等且 argv 不短于前缀;argv[0] 相同但后续词元不同不算（`python3 scripts/ssh_exec.py` 批不放行 `python3 evil.py`）
  - 不认 hopjit.yaml commands:——那是引擎自己执行 body 时的项目级白名单;本入口是外部 agent 发起的,粒度必须到任务。拒绝报文指向卡的《已批准命令》段,不指向 hopjit.yaml
  - 执行恒经 runWhitelistedCommand（白名单位传 [argv[0]] 只为复用原语——hopjit 恒拒优先于一切、shell:false 恒定、ENOENT 两因/ENOBUFS/ETIMEDOUT 分辨指路全继承;真闸在上一条）。原语抛错 → COMMAND_FAILED 携原报文
  - cwd 缺省该 run 的 workspace_dir（state.json host_context）;显式传的相对路径按 workspace_dir 解析,绝对路径原样;**不判越界**——worktree、系统临时区等任意目录都可以（2026-10-09 撤 CWD_OUTSIDE_WORKSPACE 闸,见下「撤闸记录」:授权本体是 argv 前缀,cwd 不是授权要素）。workspace_dir 缺席（host_context 没落它的旧快照）→ cwd 落 server 进程 cwd
  - 账：state.json 的 hoplog_run_dir 在场且该目录仍存在 → HopLog.resume(runDir).recordCommand 追加顶层 `command:` 块（字段见 [[spec-observability#^anc-obs-command-block]]）;缺席或目录已被 max_runs 轮转删掉 → `<instance_dir>/commands.log` 追加一行 JSON 兜底（账不丢,只是换了落点）。账里记原始 stdout/stderr 字节数;回给调用方各截 64KB 并在 truncated 标记。**账写失败不吞执行结果**：命令已经跑了,记账抛错（目录不可写等）折进返回体 `account_error` 字段,returncode/stdout 照常返回——调用方必须知道命令已执行
  - 不重建 engine / hostConfig / 注册表：纯 readState + readSpec + spawnSync + append。run 目录不在 → INSTANCE_NOT_FOUND;spec.json 坏 → CORRUPT_STATE_FILE;都是结构化错不炸 server
  - **模式归属：复用模式驱动面,不依赖独立模式**（2026-10-11 语义审计 0156 C6 定口径——此前 [[standalone-mode#^anc-struct-standalone-endpoint]] 把它算进"独立模式六工具",与本设计"不依赖独立配置,照常可用"（核心要求 3 与 ServerCapabilityStatus 约束）两处口径不一,以本设计为准,standalone-mode 已跟改）。判据：它只读快照与任务卡、不构造 Dispatcher、不经 standaloneUnavailable() 能力闸,config.yaml 缺失或凭证缺失时照常可用;服务的是 /hop 复用模式 driver（来由段）。setup 侧的印证：opencode 禁用独立模式专属工具的清单 OPENCODE_DISABLED_TOOLS 只列 start_run / run_status / resume_run / list_runs / stop_run 五件,本工具与 approve_commit / approve_dirs 同归"两模式共用的批准三件"（[[hop-cli#^anc-cli-opencode-tools-gate]]）
  - 同步 spawnSync 阻塞 server 事件循环——单 server 命令串行,timeout 兜（缺省 300s 上限 1500s）;长命令是调用方拆分的事,设计如实记不掩
  - **上限为什么是 1500（2026-10-11 hopissues/0128）**：Claude Code 对一次 MCP 工具调用有 1800 秒静默上限——期间既无响应也无 progress 通知就单方面中止调用;本工具执行期间不发进度通知（spawnSync 同步阻塞,发不了）,所以 1800 秒以上的 timeout 在 CC 上必然撞墙（cloudflash 3500 秒等待实撞,server 侧命令正常结束并记账,调用方拿不到回执）。上限压到 1800 之下并留 300 秒余量（spawnSync 返回到 MCP 响应送达还有 4MB 截断、序列化、传输的时间）,与报告方"每段 ≤1500"的绕行实践一致。超限传入**按上限截断照跑,不拒收**——拒收会让已写 `timeout_sec: 3600` 的任务卡立刻报错;inputSchema describe 与本节同数并写明分段等待是正路。在执行期间发 progress 通知以撑过 1800 秒是将来的正路（要把 spawnSync 改异步 spawn,是结构性改动）,归 hopissues/0128 处置记录,不在本条
  - 人工闸不放宽：[commit] 前置 check final/confirm、confirm/ask 停问真人一律照旧——本工具只替代"载体逐条弹窗"这一层
  - 工具名 `run_approved_command`（2026-10-01 作者改,原 `run_command`——"这个名字非常容易被封":载体权限分类器按工具名判风险,`run_command` 字面即"跑任意命令";名字里带 approved 与段名《已批准命令》/错误码 APPROVAL_REQUIRED 同词根,agent 读名即知它受卡约束）。锚名 ^anc-mcp-run-command、方法名 runCommand、hoplog `command:` 块名、常量 RUN_COMMAND_* 不随改——只改对外工具名与 skill/文档
  - **工具 description 与拒绝报文自身是对 agent 的教材**（不走 /hop 的 agent 也只从这里学;被拒那一刻读的是报文）：两处同口径,必须写进授权三要素——什么任务（授权绑 run,instance_id 取快照清单）、什么核验（命令级前缀逐词相等 + hopjit 恒拒;cwd 不是授权要素,2026-10-09 撤越界闸;任务级由步骤类型定探索态/提交态）、才可以执行;以及被拒时的处置——APPROVAL_REQUIRED 是任务授权范围要不要扩,归人决定,调用方停下问人,不自己加卡、不改走载体 Bash 绕过
```

**类型约定（HopType）**：入参 `{ state_dir?: string; instance_id: string; argv: string[]; cwd?: string; timeout_sec?: number; caller_step?: string }`（state_dir 缺省 `.hopstate`,相对 server cwd;cwd 任意目录,缺省该 run 的 workspace_dir;caller_step 只写进账）;返回 `{ returncode: number; stdout: string; stderr: string; duration_ms: number; truncated: { stdout: boolean; stderr: boolean }; account_error?: string }`（account_error 只在记账失败时在场,携原报文）;错误 `{ error: { code: 'INSTANCE_NOT_FOUND'|'CORRUPT_STATE_FILE'|'APPROVAL_REQUIRED'|'COMMAND_FAILED', message } }`（快照不可读/非 JSON/非对象 persistence 一律抛 CORRUPT_STATE_FILE 前缀,本工具透传;曾多列一码 STATE_READ_FAILED,review 补测试时发现它是死分支——persistence 不会漏出别的读错,删）。两个命名常量 `RUN_COMMAND_TIMEOUT_DEFAULT_SEC = 300` / `RUN_COMMAND_TIMEOUT_MAX_SEC = 1500`（mcp-server.ts 导出,inputSchema describe 与本节数字同源——review 抓五处字面量;MAX 须恒小于 Claude Code 的 1800 秒 MCP 静默上限,测试钉这个不等式不只钉数字）。

**关键逻辑（HopSop）**：

```
run_approved_command(state_dir?, instance_id, argv, cwd?, timeout_sec?, caller_step?):
1. instDir = resolve(state_dir ?? '.hopstate', instance_id); [条件(无 state.json)] → INSTANCE_NOT_FOUND
2. spec = readSpec(instDir); st = readState(instDir)——两读同一 try：抛错 → CORRUPT_STATE_FILE 携原报文（state 提前到这里读:坏快照在授权判定之前就报,比先报 APPROVAL_REQUIRED 更诚实）; approved = spec.header.approved_commands ?? []
3. [条件(argv 空)] → APPROVAL_REQUIRED("argv 为空");[条件(argv[0] 是 hopjit 或路径尾段 hopjit)] → COMMAND_FAILED("不得执行 hopjit……写进《已批准命令》也无效")——恒拒先于匹配,否则拒绝报文会教人往卡上加 hopjit 行（真机烟测实抓）
4. [条件(不存在 p ∈ approved: p.length ≤ argv.length 且 ∀i p[i]===argv[i])] → APPROVAL_REQUIRED("命令 <argv 前三项…> 不在本任务卡《已批准命令》里。这是任务授权范围要不要扩的问题,请停下问用户：批则在卡上加一行 `- <argv 前缀>` 后重起 run,不批则这一条走载体自己的审批。不要自己把命令加进卡,不要换通道绕过")——报文与 description、/hop skill 三处同口径（2026-10-01 review 面二抓首版报文把'加卡重起'与'改走载体 Bash'并列、无'归人决定',agent 被拒时读的正是报文）;[条件(命中)] → 继续第 5 步
5. ws = st.host_context?.workspace_dir; cwdEff = cwd 缺席 ? (ws ?? server cwd) : (isAbsolute(cwd) ? cwd : resolve(ws ?? server cwd, cwd))——只做绝对化,不判越界（cwd 可以是 worktree、系统临时区等任意目录;2026-10-09 撤 CWD_OUTSIDE_WORKSPACE 闸,理由见本条「撤闸记录」）
6. timeoutSec = min(max(1, floor(timeout_sec ?? RUN_COMMAND_TIMEOUT_DEFAULT_SEC)), RUN_COMMAND_TIMEOUT_MAX_SEC); t0=now; r = runWhitelistedCommand(argv, { whitelist:[argv[0]], cwd: cwdEff, timeoutSec, maxBuffer: 4MB, label:'run_approved_command' })（抛 → COMMAND_FAILED）
7. 账（try）：[条件(st.hoplog_run_dir 在场 且 目录存在)] HopLog.resume(st.hoplog_run_dir).recordCommand({argv, cwd: cwdEff, returncode, duration_ms: now-t0, stdout_bytes, stderr_bytes, truncated, caller_step?})
        [否则] appendFile(instDir/commands.log, JSON 行 + "\n")
        [catch] account_error = 原报文——不抛,命令已执行,结果必须回给调用方
8. 返回 { returncode, stdout: 截 64KB 注明, stderr: 截 64KB 注明, duration_ms, truncated, account_error? }
```

**撤闸记录（2026-10-09 todo/0152,作者抓"这个规矩是谁定的？我可没这么定,又是把自己卡死的蠢规矩"）**：第 5 步原有第二行"cwd 须落在该 run 的 workspace 内,否则 CWD_OUTSIDE_WORKSPACE"。来源是 2026-10-01 d147fbed（todo/0132 落地批）commit message 一句"cwd 缺省 workspace_dir 且必须落在其内",没有作者原话也没有理由——agent 把"沙箱锚在工作区"的直觉套到了命令执行上。撤掉的依据三条：①命令授权的本体是第 3-4 步的 argv 前缀匹配,卡上批了 `npm run check:fast`,在哪个目录跑都是同一条命令,cwd 不是授权要素;要越权的命令改 argv 就行,不需要换 cwd;②文件面的限制另有 Config.dirs（[[exec-engine#^anc-exec-dirs-approval]]）那一套,不在这里重复发明;③这道闸拦住的全是正当用法——改仓库文件的活恒建 worktree（driver hop-skill §1 纪律,区在系统临时目录下）、测试工作面一律建在 $TMPDIR（工程约定）,2026-10-09 两批工程链实现里 check:fast / vitest / build 都在任务卡清单上却因 cwd 在 /tmp 被拒,agent 全部改走载体 Bash,run_approved_command 一次没调,hoplog command: 块零记录——比没有这条闸更差。撤后 cwd 缺省值与相对路径解析基准不变（仍是 workspace_dir）,只删越界判;`resolveRealDeep` / `isWithinDir` 在本模块不再有调用方,它们仍是 [[tools#^anc-exec-tool-path-resolve]] 的出口不动。

### 复用模式驱动工具（七件）【契约】 ^anc-mcp-reuse-driver-tools

**来由**（todo/0146,2026-10-07 作者定）：/hop 与 /hopspec 的复用模式 driver 原先每推进一步都敲一条 `hopjit` Bash 命令。载体对 Bash 的放行按命令前缀匹配,驱动命令每次参数不同（实例号、步号、`--output` 路径）,manual 模式下几乎每条都弹窗;driver 为截断长输出自加的 `| head -c 400` 又撞管道闸。改法是把这七个子命令做成 MCP 工具:载体按工具名放行一次,参数是结构化字段,没有 shell、管道、引号转义可出错。安全不靠命令白名单,靠引擎自己的把关——commit 的 body 只有引擎能执行且每句须批准一次（^anc-mcp-commit-approve）,confirm/ask 照旧停下问人。CLI 子命令保留,供 CI、脚本与载体不支持 MCP 时回退。

**工具与 CLI 子命令一一对应**：

| 工具 | 对应 CLI | 入参（均为结构化字段） | 注解 |
|---|---|---|---|
| `run` | `hopjit run <spec>` | `spec_path`(必)、`params`(可,object)、`state_dir`(可,缺省 `.hopstate`)、`workspace_dir`(可,缺省 server cwd)、`approve_dirs`(可,bool——起跑即批 Config.dirs 清单跳停点,^anc-mcp-dirs-approve)、`log_dir`/`log_level`/`max_runs`/`context_mode`(可)、`notify`(可,只认 dingtalk) | readOnly false / destructive false |
| `submit_and_fetch_next` | `hopjit submit_and_fetch_next <step>` | `step_id`(必)、`instance_id`(可)、`state_dir`(可)、`workspace_dir`(可)、七种提交形态恰好一个：`output`(object 或 `@<work_zone 内路径>` 字符串)/`answer`(同上)/`child_instance`/`failure_child`/`failure`(text 或 `@路径`)/`replan`(markdown 或 `@路径`,另可带 `proactive`/`extend_expansion`)/`tool_result`(同 output) | readOnly false / destructive false |
| `reap_and_fetch_next` | `hopjit reap_and_fetch_next <child>` | `child_instance`(必)、`status`(必,completed\|failed)、`instance_id`(可)、`state_dir`(可)、`workspace_dir`(可) | readOnly false / destructive false |
| `status` | `hopjit status` | `instance_id`(可)、`state_dir`(可)、`workspace_dir`(可) | readOnly true |
| `resume` | `hopjit resume` | 同 status | readOnly false / destructive false |
| `abort` | `hopjit abort` | `instance_id`(可)、`reason`(可)、`state_dir`(可)、`workspace_dir`(可) | readOnly false / destructive true |
| `validate` | `hopjit validate <spec>` | `spec_path`(必)、`fragment`(可,bool)、`known_vars`(可,string[])、`workspace_dir`(可) | readOnly true |

```
HopType: ReuseDriver
  # 复用模式驱动工具的实现模块 src/reuse-driver.ts:七个工具各一个函数,与 CLI 同名子命令同一引擎调用序、同一响应形态,但没有 shell
  # 约束:工具本身不调 LLM、不读独立模式配置——干活的是调用方 agent,工具只做引擎推进,所以配置缺失时七件照常可用（^anc-mcp-server-status）
  # 约束:引擎调用序与 CLI 同名子命令逐行一致（load → claimDriverChannel('cli') → 开派发门 → 回写 → advanceToCaller）。通道认领 'cli' 是有意的:七件是 CLI 的孪生协议面,同一个 run 可以在 MCP 工具与 CLI 回退之间来回切换而不撞 DRIVER_CHANNEL_MISMATCH;独立模式 run（driver_channel=mcp）不能用七件推进,反之 start_run 建的 run 也不能
  # 约束:工作区根由调用方经 ctx.workspace_dir 给定;state_dir、spec_path、`@路径` 的相对路径都按它解析;hopjit.yaml 的 commands/language/tool_servers 都按它读
  # 约束:文件参数安全规则与 CLI 同（[[hop-cli#^anc-cli-file-arg-safety]]）——`@路径` 形态的 output/answer/tool_result 必须落在本执行单元 work_zone 内,越界抛 WORK_ZONE_VIOLATION;object 形态直接当输出对象,不经 JSON 文本
  # 约束:出错一律抛 Error,报文以 `大写码:` 开头;不读 process.cwd()/process.env、不退出进程——环境值由组合根 mcp-server 经 ctx 传入（run 隔离不变量 ^anc-run-isolation）。不 import cli.ts（本文 ② 的零耦合条款）,cli.ts 自己的同名助手保留不动,两边的共享真身是引擎
  # 约束:不发通知——复用模式钉钉通知挂点（[[hop-cli#^anc-cli-notify-reuse]]）只在 CLI 出口。run 的 notify 参数照样把渠道记进快照,之后若改走 CLI 推进仍会发;MCP 推进不发,如实记为 v1 边界
  # 约束:不含 advance/debug_step/vars/tool-call/list——前两件是渐进派发与调试场景,后三件是只读查询或已有替代,仍走 CLI
  # 定层:适配层 layer 2,属本模块——它只为本模块的七件工具服务,没有独立收链,不单立模块
  Specs:
    driverRun(
      ctx % ReuseDriverContext,   # 组合根求得的工作区根与环境值
      args % yaml                 # 入参见上表 run 行:spec_path 必填,其余可选
    ) -> response % NextResponse  # 首个介入点的响应;依赖核不过时是 INIT_FAILED 错误响应（[[hop-cli#^anc-cli-response-types]]）
      # 起跑:init 实例并推进到第一个需要调用方介入的点（cli run 顶层分支同序）
      1. specAbs = resolve(ctx.workspace_dir, args.spec_path);读 spec 文本（读不到即抛）
      2. hostConfig = 由 ctx 组装（工作区根、项目 commands 与 language、ctx.api_key 占位）;args.params 里的 hop_env_* 摘入 hostConfig.hop_env（凭证形态键名抛 HOP_ENV_CREDENTIAL_REJECTED）。hop_env_* 键不论值是什么类型都从 params 摘除,但只有字符串值进 hop_env 表——数字、布尔、对象等非字符串值被丢弃,不报错也不告警（hop_env 表是字符串表,^anc-config-hop-env;start_run 的 params 级摘取与 CLI 的 extractHopEnvIntoHostConfig 同一判定）
      3. 参数校验:[条件(log_level 不是 debug|info|warn)] 抛 INVALID_ARG;[条件(max_runs 不是正整数)] 抛 INVALID_ARG;[条件(notify 在场且不是 dingtalk)] 抛 INVALID_ARG
      4. context_mode = ctx.context_mode_env 非空串时取它,否则取 args.context_mode,再否则 full（空串视同未设,与 CLI 同口径,[[prompt-assembler#^anc-exec-context-mode]]）
      5. 依赖核 runDepsGate(ctx, spec 文本, specAbs):[条件(不过)] 返回 INIT_FAILED 响应（带 missing_tools/missing_calls/hints）,不建实例
      6. engine.initExecution(spec 文本, hostConfig, {stateDir, canFanout: true, specPath: specAbs, cliAbsPath: ctx.cli_abs_path, driverChannel: 'cli', ...}):[条件(结果非 ok)] 原样返回
      7. [条件(args.approve_dirs)] 查 dirs 批准账,未批则以当前 dirs_hash 记账（^anc-mcp-dirs-approve）
      8. 打开统一派发门;[条件(args.notify 在场)] 渠道记进快照
      9. 返回 engine.advanceToCaller()

    driverSubmit(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # step_id 必填;七种提交形态恰好一个,见上表（branch 不是提交形态——选路只由引擎按 case 条件求值,[[exec-engine#^anc-exec-branch-select-internal]]）。七种形态各自的值契约:output / answer / tool_result 是 JSON 对象或 `@<work_zone 内路径>`（文件内容是 JSON）;child_instance / failure_child 是子实例号（父实例目录 calls/<子实例号>/ 必须在场,值从该目录读,调用方不传子实例的变量）;failure 是失败说明文本或 `@路径`;replan 是子步骤 markdown 或 `@路径`（另可带 proactive / extend_expansion 两个布尔）
    ) -> response % NextResponse  # 回写失败时是引擎的 CommandResponse 错误响应,成功则是下一介入点
      # 提交一个步骤的结果并推进（cli submit_and_fetch_next 同表）
      1. [条件(args 里有不认识的键——既不是七种提交字段,也不是 step_id / instance_id / state_dir / workspace_dir / proactive / extend_expansion)] 抛 INVALID_ARG,报文点名那个键并列出七种合法提交形态（MCP SDK 的 zod 对象 schema 对未知键是剥除不是拒收,直调处理器的路径又不经 zod——拒收由本函数自己做,两条路径同判;已撤的 `branch` 走的就是这一支）;modes = 七种提交字段中在场者;[条件(多于 1 个)] 抛 INVALID_STATE（与 CLI 同报文,报文列出收到的全部形态名;引擎状态不动）。"恰好一个"的另一半——一个都不给——不单独拒:落到 4.6 按"无产出的 output 提交"走,只有零输出槽的步骤能这样完成,有输出槽的步骤由引擎的产出校验拒
      2. instanceDir = resolveInstance(resolve(ctx.workspace_dir, args.state_dir ?? '.hopstate'), args.instance_id)
      3. engine = ExecutionEngine.load(instanceDir);engine.claimDriverChannel('cli');[条件(engine.getCanFanout())] 打开统一派发门
      4. 按提交形态路由:
         4.1. [条件(child_instance)] 读子实例 calls/<child>/ 的变量;[条件(子实例 committed_steps 非空)] engine.markCommitted(step_id)（子层做过不可逆动作,父 call 步骤随之退火,^anc-exec-commit-anneal）;writeResult = engine.completeCallStep(step_id, 子变量)
         4.2. [条件(failure_child)] 读子实例状态;[条件(子实例 committed_steps 非空)] engine.markCommitted(step_id);writeResult = engine.failCallStep(step_id, 子 spec id + 子实例号 + 子步骤失败原因 + 子步骤状态 + 重试史)
         4.3. [条件(failure)] writeResult = engine.failStep(step_id, 失败说明文本——`@路径` 先读文件)
         4.4. [条件(replan)] 计划文本（`@路径` 先读文件）经片段编号归一;writeResult = engine.submitReplan(step_id, 计划, proactive/extend_expansion 选项)
         4.5. [条件(tool_result)] writeResult = engine.submitToolResult(step_id, 结果值)——值不做对象检查:工具结果的形态由工具决定,字符串、数组、数字都是合法结果,journal 回放也按裸值处理（act-body-interpreter 的 tool_request 重放）
         4.6. [其他（output 或 answer,或两者都缺席）]
              4.6.1. parsed = object 形态原样;`@` 字符串先核 work_zone 再读文件 JSON.parse
              4.6.2. [条件(提交了 output 或 answer 且 parsed 不是普通对象——字符串、数字、布尔、数组、null)] 抛 INVALID_ARG,报文点名收到的类型并给出对象形态（answer 给 `{"value":"approve"}`,output 给 `{"<输出槽名>": <值>}`）;引擎状态不动。与 CLI 同一检查（[[hop-cli#^anc-cli-json-io]]）——MCP 的 inputSchema 允许字符串（`@路径` 要用）,挡不住 JSON 文本以外的非对象值,所以检查必须在这里做
              4.6.3. [条件(engine.getEscalatePending() == step_id 且提交的是 answer)] writeResult = engine.resumeFromEscalation(step_id, parsed.guidance ?? parsed.value)
              4.6.4. [其他] 返回 engine.completeAndAdvance(step_id, parsed)（幂等重发短路与 commit 的 COMMIT_BODY_ENGINE_ONLY 拒收都在它里面）
      5. [条件(writeResult.status ≠ ok)] 返回 writeResult
      6. 返回 engine.advanceToCaller()

    driverReap(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # child_instance、status 必填;instance_id、state_dir 可选
    ) -> response % NextResponse  # 收割后的下一介入点
      # 收割一个并行子实例的结局并推进（cli reap_and_fetch_next 同序,^anc-exec-parallel-reuse-protocol）
      1. [条件(status 不是 completed|failed)] 抛 INVALID_ARG
      2. engine = load 实例;claimDriverChannel('cli');打开统一派发门
      3. engine.reconcileInflight({dispatchLostPolicy: 'stale'})（^anc-exec-parallel-inflight-reconcile）
      4. engine.reapFromChildDir(child_instance, status)
      5. 返回 engine.advanceToCaller()

    driverStatus(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # instance_id、state_dir 可选
    ) -> response % StatusResponse  # 实例状态
      # 只读查询:load 实例后返回 getStatus(),不认领通道

    driverResume(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # instance_id、state_dir 可选
    ) -> response % NextResponse  # 续跑后的下一介入点
      # 崩溃恢复并推进（^anc-cli-state-load）
      1. engine = ExecutionEngine.recover(实例目录)（悬空 running 重置为 pending）;claimDriverChannel('cli')
      2. 返回 engine.advanceToCaller()

    driverAbort(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # instance_id、state_dir、reason 可选
    ) -> response % CommandResponse  # 中止结果
      # 主动中止（不可逆,快照与 hoplog 保留,^anc-cli-abort）:load 实例 → claimDriverChannel('cli') → 返回 engine.abort(reason)

    driverValidate(
      ctx % ReuseDriverContext,   # 同上
      args % yaml                 # spec_path 必填;fragment、known_vars 可选
    ) -> response % ValidateResponse  # error 与 warn/info 两桶（cli validate 同形）
      # 只读合法性校验（^anc-exec-validation）
      1. 读 spec 文本;按 fragment 选 parseFragment 或 parseSpec;[条件(解析出错)] 返回 {status: error, errors: 解析错误, warnings: []}
      2. 整份 spec 时带 doc-ref 校验上下文（工作区根与 spec 目录可读,跨目录宽容）;片段时带 knownVars
      3. 校验结果按严重度分两桶,errors 非空 → status error,否则 ok

    driverErrorOf(
      err % yaml                  # 驱动函数抛出的错误对象或任意值
    ) -> response % yaml          # { error: { code % line, message % text } }
      # 运行时错误转结构化错误:message 取错误报文原文,code 取报文开头的 `大写码:` 前缀,没有前缀时为 DRIVER_TOOL_ERROR
      # 约束:可能出现的码包括 INSTANCE_NOT_FOUND / WORK_ZONE_VIOLATION / INVALID_STATE / INVALID_ARG / DRIVER_CHANNEL_MISMATCH / CORRUPT_STATE_FILE / WORKSPACE_NOT_FOUND / HOP_ENV_CREDENTIAL_REJECTED;错误不炸 server
```

**响应形态**：七件的返回值 = CLI `--json` 模式同一 JSON 对象（NextResponse / CommandResponse / StatusResponse / ValidateResponse,[[hop-cli#^anc-cli-response-types]]）,放进 MCP text content;引擎返回的 `status:'error'` 原样返回。

**类型约定（HopSchema）**：

```
HopSchema: ReuseDriverContext
  # 驱动函数的上下文:工作区根与组合根读好的环境值
    - workspace_dir % line   # 工作区根绝对路径;mcp-server 由参数或 server cwd 求得后传入
    - cli_abs_path % line    # dist/cli.js 绝对路径——引擎把它烘焙进 call_protocol/launch_command,子实例仍经 CLI 起跑
    - home % line            # 用户主目录绝对路径——HopAnt 根（<home>/.hopjit/ants）与系统级 tool_servers 的定位基准
    - api_key % text         # HOPJIT_ANTHROPIC_API_KEY 的值,缺席为空串——复用模式不调 LLM,只为 HostConfig 必填字段占位
    - hopjit_config % line   # HOPJIT_CONFIG 的值（独立模式配置文件路径）,缺席为空串——run 的路径适配读它,与 CLI 同口径
    - context_mode_env % line  # HOPJIT_CONTEXT_MODE 的值,缺席为空串——与 CLI 同优先序:环境变量非空时压过参数 context_mode,空串视同未设
```

**为什么后四项由 mcp-server 传入**：run 隔离不变量（ARCHITECTURE ^anc-run-isolation）只允许组合根（cli.ts / mcp-server.ts）读 process.env、process.cwd,机检 `check-process-state` 守。reuse-driver.ts 不是组合根,CLI 版这几处读环境的地方在这里一律改由 mcp-server 在 handler 里读一次、经上下文传进来。

**MCP 工具 handler（七件同形,住 mcp-server.ts 组合根）**：

```
driverContext(workspace_dir?):
1. ws = workspace_dir 在场 ? resolve(server cwd, workspace_dir) : server cwd
2. [条件(workspace_dir 在场 且 ws 不存在)] 抛 WORKSPACE_NOT_FOUND
3. 返回 { workspace_dir: ws, cli_abs_path: 本文件同目录的 cli.js, home: homedir(), api_key: 环境变量 HOPJIT_ANTHROPIC_API_KEY ?? '', hopjit_config: 环境变量 HOPJIT_CONFIG ?? '', context_mode_env: 环境变量 HOPJIT_CONTEXT_MODE ?? '' }

driverCall(workspace_dir, driverXxx):
1. try { 返回 jsonContent(await driverXxx(driverContext(workspace_dir), args)) }
2. catch(e) { 返回 jsonContent(driverErrorOf(e)) }——错误体带 isError 标记
```

### approve_commit【契约】 ^anc-mcp-commit-approve

**来由**：复用驱动工具与 run_approved_command 都由 setup 自动放行,载体不再逐条弹窗。不可逆动作需要一道闸——这道闸放在 `[commit]` 步骤上:每个 commit 步骤在当前 body 下第一次执行前先做安全分析——可逆或低危的动作（新建、追加、移动、写入前已留存旧版本的覆盖与删除）打安全标记直接执行,以后不再问;有动作销毁内容且找不回、运行命令、发通知或调后果不明的外部工具时停下来转人工（引擎侧语义权威 [[exec-engine#^anc-exec-commit-approval]];2026-10-08 作者定"主要出自于安全性判断，而不是正确性判断"）。**转人工时,人的选择发生在对话里**:driver 用不懂代码的人也读得懂的话把分析结论（每个动作的后果、建议）讲给用户,代码在用户要求时才贴,用载体的提问工具（Claude Code 的 AskUserQuestion、opencode 的 question 工具,没有提问工具的载体用普通对话消息）给三个选项——只批准这一次 / 这一步以后都通过 / 不批准;用户选前两项后 driver 调本工具把批准记进账。本工具只是记账入口,和其他 hopjit 工具一样由 setup 放行,调用不弹窗。

**为什么不用载体弹窗当批准闸（2026-10-07 作者纠正,todo/0146 真机探针后）**：v0.21.0 让 setup 唯独不放行本工具、v0.21.1 又加 Claude Code 的强制确认标记,想让"载体对本工具的弹窗"充当人批准的那一下。作者指出这条路走错了:

- 需要人审批时就在对话里问,这是 driver 本来就有的能力,confirm/ask 停点一直这么做;
- Claude Code 弹窗频繁,用户对弹窗形成"点允许"的习惯动作,弹窗里点过去不等于看过、想过;
- 弹窗只显示工具名与参数（instance_id、step_id、fingerprint、scope）,看不到 body 原文,不是让人判断的界面;
- 弹窗当闸还会制造两个实撞问题:driver 已在对话里问过一遍,弹窗又问一遍,同一件事批两次;用户在弹窗上点"以后不再询问",闸被一次点击永久撤掉。

改为对话里问之后,对话里那一问是唯一的批准动作,弹窗与放行设置不再承担安全职责。信任口径与 confirm/ask 相同:复用模式下用户的回答经 agent 转交,引擎分辨不出真人是否答过,选复用模式就是信任宿主 agent（todo/0146 已拍口径）。

```
HopType: McpCommitApprove
  # approve_commit 工具的实现（HopjitMcpCore.approveCommit 方法）:按人的选择记批准——scope=once 记本次运行里这一步的当前 body（指纹不变时 for-each 后续轮、续跑不再停;下一次运行重新问）,scope=task 记这一步的当前 body 以后都通过（跨运行有效,body 一改就重新分析）
  # 约束:复用模式 run 与独立模式 run 都用它——前者是 run/submit 返回 pause_reason=commit 的停点,后者是 run_status 返回的 paused 载荷
  # 约束:只读写批准账,不推进 run。复用模式批准后调用方再调 resume（或 submit 以外的任何推进入口）续跑;独立模式批准后调 resume_run（step_id 同,answer 任意）
  # 约束:账的位置与比对规则归引擎（engine.approveCommit,[[exec-engine#^anc-exec-commit-approval]]）——指纹对不上 → COMMIT_NOT_APPROVED 报文带当前指纹;已批准 → ok 且 already_approved:true;该步骤不是带 body 的 commit → INVALID_STATE;scope 不是 once/task → INVALID_ARG（入口校验,不进引擎）
  # 约束:加载引擎走 ExecutionEngine.load（不认领通道、不改状态,两种模式的 run 都可批）;本进程注册表里正停着的独立模式 run 用其内存引擎,避免两份引擎对象
  # 约束:独立模式 parallel 子实例停在 commit 卡上（run_status 的 paused_queue 里那张卡带 child_instance）时传 child_instance——停点属于子实例:子实例跑的是被调 spec,批准账按子实例的 spec 路径与步骤号记,本次运行的 run_id 与当前 body 也要从子实例的引擎上取,父引擎上找不到这一步,必须在子实例引擎上批。子实例引擎的取法:本进程待答队列里那张卡持有的内存引擎优先;队列里没有（server 重启后）才从 <实例目录>/parallel/<child_instance>（不在场再试 calls/<child_instance>）load。内存引擎在场时不许另外 load 一份来批——load 出来的引擎落盘会推进写入序号,内存那份续跑落盘时撞 STATE_STALE
  # 约束:复用模式的子实例由独立 worker 进程推进,停点载荷里的 instance_id 与 state_dir（<父实例目录>/parallel）就是子实例本身,照停点载荷原样传即可,不用 child_instance
  # 约束:workspace_dir 与七件驱动工具同一规则（复用 driverContext 的解析与存在性检查）——显式传了但目录不存在报 WORKSPACE_NOT_FOUND,不让它落成 INSTANCE_NOT_FOUND 之类误导报文
  # 约束:注解 readOnlyHint false / destructiveHint false / idempotentHint true——它不执行不可逆动作,只记一条批准;由 setup 放行（在 HOPJIT_ALLOWED_TOOLS 里）,tools/list 条目不带任何强制确认标记——人批准在对话里完成,工具调用本身不需要再确认
  Specs:
    approveCommit(
      instance_id % line,       # run 的实例 id
      step_id % line,           # 停下来的 commit 步骤号（来自停点载荷 step_id）
      fingerprint % line,       # 停点载荷 context.fingerprint——body 的指纹,证明批准的是此刻这份 body,body 改了则对不上
      scope % line,             # once（只批准这一次,本次运行内有效）或 task（这一步以后都通过）——取自用户在三选项里的选择
      state_dir % line?,        # 缺省 .hopstate,相对路径按工作区根解析
      workspace_dir % line?,    # 缺省 server cwd;显式传的须是已存在目录
      child_instance % line?    # 独立模式 parallel 子实例的 commit 卡:paused_queue 里那张卡的 child_instance;缺省=批顶层实例的 commit
    ) -> response % CommitApproveResponse  # ok 支 {status: ok, step_id, fingerprint, scope, already_approved?, store_path?};错误转成 { error: { code, message } }（[[hop-cli#^anc-cli-commit-approve-response]]）
      0. [条件(scope 不是 once 也不是 task)] 返回 { error: { code: INVALID_ARG, message: "scope 只能是 once 或 task" } }
      1. ws = driverContext(workspace_dir).workspace_dir   # 目录不存在 → 抛 WORKSPACE_NOT_FOUND
      2. instanceDir = resolveInstance(resolve(ws, state_dir ?? '.hopstate'), instance_id)   # 找不到 → 抛 INSTANCE_NOT_FOUND
      3. [条件(child_instance 缺省)] engine = (注册表里 run_id==instance_id 的 entry 的内存引擎) ?? ExecutionEngine.load(instanceDir)   # 快照坏 → 抛 CORRUPT_STATE_FILE
         [否则] engine = (注册表 entry 的待答队列里 child_instance 那张卡的内存引擎) ?? ExecutionEngine.load(<instanceDir>/parallel/<child_instance>,不在场则 calls/<child_instance>)   # 两处都不在场 → 抛 INSTANCE_NOT_FOUND
      4. r = engine.approveCommit(step_id, fingerprint, scope)
      5. [条件(r.status == error)] 返回 { error: { code: r.code, message: r.message } }
      6. 返回 r
      7. [catch(第 1-3 步抛错)] 返回 driverErrorOf(错误)——报文前缀码成为 code,结构化返回不炸 server
```

**调用方呈现协议（driver 侧,三载体同一协议）**：

停点只在 body 里有需要人确认的动作时出现——全部动作安全的 commit 引擎直接执行,driver 看不到停点,也不需要做任何事。

1. 停点载荷 `pause_reason: commit` 到达后,先用普通文本消息、用不懂代码的人也读得懂的话讲 `presented_data.context.analysis`:`summary`（这一步整体在做什么）、`actions` 里 verdict 为 human 的每个动作的 `consequence`（做了什么、能不能找回、影响到哪里）、`recommendation`（建议）。verdict 为 safe 的动作一句话带过。`analysis.source` 为 template 表示本宿主没有分析模型或分析出错,后果说明是固定模板,照实告诉用户。**不先贴代码**——`context.body` 原文在用户要求看代码时再完整贴出（代码块）;
2. 用载体的提问工具给出 `presented_data.response_options` 的三个选项（Claude Code 用 AskUserQuestion;opencode 用 question 工具;Codex 与其他没有提问工具的载体用普通对话消息列出三项,等用户回复）。这一问就是批准动作;
3. 用户选"只批准这一次"或"这一步以后都通过" → 调本工具,`scope` 取所选项的 value（once / task）,`fingerprint` 取 `context.fingerprint`,卡来自 run_status 的 paused_queue 时把那张卡的 `child_instance` 一并传上（工具不可用时用 CLI 子命令 `hopjit approve_commit`,[[hop-cli#^anc-cli-approve-commit]]）,再续跑（复用模式 `resume`,独立模式 `resume_run`）;
4. 用户选"不批准" → 不调本工具,告诉用户这一步没执行,按用户意思改卡重跑或放弃（复用模式 `abort`,独立模式 `stop_run`）;
5. driver 不得替用户回答这一问,不得自己判断这一步安全而调本工具——安全放行的判断已经由引擎与分析模型做过,转到人这里就只认人的选择。

返回值类型 CommitApproveResponse 的字段定义在 [[hop-cli#^anc-cli-commit-approve-response]]（CLI 与 MCP 同一份）;错误 `{ error: { code: 'COMMIT_NOT_APPROVED'|'INVALID_STATE'|'INVALID_ARG'|'INSTANCE_NOT_FOUND'|'CORRUPT_STATE_FILE'|'WORKSPACE_NOT_FOUND', message } }`。

**COMMIT_NOT_APPROVED 报文同源**：独立模式里这条报文有两个产生点——resume_run 的同步预检（本模块）与 dispatcher.resume 的 commit 分支（子实例与嵌套 call 路径,[[step-dispatcher#^anc-exec-resume-semantics]]）。两处调用引擎模块导出的同一个报文函数 `commitNotApprovedMessage(step_id, fingerprint, instance_id, child_instance?)`,报文恒含三件:先用大白话把安全分析的结论讲给用户并在对话里给三个选项、用户选批准后调 approve_commit 的完整参数（含 instance_id、fingerprint 与 scope 的两个取值,子实例卡另含 child_instance）、再 resume_run。子实例卡的拒收由子实例的 dispatcher 产生,它只知道子实例自己的 id;父 dispatcher 的待答队列路由收到 COMMIT_NOT_APPROVED 时用父实例 id 与 child_instance 重新生成报文,保证报文里的参数照抄即可用。报文本身就是 driver 协议的一部分——agent 被拒那一刻读的是报文,两处措辞不一致时照旧报文做的 agent 会跳过问人直接批准。

### approve_dirs【契约】 ^anc-mcp-dirs-approve

**来由**：spec 在 `Config.dirs` 声明的 workspace 之外的目录,第一次跑之前要有人看过清单并批准一次（引擎侧语义权威 [[exec-engine#^anc-exec-dirs-grant]]——与 commit 批准同模子：按 spec 路径 + 展开后清单哈希记账,清单不变不再问）。**人批准由 driver 在对话里问**（与 approve_commit 同模型,2026-10-07 作者纠正"需要审批的时候在对话里问"）：driver 先把 `presented_data.context.dirs` 逐条（路径 + 只读/读写）呈给用户、问同不同意,用户明确同意后才调本工具记账;本工具和其他 hopjit 工具一样进放行清单,载体弹窗不当批准闸。

```
HopType: McpDirsApprove
  Specs:
    approve_dirs(
      instance_id % line,       # 停在 pause_reason=dirs 的实例
      dirs_hash % line,         # 停点载荷里的 dirs_hash,须与当前一致
      state_dir % line?,        # 缺省 .hopstate,相对路径按工作区根解析;run 以 workspace_dir 启动时传 start_run / run 返回的绝对路径
      workspace_dir % line?     # 缺省 server cwd;显式传的须是已存在目录
    ) -> response % yaml        # {status: ok, dirs_hash, store_path} | {status: ok, already_approved: true} | 错误 { error: { code: DIRS_NOT_APPROVED | INVALID_STATE | INSTANCE_NOT_FOUND | CORRUPT_STATE_FILE | WORKSPACE_NOT_FOUND, message } }
      # 约束:workspace_dir 与 approve_commit、七件驱动工具同一规则——显式传了但目录不存在报 WORKSPACE_NOT_FOUND
      0. ws = driverContext(workspace_dir).workspace_dir（目录不存在 → 抛 WORKSPACE_NOT_FOUND）;后续抛错一律经 driverErrorOf 转结构化错误
      1. 按 resolve(ws, state_dir) + instance_id 加载引擎（不认领驱动通道——两种通道的 run 都可批）;注册表里正停着的独立模式 run 用其内存引擎
      2. 调 engine.approveDirs(dirs_hash);哈希不符 DIRS_NOT_APPROVED（报文带当前哈希与清单）;实例没有 workspace 外目录 INVALID_STATE
      3. 只写批准账（引擎 persist 并删 paused 卡）,不推进;调用方随后 `resume` 续跑

调用方呈现协议与 approve_commit 五条同款（[[#^anc-mcp-commit-approve]]）：先把 `presented_data.context.dirs` 逐条（路径 + 只读/读写）贴给用户、一句话说清"读写的那几个 commit 步骤会往里写文件",用载体提问工具问同不同意——这一问就是批准,每份清单只问一次;同意 → 调本工具再 `resume`;**不同意 → 不调本工具,告诉用户活没开始,按用户意思改卡（去掉或换目录）重跑或 `abort`**;**driver 不得替用户回答,不得在用户没明确同意时调本工具**。
```

**独立模式没有停点**（server 自己的模型在跑,没有人可问）：`start_run` 的 `dirs` 参数是唯一授权面——调用方显式传 `dirs: {read?: [绝对路径], readwrite?: [绝对路径]}` 即视为已批;引擎与 spec 声明展开后的清单对账：spec 声明了而调用方没传的 → INIT_FAILED 列缺的;调用方传了而 spec 没声明的 → 不授（照 workspace 规则,响应 `warnings` 提示）。多传目录的拒绝项从 init 返回的 warnings 里按 warning 的 `rule` 字段识别（引擎 Config.dirs 对账产生的 warning 都是 rule=CONFIG,[[exec-engine#^anc-exec-dirs-grant]]）,不按报文文字匹配。对上的直接记账为已批。复用驱动工具 `run` 加 `approve_dirs % bool`（与 CLI `--approve-dirs` 同义：起跑即记账跳停点,写参数的人就是批准的人）。

### 管理工具面（八件）【契约】 ^anc-mcp-admin-tools

**来由**（todo/0154,2026-10-10 作者抓"为什么这个过程中你都用 bash 而不是 mcp approved command？hopjit 本身不应该进入沙盒配置直通么？hopjit 都不应该拿出来讨论",拍 a 案）：README 第四例"查天气 → 提纯 → 封成 HopAnt"三句话里,前两句全程走 hopjit 的 MCP 工具零弹窗,第三句落到载体 Bash——skill 写的实现是 `hopjit --json ant pack`,接着 `ant install` 要写 `~/.hopjit/ants/`,撞 Claude Code 的 Bash 文件沙盒,agent 只能关沙盒重跑。复盘三层：①`run_approved_command` 对 `hopjit` 恒拒（防自嵌套驱动,^anc-mcp-run-command 第 3 步）,这对驱动命令是对的,但把 `doctor / ant *` 也挡在外面了;②这几个管理命令没有自己的 MCP 工具——注册面只有驱动七件、批准三件、独立模式五件、server_status,管理面是零;③hop-skill §0"不为此添加 Bash 放行规则"一刀切,把参数固定、幂等、只写 hop 自己目录的管理命令也留在了弹窗面上。三层叠加的结果：hop 自己的事（体检 / 装 / 封 / 分享 HopAnt）反而是整个 /hop 体验里唯一走载体审批的部分。作者定的修法是补 MCP 工具,不加 `Bash(hopjit *)` 放行（命令行回退面已有 USAGE 命令行手册覆盖）。

**八件与 CLI 子命令一一对应**（参数与 CLI 同名,下划线连写;响应与 CLI `--json` 同一份 JSON）：

| 工具 | 对应 CLI | 入参（均为结构化字段） | 注解 |
|---|---|---|---|
| `doctor` | `hopjit doctor` | `workspace_dir`(可,缺省 server cwd——CC 的 `.mcp.json` 与 `settings.local.json` 是项目级,按它找) | readOnly true |
| `ant_list` | `hopjit ant list` | `workspace_dir`(可——项目级根 `<workspace_dir>/hop_tasks/ants` 按它找) | readOnly true。两级合并,每项带 `scope`（project \| user）,项目级在前、同 id 两条都在 |
| `ant_install` | `hopjit ant install <dir>` | `dir`(必,单 HopAnt 目录或 HopAnt 包根;相对路径按 workspace_dir 解析)、`scope`(可,user \| project,缺省 user——装进 `~/.hopjit/ants/` 还是 `<workspace_dir>/hop_tasks/ants/`,[[hopant]] 决策 1)、`dry_run`(可,bool)、`workspace_dir`(可) | readOnly false / destructive false / idempotent false（撞 id 只在目标级内判,整单拒,不覆盖） |
| `ant_adapt` | `hopjit ant adapt <id>` | `id`(必,两级查找项目级先)、`workspace_dir`(可——项目级 HopAnt 根与项目级 `hopjit.yaml` 的注册面都按它找) | readOnly false（全绿写适配戳）/ destructive false / idempotent true |
| `ant_remove` | `hopjit ant remove <id>` | `id`(必)、`scope`(可,user \| project——缺省删两级查找命中的那一个)、`keep_store`(可,bool)、`workspace_dir`(可) | readOnly false / destructive true |
| `ant_bootstrap` | `hopjit ant bootstrap <id>` | `id`(必,两级查找)、`dry_run`(可,bool)、`workspace_dir`(可) | readOnly false / destructive false / openWorld true（跑 HopAnt 自带脚本,可装依赖可联网） |
| `ant_pack` | `hopjit ant pack <spec>` | `spec_path`(必,相对 workspace_dir)、`out`(可,缺省 `<workspace_dir>/ants`)、`id`(可)、`assets`(可,string[])、`workspace_dir`(可) | readOnly false / destructive false / idempotent false（不覆盖已有目标） |
| `ant_share` | `hopjit ant share <id>…` | `ids`(必,string[] 非空,每个两级查找项目级先——本项目总结的 HopAnt 不须先装用户级)、`out`(可,缺省 workspace_dir)、`name`(可)、`pkg_version`(可,缺省 0.1.0)、`owner`(可)、`yes`(可,bool)、`workspace_dir`(可) | readOnly false / destructive false / idempotent false |

**`setup` 不进**：它改的是载体自己的配置文件（`.mcp.json` / `settings.local.json` / `config.toml` / opencode 配置）和放行清单,且 MCP server 本身就是 setup 装出来的——server 还没注册之前没有工具可调,注册之后再改注册是自己动自己的地基。由终端跑一次是对的,USAGE 对应表那一行保持"无（终端命令）"。

**为什么是 MCP 工具而不是 Bash 放行**：两条实益。①`ant_install` / `ant_share` 写 `~/.hopjit/` 由 server 进程做,不受载体 Bash 文件沙盒约束（home 不在 Claude Code 的写入白名单里,Bash 形态必撞）;②工具名放行一次、参数结构化,与驱动七件同一套零弹窗体验,用户不需要知道有 `hopjit` 这个命令。`run_approved_command` 对 `hopjit` 的恒拒不动——它防的是 agent 用命令通道自嵌套驱动引擎,仍然对。

```
HopType: HopAdmin
  # hop 自身管理面的业务体文件 src/hop-admin.ts：doctor 八问与 ant 七动作各一个函数,外加它们共用的载体探测函数（resolveCarrierHome / detectCarriers / readMcpRegistration / mcpHandshake / learnStandaloneEntry 等,原在 cli.ts 里）
  # 定层:适配层 layer 2,属 hop-cli 模块（业务是 CLI 自己的安装体检与 HopAnt 生命周期承接,[[hop-cli#^anc-cli-doctor]] / [[hop-cli#^anc-cli-ant]] 是语义权威,本节只定 MCP 面）;是 hop-cli 模块的出口文件,登记在 hop-cli 设计的「②b 对外接口清单」节（锚名以 -exports 结尾,此处不写全名——anchor-audit 的出口表解析把任何该形态的出现都当节起点,写了会把 hop-cli 的出口表读成空）。mcp-server 经它取业务体,仍不 import cli.ts
  # 约束:不读 process.env / process.cwd / homedir / hostname / userInfo / process.execPath——机器侧事实全部由组合根（cli.ts 或 mcp-server.ts）读一次装进 AdminContext 传入（run 隔离不变量 ^anc-run-isolation 的组合根条款;与 reuse-driver 的 ReuseDriverContext 同一做法）。路径分隔符用 node:path 的 delimiter,不读 process.platform。**唯一例外：git 用户名**（归属标识缺省值的一项）在 hop-admin 内部起 `git config user.name` 子进程现读,但 **cwd 恒传 ctx.cwd**——不让它继承进程 cwd（MCP 下 server cwd 不是工作区,2026-10-10 review 抓）;不装进 ctx 的理由：只在首次算归属标识时用一次、config.yaml 落了 owner_id 后不再调,不值得每条 CLI 命令都 spawn 一次 git
  # 约束:出错一律抛 Error,报文以 `大写码:` 开头（hopant 的十一个码 / PACK_ERROR / HOPANT_NOT_FOUND）;不退出进程、不写 stdout——退出码与 stdout/stderr 分流是 cli.ts 薄壳的事
  # 约束:两个组合根各自的薄壳形态——cli.ts 的 doctor / ant 子命令 = 读进程状态组 AdminContext → 调本文件一个函数 → output() / errorExit() / process.exitCode;mcp-server.ts 的八个 handler = adminContext(workspace_dir) → 调同一个函数 → jsonContent()。两边不含任何业务判定
  # 约束:setup 命令仍住 cli.ts,它用到的探测函数从本文件 import;tests 既有的 `from '../src/cli.js'` 导入面经 cli.ts 转发（`export { … } from './hop-admin.js'`）保持可达
  Specs:
    runDoctor(
      ctx % AdminContext,      # 机器侧事实
      opts % yaml              # {server_js? % line, handshake? % 函数} 测试注入;缺省 server_js = 本文件同目录的 mcp-server.js
    ) -> report % DoctorReport # 八问报告（[[hop-cli#^anc-cli-doctor]] 九步 HopSop 原样,只是 cwd / env / home 从 ctx 取）
    antList(ctx % AdminContext) -> response % AntResponse
    antInstall(ctx % AdminContext, dir % line, dry_run % bool, scope % line) -> response % AntResponse   # scope = user | project,落 ctx.roots[scope]
    antAdapt(ctx % AdminContext, id % line) -> response % AntResponse          # report.ok 为 false 时照常返回（退出码 1 由 cli.ts 置;MCP 调用方读 report.ok）
    antRemove(ctx % AdminContext, id % line, keep_store % bool, scope? % line) -> response % AntResponse
    antBootstrap(ctx % AdminContext, id % line, dry_run % bool) -> response % AntResponse   # 脚本经 ctx.exec_path 起,env 用 ctx.env
    antPack(ctx % AdminContext, spec_path % line, opts % yaml) -> response % AntResponse    # opts = {out?, id?, assets?};spec 不存在抛 PACK_ERROR
    antShare(ctx % AdminContext, ids % [line], opts % yaml) -> response % AntResponse       # opts = {out?, name?, pkg_version?, owner?, yes?};归属标识四态照 [[hop-cli#^anc-cli-ant]]
```

```
HopSchema: AdminContext
  # 管理面函数的机器侧事实,组合根每次调用现读后传入
    - home % line           # 用户主目录绝对路径——HopAnt 根、~/.hopjit/config.yaml、载体 home 的基准
    - cwd % line            # 工作区根绝对路径——CC 项目级配置文件（.mcp.json / .claude/settings*.json / hopjit.yaml）与相对路径参数的解析基准;MCP 侧 = workspace_dir 参数或 server cwd
    - env % yaml            # 环境变量只读视图（CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME 定载体 home;PATH 给握手与 adapt;ANTHROPIC_* 给 learnStandaloneEntry;api_key_env 的在场判定;HOPJIT_CONFIG 定配置路径）
    - exec_path % line      # node 可执行文件路径——握手子进程与 ant bootstrap 脚本都用它起
    - login % line          # 登录名（os.userInfo().username,取不到为空串）——归属标识缺省值的一项
    - hostname % line       # 主机名——归属标识缺省值的一项
    - roots % AntRoots      # 两级 HopAnt 根 antRoots(home, cwd)——项目级 `<cwd>/hop_tasks/ants`、用户级 `<home>/.hopjit/ants`（[[hopant#^anc-hopant-home]];2026-10-10 两级根）
```

**MCP 工具 handler（八件同形,住 mcp-server.ts 组合根）**：

```
adminContext(workspace_dir?):
1. cwd = workspace_dir 在场 ? resolve(server cwd, workspace_dir) : server cwd;[条件(workspace_dir 在场 且 cwd 不存在)] 抛 WORKSPACE_NOT_FOUND
2. 返回 { home: homedir(), cwd, env: process.env, exec_path: process.execPath, login: userInfo().username（取不到空串）, hostname: hostname(), roots: antRoots(homedir(), cwd) }

adminCall(workspace_dir, fn):
1. try { 返回 jsonContent(fn(adminContext(workspace_dir))) }
2. catch(e) { 返回 jsonContent(driverErrorOf(e)) }——错误体带 isError 标记;码取报文 `大写码:` 前缀（HOPANT_* / PACK_ERROR / WORKSPACE_NOT_FOUND）,没有前缀落 DRIVER_TOOL_ERROR
```

**放行与 opencode 工具门**：八件全部进 `HOPJIT_ALLOWED_TOOLS`（setup 写进 CC 放行,[[hop-cli#^anc-cli-install-skill-permission]]）;`OPENCODE_DISABLED_TOOLS` 不动——管理面两种模式共用,opencode 的求差口径补"管理八件"进复用模式要用的件（[[hop-cli#^anc-cli-opencode-tools-gate]]）。

**driver 接线**：三载体 hop-skill §0 的"不为此添加 Bash 放行规则"改为"驱动命令不放 Bash;hop 自己的管理动作（体检 / HopAnt 的查装适配封装分享）走 hopjit 的 MCP 工具 `doctor` / `ant_*`,工具不可用时按 USAGE 命令行手册回退";§0 排障分支 `hopjit --json doctor` 改调 `doctor` 工具;HopAnt 段 `ant list` / `ant adapt` 改调 `ant_list` / `ant_adapt`;§6 封装 / 分享段改调 `ant_pack` / `ant_share`,返回体字段名不变。命令行等价写在各处括号里作回退。USAGE 对应表 HopAnt 行与体检行的"对应 MCP 工具"列由"无（终端命令）"改为工具名。

- 测试面：mcp-server.test 注册面名单与 `HOPJIT_ALLOWED_TOOLS` 恰等断言随之扩;新组"管理工具面"在假 HOME 下走 `ant_pack → ant_install → ant_adapt → ant_list → ant_remove` 一条链（正）,`ant_install` 撞 id / `ant_adapt` 不存在的 id / `ant_pack` spec 不存在 / 不存在的 workspace_dir 各返回结构化错误且 isError（反）,`doctor` 返回 DoctorReport 形态且 items 八问 id 齐;cli.test 的 EXPECTED_ALLOW 写死名单扩八件;cli.test 既有 doctor / setup 用例不改断言——证明搬家后行为同。

### 配置能力状态与 server_status【契约】 ^anc-mcp-server-status

**来由**：驱动工具改走 MCP 后,server 起不来就等于 /hop 不能驱动。旧行为是配置文件缺失、providers 为空、配置非法、凭证环境变量缺失时 fail-fast 退出（原核心要求 3）——这些问题只影响独立模式（server 自己调 LLM 才需要 provider 与 key）,却拖垮了复用模式。改为:serve() 在任何配置状态下都启动,配置问题记为能力状态,只拦独立模式的入口。

```
HopType: ServerCapabilityStatus
  # HopjitMcpCore 里管独立模式能力状态的部分:配置加载的结果、独立模式入口的拦截、对外报告
  # 约束:不依赖 config 的照常可用——七件驱动工具、run_approved_command、approve_commit、approve_dirs、run_status（快照兜底路径）、list_runs、stop_run、server_status
  # 约束:server 永不改写 ~/.hopjit/config.yaml——修法只告诉人改什么
  Fields:
    - config % StandaloneConfig | null   # 启动时加载并预检通过的独立模式配置;null=独立模式不可用
    - configError % ConfigError | null   # 不可用的原因与修法;config 非 null 时为 null
    - configPath % line                  # 实际读取的配置路径:HOPJIT_CONFIG 非空时取它,否则 ~/.hopjit/config.yaml
  Specs:
    standaloneUnavailable() -> err % yaml | null   # config 非 null 时为 null;否则 { error: { code: STANDALONE_UNAVAILABLE, message, reason, fix } },reason/fix 取自 ConfigError
      # 独立模式入口的能力闸。依赖 config 的三个调用点:start_run 第 0 步;resumeRun 在取到注册项之后（含 restoreRun 恢复出来的）;restoreRun 构造 Dispatcher 之前
      # 约束:message 写明"独立模式不可用:<reason>——复用模式驱动工具不受影响";configError 缺席时用缺省原因"独立模式配置未加载"与配置文件缺失那一类的修法
    serverStatus(
      tools % [line]            # 本 server 注册的全部工具名（buildServer 装配后取）
    ) -> status % ServerStatus  # 版本、独立模式能力状态、工具清单
      # server_status 工具的本体,只读
```

**serve 配置加载（HopSop）**：

```
serve 配置加载:
1. configPath = 环境变量 HOPJIT_CONFIG 非空 ? 它 : ~/.hopjit/config.yaml
2. try:
   2.1. config = loadStandaloneConfig(HOPJIT_CONFIG 非空 ? 它 : 缺省路径)
   2.2. preflightProviderKeys(config)——逐 provider 解引用 api_key_env,任一缺失即抛 STANDALONE_KEY_MISSING
   2.3. configError = null
3. catch(e):config = null;configError = classifyConfigError(e 的报文)
3a. [条件(config 不为 null)] 注册 commit 安全分析函数:provider = resolveCommitAnalyzerProvider(config);ExecutionEngine.setCommitAnalyzer(makeCommitAnalyzer(provider))（[[step-dispatcher#^anc-exec-commit-analyzer]]）;config 为 null 时不注册——引擎能判定全部安全的 commit 照常放行,其余按固定模板转人工
4. core = new HopjitMcpCore(config, configError, configPath);装配 server 并连 stdio transport——配置状态不影响启动
5. 启动日志一行:可用时报默认 provider;不可用时报"独立模式不可用:<reason>"
```

**resolveCommitAnalyzerProvider（HopSop）**——commit 安全分析用哪个模型,可测纯函数:

```
resolveCommitAnalyzerProvider(
  config % StandaloneConfig,  # 已加载并通过加载期跨节引用核（validateMergedRefs）的独立模式配置
) -> provider % CommitAnalyzerProvider  # 分析用的服务连接与模型名
1. rule = config.routing_rules 里 step_type == commit 的那条
2. ref = rule ? parseModelRef(rule.model) : resolveStandaloneDefaultModel(config)   # service_id 为 default 时取第一个 provider
3. p = config.providers 里 service_id 与 ref.service_id 大小写不敏感相等的那个
  3.1. [条件(p 不存在)] 抛 STANDALONE_CONFIG_INVALID——加载期 validateMergedRefs 已核过 routing_rules 与 default_model 引用的 service 都在 providers 里,正常走不到这一支;这一行是防线,保证配置绕过加载核时启动报配置错而不是空指针崩溃
4. 返回 {service_id: p.service_id, protocol: p.protocol, base_url: p.base_url, api_key: process.env[p.api_key_env], auth: p.auth, model: ref.model}
```

- 分析模型跟着 commit 的路由走:作者给 commit 步骤配了专门的模型,分析这一步也用它;没配就用默认模型。
- 凭证缺失的情况到不了这里——第 2.2 步 preflightProviderKeys 已经把缺 key 的配置判成 configError。
- 命令行宿主（hop-cli）不加载独立模式配置,不注册分析函数:引擎能判定全部安全的 commit 照常放行,其余按固定模板转人工（[[hop-cli#^anc-cli-approve-commit]]）。

**classifyConfigError（HopSop）**——配置报文分四类给修法,可测纯函数:

```
classifyConfigError(message) -> ConfigError:
1. [条件(报文以 STANDALONE_CONFIG_MISSING_PROVIDERS 开头,或含"缺 providers[]")] 返回 {reason: message, fix: "在 providers 下至少配一个 provider"}
2. [条件(报文以 STANDALONE_CONFIG_MISSING 开头)] 返回 {reason: message, fix: "创建 ~/.hopjit/config.yaml（只写 api_key_env 名,不写 key）,或设 HOPJIT_CONFIG 指向配置文件"}
3. [条件(报文以 STANDALONE_KEY_MISSING 开头)] 从报文取"环境变量 <名> 未设置"里的变量名（取不到用"对应的环境变量"）;返回 {reason: message, fix: "在启动 server 的环境里导出 <变量名>,然后重开会话"}
4. [其他（文法错、明文 api_key 等）] 返回 {reason: message, fix: "按报文改 config.yaml;明文 key 改用 api_key_env"}
```

第 1 步必须排在第 2 步之前:providers 缺失的报文前缀 STANDALONE_CONFIG_MISSING_PROVIDERS 也以 STANDALONE_CONFIG_MISSING 开头,顺序反了会把"providers 为空"误报成"配置文件不存在"。

**server_status 工具**：无入参。返回

```
HopSchema: ServerStatus
  # server_status 工具的返回值
    - version % line                  # 包版本;读不到为 unknown
    - standalone % StandaloneStatus   # 独立模式能力状态
    - reuse_tools_available % bool    # 恒 true——七件驱动工具不依赖配置
    - tools % [line]                  # 本 server 注册的全部工具名

HopSchema: StandaloneStatus
  # 独立模式是否可用,不可用时带原因与修法
    - available % bool        # config 加载并预检通过为 true
    - reason % text?          # 不可用的原因（配置报文原文）;available 为 true 时缺席
    - fix % text?             # 修法,四类之一（见 classifyConfigError）;available 为 true 时缺席
    - config_path % line      # 实际读取的配置路径（HOPJIT_CONFIG 或 ~/.hopjit/config.yaml）

HopSchema: ConfigError
  # 独立模式不可用的原因与修法;STANDALONE_UNAVAILABLE 错误体的 reason/fix 两字段与 StandaloneStatus 的同名字段都取自它
    - reason % text           # 配置加载或预检抛出的报文原文
    - fix % text              # 按原因分四类给的修法
```

注解 readOnlyHint true。setup 放行它:/hop 分派节用它判断 server 是否起来、独立模式是否可用（[[hop-cli#^anc-cli-install-skill-handshake]]）。

### stop_run 中止细则【契约】 ^anc-mcp-stop-run

上表 stop_run 行的语义细化，六条实施契约（1-3 首版；4-5 系 2026-08-22 review 二缺陷修：级联够不着在飞串行 call 子层 / aborted 不落盘重启后可被 resume 复活；6 系 2026-10-04 hopissues/0117 注册表外快照兜底）：

1. **级联中止**：`stopRun` 对 running run 调 dispatcher 的 `requestAbortCascade()`（不是单点 `requestAbort()`）——在飞子 dispatcher 分布在**三张表**：
   - inflightDispatchers（parallel worker 与 call parallel 形态）、callFrames（暂停中的 call 子帧）、activeCallChildren（**正在执行中的串行 call 子层**——handleCallStep 的 `await childDispatcher.runSpec()` 期间既不在 inflightDispatchers 也不在 callFrames，首版只遍历前两张表，串行 call 子树会烧到自然终态才停,review 实抓）;
   - 级联递归遍历三张表逐个下发，深递归/并行都停，不留孤儿继续调 LLM 烧钱。级联实现归 [[step-dispatcher#^anc-struct-step-dispatcher-exports]] 调度组；
2. **aborted 钉住（迟到结果竞态）**：stop_run 受理后立即把注册表状态置 `aborted` 并返回，不等执行循环真正停下（协作式中断是步间生效的，在飞的那步会跑完）。
   - 此后**任何**迟到回调都不得改写 aborted——覆盖四个回写口：applyResult（正常终态）、startRun 的异常 catch、resumeRun 的异常 catch（后两处直写 `entry.state = 'failed'`，首版漏堵——异常迟到会把 aborted 改成 failed，终态间失真，review 实抓）、**resumeRun 的 rejected 回调**（answer 被结构化拒收时回写 paused+failure 的那一支——2026-10-11 语义审计 0156 B5 补登：此前见 aborted 先返但没收 tool provider，窄竞态下工具通道泄漏）;
   - 四处一律：见 aborted 先行返回，只做资源收尾（关闭 tool provider，close 幂等可重入）。中止意图先于执行结果，否则用户看到"已停止"的 run 又自己变回 failed；
3. **终态幂等**：对 completed/failed/aborted 的 run 重复调用返回现状不报错（`idempotentHint: true` 的兑现）；注册表查不到的 run_id 按快照兜底（第 6 条），快照也没有才 RUN_NOT_FOUND；
4. **aborted 落盘（跨重启终局）**：stopRun 在该 run 的实例目录写标记文件 `aborted.json`（内容：中止时刻 + reason——非引擎状态机的一部分，是 server 协议层的墓碑标记，不改 state.json 语义）。`restoreRun` 恢复前先查此标记，**在场即拒**（错误码 `RUN_ABORTED`，消息说明该 run 已被主动中止、快照仅供人工检视）。
   - 不落盘的后果:"中止是终局"只在内存成立——server 重启后注册表清空，resume_run 未命中走 restoreRun 会把 aborted run 从快照复活成 paused 一路跑到自然终态**含 commit 不可逆操作**（review 实抓）;
   - 写标记失败不阻塞中止（stop 的主职责是停内存里的执行，落盘是加固；失败记 stderr 留痕）;
   - **问题卡随墓碑同拍清除（34 轮 review）**：stop_run 是 paused→终局的转移,等人窗口随之关闭——卡是一等实物、文件级消费方可直接读,残卡会误导它们（API 面有墓碑优先兜着,文件面没有;[[exec-engine#^anc-exec-pause-persist]] 卡生命周期=等人窗口的中止侧兑现）；
5. **工具通道收口分道**：stopRun 当场 close tool provider **仅限 paused run**（无在飞循环，不会再有回调收尾）；running run 的收口归钉住回调（applyResult / 两处 catch 的 aborted 分支）——在迟到结果到达时收。首版对 running 也当场 close，在飞那步的下一次工具调用会撞"已随 run 终态关停"拒绝，违反第 2 条"在飞的那步会跑完"的承诺，且 commit 步可能被掐成半拉子留部分不可逆副作用（review 实抓）。
6. **注册表查不到时按快照兜底（hopissues/0117,2026-10-04）**：MCP server 重启后注册表清空,重启前停在 paused 的 run 不在注册表里。旧行为只认注册表、报 RUN_NOT_FOUND,而 run_status 与 resume_run 都已经能按 state_dir 读快照——stop_run 成了唯一缺口：用户想放弃这个 run 只能手工往实例目录放墓碑文件。补法是 stop_run 收可选 `state_dir`,注册表不中时直接操作盘上快照：
   - **纯盘操作**：不建注册项、不加载引擎、不构造 Dispatcher、不需要任何凭证——与 run_status 的快照兜底同一定位。墓碑一落,之后 run_status 走既有快照兜底（墓碑优先）返回 aborted 带 restored_from_snapshot:true,resume_run 走 restoreRun 见墓碑拒 RUN_ABORTED,都不需要改;
   - **另一个活进程持有时必须拒**：同一个 state_dir 可能被两个 MCP server 进程共用,run 可能正在另一个进程的注册表里执行。本进程只能写墓碑,停不了那个进程的执行循环——墓碑落下后盘上说 aborted,那边照跑（甚至跑到 commit 不可逆动作）,终局说法与事实分裂。判据用 state.json 的最后写入者（`last_writer.pid`,[[exec-engine#^anc-exec-state-seq-guard]] 每次写盘都记）：pid 不是本进程且该进程还活着 → 拒 `RUN_OWNED_ELSEWHERE`。pid 等于本进程（注册项曾被过时预检移出）不算别人持有;
   - **快照路径不做 STATE_STALE 预检**：过时预检比的是"本进程内存里的账"与盘上序号,快照路径没有内存账,无可比;活进程持有由上一条防;
   - **墓碑写失败要报错**（与注册表路径相反）：注册表路径写墓碑失败不阻塞,因为内存里的执行已经停了,墓碑只是加固;快照路径墓碑就是中止的全部效果,写不进去等于没停成,必须如实返回 `STOP_WRITE_FAILED`;
   - **问题卡删不掉不算失败**：墓碑已落,状态权威序是墓碑优先（run_status 先看墓碑）,残卡不会被当成等人;删卡失败记 stderr。

   **能力契约（HopTrait）**：

   ```
   # Spec: stop_run 快照兜底
   Id: mcp-stop-run-snapshot
   Goal: 注册表里没有这个 run 时,按盘上快照把它正规中止——非终态的落墓碑,终态的如实返回,别人正在跑的拒绝
   Inputs:
   - run_id % line  # 要中止的 run
   - state_dir % line  # 快照根目录;缺省 .hopstate,相对路径按 server cwd 解析
   Outputs:
   - result % yaml  # 成功 {run_id, status, restored_from_snapshot: true} 或 {error: {code, message}}
   Constraints:
   - 只在注册表查不到时进入;注册表命中的行为(第 1—5 条)一字不变
   - 不建注册项、不加载引擎、不读凭证
   - 已终态(墓碑在场,或 terminal_state 为 completed/failed/aborted)只读返回,不写任何文件
   - last_writer.pid 是另一个仍存活的进程时不写任何文件,返回 RUN_OWNED_ELSEWHERE
   - driver_channel 是 cli 时不写任何文件,返回 DRIVER_CHANNEL_MISMATCH
   - 其余情形(paused,或进程崩溃时停在 running)写墓碑、删问题卡;墓碑写失败返回 STOP_WRITE_FAILED
   ```

   **类型约定（HopType）**：
   - 输入 `state_dir`：字符串,快照根目录路径（不是实例目录）;实例目录 = `resolve(state_dir ?? '.hopstate', run_id)`;
   - 墓碑 `aborted.json`：`{aborted_at: ISO 时间串, reason: 'caller 经 stop_run 主动中止（注册表外,按快照兜底）'}`——与注册表路径同两键,reason 文案区分来路;
   - 成功返回：`{run_id: string, status: 'aborted' | 'completed' | 'failed', restored_from_snapshot: true}`;
   - `last_writer`：state.json 里的 `{pid: number, at: string}`,经 persistence 的 `readStateSeq` 读;缺席视为无人持有;
   - 进程存活判定：`process.kill(pid, 0)` 不抛 → 活;抛 `EPERM` → 活（进程在,只是无权发信号）;抛 `ESRCH` → 已死。

   **关键逻辑（HopSop）**：

   ```
   # impl stopRun(run_id, state_dir) 注册表查不到之后的分支(stopFromSnapshot)
   1. [act] dir = resolve(state_dir ?? '.hopstate', run_id)
   2. [branch]
     2.1. [case(dir/state.json 不存在)] 返回 RUN_NOT_FOUND(报文点名查过的目录,提示 run 以 workspace_dir 启动时传 start_run 返回的 state_dir)
     2.2. [case(dir/aborted.json 存在)] 返回 {run_id, status: aborted, restored_from_snapshot: true}
   3. [act] st = 解析 dir/state.json(解析失败返回 RUN_NOT_FOUND,报文带解析错误原文)
   4. [branch]
     4.1. [case(st.terminal_state ∈ {completed, failed, aborted})] 返回 {run_id, status: st.terminal_state, restored_from_snapshot: true}
   5. [act] lw = readStateSeq(dir).last_writer
   6. [branch]
     6.1. [case(lw 在场 且 lw.pid ≠ process.pid 且 pidAlive(lw.pid))] 返回 RUN_OWNED_ELSEWHERE
          (报文点名 pid 与最后写入时刻;指路到那个进程的会话里调 stop_run;
           若确认该 pid 已不是 hopjit 进程〔pid 被系统复用〕,结束那个进程或等它退出后重试)
     6.2. [case(st.driver_channel 在场 且 ≠ mcp)] 返回 DRIVER_CHANNEL_MISMATCH(报文与 claimDriverChannel 同口径,指路 hopjit abort)
   7. [act] 写 dir/aborted.json;失败 → 返回 STOP_WRITE_FAILED(带系统错误原文)
   8. [act] 删 dir/paused.json(不存在跳过;删失败记 stderr,不改返回)
   9. [act] 返回 {run_id, status: aborted, restored_from_snapshot: true}
   ```

错误响应统一 `{ error: { code, message } }`。**错误码域**：MCP 协议面自有码域 + 复用 [[shared-errors]] 的 `INVALID_STATE` + 复用 dispatcher 恢复面的 `CHILD_NOT_IN_QUEUE`。

- 复用码 `CHILD_NOT_IN_QUEUE`（2026-09-25 todo/0105 登记）:resume_run 带 child_instance 而待答队列与在飞账都不中时同步返回;码的语义权威与拒因文字在 [[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 4 条（dispatcher.resume 异步拒收与本模块同步核对共用同一拒因函数）,本模块只登记"resume_run 会同步返回它";

- 自有码清单：`RUN_LIMIT`/`SPEC_NOT_FOUND`/`SPEC_INVALID`/`TOOLS_UNAVAILABLE`/`TOOLS_FILE_INVALID`/`TOOLS_NAME_CONFLICT`/`TOOLS_ASSEMBLY_FAILED`/`HOP_ENV_CREDENTIAL_REJECTED`/`CONFIG_INVALID`/`INIT_FAILED`/`RUN_NOT_FOUND`/`RUN_ABORTED`/`INSTANCE_NOT_FOUND`/`APPROVAL_REQUIRED`/`COMMAND_FAILED`/`CWD_OUTSIDE_WORKSPACE`（已撤,记录）/`RUN_OWNED_ELSEWHERE`/`STOP_WRITE_FAILED`/`INVALID_ARG`/`WORKSPACE_NOT_FOUND`;
  - 入口参数校验两码〔INVALID_ARG 驱动工具参数不合法——含 submit_and_fetch_next 的 output/answer 不是 JSON 对象、reap 的 status 不是 completed|failed、run 的 log_level/max_runs/notify 非法;WORKSPACE_NOT_FOUND 七件驱动工具与 approve_commit/approve_dirs 显式传的 workspace_dir 不存在,^anc-mcp-reuse-driver-tools;两码都是入口参数校验,不由引擎产生,所以登记在本模块而不进 shared-errors 引擎表;2026-10-07 todo/0146 review 补登〕;
  - stop_run 快照兜底两码〔RUN_OWNED_ELSEWHERE 快照的最后写入者是另一个仍存活的进程/STOP_WRITE_FAILED 快照路径墓碑写不进去,^anc-mcp-stop-run 第 6 条;2026-10-04 hopissues/0117〕;
  - run_approved_command 三码〔INSTANCE_NOT_FOUND 快照目录不在/APPROVAL_REQUIRED 不在卡上清单/COMMAND_FAILED 原语抛错含 hopjit 恒拒与超时;第四码 CWD_OUTSIDE_WORKSPACE 越 workspace 2026-10-09 已撤（todo/0152）,留名记录,^anc-mcp-run-command;另 CORRUPT_STATE_FILE 是 persistence 的码本工具透传,不列自有〕;
  - `TOOLS_ASSEMBLY_FAILED`〔装配兜底档——识别按 tools-composite 报文前缀,前缀漂移时降级为兜底码不丢结构化,九审注〕;
  - `CONFIG_INVALID`〔每 run 重读的项目级配置在场但非法——文法/凭证违规响亮拒,十二审〕;
  - `RUN_ABORTED`〔restore 撞 aborted 墓碑标记——已主动中止的 run 拒绝复活,^anc-mcp-stop-run 第4条〕;
  - `STANDALONE_UNAVAILABLE`〔配置问题使独立模式不可用时 start_run 与独立模式 resume_run 返回,错误体多带 reason/fix 两字段,^anc-mcp-server-status;2026-10-07 todo/0146〕、`DRIVER_TOOL_ERROR`〔复用驱动工具的运行时错误报文没有大写码前缀时的兜底码,^anc-mcp-reuse-driver-tools〕;
- 复用 [[shared-errors]] 的 `COMMIT_NOT_APPROVED`（approve_commit 的指纹对不上、独立模式 resume_run 在未批准时被调）与 `COMMIT_BODY_ENGINE_ONLY`（submit_and_fetch_next 工具对带 body 的 commit 步骤提交输出）——语义权威 [[exec-engine#^anc-exec-commit-approval]];复用驱动工具透传引擎与 CLI 同款报文前缀码（INSTANCE_NOT_FOUND / WORK_ZONE_VIOLATION / DRIVER_CHANNEL_MISMATCH 等）;
- 补登记录:后五码 2026-08-17 0004/0005/0007 批次补登,TOOLS_FILE_INVALID 系实装早于登记的存量欠账同批清;run_approved_command 四码 2026-10-01 工程链 review 补登（0132 批落码时只写进 HopType 漏了本清单）;
- 码域分界:run 生命周期与协议入参错误是本模块的关注点、不进引擎错误码表（塞进 shared-errors 会稀释引擎码域语义；2026-08-07 review 改口：原"不新造错误体系"表述与实现不符，以实现为准修订设计）。

**工具注解（ToolAnnotations，2026-08-10 真机实撞补定）**：全部工具必须携带 MCP 标准注解。

- 新增件（2026-10-07 todo/0146）：`server_status` 与驱动工具 `status`/`validate` 标 `readOnlyHint: true`;驱动工具 `run`/`submit_and_fetch_next`/`reap_and_fetch_next`/`resume` 与 `approve_commit` / `approve_dirs` 标 `readOnlyHint: false, destructiveHint: false`（approve_commit 另标 `idempotentHint: true`）;驱动工具 `abort` 标 `readOnlyHint: false, destructiveHint: true`（与 stop_run 同理:放弃 run 是终局）。注解按工具实际行为如实标——放行与否由 setup 的放行清单决定,不靠把注解标轻来换取载体自动通过。
- `list_runs`/`run_status` 标 `readOnlyHint: true`；`start_run`/`resume_run` 标 `readOnlyHint: false, destructiveHint: false, openWorldHint: false`（启动/推进 run 是有副作用但非破坏性、非开放世界动作）；`stop_run` 标 `readOnlyHint: false, destructiveHint: true, idempotentHint: true`（丢弃在飞进度=破坏性；对终态 run 重复调用幂等返回现状）。
- **无注解 = 载体按最坏情况对待**：Codex exec 非交互下对无注解 MCP 工具的调用会被审批层自动取消（实撞：`user cancelled MCP tool call`，模型侧真调用已发出、被 app 配置层拒），`default_tools_approval_mode = "auto"` 也救不回。注解是载体审批分级的判据输入，不是文档装饰。

## HITL 与运行生命周期【契约】 ^anc-mcp-run-lifecycle

```
start_run → running → (completed | failed | paused)
paused → resume_run → running → …（可多次暂停）
paused(pause_reason=commit) → approve_commit → resume_run → running（commit 批准停点,2026-10-07 todo/0146）
复用驱动 run → paused(pause_reason=dirs, step_id 空) → approve_dirs → resume → running（Config.dirs 批准停点,2026-10-07 todo/0148;独立模式无此停点——start_run 的 dirs 参数起跑对账）
running | paused → stop_run → aborted（终态,不可 resume）
```

- **commit 批准停点**（权威 [[exec-engine#^anc-exec-commit-approval]]）：独立模式执行到未批准的 commit 步骤时,dispatcher 先查批准账,账上有这个 commit 步骤当前 body 的授权记录就直接执行、不扫描;账上没有才做安全分析（引擎扫描判定全部安全的不调模型、记账后执行;其余在这个 commit 步骤第一次到达时交分析模型分析一次）,全部动作安全则直接执行;有需要人确认的动作才返回 paused,载荷 `pause_reason: 'commit'`、`presented_data.context` 带 `step_id`/`fingerprint`/`analysis`/`body`,`response_options` 为三选项;run_status 照常呈现。调用方用大白话把分析结论讲给人听（代码在人要求时才贴）,人选批准后调 approve_commit（带 scope）,再调 resume_run（step_id 同停点,answer 内容不看）。resume_run 只查账不分析,未批准时被调 → `COMMIT_NOT_APPROVED`,run 保持 paused。同一 commit 步骤批准后,指纹不变的 for-each 后续轮、retry 重跑、崩溃续跑都不再停;body 改了指纹就变,重新分析;

- **resume 入参校验在状态变更前（2026-08-07 review P1 补定）**：`step_id` 与 paused 载荷的 step_id 不一致 → INVALID_STATE 错误返回且 **run 保持 paused**——可恢复状态不因坏输入被毁（实撞：错误 step_id 曾先回 running 随后永久 failed）；
- **paused 不是终态**：run 停在注册表里等 resume，server 不超时自动推进（无超时概念，[[step-dispatcher#^anc-exec-pause-timeout]]）；
- **server 重启后 paused run 可恢复**【契约】——见下节 `^anc-mcp-run-restore`。
- **终态领取**：completed/failed 的 run 保留在注册表至 server 退出（v1 不做清理策略——单会话用量下无压力，出现压力再立项）。
- **驱动通道落账与跨通道拒**（2026-08-27 两模式并存三改的安全半边,权威 [[exec-engine#^anc-exec-driver-channel]]——本节只记 MCP 侧接线）：`startRun` 建 run 落 `driver_channel: 'mcp'`;
  - `resumeRun`/`stopRun` 恢复快照后核通道（stopRun 快照兜底路径直接读 state.json 的 driver_channel 字段核,同一判据）——撞 `cli` 建的 run → 结构化错误 `DRIVER_CHANNEL_MISMATCH` 指路 `hopjit submit_and_fetch_next`,不改状态;
  - `run_status`/`list_runs` 只读不拦（跨通道可观测恰是排查双执行的手段);字段缺席（旧 run）宽容并由首个推进入口认领。
- **同通道两进程的过时账预检**（2026-09-26,todo/0114,权威 [[exec-engine#^anc-exec-state-seq-guard]]——本节只记 MCP 侧接线）：两个 MCP server 进程对同一 state_dir 里的同一个 run 都有注册项时,通道核对拦不住（两边都是 mcp）,注册表的 state 也只反映本进程的内存。接线三条：
  - `resumeRun` 在取到注册项（或经 restoreRun 从盘上恢复出注册项）之后、`claimDriverChannel` 之前调引擎的 `assertStateFresh()`;`stopRun` 在注册表命中、终态幂等返回之后、`claimDriverChannel` 之前调同一函数（注册表查不到走快照兜底,那条路径没有内存账可比,不预检,见 ^anc-mcp-stop-run 第 6 条）;
  - 命中过时 → 返回 `{ error: { code: 'STATE_STALE', message } }`,message 即引擎报文原文（点名写入者 pid、写入时刻、盘上序号与本进程序号,指路"再调一次 resume_run 会从快照恢复"）;不翻状态、不注入答案、不 requestAbortCascade、不写 aborted.json、不删 paused.json;
  - 该注册项不在 running → 从注册表移出,同一进程下一次 resume_run 走 restoreRun 从盘上重新加载（兑现报文里的指路）;在 running → 不移出,在飞的 dispatcher 下次写盘自己撞 STATE_STALE,run 按既有异步 catch 转 failed,run_status 看得见。
- **宿主断开即退出（进程生命周期收口,四十七审——孤儿 server 实撞:两个历史会话的 server 挂了两天,谁都不负责杀它）** ^anc-mcp-shutdown-on-disconnect：stdio 传输的 server 生命随宿主——宿主会话退出关闭管道后 server 没有存在意义（paused run 有快照落盘,下个 server 经 ^anc-mcp-run-restore 恢复——孤儿进程反而零价值）。契约三条：
  - ①`transport.onclose`（宿主正常断开）与 `process.stdin` 的 `end`/`close`（管道关闭）都挂退出钩,触发即 `process.exit(0)`——在飞 run 的中断即崩溃中断,快照落盘由既有 persist 时机保证,不做优雅收尾（等在飞完成=不确定时长的僵尸期,退出语义要干脆）;
  - ②退出前 stderr 一行留痕（"宿主断开,server 退出;在飞/暂停 run 可经 resume_run 恢复"）;
  - ③**uncaughtException 兜底不救断连**——既有"不 exit"承诺限运行期异常（run 隔离条款）,断连钩的 exit 不经该路径（直接 process.exit,不是抛异常）。
  - 根因记档：原 serve() 只 connect 不挂任何断开钩,Node 事件循环有活跃 handle（在飞 promise/SDK 计时器）即不自然退出;uncaughtException 兜底又把"借异常死掉"的路也堵了——防炸设计的副作用把"该死的时候"也防住。
- **run 隔离不变量（server 侧落点）**：上游权威 [[../ARCHITECTURE#^anc-run-isolation]]（单机版架构总条款,通道表/取舍/守卫全在彼——本节只列 server 自己的实施件,不复制）：
  - `serve` 装 `unhandledRejection`/`uncaughtException` 兜底：记 stderr、计数留痕、**不 exit**——**不承诺关联 run**（回调无 runId 可依,关联职责归池尾 catch;漏网 run 停 running 由超时/对账/观测/重启 restore 兜住。作者拍板 2026-08-14"活"；取舍全文见主锚）；
  - `startRun`/`restoreRun` 是**组合根**：`process.cwd()`/env 在此一次读取折进该 run 的 HostConfig（env_snapshot），内核不再触进程状态；
  - `startRun` 对 `this.config` 派生物（tool_servers 等）**按 run 深拷贝**再交 HostConfig——server 持有的配置对象不被任何 run 变异；
  - 材料根参数（hopkb 需求）=组合根锚换取值来源的后续批,机制先行参数后至；
  - **实施注（2026-08-14 随批销账两暗病）**：
    - ①原 startRun 把 provider 凭证/端点/协议**写进 process.env** 供 dispatcher 读——进程环境当全局注册表的反模式实例（多 run 共享可变槽+凭证泄进程环境）,改走 env_snapshot 后进程 env 零写入（守卫一律禁 env 写,含组合根）；
    - ②原 restoreRun **不写 env**——非默认 service 凭证隐性依赖"此前某 startRun 写过的残留",server 重启直 restore 即缺,随快照统一后消除；
    - ③深拷贝分发首版实施漏（review 抓）——parseToolServers 传共享引用,下游变异条目即跨 run 污染,structuredClone 补齐。

### server 重启后 run 恢复【契约】 ^anc-mcp-run-restore

`resume_run` 的 runId 不在内存注册表时**不直接拒绝**，先走恢复路径。这是 DEBT-08"跨进程 resumeSpec"的实装形态：不做抽象自由函数，恢复逻辑落 server 的 `resumeRun` 未命中分支（真实消费方唯一，抽象留到第二个消费方出现）。

**能力契约**（HopSpec 契约）：

```
# Spec: 从快照恢复 paused run
Id: restore_run
Goal: server 重启后,把 .hopstate/<runId>/ 快照重建为注册表内可 resume 的 run
Inputs:
- run_id % line           # 待恢复实例 id
- state_dir % line        # 快照目录（缺省 .hopstate,resume_run 工具可选参数;相对路径按 server cwd 解析——workspace 锚定的 run 传 start_run 返回的绝对路径,与工具表 run_status/resume_run 行同口径）
Outputs:
- entry % yaml            # 重建的 RunEntry（state=paused）,或结构化错误
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
  restore 用重读合并后的配置调它,与工具面装配同用重读面;^anc-mcp-config 组合根装配线条款里
  buildModelEngine 的两条（routing_rules 的 thinking 透传、裸模型名引用的 service 归一）在恢复的
  run 上同样成立——恢复后第一次模型请求的 thinking 参数与 service 级设置和重启前一致（2026-10-11 todo/0164）
- **env 打底口径归一（M4,同批——原同函数内 tool_servers/commands/resource_limits 用重读面、
  env 用启动期 this.config.env,三节两种口径;且缺 hop_env_language 打底）**：env 换重读合并后
  配置的 env 节,hop_env_language 打底行与 startRun 对齐
- 恢复后注入的 step_id 必须指向本 spec 的 confirm/ask 步骤、网络暂停步、升层待答步或 commit 批准停点
  （判定顺序见下方 resumeRun 第 8 步）——坏输入拒于状态变更前（INVALID_STATE,run 保持 paused）
- **运行中崩溃恢复（2026-08-27 #52,dr20 实撞:server 死时 run 正在 call 推进中,state.json
  running=[5,5.1,5.1.1],原预检只认 confirm/ask/网络暂停三停点——纯崩溃态无入口,8.5 小时快照
  只能弃;CLI 侧 hopjit resume 本有同语义〔ExecutionEngine.recover 悬空 running→pending 幂等
  重跑,^anc-exec-crash-recovery〕,MCP 建的 run 被 driver_channel 硬闸拦在 CLI 外——通道能力
  不对称）**：恢复的 run（无 paused 载荷）且 step_id 既非 confirm/ask 也非网络暂停步时,
  **加判一条**:step_id 在快照 stepStates 里为 running（悬空崩溃步——机械判据,state.json 可核）
  → 走崩溃恢复分支:引擎悬空 running 重置 pending（复用 recover 语义,含 scope 掩码/branch
  已选保留豁免）→ dispatcher.resumeSpec() 异步续跑（job 式,与 start_run 同）;answer 参数
  忽略（崩溃恢复无问题在答——设计如此,报文不拒）。三停点判据全不中才 INVALID_STATE。
  **for-each × parallel 子实例停卡的跨进程恢复入口也是这一条**（2026-10-08 review 补,权威 [[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 6 条）:
  子实例的 commit 卡（父账上该步是 done）与 call-parallel 子实例的任何卡（callee 步骤不在父 spec）
  带 child_instance 来答会被本预检 INVALID_STATE 拒——调用方改传 step_id=<for-each 容器步>,
  容器步因有在飞子实例保持 running 且非 confirm/ask/commit → 判悬空崩溃步 → resumeSpec 对账,
  N 个子实例按 state.json 在场判全部续跑到各自停点重新入队。
```

**类型约定**（HopType）：无新类型——复用 `RunEntry`（注册表条目）。恢复的 entry 与 startRun 建的差别仅两点：`paused` 载荷为空（重启后内存丢失，step_id 校验改按 spec 结构预检）；`specPath` 从引擎快照恢复（`engine.getSpecPath()`，无则占位）。引擎侧新增两访问器支撑：`getSpecPath()`（重建 DirSpecProvider 的基准目录）、`setHostConfig()`（load 只恢复 host_context 子集，完整 HostConfig 重接）。

**关键逻辑**（HopSop）：

```
restoreRun(run_id, state_dir):
1. [条件(<state_dir>/<run_id>/state.json 不存在)] 返回 RUN_NOT_FOUND
2. [条件(<state_dir>/<run_id>/aborted.json 在场)] 返回 RUN_ABORTED——stop_run 写过墓碑的 run 不复活（^anc-mcp-stop-run）
3. [条件(standaloneUnavailable() 非空)] 原样返回 STANDALONE_UNAVAILABLE——恢复要用 provider 构造 Dispatcher,快照不动（^anc-mcp-server-status）
4. ExecutionEngine.load(instanceDir) 重建引擎
   # load 保留 running——paused 的 confirm/ask 步骤即 running 态（[[exec-engine#^anc-exec-pause-persist]]）;损坏即 RESTORE_FAILED
5. 用 server 当前 config.yaml 重建 HostConfig + 按 getSpecPath 所在目录重建缺省 DirSpecProvider（第二参 antRoots(homedir(), workspace_dir)——与 startRun 挂载同形,三级寻址：同目录 → 项目级 HopAnt → 用户级 HopAnt）
   5.1. 作业对象根从快照取:workspace_dir = engine.getRestoredWorkspaceDir()（load 恢复的 host_context 里原 run 的 workspace_dir）;[条件(旧快照缺席该字段)] 回退 server 进程 cwd。显式传过 workspace_dir 的 run 重启恢复后沙箱锚、config_project_dir 的兜底值、DirSpecProvider 的项目级根都按这个值算,不漂回 server cwd（与 config_project_dir 钉根同款）
   → engine.setHostConfig 重接
6. 新建 StepDispatcher（构造时从引擎回填 cumulative_tokens——预算跨重启延续）
7. 注册回内存注册表（state=paused）→ resumeRun 照常注入答案续跑

resumeRun(run_id, step_id, answer, state_dir, child_instance):
1. entry = 注册表[run_id];[条件(不在注册表)] entry = restoreRun(run_id, state_dir)——错误则原样返回
2. [条件(standaloneUnavailable() 非空)] 返回 STANDALONE_UNAVAILABLE——注册表命中的 run 也拦（config 只在 serve 启动时加载一次,为 null 时 start_run 从未成功,命中的只可能是恢复来的 run;闸放在这里与约束"独立模式路径一律拦"一致）
3. [条件(rejectIfStale 命中)] 返回 STATE_STALE（^anc-exec-state-seq-guard）
4. claimDriverChannel('mcp');[条件(抛)] 返回 DRIVER_CHANNEL_MISMATCH
5. [条件(entry 不是 paused,且不是"带 child_instance 且待答队列非空")] 返回 INVALID_STATE
6. [条件(带 child_instance 且队列与在飞账都没有这张卡)] 返回 CHILD_NOT_IN_QUEUE（^anc-exec-parallel-hitl-queue）
7. [条件(不带 child_instance 且 paused 载荷在场且 step_id ≠ 载荷 step_id)] 返回 INVALID_STATE,run 保持 paused
8. [条件(paused 载荷缺席——恢复来的 run)] 按 spec 结构找 step_id 对应的节点:
   8.1. isCommitPause = 节点是 commit 步骤且快照里该步为 running——commit 批准停点先于崩溃悬空判（否则会被当悬空步重置重跑,再停一次,但绕开了"未批准时 resume_run 必须明确报错"的契约）
   8.2. [条件(该步为 running 且不是 confirm/ask/升层待答/commit 停点)] 崩溃恢复:recoverDanglingRunning → 置 running → 异步 resumeSpec → 返回 {status: running, recovered_from_crash: true}
   8.3. [条件(节点不存在,或不是 confirm/ask/网络暂停步/升层待答/commit 停点)] 返回 INVALID_STATE,run 保持 paused
9. [条件(不带 child_instance 且该步为 running 且 checkCommitApproval 返回未批准)] 返回 COMMIT_NOT_APPROVED（报文 commitNotApprovedMessage,另带 step_id/fingerprint 字段）,run 保持 paused——只查账,不分析
10. 置 running,异步 dispatcher.resume(step_id, answer, call_path, child_instance),立即返回 {status: running}
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

**config schema（StandaloneConfig 即 `HopConfig` 新顶层键——mergeConfigs 必须同步逐键展开,commands 键漏写合并的前车之鉴;合并规则权威 [[config-load#^anc-config-two-level-merge]]）**：

```
HopType: NotifyConfig
  Id: notify-config
  Fields:
    - channel % line     # 通道枚举,现只 dingtalk;将来 wechat/mail 扩员
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

**启动预检（2026-08-07 review P2 补定;2026-10-07 todo/0146 改为不阻止启动）**：server 启动时**逐 provider** 解引用 `api_key_env`——任一缺失即把独立模式标为不可用并记下变量名（configError,^anc-mcp-server-status）,server 照常启动。预检仍在启动期做而不是推迟到首次 start_run——问题在 server_status 里一启动就可见,start_run 返回的 STANDALONE_UNAVAILABLE 是结构化错误。

**配置核心直接调用同样 fail-fast**：`HopjitMcpCore.startRun` 在写任何派生路由 env 前一次性读取并快照全部 provider key；任一缺失立即拒绝。必须先全读后全写，禁止边读 `api_key_env` 边写 `{SERVICE}_API_KEY`——源变量可能与另一个 provider 的派生目标同名，顺序写会把后者凭证静默串成前者。

**多 provider 的 v1 语义（2026-08-07 review P1 补定——原设计未言，代码静默只吃 providers[0]）**：`providers[0]` 为默认执行 provider（HostConfig 主体 + ModelEngine.default_service_id）。

- **全部条目**在启动时注入本进程路由环境：`{SERVICE_ID大写}_API_KEY` / `_BASE_URL` / `_PROTOCOL` / `_AUTH` / `_MAX_OUTPUT_TOKENS`;
  - `_AUTH`（第四项 2026-09-18 随 auth:bearer 档加入,仅 bearer 时写键——getClientForService 按它选鉴权头形态,schema 权威 [[shared-providers#^anc-config-standalone-schema]] auth 行）;
  - `_MAX_OUTPUT_TOKENS`（输出预算解析链第 3 级,前批次既有本行漏登随批补）;
  - `_THINKING` 与 `_THINKING_DISABLE_UNSUPPORTED`（配了才写键:前者是 provider 级思考缺省,五级链第 4 级;后者 2026-09-27 todo/0118 加入,只在 provider 声明 `thinking_disable_unsupported: true` 时写 `true`——dispatcher 在五级链算出"关"时据此改发 `output_config: {effort: "low"}`。schema 权威 [[shared-providers#^anc-config-standalone-schema]],行为权威 [[step-dispatcher#^anc-exec-thinking-disable-unsupported]]）;
  - `_PROTOCOL` 2026-08-12 随 openai 协议加入，getClientForService 按它选适配器，缺省 anthropic；即 [[step-dispatcher]] getClientForService 的多服务约定;
- spec 的 `service/model` 引用按 service_id 命中对应后端，不静默回退默认 client（错后端=烧错钱）。`default_model` 映射 ModelEngine.default_model（缺省 providers[0].model）。key 始终只在本进程 env，不出进程（隔离纪律不变）。
- **v1 边界（v2 复审点）**：路由走进程 env 意味着同 server 全部 run 共享一套 provider 集合——v1 单配置文件下语义一致无冲突；若将来出现"不同 run 用不同 provider 集合"的需求（多配置/每 run 覆写），env 通道会串台，须改为显式传 ModelEngine 路由表（依赖驱动决策，触发即复审）。
- **组合根装配线逐条契约（2026-10-11 todo/0164——每条都是 startRun / restoreRun 里的一行代码,删掉任何一行下面对应的测试必须红）**：
  - `buildModelEngine` 把 `routing_rules` 每条规则的 `thinking` 开关原样装进 `ModelEngine.routing_rules[].thinking`——dispatcher 五级链第 3 级消费（[[step-dispatcher#^anc-exec-thinking-routing]]）。可观察面：规则写 `thinking: disabled` 的步骤类别,模型客户端收到的请求参数 `thinking.type` 是 `disabled`（不装则 reason 类按内建缺省发 enabled）;
  - `buildModelEngine` 对 `routing_rules` 的 model 引用做 service 归一：引用不带 service 前缀（裸模型名,parseModelRef 解析出 `default`）时,规则的 `service_id` 归一为 `providers[0].service_id`,与 `default_model` 的归一同规则。可观察面：该规则命中的请求按 providers[0] 的 service 级设置发出（例如 `{SERVICE_ID}_MAX_OUTPUT_TOKENS` 决定请求的 `max_tokens`）,而不是落到无 service 级设置的 `default` 客户端;
  - `providerToHostConfig` 把 providers[0] 的 `auth` 贯穿到 `HostConfig.auth`——缺省 provider 路径的 defaultClient 据此选鉴权头（bearer 发 `Authorization: Bearer`,缺席或 api-key 发 `x-api-key`;显式 service 路由那一路另由 env 快照 `_AUTH` 键供给,两路同一档位）;
  - `providerToHostConfig` 构造的沙箱 `read_access.denied` 带缺省拒读基线六项 `.env` / `.env.*` / `*.key` / `*.pem` / `.hopstate/**` / `.hoplog/**`（基线语义权威 [[sandbox#^anc-config-sandbox-filesystem]]）。可观察面：run 里的工具读 workspace 内的 `.env` 或 `*.key` 文件被拒,拒收报文含 `Read denied`;
  - start_run 显式传 `workspace_dir` 时,`HostConfig.workspace_dir`、沙箱锚 `sandbox.filesystem.workspace_dir`、`config_project_dir`（项目级配置 hopjit.yaml 的重读根——每 run 装配期按 workspace_dir 找项目级配置,不按 server cwd;todo/0164 变异时 runCwd 改回 server cwd 连带 TOOLS_FILE_INVALID 反例红,暴露这第四个消费点此前漏列,2026-10-12 todo/0168 补）四处都按它算,不按 server cwd——快照 `host_context.workspace_dir` 落的就是这个值（restoreRun 第 5.1 步据此钉根,^anc-mcp-run-restore）;
  - 项目级 `tool_servers` 条目通过了配置文法核但注册文法不合法（`parseToolServers` 抛 `TOOLS_FILE_INVALID:`——如 `binding.kind` 不在枚举内、`name` 缺失）时,start_run 与 restoreRun 都返回 `{ error: { code: 'TOOLS_FILE_INVALID' } }` 结构化错误,不裸抛（注册文法权威 [[tool-interface#^anc-config-tool-registry]];顶层不是映射、`tool_servers` 不是数组这类配置文法错在 reloadProjectConfig 一层就以 `CONFIG_INVALID` 拒,到不了这里）。

## 安全边界【契约】 ^anc-mcp-key-isolation

1. **key 不出 server 进程**：配置文件只存 env 名，key 不进 MCP 响应、不进 HopLog、不进 `.hopstate/`；错误消息只给环境变量名不给值；
2. **spec_path 不做全库搜索**：只接绝对路径或相对 server cwd 的显式路径（"焊死"原则——server 无对话上下文，猜路径=在错误的 spec 上烧钱）；
3. **stdio 仅本机**：transport 网络化前必须补鉴权设计，v1 结构性排除远程调用。

## 载体注册与薄协议（二期）【契约】 ^anc-mcp-carrier-integration

- 注册：CC 项目 `.mcp.json` / Codex `~/.codex/config.toml [mcp_servers]`，命令 `hopjit-mcp`（包 bin 第二入口）。**`install-skill` 缺省同步注册**（2026-08-16 作者定装壳+注册一个动作,当时为显式 flag `--mcp`;2026-10-01 作者定"缺省安装 mcp"后不再要 flag,`--mcp` 留兼容别名——权威 [[hop-cli#^anc-cli-install-skill]]）：
  - CC 合并写 `<cwd>/.mcp.json`（保留既有其他 server）;Codex 追加 `[mcp_servers.hopjit]` 块（含 `env_vars` 凭证名透传——值不落盘只写名,干净环境实撞防线）;
  - 已有 hopjit 条目跳过（--force 亦不覆盖注册——配置是用户资产,提示自查）；
- **驱动改走 MCP 工具（2026-10-07 todo/0146）**：三载体的复用模式 driver 优先用七件驱动工具（^anc-mcp-reuse-driver-tools）推进 run,MCP 工具面不可见或 server 起不来时回退 CLI。放行清单 = provider-types 的 `HOPJIT_ALLOWED_TOOLS` 常量（hopjit 注册的全部工具,含 `approve_commit` 与 `approve_dirs`——两种批准的人同意都由 driver 在对话里问,^anc-mcp-commit-approve / ^anc-mcp-dirs-approve）,setup 写进 CC 的项目放行设置（[[hop-cli#^anc-cli-install-skill-permission]]）;setup 注册后做一次握手自检（拉起 hopjit-mcp → initialize → tools/list → 退出）,起不来就报原因与修法（[[hop-cli#^anc-cli-install-skill-handshake]]）。安全不靠载体的命令白名单:commit body 只有引擎能执行、每句批准一次,confirm/ask 停下问人,P8 前置把关不变;
- **standalone 入口与驱动工具的关系**：/hop 主路禁调 start_run 的规则（hopissues/0071）不变——七件驱动工具推进的仍是复用模式 run,推理在主对话;start_run 仍只属于 /hopspec-mcp;
- standalone 是**独立薄协议、不在降级链上**（2026-08-10 作者拍板，契约见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]）：hopjit MCP 工具面在会话可见（决策 3：注册即 opt-in）即选定 standalone——main 走 start_run → 轮询 run_status → HITL 经 resume_run → YAML 终态四步薄壳，全程零 hopjit CLI、零 subagent、零运行时环境判定。
  - 工具面不可见时才是 spawn 能力门的 delegated→inline 两层世界，两种形态互斥、无运行时交叉；
- 执行体唯一性沿 TODO 原约束：**server 侧已有 run 即已有状态写入，禁止转 CLI/subagent 重跑**。

## 实施切期【说明】

- **一期**（本设计范围）：mcp-server 模块 + config schema（shared-providers）+ 工具面/生命周期/安全测试 + 真机验收（DeepSeek Anthropic endpoint 跑 coffee-week 到 completed、doc-review 到 paused→resume→completed、key 不落盘扫描）；
- **二期**：Codex 能力门三层分派 + carrier-live-e2e 新场景（codex:standalone 从"恒 exit 2"转正）+ 崩溃恢复（注册表重建，衔接 DEBT-05/08）。
