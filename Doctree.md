%% @trace
	id: hoplogic-doctree
	type: intent
	note: 本库的文档索引 + 源-派生关系树（SSR DocTree）。新增/移动/删除文档时必须同步本文件。
%%

# SSR DocTree — hoplogic 文档索引

> 命名三层：**HOP 3.0**＝HOP 语言/概念层 v3.0；**hoplogic**＝HOP 官方项目（本库）；**HopJIT**＝hoplogic 里的 HopSpec 执行引擎。

本文件回答两个问题：**库里有什么文档**（每份附一句话表述，读者据此决定要不要展开细读——即"渐进展开"：先读一句话，需要时才读全文，再需要时沿链接与锚点深挖），以及**文档之间谁派生自谁**（SSR：Source-derivation Relation，源—派生关系），用于一致性审查与衍生同步。

**主线（读的顺序骨架）**：全库文档按**十站主线**组织阅读顺序——①工程实现链规范（元规范）②核心创新+核心规范（定位）③HopType（架构语言）④ARCHITECTURE（架构）⑤module-principles（模块规范）⑥本文件「模块索引」（15 模块收链）⑦chain-enforcement（守卫与人的职责）⑧⑨⑩安装/使用/hopskill 构建（tutorials 01-03）。各站读法见 [[D0-生态开发者导读]]；README 有最短投影。本文件是**地图**（有什么、在哪、谁派生谁），主线是**路线**（按什么顺序读）——两者正交。

**两类读者、两套根（2026-08-06 作者定：根要讲清楚）**——同一个库，人和 agent 从不同的根进入，各有各的入口链，别拿错门：

|         | **人（读者/维护者）**                                                                                                                                                                 | **Agent（执行实现的 LLM）**                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **根**   | `README.md` → 三条主线（懂它/用它/维护它）                                                                                                                                                 | **三根**：本文件 **Doctree**（地图——有什么、锚点在哪、谁派生谁）· **工程实现链规范**（元规范——怎么作业：收链/设计先行/决策 vs 推演）· **chain-enforcement**（守卫链——什么被守着、越线什么会红、八件单/准入四步） |
| **共同根** | **`ARCHITECTURE.md`**（2026-08-07 作者定）——人与 agent 的共同根索引：人从它读懂系统骨架（分层/组件/双态分布），agent 从它收架构级链（分层桥接点=豁免封闭集、`^anc-string-escape` 等跨切面契约、设计层 @trace 派生链的源）。架构是两类读者共享的同一事实，不该也无法拆成两份 | 同左                                                                                                                                    |
| 汇聚点     | —（README 自身就薄）                                                                                                                                                                | `CLAUDE.md`——会话自动加载的**摘要+指针**，非权威源：内容全部指回三根，冲突时以三根为准                                                                                  |
| 想理解     | 导读十站（[[D0-生态开发者导读]]）逐站读                                                                                                                                                       | 不通读——从 Doctree 定位模块/锚点，按任务**收链**（锚点反查 + TRACEABILITY 卡片，按需取用）                                                                         |
| 想使用     | tutorials 01-03 + `USAGE.md` 速查                                                                                                                                               | driver skill（hopspec/hopbuild——agent 的"使用文档"就是它的系统提示）                                                                                 |
| 例行操作    | `maintainers/RELEASING.md`（提交/发版检查单，每次照走）                                                                                                                                     | chain-enforcement §1c-2 模块八件单、§6 准入四步、§4 时机表                                                                                          |

分工原则：**人的文档管"读了能懂/照着能做"，agent 的文档管"收链能定位/边界能机检"**——内容重叠时权威只有一处，另一处是摘要或投影（例：模块八件单权威在 chain-enforcement §1c-2，CLAUDE.md 仅汇聚摘要；RELEASING 分诊表仅人侧核查项）。README 属人侧呈现；ARCHITECTURE 是唯一的共同根（见上表——架构事实两类读者共享，另有设计层 @trace 派生链源的角色，服务一致性审查）。给人的文档别堆锚点行话，给 agent 的文档别写叙事铺垫——受众判定先于落点选择（2026-08-06 两次实撞教训：八件单先后错放 RELEASING（人的手册装 agent 纪律）与 CLAUDE.md（汇聚点当权威源））。

**SSR 规则**：
1. **源文档是唯一权威**——源与派生不一致时，以源为准；
2. **修改方向默认向下**——先改源，再按 `@trace type` 同步派生；反向修正须先与作者确认；
3. **派生关系由各文件头部的 `@trace` 注释声明**（`source_id` 稳定锚点 + `type: intent|compact|present|extract|extend|analyze`，完整约定见 [[CLAUDE]]），本文件只做汇总视图、**不是第二真值**——冲突时以各文件 `@trace` 为准；
4. **concepts 边界**：`docs/concepts/` 是概念层文档的**受控快照**——由维护者在库外维护、单向同步入库。本库内任何文档不得成为 concepts 的源；发现 concepts 内容问题，报维护者修源后重新快照（唯一例外：机检抓出的格式违规可就地修，同时报维护者同步源）。

---

## 顶层结构

