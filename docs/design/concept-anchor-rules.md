%% @trace
	id: hopjit-concept-anchors
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: intent
	last_sync: 2026-08-16T22:51+0800
	note: 概念锚点追溯规则——从概念到测试的细粒度追溯机制。元文档：定义 anc-* 命名约定、各层嵌入语法、TRACEABILITY 卡片格式与维护规则
%%

# 概念锚点追溯规则

> **文档性质**：本文是**锚点机制的元文档（约定规范）**，不是某个 HopType 组件的设计文档。它定义 `anc-*` 锚点的命名约定、各层嵌入语法、追溯文件格式与维护规则——这些规则本身就是必须遵守的约定（标【契约】），文档中的代码块/示例只演示规则用法（标【说明】）。因此本文不套用 HopType 四要素（无 struct/trait 可描述）。本文出现的所有 `^anc-*` 均为**示例**，演示锚点写法，不是本文携带的、需要代码对齐的契约锚点。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 必须遵守的命名/语法/格式约定 | 所有追溯锚点的标注必须符合，anchor-audit 据此校验 |
| **【说明】** | 示例、格式演示、辅助理解 | 与契约一致即可 |

> **关于本文的【契约】**：本文的契约是**约定本身**（命名格式、嵌入语法、卡片格式），不是逐章挂 `^anc-*` 锚点的技术点。普通组件设计文档的【契约】章节带自有 `^anc-*` 供代码对齐；本元文档不同——它规定的就是这套锚点该怎么写，故契约章节不另设自有锚点，其规范性来自约定的强制力。

| 章节 | 分级 | 说明 |
|------|------|------|
| 问题 | 说明 | 动机背景 |
| 概念传播可溯模型 | 决策+契约 | 传播方向与对齐规则（决策）+ 产物类型与锚点语法（契约） |
| 锚点 ID | 契约 | 命名格式、`anc-` 前缀哨兵、类别表——必须遵守 |
| 各层嵌入语法 | 契约+说明 | 各层语法规则（契约）+ 代码块示例（说明） |
| 追溯文件 | 契约+说明 | 卡片结构、状态标记、落差清单格式（契约）+ 示例（说明） |
| 维护规则 | 契约 | 新增/变更/审查的操作约定 |
| 与 `@trace` 的关系 | 说明 | 与文件级追踪的分工对照 |

## 问题【说明】

文件级 `@trace` 解决了文档之间的派生关系（谁从谁来、最后何时同步）。但文件内部的概念——某个 struct、某条验证规则、某个步骤类型——没有锚点，无法回答：

> "HopSpec V3 规范里的 `commit` 步骤，在设计文档哪里细化、代码哪行实现、哪个测试验证？"

需要一套**概念级**追溯机制，补充 `@trace` 的文件级粒度。

## 概念传播可溯模型【决策+契约】

一个概念从**权威源**出发，向下游产物传播。产物类型和数量不固定——有的概念只出现在概念文档和代码里，有的贯穿四五个产物。

```
权威源（概念文档）
  ├─→ 设计文档 A
  │     ├─→ 代码文件 X
  │     │     └─→ 测试文件 T1
  │     └─→ 代码文件 Y
  │           └─→ 测试文件 T2
  └─→ 设计文档 B
        └─→ 代码文件 Z
```

### 传播方向与对齐规则

概念从权威源向下游流动，遵循 `@trace` SSR 的同一套原则：

| 规则 | 说明 |
|------|------|
| **权威源唯一** | 每个概念有且仅有一个权威定义点（通常是概念文档），下游产物引用它 |
| **正向强制对齐** | 权威源改动后，下游产物**必须**同步。方向始终从上游到下游 |
| **反向对齐需确认** | 下游产物（代码/测试）发现概念需要修正时，不得直接改权威源，须向作者确认后再改 |
| **落差即记录** | 发现上下游不一致时，立即在追溯文件中标注，区分"有意偏差"和"待修复" |

### 产物类型

概念可能出现在以下任意类型的产物中（不限于此）：

| 产物类型 | 典型文件 | 锚点语法 |
|---------|---------|---------|
| 概念文档 | HopSpec V3核心规范、HopAnt概念 | `^anc-{id}` |
| 设计文档 | design/spec-ast.md、spec-parser.md | `^anc-{id}` |
| 代码 | src/types.ts、validator.ts | `// @a: anc-{id}` |
| 测试 | tests/parser.test.ts | `// @v: anc-{id}` |

