%% @trace
	id: hoptype-system
	source: [[HopAnt概念]]
	source_id: cyant-concept
	type: extract
	last_sync: 2026-10-06T21:40+0800
	note: 设计层表达语言（HopType + HopSop）——2026-10-05 作者逐条拍定重写：运行层三件（HopSpec/HopTrait/HopSchema,引擎实装）与设计层两件（HopType/HopSop,伪代码）分层;HopType 走 Python class 式聚合不走 Rust struct/impl 分离;块关键字 struct→HopType;成员函数形态（签名 HopSchema 条目带 # 说明 / Goal 与 Constraints 用 # / self.字段 隐式引用 / 体=HopSop）;"完整 HopSpec=三件套集成体"撤销。原从 HopAnt 概念文档提取,HopAnt 为其第一个使用方。
%%

# HopType：设计层表达语言

> 本文定义**设计层**写设计文档用的两件伪代码记法——**HopType**（聚合的类型：字段 + 成员函数）与 **HopSop**（流程骨架）。它们给人和按设计写代码的 agent 读,**不被引擎解析**。引擎真跑的是运行层三件：HopSpec / HopTrait / HopSchema,定义在 [[HopSpec V3核心规范]]。

## HOP类型的两个层次【决策】 ^anc-hoptype-two-layers