```
hoplogic3/
├── Doctree.md          ← 本文件：文档架构总图（新增/移动文档必须同步）
├── README.md           ← 对外门面：是什么、装什么、怎么跑
├── USAGE.md            ← 中文上手指南（装引擎→装 skill→跑 spec）
├── STATUS.md           ← 当前状态快照（版本/健康度/在做什么/欠账）
├── todo/               ← 内部事项卡与主题计划，目录即索引；格式见 todo/README.md，已完成事项见 todo/archive/
├── CLAUDE.md           ← Agent 工程约定（实现链纪律、机检入口、目录说明）
├── ARCHITECTURE.md           ← 架构总览（引擎核心 + 双模式驱动适配层）
├── TRACEABILITY.md     ← 锚点五层追溯卡片（概念→设计→代码→测试）
├── maintainers/        ← 涉内部源的维护者文档（RELEASING.md 操作手册 + git-repo-topology.md 四仓规范;目录恒不入公开快照与 npm tarball——顶层白名单默认拒绝,verify 验证不在场）
├── docs/
│   ├── WORKAROUNDS.md  ← 外部载体缺陷登记（症状→根因→绕行→撤销条件；换机/升级载体先读）
│   ├── concepts/       ← 概念层（维护者快照，库内只读）
│   ├── design/         ← 设计层（本库活文档；rounds/ 存设计草案与提案）
│   └── tutorials/      ← 教程两系列（00 分流页；用户系列 01×2 入口+02-07 主线+08-10 进阶应用〔MCP接入/重规划/hop日常〕；开发者系列 D0-D8：导读/用AI做工程×2/架构/错误模型/HopLog/工具开发/配置/Obsidian可视化）
├── audits/             ← 全链审计存档（按跃迁维度：S2D/D2C/C2T/chain/quality，契约见其 README）〔内部开发面——GitHub 快照暂不含,后继开放〕
├── driver/             ← ⭐ 驱动载体多态：每个 LLM 载体一套等价驱动指令（见下方专节）
├── editors/            ← 编辑器可视化插件（obsidian/——折叠/大纲/落点高亮;独立构建不入引擎包,design/obsidian-plugin.md）
├── skills/             ← 分发 skill 聚合（随包出厂装用户 skills 目录;与 driver/ 载体多态正交。hopbuild=NL skill 形态〔2026-08-25 作者定,自举翻案——spec/expand-node 迁 obsolete,与 hopbuild2 构成散文纪律 vs 引擎强制双形态对照〕,hopbuild2=hopspec skill 形态）
│   ├── hopbuild/       ← 构建器 v1（**NL skill 形态,2026-08-25 自举翻案**——SKILL.md 自足七步流程散文+hopbuild-primer.md 知识附件;spec/expand-node 退役迁 docs/obsolete/hopbuild/;design/hopbuild.md ^anc-build-bootstrap 翻案条）
│   └── hopbuild2/      ← 构建器 v2 完整 skill 五件套（SKILL.md 壳+spec.md 主流程+split-node 判定器+split-structure 结构执行机+split-patterns 知识库;design/hopbuild2.md ^anc-build-layout2,2026-08-25 作者定构建成完整 skill——install-skill 与 tarball 随 v1 同批分发,触发词 /hopbuild2）
│   ├── hopspec-skill.md    ← CC 载体主驱动（部署副本在用户 .claude/skills/）
│   ├── hop-skill.md        ← /hop 随手命令（2026-08-26,恒复用模式主对话自驱——todo plan 升格/进展有账/中断可续/主动 replan;与 /hopspec 分工:成品重编排/随手轻自驱）
│   ├── references/         ← CC 执行细则共享（其中 cli-discovery.md 各载体共用）
│   └── codex/              ← Codex 载体（main + 两类 agent；无 subagent 时 inline fallback）
├── src/                ← HopJIT 引擎（21 个 TS 源文件，@a: 代码锚点；见下方源码层专节）
├── tests/              ← vitest 测试（34 个 *.test.ts，@v: 测试锚点）
├── examples/           ← 可执行 spec 范本 + doc-ref 知识文档（纯演示）
├── scripts/            ← 机检守卫（chain-health / check-* / run-audit）+ audit/ 审计工具链（anchor-audit/test-coverage-audit spec+知识文档+scan/cross_compare+standalone 化五件 prep_env/make_batches/tally_batches/write_artifact/write_batch，2026-08-08 自 examples/ 迁入；+test-coverage-audit 配套 collect_coverage.py 四子命令，2026-09-01 双模式化批新建；见守卫脚本专节）
```

**文档分层与实现链的对应**：`docs/concepts/`＝概念层（S）→ `docs/design/`＝设计层（D）→ `src/`＝代码（C）→ `tests/`＝测试（T）。跨层追溯靠锚点（`^anc-*`/`@a:`/`@v:`），汇总于 TRACEABILITY.md。守卫体系见 [[chain-enforcement]]。

## ⚖️ 元规范：工程实现链规范（先于一切文档）

**`docs/concepts/工程实现链规范.md` 是本库全部文档与代码工作的元规范**——上面那条"概念→设计→代码→测试"的四层结构、每层的职责边界、跨层追溯的锚点机制，都由它定义。它不是概念层的普通一员，而是**其余所有文档赖以组织的规则本身**：

- **行为宪法两条红线**（违反即错）：收链前置（动手前先收锚点实现链）、设计先行（改 `src/` 前对应 `docs/design/` 必须先改定，禁止跨层直达）
- **内容宪法**：命名忠实、比喻只解释不指代、锚点对齐、推演链显式
- **Agent 作业协议**：决策 vs 推演的分界——可推演的直接做，真决策点才提请人拍板
- **机检落点**：这些纪律的自动化守卫映射见 [[chain-enforcement]]（设计层），统一入口 `npm run check*`

**任何 Agent / 贡献者动手改本库之前，必须先读它**（CLAUDE.md 的约定即是它的摘要）。下面各节的文档分类，全部以它的分层定义为准。

---

## docs/concepts/ — 概念层（维护者快照 ×16）

> 概念层的编写与演进在库外（维护者工作区），本库存放其受控快照，各文件 `@trace` 标注派生关系。**库内不修改**（发现内容问题→报维护者修源→重新快照）。唯一例外：机检抓出的格式违规（如锚点缺空格）可就地修，同时报维护者同步源。

| 文档 | L2 表述 | 派生角色 |
|---|---|---|
| HopSpec V3核心规范 | 语言概念权威——15 种步骤类型、执行模型、验证规则、`^anc-*` 锚点源头 | **源**（本库多数设计文档的上游） |
| HopSpec V3配套HopJIT运行时能力 | 引擎运行时能力契约——模式无关原则、driver 角色分工、durable resume | 源 |
| HopSpec V3扩展-有序思考与渐进固化 | 无 Steps 能力声明的探索验证闭环，"动态→候选→沉淀" | 源 |
| HopSpec V3扩展-可观测性与YAMLL日志格式 | YAMLL 立为跨载体观测标准——格式不变量与保证属性 | 源 |
| HopSpec V3错误模型 | 错误分类与传播语义 | 源 |
| HopSpec V3扩展-事务与补偿 | commit 失败处理的两种扩展模式（saga 补偿/事务边界） | extend（源=核心规范） |
| HopSpec核心创新 | 核心创新独立阐述（从核心规范定位章提取） | extract（源=核心规范） |
| HopSpec-prompt-author | Spec 作者构建速查卡（LLM system prompt 用 compact 版） | compact（源=核心规范） |
| HopSpec V3语法参考 | 完整语法便查手册（标准语法 + 大纲语法变种），§0 设计理念 | compact（源=核心规范） |
| HopSpec V3 Prompt组装参考 | 6 层 context 组装机理专题（三层不重叠/大内容卸载/介入请求） | extract（源=核心规范） |
| HopAnt概念-双态组件模型 | HopAnt（曾用名 CyAnt）双态融合在组件级别、两个部署形态（HopSkill/HopAgent）、HopSpec 作为组件间接口语言 | 源 |
| HopType体系 | HopType 双态组件类型体系；Hop 概念三件套定位地（Hop契约 HopTrait / Hop类型 HopType / Hop作业流程 HopSop） | 源 |
| **⚖️ 工程实现链规范** | **元规范，先于其余一切文档**（见上方专节）——四层职责边界、宪法级原则、Agent 作业协议 | **源（全库工程纪律的最高权威，动手前必读）** |
| **⚖️ 工程实现链-模块规范** | 模块级概念权威（2026-08-08 自元规范收拢）——定义/唯一动机/六条本质要求/内容次序/必备件两组九件/生命周期 | extract（源=工程实现链规范）；module-principles 是其本库操作化 |
| **⚖️ 工程实现链-守卫规范** | 守卫级概念权威（2026-08-08 单立）——腐坏默认无声/五原则/测试层守卫侧/失效对治兜底 | extract（源=工程实现链规范）；chain-enforcement 是其本库操作化 |
| HopSop标准作业流程 | Hop 标准作业流程（SOP 供人作业、升格为 HopSpec 供机执行）——HopSpec 无执行态真子集（三容器+编号+自然语言流控），设计文档关键任务流程的缺省表达档；曾名"HopSpec V3结构化流程表达" | 源（HopSpec 文档系成员） |

