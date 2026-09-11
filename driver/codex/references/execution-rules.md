%% @trace
	id: hopspec-codex-execution-rules
	source: [[codex-driver-carrier]], [[exec-engine]], [[hop-cli]]
	source_id: hopjit-codex-driver-carrier, hopjit-exec-engine, hopjit-hop-cli
	type: extract
	last_sync: 2026-09-06T16:56+0800
	note: Codex segment driver 与 parallel worker 共用的 step_ready 执行与提交规则。
%%

# Codex Step Execution Rules

`<CLI>` 是完整调用前缀，可能是 `hopjit`、绝对 bin，或 `node "<abs>/cli.js"`。一律写：

```text
<CLI> <command> ...
```

不得再额外前置 `node`。

## step_ready

读取：

- `step_id`
- `step_type`
- `context.inputs`
- `context.instruction`
- `context.fail_context`（可选——仅失败兜底块内的步骤才有:所在容器的"此前失败情况"段,写通知/诊断类产出时如实引用它）
- `output_schema`
- `output_path`

### reason

依据完整 context 推理，输出符合 `output_schema` 的 JSON。信息确实不足时不编造——提交 `--output '{"lack_of_info": "说明缺少什么"}'` 代替正常产出，引擎把该步如实记为缺信息失败（仅 reason 有此出口；act 缺信息该失败就失败，check 判不了走如实 false）。

**工具故障出口**（^anc-exec-tool-failure-report）：推理中你用了自己的工具（检索/读文件）而工具实际失败时，**先自己想办法**——换参数重试、换语义等价的工具、走别的路径拿到等效结果，都合法（自救只花你本步的功夫；报故障是整段重跑，烧任务的重试预算）。确认换不动、没有它就无法完成推理时，提交 `--output '{"tool_failure": "哪件工具怎么失败、试过什么自救、对本步产出什么影响"}'`，不要拿编造内容凑产出。两个出口语义不同不互替：缺信息（材料本来就没有）走 lack_of_info，工具故障（取材料的手段坏了）走 tool_failure——引擎处置不同（前者可能补充知识，后者按故障重试）。

### check

输出 schema 声明的 bool 判定槽与 text 说明槽。失败时说明缺口；只如实判定，不自行决定 retry/adaptive。

### act

- 含 `hop_python` body 的 act **由引擎解释执行，不整步交给你**（2026-08-04 起）。文件工具等引擎自有工具由引擎直执不外发（2026-09-05 执行主体原则）;你只应答**引擎执行不了的工具**（caller 会话专属:MCP/宿主能力）的 `tool_request`：执行响应指定的**单个工具**（tool+已求值 args），结果经 `--tool-result "@<output_path>"` 交回；引擎重放续跑。
- **工具实现最小语义**：只做"函数名+参数字面量含义"之内的事——不添维度、不加派生字段、不换算法通道。
- 无 body：按自然语言描述执行整步，`--output` 提交。**L4 工具清单是本步能力面的权威**（0054）:基础文件操作用自身工具落实;清单带"引擎实现是唯一语义源"指引的引擎内建工具（spec 树编辑/校验族）照抄清单给的 `hopjit tool-call` 命令调用（不用 shell 模仿语义）;**其余具名授权工具（web_search/browser/pdf 这类非内建件）优先用你自己环境里语义等价的原生能力落实**——检索用你自带的网页搜索、抓取用你自带的网页访问工具,同名 MCP 件已注册进你环境的直接调用;确实没有语义等价能力时才按清单兜底指引经 `hopjit tool-call` 调用（要求引擎侧已注册该件）;清单外的特殊工具本步不可用,缺工具按失败如实上报。**工具故障先自救,换不动才报、不许硬凑产出**（^anc-exec-tool-failure-report）:本步依赖的工具调用失败时**先自己想办法**——换参数重试、换语义等价的工具或原生能力、走别的路径,都合法（自救只花本步功夫;报故障是整段重跑烧任务重试预算）。确认换不动且没有它就无法完成本步时,不要拿部分成果或编造内容凑一份"看起来完整"的产出——`--output '{"tool_failure": "哪件工具怎么失败、试过什么自救、对本步产出什么影响"}'` 提交,或直接 `--failure "<原因>"` 上报,两条路等价。注意"故障≠没结果":检索类工具报错和"检索成功但确实搜不到"是两回事——前者走本条,后者如实交空结果。

### tool_request

读 `tool` / `args` / `tool_call_seq` / `output_path`。执行该工具，结果 JSON 写 output_path，提交。

🔴 **args 值撞 `{"$file": "<路径>"}` 单键指针＝值已卸载**（参数序列化后超 4096 字符的引擎写进 work_zone/vars/ 下文件,响应里只给指针——阈值是 JSON.stringify 长度〔引擎常量 DEFLATE_THRESHOLD〕,是字符数不是字节数〔中文场景字节约为字符 3 倍,别按字节估卸载时机〕;2026-09-04 起生效）：执行工具前先读该文件、JSON 解析取真值再用,**指针对象本身不是参数值**,当字面值用（如把 `{"$file":...}` 字符串写进产物）就是把地址当货物。与 step_ready inputs 的 $file 卸载同一套协议。

