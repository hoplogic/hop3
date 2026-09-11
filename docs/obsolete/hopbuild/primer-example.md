# hopskill 构建 · 单例 primer

> 一个例子讲完 hopskill。先通读下面这份完整 spec（真实可执行，`hopjit validate` 绿），后文所有规则都指着它讲。**hopskill** = 用 HopSpec 写的 skill：翻译自然语言 skill 后，执行纪律由引擎强制，不靠 LLM 记住。

## 例子：用户反馈周处理

```markdown
# Spec: 用户反馈周处理
Id: feedback-weekly_commit
Goal: 处理本周用户反馈：逐条分析、汇总周报，经主管批准后发送（不可撤回）
Constraints:
- 周报必须覆盖所有反馈条目
Inputs:
- feedback_list: [text]  # 本周反馈原文列表
Outputs:
- weekly_report: markdown  # 周报
## Steps
1. [loop for-each fb in feedback_list, collect item_result into results, parallel] 逐条分析反馈
  + → results: [yaml]  # 各条分析结果（collect 列表端）
  > focus①:遍历不漏
  1.1. [reason] 分析单条反馈
    - ← fb
    + → item_result: yaml  # 单条结果：类别+严重度+摘要（collect 单项端）
    > 判定类别（bug/建议/咨询）与严重度（high/low），写一句话摘要
2. [subtask retry=2] 汇总并验证
  + → weekly_report: markdown  # 周报
  + → severe_count: int  # 严重问题条数
  2.1. [reason] 汇总 results 成周报并数出严重问题
    - ← results
    + → weekly_report
    + → severe_count
    > 按类别归组、严重问题置顶
  2.2. [check final] 周报覆盖全部反馈
    - ← weekly_report, feedback_list
    + → covered: bool  # 判定槽
    + → gap: text  # 说明槽
    > 核对每条反馈在周报中都有对应条目
    > focus②:审核(check 核验)
3. [branch] 按严重问题有无定发送附注
  + → send_note: line  # 发送附注（统一接口）
  3.1. [case(severe_count > 0)] 有严重问题
    + → send_note: line  # 同名填充
    3.1.1. [act] 写加急附注
      - ← severe_count
      + → send_note
      > ```hop_python
      > send_note = "含 " + str(severe_count) + " 个严重问题，请优先处理"
      > ```
  3.2. [case(else)] 常规
    + → send_note: line  # 同名填充
    3.2.1. [act] 写常规附注
      + → send_note
      > ```hop_python
      > send_note = "本周无严重问题"
      > ```
4. [confirm require_human] 请批准发送周报
  - ← weekly_report, send_note
  + → approved: bool
  > 呈周报与附注，请主管批准发送
  > focus②:审核(confirm 人审)
5. [commit] 发送周报
  - ← weekly_report, send_note, approved
  > 前序 confirm 已批准；按周次幂等去重后发送（不可撤回）
  > focus③:不可逆(把关=confirm)
```

## 逐段读这个例子

### 文件头（`# Spec:` 到 `## Steps` 之前）

必需的只有 `# Spec:` 标题和 `Goal:`。例子里其余各段：`Constraints:` 硬约束（注意它后来变成了步骤 2.2 的 check final——每条硬约束都应有 check 落地）；`Inputs:` 是调用方给的（`feedback_list: [text]`——`[T]` 列表类型，for-each 遍历对象必须是它）；`Outputs:` 是交付契约（执行完必须给出 `weekly_report`）。含 commit 的 spec，Id 建议 `_commit` 后缀。**每个声明都带 `# 一句话说明`（必选）**——类型说"长什么样"，说明讲"是什么"。

### 步骤怎么写（看步骤 1.1）

```
1.1. [reason] 分析单条反馈          ← 编号. [Step类型] 一句话任务
  - ← fb                          ← 输入：只写名（类型在源头已声明）
  + → item_result: yaml  # …      ← 输出：首现必标类型 + 一句话说明
  > 判定类别（bug/建议/咨询）…      ← 执行说明（方法论/约束）
```

变量名 `snake_case`；变量类型：`bool`/`int`/`float`、文本四分（`line` 单行 / `text` 多行 / `markdown` / `yaml`）、`[T]` 列表、`enum(a, b, …)`、自定义 Types（PascalCase，文档头 `Types:` 定义）。

