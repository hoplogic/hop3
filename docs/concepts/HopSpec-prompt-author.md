%% @trace
	id: hopspec-v3-prompt-author
	source: [[HopSpec V3核心规范]]
	source_id: hopspec-v3-core
	type: compact
	last_sync: 2026-06-18T12:44+0800
	note: LLM 构建 HopSpec 时的 system prompt 速查卡
%%

> HopSpec 构建速查 (v3.1) — 面向 Spec 作者（LLM 或人类）

## 文档骨架

```
# Spec: <标题>                     # 必选
Id: <标识符>                        # 可选，供 call 引用
Goal: <一句话目标>                  # 必选
> <补充说明>                        # 可选
Constraints:                       # 可选，含预期目标和硬性限制
- <约束>
- @knowledge <关键词>              # 可选，声明需检索的领域知识
Types:                             # 可选，跨步骤复用的结构体
- TypeName:  # 说明
  - field: type  # 说明
Inputs:                            # 可选，Spec 级输入
- var: type  # 说明
Outputs:                           # 可选，Spec 级输出
- var: type  # 说明
## Steps
N. [type] 一句话任务描述
```

`Inputs:` + `Outputs:` 构成 Spec 的公共接口，`call` 调用时据此传参和接收交付物。

## 步骤类型

**工作节点**（叶子）：
- `reason`：需要 LLM 推理的分析、判断、决策，产出新知识
- `act`：**无推理、无循环的计算和工具调用逻辑**。可选 `hop_python` body（围栏语法，见下文）。无 body 时按自然语言描述执行。无不可逆副作用，可安全重做
- `commit`：与 act **同源**（body 完全复用），唯一区别：副作用不可逆（发邮件、支付、写生产库）。推荐幂等设计。可在前面放 `confirm` 保护
- `check`：验证已有产出。**固定双槽签名**——必须声明恰好两个输出：一个 `bool`（判定槽：通过/失败）+ 一个 `text`（说明槽：失败原因，通过时不查看）。必须在 `subtask` 或 `case` 容器内，失败触发 retry
- `confirm`：**纯审批闸门**——暂停等待有权决策者 approve/reject（CITL 介入点）。`+→` 仅 bool（approve→true / reject→全局中止）。`require_human` 标注需真人决策。**只审批不收数据**——要 caller 提供业务值用 `ask`
- `ask`：**数据收集**——暂停向 caller 请求业务数据值（确认推断/多选一/自由填写）。`- ←` 声明候选/推断来源，`+→` 声明要 caller 提供的数据（任意类型）。与 confirm 正交：confirm 答"批不批"，ask 答"值是什么"
- `call`：调用另一个 Spec，格式 `N. [call] <Id> : 任务描述`。双向冒号映射：`- ← 子参数: 父变量` / `+ → 父变量: 子输出`

**结构节点**（容器）：
- `subtask`：顺序子步骤。`retry=N`（缺省 3）重跑，`retry=N adaptive` 可重规划重试
- `parallel` **属性**（非步骤类型）：subtask/call 可标——本任务可被并行调用的申报（自包含/无共享写）。执行=异步派发：主线到标注步骤即派出去跑不等完成；容器完成前把派出的活全部收好（收齐）。申报属实=依赖分析判定（与容器内其他步骤无变量依赖），标注步骤的输出容器内不可消费（只经边界导出）
- `loop for-each <item> in <list>, collect <单项> into <列表>`：列表遍历（引擎驱动游标），`<item>` 为元素绑定；收集用 collect 子句显式声明（children 每轮产单项、引擎收进列表，两名分离）；体内步骤标 parallel 即并发遍历（循环头不可标）。禁止用 reason 让 LLM 数游标
- `branch`：条件决策。**声明 `+→` 聚合输出（统一接口名）**，children 必须全是 `case`，各 case 用**同名 `+→` 填充**（互斥 case 的同名变量是同一个东西）
- `case`：分支条件，仅在 branch 下。支持 `retry=N adaptive`（与 subtask 同源）。条件格式：`N. [case] 描述 (condition_expression)` 或 `(default)`
- `loop`：循环执行，`max=N`（缺省 100）。变量跨迭代自然保留（Python 语义）；累加器用 `+→ acc=初值`（容器 init 一次）

有数据产出的容器必须声明 `+ →` 聚合输出，外部不穿透 children。

**控制流**（叶子）：
- `break`：跳出 loop（只能在 loop 内）
- `continue`：跳过当前迭代（只能在 loop 内）
- `exit`：结束 Spec，`+ →` 标记交付变量名，必须交付所有 `Outputs:` 声明的变量

## 节点体