## docs/design/ — 设计层（本库活文档 ×27）

> 各文档开头自带"文档结构与内容分级"表（【决策】/【契约】/【说明】）。此处只给 L2 表述。

**引擎核心**：

| 文档                 | L2 表述                                                               |
| ------------------ | ------------------------------------------------------------------- |
| spec-ast           | AST 类型词汇表 + 语言运行时基础（VariableStore/作用域/真值语义），全员依赖                    |
| spec-parser        | SpecParser + 39 条验证规则（S/C/V/P/B 系列）                                 |
| exec-engine        | ExecutionEngine 状态机——步骤推进、retry/adaptive、None 传播、崩溃恢复、并行 fan-out 调度 |
| prompt-assembler   | PromptAssembler 6 层 context 组装 + worker 子树视图                        |
| act-body           | hop_python 受限编排语言（parser/interpreter/builtins）                      |
| doc-ref            | `[[文档路径#章节名]]` 确定性引用——解析、切片、注入                                        |
| persistence        | 状态快照存取（FilePersistence/MemoryPersistence + for-each worker 参数通道）    |
| parallel-execution | parallel 统一模型（§U 现行权威：步骤级异步派发+容器边界收齐+杀活+测试矩阵）+ 旧通道退役期存档（子实例隔离、fanout 顾问、join merge） |

**驱动适配层**：

