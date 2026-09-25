%% @trace
	id: hopjit-spec-ast
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-18T00:43+0800
	note: SpecAST 完整 TypeScript 类型定义——所有组件的数据模型依赖。内容分级（决策/契约/说明）
%%

# SpecAST 类型定义

SpecParser 的输出类型，也是 ExecutionEngine、PromptAssembler、StepDispatcher 的输入数据模型。定义所有 15 种 HopSpec 步骤类型、两种形态（有/无 Steps）、变量声明、头部字段。

共享的辅助类型（OutputDecl、StepSummary、RetryRecord、ErrorCode、SpecError）定义于 [[shared-types]]，本文件不重复。

## 定位【契约】 ^anc-struct-spec-ast

> **模块版本**：spec-ast `v0.10.2`（2026-08-31）。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
**① 自身定位**：spec-ast 模块是 HopJIT 的**类型契约层**——定义所有模块共享的数据模型（15 种 HopSpec 步骤、AST 结构、变量/头部声明、ActBody 表达式），以及 AST 上的纯谓词与常量。它是整条实现链的"公共词汇表"，被 parser/engine/prompt/dispatcher/cli 全员依赖。

**② 边界（负责什么 / 不碰什么）**：
- **负责**：类型定义（AST/Step/ActBody）、AST 谓词函数（`isContainerStep`/`hasChildren`/`getChildren`）、跨模块常量（`DEFLATE_THRESHOLD`/`HUMAN_PREVIEW_THRESHOLD`/STEP_TYPE 集合）。
- **不碰**：任何运行时行为、I/O、状态——纯声明 + 纯函数谓词，无副作用。CLI 响应类型、Provider 接口、Config、内部运行时类型虽也在 `types.ts` 物理文件里，但**按稳定性分属不同子文件**（见下），spec-ast 模块只认 AST 与其谓词常量。

**③ src 文件构成（types.ts 按稳定性拆分）**：`types.ts` 是 god-types，按稳定性拆为多个子文件，`types.ts` 保留为 `export *` barrel（import 路径不变）：

| 子文件 | 内容 | 稳定性 | 归属模块 |
|---|---|---|---|
| `ast-types.ts` | SpecAST/SpecHeader/14 Step/StepNode/ActBody/表达式/DocRef | 最稳（语言身份） | **spec-ast** |
| `ast-helpers.ts` | isContainerStep/hasChildren/getChildren + DEFLATE/HUMAN 常量 + STEP_TYPE 集合 | 逻辑（非类型） | **spec-ast** |
| `cli-types.ts` | InitResponse/NextResponse/StepReady/ParallelReady/ExecutionPaused/各 Response | 对外稳定面 | hop-cli/shared |
| `provider-types.ts` | Tool/Knowledge/Identity/Spec/PersistenceProvider + HostConfig/SandboxConfig/ResourceLimits/ModelEngine | 宿主契约 | shared |
| `runtime-types.ts` | ExecEvent/StepFailRecord/RetryRecord/AssembledContext/StateFile/VarsFile/EngineSnapshot/Checkpoint | 内部（随实现变） | exec-engine |
| `errors.ts` | ErrorCode/SpecError/ParseError/ValidationError/ValidationSeverity | 中稳 | shared |
> 拆分动机：原 `types.ts` 把 5 类稳定性截然不同的契约塞一处（AST 最稳 vs AssembledContext 天天变），违反「模块=单一稳定性的封闭子域」（`^anc-meta-module-spec`）。拆分后各子文件稳定性内聚。
>
> **barrel 已删除**（原 `types.ts` = `export *` 全库 barrel，已于依赖显形改造中删除）：barrel 把 5 模块类型混在一个转发点、掩盖真实跨模块依赖（所有 `from './types.js'` 被误算依赖 spec-ast）。现各文件从真实定义子文件直接 import。
>
> 上表中 cli-types/provider-types/runtime-types/errors **物理在 src/ 但归属别的模块**（hop-cli/shared-providers/exec-engine/shared-errors），仅 ast-types + ast-helpers 属 spec-ast。

**对外接口清单【封闭】** ^anc-struct-spec-ast-exports：

