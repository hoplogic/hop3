---
name: hopspec
description: Run an existing HopSpec file (reuse mode — opencode itself is the reasoning LLM; hopjit driver tools via MCP first, CLI fallback; zero API key): confirm parameters, answer intervention points, present the final state by contract. Dispatched by the hop skill; users do not invoke it directly. Ad-hoc tasks without a spec go through hop.
user-invocable: false
---

%% @trace
	id: hopspec-opencode-driver
	source: [[opencode-driver-carrier]]
	source_id: hopjit-opencode-driver-carrier
	type: extract
	last_sync: 2026-10-09T00:52+0800
	note: opencode 复用模式驱动件——派生自 driver/hopspec-skill.md（CC 源）,按 opencode-driver-carrier 原语映射表适配:AskUserQuestion→question 工具/Agent 工具 driver subagent→opencode subagent（无 subagent 能力时 inline 自跑,与 Codex 载体同款降级）/斜杠触发→隐式触发。执行语义/CLI 协议/介入点纪律与 CC 版逐条同构,CC 源改协议面时本件同批随改（rule-parity 同款"接受两份"）。§2 paused:question 工具降级约束贯穿段头+confirm/ask 各分派项——question 工具按 client 类型启用（不按 provider 过滤）,某些 OpenAI 兼容服务端（如 theta）拒收该工具,不可用时降级普通文本消息。
%%

# hopspec — 驱动 HopJIT 执行 HopSpec 规约（opencode 载体）

子命令语义：`run <spec> [params]` 执行 · `list` 列出可用 spec · `status` 查进度 · `resume` 崩溃恢复。用户说"执行/跑这份 spec"即触发本 skill。

驱动 HopJIT 执行引擎（hopjit CLI）执行一个 HopSpec 规约文件。你（opencode）自身作为推理 LLM，hopjit 管理执行状态、变量存储、retry/adaptive、None 传播等流控。

## 前置条件

- `hopjit` CLI 可用（全局 `npm i -g @hoplogic/hopjit`）
- 本壳为复用模式（你自身当推理 LLM），**不需要 API key**。要走 MCP 装配（执行在 hopjit MCP server 进程）用 **hopspec-mcp** skill——两壳不同名并存，用户点名哪个就是哪种模式。

> **🔴 启动最前：CLI 定位**。本 skill 用两个变量而非硬编码路径：
> - **`<CLI>`** = hopjit 调用前缀（`command -v hopjit` 输出的绝对路径）
> - **`<PKG>`** = hopjit 包根（放 driver/、examples/ 的目录，仅引用引擎自带资源时经 `npm root -g` 取）
>
> 任何动作**之前**定位一次：`command -v hopjit` **一条命令，命中固化绝对路径，不中直接报错**（找不到=没装好，提示 `npm i -g @hoplogic/hopjit` 装好重试，不翻目录找替代）。细则见 `references/cli-discovery.md`。

## 琐碎子命令：list / status / resume

`run` 是主体（下方执行流程）。其余三个各自简单：

- **list [目录]** — 列出可执行 spec 供挑选。完整流程 + recent-dirs LRU 见 `references/discovery.md`。
- **status** — 调 hopjit 的 `status` 工具（命令行回退：`<CLI> --json status --state-dir .hopstate [--instance <id>]`），展示进度。
- **resume** — 调 hopjit 的 `resume` 工具（命令行回退：`<CLI> --json resume --state-dir .hopstate [--instance <id>]`），recover + 推进到下一介入点/终态，回主编排循环（§2）分派。仅用于崩溃恢复，正常流程不碰。

## 执行流程

### 0. 前置：定位 spec + 组装 params

`run` 前先定位 spec 文件、组装 `--params`——完整流程（spec 搜索、recent-dirs 维护、读 `## Inputs` 推断参数 + 用 question 工具向用户确认；question 工具不可用时用普通文本消息呈现参数表、等用户下条消息回答后再 run）见 `references/discovery.md`。这是 run 的**必要前置交互**，不属"自主展开"。

### 0.5 跨通道防线（引擎硬闸,你只认报错）

