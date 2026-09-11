%% @trace
	id: hopjit-tutorial-hop-python
	source: [[../concepts/HopSpec V3语法参考]]
	source_id: hopspec-v3-syntax-ref
	type: compact
	last_sync: 2026-09-05T18:17+0800
	note: 开发者系列 D10——hop_python 计算体(定位:agent 代写的简单逻辑代码呈现,人读得懂核得对;2026-08-30 作者定自用户主线 04 位移入——受限子集/白名单/禁令细节对"用 spec 的人"过深,对"写引擎周边的人"恰好)（文法权威在语法参考 §5，本文回答"什么该写成 body、怎么写、错了会怎样"）
%%

# D10 · hop_python：把不该动脑的事锁死

**目标**：学会给 `act`/`commit` 步骤写 hop_python 计算体（body），理解"谁推理、谁计算"这条 HopSpec 核心分界在写 spec 时怎么落地。
**前提**：完成 [[03-探索与提交]]（act 的可逆语义在那篇）。

## 为什么需要它

教程 1 跑 coffee-week 时你见过一句话："`[act]` 带 `hop_python` body——**引擎自己算，连 LLM 都不经过**，sum/max/min 跑一万次都一样。"

这就是 hop_python 存在的全部理由：**求和、切分、拼接、按阈值分流这类事没有任何"判断"含量，让 LLM 做纯属引入不确定性**（它可能算错、可能"顺手优化"、可能每次格式不同）。写成 body 之后，这些步骤由引擎确定性执行——同样输入永远同样输出，且零 token 成本。

**先说清你的角色：这些 body 基本不用你亲手写。** 无论是 `/hopbuild` 翻译（[[07-升级你的自然语言skill]]）还是让 agent 帮你起草 spec，body 都是 agent 生成的——它就是把"简单逻辑"从散文变成代码呈现：原来写"把营业额加起来"，现在是 `total = sum(daily_sales)`，一个意思，但后者引擎能锁死执行。**你需要的是读得懂、核得对**（这段代码是不是我要的逻辑），偶尔手调一两行。本篇按这个深度讲。

一份好 spec 的形状因此很清晰：**该动脑的写 `[reason]`（交给 LLM），不该动脑的写 `[act]` + body（交给引擎），有不可逆副作用的写 `[commit]` + body（前面加把关闸门）。**

## 第 1 步：跑一个纯计算的

Claude Code 命令：

```
/hopspec run examples/syntax/act-body.md --params '{"expenses": [120, 88, 1500, 260], "auto_limit": 2000}'
```

Codex 命令：

```
$hopspec run examples/syntax/act-body.md --params '{"expenses": [120, 88, 1500, 260], "auto_limit": 2000}'
```

这是一个报销单核算：合计、找最大单笔、按公司规则判审批级别。两个 act 步骤全带 body，整个执行**一次 LLM 都没调**——你会看到它几乎瞬间完成，而且**金额账绝不会算错**（这正是不让 LLM 心算金额的理由）。这类 spec 在独立模式下同样一分钱推理费都不花。

## 第 2 步：读懂 body 的样子

```markdown
1. [act] 合计与找最大单笔
  - ← expenses
  + → total: int
  + → biggest: int
  > ```hop_python
  > total = sum(expenses)
  > biggest = max(expenses)
  > item_count = len(expenses)
  > ```
```

像 Python，但**不是 Python**——它是 HopSpec 的受限编排方言（`hop_` 前缀就是这个意思）。它被刻意限制得很小，正因为写它的主要是 agent：**能力面越窄，agent 生成的 body 越无处藏错，你核对越轻松**。只能做四类事：

1. **基础运算**：算术 `+ - * / % // **`、字符串拼接与重复（`"-" * 3`）、比较、`and/or/not`、`in`/`not in`、字段/下标访问（含负数下标 `items[-1]`）、切片 `items[1:3]`/`s[5:]`（端点可省可负，越界钳位不报错；无步长形态 `l[::2]`——反转用 `reversed(l)`，隔位取用 `[l[i] for i in range(0, len(l), 2)]`）、字面量构造 `[1, x]`/`{"k": v}`（字典键同 Python——固定键名加引号,`{key_var: v}` 变量键求值作键名）、f-string `f"共{n}条"`；
2. **白名单函数**：与 Python 同名同义的一组 pure 函数——数值 `len` `sum` `min` `max` `round` `abs`｜文本 `lower` `upper` `strip` `split` `join` `replace` `startswith` `endswith`｜文本剥壳与解码 `strip_fence`（剥 LLM 产文本外层的代码围栏壳，第二参 key 可选——给出时连剥 `key:` 首行前缀）`parse_json`（JSON 文本转结构值，工具返回的 json 字符串取字段就靠它；幂等——入参已是结构值时原样返回,解析过的东西再过一遍无害）｜序列 `sorted` `reversed` `range` `count`（**单参列表计数**——`count(xs)` 数列表元素个数；给它字符串会报"期望数组"，Python 里 `str.count` 数子串的双参形态这里没有）｜谓词 `any` `all`｜结构 `keys` `values` `get`｜类型转换 `int` `float` `str` `bool`。再加宿主注册的工具（如 Read/Write，按工具清单的名字调）；
3. **赋值**：局部变量随便起，最终把 `+ →` 声明的输出变量赋上值；
4. **无推理分支**：`if 确定性条件:` / `elif` / `else`——条件必须是确定性表达式（比大小、查成员），不能是"如果内容质量不错"这种要判断的。

