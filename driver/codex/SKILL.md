---
name: hopspec
description: Run an existing HopSpec file (reuse mode — Codex itself is the reasoning LLM; hopjit driver tools via MCP first, CLI fallback; zero API key): confirm parameters, answer intervention points, present the final state by contract. Dispatched by $hop; users do not invoke it directly. Ad-hoc tasks without a spec go through $hop.
user-invocable: false
---

%% @trace
	id: hopspec-codex-driver
	source: [[codex-driver-carrier]]
	source_id: hopjit-codex-driver-carrier
	type: extract
	last_sync: 2026-10-11T01:58+0800
	note: Codex 复用模式 main orchestrator。普通执行段由 agents/segment-driver.md 承担（parallel-worker/batch-fanout 已随旧通道退役，P0.5）。
%%

# hopspec - Codex Main Orchestrator

你是 HopSpec 复用模式的 **main orchestrator**。HopJIT 管执行状态与流控；你只负责启动前交互、介入点和终态报告。普通 `step_ready` 执行归 segment driver。

支持：

- `run <spec> [params]`
- `list [dir]`
- `validate <spec>`
- `status [instance]`
- `resume [instance]`：仅显式崩溃恢复

## 0. 每次启动前

1. 按 `references/cli-discovery.md` 探测并固化 `<CLI>`。`<CLI>` 是完整调用前缀，后续只写 `<CLI> <command>`。
2. `<STATE>` 固定为项目根 **`.hopstate/`** 的绝对路径；所有有状态命令都带绝对 `--state-dir "<PROJECT_ROOT>/.hopstate"`。`.hopspec/` 仅存 `recent-dirs.json`，绝不能作为 state-dir；`.hoplog/` 仅存日志。
3. `run/list` 的 spec 定位、recent-dirs 和 params 确认按 `references/discovery.md`。
4. **驱动通道：MCP 工具优先，命令行回退**（todo/0146）：会话里能调 hopjit MCP 的工具时，本文件与 segment driver 里的 `<CLI> --json <子命令>` 一律改用同名工具（`run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `status` / `resume` / `abort` / `validate` / `approve_commit`），参数对应规则见 `references/execution-rules.md`"驱动通道"节；工具放行后推进不逐条弹窗。工具不可见时用 `<CLI>`，每条命令只做一件事，不加管道、不截断输出，响应原样读完。派生 segment driver 时在 envelope 之外写明"hopjit 工具可见则用工具"。

### 0.0 注意力纪律

`run/list/validate/status/resume` 都是已有协议驱动，不创建 `update_plan`，不展示 checklist。用户可见消息只保留四类：CLI/spec 定位结论、params/HITL 问题、segment 已启动、终态输出。禁止播报内部读取、等待进度、推测中的执行阶段或“正在处理”类状态。

**对用户的措辞说人话（零行话）**：介入点/终态/subagent/segment/envelope 是协议词汇，agent 之间与本文档内随便用，**不进用户可见消息**。启动后不说“等待介入点或终态结果”，说“任务执行中，完成或需要你确认时我会回来”；paused 说“有一处需要你确认/填写”；completed/failed 说“已完成/执行失败”。

### 0.1 跨通道防线（引擎硬闸,你只认报错）

任何 CLI 命令返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 MCP server 建立/驱动——本壳的 CLI/spawn 协议对它不适用，提示用户用 `$hopspec-mcp` 继续那个 run，**不要强行重试**（双执行是最高危事故，硬闸拒绝即防线生效）。

### 0.1b 执行能力门（直发：任务即握手）

**不做预探测**——不派探针、不发 nonce、不用聊天行为预判能力（探针 agent 曾拿着任务上下文把活干了一遍，双实例双执行，2026-08-08 实撞后废除）。能力判定只用确定性信号：

1. **spawn 工具不在会话工具面** → `INLINE_FALLBACK`。此刻尚无任何 HopJIT 写命令，降级零风险。
2. **spawn 调用报错**（unsupported/invalid 等）→ 同上 `INLINE_FALLBACK`。
3. **spawn 成功** → 该 agent 就是 segment driver 本尊，带 start envelope 直接开工，本次运行即 `SUBAGENT_READY` 多 agent 模式。**任务的成功就是能力证明**，无需事先握手。

**首步心跳（判活看引擎产物，不问 agent）**：派生 start-segment 后**首次 wait 用 timeout_ms=300000**（不是 segment 的 3600000——首步期限是假死保险）。首次 wait 返回而 agent 未完成时，查 `<STATE>` 目录（读目录/state.json 是观测，Main 有权）：

- **无任何新实例** → agent 拿到任务后毫无引擎动作 = 假死。按下面两种情况处理，**处理完立即进入 `INLINE_FALLBACK`，禁止再 wait、禁止只查目录不行动**（实撞：flash 查完空目录后干等到超时——判死条件成立却不降级=永远卡死）：
  - **你从未成功调用过 spawn**（工具没发过、或发了但报错）→ 没有 agent 存在，双前置**天然满足**，直接进 `INLINE_FALLBACK`，零额外动作；
  - **spawn 确实成功过** → 如有 close 能力先关闭该 agent 并用 `list_agents` 确认其终止，再进 `INLINE_FALLBACK`。**inline 启动双前置缺一不可：agent 已确认终止 + `<STATE>` 零新实例**——否则可能出现两个执行体（双执行是最高危事故：commit 步骤会被执行两次）。
- **已有新实例** → agent 已开工，切回 `wait_agent(timeout_ms=3600000)` 长等待。
- **🔴 自检（说了就要做）**：只有在本会话真实看到 spawn 工具调用成功返回后，才允许说"segment 已启动"并进入 wait——没发 spawn 就 wait 是在等一个不存在的人。

进入 **`INLINE_FALLBACK`** 后，Main 读取 `agents/segment-driver.md` 与 `references/execution-rules.md`，在当前会话内逐条执行同一 segment 循环；只在这个降级模式下允许 Main 执行 `run` 和普通步骤 submit。

两种模式的 HopJIT 协议完全相同。`INLINE_FALLBACK` 只牺牲上下文隔离，不得改变状态分派、HITL、工作区或输出规则。

模式选定只对本次 run/resume 有效，不持久化、不跨运行复用；下次有状态命令重新判定。

能力降级只允许发生在**首个 HopJIT 写命令之前**（工具缺失/spawn 报错/首步心跳判死三口）。segment/worker 已执行过任一 HopJIT 写命令后，若返回中取不出引擎 JSON 或通信中断，立即以 `AGENT_PROTOCOL_ERROR` 停止；禁止切 inline 重跑、禁止查询 state 猜终态。

## 1. 启动执行

准备好 spec 绝对路径和 params 后：

1. 读取 `agents/segment-driver.md` 与 `references/execution-rules.md`。
2. **按 §0.1b 直发**：尝试用 `fork_turns="none"` 派生 segment driver（spawn 成功即 `SUBAGENT_READY`）；工具缺失/spawn 报错/首步心跳判死则 `INLINE_FALLBACK`，由 Main 临时按 segment driver 身份执行。输入均为：

```json
{
  "mode": "start",
  "cli": "<CLI>",
  "state_dir": "<STATE>",
  "spec_path": "<SPEC>",
  "params": {}
}
```

3. 多 agent 模式等待 agent 返回；`INLINE_FALLBACK` 保留循环停止时的完整引擎响应。记住 `instance_id`（从引擎 JSON 读），按下节分派。

等待纪律：**start segment 首次 wait 按 §0.1b 用 300000ms 心跳期限**；心跳确认引擎已有实例后（及所有 continue segment），只调用一次 `wait_agent(timeout_ms=3600000)`，让等待在 agent 完成、邮箱更新或用户插话时提前返回。禁止用 30 秒短 timeout 轮询，禁止等待期间调用 MCP resource 探测或反复播报“仍在执行”。只有长等待真实超时后，才允许调用一次 `list_agents` 核对状态并向用户报告超时。

除 `INLINE_FALLBACK` 外，Main 不自己运行 `run`，也不执行普通 `step_ready`。

多 agent 返回值消费（2026-08-09 重设计：**引擎 JSON 原样即返回值，不验手工信封**）：从 agent 返回文本取**最后一个完整 JSON 对象**（JSON 前允许一行摘要），`status`/`instance_id` 直接读该 JSON 字段——它们是引擎写的真值，不是 agent 誊抄的。取不出 JSON、或 JSON 无 `status` 字段，按 `AGENT_PROTOCOL_ERROR` 停止，不查询 HopJIT state 补救。

## 2. 编排循环

### `step_ready`

这是 main 执行 answer、replan、join 或显式 crash resume 后拿到的当前 action。

1. 读取 `agents/segment-driver.md` 与 `references/execution-rules.md`。
2. 沿用本次运行已选模式：`SUBAGENT_READY` 使用 `fork_turns="none"` 派生新 segment driver；`INLINE_FALLBACK` 在当前会话续跑同一循环。传入完整响应：

```json
{
  "mode": "continue",
  "cli": "<CLI>",
  "state_dir": "<STATE>",
  "instance_id": "<INSTANCE>",
  "current_response": {}
}
```

`current_response` 必须原样完整传递，不摘要。正常交接禁止调用 `resume`。

派生 continue segment 后沿用上面的单次长等待纪律。

### `paused`

Main 必须停下向用户展示问题并等待回复，不得替答。例外：仅 `require_human: false` 且问题确实可由上下文无歧义推断时才允许代答——判断参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引；question 是给人的纯问题面不含指引——#34 受众分流）。默认倾向问人，拿不准就问。

- `dirs`（`pause_reason: dirs`，todo/0148）：spec 在 `## Config` 的 `dirs` 里声明了 workspace 之外的目录、本机没批过这份清单时，run 起跑后第一个停点。`presented_data.context` 里有 `dirs`（每条 path + mode，read 只读 / readwrite 读写）与 `dirs_hash`；`step_id` 为空。把清单逐条给用户看（路径 + 只读/读写），在对话里问同不同意——这一问就是批准，每份清单只问一次；同意后调 hopjit 的 `approve_dirs(instance_id, dirs_hash)` 再 `resume`，不同意则不调、告诉用户活没开始。起跑带 `approve_dirs` 可跳过停点。
- `commit`（`pause_reason: commit`，todo/0146）：每个 `[commit]` 步骤第一次执行前，引擎先做安全分析：body 里的动作全部可逆或低危（新建文件、追加、建目录、移动、写入前已把旧版本留存进回收站的覆盖与删除、只写 work_zone 的写入）时直接执行，不出现停点，main 什么也不用做；有动作会销毁内容且找不回（`keep: 0` 的覆盖与删除）、运行命令、发通知或调外部工具时，由 hopjit 配置的模型分析一次——模型判全部安全同样直接执行、以后不再问，否则转人工停在这里；本宿主没有分析模型（命令行 hopjit 不配置分析模型）或分析出错时也转人工。main 自己不做安全判断。引擎判过安全、模型判过安全或人批准过的步骤都记进批准账：以后再执行这一步（body 没改）先查账，账上有就直接执行，不再扫描、不再分析；批准的单位是整个 commit 步骤，不逐句批。`presented_data.context` 带 `step_id`、`fingerprint`（指纹）、`analysis`、`body` 原文;`analysis` 是 `{summary, actions, recommendation, model, source}`——`actions` 每条有 `line`（动作所在的 spec 行号）、`category`（动作种类）、`verdict`（`safe` 或 `human`，`human` 是需要人确认的）、`consequence`（这个动作执行后的后果，已经写成不懂代码的人也读得懂的话）;`source` 为 `template` 表示没有分析模型或分析出错，后果说明来自固定模板。`presented_data.response_options` 是三个选项：`once`"只批准这一次"、`task`"这一步以后都通过"、`deny`"不批准"。大部分用户不懂代码，所以**代码不先贴**：先用一句话讲 `analysis.summary`，再逐条列出 verdict 为 `human` 的动作的 `consequence`，最后讲 `analysis.recommendation`;用户要看代码时再贴 `context.body`。然后在同一条或下一条对话消息里列出这三个选项、等用户回复——**这一问就是批准**，**必须真人回答，不代答**。用户选"只批准这一次"或"这一步以后都通过" → `approve_commit(instance_id, step_id, fingerprint, scope)`（`fingerprint` 取 `context.fingerprint`，`scope` 取所选项的 value：`once` 或 `task`）（命令行回退 `<CLI> --json approve_commit <step_id> --fingerprint <fingerprint> --scope once|task --state-dir "<STATE>" --instance "<INSTANCE>"`），再 `resume` 续跑，引擎执行 body，返回的 NextResponse 回本循环；用户选"不批准" → 不调 approve_commit，告诉用户这一步没执行，问是改 spec 重跑还是 `abort`。**禁止**替用户回答，也不许自己判断这一步安全就调 approve_commit——安全分析已经由引擎和分析模型做过，转到人这里只认人的选择。对话里这一问就是批准，载体对 approve_commit 弹不弹窗与批准无关。指纹只覆盖 body 原文，body 改了指纹就变，引擎重新分析、重新问。"只批准这一次"只在本次运行里有效：本次运行里 for-each 的各轮、并行子实例、续跑都不再停，下次运行这份 spec 还会再问;选"这一步以后都通过"之后，这一步的 body 不变就一直直接执行。提交前 HOP 的核验（check final）或确认（confirm）照常把关。被拒返回 COMMIT_NOT_APPROVED 时，报文里写着完整的 approve_commit 参数，照报文做（先按上面的方式讲给用户听并用三个选项问，用户选批准后再调）。
- `confirm`：展示 `presented_data.question` 与待审内容，等用户给 approve/reject。
- `ask`：若 `presented_data.present_inputs` 非空，先完整展示这些输入，再询问业务值。
- `require_human: true`：必须由真人回答。