| 文档 | L2 表述 |
|---|---|
| hop-cli | CLI 命令表 + JSON I/O 契约 + install-skill + 状态加载语义（load/recover 分野） |
| step-dispatcher | 独立模式 StepDispatcher——模型路由、凭证、暂停语义（含 pause-timeout v1 偏差） |
| mcp-server | standalone 执行的 MCP server 形态——四工具面（start/status/resume/list）、job 式异步、HITL 常驻进程解跨进程死结、key 隔离（2026-08-06 作者拍板 MCP 方案，CLI standalone 缓做） |
| tool-interface | 工具接口标准与绑定机制（2026-08-12 批次一立卷）——第一层 ToolSpec（name/alias/schema/shape/requires_commit/unwrap）+ tool_servers 注册文法 + 双端校验（shape 异常入 adaptive 阶梯，作者定）+ 第二层绑定两档（in-process 凭审计资格/mcp 最小子集）+ CompositeToolProvider 装配 |
| tool-channels | 工具调用通道总览（2026-08-12 作者要求成文）——五条物理路径一张表（body 内置/body 非内置双模式/LLM 循环/缺省文件工具）+ requires_commit 横切 + server-side search 等相邻物定界；权威留原锚点 |
| llm-error-handling | LLM 节点错误处理总览（2026-08-31 作者要求成文）——失败信号六站旅程一张表（截断/解析阶梯/lack_of_info 分流/校验恢复/check 判定/容器升级链）+ lack_of_info 全链契约 + subtask-retry 生命周期与 prompt 供给逐拍对照 + fail_kind 表 + 雷区台账；权威留原锚点 |
| standalone-mode | standalone（独立模式）统一设计（2026-08-11 作者定"本质上是一个统一接口端，需要统一的设计和审查"）——配置/凭证/选定/工具/参数组装四份文档各管哪块的地图 + 整体必须守住的五件事（跨文档约束，单看一块推不出）+ 改动时的六问审查 |
| reuse-mode-prompt-flow | 复用模式两层提示叠加 + 进程模型 + 三要害风险 + /hop 自驱四之补三/四（阅卷分权与知识供给、提纯与现货复用）（落点在 driver 层，见文档头声明） |
| codex-driver-carrier | Codex 载体逻辑三角色 + 按当次 effective config 通信握手选择 delegated/inline + envelope/错误边界 + fanout/barrier + 真机验收矩阵 + **开发规约十三条**（改 driver/codex/** 前必读） |
| carrier-live-e2e | CC/Codex 真实载体 E2E：隔离工作区、事件归一、执行体归属、凭证防泄露、显式失败与 opt-in CI |
| i18n | 国际化设计——文档镜像树 docs/i18n/<lang>/ 三纪律 + spec 关键词双语直通（方案 B）+ 关键词保留字族（术语表五轮定稿 2026-08-15） |
| hopbuild | 构建器设计（2026-08-15 自举批立卷）——自举形态决策（spec 权威散文退役）+ 分发布局（pack 产物形态+双源同步守卫）+ 知识源三层 + 五关落位如实边界 + 参数原则分两层（spec 层 I/O 判归属↔壳层 ^anc-cli-pack-shell） |
| hopbuild2 | 构建器新设计（2026-08-21 作者立卷,五件套成稿于 skills/hopbuild2/——SKILL 壳+主流程+分拆器两分体+范式库,真机淬炼 D 系列机械防线持续演进〔现行版本见文内版本行〕）——类 LLVM pass 递归等价分拆:NL node 逐遍消解为 hop node,判定序 顺序>分支>循环>原子（判完一个返回一个）,载体=call 递归+独立 check 三检+拼装终核;终态两档（全 hop 化/含未尽原子——工具面依赖档 D94,整验不过诚实降档）;范式库知识供给;v1 保留在场对照 |
| deep-validate | 跑前深检设计（2026-09-01 作者两拍立卷,缘起 anchor-audit standalone 化十跑九坑）——validate 的深化档:validate 管静态文法/deep-validate 管运行期假设快检（说明语义×执行环境能力面对照,LLM 推理判）/anchor-audit 管逐锚点全量审计,三层分工;fast 三硬约束（LLM 调用 O(1)/输入控量三件零源码翻查/分钟级）;不阻断建议性报告;载体=scripts/deep-validate/ hopskill spec+判据台账知识文档（五面活资产） |
| hopfix | 定向修正工具设计（2026-09-02 作者点破"应该有一个工具做定向修正,不动辄从头重构"立项,缘起 0036 轮产物 run 外成孤儿只剩重烧 5.6 小时或人肉裸改两条路）——四层分工 造(hopbuild)/查静态(validate)/查运行期(deep-validate)/修(hopfix);三拍板:原地覆盖+快照回滚/三层把关(改动外零变化机械闸+局部合理关+deep-validate 复验指引)/工单双收(自然语言+结构化报告——查-修管道机器对机器);载体=scripts/hopfix/hopfix.md hopskill spec |
| obsidian-plugin | HopSpec 可视化 Obsidian 插件（2026-08-16 方案 C 立卷,Obsidian 优先）——markdown 6 级标题上限之上的步骤折叠/大纲/落点高亮;步骤行识别器与引擎零依赖按语法参考独立实现,层级=编号段数与表面形态解耦 |
| sandbox | SandboxConfig 四维度安全模型（复用模式退化为契约） |
| spec-observability | HopLog 设计——三级日志、审计字段、YAMLL 落盘、流式不可重排 |

**共享与元**：

| 文档                                              | L2 表述                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| shared-types / shared-providers / shared-errors | 共享类型、Provider 接口族、错误码                                                     |
| concept-anchor-rules                            | 锚点命名/语法/类别表/卡片格式权威（含 `^anc-meta-anchor-space` 硬格式）                        |
| module-principles                               | 模块设计与实现原则——健康判据/依赖方向(核心←适配←载体)/拆分触发信号 T1-T5/物理边界 P0-P3 演进（动模块结构前必读，不为拆而拆） |
| **chain-enforcement**                           | ⭐ 实现链机检守卫主线——守卫映射/三类守卫/空白台账/准入规则/健康度入口                                    |
| ci-pipeline                                     | 守卫自动化载体选型（hooks/Actions/npm 生命周期）+ 基线锁定，从属 chain-enforcement，3 决策点待拍      |
| release-engineering                             | 发版工程快照制（2026-09-04 立卷,缘起 0.12.2 三连拦——HEAD 移动靶）——release 启动冻结 SNAP,全检/升版本/publish 对快照 worktree 跑,主区并行不拦;凭证闸对 SNAP 判;收编三拍 cherry-pick+push+push tag;dry-run 演练;scripts/release.sh 的行为权威 |
| roadmap                                         | v1/v2/v3 里程碑路线                                                            |
| tools                                           | 受控工具装配层（成员构成/生命周期/出口边界;各工具组契约归 tools/ 子目录）。**工具家族四切面（interface 声明/channels 消费/tools 装配/tools/ 子目录各件）分工的权威论述在其开头"工具设计面地图"节** |
| tools/file-tools                                | 内置文件/目录工具组十件（读写权限链/写域分域）                                             |
| tools/spec-tree-tools                           | spec 内容工具族六件（读/写/验三面）                                                  |
| tools/dingtalk-notify                           | 钉钉通知出箱通道（第一个 requires_commit=true 内置件;引擎终态挂点共用发送体）                       |

## 根目录文档

| 文档 | L2 表述 | 派生关系 |
|---|---|---|
| README | 对外门面：包名/命令名/文件三层命名、CLI 用法、skill 安装 | — |
| USAGE | 中文上手指南（从安装到跑通第一个 spec） | — |
| reference/配置参考 | 正式配置查阅件（非教程）——四配置位全字段:StandaloneConfig（providers/default_model/routing_rules 系统分档/tool_servers/env）/spec Config 段（models 逐类别继承）/@model 标注/八级解析优先级/常见配方；**对外配置契约权威**（2026-08-13 作者定） | extract（源=shared-providers,与 @trace 一致;字段语义冲突以对外权威为准——设计管实现行为） |
| STATUS | 当前状态快照——版本、健康度、进行中、欠账（**唯一允许过期的文档**，见其头部说明） | 汇总视图（源=机检输出+TODO） |
| ARCHITECTURE | 架构总览——分层/桥接点/组件交互/双态分布（原名 DESIGN.md，2026-08-04 更名消除与 docs/design/ 歧义；模块清单归本文件「模块索引」） | 源（TODO/TRACEABILITY 的上游） |
| TRACEABILITY | 锚点五层追溯卡片 ×203 | extend（源=concept-anchor-rules） |
| maintainers/RELEASING | 维护者操作手册——提交/发版前例行检查与手工验收清单（手册层：每次都用、零叙事、自包含；原理归 chain-enforcement/carrier-live-e2e。2026-09-13 迁入 maintainers/——"手册数 ≥3 迁 docs/manuals/"旧注废止:涉内部源的维护者文档按目录隔离,不按数量） | compact（源=chain-enforcement + carrier-live-e2e） |
| maintainers/git-repo-topology | 四仓路径规范权威——内网真源/GitHub 快照/两 hopissues 通道的方向与纪律、push 分级、恒不公开清单、远期路标（CLAUDE.md Git 节留摘要指针） | intent（2026-09-13 作者定稿） |
| CLAUDE | Agent 工程约定（本库自足版） | — |

## audits/ — 全链审计存档〔内部开发面——GitHub 快照暂不含此目录,链接在公开仓不可达;后继开放〕

> 审计审"层间是否忠实"，目录按**链的跃迁维度**组织（S2D/D2C/C2T/chain/quality）。归档契约（命名带审计执行日、锚定基准 commit、只收人确认的快照）与各维度触发节奏表见 [[audits/README|audits/README]]。现存：2026-05-29 设计评审 r1（quality）、2026-06-05 覆盖率审计（C2T）、2026-07-05 代码质量审计（quality）、spec-observability 评审 r001（quality）。

## docs/i18n/ — 译本镜像树（en ×20）

> 结构与纪律的权威在 [[docs/design/i18n|design/i18n]]（^anc-i18n-docs-tree 镜像树 + ^anc-i18n-translation-discipline 翻译三纪律）。中文在 docs/ 原位作源,译本此处镜像;每份译本 @trace type: translation 指回中文源,**一致性方向恒为译本追源**;文件名译英文 slug（源-译对应靠 @trace 不靠同名）。滞后与死链机检:`npm run check:i18n`（报告不拦）。第一批（2026-08-15,作者纠偏补 D 系列）: en/README + en/tutorials/00-09（11 份）+ **en/tutorials/D0-D6（7 份）** + en/reference/configuration（slug 见各文件 @trace）。逐份 L2 表述不重复登记——与中文源逐一对应,见上下各源条目。

## docs/tutorials/ — 新手教程（用户系列 00-10 + 开发者系列 D0-D8）

> 与 USAGE.md 的分工：USAGE 是**速查**（一页看完装和跑），教程是**手把手**（带预期输出、常见坑、"接下来会发生什么"）。
> **两个系列，00 分流**（2026-08-11 作者定：两类新人两个系列）。**用户系列**（用它跑任务/写 spec）：双载体入口二选一（01-CC / 01-Codex），02-07 载体中立、编号即顺序——读懂 spec（地基）→ 探索与提交（先讲安全）→ hop_python（agent 代写，人读懂核对）→ 并行（效率）→ 实战组装 → 升级 NL skill；08-10 进阶应用（MCP 接入/重规划/hop 日常）。**生态开发者系列**（动 src/design/driver）：D0 十站主线。

| 教程 | L2 表述 | 派生关系 |
|---|---|---|
| **00-新人导读** | 分流页——你是哪类读者：用户走 01-10（附各篇一句话与"读多深"判据），开发者走 D0；判据=改的是 spec 还是 src | extend（源=Doctree） |
| **D0-生态开发者导读** | ⭐ 开发者阅读主线十站——四阶段：定向/顺链读文档/借锚点读代码/第一次改动（Doctree 是地图，它是路线） | extend（源=Doctree） |
| D1-用AI做工程-从概念到设计 | 开发主线上半场——可行域逐层收窄（概念→架构→模块→设计）/每层人拍板 AI 推演分工表/HOP 三件套表达标准（契约锁承诺+类型锁结构+流程锁逻辑=AI 无处发挥）/锚点=驾驭 AI 的缰绳 | compact（源=工程实现链规范） |
| D2-用AI做工程-AIcoding与验收 | 开发主线下半场——行为宪法四条（AI 的硬边界）/派活话术钩纪律/两句标准话术经 /hop 承载（账与续/把关不可跳/独立核验/沉淀复用）/一次改动八步节奏/人的验收=查链不逐行读码/三类失效病理学 | compact（源=工程实现链规范） |
| D3-hopissues与todo的使用〔内部开发面——所述 todo//hopissues 两账在 GitHub 快照暂不含,后继随过程资产开放〕 | 开发者两本账导读——分工一句话（修复方是谁:自己修=todo/,跨项目=hopissues）/共同骨架（文件名即状态机+probe必填+处置记录）/todo/ 三类内容（事项卡/技术债九要素/plan-主题计划三纪律）/hopissues 四差异（fixed≠closed probe复验/署名两段/改卡即推/开工扫描接线 check:fast）/常见判断题五则 | compact（源=todo/README+hopissues README;两处是规则权威,本篇导读不复写） |
| D4-架构讲解 | ARCHITECTURE 教学讲述版——一句话架构（模式无关核+双适配壳）/三个决定性"因为"（推理两处发生/载体会增加/外部须可替换）/一次执行生命线/双态分布=派活边界感/架构级派活三注意 | compact（源=ARCHITECTURE） |
| D5-错误与异常处理 | 错误模型教学讲述版——授权与上报哲学（失败挂结构上）/两条线（错误走状态机,None 无错误语义）/FailRecord 四字段/升级链+四档修复阶梯/[on fail] 失败兜底（耗尽才进/接住即 done/兜底败不再兜/退火与确定性失败直达兜底——高级特性定位先立）/未捕获终止（容忍才要动结构）/parallel 部分失败与批量 HITL 队列（child 要问人=入队逐张应答,等人让名额收齐门照等——0013 能力缺口收口）/call 加壳传播/三个现成 e2e 场景对应 | compact（源=HopSpec V3错误模型+parallel-execution U4b） |
| D6-用HopLog诊断 | 诊断实用篇——目录即导航（run_id/trace_id/instance_id 三 ID 分工）/YAMLL 块三分钟读法/六个常见诊断问题查法（挂哪步/谁算错/LLM 看到什么/卡在哪/谁答的/哪个 child）/与 state.json 分工/审计无级别豁免 | compact（源=可观测性与YAMLL） |
| 08-接入MCP服务 | 用户进阶——配置 tool_servers 节注册两形态（云端 http/本地 stdio）/body 按名调用（spec 零感知）/六条保护性规矩（白名单/凭证不落盘/requires_commit 声明侧权威/执行主权单向/故障=步骤失败零新通道/调用名全局唯一） | compact（源=tool-interface ^anc-config-tool-registry） |
| 09-有序思考与subtaskfree | 用户进阶——还没想清楚的活交给引擎：为什么有的活写不出完整步骤/[subtask free] 一行契约零子步/到步展开时发生什么（initial_plan 非失败+expansion_context 带真材料）/两条纪律引擎强制（必含 check 禁 commit）/展开预算续批问人/与重规划的分界表（原 09 replan 教学压缩为一节,例子与自跑指引保留指路） | compact（源=概念层有序思考与渐进固化+核心规范 ^anc-step-subtask-free;失败全景归 D5） |
| 10-钉钉通知 | 用户日常应用——钉钉通知教学：一次性备凭证（建机器人/环境变量/最小活实测）/三种通知时刻（✅ 终态 ❌ 失败 ⏸️ 停点等人）/三条规则（点名渠道才推手机·一次一说跟着活走零全局开关·通知失败不影响干活）/边界（只发不收/限流/敏感信息/MCP 独立模式差异） | compact（源=hop-cli ^anc-cli-notify-reuse + mcp-server ^anc-mcp-notify-hook;2026-08-31 复用模式挂点收官后按终形重建,前身随 hopjit notify 命令退役删除） |
| 04-日常活交给hop | 用户日常应用——/hop 教学：把现场的活升格为引擎管护的执行（vs /hopspec 跑成品 spec）/六动作用法/一次完整体验/任务卡=计划+语境同体（内容章节缺省供给）/subtask free 到步展开/阅卷外移为什么/接续免斜杠+裸"继续"先确认/收活三态/提纯与复用（查现货有提示,"直接开"跳查）/真实例:工程链实现与review两句话术走 /hop | compact（源=driver/hop-skill.md;协议权威在 driver 件） |
| D7-开发自己的工具 | 工具作者篇——**已就绪工具面清单**（PDF/OCR/检索/浏览器四件+四条实撞接入经验+端到端样例指路,2026-08-26 批）/两档选型表（in-process 零序列化无隔离 vs MCP 进程隔离任意语言）/in-process 五分钟上手（word-stats 模板+责任书三条）/MCP server 路线要点（最小子集/annotations 不被信/错误报文写人话）/测试三层 | compact（源=tool-interface 绑定契约） |
| D8-模型与工具配置 | 配置心法版——配置地图（系统级/项目级/spec/步骤四层什么住哪）/按 step_type 分档省成本（act 轻档 check 换家 replan 最强）/逐键继承+偏好语义（spec 引用环境没有不炸,链尾必有归宿）/env: 节三硬规则/三个常见配方 | compact（源=reference/配置参考） |
| D9-Obsidian可视化插件 | 插件安装引导版——为什么需要（markdown 6 级标题上限截断深层步骤,按编号识别与形态解耦）/三步装进 vault+启用/三能力表（折叠/大纲/落点四色+语法分族着色）/更新须重载/零打扰与边界（不做诊断补全执行） | compact（源=design/obsidian-plugin;安装命令权威 editors/obsidian/README） |
| 01-第一次运行-ClaudeCode | CC 入口：30 分钟从安装到跑通 coffee-week + 体验 ask 介入点 | extend（源=USAGE） |
| 01-第一次运行-Codex | Codex 入口（与 CC 版平行）：安装布局/触发方式/载体差异；三路 E2E 全绿（2026-08-10） | compact（源=codex-driver-carrier） |
| 02-读懂一份spec | ★地基：头部契约 vs Steps 路径/14 类型分工表（谁动脑谁把关）/两个箭头的数据流/容器与介入点/coffee-week 三分钟实练 | compact（源=HopSpec V3语法参考 §1-3） |
| 03-探索与提交 | 先讲安全——act/commit 分界（可逆探索 vs 不可逆提交）、commit 三规矩、work_zone 自由领地、沙箱四维度 | compact（源=HopSpec核心创新+语法参考 act/commit 节） |
| D10-hop_python计算体 | agent 代写的简单逻辑代码呈现——四类能力、白名单、人读得懂核得对即可、三种错误结局 | compact（源=HopSpec V3语法参考 §5） |
| D11-维护spec的内置工具 | spec 内容工具族教学——为什么需要（步骤号即树结构,手工改号必手滑）/read_spec_tree 两档（骨架/下钻）/树编辑四件独立函数（insert_node 落位号原位者后移/replace_node/replace_children/renumber_steps——2026-08-30 函数化,旧 edit_spec_tree 单入口废除）/validate_spec 改完必验/完整链与常见坑 | compact（源=design/tools ^anc-exec-spec-tools-family） |
| 05-并行与遍历 | 效率进阶——for-each+collect 遍历不漏、parallel 承诺与三条常见错法、部分失败语义 | compact（源=HopSpec V3语法参考 §parallel） |
| 06-实战-事实核查器 | 主线组装篇——hop-fact-check 逐段解剖：自查回路/四层并行分流/act 机械点名+reason 审查；提取-扇出-汇聚母版 | analyze（源=examples/hop-fact-check） |
| 07-升级你的自然语言skill | 收官应用——/hopbuild 翻译实操：事故对照、终审忠实核（对 source.md 原文副本）、pack 成具名 skill | compact（源=hopbuild SKILL） |

## driver/ — 驱动载体多态（架构要点）

**这是本库的一个核心架构决策**（[[ARCHITECTURE]] `^anc-driver-carrier-polymorphism`）：复用模式下外层 LLM（CC / Codex / 将来的 OpenCode…）当推理引擎，**引擎与 CLI 保持载体中立**（纯 JSON in/out，不假设任何工具执行能力），因此**每接入一个载体，只需为它写一套等价的驱动指令**，并列放在 `driver/` 下——引擎代码零改动。

**同语义、分载体实现**是这个目录的组织原则：各载体的执行规则对齐同一组设计锚点（`^anc-exec-mode-invariants` / `^anc-exec-advance-to-caller` / `^anc-exec-work-zone`…），允许调用原语和并发交互方式不同（CC 用 Agent 工具 + 滑动窗口通知；Codex 有 subagent 时批式 barrier join，无 subagent 时 inline 串行降级），**不允许步骤语义静默漂移**。静态纪律由 `scripts/check-driver-carriers.mjs` 机检（在 `check:fast` 内）。

| 载体 | 文档 | L2 表述 |
|---|---|---|
| **CC 载体** | driver/hopspec-skill.md（+ skills/hopbuild/） | 主 agent 只编排介入点，执行段外包 driver subagent；AskUserQuestion 问人。部署副本在用户 `.claude/skills/` |
| （CC 共享细则） | driver/references/ | driver-subagent / step-execution-rules / discovery——CC 驱动的执行细则（parallel-worker 已随旧通道退役，P0.5）；其中 **cli-discovery.md 是唯一真正载体中立、各载体共用**的部分 |
| **Codex 载体** | driver/codex/ | 有 subagent 时三主体拆分；无 subagent 时 Main 按同一角色文件 inline 执行、parallel 串行降级。references 自包含（batch-fanout / execution-rules / discovery），不带 CC 原语。完整契约见设计层 [[codex-driver-carrier]] |

## 模块索引 — 锚点串起概念/设计/代码/测试（×15）

> 模块是横向组织单元（[[module-principles]] 定原则：判据/依赖方向/接口边界/版本兼容/拆分信号）。每行的**模块锚点**即收链入口：设计文档该锚点章节=边界声明+出口清单+模块版本；`@module:` 标注绑定 src/tests 文件；TRACEABILITY 对应卡片汇总全链。分层依 module-principles §2。

| 模块（锚点） | 层 | 设计权威 | 概念上游 | src 文件 | 测试 |
|---|---|---|---|---|---|
| spec-ast（`anc-struct-spec-ast`） | 核心 | [[spec-ast]] | 核心规范（AST=语言身份） | ast-types/ast-runtime/ast-helpers | ast-helpers/ast-runtime.test |
| spec-parser（`anc-struct-spec-parser`） | 核心 | [[spec-parser]] | 核心规范（语法+验证规则） | parser/validator | parser/validator.test |
| exec-engine（`anc-struct-exec-engine`） | 核心 | [[exec-engine]] | 配套运行时能力（模式无关原则） | engine/engine-traverse/runtime-types | engine/engine-traverse.test |
| prompt-assembler（`anc-struct-prompt-assembler`） | 核心 | [[prompt-assembler]] | 核心规范 ^anc-exec-prompt-assembly | prompt | prompt.test |
| act-body（`anc-struct-act-body`） | 核心 | [[act-body]] | 核心规范 ^anc-step-act-body-lang | act-body-parser/-interpreter/act-builtins | act-body-*.test ×4 |
| doc-ref（`anc-struct-doc-ref`） | 核心 | [[doc-ref]] | 核心规范 ^anc-exec-doc-ref | doc-ref | doc-ref.test |
| hoplog（`anc-obs-hoplog`） | 核心 | [[spec-observability]] | 可观测性扩展（YAMLL 标准） | hoplog | hoplog.test |
| persistence（`anc-provider-persistence`） | 适配 | [[persistence]] | 配套运行时能力（durable resume） | persistence | persistence.test |
| hop-cli（`anc-struct-hop-cli`） | 适配 | [[hop-cli]] | 配套运行时能力（caller 介入点） | cli/cli-types | cli.test |
| step-dispatcher（`anc-struct-step-dispatcher`） | 适配 | [[step-dispatcher]] | 配套运行时能力 ^anc-exec-dual-mode | dispatcher | dispatcher.test |
| mcp-server（`anc-struct-mcp-server`） | 适配 | [[mcp-server]] | 配套运行时能力 ^anc-exec-dual-mode（standalone 执行面） | mcp-server（bin `hopjit-mcp`） | mcp-server.test |
| tools（`anc-struct-tools`） | 适配 | [[tools]] | 核心规范（sandbox 约束） | tools | tools.test |
| shared-providers（`anc-struct-shared-providers`） | 共享 | [[shared-providers]] | HopAnt 四维度（Provider 契约边界） | provider-types | （类型模块，行为面在 dispatcher.test） |
| shared-errors（`anc-error-error-code`） | 共享 | [[shared-errors]] | 错误模型 | errors | （常量模块） |
| anchor-audit-scripts（`anc-meta-traceability`） | 工具 | [[concept-anchor-rules]] | 工程实现链规范 ^anc-meta-traceability | scripts/audit/*.py | anchor-scan.test + audit-scripts.test（资产安全三钉,第九轮 review 补） |

## src/ — 引擎源码层（29 个 TS 文件）

> 每个文件对应的设计文档见上方 design 表（改 src 前对应设计先改定）。计数与逐文件表 2026-09-06 review 补账（曾滞后八件——21 实 29）。文件内 `@a: anc-*` 锚点是设计契约的代码落点，汇总于 TRACEABILITY.md。按职责分组：

**语言核心（spec → AST）**：

| 文件 | L2 表述 | 对应设计 |
|---|---|---|
| ast-types.ts | AST 类型词汇表——15 种步骤节点、Spec 头部结构 | spec-ast |
| ast-runtime.ts | VariableStore/作用域链/真值语义（语言运行时基础） | spec-ast |
| ast-helpers.ts | AST 遍历与查询小工具 | spec-ast |
| parser.ts | SpecParser——markdown（标准/大纲双语法）→ AST | spec-parser |
| validator.ts | 39 条验证规则（S/C/V/P/B 系列），放行前闸门 | spec-parser |

**执行引擎**：

| 文件 | L2 表述 | 对应设计 |
|---|---|---|
| engine.ts | ExecutionEngine 状态机——步骤推进、retry/adaptive、None 传播、崩溃恢复、并行 fan-out 调度（最大文件，1950 行） | exec-engine |
| engine-traverse.ts | 步骤树遍历/下一步定位（引擎的推进算法拆分） | exec-engine |
| prompt.ts | PromptAssembler——6 层 context 组装 + worker 子树视图 | prompt-assembler |
| doc-ref.ts | `[[文档路径#章节名]]` 确定性引用——解析、切片、注入 | doc-ref |
| persistence.ts | EngineSnapshot ↔ .hopstate/ 存取 + for-each worker 参数通道 | persistence |
| hoplog.ts | HopLog 三级日志——YAMLL 流式落盘（不可重排） | spec-observability |

**act body（hop_python 受限编排语言）**：

| 文件 | L2 表述 | 对应设计 |
|---|---|---|
| act-body-parser.ts | hop_python 词法/语法（INDENT/DEDENT 敏感） | act-body |
| act-body-interpreter.ts | 解释器（执行期无推理，严格按 body） | act-body |
| act-builtins.ts | 内置函数表 | act-body |

**驱动适配与共享**：

| 文件 | L2 表述 | 对应设计 |
|---|---|---|
| cli.ts | CLI 命令路由薄壳（run/submit_and_fetch_next/join_parallel/fanout-*/install-skill…） | hop-cli |
| cli-types.ts | CLI JSON I/O 契约类型（NextResponse 等） | hop-cli |
| dispatcher.ts | 独立模式 StepDispatcher——直调 LLM API、模型路由、暂停语义 | step-dispatcher |
| tools.ts | 受控工具 DefaultToolProvider + workspace 路径校验 | tools |
| provider-types.ts / runtime-types.ts | Provider 接口族 / 运行时共享类型 | shared-providers / shared-types |
| errors.ts | 错误码与分类 | shared-errors |
| mcp-server.ts | standalone 执行 MCP server（四工具面/job 异步/HITL 常驻） | mcp-server |
| prompt 相关外的工具族五件 tools-composite.ts / tools-registry.ts / tools-notify.ts / tools-mcp-binding.ts / tools-inprocess-binding.ts | 组合 provider 装配/注册表加载（hopjit.yaml tool_servers）/钉钉通知内置件/MCP 绑定/进程内绑定 | tools 族（tools.md 及 tools/ 子目录） |
| spec-tree-edit.ts | 步骤树编辑核心（insert/replace/renumber 纯函数） | spec-tree-tools |
| protocol-openai.ts | OpenAI responses 协议适配 | step-dispatcher（协议面） |