概念不一定贯穿所有产物类型——有多少出现点就追溯多少，不强求"四层齐全"。

## 锚点 ID【契约】

### 命名格式

`anc-{category}-{concept}`，全小写连字符，统一 `anc-` 前缀。

`anc-` 前缀是锚点的**命名空间哨兵**：grep `anc-` 即可精确定位所有追溯锚点，不会误匹配 Markdown 公式（`^2`）、脚注、普通 block reference。同时 `^anc-` 仍是合法的 Obsidian block ID，`[[doc#^anc-step-commit]]` 正常工作。

Obsidian block ID 仅支持字母、数字、连字符（`[a-zA-Z0-9-]`），不支持点号和下划线。锚点 ID 统一使用连字符，确保 Markdown 和代码中的 ID 一致。

### 类别表

| 前缀 | 覆盖范围 | 示例 |
|------|---------|------|
| `anc-step-*` | 15 种步骤类型 | `anc-step-reason` `anc-step-commit` `anc-step-branch` |
| `anc-ast-*` | AST 数据结构 | `anc-ast-spec-ast` `anc-ast-spec-header` `anc-ast-base-step` |
| `anc-type-*` | 值类型与类型声明 | `anc-type-value-types` `anc-type-type-decl` `anc-type-output-decl` |
| `anc-rule-*` | 验证规则 | `anc-rule-s1` `anc-rule-c3` `anc-rule-v1` `anc-rule-p5` |
| `anc-cli-*` | CLI 响应/请求类型与 CLI 行为约定（命令分发、JSON I/O、参数安全、实例解析、幂等性） | `anc-cli-init-response` `anc-cli-dispatch` `anc-cli-idempotency` |
| `anc-provider-*` | Provider 接口 | `anc-provider-tool` `anc-provider-knowledge` |
| `anc-config-*` | 配置类型 | `anc-config-host` `anc-config-sandbox` |
| `anc-error-*` | 错误模型 | `anc-error-error-code` `anc-error-parse-error` |
| `anc-exec-*` | 执行模型概念 | `anc-exec-none-propagation` `anc-exec-retry-adaptive` |
| `anc-struct-*` | HopType struct | `anc-struct-spec-parser` `anc-struct-exec-engine` |
| `anc-driver-*` | 驱动载体（CC / Codex carrier 的角色分工、交接契约、安装布局、静态纪律） | `anc-driver-carrier-polymorphism` `anc-driver-codex-carrier` `anc-driver-codex-agent-roles` |
| `anc-string-*` | 跨切面字符串处理规范（转义、编码、序列化边界） | `anc-string-escape` |
| `anc-run-*` | 跨切面 run 生命周期规范（run 隔离不变量、任务间保障——与 string 同为架构级跨切面契约类,2026-08-14 随单机版任务间保障架构立） | `anc-run-isolation` |
| `anc-i18n-*` | 国际化跨切面（文档多语言树/翻译纪律/关键词双语——2026-08-15 随 i18n 立项立,与 string/run 同为跨切面契约类） | `anc-i18n-docs-tree` `anc-i18n-keyword-reserved` |
| `anc-build-*` | hopbuild 构建器（自举形态/分发布局/知识源三层/校验门落位——2026-08-15 随自举批立） | `anc-build-bootstrap` `anc-build-layout` |
| `anc-viz-*` | 可视化支持（编辑器插件:折叠/大纲/落点高亮——2026-08-16 随 Obsidian 插件立） | `anc-viz-obsidian-fold` `anc-viz-outline` |
| `anc-tool-*` | 工具契约跨切面（声明两面/注册面语义/参数展开——2026-08-25 随工具一等公民批立,横跨 tool-interface/parser/engine/dispatcher 四模块故不归单模块类） | `anc-tool-two-faces` `anc-tool-params-notes` |
| `anc-obs-*` | 可观测性（HopLog） | `anc-obs-log-levels` `anc-obs-file-layout` `anc-obs-hitl-record` |
| `anc-layer-*` | HopAnt 四维度 | `anc-layer-knowledge` `anc-layer-capability` |
| `anc-surface-*` | 语法表层表述变种（同一 AST 的不同书写形态：标准/大纲语法、内联/标题风） | `anc-surface-heading-flavor` |
| `anc-mcp-*` | MCP server 协议面（standalone 执行的工具面、run 生命周期、key 隔离、载体注册） | `anc-mcp-tools` `anc-mcp-run-lifecycle` `anc-mcp-key-isolation` |
| `anc-meta-*` | 工程实现链规范（元规范） | `anc-meta-layer-division` `anc-meta-constitution` `anc-meta-content-grading` |
| `anc-module-*` | 模块规范（概念级，2026-08-08 自元规范收拢单立） | `anc-module-definition` `anc-module-requirements` `anc-module-evolution` |
| `anc-flow-*` | HopSop（HopSpec 无执行态真子集，2026-08-08 上升为概念标准） | `anc-flow-core-requirements` `anc-flow-containers` |
| `anc-ref-*` | 对外契约参考（docs/reference/——对外契约的权威属对外文档,2026-08-13 作者定;用户面文法/字段语义的权威锚,设计层实现契约从这里取对外形态） | `anc-ref-config-contract` `anc-ref-tool-servers` |
| `anc-guard-*` | 守卫规范（概念级，2026-08-08 自元规范单立） | `anc-guard-principles` `anc-guard-mapping` `anc-guard-self-trust` |
| `anc-release-*` | 发版工程设施（快照制发版生命周期/凭证闸/收编协议——2026-09-04 随发版快照制批立） | `anc-release-snapshot` |
| `anc-hoptype-*` | HopType 体系自身的元级约定（区别于 `anc-struct-*` 的具体组件实例） | `anc-hoptype-desc-spec` |