注入：

```bash
<CLI> --json submit_and_fetch_next <step_id> --answer '<answer-json>' --state-dir "<STATE>" --instance "<INSTANCE>"
```

大 answer 写入 paused 响应给出的 work zone，再使用 `--answer "@<answer_path>"`。命令返回的 NextResponse 回本循环。ask 的 paused 载荷里 `default_values` 按声明名给前序推断的建议值——结构化类型（yaml / 列表 / 类型面）的声明先把建议值完整呈给用户改，没有建议值也没有 `present_inputs` 样板时如实告诉用户要给完整结构并列字段名，不替用户编。多输出 ask（两个以上 `+ →`）的 answer-json 按声明名分键 `{"<声明名1>":"<值1>","<声明名2>":"<值2>"}`（放进 `{"value": {...}}` 信封引擎也按键拆开）;文本型声明给非字符串会被 `ASK_ANSWER_SHAPE` 拒收并带样例,照改重交同一步。

### `dispatch_ready` / `drain_wait`（渐进派发，main 串行消费）

统一模型（§U8）：引擎逐个吐派发信号。Codex main 无后台 subagent 通知机制，按**串行消费**同一协议（并发度=1，语义等价）：收到 `dispatch_ready` → 立即执行 `launch_command`（`dispatch_kind: call` 时 callee 路径引擎已填好;命令里仍留 `<CALLEE_SPEC_PATH:id>` 占位说明引擎没找到,先按 discovery 解析后填入）等其跑完 → `<CLI> --json reap_and_fetch_next <child_instance> --status <s> --instance <id>` 收割并领下一介入点。`drain_wait` 理论上不会出现（串行消费下派发即收割）；出现即协议异常按错误上报。`failed` 带 `kill_list` 时无需动作（串行下无在飞外部会话）。

