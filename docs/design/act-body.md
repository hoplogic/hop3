%% @trace
	id: hopjit-act-body
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-10-09T15:54+0800
	note: act-body 模块设计——hop_python 微语言实现链(解析/AST/解释/内置函数)。2026-07-02 从 exec-engine.md 抽出独立成文(被 parser/engine/prompt/validator 多方调,应独立模块独立文档)。
%%

# act-body 模块设计（hop_python）

act/commit 步骤 `> ```hop_python` 围栏内「无推理编排语言」的实现。词法/语法解析 → AST → 解释执行 → 内置函数库，一条独立的微型语言实现链。概念权威见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]，AST 类型定义在 [[spec-ast#^anc-ast-act-body]]。

## act-body 模块定位【契约】 ^anc-struct-act-body

> **模块版本**：act-body `v0.27.4`（2026-10-09 parseActBody 加可选第四参数 line_numbers——逐行真实行号,语句 line 按它取;不给时照旧 base_line + 行下标,契约 [[spec-parser#^anc-rule-act-body-line]]）。上版 v0.27.3（2026-10-08 commit 安全分析批次：出口表 evalExprSync 消费面补 engine commit 动作清单提取,签名与语义不变）。上版 v0.27.2（2026-10-08 todo/0131：subprocess.run 配置通路条复用模式半边改引 config-load 两级合并,类型名随更 HopConfig）。上版 v0.27.1（2026-10-07 spec_dir 批 review 修复：Constraints 4 补文件工具读类认 allowed 的出处;work_zone_path 步型口径对齐 act/check/commit;HopSop 3.3 用词与同族同形;类型约定补 resume/子实例 specPath 来源与 `run <spec>` 位置参数;四消费位升五位〔hopbuild v1 primer〕）;
> - 上版 v0.27.0=2026-10-06 新增 `spec_dir(rel?)` 实例上下文内置 ^anc-exec-spec-dir——spec 自带脚本与数据的寻址,与 work_zone_path 同族;todo/0145）;
> - 上版 v0.26.1=2026-10-01 工程链 review 修复：并集条加第三消费口 requires_commands 预检闸;出口表 unionApprovedCommandNames 行补签名与三消费口——行为面归 exec-engine v0.50.1,本模块条款与出口说明同步）。上版 v0.26.0（2026-09-30）。本版 body 口 subprocess.run 白名单改为 hopjit.yaml commands: ∪ 本 spec《已批准命令》段命令名（todo/0132——同一张卡不写两遍）;命令原语消费口两个→三个（mcp-server run_approved_command 加入）。上版 v0.25.0（2026-09-26）本版=字符串单下标（`s[0]`/`s[-1]`,两个求值器同扩,见 `^anc-step-act-body-str-index`）+ 括号在本行未闭合的定向报错（替换原五条连环报错,见 `^anc-step-act-body-one-line`）——todo/0102 批次。
> - 上版 v0.24.0 命令执行原语加可选项 `wrapperArgv`（系统沙箱前缀,spawn 时拼在 argv 最前;白名单与 hopjit 恒拒仍只核 argv[0]——py-sandbox 模块执行产物脚本时套 seatbelt 用,见 `^anc-exec-command-primitive`、[[py-sandbox#^anc-pysb-exec]]）。
> - 上版 v0.23.0 命令执行原语抽出独立文件 `command-exec.ts`（subprocess.run 与 tools 模块的 run_script 共用一份实现——todo/0110 候选 B 批次）。
> - 上版 v0.22.2 subprocess.run ENOENT 两因分辨报文(cwd 不存在与命令不存在各自指路——0020 批 review 实撞误诊后立)。
> - 上版 v0.22.1 禁循环早拦字符串字面量豁免条款(hopissues/0079)+推导判定同用掩后文本半句(review 补)。
> - 0.x 未承诺稳定；hop_python 受限子集语法是稳定契约——改它影响所有含 body 的 spec,破坏性变更须经概念层 `^anc-step-act-body-lang` 决策。
> - **逐版演进史归 git log**（本行只记现行版本,每次升版此处只改号）。

**① 自身定位**：act-body 模块实现 **hop_python**——act/commit 步骤 `> ```hop_python` 围栏内的「无推理编排语言」（受限子集：赋值 + 白名单调用 + if-else 语句与条件表达式，禁循环）。它是一条独立的微型语言实现链:词法/语法解析 → AST → 解释执行 → 内置函数库。

**② src 文件构成（4 件,按编译管线分 3 件 + 命令执行原语 1 件）**：
- `act-body-parser.ts`——hop_python 源文本 → ActBody AST（词法+语法,禁 tab/禁循环在此拒绝）。**禁循环早拦对字符串字面量豁免**——关键词搜索前先掩掉引号段:字符串里的英文 for/while 是数据不是语句,误拦即逼用户无意义改写业务文案:
  - 实撞出处:hopissues/0079——subprocess 参数含错误文案 'Profile changed while being read' 被拒,被迫改成 during read——文案本是错误证据;
  - 掩串判据=同行成对引号段替换为等长占位,转义引号按 hop_python 字面量语义处理;
  - **列表推导放行判定同用掩后文本**——for/bracket 位置与 while 检测都对 masked 做,推导判定改回原始行即字符串内 for 假触发推导误判