**四类之外全是非法**——没有 `for`/`while`（要遍历就升成 `loop` 步骤，见 [[05-并行与遍历]]），没有 `import`，没有白名单外的函数。缩进只认空格。

**语义与 Python 对齐（心智零切换）**，几条值得知道的：

- **None 检测**：`x is None` 和 `x == None` 都行（`is` 仅限 None 判定）；
- **等值是严格的**：`"3" == 3` 为假（跨类型不相等、不报错）——不会有隐式转换帮倒忙；
- **比较要同类型**：数字比数字、字符串比字典序、列表逐元素比；拿数字跟字符串比大小 = 计算异常（该步失败），不会静默给个错误结果；
- **列表 `+` 是拼接**：`[1] + [2]` 得 `[1, 2]`，同 Python；
- **列表推导可用**：`[i.name for i in inputs]`、带滤 `[x for x in xs if x > 0]`——纯映射/过滤（`for`/`while` 语句仍然没有，那是 `loop` 步骤的事）；
- **真值也是 Python 的**：`if xs:` 对空列表/空对象/空串/0/None 都判假——判空写裸真值就对，全类型工作。

这些"较真"不是苛刻——body 的全部价值就是确定性，宁可失败也不静默算错。

### `yaml` 类型的变量：拿到手就是结构

声明为 `yaml` 的变量（`+ → contract: yaml`）在 hop_python 里**是真结构（对象/列表），不是一段文本**。名字里的 "yaml" 说的是它的书写与展示语法——LLM 产出时写 YAML 文本、看它时也看到 YAML 文本，但引擎在边界上自动转换（产出时 parse 成结构入库，给 LLM 看时序列化回文本），所以你在 body 里**直接取字段，不需要任何 parse**：

```markdown
2. [act] 从契约提取输入名单
  - ← contract
  + → names: [line]
  > ```hop_python
  > names = [i.name for i in contract.inputs]   # 字段链、推导直接用
  > has_goal = len(contract.goal) > 0            # len 对对象=键数,对列表=元素数
  > ```
```

要把结构变回文本时才显式转：`str(x)` 或 f-string 插值得到序列化文本，`write(path: p, content: x)` 落盘自动写文本。反过来记住一条：**LLM 步骤给 `yaml` 变量交纯散文是过不了关的**——引擎要求能解析出结构（对象/列表），解析不出会带着反馈打回重做，不会把一段说明文字静默存进来（否则下一步 `contract.inputs` 就是 undefined，错误漂到离病灶很远的地方才炸）。

### 实例上下文函数：work_zone_path / now / today

白名单里还有三个**实例上下文函数**——不是 pure（结果依赖这次执行的环境），但也零副作用，只能在 act/commit body 里调（case 条件里调用是静态错误）：

- `work_zone_path("文件名")`：返回本实例独占涂鸦区下的路径，无参返回涂鸦区根。act 步的中间产物、草稿、台账都写这里——act 的写域就是涂鸦区，写别处会被引擎拒（见第 3 步的静态闸）；
- `now()`：当前时刻，ISO 8601 字符串（含时区），产物落款用它；
- `today()`：当前日期，YYYY-MM-DD。

时间值有个贴心设计：首次求值记进本步执行账，崩溃恢复重放时取记录值不取新值——同一步骤里时间戳不会因为重放而漂移。

### subprocess.run：在 body 里跑命令行

body 还能执行外部命令行程序，写法完全对齐 Python 的 `subprocess.run`（这是 hop_python 唯一的 `x.y(...)` 形态名字）。前提是命令名在宿主 sandbox 配置的命令白名单（`runtime.available`）里——**白名单空着 = 这个能力关死**，引擎不内置任何命令：

```python
r = subprocess.run(["git", "diff", "--stat"])    # 命令与参数一个列表,一个参数一个元素
ok = r.returncode == 0                            # 结果是结构体,字段名同 Python
hits = r.stdout
```

三条最容易踩的线：不能写整串命令行（`subprocess.run("git diff")` 会找一个叫 "git diff" 的命令）；没有 `shell=True`（shell 走私进来白名单就废了）；没有 `check=True`（失败是值不是异常，returncode 的处置写 check 步或分支）。只认 `input=`/`timeout=`/`cwd=` 三个具名参数。完整正反例与管道写法见 `docs/concepts/HopSpec V3语法参考.md` §5 的 subprocess.run 专节。