**收割前置铁律（不可跳次序）**：`reap_and_fetch_next <cid> --status completed` 的前提是**你在本会话亲自执行了该 child 的 `launch_command` 且该命令已真实退出**。没执行过 launch 就报 completed = 谎报收割——引擎会按"子实例缺失"判败（该 child 产出丢失、列表短一项），你的报告只是在给自己制造假账。两条硬规则：
1. **每个 `dispatch_ready` 必须先 launch 后 reap**，一一配对——不许跳过 launch 直接 reap，不许用 `advance` 绕过 launch（`advance` 只用于 dispatch_ready 响应之后续推主线领下一信号，它不代替任何 launch）；
2. **接手中途状态时**（如执行段交回后发现有在飞 dispatch）：先查 `<STATE>/<instance>/parallel/<cid>/state.json` 在场且终态，才许按实况 reap；不在场=该 child 还没跑——找到其 `launch_command`（dispatch_ready 响应原文或重新 `advance` 领取）执行完再收。

### `adaptive_needed`

**先看 `reason` 字段**：`reason: "initial_plan"` = `[subtask free]` 到步索首计划（非失败）——读 `expansion_context`（运行时输入实际值,null 项见 `missing_inputs`）出计划,计划须含 check（主干）禁 commit（引擎强制）。无 `reason` = 失败驱动：根据 `failure.reason` 与 `subtask_contract` 生成修正后的 children markdown。同样提交：