摘要行后用三种前缀：
- `- ←` 输入变量，只写变量名（类型和说明已在源头声明）
- `+ →` 输出变量，首次出现必须标注类型和 `#` 说明
- `>` 执行说明（段落级，放在 ← → 之后）。支持 `@knowledge <关键词>`（步骤级知识检索）和 `@model service_id/model_name`（步骤级模型路由覆盖）

**变量名全局唯一**，不同数据不能同名。已声明过的变量再次出现只写名字，可逗号合并：`- ← data_profile, clean_suggestions`

## act/commit hop_python body

act 和 commit 可选结构化 body（Python 风格缩进块），放在 `>` 指令区内用围栏包裹：

```
N. [act] 执行数据转换
  - ← raw_data
  + → result: text
  > ```hop_python
    temp = split(raw_data, "\n")
    filtered = filter_lines(temp, "ERROR")
    result = tool_name(input: filtered)
    ```
```

**body 规则**：
- 支持：赋值、内置纯函数（`len/split/trim/to_string/filter_lines`...）、工具调用（`tool_name(arg:value)`）、`if-elif-else` 确定性分支
- **禁止**：循环（需循环用 loop 步骤）、LLM 推理（需推理用 reason）
- 纯计算 body（无工具调用）由引擎自动消化，不交给 LLM 执行
- 含工具调用的 body 交给 caller（LLM/driver）严格逐行执行

## 类型系统

**原子类型**：`bool` `int` `float` `line`(单行) `text`(多行) `markdown` `yaml` `prompt`

**容器类型**：`[Type]` 列表、`(Type, Type)` 元组、`enum(v1, v2, ...)` 枚举

**领域类型**：`HopSpec`（基础类型 markdown）

**复用类型**：PascalCase 词组（≥2 词），在 `Types:` 定义，步骤中直接引用。仅单步骤用的复合类型在节点体内 YAML 展开即可。

## 约束规则

- `Constraints:` 不可违反
- `check` 固定双槽签名不可变（一 bool + 一 text），且必须在 `subtask` 或 `case` 内
- `Outputs:` 不可降级——`exit` 必须交付所有声明变量
- `subtask`/`case` 的 `retry=N adaptive` 内含 `commit` 时必须有 `confirm` 兜底
- `break`/`continue` 只能在 `loop` 容器内
- adaptive 重规划改策略不改目标——容器 `+ →` 契约不可变
- parallel 标注步骤与容器内其他步骤间禁止变量依赖，其输出容器内不可被消费（不能 `← 派出去的活的输出`）——违反即 validator 拒
- `branch` 必须声明聚合输出，各 `case` 同名填充

## 示例

```
# Spec: 用户反馈改进
Id: feedback-improve
Goal: 收集用户反馈并生成改进报告
Constraints:
- @knowledge 用户反馈分析方法论

Types:
- FeedbackItem:  # 单条用户反馈
  - source: line  # 来源渠道
  - content: text  # 反馈内容
  - severity: int  # 严重程度 1-5

Inputs:
- channels: [line]  # 数据源渠道列表

Outputs:
- report: markdown  # 改进报告
- actions: [line]  # 行动项列表

## Steps
1. [act] 从各渠道拉取原始反馈数据
  - ← channels
  + → raw_feedback: [FeedbackItem]  # 原始反馈列表
  > ```hop_python
    raw_feedback = fetch_feedback(channels: channels)
    ```
2. [reason] 按主题聚类并识别高频问题
  - ← raw_feedback
  + → clusters: [line]  # 主题聚类标签
  + → top_issues: [line]  # Top-5 高频问题
  > 关注 severity ≥ 3 的条目，提取共性模式
  > @knowledge 文本聚类最佳实践
3. [branch] 按问题严重度决定报告深度
  - ← top_issues
  + → report: markdown  # 改进报告（branch 聚合输出）
  + → actions: [line]  # 行动项（branch 聚合输出）
  3.1. [case] 存在高严重度问题 (any_severity_gte(top_issues, 4))
    + → report: markdown  # 同名填充
    + → actions: [line]
    3.1.1. [reason] 生成详细改进报告含根因分析
      - ← raw_feedback, clusters, top_issues
      + → report, actions
  3.2. [case] 仅低中严重度 (default)
    + → report: markdown  # 同名填充
    + → actions: [line]
    3.2.1. [reason] 生成常规改进摘要
      - ← clusters, top_issues
      + → report, actions
4. [subtask retry=2] 验证行动项覆盖度
  + → coverage_ok: bool  # 是否全覆盖
  + → coverage_note: text  # 覆盖说明
  4.1. [check] 验证行动项覆盖所有高频问题
    - ← top_issues, actions
    + → coverage_ok: bool  # 判定槽
    + → coverage_note: text  # 说明槽
5. [exit] 交付改进报告和行动清单
  + → report, actions
```
