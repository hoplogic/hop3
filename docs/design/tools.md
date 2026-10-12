%% @trace
	id: hopjit-tools
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-10-09T11:11+0800
	note: tools 模块设计——装配层本体（成员构成/生命周期/出口边界;2026-08-31 拆迁后形态:各工具组契约归 tools/ 子目录一模块一文件,本文只长索引行）。2026-07-02 从 shared-types.md 抽出独立成文;2026-08-31 作者定归口拆迁。
%%

# tools 模块设计

shared-providers 的 `ToolProvider` 契约（见 [[shared-providers#^anc-provider-tool]]）的**实现与装配层**——六个物理文件合成一个模块：内置实现（`tools.ts`）、声明加载（`tools-registry.ts`）、装配器（`tools-composite.ts`）、mcp 绑定（`tools-mcp-binding.ts`）、in-process 绑定（`tools-inprocess-binding.ts`）、通知通道（`tools-notify.ts`）。
本文管**装配层本体**：定位、成员构成、生命周期、出口边界；家族四切面（interface/channels/本文/tools/ 子目录）的分工见下"工具设计面地图"节。被 doc-ref 复用其沙箱读取能力。

## 工具设计面地图【说明】 ^anc-struct-tools-family-map

工具体系的设计文档是**一个家族四个正交切面**——本节是四者分工的唯一权威论述（其余文档只留指针指回此处,不复述分工——复述即漂移面,tool-interface 的旧分工句在拆迁后失实半月无人察觉是实撞）：

| 文档 | 一句话 | 管什么 | 不管什么 |
|---|---|---|---|
| [[tool-interface]] | 工具**怎么被声明与校验**（接口标准） | typed request-response 两层（第一层 name+schema+shape+requires_commit 标准;第二层 in-process/mcp 绑定机制）、注册文法（tool_servers 节）、双端校验、server 生命周期 | 任何具体工具长什么样;步骤怎么调到工具 |
| [[tool-channels]] | 工具**怎么被步骤消费**（通道地图,枢纽文档只汇总不定义） | "spec 里的一步要用工具,请求物理上怎么走"——五条通道一张表、选路规则、通道间不变量、requires_commit 横切拦截 | 工具怎么声明、怎么实现（引用另两面的权威锚点） |
| 本文 | 工具**怎么被装配起来**（装配层本体） | src/ 六文件模块的成员构成、生命周期、内置成员表、出口边界 | 具体工具的契约（索引行指子目录） |
| `tools/` 子目录 | **每件具体工具是什么**（一模块一文件） | 各工具组/通道的入参/返回/语义/Sop/正反例——一件工具的契约恒只在一份文档 | 装配与通道（指回上三面） |

读者路由：想接一个新工具 → tool-interface（注册文法）;想知道某步骤的工具调用走哪条路 → tool-channels;想改装配/加内置通道 → 本文;想查某件工具的参数语义 → tools/ 对应文件。

## tools 模块定位【契约】 ^anc-struct-tools

> **模块版本**：tools `v0.27.2`（2026-10-12 语义审计 #25 #26 作者拍甲案：listdir 空目录 result 退回纯 `[]`（content_type json 恒可 parse）,给弱模型看的明示语改走 ToolResult.hint 旁路字段,只在工具循环渲染给 LLM 的 tool_result 文本尾部追加——修前注记拼进 result 把机械通道弄坏,parse_json 与 call 位 JSON.parse 都炸;契约在 [[tools/file-tools#^anc-exec-builtin-file-tools]] listdir 行）。上版 v0.27.1（2026-10-09 commit 安全分析批次工程链 review 修复：keep 缺省值 DEFAULT_KEEP 迁到 ast-types.ts 与 engine 同源,RECYCLE_DIR_NAME / RECYCLE_LEDGER_FILE / RecycleLedgerEntry 去掉导出;留存条款改写成 HopType DefaultToolProvider（留存部分）与 HopSchema RecycleLedgerEntry,补 noteLedger 的 work_zone 跳过、账文件解析失败按空表、move 只在源存在时留存目标、execute 主流程的 keep 校验步——[[tools/file-tools#^anc-exec-file-keep-recycle]]）。上版 v0.27.0（2026-10-08 commit 安全分析批次：write / edit_file / move / remove 加可选参数 `keep`（缺省 3）——覆盖或删除已有文件前先把旧版本存进状态目录下的回收站 `recycle/`,每个文件最多保留 keep 份,同一文件在一次 run 里只留存一次（接管账 `recycle_ledger.json` 记在本 run 顶层实例目录）;remove 缺省进回收站,keep=0 才是永久删除;work_zone 内不留存。目的：最常见的覆盖与删除动作缺省可逆,commit 安全分析可直接放行——[[tools/file-tools#^anc-exec-file-keep-recycle]]）。上版 v0.26.1（2026-10-08 发版前八项修复批工程链 review 修复：父目录缺失指路报文扩到 move 的目标侧（[[tools/file-tools#^anc-exec-write-parent-missing]]——三件改四件,源不在场的 ENOENT 仍原文照回）;`makeEngineToolProviderFactory` 的 loadRegistry 回调改为接 HostConfig（项目根按 workspace_dir 取）。上版 v0.26.0（2026-10-08 todo/0131：出口 `loadProjectToolRegistry` 退役,两级 tool_servers 读取归 config-load 模块 `loadToolRegistry`;`loadTwoLevelRegistry` 保留给 hopant adapt）。上版 v0.25.1（2026-10-08 hopissues/0120：写入类三件工具（write/create/append）父目录缺失时报文指路 makedirs,不自动建目录——[[tools/file-tools#^anc-exec-write-parent-missing]]）。上版 v0.25.0（2026-10-07 todo/0148：commit 写域扩为 workspace ∪ `sandbox.filesystem.write_access.allowed`（spec Config.dirs.readwrite 经授权的目录）,resolvePath strict 档加第⑤合法形态;act/check 写域不动——[[tools/file-tools#^anc-exec-builtin-file-tools]]。上版 v0.24.0（2026-10-07 文件工具读类路径解析认 `read_access.allowed` 内绝对路径——第④种合法形态,`spec_dir()` 产物能读;写类与 run_script 不认,[[tools/file-tools#^anc-exec-tool-path-resolve]];作者定"不让读的话 knowledge、data 和未来的 inner_store 都要再分开授权"）。上版 v0.23.2（2026-10-06 出口表加 `loadTwoLevelRegistry`——hopant 批 review 修复批）。上版 v0.23.1（2026-09-30）。本版把目录边界判定两件 resolveRealDeep / isWithinDir 从模块私有改为出口（todo/0132——mcp-server run_approved_command 的 cwd 越界判复用,语义零变化）。上版 v0.23.0（同日）work_zone 豁免读写分权（todo/0126,作者定"可以读,但不应该能写"）：写只认当前实例自己的 work_zone,读对本 run 整个实例树的 work_zone 开放（祖先/兄弟/后代按目录布局判）;收回 v0.22.0 "本实例+祖先读写全放行"——后代不再能写祖先。ToolProvider 加可选方法 setWorkZoneScope（写根与读树）;registerWorkZoneRoot 语义收窄为读集合兜底。契约 [[tools/file-tools#^anc-exec-work-zone-registry]]。
>
> - 上版（v0.22.0） work_zone 沙箱豁免改为只认本次运行自己实例树的涂鸦区集合（todo/0124,作者定"这个任务就应该直接把 work_zone 目录记下来"——原三支判定里字面正则两支让 workspace 外任何含 `.hopstate/<x>/work_zone` 字面的路径都能读写、模块级注册表让同进程别的 run 互相可读写;集合改归 DefaultToolProvider 实例持有,engine.getWorkZone() 做登记路由,ToolProvider 加可选方法 registerWorkZoneRoot,PersistenceProvider 加可选方法 getWorkZoneRoots 报本实例与祖先实例的根;契约 [[tools/file-tools#^anc-exec-work-zone-registry]]）。**出口表变更**：删模块级函数 `registerWorkZoneRoot`（0066 批 provisional 登入,本版随字面判定一并退役——登记改经 ToolProvider 接口可选方法进提供者实例,不再有模块级出口;0.x 阶段删出口走 MINOR,决策依据=作者定"直接把 work_zone 目录记下来"）。
>
> - 上版（v0.21.0）文件工具认落在 workspace 内的绝对路径（hopissues/0112——hopbuild2 翻译产物的 commit 步用用户给的绝对路径派生落盘路径,原"一律禁绝对路径"把交付物拦在门外;概念层只要求落在 workspace 内,不要求相对写法）;同批修两处既有逃逸:目录前缀判定补路径分隔符边界（兄弟目录 /x/proj2 不再算在 /x/proj 内）、新建文件经软链父目录与悬空软链不再逃出 workspace（契约 [[tools/file-tools#^anc-exec-tool-path-resolve]]）。
>
> - 上版（v0.20.3） `edit_file` 给模型看的返回说明（ToolDef.returns）从"字节偏移 at byte"改正为与实际回执一致的"字符偏移 at char"（这句会渲染进工具清单,旧说法误导模型）;file-tools 设计补齐零匹配报错结构与最接近行算法的逐步流程（工程链 review 修复,契约 [[tools/file-tools#^anc-exec-builtin-edit-file-tool]]）。
>
> - 上版（v0.20.2） `edit_file` 零匹配报错附文件里最接近的行原文（最多 3 条,行号+JSON 引号包住的原文）——hb2 qwen-flash 修错步连续十几轮凭记忆写 old_text 零匹配,旧报错只回显 old_text 本身看不出错在哪（契约 [[tools/file-tools#^anc-exec-builtin-edit-file-tool]]）。
>
> - 上版（v0.20.1）`run_script` 的工具说明补写工作目录约定——脚本以它自己所在的目录为工作目录运行,同目录的样例文件给 `args` 传裸文件名（T9 复跑实撞:模型照其余文件工具的习惯传工作区相对路径,脚本找不到文件,qwen3.8-27b 因此烧穿一轮 20 轮工具上限;契约 [[tools/run-script#^anc-exec-builtin-run-script]]）。
>
> - 上版（v0.20.0）`run_script` 的 `.py` 脚本一律先过 Python 语法沙箱再执行（审查与执行归 py-sandbox 模块,契约 [[py-sandbox]]）;回执 JSON 加 `defense` 字段标本次防护等级;审查被拒=工具失败带逐行拒绝报文。run_script 原工程偏差①"白名单管不住脚本内容能再 spawn 什么"由此关上（[[tools/run-script]]）。
>
> - 上版（v0.19.0）新增执行类工具组首件 `run_script`（受控脚本执行,category=special 须节点声明）——缘起=todo/0110 候选 B 作者拍板,standalone 的 `[act free]` 工具面此前没有任何一件能让进程跑起来;命令执行原语与 hop_python 的 subprocess.run 共用一份实现（见 [[act-body#^anc-exec-command-primitive]]）;
>
> - 上版（v0.18.0）DefaultToolProvider.execute 实参名进闸核对（作者拍,决策页 todo/decision/20260916-内置工具参数名写时校验.md——move(src:/dst:) 笔误 undefined 穿透 Node fs 报误导错;分派前按 input_schema 核未知参数名/缺必填,报文点名合法参数名集,走 ToolResult 失败通道;契约 file-tools.md 实参名进闸条款）；
> - 上版（v0.17.1）listdir/exists 条目类型字段正名 type、kind 留作同值兼容别名（作者拍乙案——R9 实撞 e.type 缺键恒假,行业主流用词 type;契约 file-tools.md）；
> - 上版（v0.17.0）出口表补登 makeEngineToolProviderFactory 与 loadProjectToolRegistry（0076 批漏登+真收敛挪入,review 机检实拦补）；
> - 上版（v0.16.0）读侧两工具批（todo/0070——作者拍'rg 类工具两件立todo'）：文件工具组扩员 search_file（单文件子串搜索带行号,契约 file-tools.md ^anc-exec-builtin-search-file）+read 扩 start_line/end_line 行号段参数（存量零回归）,十件→十一件——D81 定向读盘正路的读侧兑现；
> - 上版（v0.15.0）文件工具组扩员 edit_file（局部精确替换,契约归 file-tools.md ^anc-exec-builtin-edit-file-tool）,九件→十件；
> - 0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。

**① 自身定位**：tools 模块是 shared-providers 契约的实现与装配层。负责实现与装配，不碰调度/状态。沙箱拦截规则见 [[sandbox]]。

**② 成员构成（六文件一模块，2026-08-31 现状）**：

| 文件 | 职责 | 关键类型/类 | 设计权威 |
|---|---|---|---|
| `tools.ts` | 内置实现：file 十一件 + spec 内容族六件 + 执行类一件 + 沙箱路径校验链 | `DefaultToolProvider` | [[tools/file-tools]] / [[tools/spec-tree-tools]] / [[tools/run-script]] |
| `tools-registry.ts` | hoptools.yaml 声明加载（fail-fast 校验） | `ToolSpec`/`ToolServerEntry`/`ToolBinding`/`loadToolRegistry` | [[tool-interface#^anc-config-tool-registry]] |
| `tools-composite.ts` | 装配器：成员并集/按名路由/双端校验/audit 元信息 | `CompositeToolProvider` | [[tool-interface#^anc-exec-tool-composite]] |
| `tools-mcp-binding.ts` | mcp 绑定成员：惰性连接/超时硬闸/终态收 | `McpBindingMember` | [[tool-interface#^anc-exec-mcp-binding]] |
| `tools-inprocess-binding.ts` | in-process 扩展成员：隔离模块惰性装载/异常罩/终态收 | `InProcessBindingMember` | [[tool-interface#^anc-exec-inprocess-binding]] |
| `tools-notify.ts` | 钉钉通知通道（不可逆工具）（内置成员表第二员） | `NotifyToolProvider` | [[tools/dingtalk-notify]] |

**③ 模块生命周期（一次 run 内）**：装配（dispatcher/mcp-server 构造 Composite：内置组恒在 + tools_file 注册条目 + 宿主注入并入，名字判重 fail-fast）→ 服务（body 解释器/LLM 工具循环按名调用，双端校验包住每次执行）→ 终态收（run 终态钩子 Composite.close() 逐成员传导——仅 mcp 成员有实义，三段礼貌关停）。外部 server 的细粒度五阶段（注册/惰性连接/调用/终态收/崩溃面）见 [[tool-interface#^anc-exec-tool-server-lifecycle]]。

**④ 消费方地图（谁在用本模块）**：

| 消费方 | 吃什么 | 用途 |
|---|---|---|
| step-dispatcher | `CompositeToolProvider` | 独立模式工具面装配（构造器与预检同源） |
| mcp-server | `loadToolRegistry` + `CompositeToolProvider` | tools_file 加载进宿主契约；startRun 预检工具面并集 |
| `readSandboxedFile`/`resolveWorkspacePath` | 沙箱读取复用（安全一致性——不自造第二套校验） |
| act-body 解释器 | 经 `ToolProvider` 接口（shared-providers 契约,非直接 import） | body 内工具调用 |

**⑤ 配置案例**：内置组零配置恒在；外部工具声明见 [[tool-interface#^anc-config-tool-registry]] 文法与 `examples/hoptools-bailian.yaml` 真机样例（百炼 WebSearch+amap，tool_id/unwrap/shape 全要素）；真机凭证 `npm run test:e2e:mcp-binding`（绑定层零 LLM）+ `test:e2e:standalone-tools`（LLM×外部工具全链）。

**⑤b 内置成员表（2026-08-31 随 dingtalk-notify 改造——第二内置组插槽）** ^anc-exec-builtin-member-table

CompositeToolProvider 构造器的内置段从"硬编码单成员 builtin-file"改为**内置成员表遍历装配**（数组常量 BUILTIN_MEMBERS：每项三字段 {label, provider 实例, specs}）。

- specs 是该成员工具的 ToolSpec 表,**tool_id 渠道中立映射与 requires_commit 声明的物理载体**（notify 的两样全靠它,漏挂=语言面调用名失效+不可逆闸空转）;现两员:builtin-file=DefaultToolProvider〔specs 空表〕/ builtin-notify=NotifyToolProvider〔specs 含 dingtalk_notify 条目〕;
- 2026-08-31 review 面一/面二双面实抓原句"{label, provider 工厂}"两字段失记 specs 且"工厂"失实——按设计扩渠道会漏挂映射;
- 将来新增内置通道=表里添一行,构造器零改动。内置成员与 registry 成员/宿主注入成员同过 addMember 判重与 execute 路由,双端校验/write_scope 透传/requires_commit 拦截零特殊分支——内置不是特权成员,只是装配来源不同。

**⑥ in-process 扩展档**：in-process 扩展模块=**与主代码库隔离的独立工具库**（如 hopkb 工具组）——领域逻辑住自己的库、走自己库的工程链审计，**一行不进本库**（防污染主代码库/引擎保持领域无关）；in-process 仅指运行形态（装载进引擎进程，零序列化换失去进程隔离——它崩=引擎崩,资格卡审计状态,声明装载=操作者断言）。

- 注册文法（`kind: in-process` + `module: <路径>`）、模块接口契约（execute 必须/close 可选/名单权威恒在声明侧）、装载与崩溃面语义见 [[tool-interface#^anc-exec-inprocess-binding]]；参考例=`examples/ext-tools/word-stats.mjs`（隔离模块形态样板）;
- 内置组（本库自有能力）经内置成员表装配（⑤b——表驱动,非配置注册），与扩展模块是两类成员。hopkb 升格时照参考例接入。

## 工具模块索引【说明】（docs/design/tools/ 子目录——一模块一文件） ^anc-struct-tools-modules

各工具组/通道的契约设计按模块归口子目录（2026-08-31 作者定"设计文档应该有归口,而且是可以扩展的,不应该塞到一个文档里""docs/design 下有一个 tools/ 子目录,里面放各个 tool 模块""不要污染 design 主目录"——新模块只在子目录添文件,本文只长索引行）：

| 模块文件 | 管什么 | 锚点（原名随迁,引用面经目标文件名可达） |
|---|---|---|
| [[tools/file-tools]] | 内置文件/目录工具组十一件（读写侧权限链/写域分域） | ^anc-exec-builtin-file-tools / ^anc-exec-write-scope |
| [[tools/spec-tree-tools]] | spec 内容工具族六件（读/写/验三面+族总览） | ^anc-exec-spec-tools-family / ^anc-exec-builtin-edit-tree-tool / ^anc-exec-builtin-read-tree-tool / ^anc-exec-builtin-validate-tool |
| [[tools/dingtalk-notify]] | 钉钉通知通道（不可逆工具）（第一个 requires_commit=true 内置件） | ^anc-tool-dingtalk-notify 等四锚 |
| [[tools/run-script]] | 执行类工具组一件 run_script（受控脚本执行——模型只选脚本不选命令,解释器引擎按扩展名定;第一个 category=special 内置件） | ^anc-exec-builtin-run-script / ^anc-exec-run-script-no-command-choice 等五锚 |

**requires_commit 现状随第一个不可逆内置工具更新（2026-08-31）**：原"内置全 false"的全局假设废止——按声明逐件定,权威在各模块自己的声明（文件/spec 内容两组恒 false=沙箱内无不可逆;dingtalk-notify true=不可逆;run_script false——同一份能力在 body 面的 subprocess.run 同档）。预检 T1（[[exec-engine]] validateToolSurface）对内置声明形态同样生效。

**category 现状随第一个 special 内置工具更新（2026-09-22）**：原"内置件恒 basic（零声明可用）"同样不再是全局假设——`run_script` 是 `category='special'`,**须节点显式写 `- 工具: run_script` 才下发**。两条理由（完整三条论证见 [[tools/run-script#^anc-exec-builtin-run-script]]）：

- 它的安全增量是"决定跑什么的人从规约作者变成了执行模型",这一处增量要 opt-in;
- 白名单缺省关死的装配里 basic 恒列等于往清单里塞一件必然调用失败的工具——那正是 todo/0110 本身的病（教学面许诺供给面没有的东西）。

## 对外接口清单【封闭】 ^anc-struct-tools-exports

> 出口文件 = `tools.ts` / `tools-registry.ts` / `tools-composite.ts` / `tools-notify.ts`。表外即内部。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。出口表必须与模块体量同一次改动更新。

| 符号                                                                                                          | 种类  | 出口文件               | 用途（谁依赖）                                                                                                                | 稳定性         |
| ----------------------------------------------------------------------------------------------------------- | --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| `DefaultToolProvider`                                                                                       | 类   | tools.ts           | ToolProvider 默认实现（engine/cli 建实例）                                                                                      | stable      |
| `makeEngineToolProviderFactory` | 函数 | tools-composite.ts | `makeEngineToolProviderFactory(loadRegistry: (hostConfig) => ToolServerEntry[] \| undefined)` 引擎直执面工厂构造体单一权威（cli.ts/mcp-server.ts 组合根注册与 engine.test.ts 同 import——0076 批立,2026-09-06 review 抓漏登补）;2026-10-08 review 修复：读注册表的回调改为接本 run 的 HostConfig,组合根用 `hc.workspace_dir` 当项目根（[[config-load#^anc-config-reuse-consume]] 工具面条款）,不再读进程 cwd | stable |
| ~~`loadProjectToolRegistry`~~ | 函数 | tools-registry.ts | **已退役**（2026-10-08 todo/0131）——项目级单读被 [[config-load]] 出口表 的两级 `loadToolRegistry` 接替,cli 工具工厂与 tool-call 改调之;本模块删除该函数 | removed |
| `loadTwoLevelRegistry` | 函数 | tools-registry.ts | 两级配置（sysPath + projPath,任一可 null）的 `tool_servers` 与 `providers` 两节读取合并：空文件/纯注释按无配置、顶层非 YAML 映射抛 `TOOLS_FILE_INVALID`、tool_servers 按 name 与 providers 按 service_id（大写比）项目级赢、`enrichParamsComments` 回填——与 mcp-server `mergeConfigs` 同律。消费方 `hopjit ant adapt`（[[hopant]];2026-10-06 review 从 cli.ts 挪入——CLI 不写合并规则）。todo/0131 统一两级合并时与 mergeConfigs 收敛 | provisional |
| `readSandboxedFile`                                                                                         | 函数  | tools.ts           | 沙箱内文件读取（doc-ref 复用）                                                                                                    | stable      |
| `resolveWorkspacePath`                                                                                      | 函数  | tools.ts           | workspace 相对路径解析（doc-ref 复用）                                                                                           | stable      |
| `resolveRealDeep` / `isWithinDir`                                                                           | 函数  | tools.ts           | 目录边界判定两件（真实路径换算+含分隔符边界的"在目录内"）——mcp-server `run_approved_command` 的 cwd 越 workspace 判复用,不另抄一份（[[mcp-server#^anc-mcp-run-command]],2026-09-30） | stable      |
| `validateReadAccess`                                                                                        | 函数  | tools.ts           | 三级读权限校验（doc-ref hop_env 展开的绝对路径直判复用——展开值绕过 resolveWorkspacePath 相对链,权限判据必须同一套,见 [[doc-ref#^anc-exec-doc-ref-hop-env]]） | stable      |
| `executeValidateSpec`                                                                                       | 函数  | tools.ts           | validate_spec 执行体（Provider 外纯函数——测试直调;见 ^anc-exec-builtin-validate-tool）                                               | provisional |
| `executeInsertNode` / `executeReplaceNode` / `executeReplaceChildren` / `executeRenumberSteps`              | 函数  | tools.ts           | 树编辑四工具执行体（Provider 外纯函数——测试直调;共享壳 parse→spec-tree-edit 核心→renumber→sync→serialize;见 ^anc-exec-builtin-edit-tree-tool）  | provisional |
| `CompositeToolProvider`                                                                                     | 类   | tools-composite.ts | 工具装配器（dispatcher 构造工具面 / mcp-server 预检并集）                                                                              | 0.x         |
| `loadToolRegistry`                                                                                          | 函数  | tools-registry.ts  | 独立工具注册文件加载（统一配置后为兼容/测试面——主入口已让位 parseToolServers）                                                                      | 0.x         |
| `parseToolServers`                                                                                          | 函数  | tools-registry.ts  | tool_servers 节解析（统一配置收编后主入口——mcp-server 消费;逐项 _base_dir 定 module 解析基准）                                                 | 0.x         |
| `enrichParamsComments`                                                                                      | 函数  | tools-registry.ts  | params 短形态行尾 # 说明回填（各读入口 yamlLoad 后调:loadToolRegistry 内部/mcp-server parseConfigFile/cli tool-call;^anc-tool-params-notes 窗口化算法）                | 0.x         |
| `ToolSpec` / `ToolServerEntry` / `ToolBinding`                                                              | 类型  | tools-registry.ts  | 声明态契约（Composite/McpBinding/宿主 tool_registry 贯穿；type-only 也算依赖——模块规范 §3.4）                                              | 0.x         |
| `NotifyToolProvider`                                                                                        | 类   | tools-notify.ts    | 钉钉通知通道（内置成员表装配;mcp-server 终态挂点直调 sendDingtalk）                                                                         | 0.x         |
| `sendDingtalk`                                                                                              | 函数  | tools-notify.ts    | 发送执行体（工具 execute 与引擎挂点共用——一份发送实现两个消费口,见 [[tools/dingtalk-notify#^anc-tool-dingtalk-sop]]）                              | 0.x         |
| `composeRunCard` / `RunCardInput`                                                                           | 函数/类型 | tools-notify.ts | 运行状态卡片组装（两挂点共享渲染——mcp-server maybeNotify 与 cli outputWithNotify 同调,消两处组装漂移面;见 [[tools/dingtalk-notify]] 归置注记与 [[hop-cli#^anc-cli-notify-reuse]] RunCardInput 契约） | 0.x         |

> **内部（表外即内部）**：`resolveReal` 等私有 helper；`McpBindingMember`/`InProcessBindingMember`（两绑定成员文件——仅 Composite 内部装配消费,不对模块外出口;测试经模块内 import 不算跨界）。
> **不在本表**：`spec-tree-edit.ts` 的 AST 级树编辑核心六函数与定位原语——该文件归 **spec-ast 模块**（2026-08-30 归属定,纯 AST 操作与 ast-helpers 同性质），出口登记在 [[spec-ast]] 的对外接口清单（2026-08-31 归类修正:原双重登记于此,一文件一模块一张出口表。此处不写出口锚链接——审计 scan 对 -exports 锚的行级命中会把引用行误当 manifest 定义起点,空表覆盖真表,35 处假违规实撞）。
