%% @trace
	id: hopjit-py-sandbox
	source: [[../concepts/HopSpec V3扩展-Python语法沙箱]]
	source_id: hopspec-v3-python-syntax-sandbox
	type: extend
	last_sync: 2026-09-23T12:12+0800
	note: py-sandbox 模块设计——Python 语法沙箱的引擎落地:检查器(随包发布的 Python 脚本,三条规则)+ 执行契约(审的字节即跑的字节/python3 -I/系统沙箱在场即套)+ 接进 run_script。2026-09-23 立(作者定"先出 docs/design/ 的对应设计,再动 src/")。概念锚点同名沿用(先例 anc-config-sandbox-filesystem),本文件是各锚点的实现契约。
%%

# py-sandbox 模块设计（Python 语法沙箱）

概念权威见 [[../concepts/HopSpec V3扩展-Python语法沙箱]]。本文件回答三件概念层不管的事：检查器具体长什么样、审过之后引擎怎么跑、它和已发布的 `run_script` 怎么接。

## 文档结构与内容分级

| 级别 | 节 |
|------|-----|
| 【决策】 | 模块定位 / 检查器为什么是随包 Python 脚本 / 与 run_script 的关系收窄 |
| 【契约】 | 白名单三表 / 检查器 HopTrait+HopType+HopSop / 执行契约 HopTrait+HopSop / 系统沙箱探测 |
| 【说明】 | 工程偏差 / 正反例 |

## py-sandbox 模块定位【契约】 ^anc-struct-py-sandbox

> **模块版本**：py-sandbox `v0.1.0`（2026-09-23）。首版=检查器三条规则 + 执行契约 + 接进 `run_script`（todo/0110 的正解通道,概念层 2026-09-23 作者三拍定案）。
> - 0.x 未承诺稳定；**白名单内容是稳定契约**——只加不减,减一个条目会让已交付的产物脚本一夜之间不合法（概念层 §2.2 "收窄比放宽难"）。
> - **逐版演进史归 git log**（本行只记现行版本,每次升版此处只改号）。

**① 自身定位**：py-sandbox 模块实现 **Python 语法沙箱**——对一份由执行模型写出来的真 Python 脚本做静态审查（按白名单核对源码里的每个名字），审过才执行，执行时尽可能套上操作系统沙箱。它是"产物代码"这一面的安全通道，与 hop_python（编排代码，[[act-body]]）是对偶关系：hop_python 由引擎解释执行、不能 import；产物由独立的 CPython 子进程执行、可以 `import` 白名单内的模块。

**② 文件构成（2 件）**：
- `src/py-sandbox.ts`——引擎侧编排：读原始字节 → 写私有副本 → 调检查器 → 审过则执行副本 → 清理。对外两个函数（见⑤）；
- `scripts/pysb/pysb_check.py`——检查器本体（三条规则的唯一实现），随 npm 包发布，由宿主 `python3` 运行。**为什么是 Python 脚本而不是 TS 代码**见下 `^anc-pysb-model`。

