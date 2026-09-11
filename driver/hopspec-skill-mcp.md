---
name: hopspec-mcp
description: 驱动 HopJIT 引擎执行 HopSpec 规约（MCP 装配——执行在 hopjit MCP server 进程内，server 自己调 LLM API，本壳只做启动、介入与结果呈现）。仅当用户明说走 MCP/standalone 时使用；跑 spec 的缺省入口是 /hopspec（复用模式，零 API key）。
user_invocable: true
---

%% @trace
	id: hopspec-driver-skill-mcp
	source: [[HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-runtime
	type: intent
	last_sync: 2026-08-31T09:51+0800
	note: MCP 装配薄壳（CC 载体）。2026-08-27 四改双名双壳（作者定'skill 简单点直接指定'）：与复用壳 /hopspec 不同名并存安装——名字即模式,用户敲 /hopspec-mcp 即选定 MCP 装配,零判定零配置零 NL 分发（8-16 同名互斥与 8-27 上午的单壳双协议段两代形态均退役,演进史 design codex-driver-carrier ^anc-driver-codex-standalone-dispatch 四改条款）。执行全在 hopjit MCP server 进程（Dispatcher 自调 LLM）,本壳=人意图→五 MCP 工具调用的翻译层:spec 定位/参数组装/薄协议/HITL 呈交/终态呈现。防双执行=引擎 driver_channel 硬闸（exec-engine ^anc-exec-driver-channel）。
%%

# /hopspec-mcp — 驱动 HopJIT 执行 HopSpec 规约（MCP 装配）

子命令：`run <spec> [--params]` 执行 · `list` 列出可用 spec · `status` 查进度 · `resume` 恢复。

本壳为 **MCP 装配**：执行全在 hopjit MCP server 进程内（server 自己调 LLM 推理），你只负责把用户意图翻译成五个 MCP 工具调用（`mcp__hopjit__start_run` / `run_status` / `resume_run` / `list_runs` / `stop_run`），并在需要真人决策时问人。

> **注册缺失**：若 `mcp__hopjit__*` 工具调用被运行时拒绝（无法解析），说明 MCP server 未注册——提示用户跑 `hopjit install-skill --mcp`（配置自举+注册一次完成）或检查 `.mcp.json`，**不要**改用 hopjit CLI 驱动（那是 `/hopspec` 复用壳的协议——用户敲的是本壳，静默换协议=绕过用户的模式指定）。
>
> **跨通道防线**：`resume_run`/`stop_run` 返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 CLI（复用模式）建立——提示用户用 `/hopspec` 继续那个 run，不要强行重试（双执行是最高危事故，引擎硬闸拒绝即防线生效）。

## 0. 前置：定位 spec + 组装 params

`run` 前先定位 spec 文件、组装参数——完整流程（spec 搜索、recent-dirs 维护、读 `## Inputs` 推断参数 + AskUserQuestion 确认）见 `references/discovery.md`（本 skill 目录内）。这是必要前置交互，与执行形态无关。

## 1. 执行四步（薄协议）

1. **启动**：`start_run(spec_path, params, state_dir=<cwd>/.hopstate)` → 记 `run_id`。返回错误（TOOLS_UNAVAILABLE/配置缺失等）→ **如实报错停止**（server 未建 run、零状态写入）；
2. **等待经看护 subagent，主对话不轮询**（标准范式，作者定 2026-08-22——`run_status` 是拉模式无推送，主 agent 用 sleep 扛等待=把整个会话锁死，用户插不上话）：起一个**后台看护 subagent**（`Agent` 工具 `run_in_background: true`），把 run_id 交给它——它在自己的窗口里每 60 秒左右调一次 `run_status`（间隔用 `sleep` 等，它挂着不影响任何人），到 **paused 或终态即停止轮询并把完整 JSON 带回**（subagent 完成自动通知主 agent）。**进度行格式**：running 响应带 `call_chain` 时逐层展开写进进度文件（如 `5.1→split-node/2.1.1→split-structure/3.3`——递归子树烧到哪层哪步一眼可见），带 `cumulative_tokens` 时同行附上；两字段都缺席才写裸 `running`。看护纪律：**只报告不替答**——任何 paused 都原样带回主 agent 走 §2 问人（唯一例外：主 agent 派活时明确指定的自动应答点，如测试 fixture 的固定注入）；只用 `run_status`/`resume_run`/`sleep` 三样，不碰 `.hopstate`/`.hoplog`；设轮询上限（约 40 次）超时报最后状态。收到通知后主 agent 接手：paused → §2 问人后 `resume_run` 注入，**再起新看护 subagent 继续等**；终态 → §3 呈现；
3. **终态**：`completed`/`failed` → 按下方呈现契约输出 YAML 终态块；用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ `start_run` 的 params 里带 `hop_notify: true`（终态/停点 server 自动推卡片;发不发判断归引擎三与门——开关×config notify 通道×凭证）,你只翻译意图不自行拼发送;
4. **锁定纪律**：server 侧已有 run 即已有状态写入——本 run 全程只经五工具与 server 交互，**禁止**对同一 run 另起 hopjit CLI 驱动或 subagent 重跑（引擎 DRIVER_CHANNEL_MISMATCH 硬闸会拒，但不要走到那一步）。看护 subagent 只读状态与代注指定应答点，不属重跑。

## 2. HITL：paused 必须问真人，禁止替答

paused 是 spec 作者显式声明的介入点。按 `pause_reason` 分派：

- **confirm（审批）**：用 AskUserQuestion 展示 `presented_data.question` + `response_options`，等用户选，`resume_run` 注入所选值。**禁止**自己判断该不该批；
- **ask（数据收集）**：
  - 🔴 **呈交硬约束（present_inputs）**：`presented_data.present_inputs` 非空时，先用普通 text 消息把 `context` 里这些字段**原文完整 dump**（长内容用围栏；`{$file, preview}` 复合形态完整给 preview 并注明完整文件路径），**禁止**只给标签或摘要后就问——缩略=让用户没看清就拍板；
  - 再用 AskUserQuestion 展示问题 + `output_schema` + `default_value` + 候选；用户给的**业务值**经 `resume_run` 注入（不是 approve 信号）；
- 例外：仅 `require_human: false`（未强制真人）且问题确实可由上下文无歧义推断时才允许代答——判断参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引；question 是给人的纯问题面不含指引——#34 受众分流）。默认倾向问人，拿不准就问；
- `require_human: true` 时**绝对必须**真人回答，零例外。

## 3. 终态呈现契约

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不加说明。**禁止摘要、改写、节选或省略任一输出字段**；多行字符串用 literal block（`|-`）。failed 同形（`status: failed` + `step` + `reason` 原文）。人话摘要只能放在**同一条消息内**块的下方，不能替代块；**YAML 块所在消息就是最后一条消息，发完即结束，不要再另发收尾消息**。

## 琐碎子命令

- `/hopspec-mcp list [目录]` — 按 `references/discovery.md` 列出可执行 spec；
- `/hopspec-mcp status` — `list_runs` + 对目标 run `run_status`，展示进度；
- `/hopspec-mcp resume` — `list_runs` 找 paused 的 run → 按 §2 问人 → `resume_run` 注入;
- 用户要停掉某个 run — `stop_run(run_id)`（协作式中止,终局不可 resume;已终态幂等）。

## 对用户的措辞（零行话）

启动后说"任务执行中，完成或需要你确认时我会回来"；paused 说"有一处需要你确认/填写"；终态说"已完成/执行失败"。协议词汇（run_id/轮询/介入点）不进用户可见消息。

## 输出纪律

职责=驱动执行+报告结果，不借机做研究。禁止未经要求翻 .hopstate/hoplog、做运行对比、写根因分析。确有疑点一句话指出，深查先问用户。