## tests/ — 测试层（34 个 *.test.ts）

> 命名与 src 一一对应（`X.ts` ↔ `X.test.ts`），文件内 `@v: anc-*` 锚点标记验证落点。超出一一对应的：

| 文件 | L2 表述 |
|---|---|
| e2e.test.ts / e2e-execution.test.ts | 引擎端到端——真实 example spec 走完整执行链 |
| carrier-live-e2e.test.ts | 真实 carrier runner 的确定性保护——JSONL 归一、执行体断言、凭证红线、超时清理 |
| examples.test.ts | 分发示例守卫——data-quality 语法/验证有效，演示数据确实含声明的 Z-score 离群值 |
| act-body-reuse.test.ts / act-body-validator.test.ts | act body 在复用模式下的行为 / body 级验证 |
| anchor-scan.test.ts | 锚点扫描器自身的回归测试（守卫的守卫） |
| knowledge.test.ts | doc-ref 知识文档判据（examples 里两份知识文档的可用性） |


## scripts/ — 机检守卫与自动化驱动

> 全部挂在 `npm run check*` 统一入口下（[[chain-enforcement]] §4 时机表），准入四步管理。

| 脚本 | L2 表述 | 挂载点 |
|---|---|---|
| chain-health.mjs | 链健康度体检——按链结构跑全部守卫出 4 态报告（绿/红/黄/⬜空白） | check:health |
| check-anchor-format.mjs | 锚点格式（`^anc-*` 前必须半角空格） | check:fast |
| check-driver-carriers.mjs | driver 载体静态纪律（CC 原语不得漏入 Codex 等） | check:fast |
| carrier-live-e2e.mjs / carrier-live-e2e-lib.mjs | CC/Codex 真实载体 E2E——共享隔离、安全与事件适配；有模型费用，显式运行 | test:e2e:* |
| check-design-first.sh | 设计先行机检（src 改了 design 没动＝跳层） | CI（commit 范围） |
| run-audit.mjs | 锚点全量审计入口——解析带 pyyaml 的 python 跑 scan+cross_compare，依赖缺失显式 exit 2 | check:audit |
| audit/prep_env.py | 审计环境准备——路径探测 + audit_mode 清理（fresh 清中间产物/resume 保留批结果断点；台账 semantic_audit_summary.yaml 恒不删） | anchor-audit spec 步 1 |
| audit/make_batches.py | 语义审计分批——锚点归模块/设计位反查/模块过滤防拼错，超 100 锚点按 50 一段拆，--resume 按 .anchor-audit/ 已有批结果跳过 | anchor-audit spec 步 5.1 |
| audit/write_batch.py | 批结果写盘+写前 parse 把关——围栏壳/通体缩进两形态自剥修复，真坏 rc=2 带行号打回当轮重产 | anchor-audit spec 步 5.2.1.2 |
| audit/tally_batches.py | 语义审计汇总统计——读全部批结果做三维计数/通过率/err+warn 明细，围栏与缩进噪声容忍 | anchor-audit spec 步 6.1 |
| audit/write_artifact.py | 审计产物落盘——report.md 与 semantic_audit_summary.yaml（module_ledger 增量合并，scope 从 modules 推导），白名单脚本自主写盘不经写域闸 | anchor-audit spec 步 4.3/6.2 |
| audit/collect_coverage.py | 测试覆盖率机械工序四子命令——--detect 检测覆盖率工具（vitest/jest/pytest 三型）/--run 跑覆盖（恒 exit 0，工具退出码进 stdout，超时同路径）/--analyze 解析三份 YAML+mock 预筛/--gaps 低覆盖筛选（阈值参数化） | test-coverage-audit spec 步 1/3.1/3.2/4 |
| dev-install.sh | 开发刷装置——重建 dist，并同步刷新 CC + 当前项目 Codex 两套 skill（npm run dev:install） | 手动（用户终端） |
| release.sh | G5 发版检查单十一步·快照制（npm run release，启动冻结 SNAP 对快照 worktree 跑全程，含 tarball 资产核对与收编三拍；publish/push 不可逆归人跑；行为权威 [[release-engineering]]） | 手动（用户终端） |
| hoplog-fuzz.mjs | HopLog 写入路径穷举 harness——列全 YAMLL 崩溃点，只暴露不修 | 手动 |
| validate-run-yamll.mjs | 校验一次真实 run 的全部 main.yaml 逐块合法性 | 手动 |