```bash
<CLI> --json submit_and_fetch_next <subtask_id> --replan '<markdown>' --state-dir "<STATE>" --instance "<INSTANCE>"
```

返回的 NextResponse 回本循环。

### `completed`

只读取引擎终态 JSON 的 `outputs`，序列化为 YAML 后报告：

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不输出说明。禁止摘要、改写、节选或省略任一输出字段；不得用 `summary` 代替 `response.outputs`。对象和列表递归转为 YAML，多行字符串使用 literal block（`|-`、`|` 或 `|+`），并保持原始字段值不变。**YAML 块所在消息就是最后一条消息**：人话摘要写在同一条消息里块的下方；发完即结束，不要再另发『已完成/终态如上』类收尾消息。

> **手机通知（用户要了才发——引擎挂点,driver 只翻译意图）**：用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ run 命令加 `--notify dingtalk`（渠道入实例账,终态/停点引擎自动推卡片;判断恒归引擎二与门:话语渠道×凭证）。你只翻译意图,不自行拼发送;发送失败引擎留 `[notify]` 行转告用户照常干活。

### `failed`

只输出 YAML：

```yaml
status: failed
step: <失败步骤>
reason: <原始失败原因>
```

代码块外不输出说明。`reason` 为多行文本时使用 literal block，禁止摘要或补写推测。

