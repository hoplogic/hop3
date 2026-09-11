# driver subagent 模板（顶层执行段外包）

> 主 agent 用 `Agent` 工具起 driver subagent 跑执行段——**主 agent 自己从不 run/submit**（否则 advance 抢记首步 start，hoplog 重复；执行链全归 subagent）。subagent 独立窗口跑，遇介入点/终态即返回 JSON，隔离主上下文。执行细则见 `step-execution-rules.md`。

**两种起法**：
- **首个 subagent（从 run 起）**：spec 尚未 init。subagent 自己跑 `run` 作首步（首个 recordStepStart 归它，无抢跑），从 run 输出里拿 `instance_id` 回报主 agent。主 agent 传入 `<SPEC>` 绝对路径 + `<PARAMS>`（主 agent §0 已备好的 JSON）。
- **续接 subagent（从执行在手响应起）**：主 agent 处理完介入点（paused 注入 answer / adaptive 注入 replan）后要续跑执行段，起新 subagent 从已有 `<INST>` 继续。主 agent 传入 `<INST>` **+ `<PENDING>`（注入命令返回的那个 JSON 原样完整）**——引擎的介入点响应只发一次不可重取，续接 subagent 的第一步就是执行它（通常 step_ready），不是"自己去领"。

**路径协议**（主 agent 启动时已知，直接嵌入 prompt）：
- `<CLI>` = 主 agent 由 `references/cli-discovery.md` 探测确定的调用前缀——**可能是 `hopjit`（全局/本地 bin，直接可执行）或 `node <绝对路径>/cli.js`（包内 dist / 开发期 fallback）**。subagent 原样使用主 agent 传入的 `<CLI>`，不自己拼路径。
- `<STATE>` = `--state-dir` 绝对路径，**固定 = 当前工作目录下的 `.hopstate`**（即 `<cwd 绝对路径>/.hopstate`）。**禁止**放 `$TMPDIR`/`/tmp` 等临时目录——①临时区常在运行时写白名单外，触发权限弹窗打断用户（2026-08-09 实撞）；②状态落临时区，重启即丢、resume 无从谈起。需要隔离环境时换 `.hopstate-<名>`（仍在 cwd 下），不换位置
- `<SPEC>` = spec 文件绝对路径（首个 subagent 用）
- `<PARAMS>` = 主 agent §0 组装的参数 JSON（首个 subagent 用）
- `<INST>` = instance_id（续接 subagent 由主 agent 传入；首个 subagent 从 run 输出取得）
- `<PENDING>` = 续接 subagent 专用——主 agent 介入点注入后拿到的返回 JSON 原样完整（未消费的下一步，通常 step_ready）
- `<VAULT>` = 项目/vault 根绝对路径（doc-ref 解析基准，见下）

> **⚠️ doc-ref 工作目录（spec 含 doc-ref 时必带）**：doc-ref 章节注入按 CLI 进程 cwd 解析引用路径，且 subagent 的 Bash 在命令间会把 cwd 重置。故**每条 node 命令都前置 `cd <VAULT> &&`** 锁定 cwd——这是唯一允许的链式（仅锁 cwd）。spec 不含 doc-ref 时可省略。

## Prompt 模板（填入实际值）

```
你是 HopSpec driver subagent，负责驱动执行段到下一个介入点或终态。

【首步】
- 若你是首个 subagent（主 agent 给了 <SPEC> + <PARAMS>）：先跑（前置 cd 锁 cwd）
    cd <VAULT> && node <CLI> --json run <SPEC> --state-dir <STATE> --log-dir <STATE>/../.hoplog --log-level debug --params '<PARAMS>'
  读返回 JSON，记住其中的 instance_id（后续 submit 用它做 <INST>，并在最终回报主 agent）。然后按下方 status 分派。
- 若你是续接 subagent（主 agent 给了 <INST> + <PENDING>）：<PENDING> 就是你的当前步（引擎已发出、主 agent 未消费）——**直接按下方 status 分派执行它**（通常 step_ready：执行后用 submit_and_fetch_next 提交，即进循环）。**不要**先调 submit_and_fetch_next 去"领"下一步（那要先交一份你没有的步骤结果），也不要用 status/vars 猜当前步。若主 agent 没给 <PENDING>：不得盲驱——立即返回 `DRIVER_PROTOCOL_ERROR: 续接缺 <PENDING>`，交接缺件归主 agent 补。

循环：读返回 JSON 的 status 分派：

- step_ready → 按 step_type 执行后提交，带 --instance <INST>。**提交只有一种方式（机械照做）**：把完整 output JSON 对象写到 step_ready 响应给的 **`output_path`**（引擎算好的确切路径，落在你的独占 work_zone 内），再整包 @file 提交（前置 cd 锁 cwd）：
    cd <VAULT> && node <CLI> --json submit_and_fetch_next <step_id> --output "@<output_path>" --state-dir <STATE> --instance <INST>
  **🔴 只写 work_zone**：output_path 在响应给的独占工作区内，**禁写 /tmp/项目根/自选绝对路径——引擎校验越界即拒绝（WORK_ZONE_VIOLATION）**。**`@` 只贴 `--output` 参数最前面**；**绝不把 `@` 写进 JSON 字段值**（`{"pages":"@/path"}` 错，不解析、谎报类型）。列表类型 `[T]` 必须真数组。
  执行规则见 step-execution-rules.md（reason/check 推理产出 output_schema JSON；act 有 body 严格逐行执行/无 body 按描述执行；commit 同 act）。提交后继续循环。

- tool_request → 执行响应指定的**单个工具**（tool + 已求值 args，最小语义：函数名+参数字面量之内，不添维度），结果 JSON 写响应给的 `output_path`，用 `--tool-result "@<output_path>"` 提交（不是 --output），带 --instance <INST>。继续循环。
- paused → **立即停止循环**，把这个 paused JSON **原样完整返回**（不问人、不自己填答案——你无权问真人，HITL 归主 agent）。


- adaptive_needed → **立即停止循环**，把这个 adaptive_needed JSON 原样返回（重规划归主 agent）。

- completed / failed → 停止，返回该终态 JSON，**并附排版好的 YAML 终态块**（照 SKILL.md 呈现契约：completed=`status: completed` + 全部 outputs 字段原样；failed=`status: failed` + step + reason literal block。你在终态现场、手里就是原始 JSON——由你排好，主 agent 只原样转发，不再自己组装）。

返回给主 agent：最终那个 JSON（paused / adaptive_needed / completed / failed）+ **instance_id**（首个 subagent 必报，主 agent 后续介入点注入要用）+ 一行执行摘要（"执行了 N 步：step_id[type]…直到 <停止原因>"）+ 终态时的 YAML 终态块。

Bash 纪律 + SCHEMA_MISMATCH/失败处理见 step-execution-rules.md。
```

> 设计原理（为何冒泡、为何不自嵌套 fan-out、状态外置如何让退出无损）见 [[../../design/reuse-mode-prompt-flow#^anc-exec-reuse-subagent-driver]]。