### 步骤 1：遍历 → for-each（三焦点①：遍历不漏）

原文说"逐条分析"——**必须**翻成 `loop for-each`，引擎驱动游标、全部完成才 join；❌ 翻成 reason"逐个分析"或 act body 里写 for 循环 = 把完整性交回 LLM 记忆。**取放成镜像**：`for-each fb in feedback_list` 取一端，`collect item_result into results` 放一端——单项与列表**两个名字两个变量**（1.1 每轮产出 `item_result`，引擎收进 `results` 列表）。**只写一个 child 模板**（引擎按列表复制）——循环体要做多步时，包一个 `[subtask]` 当这个唯一 child（子步骤在里面顺序走；直接平铺多个兄弟步骤会被 S12 拒，parallel 下兄弟间不允许依赖）。各条独立才加 `, parallel`。并行时 worker 是独立进程：头上不能挂累加器（汇聚只有 collect 一种），失败 child 不贡献元素（列表变短，不填 None）。

loop 的另一形态是**条件循环 `[loop max=N]`**（"重复直到"场景），跨迭代累加器挂容器头：

```markdown
2. [loop max=10] 反复修复直到达标
  + → error_log: [text] = []  # 累加器：进容器 init 一次，子步骤更新模式追加
  2.1. [act] 执行修复并重测 …
  2.2. [branch] 达标判断
    2.2.1. [case(score >= 90)] 达标
      2.2.1.1. [break]
```

### 步骤 2：核验 → check final（三焦点②：审核不跳，核心是核验）

`Constraints:` 的"必须覆盖所有反馈"落成 2.2 `check final`——放在**全部探索性步骤之后**（其后只允许 commit/exit），不可被跳过。**check 恰好两个输出槽且都在本步首次声明**：`bool` 判定 + `text` 说明。判 false 触发所在 `subtask retry=2` 重跑，text 槽自动注入重跑上下文（重跑步不要写 `← gap`——前向引用非法，`>` 里说"依据注入的失败说明修正"即可）。

### 步骤 3：分支 → branch + case

条件是 hop_python 纯表达式：`[case(severe_count > 0)]`——比较/`and/or/not`/`in`/算术/pure 函数（`len` 等）都可用，**禁工具调用与赋值**；enum 成员裸写不加引号（`risk == high`）；兜底写 `[case(else)]` 且必在最后。**branch 输出同 Python if/else**——各分支给同一个变量赋值，下游直接用；HopSpec 特有的一条：branch 头 `+ →` 声明这个统一接口名（`send_note`），各 case 同名填充。每个 case 至少一个子步骤；"什么都不做"的分支直接不写。

复杂结构用**自定义 Types**（文档头定义、步骤按名引用），字段访问可直接进条件：

```markdown
Types:
- TicketFinding:  # 单个工单的审查结论
  - severity: enum(high, medium, low)  # 严重度
  - summary: text  # 摘要
## Steps
1. [reason] 审查
  + → finding: TicketFinding  # 审查结论
2. [branch] 分流
  + → route: line  # 结论
  2.1. [case(finding.severity == high)] 高危 …
```

### 3.1.1 里的 hop_python body

act/commit 的机械逻辑可写死在 ` ```hop_python ` 围栏（每行带 `> ` 前缀）。**带 body 时仅执行 body**——任务描述不参与执行、只作人读，所以描述必须与 body 语义一致（不一致=翻译错误）。不写 body 也合法——按任务描述执行（一般路由给轻量级 LLM，描述要写到轻量模型也能照做）。能力面只有四类：

1. **基础运算**：算术 `+ - * / % // **`、字符串拼接与重复、比较 `== != < > <= >=`、布尔 `and/or/not`、成员测试 `in`/`not in`、字段取 `obj.field`、下标（含负数 `x[-1]`）、字面量构造 `[1, x]`／`{"k": v}`（对象键限字符串字面量）、f-string `f"共{n}条"`；
2. **白名单调用**——内置 pure 函数**全表**（与 Python 同名同义，位置参数）：数值 `len` `min` `max` `round` `abs` `sum`｜文本 `lower` `upper` `strip` `split` `join` `replace` `count` `startswith` `endswith`｜序列 `sorted` `reversed` `range`｜判定 `any` `all`｜结构 `keys` `values` `get`｜转换 `int` `float` `str` `bool`；文件/目录工具（命名参数 `write(path: p, content: c)`，全限沙箱内）：`read` `write` `create`（排他新建）`append` `listdir` `exists` `makedirs` `move` `remove`；临时文件用 `work_zone_path("draft.md")`；另加宿主注册工具（标不可逆的仅 commit 可调）；
3. **赋值**（局部变量与 `+ →` 输出）；
4. **无推理分支** `if/elif/else`。

