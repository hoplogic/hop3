---
name: hopspec-mcp
description: Drive HopSpec specs via the hopjit MCP server (standalone mode — execution runs in the server process with its own LLM API; this shell only handles start, human-in-the-loop stops, and final output). Use only when the user explicitly asks for MCP/standalone; the default entry for running specs is the hopspec skill (reuse mode, zero API key).
---

%% @trace
	id: hopspec-opencode-driver-mcp
	source: [[opencode-driver-carrier]]
	source_id: hopjit-opencode-driver-carrier
	type: extract
	last_sync: 2026-09-19T15:40+0800
	note: opencode MCP 装配薄壳——派生自 driver/hopspec-skill-mcp.md（CC 源）,原语映射:AskUserQuestion→question 工具/后台看护 subagent→opencode subagent 或主对话适度轮询（opencode 无后台任务完成通知机制,轮询间隔放宽）。五 MCP 工具协议与 HITL 纪律与 CC 版逐条同构。
%%

# hopspec-mcp — 驱动 HopJIT 执行 HopSpec 规约（MCP 装配，opencode 载体）

本壳为 **MCP 装配**：执行全在 hopjit MCP server 进程内（server 自己调 LLM 推理），你只负责把用户意图翻译成五个 MCP 工具调用（`hopjit_start_run` / `hopjit_run_status` / `hopjit_resume_run` / `hopjit_list_runs` / `hopjit_stop_run`——opencode 的 MCP 工具名形态是 `<server>_<tool>`），并在需要真人决策时问人。

> **注册缺失**：若 hopjit 的 MCP 工具不可用，说明 MCP server 未注册——提示用户跑 `hopjit install-skill --mcp --carrier opencode`（配置自举+注册一次完成）或检查 `~/.config/opencode/opencode.jsonc` 的 `mcp.hopjit` 条目，**不要**改用 hopjit CLI 驱动（那是 hopspec 复用壳的协议——用户点名的是本壳，静默换协议=绕过用户的模式指定）。
>
> **跨通道防线**：`resume_run`/`stop_run` 返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 CLI（复用模式）建立——提示用户用 hopspec skill 继续那个 run，不要强行重试（双执行是最高危事故，引擎硬闸拒绝即防线生效）。

## 0. 前置：定位 spec + 组装 params

`run` 前先定位 spec 文件、组装参数——完整流程（spec 搜索、recent-dirs 维护、读 `## Inputs` 推断参数 + 用 question 工具确认）见 `references/discovery.md`（本 skill 目录内）。这是必要前置交互，与执行形态无关。

## 1. 执行四步（薄协议）

1. **启动**：`start_run(spec_path, params, state_dir=<cwd>/.hopstate)` → 记 `run_id`。返回错误（TOOLS_UNAVAILABLE/配置缺失等）→ **如实报错停止**（server 未建 run、零状态写入）；
2. **等待**：执行是分钟级。有 subagent 能力时派一个看护 subagent 轮询（每 60 秒左右调一次 `run_status`，到 paused 或终态即带回完整 JSON；只报告不替答；只用 run_status/sleep，不碰 .hopstate/.hoplog；设轮询上限约 40 次）；没有就主对话适度轮询（间隔不短于 60 秒，期间明告用户"任务执行中"）。收到 paused → §2 问人后 `resume_run` 注入，继续等；终态 → §3 呈现；
3. **终态**：`completed`/`failed` → 按下方呈现契约输出 YAML 终态块；用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ `start_run` 的 params 里带 `hop_notify: true`（终态/停点 server 自动推卡片;发不发判断归引擎——开关×config notify 通道×凭证）,你只翻译意图不自行拼发送；
4. **锁定纪律**：server 侧已有 run 即已有状态写入——本 run 全程只经五工具与 server 交互，**禁止**对同一 run 另起 hopjit CLI 驱动或重跑。

## 2. HITL：paused 必须问真人，禁止替答

paused 是 spec 作者显式声明的介入点。按 `pause_reason` 分派：

- **confirm（审批）**：用 question 工具展示 `presented_data.question` + `response_options`，等用户选，`resume_run` 注入所选值。**禁止**自己判断该不该批；
- **ask（数据收集）**：
  - 🔴 **呈交硬约束（present_inputs）**：`presented_data.present_inputs` 非空时，先用普通文本消息把 `context` 里这些字段**原文完整 dump**（长内容用围栏；`{$file, preview}` 复合形态完整给 preview 并注明完整文件路径），**禁止**只给标签或摘要后就问——缩略=让用户没看清就拍板；
  - 再用 question 工具展示问题 + `output_schema` + `default_value` + 候选；用户给的**业务值**经 `resume_run` 注入（不是 approve 信号）；
- 例外：仅 `require_human: false`（未强制真人）且问题确实可由上下文无歧义推断时才允许代答——判断参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引；question 是给人的纯问题面不含指引）。默认倾向问人，拿不准就问；
- `require_human: true` 时**绝对必须**真人回答，零例外。

## 3. 终态呈现契约

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不加说明。**禁止摘要、改写、节选或省略任一输出字段**；多行字符串用 literal block（`|-`）。failed 同形（`status: failed` + `step` + `reason` 原文）。人话摘要只能放在**同一条消息内**块的下方，不能替代块；**YAML 块所在消息就是最后一条消息，发完即结束，不要再另发收尾消息**。

## 琐碎子命令

- **list [目录]** — 按 `references/discovery.md` 列出可执行 spec；
- **status** — `list_runs` + 对目标 run `run_status`，展示进度；
- **resume** — `list_runs` 找 paused 的 run → 按 §2 问人 → `resume_run` 注入;
- 用户要停掉某个 run — `stop_run(run_id)`（协作式中止,终局不可 resume;已终态幂等）。

## 对用户的措辞（零行话）

启动后说"任务执行中，完成或需要你确认时我会回来"；paused 说"有一处需要你确认/填写"；终态说"已完成/执行失败"。协议词汇（run_id/轮询/介入点）不进用户可见消息。

## 输出纪律

职责=驱动执行+报告结果，不借机做研究。禁止未经要求翻 .hopstate/hoplog、做运行对比、写根因分析。确有疑点一句话指出，深查先问用户。
