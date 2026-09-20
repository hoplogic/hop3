%% @trace
	id: hopspec-v3-syntax-reference
	source: [[HopSpec V3核心规范]]
	source_id: hopspec-v3-core
	type: compact
	last_sync: 2026-09-20T09:56+0800
	note: HopSpec v3 完整语法参考手册。§0 立设计理念（人机协同生成、关键逻辑可控可靠、探索逻辑可成长、语言层封装降复杂度、自洽上下文防望文生义），贯穿全篇；主体以标准语法写全部构造，末节单列变种语法（大纲语法）。语义权威以源文档为准，本文只做重组不新增语义
%%

# HopSpec v3 完整语法参考

> 本文是 [[HopSpec V3核心规范]] 的**语法参考版**——把规范重组成便查手册，覆盖全部语言构造。
>
> **格式约定**：HopSpec 的树结构权威是 **step ID**（`2.1` 是 `2` 的子步骤），表层排版对机器无意义，因此同一套 AST 允许多个表层表述变种、语义等价。HopSpec 有两种表层语法：**标准语法**（默认，信息密度高、序列化器输出的权威形式）与**大纲语法**（人读审计变种，借 Markdown 标题折叠）。**本文主体（§1–§10）一律用标准语法**；大纲语法单列在末节 [§11 变种语法：大纲语法](#11-变种语法大纲语法)，不与主体交叉，避免混淆。

**目录**

- [0. 设计理念（读语法前先建立）](#0-设计理念读语法前先建立)
- [1. Spec 文档结构](#1-spec-文档结构)
- [2. 步骤摘要行与节点体](#2-步骤摘要行与节点体)
- [3. 15 种步骤类型](#3-15-种步骤类型)
- [4. 类型系统](#4-类型系统)
- [5. hop_python body（act / commit 执行体）](#5-hop_python-bodyact--commit-执行体)
- [6. 变量语义](#6-变量语义)
- [7. 数据流与容器聚合输出](#7-数据流与容器聚合输出)
- [8. 执行模型速查](#8-执行模型速查)
- [9. 验证规则表（23 条）](#9-验证规则表23-条)
- [10. 完整示例（标准语法）](#10-完整示例标准语法)
- [11. 变种语法：大纲语法](#11-变种语法大纲语法)

---

## 0. 设计理念（读语法前先建立）

HopSpec 不是又一门编程语言，也不是提示模板——它是**人与 Agent 协同生成、共同读写**的一门语言。下面这几条理念贯穿全部语法，读每个构造时都应带着它们：**每一处语法设计都在为"人机协同下把逻辑做对"服务**，而不是为表达能力堆语法。

**1. 两类逻辑，两种诉求。** HopSpec 里的逻辑分两类，语法机制各有侧重：

- **关键逻辑 → 可控可靠**：业务不可违反的目标、约束、验收、不可逆操作。靠契约（`Goal`/`Constraints`/`Outputs`）+ 核验（`check final`）+ 探索提交分离（`act`/`commit`）**锁死**——引擎强制、不靠自觉。
- **探索逻辑 → 可成长**：达成目标的具体路径。靠"锁目标、放路径"+ 分层自适应修复 + 渐进固化，让成功路径沉淀复用、系统越用越聪明。

写每个 spec 时先分清：这一步是**必须锁住的关键逻辑**，还是**可以放开探索的路径**——语法（`check final` vs 普通 `check`、`commit` vs `act`、契约 vs Steps）就是给你表达这个区分的。

**2. 语言层封装执行细节，使用者只关注高级业务逻辑。** HopSpec 用**高级结构化步骤替代大量底层代码**，两类封装尤其关键：

- **封装控制流**：`subtask retry` / `check` 替代手写的重试循环 + 失败处理 + 自适应修复逻辑，`act`/`commit` 约定替代手动的副作用隔离与回滚。使用者声明"重试三次仍不达标就上报"，引擎负责怎么循环、怎么传播失败、怎么隔离不可逆操作。
- **封装 prompt 组装（重点）**：这是替代传统 Agent 最繁复部分的关键。传统做法要手写提示词 harness——为每次 LLM 调用手工拼装 context、注入知识、管理记忆、控制 token。HopSpec 里**引擎从 spec 自动组装 6 层 context**（契约骨架 → 知识 → 文档引用 → 执行链 → 步骤输入 → 输出约束，见 §8），作者只需用 `←`/`→`/`>` 声明数据契约与意图，**完全不碰 prompt 拼装**。一份声明式 spec，替代整套提示词工程脚手架。

这些执行细节（重试怎么循环、状态怎么管、prompt 怎么拼、副作用怎么隔离）全部**封装进 HopJIT 引擎**，使用者不必写、也不必读。这层封装带来两个关键收益，正对着人机协同的两个瓶颈：

- **对 LLM**：业务逻辑层的规模被大幅压缩，LLM 不必一口气扛"规划 + 控制流 + 状态管理 + 纠错"的完整代码，**避免因逻辑规模过大而陷入泥沼**。
- **对人（含非编程人员）**：spec 里没有 `while`/`try` 这类只有程序员看得懂的控制流样板，业务方也能读懂"重试三次仍不达标就上报"这样的意图，**代码量骤降、审计可行**。

**spec 的每一行都应表达"业务上要做什么"，而非"程序上怎么实现"**——实现留给引擎，是一次语言层面的封装，极大降低整体逻辑复杂度。

**3. 提供自洽上下文，杜绝望文生义。** 这是 HopSpec 最核心的纪律，也是人机协同的前提——**人和 LLM 都会望文生义，一个模糊的名字或缺失的说明，会在每次被阅读时注入一次错误假设，沿调用链指数放大**。因此：

- **命名禁止望词生义**（宪法级要求）：名称字面含义必须与实际所指一致。存 ID 就叫 `*_id`、存路径就叫 `*_path`，`ChatMessage` 而非 `Message`。
- **每个变量、类型、成员在定义或引入处都必须用 `#` 一句话解释含义**——让读者（人或 agent）无需回溯源头即可对齐语义。
- **上下文自洽**：引擎的每种对外输出（reason/check 的 6 层 prompt、confirm/ask 的介入请求、parallel 标注步骤的派活单）都**自包含**，拿到即知"要我做什么、看什么、给什么"，无需外部查阅。

> 下文各节的语法规则，本质都是这三条理念的具体落地。看到"必须标类型和 `#` 说明""固定双槽签名""聚合输出统一接口名""act 禁循环"等约束时，回想它们服务的是哪一条——语法不是为限制，而是为**让协同双方不误判**。

---

## 1. Spec 文档结构

```
# Spec: <标题>                          # 必选
Id: <标识符>                            # 可选，供 call 引用
Goal: <一句话目标>                      # 必选
> <补充说明>                            # 可选多行，展开说明
Constraints:                            # 可选多项，任务约束
- <约束>
- @knowledge <关键词>                   # 可选，声明需预检索的领域知识
Types:                                  # 可选多项，复用类型定义
- <TypeName>:  # 说明
  - <field>: <type>  # 说明
Inputs:                                 # 可选多项，Spec 级输入声明
- <var>: <type>  # 说明
Outputs:                                # 可选多项，Spec 级输出声明
- <var>: <type>  # 说明
Config:                                 # 可选，Spec 级运行时配置
  model: <service/model>                # Spec 默认模型（覆盖全局配置）
  models:                               # 按步骤类别分档路由（reason/act/check/commit 各可指一档;比 model 更细,两者可并存——类别命中优先）
    reason: <service/model>
  expansion_max: 20                     # subtask free 展开总数上限（缺省 20;耗尽不硬断,拒收报文携问人续批协议）
  engine_min_version: 0.15.1                    # 本 spec 需要的引擎最低版本（pack 打包时自动注入;引擎版本不足则启动即拒,报文带升级/删键两出路;键缺席零比对）
  requires_commands: [git, jq]          # body 经 subprocess.run 依赖的本地命令（启动时与宿主命令白名单对账,缺即拦在进任何步骤之前并指路 hopjit.yaml commands;键缺席零比对,未声明的仍靠运行期白名单拒兜底）
## Steps                                # 有 Steps → 具体实现；无 Steps → HopTrait（Hop契约）
N. [type] <一句话任务描述>
```

| 区域 | 必选 | 说明 |
|------|------|------|
| `# Spec: <标题>` | **是** | 规约标题 |
| `Id: <标识符>` | 否 | Spec 标识符，供其他 spec 通过 `[call]` 引用。含 `[commit]` 步骤的 spec，id 应以 `_commit` 为后缀。**可选函数签名** `Id: func(in...) -> out...`（只列名字、按名对应 Inputs/Outputs、id=func 名） |
| `Goal: <目标>` | **是** | 一句话目标 |
| `> <补充说明>` | 否 | Goal 的展开说明 |
| `Constraints:` | 否 | 约束条件列表（含预期目标如"行数保留率 ≥ 90%"和硬性限制）；可含 `@knowledge` 与 `[[文档路径#章节名]]` |
| `Types:` | 否 | 复用类型定义，首字母大写（PascalCase 词组），步骤中直接引用 |
| `Inputs:` | 否 | Spec 级输入变量声明，供 `[call]` 传参映射 |
| `Outputs:` | 否 | Spec 级输出变量声明（交付物=完备性契约）。初始 `None`，执行中赋值；结束仍 `None`=完备性违约，run 判 failed（缺哪个输出入 failure_reason） |
| `Config:` | 否 | Spec 级运行时配置。五个引擎消费键：`model`（默认模型）/`models`（按步骤类别分档路由）/`expansion_max`（subtask free 展开总数上限,缺省 20）/`engine_min_version`（引擎最低版本,不足启动即拒）/`requires_commands`（body 依赖的本地命令,启动时与宿主白名单对账缺即拦） | ^anc-spec-config-keys
| `## Steps` | 条件 | 有 Steps：具体实现，至少一个步骤。无 Steps：**HopTrait（Hop契约）**——仅由 Goal/Constraints/Inputs/Outputs 定义接口契约 |

**Spec 的两种形态**：

- **有 Steps**（具体实现）：完整定义执行路径，HopJIT 按步骤执行。
- **无 Steps = HopTrait（Hop契约）**：只定义 Goal/Constraints/Inputs/Outputs——接口契约。HopJIT 启动有序思考自主生成执行路径并验证，或从 Spec 库匹配已沉淀实现。调用方通过 `call` 调用时无需区分对方形态。这是"锁定目标，放开路径"的极致——连 Steps 都可不写（见 [[HopSpec V3扩展-有序思考与渐进固化]]）。

**声明区文法警告（2026-08-30 作者定"做吧"——宽容面定点收紧）** ^anc-rule-decl-zone-warn：解析器对不认识的行总体宽容（散文/注释自由写是设计本意），但**纯声明区**——`Inputs:`/`Outputs:`/`Types:`/`Constraints:`/`Config:` 五段与 `Id:` 行（`Tools:` 段的行形态错误早已是响亮 parse error，不需要本规则）——里的行本就该全是声明：这些区内**不匹配任何文法的非空行升解析警告**（warn 非 error——不拦执行，但写错的行不再无声蒸发；实撞形态：`- 城市：text` 用了全角冒号 `：`，整行静默丢，"变量未定义"在三十行外的消费步才爆，症状指向消费方病灶在声明行）。警告附修法提示：行内含全角冒号 `：`、全角括号 `（）` 等疑似全角标点时点名（中文输入法第一手滑）。豁免：空行、纯 `#` 注释行、嵌套子行（Types 字段行等已入文法的形态）。**Steps 区同罩（2026-08-30 作者令"这个也修掉"追加）**：步骤区内不匹配任何步骤文法的非空非注释行（流浪散文、`+ ->` ASCII 箭头误写等）同样报警告——这些行原先也是静默丢弃。Steps 之后的叙事章节（`## 使用说明` 等非关键字标题起）不收紧——那里的散文是合法自由文本。另一刀同批（同族静默面）：**步骤指令区的 ```hop_python 围栏开了没关，报解析错误**（原先静默接受——闭栏行被删掉 body 照样提取，产物截断不可见）。

---

## 2. 步骤摘要行与节点体

### 摘要行

每步一行：`N. [type] description`

| 部分 | 必选 | 说明 |
|------|------|------|
| `N.` | **是** | 编号，支持多级（`1.`、`2.1.`、`2.1.3.`）。树结构由 step ID 编码，缩进仅视觉辅助 |
| `[type]` | **是** | 步骤类型（15 种） |
| `description` | 否 | 一句话任务说明（建议 80–130 字符，语义完整）。只描述意图，不声明输入输出 |

### 节点体：五种前缀

| 前缀 | 含义 | 说明 |
|------|------|------|
| `- ←` | 输入 | 输入变量，只写变量名（类型和说明已在源头声明）；**建议**就近加 `# 说明`，非强制 |
| `+ →` | 输出 | 输出变量，首次出现**必须**标注类型和 `#` 含义说明 |
| `- 工具:` | 工具授权 | 特殊工具的节点级授权（`- tools:` 同义）——每工具一行 `- 工具: 工具名  # 本步用它做什么`，`*` 表全量授权。无 body 的 act 与 reason 消费（授权声明才对本步下发该工具；基础文件工具零声明恒可用；check 无工具面）。位置在 `←`/`→` 之后、`>` 之前。权威见核心规范 `^anc-step-tool-grant` |
| `- 禁工具:` | 工具禁用 | 工具的节点级禁用（`- deny_tools:` 同义）——每工具一行 `- 禁工具: 工具名  # 为什么禁`。授权行的对称半边，管辖面更宽：能关任意工具**含零声明恒可用的基础族**（如 write）；被禁工具从本步工具清单整体剔除，执行者根本看不到。禁 `*` 不合法（真要全禁逐件列名）；同名既授又禁写时报错。消费面同授权行（无 body 的 act 与 reason）。位置与授权行同带。权威见核心规范 `^anc-step-tool-deny` |
| `>` | 执行说明 | 约束、方法、关注点、`@model`、`@thinking`、`@knowledge`（可选，段落级，放在 `←`/`→` 之后） |

```
1. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_plan:  # 修复方案
    - strategy: text  # 整体修复策略
    - missing_handling: [line]  # 各列缺失值处理方式
  > 权衡数据保留率与质量，选择合适的处理方案
```

**关键规则**：

- **变量名全局唯一**：不同数据不能同名，保证引用无歧义。变量**自然保留**（Python 语义），同名再次 `+ →` 是**更新**（重写）而非重声明、不触发重名校验。**内置类型名是保留字**：`text/bool/line/number/int/float/markdown/yaml/prompt/HopSpec` 不能作变量名（校验器拒）——类型词只出现在类型位。**全部语言关键词（中英两表）同为保留字**：段头词（`inputs/outputs/config/steps` 等）、步骤类型词（`reason/act/check/ask/call/loop/subtask` 等在内的 `[…]` 步骤词）、属性子句词（`retry/max/collect/into/in` 等）都不能作变量名——完整清单见 [12. 中文关键词对照](#12-中文关键词对照双语直通)（表中每个英文词及其中文对应词均禁）;条件统配词 `else`/`其他` 同禁（变量取名 else 会与 `[case(else)]` 统配两义）。`outputs`/`steps` 这类自然变量名最易撞,改带限定词的名（如 `output_files`）即避开。**变量名=Unicode 标识符（Python 3 同款）**：字母（含中文）或下划线开头,后续字母/数字/下划线——`风险等级` 合法;`x-alias`/表达式串校验器拒。
- **首次声明 vs 简写引用**：变量首次作为 `+ →` 输出时必须标注类型和 `#` 说明；后续再次出现（输入或输出）只写变量名，可逗号合并：`- ← data_profile, clean_suggestions`。
- **每个变量、成员变量都必须用 `#` 一句话解释含义**，避免后继误用。
- **复合类型**用 YAML 缩进展开（见 §4）。

### `>` 指令区的两种特殊标注

- **`@knowledge <关键词>`**：步骤级知识检索注入（执行该步骤及子步骤时检索）。
- **`@model service_id/model_name`**：步骤级模型路由覆盖。仅对可执行步骤（reason/act/check/commit）有效。路由优先级：步骤 `@model` > Spec `Config.model` > 全局 routing_rules > 全局默认。
- **`@thinking on|off`**：步骤级思考开关（可选，2026-09-20 新增）。单独控制本步骤的模型思考通道——机械性步骤（提取、格式转换、照单填表）标 `off` 可大幅省费用（思考型模型实测 8-9 倍），重推理步骤标 `on` 可让缺省不开思考的模型拿到推理档能力。不标时按引擎的思考缺省链决定（步骤类型缺省：act 关、reason/check/act free 开——运行配置可逐层覆盖，见配置参考）。仅对可执行步骤有效；带 `hop_python` body 的步骤引擎直接执行不调模型，标了无效果也不报错。写在 `>` 指令区一行一条，与 `@model` 可同步共存。
- **`@src <原文出处>`**：步骤级源锚点（可选）——本步骤翻译自上游文档（自然语言 skill 等）的哪一处，出处记法自由（段落号/原句引文/章节名）。**纯追溯元数据，零执行语义**：解析期从指令区剥出存 AST（与 `@model` 同通道），**不进执行 LLM 的 prompt**、不影响任何执行行为；serialize 往返保留。消费方是翻译工具链（hopbuild 对账/原文演进后增量重审）与人工审阅。

```
2. [reason] 分析舆情风险
  - ← social_data, news_data
  + → risk_level: enum(low, medium, high)  # 风险等级
  > @model deepseek/deepseek-v4-pro
  > @knowledge 舆情风险评级标准
  > 综合各渠道数据，评估当前舆情风险等级和趋势
```

### doc-ref：`[[文档路径#章节名]]` 确定性精确引用

在步骤 `>` 指令区或 `Constraints:` 中写 Obsidian 风格 `[[文档路径#章节名]]`，引擎读该文件、按 markdown 标题切出该章节、注入 context 的 L2d 层。

- **确定性**：作者钉死"注入这一节"，无相关性排序、无语义匹配（区别于 `@knowledge` 的模糊语义检索，两者正交可并用）。
- **章节级精度**：强制 `#章节`，不支持 `[[doc]]` 整文档引用（易爆 token）。
- **YAML 目标文件按键切（2026-09-08）**：目标是 `.yaml`/`.yml` 时锚点写键——`[[faults.yaml#键名]]`（全文档找首个同名键）或 `[[faults.yaml#外层键.内层键]]`（点路径，限逐层直接子级不许跳级）；切出该键及其下子树连同键行上方紧邻注释块（原文行区间，注释保留）。规则表存 YAML 的材料（故障知识库/检测器注册表）由此可按键精准注入，不必整文件灌或散文指路。
- **环境参数展开（2026-08-14）**：路径位可用 `{hop_env_xxx}`——`[[{hop_env_kb_root}/判据/规范#节]]`，值取自 hop_env 覆盖链（系统配置 env: 节 → 项目配置 → params → ask，后者逐键覆盖前者）。只认 `{hop_env_*}` 形态；路径写字面 `{`/`}` 用 `\{`/`\}` 转义。引用未定义键=注入期响亮报错不静默空串。hop_env_* 只读（`+ →` 产出/body 赋值带此前缀=校验错；ask 输出放行——覆盖链合法末级）；凭证严禁入此空间（走 api_key_env 纪律）。权威见核心规范 ^anc-config-hop-env。
- **找不到即显式失败**：文件或章节不存在 = 校验错（规则 23，spec 加载期静态执行），不静默降级。
- **仅 agent 通道**：只为 reason/check/act 等步骤解析；confirm/ask 等面向人的暂停通道不解析（人靠 Obsidian 原生点击）。

---

## 3. 15 种步骤类型

分三组：工作节点（叶子）、结构节点（容器）、控制流（叶子）。

### 工作节点（叶子）

#### `reason` — LLM 推理

需要 LLM 推理的分析、判断、决策，产出新知识。关键产出后应安排 check 步骤。

- 单个 reason 以平铺推理为主，避免内含复杂逻辑结构；需要分支/循环时用 HopSpec 步骤结构表达。
- HopJIT 可将复杂 reason 拆为多个推理环节执行（建议不超过 5 步）并做内置核验，Spec 层面仍视为单步。
- 输出约束内置 `lack_of_info` 退出选项——LLM 可声明信息不足，触发知识补充检索后重试，避免幻觉。

```
2. [reason] 综合分析舆情态势，评估风险等级
  - ← social_data, news_data
  + → analysis: text  # 舆情分析
  + → risk_level: enum(low, medium, high)  # 风险等级
  > 关注负面情绪占比、传播速度、意见领袖参与度
```

#### `act` — 无推理、无循环的计算与工具调用

确定性计算、API 调用、数据变换。**必须无不可逆外部副作用**（仅无副作用计算 + 沙箱/临时区操作），可安全重做重试。

- **body = 无推理编排**：纯计算 + 白名单工具调用 + 无推理分支（`if 确定性条件`），可选 `hop_python` body（见 §5）。无 body 时按自然语言描述执行。
- **禁止循环**：需循环升 `loop` 步骤。
- **生成期 vs 执行期**：body 由 LLM 规划时生成，执行期严格照 body 执行、不推理。
- **act body 分支 vs HopSpec `branch`**：影响"本步输出值怎么算"→ act body 分支（值层面分流）；影响"执行哪一串业务动作"→ 升 HopSpec `branch`（业务路径，case 产出可被后继引用）。

```
1. [act] 统计数据质量指标
  - ← raw_data
  + → profile:  # 数据质量画像
    - missing_rates: [float]  # 各列缺失率
    - anomaly_count: int  # 异常记录数
```

#### `commit` — 有不可逆副作用的计算与工具调用

发邮件、支付、写生产库等。**与 `act` 同源**（body 定义完全复用），**唯一区别**：副作用**不可逆、不可重试**。

- **推荐幂等**：body 尽量设计为幂等（按业务键 upsert 而非无条件 insert），避免崩溃重放导致重复副作用。
- **不能出现在 `subtask retry/adaptive` 内**（除非有 `confirm` 兜底）。
- **自身不带授权环节**：能执行到 commit 说明授权已在前序完成（环境预授权，或前置 `confirm` 完成鉴权）。需人工把关时，作者在 commit **前面**放 `confirm`。

```
4. [confirm] 审批重命名方案
5. [commit] 执行批量重命名（不可逆）
  - ← rename_plan
  + → done: bool  # 执行完成标志
```

#### `check` — 验证已有产出

验证已有产出是否满足预期，不做分析推理，仅输出通过/失败判定。

- **必须在 `subtask` 或 `case` 容器内**，失败触发所在容器粒度的 retry。
- **固定双槽签名（封闭，有且只有两槽，不能多/少/换类型）**：
  - 槽 1 `bool`：判定结果。引擎**按类型定位**（认 `bool` 槽，与变量名无关），`false` → check 失败 → 触发容器升级阶梯。
  - 槽 2 `text`：失败说明。**仅失败时被查看**（通过时引擎不读，值可空）。
- 用 `+ →` 把两槽映射到用户变量名（系统语义不占用用户命名空间）。

```
3.2. [check final] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
  - ← clean_data, quality_threshold
  + → quality_ok: bool   # 判定槽：是否达标
  + → quality_note: text # 说明槽：未达标时缺口（通过时不被查看）
```

**`finally` 修饰符**：`[check final]` 是 `Constraints:` 的可执行化身——subtask/case 的任何成功路径必须经过此检查，**adaptive 不可改写或跳过**（类似 `try/finally`：策略步骤是可重写的 try body，finally check 是不可绕过的验收门）。

- 所有 `subtask` 和 `case` 均可包含 `[check final]`。
- 必须位于 children **末尾**（连续 `check final` 块之前不能有非 `check final` 步骤）。
- retry 耗尽时 subtask 直接 fail，不再执行 finally check。

#### `confirm` — 纯审批闸门

暂停执行，等待有权决策者 approve/reject，是显式 CITL（Caller-in-the-Loop）介入点。Caller 可以是人类（HITL）或上层 Agent。

- **单一职责=审批动作**（approve/reject），不收集业务数据值（要数据用 `ask`）。
- 用 `- ←` 声明待审批数据（展示给决策者），`+ →` 声明审批结果，**仅允许 `bool` 类型**（approve→true）。
- **reject → 全局中止**：所有未终态步骤标 `skipped`、执行终态 `failed`（保证后续 commit 绝不执行）。
- `require_human`：强制必须真人确认（`[confirm require_human]`）。
- "谁有权批"由宿主身份层裁定，不在语言语义内。

```
3. [confirm require_human] 用户确认重命名方案
  - ← rename_plan
  + → approved: bool  # 审批结果
```

#### `ask` — CITL 数据收集

暂停执行，向 caller 请求**业务数据值**（确认推断、多选一、自由填写），值落到 `+ →` 声明的变量。

- **单一职责=数据提供**，与 confirm 正交：confirm 答"批不批"，ask 答"值是什么"。
- 用 `- ←` 声明候选/推断来源，`+ →` 声明要 caller 提供的数据（任意类型）。
- 无 reject 全局中止语义（ask 不是闸门）。
- `require_human`：必须真人提供。
- **`present_inputs`（可选）**：列出"必须完整展示给 user 才能作答"的变量名子集，每个名字必须已在该 ask 的 `← inputs` 中。driver 收到含此字段的 paused 响应时**必须把这些变量原文完整 dump 给 user**，禁止只给标签/省略号/摘要。用于"草稿 → user 审 → 再继续"场景（PPT 大纲确认、文档评审 P0、合规 sign-off）。

```
2. [ask] 请用户确认目标领域
  - ← inferred_domain, candidate_domains
  + → target_domain: line  # 用户确认的目标领域
  > present_inputs: inferred_domain
```

#### `call` — 调用另一个 Spec

格式（结构化逻辑标准写法 2026-08-09）：`N. [call <Id>(输入映射)] 任务描述`——机读（callee id + 输入映射）全进方括号，与 `[case(条件)]`/`[loop for-each …]` 同构（方括号=机器面，其后=人读面）。

- **输入映射入括号（callee 参数名: caller 变量名或字面量，同名只写名）**：`callee_param: caller_var` 逗号分隔——左边是 callee `Inputs:` 声明的参数名，右边是 caller 的变量（前序步骤产出或 caller 的 Inputs）；同名省略成裸名；无输入写 `[call id]`。等价 Python 具名传参：`data_cleaning(source_data=order_text)`。
- **映射值位可写字面量（2026-08-27）**：`split_kind: "seq"` 把常量 `"seq"` 直接传给 callee——形态是封闭枚举：带引号字符串（同型引号成对）、数字、小写 `true`/`false`/`null`；对象/列表不入映射字面量。枚举外裸词恒为变量名（`True`/`None` 也是裸词），变量缺失按既有语义不注入、不静默转字符串。
- **输出 `+ →` 行收取（caller 变量名: callee 输出名，同名省略）**：`caller_var: callee_output`。两方向对称：冒号左边收、右边给。
- ⚠️ 旧形态 `N. [call] <Id> : 描述` + `- ←` 输入映射行：**过渡期兼容读，将废止**——新写一律用标准写法，序列化只写标准写法。
- **callee 位插值（晚绑定,2026-09-05 定形并落地）**：callee 位可写 `{变量}`——`[call {issue.analyzer_spec}(problem: issue.kind) parallel]`，执行期求值出 spec Id 或路径再走既有 call 链路。何时用的判据：生成期能枚举的恒用静态 Id / for-each+call（正例:固定三份分析 spec 就写三个 call）;只有"连调哪个子 spec 都要现场定"才用插值形态（正例:探索步跑完才知道每类问题该配哪份分析 spec）;不许用它把本该静态声明的调用推迟到运行期（静态可核性白丢）。权威见核心规范 `^anc-step-call` 插值条款。
- 也可调用其他 skill 或系统能力（需针对性明确调用规范）。
- **跨调用层上升语义**：`confirm` 由 runtime 直达有权决策者（不逐层上传）；`lack_of_info` 逐层自治上升（就近知识源优先）。

两侧对照（映射两端各是谁家的名字）：

```
# callee（data_cleaning.md）声明自己要什么:
#   Inputs:  source_data: text
#   Outputs: cleaned: text

# caller 里（caller 自己的变量叫 order_text）:
1. [act] 读取订单文本
  + → order_text: text         # caller 变量：前序步骤产出
2. [call data_cleaning(source_data: order_text)] 调用数据清洗子流程
  + → clean_result: cleaned    # caller 的 clean_result ← callee 的 Output cleaned
```

### 结构节点（容器）

#### `subtask` — 顺序子步骤分解

- `retry=N`：children 中步骤失败时整体重试，最多 N 次，缺省 3。逻辑不变，重跑相同步骤。
- `adaptive`：retry 修饰符，允许 LLM 重试时分析失败原因并重规划子步骤，缺省关闭。
- adaptive 重规划限定在 children 内，交付契约（`+ →`）不可变、`[check final]` 不可改写——**改策略不改目标、不改验收标准**。

```
3. [subtask retry=3 adaptive] 执行修复并验证质量达标
  + → clean_data: [DataRecord]  # 修复后数据
  3.1. [act] 按策略修复数据
    - ← raw_data, fix_strategy
    + → clean_data
  3.2. [check final] 验证修复后质量达标
    - ← clean_data, quality_threshold
    + → quality_ok: bool  # 判定槽
    + → quality_note: text # 说明槽
```

**`[subtask free]` 到步展开档**（`[子任务 开放]` ≡ `[subtask free]`——权威 [[HopSpec V3核心规范#^anc-step-subtask-free]]）：children 可空——写卡时只声明契约（输入/交付/描述），执行到步时引擎停下索计划（请求携执行时上下文：输入实际值+描述+全局目标），规划方出 children 提交后接续执行。展开物必须含 check、禁 commit（不可逆动作写在 subtask free 之外消费其交付物）。

```
4. [subtask free] 按分析结果处置异常项（到步展开——处置方式取决于步骤 2 的分析结论）
  - ← analysis
  + → 处置记录: text  # 每项异常的处置结果
```

#### `parallel` 属性 与 `loop for-each` — 并发与遍历

**`parallel` 是 subtask / call 的申报属性**：声明主体承诺"本任务自包含、无共享写、可安全多实例并行"（被调方自我申报，与 `requires_commit` 同构）。执行语义全局一条：**主线执行到标注步骤 → 派出去跑，不等完成，主线继续；容器完成前把派出去的活全部收好（收齐）**。未标注步骤主线自己同步做（缺省即串行）。申报属实由依赖分析把关（验证规则表 S12）：标注步骤与容器内其他步骤无变量依赖，且其输出容器内不可消费（只经容器边界导出——loop 走 collect 列表，subtask 容器走头部 `+ →`）。并发路数=系统配置（缺省 5，主线自算一路），不进 spec。

**parallel 只改时机，不改产出链拓扑（2026-09-04 明文化——此前隐含，实撞后补）**：挂上 parallel，唯一改变的是标注步骤的产出**何时到达**（子实例终态收割时才有值），产出**到达后走的路一步不变**——串行时它怎么沿声明链流（步骤产出 → 所在容器边界聚合 → 逐层向上 → 循环 collect 收集），并行时就怎么流。中间隔着别的容器（比如把 call 包在一层带失败兜底的 subtask 里）是完全合法的形态：收割把产出投递回标注步骤在链上的位置，中间容器照常完结、照常聚合边界产出。**失败同理按声明链投递**——失败回到标注步骤位置，包围容器的事务机制（retry / on fail 兜底）照常接手，不因并行而绕过。写 spec 的人只需要保证声明链本身完整（每层中间容器把被收集的变量声明为自己的边界产出——静态校验 S16 会核这条链，漏声明写时就报），并行与否不改变数据流的形状。

**`loop for-each`** 是 loop 的列表遍历形态：`[loop for-each <item> in <list_var>, collect <单项> into <列表>]`——引擎驱动游标逐元素执行 children，`<item>` 为每轮元素绑定（children 及后代可 `←` 引用，类型=列表元素类型）。**收集用 collect 子句显式声明**："对每个 item，把单项收进列表"——children 每轮产出 `<单项>`（T），引擎收进 `<列表>`（[T]，容器头 `+ →` 声明）并复位单项槽；单项与列表两个名字两个变量，各自单一类型。无收集需求可不写 collect（纯副作用循环/普通末值/累加器导出）。⚠️ 定义纪律：`<list_var>` 必须是 `[T]` 列表类型已定义变量；其消费边由引擎**从子句自动合成**——`- ← <list_var>` 行写不写都合法（不写不缺边、写了零提示）；`<item>`/`<单项>` 定义点=子句自身（不另写声明行）；**禁止**用 reason 步骤让 LLM 数游标。

兄弟并发（多个标注步骤并列，可与未标注步骤混排）：

```
2.1. [subtask] 采集各渠道数据          # 容器边界=收齐点
  + → social_data: yaml  # 社交媒体数据
  + → news_data: yaml  # 新闻媒体数据
  2.1.1. [subtask parallel] 采集社交媒体舆情   # 派出去跑
    + → social_data
    2.1.1.1. [act] 调社交渠道接口
      - ← channels, keywords
      + → social_data
  2.1.2. [subtask parallel] 采集新闻舆情       # 与 2.1.1 并发在跑
    + → news_data
    2.1.2.1. [act] 调新闻渠道接口
      - ← channels, keywords
      + → news_data
```

循环体并发（渐进流水线——体内标注，循环头无属性）：

```
2. [loop for-each file in file_list, collect issue into issues] 并行审查每个文件
  + → issues: [yaml]  # 收集列表（失败的活不贡献元素）
  2.1. [subtask parallel] 审查单个文件   # 每迭代派出一个，边遍历边并发
    + → issue: yaml   # collect 单项端
    2.1.1. [reason] 审查
      - ← file
      + → issue
```

循环体内串行生产+call 派发（流水线形态——生产有序，构建并发）：

```
3. [loop for-each ch in chapters, collect built into results] 逐章构建
  + → results: [text]
  3.1. [act] OCR/钉版/确认            # 主线串行，有序依赖
    - ← ch
    + → confirmed: text
  3.2. [call construct(src: confirmed) parallel] 派发构建   # 下一章生产与本章构建重叠
    + → built: text   # collect 单项端
```

顺序遍历（体内不标注即得——累加器可用，中途 break 收集已完成部分）；单项需事务重试时 children 内嵌 `[subtask retry=N]`（retry 仅属 subtask，loop 无 retry——失败单元是单次迭代）。并发是步骤的性质不是容器的形态：循环头不可标 parallel。

#### `branch` — 条件决策

children 必须全部是 `case`。同层级互斥步骤必须放在同一 branch 的 case 下。

- **声明 `+ →` 作为聚合输出的统一接口名**，各 case 用**同名 `+ →` 填充**（"同名 = 同一个东西"，V2 不视为重名冲突）。
- 被激活 case 的同名输出由 branch 透传到外层作用域，后续 `←` 引用始终是 branch 声明的那个名字，路径无关。
- 无 case 命中 → branch 静默跳过，**引擎不写任何值**（与 case/loop 某轮未产出同构，变量读值按 §6 变量语义通则）。

#### `case` — 分支条件

仅出现在 branch 下。**case 就是 branch 下的 subtask**——除"被 branch 按条件选中激活"外，执行语义与 subtask 完全相同：可含 check/check final（放末尾）、支持 `retry=N`/`adaptive`。被选中 case 失败（retry 耗尽）即所属 branch 失败。

- **条件语法（结构化逻辑标准写法）**：`N. [case(条件)] 人读描述`——**机读全在 `[]` 内**（与 loop/subtask 属性同构），描述纯人读。裸 `[case]` = default 兜底。
- ⚠️ 旧形态 `[case] 描述 (条件)`：**过渡期兼容读，将废止**。
- **条件 = hop_python 纯表达式**（与 act body 同一文法）：字面量（数字/字符串/`true`/`false`/**`None`**）、变量、字段 `point.type`、下标 `items[0]`、切片 `items[1:3]`（端点可省可负，钳位）、等值 `== !=`（Python 严格——跨类型不相等不异常、None 与未赋值互等）、`is`/`is not`（仅限 None 判定，`x is None` ≡ `x == None`）、序比较 `< > <= >=`（Python 语义同类型才可比——数字互比、字符串字典序、列表逐元素；跨类型按不匹配）、`and or not`（短路）、**成员测试 `in`/`not in`**（`x in items`）、算术与一元负号、括号、裸变量真值、**内置 pure 函数**（零副作用可反复求值，全表见 §5，如 `len(items) > 0`）。**禁工具调用**（有副作用）、**禁赋值**（只读）。示例：`(high_count > 10)`、`(risk == "high" and count >= 3)`、`(not urgent)`、`(upstream == None)`、`("urgent" in tags)`。
- **enum 成员裸写是结构化逻辑标准写法**（`risk_level == high`——high 是声明过的枚举成员，不加引号；校验器核对成员在场，变量禁与枚举成员重名）；自由文本字符串建议加引号；比较位置裸标识符无同名变量时兼容为字面量。
- **省略括号时整行即条件**（如 `[case] severity == "fatal"`）。
- `(default)` 或空条件均表默认 case。

```
3. [branch] 按风险等级决定响应策略
  - ← risk_level
  + → alert_report: markdown  # 预警报告（聚合输出：统一接口名）
  + → actions: [line]  # 应对行动项
  3.1. [case(risk_level == high)] 高风险
    + → alert_report: markdown  # 同名填充（同一个东西）
    + → actions: [line]
    3.1.1. [reason] 生成详细预警与应急方案
      - ← risk_level, trend
      + → alert_report, actions
  3.2. [case] 低/中风险
    + → alert_report: markdown  # 同名填充
    + → actions: [line]
    3.2.1. [reason] 生成常规监控小结
      - ← risk_level, trend
      + → alert_report, actions
```

#### `loop` — 循环执行

循环执行 children，直到满足退出条件。`max=N`（缺省 100）。

- 变量跨迭代**自然保留**（Python 语义）；累加器用 `+ → acc: type = 初值` 在容器入口 init 一次，需每轮重置的量在子步骤显式 `+ → x = Null`（见 §6）。

```
2. [loop max=20] 逐条审查
  + → findings: yaml = []   # 累加器：容器 init 一次为空列表，跨迭代累积
  2.1. [reason] 取下一片段判严重度
    + → severity: line      # 每轮被本步重新产出，自然覆盖上轮值
  2.2. [act] 追加本轮发现
    - ← findings, severity
    + → findings            # 更新累加器（更新模式，非重名）
```

> 有数据产出的容器（subtask / loop / case）必须声明 `+ →` 聚合输出，外部步骤只引用容器输出，不穿透 children。纯控制流容器可省略输出声明，隐含 `+ → none`。

### 控制流（叶子）

#### `break` — 跳出 loop

`[break]` 跳出最近祖先循环；`[break <循环步骤号>]` 跳出指定祖先循环（多层嵌套从内层直接跳出外层，如 `[break 1]`）。只能在 loop 容器内（任意嵌套深度）；带目标时目标必须是自身的祖先循环，否则报错。

#### `continue` — 跳过当前迭代

进入下一轮。`[continue]` 作用最近祖先循环；`[continue <循环步骤号>]` 作用指定祖先循环。只能在 loop 容器内（任意嵌套深度）；带目标时目标必须是自身的祖先循环，否则报错。

#### `exit` — 结束整个 spec

用 `+ →` 标记交付的变量名（类型已在 `Outputs:` 或前序步骤声明）。若无输出，显式写 `+ → none`。若 `Outputs:` 非空，exit 必须交付所有声明的输出变量。

```
5. [exit] 交付修复数据和质量报告
  + → clean_data, quality_report
```

---

## 4. 类型系统

> **先立纲（§0 理念在类型层的落地）**：类型系统的第一要务不是"表达能力"，而是**杜绝望文生义**——
> - **命名禁止望词生义**（宪法级要求）：名称字面含义必须与实际所指一致（存 ID 叫 `*_id`、存路径叫 `*_path`，`ChatMessage` 而非 `Message`）。一个误导性名称在每次被人或 LLM 阅读时都注入一次错误假设，沿调用链指数放大。
> - **每个类型、变量、成员在定义或引入处都必须用 `#` 一句话解释含义**——让读者无需回溯源头即可对齐语义。类型只给"形状"，`#` 说明给"所指"，两者缺一不可。
>
> 下面的类型只是"形状词汇表"；真正让协同双方不误判的，是**忠实命名 + `#` 说明**。

输出变量（`+ → var`）首次出现必须标注类型和 `#` 注释；已声明过的再次出现只写变量名。

**原子类型**：

| 类型         | 含义              | 示例               |
| ---------- | --------------- | ---------------- |
| `bool`     | 布尔              | `true` / `false` |
| `int`      | 整数              | `42`             |
| `float`    | 浮点数             | `0.85`           |
| `line`     | 单行字符串（可标 `line(非空)`/`line(nonempty)` 非空约束——见核心规范约束标注条款） | `"模型训练完成"`       |
| `text`     | 多行纯文本（默认）       | 对话回复、诊断文本        |
| `markdown` | 结构化 markdown 文档 | API 文档、分析报告      |
| `yaml`     | YAML 格式文本块      | 结构化输出            |
| `prompt`   | 组装好的 LLM prompt | system prompt    |

> 传统 `str` 按语义细分为 line/text/markdown/yaml/prompt/HopSpec，帮助 LLM 明确输出格式意图。

**领域特化类型**（在文本类上叠加领域语义）：

| 类型 | 基础类型 | 含义 |
|------|---------|------|
| `HopSpec` | markdown | 符合 HopSpec 格式规范的 markdown |

**容器类型**：

| 语法 | 含义 | 示例 |
|------|------|------|
| `[Type]` | 列表 | `[line]`、`[ChatMessage]` |
| `(Type, Type)` | 元组 | `(int, text)` |
| `enum(v1, v2, ...)` | 有限值枚举 | `enum(high, medium, low)` |

**复合类型用 YAML 展开**（仅单步骤用的复合类型直接在节点体内展开）：

```
+ → report:  # 精算分析报告
  - summary: text  # 执行摘要
  - metrics:  # 模型评估指标
    - gini: float  # 基尼系数
    - auc: float  # ROC 曲线下面积
  - recommendations: [line]  # 业务建议列表
```

**复用类型**（跨步骤复用）：在文档级 `Types:` 定义，PascalCase 首字母大写，步骤中直接引用：

```
Types:
- ChatMessage:  # 对话消息
  - role: line  # 角色标识（system/user/assistant）
  - content: text  # 消息正文

## Steps
1. [act] 收集对话历史
  + → messages: [ChatMessage]  # 对话历史
```

**命名约束**（承本节开头的"命名禁止望词生义"纲领，落到具体规则）：

- 复用类型用 PascalCase，必须用**词组**（≥2 词），不用单词（`PolicyRecord` 而非 `Record`）。
- 避免与原子类型（`text`、`int`、`float` 等）冲突。
- 名称自解释所属领域（`ChatMessage` 而非 `Message`）。
- 存 ID 叫 `*_id`、存路径叫 `*_path`——名字直接暴露"所指是什么"。

---

## 5. hop_python body（act / commit 执行体）

`act` 和 `commit` 的执行体（body）用 **hop_python** 表达——HopSpec 的一种**受限编排语言**，写在步骤 `>` 指令区内的 ` ```hop_python ``` ` 代码围栏里。

- **HopSpec 受限子集，非真 Python**：`python` 指语法风格（缩进块、`if cond:`/`elif`/`else:`、无花括号），不是真 Python 运行时。引擎解析为 HopSpec 中立 AST，由任意宿主语言引擎（TS/Python/Rust）解释执行（环境无关原则）。`hop_` 前缀即"HopSpec 方言、非宿主语言"的命名忠实标记。
- **能力边界 = 白名单**：body 只能做四类事——
  1. 基础运算（算术 `+ - * / % // **`、字符串拼接与重复、比较、布尔 `and/or/not`、`in`/`not in`、字段/下标（含负数）、切片 `seq[start:stop]`（端点可省可负，钳位宽容；无步长形态——反转用 `reversed(l)`，隔位取用推导式配 `range`）、字面量构造 `[1, x]`/`{"k": v}`、f-string `f"共{n}条"`）；
  2. 白名单调用（内置 pure 函数 ∪ 宿主 `ToolProvider` 注册的工具）——pure 函数全表（**与 Python 同名同义**）：数值 `len` `min` `max` `round` `abs` `sum`｜文本 `lower` `upper` `strip` `split` `join` `replace` `startswith` `endswith`｜文本剥壳与解码 `strip_fence(text, key?)`（机械剥 LLM 产文本值外层的代码围栏壳；第二参 key 可选——给出且剥后首行恰为 `key:`/`key: |` 时连键前缀与其引入的缩进一并剥）`parse_json(text)`（JSON 文本 → 结构值，供内置工具族的 json 字符串返回值取字段；**幂等**——入参已是结构值/数字/布尔/null 时原样返回,复用模式回传链提前解析过也不炸〔2026-09-05 作者定容错〕；解析失败按计算异常折本步失败，不静默）｜序列 `sorted` `reversed` `range` `count`（**单参列表计数**——`count(xs)` 返回列表元素个数，字符串入参报"期望数组"；Python `str.count` 的双参子串计数形态引擎没有）｜聚合谓词 `any` `all`（接受列表；`any([])` 为 False、`all([])` 为 True——存在性判定与推导组合即成（嵌套≤2，见 §5 推导规则），如 `hit = any([startswith(c, g) for g in given_list])`）｜结构 `keys` `values` `get`｜类型转换 `int` `float` `str` `bool`（零副作用，case 条件亦可用）。成员测试用 `in`/`not in` 运算符；None 检测用 `x is None` 或 `x == None`（同义，`is` 仅限 None 判定）。
     **实例上下文函数**（性质不同于 pure，不混列：依赖实例环境、零副作用，仅 act/commit body 可调——case 条件里调用为静态错误）：`work_zone_path(rel?)`（本实例涂鸦区下的绝对路径，无参返回涂鸦区根，禁 `..` 穿越）、`now()`（ISO 8601 当前时刻）、`today()`（当前日期 YYYY-MM-DD）——时间值首次求值入本步 journal，重试/崩溃恢复重放取记录值保确定性。另有 `subprocess.run`（白名单命令行调用，非纯——外部进程有副作用，同样仅 body 可调），完整写法与正反例见本章末专节；
  3. 赋值（局部变量与 `+ →` 输出）；
  4. 无推理分支（`if`/`elif`/`else`）。
  调白名单外的任何东西 = 非法。
- **工具命名空间 = `ToolProvider.list()`**（唯一权威名字源）：独立模式引擎直接 `ToolProvider.execute`；复用模式 caller 必须按清单注册同名工具（把 CC 的 Read/Write/Bash 等包装成清单声明的名字与签名）。body 只认统一名字空间。
- **禁循环**：body 不含 `for`/`while`——升 `loop` 步骤。词法即拒绝循环关键字。
- **词法契约**：缩进**只接受空格、禁止 tab**；行尾 `#` 注释；数据从 `←` 取、局部变量顺序传递、写入 `+ →` 输出。
- **自然语言说明与 body 功能一致（2026-08-30 作者定）**：带 body 的步骤，`>` 说明与步骤标题必须**如实、完整地说清 body 在干什么**——说人话，不吝啬字数。body 是执行权威，但说明是人审计和 LLM 理解上下文的入口：说明说"统计数量"而 body 还悄悄写了文件，审计的人就被说明骗过去了。判据：只读说明不读代码的人，对这步会发生什么的预期与实际零偏差。反例——说明"核对清单"、body 里却有 `subprocess.run(["git", "push"])`：说明漏了不可逆动作，比没有说明更危险。
- **生成期 vs 执行期**：body 由 LLM 规划/adaptive 重规划时生成；执行期被严格解释、不再推理。纯计算 body 由引擎自动消化；含工具调用的 body 交 caller 严格逐行执行。

```
N. [act] 执行数据修复
  - ← raw_data, fix_strategy
  + → clean_data: [DataRecord]  # 修复后数据
  + → repair_summary: [line]  # 修复操作摘要
  > ```hop_python
    filled = fill_missing(data: raw_data, strategy: fix_strategy)
    if fix_strategy.clip_enabled:
        cleaned = clip_outliers(data: filled, threshold: fix_strategy.z_threshold)
    else:
        cleaned = filled
    clean_data = cleaned
    repair_summary = fix_strategy.actions
    ```
```

### subprocess.run：白名单命令行调用 ^anc-step-subprocess-run

body 里可以执行外部命令行程序，写法**完全对齐 Python 的 `subprocess.run`**（2026-08-29 作者定——"写是按 python 写"，名字是写法的一部分；这是 hop_python 唯一的 `x.y(...)` 形态，引擎认此字面为内置，不开模块系统）。前提：命令名必须在宿主 sandbox 配置的命令白名单里（`runtime.available`）——**名单空 = 此能力关死**，引擎不内置任何命令。依赖的命令名同时写进 Config 段的 `requires_commands:` 键（spec 自声明命令依赖）——引擎启动时拿声明与宿主白名单对账，缺配置在进任何步骤之前就拦下并指明加进 hopjit.yaml 的 commands: 列表；键缺席零比对（存量 spec 零破坏），未声明的命令仍由运行期白名单核兜底拒。

```python
# ✅ 正确:命令与参数在一个列表里,命令是第一个元素,一个参数一个元素
r = subprocess.run(["git", "worktree", "add", wt_dir, commit_id])

# ✅ 正确:边界显式——喂 stdin 用 input=,超时 timeout=(秒,缺省 60),工作目录 cwd=(缺省本实例 work_zone)
r = subprocess.run(["grep", "TODO"], input=diff_text, timeout=30, cwd=work_dir)

# ✅ 正确:结果是结构体,字段名同 Python——命令失败不炸,returncode 的处置写 check 步或分支
ok = r.returncode == 0
hits = r.stdout
```

```python
# ❌ 整串命令行——没有 shell 在解释它,这会找一个叫 "git diff" 的命令,必失败
r = subprocess.run("git diff")

# ❌ shell=True——恒拒:把 shell 走私进来,白名单管控全失;bash/sh 也不该进白名单
r = subprocess.run(["bash", "-c", "grep TODO src/"], shell=True)

# ❌ 参数挤在一个元素里——"TODO src/main.ts" 会被当成一个文件名找
r = subprocess.run(["grep", "TODO src/main.ts"])

# ❌ check=True——恒拒:HopSpec 无异常机制,失败是值;returncode 的处置写 check 步或分支
r = subprocess.run(["npx", "vitest", "run"], check=True)
```

只认 `input=`/`timeout=`/`cwd=` 三个具名参数——Python 白名单外的参数（`check`/`shell`/`env`/`capture_output` 等）逐个拒并指路，不静默吞（`capture_output` 不需要：输出恒捕获，它就是 spec 变量的来源）。

**管道**——shell 的 `a | b`，标准写法=逐段调用、上一段的 stdout 显式喂给下一段的 `input=`（Python subprocess 本来的惯用法）：

```python
# ✅ git diff | grep TODO 的形态
diff_r = subprocess.run(["git", "diff"])
grep_r = subprocess.run(["grep", "TODO"], input=diff_r.stdout)

# ✅ 更好:命令自带过滤时不接管道——少一段,中间数据不走变量
log_r = subprocess.run(["git", "log", "--grep=fix"])
```

```python
# ❌ 想在参数里写管道——"|" 只是个字符,grep 会把它当文件名找
r = subprocess.run(["git", "diff", "|", "grep", "TODO"])
```

逐段调用的三个顺带好处：每段输出是变量、进执行账，坏在哪段一查便知；每段可单独判 `returncode` 走分支，不必整链重来；中间值可被后续任何步骤复用。一句话：**命令 = 白名单里的名字开头的一个列表；管道 = 上一段的 `.stdout` 显式喂给下一段的 `input=`。没有 shell，没有整串命令行，没有黑箱中间流。**

---

## 6. 变量语义

HopSpec 变量遵循**统一 Python 语义**：**命名空间是函数级扁平的**——一份 spec 的一次执行 = 一次函数调用 = 一个命名空间；subtask/loop/branch/case 是控制流块**不是作用域**（同 Python 的 for/if/try），任何步骤产出的变量后续任何步骤都可见可更新，真正的边界只有 call 子 spec（=函数调用）和 parallel 派出去的活（=独立进程）。同名同型 = 同一变量再赋值（合法）；同名异型才是 error。变量一律**自然保留**——跨迭代（loop）、跨重试（subtask retry）都不自动清空。**引擎不做任何"每轮自动清空"的隐式行为。**

- **累加器**（跨迭代累积）：在 loop 或其上层容器节点声明 `+ → acc: type = 初值`，初值在**每次容器进入时**求值并写入（同一 loop 自己的轮间不算"进入"——累加器跨迭代保值；**外层循环每轮重新进入内层容器算新的进入,初值重灌**——嵌套形态下上一外层项的值不会漂进下一项〔hopissues/0050,2026-08-31 引擎判定:写了 `= 初值` 就是表达"每次进入从初值开始"〕）。子步骤以更新模式（`← acc … + → acc`）读取并累加。
- **显式重置**（每轮/每次清空）：在子步骤显式声明 `+ → x: type = Null`（或其它初值）。该步骤每次执行时写入初值——loop 内每轮该步都执行，即每轮重置。**重置是 spec 里可见的一步，不是引擎背后的魔法。**

**`= 初值` 语法**（`+ → x: type = 初值 # 说明`）：

- 声明在**容器节点**（loop/subtask 自身的 `+ →`）→ **每次进入时 init**：容器进入时写入，跨迭代/重试保留（累加器）；外层容器轮进导致的**重入是新的进入**，重灌初值（嵌套循环不漂残值——需要跨外层项传递的值别写 `= 初值`,声明在更外层）。
- 声明在**叶子步骤**的 `+ →` → 该步**每次执行时**重置为初值（每轮清零）。
- `Null`/`None`/`null` 归一为空值；其余按 type 解析字面量（`[]`/`{}` 空集合、**非空对象/列表按 JSON 解析**——`{"committed": 0}` 得对象非字符串（写坏 JSON 当场 parse error 指路,不静默存串——串在运行期 `x["k"]` 必炸"非对象取下标",病灶离报错隔一层）、`0`、`false`、`""`、裸文本为字符串）。
- 与 `←` 带入的关系：`= 初值` 显式声明**优先**——想沿用上游带入值就不写 `= 初值`。

**残留由作者负责**（同 Python）：若某变量某轮/某分支未产出，`←` 会读到上一次的值（不是 undefined）——要避免就显式 `= Null` 重置，或确保每轮必产出。validator 只校验"变量名已声明过"（静态存在性，扁平已声明集），不追踪运行时是否本轮产出。

---

## 7. 数据流与容器聚合输出

- **数据流方向**：`- ←` 输入 / `+ →` 输出。步骤输入必须来自前序步骤输出或 `Inputs:` 声明（规则 14）。
- **容器聚合输出**：有数据产出的容器（subtask/loop/case）必须声明 `+ →` 聚合输出，外部步骤只引用容器输出、不穿透 children。纯控制流容器可省略（隐含 `+ → none`）。
- **branch 聚合**：branch 声明 `+ →` 作为统一接口名，各 case **同名填充**；被激活 case 的输出由 branch 透传外层。无 case 命中 → 静默跳过、不写任何值。
- **for-each 收集**：`collect <单项> into <列表>` 子句显式声明——children 每轮产单项，引擎收进列表（串行中途 break 时为已完成迭代的部分列表）。
- **call 双向映射**：冒号左目标、右来源，引擎在父子变量空间自动搬运。

---

## 8. 执行模型速查

### Prompt 组装（6 层 context）

HopJIT 为 `reason`/`check` 步骤组装 prompt 时按 6 层构建：

| 层级 | 来源 | 内容 |
|------|------|------|
| L1. Spec 契约 + 骨架 | Goal + Constraints + Types + Outputs + Steps 骨架 | 不随步骤变化的全局背景 + 静态步骤树（含 step_id/type/summary、嵌套结构、容器关键属性；不含执行状态/产出值/节点体） |
| L2. 知识上下文 | KnowledgeLayer.retrieve | 领域知识（Spec `@knowledge` 预检索 + `lack_of_info` 补充 + 步骤 `@knowledge` + 动态检索）。可选 |
| L2d. 文档引用 | doc-ref `[[文档路径#章节名]]` 解析 | 作者钉定的确定性精确引用。可选 |
| L3. 执行链上下文 | 执行树 | 从根到当前步骤：容器结构、已完成产出、loop 迭代状态、branch 命中哪个 case |
| L4. 步骤输入 | `- ←` 变量 | 当前步骤依赖的实际数据 |
| L5. 步骤指令 | 摘要行 + `>` | 任务目标和执行指导 |
| L6. 输出约束 | `+ →` 类型结构 | 期望的输出格式和字段 |

> L1 骨架（静态计划地图）与 L3 执行链（动态轨迹）互补不重叠；当前步骤在 L3 仅作位置锚点，其 `←/>/+→` 契约交由 L4/L5/L6 承载。

### 失败传播（函数级 fail，与异常同构）

- 每步隐式状态 `hop_status`：`ok` | `fail`。`fail` 时记录 FailRecord（失败步骤/reason/fail_kind/轮次，逐轮累积随实例留存）。
- **fail 只有两个去向**：被事务边界（subtask/case 的 retry/adaptive）接住修复，或穿透全部边界**终止整个 spec 实例**（与未捕获异常终止函数同构）。没有"失败了继续往下跑"。
- **fail 不碰值空间**：失败不把输出置 None、不清理不回滚（残留处置归 spec 作者）。None 是普通值，仅来自 `= Null` 重置或声明未产出；条件里可用 `x is None` 检测走降级分支。
- 计算异常也是 fail：body 算错 → 本步 fail；case 条件算错 → branch fail。
- retry 耗尽 = 标准 fail 继续升级——容器作为一个步骤找外层事务边界重跑，顶层无人接住则实例终止、上报 caller。
- parallel 标注步骤（派出去的活）是**唯一显式例外**（集合语义，作者标注即选择容忍部分失败）：一个活 fail → 主线与其余在跑的活不受影响；失败的活不贡献收集元素（**列表变短，不填 None**），由收齐后的消费步骤决定是否接受部分结果。主线步骤 fail 则相反：本容器在跑的活**全部杀死**（killed，不留幻影），容器整体 fail。

### 分层重试与自适应（`retry` 总预算 N 内，按可信度降级）

1. **retry（无 adaptive）**：每次失败重跑相同子步骤，逻辑不变，最多 N 次。
2. **retry + adaptive — 降级阶梯**（可信度由高到低）：
   1. **带反馈重跑**：重跑相同结构，注入上次失败说明（非机械盲跑）。
   2. **选预声明备用链路**：按 `(spec_id, step_id, 错误模式)` 查备用链路库，命中则选预写测过的备用 children。**高可信——是选择不是生成**。
   3. **基于备用链路重规划**：以备用链路为脚手架 + 新错误信息，LLM 重规划。**中可信**。
   4. **从零重规划**：无匹配备用链路时 LLM 从零重规划。**低可信、兜底**。
   - 💡 **只选不生成是常态，生成是降级兜底**；第 3/4 档运行时生成必经 HopLog 提报沉淀（渐进固化）。
   - ⚠️ 范围限当前 subtask children 内，交付契约（`+ →`）与 `[check final]` 不可变。
3. **预算耗尽 → fail**：上报 caller。
4. **逐层上报 → HITL**：调用链顶端的人类是终极决策。

### 完整性约束

重试/自适应改**策略**（怎么做），不改**目标**（做到什么），目标由两重机制守护：

- **`[check final]`**：`Constraints:` 的可执行化身，成功路径必经，adaptive 不可改写/跳过。验"质"。
- **Output schema**：`Outputs:` 声明不可降级，adaptive 重规划时验证新 children 覆盖所有 `+ →` 声明。验"全"。

普通 `[check]` 可被 adaptive 改写，`[check final]` 不可。

### HopLog（执行可观测性）

只追加、实时落盘的完整执行轨迹，给人和 agent 排查深层 bug 用。核心要求：实时性（禁事后补写）、完整性（输入/输出/LLM 交互/工具调用/失败原因全记）、可追溯（事件按时序、start/done/failed 配对）、安全审计（audit 事件不受日志级别限制）、分级控制（debug 全值 / info 记名不记值 / warn 只记异常）、resume 支持。落盘格式 **YAMLL**（只追加、块级独立、人机兼读）立为通用标准，任何 runtime 载体遵循同一套不变量（见 [[HopSpec V3扩展-可观测性与YAMLL日志格式]]）。

---

## 9. 验证规则表（23 条）

| # | 检查项 | 级别 |
|---|--------|------|
| 1 | 有 Steps 的 Spec 至少一个步骤；无 Steps 的 Spec 必须有 Goal + Outputs | 错误 |
| 2 | 步骤类型合法（15 种） | 错误 |
| 3 | step_id 全局唯一 | 错误 |
| 4 | 叶子类型不能有 children | 错误 |
| 4b | parallel 申报属实+无 Future：标注步骤与容器内其他步骤无变量依赖；标注步骤输出容器内不可消费；只可标 subtask/call | 错误 |
| 5 | goal 非空 | 错误 |
| 6 | 容器类型必须有 children | 错误 |
| 7 | branch 的 children 必须全部是 case | 错误 |
| 8 | case 只能出现在 branch 的 children 中 | 错误 |
| 9 | 有数据产出的容器必须声明 `+ →` 聚合输出；纯控制流容器可省略（隐含 none） | 错误 |
| 10 | exit 必须声明 `+ →` 交付物，变量须在 `Outputs:` 或前序步骤中已声明 | 错误 |
| 11 | retry、adaptive 仅适用于 subtask 和 case | 错误 |
| 12 | call 引用的 Id 必须存在 | 错误 |
| 13 | Inputs 声明的变量类型合法 | 错误 |
| 14 | 步骤输入（`← var`）必须来自前序步骤输出或 `Inputs:` 声明 | 错误 |
| 15 | 变量名全局唯一，不同数据不能同名 | 错误 |
| 16 | Outputs 声明的变量类型合法 | 错误 |
| 17 | `subtask retry/adaptive` 内不能包含 `[commit]`（除非有 `confirm` 兜底）；`call` 要求被调 spec 不含 `[commit]` 或已有 `confirm` 保护 | 错误 |
| 18 | `check` 必须出现在 `subtask` 或 `case` 容器内 | 错误 |
| 19 | `break`/`continue` 只能在 `loop` 容器内（任意嵌套深度）；带目标步骤号时目标必须存在且是自身的祖先循环 | 错误 |
| 20 | `[check final]` 必须在 `subtask` 容器内且位于 children 末尾 | 错误 |
| 21 | 声明的输出变量应有步骤产出——作用域内无任何步骤（含子孙）以 `+ →` 产出它时 warn | 警告 |
| 22 | `check` 步骤必须恰好声明两个输出：一个 `bool` + 一个 `text`（固定签名） | 错误 |
| 23 | doc-ref `[[文档路径#章节名]]` 引用的文件必须存在、章节可在该文件标题中匹配 | 错误 |

> 规则 23（P10）是**静态可达性**检查：只在作用域内完全无产出者时 warn，任一分支产出即不报。声明而不产出可能是合法 impl 情况（HopTrait、产出留给被 call 的子 spec、exit 运行时给、有序思考动态生成），故 warn 不阻断。

---

## 10. 完整示例（标准语法）

以标准语法书写的完整 Spec：

```
# Spec: 数据质量评估与修复
Goal: 评估输入数据集的质量问题，自动修复并生成质量报告

Inputs:
- raw_data: [DataRecord]  # 原始数据集
- quality_threshold: float  # 质量达标阈值

Outputs:
- clean_data: [DataRecord]  # 修复后数据
- quality_report: markdown  # 质量报告

Constraints:
- 修复后数据行数保留率 ≥ 90%
- 不可篡改原始业务字段含义

Types:
- DataRecord:  # 数据记录
  - id: line  # 记录标识
  - fields: yaml  # 业务字段
  - source: line  # 数据来源

## Steps
1. [act] 统计数据质量指标（缺失率、异常分布、跨字段一致性）
  - ← raw_data
  + → profile:  # 数据质量画像
    - missing_rates: [float]  # 各列缺失率
    - anomaly_count: int  # 异常记录数
    - issues: [line]  # 质量问题列表
2. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_strategy: text  # 修复策略
  > 权衡数据保留率与质量，选择合适的缺失值处理和异常值处理方案
3. [subtask retry=3 adaptive] 执行修复并验证质量达标
  + → clean_data
  3.1. [act] 按策略修复数据
    - ← raw_data, fix_strategy
    + → clean_data
  3.2. [check final] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
    - ← clean_data, quality_threshold
    + → quality_ok: bool  # 判定槽：是否达标
    + → quality_note: text # 说明槽：未达标时缺口（通过时不被查看）
4. [act] 生成质量报告（含修复前后对比）
  - ← profile, clean_data, raw_data
  + → quality_report
5. [exit] 交付修复数据和质量报告
  + → clean_data, quality_report
```

---

## 11. 变种语法：大纲语法

> 本节是**表层表述变种**，不改变任何语义——大纲语法与标准语法解析出的 AST 结构相同、语义等价（`^anc-surface-heading-flavor`）。标准语法（§1–§10）已是完整语法，本节只是给"人读审计"场景提供的另一种排版皮肤。

### 为什么有大纲语法

标准语法信息密度高、适合速览与机器往返，但人读长 spec 审计时有三个痛点：控制流不能折叠、大段编排说明无处安放、输入变量易忘义。**大纲语法**借 Markdown 标题的原生折叠解决这些——Obsidian 可收起 step 子树、outline 面板即 step 导航器（"大纲语法"之名即取自它把每个 step 变成文档大纲节点）。

| 维度 | 标准语法 | 大纲语法 |
|------|---------|---------|
| 定位 | 默认，serializer 输出的权威形式 | 人读审计变种 |
| 树结构编码 | 顶格 `N.M. [type]` 编号 | `#` 标题 + `N.M.` 编号 |
| 执行说明载体 | `>` 前缀 | 标题下自然段落（`>` 可省） |
| 折叠支持 | 无 | Markdown 原生折叠 |
| 适用场景 | 速览、机器往返 | 人读审计、大段编排说明 |

> **v1 工具支持**：解析器**双读**两种语法；序列化器（serializer）仍**只写**标准语法。大纲语法是手写/审计时的输入便利，反向"吐大纲语法"留待后续。

### 四条规则

1. **步骤编号加 `#` 前缀，逐级加一**：`## Steps` 用了 `##`，故顶层 `N.` 从 `###` 起；子步每深一层多一个 `#`（`N.N.`→`####`、`N.N.N.`→`#####`…）。深过 h6 继续加 `#`（Obsidian 不渲染第 7 级、失去那几层折叠粒度，但解析器认 step ID 数字、不认 `#` 个数，照常构树）。
2. **meta 紧贴标题、正文在后**：`- ←` / `+ →` 数据契约紧接步骤标题**下一行、不留空行**（契约先亮明）；随后空一行写自然段落正文（= 执行说明，替代标准语法的 `>` 前缀，`>` 可省）。`←/→` 与正文段落顺序不敏感（解析器各归各的桶），但约定 meta 在前、说明在后。
3. **`hop_python` 代码体直挂标题下**：act/commit 的 hop_python 代码块作标题下的独立 fenced code block（代码是代码，不被自然段落吸收）。
4. **`## Task` 契约分区（可选）**：可在 `Id:` 后、`## Steps` 前插一个 `## Task` 分组标题，把 Goal/Constraints/Types/Inputs/Outputs 归入"契约区"，与 `## Steps`"实现区"对称、各自可折叠。`## Task` 不是 section 关键字，解析器静默忽略、零解析影响，纯为 Obsidian 折叠分区服务。

### 单步骤对照

同一个 reason 步骤，两种写法：

**标准语法**：

```
2. [reason] 分析舆情风险
  - ← social_data, news_data
  + → risk_level: enum(low, medium, high)  # 风险等级
  > 综合各渠道数据，评估当前舆情风险等级和趋势
```

**大纲语法**（顶层步骤 → `###`）：

```
### 2. [reason] 分析舆情风险
- ← social_data, news_data
+ → risk_level: enum(low, medium, high)  # 风险等级

综合各渠道数据，评估当前舆情风险等级和趋势
```

### 完整示例（大纲语法）

与 §10 同一个 Spec（数据质量评估与修复），改用大纲语法书写——解析出的 AST 与 §10 完全相同：

````
# Spec: 数据质量评估与修复
Id: data-quality

## Task

Goal: 评估输入数据集的质量问题，自动修复并生成质量报告

Inputs:
- raw_data: [DataRecord]  # 原始数据集
- quality_threshold: float  # 质量达标阈值

Outputs:
- clean_data: [DataRecord]  # 修复后数据
- quality_report: markdown  # 质量报告

Constraints:
- 修复后数据行数保留率 ≥ 90%
- 不可篡改原始业务字段含义

Types:
- DataRecord:  # 数据记录
  - id: line  # 记录标识
  - fields: yaml  # 业务字段
  - source: line  # 数据来源

## Steps

### 1. [act] 统计数据质量指标（缺失率、异常分布、跨字段一致性）
- ← raw_data
+ → profile:  # 数据质量画像
  - missing_rates: [float]  # 各列缺失率
  - anomaly_count: int  # 异常记录数
  - issues: [line]  # 质量问题列表

### 2. [reason] 解读质量画像，制定修复策略
- ← profile
+ → fix_strategy: text  # 修复策略

权衡数据保留率与质量，选择合适的缺失值处理和异常值处理方案。
优先保留业务关键字段，缺失值处理不得改变字段语义。

### 3. [subtask retry=3 adaptive] 执行修复并验证质量达标
+ → clean_data

对修复策略容错重试：策略失效时可 adaptive 重规划子步骤，但
交付契约与 finally 验收门不可变。

#### 3.1. [act] 按策略修复数据
- ← raw_data, fix_strategy
+ → clean_data

```hop_python
clean_data = repair(data: raw_data, strategy: fix_strategy)
```

#### 3.2. [check final] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
- ← clean_data, quality_threshold
+ → quality_ok: bool  # 判定槽：是否达标
+ → quality_note: text # 说明槽：未达标时缺口（通过时不被查看）

### 4. [act] 生成质量报告（含修复前后对比）
- ← profile, clean_data, raw_data
+ → quality_report

### 5. [exit] 交付修复数据和质量报告
+ → clean_data, quality_report
````

> 注：上面外层用了四反引号 ```` ```` ```` 包裹，因为内部 3.1 的 hop_python 用了三反引号——大纲语法把 hop_python 顶格直挂，写进文档示例时外层围栏须比内层多一级，否则内层会提前闭合。这是**书写本参考文档**时的 markdown 转义细节，不是 HopSpec 语法要求。

## 12. 中文关键词对照（双语直通） ^anc-i18n-keywords-zh-table

> 全部语言关键词**中英恒等价、同时被认、零声明**（方案 B 直通,权威 [[HopSpec V3核心规范#^anc-i18n-keywords-bilingual]]）——spec 里 `## 目标` 与 `## Goal`、`[推理]` 与 `[reason]` 完全同义,可任意混写。AST/引擎/日志恒为英文规范形。**生成物语言可配置**（2026-09-03）：项目级 `hopjit.yaml` 写 `language: zh` 后,引擎序列化输出（树读回/hopbuild 生成物）缺省中文关键词;缺省或写 `en` 为英文。存量 spec 的关键词语言转换用 `hopjit lang <spec> --to zh|en`——先备份（同目录 `<原名>.bak.<时间戳>`）再原地改写,只动关键词不动变量名/说明/body,转换前后 validate 结果不一致时拒绝写回。**中英两表关键词都是保留字**,不得作变量名;变量名本身支持中文（Unicode 标识符,`风险等级: enum(高, 中, 低)` 合法）。

**段头与 Id 行**：

| 英文 | 中文 | 英文 | 中文 |
|---|---|---|---|
| `Id:` | `标识:` | `Outputs` | `输出` |
| `Goal` | `目标` | `Config` | `配置` |
| `Constraints` | `约束` | `Steps` | `步骤` |
| `Types` | `类型` | | |
| `Inputs` | `输入` | | |

**步骤类型**（`[循环]` ≡ `[loop]`）：

| 英文 | 中文 | 英文 | 中文 | 英文 | 中文 |
|---|---|---|---|---|---|
| reason | 推理 | commit | 提交 | loop | 循环 |
| act | 探索 | call | 调用 | break | 跳出循环 |
| check | 检查 | branch | 分支 | continue | 继续循环 |
| confirm | 确认 | case | 条件 | exit | 结束 |
| ask | 询问 | subtask | 子任务 | | |

**属性与子句**（`[子任务 重试=2 并行]` ≡ `[subtask retry=2 parallel]`）：

| 英文 | 中文 |
|---|---|
| `retry=N` | `重试=N` |
| `max=N` | `上限=N` |
| `adaptive` | `自适应` |
| `final` | `终检` |
| `free` | `开放` |
| `parallel` | `并行` |
| `require_human` | `必须真人确认` |
| `for-each X in L` | `遍历 X 于 L` |
| `collect U into O` | `收集 U 入 O` |
| `[case(else)]` 统配 | `[条件(其他)]` |
| `- tools:` 工具授权行 | `- 工具:` |
| `- deny_tools:` 工具禁用行 | `- 禁工具:` |

**不翻的面**：类型名（`line`/`text`/`bool`/…——短英文即术语）、hop_python 内置函数（`len`/`strip` 等,对齐 Python）、`Null` 特殊值（已有三写宽容）。报错文案回显你写的字面（写 `[思考]` 报 `Unknown step type: 思考`,不显归一名）。

全中文最小示例：

```markdown
# Spec: 客户检查
标识: kehu-check
## 目标
逐个检查客户并收集预警
## 输入
- 客户列表: [line]  # 全部客户
## 输出
- 预警名单: [line]  # 收集结果
## 步骤
1. [循环 遍历 客户 于 客户列表, 收集 预警 入 预警名单] 逐个检查
  + → 预警名单: [line]  # 收集端
  1.1. [推理] 判断该客户是否需预警
    - ← 客户
    + → 预警: line  # 单项判定
2. [结束] 交付
```

---

> **引用**
> - [[HopSpec V3核心规范]] §HopSpec规约结构 / §步骤类型 / §执行模型 / §验证规则 — 全部语法与执行语义的权威定义
> - [[HopSpec V3核心规范]] §表层表述变种：内联紧凑风 / 标题风（`^anc-surface-heading-flavor`）— 大纲语法变种的原始定义（源文档中称"内联紧凑风 / 标题风"，本文改称"标准语法 / 大纲语法"）
> - [[HopSpec-prompt-author]] — Spec 作者构建速查卡（本文的精简姊妹版）
> - [[../design/i18n#^anc-i18n-glossary]] — 中文术语表权威（§12 是其作者可读视图;两处冲突以术语表为准）
> - [[HopSpec V3扩展-有序思考与渐进固化]] — HopTrait（无 Steps 的 Spec）的探索验证闭环
> - [[HopSpec V3扩展-可观测性与YAMLL日志格式]] — HopLog / YAMLL 格式不变量
