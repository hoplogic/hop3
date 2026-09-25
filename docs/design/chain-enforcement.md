%% @trace
	id: hopjit-chain-enforcement
	source: [[../concepts/工程实现链规范]]
	source_id: engineering-chain-spec
	type: extend
	last_sync: 2026-08-17T13:00+0800
	note: 实现链的机检守卫总览——把静态、确定性与真实载体守卫按"守链哪一环"归位成一条主线，标出已守/空白，并定何时跑。回答"这条链凭什么不会腐坏"。
%%

# 实现链的机检守卫（Chain Enforcement）

> **本文定位**：守卫级概念权威=[[../concepts/工程实现链-守卫规范]]（2026-08-08 单立，三原则：显式覆盖／手段×对象两维正交／守卫自证＋无宽限期推论；§六闭环=规则×制品×工具三分＋六档时机）。本文把概念原则**操作化到本库**：守卫映射表（§1，即闭环制品之一）、手段×对象划分的本库实例（§2）、空白台账现值（§3）、执行时机与统一入口（§4，即闭环时机表的本库实例）、自证四硬要求落地（§5）、准入四步（§6，无宽限期推论的执行协议）、健康度入口（§7）。与 [[module-principles]] 之于模块规范同构：概念层管原则，本文管本库判据与现值。
>
> **历史背景（本文为何存在）**：本工程曾积累 8 个校验工具却从未组织成主线——`check-design-first.sh` 路径假阴性存在约半年无人发现（正因它从不被跑）；310 处行号漂移、9 个因中文标点隐形的锚点，同属"检查存在但不运行"的静默累积。这段实撞史正是概念层"链会腐坏且默认无声"的第一手证据。

> **概念权威**：守卫级概念原则见 [[../concepts/工程实现链-守卫规范]]（2026-08-08 单立）——本文是它在本库的**操作化**（守卫映射表/工具/台账/执行时机/八件单），不重复定义概念原则。

## 文档结构与内容分级

| 章节              | 分级  | 锚点                          |
| --------------- | --- | --------------------------- |
| 守卫映射：链的每一环由谁守   | 契约  | `anc-meta-chain-guards`     |
| 模块八件单（新建模块收链序列） | 契约  | `anc-meta-module-checklist` |
| 三类守卫的性质差异       | 契约  | `anc-meta-guard-kinds`      |
| 空白台账            | 契约  | `anc-meta-guard-gap-ledger` |
| 执行时机与统一入口       | 契约  | `anc-meta-guard-entry`      |
| 守卫自身的可信度        | 契约  | `anc-meta-guard-trust`      |
| 守卫准入规则          | 契约  | `anc-meta-guard-admission`  |
| 跨项目议题通道接入      | 契约  | `anc-meta-hopissues-scan`   |
| 链健康度单一入口        | 契约  | `anc-meta-chain-health`     |
| 守卫链整体闭环·实践指南 | 契约  | `anc-meta-chain-closure-practice` |

---

## 1. 守卫映射：链的每一环由谁守【契约】 ^anc-meta-chain-guards