**③ 边界（负责什么 / 不碰什么）**：
- **负责**：检查器三条规则、白名单三表、私有副本与清理、`python3 -I -B` 启动形态、系统沙箱探测与套用、拒绝报文的可操作文本。
- **不碰**：命令白名单核对与 spawn 失败分辨（交命令执行原语 [[act-body#^anc-exec-command-primitive]]，本模块两次子进程——检查器与产物——都经它发出）；工具注册、读权限链、扩展名定解释器（交 tools 模块的 `run_script`，[[tools/run-script]]）；产物对不对（交规约自己的正反样例判据——审过≠脚本是对的）。

**④ 跨模块关系**：
- 依赖：`command-exec.ts`（act-body 模块，同在核心层）+ node 内置；
- 被依赖：tools 模块 `executeRunScript`（`.py` 脚本一律经本模块执行）；
- 定层：引擎核心层（层 1）——只依赖同层原语与 node 内置，不认识 ToolDef/ToolResult（那是适配层的形态），与 command-exec 同一个"两边都能用"的站位（判据 [[module-principles#^anc-meta-module-layering]]）。

**⑤ 对外接口清单【封闭】** ^anc-struct-py-sandbox-exports：

> 本表是 py-sandbox 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `py-sandbox.ts`。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `runSandboxedPython` | 函数 | py-sandbox.ts | 审查+执行一份 `.py` 脚本（tools 模块 run_script 调） | stable |
| `checkPythonScript` | 函数 | py-sandbox.ts | 只审不跑（测试与将来的交付前复审用——`^anc-pysb-artifact-form` 的"加标头后再审一遍"消费点） | stable |
| `PySandboxOptions` | 类型 | py-sandbox.ts | 两个函数的策略参数（解释器名/命令白名单/超时/输出上限） | stable |
| `PyCheckViolation` | 类型 | py-sandbox.ts | 一条拒绝记录 `{line, name, reason, alternative}` | stable |
| `PySandboxRunResult` | 类型 | py-sandbox.ts | 执行结果：被拒（带拒绝记录与报文）或跑完（带回执与防护等级） | stable |
| `PyCheckResult` | 类型 | py-sandbox.ts | `checkPythonScript` 的返回：通过，或被拒（带拒绝记录与报文） | stable |

> **内部（表外即内部）**：私有副本的建与删、系统沙箱探测、seatbelt profile 常量、拒绝报文排版函数、拒绝报文末行的表一清单常量（与检查器 `MODULE_SYMBOLS` 同表两处，测试钉住两处一致）。

## 设计层落点：检查器为什么是随包发布的 Python 脚本【决策】 ^anc-pysb-model

概念层 §二 的核心形态是"引擎不执行产物，只审产物"，并在规则一里锁死了"必须用 CPython 自己的 `ast.parse` 按原始字节解析"。落到本库（TypeScript 引擎），推演只有一条路：

- TS 里没有 CPython 解析器，用 TS 另写一份 Python 解析器正是规则一禁止的形态（UTF-7 编码声明、NFKC 标识符归一两类分歧）；
- 所以检查器必须是一段 Python 代码，由宿主 `python3` 运行。它随引擎发布（`scripts/pysb/pysb_check.py`，写进 `package.json` 的 `files` 与发版资产核对清单），不是宿主自备；
- 这不引入新依赖：产物要实跑本就需要 `python3`，而 `run_script` 的前提就是操作者已把 `python3` 放进命令白名单。

**检查器与产物用同一个解释器**。检查器从运行它的那个 Python 的 `ast` 模块机械导出节点字段名（属性白名单的一半），而产物也由同一个 `python3` 执行——审查所依据的语法版本与执行所依据的语法版本一致。检查器本身也经命令执行原语发出、受同一份命令白名单管，引擎不给自己开一条绕过白名单的暗道。

**检查器是可信代码，产物不是**。检查器只做解析与遍历，不执行被审脚本的任何部分；它以 `python3 -I -B` 启动（不读环境变量、不把被审脚本所在目录放进模块搜索路径、不在包目录里写字节码缓存）。

## 白名单三表【契约】

白名单的权威内容就是下面三张表，检查器里的常量与本节逐条对应。**入名单的前提**（概念层 §2.2）：条目本身不是模块对象，且从它出发（含返回值）经非下划线属性若干跳内爬不到模块、帧、代码对象或内置函数；加条目走引擎发版流程并附属性图验证结果，见 `^anc-pysb-whitelist-authority`。

**表一：模块符号（规则二，18 个）**

| 模块 | 放行的符号 |
|---|---|
| `ast` | `parse` `walk` `FunctionDef` `AsyncFunctionDef` `ClassDef` `get_docstring` `iter_child_nodes` |
| `re` | `match` `search` `findall` `sub` `split` `escape` |
| `json` | `loads` `dumps` |
| `sys` | `argv` `exit` `stderr` |

18 个都是"可以当值用"的条目（`sorted(xs, key=re.escape)` 合法）。

**表二：内置名（规则三，31 个）**

| 类别 | 名字 | 用法许可 |
|---|---|---|
| 输出与构造 | `print` `len` `range` `int` `str` `float` `bool` `list` `dict` `set` `tuple` | 可当值用 |
| 迭代与聚合 | `enumerate` `sorted` `reversed` `sum` `min` `max` `any` `all` `abs` `zip` `map` `filter` | 可当值用 |
| 其他 | `isinstance` `repr` | 可当值用 |
| 文件 | `open` | **只许直接调用**；模式实参（第二个位置实参或 `mode=`）缺席或是字面量 `'r'`/`'rb'`/`'rt'`；不许 `*`/`**` 展开实参 |
| 异常类 | `Exception` `ValueError` `KeyError` `OSError` `SyntaxError` | 可当值用 |

判定"是不是内置名"用运行检查器那个 Python 的 `dir(builtins)` 全集加一切下划线开头的名字——**不在表二里的内置名一律拒**（这是白名单，不是"只禁 eval/exec"的黑名单）。脚本自己定义的普通名字（变量、函数、类）不是内置名，不查表二，但它们不许与内置名或已导入的模块名同名（规则二、规则三的"不许重新绑定"）。

**表三：对象属性名（规则三）**

| 来源 | 内容 |
|---|---|
| 机械导出 | 运行检查器那个 Python 的 `ast` 模块里一切 `ast.AST` 子类的 `_fields` 与 `_attributes`（`body` `name` `lineno` `end_lineno` `id` `value` `args`……），不手列 |
| 手列：字符串 | `strip` `lstrip` `rstrip` `split` `rsplit` `splitlines` `join` `startswith` `endswith` `replace` `lower` `upper` `find` `rfind` `count` `isdigit` `isalpha` `isspace` `isidentifier` `partition` `rpartition` `removeprefix` `removesuffix` `ljust` `rjust` `center` `zfill` |
| 手列：列表/字典/集合 | `append` `extend` `insert` `pop` `remove` `index` `sort` `reverse` `copy` `clear` `get` `keys` `values` `items` `setdefault` `update` `add` `discard` `union` `intersection` `difference` `issubset` |
| 手列：文件句柄 | `read` `readline` `readlines` `close` |
| 手列：正则匹配结果 | `group` `groups` `start` `end` `span` `groupdict` |

**明确不入**（写出来即拒，拒绝报文给替代写法）：`format` `format_map`（运行期解释模板里的属性链——用 f-string）、`write` `writelines` `truncate`（产物不落盘——报错输出用 `print(…, file=sys.stderr)`）、`fileno` `buffer` `detach` `reconfigure`、帧与代码对象的一切属性。下划线开头的属性恒不在表内。

属性是按名字放行的（静态检查不知道 `x.read` 里的 `x` 是什么类型），所以模块名后面的 `.符号` 走表一，其余一切 `.属性` 走表三；`match` 语句里的类模式关键字（`case C(attr=…)`）也是取属性，同走表三。

## 检查器【契约】 ^anc-pysb-defenses

**能力契约（HopTrait）**：

```
# Spec: Python 语法沙箱检查器
Id: pysb_check.py <脚本路径> -> stdout JSON
Goal: 按三条规则静态审一份 Python 脚本,输出逐条拒绝记录;不执行被审脚本的任何部分
Inputs:
- 脚本路径: line   # 命令行第一个参数;检查器以二进制模式读该文件的原始字节
Outputs:
- 审查结论: yaml   # stdout 恰好一行 JSON,形态见下 HopType
Constraints:
- 规则一:原始字节直接交 ast.parse(字节)——不先解码成文本(编码声明由 ast.parse 自己照 CPython 语义处理);
  解析失败=一条拒绝记录(name='<语法>'),不是检查器自身失败
- 规则二:只许 `import 模块` 且模块 ∈ 表一的模块列;禁 from 形态、禁 as、禁带点模块名;
  模块名在 Load 位置只许作为 `模块.符号` 的左半且该组合 ∈ 表一;模块名不许出现在任何绑定位置
  (赋值/增强赋值/注解赋值目标、形参含 lambda 形参、for/with/推导的目标、except as、
  def/class 名、match 捕获名、global/nonlocal 声明、import 别名)
- 规则三:Load 位置的内置名 ∈ 表二,否则拒;表二条目按用法许可核(open 只许直接调用+模式字面量+不许展开);
  内置名与下划线开头名不许出现在绑定位置;一切 `.属性`(模块符号除外)∈ 表三;match 类模式关键字 ∈ 表三
- 下划线开头的名字/属性单独报错(拒绝报文更好懂),不是独立防线
- 每条拒绝记录带替代写法(知道的给具体替代,不知道的给该类名单的指路);同一行同一名字同一原因只报一次
- 退出码:审完(不论过没过)恒 0;检查器自身出错(读不到文件/内部异常)非零且 stderr 写原因
  ——引擎据此区分"脚本被拒"(模型可改)与"检查器坏了"(引擎故障,不该让模型去改脚本)
```

**类型约定（HopType）**：

- 检查器 stdout：`{"ok": true}` 或 `{"ok": false, "violations": [<拒绝记录>...]}`，恰好一行 JSON；
- 拒绝记录 `PyCheckViolation`：
  - `line: int`——违规所在行号（语法错误取解析器报的行，拿不到时为 0）；
  - `name: string`——违规的那个名字，按源码形态写（`import pathlib` 记 `pathlib`，`os.path` 记 `os.path`，`x.format` 记 `.format`，`open` 模式违规记 `open`）；
  - `reason: string`——为什么被拒，一句完整的话（"`pathlib` 不在模块白名单内"）；
  - `alternative: string`——替代写法（"读文件用内置 `open(路径)`，只读模式"），没有具体替代时写该类白名单清单。
- `PyCheckResult`（`checkPythonScript` 返回）：`{ok: true}` 或 `{ok: false, violations, message}`，`message` 是给执行模型看的排版文本（见下"拒绝报文"）。

**关键逻辑（HopSop）**：

```
pysb_check(脚本路径):
1. [act] 字节 = 二进制读(脚本路径);读失败 → stderr 写原因,退出码 2
2. [act] 树 = ast.parse(字节);SyntaxError → 输出单条拒绝 {line, name:'<语法>', reason: 解析器原文} 并结束
3. [act] 父表 = 每个节点 → 其父节点(判"模块名是否紧跟 .符号"、"open 是否处于调用位"都要看父节点)
4. [loop for-each 节点 in walk(树)] 规则二·import 形态
   4.1 [条件(ImportFrom)] 拒"from 形态",替代"改写成 import 模块,用 模块.符号"
   4.2 [条件(Import)] 逐个别名:带 as/带点/模块 ∉ 表一 → 拒;否则记入 已导入模块
5. [loop for-each 节点 in walk(树)] 绑定位置核对
   5.1 取该节点绑定的名字(见 HopTrait 规则二的绑定位置清单;import 别名本身不算,4 已管)
   5.2 [条件(名字 ∈ 已导入模块 或 ∈ 内置名全集 或 下划线开头)] 拒"不许绑定名字 X"
6. [loop for-each 节点 in walk(树)] 名字与属性核对
   6.1 [条件(Attribute 且左半是已导入模块的 Load 名字)] 跳过(交 6.3 核)
   6.2 [条件(其他 Attribute)] 属性名 ∉ 表三 → 拒(format/write 等给专项替代)
   6.3 [条件(Load 名字 ∈ 已导入模块)] 父节点不是以它为左半的 Attribute → 拒"模块不许当值";
       组合 ∉ 表一 → 拒"模块.符号 不在白名单"
   6.4 [条件(Load 名字 ∈ 内置名全集 或 下划线开头)] ∉ 表二 → 拒;
       ∈ 表二且只许直接调用(open) → 核调用位/展开/模式字面量
   6.5 [条件(MatchClass)] 关键字属性名 ∉ 表三 → 拒
7. [act] 拒绝记录按 (行号, 名字, 原因) 去重、按行号排序;stdout 输出 JSON,退出码 0
```

**拒绝报文**（`checkPythonScript` 把拒绝记录排版成给模型看的文本，概念层 §2.3 的报文形态要求）：

```
Python 语法沙箱审查未通过,脚本没有执行。逐条改完再跑:
- 第 3 行 `pathlib`:pathlib 不在模块白名单内。替代:读文件用内置 open(路径),只读模式
- 第 7 行 `.format`:format 会在运行期解释模板里的属性链,不在属性白名单内。替代:拼字符串用 f-string
可用的模块符号:ast.parse ast.walk …(表一全列)
```

末行固定附表一全列——模型改写时最常需要的就是"到底能 import 什么"，一次给全比让它逐个试省轮数。

## 执行契约【契约】 ^anc-pysb-exec

**能力契约（HopTrait）**：

```
# Spec: 审查并执行一份 Python 脚本
Id: runSandboxedPython(scriptPath, args, opts) -> PySandboxRunResult
Goal: 审的字节就是跑的字节——审过才执行,执行的是审过的那份私有副本
Inputs:
- scriptPath: line      # 脚本绝对路径(调用方已过读权限链、已确认文件在场)
- args: [line]          # 传给脚本的参数
- opts.interpreter: line   # 解释器命令名(run_script 按扩展名表给 'python3')
- opts.whitelist: [line]   # 命令白名单(sandbox.runtime.available,原样转交原语)
- opts.timeoutSec: number  # 产物执行超时(run_script 给 60)
- opts.maxBuffer: int      # 产物单流输出上限(run_script 给 64KB)
Outputs:
- result: yaml   # 见下 HopType
Constraints:
- 原始字节只读一次;私有副本写在 os.tmpdir() 下新建的 hopjit-pysb-<随机> 目录,保留原文件名
  (该目录不匹配 work_zone 判定,执行模型的写工具写不进去);检查器审副本、产物执行副本,不再按原路径读盘
- 检查器与产物两次子进程都经命令执行原语发出(同一份命令白名单、同一套失败指路);两者都以 `-I -B` 启动
- 产物的工作目录 = 原脚本所在目录(脚本读同目录的样例文件用相对名);副本在别处,-I 让副本目录与工作目录都不进模块搜索路径
- 审查没过 → 不执行,返回被拒结果(不抛错——被拒是模型可改的正常结果,不是故障)
- 检查器自身失败(非零退出/输出不是约定 JSON)→ 抛错,报文写明"检查器自身运行失败"与 stderr 摘要
- 系统沙箱在场即套上,缺席照跑并标 syntax-only(见 ^anc-pysb-os-independence)
- 临时目录在 finally 里删除——不论审过与否、执行成败
- 超时/撞顶/白名单拒等原语抛出的错误原样上抛,由调用方包装(与原语"只抛不翻译"同一分工)
```

**类型约定（HopType）**：

- `PySandboxRunResult` 二选一：
  - 被拒：`{status: 'rejected', violations: PyCheckViolation[], message: string}`——`message` 即上节拒绝报文；
  - 跑完：`{status: 'ran', stdout: string, stderr: string, returncode: int, defense: 'syntax+os-sandbox' | 'syntax-only'}`——`returncode` 非零照样是跑完（失败是值）；`defense` 是本次执行实际获得的防护等级，写进工具回执、随 hoplog 的工具结果预览入账。

**关键逻辑（HopSop）**：

```
runSandboxedPython(scriptPath, args, opts):
1. [act] 字节 = 读(scriptPath)(一次)
2. [act] 私有目录 = mkdtemp(os.tmpdir()/hopjit-pysb-);副本 = 私有目录/basename(scriptPath);写入字节
3. [try]
   3.1 [act] 审查 = 原语([interpreter, '-I', '-B', 检查器路径, 副本], {whitelist, timeoutSec: 30,
              maxBuffer: 1MB, label: 'Python 语法沙箱检查器'})
   3.2 [check] 审查.returncode≠0 或 stdout 解析不出约定 JSON → 抛"检查器自身运行失败"
   3.3 [条件(审查.ok == false)] 返回 {status:'rejected', violations, message: 排版(violations)}
   3.4 [act] 系统沙箱 = 探测()(见下节)
   3.5 [act] 回执 = 原语([interpreter, '-I', '-B', 副本, ...args], {whitelist, cwd: dirname(scriptPath),
              timeoutSec, maxBuffer, label: 'run_script', wrapperArgv: 系统沙箱.前缀})
   3.6 返回 {status:'ran', ...回执, defense: 系统沙箱 ? 'syntax+os-sandbox' : 'syntax-only'}
4. [finally] 删除私有目录
```

检查器路径 = 包根下 `scripts/pysb/pysb_check.py`，包根由本文件编译产物位置推出（`dist/` 的上一级），不读进程工作目录。检查器超时给 30 秒、输出上限 1MB——它的输出是拒绝记录，正常远小于此；撞了说明被审脚本异常巨大，按原语的响亮失败处理。

`wrapperArgv` 是命令执行原语为本模块新增的可选项（[[act-body#^anc-exec-command-primitive]] v0.24.0）：原语照旧只核 `argv[0]`（解释器）的白名单与 hopjit 恒拒，spawn 时把前缀拼在最前面。前缀由引擎内部给定（固定的 `sandbox-exec -p <profile>`），不来自模型也不来自规约，所以不受命令白名单管——白名单管的是"这台机器允许跑什么程序"，套一层系统沙箱只会让能力更小。

## 系统沙箱：探测与套用【契约】 ^anc-pysb-os-independence

概念层定了三条：**准入判据不依赖系统沙箱；在场即必须套上；缺席照跑并如实标明单层防护**。实现落点：

| 平台 | 系统沙箱 | 探测 | v1 状态 |
|---|---|---|---|
| macOS | seatbelt（`sandbox-exec`） | 每次执行前跑 `sandbox-exec -p <profile> /usr/bin/true`，退出码 0 即在场 | 已实现 |
| Linux | bwrap | — | 未实现，按缺席处理（工程偏差③） |
| 其他 | 无等价轻量件 | — | 按缺席处理 |

**seatbelt profile**（固定常量）：

```
(version 1)(allow default)(deny network*)(deny process-fork)(deny file-write*)
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))
```

三条 deny 对应产物能力面之外的三类动作：连网、起子进程、写盘。白名单已经让这三类在源码里写不出来，profile 是白名单万一漏了一个符号时的第二道。

**探测为什么是"实跑一次"而不是"看命令在不在"**：`sandbox-exec` 在场但不可用的情形真实存在——本机实测，在 Claude Code 自己的沙箱里嵌套调用 `sandbox-exec` 报退出码 71（嵌套 seatbelt 被拒）。

- 只看可执行文件在不在，会把"在场但套不上"误判为在场，产物执行随之以退出码 71 失败，模型读到的是一个与它的脚本毫无关系的错误；
- 实跑一次 `/usr/bin/true` 失败即按缺席处理，产物照跑、标 `syntax-only`；
- 探测每次执行前做一次，不缓存（开销约十毫秒；缓存就要引入模块级可变状态，与 run 隔离守卫相抵）；
- 探测进程是引擎内部的固定命令，不经命令白名单。

## 白名单的归属【契约】 ^anc-pysb-whitelist-authority

概念层 §2.4：引擎内置基础名单，宿主只能做减法；spec 用 `requires_modules` 声明依赖、INIT 时对账。

**v1 实现状态**：引擎内置名单已落地（就是上面三张表，常量在检查器里）；**宿主减法配置与 `requires_modules` 对账都未落地**（工程偏差①）。v1 下宿主对名单没有任何配置入口，名单就是引擎内置那一份——这比"宿主只能做减法"更严，不违反概念层的上限约束。

## 交付形态【契约】 ^anc-pysb-artifact-form

概念层 §2.5：引擎填写机器生成标头（不带时间戳）+ 最小确定性规整 + 加标头后再审一遍。

**v1 实现状态：未落地**（工程偏差②）。原因：交付发生在 `[commit]` 步，标头字段（来源规约、对应条款、run_id）要从规约的结构化产出里取，这需要一个"交付 Python 产物"的专门动作（工具或 commit 内置），v1 的 `run_script` 只管"验证期执行"这一段。预留的消费点是 `checkPythonScript`：加完标头后的再审一遍调它。

## 与 run_script 的关系收窄【决策】

`run_script` 2026-09-22 发布时（[[tools/run-script]]），`.py` 脚本审都不审直接交给 `python3`，它的真实安全边界只是"操作者放行了 python3 + 规约作者在那一步写了 `- 工具: run_script`"两道人的授权（其工程偏差①的原话："白名单只管住解释器，管不住脚本内容能再 spawn 什么"）。本模块落地后收窄为：

- **`.py` 脚本一律先过语法沙箱**——`executeRunScript` 的第 ⑤ 步从"直接调原语"改为调 `runSandboxedPython`。审不过不执行；
- **run_script 的工程偏差①由此关上**：脚本里写不出 `subprocess`、`os`、写模式 `open`，"管不住脚本内容能再 spawn 什么"不再成立；
- **两道人的授权仍然保留**：语法沙箱不替代"操作者放行 python3"与"规约作者声明 `- 工具: run_script`"，三者叠加；
- **不跑语法沙箱的开关不存在**。宿主与规约都不能关掉审查——一旦可关，`run_script` 就回到"模型现场决定跑任意代码"的形态（概念层 §2.3 的三方授权对照表中间那一行）。

**审查被拒在 run_script 上的映射**（概念层 §2.3 "本步失败，进重试链"的落地）：

1. 工具层：`run_script` 返回 `ToolResult{success: false, result: 拒绝报文}`。模型在同一个工具循环里就能照报文改写脚本再调——这是第一道、也是最便宜的一道反馈环；
2. 步级：模型若放弃改写、或带着"没跑通"的状态交出产出，由该步自己的产出契约与后续 `[check]` 判失败，走引擎既有的重试链；耗尽按普通步骤失败处理，不另设出口。

`run_script` 的回执 JSON 加一个字段 `defense`（取值同 `PySandboxRunResult.defense`），让执行模型与看账的人都知道这次执行的防护等级。

## 工程偏差（v1，如实标注）

1. **白名单归属只落了"引擎内置"一半**：宿主减法配置与 spec 的 `requires_modules` 声明及 INIT 对账未实现（`^anc-pysb-whitelist-authority`）。v1 没有配置入口，名单恒为引擎内置那份；
2. **交付形态未落地**：机器生成标头、最小规整、加标头后复审都未实现（`^anc-pysb-artifact-form`），等"交付 Python 产物"的专门动作一并做；
3. **Linux bwrap 未实现**：Linux 上恒按系统沙箱缺席处理，产物照跑、标 `syntax-only`。概念层允许缺席照跑，这不是违约，是少了一层冗余；
4. **body 面的 `subprocess.run` 不走语法沙箱**：规约作者在 hop_python body 里写死的 `subprocess.run(["python3", "x.py"])` 仍直接执行。那条通道的授权主体是规约作者（生成期白纸黑字、人能 review，概念层 §2.3 对照表第一行），与本模块管的"模型运行期生成的脚本"不是一回事；
5. **检查器与产物同一个 `python3`，但 `python3` 是谁由宿主 PATH 决定**：换机器换版本，机械导出的属性表三随之变化（新版本 `ast` 多了字段就多放几个字段名）。这些字段名都是语法树节点的数据字段，放行它们不引入能力；手列部分不随版本变。

## 正反例

- **正**：sdc 的守卫脚本（`import ast, sys` + `open(sys.argv[1]).read()` + `ast.walk(ast.parse(src))` + `n.end_lineno - n.lineno + 1 > 40` + `print(…, file=sys.stderr)` + `sys.exit(1)`）审过、执行，`run_script` 回 `{"returncode": 1, "stdout": …, "stderr": …, "defense": "syntax+os-sandbox"}`；
- **正**：`sorted(xs, key=len)`、`sorted(xs, key=lambda s: -len(s))`、`list(map(re.escape, ys))`、`str.lower('A')` 放行（表一表二条目可当值用）；
- **反**：`import os` → 拒，脚本没有执行，报文点名第几行、`os` 不在模块白名单、附可用模块符号全列；
- **反**：`open('out.txt', 'w')` → 拒，报文说明产物只读、报错输出用 `print(…, file=sys.stderr)`；
- **反**：`f = open`、`map(open, …)`、`open(*args)`、`open('x', m)`（`m` 是变量）→ 拒，`open` 只许直接调用且模式须是字面量；
- **反**：`__builtins__.eval('1')`、`breakpoint()`、`type(1)`、`'{0.__class__}'.format(1)`、`g.gi_frame`、`re.enum.sys`、`sys.modules['os']`、`f(re)`、`re = open`、`from re import match`、`import os.path`、UTF-7 编码声明、全角 `ｅval` → 全部拒（概念层 §2.2 实测对照清单逐条成为测试用例）；
- **反（审过的不是跑的）**：审完之后原路径上的文件被换成别的内容 → 执行的仍是审过的私有副本，换掉的文件不会被执行；
- **反（冒牌标准库）**：模型在脚本旁边写一个 `json.py`，脚本只写 `import json` → 以 `-I` 启动，加载的是标准库 `json`，冒牌文件不生效；
- **反（系统沙箱在场但套不上）**：`sandbox-exec` 存在但嵌套调用报 71 → 探测失败按缺席处理，产物照跑、`defense` 标 `syntax-only`，而不是让产物以 71 失败。
