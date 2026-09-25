# step_ready 执行规则（driver / worker 共用）

> 本文件是 hopspec skill 的抽出片段——`step_ready` 时按 `step_type` 怎么执行、怎么提交、异常怎么处理。driver subagent（`driver-subagent.md`）与主 agent 都引用此规则，消除重复。

## 按 step_type 执行

**reason / check**：你自身就是推理 LLM。依据 `context`（task_context / progress_summary / inputs / instruction / output_schema;兜底步另有 fail_context——所在失败兜底块的"此前失败情况"段,写通知/诊断类产出时如实引用它）推理，产出符合 output_schema 的 JSON（key 对应 output_schema 的 name）。

**reason 步的缺信息出口**：推理所需的信息在 context 里确实不存在时，不要编造——提交 `--output '{"lack_of_info": "说明缺少什么"}'` 代替正常产出，引擎会把该步如实记为缺信息失败（fail_kind 携语义进容器升级链，容器可据此分流知识补充或上报）。仅 reason 步有此出口；act 缺信息该失败就失败，check 判不了走如实 false。

**reason 步的工具故障出口**（^anc-exec-tool-failure-report）：reason 步执行中你用了自己的工具（检索/读文件）而工具实际失败时，**先自己想办法**——换参数重试、换语义等价的工具、走别的路径拿到等效结果，都合法（自救只花你本步的功夫；报故障是整段重跑，烧的是任务的重试预算——自救优先是成本更优的选择）。确认换不动、没有它就无法完成推理时，提交 `--output '{"tool_failure": "哪件工具怎么失败、试过什么自救、对本步产出什么影响"}'`，不要拿编造内容凑产出。缺信息（材料本来就没有）走 lack_of_info，工具故障（取材料的手段坏了）走 tool_failure——两个出口语义不同，引擎处置不同（前者可能补充知识，后者按故障重试）。
- **check 步骤**：固定双输出 bool（判定）+ text（说明）。判定 false → 引擎自动触发带反馈重跑/adaptive，**你只如实回判定**，不自己决定重试。

**act / commit 的 body 归引擎（2026-08-04 起）**：有 `hop_python` body 的 act/commit **不再整步交给你**——引擎自己解释执行。你只会收到两种请求：
- **`tool_request`**：引擎解释 body 撞到一个**引擎自己执行不了的工具**（caller 会话专属:MCP/宿主能力——文件工具等引擎 provider 内的工具已由引擎直执不再外发,2026-09-05 执行主体原则,权威 exec-engine ^anc-exec-tool-request）——响应给出 `tool`（工具名）、`args`（已求值命名参数）、`tool_call_seq`、`output_path`。你**只执行这一个工具**（用 Read/Write/Bash 落实其语义），结果 JSON 写 `output_path` 后提交：
  ```bash
  node <CLI> --json submit_and_fetch_next <step_id> --tool-result "@<output_path>" --state-dir <STATE> --instance <INST>
  ```
  🔴 **最小语义**：只做工具名+参数字面量之内的事，不添维度、不加派生字段（body 编排、中间变量、输出组装全在引擎，你多算的字段也进不了输出——但别浪费步数）。结果小可以直接 `--tool-result '<json>'` 内联。
  🔴 **args 值撞 `{"$file": "<路径>"}` 单键指针＝值已卸载**（参数序列化后超 4096 字符的引擎写进 work_zone/vars/ 下文件,响应里只给指针——阈值是 JSON.stringify 长度〔引擎常量 DEFLATE_THRESHOLD〕,是字符数不是字节数〔中文场景字节约为字符 3 倍,别按字节估卸载时机〕;2026-09-04 起生效）：执行工具前先 Read 该文件、`JSON.parse` 取真值再用,**指针对象本身不是参数值**,当字面值用（如把 `{"$file":...}` 字符串写进产物）就是把地址当货物。与 step_ready inputs 的 $file 卸载同一套协议。
  🔴 **载荷从原响应捕获，禁中途 `resume` 重取**：tool_request 的 `tool`/`args`/`output_path` 只随那一次响应下发——收到就保存（载荷大先落盘存副本，后续要用读副本）。`resume` 不是查询命令：它把步骤重置后 body 从头重放——已提交过结果的工具调用直接代入旧结果，**尚未提交结果的那次调用会重新执行**，此时文件系统可能已被后续流程改变，重新执行得出的错误结果会**覆盖首轮的正确记录**（真机实撞：变异核证的恢复步已把文件复原，中途 resume 触发重跑，"变异未生效"的假结果冲掉了首轮"变异生效且测试变红"的真记录）。resume 只在进程/会话真死了之后用来接续实例。
