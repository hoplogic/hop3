%% @trace
	id: hopjit-hop-cli
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-10-12T11:15+0800
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
| 命令契约 | 契约 | `anc-cli-dispatch` / `anc-cli-instance-resolve` / `anc-cli-state-load` / `anc-cli-run-deps-gate` / `anc-cli-workspace-arg` / `anc-cli-approve-dirs` / `anc-cli-list` / `anc-cli-pack` / `anc-cli-install-skill` / `anc-cli-doctor` / `anc-cli-install-skill-demo-ants` / `anc-cli-install-skill-permission` / `anc-cli-opencode-tools-gate` / `anc-cli-pack-shell` / `anc-cli-hop-ops-parity` / `anc-cli-install-skill-handshake` / `anc-cli-install-skill-single-entry` / `anc-cli-carrier-autodetect` / `anc-cli-postinstall`（已撤,记录）/ `anc-cli-first-run-hint` / `anc-cli-ant` / `anc-cli-hop-dispatch` / `anc-cli-carrier-home-resolution` / `anc-cli-notify-reuse` / `anc-cli-abort` / `anc-cli-approve-commit` / `anc-cli-schema-sep` |
| CLI 响应类型 | 契约 | `anc-cli-response-types`（组标题）/ `anc-cli-ant-response` / `anc-cli-init-response` / `anc-cli-validate-response` / `anc-cli-list-response` / `anc-cli-next-response` / `anc-cli-step-ready` / `anc-cli-execution-paused` / `anc-cli-commit-approve-response` / `anc-cli-command-response` / `anc-cli-vars-response` / `anc-cli-status-response` / `anc-cli-status-nested-pause` / `anc-cli-abort-response` / `anc-cli-replan-response` / `anc-cli-branch-request` |
| JSON I/O 约定 | 契约 | `anc-cli-json-io` / `anc-cli-file-arg-safety` |
| JSON 交互示例 | 说明 | — |

## 定位【契约】 ^anc-struct-hop-cli

