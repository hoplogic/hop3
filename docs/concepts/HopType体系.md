%% @trace
	id: hoptype-system
	source: [[HopAnt概念-双态组件模型]]
	source_id: cyant-concept
	type: extract
	last_sync: 2026-08-12T22:13+0800
	note: HopType 类型与组合体系——从 HopAnt 概念文档中提取的通用元模型
%%

# HopType：类型与组合体系

> 概念探索阶段

## 定位

**Hop 概念三件套**（2026-08-10 作者定名）——HopSpec 语言的三个基础构件，各答一问：

| 构件 | 本名 | 是什么 | 核心问题 |
|------|------|---------|---------|
| **Hop契约** | **HopTrait** | 无 Steps 的 Spec——只有 Goal/Constraints/Inputs/Outputs 的接口契约 | 承诺什么（WHAT） |
| **Hop类型** | **HopType** | 组件类型——状态字段（Fields）+ 绑定的 Spec 清单 | 是什么、状态存在哪 |
| **Hop作业流程** | **HopSop**（[[HopSop标准作业流程]]） | 顺序/循环/分支 + 分层编号的控制流骨架——SOP 是大致流程，需要 HopJIT 双态融合执行时升级为 HopSpec | 按什么次序做 |

**完整的 HopSpec（有 Steps）= 三件套的集成体**：Hop契约给出目标与边界，HopSop 给出控制流骨架，再加数据流（`←`/`+→`）、步骤类型（reason/act/…）与执行语义（retry/HITL）即成可执行规约。生态分工不变：HopSpec 定义行为，HopType 组织组件，HopJIT 执行调度——三者正交、各自独立演进。

> **称呼约定**：`struct`/`impl`/`trait` 是本体系的语法关键字（借 Rust 词形，语义见下方类比表）；行文称呼用中文本名——**组件类型（struct）、行为实现（impl）、Hop契约（HopTrait）、成员字段（Fields）**——关键字仅在语法语境与首次括注锚定时出现，让非 Rust 背景读者不靠 Rust 预备知识也能读懂。

## 与 Rust 的类比

| Rust          | HopSpec 生态             | 说明                                                         |
| ------------- | ---------------------- | ---------------------------------------------------------- |
| `struct`      | **`struct:`**          | 组件类型定义——身份、状态字段、能力边界                                      |
| （实例）     | **HopAnt**              | 组件类型的运行时实例——活的智蚁                                        |
| `impl`        | **`impl` Spec**        | 行为实现——组件类型实现某个 Spec                                      |
| `trait`       | **HopTrait（Hop契约）** | 无 Steps 的 Spec——只有 Goal/Constraints/Inputs/Outputs，由有序思考或 Spec 库匹配实现 |
| `mod`/`crate` | **Spec 库**             | 组织、命名空间、版本、依赖                                              |
| async/channel | **协作模式**               | 多 HopAnt 之间的交互模式                                            |

**三层关系**：组件类型（`struct`）定义类型，行为实现（`impl`）绑定行为（Spec），HopAnt 是实例化后的运行时实体。

## 组件类型（struct）定义

```
struct: <名称>
  Id: <标识符>
  Fields:                    # 成员字段，HopAnt 实例各自持有
    - <field>: <type>  # 说明
  Specs:                     # 行为定义，绑定在组件上
    - <Spec Id>              # 有 Steps 或无 Steps 均可
```

| 区域 | 说明 |
|------|------|
| Id | 组件标识，用于实例化和寻址 |
| Fields | 成员字段，实例持久状态，跨 Spec 执行存活 |
| Specs | 对外暴露的能力清单，每个指向一个 Spec 定义 |

### 代码侧 vs Agent 侧

**代码侧组件类型** 额外需要：运行时环境（语言、依赖），绑定到具体的 class/module

**Agent 侧组件类型** 额外需要：可用工具集、知识域（知识库、领域文档）、推理能力级别

## 行为实现（impl）：组件类型实现 Spec

组件类型与 Spec 的绑定关系用 `impl` 表示——类比 Rust 的 `impl Trait for Struct`。一个组件类型的 Specs 列表中的每个 Spec Id 都有对应的 `impl`，标记该 Spec 由此组件类型实现。

### Fields 作为 Spec Inputs

当 Spec 被组件类型 impl 时，Spec 的 Inputs 可以引用该组件类型的成员字段（Fields）。这些 Field 输入用 `# Field` 标注，类型已在组件类型的 Fields 中声明，Inputs 中只写变量名：