- **无 body 的 act/commit**：读自然语言描述，用 Bash/Read/Write 执行整步，`--output` 提交（旧流程）。**L4 工具清单是本步能力面的权威**（0054——prompt 的 L4 区块列出本步可用工具与调用通道,按它办）:基础文件操作用你自己的 Read/Write/Bash 落实;清单里带"引擎实现是唯一语义源"指引的引擎内建工具（spec 树编辑/校验族）照抄清单给的 `hopjit tool-call <名> --args '<json>'` 命令经 CLI 调用,不要用 Bash 模仿它的行为;**其余具名授权工具（web_search/browser/pdf 这类非内建件）优先用你自己环境里语义等价的原生能力落实**——检索用你自带的网页搜索、抓取用你自带的网页访问工具,同名 MCP 件已注册进你环境的直接调用;你确实没有语义等价能力时才按清单的兜底指引经 `hopjit tool-call` 调用（那要求引擎侧已注册该件）。**清单外的特殊工具本步不可用**——步骤没授权就不碰,缺工具按步骤失败处理如实上报。**工具故障先自救,换不动才报、不许硬凑产出**（^anc-exec-tool-failure-report）：本步依赖的工具调用失败时**先自己想办法**——换参数重试、换语义等价的工具或原生能力、走别的路径拿到等效结果,都合法（自救只花你本步的功夫;报故障是整段重跑,烧的是任务的重试预算）。确认换不动（报错/超时反复、你确认没有等价能力）且没有它就无法完成本步时,不要拿部分成果或编造内容凑一份"看起来完整"的产出——用 `--output '{"tool_failure": "哪件工具怎么失败、试过什么自救、对本步产出什么影响"}'` 提交（引擎识别单键 tool_failure 转步骤失败,按故障处置:容器重试或如实失败）,或直接 `--failure "<原因>"` 上报,两条路等价。特别注意"故障≠没结果"：检索类工具报错和"检索成功但确实搜不到"是两回事——前者走本条,后者如实交空结果。

**commit**：与 act 同源（副作用不可逆）。有 body → 同上由引擎解释、你只应答 tool_request；无 body → 展示不可逆操作描述后按描述执行。

## 提交（一条命令）

```bash
node <CLI> --json submit_and_fetch_next <step_id> --output '<结果 JSON>' --state-dir <STATE> --instance <INST>
```
- 输出 JSON：`{"var_name": value, ...}`，key 对应 output_schema 的 name。**列表类型 `[T]` 必须是真数组**（`{"pages": [ ... ]}`，不是把数组写成字符串），否则 SCHEMA_MISMATCH。

**提交 output 只有一种方式（机械照做，不要自己判断长短）：**

1. 把完整 output JSON 对象写到 step_ready 响应给你的 **`output_path`**（引擎已算好的确切路径，形如 `<work_zone>/out_<step_id>.json`）。文件内容形如 `{"pages":[...], "component_set":"..."}`——**所有字段都在这一个文件里**。
2. 用整包 `@file` 提交（`@` 后就是那个 `output_path`）：
   ```bash
   node <CLI> --json submit_and_fetch_next <step_id> --output "@<output_path>" --state-dir <STATE> --instance <INST>
   ```

- **🔴 独占工作区，只写这里**：`output_path` 落在你的 **work_zone**（响应给出的独占工作区）内。**禁止**写 `/tmp`、项目根或任何自选绝对路径——**引擎会校验 `--output` 路径在 work_zone 内，越界直接拒绝提交（WORK_ZONE_VIOLATION）**。后果（实测事故）：多个并行 worker 写共享 `/tmp/out_*.json` 会**互相覆盖、串台**——你的产出被别人的覆盖、check 可能漏检、最终产物损坏。用响应给的 `output_path` 就零风险。
- **`@` 只能贴在 `--output` 参数最前面**（`--output @文件`＝整个 output 在文件里）。CLI 只认「整个参数值以 @ 开头」，其它位置的 `@` 都不解析。
- **绝不把 `@` 写进 JSON 字段值**：`--output '{"pages":"@/path"}'` 是错的——`@/path` 不会被读文件、原样存字符串谎报类型。**大字段也放进那个文件里当真值**（真数组/真对象/真字符串）。
- 提交后引擎返回下一步 JSON，继续循环。

## call 步骤（子 spec 调用）

step_ready 的 `step_type` 为 `call` 时，整步归你驱动（引擎不解释）。响应里带 **`call_protocol` 载荷——四条命令引擎已拼好，你只照抄**（🔴 禁改参数、禁 `run --call-parent`、禁查 `--help` 自选路线——那是引擎派发 launch_command 的 worker 入口，混用会双重嵌套跑死野目录，引擎设了 CALL_PROTOCOL_MISUSE 闸但不要靠闸兜底）：

