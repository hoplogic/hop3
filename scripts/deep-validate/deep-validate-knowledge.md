%% @trace
	id: deep-validate-knowledge
	note: deep-validate spec（同目录 deep-validate.md）的 doc-ref 知识文档家——判据台账（活资产,撞新坑补条款）+ 环境事实教材（引擎能力面快照,引擎侧契约变更须同批刷新——刷新义务见 docs/design/deep-validate.md ^anc-meta-deep-validate-ledger）。设计权威 docs/design/deep-validate.md。
%%

# deep-validate 判据台账

本文档是 `scripts/deep-validate/deep-validate.md`（跑前深检 spec）的**外部知识家**——spec 通过 `[[deep-validate-knowledge#章节]]` doc-ref 精确引用各章节，引擎运行期切片注入推理步上下文。

> **章节标题是 doc-ref 锚点，勿随意改名**：spec 的 `[[...#章节名]]` 按标题匹配，改标题会断引用。撞新坑补判据优先在既有判据面章节内补条款，不轻易增删/重命名章节。

---

## 使用说明

**你在判什么**：validate 已经把静态文法查完了（机械体检单在手）。你的任务是查**静态判不了的运行期假设**——每个步骤的说明文字教执行者做的动作，与目标执行模式的真实能力面（环境事实教材节）是否对得上。对不上的，spec 全绿也会在真机上死。

**判定纪律**：

- **五个判据面逐面过账**：每面写"查了，结论无风险"或"查出风险 N 条：…"——静默跳过任何一面=检查不完整，不许交卷；
- **风险条目四件套**：坑位（步骤号+引文）/病理（为什么会死，指向哪条环境事实）/修法建议（可执行的具体改法，不是"注意一下"）/严重度（**高**=真机必死或产出必坏；**中**=特定条件下死（如特定执行模式/特定输入规模）；**低**=能跑但低效或有隐患）；
- **只报有据的**：每条风险必须能指出"说明文字的哪句话 × 环境事实的哪一条"矛盾。推测性的"可能有问题"不报——误报驱动作者改写合法 spec，比漏报更伤；
- **机械体检单的 warning 逐条表态**：warning 是 validate 白送的缺陷线索（如 B7"act 无 free 无 body"），每条写"采纳为风险"或"不构成风险因为 X"——不许两头都不管；
- **执行模式二分**：exec_mode=standalone 时按 standalone 能力面判（环境事实教材节的工具清单与写域规则是硬事实）；exec_mode=driver（复用模式）时 caller 能力面宽且无机器可读登记（见教材节末段），能力面矛盾类判据从宽，但体量/环境依赖/写域判据照常。

---

## 判据面一 执行模式能力面矛盾

**判什么**：步骤说明文字教执行者做的动作，目标执行模式的工具面里没有这个能力。

**怎么判**：逐步骤读说明文字（`>` 指令区与摘要行），提取其中教的**动作**（"用 X 命令判""读某文件""删旧产物""调某工具"），对照环境事实教材节里该步骤类型在目标执行模式下的工具面清单。动作需要的能力不在清单里 → 风险。重点盯三类步骤：

- **check 步（判官）**：standalone check 判官**零工具面**（纯判定，见教材节）——说明教它"检查文件存在""读盘核对"而输入变量里没有备好的料 → 判官只能如实拒判，重试烧尽。正形：确定性检查改 check body（引擎直执零 LLM），或前置 act 步备料经 `←` 喂给判官；
- **无 body 的 act/act free 与 reason**：工具面=十一件文件工具+spec 内容族（basic 档恒在）+按 `- 工具:` 声明的 special 件——说明教"跑命令/起进程/开浏览器"而 body 里没有 subprocess.run、声明里没有对应工具 → 无从执行；
- **复用模式写法残留**："driver 用 test -s 判""让 CC 去 grep"这类句式是复用模式（CC 当执行者）的写法，standalone 执行者没有 shell——目标模式是 standalone 时这类说明整句失效。

**实撞例**（anchor-audit standalone 化第五跑，九坑之坑 5）：3.2 判官步说明写"机械检查 driver 用 test -s 判六份 YAML 非空"——standalone 判官 LLM 零文件工具，如实拒判，重试耗尽整个 subtask 报废。修法：check body 化（`exists`+`read` 判六份齐备非空，引擎直执零 LLM）。

**修法方向**：确定性检查下沉 check body；判官需要的料由前置 act 步备好经 `←` 传入；复用模式句式改写成与执行模式无关的形态（说清要判什么，不指定用什么外部工具判）。