- `act-body-interpreter.ts`——ActBody AST 顺序解释执行（求值模型见下文 `^anc-exec-act-body-interp`）
- `act-builtins.ts`——内置函数白名单（与 Python 同名：len/split/strip/str/int/float/bool…）+ arity 定义,parser 校验与 interpreter 执行共用
- `command-exec.ts`——命令执行原语（白名单核对/hopjit 恒拒/spawnSync/失败三类分辨指路,见 `^anc-exec-command-primitive`）。**三个消费口**：本模块的 `subprocess.run`（body 内,规约作者写死的命令）、tools 模块的 `run_script`（工具面,执行步里模型按需跑脚本,契约 [[tools/run-script]]）、mcp-server 的 `run_approved_command`（外部 agent 在某 run 上下文里执行已批准命令,白名单位传 argv[0] 只为复用原语,真闸是任务卡前缀清单,契约 [[mcp-server#^anc-mcp-run-command]],2026-09-30）

**③ 边界（负责什么 / 不碰什么）**：
- **负责**:hop_python 的解析、AST、解释、内置函数。
- **不碰**:工具调用的实际执行（独立模式交 ToolProvider；复用模式经 `tool_request` 介入点交 caller 单工具执行）、LLM 推理（body 执行期零推理,这是其安全身份）、调度（交 engine/dispatcher）。
  - **两种模式 body 都由本模块 interpreter 解释执行**（概念层 2026-08-04 收紧,见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 原则 6）——复用模式下 interpreter 撞**引擎自有 provider 之外**的工具才挂起,由 engine 发 tool_request、收结果后续跑;
  - 执行主体原则 2026-09-05 改定,权威 [[exec-engine#^anc-exec-tool-request]] 分派判据条款:provider 命中的直执入账;原『撞非内置工具即挂起』与 v0.2.0 前『整个 body 文本交 caller』两代旧形态均废。

**④ 跨模块关系**：被 parser（解析 spec 时调 act-body-parser 解析 body）、engine（独立模式调 interpreter 执行）、validator（校验 body 规则 B1-B5）依赖。ActBody 类型定义在 spec-ast（`^anc-ast-act-body`）。

**⑤ 对外接口清单【封闭】** ^anc-struct-act-body-exports：

> 本表是 act-body 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `act-body-parser.ts` / `act-body-interpreter.ts` / `act-builtins.ts`（三件按编译管线分，各有对外面）+ `command-exec.ts`（命令执行原语——对外面给 tools 模块 `run_script`、mcp-server `run_approved_command` 共用;并集函数给 dispatcher/engine 注入点）。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `parseActBody` | 函数 | act-body-parser.ts | hop_python 源 → ActBody AST（parser 调;可选 line_numbers 逐行给真实行号,签名与语义见 [[spec-parser#^anc-rule-act-body-line]]） | stable |
| `serializeActBody` | 函数 | act-body-parser.ts | ActBody → 渲染文本（prompt 组装时给 LLM 看的 body 展示；非旧"整 body 交 caller 执行"语义） | stable |
| `extractHopPythonFence` | 函数 | act-body-parser.ts | 从 `> ```hop_python` 围栏抽 body 源（parser 调） | stable |
| `bodyHasToolCall` | 函数 | act-body-parser.ts | 判 body 是否含工具调用（engine 消化判定） | stable |
| `BodyInterpreter` | 类 | act-body-interpreter.ts | ActBody 顺序解释执行（engine/dispatcher 独立模式） | stable |
| `ACT_BUILTINS` | 常量 | act-builtins.ts | 内置函数白名单 + arity（validator 校验 B2） | stable |
| `ACT_BUILTIN_NAMES` | 常量 | act-builtins.ts | 内置函数名集合（validator/parser 查白名单；mcp-server 工具面预检） | stable |
| `parseExpression` | 函数 | act-body-parser.ts | 单表达式解析（validator 条件表达式 B 组校验/engine-traverse case 条件求值前端） | stable |
| `evalExprSync` | 函数 | act-body-interpreter.ts | 表达式同步求值（engine-traverse case 条件判定;engine commit 动作清单提取求实参,[[exec-engine#^anc-exec-commit-action-facts]]——无工具无 IO 的纯求值面） | stable |
| `findNonPureCallWith` | 函数 | act-body-parser.ts | 表达式内非纯调用探测（validator 条件纯度校验——条件里禁工具/time） | stable |
| `exprChildren` | 函数 | act-body-parser.ts | 子表达式清单唯一权威（扫描类消费面公共遍历;validator C8/B4 调） | stable |
| `exprMapChildren` | 函数 | act-body-parser.ts | 子表达式同构重建（变换类消费面;engine-traverse 裸字消歧调） | stable |
| `ToolCallPending` | 类 | act-body-interpreter.ts | tool_request 挂起信号（engine 捕获后组装 ToolRequest 外发——2026-08-04 tool_request 机制引入，本行为漏登补账 2026-08-06） | stable |
| `makeReplayToolProvider` | 函数 | act-body-interpreter.ts | tool_journal 确定性重放 Provider+direct 直执兜底（engine 消化路径用——2026-09-05 执行主体原则扩 direct 参数,字段约定权威 [[exec-engine#^anc-exec-tool-request]] HopType 条款） | stable |
| `runWhitelistedCommand` | 函数 | command-exec.ts | 命令执行原语（tools 模块 run_script 调——白名单核/hopjit 恒拒/spawn/失败三类指路共用一份,见 `^anc-exec-command-primitive`） | stable |
| `CommandResult` | 类型 | command-exec.ts | 原语返回形状 `{stdout, stderr, returncode}`（同上，type-only） | stable |
| `unionApprovedCommandNames` | 函数 | command-exec.ts | 签名 `(whitelist?: string[], approved?: string[][]) → string[] \| undefined`。body 口白名单并集（hopjit.yaml commands: ∪ spec《已批准命令》各行 argv[0],去重）——dispatcher 与 engine 两个 commandWhitelist 注入点 + engine requires_commands 预检闸三处调;两边都缺席返回原 whitelist（undefined=关死不变,[]=关死）,见 `^anc-exec-command-primitive` 并集条（2026-09-30;2026-10-01 加预检口） | stable |

> **内部（表外即内部）**：tokenizer/递归下降解析的私有函数、interpreter 的求值私有方法、各内置函数实现体。

## 列表推导【契约】 ^anc-step-act-body-comprehension

`[expr for x in xs]` 与带滤 `[expr for x in xs if cond]`（2026-08-19 作者拍板『需要就加,风险可控』——起因:expand-node 1.3 理想 body 化卡在 known_vars 参数拼装,`[i.name for i in inputs]` 类"对象列表提字段"构造 body 文法不逮,工具参数被迫走 LLM 转述面）：

- **语义**：纯映射/过滤——迭代次数=列表长度天然有界、零跨迭代状态,不违『禁循环语句』本意（for/while 语句仍拦,报错文案指路推导可用）;
- **文法**：列表字面量分支扩展——首元素解析后遇 `for` 即转推导;**source/filter 用无三元档 parseOr**（推导内裸 `if` 归 filter,Python 同款,三元须括号——实撞:带滤形态的 if 被 parseExpr 吞成三元起头报『缺 else』）;**嵌套深度≤2**（2026-09-03 作者拍板,原禁嵌套放宽——见下嵌套深度条款）;体内禁工具调用（checkActExpr 统一核,B2 面不变）;
- **嵌套深度≤2**（2026-09-03 作者拍板）：
  - 实撞出处:hopissues/0068——`alien = [x for x in xs if not any([startswith(strip(x), g) for g in gs])]` 是标准 Python 合法形态〔CPython 实测正确〕,原『禁嵌套』把聚合谓词内嵌形整体堵死,0067 补了 any/all 后消费场景仍够不着〔顶层 any 可用、内嵌位置不可用〕,hopkb 锚定闸被迫固定展开打折;
  - 三案取舍:A 窄放行仅 any/all 实参位=表述太复杂;B 全面放开=太危险;作者拍 C『要不简化点,仅允许2层嵌套?』——一句话可表述、实现=布尔闸改深度计数器、恰2层场景放行、3层以上照拦;
  - 已知副作用〔上报时说明〕:2层裸嵌套构造嵌套列表也随之放行——同为标准 Python 且有界,风险可受;
  - **深度定义**：顶层推导=第1层;其 element/source/filter 任一位置内的推导=第2层;第2层内再嵌=第3层,拒;
  - **实现**：parser 持深度计数器 `comprehensionDepth`（进推导+1、该推导解析完-1;进入更深一层的判定点上当前深度已达2〔即将开第3层〕即报错——source/filter 位在 for/in 后判,element 位先于 for 解析故推导完成后回查 element 子树最大嵌套深度,`exprComprehensionDepth` 深度感知取代原布尔判 `exprContainsComprehension`）;
  - **报错文案**：『列表推导嵌套超两层（最多两层——外层过滤+内层聚合谓词是常见合法形态;更深的嵌套升 loop 步骤或先拆中间变量）』;
  - **求值面零改动**：双求值器对推导的求值本就递归通用,嵌套深度只是静态文法闸,解释器不感知。
- **求值**：async 解释器 scope 注入迭代变量（**遮蔽外层同名,退出恢复**）;同步求值器包装 readVar 注入;遍历对象非列表=计算异常响亮（不静默造空表）;
- **静态面与绑定语义消费面**：itemVar 是绑定变量,**凡按"变量已声明与否"做判断的消费面都必须显式接绑定语义**（盲下钻=把 itemVar 当未定义,^anc-struct-expr-walk 位置语义档,never 断言外的第二类必接点）。三处：
  - B4 可见集（element/filter 在扩展集下核、source 用原集,itemVar 泄漏到推导外引用照拦）；
  - C8 case 条件 walk（case 条件是同一表达式文法的第二宿主——itemVar 临时入 scope 核 element/filter,退出恢复含遮蔽还原）；
  - 运行侧裸字消歧 disambiguateBareWords（element/filter 内 itemVar 视为已声明,不得字面量化——否则 filter 里 `s == target` 的 s 被转成字符串 `"s"` 恒错）;
- **AST**：ComprehensionExpr{element, itemVar, source, filter?}——exprChildren/exprMapChildren/serializeExpr（往返稳定）/exprPrec（原子档）/双求值器/checkActExpr 全消费面同批登记（^anc-struct-expr-walk 原语红利:扫描类自动覆盖）。

## 序列切片【契约】 ^anc-step-act-body-slice

`seq[start:stop]` Python 基础形态（2026-09-05 作者立卡 todo/0071『需要什么样的切片支持？立一个todo』）：

- 当轮实撞:0066 实现批的 commit body 想从 `git status --porcelain` 输出剥状态前缀写了 `l[2:]`,表达式解析连环报『] 未闭合』且报文不点名切片不支持,定位烧两轮后绕行;
- 定位:LLM 按 Python 直觉写切片是本能,每撞一次烧一轮重写——hop_python『与 Python 同名同义』既有原则〔2026-08-10 作者定『代码面向 agent/程序员,Python 一致降心智负担』〕的补全件。

条款：

- **文法**：postfix 下标位扩切片三形态——`l[start:stop]` 双端点、`l[start:]`/`l[:stop]` 单端点、`l[:]` 全省略（整拷贝）;端点为任意表达式（与动态下标同款）;
  - **不做 step**（`l[::2]` 三段形态——2026-09-05 作者定'先在文档和报错信息中说明'）:机械面小但负步长语义面重〔`l[::-1]` 缺省值翻转/钳位反向/`slice.indices()` 边界矩阵〕,而两大真实需求已有正路——反转用内置 `reversed(l)`、隔位取用推导式 `[l[i] for i in range(0, len(l), 2)]`;维持不做,等 hoplog 实撞数据说话,真要做时含负步长一步做全不做半截;
  - stop 后再撞 `:` 定向报错给两条正路（reversed/推导式,文案与本条款同源）;单下标路径零改动（`l[i]` 既有文法与钉全数不动）;
  - `:` 的三个既有用途（字典字面量键后/调用具名参数/类型标注）分属 lbrace-primary、lparen-callargs、声明区三个上下文,与 lbracket-postfix 位的切片零交叠,无歧义;
- **钳位宽容语义（与单下标的分野——正是 Python 本款）**：切片越界不报错自动钳到边界（`l[10:]`→`[]`、`l[:99]`→整列表）;负数端点按 `len+n` 换算后钳位（`l[-3:]` 末三个、`l[:-1]` 去末元素）;start≥stop（钳位后）→空序列。
  - **单下标越界的既有语义不变**：读得 undefined/None 传播（非报错——tests 既有钉『负数下标越界读 undefined(不炸)』）;
  - 分野是『切片得空序列、单下标得 None』,两者都不炸,与 Python 的『切片钳位/单下标 IndexError』相比我们单下标本就宽容,切片随之取 Python 切片本款钳位;
- **字符串与列表同语义**：`s[5:]` 剥定长前缀、`items[1:]` 去首元素——两大高频场景;数组与字符串之外的类型上切片=计算异常（warn+None,与单下标在列表/字符串/对象之外的类型上取值同款处置）;`reversed` 内置双收列表与字符串（字符串返翻转后字符串——step 报错与文档指的反转正路对两类序列都成立,2026-09-05 review 抓:原 `reversed` 只收数组,写 `s[::-1]` 的人按指路改写会再撞一次计算异常,与本条'同语义'承诺冲突）;
  - 单下标自 2026-09-23 起也收字符串（`s[0]` 取单字符），见 `^anc-step-act-body-str-index`;
- **端点求值语义**（2026-09-05 review 面二真机探针抓实装漂移后改定）：
  - 改定缘由:原文'端点求值非整数=计算异常'写宽了,`Number()` 强转静默放行 None 与数字串,且 None 端点得 0、undefined 端点得缺省:同一'无值'两个行为,违反值模型『None 与未赋值同视为无值』〔本文档 hop_env 节与核心规范同款〕;
  - **None 与 undefined 端点一律按端点缺席**（`l[:x]` x=None → 整列表——与 Python 本款 `l[:None]` 一致,值模型归一）;
  - **布尔端点当 0/1**（Python 本款 True==1）;
  - **其余非整数端点（数字串 `'2'`、小数、任意对象）=计算异常**（warn+None——数字串不再静默强转:Python 本款是 TypeError,我们折计算异常同款响亮）;
  - 端点缺席=Python 缺省（start=0/stop=len）;
- **AST**：SliceExpr{object, start?, stop?}（start/stop 可缺席=省略端点）。
  - **分立节点不复用 IndexExpr 加可选字段**——两节点求值语义分野大〔None 传播 vs 钳位〕,分立让每个消费位被 TS exhaustive check 强制表态防漏改;
  - 全消费面同批登记:exprChildren/exprMapChildren/serializeExpr（往返稳定:`object[start?:stop?]` 原文重建）/exprPrec（postfix 档）/双求值器（evalExpr/evalExprSync 同扩,条件表达式里切片可用）/validator 链根核（field/index 链扩 slice 同入）。

## 对象字面量键=表达式（Python 对齐）【契约】 ^anc-step-act-body-dict-key

`{"k": v}` 字面量键 / `{key_var: v}` 变量键求值（2026-08-20 作者定『与 python 一致』——原『键限字符串字面量』是人为收紧:重档真递归实录 flash 构造 invoice_finding 反复写裸键 {invoice: x},Python/JS 肌肉记忆,三轮 parse error 递归子调用全灭;等值/序比较/真值/str 历批全对齐 Python,键位是漏网面）：

- **文法**：键位收任意表达式（parseExpr）——字符串字面量最常用;裸名=变量引用（VarRefExpr）;计算键（f-string/拼接）合法;
- **求值**：键表达式求值后 `str()` 归一为字符串键（Python dict 任意可哈希键,我们值模型键=字符串——数字键求值后 str 归一,与 JS 对象同义;None 键=计算异常响亮）;
- **静态面**：键位经 checkActExpr 照常核——**裸名键未定义即 B4 error**,报文追加指路两改法（『键写字符串加引号 {"k": v},或先定义该变量』——JS 心智写裸键意图多半是字面量,静态期即断不漂运行期）;
- **AST**：DictLiteralExpr.entries[].key 从 string 改 ActExpr——exprChildren/exprMapChildren/serializeExpr/exprPrec/双求值器/checkActExpr 全消费面同批（^anc-struct-expr-walk 作业单）;serializeExpr 字符串字面量键紧凑形 `{"k": v}` 往返稳定。

## 字符串单下标【契约】 ^anc-step-act-body-str-index

`s[i]` 在字符串上取单个字符（2026-09-23 作者拍板 todo/0102"解释器补字符串下标"）。

- **实撞**：spec 里写 `x = "yes" if strip(l)[0] in "123456789" else "no"`（按首字符判是不是数字开头），validate 全绿，运行时却走"在非数组/对象上取下标"的计算异常，步骤失败；写在 case 条件里则静默得 undefined，连 warn 都没有。
- **为什么补**：文法上 `strip(l)[0]` 本来就合法（validate 放行是对的），缺的是解释器那一半。切片早已"字符串与列表同语义"（见 `^anc-step-act-body-slice`），单下标只认列表是漏网面；Python 心智里 `s[0]` 天经地义，概念层"下标含负数"也没把下标限定在列表上——概念层文字不用改。
- **不做的事**：validate 不加"下标对象的类型推断"规则——hop_python 变量无静态类型，推断只能猜，猜错就误报；解释器补齐后这条路本身就通了，没有需要静态拦的错误形态。

**能力契约（HopTrait）**：

```
# Spec: 单下标求值
Id: index_value(obj, idx) -> value
Goal: 对 obj[idx] 求值——列表与字符串按位置取、对象按键取,其余类型是计算异常
Inputs:
- obj % yaml  # 被下标对象（任意求值结果）
- idx % yaml  # 下标求值结果
Outputs:
- value % yaml  # 取到的元素/字符/键值;越界得 None;计算异常时为 None 并留 warn
Constraints:
- 列表与字符串走同一段"序列单下标"逻辑,语义完全一致：下标先转数字(与列表既有口径相同,Number 转换)再判整数;非整数=计算异常"下标 X 非整数 → None"
- 负数下标按 Python 从末尾数（s[-1] 末字符）;换算后越界（含负数越界）得 None,不报错——与列表单下标既有的宽容语义同款
- 字符串取出的是长度为 1 的字符串;计数口径与 len/切片相同（JS 字符串下标,UTF-16 码元——中文等常用字符与 Python 一致,emoji 等补充平面字符与 Python 不同,既有口径本批次不改）
- 对象（非列表的 dict）按 str(idx) 键查找——既有行为不变
- 数字、布尔等其余类型上取下标=计算异常"在非列表/字符串/对象上取下标 → None"
- 两个求值器同扩：异步 BodyInterpreter.evalExpr（body 语句）与同步 evalExprSync（case 条件、callee 表达式）
```

**类型约定（HopType）**：模块级共用函数 `indexValue(obj, idx) → { value?: unknown; err?: string }`（与 `sliceValue` 同形——求值结果或计算异常文案二选一），两个求值器都调它，不各写一份。被下标对象三分类：

- **序列**：列表或字符串 → 位置下标（整数核 → 负数换算 → 越界得 undefined）；
- **映射**：非 null 的普通对象 → `String(idx)` 键查找；
- **其余**：数字/布尔/None → 计算异常文案。

两个求值器对计算异常的处置沿用各自既有约定：

- 异步路径：文案进 warnLog，返回 None（本步随后 fail）。
- 同步路径：文案经 onWarn 报出，返回 undefined。**None/undefined 上取下标在同步路径保持静默返回 undefined**——与同步路径"在 None 上取字段静默得 undefined"既有约定一致，case 条件里写 `x[0] == "a"` 而 x 未赋值时仍按不命中处理，不因本批次改成分支失败；数字/布尔上取下标同步路径补 warn（改前静默，与切片同步档"异常路径出文案"惯例对齐）。

**关键逻辑（HopSop）**：

```
单下标求值:
1. 求 obj、idx
2. [分支] 按 obj 判型
   2.1 [条件(obj 是列表或字符串)] n = Number(idx)
       - n 非整数 → 计算异常"下标 X 非整数 → None"
       - k = n < 0 ? len + n : n;k 越界 → undefined(None);否则取第 k 个元素/字符
   2.2 [条件(obj 是非 null 对象)] 按 String(idx) 键查找
   2.3 [否则] 计算异常"在非列表/字符串/对象上取下标 → None"
3. 异步路径:计算异常 → warnLog + 返回 None
   同步路径:obj 是 None/undefined → 静默 undefined;其余计算异常 → onWarn + 返回 undefined
```

## 语句写在一行内：括号跨行定向报错【契约】 ^anc-step-act-body-one-line

hop_python 按行解析，每条语句必须写在一行内；字典/列表字面量、调用参数、括号分组、下标只要在本行没有闭合，就报一条定向错误（2026-09-23 作者拍板 todo/0102）。

- **实撞**：LLM 按 Python 习惯把字典写成多行（`x = {` 换行 `"a": s,` 换行 `}`），validate 连环报五条："非法表达式起始: newline"、"对象字面量键后期望 :"、"} 未闭合（对象字面量）"、"语句后期望换行"、"非法语句起始: indent"。写的人读不出"原来是不许跨行"，只能乱改。
- **validate 与运行时同源**：validate 用的就是运行时同一个解析器（跨行写法本来就被拦），缺的只是一条读得懂的报文，不需要另加校验规则。
- 教学面（skills/ 下 hopbuild-primer、split-patterns）已经教过"一条语句一行"，本批次不动。

**能力契约（HopTrait）**：

```
# Spec: 括号跨行定向报错
Id: one_line_bracket_error(tokens) -> errors
Goal: 括号在本行没闭合时只报一条读得懂的错误,告诉写的人不能跨行、怎么改
Inputs:
- tokens % yaml  # 词法记号流（按行切,每行末尾一个 newline 记号）
Outputs:
- errors % yaml  # 恰好一条定向错误
Constraints:
- 触发条件:解析器正处在某个括号结构内部（列表字面量 [ / 字典字面量 { / 调用参数 ( / 括号分组 ( / 下标与切片 [）,此时要报任何解析错误而当前记号是换行（或输入结束）——意味着括号没写完这一行就结束了
- 两种成因都走这一条:①跨行书写（左括号后换行接着写）;②单行里真的漏写了右括号（xs = [1, 2 行尾结束）。hop_python 里一行结束时括号未闭合只有这两种原因,定向文案对两者都指对方向
- 报文原文:"<左括号> 在本行没有闭合：hop_python 每条语句写在一行内，字典/列表字面量不能跨行，装不下就拆成多个赋值"（解析器统一加前缀 "act body: "）;行号=最内层未闭合左括号所在行
- 报出这一条后立即停止解析整个 body（或整条 case 条件）,不再连环报后续错误——跨行的续行在按行解析器眼里都是垃圾,重新同步只能猜,猜出来的报错全是噪声
- 括号内部、不在换行处的错误（如 l[::2] 步长报错、{"a" 1} 缺冒号）照报原文案,不受影响
- case 条件宿主同款（parseExpression 共用同一 Parser）:条件写在一行里,只可能是漏写右括号,报文前半句"在本行没有闭合"指对方向
```

**类型约定（HopType）**：Parser 增一个成员 `brackets: Token[]`——当前所处的括号开记号栈（最内层在栈顶）。进括号结构时压栈、离开时出栈，用 `try/finally` 包住保证解析中途报错时也会出栈（不泄漏到后续表达式）。另有一个模块内哨兵 `ONE_LINE_ABORT`（抛出用于中止解析，不是错误本身——错误在抛出前已写进 errors），两个入口 `parseActBody`、`parseExpression` 捕获它后返回 null。

- **时序约束**：括号结构内部的其他报错（如列表推导嵌套超两层）必须在吃掉右括号之前报——吃完右括号时本层还在栈上、当前记号又恰是行末换行，此时报错会被误判成括号跨行（实撞：推导深度检查原本排在吃 `]` 之后，改造后被吞成定向文案，既有测试"3层嵌套拒"转红，已前移）。

**关键逻辑（HopSop）**：

```
报错(msg):
1. [条件(brackets 非空 且 当前记号是换行或输入结束)]
   1.1 写入一条错误:行号=brackets 栈顶记号行号,文案=栈顶左括号 + " 在本行没有闭合：hop_python 每条语句写在一行内，字典/列表字面量不能跨行，装不下就拆成多个赋值"
   1.2 抛 ONE_LINE_ABORT 中止解析（原 msg 丢弃——它是跨行引起的连带症状）
2. [否则] 照旧写入 msg
入口(parseActBody / parseExpression):
3. 捕获 ONE_LINE_ABORT → 返回 null（errors 里恰好多出那一条）;其他异常照常上抛
```

## 表达式遍历原语【契约】 ^anc-struct-expr-walk

**为什么**：ActExpr 的消费面 8+ 处（双求值器/serializer/hasCall/hasToolCall/findNonPure/validator B4/C8 walk/运行时裸字消歧），每处各持一个 switch——新增节点要"记得"逐处补,TS 对无 never 断言的 switch 不报漏。三撞实录：v0.5.0 三字面量入语言时五 walker 补了但 C8 walker 漏（悬空变量漏放一周）；ternary 入语言时 C8 再漏（二审抓）；serializer 零括号漂移潜伏至三审。**结构性根治=遍历知识收敛一处,漏接升编译错误**。

**HopType（两原语）**：
```
exprChildren(expr: ActExpr) → ActExpr[]        # 子表达式清单（不含自身;literal/var 返回 []）
exprMapChildren(expr: ActExpr, f: ActExpr→ActExpr) → ActExpr   # 同构重建（每个孩子过 f,结构/其余字段不变）
```

**HopTrait（约束）**：
- **唯一权威**：两原语内的 switch 是全库唯二"逐节点列孩子"的位置，**switch 必带 never 穷尽断言**——ActExpr 加成员而原语未接,tsc 编译红（这是整个机制的锚点）;
- **消费面分三类,各归其位**：
  - **扫描类**（找东西:hasCall/hasToolCall/findNonPure/B4 checkActExpr/C8 变量收集）经 exprChildren 递归——纯扫描面（hasCall 族）零逐节点 switch;带位置语义的扫描面（B4 的 var/call、C8 的比较位/字段链）**命中节点显式 case,其余一律 default 经 exprChildren**（混合形态结构安全:新节点自动落 default 进原语,无需 never 断言——四审措辞校准,实装即此形态）;
  - **变换类**（重建:disambiguateBareWords）经 exprMapChildren,只写"命中节点怎么改",下钻交原语;
  - **逐节点类**（求值/带优先级渲染——对每种节点做的事本质不同,收敛不掉）保留自有 switch 但必带 never 断言;
- **特殊位语义归消费面**：原语只给"全部子表达式",消费面自己处理位置语义（如 C8 的比较位裸字兼容看 binary 结构、serializer 的优先级看语境）——需要位置语义的消费面可以不用原语,但必须落逐节点类纪律（never 断言）。

**HopSop（新增 ActExpr 节点的作业单）**：
1. ast-types.ts 加节点类型入 ActExpr 并集
2. **spec-ast.md 同步登记**（ActExpr 并集清单 + struct 逐条区各补一笔——本文档定位段自声明"AST 类型定义在 [[spec-ast#^anc-ast-act-body]]",漏登即权威失真。2026-09-05 review 抓:SliceExpr/ComprehensionExpr 两代节点都走漏了这步,根在本作业单原先没有这一行）
3. `npx tsc --noEmit` → 全部带 never 断言的 switch 逐个红,按红名单补：两原语 + 双求值器 + serializeExpr/exprPrec
4. 扫描类/变换类消费面零改动（经原语自动覆盖）
5. 正反例:新节点藏悬空变量→C8 拦;新节点进裸字消歧位→语义正确;**静态校验与消歧面的行为钉**（B4 端点/子位未定义变量拦、case 条件 C8 同款、消歧下钻语义——2026-09-05 review 变异实锤:代码经原语自动覆盖≠测试自动覆盖,三处非等价变异在 1287 例下全存活）

## act body 执行模型【契约】 ^anc-exec-act-body-interp

act/commit 步骤若有结构化 body（hop_python，见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]、[[spec-ast#^anc-ast-act-body]]），**两种模式都由引擎内置解释器 `BodyInterpreter`（`src/act-body-interpreter.ts`）按 AST 顺序执行——无 LLM、执行期无推理**（概念层 2026-08-04 收紧原则 6，同定位段"不碰"条）。

- 模式差异仅在工具执行体的兜底面：独立模式解释器直调 ToolProvider；复用模式引擎 provider 命中的工具同款直执（2026-09-05 执行主体原则,权威 [[exec-engine#^anc-exec-tool-request]]）,仅 provider 外的工具（caller 会话专属:MCP/宿主能力）经 `tool_request` 交 caller 执行**单个工具**、结果经 journal 代入续跑。
- （本段 2026-08-08 语义审计修正：原文"复用模式 body 交付 caller 执行"是 v0.2.0 前旧行为残留，与定位段自相矛盾。）

- **求值模型**：scope 初值 = 步骤 `←` 输入（`step.context.inputs`，按 name）。顺序执行语句：赋值写 scope、`if` 按 `isTruthy`（复用 [[exec-engine#^anc-exec-none-propagation]] 同一真值语义）走 then/else、调用求值。结束后从 scope 取 `+→` 声明名组成输出，交 `completeStep` 走 schema 校验（[[exec-engine#^anc-exec-output-schema-check]]）。
  - **输入边界先解引用大值卸载指针再进 scope**——解释器是确定性执行体,必须拿到真值,LLM 通道"由 LLM 决定是否 Read"的自由度在这里不存在：
    - **`$file` 指针解引用**（[[shared-types#^anc-exec-deflate]] 的逆操作）：`resolveInputs` 把超 `DEFLATE_THRESHOLD`（4096）的大值卸载为 `{$file: abs_path}` 指针,解释器必须先读文件取真值再进 scope——否则 `a + b` 数组拼接 `Array.isArray(指针对象)=false` 落入数值强转报"不可转数字"（BUG-A `^todo-bug-deflate-plus`）。
    - 判定按指针形状契约精确匹配（[[shared-types#^anc-exec-deflate]]：恰单键 `{$file: string}`）——含其他键的用户数据对象原样进 scope 不误读文件;指针指向的文件读取失败时响亮报错（缺盘面不静默）;
    - **解引用递归下钻**：数组逐元素、普通对象逐字段递归解引用——"解释器必须拿到真值"承诺覆盖任意嵌套位;形状契约不变,`{$file, preview}` 人通道双键对象含其他键不匹配、天然豁免;
      - 实撞出处:2026-08-24 D59——原实现只剥顶层值,指针藏在数组元素/对象字段位时原样进 scope:dr13 collect 数组里一项超阈成指针,机械拼装 body 把 `{$file}` 对象喂 edit_spec_tree 拒"需要非空 fragment",4 攻同败烧死子实例;
    - **`$preview` 预览对象同须解引用**：inline 预览通道（[[step-dispatcher#^anc-exec-llm-inline-context]]）把超 `INLINE_PREVIEW_MAX` 的字符串输入换成 `{$preview, full_chars, full_file?}` 三键对象,受众是裸 API LLM,解释器不识别即把整对象喂工具;
      - 实撞出处:2026-08-26 dr18 第3攻——同族第二形态:validate_spec 报"text 参数必须是字符串",确定性错误重试必死,5.1#3 七小时白烧;
      - 形状判据=恰含 `$preview`(string)+`full_chars`(number),`full_file` 缺省或 string（存在但非 string 的对象不匹配形状,原样保留）;命中读 `full_file` JSON.parse 还原全文,`full_file` 缺席响亮抛错不拿节选顶替（节选替真值=静默截断）;
      - $preview 只对绑定值顶层整串产生（产生条件 `typeof val==="string"`）,结构上不出现在嵌套位——递归覆盖属双保险,消费侧契约权威 [[shared-types#^anc-exec-deflate]] D59 $preview 段。
- **表达式**：`+` 按操作数类型分派（双列表拼接；任一为 string 则串接，否则数加）；`and`/`or` 短路；等值与序比较语义见 [[#^anc-exec-ordered-compare]]（Python 对齐：等值严格深比较、序比较同类型才可比、`is`/`is not` 仅限 None）。
- **工具调用**：callee ∈ 内置白名单（`ACT_BUILTINS`）→ 同步求值；否则查 `ToolProvider.list()`——未知则抛 `TOOL_EXEC_ERROR`，`requires_commit` 工具在 act（`allowCommit=false`）抛 `COMMIT_REQUIRED`、commit（`allowCommit=true`）放行。工具用**命名参数**（对应 `ToolProvider` 的 `Record` args）。
  - `allowCommit` 同时决定内置文件工具的写域（[[tools/file-tools#^anc-exec-builtin-file-tools]] 分域条款,2026-08-28）：解释器把 `write_scope`（false→'work_zone'，true→'workspace'）随 execute 第三参传给 provider——act/check body 写 work_zone 外即拒 WORK_ZONE_ONLY。
- **三层重试责任分清**：
  - ①工具瞬时失败重试 = **ToolProvider 内部职责**（execute 自己实现，引擎只调一次拿结果，失败抛 `TOOL_EXEC_ERROR` → failStep → 容器级 retry）；
  - ②算子级 `SCHEMA_MISMATCH` 重试（[[step-dispatcher#^anc-exec-operator-retry]]）是为 LLM「改 prompt 重做」设计的，**body 步骤跳过**（body 非 LLM 且确定性，重做产出一样的不匹配）→ schema 不匹配直接 failStep → 容器级 retry；
  - ③容器级 retry = subtask/case。
- **fallback**：无 body 的 act/commit 回退 LLM tool-use 循环（`executeActWithTools`）——存量 spec 零回归，渐进迁移。

## 比较语义：Python 对齐（等值/序/is None）【契约】 ^anc-exec-ordered-compare

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]] 运算符条款（2026-08-11 作者两轮拍板："心智用 python 一致最简单，否则解释成本过高"；"删宽松等值 + schema 边界归一转换 + is None 也做了"）。

**能力契约（HopTrait）**：

```
# Spec: 比较求值
Id: compare_eval(op, left, right) -> result
Goal: 对 == != < > <= >= is 按 Python 语义求值,跨类型不静默强转
Inputs:
- op % enum(eq, ne, lt, gt, le, ge)  # 等值两个 + 序比较四个（is/is not 解析层已归一为 eq/ne 对 None）
- left % yaml  # 左操作数（任意求值结果）
- right % yaml  # 右操作数
Outputs:
- result % bool  # 比较结果;序比较不可比时为 None（计算异常）
Constraints:
- 等值 ==/!= Python 严格:跨类型不相等不异常（"3" == 3 假）;数字与 bool 互比按数（True == 1 真）;列表/对象深比较逐元素递归;None 与未赋值同视为"无值"互等（x == None 命中两者——值模型事实非宽松特例）
- in 的元素查找与 == 同一等值语义（3 in ["3"] 假）
- 序比较数字与 bool 互比按数值;双字符串字典序（"2026-08-01" < "2026-08-02" 真;"10" < "9" 真）;双列表逐元素字典序,元素递归,前缀短者小
- 序比较其余组合（数字×数字串、None/对象任一侧参比等）=计算异常→None+warnLog,条件上下文按不命中;等值无计算异常路径（Python 同义:!= 恒有答案）
- is/is not 仅限 None 判定（x is None ≡ x == None,解析层归一不进 AST）;右操作数非 None 报错指路 ==（hop_python 值模型无对象身份概念,不开通用 is）
- 数字串不再有语言内特赦——输出边界已归一转换（见 [[exec-engine#^anc-exec-output-schema-check]] 边界归一条款）,变量空间里声明 int/float/number 的值必为数字
```

**类型约定（HopType）**：`strictEq(l, r) → boolean` 与 `orderedCompare(op, l, r, onWarn?) → boolean | null`——act-body-interpreter.ts 模块级函数，**双求值器共用**（BodyInterpreter 异步路径直用；evalExprSync 条件路径把 null 转 undefined，维持"条件异常按 falsy"既有约定）。

- `membershipTest` 元素查找复用 `strictEq`。`orderedCompare` 内部 `cmp(a, b) → -1|0|1|null` 递归比较器，null 即不可比信号一路上浮。原 `looseEq` 删除。
- parser 侧：`is` 进 KEYWORDS，parseCmp 识别 `is [not] None` 归一产出 `==`/`!=` 对 None 字面量的 BinaryExpr（AST 无新节点，serializer/walker 零改动）。

**关键逻辑（HopSop）**：

```
比较求值:
1. [分支] 按运算符分派
   1.1 [条件(op ∈ {==, !=})] strictEq 深比较:
        None/未赋值家族互等 → 数字/bool 家族按数 → 同为字符串/布尔直比 →
        双列表逐元素递归(长度先判) → 双对象键集+逐键递归 → 其余 False。!= 取反
   1.2 [条件(op ∈ {<, >, <=, >=})] orderedCompare:
        cmp 判型分派（数字家族按数/双字符串字典序/双列表递归/其余 null）
        → null 则 warnLog"类型不可比"返回 None,否则按 op 折 bool
2. 解析层 is [not] None 已归一为 1.1,无运行期 is 路径
```

## time 实例上下文内置（now/today）【契约】 ^anc-exec-time-builtins

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]] 实例上下文内置条款（作者定 2026-08-12 纳入 hop_python，不走工具通道——复用模式为一个时间戳付一次 tool_request 跨进程往返不成比例）。

**能力契约（HopTrait）**：

```
# Spec: now 内置函数
Id: builtin-now
Goal: 返回当前时刻 ISO 8601 字符串（含时区），供产物落款/时间计算
Outputs:
- ts % line   # 如 2026-08-12T15:30:00+08:00

# Spec: today 内置函数
Id: builtin-today
Goal: 返回当前日期 YYYY-MM-DD
Outputs:
- d % line
```

**类型约定（HopType）**：BodyExecContext 增 `timeJournal: [line]`（可选）——本步已求值的时间值序列。

- StateFile 增独立键 `time_journal: {step_id: [line]}` 与 `tool_journal` 并列（不并入 tool_journal——元素类型不同，且按 step_id 的清理递归会漏删前缀键），持久化/恢复/清理三时机与 tool_journal 逐点同步。
- ACT_BUILTINS 白名单占位（arity 0），条件表达式路径（evalExprSync）调用报"需实例上下文"（work_zone_path 同款守卫）。

**构造点接线**：复用模式（engine 重放循环）传 `timeJournal[step_id]` 持久数组——挂起点随 state 落盘，跨进程重放取记录值；独立模式（dispatcher.executeActBody）传本次执行的新数组——body 单遍执行无重放，重试=新尝试取新时间即预期语义，不落盘。

**关键逻辑（HopSop）**：

```
now()/today() 求值:
1. [branch] 按本步时间序号 n（第 n 次时间取值）查 journal
  1.1. [case(journal[n] 在场)] 返回记录值——重试/崩溃恢复重放取记录值不取新值（重放确定性,与工具结果重放同一哲学）
  1.2. [case(缺席)] 取真实时钟 → 追加入 journal（随既有持久化通道落盘）→ 返回
2. 步骤完成/失败/重试清本步 journal（同 tool_journal 清理时机——重跑取新时间是预期语义）
```

**正反例**：正例=body 内 now() 返回 ISO 形状、同步骤重放取记录值一致；反例=条件里调用报静态/运行错误、重试后取新值（journal 已清）。

## hop_env 只读变量注入【契约】 ^anc-exec-body-hop-env

概念权威 [[../concepts/HopSpec V3核心规范#^anc-config-hop-env]]"body 走 Python 自身 f-string"半边的落点：hop_env 表（`BodyExecContext.hopEnv`，注入源=`HostConfig.hop_env`，两执行路径 engine/dispatcher 同源传入）在 `run()` 开始时作**只读变量**播入 scope——body 内 `hop_env_kb_root` 直接可引、f-string 插值走解释器既有文法，引擎不做第二套展开。

- **静态面（validator 配合）**：B4 可见集对 `hop_env_*` 前缀名放行（运行时注入，静态不可知具体键）；赋值目标带前缀=B1 error（写禁,权威 [[spec-parser#^anc-rule-hop-env-readonly]]）；
- **运行面**：引用了表中不存在的 `hop_env_*` 键 → 解释器按既有"引用未定义变量"抛错折计算异常 → 本步 fail（与 doc-ref 位 HOP_ENV_UNDEFINED 同一响亮原则，不静默 None）；
- **运行期写防线**：赋值目标带 `hop_env_` 前缀 → 计算异常（静态闸的运行期兜底——replan 生成的 body 同受约束）。

**正反例**：body 引用已定义键取到值/引用未定义键 fail/赋值目标带前缀 fail/f-string 插值正确。

## strip_fence 文本剥壳内置【契约】 ^anc-exec-strip-fence

LLM 产文本值的围栏壳/键前缀污染是稳定病灶家族（`^anc-exec-output-fence-recovery` 同族）——恢复阶梯管**结构值**（YAML parse 解出真值）,但**文本片段值**（spec 片段/markdown 正文）不能走 parse（步骤序列 parse 成 YAML 即碎）,此前只能靠产出步契约注释自律+核查步打回,弱模型反复复发烧 retry（2026-08-20 buildtest 实录:三例 ≥6 轮烧在 expand-node 1.2 的 ```yaml+`draft_fragment: |` 包裹上,机械可剥的壳走 LLM 重跑纠偏）。

**能力契约（HopSpec 契约）**：

```
# Spec: strip_fence 内置函数
Id: strip_fence(text, key?) -> text
Goal: 机械剥除 LLM 文本值外层的代码围栏与自标记键前缀,还原正文——消费侧防线,不依赖产出侧自律
Inputs:
- text % text  # 待剥文本;非字符串原样返回
- key % line   # 可选,自标记键名（如 "draft_fragment"）——剥围栏后首行是 `<key>:` 或 `<key>: |` 时再剥该行及其引入的统一缩进
Outputs:
- clean % text  # 剥后正文;无壳时原样返回（幂等,合法围栏正文不被误剥——只剥"整值被单一围栏包裹"形态,正文内嵌围栏不动）
Constraints:
- 纯文本操作零 parse——与 recoverFencedValue（结构档,YAML parse）分工:本内置管文本片段,不解释内容
- 剥壳判据从紧:仅当整值 trim 后以 ``` 开头且以 ``` 结尾（单围栏包裹）才剥;键前缀仅在 key 实参给出且逐字匹配时剥
- 无实例上下文依赖（纯函数,ACT_BUILTINS 正式成员,case 条件亦可用）
```

**关键逻辑（HopSop）**：整值单围栏判定 → 剥外层围栏行 → key 给出且首行=`key:`/`key: |` → 删该行+剥余行统一前导缩进 → 返回;任一判定不中即原样返回。

**消费位**：expand-node 1.3 body（`draft_fragment = strip_fence(draft_fragment, "draft_fragment")` 先剥再验——机械可剥的壳不再烧 LLM 重跑轮;剥不掉的真格式错照旧 frag_validate 红）。

## parse_json 结构解码内置【契约】 ^anc-exec-parse-json

内置工具族（validate_spec/树编辑四件 insert_node/replace_node/replace_children/renumber_steps）返回 `content_type: json` 的**字符串**——body 里拿到的是 JSON 文本,要取字段（如 replace_node 返回的 `spec_text`）此前只能把整段编排升 LLM 步。

- 实撞出处:2026-08-21 hopbuild2 压测 test11——拼装步无 body 走 LLM 工具会话,弱模型把多轮推理独白当 fragment 交付——35K 废话进产物;机械编排被迫走 LLM 正是 body 化要消除的病灶。

```
# Spec: parse_json 内置函数
Id: parse_json(text) -> value
Goal: JSON 文本 → 结构值(dict/list/标量),供 body 取字段——内置工具 json 返回值的机械解码半边
Inputs:
- text % text  # JSON 文本;入参已是结构值/数字/布尔/null 时原样返回（幂等容错,2026-09-05 作者定"parse_json应该需要有容错能力"——上游通道把文本提前解析成对象时 body 不因二次解析炸,0075 批;undefined 照抛——未定义变量信号不吞）
Outputs:
- value % yaml  # 解出的结构值(字段访问/下标照 hop_python 既有文法)
Constraints:
- 解析失败（坏 JSON 文本）/undefined 入参=计算异常（折 None+warnLog 留痕,warnLog 非空即本步 fail——求值面统一罩既有语义,步级仍响亮不静默）;已解析的 JSON 值域成员（对象/列表/数字/布尔/null）原样返回不算失败（幂等——改造前"非字符串一律抛"半边废,沿革见 0075 批）
- 纯函数零 IO（ACT_BUILTINS 正式成员;case 条件亦可用,与 strip_fence 同格）
```

**消费位**：hopbuild2 split-structure 拼装步 body——`r = parse_json(replace_node(...)); fragment = r.spec_text`（2026-08-30 随树编辑函数化迁移）（原 LLM 工具会话整段降格,交付面零 LLM 污染）。

## subprocess.run 命令行白名单调用【决策+契约】 ^anc-exec-subprocess-run

**为什么（2026-08-29 作者定,todo/0033 全案）**：命令执行通道的路线选择——"我们不用 cc 里混乱的 bash 命令,而是在 hop_python 里显性化命令的调用,这样 sandbox 可以有效的管控住"。

- 论证:宿主 Bash 通道的管控面是对整串命令文本做模式匹配（管道/链式/子 shell 自由组合,agent 想绕总有写法）;显性化调用给 sandbox 的是**结构化事实**（命令名/参数列表/工作目录三元组）,管控判定从文本猜测变精确匹配。
- 命名作者拍 A 案:函数名就叫 `subprocess.run`——"写是按 python 写",名字是写法的一部分,肌肉记忆零摩擦;解释器认此字面为特例,**不开模块系统**（field 调用的既有定向报错对其余 `x.y(...)` 形态原样）。

**能力契约（HopTrait）**：

```
# Spec: subprocess.run 内置
Id: subprocess.run(argv, input?, timeout?, cwd?) -> {stdout, stderr, returncode}
Goal: 在 act/commit body 内执行白名单命令,参数列表制不经 shell,结果为结构化值
Inputs:
- argv % [line]     # 位置参数第一个:命令与参数在一个列表,命令是第一个元素(subprocess 标准形态)
- input % text      # 具名可选:喂给命令 stdin 的文本(管道=上一段 .stdout 显式喂给下一段 input=)
- timeout % number  # 具名可选:秒;缺省 60;**非法值(0/负/非数)=参数解析期 TOOL_EXEC_ERROR 不执行命令**(F6 裁定:非法参数是 spec 写错,早失败优于带病执行——命令副作用已发生再炸步重试=非幂等双执行)
- cwd % line        # 具名可选:工作目录;缺省=本实例 work_zone
Outputs:
- result % yaml     # {stdout: text, stderr: text, returncode: int}——命令失败不炸,returncode 的处置写 check 步或分支(失败是值,与"计算异常=None+log"同哲学)
Constraints:
- 命令名(argv[0])必须 ∈ sandbox.runtime.available 白名单——名单空/未配置=能力关死(缺省安全),运行期拒 TOOL_EXEC_ERROR 点名"命令不在白名单"
- 不经 shell:参数列表直接 spawn,参数里的空格/分号/$ 都只是字符,注入无门
- Python 白名单外具名参数(check/shell/env/capture_output 等)=**B2 专项静态拒**(参数名是字面,validate 期可查)+运行期兜底双闸——名字带来 subprocess 的期望,期望逐条明确接或明确拒,不静默吞
- act/commit/**check** body 可用(需实例上下文,与 work_zone_path/now 同类——check 带 body 本就是引擎强制的机械判定,判定里跑命令〔git diff 核对类〕语义自然;二轮 review F5 抓实装本就通、原措辞"仅 act/commit"与现实不符,按合理性裁定放开并改措辞而非在 check 里拦);case 条件路径由白名单占位 fn 运行期拒(throw 折计算异常——now/today 同款模式;C8 静态面对 builtin 名单内名字放行,拦截靠占位)
- 结果经命令 journal 记录,重放取记录值不重执行(body 中断续跑从头重放,命令可能不幂等——git worktree add 二跑必败)
```

**类型约定（HopType,字段逐条）**：

- 白名单声明位 = **`SandboxConfig.runtime.available`**（既有字段语义升格,见 [[sandbox#^anc-config-sandbox-runtime]]——原"可用运行时声明,文档性不校验"升为"subprocess.run 命令白名单,引擎强制";存量零破坏:该字段此前引擎零消费）;
- `BodyExecContext.cmdJournal?: Array<{stdout: string; stderr: string; returncode: number}>`——命令结果重放载体（与 timeJournal 同款:撞第 n 次取记录值,缺席真执行并追加）;
- `BodyExecContext.commandWhitelist?: string[]`——engine 从 hostConfig.sandbox.runtime.available 注入;缺席=关死;
- engine 侧 `cmdJournal: Record<string, CmdRecord[]>` 按 step_id 持久化（state.json `cmd_journal` 键,与 time_journal 并排——跨进程重放不丢;步骤完成/重试清账同 timeJournal 三清理点）;
- parser 特例：`subprocess.run(...)` 的 field-call 形态在 parsePostfix 收窄放行——object 为 var 'subprocess' 且 field 为 'run' → CallExpr{callee:'subprocess.run'};其余 field 调用照旧定向报错。`ACT_BUILTINS` 加占位项（B2 静态认名,真实现走解释器专路——work_zone_path 同款模式）;
- **调用命名参数双形态**（随批文法扩展,零歧义零回归）：parseCallArgs 在既有 `name: expr` 之外认 **`name=expr`**（Python kwargs 形态——"写是按 python 写",`input=`/`timeout=` 是 subprocess 肌肉记忆;改前 `f(x=3)` 是解析错误〔`=` 不是表达式运算符〕,改后合法,存量 spec 零回归;`==` 是独立 token 与 `=` 不混）。两形态等价同一 AST（CallArg.name）,serializer 恒输出 `name: expr` 既有形态;
- 返回值恒结构体三字段;输出体量上限 maxBuffer=10MB——**撞顶=步骤失败**,不截断(截断的 stdout 喂下游=静默数据缺角,比响亮失败更危险)。spawnSync 三类失败各带指路:
  - ENOBUFS→"输出过大,用命令自带过滤收窄";
  - ETIMEDOUT→"超时可调大或收窄工作量";
  - ENOENT 分两因指路——spawn 失败且 code=ENOENT 时先 existsSync 分辨:cwd 不存在→"工作目录不存在:<路径>（常见因:body 里 cwd 参数的占位符没替换/相对路径基准错;命令本身可能好好在系统里）",cwd 在场→"白名单里有名字但系统找不到可执行文件"。分辨判的 cwd=cwd参数??workZone（与 spawnSync 实际使用同源）;两者皆缺省时恒走命令不存在半边;
    - 分辨理由:Node 对两种失败报同一 ENOENT,不分辨即误导排障——0020 批次 review 实撞:建卡漏替换 <仓库根绝对路径> 占位符,报文指向命令,误诊"本机无 uv"并连带错修总结出的 spec,作者两连问勘正;
- **位置参数恰一个**(argv 列表)——第二个位置参数=B2 静态 error+运行期同拒(双闸同构;review 抓此行为原只存在于代码);B2 专项在 validator 的 checkActExpr call 分支内,合法具名集={input,timeout,cwd}与解释器认参集同构;
- **双模式行为（核心契约面,一轮 review 抓缺席后补）**：
  - 复用模式=引擎消化路径直执 spawnSync（subprocess.run 是内置不是工具,bodyHasToolCall 不计入——命令在引擎进程执行,不经 caller tool_request;cmdJournal 保跨进程重放,这正是它存在的理由）;
  - 独立模式=dispatcher 构造 BodyExecContext 时同注入 commandWhitelist/cmdJournal（journal 持久化经引擎同一账——dispatcher 从 engine 取步骤级持久数组）;
  - 两模式白名单同源 hostConfig.sandbox.runtime.available;
- **配置通路（一轮 review 抓"三组合根全写死 [] 能力实际不可开启"后补）**：
  - HopConfig（原名 StandaloneConfig）顶层键 `commands?: string[]`（人话名——操作者视角是"允许哪些命令",不是"配置 sandbox.runtime"),加载后装入 hostConfig.sandbox.runtime.available;
  - 复用模式 CLI 同读本键——经 [[config-load#^anc-config-reuse-consume]] 取系统级与项目级合并结果（2026-10-08 todo/0131 起两级,原项目级单键读退役;容错两分:commands/language 钝感回缺省,tool_servers 坏配置响亮拒,权威同锚）;
  - 两级合并=并集（系统级+项目级,与 tool_servers 同律）;
- **hopjit 恒拒名单（2026-08-30 作者定"hopjit 本身就不应该被 act 调用"）**：`hopjit` 进恒拒名单,**优先级高于白名单**——argv[0] 是 `hopjit`（或路径尾段为 hopjit）一律拒,`commands:` 白名单写了 hopjit 也不放行且配置加载即 fail-fast 报配置错（白名单管"哪些外部命令可用",hopjit 不是外部命令是执行语境本身）。
  - 层次约束论证:被执行的步骤内容不得反过来驱动执行引擎,自嵌套执行必坏状态账;跑别的 spec 有 [call],通知等不可逆动作走注册工具的 commit 步骤,查执行状态本就不该查——步骤不感知引擎;
  - 拒绝报文带指引（[call]/注册工具/不查状态三条正道）。 ^anc-exec-subprocess-deny-hopjit

**关键逻辑（HopSop）**：

```
subprocess.run 求值(解释器 evalCall 专路):
1. [act] 解析参数:位置参数恰一个且求值为字符串列表(argv);具名只认 input/timeout/cwd,
   其余具名 → TOOL_EXEC_ERROR 点名(运行期兜底,validate 期已静态拦字面形态)
2. [check] argv 形态核:非列表/空列表/元素非字符串 → TOOL_EXEC_ERROR 指路列表形态
   （本步与步 1 同属"实参解析",留在本模块不进原语——原语拿到的恒是已解析好的 argv）
3. [branch] journal 重放判定(先于管控闸——重放的是**已经发生过的事实**,不重走闸门:
   本步已在上一进程真跑过且当时过了白名单,续跑时操作者若改了配置,重放照旧成立)
   3.1 [条件(cmdJournal 第 n 项在)] 直接返回记录值(不重执行——命令不幂等)
   3.2 [条件(缺席)] 走步 4 真执行
4. [act] 调命令执行原语 runWhitelistedCommand(argv, {whitelist: ctx.commandWhitelist,
   cwd: cwd ?? workZone, timeoutSec, maxBuffer: 10MB, input, label: 'subprocess.run',
   errorPrefix: 'TOOL_EXEC_ERROR: '}) → {stdout, stderr, returncode} 追加 journal 后返回
   ——hopjit 恒拒、白名单两拒带配置指路、shell:false、spawn 失败三类分辨指路**全在原语内**
   （^anc-exec-command-primitive;原语只抛不翻译,TOOL_EXEC_ERROR 前缀由本消费口传入,
   引擎按该前缀把 body 抛错转成本步 fail 走既有升级链）
5. 步骤 done 时 engine.completeStep 清本步 cmdJournal（两模式同一清账点——review F3:原完成清只在复用消化循环,standalone 零清账,for-each 二轮命中重放返回上一轮 stdout=静默错数据）
```

**工程偏差（v1,如实标注）**：

- ①外向命令拦截（git push 类 requires_commit 同款语义）未做——白名单是纯名单无元数据位,操作者把外向命令放进白名单=自担 act 位可重跑后果,升级形态（名单条目结构化带 requires_commit 标）随真需求;
- ②命令写域 sandbox 管不到 spawn 级（命令进程写哪里引擎无从拦,cwd 缺省 work_zone 只是引导不是墙）——这是 spawn 通道的物理边界,如实记;
- ③静态白名单预检（validate 期查 argv[0] 字面量∈白名单）未做——validate 时点 sandbox 配置未必是运行期那份,静态查易误报,运行期拒是权威。
  - **补注（2026-09-15,hopissues/0090）**：INIT 期 requires_commands 声明对账闸已另立（[[exec-engine#^anc-exec-requires-commands-gate]]——INIT 读的 hostConfig 与运行期同一份,无本条担心的时差错位;对账对象是 spec 自声明不是 argv 扫描）,本条"validate 期不做静态预检"的裁定不变。

**与相邻契约分工**：白名单声明与四维度模型归 [[sandbox#^anc-config-sandbox-runtime]];工具调用/内置函数白名单 B2 归 [[spec-parser]];使用面正反示例权威=概念层语法参考 §5 subprocess.run 小节。

**Tools 注册面与本件不合流,但共用底层 spawn 原语**（2026-09-22 随 run_script 批改定,原文"不合流——各自注册各自管控"保留其本意并写清边界）：

- **不合流的是"注册与管控",这一条不变**——本件是 body 内置（走 hop_python 的静态校验面:B2 参数名核对、白名单占位、case 条件拦截）;注册面工具走 ToolDef 声明/category 分档下发/input_schema 实参名进闸/ToolResult 失败通道/requires_commit 横切拦截。两套管控各自完整,谁也不借谁的闸;
- **合流的只有最底下那段 spawn**——抽成 `^anc-exec-command-primitive`。理由:白名单两拒的配置指路、hopjit 恒拒、ENOENT 两因分辨每一条都是实撞换来的（0090 用户 1.5 小时废跑、0020 批次误诊连带错修）,抄第二份等于下一次修坑只修到一半;
- **分工一句话**：规约作者写死的命令走本件（body 内,零 LLM 裁量）;执行步里模型按任务需要跑的脚本走 `run_script`（工具面,有裁量、须节点授权,契约 [[tools/run-script]]）。两者共用一个白名单——操作者只需在一处表达"这台机器上允许跑什么"。

## 命令执行原语【契约】 ^anc-exec-command-primitive

`command-exec.ts` 一件事：**把一个 argv 列表在白名单管控下真正 spawn 出去,并把失败翻译成能照着修的报文**。它不认识 hop_python，也不认识 ToolDef——两个消费口各自把自己的形态归一成 argv 后调它。

**为什么抽出来（2026-09-22,todo/0110 候选 B 批）**：`run_script` 落地时需要的正是 `subprocess.run` 已经踩坑踩出来的那套管控——白名单两拒带配置指路、hopjit 恒拒、ENOENT 两因分辨、撞顶响亮失败。两条路摆着:抄一份进 tools 模块,或抽一份共用。

- **抄的代价不是"多几十行代码",是下一次修坑只修到一半**——这四件里没有一件是拍脑袋想出来的,全是实撞后补的,而实撞下次会撞在哪一侧无从预知;
- **依赖方向合法**:tools 在驱动适配层（层 2）,act-body 在引擎核心层（层 1）,层 2 引层 1 是顺向（判据 [[module-principles]] §2,机检 `scripts/check-layer-imports.mjs`）。

**能力契约（HopTrait）**：

```
# Spec: 命令执行原语
Id: runWhitelistedCommand(argv, opts) -> {stdout, stderr, returncode}
Goal: 白名单管控下 spawn 一个本地进程,结果结构化返回,失败带可照着修的指路报文
Inputs:
- argv % [line]        # 命令与参数在一个列表,命令是第一个元素
- opts.whitelist: [line]   # 允许的命令名集合(缺席或空=能力关死)
- opts.cwd: line      # 工作目录
- opts.timeoutSec: number  # 超时秒数(调用方给,原语不设缺省——两个消费口的缺省各自声明)
- opts.maxBuffer: int # 单流输出上限字节(调用方给:body 面 10MB / 工具面 64KB)
- opts.input: text    # 可选,喂 stdin 的文本
- opts.wrapperArgv: [line]  # 可选,系统沙箱前缀(py-sandbox 传 sandbox-exec -p <profile>;缺席=不套)
Outputs:
- result % yaml        # {stdout: text, stderr: text, returncode: int}——非零退出码是值不是异常
Constraints:
- hopjit 恒拒,优先级高于白名单（^anc-exec-subprocess-deny-hopjit 的判据与报文原样归本原语）
- argv[0] ∉ whitelist 即拒;whitelist 缺席或空=拒（缺省安全）。**两拒报文都带修法指路**"把 <命令名> 加进项目根 hopjit.yaml 的 commands: 列表"（hopissues/0090——用户 1.5 小时废跑换来的条款,不许在任一消费口退化成哑报文）
- **body 口的 whitelist = hopjit.yaml commands: ∪ 本 spec《已批准命令》段各前缀的 argv[0]**（2026-09-30 todo/0132,[[spec-parser#^anc-rule-approved-commands]]）：同一张任务卡里人不用把命令写两遍——卡上批了 `python3 scripts/ssh_exec.py`,body 的 `subprocess.run(["python3", …])` 就能跑。并集在注入 commandWhitelist 处做（dispatcher.executeActBody 与 engine 复用模式消化路径两处,从 spec.header 取）,原语零变化;**requires_commands 预检闸同吃并集**（[[exec-engine#^anc-exec-requires-commands-gate]]——2026-10-01 review 实抓：卡上批了 echo、Config 又声明 requires_commands: [echo]、宿主白名单空,INIT 闸拦并教人改 hopjit.yaml,与"同一张卡不写两遍"自相矛盾;三个消费口读同一个并集函数）。body 口只并 argv[0]（命令名级）不做前缀级——body 是 spec 作者写死的、经 validate 的确定性代码,不是外部 agent 临场拼的;前缀级匹配只在 [[mcp-server#^anc-mcp-run-command]] 做。工具面 run_script 口**不并**（模型临场跑脚本,粒度归 hopjit.yaml;留口,有实撞再议）
- shell: false 恒定——参数列表制的物理保证,不是可选项
- wrapperArgv 只拼在 spawn 的最前面,不参与白名单与 hopjit 恒拒核对(那两道只看 argv[0])。前缀由引擎内部给定(固定的系统沙箱命令),不来自模型也不来自规约;套一层沙箱只会让被执行进程的能力更小,所以不需要白名单放行
- 失败三类各带指路:ENOBUFS(撞顶,不截断)/ETIMEDOUT(超时)/ENOENT(cwd 不存在与命令不存在两因经 existsSync 分辨,各自指路)
- **原语只抛不翻译**:抛出的是带指路文本的错误,由消费口决定包装形态（body 面 → TOOL_EXEC_ERROR 炸步;工具面 → ToolResult{success:false} 经工具结果通道回执行方）。原语不认识这两种形态,这是它能被两边共用的前提
- 重放 journal **不进原语**——归各消费口自己（body 面 cmdJournal 按 step_id 持久化;工具面无重放语义:工具调用本就是模型每轮现发的,没有"从头重放 body"这件事）
```

**关键逻辑（HopSop）**：

```
runWhitelistedCommand(argv, opts):
1. [check] argv 形态:非空字符串列表,否则抛"命令列表为空/元素非字符串"
2. [check] hopjit 恒拒:argv[0] 或其路径尾段为 hopjit → 抛带三条正道指引的拒绝报文
3. [check] 白名单:whitelist 缺席或空 → 抛"命令 'X' 无法执行:未配置命令白名单"+配置指路;
   argv[0] ∉ whitelist → 抛"命令 'X' 不在白名单(sandbox.runtime.available)"+配置指路
   （两拒都在 argv 解析后——报文要能点名要跑的命令）
4. [act] 全量 = [...(wrapperArgv ?? []), ...argv];spawnSync(全量[0], 全量.slice(1), {input,
        timeout: timeoutSec*1000, cwd, encoding: 'utf-8', shell: false, maxBuffer})
        ——无 wrapper 时即 spawnSync(argv[0], argv.slice(1), …),行为与 v0.23.0 逐字节一致
5. [branch] spawn 结果
   5.1 [条件(r.error 在场)] 按 code 分三类抛指路报文（ENOBUFS/ETIMEDOUT/ENOENT 两因分辨）
   5.2 [条件(无 error)] 返回 {stdout, stderr, returncode: r.status ?? -1}——退出码非零照样正常返回
```

**消费口差异表**（同一原语,策略各给）：

| | `subprocess.run`（body 内置） | `run_script`（注册面工具） |
|---|---|---|
| argv 从哪来 | 规约作者写死的列表 | 引擎按扩展名定解释器;`.py` 经 py-sandbox 拼 `[python3, -I, -B, 私有副本, ...args]`（另有一次检查器调用 `[python3, -I, -B, 检查器, 私有副本]`,同经本原语） |
| timeoutSec 缺省 | 60（可由 `timeout=` 覆盖） | 60（恒定,不给参数） |
| maxBuffer | 10MB（消费者是 body 变量） | 64KB（消费者是模型上下文窗口） |
| 失败包装 | 抛 TOOL_EXEC_ERROR → 本步 fail | `ToolResult{success:false}` → 回执行方 |
| 重放 | cmdJournal 按 step_id 持久化 | 无（工具调用无重放语义） |
| wrapperArgv | 不传 | `.py` 脚本经 py-sandbox 调用,系统沙箱在场时传 seatbelt 前缀（[[py-sandbox#^anc-pysb-os-independence]]） |

## work_zone_path 实例上下文内置【契约】 ^anc-exec-work-zone-path

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]] 工具组条款（work_zone 涂鸦区豁免，作者定名 2026-08-10）。

**能力契约（HopSpec 契约）**：

```
# Spec: work_zone_path 内置函数
Id: work_zone_path(rel_path) -> abs_path
Goal: 在 body 内给出本实例 work_zone 涂鸦区下的确定路径,供临时文件/中间产物读写
Inputs:
- rel_path % line  # 可选,涂鸦区内相对路径;省略返回涂鸦区根
Outputs:
- abs_path % line  # work_zone 下的绝对路径
Constraints:
- 仅 act/check/commit body 可用（check 带 body 是引擎强制的机械判定,同 :439 subprocess.run 条款——2026-10-07 本句随 spec_dir 批对齐,原"仅 act/commit"是 F5 裁定前的滞后措辞）——case 条件里调用报"需实例上下文"折计算异常（路径不属条件业务面）
- rel_path 禁 .. 穿越,违者 TOOL_EXEC_ERROR → 本步 fail
- 执行环境未提供 work_zone（如无实例上下文的裸求值）→ TOOL_EXEC_ERROR,不静默回退
- 返回路径读写工具放行——.hopstate 禁令的唯一豁免,也是"workspace 外绝对路径拒"的唯一豁免（work_zone 可以在 workspace 外;见 [[tools/file-tools#^anc-exec-builtin-file-tools]]）
```

**类型约定**：真实现不在 `ACT_BUILTINS`（白名单里是占位项，保 B2 静态校验认名）——实例上下文经 `BodyExecContext.workZone: string`（可选字段）注入，`BodyInterpreter.evalCall` 对 `work_zone_path` 走专路。

- 两执行路径的注入源同为 `engine.getWorkZone()`：复用模式 = FilePersistence `.hopstate/<inst>/work_zone/`；独立模式 = MemoryPersistence 首调 tmpdir 自建（[[persistence]] v0.2.0）。

**关键逻辑（HopSop）**：

```
evalCall 遇 work_zone_path:
1. [分支] 上下文检查
   1.1 [条件(ctx.workZone 为空)] 抛 TOOL_EXEC_ERROR"不可用——本执行环境未提供 work_zone"
   1.2 [条件(其他)] 继续
2. 求值 rel_path 实参（无参 → 空串）
3. [分支] 穿越检查
   3.1 [条件(rel_path 含 ..)] 抛 TOOL_EXEC_ERROR"禁 .. 穿越"
   3.2 [条件(rel_path 为空)] 返回 ctx.workZone 根
   3.3 [条件(其他)] 返回 ctx.workZone + "/" + rel_path
```

## spec_dir 实例上下文内置【契约】 ^anc-exec-spec-dir

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]] 实例上下文内置条款（2026-10-06 作者随 HopAnt 立——HopAnt 自带的脚本与数据随 spec 走,body 要能拿到 spec 所在目录;源头 todo/0145）。与 [[#^anc-exec-work-zone-path]] 同一族：同样是实例上下文、同样只算路径。

**能力契约（HopTrait）**：

```
# Spec: spec_dir 内置函数
Id: spec_dir(rel_path) -> abs_path
Goal: 在 body 内给出本 spec 文件所在目录下的确定路径,供 spec 自带的脚本与数据寻址
Inputs:
- rel_path % line  # 可选,spec 目录内相对路径;省略返回 spec 目录本身
Outputs:
- abs_path % line  # spec 目录下的绝对路径
Constraints:
- 仅 act/check/commit body 可用——case 条件里调用报"需实例上下文"折计算异常（与 work_zone_path 同款）
- rel_path 禁 .. 穿越,违者 TOOL_EXEC_ERROR → 本步 fail
- 执行环境没有 spec 文件（内存态、无 specPath 的裸求值）→ TOOL_EXEC_ERROR,不静默回退到 workspace
- **只算路径,不开任何权限**：返回值交给文件工具或 subprocess.run 时仍走各自既有的权限链——spec 目录在读权限内（^anc-exec-doc-ref-resolve 起跑授权;文件工具读类按 [[tools/file-tools#^anc-exec-tool-path-resolve]] 第④形态认 `read_access.allowed` 内的绝对路径,所以 `read(path: spec_dir("data/a.csv"))` 通——2026-10-07 补,此前 resolvePath 在咨询 allowed 前就拒,review 探针抓出）、不在写权限内,所以能读能跑不能写;跑脚本须经《已批准命令》（任务级授权）。这正是它与 run_script 的分工：run_script 守的是执行模型现写的脚本,spec_dir 服务的是随 spec 分发、装前可审的脚本,两条寻址链不混（作者 2026-10-06 否掉"run_script 也走 spec 目录"的提法：放开到用户项目是开放执行,安全面没审过）
```

**类型约定**：真实现不在 `ACT_BUILTINS`（白名单里是占位项,保 B2 静态校验认名）——实例上下文经 `BodyExecContext.specDir: string`（可选字段）注入,`BodyInterpreter.evalCall` 对 `spec_dir` 走专路。两执行路径的注入源同为 `dirname(resolve(engine.getSpecPath()))`（与起跑读授权 engine.ts initExecution 同一算法）：复用模式 CLI `run <spec>` 位置参数;独立模式 dispatcher 起跑带 specPath;崩溃恢复 `load` 从快照 `spec_path` 回填,续跑不丢;parallel 子实例继承父 specPath（同一份 spec）,call 子实例取 callee 自己的路径——非 `DirSpecProvider` 供源时 `resolveCalleeSpecPath` 返 null,子实例 spec_dir 报不可用（与 [[doc-ref#^anc-exec-doc-ref-resolve]] "specPath 缺席跳过本级"同一降级）;内存态（测试直塞 spec 文本）`getSpecPath()` 为 null 时不注入。

**关键逻辑（HopSop）**：

```
evalCall 遇 spec_dir:
1. [分支] 上下文检查
   1.1 [条件(ctx.specDir 为空)] 抛 TOOL_EXEC_ERROR"spec_dir 不可用——本执行环境没有 spec 文件"
   1.2 [条件(其他)] 继续
2. 求值 rel_path 实参（无参 → 空串）
3. [分支] 穿越检查
   3.1 [条件(rel_path 含 ..)] 抛 TOOL_EXEC_ERROR"禁 .. 穿越"
   3.2 [条件(rel_path 为空)] 返回 ctx.specDir
   3.3 [条件(其他)] 返回 ctx.specDir + "/" + rel_path
```

## 内置函数表四消费位同源【契约】 ^anc-exec-builtins-doc-sync

`ACT_BUILTINS` 名单（`src/act-builtins.ts`）是内置函数的唯一事实源。文档侧有**四个固定消费位**各自誊抄这份名单教读者，历史上反复漏抄（0067 实撞：any/all 入引擎后概念层与教程恒漏，三个函数三次同形漂移——design 层与 skills 消费位从不漏，concepts 快照与 tutorials 恒漏）。本条款把"新增内置函数必须五位同改"定为契约：

1. `docs/concepts/HopSpec V3核心规范.md`（^anc-step-act-body-lang 节的 pure 函数全表与实例上下文条款）；
2. `docs/concepts/HopSpec V3语法参考.md`（§5 白名单调用条与 subprocess.run 专节）；
3. `docs/tutorials/D10-hop_python计算体.md`（第 2 步白名单函数表与实例上下文小节）；
4. `skills/hopbuild2/split-patterns.md`（hop_python 文法速查的内置纯函数分组表）;
5. `skills/hopbuild/hopbuild-primer.md`（hopbuild v1 primer 的"内置纯函数白名单全集"句——它随 npm 分发、setup 装进用户机、SKILL.md 要求"拿不准先查它",自称全集就要守全;2026-10-07 spec_dir 批 review 抓它漏 spec_dir 后升第五位）。

- **守卫钉**（先例=ENGINE_BUILTIN_SPECIAL_TOOL_NAMES 与注册面同源钉，tools.test.ts）：测试从 `src/act-builtins.ts` 源文本正则提取名单（黑盒读文本，不 import 构建产物——名单在 .ts 源里），对四个文件逐员断言"全文含反引号包裹的 `` `函数名` ``"。判据故意从宽到全文级——各文件对同一函数的行文形态不同（反引号单包 `` `name` ``/`` `name(args)` `` 与斜杠并列串 `` `a/b/c` `` 两种都认,后者 2026-10-07 随第五位加——primer 用一串反引号列名单;有的在表里、有的是专节标题、有的带调用示例），按"表内某行"精确匹配会被正当的行文调整误伤；从宽判据守的是"这个函数在该文档里有记载"，记载质量归语义审计。
- **subprocess.run 特例**：它是 hop_python 唯一的 `x.y(...)` 形态名，文档里常以裸名 `subprocess.run` 出现在围栏代码块内（反引号包裹不稳定），判据放宽为"全文含 subprocess.run 字样"。
- **缺员即红且点名**：断言失败信息带文件名与函数名，接活的人不用再对账。