任何 CLI 命令返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 MCP server 建立/驱动——本壳的 CLI 协议对它不适用，提示用户用 hopspec-mcp 继续那个 run，**不要强行重试**（双执行是最高危事故，硬闸拒绝即防线生效）。

### 1. 启动 + 驱动姿态（主 agent 编排，执行段外包 subagent）

**核心姿态**：run 之下，**主 agent（你）只做编排者，全程不碰执行链**——不自己调 `run`/`submit`（`run` 的 advance 会抢记首步 start → hoplog 重复；执行链全归执行 subagent）。你只：① 做 §0 前置（定位 spec + 组装 params，含问人）；② **派一个执行 subagent 跑执行段**（用你的 subagent 机制——内置 general 这类通用 subagent 即可，prompt 模板见 `references/driver-subagent.md`，填入 `<CLI>` 绝对路径 + `<STATE>` + `<SPEC>` + `<PARAMS>`）；③ 处理 subagent 带回的**介入点**（paused 问人 / adaptive replan / 终态）。执行段每步累积 context 是"哑应答体"式机械搬运，放 subagent 独立窗口跑，主上下文只留介入点 + 摘要。

**无 subagent 能力时的降级（inline）**：当前会话派不了 subagent 时，主 agent 自己按 `references/driver-subagent.md` 的循环跑执行段——执行语义完全不变（与 Codex 载体 inline 模式同款降级），只是隔离主上下文的收益没有了。paused 的问人纪律照守。

**执行节奏归引擎**：主 agent 与 subagent 都**不主动推进**——只在引擎给的介入点应答。