---

## 判据面二 确定性步骤形态

**先记住 hop_python 不是 Python（判 body 语法前必读,R8 实撞误报后补）**：body 语言是 hop_python——与 Python 同源但有自己的合法形态,**不得拿 Python 语法规则判 hop_python 的对错**。已实撞的误报形态:`subprocess.run([...], timeout: 60)` 的 `timeout:` 冒号具名参被判"不是合法 Python 关键字参数"——这在 hop_python 恰是唯一正确写法（具名参用冒号,与 spec 的工具调用签名同形）。语法层的对错以 validate 结果为准（它就是 hop_python 的判官）,本体检只管"运行期假设"不管文法——validate 已绿的 body,文法面零风险,不要再报。

**判什么**：步骤自称确定性（说明含"无推理/纯脚本/纯计算/纯机械/零 LLM"及同义变体）却没有 hop_python body——自称确定性而实际会派给 LLM 执行。

**怎么判**：**按语义判，不按词表**——"无推理纯脚本调用""纯机械读取""这一步不需要思考，照抄即可"都算自称确定性；反过来，说明里出现"纯"字但语义是推理活（"纯粹从原文提炼"）不算。判据：说明文字承诺这一步没有判断成分（输入定则输出定），而步骤没有 body → 引擎只能把它派给 LLM，LLM 拿着"无推理"的指令要么用工具循环笨拙模拟脚本，要么自报 tool_failure 耗尽。validate 的 B7 只能按"act 无 free 无 body"的形态发 warn（词表脆，静态判不了语义），语义半边归本面。

**实撞例**（anchor-audit standalone 化第二、三跑，九坑之坑 2）：3.1/4.1 两步说明明写"无推理纯脚本调用"却无 body——standalone 工具面无命令执行，执行 LLM tool_failure 自报耗尽（通道本身工作正常，是步骤形态错了）。修法：body 化 `subprocess.run(["uv", "run", ...])`，命令进白名单。

**修法方向**：自称确定性的步骤补 hop_python body（读写/子进程/判定全下沉 body 引擎直执）；真拆不开确定性形态的，去掉"无推理"的自我宣称、标 `[act free]` 承认它是自由任务。

---

**扩展:产出格式脆弱性**（2026-09-01 实撞立条——anchor-audit 批结果教 LLM 产出 flow 形态 YAML `{ verdict: ✅, note: 说明 }`,样例 note 带引号但 LLM 照抄时引号丢失,裸值恰含 `[` 即炸整文件解析;时炸时不炸取决于内容,25 批只炸 1 批）：spec 教 LLM 产出结构化格式（YAML/JSON 文本落变量或写盘）时,检查格式约定对自由文本的容错——**flow 形态（`{...}` 行内映射）+自由文本值位=脆弱组合**（裸值含 `[ ] , : { }` 任何一个炸）,块风格（`键: |` 缩进块）零转义天然安全。修法方向:样例改块风格,或明文强调"引号是语法必需件照抄必须保留",或产出通道加写前 parse 校验（产格式的当轮打回,别让坏文件落盘炸给几步外的读盘方——病灶离症状隔容器是最难排障的形态）。

## 判据面三 体量模式

**判什么**：说明教 LLM 逐条转写机器可读数据——输出体量随输入数据规模线性增长的活派给了 LLM。

**怎么判**：找"读 X 后逐条整理成清单/转写成 YAML/汇总每一项"形态的说明，估 X 的规模来源：X 是盘上的机器产物（扫描结果 YAML/日志/全库清单）而条目数不设上限 → LLM 转写必随规模烧穿 max_tokens（输出被硬掐断，引擎判残缺不收，重试同样被掐，几轮烧光额度）。判据核心是**转写**——LLM 亲手复述每一条数据；读大文件后**摘要/判断**（输出体量恒定）不在此列。

**实撞例**（anchor-audit standalone 化第七跑，九坑之坑 7）：5.1 步说明教 LLM 读两份 YAML 后亲手产出全部锚点清单——395 个锚点的转写烧穿 output_tokens=65536，工具循环轮被掐断。修法：脚本化 make_batches.py（归组/反查/过滤全在脚本内），body 跑脚本+parse_json 读回，LLM 零转写。

