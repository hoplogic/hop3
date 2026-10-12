%% @trace
	id: hopjit-hopant
	source: [[../concepts/HopAnt概念]]
	source_id: cyant-concept
	type: extend
	last_sync: 2026-10-11T21:47+0800
	note: HopAnt 实体在引擎侧的第一个模块——安装、适配、本机索引、编排的寻址与起跑核（概念层生命周期①②③）。todo/0142 子卡 A 与 B。inner_store 的读写机制归 todo/0144,本模块只建目录与放适配戳。
%%

# hopant 模块设计规范

> **模块版本**：hopant `v0.5.4`（2026-10-11 todo/0159：packAnt 前置核从"存在性"扩到"存在且可读"——doc-ref 与 assets 两类写盘前 accessSync(R_OK),读不出一次性抛 HOPANT_DOC_MISSING 带系统 message;错误码表该行扩语义不新开码;测试面补反例）。上版 v0.5.3（2026-10-11 作者 `/hop 把天气查询总结` 实撞：packAnt 直落 HopAnt 根时不重建 index.md,项目级 `hop_tasks/ants/index.md` 封完仍空表而 /hop 分派只读索引——加 opts.indexRoot,组合根判 outDir 等于 roots.project / roots.user 时传入,步 7 重建该根索引;^anc-hopant-index 改动入口从两个列到三个;PackAntResult 加 index_rebuilt）。上版 v0.5.2（2026-10-11 语义审计 0156 C 类：removeAnt 约束与 HopSop 步 1 两处"返回 false"改"返回 null"与 v0.5.1 定的返回类型一致;packAnt outDir 说明改为如实陈述现行分工——两组合根缺省 `<工作区>/ants`,driver 总结时显式传 out=项目级根;scanCredentials L2 补写 hex 熵门槛 3.0 与分档理由）。上版 v0.5.1（2026-10-10 0154+0155 工程链 review 修复：删 HopAntHome 节末多余的代码围栏（全文围栏奇偶翻转,渲染与 check-line-length 判定全反）;removeAnt 返回类型改定为 `project | user | null`（代码与 hop-admin 一直按此;设计写 bool 是漏改）;resolveAnt 补 HOPANT_BAD_ID 约束;决策 9 补拍板来源;决策 8 git 配置按工作区目录读;:47 与 CLI 承接段两级口径;出口表补 CREDENTIAL_SCAN_DISCLAIMER;AntRoots.user 形态约束）。上版 v0.5.0（2026-10-10 todo/0155 作者定"总结成 hopant,而且应该有项目级 hopant 位置"：HopAnt 根从一级改两级——用户级 `~/.hopjit/ants/` 与项目级 `<项目>/hop_tasks/ants/`,查找项目先于用户、同 id 项目级遮用户级;新类型 AntRoots 与 resolveAnt / listAntsIn / rebuildIndex 按根操作,install / remove / adapt / bootstrap / share 都按两级找或按 scope 落;call 寻址与批准账定位第二级改为两根顺序查;checkRunDeps 收 roots;packAnt 不变（它只写 outDir,落项目级由组合根把 outDir 定成项目级根）。上版 v0.4.2（2026-10-09 commit 安全分析批次工程链 review 缺陷 D41：commit 批准账的说明改为“先查账、账上没有才做安全分析”,引擎判定安全的结果也记进账）。上版 v0.4.1（2026-10-09 子卡 C/E 工程链 review 修复批,作者拍四件：①凭证核不靠关键词,三层证据综合研判打分（已知厂商形态 / 高熵 / 键名提示+值形态,拒—警告—放行三档）,扫描面扩到可分发面全部文本文件,免责五处——"用户应自己避免密钥写入 hop 文档或代码";②标准工具例外回写概念⑤,补入标准工具时写标准签名;③概念 Package 节删 postinstall;④curl 走已批准命令,不加 web_fetch。review 实锤修复：授权行内建名经内建名单过滤且跳过 `*`（H-1：库内五份 spec 封装后 adapt 红）;改写面复用 parser 签名/切词函数（中文工具名、带引号命令报删实未删）;owner 落盘即用不再问（决策 8 被 hop-cli 条文反了）;assets 前置核;doc-ref 越界拒;Id 行保证;内建名单改用 validator B2 两名单（消第三份手抄,补通知件）;Tools 段插 Outputs 后;出口表补五类型;错误码计数去数字）。上版 v0.4.0（2026-10-09 todo/0142 子卡 C 封装 + E 分享,作者定"C + E"、第一个真实 HopAnt 拿 hop-fact-check：新 HopType **AntPacker**（^anc-hopant-pack）——`packAnt` 把一份 spec 升格为可装的 HopAnt 目录,核心是**头对账**：从 act/commit 的 body 用 AST 扫实际调用的工具与 subprocess.run 首项,与 Tools 段 / 《已批准命令》段比对,少补多删并把增删列进报告（概念⑤"作者不手填,/hop 从正文扫"）;`shareAnts` 把若干已装 HopAnt 的可分发面装进 HopAnt 包目录,分享前四核（头与目录一致 / 无凭证字面量 / 本机面不在包里 / 有谱系才写谱系）不过即拒不写;`isLocalFace` 从 applyInstall 抽出与 share 共用;owner_id 的写回落在 share。CLI `hopjit ant pack` / `ant share`,错误码加五个。②b 出口表加六项（packAnt / reconcileHeader / collectBodyUsage / shareAnts / findCredentialLiterals / isLocalFace）;决策 8 的 `--branch-id` 改实为 `--owner`）。上版 v0.3.7（2026-10-08 commit 批准账的说明随 [[exec-engine#^anc-exec-commit-approval]] 改为安全分析:指纹只覆盖 body,模型判定安全与人批准都按 spec 路径+步骤号+body 指纹记;本模块代码不动）。上版 v0.3.6（2026-10-08 commit 批准账记账键改为内容指纹,task 一律通过按 spec 路径记——随 [[exec-engine#^anc-exec-commit-approval]] 自动研判优先）。上版 v0.3.5（2026-10-07 todo/0146 工程链 review 修复批次：CommitApprovalStoreLocate 补块首说明行;commitApprovalStorePath 比较前先解析 antsRootDir 的软链——引擎传入的 spec 路径已解析软链,HOME 经软链时两边口径不一会让 HopAnt 的账错落 .hopstate）。上版 v0.3.4（2026-10-07 dirs 批 review：②c 加"readwrite 不许指向 HopAnt 自身"归适配期核（待实现,挂子卡 D）。上版 v0.3.3（2026-10-07 todo/0148：编排节加 `dirsApprovalStorePath`（与 commitApprovalStorePath 同规则,文件名 dirs_approvals.json）。上版 v0.3.2（2026-10-07 ②c 运行时目录加一条：HopAnt 的 commit 批准账落 `inner_store/commit_approvals.json`,读写归引擎 [[exec-engine#^anc-exec-commit-approval]];编排节加纯函数出口 `commitApprovalStorePath`（^anc-hopant-commit-store）——账位置规则只此一份实现,两个组合根注册的闭包都调它;todo/0146;上版 v0.3.1=2026-10-07 spec_dir 批 review 修复：②c 立锚 ^anc-struct-hopant-runtime-dirs、脚本路径约定全经 argv 不依赖 cwd、读授权对文件工具生效的出处;上版 v0.3.0=2026-10-07 加「编排」节——callee 寻址纯函数 `resolveCalleeSpecPath` 与复用模式起跑依赖核 `checkRunDeps` 两个出口,/hop 分派读索引的协议;todo/0142 子卡 B,作者 2026-10-07 定方案;上版 v0.2.4=2026-10-06 定位节加「运行时目录」条——工作区=用户项目,HopAnt 目录只读,自带脚本经已批准命令+subprocess.run+spec_dir(),todo/0145 作者定;上版 v0.2.3=2026-10-06 归属标识改名：出口 `branchId`→`ownerId`、适配戳字段 `branch`→`owner`、config 键 `owner_id`——作者抓"为啥叫 branch_id",它标的是人与机器不是谱系分支;上版 v0.2.2=2026-10-06 CLI 承接节加第二个调用方：setup 缺省装演示 HopAnt 复用 planInstall/applyInstall,模块代码不变;上版 v0.2.1=2026-10-06 工程链 review 修复批：headerHash 复用 parser 段识别〔中文段头/内联形此前哈希不变〕、两级注册面读取挪进 tools-registry、missing 先算不靠引擎报文、adaptState 出口、HopType 签名按规则 3 竖排带 #、纯数据块改 HopSchema;上版 v0.2.0=2026-10-06 加决策 7：标准工具 `web_search` 没注册不算适配缺口,报告加 `tools.standard_unregistered` 与 `notes` 两个字段——作者定"websearch 应该视为标准工具";上版 v0.1.0=2026-10-06 新建——todo/0142 子卡 A：HopAnt 目录布局、安装、配置适配、本机索引,CLI 承接 `hopjit ant`。概念权威 [[../concepts/HopAnt概念#^anc-struct-hopant-layout]] / [[../concepts/HopAnt概念#^anc-struct-hopant-package]] / [[../concepts/HopAnt概念#^anc-struct-hopant-lifecycle]]。逐版演进史归 git log）

## 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（边界、出口清单、运行时目录） | 契约 | `anc-struct-hopant` / `anc-struct-hopant-exports` / `anc-struct-hopant-runtime-dirs` |
| 关键决策 | 决策 | — |
| HopAntHome（hop 目录与索引） | 契约 | `anc-hopant-home` / `anc-hopant-index` |
| AntInstaller（来源识别、安装、卸载） | 契约 | `anc-hopant-install` |
| AntAdapter（配置适配与适配戳） | 契约 | `anc-hopant-adapt` / `anc-hopant-stamp` |
| 编排（分派、call 寻址、批准账位置、起跑依赖核） | 契约 | `anc-hopant-orchestrate` / `anc-hopant-callee-resolve` / `anc-hopant-commit-store` / `anc-hopant-run-deps` |
| AntPacker（封装：spec → HopAnt 目录,头对账;分享：HopAnt → HopAnt 包,四核） | 契约 | `anc-hopant-pack` / `anc-hopant-share` |
| 错误码 | 契约 | `anc-hopant-errors` |
| CLI 承接 | 说明 | 契约在 [[hop-cli#^anc-cli-ant]] |

## 定位【契约】 ^anc-struct-hopant

**① 自身定位**：hopant 是驱动适配层的一个模块,把概念层定义的 HopAnt 实体落到文件系统上——一个 HopAnt 就是 hop 目录下的一个子目录,本模块负责把它装进来、核它在这台机器上能不能跑、把它登记进本机索引。它只操作文件与已解析的 spec 头,**不执行 spec、不起子进程、不读进程环境**：home 目录、项目根（两级 HopAnt 根由此算出,决策 1）、环境变量表、PATH 目录列表、git 用户名、主机名、引擎版本全部由调用方（组合根 `cli.ts` / `mcp-server.ts`,经 hop-admin）取好后以参数传入。这样测试可以用临时目录与假环境表完整覆盖,模块自身零 `process.*` 引用（守卫 `check-process-state.mjs` 的内核纪律）。

**② 与其他模块的关系**：
- 读 spec 头用 [[spec-parser]] 的 `parseSpec`——HopAnt 的清单就是入口 spec 的文件头（[[../concepts/HopAnt概念#^anc-struct-hopant-layout]] 清单表）,本模块不另造清单格式;
- Tools 段对账复用 [[exec-engine#^anc-exec-tools-reconcile]] 的静态方法 `ExecutionEngine.reconcileTools(needs, available)`——判据与独立模式起跑时一致,不另写一套;
- 注册面来自两级配置（`~/.hopjit/config.yaml` + `<项目>/hopjit.yaml`,[[shared-providers#^anc-config-standalone-schema]]）的 `tool_servers` 与 `providers` 两节,由 tools-registry 的 `loadTwoLevelRegistry(sysPath, projPath)`（[[tools#^anc-struct-tools-exports]] 出口;v0.1.1 从 cli.ts 挪入——读配置→解析注册面本就住那里,`loadProjectToolRegistry` 是先例）读取合并后由组合根传入：空文件/纯注释按无配置、顶层不是 YAML 映射抛 `TOOLS_FILE_INVALID`、`tool_servers` 按 name 与 `providers` 按 `service_id`（大写比）项目级赢、`enrichParamsComments` 回填——与 mcp-server 的 `mergeConfigs` / `parseConfigFile` 同律。不 import `loadStandaloneConfig`：它住 mcp-server.ts,该文件顶层加载 MCP SDK,CLI 每条命令都会付这笔启动费。`HOPJIT_CONFIG` 环境变量在场时组合根把它当 sysPath、projPath 传 null（单文件语义,与 mcp-server 同）。todo/0131 把两级合并统一到 CLI 侧时本函数并入;
- CLI 承接见 [[hop-cli#^anc-cli-ant]]：`hopjit ant install|adapt|list|remove|bootstrap|pack|share`;
- **不碰** inner_store 内部机制（[[../../todo/0144_store数据层_引擎内置SQLite工具_一库两schema-act写tmp-commit写main_open|todo/0144]]）：本模块只建 `inner_store/` 目录并在其中放一个适配戳文件;0144 落地后适配戳迁入其机制,本文随之升版。

**②c 运行时目录** ^anc-struct-hopant-runtime-dirs：（todo/0145,作者 2026-10-06 定;概念权威 [[../concepts/HopAnt概念#^anc-struct-hopant-layout]]「跑 HopAnt 时的工作区」段;2026-10-07 review 立锚——落点不在 hopant.ts 而在 engine/dispatcher/tools,子卡 B 接线"独立模式传 workspace_dir=用户项目"要有锚可挂）
- **工作区 = 用户发起 /hop 时所在的项目目录**,不是 HopAnt 自己的目录。文件工具读写、commit 落点、相对路径解析都按用户项目算。复用模式 CLI run 取 cwd（既有行为,零改动）;独立模式由 /hop 起 run 时传 workspace_dir=用户项目（子卡 B 接线）。
- **HopAnt 目录是只读资源目录**：引擎起跑把 spec 所在目录加进读权限（[[doc-ref#^anc-exec-doc-ref-resolve]],两模式共用;文件工具读类认这条授权——[[tools/file-tools#^anc-exec-tool-path-resolve]] 第④形态,2026-10-07 补）;`knowledge/` 经 doc-ref 两级基准（先 spec 目录后工作区）;数据样例经文件工具读 `read(path: spec_dir("data/a.csv"))`。一条读授权覆盖 knowledge / 数据样例 / 将来的 inner_store,不分开授权（作者 2026-10-07 定）。
- **自带脚本 `scripts/` 经任务级授权跑**：入口 spec《已批准命令》列 `- python3 scripts/x.py`,body 里 `subprocess.run(["python3", spec_dir("scripts/x.py"), "--data", spec_dir("data/a.csv"), "--out", work_zone_path("out.json")])`;路径由 [[act-body#^anc-exec-spec-dir]] 的 `spec_dir(rel?)` 取。**脚本的路径约定：全部路径经 argv 传绝对值,不依赖 cwd**——`subprocess.run` 不传 cwd（缺省 work_zone,脚本的临时输出落涂鸦区）,自带资源用 spec_dir()、输出用 work_zone_path()、用户文件由 Inputs 给;不加"workspace 根"内置,需求出现前不开（2026-10-07 review 抓示例 cwd 留省略号后定）。**不经 `run_script`**——那条工具守的是执行模型现写的脚本（[[tools/run-script]]）,两条寻址链不混。
- **commit 不写 HopAnt 目录**：spec 目录不在写权限内,可分发面不被运行弄脏。演化回写 HopAnt 自己的 spec（概念生命周期④）归子卡 D 另开口子。
- `inner_store/` 的注入归 todo/0144。
- **入口 spec 的 `Config.dirs.readwrite` 不许指向 HopAnt 自身目录**（概念 ^anc-struct-hopant-layout：HopAnt 目录只读,演化回写走 /hop 人审）——引擎不判（引擎不认识 HopAnt 安装位,[[exec-engine#^anc-exec-dirs-grant]] 与 spec 目录的关系条）;归 AntAdapter 适配期核：readwrite 展开后落在 `<antDir>` 内 → 适配缺口 `readwrite_targets_self`,hints 指路"把目录声明改到用户项目或 inner_store 之外"。**待实现**,挂 todo/0142 子卡 D（演化落 inner_store 时一并）。
- **dirs 批准账落 `inner_store/dirs_approvals.json`**（todo/0148,2026-10-07）：HopAnt 入口 spec 在 `Config.dirs` 声明的 workspace 外目录,第一次跑前须经人批一次,按 spec 路径 + 展开后清单哈希记账（[[exec-engine#^anc-exec-dirs-grant]]）。与 commit 批准账并排、分文件;同为**本机面**——分享不带,接收方装上后自己批一次（装前适配只核工具与凭证,目录授权在第一次跑时问）。
- **commit 批准账落 `inner_store/commit_approvals.json`**（todo/0146,2026-10-07）：HopAnt 里每个 `[commit]` 步骤在当前 body 下第一次执行前先做安全分析,之后查账放行不再扫描:引擎判定安全的、分析模型判定安全的、人批准的、转人工待批的都记进账,按 spec 路径+步骤号+body 指纹记账（人选"只批准这一次"时另记本次运行的 run_id）（[[exec-engine#^anc-exec-commit-approval]]）。HopAnt 的账跟 HopAnt 走而不跟用户项目走——同一个 HopAnt 在不同项目里跑,批过的 commit 不必每个项目重批;卸载时 `--keep-store` 一并保留。判据是 spec 文件落在任一级 HopAnt 根（`<项目>/hop_tasks/ants/<id>/` 或 `~/.hopjit/ants/<id>/`）下;读写由引擎做,本模块只保证 `inner_store/` 目录在场。0144 落地后是否迁入其机制随 0144 定。

**③ 不是什么**：不是 /hop 的分派面——分派判断由 driver 在主对话里做,本模块只提供它读的索引、它查的适配状态、它跑之前的依赖核（见「编排」节）;不做逻辑适配——改 spec 的动作归 /hop 侧,本模块只提供"改之前备份原件"的原语（封装与分享见「AntPacker」节——2026-10-09 子卡 C/E 落地,此前本句写"不是封装器与分享器"）;不处理 git URL / 压缩包 / npm 三条取包通道（本版来源只认本地目录,三条通道取到本地目录后同样走本模块）。

**②b 对外接口清单【封闭】** ^anc-struct-hopant-exports：

> 出口文件 = `src/hopant.ts`。表外符号即内部实现。

| 符号 | 种类 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|
| `AntRoots` / `AntScope` / `antRoots` | 类型 / 函数 | 两级 HopAnt 根 `{project % line, user % line}` 与级别名 `project | user`;`antRoots(home, projectDir)` 算出两根（用户级 `<home>/.hopjit/ants`,项目级 `<projectDir>/hop_tasks/ants`）。hop-admin 与 mcp-server 构造 | provisional |
| `antsRoot` / `antDir` / `indexPath` | 函数 | 单根路径约定三件——`antsRoot(home)` 是用户级根（旧名保留,=antRoots(...).user）;`antDir(root, id)` / `indexPath(root)` 第一参改为**根目录**（任一级都行）,cli 与测试 | provisional |
| `resolveAnt` | 函数 | 按 id 两级查找（roots, id）→ `{dir, scope}` 或 null;项目级先于用户级（决策 9）。adapt / remove / bootstrap / share / 分派命中都经它 | provisional |
| `listAntsIn` / `listAnts` | 函数 | `listAntsIn(root)` 单根已装 id 列表;`listAnts(roots)` 两级合并 `[{id, scope, dir}]`（项目级在前,同 id 两条都在） | provisional |
| `rebuildIndex` / `specTitle` | 函数 | `rebuildIndex(root)` 重建该根的 `ants/index.md`,install/remove 末尾对改动的那一级调;`specTitle` 去掉 parser 保留在 title 里的 `Spec: ` 前缀（索引与 list 共用） | provisional |
| `detectSource` | 函数 | 来源目录是单 ant 还是包,cli install | provisional |
| `planInstall` | 函数 | `planInstall(srcDir, root)` 生成安装计划（含撞 id 与 bootstrap 标记）——第二参是目标级的根（项目级或用户级,撞 id 只在这一级判）;cli install 与 --dry-run | provisional |
| `applyInstall` | 函数 | 按计划拷贝可分发面、建 inner_store、重建索引 | provisional |
| `removeAnt` | 函数 | 卸载（roots, id, keepStore, scope?）→ 删了哪一级 `project \| user`,没装返回 null——scope 缺省按 resolveAnt 找到的那一级删;备份位恒 `<home>/.hopjit/ants-store-backup/<id>/`（两级共用,用 roots.user 上溯 home） | provisional |
| `ownerId` | 函数 | 归属标识 `<用户>-<主机>`（gitUserName, loginName, hostname） | provisional |
| `headerHash` | 函数 | 入口 spec 头三段的内容哈希（specText） | provisional |
| `readStamp` / `writeStamp` / `needsAdapt` | 函数 | 适配戳三件 | provisional |
| `adaptState` | 函数 | `ant list` 三态 never / stale / adapted,CLI 只调不判 | provisional |
| `adapt` | 函数 | 配置适配：工具/凭证/命令/引擎四项核,返回报告（antDir, env） | provisional |
| `backupOrig` | 函数 | 逻辑适配前备份 `<id>.md` → `<id>.orig.md` | provisional |
| `resolveCalleeSpecPath` | 函数 | call 目标寻址（callerDir, roots, calleeId）:同目录 → 项目级根 → 用户级根（roots 可为 null 只查同目录）;两个消费点——cli 注册给引擎（复用模式填真实路径）、dispatcher 的 DirSpecProvider（独立模式） | provisional |
| `dirsApprovalStorePath` | 函数 | dirs 批准账位置,与 commitApprovalStorePath 同规则换文件名 `dirs_approvals.json`（^anc-hopant-commit-store,[[exec-engine#^anc-exec-dirs-grant]]） |
| `commitApprovalStorePath` | 函数 | commit 批准账位置（roots, specPath, runRootParent）:spec 在任一级 HopAnt 根下记该 HopAnt 的 inner_store/,其余记 .hopstate/;cli 与 mcp-server 注册给引擎的闭包调它（^anc-hopant-commit-store） | provisional |
| `checkRunDeps` | 函数 | 复用模式起跑依赖核（specText, specPath, env{roots, tool_servers}）:Tools 段工具 + 静态 call 目标（同目录 → 两级 HopAnt 根）,沿 call 树递归;cli / reuse-driver 顶层 run/init 调 | provisional |
| `packAnt` | 函数 | 封装（specPath, outDir, opts{id?, assets?}）：解析 spec → 头对账 → 写 `<outDir>/<id>/<id>.md` 与附件 → 返回 PackAntResult（含 reconciled 增删报告）;docs 缺即抛不写 | AntPacker ^anc-hopant-pack | stable |
| `reconcileHeader` | 函数 | 头对账纯函数（specText）→ ReconcileReport + 改写后的 spec 文本：Tools 段 ← 带 body 步骤的工具调用 ∪ tool_grants;已批准命令段 ← subprocess.run 列表字面量首项;只动这两段,其余字节不变 | AntPacker ^anc-hopant-pack | stable |
| `collectBodyUsage` | 函数 | AST 遍历（steps）→ {tools % [line], commands % [line], undetermined % [line]}：工具名=CallExpr.callee 去掉内建函数/内置文件工具/引擎内建 special/subprocess.run 后余下的 ∪ tool_grants;命令=subprocess.run 第一参 list 字面量的首元素字面量;第一参非字面量记 undetermined | AntPacker ^anc-hopant-pack | stable |
| `shareAnts` | 函数 | 分享（roots, ids, outDir, opts{name?, version?, owner}）：每个 id 经 resolveAnt 两级找（项目级先）→ 四核 → 拷可分发面 → 写 package.json → 返回 ShareAntsResult;任一核不过抛,不写 | AntPacker ^anc-hopant-share | stable |
| `scanCredentials` | 函数 | 凭证扫描（text, ctx{file, kind}）→ {rejected % [CredentialHit], warnings % [CredentialHit]}：三层证据综合研判——第 1 层已知厂商形态单独即拒;第 2 层高熵与第 3 层键名提示+值形态单独只警告、同值叠加即拒;围栏/注释/示例文件降一档（第 1 层不降）。启发式,不保证无漏（作者定 2026-10-09） | AntPacker ^anc-hopant-share | stable |
| `CREDENTIAL_SCAN_DISCLAIMER` | 常量 | 凭证扫描免责句（响应字段 / driver 念给用户 / 错误说明三处同一句;tests 消费）——0142 子卡 E 遗留漏登,2026-10-10 review 补 | AntPacker ^anc-hopant-share | stable |
| `isLocalFace` | 函数 | （relPath）→ bool：ant 根下顶层 `inner_store/` 或任意深度 `*.orig.md` 为本机面——applyInstall 与 shareAnts 共用同一判法（从 applyInstall 抽出） | AntInstaller ^anc-hopant-install / AntPacker ^anc-hopant-share | stable |
| `hopantError` | 函数 | 全部错误码的统一出口（message 固定为 `码: 说明` 形态）,cli 的 NOT_FOUND 也经它 | provisional |
| `InstallPlan` / `InstallResult` / `AdaptEnv` / `AdaptReport` / `AdaptStamp` / `SourceKind` / `RunDepsEnv` / `RunDepsReport` / `ReconcileReport` / `PackAntResult` / `BodyUsage` / `CredentialHit` / `CredentialScan` / `ShareAntsResult` | 类型 | 上述函数的入参与返回形状 | provisional |

## 关键决策【决策】

**决策 1：hop 目录两级——用户级 `~/.hopjit/`、项目级 `<项目>/hop_tasks/`,HopAnt 住各自的 `ants/<id>/`。**（2026-10-10 作者定"应该有项目级 hopant 位置",改写 2026-10-06 的一级版本）概念层说"装在 hop 自己的目录下",本库 hop 自己的目录有两个：用户级 `~/.hopjit/`（`config.yaml` 住那里,跟人走,所有项目可用）与项目级 `hop_tasks/`（/hop 的一切住这一个家——活跃任务卡、archive/、ants/,作者 2026-08 定"项目根不另开目录,太污染";它在 .gitignore 里,与任务卡同命——项目级 HopAnt 是这个项目自己总结出来的流程,要给队友走分享）。两级同一布局（`ants/<id>/` 下的结构一字不差）,只是根不同。谁落哪级：**总结**（/hop distill,干完的活 → HopAnt）落项目级——它是这个项目的产物;**安装**别人的 HopAnt 缺省用户级（装进来是给自己用）,用户说"只在这个项目里用"落项目级。`home` 与项目根都由调用方传入,模块内不调 `homedir()` / `process.cwd()`。适配核的注册面含 `<cwd>/hopjit.yaml` 项目级一层,而适配戳不记 cwd——同一个 HopAnt 在不同项目目录下 `ant adapt` 可能得到不同报告,戳以最后一次全绿为准;这与"配置随项目叠"的两级配置语义一致,不另加项目级戳。

**决策 9：两级查找序 = 项目级先于用户级,同 id 项目级遮住用户级;列表合并并标 scope。**（agent 自决策 1 推演,2026-10-10 commit 1455d173 记录,作者未反对）与两级配置"项目级赢"同向。理由：项目级是"这个项目自己总结的、为这个项目改过的"版本,离当前意图最近;用户级是"通用的"版本。遮蔽只影响按 id 找（分派命中、`call <id>`、adapt / remove / bootstrap 的 id 参数）——`ant list` 两级都列、每行带 `scope`,同 id 两行都在,用户看得见被遮的那个。`remove` 按 id 删的是查找到的那一个（项目级在就删项目级）,要删被遮的用户级那份,先删项目级或显式传 scope。安装撞 id 只在**同一级**内判（项目级装一个与用户级同 id 的 HopAnt 是合法的遮蔽,不是冲突）。索引每级一份 `ants/index.md`,各自从各自的 ants/ 重建;/hop 分派读两份（先项目级）。

**决策 2：安装全或无。** 一个来源目录里有几个 HopAnt 就装几个,其中任何一个与已装的撞 id,整单拒绝、一个都不写——半装的状态比不装更难收拾（用户看到索引里多了两个少了一个,不知道哪个是这次的）。撞 id 怎么办归用户：删旧的再装,或者改来源目录里的 id（文件名与 Id 字段一起改）。本版不做交互改名。

**决策 3：来源里的本机面一律丢弃。** 概念层定"安装时三条通道都丢弃来包里带的 inner_store/",`*.orig.md` 同属本机面。目录拷贝时发送方常忘删,本模块在拷贝那一步按名跳过,不依赖发送方。

**决策 4：bootstrap.js 本模块不执行。** 安装计划里只标记"这个 ant 带 bootstrap.js",跑 `--dry-run` 与真跑都是 CLI 层的事（`ant bootstrap <id>`,spawn 子进程）——模块纯函数、无子进程的边界由此守住;概念层"先 dry-run 呈计划、用户同意再执行"的顺序由 CLI 与 /hop 保证。

**决策 5：适配戳本版落 `inner_store/adapt.yaml`。** 概念层只说"记在 inner_store"。0144 的 SQLite 机制还没有,先用一个 YAML 文件承载;0144 落地时迁移,接口 `readStamp/writeStamp` 不变。

**决策 8：归属标识自动生成,不问人;打包时明示并问要不要改,答过就落盘;可加参数跳过。** 作者定 2026-10-06。`ownerId` 由 git 用户名（`git config user.name`,**按工作区目录读**——MCP 下 server 进程 cwd 不一定是工作区,2026-10-10 review 抓 spawnSync 未传 cwd）、否则登录名与主机名现算出缺省值;`~/.hopjit/config.yaml` 的 `owner_id` 键一旦有值就恒用它（人改过一次不能下次再问,所以必须落盘）。读的一侧现在就有：CLI `localOwnerId` 先读 `owner_id`,没有才现算。写的一侧在分享（子卡 E,2026-10-09 落地）：`hopjit ant share` 不自己问人——CLI 不接终端对话,问归 /hop driver;取值顺序 `--owner <值>` > config.yaml 已落盘的 `owner_id`（在场即用,**不问**——这就是"答过不再问"的落码,2026-10-09 review 抓出此前 hop-cli 条文写成"没带旗仍问"与本决策相反）> `--yes`（首机无落盘值时跳过询问用现算值）> 都缺且首机 → 响应 `owner_prompt_required: true` 带缺省值返回、不写包,driver 在对话里问用户再带 `--owner` 重跑（一台机器只会问这一次）;成功写包后把用的值写回 `~/.hopjit/config.yaml` 的 `owner_id`（只动这一键）。参数名曾写 `--branch-id`,随 v0.2.3 改名 ownerId 一并改为 `--owner`。适配戳与谱系用的都是同一个来源,所以戳里的分支在打包确认前后可能从现算值变成人改的值——那一次 `ant list` 会报 stale,重走一遍只读的配置适配即可。模块 `ownerId` 仍是纯函数,读写 config 都在组合根。

**决策 6：命令在不在按 PATH 实查,不按名字集合比对。** 引擎起跑时的 `requires_commands` 预检是"卡上声明的命令名 ⊆ 宿主白名单 ∪ 卡上前缀首项"的集合比对（engine.ts initExecution）——那是授权核对。适配要回答的是另一个问题："这台机器装了没有"（概念层适配表"可执行文件在不在 PATH"）,所以对《已批准命令》每条前缀的首项,在传入的 PATH 目录列表里逐个找同名可执行文件。两个判法回答两个问题,不合并。

**决策 7：标准工具不算适配缺口。** 作者定（2026-10-06）"websearch 应该视为标准工具"。**标准工具**指名字与签名由 hop 定、每台装了 hop 的机器都有办法落实的工具，现只有 `web_search` 一个，名单是共享层常量 `STANDARD_TOOL_NAMES`（`provider-types.ts`）。落实方式按执行模式分两种：复用模式由 caller 用自带的网页检索落实，不需要注册，也不需要引擎侧凭证（[[prompt-assembler#^anc-exec-tool-manifest-source]] 第 4 条，2026-08-31 已定）；独立模式由 `tool_servers` 里 `tool_id: web_search` 的那条注册落实，后端可换（`examples/hoptools-websearch.yaml`）。适配时还不知道之后用哪种模式跑，所以标准工具没注册时不进 `tools.missing`、不让 `ok` 变假，只在 `notes` 里写一句"复用模式可直接用；要用独立模式跑，先注册它"。参数对账照做：标准工具已注册时，Tools 段声明的参数仍要过 `reconcileTools`，注册面签名不符照样报 `tools.errors`。为什么不把标准工具做成引擎内建件：检索要连外部服务、要凭证，后端选择属于用户，内建会把一个具体后端绑进引擎。

## HopAntHome：hop 目录与索引【契约】 ^anc-hopant-home

```
HopType: HopAntHome
  # 一台机器上 HopAnt 的家：两级根的路径约定、按 id 查找、本机索引。无状态纯函数集——home / 项目根逐函数传入,不读进程环境
  Fields: （无）
  Specs:
    antRoots(
      home % line,              # 用户主目录绝对路径
      projectDir % line         # 项目根绝对路径（/hop 的工作区;cli 为 cwd,mcp 为 workspace_dir）
    ) -> roots % AntRoots       # {project: `<projectDir>/hop_tasks/ants`, user: `<home>/.hopjit/ants`}
    antsRoot(
      home % line               # 用户主目录绝对路径
    ) -> root % line            # `<home>/.hopjit/ants`——用户级根,与 antRoots(...).user 同值（旧名保留给只认用户级的调用方：演示件安装、备份位上溯）
    antDir(
      root % line,              # 某一级 HopAnt 根（roots.project 或 roots.user）
      id % line                 # HopAnt id,即目录名
    ) -> dir % line             # `<root>/<id>`
      # 约束：id 不合法抛 HOPANT_BAD_ID。合法 = 首字符小写字母或数字,其余小写字母、数字、连字符、下划线、点（npm 包名字符集）;大写、空串、路径分隔符、`..` 都不合法
    resolveAnt(
      roots % AntRoots,
      id % line
    ) -> hit % yaml | null      # {dir % line, scope % line（project | user）};两级都没有返回 null
      # 约束：id 不合法抛 HOPANT_BAD_ID（经 antDir,与 planInstall / removeAnt 同律）——不合法的 id 装不进来,查找时直接拒不返回 null
      # 决策 9：项目级先于用户级,同 id 项目级遮住用户级。"在场"判据与 listAntsIn 同——目录下有 `<id>.md` 入口 spec 才算
      1. [条件(roots.project/<id>/<id>.md 存在)] 返回 {dir: roots.project/<id>, scope: project}
      2. [条件(roots.user/<id>/<id>.md 存在)] 返回 {dir: roots.user/<id>, scope: user}
      3. 返回 null
    indexPath(
      root % line               # 某一级 HopAnt 根
    ) -> path % line            # `<root>/index.md`
    listAntsIn(
      root % line               # 某一级 HopAnt 根
    ) -> ids % [line]           # 该级已装 HopAnt 的 id,升序;根不存在返回空
      # ants/ 下每个含 `<目录名>.md` 的子目录算一个;没有入口 spec 的目录不算（半拷贝残留）
    listAnts(
      roots % AntRoots
    ) -> ants % [yaml]          # 两级合并,每项 {id, scope, dir};项目级全部在前、用户级在后,各自升序;同 id 两条都在（用户看得见被遮的那个）
    specTitle(
      rawTitle % line           # parser 返回的 header.title（含 `Spec: ` 前缀）
    ) -> title % line           # 去掉前缀后的标题本体,索引与 `ant list` 共用
    rebuildIndex(
      root % line               # 某一级 HopAnt 根
    ) -> count % int            # 写入的条目数
      # 重建该根的 index.md——/hop 分派时只读这两张表（先项目级）,不逐个读 spec（概念层③"筛选不许浪费主对话注意力"）;install / remove 只重建被改动的那一级
      1. ids = listAntsIn(root)
      2. 对每个 id：parseSpec 读 `<id>/<id>.md` 的 header,取 specTitle(title) 与 goal 的第一行;解析出错的条目写 `- <id> — （入口 spec 解析失败）`,不中断
      3. 写 index.md：首行 `# HopAnt 索引（由 hopjit ant 维护,勿手改）`,然后每 ant 一行 `- <id> — <title> — <goal 首行>`;ids 为空且 index.md 不存在时不建目录不写文件（项目级根多数项目没有,不无故在项目里长出 hop_tasks/ants/）
      4. 返回条目数
```

```
HopSchema: AntRoots
  # 两级 HopAnt 根（决策 1 / 9）
  - project % line            # `<项目根>/hop_tasks/ants`——这个项目总结出的、或用户指明只给这个项目装的 HopAnt
  - user % line               # `<home>/.hopjit/ants`——装进来给自己用的 HopAnt,所有项目可见;恒由 antsRoot(home) 构造（removeAnt 的备份位靠它上溯两级得到 home,别的形态会算错）
```

**索引格式** ^anc-hopant-index：一行一个 HopAnt,三段用 ` — `（空格、em dash、空格）分隔：`- <id> — <入口 spec 的 # Spec: 标题> — <Goal 第一行>`。Goal 缺席写 `（无 Goal）`。每级根各一份 index.md,都是派生物,任何时候可以从各自的 ants/ 目录重建;install、remove 与直落某级根的 pack 三个改动入口的最后一步都重建被改动那一级的,不做增量改写（pack 一支 2026-10-11 补——此前漏了,项目级总结件封完索引空表,分派命中不了）。/hop 分派读两份：先 `<项目>/hop_tasks/ants/index.md` 再 `~/.hopjit/ants/index.md`,同 id 以项目级为准（决策 9）。

## AntInstaller：来源识别、安装、卸载【契约】 ^anc-hopant-install

```
HopType: AntInstaller
  # 把一个本地目录里的 HopAnt 装进 hop 目录。只拷可分发面,全或无,不执行任何脚本
  Specs:
    detectSource(
      srcDir % line             # 来源目录绝对路径
    ) -> kind % line,           # single（单 ant 目录）/ package（HopAnt 包根）/ invalid
         antDirs % [line]       # 各 HopAnt 目录绝对路径（single 时就是 srcDir 自己）
      # 判来源目录是什么
      # 约束：两种形态同时满足时按 package（包根不会自带入口 spec,撞上说明目录混放,宁取显式结构）
      1. [条件(存在 `<srcDir>/ants/` 且其下至少一个子目录含 `<子目录名>.md`)] kind = package,antDirs = 这些子目录
      2. [条件(存在 `<srcDir>/<basename(srcDir)>.md`)] kind = single,antDirs = [srcDir]
      3. [条件(其他)] kind = invalid,antDirs = []

    planInstall(
      srcDir % line,            # 来源目录绝对路径
      root % line               # 装到哪一级的根（roots.user 或 roots.project,由调用方按 scope 选——缺省用户级,决策 1）
    ) -> plan % InstallPlan     # 安装计划,不写盘
      # 生成安装计划。CLI --dry-run 直接把它呈给用户
      # 约束：kind=invalid 抛 HOPANT_SOURCE_INVALID;任一 ant 的入口 spec 解析失败抛 HOPANT_SPEC_INVALID（带文件与首条错误）;id 与 Id 字段不一致抛 HOPANT_ID_MISMATCH;目录名不是合法 id 抛 HOPANT_BAD_ID（经 antDir）
      1. kind, antDirs = detectSource(srcDir)
      2. 对每个 antDir：id = basename(antDir);parseSpec 读 `<antDir>/<id>.md`,核 header.id 等于 id（缺 Id 字段视为一致——文件名即 id）
      3. 对每个 ant：dst = antDir(root, id);conflict = dst 已存在（只在**本级**判——另一级有同 id 是合法遮蔽,不是冲突,决策 9）;hasBootstrap = 存在 `<antDir>/bootstrap.js`
      4. plan.ok = 没有任何 conflict;plan.ants = [{id, src, dst, conflict, hasBootstrap}];plan.source_kind = kind;plan.root = root

    applyInstall(
      plan % InstallPlan        # planInstall 的产出
    ) -> result % InstallResult # 装了谁、跳过了什么、谁带 bootstrap
      # 按计划落盘。撞 id 时全或无：plan.ok 为 false 直接抛 HOPANT_ID_CONFLICT 列出撞的 id,一个都不写。拷贝中途 IO 失败不回滚,留下的半装目录由人清（listAnts 不会把没有入口 spec 的半装目录算进去）
      1. [条件(plan.ok 为假)] 抛 HOPANT_ID_CONFLICT
      2. 对每个 ant：递归拷贝 src → dst,**跳过** ant 根下的 `inner_store/` 目录（只看顶层——按布局它只住根,深层同名目录不是本机面）与任意深度的 `*.orig.md` 文件（本机面不进来,决策 3）
      3. 对每个 ant：建 `<dst>/inner_store/`（空目录）
      4. rebuildIndex(plan.root)
      5. result.installed = ids;result.skipped_local_files = 实际跳过的路径列表,每项 `<id>/<相对 ant 根的路径>`（用户能看到丢了什么）;result.bootstrap_pending = 带 bootstrap.js 的 id 列表（提醒去跑 `ant bootstrap`）

    removeAnt(
      roots % AntRoots,
      id % line,                # 要卸的 HopAnt id
      keepStore % bool,         # 真=先把 inner_store/ 挪到备份位再删
      scope? % line             # project | user;缺省按 resolveAnt 找到的那一级（项目级在就删项目级,决策 9）
    ) -> removed_scope % line | null   # 删了哪一级（project | user）;null=本来就没装（hop-admin 据此填响应 scope 并折成 removed 布尔）
      # 卸载。备份位恒 `<home>/.hopjit/ants-store-backup/<id>/`（两级共用——home 由 roots.user 上溯两级得到;概念层"inner_store 留不留问用户"的留一边）
      # 约束：id 不存在返回 null 不抛;id 不合法抛 HOPANT_BAD_ID（经 antDir）
      1. dir = scope 在场 ? antDir(roots[scope], id) : resolveAnt(roots, id)?.dir;[条件(dir 缺或不存在)] 返回 null
      2. [条件(keepStore 且 inner_store/ 存在)] 挪 inner_store/ 到备份位（已有同名备份先删旧的）
      3. 删 dir
      4. rebuildIndex(dir 所在的根);返回 dir 所在的 scope
```

**InstallPlan / InstallResult 的字段**：

```
HopSchema: InstallPlan
  # 安装计划（planInstall 产出,applyInstall 消费;--dry-run 原样呈给用户）
  - root % line               # 装到哪一级的根（applyInstall 末尾 rebuildIndex 要用;读它就知道落的是项目级还是用户级）
  - source_kind % line        # single | package
  - ok % bool                 # 没有撞 id
  - ants % [yaml]             # 每项 {id, src, dst, conflict % bool, hasBootstrap % bool}

HopSchema: InstallResult
  # 安装结果：装了谁、跳过了哪些本机面文件、哪些 ant 带 bootstrap.js 等用户决定
  - installed % [line]        # 装进去的 id
  - skipped_local_files % [line]   # 被跳过的本机面路径,每项 `<id>/<相对 ant 根的路径>`
  - bootstrap_pending % [line]     # 带 bootstrap.js、等用户决定跑不跑的 id
```

## AntAdapter：配置适配与适配戳【契约】 ^anc-hopant-adapt

概念层生命周期②把适配分两档：配置适配不改 spec,逻辑适配改 spec。本模块做配置适配的**核与报告**——把入口 spec 头声明的四类依赖逐个对这台机器核一遍,缺什么、怎么补,写成一张报告;报告全绿才写适配戳。修配置、导凭证、跑 bootstrap 都是用户或 /hop 的动作,模块不替做。

```
HopType: AntAdapter
  # 对一个已装 HopAnt 核本机依赖。四项全由入口 spec 文件头推出,机器侧事实全由 env 参数传入
  Specs:
    adapt(
      antDir % line,            # 已装 HopAnt 的目录绝对路径
      env % AdaptEnv            # 机器侧事实（组合根取好传入）
    ) -> report % AdaptReport   # 四项核验结果与补法提示
      # 四项核验：工具在不在注册面、凭证环境变量在不在、命令在不在 PATH、引擎版本够不够
      # 约束：入口 spec 解析失败抛 HOPANT_SPEC_INVALID;不写盘——写戳是调用方看 report.ok 后另调 writeStamp
      1. header = parseSpec(`<antDir>/<id>.md`).header
      2. 工具（与 checkRunDeps 共用内部函数 splitToolNeeds,两处判据不分叉）：needs = header.tools ?? [];available = env.tool_servers 展开成 {name, tool_id, input_schema, requires_commit} 列表;**先按 name / tool_id 算 unregistered = needs 里不在 available 的工具名**,再按 STANDARD_TOOL_NAMES 分两堆：标准工具（现只有 web_search,决策 7）→ tools.standard_unregistered 只进 notes 不算缺口,其余 → missing;再把 needs 里已注册 的那部分传给 ExecutionEngine.reconcileTools(needs', available),errors 与 warnings 直取其返回值——不解析引擎的错误文案（引擎改措辞这里不受影响）;report.tools = {missing, errors, warnings}
      3. 凭证：对 needs 里每个工具,找它所属 server 的 `binding.auth_env`;再加 env.providers 每项的 `api_key_env`;去重后逐个查 env.env_vars 里有没有非空值;report.credentials = {required: 全部名字, missing: 缺的名字}
      4. 命令：对 header.approved_commands 每条前缀取首项,在 env.path_dirs 逐目录找同名文件且可执行（恒另查 `.exe` / `.cmd` 两个后缀,非 Windows 上多查无害;首项本身带路径分隔符的直接按该路径查可执行位,不扫 PATH）;report.commands = {required, missing}
      5. 引擎：required = header.config.engine_min_version;current = env.engine_version;report.engine = {required, current, ok: 缺 required、或 current 为 null（调用方取版本失败——CLI 侧用 engine 的 getEngineVersion,读失败返 null,与引擎起跑的 fail-open 同律;不许用 '0.0.0' 之类占位值,那会把一切 engine_min_version 判成引擎过低）、或 current >= required（semver 三段比,非 semver 串按缺席不拦）}
      6. report.ok = 四项都没有缺口（tools.standard_unregistered 不算缺口）;report.hints = 每个缺口一句怎么补（工具缺→"在 ~/.hopjit/config.yaml 的 tool_servers 注册,或写映射";凭证缺→"export <名>=…";命令缺→"安装后确认在 PATH;该 ant 带 bootstrap.js 时先 hopjit ant bootstrap <id>";引擎低→"npm i -g @hoplogic/hopjit@latest";工具声明本身有问题〔参数不在注册面、requires_commit 失实〕→ 原样转述对账错误）

    adaptState(
      antDir % line,            # 已装 HopAnt 的目录绝对路径
      owner % line             # 本机归属标识
    ) -> state % line           # never（没有戳）/ stale（戳在但分支或头哈希不符,含入口 spec 读不出来）/ adapted
      # `ant list` 的三态只在这里判,CLI 不另写分支
      1. stamp = readStamp(antDir);[条件(stamp 为 null)] 返回 never
      2. hash = headerHash(读 `<id>.md`);读失败或解析失败按 hash = 空串
      3. 返回 needsAdapt(stamp, owner, hash) ? stale : adapted

    # ---- 适配戳四件 ----
    ownerId(
      gitUserName % line,       # `git config user.name` 的值,取不到传空串
      loginName % line,         # 本机登录名,取不到传空串
      hostname % line           # 主机名,取不到传空串
    ) -> id % line              # `<用户>-<主机>`
      # gitUserName 非空用它,否则 loginName,两者都空用 `user`;hostname 空用 `host`。空格与路径分隔符替换为连字符
      # 约束：本函数只算缺省值,不读不写文件;读 config.yaml 的 owner_id 与打包时的问与写回归组合根（决策 8,写回在子卡 E）
    headerHash(
      specText % text           # 入口 spec 文件全文
    ) -> hash % line            # sha256 前 12 位十六进制
      # 入口 spec 头的内容哈希,只覆盖适配核过的三段——正文改了不触发重新适配。这个值持久化进适配戳并跨版本比对,算法细节是兼容性契约：
      1. 段识别**复用 parser 的段切分**（spec-parser 的 identifySections,经导出函数 sectionSpans 取 {kind, startLine, endLine}）——parser 认什么段头这里就认什么：英文 `## Tools` / `## Approved Commands` / `## Config`、中文 `## 工具` / `## 已批准命令` / `## 配置`、以及内联标签形 `Tools:` / `Config:`。不自写段头正则（与定位节 ② "不另造清单格式"同律;v0.1.0 曾自写,中文段头与内联形下改了工具哈希不变——review 实跑抓出）
      2. 按 tools → approved_commands → config 顺序取各段原文,段不存在算空串;每段 trim
      3. 三段用 `\n---\n` 拼接,sha256,取前 12 位十六进制
    readStamp(
      antDir % line             # 已装 HopAnt 的目录绝对路径
    ) -> stamp % AdaptStamp     # 可为 null：文件不存在、YAML 解析失败、或缺 owner / hash 字符串字段
      # 读 inner_store/adapt.yaml
    writeStamp(
      antDir % line,            # 已装 HopAnt 的目录绝对路径
      stamp % AdaptStamp        # 要写的戳
    ) -> path % line            # 写到的文件路径
      # 写 inner_store/adapt.yaml（目录不存在先建）
    needsAdapt(
      stamp % AdaptStamp,       # readStamp 的返回,可为 null
      owner % line,            # 本机归属标识
      hash % line               # 当前入口 spec 的头哈希
    ) -> needed % bool          # 真=要重新适配
      # stamp 为 null → 真;stamp.owner ≠ owner（目录是别的机器拷来的）→ 真;stamp.hash ≠ hash（spec 头被升级或改过）→ 真;否则假
    backupOrig(
      antDir % line             # 已装 HopAnt 的目录绝对路径
    ) -> created % bool         # 假=`.orig.md` 已存在,没动
      # 逻辑适配前备份：`<id>.md` 拷成 `<id>.orig.md`;已存在不覆盖（概念层"之后不再碰 .orig.md"）
```

**适配戳** ^anc-hopant-stamp：

```
HopSchema: AdaptStamp
  # 适配戳（inner_store/adapt.yaml）：归属标识 @ 入口 spec 头哈希 + 当时的报告
  - adapted % line          # `<归属标识> @ <头哈希>`——概念层定的一行形态,人读
  - owner % line           # 归属标识单独一份,机读
  - hash % line             # 头哈希单独一份,机读
  - at % line               # ISO 时间
  - report % yaml           # 适配时的 AdaptReport 全文（重跑时只补缺的,要有上次的账）
```

```
HopSchema: AdaptEnv
  # 机器侧事实,全部由调用方取好传入
  - tool_servers % [yaml]   # 两级合并后的 tool_servers 条目（ToolServerEntry[]）
  - providers % [yaml]      # 两级合并后的 providers 条目（只用 api_key_env）
  - env_vars % yaml         # 环境变量表（名 → 值）
  - path_dirs % [line]      # PATH 拆开的目录列表
  - engine_version % line   # 当前 hopjit 版本;取不到传 null（不许占位串）

HopSchema: AdaptReport
  # 配置适配报告：四项核验各自的 required / missing + 每个缺口一句怎么补
  - ok % bool               # 四项都没有缺口（tools.standard_unregistered 不算缺口）
  - tools % yaml            # {missing % [line], standard_unregistered % [line], errors % [line], warnings % [line]}——missing 是缺口;standard_unregistered 是没注册的标准工具,不算缺口（决策 7）
  - credentials % yaml      # {required % [line], missing % [line]}
  - commands % yaml         # {required % [line], missing % [line]}
  - engine % yaml           # {required % line, current % line, ok % bool}
  - hints % [line]          # 每个缺口一句怎么补
  - notes % [line]          # 不影响 ok 的提示,现只有"标准工具未注册时独立模式要先注册"一类
```

## 编排：分派、call 寻址与起跑依赖核【契约】 ^anc-hopant-orchestrate

概念层生命周期③（[[../concepts/HopAnt概念#^anc-struct-hopant-lifecycle]]）:HopAnt 走 /hop 既有分派里"一份现成 spec"那一路,不加新路;`call <ant-id>` 与 call 一份普通 spec 零区别。本节把这两句落成三件事——/hop 怎么找到它、call 怎么找到它、跑之前核什么。todo/0142 子卡 B,方案作者 2026-10-07 定。

**分派协议**（driver 侧,三载体 /hop 的"0. 分派"节;本模块提供材料不做判断）：
1. 用户说的活不是一句话能答完的,先读两张索引（[[#^anc-hopant-index]],一行一个 HopAnt）：先 `<项目>/hop_tasks/ants/index.md`（这个项目总结出的流程）,再 `~/.hopjit/ants/index.md`（装进来的）;同 id 以项目级为准（决策 9）。命中某个 HopAnt 的标题或 Goal → 走它的入口 spec `<命中那一级的根>/<id>/<id>.md`,按"一份现成的 HopSpec 文件"那一路跑;没命中再走升格主路。两张索引都不存在就是没有任何 HopAnt,跳过。此前 /hop 另扫 `hop_tasks/specs/` 找"提纯件"当底稿——2026-10-10 总结直接成 HopAnt 后那一步并入这里,`hop_tasks/specs/` 退役。
2. 跑之前看适配状态：`ant_list` 工具（命令行 `hopjit --json ant list`）里该 id 的 `adapt_state`（两级都列,带 scope;同 id 看项目级那行）。`adapted` 直接跑;`never` / `stale` 先 `ant_adapt`（`hopjit --json ant adapt <id>`,按 id 两级找,项目级先）——全绿（写了戳）就跑,有缺口把报告的 hints 告诉用户,补齐前不跑。
3. 工作区是用户发起 /hop 时所在的项目目录（定位节 ②c）。复用模式在项目目录里跑 `hopjit run <入口 spec 绝对路径>`,工作区取 cwd;独立模式 `start_run` 显式传 `workspace_dir=<项目目录>`——server 的 cwd 不一定是项目。

**call 寻址** ^anc-hopant-callee-resolve：

```
HopType: CalleeResolve
  Specs:
    resolveCalleeSpecPath(
      callerDir % line,         # 调用方 spec 文件所在目录绝对路径
      roots % AntRoots | null,  # 两级 HopAnt 根;null 时只查第一级（内存态 / 旧调用方）
      calleeId % line           # call 的目标 id（已解引用）
    ) -> path % line            # callee spec 文件绝对路径;找不到返回 null
      # 两个模式同一规则、同一实现:独立模式 DirSpecProvider（[[shared-providers#^anc-provider-spec-default]]）与复用模式引擎注册位（[[exec-engine#^anc-exec-callee-resolver]]）都调本函数
      1. calleeId 为空、含 `/` 或 `\`、或含 `..` → 返回 null（名字就是名字,不是路径）
      2. p1 = `<callerDir>/<calleeId>.md`;文件存在 → 返回 p1
      3. roots 非 null 时 p2 = `<roots.project>/<calleeId>/<calleeId>.md`;文件存在 → 返回 p2
      4. roots 非 null 时 p3 = `<roots.user>/<calleeId>/<calleeId>.md`;文件存在 → 返回 p3（决策 9：项目级先于用户级）
      5. 返回 null
```

- 同目录优先：HopAnt 自己的内部子 spec 与某个已装 HopAnt 同名时,内部子 spec 生效。
- 第 3 步不校验 HOPANT_BAD_ID 的字符集:那是安装时的准入规则,寻址只负责防穿越;不合法的 id 装不进来,自然也找不到。
- 两个消费点:引擎拿到的是组合根绑好的闭包 `(callerSpecPath, id, workspaceDir) => resolveCalleeSpecPath(dirname(callerSpecPath), antRoots(homedir(), workspaceDir), id)`（项目根=本实例的 workspace_dir,引擎从 hostConfig 取后传给闭包,[[exec-engine#^anc-exec-callee-resolver]]）;DirSpecProvider 的 `pathOf` / `resolve` 直接调本函数（dispatcher 与 hopant 同在层 2,同层 import 不越层,规则只此一份实现）。

**commit 批准账位置** ^anc-hopant-commit-store：

```
HopType: CommitApprovalStoreLocate
  # commit 批准账与 dirs 批准账的位置规则:spec 在已装 HopAnt 目录里时账跟着 HopAnt 走,否则放在 run 根的上一级
  Specs:
    commitApprovalStorePath(
      roots % AntRoots,         # 两级 HopAnt 根（项目根=本实例 workspace_dir）
      specPath % line,          # 本实例 spec 文件绝对路径
      runRootParent % line      # 本实例 run 根目录的上一级（通常就是 .hopstate 绝对路径）
    ) -> path % line            # 批准账文件绝对路径
      # 引擎批准闸的位置规则（[[exec-engine#^anc-exec-commit-approval]]）只此一份实现,cli 与 mcp-server 两个组合根注册的闭包都调它
      # 约束:specPath 由引擎按 canonicalSpecPath 传入,已解析软链;两级根都必须按同一口径解析软链后再比较——HOME 本身经软链时（macOS 临时目录 /var → /private/var、Linux 上 /home 指向别的盘）,一边解析一边不解析就比不出前缀,HopAnt 的账会错落到 run 根上一级
      1. 对 root 依次取 roots.project、roots.user（决策 9 顺序;两级都试,命中即返回）：root' = realpath(root),目录不存在时用原值
      2. rel = relative(root', specPath)
      3. rel 不以 `..` 开头、不是绝对路径、且至少两段（`<id>/<文件>`）→ 返回 `<root'>/<rel 第一段>/inner_store/commit_approvals.json`
      4. 两级都不命中返回 `<runRootParent>/commit_approvals.json`
    dirsApprovalStorePath(
      roots % AntRoots,         # 同上
      specPath % line,          # 同上
      runRootParent % line      # 同上
    ) -> path % line            # dirs 批准账文件绝对路径（[[exec-engine#^anc-exec-dirs-grant]]）
      # 与 commitApprovalStorePath 同一位置规则,只换文件名 `dirs_approvals.json`——两类批准粒度不同（commit 按步骤+body,dirs 按整份清单）,分文件零歧义。运行时引擎拿注册位给的 commit 账路径在同目录换名（[[exec-engine#^anc-exec-dirs-grant]] 授权账条）,组合根不直调本函数;本函数是那条规则的具名真身,测试断言与审计对照用,与引擎换名结果必须相等（hopant.test 钉）
```

**起跑依赖核** ^anc-hopant-run-deps：作者 2026-10-07 定"按 agent 有的那几个标准工具来算即可,其他的要么是 mcp,要么是 hopant,都没有就应该报错"。复用模式下宿主 agent 拿着自己的全部工具干活,引擎不经手——Tools 段写了什么,复用模式其实都"能跑";但换到独立模式或另一台机器就断。起跑核把这件事提前到第一步之前:Tools 段与 call 目标必须是 hopjit 看得见的东西。

```
HopType: RunDepsCheck
  Specs:
    checkRunDeps(
      specText % text,          # 入口 spec 全文
      specPath % line,          # 入口 spec 文件绝对路径（call 寻址的基准）
      env % RunDepsEnv          # 机器侧事实,组合根取好传入
    ) -> report % RunDepsReport
      # 约束:不写盘、不起子进程;入口 spec 解析报 error 时返回 ok=true 空报告——解析错误归引擎 init 报,这里不抢
      1. queue = [(specText, specPath)];visited = {specPath}
      2. 逐个取出 (text, path):
         2a. ast = parseSpec(text);解析报 error 的跳过（入口那份按约束返回,callee 那份记一条 calls.unreadable）
         2b. 工具:splitToolNeeds(ast.header.tools, env.tool_servers) → missing 进 tools.missing（每条带 spec 名）、errors/warnings 进同名字段;标准工具没注册的不算缺口（与 adapt 同,AntAdapter 决策 7）
         2c. call:遍历全树（getChildren 递归）取每个 call 步骤的 callee_spec_id——动态 callee（callee_expr）跳过,起跑时求不出值
             - p = resolveCalleeSpecPath(dirname(path), env.roots, id);p 非 null 且不在 visited → 读文件入 queue、加入 visited（同目录 → 项目级 HopAnt → 用户级 HopAnt,决策 9）
             - p 为 null:id 是已注册工具名（tool_servers 展开后 name 或 tool_id 相等）或标准工具 → 通过（call 也可以调工具,[[step-dispatcher#^anc-exec-call-tool]]）;否则进 calls.missing（带调用方 spec 名与步骤号）
      3. ok = tools.missing、tools.errors、calls.missing、calls.unreadable 全空
      4. hints:工具缺 → "工具 <名> 没有注册:在 ~/.hopjit/config.yaml 或项目 hopjit.yaml 的 tool_servers 里注册它（宿主自己挂的 MCP 也要在这里注册一遍）,或改用 HopAnt 实现这一步";call 缺 → "call 目标 <id> 找不到:不是同目录的 spec,不是本项目或本机已装的 HopAnt,也不是已注册的工具——HopAnt 先装（/hop 安装 <目录>）,拼错了改 spec";errors 原样转述
```

```
HopSchema: RunDepsEnv
  - roots % AntRoots        # 两级 HopAnt 根（项目根=本 run 的工作区）
  - tool_servers % [yaml]   # 两级合并后的 tool_servers 条目（loadTwoLevelRegistry 的返回）

HopSchema: RunDepsReport
  - ok % bool
  - tools % yaml            # {missing % [line], standard_unregistered % [line], errors % [line], warnings % [line]}——条目形如 "<spec 名>: <工具名>"
  - calls % yaml            # {missing % [line], unreadable % [line]}——missing 条目形如 "<spec 名> 步骤 <号>: <id>"
  - hints % [line]
```

- **沿 call 树递归**:子实例起跑时不再核（call 子实例与并行 worker 由引擎派出,父实例起跑时已把整棵树核过）——一次核全,跑到一半才断的情形只剩动态 callee。
- **调用点**:cli 顶层 `run` 与顶层 `init`（[[hop-cli#^anc-cli-run-deps-gate]]）;MCP 独立模式不调——它有自己的两道（exec-engine ^anc-exec-tools-reconcile ①② 与 dispatcher 的 UNKNOWN_SPEC）。
- **后果**:Claude Code 里自挂的 playwright 之类 MCP,没在 hopjit 的 tool_servers 里注册,写进 Tools 段的 spec 在复用模式起跑就报错。这是有意的,依据见 [[exec-engine#^anc-exec-tools-reconcile]] ③。

## AntPacker：封装与分享【契约】 ^anc-hopant-pack

概念层生命周期⑤封装、⑥分享（[[../concepts/HopAnt概念#^anc-struct-hopant-lifecycle]]）与包格式（[[../concepts/HopAnt概念#^anc-struct-hopant-package]]）的实装。封装把一份 spec 收成一个可装的 HopAnt 目录,分享把若干已装 HopAnt 的可分发面收成一个 HopAnt 包目录——两者是生产侧相邻两步,同一 HopType。与 AntInstaller 对称：Installer 把目录拆进 home,Packer 把 spec 收成目录、把目录收成包。纯函数——spec 文本、来源与输出目录、home、归属标识全由组合根传入,模块不读 process.*。

**本批边界（作者 2026-10-09 定"C + E"）**：分发通道只做本地目录（包目录即产物,压缩归用户一条 `tar` 命令,引擎不包依赖）;不做 git/npm 通道;包根不写 `scripts.postinstall`（作者 2026-10-09 定"删 postinstall",概念层同步删——与 hopjit 自身撤钩子同一原则,不是留待）;不生成 SKILL.md 壳（概念说"可选",pack 壳定位归 F 清理）;谱系只有在场才写（D 演化未做,hop-fact-check 首次封装无谱系,包里不造空字段）。

### 封装：spec → HopAnt 目录

```
HopType: AntPacker
  # 封装与分享两组函数。约束:不读 process.cwd()/env/homedir——路径与归属标识由 cli.ts 传;只写 outDir 下的目标目录,不碰来源 spec 文件
  # 约束:头对账只认 AST,不用正则扫正文——与 checkRunDeps / headerHash 同一 parser 事实源;改写面（定位要删的条目行）没有 AST 行号可用,复用 parser 导出的 toolSigName / splitArgvPrefix 识别条目,不自写正则（2026-10-09 review：自写正则漏中文工具名与带引号命令,报告说删了正文没删）
  Specs:
    packAnt(
      specPath % line,          # 来源 spec 绝对路径（总结时是任务卡终态 spec 的改写稿,或 examples 下的 spec,不区分）
      outDir % line,            # 输出根目录;产物落 <outDir>/<id>/。**总结直接落项目级**（2026-10-10 作者定"总结成 hopant"）,分工三方：本函数只认传进来的 outDir;两个组合根（cli `ant pack --out` 与 mcp `ant_pack.out`）缺省都是 `<工作区>/ants`,不自动换成项目级根;driver 总结时**显式传** out=`<项目>/hop_tasks/ants`（即 roots.project）,产物就地成为活的项目级 HopAnt,不再经 install。封装给别人看、要放别处时 outDir 任意
      opts % yaml               # {id? % line 缺省取 spec 的 Id 行; assets? % [line] 随包拷进 ant 根的文件（spec 同目录相对路径或绝对路径）; indexRoot? % line 封装目标就是某级 HopAnt 根时由组合根传入该根,步 7 据此重建索引,缺省不重建; rewriteId? % yaml 组合根注入的 Id 行改写函数（cli.ts 的 rewriteSpecId;hopant 不能反向 import cli,缺省回退用同一正则的本地副本——两份正则同形是层规造成的必要重复）}
    ) -> result % PackAntResult
      1. id = opts.id ?? 解析出的 header.id;[条件(id 不合法——同 antDir 的 HOPANT_BAD_ID 判法)] 抛 HOPANT_BAD_ID
      2. parsed = parseSpec(读 specPath);[条件(errors 非空)] 抛 HOPANT_SPEC_INVALID
      3. report, newText = reconcileHeader(spec 文本)
      4. docs = header.doc_refs ∪ 各步 doc_refs 的 doc 去重;[条件(doc 名 normalize 后以 `..` 开头或是绝对路径)] 抛 HOPANT_DOC_MISSING 带"知识文件须在 spec 同目录或其子目录,先放进来再封装"——越界引用拷不进 ant 根,封装假绿产物装上后 share 必红;逐个在 spec 同目录找 `<doc>.md`（Obsidian 省后缀时补）;[条件(任一缺席)] 抛 HOPANT_DOC_MISSING 列出缺的——打包假绿是缺陷（与 hop-cli pack 的 0077 口径同）;opts.assets 逐个解析（spec 同目录相对或绝对）,[条件(任一不存在)] 同抛 HOPANT_DOC_MISSING;**存在性之外再核可读**（2026-10-11 todo/0159）：对 docs 与 assets 逐个 `accessSync(src, R_OK)`,[条件(任一读不出——权限不够、坏符号链接等)] 收齐后一次性抛 HOPANT_DOC_MISSING,报文列出读不出的文件与系统错误 message——文件在但读不出等同于拿不到材料,不新开错误码;不等到第 6 步 cpSync 才撞,那时目录已建了一半,拒绝路径就不再是零残留——**全部前置核在第 5 步之前完成,写盘后不再有拒绝路径**
      5. [条件(<outDir>/<id>/ 已存在且非空)] 抛 HOPANT_TARGET_EXISTS——封装不覆盖,要重封先删
      6. 写 `<outDir>/<id>/<id>.md` = rewriteId(newText, id)（Id / 标识 行改为 id;**原文没有 Id 行时在 `# Spec:` 标题行后插入一行 `Id: <id>`**——产物恒有 Id 行,share 核一才能严格比对;planInstall 的"缺 Id 视为一致"豁免是给手工目录留的,封装产物不走它）;docs 逐个拷到 ant 根同名（doc-ref 的解析基准是 spec 所在目录,拷到同目录引用不用改;`knowledge/` 子目录留给用户手放的非 doc-ref 附件）;opts.assets 逐个拷到 ant 根（目录递归拷）;**不建 inner_store/**（安装时建,封装产物是可分发面）
      7. [条件(opts.indexRoot 在场)] rebuildIndex(opts.indexRoot)——封装直落 HopAnt 根时重建该根的 index.md（2026-10-11 作者 `/hop 把天气查询总结` 实撞：pack 到 `hop_tasks/ants/` 后 index.md 仍是空表,/hop 分派只读索引,"就地成为活的项目级 HopAnt"落空）。indexRoot 由组合根判定：outDir 解析后等于 roots.project 或 roots.user 时传该根,否则不传（封装到别处的产物是待装目录,不是活的 HopAnt,索引归 install 重建）。这是"index.md 恒为派生物、谁改目录谁重建"（[[#^anc-hopant-index]]）在第三个改动入口上的落实——install / remove / pack 三者同律
      8. 返回 {id, dir, reconciled: report, docs_copied, assets_copied, index_rebuilt: indexRoot ?? null}

    reconcileHeader(
      specText % text           # 来源 spec 全文
    ) -> report % ReconcileReport,
         newText % text         # 只改了 Tools 段与《已批准命令》段的 spec 文本;两段都无改动时与原文逐字节相同
      # 头对账：声明面（header）与使用面（body + 授权行）比对,少补多删（概念⑤）。使用面两种来源：带 body 的 act/commit 步骤里的调用;任何步骤 `- 工具:` 授权行里的名字（经内建名单过滤,`*` 全量授权不是工具名跳过）。act free / reason 步没有 body,故无调用可扫——它们的工具面只由授权行表达
      1. parsed = parseSpec(specText);usage = collectBodyUsage(parsed.ast.steps)
      2. declaredTools = header.tools 的 name 集合;usedTools = usage.tools
         tools_added = usedTools − declaredTools。补入行形态分两种：标准工具（∈ STANDARD_TOOL_NAMES）写标准签名 `- web_search(query) -> result % yaml  # 封装对账补入（标准工具,签名由 hop 定）`——作者 2026-10-09 OK;非标准工具写占位 `- <name>(input) -> result % yaml  # 封装对账补入——正文调用了但 Tools 段未声明,请补参数签名` 加子条目 `  - input % text  # 待补`（parser 要求签名参数与子条目对应,裸 `(…)` 过不了 parse;参数签名机器推不出,留给人——**占位签名装机 adapt 会报参数不符,driver 见 reconciled.tools_added 非空须提醒用户改签名**）
         tools_removed = declaredTools − usedTools − STANDARD_TOOL_NAMES ∩ declaredTools（标准工具 web_search 在 free 步被调用方自带能力落实,正文无调用形态,**声明了就保留**）
      3. declaredCmds = header.approved_commands 各行首项集合;usedCmds = usage.commands
         commands_added = usedCmds − declaredCmds（补一行只含首项的前缀）;commands_removed = declaredCmds − usedCmds;usage.undetermined 非空时**不删任何命令行**（静态判不出的调用可能用了被删的前缀）,只在报告里列出
      4. [条件(四个增删集合全空)] 返回 report(全空) 与原文
      5. 用 sectionSpans 定位 `tools` 段与 `approved_commands` 段的行区间,整段重写（段头行保留,条目按"原有保留项 + 新增项"顺序;要删的条目用 parser 的 toolSigName(line) / splitArgvPrefix(line).tokens[0] 识别,顶层条目删除连带其缩进子行）;段不存在而有新增时,按概念核心规范的段序插入——Tools 插在 Outputs 段之后（找不到 Outputs 退到 Config / 已批准命令 / Steps 之前）、已批准命令插在 Steps 段之前
      6. 返回 report 与新文本

    collectBodyUsage(
      steps % yaml              # SpecAST.steps
    ) -> usage % yaml           # {tools % [line], commands % [line], undetermined % [line]}
      1. 递归遍历 steps（children / cases 的 children）;对每个步骤：[条件(step.tool_grants 在场)] tools ∪= grants 的 name 中**既不是 `*` 也不在 2.2 内建名单里的**（2026-10-09 review H-1：不过滤会把 `- 工具: read` 补进 Tools 段,封装产物在任何机器 adapt 与起跑闸都红——库内 deep-validate / hopbuild2 等五份 spec 实锤）
      2. [条件(step.body 在场)] 遍历 body.statements（assign 看 value、call 看 call、if 看 condition 与两分支递归）,对每个 CallExpr：
         2.1. [条件(callee == 'subprocess.run')] 第一参的 value 是 list_literal 且首元素是 string 字面量 → commands ∪= 该字面量;[其他] undetermined ∪= `<step_id>: subprocess.run 第一参非字面量`
         2.2. [条件(callee ∈ 内建名单)] 跳过——内建不是注册面工具。内建名单 = ACT_BUILTIN_NAMES（act-builtins）∪ validator 的 B2_BUILTIN_FILE_TOOLS（文件工具十一件 + 树编辑 special 六件 + run_script,引擎恒注册零声明的事实源,与 B2 规则同一份——不在 hopant 里另抄名单）∪ B2_BUILTIN_NOTIFY_TOOLS（dingtalk_notify / notify,2026-10-09 review 抓漏）∪ NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES;hopant（层 2）import validator（层 1）合层规,engine 已有先例
         2.3. [其他] tools ∪= callee
         2.4. 实参的 value 里嵌套的 CallExpr 同样递归（`write(content: str(x))` 的 str 是内建跳过,`my_tool(a: other_tool())` 两个都收）
      3. 三个集合去重、按首次出现序返回
```

```
HopSchema: ReconcileReport
  # 头对账的增删明细——packAnt 响应原样带出,/hop 读给用户看"封装改了你的 spec 头哪几行"
  - tools_added % [line]        # 正文用了、Tools 段没声明的工具名
  - tools_removed % [line]      # Tools 段声明了、正文没用且不是标准工具的
  - commands_added % [line]     # 正文 subprocess.run 用了、已批准命令段没有的首项
  - commands_removed % [line]   # 段里有、正文没用的首项（undetermined 非空时恒空）
  - commands_undetermined % [line]  # 第一参不是列表字面量、静态判不出命令名的调用（步骤号 + 一句）

HopSchema: BodyUsage
  # collectBodyUsage 的返回;reconcileHeader 消费,也导出给测试直测
  - tools % [line]              # 使用面工具名（授权行 ∪ body 调用,已去内建与 `*`）
  - commands % [line]           # subprocess.run 列表字面量首项
  - undetermined % [line]       # 第一参不是列表字面量的调用（步骤号 + 一句）

HopSchema: PackAntResult
  # packAnt 的返回;cli 原样进 AntResponse
  - id % line                   # 封装出的 HopAnt id
  - dir % line                  # 产物目录绝对路径 <outDir>/<id>
  - reconciled % ReconcileReport
  - docs_copied % [line]        # 随包拷入的 doc-ref 文件名
  - assets_copied % [line]      # 随包拷入的 assets
```

**与 hop-cli pack 的分工**：`hopjit pack` 把 spec 打成载体 skill 壳（SKILL.md + spec.md,斜杠命令场景）,`hopjit ant pack` 把 spec 封成 HopAnt 目录（入口文件名即 id,无壳）。两者都收 doc-ref 文件,收法相同（同目录找、缺即拒）;ant pack 多做头对账。pack 的定位改写归 F 清理,本批不动。

### 分享：HopAnt 目录 → HopAnt 包 ^anc-hopant-share

```
HopType: AntPacker（续）
  Specs:
    shareAnts(
      roots % AntRoots,         # 两级 HopAnt 根;每个 id 经 resolveAnt 找（项目级先,决策 9）——这个项目总结的 HopAnt 不用先装到用户级就能分享
      ids % [line],             # 要装进包的 HopAnt id,至少一个
      outDir % line,            # 包目录落 <outDir>/<name>/
      opts % yaml               # {name? % line 单 ant 缺省=id,多 ant 必填; version? % line 缺省 0.1.0（CLI 参数名 --pkg-version——--version 是全局引擎版本旗）; owner % line 归属标识,必填——问不问人归 cli/driver,到这里恒有值}
    ) -> result % ShareAntsResult
      # 四核任一不过即抛,不写任何文件（概念⑥"分享前 /hop 做四件事"——第四件是条件句,见 4）
      1. [条件(ids 空)] 抛 HOPANT_BAD_ID;[条件(opts.owner 空白)] 抛 HOPANT_BAD_ID（"到这里恒有值"由模块自己兜,不只靠 CLI trim）;[条件(ids 多于一个且 opts.name 缺)] 抛 HOPANT_PKG_NAME_REQUIRED;name = opts.name ?? ids[0];[条件(name 不合 npm 包名规则)] 抛 HOPANT_BAD_ID
      2. 对每个 id——核一：入口 spec 头与目录一致：hit = resolveAnt(roots, id);[条件(hit 为 null)] 抛 HOPANT_NOT_FOUND;下文 antDir 指 hit.dir;parseSpec 过（否则 HOPANT_SPEC_INVALID）;header.id == id（否则 HOPANT_ID_MISMATCH）;doc_refs 指向的文件全在 ant 目录内（否则 HOPANT_DOC_MISSING）
      3. 对每个 id——核二：凭证扫描：对 ant 目录内**全部文本文件**（可分发面;跳过本机面与二进制——按扩展名判文本：md/yaml/yml/json/py/js/mjs/ts/sh/txt/toml/ini/env 及无后缀的 UTF-8 可解码文件;spec、知识附件、scripts/、bootstrap.js 一视同仁,作者 2026-10-09 定"要扩"）跑 scanCredentials;[条件(任一 rejected)] 抛 HOPANT_CREDENTIAL_LITERAL 列出 文件:行:层:原因,不写包;warnings 收集进响应,不拦
      4. 谱系：[条件(antDir/inner_store/lineage.yaml 在场——文件名是本版先定的读点,D 演化定稿若另定名回改这里与代码两处;本版恒无)] 读出备用;[其他] 不写字段
      5. [条件(<outDir>/<name>/ 已存在且非空)] 抛 HOPANT_TARGET_EXISTS
      6. 写包：对每个 id 递归拷 antDir → <outDir>/<name>/ants/<id>/,**跳过 isLocalFace 为真的路径**（核三的实现——排除即满足;写完对产物目录再扫一遍 isLocalFace 作自检,命中即**删掉已写的包目录**再抛 HOPANT_LOCAL_FACE_LEAK,防排除逻辑回归且不留半成品）
      7. 写 <outDir>/<name>/package.json = HopAntPackageJson（下）
      8. 返回 {name, version, dir, ants: ids, checks: {header_dir_consistent: true, no_local_face: true, lineage_written: 有谱系的 id 列表}, credential_scan: CredentialScan, owner}（旧字段 no_credential_literals 删——"没有"是说不出口的,改为 credential_scan 回执带免责）

    scanCredentials(
      text % text,              # 一份文件全文
      ctx % yaml                # {file % line 相对 ant 根的路径; kind % line 'doc'（md）| 'data'（yaml/json/toml/ini/env）| 'code'（py/js/mjs/ts/sh）| 'text'}
    ) -> scan % CredentialScan
      # 作者 2026-10-09 定稿："不能只靠关键词匹配""三层综合研判"。三层各出证据,合成三档处置：拒 / 警告 / 放行。免责见 CredentialScan.disclaimer
      1. 切候选串：kind=data 取每个键的值;kind=code 取字符串字面量与赋值右边（同时记赋值左边名字作键名提示）;kind=doc/text 取每行（Markdown 行内 `key: value` 形态也抽键名）;同时记每个候选串的上下文：是否在代码围栏内、是否注释行、文件名是否含 example / sample / test / fixture
      2. 对每个候选串跑三层,各出一个布尔证据：
         L1 已知厂商形态（查形态表,与键名无关）：OpenAI `sk-[A-Za-z0-9_-]{16,}` / `sk-ant-…`;GitHub `gh[pousr]_[A-Za-z0-9]{20,}` / `github_pat_…`;GitLab `glpat-…`;Slack `xox[abpr]-…`;AWS `(AKIA|ASIA)[0-9A-Z]{16}`;Google `AIza[0-9A-Za-z_-]{35}` / `ya29\.`;Stripe `sk_(live|test)_…`;SendGrid `SG\.…`;JWT 三段 `eyJ…\.eyJ…\.…`;PEM `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`;URL 带账号段 `[a-z]+://[^/\s:]+:[^/\s@]+@`。形态表写在代码常量里,加一项加一行
         L2 高熵随机串：长度 ≥ 24、字符集 ∈ {base64, hex, urlsafe-base64}、香农熵（按字符频率算的 Shannon 熵,单位 bit/字符）过门槛——**门槛按字符集分两档**：base64 / urlsafe-base64 串 ≥ 4.0;纯 hex 串（`^[0-9a-f]+$`,不分大小写）≥ 3.0 且长度另须 ≥ 32（hex 只有 16 种字符,熵上限 4.0,拿 4.0 当门槛等于永不命中,所以降到 3.0 再用更长的长度补偿）;排除环境变量名形态 `^[A-Z][A-Z0-9_]*$`、占位（`<…>` / `${…}` / `{{…}}` / `***`）、UUID、文件路径、不带账号段的 URL、同一字符重复串
         L3 键名提示 + 值形态：键名（或赋值左边）去掉 `_env` 后缀后仍含 api_key / apikey / token / secret / password / passwd / credential / auth 之一,**且**值长度 ≥ 8、含数字或大小写混合、不是环境变量名 / 占位 / 纯数字 / 取环境变量的表达式（`os.environ[…]` / `os.getenv(…)` / `process.env.X` / `$X` / `${X}`）。`max_tokens: 4096`（纯数字）、`secret_sauce: recipe`（无数字小写词）、`token = os.environ["X"]`（取环境变量）都不满足
      3. 合成处置：[条件(L1)] 拒,**不降档**（示例文件里也不该放真钥匙）;[条件(L2 且 L3 同值)] 拒;[条件(L2 或 L3 单独)] 警告;[其他] 放行。[条件(候选串在代码围栏 / 注释行 / 示例文件内)] 把 L2+L3 的"拒"降为"警告"
      4. 返回 {rejected, warnings} 每项 {file, line, layers % [int], reason % line}——reason 写人话（"键 api_key 后跟了像密钥的值,应写环境变量名"）
      # 不判：`*_env:` 键的值（那就是环境变量名的家）。警告不是误报清单,是让用户亲自过一眼

    isLocalFace(
      relPath % line            # 相对 ant 根的路径,/ 分隔
    ) -> local % bool
      1. 返回 relPath 的第一段 == 'inner_store' 或 basename 匹配 /\.orig\.md$/
      # applyInstall 第 2 步与 shareAnts 第 6 步共用;概念 ^anc-struct-hopant-layout 的本机面定义只在这一处落码
```

```
HopSchema: HopAntPackageJson
  # 包根 package.json——与 npm 包兼容（只要 name/version）,不带 dependencies / scripts（作者 2026-10-09 定"删 postinstall",概念 Package 节已同步：安装恒由 /hop 安装 显式触发,无自动钩子）
  - name % line                 # 包名,npm 包名规则
  - version % line              # 运输标签,分享者定,缺省 0.1.0
  - files % [line]              # 恒 ["ants/"]——白名单
  - hopant % yaml               # {owner % line, ants % yaml}——ants 按 id 分键,每个 id 的值是 {} 或 {lineage % yaml}（有谱系才有 lineage 键;概念 :172 的 hopant.lineage 形态在这里按 ant 分键落位）

HopSchema: CredentialHit
  - file % line                 # 相对 ant 根路径
  - line % int
  - layers % [int]              # 命中的层号 1/2/3
  - reason % line               # 人话原因

HopSchema: CredentialScan
  # 核二的回执——不是"没有凭证"的保证,是"扫了什么、按什么判、判出什么"
  - files_scanned % int
  - rejected % [CredentialHit]  # 非空即不写包（抛 HOPANT_CREDENTIAL_LITERAL）
  - warnings % [CredentialHit]  # 写包,但 driver 须念给用户让人过一眼
  - method % line               # 恒 'heuristic'
  - disclaimer % line           # 恒："凭证扫描是启发式的尽力防线,不保证无漏;不把密钥写进 hop 文档和代码是用户自己的责任——请经环境变量（spec 里 *_env: 键写变量名）或密钥管理服务取用。"（作者 2026-10-09 定"要强调免责"）

HopSchema: ShareAntsResult
  - name % line
  - version % line
  - dir % line                  # 包目录绝对路径
  - ants % [line]
  - checks % yaml               # {header_dir_consistent % bool, no_local_face % bool, lineage_written % [line]}——回执不是判定：前两项到这里恒 true（false 的路径是抛错不是返回）,lineage_written 是有信息量的那个
  - credential_scan % CredentialScan
  - owner % line
```

**owner_id 的写回**（决策 8 写的一侧）：归组合根 cli.ts——`ant share` 成功后把 opts.owner 写进 `~/.hopjit/config.yaml` 的 `owner_id`（读文件 → 只改这一键 → `yamlDump(cfg, YAML_DUMP_OPTS)` 写回,与 setup `--plus` 合并 tool_servers 的写法同形;文件不存在则新建只含这一键）。模块层不碰 config。

**测试面**：`tests/hopant.test.ts` 两个 describe（封装组 / 分享组,凭证扫描直测在分享组内）——封装（正：Tools 段漏声明的工具被补、标准工具补标准签名、多声明的非标准工具被删（含中文名）、标准工具声明了保留、授权行内建名与 `*` 不补、容器步骤与 if 三部分与列表内嵌套调用都收、subprocess.run 首项补进已批准命令（含带引号首项的删除）、undetermined 在场时不删命令、doc-ref 文件随包（含步骤级）、Id 行改写（英文 Id: 与中文 标识:,无 Id 行时插入）、Tools 段插 Outputs 后、不建 inner_store;反：doc 缺 / doc 越界 / assets 缺 / doc 或 assets 存在但读不出（chmod 000）→ HOPANT_DOC_MISSING 且目标目录不存在、目标非空 → HOPANT_TARGET_EXISTS、坏 id（大写 / `..`）拒、坏 spec → HOPANT_SPEC_INVALID）/ 分享（正：单 ant 缺省 name=id、多 ant 包、`@scope/name` 包名、package.json 字段、files 白名单、有 lineage.yaml 时写谱系;反：L1 单独拒 / L2+L3 叠加拒 / 示例文件里真 sk- 不降档、L2 单独与 L3 单独只警告、max_tokens 与 os.environ 与 UUID 放行、围栏内 L2+L3 降警告、代码文件里的 ghp_ 拒、inner_store 里的凭证不扫、inner_store 与 *.orig.md 不进包、Id 与目录名不一致 → HOPANT_ID_MISMATCH、入口 spec 坏 → HOPANT_SPEC_INVALID、多 ant 缺 name → HOPANT_PKG_NAME_REQUIRED、ids 空 / 非法包名 / owner 空白 → HOPANT_BAD_ID、目标非空 → HOPANT_TARGET_EXISTS）;真实 HopAnt：`examples/ants/hop-fact-check/` 在假 HOME 下 planInstall + applyInstall + adapt,断言 ok 且唯一提示是 web_search 标准工具,并断言产物与 `examples/hop-fact-check.md` 逐字节相同（源-副本同步钉）。`tests/cli.test.ts` 加 `ant pack` 与 `ant share` 子进程例（owner 四态：--owner / config 落盘即用不问 / 首机 --yes 现算并新建 config / 首机无旗 prompt;owner_id 只动一键;config 顶层非映射拒;--pkg-version 缺省 0.1.0;credential_scan 回执与 warnings 透传）。

## 错误码【契约】 ^anc-hopant-errors

全部经统一出口构造,message 以错误码开头、冒号后是人话说明（码是闭合枚举,拼错编译期红）：

```
HopType: HopAntErrors
  # 全部错误码的唯一构造点（码是下表的闭合枚举,加码加表一行;不在这里写数字——曾写"六""九"与表 11 行三处打架）;cli 的 NOT_FOUND 也经它
  Specs:
    hopantError(
      code % line,              # 下表之一
      detail % text             # 人话说明,按下表"说明里带什么"列写
    ) -> err % yaml             # Error 对象,message = `<code>: <detail>`
```


| 码 | 什么时候 | 说明里带什么 |
|---|---|---|
| `HOPANT_BAD_ID` | id 不合法：含 `/`、`\`、`..`、空、大写字母、或首字符不是小写字母/数字 | 原 id |
| `HOPANT_SOURCE_INVALID` | 来源目录既不是单 ant 也不是包 | 目录路径 + 两种合法形态各一句 |
| `HOPANT_SPEC_INVALID` | 入口 spec 解析报 error | 文件路径 + 首条错误 |
| `HOPANT_ID_MISMATCH` | 入口 spec 的 Id 字段与文件名不同 | 两个值 |
| `HOPANT_ID_CONFLICT` | 安装计划里有撞 id | 撞的 id 列表 + "先 hopjit ant remove 或改来源 id" |
| `HOPANT_NOT_FOUND` | adapt / bootstrap / share 指向的 id 没装 | id + `hopjit ant list` 指路 |
| `HOPANT_DOC_MISSING` | pack 时 doc-ref 指向的文件不在 spec 同目录、或引用越界（`../` / 绝对路径）、或 `--assets` 指向的文件不存在、或 doc-ref / assets 文件存在但读不出（权限、坏符号链接——2026-10-11 todo/0159 扩语义,不新开码）;share 时 doc-ref 文件不在 ant 目录内 | 缺的文件名列表 + 该放哪;读不出的带系统错误 message |
| `HOPANT_TARGET_EXISTS` | pack / share 的目标目录已存在且非空 | 目录路径 + "先删或换 --out" |
| `HOPANT_PKG_NAME_REQUIRED` | share 多个 id 而没给 --name | id 列表 |
| `HOPANT_CREDENTIAL_LITERAL` | share 核二 scanCredentials 有 rejected（L1 单独或 L2+L3 叠加） | 文件:行:层 + 人话原因逐条 + 免责一句 |
| `HOPANT_LOCAL_FACE_LEAK` | share 写完自检发现本机面路径进了包（排除逻辑回归;抛前已删掉半成品包目录） | 泄露路径 |

## CLI 承接【说明】

契约在 [[hop-cli#^anc-cli-ant]]。2026-10-10 todo/0154 起业务体住 hop-cli 模块的 hop-admin.ts,组合根（`cli.ts` / `mcp-server.ts`）只负责：取 `homedir()` 与工作区根算两级 HopAnt 根 `antRoots`;算两级配置路径（`HOPJIT_CONFIG` 在场即单文件）交给 `loadTwoLevelRegistry`（config 都缺席按空注册面,不报错——用户可能还没配,这时适配报告会把所有工具列为缺口,正是要告诉用户的事）;拆 `process.env.PATH`;归属标识先读 `~/.hopjit/config.yaml` 的 `owner_id`,没有才由 `git config user.name`（失败即空）、`os.userInfo().username`、`os.hostname()` 交 `ownerId` 现算（决策 8;写回归打包）;引擎版本用 engine 的 `getEngineVersion()`（读失败 null）;`ant list` 的三态调 `adaptState`;`ant bootstrap` 时 spawn `node <antDir>/bootstrap.js [--dry-run]` 并把 stdout/stderr 原样进响应。

`run` / `init` 顶层起跑前调 `checkRunDeps`（env.roots=antRoots(homedir(), 工作区根),tool_servers 同上取法）;启动时把 `resolveCalleeSpecPath` 绑成闭包 `(caller, id, ws) => resolveCalleeSpecPath(dirname(caller), antRoots(homedir(), ws), id)` 注册给 `ExecutionEngine.setCalleeSpecResolver`（第三参由引擎传本实例 workspace_dir）,与工具工厂注册同一处。

setup 的第 7 项职责（缺省装三个演示 HopAnt,契约 [[hop-cli#^anc-cli-install-skill-demo-ants]]）是本模块的第二个调用方：`cli.ts` 的 `installDemoAnts` 把包内演示原件拼成临时的单 HopAnt 来源目录,再调同一对 `planInstall` / `applyInstall` 落盘,不另写安装逻辑——id 校验、本机面文件跳过、`inner_store/` 新建、索引重建与 `hopjit ant install` 完全同一条路径。

## 测试面

`tests/hopant.test.ts`,`@module: hopant`。临时 home 用 `mkdtempSync`,不碰真实用户目录。两级根（v0.5.0,todo/0155）：`antRoots` 两根路径;`resolveAnt` 项目级先于用户级、同 id 遮蔽、都没有 null;`listAnts` 合并顺序与 scope、同 id 两条都在;`planInstall` 撞 id 只在本级判（另一级同 id 不是冲突）;`removeAnt` 缺省删查到的那级、显式 scope 删指定级、备份位恒用户级;`resolveCalleeSpecPath` 三级顺序（同目录 → 项目 → 用户）;`commitApprovalStorePath` spec 在项目级 HopAnt 下账落该 HopAnt 的 inner_store/;`checkRunDeps` call 目标是项目级 HopAnt 时通过;`shareAnts` 分享项目级 HopAnt 不须先装用户级;`rebuildIndex` 空根且无 index 不建目录。CLI 子进程用例依赖 `dist/cli.js`——缺席时**显式失败**（断言带指路'先 npx tsc'）,不许静默跳过（`^anc-meta-guard-trust`）。正反例成对：单 ant 安装 / 包安装 / 撞 id 整单拒且一个不写 / 本机面被跳过且 skipped_local_files 列出 / 索引三段格式与重建 / Id 字段不一致拒 / adapt 四项各一正一反 / 标准工具未注册不算缺口而非标准工具未注册算缺口（一对） / needsAdapt 三个为真的条件各一例加一个为假 / backupOrig 二次不覆盖 / removeAnt keepStore 两态 / 错误码六个各至少一例 / resolveCalleeSpecPath 同目录命中、HopAnt 根命中、同名时同目录优先、两处都没有返回 null、id 带分隔符或 `..` 返回 null / checkRunDeps 标准工具未注册通过而非标准工具未注册报错（一对）、已装 HopAnt 的 call 通过而未装报错（一对）、call 目标是已注册工具通过、动态 callee 不核、callee spec 里的未注册工具经递归报出、call 环不死循环。