**驱动通道：hopjit MCP 工具优先，命令行回退（todo/0146）**：本篇与 references/ 里的命令写成 `<CLI> --json <子命令> ...`，会话里能调 hopjit MCP 的工具时一律改用同名工具——`run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `status` / `resume` / `abort` / `validate` 七个子命令各对应一个工具，引擎调用与响应相同，参数名是 CLI 参数去掉 `--`、连字符换下划线（`--instance` → `instance_id`，`--child-instance` → `child_instance`，`--output '<JSON>'` → `output = <对象>`，`@<路径>` 形态照用）。工具不调 LLM，推理仍在本会话与执行 subagent 里。opencode 安装缺省 `mcp.hopjit.enabled: false`，工具多半不可见：用户把它改为 `true` 并放行 hopjit 工具后新会话才可用，你不改用户配置。派执行 subagent 时在 prompt 里写明"有 hopjit 工具就用工具"。工具不可见时用命令行，纪律如下（硬约束，主 agent 与 subagent 都遵守）：
- **每条 bash 调用只做一件事**：不链式（`&&`）、不管道（`|`）、不变量赋值、不截断输出（唯一例外：spec 含 doc-ref 时前置 `cd <VAULT> &&` 锁 cwd）。`| head -c 400` 一类截断会多触发一次确认，并丢掉响应后半截的字段
- **直接写完整命令**：`<CLI> <子命令> <参数>`，不缩写、不用 shell 变量
- **自己读 JSON**：每条 CLI 命令**必须带全局 `--json`**——返回的 JSON 原样读完按 `status` 分派，不 `| python3 -c` / `| node -e` 提取

> 主 agent 自己**只**跑 §2 paused/adaptive 的 `submit_and_fetch_next --answer/--replan`（注入问人结果），**不跑 run、不跑执行步的 submit**（inline 降级形态除外）。
> **不要 `rm -rf .hopstate`**——run 在 state-dir 下创建带唯一 instance_id 的新实例，旧实例不干扰。需要干净环境时用新的 `--state-dir` 名。

### 2. 主 agent 编排循环（你只处理介入点）

执行 subagent 返回后拿到 JSON（+ instance_id），按 `status` 分派。**编排循环**：处理完一个介入点 → 拿到下一步 JSON → 再分派，直到终态。

#### `step_ready` → **派执行 subagent 跑执行段**

step_ready 意味着一段**纯执行**（连续 reason/act/check/commit）。派一个执行 subagent 跑它——prompt 模板见 `references/driver-subagent.md`：
- **首个执行段**：subagent 从 `run` 起（传 `<SPEC>` + `<PARAMS>`），它跑 run + 后续 submit 循环，回报 instance_id。**你记住这个 instance_id**——后续介入点注入用它。
- **介入点后续接**（paused/adaptive 注入后又是 step_ready）：派**续接 subagent**——传 `<INST>`（instance_id）**+ `<PENDING>`（你注入 `--answer`/`--replan` 后拿到的返回 JSON，原样完整、不摘要）**。那个 JSON 是引擎只发一次的在手动作，消费权随交接转移——不传它，续接 subagent 无协议通道取回，只能盲驱。

subagent **一直跑到下一个介入点**（paused / adaptive_needed / tool_request）或**终态**（completed / failed）才停，把那个 JSON + 摘要返回给你 → **回本编排循环继续分派**。

#### `paused` → **必须停下问人，禁止自己替答**（主 agent 专属）

⚠️ **硬约束（违反即错误）**：paused 是 spec 作者**显式声明的介入点**——作者特意放了 confirm/ask，就是要**外部决策者**（人）来定。你**必须停下问人**——优先用 **question 工具**向用户展示问题、等用户回答；question 工具不可用时（如服务端拒收该工具）用普通文本消息呈现问题与选项，等用户下条消息回答后再注入。**禁止**自己推理出答案就 submit。（paused 归主 agent 而非 subagent——subagent 无权、也无法问真人。）

按 `pause_reason` 分派：

**`dirs`（Config.dirs 目录授权,run 起跑后第一个停点,todo/0148）→ 必须问人同不同意**：spec 在 `## Config` 的 `dirs` 里声明了 workspace 之外的目录、而本机没批过这份清单时停下。`presented_data.context` 带 `dirs`（每条 `path` + `mode`,mode 是 read 只读或 readwrite 读写）与 `dirs_hash`;`step_id` 为空（run 级前置条件,不属于任何步骤）。
1. 先用普通 text 消息把清单逐条列出（路径 + 只读/读写），一句话说清"这个活要碰 workspace 之外的这几个目录，读写的那几个 commit 步骤会往里写文件";
2. 用 question 工具问同不同意——**这一问就是批准**，每份清单只问一次;
3. 同意 → `approve_dirs(instance_id, dirs_hash)`（工具不可用时走命令行 `<CLI> --json approve_dirs <dirs_hash> --state-dir .hopstate --instance <instance_id>`），再 `resume` 续跑;不同意 → 不调，告诉用户活没开始，问是改 spec 还是放弃;
4. 同一份清单批过一次后重跑、续跑都不再停;声明或 Inputs 传的目录变了会重新问。起跑时带 `approve_dirs`（命令行 `--approve-dirs`）可直接记账跳过停点。