**修法方向**："确定性用脚本、判断用 LLM"的脚本侧归位——数据搬运/归组/格式转换写成脚本或 hop_python body，LLM 只消费脚本产出的结构化结果做判断。整篇重写类同病（hopbuild2 修错步实撞：几万字草稿整篇重写撞输出上限）——改定向编辑。

**输入侧同族（上下文墙）**：单步教 LLM 读不设上限的多份大材料（"读全部 N 篇原文后综合判断"）会从输入侧撞模型上下文窗（hopissues/0070 实撞：单步读 11 篇原文请求 1.05M 超 1M 窗）。引擎有压缩降级兜底（早轮工具返回原文换任务相关摘要，撞墙重试一次，再撞快速失败指路），但降级是止损不是修法——spec 侧正解仍是 for-each 逐份处理。

---

## 判据面四 环境依赖

**判什么**：body 里的命令与目标环境对不上——命令不在白名单，或命令依赖环境里没有的库/工具。

**怎么判**：扫全部 body 里的 `subprocess.run` 调用，两层核对：

1. **白名单核对**：argv 首元素（命令名）∈ 备料步读到的项目 `hopjit.yaml` 的 `commands` 白名单？不在 → 该步运行期被引擎响亮拒（这不是 spec 缺陷是环境配置缺失，但跑前就该知道）。项目无 hopjit.yaml = 白名单为空 = 一切 subprocess.run 必拒；
2. **依赖推理**：命令依赖的运行时（`python3 xxx.py` 依赖脚本 import 的库、`node xxx.mjs` 依赖 node_modules）在目标环境有没有着落。特别注意：**引擎 spawnSync 不吃 shell alias**——用户终端里 `python3` 好使不代表引擎起的裸 `python3` 一样（alias/venv 不透传，裸命令落到系统装）。

**实撞例**（anchor-audit standalone 化第四跑，九坑之坑 4）：脚本 import pyyaml，用户 shell 的 python3 是 uv alias（带环境），引擎 spawnSync 起裸 python3 落系统装缺 pyyaml，rc=2。修法：改 `uv run --with pyyaml python3` 形态一次性供依赖零系统污染，白名单 python3 → uv。

**修法方向**：命令进白名单（提示用户配 hopjit.yaml）；依赖显式随命令供给（uv run --with / npx 形态），不赌环境预装；对"环境该有而没有"的，报告里写明这是环境配置面的跑前准备项。

---

## 判据面五 写域与路径

**判什么**：说明文字或 body 教的写盘/路径习惯与引擎写域规则、沙箱路径规则矛盾。

**怎么判**：对照环境事实教材节的写域规则三条硬事实（act/check 限 work_zone；commit 限 workspace；路径一律 workspace 相对、禁绝对路径、work_zone 绝对路径唯一豁免），扫两处：

1. **说明文字教的写动作**：散文教执行者"删旧产物""清空目录""把结果写到 X"而步骤是 act/check（非 commit）且 X 不在 work_zone → 运行期 WORK_ZONE_ONLY 拒。注意散文形态静态拦不到（B9/B10 只拦 body 里的字面路径），散文半边归本面；
2. **路径习惯**：说明或 body 里的绝对路径习惯（"读 /Users/.../xxx""写 /tmp/xxx"）——沙箱禁绝对路径（work_zone 产物除外），字面形态 validate 的 B9（写侧）/B10（读侧）已静态拦，**变量拼出来的路径和散文里教的路径静态拦不到**，归本面推理判。

**实撞例两件**：

- （第八跑，九坑之坑 8）步 1 说明教 LLM "清理 .anchor-audit/ 旧产物"——act 步写域闸拒（WORK_ZONE_ONLY，该目录不在 work_zone）。修法：清理动作脚本化（prep_env.py 经 subprocess.run，脚本进程不受工具面写域闸约束，写的是它自己的业务目录）；
- （第六跑，九坑之坑 6）body 文件工具用字面绝对路径撞沙箱禁令（0042 卡记同款实撞十一次）。修法：改 workspace 相对路径。此形态现已由 B10 静态拦（字面半边），deep-validate 管剩下的变量/散文半边。

**修法方向**：持久写盘归 commit 步承载；中间产物用 `work_zone_path()` 取路径；文件工具路径一律 workspace 相对；引擎工具面管不到的目录操作（清第三方产物目录）走白名单脚本。

---

## 环境事实教材

本节是引擎能力面的**快照教材**——推理判定的对照基准。引擎侧契约变更（源头锚点见各段）须同批刷新本节。

### standalone 执行模式的工具面