> 本表是 spec-ast 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `ast-types.ts`（AST 类型契约）/ `ast-helpers.ts`（谓词 + 常量）/ `ast-runtime.ts`（语言运行时基础能力：变量存储/作用域定位/真值语义）/ `spec-tree-edit.ts`（AST 级树编辑核心——2026-08-30 函数化批归属定 spec-ast〔纯 AST 操作与 ast-helpers 同性质〕,出口面 2026-08-31 补登:归属改定时漏登出口清单,tools/dispatcher 的合法深入 import 被边界守卫误报）。
>
> spec-ast 是全库"公共词汇表 + 语言运行时基础"，被 parser/engine/prompt/dispatcher/cli 全员依赖，故对外面大且稳定。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途 | 稳定性 |
|---|---|---|---|---|
| `SpecAST` / `SpecHeader` / `SpecConfig` / `TypeDecl` / `VarDecl` / `VarBinding` / `OutputDecl` / `ParamMapping` / `SourceLocation` / `ToolNeed` | 类型 | ast-types.ts | AST 顶层结构 + 声明（ToolNeed=Tools 段工具需求条目,^anc-rule-tools-section） | stable |
| `StepNode` / `StepType` / `ExecutableStepType` / `StructuralStepType` / `BaseStep` | 类型 | ast-types.ts | 步骤联合的判别基座 | stable |
| `ReasonStep` / `ActStep` / `CheckStep` / `ConfirmStep` / `AskStep` / `CommitStep` / `CallStep` | 类型 | ast-types.ts | 7 可执行步骤类型 | stable |
| `SubtaskStep` / `LoopStep` / `BranchStep` / `CaseStep` / `BreakStep` / `ContinueStep` / `ExitStep` | 类型 | ast-types.ts | 7 结构/控制流步骤类型 | stable |
| `ParallelStep` | 类型 | ast-types.ts | parallel 标注 subtask 的收窄别名 `SubtaskStep & {parallel: true}`（engine/engine-traverse/parser/validator 类型收窄用——原独立步骤类型 2026-08-07 退役,统一模型 P0.5 复活为别名形态） | stable |
| `isParallelContainer` / `getForEach` | 函数 | ast-helpers.ts | parallel 容器谓词 + for-each 子句取值（engine/engine-traverse/validator/cli 判派发形态共用判据） | stable |
| `ActBody` / `ActStatement` / `ActExpr` / `AssignStmt` / `CallStmt` / `IfStmt` / `BinaryExpr` / `BinaryOp` / `CallExpr` / `CallArg` 等 | 类型 | ast-types.ts | hop_python AST（act-body/validator 消费） | stable |
| `DocRef` / `DocRefFragment` | 类型 | ast-types.ts | doc-ref 引用/片段结构 | stable |
| `ResponseOption` / `StepSummary` | 类型 | ast-types.ts | 辅助类型（confirm 选项 / replan 摘要） | stable |
| `hasChildren` / `getChildren` / `isContainerStep` / `getParentStepId` | 函数 | ast-helpers.ts | AST 谓词 + step_id 寻址（全员消费） | stable |
| `isUpdateModeOutput` | 函数 | ast-helpers.ts | 判某输出是否"更新模式"（步骤同时 `← X` 且 `+ → X`，读入即输出更新既有变量）——engine failStep 跳过 null 化 / check 失败写回 / validator V3 放行遮蔽共用同一判据，抽此消重（^anc-exec-failstep-skip-update / ^anc-rule-v3） | stable |
| `EXECUTABLE_STEP_TYPES` / `STRUCTURAL_STEP_TYPES` / `CONTAINER_STEP_TYPES` / `ALL_STEP_TYPES` | 常量 | ast-helpers.ts | 步骤类型集合（parser/validator/engine 判类） | stable |
| `formatTypeDecl` / `collectTypeDeclClosure` | 函数 | ast-helpers.ts | TypeDecl 字段级序列化+闭包收集（prompt L1 Types 段与 SCHEMA_MISMATCH 反馈两消费点单源——0017:生成/反馈/校验三面同一份契约） | provisional |
| `DEFLATE_THRESHOLD` / `HUMAN_PREVIEW_THRESHOLD` / `INLINE_PREVIEW_MAX` | 常量 | ast-helpers.ts | 大内容阈值（engine/prompt deflate 判定;INLINE_PREVIEW_MAX=inline 通道预览限额,^anc-exec-llm-inline-context 两个使用点 prompt/doc-ref 共用;v3 起只对下发面含 read 的步骤生效） | stable |
| `DEFAULT_EXPANSION_MAX` | 常量 | ast-types.ts | subtask free 展开熔断缺省（engine/validator 双侧同源——dff2cb7 批迁入与 SpecConfig 同居,清单漏登 0830 review 补） | stable |
| `VariableStore` / `VariableScope` / `StepStatus` | 类/类型 | ast-runtime.ts | 变量存储（扁平命名空间语义;scope 树仅作 for-each 收集缓冲与 vars.json v2 存储基质）+ 步骤状态（engine/prompt 消费） | stable |
| `buildStepMap` | 函数 | ast-runtime.ts | step_id→StepNode 反查表构建（**纯函数,2026-08-14 随 run 隔离不变量去缓存**——原模块顶层 `let _stepMapCache` 是"run 级缓存住进程级槽"的违反面〔权威 [[../ARCHITECTURE#^anc-run-isolation]]〕:多 run 互踢命中率归零,且是全库唯一可变模块全局、被仿写即正确性 bug;缓存归属改引擎实例持有） | stable |
| `isTerminalStatus` | 函数 | ast-runtime.ts | **单点定义终态集合**（done/failed/skipped）——engine/engine-traverse 多处判据复用，新增终态只改这里。与 `StepStatus` 配套（2026-08-01 补登：清单原列了 StepStatus 却漏了这个配套谓词） | stable |
| `insertNodeAt` / `replaceNodeAt` / `replaceChildrenAt` / `deleteNodeAt` / `renumberSteps` / `syncWorkItems` | 函数 | spec-tree-edit.ts | AST 级树编辑核心（tools 工具壳与 dispatcher replan 拼装共用——契约权威 [[tools/spec-tree-tools#^anc-exec-builtin-edit-tree-tool]] 两层结构第一层） | provisional |
| `findNodeByPath` / `findParentListByPath` / `TreeEditOutcome` | 函数/类型 | spec-tree-edit.ts | 树定位原语与结果二态（核心函数内部使用,亦为公开出口供测试直用） | provisional |
| `getWriteScope` | 函数 | ast-runtime.ts | 恒返回 'root'（2026-08-09 扁平命名空间重构;签名保留因调用面广） | stable |
| `isTruthy` | 函数 | ast-runtime.ts | HopSpec 条件真值语义（engine/act-body 消费） | stable |
| `buildStepMap` / `SCOPE_CREATING_TYPES` | 函数/常量 | ast-runtime.ts | step_id 反查表 + 作用域容器类型集（engine-traverse 消费） | provisional |

> **内部（表外即内部）**：`ValueTypeString`（值类型字符串字面量，暂无跨模块 import）、`LiteralExpr`/`VarRefExpr`/`FieldAccessExpr`/`UnaryExpr` 等表达式子类型（经 ActExpr 联合暴露，不单独 import）。
>
> **迁移注（2026-07-02）**：`VariableStore`/`StepStatus`/`getWriteScope`/`isTruthy`/`buildStepMap`/`SCOPE_CREATING_TYPES` 原在 exec-engine 的 engine-vars.ts/engine-traverse.ts,因被 prompt/act-body 多方跨模块调用(非引擎私有)、且只依赖 spec-ast 自身,归位到 spec-ast 的 ast-runtime.ts。
>
> engine-vars.ts 已删除,engine-traverse.ts 瘦身为纯引擎私有遍历(对 exec-engine 外零符号)。

## 文档结构与内容分级

本文档是 HopSpec 的纯数据模型定义，主体是带锚点的类型契约。内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择（多个合法选项中选一） | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的类型/字段约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 序列化约定、引用关系、约束表、示例 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 关键决策 · 步骤类型二分 | 决策 | — |
| 关键决策 · step_id 层级数字编码 | 决策 | — |
| 关键决策 · discriminated union by step_type | 决策 | — |
| 关键决策 · v1 类型校验策略 | 决策 | — |
| 顶层结构 | 契约 | `anc-ast-spec-ast` / `anc-ast-spec-structure` |
| SpecHeader | 契约 | `anc-ast-spec-header` / `anc-type-type-decl` |
| StepType 联合类型 | 契约 | `anc-ast-step-type` |
| BaseStep | 契约 | `anc-ast-base-step` / `anc-exec-model-annotation` |
| 7 种可执行步骤 | 契约 | `anc-ast-executable-steps`（组标题）/ `anc-step-reason` / `anc-step-act` / `anc-step-act-sandbox-constraint` / `anc-step-check` / `anc-step-check-finally` / `anc-step-confirm` / `anc-step-ask` / `anc-step-commit` / `anc-step-call` / `anc-step-call-literal`（字面量映射项） |
| act body AST | 契约 | `anc-ast-act-body` |
| 8 种结构/控制流步骤 + parallel 属性 | 契约 | `anc-ast-structural-steps`（组标题）/ `anc-step-branch` / `anc-step-subtask` / `anc-step-parallel`（属性，落 Subtask/Loop 字段） / `anc-step-loop` / `anc-step-case` / `anc-step-break` / `anc-step-continue` / `anc-step-exit` / `anc-step-on-fail` |
| 步骤节点联合类型 | 契约 | — |
| 容器步骤的 children 约束 | 说明 | — |
| 已修正记录：StepSummary.step_type | 说明 | — |
| 与 shared-types 的类型引用关系 | 说明 | — |
| 序列化约定 | 说明 | — |

---

## 关键决策【决策】

本节集中记录数据模型层四个不可推演的人为决策——每一个都在多个合法选项中选定其一，下游设计与代码必须遵从。

### 决策一：步骤类型二分（6 可执行 + 8 结构）

将 15 种 HopSpec 步骤切成两类：

- **6 种 ExecutableStepType**（`reason`/`act`/`check`/`confirm`/`commit`/`call`）——由 StepDispatcher 分派、直接调 LLM API 执行。
- **8 种 StructuralStepType**（`subtask`/`parallel`/`loop`/`branch`/`case`/`break`/`continue`/`exit`）——由 ExecutionEngine 内部解析展开，不直接出现在交给 LLM 执行的 `StepReady.step_type` 中。

**为何拍板**：另一合法选项是"全部 15 种一视同仁交给 dispatcher"。选择二分，是因为结构/控制流是 Engine 的职责（展开 children、选择 next_step、评估 branch 条件），不应消耗一次 LLM 调用。`StepReady.step_type` 因此被收窄为仅 6 个可执行值——分支决策若需 LLM 推理，必须在 branch 前置 reason 步骤产出分类变量。该二分直接决定了 `StepType` 的子类型划分（见下文「StepType 联合类型」章节）。

### 决策二：step_id 用层级数字编码

`step_id` 采用 `"1.2.3"` 形式的层级点分数字编码，而非 UUID 或自增整数。

**为何拍板**：UUID 不可读、无法表达父子层级；自增整数无法体现树结构。点分编码让 step_id 自身携带嵌套位置信息（`"4.1.2"` 即第 4 步 loop 体内第 1 个 parallel 的第 2 个分支），日志、卫星文件命名、断点恢复全部可直接以 step_id 寻址。代价是 replan 改写 children 时需重编号，由 Engine 负责维护。

### 决策三：TypeScript discriminated union（按 step_type 判别）

StepNode 定义为 TypeScript 的判别联合（discriminated union），判别字段统一为 `step_type`。

**为何拍板**：另一合法选项是单一 `Step` 接口 + 可选字段全集（所有步骤共用一个宽接口）。选择判别联合，是因为它在编译期即可按 `step_type` 字面量自动收窄类型——访问 `CallStep.callee_spec_id` 或 `LoopStep.max_iterations` 时类型安全，宽接口则全是可选字段、无法静态保证。这要求每个 step 接口的 `step_type` 字段为字面量类型（`step_type: 'reason'` 而非 `StepType`）。

### 决策四：v1 类型校验策略（基础类型查值 + TypeDecl 仅查字段名）

v1 的 `output_schema` 与变量类型校验采取分层策略：

- **基础类型**（`text`/`bool`/`line`/`number`/`[line]`）做值类型检查。
- **enum(...)** 做值是否属于枚举成员的检查。
- **自定义 TypeDecl** 仅验证字段名存在性（`Record.keys` 子集检查），**不做递归类型匹配**；fields 值为自定义类型名时视同 `any`。
- **ParamMapping** 的 from/to **不做类型匹配**（validator V6 仅检查 from/to 非空，不校验变量存在性）。

**为何拍板**：完整递归类型校验是另一合法选项，但 v1 选择放弃。原因是 LLM 产出的值经 JSON 序列化可透传任意类型，跨类型传递（如 caller `number` → callee `text`）不会崩溃，只是 callee 侧 LLM 收到的值可能与预期类型不符。v1 优先保证不误杀、不崩溃；完整递归类型校验留待 v2+。该决策的具体落点见下文「SpecHeader」章节的 TypeDecl 注释与「6 种可执行步骤」章节 CallStep 的 ParamMapping 注释。

---

## 顶层结构【契约】 ^anc-ast-spec-structure

SpecAST 是 Spec markdown 解析后的完整抽象语法树根节点 ^anc-ast-spec-ast

```
struct: SpecAST
  Id: spec-ast
  Fields:
    - header: SpecHeader             # Spec 头部字段结构
    - steps: [StepNode]              # 可选。步骤树；缺省 = 能力声明形态（无 Steps 段）
```

（TS 形态是代码层投影，在 src/ast-types.ts——设计以本 HopType 为准。）

两种形态：
- **能力声明**（无 Steps）：仅 header，用于被 call 的 Spec 声明其契约（Inputs/Outputs/Constraints）
- **完整执行规约**（有 Steps）：header + steps 树，可直接执行

---

## SpecHeader【契约】 ^anc-ast-spec-header

```
struct: SpecHeader
  Id: spec-header
  Fields:
    - title: line                    # Spec 标题（首个 # heading）
    - id: line                       # 可选。Spec 标识符
    - signature: line                # 可选。Id 行可选函数签名原文 `func(in...) -> out...`（S14 校验按名对应 Inputs/Outputs；serializer 原样回写。2026-08-09 作者定）
    - goal: text                     # 可选。## Goal 段文本
    - constraints: [line]            # 可选。## Constraints 段，每条约束一行
    - types: [TypeDecl]              # 可选。## Types 段定义的结构体
    - inputs: [VarDecl]              # 可选。## Inputs 段，外部调用者传入
    - outputs: [OutputDecl]          # 可选。## Outputs 段（OutputDecl 定义见 shared-types）
    - config: SpecConfig             # 可选。## Config 段
    - doc_refs: [DocRef]             # 可选。doc-ref 提取落点（spec-parser ^anc-rule-doc-ref-extract 权威,本块补同步）

struct: TypeDecl
  Id: type-decl
  Fields:
    - name: line                     # 类型名
    - fields: yaml                   # field_name → 类型字符串的字典（"text" | "bool" | "line" | "number" | "enum(...)" | "markdown" | "yaml" | "prompt" 等）

struct: VarDecl
  Id: var-decl
  Fields:
    - name: line                     # 变量名
    - type: line                     # 基础类型（ValueTypeString，定义见 shared-types）或自定义 TypeDecl 名
    - description: line              # 可选。# 注释

struct: SpecConfig
  Id: spec-config
  Fields:
    - max_depth: number              # 可选。call 深度限制，默认 10（声明在场,运行时零消费——随将来需求再接,教学面勿列）
    - max_retries: number            # 可选。全局 retry 上限，默认 3（同上,零消费）
    - model: line                    # 可选。Spec 级默认模型（格式: service/model，覆盖全局 ModelEngine.default）
    - models: yaml                   # 可选。按步骤类别分档路由（reason/act/check/commit 各可指一档;权威 [[step-dispatcher#^anc-exec-model-routing]]）
    - expansion_max: number          # 可选。subtask free 展开总数上限（缺省 20;权威 [[exec-engine]] ^anc-exec-subtask-free-expand 契约7）
    - engine_min_version: line       # 可选。引擎最低版本闸（权威 [[exec-engine#^anc-exec-engine-min-version-gate]]）
    - requires_commands: [line]      # 可选。body 依赖的本地命令声明（权威 [[exec-engine#^anc-exec-requires-commands-gate]]）
    - ...: yaml                      # 扩展配置项（任意键，值型 unknown）
```

**引擎消费键清单同源【契约】**（2026-09-15 作者抓工程链脱节后立——expansion_max/engine_min_version/requires_commands 三个键先后落到设计+代码+测试三层而概念层零条款,半个多月无人发现;病根:Config 扩展键经索引签名消费,加键零编译约束,概念层是否记载纯靠人自觉）：

- **单一事实源**：`src/ast-types.ts` 导出常量 `ENGINE_CONFIG_KEYS`——引擎真消费的 Config 键全清单（新增引擎消费键必须入列;声明在场但零消费的键〔max_depth/max_retries〕不入列不入教学面）;
- **守卫双向核**（tests/config-keys-doc-sync.test.ts,npm test 内常驻）：
  - ①清单→文档:清单每键在概念层语法参考的记载面在场——判据是**名字边界正则**（键名前后都不是标识符字符才算在场,防 model 被 models 的记载子串吞并假绿——立守卫批阅卷实锤裸子串判在 model 键上实质失效后改定;从宽面保留:不限定出现位置与包裹形态,记载质量归语义审计）,缺即红点名键与文件;
  - ②代码→清单:扫 src/*.ts 的 `config?.['键']`/`specConfig?.['键']` 索引消费形态（键名限 ASCII 标识符——注释里的中文示例字样不是真键）,提取键不在清单即红——经索引通道加新消费键,不登清单+不写概念层就过不了机检;
  - **扫描面边界如实记**:具名字段属性访问（如 `specConfig?.model`）不在扫描面——具名字段有 tsc 管类型,概念层记载靠"入清单三件同批"纪律与本条①兜（新键若加成 SpecConfig 具名字段走属性访问,②的机检承诺不覆盖它）;上方 struct 把五消费键都列成具名字段是**文档视图**,TS 接口实况是 model/max_depth/max_retries/expansion_max 四个具名+其余走索引签名——struct 按语义完整列,TS 按消费通道选形态,两者不同步是设计使然;
- **为什么钉概念层不钉设计层**：设计先行有 check-design-first 机检守,历次批次设计层从未漏;脱节恒发生在概念层（受控快照,误解为"只有 vault 演进才动"）——守卫对准实际出血点。 ^anc-ast-config-keys-doc-sync

TypeDecl 的 v1 output_schema 校验策略（见关键决策四）：基础类型（text/bool/line/number/[line]）做值类型检查；enum(...) 做值属于枚举成员检查；自定义 TypeDecl 仅验证字段名存在性（fields 键子集检查），不做递归类型匹配。v1 不支持嵌套 TypeDecl 引用校验：fields 值为自定义类型名时（如 "AddressType"），v1 不递归解析，视同 any。v2+ 可引入完整的递归类型校验。

enum 格式规范：`enum(member1,member2,...)` — 括号内逗号分隔，成员为不含逗号/括号的字符串，前后空格由解析器 trim。示例：`enum(low,medium,high)`、`enum(approve,reject,revise)`

TypeDecl 定义 Types 段的复用结构体（名称+字段字典+逐字段说明），v1 仅校验字段名存在性 ^anc-type-type-decl

**字段说明随声明入 AST，按接收端分流供给（2026-08-27 作者定"jit 执行不需要 # 注释，llm 执行需要"——fact-check review 实撞：作者按宪法给 CheckPoint.premises 写了字段语义注释，parser 静默丢弃，执行 LLM 收到的 Types 渲染只有 `premises:text` 干条目，字段纪律供给面蒸发；与 Tools 段 params/notes 不进 prompt 同族〔todo/0027②〕）**：

- **结构**：`TypeDecl.field_descriptions?: Record<string, string>`（字段名→`#` 注释原文；类型级注释入 `description?: string`）——与 `fields` 平行的可选字典，无注释的字段缺席；
- **parser**：Types 段字段行 `- name: type  # 说明` 的注释剥出存入（原样保留，不截断）；serializeSpec 回写带注释（往返不丢——注释是声明的一部分）；
- **LLM 消费面带注释**：formatTypeDecl 渲染逐字段附说明（prompt L1 Types 段 / subtask 输出闭包 / SCHEMA_MISMATCH 反馈三消费点同源自动受益——0017"生成/反馈/校验三面同一份契约"不变）；
- **JIT 面照旧零消费**：body 解释器/validator 类型校验只认 `fields` 的类型词——注释不参与任何机器判定（说明是给 LLM 与人的，机器面语义零变化）。

---

## StepType 联合类型【契约】 ^anc-ast-step-type

由关键决策一（步骤类型二分）推演：`StepType` 拆为 ExecutableStepType 与 StructuralStepType 两个子集。

三个类型均为枚举/联合，不是 struct：

- **ExecutableStepType**——7 种可执行类型（由 StepDispatcher.execute_step 分派/复用模式交 caller），枚举值：`reason` / `act` / `check` / `confirm` / `ask` / `commit` / `call`
- **StructuralStepType**——7 种结构/控制流类型（由 ExecutionEngine 内部解析，不出现在 StepReady.step_type 中；parallel 已于 2026-08-07 降为 subtask/loop 的属性，不再是类型），枚举值：`subtask` / `loop` / `branch` / `case` / `break` / `continue` / `exit`
- **StepType** = ExecutableStepType ∪ StructuralStepType，全部 15 种
（本块 2026-08-08 语义审计两次修正：原文 6+8=14 漏 ask 且未随 parallel 降属性更新；7+7=**14** 为终值——"13 种"系重构时在漏 ask 的旧数上 −1 所得，作者已确认更正。）

可执行与结构的分界：`StepReady.step_type` 仅包含 `ExecutableStepType`（7 个值）。Engine 遇到 structural 类型（含 branch）时自动展开 children 或将合适的 child 推到 `next_step`。branch 步骤由 Engine 内部评估 case 条件并选择匹配的 case，不需要 LLM 推理——如果分支决策需要 LLM 推理，应在 branch 前置一个 reason 步骤产出分类变量。

---

## 步骤节点

### BaseStep — 所有步骤的公共字段【契约】 ^anc-ast-base-step

由关键决策二（step_id 层级数字编码）推演：`step_id` 为点分层级字符串。由关键决策三（discriminated union）推演：`step_type` 为判别字段，各子接口将其收窄为字面量。

```
struct: BaseStep
  Id: base-step
  Fields:
    - step_id: line                  # 层级编码，如 "1.2.3"
    - step_type: line                # 步骤类型判别字段，取值 ∈ StepType 全部 15 种
    - summary: line                  # 摘要行（不含 [type] 标记和 ←/+/→）
    - inputs: [VarBinding]           # 可选。← 输入绑定
    - outputs: [OutputDecl]          # 可选。+ → 输出声明（OutputDecl 定义见 shared-types）
    - instruction: text              # 可选。> 执行说明（多行合并，@model 标注已提取移除）
    - model_override: line           # 可选。@model 标注提取值（格式: service/model） ^anc-exec-model-annotation
    - thinking_override: line   # 可选。@thinking 步骤标注(on|off)——单步思考开关,五级链第 2 级;解析与 serialize 往返同 @model 通道。权威 [[step-dispatcher#^anc-exec-thinking-step-annotation]]（2026-09-20 review 批补登——struct 唯一定义处漏字段同型病第四犯后堵）
    - src_ref: line                  # 可选。@src 源锚点（翻译自上游文档哪一处——纯追溯零执行语义 ^anc-step-src-annotation）
    - source_location: SourceLocation  # 可选。markdown 原文位置（错误报告用）
    - doc_refs: [DocRef]             # 可选。doc-ref 提取落点（spec-parser ^anc-rule-doc-ref-extract 权威,本块补同步）

struct: VarBinding
  Id: var-binding
  Fields:
    - name: line                     # 变量名
    - source: line                   # 引用来源（变量名，与 name 同值）
    - synthesized: bool              # 可选。parser 从 for-each 子句合成的消费边（非作者书写，V9 据此辨冗余）

struct: SourceLocation
  Id: source-location
  Fields:
    - line_start: number             # 原文起始行号
    - line_end: number               # 原文结束行号
```

### 6 种可执行步骤【契约】 ^anc-ast-executable-steps

本组对应 ExecutableStepType（关键决策一）——由 StepDispatcher 分派、直接调 LLM API 执行。组级共性：每个接口将 `step_type` 收窄为字面量（关键决策三）；语义约束（沙箱、commit 兜底等）以注释附在各接口处。

```
struct: ReasonStep ^anc-step-reason
  Id: step-reason
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'reason'
    # 无额外字段——推理上下文完全由 PromptAssembler 组装

struct: ActStep ^anc-step-act
  Id: step-act
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'act'
    - body: ActBody                  # 可选。```hop_python 围栏解析所得的结构化 body（见 ^anc-ast-act-body）；省略=无结构化 body，执行回退自然语言 instruction
    # 语义约束：act 步骤无不可逆副作用，写操作限于 workspace 内。
    # requires_commit=true 的工具在 act 步骤中被 StepDispatcher 自动拦截。
    # 沙箱外的写/删/移动必须用 commit 步骤，由 Spec 流程保障安全性。

struct: CheckStep ^anc-step-check
  Id: step-check
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'check'
    - is_finally: bool               # 可选。[check final] 变体（旧写法 finally 兼容读将废止）：Constraints 的可执行化身，adaptive 不可改写或跳过 ^anc-step-check-finally
    - body: ActBody                  # 可选（2026-08-19 作者拍板 A,概念 ^anc-step-check-body）。纯机械判定的 hop_python body——与 act 同文法同解释器,body 直赋两槽变量,引擎消化零 LLM;省略=LLM 判（语义面核验正当形态）。原静默面收口:此前 check 里写围栏滑进 instruction 变提示词,两头不占
    # 验证上下文由 PromptAssembler.assemble_check_context 组装
    # 固定输出签名（封闭）：outputs 必须恰好为 bool（判定槽）+ text（说明槽）两项，由 P11 强制
    # （[[spec-parser#^anc-rule-p11]]）。引擎按类型定位 bool 槽判通过/失败、text 槽作失败说明
    # （[[exec-engine#^anc-exec-check-verdict]]）。槽经 outputs[].type 区分，与用户变量名无关。

struct: ConfirmStep ^anc-step-confirm
  Id: step-confirm
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'confirm'
    - require_human: bool            # 可选。true=必须人工确认，false/省略=Caller可代确认
    - response_options: [ResponseOption]  # 可选。审批选项（缺省 approve/reject）
    # ResponseOption 定义见 shared-types.md（此处为就近引用，权威定义在 shared-types）
    # 纯审批闸门：+→ 仅允许 bool（approve→true / reject→全局中止）。要 caller 提供业务数据用 AskStep

struct: AskStep ^anc-step-ask
  Id: step-ask
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'ask'
    - require_human: bool            # 可选。true=必须真人提供数据
    - present_inputs: [line]         # 可选。必须完整展示给 user 的变量名子集（必须 ⊆ ← inputs，P14 校验，见 [[spec-parser#^anc-rule-p14]]）
    # CITL 数据收集：- ← 声明候选/推断来源，+→ 声明要 caller 提供的数据（任意类型）
    # 与 confirm 正交：confirm 答"批不批"，ask 答"值是什么"
    # answer 直接落到 +→ 声明的变量名，无 reject 全局中止语义
    # paused 返回自包含介入请求（question/output_schema/default_value/options/present_inputs），
    # 见 ^anc-exec-hitl-presentation。present_inputs 由配套运行时 driver 承诺完整 dump（不缩略）

struct: CommitStep ^anc-step-commit
  Id: step-commit
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'commit'
    - irreversible_action: line      # 不可逆操作描述（从 > 指令提取）
    - body: ActBody                  # 可选。与 act 同源：commit body 复用 ActBody（见 ^anc-ast-act-body），执行差别仅 requires_commit 工具放行 + 不可逆不可重试
    # commit 本身不内嵌 confirm——Spec 作者可选择在 commit 前显式放置 confirm 步骤来保护
    # 验证规则 P8：retry/adaptive subtask 内含 commit 时，必须有 confirm 兜底

struct: CallStep ^anc-step-call
  Id: step-call
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'call'
    - callee_spec_id: line           # 可选。被调用 Spec 的 ID（解析自 "[call] spec_id : summary"，Spec 库/注册表查找）
    - param_mapping: [ParamMapping]  # 可选。输入映射：from=父变量, to=子 Input 名（- ← 子参数: 父变量）
    - output_mapping: [ParamMapping] # 可选。输出映射：from=子 Output 名, to=父变量名（+ → 父变量: 子输出）
    - parallel: bool                 # 可选。callee 并发申报转述（统一模型 2026-08-11 P0）：异步派发、宿主 loop 边界收齐。见 [[parallel-execution#^anc-exec-parallel-dispatch-model]]

struct: ParamMapping
  Id: param-mapping
  Fields:
    - from: line                     # 来源变量名（字面量项=作者原文,如 `"seq"`——序列化回写用）
    - to: line                       # 目标变量名
    - literal_value: yaml            # 可选。在场即字面量项:解析后的运行时值(字符串/数字/bool/null),引擎直传不查父变量。缺席=变量映射(既有语义)
```

ParamMapping 的双向映射语法对称（目标: 来源，同名省略），引擎在父子变量空间间自动搬运。v1 不做 from/to 的类型匹配校验（见关键决策四；validator V6 仅检查 from/to 非空）。跨类型传递（如 caller number → callee text）静默通过——JSON 序列化可透传任意类型，callee 侧 LLM 收到的值可能与预期类型不符，但不会崩溃。v2+ 可加类型兼容性检查。

**字面量映射项【契约】（2026-08-27 作者拍板 A，hopissues/hoplogic3/0044——原实装只映射父变量，`split_kind: "seq"` 的 `"seq"` 被当作不存在的父变量静默丢弃，子实例拿 None）**：param_mapping 值位（`from` 位）写字面量时，命中即在映射项上落 `literal_value`（解析后的运行时值）并保留 `from` 原文（序列化回写作者写法）。

- **判定面 = 封闭枚举**：同型引号成对字符串（`"seq"`/`'seq'`）、数字（`-?\d+(\.\d+)?`）、严格小写 `true`/`false`/`null`——三正则在 parser（paramMappingEntry）与 V6 output 闸两处逐字同，不许漂移；
- 命中项的**值解析**复用 parseInitValue 单点（判定与解析分工：判定面是映射位自己的封闭枚举，比 `= 初值` 窄——对象/列表 `{}`/`[]` 与大写 `True`/`None` 不入映射字面量，前者前置步骤装配后传变量，后者按裸词=变量名走缺失语义。review 实抓初版判定用 /i 宽容：`True` 过判定但 parseInitValue 只认小写跌字符串分支，literal_value 得字符串 `"True"`——静默转字符串正是本条款禁止的病形）；
- **裸词恒为变量名**——`mode: seq` 是变量映射，永不猜成字符串（静默转字符串=另一种静默错误：变量名打错本该按缺失语义拒，转字符串会带病通过）；
- 映射串切分引号感知且**双入口**（`[call id(...)]` 行内与旧形态 `- ←` 行同经 splitMappingSegments，`"a, b"` 不被逗号切碎；旧形态行的 `#` 注释剥离同为引号感知）；
- 仅 param_mapping 有字面量语义；output_mapping 值位是子输出名，字面量无意义（V6 拦截见 [[spec-parser#^anc-rule-v6]]）。消费面全部同源（resolveCallParams 单点，见 [[exec-engine#^anc-exec-call-auto-map]]）。 ^anc-step-call-literal

ActStep 的沙箱约束：无不可逆副作用，操作范围限于 SandboxConfig 四维度边界（filesystem/network/runtime/database，见 [[sandbox]]） ^anc-step-act-sandbox-constraint

### act body AST【契约】 ^anc-ast-act-body

act/commit 的结构化 body——`> ```hop_python` 围栏内的「无推理编排」（赋值 + 白名单调用 + if-else 分支，**禁循环**）解析所得。概念见 [[../concepts/HopSpec V3核心规范#^anc-step-act]]；body 语言 hop_python 的完整契约（受限子集/环境无关/白名单/禁tab）见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]。生成期由 LLM 产出 body，执行期被引擎（独立模式）或 caller（复用模式）严格解释，不再推理。

两个联合类型（不是 struct）：

- **ActStatement** = AssignStmt ∪ CallStmt ∪ IfStmt（按 type 字段判别）
- **ActExpr** = LiteralExpr ∪ VarRefExpr ∪ FieldAccessExpr ∪ IndexExpr ∪ SliceExpr ∪ BinaryExpr ∪ UnaryExpr ∪ CallExpr ∪ ListLiteralExpr ∪ DictLiteralExpr ∪ FStringExpr ∪ TernaryExpr ∪ ComprehensionExpr（按 type 字段判别）。
  - 成员沿革：ListLiteral/DictLiteral/FString 2026-08-10 A 档实装，TernaryExpr 2026-08-17 作者改判转正式支持，ComprehensionExpr 2026-08-19 列表推导批，SliceExpr 2026-09-05 切片批〔后两员补登 2026-09-05 review 抓漏——权威并集漏员即对新消费者说谎〕——均 Python 对齐
- **BinaryOp** 枚举：`+` `-` `*` `/` `%` `//` `**` `==` `!=` `<` `>` `<=` `>=` `and` `or` `in` `not in`——% // ** 2026-08-10 补齐（** 右结合、-2**2==-4 Python 优先级）；in/not in 成员测试（数组查元素/字符串查子串/对象查键）

```
struct: ActBody
  Id: act-body
  Fields:
    - statements: [ActStatement]     # 语句序列
    - source_location: SourceLocation  # 可选。围栏在原文位置，错误定位

struct: AssignStmt                   # local = <expr>  或  outputName = <expr>（写 +→ 输出）
  Id: assign-stmt
  Fields:
    - type: line                     # 判别字面量 'assign'
    - target: line                   # 变量名（body 局部 or +→ 输出名）
    - value: ActExpr                 # 右值表达式
    - line: number                   # 可选。原文行号

struct: CallStmt                     # 工具/内置调用作为独立语句（副作用，如 write）
  Id: call-stmt
  Fields:
    - type: line                     # 判别字面量 'call'
    - call: CallExpr                 # 调用表达式
    - line: number                   # 可选。原文行号

struct: IfStmt                       # 无推理分支；condition 须确定性可求值
  Id: if-stmt
  Fields:
    - type: line                     # 判别字面量 'if'
    - condition: ActExpr             # 分支条件
    - then_body: [ActStatement]      # 命中分支语句
    - else_body: [ActStatement]      # 可选。elif 在 parser 层展开为 else_body:[IfStmt] 嵌套，消除 elif 节点
    - line: number                   # 可选。原文行号

struct: LiteralExpr
  Id: literal-expr
  Fields:
    - type: line                     # 判别字面量 'literal'
    - value: line                    # 字面值，值型 string | number | boolean | null（null=Python None，2026-08-09 补）
    - literal_kind: line             # 枚举：'string' | 'number' | 'bool' | 'null'

struct: VarRefExpr                   # 变量引用（← 输入 / body 局部 / 上文赋值）
  Id: var-ref-expr
  Fields:
    - type: line                     # 判别字面量 'var'
    - name: line                     # 变量名

struct: FieldAccessExpr              # obj.field（可链式 a.b.c）
  Id: field-access-expr
  Fields:
    - type: line                     # 判别字面量 'field'
    - object: ActExpr                # 被访问对象
    - field: line                    # 字段名

struct: IndexExpr                    # items[i]——动态下标任意表达式；负数下标 Python 语义（items[-1]=末元素）
  Id: index-expr
  Fields:
    - type: line                     # 判别字面量 'index'
    - object: ActExpr                # 被下标对象
    - index: ActExpr                 # 下标表达式

struct: SliceExpr                    # seq[start:stop]——切片；钳位宽容语义与单下标 None 传播分野,分立节点（^anc-step-act-body-slice）
  Id: slice-expr
  Fields:
    - type: line                     # 判别字面量 'slice'
    - object: ActExpr                # 被切片对象（列表或字符串）
    - start: ActExpr                 # 起点端点（可缺席=Python 缺省 0）
    - stop: ActExpr                  # 终点端点（可缺席=Python 缺省 len）

struct: BinaryExpr
  Id: binary-expr
  Fields:
    - type: line                     # 判别字面量 'binary'
    - op: line                       # 运算符 ∈ BinaryOp 枚举（见上）
    - left: ActExpr                  # 左操作数
    - right: ActExpr                 # 右操作数

struct: UnaryExpr
  Id: unary-expr
  Fields:
    - type: line                     # 判别字面量 'unary'
    - op: line                       # 枚举：'not' | '-'
    - operand: ActExpr               # 操作数

struct: CallExpr                     # callee ∈ 白名单（内置函数 ∪ ToolProvider 工具）
  Id: call-expr
  Fields:
    - type: line                     # 判别字面量 'call'
    - callee: line                   # 被调用名
    - args: [CallArg]                # 实参列表

struct: ListLiteralExpr              # [1, "a", x]——元素任意表达式
  Id: list-literal-expr
  Fields:
    - type: line                     # 判别字面量 'list_literal'
    - elements: [ActExpr]            # 元素表达式列表

struct: DictLiteralExpr              # {"k": v}——键=任意表达式求值后 str 归一（2026-08-20 Python 对齐,原"键限字符串字面量"废;权威 [[act-body#^anc-step-act-body-dict-key]]）
  Id: dict-literal-expr
  Fields:
    - type: line                     # 判别字面量 'dict_literal'
    - entries: yaml                  # 键值对列表，每项 { key: line; value: ActExpr }

struct: TernaryExpr                  # a if c else b——条件表达式（右结合,最低优先级,惰性求值只算命中分支）
  Id: ast-ternary-expr
  Fields:
    - type: line                       # 'ternary'
    - condition: ActExpr
    - then: ActExpr
    - else: ActExpr

struct: ComprehensionExpr            # [expr for x in xs (if cond)]——列表推导,嵌套深度≤2（^anc-step-act-body-comprehension;2026-09-05 review 补登——2026-08-19 实装时漏登本权威）
  Id: comprehension-expr
  Fields:
    - type: line                     # 判别字面量 'comprehension'
    - element: ActExpr               # 元素表达式（itemVar 在其可见集内）
    - itemVar: line                  # 迭代变量名（绑定变量,遮蔽外层同名）
    - source: ActExpr                # 被迭代列表表达式
    - filter: ActExpr                # 过滤条件（可缺席）

struct: FStringExpr                  # f"共{n}条"——{{/}} 转义字面花括号；插值 None→"None"、对象→JSON
  Id: fstring-expr
  Fields:
    - type: line                     # 判别字面量 'fstring'
    - parts: yaml                    # 文本段与插值交替列表，每项 {kind:'text'; text: line} 或 {kind:'expr'; expr: ActExpr}

struct: CallArg
  Id: call-arg
  Fields:
    - name: line                     # 可选。工具调用用命名参数（name 必填，对应 ToolProvider Record args）；内置函数用位置参数（name 省略）
    - value: ActExpr                 # 实参值表达式
```

**可调用项 = 白名单**（[[sandbox#^anc-exec-sandbox-principle]]）：`CallExpr.callee` 必须 ∈ 内置函数白名单（`ACT_BUILTINS`，26 件 pure 函数全表见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]）∪ `ToolProvider.list()` 工具名。调白名单外 = 失败。白名单即 act 能力边界，天然实现"无任意代码执行"。

- `+` 按操作数类型分派（数加 / 串接）；`*` 对（string, int）为字符串重复；
- **表达式 walker 五处同步义务**：新增 ActExpr 节点类型时 serialize/exprHasToolCall/exprHasCall/findNonPureCallWith/checkActExpr 必须同批补 case——TS exhaustive switch 保静态漏检。



本组对应 StructuralStepType（关键决策一）——由 ExecutionEngine 内部解析展开，不直接交给 LLM 执行。组级共性：每个接口将 `step_type` 收窄为字面量（关键决策三）；容器类（subtask/parallel/loop/branch/case）持有 `children`，其约束见下文 children 约束表。

```
struct: BranchStep ^anc-step-branch
  Id: step-branch
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'branch'
    - children: [CaseStep]           # Engine 内部评估 case.condition 选择匹配的 case
    # branch 声明 +→ 聚合输出（统一接口名），各 case 用同名填充（同一个东西）。
    # branch done 时从命中 case scope 读同名值透传到外层。无命中 → 不写值。见 [[exec-engine]] 变量作用域规则 5b

struct: SubtaskStep ^anc-step-subtask
  Id: step-subtask
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'subtask'
    - retry: number                  # 可选。最大重试次数，默认 3（retry 仅属 subtask/case——事务边界属性）
    - adaptive: bool                 # 可选。是否启用 adaptive replan，默认 false
    - parallel: bool                 # 可选。callee 并发申报（统一模型：异步派发、容器边界收齐 ^anc-exec-gather）
    - free: bool             # 可选。到步展开档（^anc-step-subtask-free,2026-08-27）——children 可空,到步引擎索计划;S5 豁免
    - children: [StepNode]           # 任意步骤类型
```

**parallel 属性（原 ParallelStep 退役，2026-08-07 语言重构）** ^anc-step-parallel

ParallelStep 独立步骤类型退役——静态并行=SubtaskStep.parallel，动态并行=LoopStep.forEach+parallel（两字段即本锚点的设计落点）。旧 `+ → item : for-each list` 伪输出行文法废除。

- `@a: anc-step-parallel` 的代码落点=两容器 parallel 字段的解析（parser）与 `isParallelContainer()`/`getForEach()` 谓词（ast-helpers）；
- ParallelStep 保留为类型别名 `SubtaskStep & {parallel:true}` 仅供引擎路径类型收窄（P0.5 收窄：LoopStep.parallel 已随 loop 头文法废除删除，宿主只剩 subtask/call）。

```
struct: LoopStep ^anc-step-loop
  Id: step-loop
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'loop'
    - max_iterations: number         # 可选。条件循环形态：最大迭代次数，默认 100
    - forEach: yaml                  # 可选。for-each 遍历形态 { listVar: line; itemVar: line }：`[loop for-each <itemVar> in <listVar>]`——引擎驱动游标，itemVar 绑定各元素（2026-08-07 自原 ParallelStep 迁入）。与 max_iterations 互斥
    - collect: yaml                  # 可选。collect 收集子句列表，每项 { unitVar: line; listVar: line }：`collect <unitVar> into <listVar>`（仅 for-each 形态；可多个）。children 每轮产出 unitVar(T)，引擎轮末收进 listVar([T]) 并复位单项槽。2026-08-09 作者定——取代旧"children 同名输出自动收集"（同名异型是"同名=同一变量"原则唯一裂缝）
    - children: [StepNode]           # 循环体步骤。break/continue 终止或跳过当前迭代
    # loop 无 retry：失败单元是单次迭代，事务性重试用 children 内嵌 [subtask retry=N]

struct: CaseStep ^anc-step-case
  Id: step-case
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'case'
    - condition: line                # 可选。条件表达式：{var} / {var}=={literal} / {var}!={literal}。空 = default case（必须为最后一个）
    - retry: number                  # 可选。最大重试次数，默认 3（case 就是 branch 下的 subtask，语义同 SubtaskStep.retry）
    - adaptive: bool                 # 可选。是否启用 adaptive replan，默认 false（语义同 SubtaskStep.adaptive）
    - children: [StepNode]           # 仅作为 branch 的直接 child，不可嵌套在其他容器中（validator 检查）
    # case 即 branch 下的 subtask：开自己的作用域、声明自己的 `+ →` 聚合输出（BaseStep.outputs），
    # children 产出聚合后提升到 branch 外层供后续引用。互斥 case 各自声明所需输出名（按需，不强制同名）
    # 由概念层「case 就是 branch 下的 subtask」推演：case 继承 subtask 的全部重试语义。
    # retry 祖先查找（fail_step）须同时匹配 subtask 和 case 容器。

struct: BreakStep ^anc-step-break
  Id: step-break
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'break'
    - target_loop: line              # 可选。目标循环步骤号（[break 5.2] 的 5.2）——缺省=最近祖先循环;须是自身祖先循环（C3 扩展判）。与 HopSop [退出循环 <序号>] 对偶
    # 仅允许在 loop 内。Engine 检测到后终止目标循环（无 target_loop 即最近祖先）

struct: ContinueStep ^anc-step-continue
  Id: step-continue
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'continue'
    - target_loop: line              # 可选。目标循环步骤号——缺省=最近祖先循环;须是自身祖先循环（C3 扩展判）。与 HopSop [继续循环 <序号>] 对偶
    # 仅允许在 loop 内。Engine 检测到后跳过目标循环的当前迭代（含内层循环整体结束）

struct: ExitStep ^anc-step-exit
  Id: step-exit
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'exit'
    - exit_outputs: yaml             # 可选。提前退出时的输出值（变量名 → 值的字典，值型 unknown）
    # 可在任意位置。Engine 检测到后终止整个 Spec 执行

struct: OnFailStep ^anc-step-on-fail
  Id: step-on-fail
  Fields:                            # 含 BaseStep 全部字段，step_type 收窄为 'on_fail'
    - children: [StepNode]           # 兜底 children——宿主 retry 耗尽后执行,走完失败被消化
    # [on fail]/[失败兜底]（2026-08-21 作者立,概念权威 HopSpec V3核心规范 ^anc-step-on-fail）。
    # 位置约束 S15（宿主 subtask/case/必居末位/至多一个）;执行语义 exec-engine ^anc-exec-on-fail
    #（耗尽激活/正常路径整树 skipped/兜底自败不再兜/与 commit 退火正交——退火边界直达兜底）。
    # 非 scope 创建容器——children 写宿主 scope,兜底值直达容器输出。
```

---

## 步骤节点联合类型【契约】

由关键决策三（discriminated union）推演：StepNode 是 15 个步骤接口的判别联合，TypeScript 编译期按 `step_type` 自动收窄。

StepNode 是联合类型（不是 struct），成员枚举：

- 可执行：ReasonStep / ActStep / CheckStep / ConfirmStep / AskStep / CommitStep / CallStep
- 结构/控制流：BranchStep / SubtaskStep / ParallelStep（SubtaskStep 的类型收窄别名）/ LoopStep / CaseStep / BreakStep / ContinueStep / ExitStep

TypeScript 的判别联合（discriminated union）通过 `step_type` 字段自动收窄类型。

---

## 容器步骤的 children 约束【说明】

下表为 validator 提供检查依据（完整验证规则见 [[spec-parser]] 附录）：

| 容器类型 | 允许的 children | 最少 children | 特殊约束 |
|---------|----------------|--------------|---------|
| subtask | 任意 StepNode | 1 | — |
| parallel | 任意 StepNode | 1 | v1 顺序模拟 / v2 复用模式真并行（每 child 独立子实例 fan-out，join merge，见 [[exec-engine#^anc-exec-parallel-batch]]）；child 期望为容器，叶子 child 在 v2 退化为单步串行 |
| loop | 任意 StepNode | 1 | 必须内含 break/continue/exit 或通过 branch 终止 |
| branch | 仅 CaseStep | 2 | case 不可嵌套在其他容器中 |
| case | 任意 StepNode | 0 | 仅作为 branch 的直接 child |

---

## DocRef / DocRefFragment（doc-ref 文档引用类型）【契约】 ^anc-type-doc-ref

doc-ref `[[文档路径#章节名]]` 是 KnowledgeProvider 的**确定性对偶**——无 provider、无相关性排序，作者钉定文件+章节，引擎读文件切章节注入（见 [[doc-ref#^anc-exec-doc-ref-resolve]]）。类型定义在 ast-types.ts（AST 契约层）：

```
struct: DocRef                       # parser 预提取的引用声明（进 AST：BaseStep.doc_refs / SpecHeader.doc_refs）
  Id: doc-ref
  Fields:
    - doc: line                      # workspace 相对文档路径（Obsidian 省 .md 时引擎补全兜底）
    - section: line                  # 章节名（匹配 markdown 标题，不含 # 前缀）

struct: DocRefFragment               # dispatcher 运行期解析出的章节内容（注入 doc_ref_context 前的中间形态）
  Id: doc-ref-fragment
  Fields:
    - doc: line                      # workspace 相对文档路径
    - section: line                  # 请求的章节名
    - heading: line                  # 实际命中的标题原文（如 "二、色板"）
    - content: text                  # 切出的章节正文
    - matched: line                  # 匹配级别，枚举：'exact' | 'normalized' | 'fuzzy'（fuzzy 多命中取首 + warn）
    - file_path: line                # 可选。大节 deflate 后的 $file 绝对路径（小节内联时缺省）
```

`DocRef` 由 parser 提取入 AST（[[spec-parser#^anc-rule-doc-ref-extract]]），P15 静态校验存在性（[[spec-parser#^anc-rule-p15]]）。`DocRefFragment` 是 engine 解析的运行期产物，渲染进 `AssembledContext.doc_ref_context`（[[prompt-assembler#^anc-exec-doc-ref-injection]]）。解析流程见 [[doc-ref#^anc-exec-doc-ref-resolve]]。

---

## 已修正记录：StepSummary.step_type【说明】

`StepSummary.step_type` 已在 [[shared-types]] 中从 `string` 修正为 `StepType`（全部 15 种），覆盖 `AdaptiveNeeded.original_children` 和 `RetryRecord.steps_tried` 中的容器类型。

---

## 与 shared-types 的类型引用关系【说明】

```
spec-ast.md（本文件）
  ├── SpecAST, SpecHeader, StepNode, BaseStep, all 14 step interfaces
  ├── StepType, ExecutableStepType, StructuralStepType
  ├── VarBinding, VarDecl, TypeDecl, SpecConfig, ParamMapping
  └── 引用 shared-types.md 的:
        OutputDecl, StepSummary（修正后）, RetryRecord, ErrorCode, SpecError, ResponseOption

shared-types.md
  ├── CLI 响应/请求类型（NextResponse, CommandResponse, VarsResponse, ...）
  ├── ErrorCode, SpecError
  ├── OutputDecl, StepSummary, RetryRecord
  └── 引用 spec-ast.md 的:
        SpecAST（ExecutionEngine.spec 字段）, StepType（StepSummary.step_type）
```

---

## 序列化约定【说明】

- **parse_spec**：markdown → `SpecAST`（内存对象）
- **serialize_spec**：`SpecAST` → markdown（用于 replan 生成的新 children 回写、调试日志）
  - 生产路径：replan 提交的 children 经 `parse_spec` 解析为新 StepNode[]，Engine 验证后直接替换，不经过 serialize 往返
  - 调试/日志路径：`serialize_spec` 作为辅助工具，不做双向一致性保证
- **spec.json**：`SpecAST` 的 JSON 序列化（`JSON.stringify`），存储在 `.hopstate/<id>/spec.json`

`serialize_spec` 是辅助工具（调试/日志），不要求 parse→serialize→parse 完全等价。生产路径始终是单向：markdown → SpecAST → Engine。