1. **建子实例**：照抄 `call_protocol.init_command`，唯一要做的是把 `<CALLEE_SPEC_PATH:id>` 占位符替换为 callee spec 真实路径（按 spec 发现流程：callee_spec_id + 与父 spec 同目录约定）。params/trace/log 参数引擎已折入，不看不改。
2. **驱动子实例**：先照抄 `call_protocol.child_advance` 领取子实例首个介入点（init 建的子实例是未推进态），然后标准循环（`--state-dir` 照抄 `child_state_dir`、`--instance` 照抄 `child_instance`）直到终态。
3. **子实例 completed** → 照抄 `call_protocol.report_completed`（引擎按 output_mapping 从子实例取值，你不搬运数据）。
4. **子实例 failed** → 照抄 `call_protocol.report_failed`（🔴 引擎读子实例失败记录原封组装 CalleeFailure——绝不用 `--failure` 自由文本转述，那等于 catch 到异常丢了 stack trace）。

**命令怎么执行**（hopissues/0097）：引擎给的命令（`call_protocol` 各条与派发的 `launch_command`）里,参数表、打回意见这类数据值一律不在命令行上——引擎把它们写进父实例目录下的参数文件,命令里只放 `"@<文件绝对路径>"`。所以命令串本身只含路径与标识符,**整串原样交给 shell 执行即可**（用你的 bash 工具跑,或程序里 `execSync(整串)`）。🔴 不要自己二次加工命令：不要拆开重新加引号、不要把 `@` 路径换成文件内容内联、不要为"保险"再套一层引号——二次加工正是旧形态腐蚀子 spec 源码的来路（反引号与 `$` 在双引号里被 shell 解释,代码块被静默吞掉）。程序里想绕开 shell,就按 shell 规则把整串拆成参数数组再 `execFileSync`,拆出来的每个参数一字不改。

（兼容注：旧引擎响应无 `call_protocol` 字段时，按旧协议手拼——`init <子spec路径> --parent <INST> --step <call步骤id> --params '<子Inputs JSON>' --state-dir <STATE>`，子实例循环用 `<STATE>/<INST>/calls` + 子 ID，回报命令同上两条的形状。）

## 异常处理

- **空/非 JSON stdout 不猜**（DRIVER_PROTOCOL_ERROR，与 Codex 载体同契约）：推进型命令 exit 0 但 stdout 空或非 JSON → **立即停止**，报告异常并把命令与现象交回主 agent；写命令可能已落盘，**不得自动重跑、不得从 spec/state/文件名猜下一状态**。
- **SCHEMA_MISMATCH** → 你的输出不符合 schema，**修正后重新 submit 同一步**（引擎未推进，停在原步）。
- **JSON 值内含引号必转义**：output 值是长 markdown/文本时，值内 ASCII 双引号必须 `\"` 转义，否则 JSON.parse 报 `Expected ',' or '}'`（实测坑：报告含英文引号首提失败）。**根治法：别内联长文本**——写 output_path 文件再 `@file` 提交（文件里是合法 JSON 即可，无 shell 转义问题）；文本内引号用中文引号也可规避。
- **含空格路径**：整个 `@<output_path>` 必须放在同一对双引号内；`@` 仍是参数值首字符。只写 `@<未引用路径>` 会被 shell 拆成多个参数。
- **步骤执行失败** → `node <CLI> --json submit_and_fetch_next <step_id> --failure "<原因>" --state-dir <STATE> --instance <INST>`，引擎内部处理 retry/adaptive 并返回下一步。
- **全部 retry 耗尽** → 引擎自动传播 fail，submit 最终返回 `failed`。
- **重发已完成的步骤（幂等回执）**：submit 返回 `status:"ok"` 且 `code:"ALREADY_DONE"`，报文含"引擎当前在等步骤 Y"——这不是错误也不是新的推进：你交的步早已完成，本次什么都没变。正确动作=按报文点名的步号交付欠的那步，**不要**把自己记的步号当权威重交。带**不同内容**重交已完成步会被拒（`STALE_RESUBMIT` error）——那说明你的步号记错了，核对报文点名后改交正确的步。
- **`WAITING_WRITEBACK`**（status:"failed" 携此前缀的 failure_reason）：出现在 resume/推进类命令——不是 run 失败，是引擎在告诉你"有步骤已派出还没交结果"。正确动作=按报文列的步号用 submit_and_fetch_next 交付它们；不得按失败终态处理（不上报失败、不废弃任务）。

## Bash 命令纪律（硬约束）

- 每条 Bash 调用只做一件事：一条 `node ...`，不管道（`|`）、不变量赋值。**唯一允许的链式**是前置 `cd <VAULT> &&` 锁定 cwd（spec 含 doc-ref 时必带——doc-ref 按 CLI 进程 cwd 解析引用路径，且 subagent Bash 在命令间会重置 cwd）；除此之外不 `&&`。
- 直接写完整命令 `[cd <VAULT> && ] node <CLI> <子命令> <参数>`，不缩写、不用 shell 变量。
- 自己读 stdout 的 JSON 按 `status` 分派，不 `| python3 -c` / `| node -e` 提取字段（管道触发 pipe_guard 弹框打断）。