## examples/ 中的文档

| 位置 | L2 表述 |
|---|---|
| examples/*.md | 可执行 spec 范本（演示用；审计类已迁 scripts/audit/） |
| examples/hop-doc-review2/ | 多角度文档评审完整版（hopbuild2 从 doc-review NL skill 构建+十七轮真机验证收编 2026-09-01；主 spec+reviewer-worker 审查员子 spec+README——与入门版 doc-review.md 并存不替换,差异见其 README） |
| examples/（入门随包件） | 三课递进：coffee-week（①纯确定性首跑）+data-quality（②tool_request 演示，数值非基线）+doc-review（③介入点）+ 两份演示数据 +GETTING-STARTED（files 白名单按文件挑；run 定位第 2 级同路径命中） |
| scripts/audit/ | 审计工具（scan.py 六层采集 / cross_compare.py 15 项比对 / standalone 化五件：prep_env.py 环境准备、make_batches.py 分批、tally_batches.py 汇总计数、write_artifact.py 产物落盘、write_batch.py 批结果写前校验；sample_anchors.py 已废弃删除） |
| scripts/deep-validate/ | 跑前深检 hopskill（deep-validate.md spec 三步骨架 + deep-validate-knowledge.md 判据台账五面与环境事实教材 + dv-batch.md 批量外壳〔loop for-each + call parallel 十行 spec,N 份并行体检交引擎派发——2026-09-01 全库 40 份体检与双模式化批复跑实战件〕；设计权威 docs/design/deep-validate.md） |
| scripts/hopfix/ | 定向修正 hopskill（hopfix.md——按工单对既有 spec 做节点级定向编辑:分诊四档/树编辑五件/三层把关/快照写回;设计权威 docs/design/hopfix.md） |

---

## 维护机制

**谁维护**：改动文档的人（Agent 或维护者）——不设专职维护轮，责任随改动走。

**何时更新（触发条件）**：

| 触发 | 动作 | 时机 |
|---|---|---|
| 新增文档 | 在对应分类表加一行（L2 表述一句话 + 派生角色） | **与新增文档同一个 commit**——本文件滞后即失效 |
| 删除/移动/改名文档 | 删行/挪行/改名，同时核对该文档作为"源"被谁引用（`@trace source` 会断） | 同一个 commit |
| 文档定位/内容大改 | 核对 L2 表述句是否仍准确，失准即改 | 同一个 commit |
| concepts 快照重新同步 | 逐行确认 ×10 表格的 L2 表述仍与新快照相符 | 快照同步的 commit 内 |
| 派生关系变更（`@trace` 的 source/type 改了） | 同步"派生角色"列 | 同一个 commit |

**如何校验（本文件自身的失效检测）**：

- **机检**：目前**无专用守卫**——文件清单与本索引的一致性、L2 表述的准确性都靠人工纪律维持。这是已知空白，性质同 [[chain-enforcement]] §3 空白台账（语义类，机检只能查"文件存在性"，查不了"表述准确性"）；若腐坏反复发生，应按守卫准入四步补一个"文件清单 diff"级别的确定性机检
- **人工审查节奏**：全库性审查（发版前、里程碑收口）时把本文件过一遍——用 `ls docs/design/ docs/concepts/ *.md` 对照各表，缺行/多行/表述失准即修

**冲突仲裁**：本文件是**汇总视图不是第二真值**——派生关系与各文件头部 `@trace` 冲突时，以 `@trace` 为准、改本文件。发现冲突本身就是本文件过期的信号。

**与 STATUS.md 的分工**：本文件管"有什么、谁派生谁"（结构，低频变）；STATUS.md 管"现在怎么样"（状态，高频变、允许过期）。时效性规则各自头部声明，互不重复。