| 层次                 | 构件                           | 是什么                                                                                                  | 谁消费                         |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| **运行层**（hopjit 实装） | **HopSpec**                  | 完整函数：原型 + 函数体（Steps）,引擎按步执行                                                                          | parser / engine / validator |
|                    | **HopTrait**（Hop契约）          | 函数原型：只有 Goal/Constraints/Inputs/Outputs,无 Steps;`call` 它时引擎走有序思考或查 Spec 库                            | 引擎                          |
|                    | **HopSchema**                | 类型标注文法：`名 % 类型  # 说明`;Inputs/Outputs/Types/Tools/Config 段都用它（[[HopSpec V3核心规范#^anc-type-hopschema]]）。设计文档里的纯数据形状（响应、记录、入参对象）也用它,块关键字 `HopSchema:`（[[#^anc-hoptype-vs-hopschema]]） | parser / validator;设计读者 |
| **设计层**（伪代码）       | **HopType**                  | 聚合类型：Fields + 成员函数,一个块描述一个 TS/Python 里的 class 或 module                                               | 读设计写代码的人与 agent             |
|                    | **HopSop**（[[HopSop标准作业流程]]） | 流程骨架：顺序/分支/循环的编号步骤,不带执行语义                                                                            | 同上                          |

两层的关系一句话：**设计层描述"代码该长什么样",运行层是引擎真跑的格式。** HopSchema 是两层共用的基本类型标注文法：HopType 的 Fields 与函数参数用它标类型。HopType 与 HopSchema 的分界见下节。

## HopType 与 HopSchema 的分界【契约】 ^anc-hoptype-vs-hopschema

两者都在设计文档里出现,都用 `- 名 % 类型  # 说明` 写字段,所以容易混用。分界只看一件事：**有没有行为**。

**HopSchema 是数据形状。** 一组字段、每个字段一个类型一句说明,没有成员函数。它描述的是"一个值长什么样"：一个 CLI 命令吐出的 JSON、一条写进文件的记录、一个函数的入参对象或返回对象。它与运行层 spec 的 `Types:` 段是同一个东西——`Types:` 段里一条 `- Name:  # 说明` 加缩进字段行就是一个 HopSchema;设计文档里写成块是为了给它起名、让代码与测试能按名对照。

```
HopSchema: AdaptReport
  # 配置适配报告：四项核验各自的 required / missing + 每个缺口一句怎么补
  - ok % bool               # 四项都没有缺口
  - tools % yaml            # {missing % [line], errors % [line], warnings % [line]}
  - hints % [line]          # 每个缺口一句怎么补
```

**HopType 是带行为的聚合。** 字段加成员函数,一个块对应代码里一个 class 或 module——它描述的是"这个部件能做什么、内部怎么做"。成员函数的参数与返回值用 HopSchema 标类型,函数体用 HopSop 写。

```
HopType: AntAdapter
  # 对一个已装 HopAnt 核本机依赖
  Specs:
    adapt(
      antDir % line,            # 已装 HopAnt 的目录绝对路径
      env % AdaptEnv            # 机器侧事实（HopSchema）
    ) -> report % AdaptReport   # 核验结果（HopSchema）
      1. …
```

三条判据：

1. **只有字段、没有函数 → HopSchema。** 哪怕字段很多、嵌套很深,只要没有"做什么",它就是数据。响应类型、计划对象、记录条目、配置节的形状都属此类。
2. **有函数 → HopType,字段写在 `Fields:`。** 函数引用的数据对象另立 HopSchema,不把它的字段摊进 HopType 的 Fields——HopType 的 Fields 是这个部件自己持有的状态,不是它经手的数据。
3. **拿不准时问"代码里它是什么"**：是一个 interface / dataclass / TypedDict → HopSchema;是一个 class / module 且有方法 → HopType。

旧写法说明：2026-10-05 本文重写时只定了 HopType,没有给纯数据形状单独起名,存量设计文档里有百余处 `HopType:` 块只写 `Fields:`（hop-cli 的 CLI 响应类型章整章、各模块的入参/返回对象）——按本节口径它们都是 HopSchema。新写的不再这样写;存量迁移节奏待作者拍（作者 2026-10-06 点出"AntResponse 其实应该是 HopSchema"后立本节）。

## HopType 的写法【契约】 ^anc-hoptype-block

本节即 HopType 的描述规范（原独立节「HopType 描述规范」2026-10-05 并入,外部引用锚保留）。 ^anc-hoptype-desc-spec

**聚合形态**（作者定 2026-10-05：走 Python class 式,不走 Rust struct/impl 分离）。一个块 = 一个类型,字段与成员函数在一处：

```
HopType: ExecutionEngine
  # 执行状态机——管步骤状态、变量作用域、retry/adaptive、失败升级
  Fields:
    - step_states % yaml        # 各步骤当前状态
    - retry_counters % yaml     # 各步骤已重试次数
  Specs:
    fail_step(
      step_id % line,           # 要处理的步骤号,必须是已 start 的步骤
      failure_reason % text     # 失败原因,原样进 retry 反馈
    ) -> escalation % yaml      # retry 或 escalate,带本步重试计数
      # 处理步骤失败：按 retry 阶梯决定重试还是升级
      # 约束：超过 max 后不再重试,直接升级
      1. 读 self.retry_counters[step_id]
      2. [条件(计数 < max)] self.retry_counters[step_id] += 1,返回 retry
      3. [其他] self.step_states[step_id] = failed,返回 escalate
```

规则逐条：

1. **块关键字 `HopType:`**（原 `struct:`;锚点类别名 `anc-struct-*` 不随改——追溯链稳定优先）。块首行下一行 `#` 写这个类型是什么。
2. **Fields 是 HopSchema 条目**：`- 名 % 类型  # 说明`,每条必带说明。
3. **成员函数是函数形态**：签名 `名(参数, …) -> 返回类型`,**参数与返回值都是 HopSchema 条目,每条必带 `#` 一句话说明**;参数竖排、一行一条,与 Fields 同一套文法。不写 `# Spec:` 标题、不写 `## Inputs` / `## Outputs` / `## Steps` 段头。
4. **Goal 与 Constraints 都用 `#` 标记**：签名下第一行 `#` 写这个函数干什么;前置条件、失败条件写 `# 约束：…`。不设独立段。
5. **`self.<字段>` 隐式引用本实例的 Fields**：不进参数列表;`self.x = …` 即改状态,是副作用不是返回值。HopType 块外的独立 spec 不许出现 `self`。
6. **函数体 = HopSop**：编号步骤 + `[条件(…)]` / `[其他]` / 循环等 HopSop 控制流写法;**不带** `[act]` / `[check]` / `[reason]` 类型标、不带 `←` / `+→` 数据流。重试按 HopSop 定义：缺省 0,要就显式标 `重试=N`;`自适应` 同样显式标了才有（[[HopSop标准作业流程]] 定位节）。
7. **无关键逻辑的成员只写签名 + `#` 说明**——纯类型模块、薄适配层照此。
8. **成员超过 5 个按职责分组**,组级共性上提到组标题。
9. **无成员函数的纯数据形状不写 `HopType:`,写 `HopSchema:`**——分界与判据见上节 [[#^anc-hoptype-vs-hopschema]]。

## 独立 HopTrait 的位置【契约】 ^anc-hoptype-hoptrait

**HopTrait（Hop契约）= 无 Steps 的 Spec**：只有 Goal/Constraints/Inputs/Outputs 的接口契约。它是**运行层实装件**——一份真的 spec 文件,可以被 `call`,引擎走有序思考生成实现或从 Spec 库匹配已沉淀的实现。

设计层里,**写在 HopType 块里的是函数,写在块外的才是 HopTrait**——这一句是两者的边界。单实现者的契约不单拆,就是 HopType 的一个成员函数;只有**一份契约有多个实现者**时才单独写 HopTrait（Provider 接口这类"核心定义、多个适配层实现"的跨层契约）。HopTrait 用 HopSpec 的 markdown 结构写（它本来就是一份 spec）。

行文一律用本名 HopTrait / Hop契约,旧称"HopSpec 契约（Spec without Steps）""trait 形式"不再使用。

## 双态在组件级别的体现

HopSpec 的双态融合不只在步骤级别（act = 代码执行，reason = LLM 推理），在组件级别同样成立：

- 一个 HopAnt 可以是**传统代码组件**（Python class、TypeScript module、Java service）
- 一个 HopAnt 可以是**LLM Agent**（拥有工具、知识域、推理能力）
- 一个 HopAnt 可以是**混合体**——部分 Spec 由代码实现，部分靠 LLM 推理

同一个组件类型定义内，不同 Spec 可以有不同的执行后端：
- 有的 Spec 是代码实现（`act` 为主）
- 有的 Spec 是 LLM 推理（`reason` 为主）
- 有的 Spec 是 HopTrait（无 Steps 的 Hop契约）

实例化时根据部署配置绑定具体的执行后端。调用方只 `call` Spec，不关心对面是代码还是 LLM。**HopSpec 是组件间的通用接口语言。**