**`commit`（不可逆步骤需要人确认）→ 必须问人批不批**：每个 `[commit]` 步骤第一次执行前，引擎先做安全分析：body 里的动作全部可逆或低危（新建文件、追加、建目录、移动、写入前已把旧版本留存进回收站的覆盖与删除、只写 work_zone 的写入）时直接执行，不出现停点，driver 什么也不用做；有动作会销毁内容且找不回（`keep: 0` 的覆盖与删除）、运行命令、发通知或调外部工具时，由 hopjit 配置的模型分析一次——模型判全部安全同样直接执行、以后不再问，否则转人工停在这里；本宿主没有分析模型（命令行 hopjit 不配置分析模型）或分析出错时也转人工。driver 自己不做安全判断。`presented_data.context` 带 `step_id`、`fingerprint`（指纹）、`analysis`、`body` 原文;`analysis` 是 `{summary, actions, recommendation, model, source}`——`actions` 每条有 `line`（动作所在的 spec 行号）、`category`（动作种类）、`verdict`（`safe` 或 `human`，`human` 是需要人确认的）、`consequence`（这个动作执行后的后果，已经写成不懂代码的人也读得懂的话）;`source` 为 `template` 表示没有分析模型或分析出错，后果说明来自固定模板。`presented_data.response_options` 是三个选项：`once`"只批准这一次"、`task`"这一步以后都通过"、`deny`"不批准"。
1. 大部分用户不懂代码，所以**代码不先贴**：先用一句话讲 `analysis.summary`，再逐条列出 verdict 为 `human` 的动作的 `consequence`，最后讲 `analysis.recommendation`;用户要看代码时再贴 `context.body`。然后用 question 工具（不可用时按段头降级）给出这三个选项——**这一问就是批准**。对话里这一问就是批准，载体对 approve_commit 弹不弹窗与批准无关。
2. 用户选"只批准这一次"或"这一步以后都通过" → `approve_commit(instance_id, step_id, fingerprint, scope)`（`fingerprint` 取 `context.fingerprint`，`scope` 取所选项的 value：`once` 或 `task`）（工具不可用时走命令行 `<CLI> --json approve_commit <step_id> --fingerprint <fingerprint> --scope once|task --state-dir .hopstate --instance <instance_id>`），再 `resume` 续跑，引擎执行 body；用户选"不批准" → 不调 approve_commit，告诉用户这一步没执行，问是改 spec 重跑还是 `abort`。**禁止**替用户回答，也不许自己判断这一步安全就调 approve_commit——安全分析已经由引擎和分析模型做过，转到人这里只认人的选择。
3. 指纹只覆盖 body 原文，body 改了指纹就变，引擎重新分析、重新问。"只批准这一次"只在本次运行里有效：本次运行里 for-each 的各轮、并行子实例、续跑都不再停，下次运行这份 spec 还会再问;选"这一步以后都通过"之后，这一步的 body 不变就一直直接执行。提交前 HOP 的核验（check final）或确认（confirm）照常把关。被拒返回 COMMIT_NOT_APPROVED 时，报文里写着完整的 approve_commit 参数，照报文做（先按上面的方式讲给用户听并用三个选项问，用户选批准后再调）。带 body 的 commit 不能用 submit 提交产出（COMMIT_BODY_ENGINE_ONLY）。续跑拿到下一步 JSON → **回编排循环分派**。

**`confirm`（审批闸门）→ 必须问人批不批**：
1. 用 question 工具展示 `presented_data.question` + `response_options`（approve/reject），等用户选（question 工具不可用时按段头降级——用普通文本消息呈现问题与 approve/reject 选项，等用户下条消息回答后再注入）
2. 用户选定后注入（**带 `--instance <id>` 跨进程定位**）：
```bash
<CLI> --json submit_and_fetch_next <step_id> --answer '{"value":"<用户选择>"}' --state-dir .hopstate --instance <instance_id>
```
3. approve→映射 bool true；reject→全局中止。**禁止**自己判断该不该批
4. 注入后拿到下一步 JSON → **回编排循环分派**（若又是 step_ready → 派续接 subagent）

