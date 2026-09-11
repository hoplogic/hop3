---
name: hopspec
description: 驱动 HopJIT 引擎执行 HopSpec 规约（复用模式——CC 自身当推理 LLM，hopjit CLI 管理执行状态和流控，零 API key）。跑 spec 的缺省入口；仅当用户明说走 MCP/standalone 时才用 /hopspec-mcp。
user_invocable: true
---

%% @trace
	id: hopspec-driver-skill
	source: [[HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-runtime
	type: intent
	last_sync: 2026-08-31T14:32+0800
	note: 复用模式 CC 驱动指令（源）。本 driver/ 目录是复用模式驱动指令的归属处，Codex 等其他 runtime 载体将来并列于此。部署副本=.claude/skills/hopspec/SKILL.md（开发期软链到本源，改源即生效）。节奏归引擎/caller 介入点契约见 source 的 ^anc-exec-engine-driver-roles / ^anc-exec-mode-invariants。2026-07-04 顶层驱动改造：主 agent 只编排介入点，执行段外包给 driver subagent（隔离主上下文，见 [[reuse-mode-prompt-flow]]）。同日精简：subagent 模板 + 公共执行规则 + spec 发现前置外置 driver/references/（driver-subagent / parallel-worker / step-execution-rules / discovery），主体只留主 agent 编排 + 子命令表（303→181 行；消 list 与 §0 的 recent-dirs 重复）。同日 e2e 实测通过 + 修临时文件散落：driver/worker @file 临时文件改写 scratch_dir（随 .hopstate 隔离/清理），不再落项目根裸名污染 git。再修主 agent 抢跑：主 agent 全程不碰执行链（不自己 run/submit 执行步），run 也交首个 subagent（否则 advance 抢记首步 start → hoplog 重复块）；主 agent 只 §0 前置 + 起 subagent + 处理介入点。2026-07-07 e2e 复跑（ppt-html work_zone 验证）暴露两处并固化：① for-each worker itemVar 通道简化——从"driver 手工从响应提取 params_for_child 拼 --params 透传"改为"引擎 fan-out 按 cid 落盘 + worker init 自动回填"（driver 零参与，parallel-worker.md 去掉 --params，见 design ^anc-exec-parallel-foreach-worker）；② doc-ref 工作目录——doc-ref 按 CLI 进程 cwd 解析且 subagent Bash 命令间重置 cwd，故 worker/driver subagent 每条 node 命令前置 `cd <VAULT> &&` 锁 cwd（唯一允许的链式，driver-subagent/parallel-worker/step-execution-rules 同步）。2026-07-08 fan-out 调度代码化：满额窗口/补位/命令拼装从 skill NL 移进无状态 CLI 顾问（fanout-plan/fanout-next），主 agent 退为句柄执行器（起 subagent+收通知，照 CLI 给的 launch_command 原样执行、零调度计算）。载体决策依实测：专职调度 subagent 因"idle 即完成"跨窗口丢早批通知不可行，只有主 agent 稳定持句柄（design ^anc-exec-parallel-fanout-advisor）。结构性消除忘 --params/漏 cd/串台/重复派发。parallel-worker.md 改写为调顾问+照做。2026-08-27 四改双名双壳（作者定'skill 简单点直接指定,不要 NL LLM 装配'——同日推翻三改单壳）：本壳回归纯复用,MCP 薄协议独立为 /hopspec-mcp（hopspec-skill-mcp.md,不同名并存安装）——名字即模式,零判定零配置零分发;driver_mode 配置与 hopjit driver-mode 命令随之退役;防双执行=引擎 driver_channel 硬闸（与壳形态无关,保留;design codex-driver-carrier ^anc-driver-codex-standalone-dispatch 四改条款 / exec-engine ^anc-exec-driver-channel）
%%

# /hopspec — 驱动 HopJIT 执行 HopSpec 规约

子命令：`run <spec> [--params]` 执行 · `list` 列出可用 spec · `status` 查进度 · `resume` 恢复。

驱动 HopJIT 执行引擎（hopjit CLI）执行一个 HopSpec 规约文件。CC 自身作为推理 LLM，hopjit 管理执行状态、变量存储、retry/adaptive、None 传播等流控。

## 前置条件

- `hopjit` CLI 可用（全局 `npm i -g hopjit` / 项目内 `npm i hopjit` / 开发期 `npm link` 或本地 `npm run build`）
- 本壳为复用模式（CC 自身当推理 LLM），**不需要 API key**。要走 MCP 装配（执行在 hopjit MCP server 进程）用 **`/hopspec-mcp`**——两壳不同名并存，敲哪个就是哪种模式。

> **🔴 启动最前：CLI 定位**。本 skill 用两个变量而非硬编码路径：
> - **`<CLI>`** = hopjit 调用前缀（`hopjit` 或 `node <abs>/cli.js`）
> - **`<PKG>`** = hopjit 包根（放 driver/、examples/ 的目录）
>
> 主 agent 在 `run`/`list` 等任何动作**之前**定位一次：`command -v hopjit` **一条命令，命中固化绝对路径，不中直接报错**（2026-08-09 作者定，原四级探测废除——找不到=没装好，报错装好重试，不翻目录找替代）。细则见 `driver/references/cli-discovery.md`；`<PKG>` 仅引用引擎自带资源时经 `npm root -g` 取。

## 琐碎子命令：list / status / resume

`/hopspec run` 是主体（下方执行流程）。其余三个各自简单：

- `/hopspec list [目录]` — 列出可执行 spec 供挑选。完整流程 + recent-dirs LRU 见 `<PKG>/driver/references/discovery.md`。
- `/hopspec status` — 跑 `<CLI> --json status --state-dir .hopstate [--instance <id>]`，展示进度 JSON。
- `/hopspec resume` — 跑 `<CLI> --json resume --state-dir .hopstate [--instance <id>]`，recover + 推进到下一介入点/终态，回主编排循环（§2）分派。

## 执行流程

### 0. 前置：定位 spec + 组装 params

`run` 前先定位 spec 文件、组装 `--params`——完整流程（spec 搜索、recent-dirs 维护、读 `## Inputs` 推断参数 + AskUserQuestion 确认）见 `<PKG>/driver/references/discovery.md`。这是 run 的**必要前置交互**，不属"自主展开"。

### 0.5 跨通道防线（引擎硬闸,你只认报错）

任何 CLI 命令返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 MCP server 建立/驱动——本壳的 CLI 协议对它不适用，提示用户用 `/hopspec-mcp` 继续那个 run，**不要强行重试**（双执行是最高危事故，硬闸拒绝即防线生效）。

### 1. 启动 + 驱动姿态（主 agent 编排，执行段外包 subagent）

**核心姿态（本 skill 的关键设计）**：`/hopspec run` 下，**主 agent（你）只做编排者，全程不碰执行链**——不自己调 `run`/`submit`（`run` 的 advance 会抢记首步 start → hoplog 重复；执行链全归 subagent）。你只：① 做 §0 前置（定位 spec + 组装 params，含问人）；② **起 driver subagent 跑执行段**；③ 处理 subagent 冒泡回的**介入点**（paused 问人 / parallel fan-out / adaptive replan / 终态）。执行段每步累积 context 是"哑应答体"式机械搬运，放 subagent 独立窗口跑，主上下文只留介入点 + 摘要，不被污染。与 parallel worker 同范式，只是推广到顶层。

**启动**：§0 备好 spec 绝对路径 + params JSON 后，**起首个 driver subagent**（`Agent` 工具，prompt 模板见 `<PKG>/driver/references/driver-subagent.md`，填入 `<CLI>` 绝对路径 + `<STATE>` + `<SPEC>` + `<PARAMS>`）。subagent 自己跑 `run` 作首步（首个 `recordStepStart` 归它，不抢跑），跑到介入点/终态返回 JSON + **instance_id** + 摘要。**你记住它回报的 instance_id**——后续介入点注入用它。

**执行节奏归引擎**：主 agent 与 subagent 都**不主动推进**——只在引擎给的介入点应答。

**⚠️ Bash 命令纪律（硬约束，主 agent 与 subagent 都遵守）**：
- **每条 Bash 调用只做一件事**：不链式（`&&`）、不管道（`|`）、不变量赋值
- **直接写完整命令**：`<CLI> <子命令> <参数>`，不缩写、不 `$HOPJIT`
- **自己读 JSON**：driver 的每条 CLI 命令**必须带全局 `--json`**（CLI 缺省输出 YAML 给人看；机器消费方显式要 JSON）——返回单行 JSON 直接读懂按 `status` 分派，不 `| python3 -c` / `| node -e` 提取
- **理由**：管道到解释器触发 pipe_guard hook 弹框打断；直接命令走 `Bash(node *)` 预授权零弹窗

> 主 agent 自己**只**跑 §2 paused/adaptive 的 `submit_and_fetch_next --answer/--replan`（注入问人结果），**不跑 run、不跑执行步的 submit**。
> **不要 `rm -rf .hopstate`**——run 在 state-dir 下创建带唯一 instance_id 的新实例，旧实例不干扰。需要干净环境时用新的 `--state-dir` 名。

### 2. 主 agent 编排循环（你只处理介入点）

首个 subagent 返回后拿到 JSON（+ instance_id），按 `status` 分派。**编排循环**：处理完一个介入点 → 拿到下一步 JSON → 再分派，直到终态。

#### `step_ready` → **起 driver subagent 跑执行段**（你从不自己 run/submit 执行步）

step_ready 意味着一段**纯执行**（连续 reason/check/act/commit）。**用 `Agent` 工具起一个 driver subagent** 跑它——prompt 模板见 `<PKG>/driver/references/driver-subagent.md`：
- **首个执行段**：起首个 subagent 从 `run` 起（传 `<SPEC>` + `<PARAMS>`），它跑 run + 后续 submit 循环，回报 instance_id。
- **介入点后续接**（paused/adaptive 注入后又是 step_ready）：起**续接 subagent** 继续——传 `<INST>`（你记住的 instance_id）**+ `<PENDING>`（你注入 `--answer`/`--replan` 后拿到的返回 JSON，原样完整、不摘要）**。那个 JSON 是引擎只发一次的在手动作，消费权随交接转移——不传它，续接 subagent 无协议通道取回，只能盲驱。

subagent **一直跑到下一个介入点**（paused / adaptive_needed / tool_request）或**终态**（completed / failed）才停，把那个 JSON + 摘要返回给你 → **回本编排循环继续分派**。

> 主 agent **从不自己 run、也不自己 submit 执行步**——那正是要外包的、且抢跑会污染 hoplog。你只在 subagent 返回介入点后接手。执行细则在 `references/step-execution-rules.md`，subagent 自会引用。

#### `paused` → **必须停下问人，禁止自己替答**（主 agent 专属）

⚠️ **硬约束（违反即错误）**：paused 是 spec 作者**显式声明的介入点**——作者特意放了 confirm/ask，就是要**外部决策者**（人）来定。你**必须**用 `AskUserQuestion` 展示问题、等用户回答，**禁止**自己推理出答案就 submit。（这也是为什么 paused 归主 agent 而非 subagent——subagent 无权、也无法问真人。）

按 `pause_reason` 分派：

**`confirm`（审批闸门）→ 必须问人批不批**：
1. **必须**用 `AskUserQuestion` 展示 `presented_data.question` + `response_options`（approve/reject），等用户选
2. 用户选定后注入（**带 `--instance <id>` 跨进程定位**）：
```bash
<CLI> --json submit_and_fetch_next <step_id> --answer '{"value":"<用户选择>"}' --state-dir .hopstate --instance <instance_id>
```
3. approve→映射 bool true；reject→全局中止。**禁止**自己判断该不该批
4. 注入后拿到下一步 JSON → **回编排循环分派**（若又是 step_ready → 起新 subagent 续）

**`ask`（数据收集）→ 必须问人要值**：
1. **🔴 呈交硬约束（present_inputs）**：若 `presented_data.present_inputs` **非空**（如 `["raw_outline", "draft"]`），你**必须**在调 `AskUserQuestion` **之前**先用普通 text 消息（markdown 段落/引用块/代码块）把 `context` 里这些字段的**原文完整 dump** 给用户——**禁止**只给标签、省略号或摘要后就问。这是 spec 作者显式声明的"必须看完才能答"的呈现契约（见 design ^anc-exec-hitl-presentation），缩略 = 让用户在没看清的状态下拍板,**等于违反 ask 语义**。

   **`context` 字段两种形态**（人通道 ^anc-exec-deflate）：
   - **原值**（小于 5K 字符）：直接是字符串/对象，原样 dump 即可，长内容用 ` ``` ` 围栏避免被 markdown 渲染破坏
   - **`{$file, preview}` 复合**（≥ 5K 字符，引擎自动卸载）：preview = 头 5K 字符 + "...[完整内容见文件]"。你**必须**完整 dump preview 给 user（已经是 user 可读量），**并提示** "完整内容见 `{$file 路径}`"，让 user 知完整在哪。user 想看完整时你 `Read` 文件再展示

   **禁止二次摘要**：preview 已经是引擎按"人友好阈值"卸载的产物，你不应再压缩它。**省略 `present_inputs`** 时按现行行为（可缩略提示）。
2. **必须**用 `AskUserQuestion` 展示 `presented_data.question`，并把 `output_schema`（要填的变量+类型）、`default_value`（前序推断默认值）、`context`（候选来源）一并呈现给用户
3. 选项构造：若有推断默认值，第一项给"采用默认：<default_value>"；再列其它候选（来自 context）；用户可选"Other"自由填
4. 用户给值后注入（用用户提供的**真实值**，不是 approve；带 `--instance`）：
```bash
<CLI> --json submit_and_fetch_next <step_id> --answer '{"value":"<用户提供的真实数据值>"}' --state-dir .hopstate --instance <instance_id>
```
   **值大时（如整份大纲/草稿）**：把 `{"value":"..."}` 整个写到 paused 响应给的 `work_zone` 目录下（如 `<work_zone>/answer_<step_id>.json`），再整包 `--answer @<work_zone>/answer_<step_id>.json`。`@` 只贴 `--answer` 参数最前面，绝不写进 JSON 字段值；只写 work_zone、不写 /tmp。
5. **禁止**把 approve 当数据值——ask 要的是业务值（如"技术规范"），不是审批信号。用户若想采用默认，把 default_value 的真实内容作为 value 注入
6. 注入后拿到下一步 JSON → **回编排循环分派**

> **例外**：`require_human: false`（未强制真人）且问题确实可由上下文无歧义推断时，才允许主 agent 代答——**代答判断/要不要强问，参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引，如"已给且存在直接采用不必强问"；question 是给人的纯问题面，不含这些指引——#34 受众分流）**。但 confirm/ask 默认倾向问人，拿不准就问。`require_human: true` 时**绝对必须**真人回答，零例外。

#### `adaptive_needed` → 重规划（主 agent）
**先看 `reason` 字段分流**：`reason: "initial_plan"` = 这不是失败——是 `[subtask free]` 到步索首计划：读 `expansion_context`（容器输入的**运行时实际值**,null 值项见 `missing_inputs` 清单）+ `subtask_contract` 出计划,**计划必须含 check 步（主干）、禁 commit**（引擎强制,违者拒收）。无 `reason` 字段 = 既有失败驱动语义：读失败上下文（`failure.reason` + `subtask_contract`），生成新步骤 markdown。两种都同样提交（带 `--instance`）：
```bash
<CLI> --json submit_and_fetch_next <subtask_id> --replan '<新步骤 markdown>' --state-dir .hopstate --instance <instance_id>
```
返回值即重规划后的下一步 → **回编排循环分派**（step_ready 则起续接 subagent，把这个返回 JSON 作 `<PENDING>` 原样传入——它只发一次，你不消费就必须随交接转移）。

#### `completed` → YAML 结构化输出全部 outputs，结束

只读取终态响应的 `outputs`，序列化为 YAML 代码块报告：

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不加说明。**禁止摘要、改写、节选或省略任一输出字段**；对象/列表递归转 YAML，多行字符串用 literal block（`|-`），字段值保持原样。（与 Codex 载体同一呈现契约——终态是交付物，完整性优先于简洁。）**YAML 块所在的这条消息就是你的最后一条消息**：人话摘要写在同一条消息里、块的下方；发完即结束，**不要再另发一条『已完成/终态 YAML 如上』之类的收尾消息**（另发=把 YAML 块挤出终位，e2e 实撞 2026-08-17）。

⚠️ **长程流程末尾尤其容易违反本契约**（多介入点走完后顺手用人话总结收尾、忘贴 YAML 块——e2e 实撞：业务全部完成、产物齐落盘，仅因终态消息无 `status: completed` 块被判红）。subagent 终态回报已按模板附排版好的 YAML 块——**原样转发它**，人话摘要只能放在块后，不能替代块。

#### `failed` → YAML 结构化失败信息，结束

```yaml
status: failed
step: <failed_step_id>
reason: <原始 failure_reason>
```

代码块外不加说明；`reason` 多行时用 literal block，禁止摘要或补写推测。

> **手机通知（用户要了才发——引擎挂点,driver 只翻译意图）**：用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ run 命令加 `--notify dingtalk`（渠道入实例账,终态/停点引擎自动推卡片;发不发判断恒归引擎二与门:话语渠道×凭证环境变量,无配置文件环节）。你只翻译意图,不自行拼发送。发送失败引擎留 `[notify]` 行 → 转告用户一句照常干活。

#### `dispatch_ready` / `drain_wait` → 渐进派发编排（主 agent）

统一模型（§U8）：parallel 标注步骤由引擎逐个吐派发信号，主线与在飞 worker 并行推进。**引擎是调度权威**（名额/记账/收割合并全在引擎），你是句柄执行器——起后台 subagent、收完成通知、回报终态，零调度计算。

- **`dispatch_ready`**：起一个**后台 worker subagent**（run_in_background），prompt 只有一件事：原样执行响应里的 `launch_command`（引擎拼好，含 cd/--json/子实例定位，禁改参），跑到终态后报告 `child_instance` + completed/failed。`dispatch_kind: call` 时 `launch_command` 含 `<CALLEE_SPEC_PATH:id>` 占位——按 spec 发现流程解析 callee 路径填入再执行。起完立刻 `<CLI> --json advance --instance <id>` 续推主线，**不等 worker**；
- **worker 完成通知到达**：`<CLI> --json reap_and_fetch_next <child_instance> --status <completed|failed> --instance <id>`——引擎收割（输出自取，你不搬运数据）并返回下一介入点，回本编排循环分派。**reap 只用于引擎 dispatch_ready 派发过的 child**——无 parallel 标注的 call 子实例（init --parent 手工建的）用 `submit_and_fetch_next <call步骤号> --child-instance <子实例>` 收割,误用 reap 会被响亮拒。**只在收到真实 worker 通知后 reap**——没起过 worker 的 child 不许凭空报 completed（引擎按子实例缺失判败,谎报=给自己造假账）；
- **`drain_wait`**：主线走完在等在飞收割——**不轮询**，等下一个 worker 通知走 reap_and_fetch_next 即可。**响应带 `stale` 清单时逐项自查**（引擎对账发现"派发已入账但子实例长期未建/未终态"，它判不了你起没起、交你处置）：这个 child 你**没起过** worker → 现在起（响应的 `stale_launch[child]` 就是引擎重拼好的启动命令,原样执行禁改参——同 dispatch_ready 纪律）；**起过还在跑** → 继续等它的通知；**起过但确认已死**（后台 task 已失败/被杀）→ `reap_and_fetch_next <child_instance> --status failed` 显式报败收割。不许对 stale 项不闻不问——那是 run 挂起的唯一途径；
- **`failed` 响应带 `kill_list`**：主线失败，清单里的在飞已被引擎记 killed（账面终态）——尽力停掉对应后台 subagent；停不掉不影响正确性（引擎对 killed 的迟到结果直接丢弃）；
- 通知建议逐个串行处理（收一个 reap 一个）；重复 reap 幂等（引擎防重）。

### 3. 异常处理

> 执行段异常主要由 driver subagent 就地处理（模板已含 SCHEMA_MISMATCH 重试、步骤失败 `--failure`，细则见 `references/step-execution-rules.md`）。主 agent 侧共通规则：

- hopjit 命令返回非零 exit code → 读 stderr，报告错误。
- `submit_and_fetch_next` 返回 `SCHEMA_MISMATCH` → 输出不符 schema，修正后重 submit 同一步（引擎未推进）。
- 全部 retry 耗尽 → 引擎自动传播 fail，submit 最终返回 `failed`（subagent 冒泡回主 agent 报告）。

> **调试用** `<CLI> --json debug_step`（推进一步、不消化、不自动推进）——仅人工逐步排查时用，正常驱动只用 run + submit_and_fetch_next。

## 探测与定位的展示纪律

§0 的 CLI 定位与 spec 定位是内务：**静默完成、一行结论**（"定位到 spec：<路径>（引擎 <版本>）"），中间命令不解说、不逐步汇报。细则见 references/cli-discovery.md。

## 进度展示

执行段在 driver subagent 内，主 agent 不再逐步显示每步——**主 agent 在介入点粒度报进度**：subagent 返回时把它带回的执行摘要转述一行，再报当前状态。

**🔴 对用户的措辞说人话（零行话）**：介入点/终态/subagent/segment/envelope 是**协议词汇**——本文档内部和 agent 之间随便用，**不进用户可见消息**。对用户说的是它们的人话对应：启动后不说"等待介入点或终态结果"，说"任务执行中，完成或需要你确认时我会回来"；paused 说"有一处需要你确认/填写"；completed/failed 说"已完成/执行失败"。模板：
```
▸ 已完成 N 步：<摘要一行>。<接下来：任务继续执行中 / 有一处需要你确认 / 全部完成 / 执行失败>
```
subagent 内部**自己**可按需简报每步（`✓ Step {step_id} [{step_type}] {summary}`），但那些留在 subagent 窗口、不进主对话——这正是隔离主上下文的目的。

## 输出纪律（硬约束）

`/hopspec run` 的职责是**驱动执行 + 报告结果**，不是借机做研究。输出严格限于：
1. 每步一行进度（如上 `✓ Step ...`，被引擎消化的步骤无需逐行报）
2. 终态结果：`执行完成。输出：\n  {outputs}` 或 `执行失败。步骤 X：{reason}`

**禁止**：未经要求就翻 hoplog/state.json、做多次运行对比、写根因分析表格、长篇解释引擎内部行为。
- 引擎"一次返回 completed"是**正常优化**（纯计算 body 被引擎消化，节奏归引擎，见 `^anc-exec-advance-to-caller`），**不是异常**，不要为此展开调查。
- **例外（允许且应做）**：第 0 节的 spec 定位与参数组装确认是**必要前置交互**，不属"自主展开"——run 之前该搜 spec、读 Inputs、组装参数并经 AskUserQuestion 确认。纪律约束的是**执行过程与执行后**的多余分析，不是启动前的准备。
- 确有疑点（如 status 非预期、报错），**一句话指出**即可，需要深查先问用户，不自主展开。

## 约束

- `.hopstate/` 目录存放执行状态，应加入 `.gitignore`
- 不要修改 spec 文件本身——执行过程只读 spec，状态全在 .hopstate
- reason/check 步骤：CC 直接推理，不再额外调 LLM API（避免双重收费）
- act/commit 步骤：有 hop_python body 则**严格按 body 执行、不自由发挥**（执行期无推理）；无 body 才按自然语言描述用工具执行。操作范围受 spec 中 SandboxConfig 约束

## 示例

```bash
# 执行一个数据质量评估 spec
/hopspec run <PKG>/examples/data-quality.md

# 带参数执行
/hopspec run my-spec.md --params '{"input_data": "data.csv", "threshold": 0.8}'

# 查看进度
/hopspec status

# 从中断恢复
/hopspec resume
```