类别表可扩展——新增类别时更新本文件。

> ⚠️ **同步提醒**：本表是权威，但机检脚本 `scripts/audit/scan.py` 的 `CATEGORIES` 常量是**另一份硬编码副本**（`.claude/skills/anchor-audit/scan.py` 是它的软链）。**改本表时必须同步改该常量**，否则新类别会被机检误报"不在合法类别表中"（2026-07-31 扩 `anc-driver-*` 时踩过）。让 scan.py 直接解析本表以消除双真值，属独立治理项。

## 各层嵌入语法【契约】

### L0/L1 Markdown：Obsidian block reference

Obsidian 原生 block reference 机制：在段落/列表项末尾追加 ` ^anc-{id}`（空格 + `^` + `anc-` + ID），即可通过 `[[文件名#^anc-{id}]]` 从其他文件引用该块。

**行中锚定变体（合法定义）**：契约段落也常以 `**标题** ^anc-{id}：正文……` 形式在**行首标题后**锚定（锚点后跟中文冒号继续正文）。这是既有设计文档的普遍写法（22 处），语义等同行尾锚定。**扫描器必须三种都认**（行尾/行中粗体后/表格单元格尾——第三种见下条,2026-09-04 补）。行中锚定判据（两个条件缺一不可）：锚点**紧跟在粗体标题 `**…**` 之后**，且后接 `：`/`:`。行中其它位置的 `^anc-` 提及（如"见 ^anc-x"、"修正 ^anc-x：……"、括号引用）是**引用不是定义**，不采集。

**表格单元格尾锚（合法定义,第三形态）** ^anc-meta-anchor-table-cell：（2026-09-04 todo/0057 G-采集补,实撞:核心规范节点体条目表内 ^anc-step-tool-grant 审计采集收不到,链上凭空断一环）Markdown 表格行的**末单元格尾部** ` ^anc-{id} |` 形态（锚点后跟空格与行尾管道符）。Obsidian 对表格内 block reference 同样可引,概念层用表格组织条目时锚天然落在单元格里——是合法书写不是违规。扫描器判据：锚点后紧跟 ` |` 至行尾,且锚前字符是实内容（排除管道/空白/斜杠——分级表索引行的整格锚 `| ^anc-x |` 与多锚列表 `^a / ^b |` 是引用不是定义,实装两轮误收 12 处假重复后收窄）。表格行中段的 `^anc-` 提及仍是引用不采集。

> **示例规则**：示例一律使用模板占位形式 `^anc-{category}-{concept}`（含花括号）——花括号使示例不匹配扫描正则，不会被误判为真锚点。禁止在示例中使用真实锚点 ID（会与权威定义形成跨文件同 ID 冲突）。