```
struct: ExecutionEngine
  Id: exec-engine
  Fields:
    - spec: SpecAST
    - step_states: yaml
    - retry_counters: yaml
    ...

## impl fail_step

# Spec: 处理步骤失败
Id: fail_step

Inputs:
- step_id: line          # 调用方传入
- failure_reason: text   # 调用方传入
- spec                   # Field
- step_states            # Field
- retry_counters         # Field
```

调用方（外部 `call`）只需传入非 Field 的 Inputs；Fields 由 HopJIT 从当前 HopAnt 实例自动注入。这解决了"Spec 如何访问组件状态"的问题——通过显式的 Inputs 声明而非隐式注入。

对比独立 Spec（不被任何组件类型 impl 的）：Inputs 全部由调用方传入，没有 Field 注入。

## Hop契约（HopTrait） ^anc-hoptype-hoptrait

**HopTrait（Hop契约）= 无 Steps 的 Spec**（2026-08-10 作者定名，原称"能力契约（trait）/能力声明"）：只有 Goal/Constraints/Inputs/Outputs 的接口契约。

- **有 Steps 的 Spec** = 具体实现（在 HopTrait 承诺的边界内给出执行路径）
- **HopTrait（无 Steps）** = 只承诺 WHAT，由 HopJIT 有序思考生成实现，或从 Spec 库匹配已沉淀的实现

`call` 一个 HopTrait 时，HopJIT 自动走有序思考或查库匹配——调用方不关心对方是硬编排还是动态生成的。`impl` 关系随之读作：**HopType impl HopTrait**（组件类型承诺履行某契约，用有 Steps 的 Spec 兑现）。

Skill 不是独立概念，它就是 Spec。`trait` 作为语法关键字保留（借 Rust 词形），行文一律用本名 HopTrait / Hop契约。

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

## HopType 描述规范（设计文档侧） ^anc-hoptype-desc-spec

（收编自 [[工程实现链规范]] 同名节，2026-08-08 作者指出描述规范应随 HopType 体系单立、不随元规范。原 `^anc-meta-hoptype-spec` 锚点在元规范原位保留；本节为语义权威。）

每个 HopType（组件类型，`struct` 定义）的设计描述必须覆盖**四要素**（行文称呼用中文本名，关键字括注锚定）：

1. **自身定位**：这个组件是什么、解决什么问题（用本体语言，不依赖比喻）
2. **与其他 HopType 的关系**：被谁使用、使用谁、与相邻组件的职责边界
3. **主要 Hop契约（HopTrait）与主要成员**：Hop契约 + 关键成员字段（Fields）——**每个成员字段 / 契约方法独立成条完整介绍**（类型、用途、何时设定/调用、与级别/守卫等机制的交互、副作用），不吝啬空间
4. **核心行为实现（impl）的主要 HopSop 逻辑**：**关键契约与关键流程一起展示**——流程（步骤逻辑）必须与它兑现的契约（HopTrait 的 Goal/Outputs/Constraints）同节在场，**只展示流程、缺漏契约=三件套描述不清**。流程表述用 [[HopSop标准作业流程]]

**成员列表的层次要求**：成员字段或契约方法超过 5 个时必须按职责分组（如"步骤记录组 / 生命周期组 / 访问器组"），组级共性（守卫规则、副作用特征）上提到组标题，不允许平铺一排怼脸上。

**比喻只解释不指代**（宪法级原则，定义见 [[工程实现链规范#^anc-meta-constitution]]）：组件的称呼/引用/术语必须用本名，比喻仅用于首次解释——本条在要素①（自身定位）中尤其要守。

## 待探索

- [x] 组件类型（struct）的定义语法细化 → Fields 类型复用 HopSpec 值类型（HopSchema 使用处之一,[[HopSpec V3核心规范#^anc-type-hopschema]]）+ struct 名互引（设计文档 76 个 struct 实践定形）
- [x] HopJIT 隐式注入的机制设计 → 见 impl 章节：Fields 作为 Spec Inputs，`# Field` 标注
- [ ] HopAnt 实例化与寻址机制（如何创建实例、如何在 `call` 中指定目标实例）
- [ ] HopAnt 之间的协作模式（不只是 parallel，还有协商、竞争、委托）
- [ ] Spec 库的组织方式（命名空间、版本、可见性）
- [ ] 传统代码组件类型的绑定机制（如何把 Python class 包装为 struct）
- [ ] Agent 侧组件类型的能力发现和匹配
- [ ] HopTrait 机制细化（`impl HopTrait for struct` 的显式声明）——需要时再引入