**`ask`（数据收集）→ 必须问人要值**：
1. **🔴 呈交硬约束（present_inputs）**：若 `presented_data.present_inputs` **非空**（如 `["raw_outline", "draft"]`），你**必须**在调 question 工具**之前**先用普通文本消息把 `context` 里这些字段的**原文完整 dump** 给用户——**禁止**只给标签、省略号或摘要后就问。这是 spec 作者显式声明的"必须看完才能答"的呈现契约，缩略 = 让用户在没看清的状态下拍板,**等于违反 ask 语义**。

   **`context` 字段两种形态**：
   - **原值**（小于 5K 字符）：直接是字符串/对象，原样 dump 即可，长内容用 ` ``` ` 围栏
   - **`{$file, preview}` 复合**（≥ 5K 字符，引擎自动卸载）：preview = 头 5K 字符 + "...[完整内容见文件]"。完整 dump preview 给用户，**并提示**"完整内容见 `{$file 路径}`"。用户想看完整时你读该文件再展示

   **禁止二次摘要**：preview 已经是引擎按"人友好阈值"卸载的产物，你不应再压缩它。
2. 用 question 工具展示 `presented_data.question`，并把 `output_schema`（要填的变量+类型）、`default_value` / `default_values`（前序推断的建议值——后者按声明名分键，每个声明一份）、`context`（候选来源）一并呈现（question 工具不可用时按段头降级——用普通文本消息呈现问题与选项，等用户下条消息回答后再注入）
3. 选项构造：若有推断默认值，第一项给"采用默认：<default_value>"；再列其它候选（来自 context）；用户可自由输入
   **结构化类型的声明（yaml / 列表 / 类型面）先给人一个可以改的东西，不让人凭空写**：`default_values` 里有这个声明（按声明名分键，值是前序步骤产出的同名变量）→ 把它完整呈给用户（可读的 YAML 块，不缩略），问"照这个用，还是改哪里"，用户改完按声明名提交；`default_values` 里没有它、也没有 `present_inputs` 样板 → 如实告诉用户"这一步要你给完整的 <名>（<类型>），没有样板"并列出 `output_schema` 的字段名，不替用户编——这种 spec 写得不对（validate 会给 V17 warn），事后回写卡时前置一个备料步骤。
4. 用户给值后注入（用用户提供的**真实值**，不是 approve；带 `--instance`）：
```bash
<CLI> --json submit_and_fetch_next <step_id> --answer '{"value":"<用户提供的真实数据值>"}' --state-dir .hopstate --instance <instance_id>
```

   **多输出 ask（步骤声明了两个以上 `+ →`）按声明名提交**：`--answer '{"<声明名1>":"<值1>","<声明名2>":"<值2>"}'`——放进 `{"value": {...}}` 信封里引擎也认（按键拆开）,但不要把一个值裸给多个声明;文本型声明（line/text/markdown）给的不是字符串会被 `ASK_ANSWER_SHAPE` 拒收并带样例,照样例改后重交同一步。
   **值大时（如整份大纲/草稿）**：把 `{"value":"..."}` 整个写到 paused 响应给的 `work_zone` 目录下（如 `<work_zone>/answer_<step_id>.json`），再整包 `--answer @<该路径>`。`@` 只贴 `--answer` 参数最前面，绝不写进 JSON 字段值；只写 work_zone、不写 /tmp。
5. **禁止**把 approve 当数据值——ask 要的是业务值（如"技术规范"），不是审批信号。用户若想采用默认，把 default_value 的真实内容作为 value 注入
6. 注入后拿到下一步 JSON → **回编排循环分派**

> **例外**：`require_human: false`（未强制真人）且问题确实可由上下文无歧义推断时，才允许主 agent 代答——**代答判断/要不要强问，参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引，如"已给且存在直接采用不必强问"；question 是给人的纯问题面，不含这些指引）**。但 confirm/ask 默认倾向问人，拿不准就问。`require_human: true` 时**绝对必须**真人回答，零例外。

#### `adaptive_needed` → 重规划（主 agent）
**先看 `reason` 字段分流**：`reason: "initial_plan"` = 这不是失败——是 `[subtask free]` 到步索首计划：读 `expansion_context`（容器输入的**运行时实际值**,null 值项见 `missing_inputs` 清单）+ `subtask_contract` 出计划,**计划必须含 check 步（主干）、禁 commit**（引擎强制,违者拒收）。无 `reason` 字段 = 既有失败驱动语义：读失败上下文（`failure.reason` + `subtask_contract`），生成新步骤 markdown。两种都同样提交（带 `--instance`）：
```bash
<CLI> --json submit_and_fetch_next <subtask_id> --replan '<新步骤 markdown>' --state-dir .hopstate --instance <instance_id>
```
返回值即重规划后的下一步 → **回编排循环分派**（step_ready 则派续接 subagent，把这个返回 JSON 作 `<PENDING>` 原样传入——它只发一次，你不消费就必须随交接转移）。

#### `completed` → YAML 结构化输出全部 outputs，结束

只读取终态响应的 `outputs`，序列化为 YAML 代码块报告：

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不加说明。**禁止摘要、改写、节选或省略任一输出字段**；对象/列表递归转 YAML，多行字符串用 literal block（`|-`），字段值保持原样。（与 CC/Codex 载体同一呈现契约——终态是交付物，完整性优先于简洁。）**YAML 块所在的这条消息就是你的最后一条消息**：人话摘要写在同一条消息里、块的下方；发完即结束，**不要再另发收尾消息**（另发=把 YAML 块挤出终位）。

⚠️ **长程流程末尾尤其容易违反本契约**（多介入点走完后顺手用人话总结收尾、忘贴 YAML 块）。subagent 终态回报已按模板附排版好的 YAML 块——**原样转发它**，人话摘要只能放在块后，不能替代块。

> **手机通知（用户要了才发——引擎挂点,driver 只翻译意图）**：用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ run 命令加 `--notify dingtalk`（渠道入实例账,终态/停点引擎自动推卡片;发不发判断恒归引擎——话语渠道×凭证环境变量两者齐才发）。你只翻译意图,不自行拼发送。发送失败引擎留 `[notify]` 行 → 转告用户一句照常干活。

#### `failed` → YAML 结构化失败信息，结束

```yaml
status: failed
step: <failed_step_id>
reason: <原始 failure_reason>
```

代码块外不加说明；`reason` 多行时用 literal block，禁止摘要或补写推测。

#### `dispatch_ready` / `drain_wait` → 并行派发（首版按串行退化处理）

parallel 标注步骤在无后台 subagent 能力的载体上按顺序执行（引擎保证结果与并行一致）。收到 `dispatch_ready`：`dispatch_kind: call` 时 callee 路径引擎已填好（同目录 `<id>.md` 优先,其次已装 HopAnt `~/.hopjit/ants/<id>/<id>.md`）;命令里仍留 `<CALLEE_SPEC_PATH:id>` 占位说明两处都没找到,先按 `references/discovery.md` 的 spec 发现流程解析 callee 真实路径填入（唯一允许的改动,其余参数禁改）；然后在当前窗口顺序执行该命令到 worker 终态，再 `<CLI> --json reap_and_fetch_next <child_instance> --status <completed|failed> --instance <id>` 收割，继续循环；`drain_wait` 且无在飞=继续 advance。**reap 只用于引擎 dispatch_ready 派发过的 child**；没跑过的 child 不许凭空报 completed。

### 3. 异常处理

- hopjit 命令返回非零 exit code → 读 stderr，报告错误。
- `submit_and_fetch_next` 返回 `SCHEMA_MISMATCH` → 输出不符 schema，修正后重 submit 同一步（引擎未推进）。
- 全部 retry 耗尽 → 引擎自动传播 fail，submit 最终返回 `failed`。
- 执行段细则（tool_request 应答/工具故障出口/幂等回执/WAITING_WRITEBACK）见 `references/step-execution-rules.md`。

## 进度展示与措辞

执行段在 subagent 内，主 agent 在介入点粒度报进度：subagent 返回时转述一行执行摘要，再报当前状态。

**🔴 对用户的措辞说人话（零行话）**：介入点/终态/subagent/segment 是**协议词汇**——本文档内部随便用，**不进用户可见消息**。启动后不说"等待介入点"，说"任务执行中，完成或需要你确认时我会回来"；paused 说"有一处需要你确认/填写"；completed/failed 说"已完成/执行失败"。

## 输出纪律（硬约束）

职责是**驱动执行 + 报告结果**，不是借机做研究。**禁止**：未经要求就翻 hoplog/state.json、做多次运行对比、写根因分析、长篇解释引擎内部行为。引擎"一次返回 completed"是**正常优化**（纯计算 body 被引擎消化），不是异常。确有疑点一句话指出，深查先问用户。

## 约束

- `.hopstate/` 目录存放执行状态，应加入 `.gitignore`
- 不要修改 spec 文件本身——执行过程只读 spec，状态全在 .hopstate
- reason/check 步骤：你直接推理，不另调 LLM API（避免双重收费）
- act/commit 步骤：有 hop_python body 则**严格按 body 执行、不自由发挥**（引擎直执，你只应答 tool_request）；无 body 才按自然语言描述用工具执行。操作范围受 spec 中 SandboxConfig 约束
