# hopskill 构建 · 8k 自包含 primer

> 目标读者：需要独立写出一个能过 `hopjit validate` 的 hopskill 的 agent。本文自包含——不依赖外部文件即可完成中等复杂度的翻译；边角判据（三焦点完整反例集、知识外置细则）在库内 `skills/hopbuild/references/`，可用时优先对照。

## 一、是什么、为什么

**hopskill** = 用 HopSpec 规约写成的 skill。把自然语言 skill（散文 SKILL.md）翻译成结构化规约后，执行纪律由 **HopJIT 引擎结构化强制**，不再依赖执行 LLM"读到并记住"。

自然语言 skill 的三类稳定事故，对应翻译的三条正确性底线（**违反=翻译错误，不是风格问题**）：

| 事故              | 底线               | HopSpec 落法                                   |
| --------------- | ---------------- | -------------------------------------------- |
| 做到第 7 个忘了还有 3 个 | **① 遍历不漏**       | `loop for-each`——引擎驱动游标、全部完成才 join           |
| "应该没问题"就跳过核验    | **② 审核不跳**       | `check final`（不可跳的验收门）；需人拍板处才用 `confirm`（引擎暂停等真人） |
| 调试期把邮件发出去了      | **③ 试错不 commit** | 不可逆操作隔离进 `commit`，前序强制把关闸门                   |

另两条原则：**忠实翻译**（不增删业务逻辑，原文意图不清就问作者，不臆断）；**生成即校验**（必须过 `validate` + 作者过目双门）。

**四条构建心法（宪法级,量大必应验）**：
1. **渐进,第一版只做结构最小集**——拆循环（for-each）、落核验（check）、隔离不可逆（commit）三件做完就交付;细分支/并行/知识外置留后续迭代按实跑反馈加。**嵌套遍历一次只拆一层**：『对每个 X 的每个 Y』只把外层翻 for-each,内层留在子步骤任务描述里（除非用户点名内层也要引擎强制）。第一版步骤量级 ≈ 原文自然段落量级,膨胀超 ~2 倍=一次做深了。宁可简单能跑,不要完备难懂。
2. **I/O 恰如其分**——Inputs=**任务的业务输入**:原文需要外部提供的数据一个不漏、不添;执行/驱动设施（CLI/路径/时间）不是业务输入不进,步骤描述说『用执行环境的 X』。Outputs=**原文承诺的交付物**:一个不漏、不添、**中间产物不进**（草稿/内部判定在步骤间流转即可,交付出去=把工作台摆进交付箱）。
3. **关注点分步**——第一步只管结构（步骤分拆+三焦点）;第二步通盘反思 ask 面（参数前置收拢,中段暂停只留真依赖中间产物的;**颗粒度=一个 ask 一个可独立作答的决策**——合并独立决策=打包拍板,拆碎单一决策=碎问,**该人研判的给 default 溜过=反向同罪**）;第三步逐容器反思 retry（重跑凭什么会变好?——带反馈/adaptive 换路/确定性失败不 retry 直接上报,缺省 retry=3 不是免检章）;知识外置（≤10 行判据先内联）与判定 enum 化是生成时的执行细节。每步一个关注点。
4. **LLM 步骤输出要简单**——reason/act（无 body）的 `+ →` 首选单值或平面字段（line/bool/enum/int）;嵌套结构错误率随复杂度陡增,轻量模型量大必错。要大结构就拆步:一步一个简单输出,或 reason 出平面字段 → act body 机械组装（组装是代码不是 LLM 赌格式）。

## 二、文件骨架

