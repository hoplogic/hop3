%% @trace
	id: hopjit-doc-ref
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-07-02T11:43+0800
	note: doc-ref 模块设计——[[文档路径#章节名]] 确定性精确知识引用(提取/切片/注入)。2026-07-02 从 step-dispatcher.md 抽出独立成文(被 parser/validator/engine 多方调,应独立模块独立文档;早期误挂 dispatcher 是历史)。
%%

# doc-ref 模块设计

`[[文档路径#章节名]]` 确定性精确知识引用的实现——从 spec 文本提取引用（parser 期）、静态校验存在性（validator P15）、运行期读文件切章节注入 agent context（engine 期）。概念权威见 [[../concepts/HopSpec V3核心规范#^anc-exec-doc-ref]]。

## doc-ref 模块定位【契约】 ^anc-struct-doc-ref

> **模块版本**：doc-ref `v0.3.0`（2026-09-23——resolveDocRefs 大节处置由布尔 inlinePreview 扩为 inlineMode 三档,todo/0115）。0.x 未承诺稳定。`[[文档路径#章节名]]` 语法 + 章节切片算法是稳定契约——改它影响所有用 doc-ref 的 spec）
>
> **记法约定**：全库文档提到 doc-ref 语法时写 `[[文档路径#章节名]]`——双方括号内两段是**占位符**（待作者填入的 workspace 相对路径与 markdown 标题），不是叫"文档路径"的文件。实际写法如 `[[anchor-audit-knowledge#宪法级原则]]`。此记法与 Obsidian wiki 链接同形，引擎独立实现解析（不依赖 Obsidian）。

**① 自身定位**：doc-ref 模块实现 `[[文档路径#章节名]]` 确定性精确知识引用——从 spec 文本提取引用（parser 期）、静态校验存在性（validator P15）、运行期读文件切章节注入 agent context（engine 期）。概念见 [[../concepts/HopSpec V3核心规范#^anc-exec-doc-ref]]。

**② src 文件构成**：`doc-ref.ts`（纯函数模块）——`extractDocRefs`（提取）/`sliceSection`（Markdown 章节切片）/`sliceYamlKey`（YAML 键切片）/`sliceByFileType`（按扩展名分流两档）/`resolveDocRefs`（读文件+deflate）/`checkDocRefExists`（P15 静态校验）/`formatDocRefContext`（渲染 L2d）。

**③ 边界（负责什么 / 不碰什么）**：
- **负责**：`[[]]` 正则提取、markdown 章节切片算法、章节内容读取+deflate、L2d 渲染。
- **不碰**：sandbox 文件读取的权限校验（复用 tools 的 `readSandboxedFile`）、注入时机调度（engine `resolveStepDocRefs` 调本模块）、与 @knowledge 的模糊检索（正交,各管各的）。

**④ 跨模块关系（doc-ref 穿过多层：parser/validator/engine）**：parser 调 `extractDocRefs` 入 AST、validator 调 `checkDocRefExists`（P15）、engine `assembleBasicContext` 调 `resolveDocRefs`+`formatDocRefContext`、复用 tools 的沙箱读取。
行为锚点分散于 [[spec-parser#^anc-rule-doc-ref-extract]]/[[spec-parser#^anc-rule-p15]]/[[#^anc-exec-doc-ref-resolve]]/[[prompt-assembler#^anc-exec-doc-ref-injection]]，本节是其**模块级统一定位**。

**⑤ 对外接口清单【封闭】** ^anc-struct-doc-ref-exports：

> 本表是 doc-ref 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `doc-ref.ts`。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `extractDocRefs` | 函数 | doc-ref.ts | 从 spec 文本提取 `[[文档路径#章节名]]` 入 AST（parser 期） | stable |
| `resolveDocRefs` | 函数 | doc-ref.ts | 运行期读文件+章节切片+大节按通道三档处置（deflate/预览/全量,engine 调） | stable |
| `checkDocRefExists` | 函数 | doc-ref.ts | P15 静态存在性校验（validator 调） | stable |
| `formatDocRefContext` | 函数 | doc-ref.ts | 渲染 L2d doc-ref context（engine 调） | stable |
| `DocRefError` | 类 | doc-ref.ts | 文件/章节找不到时抛出（engine failStep 消费） | stable |

> **内部（表外即内部）**：`sliceSection`/`sliceYamlKey`/`sliceByFileType`（切片算法族，被 resolveDocRefs/checkDocRefExists 内部调——export 仅为测试可达,非模块出口）、正则常量 `RE_DOC_REF`、`RE_KEY`（键行判据）。

## doc-ref 文档引用解析【契约】 ^anc-exec-doc-ref-resolve

doc-ref 解析归 **engine**（`assembleBasicContext`），不在 dispatcher——因为它必须在**两种模式都生效**。

**为何挂 engine 而非 dispatcher（架构修正）**：dispatcher 是**独立模式专属**驱动适配层（[[step-dispatcher]]：「复用模式不经过本组件」）。doc-ref 是 spec 的**硬契约**（spec 作者用 `[[]]` 钉定的必读知识，不是可降级的可选增强）。

- 若挂 dispatcher，则复用模式（CC 直接驱动 hopjit CLI，hopspec 的主用法）的 `step_ready.context.doc_ref_context` 永远为空，doc-ref 在主路径上等于不存在。故解析下沉到 `engine.assembleBasicContext`（`nextStep` 内、两模式共享的 context 组装基座），与 confirm/ask paused 组装、失败升级同层；
- 对比：`injectKnowledge` 留在 dispatcher 是合理的——它是 async provider 调用 + **可降级**（无 provider 则 L2 空），复用模式 caller（CC）自带知识能力可自行补；doc-ref 是 **sync 文件读取 + 不可降级**，必须引擎侧保证。

> **变更记录（已修正）**：期一初版误挂 dispatcher（`injectDocRefs`），e2e 实测复用模式 doc_ref_context 恒空。已修正为 engine 侧 `resolveStepDocRefs`，dispatcher 不再有 doc-ref 逻辑。此为历史沿革（非待办债）。

**为何不挂 PromptAssembler**：PromptAssembler 是纯组装层（无 I/O，数据经 EngineAccessor 注入）。doc-ref 需文件读取，engine 本就持有 `hostConfig.workspace_dir` + `sandbox` 且已做 I/O（persist/work_zone），是 I/O 的自然归属；PromptAssembler 保持纯净。

**解析流程**（engine `resolveStepDocRefs(step, context)` 调纯函数 `resolveDocRefs(refs, workspaceDir, sandbox, workZone, hopEnv?, specDir?, inlineMode?)`，模块 src/doc-ref.ts）：

1. **收集 refs**：spec 级（`spec.header.doc_refs`，对所有步骤可见）+ 步骤级（`step.doc_refs`）合并去重。
2. **路径解析 + sandbox 校验**：Obsidian 习惯省 `.md` 后缀 → 每个候选位先试原名，再试 `+.md` 兜底；禁字面绝对路径/`..`，读一律走 `validateReadAccess` 权限链（denied 基线对任何候选位同拦）。**解析基准两级（2026-08-20 作者定——目录概念三层归位：spec 目录=自包含单元/workspace=作业对象根/work_zone=引擎内务）**：
   - **第一级 spec 目录**（`dirname(specPath)`）：spec 自带材料（同住知识文档）随 spec 走——hopbuild primer、audit knowledge、pack 产物的 spec.md+知识文档全是"知识文档与 spec 同目录"形态，spec 是自包含分发单元，其自带引用不依赖 caller 从哪启动。两处同名时 spec 目录赢（自包含语义）。specPath 缺席（内存态引擎/片段校验）跳过本级；
     - **但子实例必须继承父的 specPath**；call 子实例 spec 另有其人时传 callee 自己的路径〔SpecProvider 源〕，parallel subtask 子实例=同一份 spec 传父的；
       - 实撞出处（2026-09-01 第九跑）：dispatcher 三处子实例 init〔parallel subtask/parallel call/串行 call〕全漏传，子实例 specDir 缺席致 doc-ref 校验只剩 workspace 根基准，anchor-audit 的 11 个语义批 init 全灭〔知识文档住 scripts/audit/ 与 spec 同目录，父实例好的、子实例全找不到〕；
   - **第二级 workspace_dir**（作业对象根）：业务材料按 workspace 相对路径解析（`resolveWorkspacePath`）。
   - **spec 目录读授权（随 spec 引用即授权,与 hop_env"写参即授权"同款）**：spec 目录可在 workspace 外（如全局装的 skill 目录），initExecution 组合点把 `dirname(specPath)` 并入 sandbox read allowed（绝对路径、去重）——caller 显式递了 spec 路径即授权读其同目录材料；denied 基线（`.env`/`*.key` 等）仍优先拦。
   - 两级全不命中报「文件未找到」（P15 报文/运行期 failStep 都会响亮）。库外/绝对根业务材料照旧用 `{hop_env_*}` 环境参数（声明即授权读,见 [[#^anc-exec-doc-ref-hop-env]]）。
3. **章节切片**（`sliceSection(lines, section)`——Markdown 档）：
   - 扫所有 ATX 标题（`RE_HEADING`），跳过 ``` fence 内伪标题（inFence 翻转）。**实况如实记**：`RE_HEADING`/`RE_FENCE` 不是从 parser import 共享——doc-ref.ts:21-22 与 parser.ts:19,29 各持一份同值定义（parser 的正则是模块内常量未出口）。**对账义务**：改任一处的标题/fence 判据须同步另一处，否则"parser 认的标题 doc-ref 切不到"这类分裂静默出现。
   - 三级匹配（命中即停）：**a 精确**（heading.text trim 全等 section）→ **b 归一化**（剥中文/数字序号前缀后相等：`normalize("二、色板")="色板"`、`normalize("4.7 统计框")="统计框"`；保守剥离，避免"第三方"误剥）→ **c 子串包含**（兜底，多命中取首 + 切片结果标 ambiguous——切片层如实记录,当前无上层消费者不产生 warn,与 YAML 档 b 级同口径）。
   - 切区间 `[命中行+1, 下一个 depth ≤ 命中 depth 的标题行)`，EOF 兜底。子标题包含在内（切 `## 二、色板` 带其下 `### 2.x`；切 `### 4.7` 不越界到 `### 4.8`）。
   - 同文件被同步骤多次引用 → 文件只读一次（按 path 缓存 lines），切多次。

3b. **YAML 键切片**（`sliceYamlKey(lines, section)`——目标文件扩展名 `.yaml`/`.yml` 时走本档,Markdown 档不受理 YAML）： ^anc-exec-doc-ref-yaml-slice
   - 缘起（R10 sandbox 实撞,2026-09-08 作者拍"做"）：结构化规则表存 YAML 是 skill 语料常态（故障知识库/检测器注册表/部署规则）,原先锚点只认 Markdown 标题,`[[teardown-faults.yaml#teardown_procedure]]` 报 P15"章节未匹配",只能整文件注入（1200 行灌上下文）或降级散文指路（失去静态校验与确定性注入）。
   - **行级切片,不走解析-序列化**：直接在原文本行上定位键行、按缩进切区间——保留注释（YAML 规则表的语义大量住块注释里,如"铲除铁律";js-yaml 解析会丢注释）,且与 Markdown 切片同为行区间算法零解析歧义。js-yaml 不参与切片。
   - **键行判据**（精确定义,常数权威=代码 RE_KEY）：顶格或缩进的 `键:` 形态行,五个要件全满足才算——
     - ①键名首字符非空白非 `#` 非冒号（`#` 开头是注释行不是键）;
     - ②引号键 `"k":`/`'k':` 剥引号后同判;
     - ③**冒号后须是空白或行尾**（`foo:bar`/`http://x` 这类冒号后紧跟字符的行不是键行——两批 review 抓设计字面正则缺此半截,照旧文实现会把 URL 判成键）;
     - ④**序列项行不是键行**（`- ` 开头或裸 `-` 的行是序列的值内容——业界实践对照调研抓"零缩进序列"坑后补:YAML 允许序列项与父键同列（`steps:` 下一行顶格 `- name: x` 合法且是 GitHub Actions/K8s 清单最常见写法）,不排除则 `- name` 成伪键、缩进≤父键即当出块边界,**切片在首个序列项处静默截断**——本清单唯一"键存在但区间切错"的形态,P15 兜不住;序列项内部的 `name: x` 缩进恒比父键深,照常入键表不受影响）;
     - ⑤fence 概念 YAML 无,不设 fence 跳过（块标量内容行若恰呈 `k: v` 形态会入键表——已知共同决定,真实撞再议;plain scalar 折行呈 `k: v` 同族同议）。
   - **已知放弃项（读侧注入用途的有意边界,业界对照调研 2026-09-08 定稿）**：flow style 行内映射 `{a: 1}` 不展开;多文档分隔 `---` 不识别;tab 缩进畸形文件不救;复杂键 `? :` 形态不可寻址（查找 miss,P15 红——失败显式）;锚点/标签前缀键（`&a k:`）查找 miss 同显式;别名值 `k: *ref` 切出引用行本身非展开内容（CST 解析库同样无解,消费侧知悉）。
     - 选型依据:读侧切原文行区间与 VS Code YAML folding 同算法（缩进判据,官方 offSide 策略）,保注释目标下解析-序列化路线自身注释保真有成堆已知缺陷（go-yaml/ruamel 注释归属 bug 群）,"不解析所以不丢"成立;引 CST 库只省"找键行"半件事,"含注释的原文区间边界"仍要自定。
   - **两档匹配（按锚点形态分派,不级联回退——两批 review 抓"命中即停"级联措辞误导后改）**：
     - 锚点含 `.` 走 **a 点路径精确**（`#外层键.内层键` 按点拆段逐层下钻——每段限上一段区间内的**直接子级**〔区间内全部键的最浅缩进=子级层,命中键须恰在该层〕,全路径命中才算,失败不回退 b 档）;
     - 不含 `.` 走 **b 单键名深度优先首命中**（`#键名` 全文档按行序找首个同名键行,不限层级——作者不必写全路径;多命中取首 + 切片结果标 ambiguous。ambiguous 是切片层的如实记录,当前无上层消费者——DocRefFragment 不携带该字段,不产生 warn;要消费须先扩片段类型,挂账不空头承诺;单命中 matched=exact 不标 ambiguous）;
     - **已知限制**：键名自身含 `.` 的字面键（引号键 `"a.b":`）会被分派进 a 档按路径拆解,当前不可寻址——要引用这类键,改键名或整文件注入。
   - **切区间** `[键行, 下一个缩进 ≤ 键行缩进的键行)`,EOF 兜底——**键行自身包含在切片内**（与 Markdown 档"命中行+1"不同:YAML 键行携带键名与行内值,`k: v` 单行键值切掉键行就没了;注入片段以键行开头,读者可见完整 `键: 值` 结构）。键行之上紧邻的连续注释行（属该键的文档注释,如条目头的说明块）一并带入——注释归属判据:与键行之间无空行阻隔的紧邻 `#` 行块。
   - 匹配失败 → `matched: 'none'`,P15/运行期报文与 Markdown 档同款"章节未匹配"。
   - 候选路径：`.yaml`/`.yml` 后缀不追加 `.md` 兜底（candidatePaths 按扩展名分流;**扩展名判定大小写不敏感**——`.YML`/`.YAML` 同罩,两批 review 抓测试钉了设计没写的行为后补）。
   - **切片结果字段（SliceResult,YAML 档语义——类型约定,两批 review 抓 HopType 缺席后补）**：`heading`=命中的键名（剥引号后;Markdown 档此字段是标题文本）;`content`=切出的行区间文本（键行+子树+上方紧邻注释块）;`matched`=a 档命中恒 `exact`,b 档单命中 `exact`、多命中 `fuzzy`,未命中 `none`;`ambiguous`=仅 b 档多命中时置 true。
   - deflate 卸载/渲染/缓存与 Markdown 档同管线（切出的是文本行,下游零分叉）。
4. **大节处置按通道分三档**（resolveDocRefs 末参 `inlineMode`,2026-09-23 todo/0115 由布尔 inlinePreview 扩为三档）：
   - `inlineMode` 缺省（agent 通道,复用模式）:单章节超 `DEFLATE_THRESHOLD` → 写 `workZone/docref/<doc>__<章节>.md` 返 $file 指针（deflate 卸载）；workZone 空串时内联全文；
   - `inlineMode='preview'`（standalone,本步下发面含 read）:超 `INLINE_PREVIEW_MAX` → 全文落 `workZone/docref/`,片段带头部节选 `preview` 与 `full_chars`；不超则全文内联；
   - `inlineMode='full'`（standalone,本步下发面没有 read）:无论多大一律全文内联,不产指针不产预览——读不了文件的步骤拿到"全文在某文件"是死路（判定与权威 [[step-dispatcher#^anc-exec-llm-inline-context]] v3）；
   - inline 两档都不得落进 deflate 分支（落进去就产 $file 指针,BUG-H 复发）;调用方 engine.resolveStepDocRefs 按 `stepDeliversReadTool(step)` 选档,与 L4 输入预览同一判定。
   - **空 workZone 边界的实况**：引擎侧两个持久化实现的 `getWorkZone()` 恒返回非空——FilePersistence 有 instanceDir（src/persistence.ts:165-167），MemoryPersistence 首次调用惰性在 tmpdir 下自建（src/persistence.ts:235-245）——所以 resolveDocRefs 的空串分支（deflate 与 preview 两档的 `workZone &&` 判定）是防御性留置，引擎生产路径不可达。
5. **渲染**：`formatDocRefContext(fragments)` → 写 `context.doc_ref_context`（L2d，渲染契约见 [[prompt-assembler#^anc-exec-doc-ref-injection]]）；流控来源记 HopLog `doc_refs` 字段。

**找不到即硬报错**（对齐概念"确定性精确引用"，[[../concepts/HopSpec V3核心规范#^anc-exec-doc-ref]]）：文件不存在 / 章节无匹配 / sandbox 拒读 → `engine.failStep(step_id, ...)` 走标准升级链，**不静默降级**（区别于 lack_of_info 的 graceful degrade——doc-ref 是作者钉死的硬依赖，静默会埋雷）。
**正常情况下 P15 已在加载期拦截**（[[spec-parser#^anc-rule-p15]]），运行期 failStep 是兜底（文件加载后被删、或 P15 因无 workspace 跳过的场景）。

**组装 catch 两义务（2026-08-14 BUG-F 补定）**：nextStep 的 context 组装 catch 罩的不只 doc-ref（还有输入 deflate 写盘/知识注入）——

- ①报错标签**按异常真身分型**（DocRefError 才标 doc-ref,其余标"context 组装失败",不许一律冒充 doc-ref——deflate ENOENT 被误标曾把排障方向全带歪）；
- ②失败**必须留痕 HopLog**（本 catch 在 recordStepStart 之前,不补 start+failed 两笔则失败被孤儿门拦、日志零痕迹——"步骤从未 start"的静默死假象即由此来）。

**与 @knowledge 正交**：doc-ref 不依赖 `knowledge_provider`（文件读取是引擎自带能力）；同一步骤可同时有 L2 知识（dispatcher 富化，仅独立模式）和 L2d doc-ref（engine 富化，两模式），两者写不同 context 字段，互不干扰。

## hop_env 环境参数展开【契约】 ^anc-exec-doc-ref-hop-env

概念权威 [[../concepts/HopSpec V3核心规范#^anc-config-hop-env]]（命名空间/覆盖链/只读语义）。doc-ref 路径位是 `{hop_env_*}` 的**唯一引擎展开位**（面最小原则——instruction 不展开值表随 prompt 注入,body 走 Python 自身 f-string）。

**展开实现（解析流程第 2 步前插一步"步骤 1b"）**：
- **时机=注入期**（resolveDocRefs 入口）,值来源=引擎持有的 hop_env 表（HostConfig.hop_env,组合根按覆盖链合成——配置两级合并→params 覆盖→ask 回填经变量空间同步）;
- **文法**：`\{hop_env_[a-z0-9_]+\}` 形态替换为对应值;`\\{`/`\\}` 反斜杠转义为字面花括号（先扫转义占位再替换变量,最后还原字面——三段式防转义内容被误替换）;其余字符原样;
- **未定义键=响亮报错**：引用的键不在 hop_env 表 → 该步 failStep（HOP_ENV_UNDEFINED,报缺的键名与可用键清单）——不静默空串（空串拼路径是找错文件的温床）;
- **展开后再走既有链**：sandbox 校验照旧吃展开后的路径——hop_env 值指向 workspace 外时按 read_access 规则判（写配置即授权的定性=hop_env 声明的根**自动入 read allowed**,组合根合成表时同步扩沙箱读白名单——授权面与声明面同一动作,不分叉）;
- **P15 静态校验分档**：字面引用照旧 validate 期查;含 `{hop_env_*}` 的引用在 hop_env 表可得时（engine init 期经 HostConfig 带表——裸 `hopjit validate` 无配置面,恒走缺席档）展开后查,表缺席时跳过并推 **info 级注记**（"含环境参数,注入期核"——不假绿也不误拒,留痕非静默）。

**正反例**：展开命中注入成功/未定义键响亮报错列可用键/转义字面花括号原样/hop_env 根外路径经 read allowed 放行+未声明根照拒/P15 两档（配置在场静态查中缺文件/缺席跳过不误拒）。