**列表项**（最常见）：

```markdown
- `xxx`：某个概念的一句话定义 ^anc-{category}-{concept1}
- `yyy`：另一个概念的一句话定义 ^anc-{category}-{concept2}
```

引用方式：`[[权威文档名#^anc-{category}-{concept1}]]`

**段落**——锚点加在段落最后一行末尾：

```markdown
某概念的完整段落描述，可以跨多行，锚点附在最后一行末尾。 ^anc-{category}-{concept}
```

**表格**——表格行内锚是第三合法定义形态（见上"表格单元格尾锚"——末单元格尾锚即逐行锚定,Obsidian block reference 对表格行同样可引）。验证规则表这类逐条各需独立锚且行内空间挤的,列表格式仍是更清爽的选择（建议非禁令）：

```markdown
- R1：某条规则的描述，error ^anc-rule-{r1}
- R2：另一条规则的描述，error ^anc-rule-{r2}
```

**⚠️ 硬格式要求：@a:/@v: 必须行首注释形态【契约】** ^anc-meta-anchor-head：代码/测试层锚点标注必须是注释起始处紧跟标注的形态（`// @a: anc-x` 或行尾独立注释 `代码;   // @a: anc-x`——判据:@a:/@v: 之前只能是注释符与空白）。**中文句尾粘连形态非法**（`// ……保留。@a: anc-x`——审计采集正则 `(?://|#)\s*@a:` 只认注释符后紧跟,句中粘连收不到,锚点隐形链上断环;2026-09-04 todo/0057 G-采集实撞:parser.ts 两处粘连形态已移正,同类会再犯,收敛书写形态比放宽采集稳〔放宽=散文提及误采〕）。**块注释形态同属隐形**（` * @a: anc-x */` 星号行——scan 采集正则与格式钉双双收不到,2026-09-04 review 面二实抓活体 11 行含 anc-exec-durable-resume 唯一代码落点;书写收敛为行首 `// @a:` 形态,块注释内不放标注）。机检:check-anchor-format.mjs 第三职责（含块注释形态拦截）。

**⚠️ 硬格式要求：锚点前必须有一个半角空格【契约】** ^anc-meta-anchor-space

`^anc-*` 之前**必须**是半角空格，之后必须是行尾（可有尾随空白）。即 `…描述 ^anc-x-y`，**不可** `…描述）^anc-x-y` 或 `…描述。^anc-x-y`。

- **为什么是硬要求**：机检正则为 `' \^(anc-[a-z][a-z0-9-]*)\s*$'`——要求空格才能与正文里偶然出现的 `^anc-` 字样区分（如散文里写 `见 ^anc-foo` 的行内引用）。缺空格 → 该锚点**根本不被采集** → 设计层"查无此锚点" → 下游连锁误判：TRACEABILITY 卡片标 ✅ 却报"无设计锚点"、设计→代码覆盖率虚低。
- **中文标点尤其易犯**：`）`/`。`/`：` 紧跟锚点时视觉上"看起来有分隔"，实则不是空格。2026-08-01 全库扫出 9 处（`design/spec-parser.md` 4 处、`parallel-execution.md` 2 处、`exec-engine.md` 2 处、`spec-observability.md` 1 处），致 15 张卡片被误判为"标 ✅ 但无设计锚点"。
- **机检**：`scripts/check-anchor-format.mjs` 扫全库 md，锚点前非空格即报错（CI/提交前跑）。

**同文件重复锚定义禁止（2026-08-30 review 实锤后补）** ^anc-meta-anchor-unique：同一 `^anc-*` 锚在同一文件出现两处行尾定义=影子契约——两段各自演化必漂移，跨文件 `[[文件#^锚]]` 引用解析歧义，审计只认其一另一段隐形（实撞：step-dispatcher.md 子实例落盘条款同批两 hunk 重复粘贴整段，audit naming_violation 报红）。机检并入 `check-anchor-format.mjs`：同文件同锚 ≥2 处行尾定义即报错，报文列全部行号让人挑正身。跨文件同锚不在此检（TRACEABILITY 卡与设计文档本就同锚互指）。

### L2 代码：`// @a: anc-{id}`