```markdown
# Spec: <标题>
Id: <kebab-case-id>              # 可选，供 call 引用；含 commit 的建议 _commit 后缀
                                 # 可写函数签名形式 my-id(in1, in2) -> out1——一眼读懂调用面；
                                 # 写了就必须与 Inputs/Outputs 按名完全对应（多/漏/错名均 error）
Goal: <一句话业务目标>
> <可选多行补充>

Constraints:                     # 可选，硬约束（→ 常映射为 check final）
- <约束>

Types:                           # 可选，复用复合类型（PascalCase）
- <TypeName>:  # 一句话说明，讲清楚含义/意图，避免误解（必选，下同）
  - <field>: <type>  # 一句话说明

Inputs:                          # 可选，Spec 级输入
- <name>: <type>  # 一句话说明

Outputs:                         # 可选，交付物契约（exit 必须全部交付）
- <name>: <type>  # 一句话说明

## Steps
<步骤列表>
```

必需项只有 `# Spec:` 标题 + `Goal:`。

**步骤节点体三前缀**：

```markdown
N. [Step类型 修饰] 一句话任务描述
  - ← var                        # 输入：只写变量名（类型在源头已声明）
  + → var: type  # 一句话说明    # 输出：首现必标类型 + # 一句话说明（讲清意图防误解）
  > 执行说明（角色视角/方法论/约束）
```

**变量类型**（`+ →` 首现声明与 Types/Inputs/Outputs 里的 `<type>` 位；注意与 Step类型 是两回事——Step类型在方括号里说"这步干什么"，变量类型说"这个数据长什么样"）：

- 基础值：`bool` / `int` / `float`
- 文本按用途细分：`line`（单行短文本，如路径、标题）/ `text`（多行自由文本）/ `markdown`（结构化文档）/ `yaml`（结构化数据块）
- `[T]`：T 的列表，如 `[line]`（路径列表）、`[yaml]`（结构化条目列表）——for-each 遍历的对象必须是 `[T]`
- `enum(v1, v2, …)`：有限值枚举，如 `enum(high, medium, low)`——供 case 条件裸字比较
- 自定义 Types：文档头 `Types:` 定义的复合类型，步骤里按 PascalCase 名字引用。示例如下：

  ```markdown
  Types:
  - TicketFinding:  # 单个工单的审查结论
    - ticket_id: line  # 工单编号
    - severity: enum(high, medium, low)  # 严重度
    - summary: text  # 问题摘要
  Inputs:
  - ticket_text: text  # 待审查的工单原文
  ## Steps
  1. [reason] 审查工单
    - ← ticket_text
    + → ticket_finding: TicketFinding  # 本工单的审查结论
    > 按审查标准逐项核对工单内容，判定严重度并写摘要
    ……（后续步骤 ← ticket_finding 引用，字段访问写 ticket_finding.severity）
  ```

变量名一律 `snake_case`。变量名要意义明确，避免单个词，避免望词生义产生误解

**复合输出就地展开**（本步专用的结构化输出，不必立 Types）：`+ → report:`（行尾冒号、不写类型）+ 缩进子行 `- field: type  # 一句话说明`，整体按 yaml 处理。**确有需要才用,不是缺省姿势**——LLM 步骤的输出首选单值/平面字段（见「输出要简单」）。

`>` 区用于展开描述工作，其中可以包含可选标注：`@model 服务/模型名`（步骤级模型路由）、`@knowledge 关键词`（语义检索注入）、`[[知识文件#章节]]`（doc-ref 精确注入，见自查清单 4）。

编号：顶层 `1. 2.`；容器子步 `3.1. 3.2.`；缩进 2 空格/层。

## 三、14 种 step 类型与选型

**叶子（做实事）**：

| 类型            | 语义                        | 身份约束                                                      |
| ------------- | ------------------------- | --------------------------------------------------------- |
| `reason`      | LLM 推理/分析，产出新知识           | 唯一"动脑"的步                                                  |
| `act`         | 无推理的确定性计算+工具调用            | **必无不可逆副作用、可安全重跑**                                        |
| `commit`      | 有不可逆外部副作用的操作              | 前序须有把关；入 retry 容器时**把关步骤（confirm/check）必须在它之前**；**尽可能幂等** |
| `check`       | 验证产出达标，固定输出 `bool + text` | **必在 subtask/case 内**；失败触发容器 retry                        |
| `check final` | 不可被 adaptive 跳过的验收门       | **必在全部探索性步骤之后**，其后只允许 commit/exit（提交性收尾）；Constraints 的化身  |
| `confirm`     | 纯审批闸门，等外部决策者              | driver 不得替答；**reject 全局中止**                               |
| `ask`         | 向用户收集业务数据                 | 无 reject 语义；`present_inputs` 呈交依据                         |
| `call`        | 调用另一个 spec                | 标准写法 `[call id(输入映射)] 描述`——机读全入方括号；语法见下「call 的映射」         |

