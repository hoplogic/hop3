%% @trace
	id: hopjit-tools-run-script
	source: [[../tools]]
	source_id: hopjit-tools
	type: extract
	last_sync: 2026-09-23T14:41+0800
	note: 执行类内置工具组模块设计——run_script 一件。2026-09-22 立（todo/0110 候选 B 作者拍板：standalone 的 [act free] 工具面缺执行手段，规约要求"实跑校验脚本"的步骤在这个环境里无解）。装配层本体与出口边界仍归 [[../tools]]；命令执行原语（白名单核/spawn/失败指路）与 hop_python 的 subprocess.run 共用一份实现，权威在 [[../act-body#^anc-exec-command-primitive]]。
%%

# 执行类内置工具组（run_script）

> **模块版本**：随 tools 模块（[[../tools]] v0.20.1，2026-09-23 工具说明补写工作目录约定;v0.20.0 为同日 `.py` 脚本接入 Python 语法沙箱批次;v0.19.0 为 2026-09-22 本组立组批次）。本文件是 tools 模块的组成部分，不独立计版——契约变更升 tools 模块版本号。

tools 模块的第三个内置工具组（前两组=[[file-tools|文件/目录工具组]] 十一件、[[spec-tree-tools|spec 内容工具族]] 六件；[[dingtalk-notify|钉钉通知]] 是独立内置通道）。

实现文件 `src/tools.ts`（`DefaultToolProvider`），命令执行原语在 `src/command-exec.ts`（act-body 模块，见下"与 subprocess.run 的分工"），`.py` 脚本的静态审查与受控执行在 `src/py-sandbox.ts`（py-sandbox 模块，[[../py-sandbox]]）。本组现只有一件工具：`run_script`。

## 缘起：教学与供给对不上，规约要的能力这个环境给不了 ^anc-exec-run-script-why

**实撞（2026-09-21，完工测试清单 T9，立卡 todo/0110，severity high）**：`standard-decompose-codify` 规约的步 5.1.1 正文写着"实跑验证（用执行环境 shell 跑生成的校验脚本）"，而 standalone 装配给 `[act free]` 步的工具面只有十一个纯文件读写工具，**没有任何一件能让一个进程跑起来**。三家模型跑同一份规约、同一个环境，各死一种死法：

- **qwen3.8-27b**：全程零协议违规，写出的 Python 校验脚本捞到观测目录实跑完全正确——它唯一缺的是一个按回车的地方。于是它把"本该被执行的 runner 脚本"换了十三个名字写了十三遍（内容一直在演进，是真的在搜索解空间，不是机械复读），二十轮工具上限烧尽，4.5 万 tokens。
- **Ling-3.0-Flash**：直接幻觉出一个 `bash` 工具，把调用写成消息文本发了九轮（引擎的工具派发看不见这种文本，落到产出收割被判 SCHEMA_MISMATCH），5.9 万 tokens，40 秒死。
- **deepseek**（强模型也中，只是症状轻）：两条 guard 里 C2 诚实承认"本环境工具面未暴露 shell 执行器"并换用 `search_file` 做等效验证；**C1 却编造了执行来源**——`verify_outcome` 写着"以 shell 运行 python3 guard_C1.py……退出码 0"，而那一轮它总共只发了 `makedirs` 与 `write` 两个调用，一次都没执行过任何东西。

**这个环境把模型逼进了诚信失格**，这是本组立组最要紧的那条理由：规约把"实跑验证留痕"定成必填字段、把 `status: 已码` 的判据定义成"跑通"，环境不给实跑手段，模型只剩"编造"或"拒交"两条路。同一个模型在两条 guard 上各选了一条——**这不是模型的诚信档位问题，是供给必然逼出来的**。

叠加的第二层病因在引擎自己身上：`act` 与 `act_free` 两个角色档里**无条件**拼着一句"每条 Bash 命令只做一件事，禁止管道（|）、链式（&&）"。引擎一边发"未列出的工具不可用"的十一件纯文件工具清单，一边在同一页纸上教模型 Bash 命令的卫生规矩。在这个供给面下推断"我可以调 bash"是合理推断，不是幻觉。这一句的条件化是同批的另一半修复（权威 [[../prompt-assembler#^anc-exec-l0-worldview-impl]]）。

**作者拍板（2026-09-22）**：走 0110 候选 B——给 standalone 装配注入受控的执行工具。路线形态由本文定。

## 核心定位：不新增引擎能力，只把已有能力接到 LLM 面 ^anc-exec-run-script-position

这是理解本组安全面的关键一句：**引擎执行本地命令的能力 2026-08-29 就已经发布了**——hop_python body 里的 `subprocess.run`（权威 [[../act-body#^anc-exec-subprocess-run]]），它同样在 act/check 步可用，同样受 `sandbox.runtime.available` 白名单管，同样能 spawn 出一个想写哪儿写哪儿的进程。

`run_script` **不给引擎添一分新的物理能力**，它做的是把这份已经在场的能力接到 `[act free]` 的 LLM 工具面上——原来只有"规约作者在 body 里写死的命令"能跑，现在"执行步里的模型按任务需要跑一个脚本"也能跑。安全面的增量只有一处：**决定跑什么的人从规约作者变成了执行模型**。本组的全部约束设计都围绕这一处增量收口（见下节）。

## 关键设计裁定：模型不选命令，只选脚本 ^anc-exec-run-script-no-command-choice

命令执行通道的路线论证在 `subprocess.run` 那边已经定过一次（[[../act-body#^anc-exec-subprocess-run]]）：宿主 Bash 通道的管控面是对整串命令文本做模式匹配，管道/链式/子 shell 自由组合，agent 想绕总有写法；显性化调用给 sandbox 的是**结构化事实**（命令名/参数列表/工作目录三元组），管控判定从文本猜测变精确匹配。

`run_script` 是这条路线的**最强形态**：模型连命令名都不供给。

- 签名是 `run_script(path, args?)`——模型给的是"跑哪个脚本文件"和"给它哪些参数"；
- **解释器由引擎按脚本扩展名自己选**（`.py` → `python3`，现只此一行，见下"扩展名表"）。模型看见的是"跑这个脚本"，不是"跑这条命令"；
- 于是白名单里需要放行的东西收敛成一个字面量（`python3`），而不是一族命令。操作者看配置文件时一眼看得清自己开了什么。

**这样定还消掉了两个原本要拍的板**：①"要不要给模型 `command` 参数、怎么防它写 `bash -c`"——不存在了；②"python 要不要钉小版本"——解释器是引擎选的，不是模型选也不是规约作者选，钉版本反而有害：换一台机器或 homebrew 路径一变就报"命令不在白名单"，把纯环境问题变成一次记在案的模型失败。白名单条目就写 `python3`，不写 `/usr/bin/python3`（后者在本机是最旧的 3.9）。

**扩展名表（v1 只有一行，扩展位留明）**：

| 脚本扩展名 | 引擎拼的 argv[0] | 说明 |
|---|---|---|
| `.py` | `python3` | sdc 类任务的校验脚本恒是 Python——三家模型实际都写 `.py`；脚本只用标准库 `ast`（`end_lineno` 自 3.8 起在场），无版本敏感面 |

- **`.sh` 恒拒**，报文点明理由："shell 脚本不支持——shell 语义下脚本内容就是任意命令，白名单形同虚设"。这不是懒，是本组唯一的收口点所在：允许 `.sh` 等于把"模型自选命令"从正门赶出去又从后门请回来，而且让它成为最自然的用法；
- 其余扩展名（`.js`/`.mjs`/`.rb`…）**没有实需不开**（与 search_file "不做跨文件目录级搜索"同哲学——开了就是白给执行 LLM 自由度）。将来真有需求：表里添一行 + 白名单里操作者放行同名解释器，两处齐才通。

## 能力契约（HopTrait） ^anc-exec-builtin-run-script

```
# Spec: run_script 受控脚本执行
Id: builtin_run_script
Goal: 让 [act free]/[act]/[check]/[reason] 步骤真的把一个脚本跑起来并看到它的 stdout/stderr/退出码——取代"写了校验脚本但没有按回车的地方"这个死局
Constraints:
- 模型供给脚本路径与参数,**不供给命令**——解释器由引擎按扩展名表选（^anc-exec-run-script-no-command-choice）;扩展名不在表内即拒,报文点名支持哪些
- 解释器名必须 ∈ sandbox.runtime.available 白名单——名单空/未配置=能力关死（缺省安全,引擎不内置任何命令）;拒绝报文带配置指路"把 python3 加进项目根 hopjit.yaml 的 commands: 列表"（与 subprocess.run 两拒报文同措辞,hopissues/0090 指路条款）
- category='special'——**须节点显式声明 `- 工具: run_script` 才下发**（不是 basic 恒列。三条理由见下"为什么 special"）
- requires_commit=false——与 body 里的 subprocess.run 同档（同一份能力同一个曝露面,见 ^anc-exec-run-script-position）;不可逆面的诚实边界见下"工程偏差"
- **脚本非零退出码不是工具失败,是脚本的判定结果**（success=true,退出码在返回值里）——工具 success=false 只留给"脚本没能跑起来"（扩展名不支持/白名单拒/文件不存在/超时/输出撞顶）。缘起即 sdc 实撞:校验脚本对违规样例本就该返回 1,把 rc=1 报成工具失败会把模型重新推回"找别的执行入口"的死路
- 不经 shell:解释器与脚本路径按参数列表直接 spawn,参数里的空格/分号/$ 都只是字符,注入无门（shell: false 恒定,与 subprocess.run 同一份实现）
- 工作目录恒 = **脚本自己所在的目录**,不给 cwd 参数（模型少一个自由度;脚本要动别处的文件,用参数传路径）——定成脚本所在目录而非"本实例 work_zone"的理由见下"工作目录为什么是脚本所在目录"
- **工作目录这条约定必须写进给执行 LLM 看的工具说明**（`ToolDef.description` 与 `path`/`args` 的字段说明）:脚本以它自己所在的目录为工作目录运行,`args` 原样交给脚本不经引擎解析——同目录的样例文件传裸文件名。缘起 2026-09-23 T9 复跑实撞:其余文件工具的路径一律按工作区相对路径解析,模型照这个习惯给 `args` 传 `.hopstate/<实例>/work_zone/样例.ts`,脚本在自己的目录下按这个相对路径找不到文件;Ling 撞一次自己排查出来,qwen3.8-27b 撞四次,首轮 20 轮工具上限因此烧穿,还把校验脚本从"接收待查文件"退化成"只查写死在脚本里的示例代码"

- 超时恒 60 秒,不给 timeout 参数（与 subprocess.run 缺省同值）;超时报文指路"收窄脚本工作量"
- 输出上限 64KB/流,**撞顶=工具失败带指路,不截断**（截断的 stdout 喂下游=静默数据缺角,比响亮失败更危险——与 subprocess.run 同哲学;限额从 body 面的 10MB 收到 64KB 的理由见下"输出限额"）
- 脚本路径走 read 同款三级读权限链（denied → confirm_required → allowed）,workspace 相对,work_zone 绝对路径豁免——"能执行"的前提是"能读到"
- 命令执行原语（白名单核/hopjit 恒拒/spawn/失败三类指路）与 hop_python 的 subprocess.run **共用一份实现**,不自造第二套（^anc-exec-command-primitive）
- **`.py` 脚本一律先过 Python 语法沙箱**（2026-09-23 起,契约 [[../py-sandbox]]）:审的字节就是跑的字节(执行私有副本)、`python3 -I -B` 启动、系统沙箱在场即套上;审查被拒=success:false 带逐行拒绝报文,脚本不执行;没有关掉审查的开关
```

**为什么 special 而不是 basic**（三条，任一条单独成立）：

1. **安全增量要 opt-in**：本组的安全增量就是"决定跑什么的人变成了执行模型"（^anc-exec-run-script-position）。special 意味着规约作者必须在那一步写下 `- 工具: run_script`——这是一次显式声明"这一步确实需要执行能力"，而 basic 恒列等于全库每个 act/check/reason 步都随身带一个执行器；
2. **白名单缺省是关死的**：绝大多数装配的 `commands` 键是空的。basic 恒列会往清单里塞一件在这些环境里 100% 调用失败的工具——**那正是 0110 这张卡本身的病**（教学面许诺了供给面没有的东西）。special 让它只出现在作者确认过环境的那些步骤里；
3. 顺带的实现收益：`prompt.ts` 复用模式的 `basicNames` 硬编码清单不用改（basic 族清单是两模式同源承诺的物理载体，动它要连带核对两模式一致性）。

## 类型约定（HopType，字段逐条）

- `path: string`（必填）——要执行的脚本文件路径。装的是**路径**不是脚本内容；workspace 相对形态，work_zone 绝对路径豁免（与 read 同）。扩展名决定解释器，所以 `.py` 后缀不是装饰，是语义的一部分；
- `args: array`（可选，缺省空）——传给脚本的命令行参数，**字符串列表**（每项一个参数，不是一整串待拆的命令行）。引擎拼出的实际 argv = `[解释器, path, ...args]`。列表里的元素非字符串时按 `String(v)` 归一；
- 返回：JSON 文本 `{"returncode": <int>, "stdout": <text>, "stderr": <text>, "defense": <text>}`（形态与 listdir/exists 的 JSON 文本同款，消费侧 `parse_json` 取用）。四个字段恒在场；`defense` 是本次执行实际获得的防护等级——`syntax+os-sandbox`（语法沙箱审过 + 系统沙箱套上）或 `syntax-only`（系统沙箱缺席，只有语法层单层防护），取值权威 [[../py-sandbox#^anc-pysb-exec]]；
- 审查被拒时返回 `success: false`，`result` 是拒绝报文文本（逐条写明第几行、哪个名字、为什么被拒、替代写法，末行附可用模块符号全列），不是 JSON；
- `ToolDef.returns` 的人读描述必须写明"非零退出码是脚本的判定结果，不是工具失败"——这句话是给执行 LLM 的，写漏了它就会把 rc=1 当失败去找别的路（缘起实撞形态）。

**工作目录为什么是脚本所在目录（而不是"本实例 work_zone"）**：`DefaultToolProvider` 是**每个 run 构造一次**的，构造参数只有 `HostConfig`（workspace 根 + 沙箱配置），**它手上没有"本实例 work_zone"这个值**。

- work_zone 是逐实例的（父实例与 parallel/call 子实例各有一个），只在引擎与 dispatcher 那一层在场，工具 `execute()` 的签名里没有它；
- 要让工具知道当前实例的 work_zone，得给 `ToolProvider` 契约加一路上下文参数，那是跨模块的接口变更，为一个 cwd 缺省值不值得。

脚本所在目录是**从入参就能算出来**的，且在实际形态下与 work_zone 等价：act/check 步的写域本就被收窄在 work_zone 内（`^anc-exec-write-scope`），模型刚 `write` 出来的校验脚本必然躺在 work_zone 里，所以 `dirname(脚本路径)` 天然就在 work_zone 下。额外的好处是脚本读写同目录的同伴文件（样例文件、临时产物）可以直接用相对名，不必先拼绝对路径。

**输出限额为什么从 10MB 收到 64KB**：`subprocess.run` 的消费者是 body 变量（落 work_zone 文件也行，10MB 无妨）；`run_script` 的消费者是**模型的上下文窗口**——工具结果原样注回对话，10MB 当场烧穿。64KB 已经远超任何合理的校验脚本输出量，撞顶时报文指路"用脚本自带过滤或只打印摘要"。两个限额同一份原语、各自传入自己的策略值。

## 与 subprocess.run 的分工，以及原语单一实现

[[../act-body#^anc-exec-subprocess-run]] 的"与相邻契约分工"里原有一句：**"Tools 注册面（服务型工具，有 schema 有会话）与本件（本地进程一次性调用）不合流——各自注册各自管控"**。`run_script` 是一件注册面工具，内部做的是本地进程一次性调用，表面上就是踩在这条分界上，所以要把话说清楚：

- **不合流的是"注册与管控"，不是"底层怎么 spawn"**。这条分界当初要防的是"把 subprocess 做成一件工具，于是命令执行绕过 hop_python 的静态校验面（B2 参数名核对、白名单占位、case 条件拦截）"。
  - `run_script` 没有绕任何东西：它是一件普普通通的注册面工具，走 `ToolDef` 声明、走 `category` 分档下发、走 `input_schema` 实参名进闸、走 `ToolResult` 失败通道、走 `requires_commit` 横切拦截；
  - **管控是工具面那一整套，不是 subprocess.run 那一套**，两套各自完整，没有混流；
- **合流的只有最底下那段 spawn**：白名单核对、`hopjit` 恒拒、`shell: false`、spawn 失败三类分辨指路（ENOBUFS/ETIMEDOUT/ENOENT 的 cwd-不存在 vs 命令-不存在两因分辨）。
  - 这段逻辑的每一条都是踩过坑换来的：ENOENT 两因分辨是 0020 批次误诊后补的，白名单两拒的配置指路是 hopissues/0090 用户 1.5 小时废跑换来的；
  - 抄第二份 = 下一次修坑只修到一半，这是本库反复吃过的漂移面。所以**提取成一份原语，两个消费口各传自己的策略**（限额、journal 归属），权威 [[../act-body#^anc-exec-command-primitive]]。

**分工一句话**：规约作者写死的命令走 `subprocess.run`（body 内，零 LLM 裁量）；执行步里模型按任务需要跑的脚本走 `run_script`（工具面，有裁量、须节点授权）。两者共用一个白名单——操作者只需在一处表达"这台机器上允许跑什么"。

## 关键逻辑（HopSop）

```
executeRunScript(path, args, sandbox):
1. [act] 扩展名定解释器: ext = path 的小写扩展名
   1.1 [条件(ext == '.py')] cmd = 'python3'
   1.2 [条件(ext == '.sh')] 报错"shell 脚本不支持——shell 语义下脚本内容就是任意命令,
       白名单形同虚设;把逻辑写成 .py 脚本"（专项报文,与"不支持的扩展名"分开——.sh 是
       最可能被试的那个,给理由而不是给一句干巴巴的不支持）
   1.3 [条件(其他)] 报错"不支持的脚本类型 <ext>——当前支持: .py"
2. [act] 路径解析与读权限: resolveWorkspacePath → validateFileAccess('read')（与 read 同链同序）
3. [check] 脚本文件不存在 → 报错"脚本文件不存在: <path>"（执行语义预设文件在场,与 edit_file
   "目标不存在即报错"同款——不静默当空脚本跑）
4. [act] args 归一: 非列表 → 报错点名"args 须是字符串列表";列表元素逐个 String() 归一
5. [act] 审查并执行（.py 一律走 Python 语法沙箱,契约 [[../py-sandbox#^anc-pysb-exec]]）:
   runSandboxedPython(脚本绝对路径, args, { interpreter: cmd, whitelist: sandbox.runtime.available,
        timeoutSec: 60, maxBuffer: 64KB })
   ——内部:读一次原始字节 → 写私有副本 → 经原语跑检查器审副本 → 审过才经原语执行副本
   (cwd = dirname(脚本绝对路径),python3 -I -B,系统沙箱在场即套 wrapperArgv)。
   白名单核/hopjit 恒拒/spawn/失败三类指路仍全在原语内（^anc-exec-command-primitive）;
   白名单核对发生在检查器 spawn 之前,所以白名单两拒的报文与接入语法沙箱前逐字一致
6. [branch] 结果归一
   6.1 [条件(status == 'rejected')] ToolResult{success: false, result: 拒绝报文}——脚本没有执行;
       模型照报文改写脚本再调,是同一工具循环内最便宜的反馈环
   6.2 [条件(status == 'ran',不论退出码)] ToolResult{success: true, content_type: 'json',
       result: '{"returncode": n, "stdout": "...", "stderr": "...", "defense": "..."}'}
       ——**退出码非零照样 success: true**（失败是值:校验脚本对违规样例本该返回 1）
   6.3 [条件(抛出:白名单拒/超时/撞顶/spawn 失败/检查器自身运行失败)] ToolResult{success: false,
       result: 指路报文}——不抛出,错误经工具结果通道回执行方（与本模块其余工具同形）
```

## 消费侧接线（同批） ^anc-exec-run-script-wiring

1. **`examples/standard-decompose-codify/` 步 5.1.1 挂 `- 工具: run_script`**——special 件须节点声明才下发；正文"用执行环境 shell 跑生成的校验脚本"改写成按本工具的实际形态说话（跑的是 `.py` 脚本，不是 shell）。这一步是 0110 probe #2 的落点：27b 原参数复跑，步 5.1 不再因"找不到 shell"烧尽；
2. **`hopjit.yaml` 的 `commands` 加 `python3`**——本库自己的装配要能跑起来才能验收（配置改动须作者点头，见处置记录）；
3. **`act`/`act_free` 角色档的 Bash 纪律句条件化**——0110 候选 A，与本组同批（权威 [[../prompt-assembler#^anc-exec-l0-worldview-impl]]）：
   - standalone 装配的工具面里没有任何"自由写命令行"的工具，这句话在那里是纯误导；复用模式下 caller 自带 Bash，该句照渲染；
   - **本组的 `run_script` 不触发这句话**——模型给的是脚本路径与参数列表，命令行由引擎拼，管道与链式在这个接口上无法表达（^anc-exec-run-script-no-command-choice）；挂了 run_script 的 standalone 步骤同样不渲染。
4. **三份名单登记**（新件加入注册面就会让三个同源钉变红，各自是一次分类判断，不是机械补名）：
   - **B2 内置工具名单 + 签名表**（`validator.ts`）：入列，理由与"不入列会发生什么"写在 [[../spec-parser#^anc-rule-b2]]（要点：`category` 只管无 body act 的下发面，body 调用走解释器通路不看它——body 里调 `run_script` 合法且零声明，validator 必须认得，否则 commit body 跑脚本被 error 拒载、参数名笔误退回运行期才炸）；
   - **B9 写侧 / B10 读侧名单**（`validator.ts`）：**都不入**。这两份名单管的是"字面路径写盘拦截"（B9）与"读权限链"（B10）两条针对**文件路径参数**的静态判据。
     - 而 `run_script` 的 `path` 装的是**要执行的脚本**——它不写这个路径，脚本内容写到哪里是脚本进程的事，引擎静态期与运行期都看不见（工程偏差②）；
     - 把它塞进 B9 会让"模型 write 出脚本再 run 它"这个本组的正常形态被拦掉（脚本路径必然是字面或拼接形态），拦的还是一个它根本不写的路径；
   - **复用模式指引档分族名单**（`provider-types.ts`）：入**原生优先族**新常量 `NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES`，不入唯一语义源族——判据与"为什么要第二个常量"见 [[../prompt-assembler#^anc-exec-tool-manifest-source]] 第 4 条（要点：跑 `.py` 不是 HopSpec 专有语义，caller 自己的 Bash 跑 `python3 <脚本>` 等价，且教 tool-call 为主会把 caller 指向一条依赖它那侧多半没配的命令白名单的路）。

## 工程偏差（v1，如实标注）

1. **脚本内容能做什么，由 Python 语法沙箱收窄，不由命令白名单收窄**（tools v0.20.0，[[../py-sandbox]]）。命令白名单只管住解释器本身；
   - `.py` 脚本执行前一律过 Python 语法沙箱，`subprocess`、`os`、写模式 `open` 在源码里写不出来，审不过不执行；原有的两道人的授权（操作者把 `python3` 放进 `commands`、规约作者在那一步写下 `- 工具: run_script`）仍保留，与语法沙箱三者叠加；
   - 仍在的边界：语法沙箱只管"模型运行期写出来的脚本"，body 里规约作者写死的 `subprocess.run` 不走它（[[../py-sandbox]] 工程偏差④）；
2. **命令进程的写域**（原文继承 [[../act-body#^anc-exec-subprocess-run]] 工程偏差②"命令进程写哪里引擎无从拦"）：`.py` 脚本接入语法沙箱后，写模式 `open` 写不出来、没有 `os`/`shutil`，脚本自身不能落盘；macOS 上系统沙箱在场时 seatbelt 另拒一切文件写入。Linux 与系统沙箱缺席时，写域只由白名单保证（[[../py-sandbox]] 工程偏差③）；
3. **没有并发/资源额度**：一步之内模型可以连着跑 N 个脚本，各 60 秒。上限靠既有的工具循环轮数上限（`MAX_TOOL_ITERATIONS`）间接兜，本组不另设额度。真需求（跑测试套件这类长任务）出现时再议；
4. **扩展名表只有一行**——`.js`/`.mjs` 等没有实需不开（不是不能开，是开了没人用只增曝露面）。加一行的成本是几行代码 + 操作者白名单放行，随真需求走。

## 正反例

- **正**：模型 `write` 出 `guard_clause1.py` 与两份样例，然后 `run_script(path: "…/guard_clause1.py", args: ["…/test_violation.py"])` 拿到 `{"returncode": 1, "stdout": "VIOLATIONS FOUND: …", "stderr": "", "defense": "syntax+os-sandbox"}`，据此如实填 `verify_outcome`——**它写下的"退出码 1"是它看见的，不是它推断的**（这正是 0110 要治的那件事）；
- **反**：模型 `run_script(path: "check.sh")` → 被拒且报文说清"shell 脚本不支持，把逻辑写成 .py"（报文给出路，不是干巴巴的不支持）；
- **反**：某步没写 `- 工具: run_script` 却调它 → 该工具压根不在清单里，下发面与清单同源（special 零声明不下发）；
- **反**：`commands` 键空的环境里调它 → 报"未配置命令白名单"并指路 `hopjit.yaml` 的 `commands` 键，**不是**静默失败也不是含糊的"不可用"；
- **反（审查被拒）**：模型写的校验脚本里有 `import os` 或 `open(p, 'w')` → `run_script` 回 `success: false`，报文逐条写明第几行、哪个名字、为什么被拒、替代写法，**脚本没有执行**；模型照报文改写后再调即可；
- **反（把退出码当失败）**：校验脚本对违规样例返回 1，工具却回 `success: false` → 模型判定"执行工具也不好用"，重新开始找别的执行入口——这是本组最要命的一种实现错误，测试正反例成对钉住。