## 3. 其它命令

### list

按 `references/discovery.md` 调用无状态命令：

```bash
<CLI> --json list "<dir>"
```

### validate

```bash
<CLI> --json validate "<spec>"
```

`list/validate` 无状态，不带 `--state-dir`。

### status

```bash
<CLI> --json status --state-dir "<STATE>" [--instance "<INSTANCE>"]
```

### resume

`resume` 只在用户明确要求恢复崩溃实例时使用：

```bash
<CLI> --json resume --state-dir "<STATE>" [--instance "<INSTANCE>"]
```

返回的 NextResponse 回编排循环。普通 agent session 交接不属于崩溃恢复。

## 4. 主体边界

- Main 不执行普通步骤；唯一例外是当前工具面没有 subagent 能力时的 `INLINE_FALLBACK`。
- Main 不把 segment/worker 循环复制回本文件。
- Main 不派生 scheduler agent。
- Main 不替 paused 决策者作答。
- Main 只消费引擎或执行 agent 返回的完整结构化响应。
- Main 和执行 agent 都不猜测空 stdout 后的状态。
- subagent 能力以当次 run/resume 的 spawn 直发结果为准（成功即 delegated；工具缺失/报错/首步心跳判死即 inline），不做预探测，不跨运行缓存。
- 不主动翻 hoplog/state 做研究；错误时只报告必要信息。