**hop_python——case 条件与 act/commit body 共用的小语言**（受限子集非真 Python，先立于此，下文直接引用）：

- **表达式能力面**（两处通用，**与 Python 一致**）：字面量（数字/字符串/`true`/`false`/`None`）、**列表/对象字面量**（`[1, x]`、`{"k": v}`——对象键限字符串字面量）、**f-string**（`f"共{n}条"`）、变量、字段访问 `point.type`、下标 `items[0]`（负数可用 `items[-1]`）、比较 `== != < > <= >=`（Python 同义——等值跨类型不相等、序比较同类型才可比、字符串对按字典序）、`and/or/not`、**成员测试 `in` / `not in`**（`x in items`——数组查元素/字符串查子串/对象查键）、算术 `+ - * / % // **`、字符串重复 `"-" * 3`、括号、**pure 函数调用**（见下表）。**None 检测写 `x is None` / `x is not None`**（Python 惯用形；`x == None` 同义。`is` 仅限 None 判定）。**不支持**（报错会指路）：三元 `a if c else b`（用 if/else 语句）、链式比较（用 and 拆）、`+=`（写全）、`pass`（空分支不写）、`map/filter/lambda/enumerate/zip`（循环归 loop）。
- **pure 函数全表**（零副作用纯计算，case 条件与 body 都可用，Python 同名同义）：数值 `len` `min` `max` `round` `abs` `sum`｜文本 `lower` `upper` `strip` `split` `join` `replace` `count` `startswith` `endswith`｜序列 `sorted` `reversed` `range`｜结构 `keys` `values` `get`｜类型转换 `int` `float` `str` `bool`。**判空只用裸真值或 `len(x) == 0`**（`if x:` 对 null/空串/空列表一体安全；❌ `x != ""`——字段为 null 时 `None != ""` 为 True，误入非空分支，validate 会 B6 提示）。条件示例：`[case(len(pending_list) > 5)]`、`[case("urgent" in tags)]`。
- **case 条件 = 上述表达式，再禁两样**：**禁工具调用**（有副作用，条件必须可反复求值）、**禁赋值**（条件只读）。
- **body = 表达式 + 三类扩展**：①工具调用（具名传参 `f(data: x)`）——内置文件/目录工具组九件（命名与 Python os/shutil 对齐：`read` `write` `listdir` `exists` `create`（排他新建，已存在即失败——并发抢占/哨兵文件用它）`append` `makedirs`（含中间层，幂等）`move` `remove`，全部限沙箱 workspace 内、act/commit 都可调），另加宿主注册的工具（按运行环境清单；标不可逆的仅 commit 可调）。**临时文件放 work_zone 涂鸦区**：`p = work_zone_path("draft.md")` 返回本实例独占工作区路径（无参返回根），中间产物/分段落盘用它，不污染 workspace；②赋值（局部变量与 `+ →` 输出）；③`if/elif/else` 无推理分支。**禁 `for`/`while`**（循环升 loop 步骤）、**禁 `import` 与模块/方法调用**——没有 `import os`，没有 `os.listdir(x)`，没有 `s.strip()`：一律裸名直调（`listdir(path: p)`、`strip(s)`），缩进只用空格。

带 body 的 act 示例（body 写在 `>` 区的代码围栏里，**每行都带 `> ` 前缀**）：