**`anc-struct-*` 模块锚点的落点通道是 `@module:` 而非 `@a:`/`@v:`**：模块定位锚点的代码/测试落点形式为文件头 `// @module: <模块名> ^anc-struct-x`（src 与 tests 两侧同式）。状态判定（卡片 ✅ 是否成立）对 `anc-struct-*` 认 `@module:` 通道：src 侧有 @module 标注＝有代码落点，tests 侧有＝有测试落点。（check_ref 引用校验已认此通道，状态判定 2026-08-03 对齐。）

**标注行可带尾注说明**：`// @v: anc-x — 说明文字` 合法——扫描器对每个逗号段只取空白前首词作锚点 id，其后的破折号说明忽略（2026-08-03 定；此前尾注会让整段 id 校验失败被静默丢弃）。

**设计锚点合法载体**：`docs/design/*.md`（默认）与根目录 `ARCHITECTURE.md`（架构总览，携带跨组件契约锚点如 `^anc-string-escape`）——扫描器把 `ARCHITECTURE.md` 当设计层文件一并扫。

**合法落点目录**：`src/`（引擎实现，默认）与 `scripts/`（机检守卫实现——守卫自己也在链上，`^anc-meta-*` 契约的 `@a:` 落点多在此）。扫描器两处都扫（scan.py `--aux-src-dirs`，默认含 `scripts/`）。driver 载体契约（`^anc-driver-*`）的落点是 `driver/**` 的**驱动文档本身**，不携带 `@a:` 标注——其落点性质在设计文档头部声明（见 [[codex-driver-carrier]] 头部澄清），对"设计→代码"覆盖维度报缺失属预期。

标注在 interface / type / function / const 的定义行行尾：

```typescript
export interface CommitStep extends BaseStep { // @a: anc-step-commit
export interface ReasonStep extends BaseStep { // @a: anc-step-reason
```

验证规则在具体检查处标注：

```typescript
// S1: title non-empty // @a: anc-rule-s1
if (!ast.header.title?.trim()) {
```

导出函数：

```typescript
export function parseSpec(markdown: string) { // @a: anc-struct-spec-parser
export function validateSpec(ast: SpecAST) { // @a: anc-rule-all
```

### L3 测试：`// @v: anc-{id1}, anc-{id2}`

标注在 `it` 块上方，声明该测试验证了哪些概念：

```typescript
// @v: anc-rule-s1
it('rejects empty title', () => {

// @v: anc-step-commit
it('parses commit irreversible_action from instruction', () => {
```

## 追溯文件【契约+说明】

文件位置：`TRACEABILITY.md`（仓库根目录）。

**用概念卡片，不用矩阵**。一个概念的传播链天然是树形的——从权威源分叉到多个设计条目，每个条目又对应多处代码和测试。用缩进树表示传播路径：

```markdown
## anc-step-commit

有不可逆外部副作用的动作（发邮件、支付、写生产库）

- [[HopSpec V3核心规范#^anc-step-commit]] ← 权威源
  - [[spec-ast#^anc-step-commit]] — CommitStep interface 定义
    - types.ts `CommitStep` — @a: anc-step-commit
    - parser.ts:487 flatToStepNode commit 分支
      - parser.test.ts "parses commit irreversible_action" — @v: anc-step-commit
  - [[spec-parser#^anc-rule-p2]] — ~~P2: commit 须有 approval:bool~~ **【已废除】**（旧 commit 语义残留，新概念授权前置 confirm，见 spec-parser P2 废除说明）
  - [[spec-parser#^anc-rule-p5]] — P5: commit 须有 irreversible_action
    - validator.ts:339 P5 check — @a: anc-rule-p5
      - validator.test.ts "P5: rejects..." — @v: anc-rule-p5
```

### 卡片结构

```markdown
## anc-{category}-{concept}

{一句话概念描述}

- {概念文档位置} ← 权威源
  - {设计文档位置} — {细化了什么}
    - {代码文件:行号} — @a: anc-{id}
      - {测试文件} "{测试名}" — @v: anc-{id}
```