> **模块版本**：hop-cli `v0.55.3`（2026-10-12 todo/0168：`submit_and_fetch_next` 撤 `--branch` / `--reason`——branch 由引擎按 case 条件求值,没有外部选择入口（作者定"不存在外部选路场景,branch / case 都是显性条件",契约 exec-engine ^anc-exec-branch-select-internal）;^anc-cli-branch-request 改废除记录,BranchRequest 类型删;命令表行删、原"调试 / 人工介入时手选 case"一句改为无入口陈述）。上版 v0.55.2（2026-10-11 作者抓"这些为什么要用 bash？"：^anc-cli-hop-dispatch 加「分派与总结阶段读原料用载体的只读文件工具,不走 shell」条——索引 / current / state.json / 任务卡 / 入口 spec 的读取一律走 Read / Glob / Grep 同类只读工具,shell 只留执行类;三载体 hop-skill.md 输出纪律节同款,check-driver-carriers 加 token）。上版 v0.55.1（2026-10-11 todo/0158 第一块真机 probe 实撞：opencode 的 `mcp.hopjit` 已有条目改"三分"——command 不是 hopjit-mcp 的用户自配跳过、现行形态跳过、hopjit 自己写的 `enabled:false` 旧形态由 setup 升级为 enabled:true 并补 tools 节五键;doctor 的 enabled:false warn hint 改为指路重跑 setup 而不是手工改文件。作者抓"普通用户会手工翻么？这是 hopjit 自己的 mcp service"——"已有条目跳过"只保护用户资产,不保护自己的旧形态）。上版 v0.55.0（2026-10-11 todo/0158 第一块：CC 系载体的 MCP 注册改为按族决策——族内无人在 user/local 级注册才写项目级 .mcp.json,族内已有注册时缺注册的载体往它自己的 .claude.json 写 local 级条目（只加一键 / 坏 JSON 响亮失败 / 文件不存在不建 / 查法=写法）;出口表加 ccFamilyRegistration / writeCcLocalRegistration;dev-install.sh 改为自动探测装全部在场载体。来由=doctor 报 cfuse-cc 没注册,追因 cc 与 cfuse-cc 共用 .mcp.json 却各查自己的 .claude.json）。上版 v0.54.2（2026-10-11 语义审计 0156 C 类：StatusResponse / VarsResponse 两 HopType 补 `inconsistency` 可选字段;detectPausedState HopSop 补源⑥ dirs 为首步,与引擎实际顺序一致;^anc-cli-run-deps-gate 条款里 `adaptConfigPaths(cwd)` 改为 cli.ts 现行 `reuseConfigPaths(workspaceDir)`、callee 解析根改两级 `antRoots(home, workspaceDir)`;七处指向代码行号的旧指针改写函数名/字段名）。上版 v0.54.1（2026-10-10 0154+0155 工程链 review 修复：^anc-cli-doctor 的 runDoctor / mcpHandshake 签名与引擎版本来源改成搬家后的现行形态（HopType 与 HopSop 四处,出口表引述块一处）;AntResponse.scope 写明 remove 在 removed 为假时不带;出口表 AdminContext 行补 roots;^anc-cli-ant adapt 条 git 配置按工作区目录读）。上版 v0.54.0（2026-10-10 todo/0155 HopAnt 两级根：`ant install` 加 `--scope user|project`（缺省 user）,`ant remove` 加可选 `--scope`,`ant list` 两级合并每行带 scope,`ant adapt / bootstrap / share` 按 id 两级找（项目级先）;`ant pack` 不变;组合根把 `antRoots(home, workspace)` 装进 AdminContext 传给 hop-admin;callee 解析闭包与批准账闭包改用两级根（项目根取本实例 workspace_dir）;演示件安装仍落用户级——[[hopant]] 决策 1 / 9）。上版 v0.53.0（2026-10-10 todo/0154 管理面业务体搬出：doctor 八问与 ant 七动作从 cli.ts 搬进新出口文件 `src/hop-admin.ts`（随搬载体探测与归属标识助手）,机器侧事实经 `AdminContext` 传入,cli.ts 的 doctor / ant 子命令改薄壳;mcp-server 由此挂出 `doctor` / `ant_*` 八个管理工具（[[mcp-server#^anc-mcp-admin-tools]]）;`HOPJIT_ALLOWED_TOOLS` 加八件、opencode 求差口径补管理面;出口表加 hop-admin.ts 四行;^anc-cli-doctor / ^anc-cli-ant 各补「实现落点」段,CLI 行为零变化）。上版 v0.52.1（2026-10-10 USAGE 定位改命令行手册——CLI 命令表节尾登记「USAGE.md 是本表的人读版」四条约定（同源 / 对应表权威出处 / 两条路执行姿态不混 / 不教用户手敲）。上版 v0.52.0（2026-10-09 todo/0139 第 2 块"/hop 自洽"定位改写：^anc-cli-hop-dispatch 条补「/hop 的定位与 description 契约」段——定位改"HopSpec 的总入口"（作者 2026-09-30 定方向）,description 结构 HopSchema HopSkillDescription 四块（定位与 HopSpec 一句 / 对执行 LLM 的好处三条 / 什么时候用五条 / 排除句,作者 2026-10-09 三条要求定稿）,形态约束三条（单物理行〔三处行级解析〕/ ≤1024 字符〔Agent Skills 标准〕/ 无 XML 标签）+ 三载体语言分工 + 派生面同步;check-driver-carriers 新增三载体 description 机检;三载体 hop-skill.md description 与正文开头定位段同改,现行英文 description 1042 字符超限一并修正）。上版 v0.50.1（2026-10-09 commit 安全分析批次工程链 review 修复：approve_commit 行为段删去 scope=once"重跑也不再停"的错误说法——重跑是新 run_id,once 批准不跨运行,与 exec-engine 及代码一致）
> - 上版 v0.51.0=2026-10-09 todo/0139 第三块"可用性守卫"：新命令 `hopjit doctor`（^anc-cli-doctor,作者定名——"setup --check 太复杂,如果 brew doctor 有惯例,那么继续用 doctor"）——装完 hop 之后一条命令答八问（skill 在场 / 版本 / 菜单可见 / MCP 注册 / 握手 / 放行 / MCP server 模型配置 / 独立模式凭证）,每项 ok|warn|fail|n/a 一行加指路,任一 fail 退 1。核心取舍：**doctor 查的每一项都是 setup 写的某一项,查法复用 setup 同一个探测函数**——setup 里与写操作揉在一起的三段判定（学 standalone 配置 / MCP 已注册判定 / 放行缺口）抽成只读函数 `learnStandaloneEntry` / `readMcpRegistration` / `ccPermissionMissing`,setup 改调它们再写,"查法=写法"由代码结构保证。作者口径：模型配置那问报的是"MCP server 根本没配置"（fail,setup 没学到的原因照 note）而不是"没凭证"（凭证变量缺是 warn,只影响独立模式）。driver 三载体 §0 "已注册但工具不可见"改为先跑 doctor）。上版 v0.50.1（2026-10-09 子卡 C/E review 修复：`ant share` 归属标识改为"落盘即用不问"（决策 8 被 v0.50.0 条文反了——config 有 owner_id 时不带旗仍问;driver 给的命令行不带 --yes 所以每次都问）;owner 三态改四态;响应加 credential_scan 回执（含免责,作者定）;`PACK_ERROR` 登记;AntResponse id / next_step 说明补 pack / share;版本行 `--version` 笔误改 `--pkg-version`）。上版 v0.50.0（2026-10-09 todo/0142 子卡 C/E：`hopjit ant` 族加 `pack <spec> [--out] [--id] [--assets…]`（封装：spec → HopAnt 目录,头对账增删进响应）与 `share <id>… [--out] [--name] [--pkg-version] [--owner|--yes]`（分享：已装 HopAnt → HopAnt 包目录,四核不过即拒;归属标识缺省不问人——`owner_prompt_required` 返回交 driver 在对话里问;成功后写回 config.yaml `owner_id`,决策 8 写的一侧）;AntResponse 加两形态;业务权威 [[hopant#^anc-hopant-pack]] / [[hopant#^anc-hopant-share]]）。上版 v0.49.0（2026-10-08 commit 批准改为安全分析：CLI 不注册分析函数,引擎判定全部安全的 commit 照常放行、其余按固定模板转人工;CommitPauseContext 去掉 review 与 referenced_files、加 analysis（CommitAnalysis）,指纹只覆盖 body;scope=once 改为本次运行内有效——^anc-cli-approve-commit）。上版 v0.48.0（2026-10-09 todo/0143 作者定"去掉"：**撤 npm postinstall 钩子**——package.json 不再登记 `postinstall`,`dist/postinstall.js` 与 `postinstallSkipReason` 删除;装 skill 只剩 `hopjit setup` 一个入口。原因三条：npm 12 起默认拦截依赖的安装脚本,钩子在多数新机器上根本不执行,留着只换来每个新用户装包时一段 npm 警告;npm 官方最佳实践明说安装脚本只该做目标机编译,用它改用户 agent 目录恰是 npm 要拦的那类行为;同一件事两个触发点两套跳过逻辑是分叉。补**首次运行提示**（新锚 ^anc-cli-first-run-hint）：用户漏跑 setup 时,下一次敲任何 hopjit 子命令 stderr 一行指路;零状态,`--json` 的 stdout 不动。^anc-cli-postinstall 条款改为撤销记录,锚保留供历史引用,代码落点归零）。上版 v0.47.3（2026-10-08 todo/0151 作者定"删"：pack 壳不再写 knowledgeNote（"本目录还包含判据知识文档（X、Y）,引擎按 doc-ref 自动注入"一句）——它与 ^anc-cli-pack-shell"内务零披露"条直接打架,点名文件本身就是诱导预读,后半句"无需手动引用"拦不住;知识文档照样随包拷入,只是壳里不提。PackResponse.knowledge_docs 不变）。上版 v0.47.2（2026-10-08 发版前八项修复批工程链 review 修复：^anc-cli-pack-shell 交付段补注实装时点（设计 2026-08-15 写定,模板 2026-10-08 todo/0129 B5 才读 header.outputs 兑现）并登分级表;InstallSkillResponse 的 permission_note / mcp_note 说明补 opencode 一支（v0.47.0 改了码没改字段说明）;复用模式工具工厂 / tool-call / runDepsGate 的项目根改按 HostConfig.workspace_dir 取（[[config-load]] 工具面条款）;`adaptConfigPaths` 与 `runDepsGate` 改调 config-load 的 `configPaths`,CLI 不再自拼配置路径）。上版 v0.47.1（2026-10-08 todo/0133 挂账②：driver 三载体 hop-ops.md 同文改机检——check-driver-carriers.mjs 三份字节等值断言,新锚 ^anc-cli-hop-ops-parity）。上版 v0.47.0（2026-10-08 todo/0134 作者拍 b 案：opencode 注册改 `enabled:true`,同文件 `tools` 节把独立模式专属五件（start_run / run_status / resume_run / list_runs / stop_run）按 `hopjit_<名>` 写 false,幂等不动用户其他键;permission_note 撤「把 enabled 改 true」句——新锚 ^anc-cli-opencode-tools-gate）。上版 v0.46.0（2026-10-08 todo/0131 复用模式配置改两级合并：`buildHostConfig` 经 config-load 取系统级+项目级合并结果装 commands / language / env / resource_limits,工具工厂与 tool-call 取两级 tool_servers;`readProjectCommands` / `readProjectLanguage` 出口退役,权威 [[config-load]]）。上版 v0.45.0（2026-10-08 commit 批准改为自动研判优先:`approve_commit` 的 `--body-hash` 改 `--fingerprint`、新增必填 `--scope once|task`;CLI 不注册研判函数,未批准的 commit 恒转人工;CommitPauseContext 换成 fingerprint/review/referenced_files,commit 停点 response_options 为三选项;CommitApproveResponse 换 fingerprint、加 scope。权威 [[exec-engine#^anc-exec-commit-approval]]）。上版 v0.44.3（2026-10-08 ExecutionPaused.presented_data 加 `default_values?`——ask 停点对每个声明按名给前序同名建议值,`default_value` 保留只给第一个声明向后兼容;权威 [[step-dispatcher#^anc-exec-hitl-presentation]] 建议值供给条。上版 v0.44.2（2026-10-07 todo/0146 工程链 review 修复批次：`approve_commit` 子命令加 `--workspace`（与 run/init 同一 resolveWorkspaceArg,显式路径不存在报 WORKSPACE_NOT_FOUND,state-dir 相对它解析）,签名与 HopSop 补齐,命令表补 --state-dir;响应类型章补 HopSchema ExecutionPaused、CommitPauseContext 与 CommitApproveResponse（新锚 ^anc-cli-commit-approve-response）;握手自检补 McpHandshake 类型、mcpHandshake 签名与七支 HopSop,动作清单补 tools/call server_status;manifest 跳过写入与 output/answer 对象检查补 HopSop;删放行条款里撤回时残留的「只留一个例外」）。上版 v0.44.1（2026-10-07 dirs 批工程链 review 修复：StatusResponse paused 判定加源⑥（dirs 卡 step_id 恒空串,首版 status 报 running）;陈卡对账记档前提改;approve_dirs 行返回类型改 DirsApproveResponse;run 行加 --approve-dirs 专句;子实例入口不收 --approve-dirs 写明。上版 v0.44.0（2026-10-07 todo/0148：`approve_dirs <dirs-hash>` 子命令、`run`/`init` 加 `--approve-dirs`、pause_reason 枚举加 dirs——Config.dirs 清单批准一次的 CLI 入口,^anc-cli-approve-dirs。上版 v0.43.3（2026-10-07 todo/0146 probe 3 实撞两处修正：①setup 的托管目录 manifest 内容不变时不写盘——已装好的项目里跑 setup 只为补项目级注册与握手诊断,却因无条件重写 manifest 在 Claude Code 沙箱里撞 EPERM 整条失败,契约 ^anc-cli-install-skill;②`submit_and_fetch_next` 的 `--output`/`--answer` 解析结果必须是 JSON 对象,否则在调引擎前以 INVALID_ARG 拒、状态不动——实撞 `--answer '"approve"'` 让引擎抛 TypeError,帮助文本同步写明对象形态,契约 ^anc-cli-json-io。上版 v0.43.2（2026-10-07 setup 放行清单并入 `approve_commit`——commit 的人批准改为 driver 在对话里问,载体弹窗不再当批准闸;作者纠正"需要审批的时候在对话里问",Claude Code 弹窗频繁、用户习惯性点过,契约 ^anc-cli-install-skill-permission、^anc-cli-approve-commit。上版 v0.43.1（2026-10-07 陈旧副本扫描修两处误判：①一次 setup 装多个载体时，opencode 那一轮把 Claude Code 的现行目录 `~/.claude/skills/` 当旧位置完整扫描——改为只有 Codex 的两处历史位置做完整扫描，其余扫描根只看 `demo-*`；②"spec.md 缺 `engine_min_version` 指纹判陈旧"只对用户自建件生效，自带件只看版本——实撞：当前版 hopbuild2 被挪进备份区,契约 ^anc-cli-stale-skill-scan。上版 v0.43.0（2026-10-07 陈旧副本由只提示改为本器自带件自动挪进备份区：setup 第 6 项职责对六件、旧名 `hopskill-build`、`hop-*`、`demo-*` 的陈旧副本整目录挪到 `~/.hopjit/stale-backup/<时间戳>/` 并写 RESTORE.txt,用户自建件仍只提示指路 /hopfix;修正旧名 `hopskill-build` 被误判为用户自建件的缺陷——作者问"这个应该直接升级覆盖吧？"后同意挪走方案,契约 ^anc-cli-stale-skill-scan。上版 v0.42.0（2026-10-07 工作区可见与显式传参：`run` / `init` 加可选 `--workspace <dir>`（与独立模式 start_run 的 workspace_dir 参数对称,缺省仍 cwd,显式路径不存在即拒 WORKSPACE_NOT_FOUND）,子实例 launch_command / call_protocol.init_command 恒带父 workspace;六个带 work_zone 的响应并列回显 `workspace_dir`——作者问"复用模式下的 cwd 是哪儿来的？在 CC 下用户没有显性的 cwd 感知"：工作区此前只由进程 cwd 隐式决定、决定了也没有一处主动告诉人;契约 ^anc-cli-workspace-arg。上版 v0.41.0（2026-10-07 todo/0146：setup 第 5 项放行面从 `run_approved_command` 一个工具扩为 provider-types 的 `HOPJIT_ALLOWED_TOOLS` 清单——hopjit 全部 MCP 工具减去 `approve_commit`〔^anc-cli-install-skill-permission〕;第 4 项注册后加握手自检:拉起 hopjit-mcp 走 initialize 与 tools/list 后退出,起不来就报原因与修法,响应新增 `mcp_handshake`〔^anc-cli-install-skill-handshake〕;组合根注册 commit 批准存储解析函数〔[[exec-engine#^anc-exec-commit-approval]]〕;run 遇未批准 commit 返回 pause_reason=commit 停点,新增子命令 `approve_commit`〔^anc-cli-approve-commit〕批准后 `resume` 续跑）。上版 v0.40.0（2026-10-07 todo/0142 子卡 B：顶层 `run` / `init` 起跑前加依赖核 ^anc-cli-run-deps-gate〔标准工具放过、其余工具须在两级 tool_servers 注册、静态 call 目标须是同目录 spec / 已装 HopAnt / 已注册工具,否则不建实例、报错指路〕;组合根注册 callee 路径解析函数,`call_protocol.init_command` 与 call 的 `launch_command` 改为填真实路径）。上版 v0.39.0（2026-10-06 todo/0142 作者定"demo skill 方向错了，以后都应该是 hopant，由于 hopant 是安装在 hop 下，所以 demo 可以缺省就装""demo 保留前缀"：setup 新增第 7 项职责——三个演示件由包内原件生成 HopAnt 缺省装进 `~/.hopjit/ants/demo-*`,不再 pack 成载体 skill;`--demo` 退成隐藏的无作用参数保留一个版本周期;陈旧扫描加旧 demo skill 废弃提示;pack 的 Id 改写覆盖中文 `标识:` 行;响应 demo 字段挪到顶层 `demo_ants`/`demo_note`）;）；
> - 上版 v0.38.2=2026-10-06 hopant 批工程链 review 修复：AntResponse 入响应类型章 ^anc-cli-ant-response〔HopSchema 块,含 exit code 条款〕;两级注册面读取挪出 cli 归 tools-registry;list 三态调 hopant.adaptState;:28 粘错的 anc-cli-notify-reuse 尾注搬回 tools-notify 行）;
> - 上版 v0.38.1=2026-10-06 作者要求"setup 要做的事情，再明确一下"：^anc-cli-install-skill 契约头原写"纯文件拷贝"且只提 CC，与现行行为不符，改为按执行顺序的七项职责表 + 恒不做的事 + 用户级/项目级作用域说明;行为零变化,细则子条不动）；
> - 上版 v0.38.0=2026-10-06 todo/0143 作者定：安装命令对外改名 `hopjit setup`,旧名 `install-skill` 退役为隐藏别名保留一个版本周期〔^anc-cli-install-skill 命令名条〕;安装主路改两条命令,postinstall 降为顺手加速并补记"钩子根本不执行"的第五种情况〔^anc-cli-postinstall〕;钩子提示改指 setup）；
> - 上版 v0.37.0=2026-10-06 新增 `ant` 命令族——HopAnt 安装/适配/索引/卸载/bootstrap 的 CLI 承接,业务在 [[hopant]] 模块,契约 ^anc-cli-ant,todo/0142 子卡 A）；
> - 上版 v0.36.3=2026-10-04 `buildHostConfig` 的 `sandbox.filesystem.workspace_dir` 从 `'.'` 改为 `process.cwd()` 绝对路径——与 `workspace_dir` 同值同源,随 state.json 持久化后不再被续推命令的进程 cwd 重新展开;契约 [[sandbox#^anc-config-sandbox-workspace-root]],MCP 侧同款先例 ^anc-mcp-config 2026-08-20）；
> - 上版 v0.36.2=2026-10-03 todo/0139 挂钩②改形态：next_step 值追加第二句——把包内 `docs/agent-instructions-template.md` 贴进项目 CLAUDE.md / AGENTS.md,先问用户;install-skill 自身不写用户的指令文件）；
> - 上版 v0.36.1=2026-10-03 todo/0139 挂钩①：install-skill 响应顶层恒带 `next_step` 指路包内 docs/AGENT-GUIDE.md——作者抓"这么深的地方,agent 为啥会来读",装包必经点是唯一能把 agent 引过去的位置;postinstall 成功行同带）；
> - 上版 v0.36.0=2026-10-03 作者定"install-skill 应该是智能探测的,不是手工选择"+"只敲 npm install -g,其他的都应该让 /hop 去解决"：install-skill 缺省按本机载体 home 在场自动探测、一次装全部探到的载体,`--carrier` 降为显式覆盖〔^anc-cli-carrier-autodetect〕;包加 postinstall 钩子装包即装 skill,四种环境静默跳过只留一行指路〔^anc-cli-postinstall〕;InstallSkillResponse 加 carriers/results 多载体形态）；
> - 上版 v0.35.1=2026-10-01 工程链 review 修复：frontmatter 键名 user_invocable→user-invocable〔官方连字符,下划线自 8 月起空操作〕;放行判据显式枚举 cc/cfuse-cc 不借 carrierFamily〔opencode 被误写 CC 文件〕;放行七形态写全〔permissions 非对象/allow 非数组不写只 note〕;缺省注册条补自举三支与注册面失败两支;其他载体小节加 opencode 启用句;装载清单登 hop-ops.md;出口表登 ensureCcPermission;InstallSkillResponse 小节加锚;:225 旧句清）。上版 v0.35.0（同日）。本版 install-skill 三改（作者定"核心是通过安装和 /hop 完成对 coding agent 的教育,对用户尽可能傻瓜化"）：①缺省即注册 MCP server 并自举配置（原须 --mcp）;②CC 载体自动放行 `mcp__hopjit__run_approved_command`（写 `<cwd>/.claude/settings.local.json` permissions.allow,幂等）;③用户可见 skill 收敛为 `hop` 一个——hopspec/hopspec-mcp/hopbuild/hopbuild2/hopfix 仍装到盘上但 `user_invocable: false`,由 /hop 分派;InstallSkillResponse 加 permission_written/permission_note。上版 v0.34.0（2026-09-27）。0.x 未承诺稳定。
> - 本版=新增 schema-sep 命令（把 spec 源文件里 HopSchema 名/类型分隔符从 `:` 原地迁移到 ` % ` 的工具,先备份、转换后三道校验不过就拒绝写回,todo/0109 第 2 步,^anc-cli-schema-sep）；
> - 上版 v0.33.0=status 对网络暂停与嵌套串行调用子流程里的停点也报 paused,StatusResponse 新增可选字段 call_path（^anc-cli-status-nested-pause,todo/0105 作者拍甲案）；
> - 上版 v0.32.0=init 新增 --child-instance（循环里的串行 call 子实例按轮次命名,子实例 ID 与步骤号分开传,hopissues/0098）；
> - 上版 v0.31.0=init 的 --upstream-feedback 支持 @file（引擎拼给 driver 的命令里数据值一律走参数文件,hopissues/0097）；
> - 上版 v0.30.0=PR#8 opencode 两契约行为（--mcp 注册缺省 enabled:false 防复用模式误调独立模式工具〔hopissues/0099〕+ hopbuild 族装 opencode 时 SKILL.md 副本 /hopspec run 改写为隐式触发〔hopissues/0101〕）+ 联审修复批；
> - 上版 v0.29.0=0096 陈旧副本新鲜度提示（^anc-cli-stale-skill-scan——install-skill 装载后只读扫描旧位置,本器产物落后报 stale_notes 携升级路径;InstallSkillResponse 补字段）；
> - 上版 v0.28.0=0086 语义审计修复批（abort 契约句独立带锚/HopLog 恒开条款带锚/分级表补四锚/响应类型章补 InstallSkillResponse+PackResponse/出口清单勘误四符号/@file 清单补 --tool-result/CALL_PROTOCOL_MISUSE 闸回写/work_zone 固定名同步/install rmSync 条款/计数句去数字改指权威/钝感句容错两分/debug_step 入双执行闸枚举）；
> - 上版（v0.27.3）=0081 批（StatusResponse/VarsResponse 枚举补 paused+status 两摘要字段+VarsResponse 存量漏 aborted 修）；
> - **CLI 命令+参数+JSON 响应结构是包级对外稳定面**——driver 依赖,破坏即破坏 driver,按 `^anc-meta-module-evolution` 属包级 MAJOR 候选；cli-types 子文件即此对外契约；
> - **逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
>
> **`--version` 单一事实源 = package.json【契约】** ^anc-cli-version-single-source：`program.version()` **不硬编码字面量**，在构建期从包 `package.json` 的 `version` 字段读取——`hopjit --version` 输出恒等于已安装包版本，杜绝"发版忘同步 CLI 字面量"的脱节（0.1.1 发布时 CLI 仍自报 0.1.0 即此病）。
> - 读取方式：编译产物 `dist/cli.js` 相对定位包根 `package.json`（`fileURLToPath(import.meta.url)` → 上溯 `dist/../package.json`），读失败则回退字符串常量兜底（不阻断 CLI 启动）。
>
> **入口判定须解析软链【契约】**：`cli.ts` 只在自己是进程入口时才跑 `program.parseAsync`（被 tests 以模块形式 import 时不跑,否则一 import 就解析测试进程的 argv）。入口判定的规则：**把 `process.argv[1]` 与 `fileURLToPath(import.meta.url)` 两边都经 `realpathSync` 解析成真实路径后再比对相等**,任一边解析失败（文件不存在）退回 `resolve` 的绝对路径。原因：全局包是软链形态——`npm link` / 全局安装后 bin 是 `/usr/local/bin/hopjit → <包>/dist/cli.js` 的软链,本库开发期 `npm run dev:install` 又把全局包 link 回本库,`process.argv[1]` 拿到的是软链路径而 `import.meta.url` 是真实路径,直接字符串比对必不相等 → 判成"不是入口" → 全局 `hopjit` 的所有命令空跑 exit 0,整个 CLI 不启动。落点 `@a: anc-struct-hop-cli`——`src/cli.ts` 末尾的 `resolveRealPath` 与 `isMain` 常量。

**① 自身定位**：HopCLI 是 ExecutionEngine 的命令行路由薄壳——把命令行参数解析为对 Engine 方法的一次调用，再按输出分流契约序列化结果（缺省 YAML，机器调用显式 `--json`）。它**不含任何业务逻辑**：步骤调度、状态机、变量作用域、重试策略全在 Engine 内（见 [[exec-engine]]）。CLI 的全部职责是「解析参数 → 路由到一个 Engine 方法 → 序列化结果」。（解释性类比：类似数据库的命令行客户端——只做协议转换，不做查询规划。）

**② 与其他 HopType 的关系**：
- **ExecutionEngine 的薄封装层**：每个命令对应一个**主** Engine 方法（`init`→`init_execution`、`submit_and_fetch_next`→`completeAndAdvance`、`debug_step`→`next_step`……）。
  - 主方法前后允许**推进面固定序列**（claimDriverChannel/reconcileInflight/advanceToCaller 这类每次调用形态恒定的编排薄链——reap_and_fetch_next 五连调、advance 四连调即此形态;2026-09-12 0088 批按实况收窄原"不组合多个 Engine 调用"过宽表述）；
  - CLI 不含业务判定（判定恒归引擎——组合的每一环都是无条件顺序调用,无 CLI 侧分支裁量;escalate 应答分派按引擎自报的待答态查询分流,查询归引擎判定仍不在 CLI）、不在命令间维护状态；
  - **节奏与消化逻辑已全部归引擎**（[[exec-engine#^anc-exec-advance-to-caller]]）——CLI 是真正的纯薄壳，无任何业务逻辑例外
- **热路径不经 CLI**：StepDispatcher↔Engine 的循环走进程内 TypeScript API（[[exec-engine]] 决策 1），零进程边界开销。CLI 子进程 IPC 仅用于外部人工交互、调试、HITL 介入
- **面向 Agent 与人双消费**：缺省 YAML 供人在终端阅读；外部脚本/Agent 显式传全局 `--json` 取得单行 JSON
- **不碰 Provider 抽象、不碰持久化**：CLI 不持有 ToolProvider/KnowledgeProvider，不直接读写 state.json——状态由 Engine 经 `state_dir` 管理，CLI 只传 `state_dir` 路径

> **历史说明**：早期版本曾在 CLI 层用自由函数 `consumeToolFreeBodies` 消化纯计算 body（曾标注为"唯一业务逻辑例外"，破坏薄壳分层选择）。task #96 把该逻辑上收为引擎语义 [[exec-engine#^anc-exec-advance-to-caller]]，CLI 薄壳**分层契约**（设计层取舍，非宪法级原则）重新自洽——这条曾被迫的破例已消除。原锚点 `anc-cli-next-drives-body` 废止，语义迁移至引擎侧 advance。

**节奏归引擎，driver 哑应答**【契约】：复用模式 driver（CC）通过 `submit_and_fetch_next` 交活 + 领取下一指令（一次原子往返），引擎决定推进节奏、消化哪些中间步、停在哪个 caller 介入点。caller 介入点（reason/check/confirm/含工具 body act-commit）+ 消化规则的唯一权威定义见 [[exec-engine#^anc-exec-advance-to-caller]]——CLI 不重复判定，只转发 `completeAndAdvance` 的返回。

**`hopjit run`** 是 `init` + 首个 `completeAndAdvance` 推进的便利合并：一条命令建实例并推进到首个 caller 介入点或终态（纯计算 spec 一条直达 completed）。返回 NextResponse（附 instance_id 供后续 submit_and_fetch_next）。run 不引入新流控——复用引擎 advance。

**②b 对外接口清单【封闭】** ^anc-struct-hop-cli-exports：

> 本表是 hop-cli 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `cli-types.ts`（响应/请求 JSON 契约，是 driver 依赖的包级对外稳定面）与 `hop-admin.ts`（hop 自身管理面的业务体——doctor 八问与 ant 七动作,2026-10-10 todo/0154 从 cli.ts 搬出,供 mcp-server 组合根挂成管理工具,[[mcp-server#^anc-mcp-admin-tools]]）。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。
> - `cli.ts` 是可执行入口薄壳，**但并非零导出**（原文"无被 import 的对外符号"与实况不符,2026-09-11 审计勘误）——实况四个测试面导出符号：
>   - `program`（src/cli.ts 文件末尾 `export { program }`,消费方=tests——tests/cli.test.ts 从 `../src/cli.js` 直接 import 用 `program.parseAsync` 进程内驱动命令）；
>   - `ensureCcPermission`（2026-10-01,^anc-cli-install-skill-permission——CC 放行写入,面向测试可达性导出,当前测试经 program 路由）；
>   - `installDemoAnts(pkgRoot, home)`（2026-10-06,^anc-cli-install-skill-demo-ants——由包内原件生成演示 HopAnt 并装进 `<home>/.hopjit/ants/`,返回 `{ installed, notes }`;面向测试可达性导出,测试传临时 home 直调）与 `rewriteSpecId(raw, id)`（把 spec 文本里第一行 `Id:` 或 `标识:` 的值改写为 id,保留原关键词;pack 的 Id 改写与演示件生成共用）；
>   - `bootstrapStandaloneConfig`/`readStandaloneCredentialNames`/`detectCcHopjitRegistration`（export 面在场,面向测试可达性导出;行号随文件漂移,以 grep 为准——2026-10-09 doctor 批勘误：原写 :923/:1010/:1029 已漂到 :1188/:1330/:1470）；
>   - `detectCarriers`/`firstRunHint`/`mcpHandshake`/`moveStaleToBackup`/`setOutputJson`（tests/cli.test.ts 直接 import 的既有导出,2026-10-09 doctor 批补登——此前漏登）；
>   - `runDoctor(ctx, opts)`/`learnStandaloneEntry(ctx, carrier)`/`readMcpRegistration(ctx, carrier)`/`ccPermissionMissing(cwd)`/`readSkillFrontmatter(home, name)`/`resolveCarrierHome(ctx, c)`/`installedHopDriverVersion(ctx, c)`（2026-10-09 ^anc-cli-doctor;2026-10-10 todo/0154 搬进 hop-admin.ts 后签名改收 ctx,cli.ts 只转发——doctor 的八问判法与从 setup 抽出的三个只读半边;后两个原非导出,doctor 与测试要用改为导出）；
> - 另有 resolveParam/assertOutputInWorkZone 等 CLI 参数处理 helper 同被 tests 直接 import——这些是测试可达面,不是跨模块业务出口,生产代码跨模块 import cli.ts 仍违规（guard-scripts 越层检查在案）。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `InitResponse` | 类型 | cli-types.ts | init 响应（engine 返回类型） | stable |
| `NextResponse` | 类型 | cli-types.ts | 推进响应联合（engine advance 返回，7 形态——2026-08-11 +DrainWait/+DispatchReady，−ParallelReady〔P1 清理〕） | stable |
| `StepReady` | 类型 | cli-types.ts | 步骤就绪形态（engine 组装） | stable |
| `ExecutionCompleted` / `ExecutionFailed` / `ExecutionPaused` | 类型 | cli-types.ts | 终态/暂停形态（engine 返回） | stable |
| `DrainWait` | 类型 | cli-types.ts | 收齐等待形态（统一模型：主线走完等在飞收割，step-dispatcher 消费；P2 复用模式 driver 消费）。2026-08-11 随 P0 新增，见 [[parallel-execution#^anc-exec-parallel-reap-drain]] | provisional |
| `DispatchReady` | 类型 | cli-types.ts | 派发信号形态（统一模型 subtask parallel：子树异步派发为子实例，step-dispatcher 消费；P2 复用模式 driver 消费）。2026-08-11 随 P0.5 新增 | provisional |
| `AdaptiveNeeded` | 类型 | cli-types.ts | adaptive replan 请求（engine 返回） | stable |
| `CommandResponse` | 类型 | cli-types.ts | done/fail/answer 通用响应（engine 返回） | stable |
| `VarsResponse` / `StatusResponse` / `ReplanResponse` | 类型 | cli-types.ts | vars/status/replan 命令响应（engine 返回） | stable |
| `AbortResponse` | 类型 | cli-types.ts | abort 命令响应（实例主动中止,2026-08-26 随 [[exec-engine#^anc-exec-abort]] 新增） | provisional |
| `AdminContext` | 类型 | hop-admin.ts | 管理面函数的机器侧事实（home / cwd / env / exec_path / login / hostname / roots）,两个组合根各自读进程状态装它（[[mcp-server#^anc-mcp-admin-tools]] HopSchema AdminContext） | provisional |
| `runDoctor` / `formatDoctorReport` / `DoctorReport` / `DoctorItem` / `DoctorStatus` | 函数 / 类型 | hop-admin.ts | 体检八问的本体与报告形态（^anc-cli-doctor;mcp-server `doctor` 工具与 cli `doctor` 子命令共用） | provisional |
| `antList` / `antInstall` / `antAdapt` / `antRemove` / `antBootstrap` / `antPack` / `antShare` | 函数 | hop-admin.ts | HopAnt 七动作的组合根无关业务体（^anc-cli-ant;mcp-server `ant_*` 八件之七与 cli `ant` 子命令共用;出错抛 `大写码:` 前缀 Error） | provisional |
| `AntResponse` / `AntScope` | 类型 | hop-admin.ts / hopant.ts | ant 七动作的统一响应形态（status / action / id / scope / 各动作字段;mcp-server adminCall 的泛型消费它,cli antShell 直接 output）;AntScope 是 `project | user` 两级标识（2026-10-10 0154+0155 工程链 review D6 补登——此前 export 在而表外） | provisional |
| `resolveCarrierHome` / `detectCarriers` / `installedHopDriverVersion` / `readSkillFrontmatter` / `readMcpRegistration` / `detectCcHopjitRegistration` / `ccFamilyRegistration` / `writeCcLocalRegistration` / `ccPermissionMissing` / `mcpHandshake` / `learnStandaloneEntry` / `localOwnerId` / `savedOwnerId` / `writeOwnerId` / `rewriteSpecId` / `Carrier` / `CARRIER_VALUES` / `carrierFamily` / `McpRegistration` / `McpHandshake` / `StandaloneEntry` | 函数 / 类型 / 常量 | hop-admin.ts | 载体探测与归属标识助手——setup（仍住 cli.ts）与 doctor / ant 共用;原在 cli.ts,随业务体搬出;cli.ts 对 tests 的既有导入面经 `export { … } from './hop-admin.js'` 转发保持可达 | provisional |

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
4. [branch] 按子命令路由到对应 Engine 方法（init/next/done/fail/status/vars/replan/resume/abort）
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

**工作区根取值（2026-10-04,英文文档批一实撞）**：`buildHostConfig` 把 `workspace_dir` 与 `sandbox.filesystem.workspace_dir` **都**设为 `process.cwd()` 的绝对路径——这是整个 run 唯一一次读 cwd。续推命令（submit/advance/reap/resume）经 `ExecutionEngine.load` 从 state.json 的 `host_context` 恢复这两个值,不再调 `buildHostConfig` 覆盖。原 `sandbox.filesystem.workspace_dir: '.'` 是相对写法,存盘后在每个续推进程里按该进程 cwd 展开,driver 换目录敲命令即把写权限边界带偏（契约与实撞见 [[sandbox#^anc-config-sandbox-workspace-root]]）。

**配置通路（2026-10-08 todo/0131 改为两级合并——作者 2026-09-30 定旧口径"复用模式不做配置合并"是 agent 自拟不是作者决定）**：`buildHostConfig(workspaceDir)` 经 [[config-load#^anc-config-reuse-consume]] 的 `loadReuseConfig(configPaths(homedir(), workspaceDir, HOPJIT_CONFIG))` 取系统级 `~/.hopjit/config.yaml` 与项目级 `hopjit.yaml` 的合并结果,装四样：`commands` → `sandbox.runtime.available`（执行契约权威 [[act-body#^anc-exec-subprocess-run]]）、`language` → `language` 与 `hop_env.hop_env_language`（^anc-i18n-language-config）、`env` → `hop_env` 底层（params 显式传的同名键后到覆盖,^anc-config-hop-env）、`resource_limits` → `resource_limits`。合并规则逐键表与容错两档权威在 [[config-load#^anc-config-two-level-merge]]——家目录与 cwd 只在本组合根读,算成路径后传入。
- 工具注册面同走两级：引擎工具工厂与 `tool-call` 经 `loadToolRegistry` 取合并后的 `tool_servers`（系统级条目相对 `~/.hopjit/` 解析——`setup --plus` 写进系统级的 websearch / playwright 复用模式从此可见）;原项目级单读 `readProjectCommands` / `readProjectLanguage` / `loadProjectToolRegistry` 三件退役；
- **容错档位两分照旧**（2026-09-11 review 勘正的分档,换成在合并结果上判）:commands 与 language 钝感（文件坏 YAML / 形状不符回缺省——空名单/en,stderr 记一行 warn,不炸 CLI;commands 含 hopjit 仍响亮拒 CONFIG_ERROR）;tool_servers 响亮（坏节 parseToolServers 拒,折 CONFIG_ERROR 退出码 1——工具注册错配静默回空会让声明的工具悄然缺席,拒载好过带病跑）。

## CLI 命令表【说明】

所有命令输出 JSON，面向 Agent（StepDispatcher）消费。

| 命令 | 路由到 | 响应类型 |
|------|--------|---------|
| `hopjit run <spec.md> [--workspace dir] [--approve-dirs] [--params json] [--context-mode full\|minimal] [--parallel-parent id --parallel-child cid] [--call-parent id --call-step ci]` | init_execution + completeAndAdvance 推进到首个 caller 介入点/终态。统一模型 worker 双入口（launch_command 拼装）：--parallel-* = subtask 子树收窄子实例（parallel/<ci>/）；--call-* = callee 全量子实例（calls/<ci>/，含 calls/ 段数深度检查 ^anc-exec-call-depth-check）——两入口 unifiedDispatch 门不开（嵌套退化）。**--call-* 误用闸（2026-08-14 e2e 实撞）**：--state-dir 尾段已是 `<call-parent-id>/calls` 形态（驱动方把协议 A〔init --parent 后对 `<STATE>/<INST>/calls` 走标准循环〕的目录喂给了协议 B 入口——本入口自拼 `<parent>/calls/`,再喂即双重嵌套,子实例跑死野目录而官方 calls/<ci>/ 恒 pending）→ 启动即拒,报 `CALL_PROTOCOL_MISUSE`,报文含两协议二选一指路（init --parent 建的子实例用标准循环驱动 vs run --call-parent 只用于引擎派发的 launch_command——src/cli.ts `run` 命令里的 `CALL_PROTOCOL_MISUSE` 判定）,不静默建嵌套目录。**--notify <渠道> 通知开关（^anc-cli-notify-reuse）**：flag 值=渠道名（现枚举只 dingtalk,非法值启动即拒）,记入实例 state 的 notify_channel（跨进程持久——复用模式每条命令新进程,内存标志活不过一条命令）,终态/停点经通知挂点二与门发送（渠道随话语走零配置文件,2026-08-31 作者定）。**HopLog 恒开**：`--log-dir` 缺省 `<state-dir>/../.hoplog`（轨迹=G11 核真过程凭证，不依赖 driver LLM 记得传参——2026-08-08 E2E 实撞 subagent 漏抄参数即无轨迹；对齐 mcp-server 恒开先例），显式传参可改址。**`--workspace <dir>` 工作区根显式指定（^anc-cli-workspace-arg）**：缺省取进程 cwd（既有行为）,显式传则以它为工作区（不存在即拒）;driver 应显式传会话启动目录,不依赖 Bash 当下 cwd。**`--approve-dirs` Config.dirs 清单起跑即批（^anc-cli-approve-dirs）**：不传则 workspace 外目录第一次要跑时停 paused/dirs 等人 | NextResponse（含 instance_id、workspace_dir） |
| `hopjit submit_and_fetch_next <step-id> --<参数>` | 按参数路由回写方法 → completeAndAdvance | NextResponse（成功）/ CommandResponse 错误码（不推进） |
| `hopjit reap_and_fetch_next <child-instance> --status completed\|failed` | 统一模型收割——**仅服务带 parallel 标注的派发**（引擎 dispatch_ready 吐出的 child,依赖派发时登记的在飞名册;无 parallel 标注的 [call] 用 `submit --child-instance`,分工判据见 [[parallel-execution#^anc-exec-reap-scope]]）：引擎读子实例目录取输出/FailRecord（reapParallelSubtask/Call）→ advanceToCaller;对从未派发过的 child 响亮拒 REAP_NOT_PARALLEL（^anc-exec-reap-misuse-reject） | NextResponse |
| `hopjit advance` | dispatch_ready 后续推主线（advanceToCaller 薄壳,仅渐进派发场景） | NextResponse |
| `hopjit debug_step [--instance id]` | ExecutionEngine.next_step（**调试用**，纯推进一步、不消化、不 advance） | NextResponse |
| `hopjit validate <spec.md> [--fragment] [--known-vars a,b]` | SpecParser.parse/parseFragment + validate_spec（不创建实例;片段模式见 ^anc-cli-validate-response 片段条款） | ValidateResponse |
| `hopjit tool-call <名> [--args '<json>'\|--args @file]` | CompositeToolProvider 全量注册面直调一件工具（复用模式 act free 的特殊工具执行通道——通道⑥,契约见 [[tool-channels#^anc-exec-tool-channels]]）:无实例无状态;requires_commit=true 恒拒;未知名报 UNKNOWN_TOOL 附注册面清单指路 | 工具结果 JSON（{success, result, ...}） |
| `hopjit list <dir>` | 扫目录 + parseSpec 解析 + 判定可执行 spec（不创建实例、无状态） | ListResponse |
| `hopjit init <spec.md> [--workspace dir] [--approve-dirs] [--params json\|@file] [--parent id] [--step call-step-id] [--child-instance id] [--trace id] [--upstream-feedback text\|@file] [--state-dir dir]` | ExecutionEngine.init_execution（**调试用**，正常启动用 run）。**--upstream-feedback 支持 `@file`**（引擎拼的 init_command 恒用文件形态传反馈,见 [[exec-engine#^anc-exec-cmd-args-file]]）。**--child-instance 给 call 子实例 ID**（决定子实例目录 `<父>/calls/<id>/`;缺席时取 --step 的值;--step 恒用于父引擎取参数映射——两者在 loop 里的串行 call 上值不同,见 [[exec-engine#^anc-exec-call-child-iter-id]]）。**路径身份两字段（specPath/cliAbsPath）与 run 入口对称传入**——漏传即 doc-ref 首级解析目录错位到 cwd（跨目录 init 报 P15 文件未找到）+嵌套 call 响应缺 call_protocol（buildCallProtocol 两字段任一缺席返 undefined），hopissues/0076 实撞 | InitSuccess \| InitError |
| `hopjit status [--instance id]` | ExecutionEngine.get_status | StatusResponse |
| `hopjit vars [--instance id]` | ExecutionEngine.get_vars | VarsResponse |
| `hopjit resume [--instance id]` | ExecutionEngine.recover → completeAndAdvance | NextResponse |
| `hopjit approve_commit <step-id> --fingerprint <指纹> --scope once\|task [--instance id] [--state-dir dir] [--workspace dir]` | ExecutionEngine.load → approveCommit（commit 转人工后记录人的选择的 CLI 入口,与 MCP 工具 `approve_commit` 同一引擎方法、同一批准账,契约见下方「commit 批准停点的 CLI 入口」条 ^anc-cli-approve-commit;不推进 run,批准后 `resume` 续跑） | CommitApproveResponse |
| `hopjit approve_dirs <dirs-hash> [--instance id]` | ExecutionEngine.load → approveDirs（Config.dirs 清单批准一次的 CLI 入口,与 MCP 工具 `approve_dirs` 同一引擎方法、同一批准账 `dirs_approvals.json`,契约 ^anc-cli-approve-dirs） | DirsApproveResponse（ok 臂带 dirs_hash / already_approved? / store_path;error 臂 code DIRS_NOT_APPROVED \| INVALID_STATE） |
| `hopjit abort [--instance id] [--reason text]` | ExecutionEngine.abort（实例主动中止,契约 [[exec-engine#^anc-exec-abort]]:非终态→aborted 持久幂等/completed·failed 拒改写/aborted 后一切推进命令墓碑拒;加载走 load 保留现场） | AbortResponse |
| `hopjit doctor` | 体检：装完 hop 之后一条命令答"能不能用"的八问（skill 在场 / 版本 / 菜单可见 / MCP 注册 / 握手 / 放行 / MCP server 模型配置 / 独立模式凭证）,每项一行 ok\|warn\|fail\|n/a + 指路;只报不改,修归 `setup`。任一 fail 退出码 1,否则 0（^anc-cli-doctor） | `DoctorReport` |
| `hopjit setup [--dir <目标>] [--carrier cc\|codex\|cfuse-cc\|cfuse-codex\|opencode] [--plus] [--mcp] [--force]` | 从包内 `driver/` 展开 skill 到目标（**旧名 `install-skill` 是隐藏别名**,不进 --help,调用时 stderr 提示改用 setup,保留一个版本周期,2026-10-06;**`--carrier` 缺席时自动探测本机在场的载体并逐个装**,一个都没探到才回落 cc,^anc-cli-carrier-autodetect;**缺省即注册 MCP server + 自举配置 + CC 放行 run_approved_command**,2026-10-01;`--mcp` 保留为显式别名）;用户可见 skill 只有 `hop`,其余五件装为内部件——目标按 carrier 解析（`--dir` 覆盖；`cc`/`codex` 读官方环境变量 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 自动适配当前环境,`cfuse-cc`/`cfuse-codex` 固定 cfuse home,详见 ^anc-cli-carrier-home-resolution）；演示件缺省装为 HopAnt（`~/.hopjit/ants/demo-*`,与载体无关,见本命令契约第 8 项;`--demo` 是隐藏的无作用参数,保留一个版本周期）；Codex 旧项目级残留检测→`legacy_note`；不涉引擎状态 | InstallSkillResponse |
| `hopjit schema-sep <spec.md>` | parseSpec + convertSchemaSeparators + validateSpec（把 HopSchema 名/类型分隔符从 `:` 原地改成 ` % `,先备份;不创建实例、不调 Engine,契约见 ^anc-cli-schema-sep） | SchemaSepResponse |
| `hopjit pack <spec.md> [--carrier cc\|codex\|cfuse-cc\|cfuse-codex\|opencode] [--dir <目标>] [--name <skill名>] [--assets <逗号分隔文件>] [--force]` | 把一个 hopskill spec 打包成载体对应的**独立具名 skill**（CC 系 `/skill`；Codex 系 `$skill`；`cfuse-*` 复用对应原生系的包装模板,仅目标 home 不同） | PackResponse |
| `hopjit ant install <目录> [--dry-run] [--scope user\|project]` / `ant adapt <id>` / `ant list` / `ant remove <id> [--keep-store] [--scope user\|project]` / `ant bootstrap <id> [--dry-run]` / `ant pack <spec> [--out <dir>] [--id <id>] [--assets <文件>…]` / `ant share <id>… [--out <dir>] [--name <包名>] [--pkg-version <v>] [--owner <标识>\|--yes]` | [[hopant]] 模块（HopAnt 安装/配置适配/本机索引/卸载/封装/分享;组合根只取 home、两级配置、PATH、git 用户名、主机名、引擎版本后注入——契约 ^anc-cli-ant） | AntResponse |

**USAGE.md 是本表的人读版（2026-10-10 作者定 USAGE 定位——"要不明确就是 cli 的 usage？写明供 agent 参考,供人 debug 用？同时讲清楚 /hop 呼叫的对应关系"）**：仓库根 `USAGE.md`（随 npm 包分发）是 `hopjit` 命令行手册,读者两种——agent 在 hopjit MCP 工具不可用时按它命令行回退（每条命令对应一个同名 MCP 工具,响应相同）,人在 /hop 出问题时按它排查;日常用户走 /hop,不需要读它。四条约定：①**与本表同源**——命令增删改时 USAGE 的分组速查同批改,清单以 `hopjit --help` / `hopjit ant --help` 实况为准,参数从本表抄;机检只管 USAGE 在场（release-engineering 入口六件）不管语义,语义靠本条与阅卷;②**/hop 话语→命令→MCP 工具的对应表**权威出处是 driver/hop-skill.md §2（驱动工具与同名子命令是同一套引擎调用）与 [[mcp-server#^anc-mcp-tools]] 工具面表,USAGE 只抄不另编;③对应表里"升格任务卡"（hop-skill §2,执行在主对话）与"跑现成 spec / HopAnt"（hopspec-skill §1,主 agent 编排、执行段外包 subagent）两条路分行写,执行姿态各按自己的 skill,不混;④USAGE 不写任何教用户日常手敲命令的内容——用户说"体检一下",/hop 去跑 `doctor`,用户不需要知道命令名（[[#^anc-cli-hop-dispatch]] /hop 是唯一用户入口）。

**`submit_and_fetch_next` 的互斥参数**（driver 主循环唯一应答命令，提交内容由参数区分）：
- `--output <json>` — reason/check/act 结果回写 → complete_step
- `--answer <json>` — confirm 决策注入 → complete_step（confirm 规范化）
- `--child-instance <id>` — call 子实例回填 → complete_call_step。**无 parallel 标注 [call] 的设计期望收割命令**——普通 call 与串行 for-each loop 体内的 call 都用它（loop 场景由 completeStep 级联做 collect 累积与迭代推进）;带 parallel 标注的派发才用 reap_and_fetch_next（分工判据 [[parallel-execution#^anc-exec-reap-scope]]）
- `--failure <reason>` — 步骤失败 → fail_step（自由文本，非 call 场景）
- `--failure-child <id>` — call 子实例失败 → fail_call_step（2026-08-09 与 done 对称的机器通道：引擎读子实例失败记录组装结构化 CalleeFailure、继承 fail_kind——驱动方从"总结失败"退化为"报告子实例 ID"）
- `--replan <md>` — 重规划 children → submit_replan

各参数互斥（一次提交一种）。回写成功 → completeAndAdvance 推进返回 NextResponse；返回错误（SCHEMA_MISMATCH/INVALID_STATE）→ 原样返回不推进；**ALREADY_DONE 是 ok 回执即终点**（hopissues/0056——幂等重发直返结构化成功报文〔含"引擎在等步 Y"欠账指引〕不推进，不是错误形态；契约见 [[shared-types#^anc-cli-idempotency]]）。

**`hopjit abort` 契约**：加载走 load 保留现场（中止不需要 recover 的悬空重置）→ claimDriverChannel 双执行硬闸 → ExecutionEngine.abort(reason)。中止不可逆，快照与 hoplog 保留可检视；终态语义契约见 [[exec-engine#^anc-exec-abort]]。 ^anc-cli-abort

**HopLog 恒开契约**：CLI 侧 hoplog 不设开关——缺省落址 `resolve(<state-dir>/../.hoplog)`，`--log-dir` 显式传参可改址，但无论是否传参轨迹恒记录。轨迹是 G11 核真过程的凭证，不能依赖 driver LLM 记得传参（2026-08-08 E2E 实撞：subagent 漏抄模板参数即无轨迹假红；对齐 mcp-server 恒开先例）。 ^anc-obs-hoplog-always-on

**`hopjit list <dir>` 契约** ^anc-cli-list：扫描单个目录的直接 `.md` 文件（不递归），对每个文件 `parseSpec` 后判定是否为**可执行 spec**，输出清单。无状态、不创建实例、纯函数（同一 dir → 同一输出，便于测试与跨 runtime 复用）。
- **可执行 spec 判定**（三条全满足）：① `ast.header.goal` 非空；② `ast.steps` 非空（有 Steps）；③ **排除设计文档**——原文含 `%% @trace` 头、或路径段含 `design/`、或含 `## impl ` 段（这些的 Steps 是 impl 伪码示例，非可执行 spec）。解析失败（parseErrors）的文件跳过、不计入。
- **输出 ListResponse**：`{ status:'ok', dir, specs: [{ file, id, goal }] }`——`file` 为文件名（非全路径），`id`=`ast.header.id`（缺省用 title），`goal`=Goal 首句。排序由 caller（skill）按 recent-dirs 决定，引擎按文件名稳定排序即可。
- **recent-dirs 不归引擎**：LRU 偏好记录（`.hopspec/recent-dirs.json`）+ 首次"问用户搜哪个目录"的交互留 skill。引擎不假设 `.hopspec/` 布局——只接收一个明确 dir、吐该 dir 的 spec 清单（对齐概念层"引擎核心不假设文件系统布局" [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 推论）。

**`hopjit setup` 契约** ^anc-cli-install-skill：装完 npm 包之后，把 hop 接进用户机器上的 coding agent。setup 不创建引擎实例、不读写 `.hopstate`；它写的全部是载体与 hopjit 的配置文件和 skill 文件。职责按执行顺序共八项，每项的细则见下方对应子条：

| # | 职责 | 写到哪里 | 作用域 | 什么时候不写 |
|---|---|---|---|---|
| 1 | **选载体**：`--carrier` 给了只装那一个；只给 `--dir` 按 cc 装；都没给则探测本机所有载体 home，探到几个装几个，一个没探到按 cc 装 | 不写文件 | — | — |
| 2 | **装 skill**：hop、hopspec、hopspec-mcp、hopbuild、hopbuild2、hopfix 六件，用户菜单里只出现 `/hop`；SKILL.md 注版本戳 | `<载体 home>/skills/`（或 `--dir`） | 用户级 | 目标已存在且没带 `--force` |
| 3 | **自举 standalone 配置**：学习宿主 agent 的模型、端点与凭证名（只写凭证名，不写值） | `~/.hopjit/config.yaml` | 用户级 | `~/.hopjit/config.yaml` 或 `<cwd>/hopjit.yaml` 已存在；学习源缺失 |
| 4 | **注册 hopjit MCP server，并做握手自检**：注册（或已有注册）之后拉起一次 `hopjit-mcp`，走 initialize 与 tools/list 后退出，起不来就在 `mcp_handshake` 里报原因与修法（^anc-cli-install-skill-handshake） | CC：`<cwd>/.mcp.json`；Codex：`<Codex home>/config.toml`；opencode：用户级 opencode 配置的 `mcp.hopjit`（`enabled:true`）+ 同文件 `tools` 节关独立模式五件（^anc-cli-opencode-tools-gate）；自检不写文件 | CC 项目级；Codex、opencode 用户级 | 任一 scope 已有 hopjit 条目（`--force` 也不覆盖）（postinstall 钩子 2026-10-09 已撤,原"postinstall 阶段跳过"条件不再存在） |
| 5 | **放行 hopjit 的 MCP 工具**（仅 CC 与 cfuse-cc）：`HOPJIT_ALLOWED_TOOLS` 清单里的每个工具，即 hopjit 注册的全部工具 | `<cwd>/.claude/settings.local.json` 的 `permissions.allow` | 项目级 | 清单条目都已在；文件结构不合法。其他载体只给 `permission_note` 指路 |
| 6 | **扫描旧位置的陈旧副本**：本器自带件的陈旧副本整目录挪进备份区，用户自建件只提示（^anc-cli-stale-skill-scan） | `~/.hopjit/stale-backup/<时间戳>/`，结果报在 `stale_notes` | 用户级 | 没有发现陈旧副本；挪动失败时退回只提示 |
| 7 | **装演示 HopAnt**：由包内三份演示原件生成 `demo-coffee-week`、`demo-fact-check`、`demo-rename` 三个 HopAnt，与载体无关，每次 setup 只做一次 | `~/.hopjit/ants/demo-*/`，并重建 `~/.hopjit/ants/index.md` | 用户级 | 同 id 已存在（`--force` 也不覆盖） |
| 8 | **回报结果并指路**：逐载体结果、各项 note、`next_step` 指向包内 AGENT-GUIDE 与项目指令模板 | stdout | — | — |

选项附加一项，缺省不做：`--plus` 加装两个研究 skill 并把它们的 tool_servers 合并进 `~/.hopjit/config.yaml`（^anc-cli-install-skill-plus）。`--demo` 已无作用：演示件改为第 7 项缺省安装后，该参数只为兼容旧脚本与旧文档保留一个版本周期，不出现在 `--help` 里，传与不传结果相同。

setup 恒不做的事：
- 不覆盖用户已有的配置条目：MCP 注册、standalone 配置、放行条目、已装的演示 HopAnt 已存在时一律跳过，`--force` 只管 skill 文件；
- 不删除不归本器管的文件：`--force` 只删上次安装清单里有、这次源里已没有的文件；旧位置的本器自带件陈旧副本挪进备份区而不删除，用户自建件只报告；
- 不写用户项目的指令文件（CLAUDE.md / AGENTS.md）：`next_step` 只建议，贴不贴由用户决定；
- 不阻断于环境问题：注册、自举、放行遇到家目录不可写之类的环境失败只留 note，skill 照装；用户配置文件内容损坏（如 `.mcp.json` 不是合法 JSON）才报错退出，避免覆盖用户文件。

**作用域分两类，决定了在哪个目录跑**：第 2、3、7 项与 Codex、opencode 的注册是用户级，在任何目录跑结果都一样；CC 的注册（第 4 项）与放行（第 5 项）写在 `<cwd>` 下，必须在用户项目根目录跑才落到对的位置。postinstall 的 cwd 是 npm 包目录，所以跳过这两件；/hop 第一次在某个项目里运行时检查 `.mcp.json`，缺 hopjit 条目就在该项目里补跑一次 setup（^anc-cli-postinstall）。setup 全程幂等，重复运行只补缺的部分。

setup 最初的职责只有第 2 项：包内主文件名（如 `hopspec-skill.md`）与载体的 skill 发现布局（`<name>/SKILL.md`）不一致，需要展开拷贝。第 3、4 项于 2026-10-01 改为缺省执行，第 5 项同日加入，第 1 项的自动探测于 2026-10-03 加入；第 4 项的握手自检与第 5 项放行面扩为全部工具于 2026-10-07 加入（todo/0146;同日 approve_commit 也并入放行清单,commit 的人批准改由 driver 在对话里问）。
- **命令名 setup，旧名 install-skill 退役为隐藏别名（2026-10-06 作者定，todo/0143）**：npm 12 起默认拦截依赖包的安装脚本，postinstall 在多数新机器上不执行，安装主路因此改为两条命令 `npm install -g @hoplogic/hopjit` 加 `hopjit setup`。对外的命令名是 `setup`；锚点名 `anc-cli-install-skill*`、响应类型名 InstallSkillResponse、报错前缀 `INSTALL_SKILL_ERROR:` 是内部标识，不随之改名。
  - 旧名 `install-skill` 保留一个版本周期作为隐藏别名：不出现在 `--help` 的命令列表里；接受与 setup 完全相同的选项，行为与 stdout 输出完全相同；调用时向 stderr 打一行 `[hopjit] install-skill 已改名为 setup，请改用 hopjit setup（旧名将在后续版本移除）`。保留的原因：用户机器上已装的旧版 driver 文本写的是 `hopjit install-skill`，引擎升级后 driver 还没刷新的那段时间仍会调旧名。
  - 两个名字共用同一个 action 函数，选项定义只写一处，不复制。
  - 正例：`hopjit setup --carrier codex` 与 `hopjit install-skill --carrier codex` 的 stdout 相同，后者 stderr 多一行改名提示；反例：`hopjit --help` 的输出里有 setup，没有 install-skill。
- **包根定位**：用 `import.meta.url` 解析 cli.js 自身路径 → 包根 = `dist/../`（不依赖 cwd，全局/本地装都对）。
- **两载体清单对等：构建工具随装（hopissues/0052,2026-08-31——实现遗漏修正;2026-09-15 todo/0093 件二扩员 hopfix）**：`hopbuild`/`hopbuild2`/`hopfix` 三件住包内 `skills/` 聚合目录,**载体中立**（构建工具非载体驱动件——cli.ts 拷贝点注释自始明示）,CC 与 Codex 分支**都装**。修前 Codex 分支漏拷两件（同一命令两载体能力不对等,Codex 用户装完无 /hopbuild 可用——报告方实撞）。
  - 版本戳口径:与 CC 分支同源对齐——copyDir 拷入后对两件的 SKILL.md 走 stampSkill 注版本戳（CC 分支 2026-08-25 起即如此,对齐=清单与戳都齐;设计首稿误记"CC 不注戳",4.2 实现时对码纠正）；
  - 正例:codex 载体装出 hopbuild/hopbuild2 两目录;反例回归:CC 载体清单不因本修变化；
  - hopfix 特殊性:hopspec skill 形态——壳 SKILL.md 之外流程真源 `scripts/hopfix/hopfix.md` 拷入装载目录成自足件,SKILL 内执行命令按装载形态指本目录 hopfix.md;版本兼容三义务的迁移通道消费面,^anc-release-version-compat 义务③——其"版本迁移对照"知识节随每次破坏性收严更新
- **目标按 carrier 解析（`--dir` 覆盖；2026-09-02 加 cfuse 载体 + 读官方环境变量,见 ^anc-cli-carrier-home-resolution）**：`--dir` 显式指定 skills 根目录时直接用;缺席时按 `--carrier` 映射到对应载体 home 下的 `skills/`。
  - 映射表：`cc`→`$CLAUDE_CONFIG_DIR/skills`、`codex`→`$CODEX_HOME/skills`、`cfuse-cc`→`~/.codefuse/engine/cc/skills`、`cfuse-codex`→`~/.codefuse/engine/codex/skills`、`opencode`→`$OPENCODE_CONFIG_DIR/skills`（环境变量缺席回落 XDG `~/.config/opencode/skills`）；
  - `cc`/`codex` 的环境变量缺席时回落 `~/.claude`/`~/.codex`（原生默认,与 2026-08-27 作者定"codex 和 cc 看齐=用户级"一致）。

- **载体 home 解析（2026-09-02 作者定:cfuse 内置载体适配）** ^anc-cli-carrier-home-resolution：hopjit setup 原硬编码 `~/.claude/skills` 与 `~/.codex/skills`,在 cfuse 环境下装错位置。
  - 错位原因：cfuse 内置的 Claude Code / Codex 通过官方环境变量 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 把 home 重定向到 `~/.codefuse/engine/{cc,codex}/`,skill 从重定向后的 home 读。
  - **两条安装路径必须都覆盖**:
  - **场景一:在目标 agent 会话里跑 setup**（最常见——hoplogic3 是 agent 工具,用户在 cc/codex 会话里让 agent 装）。此时进程继承目标 agent 注入的环境变量,`--carrier cc`/`codex` 读 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 即自动装到目标 agent 的 home（原生或 cfuse 重定向均可）。用户视角:cfuse 内置窗口表现为原生载体,按该载体的原生命令跑即可,无需特殊 cfuse 命令。
  - **场景二:裸终端跑 setup,目标 agent 未启动**。此时无环境变量,且 hopjit 无从知道用户接下来要启动哪个 agent——环境变量只能反映"当前在哪",不能反映"装给谁",信息缺失。`--carrier cc`/`codex` 缺席环境变量时回落 `~/.claude`/`~/.codex`（原生默认）,若用户其实要装给 cfuse 内置载体就装错。
  - **解法:carrier 扩展为 `cc | codex | cfuse-cc | cfuse-codex | opencode`**。`cc`/`codex` 读官方环境变量（场景一自动适配当前环境）;`cfuse-cc`/`cfuse-codex` **不读环境变量**,固定 `~/.codefuse/engine/{cc,codex}/skills`（场景二裸终端显式指定 cfuse 目标）。读环境变量会与"裸终端指定 cfuse"的意图冲突——用户显式选了 cfuse carrier 就是声明目标,不该被当前进程环境（可能空、可能恰好是别的 home）覆盖。
  - **driver 源复用,不新写**:`cfuse-cc` 与 `cc` 共用 CC driver 源（`driver/hopspec-skill.md` 等）,`cfuse-codex` 与 `codex` 共用 Codex driver 源（`driver/codex/` 等）——cfuse 内置载体是 CC/Codex 本体套壳,skill 格式完全一致,仅 home 不同。代码层用 `carrierFamily(carrier)` 派生 driver 源系别（`cc`|`codex`）。
  - **`~/.codefuse` 硬编码可接受**:与硬编码 `~/.claude`/`~/.codex` 同性质（该工具的约定默认 home）;若 cfuse 未来提供 home 环境变量,`resolveCarrierHome` 的 cfuse 分支顺带读它。
  - **适用范围**:本条款的 home 解析同样适用于 `--mcp` 配置自举（CC 系读 `<home>/settings.json`、Codex 系读 `<home>/config.toml`）、MCP 注册（Codex 系写 `<home>/config.toml`）、`detectCcHopjitRegistration`（CC 系读 `<home>/.claude.json`）——所有按载体 home 定位的路径统一走 `resolveCarrierHome(carrier)`,不各自硬编码。
  - 正例:cfuse 用户在 cfuse 内置 cc 会话里 `hopjit setup`（零参数）→ 读 `CLAUDE_CONFIG_DIR` 装到 `~/.codefuse/engine/cc/skills`;裸终端 `hopjit setup --carrier cfuse-cc` → 装到 `~/.codefuse/engine/cc/skills`。
  - 反例:裸终端 `hopjit setup`（零参数,无环境变量）→ 回落 `~/.claude/skills`,cfuse 内置 cc 读不到（用户须显式 `--carrier cfuse-cc` 或在 cfuse 会话里跑）。
- **opencode 载体（2026-09-15 加,见 todo/0089）**：opencode 是独立载体家族（非 CC/Codex 套壳）,home 用 XDG——`OPENCODE_CONFIG_DIR` 重定向 config 目录,缺席回落 `$XDG_CONFIG_HOME/opencode`（默认 `~/.config/opencode`,**不是** `~/.opencode`）。与 cfuse 的两点关键不同:
  - **driver 源=driver/opencode/ 自有内容层**（2026-09-19 改判,原'复用 CC 不新写'废）：skill 展开走 opencode 专属分支装 `driver/opencode/` 原语适配版（权威 [[opencode-driver-carrier#^anc-driver-opencode-primitive-map]]）。
    - 改判缘起：作者抓'opencode 完全复用 cc 的?'——发现层兼容（`<name>/SKILL.md`+frontmatter 同构,opencode 甚至主动兼容 `~/.claude/skills/`）**不等于**执行层可用,CC 正文 30 处 CC 专属原语（AskUserQuestion/driver subagent/task-notification）对 opencode 无协议保证,真机能通靠模型自由发挥；
    - hopbuild 族照旧共装;hop 件照装（2026-09-20 作者撤销"不装",见 [[opencode-driver-carrier#^anc-driver-opencode-install-layout]];本句 2026-10-01 review 随 :310 六件全装条款清旧文）;`carrierFamily('opencode')='cc'` 仅余 pack/--plus 包装模板选型语义——放行判据不得借它。
  - **MCP 注册与 LLM 自举形态不同,须单独分支**:opencode 把所有配置（含 MCP）集中在 opencode 配置文件（`opencode.jsonc`/`opencode.json`/`config.json`,opencode 加载 deep-merge 三者、`.jsonc` 优先;非 TOML/YAML）,无独立 `.mcp.json`。
    - hoplogic3 跟随 opencode 配置管理——写 `opencode.jsonc`（opencode 标准,globalConfigFile candidates[0]）,用 jsonc-parser 保留注释（opencode 同款 modify/applyEdits）;检测 candidates `[opencode.jsonc, opencode.json, config.json]` 查 mcp.hopjit;坏 JSON best-effort 不阻断；
    - MCP 条目 `mcp.<name> = { type:"local", command:[...], environment:{...} }`（`command` 是 command+args 合并的数组、`type` 必填、env 字段叫 `environment` 非 `env`）；
    - LLM 配置也在 opencode 配置文件（`model`=`"provider/model-id"`、`provider.<id>.options.baseURL`/`apiKey`、`provider.<id>.env` 凭证名数组）。
  - **skill 展开走 opencode 正路**（作者 2026-09-15 拍,不借道 `~/.claude/skills/`）:落 `<opencode home>/skills/<name>/SKILL.md`（用户级 `~/.config/opencode/skills/`）,opencode 原生发现路径（`{skill,skills}/**/SKILL.md`）。
    - 不借道 `~/.claude/skills/` 的理由:该红利只在原生 CC home（`~/.claude`）成立——cfuse-cc 装在 `~/.codefuse/engine/cc/skills` opencode 读不到（opencode 只扫 `$HOME/.claude`,不读 `CLAUDE_CONFIG_DIR`）,依赖巧合不可靠;走 opencode 正路所有场景一致。
  - **--mcp 注册（opencode 分支）**:写**用户级** opencode 配置（candidates `[opencode.jsonc, opencode.json, config.json]` 第一个存在,对齐 opencode globalConfigFile;都不存在用 `opencode.jsonc`）的 `mcp.hopjit`——`{ type:"local", command:["hopjit-mcp"], enabled:true, environment:{} }`,并在同一文件顶层 `tools` 节把**独立模式专属工具**逐个写 `false`。 ^anc-cli-opencode-tools-gate
    - **enabled:true + tools 节关独立模式工具（2026-10-08 todo/0134 作者拍 b 案,翻 2026-09-15 的 enabled:false）**：2026-09-15 定 enabled:false 的立意是防复用模式下 LLM 自决调 `hopjit_start_run` 劫持执行（opencode 无 MCP 工具优先机制,MCP 工具与内置工具平级注入同一工具字典,session/tools.ts:390-490 无优先级/权重,skill 指令拦不住——hopissues/0099）。todo/0146 之后复用模式**需要** server 活着：任务卡《已批准命令》经 `run_approved_command` 执行、驱动七件走 MCP 工具,都要 server 在。同一个 `enabled` 开关管两类工具,一类要关一类要开。翻案依据=opencode 官方文档（opencode.ai/docs/mcp-servers）核实：MCP 工具按 `<server>_<tool>` 命名,全局 `tools` 配置支持按工具名关闭（`"tools": {"hopjit_start_run": false}`）且 server 保持开启。于是 server 开着,只把会劫持的那几件关掉——两全。
    - **关哪些**：独立模式专属工具 = hopjit MCP 注册面全部工具 减去复用模式要用的件（驱动七件 `run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `status` / `resume` / `abort` / `validate`,批准面 `approve_commit` / `approve_dirs` / `run_approved_command`,两模式共用的 `server_status`,管理八件 `doctor` / `ant_*`——2026-10-10 todo/0154 加入,体检与 HopAnt 生命周期动作两模式都要）。按现行注册面机械求差得 `start_run` / `run_status` / `resume_run` / `list_runs` / `stop_run` 五件。代码里用导出常量 `OPENCODE_DISABLED_TOOLS`（provider-types,与 `HOPJIT_ALLOWED_TOOLS` 同处）列死这五件并注明求差口径,不在运行期算——装配器不该为了求差去 import mcp-server 的注册面;mcp-server 新增独立模式专属工具时同批改这里（测试钉：常量 ⊆ 注册面且与驱动七件 + 批准三件 + server_status 零交集）。写进 `tools` 节的键形态是 `hopjit_<工具名>`。
    - **幂等与用户键**：`tools` 节按键逐个 `jsoncModify`,只写缺席或值不为 false 的键,用户已有的其他键一个不动;`mcp.hopjit` 已存在时按下一条"已有条目三分"处理,其中用户自配与已是现行形态的两种整条跳过,也不改 `tools` 节（用户既然自己配了 server,tools 节也归用户）。
    - **已有 `mcp.hopjit` 条目三分（2026-10-11 作者抓"普通用户会手工翻么？这是 hopjit 自己的 mcp service"）**："已有条目跳过"保护的是**用户**资产,hopjit 自己写的旧形态条目不是用户资产,由 setup 自己升级,不能跳过后让 doctor 叫用户手工翻。判据是条目的 `command`：
      1. `command` 不是 `hopjit-mcp`（用户自配,例如指到自己的包装脚本）→ 整条跳过,`tools` 节不动,`mcp_note`"已有条目未改动";
      2. `command` 是 `hopjit-mcp` 且 `enabled` 不为 false（现行形态）→ 跳过,`tools` 节不动（用户为走 standalone 把 `hopjit_start_run` 改回 true 后重跑 setup,不被翻回）;
      3. `command` 是 `hopjit-mcp` 且 `enabled: false`（2026-09-15 至 2026-10-08 之间 setup 写的旧形态,本机 2026-10-11 实撞）→ **升级**：`enabled` 改 true,并按上条幂等规则补 `tools` 节五键（旧形态没有 tools 门,不补等于把 start_run 劫持风险重新放出来）,其余键不动;`mcp_note` 写明"旧形态升级"。
      实例：本机 opencode.json 里 `mcp.hopjit = {type: local, command: [hopjit-mcp], enabled: false, environment: {}}`,是 todo/0134 之前的 setup 写的;修前 setup 按"已注册"跳过,doctor 报 warn 并让用户改文件——普通用户不会去改,也不该改。错误后果：opencode 里 hopjit 的 MCP 工具永远不可达,/hop 退回命令行逐条弹窗。
    - 走 standalone（hopspec-mcp）时用户把 `tools` 节里 `hopjit_start_run` 等五键改 `true`（或删掉）即可,注册 note 明示;不再有"把 enabled 改 true"这一步；
    - `environment` 留空 `{}`:opencode 启动 local server 时 `env = { ...process.env, ...mcp.environment }`,process.env 透传凭证（与 CC `.mcp.json` 只放 command、靠会话 env 透传同思路,守 standalone 不变量第 1 条"只写名不写值"）；
    - **jsonc-parser modify/applyEdits 保留原格式+注释**——hoplogic 对所有候选文件统一 jsoncModify（opencode 仅 .jsonc 用 patchJsonc,非 .jsonc 用 stringify 重新格式化;hoplogic 统一 jsoncModify 更优雅——保留原格式不重新格式化用户文件,是"高质量优雅"取舍,不严格跟随 opencode 非 .jsonc 的 stringify）；
    - **检测 candidates 查 mcp.hopjit**（.jsonc/opencode.json/config.json 任一已有则跳过——opencode global deep-merge 任一有即生效,消除"只查一个文件漏其他"的静默冲突）；
    - 坏 JSON best-effort 不阻断 skill 安装（与 cc 分支 .claude.json 解析失败同纪律）;已有 `mcp.hopjit` 条目按"已有条目三分"——用户自配与现行形态跳过（与 cc/codex 同纪律,--force 不覆盖注册面）,hopjit 自己写的 `enabled:false` 旧形态升级；
    - 用户级而非项目级:与 install-skill 主体（用户级 skill）+ Codex（用户级 config.toml）对齐,跟人走不污染项目。
  - **LLM 配置自举（opencode 分支）**:**deep-merge 三文件**（opencode 加载顺序 `config.json → opencode.json → opencode.jsonc`,后者覆盖、`.jsonc` 优先,与 opencode 加载一致;jsonc-parser parse 含注释）。
    - 学习字段：取 `model`（`"provider/model-id"` 拆出 provider id+model id）+ `provider.<id>.options.baseURL`（base_url）+ `provider.<id>.env[0]`（api_key_env 凭证名,opencode provider 定义声明该 provider 接受的 env var 名）；
    - protocol **忠实照抄 `provider.<id>.npm` 字段**（0020 批改定 2026-09-20,作者问"opencode 自己是怎么判定用 chat 还是 responses"查实——npm 字段就是 opencode 的 wire_api 等价物:它声明该 provider 用哪个 AI SDK 驱动,官方文档明定 `@ai-sdk/openai`→`/v1/responses`、`@ai-sdk/openai-compatible`→`/v1/chat/completions`、`@ai-sdk/anthropic`→Anthropic 原生）；
      - 映射:`@ai-sdk/anthropic`→anthropic / `@ai-sdk/openai`→openai-responses / `@ai-sdk/openai-compatible` 及其余→openai-chat；
    - npm 字段缺席（内置 provider 不写 npm——协议定义在 opencode 内置注册表不在用户配置文件,抄不到）回退 provider id 推断:含 `anthropic`→anthropic,否则保守取 openai-chat（猜错代价不对称:猜 responses 撞无此面的端点=启动即炸,猜 chat 最坏少用好通道）；
    - 写入系统级 `~/.hopjit/config.yaml`,`service_id=opencode_host`,只写凭证名不写值；
    - 学习源缺失（三文件都不存在/坏 JSON/无 model/provider）→不写文件,note 明示需自建（与 cc/codex 同纪律;坏 JSON best-effort 不阻断,与 --mcp 注册同纪律）。
  - **装载清单对等**:opencode 走 CC 分支,`hopspec`/`hopspec-mcp`/`hopbuild`/`hopbuild2`/`hopfix` 全装（含 0093 件二 hopfix,载体中立件随 CC 分支）。
    - **hopbuild 族装时改写副本**（PR#8（贡献者合未）,经 opencode 1.18.31 源码核实——hopissues/0101）:hopbuild/hopbuild2/hopfix 从 CC 源拷贝后,把 SKILL.md 副本的 `/hopspec run ` 改写为 `用 hopspec skill 执行 `（装时改副本,不改 CC 源）；
      - 为什么改写:opencode 有斜杠命令系统（/hopspec run 可工作,command/index.ts:134-152）,改写非修功能失效——是对齐原语映射"斜杠触发→隐式触发"+LLM 消费友好度（hopbuild SKILL.md 由 LLM 消费,经 skill 工具隐式触发更直接）；
      - 豁免注记:hopfix/hopfix.md 正文不在改写面——其 `/hopspec run` 出现在 spec body 字符串字面量内,改写会变更 spec 产出文本,豁免（联审裁定 2026-09-21）。
- **展开动作**（CC 载体，`--carrier cc` 默认，`opencode` 同走本分支）：
  - `driver/hopspec-skill.md` → `<目标>/hopspec/SKILL.md`（**改名**为 SKILL.md）
  - `skills/hopbuild/` → `<目标>/hopbuild/`（整目录，其 SKILL.md 已对名）
  - **旧名目录清理（rename 残留清理）**：CC 分支尾部检查 `<目标>/hopskill-build/`（hopbuild 的改名前旧目录名）——存在即 `rmSync` 整目录删除，并在 `installed` 清单记一条"旧名残留已清理"（src/cli.ts `install-skill` 命令 CC 分支的 `legacy` 清理段）。定性：这不是受管目录 manifest 清理（那套只删自己 manifest 里的 `.md`），而是 hopskill-build→hopbuild 一次性改名的残留兜底——旧名 skill 残留会与新名双触发。
  - `driver/references/` → `<目标>/hopspec/references/`（**随 skill 拷贝**，使 skill 自包含，不依赖 `<PKG>` 探测能否回指 node_modules——用户可能只装 skill 未装包，或全局装路径探测失败）。
    - 拷贝后 skill 内 `<PKG>/driver/references/` 引用由自举探测解析：探到包→引包内；探不到→引 `.claude/skills/hopspec/references/` 本地副本作兜底；
    - references/ 是受管目录，`--force` 时清除源里已不存在的残留 `.md`（条款见下方 Codex 段"受管目录清理"——两载体同一契约）。
  - 三载体 `hop` 件都附装 `driver/<载体>/hop-references/hop-ops.md`（CC 源在 `driver/hop-references/`）→ `<目标>/hop/references/hop-ops.md`——运维规则按需读件,[[#^anc-cli-hop-dispatch]];三份同文由机检守,条款见下「三载体 hop-ops.md 字节同文」;
  - `--carrier codex`：按 [[codex-driver-carrier#^anc-driver-codex-install-layout]] 展开**按 agent 主体拆分**的 Codex skill：
    - `driver/codex/SKILL.md` → `<目标>/.agents/skills/hopspec/SKILL.md`
    - `driver/codex/agents/` → `<目标>/.agents/skills/hopspec/agents/`
    - `driver/codex/references/` → `<目标>/.agents/skills/hopspec/references/`
    - `driver/references/cli-discovery.md` → `<目标>/.agents/skills/hopspec/references/cli-discovery.md`
    - **不复制**公共 `driver-subagent.md` / `parallel-worker.md` / `step-execution-rules.md` / `discovery.md`；这些文件含 CC 载体原语，Codex 使用自己的 agent 与 reference 文件。
    - **受管目录清理（2026-08-13 立实撞销账;2026-08-24 hopissues/0022 改判据为自有安装清单——方案甲作者拍板）**：`references/`（CC/Codex）与 `agents/`（Codex）是**受管目录**。**受管的边界=清单不是目录**：安装器每次装机在受管目录落 `.hopjit-manifest.json`（本次写入的 `.md` 文件名列表+版本戳）。
      - `--force` 清理**只删"上次 manifest 里有、本次源里已没有"的文件**——自己上版装的陈旧残留照删（2026-08-13 立意完整保留:parallel-worker.md 残留喂废协议致真机 41s 读废文档、健康活被 dispatch-lost 误杀）；
      - **用户/别的工具放的文件天然豁免**（不在任何 manifest 里=不是我写的=无权删。原判据"源目录补集"把'受管目录'误解成'目录里所有 .md 都归我管'——probe 实证用户笔记 my-note.md 被无声 rmSync,且 dev-install.sh 缺省带 --force 让日常装机天然走此档;同一个 --force 同时表达'覆盖我的同名文件'与'删除我的非同名文件'两种强度悬殊的授权,后者现在收窄到零越权面）；
      - **manifest 缺席（首次装/旧版装机）按空清单处理=零删除**,本次装机落新 manifest 后下次清理恢复正常——存量残留经一次正常装机周期自然进入清单管辖；
      - 响应 `removed` 字段列出实删项;非 force 不删（与"存在即跳过"对称）。清理只限受管目录、只删 manifest 内 `.md`——SKILL.md 顶层与用户其它 skill 不碰。
      - **manifest 内容不变时不写盘（2026-10-07 todo/0146 probe 3 实撞）**：新 manifest 的序列化文本与盘上现有 manifest 逐字节相同时跳过写入。原因：Claude Code 沙箱禁止写 `~/.claude/skills/`,/hop 在已装好的项目里跑 setup 只为补项目级注册与诊断握手,`installed` 为空,却因无条件重写 manifest 撞 EPERM 整条失败,driver 只能关沙箱重跑。内容变了（版本升级、源文件增减）照常写——那时本来就在改用户级目录。

**三载体 hop-ops.md 字节同文（2026-10-08 todo/0133 挂账②）** ^anc-cli-hop-ops-parity：`driver/hop-references/hop-ops.md`（CC 源）与 `driver/codex/hop-references/hop-ops.md`、`driver/opencode/hop-references/hop-ops.md` 是同一份载体中立件在三处的落点,此前只靠阅卷手核 md5,`check-driver-carriers.mjs` 零感知。机检：该守卫加两份对 CC 源的字节等值断言,任一份不同即红并点名文件;改 hop-ops.md 必须三份一起改。负向验证（准入第③步）：`echo x >>` 任一份 → 守卫 exit 1 点名;复原后通过。

        ```
        受管目录 manifest 落盘:
        1. [条件(受管目录不存在)] 跳过
        2. mfText = 序列化 {version: 包版本, files: 本次源里的 .md 文件名升序}（两空格缩进）
        3. [条件(盘上 manifest 存在且读出的文本与 mfText 逐字节相同)] 跳过写入
        4. [其他（不存在、内容不同、读失败）] 写入 mfText——读失败按"不同"处理,宁可多写一次
        ```
    - **【决策：依赖驱动】为什么不再装 AGENTS.md（2026-07-17 改定，由 Codex 官方 skills 机制查证触发）**：早期方案把驱动指令装为项目根 `AGENTS.md`，有三重错配。skill 布局三者全解。此决策随 Codex skills 机制演进复审。
      - ① AGENTS.md 是用户的项目级常驻指令（等位 CC 的 CLAUDE.md），驱动指令只是一个可选能力，占顶层身份即鸠占鹊巢，且与用户已有 AGENTS.md 冲突不可调和（跳过=装不上，--force=毁用户文件）；
      - ② AGENTS.md 每会话全文常驻（32 KiB 硬限），驱动指令常驻浪费用户注意力预算；
      - ③ Codex 官方明确"可复用 workflow 属 Skills 不属 AGENTS.md"，skills 描述常驻、正文按需加载（渐进式），且支持隐式触发（按 SKILL.md frontmatter description 匹配任务）。
- **MCP server 注册与配置自举——缺省即做（2026-10-01 作者定"缺省安装 mcp"：装完就能用,不另要 flag;`--mcp` 保留为显式别名,带不带行为相同。此前 2026-08-16 作者定"模式选定装配时化"时为显式 flag,见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]）**。自举失败（学不到模型/凭证）只留 note 不阻断 skill 安装——server 要到有 providers 配置才起得来,这是 run_approved_command 可达的前提,note 要把这一点说出来：
  - **自举三支**：学到模型/凭证→写 `~/.hopjit/config.yaml`,`mcp_config_bootstrapped`=路径;学不到→不写,`mcp_config_note` 说明学习源缺什么;学不到**且**系统级 `~/.hopjit/config.yaml` 不在→note 末尾追一句"没有 providers 配置时 hopjit MCP server 起不来,run_approved_command 要等配置就位才可用"（server 起不来的真实后果,不藏）。自举抛异常同第二支处理（note 带异常文字）。
  - **注册面失败两支（2026-10-01 review 补——规则原只在代码注释）**：用户配置文件损坏（CC `.mcp.json` 坏 JSON 等,报文前缀 `INSTALL_SKILL_ERROR:`）→仍响亮退出,不静默覆盖用户文件（既有契约）;环境性失败（家目录不可写/路径受限等其余异常）→降为 `mcp_note` 不阻断 skill 安装——skill 装好了但 MCP 工具不可达,note 指路"修复后重跑 hopjit setup 即补注册"。
  - 壳：CC 装 `driver/hopspec-skill-mcp.md` → `<目标>/hopspec-mcp/SKILL.md`（双名双壳恒装,不同名并存、名字即模式——与复用变体 `hopspec/` 各居其位;原文"同名互斥同位"系 2026-08-27 四改前旧口径,同文档 §install-skill 现行条款已按双名双壳改定,本句 2026-09-12 0088 批清同文档残句）；Codex 装 `driver/codex/SKILL-mcp.md`；两变体共享 `references/discovery.md`（§0 spec 定位与参数组装是模式无关的人机前置）；
  - 注册：CC 系载体（cc / cfuse-cc,判据 carrierFamily === 'cc'）的注册点是项目级 `<cwd>/.mcp.json` 的 `mcpServers.hopjit = {command: "hopjit-mcp"}`（JSON 合并保留其他 server）。**这个文件是机器上全部 CC 系载体共用的**——cc 与 cfuse-cc 启动时都读同一个项目目录下的 .mcp.json,但各自的用户级配置是两个不同的文件（`~/.claude.json` 与 `~/.codefuse/engine/cc/.claude.json`,按 ^anc-cli-carrier-home-resolution 解析）。
    - **CC 跨 scope 已注册感知,按族决策（2026-08-20 实撞立——开发库 local 级注册在场时 install 又写 project 级,CC 报同名多 scope 冲突诊断且新注册被窄 scope 盖住;2026-10-11 todo/0158 改为按族——原条款只查本载体自己的 .claude.json,机器上 cc 在 local 级已注册、cfuse-cc 没注册时,cfuse-cc 那轮照写 .mcp.json,cc 立刻在 local 与 project 两个 scope 同时有 hopjit,正是本条要防的冲突）**：setup 装任一 CC 系载体前,先对族内**每个在场的** CC 系载体（home 目录存在的,不只本次要装的——`--carrier` 显式只装一个时其余仍参与查）各查一次它自己的 `.claude.json`：user 级（顶层 `mcpServers.hopjit`）与本 cwd 的 local 级（`projects["<cwd>"].mcpServers.hopjit`）。然后二选一：
      - **(a) 族内没有任何载体在 user / local 级注册** → 写一次 `<cwd>/.mcp.json`,族内全部载体由它覆盖;族内每个载体的响应 `mcp_registered` 都指向这个文件（只写一次,第二个载体那轮看到已有条目按"已有跳过"处理）。
      - **(b) 族内已有载体在 user 或 local 级注册** → **不写 .mcp.json**（写了就制造同名多 scope）;族内**缺注册的每个载体**在**它自己的** `.claude.json` 写一条 local 级条目 `projects["<cwd>"].mcpServers.hopjit = { command: "hopjit-mcp" }`——与 `claude mcp add --scope local` 的产物同形,与已注册的兄弟载体同 scope,不冲突;已注册的载体 note 指明所在 scope,不写。只装一个载体（`--carrier`）时只给被装的那个写。
      - **往 .claude.json 写的纪律**（这是载体自己的配置文件,触碰面要最小）：①只加这一个键——`projects[cwd]` 不存在就建,`mcpServers` 不存在就建,其余任何键一字不动,JSON.parse → 改 → `JSON.stringify(…, null, 2)` 回写;②文件内容不是合法 JSON → 响亮失败 `INSTALL_SKILL_ERROR` 不覆盖（与 .mcp.json 坏 JSON 同纪律）;③文件**不存在时不建**——.claude.json 是载体首次启动时自己初始化的,不存在说明该载体从没启动过,此时它不算"在场",回到 (a) 的判断;④**查法=写法**：写进去的位置就是 `detectCcHopjitRegistration` 查的位置（同一函数解析 home、同一键路径）,doctor 问 4 对 cfuse-cc 的 `mcp_registered` 判定因此自动认这条 local 级条目。
      - "已有条目跳过"原则的检测面补全:CC 注册面是三 scope 一体,只查 .mcp.json 看不见另两个;某个载体的 `.claude.json` 解析失败在 (a)/(b) 判断里按"该载体未注册"计（best-effort,CC 内部格式演进不拦装）,但轮到给它写 local 级条目时按②响亮失败;
    - Codex 追加 `<Codex home>/config.toml`（home 按 ^anc-cli-carrier-home-resolution 解析,原生=`~/.codex`）的 `[mcp_servers.hopjit]`（command + `env_vars` 凭证名透传——Codex 干净环境启动 stdio server 实撞防线,值不落盘）；
    - **env_vars 凭证名联动 standalone 配置（2026-08-20 实撞立——原硬编码 ANTHROPIC 对,standalone 配置用 DEEPSEEK_API_KEY 等其他凭证名时 server 拿不到凭证=启动即缺凭证,透传目的落空）**：取系统级 `~/.hopjit/config.yaml` providers 的 `api_key_env` 并集（含本次自举刚写的——自举先于注册执行）;读不到（配置缺席/坏文件/空表）回落缺省对 `["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]`；
    - 已有 hopjit 条目一律跳过并提示（注册配置是用户资产,--force 不覆盖注册面——force 只管壳文件）；
    - opencode 载体注册（写**用户级** `opencode.json` 的 `mcp.hopjit`——`{ type:"local", command:["hopjit-mcp"], environment:{} }`,`command` 数组合并、`environment` 留空靠 process.env 透传）见上 opencode 载体条款;
  - 响应 `mcp_registered` 字段（写入的配置路径,跳过时 null+原因）；
  - **配置自举**（2026-08-17 作者定——没有已有配置时把主 agent 的 LLM 配置学习为 standalone 缺省模型，并向用户明示）：
    - **触发条件**：仅当两级 standalone 配置（`~/.hopjit/config.yaml` 与 `<cwd>/hopjit.yaml`）**全缺席**时执行——已有配置是用户资产零触碰（与注册面同款纪律）。
    - **学习源（CC 载体）**=两级链：①进程环境 `ANTHROPIC_*` 族；②环境缺席时读 **CC settings 文件族**——`<CC home>/settings.json`（home 按 ^anc-cli-carrier-home-resolution 解析，原生=`~/.claude`）与 `<cwd>/.claude/settings.json`/`settings.local.json` 的 `env` 块同名变量 + 顶层 `model` 字段，项目级>用户级。
      - 为什么要读 settings：覆盖"在普通终端跑装配"的形态——settings env 块只在 CC 会话内注入子进程，终端环境是干净的；而运行期 MCP server 由 CC 拉起必继承 env 块，故凭证名引用仍有效；
      - 凭证名 AUTH_TOKEN 优先、API_KEY 次之，**只写名不写值**（standalone 不变量第 1 条——settings 里读到的也只取"哪个名字被配了"不抄值）；BASE_URL 缺省 `https://api.anthropic.com`，MODEL 缺省引擎缺省模型；protocol=anthropic；
      - 两级链都空（如 OAuth 订阅登录——凭证在 keychain 无 env 名，且订阅凭证本不可复用给独立 server）→ 不写文件，note 如实明示需自建并配 API key。
    - **学习源（Codex 载体）**=`<Codex home>/config.toml`（home 按 ^anc-cli-carrier-home-resolution 解析，原生=`~/.codex`）的 `model`+`model_provider`→`[model_providers.<id>]` 的 `base_url`+`env_key`+`wire_api`（env_key 缺省 OPENAI_API_KEY 惯例）。
      - protocol **忠实照抄宿主 wire_api**——`"responses"`→openai-responses，`"chat"` 或缺省→openai-chat（0020 批次改定 2026-09-20：responses 适配器实装后原"一律学为 openai-chat"的强制降级撤销——降级当年是防"学预留枚举=交付启动即炸的配置"，实装后照抄即忠实，降级反成失真：Codex 生态 provider 已普遍 wire_api="responses"）。
    - **学习源（opencode 载体）**：读 opencode 配置的 `model`+`provider.<id>` 的 `options.baseURL`+`env[0]`，protocol 忠实照抄 `provider.<id>.npm` 字段、缺席回退 id 推断（0020 批次改定）——详见上方 opencode 载体条款。
    - **写入**：**系统级** `~/.hopjit/config.yaml`（providers 归系统级——跟人走），`service_id=<carrier>_host`（命名忠实：值是宿主后端），文件头注释注明学习来源与时间。**providers 节经 YAML 序列化器输出**——值来自宿主配置不可控，裸模板拼接遇 `: `/`#` 类字符产物即炸自家加载器（二审探针实抓）。
    - **学习源缺失**（CC 无凭证 env / Codex 无 config.toml 或缺 model/base_url）→ **不写文件**，note 明示需自建。
    - **响应字段**：`+mcp_config_bootstrapped`（写入路径，未自举 null）、`+mcp_config_note`（明示学了什么——模型/端点/凭证名，或未学习原因）。
- **演示件缺省装为 HopAnt（2026-10-06 作者定"demo skill 方向错了，以后都应该是 hopant，由于 hopant 是安装在 hop 下，所以 demo 可以缺省就装""demo 保留前缀"，todo/0142）** ^anc-cli-install-skill-demo-ants：setup 第 7 项职责。三个演示件不再打包成载体 skill，而是生成 HopAnt 装进 `~/.hopjit/ants/`。
  - **为什么可以缺省装**：旧形态的 demo skill 占载体的 `/` 菜单与 skills 目录，所以 2026-08-06 定为"缺省不装、`--demo` 才装"。HopAnt 住 hop 自己的目录，不进任何载体的菜单，由 /hop 分派到它（todo/0142 子卡 B），缺省装不打扰用户环境。
  - **演示集**（id 一律 `demo-` 前缀——前缀是命名空间：用户一眼认出演示件，可整批 `hopjit ant remove`，不与用户自己的 HopAnt 撞 id）：
  | HopAnt id | 包内原件 | 随附资产 | 演示什么 |
  |---|---|---|---|
  | `demo-coffee-week` | `examples/coffee-week.md` | `coffee-sales.json` | 入门：ask 确认 + act 纯计算 + reason 判断 + check 核验 |
  | `demo-fact-check` | `examples/fact-check-demo.md` | `fact-check-sample.md` | 实战：for-each 并行核查一级事实（fact-check 完整版的适度简化——只核可直接查证的事实断言，不做推演审查与自查回路）；只依赖标准工具 `web_search` |
  | `demo-rename` | `examples/syntax/confirm-commit.md` | — | 探索-核验-提交：批量重命名——act 探索 → confirm 人审 → commit 不可逆（幂等设计；教程 03 主角） |
  - **生成方式**：包内原件保持原位不动（教程与 `run examples/...` 命令照旧引用它们）。对每个演示件，在系统临时目录建一个单 HopAnt 来源目录 `<临时目录>/<id>/`：入口 spec 写成 `<id>.md`，内容是原件把 Id 行改写为 `<id>`（英文 `Id:` 与中文 `标识:` 两种写法都改写，保留原关键词）；资产拷到同目录。然后走 [[hopant]] 模块的 `planInstall` + `applyInstall`——与 `hopjit ant install` 同一条安装路径，入口 spec 解析、Id 与文件名一致性核对、建 `inner_store/`、重建 `index.md` 都由模块完成，setup 不另写安装逻辑。临时目录用完即删。Id 必须随 id 改写的原因：HopAnt 安装要求入口 spec 的 Id 与文件名相同（[[hopant#^anc-hopant-install]]），且 Id 是运行痕迹的命名根（hoplog 目录、状态元数据），`demo-rename` 跑出 `confirm-commit-*` 日志会与用户同 Id 的 spec 混淆。
  - **已存在即跳过，`--force` 不覆盖**：`~/.hopjit/ants/<id>/` 已存在时该件跳过，`demo_note` 写明"已装，跳过"。`--force` 不作用于演示 HopAnt——HopAnt 目录里有本机面（`inner_store/` 的适配戳、逻辑适配后的 `<id>.orig.md` 备份），覆盖会丢用户本机状态。要刷新到新版演示件：先 `hopjit ant remove <id>` 再跑 setup。
  - **与载体无关、每次只做一次**：演示 HopAnt 不属于任何载体，在逐载体安装循环之外执行一次；自动探测到多个载体时也只装一次。
  - **失败不中断**：某一件生成或安装失败（原件缺失、家目录不可写等）只记进 `demo_note`，其余演示件与 skill 安装照常完成，setup 退出码不变。
  - **`--demo` 退成隐藏的无作用参数**：保留一个版本周期，用 commander 的隐藏选项定义，不出现在 `--help` 里；传入时行为与不传完全相同，不报错、不提示——旧版 driver 文本、旧教程、开发脚本里写的 `setup --demo` 仍能跑通。
  - **响应字段**（顶层，不进 results——与载体无关）：`demo_ants % [line]` 本次新装的演示 HopAnt id 清单（全部已存在时为空表）；`demo_note % line` 可选，跳过与失败说明。
  - **旧形态 demo skill 的去向**：以前 `--demo` 装进载体 skills 目录的 `demo-*` skill 不由本器删除（setup 不删除上次安装清单以外的文件，且用户可能改过它们），由陈旧副本扫描整目录挪进备份区（^anc-cli-stale-skill-scan）。
  - 正例：干净家目录跑 `hopjit setup` 后 `~/.hopjit/ants/demo-coffee-week/demo-coffee-week.md`、同目录 `coffee-sales.json`、`inner_store/` 都在，`index.md` 列出三件；第二次跑 `demo_ants` 为空、`demo_note` 写已装跳过。反例：用户改过 `~/.hopjit/ants/demo-rename/demo-rename.md`，再跑 `hopjit setup --force`，该文件内容不变。
  - **能力契约与关键逻辑**：

```
HopType: DemoAntInstaller
  # setup 第 7 项的实现单元,住 cli.ts（组合根:取 homedir() 与包根后调用）;安装本身全部委托 hopant 模块
  Specs:
    rewriteSpecId(
      raw % text,               # spec 原文全文
      id % line                 # 要改写成的 Id 值
    ) -> text % text            # 改写后的全文
      # 第一处行首 `Id:` 或 `标识:` 行的值换成 id,关键词原样保留;两种都没有时原文不变（无 Id 字段视为与文件名一致,见 hopant planInstall）
    installDemoAnts(
      pkgRoot % line,           # 包根绝对路径,原件在 <pkgRoot>/examples/ 下
      home % line               # 用户主目录绝对路径,装到 <home>/.hopjit/ants/
    ) -> installed % [line],    # 本次新装的 HopAnt id
         notes % [line]         # 跳过与失败说明,一件一条
      # 约束：不抛异常——任何失败都转成 notes 条目;已存在的 HopAnt 目录不读不写
      1. 对演示集每一件 {id, 原件, 资产}：
        1.1. [条件(antDir(home, id) 已存在)] notes 追加"<id> 已装,跳过（要刷新先 hopjit ant remove <id>）";下一件
        1.2. 在系统临时目录建 <tmp>/<id>/;写 <tmp>/<id>/<id>.md = rewriteSpecId(读 <pkgRoot>/examples/<原件>, id);有资产则拷 <pkgRoot>/examples/<资产> 到 <tmp>/<id>/
        1.3. plan = planInstall(<tmp>/<id>, home);applyInstall(plan);installed 追加 id
        1.4. [条件(1.2–1.3 任一步抛错)] notes 追加"<id> 安装失败：<错误信息>"
        1.5. 删除 <tmp>（成功失败都删）
```

- **CC 载体自动放行 hopjit 的 MCP 工具（2026-10-01 作者定,hopissues/0114 零弹窗半边的安装侧;2026-10-07 todo/0146 由一个工具扩为清单）** ^anc-cli-install-skill-permission：Claude Code 对每个 MCP 工具的调用缺省弹窗确认,它只认工具名、看不见参数内容。2026-10-01 首版只放行 `run_approved_command`——放行这一个工具名=撤掉这层空闸,把"这条命令能不能跑"的判定交给 hopjit 的任务卡闸（[[mcp-server#^anc-mcp-run-command]]）。2026-10-07 复用模式驱动改走 MCP 工具（[[mcp-server#^anc-mcp-reuse-driver-tools]]）,放行面同理扩为 hopjit 的全部工具：
  - **放行清单 = `HOPJIT_ALLOWED_TOOLS`**（src/provider-types.ts 常量,与 `RUN_APPROVED_COMMAND_TOOL`、`APPROVE_COMMIT_TOOL` 同处定义;mcp-server 注册工具与 setup 写放行共用这一处,新增工具时两边不会漏一边）：hopjit 注册的全部 MCP 工具名,含 `approve_commit`,含管理八件 `doctor` / `ant_list` / `ant_install` / `ant_adapt` / `ant_remove` / `ant_bootstrap` / `ant_pack` / `ant_share`（2026-10-10 todo/0154,[[mcp-server#^anc-mcp-admin-tools]]——参数固定、只写 hop 自己的目录,放行它们不是放大口子;不加 `Bash(hopjit *)`,作者定）。测试断言清单与注册工具集完全相等。
  - **`approve_commit` 同样放行**：它是 commit 每句批准一次的记账入口（[[mcp-server#^anc-mcp-commit-approve]]）。人批准发生在对话里——driver 贴出 body、用载体提问工具问用户同不同意,用户同意后才调它;载体弹窗不承担批准职责。2026-10-07 当天曾让 setup 唯独不放行它、靠 Claude Code 对它的弹窗当批准闸,作者纠正:Claude Code 弹窗频繁,用户习惯性点过或点永久放行,弹窗不是可靠的闸,也看不到 body 原文;需要人批准就在对话里问。
  - 落点：`<cwd>/.claude/settings.local.json` 的 `permissions.allow` 数组追加清单里每个工具的全名 `mcp__hopjit__<工具名>`（工具全名=`mcp__<server 注册名>__<工具名>`,server 注册名三载体恒 `hopjit`）。已在的条目跳过,缺的逐个补——旧版只写了 run_approved_command 的项目重跑 setup 即补齐其余。项目级 local 文件（不进 git）——与 `.mcp.json` 同为项目作用域。
  - 幂等与不覆盖（七形态,2026-10-01 review 从四补全——'不覆盖用户配置'要在每一支成立）：①文件不存在→新建 `{ "permissions": { "allow": [...] } }`;②存在且已含该串→不动;③存在不含→追加（保留其他条目与其他键）;④不是合法 JSON→不写,`permission_note` 说明路径与"请修复后重跑";⑤顶层不是对象（null/数组/标量）→不写只 note;⑥`permissions` 存在但不是对象→不写只 note;⑦`permissions.allow` 存在但不是数组→不写只 note（⑥⑦首版静默替换成 `{}`/`[]` 后写盘,覆盖了用户原值——review 面二/面三实抓）;⑧写入时环境性失败（目录只读等）→不抛,`permission_note` 带原因与手动修法（与注册面同律——review 补测试时实抓:注册面 catch 住了,放行这里再抛仍炸整条安装）。只加清单里的精确工具名,不加任何 Bash 规则、不动 deny、不加 `mcp__hopjit__*` 通配（通配会把以后新增、尚未评估的工具一并放行;清单逐个列名,新增工具进清单是一次显式决定）。②的判据相应是"清单条目全部已在"。
  - 其他载体（判据=显式枚举 `carrier === 'cc' || carrier === 'cfuse-cc'`,**不借 `carrierFamily`**——那个函数把 opencode 也归 'cc' 系,只是包装模板选型语义,首版误用致 opencode 被写了 CC 文件,review 面二实抓）：Codex 与 opencode 都有按 `<server>_<tool>` 粒度的放行配置,但公开文档未给出完整放行格式——本器不猜格式,`permission_note` 输出一行指路"请在载体里放行 hopjit 的 MCP 工具"。opencode 的 note 加一句说明 server 已启用、独立模式工具已在 `tools` 节关闭、要走 standalone 时把那几键改 true（2026-10-08 todo/0134 b 案起,原"把 enabled 改 true"句撤,见 ^anc-cli-opencode-tools-gate）。
  - 响应：`permission_written`（写入的文件路径;跳过/非 CC 时 null）+ `permission_note`。
- **注册后的握手自检（2026-10-07 作者定,todo/0146 MCP 健康"乙"案）** ^anc-cli-install-skill-handshake：注册写进配置不等于 server 起得来——`hopjit-mcp` 不在 PATH、node 版本不对、配置路径错,都要等用户新开会话、/hop 调不到工具时才暴露,且载体只报"server 连接失败"不给原因。setup 在第 4 项之后当场验一次：
  - **动作**：以 `process.execPath` 跑包内 `dist/mcp-server.js`（不是 PATH 上的 `hopjit-mcp`——验的是本次装的这份;PATH 解析问题另判,见下条）,经 stdio 发 `initialize` → `notifications/initialized` → `tools/list` → `tools/call server_status`,收到 server_status 的结果即关 stdin 让它退出。超时 10 秒。
  - **PATH 判定**：另查注册条目里的 command（缺省 `hopjit-mcp`）在当前 PATH 上能否找到;找不到时修法写"把 npm 全局 bin 目录加进 PATH,或把注册里的 command 改为 `<node 绝对路径> <包内 dist/mcp-server.js 绝对路径>`"。setup 不自动改用户的注册条目——注册是用户资产,只报修法。
  - **结果**：响应字段 `mcp_handshake = { ok: bool, tools?: [line], standalone_available?: bool, reason?: text, fix?: text }`。ok=true 时 tools 是 server 报的工具名,standalone_available 来自对 `server_status` 的一次调用（独立模式配置是否可用,不可用时 reason/fix 照抄 server 的说法——配置问题不阻止 server 启动,[[mcp-server#^anc-mcp-server-status]]）。ok=false 时 reason 是子进程 stderr 末尾几行或超时说明,fix 是修法。
  - **不阻断**：自检失败只进响应,skill 照装、退出码 0——与注册面环境性失败同律。
  - **/hop 复用同一判断**：/hop 分派节发现工具不可达时,让 agent 跑 `hopjit setup` 拿到同一份 `mcp_handshake` 报告,按 reason/fix 修或告诉用户（[[#^anc-cli-hop-dispatch]]）。

  ```
  HopSchema: McpHandshake
    # setup 注册后握手自检的结果,进 InstallSkillResponse.mcp_handshake
      - ok % bool                       # 包内 server 握手成功且注册的 command 在 PATH 上找得到
      - tools % [line]?                 # server 报的工具名;server 起不来时缺席,PATH 找不到时仍带（server 本身是好的）
      - standalone_available % bool?    # server_status 报的独立模式是否可用;ok=true 且拿到了 server_status 结果时在场
      - reason % text?                  # ok=false 时是失败原因;ok=true 但独立模式不可用时照抄 server_status 的 reason
      - fix % text?                     # 与 reason 成对的修法

  HopType: CliMcpHandshake
    # setup 第 4 项之后的握手自检（cli.ts 导出函数,可单测）
    Specs:
      mcpHandshake(
        execPath % line,      # node 可执行文件路径（组合根传 process.execPath;hop-admin 不读进程状态,2026-10-10 todo/0154 搬家后加）
        serverJs % line,      # 包内 dist/mcp-server.js 绝对路径——验本次装的这份
        command % line,       # 注册条目里的 command;CC 载体从项目 .mcp.json 的 mcpServers.hopjit.command 读,读不到或其他载体用 hopjit-mcp
        pathEnv % line        # 当前 PATH 环境变量值
      ) -> result % McpHandshake
        # 约束:只报告不修改注册;任何失败都折成 ok=false 返回,不抛
  ```

  ```
  setup 握手挂点:
  1. command = 'hopjit-mcp';[条件(载体是 cc 或 cfuse-cc 且 <cwd>/.mcp.json 可读且 mcpServers.hopjit.command 是字符串)] command = 该值
  2. mcp_handshake = mcpHandshake(process.execPath, <包根>/dist/mcp-server.js, command, PATH)

  mcpHandshake(execPath, serverJs, command, pathEnv):
  1. [条件(serverJs 不存在)] 返回 {ok:false, reason:"包内 server 文件不存在", fix:重装}
  2. 以当前 node 起握手子进程（spawnSync,10 秒超时）:子进程拉起 server,依次 initialize → notifications/initialized → tools/list → tools/call server_status,打印一行 JSON
  3. [条件(超时或被信号终止)] 返回 {ok:false, reason:"MCP 握手超时", fix:重装};[条件(子进程起不来)] 返回 {ok:false, reason:"握手子进程起不来:<原因>", fix:重装}
  4. [条件(子进程输出不是 JSON)] 返回 {ok:false, reason:"握手输出无法解析:<输出末尾>", fix:重装}
  5. [条件(server 中途退出)] 返回 {ok:false, reason:"server 启动后退出（exit 码）:<stderr 末 5 行>", fix:重装}
  6. [条件(command 是绝对路径而文件不存在,或是裸名而 PATH 各目录下都没有)] 返回 {ok:false, tools, reason:"注册里的 command 在 PATH 上找不到", fix:"把 npm 全局 bin 目录加进 PATH,或把注册里的 command 改为 <node 绝对路径> <serverJs>"}
  7. 返回 {ok:true, tools, standalone_available};独立模式不可用时另带 server_status 的 reason/fix
  ```
- **用户可见 skill 收敛为 `hop` 一个（2026-10-01 作者定——"现在安装时会装好几个 hop 家族的 skill,也要考虑避免 coding agent 的认知混乱"）** ^anc-cli-install-skill-single-entry：六件仍全部装到盘上（清单与路径不变）,但只有 `hop/SKILL.md` 保持 `user-invocable: true`（三载体源都显式写,不靠缺省）;`hopspec`/`hopspec-mcp`/`hopbuild`/`hopbuild2`/`hopfix` 五件 frontmatter 改 `user-invocable: false`（**连字符**——Claude Code 官方 frontmatter 键名,未识别的键静默忽略;本库自 2026-08 起写的下划线 `user_invocable` 一直是空操作,2026-10-01 review 面四对官方表实锤后全库改正）。Claude Code 对该字段的语义：不出现在用户的 `/` 菜单,模型仍可按 description 调用,description 仍进上下文（官方 skills 文档"Control who invokes a skill"）。/hop 的分派节决定什么情况走哪件（[[#^anc-cli-hop-dispatch]]）。Codex/opencode 载体同改 frontmatter（载体不认该字段时无害）。缺省件铁律不变：零配置可跑;`--plus` 件仍是显式附装。

- **响应恒带 `next_step` 指路 agent 使用说明（2026-10-03 作者抓"这么深的地方,agent 为啥会来读"——todo/0139 挂钩①）**：`docs/AGENT-GUIDE.md` 是写给替用户干活的 coding agent 读的（装完行为要变在哪、三条必须守的边界）,随 npm 包分发,但放在 docs/ 下没有任何必经点能把 agent 引过去。agent 装 hop 必经 `setup`（手动跑或 postinstall 钩子跑）,所以成功响应顶层恒带一行 `next_step`,值 = 一句完整指令 + **包内 AGENT-GUIDE 的绝对路径**（`<包根>/docs/AGENT-GUIDE.md`,包根即 driver_source）——带绝对路径是为了 agent 不必再算 `npm root -g`。与载体无关,放顶层不进 results。postinstall 成功时 stderr 那行同样带这句（`--foreground-scripts` 或 agent 代跑时可见）。失败形态 `{status:'error'}` 不带。**值的第二句（2026-10-03,挂钩②改形态）**：指路包内 `docs/agent-instructions-template.md`——一段可贴进用户项目 CLAUDE.md（Claude Code）或 AGENTS.md（Codex / opencode）的指令,让项目里的 agent 稳定知道"这个项目用 hop、什么活走 /hop、三条边界"。措辞必须带"先问用户"：贴不贴归用户,install-skill 与 postinstall 都**不写**用户项目的指令文件（那是用户的常驻指令面,与注册 .mcp.json 不是一个性质）。

- **载体自动探测（2026-10-03 作者定"install-skill 应该是智能探测的,而不是手工选择"）** ^anc-cli-carrier-autodetect：`--carrier` 缺席时不再缺省 `cc`,而是探测本机装了哪些载体,对探到的每一个各装一遍（同一套展开/注册/自举/放行流程逐载体跑,互不影响）。`--carrier` 显式给出时照旧只装那一个——它从"必选参数"降为"覆盖探测结果"。
  - **探测判据=载体 home 目录在场**（按 ^anc-cli-carrier-home-resolution 解析后 `existsSync`）：`cc`→`$CLAUDE_CONFIG_DIR` 或 `~/.claude`;`codex`→`$CODEX_HOME` 或 `~/.codex`;`opencode`→`$OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`;`cfuse-cc`/`cfuse-codex`→`~/.codefuse/engine/{cc,codex}`。home 在场=用户至少启动过一次该载体,是"装了"的最低可靠信号;不探可执行文件（PATH 里有 `claude` 不等于用户在用,且 cfuse 内置载体没有独立可执行文件）。
  - **去重**：环境变量把 `cc` 的 home 重定向到 `~/.codefuse/engine/cc` 时（cfuse 会话里跑）,`cc` 与 `cfuse-cc` 解析到同一目录——按解析后的 home 去重,只装一次,carrier 名取先探到的（探测顺序固定 cc → codex → opencode → cfuse-cc → cfuse-codex）。
  - **一个都没探到**→回落只装 `cc`（与旧缺省一致：用户裸机先装 hopjit 再装 Claude Code 的顺序也要能通,`~/.claude/skills` 由本器创建）,响应 `detect_note` 说明"未探到任何载体 home,按 Claude Code 装到 ~/.claude/skills;其他载体装好后重跑 hopjit setup 即自动补装"。
  - **响应形态**：探测路径下 `carrier` 字段仍带（=探到的第一个,兼容只读该字段的旧消费方）,新增 `carriers % [line]`（本次实际装的载体清单）与 `results % [InstallSkillResult]`（每载体一份,结构=旧响应去掉 status/driver_version/driver_source 三个全局字段）;顶层 `installed`/`target`/`mcp_registered`/`permission_written` 等字段取第一个载体的值（兼容）。显式 `--carrier` 路径 `carriers` 恒单元素,形态同。`--dir` 与自动探测互斥——`--dir` 给了目标目录却不知道给哪个载体,此时等价 `--carrier cc`（旧行为）,不探测。
  - 正例：机器上有 `~/.claude` 和 `~/.codex` → `hopjit setup` 零参数装两个载体,`carriers: ["cc","codex"]`;反例：`hopjit setup --carrier codex` 只装 codex,即便 `~/.claude` 在场也不碰。
  - 测试面：探测函数 `detectCarriers()` 导出,用例用临时 HOME 布目录正反例（两在场/零在场/环境变量重定向去重/显式 --carrier 不探测）。

- **postinstall 钩子已撤（2026-10-09 作者定"去掉",todo/0143）** ^anc-cli-postinstall：2026-10-03 至 2026-10-09 之间包里带 `scripts.postinstall: node dist/postinstall.js`,装包时自动跑一遍零参数 setup,四种环境静默跳过。撤销原因：①npm 12 起默认拦截依赖包的安装脚本（没被 allowScripts 放行的包静默跳过,只在结尾列包名）,钩子在多数新机器上根本不执行,留着只换来每个新用户装包时一段 npm 警告——还附一条漏了包名、照抄报 ENOENT 的放行命令;②npm 官方最佳实践（scripts 文档 Best Practices）："The only valid use of install or preinstall scripts is for compilation which must be done on the target architecture"——用安装脚本写用户的 agent 配置目录恰是 npm 12 要拦的那类行为,我们不该教用户绕过刚加的安全默认值;③同一件事（装 skill）两个触发点、两套跳过逻辑（钩子四种 + 本该再加的首次运行五种）、两组测试,是分叉;钩子还要专门规避 sudo 下 HOME 是 root 的坑。撤后的形态：**装 skill 只有 `hopjit setup` 一个入口**,安装主路恒两条命令（`npm install -g @hoplogic/hopjit` 只装引擎,npm 零警告;`hopjit setup` 显式装 /hop,用户知道自己在改什么）,漏跑第二条由下一条首次运行提示兜底。删除面：package.json `postinstall` 字段、`src/postinstall.ts`、`cli.ts postinstallSkipReason`、`HOPJIT_POSTINSTALL` 环境变量与 setup 里按它跳过项目级两件的分支（项目级两件现在恒在用户项目目录由 setup 或首次 /hop 落位）、check-process-state 组合根白名单的 postinstall.ts、layer-imports 表的 postinstall 行、release 资产清单的 dist/postinstall.js。`HOPJIT_SKIP_SKILL` 保留,改作首次运行提示的静音开关。本锚保留作撤销记录,代码落点归零。

- **`hopjit doctor`：装完之后一条命令答"能不能用"（2026-10-09 todo/0139 第三块,作者定名 doctor——"setup --check 太复杂,如果 brew doctor 有惯例,那么继续用 doctor"）** ^anc-cli-doctor：现在"装完能不能用"只靠真机 E2E 两档,没有一条机检覆盖"新装用户第一次 /hop 的路径"。doctor 把这条路径上的八问一次答完,每问一行 `ok` / `warn` / `fail` / `n/a` 加一句指路,照 brew doctor 的惯例——用户敲之前就知道它干什么。**只报不改**：修归 `hopjit setup`,doctor 不写任何文件,所以排障时可以放心先跑它。

  **实现落点（2026-10-10 todo/0154）**：八问判法与下面 HopType CliDoctor 的五个成员住 `src/hop-admin.ts`（hop-cli 模块出口文件）,`runDoctor` 的第一参改为 `AdminContext`（cwd / env / home 等机器侧事实由组合根读好传入,[[mcp-server#^anc-mcp-admin-tools]]）;`cli.ts` 的 `doctor` 子命令与 `mcp-server.ts` 的 `doctor` 工具是它的两个薄壳,报告形态、退出码规则不变。下文 HopSop 里的 `homedir()` / `env` / `cwd` 读作 `ctx.home` / `ctx.env` / `ctx.cwd`。

  **核心约束：查法=写法**。doctor 查的每一项都是 setup 八项职责（^anc-cli-install-skill 职责表）里写过的某一项,判法必须调 setup 同一个探测函数——两套判法必分叉（setup 写了 A,doctor 按 B 判,用户看到 setup 成功 doctor 却红）。setup 里有三段判定此前与写操作揉在一起,本批抽成只读函数,setup 改调它们再写：

  ```
  HopType: CliDoctor
    # 体检的八问判法与 setup 共用的三个只读半边。约束:不写任何文件;不调 setup 的写函数;不另写第二套探测
    Specs:
      learnStandaloneEntry(
        carrier % line           # cc | codex | cfuse-cc | cfuse-codex | opencode
      ) -> learned % yaml        # {entry % yaml} 学到了（service_id / protocol / base_url / model / api_key_env 五键）| {note % line} 没学到及原因
        # 从 bootstrapStandaloneConfig 抽出的学习半边：三载体分支与失败 note 文案原样不动（opencode 读 config.json/opencode.json/opencode.jsonc 的 model + provider;CC 系读进程环境与 settings 的 ANTHROPIC_*;Codex 读 config.toml 的 model / model_provider / base_url / env_key）。bootstrapStandaloneConfig 改为"已存在短路 → 本函数 → 写文件"
      readMcpRegistration(
        carrier % line,
        cwd % line               # CC 的 .mcp.json 是项目级,按 cwd 找
      ) -> reg % yaml            # {registered % bool, where? % line 注册在哪个文件哪一级, command? % line, enabled? % bool, note? % line}
        # 从 setup 第 4 项抽出的"已注册判定"半边：CC 系查 <cwd>/.mcp.json 的 mcpServers.hopjit 与 detectCcHopjitRegistration 的 user/local 两级,任一即 registered;Codex 查 <home>/config.toml 的 [mcp_servers.hopjit];opencode 查三候选配置的 mcp.hopjit 与其 enabled。setup 改调它决定"跳过还是写"
      ccPermissionMissing(
        cwd % line
      ) -> gap % yaml            # {path % line, missing % [line] 缺的 mcp__hopjit__<工具> 条目, invalid? % line 文件结构不合法的原因}
        # 从 ensureCcPermission 抽出的"读 + 算缺口"半边：清单=HOPJIT_ALLOWED_TOOLS 映射 mcp__hopjit__<名>;ensureCcPermission 改调它再写
      readSkillFrontmatter(
        home % line,             # 载体 home
        name % line              # skill 名,本批只用 hop
      ) -> fm % yaml             # {name? % line, description? % line, user_invocable? % bool} | null 文件不在
        # 只读 <home>/skills/<name>/SKILL.md 的 frontmatter（--- 到 --- 之间,user-invocable 连字符键）
      runDoctor(
        ctx % AdminContext,      # 机器侧事实（cwd / env / home / exec_path 等,组合根读好传入;2026-10-10 todo/0154 由 (cwd, env) 改——权威形态与 [[mcp-server#^anc-mcp-admin-tools]] HopAdmin.runDoctor 同一份）,
        opts % yaml              # {server_js?, handshake?} 测试注入
      ) -> report % DoctorReport
        1. carriers = detectCarriers(ctx);engine = getEngineVersion() ?? '0.0.0'（engine 模块的同源读法——hop-admin 不能 import cli.ts 的 readPackageVersion,两者读同一份 package.json;^anc-cli-version-single-source 的"单一事实源"指 package.json 不指读函数）
        2. [条件(carriers 空)] 问 1-6 各出一项 {carrier: 'none', status: fail, detail: "本机没探到任何 coding agent 的配置目录（~/.claude / ~/.codex / ~/.config/opencode）", hint: "装好 Claude Code / Codex / opencode 之一后重跑 hopjit setup"};跳到 9
        3. 对每个 carrier c（home = resolveCarrierHome(c)）出问 1-3：
           3.1. skill_installed：v = installedHopDriverVersion(c);[条件(v === null)] fail,detail "<home>/skills/hop/SKILL.md 不在",hint "运行 hopjit setup";[其他] ok,detail "<home>/skills/hop（v<v>）"
           3.2. skill_version：[条件(3.1 fail)] n/a;[条件(v !== engine)] warn,detail "装于 v<v>,当前 v<engine>",hint "重跑 hopjit setup 刷新";[其他] ok
           3.3. skill_visible：[条件(3.1 fail)] n/a;fm = readSkillFrontmatter(home, 'hop');[条件(fm 缺 name 或 description)] fail,detail "SKILL.md frontmatter 缺 name/description,载体不会把它列进菜单",hint "重跑 hopjit setup --force";[条件(c 是 cc 系且 fm.user_invocable !== true)] fail,detail "user-invocable 不是 true,/hop 不会出现在菜单",hint 同上;[其他] ok（Codex / opencode 忽略 user-invocable 字段——载体只校验 name+description,survey 核实）
        4. 对每个 carrier c 出问 4：mcp_registered：reg = readMcpRegistration(c, cwd);[条件(!reg.registered)] fail,detail "没注册（看了 <候选文件>）",hint "在项目根运行 hopjit setup"（CC 系注册是项目级 .mcp.json 或该载体自己 .claude.json 的 local 级条目——两处都查,查法与 setup 写法同源〔^anc-cli-install-skill 注册条 (a)/(b)〕;其他载体是用户级——hint 按载体措辞）;[条件(c === opencode 且 reg.enabled === false)] warn,detail "已注册但 enabled: false",hint "重跑 hopjit setup（hopjit 自己写的旧形态条目会被升级为 enabled:true;command 不是 hopjit-mcp 的用户自配条目 setup 不动,要自己改）后新开会话"——不叫普通用户手工改配置文件（2026-10-11 作者抓）;[其他] ok,detail reg.where
        5. 问 5 mcp_handshake 只做一次（同一个包同一个 server,不按载体重复拉起）：[条件(所有载体问 4 都 fail)] n/a,detail "没有任何注册,不拉起";[其他] command = 第一个 registered 的 reg.command ?? 'hopjit-mcp';h = mcpHandshake(ctx.exec_path, <包内 dist/mcp-server.js>, command, env.PATH);[条件(!h.ok)] fail,detail h.reason,hint h.fix;[其他] ok,detail "<tools 数> 个工具"
        6. 对每个 cc 系 carrier 出问 6 permissions：gap = ccPermissionMissing(cwd);[条件(gap.invalid)] fail,detail gap.invalid,hint "修好 <path> 的 JSON 结构后重跑 hopjit setup";[条件(gap.missing 非空)] fail,detail "缺 <N> 项放行",hint "在项目根运行 hopjit setup";[其他] ok。非 cc 系载体出一项 n/a,detail "该载体没有放行清单这一层"
        7. 问 7 mcp_llm_config（与载体无关,一项）：cfg = loadReuseConfig(configPaths(homedir(), cwd));[条件(cfg.providers 空)] fail,detail "MCP server 的模型没配置：setup 从 <载体> 没学到 LLM 配置——<learnStandaloneEntry(c).note 的原因半句>"（c 取第一个载体;这是作者口径——不是"没凭证",是"根本没配置"）,hint "自建 ~/.hopjit/config.yaml 写一个 provider（格式见 docs/reference/配置参考.md）,或在能学到配置的载体环境里重跑 hopjit setup";[其他] ok,detail 列 service_id/model 各一
        8. 问 8 standalone_credential：[条件(问 7 fail)] n/a;missing = providers 里 env[api_key_env] 为空的变量名;[条件(missing 非空)] warn,detail "独立模式凭证变量 <名列表> 未设置",hint "只影响 MCP 独立模式（start_run）,主路 /hop 不受影响;要用独立模式先 export <名>";[其他] ok
        9. summary = 四档计数;exit_code = [条件(任一 fail)] 1 [其他] 0;返回 DoctorReport
  ```

  ```
  HopSchema: DoctorItem
    - id % line               # skill_installed | skill_version | skill_visible | mcp_registered | mcp_handshake | permissions | mcp_llm_config | standalone_credential
    - carrier % line          # cc | codex | cfuse-cc | cfuse-codex | opencode | none（零载体）| -（与载体无关的问 7/8;握手取第一个注册的载体）
    - status % line           # ok | warn | fail | n/a
    - detail % line           # 一句事实（看了哪个文件、读到什么）
    - hint? % line            # fail / warn 时的补法,普通用户一遍读懂,写命令,不写内部锚名

  HopSchema: DoctorReport
    - status % line           # 恒 'ok'——doctor 跑完就是 ok,检查结果在 items;doctor 自身炸（读文件异常等）才走 errorExit
    - action % line           # 恒 'doctor'
    - engine_version % line
    - carriers % [line]       # detectCarriers() 的结果
    - items % [DoctorItem]
    - summary % yaml          # {ok % int, warn % int, fail % int, na % int}
    - exit_code % int         # 任一 fail → 1;否则 0
  ```

  **输出形态**：人读（缺省）首行 `hopjit doctor — v<引擎版本>`,每项一行 `[ok]   skill_installed      cc  ~/.claude/skills/hop（v0.19.1）`,fail / warn 行末尾 ` → <hint>`,末行 `summary: N ok / N warn / N fail / N n/a`;`--json` 输出 DoctorReport 整体。两形态同源一份 items。退出码按 exit_code,不走 errorExit——fail 是正常报告不是命令出错。`doctor` 进 FIRST_RUN_EXEMPT（与 setup 同,不自己提示自己）。

  **与 setup 职责表的对应**：问 1-3 ← 职责 2（装 skill）;问 4-5 ← 职责 4（注册 + 握手）;问 6 ← 职责 5（放行）;问 7-8 ← 职责 3（自举 standalone 配置）。职责 1（选载体）是 doctor 自己的第 1 步;职责 6 / 7 / 8（陈旧副本 / 演示 HopAnt / 回报）doctor 不查——陈旧副本 setup 顺手扫,演示件缺了不影响能不能用。

  **不做**：不修（修归 setup）;不查引擎自身是不是最新版（npm registry 网络面,另议）;不查工具注册面调不调得通（那是 `ant adapt` 与起跑闸的事）;不并 `mcp-probe`（作者定独立命令——doctor 看本机装对没,probe 看一个外部 server 长什么样,两个方向;probe 另批）。

  **driver 接线**：三载体 hop-skill §0 分派"已注册但工具不可见"分支改为先跑 `hopjit --json doctor`,读 items 里 fail 项的 hint——doctor 一次答全八问且不写文件,比"跑 setup 读 mcp_handshake"信息多且排障时不该先做写操作;能改的（如 .mcp.json 的 command 绝对路径）改,改不了把 detail 与 hint 原样告诉用户。check-driver-carriers 的 hop-skill parity token 加 `hopjit --json doctor`。

  - 测试面（cli.test "hopjit doctor"组,进程内 withHome 形态 + 子进程一例）：正：setup 后跑 doctor 八项 ok 且 exit_code 0;反：没装 skill → skill_installed fail 且 skill_version / skill_visible n/a 且 exit_code 1;戳改旧 → skill_version warn 且 exit_code 0;frontmatter 删 user-invocable → CC skill_visible fail;.mcp.json 删 hopjit → mcp_registered fail 且 mcp_handshake n/a;opencode enabled:false → warn 且 hint 指路重跑 setup 而不是手工改文件;无 providers → mcp_llm_config fail 且 detail 含 learnStandaloneEntry 的 note 半句、standalone_credential n/a;providers 在场 + env 缺 → standalone_credential warn 且 exit_code 0,env 在 → ok;零载体 → 六项 fail carrier none;子进程 `node dist/cli.js --json doctor` 在假 HOME 下 exit 1 且 stdout 可 JSON.parse,人读形态同 exit。抽出的三个只读函数各一例直测;setup 既有用例覆盖写半边不减。

- **首次运行提示：漏跑 setup 时下一条 hopjit 命令指路（2026-10-09 todo/0143 修法 2,撤钩子后的唯一兜底）** ^anc-cli-first-run-hint：用户只敲了 `npm install -g` 没敲 `hopjit setup`,本包第一个有代码在跑的时机是他下一次敲任何 `hopjit` 子命令——在那里检测、提示、不动手。

  ```
  HopType: FirstRunHint
    # 全局 preAction 钩子里的一次检测:本机探到的载体里 /hop 装没装、版本是否落后;只向 stderr 说一句,不改任何文件
    # 约束:只写 stderr——`--json` 的 stdout 是 driver 解析的响应,一个字节都不许动
    # 约束:零状态——不记"提示过几次",装过就有版本戳自然不再提;版本落后也提（顺手覆盖"引擎升了 skill 没刷"）
    # 约束:不自动装——用户环境拦安装脚本正说明不希望包自作主张改东西（todo/0143 否掉的方向）
    Specs:
      firstRunHint(
        argv % list,          # 本次子命令与选项（判不提示情形）
        env % yaml,           # 进程环境（HOPJIT_SKIP_SKILL / CI / 载体 home 重定向变量）
        engineVersion % line  # getEngineVersion() ?? '0.0.0'（见第 1 步）
      ) -> hint % line        # 空串=不提示;非空=写 stderr 的那一行
        1. [条件(子命令是 setup 或隐藏别名 install-skill,或 argv 含 --version / --help / -V / -h,或没有子命令)] 返回空——正要装的人不用被催
        2. [条件(env.HOPJIT_SKIP_SKILL == '1' 或 env.CI 在场)] 返回空——与原钩子同一组开关,静音与流水线
        3. carriers = detectCarriers();[条件(为空)] 返回空——无 agent 的机器（纯 server 跑独立模式）/hop 本来不需要
        4. 对每个载体读 `<载体 home>/skills/hop/SKILL.md` 的版本戳 `<!-- driver: @hoplogic/hopjit vX.Y.Z … -->`：缺文件或缺戳记"未装",戳版本 != engineVersion 记"落后 vX.Y.Z"
        5. [条件(全部载体已装且版本相同)] 返回空
        6. [条件(有未装)] 返回 `[hopjit] /hop 还没装进本机 agent（<未装载体名,逗号分隔>）——运行 hopjit setup;静音：HOPJIT_SKIP_SKILL=1`
        7. [其他（只有落后）] 返回 `[hopjit] /hop 版本落后（<载体名> 装于 v旧,当前 v新）——重跑 hopjit setup 刷新;静音：HOPJIT_SKIP_SKILL=1`
  ```

  - 挂点：commander 全局 `preAction` 钩子（与 `--json` 置位同一处）,hint 非空即 `process.stderr.write(hint + '\n')`,然后照常执行命令——提示不改变任何命令的行为与退出码;
  - 读戳只读 SKILL.md 前几行（版本戳在 frontmatter 之后第一行,^anc-cli-install-skill 版本可见性条）,读失败按"未装"——不炸命令;
  - 与 ^anc-cli-stale-skill-scan 的分工：那个在 setup 装载后扫**旧位置**的陈旧副本并挪备份区,是安装期动作;本条在**每条命令前**只读当前位置、只说一句,不动文件;
  - 测试面（cli.test "首次运行提示"组,假 HOME + 假载体 home）：①探到载体但无 hop/SKILL.md → stderr 一行含"运行 hopjit setup"且 `--json list` 的 stdout 仍是纯 JSON;②装过同版本戳 → stderr 零输出;③戳版本落后 → 含"版本落后"与两个版本号;④`setup` / `--version` / `HOPJIT_SKIP_SKILL=1` / 零载体 → 零输出;⑤纯函数 `firstRunHint` 直测七支。

- **`--plus`：附装进阶研究件并自动落位工具配置（2026-08-30 作者定"install-skill --plus 这样比较简单的"〔当时的命令名;2026-10-06 起为 setup --plus〕——进阶件不进缺省〔缺省件铁律=零配置可跑,这两件依赖外部工具注册,不配即死;deep-research 另有费用时长面〕,但值得一开关到位）** ^anc-cli-install-skill-plus：带 `--plus` 时做三件：
  1. **装 plus 集**（carrier-aware pack——与 `hopjit pack` 同一个 packSpec 实现;名字即 spec Id 不加前缀——这两件本就带 hop- 前缀命名空间）：
  | skill 名 | 源 spec | 资产 | 是什么 |
  |---|---|---|---|
  | `hop-fact-check` | `examples/hop-fact-check.md` | `fact-check-sample.md` | 事实核查完整版（断言提取+并行检索验证+推演审查+可信度分级报告） |
  | `hop-deep-research` | `examples/hop-deep-research/hop-deep-research.md` | `hop-deep-research-sample.md` | 深度研究（子问题分解+双语检索+对抗式验证+引用报告+落盘交付） |
  安装位=正式件同点（CC 用户级 `~/.claude/skills`,Codex 项目级）;已存在跳过,`--force` 覆盖——与既有防覆盖口径一致。
  2. **工具配置自动落位**：把 `examples/hoptools-websearch.yaml` 与 `examples/hoptools-playwright.yaml` 的 `tool_servers` 条目**合并写入系统级 `~/.hopjit/config.yaml`**。
     - 按 server `name` 判重（`bailian_search`/`playwright`）,已有同名条目跳过不覆盖（用户资产纪律,与 --mcp 注册面同款）;config.yaml 缺席则新建只含 tool_servers 节;YAML 经序列化器输出不裸拼；
     - 响应 `plus_tools_merged` 字段（写入的 server 名列表,全跳过时空表+note 说明）。
  3. **打印剩余人工动作**（自动化替代不了的一步）：note 明示"export DASHSCOPE_API_KEY=<百炼key>（web_search 凭证;Playwright 首跑自动下载浏览器 ~150MB）"。
  npm 包前提：`files` 白名单补 `examples/hop-fact-check.md`、`examples/hop-deep-research/`（目录含 spec+sample）、两份 hoptools-*.yaml。默认不装：进阶件是载体 skill,会占用户的 skills 目录与菜单,且要改用户的 config.yaml,不该未经请求就做（演示件改为 HopAnt 后缺省装,理由是 HopAnt 不占载体菜单,见 ^anc-cli-install-skill-demo-ants;这两件转 HopAnt 归 todo/0142 后续）。
- **版本可见性（2026-08-04 补，2026-08-05 修正 frontmatter 顺序）**：
  - ①响应带 `driver_version`（=包 package.json version）与 `driver_source`（=包根绝对路径）——用户一眼看出"装的是哪个版本、从哪来的源"（全局包 vs 本库开发源）；
  - ②展开的 `<skill>/SKILL.md` 在 YAML frontmatter 闭合线后注入一行 HTML 注释版本戳 `<!-- driver: @hoplogic/hopjit v{version} ({source}) installed {ISO时间} -->`——已装副本自身可查（`head -5` 即见），不依赖当初的安装响应。Codex 要求 `SKILL.md` 第一行必须是 `---`，版本戳不得前置。
- **陈旧副本处置（hopissues/0096 立"给的不是清理命令,是 hopfix 这样的升级命令";2026-10-07 作者同意"本器自带件的陈旧副本自动挪进备份区"）** ^anc-cli-stale-skill-scan：setup 装载完成后扫描**本安装器写过的旧位置**。本器自带件的陈旧副本整目录挪进备份区，用户自建件只提示并指路 `/hopfix`；两类结果都报在 `stale_notes`。处置不拦装载，任何一步失败都退回只提示。
  - **为什么自带件改为自动挪走**：旧位置已不是安装位置，`--force` 刷新不到它，而载体可能优先加载旧位置的副本、盖住新版（0096 实撞：8-14 旧副本缺授权，29 个子实例全灭）。原口径"只提示、用户自行处置"把一件可机械完成的事交给人，且提示里的判断（"确认无自改内容后可删"）用户难以核实——2026-10-07 实例：`~/.agents/skills/hopspec` 的 SKILL.md 修改时间比版本戳晚一小时，有无自改说不清。挪进备份区而不删除，用户就算改过也不会丢，"可能有自改"不再是阻止自动处置的理由。原地覆盖成新版不采用：旧位置不是安装位置，覆盖会让同一件 skill 在两处各养一份，且改过名的旧件（如 `hopskill-build`）覆盖后会与新名并存、双重触发。
  - **扫描面**：①当前 carrier 的历史装载位置（Codex 族=`~/.agents/skills/`——"demo 恒项目级"口径〔2026-08-27〕之前的历史用户级装载点,0096 事故病灶;CC 族=`~/.claude/skills/` 下的 demo 件——demo 改恒项目级前的旧装）;②cwd 项目级 demo 位置（2026-08-27 至 2026-10-06 `--demo` 的 Codex 装载点 `<cwd>/.agents/skills/`,仅 Codex 族扫）;③本次安装的现行目标目录,只看 `demo-` 开头的目录（CC 族旧 `--demo` 与正式件装在同一目录,现行目标对其他件不算旧位置,对旧 demo skill 算）。
  - **只有 Codex 的两处历史位置做完整扫描，其余扫描根一律只看 `demo-*`**：完整扫描（六件、旧名、`hop-*`、用户自建件都处置）只用于扫描面①的 `~/.agents/skills/` 与扫描面②，且该目录不是任何载体的现行安装目录（本机各载体 home 下的 `skills/`、`~/.claude/skills/`、本次目标）。CC 族的 `~/.claude/skills/` 本身就是 Claude Code 的现行安装目录，只有其中的旧 demo skill 算旧件。原因：一次 setup 依次给多个载体安装，A 载体的现行目录对 B 载体不是旧位置——2026-10-07 实撞：opencode 那一轮把 `~/.claude/skills/` 当旧位置完整扫描，把 Claude Code 正在用的当前版 hopbuild2 挪进了备份区。
  - **认领判据**：目录下 SKILL.md 含本安装器版本戳（`driver: @hoplogic/hopjit`）才认——不是本器写的文件零打扰，不读之外不做任何事。陈旧判据按类别分：本器自带件只看版本戳的版本号是否落后当前包版本；用户自建件在版本落后之外，spec.md 缺 `engine_min_version` 指纹（0093 前的 pack 旧产物）也判陈旧——该指纹由 `pack` 注入，自带件的 spec.md（如 `hopbuild2/spec.md`）本来就不带它，按指纹判会把当前版自带件误判为陈旧;旧 demo skill 不看版本新旧,带本器版本戳即判废弃。
  - **分类判据**：
    - **本器自带件**：目录名是现行安装集六件之一（`hopspec`、`hopspec-mcp`、`hop`、`hopbuild`、`hopbuild2`、`hopfix`），或是这六件的旧名（现有一个：`hopskill-build`，2026-08 改名为 `hopbuild`），或以 `hop-` 开头（`--plus` 进阶件），或以 `demo-` 开头（旧形态演示 skill）。这些件都有现行替代：六件已随本次安装刷新到现行位置，`hop-*` 由 `setup --plus` 重装，`demo-*` 已改为 HopAnt 装在 `~/.hopjit/ants/`；
    - **用户自建件**：带本器版本戳但不属于上一类的目录，即 `hopjit pack` 打包出的 spec skill。本器没有它的新版源，只能提示用户走 `/hopfix` 做版本迁移（validate error 清单为工单的定向修正）。
  - **例外：Codex 的 `--plus` 现行位置**：Codex 族的 `--plus` 进阶件现行就装在 `<cwd>/.agents/skills/`（扫描面②同一目录），那里的 `hop-*` 陈旧副本属于现行位置，不挪动，只提示在项目目录重跑 `hopjit setup --carrier codex --plus --force` 刷新。挪走会让未带 `--plus` 的这次 setup 把用户在用的进阶件拿掉。
  - **备份区布局**：每次 setup 的挪动落在同一个目录 `~/.hopjit/stale-backup/<时间戳>/`（时间戳=本次 setup 开始时刻的 ISO 串，冒号换成连字符，同一次 setup 里所有载体共用一个），每件挪成 `<时间戳目录>/<目录名>`，与已挪进的同名件冲突时依次加 `-2`、`-3` 后缀。同目录写一份 `RESTORE.txt`，每行一条"备份路径 → 原路径"，供用户挪回。
  - **挪动方式与失败退回**：先 `rename`；跨文件系统（`EXDEV`）时改为整目录复制后删除原目录。建备份目录失败、`rename` 与复制都失败时，原目录保持不动，该件退回原口径只提示，并说明挪动失败的原因。
  - **与 `legacy_note` 的关系**：Codex 分支的旧项目级残留检测（[[codex-driver-carrier]] 安装布局节）在本扫描之前计算；被本扫描挪走的路径从 `legacy_note` 的点名与删除命令中剔除，全被挪走时 `legacy_note` 缺席。
  - **响应字段** `stale_notes: [line]`（可选，零发现缺席）。每条一行：自带件写"已挪走：原路径 → 备份路径（原因），需要时按 RESTORE.txt 挪回"；退回提示写原路径、原因与失败说明；用户自建件写原路径、版本与 `/hopfix` 指路。
  - 正例：`~/.agents/skills/hopspec` 带 v0.2.6 版本戳，`setup --carrier codex` 后原目录不在，`~/.hopjit/stale-backup/<时间戳>/hopspec/SKILL.md` 在，`RESTORE.txt` 有对应行，`stale_notes` 有"已挪走"一行；`~/.agents/skills/hopskill-build` 同样挪走，不再被当成用户自建件指路 `/hopfix`。反例：`~/.claude/skills/user-own-skill` 无版本戳，不报不动；`~/.claude/skills/my-flow` 带旧版本戳但不在自带件名单，原地不动，`stale_notes` 指路 `/hopfix`；`~/.hopjit/stale-backup` 被一个普通文件占位导致建目录失败时，陈旧副本原地不动，`stale_notes` 退回提示并写明失败原因。
  - **能力契约与关键逻辑**：

```
HopType: StaleSkillScan    # setup 第 6 项职责的执行体（src/cli.ts setup 动作内联段）
  Fields:
    - scan_roots % [path]          # 扫描根目录：上文扫描面三处，按载体族取，同一路径只扫一次
    - target % path                # 本次安装的现行目标目录（只对 demo-* 视为旧位置）
    - driver_version % text        # 当前包版本，与版本戳比较判陈旧
    - backup_root % path           # ~/.hopjit/stale-backup/<时间戳>，本次 setup 首次需要挪动时才建

  def handle(dir: path) -> line | null
    # 对一个候选目录做认领、判陈旧、分类、处置；不认领或不陈旧返回 null，否则返回一条 stale_notes 行
    HopSop:
      dir 所在扫描根不是 Codex 的两处历史位置，或是某个载体的现行安装目录，且名字不以 demo- 开头 → 返回 null
      读 dir/SKILL.md；不存在或不含本器版本戳 → 返回 null
      名字以 demo- 开头 → 判废弃；本器自带件版本戳落后 → 判陈旧；用户自建件版本戳落后或 spec.md 缺 engine_min_version → 判陈旧；都不是 → 返回 null
      Codex 族且 dir 在 <cwd>/.agents/skills 且名字以 hop- 开头 → 返回"重跑 setup --plus --force"提示行
      名字不属于本器自带件（六件、旧名 hopskill-build、hop-*、demo-*）→ 返回 /hopfix 指路行
      建 backup_root（已建则复用）；目标名 = 名字，撞名则加 -2、-3
      尝试 rename(dir, 目标)；EXDEV 则 复制整目录 后 删除 dir
      成功 → RESTORE.txt 追加"目标 → dir"，返回"已挪走"行
      任何一步失败 → 原目录不动，返回原因加失败说明的提示行
```
- **输出 InstallSkillResponse**：`{ status:'ok', carrier, driver_version, driver_source, installed: [路径…], target }`；恒带 `mcp_registered`/`mcp_config_bootstrapped`（2026-10-01 起缺省注册,可为 null）与 `permission_written`,另按情况带 `mcp_note`/`mcp_config_note`/`permission_note`（配置自举明示——学了什么模型/端点/凭证名,或未学习原因）；`stale_notes`（可选——陈旧副本提示,见上条）；失败 `{ status:'error', message }`。
- **为何随包发 driver 是前提**：install-skill 从 `node_modules/@hoplogic/hopjit/driver/` 读源——`files` 白名单必含 `driver/`（已含）。
- **入门 examples 随包（2026-08-04 作者定；2026-08-05 收平路径——作者指出别让新手多敲字）**：入门四件（`data-quality.md`+`doc-review.md`+`demo-data.json`+`GETTING-STARTED.md`）直接放 `examples/` 根随包（files 白名单按文件挑）。全量 22 个 spec 仍只在仓库。 **用户面文档随包（2026-10-02 作者三轮定口径）**：入口五件 + 概念层 15 份 + 教程用户系列 14 份 + D10 共 35 份**逐文件**进 files 白名单（不进整目录;ARCHITECTURE/D 系列/工程实现链/设计层/追溯表/Doctree/i18n 不进）,且进包的是 prepack 清洗后的发布件、postpack 恢复源——清单权威 `scripts/pkgdocs-manifest.json`,规则权威 [[release-engineering#^anc-release-tarball-self-contained]]，本条只记装载面事实。
  - **仓库路径与包内路径同形**——新手命令恒为 `run examples/data-quality.md`，无论 clone 仓库还是纯 npm 全局装都一次命中（getting-started 子目录曾致命令变长+两处路径不同形，已废）。

**`/hop` 分派规则（driver 面契约,2026-10-01 作者定——用户可见入口收敛后 hop 要替用户选路）** ^anc-cli-hop-dispatch：/hop 进来先判用户给的是什么,五条路,拿不准问一句不猜：

| 用户给的 | 走 | 说明 |
|---|---|---|
| 一句话能答完、不需要留痕的 | 直接答,不进 hop | hop 不劫持对话 |
| 复杂的、需要可控可靠保障的活（多步/要进度/要核验/要可续） | 升格为任务卡,引擎管进度与把关 | hop 的主路（driver/hop-skill.md §1 起） |
| 一份现成的 HopSpec 文件 | 按 `hopspec` skill 协议直接跑,不升格 | 参数确认/介入点/终态呈现归 hopspec 协议;`/hop list` 不列它 |

| 构建/翻译/修订 HopSpec | 翻译→`hopbuild`;改几处→`hopfix`;`hopbuild2` 仅用户点名时 | hopbuild2 是实验件,不按模型能力自动选（留卡） |
| 用户明说"走 MCP / standalone" | 按 `hopspec-mcp` skill 协议 | 另一种运行形态,server 进程自跑,本对话只启动与介入 |

**分派判断不念给用户听,进入哪条路给一句固定开场白（作者 2026-10-12 抓"这个描述也很土"）**：分派表是给 agent 的选路规则,"用户给了一份现成的 HopSpec 文件——按 hopspec 协议跑,不升格。先读 hopspec skill 的协议再起跑"这类话是 agent 在念规则给自己听,不进用户可见消息。走"现成 HopSpec 文件"这一路时对用户只说一句：**"现在有现成的 HopSpec 流程，下面按 HopSpec 运行。"**（大小写统一写 HopSpec）;其余四路同理——对用户说的是接下来要干什么,不说为什么选这条路。三载体 hop-skill.md 分派节同款,check-driver-carriers 的 token parity 核在场。

**分派前的 MCP 可达性检查与修复（2026-10-07 todo/0146,取代 2026-10-03 起"缺 .mcp.json 就补跑 setup"一句）**：复用模式驱动优先用 hopjit MCP 工具（[[mcp-server#^anc-mcp-reuse-driver-tools]]）,所以 /hop 进来先确认这些工具在本会话可用。三种情况：

- **工具在本会话可见**（能调 `mcp__hopjit__server_status`）→ 直接用 MCP 工具驱动。server_status 报独立模式不可用只影响 /hopspec-mcp 那条路,不影响主路;
- **未注册**（项目根无 `.mcp.json` 或其中无 `mcpServers.hopjit`,且工具不可见）→ 跑一次 `hopjit setup` 补注册与放行,告诉用户"已在本项目注册 hopjit,新开会话后生效";本会话按 CLI 回退驱动;
- **已注册但工具不可见**（server 起不来）→ 跑 `hopjit --json doctor`（^anc-cli-doctor,只报不改）,读 items 里 status 为 fail 的项：detail 是事实、hint 是补法。agent 能修的（如 mcp_handshake 的 hint 给出 `.mcp.json` 里 command 该改的绝对路径）就修,修后提示"新开会话后生效";修不了把 detail 与 hint 原样告诉用户。2026-10-09 前此分支写"跑 setup 读 mcp_handshake"——setup 是写操作,排障不该先写,且只答握手一问。本会话按 CLI 回退驱动。

**分派与总结阶段读原料用载体的只读文件工具,不走 shell（2026-10-11 作者抓"这些为什么要用 bash？"）**：/hop 在分派、列活、切活、总结时要读不少东西——两级 `index.md`、`hop_tasks/current`、`.hopstate/*/state.json`、任务卡的 Steps 终态与处置记录、HopAnt 入口 spec。这些都是"看",不是"做"。规则：读文件用载体的文件读取工具,找文件用通配搜索工具,找内容用内容搜索工具（CC 是 Read / Glob / Grep,Codex 与 opencode 用各自的同类只读工具）;`ls` / `cat` / `head` / `sed -n` / `grep -n` / `diff` 这类只读查看一律不经 shell。原因：载体对 shell 命令逐条弹窗,弹窗里是一坨管道,用户看不出 agent 在干什么;只读工具免弹窗、意图可读。实撞：2026-10-11 `/hop 把天气查询总结`——真正需要的只是两次管理工具调用（`ant_pack` / `ant_adapt`）,却为了找原料拼了七八条 `ls | grep` / `cat` / `diff <(…)`,每条一次弹窗,`diff <(…)` 还撞沙箱又补一条。shell 只留给真正要执行的动作：任务卡《已批准命令》上的命令（走 `run_approved_command`）、build / 测试、git 的写操作。本条是 driver 面纪律,三载体 hop-skill.md「输出纪律」节同款（check-driver-carriers 的 token parity 核在场）。

**/hop 的定位与 description 契约（2026-10-09 todo/0139 第 2 块,作者 2026-09-30 定方向——"未来 /hop 应该是 hop 系列的总入口，从安装 维护 使用，都在这里找到最放心最可靠的路径"）**：分派表说的是"进来之后走哪条路",description 说的是"什么该进来"——同一契约的两面,description 是模型决定调不调这个 skill 的唯一依据（用户可见件只有 hop 一个,^anc-cli-install-skill-single-entry）,所以它的内容与形态也归本条管。

- **定位一句**：/hop 是 HopSpec 的总入口——手头的活、现成的 spec 与 HopAnt、构建修订、hop 自身的安装升级体检、接续上次的活,都从它进;接入外部 MCP 工具由它指路。2026-10-09 前的定位"日常把活交给引擎管"只覆盖主路一条。
- **description 的结构（四块,顺序固定）**。作者三条要求：hop 是什么要先说清（"hop 是啥,llm 不知道"）、条目分行（"做好 item 分行"）、对 LLM 自己的好处要讲（"降低 llm 自身的压力,延展 llm 的复杂任务调度和管控能力和可靠性"）：

```
HopSchema: HopSkillDescription
  - 定位与 HopSpec 一句 % line   # "<入口符号> 是 HopSpec 的总入口。HopSpec 是把一件活写成带目标、步骤、核验点的结构化规约,交给 hopjit 引擎按步执行：进度有账、把关由引擎强制、中断可续。"
  - 对执行 LLM 的好处 % [line]   # 恰三条,顺序固定：(1) 卸掉记账压力——进度、产出、把关结果全在引擎账上,不占上下文不靠记;(2) 复杂任务的调度不靠自己撑——顺序/并行/分支/循环/重试由引擎按规约执行,只管当前一步;(3) 可靠性由结构保证——核验点跳不过去,不可逆动作前必过人审或终检,中断从账上接着跑
  - 什么时候用 % [line]          # 恰五条,与分派表同源：① 多步骤要留进度要核验要可续的活→升格任务卡;② 跑现成 HopSpec 文件或已装 HopAnt;③ 自然语言 skill 翻译成 HopSpec 或修订已有 spec;④ hop 自身的安装、升级、体检从 /hop 走,用户不记 hopjit 子命令——接入外部 MCP 工具 /hop 给指路（接入流程未落地前只许写"指路",不许诺具体命令）;⑤ "继续上次的活 / 接着干"→接上手头活的账
  - 排除句 % line                # "一句话能答完、不需要留痕的活不进 /hop。"
```

- **形态约束三条（校验规则,出处各一）**：①**单物理行**——Codex provider、`scripts/check-driver-carriers.mjs` 的 frontmatter 核、`readSkillFrontmatter`（^anc-cli-doctor 的 skill_visible 问）三处都按行取 `description:` 键值,YAML 块标量 `description: |` 读出空,所以"item 分行"落成行内编号（好处 (1)(2)(3),场景 ①-⑤ / (a)-(e)）,真正的分行版写在正文开头定位段;②**≤1024 字符**（按 JavaScript 字符串长度计）——Agent Skills 开放标准的 description 上限,超限的 skill 可能被校验器拒或静默跳过;③**不含 XML 标签**（同标准）。机检：`scripts/check-driver-carriers.mjs` 对三载体 hop-skill.md 核三条外加"含'总入口'或'single entry point'字样"(定位改了没同步的最小探针),挂 check:fast。
- **三载体语言分工**：CC 版中文、入口符号 `/hop`;Codex 版英文、`$hop`;opencode 版英文、裸 `hop`（隐式触发,按 description 装载）。英文是同义翻译——三条好处与五条场景一条不少,只压措辞。正文开头定位段三载体都是中文（正文本就中文,只有 description 分语言）,把同一份内容真正分行写全：标题 `# <入口符号> — HopSpec 的总入口`,第一段=HopSchema 四块的分行版,其后保留主路说明段（"把你正要干的活…升格为一份 HopSpec…引擎只管三件事"）。
- **派生面同步**：教程 04（docs/tutorials/04-日常活交给hop.md,compact 派生）「一句话定位」节、Doctree 的 hop-skill 行与教程 04 行随源同改;hopspec / hopspec-mcp / hopbuild / hopbuild2 / hopfix 五件 description 不在本契约内。

**commit 批准停点的 CLI 入口（2026-10-07 todo/0146）** ^anc-cli-approve-commit：组合根注册了批准账解析函数（[[exec-engine#^anc-exec-commit-approval]]）,所以 CLI 起的 run 走到未批准的 commit 同样过批准关卡。**CLI 组合根不注册安全分析函数**——命令行宿主不加载独立模式配置,没有分析模型可用:引擎从 body 判定全部动作安全的 commit 照常直接执行;其余未批准的 commit 按固定模板转人工:`run`/`submit_and_fetch_next`/`resume` 返回 `status: paused`、`pause_reason: commit`,`presented_data.context` 带 `step_id`、`fingerprint`、`analysis`（source 为 template,模板后果说明）、`body`,`response_options` 为三选项。同一份批准账里已有的记录照样认:MCP 宿主分析为安全的、人选过"这一步以后都通过"的,CLI 路径都不再停。批准入口两个,写同一份批准账：MCP 工具 `approve_commit`（[[mcp-server#^anc-mcp-commit-approve]]）与本子命令 `hopjit approve_commit <step-id> --fingerprint <指纹> --scope once|task`。
- **为什么 CLI 也要有**：CLI 保留给 CI、脚本与载体不支持 MCP 时的回退。只有 MCP 入口时,这些环境里任何带 commit 的 spec 都会停在批准点且无法继续。
- **人批准这一下在 CLI 路径上如何成立**：与 MCP 路径同一协议——driver 先用大白话把安全分析的结论（每个需要人确认的动作的后果与建议）讲给用户,代码在用户要求时才贴,在对话里给三个选项,用户选"只批准这一次"（--scope once）或"这一步以后都通过"（--scope task）后才跑这条命令（[[mcp-server#^anc-mcp-commit-approve]]「调用方呈现协议」）。载体对这条 Bash 命令弹不弹窗与批准无关。CI 与脚本里由写脚本的人显式写这条命令,等同于写脚本时批准。
- **行为**：ExecutionEngine.load（不认领通道,两种通道的 run 都可批）→ approveCommit;指纹对不上报 COMMIT_NOT_APPROVED（报文带当前指纹）,已批准返回 `already_approved: true`,步骤不是带 body 的 commit 或 scope 不是 once/task 报 INVALID_STATE。只写批准账,不推进;批准后 `resume`（或任一推进命令）续跑。scope=once 时本次运行内指纹不变的 for-each 各轮、并行子实例、续跑都不再停,重跑与下一次运行重新问（与 [[exec-engine#^anc-exec-commit-approval]] 同句）;scope=task 时这一步在当前 body 下以后都通过,body 一改就重新分析。
- **`--workspace`**：与 `run`/`init` 同一 `resolveWorkspaceArg`（^anc-cli-workspace-arg）,显式路径不存在报 WORKSPACE_NOT_FOUND;`--state-dir` 相对它解析。与 MCP 工具 approve_commit 的 `workspace_dir` 参数对称——起跑时显式指定过工作区的 run,批准时也能用同一个工作区定位,而不依赖 Bash 当下的 cwd。不传时 state-dir 相对 cwd 解析,与改动前一致。

```
HopType: CliCommitApprove
  # hopjit approve_commit 子命令
  Specs:
    approveCommitCommand(
      step_id % line,           # 位置参数,停下来的 commit 步骤号
      fingerprint % line,       # --fingerprint,停点载荷 presented_data.context.fingerprint
      scope % line,             # --scope,once 或 task,取自用户在三选项里的选择;缺席报参数错
      instance % line?,         # --instance,缺席取 state-dir 下最新实例
      state_dir % line?,        # --state-dir,缺省 .hopstate,相对工作区根解析
      workspace % line?         # --workspace,缺省 cwd;显式路径须是已存在目录
    ) -> response % CommitApproveResponse   # stdout 输出（[[#^anc-cli-commit-approve-response]]）;抛错走 errorExit
```

```
approveCommitCommand(step_id, fingerprint, scope, instance, state_dir, workspace):
1. ws = resolveWorkspaceArg(workspace)                     # 显式路径不存在 → errorExit WORKSPACE_NOT_FOUND
2. instanceDir = resolveInstance(resolve(ws, state_dir), instance)   # 找不到 → errorExit INSTANCE_NOT_FOUND
3. engine = ExecutionEngine.load(instanceDir)              # 不认领驱动通道
4. 输出 engine.approveCommit(step_id, fingerprint, scope)    # ok 支与 error 支都走 stdout 业务通道,退出码 0（与 resume 等命令的业务错误同律）
5. [catch(第 1-3 步抛错)] errorExit(报文)                     # stderr,退出码 1
```
- **驱动提交不能绕过**：`submit_and_fetch_next <commit 步骤> --output ...` 对带 body 的 commit 返回 COMMIT_BODY_ENGINE_ONLY,产出只能由引擎执行 body 得到。

CLI 回退时如实告诉用户一句"本会话 hopjit 工具不可用,改用命令行驱动,每条命令可能弹窗确认"。不为回退配置 Bash 放行规则——驱动命令参数每次不同,前缀规则要么放不住,要么放得太宽。回退时每条命令只做一件事:不加管道、不截断输出（`| head` 一类截断会触发载体的管道检查而多弹窗,且丢掉响应后半截的字段）。

**运维场景的特殊规则按需加载**（作者定"针对运维场景下的特殊规则,普通人用不上,要考虑如何触发"）：机器分级（测试机整机放行/生产机只读进 act、变更进 commit）、按机器写 `## 已批准命令` 前缀等规则放包内 `driver/hop-references/hop-ops.md`（三载体各一份,装到 `<目标>/hop/references/hop-ops.md`——不放 driver/references/ 是因为那个目录整体拷进 hopspec/references/）,主线只留一句触发指引——活涉及 ssh/远端机器/多台环境,或项目 `hopjit.yaml` 有 `environments:` 段（本批只是 agent 读的约定,引擎不解析;配置加载对未知顶层键不拒——core 配置只对 resource_limits 内部键做未知拒）时才读。普通人永远不碰到这一段。

**dirs 批准停点的 CLI 入口与 `--approve-dirs`（2026-10-07 todo/0148）** ^anc-cli-approve-dirs：spec `Config.dirs` 声明了 workspace 之外的目录且本机还没批过这份清单时,`run`/`init` 后的首次推进（`run` 本身,或 `init` 后的 `resume`）返回 `status: paused`、`pause_reason: dirs`,`presented_data.context` 带 `dirs: [{path, mode}]`（只列 workspace 外的,mode ∈ read|readwrite）与 `dirs_hash`（引擎侧权威 [[exec-engine#^anc-exec-dirs-grant]]）。批准入口两个,写同一份 `dirs_approvals.json`：MCP 工具 `approve_dirs`（[[mcp-server#^anc-mcp-dirs-approve]]）与本子命令 `hopjit approve_dirs <dirs-hash> [--instance id]`。
- **行为**：ExecutionEngine.load（不认领通道）→ approveDirs;哈希对不上报 DIRS_NOT_APPROVED（报文带当前哈希与清单）,已批准返回 `already_approved: true`,实例没有 workspace 外目录报 INVALID_STATE。只写批准账,不推进;批准后 `resume` 续跑,同一份清单之后不再停。
- **人批准这一下如何成立**：与 approve_commit 同——driver 把清单（路径 + 只读/读写）呈给用户、在对话里问同不同意,同意后才跑本命令;载体对 Bash 命令的弹窗不当批准;CI 与脚本里由写脚本的人显式写这条命令（等同写脚本时批准）。
- **`run` / `init` 的 `--approve-dirs` 参数**：起跑即调 approveDirs 记账,不停——脚本 / CI 场景,写参数的人就是批准的人。与 MCP 复用驱动 `run` 的 `approve_dirs` 字段同义。**子实例入口不收此参数**（`run --parallel-parent` / `run --call-parent` / `init --parent`——子实例不重展开不重核,经 inheritedDirs 继承父的清单,[[exec-engine#^anc-exec-dirs-grant]] 子实例与恢复条）;init 路径下在 initExecution 返回 ok 之后调（此时 instanceDir 已就位,账路径可解析）。
- **与 commit 批准的关系**：两道闸正交——dirs 闸在首个步骤之前（read 授权 act 步就要用）,commit 闸在每个 commit 步骤之前;账分两个文件,resolver 共用一个注册位。

**`hopjit ant` 契约** ^anc-cli-ant：HopAnt 生命周期①安装、②适配、⑤封装、⑥分享的命令行承接（概念 [[../concepts/HopAnt概念#^anc-struct-hopant-lifecycle]];业务全在 [[hopant#^anc-struct-hopant]] 模块,本命令族是薄壳）。七个子命令：

- `ant install <目录> [--dry-run] [--scope user|project]`：来源是单 HopAnt 目录或 HopAnt 包根（含 `ants/`）。`--scope` 定装到哪一级（[[hopant]] 决策 1）：缺省 `user`（`~/.hopjit/ants/`,装别人的 HopAnt 是给自己用）;`project` 落 `<工作区>/hop_tasks/ants/`（用户说"只在这个项目里用"）。撞 id 只在目标级内判。先 `planInstall(src, roots[scope])`;`--dry-run` 只输出计划（含撞 id 与哪些 ant 带 bootstrap.js）不写盘;否则 `applyInstall`。撞 id 整单拒（`HOPANT_ID_CONFLICT`）。装完响应里 `bootstrap_pending` 列出带安装脚本的 ant,提示用户先 `ant bootstrap <id> --dry-run` 看计划——**install 不自动跑任何脚本**。
- `ant adapt <id>`：id 经 `resolveAnt(roots, id)` 两级找（项目级先于用户级,决策 9）,找不到 `HOPANT_NOT_FOUND`;组合根取好机器侧事实传入 `adapt`——两级注册面经 tools-registry 的 `loadTwoLevelRegistry(sysPath, projPath)`（config 都缺席按空注册面不报错;空文件/纯注释按无配置;顶层不是 YAML 映射抛 `TOOLS_FILE_INVALID` 走 stderr;`HOPJIT_CONFIG` 在场即单文件语义——与 mcp-server 同律,CLI 自身不写合并规则）;`process.env`;`PATH` 拆目录;归属标识先读 `~/.hopjit/config.yaml` 的 `owner_id`,没有才由 `git config user.name`（在工作区目录里跑——MCP 下 server cwd 不是工作区,2026-10-10 review 补 cwd） / `os.userInfo().username` / `os.hostname()` 现算交 `ownerId`（[[hopant]] 决策 8：打包时明示并问要不要改、答过写回该键;本命令只读不写）;引擎版本用 `getEngineVersion()`（读失败 null,fail-open）。报告全绿即 `writeStamp`;响应带 report 与 hints 全文;**报告有缺口时 stdout 仍是完整 JSON、退出码 1**（消费方按 exit code 判绿红,按 JSON 读缺口）。
- `ant list`：`listAnts(roots)` 两级合并（项目级在前;同 id 两行都在,各带 `scope`）+ 每个 ant 的 `adaptState`（never / stale / adapted 三态在 hopant 模块里判,CLI 只调——薄壳不写分支）。响应每项 `{id, scope, title, adapt_state}`。
- `ant remove <id> [--keep-store] [--scope user|project]`：`removeAnt(roots, id, keepStore, scope?)`——不带 `--scope` 删两级查找命中的那一个（项目级在就删项目级）,带则删指定级;`--keep-store` 把 inner_store 挪到备份位（恒 `~/.hopjit/ants-store-backup/<id>/`）。响应带 `scope`。
- `ant bootstrap <id> [--dry-run]`：id 两级找（同 adapt）;spawn `node <antDir>/bootstrap.js [--dry-run]`,cwd 为 antDir,stdout/stderr 原样进响应,脚本 exit code 进 `returncode`;**脚本非零时本命令退出码 1**;没有 bootstrap.js 响应 `has_bootstrap: false` 不报错。

- `ant pack <spec> [--out <dir>] [--id <id>] [--assets <文件>…]`（2026-10-09 子卡 C）：组合根把 spec 绝对路径、`--out`（缺省 `<cwd>/ants`——产物 `<out>/<id>/` 是单 ant 目录,detectSource 的 single 形态,`ant install <它>` 能装）、`--id`、`--assets` 传给 `packAnt`;响应带 `reconciled`（头对账增删,/hop 读给用户看"封装改了你 spec 头的哪几行";`tools_added` 里的非标准工具是占位签名,装机前要按真实参数改）。spec 文件不存在或不可读 → `PACK_ERROR` errorExit 退 1;其余错误码见 hopant 错误码表。不覆盖已有目标（HOPANT_TARGET_EXISTS）。
- `ant share <id>… [--out <dir>] [--name <包名>] [--pkg-version <v>] [--owner <标识>|--yes]`（2026-10-09 子卡 E;包版本参数叫 `--pkg-version` 不叫 `--version`——后者是 commander 全局的引擎版本旗,子命令里同名会被它截走）：每个 id 经 `resolveAnt` 两级找（项目级先;这个项目总结的 HopAnt 不须先装用户级就能分享）。归属标识四态（决策 8"答过不再问",2026-10-09 review 改正——此前写成"没带旗仍问"）：①`--owner <值>` 用它;②否则 config.yaml 有 `owner_id` → 直接用,不问;③否则 `--yes` → 现算 `用户-机器` 用它;④否则（首机且无旗）→ 响应 `{status: 'ok', action: 'share', owner_prompt_required: true, owner_default: <现算值>}` 退出码 0 **不写包**,driver 在对话里问用户后带 `--owner` 重跑（CLI 不接终端对话,问人归 /hop;一台机器只会走到④一次）。成功后把用的 owner 写回 `~/.hopjit/config.yaml` 的 `owner_id`（只动这一键,`yamlDump(cfg, YAML_DUMP_OPTS)`;文件不存在新建）,响应带 `owner_written: <路径>`。四核任一不过 → 错误码 errorExit 退出 1,不写。写了包时响应带 `credential_scan`（回执：扫了几个文件 / warnings / method heuristic / disclaimer 免责句）,driver 把 warnings 逐条与 disclaimer 念给用户。`--out` 缺省 `<cwd>`,包目录落 `<out>/<name>/`。

**实现落点（2026-10-10 todo/0154）**：七个子命令的组合根无关部分（取 home、两级配置路径、PATH、归属标识、引擎版本后调 hopant 模块;响应对象的组装;`next_step` 文案）住 `src/hop-admin.ts` 的 `antList` / `antInstall` / `antAdapt` / `antRemove` / `antBootstrap` / `antPack` / `antShare`,机器侧事实经 `AdminContext` 传入;`cli.ts` 的 `ant` 子命令与 `mcp-server.ts` 的 `ant_*` 工具是它的两个薄壳（[[mcp-server#^anc-mcp-admin-tools]]）。上文各子命令条里的 `process.env` / `process.cwd()` / `homedir()` / `os.userInfo()` / `os.hostname()` 读作 `ctx.env` / `ctx.cwd` / `ctx.home` / `ctx.login` / `ctx.hostname`;`ant adapt` 报告有缺口、`ant bootstrap` 脚本非零时的退出码 1 由 cli.ts 置,MCP 侧调用方读 `report.ok` / `returncode`。

响应形状见响应类型章 [[#^anc-cli-ant-response]]。错误码见 [[hopant#^anc-hopant-errors]],经 `errorExit` 走 stderr、退出码 1——stdout 不出 JSON（MCP 侧同一个 Error 经 driverErrorOf 转 `{error:{code,message}}`）。**两级配置合并不在 CLI 里写**：v0.37.0 曾在 cli.ts 放一个 `readAdaptRegistry` 复制 `mergeConfigs` 的合并,review 实跑抓到三处分叉（空文件崩 / 顶层非映射静默按空 / `HOPJIT_CONFIG` 不认）,v0.38.1 挪进 tools-registry——薄壳契约 ^anc-struct-hop-cli 的「不含业务判定」由此守住。

**`hopjit pack` 契约** ^anc-cli-pack：把一个 hopskill spec 打包成**独立具名 skill**——用户视角是"装了一个叫 doc-review 的能力"，HopSpec/hopjit/通用 driver 全部成为实现细节。用户要的是具名能力，spec 是能力实现。

- **validate 闸门含 doc-ref 解析上下文**（hopissues/0077——原恒缺席 P15 空转：知识文件/章节缺失 validate 报 error 而 pack 照 ok 写产物，打包假绿）：pack 是交付时点，知识闭合是产物硬要求，不用 validate 命令的 lenient 跨目录降级——error 即拒不写产物；知识文档收集面缺失同响亮拒（静默跳过=产物装上即 P15）。
- **carrier 分流**：默认 `--carrier cc` 保持既有行为；`--carrier codex` 生成 Codex 项目 skill；`--carrier cfuse-cc`/`cfuse-codex` 复用对应原生系的包装模板（CC 系 `/skill` 或 Codex 系 `$skill`）；`--carrier opencode` 复用 CC 系包装模板（`/skill` 入口——opencode 兼容 CC skill 格式），`--dir` 缺省 `.opencode/skills`（项目级，opencode 原生发现路径）。
- **`--dir` 缺省是项目级**（`.claude/skills` / `.agents/skills` / `.opencode/skills`，按 carrierFamily）——与 install-skill 不同，pack 产物跟项目走。cfuse 用户要装到 cfuse home 用 `--dir` 显式指定（如 `--dir ~/.codefuse/engine/cc/skills`）。
- **薄包装前置段按 carrier 生成**装驱动命令/位置（cfuse-* 指引 `--carrier cfuse-*`，不硬编码原生 `~/.claude`/`~/.codex`）。
- **skill 版本注入**（hopissues/0092——pack 薄包装 SKILL.md frontmatter 原恒缺 version：HopSpec 头部无 version 槽，源 skill 版本在 hopbuild 翻译期即丢，pack 无源可继承，消费方读空回退 unknown 致任务归属丢失）：`--skill-version <v>` 选项显式注入 frontmatter `version:` 行（两载体薄包装同注）。
  - 未传时 frontmatter 不写 version 行且 pack 输出 note 提示"产物无版本号——消费方读 version 的场景传 --skill-version"（交付时点不再静默；不设缺省值——编造版本号比缺席更误导）；
  - 全链版本槽（SpecHeader 加 version 字段让翻译期承接源 skill 版本）属语法面改动须经概念层决策，另案不并本条。
- **engine_min_version 注入**（todo/0093 版本兼容性原则，与 --skill-version 正交——skill 业务版本给消费方，engine_min_version 给引擎闸）：pack 时向 spec 的 Config 段注入 `engine_min_version: <打包时引擎版本>`（readPackageVersion 单点；spec 已有该键则保留作者手写值不覆盖——作者放宽是知情行为）；引擎 init 比对契约归 [[exec-engine#^anc-exec-engine-min-version-gate]]。

- **name 覆盖时 Id 随名改写（2026-08-11 作者指出"Id 不动会干扰目标环境"后补定）**：`--name`（或内部 name 参数）与 spec 自身 `Id` 不一致时，打包**副本**的 Id 行改写为 name（英文 `Id:` 与中文 `标识:` 两种写法都认，保留原关键词——2026-10-06 补：此前只认 `Id:`，中文关键词 spec 带 name 打包时 Id 不改写，与安装 HopAnt 要求 Id 等于文件名冲突；改写函数 `rewriteSpecId` 与演示 HopAnt 生成共用）——Id 是运行痕迹的命名根（hoplog 目录 `<spec_id>-<时间戳>`、状态元数据、call 寻址），skill 名与 Id 不一致会让 demo-rename 的运行留下 confirm-commit-* 日志，且可能与用户同 Id spec 的痕迹混淆。
  - **源文件不动**（改的是 skill 内副本）；不传 name 时零改写（原样打包，既有行为不变）；
  - ⚠️ 副本 Id 改写后，其它 spec 若按旧 Id `call` 该副本会找不到——demo 场景无此耦合；将来出现"打包被 call 依赖的 spec"需求时复审。

- **输入**：spec 文件路径。先 `parseSpec` 校验（validate 闸门，error 即拒——pack 不放行坏 spec），并从 AST 取 `id`（默认 skill 名）与 `goal`（生成触发描述）。
- **目标与展开布局**：
  - CC：目标默认 `.claude/skills/`，显式入口 `/<skill名>`；
  - Codex：目标默认当前项目根下 `.agents/skills/`，显式入口 `$<skill名>`；Codex 会从当前目录到仓库根扫描 `.agents/skills`。
  - 两者均展开为 `<skill根>/<skill名>/SKILL.md + spec.md + references/assets`。
  - `SKILL.md`——**生成的薄包装**（见下），frontmatter `name`=skill 名、`description`=由 goal 生成的触发描述（含中文任务动词，CC 隐式触发靠它）；
  - `spec.md`——spec 文件原样拷入（改名 spec.md，skill 目录即自包含）；
  - spec 引用的**知识文档**（doc-ref `[[X#…]]` 提到的同目录 .md）逐个拷入——doc-ref 按 cwd 相对解析，spec 与知识文档必须同目录（同 hopbuild 的知识文档同住约定）；
  - **数据资产**（`--assets <逗号分隔文件名>`，2026-08-06 补；**2026-09-04 扩目录形态**——hopissues/0069 多文件 skill 语料实锤：成熟 skill 的附属资产是 `references/`、`scripts/` 整目录，逐文件点名既繁琐又易漏）：spec 运行依赖的非 .md 资产（演示数据 JSON/CSV、引用文档目录、脚本目录等）逐个从 spec 同目录拷入 skill 目录。
    - 条目是文件即拷文件，是**目录即整树递归拷入**（保持相对路径结构，产物内指针原样可解析）；
    - skill 目录即自包含可分发单元，装完即可跑、不依赖用户现场备数据（作者原则："数据集当然应该现场准备好"）；
    - 资产不存在即 error 拒 pack（防呆：不产出一个装上就跑不了的 skill）。
    - 【决策：依赖驱动】为什么走 `--assets` 参数而非 spec 头部 `Assets:` 声明：后者是 spec 文法（语言面）改动，权威在概念层，而 `docs/concepts/` 是库内只读快照——本库无权加语言特性。`--assets` 落在适配层职权内，零文法改动。若概念层将来引入资产声明，此参数降级为覆盖手段，随之复审。
- **🔴 用户注意力原则（pack 产物的第一设计约束，2026-08-04 作者定）**：hopskill 是**给非程序员用户**用的，非 debug 模式——**注意力是最宝贵的资源，不要浪费**。debug 视角是 /hopspec 技术用户的事，不是 pack 产物的事。落为三条硬要求：
  - ①包装 SKILL.md 指示执行 LLM **不向用户展示内务**（CLI 探测、路径解析、状态目录、JSON 结构等命令行细节一律不进对话，只报"在做什么"级别的一行进度）；
  - ②面向用户的语言**零行话**（不说 spec/引擎/介入点/subagent，说"步骤/任务/需要你确认"）；
  - ③用户看到的只有三类内容——**要收集的输入、必须拍板的暂停点、最终交付物**。
- **前置段版本声明（hopissues/0051,2026-08-31 作者拍定"只提示+给升级命令"——低版本场景的指路责任）** ^anc-cli-pack-version-floor：两载体薄包装 SKILL.md 的前置段第 1 条从静态句改为**带打包时版本的精确句**——"hopjit 引擎已安装且版本 >= X.Y.Z（本 skill 由该版本打包;`hopjit --version` 可验证,低于则先升级:`npm i -g @hoplogic/hopjit@latest`）"。
  - X.Y.Z 取 `readPackageVersion()`（版本单一事实源 ^anc-cli-version-single-source——不写第二份真值,报告卡拍板点②直采）；
  - **为什么闸长在包装层不在引擎**：低版本场景里执行 parse 的正是旧引擎——旧引擎不认识新语法才报语法错误,让它"识别新语法并改报版本过低"等于它已经不旧,逻辑死结;spec 文件自身加版本字段属概念层文法权威,本库快照无权改；
  - 故前置检查的执行位=薄包装的指引文字（caller agent 读到版本要求会跑 `hopjit --version` 比对,低则按指引先升级——**只提示不默认升级**:`npm i -g` 改全局环境是不可逆外向动作,默认做违背"不可逆须授权"一贯口径,且可能破坏用户其它项目的版本依赖;提示文案自带命令,升级代价=一次确认〔2026-08-31 作者拍 A〕）；
  - 正例:pack 产物前置段含当前包版本号与升级命令;反例:版本号写死字面量（第二真值——包升版后 pack 产物仍写旧版即谎报）。

- **薄包装 SKILL.md 的内容契约（壳层原则,2026-08-15 作者定单立——hopbuild 自举实撞三连沉淀,适用一切 pack 产物的壳）** ^anc-cli-pack-shell：
  - **参数引导只列用户真有信息的参数**：agent 自供参数（探测值/环境值）不进参数表——执行 agent 装了 /hopspec 就已按驱动协议持有 CLI 等环境事实,列出来=把内务当参数问用户;
  - **内务零披露**：不罗列知识文档/注入机制/spec 内部结构——引擎 doc-ref 自动注入,agent 无需知道这些文件存在;写出来=诱导预读后在会话里手工执行判据,绕开引擎强制（自举要消灭的旁路）。壳里**连文件名也不点**：2026-08-15 到 2026-10-08 之间 pack 模板一直带一句"本目录还包含判据知识文档（X、Y）,引擎执行时按 spec 内 doc-ref 自动切片注入,无需手动引用",review 面二抓出与本条打架,作者定删——点名文件就是诱导,"无需手动引用"的叮嘱对 LLM 不起作用;
  - **@trace note 只写定位句**：演进史归 git log,不塞流水账（每个读壳的 agent 都要吞一遍 note）;
  - **交付段**（2026-08-15 作者抓'壳的输出还没对上'——三段式漏的第四段）：列 spec `## Outputs` 各交付物+呈现口径（触发 agent 拿到终态后照此向用户交付,与 spec Outputs **严格对齐**——壳的参数段对齐 Inputs,交付段对齐 Outputs,两头都不悬空）;有后续动作指引（如 pack）写在此段。实装时点：本条 2026-08-15 写定后 pack 模板一直没读 `header.outputs`,交付段是空话,2026-09-30 语义审计抓到,2026-10-08 todo/0129 B5 补——模板从 spec 头部 Outputs 逐条渲染"名 % 类型 # 说明",无 Outputs 的 spec 写一句"本 spec 无声明交付物";
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

**branch 没有命令行入口**：branch 由引擎按 case 条件自动求值,没有外部选择入口（2026-10-12 作者定,todo/0168;契约 [[exec-engine#^anc-exec-branch-select-internal]]）——`submit_and_fetch_next` 不接受 `--branch` / `--reason`,传了由 commander 报未知选项。`--replan` 应答 `adaptive_needed`。

所有响应类型（InitResponse、NextResponse、CommandResponse、VarsResponse、StatusResponse、ReplanResponse）定义于本文档「CLI 响应类型」章（原在 shared-types.md，2026-07-02 归位 hop-cli——它们是 CLI 命令的对外 JSON 契约，属 hop-cli 模块）。

---

## 命令契约【契约】

**一命令一 Engine 方法（薄壳分层契约）** ^anc-cli-dispatch
每个 CLI 命令解析参数后**恰好调用一个** Engine 方法并序列化其返回值，命令间不组合多个 Engine 调用、不维护跨命令状态。命令↔方法映射见 CLI 命令表的「路由到」列。CLI 不实现任何业务逻辑（调度/状态机/重试/变量作用域/**节奏与消化**全在 Engine）——这保证 CLI 路径与进程内 API 路径行为一致。

> 这是**设计层的分层选择**（取舍：逻辑归引擎换取两路径行为一致），非宪法级原则。`submit_and_fetch_next` 虽含多种提交参数，仍是"一命令一方法"——按参数选**一个**回写方法 + completeAndAdvance（后者是引擎单一方法）。节奏消化逻辑归引擎（[[exec-engine#^anc-exec-advance-to-caller]]）后，CLI 再无业务逻辑例外。

**实例解析** ^anc-cli-instance-resolve
`--instance` 省略时，CLI 取 `state_dir` 下最新（按目录 mtime 或 run_id 时间戳排序）的实例目录作为目标。显式传 `--instance id` 时直接定位该实例，**且先做目录在场校验**。

- 校验来历：2026-09-01 作者令"按工程链修"——live:core codex:parallel 实撞：driver 手抄实例号丢一字符，缺校验时错号一路走到 persistence 读 spec.json 撞 ENOENT，报 `CORRUPT_STATE_FILE`"状态文件损坏"——两种病一张脸：收报文的 driver/人不会想到是自己把号抄错了，排障方向被误导。LLM driver 手抄 UUID 是常态误差面，报文必须让它能自纠；

- 目录不存在 → 报 `INSTANCE_NOT_FOUND: 实例 <id> 在 <state_dir> 下不存在——若实例号是手抄的请核对有无抄错`（提醒句是报文的一部分——报文的读者常是抄错号的 LLM driver，直接点破最常见成因），**并列出该 state_dir 下真实存在的实例目录名**（按 mtime 新前旧后，最多 5 个——指路：抄错号的一眼能对出正确的号；空目录如实说"目录下无任何实例"；state_dir 本身不可读时如实报"state_dir 本身不可读"——指路失败不掩主错误）；
- **校验覆盖 CLI 全部实例定位通路**（2026-09-01 review 面二抓：初版只在 --instance 参数通路，`run --call-parent` 的父实例定位直调 load 绕过校验，错号父实例仍报旧病——收纯是全称承诺，凡 CLI 收外部实例号的入口同经 resolveInstance）。`CORRUPT_STATE_FILE` 语义随之收纯：目录在而状态文件缺/坏（崩溃半写、真损坏）才是它；
- **半初始化子实例目录再收窄一档**（0059 实撞:父已写 params.json 但 child 未 init,目录在场而 spec/state/vars 三件全缺——按上句口径报 CORRUPT_STATE_FILE"spec.json 不可读",报文教人往"文件损坏"方向排障,而病是"子实例从未完成初始化"）:实例定位命中目录后、交 Engine.load 前,**探测 state.json 在场性**。
  - 缺席且目录内无 spec.json → 报 `INSTANCE_NOT_INITIALIZED: 子实例 <id> 目录在场但未完成初始化（无 state.json/spec.json——常见成因:child 启动失败留下的半截目录）。删除该目录后重新派发即可`;state.json 在场而内容坏才是 CORRUPT_STATE_FILE 的地盘；
- 三档语义排开:目录不在=INSTANCE_NOT_FOUND / 目录在而未初始化=INSTANCE_NOT_INITIALIZED / 初始化过而文件坏=CORRUPT_STATE_FILE——每档报文指路各自的处置；
- 校验只在显式 `--instance` 分支——省略分支取的就是真实存在的目录，天然无此病。CLI 自身不读写实例内状态文件，仅把解析出的实例标识/目录传给 Engine。

**状态加载契约** ^anc-cli-state-load
除 init（新建实例）外，每个命令先用 `ExecutionEngine.load(dir)` 或 `recover(dir)` 从快照重建引擎实例，再调一个业务方法。**加载是前置构造，不计入「一命令一 Engine 方法」**——它产出引擎实例而非业务结果。两个加载入口的语义差异是关键契约（概念见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-durable-resume]]）：
- **load**——保留 running。日常命令（submit_and_fetch_next/debug_step/status/vars）用。复用模式下 running 是"已交付 caller、正等回写"的合法持久态，重置会打断 run→submit 跨进程流
- **recover**——重置悬空 running 为 pending（branch 已选 case 特例除外）。仅 `hopjit resume` 用。崩溃时的 running 无回写记录，是悬空的
- **为何由命令显式选**：引擎无法仅凭 running 状态区分"已交付待回写"与"崩溃悬空"，故加载语义由调用入口（命令）决定

**顶层起跑依赖核** ^anc-cli-run-deps-gate

`hopjit run <spec>` 与 `hopjit init <spec>` 起**顶层**实例时,在调 `engine.initExecution` 之前先核入口 spec 的依赖（2026-10-07,todo/0142 子卡 B;判定逻辑在 [[hopant#^anc-hopant-run-deps]] 的 `checkRunDeps`,判据权威 [[exec-engine#^anc-exec-tools-reconcile]] ③）：

- **核什么**:Tools 段工具——标准工具（`STANDARD_TOOL_NAMES`）放过,其余必须在两级配置的 `tool_servers` 里注册且通过 reconcileTools 四判;静态 call 目标——必须是同目录 spec、已装 HopAnt 或已注册工具;沿 call 树递归核到底。
- **不核谁**:`run --call-parent`（call 子实例 worker）、`run --worker`（并行 worker）、`init --parent --step`（call 子实例）——父实例起跑时已把整棵树核过,子实例重复核只是多读一遍配置。
- **注册面怎么取**:与 `ant adapt` 同一取法——cli.ts 的 `reuseConfigPaths(workspaceDir)` 算两级路径（系统级按家目录、项目级按工作区根而非进程 cwd,^anc-cli-workspace-arg;`HOPJIT_CONFIG` 在场即单文件;hop-admin.ts 的 `ant adapt` 走同源的 `adaptConfigPaths(ctx)`,两者都只是 config-load.configPaths 的薄包装）,`loadTwoLevelRegistry` 读;配置都缺席按空注册面,此时 Tools 段里任何非标准工具都会报缺,这正是要告诉用户的事。配置文件格式坏（TOOLS_FILE_INVALID）照原样报错,不吞。
- **不过时**:输出 `{status:'error', error_code:'INIT_FAILED', message, errors, missing_tools, missing_calls, hints}`（message 以 `INIT_FAILED 依赖核:` 开头,逐条列缺口;`errors` 是一条 `{kind:'validate', rule:'INIT_FAILED', severity:'error', message}`,与引擎 init 失败响应同形,读 `errors[]` 的 driver 不用改）,不建实例目录、不进首步;退出码 0,与引擎 init 失败同走业务错误通道（stdout JSON）。
- **为什么放在 CLI 不放进引擎 init**:注册面要读两级配置文件、call 寻址要查家目录——都是组合根才能碰的进程环境（run 隔离守卫）;引擎 init 期的 ① 号调用点只对 hostConfig.tool_provider 对账,复用模式不注入它。这一步与实例解析、状态加载同性质,是调业务方法前的前置检查,不计入「一命令一 Engine 方法」。
- 同处还做一件组合根注册:进程启动时 `ExecutionEngine.setCalleeSpecResolver((caller, id, workspaceDir) => resolveCalleeSpecPath(dirname(caller), antRoots(homedir(), workspaceDir), id))`——HopAnt 根是两级 `antRoots(home, workspaceDir)`（项目级 `<工作区>/hop_tasks/ants` 先、用户级 `~/.hopjit/ants` 后,[[hopant#^anc-hopant-home]] 决策 9;项目级取本实例工作区,不做 process.cwd 兜底）,与工具工厂注册相邻（[[exec-engine#^anc-exec-callee-resolver]]）;依赖核本身传给 `checkRunDeps` 的 roots 也是同一组两级根。

**工作区根显式指定** ^anc-cli-workspace-arg

复用模式的工作区根此前只有一条来路——CLI 进程的 `process.cwd()`。这个 cwd 是 Claude Code 会话启动目录被 Bash 工具继承下来的：用户看不见它,Bash 工具在会话里 `cd` 过别处之后它还会变。独立模式 `start_run` 早有显式的 `workspace_dir` 参数（[[mcp-server#^anc-mcp-config]]）,复用模式缺对称的一半。2026-10-07 作者问"复用模式下的 cwd 是哪儿来的？在 CC 下，其实用户没有一个显性的 cwd 感知"后补齐：

```
HopType: CliWorkspaceArg
  Id: cli-workspace-arg
  Specs:
    - resolveWorkspaceArg(
        arg % line?,            # --workspace 的原值;缺席=未传
        cwd % line              # 进程当前目录绝对路径
      ) → workspace_dir % line  # 工作区根绝对路径;写入 HostConfig.workspace_dir 与 sandbox.filesystem.workspace_dir 两处同值
      # 不存在的显式路径直接拒,不搜索不回退——与 start_run 同一态度
```

```
resolveWorkspaceArg(arg, cwd):
1. [条件(arg 缺席)] 返回 cwd（既有行为,零改动——不传的调用方行为完全不变）
2. [其他] p = isAbsolute(arg) ? normalize(arg) : resolve(cwd, arg)
   2.1. [条件(p 不存在或不是目录)] errorExit `WORKSPACE_NOT_FOUND: workspace 不存在（<p>）——只接受显式路径,不做搜索`（报文形态照 mcp-server 的同名错误）
   2.2. [其他] 返回 p
```

- **谁消费返回值**：`buildHostConfig(workspaceDir)`——`workspace_dir` 与 `sandbox.filesystem.workspace_dir` 同值绝对路径（58a3c061 约束不变）;项目级配置 `hopjit.yaml` 的 `commands` / `language` 两个读取点按它定位,不再裸读 `process.cwd()`——工作区指到哪,项目级配置就从哪读。
- **子实例恒继承**：引擎拼 parallel worker 的 `launch_command` 与 call 的 `call_protocol.init_command` 时恒带 `--workspace "<父 workspace_dir>"`（[[exec-engine#^anc-exec-parallel-reuse-protocol]] / [[exec-engine#^anc-exec-call-protocol-payload]]）。子进程的 cwd 由 driver 执行命令时的 Bash 决定,不带这个参数父子工作区就会分叉。
- **响应回显**：六个带 `work_zone` 的响应形态（StepReady / ToolRequest / ExecutionCompleted / ExecutionFailed / ExecutionPaused / DispatchReady 的派发项）并列携带 `workspace_dir`（值=HostConfig.workspace_dir;HostConfig 无 workspace_dir 时字段缺席,不抛）——与 work_zone 同族同位,一次加齐。引擎侧收口两处：NextResponse 出口 `nextStep` / `advanceToCaller`;escalate 与展开续批两个 paused 构造器（它们经 `completeStep` → `completeAndAdvance` 非 ok 直返,不过前两处——首发与 `nextStep` 重放同一张卡必须字段一致）。driver 起跑后把它转告用户一句（"这个活在 <目录> 上跑"）,隐式的工作区在对话里可见;hoplog 头块同记（[[spec-observability#^anc-obs-file-layout]]）。
- **只给 run / init**：`submit_and_fetch_next` 等后续命令从 state.json 恢复 HostConfig,工作区已定,不收此参数。

**通知挂点·复用模式（2026-08-31 作者定"给/hop 加一个钉钉通知功能"——0052'复用模式不挂待真需求'预留的真需求到场）** ^anc-cli-notify-reuse

standalone 挂点契约（[[mcp-server#^anc-mcp-notify-hook]]——三与门/事件面/卡片规格/失败旁路）在复用模式的对称落地。与 standalone 的三点差异是本节的全部内容,其余同款不复述：

**能力契约（HopTrait）**：

```
trait: CliNotifyReuse
  Id: cli-notify-reuse
  Constraints:
  - 开关跨进程:run 命令 --notify <渠道> flag → **StateFile.notify_channel** 持久（字段实况落 state.json 的 StateFile 的 `notify_channel` 字段,src/runtime-types.ts——EngineSnapshot 经其 state 成员携带该字段落盘,持久化语义等价;terminal_state 先例同款:置值入 state,load 恢复——复用模式每条命令新进程,内存标志无效;存渠道名不存布尔——命名忠实:字段装的是"用哪个渠道",不是"要不要"）
  - 挂点=CLI 公共出口:outputWithNotify(result, engine)——五个可达终态/停点的命令（run/submit_and_fetch_next/reap_and_fetch_next/advance/resume）拿到 NextResponse 后、output() 前统一过此函数（一处实现五处调用,不逐命令散挂）
  - 二与门（2026-08-31 作者定"每次 hop 时说,否则太烦"——渠道随话语走,零配置文件）:①state.notify_channel 在场（run --notify dingtalk 置入,渠道值来自用户话语——"跑完钉钉通知我"点名了渠道,driver 只翻译不判断;flag 值非法渠道启动即拒响亮报可用渠道枚举）②凭证 sendDingtalk 自查。缺门①静默跳过,走到发送而失败记 stderr 一行。**与 standalone 三与门的分道**:standalone（MCP server 长活进程,^anc-mcp-notify-hook）保留 config notify 节声明通道——server 场景配置一次多 run 共享合理;复用模式每 run 都是用户现场一句话,再要配置文件=说了通知还得先配文件手机才响,正是"太烦"本体。原设计的门②（hopjit.yaml notify 节+readProjectNotify）随本条退役不实装
  - paused 同发（与 standalone 对称——复用模式长活同样有"用户走开"场景:driver 停在 confirm 等人时用户可能已离开对话;且门①已是"用户要了才发",要了通知的用户想被叫回来）
  - 卡片渲染共享:composeRunCard（tools-notify.ts,与 sendDingtalk 并列——一份渲染两处挂点〔mcp-server.maybeNotify 与本挂点〕同调,消两处组装漂移面;渲染函数住通知模块=代码归置,调用责任仍在挂点侧,sendDingtalk 仍只收文本,与"工具只收文本"口径不冲突）
  - 通知失败恒不拖垮:发送 await 但带 5s 超时兜底（**短命进程条款——与 standalone 的 fire-and-forget 分道**:CLI 每命令一进程,fire-and-forget 会被进程退出掐死〔实测:发送尝试竞态丢失〕;"不拖垮"在短命进程形态=不无限等,不是不等——发送最多拖住进程 5s,超时/失败记 stderr 一行放行）,output() 恒执行
```

**类型约定（HopType）**：

```
HopType: EngineSnapshotNotifyExt    # StateFile 新字段（代码实况落 src/runtime-types.ts StateFile.notify_channel:105——快照经 EngineSnapshot.state 携带同一字段持久化,等价;terminal_state 同款可选形态。struct 名保留历史命名,字段归属以本注为准）
  Id: engine-snapshot-notify-ext
  Fields:
    - notify_channel % line     # 可选,缺省缺席=不通知——run --notify <渠道> 置渠道名持久（现枚举只 dingtalk）,load 恢复;子实例不继承（通知归顶层 run,worker 不发）

HopType: RunCardInput               # composeRunCard 入参（两挂点共用的数据面）
  Id: run-card-input
  Fields:
    - spec_title % line       # 卡片名（人读的"这活叫什么"——恒取 spec 标题,不用文件名）
    - state % line            # completed | failed | paused（徽记三态映射 ✅/❌/⏸️）
    - completed_steps % int   # 进度分子
    - total_steps % int       # 进度分母
    - current_step % line     # 可选,当前步/失败步
    - paused_question % text  # 可选,停点问题摘要（paused 卡片正文）
    - run_id_tail % line      # 实例 id 尾段（多 run 并存对号）
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

测试正反例：--notify dingtalk 记入 state 且跨进程可见（run 后另起命令读快照）;终态发送 fetch 桩收 ✅ 卡片含 spec 标题;未 --notify 零发送;--notify 带非法渠道启动即拒;发送异常 output 照常返回;paused 停点发 ⏸️ 卡片。composeRunCard 三态渲染单测归 tools.test.ts。

driver 接线口径：用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ /hop 建卡后 run 命令带 --notify dingtalk（发不发判断恒归引擎门,driver 只翻译意图不自作主张——没点名渠道就不带 flag）;MCP 载体=start_run params 带 hop_notify:true（standalone 侧契约不随本条变,分道理由见 Trait 二与门条款）。

**~~通知推送 notify~~（已退役,2026-08-30 当日立当日撤——作者定"tools 不再直接通过 hopjit cli 外露"）** ^anc-cli-notify

同日三连纠后收口：①"不是做一个 hopjit cli 给人用,是给 hopspec 和 hop 用的"→②"没说钉钉通知为啥会通知"→③"hopjit 阉割=tools 不再直接通过 hopjit cli 外露"。CLI 不承载工具能力外露——工具能力恒经工具面（ToolProvider 装配）,通知的正式形态=注册工具模块+引擎终态/停点配置驱动挂点（归 todo/0052 后续批次:设计归口 docs/design/tools/ 子目录）。notify 命令与 NotifyResponse 当日实装当日移除,实现史归 git log。

**本条与 tool-call 命令的分界（2026-08-31 作者定"hopjit cli 应该是工具的标准出口了,因为要被复用模式调用"——两条裁决不冲突,消费方不同）**：
- 本条封的是**给人的命令面**——把工具做成 `hopjit notify` 这类面向终端用户的独立命令,导向"普通人直接用 hopjit"的错误定位；
- `hopjit tool-call`（通道⑥,[[tool-channels#^anc-exec-tool-channels]]）是**给复用模式 driver 的机器通道**——caller agent 在 act free 执行期按 L4 清单调引擎内建工具,引擎实现是唯一语义源,driver 不用 Bash 模仿；
- 判据一句话:命令的预期使用者是人=违反本条;是 driver 按清单指引的机器调用=通道⑥职权。tool-call 因此是复用模式的工具标准出口,不是本条的翻案。

**`hopjit schema-sep <spec>` 契约（HopSchema 分隔符迁移工具）** ^anc-cli-schema-sep

来由：作者 2026-09-22 定"`%` 是正式 HopSchema 语法，`:` 将成为 deprecated"。parser 已双文法并收、用 `:` 的 spec 会收到 W2 告警（[[spec-parser#^anc-rule-schema-sep-dual]]）；本命令是 todo/0109 第 2 步，给作者一个一键把整份 spec 迁到 `%` 的工具。形态仿 `hopjit lang`（[[i18n#^anc-i18n-language-config]] 转换工具条款）：先备份，再行级手术原地改写，转换引病就拒绝写回。

**命名**：`schema-sep`——与 `lang` 同为"短名词直指改写对象"的风格：schema 指 HopSchema，sep 指 separator（分隔符），合起来就是"HopSchema 分隔符"，不看文档也能猜到改的是什么。不带 `--to` 参数：迁移方向是单向的（`:` 到 `%`），`%` 转回 `:` 没有合法用途（`:` 正在走向废弃），做成双向只会多一个没人该用的开关。

**与薄壳分层契约的关系**：本命令同 validate / list / lang 一样是纯文本工具命令，不创建实例、不调任何 Engine 方法，只调 parser 与 validator 的出口函数——"一命令一 Engine 方法"（^anc-cli-dispatch）约束的是实例命令，本命令不在其列。

**能力契约（HopTrait）**：

```
trait: CliSchemaSeparatorMigrate
  Id: cli-schema-separator-migrate
  Inputs:
  - spec % line          # spec 文件路径（相对 cwd 或绝对）
  Constraints:
  - 改写面只有 HopSchema 名/类型分隔符：由 convertSchemaSeparators 执行（识别面=parser 的 colon_separators 记录，
    见 [[spec-parser#^anc-rule-schema-sep-convert]]），变量名、类型原文、# 说明、> 指令文字、hop_python body、
    围栏内内容、Config 段、call 映射、段头标签一律逐字节不动
  - 写回前在内存里做三道核对，任一不过就拒绝写回、以非 0 退出：原件一个字节不动、不产生备份文件：
    ① 转换后 parse 错误数加 validate error 数，与转换前相比不许增加（转换前已有的错误不算转换的锅——同 lang 的基线对照律）；
    ② 语义不变，分两半核：
       ②a 转换前后两份 AST 剥掉 source_location、colon_separators、narrative_sections 后必须逐字段相等
           （narrative_sections 是内容章节的原文字节收集——声明区写在非关键字 ## 节下时〔如 hop-fact-check 的
           ## 任务〕，节原文里就含声明行，随分隔符改动而变是预期内的，所以不参与 AST 比对，由 ②b 在字节层兜住）；
       ②b 逐行比对原件与转换产物：有差异的行必须恰好是转换前 parse 记录的冒号分隔符行（行数也不许变）——
           不信转换函数自报的改动清单，用 parser 记录独立核对；
    ③ 转换函数报告的 unmatched_lines 必须为空，且转换后 re-parse 的 colon_separators 必须为空（有该改没改成的行=转换不完整）
    拒绝报文说清是哪道核对没过、前后各是多少、涉及哪些行号，并提示"原件未动、无备份产生，请把这份 spec 附到 hopissues 报告"
  - 零改动（文件里已经没有用 : 的分隔符）→ 返回 changed_lines=0、backup=null，不写文件不产生备份
  - 有改动 → 先写备份 <原文件名>.bak.<时间戳>（同目录；时间戳=UTC 年月日时分秒 14 位；同名已存在加 .2/.3 序号，不覆盖旧备份），
    再原地写回转换产物
  - 输出走 JSON 单行（^anc-cli-json-io）；拒绝走 errorExit（stderr + 退出码 1）
```

**类型约定（HopType）**：

```
HopType: SchemaSepResponse          # hopjit schema-sep 成功时的 stdout JSON
  Id: schema-sep-response
  Fields:
    - status % line            # 恒为 ok（拒绝走 errorExit，不产生本结构）
    - changed_lines % int      # 改写了几行（零改动时为 0）
    - backup % line            # 备份文件的绝对路径；零改动时为 null
    - note % line              # 可选，仅零改动时出现，说明"没有用冒号的分隔符，零改动零备份"
```

**关键逻辑（HopSop）**：

```
schema-sep(spec):
1. [act] original = 读文件全文；before = parseSpec(original)
2. [act] beforeErrs = before 的 parse 错误数（非零时）或 validateSpec(before.ast) 的 error 数
3. [act] {text: converted, changed_lines, unmatched_lines} = convertSchemaSeparators(original)
4. [act] after = parseSpec(converted)；afterErrs 同第 2 步口径
5. [条件(afterErrs > beforeErrs)] errorExit（核对①：报前后错误数）
6. [条件(两份 AST 剥 source_location、colon_separators、narrative_sections 后不等
        或 行数变了 或 有差异的行集合 ≠ before 记录的冒号分隔符行集合)] errorExit（核对②）
7. [条件(unmatched_lines 非空 或 after.ast.header.colon_separators 非空)] errorExit（核对③：报行号）
8. [条件(converted === original)] 输出 {status: ok, changed_lines: 0, backup: null, note}，结束
9. [act] 写备份（时间戳命名，撞名加序号）→ 写回 converted → 输出 {status: ok, changed_lines, backup}
```

测试正反例（tests/cli.test.ts，@v: anc-cli-schema-sep）：
- 正例：拿 examples/hop-fact-check.md（含 Types、Tools、hop_python body、围栏 YAML 示例，裸键段头形态）拷到 os.tmpdir() 并在步骤段前补一段 Config，跑命令——所有用冒号的分隔符行都换成 ` % `，其余每一行逐字节不变，备份文件在场且内容等于原件，转换后 validate 零 error 且零 W2；再跑一次零改动零备份；
- 反例：正确的转换函数造不出"转换引病"的输入，测试用 vi.mock 对 parser 模块做透传包装——convertSchemaSeparators 平时调真实现，拒绝用例里单次换成会改坏文件的桩（ESM 的具名导入是只读绑定，vi.spyOn 换不掉 cli.ts 已绑定的那个函数，所以走 vi.mock）；
- 每道核对各一个反例：①桩删掉标题与 Id 行使错误数上升；②a 桩改了 Outputs 的说明；②b 桩在真转换之外改了一行 HTML 注释（AST 不变，只有字节层能抓）；③桩什么都不改却报成功。命令都拒绝写回、退出码 1、报文点名是哪道核对、原件不动、零备份。

**实现**：TypeScript（代码侧），文件 `src/cli.ts`（commander.js）。

---

## CLI 响应类型【契约】 ^anc-cli-response-types

> 各 CLI 命令序列化到 stdout 的 JSON 响应结构。2026-07-02 从 shared-types.md 归位——它们是 hop-cli 模块的对外 JSON 契约（driver 依赖），属 CLI 命令表「响应类型」列的类型定义。
> - `SpecError`/`ErrorCode` 见 [[shared-errors]]，`OutputDecl`/`StepSummary`/`RetryRecord`/`ExecEvent` 见 [[shared-types#^anc-type-auxiliary]]，`$file`/`preview` 卸载见 [[shared-types#^anc-exec-deflate]]。

### InitResponse（hopjit init） ^anc-cli-init-response

```
HopType: InitSuccess
  Id: init-success
  Fields:
    - status % line           # 恒为 'ok'
    - instance_id % line      # 新建实例 ID
    - warnings % [SpecError]  # 可选。warn 级校验结果（不阻断 init，但透传供作者修复）

HopType: InitError
  Id: init-error
  Fields:
    - status % line         # 恒为 'error'
    - errors % [SpecError]  # ParseError 或 ValidationError（仅 error 级）
```

（TS 形态是代码层投影，在 src/cli-types.ts——设计以本 HopType 为准。）

init 跑完整校验：**error 级阻断**（不创建实例、不写状态目录），**warn 级不阻断但透传**到 `InitSuccess.warnings`——警告被吞掉等于不存在（见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-validation]]）。

### ValidateResponse（hopjit validate） ^anc-cli-validate-response

**片段模式 `validate <file> --fragment [--known-vars a,b,c]`**（hopbuild 单轮核查用——逐节点展开的 spec 片段无完整头部）。响应结构与整文模式同形。
- **parser 原生吃裸片段**（parseFragment:输入=裸步骤序列,无 `# 标题`/`## Steps` 节头也直接解析——不是内部拼假头骗过整文验证器;原生解析的实利:报错行号=片段文件真实行,拼头会整体偏移）；
- validator 只验**片段自身的合法性**,豁免整文完备性类规则（S8 goal 必备/S10 头部结构/exit 交付完整性/P10 输出无产出 warn——片段天然不完整,报了全是噪声）；
- `--known-vars` 逗号分隔的上层已知变量名,注入 V1 可追溯来源（片段引用上层变量不误报凭空引用;类型未知按通配匹配——类型核对归整文 validate）；
- 片段仍全量执行的面:步骤文法/容器结构（C 族）/片段内变量流（V 族,含 known-vars 扩展来源）/特殊步骤规则（P 族除 P10）；
- **片段编号从 1 起**（相对编号——片段是自足局部,`3.2.1.` 类绝对路径起头会因祖先不在场被树装配拒;调用方并入全文时自行改写编号）。


```
HopType: ValidateResponse
  Id: validate-response
  Fields:
    - status % line           # 'ok' 或 'error'——error = 存在 error 级违规（spec 不可执行）；ok = 无 error（可能有 warn）
    - errors % [SpecError]    # error 级违规（空 = 结构合法）
    - warnings % [SpecError]  # warn 级违规（建议修复）
```

`validate` 与 init 共用同一套校验规则（规则集权威与条数归 [[spec-parser]]——本处不复记具体数字,历史上此处写死"35 条"后随批加规则失配），区别在于：validate 只读（不创建实例、不写状态）、且 error 与 warn **全集返回**（不阻断——它本就是给作者看的检查报告）。纯结构校验，不需要 params。

### ListResponse（hopjit list） ^anc-cli-list-response

```
HopType: ListResponse
  Id: list-response
  Fields:
    - status % line   # 恒为 'ok'
    - dir % line      # 被扫描的目录
    - specs % [yaml]  # 每项 { file: 文件名（非全路径）、id: ast.header.id（缺省用 title）、goal: Goal 首句 }；按文件名稳定排序，排序偏好（recent 优先）由 skill 决定。可执行判定规则见 [[hop-cli#^anc-cli-list]]
```

`list` 对目录内每个 `.md` 做 `parseSpec` 后判定可执行 spec（goal 非空 + steps 非空 + 排除设计文档），解析失败的跳过。无状态纯函数（同 dir → 同输出），便于测试与跨 runtime 复用。recent-dirs LRU 与首次目录交互留 skill，引擎不假设 `.hopspec/` 布局。

### InstallSkillResponse（hopjit setup） ^anc-cli-install-skill-response

```
HopType: InstallSkillResponse
  Id: install-skill-response
  Fields:
    - status % line                    # 'ok' 或 'error'
    - carrier % line                   # 本次安装的第一个载体（兼容字段;自动探测时=探到的第一个,^anc-cli-carrier-autodetect）
    - carriers % [line]                # 本次实际安装的全部载体（显式 --carrier 时单元素）
    - results % [InstallSkillResult]   # 每载体一份结果,字段=下列 target 起的各字段;顶层同名字段取 results[0] 的值（兼容只读顶层的旧消费方）
    - detect_note % line               # 可选。自动探测说明（零探到回落 cc / 去重）
    - demo_ants % [line]               # 恒带。本次新装的演示 HopAnt id（全部已存在时空表;顶层字段,与载体无关,^anc-cli-install-skill-demo-ants）
    - demo_note % line                 # 可选。演示 HopAnt 跳过（已装）与失败说明（顶层字段）
    - next_step % line                 # 恒带。一句指令 + 包内 docs/AGENT-GUIDE.md 绝对路径——装完的 agent 下一步读什么（todo/0139 挂钩①,2026-10-03）
    - driver_version % line            # 包 package.json version（装的是哪个版本）
    - driver_source % line             # 包根绝对路径（从哪个源装的）
    - target % line                    # 展开目标 skills 目录
    - installed % [line]               # 本次写入的文件/目录路径清单（含 plus 附装项与"旧名残留已清理"记录）
    - removed % [line]                 # 可选。受管目录清理实删项（--force 档才出现）
    - plus_note % line                 # 可选。--plus 附装说明（含剩余人工动作提示）
    - plus_tools_merged % [line]       # 可选。--plus 合并进 config.yaml 的 tool server 名列表
    - legacy_note % line               # 可选。Codex 旧项目级残留检测提示
    - stale_notes % [line]             # 可选。陈旧副本新鲜度提示（^anc-cli-stale-skill-scan——旧位置本器产物版本落后/缺指纹,携升级路径,零发现缺席）
    - mcp_registered % line            # 恒带(可为 null)。写入的注册配置路径,跳过/失败时 null（2026-10-01 起缺省注册,不再依 --mcp）
    - mcp_note % line                  # 可选。注册跳过原因（已有条目/scope 冲突指路）或注册环境性失败的降级说明（2026-10-01）;opencode 载体注册成功时也带——说明已 enabled:true 并在 tools 节关闭了哪五个独立模式专属工具、走 standalone 时怎么改回（^anc-cli-opencode-tools-gate）
    - permission_written % line        # 恒带(可为 null)。CC 载体写入放行的 settings.local.json 路径;跳过/非 CC 时 null（^anc-cli-install-skill-permission）
    - mcp_handshake % yaml             # 可选。注册后握手自检结果 { ok, tools?, standalone_available?, reason?, fix? }——握手跳过时缺席（^anc-cli-install-skill-handshake）
    - permission_note % line           # 可选。放行跳过原因或其他载体的手动指路;opencode 一支不再说"把 enabled 改 true"（v0.47.0 起 server 已启用）,改为指路按 <server>_<tool> 粒度放行并说明独立模式专属工具已关
    - mcp_config_bootstrapped % line   # 恒带(可为 null)。配置自举写入路径,未自举 null;未自举且系统级配置缺席时 mcp_config_note 点明 run_approved_command 不可达
    - mcp_config_note % line           # 可选。自举明示——学了什么模型/端点/凭证名,或未学习原因
    - note % line                      # 可选。零写入提示（目标已存在,用 --force 覆盖）
```

（代码实况：本响应无独立 TS 类型——形状在 `cli.ts` setup 命令的 output 字面量（src/cli.ts setup 命令末尾 output({...}) 字面量（行号随代码漂移,以 grep `driver_source` 定位）），可选字段按条件展开。失败形态 `{ status:'error', message }` 经 errorExit 走 stderr。）

### AntResponse（hopjit ant） ^anc-cli-ant-response

```
HopSchema: AntResponse
  # hopjit ant 七个子命令共用的 stdout JSON。错误一律经 errorExit 走 stderr（退出码 1）,stdout 不出 JSON——所以 status 恒 'ok',不设 'error' 臂
  - status % line            # 恒 'ok'
  - action % line            # install | adapt | list | remove | bootstrap | pack | share
  - id % line                # 可选。adapt / remove / bootstrap / pack 带：操作或封出的 HopAnt id
  # ---- install ----
  - dry_run % bool           # 可选。install --dry-run 时 true;bootstrap --dry-run 时也带
  - plan % InstallPlan       # install 恒带（dry-run 与真装都带——真装时它与 result 并存,不是二选一）;形状见 [[hopant#^anc-hopant-install]]
  - result % InstallResult   # install 真装时带
  - next_step % line         # 可选。install 的 result.bootstrap_pending 非空时带 `hopjit ant bootstrap <id> --dry-run`;pack 恒带（下一步 `hopjit ant install <产物目录>`;reconciled.tools_added 非空时还带"补入的占位签名装机前要改"）;share 两分支恒带
  # ---- adapt ----
  - report % AdaptReport     # adapt 恒带;形状见 [[hopant#^anc-hopant-adapt]]
  - stamp_written % line     # adapt 恒带,可为 null：report.ok 时是写入的 adapt.yaml 路径,否则 null
  # ---- list ----
  - ants % [yaml]            # list 恒带：每项 {id % line, scope % line（project | user）, title % line（入口 spec 解析失败写占位）, adapt_state % line（never | stale | adapted）};项目级在前,同 id 两条都在（2026-10-10 两级根）
  # ---- remove ----
  - removed % bool           # remove 恒带：假=本来就没装
  - scope % line             # install / adapt / bootstrap 恒带,remove 在 removed 为真时带（没删就没有级）：操作落在哪一级（project | user）——install 是 --scope 的值,其余是两级查找命中的那一级
  - kept_store % bool        # remove 恒带：真=--keep-store 且确有 inner_store 被挪到备份位
  # ---- bootstrap ----
  - has_bootstrap % bool     # bootstrap 恒带：假=该 HopAnt 没有 bootstrap.js（不报错,后续字段缺席）
  - returncode % int         # bootstrap 有脚本时带：脚本退出码
  - stdout % text            # bootstrap 有脚本时带
  - stderr % text            # bootstrap 有脚本时带
  # ---- pack ----
  - pack % PackAntResult     # pack 恒带;形状见 [[hopant#^anc-hopant-pack]]（id / dir / reconciled 增删 / docs_copied / assets_copied）
  # ---- share ----
  - owner_prompt_required % bool   # share 四态里的"首机且无旗"：--owner 缺、config.yaml 无 owner_id、也没 --yes → true,此时只有本字段与 owner_default,不写包（config 已有 owner_id 时不会出现——答过不再问）
  - owner_default % line     # 同上,缺省归属标识（供 driver 在对话里问用户要不要改）
  - share % ShareAntsResult  # share 写了包时带;形状见 [[hopant#^anc-hopant-share]]
  - owner_written % line     # share 写了包时带：写回 owner_id 的 config.yaml 路径
  - credential_scan % CredentialScan  # share 写了包时带（share.credential_scan 的同一对象提到顶层,driver 恒读得到）：files_scanned / rejected（写了包则恒空）/ warnings / method / disclaimer——driver 把 warnings 与 disclaimer 念给用户
```

**退出码条款**（消费方按它判绿红,按 JSON 读细节）：`adapt` 报告有缺口 → 1;`bootstrap` 脚本非零 → 1;`share` 的 `owner_prompt_required` → 0（不是错,是等人答）;其余子命令成功 → 0;任何错误码（[[hopant#^anc-hopant-errors]]）→ errorExit 走 stderr,1。与 InstallSkillResponse / PackResponse 同律：只在设计层立 HopType,代码层不另建 TS 类型（cli.ts 的 `output({...})` 字面量即实现,测试断字段）。

### PackResponse（hopjit pack）

```
HopType: PackResponse
  Id: pack-response
  Fields:
    - status % line          # 'ok' 或 'error'
    - carrier % line         # 打包目标载体
    - skill_name % line      # 最终 skill 名（--name 覆盖或 spec Id）
    - target % line          # 产物落点目录
    - installed % [line]     # 本次写入的文件路径清单
    - knowledge_docs % [line] # 随包收集的知识文档清单（doc-ref 闭合面）
    - assets % [line]        # 随包资产文件清单（--assets）
    - note % line            # 可选。零写入提示（目标已存在,用 --force 覆盖）

HopType: PackError
  Id: pack-error
  Fields:
    - status % line          # 恒为 'error'
    - message % line         # 错因（spec 不存在/解析失败/校验失败/资产缺失）
    - errors % [line]        # 可选。parse/validate 逐条错误
```

（代码实况：TS 形态是 `cli.ts` 内部 `PackResult` 联合类型（src/cli.ts `packSpec()` 上方的类型声明）——pack 命令与 setup --plus 共用 `packSpec()` 返回同型。）

### NextResponse（hopjit next） ^anc-cli-next-response

NextResponse 是联合类型（其中带 `work_zone` 的六形态——StepReady / ToolRequest / ExecutionCompleted / ExecutionFailed / ExecutionPaused / DispatchReady 派发项——并列带 `workspace_dir`,^anc-cli-workspace-arg），8 形态由 `status` 字段区分：StepReady / AdaptiveNeeded / ExecutionCompleted / ExecutionFailed / ExecutionPaused / ToolRequest / DrainWait / DispatchReady（后三者形状权威见 [[exec-engine#^anc-exec-tool-request]] 与 [[parallel-execution#^anc-exec-parallel-reap-drain]]）。

```
HopType: StepReady
  Id: step-ready
  Fields:
    - status % line                # 恒为 'step_ready'
    - instance_id % line           # 所属实例 ID
    - step_id % line               # 步骤 ID，如 "2.1.3"
    - step_type % line             # 枚举 reason/act/check/confirm/ask/commit/call（ExecutableStepType）
    - summary % line               # 摘要行描述
    - context % AssembledContext   # 装配好的执行上下文
    - work_zone % line             # 实例 work_zone 工作区绝对路径（driver 写临时文件用，见 [[exec-engine#^anc-exec-work-zone]]）
    - workspace_dir % line         # 可选。本 run 工作区根绝对路径（与 state.json host_context.workspace_dir 同值;driver 起跑后向用户转告一句,^anc-cli-workspace-arg）——HostConfig.workspace_dir 缺席（直接构造引擎的内存态场景）时不在场
    - output_path % line           # 本步输出文件确切路径（<work_zone>/out_<step_id>.json，^anc-exec-work-zone 权威）
    - call_protocol % CallProtocol # 可选。仅 step_type=call 且复用模式 CLI 通道（engine 持 cliAbsPath+specPath）——命令拼装权归引擎,driver 照抄零手拼（语义权威 [[exec-engine#^anc-exec-call-protocol-payload]]）

HopType: CallProtocol
  Id: call-protocol
  Fields:
    - init_command % line          # 完整 init 命令,callee 路径由引擎填绝对路径（同目录 → ~/.hopjit/ants/<id>/<id>.md,[[exec-engine#^anc-exec-callee-resolver]]）,解析不到才留 <CALLEE_SPEC_PATH:id> 占位交 driver 自找（DispatchReady.launch_command 同一规则）;params=引擎 auto-map 快照+hop_env 透传;trace/log-dir/级别继承已折入;父层有修正意见时另拼 --upstream-feedback（重跑轮才有,D41 复用半边）;参数表与反馈文本都以 "@<文件绝对路径>" 形态出现,值由引擎预先写进父实例目录 cmd_args/ 下的文件,命令行上不含数据值（[[exec-engine#^anc-exec-cmd-args-file]],hopissues/0097）
    - child_state_dir % line       # 子实例驱动循环的 --state-dir 值（<顶层STATE>/<inst>/calls）
    - child_instance % line        # 子实例 ID（确定性:不在 loop 里=call 步骤号,在 loop 里=<步骤号>.<各祖先 loop 当前轮次,外层到内层>——[[exec-engine#^anc-exec-call-child-iter-id]];init_command 以 --child-instance 带同一值）
    - child_advance % line         # 循环起步命令全文（init 建的子实例是未推进态,advance 领首个介入点——cc:call 真机实撞:未给起步命令则 driver 翻 CLI 源码反推,8 轮侧查顶过超时线;照抄纪律不许有"你自己想第一步"的洞）
    - report_completed % line      # 成功回报命令全文（--child-instance 机器通道）
    - report_failed % line         # 失败回报命令全文（--failure-child 机器通道）
```

StepReady 是 agent 主循环的正常推进信号，返回待执行步骤的上下文 ^anc-cli-step-ready

（ParallelReady 类型块与契约段已删——P1 清理：旧通道类型随 driver 面归零删除，见 v0.10.0 版本行；渐进派发形态见 DispatchReady/DrainWait。）

ExecutionPaused 是 CITL 介入点（confirm 审批 / ask 数据收集）触发的暂停信号——自包含介入请求（question + output_schema + default_value + options），caller 拿到即知"看什么/给什么/怎么给"。confirm 答审批（approve/reject）、ask 答数据值，引擎按 pause_reason 解析 answer。见 [[../concepts/HopSpec V3核心规范#^anc-exec-hitl-presentation]] ^anc-cli-execution-paused

pause_reason=commit 是 commit 转人工停点：不靠 answer 续跑,而是按人的选择经 approve_commit 记批准账再 resume（[[#^anc-cli-approve-commit]]、[[exec-engine#^anc-exec-commit-approval]]）;`response_options` 是给人看的三选项（once/task/deny,driver 用它向人提问,选中值作 approve_commit 的 scope,deny 不调）,`presented_data.context` 的形态见 CommitPauseContext。pause_reason=dirs 同理,context 是 `{dirs, dirs_hash}`（[[#^anc-cli-approve-dirs]]）。

```
HopSchema: ExecutionPaused
  # 暂停响应（cli-types.ts ExecutionPaused）;复用模式 run/submit/resume 与独立模式 run_status 的 paused 载荷同一形态
    - status % line               # 恒 'paused'
    - instance_id % line          # 实例 id
    - step_id % line              # 停在哪个步骤
    - pause_reason % line         # confirm | commit | waiting_human | ask | network | escalate | dirs——confirm/commit/waiting_human 审批型;ask 数据收集型;network 网络中断暂停（^anc-exec-network-pause）;escalate 升层问路（^anc-exec-check-escalate）;dirs Config.dirs 清单批准（^anc-exec-dirs-grant）
    - presented_data % yaml       # 自包含介入请求 {summary, question?, instruction, engine_impact?, context?, output_schema?, default_value?, default_values?, present_inputs?}——context 按 pause_reason 分形态,commit 停点见 CommitPauseContext
    - response_options % [yaml]   # confirm 的可选回答 [{value, label, description?}];commit 停点为三选项 once/task/deny（选中值作 approve_commit 的 scope,不作 answer）;dirs 停点为空表
    - work_zone % line            # 实例 work_zone 绝对路径
    - workspace_dir % line?       # 本 run 工作区根（^anc-cli-workspace-arg）;HostConfig 无 workspace_dir 时缺席
    - call_path % [line]?         # 独立模式嵌套 call 里的停点:从顶层 call 步到暂停 spec 的直接父 call 的步骤号链;顶层暂停缺席（[[step-dispatcher#^anc-exec-call-recursion]]）
    - child_instance % line?      # parallel 子实例暂停冒泡入队时携带,resume 按它路由（^anc-exec-parallel-hitl-queue）;顶层与 call 暂停缺席

HopSchema: CommitPauseContext
  # pause_reason=commit 时 presented_data.context 的形态
    - step_id % line              # commit 步骤号,与外层 step_id 同值——approve_commit 的 step_id 参数从这里取
    - fingerprint % line          # body 指纹——approve_commit 的 fingerprint 参数从这里取;body 变了指纹就变,批准失效
    - analysis % CommitAnalysis   # 安全分析结果（[[exec-engine#^anc-exec-commit-approval]]）:summary、逐个动作的大白话后果与 verdict、recommendation、source（model 或 template）——driver 先用大白话把它讲给用户
    - body % text                 # commit 的 hop_python body 原文——用户要求看代码时 driver 原样贴出
```

### CommitApproveResponse（hopjit approve_commit / MCP approve_commit） ^anc-cli-commit-approve-response

```
HopSchema: CommitApproveResponse
  # approve_commit 的返回（engine.ts CommitApproveResponse）;CLI 子命令与 MCP 工具同一形态。分 ok 与 error 两支,按 status 区分
    - status % line               # 'ok' 或 'error'
    - step_id % line?             # ok 支:被批准的 commit 步骤号
    - fingerprint % line?         # ok 支:被批准的内容指纹
    - scope % line?               # ok 支:once 或 task
    - already_approved % bool?    # ok 支:此前已批准过（本次运行同指纹的 once 记录,或同指纹的 task 记录）时为 true,首次批准时缺席
    - store_path % line?          # ok 支:批准账文件路径;批准账未启用（组合根没注册账位置）时缺席
    - code % ErrorCode?           # error 支:COMMIT_NOT_APPROVED（指纹对不上,内容已变）| INVALID_STATE（步骤不是带 body 的 commit,或 scope 不合法）
    - message % line?             # error 支:说明;COMMIT_NOT_APPROVED 的报文带当前指纹
```

MCP 工具在 error 支之外还可能返回 `{ error: { code, message } }`——那是工具入口的实例解析、工作区检查等抛错经 driverErrorOf 转换的结果（[[mcp-server#^anc-mcp-commit-approve]]）,不是本类型。

### CommandResponse（done/fail/answer 通用） ^anc-cli-command-response

```
HopType: CommandResponse
  Id: command-response
  Fields:
    - status % line      # 'ok' 或 'error'
    - code % ErrorCode   # 可选。错误时必填
    - message % line     # 可选。错误说明
```

### VarsResponse（hopjit vars） ^anc-cli-vars-response

```
HopType: VarsResponse
  Id: vars-response
  Fields:
    - status % line             # 恒为 'ok'
    - instance_id % line        # 实例 ID
    - execution_status % line   # 枚举 running/paused/completed/failed/aborted（与 StatusResponse 同源同口径——两响应共用引擎同一状态推导;paused/aborted 语义见 StatusResponse 节。2026-09-09 前此行漏写 aborted 且缺 paused,存量文实偏差随 0081 批齐修）
    - inconsistency % line      # 可选。completed 标记与步骤态不一致的显式信号（一段说明文字）;只在引擎判出不一致时在场（hopissues/0093,[[exec-engine#^anc-exec-completed-consistency]]）
    - variables % yaml          # var_name → value，null = None
    - pending_outputs % [line]  # Outputs 中尚未赋值的变量名
```

### StatusResponse（hopjit status） ^anc-cli-status-response

```
HopType: StatusResponse
  Id: status-response
  Fields:
    - status % line            # 恒为 'ok'
    - instance_id % line       # 实例 ID
    - inconsistency % line     # 可选。completed 标记与步骤态不一致的显式信号（一段说明文字）;只在引擎判出不一致时在场（hopissues/0093,[[exec-engine#^anc-exec-completed-consistency]]）
    - execution_status % line  # 枚举 running/paused/completed/failed/aborted（aborted=主动中止,[[exec-engine#^anc-exec-abort]];paused=停驻等外部应答——todo/0081:此前枚举缺 paused,停驻被报 running,看护方接此通道感知不到"引擎在等人",停点挂死〔2026-09-09 实撞挂 30+ 分钟〕）
    - total_steps % number     # 步骤总数
    - completed % number       # 已完成步骤数
    - failed % number          # 已失败步骤数
    - pending % number         # 待执行步骤数
    - current_step % line      # 可选。本实例当前 running 的步骤 ID（无则已结束）。paused 时分三种情形:停点是本层的 confirm/ask/escalate 步→与 paused_step_id 同指停驻步（暂停态由 running 编码,^anc-exec-pause-persist）;停点是本层的网络暂停→该步已回置 pending,本字段取本层仍 running 的步骤（通常是网络暂停步的父容器;顶层步网络暂停时缺席）;停点在嵌套串行调用的子流程里→本字段照旧取本层 running 的步骤（步骤账先父后子排列、取最后一个 running 的,即那个调用步）,停点本身看 paused_step_id + call_path
    - pause_reason % line      # 可选。仅 paused 时在场——停驻原因摘要（confirm/waiting_human/ask/escalate/network/commit/dirs——commit=commit 批准闸,dirs=Config.dirs 清单批准闸（^anc-cli-approve-dirs）;network=网络重试用完后的网络暂停,todo/0105 起在场;停点在嵌套子流程里时取最深那层的值;畸形卡兜底 unknown——卡在场但 pause_reason 字段非字符串时的防御值,引擎自产卡恒带 reason 正常不出现）,看护方判"该叫人了"用;问题卡全文不在本响应（归 resume/run_status 通道,status 不膨胀）
    - paused_step_id % line    # 可选。仅 paused 时在场——停驻步骤 ID（停点在嵌套子流程里时是最深那层子流程自己的步骤号,不是父层步骤号——配合 call_path 定位）
    - call_path % [line]       # 可选。仅当停点在嵌套串行调用的子流程里时在场——从顶层调用步到停点所在子流程的直接父调用步,逐层的步骤号（与 MCP 暂停载荷 ExecutionPaused.call_path 同语义,[[step-dispatcher#^anc-exec-call-recursion]]）;停点在顶层时缺席。todo/0105 新增
```

**paused 判定三源（0081 原判;0105 追加的源④⑤见下一段——引擎侧,状态源优先不依赖递送件;判定位置=终态凌驾之后、步骤态推导之前——aborted 凌驾〔[[exec-engine#^anc-exec-abort]] 第5条〕与 failed/completed 终态标记凌驾〔todo/0058〕两条既有决策不被扰动:实例已终态时纵有残卡也恒报终态）**：
- ①escalate 停驻=state.json `escalate_pending` 在场;
- ②confirm/ask 停驻=某 running 态步骤的 step_type∈{confirm,ask}（暂停态由 running 编码,[[exec-engine#^anc-exec-pause-persist]]）;
- ③盘上问题卡 paused.json 在场且经陈卡对账（卡的 step_id 在步骤账里仍是 running 才认——卡是递送件非状态源,崩溃路径可残留陈卡,对账纪律与 MCP run_status 兜底路同款）；
- pause_reason 优先取卡内值（卡有完整 reason）,无卡时按判源推；
- **陈卡对账边缘分叉（记档,2026-10-07 前提已变）**：原记"卡缺 step_id 是偶发边缘,引擎侧弃卡落状态源、MCP 兜底侧认卡,不强求归一"。dirs 卡让空 step_id 成为常态路径——源⑥把它收进状态源判定,两侧归一;本条只对 dirs 之外的残卡仍成立；
- 源④⑤（网络暂停、嵌套串行调用子流程里的停点）见下一段;
- **源⑥ Config.dirs 批准停驻**（2026-10-07 todo/0148 review 补——dirs 卡 `step_id` 恒为空串,源③的"卡 step_id 在步骤账里是 running"永不命中,首版 status 对 dirs 停点报 running）=state.json `declared_dirs.outside` 非空 且 `checkDirsApproval()` 返回 approved=false → paused,`pause_reason: dirs`,`paused_step_id` 缺席（run 级前置条件不属于任何步骤）。判定不依赖卡（卡丢了照样报 paused）;MCP run_status 快照兜底对 dirs 卡同判（[[mcp-server#^anc-mcp-run-restore]] 快照兜底——两侧口径一致,不再是"引擎弃卡、兜底认卡"的边缘分叉）。

**网络暂停与嵌套串行调用停点也报 paused（todo/0105,2026-09-25）** ^anc-cli-status-nested-pause

演进来由：
- 0081 批次（2026-09-09）当时把网络暂停写成"已知边界,显式不覆盖"——理由是网络暂停由 dispatcher 在内存里组装载荷、不落问题卡、步骤回置 pending,快照侧判不出;且它是"非人工停点,resume 即续",不在"主 agent 感知等人停驻"的痛点面。嵌套子流程里的停点当时没有讨论,父实例 status 不下钻子实例目录;
- 0105 实撞推翻了这个判断（2026-09-21 宏观任务验收与成绩 T5,hb2 自建 × Ling）：主任务第 5.1.2.2.1.1 步串行调用子流程,子流程第 1.1 步网络重试用完进入网络暂停。观察方全程用命令行 `hopjit status`,30 多分钟看到的一直是"running、停在 5.1.2.2.1.1",最后停掉任务。网络暂停没人调 resume 就永远停着——恰是 0081 要消灭的"引擎停下了外面没人知道";嵌套子流程里的 ask 停点经复现测试确认同样报 running;
- 判断"判不出"也不成立：网络暂停在状态账事件流里留有 network_pause 事件（随 state.json 持久化）,子流程的快照在父实例目录的 `calls/<子实例>/` 下,都是盘上可读的状态源,不需要新增问题卡;
- 作者 2026-09-25 拍板,选项原文"甲：顶层+嵌套都看见（推荐）"：命令行 status 对顶层网络暂停和嵌套串行调用子流程里的停点都报 paused,判定只看状态账。

**能力契约（HopTrait）**：

```
trait: StatusNestedPauseVisible
  Id: status-nested-pause-visible
  Constraints:
  - 判定位置不动:源④⑤追加在源①～③之后,仍处于"终态凌驾之后、步骤态推导之前"——aborted、failed、completed 三个终态标记照旧先判,实例已终态时纵有残留停点也报终态
  - 源④ 网络暂停:本实例某步当前是 pending,且事件流里 step_id 等于该步的最后一条事件是 network_pause → paused,pause_reason=network,paused_step_id=该步。该步重新开始（记 step_start）或完成后最后一条事件已不是 network_pause,自然不再算——判据只看状态账,不看递送件
  - 源⑤ 嵌套串行调用下钻:本实例某个未标 parallel 的 call 步当前是 running,且本实例目录下 calls/<子实例名>/ 有子流程快照 → 对子流程快照递归套用同一套判定（源①～⑤）,命中即报 paused;子实例名用引擎现成取名法 serialCallChildInstance（循环里带各层轮次后缀,[[exec-engine#^anc-exec-call-child-iter-id]]）——与子引擎落盘目录同一来源,不另造
  - 最深层取值:pause_reason 与 paused_step_id 取最深那层停点的值,call_path 记从本层到停点所在子流程的逐层调用步号;子流程已落终态标记（completed/failed/aborted）时不算停点
  - 不下钻 parallel 子实例:parallel 子实例等人时 run 整体报什么,已由 [[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 3 条锁定（主线还能推进报 running + 待答队列,主线只剩等人才报 paused;呈现通道是 MCP run_status 的 paused_queue）——status 见到 parallel 子实例等人就报 paused 会与之冲突。作者拍板原文指定的取名法 serialCallChildInstance 也只对应串行调用
  - 读失败不抛错:纯内存实例（无实例目录）、子目录不存在、子快照读失败,一律当作该层无停点,落到步骤态推导——status 是观测面,不因观测失败而失败
  - 不新增问题卡、不改暂停与恢复语义:网络暂停照旧不落卡、resume 照旧按 call_path 下钻（[[step-dispatcher#^anc-exec-network-pause]]）;本条只让观测面如实
```

**关键逻辑（HopSop）**：

```
detectPausedState(本实例) → {reason, stepId, callPath?} | null:
1. 源⑥:checkDirsApproval() 有结果且 approved=false（state.json declared_dirs.outside 非空且账未批）→ 返回 {dirs, stepId 空串}（run 级前置条件不属于任何步骤,不读卡——dirs 卡 step_id 恒空串,源③永不命中,所以排在最前）
2. 源③:读 paused.json,卡的 step_id 在本实例步骤账里仍是 running → 返回 {卡内 reason 或 unknown, 卡 step_id};否则视为陈卡落下一步
3. 源①:escalate_pending 在场 → 返回 {escalate, 该步}
4. 源②:某步 running 且 step_type ∈ {confirm, ask} → 返回 {confirm|ask, 该步}
5. 源④:某步 pending 且 事件流里该步最后一条事件 = network_pause → 返回 {network, 该步}
6. 源⑤:对每个 running 且未标 parallel 的 call 步 c:
   6.1 子目录 = <本实例目录>/calls/<serialCallChildInstance(c)>/;无本实例目录或子目录无 state.json → 跳过
   6.2 子引擎 = load(子目录);读失败 → 跳过
   6.3 子引擎已落终态标记 → 跳过
   6.4 d = 子引擎.detectPausedState();d 非空 → 返回 {d.reason, d.stepId, callPath: [c, ...(d.callPath ?? [])]}
7. 返回 null

determineExecutionStatus:aborted → failed → completed 标记 → detectPausedState 非空报 paused → 步骤态推导（顺序不变）
getStatus:paused 时 pauseSummary = {pause_reason, paused_step_id, call_path(仅非空时)}
```

测试正反例（tests/engine.test.ts、tests/dispatcher.test.ts、tests/cli.test.ts,@v: anc-cli-status-nested-pause）：顶层网络暂停报 paused+network,该步重新开始或完成后不再报;嵌套串行调用子流程网络暂停报 paused+network+call_path,子步重新开始后回 running;dispatcher 真跑出的嵌套网络暂停经 load 父目录报 paused+network+call_path,按 call_path 恢复跑完后报 completed;嵌套 ask 停点报 paused+ask+call_path,答完后不再报;两层嵌套时 call_path 由外到内;循环里的串行调用（子实例名带轮次后缀）也能下钻命中;父实例已终态时子目录残留停点仍报终态;子实例已落终态标记（completed 或 abort 后残留暂停痕迹）不下钻;命令行 status 读快照同口径。

### AbortResponse（hopjit abort） ^anc-cli-abort-response

```
HopType: AbortResponse
  Id: abort-response
  Fields:
    - status % line            # 恒为 'ok'（幂等重放同形态;异态改写走 error 面 ABORT_TERMINAL_CONFLICT）
    - instance_id % line       # 实例 ID
    - execution_status % line  # 恒为 'aborted'
    - abort_reason % text      # 中止原因（入账值——显式传入或缺省 '(user abort)'）
```

### ReplanResponse（hopjit replan） ^anc-cli-replan-response

ReplanResponse 是联合类型，成员 ReplanSuccess / ReplanError，由 `status` 区分：

```
HopType: ReplanSuccess
  Id: replan-success
  Fields:
    - status % line                 # 恒为 'ok'
    - new_children % [StepSummary]  # 替换后的新步骤摘要

HopType: ReplanError
  Id: replan-error
  Fields:
    - status % line         # 恒为 'error'
    - code % ErrorCode      # 错误码
    - errors % [SpecError]  # 解析或验证错误
```

### ~~driver-mode~~（已废止,2026-08-27 四改） 

三改引入的模式读出命令与 DriverModeResponse 随双名双壳形态废止——模式编码进 skill 名（`/hopspec`=复用,`/hopspec-mcp`=MCP）,运行时无判定即无读出需求。决策与演进史见 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]] 四改条款。`^anc-cli-driver-mode` 锚废止。

### BranchRequest（已废除,2026-10-12 todo/0168） ^anc-cli-branch-request

**废除记录**：原型 `BranchRequest { step_id, selected_case_id, reason? }` 是 `submit_and_fetch_next --branch <case-id> [--reason]` 的请求体,让调用方替引擎指定 branch 走哪个 case（原文把它说成调试或人工介入时手选 case 的口子）。作者 2026-10-12 定"不存在外部选路场景,branch / case 都是显性条件"：选路只由引擎进入 branch 时按 case 条件求值,调用方的角色是交付前序步骤的产出值,不是替引擎选路——预选绕过 spec 写明的条件,运行中改选把账改一半后以 No executable step found 失败（契约与根因见 [[exec-engine#^anc-exec-branch-select-internal]]）。随之一并撤的：`src/cli-types.ts` 的 `BranchRequest` 类型、CLI 的 `--branch` / `--reason` 选项、复用模式驱动面 `branch` 提交形态（[[mcp-server#^anc-mcp-reuse-driver-tools]] 八种改七种）、`engine.selectBranch` 公开方法。锚点保留作废除记录载体（五层链稳定标识不因废除断链）,代码与测试不再挂它。

---

## JSON I/O 约定【契约】

**tool_request 通道（2026-08-04，随引擎 `^anc-exec-tool-request` 新增）**：NextResponse 联合类型增 `ToolRequest` 分支（形状见 [[exec-engine#^anc-exec-tool-request]]）。
- `submit_and_fetch_next` 增 `--tool-result '<json>'|@file` 参数（与 --output/--answer 互斥三选一）——应答 tool_request 专用，注入单工具结果后引擎续解释 body。对非 tool_request 状态使用返回 INVALID_STATE。

**输出分流** ^anc-cli-json-io
- **缺省输出 YAML**（多行块状，人可读——2026-08-06 作者拍板："缺省都是 yaml，除非用 --json 强制"；锚点 ID 保留历史名不改，契约以本文为准）；`--json` 全局 flag 或环境变量 `HOPJIT_OUTPUT=json` 强制单行 JSON（优先级：`--json` flag 或 `HOPJIT_OUTPUT=json` 任一即 JSON（实现为 env 恒优先——现实用况两者无分歧））
- **机器消费方显式走 `--json`**：driver（CC/Codex skill 全部命令模板）、测试，以及 HopJIT 生成后交给 driver 原样执行的 `launch_command` / `join command` 统一带全局 `--json`（位置在子命令前）——协议行为与历史完全一致；人裸跑 setup/pack/validate/list/status 等命令直接得 YAML
- 错误输出到 stderr（非 JSON），成功/业务错误输出到 stdout（YAML 或 JSON 按上述规则）
- `--output` 和 `--answer` 互斥：正常步骤用 `--output`，HITL 回复用 `--answer`
- `--answer`：仅用于 HITL 暂停后注入用户回复。接受 JSON 字符串 `'{"value": "approve", "reason": "..."}'`。value 必须匹配 ExecutionPaused.response_options 中的某个 value。对非暂停步骤使用 `--answer` 返回 INVALID_STATE 错误
- **`--output` 与 `--answer` 解析后必须是 JSON 对象（2026-10-07 todo/0146 probe 3 实撞）**：两者的协议都是"键名到值"的对象（`--output` 键是输出槽名,`--answer` 键是 `value`/`decision` 等）。解析结果是字符串、数字、布尔、数组或 null 时,CLI 在调用引擎之前以 `INVALID_ARG` 报错退出（stderr,非零退出码）,报文给出正确形态 `{"value":"approve"}` / `{"<输出槽名>": <值>}`,引擎状态不动。实撞：driver 照 help 文字"as JSON"传了 `--answer '"approve"'`,JSON 字符串一路进到引擎 confirm 决策提取,`'decision' in "approve"` 抛 TypeError,报出的是 JS 内部错误而不是用法错误。MCP 驱动工具 `submit_and_fetch_next` 在 reuse-driver 里做同一检查（[[mcp-server#^anc-mcp-reuse-driver-tools]]）——它的 inputSchema 为了接受 `@路径` 允许字符串,JSON 文本形态的字符串解析出来照样可能不是对象。
  ```
  output/answer 对象检查（CLI 与 MCP 驱动工具同一规则）:
  1. raw = output ?? answer;[条件(raw 缺席)] 跳过检查,按无产出提交
  2. parsed = 解析 raw（@路径先核 work_zone 再读文件,其余按 JSON 文本）
  3. [条件(parsed 不是对象,或是数组,或是 null)] 以 INVALID_ARG 拒,报文写明收到的类型与正确形态,引擎状态不动
  ```
- `--output` 和 `--steps` 接受 JSON 字符串或 `@file` 路径（避免 shell 参数长度限制）
- 由关键决策 2 推演：单行 JSON + stdout/stderr 分流

**文件参数与 work_zone 工作区** ^anc-cli-file-arg-safety
- `@file` 路径：`--output`/`--answer`/`--params`/`--replan`/`--tool-result`/`--upstream-feedback` 的值以 `@` 开头时从文件读取内容（`--upstream-feedback` 读原文不做 JSON 解析——引擎拼给 driver 的命令里参数表与反馈文本恒走文件形态,见 [[exec-engine#^anc-exec-cmd-args-file]]）。**推荐并鼓励用响应给出的确切路径**（step_ready 的 `output_path` / `work_zone` 目录下）。
- **提交越界校验**：`submit_and_fetch_next --output "@<path>"` 与 `--tool-result "@<path>"` 时，引擎校验 `<path>` 落在本执行单元的 `work_zone` 内，**越界（如 /tmp、项目根、兄弟 child 的 work_zone）→ 拒绝提交并报错**（提示改写本单元 work_zone 路径；两入口同款 `assertOutputInWorkZone`,src/cli.ts 里 `submit_and_fetch_next` 的 `--tool-result` 与 `--output` 两条分支各调一次）。
  - **前缀判定用平台分隔符**（`path.sep`,不硬编码 `'/'`）——win32 下 `resolve` 产反斜杠路径,硬编码前斜杠使 work_zone 内的合法路径永不匹配、`@file` 提交全废（0057 实撞:Windows 用户 parallel 场景 @file 全被误拒,而 @file 恰是 worker 输出提交的设计形态）；
  - 整个 `@<path>` 必须作为一个双引号参数，兼容含空格的工作区；`@` 位于参数值首字符，CLI 才会读文件；
  - 这是引擎唯一能真拦的点——复用模式 act 由 CC/worker 的 Bash/Write 执行、写入不过引擎，无法在"写入那一刻"拦，只能在"提交那一刻"校验。硬边界的极限即此（不做 OS 级沙箱）。
- **并行 worker 隔离（消除串台）** ^anc-cli-parallel-file-isolation：parallel fan-out 多个 worker subagent 共享 cwd。三重保险消除串台（实证 bug：ppt-html 多页并行，worker 共用 `/tmp/out_4.3.1.1.json` 互相覆盖、s5 变 s4）：
  - **① work_zone 路径带 child 身份（身份在实例目录层级，不在目录名）**：parallel/call 子实例的实例目录本身按 child 分道（`<父instanceDir>/parallel/<child_step_id>/` 或 `calls/<child_step_id>/`），work_zone 恒为实例目录下的**固定名** `work_zone/`（persistence `getWorkZone` = `<instanceDir>/work_zone`,src/persistence.ts `FilePersistence.getWorkZone`）——不同 child 的完整路径天然不同。
    - 原文"目录名带后缀 `work_zone_<child_step_id>`"与实现不符，[[exec-engine#^anc-exec-work-zone]] 2026-08-30 已勘误，本处同步。
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