```markdown
3. [act] 统计告警数并给出规模档位
  - ← alert_list, batch_note
  + → alert_count: int  # 告警条数
  + → scale_label: line  # 规模档位（小批/大批）
  > ```hop_python
  > alert_count = len(alert_list)
  > note_clean = strip(batch_note)
  > if alert_count > 100:
  >     scale_label = "大批: " + note_clean
  > else:
  >     scale_label = "小批: " + note_clean
  > ```
```

**容器/控制流**：

| 类型                        | 语义                                         | 要点                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subtask`                 | 顺序容器+事务单元                                  | `retry=N`（缺省 3）整组重跑；`adaptive` 允许重规划（交付契约与 check final 不可改）；`parallel` 申报可并行执行（见下「parallel 属性」）                                                                                                                                                                                                                                                                                                        |
| `loop`                    | 两形态：`max=N` 条件循环 / `for-each x in xs` 列表遍历 | 变量跨迭代自然保留；**无 retry**（单轮要事务性在循环体内嵌 `[subtask retry=N]`）；要并发遍历时给体内 subtask/call 标 `parallel`（见下「parallel 属性」）                                                                                                                                                                                                                                                          |
| `branch`+`case`           | 条件决策，children 必全是 case                     | 标准写法 `[case(条件)] 人读描述`——**机读全在方括号内**（与 `[loop for-each …]` 同构），描述纯人读；**条件 = hop_python 纯表达式**（能力面与收紧见上「hop_python」节）；enum 变量比较时成员**裸写不加引号**（`risk == high`），自由文本才加引号；**统配（else）写 `[case(else)]` 且只能放最后**；条件按序求值、命中即入；若全部不命中且无 else 兜底，branch 不报错、整块跳过不执行、**不写任何变量**。**每个 case 至少一个子步骤**（case 是容器，不能只挂 `+ →` 空身）——"什么都不做"的分支**直接省略不写**（无命中静默跳过，天然就是无动作）。**下游要用 case 的产出时，branch 头必须声明同名 `+ →` 统一接口**（见下） |
| `break`/`continue`/`exit` | 跳出 loop / 跳过本轮 / 结束 spec                   | break/continue 仅 loop 内；exit 交付全部 Outputs——**bare exit（不写 `+ →`）= 隐式交付全部 Outputs**，写了就必须写全（半写即错）                                                                                                                                                                                                                                                                                                        |

**`parallel` 属性**（不是步骤类型；可标 `subtask` 与 `call`）：申报"本任务自包含、无共享写、可安全多实例并行"。执行语义=**异步派发**——主线走到标注步骤就派出去跑、不等完成、继续下一兄弟/下一迭代；容器结束前引擎自动把本容器派出的活全部收齐（收取无语法，引擎自知）。未标注的步骤主线自己同步做（缺省即串行）。写法与边界：

- **循环体内标注** → 各迭代渐进派发（流水线并发）；**兄弟并列多个标注** → 兄弟并发。并发路数不进 spec（部署配置管）。call 标注写 `[call id(映射) parallel]`。
- **派出的活 = 独立进程**：入参在派发时快照传入；**其输出在本容器内不可被后续步骤消费**（值可能未回，S12 拦）——只经容器边界导出：loop 经 collect 列表、subtask 经容器头 `+ →`（收齐后可读）。容器内确需消费其输出 → 把两者包进同一子 subtask（依赖显式化为串行结构）。
- **输出禁累加器**（S13）：并行汇聚只有 collect 收集列表一种；要归约（汇总/统计）写"收集列表 + 容器后一个串行步骤消费列表"。
- **失败**：派出的活自己 fail → 不贡献收集元素（列表变短、不填 None），部分结果可否接受由后继裁量。

**选型映射**（读原文按动词认）：分析/判断→`reason`｜计算/提取/跑脚本→`act`｜发送/支付/删除/写生产→`commit`｜验证/确保→`check`｜让用户确认/审批→`confirm`｜问用户要数据→`ask`｜对每个X→`loop for-each`｜重复直到→`loop`｜如果…否则→`branch`｜分几步/要重试→`subtask`｜调另一个流程→`call`。

**两个易混分界**：
- `reason` vs `act`：要动脑用 reason，纯机械执行用 act；"定策略"和"执行策略"拆成 reason→act 两步。
- `act` vs `commit`：唯一分界是**副作用可逆性**。拿不准能否安全重跑 → 保守当 commit。

**act/commit 的 hop_python body（可选执行体）**：纯机械步骤可在 `>` 区加 ` ```hop_python ` 代码围栏写死执行逻辑，语言能力面见上「hop_python」节的 body 段。数据从 `←` 输入取、结果写进 `+ →` 声明的输出变量。**带 body 时仅执行 body**——任务描述与 `>` 说明不参与执行，只作人读；所以**描述必须与 body 语义一致**（描述说的就是 body 做的，不一致=翻译错误，写完 body 回头核对描述）。不写 body 也合法——按任务描述执行（一般路由给 flash 级轻量 LLM，任务描述要写到轻量模型也能照做）。