> 上游原则：[[../concepts/工程实现链规范#^anc-meta-guard-mapping]]（每环显式回答"由谁守"）——本表即其物理形态。

实现链有 **4 个层** 和 **3 个跃迁**（S→D、D→C、C→T），加上穿透全链的**宪法级原则**。逐一列出守卫：

### 1a. 层内守卫（每层自身的内容合规）

| 层 | 守什么 | 守卫 | 判据来源 |
|---|---|---|---|
| 概念层 | 锚点命名合法（`anc-{category}-{concept}`、类别在表内） | `scan.py`（命名违规检查） | `concept-anchor-rules.md` 类别表 |
| 概念/设计层 | **锚点前必须半角空格**（否则锚点隐形、不被采集） | `check-anchor-format.mjs` | `^anc-meta-anchor-space` |
| 概念/设计层 | **同文件禁重复锚定义**（影子契约必漂移、引用歧义） | `check-anchor-format.mjs`（同脚本第二职责） | `^anc-meta-anchor-unique` |
| 代码/测试层 | **@a:/@v: 必须行首注释形态**（句尾粘连采集正则收不到、锚点隐形——0057 G-采集实撞,收敛书写比放宽采集稳） | `check-anchor-format.mjs`（同脚本第三职责） | `^anc-meta-anchor-head` |
| 代码层内核 | **禁触进程级状态**（`process.env`/`process.cwd`/`process.chdir`——run 隔离不变量的机检半边:进程状态只许组合根〔cli.ts 命令入口/mcp-server.ts serve+startRun 入口〕一次读取折进 run 级 HostConfig,内核运行期只消费载体;含模块顶层可变状态禁令） | `check-process-state.mjs` | `^anc-run-isolation`（ARCHITECTURE,单机版架构总条款） |
| 全层文本文件 | **禁含 NUL 等控制字节**（grep 判二进制后全 grep 系工具链对该文件失明——守卫/审计/人工排查集体瞎；2026-08-13 实撞：shell 写入把字面 NUL 带进 parser.ts,review 时"代码在场"险被误判"缺失"） | `check-text-integrity.mjs` | `^anc-meta-guard-text-integrity` |
| 设计层 | 同上 + 模块对外接口清单【封闭】 | `scan.py` + `cross_compare.py`（模块边界违规） | `^anc-meta-module-spec` |
| 设计层 | 公开出口须有说明注释 | `cross_compare.py`（出口注释违规） | 同上 |
| 代码层 | 类型正确 | `tsc --noEmit` | TypeScript |
| 代码层 | 文件归属模块（`@module:` 无遗漏、不悬空） | `scan.py`（模块归属） | `^anc-meta-module-trace` |
| 设计层 | **模块架构工程链审计**（src `@module:` 集合 ⊆ Doctree 索引/ARCHITECTURE/module-principles §7 三处架构视图） | `check-module-arch-audit.mjs`（缺名即红；`check:fast` 内，2026-08-06 准入，原 G10） | `^anc-meta-module-arch-audit`（概念上游=必备件④） |
| 测试层 | 测试真实通过 | `vitest run`（872 例） | — |
| 测试层 | **e2e 测真结果、核真过程**（端到端断言最终结果之外，必须查实际执行日志核验过程轨迹）；**正反例成对**（行为变更的测试必须正例+反例成对——豁免外溢/拦截漏放/修复误伤只有反例测得出；判定/守卫类代码无反例即不完整；2026-08-10 上溯立源：--answer 豁免零测试、#iter 修复只正例两连实撞后入法） | `e2e-execution.test.ts` hoplog 断言 + `carrier-live-e2e` readTerminalEvidence 用 HopLog 单一解析器核验真实 YAMLL 块键 + mcp-server HopLog 恒开断言（G11 2026-08-07 大部销账；余量见台账）；正反例=评审义务（机检不可达——"哪些行为算变更、边界钉哪"是语义判断），语义审计 C→T 维度顺带核 | `^anc-meta-layer-test`（概念层测试原则） |

### 1b. 跃迁守卫（层与层之间是否忠实传达）

| 跃迁 | 守什么 | 守卫 | 现状 |
|---|---|---|---|
| **S→D**（概念→设计） | 设计是否忠实传达概念语义 | anchor-audit **语义审计**（LLM 读源文件判 ✅/⚠️/❌） | ⚠️ 非机检，需人/LLM 跑 skill |
| **D→C**（设计→代码） | 每个设计契约有代码落点 | `cross_compare.py` 设计→代码覆盖 | ⚠️ 基线 185/207 |
| **D→C** | **改代码前设计先行**（时序，不只是存在性） | `check-design-first.sh` | ✅ 绿（2026-08-01 修了路径假阴性） |
| **C→T**（代码→测试） | 每个代码锚点有测试覆盖 | `cross_compare.py` 代码→测试覆盖 | ⚠️ 基线 189/204 |
| **C→T** | **行/分支覆盖率不许变差**（锚点覆盖之外的量化底线；概念上游=`^anc-meta-layer-test` 合理覆盖率原则，2026-08-07 上溯立源） | `vitest --coverage` + `check-coverage-baseline.mjs` 基线比对（2026-08-03 准入，原 G7） | ✅ 基线 src 行 92.5% / 分支 87%（权威=`audits/baselines/coverage-baseline.json`,本格随其人工上调同步——2026-08-17 上调锁三元+walker 批成果;数字以文件为准防两处漂移） |
| **全链** | 追溯卡片与各层实际一致 | `cross_compare.py` 无效引用 / 状态标记 + **`check-anchor-baseline.mjs` 基线比对（变差即红，2026-08-03 准入）** | ✅ 基线锁定 27 / 36（`audits/baselines/anchor-baseline.json`，锚定 822b031） |

### 1c. 宪法级原则的守卫（穿透全链）

| 原则 | 可机检？ | 守卫 |
|---|---|---|
| **锚点对齐** | ✅ | `scan.py` + `cross_compare.py`（全量,不采样) |
| **模块依赖方向**（module-principles §2） | ✅ | `check-layer-imports.mjs`（src 全量 import 含 type，越层即红；豁免=DESIGN 桥接表，2026-08-04 准入） |
| **版本-接口互锁**（module-principles §4） | ⚠️ 部分 | `check-version-lock.mjs`（接口区 diff 而模块版本行无 diff 即红；pre-commit --staged 档 + check/chain-health HEAD~1 档，2026-08-04 准入）。语义分级（MINOR/PATCH）归人 |
| **命名忠实**（`*_id`/`*_path`） | ⚠️ 部分 | 仅锚点类别名机检；字段命名靠人评审 |
| **比喻只解释不指代** | ❌ | 无机检（语义判断，靠人/LLM 评审） |
| **推演链显式** | ❌ | 无机检 |
| **收链前置**（行为宪法） | ❌ | 不可机检（约束 Agent 动作，非产物） |
| **设计先行**（行为宪法） | ✅ | `check-design-first.sh`（机检判据：一次改动 `src/` 改了而 `design/` 没动） |

### 1c-2. 模块八件单：新建模块的收链把关序列【契约】 ^anc-meta-module-checklist

**新建模块＝收链把关最重的一档**（2026-08-06 作者两次定性：①"模块登记需要有一个明确的环节"②"这是 agent 收链把关的工作，不是人的操作手册项"；本节即该环节的守卫链权威——CLAUDE.md 只是本节的汇聚摘要）。

Agent 建模块必须按序收齐八件、**一次改动交付**，不许散落多 commit 事后补（实撞：mcp-server 登记散在四个 commit，靠人两次盘出）。依据 = 元规范四必备件（[[../concepts/工程实现链规范#^anc-meta-module-design-artifacts]]）+ 本库落点（[[module-principles#^anc-meta-module-arch-audit]]）。

| # | 件 | 落点 | 守卫兜底 |
|---|---|---|---|
| 1 | 设计文档先行：定位章节（`^anc-struct-<名>` + 边界声明 + 模块版本 v0.1.0，演进流水归 git log）+ 出口清单【封闭】 | `docs/design/<名>.md` | `check-design-first.sh`（时序）+ G9（版本互锁） |
| 2 | 定层：LAYER 表登记（先在 module-principles §2 对号） | `scripts/check-layer-imports.mjs` | G8（表外新文件显式红） |
| 3 | 新锚点类别（如需）：类别表 + scan.py 常量同步 | `concept-anchor-rules.md` + `scripts/audit/scan.py` | scan.py 命名违规 |
| 4 | 写码：文件头 `@module:` + 契约锚点 `@a:` 逐个落（设计锚点不悬空） | `src/` | scan.py 归属 + audit 状态检查 |
| 5 | 专属测试：文件头 `@module:` + 关键行为 `@v:` | `tests/<名>.test.ts` | C→T 覆盖 + 覆盖率基线 |
| 6 | 三处架构视图同次更新：Doctree（树图/设计层表/模块索引，计数 ×N 也要动）· ARCHITECTURE（组件+双态表）· module-principles §7 盘点 | 三视图 | G10 `check-module-arch-audit.mjs`（在场性） |
| 7 | TRACEABILITY 立卡（权威源→`@a:`→`@v:` 全链） | `TRACEABILITY.md` | cross_compare 无效引用/覆盖 |
| 8 | `npm run check` 全绿；审计"有改善"则锁升基线 | `audits/baselines/anchor-baseline.json` | check 全家 |

**守卫覆盖的如实边界**：各件的"在场性"多有机检兜底（右列），但**"八件一次改动交齐"这个时序完整性本身属行为纪律**（§2 第三类）——机检只能事后逐件抓漏，交齐与否靠 agent 自律 + 人验收（RELEASING 分诊表的核查项）。

### 1d. 特性专属守卫（不属链的通用环节，但守具体契约）

| 守卫 | 守什么契约 |
|---|---|
| `check-hopissues.mjs` | 跨项目议题通道开工扫描（`../hopissues/` 两数:他方 fixed 待本方复验逐条点名——先复验再开新工/报给本方 open+reopen 计数;通道库缺席显式失败不静默跳过——README 接入义务①,规则权威=hopissues/README.md,`^anc-meta-hopissues-scan`;2026-08-17 准入,负向验证=改路径探缺席 exit 1） |
| `check-driver-carriers.mjs` | Codex carrier 静态纪律（禁用 CC 原语、main 不内嵌执行循环、文件完整）+ CC/Codex 稳定协议签名 parity（`^anc-driver-codex-rule-parity`）+ **driver last_sync 一致性**（实改未刷即红——手工纪律三撞升守卫,`^anc-driver-lint-last-sync`;git 不可用显式跳过明说） |
| `carrier-live-e2e.mjs` | CC/Codex 真实宿主进程、subagent 执行体归属、终态业务结果与凭证不落盘（`^anc-driver-live-e2e`）；有费用，opt-in |
| `hoplog-fuzz.mjs` | hoplog 写入路径穷举——每场景真跑 HopLog + js-yaml 解析，暴露 YAMLL 崩溃点 |
| `validate-run-yamll.mjs` | 一次真实 run 的所有 main.yaml 逐块 YAMLL 合法性（复用 fuzz 的 validateYamll 语义） |
| `chain-health.mjs` 内置 examples 校验 | G1 守卫：`hopjit list` 判可执行 spec → 逐个 `validate`，失效即红（复用引擎权威判据，不另造）。首跑即抓出 doc-review.md 的 V8 失效 |
| `chain-health.mjs` 自身 | §7 链健康度单一入口——跑全部确定性守卫按 §1 结构出报告（本表的可执行形态） |
| `audit-scope.mjs`（手动/发版前） | 语义审计增量范围推导——module_ledger（每模块最后审于哪个 commit）× git diff 判"动过没审"，输出按模块跑命令；零 @module 标注 exit 2 显式失败；判据回归常驻 guard-scripts.test.ts（2正2反） |
| `check-scripts-syntax.mjs`（check:fast 内） | scripts/ 全部 .mjs `node --check` + 全部 .sh `bash -n` 语法门（.sh 面 2026-08-14 三档 review 补——7 个 shell 脚本含 release.sh 此前语法零机检,批量脚本改写高频期裸奔）——e2e 断言库等脚本不经 tsc/vitest，语法级断链（如重复声明）此前只有真机跑才暴露（2026-08-11 实撞：断言迁移引入重复 `const log`，vitest fixture 测的是 import 后的函数、编译错在 import 时才炸，5 场景真机全红同因）。零匹配 exit 2 显式失败防 glob 空转；判据回归常驻 guard-scripts.test.ts（正例+两反例）；HOPJIT_CHECK_ROOT 注入 fixture（同族三守卫同模式） |
| `check-e2e-assertions.mjs`（check 内） | 概念 [[../concepts/工程实现链-守卫规范#^anc-guard-assertion-on-chain]]"断言可执行或可重放"的本库落点——对 `passes/` 归档以 offline 模式干跑各场景断言的账面部分（事件流/终态文本判据跳过），语义迁移改漏断言当场红；归档缺席跳过明说（gitignore 本地资产）。断言挂 `@v:` 入收链通道（scan.py `--aux-test-dirs scripts`）；判据回归 e2e-assertion-replay.test.ts 正反例（2026-08-12 准入，原 G13。设计 [[carrier-live-e2e#^anc-driver-live-e2e-assertions]]；沙箱等价台账同批 [[carrier-live-e2e#^anc-driver-live-e2e-equivalence]]，原 G14） |
| `check-line-length.mjs`（`check:fast` 成员） | 设计文档行长纪律 warn（todo/0098 作者拍 300 字线"300字,一行啊!"——docs/design 散文区单行 >300 字点名,排除代码块/表格行;超长单行=实撞叙事逐次追加的灾情原始形态,批一至批三 601+ 处清零后的防复发线）。**报告型 exit 恒 0**（拆行是纪律不是正确性,红档会把顺手小改逼成大批次;量回涨时升红须重走准入四步）;负向验证=临时造 301 字行确认 warn 点名（2026-09-21 批三随批验）。 ^anc-meta-line-length-guard |
| `i18n-staleness.mjs`（`check:i18n`,手动/发版前） | 译本滞后报告（[[i18n#^anc-i18n-translation-discipline]] 第 3 条——译本 @trace last_sync vs 中文源 git 最后改动日,复用 `^anc-driver-lint-last-sync` 日粒度判据;另报结构问题:缺 @trace type:translation/缺 last_sync/source 死链）。**报告型 exit 恒 0**（初期降档不拦是设计条款;译本量上来后升红须重走准入四步）;git 不可用显式跳过;判据回归 guard-scripts.test.ts（1 正 3 反:滞后/新鲜/缺 trace/死链） |
| `parser-fuzz.mjs`（`fuzz:parser`,手动/改 parser 后/发版前;`fuzz:parser:cov` 附带覆盖率） | parser **五**不变量穷举（[[spec-parser#^anc-meta-parser-fuzz]]——删行等价『无静默吞』+双语等价『方案 B 机械核证,替换器独立实现防自证』+往返投影稳定『排版豁免投影不豁免』）。语料=examples 可执行 spec+双种子;惰性白名单=台账每条挂设计出处;已知盲区走 parser-fuzz-known.json 基线（棘轮只许变好,新增即红）;examples 扫描面空转 exit 2;判据回归 guard-scripts.test.ts。首跑战果:双语等价全绿+1 真投影漂移+14 惰性行入账;扩面（2026-08-15 作者拍板）:+④全半角变异等价（探针三中——全角冒号 121 站点/全角右括号 3 站点,按**形态**归组入基线防站点淹没台账）+⑤崩溃安全 no-throw（throw 即红不入基线;js-yaml 边界实证已捕获）+双语面扩 validate 规则码等价（覆盖率揭盲:validator 原 0% 在面）。覆盖率测量 `fuzz:parser:cov`（V8 原生,报 dist 行覆盖=fuzz 盲区量化,不设闸——首测 parser 83.3%/validator 55.9%/总 59.1%） |
| `coverage-report.mjs`（通用报告器） | NODE_V8_COVERAGE 多进程覆盖 JSON 合并→dist/*.js 行覆盖报告（fuzz 与真机三档共用;真机挂法 HOPJIT_COVERAGE=1,见 [[carrier-live-e2e#^anc-driver-live-e2e-entry]] 覆盖率条款;目录空/无 dist 数据 exit 2 不装绿） |
| `builtins-doc-sync.test.ts`（npm test 内） | 内置函数表四消费位同源（名单唯一事实源=src/act-builtins.ts 的 ACT_BUILTINS,四个文档消费位〔concepts 快照/语法参考/教程等,清单权威=设计条款〕逐员比对,新增内置函数漏记文档即红点名——any/all、strip_fence、parse_json 三次入引擎恒漏文档的实撞对治;`^anc-exec-builtins-doc-sync`;2026-09-03 本行补登记——落码落测后登记表缺行,工程链 review 抓获） |
| `config-keys-doc-sync.test.ts`（npm test 内） | Config 引擎消费键与概念层记载面同源（清单唯一事实源=src/ast-types.ts 的 ENGINE_CONFIG_KEYS;双向核:①清单每键在概念层语法参考记载面在场缺即红,②src 索引消费形态 `config?.['键']` 提取键不在清单即红——expansion_max/engine_min_version/requires_commands 三键先后落设计+代码+测试而概念层零条款半个多月的实撞对治,作者抓"工程链严重脱节"2026-09-15;`^anc-ast-config-keys-doc-sync`;先例=builtins-doc-sync 同源钉形态） |

> **登记步漏登第 2 次实撞复审**（2026-09-03 工程链 review 记录）：本表已两次出现"守卫落码落测但登记表缺行"——第 1 次是 hopbuild2 载体词表断言段（`anc-guard-hb2-carrier`,D73 批引入时欠登记、D74 批 review 面四抓获补），第 2 次是本次的 builtins-doc-sync（立卡入 TRACEABILITY 但本表无行）。两次同病：准入四步的第①步"映射表登记"是纯手工动作，无机检兜底。
>
> 评估：登记步可升机检——当 TRACEABILITY.md 出现新的 `@v:` 挂 `anc-guard-*` 或 `anc-*-sync` 类锚的卡片时，比对本表（§1d）有无同名行，缺行即红；形态类似既有的 check-threshold-sync（跨文件同源比对）。是否立项归作者拍板，本段只记录评估结论与两次实撞事实。

## 2. 三类守卫的性质差异【契约】 ^anc-meta-guard-kinds

> 上游原则：[[../concepts/工程实现链规范#^anc-meta-guard-three-kinds]]（三类不混用）——本节给本库实例与失效模式对照。

混用会导致"以为守住了实则没有"，故必须分清：

| 类 | 判据 | 例 | 失效模式 |
|---|---|---|---|
| **确定性机检** | 有唯一正确答案，脚本可判 | tsc、锚点格式、模块边界、覆盖计数 | **误报**（判据本身错，如 `check-design-first.sh` 的路径漏配、`scan.py` 曾拿卡片 id 去嵌套锚点的文件里找）→ 对治见 §5 |
| **语义审计** | 需读源文件理解意图，LLM 判 | S→D 是否忠实、实现是否符合契约意图 | **降级为形式检查**（只看锚点存在不看内容一致）→ anchor-audit 的宪法原则明令"必须读源文件而非凭 ID/行号推断" |
| **行为纪律** | 约束 Agent 动作而非产物，多数不可机检 | 收链前置、默认动手问是例外 | **无从验证**（只能靠 CLAUDE.md 常驻 + 人评审）→ 唯一例外是设计先行，因它在 git diff 里留下可机检痕迹 |

**推论**：宣称"CI 全绿"**不等于**实现链健康——CI 只覆盖第一类。第二类需定期跑 anchor-audit skill（LLM 语义审计），第三类只能靠评审。**别把三类混为一谈**。

**行为纪律新增条：机械翻查外包 subagent（作者定 2026-08-22）** ^anc-meta-review-offload

语义审计与工程链 review 的执行姿态约束——**机械的大面积翻查外包给 subagent，主对话只管判断与决策**。收链前置要求收锚点链，但把链的全文逐轮 grep 进主上下文会淹没判断力（实撞：单特性 review 七轮 grep 灌主窗口——注意力经济被 review 自己违反）。属第三类（不可机检），靠 CLAUDE.md 常驻 + 评审。

- 分工判据：面大于约 3 个文件的锚点链核对、hoplog 逐步走查、测试覆盖清点、跨文件一致性比对 → 外包（subagent 只带回"缺陷+证据行号+建议"）；缺陷真伪判断、修法决定、决策上报 → 主对话保留；
- 本条与 anchor-audit 的"必须读源文件"宪法原则不冲突——读源的是 subagent，主对话消费其结论；
- **长任务 subagent 必须边走边写进度文件**（同日补——派活时指定进度文件路径,subagent 每完成一个单元追加一行结论:人可随时 tail 看进展/中途死掉进度不丢续班可接/主对话仍只消费终报。实撞:28 实例走查跑 5 分钟期间进度无处可看）。

## 3. 空白台账【契约】 ^anc-meta-guard-gap-ledger

> 上游原则：[[../concepts/工程实现链规范#^anc-meta-guard-gap-discipline]]（空白可存在、模糊不允许）——本台账即其在本库的现值。

**台账不是清单**：清单只记录"发现了洞"，台账**强制每个洞有处置**。每项空白必须标三个字段，不允许模糊：

- **处置**：`补守卫`（定验收标准）/ `接受不守`（记 why，何种信号触发复审）/ `待定`（**必须带截止条件**，不许无限期待定）
- **可达性**：机检可达 / 仅语义（LLM 审计）/ 仅行为（人评审）——决定守卫形态的上限
- **触发**：什么事件发生时本项必须重新处置

"接受不守"是合法状态——不是所有环节都值得机检守（成本/收益），但**接受必须显式**。空白可以存在，模糊不允许存在。

| #   | 空白                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 可达性                | 处置                                                                                                                                                                                                                                                            | 触发复审                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| G1  | examples spec 无校验入口——引擎新增验证规则后 spec 失效无人知                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 机检可达               | **补守卫**：`chain-health.mjs` 内置（`hopjit list` 判可执行 → 逐个 `validate`，error 即红）。2026-08-02 实证：V8 规则加入后 `doc-review.md` 失效无人发现                                                                                                                                      | —                            |
| G2  | "设计承诺未实现且未标 v1 偏差"无守卫（pause-timeout 类）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 仅语义（判"实现了没"需读代码意图） | **接受不守（机检层）**：D→C 覆盖率是间接信号；真判定归 anchor-audit 语义审计（G3 的节奏内）。why：机检无法区分"未实现"与"落点在 driver 层"等正当情况，强判必然误报                                                                                                                                                         | 语义审计每轮必查"设计契约 vs 实现存在性"      |
| G3  | S→D 语义审计无常规节奏                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 仅语义                | **补节奏（2026-08-08 机检化，同日修假闸；2026-08-11 作者裁决降为提示不拦发版）**：release.sh ④a 检查 **`semantic_audit_summary.yaml`**（anchor-audit **块二·语义审计**的专属产物，步骤 6.2 带时间戳落盘）——缺失或 >14 天**打印醒目提示后放行**（原"强制人工确认否则中断"降级：语义审计非发版闸——终点凭证〔④ e2e〕才是硬闸，审计节奏靠提示+人自律；实撞：作者发版时被 [y/N] 拦截，裁"这个不应该设置成强行限制"）。**增量节奏（2026-08-11 作者问"能否自动增量"）**：summary 增设 `module_ledger`（每模块 audited_commit/audited_at 累积台账，按模块跑时增量合并不覆盖）；`scripts/audit-scope.mjs` 按台账 × git diff 自动推"动过没审"的模块清单并给出按模块跑命令——审计工作量从"每次全量"降为"只审改动模块"，全量留大版本。⚠️ 初版误核 cross_compare 产物（块一机检、每次 check 刷新→恒绿假闸），当日分拆三块后修正——**分不清 anchor-audit 内部工作性质直接导致闸失效**，是"大杂烩必须拆"的实证 | 审计产物结构变更时                    |
| G4  | 比喻不指代 / 推演链显式两条内容宪法无机检                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 仅语义                | **接受不守（机检层）**：纯语义判断，启发式 lint（检测已知比喻词作指代）误报率会高到淹没信号。靠评审 + 语义审计                                                                                                                                                                                                 | 若同类违规实际发生 ≥2 次，复审是否上启发式 lint |
| G11 | e2e"核真过程"落实（2026-08-07 当日大部销账）：`e2e-execution.test.ts` 原有 hoplog 断言✓；`carrier-live-e2e` readTerminalEvidence 用 HopLog `extractHopLogStepKeys` 核验真实 YAMLL 块键（main.yaml 在场+state 每个 done 步骤有精确记录，缺即红；fixture 由 HopLog 真写，防守卫自测假格式）✓；mcp-server 补 HopLog 恒开+日志在场断言✓；`e2e.test.ts` 经盘点判定**非执行类**（纯 parse/validate 链，无执行过程可核）不适用。**余量①**：轨迹断言的"lint 所有执行类 e2e 含日志断言"元守卫未做——执行类 e2e 现仅三处且均已覆盖，新增时人工核，累计 ≥5 处再上 lint。**余量②（2026-08-07 review 抓出）**：readTerminalEvidence 只扫顶层 main.yaml，而 parallel child 生命周期按方案 A 记在卫星日志（`parallel/<cid>/log/`，见 spec-observability ^anc-obs-parallel-child-satellite）——含 parallel 的 live 场景其 child 步骤在 main.yaml 无块键、会假红。当前 live 场景（coffee-week）无 parallel 暂不触发；上第一个含 parallel 的 live 场景时必须先扩 readTerminalEvidence 聚合卫星日志 | 机检可达               | **大部销账**，余量待定（截止①=执行类 e2e 达 5 处；截止②=首个含 parallel 的 live 场景）                                                                                                                                                                                                   | 新增执行类 e2e 时必查                |
| G12 | 样例/工具 spec 语法漂移无守卫（作者定 2026-08-09 release 必查）：语法改版后旧写法兼容读——引擎绿但**教材含旧写法用户会照抄**（实撞：认知三改后 audit-kit 外仍可能混入旧形态；spec 漂移曾致两载体 demo 不同版） | 机检可达 | **已上守卫**：`check-spec-syntax.mjs`——examples+scripts 全 spec ①validate 绿 ②旧写法黑名单（max_iterations=/check finally/旧统配/旧 call 形态）零命中，**零豁免**（初版曾给"冻结基线"开豁免口，作者当日纠正拆除——语法演进时工具样例必须跟着变）。**③文档行文扫描面**（2026-08-13 作者定"扩"——实撞：概念层 2026-08-09 宣废 check finally 后文档残留 15+ 处含当日新写教程,守卫只扫 spec 文件=盲区,旧术语在行文里繁殖被人肉抓）：docs/ 全 md 的黑名单扫描,**行级豁免**=该行含废止告示类标记词（将废止/兼容读/黑名单/旧写法/旧修饰/兼容判据/过渡期）——废止告示与兼容判据的本职就是提旧写法,按行判不误伤;rounds/ 整目录豁免（讨论存档不改正文）。**④hopbuild2 专项断言段**（D73 批引入对齐门词表断言,D74 批〔hopissues/0062+0065〕扩齐,权威=hopbuild2.md D73/D74）：③a 对齐门 carrier_cons 词表/③b split-node 路径闸/③c 分拆通道 carrier_lines 词表——九子串正典逐词相等（单侧与同步漂移皆红）+毒句每词至少一句+0062 半边三处在场（free_warns 计数/legal_ok 判据/legal_note 指路）+0065 消费接线（syntax_ok 含 len(carrier_lines) == 0）+B7 文案跨层同源（validator 源文与 spec.md 判据子串一致）;③f-6（D101,todo/0104）修检烧尽兜底的人裁接受现状分支——母本 spec.md 与 qwen3.8-27b 变体都查:← 含 exhaust_brief 与 exhaust_path、声明 + → sensible_note、body 给 sensible_note 的赋值同时含这两个变量,提取不到分支即红（不赋值则审阅文件修检遗留节渲染出字面 undefined）。挂 `npm run check` 尾（release ② 全量检查即含） | 语法改版时黑名单同步扩;hopbuild2 载体词表变更时正典清单同步 |




**台账维护规则**：新发现的空白**必须入账**（哪怕处置是待定）；处置为"补守卫"的项完成后**从台账移除、在 §1 映射表登记**——台账只记洞，不记已关的洞（历史见 git）。销账近例：

- G5/G7/G8/G9 均在发现后数日内补守卫销账。其中 G5=scripts/release.sh 十步检查单，0.1.2 四坑+0.1.5 发版时点坑全固化；2026-08-14 +⑥a patch 档 breaking 闸——0.2.6 实撞:breaking 批被缺省 patch 发出,档位判断不能靠人肉记忆;判据=上一 tag 以来 commit 含破坏性标记词即拒 patch 指路 minor,HOPJIT_RELEASE_ALLOW_PATCH=1 显式豁免,事故窗口 v0.2.5..v0.2.6 实测命中 7 条；
- G10=模块架构工程链审计，2026-08-06 mcp-server 实撞当日销账（check-module-arch-audit.mjs，顺带抓出 act-body/shared-errors 两个存量缺登）；
- G13=e2e 断言在链，2026-08-12 销账（断言挂 @v:+scan.py aux-test-dirs 扩面+check-e2e-assertions.mjs 存档重放，首跑即抓 assertParallelSmokeScenario 顶层实例过滤按全路径误滤的真 bug）；
- G14=沙箱等价台账，2026-08-12 销账（carrier-live-e2e §8 ^anc-driver-live-e2e-equivalence 逐场景登记）；
- 边界双指标钉零，2026-08-12 作者定'立刻强化'当日（存量 14 边界违规=5 模块出口表滞后,逐模块补登记清零+4 出口注释补写;anchor-baseline 增 module_boundary_violations/export_comment_violations 两指标钉 0——新增跨模块 import 不登记出口表当场红,'缓慢变差'空间关闭）。

## 3b. 跨项目议题通道接入【契约】 ^anc-meta-hopissues-scan

`../hopissues/` 是 HOP 项目群跨项目问题协同的唯一通道（**规则唯一权威=hopissues/README.md**——状态机/单写侧/probe 闭环判据全在彼,本节不复写只登记本库接入契约）：

- **接入件**：`scripts/check-hopissues.mjs` 挂 `check:fast`（必经点——README 接入义务①"零守护零轮询,通知靠必经点顺带"）;
- **两数报告**：他方标 fixed 待本方复验 N 笔（**逐条点名**并指路"先跑卡内 probe 复验再开新工:绿→closed,红→reopen 携实跑输出"）+ 报给本方待修（open/reopen）N 笔;
- **"待本方复验"必须按 frontmatter 的 `from` 字段过滤**（2026-09-22 立，原先"他库子目录下的 fixed 卡一律点名"的近似判据作废）：
  - **归属判据是谁是报告方**——`fixed→closed` 与 `reopen` 归报告方（README 单写侧规则），所以只有 `from: hoplogic3` 的卡才是本库的复验活。他库子目录下 `from` 是别家的 fixed 卡，报告方是那一家，与本库无关，点名即误派;
  - **为什么原判据当时够用而现在不够**：通道刚接入时参与方只有两家，"在他库目录里"与"本库报的"恰好等价；现在通道里的 `from` 已有七个不同值（本库、知识库项目、几个外部 skill 项目、公开仓等），等价关系破裂;
  - **实撞形态**：`hopkb/0003`（`from` 是知识库项目）被本库守卫连续点名为"待本方复验"，而那张卡的 probe 要知识库项目自己的 Vault 环境才能跑，本库既没有环境也没有义务——每轮 `check:fast` 都在给本库派一件干不了也不该干的活;
  - **`from` 读不到的卡不静默丢**（frontmatter 缺失或损坏）：仍然点名，但单列"归属待核"一档并注明读不到 `from`——宁可多报一条让人核，不可静默漏掉本方真欠的复验。
- **通道缺席显式失败**（exit 1 附 clone 指引）——不静默跳过（[[#^anc-meta-guard-trust]] 同款纪律）;议题在场只报数不拦（exit 0——议题是队列不是违规,拦截会把"有活要干"误标成"库坏了"）;
- **判据随外库演进**：README 接入义务节改版时本脚本随动（外库文档无 ^anc 锚,本节即其在本库的契约投影点）。

## 4. 执行时机与统一入口【契约】 ^anc-meta-guard-entry

**统一入口原则**：人与自动化**共用同一套命令**，杜绝"CI 跑的和本地跑的不一样"。

```jsonc
// package.json scripts（2026-08-02 已实施）
"check:fast":   "tsc --noEmit && node scripts/check-anchor-format.mjs && node scripts/check-text-integrity.mjs && node scripts/check-driver-carriers.mjs && … && npm run -s check:scripts-syntax",
                                                 // scripts-syntax（2026-08-11）：scripts/ 全 .mjs node --check——
                                                 // 断言库等脚本不经 tsc/vitest 编译面,语法断链真机才炸的盲区
"check:audit":  "node scripts/run-audit.mjs",   // 不裸写 python3——npm 子进程无 shell alias，可能拿到
                                                 // 无 pyyaml 的解释器；run-audit.mjs 逐候选实测、找不到
                                                 // 显式 exit 2（禁静默跳过，^anc-meta-guard-trust）。
                                                 // 有发现时报告不挡（基线锁定待 ci-pipeline 决策 3）
"check":        "npm run -s check:fast && npm test && npm run -s check:audit",
"check:health": "node scripts/chain-health.mjs"  // §7 体检视图；含子进程测试前先 build，禁止复用旧 dist
```

| 时机 | 跑什么 | 耗时（实测） | 为何在这里 |
|---|---|---|---|
| **改完代码随手** | `check:fast` | ~3s（tsc 2s + 2 lint <1s） | 快到没有不跑的理由 |
| **提交前** | `check:fast` + `check-design-first.sh HEAD~1..HEAD` | ~3s | 设计先行只有在 commit 粒度才可判 |
| **push / PR 前** | `check`（含 872 测试 + audit） | ~15s | 慢检查不该阻塞每次 commit |
| **发版前** | `check` + `npm pack --dry-run` 清单核对 | ~20s | **不可逆外向操作**——0.1.1 自报版本号错正是从只跑 `clean && tsc` 的 `prepublishOnly` 漏出去的 |
| **周期性（月/里程碑）** | anchor-audit skill 全量语义审计 | 分钟级（LLM） | 第二类守卫，机检覆盖不到 |
| **改中文用户面文档后 / 发版前** | `npm run check:i18n`（译本滞后报告） | <1s | 源-译一致性方向恒为译本追源（翻译三纪律）;报告不拦,滞后清单给续翻批次排程 |
| **改 parser/serializer 后 / 发版前** | `npm run fuzz:parser`（五不变量穷举;`:cov` 变体附覆盖率） | ~5s | 静默吞是 parser 失效主形态（i18n 批五连撞）,机械可判面例行核;不入 check:fast——非改码必跑面 |
| **改引擎后随手（真机例行档）** | `test:live:smoke`（四 smoke:工具三通道/mcp 绑定/多 run 隔离/大输入内联） | ~2min,零/单 LLM | 引擎-工具-server 真机面,无载体进程——mock 盲区（5b-2）的例行覆盖位 |
| **发版前（真机发版档=终点凭证生产）** | `test:live:core`（10 快乐+6 失败路径,两波:13 并发 5+standalone 系串行;`HOPJIT_COVERAGE=1` 前缀附引擎行覆盖报告） | ~13min,有模型费用 | 守卫链终点方案（概念 [[../concepts/工程实现链-守卫规范#^anc-guard-e2e-primacy]] 真机三档）。**机检闸**：场景通过落盘 `.e2e-evidence/*.json`（含 HEAD），release.sh ④ 强制 cc:delegated+codex:delegated 凭证在场且覆盖发版快照（快照制 2026-09-04 起判据对 SNAP 不对 HEAD,权威 [[release-engineering#^anc-release-snapshot]]）——2026-08-08 实撞（agents frontmatter 400 差点带版发出）后把手册纪律升级为发版硬闸 |
| **改 prompt 组装/doc-ref/primer/hopbuild spec/能力门后（真机触发档）** | `test:live:deep [audit\|buildtest\|flash]` | 贵,串行可选跑 | LLM 质量面——深核判定/hopbuild 全链自跑/弱模型长程,不随引擎小改回归,例行跑=烧钱不增信 |
| **想知道链状态时** | `node scripts/chain-health.mjs`（体检视图） | ~30s | 全量+结构化+空白呈现，见 §7 |

**自动化载体**（本地 hooks / GitHub Actions / prepublishOnly）是**这张表的执行机制，不是它的替代**——载体选型见 [[ci-pipeline]]，本文只定"该在什么时机守什么"。

## 5. 守卫自身的可信度【契约】 ^anc-meta-guard-trust

> 上游原则：[[../concepts/工程实现链规范#^anc-meta-guard-self-trust]]（守卫自证四硬要求）——本节记本库三次实撞与四条要求的落地。

**守卫会坏，且坏了默认无声**——本工程已实证三次：

| 事件 | 症状 | 发现方式 |
|---|---|---|
| `check-design-first.sh` 路径漏配 | 对本库所有 commit 都报"src 无改动"，机检形同虚设约半年 | 人工审计时偶然发现 |
| `scan.py` 拿卡片 id 去嵌套锚点的文件里找 | 58 处报缺里 25 处是假报缺失 | 深查个例时发现 |
| `anchor-scan.test.ts` 首版静默跳过 | python 探测失败即 `return`，5 个用例每例 0ms 假绿，比没测试更坏 | **故意改坏被测对象后测试仍全绿**才暴露 |

由此定五条硬要求：

1. **新增守卫必须做负向验证**：故意制造违规，确认守卫**真的红**（并记录在提交信息里）。只验证"当前通过"等于什么都没验证。
2. **守卫的判据变更须过测试**：判据脚本本身要有回归测试（`tests/anchor-scan.test.ts` 锁 scan.py 四条判据；`tests/guard-scripts.test.ts` 锁 G8/G9/G10 三守卫九路径——HOPJIT_CHECK_ROOT 注入 fixture 仓库，合规/违规/判据源异常三态全断言，2026-08-07 补），否则重构时会静默退回。
3. **禁止静默跳过**：依赖缺失（python/pyyaml 未装等）必须**显式失败**并给出装法，不得 `return`/`skip` 冒充通过。
4. **测试输出零假警报**：测试中**故意触发**的错误路径（防呆断言、错误码用例）与被测工具对临时最小工程的正常警告，其 stderr **必须捕获进断言、不得直通终端**（子进程调用加 `stdio: pipe`）——绿灯测试跑出满屏 `Error:`/警告，装包跑测试的人分不清真假、会被吓到（2026-08-06 用户实撞两处：anchor-scan 的"目录不存在"警告 + cli 错误路径用例的 INVALID_STATE/ENOENT）。与第 3 条互补：3 管"坏了不许装好"，本条管"好着不许装坏"。
5. **测试运行器的进度回报不许被用例饿死**：全部用例通过、`npm test` 却退出码 1，同样是"好着装坏"，而且会拦发版。
   - 已知病因：`tests/cli.test.ts` 这类套件用 `execSync`/`spawnSync` 同步起子进程，单个用例在同步调用里连续占住 vitest 工作进程的事件循环。
   - 后果：工作进程向主进程回报进度的 `onTaskUpdate` 调用发不出去，排队超过 vitest 内置的 60 秒通信超时（写死在 vitest 的进程间通信层，配置项改不了），就报 `Timeout calling "onTaskUpdate"` 并计 1 个错误。
   - 治法：`vitest.config.ts` 的 `setupFiles` 挂 `tests/setup/yield-event-loop.ts`，每个用例结束后用 `setImmediate` 让出一次事件循环，排队中的回报在下一个用例开跑前发出。
   - 实证（2026-09-26，vitest 3.2.4，机器负载平均值 6 到 9）：单跑 `cli.test.ts` 不挂让出钩子三次全部复现该报错（273 过、退出码 1）；挂上后三次全部退出码 0、零报错。
   - `teardownTimeout` 放宽（2026-09-04）管的是收尾钩子，管不到这个 60 秒通信超时——当时把它当成这个报错的治法是误判，配置注释已改正。
   - 常驻保护：`tests/guard-scripts.test.ts` 断言 `vitest.config.ts` 的 `setupFiles` 挂着该文件、该文件在 `afterEach` 里让出事件循环；删掉任一处即红。

> 这五条是对治"守卫失效无声/守卫输出失真"的唯一手段——守卫是链的最后一道防线，它自己没有防线。

## 6. 守卫准入规则【契约】 ^anc-meta-guard-admission

> 上游原则：[[../concepts/工程实现链规范#^anc-meta-guard-admission-principle]]（准入即存在）——本节给本库的落位四步。

**问题**：本工程的守卫向来是临场发挥的产物——发现问题 → 写个脚本 → 挂哪儿看心情。结果就是本文开头那句"8 个工具从未被组织成主线"。修好存量不够，**必须堵住增量**：

**一个新守卫（lint 脚本 / 判据测试 / 校验维度）诞生时，必须完成四步落位，缺任一步即视为守卫不存在**（与"缺锚点即缺追溯"同一逻辑）：

| 步 | 落位 | 为什么缺它不行 |
|---|---|---|
| 1 | **§1 守卫映射表登记**（守链哪一环 + 判据来源锚点） | 不登记 = 下一个人不知道这环已有守卫，重复造或漏跑 |
| 2 | **§4 时机表挂载**（什么时候跑、进哪个统一入口） | 不挂载 = "检查存在但不运行"，本文开头的病复发 |
| 3 | **负向验证**（故意制造违规确认真的红，记录在提交信息） | §5 三次实证：只验"当前通过"的守卫可能是假绿 |
| 4 | **TRACEABILITY 立卡**（权威源锚点 → 脚本 `@a:`/`@v:`） | 守卫自己也在链上——它的判据变了，得能追到谁定的 |

**对已收编的空白同样适用**：台账（§3）里处置为"补守卫"的项，完成判据就是这四步——不是"脚本写完了"，是"四步落齐了"。

**准入的反面——退役**：守卫失去判据来源（契约废除）或被更强守卫替代时，从 §1/§4 移除并在 TRACEABILITY 卡片标废弃，不留僵尸条目（僵尸守卫比没有更坏：它给"这环有人守"的错觉）。

## 7. 链健康度单一入口【契约】 ^anc-meta-chain-health

**问题**：要知道链的状态，此前需要跑 5 条命令、看 7 个数字、再人脑对照 §1 的表判断哪些是误报——"主线"停在文档里，没有可执行形态。

**契约**：`scripts/chain-health.mjs` 是链健康度的**单一入口**。它跑全部确定性守卫，按 §1 的结构（层内 / 跃迁 / 宪法 / 特性专属）输出一份结构化报告：

- 每个守卫一行：**绿**（通过）/ **红**（违规，列明细）/ **黄**（基线内的已知欠账，标数字）；
- 空白项照 §3 台账标注 `已知未守（台账 G#·处置）`——**报告必须诚实呈现"没守的部分"**，否则"全绿"又会冒充"链健康"（§2 的推论）；
- 第二类（语义审计）与第三类（行为纪律）守卫在报告尾部固定提示"本报告不覆盖"及其核查方式——防止把机检报告误读为全链体检；
- 退出码：任何红 → exit 1；全绿或仅黄 → exit 0（黄的基线管理见 [[ci-pipeline]] `^anc-meta-ci-baseline`）。

**自举要求**：本脚本自身按 §6 准入规则落位（映射表登记、时机表挂载、负向验证、TRACEABILITY 卡）——它是准入规则的第一个实例，也是对规则可行性的检验。

**与统一入口的关系**：`npm run check` 系列（§4）是**开发动线**（快速、分层）；`chain-health.mjs` 是**体检视图**（全量、结构化、含空白呈现）。前者答"我能提交吗"，后者答"链现在什么状态"。

## 8. 守卫链整体闭环：本库实践指南【契约】 ^anc-meta-chain-closure-practice

> 上游原则：[[../concepts/工程实现链-守卫规范#^anc-guard-chain-closure]]（闭环=规则×制品×工具三分+六档时机）。本节给本库的**逐件对号表**与实践口诀——新人/新 agent 照此走通闭环自检句。

### 8a. 规则×制品×工具对号表

| 概念件 | 本库落点 | 状态 |
|---|---|---|
| 规则·环全集推导 | §1 结构（4 层+3 跃迁+宪法逐条+横向模块×契约件）——本文 §1 各小节即推导展开 | ✅ 表在，**差集检查未机检**（见 8c 缺口） |
| 制品·守卫映射表 | §1 四张表（1a 层内/1b 跃迁/1c 宪法/1d 特性） | ✅ |
| 制品·空白台账 | §3（G2/G3/G4/G11 余量现值） | ✅ |
| 制品·终点凭证 | `.e2e-evidence/*.json`（[[carrier-live-e2e#^anc-driver-live-e2e-evidence]]） | ✅ 2026-08-08 建 |
| 工具·机检脚本群 | scripts/check-*.mjs ×8 + scan.py/cross_compare.py | ✅ |
| 工具·语义审计 | anchor-audit **块二**（按模块分批 LLM 判忠实；产物 `semantic_audit_summary.yaml` 带时间戳）——anchor-audit spec 实为三块编排壳：块一 scan+比对=机检（日常 `check:audit` 已跑）/块二语义审计（G3 节奏的真对象）/块三 fix=写操作（经人确认） | ✅ 节奏闸 2026-08-08 挂 release ④a（核块二产物） |
| 工具·e2e 驱动+hoplog 分析 | `carrier-live-e2e.mjs`（readTerminalEvidence 逐步骤核验） | ✅ |
| 工具·release 闸 | `release.sh` ④（凭证硬闸）+ ④a（审计节奏，提示不拦——2026-08-11 作者降级）。**发版无关面黑名单（2026-08-26 作者两轮定形："不要因为不影响 release 的内容阻断 release"→分拦放；"应该走黑名单，安全点"→缺省拦、显式豁免）**：单一黑名单 `NONRELEASE_RE` 枚举**确认不影响发版产物**的路径（`todo/ docs/ hop_tasks/ audits/ tests/ scripts/audit/ TRACEABILITY.md Doctree.md ARCHITECTURE.md AGENTS.md CLAUDE.md .playwright-mcp/ vitest.config.ts maintainers/`（TODO.md 已随卡目录化退役删除,2026-08-30;vitest.config.ts 2026-09-04 b5a145d3 加入,本行 2026-09-13 补记） + 检查单自身 `scripts/release.sh`——它不被 E2E 测,它的验证就是当次发版执行本身;AGENTS/CLAUDE 是 agent 工程约定件,2026-08-26 黑名单首跑即拦 AGENTS.md 后作者定补入;scripts/audit/ 是语义审计工具面——不进 tarball〔files 字段无 scripts/〕不进 version commit,与 tests/·audits/ 同类,2026-09-01 发版首拦审计 spec 在飞改动后作者定补入〔"这个是不是不应该阻碍发版"〕;`.gitignore` 是仓库追踪面配置——不进 tarball〔npm 打包不含它,pack 用 files 白名单〕不影响 dist 产物,2026-09-01 同日第二拦实锤补入:上一条修复恰改了 .gitignore 一行,④ E2E 凭证闸对"凭证..HEAD 差集"按黑名单判,.gitignore 不在名单内即要求重跑 13 分钟 live:core——而该 diff 对发版产物零影响,重跑买到的信息为零,正是 2026-08-26 立黑名单要防的原形态;`maintainers/` 是维护者内部操作面整目录——不进 tarball〔files 白名单无它〕不影响 dist 产物,原单条 RELEASING.md 2026-09-04 快照制首跑实拦补入〔快照制批改了它一行使凭证差集含它被拦〕,2026-09-13 RELEASING.md 迁入 maintainers/ 后单条收编为整目录），**名单外一切路径（含未来新增的未知路径）缺省按影响发版对待**——白名单会漏放新路径,黑名单只会误拦（误拦补名单一行,漏放是带伤发版）。两处消费：**① 工作区检查**——快照制下降级为警告不拦（发的是快照,主区并行改动不在本次发版内——原黑名单分拦放语义随之退役,脏区仅列出留痕）;**④ E2E 凭证闸**——凭证 commit 须 ==发版快照 SNAP,或为其祖先且 `凭证..SNAP` 的 diff 路径**全部**落在名单内才放行（列出放行清单留痕;快照制 2026-09-04 起基准从 HEAD 改 SNAP——移动靶病根除,权威 [[release-engineering#^anc-release-snapshot]]）,任一名单外路径即拦重跑 live:core（2026-08-26 实撞:改 release.sh 自身+设计文档一笔提交使凭证落后 HEAD,重跑 13min 买到的信息为零）。连带 ⑥ `npm version` 改 `--no-git-tag-version`+手工 commit+tag（npm version 自带全树干净检查,与 ① 分拦放冲突;只提交版本双文件,tag 形态不变,断点续发零影响） | ✅ |
| 工具·阈值同源守卫 | `check-threshold-sync.mjs`（todo/0060——prompt 供给体量阈值"设计写死数字+代码写死常量"双写形态,改常量不改文档无声;映射表 6 组〔RETRY_BASE_INLINE_CHARS/历史行 clip/UPSTREAM_FEEDBACK_GUARD_CHARS/DEFLATE_THRESHOLD/HUMAN_PREVIEW_THRESHOLD/INLINE_PREVIEW_MAX〕,每条钉具体文件+含语境词捕获正则防裸数值误配;两侧不等红,任侧配不到也红〔条款改写/常量改名同属失同源〕;新增阈值=映射表加行+本表随更;挂 check:fast;守卫锚 `^anc-meta-threshold-sync`） | ✅ 2026-09-01 准入四步全过（负向双向:改常量红/改文档红,各复原绿） |
| 工具·教学供给面对账守卫 | `check-teaching-sync.mjs`（D93 防线一,作者抓"知识供给缺口一直在打地鼠"——教学文档是引擎注册面的手写副本,缺口/教错只能靠真机烧钱发现;move src/dst 毒行漏过五层防线正因教学表虽对但无人核 spec 实装。两面:A=教学签名表逐件对 DefaultToolProvider.list() input_schema〔调用形态位的具名参数名,示意值不判〕;B=教学 hop_python 示例段的工具调用参数名核〔作者点名"示例也非常重要"——教错的示例比不教破坏力更大〕。教学面清单文内登记〔split-patterns/dv-knowledge,扩新教学文档加行〕;依赖 dist 缺失显式失败;挂 check:fast;守卫锚 `^anc-build-teaching-sync`） | ✅ 2026-09-16 准入四步全过（负向:教学表 move 改 src/dst 红复原绿;首跑抓 5 处抽取面误报当场收窄——示意变量值/字段访问不判） |
| 工具·统一入口命令 | `check:fast` / `check` / `test:e2e:all` / `chain-health` / `release`（§4 时机表逐档对应） | ✅ |

### 8b. 实践口诀（按时机六档）

| 时机 | 口诀 | 命令 |
|---|---|---|
| 改动中 | 随手快检 | `npm run check:fast` |
| 提交前 | 快检+设计先行 | `check:fast` + `check-design-first.sh HEAD~1..HEAD` |
| 推送前 | 全量 | `npm run check` |
| 建模块/守卫时 | 八件单一次交齐（§1c-2）/ 准入四步（§6） | — |
| 发版前 | 刷终点凭证再发 | `npm run test:e2e:all` → `npm run release`（闸自动核） |
| 想知道链状态 | 一眼体检 | `node scripts/chain-health.mjs`（含终点凭证状态段） |

### 8c. 已知闭环缺口（照台账纪律登记）

| 缺口 | 处置 |
|---|---|
| **差集检查未机检**：§1 映射表 vs 环全集推导的比对靠人工维护（新守卫靠 §6 准入自律登记，漏登无红灯） | 接受不守（机检层）：环全集的"结构推导"本身含语义判断（哪算一环），全自动差集会大量误报；靠 §6 准入协议+本节 8a 对号表人工盘点。触发复审：守卫数量 >30 或漏登实撞 ≥2 次 |
| **chain-health 不含语义审计执行状态**：报告有终点凭证段（2026-08-08 补），但语义审计"最近何时跑过"仅 release ④a 时点核验 | 待定（截止：下次 anchor-audit 全量跑时，顺手把产物时间戳段加进 chain-health） |