**白名单怎么配**（作者定 2026-09-05"研发阶段可以把 bash 开放给用户，先跑起来，以后再收敛——配置项就是开关"）：配置写在项目根的 `hopjit.yaml`（跟项目走）或系统级 `~/.hopjit/config.yaml`（跟人走），两级取并集，键名 `commands:`。引擎核的是命令名（argv 第一个元素），参数不管——所以放行 `bash` 等于全开（`bash -c` 后面随便写），这正是研发期开关的含义。

研发阶段（宽口，先跑起来）：

```yaml
# hopjit.yaml（项目根）
commands:
  - bash        # 宽口:一切现场命令经 subprocess.run(["bash", "-c", "..."]) 跑
  - ssh         # 远程操作
```

生产收敛（点名制——spec 一字不改，只动配置）:

```yaml
commands:
  - git
  - kubectl
  - /opt/deploy/teardown.sh    # 完整路径也行
```

三条语义记牢：**缺省关死**（`commands:` 不写或为空 = subprocess.run 整个不可用——默认安全，忘配不会静默放行）；**报错自带名单**（跑到那步报 `命令 "ssh" 不在白名单（sandbox.runtime.available: git, uv, npx）`，照着往配置加一行重跑即可）；**`hopjit` 恒拒**（白名单写了也不放行——被执行的步骤不得反过来驱动引擎）。

## 第 3 步：错了会怎样（三种结局，都不含糊）

| 你写了 | 结局 |
|---|---|
| 循环关键字、白名单外函数 | `hopjit validate` 当场拒——**执行前就挡住** |
| 语法合法但算不动（如对字符串做减法） | 该步骤按失败处理，走 spec 的 retry/失败传播——**不会静默给错值** |
| 把该推理的事硬写成 body | 写不出来——body 没有"判断"能力，这是**提示你该用 `[reason]`** 的信号 |

最后一条值得展开：agent 起草时若把该判断的事硬憋成了确定性条件（或者你自己手调时想这么干），别将就——"这里得看情况"正是推理与计算的分界线。把要判断的部分拆成前面的 `[reason]` 步骤（产出一个明确变量），body 只消费判断结果：

```markdown
2. [reason] 评估修复策略           # 该动脑的
  - ← issues
  + → fix_strategy: yaml          # 明确产出：策略对象
3. [act] 执行修复                  # 不该动脑的
  - ← raw_data, fix_strategy
  + → clean_data: [yaml]
  > ```hop_python
  > if fix_strategy.clip_enabled:      # 消费判断结果——这是确定性条件
  >     cleaned = clip_outliers(data: raw_data, threshold: fix_strategy.z_threshold)
  > else:
  >     cleaned = raw_data
  > clean_data = cleaned
  > ```
```


**还有一类是写的时候就被拦**（validate 静态闸，跑都不用跑）：读文件的工具（`read`/`exists`/`listdir`）的 path 参数写成字面绝对路径（如 `read(path: "/Users/you/f.md")`）——validate 当场 error。沙箱禁绝对路径：一律写 workspace 相对路径；实例涂鸦区的文件用 `work_zone_path("文件名")` 取路径。写侧六件工具的字面路径同有静态闸（写盘归 commit 或 work_zone）。

## 第 4 步：commit 与 check——同一套文法

`[commit]` 与 `[act]` 用同一套 body 文法，区别在语义与规矩——上一篇 [[03-探索与提交]] 已讲透（不可逆、前面必有闸、尽量幂等）。样例见 `examples/syntax/confirm-commit.md`。

`[check]` 也能带同一套 body——当判定是**纯机械的**（判空、比阈值、核数组长度），写成 body 让引擎直接算，零 LLM 调用：

```markdown
5. [check] 合法关：validate 零 error
  - ← validate_result
  + → legal_ok: bool   # 判定槽
  + → why: text        # 失败说明
  > ```hop_python
  > legal_ok = '"errors":[]' in validate_result
  > why = "" if legal_ok else validate_result
  > ```
```

给不动脑的判定烧 LLM 既浪费又不可靠（LLM 判空真的会错）。不带 body 的 check 照旧由 LLM 判——那是语义面核验（"内容质量够不够"）的正当形态。两种产出方式走同一判定路径：bool 槽 false 就触发所在容器 retry。

## 何时不写 body

`act` 不带 body 也合法——按自然语言描述执行（复用模式下由载体用工具完成）。经验法则：**能用四类能力写清的就写 body**（换来确定性 + 零推理成本）；确实要靠载体工具面自由发挥的（如"打开浏览器截图"）才留自然语言。

## 下一步

- 回用户主线的 [[05-并行与遍历]] 看计算体在遍历里的用法——"对每个 X 做 Y"交给引擎；
- 完整文法与全部白名单：`docs/concepts/HopSpec V3语法参考.md` §5（hop_python body）、§4（case 条件表达式——同一文法的只读子集）；
- 变量怎么在步骤间流动、累加器怎么写：同文 §6（变量语义）；
- 更多样例：`examples/syntax/`（act-body / confirm-commit / loop-branch）。