**call 的映射**：

```markdown
# callee 声明自己要什么:  Inputs: source_data / Outputs: cleaned
# caller 里（caller 自己的变量叫 order_text，前序步骤产出）:
1. [call data_cleaning(source_data: order_text, mode)] 一句话任务描述
  + → clean_result: cleaned  # 输出映射：caller 变量 clean_result ← callee 输出 cleaned
```

**输入映射在方括号的圆括号内**：`callee 参数名: caller 变量名` 逗号分隔——左边是 callee Inputs 声明的参数名，右边是 caller 自己的变量；等价 Python 具名传参 `data_cleaning(source_data=order_text)`。两侧同名时省略冒号和右侧、只写一个裸名（`mode` ≡ `mode: mode`）；无输入省略圆括号（`[call spec-id]`）。输出映射同理：`caller 变量名: callee 输出名`，两侧同名只写一个名（`+ → cleaned` ≡ `+ → cleaned: cleaned`）。

**confirm/check 的输出槽是硬约束**（validator 强制）：
- `confirm` 的 `+ →` **只允许 bool，且必须在 confirm 步内带类型声明**（写 `+ → approved: bool`，不要"容器头预声明+步内裸名"——校验按本步标注判型，裸名会被拒）。纯审批闸门；要收集数据用 ask，两者不可混。
- `check`/`check final` **恰好两个输出槽且都在本步首次声明**：一个 `bool`（判定）+ 一个 `text`（说明）。**不要**复用外部已有变量当判定槽（如 `+ → format_ok` 引用容器头声明的 bool）——判定槽必须带类型在 check 步内新声明，容器要导出时在容器头写同名声明由引擎提升。

## 四、三焦点翻译细则

### 焦点① 遍历 → for-each

```markdown
5. [loop for-each item in items, collect result into results] 逐项处理
  + → results: [text]            # collect 子句的列表端（引擎逐轮收集）
  5.1. [subtask retry=2 parallel] 处理单项    # parallel=各迭代异步派发（各项独立才加）
    - ← item                     # 元素绑定直接引用
    + → result: text             # collect 子句的单项端（每轮产出，引擎运走）
    > 对单个 item 做处理
```

要点：**取放成镜像**——`for-each <item> in <list>` 声明取的一端，`collect <单项> into <列表>` 声明放的一端；单项与列表是**两个名字两个变量**（单项 `T` 每轮产出，引擎轮末收进列表 `[T]` 并复位单项槽）。列表端在容器头 `+ →` 声明类型。**只写一个 child 模板**（引擎按列表复制）；并发标注打在体内 subtask/call 上，各项独立才加（见「parallel 属性」）。无 collect 子句 = 纯副作用循环，或用普通末值/累加器导出（仅串行）。
反例：❌ act body 里写 `for` 循环（body 禁循环）；❌ `[reason] 逐个分析`（遍历交回 LLM 记忆）；❌ 单项与列表同名（同名=同一变量，收集必用 collect 子句两名分离）；❌ `parallel` 标在 loop 上（它只可标 subtask/call）。