白名单外一律非法。**禁 `for`/`while` 与 `map/filter/lambda`**（循环归 loop 步骤）、**禁 `import` 与模块/方法调用**——没有 `os.listdir(x)`、没有 `s.strip()`，一律裸名直调 `strip(s)`；无三元/链式比较/`+=`（用 if/else、and 拆、写全）。None 检测写 `x is None`（`x == None` 同义，`is` 仅限 None 判定）；判空用 `len(x) == 0`（空列表/空对象为真值）。缩进只用空格。

### 步骤 4：人审 → confirm（仅当原文真要人拍板）

原文说"经主管批准"——翻成 `confirm`，输出**只允许 bool 且必须本步带类型声明**；reject 全局中止（后续 commit 绝不执行）。不可逆前的审批加 `require_human`。❌ 翻成 reason"判断是否该批准"（架空决策者）；❌ 原文只说"验证达标"却翻成 confirm（机器能核验的用 check）。

要收集数据用 **`ask`**（confirm 答"批不批"，ask 答"值是什么"，不可混；ask 无 reject 中止语义）：

```markdown
1. [ask] 请用户确认目标领域
  - ← inferred_domain
  + → target_domain: line  # 用户给的值落这里
  > present_inputs: inferred_domain
```

### 步骤 5：不可逆 → commit（三焦点③：试错不 commit）

"发送（不可撤回）"——翻成 `commit`，前序须有把关（confirm 人审／足够 check／环境预授权，三选一；例子里是步骤 4）。入 retry 容器时把关步骤必须在它之前（"act 探索 → check final 验收 → commit 提交"同容器是正统事务形态）。**尽可能幂等**（例子 `>` 里写了"按周次幂等去重"）。❌ 不可逆操作放 act；❌ commit 无前序把关。

### 变量语义（Python 函数级，只记 HopSpec 特有的）

一次执行 = 一次函数调用，容器是控制流块不是作用域——Python 怎么理解变量这里就怎么理解。特有增量：同名再 `+ →` = 再赋值（同名异型才 error）；更新已有变量写 `← x` + `+ → x`；累加器 `+ → acc: type = 初值` 挂容器头（init 一次）；`= Null` 挂子步骤 = 每轮重置；fail 与异常同构——被 subtask/case retry 接住或终止整个实例，没有"失败了继续跑"；None 只来自 `= Null` 或声明未产出（`x is None` 可检测）。

### 调另一个流程 → call

原文说"调用已有的 X 流程"——翻成 `call`，机读全入方括号，括号内 `callee 参数名: caller 变量名`（同名写一个裸名），输出 `+ →` 行收取：

```markdown
# callee 声明:  Inputs: source_data / Outputs: cleaned
2. [call data_cleaning(source_data: order_text, mode)] 调用清洗子流程
  + → clean_result: cleaned  # 本地名: callee 输出名（同名写一个）
```

## 翻译纪律与自查

**忠实翻译**：不增删业务逻辑，意图不清问作者。**生成即校验**：`hopjit validate` 零 error + 作者过目，双门都过才交付。自查四条：①每个遍历点都成 for-each？②每条 Constraints 有 check、原文真要人拍板处才有 confirm？③每个不可逆都成 commit 且把关在前？④行为映射表——原文每个行为 ↔ spec 步骤一一对应，无遗漏无杜撰。大段判据（`>` 超 5-6 行）外置成同目录 `<spec-id>-knowledge.md`，`>` 里 `[[文件名#章节]]` 引用。三焦点落点在 `>` 末尾标 `focus①/②/③`（如例子所示）。
