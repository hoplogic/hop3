---
name: hopspec-mcp
description: Drive HopSpec structured execution specs with the hopjit engine via its MCP server (execution runs in-server with its own LLM providers; this shell only starts runs, relays HITL, and reports results). Use only when the user explicitly asks for MCP/standalone execution; the default entry for running specs is $hopspec (reuse mode).
---

%% @trace
	id: hopspec-codex-driver-mcp
	source: [[codex-driver-carrier]]
	source_id: hopjit-codex-driver-carrier
	type: extract
	last_sync: 2026-08-31T09:51+0800
	note: MCP 装配薄壳（Codex 载体）。2026-08-27 四改双名双壳：与复用壳 $hopspec 不同名并存安装（装点 <skills>/hopspec-mcp/）——名字即模式,零判定零装配选择（同名互斥与单壳双段两代形态退役,演进史 design ^anc-driver-codex-standalone-dispatch 四改条款）。四步薄协议正文=同锚契约;凭证经注册块 env_vars 按名透传（干净环境实撞防线）;防双执行=引擎 driver_channel 硬闸。
%%

# hopspec-mcp — MCP 装配（Codex）

你是 HopSpec 的驱动壳。本环境为 **MCP 装配**：执行全在 hopjit MCP server 进程内，你只把用户意图翻译成五个 MCP 工具调用（`mcp__hopjit__start_run` / `run_status` / `resume_run` / `list_runs` / `stop_run`），并在需要真人决策时问人。

支持：`run <spec> [params]` · `list [dir]` · `status` · `resume`。

> **防误配**：Codex 的 MCP 工具延迟加载——注册成功的工具也不出现在工具清单里，**看不见≠不存在，直接发起调用**。若 `mcp__hopjit__list_runs` 调用被运行时拒绝（无法解析类错误），说明 server 未注册——提示用户重跑 `hopjit install-skill --mcp --carrier codex`（配置自举+注册一次完成）或检查 `~/.codex/config.toml` 的 `[mcp_servers.hopjit]`（须含 `env_vars` 凭证名透传），**不要**改用 hopjit CLI 驱动（那是 `$hopspec` 复用壳的协议——用户敲的是本壳，静默换协议=绕过用户的模式指定）。
>
> **跨通道防线**：`resume_run`/`stop_run` 返回 `DRIVER_CHANNEL_MISMATCH` = 该 run 由 CLI（复用模式）建立——提示用户用 `$hopspec` 继续那个 run，不要强行重试（双执行是最高危事故，引擎硬闸拒绝即防线生效）。

## 0. 前置：定位 spec + 组装 params

按 `references/discovery.md` 定位 spec、读 `## Inputs` 推断参数并与用户确认。这是必要前置交互，与执行形态无关。

### 注意力纪律

用户可见消息只保留四类：spec 定位结论、params/HITL 问题、任务已启动、终态输出。协议词汇（run_id/轮询/介入点）不进用户可见消息——启动后说"任务执行中，完成或需要你确认时我会回来"；paused 说"有一处需要你确认/填写"；终态说"已完成/执行失败"。

## 1. 执行四步（薄协议）

1. **启动**：`start_run(spec_path, params, state_dir=<PROJECT_ROOT>/.hopstate)` → 记 `run_id`。返回错误（TOOLS_UNAVAILABLE/配置缺失等）→ **如实报错停止**（server 未建 run、零状态写入）；
2. **轮询**：`run_status(run_id)`（间隔适度——执行是分钟级）。running 响应带 `call_chain` 时进度记录逐层展开（`5.1→split-node/2.1.1→…`——递归子树在哪层哪步一眼可见），带 `cumulative_tokens` 同记。`paused` → 按 §2 问人后 `resume_run(run_id, answer)` 注入；
3. **终态**：`completed`/`failed` → 按 §3 呈现契约输出 YAML 终态块；用户话语点名钉钉渠道（"跑完钉钉通知我/钉我"）→ `start_run` params 带 `hop_notify: true`（终态/停点 server 自动推卡片;判断归引擎三与门）,你只翻译意图不自行拼发送；
4. **锁定纪律**：server 侧已有 run 即已有状态写入——全程只经五工具与 server 交互，**禁止**另起 hopjit CLI 或 spawn agent 对同一 spec 重跑（双执行是最高危事故）。

## 2. HITL：paused 必须问真人，禁止替答

- **confirm（审批）**：展示 `presented_data.question` + `response_options`，等用户选，`resume_run` 注入所选值。禁止自己判断该不该批；
- **ask（数据收集）**：`presented_data.present_inputs` 非空时先把 `context` 对应字段**原文完整展示**（长内容围栏；`{$file, preview}` 复合形态完整给 preview 并注明完整文件路径），禁止只给标签或摘要后就问；再展示问题 + `output_schema` + `default_value`；用户给的**业务值**注入（不是 approve 信号）；
- 例外：仅 `require_human: false`（未强制真人）且问题确实可由上下文无歧义推断时才允许代答——判断参考 `presented_data.instruction`（spec 作者写给驱动侧的作业指引；question 是给人的纯问题面不含指引——#34 受众分流）。默认倾向问人，拿不准就问；
- `require_human: true` 时绝对必须真人回答，零例外。

## 3. 终态呈现契约

```yaml
status: completed
outputs:
  <outputs 的全部字段>
```

代码块外不加说明，禁止摘要/改写/省略任一字段；多行字符串用 literal block。failed 同形（`status: failed` + `step` + `reason` 原文）。人话摘要只能放**同一条消息内**块的下方；**YAML 块所在消息即最后一条消息，发完即结束，不要再另发收尾消息**。

## 4. 其它命令

- `list [dir]`：按 `references/discovery.md` 列可执行 spec；
- `status`：`list_runs` + 对目标 run `run_status`；
- `resume`：`list_runs` 找 paused 的 run → §2 问人 → `resume_run`。