### 焦点② 审核 → check / confirm（核心是核验；人审只是一种形式，视需求定）

**产出核验（核心形态）** →

```markdown
3. [subtask retry=2] 执行并验证
  + → summary: text
  3.1. [act] 执行操作 …
  3.2. [check final] 验证达标        # 必在探索步骤之后（其后只可 commit/exit）
    - ← output, threshold
    + → ok: bool                 # 判定槽
    + → note: text               # 说明槽（未达标的缺口，供带反馈重跑）
```

原文 Constraints 每条硬约束都应有对应 check 落地。
**check 失败反馈**：check 判 false 时，text 说明槽自动注入重跑步上下文（"带反馈重跑"机制）——重跑步**不要写 `← 说明槽`**（前向引用违反 v1），`>` 里点明"依据注入的失败说明定向修正"即可。

**人来把关（仅当原文真要人拍板时）** →

```markdown
6. [confirm require_human] 请批准执行修复
  - ← fix_plan                   # 给决策者看的依据
  + → approved: bool             # approve→true；reject→全局中止
  > 展示 fix_plan，请决策者批准。
```

`require_human`：不可逆/高风险加（强制真人）；一般确认可省。不要把原文没有的人审擅自加进来——机器能核验的用 check。
反例：❌ `[reason] 判断是否该批准`（架空外部决策者）；❌ 原文只说"验证达标"却翻成 confirm（把核验降级成打扰人）。

**branch 的输出**：同 Python if/else——每个分支给同一个变量赋值，下游直接用。HopSpec 特有的只有一条：**branch 头 `+ →` 声明这个统一接口名，各 case 同名填充**（导出契约显式化）：

```markdown
3. [branch] 按档位分流
  + → conclusion: text  # 统一接口
  3.1. [case(tier == 'fast')] 快速通道
    + → conclusion: text  # 同名填充
    3.1.1. [act] 生成结论 …
      + → conclusion
  3.2. [case(else)] 兜底（必在最后）
    + → conclusion: text
    …
4. [commit] 写入系统
  - ← conclusion
```

### 焦点③ 不可逆 → commit + 把关

```markdown
7. [commit] 发送报告邮件
  - ← final_report, approved
  > 前序 confirm 已批准；执行发送（不可逆）。
```

把关闸门三选一：前序 `confirm` 人审／足够的 `check` 验证／环境预授权（能执行到即已授权）。
**commit 尽可能幂等**（如按业务键 upsert/去重），`>` 里写明幂等键。
反例：❌ 不可逆操作放 act；❌ commit 无任何前序把关；❌ retry 容器内 commit 前无 confirm/check 把关（把关在 commit 后不算——提交完才验收=裸奔提交）。
**"探索→验收→提交"同容器是正统事务形态**：`subtask retry` 内 act 探索 → `check final` 验收 → `commit` 提交——验收不过就重跑探索段，commit 只在验收通过后执行一次；check final 之后只允许 commit/exit（禁再做探索性工作）。

**落点标注**：每个因三焦点定型的步骤，`>` 末尾加 `> focus①:遍历不漏` / `> focus②:审核(…)` / `> focus③:不可逆(把关=…)`——供事后逐关检查。

## 五、变量语义（易踩坑）

**变量 = Python 函数级语义**：一次 spec 执行 = 一次函数调用，容器（subtask/loop/branch/case）是控制流块不是作用域——Python 里怎么理解变量，这里就怎么理解。真边界只有两处：call 子 spec（=函数调用）、parallel 派出的活（=独立进程，入参派发时快照传入）。以下只列 **HopSpec 特有**的部分：

