%% @trace
	id: hopjit-spec-parser
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-09T09:11+0800
	note: SpecParser 组件定义 + impl Specs。内容分级（决策/契约/说明）+ 54 条验证规则契约锚点 + 输入防护与类型校验决策
%%

# struct: SpecParser

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、覆盖统计、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（四要素） | 契约 | `anc-struct-spec-parser` |
| 关键决策 | 决策 | — |
| impl parse_spec | 契约 | — |
| Tools 段解析 | 契约 | `anc-rule-tools-section` |
| 相关类型 / 输入防护 | 契约 | — |
| 验证规则·结构（S1-S16） | 契约 | `anc-rule-s1` … `anc-rule-s16` |
| 验证规则·控制流（C1-C8） | 契约 | `anc-rule-c1` … `anc-rule-c8` |
| 验证规则·变量（V1-V9） | 契约 | `anc-rule-v1` … `anc-rule-v9` |
| 验证规则·特殊步骤（P1-P14） | 契约 | `anc-rule-p1` … `anc-rule-p11` |
| 验证规则·集合锚点 | 契约 | `anc-rule-all` / `anc-rule-v3-all` |
| 规则覆盖说明 | 说明 | — |

## 定位【契约】 ^anc-struct-spec-parser

> **模块版本**：spec-parser `v0.38.0`（2026-09-16）。本版=新增 V14 Tools 段声明-授权对账 warn（D94 批作者拍"validate 应该加验证"——声明零消费=工具静默不可见空转,最难发现的失效形态写时点名;授权行/body 直调/通配三消费形态全认,warn 档理由与反向不查论证入条款）。上版（v0.37.0）=B2 内置工具具名参数名核对升档 error（作者拍,决策页 todo/decision/20260916-内置工具参数名写时校验.md——move(src:/dst:) 笔误五层防线全漏烧真机一轮;本地签名表与 tools.ts input_schema 同源,对账钉扩参数名级;未知参数名/缺必填/位置参数三判,报文带合法参数名集指路）。上版（v0.36.1）=R10 review 修复批（B2 三档枚举改 act/check〔reason 空指〕/fragment 模式 commit 档降 warn〔replan 误杀〕/checkActExpr 四处递归透传补漏/通知件名单纠源+对账钉/放行论据分模式如实化）。上版（v0.36.0）=B2 commit 步未知函数升档 error（hopissues/0089——不可逆步 body 野函数名静默走 tool_request 外包致 completed 谎报,三批连撞;Tools 段声明过的保持 warn）。上版（v0.35.1）=0086 语义审计修复批（doc-ref 注入点下沉回写 engine.assembleBasicContext+提取期去重条款+出口表死锚名改指 anc-i18n-language-config）。上版（v0.35.0）=P10 第三档补严修复批（工程链review 四面并行+变异 7 处 3 存活后:第四规则容器自声明不短路/on_fail 兜底块除外/exit_outputs 死分支两处删/存在性两档限定语/warn 字面统一/规则计数句去数字改指权威）。上版（v0.34.2）=输入防护条款升 1MB+报文带实际字节数(hopissues/0080)并补设计锚 ^anc-rule-input-guard(review 抓 0080 批 @a:/@v: 挂了现场发明的非法锚 anc-parse-spec——parse 类别不在合法表,改挂本锚归 rule 族)。本版三名单同源补账（review 变异实锤名单成员级零保护后）：B9 补 edit_file（写侧七件）/B10 补 search_file（读侧四件）——两批扩员各漏刷姊妹条;B2 措辞'树编辑件'改'spec 内容族六件'与 file-tools 权威归类对齐;三名单同源一致性立对账钉机检。上版（v0.34.0）新增 **call callee 位插值收取**（概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-call]] 插值条款,作者三拍 2026-09-05"run_spec 这个不就是call么"/"{}主语义就是fstring,直接用{analyzer_spec}"——动态派发归 call 晚绑定不另造工具,todo/0066）：`[call {表达式}(映射)]` 形态——花括号平衡扫描切出表达式串,经 parseExpression（f-string 同一解析器,能力面全集不另开子集）解析成 ActExpr 存 `CallStep.callee_expr`（与 callee_spec_id 互斥恰一）;表达式非法=写时 error（报文教形态）;**两处 call 正则同改**（预判处与主提取处——收链实抓单改必漏）;三形态归一处与属性放行表随扩。静态检两件：P1 扩为"callee_spec_id 与 callee_expr 至少其一";新 V13——callee_expr 根变量必须由前序步骤产出或来自 Inputs（V1 同族核,断供=写时红）。S12/S16/P8 零改动（判定材料不含 callee 字段,收链实证）。serializer 插值形态原样往返。执行侧解引用契约归 [[step-dispatcher#^anc-step-call-dynamic-callee]]。上版（v0.33.1）**括号组容空格三位一致**（^anc-rule-v7-header-types ④,作者拍"validate 修"——0069 两路语料独立撞 enum(high, low) Types 字段位炸而 Inputs 位合法:Types 字段分词改先收标识符再整收括号组,normalizeTypeToken 剥逗号周边空白归一 AST 规范形,line( 非空 ) 毒形态照拒钉不动〔拒点移残余空白核,消息不变〕）。前版（v0.33.0）新增**节点体工具禁用条目**（概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-deny]],作者拍"是不是可以在指定节点禁止 write tool" 2026-09-05,与 edit_file 工具同批——0038b 实测修错步 write 全文回写 17 万 tokens 的封堵半边）:`- 禁工具: 名  # 为什么禁`（`- deny_tools:` 同义）——parser 收进 `ActStep.tool_denies: {name, note?}[]`（ReasonStep 同形并排）;文法钉与授权行同族但两处有意不同:**禁 `*`**（全量禁=零工具面,真要如此逐件列名——防手滑废掉整个工具面;授权 `*` 有正当场景,禁用没有）/**同名既授又禁当场拒**（checkAttrGate 比对 tool_grants×tool_denies 交集,冲突=笔误或想不清,写时红点名工具名,不做运行期静默偏一边）;每行恰一名(逗号拒)/空名拒/仅 act/reason 步收——三钉与授权行逐字同族。`禁工具|deny_tools` 入关键词保留字族;lang 转换通道两处随扩（关键词映射表+条目行转换正则）。收取块与授权行同位纪律（先于 RE_LIST_ITEM 族判,防被复合展开条目收编）。上版（v0.32.1）出口表补登 convertSpecKeywords（language 批漏登,review 审计账面清缴实拦）。上版头部类型校验补位（todo/0064——V7 扩面 Outputs 节与 Types 字段位+字段行整串核,^anc-rule-v7-header-types）。上版新增**类型位约束标注** `line(非空)`/`line(nonempty)`（概念权威 [[../concepts/HopSpec V3核心规范#^anc-type-constraint-annotation]],作者拍 B 案）:parser 归一站 normalizeTypeToken（收取点详见 ^anc-type-constraint-annotation 条款——七站全接,演进论证归 git log）;V4/V7 类型合法性精确认 line(nonempty)（不开 line(任意参)）;值核归 checkValue（空串/全空白 mismatch,报文教答不出走失败通道）;coerce 折叠归一同罩（约束只管空判,折叠语义与裸 line 一致）;serialize 原样往返。上版补装 V10 子条①（collect unitVar 产出方核验,todo/0051）并按文法现实删除②尾句空转核验。上版新增 B10（body 读侧字面绝对路径静态检,deep-validate 批——九坑之坑 6 读侧半边,B9 同形姊妹条）。上版新增 V12（call 映射禁点路径,dr21 十六撞立规）与 B9（act/check body 写域静态检,dr21 双撞立规）两规则。上版新增**节点体工具授权条目**（0054,概念权威 ^anc-step-tool-grant）:`- 工具: 名  # 意图`（`- tools:` 同义,`*` 全量）——parser 收进 `ActStep.tool_grants: {name, note?}[]`;文法钉:每行恰一名(逗号多名拒指路每行一个)/`*` 与具名互斥/仅 act 步收(其余类型此行报错指路)/`工具|tools` 入关键词保留字族(变量名禁用)。0.x 未承诺稳定。本版含 **number 类型除名**（作者定"和python一致":数字类型只有 int/float;number 曾在 BUILTIN_TYPES 事实流通但概念层原子类型表无户口,除名后拒收报文经类型清单自然指路,number 仍占保留字位防旧写法 `x: number` 静默变身变量引用;examples/教程/测试 fixture 全量随改,概念层原子类型表后追明文）。含 parser+validator 两 src 文件；HopSpec markdown 语法 + 54 条验证规则是稳定契约,改语法/加破坏性规则或既有规则改档升严须经决策交代（概念层或实撞驱动的作者拍板,账面可溯）。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
**① 自身定位**：SpecParser 是 HopSpec markdown 与 SpecAST 之间的双向桥——把 HopSpec v3 markdown 解析为结构化 AST（`parse_spec`），反向把 AST 序列化回 markdown（`serialize_spec`），并对 AST 执行 **54 条验证规则**（`validate_spec`）。它是把"人/agent 写的文本规约"变成"引擎可执行的数据结构"的入口关卡，54 条规则是放行前的质量闸门。

**② 与其他 HopType 的关系**：
- **给 ExecutionEngine 输出 SpecAST**——Engine 只接受已解析、已校验通过的 AST，不直接碰 markdown。解析失败或存在 `error` 级违规时不放行执行
- **纯无状态代码组件**（`Fields: （无）`）——不持有运行态、不落盘、不走 PersistenceProvider 抽象。同一份 markdown 解析结果确定且可重复，无副作用
- **依赖 [[shared-types]] 与 [[spec-ast]]**——SpecError（ParseError / ValidationError）、StepType（15 种）、ValueType（9 种）等类型定义在外部，本组件只消费

**②b 对外接口清单【封闭】** ^anc-struct-spec-parser-exports：

> 本表是 spec-parser 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `parser.ts` / `validator.ts`（双出口，validator 是独立对外面）。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `parseSpec` | 函数 | parser.ts | markdown → SpecAST（engine/cli init 调） | stable |
| `parseFragment` | 函数 | parser.ts | 裸步骤片段 → SpecAST（cli validate --fragment 与 tools validate_spec 调——hopbuild 单轮核查,见 ^anc-rule-fragment-mode） | provisional |
| `flattenFragmentNumbering` | 函数 | parser.ts | 片段编号归一（parse 前预处理——LLM 沿用原步骤号的自然形态〔replace 1.1 就写 1.1.〕规整为顶层连号,子行前缀整树随父改写,幂等;replan 提交两入口共用:standalone dispatcher 管线+复用模式 CLI --replan——两模式同一提交语义同一宽容度,见 [[step-dispatcher#^anc-exec-adaptive-pipeline]] 归一附则,0030/P2-2 对齐裁定 A） | provisional |
| `FragmentOptions` | 类型 | validator.ts | validateSpec 片段模式第三参（cli/tools 消费,见 ^anc-rule-fragment-mode） | provisional |
| `validateSpec` | 函数 | validator.ts | 54 条规则校验（engine/cli 放行前闸门） | stable |
| `validateOutputValues` | 函数 | validator.ts | 输出值级 schema 校验（engine completeStep 调） | stable |
| `formatSchemaMismatch` | 函数 | validator.ts | 组装 SCHEMA_MISMATCH 反馈文本（engine 调;+typeDecls 可选参——失配涉自定义 TypeDecl 时附字段级定义行闭包,0017 反馈半边） | provisional |
| `coerceOutputValues` | 函数 | validator.ts | 输出边界归一转换（int/bool/line/yaml 四族;+typeDecls 第三参——[T] 元素/TypeDecl 字段与校验同判据面递归归一;engine completeStep 校验后调,init 入口同规） | stable |
| `recoverOutputValues` | 函数 | validator.ts | 围栏输出恢复阶梯（剥围栏→YAML 解析→单键嵌套剥层,解出真值才采用——engine completeStep 校验前调,BUG-C 修;契约 [[exec-engine#^anc-exec-output-fence-recovery]]） | stable |
| `repairQuotedPrefixScalars` | 函数 | validator.ts | 值内前置引号片段的标量修复（`键: "片段"接裸文` 非法 YAML 行重包成合法带引号标量——恢复阶梯②档与 dispatcher 多输出两处 yamlLoad 失败后的修复重试共用;契约 [[step-dispatcher#^anc-exec-output-quoted-prefix-repair]]） | stable |
| `normalizeOutputsToFixpoint` | 函数 | validator.ts | 不动点归一（循环 recover+coerce 至值稳定——嵌套组合壳〔JSON 包 YAML 串/围栏包 JSON/多层同键〕单趟接力必漏,coffee3 实撞;engine completeStep 与 subtask 收割两站点调;契约 [[exec-engine#^anc-exec-output-fence-recovery]] 不动点条款） | stable |
| `recoverFencedValue` | 函数 | validator.ts | 围栏值恢复原语（无声明档——call 边界输出映射逐值剥壳,engine mapCallOutputs 调;BUG-D 修,同契约） | stable |
| `serializeSpec` | 函数 | parser.ts | AST→markdown（engine L2e 引用检测的 rawSource 降级源——load 恢复实例无原文,子串检测是合法用途,禁的是重建;见 [[prompt-assembler#^anc-exec-hop-env-table]]） | provisional |
| `serializeFragment` | 函数 | parser.ts | 步骤树→裸片段文本（无头无节标题,parseFragment 对称逆——tools 树编辑四件 spec_is_fragment 模式调,见 [[tools/spec-tree-tools#^anc-exec-builtin-edit-tree-tool]]） | provisional |
| `convertSpecKeywords` | 函数 | parser.ts | 关键词语言转换行级手术（hopjit lang 命令消费,[[i18n#^anc-i18n-language-config]]——2026-09-04 review 抓 language 批漏登出口表补） | provisional |

> **内部（表外即内部）**：各规则的私有校验函数（walkVariableScope 等）、正则常量。

**③ 主要 traits 与主要成员**：

```
struct: SpecParser
  Id: spec-parser
  Fields: （无）
  Specs:
    - parse_spec       # markdown → SpecAST
    - serialize_spec   # SpecAST → markdown
    - validate_spec    # SpecAST → [ValidationError]
```

- `parse_spec(markdown) → (ast, errors)`——生产主路径。前置输入防护（大小/深度上限）→ 提取头部 → 解析 Steps 树 → 构建 AST。这是引擎拿到 Spec 的唯一来源
- `serialize_spec(ast) → markdown`——反向回写，用于工具链展示/导出。**不保证 parse→serialize→parse 往返字节一致**（见关键决策）
- `validate_spec(ast) → [ValidationError]`——对 AST 执行 54 条规则，输出带 `rule` 编号和严重程度（error/warn/info）的违规列表。error 阻塞执行，warn 建议修复，info 提示性

**④ 核心 impl 的主要逻辑**：
```
# impl parse_spec（markdown → AST）
1. [act] 输入防护：大小 ≤ 1MB、嵌套深度 ≤ 64 层，超限返回 ParseError（报文带实际字节数）
2. [act] 提取头部区域（title/Id/Goal/Constraints/Types/Inputs/Outputs）
3. [act] 按 step_id 数字编码解析 Steps 树，逐节点解析摘要行 + 节点体（← → >）
4. [act] 构建 SpecAST 并校验基本结构
5. [exit] 交付 ast + errors（errors 空 = 解析成功）
```

**实现**：TypeScript（代码侧），文件 `src/parser.ts`（解析/序列化）+ `src/validator.ts`（54 条规则）。

---

## 关键决策【决策】

以下是 spec-parser 上不可从概念推演、由作者拍板的关键选择：

1. **输入防护上限** ^anc-rule-input-guard：解析前强制 **输入大小 ≤ 1MB**（`MAX_INPUT_SIZE = 1024 * 1024`——2026-09-09 随 hopissues/0080 从 100KB 上调:报告方 100,558 字节真实业务 spec 被拒、被迫压缩到 99,776 字节牺牲可读性,100KB 已被业务尺寸触顶,违背本条'只做异常输入防护不是业务约束'的自身定位;1MB 对手写逐行解析器零压力且彻底脱离业务尺寸区;超限报文带实际字节数——只报阈值不报实况,用户不知道差多少）+ **步骤嵌套深度 ≤ 64 层**（`MAX_NESTING_DEPTH = 64`），超限直接返回 ParseError。理由：防 ReDoS 和解析器资源耗尽——上限只做异常输入防护，**不是业务约束**（2026-08-17 作者判定修正：原 10 层把输入防护当成了业务上限，合法规约的条件密度轻易触顶——每重条件 branch+case 吃 2 层，10 层≈4 重条件；call 链深度的 10 层资源限制是另一个正交的闸，见 [[exec-engine#^anc-exec-call-depth-check]]）。解析器为手写 line-by-line 实现，不解析 HTML 块和自动链接（减少攻击面）。

2. **规则的 error/warn 二分**：每条验证规则预先归类为 `error`（阻塞执行，引擎拒绝放行）或 `warn`（不阻塞，仅提示应修复）。二分原则——**会导致执行语义错误或不可达的违规判 error**（如步骤 ID 非法、变量引用悬空、类型无效、控制流结构破损）；**只影响可读性/健壮性、不破坏执行正确性的判 warn**（如 commit 缺 approval 声明、loop 缺显式终止路径、retry 计数建议）。具体每条归类见各规则锚点。

3. **V4 严格类型校验**：输出类型校验走 `isValidTypeWithDecls`——类型必须是 9 种 ValueType 之一**或**已在 Types 段声明的 TypeDecl，**未声明类型一律拒绝**（判 error），不做宽松/模糊匹配。理由：类型是变量契约的基础，宽松匹配会让拼写错误的类型名静默通过，把错误推迟到运行时。

4. **serialize_spec 单向不保证往返一致**：`serialize_spec` 仅用于工具链展示/导出，**不保证 `parse → serialize → parse` 字节级或结构级往返一致**。理由：生产路径是单向的 markdown → AST（人/agent 写 markdown，引擎读 AST），序列化只是辅助；为往返一致性付出的格式保真成本不值得，且会约束 markdown 书写自由度。

---

## impl parse_spec【契约】

```
# Spec: 解析 HopSpec markdown
Id: parse_spec
Goal: 将 HopSpec v3 markdown 文件解析为结构化 AST

Inputs:
- markdown: text  # HopSpec markdown 原文

Outputs:
- ast: yaml       # SpecAST 结构
- errors: [line]  # 解析错误（空 = 成功）

Constraints:
- 严格遵循 HopSpec v3 语法规范
- 支持 15 种步骤类型（含 on_fail 失败兜底,2026-08-21）
- 支持有 Steps 和无 Steps 两种形态

## Steps
1. [act] 提取头部区域（Spec 标题、Id、Goal、Constraints、Types、Inputs、Outputs）
  - ← markdown
  + → header: yaml  # 头部字段集合
2. [act] 解析 Steps 树（如有）
  - ← markdown
  + → steps: yaml  # 步骤树结构（step_id 编码层级）
  > 按 step ID 编码树结构，解析每个节点的摘要行 + 节点体（← → >）
3. [act] 构建 SpecAST 并校验基本结构
  - ← header, steps
  + → ast, errors
4. [exit] 交付 AST
  + → ast, errors
```

---

## 相关类型 / 输入防护【契约】

SpecError（ParseError / ValidationError）和 InitResponse 定义于 [[shared-types]]。

**Tools 段解析**（概念权威=[[../concepts/HopSpec V3核心规范#^anc-tool-two-faces]] spec 需求声明半边,2026-08-25 作者定;任务 #49） ^anc-rule-tools-section：

- **段头识别**：`Tools:`/`工具:` 入 SECTION_KEYWORDS（kind: 'tools'——独立段,不再被静默吞进相邻 section;interim 拦截随本实装退役）;
- **条目文法**（HopSchema 条目式,与 Inputs 同款分项心智）：
  - 签名行 `- <tool>(<param>, …) -> <out>: <type>  # 用途说明`——tool=工具名（合法标识符或注册面 tool_id）,括号列参数名（与参数子条目按名对应）,`->` 后输出名: 类型（单输出;多输出场景走 output 名对象,v1 只做单输出——实测工具响应主形态）;
  - 参数子条目 `  - <param>: <type>  # 逐参数说明`——类型词汇=HopSpec 原子+`[原子]`（与 output_schema 同表）;说明入结构（ToolNeed.params[].description）;
  - `  > 扩展说明` 可选多行——收进 ToolNeed.notes;
- **AST 落点**：`header.tools?: ToolNeed[]`——`{ name, params: [{name,type,description}], output: {name,type}, description, notes? }`;
- **校验规则（T 组新设,随 #49 实装批定编号;review D7 修 2026-08-25）**：签名行括号参数与子条目按名一致（多/漏/错名 error）;同名工具重复声明报错;**不合文法行响亮报错带真实行号**——签名行/参数条目不匹配文法即 parse error（报文含该行原文与正确形态,行号=1-based 真实行,不恒报段头行;原实现静默跳过=作者以为声明了实际没进 AST 的假绿窗口）。类型词汇表核**归对账不归 parser**（reconcileTools 四判之一,见 [[exec-engine#^anc-exec-tools-reconcile]]——parser 只收结构,词表是语义校验）;
- **消费面**：①引擎 init 对账（exec-engine——环境注册面缺工具/参数名集合不兼容/requires_commit 冲突 → INIT_FAILED 带明细）;②prompt L1 契约随附工具语义（执行 LLM 逐参数拿语义）;③call 工具决议的静态核对照物。

**初值字面量解析**（`= 初值` 位,概念权威=[[../concepts/HopSpec V3语法参考]] §初值语法——2026-08-17 hopissues/hoplogic3/0002 扩）：`Null/None/null`→空值;`{`/`[` 开头**按 JSON 解析**（合法得真对象/列表——hopkb 批量壳 tally 实撞:原实现只认空 `{}`/`[]`,非空对象跌裸文本分支静默存串,运行期 `x["k"]` 炸"非对象取下标"离病灶隔一层;**坏 JSON 当场 parse error 报文含错因与改法**——静默存串是"两头都不占":既没支持又没拒绝）;`true/false`/数字/带引号串/裸文本沿既有。 ^anc-rule-init-value

**输入防护**（决策依据见上文关键决策 1）：`parse_spec` 在解析前执行以下前置检查，防止 ReDoS 和解析器资源耗尽：
- 输入大小上限：1MB（`MAX_INPUT_SIZE`，超出返回 ParseError 带实际字节数）
- 步骤嵌套深度上限：64 层（`MAX_NESTING_DEPTH`，超出返回 ParseError——异常输入防护量级，非业务约束；call 链深度 10 层是正交的另一闸）
- 手写 line-by-line 解析器：不解析 HTML 块和自动链接（减少攻击面）

---

## doc-ref 引用提取【契约】 ^anc-rule-doc-ref-extract

parser 在构建 AST 时（`flatToStepNode` 阶段及头部 `Constraints:` 处理），从文本中提取 Obsidian 风格的 doc-ref `[[文档路径#章节名]]` 引用，存入 AST：

- **来源**：步骤 `instruction`（join 后的 `>` 指令文本）→ `BaseStep.doc_refs?: DocRef[]`；spec 级 `Constraints:`（join 后）→ `SpecHeader.doc_refs?: DocRef[]`。对齐 `@knowledge` 的 spec/step 二分作用域。
- **正则**：`RE_DOC_REF = /\[\[([^\]#|]+)#([^\]|]+?)(?:\|[^\]]+)?\]\]/g` —— 捕获组 1 = 文档路径，捕获组 2 = 章节名；`(?:\|[^\]]+)?` 吞掉 Obsidian 的 `|别名` 后缀（别名仅给人看，引擎忽略）。
- **排除 `#^` 锚点引用**：章节名首字符为 `^` 时**跳过**——`[[doc#^anc-xxx]]` 是段落锚点反链（引擎源码注释里已大量使用），不是 doc-ref 的章节引用，误匹配会污染。
- **强制要求 `#`**：正则不匹配无 `#` 的纯 `[[doc]]`（整文档引用本期不支持，见概念 [[../concepts/HopSpec V3核心规范#^anc-exec-doc-ref]]）。
- **解析时不读文件**：parser 只做字符串→AST 提取，无 I/O（保持 parser 纯函数定位）。文件存在性与章节可匹配性由 **P15**（[[#^anc-rule-p15]]）在 validate 阶段校验，章节内容由 **engine 在运行期注入**（`engine.assembleBasicContext` 调 `resolveDocRefs`，src/engine.ts:3418——解析已从 dispatcher 下沉引擎侧，沿革与理由见 [[doc-ref#^anc-exec-doc-ref-resolve]]）。
- **提取期去重**：`extractDocRefs` 对同一 `(doc, section)` 组合只收一条（按 `doc + section` 键去重，src/doc-ref.ts:26）——同一文本里重复写同一引用不产生重复 AST 条目。
- `DocRef = { doc: string; section: string }` 定义于 [[shared-types]]。

---

## @src 源锚点提取与写回【契约】 ^anc-step-src-annotation

`@src <锚ID>` 步骤级源锚点（概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-src-annotation]]——纯追溯元数据零执行语义）双向实装归本模块：**提取**——parser 从 `>` 指令区剥出（SRC_RE,@model 同通道）存 `BaseStep.src_ref`,剥出即不进 instruction=不进执行 prompt;**写回**——serializer 在 instruction 前输出 `> @src ...`（与 @model 同批写回——两标注是语义子句,丢失后 re-parse 锚点/路由漂移）;往返二次稳定。validate 对 src_ref 零判定（消费方=hopbuild 对账工具链,引擎只运载）。

## 表层表述变种解析（标题风）【契约】 ^anc-rule-surface-heading-flavor

概念见 [[../concepts/HopSpec V3核心规范#^anc-surface-heading-flavor]]。step ID 是唯一树结构权威，表层排版对机器无意义——parser **双读**两种表层风味（内联紧凑风 + 标题风），解析出结构相同的 AST。五条解析规则：

- **步骤行 `#` 前缀剥离**：`parseStepSection` 匹配 `RE_STEP` 前，先对 `trimmed` 剥去行首标题前缀——`stepBody = trimmed.replace(/^#+\s+/, '')`，再 `stepBody.match(RE_STEP)`。剥掉过前缀（`stepBody !== trimmed`）的步骤标记为 **heading-flavor**（`current.headingFlavor = true`，`FlatStep` 内部字段，不入 AST）。`#` 个数不参与树构建（树仍由 step ID 数字编码），故深过 h6 的 `#######` 照常解析。内联风步骤无前缀、`stepBody === trimmed`，走原路径不变。
- **heading-flavor 段落吸收进 instruction**：`parseStepSection` 节点体扫描的末尾兜底分支——当 `current.headingFlavor` 且当前行非 marker（非 `- ←`/`+ →`/fence/`%%`/staleForEach/`>`）时，纯文本行 `current.instruction.push(trimmed)`（标题下自然段落 = 执行说明，等价内联风 `>` 指令）。**内联风保持现状**：非 heading-flavor 步骤的未知行**静默丢弃**（零回归）。marker 分支顺序不变、纯文本兜底置于最末。
- **heading-flavor 裸 `hop_python` fence 捕获（含 de-indent）**：内联风 act body 是 `> ```hop_python`（行首 `>`，不触发顶部裸 fence-skip），流入 instruction 后由 `extractHopPythonFence` 提取；**标题风 act body 是裸 fence**（` ```hop_python ` 直挂标题下，行首即反引号），会命中 `parseStepSection` 顶部的 `RE_FENCE` skip 而被整段丢弃——必须拦截。规则：`current.headingFlavor` 时，裸 fence 的开/闭行与 body 行**捕获进 `current.instruction`**（开行归一为 ` ```hop_python `/闭行 ` ``` `，body 行按**开栏行的行首缩进量 de-indent**——`line.slice(fenceIndent)`）。de-indent 必要因 act body 缩进敏感（`tokenize` 按行首空格算 INDENT/DEDENT），裸 fence 常整体缩进（Obsidian 代码块观感），不 de-indent 则 body 首行凭空多一层 INDENT 触发 `期望缩进块` 之类误判；内联风的 `> ` 前缀剥离天然完成等效 de-indent。捕获后 body 经既有 `extractHopPythonFence` → `parseActBody` 路径提取，与内联风归一。**非 heading-flavor 裸 fence 维持原状**（skip 丢弃，零回归）。
- **复合输出 YAML 展开解析**（2026-08-09 通读实测补——概念 `^anc-type-system`"复合类型用 YAML 展开"明文承诺，parser 原样把 `+ → profile:  # 说明` 解析成名为 `"profile:"` 的变量（冒号未剥、无类型），下游 `← profile` 全 V1 未定义，概念示例集体过不了校验）：输出行以冒号结尾（`name:` 后无类型 token，仅可选 `#` 注释）= 复合类型声明头——变量名剥冒号，type 记 `yaml`（复合结构的运行值形态），description 取 `#` 注释；随后的缩进子行（`- field: type  # 说明` 形态，缩进深于输出行）是该复合类型的**字段说明**，供人读与 LLM 输出约束（L6 渲染），不注册为独立变量。子行捕获进 `OutputDecl.fields`（新增可选字段，形状 `{name, type, description}[]`），不入变量流图。
- **步骤编号尾点可选**（2026-08-18 buildtest 实撞,静默吞家族——LLM 写 `1.1 [reason] …` 缺尾点,步骤行被当普通文本静默丢弃 → 父容器 S5"无子步",报错指向缩进完全错位,重试打转）：`RE_STEP` 与 case/call 特判前缀的编号后接法改为 `(?:\.\s*|\s+)`——带点（后空格可选,兼容既有粘连形 `1.[reason]`）或无点必空格（新收 `1.1 [reason]`;粘连无点 `1[reason]` 不收,数字-类型无分隔歧义面大）——两形同 AST。表层意图无歧义（数字编号+类型标记就是步骤行）,step ID 是唯一树结构权威,尾点是排版糖——与标题风双读同一原则。序列化仍只写规范形（带尾点）。**误伤面核过**：普通散文行以 `N.N [word]` 开头的形态不存在于全库语料;`- ←`/`+ →`/`>` marker 行不以数字开头不涉。**字母后缀伪步骤行响亮拒**（2026-08-19 三十审实撞,同族最痛一例：`5.2b. [act] …` 编号不合 RE_STEP,整步连同 ←/→/body 被静默吸进前一步——body 挂错宿主,前一步〔植锚 LLM 工具活〕被引擎当纯计算 body 直执,真正的活整个跳过且 validate 全绿;修=步骤形态行〔数字开头+[类型] 标记〕而编号不合文法 → parse error 指路『步骤号只许数字与点』,绝不静默并入前一步）。 ^anc-rule-step-number-dot-optional
- **未闭合围栏响亮拒**（2026-08-26 P1/P2 处置批复审抓,静默吞家族——LLM 截断产物/装饰性 ``` 是现实形态：裸围栏只开不闭时,fence-skip 把其后**全部步骤行静默吞掉**,AST 只剩前半且 errors 为空——步骤蒸发比拒收糟〔拒收有账〕比错值糟〔错值下游能炸出〕;实验:未闭围栏后的 `2. [act]` 无声消失,唯一兜底是 submitReplan 完备性闸恰好红,输出被前面步骤覆盖时直接静默通过）：**步骤扫描层（parseStepSection）扫描结束仍 inFence → parse error**『围栏未闭合（```开于第 N 行）——检查产物是否被截断』,行号=开栏行;节识别层（identifySections）同判。flattenFragmentNumbering 的围栏跟踪不加错误面（纯文本预处理不产 error,归一后交 parse 报）——三层同语义单点报错,不三处各报。 ^anc-rule-unclosed-fence
- **输入 `#` 就近注释剥离**：`parseInputExpr` 逗号切分前先剥行尾 `# 注释`——`const hashIdx = text.indexOf('#'); const body = hashIdx >= 0 ? text.slice(0, hashIdx) : text;`，对 `body` split。手法对齐 `parseOutputExpr` 的 hashIdx（[[#^anc-rule-doc-ref-extract]] 邻近的输出注释剥离）。概念侧输入 `#` 为**建议非强制**（见概念 node-body 表），validator 不加 warn。
- **meta-first 顺序不敏感（无需改代码，行为固有）**：概念标题风约定 `- ←`/`+ →` 紧贴标题、正文段落在后。这对 parser **本就零影响**——`parseStepSection` 节点体扫描逐行分派到独立累积桶（`inputs` / `outputs` / `instruction`），marker 行与段落行的**先后顺序不改变各桶内容**，故 meta-first（契约在前、说明在后）与内联风的 meta-last 解析出**相同 AST**。测试锁定此等价（见 `tests/parser.test.ts` 标题风 AST 等价用例），防未来重构误引入顺序依赖。
- **`## Task` 契约分区静默忽略（无需改代码，行为固有）**：标题风可在 `Id:` 后插 `## Task` 分组标题（归拢 Goal/Inputs/Outputs 等契约区，供 Obsidian 折叠）。`identifySections` 只认 `SECTION_KEYWORDS` 表内的 depth-2 关键字（goal/constraints/types/inputs/outputs/config/steps），`## Task` 不在表内 → 不产生 section、被**静默忽略**，对 header 与 steps 解析零影响。这是**有意支持的分区惯例**，非漏网 bug——勿在"未知 `##` 标题"上加报错/警告（会破坏此惯例）。测试锁定 `## Task` 存在时 header 仍正确解析。

**v1 只读偏差**：`serialize_spec` 仍只写内联紧凑风（`>` 在内联风保留，否则序列化无载体写指令），**不**输出标题风。理由同关键决策 4（序列化单向、不保证往返格式一致）——标题风是手写/审计输入便利，反向"吐标题风"留待后续。故 `parse(标题风) → serialize → 内联风` 是预期行为，AST 语义等价即可（round-trip 断言在 AST 层，非文本层）。

---

### 声明区文法警告【契约】 ^anc-rule-decl-zone-warn

概念权威 [[../concepts/HopSpec V3语法参考#^anc-rule-decl-zone-warn]]（2026-08-30 作者定,todo/0016 全角冒号一刀——宽容面定点收紧:声明区里写错的行不再无声蒸发,"变量未定义在三十行外的消费步爆而病灶在声明行"的远端症状消除）。

**能力契约（HopTrait）**：
- 范围=五声明段（Inputs/Outputs/Types/Constraints/Config 的 section 区间）+ Id 行形态（2026-08-30 作者追问"constraints, config 这两个为啥不在"后补入——两段同为纯声明区,全角冒号同样静默丢:Constraints 行漏 `- ` 前缀整条约束蒸发,Config 键用全角冒号该键回缺省）；Tools 段不入本道——其行形态错误早已是响亮 parse error（三分支外一律报错）,再收集是重复报;Steps 区与散文节不收紧（行形态复杂误报面大）；
- 区内不匹配任何文法的非空行 → parse **warning**（非 error——不拦执行,产物照旧可跑）,报行号+行文前 60 字符;
- 全角标点点名：行内含 `：`/`（`/`）`/`，` 等全角标点时警告附"疑似全角标点,改半角"提示（中文输入法第一手滑,121 站点摸底的高频形态）;
- 豁免面：空行、纯 `#` 注释行、已入文法的嵌套子行（Types 字段行/enum 续行）——判据=现行逐行解析已消费的行天然不进警告,警告只收"逐行解析跳过且非空非注释"的行。各段"被文法认领"的判据：Inputs/Outputs=RE_VAR_DECL 中；Constraints=RE_LIST_ITEM 中（`- ` 列表项）；Config=`-? 键:` 半角冒号键行形态（整段 YAML 与逐行回退两条路都只吃它）；Types=段内状态机实际消费（类型声明行/类型下的合法字段行）；
- **Steps 区扩围（2026-08-30 作者令"这个也修掉"追加）**：步骤区行循环里掉到末尾兜底且非标题风的行（原静默丢弃——流浪散文/`+ ->` ASCII 箭头/首步之前的野文字）收 section='Steps' 入同一容器同走 W1。**停收闸**：撞到 `##` 标题行即停收（Steps 后的叙事节不产生 section,Steps 区间一直伸到文件尾——叙事散文是合法自由文本,不停收即 24 文件大误报,实测撞出后加闸）。声明段收集器同款闸（声明段后紧跟叙事节的同病）；
- **指令级围栏闭合（^anc-rule-unclosed-fence 同族扩展,同批）**：extractHopPythonFence 返回 unclosed 位,开栏后到指令区结束没等到闭栏 → parse error（原静默接受:删掉闭栏行 body 照样提取,产物截断不可见——fuzz 惰性行 12 条 `> \`\`\`` 的病根）。

**关键逻辑（HopSop）**——通道选型：ParseError 无 warn 位（parse errors 是硬错且非空即截断 validate),孤儿行**入 AST 由 validator 出 warn**（validator 的 error/warn/info 通道现成,validate/init 两入口同享零新通道）:
```
parser（收集半边,零报错）:
1. [act] 五声明段逐行走既有文法（消费成功的行照旧入 AST）
2. [条件(行未被文法消费 且 非空 且 非纯#注释)] 收集 {line, text, section} 入
   SpecHeader.decl_zone_orphans（可选字段,无孤儿不置——AST 向后兼容）
3. Id 行形态: RE_ID_LINE 不中但行首匹配 /^(Id|标识)：/ 的 → 同收（全角冒号 Id 行定向网）
validator（判定半边,新规则 W1）:
4. [act] 读 header.decl_zone_orphans 逐行产 severity='warn'——报 section+行号+行文前 60 字符;
   行内含全角标点（：（），；）附"疑似全角标点,改半角"点名
```
测试正反例：全角冒号声明行 → warn 且报文含"疑似全角标点"；正常声明/注释/空行/Types 嵌套子行 → 零警告；Steps 区畸形行 → 不警告（范围外维持宽容）。

### serializer 输出行三形态分写【契约】 ^anc-rule-serialize-output-forms

（2026-08-30 todo/0016 投影漂移修——S4"不保证往返一致"豁免的是**格式**,不豁免**语义**：写回件 re-parse 后 AST 结构变了就是投影违约。）步骤输出行按 OutputDecl 三形态分写：

- **复合输出**（fields 非空）→ 展开头 `+ → name:`（尾冒号无类型）+ 缩进 `- 字段: 类型` 子行——原写 `name: yaml` 把 fields 整个丢掉；
- **裸名引用**（type 空串=更新/引用既有变量,如 loop 更新模式 `+ → findings`）→ 裸名**不写冒号**——原写 `name: `（尾冒号空类型）,re-parse 误认复合展开头得 type='yaml',投影漂移实锤形态（fuzz 基线 loop-branch 记录）；
- **常规声明** → `+ → name: type` 照旧。

同批同族：act body serializer 的 f-string 插值内字符串字面量改写**单引号**（quoteSingle,fstringDepth 状态）——f-string 外层恒双引号,插值内再出双引号即撞栏,`f"{p["id"]}"` re-parse 必炸（hop-fact-check/hop-deep-research 两件实撞）。@a: anc-rule-serialize-output-forms

### 内容章节缺省供给【决策+契约】 ^anc-rule-narrative-sections

**为什么（2026-08-27 作者三连定）**：①"写在 spec 文件的内容章节,就是缺省要供给的内容,也是 /hop 写成一个文件的原因"——一文件=一供给单元,"计划+语境同体"的同体包括供给面;此前两案（driver 纪律加 doc-ref 引用/显式标记+守卫）均被否:依赖 LLM 自觉不靠谱,记标记也是记;②"不只是背景"——节名不设白名单,全部内容章节都供;③"处置记录这种垃圾集散地除外"——追加式流水账是噪声。

**收集规则（parser 面）**：

- 非关键字的 `##` 节（SECTION_KEYWORDS 未命中）且**节内不含步骤行**（RE_STEP 零命中——含步骤行=标题风分区,归 ^anc-rule-surface-heading-flavor 既有契约,继续静默跳过零解析影响）→ 收集为**内容章节**：`SpecAST.header.narrative_sections?: Array<{ title, content }>`（title=节名原文,content=节体原文字节——不解析不加工）;
- **排除双轨：惯例名单 + 通用标记（2026-08-29 作者拍 A 案——实物落地后抓"很蠢的(不供给)也放入标题了":机制噪声长在人读的标题上,每张卡都带着）**：
  - **惯例名单**（PRIVATE_SECTION_NAMES,现只一员 `处置记录`）：节名去空白后精确等于名单项 → 不收,标题保持干净的 `## 处置记录`。引擎认惯例名与 git 认 .gitignore 同理——"处置记录"已是任务卡跨载体惯例,原"引擎不认 driver 私有词汇"的洁癖在实物丑陋面前让步（一个词的名单,不是白名单机制回潮——供给面仍是"全部内容章节缺省供给",名单只管排除侧）;
  - **通用标记**（既有机制原样保留）：节名内出现 `(不供给)` / `(private)` 的不收（宽容匹配非尾锚——作者抓位置陷阱:尾匹配下照抄带尾巴即静默失效,而排除标记的失效模式恰是垃圾被供给）——任意其它节想留给人读用它显式标（如 `## 草稿(不供给)`）;
  - hop-skill 卡模板的处置记录节名随之回归干净形态 `## 处置记录`;既有带标记的卡无需迁移（标记轨照旧生效,双轨并行无冲突）;
- 一级标题(`#`)/二级(`##`)结束当前节;**三级以下(`###+`)是节内内容**（`## 背景` 里用 `###` 分小节属自然写法,子节标题与内容全数并入所属节——阅卷实锤:初版任意深度掐断,### 后内容既不供给也在往返中蒸发,违背'写进文件的就是要供给的'）;围栏内与 `%% %%` 注释块内的 `##` 照旧不算节头（阅卷附注实锤:@trace 块内 ## 曾被误收伪节）;
- serializer 原文回写（narrative_sections 按原序原字节输出——镜像写回的"叙事段字节原样"条款自此有 AST 依据）。

**供给面（prompt 归属 [[prompt-assembler#^anc-exec-cache-affinity]]）**：narrative_sections 注入 `spec_knowledge_context`（L2-spec 稳定面——跨步恒定,缓存亲和;渲染形态与 spec 级 @knowledge 并列,来源标 `本文件《节名》`。**执行序契约**:组装期 narrative 先入本字段,检索型知识后跑——追加语义的实现点在**检索侧**〔injectKnowledgeContext〕,组装侧直建;阅卷实锤初版追加分支写在组装侧成死代码,检索侧赋值整段覆盖 narrative）。**doc-ref 机制不动**（跨文件引用照旧;同文件节引用变冗余但无害——doc-ref 注入的是步骤级 L2,重复供给不冲突）。

## 验证规则（54 条）【契约】 ^anc-rule-all

本规则集对齐 HopSpec V3 核心规范的完整语法 ^anc-rule-v3-all

`validate_spec` 对 SpecAST 执行的 54 条验证规则——这是本组件的契约主体。rule 编号对应 `ValidationError.rule` 字段。严重程度：`error` = 阻塞执行，`warn` = 不阻塞但应修复（二分原则见关键决策 2）。

### 结构规则（S）

- S1：Spec 必须有标题（header.title 非空），error ^anc-rule-s1
- S2：步骤 ID 格式正确（层级数字编码，如 "1.2.3"，每个数字 ≥ 1），error ^anc-rule-s2
- S3：步骤 ID 在同一 Spec 内唯一，error ^anc-rule-s3
- S4：step_type 必须为 15 种有效值之一（2026-08-07 parallel 类型退役；见 [[spec-ast]] StepType），error ^anc-rule-s4
- S5：容器步骤（subtask/loop/branch/case——parallel 类型已退役）必须有至少 1 个 child，error。**豁免：`[subtask free]` 到步展开档 children 可空**（2026-08-27 随 ^anc-step-subtask-free——写卡只声明契约,children 由执行到步时索计划补齐;非 free 的空容器照拒。空且非 free=S5 error,free 且非空=合法〔预填部分步照常执行,到步语义不触发——free 只在 children 空时改变到步行为〕） ^anc-rule-s5
- S6：步骤 ID 层级一致：child step_id 必须以前缀形式继承 parent step_id，error ^anc-rule-s6
- S7：顶层步骤 ID 必须为单数字（"1", "2", ...），error ^anc-rule-s7
- S8：Spec 应有目标（header.goal 非空），error ^anc-rule-s8
- S9：数据产出容器（subtask/parallel/loop/branch/case）若有后续步骤引用其输出，则必须声明 `+ →`，error；纯控制流容器可省略（隐含 `+ → none`），不报错。**branch 声明 `+ →` 作为聚合输出的统一接口名**，各 case 用同名 `+ →` 填充（同一个东西，V2 不报重名）。**case 即 branch 下的 subtask**，开自己的作用域、声明同名聚合输出 ^anc-rule-s9
- S10：有 Steps 的 Spec 至少包含一个步骤；无 Steps 的 Spec（能力声明）必须有 Goal 和 Outputs，error ^anc-rule-s10
- S11：叶子步骤（reason/act/check/confirm/ask/commit/call/break/continue/exit）不能有 children，error ^anc-rule-s11
- S12：**parallel 申报属实 + 无 Future**（2026-08-10 统一模型改写，概念 [[../concepts/HopSpec V3核心规范#^anc-rule-s12]]；实现待排期——迁移期内现行代码仍跑旧判定"容器声明+children 依赖分析"）：三子条——① **宿主**：parallel 只可标 subtask/call；loop 头标注=error（明确提示"迁移为体内步骤标注"）；② **在飞不可依赖**：标注步骤不得 `←` 其他标注步骤的输出（对方在飞值未就绪；未标注主线步骤的输出照常可用——主线串行保证派发时已就绪、快照传入，流水线形态的前提）；③ **无 Future**：标注步骤的输出（call 为 output_mapping 目标名）在所在容器内不可被后续步骤消费（值可能未回——含同轮后续步骤与跨迭代引用，只经容器边界导出）；④ **收敛边界必须存在且=最近任务容器**（2026-08-13 作者定形，三撞合一：examples 顶层裸挂全绿 / case 臂边界归属 / retry 归属抖动推演）：任务容器 = **subtask/case/loop**（case 就是 branch 下的 subtask，自身即事务即边界）；**branch 是唯一透明结构**（选择结构非任务单元），边界判定穿过 branch 向上找；**loop 无远程特权**——中间隔着 subtask/case 时边界收窄到最近那层（推演根据=并行失败走边界的 retry，边界越过更近事务则失败归属随远处结构漂移，retry 归属抖动，事务语义失效——同理废弃"声明驱动穿透边界"候选方案，废案记 [[parallel-execution]]）。标注步骤无任务容器祖先（顶层裸挂/只有 branch 祖先）即 error（报文指路"包一层任务容器"）；call parallel 的边界更严=必须 loop 体内（①既有）。原"顶层平铺：收齐点=实例边界"读法作废。对未标注但判定独立的步骤给 info 级提示"可考虑申报 parallel"（**v1 偏差：info 提示未实现**——优化项，暂缺不影响正确性）。error。正反例矩阵行 6/7/8。 ^anc-rule-s12
- S13（2026-08-09 新增；2026-08-10 随统一模型改写措辞，判定对象从容器头改为标注步骤输出）：**parallel 标注步骤的输出不得声明为累加器**（带 `= 初值` 的输出）——派出去的活是独立进程无共享空间可累加，其输出只走收集列表（loop collect）或容器边界具名导出（失败的活不贡献元素，部分失败=列表变短）；要 reduce 在收齐后的步骤自己写。error。见概念 [[../concepts/HopSpec V3核心规范#^anc-exec-loop-var-scope]]。 ^anc-rule-s13
- S15（2026-08-21 随 `[on fail]` 失败兜底原语新增,概念 [[../concepts/HopSpec V3核心规范#^anc-step-on-fail]]）：**on_fail 位置约束**——宿主必须是 subtask/case（retry 耗尽才有兜底语义,loop/顶层挂即 error）;必须是容器**最后一个子节点**（check final 之后）;一容器**至多一个**。文法两形态：英文 `[on fail]`（唯一双词类型,parser 在类型归一点合并 type='on'+attrs='fail'）/中文 `[失败兜底]`（别名表)。serializer 写回标准形 `[on fail]`。error。**C7 协同（四次复审实抓互斥矛盾后补条款）**：on_fail 入 C7 提交段白名单（check final 之后合法后随者=commit/exit/check final/on_fail）——S15 钦定'check final 之后末位',C7 不放行则标准形态必红;兜底块非探索步骤（只在失败路径执行）,不破'check final 后无探索'语义。 ^anc-rule-s15
- S16（2026-09-04 随 parallel 续链收割新增,作者补拍"在 validate 工具这边应该有这种循环收集断链的检测"——决策档案 todo/decision/20260904-parallel收割须兑现声明产出链.md;D80 实撞:loop>壳>call parallel 三层形态,壳漏声明边界产出时收割链静默断,运行 18 小时后丢产物账面 completed）：**并行收集产出链完整**——两半:①**collect 供给核**:loop 头 collect 点名的单项变量,必须由循环体**直接子级**的边界产出（`+ →` 声明）提供,点名无人供=error;②**链条逐环核**:parallel 标注步骤到收集边界（带 collect 的 loop）之间隔中间容器时,每层中间容器必须把被收集变量声明为自己的边界产出,漏声明=error 点名断在哪层（报文形如「collect 变量 X 在容器 N.N 断链——该容器未声明 + → X,子层产出到不了收集边界」）。写时抓"spec 真断链",与引擎续链收割（[[parallel-execution#^anc-exec-parallel-reap-chain]]"链齐必须走通"）两半合拢,消灭"运行期静默丢产物"地带。error。 ^anc-rule-s16
- S14（2026-08-09 新增，作者定 Id 函数签名）：Id 行**可选**函数形式 `Id: <func_id>(in1, in2) -> out1, out2`——`header.id` 仍取 func 名（call 寻址不变），签名只列**名字**（类型留在 Inputs/Outputs 展开块，签名是索引不是替代）。**写了签名就必须对应**：参数名集合 = `Inputs:` 名集合、返回名集合 = `Outputs:` 名集合（多/漏/错名均 error——签名错误比没有签名更误导，同 P4 半写即错原则）。无签名的纯 Id 行完全合法。签名原文存 `header.signature`（serializer 原样回写），不结构化入 AST（一致性静态校验完即无运行时消费方；call/L2 消费留待需要时扩展）。**签名函数名名位收中文**（字符集=\w 加中文区段、次位起收连字符——与变量名的 V2b 全 Unicode 字母文法是两套（V2b 禁连字符），不混同；中文函数名一等公民，parser 与 validator 两侧文法必须同宽；2026-08-30 语义审计实抓两侧撕裂：parser 收中文、validator 只认 ASCII，设计明文合法的 `Id: 处理(输入) -> 结果` 被 S14 误拒——修后两侧同宽，正反例成对钉）。 ^anc-rule-s14

### 控制流规则（C）

- C1：case 步骤只能作为 branch 的直接 child，error ^anc-rule-c1
- C2：branch 的 children 必须全部是 case，且至少 1 个（单 case = if-then），error ^anc-rule-c2
- **case 条件解析**（概念 [[HopSpec V3核心规范#^anc-step-case]]；2026-08-09 作者定结构化逻辑标准写法改版）：**结构化逻辑标准写法 `[case(条件)] 人读描述`——机读全在 `[]` 内**（与 `[loop for-each …]`/`[subtask retry=N]` 属性同构），描述纯人读不入求值。步骤行对 `[case(` 起始的属性区改**括号平衡扫描**取条件（条件可含 `]`/嵌套括号如 `items[0] == "a"`，`[^\]]*` 正则会误截）；`[case]` 无条件 = default。统配标准写法 `[case(else)]`（2026-08-09 认知三改——`...` 是符号谜语，else 是日常英语）；else 为条件位保留字（V2 禁变量名/枚举成员取 else）。**旧统配已废止**（`[case(...)]` 落条件解析即 C8 报错提示改 else；`[case(default)]` 显式 parse error 提示改 else——default 与内部统配标记同拼写，放行即静默复活旧写法；`[case()]` 空串同废；裸 `[case]` 仍= default 兜底保留）。**旧形态过渡期兼容读（将废止）**：`[case] 描述 (条件)`（行尾最后一个平衡括号组）照旧解析——存量零迁移；serializer 统配写 `(else)`；废止时点待概念层宣布。condition 字符串原样存 `CaseStep.condition`（表达式 AST 不入 SpecAST——求值期引擎经 parseExpression 即时解析）。求值由引擎 `evaluateCondition` 负责（解析侧不求值、不剥引号）。**`[case(条件) 属性…]` 尾属性**（2026-08-13 随属性总闸补通道）：平衡扫描取完条件后，`)` 与 `]` 之间的尾巴按常规属性文法解析（复用 call 括号尾属性通道模式）——case 可带 retry/adaptive/parallel（case 就是 branch 下的 subtask）；此前尾巴无通道，`[case parallel]` 的 parallel 被当条件源或静默丢弃是实撞病根。 ^anc-rule-case-condition

- **属性总闸（未消费属性即 parse error）**（2026-08-13 作者定，概念 [[../concepts/HopSpec V3核心规范#^anc-step-parallel]]；实撞：`[case parallel]` 静默吞且旧形态下被解析成 default 统配——分支语义被无声改写；`[reason retry=2]`/`[act parallel]` 全族同病，P9 因 parser 先丢属性成死代码）：**每类步骤声明自己消费的属性键集合，解析收尾时剩余未消费键一律 parse error**，报文带"属性 X 不适用于 [类型]"与正确宿主指路（parallel→subtask/call/case；retry/adaptive→subtask/case）。内部通道键（`__cond`/`__callee`/`__callmap`）与结构键（`for-each`/`collect`/`max`）随各类型消费面登记。**消费面表**：subtask={retry,adaptive,parallel}；case={retry,adaptive,parallel,__cond}；call={parallel,__callee,__callmap,＋无括号形态的裸 callee 键}；loop={max,max_iterations(兼容读),for-each,collect,parallel(在表但另有专项报错——头部 parallel 已废除文法,总闸不重复报)}；check={final,finally(废止判定用)}；confirm={require_human}；ask={require_human,present_inputs}；reason/act/commit/exit=∅；break/continue={目标步骤号（裸 `数字(.数字)*` 键,入 target_loop——其余裸键仍拦）}。P9 的属性错位判定升到 parser 层即时拦（validator P9 保留 @model warn 半边）。 ^anc-rule-attr-gate

- **call 头解析**（概念 [[HopSpec V3核心规范#^anc-step-call]]；2026-08-09 作者裁决结构化逻辑标准写法统一）：**结构化逻辑标准写法 `[call <Id>(输入映射)] 描述`——机读（callee id + 输入映射）全在 `[]` 内**（primer 盲测实撞：agent 把"方括号=机器面"合理泛化到 call 被 P1 拒——语言自身结构化逻辑标准写法不一致的债）。括号内输入映射 `callee_param: caller_var` 逗号分隔（目标: 来源），**同名省略成裸名**（`(doc)` ≡ `(doc: doc)`）；**无输入写 `[call id]`**（无括号）。步骤行对 `[call ` 起始做**括号平衡扫描**（复用 case 通道模式：映射值可含引号/嵌套括号），id 与映射串经 attrs 内部通道（`__callee`/`__callmap`）传递。**输出映射不变**：`+ → parent_var: callee_output` 行收取。**旧形态过渡期兼容读（将废止）**：`[call] <Id> : 描述` + `- ←` 输入映射行照旧解析——存量零迁移；serializer 只写标准写法；废止时点待概念层宣布（届时兼容分支降 error）。映射解析后仍入 `CallStep.param_mapping`（AST 不变，纯表层文法改版——engine/CLI/回填零改动）。 ^anc-rule-call-orthography
- **片段验证模式**（parseFragment+validateSpec options.fragment,hop-cli --fragment 的引擎面）：**parseFragment 原生解析裸步骤片段**——输入=步骤序列文本（无 `# 标题`/`## Steps` 节头,可带片段自身的 `> `/`←`/`→` 全部节点体元素）,复用 parseStepSection 全套步骤文法,报错行号=片段真实行（不经拼头,无行号偏移）;validateSpec options {fragment:true, knownVars:[...]}——豁免整文完备性规则（S8/S10/exit 交付/P10）,knownVars 注入 V1 可追溯来源（类型未知按通配,类型核对归整文验）,**B2 commit 档降 warn**（R10 review 补——parseFragment 合成 header 恒无 tools,片段看不见整文声明面,error 判据材料缺失;非 free 容器 replan 合法含 commit 且全量走 fragment 校验,error 会误杀合法 replan;报文注"整文验为准",与 knownVars 类型归整文验同一分层）,其余规则全量执行。豁免必须显式列举——默认全验,漏豁免=误报可见,误豁免=漏检不可见,宁可前者。**C3/C6/C7 祖先缺席形态豁免**（buildtest 实撞 2026-08-18:片段=循环体/事务体子树时 loop/subtask 容器住父上下文,片段本地无祖先——continue/check/check final 合法却被拒,反馈教 LLM 删掉合法流控=误报驱动劣化产物;C7 半边系工程链 review 对读抓出——初版条款自断言'C7 不涉'不实,C7 首判 'must be inside a subtask' 与 C6 同病）：只豁免"无祖先"消息形态（C3 'is not inside a loop'/C6 'must be inside a subtask or case'/C7 'must be inside a subtask'）;片段内真有容器但类型/位置错的照拦（祖先在场即本地可判——C3 带目标的三子检查与 C7 末尾位置判'only commit/exit/check final may follow'消息形态不同,全量照跑）;整文位置正确性归整文验（5.4 读回全文 validate 兜底,与 knownVars 类型归整文验同一分层）。 ^anc-rule-fragment-mode
- C3：break/continue 步骤只能在 loop 内部（任意深度），error；**带目标形态** `[break <步骤号>]`/`[continue <步骤号>]`（方括号内类型词后的裸步骤号,经属性通道入 `target_loop`）目标必须存在、是 loop、且是自身祖先——三判任一不过 error（与 HopSop 流控目标契约同构:祖先循环才可指） ^anc-rule-c3
- C4：exit/break 后的同级步骤不可达，warn ^anc-rule-c4
- C5：loop 必须有至少一条可达的终止路径（break/exit 或 max_iterations），warn。**for-each 形态豁免**（2026-08-08 补：列表耗尽即结构性终止,不需 break/exit——代码先行,此处回写） ^anc-rule-c5
- C6：check 步骤必须在 subtask 或 case 内部（任意深度），error ^anc-rule-c6
- C7：`[check final]` 必须在 subtask 容器内且位于全部探索性步骤之后——其后只允许**提交性收尾**（`commit`/`exit`/其他 `check final`），出现其余步骤类型（reason/act/ask/confirm/loop/branch/subtask/call/break/continue）error；check final 前的探索段内不得夹 check final ^anc-rule-c7
- C8（2026-08-09 重写，随 case 条件升 hop_python 表达式子集——作者裁决"一套表达式文法两个宿主"）：case condition 必须是**合法的 hop_python 纯表达式**且引用变量路径合法（error）。校验两段：① **表达式合法性**——经 act-body-parser 的 `parseExpression` 入口解析（同一文法：字面量/变量/字段访问/数组下标/比较 `== != < > <= >=`（数值语义）/布尔 `and or not`/算术 `+ - * /`/括号/裸变量真值），解析失败报 C8 并附**准确错因**（原实现只认 ==/!=，`(count > 10)` 被误报"未定义变量"——报错文案指错方向是 8k primer K 题实撞的直接教训）；**条件允许内置 pure 函数、禁工具调用**（2026-08-10 作者定）——call 节点 callee ∈ ACT_BUILTIN_NAMES 放行（实参照常走变量路径校验），否则报 C8"非 pure 函数"；**禁赋值**（只读）；**enum 成员裸写结构化逻辑标准写法**（作者定）——比较另一侧是 enum 型时，裸字须 ∈ 枚举成员（写错当场报，合法值列表入消息）；配套 V2 禁令：变量名不得与作用域内任何 enum 成员重名（裸字消歧两义）；② **变量路径校验**——遍历表达式 AST 的全部 var/field 节点，逐个按原 dotted path 规则校验（首段可见性/TypeDecl 字段下钻/数组下标，不变）；**复合节点子表达式一律下钻**（ternary 三支/list 元素/dict 值/fstring 插值——2026-08-17 二审实抓：三元新增时发现 2026-08-10 三种字面量节点从未进本 walker,悬空变量藏进任一支即漏放,同族一并补）。**条件位 f-string 插值不可用**（如实钉住:条件解析前 `{x}` 一律剥为 `x`〔历史 `{point.type}` 花括号形态兼容层〕,`f"{x}"` 被剥成纯文本——validator 与运行时同一剥除两侧一致无分叉;条件里要拼接串前置 act 步产出变量）。**default case（空条件）跳过**。存量 spec 的 `==`/`!=`/裸变量写法全部是新文法真子集，零迁移。 ^anc-rule-c8

### 变量规则（V）

- V1：← 输入绑定引用的变量必须存在（Inputs ∪ 前序步骤 outputs ∪ 祖先 scope outputs），error ^anc-rule-v1
- V2（2026-08-09 扁平命名空间重定义；同日 collect 子句后豁免收窄）：**同名 = 同一个变量**。同名+同类型 = 同一变量的多次赋值（合法——Python 重新赋值语义，含原"更新模式"与任意深度的块内写）；同名+**异类型** = 两个数据抢一个名字，error。**唯一同名特例**：branch 统一接口——branch 头与各 case 的同名 `+ →` 是同一变量（互斥分支对同一语义角色取值），同型要求照常。for-each 收集经 collect 子句两名分离（unitVar/listVar 异名），无同名问题——原"接口填充豁免①"删除。**保留字禁令三族**（V2 承载）：① `else`/`其他`（[case(else)] 统配位,2026-08-09;**2026-08-25 收编关键词闸单闸**——原散点判只拦产出位,Inputs/for-each/collect/call 映射四位放行与'禁作变量名'承诺不符,收编后六检查位恒同位,enum 成员含 else 判保留散点〔成员位不在变量位内〕）；② enum 成员重名（裸字消歧,2026-08-09;**2026-08-25 改预扫台账双向覆盖**——原实现产出位单向扫 scope.declared 只拦'新变量撞已有 enum 成员',反向〔后声明的 enum 撞已有变量〕与 Inputs/for-each/collect/call 映射位全放行;扁平命名空间声明顺序无语义,collectEnumMembers 预扫全 spec〔Inputs+全步骤产出,enum(...) 与 [enum(...)] 两形态〕建 成员→声明处 台账,enumMemberCollisionError 挂六变量位与关键词/类型闸恒同位,天然双向）；③ **内置类型名全局保留**（2026-08-14 作者拍板 A,概念 [[../concepts/HopSpec V3核心规范#^anc-rule-type-reserved]]）——`text/bool/line/number/int/float/markdown/yaml/prompt/HopSpec` 禁作变量名（Inputs/产出名/call 映射目标）,类型词与变量位同槽竞争的语法位会静默错读（BUG-G:call 映射 `domain: line` 被读成变量引用）,类型词做变量名无真实需求。检查位=Inputs 声明+产出注册+call output_mapping.to/param_mapping.to;error。**V6 的映射来源撞类型 token 闸保留**（来源位撞=另一形态:类型声明误入映射行,报文指改法——两闸互补非冗余）。正反例:input 名 text 拒/产出名 yaml 拒/映射目标 line 拒/普通名零误伤/类型位照常（`+ → x: line` 的 line 在类型位合法）。 ^anc-rule-v2
- 规则 27：**内置类型名全局保留**（2026-08-14 作者拍板 A,概念 [[../concepts/HopSpec V3核心规范#^anc-rule-type-reserved]]）：`text/bool/line/number/int/float/markdown/yaml/prompt/HopSpec` 禁作变量名——类型词与变量位同槽竞争的语法位（call 映射 `+ → to: from` 冒号后是变量位）会静默错读（BUG-G:`domain: line` 被读成变量引用产 null）,类型词做变量名无真实需求（同 else 先例）。检查位七处=Inputs 声明/产出注册/call param_mapping.to/output_mapping.to/for-each itemVar/collect unitVar/Types 段类型名遮蔽（typeReservedError 共享判据,报文统一指规则 27;itemVar·unitVar·TypeDecl 三位系 review 全谱探测补漏——「变量引入位」的完备枚举=声明·产出·映射目标·子句绑定,TypeDecl 属类型命名位但遮蔽内置同为歧义源同闸）;V6 的**来源位**撞类型 token 闸保留（另一形态:类型声明误入映射行,报文指改法——两闸互补）。error。正反例:Inputs 撞拒/产出名拒/映射目标拒/类型位照常/形近普通名（lines/text_body）零误伤。 ^anc-rule-type-reserved
- V3【已废除，2026-08-09】：原"输出不得遮蔽祖先 scope 变量"随块级作用域废除失去对象——扁平命名空间无嵌套作用域即无遮蔽，同名判定全部归 V2（同型=同一变量合法/异型=error）。原两条豁免（更新模式/显式初值）成为普通合法写法无需豁免。编号保留仅作规则史锚。 ^anc-rule-v3
- V4：+ → 输出类型必须有效（严格校验 `isValidTypeWithDecls`：9 种 ValueType 或已声明 TypeDecl，未声明类型拒绝，见关键决策 3），error。**类型 token 切分文法**（2026-08-25,28 轮 review 抓静默吞家族新例）：声明位类型 token = `\S+` 可选带一层括号参数、可选尾 `]`——`[enum(a, b)]` 列表元素含参形的括号内逗号带空格,原 `\S+(?:\([^)]*\))?` 停在空格前吞不到闭括号后的 `]`,Inputs/Outputs 段整行静默消失、步骤产出行被逗号切碎成三个碎名——三站点（RE_VAR_DECL/Types 字段行/parseOutputExpr singleMatch）同修尾 `\]?`;切分宽一档,类型合法性照旧归 V4/V7（isValidTypeWithDecls 对 `[enum(...)]` 走 `[T]` 剥括号递归本就合法） ^anc-rule-v4
- V2b：**变量名标识符文法闸**（2026-08-15 primer trap 实撞——agent 把赋值表达式写进 `+ →` 行:`+ → alert_list = alert_list + [customer]`,parser 把整串静默收作变量名,下游 B4/B5 报『引用未定义/无对应赋值』指错方向,真病在 `+ →` 行写了表达式）：`+ →` 产出名/Inputs 名文法=**Unicode 标识符（Python 3 同款,2026-08-15 作者两轮裁定终形）**：`[\p{L}_][\p{L}\p{N}_]*`——中文名一等公民（`风险等级` 合法）,与 hop_python tokenizer 字符集精确一致（能声明必能引用,零下游冲突面;连字符/空格/`=`/`+` 等表达式字符天然出局）。违规 = **error**,含 `=`/空格时报文指明『`+ →` 行只声明名字,累加写法进 hop_python body』（实撞串 `alert_list = alert_list + [customer]`）。error。正反例:表达式串拒指路/中文名放行/连字符拒（Python 同判且下游 tokenizer 切不动）/数字开头拒。 ^anc-rule-v2b
- V5：Inputs 段变量名不重复，error ^anc-rule-v5
- V6：call 步骤 param_mapping 的 from/to 非空，error（param_mapping 与 output_mapping 两方向都校验——加严已在码,此处回写）。**映射/类型声明文法歧义闸（2026-08-14 BUG-G 实撞补定）**：output_mapping 的 `from`（子输出名）撞内置类型 token（line/text/yaml/number/bool/int/float/markdown/prompt）= **error**——`+ → domain: line` 是作者按类型声明习惯写的（其他步骤同形态合法）,call 行被读成"domain ← 子输出 line"静默错映射,子实例无此输出运行期得 null（hopkb 级二实撞:collect 收 [null]）。类型 token 做子输出名的真实场景不存在,撞上即歧义,报文指明两种改法（同名裸写 `+ → domain` / 真映射写子输出真名）。error。正反例:domain: line 拒指路/真映射 clean_doc: normalized 放行/裸名放行。**字面量映射项两闸（2026-08-27 随字面量入文法,hopissues/0044）**：①param_mapping 字面量项（`literal_value` 在场）豁免 from 的变量语义检查（S12 消费边等不把 `"seq"` 当变量名）,`to` 侧检查照旧;②output_mapping 值位写字面量 = **error**——判定面与 parser 三正则逐字同（同型引号成对/数字/小写 true|false|null,权威 [[spec-ast#^anc-step-call-literal]],两闸不许漂移）;输出映射值位是子输出名,"接收一个常量"无意义,多半是方向写反（报文指明 `+ →` 行是"父变量: 子输出名"）。正反例:param 字面量放行/output 值位 `"x"` 拒指路。 ^anc-rule-v6
- V7：Inputs 段声明的变量类型必须有效（ValueTypeString 或已声明 TypeDecl），error ^anc-rule-v7
- V9（2026-08-08 作者终定：**宽容双写法，无运行时检查**）：`loop for-each` 头部子句同时声明两个名字——`itemVar` 定义点=子句自身，`listVar` 的消费边由 **parser 自动合成**入 `loop.inputs`（`VarBinding.synthesized=true`，V1/S12 从变量流图照常可见），故**不写 `- ← listVar` 不缺边、显式写也完全合法零提示**（作者原话"写了也行，不写也没错"）。演进史：08-07 立规"缺 ← 行 error"（强制重复实现消费边入图，迁移误删即悬空）→ 同日翻转"显式行 info 冗余"（合成边使悬空结构性不可能）→ 08-08 终定等价无提示（info 的"建议删除"与'写了也行'矛盾）。V9 编号保留仅作规则史锚。**itemVar 的注册只取决于 for-each 子句在场，与容器是否声明 `+ →` 无关**——纯副作用循环（S9 允许省略输出）child 引用 itemVar 同样合法（2026-08-09 实撞后明文化）。 ^anc-rule-v9
- **类型位约束标注 `line(非空)`/`line(nonempty)`（2026-09-02 作者拍 B 案,概念权威 [[../concepts/HopSpec V3核心规范#^anc-type-constraint-annotation]]）**：双语等价,parser 归一站 `normalizeTypeToken` 中文→英文规范形（AST 恒存 `line(nonempty)`,与步骤类型中文别名同律）,**七个类型收取点全站接入**——Inputs 节/Outputs 节/步骤输出/工具参数/工具 output 声明/步骤内联复合输出 fields/头部 Types 节字段（末位系 review 实抓漏点补齐:漏归一的中文标注在 Types 字段位静默零保护,0043 事故形态复刻）;**列表元素形 `[line(非空)]` 同归一**（元素递归校验使英文形天然生效,中文形必须同享——双语不对称=英文暗通中文暗哑）。V4/V7 精确认 `line(nonempty)`（不开 line(任意参)——约束语言口子不开）;V4 对 `line(` 开头的非法变体（含空格/错参）报错附指路句（正确形态两写法——响亮但不指路=烧一轮重试）。值核在 checkValue（空串/全空白 mismatch）;coerce 折叠同罩;serialize 原样往返;PARAM_TYPES 同收编（工具参数语义面同享,归一了必须用得上）。 ^anc-type-constraint-annotation
- **头部类型校验补位（todo/0064,2026-09-02——历来空白:V7 只罩 Inputs 节）**：①头部 `## Outputs` 节类型逐条经 isValidTypeWithDecls 核（V7 扩面与 Inputs 对称,报文同式含 line( 指路——`- r: foo` 曾静默入 AST 运行期落存在性分支）;②头部 `## Types` 节字段位类型同核（报文点名 TypeDecl 名+字段名——B-3 批接入归一但校验半边空白,C8 的 typeDecls 消费曾在坏类型上工作）;③Types 字段行文法整串核：类型串之后只许空白或 `#` 注释,余料非空=parse error 响亮拒带指路（前缀匹配曾把 `line( 非空 )` 截成 `line(` 静默入 fields——静默切值比丢行更毒;余料起点=整段匹配结束位,不许 indexOf 类型串——"line" 会先在字段名 "line_ref" 里命中,存量扫描实撞误伤后定式）;④**括号组容空格与各类型位一致**（2026-09-05 作者拍"validate 修"——0069 两路语料独立撞:`enum(high, low)` 逗号后带空格在 Inputs/步骤输出位合法,Types 字段位却因 `\S+` 分词在空格处断截出 `enum(high,`,余料 ` low)` 触发③的余料闸报错且文案指向"非空约束"不对症）：字段类型串分词改为**先收标识符再整收括号组**（括号内容容空格,`enum(high, low)`/`line(非空)` 一次收全）,归一站 normalizeTypeToken 剥括号内空格后入 AST（AST 恒存规范形 `enum(high,low)`,serialize 往返稳定）;③余料闸保留原语义（真余料——括号组之外的杂text——照拒）,报错文案按余料形态分流:以 `,`/`)` 开头的余料已被④消灭,剩余形态仍指路非空约束写法。三类型位（Inputs/步骤输出/Types 字段）对同一类型串行为一致是本条款的验收判据。 ^anc-rule-v7-header-types
- V10（2026-08-09 新增，随 collect 子句）：collect 子句的两端静态校验，error——① `unitVar` 须有产出方（且非列表型——单项端是 T）。产出方=loop 体内**任一后代步骤**声明产出 unitVar，两种声明形态都算：步骤的 `+ →` 输出声明，或 call 步 `output_mapping` 的目标变量（`[call 子spec(...)]` 的 `+ → unitVar` 半边）。扫全部后代是运行时语义的如实映射：unitVar 注册在子句（root 槽,同 itemVar）,体内任意深度的后代写它都直落该槽——嵌套 subtask/loop 深处产出 unitVar 是现役合法形态（嵌套累加器等价重写测试（tests/nested-loop-accumulator.test.ts,hopkb construct 实撞场景）正是孙辈产出）,只认直接 child 会误杀。缺产出方的运行时后果=传送带每轮从 unitVar 槽读到哨兵 null,静默收出 `[null,null,…]` 列表——报文须把这个后果讲给作者；② `listVar` 须在容器头 `+ →` 声明且为列表型 `[T]`（原尾句"元素型与 unitVar 声明型一致"2026-09-01 删除——collect 子句文法无 unitVar 型槽,AST 无处存型,该核验结构性空转,按文法现实除名）；③ collect 仅可出现在 for-each 形态 loop。unitVar 由子句注册进命名空间（同 itemVar：定义点=子句，children 可写、引擎轮末收集复位）。三子条全实装（validator.ts V10 块；①2026-09-01 todo/0051 补装）。 ^anc-rule-v10
- **hop_env 保留命名空间**（2026-08-14 作者定"第一步只读",概念 [[../concepts/HopSpec V3核心规范#^anc-rule-hop-env-readonly]]）：`hop_env_` 前缀是保留命名空间——①步骤 `+ →` 产出名带此前缀 = error（环境参数只读,业务变量禁入命名空间）;②act body 赋值目标带此前缀 = error（B 规则族扩,静态可查——body 是确定性文本）;③**ask 输出到 hop_env_* 放行**（覆盖链合法末级——运行时问人补值是设计内,非 spec 自改）。可写语义留真需求再议。error。**读侧对偶**：body **引用** `hop_env_*` 名 B4 视作可见放行（运行时注入,静态不可知具体键——未定义键运行期响亮 fail,见 [[act-body#^anc-exec-body-hop-env]]）。正反例:产出名违规拒/body 赋值拒/ask 输出放行/普通变量零误伤/body 引用放行。 ^anc-rule-hop-env-readonly
- V11（2026-08-13 作者定"叶子用到的输入变量必须在节点声明"——L4 prompt 组装只喂 `- ←` 声明的变量,引用未声明=LLM 拿缺料上下文静默出垃圾）：**叶子输入声明完备性的散文引用档**,warn——可执行步骤 instruction 中出现"已定义且本步未声明、非本步自产"的变量名 token 时提示"是消费就补 `- ←`,是散文提及可忽略"。**warn 不 error 的理由（如实分层）**：文本命中≠消费（实测存量两处命中全是提及型——母列表名指代单项/解释性提及）,error 档会迫使作者改写散文措辞避开变量名;精确可判的两面已有硬闸（body 引用=B4 error/ask present_inputs=P14 error）,散文消费的终审归语义审计。短名（<3 字符）不查——撞词率过高无信噪。 ^anc-rule-v11
- V12（2026-09-01 doc-review 第十六次真机实撞立规,作者拍 A 案"响亮拒"）：**call param_mapping 映射来源禁点路径**,error——非字面量映射项的 `from` 含 `.` 即报"参数映射只认整名变量,对象字段先在循环体内拆平（act body: `cur_x = get(item, "x", "")` 逐字段）再传"。为什么：引擎 resolveCallParams 按整名查父变量,`item.reviewer_prompt` 不是变量名查不到即**静默跳过不注入**——实撞:审查员轮 `[call reviewer-worker(reviewer_prompt: item.reviewer_prompt, ...)]` 三个 item.* 参数全 undefined 进子实例,5/5 子实例 makedirs(undefined) 全灭;更险的是子实例拿空指令不自报 lack_of_info,自造角色跑完全程审查（产出像样但角色与派单不符）。字面量项（literal_value 在场）豁免——`"a.b"` 字符串字面量含点是合法值。与运行时 warn（^anc-exec-call-auto-map HopSop 1.3）两层:静态拦写法,运行时兜漏网（点路径之外的悬空 from）。教学面配套=hopbuild2 split-patterns call 拆平教条（报文与教条互指）。正反例:`item.x` 拒指路/整名变量放行/字面量 `"a.b"` 放行。 ^anc-rule-v12
- V14（2026-09-16 D94 档位勘误批随立,作者拍"validate/deep-validate 应该加验证"——供给链两环断链的写时检查半边;缘起=D94 排查实锤"Tools 段声明了但零步骤授权=工具对所有步骤静默不可见,LLM 只能空转不报错"是 split-patterns 教的"最难发现的失效形态",而 validator 此前对 header.tools 只做 B2 分档消费,零断链检查）：**Tools 段声明-授权行消费对账**,warn——`header.tools` 声明的每个工具名,若未被任何步骤的 `- 工具:` 授权行（tool_grants,含 `*` 通配）引用、且未被任何 body 内 CallExpr 调用（body 直调是 basic 面之外的另一合法消费形态）→ warn 点名（报文:`V14: Tools 段声明的工具 "X" 未被任何步骤授权或调用——standalone 下它对所有步骤不可见,声明即空转;要用它给消费步加 "- 工具: X" 授权行,不用它删声明`）。**warn 不 error 的理由**：复用模式下 caller 可能按 Tools 段自行注册消费（清单对 caller 有信息价值）,且存量产物普遍两环齐全（hopbuild2 构建器义务),error 会误伤边缘合法形态;standalone 主通道的真缺陷由报文指路当场可修。反向半边（授权行引用未声明名）不在本规则——授权行开的是环境注册面工具,Tools 段只是需求声明子集,授权超出声明合法（basic 件恒可授）。正反例:声明 ssh_exec+步骤授权 → 零 warn/声明 ssh_exec 零授权零调用 → warn 点名/声明+body 直调（无授权行）→ 零 warn（body 消费合法）/`- 工具: *` 通配在场 → 全部声明视为已消费。 ^anc-rule-v14
- V13（2026-09-05 插值 callee 批,随 ^anc-step-call-dynamic-callee 立）：**call 步骤 callee_expr 在场时,表达式引用的全部根变量（含字段取的根、下标位变量）必须由前序步骤产出或来自 Inputs**（V1 同族核——同一张变量产出登记面）,error——断供=写时红点名变量名（报文:`V13: call 步骤 "X" 的 callee 插值表达式引用变量 "名" 无产出方——前序步骤 + → 或 Inputs 须先声明它`）。为什么：callee 变量断供=执行期解引用必然求出 undefined,晚绑定的"晚"只该晚到运行期取值,不该晚到运行期才发现变量根本无人产出。执行侧解引用契约归 [[step-dispatcher#^anc-step-call-dynamic-callee]]。正反例:前序步骤产出 analyzer 后 `[call {analyzer}]` 过/无产出方 `{ghost_spec}` 拒点名变量名/for-each itemVar 字段取 `{issue.analyzer_spec}` 放行（itemVar 由子句注册）。 ^anc-rule-v13
- V8：`loop for-each` 的 `listVar` 引用的变量，其**声明类型必须是列表 `[T]`**（error）——`[loop for-each item in X]` 中 X 必须来自某处 `+ → X: [T]` 或 Inputs `X: [T]`。for-each 语义是"对列表每个元素展开一轮/一个 child"，listVar 非列表（如误写 `text`）会让引擎把整个值当**单个**元素（parallel 只展开 1 个 child、串行只跑 1 轮）（实测：`confirmed_points: text` + `for-each confirmed_points` → 只跑 1 child 而非 N 个）。运行时才 `Array.isArray` 失败、故障漂离源头——静态提前炸。**两形态同查**（2026-08-07 review 抓出串行漏网——原实现限定 parallel 容器，V8 实撞立规的 bug 对串行形态复发）。查法：`getForEach(step)` 存在即解析 listVar 声明类型，非 `/^\[.+\]$/` 即报错。见 [[exec-engine#^anc-exec-parallel-foreach]] / [[exec-engine#^anc-exec-foreach-serial]]。 ^anc-rule-v8

### 特殊步骤规则（P）

- P1：call 步骤必须有 callee_spec_id 或 callee_expr（至少其一——插值形态 2026-09-05 起合法,^anc-step-call-dynamic-callee），error ^anc-rule-p1
- ~~P2：commit 步骤的 output 声明应包含 `approval: bool`，warn~~ **【已废除】** ^anc-rule-p2
  - 废除原因：源于旧 commit 语义（commit 自带审批、输出 approval）。新概念（见 [[../concepts/HopSpec V3核心规范#^anc-step-commit]]）下 commit 不自带授权环节——授权前置到 `confirm` 步骤，commit 能执行即说明已授权。approval 是 confirm 的产物，不是 commit 的。编号位保留（不重编 P3-P10），规则不再生效
- P3：confirm 步骤的 response_options 若指定须至少含 1 个选项，warn ^anc-rule-p3
- P4（2026-08-09 作者定 bare-exit 语义落定）：exit **显式声明** exit_outputs 时 key 必须与 header.outputs 完全一致（多/漏均 error）；**bare exit（无 exit_outputs）= 合法简写，隐式交付 header 全部 Outputs**（概念 ^anc-step-exit——Outputs 段是交付契约权威，重抄冗余；运行时终态照读命名空间全部 Outputs 兜底，执行结束仍 None 的输出=完备性违约判 failed——[[exec-engine#^anc-exec-output-completeness]],2026-08-17 warning 档废）。原'完全无声明不查'从审计边界转正为定义行为。**exit 带 hop_python body = error**（2026-08-25 作者拍板 B〔静态拦+指路〕,hopissues/hoplogic3/0027 真病灶——exit 是纯流控步,引擎只认 act/commit/check 三型的 body（exit 的围栏留在 instruction 成死代码零执行）,而 validate 全绿:作者以为交付计算会跑,run 必然完备性违约 failed,离病灶隔一层。拦法:**流控三型（exit/break/continue）与容器五型（subtask/loop/branch/case/on_fail）** instruction 含 ```hop_python 围栏即 P4 error（容器 2026-08-25 29 轮 review 扩——容器 instruction 无任何执行通道,prompt 骨架只渲染 summary+attr,同族死代码同闸）,报文按类型指路（exit→『计算移前置 act 步,exit 裸交付』/流控→『只写摘要行』/容器→『计算下沉为容器内 [act] 子步』）。**reason/confirm/ask 不拦**:instruction 进 LLM prompt/问人呈现文本,围栏是给读者的参考材料非死代码。**片段模式照拦**:P4 片段豁免收窄到交付完备形态（片段天然缺 header.outputs 对照面才豁免）,死代码闸报文含『死代码』片段内完全可判——hopbuild expand-node 片段核查是该反馈第一消费场,整码豁免会让缺陷漏到拼装后整文验才报。不选"exit 支持 body"扩展:步骤类型职责纯净（动手=act）,概念层 exit 语义零扩展。 ^anc-rule-p4
- P5：commit 步骤的 irreversible_action 字段非空，error ^anc-rule-p5
- P6：subtask.retry >= 1，loop.max_iterations >= 1，warn。**retry=0 且容器带 `[on fail]` 兜底子步 → 不告警**（2026-09-05 作者拍"修"——0069 压力语料实撞:两处主线容器刻意 retry=0+on fail,语义="失败不盲重跑,直落兜底交诊断包",引擎完全支持〔retry 耗尽先看 on_fail 激活,retry=0 即立即耗尽直落〕,是正当写法;无 on_fail 的 retry=0 照警——**但"失败即整体停下"语义的 retry=0 无 on fail 同样是正当形态**〔0069 R6 语料实抓:旧报文把加 on fail 当唯一消警手段推荐,与"停下场景别加 on fail——兜底把失败吞掉变成继续"的教学方向相反,会引导翻译者篡改语义;报文改为按语义二选一,停下形态明示可带理由忽略〕） ^anc-rule-p6
- P7：ResponseOption.value 和 label 非空字符串，warn ^anc-rule-p7
- P8：retry/adaptive subtask 内的 commit **前序须有把关步骤**——同容器（含嵌套子孙展开的文档序）位于该 commit 之前存在 `confirm` 或 `check`/`check final` 任一即放行，全无 error（判序不判位：跟在 commit 后的 check 不算把关）；内含 call 且无任何把关步骤时 warn（无法静态验证 callee 是否含未兜底 commit，v2+ 运行时检查）。**空 `[subtask free]` 视作把关点**（2026-08-27 随 ^anc-step-subtask-free——其展开物被引擎强制含 check〔EXPANSION_NO_CHECK 运行时闸〕,静态图看不见但运行时必在;不认则'commit 写在 free 外面消费交付物'的教法与 P8 正面冲突,review 实锤:照文档写必撞 P8 error）。本规则是静态排布检查,只管"写的时候把关步骤排在 commit 前面"；运行期的执行序保证（引擎推进不越过未终态步骤直执 commit）归引擎 [[exec-engine#^anc-exec-advance-order-invariant]]——互指 ^anc-rule-p8
- P9：retry 和 adaptive 属性仅适用于 subtask 和 case 步骤类型（case 就是 branch 下的 subtask），error；@model 标注出现在**非路由类别步骤**上时 warn（无效果）——判据=模型路由类别集（reason/act/check/commit,与对外契约'仅可执行步骤(reason/act/check/commit)有效'及 RoutingCategory 同源;原按 EXECUTABLE_STEP_TYPES 判含 confirm/ask/call,@model 写在这三类上通过校验零提示、运行期永不消费,hopissues/0008②——confirm/ask 无 LLM、call 是引擎递归,warn 报文指路） ^anc-rule-p9
- P10 两档（2026-08-17 spec 级半边升 error——hopissues/hoplogic3/0001:hopkb 截断 spec〔Outputs 声明 outcome 而产出步已被误删〕过 validate 零 error 直接跑,completed 假绿到父层 reap 才炸;exit 完备性 P4 只在 exit 在场才触发=闸挂在被删的门上,须一条不依赖 exit 在场的产出点规则）：**Spec `Outputs:` 声明在全 spec 无任何产出点（步骤 `+ →`/call 输出映射 `+ → 父变量: 子输出`/exit 交付）→ error**——有 Steps 才判（无 Steps 的能力声明 spec=HopTrait 形态天然豁免）;产出点核对含 call output_mapping 的 to 侧（同批修盲区:原实现漏计,call 产出 Outputs 的合法形态会被误杀）。**容器 `+ →` 半边维持 warn**（容器输出可由 collect/itemVar/引擎通道给,静态判死会误杀——两档判据不同不并档）。静态可达性检查——**本句只管存在性两档**（error 档与容器 warn 档判"有没有产出点"，任一分支产出即不报；必然性归第三档另判）。**空 [subtask free] 豁免**（2026-08-27——契约要求声明交付物而产出点天然在未来的展开物里,不豁免则合规写法必然误报;运行时 replan-outputs 闸兜住交付）。**第三档:条件产出 warn（2026-09-10 hopissues/0084——库外真实用户 skill 翻译实撞:Outputs 变量只在 branch 一臂产出,validate 全绿〔既有档判"∃ 产出点",全树并集〕,用户跑另一臂运行时完备闸才 failed;这是 0001 显式留开的半边——当时只把运行时闸 warn→failed,静态警告面没补）**：Outputs 声明变量**有产出点但非"必然产出"**（存在一条可达完成路径沿途未赋值）→ **warn**（非 error——多路径交付不同物是合法设计,静态闸只提醒作者别把条件产出当无条件承诺）,文案点名"仅部分完成路径产出,建议按交付路径拆 call 子 spec 各带本路径 Outputs,或确保每条可达终态前赋值"。**必然性判定三规则**（HopSpec 无任意跳转,结构化递归可判,不需要通用数据流分析）：①顺序容器——任一子步必然产出即必然;②branch——**全部 case 臂都必然产出才必然,且须存在 else 臂**（无 else 臂时所有条件都可能不命中、整个 branch 被跳过,任何臂内的产出都不必然——parser 把 case(else) 归一存成 condition='default',判据认 else/default/空三形态;与既有档的并集语义恰是两档分界:并集判"有没有人产",交集判"人人都产"）;③loop——循环体产出**保守判不必然**（max 属性允许零迭代,循环体可能一次都不执行;warning 档下宁少报不误杀）。exit 交付算该路径产出;call 输出映射 to 侧算必然产出（子 spec 对其 Outputs 有自己的完备闸）;空 [subtask free] 豁免照旧（显式豁免:free 容器声明的交付物产出点天然在未来展开物里,其自声明 `+ →` 计必然）。**④容器自声明不短路（2026-09-11 review 修复批——变异复核实锤:0084 原型包进一层自声明 `+ → report` 的 subtask 即整体穿闸,静态闸拦不住主病灶的最常见变体）**:有子步的非 loop 容器（subtask/case/branch）的自声明 `+ →` **不**计必然——容器交付什么由子树必然性说了算（自声明是聚合出口的类型申报,不是产出证据）;loop 头槽（collect/itemVar 承接,引擎通道兜底交付）与空 [subtask free] 是仅有的两处自声明计必然。**on_fail 兜底块产出不计必然**（同批——on_fail 只在失败路径执行,"只在 on_fail 里产出"恰是条件产出形态,并集须跳过它）。**exit 交付经步骤 `+ →` 声明承载**（exit_outputs 专用语法 parser 未支持——原实现的 exit_outputs 分支是死代码,同批两处删除〔collectProduced 同款〕;设计口径以 parser 实况为准）。**顺序并集不感知 exit 早退**（branch 臂内 exit 提前完成时其后顺序步产出照计必然——warn 档宁少报,该漏报形态记录在案不改行为）。实现=collectProduced 旁立 collectAlwaysProduced 变体,两函数并存不合并（并集语义供既有 error 档,交集语义供本档——语义不同强行合一必生分支参数糊）。 ^anc-rule-p10
- P11：`check` 步骤固定输出签名校验，error。check 是内置验证算子，必须**恰好声明两个输出**：一个 `bool`（判定槽）+ 一个 `text`（说明槽）——不能多、不能少、不能换类型（与位置无关，引擎按类型定位）。不满足（如只声明单 bool、双 bool、缺 text、三输出）即 error。对齐概念 [[../concepts/HopSpec V3核心规范#^anc-rule-p11]]，引擎据 bool 槽判定通过/失败、text 槽作失败说明（见 [[exec-engine#^anc-exec-check-verdict]]） ^anc-rule-p11
- P14：`ask` 步骤 `present_inputs` 子集校验，error。若 AskStep 声明了 `present_inputs: [name1, name2, ...]`，每个名字必须出现在该 ask 的 `← inputs` 中（即 inputs.some(b => b.name === presentName)）。不在 ← inputs 中的名字 error——避免 driver 收到 paused 响应时拿不到值无法呈现。对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]] 呈交语义条款 ^anc-rule-p14
- P12：`confirm` 步骤 `+ →` 输出仅允许 bool 类型（error）——审批闸门语义（概念 ^anc-step-confirm），非 bool 输出即误用 confirm 收数据（该用 ask） ^anc-rule-p12
- P13：`ask` 步骤必须声明 `+ →` 输出（error）——数据收集步无输出=收了没处放（概念 ^anc-step-ask） ^anc-rule-p13
- P15：doc-ref `[[文档路径#章节名]]` 静态存在性校验，error。遍历所有步骤的 `doc_refs[]` 及 spec 级 doc_refs（来自 `Constraints:`），对每个 `{doc, section}`：① 解析 `doc`（**两级基准与注入期同判：spec 目录优先、workspace 兜底**——见 [[doc-ref#^anc-exec-doc-ref-resolve]] 解析基准条；Obsidian 省 `.md` 时补 `.md` 兜底）后文件必须存在；② `section` 必须能在该文件中匹配——Markdown 文件按标题三级匹配（精确/归一化序号/子串,`sliceSection` 算法 [[doc-ref#^anc-exec-doc-ref-resolve]]）,YAML 文件（`.yaml`/`.yml`）按键两档匹配（点路径限直接子级/单键名首命中,`sliceYamlKey`,见 [[doc-ref#^anc-exec-doc-ref-yaml-slice]]——两批 review 抓 P15 权威条目漏同步 YAML 档后补）。文件不存在或章节无匹配 → error。对齐概念"找不到即响亮失败"（[[../concepts/HopSpec V3核心规范#^anc-exec-doc-ref]]）——doc-ref 是确定性精确引用，静默降级会让作者误以为知识已注入。**校验需读文件**（V6"不校验运行期信息"的例外：doc-ref 文件是 spec 加载期可达的静态资源，非运行期产物），无 workspace 访问能力时（如纯 AST 单测）跳过此规则。**`hopjit validate` 命令必须递文件访问上下文（2026-08-20 实撞立——原生产路径恒传 undefined,P15 静默跳过,validate 对坏 doc-ref 报"通过"是假绿;init 期才响亮,两入口判定面撕裂）**：validate 命令按 `dirname(specPath)`+cwd 构造 ctx 传入（specPath 命令行现成有）;仅纯 AST 单测与片段校验（fragment 无文件身份）允许缺席跳过。**validate 档跨目录降警（ctx.lenient_cross_dir,仅 validate 命令置位）**：含路径分隔符的引用按 workspace 相对解析,而 validate 时点的 cwd 是猜测非运行期权威（vault 材料 spec 从库内 validate 必找不到,cd vault 再 run 才是它的运行形态）——该形态"文件未找到"降 **warn**（报文缀"运行期核",与 hop_env 缺席档 info 同款留痕非静默）;裸名/同目录引用两级基准即静态权威,照旧 error;章节未匹配（文件已读到）恒 error——文件都在,章节断=真断。init 期 workspace 即运行期权威,不置 lenient,全形态 error。 ^anc-rule-p15

### act body 规则（B）【契约】 ^anc-rule-b-all

校验 act/commit/check 的 hop_python body（见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]；check body 概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-check-body]]——"与 act 同文法同解释器"即同受 B 系列，三十五审抓 check body 入语言时 B 面漏接：ghost 变量 validate 绿、运行期才炸）。仅当 step 有 `body` 时检查。

- B1：body 禁循环（`for`/`while`），error。实际由 parser 词法层拒绝（PARSE_ERROR），validator 兜底防御 ^anc-rule-b1
- B2：body 内 `CallExpr.callee` 须 ∈ 内置函数白名单 ∪ **内置文件/编辑工具名单** ∪ ToolProvider 工具名。validator 期拿不到 ToolProvider（运行期信息），故仅校验：在内置函数白名单 → 校验参数个数（arity）；在内置文件/编辑工具名单（read/write/append/edit_file/search_file/exists/listdir/create/makedirs/move/remove 十一件+spec 内容族六件〔validate_spec/树编辑四件/read_spec_tree——权威归类见 file-tools.md,2026-09-06 review 抓原措辞'树编辑件'字面覆盖不住前后两员后对齐〕——tools.ts 文件工具组,引擎恒注册零声明,静态已知非运行期信息;名单本地维护注明与 tools.ts 同源,B9 同款先例——validator 属核心层不得 import 适配层 tools）→ **核对具名参数名**（2026-09-16 作者拍升档,决策页 todo/decision/20260916-内置工具参数名写时校验.md——实撞:hopbuild2 交付步 `move(src:, dst:)` 凭 Python shutil 肌肉记忆臆造参数名,注册面真名 from/to;原"参数错留运行期报"实况是运行期同样零校验,undefined 穿透到 Node fs 报误导性错误〔"The path argument must be of type string"而 move 无 path 参〕,且毒行躲在 `if 旧文件在场` 条件后,selftest/历次 probe 全走 else 分支零通电,真机烧一轮才爆）：**本地签名表**（每件工具的合法参数名集+必填集,与 tools.ts 各 ToolDef input_schema 的 properties/required 同源——同源一致性由 tools.test.ts 对账钉扩到参数名级机检,名单同源三姊妹先例的纵深半边）,三判:①具名参数名不在合法集 → **error** 点名指路（报文带该工具全部合法参数名——"move 没有 src 参数,它的参数是 from/to"）;②必填参数缺席 → **error** 点名缺谁;③位置参数（无名实参）→ **error**（内置工具件恒具名调用,`move(a, b)` 形态运行期装 Record 全丢——B2 报文教 `move(from: a, to: b)` 形态）。三判只对签名表成员生效,表外调用走既有分档不受影响；在内置通知件名单（dingtalk_notify/notify 两件——两员来源各异:dingtalk_notify=tools-notify.ts 注册面 wire 名,notify=tools-composite.ts specs 表的渠道中立 tool_id 映射〔R10 review 纠源:原并称"tools-notify 注册面同源"对 notify 半边指错源〕;恒注册零声明,requires_commit 恒真而 commit body 直执是既定形态,0089 批 commit 档需认它们防误拒;同源一致性由 tools.test.ts 对账组第四行机检——姊妹三名单同款防线）→ 认得,不报；两份名单都不在 → 按步骤类型分档（2026-09-14 hopissues/0089 实撞升档——hopkb 侧 [commit] 步 body 写了不存在的 `run_shell`,B2 warn 放行后运行期被当"caller 会话工具"走 tool_request 外包,driver 回执 {ok:true} 未真执行,引擎报 completed:盘面零提交、产出变量装回执值,不可逆步动作真实性全程无闸——三批连撞）：**act/check 步 warn**（视为外部工具,运行期由 dispatcher 对照 `ToolProvider.list()` 确认,未知报 TOOL_EXEC_ERROR——caller 会话工具是合法场景,开放性保留;reason 步不列:其 AST 无 body 字段〔围栏是给读者的参考材料,P4 条款〕,B 系列校验入口只收 act/commit/check 三型——R10 review 抓原文"act/reason"空指 reason 漏 check 后改正）;**commit 步再核 Tools 段:`header.tools` 声明过 → warn 同 act 档**（放行理由分模式如实记——standalone 模式:init 期 reconcileTools 对账+运行期 provider 真身;复用模式:生产主通道无对账无 provider,放行理由=作者在 Tools 段显式声明即知情,tool_request 交 caller 是既定契约形态。另注 tool_id 别名缝隙:declaredTools 只认 header 声明名,reconcileTools 认 name∪tool_id 双名——B2 静态期拿不到注册面别名表〔V6 哲学〕,声明名与调用名须同名,现实面窄记录在案）,**未声明 → error 拒载**（不可逆步的野函数名=多半是把 subprocess.run 写成了别的名字,写时拦住指路:报文点名"要跑命令用 subprocess.run;要用外部工具先在 Tools 段声明"——静默流到运行期的代价是"把关全过、动作没做、账报做了"的谎报终态）。**fragment 模式例外:commit 档降 warn**（parseFragment 合成 header 恒无 tools——片段看不见整文的声明面,error 判据材料缺失;非 free 容器 replan 合法含 commit 且全量走 fragment 校验,按 error 拒是误杀合法 replan;报文注"片段无 header 声明面,整文验为准"——R10 review 抓判定面撕裂后补,豁免登记见 ^anc-rule-fragment-mode）。对齐 V6"不校验运行期信息"哲学。文件件此前漏列致 body 调 `write`/`read` 误报"非内置视为工具"warn——教学明列"恒可用零声明"而 validator 不认,每个新作者都付一次"这 warn 能不能留"的犹豫成本（2026-09-06 R3 抽测两路独立撞） ^anc-rule-b2
  - **subprocess.run 专项**（2026-08-30 二轮 review 补登记——B2 权威处原零字;追加时曾把上行锚挤成行中锚,审计抓后挪行）：具名参数集={input,timeout,cwd},白名单外具名(check/shell/env/capture_output 等)error 点名指路;位置参数恰一个(argv 列表),多位置 error——执行契约权威 [[act-body#^anc-exec-subprocess-run]],本处只登记规则存在
- B4：body 内变量引用（`VarRefExpr`）须可见——可见集 = 步骤 `←` 输入名 ∪ body 内此引用之前赋值的局部/输出名，**不含作用域链祖先变量**（与运行时 BodyInterpreter 严格对齐：它只灌 `ctx.inputs`，body 要用任何外部变量都必须 `←` 显式带入；此前实现误用全链可见集，祖先变量静态放行、运行时才炸"未定义变量"——2026-08-09 hopkb 实撞 S1 后收紧）。未定义引用 error。`if` 分支进入时各拷贝可见集（分支内局部变量不泄漏到分支外） ^anc-rule-b4
- B5：body 对步骤声明的 `+→` 输出，应有对应 `AssignStmt`（target=输出名）。声明 +→ 但 body 不写 → warn（对齐 P10 风格） ^anc-rule-b5
- B8：结构声明输出禁赋标量字面量（**error**——hopissues/0023,2026-08-24）：act/commit body 内对声明为 `yaml`/`[T]` 的 `+→` 输出字段赋**标量字面量**（字符串/数字/bool/None——LiteralExpr 四型全拦,含 if/elif/else 分支内）→ error,报文给改法（"空态写 `{}` 或 `[]`"）并带赋值行号。**为什么必须静态拦**：body 是确定性代码、字面量写在源文件里,`cur = ""` 对 `+ → cur: yaml` 必然违反运行期 checkValue（^anc-type-yaml-structured:结构化数据标量一律拒）——不用跑就可判;漏到运行期代价是乘法级（body 确定性重跑同值,SCHEMA_MISMATCH 转容器 retry 层层相乘——实撞:单子实例 64 次失配、11 子实例全灭、39 万 token 白烧零产出,根因埋 64 层重复日志而它是一行源码的类型说谎）。**只判字面量直赋**,变量/调用/表达式赋值静态不可知值形态归运行期 checkValue（实撞两处都是裸字面量——低成本覆盖真实病形）;局部变量（非声明输出）不拦（无类型声明无从违反） ^anc-rule-b8
- B6：判空形态 null-safety lint（**info 非阻断**——hopissues/0015 作者拍板 defense-in-depth 半边,2026-08-17）：**body 内与 case 条件内**（十九审——教学面'case 条件与 act body 同规',实装初版只挂 body walker,case 条件走 checkCaseCondition 独立路径 lint 不触发,教学与实装脱节;两路径同口径同报文）比较表达式命中 `<expr> != ""` 或 `<expr> == ""` 字面形态 → info 提示"对可能为 null 的字段不 null-safe（None != "" 为 True）,判空用裸真值 `if x:` 或 `len(x)==0`（概念规范钦定惯用形）"。**口径最窄**：仅这两个字面形态（空串字面量在任一侧）,`in`/`is None`/与非空串比较等一概不碰——`!= ""` 是合法运算符组合不拒,作者确知非 null 的用法收 info 噪声最小化;不改求值语义。实撞:gl-recon 6 breaks 全归因 mapping——reason 步 emit null,`None != ""` 判真误入非空分支,run 无 error 归因静默全错 ^anc-rule-b6

（编号跳过 B3：原拟"条件确定性"校验，但 hop_python 文法已排除自然语言/推理表达式，条件只能是确定性表达式，无需独立规则。保留编号位不复用。）

- B7（2026-08-22 随 `[act free]` 自由任务修饰新增,概念 [[../concepts/HopSpec V3核心规范#^anc-step-act]] free 档条款）：**act/commit 形态完备**——act 步骤要么带 hop_python body（机械档,执行期零 LLM）,要么标 `free` 修饰（自由任务档,执行者可推理可用工具）。**act 无 free 无 body = warn**（形态欠账:要么努力简化补 body,要么标 free 承认现状——warn 非 error:存量 41 处无 body act 平滑过渡,构建器新产物按新形态成文）;**有 free 又带 body = error**（两档互斥——标了 free 说明拆不开,又给 body 说明拆得开,自相矛盾）;free 挂 act 与 subtask 两宿主（2026-08-27 +subtask——到步展开档 ^anc-step-subtask-free:children 可空,S5 豁免;`SubtaskStep.free?: boolean`,serializer 写回 `[subtask free]`;commit/reason 等其余宿主标 free 走属性总闸拒——commit 不可作自由载体,reason 本身就是自由推理面）。**free×parallel 互斥**（B7 面,error——2026-08-27 三轮 review 实锤:traverse dispatch 门先于 expand 门,空 free parallel 被整棵派发成子实例,索计划请求落到孙进程 worker,规划方收不到;规划请求必须到达有规划权的 caller,worker 是哑执行者——消费方出现时再议放开）。**commit 无 body = error**（2026-08-31 作者宣布升级——2026-08-22 两拍『commit 必须带 body,error 级——同意』+『现阶段先 warn 兼容过渡』的到期兑现。升级依据=过渡期观察结果:三路排查实锤无 body commit 的 LLM 通道四缺陷叠加〔S1 零工具清单供给（渲染条件写死 act,写域口径行是生产不可达死代码）/S1b requires_commit 工具物理不可达（parser 禁 commit 声明工具+内置件全 basic,allowCommit 放行闸有闸无货——commit 核心意义在此通道断路）/S2 L5 打回轮喂虚构历史（commit 未执行过却收到"你上一轮的产出被打回"）/S2b SCHEMA_MISMATCH 算子重试=不可逆动作重放窗口（新轮 LLM 无前轮记忆重放工具,退火闸只防容器级管不到 done 前）〕——与其为一条本该退役的通道修四件,升 error 使其消费面归零。原则同 2026-08-22:不可逆动作最不能交给 LLM 现场发挥,发送什么/写到哪该生成期定死。存量四处无 body commit 同批补 body。error 报文指路:参数复杂就前置步骤备好参数,body 只做最后一调）。parser:attrs 表 act 收 `free`,`ActStep.free?: boolean`,serializer 写回 `[act free]`。 ^anc-rule-b7
- B9（2026-09-01 dr21 十七连跑实撞立规——写域错构建期全绿真机各烧一轮:act 建持久目录两处,第十二次步21/第十六次步32）：**act/check body 写域静态检**,error——act/check 步 body 里写侧工具调用（write/append/create/edit_file/makedirs/move/remove 七件,与运行时受控写侧名单同源——删除件注册名是 remove;edit_file 2026-09-06 review 补员:edit_file 批实装即走 write 同闸,B9 名单当批漏刷,同源承诺字面破半日;三名单〔B2/B9/B10〕与注册面的同源一致性由对账钉机检——tests 层对 DefaultToolProvider.list() 逐员核,2026-09-06 review 变异实锤名单成员级零保护后立）的 `path` 实参,形态为**字符串字面量**或**最左叶为字符串字面量的拼接表达式**且未被 `work_zone_path()` 包裹 → 报"act/check 步 body 的持久写盘归 [commit] 步骤承载,中间产物用 work_zone_path() 取路径"（与运行时闸 WORK_ZONE_ONLY〔tools#写域〕同口径——静态拦字面形态,变量/复杂表达式静态不求值留运行时闸,两层防线不互替不冒充全覆盖）。commit 步 body 豁免（写 workspace 是其本职）。静态可判性探针实证:AST 对 path 实参三形态可辨（literal/work_zone_path 包裹 call/var）,binary 拼接左端 literal 同可判。正反例:act 字面路径拒/act work_zone_path() 放行/commit 字面路径放行/act 变量路径放行（不误报——运行时闸兜）。 ^anc-rule-b9
- B10（2026-09-01 deep-validate 批立规,anchor-audit standalone 化九坑之坑 6 的读侧半边——body 文件工具字面绝对路径构建期全绿,真机撞沙箱"禁绝对路径"拒,0042 卡记同款实撞十一次;写侧六件已有 B9 先例,读侧三件此前无静态闸）：**body 读侧字面绝对路径静态检**,error——act/check/commit 步 body 里读侧工具调用（read/exists/listdir/search_file 四件,与运行时三级读权限链受控读侧名单同源——search_file 2026-09-06 review 补员:0070 批读侧扩员未盘姊妹条,body 写 search_file 字面绝对路径曾静态全绿真机才拒,恰是本规则立规要治的病形）的 `path` 实参,形态为**以 `/` 开头的字符串字面量**或**最左叶为此形态字面量的拼接表达式**且未被 `work_zone_path()` 包裹 → 报"文件工具路径一律 workspace 相对（沙箱禁绝对路径）——read/exists/listdir 的 path 写相对路径,实例涂鸦区用 work_zone_path() 取路径"（与运行时沙箱路径闸〔tools resolveWorkspacePath 禁绝对路径〕同口径互补——静态拦字面形态早失败,变量/复杂表达式静态不求值留运行时闸,两层防线不互替）。判定件复用 B9 同族形态判定（b9LeftmostLiteral 收窄到"字面量且以 / 开头"——B9 拦一切字面路径〔写域语义〕,B10 只拦绝对形态〔相对路径读侧完全合法〕,判据面不同不并条）。commit 步不豁免（读侧无"写 workspace 本职"对应物——绝对路径对 commit 的 read 同样必拒）。work_zone_path() 包裹豁免同 B9（其产物是合法绝对形态）。存量核对:examples//scripts//skills//driver/ 全库 body 零命中（2026-09-01 落规前实核）,零迁移。正反例:act body `read(path: "/Users/x/f.md")` 拒指路/相对路径 `read(path: ".anchor-audit/x.yaml")` 放行/`read(path: work_zone_path("f.md"))` 放行/变量路径放行（运行时闸兜）/commit body 绝对路径同拒。 ^anc-rule-b10

### 规则覆盖说明【说明】

54 条规则覆盖 5 个维度（2026-08-09：S13/S14 增、V3 废除；2026-09-01：V12/B9/B10 增；2026-09-04：S16 增；2026-09-05：V13 增）：
- **结构规则**（S1-S16）：16 条，确保 AST 基本结构合法
- **控制流规则**（C1-C8）：8 条，确保控制流语义正确
- **变量规则**（V1-V14）：11 条（V3 废除，编号位保留），确保变量引用和类型有效
- **特殊步骤规则**（P1-P15）：14 条（P2 废除，编号位保留）
- **act body 规则**（B1-B10）：9 条（B3 并入 B2，编号位保留），确保 hop_python body 合法与 act 形态完备

未穷尽但优先覆盖的场景（可在后续迭代添加）：
- loop 迭代变量覆盖的合法性验证（同名变量在迭代间延续的行为明确化）
- 跨 Spec call 的变量契约校验（需 callee spec 解析后才能验证，属于运行时检查）
- 循环复杂度上限（如最大嵌套深度、最大步骤数）
- 步骤摘要行长度限制（可读性建议，非正确性问题）

## parser-fuzz 穷举守卫【契约】 ^anc-meta-parser-fuzz

**为什么**：parser 的失效主形态是**静默吞**——输入行没被消费也没报错，直接消失（i18n 批五连撞:中文 Inputs 行/Types 段/[情形(其余)] 整行/内联标签段头/子串腐蚀,历史上 ^todo-parser-silent-swallow 同族）。每次都靠人工"覆盖面清单逐面核"事后抓,机械可判的面应升机检。同族先例 hoplog-fuzz（穷举 harness,§1d 特性专属守卫）。

**三不变量**（全部机械可判,scripts/parser-fuzz.mjs）：

1. **删行等价（无静默吞）**：对语料每份 spec 的每个非空行,删除该行重新 parse——AST（剥 source_location 归一）与 errors 集合**双双不变** = 该行是"惰性行"（存在与否零影响）。惰性行必须命中**白名单**（设计放行的形态）,否则即静默吞缺陷。白名单初始集：@trace 块行（%% 包裹）/非关键字 depth-2 标题（^anc-rule-surface-heading-flavor 明文放行的 ## Task 契约分区）**及其分区内散文**（分区语义=纯人读,整块惰性是契约本身）/纯分隔线。围栏标记行**不入白名单**——删围栏行改变 body 提取即非惰性,若测得惰性则是围栏配对宽容路径的真发现（首跑 12 条 `> ```` 孤行即此类,入基线待分诊而非放行）。白名单是**台账不是豁免阀**——每条挂设计出处,新增须记出处;
2. **双语等价（方案 B 机械核证）**：按术语表把英文 spec 的关键词逐 token 替换为中文（替换器在 fuzzer 内**独立实现**,不复用 parser 的别名表——同表核同表=自证）,两次 parse 的归一 AST 必须逐字段相等;
3. **往返投影稳定**：parse → serializeSpec → parse,**语义投影**相等。投影=header 各声明（名/类型/**Types 段 fields**）+ 步骤树（step_id/step_type/retry/adaptive/parallel/condition/forEach/collect/max_iterations/输入输出名表**含就地展开复合输出的 fields**/act body 围栏）——serializer 的"格式不保真"豁免（关键决策 4）只豁免排版,不豁免投影字段（v0.7.6 for-each 子句丢失即投影违约的实撞）。

4. **全半角变异等价（字符级,2026-08-15 作者拍板扩面）**：对语料每份 spec 的**结构字符位**逐个做半角→全角替换（`(→（`/`)→）`/`:→：`/`,→，`——中文输入法自然产物,中文关键词上线后中文作者第一脚踩的坑）,每个变异体 parse 后须**报错或结构不变**,静默劣化（步骤/声明消失且零报错）即缺陷。探针实锤:`[条件（x>0）]` 整步消失 steps=0 零报错/`标识：` Id 静默丢;
5. **崩溃安全（no-throw）**：全部变异体（删行/全半角/双语/往返中间产物）跑在 catch 下,parseSpec **对任意输入只报错不 throw**（标准 fuzzer 底线断言;Types/Config 段走 yamlLoad,js-yaml 会 throw——须证边界处捕获）。throw 即红,不入基线不豁免。

**覆盖率测量（fuzz 面盲区量化,2026-08-15 作者令'把覆盖率测量出来'+'必须核验分母'）**：`npm run fuzz:parser:cov`——V8 原生覆盖跑 fuzzer 全流程。**分母=目标面清单**（scripts/parser-fuzz-face.json,按 import 链逐文件核验定性,2026-08-15 实核——报告器视野=projectRoot/dist/ 前缀过滤共 7 文件,与清单 7=7 精确一致;js-yaml 等第三方经 node_modules 路径天然滤除）：

| 定性 | 文件 | 判据 |
|---|---|---|
| **target**（fuzz 责任面,数字=盲区量化） | parser.js / validator.js / ast-helpers.js | parseSpec/validateSpec/serializeSpec 主体与结构助手 |
| **partial**（部分在面,只有 parse/validate 消费的入口在面） | act-body-parser.js（围栏提取+表达式 parse 在面;解释器消费的求值路径不在）/ doc-ref.js（extractDocRefs 在面;checkDocRefExists 吃文件系统,fuzz 无 workspace 天然不触达） | 双消费面文件,fuzz 只走静态半边 |
| **out**（被动加载,函数体属执行期——fuzz 数字无语义） | act-builtins.js（validator 只查名单 ACT_BUILTIN_NAMES,函数体归 act-body-interpreter 执行期）/ tools.js（经 doc-ref import 链载入,沙箱读文件属执行期） | 名单/传递依赖,执行面归属单测+真机 |

**面外文件的覆盖归属必须核验非宣称**：报告器对 out/partial 文件**现场读 coverage/coverage-summary.json**（vitest 单测产物）打真实数字（如 act-builtins 95.6%/tools 100%）;产物缺席时明示"跑 check:coverage 取数"不打陈数。js-yaml 等第三方不入报告。报告仅展示不设阈值闸（理由同前:钉阈值=逼人塞语料凑数）。

**语料**：examples/ 全部可执行 spec——圈定判据与 chain-health G1 的 `hopjit list` **语义对齐但独立实现**（Id 行+Steps 段+parse 出步骤;不引 CLI——fuzzer 须只依赖 parser 产物独立可跑）+ 合成种子（fuzzer 内置:全中文 spec〔双语面〕/全特性英文 spec〔子句属性 case call 面〕/**六探底形态变异种子**〔Inputs 无冒号·裸词/Outputs 箭头误写/Steps 流浪行/坏编号/未知段头——已知盲区的常驻复现件,进基线台账钉住〕）。examples 扫描面空转 exit 2 显式失败（^anc-meta-guard-trust;种子恒在,判据打 examples 面防种子撑假绿）。

**运行档位**：独立命令 `npm run fuzz:parser`（手动/发版前/改 parser 后,不入 check:fast——穷举 O(行数×parse) 秒级但非改码必跑面）。**发现分级**：白名单外惰性行/双语不等价（AST 或 validate 规则码）/投影漂移/全半角劣化形态 = 基线比对,基线外新增 exit 1 红;**no-throw 违约恒红不入基线**（崩溃无『已知未修』资格）;白名单内命中 = 计数报告。全半角发现按**形态**（字符对）归组入基线,非站点级——121 站点=1 形态防台账淹没,修一形态销一组。**基线台账**：`audits/baselines/parser-fuzz-known.json` 记**已知未修**的静默吞形态（探底五真盲区先入账——修一个销一格,新增即红:与 anchor-baseline 棘轮同构,只许变好）。
