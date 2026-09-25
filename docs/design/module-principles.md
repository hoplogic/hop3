%% @trace
	id: hopjit-module-principles
	source: [[../concepts/工程实现链规范]]
	source_id: engineering-chain-spec
	type: extend
	last_sync: 2026-08-04T12:07+0800
	note: 模块设计与实现原则——把元规范 ^anc-meta-module-* 三节推演到本库：模块判据、依赖方向、拆分触发条件、物理边界演进路线。先对焦原则，不为拆而拆（2026-08-04 作者定调）。
%%

# 模块设计与实现原则

> **本文定位**：元规范已定义模块的**通用**原则——[[../concepts/工程实现链规范#^anc-meta-module-spec]] 封闭子域四要求、[[../concepts/工程实现链规范#^anc-meta-module-evolution]] 版本演进、[[../concepts/工程实现链规范#^anc-meta-module-trace]] 归属标注；
> 外加**设计层必备件清单** `^anc-meta-module-design-artifacts`（2026-08-06 作者定：设计层面必须明确模块的设计与要求——定位章节/出口清单/契约锚点成对/架构视图在场，四件缺一即模块环不完整）。
>
> 本文把它们**推演到本库的具体判据**：什么算一个健康模块、依赖只许朝哪个方向、什么信号出现才拆、物理边界走什么演进路线。**先有原则，重构才有判据——不为拆而拆**（2026-08-04 作者定调：模块拆分不着急，先从设计和代码层面对焦清楚）。本库的"架构视图在场"落点 = Doctree 模块索引 + ARCHITECTURE 组件/双态表 + 本文 §7 盘点（审计契约见 §6b）。

## 文档结构与内容分级

| 章节             | 分级                    | 锚点                              |
| -------------- | --------------------- | ------------------------------- |
| 模块判据（何为一个健康模块） | 契约                    | `anc-meta-module-criteria`      |
| 依赖方向（分层规则）     | 契约                    | `anc-meta-module-layering`      |
| 接口边界（出口清单机制）   | 契约                    | `anc-meta-module-interface`     |
| 版本与兼容（模块级演进）   | 契约                    | `anc-meta-module-versioning`    |
| 拆分触发判据（何时才拆）   | 契约                    | `anc-meta-module-split-trigger` |
| 物理边界演进路线       | 决策：原则性（路线已定，各阶段触发待事件） | `anc-meta-module-physical`      |
| 模块架构工程链审计     | 契约                    | `anc-meta-module-arch-audit`    |
| 现状盘点           | 说明（快照，会过期）            | —                               |

---

> **概念权威**：模块级概念要求见 [[../concepts/工程实现链-模块规范]]（2026-08-08 收拢）——本文是它在本库的**操作化**（机检判据/分层表/拆分信号/盘点），不重复定义概念要求。

## 1. 模块判据【契约】 ^anc-meta-module-criteria

一个健康模块 = 元规范四要求（封闭子域/注意力自足/接口面最小/测试边界对齐）在本库的可核查形态：

1. **一个 `^anc-struct-*` 定位锚点 + 边界声明**——设计文档里该模块的章节须写清"负责什么 / **不**碰什么"；
2. **文件头 `@module:` 归属**——每个 src/tests 文件恰好属一个模块（机检：scan.py 模块维度，漏标即报）；
3. **可独立收链**——Agent 只拉这个模块的设计章节 + 接口类型 + 专属测试就能安全修改，不必把依赖模块全文拉进上下文。**操作判据**：模块的设计契约字符数 + 接口类型 + 测试，加起来一个上下文窗口装得下且有富余；
4. **专属红灯**——每个模块有自己的 `*.test.ts`，改坏了由自己的测试拦，不靠上层 e2e 间接兜（现状两个豁免见 §7 盘点：shared-providers/shared-errors 是纯类型/常量模块，其行为面由使用方测试覆盖，卡片已注记）。

**模块 ≠ 文件**：一个模块可含多个 src 文件（act-body 三件、spec-ast 三件），判据是关注点而非文件数。**模块 ≠ 目录**：现阶段模块是 `@module:` 标注的逻辑边界，物理目录是否引入见 §6 路线。

## 2. 依赖方向【契约】 ^anc-meta-module-layering

[[../ARCHITECTURE#架构分层]] 已声明三层，本节把"分层"收紧为**可机检的依赖方向规则**：

```
载体层（driver/ 驱动文档，不是 TS 代码）
   ↑ 只依赖 CLI 的 JSON 契约（cli-types），不 import 任何实现
驱动适配层：hop-cli · step-dispatcher · tools（含 tools-notify.ts 钉钉通道——不可逆工具通道属工具面适配层,与 mcp-binding 同位） · persistence(File)
   ↑ 可 import 引擎核心与共享层
引擎核心层：exec-engine · spec-parser · spec-ast（含 spec-tree-edit.ts——AST 级树编辑核心,仅依赖 ast-types;契约归 tools 模块 ^anc-exec-builtin-edit-tree-tool 两层结构之第一层,文件定层按依赖事实归核心层） · act-body（含 command-exec.ts——命令执行原语,仅依赖 node 内置;两个消费口分处两层〔本模块的 subprocess.run + 适配层 tools 的 run_script〕,文件按依赖事实归核心层,适配层向下 import 是合规方向） · py-sandbox（Python 语法沙箱——产物脚本白名单静态审查+受控执行;仅依赖 node 内置与同层 command-exec,被适配层 tools 的 run_script 调,见 [[py-sandbox#^anc-struct-py-sandbox]]） · prompt-assembler · doc-ref · hoplog
   ↑ 可 import 共享层；【禁止】import 驱动适配层
共享层：shared-types · shared-providers · shared-errors
   【禁止】import 任何上层
```

三条硬规则：

1. **核心不知适配**：引擎核心模块不得 import hop-cli/step-dispatcher/tools 的实现——核心对外部世界的全部认知经 Provider 接口（shared-providers）注入。已核准的桥接例外集中登记在 [[../ARCHITECTURE#分层桥接点]]（HopLog 有意保留、type-only import 可接受），**新增桥接必须先进那张表再写代码**；
2. **共享层零依赖**：shared-* 只含类型/接口/常量，不 import 兄弟模块；
3. **同层横向依赖须显式**：同层模块间的 import 就是 `@module-deps:` 声明的内容（集成测试已有此机制），声明与实际 import 不一致由机检报（cross_compare deps 维度，已全绿）。

> **机检落点**：`scripts/check-layer-imports.mjs`（G8 守卫，2026-08-04 准入）——按本节分层表扫 src/ 全部相对 import（含 `import type`），越向即红；豁免名单与 [[../ARCHITECTURE#分层桥接点]] 一一对应（脚本内注明"新增豁免必须先登记桥接表"）。deps 声明一致性另由 cross_compare deps 维度守。

## 3. 接口边界【契约】 ^anc-meta-module-interface

模块边界的物理形态是**出口清单（manifest）**——已在各模块设计文档实施（如 [[doc-ref]]「模块出口」表），本节把机制收编为全库契约：

1. **出口清单是对外依赖面的封闭集**：每个模块的设计文档维护一张出口表（符号/种类/出口文件/谁依赖/稳定性），**表外符号即内部实现**——别的模块 import 表外符号 = 边界违规（机检：cross_compare 模块边界维度;基线钉 0——anchor-baseline module_boundary_violations,新增违规当场红,2026-08-12 边界清零后钉死）；
2. **出口注释**：出口文件的每个顶层 export 必须带说明注释（它是什么、谁消费、指回设计锚点）——出口即接口文档的最小单元（机检：export_comment_violations，现值 0）；
3. **接口面最小的操作判据**（元规范要求③的落地）：新增出口必须同时登记出口表并写明"谁依赖"——**说不出消费方的 export 不准出口**。为测试而 export 私有逻辑是 T4 拆分信号，不是出口理由；
4. **type-only 依赖也算依赖**：`import type` 同样受 §2 方向规则与出口清单约束（类型是最容易无声扩散的耦合面）；已核准的 type-only 桥接同样登记在 [[../ARCHITECTURE#分层桥接点]]。

**收窄接口模式**（推荐）：跨模块协作优先经**显式收窄接口**而非直接吃对方全出口——现例：prompt-assembler 经 `EngineAccessor` 访问 engine（[[prompt-assembler]]），engine 经 `PersistenceProvider` 访问持久化。新增跨模块协作时先问"能不能收窄"。

## 4. 版本与兼容【契约】 ^anc-meta-module-versioning

元规范 [[../concepts/工程实现链规范#^anc-meta-module-evolution]] 已定通用规则（分层同规则的语义化版本/破坏性变更=原则性决策/format_version 正交轴）。本节是它在本库的**操作化**：

1. **模块版本记在设计文档头**（已实施：各设计文档"模块版本"引块）。**版本行只记现行版本号+日期+稳定契约一句**——逐版演进史归 git log，不在版本行内累积编年史（2026-08-19 作者纠：版本行堆成数千字编年史违反"落笔只留结论"，论证归 commit message；升版时此处只改号）。**驱动版本号的是该模块出口清单的兼容性变化**，与代码行数/内部重构无关：
   - 出口表删符号/改签名/改语义 → MAJOR（0.x 阶段走 MINOR，但必须过决策）；
   - 出口表加符号（旧消费方不受影响）→ MINOR；
   - 表内符号行为修复 → PATCH；
   - **判据物理化**：改版本号的 commit 必须同时改出口表——出口表不变则版本号不该动，版本号不动则出口表不许破坏性地变（两者互为机检锚）；
2. **包级对外稳定面单列**：CLI 命令+参数+JSON 响应（cli-types）与 `.hopstate` 格式是**包级契约**（driver 与持久化读者依赖），其破坏按包级 MAJOR 候选处理，不与模块版本联动（各自边界各自判）；
3. **兼容策略必须显式三选一**（破坏性变更决策时）：并行支持旧接口一段（写明移除条件）/ 提供迁移 / 直接断并升版本。**禁止散落的"顺手兼容"补丁**——本库已两次按"alpha 刷新无迁移层"处理（`~/.hopstep`→`~/.hopjit`、HOPSTEP_ 环境变量），该先例适用于 0.x 全期：**0.x 破坏性变更默认"直接断"，但仍须人拍板**；
4. **format_version 独立轴**：state.json/vars.json 的格式版本与模块语义版本正交；当前策略"破坏式不兼容"（读旧版明确拒绝+提示重建），npm 分发有真实用户持久化数据时复审（依赖驱动决策，触发条件已在元规范登记）；
5. **driver 契约的版本锚**：driver（CC/Codex skill 文档）不带独立版本号——它随包发布，其兼容性完全由 cli-types JSON 契约背书。改 NextResponse 等结构 = 改 driver 契约，按第 2 条包级处理。

## 5. 拆分触发判据【契约】 ^anc-meta-module-split-trigger

模块拆分/合并是**设计级决策**（元规范：Agent 建议、人拍板，不擅自重构）。本节定义**什么信号出现时才值得把"拆分提案"提上决策桌**——没有信号就不提，杜绝"为整洁而拆"：

| # | 触发信号 | 判据 | 现状对号 |
|---|---|---|---|
| T1 | **收链装不下** | 模块设计契约+接口+测试超出一个上下文窗口能舒适容纳的量，Agent 改它必须"盲改一部分" | exec-engine（1923 行代码 + 5329 字符设计契约）**接近**但未越线——engine-traverse 拆出后收链仍可行 |
| T2 | **单测试文件跨多关注点红灯** | 一个 test 文件的失败经常定位到互不相关的功能块 | 未出现 |
| T3 | **新特性无处安放** | 来了一个真实需求，塞进现有任何模块都会破坏其边界声明 | 独立模式真并行（v2）落地时对 exec-engine 是此信号 |
| T4 | **接口面被迫扩大** | 为让别的模块用上内部逻辑而 export 私有函数 | 未出现 |
| T5 | **物理分发需要** | 某部分要独立发包/独立版本节奏 | 未出现（引擎+driver 同包发布） |

**拆分提案的必备内容**（提交决策时）：触发了哪个信号（引证据）、新边界声明各是什么、锚点/卡片/测试怎么迁移、影响哪些 `@module-deps:`。缺一不受理。

**明确不拆的**（2026-08-04 现状判定）：engine.ts 虽大但 T1 未越线，**等 T3（v2 真并行）到来时一并设计**——那时拆分有真实需求牵引，边界自然显形；现在拆是凭美学猜边界，八成要返工。

## 6. 物理边界演进路线【决策：原则性】 ^anc-meta-module-physical

模块的物理形态分三档，**按信号逐档演进，不跳档**：

| 档 | 形态 | 进入条件 | 状态 |
|---|---|---|---|
| P0 | **平铺 + 标注**（现状）：src/ 一层，`@module:` 逻辑边界 | — | ✅ 现行 |
| P1 | **平铺 + 依赖方向 lint**：G8 守卫上线，越层 import 即红 | §2 规则拍板（本文即拍板） | 待补守卫（G8） |
| P2 | **子目录物理边界**：src/{core,adapter,shared}/ 或按模块分目录 | 首次大拆分发生时（T3 触发的那次）顺势立目录——目录调整与拆分一次付清，不单独动 | 挂 roadmap |
| P3 | **分包**：引擎核心/适配各自 npm 包 | T5 信号（有独立分发需求） | 无计划 |

**why 不直接上 P2**：移动 21 个文件动全部 import 路径、TRACEABILITY 落点、覆盖率基线——纯物理收益（目录即边界）在 P1 的 lint 之下增量很小，成本却是全库震动。P1 用 lint 拿到了 P2 九成的防腐收益。

## 6b. 模块架构工程链审计【契约】 ^anc-meta-module-arch-audit

概念层必备件④（[[../concepts/工程实现链规范#^anc-meta-module-design-artifacts]]）在本库的可核查判据：**src 全部 `@module:` 声明的模块名集合，必须逐名出现在三处全局视图**——[[../../Doctree|Doctree]]「模块索引」、[[../../ARCHITECTURE|ARCHITECTURE]]（组件/双态表）、本文 §7 盘点。新建/改名模块时三视图与模块本体**同一次改动**更新。

- 守卫 `check-module-arch-audit.mjs`（`check:fast` 内）缺名即红；判据源为空时显式失败不静默跳过；
- 实撞背景：2026-08-06 mcp-server 代码/纵向锚点全齐而三视图滞后数轮提交无红灯，靠人盘出（G10 当日销账）。

**模块登记的操作环节（2026-08-06 作者定"需要有一个明确的环节"，并纠正归属：这是 agent 收链把关的工作，不是人的操作手册项）**：新建模块的登记是 **agent 建模块时的收链八件单**，权威在 [[chain-enforcement#^anc-meta-module-checklist]]（守卫链主线 §1c-2；CLAUDE.md 仅汇聚摘要）——设计先行→定层→锚点类别→写码→测试→三视图→立卡→全检，**一次改动交齐**、不许散落多 commit 事后补。本节守卫兜底其中三视图在场性；人侧（RELEASING 分诊表）只核"agent 是否交齐"。

## 7. 现状盘点【说明·快照 2026-08-06】

16 模块规模（`npm run check:audit` 产物 module_scale，过期以实测为准）：

- exec-engine 1923 行 / spec-parser 1558 / prompt-assembler 893 / hop-cli 697 / step-dispatcher 627 / act-body 601 / spec-ast 493 / hoplog 421；
- **mcp-server 389**（2026-08-06 新增，standalone MCP 协议壳，适配层）；
- doc-ref 163 / persistence 155 / shared-providers 132 / tools 122 / shared-errors 47 / anchor-audit-scripts（纯脚本）；
- **py-sandbox**（2026-09-23 新增，Python 语法沙箱，核心层；src 一件 + 随包检查器脚本 `scripts/pysb/pysb_check.py`；^anc-struct-py-sandbox 定位+边界声明✓、@module 归属✓、专属 py-sandbox.test.ts✓）。

- 健康：≤900 行的 12 个模块全部满足 §1 四判据（mcp-server：^anc-struct-mcp-server 定位+边界声明✓、@module 归属✓、独立收链✓、专属 mcp-server.test.ts✓）；
- 观察名单：exec-engine（T1 接近线，T3 到来时拆）、spec-parser（parser+validator 1558 行，关注点尚单一，无信号）；
- 豁免注记：shared-providers/shared-errors 无专属测试（纯类型/常量，行为面在使用方测试），TRACEABILITY 卡片已按落差声明。