- **声明语法**：同名再 `+ →` = 再赋值（合法；**同名异型**才 error）；更新已有变量写更新模式（`← x` + `+ → x`）。**`+ →` 行只声明名字**（`name: type` 或裸名）——累加/表达式写进 hop_python body（❌ `+ → alert_list = alert_list + [item]`：整串会被当变量名拒）。
- **变量名**：标识符（字母含中文/下划线开头，后续字母数字下划线——Python 同款；中文名一等公民 `风险等级: enum(高, 中, 低)` 合法）。**关键词与类型名是保留字**——变量不得取名 `reason`/`final`/`case`/`line`/`text` 等（步骤类型词/属性词/段头词/内置类型名全族，中文关键词同禁）。
- **累加器**：`+ → acc: type = 初值` 挂容器头（进入容器 init 一次），子步骤更新模式追加。之后要被 for-each 遍历的必须声明 `[T]`（V8）。每轮重置则在子步骤声明 `= Null`（该步每次执行写初值）。
- **🔴 parallel 标注步骤的输出禁累加器**（S13）：派出去的活无共享空间，并行汇聚只有 collect 收集列表一种；要 reduce 在收齐后的串行步骤做。
- 输入 `←` 必须来自前序输出或 Inputs（v1）；**容器头只写 `+ →` 不写 `- ←`**——它是导出契约不是访问控制。
- **fail 与异常同构**：被事务边界（subtask/case retry）接住，或穿透终止整个实例——没有"失败了继续跑"。fail 不碰变量值；None 只来自 `= Null` 或声明未产出，`x is None` 可检测。唯一例外 parallel：派出的活 fail 不贡献收集元素（列表变短，不填 None），部分结果可否接受由后继裁量。

## 六、生成后自查清单

1. `hopjit validate <spec>` 零 error（高频规则：v1 输入可追溯／c6 check 必在容器内／c7 check final 后只可提交性收尾／exit 交付全部 Outputs）。
2. 三焦点逐关独立复查：每个遍历点都成 for-each？每条 Constraints/核验点有 check、原文真要人拍板处才有 confirm？每个不可逆都成 commit 且有把关？
3. 行为映射表：原文每个行为 ↔ spec 步骤逐一对应，无遗漏无杜撰。
4. 大段判据（评分规则/清单/模板，`>` 超 5-6 行）外置成同目录 `<spec-id>-knowledge.md`，`>` 用 `[[文件名#章节]]` doc-ref 引用（禁引目录外——运行期按 cwd 解析禁 `..`）。
5. 交作者过目（语义忠实门），批准后写盘。

## 七、最小完整样例

```markdown
# Spec: 批量文件审查
Id: file-review
Goal: 审查目录下每个待查文件并产出汇总报告，经人批准后归档
Inputs:
- files: [line]  # 待审查文件路径列表
Outputs:
- report: markdown  # 汇总报告
## Steps
1. [loop for-each f in files, collect finding into findings] 逐文件审查
  + → findings: [yaml]  # 各文件问题（collect 列表端）
  > focus①:遍历不漏
  1.1. [subtask parallel] 审查单个文件    # 各迭代异步派发
    + → finding: yaml  # 单文件问题（collect 单项端）
    1.1.1. [reason] 审查
      - ← f
      + → finding
      > 读取并按质量标准审查该文件
2. [subtask retry=2] 汇总并验证
  + → report: markdown  # 汇总报告
  2.1. [reason] 汇总 findings 成报告
    - ← findings
    + → report
    > 按严重度归类汇总
  2.2. [check final] 报告覆盖全部文件
    - ← report, files
    + → complete: bool  # 判定槽
    + → gap: text  # 说明槽
    > 核对每个输入文件在报告中都有对应条目
    > focus②:审核(check 核验)
3. [confirm require_human] 请批准归档
  - ← report
  + → approved: bool
  > 呈报告请人批准归档
  > focus②:审核(confirm 人审)
4. [commit] 归档报告
  - ← report, approved
  > 前序 confirm 已批准；写入归档目录（不可逆）
  > focus③:不可逆(把关=confirm)
```