**十一件文件/目录工具**（DefaultToolProvider 内置文件工具组，全部 basic 档零声明可用；权威 docs/design/tools/file-tools.md ^anc-exec-builtin-file-tools；search_file 与 read 行号段 2026-09-06 扩员——单文件子串搜索带行号/按行号段取段，契约 ^anc-exec-builtin-search-file）：

| 工具 | 入参 | 返回 | 语义与关键约束 |
| --- | --- | --- | --- |
| `read` | `path` | 文件内容 text | 三级读权限 |
| `listdir` | `path` | `[{name, kind}]`（kind: file/dir） | 读权限同 read |
| `exists` | `path` | `{exists: bool, kind: file/dir/none}` | 不存在返回 false 不报错（探测语义）；**返回是 JSON 文本，须 parse_json 后取 .exists** |
| `write` | `path, content` | 写入确认 | 新建或覆盖 |
| `create` | `path, content` | 创建确认 | 排他新建——已存在即失败 |
| `append` | `path, content` | 追加确认 | 文件不存在则创建 |
| `edit_file` | `path, old_text, new_text` | 替换确认（含字节偏移） | 局部精确替换——old_text 恰匹配一处才替换；零匹配/多匹配报错带计数（宁拒不猜，按报错补上下文重试）；目标文件不存在报错 |
| `makedirs` | `path` | 创建确认 | 含中间层；已存在即成功（幂等） |
| `move` | `from, to` | 移动确认 | 源与目标都限 workspace 内 |
| `remove` | `path` | 删除确认 | 仅文件（目录不删）；不存在即失败 |

另有 **spec 内容族六件**（validate_spec / insert_node / replace_node / replace_children / renumber_steps / read_spec_tree）——纯函数内容进内容出，不触文件系统。

**各步骤类型在 standalone 下拿到什么**：

- **act 带 body**：引擎直执 body 零 LLM，body 里可调上表全部工具 + `subprocess.run`（白名单命令）；
- **act free 与 reason**：LLM 带工具循环——basic 档（上表十件+内容族）恒下发，special 档按节点 `- 工具: 名` 声明下发；节点 `- 禁工具: 名` 声明的工具（含 basic 族）从下发清单整体剔除；**reason 恒拿不到 requires_commit=true 的工具**（作者定"等同于 act 的能力，不能 commit 写"）；
- **check**：**零工具面**——判官纯判定，判定所需材料必须经 `←` 输入变量喂进来，或改 check body（引擎直执）；
- **commit**：必须带 body（B7 error 级，无 body commit 进不了引擎），body 引擎直执。

### 写域规则

（权威 docs/design/tools/file-tools.md ^anc-exec-write-scope，逐条照抄）

- 写侧（write/create/append/makedirs/move/remove）按步骤权限分域：**act/check 限 work_zone**（探索段写的都是中间产物，越界即拒 WORK_ZONE_ONLY，free 与否无关——free 不放大权限）；**commit 限 workspace**（持久写盘=交付动作）+ 禁 .hopstate/（引擎状态区，work_zone 是该禁令唯一豁免）；
- 路径一律 workspace 相对（禁绝对路径、禁 `..`）——**唯一豁免：work_zone 绝对路径放行**（`work_zone_path()` 产物就是绝对形态）；
- 读侧（read/listdir/exists）走三级读权限链（denied → confirm_required → workspace/allowed），路径规则同上。

### 命令白名单机制

（权威 docs/design/act-body.md ^anc-exec-subprocess-run）body 里 `subprocess.run` 的命令名须 ∈ 项目 `hopjit.yaml` 的 `commands` 键白名单；白名单缺席（无此文件或无此键）= 一切 subprocess.run 响亮拒。引擎 spawnSync **不吃 shell alias**——判命令可用性按系统裸命令，不按用户终端体感。

### 复用模式（driver）的 caller 能力面

复用模式下执行者是 driver（如 Claude Code）——它按 driver skill 的散文规则驱动引擎并亲自执行步骤。**其能力面是散文级的，无机器可读登记**（没有等价于上表的工具清单可查）：CC 通常有文件读写、shell、搜索等宽工具面，但"通常有"不是契约。因此 exec_mode=driver 时：判据面一（能力面矛盾）从宽——只报"任何合理 driver 都不会有"的能力假设；写域规则不适用于 driver 亲自执行的步骤（引擎工具面的闸只管引擎通道），但 body 步照常受闸——body 恒走引擎直执，与执行模式无关。