🔴 **载荷从原响应捕获，禁中途 `resume` 重取**：这些字段只随那一次响应下发——收到就保存（载荷大先落盘存副本，后续要用读副本）。`resume` 不是查询命令：它把步骤重置后 body 从头重放——已提交过结果的工具调用直接代入旧结果，**尚未提交结果的那次调用会重新执行**，此时文件系统可能已被后续流程改变，重新执行得出的错误结果会**覆盖首轮的正确记录**（真机实撞：变异核证的恢复步已把文件复原，中途 resume 触发重跑，"变异未生效"的假结果冲掉了首轮"变异生效且测试变红"的真记录）。resume 只在进程/会话真死了之后用来接续实例。

```bash
<CLI> --json submit_and_fetch_next <step_id> --tool-result "@<output_path>" --state-dir "<STATE>" --instance "<INSTANCE>"
```

### commit

与 act 同源，严格执行已授权的不可逆动作。执行 agent 不自行增加审批步骤。

## 输出文件

完整输出对象只写响应给出的 `output_path`：

```json
{"var_name":"value"}
```

禁止写 `/tmp`、项目根、兄弟 work zone 或自选路径。列表/对象必须是真实 JSON 类型。

提交：

```bash
<CLI> --json submit_and_fetch_next <step_id> --output "@<output_path>" --state-dir "<STATE>" --instance "<INSTANCE>"
```

整个 `@<output_path>` 是一个双引号参数。`@` 只位于参数值首字符，不写进 JSON 字段值。

提交返回的新 JSON 是循环下一条响应。

## CLI 响应完整性

`run`、`submit_and_fetch_next`、`join_parallel`、`fanout-plan`、`fanout-next`、`resume` 都必须在 stdout 返回一条完整 JSON。

- exit 0 + 空 stdout
- stdout 不是可解析 JSON
- JSON 缺少 `status` / `action` 等该命令要求的分派字段

以上均为 **`DRIVER_PROTOCOL_ERROR`**。立即停止并把命令、退出码、stdout、stderr 返回 Main。写命令可能已经落盘，**禁止自动重跑**；也禁止根据 spec body、工具序号、约定文件名或 state 文件推断下一条响应。

## call

`step_type` 为 `call` 时整步归你驱动。响应带 **`call_protocol` 载荷——四条命令引擎已拼好，照抄执行**（禁改参数、禁 `run --call-parent`、禁查 `--help` 自选路线——worker 入口混用会双重嵌套跑死野目录）：

1. 照抄 `call_protocol.init_command`，唯一动作是把 `<CALLEE_SPEC_PATH:id>` 占位符替换为 callee spec 真实路径（callee_spec_id + 与父 spec 同目录约定）。
2. 先照抄 `call_protocol.child_advance` 领取子实例首个介入点（init 建的子实例是未推进态），再走标准循环（state-dir 照抄 `child_state_dir`、instance 照抄 `child_instance`）直到终态。
3. 子实例 completed：照抄 `call_protocol.report_completed`（引擎按映射回填，你不搬数据）。
4. 子实例 failed：照抄 `call_protocol.report_failed`（**禁止 `--failure` 自由文本转述**——引擎读子实例失败记录原封组装 CalleeFailure）。

（兼容注：旧引擎响应无 `call_protocol` 时按旧协议手拼——`init <子spec路径> --parent <INSTANCE> --step <step_id> --params '<子Inputs JSON>' --state-dir "<STATE>"`，循环用 `<STATE>/<INSTANCE>/calls` + 子 ID，回报命令形状同上。）

## 错误

- `SCHEMA_MISMATCH`：修正 output 后重提交同一步，引擎未推进。
- **重发已完成的步骤（幂等回执）**：submit 返回 `status:"ok"` + `code:"ALREADY_DONE"`，报文含"引擎当前在等步骤 Y"——不是错误也不是新推进（你交的步早已完成，本次什么都没变）。正确动作=按报文点名交付欠的那步，不要把自己记的步号当权威重交。带**不同内容**重交已完成步被拒（`STALE_RESUBMIT` error）=你的步号记错了，核对报文后改交正确的步。
- **`WAITING_WRITEBACK`**（status:"failed" 携此前缀的 failure_reason）：出现在 resume/推进类命令——不是 run 失败，是"有步骤已派出还没交结果"。按报文列的步号交付它们；不得按失败终态处理（不上报失败、不废弃任务）。
- 步骤执行失败：

```bash
<CLI> --json submit_and_fetch_next <step_id> --failure "<reason>" --state-dir "<STATE>" --instance "<INSTANCE>"
```

- CLI 非零退出：停止并把命令、退出码、stdout、stderr 返回 main。
- `DRIVER_PROTOCOL_ERROR`：停止，不重试、不猜测、不继续提交。
- 含 doc-ref 时，每条需要固定 cwd 的命令可使用唯一允许的链式：

```bash
cd "<VAULT>" && <CLI> <command> ...
```

除固定 cwd 外，不使用管道、命令替换或多命令链。

## 介入点

执行 agent 收到以下状态立即停止并返回，不自行处理：

- `paused`
- `parallel_ready`
- `adaptive_needed`
- `completed`
- `failed`
