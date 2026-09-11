# HopSpec V3 语法与翻译判据知识

> `examples/hopbuild.md` 的陪伴知识文档（doc-ref 被引文件，章节标题是切片锚、不可改名）。**内容权威源是 `skills/hopbuild/hopbuild-primer.md`**（2026-08-18 单源汇聚,primer-8k 退役）——primer 演进后须正向同步本文件（2026-08-09 依 primer 全文重写，替换旧口径：同名自动收集→collect 子句、旧 case 写法→结构化逻辑标准写法、V3 遮蔽豁免→扁平命名空间）。概念层全文在 `docs/concepts/HopSpec V3核心规范.md`。

## HopSpec 骨架与 step 类型映射

**文件骨架**：`# Spec: <标题>` + `Goal: <一句话>`（二者必需）；可选 `Id:`（kebab-case，供 call 引用）/ `Constraints:`（硬约束，常映射为 check final）/ `Types:`（PascalCase 复合类型）/ `Inputs:` / `Outputs:`（exit 须全交付）/ `## Steps`（≥1 步）。值类型：`line`/`text`/`markdown`/`yaml`/`bool`/`int`/`float`/`[T]` 列表/自定义 Types。

**步骤节点体三前缀**：`- ← var`（输入，只写名）；`+ → var: type  # 说明`（输出，首现标类型）；`> 执行说明`。编号顶层 `1.`、子步 `3.1.`，缩进 2 空格/层。

**叶子步选型**（读原文按动词认）：分析/判断→`reason`（唯一动脑步）｜计算/提取/跑脚本→`act`（必无不可逆副作用、可安全重跑）｜发送/支付/删除/写生产→`commit`（前序须有把关闸门：confirm 人审/足够 check/环境预授权；禁入 retry 容器）｜验证/确保→`check`（固定输出 bool+text，必在 subtask/case 内；`check final` 必在容器末尾、adaptive 不可跳）｜让用户审批→`confirm`（driver 不得替答，reject 全局中止）｜问用户要数据→`ask`（`present_inputs` 呈交依据）｜调另一流程→`call`（结构化逻辑标准写法 `[call id(子参数: 父变量, 同名裸名)] 描述`——机读全入方括号；输出 `+ → 父变量: 子输出` 行收取）。

**容器/控制流**：`subtask`（顺序容器+事务单元，`retry=N` 缺省 3 整组重跑，`adaptive` 允许重规划但交付契约与 check final 不可改）｜`loop`（`max=N` 条件循环 / `for-each x in xs` 列表遍历；无 retry）｜`branch`+`case`（结构化逻辑标准写法 **`[case(条件)] 人读描述`**——机读全在方括号内；条件=hop_python 纯表达式：比较数值语义、`and/or/not`、算术、字段访问、`x == None` 探测空值，禁工具调用禁赋值；**统配 else 写 `[case(else)]` 且必在最后**；顺序命中；下游要用 case 产出时 branch 头必须声明同名 `+ →` 统一接口）｜`break`/`continue`/`exit`。

**并发收集用 collect 子句（显式）**：`[loop for-each item in items, collect result into results]` + 体内 `[subtask parallel]`——并发是体内步骤的性质（循环头不可标 parallel）；单项 `result`（标注步骤产出 T）与列表 `results`（容器头声明 [T]）两个名字分开声明。**parallel 标注步骤输出禁累加器**（S13：派出去的活无共享空间，汇聚只有收集列表一种语义；reduce 在收齐后的串行步做）。

## 纪律落点强制翻译判据（遍历/核验/提交/研判四类）

**① 循环遍历不漏 → for-each**：原文每个"对每一个/逐个/遍历"必翻 `loop for-each`（独立项体内包 `[subtask parallel]` + collect 子句收集）。禁止翻成"一步处理全部"——那正是自然语言 skill 做到第 7 个忘了还有 3 个的事故形态。

**② 审核不跳 → confirm + check**（两层必须分辨）：真人拍板→`confirm require_human=true`；机器可验的达标判定→`check`；每条 Constraints 至少一个 check final 兜底。禁止把"应该没问题"翻成注释——审核必须是引擎强制的步骤。

**③ 试错不 commit → act/commit 分离**：唯一分界是**副作用可逆性**——拿不准能否安全重跑，保守当 commit；commit 前序必有把关闸门（三选一），禁入 retry 容器。

## 高频验证规则（生成后自查，避免 validate error）

- **v1**：步骤 `←` 输入必来自前序 `→` 输出或 `Inputs:` 声明，不能凭空引用。
- **v2**：同名 = 同一变量——再次 `+ → x`（裸名或同型）是合法再赋值，**同名异型才是 error**（扁平命名空间，无块级作用域）。
- **v8**：for-each 的 listVar 声明必须是列表型 `[T]`。
- **v10**：collect 的单项名须有 child 产出（T 型）、列表名须容器头声明（[T] 且元素型匹配）。
- **c6**：`check` 必在 subtask/case 容器内。
- **c7**：`check final` 必在容器**末尾**。
- **s13**：parallel 标注步骤禁带 `= 初值` 的累加器输出。
- **p15**：doc-ref `[[文档路径#章节名]]` 的文件与章节必须真实存在（按 cwd 解析，禁 `..` 跨目录）。
- **exit**：Outputs 声明变量必须全部交付（bare exit = 隐式交付全部）。

生成完跑 `node <CLI> validate <spec>` 核验零 error。

## check 失败反馈：显式 last_err 通道（推荐）

`subtask retry` 里想让"重跑步据上轮错误定向修正"在 **spec 数据流里显式可见**（而非靠引擎隐式注入），用**显式反馈变量**模式：

```markdown
1. [act] init                 # 在 subtask 外初始化反馈通道
  + → last_err: text = ""      # init 空串
  > init
2. [subtask retry=3] work
  + → out: text
  2.1. [reason] 生成或修正
    - ← last_err                # 显式读上轮错误：空=首轮全新，非空=据它定向修正
    + → out: text
    > last_err 空=新生成；非空=依据 last_err 修正对应处
  2.2. [check final] 门（失败回填 last_err）
    - ← out, last_err           # 更新模式（← last_err 且 → last_err）
    + → ok: bool
    + → last_err: text          # 失败时写错误说明、通过时置空
    > ok=false→last_err=错误清单；ok=true→last_err=""
```

**要点**：
- `last_err` 在 subtask 外的前序步 `= ""` 初始化一次；扁平命名空间下 subtask 内的 check/reason 读写的就是同一个变量（容器不是作用域）。
- check 步用**更新模式**（`← last_err` 且 `+ → last_err`）回填；check 判 false 时引擎先写更新模式输出再 fail——回填值不丢，重跑轮 `← last_err` 读到（fail 不碰值空间，变量跨重试自然保留）。
- 重跑 reason 步 `← last_err` **显式**读上轮回填——"据错误修正"是 spec 里看得见的数据依赖。

> 对比：引擎另有隐式「带反馈重跑」（升级阶梯第 1 档，check text 槽经重跑上下文自动注入）——能跑但反馈不在 spec 数据流里显式。**优先用显式 last_err 通道**。