规则：
- 根节点是权威源，标注 `← 权威源`
- 下游产物按传播路径缩进
- 叶子节点通常是测试；没有测试的分支标注 `(未覆盖)` 或 `(后续迭代)`
- **引用不写行号**：只写 `文件名`，不写 `文件名:123`——行号是必然随代码增删腐坏的快照，定位靠 `@a:`/`@v:` 锚点 grep。（2026-08-01 清理掉 386 行历史行号）
- **可校验引用的判据 = 行内带 `@a:`/`@v:` 声明**：卡片行只有形如 `- 文件 — @a: anc-{id}` 才是**机检校验的落点引用**；散文行里提到文件名（如"(未覆盖) types.ts 无 trace_id"、"`src/engine.ts` getLogEvents() 消费……"）是**说明不是引用**，扫描器不得当引用校验（否则散文提一次文件名就背一条"无效引用"，卡片被迫回避文件名——毁可读性换指标）。2026-08-03 定，scan.py 同步。
- **引用路径以仓库根为基准**：`src/`、`tests/`、`scripts/`、`examples/` 前缀都合法；扫描器不得强行补 `src/` 前缀。

**引用行归属契约【契约】** ^anc-meta-card-ref-owner：卡片是**嵌套树**，一张卡片下常列出**相关锚点**的落点（上例 `anc-step-commit` 卡片下列了 `anc-rule-p5` 的 validator 落点）。因此每条引用行归属**该行 `— @a:`/`— @v:` 声明的锚点**，而非所在卡片的 id：

- 引用行**必须**以 `— @a: anc-x`（代码）或 `— @v: anc-x`（测试）结尾声明归属；省略则默认归属所在卡片。
- 校验语义（`scan.py` 实现）：对每条引用，去目标文件里找**标注了该行归属锚点 id** 的 `@a:`/`@v:` 行——找不到即 `invalid_refs`。**不拿卡片 id 去嵌套锚点的文件里找**（那必然找不到，是假报缺失：2026-08-01 曾因此在 58 处报缺里误报 25 处）。
- 推论：嵌套列出别的锚点落点是**合法且鼓励**的写法（它让一个概念的完整传播链可见），审计不因此罚分——但那些行的归属声明必须写对。

### 状态标记

在卡片标题后标注：

| 标记 | 含义 |
|------|------|
| ✅ | 追溯链完整（L0→L3 全部贯通） |
| ⚠️ 落差 | 链条中有断裂，附说明 |
| 🔲 未实现 | 概念存在但设计/代码层有意推迟 |
| ❌ 冲突 | 概念与实现矛盾，需决策 |

**落点声明豁免**：部分锚点的落点**天然不在 src/tests**——伞锚点（落点经由派生锚点）、driver 载体契约（落点=驱动文档）、纯文档程契约（落点=设计文档自身流程）。这类卡片在标题行 ✅ 后**必须**以括注声明落点性质（含"伞锚点"或"落点="字样）；机检状态判定对带此括注的卡**跳过三层齐全校验**（落点真实性归语义审计查）。无括注的 ✅ 卡照常严判——豁免必须显式，不许默豁免。

### 落差清单

追溯文件末尾集中列出所有落差和冲突，每条记录：

| 字段 | 说明 |
|------|------|
| 锚点 | 相关概念的 anchor-id |
| 落差描述 | 一句话说明不一致的内容 |
| 决策 | **有意**（附原因）/ **待修复** / **待确认** |

## 维护规则【契约】

1. **新增概念**：从权威源开始标锚点，逐层向下游传播，最后在 TRACEABILITY.md 新增卡片
2. **权威源变更**：改权威源后，沿传播树正向同步所有下游产物
3. **下游发现不一致**：不直接改权威源，标注落差，向作者确认后再反向对齐
4. **一致性审查**：`grep -rn '@a: anc-\|@v: anc-' src/ tests/` 提取代码侧全部锚点，与 TRACEABILITY.md 交叉比对。也可使用 `/anchor-audit` 技能自动化执行

## 与 `@trace` 的关系【说明】

| | @trace | 概念锚点 |
|---|--------|---------|
| 粒度 | 文件级 | 概念级（行/段落） |
| 位置 | 文件头部 `%% %%` 注释 | 行尾 `^anc-{id}` / `// @a: anc-{id}` / `// @v: anc-{id}` |
| 解决的问题 | 文件从哪派生、何时同步 | 概念在哪定义、在哪实现、在哪测试 |
| 关系 | 互补，不替代 | 互补，不替代 |
