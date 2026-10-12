%% @trace
	id: hopjit-step-dispatcher
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-10-12T22:07+0800
	note: StepDispatcher 组件定义 + impl run_spec, execute_step。内容分级（决策/契约/说明）+ 6 个定义锚点
%%

# StepDispatcher 设计规范

> **与 HopJIT 的关系**：StepDispatcher 是独立模式的驱动适配层——ExecutionEngine 提供状态机和流控，StepDispatcher 把"下一步该做什么"翻译为对 Anthropic API 的实际调用并把结果回传引擎。复用模式（CC 直接驱动 hopjit CLI）不经过本组件。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择（存在多个合法选项时被选中的那个） | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点或明确约定的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | impl HopSpec 逻辑、示例、格式演示、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（四要素） | 契约 | `anc-struct-step-dispatcher` |
| 关键决策 | 决策 | — |
| impl run_spec | 说明 | — |
| Paused 恢复机制 | 契约 | `anc-exec-paused-resume` |
| 统一恢复模型 / 恢复 API | 契约 | （归 `anc-exec-paused-resume`） |
| confirm 与 commit 的恢复语义 | 决策+契约 | `anc-exec-resume-semantics` / `anc-exec-confirm-answer` |
| commit 安全分析函数 | 契约 | `anc-exec-commit-analyzer` |
| 无超时语义 | 契约 | `anc-exec-pause-timeout` |
| impl resume_spec | 说明 | — |
| 独立模式 call 递归 | 契约 | `anc-exec-call-recursion` / `anc-exec-call-tool`（工具 callee 退化形态）/ `anc-exec-call-child-persist`（子实例状态落盘随父） |
| 独立模式真并行 | 契约 | `anc-exec-standalone-parallel` |
| impl execute_step | 说明 | — |
| lack_of_info 知识补充路径 | 说明 | — |
| 节点级工具授权分档下发 | 契约 | `anc-step-tool-grant` |
| reason 步工具面（standalone） | 契约 | `anc-exec-reason-tools` / `anc-exec-toolloop-repeat-break` |
| 工具故障自报通道（reason+无 body act 的 tool_failure） | 契约 | `anc-exec-tool-failure-report` |
| 执行证据机核（重试轮零工具即声称完成拒收） | 契约 | `anc-exec-act-evidence-gate` |
| ~~doc-ref 文档引用解析~~（已抽出 [[doc-ref]]） | — | `anc-exec-doc-ref-resolve` 迁 doc-ref.md |
| 算子级重试 | 契约 | `anc-exec-operator-retry` |
| 产出被拒时正文疑似工具调用的附加提示 | 契约 | `anc-exec-text-toolcall-hint` |
| adaptive 结构化生成（三段流水线） | 契约 | `anc-exec-adaptive-pipeline` |
| API 请求构造 | 说明 | — |
| 步骤类型与 API 调用路径 | 说明（对照表） | — |
| 工具权限模型 | 契约 | `anc-exec-tool-permission` |
| API 错误处理与重试策略 | 契约 | `anc-exec-api-retry` / `anc-exec-network-pause`（网络暂停 B 半边） |
| 工具循环上下文压缩降级 | 契约 | `anc-exec-toolloop-ctx-degrade` |
| 子实例 HITL 队列（dispatcher 侧） | 契约 | `anc-exec-parallel-hitl-queue-dispatch` |
| LLM 前缀缓存注入 | 契约 | `anc-exec-cache-control` |
| 工具循环 tool_result 内容渲染 | 契约 | `anc-exec-tool-result-render` |
| 烧穿疑似反刍分流（正文空/in-band 高重复两形态） | 契约 | `anc-exec-thinking-exhausted`（归截断闸节内） |
| thinking 五级优先链（记名册>@thinking>routing_rules>provider 缺省>步骤类型缺省） | 契约 | `anc-exec-thinking-routing`（2026-09-20 review 批补登——旧欠;新锚一并） |
| @thinking 步骤标注（单步思考开关,B 案独立标注） | 契约 | `anc-exec-thinking-step-annotation` |
| 思考关不掉的端点改发 effort: low（五级链结果为关时的请求替换） | 契约 | `anc-exec-thinking-disable-unsupported` |
| API 密钥管理 | 契约 | — |
| 多模型路由 | 契约 | `anc-exec-model-routing` |
| 路由解析 | 契约 | `anc-exec-model-resolve` |
| 成本护栏 | 契约 | `anc-exec-cost-guardrails` |
| 上下文水位观测告警 | 契约 | `anc-exec-ctx-watermark` |
| 输出预算解析 | 契约 | `anc-exec-output-budget` |
| 非正常停止的判定与处置（stop_reason 三分） | 契约 | `anc-exec-output-abort-loud` |

> 跨文档引用 `^anc-exec-mode-invariants`（[[../concepts/HopSpec V3配套HopJIT运行时能力]]）是 link 不是本文定义锚点。

## 定位【契约】 ^anc-struct-step-dispatcher

> **模块版本**：step-dispatcher `v0.46.11`（2026-10-12 语义审计 #25：^anc-exec-tool-result-render 补 ToolResult.hint 旁注追加规则——注入 LLM 的 tool_result 文本 = result 渲染 + 换行 + hint,机械通道不见 hint）。上版 v0.46.10（2026-10-12 语义审计 27 条修复批次：^anc-step-tool-deny 消费面句漏改——1140 行仍写"check/commit 不收禁用行",与同文 1089/1105 行、parser 代码、概念层（作者拍甲案同步）相反,改为 check 同收 commit 不收;无代码改动）。上版 v0.46.9（2026-10-11 todo/0165：call parallel 形态两处补句——^anc-exec-call-recursion 的 call 边界反馈条补"parallel 标注的 call 子实例同样接收父的上游反馈,launchParallelCallChild 经同一个 buildCallUpstreamFeedback 拼装、同一个 EngineOptions.upstreamFeedback 注入";^anc-exec-call-child-persist 第 1 条补 parallel call 子实例 ID 的取法=dispatchParallelCall 算出的 `<步骤号>.<轮次>`,同落 calls/。此前两条只写串行 call 形态;无行为改动,配套 dispatcher.test.ts 六条传递线专测七条）。上版 v0.46.8（2026-10-11 todo/0161：^anc-exec-reason-tools 扩到 check——无 body 的 check 与 reason 同一入口,有声明走工具循环、零声明单发纯判定,requires_commit 件恒不下发,角色档与模型类别按步骤类型分;三处"check 步零工具面"改"零声明时零工具面";正反例补 check 侧三条。作者 2026-10-11 定"check 工具可能要读文件,留个口子"）。上版 v0.46.7（2026-10-11 语义审计 0156 C 类：九处账面与代码对齐——THINKING_EXHAUSTED / TOOL_LOOP_REPEAT 失败档次改写为步级瞬态（TRANSIENT_PREFIXES 首撞免扣）;协议客户端 classifyError 枚举补 unreachable、HopType 补 endpoint? / messages? 字段、stop_reason 值集按 SDK StopReason 写实;D61 词表补 ENETUNREACH / EAI_AGAIN;pausedChildren 条目补 engine / calleeId 成五字段;恢复语义表加升层停点行写 guidance 缺席退回 value 键;退避抖动改固定 0–100ms、cause 链口径改"本体+5 跳共 6 对象"、成本护栏首句三个改五个;parse_model_ref 补 INVALID_MODEL_REF 三规则）。上版 v0.46.6（2026-10-11 语义审计 0156 B6：^anc-exec-paused-resume 核清 confirm 停点由引擎 nextStep 产出、两模式同一载荷;dispatcher 的 executeConfirm 是不可达死码（探针四套件 1826 例零到达）,连同 confirm 分派分支删除）。上版 v0.46.5（2026-10-11 语义审计 0156 B3：杀活连坐条款补实装落点——requestAbortCascade 末尾调 engine.killInflight(),stop_run 路径对 paused 子实例账记 killed,此前只有主线失败路径记）。上版 v0.46.4（2026-10-11 语义审计 0156 B2：requestAbortCascade 三张在飞表条款写明 inflightDispatchers 含 reconcileAndRebuild 重建的 worker——代码重建处补登记/收割后删除,父 abort 能够到崩溃重建的子实例）。上版 v0.46.3（2026-10-11 语义审计 0156 B1：^anc-exec-parallel-hitl-queue-dispatch 应答路由补"实装落点"——续跑先按 launchParallelSubtask 同款等空位再摘卡续跑,名额满不超员;代码 resume 的 childInstance 分支同步加等待循环）。上版 v0.46.2（2026-10-11 语义审计 0156 A2：^anc-exec-reason-tools 的 max_inline_tools 档案上限截断条款与 HopSop 第 1 步标"待实装,归 todo/0095"——代码从未读过 profile,设计写了代码没做;定乙案不在本批写码,理由见条款）。上版 v0.46.1（2026-10-10 0154+0155 工程链 review 修复：出口表下 DirSpecProvider 条款构造签名改 `(基准目录, roots?)` 三级寻址——todo/0155 改了代码与 shared-providers 设计,漏了本文件这一条）。上版 v0.46.0（2026-10-08 commit 批准改为安全分析：原 commit 研判函数条款改为 ^anc-exec-commit-analyzer——makeCommitAnalyzer 只读带行号的 body 与引擎动作清单,不再读引用文件,逐动作给分类、引用行号、safe/human 结论与大白话后果;authorized_by 取值换成 engine_safe / model_safe / human / task_always / policy;COMMIT_NOT_APPROVED 报文改为先讲大白话分析、代码不先贴——权威 [[exec-engine#^anc-exec-commit-approval]]）。上版 v0.45.3（2026-10-08 todo/0151 作者定"修"：replan 流水线段 pipelineCall 补 HopLog `llm:` 块——此前三个 LLM 调用点只有两处记,到步展开 / 失败分析 / 改动策略 / 生成四种调用用了什么模型、烧了多少、端点怎么收尾在日志里全盲;记录点挂在触发 replan 的容器步骤下,字段与另两处同款,prompt/response 仍按级别裁剪;^anc-exec-output-abort-loud 观测①"既有盲区"句随删,^anc-exec-adaptive-pipeline 观测条补写）。上版 v0.45.2（2026-10-08 发版前八项修复批工程链 review 修复）。本版=OUTPUT_ABORTED 从事务级确定性改为**步级瞬态**（与 OUTPUT_TRUNCATED 同待遇：首撞免扣预算、下轮带反馈重跑、复发照扣）——批次一把它定成事务级越过了作者 2026-09-04 拍定的口袋归类判据（根因在本轮输入 → 步级瞬态）。上版 v0.45.1（2026-10-08）=研判输出解析接入 repairYamlScalars（解析点第 7 处）:研判理由引用 body 原文时值里的冒号加空格让 YAML 直载失败,放行结论被误判成无法解析而转人工（真机实撞）。上版 v0.45.0（2026-10-08）=commit 批准改为自动研判优先（作者定"自动研判,拿不准转人工，但是依然要给人选项，这个任务以后一律通过"）:executeCommit 关卡改 await engine.commitGate;commit_audit 的 authorized_by 取批准来源（human/auto_review/task_always/policy,收 todo/0146批review遗留账 ①）;resume commit 分支只查账不研判,报文参数改 fingerprint;新增研判函数工厂（v0.46 已由安全分析函数取代）。上版 v0.44.0（2026-10-08）=非正常停止响亮失败：stop_reason 三分（正常 / max_tokens / 其他）,其他值解析前抛 OUTPUT_ABORTED 事务级确定性失败不重试;openai 两协议 finish_reason 原值透传;HopLog llm 块记 stop_reason;usage 全零记 warn 旁证（todo/0121,^anc-exec-output-abort-loud）。上版 v0.43.1（2026-10-08）。上版 v0.43.0（2026-10-08）=ask 建议值供给：停点载荷加 `default_values` 按声明名分键（每个声明前序同名产出当建议值）;结构化类型 ask 必须有建议值来源（前序同名产出或 present_inputs,作者定 a 案,引擎不造骨架）。上版 v0.42.3（2026-10-08）=多声明 ask 被同一个对象灌满 → ASK_ANSWER_FLOOD 拒收（作者定"拒收并说明原因";定性为防御性兜底——多声明结构化 ask 不是推荐写法）。上版 v0.42.2（2026-10-08）=六卡批工程链 review 修复：AskAnswerMapper 按 HopType 块规则重写（块首 # 说明、Specs 组、参数竖排各带 #、分支 `[条件(…)]/[其他]`）。上版 v0.42.1（2026-10-07）=ask 应答映射补第二分支"信封内按声明名分家的对象按键拆解",文本型声明（line/text/markdown）收到对象或数组在写入路径拒收 ASK_ANSWER_SHAPE（hopissues/0119,权威 ^anc-exec-hitl-presentation 四分支 HopSop）。上版 v0.42.0（2026-10-07）=commit 批准闸:executeCommit 在执行 body 之前查引擎批准账,未批准设 pendingPause（pause_reason=commit）并落卡;resume 对 commit 暂停的 run 已批准则重置该步续跑、未批准拒收 COMMIT_NOT_APPROVED（todo/0146,权威 [[exec-engine#^anc-exec-commit-approval]]）。上版 v0.41.1（2026-10-07）=DirSpecProvider 构造加可选第二参 `antsRoot`,第一级同目录找不到时找 `<antsRoot>/<id>/<id>.md`,两级查找委托 hopant 的 `resolveCalleeSpecPath`（独立模式 `call <ant-id>`,todo/0142 子卡 B）。上版 v0.41.0（2026-10-04）。本版=DNS 秒级闪断不再判死端点：进程内按主机名缓存上一次解析成功的地址,DNS 查询失败时改用缓存地址连接;本进程里成功应答过的端点再撞 ENOTFOUND/ECONNREFUSED 降为网络类,走重试与网络暂停,不再首次即判 run failed;从没成功应答过的端点与 EPERM 维持 0106 的 fail-fast（hopissues/0118,见 ^anc-exec-network-pause 末两条）。上版 v0.40.2（2026-09-29）=工程链 review 修复:裸冒号修复的解析点清单改成逐一列出六处加一处诊断点;yaml 解析失败反馈的常见原因补"值以反引号、@ 或 % 开头";HopType 补键起始列与续行定义,HopSop 补三个停止出口;执行证据机核补使用点②的 HopSop、代码判法与标题的等价说明、reason 步授写类工具的已知边界（todo/0123）

**版本速览表**（新→旧）：

| 版本 | 内容一句话 | 要点与实撞出处 |
|---|---|---|
| v0.47.0 | web_search 请求时探测 provider 原生搜索 | todo/0153,作者 2026-10-12 三案里拍"请求时探测"（否显式配置字段与域名表）。anthropic 协议下 spec 声明的 web_search 首次真实请求即探测：tools 里换成服务端声明发出,响应含 server_tool_use（只认块类型不看工具名——deepseek web_search 与智谱 web_search_prime 同判）即 native,含 web_search 的 tool_use 即 client,忽略或 400 拒收则有注册重发一次客户端形态、没注册 WEB_SEARCH_UNAVAILABLE;结果按 service_id 存 state.json web_search_modes 随快照;起跑对账对未注册的 web_search 按缺省协议放行。^anc-exec-protocol-adapter 新条款,原"服务端工具不下发不消费"收窄到 openai 两协议 |
| v0.46.11 | tool_result 渲染补 hint 旁注 | 2026-10-12 语义审计 #25 作者拍甲案;listdir 空目录明示语从 result 挪到 hint,渲染时追加在文本尾部 |
| v0.46.10 | 禁用行消费面句补 check | 2026-10-12 语义审计 #18：1140 行"check/commit 不收禁用行"是 0161 同批漏改,同文 1089/1105 已改口;概念层 836 行作者拍甲案同步 |
| v0.46.9 | call parallel 子实例的上游反馈与子实例 ID 两句补齐 | 2026-10-11 todo/0165;call 边界反馈条与 ^anc-exec-call-child-persist 第 1 条此前只写了串行 call 形态,launchParallelCallChild 这条路的 upstreamFeedback 传入与 `<步骤号>.<轮次>` 子实例 ID 取法补成明句;配套六条传递线（committed 传播 / upstreamFeedback 下传 / dirs 继承 / logLevel 继承 / 派生视图 / calls/ 布局）专测六正例一反例,六次变异重放各红;无行为改动 |
| v0.46.8 | check 步按声明带工具,与 reason 同一套规则 | ^anc-exec-reason-tools 标题与契约扩到 check：无 body 的 check 与 reason 同一入口（有声明走工具循环,零声明单发纯判定）,requires_commit 件恒不下发,角色档与模型类别按步骤类型分;三处"check 步零工具面"改"零声明时零工具面";正反例补 check 三条。作者 2026-10-11 定"check 工具可能要读文件,这个应该留个口子",todo/0161;三种步骤只剩两套工具面规则 |
| v0.46.7 | 账面与代码对齐九处（纯文字,零行为变化） | 两个截断前缀的失败档次写成步级瞬态（代码 TRANSIENT_PREFIXES 2026-09-04 乙案）;protocol-client 契约 classifyError 九值 / endpoint? 字段 / stop_reason 值集;D61 词表两码;pausedChildren 五字段;升层应答 value 键兜底;退避抖动与 cause 链深度;成本护栏五机制;INVALID_MODEL_REF 三规则。来源=2026-10-11 六模块语义审计 ⚠️ C3 |
| v0.46.6 | 删死码 executeConfirm,confirm 停点归引擎一处 | ^anc-exec-paused-resume：审计报"两模式 confirm 载荷分叉",探针实证 dispatcher 的 executeConfirm 不可达——引擎 nextStep 已对 confirm 产 paused;删死码,测试钉独立模式 confirm 载荷形态。来源=2026-10-11 六模块语义审计 ⚠️ |
| v0.46.5 | 级联中止账记 killed | ^anc-exec-parallel-hitl-queue-dispatch 杀活连坐：requestAbortCascade 末尾 engine.killInflight(),stop_run 对 paused 子实例账面从 paused 改 killed。来源=2026-10-11 六模块语义审计 ⚠️ 复核为"设计四件代码三件" |
| v0.46.4 | 重建 worker 登记进 inflightDispatchers | ^anc-exec-parallel-abort / request_abort_cascade：reconcileAndRebuild 重建的 worker 入在飞表,父 abort 级联可达。来源=2026-10-11 六模块语义审计 ⚠️ 复核为真缺陷 |
| v0.46.3 | HITL 队列续跑先等空位 | ^anc-exec-parallel-hitl-queue-dispatch：条款"名额满等空位"补实装落点,代码 resume(childInstance) 分支加 hasFreeSlot 等待循环。来源=2026-10-11 六模块语义审计 ⚠️ 复核为真缺陷（满员续跑超员） |
| v0.46.2 | reason 工具面 max_inline_tools 条款标待实装 | ^anc-exec-reason-tools：条款与 HopSop 第 1 步加"待实装,归 todo/0095"——本版代码无 profile 读取。来源=2026-10-11 六模块语义审计 ❌（设计写了代码没做） |
| v0.46.1 | 分析材料参数改来源形态 | ^anc-exec-commit-analyzer:prompt 里的 args 是来源形态不是某次运行的值,分析判据补输入来源目标的判法;签名与字段说明补齐。commit 安全分析 review 缺陷 D41:commit 与 confirm 对照段补"执行前先查批准账,账上没有当前 body 的授权记录才做安全分析"。来源=commit 安全分析批次工程链 review（作者 2026-10-09 口径） |
| v0.46.0 | commit 安全分析函数 | ^anc-exec-commit-analyzer 取代原 commit 研判函数条款:makeCommitAnalyzer/analyzeCommitWith/renderCommitAnalysisPrompt,ANALYSIS_MAX_TOKENS=4096,不读文件;executeCommit 第 5 步改调 commitAuthorizedBy。来源=2026-10-08 作者改定方向"这里应该主要出自于安全性判断，而不是正确性判断" |
| v0.45.3 | replan 流水线段补 llm 块 | ^anc-exec-adaptive-pipeline 观测条:pipelineCall 每次调用后在容器步骤下记 llm 块（model / max_tokens / stop_reason / thinking / 用量 / prompt / response,与主路径同款）,段标签进 `pipeline_stage`。来源=todo/0151（review 面二 G10 既有盲区,作者 2026-10-08 定修） |
| v0.45.2 | OUTPUT_ABORTED 改步级瞬态 | ^anc-exec-output-abort-loud 处置段:产生点不记 fail_kind=deterministic,前缀进引擎 TRANSIENT_PREFIXES（[[exec-engine#^anc-exec-deterministic-no-retry]] 口袋归类表）;报文改"下一轮请换措辞再试一次";错误分类表行同改。来源=发版前八项修复批工程链 review 合理性意见 #1 |
| v0.45.1 | 研判输出解析接入裸冒号修复 | 研判函数（已由 anc-exec-commit-analyzer 取代）第 4 步:直载失败经 repairYamlScalars 修复重载;^anc-exec-output-inline-colon-repair 解析点清单加第 7 处。实撞=2026-10-08 commit 自动研判真机测试,deepseek-flash 给出 verdict: pass,理由里引用 `content: notice` 致解析失败转人工 |
| v0.45.0 | commit 批准:自动研判优先 | executeCommit 关卡改 commitGate（研判放行记账、转人工停点三选项）;authorized_by 分出 human/auto_review/task_always;新增研判函数条款（v0.46 已由安全分析函数取代;makeCommitReviewer:协议客户端单次调用、读引用文件走沙箱、输出解析不了按转人工）。来源=作者 2026-10-08 |
| v0.44.0 | 非正常停止响亮失败 | ^anc-exec-output-abort-loud 新增:classifyStopReason 三分,aborted 抛 OUTPUT_ABORTED（fail_kind=deterministic 事务级）;openai chat/responses 的 finish_reason 原值透传;llm 块记 stop_reason;usage 全零 warn。实撞=todo/0121（疑似内容审核掐断的半截输出被 SCHEMA 闸误判,重试白烧） |
| v0.42.0 | commit 批准闸（独立模式半边） | executeCommit 在 ADVANCE_ORDER_VIOLATION 检查之后查 engine.checkCommitApproval,未批准 → pendingPause + writeCommitApprovalCard → 返回 paused;resume 新增 commit 分支:已批准 → engine.resetCommitStepAfterApproval → executionLoop,未批准 → paused+rejected COMMIT_NOT_APPROVED;^anc-exec-resume-semantics 表 commit 行改写。来源=todo/0146（作者 2026-10-07"每一句 commit 只需要确认一次"） |
| v0.41.0 | DNS 秒级闪断不再判死端点 | ^anc-exec-network-pause 增"曾经连通过的端点不按死端点判"条（HopTrait/HopType/HopSop）:第一层 protocol-openai 新增 createCachingLookup,模块级单例经 longWaitFetchOptions 接进 undici 连接设置（调用方传函数形态 connect 时不接）,DNS 查询报 ENOTFOUND/EAI_AGAIN 且该主机名成功解析过就用上次的地址;第二层 dispatcher 模块级记录本进程成功应答过的端点（service_id + base_url）,这些端点撞 ENOTFOUND/ECONNREFUSED 改归 network 档,6 次退避后进网络暂停;EPERM、从没成功应答过的端点照旧 fail-fast。实撞=hopissues/0118（一次秒级 DNS 闪断,0106 规则首次即判死,一个并行父任务下 39 个子实例全被杀）;作者口径"成功调用现在失败的,为什么不用历史值" |
| v0.40.2 | 工程链 review 修复:裸冒号修复与执行证据机核的设计补齐 | ^anc-exec-output-inline-colon-repair:解析点清单逐一列出（六处+诊断点,旧文"四处"是引号前缀修复立条时的计数）;反馈常见原因补保留字符开头一条（validator 反馈文案同改）;HopType 定义键起始列（含列表前缀 `- `）、两种命中形态与续行;HopSop 补"报错不带行号/行号越界/32 次用尽"出口;测试成对补形态①必要条件反例与接线面。 ^anc-exec-act-evidence-gate:补使用点②（重试轮追加句渲染信号）HopSop、代码判"不等于 reason"与标题"只核 act"的等价说明、reason 步授写类工具的已知边界待拍（todo/0123）。来源=变速箱 qwen-flash 适配工程链 review（审查对象 214b92a0..19f757ed） |
| v0.40.1 | 裸冒号修复加引号时连同续行并入 | ^anc-exec-output-inline-colon-repair 增段:键值行已有行内值时,下面缩进深于键起始列的连续非空行是同一个值的续行,去首尾空白以一个空格接进值后整值加引号,续行位置置空行（行数不变）。实撞=ppt qwen-flash 第四跑步 4.1 修订轮,第 5 页裸冒号值跨两行、续行以反引号开头,只给首行加引号后续行被孤立再误修,pages 落空归一空列表,4.6 打回"pages 是空的"烧尽重试,run 失败（21.7 万 tokens） |
| v0.40.0 | 执行证据机核只核 act 步 | ^anc-exec-act-evidence-gate 增"适用范围"段:reason 步的交付物是产出文字本身,重试轮零工具按反馈改文字是合法形态,整个不进本闸;两个使用点同分道（dispatcher 机核区块跳过、工具清单重试轮追加句不渲染）。实撞=deep-validate 步 2.1（reason,声明 read 读卸载大件）× qwen-flash:第 2、3 轮按反馈改对了报告、零工具、没写 no_change,两轮被拒,重试耗尽;规约教写 no_change 复跑同样死 |
| v0.39.1 | 裸冒号修复加第二种命中形态:值以反引号、@ 或 % 开头 | ^anc-exec-output-inline-colon-repair 增段:报错行是键值形态且值以 YAML 保留字符（反引号、@）或指令起始符 % 开头时,不论值里有无冒号加空格都整值加引号,与裸冒号形态同一循环同一停止条件;引号、流式集合、块式标量、锚点、别名、标签、注释起始符仍不归本修复。实撞=ppt qwen-flash 步 4.1 content_points 以反引号开头,pages 解析落空归一空列表,交付零页演示文稿且全程无报错 |
| v0.39.0 | 值里裸冒号修复 + yaml 解析失败反馈点名出错行 | 新锚 ^anc-exec-output-inline-colon-repair:repairInlineColonScalars 按解析器报错行逐行把"不加引号且含英文冒号加空格"的值整值加引号,与引号前缀修复串联成 repairYamlScalars,四处解析点改调串联版;checkValue 对 yaml 解析失败报"第 N 行（原文）解析失败"加常见原因,解析出文字才报散文。实撞=hb2 qwen-flash 变体 4.2 七次输出四次撞,旧反馈误报散文致三次重试同因死 |
| v0.38.0 | 端点不可达 fail-fast | ^anc-exec-network-pause 末条:classifyError 归 network 且错误链带 ECONNREFUSED/ENOTFOUND/EPERM → 定性 unreachable 分档,首次即判不退避,抛 ENDPOINT_UNREACHABLE 前缀不进暂停门走 failStep 到 run failed,报文含 service_id/base_url/错误码。实撞=hopissues/0106（hop3 真机:dead provider 90s+ 永 running 静默挂死） |
| v0.37.0 | 键行全角冒号等同半角 | 新锚 ^anc-exec-output-fullwidth-key-colon（HopTrait/HopSop）:parseStepOutput 取值前把顶格声明输出名（可带双引号）后紧跟的全角 `：` 换成 `: `,单输出与多输出全部解析路径吃规范化文本;单输出没剥到标签时返回原文保真;值里、缩进行、非声明名行不动。实撞=glm-5.3-flash ppt `slide_ok： true` 三连重试烧尽,全集 6 个任务 33 处;作者拍 A=todo/decision/20260928-输出键行全角冒号.md |
| v0.36.0 | 非流式长请求不再被 300 秒掐断,等满上限不再当网络中断重试 | ^anc-exec-nonstreaming-timeout 新增"连接设置"段（HopTrait/HopType/HopSop）:undici Agent 的 headersTimeout/bodyTimeout 取 client 级等待上限,经 fetchOptions 传给三种协议共五个构造点;client 级上限改按 service 解析;SDK maxRetries 置 0。^anc-exec-api-retry 重试表加"客户端等待超时"行:classify 先认 undici 超时错误码归 timeout,timeout 且耗时 ≥ 本次等待上限 90% → 不重试,抛 `CLIENT_TIMEOUT:` 文案,不走网络暂停。实撞=todo/0117（glm-5.3-flash 单发 3—8 分钟,约 300 秒处 UND_ERR_HEADERS_TIMEOUT,再按网络瞬断重试 6 次,约 35 分钟后报"网络中断"）;作者拍方向 A=todo/decision/20260927-非流式超时修法加undici依赖.md |
| v0.35.0 | 思考关不掉的端点改发 effort: low | 新锚 ^anc-exec-thinking-disable-unsupported（todo/0118,作者拍"配置声明关不掉，改发少想"）:ProviderEntry 新增可选 `thinking_disable_unsupported: true`;五级链照常计算,结果为"关"且目标端点声明了关不掉时,请求改发 `output_config: {effort: "low"}`、不带 thinking 键,五级一视同仁;hoplog llm.thinking 摘要新增 `effort:low` 值,从发送口请求对象抄。实撞=glm-5.3-flash 收到 thinking disabled 报 400,烧穿记名册的止血重试反而让步骤必败 |
| v0.34.3 | no_change 剥除范围扩到调了工具的重试轮 | ^anc-exec-act-evidence-gate 剥除条件由"A B C 三条成立"放宽到"A B 两条成立",拒收条件不变;调了工具仍写 no_change 记 warn。实撞=T9 sdc×qwen3.8-27b r6 第 3 次尝试:五字段产出完整,尾随一行 no_change 使产出被解析成两个键的对象,类型校验误报缺字段 |
| v0.34.2 | 机核拒收文案开头提为共享常量 | ^anc-exec-act-evidence-gate 文案一字不变,开头一段改引用 prompt.ts 导出的 ACT_EVIDENCE_GATE_PREFIX;^anc-exec-cost-guardrails 补重做反馈指针。实撞=T9 sdc×qwen3.8-27b r5,见 prompt-assembler v0.27.0 |
| v0.34.1 | 截断报文分辨端点自带上限 | ^anc-exec-output-truncation-loud 契约句改定并新增"端点自带上限的分辨"段（todo/0113,作者拍 A 案"先量再批换端点"）:三个抛错点共用导出函数 truncationAdvice,报文恒写请求 max_tokens 与实际 output_tokens 两个数;output_tokens < 请求值×0.9 判端点自带上限,明说改本地配置没有用并点名探针 run-output-cap;前缀与重试行为不变。实撞:百炼 claude-code-proxy 端点 4096 硬上限忽略请求 65536,旧报文叫人调大早已是 65536 的本地上限,T7 ppt 4.2 与 T2 fact check L 5.2 两跑约 10 万 tokens 白烧 |
| v0.34.0 | 执行证据机核的 no_change 出口改成旁路声明 | ^anc-exec-act-evidence-gate 第二出口改定（todo/0111）:放行后把 no_change 键块（键行+缩进续行,与 extractSelfReportKey 读取范围一致）从响应文本剥掉再解析产出;剥空=只交了 no_change 没交产出,用专用文案拒收并点名本步输出名;拒收文案与重试轮工具清单句改教"产出照声明完整交,另起一行写 no_change";补 HopTrait/HopType/HopSop。按产出语义值放行的方案不做（语义判断,违本闸机械立场）。实撞:T9 sdc×qwen3.8-27b 步 5.1.1 只交一行 no_change 被类型校验以缺字段判死 |
| v0.33.0 | 产出被拒时正文疑似工具调用的附加提示 | 新锚 ^anc-exec-text-toolcall-hint:SCHEMA_MISMATCH 算子级重试的重做与耗尽两处,按本步最近一次终轮响应正文识别五种文字形态的工具调用,在原校验报文后追加条件式提示（工具名、在不在本步可用清单、可用的有哪些,"如果这段是产出内容本身，忽略本提示"收尾）;通过校验的产出不碰。实撞=todo/0110（Ling 在无 bash 的步骤里 9 轮把 `<tool_call>bash` 写成正文,反馈只说形态不对） |
| v0.32.0 | 并行子任务独占开关打开的工具 server 进程 | ^anc-exec-standalone-parallel "worker 共享父 ToolProvider"段加例外条款:三个并行注入点（过期子实例重建、并行子任务、并行 call 子实例）注入父工具面的派生视图（[[tool-interface#^anc-exec-tool-composite]] forkForParallelChild）,开关全关时仍是父的同一个对象;子任务收场关派生视图自有成员,暂停不关。实撞=todo/0112（deep research 5 个并行子任务共用一个 playwright 进程互抢浏览器） |
| v0.31.2 | 超窗错误产生点记确定性类别 | 错误分类表上下文溢出行:handleStepReady 捕获到以超窗前缀开头的错误时 failStep 传 fail_kind='deterministic'（[[exec-engine#^anc-exec-deterministic-no-retry]] "档次判定只看失败原因的开头"条款的产生点半边）。实撞=todo/0116（判定打回意见引用超窗前缀字样被当事务级确定性失败） |
| v0.31.1 | 网络暂停可观测 + 拒因文字单一来源 | ^anc-exec-network-pause 补"可观测性"一条:命令行 status 按状态账判得出网络暂停与嵌套串行调用子流程里的停点（判定权威 [[hop-cli#^anc-cli-status-nested-pause]]）,本模块暂停与恢复语义零变化;resume 的 CHILD_NOT_IN_QUEUE 拒因文字提成导出函数 childNotInQueueMessage,供 mcp-server resume_run 同步核对共用（[[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 4 条）。实撞=todo/0105（T5 hb2×Ling 嵌套网络暂停观察方 30 多分钟看到 running） |
| v0.31.0 | executeCall 子实例 ID 在 loop 里按轮次命名 | ^anc-exec-call-child-persist 第 1 条与 executeCall HopSop 步 5 改:子引擎 callStepId 与卫星日志目录名取引擎 serialCallChildInstance（[[exec-engine#^anc-exec-call-child-iter-id]]）,loop 里每轮落自己的 `calls/<步骤号>.<轮次>/`,不再被下一轮 init 整目录删除;callFrames/activeCallChildren/call_path 仍按 call 步骤号为键（它们寻址的是步骤,不是目录）。实撞=hopissues/0098 |
| v0.30.0 | inline 预览按本步有没有 read 工具分道 | ^anc-exec-llm-inline-context v3,todo/0115 作者拍 A 案——超 2 万字符的值只对下发面含 read 的步骤给节选预览,零工具 reason/check 全量内联（吸收 #53 check 特判）;两个使用点（L4 输入、doc-ref 章节）同分道,doc-ref inline 通道分预览/全量两档。实撞:deep-research 10.1 综合报告两次只看到前 2 万字符,对大半子问题"不给结论" |
| v0.29.0 | openai-responses 协议适配器实装 | todo/0020，作者拍"按工程链开工"。^anc-exec-protocol-adapter 扩为三档 wire 协议；makeOpenAiResponsesClient 做 IR↔Responses typed items 双向转换（tool_use/tool_result 与 function_call/function_call_output 一一映射，恒 store:false 全量重发）；ProtocolClient 增 supportsToolLoop 能力谓词（工具循环闸与 reason 降级道改判谓词，不比枚举名）；原"openai 不做工具循环"边界翻案（GPT-5.4 起 chat 不支持 reasoning 工具调用，Responses 是 OpenAI 官方生态正路，DeepSeek/xAI/vLLM/Azure 已原生跟进；^todo-openai-tool-loop 观察账随批次销）。实证=DeepSeek /v1/responses 真机四拍探针+standalone 工具循环 E2E completed |
| v0.28.0 | 执行证据机核 | ^anc-exec-act-evidence-gate 新锚——重试轮+工具面在场+零调用+无 no_change 自报，四条件与门拒收（第二出口=顶格 no_change 自报键放行留痕，阅卷两轮打磨）；治 27b 修错步十轮零工具调用却虚构完成；随批次工具清单前导句按重试轮分道。0095 2e，作者拍"27b 全面走通"第一件 |
| v0.27.0 | 0100 思考开关批次 | 步骤级 `@thinking off\|on` 标注（^anc-exec-thinking-step-annotation 新锚，B 案独立标注——机械步关思考省 8-9 倍、重推理步开思考补档，两手柄的落点）；thinking 路由扩五级优先链（记名册>步骤标注>routing_rules>provider 缺省>引擎内建步骤类型缺省〔作者定：act 关，act free/reason/check 开〕——思考行为自此恒显式，端点私有缺省退场；provider 级=逐模型矫正档，schema 权威 shared-providers） |
| v0.26.0 | reason 工具面改全按声明下发等三件 | ^anc-exec-reason-tools 修订+^anc-exec-toolloop-repeat-break 新锚（工具循环同签名断路器）+max_inline_tools 档案上限联动。Qwen3.8-27B 七轮实验与阶梯探针实锤：闲置工具面对弱执行者是行为吸引子，长供给×满配走偏 5/6 而 0 工具 3/3 交卷；model-gearbox 消费面第一环 |
| v0.25.0 | THINKING_EXHAUSTED 变招重试 | ^anc-exec-thinking-exhausted 三批次——检出即记名步号，该步后续重试轮 thinking 强制 disabled。R4 实撞：同 run 13 次烧满 65535 正文全空 ≈85 万纯废 token，免预算重试无变招同型反复撞 |
| v0.24.0 | 成本护栏第 5 机制：实例级上下文体量观测与软阈值告警 | ^anc-exec-ctx-watermark，hopissues/0095——长转录 150K+ 延迟超线性恶化撞超时墙全程零观测；峰值水位入账 hoplog/run_status+双档 warn+超时重试水位提示，纯观测加法零语义变更 |
| v0.23.1 | 补 ^anc-step-tool-grant 设计侧锚定义节 | 0088 批次清 0054 批次挂账——内容收拢自 spec-parser 版本行文法半边与本文档消费面，TRACEABILITY ⚠ 注记随清 |
| v0.23.0 | call callee 位插值解引用契约 | ^anc-step-call-dynamic-callee，todo/0066——resolveCalleeId 公共件/三消费点/非空字符串收紧/寻址政策零开口/executor 教学落 L0 |
| v0.22.0 | 节点级工具禁用下发过滤契约 | ^anc-step-tool-deny，与 edit_file 同批次 |
| v0.21.0 | 工具循环上下文压缩降级 | hopissues/0070——撞墙预检+补救两档任务相关摘要压缩；二次撞墙 CONTEXT_OVERFLOW 前缀入确定性口袋 |

**① 自身定位**：StepDispatcher 是独立模式的驱动适配层（TypeScript 模块，文件 `src/dispatcher.ts` + `protocol-openai.ts`）——负责两件事：

- **调度循环**（init → next → execute → done → repeat）；
- **单步执行**（按步骤类型分派，经协议适配层调 LLM API——anthropic/openai-chat/openai-responses 三协议，见 ^anc-exec-protocol-adapter；工具循环由 supportsToolLoop 能力谓词分道,anthropic 与 openai-responses 承载）。

它是 HopJIT"自带执行能力"的承载者：复用模式把执行能力交给 caller（CC），独立模式则由本组件自己调模型执行。

**② 与其他 HopType 的关系**：
- **ExecutionEngine 是上游驱动**——Engine 持有状态机和流控逻辑，StepDispatcher 在主循环中调用 `engine.next_step()` 取下一步上下文、`engine.complete_step()` / `engine.fail_step()` 回传结果。引擎决定"做什么"，Dispatcher 决定"怎么调 API 做"
- **调用 PromptAssembler 组装上下文**——execute_step 拿到 StepReady 后，由 PromptAssembler 产出 6 层 AssembledContext，再经 build_api_request 转为 Anthropic Messages 请求
- **调用 ToolProvider 执行工具**——act/commit 步骤的 tool_use 通过 `ToolProvider.list()` 取工具定义、`ToolProvider.execute()` 实际执行，受 SandboxConfig 约束
- **经 Engine 向 HopLog 写执行内幕**——独立模式的 LLM prompt/response/tokens、工具调用明细由 Dispatcher 执行时产生，经引擎写入 HopLog（见 [[spec-observability]] 双模式记录分界）
- **构造期依赖注入**：通过构造函数接收 `ExecutionEngine` 实例和 `HostConfig`（与 PromptAssembler 模式一致，便于测试 mock）。不提供 ToolProvider 时回退 `DefaultToolProvider`（Read/Write 受控工具 + SandboxConfig 四维度约束）

**②b 对外接口清单【封闭】** ^anc-struct-step-dispatcher-exports：

> 本表是 step-dispatcher 对外依赖面的封闭集，表外符号即内部实现。出口文件 = `dispatcher.ts` + `protocol-openai.ts`（协议适配器，同模块第二文件）。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。
>
> **注**：step-dispatcher 是**叶子驱动**（独立模式入口），当前无其它 src 模块 import 其符号（复用模式不经本模块，独立模式经测试驱动）。下列符号是其对外可用面，供独立模式入口/测试实例化；无跨模块 src 消费即无受检项。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `StepDispatcher` | 类 | dispatcher.ts | 独立模式调度循环（入口/测试实例化） | provisional |
| `DispatcherConfig` | 类型 | dispatcher.ts | 构造配置（tokenBudget 等） | provisional |
| `RunResult` | 类型 | dispatcher.ts | runSpec 返回结果 | provisional |
| `parseModelRef` | 函数 | dispatcher.ts | `service/model` / 裸 model 的单一解析入口（dispatcher、mcp-server 消费） | stable |
| `makeCommitAnalyzer` | 函数 | dispatcher.ts | commit 安全分析函数工厂（CommitAnalyzerProvider → CommitAnalyzer）——mcp-server 组合根按独立模式配置构造后经 ExecutionEngine.setCommitAnalyzer 注册（^anc-exec-commit-analyzer;2026-10-08 v0.46 由 makeCommitReviewer 改名改义） | provisional |
| `CommitAnalyzerProvider` | 类型 | dispatcher.ts | 分析用服务描述 {service_id, protocol, base_url?, api_key, auth?, model}（mcp-server 组合根构造） | provisional |
| `childNotInQueueMessage` | 函数 | dispatcher.ts | CHILD_NOT_IN_QUEUE 拒因文字单一来源（dispatcher.resume 异步拒收与 mcp-server resume_run 同步核对共用,[[parallel-execution#^anc-exec-parallel-hitl-queue]] 第 4 条;todo/0105） | provisional |
| `DirSpecProvider` | 类 | dispatcher.ts | 缺省 SpecProvider（调用方 spec 同目录 → 本机 HopAnt 根两级寻址，standalone 入口/测试构造注入；决策见 [[shared-providers#^anc-provider-spec-default]]） | provisional |
| `ProtocolClient` / `LlmErrorKind` | 类型 | protocol-openai.ts | LLM 调用协议句柄与错误类别枚举（dispatcher 内部消费+测试） | provisional |
| `wrapAnthropicClient` / `makeOpenAiClient` / `makeOpenAiResponsesClient` | 函数 | protocol-openai.ts | 三协议客户端构造（dispatcher 构造分派消费;openai 两个构造函数 v0.36.0 起收 waitMs,自己建连接设置） | provisional |
| `nonstreamingWaitMs` / `longWaitFetchOptions` | 函数 | protocol-openai.ts | 等待上限换算公式（按 max_tokens,唯一一处）与长等待连接设置构造（undici Agent,两个时限取等待上限;v0.41.0 起 connect 缺席或为对象时接 DNS 缓存 lookup）——dispatcher 构造点与重试分派消费（^anc-exec-nonstreaming-timeout,v0.36.0） | provisional |
| `createCachingLookup` | 函数 | protocol-openai.ts | 带上次成功结果兜底的 DNS 查询构造（底层查询可注入,测试消费;模块级单例经 longWaitFetchOptions 接线——^anc-exec-network-pause "曾经连通过的端点"条,v0.41.0,hopissues/0118） | provisional |

> **内部（表外即内部）**：各 execute*/build* 私有调度方法、API 请求组装 helper。

**③ 主要 traits 与主要成员**：

Fields：

- `engine: ExecutionEngine`——被驱动的引擎实例（构造注入）。实例标识由 Engine 持有（`engine.instance_id`），Dispatcher 不冗余存储
- `host_config: HostConfig`——宿主环境配置，含 ToolProvider / KnowledgeProvider / SandboxConfig 和 API key（定义见 [[shared-types]]）。构造时注入，提供执行能力的全部外部依赖
- `clients: Map<service_id, ProtocolClient>` 客户端池——按 service 的 wire 协议构造的协议句柄池（anthropic 直通包装/openai 适配器，^anc-exec-protocol-adapter），每个 service 独立 base_url + 凭证 + protocol，首次使用时按需创建；`default` 键为默认客户端
- `cumulative_tokens: number` / `token_budget?: number`——累计 token 消耗与全局预算上限（见成本护栏章）。**cumulative_tokens 经引擎持久化到 state.json**（可选字段）：Dispatcher 每次 API 调用累计后同步给引擎（`engine.setCumulativeTokens`），随常规 persist 落盘；跨进程 resume 重建 Dispatcher 时从引擎回填——预算护栏不被进程重启绕过。token_budget 不落盘（预算上限是宿主 resume 时重新给定的配置，非执行状态）

Specs（按职责分三组）：

**调度组**——驱动整个执行实例的循环：

- `run_spec`——主循环：init 解析初始化 → 反复 next 取步骤 → execute 执行 → done 回传 → 直到终态或暂停。遇 confirm/commit 暂停时返回 `{ status: 'paused' }` 交给 caller
- `resume_spec`——恢复中断的执行（跳过 init，从快照重建后直接进入 next 循环），覆盖 CITL 决策注入和崩溃续跑两种入口
- `request_abort` / `request_abort_cascade`——协作式中止请求：置 aborted 标志，循环在步间检查生效（不打断执行中的单步）。`requestAbort` 只停本层（parallel 杀活对单个在飞子实例用它）；`requestAbortCascade` 递归遍历**三张在飞表**逐个下发，深递归/并行场景下停整棵执行树。后者是 mcp-server `stop_run` 的消费面（[[mcp-server#^anc-mcp-stop-run]]）。三张在飞表：
  - inflightDispatchers（parallel worker——含 `reconcileAndRebuild` 从盘上重建的 worker：重建出来的 StepDispatcher 同样 set 进本表,收割后同样 delete,与 launchParallelSubtask / launchParallelCallChild 同款。2026-10-11 语义审计 0156 B2 补——此前重建 worker 不登记,父 abort 的 kill_list 与级联够不到它们,只剩账面 killed 兜底,重建子实例继续烧到自然终态）；
  - callFrames（暂停中的 call 子帧）；
  - activeCallChildren（执行中的串行 call 子层：handleCallStep 在 `await 子 runSpec()` 期间子 dispatcher 不在前两张表里，进 await 前登记、结算后注销——2026-08-22 review 实抓该缺口，只遍历两表则串行 call 子树烧到自然终态）

**单步执行组**——把单个步骤翻译为 API 调用：

- `execute_step`——按 `step_type` 分派：reason/check 纯推理、act 推理+tool_use loop、commit 执行不可逆操作、confirm 构造暂停信号、call 递归 run_spec
- `build_api_request`——把 AssembledContext 6 层转为 Anthropic Messages 请求（system + messages + 模型/温度/工具参数）
- `execute_tool`——工具调用的安全闸门：步骤-工具匹配检查 + 沙箱四维度检查 + Provider 执行

**模型与凭证组**——多后端路由：

- `resolve_model`——7 级优先级链解析步骤应路由到哪个 service/model（见关键决策）
- `resolve_credential` / `get_or_create_client`——凭证解析与客户端池管理，所有 service 统一走 Anthropic SDK，仅 base_url 和凭证不同

**④ 核心 impl 的主要 HopSpec 逻辑**：
```
# impl run_spec（调度主循环）
1. [act] init 解析 spec_source + run_params，获得 instance_id
2. [loop] 反复 next 取 NextResponse，按 status 分派：
   > completed/failed → 提取结果退出
   > step_ready → execute_step → done 回传（暂停信号则退出等 resume）（None 前置检查 2026-08-09 已删——fail 即异常定稿,None 是普通值）
   > adaptive_needed → 基于 subtask_contract 重规划 → submit_replan
   > paused → 构造 ExecutionPaused 返回 caller
```

---

## 关键决策【决策】

以下是设计 StepDispatcher 时存在多个合法选项、必须人拍板的关键选择。能从这些决策推演的实现细节不重复列出。

### 决策 1：直调 Anthropic API，而非套用 CC SDK / Subagent

StepDispatcher 自己持有 Anthropic SDK 调 Messages API，而不是把执行委托给 Claude Code SDK 或 subagent 机制。理由：

- **HITL / 续跑**：confirm/commit 需要在任意步骤暂停、返回 caller、跨进程恢复。直调 API 让暂停点和状态快照完全由 HopJIT 控制；套 CC SDK 则暂停语义受 SDK 会话生命周期约束
- **模型自由**：直调 API 才能按步骤路由到不同后端（reason→DeepSeek、check→Claude），CC SDK 绑定单一会话模型
- **清晰组件边界**：Engine（状态机）/ Dispatcher（执行）/ PromptAssembler（上下文）/ ToolProvider（工具）各司其职，边界清晰可测；嵌套 SDK 会模糊"谁拥有执行能力"这一双模式核心区分

### 决策 2：进程内 API 与 Engine 通信，而非 CLI 子进程 IPC

StepDispatcher 与 ExecutionEngine 之间用**进程内直接函数调用**（`engine.next_step()` / `engine.complete_step()` / `engine.fail_step()`），而非每步派生 `hopjit` 子进程。理由是性能：

- 热路径（next → execute → done 循环）零进程边界开销
- 进程内 API 消除每步 2 次进程派生 + 4-5 次文件 I/O 的开销，对于 40 步的典型 Spec 节省约 80 次进程创建和 160 次文件操作
- CLI 命令（`hopjit init/next/done/...`）保留为 Engine API 的薄封装层，仅用于外部人工交互和调试

### 决策 3：commit 批准后由 Dispatcher 执行，而非 caller 回填

commit 步骤获 caller 批准后，**由 Dispatcher 自己执行**不可逆操作（LLM tool_use），而非"caller 已执行、resume 仅回填结果"。由概念层双模式定义推演：执行能力归属决定执行者——独立模式执行能力在 ToolProvider（引擎侧），故批准后引擎执行；复用模式执行能力在 caller，故 caller 自己执行后回填。审计链相应分离：`authorized_by` 记录决策者，执行记录归属执行者。

### 决策 4：resolveModel 采用 7 级优先级链

步骤路由到哪个模型，按以下优先级从高到低解析（细则见"路由解析"章 `resolve_model`）：

| 优先级 | 来源 | 用途 |
|------|------|------|
| 1 | `step.model_override`（`@model` 标注） | 单步精确指定 |
| 2 | `spec_config.model` | Spec 级默认 |
| 3 | `model_engine.routing_rules`（按 step_type 匹配） | 按步骤类型批量路由 |
| 4 | `model_engine.default_model` | 显式引擎/standalone 默认（含目标 service） |
| 5 | `env.ANTHROPIC_MODEL` | 无显式 ModelEngine 默认时继承宿主环境 |
| 6 | `hostConfig.model` | programmatic 注入 fallback |
| 7 | `'claude-sonnet-4-6'` | 硬编码兜底 |

越靠近步骤且越显式的越优先（step > spec > 全局规则 > 显式引擎默认 > 宿主环境 > 注入 > 硬编码）。`ANTHROPIC_MODEL` 只作未配置 ModelEngine 时的继承 fallback，不能覆盖 standalone 配置选定的非默认 service。

---

## impl run_spec【说明】

```
# Spec: 执行 HopSpec 规约
Id: run_spec
Goal: 驱动 HopSpec 规约的完整执行，直到所有步骤完成或失败上报

Inputs:
- spec_source % text  # HopSpec markdown 原文或文件路径
- run_params % yaml   # 运行参数：Spec Inputs 的初始值（可选）

Outputs:
- result % yaml       # Spec 的 Outputs 变量集合
- status % line       # completed | failed

## Steps
1. [act] 调用 hopjit init 解析并初始化执行实例
  - ← spec_source, run_params
  + → instance_id % line  # 执行实例 ID
  > 调用 Engine 的 init_execution，传入 spec_source 和 run_params
  > 返回 instance_id；若解析或验证失败则展示 errors 并终止

2. [loop] 逐步执行直到完成或失败
  + → result, status

  2.1. [act] 调用 hopjit debug_step 获取下一步上下文
    - ← instance_id
    + → next_resp % yaml  # NextResponse（5 种形状之一）
    > 调用 Engine 的 next_step，传入 instance_id，返回 NextResponse（5 种形状之一）

  2.2. [branch] 按 NextResponse.status 分派
    + → none
    2.2.1. [case] status = 'completed'
      2.2.1.1. [act] 提取最终结果
        - ← next_resp
        + → result, status
        > result = next_resp.outputs, status = 'completed'
      2.2.1.2. [break]

    2.2.2. [case] status = 'failed'
      2.2.2.1. [act] 提取失败信息
        - ← next_resp
        + → result, status
        > result = next_resp.partial_outputs, status = 'failed'
      2.2.2.2. [break]

    2.2.3. [case] status = 'step_ready'（正常步骤待执行）
      2.2.3.1. [subtask retry=1 adaptive] 执行当前步骤并记录结果
        + → none
        2.2.3.1.1. [act] （已删）None 前置检查——2026-08-09 None 闸废除,None 输入照常交执行体
          - ← next_resp
          + → has_none_inputs % bool
          > 若任何输入变量值为 null（None），跳过 API 调用，直接 fail step
          > 返回 { status: 'error', code: 'MISSING_INPUT', message: 'Required input X is None' }
          > 不消耗 API 调用配额——失败处置在 Engine 层已决定，无需 LLM 推理
        2.2.3.1.2. [branch] 按 has_none_inputs 分派
          + → none
          2.2.3.1.2.1. [case] has_none_inputs = true
            2.2.3.1.2.1.1. [act] 直接 fail step（不调 API）
              > 调用 hopjit fail <step-id> --reason 'MISSING_INPUT: <var_names>'
              > 由 Engine.fail_step 按升级链（重试阶梯/未捕获终止）处理
            2.2.3.1.2.1.2. [continue]  # 跳过 execute_step
          2.2.3.1.2.2. [case] has_none_inputs = false
            2.2.3.1.2.2.1. 调用 execute_step：根据步骤类型执行
              - ← next_resp
              + → step_result % yaml  # 步骤输出或暂停信号
            2.2.3.1.2.2.2. [branch] 按 step_result 类型分派
              + → none
              2.2.3.1.2.2.2.1. [case] step_result 为暂停信号（confirm/commit 触发 HITL）
                2.2.3.1.2.2.2.1.1. [act] 输出暂停信号，退出循环等待外部回复
                  - ← next_resp, step_result
                  + → pause_signal % ExecutionPaused
                  > 构造 ExecutionPaused JSON，含 presented_data 和 response_options
                  > run_spec 返回 pause_signal 给调用方（不调 hopjit submit_and_fetch_next）
                  > 调用方呈现暂停信号给用户 → 用户回复
                  > 外部调用 hopjit submit_and_fetch_next <step-id> --answer '<json>'
                  > Engine 注入回复并推进状态 → 调用方重新进入 run_spec 循环
                2.2.3.1.2.2.2.1.2. [break]  # 退出 loop，等待外部 resume 后重新进入
              2.2.3.1.2.2.2.2. [case] step_result 为正常步骤输出
                2.2.3.1.2.2.2.2.1. [act] 调用 hopjit submit_and_fetch_next 记录结果
                  - ← next_resp, step_result
                  > 调用 Engine 的 complete_step，传入 next_resp.step_id 和 step_result
                  > 若返回 SCHEMA_MISMATCH，修正输出格式后重试
      2.2.3.2. [continue]

    2.2.4. [case] status = 'adaptive_needed'（需要重规划）
      2.2.4.1. [reason] 分析失败原因，基于 subtask_contract 设计新步骤
        - ← next_resp
        + → new_steps % text  # 新 children 的 HopSpec Steps markdown
        > 参考 next_resp.retry_history 避免重复失败策略
        > 新步骤必须满足 next_resp.subtask_contract.outputs
      2.2.4.2. [act] 提交重规划
        - ← next_resp, new_steps
        > Dispatcher 维护本地 replan_attempt_count（每个 subtask_id 独立计数）
        > 提交 new_steps 到 Engine 的 submit_replan，传入 subtask_id
        > Engine 解析验证后替换 children，**重写 spec.json（AST 变更须持久化）+ 发 replan_audit 提报**
        >   （提报与持久化在 Engine 侧统一做，两模式一致——见 [[exec-engine#anc-exec-retry-adaptive]] Adaptive Replan 协议步骤 4/6）
        > 若返回 VALIDATION_ERROR：replan_attempt_count++，重新生成（本地最多 3 次）
        > 达 3 次后调 fail_step(subtask_id)，防止无限循环
      2.2.4.3. [continue]

    2.2.5. [case] status = 'paused'（执行暂停，等待外部恢复）
      2.2.5.1. [act] 输出暂停信号，退出循环
        - ← next_resp
        + → result, status
        > resume 后 hopjit debug_step 可能返回 paused 状态（步骤仍在等待 HITL 回复）
        > 构造 ExecutionPaused 信号返回给调用方，调用方呈现给用户
        > 外部调用 hopjit submit_and_fetch_next <step-id> --answer '<json>' 注入回复后重新进入循环
      2.2.5.2. [break]
```

---

## LLM 注入面内联真值（standalone 无文件工具）【契约】 ^anc-exec-llm-inline-context

上游权威 [[shared-types#^anc-exec-deflate]] 消费端能力前提条款（BUG-H 实撞:deflate $file 指针泄给裸 API LLM,面对死引用就地编造幻觉材料落盘真库）。本节定 dispatcher 侧实施：

**能力契约（HopSpec 契约,v2 2026-08-25 作者定"独立模式用类似 yaml 缩进的方式引用,同时给一个相对宽松的限额"——限额普查定案:一刀切全内联把 ppt4 一个 41K 变量反复内联 12+ 处,57% prompt 超总量线,CONTEXT_OVERFLOW 实发 7 次全是此场景）**：

```
# Spec: standalone LLM 注入面内联（预览形态）
Goal: 裸 API LLM（无文件工具）收到的 prompt 中一切值条目都诚实——要么真值全文,要么明说是节选预览并声明全文在哪;$file 指针冒充值（BUG-H 病根:死引用逼模型编造）不出现在任何 LLM-facing 文本
Inputs: AssembledContext（引擎组装,inputs/doc_ref_context/hop_env_table 三面可能含指针）
Outputs: prompt 文本（真值内联或诚实预览条目）
Constraints:
  - 实施点=引擎组装期：StepDispatcher 构造时调 engine.setInlineLlmContext(true)——三注入面
    （resolveInputs L4/doc-ref 大节 L2/hop_env 值表）在该标志下不产 $file 指针;
    组装期一处关阀优于消费期逐面解引用（消费面会新增,组装面是单点）
  - inline 通道宽松限额 INLINE_PREVIEW_MAX=20000 chars/变量（≈5K tokens——dr16 普查变量 p90
    2502 的 8 倍,常态业务变量全量内联不受影响,只拦 40K 级病态尾巴）:
    · 值 ≤ 20000 → 真值全文内联（既有形态不变）;
    · 值 > 20000 且本步下发的工具面里有 read → 预览条目（L4 yaml 缩进条目形态,
      ^anc-exec-inputs-render 同款元信息头）:
      值位=前 20000 字符 + 明示"以下省略 N 字符";条目自带"体量: 全文 M 字符"与
      "全文: <work_zone/vars/<name>.json>（本条为节选预览;有文件工具时可读全文）"——
      全文照旧落盘（工具环读得到,审计有据）,与指针形态的本质区别是值位是真内容
      不是死引用;
    · 值 > 20000 但本步下发的工具面里没有 read → 真值全文内联（v3 2026-09-23 todo/0115,
      作者拍 A 案"按有没有读文件工具决定"）。预览的前提是"拿到节选的步骤能自己去读全文",
      没有 read 的步骤拿到的"全文在某文件"是死路,只能拿开头节选干活——汇总型 reason 步
      （deep-research 10.1 综合报告,输入 5 万到 10 万字符是常态）因此对大半材料"不给结论",
      run 照样 completed,是静默的残缺产出。全量内联后真超模型窗口会触发既有的
      CONTEXT_OVERFLOW 激进重组,重组后仍超就响亮失败——响亮失败好过静默残缺
  - "本步下发的工具面里有没有 read"的判定（prompt.ts `stepDeliversReadTool`,两个使用点共用）:
    · tool_denies 里有 read → 没有（禁用优先,与下发面过滤同序）;
    · act / commit → 有（basic 族恒下发,read 属 basic——带 body 的 act 与 commit 不调 LLM,
      判定结果不影响它们）;
    · reason → 声明了 `- 工具: read` 或 `- 工具: *` 才有（^anc-exec-reason-tools 按声明下发）;
    · check 零声明、以及 replan 流水线借 subtask 节点组装的输入 → 没有（零工具面单发）;check 声明了工具 → 有（与 reason 同,2026-10-11 todo/0161）;
    · 已知偏差（v1 简化）:openai-chat 协议（无工具循环能力）上声明了 read 的 reason 步
      实际走零工具单发,判定仍按"有"给预览——组装期拿不到本步路由到哪个协议,
      此组合罕见（声明工具的 reason 路由到 openai-chat）,撞上再把协议能力透传进组装期
  - 本判定吸收原 check 判定步豁免（#53）:check 步零声明时零工具面,按通则全量内联,不再按步骤类型特判;check 声明了工具时与 reason 同按工具面判（2026-10-11 todo/0161）
  - 两个使用点都按此判定分道:L4 输入变量预览（resolveInputs）、doc-ref 内容章节预览
    （resolveDocRefs——inline 通道分"预览"与"全量"两档,两档都不产 $file 指针;
    全量档不得落进 agent 通道的 deflate 分支,落进去就是 BUG-H 复发）
  - BodyInterpreter 的 derefFilePointer 保留（防御性——历史 state 里可能已有指针值）;**$preview 预览对象同经它解引用还原真值**（消费侧契约权威 [[shared-types#^anc-exec-deflate]] D59 $preview 段——解释器是确定性执行体,预览对象为 LLM 设计,dr18 第3攻 validate_spec 收对象确定性死实撞;$preview 只对绑定值顶层整串产生〔产生条件 typeof val==="string"〕,结构上不出现在数组元素/字段位,递归覆盖属 belt-and-suspenders）（构造 BodyExecContext 注入 `commandWhitelist`/`cmdJournal=engine.getCmdJournalFor`——subprocess.run 独立模式接线,清账归 engine.completeStep;契约权威 [[act-body#^anc-exec-subprocess-run]] 双模式条款,2026-08-30 属地登记）
  - 500 字符截断维持废除（预览是显式声明的节选,不是静默截断）
  - 复用模式零变化（driver=Claude 有 Read,4096 deflate 指针语义照旧）
```

**正反例**：
- standalone 中等输入（4K-20K）reason 步：prompt 含真值全文（无 $file 无预览标记）；
- standalone 超大输入（>20K）给声明了 `- 工具: read` 的 reason 步或无 body 的 act 步：prompt 含前 20000 字符+省略声明+全文路径,work_zone/vars 落盘全文；
- **同一超大输入给零工具声明的 reason 步或 check 步：prompt 含全文、无"节选预览"字样**（反例=旧形态截头给死路指引）；act 步声明 `- 禁工具: read` 时同走全文；
- doc-ref 超大章节四例同分道（全量档不含 $file、不含"请 Read"）；
- 复用模式同输入照旧 $file 指针；预览条目值位是真内容片段而非 `{$file:...}` 对象。

## LLM 前缀缓存注入（anthropic 协议）【契约】 ^anc-exec-cache-control

**为什么**（作者定 2026-08-16 ABC 全做之 B/C；A 分层重排见 [[prompt-assembler#^anc-exec-cache-affinity]]）：standalone 一次 run 几十次独立 API 调用共享稳定前缀，Anthropic 前缀缓存**不标不缓存**——cache_control 断点是显式 opt-in。写入 1.25×、读 0.1×，同 run 内步骤连续调用（分钟级间隔 < 5min TTL）复用 ≥1 次即回本。

**注入规则（B）**：
- **单步调用**（buildApiRequest）：system 从纯串改 content-block 数组——稳定面块（workspace + L1-static + L2-spec + spec 级 doc-ref + hop_env 表）末尾打一个 `cache_control: {type: 'ephemeral'}`；易变面（position_context + 步骤级知识等）在其后不标。tools→system→messages 前缀序下 tools 自动一并入缓存；
- **act 工具循环**（executeActWithTools）：除 system 稳定块外，每轮把**最新 user 消息**（tool_results）打滚动断点——N 轮循环逐轮增量复用，不打=每轮全价重读全部历史。
  - **滚动=移动不是累加**：打新断点前必须先遍历 messages 清除既有 user 消息内 tool_result 块上的 cache_control 字段（system 稳定块断点不动——它在 system 数组不在 messages），保证 messages 内恒最多 1 个断点（+system 1 个=总 2）。缓存复用不靠旧标记留在原地——上一轮已缓存的前缀由 API 按最长前缀匹配自然接续。
  - **为什么必须清（2026-09-04 review 面二 D1 实锤）**：初版只打不清，每轮新增 1 个断点从不清旧——5 轮循环即累积 6 个断点（含 system 1 个），超 Anthropic 官方上限 4 个 cache_control 块，API 直接 400 拒收，长工具循环必死；
- **低于最小可缓存长度**（~1024 token）API 自动忽略标记——小 spec 无害零分支；
- **openai-chat 协议**：适配器剥除 cache_control（OpenAI 自动前缀缓存,A 的分区重排已让它受益）——IR 恒 Anthropic 形状,剥除在 create 转换处。

**观测闭环（C）**：HopLog llm 流控字段扩 `cache_read_input_tokens`/`cache_creation_input_tokens`——真机档跑完可算实际命中率,无观测=效果只能靠信仰。
- 字段来源:response.usage 透传;openai-chat 侧 null 如实记,openai-responses 把 input_tokens_details.cached_tokens 映入 cache_read_input_tokens 可非 null（0020 批次,与 ^anc-exec-protocol-adapter usage 条款同源）;
- cumulativeTokens 计费口径不变（cache 读写已计入 usage.input_tokens 的计费语义由 API 侧定义,引擎照记原值）。

**正反例**：稳定块断点在场（anthropic 单步请求 system[0].cache_control）/工具循环第 2 轮最新消息带断点/openai 请求体零 cache_control 字段/小 spec 不因断点报错/HopLog llm 块含 cache 两字段（anthropic）与 null（openai-chat;openai-responses 的 cache_read 可非 null）。

## Paused 恢复机制（独立模式 CITL）【契约】 ^anc-exec-paused-resume

概念层原则"CITL 暂停点一致"（[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）要求 confirm 在独立模式也产生"等待 caller 决策"状态。`runSpec()` 遇到 confirm 返回 `{ status: 'paused', pause: ExecutionPaused }` 后，caller 通过恢复机制注入决策并继续执行。commit 只在本句 body 从未被批准过时暂停一次（[[exec-engine#^anc-exec-commit-approval]]）,批准过的直接执行。

### 统一恢复模型

**resume = 在某个 PersistenceProvider 之上从暂停点继续驱动引擎**。内存/文件只是 persistence 选择，不是两种恢复机制：

| 场景 | Persistence | 恢复入口 | 适用 |
|------|------------|---------|------|
| 短暂停（程序内审批） | MemoryPersistence | 同实例 `dispatcher.resume(stepId, answer)` | 调用方进程长活（服务、HopAnt 实例） |
| 长暂停（人工隔天审批） | FilePersistence | 跨进程 `resumeSpec(persistence, stepId, answer)` | HITL 等待跨进程生命周期 |

`resumeSpec` 内部即"从快照重建 Dispatcher + 调用同实例 resume"——两条路径汇合到同一实现。

> **实装状态（2026-06-13）**：CITL 恢复闭环已实装。`dispatcher.resume(stepId, answer)` 注入决策：
> - confirm 将 answer 作为步骤输出 completeStep（audit hitl_decision）；
> - commit 批准走 act tool_use 循环执行不可逆操作（allowCommit=true 放行 requires_commit 工具，audit commit authorized_by 取批准来源,见 ^anc-exec-resume-semantics commit 行），拒绝则 failStep；
> - runSpec 遇 confirm/commit 构造 ExecutionPaused（pendingPause）返回。
> - **confirm 停点由引擎产出,两模式同一载荷**（2026-10-11 语义审计 0156 B6 核清）：引擎 `nextStep` 对 confirm 步直接返回 paused（question="审批：<summary>"、context=人通道原值,权威 ^anc-exec-hitl-presentation / ^anc-exec-audience-routing）,独立模式与复用模式走的是同一处构造;dispatcher 原有一个自建 confirm 载荷的 `executeConfirm`（无 question、context 取 LLM 供给面）,但 dispatcher 永远收不到 confirm 的 step_ready,它是死码——审计把它当成"两模式分叉"报了 ⚠️,实为不可达分支;探针（四套件 1826 例在其中抛错零到达）实证后删除,dispatcher 的 confirm 分派分支随删。独立模式 confirm 停点载荷形态由测试直接钉在 dispatcher.runSpec 返回值上。
> 跨进程恢复的实装形态=mcp-server 重启后 run 恢复（[[mcp-server#^anc-mcp-run-restore]]）：load 引擎 + 宿主重注入 HostConfig + 新建 Dispatcher（构造时回填 cumulative_tokens）。同进程 `dispatcher.resume` 覆盖常规路径。

### 恢复 API

**恢复能力契约（HopTrait，Spec without Steps）**：

```
# Spec: 同实例恢复
Id: dispatcher-resume
Goal: 注入 caller 对暂停步骤的决策，继续执行循环直到下一个终态/暂停点
Inputs:
- step_id % line     # 暂停的 confirm/ask 步骤
- answer % yaml      # caller 决策（注入为步骤输出）
- call_path % [line] # 可选。多层 call 暂停帧的调用链——非空则剥头下钻直达挂起帧
Outputs:
- result % yaml      # RunResult（completed/failed/paused;paused+rejected={code,message}=answer 被拒未推进,修正后可重试——0016）

# Spec: 跨进程恢复
Id: dispatcher-resume-spec
Goal: 从持久化快照重建执行状态后恢复——注入决策续跑（对账在飞、重建 worker 见 §U2）
Inputs:
- persistence % PersistenceProvider
- step_id % line
- answer % yaml
- host_config % HostConfig
Outputs:
- result % yaml      # RunResult
```

（代码层投影：dispatcher.ts `StepDispatcher.resume(stepId, answer, callPath?)` 与 `resumeSpec`——设计以本契约为准。）

### confirm 的恢复语义【决策+契约】 ^anc-exec-resume-semantics

**confirm 是每次 run 都停的暂停点**（鉴权/决策环节）。commit 的每次执行不重新鉴权——授权在前序完成（环境预授权或前置 confirm），如同 `git commit` 不每次重新鉴权（见概念层 `^anc-step-commit`）;唯一的例外是批准关卡:一个 commit 步骤执行前先查批准账,账上没有这一步当前 body 的授权记录才做安全分析,body 里的动作全部可逆或低危（新建、追加、留存旧版本的覆盖与删除、备份轮转）就记账后直接执行、不问人,有不留旧版本的覆盖与删除、外部命令或外部服务调用时停下来让人批;人可以只批这一次（本次运行内有效）或这一步以后都通过（body 不变就一直有效）（2026-10-07 作者定,todo/0146;2026-10-08 作者定改为安全分析;权威 [[exec-engine#^anc-exec-commit-approval]]）。

| 步骤类型 | answer 含义 | 恢复后行为 |
|---------|-----------|----------|
| confirm | 审批决策（approve/reject） | approve → bool 槽写 true，记录 hitl_decision 审计 → 继续循环；reject/deny → 全局中止 |
| ask | caller 提供的数据值 | 值直接落到 `+→` 声明变量名 → 继续循环。无 reject 全局中止语义 |
| commit | 不带 answer;前提是 caller 已按人的选择调 approve_commit（scope=once 或 task）批准当前内容 | 已批准 → engine.resetCommitStepAfterApproval（running→pending、删卡）→ 进执行循环,nextStep 重新派发,executeCommit 看到批准后执行 body;未批准 → 不改状态、不分析,返回 paused+rejected `COMMIT_NOT_APPROVED`。body 执行后记 commit 审计,authorized_by 取批准来源（engine_safe / model_safe / human / task_always;关卡关闭为 policy）。需每次 run 都过人时由 Spec 作者在 commit 前置 confirm |
| 升层停点（pause_reason=escalate,待答步是 escalatable 的 check 步或展开续批的 subtask free 容器） | 指引文本。dispatcher 取 `answer.guidance` 键;该键缺席时**退回取 `answer.value` 键**（driver 按 ask 惯性交 value 键的形态,语义同为指引文本,宽容收下不逼重试）;两键都没有按空串处理 | 不走 mapAskOutputs（guidance 永远配不上 check 双槽声明）,`engine.resumeFromEscalation(stepId, guidance)` 把文本回注发起层的重试反馈通道,发起步回 pending 进执行循环重跑;展开续批形态另分"收手词面 → failStep deterministic 收口 / 其他 → 入授权账续展开"两路（权威 [[exec-engine#^anc-exec-check-escalate]] 应答回注条与 ^anc-exec-subtask-free-expand 契约 7）。2026-10-11 语义审计 0156 C3 补:value 键兜底此前只在代码注释里有,设计未写 |

独立模式 commit 批准关卡的两段流程（权威 [[exec-engine#^anc-exec-commit-approval]],本处是 dispatcher 侧落地）:

```
executeCommit(step):
1. 执行序核:文档序在本步之前存在非终态步骤 → 抛 ADVANCE_ORDER_VIOLATION（不可逆操作拒绝越序执行）
2. approval = await engine.commitGate(step.step_id)（查账,有授权记录直接放行、不扫描 → 扫描,引擎判全部安全记账放行 → 未批准且这个 commit 步骤没分析过则分析 → 判安全记账放行,否则转人工）
3. [条件(approval 不为 null 且 approval.approved 为 false)]
   3.1. pause = engine.buildCommitApprovalPause(step.step_id, approval)
   3.2. pause.work_zone 置空串（独立模式不向外部 driver 暴露 work_zone,^anc-exec-work-zone）
   3.3. engine.writeCommitApprovalCard(pause)（记事件、写 paused.json、persist）
   3.4. pendingPause = pause;返回 paused（步骤保持 running）
4. 执行 body（executeActBody,允许 requires_commit 工具）
5. 记 commit_audit,authorized_by = commitAuthorizedBy(approval?.decided_by):engine_safe / model_safe / human / task_always 原样,gate_closed 或 approval 为 null → policy

resume 的 commit 分支(step_id)（步骤类型是 commit 且状态为 running 时进入,在 confirm/ask 规范化之前）:
1. approval = engine.checkCommitApproval(step_id)（只查账,不分析——分析已在停下之前做过）
2. [条件(approval 不为 null 且 approval.approved 为 false)]
   返回 {status: paused, rejected: {code: COMMIT_NOT_APPROVED, message: commitNotApprovedMessage(step_id, fingerprint, instance_id)}}（状态零变化,run 仍 paused）
3. engine.resetCommitStepAfterApproval(step_id)（running → pending、删卡、persist）
4. 进执行循环:nextStep 重新派发这一步,executeCommit 第 2 步这次看到批准,执行 body

resume 的子实例队列路由收到子 dispatcher 的拒收时（childInstance 非空,子 resume 返回 rejected）:
1. 卡回队列、账回 paused（既有）
2. [条件(rejected.code == COMMIT_NOT_APPROVED)]
   fp = 子引擎.checkCommitApproval(step_id).fingerprint
   返回 rejected 换成 commitNotApprovedMessage(step_id, fp, 父实例 id, childInstance)——子 dispatcher 只知道子实例自己的 id,报文里的 instance_id 要换成调用方手里的 run id,并带上 child_instance
3. [其他] 原样返回子的拒收
```

- **COMMIT_NOT_APPROVED 报文同源**:resume 分支第 2 步与 MCP resume_run 的顶层预检（[[mcp-server#^anc-mcp-commit-approve]]）用同一个报文函数 commitNotApprovedMessage(step_id, fingerprint, instance_id, child_instance?)（子实例卡的拒收由父 dispatcher 的队列路由带父实例 id 与 child_instance 重新生成;放在 engine 模块导出,dispatcher 与 mcp-server 都能 import,不破分层）。报文写明三件事:这句 commit 有需要人确认的动作、还没批准;先用大白话把停点里的安全分析（每个需要确认的动作的后果与建议）讲给用户,代码不先贴,用三个选项问（只批准这一次 / 这一步以后都通过 / 不批准）;用户选前两项后调 approve_commit(instance_id, step_id, fingerprint, scope) 再 resume_run,选不批准则不调。理由:报文是 driver 协议的一部分,子实例与嵌套 call 路径若沿用旧报文"先调 approve_commit",agent 会照字面跳过问人直接批准。


**confirm answer 规范化【契约】** ^anc-exec-confirm-answer：（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-confirm]] answer→输出映射）caller 注入的 answer 不直接 writeOutputs（否则原始 key 如 `value` 污染变量空间、声明的输出名永远为 None）。

规范化在 **engine.completeStep 一处**集中（复用模式 CLI `submit_and_fetch_next --answer` 与独立模式 `dispatcher.resume` 共用，模式无关）：
- **决策值提取**：`answer.decision ?? answer.value ?? answer.answer ?? 单值`
- **reject 类**（reject/rejected/deny/denied/no——后两值为代码宽容同义词，2026-08-08 审计回写）→ **全局中止**（非局部 fail）：confirm 是授权否决，整条执行路径终止——`failStep` 后将所有未终态步骤标 `skipped`、执行终态 `failed`（类似 exit 全局性，终态失败）。见概念 [[../concepts/HopSpec V3核心规范#^anc-step-confirm]] reject 全局中止
  - **不走步骤级升级链**：reject 是授权否决非执行失败，且后续 commit 未必依赖 approval，数据链拦不住；
  - 统一两模式，原 dispatcher.resume 的 reject 分支收编进 completeStep
- **approve 类 → bool 审批槽写 `true`**（confirm 收窄为纯审批，`+→` 仅 bool）。落到 `+→` 声明的变量名，caller 无需知道声明名
- **取不到决定值 → 拒收（2026-10-07 作者定,todo/0146 review 决策 2）**：决策值提取的结果是 undefined 或 null 时——answer 缺席、是空对象 `{}`、decision/value/answer 三个键都没有且不是单值对象、或取到的值是 null（如 `{value: null}`）——completeStep 返回 `SCHEMA_MISMATCH` 结构化错误,报文写明"confirm 的回答里没有决定值,传 {value: \"approve\"} 或 {value: \"reject\"}";**不写变量表、不记 hitl、保留暂停卡、不推进**,与下方"ask 零映射拒收"同一处置形态。
  - **为什么拒收而不是当同意**：confirm 是人工闸,把"没给决定"当成"同意"等于空回答就能绕过人。JSON 没有 undefined,序列化后的空值恰好是 null,所以 null 与缺席同判；
  - **范围只管"取不到"**：取到了值、值不在 reject 类里的,仍按同意处理（与上一条一致,不改宽容口径）;commit 批准停点的续跑不带回答,不经 confirm 规范化,不受本条影响；
  - **非对象回答**：决策值提取对字符串、数组、null 这类非对象回答返回 undefined 而不是抛异常,于是同样落到本条拒收——各入口在进引擎前已经各自拦过一次（CLI [[hop-cli#^anc-cli-json-io]],MCP 驱动工具 [[mcp-server#^anc-mcp-reuse-driver-tools]]）,本条是引擎这一层的第二道防线；
  - **独立模式同样生效**：dispatcher.resume 对 completeStep 的非 ok 返回已转成 `{status: paused, rejected}`（run 保持 paused、卡不动）,不需要另加分支。
  - **使用点两处**：①completeStep 对 running 的 confirm 步规范化回答（上面的 HopSop）;②向已完成的 confirm 步重发时的幂等比对——非空但取不到决定值的回答不经 mapConfirmOutputs 映射,结果是 STALE_RESUBMIT 而不是 ALREADY_DONE（空对象 `{}` 按"不带 outputs"处理,照旧 ALREADY_DONE）（[[exec-engine#^anc-exec-stale-resubmit]] confirm/ask 应答同律条）。两处判"取不到"的口径相同:undefined 或 null。

```
normalizeConfirmAnswer(step_id, answer):
1. decision = extractDecision(answer)
   1.1. [条件(answer 不是普通对象——缺席、字符串、数字、数组、null)] decision = undefined
   1.2. [其他] 依次取 answer.decision、answer.value、answer.answer（键存在即取）;三键都没有时,answer 恰有一个键 → 取那个键的值,否则 undefined
2. [条件(decision 为 undefined 或 null)] 返回 {status: error, code: SCHEMA_MISMATCH, message: 说明没有决定值并给出两种合法形态}（状态零变化）
3. [条件(String(decision) 小写后属于 reject 类)] 全局中止（见上）,返回 ok
4. [其他] mapConfirmOutputs 把每个声明输出映射为 true,交 completeStep 后续照常写表与推进
```

**ask answer 处理【契约】** ^anc-exec-hitl-presentation：（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]]）ask 是数据收集，与 confirm 审批正交。caller 注入的数据值直接落到 `+→` 声明的变量名——不走 confirm 的 decision 提取/reject 中止逻辑。
- 若 caller answer 是 approve（采用默认值快捷），引擎用 `default_value`（前序推断）填充；若 answer 给具体值/选项，则用该值。
- （本锚点覆盖：paused 自包含介入请求组装 + ask answer 落值）

**建议值供给——结构化类型的 ask 不让人凭空敲结构（2026-10-08 作者定："yaml/列表型的输入究竟应该怎么交互,至少要给一个建议输入让人来改";同日补定"尽力避免问人 yaml/列表这种设计,除非没有其他更好的选择"）**：

- **第一层是设计选择,不是机制**（概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]] 同条）：写 spec 时先问要不要向人要结构——正路三条：前置步骤从文件 / 环境 / 前序产出备好,ask 只让人确认或改一处;拆成几个各要一个标量的 ask;用 `enum` 让人在候选里选。只有这些路都走不通时才向人要 yaml / 列表,下面的建议值供给是那个例外情形的兜底,不是对结构化 ask 的许可。

- **载荷**：ask 停点的 `presented_data` 带 `default_values % yaml`——按声明名分键,对每个 `+ →` 声明,该 ask 的 `- ←` 输入里有同名变量（前序步骤产出）就把值填进去,没有的声明不出现在键里。既有 `default_value`（只给第一个声明）保留,向后兼容旧 driver。
- **来源规则（作者定 a 案）**：真要向人要结构时,结构化类型（yaml / 列表 / 类型面具名类型）的 ask **必须有建议值来源**,两种——①前序步骤产出同名变量（引擎自动当建议值,上条）;②`present_inputs` 指一个样板变量（driver 必须完整呈出）。两者都没有是 spec 写得不对——写 spec 时 validator V17 warn（[[spec-parser#^anc-rule-v17]]）,运行期 driver 如实告诉人这一步要给完整结构并列出字段名,不静默。**引擎不按类型造骨架**（作者否 b 案）：裸 `% yaml` 没有字段信息只能给空壳,没意义;类型面有字段的骨架留作后续,先把来源规则立住。
- **driver 义务**（三载体 ask 停点段）：声明是结构化类型且 `default_values` 里有它 → 先把建议值完整呈给人（可读的 YAML 块,不缩略）,问"照这个用,还是改哪里",人改完按声明名提交;没有建议值 → 告诉人"这一步要你给完整的 <名>（<类型>）,没有样板",列出 `output_schema` 的字段名,不替人编。
- **为什么**：ask 的概念定位是向人要数据值,典型是选项、一句话、一个数字;结构化数据让人现场手敲 JSON 不是正常用法,正路是前置步骤从文件或环境备好、ask 只让人确认或改一处。0119 那张卡的多输出 ask 实撞与 FLOOD 拒收都是这个缺口的下游症状——补上建议值供给,人改一个现成结构比凭空写少错得多。

**ask 应答映射四分支（engine.mapAskOutputs，2026-10-07 hopissues/0119 补"信封内键命中"分支;2026-10-08 review 修复批按 HopType 块规则重写签名、四分支统一命名）**：四分支的名字固定为 **顶层键命中 / 信封内键命中 / approve 快捷 / 单值灌满**,本节、零映射条款、代码注释三处同一套词。

```
HopType: AskAnswerMapper
  # ask 步应答到声明输出的映射器——caller 注入的原始 answer 对象按四分支落到 `+ →` 声明的变量名
  Specs:
    mapAskOutputs(
      node % AskStep,       # 当前 ask 步（取其 outputs 声明）
      answer % yaml,        # caller 注入的原始应答对象,未剥封
      step_id % line,       # 当前步号,approve 快捷读前序推断值时定作用域
    ) -> outputs % yaml     # 按声明名分家的输出对象;交 coerceAskTypes 做无损标量归一后写变量表
      1. [条件(声明为空)] 原样返回 answer
      2. [条件(answer 顶层键里有任一声明名)] 采用 answer（顶层键命中——"按声明名提交"的正路）
      3. 剥信封：raw = answer.decision ?? answer.value ?? answer.answer ?? 单键的值
      4. [条件(raw 是普通对象——非数组、非 null——且它的键里有任一声明名)] 采用 raw（信封内键命中——与顶层键命中同语义,只多剥一层）
      5. [条件(raw 是 "approve")] 每个声明取前序同名推断值（approve 快捷）
      6. [其他] 每个声明都赋 raw（单值灌满——单声明收单值的正路;多声明时同一整值灌满每个声明,由下方两道拒收面接手：文本型声明收对象/数组 → ASK_ANSWER_SHAPE,两个以上声明收到同一个对象 → ASK_ANSWER_FLOOD）
```

- **信封内键命中的来历**（hopissues/0119，外部 skill 项目 2026-10-04 真机实撞）：驱动文档教的注入形态是信封 `--answer '{"value": …}'`。多输出 ask 的 caller 照模板把按声明名分好家的对象放进信封——顶层只有 `value` 一个键,顶层键命中不成立,剥封后走单值灌满,同一个整对象被赋给每一个声明;声明是 `line` 的变量装着对象,下游拼字符串变成 `[object Object]`,败因在两步之外的 ENOENT 才显形。拒收不是正解：信封是驱动文档自己教的写法。
- **文本型声明收到非标量 → 拒收**（同卡第二失守面）：completeStep 的 ask 分支在 mapAskOutputs 之后、零映射拒收之前判——声明类型为 `line` / `text` / `markdown` 的输出拿到的是对象或数组 → 返回 `SCHEMA_MISMATCH`,报文前缀 `ASK_ANSWER_SHAPE`,点名声明与类型并给出按声明名提交的样例 `{"<名1>": "<值>", "<名2>": "<值>"}`;**不写变量表、不记 hitl、卡保留、不推进**（与零映射拒收同通道形态）。只在写入路径判,幂等重发的比对路径（[[exec-engine#^anc-exec-stale-resubmit]]——completeStep 对已 done 步的内容比对）不拒,比对只看相不相等。`yaml` / 列表 / 类型面声明收对象是合法值,不在此拦。coerceAskTypes 的"只做无损转换、不新增拒收面"契约不动,拒收面住在调用处。
- **多个声明收到同一个对象 → 拒收**（2026-10-08 作者定"拒收并说明原因",六卡批 review 上报 N1）：ask 声明两个以上输出、单值灌满后至少两个声明的值是**同一个对象引用**（信封里的对象键名与全部声明名零交集时就是这形态）→ 返回 `SCHEMA_MISMATCH`,报文前缀 `ASK_ANSWER_FLOOD`,写明"N 个声明收到了同一份对象——几乎必是忘了按声明名分键"并给按声明名提交的样例;处置形态与 SHAPE 同（不写表、不记 hitl、卡保留、不推进）。为什么拒而不是放行：多个声明各装同一份对象,下游每个消费者都拿错料（db 配置被塞给 cache 配置）而引擎报成功零提示;真要两个声明同一个值,`{"a": X, "b": X}` 写得出来。**定性是防御性兜底,不是认可这种写法**：ask 的概念定位是向人要数据值,典型是选项、一句话、一个数字（[[../concepts/HopSpec V3核心规范#^anc-step-ask]]）;要多份结构化数据的正路是前置步骤从文件或环境备好、ask 只让人确认或改一处,或拆成多个要标量的 ask——全库 examples/skills 里没有一个 ask 声明两个以上结构化输出。让人现场手敲 JSON 本身是 spec 写得不对,本闸堵的是写错之后的静默灌错。单声明 yaml 收对象天然正确,不经本闸;两个以上声明按声明名提交（顶层或信封内分键）照常放行。
- **三道拒收闸的分工**：对象/数组落到文本型声明归 `ASK_ANSWER_SHAPE`（形态错）;两个以上声明被同一个对象灌满归 `ASK_ANSWER_FLOOD`（分键错）;null/undefined 归下方 `ASK_ANSWER_EMPTY`（零映射）。判序 SHAPE → FLOOD → EMPTY——文本型声明被灌对象时 SHAPE 先报（它的报文更具体）。信封内键只命中部分声明名时按"信封内键命中"采用,未命中的声明落 undefined,由零映射条款的"部分映射容忍"放行（增量应答合法）。

**question 与 instruction 受众分流（2026-08-25 修 #34,作者 08-24 实抓）**：paused 载荷的 `presented_data.question` 是**给人的问题面**——只由 summary 构成（confirm=`审批：<summary>` / ask=`请提供：<summary>`），**不再拼接步骤 instruction**。
- **为什么分流**：instruction 是 spec 作者写给执行/驱动侧的作业指引（"若 X 已给且存在直接采用不必强问"这类），受众是答题的机器方,拼进 question 等于让人读机器指令（实抓形态:question 后半段全是驱动侧判断规则）；
- **instruction 保留为载荷独立字段**（驱动侧代答判断/是否强问的参考）——**driver 契约已接线**:各载体 SKILL 的 paused 节注明读 presented_data.instruction 且带 require_human:false 例外框架〔无框架裸挂"代答"=在没开门的文档里隐式开门,二审抓表述漂移〕;原表述含"呈现裁剪依据"已删——呈现裁剪与 present_inputs 禁缩略硬约束冲突,instruction 不得作为缩略呈现的依据；
- 数据面归 context/output_schema/default_value,呈现契约（present_inputs 纪律）不变；
- **审计对齐**:hitl 的 shown 字段与 question 同源（=summary）——instruction 不进人眼后审计再拼它="还原人当时看到了什么"失真（观测记录点必须在事实边界）;instruction 的审计痕在 paused 问题卡整卡。

**ask 零映射拒收**（hopissues/hoplogic3/0031——规范化后一个声明输出都没得到有效值 → 拒收不写表）：mapAskOutputs 四分支（顶层键命中 / 信封内键命中 / approve 快捷 / 单值灌满）走完后，若**全部声明输出均无有效值——undefined 或 null 都算无效**，completeStep 返回 `SCHEMA_MISMATCH` 结构化错误（报文点名缺哪些声明输出+指路"approve 快捷需前序有同名推断值"），**不写变量表、不记 hitl、卡保留、不推进**——与凭证闸（0004 ask 级）同通道形态。
- **null 也算无效的来历**（review 复核抓漏）：原判据只认 undefined，而 MCP/CLI 的 answer 走 JSON，**JSON 没有 undefined、序列化空值恰产 null**——`{value:null}` 把 null 灌满全部声明输出后穿闸，0031 病灶经 null 形态原样复发；
- **典型形态**：answer 是 `{value:"approve"}` 但前序无同名推断值可采——approve 是 confirm 的应答形态，ask 要业务值；
- **修前静默 ok 的后果**：声明输出落 None，下游拿空输入继续跑，败因漂移到两步外（fact-check 全链实撞：步骤 3 静默吞 → 步骤 5 retry exhausted，真因与终态败因隔两步）；
- **部分映射容忍**：多输出声明部分有值=放行（增量应答合法，未答的落 None 由下游 None 传播语义接手）——拦的是"整个应答一个都没对上"（应答形态整体错误的机械判据），不拦"答了一半"。

**ask paused 响应的 `present_inputs` 透传【契约】**（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]] 呈交语义条款）：若 AskStep 声明了 `present_inputs: [name1, name2, ...]`（已经过 P12 校验是 ← inputs 的子集），引擎组装 paused 响应时**必须**在 `presented_data` 加 `present_inputs: [name1, name2, ...]` 字段，原样透传。
- **driver 义务**：收到此字段非空时，**必须把 `context` 里这些字段的原文完整 dump 给 user**（用 markdown 段落/引用块/代码块），禁止只给标签/省略号/摘要后再问决定——这是 driver 契约义务，由各 runtime 载体（复用模式 SKILL.md、独立模式 dispatcher 等）落实；
- 省略 `present_inputs` 字段（或为空）= 现行行为（driver 可缩略）；
- **用途**：让"草稿 → user 审 → 继续"场景（如 PPT 大纲确认、文档 P0 决策）真正保证 user 看到大段内容才作答；
- 注：数据本身已在 `context` 里完整呈现（context 含该 ask 的全部 ← inputs 值），present_inputs 只是"必展示"标记，不是新数据通道。

commit 由 Dispatcher 直接执行（独立模式执行能力在 ToolProvider/引擎侧）——由概念层双模式定义推演：执行能力归属决定执行者。审计链：`authorized_by` 记录授权来源（engine_safe/model_safe/human/task_always/policy，[[exec-engine#^anc-exec-commit-approval]]），执行记录归属执行者。

本节机制满足概念层原则 5（暂停必有恢复闭环，执行必达终态，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）。


### commit 安全分析函数【契约】 ^anc-exec-commit-analyzer

[[exec-engine#^anc-exec-commit-approval]] 的安全分析函数在本模块实现：引擎层只定函数类型 CommitAnalyzer，调模型要用协议客户端，客户端归本模块，所以由本模块给出工厂、组合根注册。分析函数只读引擎给的材料（带行号的 body 与引擎动作清单），不读文件、不看输入值——安全性由 body 里的动作决定，材料自足。动作清单里的参数是来源形态，不是某次运行的值（作者 2026-10-09 定"核心是研判的时候，应该判断这个过程，不应该是实例化的参数"）：分析结论按 spec + 步骤号 + body 指纹记账、以后复用，材料必须对这句 body 的每次运行都成立。

```
HopType: StepDispatcher 模块函数
  # 安全分析函数工厂;无状态,不持有引擎
  Specs:
    makeCommitAnalyzer(
      provider % CommitAnalyzerProvider   # 分析用的服务与模型,HopSchema 见下
    ) -> analyzer % CommitAnalyzer        # 异步函数,签名见 exec-engine
      1. client = 按 provider.protocol 构造协议客户端:openai-chat → makeOpenAiClient,openai-responses → makeOpenAiResponsesClient,其余 → wrapAnthropicClient（auth=bearer 走 authToken、apiKey 置 null;否则 apiKey、authToken 置 null;SDK 内部重试 0）;等待上限 nonstreamingWaitMs(ANALYSIS_MAX_TOKENS),与执行路径同一构造
      2. 返回 analyzeCommitWith(client, provider, ·)
    analyzeCommitWith(
      client % ProtocolClient,              # makeCommitAnalyzer 第 1 步构造的协议客户端
      provider % CommitAnalyzerProvider,    # 取 model 与 service_id（后者拼进返回的 model 字段）
      request % CommitAnalysisRequest       # 引擎组好的分析材料（exec-engine buildCommitAnalysisRequest）
    ) -> analysis % CommitAnalysis          # 模型给的分析,尚未与引擎动作清单合并
      1. prompt = renderCommitAnalysisPrompt(request)
      2. resp = client.create({model: provider.model, max_tokens: ANALYSIS_MAX_TOKENS, system: COMMIT_ANALYSIS_SYSTEM, messages: [{role: user, content: prompt}]})——调用一次,不重试（失败由 commitGate 接住改用模板分析、转人工）
      3. 取 resp 的文本块拼接,按 YAML 解析出 {summary, actions, recommendation}（容忍代码围栏）;直载失败时经 repairYamlScalars 修复后重载（解析点第 7 处,见 ^anc-exec-output-inline-colon-repair 清单）
      4. [条件(修复后仍解析失败,或 actions 不是列表)] 抛错 "安全分析输出无法解析:<前 200 字>"（commitGate 接住改用模板分析）
      5. actions 每项只取 line / callee / category / cited_lines / verdict / consequence 六个字段;verdict 不是 safe 也不是 human 的改为 human
      6. 返回 {summary, actions, recommendation, model: "<service_id>/<model>", source: model}（与引擎动作清单的对齐、模型不能降低风险由 engine.mergeAnalysis 负责,本函数不做）
    renderCommitAnalysisPrompt(
      request % CommitAnalysisRequest       # 引擎组好的分析材料
    ) -> prompt % text                      # 发给分析模型的 user 消息全文
      1. 段落依次为:任务目标、任务背景（narratives 每节标题+正文）、待提交步骤（步骤号/说明/不可逆动作描述）、本步之前的把关（gate_fact 一行）、body 原文（body_lines,每行带 spec 文件行号）、引擎动作清单
      2. 引擎动作清单每个动作一段 HopSchema 赋值形态:`- 第 <line> 行 <callee> % <category>  # 引擎判定 <risk>:<reason>`,其下缩进列 args 与 keep;清单为空写"（引擎没有找到有副作用的调用）"
      3. args 原样渲染引擎给的来源形态（字面量的值、"target(本步输入,运行时取值)"、"任务临时工作区里的 out.md"、"运行前无法确定"）——材料里没有某次运行的输入值,分析结论对这句 body 的每次运行都成立（[[exec-engine#^anc-exec-commit-action-facts]]）
```

```
HopSchema: CommitAnalyzerProvider
  # 分析用的服务;由组合根从独立模式配置取出
    - service_id % line          # 配置里的 service_id
    - protocol % line            # anthropic / openai-chat / openai-responses
    - base_url % line | null     # 服务端点地址;null=用协议客户端的缺省端点
    - api_key % line             # 已解引用的凭证值,只进客户端构造,不进日志与报文
    - auth % line | null         # bearer 或缺席
    - model % line               # 分析用的模型名,原样传给 client.create
```

**分析判据**（COMMIT_ANALYSIS_SYSTEM 的内容，写给分析模型）：分析模型的任务是对引擎列出的每个动作判断它是可逆或低危（safe），还是需要人确认（human），并用不懂代码的人能读懂的话写出后果。

- **safe 的范围**：新建文件、追加内容、新建目录；覆盖或删除前留存了旧版本（keep ≥1）的写入、移动、删除；只改动任务临时工作区的操作；备份轮转——改名或删除的对象是同一文件的旧备份，最新内容仍保留（category 写 rotation，cited_lines 列出构成轮转的几行）；其他不丢数据的数据操作（category 写 data_op）。
- **human 的范围**：不留旧版本的覆盖与删除——目标来自本步输入时，按"这个输入可能是任何文件"判断，不按某个具体文件名判断；影响范围运行前定不下来、又可能丢数据的动作；引擎判定为 human 的动作（外部命令、外部工具、通知）一律保持 human——这些动作的后果在 body 之外，读 body 判断不了。
- **consequence 的写法**：一两句大白话，说清做了什么、能不能找回、影响到哪里。不写代码、不写函数名；文件写路径——清单里给的是值就写值，给的是来源（"target(本步输入,运行时取值)"、"任务临时工作区里的 out.md"）就照来源写，"运行前无法确定"的照写，不推测具体值。
- **summary 与 recommendation**：summary 一句话说这一步整体在做什么；recommendation 一两句给人的建议（例如"确认目标目录里没有你手工改过、要保留的文件再批准"）。
- **输出格式**：一个 YAML 对象，字段 summary、actions（每项 line / callee / category / cited_lines / verdict / consequence）、recommendation。actions 按引擎清单逐项对应，不增不减。

- **为什么分析函数不复用执行路径的 resolveModel 与重试**：分析不属于任何步骤，没有 StepReady 可供路由；分析失败的正确去向是用模板转人工，不是重试到成功——重试会让一次网络抖动拖长停点，而人随时可以批。
- **ANALYSIS_MAX_TOKENS = 4096**：每个动作一段后果加整体建议，动作多的 body 超过 2048；思考档位不设（走服务缺省）。
- **不读文件**：分析材料里没有文件内容，凭证文件不可能经分析路径送出。


### 无超时语义【契约】 ^anc-exec-pause-timeout

**HopSpec/HopJIT 没有暂停超时概念**（作者定 2026-08-10，语言设计第一原则——彻底取消，非"暂缓实现"）：paused 是合法稳定状态、**永久有效**，caller 任何时候 resume 都继续；引擎绝不替 caller 做决策，放弃只能由人显式作出（confirm reject / 宿主删实例）。

取消理由：①超时自动处理（自动批准/自动采默认/自动放弃）无论哪种形态都在替 caller 决策，与 CITL 身份冲突且极易被心智误读酿成事故；②载体支撑不了——复用模式暂停=进程退出+状态落盘，无后台计时者，唯一可检查点是 resume 时，而 CC/Codex 的 resume 只发生在用户回来时（人已在场，超时无意义）；独立模式虽可做但单模式特有语义违背"两模式一致"原则；③普通人心智负担（"设了超时会发生什么"需要解释即是成本）。

- **实例终结归系统级 GC**：超期未完成的执行实例（含长期 paused）由部署层垃圾回收清理（`.hopstate/` 目录清理机制，属部署配置非语言语义）
- 勿混淆：`resource_limits.timeout_seconds` 是**单步 LLM 调用超时**（成本护栏第 4 条），与暂停等待无关

## impl resume_spec【说明】

```
# Spec: 恢复中断的执行
Id: resume_spec
Goal: 从暂停（CITL 决策注入）或崩溃中断点恢复执行

Inputs:
- instance_id % line  # 已有执行实例 ID
- step_id % line      # 暂停步骤 ID（CITL 恢复时必填，崩溃恢复为空）
- answer % yaml       # caller 决策（CITL 恢复时必填）

Outputs:
- result % yaml       # Spec 的 Outputs 变量集合
- status % line       # completed | failed | paused（再次暂停）

## Steps
1. [act] 从 PersistenceProvider 恢复引擎状态
  - ← instance_id
  > Engine 读取快照，重置悬空的 running 步骤为 pending（branch 特殊处理）

2. [branch] 按恢复类型分派
  2.1. [case] step_id 非空（CITL 恢复）
    2.1.1. [act] 注入 caller 决策
      - ← step_id, answer
      > confirm: answer 作为步骤输出注入；commit: 批准则执行不可逆操作后注入
  2.2. [case] default（崩溃恢复）
    2.2.1. [act] 无需注入，重置的步骤将重跑

3. [loop] 逐步执行直到完成/失败/再次暂停
  > 与 run_spec 主循环相同——复用同一执行循环逻辑
```

---

## 独立模式 call 递归【契约】 ^anc-exec-call-recursion

由概念层双模式定义推演（执行能力归属决定执行者，[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）：独立模式执行能力在引擎侧，call 的子 spec 执行由 Dispatcher **嵌套递归**完成——复用模式由 CC 建子实例驱动，本节是独立模式的对应实装契约。confirm 上升语义对齐概念 [[../concepts/HopSpec V3核心规范#^anc-exec-call-escalation]]。

**call 工具决议（#49,概念权威 ^anc-step-call 扩义——2026-08-25 作者定"工具应该可以被 call"）** ^anc-exec-call-tool：handleCallStep 的 callee 名决议改两段——**先查 SpecProvider**（命中=子 spec,走下方既有递归契约零变化）;**未命中再查 ToolProvider.list()**（按 name 或 tool_id 命中=工具 call,走退化形态）;两边都不中才 fail UNKNOWN_SPEC（报文改"未解析到 spec 或工具 '<id>'"）。工具 call 退化形态：

- **执行**=单次 `ToolProvider.execute(name, 求值后的映射实参)`——param_mapping 经 resolveCallParams 求值（变量项按父变量空间取,字面量项直传——[[spec-ast#^anc-step-call-literal]]）,to=注册面参数名;无子实例、无递归深度消耗、无 callFrames 帧;
- **结果回填（review D5 收窄 2026-08-25）**=响应按 output_mapping 落父变量,两条合法路径——①响应为对象且 `from` 是其字段:取字段值;②响应为标量且**恰单条映射**:整值直落（唯一合法兜底形态）。
  - 其余形态（对象响应字段 miss——from 名打错;标量响应配多映射）**响亮 failStep 点名可用字段**,不整值灌错值（原实现字段 miss 时整对象兜底落变量,同值重复灌多变量零报错——灌错值温床）;
  - output_schema 在场照 ^anc-exec-tool-shape-check 双端校验,偏差=步骤 fail 入既有升级阶梯;
- **requires_commit 语境拦截**：call 步骤位与 act 同权——requires_commit=true 的工具在 call 位拒绝（COMMIT_REQUIRED 报文指路"包进 commit 步骤的 body 调用"）;概念层"call 位同受 act 语境拦截"的落点;
- **重试语义（v1,review D9 对齐现状）**：工具 call 结果经 completeStep 落变量后步骤 done——容器重试时本步整步重跑=重调工具（与"act 可安全重做"同约:requires_commit 工具已被本位拦截,可重调面全部无不可逆副作用）;body 工具调用式的 journal 逐调用重放**不适用本形态**（那是步内多调用的中断续跑机制,本形态单调用即完成无中断窗口）;
- **复用模式对应（待落,review D3 挂账 [[todo/0027_工具一等公民三件_open|0027 四件余账]]）**：目标形态=CLI 通道 call 步骤对工具 callee 吐 tool_request（caller 执行后 --tool-result 交回）,不吐 call_protocol。
  - **现状未实装**——CLI 通道对 call 步仍一律吐 call_protocol（工具名会进 callee 占位）,engine done 通道明文拒 call 步用 --tool-result;
  - 复用模式暂不支持工具 callee（写 spec 时工具调用用 act body 形态,双模式等价）。

## call callee 位插值解引用【契约】 ^anc-step-call-dynamic-callee

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-call]] 插值条款。作者三拍（2026-09-05,todo/0066 三拍原话全文在卡）：
- "run_spec(spec_path, params) -- 这个不就是call么"——定性动态派发是 call 的晚绑定形态不另造工具;
- "{}在hopspec中主要就是fstring语义，那就可以简化，直接用{analyzer_spec}"——拍定 callee 位直接花括号无引号壳;
- "重要的还是给llm引导，让其明白，用call工具起类似subagent的作用"——定知识供给半边并重。

**缘起**：standalone 与复用模式派发能力不对等——产物 spec 要"探索后对每类对象各起一个子任务"时,复用模式有 Task 工具,standalone 执行 LLM 零派发能力;原方案 run_spec 工具被作者点破是 call 的重复发明（配额闸/收割/把关全要重造,且把派发权整个交给 act free 的 LLM）。

**正形=callee 位晚绑定**：**结构管次数（调用点钉在步骤树上,单 call 一次/for-each 几个元素几次）、变量管对象（LLM 只能定"调谁"不能定"调几次"）**——费用失控面天然消失,收割/兜底/parallel 全复用既有链路。

**能力契约（HopSpec 契约）**：

```
# Spec: call callee 位插值解引用
Goal: `[call {表达式}(映射)]` 执行期把表达式求值成 spec Id,再走与静态 Id 完全相同的 call 链路——晚绑定只改"何时知道调谁",不改调用语义的任何一环
Constraints:
- 求值器与 f-string 同源（evalExprSync + 引擎变量空间 readVar 闭包）——表达式能力面全集（裸变量/字段取/下标）,不另开子集
- 求值结果必须是非空字符串——空值/None/对象/数字一律按解引用失败处置（callee 是标识符不是文本:对象值=上游产出形态错,响亮报错点名表达式原文与实际求值结果,不做 formatFStringValue 的对象转 JSON 静默兜底）
- 解引用成功后走完全既有链路：SpecProvider→ToolProvider 两段决议/参数过 callee Inputs 校验/子实例/独立把关/续链收割/失败单跳摘要/parallel——零新执行机制,晚绑定对下游不可见
- 寻址政策零开口：求值结果走与静态 Id 同一 provider.resolve 通道——DirSpecProvider 拒 / 与 .. 的防穿越政策自然沿用;概念层"Id 或路径"的路径含义归 provider 政策（换支持路径的 provider 即支持）,引擎不为路径形态开新分支
- 三消费点同改,一处不漏：同步 handleCallStep / parallel launchParallelCallChild / 复用模式命令拼装（engine 侧三处——dispatch_ready launch_command / buildCallProtocol init_command / buildStaleLaunch 重拼,均经 calleePathToken 填解析出的路径、解析不到留 <CALLEE_SPEC_PATH:id> 占位,[[exec-engine#^anc-exec-callee-resolver]]——漏改则 {表达式} 原文漏进命令静默失败）
- 解引用失败（求值异常/非字符串/空串）= 步骤失败带明细（表达式原文+求值结果）进既有升级阶梯,与 UNKNOWN_SPEC 同款处置,不静默
- 解引用失败的形态分模式:独立模式（dispatcher 两消费点）=步骤失败响亮报带明细;复用模式（engine 三拼装点）=warn 落账+载荷缺席（buildCallProtocol 整包不拼）或空占位（dispatch_ready/staleLaunch 的 `<CALLEE_SPEC_PATH:>`）——nextStep 途中不宜 failStep 的结构限制,失败最终在 worker 侧响亮（launchParallelCallChild 已先报）;两形态都不让 {表达式} 原文漏进命令
```

**类型约定（HopType）**：

- `callee_expr_src: string`——表达式原文存留,两个消费点:serializer 原样回写 `{原文}` 往返一致/解引用失败报错回显原文（callee_expr 是解析后 AST 无法反推原文,伴生字段是唯一原文来源）

**HopSop（resolveCalleeId 公共件,三消费点共用）**：

```
resolveCalleeId(node, readVar):
1. [branch] 按字段形态分派
  1.1. [case(callee_spec_id 在场)] 直接返回（静态形态,零行为变化——存量零回归）
  1.2. [case(callee_expr 在场)] evalExprSync(callee_expr, readVar) 求值
    1.2.1. [check] 结果为非空字符串 → 返回;否则抛解引用失败（明细:表达式原文+typeof+值预览）
2. 调用方拿返回值走既有决议链（先 SpecProvider 后 ToolProvider,两不中 UNKNOWN_SPEC）
```

**知识供给半边（与文法半边并重,作者定"如何用要描述清楚"）**：
- executor 教学落 L0 worldview（收链实证现状为零）——L0 叶子类型枚举行的 call 半句扩为完整心智模型:call 步骤引擎自动执行=派发独立子实例〔相当于 subagent:独立上下文/自带把关/产物自动收回〕;探索步为后续 call 备清单=每项含 callee 标识与参数,派发/等待/收割全归引擎;禁止自己在上下文里逐个扮演子任务——上下文污染/撞窗口/零并行三致命伤;
- 落 L0 依据:全程恒定的世界观知识,L0 恒定化后加在稳定块零 cache 代价;
- 构建器判据落 split-patterns call 主节（何时用:生成期能枚举恒静态 Id,连调谁都要现场定才插值;正反例并排）;
- 教学面验收判据：零先验执行 LLM 读完能答对三问——派发谁做/我产出什么/为什么不能自己扮演。

**正反例**：`[call {issue.analyzer_spec}(problem: issue.kind) parallel]` 求值 "security-analyzer" → 派发该 spec 子实例（正）/求值结果为对象 → 步骤失败点名"callee 表达式求值结果非字符串"（反）/求值出 "no-such-spec" → UNKNOWN_SPEC 与拼错静态 Id 同款（反）/静态 Id spec 全量测试零回归（正）/S12/S16 对插值形态照常判定（正——判定材料不含 callee 字段,收链实证）。

**能力契约**（HopSpec 契约）：

```
# Spec: 独立模式执行 call 步骤
Goal: 解析 callee spec 并嵌套执行，把子 Outputs 按映射回填父变量；子层 confirm/ask 直达顶层 caller
Inputs:
- call_step % CallStep         # callee_spec_id + param_mapping/output_mapping
- call_depth % number          # 本帧深度（顶层 run 为 0）
Outputs:
- step_result % yaml           # 子 Outputs 映射回父的变量集，或暂停信号
Constraints:
- 无 SpecProvider 或 resolve 返回 null → fail UNKNOWN_SPEC（不猜路径）
- call_depth ≥ max_call_depth（缺省 10，resource_limits.max_call_depth 覆盖）→ fail DEPTH_EXCEEDED，不建子实例
- 子实例变量空间与父完全隔离，仅经 param_mapping/output_mapping 传递
- 子失败时 FailRecord 内核原封加壳为 CalleeFailure（不自由文本转述），fail_kind 跨界继承
- **call 边界反馈传递（D41,2026-08-23 作者点破"L2c 的本质是 call 的 fail 原因没有反馈"）**：
  call 步位于重试容器内且父层有重试反馈（getActiveRetryFeedback(call步id) 非空）时,反馈文本
  经 EngineOptions.upstreamFeedback 传入子实例——子实例 PromptAssembler 渲染为 L5 修正指令的
  "上游修正意见"条目,子 spec 除 check/commit 外全部步骤可见（受众分道,H1）;**递归下传**（子再 call 孙时,孙收到的 upstreamFeedback = 子自身
  重试反馈与父传入反馈的拼接;体量纪律=当前打回意见零截断/历史行单条 4000/累积保护线 24000
  尾部截留,权威见 [[prompt-assembler#^anc-exec-l2c-retry-feedback]] L6 上游反馈条——衰减靠
  保护线,不靠层数硬砍）。
  病根（dr8 实撞）：call 不经 PromptAssembler（递归 runSpec）,L2c 只作用于 prompt 装配层——
  父层重试反馈对 call 子树完全不可见:外层意见轮重跑时,真正干重拆活的 call 子实例是全新引擎,
  作者修订意见一个字都看不见,分层与跨层 L2c 都只喂到父 spec 自己的步骤为止。
  **复用模式半边（H2,2026-08-31 作者拍 A 案——三路排查抓 D41 只实装 standalone:复用模式的
  call 走 call_protocol,driver 照抄 init_command 另起进程,该命令原先不带反馈载荷,CLI init 也
  无接收选项——父层打回 call 重跑时重建子实例对修订意见全盲,dr8 病复用模式仍活）**：
  buildCallProtocol 拼 init_command 时读父层当前反馈（getActiveRetryFeedback(call步id),与
  standalone 同源）,非空即追加 \`--upstream-feedback <JSON双层引文本>\`（转义纪律同 params 先例）;
  **载荷构成与 standalone 同构**（2026-09-01 review 面二抓两模式分叉后补定——原实装只拼当轮
  fb.reason,丢此前打回历史行,callee 多轮打回场景看不到"此前已被打回过的意见"）:拼接内容=
  inherited（父传入的 upstreamFeedback）+ prior 历史行（单条 4000 clip,"第 N 次打回："前缀）
  + 当前 reason（零截断）,拼后累积 24000 chars 尾部截留——与 dispatcher.buildCallUpstreamFeedback
  同一构成同一体量纪律（复用即同构:两模式经同一公共体拼装,不许各写一份判法）;
  CLI init 加对应选项转 EngineOptions.upstreamFeedback——两模式汇入同一注入口,下游（L5 条目
  渲染/check·commit 掐口/24000 保护线）自动生效,driver 照抄零改动。选型记录:B 案文件通道
  （calls/<ci>/upstream.txt 约定自读）因新增文件约定与清理/恢复一致性面被否——作者定"反馈
  意见不会那么大",命令行参数走 params 同款转义即可;C 案塞 params 保留键与命名空间防御口径
  冲突,列出即否。**注入时点=重跑轮的 init**（首跑无反馈不带参;协议命令是吐 step_ready 时
  现拼的——每次父层 nextStep 到该 call 步都重拼,重跑轮拼进当轮反馈,时效天然正确）。
  **parallel 标注的 call 子实例同样接收父的上游反馈**（2026-10-11 todo/0165 补句——此前本条只写了串行 call 形态）：
  launchParallelCallChild 建子引擎时按派发步骤号（dispatch_ready 载荷的 step_id）调同一个
  buildCallUpstreamFeedback,拼出的文本经同一个 EngineOptions.upstreamFeedback 传入子实例——与串行
  executeCall 同源同构,载荷构成与体量纪律不另立一套;父层无重试史且自身无祖辈反馈时不传该键
  （子实例零注入,与串行形态同判）。
```

**类型约定**（HopType）：

- `CallFrame`——挂起的子调用帧，父 Dispatcher 持有：
  - `dispatcher: StepDispatcher`——子 spec 的嵌套 Dispatcher 实例（子引擎经它驱动）
  - `engine: ExecutionEngine`——子执行实例（**状态落盘随父**,2026-08-29 作者定"为啥不落盘"四坑裁决,详见下方"子实例状态落盘"条款;`parentInstanceId`/`callStepId` 照复用模式子实例约定）
  - `reported_tokens: number`——已计入父累计的子 token 数（增量记账防跨 resume 重复计）
- `StepDispatcher` 新增字段：
  - `callFrames: Map<string, CallFrame>`——call_step_id → 暂停中的子帧（子终态即删；仅 paused 的帧存活）
  - `activeCallChildren: Map<string, StepDispatcher>`——call_step_id → **执行中的**串行 call 子 dispatcher（进 `await 子 runSpec()` 前登记、结算时注销；requestAbortCascade 的第三张遍历表——callFrames 只收暂停帧，执行期子层无此表则级联够不着）
  - `callDepth: number`——本 Dispatcher 的调用深度（构造入参，顶层 0，子帧 = 父+1）
- `ExecutionPaused` 增可选字段 `call_path?: string[]`——暂停帧的调用链（从顶层 call step_id 到暂停 spec 的直接父 call，顶层暂停时缺省）。caller 决策注入时原样带回，runtime 据此直达挂起帧——概念层"完整调用链 step_id 为 key 直达有权决策者"的落点
- `DispatcherConfig` 增 `callDepth?: number`（内部递归用，宿主不设）
- `DirSpecProvider`（出口 `dispatcher.ts`）——缺省 SpecProvider（决策与寻址规则见 [[shared-providers#^anc-provider-spec-default]]）：构造入参 = `(基准目录, roots?)`（roots 是两级 HopAnt 根 AntRoots,2026-10-10 todo/0155 起;缺席只查同目录）；`pathOf(id)` = `resolveCalleeSpecPath(基准目录, roots ?? null, id)`（[[hopant#^anc-hopant-callee-resolve]]——先 `<基准目录>/<id>.md`，再 `<roots.project>/<id>/<id>.md`，再 `<roots.user>/<id>/<id>.md`；id 含 `/`、`\` 或 `..` 直接返回 null 防穿越）；`resolve(id)` = pathOf 命中则读该文件，否则 null

**子实例状态落盘（2026-08-29 作者定"为啥不落盘,可能比较大啊"——原 MemoryPersistence 缺省的翻案）** ^anc-exec-call-child-persist：

原设计"Dispatcher 驱动完整生命周期,无需跨进程"的推理只在"进程永不死、中间不停顿"的假设下成立——假设破了,四坑实存：
- ①deflate 大值卸载无 work_zone（子实例大产出全量占内存+全量内联 prompt 双重放大——作者点破的正是这坑）;
- ②子实例内 confirm/ask/escalate 暂停卡不落盘,server 重启即蒸发（MCP 0028 detach 恢复只救顶层）;
- ③崩溃后父可 resume 子实例从零重跑白烧钱;
- ④最重:子实例已执行 commit 后崩溃,退火标记（committed_steps）随内存死,resume 重跑=commit 重放——复用模式靠子盘上 state.json 传播退火（^anc-exec-commit-anneal 三形态传播）,standalone 子实例无盘此防线整个不存在。

行为契约（逐条,验证面）：

1. **落盘判据=父有则子有**：父引擎 instanceDir 非空 → 子引擎 stateDir=`<父instanceDir>/calls`（FilePersistence 使子实例落 `calls/<子实例ID>/`——与复用模式 init --parent 的目录布局完全同构,零新布局）;子实例 ID 由引擎 serialCallChildInstance 算出（不在 loop 里=call 步骤号,在 loop 里带各层轮次后缀,见 [[exec-engine#^anc-exec-call-child-iter-id]]——两模式同一个方法,loop 各轮子实例目录互不删除）;**parallel 标注的 call 子实例同落 `calls/<子实例ID>/`,子实例 ID 由引擎 dispatchParallelCall 算出**＝`<call 步骤号>.<轮次>`——轮次取最近一层 loop 祖先的当前轮次,无 loop 祖先时恒为 1（兄弟位每个 call 步骤号唯一,不撞）;launchParallelCallChild 把 dispatch_ready 载荷里的 child_instance 原样作子引擎的 callStepId,stateDir 同样是 `<父instanceDir>/calls`,卫星日志目录 `calls/<子实例ID>/log`（2026-10-11 todo/0165 补句,目录布局权威仍是 [[exec-engine#^anc-exec-parallel-subinstance]] 的两命名空间表）;父 instanceDir 为空（纯内存宿主:测试/程序内嵌入——"无跨进程"假设在该场景真成立）→ 子随纯内存,现状形态保留;
2. **parallel worker 子实例同判据**（launchParallelSubtask 同改——stateDir=`<父instanceDir>/parallel`,子落 `parallel/<childId>/`,与复用模式 worker 布局同构）;
3. **四坑随落盘自然平**：work_zone 由 FilePersistence.init 建（deflate 通）;暂停卡 writePausedCard 落盘（跨进程可恢复);退火标记随 state.json 持久（^anc-exec-commit-anneal 的子盘读取路径 standalone 从此走通）;escalateCardMemo 内存副本退化为纯内存宿主的兜底（落盘形态盘卡恒在）;
4. **深度嵌套自然成立**：孙 call 的父是子实例（有 instanceDir）→ 孙落 `calls/<child>/calls/<grand>/`——目录层级即调用链,与复用模式 call-depth 检查的"calls/ 祖先数"判据同一物理量。

**关键逻辑**（HopSop）：

```
executeCall(call_step):
1. [条件(depth ≥ 上限)] fail DEPTH_EXCEEDED，返回
2. [act] spec_provider.resolve(callee_spec_id) → null 则 fail UNKNOWN_SPEC，返回
3. [act] 解析+校验子 spec（parseSpec/validateSpec，error 即 fail VALIDATION_ERROR）
4. [act] 按 param_mapping 从父 vars 取值构造子 Inputs（from=父变量, to=子 Input 名；无映射项按同名取）
5. [act] 子实例 ID = engine.serialCallChildInstance(call_step_id)（loop 里带轮次后缀,^anc-exec-call-child-iter-id）
   建子引擎（**状态落盘随父**:父有 instanceDir → stateDir=<父instanceDir>/calls,子落 calls/<子实例ID>/——与复用模式子实例同布局;父纯内存 → 子随纯内存〔见"子实例状态落盘"条款〕;+ parentInstanceId/callStepId=子实例ID + 父 hoplog 卫星目录 calls/<子实例ID>/log）
   帧表键（callFrames/activeCallChildren/call_path）恒用 call_step_id——寻址的是步骤不是目录
   与子 Dispatcher（callDepth=父+1；tokenBudget=父剩余预算）
6. 调用子 dispatcher.runSpec() 递归执行
7. [branch] 按子 RunResult 分派：
   [条件(completed)] 父引擎 completeCallStep(callStepId, 子 vars) 按 output_mapping 回填 → 帧销毁
   [条件(failed)]    父引擎 failCallStep(callStepId, 子状态) 组装 CalleeFailure → 帧销毁 → 父升级链照常
   [条件(paused)]    帧存入 callFrames；子 pause 的 call_path 头部插入本 call_step_id 后
                     作为父的 pendingPause 上抛——逐帧挂起、暂停信号直达顶层 caller
8. [act] 父累计 tokens += 子新增（reported_tokens 增量记账）

resume(stepId, answer, call_path?):
1. [条件(call_path 非空)] 取 callFrames[call_path[0]]，剥头递归 frame.dispatcher.resume(...)
   → 子帧回到步骤 7 分派（completed/failed 则收帧回填/失败，paused 则重新挂起）
2. [条件(其他)] 本层暂停步骤，照既有 confirm/ask 注入逻辑
```

**与复用模式的对称**：两模式的子实例形态、id（同一个 serialCallChildInstance 算出,loop 里带轮次后缀）、输出回填（completeCallStep）、失败通道（failCallStep/CalleeFailure）完全同一套引擎 API——差别仅在"谁驱动子实例"（CC 起子进程链 vs Dispatcher 嵌套递归）;状态介质自子实例落盘批（^anc-exec-call-child-persist）起两模式同判据——父有 instanceDir 子落盘,父纯内存子随之。confirm 上升在复用模式天然到顶（CC 全程驱动），在独立模式经 call_path 直达——同一概念锚点两种落法。

> **实装状态（2026-08-10）**：随 v2-1 实装（[[roadmap#v2-1 独立模式（引擎自驱）]]，DEBT-04（已销,盘点见 [[todo/0028_call-能力盘点与剩余缺口_open|0028]]） 项 3）。engine 侧 Inputs 自动映射与运行时 depth 检查见 [[exec-engine]] Call 执行模型（两模式共用）。

---

## 子实例 HITL 队列（dispatcher 侧机制）【契约】 ^anc-exec-parallel-hitl-queue-dispatch

> 语义权威=[[parallel-execution#^anc-exec-parallel-hitl-queue]]（U4b 六件套,2026-08-25 作者拍板 A）。本节只登 dispatcher 侧机制件：

- **队列结构**：`pausedChildren: Map<child_instance, { pause: ExecutionPaused; dispatcher: StepDispatcher; engine: ExecutionEngine; kind: 'subtask'|'call'; calleeId?: string }>`——条目五字段：`pause` 是停点载荷（续跑时回填 question/context 用）、`dispatcher` 是子 dispatcher 句柄（续跑直接 resume）、`engine` 是子引擎句柄（续跑后收割时读子变量表 / 失败态 / committed 标记,commit 停点时读批准账 fingerprint,杀活连坐时 removePausedCard 删子卡;对外 getPausedChildren 只暴露 pause+engine 两字段）、`kind` 区分 parallel 子任务与 call 子实例（终态收割走 reapParallelSubtask 还是 reapParallelCall）、`calleeId` 仅 call 形态有值（被调 spec 的 id;入队时记下,现行代码只存不读,留作诊断面）。子 dispatcher 句柄存活等应答（与 callFrames 同哲学:挂起帧不销毁）;（2026-10-11 语义审计 0156 C3 补齐:此前只写 pause/dispatcher/kind 三字段）
- **入队点**：launchParallelSubtask/launchParallelCallChild 的 worker 终态回调 `r.status === 'paused'` 分支——原 PARALLEL_HITL_TODO 判 failed 退役:改 `engine.markInflightPaused(child)`（账 inflight→paused 让名额）+入队,**不 reap**（子实例未终态）;子引擎盘上问题卡保留（0028 契约,35 轮临时清卡撤）;
- **应答路由**：`resume(stepId, answer, callPath, childInstance?)` 第四参——携 childInstance 时从 pausedChildren 取句柄:`engine.markInflightResumed(child)`（paused→inflight 二次占名额;名额满等空位）→ 子 dispatcher.resume(stepId, answer) → 终态照常 reap、仍 paused（多暂停点）更新队列;
  - 实装落点（2026-10-11 语义审计 0156 B1 补——此前"名额满等空位"只写在条款里,代码续跑处直接 resume 不查名额）：续跑之前、还没把卡从 pausedChildren 摘下之时,按 launchParallelSubtask 同款 `while (!engine.hasFreeSlot() && inflightPromises.size > 0) await Promise.race(inflightPromises.values())` 等到有空位;等完再 delete 卡 + markInflightResumed + resume。先等后摘卡的顺序是必要的：等待期间若另一张卡被答,它看队列仍能看到本卡在等,不会误判成"队列里没这张卡"。续跑中的子 promise 同时登进 inflightPromises（跑完即删）——下一张卡的等待循环靠这张表判"进程内有没有在飞句柄",不登记则账上 inflight 而表为空,循环条件不成立直接放行,照样超员。
- **executionLoop 等待面**：drain_wait 的"无在飞句柄防死循环"判据改为"无 inflight 句柄**且无 paused 队列**"——只剩等人时不判 failed,返回 paused（队首卡+run 级 paused 语义,主线让位等人）;
- **杀活连坐**：requestAbortCascade 与主线失败杀活遍历 pausedChildren——子 dispatcher abort+子引擎 removePausedCard+账记 killed+出队。
  - 实装落点（2026-10-11 语义审计 0156 B3 补——此前 requestAbortCascade 做了前三件,"账记 killed"只在主线失败路径经 `engine.killInflight` 发生,stop_run 路径不经它,父 inflight 账上该子仍是 paused）：requestAbortCascade 遍历完四张在飞表后调 `engine.killInflight()`（无 scope=整个实例在飞与 paused 全杀——级联中止本就是整棵树,不按容器收窄）;killInflight 自带 commit 退火传播与 hoplog `parallel_kill` 留痕,不另写记账口。

## 独立模式真并行【契约】 ^anc-exec-standalone-parallel

由 [[exec-engine]] 决策 4（渐进升维）的 v2-1 档推演：独立模式复用引擎同一套并行三机制（批收集/worker 隔离/单点 join），并发原语选**进程内 Promise 池**——独立模式执行能力全在引擎侧，无需子进程/文件介质。S12（children 无数据依赖）保证与顺序模拟结果等价。

**worker 共享父 ToolProvider**（hopissues/0021,2026-08-20）：四个 worker 构造位点（fan-out 派发/同步退化/call 递归/call 帧恢复）经 `DispatcherConfig.sharedToolProvider` 注入父 provider——worker 持同一引用零新建零 spawn。
- provider 生命周期归顶层三收点（mcp-server applyResult 终态/failed-via-throw/resume-catch）;
- 工具面同源（同一 hostConfig）共享安全;未注入照旧自建（顶层/宿主直构语义不变）。
- **实撞出处**：原每 worker 构造自建 CompositeToolProvider——含 stdio mcp 成员时各 spawn 独立子进程且 close 三收点只收顶层,worker 的无人收;hopkb 实撞一天批量验证后 218 僵尸进程×600MB≈6.8GB;
- **已知轻微面（记档不修）**：共享 provider 的 warnSink 闭包捕获父 pendingToolWarns——worker 执行期的装配 warn 堆进父暂存,随父下一步落账（挂错步但留痕在,warn 是横切诊断非步骤归因;修=per-call warn 上下文,复杂度不值当前收益）。派生视图同样共用这个 warn 汇,局限不变。

**例外条款：per_parallel_child 打开的工具 server 在并行子任务里独占进程**（todo/0112,2026-09-25;字段语义权威 [[tool-interface#^anc-config-tool-registry]]）。
- **为什么**：共享一个进程对无状态 server 是对的（0021 的出发点）,但 playwright 这类 server 的进程自带"当前页面"这种会话状态——5 个并行子任务共用一个进程时页面串台、报"Browser is already in use"。实验证实只有一个子任务一个进程才各自拿到正确页面;
- **派生**：三个并行注入点——过期子实例重建（reconcileAndRebuild）、并行子任务（launchParallelSubtask）、并行 call 子实例（launchParallelCallChild）——注入的不再直接是 `this.toolProvider`,而是它的 `forkForParallelChild()` 结果。注册表里没有任何打开开关的 server 时,这个结果就是父的同一个对象（开关全关时与 0021 行为逐字节相同）;有的话是一个派生视图——开关打开的 server 换成新成员实例（懒连接,第一次调用才起进程）,其余成员与父共用;
- **串行 call 不派生**：executeCall 的注入点照旧传 `this.toolProvider`。顶层的串行 call 因此与顶层共用进程;并行子任务内部的串行 call 拿到的是该子任务自己的派生视图,自然用该子任务的进程;
- **关闭时机**（派生视图的 `closeOwned()`——只关派生视图自己新建的成员,父的成员一个不碰;父视图就是自身时不调用）：
  1. 并行子任务非暂停收场（completed / failed / runSpec 抛异常）→ 关;
  2. 并行子任务停在人工确认或提问点（paused）→ 不关,子 Dispatcher 连同它的派生视图挂进 pausedChildren,等人回答期间浏览器页面与登录态都在;
  3. 暂停的子任务经 resume 恢复后 completed 或 failed → 关;恢复后停在下一个暂停点 → 不关;恢复应答被拒（留在队列里）→ 不关;
  4. 中止级联（requestAbortCascade）遍历暂停中的子任务时 → 关;
  5. 在飞子任务因主线失败被杀 → 协作式中止,子任务自己的 runSpec 返回后走第 1 条关;
  6. 兜底：顶层工具面 close()（mcp-server 三收点）连带关掉所有还没关的派生视图——覆盖主线失败时暂停中的子任务等走不到上面各条的路径;
- **与 0021 不矛盾**：子任务仍不自建整套工具面（内置文件工具、通知、宿主注入、开关关闭的 server 仍是父的同一实例）;新建的只有开关打开的那几个 server 成员,而且每个都有明确的关闭点——0021 的僵尸进程病根是"建了没人关",这里建一个关一个。

**能力契约**（HopSpec 契约）：

```
# Spec: 独立模式执行 parallel 批
Goal: 把 nextParallelBatch 吐出的 children 并发执行（各自内存态子引擎），全部终态后 joinParallel 合并回父
Inputs:
- batch % ParallelReady        # 引擎批量吐出的就绪 children（已排除含 confirm/ask 子树）
Outputs:
- join_result % yaml           # joinParallel 合并结果（收集列表/同名提升落父变量空间）
Constraints:
- 并发窗口 ≤ max_concurrent_workers（缺省 5）——超出的 children 排队，任一完成即补位
- 失败 child 不阻塞兄弟（全部跑到终态才 join；失败不贡献收集元素——列表变短，2026-08-09 定稿）
- worker 子引擎内 can_fanout=false（嵌套 parallel 退化串行，一层并行原则）
- worker 内暂停点不可能出现（引擎批收集已结构性排除含 confirm/ask 子树，^anc-exec-parallel-confirm-exclude）
```

**类型约定**（HopType）：无新公共类型——复用 `ParallelReady`/`ParallelChildSpec`（cli-types）与引擎 `joinParallel` 入参形状 `Record<child_id, { vars, failed, log? }>`。Dispatcher 内部件：

- `runParallelBatch(batch)`——私有方法，Promise 窗口池调度器（见下方流程）
- worker 子引擎构造：`initExecution(父spec原文, hostConfig, { params: child.params_for_child, subtreeRoot: child_step_id, parentInstanceId, callStepId: child_step_id, traceId: 父 instanceId, logDir: 父卫星 parallel/<cid>/log })`
  - **状态落盘随父**（父有 instanceDir → stateDir=`<父instanceDir>/parallel`,子落 `parallel/<childId>/`;父纯内存 → 子随之——^anc-exec-call-child-persist 契约条 2）、`canFanout` 不置（false，嵌套退化串行）;
  - **spec 源=引擎留存的原文 `getRawSource()`，禁用 `serializeSpec` 重建**——序列化按设计单向有损（[[spec-parser]] 关键决策 4：body 围栏、parallel 属性等不保证保留），拿它重建 worker 源=语义静默丢失（实撞：act body 丢失 → worker 走 LLM 循环悬挂）;
  - 引擎为此在 init 留存 spec 原文（内存字段，见 [[exec-engine]]），worker/replan 后源以 AST 持久化的 spec.json 为准不受影响
- worker 子 Dispatcher：继承父 hostConfig；`callDepth` 继承父值（parallel 不是 call，不加深）；token 记账并入父累计

**关键逻辑**（HopSop）：

```
executionLoop 增一介入点分派:
[条件(engine.advanceToCaller 返回 parallel_ready)] runParallelBatch(batch) → 回主循环

runParallelBatch(batch):
1. [act] 置窗口 = min(max_concurrent, children 数)；结果槽 childResults = {}
2. [loop for-each child in batch.children, 窗口池并发]  # Promise 池:任一 settle 即补位
   2.1. [act] 建 worker 子引擎（上方类型约定的构造参数;**状态落盘随父**:父有 instanceDir →
        stateDir=<父instanceDir>/parallel 子落 parallel/<childId>/,父纯内存 → 子随之——与
        executeCall 第 5 步同判据〔^anc-exec-call-child-persist〕）+ 子 Dispatcher
   2.2. 调用子 dispatcher.runSpec()
   2.3. [act] childResults[cid] = { vars: 子引擎全变量, failed: status != completed }
        > 子引擎抛异常同 failed（fail 即异常,不静默吞——异常文本记入父 hoplog warn）
3. [act] engine.joinParallel(batch.parallel_step_id, childResults) → 合并回父变量空间
4. [act] 父累计 tokens += Σ 各 worker 消耗
```

**与复用模式的对称**：批收集（`nextParallelBatch`）、暂停点排除、join merge（`joinParallel`）全是同一套引擎 API；差别仅在 worker 载体（CC subagent 子进程 ↔ 进程内 Promise）。
- 状态介质自子实例落盘批次（^anc-exec-call-child-persist）起两模式同布局——父有 instanceDir 时 standalone worker 同落 `parallel/<childId>/`,父纯内存才走 MemoryPersistence;
- `can_fanout` 语义相同：顶层 Dispatcher 的引擎置 true 以启用 `advanceToCaller` 的 fan-out 探测，worker 子引擎不置。

> **实装状态（2026-08-10）**：随 v2-1 实装。dispatcher `executionLoop` 增 `parallel_ready` 分派 + `runParallelBatch` 窗口池；引擎侧零改动（三机制 v2 复用模式已备）。原"独立模式保持顺序模拟"（决策 4 v2 档注记）随本节作废。

```
# Spec: 执行单个步骤
Id: execute_step
Goal: 根据步骤类型分派执行，返回步骤输出

Inputs:
- next_resp % yaml  # StepReady（来自 hopjit debug_step，status = 'step_ready'）

Outputs:
- step_result % yaml  # 步骤输出变量，结构符合 next_resp.context.output_schema

## Steps
1. [branch] 按 next_resp.step_type 分派
  + → step_result

  1.1. [case] step_type = reason
    1.1.1. [reason] 按组装好的上下文推理
      - ← next_resp
      + → step_result
      > 构造 API 请求：system = HopSpec 任务描述，messages = [AssembledContext 6 层]
      > 输出必须符合 next_resp.context.output_schema 结构
      > output_schema 自动追加可选字段：lack_of_info: text（信息不足时填写缺失内容描述）
      > LLM 返回 lack_of_info 非空时，走知识补充路径（见下方 lack_of_info 处理）

  1.2. [case] step_type = act
    1.2.1. [act] 执行确定性操作
      - ← next_resp
      + → step_result
      > 构造 API 请求，附带 tool_use（通过 ToolProvider.list() 获取可用工具定义）
      > 根据 next_resp.context.instruction 中的执行说明调用对应工具
      > 工具调用通过 ToolProvider.execute()，受 SandboxConfig 约束（act 不走 authorize）

  1.3. [case] step_type = check
    1.3.1. [check] 验证产出是否满足预期
      - ← next_resp
      + → step_result
      > 构造 API 请求，传入验证上下文，LLM 产出 check 固定签名输出：bool 判定槽 + text 说明槽。
      > **判定不在此处做**——dispatcher 把产出原样交 `completeStep`，由引擎按 bool 槽判通过/失败
      > （[[exec-engine#^anc-exec-check-verdict]]）：false → failStep 接升级阶梯（首次带反馈重跑、再 adaptive）。
      > dispatcher 不重复判定（模式无关，复用模式 CLI done 与独立模式共用 completeStep 一处判定）。

  1.4. [case] step_type = confirm
    1.4.1. [confirm] 请求人工确认
      - ← next_resp
      + → step_result
      > 输出 HITL 暂停信号 JSON，含待确认数据和可选回复项
      > 调用方呈现暂停信号给用户 → 用户回复 → hopjit submit_and_fetch_next 注入答案 → 引擎继续

  1.5. [case] step_type = commit
    1.5.1. [act] 执行不可逆操作
      - ← next_resp
      + → step_result
      > 先过批准关卡（[[exec-engine#^anc-exec-commit-approval]]）:body 的动作全部可逆或低危 → 直接继续;否则查账,未批准且没分析过 → 交模型做安全分析,判安全则记账继续;需要人确认 → 输出暂停信号（pause_reason=commit,带 fingerprint、大白话安全分析、body 原文与三个选项）并落卡,不执行
      > 已批准 → 执行 body;每次 run 的授权由 Spec 作者在 commit 前放置 check final 或 confirm 保证（P8）
      > 验证规则 P8 在 retry/adaptive subtask 内强制要求有 confirm 兜底

  1.6. [case] step_type = call
    1.6.1. [act] 初始化子 Spec 执行实例
      - ← next_resp
      + → child_instance_id % line  # 子实例 ID
      > 调用 Engine 的 init_execution，传入 callee spec 路径、父实例 ID、call 步骤 ID 和映射后的参数
    1.6.2. 调用 run_spec：递归执行子规约
      - ← child_instance_id
      + → step_result
```

---

## lack_of_info 知识补充路径【说明】

**承接面=仅 reason**（2026-08-31 作者定 0053"只应该给 reason"）：
- reason 交 lack_of_info 本质是触发 fail:它是 reason 唯一的语义性自报失败通道;
- check 不设〔"判不了"的正形=如实 false+说明,或 escalatable 的结构化 gap——三值化议过撤了,不给 escalate 发明第二触发形态〕;
- act 不设〔确定性/工具执行,缺信息该失败就失败〕;
- 原实装对全部 LLM 步骤类型不加区分地接,收窄后 act/check 交该键不入本路径——check 双槽照常走 schema 校验,act 同。

reason 返回 `lack_of_info` 非空时，StepDispatcher 不立即 fail，而是尝试知识补充检索后重试：

```
handle_lack_of_info(step_id, lack_of_info, context, knowledge_provider?):
  // 1. 无 KnowledgeProvider → 直接 fail（无检索能力）
  if !knowledge_provider:
    engine.fail_step(step_id, lack_of_info, 'lack_of_info')
    return

  // 2. 以 lack_of_info 描述为 query 检索补充知识
  fragments = knowledge_provider.retrieve(lack_of_info, max_results=5)

  // 3. 无结果 → fail
  if fragments.length == 0:
    engine.fail_step(step_id, lack_of_info + ' (knowledge retrieval returned no results)', 'lack_of_info')
    return

  // 4. 有结果 → 注入知识上下文后重试当前步骤（不走 subtask retry）
  supplementary_context = format_knowledge(fragments, '由步骤 ' + step_id + ' 的 lack_of_info 触发')
  context.knowledge_context = merge_knowledge(context.knowledge_context, supplementary_context)
  retry_result = execute_step_with_context(step_id, context)

  // 5. 重试仍返回 lack_of_info → fail
  if retry_result.lack_of_info:
    engine.fail_step(step_id, retry_result.lack_of_info + ' (after knowledge supplement)', 'lack_of_info')
    return

  return retry_result
```

**与 subtask retry 的区别**：lack_of_info 补充检索是步骤级的"微重试"——以 lack_of_info 描述为针对性 query 检索，注入后重试同一步骤。subtask retry 是容器级的——重跑所有 children，不感知 lack_of_info 的具体原因。

## 节点级工具授权的分档下发【契约】 ^anc-step-tool-grant

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-grant]]。设计层此前无本锚定义（内容散在 spec-parser 版本行〔`- 工具:` 行收取文法〕与本文档 ^anc-exec-reason-tools 节〔消费面〕,TRACEABILITY 卡自 0054 批起挂 ⚠ "设锚补齐归 0054 批主"——2026-09-12 0088 批补齐,本节为设计侧锚定位点）：

- **分档判据**：basic 族（文件读写十一件+spec 内容族六件）恒下发零声明;special 族（tools_available 注册的外部件）按节点 `- 工具: 名  # 意图` 声明行下发——无声明即不在该步工具面（合规空转是最难发现的失效形态,声明行是防线）;
- **文法收取归 [[spec-parser]]**（`- 工具:`/`- tools:` 同义、每行恰一名、`*` 全量、仅 act/reason 步收——版本行沿革有账）;**下发过滤归本文档**（消费点两处:无 body act 的工具循环与 reason 步工具面 ^anc-exec-reason-tools,禁用半边见 ^anc-step-tool-deny——授权/禁用两行对称,同名冲突写时拒）;
- requires_commit=true 件恒不下发（"不能 commit 写"——list 期过滤,^anc-exec-reason-tools 承载）。

## reason 与 check 步工具面（standalone）【契约】 ^anc-exec-reason-tools

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-grant]]（2026-09-01 作者拍"所以应该给 reason 提供文件工具""等同于 act 的能力，不能 commit 写";2026-10-11 作者拍 check 同款——"check 工具可能要读文件,这个应该留个口子",todo/0161;概念文档随对账批次同步）。本节规则对 reason 与 check 两种步骤同样成立——三种步骤只剩两套规则：act 一套（basic 恒下发、special 按声明）,reason/check 一套（全按声明）。
- **缘起**：anchor-audit spec standalone 化六跑，第六跑死在 4.2——reason 步要读盘上 cross_compare_results.yaml，standalone reason LLM 零工具面判不了（no knowledge provider）；5.2.1.1（逐锚点读源文件判定）/6.1（逐批读盘统计）同形态；
- 复用模式执行者（CC/Codex）天然带工具面，reason 用文件/检索是常态——standalone 的 reason 与它能力不对等，同一份 spec 两模式一活一死。

**能力契约（HopSpec 契约）**：

```
# Spec: standalone reason / check 步执行
Goal: reason 与 check 步在 standalone 下与复用模式能力对等——可推理或判定、可用受控工具读料，产出仍按声明 schema 解析
Inputs:
- step % StepReady  # reason 步（无 body——reason 本无 body 形态）或无 body 的 check 步（带 body 的 check 归解释器 ^anc-step-check-body,不入本面）
Outputs:
- outputs % yaml  # 按声明 schema 解析的产出（经既有 parseStepOutput 阶梯,lack_of_info/tool_failure 前置探测照常）
Constraints:
- **reason 与 check 的工具面全按节点声明下发（2026-09-18 修订 reason——basic 族不再恒下发;2026-10-11 todo/0161 check 并入同一套规则）**：`- 工具:` 声明什么下发什么（basic 与 special 同一文法零分档差异）,零声明=零工具面走单发纯推理。原"basic 恒下发"口径废除——那是 2026-09-01 救 anchor-audit 真饥荒时的实装选择,救的是"少数 reason 步真要读盘",给的却是全部 reason 步无条件十一件;弱模型实撞:Qwen3.8-27B 在输入全实值的最简 reason 步上七轮全灭 20 轮工具空转,文字五级+结果语义两级干预全部无效,直连探针实证长供给×满配工具面走偏 5/6 而 0 工具 3/3 交出正确产出——闲置工具面对弱执行者不是备而不用,是行为吸引子;声明制同时天然把用工具步的工具面压到少数几件（Qwen ≤3 件档 0/6 走偏）。act 步不动（act 本就是干活步,basic 恒下发照旧）
- requires_commit=true 的工具恒不下发（"不能 commit 写"——reason / check 与 act free 同一条不可逆红线;list 期过滤,非运行期拒）。check 只读不写：它用工具是为了核对产出实物（大产出常走 `$file` 卸载,只看指针与预览判不了）,能产生不可逆后果的工具在 check 里永远不给
- check 入本面（2026-10-11 todo/0161）：无 body 的 check 与 reason 同一入口——有声明走工具循环,零声明单发纯判定（既有行为不变）;带 body 的 check 不受影响（解释器机械判定,^anc-step-check-body）。不为 check 单开第三套规则。原"check 不入本面,要放开另立批"随本条撤
- openai-chat 协议降级：工具循环按 supportsToolLoop 能力谓词分道（0020 批——anthropic/openai-responses 承载,openai-chat 不承载）——supportsToolLoop=false 的 reason 退回单发零工具形态（不 fail-fast——reason 不同于 act:它总能纯推理产出,工具只是增强）
- **模型档案上限联动（model-gearbox 消费面第一环）——待实装,归 todo/0095 档案消费批**：下发前读目标模型 profile 的 `adapt.max_inline_tools`（有档案且非 null 时）,声明件数超上限则截到上限并 recordWarn 点名被截件（声明制管"步骤要什么",档案管"模型受得了什么",取交集;无档案/null=不设限,存量零变化）。**本版代码无 profile 读取,声明件数不截断**——档案读取 / 匹配 / 缓存整套机制是 0095 的一件事,不在 reason 工具面单独开一个读取口（22962deb 当时即定"档案消费下一批",设计漏标;2026-10-11 语义审计 ❌ 判出后补标）
```

**HopSop（执行流程，2026-09-18 修订版）**：

```
# impl execute_reason_or_check_standalone
0. [branch] check 带 body → 解释器机械判定（^anc-step-check-body）,不进下面各步;reason 或无 body 的 check 继续
1. [act] 组装工具清单（全按节点声明 + requires_commit 过滤;max_inline_tools 截断待实装,归 todo/0095——本版不截）
2. [branch] 分派
  2.1. [case(零声明或 supportsToolLoop=false 协议)] 单发零工具（既有 executeReasonOrCheck 形态——纯推理 / 纯判定步的缺省路,弱模型物理无可着魔按钮;openai-chat 落此道,0020 批谓词口径）
  2.2. [case(有声明且 supportsToolLoop=true)] 走工具循环（与 act 共用循环体:滚动 cache 断点/预算闸/超轮上限/tool_failure 终轮探测）——角色档按步骤类型:reason 档 / check 档（check 档的 L4 操作指引仍是判官身份,工具只是拿实物核对的手段）;模型解析类别同样按步骤类型（models.reason / models.check 与对应 routing_rules 照常生效）;anthropic 与 openai-responses 落此道
3. [act] 终轮文本经 parseStepOutput 既有阶梯解析（lack_of_info 前置探测只在 reason 路径——check 的双槽签名没有这个语义通道）
```

**工具循环同签名断路器（2026-09-18 同批新增,act/reason 工具循环共用）** ^anc-exec-toolloop-repeat-break：连续 3 次同名同参（参数 JSON 串相等）工具调用即断——抛错前缀 `TOOL_LOOP_REPEAT:` 报文点名"同一调用连续 N 次重复,结果不会不同"（失败档次=**步级瞬态**：前缀登在引擎 `TRANSIENT_PREFIXES`,首次撞到免扣重试预算、下轮带反馈重跑、复发照扣——与 THINKING_EXHAUSTED / OUTPUT_TRUNCATED 同待遇;归类判据见 [[exec-engine#^anc-exec-deterministic-no-retry]] 口袋归类表。2026-10-11 语义审计 0156 C3 改定：此前本句写"deterministic 口袋",与代码 2026-09-04 乙案登成瞬态前缀不一致）。
- 与 MAX_TOOL_ITERATIONS(20 轮)分工:那个管总量,这个管形态——实撞:Qwen 第五轮 14 连扫同一空目录,总量闸到第 20 轮才拦,断路器第 3 次重复即止损,17 轮陪葬费省下;
- 对全部模型生效;"同名不同参"不触发（合法的逐文件遍历形态）。

**正反例**：reason 声明 special 工具→清单含之且**只含声明件**（prompt-assembler 的 L4 清单与本节下发面同一过滤——2026-09-18 修订时下发面改了、清单漏改仍对 reason 恒列 basic,2026-09-30 语义审计抓"清单与下发面失同源",2026-10-08 todo/0129 B8 补齐;原正反例文"未声明→仅 basic"是修订前口径,随本句撤）/reason 零声明→零工具零清单/requires_commit 件恒缺席/**check 声明 read→工具循环里读到 work_zone 文件后给出判定**（2026-10-11 todo/0161）/**check 零声明→单发零工具（既有行为不变）**/**check 声明 requires_commit=true 的工具（如 write）→下发面里没有它**/openai-chat 路由 reason 单发零工具（supportsToolLoop=false 降级道,openai-responses 有声明照走工具循环——0020 批）/工具循环终轮 lack_of_info 照常探测。

## 节点级工具禁用的下发过滤【契约】 ^anc-step-tool-deny

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-deny]]（2026-09-05 作者拍"甲，而且是不是可以在指定节点禁止 write tool?"——与 edit_file 工具同批：edit_file 给正路，禁用行封邪路）。缘起：0038b 轮定量账坐实 hopbuild2 修错步"有树编辑工具可用仍选 write 全文回写、另一轮 create+append×8+move 分块重建全文"——说明段的文字禁令（D68"禁止整篇重写"）不牢靠，需要结构性封堵：被禁工具从下发清单整体剔除，执行 LLM 根本看不到它。

**能力契约（HopSpec 契约）**：

```
# Spec: 节点级工具禁用下发过滤
Goal: 节点声明 `- 禁工具: 名` 后,该工具对本步执行者不可见——standalone 的 API tools 字段与复用模式的 L4 工具清单同一语义
Constraints:
- 过滤位=list 期,分档过滤之前（禁用优先——被禁件无论 basic/special/已授权,先剔除;与 requires_commit 过滤同哲学:清单里没有,LLM 不会调,运行期无需新拦截）
- 管辖面比授权行宽：授权行只能开 special,禁用行能关任意件含 basic 族（这正是它存在的理由——basic 恒下发原则的唯一例外通道）
- 消费面与授权行同族：无 body act、reason 与 check（executeReason 复用 executeActWithTools 循环体天然生效,零额外改动;check 自 todo/0161 与授权行同批放开——能开就要能关,2026-10-12 作者拍板概念层 ^anc-step-tool-deny 同步）;commit 不收禁用行（parser 层已拒,dispatcher 不需防御）
- 复用模式 L4 工具清单（buildToolManifest）同吃禁名过滤——两模式禁用语义逐字节一致,basic 恒列行对被禁件剔除
- 同名授禁冲突不到本层（parser checkAttrGate 写时已拒——本层拿到的 grants/denies 恒无交集）
```

**HopSop（过滤流程,executeActWithTools 开头）**：

```
1. [act] 取节点 tool_grants 与 tool_denies（findStepInSpec 同一取点）
2. [act] deniedNames = denies 名字集合
3. [act] tools = ToolProvider.list()
   .filter(不在 deniedNames)          ← 本批新增,链首位（禁用优先）
   .filter(basic 或 grantAll 或已授权)  ← 既有分档过滤
   .filter(allowCommit 或非 requires_commit)  ← 既有不可逆过滤
```

**正反例**：节点禁 write→下发清单无 write（basic 族被禁实证）/不禁件照常在/reason 步禁用同样生效/零禁用声明与改造前逐字节同构（存量零回归）/L4 清单对被禁件同步剔除。

## 工具故障自报通道（reason+无 body act 的 tool_failure）【契约】 ^anc-exec-tool-failure-report

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-failure-exit]]（工具故障退出条款，2026-09-01 作者拍 A 案随批回收概念层——与 lack_of_info"信息不足退出"并列的同族自报出口）。2026-09-01 作者拍板 A+C（缘起：复用模式 web_search 改走 caller 原生检索后作者追问"agent 自己的 web search 出故障能感知到么"——盘出无 body act 的结构缺口）。
- **问题**：无 body 的 act 步工具失败落在执行 LLM 手里没有结构化出口——独立模式工具循环把失败以 `is_error:true` 回注后全归 LLM 裁量，它想如实认输也没有语义通道;
- **为什么 lack_of_info 不够**：act 无 lack_of_info——0053 承接面裁定"act 缺信息该失败就失败"，但**工具故障不是缺信息**：lack_of_info 的承接是补检索，act 不适用；工具故障的承接是容器重试〔瞬时故障重试即愈〕+故障原文进失败账，act 天然适用——两通道不冲突不重叠;
- **无出口的后果两形态**：硬凑产出（静默退化——检索故障伪装成"搜不到"，业务面不可区分）或交不合 schema 的东西（被当格式错烧算子重试，失败归因记错账）。

**A 案：tool_failure 自报形态**

```
trait: ToolFailureReport
  Id: exec-tool-failure-report
  Provides:
    - LLM 执行的无 body 步骤单键自报 tool_failure → failStep(fail_kind='tool_failure') → 既有容器阶梯
  Constraints:
    - 承接面=reason + 无 body 的 act（2026-09-01 作者补定"reason也需要用tool,特别是web search"——复用模式执行者是带工具面的 agent,reason 用检索是常态;commit 议过撤回:作者定"commit必须通过body",且 B7 守卫已是 error 级——无 body 的 commit 进不了引擎,通道天然够不着,零新码零豁免）。有 body 的 act/commit 走解释器 TOOL_EXEC_ERROR 既有闭环不经 LLM 产出面;check 不设（判不了的正形=如实 false+说明/escalatable gap——不给 escalate 之外发明第二触发形态）
    - 判定位=engine.completeStep 早判区,与 lack_of_info 同位、先于 schema 校验（同一顺序理由:自报形态天然缺声明输出槽,后判则先被 SCHEMA_MISMATCH 打回、出口永不可达;两模式同点——独立模式 dispatcher 产出与复用模式 CLI submit 都经此）
    - standalone 解析站前置探测（与 lack_of_info 链第 2/3 站同款站位,公共体 extractSelfReportKey）:解析按声明收键,不前置探测则单输出步把自报段当声明值收下毒值 completed——reason 路径与工具循环终轮（无 body act;commit 同经此循环但 B7 error 后不可达）各探一次,命中短路返回 {tool_failure: 值},承接归 completeStep 早判
    - 判定形态与 lack_of_info 同族:outputs.tool_failure 非 undefined 非 null 即触发（值=故障说明:哪件工具怎么失败、对本步产出什么影响）
    - fail_kind='tool_failure'（FailKind 词表扩员四值）——容器阶梯对它走缺省重试路径（瞬时故障重试即愈,正确语义,零新分支）;不入 deterministic 掐重试名单（工具故障非确定性）;跨 call 界随 StepFailRecord 原样继承（既有机制,零新码）
    - 滥用对账判据（作者关切"逃生门"防线）:教条写死"仅工具调用实际失败时";谎报形态机械可查——hoplog 该步 tool 块零 failure 条目却报了 tool_failure = 谎报,审计面可钉（不做运行期拦截:独立模式可对账,复用模式 caller 的工具调用不在引擎账上,拦截判据两模式不齐,留审计面）
```

**关键逻辑（HopSop）**：

```
completeStep(step_id, outputs) 早判区（既有 lack_of_info 判定之后并列）:
1. [条件(节点 step_type=='reason',或 step_type=='act' 且无 body;且 outputs.tool_failure 非 undefined 非 null)]
   1.1 why = tool_failure 值（字符串直取,非字符串 JSON.stringify——与 lack_of_info 同款序列化）
   1.2 return failStep(step_id, `${why} (tool_failure)`, 'tool_failure')
2. 否则照常进 schema 校验
```

**C 案：零工具成果产出的机械 warn 兜底**（与 A 独立生效,同锚同批）：独立模式工具循环（executeActWithTools）终轮（无 tool_use、即将 parseStepOutput 返回）判：`toolCallLog` 非空且**全部** failure → `hoplog.recordWarn(step_id, '本步全部 N 次工具调用均失败,产出可能建立在零工具成果上（tool 块可对账）')`。
- 不拦截不改产出——LLM 可能合法地"工具全挂后如实交了空结果/降级说明"，warn 是审计抓手不是判决;
- toolCallLog 为空（本步没用工具）或有任一 success 不触发。

**配套教条两处**：L4 清单调用方式行（真身档,教条句现行文本以 [[prompt-assembler#^anc-exec-tool-manifest-supply]] 第 4 面条款为准——本节只记落位不复述措辞,逐字引用曾在 2026-09-01 自救优先改词批漂移一次,review 后改指针形态）；driver 两载体复用模式同款教条（reason 段与无 body act 条,以 `--failure` 或 tool_failure 键承载——两条路殊途同归 completeStep 早判区/failStep;含自救优先决策序与成本结构,文本以各载体文件为准）。

**正反例**：
- act 步产出 `{tool_failure: "web_search 连续 3 次超时"}` → failStep 且 fail_kind='tool_failure'、容器 retry 触发=正；
- reason 步交 tool_failure（检索故障无法推理）→ 同触发=正（作者补定后承接面含 reason）；
- 带 body 的 act 交 tool_failure → 照走 schema 校验（body 通道有 TOOL_EXEC_ERROR 闭环）=正；
- check 交 tool_failure → 照走双槽 schema 校验=正（check 不设）；
- act 正常产出含业务字段 → 零误触=正；
- toolCallLog 三条全 failure 且产出正常 → warn 落账=正（C）；
- toolCallLog 两 failure 一 success → 不 warn=反例判据（C 只认全败）；
- commit 无反例可写——B7 守卫 error 级下"无 body 的 commit"进不了引擎，通道够不着的形态无法构造测试（如实记录，不硬凑假 spec）。

**判定先于 schema 校验（顺序契约,2026-08-31 补钉）**：`{lack_of_info: …}` 形态天然缺声明输出槽——lack_of_info 判定必须在 completeStep schema 校验之前,否则先被 SCHEMA_MISMATCH 打回、逃生口永不可达。此顺序原实装碰巧正确但零测试锁定,本批补钉。

**复用模式承接（2026-08-31 补齐——原零承接,教条教了一个必被 SCHEMA_MISMATCH 打回的出口）**：CLI `submit_and_fetch_next --output '{"lack_of_info": "…"}'` 对 reason 步识别该形态,转 `failStep(kind='lack_of_info')` 不走 schema 校验——两模式同语义。
- 复用模式无 KnowledgeProvider 通道,恒直接 fail,容器 retry/adaptive 照常接手;
- driver 可在重跑轮自行补材料——caller 有工具,这正是复用模式此通道弱需求的原因,但通道在场胜过教而不通。

**最多补充 1 次**：避免检索-重试循环。补充后仍 lack_of_info 则走正常 fail 错误链（subtask retry/adaptive 可能从更高层级修复）。

---

> **doc-ref 模块已抽出**：`[[文档路径#章节名]]` 确定性知识引用(提取/切片/注入)+ 解析流程契约 `^anc-struct-doc-ref` / `^anc-exec-doc-ref-resolve` 已独立成 [[doc-ref]]（被 parser/validator/engine 多方调,应独立模块独立文档;早期误挂 dispatcher 是历史,解析实归 engine.assembleBasicContext）。

---

## 执行证据机核（重试轮零工具即声称完成的拒收闸）【契约】 ^anc-exec-act-evidence-gate

**作者拍板**：2026-09-20"让 27b 全面走通"四缺口盘点后拍"按工程链开工"，第一件即本条（todo/0095 卡 2e 候选①，验尸定案后的对症方子）。

**实撞背景**：27b 在 hopbuild2 修错步（act free 工具循环）的全部 10 个重试轮里一次工具都没调——每轮 2-5 秒、64-268 token，读完修复工单直接把工单复述成"修了 N 处"的产出交卷，纯虚构完成。判官第 2 轮就点破"自称修了、盘面真身不在场"，此句进后续每轮反馈，模型照样不动手，虚构逐轮升级拟真度（第 8 轮带虚构行号引用）。同语料复跑同款复现。文字防线（判官点破进反馈十轮）实证无效——"教学清不了零"定律的又一实例，防线必须机械。成本账：每轮虚构是零成本谎言，却烧一次判官全审（13K-24K token）——循环里最贵的环节在为谎言买单。

**判定条件（机械四与门，信号全部既有零新观测）**：

| 信号 | 取自 | 语义 |
|---|---|---|
| A 重试轮 | step.context.retry_feedback 非空 | 本步带着修复反馈重做（首轮不核——首轮零工具的合法形态多） |
| B 工具面在场 | 本步实际下发 tools 非空 | 工具面本就为空的步，零调用天然合法 |
| C 零调用 | toolCallLog.length === 0 | 全程一次工具没发 |
| D 无如实声明 | 终轮响应文本里没有任何一行以 `no_change:` 开头（出现在任意行首都算，不要求在产出之前） | 有自报=走第二出口：放行留痕，并把这一行当旁路声明剥掉后再解析产出（见下；剥除不只在放行路径——A、B 两条成立的轮次里调了工具也照剥，见"剥除范围"段） |

**适用范围：只核 act 步（含 act free），reason 步整个不进本闸**（v0.40.0，2026-09-29 deep-validate × qwen-flash 实撞）。本闸防的是"声称改了盘面其实没动手"——前提是这一步的交付物落在盘面上，产出文字只是对盘面动作的陈述。reason 步不是这样：它的交付物就是产出文字本身，工具只是读料的增强（[[#^anc-exec-reason-tools]]"reason 总能纯推理产出"），重试轮只按反馈改产出文字、一次工具都不调，是最常见的合法形态，没有"虚构的盘面动作"可以核。**实撞**：deep-validate 步 2.1（reason，声明 `- 工具: read` 只为读被卸载的大件 spec 全文）第 1 轮被判官以"P10 风险条目缺坑位"打回；第 2、3 轮 qwen-flash 都按反馈把报告改对了（P10 补上"坑位：步骤 4.3"），都没调工具，也都没写 no_change 行，两轮都被本闸拒收，subtask 重试耗尽，run failed——在规约步骤说明里加一句教写 no_change 的话复跑，两轮照样不写，同样死法。靠教学让模型在 reason 步写这一行，是在为一道本不该拦它的闸买单。判定用的是 step_type，机械可判，不做语义猜测。同一分道的使用点共两处：①本闸拒收与 no_change 剥除（dispatcher 执行证据机核区块，reason 步跳过整个区块——首轮、重试轮都原文不动，与"工具面为空"同一处置）；②工具清单重试轮追加句（prompt 工具清单渲染的 retryRound 信号，reason 步不传——那句话"反馈要求修改盘面的必须真调工具落实"和 no_change 出口，对 reason 步既不适用也无闸可对应，渲染出来只会误导；渲染层条款见 [[prompt-assembler#^anc-exec-tool-manifest-supply]] 第 6 面）。

- **代码判法与标题的关系**：两个使用点在代码里判的都是"step_type 不等于 reason",不是"step_type 等于 act"。在现行可达路径上两者等价——走到工具循环的只有 act 与 reason 两类（check 步不下发工具;commit 步没有 body 会在校验期被 B7 规则拒载,有 body 则由 body 解释器执行、不进工具循环）。变异核证实证过这一点:把判法改成"等于 act"全量测试结果不变。
- **已知边界（待拍板,todo/0123）**：reason 步可以被授予写类工具（write、edit_file 等不带 requires_commit 标记的工具,按 [[#^anc-exec-reason-tools]] 会下发）。这种 reason 步的交付物有一部分落在盘面上,本闸不核它,重试轮不调工具就声称"已写好文件"不会被拦。现行库内没有给 reason 步授写类工具的规约,属于潜在漏洞;修法有三个方向（工具面含写类工具的 reason 步照样进闸 / 禁止给 reason 步授写类工具 / 接受并写明边界）,上层没有锁死,待作者拍板。

四与门全真（三信号 + 响应里无 `no_change` 自报行）→ 交卷拒收：throw SCHEMA_MISMATCH 前缀错误，上浮 handleStepReady 的失败链走**容器级重试**（吃 subtask retry 预算——不新建预算面，**不送判官**；注：不是算子级 SCHEMA 环——那条通道只接 completeStep 返回的响应码，执行期 throw 走容器链，首版设计陈述有误经阅卷勘正）。反馈文案原文（指路双出口；开头一段"SCHEMA_MISMATCH: 带着修复反馈重做本步却一次工具都没调"是 prompt 模块导出的常量 `ACT_EVIDENCE_GATE_PREFIX`,dispatcher 抛错时引用——修正指令渲染靠这段开头认出机核拒收,不再给它套形态指引,见 [[prompt-assembler#^anc-exec-l2c-retry-feedback]]）：

> SCHEMA_MISMATCH: 带着修复反馈重做本步却一次工具都没调——要么真调工具修改盘面；要么确实无需修改或做不到时，产出照本步输出声明完整交，另起一行顶格写 `no_change: 原因` 如实声明未做修改（这一行不占产出的位置，也不能代替产出）；复述工单不算修复

**第二出口 = 旁路声明**（2026-09-26 todo/0111 改定）：`no_change: 原因` 是与 tool_failure/lack_of_info 同族文法的行首自报键（extractSelfReportKey 行首键匹配，机械可判非语义猜测）。它是**旁路声明**：只告诉引擎"本轮如实没改盘面"，不是产出的一部分，也不能代替产出。自报在场 → 放行 + warn 留痕（"零工具重做轮携 no_change 自报"入 HopLog，审计面可对账真伪——虚构者若学会写 no_change 谎称没改，判官对着盘面与工单立刻现形，谎言从"烧判官全审"降级为"一行 warn 可查账"），然后把这个键块从响应文本里剥掉，剥后的文本才交产出解析。为什么不是"拒一轮后放行"：那等于机核只拦一次，虚构者重复虚构一轮就过，防线名存实亡。

为什么必须剥：首版放行后什么都不改，no_change 行原样进产出解析——单输出 text 步的值会混进这一行；结构化输出声明的步骤（复合类型、带必填字段）更糟，模型照首版文案"在产出顶格写一行"的字面，常常整份产出只剩这一行，类型校验必然报缺字段判死。**实撞**（todo/0111，T9 sdc×qwen3.8-27b 步 5.1.1，输出声明 `guard_result: GuardResult` 五字段）：第 3/4 轮交了规约明文允许的降档产出（status: 降档需人裁）因零工具被拒；第 5 轮照文案只写一行 no_change，闸放行后被类型校验以"缺字段 clause_id"判死，retry 耗尽，run failed——出口成了死门。

**剥除范围：重试轮且工具面在场就剥，不看调没调工具**（v0.34.3，T9 sdc×qwen3.8-27b 第六次复测实撞）。v0.34.0 只在放行路径（零工具）剥，调了工具的重试轮原文不动。可重试反馈与工具清单在所有"重试轮+工具面在场"的轮次都教了 no_change 出口，模型不会精确区分"这轮我调没调过工具"——r6 第 3 次尝试先列目录、读文件（调了工具），产出末尾照样顶格写了一行 no_change，这一行原样进解析，完整的五字段产出被解析成两个键的对象，类型校验报"缺字段 clause_id"，重试耗尽。判据仍是机械的行首键匹配：教过这个出口的轮次（A、B 两条成立）都按旁路声明剥；拒收条件不变（仍要四条全真）；调了工具还写 no_change 记一条 warn，自述"没改"与工具调用记录可对账。

**能力契约（HopTrait）**：

```
# Spec: 执行证据机核
Id: act-evidence-gate
Goal: 重试轮里工具面在场却一次工具都没调的交卷，要么拒收重做，要么凭行首 no_change 自报放行；
      放行时 no_change 只作旁路声明，产出仍按本步输出声明解析与校验
Inputs:
- step_type % line  # 本步步骤类型（reason 步不进本闸）
- response_text % text  # 终轮响应的全部文本块拼接（extractTextContent）
- retry_feedback % text  # 本步修复反馈，空=首轮
- tools_sent % [line]  # 本步实际下发的工具名
- tool_call_count % int  # 本步工具循环全程的调用次数
- output_names % [line]  # 本步输出声明的变量名
Outputs:
- parse_text % text  # 交给 parseStepOutput 的文本（重试轮且工具面在场、响应里有 no_change 键块时=剥掉该键块后的文本；其余情形=原文）
Constraints:
- step_type 为 reason 时整个不核不剥，parse_text = response_text（reason 的交付物是产出文字本身，没有盘面动作可核）
- 拒收只在四与门全真时发生；剥除在 A、B 两条成立（重试轮且工具面在场）时就做，不看调没调工具——这两条成立的轮次都教过 no_change 出口；首轮、工具面为空两种情形原文不动，不剥
- 剥除范围与 extractSelfReportKey 的读取范围一致，不多剥不少剥
- 不做产出语义判定：不看产出字段的值像不像"认输"
- 剥完还有内容的，一律照走既有解析与类型校验（缺字段照报缺字段）
```

**类型约定（HopType）——旁路自报键块**：

- 键行：第一条匹配 `^no_change\s*:` 的行（行首顶格，任意行位）；
- 续行：键行之后连续的、以空白字符开头的非空行（其间的空行一并算进键块），遇到第一条顶格的非空行即止——与 extractSelfReportKey 收集续行的规则逐字一致；
- 剥除 = 从文本里删掉键行、续行以及它们之间的空行；键块前后的其他文本原样保留、原序拼接；
- 只剥第一个键块（与 extractSelfReportKey 只读第一个匹配同口径）。

**HopSop（放行路径）**：

```
# impl act_evidence_gate（executeActWithTools 终轮无 tool_use 分支内，全败 warn 之后、lack_of_info/tool_failure 探测之前）
1. [branch] 判前三条
  1.0. [case(step_type == reason)] parse_text = response_text（不核不剥）
  1.1. [case(retry_feedback 非空 且 tools_sent 非空 且 tool_call_count == 0)]
    1.1.1. [act] noChange = extractSelfReportKey(response_text, 'no_change')
    1.1.2. [branch] 判 D
      1.1.2.1. [case(noChange 缺席)] 抛 SCHEMA_MISMATCH（反馈文案原文见上）
      1.1.2.2. [case(noChange 在场)]
        - [act] recordWarn（"执行证据机核放行:零工具重做轮携 no_change 自报（原因）——审计面可对账真伪"）
        - [act] parse_text = stripSelfReportKey(response_text, 'no_change')
        - [check] parse_text 去空白后为空 → 抛 SCHEMA_MISMATCH 剥空专用文案（原文见下）
  1.2. [case(retry_feedback 非空 且 tools_sent 非空 且 tool_call_count > 0)]
    1.2.1. [act] noChange = extractSelfReportKey(response_text, 'no_change')
    1.2.2. [branch] noChange 在场 → recordWarn（"本轮调用了工具仍写 no_change 自报,已按旁路声明剥掉——审计面可对账"）；parse_text = stripSelfReportKey(response_text, 'no_change')；剥空同 1.1.2.2 专用文案拒收。noChange 缺席 → parse_text = response_text
  1.3. [case(else)] parse_text = response_text（不剥）
2. [act] 后续 lack_of_info / tool_failure 探测、lastFinalTurn 记录、parseStepOutput 全部改吃 parse_text
   （parseStepOutput 按单输出 unwrapSelfLabeled / 多输出 YAML 解析的既有两条路照常走）

# impl 使用点②:工具清单重试轮追加句的渲染信号（prompt 组装,buildToolManifest 调用处）
1. [branch] 算 retryRound
  1.1. [case(retry_feedback 非空 且 step_type != reason)] retryRound = true → 清单头渲染重试轮追加句
  1.2. [case(else)] retryRound = false → 清单按首轮形态渲染（reason 步重试轮走这里）
```

**剥空专用拒收文案原文**（`<输出名>` 按本步输出声明的变量名逐个列出，以顿号相连）：

> SCHEMA_MISMATCH: 只交了 `no_change` 自报、没有交产出——no_change 只是旁路声明，不能代替产出。产出仍须按本步输出声明完整交（本步要交：<输出名>），做不到的就在产出里如实写明做不到的情况；`no_change: 原因` 另起一行写在产出之外

为什么要专用文案：不剥时这种响应会被类型校验报成"缺字段 clause_id"一类，模型看了以为是格式问题，看不出真正要它做的是"把产出也交上"；剥空后若直接交 parseStepOutput，会得到空响应错误，同样说不清。

**正反例**：

- T9 第 5 轮原文（只有一行 no_change）→ 剥空 → 专用文案拒收（正——不再以"缺字段"判死）；
- 完整 guard_result 五字段产出 + 另起一行 no_change（行在产出之前或之后都一样）→ 产出正常收、warn 在场（正）；
- 单输出 text 步：`result: 未做修改…` 后跟 no_change 行 → result 值不含 no_change 那一行（正）；
- no_change 键行后跟缩进续行 → 续行一并剥掉，不进产出（正）；
- T9 第 3/4 轮原文（合法降档产出、无 no_change）→ 仍拒收（反——闸本身不放宽，文案教它另起一行补 no_change）；
- 首轮响应里恰好有一行 `no_change: …` → 不核也不剥，原样进解析（反——没教过这个出口的轮次不动它）；
- reason 步（声明了 read 工具）重试轮零调用、无 no_change、按反馈改好的完整产出 → 不拒收，产出正常收（正——deep-validate 2.1 × qwen-flash 实撞形态）；同一形态放在 act 步上 → 仍拒收（反——act 的闸不因本条放宽）；
- reason 步重试轮产出里带一行 no_change → 不剥，原样进解析（reason 步从未被教过这个出口，与首轮同一处置）；
- 重试轮调了工具、产出 guard_result 五字段完整、下面又顶格写一行 no_change（T9 r6 第 3 次尝试原文）→ 剥掉这一行、产出正常收、warn 在场（正——修前这一行原样进解析,整份产出被解析成 `{guard_result, no_change}` 两个键的对象,单键剥层不触发,类型校验报"缺字段 clause_id",而模型的五个字段其实都在）。

**不做的方案**：按产出字段的语义值放行（例如 status 落在"降档需人裁"这类枚举值上就视为已如实声明）——要引擎理解"哪个字段的哪个值算认输"，是语义判断，与本闸"行首键匹配、机械可判"的立场相反。正确降档产出吃拒收的连带问题改由教学面治（见随批半件：重试轮工具清单同时教 no_change 出口，降档产出另起一行写 no_change 即一次过）。

**误伤面（宁窄不宽）**：首轮恒不核（零误伤）；重试轮真无需动盘的形态（重试因产出皮病、纯文本改措辞）与做不到而如实降档的形态，产出照声明交、另起一行写 no_change 即过——代价一行文字且反馈与工具清单都教路。不做产出语义判定（"看起来声称修了"这类猜测不进判定条件；no_change 是行首键匹配不是语义判定）——拦不全可以（判官兜底仍在）。

**与既有机制的分工**（三者正交，同区块落码）：

| 机制 | 管什么 | 处置 |
|---|---|---|
| 全败留痕（^anc-exec-tool-failure-report C 案兜底） | 调了工具全失败 | warn 留痕不拦 |
| 本机核 | 该调没调（重试轮声称完成） | 拒收重做 |
| 同签名断路器（^anc-exec-toolloop-repeat-break） | 重复调同一工具同参数 | 抛断 |

**随批半件（渲染层分道）**：工具清单前导句"任务不需要工具时严格禁止调用"（prompt.ts 工具清单节）在重试轮修错场景方向反了——给虚构完成递了合法出口。修=按 retry_feedback 在场分道（v0.40.0 起 reason 步不走分道，恒按首轮渲染——本闸不核 reason，见"适用范围"段）：首轮维持原句（闲置工具面是行为吸引子，P2 的正确防线）；重试轮追加"但本轮带着修复反馈——反馈要求修改盘面的，必须真调工具落实，禁止只在产出里声称已修"。2026-09-26（todo/0111）重试轮这句同时教合法出口（与 tool_failure 出口"教出口必教下文"同族）——追加句全文改为："**但本轮带着修复反馈**——反馈要求修改盘面的，必须真调工具落实；禁止只在产出里声称已修（引擎会机械核对本步工具调用记录，零调用却声称完成会被当场拒收重做）。确实无需修改或做不到的，产出照本步输出声明完整交，另起一行顶格写 `no_change: 原因` 如实声明未做修改（这一行不占产出的位置，也不能代替产出）。"首轮不渲染这句（首轮没有这道闸）。

**挂账不入本批**：判官工单膨胀（单轮 18.5K）属 hopbuild2 spec 面且 D96/D97 判官瘦身已治过一轮，归 hb2 下轮观察（0095 卡 2e 销账行注明）。

## adaptive 结构化生成（三段流水线）【契约】 ^anc-exec-adaptive-pipeline

概念上游 [[../concepts/HopSpec V3扩展-有序思考与渐进固化#探索验证闭环]]（作者裁 A 档 2026-08-13——第 4 档从零重规划与 HopTrait 有序思考是同一闭环的两个入口,②结构化生成环两者共用;本节是其 adaptive 入口的最小实装,B 档〔流水线 HopSpec 化+搜索环接 Spec 库〕候 Spec 库协议）。

**能力契约（HopTrait）**：

```
# Spec: adaptive 结构化生成
Id: adaptive-pipeline
Goal: 把"一句 prompt 自由生成新 children"替换为有中间产物的三段流水线——每段产物可核,
      生成失败可定位到段,重试不再是掷骰子
Inputs:
- adaptive_needed 载荷（failure/subtask_contract/original_children/retry_history）
Outputs:
- children markdown（交 submitReplan 静态验证闸——验证侧契约在 exec-engine,本节只管生成侧）
- 中间产物两件入 HopLog（failure_analysis/replan_strategy——replan_audit 前置留痕,离线审核
  候选文件时可对照"当时怎么想的"）
- 每次 pipelineCall 调用在触发 replan 的容器步骤下记一个 `llm:` 块（2026-10-08 todo/0151 补——此前流水线段是三个 LLM 调用点里唯一不记的,
  用了什么模型、烧了多少、端点以什么原因收尾全盲）：字段与 parseStepOutput 主路径同款（model / max_tokens / stop_reason / thinking /
  用量四项 / ctx_input_total / prompt / response,prompt 与 response 按级别裁剪）,另加 `pipeline_stage`（initial_plan / failure_analysis /
  replan_strategy / generate 之一）区分是哪一段;容器步骤已 recordStepStart（引擎进入 adaptive 时已记）,不撞孤儿守卫
Constraints:
- 三段各自独立 LLM 调用,后段吃前段产物——不合并回一发（合并=退回自由生成）
- 中间产物是结构化文本非自由散文（分析段=归因三选一+定位;策略段=保留/替换清单+理由）
- 三段任一失败（LLM 错/产物空）→ 该次 replan 尝试失败,走既有 replan 重试预算——零新失败通道
- token 纪律:三段总开销受既有预算护栏管（checkBudget 逐段累计,无豁免）
- **素材、知识、步骤分开——新 children 只写结构,素材恒走文件**（D40,2026-08-23 作者定"重规划输出
  那么多,说明本身逻辑有问题,没有把素材、知识、步骤分开,全部混在了一起,而且也没有正确的使用文件"。
  dr8 实撞:对几十步大 subtask 重规划,生成段把产物内容内联进新步骤描述,16384 输出上限三攻全被掐断）:
  生成段 prompt 明令——新 children 的步骤描述只写"做什么"与 I/O 声明,不内联大段素材内容;原 children
  里经文件流转的素材（work_zone 路径引用）在新 children 里保持文件引用形态,不展开成正文;步骤执行
  说明超过一两句的写"细则见 <文件>"而不是全文内联。重规划的产出量应正比于**结构复杂度**（步骤数×
  每步几行）,与业务素材体量无关——输出接近上限本身就是"素材混进了结构"的信号
- **OUTPUT_TRUNCATED 是确定性失败**：同一输入重发必然同样超限——replan 段被掐断时该次尝试
  按确定性失败处理,不原样重发（reason 前缀 `OUTPUT_TRUNCATED:` 入 [[exec-engine#^anc-exec-deterministic-no-retry]]
  确定性口袋;replan 自己的三攻预算对它同样不适用——三攻同因纯烧,dr8 实撞 8.5 分钟三攻全灭）
```

**关键逻辑（HopSop，D43 定向编辑修订——2026-08-23 作者定"对 spec 指定章节的改动应该有工具支持,而不是全量输出"）**：

```
handleAdaptive(resp) 三段流水线 + 机械拼装:
1. [act] 失败分析段:输入 failure+retry_history+original_children →
   产物 failure_analysis: { 归因: enum(数据问题,结构问题,工具问题), 定位: 步骤号+为何, 证据: 步骤号/行号级引用 }
   > **产物纪律（D40 精确化——实锤:coffee 站成功案例的 failure_analysis 里整份 spec_text 全文
   > 被抄进"证据",小 spec 无症状,dr8 大素材下第一段即撞 16384 三攻全灭）**：产物禁止复制
   > spec 正文/失败记录原文——证据只写步骤号与一句话引用,素材在后续段输入里本就在场
2. [act] 策略段:输入 分析产物+subtask_contract+original_children →
   产物 replan_strategy JSON: **编辑序列**（D44 定型,作者三连裁定 2026-08-23——①"add after 语义
   很混乱,应该是 insert 语义";②"为什么需要 keep?"→去 keep:编辑器缺省语义**未提及=保留**,keep
   是为 insert 挂位置造的脚手架〔无 keep 则 insert 无参照系〕,而"漏列丢步"缺陷本身就是"keep
   缺席=丢弃"这个自造语义的产物——循环论证,语义定对则缺陷不存在;③补 delete:编辑代数完备=
   删/换/增三原子,replan 常见归因"某步多余/产假数据"没有 delete 只能 replace 硬凑空壳步）：
   `{ edits: [ {op:"replace", step_id, why} | {op:"delete", step_id, why} | {op:"insert", before, intent} ] }`
   - **未提及的步骤一律原样保留**（编辑器缺省——策略产物是纯改动清单,改一步写一行,输出量
     与改动量成正比,"漏列"失败模式不复存在）;
   - delete 必带 why（删除是决策不是顺手——语义蒸发族病〔D33 闸门蒸发/D43 静默丢步〕的高危
     操作;安全网=submitReplan 静态闸:被删步产出有下游消费者时 V1 未定义变量当场红,引擎
     既有闸即防线,不新造）;
   - insert.before = 原 children 的真实 step_id 或 "END"（插尾）——锚引用原步骤定位插入点,
     与 `<<EDIT k>>` 片段序号对位各司其职（锚管位置,序号管内容配对,机械可判）
   > 结构化 JSON 非散文;同守产物纪律（只写步骤号与理由,不抄正文）
3. [act] 生成段:输入 策略产物+subtask_contract+**replace 目标步原文**（dispatcher 按编辑序列
   对 replace 项 serializeFragment 单步切片机械附入 prompt——"改这步"是真改写非凭空重写,
   旧步骤里对的部分〔IO 声明/执行说明细节〕有参照;D40"正确使用文件/按需供给"的读面兑现,
   输入量=被改步骤体量非 subtask 全量）→ **按编辑序列的 replace/insert 项逐个生成步骤片段**,
   输出形态=带序标记的片段列表（`<<EDIT k>>` 分隔,k=该项在编辑序列中的序号——拼装按 k 对位,
   不靠内容猜;delete 项无生成物不出现）;不重写未提及步骤（改动量输出）
4. [act] 机械拼装（工具支持的定向编辑,零 LLM,**AST 层完成——自动重编号**;实现统一
   2026-08-30 作者拍 B 案"replan 编辑序列的机械拼装也统一到同一组树编辑函数"——原自有拼装
   与 edit_spec_tree 各写一遍"按序拼装+重编号+序列化",作者反问"这个又是什么鬼"后统一:
   拼装段底层改调 spec-tree-edit 核心函数组〔[[tools/spec-tree-tools#^anc-exec-builtin-edit-tree-tool]] 两层
   结构之第一层〕,协议语义零变）:
   把 D44 三原子翻译成核心函数调用序——insert 按原 children 文档序先行（同锚多 insert 保持
   清单序;锚步被 delete 时已插片段留原位）,delete/replace 按编辑清单序执行（协议校验保证目标
   两两不同,操作可交换,与文档序结果恒等价）:delete=deleteNodeAt;replace=replaceNodeAt（取对应
   `<<EDIT k>>` 片段 parseFragment 成节点,一项可多步）;insert.before=insertNodeAt（before 锚
   换算为目标步在当前工作副本的落位号）;insert.before="END"=末位+1 追加位（落位号按工作副本
   长度+1 直给——依赖不变量『replan 语境下 work 顶层 id 恒为带点号的子步 id』,裸整数号不会撞;
   若将来复用到顶层 Steps 重排等裸整数 id 场景须先重审此处）。插入片段自带 1..n 相对号会与原
   步 step_id 撞号——插入时先打临时唯一号（tagTemp）,保编辑期间按 id 定位 delete/replace 的
   唯一性,最终 renumberSteps 统一重写——全部编辑完 renumberSteps 一次（1..N 顶层连号,children 递归带前缀;submitReplan
   期望顶层号片段,LLM 片段编号乱序/撞号由重编号归一,作者定"add 需要能够自动调整序号"）→
   serializeFragment 直出 → submitReplan（验证闸归引擎照旧,熔断/重复检测不变）
   > **回退通道**:策略 JSON 解析不动/replace/delete/insert.before 引用悬空/编辑序列为空或
   > 全删光（产物零步骤——防极端输出）/生成段缺某 `<<EDIT k>>` 片段/片段 parse 不过 →
   > 该次退回全量生成（原形态,一次机会）——零新失败通道,定向编辑是优化不是新契约面
   > **片段编号归一在 parse 之前**（hopissues/0030 复验实锤——"重编号归一"承诺的前半截缺失;
   > review 复核修正机理 2026-08-25——首版"子行由 parse 自然挂载"陈述错误,parser 按 **step_id
   > 前缀**建树非按缩进〔parser.ts buildStepTree〕,只改顶层号会把缩进子行变 orphan）:
   > LLM 给 replace 1.1 的片段自然写 `1.1.` 子编号（它在改那一步）,而 parseFragment 按"片段=
   > 顶层裸步骤序列"契约拒子编号（references non-existent parent）——归一若只在 parse 成功后
   > 的 renumber 做,子编号形态在 parse 关就死,永远到不了归一;全量生成产物同病（replan 语境
   > LLM 总倾向沿用原步骤号）,三轮同因全灭。修法=**前缀重写归一**:片段/replan 提交文本 parse
   > 前,顶层（零缩进）多段编号行按出现序分配顶层连号,**其下所有编号行（含缩进子行）的同一
   > 旧前缀整树替换为新号**——子步骤跟随父号改写,树关系保持（`1.1.`→`1.` 时 `1.1.1.`→`1.1.`）;
   > **已是顶层连号的输入幂等不变**（提交点对定向拼装产物二次归一无害的正确性前提）;
   > **零缩进多段编号视同顶层步骤参与连号**——parser 虽允许零缩进 `1.`+`1.1.` 按 ID 建树,但
   > replan 片段语境无法区分"LLM 沿用原号的顶层步骤"与"刻意零缩进层级",归一按前者处理并
   > 保持前缀重写（`1.`+`1.1.` → `1.`+`1.1.` 幂等,因 `1.1.` 有前缀 `1.` 在场时视为其子而非独立
   > 顶层——判据:多段编号行的父前缀若在本片段先前行出现过,视为子步骤随父改写,否则视为
   > 独立顶层重新编号;**缩进行父不在场（形态异常）→ 原样保留交 parse 报错,不猜不吞**——
   > 归一只处理可判形态,不可判的留给 parse 响亮拒）;扁平化是机械文本变换零 LLM,与 renumber 同族
   > （一个管 parse 前形态归一,一个管拼装后连号）;**函数住 parser 侧共享出口**（P2-2 裁定 A
   > 2026-08-25——归一本质是 parse 前预处理非 dispatcher 私产;replan 提交**两入口同接**:
   > standalone 管线〔fragOf 片段 parse 前+submitReplan 提交前〕与复用模式 CLI --replan
   > 〔submit_and_fetch_next 提交前〕——驱动侧 LLM 同有沿用原号倾向,两模式同一提交语义
   > 同一宽容度,不靠'驱动方有纠错回路'的概率缓解）;**围栏感知**（P2-4 裁定 A 2026-08-26——
   > 归一跟踪 ``` 开闭,围栏内行跳过不改不计数:零缩进围栏内形似编号的行〔注释/模板素材里的
   > markdown 列表〕若被误改,虽有三层缓冲〔parse 认围栏树不坏/reIdSteps 兜底重排〕仍是
   > 文本污染;与 parser 各扫描层的 RE_FENCE 惯例同款）
5. 段间体量闸:分析/策略段产物 >2000 字即判段失败（这两段是结构化短文本,超长本身就是
   "素材混入"的确定性信号）——走既有 replan 重试预算,重试 prompt 带超长反馈
6. 三件中间产物+各段 output_tokens recordStepMeta 入 HopLog（subtask 步骤下,info 级——
   dr8 观测盲区补:原三攻烧完只有一行终态错误,段级无账,死在哪段无从判）
7. **submitReplan 拒因留痕**（hopissues/hoplogic3/0030——三轮策略全对却落地全拒,拒因在本层
   蒸发,排查者只见 'Replan failed after 3 attempts' 死文案）:submitReplan 返回 error 时,
   errors 明细随轮次 recordStepMeta 入 HopLog（**submit_rejected 独立审计字段**=拒因原文数组
   ——P2-1 归类裁定后从 replan_pipeline 流控块拆出,挂审计通道恒写,归类判据见
   [[spec-observability#^anc-obs-audit]] 错误凭证条款）;终态 failStep 的 reason 携**末轮拒因摘要**（`Replan failed after N attempts;
   last: <末轮首条 error message>`）——与 0016 同哲学:结构化错误不许中转层蒸发。
   注:replan_audit 与候选文件落盘在 submitReplan 成功路径（engine 侧,设计如此——audit 记
   "采用了什么",拒收品不入沉淀通道）,失败形态的可诊断面由本条 submit_rejected 承担
```

**与相邻契约的分工**：本节=生成侧（怎么想出来）;[[exec-engine#^anc-exec-retry-adaptive]]=验证与沉淀侧（想出来的算不算数/怎么留档）;熔断三件仍在验证侧不动——流水线不豁免熔断。

## 算子级重试【契约】 ^anc-exec-operator-retry

**算子级重试**：单个 LLM 算子（reason/check）的一次产出不达标时，**重做同一步**（不改步骤结构、不重跑 children），与**容器级 retry**（subtask/case 的 `retry=N`，重跑整个 children 子树）正交分层。算子级重试已有三个触发器，同属一类：

| 触发器 | 不达标判定 | 修复动作 | 上限 |
|--------|-----------|---------|------|
| `lack_of_info` | LLM 声明信息不足 | 知识补充检索后重试 | 1（见上节） |
| `CONTEXT_OVERFLOW` | 上下文超 token 预算 | reassemble_aggressive 后重试 | 1（见 `anc-exec-api-retry` 邻接） |
| `SCHEMA_MISMATCH` | 产出不匹配 `+→` 声明类型 | 拼校验反馈后重试 | **缺省 3** |

**与容器级 retry 的边界**（防混指）：算子级重试**耗尽 → failStep**，failStep 再触发所在 subtask/case 的**容器级 retry**——两层嵌套递进，非竞争。算子级重试**不触发 adaptive**（adaptive 是容器级重规划的事）。

### SCHEMA_MISMATCH 重试（分模式，语义一致）

校验语义统一在引擎 `completeStep`（见 [[exec-engine#^anc-exec-output-schema-check]]，两模式共用同一套 type 校验）；**重试机制分模式**，但缺省次数与反馈语义一致：

- **独立模式**（Dispatcher 在）：Dispatcher 调 `completeStep` 收到 `SCHEMA_MISMATCH` → 把 message（字段/声明类型/实际值/原因）作为反馈拼进 prompt → 重做该算子 → **缺省 3 次** → 耗尽 `failStep`（转入容器级 retry）。
- **resume 注入通道（hopissues/0016）**：`dispatcher.resume` 对 `completeStep` 返回值**必须判读**——非 `ok`（SCHEMA_MISMATCH/INVALID_STATE/HOP_ENV_CREDENTIAL_REJECTED 等）时**不进 executionLoop**,返回 `{status:'paused', rejected:{code,message}}` 原样上传（与 CLI `submit_and_fetch_next` '出错不推进'同语义）。
  - 修前形态:无条件继续循环——被拒的 ask/confirm 步保持 running 被 dfs 跳过,直奔 exit 撞完备性闸,结构化错误被吞成 'No executable step found',排查方向彻底误导;run 被錘成 failed 终态,用户连重试机会都没有;
  - 嵌套 call 帧的拒收同形上传（settleCallResult 前判 rejected 直接透传,帧保持挂起）。
- **复用模式**（无 Dispatcher）：`hopjit submit_and_fetch_next` 遇 SCHEMA_MISMATCH 直接返回 `{ status:'error', code:'SCHEMA_MISMATCH', message }`，步骤**保持 running、不推进**（[[exec-engine#^anc-exec-advance-to-caller]] 错误不推进）→ caller（CC）读 message 自行修正、重新 submit。
  - 缺省 3 次是**对 caller 的契约建议**（写入 message），引擎不强制计次——符合"复用模式信任 caller"（[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 第 4 条沙箱同理）。

```
handle_schema_mismatch(step_id, context, attempt=1, max=3):   // 独立模式
  result = execute_step_with_context(step_id, context)
  resp = engine.complete_step(step_id, result)
  if resp.code != 'SCHEMA_MISMATCH':
    return resp                                  // 通过或其他错误，交回主循环
  if attempt >= max:
    engine.fail_step(step_id, 'SCHEMA_MISMATCH after ' + max + ' attempts: ' + resp.message)
    return                                       // 耗尽 → 触发容器级 retry
  context.feedback = build_schema_feedback(resp.message)   // 字段/声明/实际值/原因
  return handle_schema_mismatch(step_id, context, attempt+1, max)
```

独立模式的重做反馈与耗尽原因在"正文疑似工具调用"时各追加一段提示，见下节 ^anc-exec-text-toolcall-hint。

### 产出被拒时正文疑似工具调用的附加提示【契约】 ^anc-exec-text-toolcall-hint

**作者拍板**：2026-09-25 todo/0110 probe 3（候选 D）。呈报"模型把工具调用写成正文文字时给明确回声"时，作者先反问"如果正文里恰好有这样的内容，而不是真的要去做tool调用呢？"（担心误报：产出本身合法地含有 `<tool_call>` 这类文字，比如在写一份讲工具调用协议的文档）；补呈三层防误报形态后拍"按三层形态做备选 1 (推荐)"。

**实撞背景**：2026-09-22 Ling-3.0-Flash 跑 standard-decompose-codify 步 5.1.1（act free，工具面是 11 个纯文件工具，没有 bash）。模型连着 9 轮输出一字不差的同一段普通消息文本——一段思考散文后跟 `<tool_call>bash` + `<arg_key>command</arg_key>` + `<arg_value>…python3 guard_clause1.py…</arg_value>` + `</tool_call>`。这不是 tool_use 结构，工具派发看不见它，整段文本落进产出收割，被判 SCHEMA_MISMATCH（声明要对象，实际是文本）。模型收到的反馈只有校验报文；算子级重试用完后，容器级重试的 L6 反馈还说"这通常说明产出的形态不符合输出声明……内容本身可能没有问题，重点检查形态"，把它往"YAML 没写对"的方向引。模型从头到尾不知道"你叫的这个工具不存在、写在正文里也叫不到"。

**三层防误报**（作者拍的形态，三层缺一不可）：

1. **只在产出已经被拒之后才检测**——检测只挂在 completeStep 返回 SCHEMA_MISMATCH 的两个位置（重做与耗尽）。通过校验的产出一律不碰：正文里恰好有这类文字、而产出本身合规的，永远看不到提示；
2. **原有的打回反馈一字不动，只在后面追加一段**——即使误报，模型拿到的原信息也不少一个字；
3. **追加段措辞是条件式**——开头是"如果你本意是调用工具 X："，结尾恒是"如果这段是产出内容本身，忽略本提示。"

**能力契约（HopTrait）**：

```
# Spec: 产出被拒时正文疑似工具调用的附加提示
Id: text-toolcall-hint
Goal: 模型把工具调用写成正文文字、产出因此被校验拒收时，让它在下一次尝试里知道：
      写在正文里的调用引擎收不到；它想叫的工具在不在本步可用清单里；可用的有哪些
Inputs:
- 本步最近一次终轮响应记录（FinalTurnRecord，见下方类型）
- completeStep 返回的 SCHEMA_MISMATCH 报文原文
Outputs:
- 追加了提示的重做指令（重做位置）/ 追加了提示的失败原因（耗尽位置）；
  正文里没有疑似工具调用形态时，两者与改前逐字相同
Constraints:
- 只在 SCHEMA_MISMATCH 算子级重试的两个位置检测：重做前、耗尽 failStep 前；
  产出通过校验的路径上没有任何检测调用
- body 步骤（确定性执行，没有模型文字）不检测
- 执行证据机核（^anc-exec-act-evidence-gate）抛出的 SCHEMA_MISMATCH 不检测——那条走容器链，
  管的是"该调工具没调"，不是"把调用写成文字"
- 校验报文原文不改写，提示整段追加在它后面，以标记行 TEXT_TOOLCALL_HINT_MARKER 起头
- 提示措辞条件式，恒以"如果这段是产出内容本身，忽略本提示。"收尾
- 不新增重试预算，不改重试次数
- 复用模式不做：那里没有 Dispatcher，caller 自带真工具，SCHEMA_MISMATCH 报文直接回给 caller
```

**类型约定（HopType）**：

```
FinalTurnRecord:   # dispatcher 每步一份（按 step_id 存），只保留最近一次
- text % text  # 本步最近一次模型终轮响应的正文——text 块按原样拼接的原文，不是解析后的产出值
- tool_names % list<line>  # 这次调用实际下发给模型的工具名清单（executeActWithTools 里过滤后的 tools 的 name）；单发 reason/check 恒为空列表

TextToolCall:   # 识别函数 detectTextToolCall 的返回；正文里没有任何疑似形态时返回空（undefined）
- tool_name % line?  # 从文字形态里取到的工具名；取不到时缺席（仍判为疑似工具调用）
```

**关键逻辑（HopSop）**：

```
记录 FinalTurnRecord（dispatcher）:
1. executeReasonOrCheck 与 executeActWithTools 入口先删掉本步旧记录——避免拿上一次的正文判这一次
2. 两处 parseStepOutput 调用紧前写入记录：
   - executeReasonOrCheck（单发）：text=本次响应正文，tool_names=[]
   - executeActWithTools 终轮无 tool_use 分支：text=终轮响应正文，tool_names=本步下发的工具名
3. handleStepReady 收尾（成功、失败、暂停都走）删掉本步记录

detectTextToolCall(text) 识别规则（纯函数，prompt.ts）——五种文字形态，取正文里最靠前的一处:
  a. `<tool_call>`：标签后紧跟标识符 → 工具名（Ling 实撞形态 `<tool_call>bash`）；
     标签后是 JSON 对象 → 取其中 "name" 键的值（Qwen 类形态 `<tool_call>{"name": "x", …}`）
  b. `<function_call>`：取名规则同 a
  c. ```` ```tool_code ```` 围栏：围栏内第一个调用表达式的名字，跳过外层 print，
     带点号的取最后一段（`print(default_api.bash(…))` → bash）
  d. `<invoke name="x">`：name 属性值
  e. 特殊记号 `<|tool_call…` / `<｜tool▁call…`（半角竖线与全角竖线、下划线与▁都认）：
     取 `tool_sep|>` / `tool▁sep｜>` 后紧跟的标识符；没有则取其后 JSON 的 "name"
  扫描窗口 2000 个字符（常量 JSON_SCAN_CHARS）：a/b 找 JSON "name" 只看标签后 2000 个字符；
    e 找 tool_sep 与 JSON "name" 都只看从特殊记号起算的 2000 个字符。2000 是一个调用参数块的量级，
    扫全文会从远处无关的 JSON 里误取名字；要找的东西落在窗口外时按取不到名字处理
  每种形态取不到名字 → 仍返回 TextToolCall（tool_name 缺席），提示里不点名
  不认：没有尖括号标签或围栏的普通单词（如正文里出现 `tool_call_seq`）

buildTextToolCallHint(text, tool_names)（纯函数，prompt.ts）:
  hit = detectTextToolCall(text)；hit 为空 → 返回空（调用方什么都不追加）
  X = hit.tool_name；清单 = tool_names 用"、"连接
  按四种情形拼提示正文（前置标记行 TEXT_TOOLCALL_HINT_MARKER）:
  - 本步零工具（tool_names 为空）：
    "如果你本意是调用工具[ X]：写在正文里的调用引擎收不到；你这一步没有任何可用工具，
     需要的内容只能从本步输入材料里取。"
  - 取到 X 且 X 不在清单：
    "如果你本意是调用工具 X：写在正文里的调用引擎收不到，工具要通过工具调用功能发起，不能写成文字；
     X 不在你这一步的可用工具清单里，可用的有：<清单>。"
  - 取到 X 且 X 在清单：
    "如果你本意是调用工具 X：写在正文里的调用引擎收不到；X 在你这一步的可用工具清单里，
     要通过工具调用功能发起，不要写成文字。"
  - 没取到名字（清单非空）：
    "如果你本意是调用工具：写在正文里的调用引擎收不到，工具要通过工具调用功能发起，不能写成文字；
     你这一步可用的工具有：<清单>。"
  四种情形末尾恒追加"如果这段是产出内容本身，忽略本提示。"

挂接（handleStepReady 的 SCHEMA_MISMATCH 循环，非 body 步骤）:
  hint = buildTextToolCallHint(记录.text, 记录.tool_names)   // 无记录或无命中 → 空
  重做位置：instruction = 原指令 + "\n\n" + SCHEMA_KICK_MARKER + "\n" + 校验报文 + (hint ? "\n\n" + hint : "")
  耗尽位置：failStep 原因 = 校验报文 + " (after 3 attempts)" + (hint ? "\n\n" + hint : "")
  // 耗尽位置的提示随失败原因进容器级重试的 L6 反馈，渲染规则见 [[prompt-assembler#^anc-exec-l2c-retry-feedback]]
  // 短档重做 prompt 按 SCHEMA_KICK_MARKER 摘到末尾，提示在摘出段内，随之保留
```

**据此可判的四个例子**：

| 场景 | 结果 |
|---|---|
| Ling 实撞回放：act 步可用 write、listdir，正文写 `<tool_call>bash…`，产出要对象被拒 | 重做指令里校验报文原样在场，其后提示点名 bash 不在清单、列出 write 与 listdir、以"忽略本提示"收尾 |
| 同一段文字作为 text 型产出，一次通过校验 | 零提示（不进 SCHEMA_MISMATCH 循环） |
| 产出被拒，但正文没有任何工具调用形态（如 "not a number"） | 重做指令与改前逐字相同 |
| 单发 reason（零工具）正文写 `<tool_call>read …` 被拒 | 提示说这一步没有任何可用工具、只能从输入材料里取 |

**已知局限**（作者拍的第一层边界，如实记下）：正文写了工具调用、而产出类型是 text 从而校验通过时，模型交出的就是那段文字，本机制不管——这正是"通过校验的产出不碰"的代价，换来的是零误报改写合法产出。

**工具循环 tool_result 内容渲染【契约】** ^anc-exec-tool-result-render

（2026-08-27 fact-check 真机实撞——0032 首跑 8 个事实点全判 not_found,真因是引擎渲染不是检索失败）：无 body act 的 LLM 工具循环把工具结果注回 LLM 时，`tool_result` 块的 `content` 必须是**文本**（Anthropic 协议要求 string 或 content-block 数组）。

而 ToolResult.result 有两种形态：字符串（binding 层原始 text），或**对象**——CompositeToolProvider 的 unwrap 解包与 output_schema 裁剪通过面返回的就是裁剪后对象（`content_type: 'json'`，见 [[tool-interface#^anc-exec-tool-shape-check]]）。契约：

- **对象结果 → `JSON.stringify` 序列化后注入**——与 formatInputs 对对象输入的既有渲染同一形态（LLM 消费面统一 JSON 文本）；
- **字符串结果 → 原样注入**（既有行为零变化）；
- **失败结果同规则**（错误面 result 按 binding 契约恒为字符串，但防御性同判——对象错误也序列化，不出 `[object Object]`）；
- **`hint` 旁注追加在文本尾部**（2026-10-12 语义审计 #25,作者拍甲案）：ToolResult 带 `hint` 时,注入 LLM 的 content = 渲染后的 result 文本 + 换行 + hint 原文;hint 不参与 `content_type` 判定,也不进 hoplog 的 result_preview 之外的任何机械通道。首个用户 listdir 空目录（result 纯 `[]`,hint 带"目录存在但为空…"明示语）——修前把明示语塞进 result,JSON 消费端全炸;
- **禁止 `String()` 直转对象**——产物是 `"[object Object]"`：工具明明成功返回了完整结构，LLM 收到的却是 15 字符占位符，只能如实报"结果不可解析"。
  - 失败形态极隐蔽：run 结构上全绿（工具 success、步骤 completed、终态 completed），败因藏在业务产出里;
  - 实撞：websearch-brief 的检索走 act body 通道②结果直落变量空间不经此渲染，同一工具面同一注册文件全好；fact-check 的检索走无 body act 通道④，每次调用都成功、每次注入都是 `[object Object]`，8 个事实点全判 not_found；
- **同族第二消费点 = BodyInterpreter 的 TOOL_EXEC_ERROR 报文**（act-body-interpreter.ts，通道②的失败面）——失败 result 经 in-process 模块守卫（只核 success 类型不核失败面 result 类型）与宿主注入 provider 两个口子可为对象，报文受众是 FailRecord→replan 与人，占位符同样吃掉适配依据，同判 JSON 序列化（review 二轮抓的 String() 残留）。
  - 三处消费点（工具循环注入 / executeCallTool 失败报文 / TOOL_EXEC_ERROR 报文）判型三目逐字同形态。

> act/commit 的执行已结构化（hop_python body，见 [[act-body#^anc-exec-act-body-interp]]）：有 body 走 `BodyInterpreter` 确定性执行（无 LLM）、**跳过 SCHEMA_MISMATCH 算子级重试**（body 非 LLM 且确定性，重做产出一样的不匹配）；无 body 回退 `executeActWithTools` 的 LLM 循环（存量零回归）。
> - 算子级 SCHEMA_MISMATCH 重试本节落地范围＝无 body 的 reason/check/act + 复用模式 done 打回；工具瞬时失败重试归 ToolProvider 内部。
>
> **`[act free]` 角色档分道（2026-08-22 随概念 free 档新增,概念 [[../concepts/HopSpec V3核心规范#^anc-step-act]]）**：无 body 的 act 执行路径不变（executeActWithTools LLM 循环）,角色指引按 free 分道,**两条消费线同源**（prompt.ts `actRoleKind` 选档 + `roleGuideText` 取档文本）。
> - review 实抓初版只接了 hoplog 记录线,standalone 真实 API 请求零角色指引,free/非 free 请求逐字节同构,设计落空。消费线两条：
> - ①**standalone 请求线**——executeActWithTools 把角色档文本注入 system 尾块（易变面,不碰稳定块缓存前缀;commit 步取 commit 档;**尾块=角色段单档,不含 L0 世界观本体**——buildSystemPrompt 已发过一份 L0,尾块再带整份即同请求重复发送,2026-08-31 作者对 probe hoplog 实抓该形态每请求多烧约 1.5K 字符）;
> - ②**hoplog 记录线**——engine recordStepStart 的 prompt 渲染同选档。
>
> **标 free**：任务执行档,并明令禁止不可逆动作（free 不可作提交载体——作者钉"act free 不能有 commit 语义"）;[act free] 语法关键词照旧（作者面词汇,作者懂它对照带 body 的 act）。
> - **"自由"一词从执行 LLM 可见面退场**——2026-08-31 作者定"当然去掉,否则无法无天了":free 是相对非 free 档的机制词,投给执行 LLM 被读成"可自由发挥",与 L4 硬约束对拉,thinking 型模型的思考散文污染有其贡献;
> - 档文措辞="可以推理、可以拆解步骤、需要时可以使用工具;L4 的执行说明与输出约束是任务边界,不是参考建议"。
>
> **未标 free 且无 body**：维持"确定性执行禁推理"档（B7 warn 促其补 body 或标 free——执行面不变,平滑过渡）。free 步骤工具面同 act（受控工具,requires_commit 拒）。 ^anc-exec-act-free-role

---

## API 请求构造（AssembledContext → Anthropic API）【说明】

StepDispatcher 将 PromptAssembler 产出的 AssembledContext 转换为 Anthropic Messages API 请求。这是每次 LLM 调用的核心路径。

### build_api_request 映射规则

```
build_api_request(context: AssembledContext, step_type: ExecutableStepType): ApiRequest

  // 1. system prompt（Anthropic API 的 system 参数）
  system_parts = []
  system_parts.push(context.spec_contract)                   // L1: Spec 契约（Goal + Constraints + Types + Outputs）
  if context.knowledge_context:
    system_parts.push(context.knowledge_context)             // L2: 知识上下文（可选，含 @knowledge 预检索 + 动态检索）
  system = system_parts.join('\n\n---\n\n')

  // 2. messages 数组（Anthropic API 的 messages 参数）
  messages = []

  // L3: 执行链上下文 → user message
  if context.execution_context.trim():
    messages.push({ role: 'user', content: '[执行链上下文]\n' + context.execution_context })

  // L4: 步骤输入 → user message
  inputs_text = format_inputs(context.inputs)                // 每个变量：`{name}: {value}`，null 显示为 `None`
  messages.push({ role: 'user', content: '[步骤输入]\n' + inputs_text })

  // L5: 步骤指令 → user message
  messages.push({ role: 'user', content: '[当前任务]\n' + context.instruction })

  // L6: 输出约束 → user message
  schema_text = format_output_schema(context.output_schema)  // 每个 OutputDecl：`- {name}: {type} # {description}`
  messages.push({ role: 'user', content: '[输出要求]\n' + schema_text + '\n\n请严格按上述结构输出 YAML。' })

  // 3. API 参数
  return {
    model: host_config.model ?? 'claude-sonnet-4-6',
    system: system,
    messages: messages,
    max_tokens: host_config.resource_limits?.max_output_tokens ?? 32768,   // 缺省与 DEFAULT_MAX_OUTPUT_TOKENS 同源（0084 批三勘正伪代码旧账 4096）
    temperature: select_temperature(step_type),
    tools: step_type === 'act' ? format_tools(tool_provider.list()) : undefined,
    tool_choice: step_type === 'act' ? { type: 'auto' } : undefined,
  }
```

### 序列化格式

所有层的内容以**纯文本**格式拼接，用 `[标签]` 前缀标识各层边界（非 XML/JSON）。选择纯文本而非 XML 标签的理由：HopSpec 的指令本身是自然语言，XML 嵌套增加 token 开销但不增加语义精度。

### temperature 选择

```
select_temperature(step_type: ExecutableStepType): number
  reason  → 0.3   // 结构化推理，需要稳定性但保留少量灵活性
  act     → 0.0   // LLM 生成代码/命令，需确定性
  check   → 0.0   // 验证判定必须稳定可复现
  call    → —     // call 不直接调 API（递归 run_spec）
  confirm → —     // confirm 不调 API（HITL 暂停）
  commit  → —     // commit 的 confirm 阶段不调 API；执行阶段同 act（0.0）
```

### 多输出步骤的输出解析（2026-08-06 真机实撞后补契约）

**单输出步骤**：全文即值——**但先做尾部自标签收窄**。
- **缘起**（2026-08-31 作者对打回轮基准实抓）:deepseek 思考散文+尾部 `intro: 值` 行的形态,全文即值把思考连标签整段收进变量,脏值再被 check 核错对象、被打回轮当基准;
- **形态契约**作者定"思考可以写在前面,但产出必须以 YAML 键值收尾",L4 输出段渲染格式例教此形态——教的和收的同一契约:响应里存在顶格 `声明名:` 打头的行时,从**最后一个**该形态行起收值〔含其块标量延续行〕,其前散文弃;不存在该行照旧全文即值〔宽容底线,业务文本不巧含键名字样时取最后一个顶格行也符合"值收尾"契约〕。

**收窄认三种标签行后继形态**：
- ①块标量指示符（`|`/`>` 系）→ 收延续行剥公共缩进;
- ②行内值且后无正文 → 收行内值;
- ③**空值键行+全缩进子结构**（标签行后每个非空行都带缩进=嵌套映射/列表延续）→ 收子结构行剥公共缩进（产出字符串交 coerce 归一层 yamlLoad 成结构值,与既有 coerce 分工不变——收窄管切散文,coerce 管字符串→结构）。
  - 第三种 2026-09-01 doc-review 第十四次验证实撞补——`templates_content:` 空值键行+缩进嵌套列表〔6 份模板 28KB〕,旧收窄只认块标量指示符与"行内值后无正文"两形态,嵌套子结构被判"形态含糊"原样返回,散文进值 → coerce 对散文+YAML 混合体 yamlLoad 必炸 → 字符串灌列表校验判非数组,三轮烧尽步 23;模型末轮已完全照做〔读回暂存件+顶格键块交付〕,败因纯在收窄面窄;
- 标签行后存在**顶格**非空行仍判形态含糊原样返回（顶格行=子结构已终结,后续内容归属不明,不做跨段猜测）。

**多输出步骤**：**先按 YAML 文档解析**（剥可选围栏后 yamlLoad；对象且命中任一声明键 → 按声明键提取，缺键为 null）——LLM 对"多个命名输出"天然倾向 YAML 风格作答，块标量（`key: |` 换行缩进正文）必须正确取到正文。YAML 解析不成立时回退**逐行正则**。
- 实撞案例：DeepSeek 对 coffee-week step 2 输出 `advice: |` 块——旧逐行正则把 `|` 字符本身当值，下游周报残缺、check 正确拦截、retry 耗尽;
- **围栏剥除认任意语言标签**（2026-08-24 coffee4 实撞——旧正则只认 ```yaml|yml,flash 交 ```json 剥不掉,yamlLoad 对围栏行必炸走回退;与 validator parseYamlStructure 同口径 `[a-zA-Z]*`）；
- **回退逐行认带引号键**（同案第二缺口——thinking 模型 text 被 max_tokens 掐成残 JSON 时 yamlLoad 炸走回退,而 `"seq_hit": true` 带引号键+缩进,裸 `startsWith('key:')` 不认→null;键匹配 `/^\s*"?key"?\s*:/`,值按命中长度切+剥引号。两缺口叠加=内容完好三轮全 null 烧尽子实例——DEBT-09 response 落账首次对证"模型交了什么 vs 引擎解成什么"定罪解析层）;
- 提示侧口径同批统一（L0 角色档教 YAML,见 [[prompt-assembler#^anc-exec-l0-worldview-impl]] 第 5 条——教的方向与解析先验一致,宽容收 JSON 不变）。

**散文导语+围栏的围栏内容单解（2026-08-30 doc-review 首跑实撞——多输出提取对"散文+围栏"形态三连 null 烧尽）** ^anc-exec-output-fence-content-retry

LLM 高频形态"散文导语＋```yaml 围栏包全部输出键（内含嵌套映射）"在原提取链必死：围栏剥除正则是**原地去标记**（散文保留）→ 剥后文本=散文+裸 YAML 混合 → yamlLoad 对散文行必炸 → 回退逐行正则不认嵌套映射键（`doc_analysis:` 行内无值）→ null。
- 实撞:doc-review 步 7,deepseek-v4-flash 三次产出内容完好（四问回答+七条脆弱点,质量佳）,引擎三次提取 null,SCHEMA_MISMATCH 烧尽整步——与 coffee4"内容完好三轮全 null"同病族,前两修（围栏标签放宽/带引号键）都没治到"散文残留炸 yamlLoad"这半边。

契约：整文 yamlLoad 失败或未命中声明键后、落回退逐行之前，**取首个围栏块内容单独再试一次 yamlLoad**（散文弃）——命中任一声明键即按声明键提取返回。
- 多围栏拼合不做跨块猜测照旧回退（二十五审钉不动;判据=剥除首个围栏块后剩余文本仍含围栏开栏标记——工程链 review 实证旧判据"捕获组内再现 ```"在懒惰非锚定正则下恒假守卫空转:两个规整围栏块时捕获组只含首块内容,首块含声明键的多围栏被单解采纳其余键置 null,劣于承诺的回退;旧判据是从单输出锚定正则语境抄来的,换语境失义）;
- 围栏内容也不成 YAML 再走回退逐行;
- 与单输出"签名围栏+散文弃尾"（^anc-exec-output-parse-self-labeled）同哲学：围栏就是"这块是值"的声明,散文是给人看的评注。

**值内前置引号片段的标量修复重试（2026-08-30 doc-review 首跑二撞——中文写作高频形态"键: "引号片段"接裸文"炸整文 YAML,内容完好三连判死）** ^anc-exec-output-quoted-prefix-repair

LLM 用中文写结构化内容时高频产出这种行：`risk_point: "陶寺=尧都"是证据链推定而非定论：…`——值以带引号的片段开头、引号闭合后又接裸文本。这在 YAML 文法里是非法标量（引号开头的值必须整值被引号包住）,一行即炸整文 yamlLoad。
- 实撞:doc-review 步 11（单输出 [yaml] 列表）,模型第 2/3 次输出肉眼完好（10 条风险点,质量好）,就因两三行这种形态整文解析失败、恢复阶梯"YAML 解析失败=真散文放弃恢复"直接弃,SCHEMA_MISMATCH 三连烧尽;
- 与围栏病族（^anc-exec-output-fence-recovery / ^anc-exec-output-fence-content-retry）同属"内容完好、提取层判死",但病灶在值内文法不在包裹形态。

契约：恢复阶梯的 YAML 解析失败后、放弃恢复之前,做**引号前缀行修复重试**——逐行找 `键: "…"裸文` 形态,把整值重包成合法带引号标量（内部引号转义）,修复后再试一次 yamlLoad;修复只动命中行,其余行原样;二次解析仍失败才判真散文放弃。
- 命中正则:值位以 `"` 开头、闭合引号后**紧邻**非空白字符——取严不含"引号后空格再接文字"形态:紧邻要求同时保护了 `k: "a" # comment` 这类合法行不被误重包;空格间隔的非法形态不修复,如实走原失败路径;
- 立条时四处 yamlLoad 解析点一个修复原语（同病同治）：①恢复阶梯②档（validator recoverOutputValues——声明输出的字符串值恢复）;②parseYamlStructure（validator——yaml 型 checkValue 与 coerceOutputValues 共用判据面;**注意语义**:修复接入此处=yaml 类型校验的采纳面同步放宽,含引号前缀行的字符串值修复后能过 yaml 型校验,这是有意的行为面变化不是实现细节）;③④dispatcher 多输出路径的整文与围栏内容两处（经 yamlLoadWithRepairImpl）。之后解析点扩到六处加一处诊断点,现行完整清单见下一条 ^anc-exec-output-inline-colon-repair 修复半边末项——本修复与裸冒号修复经 `repairYamlScalars` 串联,覆盖面恒相同。

**值里含英文冒号加空格的裸值修复重试（2026-09-29 hb2 qwen-flash 变体首跑实撞）** ^anc-exec-output-inline-colon-repair

模型写结构化内容时,常在不加引号的值里写出英文冒号加空格：`说明: 模式（new: 新事故, update: 状态更新）`。YAML 规定不加引号的值里不能出现"冒号加空格"（会被当成又一层键值对）,这一行就让整份 YAML 解析失败。
- 实撞:hopbuild2 头部契约门（步 4.2,单输出 yaml）,qwen-flash 7 次输出里 4 次在 mode 输入的说明值里这样写,其余内容完好;规约 4.2 正文早已明文教"说明值含英文冒号加空格必须整条加引号",模型仍 4/7 违反——与恢复阶梯"教学清不了零"同一条定律;
- 雪上加霜的是反馈误诊:校验层把"解析失败"报成"实际是散文文本",模型照着反馈去删散文、改形态,没人告诉它是哪一行的冒号,subtask 三次重试死在同一个原因上（7.5 万 tokens）。

契约（修复半边）：引号前缀行修复之后仍解析失败,做**报错行引导的裸冒号修复**——按 YAML 解析器报出的出错行号取那一行,若它是 `<缩进>[- ]键: 值` 形态、值不以引号或 YAML 结构起始符（`" ' [ { | > & * ! % @` 和反引号、井号）开头、且值里含英文冒号加空格,就把整值重包成合法带双引号的字符串（内部引号转义）,再解析一次;还失败且报错行换到了另一行同形态行,继续修（上限 32 次防御）;报错行不是这种形态即停,如实走原失败路径。
- 为什么按报错行修而不是全文扫描:块式标量（`|` 后面的多行文本,如工具面 rendered）里的行合法地含"冒号加空格",全文扫描会给它们加上引号、改掉内容;解析器只会在真正出错的行上报错,按报错行修就碰不到块式标量里的行;
- 为什么安全:块式映射里不加引号的值本来就不允许出现冒号加空格,这种行不存在"另一种合法读法",加引号是唯一的还原;
- 修复原语 `repairInlineColonScalars` 与引号前缀修复串联成 `repairYamlScalars`（先引号前缀、后裸冒号）,凡是"直载失败后试修复"的解析点都改调串联版。解析点共七处加一处诊断点,逐一列出（上一条引号前缀修复写的"四处"是它立条时的计数,之后解析点增加,以本清单为准）：
  1. validator `recoverOutputValues` 恢复阶梯第②档（声明输出的字符串值恢复）;
  2. validator `parseYamlStructure`（yaml 型 checkValue 与 coerceOutputValues 共用的判据面——修复接入此处=yaml 型校验的采纳面同步放宽,是有意的行为面变化）;
  3. dispatcher 多输出路径整文解析（经 `yamlLoadWithRepairImpl`,下同）;
  4. dispatcher 多输出路径围栏内容单解（^anc-exec-output-fence-content-retry）;
  5. dispatcher 多输出路径尾部键块单解（^anc-exec-output-tail-yaml-retry）;
  6. dispatcher 单输出自标注剥壳第四形态（空值键行加顶格列表,^anc-exec-output-parse-self-labeled）;
  7. dispatcher `analyzeCommitWith` 安全分析输出解析（^anc-exec-commit-analyzer）——分析输出的后果说明常引用 body 原文,如 `consequence: 执行 write("out/notice.md", content: notice)`,值里的冒号加空格让整段 YAML 解析失败,判断结果被误判成"无法解析"而转人工（2026-10-08 研判版真机实撞,deepseek-flash;安全分析版沿用此修复）;
  - 诊断点:validator `yamlParseFailure`——不产出值,只在修复后的文本上取报错行号与原文,供下面反馈半边点名出错行。

**同一修复的第二种命中形态:值以反引号、`@` 或 `%` 开头（2026-09-29 ppt qwen-flash 实撞）**。YAML 把反引号和 `@` 定为保留字符、`%` 定为指令起始符,不加引号的值拿它们开头,解析器同样报"bad indentation of a mapping entry"。中文写作里用反引号标出专名极常见：`content_points: \`工程实现链规范\`。先于其余一切文档……`。
- 实撞:ppt 步 4.1 逐页规格（多输出,pages 为列表）,qwen-flash 输出内容完好,一行 content_points 以反引号开头,整文解析失败 → 回退逐行正则取不到列表 → pages 为 null → 宽容度条款归一成空列表,只记一条告警;后面逐页生成零页、终检"slide 数 == 页数"是 0 == 0 照样通过,**交付了一份零页的空演示文稿,全程无报错**;
- 契约:报错行是 `<缩进>[- ]键: 值` 形态、值以反引号、`@` 或 `%` 开头时,不论值里有没有冒号加空格,都整值重包成带双引号的字符串——与裸冒号形态走同一个按报错行逐行修的循环、同一套停止条件（同行二次报错即停、非这两种形态即停、上限 32 次）;
- 为什么安全:这三个字符开头的不加引号值在 YAML 里没有任何合法读法,加引号是唯一的还原;引号、`[` `{` `|` `>` `&` `*` `!` `#` 开头的值仍不归本修复——它们各有合法语义（引号串、流式集合、块式标量、锚点、别名、标签、注释）,强行加引号会改掉合法内容。

**加引号时连同续行一起并入（2026-09-29 ppt qwen-flash 第四跑实撞）**。不加引号的值可以跨多行写:键值行后面紧跟着缩进比键更深的行,YAML 把它们当成同一个值的续行,折成一个空格接上。只给第一行加引号、续行留在原地,续行就成了孤立的一行,解析器接着在续行上报错——续行若恰好长得像 `第4站: \`架构\`。…`,还会被当成新的键值行去重包,同一行第二次报错后修复停止,整份输出照样解析失败。
- 实撞:ppt 步 4.1 修订轮,qwen-flash 输出完整 6 页,第 5 页 `content_points: 第3站: \`架构语言 HopType\`。……` 下面接一行缩进更深的 `第4站: \`架构\`。……`（模型想换行,写成了普通值的续行）;第一行按裸冒号形态加了引号,续行被孤立再被误修,pages 落空归一成空列表,4.6 打回"pages 是空的",重试烧尽,run 失败（21.7 万 tokens）;
- 契约:给第 n 行加引号时,往下收集续行——非空、缩进比该行键的起始列更深的连续行（遇到空行或缩进不深于键的行即止）;把它们去掉首尾空白后用一个空格与第 n 行的值接起来（与 YAML 对普通多行值的折行读法相同）,整值重包成带双引号的字符串写回第 n 行,被收走的续行改成空行（行数不变,反馈里的行号仍与模型原文一致）;
- 为什么安全:键值行已经有行内值时,下面缩进更深的行在 YAML 里只能是这个值的续行,不可能是嵌套映射（行内值后面不能再挂子映射）,并入是唯一的还原;没有行内值的键行（`key:` 后面空着,下面是嵌套结构）本来就不命中本修复。

契约（反馈半边）：yaml 型校验对字符串值判不合格时,**解析失败与真散文分开报**——解析器报错的,反馈写明"第 N 行（该行原文,超过 120 字截断加省略号）YAML 解析失败"与常见原因（值里含英文冒号加空格要整值加双引号、值以反引号或 @ 或 % 开头要整值加双引号、值以引号开头却没把整值包住——三条病因与修复半边的两种命中形态加引号前缀修复一一对应,修复修不好时模型从反馈里拿得到病因）,并说"只修这一行,其余内容不必改";解析成功但得到的是一段文字（不是对象或列表）的,才报"实际是散文文本"。报错行号与原文取自修复后的文本（两种修复都不增删行,行号与模型原文一致）。

**能力契约（HopTrait）**：

```
# Spec: 值里裸冒号修复
Id: yaml-inline-colon-repair
Goal: 把"不加引号、值里含英文冒号加空格"或"不加引号、值以反引号/@/% 开头"而炸掉 YAML 解析的键值行（连同它的续行）整值加上引号,让内容完好的结构化输出能被解析
Inputs:
- text % text   # 一段解析失败的 YAML 文本（已剥围栏,已过引号前缀修复）
Outputs:
- repaired % text   # 修复后的文本;一处都没修时与 text 逐字相同
Constraints:
- 只修 YAML 解析器报错的那一行,不做全文扫描（块式标量里合法的"冒号加空格"不碰）
- 该行必须是 `<缩进>[- ]键: 值` 形态,且满足两种命中之一:①值不以 " ' [ { | > & * ! % @ 反引号 井号 开头,且值里含英文冒号加空格;②值以反引号、@ 或 % 开头（YAML 保留字符与指令起始符,不加引号时无合法读法）;都不满足则停止,原样返回
- 整值用 JSON 字符串形态重包（内部双引号与反斜杠转义）,键与缩进不动,不增删行
- 该行下面缩进比键起始列更深的连续非空行是同一个值的续行:去首尾空白后以一个空格接到值后面一起重包,续行位置改成空行
- 修一行后重新解析,报错换到另一行同形态行就接着修;同一行报错两次即停;总次数上限 32
```

**类型约定（HopType）**：本条不引入新类型——输入输出都是字符串。判定用到的几个行级概念逐条定义：

- 报错行号：js-yaml 抛出的 YAMLException 的 `mark.line`（从 0 起数）,反馈里展示时加一;异常不带行号、或行号不小于总行数时,视为"没有可修的报错行";
- 键值行形态：`<缩进>[- ]<键>:<至少一个空白><值>`。键的首字符不能是空白、冒号、双引号、单引号、井号、横杠（防止 `- : :` 这类残行被当成键）,键里不含冒号;
- 键起始列：该行开头的空白字符数,**加上**列表项前缀 `- ` 的两个字符（有前缀时）——即键名第一个字符所在的列。例：`  - 说明: …` 的键起始列是 4;
- 形态①命中：值的首字符不是 `" ' [ { | > & * ! % @` 、反引号、井号、冒号或空白,且值里含英文冒号加空格;
- 形态②命中：值的首字符是反引号、`@` 或 `%`;
- 续行：第 n 行之后的连续行,每一行都非空且开头空白数大于键起始列;遇到第一条空行、或开头空白数不大于键起始列的行即止（该行不算续行）。

**关键逻辑（HopSop）**：

```
# impl repairYamlScalars(text)   # 七处解析点加一处诊断点共用的串联修复
1. [act] t = repairQuotedPrefixScalars(text)          # 第一道:引号前缀全行扫描（既有契约）
2. [act] t = repairInlineColonScalars(t)              # 第二道:裸冒号按报错行逐行修（本条）
3. [act] 返回 t                                       # 两道都没命中则与 text 逐字相同,调用方按相等判"无修复"

# impl repairInlineColonScalars(t)
1. [loop 至多 32 次]
  1.1. [act] 解析 t;成功 → 返回 t
  1.2. [branch] 取报错行号 n
    1.2.1. [case(异常不带行号,或 n 不小于总行数)] 返回 t
    1.2.2. [case(n 已修过)] 返回 t（同一行报错两次=加引号没治好,不再重复修）
    1.2.3. [case(第 n 行形态①命中)] 进 1.3
    1.2.4. [case(第 n 行形态②命中)] 进 1.3（两种形态对值首字符的要求互斥,不会同时命中）
    1.2.5. [case(else)] 返回 t（交调用方走原失败路径）
  1.3. [act] 收第 n 行下面的续行（定义见 HopType）,去首尾空白以一个空格接进值,整值用 JSON 字符串形态加双引号写回第 n 行,续行位置置空行,记 n 已修
2. [act] 32 次用尽仍未解析成功 → 返回当前 t（已修的行保留,交调用方再解析一次,多半仍失败走原失败路径）
3. 一行都没修过时返回的是入参 text 本身（逐字相同）,调用方据此判"无修复"跳过二次解析

# impl checkValue 的 yaml 分支（字符串值）
1. [act] 剥围栏 → 解析;失败则 repairYamlScalars 后再解析
2. [branch]
  2.1. [case(解析出对象或列表)] 合格
  2.2. [case(解析器仍报错)] 报"第 N 行（该行原文,截断）YAML 解析失败"+常见原因+"只修这一行"
  2.3. [case(解析出标量文字)] 报"实际是散文文本——直接返回结构本身"
```

- 测试成对：正例=hb2 实撞形态（inputs 列表项里 `说明: 模式（new: 新事故, update: 状态更新）`）修复后解出完整对象、两行同病逐行都修、yaml 型声明端到端归一成结构、dispatcher 多输出侧接线解出全键、解析失败的反馈含"第 N 行"与该行原文;反例=块式标量（`rendered: |`）里含冒号加空格的行原样不动、值以引号开头的行不归本修复（不重包）、真散文仍报"散文文本"、报错行不是键值形态时原样返回。第二种命中形态另成对:正例=ppt 实撞形态（列表项里 `content_points: \`专名\`。正文` 以反引号开头,值里无冒号加空格）修复后解出完整列表、`@` 开头同治、dispatcher 多输出侧列表输出不再落空;反例=值中间含反引号的合法行原样不动（不以反引号开头就不命中）、`&` 锚点与 `*` 别名开头的合法行不被重包。续行并入另成对:正例=ppt 第四跑实撞形态（列表项里裸冒号值跨两行,续行以反引号开头）修复后解出完整列表、该值等于两行以一个空格接起;反例=紧跟的下一个同级键（缩进不深于键）不被并入、原样作为下一个键解析。形态①的必要条件"值里含冒号加空格"另成反例:报错行是键值形态、值里没有冒号加空格（如缩进写坏的列表 `items: - a` 下接 `  - b`）→ 不修、原样返回（撤掉这个条件会把坏结构改写成一个字符串收下,形态①正例全绿看不出来）。接线面另成对:恢复阶梯第②档（recoverOutputValues）对值里裸冒号的列表经修复解出结构（正）;反馈半边断言精确行号、该行原文与三条病因,超过 120 字的行截断加省略号（正）。

**散文导语+裸 YAML（无围栏）的尾部键块单解（2026-08-31 doc-review 第十次验证实撞——提取病族第三形态,多输出侧补齐与单输出"尾部自标签收窄"同款契约）** ^anc-exec-output-tail-yaml-retry

LLM 第三种高频形态："[thinking] 思考散文＋**裸 YAML 键值块**（无任何围栏）"。原提取链必死：整文 yamlLoad 被散文行炸掉 → 无围栏,围栏内容单解（^anc-exec-output-fence-content-retry）不适用 → 回退逐行正则不认嵌套映射键（`search_results:` 行内无值,块结构在后续行）→ null → 宽容度条款把 null 归一空列表,**业务面静默空转无一处报错**。
- 实撞:doc-review 第十次真机验证步 10,deepseek-v4-flash 4 次 web_search 全成功后交出 9 条结构化对标结果（title/url/summary 齐全,含直接对冲文档核心论断的证据）,形态=[thinking] 散文两行+裸 YAML;引擎解 null 归一 [],下游风险清单退化成"对标无结果"元提示——数据在 work_zone 落盘件里,变量流里没有;
- 同 run 早前步骤 domain_candidates 同形态同死,一 run 两撞。

契约：多输出提取链在整文 yamlLoad 失败（或未命中声明键）、且围栏内容单解不适用（无围栏）后、落回退逐行之前,做**尾部键块单解**——找**首个顶格 `<声明键>:` 打头的行**（任一声明键命中即可）,从该行起截到文末,对这段单独再试 yamlLoad（经引号前缀修复原语,与其他解析点同罩）;解出对象且命中任一声明键 → 按声明键提取返回;仍不成 YAML → 照旧回退逐行。
- **与单输出"尾部自标签收窄"同一形态契约**（"思考可以写在前面,但产出必须以 YAML 键值收尾"——作者 2026-08-31 定,L4 输出格式例教的正是此形态）:单输出从最后一个自标签行收,多输出从首个声明键顶格行收（多键块内的后续键是内容不是新起点,取首不取尾）;
- 散文行含键名字样不误触:判据是**顶格**（行首零缩进）+键名+冒号,思考散文里的行内提及不在顶格位;冒号认半角,也认紧跟声明键名的全角 `：`（全角在进入本阶梯之前已被规范成半角,见下条 ^anc-exec-output-fullwidth-key-colon）;
- 三形态阶梯全景（围栏内容单解→引号前缀修复→尾部键块单解）覆盖"散文+围栏"/"值内引号片段"/"散文+裸 YAML"——共同哲学:内容完好时提取层不判死,形态修复尽头才认真散文。

**键行里紧跟声明输出名的全角冒号等同半角（2026-09-28 flash 全集实撞,作者拍 A——决策档 todo/decision/20260928-输出键行全角冒号.md）** ^anc-exec-output-fullwidth-key-colon

模型用中文思考、收尾写输出键时,常把键名后的冒号顺手打成全角：`slide_ok： true`。YAML 只认半角冒号,这一行就不是键值对;上面各级解析都找不到声明键,最后判"声明的输出未产出"让模型重做——而它重做还是写全角,重试次数就这样白白用光。
- 实撞：glm-5.3-flash 跑 ppt,每页自检步要输出 `slide_ok` 与 `slide_issue`,四项判据逐条核完、结论"判定通过",最后一行写成 `slide_ok： true`,连续三次重试都这样写,第 6 页一页烧 22.9 万 tokens,整格约 29 万 tokens 耗在这一个标点上;
- 全集日志里 glm-flash 在 6 个任务里写过全角冒号键行（ppt 15 处、deep research 6 处、hb2 6 处、deep validate S 4 处、fact check M 1 处、合同 route 1 处）,qwen-flash 零处;
- 库里全角冒号容忍已有两处（规约解析的工具授权行 i18n.md、hopbuild2 声明区）,模型输出键行这一处原先没有规定,代码只认半角。

**现行规则**：parseStepOutput 在空响应闸之后、任何取值路径之前,先对响应文本做一次**键行冒号规范化**,之后单输出与多输出的全部解析路径（整文 YAML、围栏内容单解、尾部键块单解、逐行回退、单输出自标签收窄）都吃规范化后的文本。规范化只动一个位置：
- **哪一行**：顶格（行首零缩进）、以某个**本步声明过的输出名**打头的行,输出名可带一对双引号（`"slide_ok"：`）;
- **动哪个字符**：输出名（及可选的空格/制表符）后面紧跟的那一个全角冒号 `：`,换成半角冒号加一个空格 `: `——加空格是因为 YAML 里 `key:true`（冒号后无空格）不算键值对,模型写的 `report_ok：true` 正是这种紧贴形态;
- **不动什么**：值里的全角冒号（`slide_issue： 结论：通过` 只换第一个）;带缩进的行（块标量正文、嵌套结构里的行,那是内容不是本步的键行）;不以声明输出名打头的行（散文里的"结论：通过"）;半角冒号的行原样。

**单输出"全文即值"的保真**：单输出步骤没有标签行时是全文即值——此时值里恰好有一行 `输出名：…` 也属内容,不能被改写。所以单输出路径的规则是：自标签收窄**真的剥下了标签**（返回值与规范化后全文不同）才采用收窄结果;没剥（返回的就是全文）则返回**原文**,规范化对值零影响。

为什么只认"声明过的输出名紧跟的冒号"：这个位置的全角与半角在语义上没有任何歧义——模型要写的就是这个键,只是标点打成了全角。引擎在这里替它规范标点,不是猜它的意思;而值里的全角冒号是内容,一个都不碰。误触面与半角完全相同（散文里恰好有一行以输出名加冒号顶格打头,半角时本来就会被当成键行）,不新增一类风险。

提示侧配套：交付格式说明在中文描述的步骤里多一句"键名后的冒号用半角"（见 [[prompt-assembler#^anc-exec-format-example-structural]] 同批次追加的"半角冒号提示"段）——解析侧兜住已经写成全角的,提示侧减少写成全角的次数。

**能力契约（HopTrait）**：

```
# Spec: 输出键行冒号规范化
Id: output-key-colon-normalize
Goal: 把模型响应里"顶格声明输出名 + 全角冒号"的键行改成半角冒号,让后续解析路径都能认出这个键
Inputs:
- text % text           # 模型响应的正文全文（已过截断闸与空响应闸）
- output_names % [line] # 本步声明的全部输出名
Outputs:
- normalized % text     # 规范化后的全文;没有命中行时与 text 逐字相同
Constraints:
- 只改顶格、以某个 output_names 成员（可带一对双引号）打头、后面（隔着可选空格/制表符）紧跟全角 `：` 的行,且每行只改这一个字符
- 全角 `：` 换成 `: `（半角冒号加一个空格）
- 带缩进的行、不以声明输出名打头的行、值里的全角冒号一律原样
- 输出名按字面匹配（正则元字符转义）,`slide_ok` 不命中 `slide_ok_extra：`
```

**类型约定（HopType）**：本条不引入新类型——输入是字符串与声明输出名列表（OutputDecl[] 的 name 字段）,输出是字符串。

**关键逻辑（HopSop）**：

```
# impl parseStepOutput 的取值前处理
1. [act] 截断闸、空响应闸照旧（本条不改这两道闸）
2. [act] normalized = 输出键行冒号规范化(text, schema 的全部 name)
3. [branch] 按声明输出个数
  3.1. [case(单输出)]
    3.1.1. [act] unwrapped = unwrapSelfLabeled(normalized.trim(), name)
    3.1.2. [act] 值 = (unwrapped 与 normalized.trim() 不同) ? unwrapped : text.trim()   # 没剥标签=全文即值,返回原文
  3.2. [case(多输出)] 整文 YAML → 围栏内容单解 → 尾部键块单解 → 逐行回退,四级都吃 normalized（各级判据不变）
```

- 测试成对：正例=`slide_ok： true` 两输出步取到布尔 true、`report_ok：true`（紧贴无空格）取到 true、单输出散文+`名： 值` 尾行收到值、带双引号键 `"slide_ok"：` 取到;反例=值里的全角冒号原样（`slide_issue： 结论：通过` 取到 `结论：通过`）、单输出无标签全文即值时值里 `名：…` 行原样、带缩进的 `  名：` 行不改、`slide_ok_extra：` 不命中 `slide_ok`。

**长输出请求超时随 max_tokens 缩放** ^anc-exec-nonstreaming-timeout

**输出预算解析（按模型上限发,产出约束归 spec）【契约】** ^anc-exec-output-budget

（2026-08-27 作者定"按 LLM 的上限去设置,Ln 门限自己控制"——fact-check 真机实撞:16384 旧缺省对推理型模型两头紧,thinking 烧满全池正文零字节 OUTPUT_TRUNCATED,retry 白烧两轮;"给引擎设小池防费用"是弱模型时代的姿势,按用量计费下压池只制造截断不省钱）。max_tokens 解析链（specific→general 第一命中生效）：

1. env `HOPJIT_MAX_OUTPUT_TOKENS`（显式覆盖恒最高）
2. `resource_limits.max_output_tokens`（run/宿主级显式配置）
3. **provider 声明 `max_output_tokens`**（ProviderEntry 可选字段,schema [[shared-providers#^anc-config-standalone-schema]]——按当次请求路由到的 service 取;standalone 注入面经 `{SERVICE_ID}_MAX_OUTPUT_TOKENS` env 快照透传,与 BASE_URL/PROTOCOL 三键同族）
4. 内置缺省 **32768**（2026-08-27 从 16384 抬升——16384 是 8 月中弱模型时代定的,推理型模型 thinking+正文共池下太紧;各主流模型输出上限已在 32K-64K 档,缺省不该替模型收窄）

**原则**：引擎的 max_tokens 是"物理上限",不是"产出配额"——产出多大由 spec 各步骤的输出声明（Ln 门限）约束,LLM 自然按需产出,上限只防失控。**`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 从链中摘除**（2026-08-27 同批——该 env 的语义是"CC 宿主管自己 agent 的输出",引擎捡它=主对话 agent 的设置泄漏给引擎:用户压 CC 输出省帐,standalone 提取步跟着被压烧穿;同名变量跨两受众是误配面,0.x 干净摘）。

**观测**：HopLog llm 块记当次请求的 `max_tokens`（观测记录点在事实边界——发送口抄实际请求参数;实撞:烧穿排障时"上限是多少、哪级来的"只能翻代码答）;同块记响应的 `stop_reason` 原值,缺席记 `absent`（todo/0121——端点以什么原因收尾只有这一处能看到,^anc-exec-output-abort-loud）。

（2026-08-18 buildtest 实撞——输出预算升 32768 后 SDK 拒发）：Anthropic SDK 对非流式请求按 max_tokens 估算耗时（`max_tokens/128000 × 60min`）,超 10 分钟且 **client 级 timeout 未设** → 抛 `Streaming is required for operations that may take longer than 10 minutes`（预检拒发,请求根本没出网——engine 层收到的是步骤 fail）。
- **预检只看 client 构造 `_options.timeout`,per-request 第二参不进预检判断**（v0.8.7 首修落在 create 第二参=修错层,复跑实证同错;SDK 0.111 源码 `timeout = this._client._options.timeout; if (!body.stream && timeout == null) → 预检抛`）。

契约：**客户端的等待上限按输出上限换算，公式只有一处**——`nonstreamingWaitMs(maxTokens) = max(10min, ceil(maxTokens/128000 × 60min))`（protocol-openai.ts 导出,与 SDK 估算同式）。两个用法：
- **client 级等待上限**（`nonstreamingTimeoutMs(serviceId)`）= `nonstreamingWaitMs(resolveMaxOutputTokens(serviceId))`——按这个客户端所属 service 解析输出上限（缺省客户端传 `'default'`,与实际请求取 max_tokens 的解析同源）。它给三样东西用：SDK 构造期 timeout（解锁 SDK 预检）、undici 连接设置的两个时限（见下"连接设置"）。这个客户端发出的任何请求，max_tokens 都不超过这个解析值，所以 client 级上限恒 ≥ 单次请求的上限;
- **单次请求等待上限** = `nonstreamingWaitMs(request.max_tokens)`——三种协议的 create 都作为 SDK 第二参 `{ timeout }` 传入（真实 HTTP 等待按请求精确）;同一个数也是 callLlmWithRetry 判"客户端等待超时"和报错文案里"N 分钟"的依据（^anc-exec-api-retry "客户端等待超时"条）。
- 缺省 32768 换算约 15.4min——2026-08-27 缺省抬升随更,^anc-exec-output-budget;大预算按同一换算放宽,client 级已设即跳过预检;
- 原注记"client 级 timeout 用全局解析不带 serviceId,provider 声明更大上限时是已知宽松边"已消解：v0.36.0 起 client 级按 service 解析;
- 不引入流式（IR 形状不变,mock 面零迁移;流式改造不在 todo/0117 范围）。

**SDK 之下还有一层 300 秒的时限：连接设置（v0.36.0,todo/0117,2026-09-27 作者拍方向 A"新增 undici 依赖"）**：两个 SDK 都走 node 内建 fetch,内建 fetch（undici）对"等响应头"有自己的缺省时限 300 秒（headersTimeout）,对"两次收到数据之间的间隔"也是 300 秒（bodyTimeout）。非流式请求要等模型整段生成完才回响应头，所以生成超过 300 秒的请求一律在第 300 秒被掐断，上面给 SDK 的长 timeout 根本轮不到生效。
- 实撞出处：glm-5.3-flash（思考恒开，单发 3—8 分钟）变速箱测评在约 300 秒处报 `UND_ERR_HEADERS_TIMEOUT`;本机复现：假服务器 310 秒才回，SDK timeout 设 15 分钟、maxRetries 0,301.6 秒报 `APIConnectionTimeoutError`;
- 修法：新增运行时依赖 `undici@^7`,用它的 `Agent` 建一个连接设置，两个时限都取 client 级等待上限（同源，不另立数字），经 SDK 构造选项 `fetchOptions: { dispatcher }` 传入。两个 SDK（@anthropic-ai/sdk 0.111、openai 7.4）的构造选项都有 `fetchOptions`（类型 MergedRequestInit,含 `dispatcher` 字段），SDK 每次请求把它并进 fetch 的第二参;
- **五个客户端构造点全部带上**：构造函数里的缺省客户端（anthropic / openai-chat / openai-responses 三选一）与 getClientForService 里按 service 建的客户端（同样三选一）。openai 两个构造函数 `makeOpenAiClient` / `makeOpenAiResponsesClient` 的入参加 `waitMs`（client 级等待上限），由它们自己建连接设置;
- 同一批次三个客户端的 SDK 构造期都给 `maxRetries: 0`——理由见 ^anc-exec-api-retry "SDK 内部重试关掉"条。

**能力契约（HopTrait）**：

```
# Spec: 长等待连接设置
Id: long-wait-fetch-options
Goal: 给 SDK 客户端一份连接设置，让 node 内建 fetch 等响应头、等数据的时限与引擎的等待上限一致，
      不再被 undici 缺省的 300 秒先掐断
Inputs:
- wait_ms % int  # client 级等待上限（毫秒），= nonstreamingTimeoutMs(serviceId)，不另立数字
- extra % yaml   # 可选。undici Agent 的其它构造选项；只给测试注入假连接（connect）用，生产不传
Outputs:
- fetch_options % yaml  # { dispatcher: undici Agent }，原样作为 SDK 构造选项 fetchOptions
Constraints:
- headersTimeout 与 bodyTimeout 恒等于 wait_ms；extra 里带同名键也被 wait_ms 盖掉
- 五个客户端构造点（缺省客户端三协议 + 按 service 建客户端三协议）全部经本函数取连接设置，不各写各的
- 同一个客户端里 SDK 构造期 timeout 也取 wait_ms（Anthropic 用它解锁预检；OpenAI 同值）
- 每个客户端一份连接设置（Agent 自带连接池，随客户端缓存复用）
```

**类型约定（HopType）**：

```
HopType: LongWaitFetchOptions
  Id: long-wait-fetch-options-type
  Fields:
    - dispatcher % yaml  # undici Agent 实例，构造参数：
                        #   headersTimeout: int  等响应头的最长时间（毫秒）= wait_ms
                        #   bodyTimeout: int     响应体两次收到数据之间的最长间隔（毫秒）= wait_ms
                        #   其余 Agent 选项取 undici 缺省（测试可经 extra 注入 connect）
```

**HopSop（客户端构造）**：

```
# impl 构造一个协议客户端(serviceId, protocol, 凭证)
1. [act] wait_ms = nonstreamingTimeoutMs(serviceId)   # 缺省客户端 serviceId='default'
2. [act] fetch_options = longWaitFetchOptions(wait_ms)
3. [branch] 按 protocol 建客户端
  3.1. [case(anthropic)] new Anthropic({ 凭证..., timeout: wait_ms, maxRetries: 0, fetchOptions: fetch_options })，再经 wrapAnthropicClient 包一层
  3.2. [case(openai-chat)] makeOpenAiClient({ 凭证..., waitMs: wait_ms })——内部 new OpenAI({ 凭证..., timeout: wait_ms, maxRetries: 0, fetchOptions: longWaitFetchOptions(wait_ms) })
  3.3. [case(openai-responses)] makeOpenAiResponsesClient({ 凭证..., waitMs: wait_ms })——同 3.2
4. [act] 每次 create：SDK 第二参 { timeout: nonstreamingWaitMs(request.max_tokens) }
```

- 为什么单次请求的 timeout 可以小于连接设置的时限：单次请求 timeout 管"等响应头"这一段，到点由 SDK 自己中止;连接设置只要不比它短就不会抢先掐断。反过来如果连接设置比单次请求短，就又回到了本条要治的病。
- undici 版本：`^7`（装入时 7.30.0,要求 node ≥ 20.18.1;本库 engines 写 node ≥ 20,node 20.0—20.18.0 装包时 npm 只报 engines 警告不拦——属已知边界，见 todo/0117 处置记录）。

**空响应响亮失败** ^anc-exec-output-empty-loud

**现行规则**：parseStepOutput 在截断判之后、取值之前，判 `text.trim()` 为空 → **抛 EMPTY_OUTPUT 响亮失败**（消息说明响应全空、含 output_tokens 实数）。反馈归因正确——"你没产出任何内容"恰是事实，与截断场景的错误归因相反。
- 实撞出处：2026-08-31 doc-review 第十二次验证——LLM 返回空文本且 stop_reason 正常收尾，`text.trim()` 得空串照常收为值，`domain_name: ""` 状态 completed 零重试零报错，空串灌进下游拼出 `DocReviewers//reviewers` 残路径;
- 截断闸 ^anc-exec-output-truncation-loud 只认 `stop_reason === 'max_tokens'`，正常收尾的空响应原本没有任何闸——输出提取病族第四形态：前三形态是"内容完好提取层判死"，本形态相反，内容真缺提取层放行。

**步级重发半边**（2026-09-07 hopissues/0072 实撞后兑现）。EMPTY_OUTPUT 属瞬时模型抖动（output_tokens 个位数的空喷，重试即愈——与 SCHEMA_MISMATCH 算子级重试同哲学同层）。
- 实撞出处：首版条款写"触发既有重试通道"但实现落进 executeStep 大 catch 直接 failStep 点燃容器——check 步瞬时空响应被当判 false 整容器重跑，叠加聚合账不清零自激死锁，hopkb 309 实例 3 例好实例报废。

处置规则分条如下：

- **覆盖口径=步骤执行层的每一个模型调用口**都经空响应重发包装（2026-09-07 作者拍"全口径罩"）。replan 流水线不属步骤执行，自有 ADAPTIVE_PIPELINE 闸不在本罩；
  - 实撞出处：原形态只包 handleStepReady 首发，同步骤内 SCHEMA 重试轮与 lack_of_info 补检索重发直调 executeStepWithTimeout，撞空响应仍一发点燃容器，0072-review 实抓两扇留窗；三口全包后无死角；
- **重发机制**：包装识别 `EMPTY_OUTPUT:` 前缀走步级重发，拦在"落 failStep 的大 catch"之前——网络暂停等其它异常原样穿透归各自通道；instruction 附一行"上一次响应为空,请完整产出"防同因，重发 executeStepWithTimeout；
- **计数口径=每个调用口独立**，各自至多 EMPTY_RETRY_MAX=2 次（首发+重发共三次，与 SCHEMA_RETRY_MAX=3 对齐）——空响应是瞬时抖动，与外层处于第几轮 schema 重试无关，共享池会让先撞的口子吃光后撞口子的自救额度；耗尽才 failStep 转容器级 retry（闸不软化——空响应仍然一个都收不下，变的只是"收不下之后先自救再上报"）；
- **instruction 三出口全复原**（成功/非 EMPTY 异常/耗尽）——提醒残留会成为后续重试轮的错误归因基线；包装捕获的 baseInstr 是进入时版本（SCHEMA 重做口进入时已含反馈，复原到反馈版恰是正确语义）；
- **paused 穿透**：paused 属 executeStepWithTimeout 的正常返回值不是异常，原样穿透包装层，不重发不计数；
- **留痕**：每次重发落一条 recordWarn `[empty-retry]`——重发是异常处置，观测轨迹不可缺；
- **模式分工**：本闸与步级重发均属独立模式 dispatcher 的产出消费链，复用模式的产出把关归 caller（与 ^anc-exec-operator-retry 的模式分工同构）；body 步不经 LLM 无此形态天然不涉。

**边界**：只拦"整个响应文本为空/纯空白"——模型显式产出 `键: ""` 空值属合法产出照常收（空串可以是业务值，全空响应不是）；多输出路径同罩（全空文本走到回退逐行全键 null，列表宽容度条款会把 null 归一成空列表，业务面同样静默空转）。

**输出截断响亮失败** ^anc-exec-output-truncation-loud

（2026-08-18 buildtest 实撞——静默截断产出错误归因反馈）：`stop_reason=max_tokens` 表示输出被上限掐断。
- thinking 型模型可把全部输出预算烧在推理上,text 空——实撞:v4-pro 16384 tokens 全 thinking,node_result="" 被当正常值收下,下游 validate 报"片段为空",重试反馈教模型"你没产出"=错误归因,同因必死。

契约：解析输出前先判 stop_reason（判定函数 classifyStopReason 见下"非正常停止的判定与处置"）——`max_tokens` → **抛 OUTPUT_TRUNCATED 响亮失败**（报文必含两个数：本次请求实发的 `max_tokens` 与响应实际的 `output_tokens`；建议按下面"端点自带上限的分辨"分两种写）——部分产出也不收（截断值是残值,收下=毒值下游）;openai 协议 `finish_reason=length` 已映射同值同治。
- **覆盖面=全部 LLM 响应消费点**：parseStepOutput（reason/check/act 终轮）、pipelineCall（replan 三段——二十五审抓:绕过 parseStepOutput,截断半截产出静默入 replan）、**工具循环带 tool_use 的轮次**（二十六审抓:掐在工具参数生成中途时半截参数会被直接拿去执行工具——write 类工具吃残缺参数比收残值更危险,判在工具执行前）;
- 与守卫『禁止静默跳过』同根：预算不够是环境问题,须显式失败指路,不许装作模型没干活。

**非正常停止的判定与处置（todo/0121,2026-10-08）** ^anc-exec-output-abort-loud

截断闸原先只认 `max_tokens` 一个值。端点以别的原因中途掐断（实撞疑似内容审核：智谱端点返回半截正文,usage 全零）时,半截输出被当正常产出解析,报 SCHEMA_MISMATCH 把病因指错,重试白烧。现在解析前按下表判 `stop_reason`,三个消费点（parseStepOutput / pipelineCall / 工具循环带 tool_use 的轮次）共用一个判定函数：

```
# impl classifyStopReason(stop_reason)
# 入参是 IR 的 stop_reason 字符串（anthropic 原值;openai 协议经下方映射）;返回 'normal' | 'truncated' | 'aborted'
1. [条件(stop_reason ∈ {end_turn, tool_use, stop_sequence} 或 缺席/空)] 返回 normal
   > 正常收尾的三个值与缺席——缺席按正常收（mock 面与旧端点不带该字段,不能因为没字段就判死）
2. [条件(stop_reason == max_tokens)] 返回 truncated
   > 既有截断闸：OUTPUT_TRUNCATED / THINKING_EXHAUSTED 分流照旧,步级瞬态首撞免扣
3. [其他] 返回 aborted
   > refusal / pause_turn / content_filter 以及任何没见过的值——端点主动停止,产出不完整
```

aborted 的处置：三个消费点都在解析前抛 `OUTPUT_ABORTED: 端点以 <原值> 原因停止输出,产出不完整（<消费点>）——多半是内容触发了端点审核;下一轮请换措辞（去掉可能触发审核的内容）再试一次,仍断则换端点`,半截产出不收、不进 SCHEMA 反馈。失败档次是**步级瞬态**（2026-10-08 review 修复改定;批次一曾定事务级）：handleStepReady 对它不做特殊处理,普通 failStep,前缀 `OUTPUT_ABORTED:` 登在引擎的步级瞬态清单 TRANSIENT_PREFIXES 里——同一步同一前缀首撞免扣容器 retry 预算、下一轮带着这条失败反馈重跑,复发起照常扣预算（[[exec-engine#^anc-exec-deterministic-no-retry]] 口袋归类表与免预算有界化条）。为什么是步级瞬态不是事务级：作者 2026-09-04 拍定的归类判据是"失败根因在本轮输入还是在结构/子层"——审核类停止的根因就是本轮输入里的内容,下一轮的失败反馈明说"换措辞",输入就变了,墙未必还在;这与 OUTPUT_TRUNCATED（下轮反馈"别整篇重写"）是同一类。事务级口袋留给根因在结构或子层、任何一轮重跑都同因的失败（深度超限 / 子层烧尽 / 材料总量超窗 / 死端点）。

openai 协议的映射改为**原值透传**：chat 协议 `finish_reason` 中 `length → max_tokens`、`stop → end_turn`、`tool_calls / function_call → tool_use`,其余（`content_filter` 等）原值进 IR 的 stop_reason（旧形态把非 length 一律映成 end_turn,content_filter 被吞成正常收尾）;responses 协议 `status=incomplete` 且 `incomplete_details.reason=max_output_tokens → max_tokens`,其他 incomplete 原因原值透传（如 `content_filter`）,completed 按有无工具调用映 tool_use / end_turn。

观测两条：① HopLog llm 块记 `stop_reason` 原值（映射前的协议原值不另记——IR 里非 max_tokens/end_turn/tool_use 的值就是原值）,缺席记 `absent`,与 max_tokens / thinking 同样恒显式（^anc-exec-output-budget 观测条）。记录点三处（parseStepOutput 主路径 / 工具循环轮 / replan 流水线段 pipelineCall——第三处 2026-10-08 todo/0151 补,此前是盲区）;② 响应 usage 的 input_tokens 与 output_tokens 同为 0 而正文非空时,记一条 warn `[usage-zero] 响应 usage 全零而正文非空——端点可能未按正常路径收尾,是中途掐断的旁证`,只做旁证不改判定。

**端点自带上限的分辨（todo/0113,2026-09-26 作者拍 A 案"先量再批换端点"）**

为什么要分：有的端点对单次响应自带输出上限，而且忽略请求里的 max_tokens。
- 实撞：qwen3.8-27b 经阿里云百炼 claude-code-proxy 端点（provider `bailian_qwen`）,请求写 max_tokens=65536，响应回来 `stop_reason=max_tokens`、`output_tokens=4096`。旧报文只写 output_tokens 并叫人"调大 HOPJIT_MAX_OUTPUT_TOKENS 或 resource_limits.max_output_tokens"——而本地上限早已是 65536，调多大都没用。宏观任务验收与成绩 T7 ppt 生成的步骤 4.2 与 T2 fact check L 的步骤 5.2 两格都照这个误导重试（后者三次都截在 4096），两跑约 10 万 tokens 白烧；
- 本地上限掐断时 output_tokens 等于请求值（Anthropic 协议计数含 thinking 块）；端点自带上限掐断时 output_tokens 明显低于请求值。报文同时写出两个数，读者一眼就能分辨；引擎再按数值替读者判一次，给出对症的建议。

判据（纯数值比较，不做语义判断）：
- 请求值与 output_tokens 都拿得到，且 `output_tokens < 请求值 × 0.9` → 判"端点自带上限"；
- 为什么阈值是 0.9：本地上限掐断时两数相等，留一成余量容纳个别端点计数上的小出入；实撞的 4096 对 65536 相差 16 倍，阈值取 0.5 到 0.95 结论都一样，不敏感；
- 否则（两数相近，或任一个拿不到）→ 按本地上限掐断写。

三个抛错点共用一个导出函数 **`truncationAdvice(requestedMaxTokens, outputTokens)`**（src/dispatcher.ts 顶层），由它产出报文里"两个数 + 建议"这一截；各站点只在前面拼自己的站点半句：
- parseStepOutput（reason/check/act 终轮）：`OUTPUT_TRUNCATED: 输出被 max_tokens 上限掐断，产出不完整不可用`；
- pipelineCall（replan 流水线段）：`OUTPUT_TRUNCATED: replan 流水线段输出被 max_tokens 掐断`；
- 工具循环带 tool_use 的轮次：`OUTPUT_TRUNCATED: 工具循环轮输出被 max_tokens 掐断，工具参数可能残缺,不执行`。

请求值取"产生这条响应的那个请求"实发的 max_tokens：
- pipelineCall 取 `request.max_tokens`；
- 工具循环两处（带 tool_use 轮、终轮进 parseStepOutput）取 `loopRequest.max_tokens`（重发时只换 messages，max_tokens 不变）；
- executeReasonOrCheck 取实际发出请求的 max_tokens——上下文溢出后改用激进重组的 retryRequest 重发时，取 retryRequest 的值；
- parseStepOutput 手里没有请求，由调用点经可选第四参数 `requestedMaxTokens` 传入；不传（如测试直调）按"拿不到"处理。

`truncationAdvice` 产出的三种文字（X=请求值，Y=output_tokens，拿不到的数位写 `?`）：
- **本地上限掐断**：`（本次请求上限 max_tokens=X，实际输出 output_tokens=Y）——调大 HOPJIT_MAX_OUTPUT_TOKENS、resource_limits.max_output_tokens 或 provider 的 max_output_tokens`
- **端点自带上限**：`（本次请求上限 max_tokens=X，实际输出 output_tokens=Y）——实际输出远低于请求上限，是端点自己的输出上限掐断的，与本地配置无关，改本地上限配置没有用。核实端点能力（探针 model-gearbox/probes/run-output-cap.mjs）、换不带此上限的端点，或把本步产出拆小`
- **回落（任一个数拿不到）**：与本地上限掐断同文，拿不到的数位写 `?`，例：`（本次请求上限 max_tokens=?，实际输出 output_tokens=16384）——调大 HOPJIT_MAX_OUTPUT_TOKENS、resource_limits.max_output_tokens 或 provider 的 max_output_tokens`

失败语义不变：前缀仍是 `OUTPUT_TRUNCATED:`，仍在 engine 的步级瞬态前缀里按既有规则重试（首撞免扣预算）；反刍分流（THINKING_EXHAUSTED）照旧先于本报文判。
- 为什么本批次不改重试：端点自带上限时重试大概率同样截在同一个数（T2 实撞三次都截 4096），改成直接失败能省重试钱；但那是失败语义变更，作者这次只拍了报文与探针，重试行为留作后续观察项（记在 todo/0113 处置记录）。

**能力契约（HopTrait）**：

```
# Spec: 截断报文
Id: truncation-advice
Goal: 输出被 max_tokens 掐断时，报文写出请求上限与实际输出两个数，并按两数关系给出对症建议——
      端点自带上限时明说"改本地配置没有用"，本地上限掐断时指路三个调参位
Inputs:
- requested_max_tokens % int  # 产生本响应的那个请求实发的 max_tokens；拿不到=缺席
- output_tokens % int  # 响应 usage.output_tokens；拿不到=缺席
Outputs:
- advice % line  # 拼在站点半句后面的"（两个数）——建议"一截
Constraints:
- 两个数恒写出，拿不到的写 ?
- 判定只做数值比较（output_tokens < requested_max_tokens × 0.9），不看响应内容
- 不改前缀、不改失败语义；三个抛错点都经本函数出建议，不各写各的
```

**HopSop（判据分支）**：

```
# impl truncationAdvice(requestedMaxTokens, outputTokens)
1. [act] X = requestedMaxTokens 是有限数 ? requestedMaxTokens : '?'；Y = outputTokens 是有限数 ? outputTokens : '?'
2. [act] nums = "（本次请求上限 max_tokens=X，实际输出 output_tokens=Y）"
3. [branch] 判端点自带上限
  3.1. [case(X 与 Y 都是数 且 Y < X × 0.9)] 返回 nums + "——实际输出远低于请求上限……或把本步产出拆小"（全文见上）
  3.2. [case(else)] 返回 nums + "——调大 HOPJIT_MAX_OUTPUT_TOKENS、resource_limits.max_output_tokens 或 provider 的 max_output_tokens"
```

端点的真实输出上限由探针 `model-gearbox/probes/run-output-cap.mjs` 实测，机读表落 `model-gearbox/probes/output-cap/endpoint-output-caps.yaml`——报文里点名探针，是给读者一个核实的动作，而不是让引擎运行时去查表（引擎不读 model-gearbox）。

**烧穿疑似反刍,报文分流+留档线下（hopissues/hoplogic3/0060,2026-09-01 作者定轻量案"thinking 爆了直接报 thinking 异常,可能是反刍,留档线下分析即可"——弃流式检测〔动非流式既有架构不值〕;2026-09-02 二批重修:reopen 主诉 in-band 形态+留档静默失效+失败档次漏配〔当时登进确定性判据,2026-09-04 乙案改登步级瞬态前缀,见下"失败语义"条〕+死站点删除+封顶口径写实,五面一批）**：两个截断站点（parseStepOutput 主闸、replan 流水线段）在抛错前做零成本判定,命中两形态之一即报文换 `THINKING_EXHAUSTED` 前缀并留档：
- **形态①正文全空**（thinking 通道烧穿——预算全烧推理块,零可见产出）：`stop_reason=max_tokens` 且可见正文 text 为空/全空白;
- **形态②正文高重复（in-band 反刍,二批扩——reopen 主诉）**：正文非空,但尾窗重复度越阈——非思考模式模型把反刍循环写在可见正文里（hopkb r21 实录:deepseek-v4-flash "让我重新审视" 1330 次灌满 65536,首批只判①把它放走照旧教"调大上限"）。判据=零成本纯字符串统计（`isHighlyRepetitive`）:尾窗 4000 字符按 32 字符切片,统计切片在其之前文本已出现的比率,>50% 判高重复;阈值保守（实录形态数量级越阈）,长排版正文不误触（反例钉）;常数权威=代码,本条款记语义。
两形态报文各自写实（①"正文为空"/②"正文被高度重复的循环文本填满〔in-band 形态〕"），共同尾句：可能是思维反刍循环（常见诱因：判据/约束互相矛盾制造两难），全文已留档 hoplog，调大上限对反刍无效。处置规则分条如下：

- **触发边界**：有 tool_use 块恒不碰（产工具参数被掐非反刍）；工具循环轮不设分流站（二批次删——该站前提 hasToolUse=true 而分流对 tool_use 恒不碰，调用结构性空转；终轮无 tool_use 响应归 parseStepOutput 闸接住，覆盖面无洞）；正文非空且不重复的截断照旧 OUTPUT_TRUNCATED（真超限，指路调参对症）；
- **留档**：命中时响应全部内容块可见序列化全文经 `HopLog.recordRuminationSuspect` 落**文档级顶层块**——不过孤儿守卫（命中时点在截断抛错前，步级归属不可靠；二批次修：首批次经 recordStepMeta 传空步骤号被孤儿守卫拒收，留档静默失效而报文谎称已留档，mock 测试无守卫假绿未抓，review 探针实证）；
- **留档封顶**：每 dispatcher 实例上限 5 份（父与 parallel 各子实例各自计，子实例写各自 hoplog 按文件计；超出只记一行计数 warn 不存全文——防连环反刍灌爆）；
- **报文尾句如实跟随留档实况**，三分支：已留档/封顶未存（指路前 5 份）/hoplog 未开启未留档——报文不许在未留档路径上谎称已留档（首批次同病阅卷实抓）；
- **失败语义=步级瞬态**：THINKING_EXHAUSTED 前缀登在引擎 `TRANSIENT_PREFIXES`（与 OUTPUT_TRUNCATED / TOOL_LOOP_REPEAT / OUTPUT_ABORTED 同一清单）——首次撞到免扣重试预算、下一轮带反馈重跑（配合下方"变招重试"换参数），复发照扣预算走阶梯;归类判据与四条前缀清单的权威在 [[exec-engine#^anc-exec-deterministic-no-retry]] 口袋归类表。二批次补配判据的来由：首批次只写承诺未配判据，实走满阶梯重试，反刍场景每轮烧满上限，review TE-2 实抓。2026-10-11 语义审计 0156 C3 改定：此前本条与上方段首写"确定性口袋 / deterministic",与代码 2026-09-04 乙案（首撞免扣、复发照扣）不一致;
- **不做引擎侧自动反刍终判**：报文只说"可能"，是不是反刍归线下人对着留档判；重复度判据是分流触发器不是终判。

**变招重试：检出即记名，该步后续重试轮 thinking 强制 disabled**（三批次，2026-09-17 R4 实撞——同一构建 run 内 THINKING_EXHAUSTED 13 次×烧满 65535 正文全空 ≈85 万纯废 token：免预算重试保住了预算账，但重试请求与首跑参数完全同源〔resolveModel 无 per-retry 覆盖〕，反刍绑定输入形态，同型请求反复撞；check 判官步恒不吃 L5 重试反馈〔A 案〕，其重跑是逐字节同输入，不变招=保证再反刍）：

- **记名**：dispatcher 持步号集合，checkThinkingExhausted 命中且有步号即记名；
- **降档**：buildApiRequest 装配时步号在册 → thinking 强制 `{type:'disabled'}`，覆盖 route 声明与端点缺省——正文都写不出来时先降档保底拿产出，推理质量其次。协议面：deepseek anthropic 协议端点两值实测认；openai-chat 协议 thinking 参数静默丢弃零影响；openai-responses 把 disabled 映为 reasoning.effort:'low'（0020 批次两点映射）——记名强制 disabled 在该协议上实发最低思考档，降档保底方向同；
  - 目标端点在 provider 配置里声明了 `thinking_disable_unsupported: true`（思考关不掉，收到 disabled 报 400——glm-5.3-flash 实测）时，降档的实发形态换成 `output_config: {effort: "low"}`、不带 thinking 键，见 ^anc-exec-thinking-disable-unsupported。止血方向不变（把思考压到最低），只是换一种端点认的写法；不做这个替换，止血在这类端点上会变成"重试发 disabled → 400 → 步骤必败"；
- **记名 sticky 到 dispatcher 实例生命周期**：该步此后恒降档——反刍绑定的是该步的输入形态，形态不随轮次变；replan 流水线段无步号不记名（自有 ADAPTIVE_PIPELINE 通道）；
- **与既有反证的分界**：act 工具循环 thinking:disabled 打转的 2026-08-20 反证不与本条冲突——那是"全程禁"的路由配置面，本条是"烧穿后的止损降档"，前提已是该步带 thinking 跑不出正文。 ^anc-exec-thinking-exhausted

**单输出自标注剥壳** ^anc-exec-output-parse-self-labeled

（2026-08-18 buildtest 实撞——单输出路径"全文即值"是包裹症盲区）：LLM 对单输出步骤也常把输出 echo 成 YAML 键形态（整包 ```yaml 围栏 + `<输出名>: |` 块标量——deepseek 系高频,提示词"裸文本直出"治不住）,单输出路径原样收下 → 围栏与标签进变量,下游机械消费（如 validate 工具）parse 错。

契约：单输出取值前做**自标注剥壳**——①整包围栏（首行 ` ``` `/` ```yaml `、尾行 ` ``` `）先剥两端行；②剥后首行恰为 `<输出名>: <指示符>`（块标量指示符）→ 收余行剥公共缩进削尾空行为值；首行为 `<输出名>: <单行值>` 且无余行 → 取单行值。与多输出 YAML 主路径的键提取对称。
- **签名围栏块+散文形态同剥**（三十八审 flash 实撞收窄,三十九审扩导语位——签名块前的散文导语同弃）:`围栏自标注块+收尾围栏+评注散文` 形态原按"围栏须包整文"放弃剥壳,壳连散文逐字节进值落盘,5.4 反馈诊断准确但 flash 输出习惯治不住,重试打转到超时;签名在场即无歧义:首围栏内首行 echo 了输出名 → 收**围栏内**为值经②路径,围栏后散文尾巴弃——签名声明了"这块是值",尾巴是评注;
- **空值键行+子结构形态收窄（第三/四形态,2026-09-21 0106 批合并写清——第三形态系 doc-review 第十四次实撞随修,原只落实现注释设计失记,本批补账）**：尾部自标签行是 `<输出名>:` 空值形态、其下挂子结构行时,按子结构形态分道：
  - 子结构**全缩进**（第三形态,doc-review 实撞:空值键行下挂嵌套列表,旧判含糊原样,散文进值 coerce 炸列表校验）→ 收子结构剥公共缩进为值;
  - 子结构**顶格列表**（第四形态,0106 T9 实撞:27b 照"思考不进产出从键行收"教学交『散文+顶格 `clauses:`+顶格 `- 条目`』——顶格列表恰是最标准 YAML 写法,旧"全缩进"判据不认,散文全文进值,SCHEMA 误拒模型合规产出,重试必同死,三 attempts 烧尽整 run 冤死;散文段自身含合法 YAML 清单行时整包解析亦炸,教学承诺"从键行收"与收割实现脱钩）→ 从标签行起截到文末交 yamlLoad 单解,解出对象且含输出键即收该键值——**教学承诺的字面兑现**;
  - 标签行后出现顶格非列表非空行仍判含糊原样（顶格散文=子结构已终结,不做跨段猜测）;
- **非自标注形态原样零变化**：围栏可能是业务内容,只认"首行 echo 了输出名"的无歧义签名；`<名>: 值` 后还有多行且非上述子结构形态=形态含糊,不碰；
- **无签名的多围栏块拼合不剥**——首尾正则会跨块误捕〔捕获组内再现 ``` 即多块〕,把中间散文与围栏标记收进值,二十五审探针抓;有签名时按上条收首围栏块。

**回退路径的块标量兜接** ^anc-exec-output-parse-fallback-block

（2026-08-18 buildtest 实撞——同一失败模式在回退路径复活）：LLM 输出 `key: |` 后正文**顶格不缩进**（markdown 正文天然顶格）→ 整文非法 YAML → yamlLoad 抛错走回退 → 逐行正则再次把 `|` 当值（毒值污染下游整条链：buildtest 中 skill_content='|' 致 header_final 全 `__UNKNOWN__`、构建循环空转到 retry 耗尽——check 拦不如源头取对）。

契约：回退正则取到的值若恰为块标量指示符（`|`/`|-`/`|+`/`>`/`>-`/`>+`）→ **收块**：从该行之后收集后续行直到下一个声明键行（`^<其他声明键>:` 顶格）或文末，剥公共缩进、削尾部空行，块文本即值；值非指示符时按原样单行取值（既有行为零变化）。
- 指示符孤行真是业务值的概率可忽略（YAML 语境里 `|` 孤行本就不是合法标量写法）。

**temperature 拒收自适应（2026-08-06 真机实撞）**：部分 Anthropic 兼容端点的新模型**拒收 temperature**（DeepSeek deepseek-v4-flash 返回 400 invalid_params "`temperature` is deprecated for this model"）。
- callLlmWithRetry 识别此错误（400 + 消息含 temperature）→ **剥除 temperature 立即重试一次**（同请求、不计入退避重试次数）；剥除后该端点整个 run 期免传（记 per-client 标记，避免每步都 400 一次）;
- 语义代价可接受：这类模型不支持温度即意味着服务端固定采样策略，传与不传行为一致。

### format_inputs / format_output_schema

```
format_inputs(inputs: Record<string, any>): string
  对每个 key-value：
    null    → "{key}: None"
    string  → "{key}: {value}"（超 500 字符截断 + [TRUNCATED]）
    其他    → "{key}: {JSON.stringify(value)}"

format_output_schema(schema: OutputDecl[]): string
  对每个 OutputDecl：
    "- {name}: {type}"
    若有 description：追加 " # {description}"
```

---

## 步骤类型与 API 调用路径【说明：对照表】

| step_type | 是否调 LLM API | 是否经 PromptAssembler | 是否走 build_api_request | 说明 |
|-----------|:---:|:---:|:---:|------|
| reason | Y | assemble_reason_context | Y | 纯推理 |
| act | Y | assemble_act_context | Y | 推理 + tool_use loop |
| check | Y | assemble_check_context | Y | 验证推理 |
| confirm | N | — | — | 直接构造 ExecutionPaused，不调 API |
| commit | N（confirm 阶段）/ Y（执行阶段） | —（confirm）/ assemble_act_context（执行） | —（confirm）/ Y（执行） | confirm 阶段 HITL 暂停；执行阶段同 act |
| call | N | — | — | 递归 run_spec，不直接调 API |

confirm 和 call 步骤不经过 PromptAssembler 和 build_api_request——confirm 直接从 StepReady.context 构造 ExecutionPaused 信号，call 递归调用 run_spec。

---

## 工具权限模型【契约】 ^anc-exec-tool-permission

**构造期接线义务**：Dispatcher 构造函数装配完 CompositeToolProvider 后必须调 `engine.setToolDefsSource(provider)` 把工具注册面交给引擎——这是 L4 工具清单在独立模式渲染真身档的唯一料源。
- worker 经 `sharedToolProvider` 注入复用父 provider 时同样接线（接的是父 provider、接到各自的子引擎上——每个子 Dispatcher 构造点都有自己的 childEngine，清单与下发面同源不随注入支路变）;
- 契约与禁令细节见 [[prompt-assembler#^anc-exec-tool-manifest-source]]；漏接=独立模式清单恒落复用模式通道指引档，2026-08-31 真机实抓。

安全模型由两个机制覆盖：

1. **ToolDef.requires_commit**：工具注册时声明副作用级别。act 步骤中 StepDispatcher 自动拦截 `requires_commit=true` 的工具调用
2. **SandboxConfig**：执行沙箱（workspace 内自由操作）+ 读取控制（三级权限）

### 执行流程

```
execute_tool(step_type, tool_name, tool_args):
  tool_def = tool_provider.list().find(t => t.name == tool_name)

  // 1. 步骤-工具匹配检查
  if step_type == 'act' && tool_def.requires_commit:
    return { success: false, result: 'COMMIT_REQUIRED: 此工具仅可在 commit 步骤中调用' }

  // 2. 沙箱检查（按资源类型分派）
  if is_write_operation(tool_name, tool_args):
    validate_path_within_workspace(tool_args.path, sandbox.filesystem.workspace_dir)
  if is_read_operation(tool_name, tool_args):
    check_read_access(tool_args.path, sandbox.filesystem.read_access)
  if is_network_operation(tool_name, tool_args):
    validate_host_trusted(tool_args.url, sandbox.network.trusted_hosts)

  // 3. 执行
  return tool_provider.execute(tool_name, tool_args)
```

### 沙箱检查（四种资源类型）

**① filesystem**：workspace_dir 内可自由写删，workspace 外写/删/移动 act 步骤自动拦截。read_access 三级：denied > confirm_required > allowed，未匹配默认禁止。路径参数先经 `realpath()` 解析，路径穿越和 symlink 逃逸被拒绝。`.hopstate/` 禁止写入。

**② network**：trusted_hosts 白名单内只读请求（GET/search/fetch）= act 级别。白名单外域名或有副作用请求（POST/PUT）= commit 级别，act 步骤拦截。

**③ runtime**：sandbox.runtime.available 声明可用库。act 步骤可调用已声明库在 workspace 内计算。安装新库 = commit 级别。

**④ database（v2+）**：只读查询 = act，写入/删除 = commit。

### DefaultToolProvider（无宿主配置时的默认行为）

不提供 ToolProvider 时，StepDispatcher 使用 `DefaultToolProvider`：

- **可用工具**：Read / Write（均 requires_commit=false）。**不含 bash**——bash 是高危工具（任意命令执行），仅宿主注入的 ToolProvider 可显式提供且必须标记 requires_commit=true（见 [[shared-types]] 关键决策、[[sandbox]] 决策 3）
- **默认 filesystem**：workspace=`process.cwd()` 子目录，read_access.allowed=[workspace + '/**']，denied=['.env*', '**/*.key', '.hopstate/**']
- **默认 network**：trusted_hosts=[]（默认不允许网络访问）
- **默认 runtime**：available=[]（默认无额外库声明）

**安全边界说明**：应用层检查是**最小防护，非安全边界**——无法防御所有绕过手段。安全敏感部署应注入容器化 ToolProvider（cgroup/namespace 隔离），将安全边界下推到操作系统层。Provider 模式的设计优势——安全策略由宿主决定，HopJIT 不做安全承诺。

### HopAnt 集成时的 ToolProvider

HopAnt 使用方将 `CapabilityLayer.execute_tool` 适配为自定义 ToolProvider 注入，工具的 `requires_commit` 和 SandboxConfig 由 HopAnt 的 Layer 配置驱动。

---

## API 错误处理与重试策略【契约】 ^anc-exec-api-retry

StepDispatcher 直调 Anthropic API，需处理以下错误场景。ErrorCode 定义见 [[shared-types]]。

### 重试策略

| 错误 | HTTP 状态码 | ErrorCode | 策略 |
|------|-----------|-----------|------|
| 限流 | 429 | RATE_LIMITED | 指数退避重试：1s → 2s → 4s → 8s（最多 4 次）。若仍失败，失败该步骤并触发上层 retry。 |
| 服务端错误 | 529, 5xx | API_SERVER_ERROR | 指数退避重试：1s → 2s → 4s（最多 3 次）。超过则 fail step。 |
| 网络超时 | — | API_TIMEOUT | 指数退避重试最多 **6 次**,退避封顶 60s（1s→2s→4s→8s→16s→32s,总耐受约 2 分钟——v0.14.1 A 半边,dr17 实撞:旧 2 次×短退避总耐受 3 秒,1 分钟网络中断 43 秒烧穿全树）。耗尽走**网络暂停**（B 半边,见下——不 fail step）。只管**短超时**（连接超时、系统层 ETIMEDOUT 这类，失败前等待时长不到本次请求等待上限的 90%）;等满了等待上限的归下一行。 |
| 客户端等待超时 | — | —（失败原因前缀 `CLIENT_TIMEOUT:`） | **不重试**（v0.36.0,todo/0117）。判据与文案见下"客户端等待超时"条。不走网络暂停,直接以 `CLIENT_TIMEOUT:` 前缀 fail step,交给步骤级 retry（subtask retry 预算）决定要不要整步重跑。 |
| 网络错误 | — | API_NETWORK_ERROR | 同"网络超时"行（timeout/network 同档同待遇）。 |
| 端点非正常停止 | — | OUTPUT_ABORTED | **API 层不重试,交给步骤级 retry 按步级瞬态处理**。响应 stop_reason 既不是正常收尾（end_turn / tool_use / stop_sequence / 缺席）也不是 max_tokens（refusal / content_filter 等）→ 解析前抛 `OUTPUT_ABORTED:` 前缀,普通 failStep;引擎按 TRANSIENT_PREFIXES 首撞免扣预算、下轮带"换措辞"反馈重跑、复发照扣;半截产出不收不进 SCHEMA 反馈。见 [[#^anc-exec-output-abort-loud]]（todo/0121;档次 2026-10-08 review 修复改定）。 |
| 端点不可达 | — | ENDPOINT_UNREACHABLE | **不重试**,首次即以 `ENDPOINT_UNREACHABLE:` 前缀 fail step（fail_kind=deterministic）。`ECONNREFUSED`/`ENOTFOUND`/`EPERM` 是配置指向死端点或系统策略不放行的确定性结果,见 [[#^anc-exec-network-pause]] "端点不可达"条（hopissues/0106）。**例外**（v0.41.0,hopissues/0118）：本进程里成功应答过的端点撞 `ENOTFOUND`/`ECONNREFUSED`,改按"网络错误"行处理（6 次退避,耗尽进网络暂停）,见同锚"曾经连通过的端点"条。 |

**网络类失败上传时挂可读前缀（2026-08-23 作者定"同意"）**：executionLoop 兜层把步骤失败原因写进 failStep 前,`classifyError` 判 `network`/`timeout` 的错误文案改写为 `NETWORK_ERROR: 网络中断（非内容问题——与产出质量无关,原文: <原文案>）`。
- 实撞出处:dr10 两处 `reason: terminated`——undici fetch 断流的原始文案直接落 FailRecord,经 L2c 塞给下一轮 LLM——"上次失败原因:terminated"零信息量,LLM 会试图"修正"一个网络故障;走查者也分不清内容失败与环境失败。

**分类兜底按文案识别裸网络异常（2026-08-24 D61,dr14 实抓）**：两协议 classify 的 `other` 兜底前,message 命中 undici/Node 网络文案集（文案三条 `terminated` / `fetch failed` / `socket hang up`,错误码六条 `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `EPIPE` / `ENETUNREACH` / `EAI_AGAIN`——`ENETUNREACH` 是本机到目标网络无路由（断网、VPN 掉线）,`EAI_AGAIN` 是 DNS 暂时失败,两者都是等一等就好的瞬时故障;完整词或错误码形态精确匹配,不裸含子串防误伤业务文案;代码权威 protocol-openai 的 `isBareNetworkMessage`,2026-10-11 语义审计 0156 C3 把漏列的后两码补齐）→ 归 `network` 档,获得 2 次重试与耗尽挂前缀的完整待遇。
- 实撞出处:`classifyError` 只认 SDK 错误类 instanceof,但 SDK 只包装"请求发起阶段"的错误;流读取中途断的 undici 裸 TypeError〔`terminated`〕不经包装直接穿透,落 `other` 档=0 重试+原样抛,裸文案再次进 FailRecord——D58 前缀被绕过,dr14 一子块判定器就此烧掉走兜底;
- 探针实证:连接拒→APIConnectionError 正确归 network;流中断→裸 TypeError 漏网。
- **v0.36.0 补一条先于文案兜底的判据**：错误本身或它的 cause 链上带 undici 错误码 `UND_ERR_HEADERS_TIMEOUT`（等响应头超时）或 `UND_ERR_BODY_TIMEOUT`（等数据超时）→ 归 `timeout` 档，不归 `network`。实测：数据中途停满 bodyTimeout 时抛的是裸 `TypeError('terminated')`,cause 是 BodyTimeoutError——按文案兜底会被当成网络断流，再按网络瞬断重试 6 次;它其实是"等满了时限"，要进下一条的客户端等待超时判定。沿错误对象往下最多看 6 个对象——本体加 5 跳 `cause`（代码循环 `depth < 6`,防环;2026-10-11 语义审计 0156 C3 改定:此前写"5 层"与代码 6 层循环的口径不一,现写成"本体 + 5 跳"消歧）。

**客户端等待超时（v0.36.0,todo/0117,2026-09-27）**：一次请求等满了引擎给它的等待上限（^anc-exec-nonstreaming-timeout 的单次请求等待上限）仍没收到完整响应。它和网络瞬断是两回事：
- 网络瞬断等一等就好，重试有意义;等待超时是这次请求本身就要那么久（模型思考长、产出长），同样的请求再发一遍大概率同样等满，每次重试又是至少 10 分钟外加一整轮生成的费用。todo/0117 的放大形态：旧规则把它当网络错误重试 6 次，每次等满，约 35 分钟后才以"网络中断"失败，文案还把排查方向引到网络上;
- **判据**（callLlmWithRetry 内，纯机械）：`classifyError` 判 `timeout`,且这次尝试从发出到失败的耗时 ≥ 本次请求等待上限的 90%。为什么要看耗时：`timeout` 档里还混着短超时——SDK 对 fetch 抛错按文案 `/timed? ?out/` 判超时，undici 连接超时（10 秒）、系统层 `ETIMEDOUT` 都会被包成同一个 `APIConnectionTimeoutError`,错误对象上分不出来，只有耗时分得出来。90% 留的余量给 undici 的粗粒度计时器（可能早触发约 1 秒）;最小上限 10 分钟时余量 1 分钟，远大于连接超时与系统层超时的量级，两类不会混;
- **重试次数 0**：理由一，同因必重（见上）;理由二，步骤级还有一层 retry,由 spec 作者按 subtask retry 预算控制，要不要再花一轮钱归那一层定，API 层不替它加码;理由三，不走网络暂停——暂停后 resume 会把同一个请求原样重发，等满后再次失败，暂停只是把失败推迟到人来点恢复之后;
- **报错文案**（新前缀 `CLIENT_TIMEOUT:`,不再说"网络中断"）：`CLIENT_TIMEOUT: 客户端等待超过 <N> 分钟仍没收到模型的完整回复，按等待上限中止（不是网络中断，也与产出内容无关——这次请求本身耗时超过了引擎给它的等待上限；等待上限按本次请求的 max_tokens=<X> 换算，每 128000 tokens 60 分钟、最少 10 分钟。可以精简本步产出，或换更快的端点；调大输出上限〔HOPJIT_MAX_OUTPUT_TOKENS / resource_limits.max_output_tokens / provider 的 max_output_tokens〕会按比例放宽等待上限。原文: <原文案>）`。N = 本次请求等待上限换算成分钟、向上取整;实例上下文水位越 75% 线时照旧追加 ^anc-exec-ctx-watermark ③的体量提示;
- **下游消费点**：①engine 的失败分档只看失败原因开头（[[exec-engine#^anc-exec-deterministic-no-retry]]）,`CLIENT_TIMEOUT:` 不在瞬态与事务级两张前缀清单里，按普通失败走 subtask retry 预算——本批次不改 engine;②executeStep 的网络暂停只认 `NETWORK_ERROR:` 前缀，本前缀不命中，照常 failStep;③L6 修正指令把它当执行过程类失败说实话、不套"检查产出形态"的指引（[[prompt-assembler#^anc-exec-l2c-retry-feedback]] v0.28.0）。

**SDK 内部重试关掉（v0.36.0,同批次）**：两个 SDK 构造选项 `maxRetries` 缺省 2——SDK 在连接错误、超时、408/409/429/5xx 上自己先重试 2 次，引擎看到的每一次失败背后其实是 3 次请求。实测（SDK timeout 1 秒、缺省重试）：假服务器被打了 3 次。
- 这让上面的重试表不成立（网络档写 6 次，实际最多 21 次请求），也让"客户端等待超时不重试"做不到：SDK 的单次请求计时到点后先自己重试 2 次，一个 15 分钟上限的请求要等 45 分钟引擎才看到失败;
- SDK 的重试不分错误类型，只能整体开关（只对超时关掉没有公开入口）。所以三个客户端构造期一律 `maxRetries: 0`,重试全部归引擎这一层，重试表写几次就是几次;
- 代价：限流（429）与服务端错误（5xx）的实际请求次数从"引擎次数 × 3"降到重试表写的次数，SDK 对 `retry-after` 响应头的遵从也随之没了（引擎退避是固定的 1s→2s→4s→8s）。按时间算，SDK 那两次内部重试的退避约 0.5s + 1s,429 档总耐受从约 22 秒降到约 15 秒。是否要把 429 档次数调高或让引擎读 `retry-after`,留作观察项（todo/0117 处置记录）。

**HopSop（callLlmWithRetry 单次失败的分派,v0.36.0 后）**：

```
# impl callLlmWithRetry 的 catch 段(err, attempt, request, elapsed_ms)
1. [act] kind = client.classifyError(err)   # 两协议 classify 都先认 undici 超时错误码归 timeout,再走文案兜底
2. [branch] 按 kind 分派
  2.1. [case(temperature_rejected 且请求带 temperature)] 剥掉 temperature,不计次数立即重发(既有)
  2.2. [case(auth 或 context_overflow)] 原样抛(既有)
  2.2a. [case(unreachable 且 错误码 ∈ {ENOTFOUND, ECONNREFUSED} 且 client.endpoint 的键在 reachedEndpoints 里)]
       曾经连通过的端点——kind 改为 network,落到 2.4 走网络类重试与 NETWORK_ERROR(v0.41.0,hopissues/0118,
       见下 ^anc-exec-network-pause "曾经连通过的端点"条)
  2.2b. [case(unreachable)] 端点不可达——不重试,抛 ENDPOINT_UNREACHABLE 文案(service_id/base_url/错误码三样,
       见下 ^anc-exec-network-pause "端点不可达"条;hopissues/0106)
  2.3. [case(timeout 且 elapsed_ms ≥ nonstreamingWaitMs(request.max_tokens) × 0.9)] 客户端等待超时——
       不重试,抛 CLIENT_TIMEOUT 文案(N=等待上限分钟数向上取整,X=request.max_tokens,水位越线追加体量提示)
  2.4. [case(else)] 按 getMaxRetries(kind) 判:还有次数 → 退避后重发;次数用完且 kind 是 network/timeout →
       抛 NETWORK_ERROR 文案(既有);其余原样抛
```

**网络暂停（B 半边,v0.14.1 2026-08-25 作者定 A+B）** ^anc-exec-network-pause：API 层网络/超时重试耗尽后**不进 failStep**——executeStep 的 catch 识别 `NETWORK_ERROR:` 前缀,把该步状态回置 pending（与 crash-recovery 的 running→pending 同语义:步骤未产生任何效果,重执行安全）,persist 后向上返回 `paused`,`pause_reason: 'network'`,载荷携 step_id 与网络错误原文。
- 实撞出处:dr17——1 分钟网络中断,NETWORK_ERROR 被当普通步骤失败吃容器内容重试预算,CalleeFailure 逐层上炸,顶层三连发间隔 7-8 秒无退避全秒死,43 秒烧穿 run failed 整树报废;网络类失败与产出质量无关,烧内容预算是把'必活'〔等一等就好〕当'必死'处理。

三条通路：

- **主线**：executionLoop 收到 network paused 即返回 caller——run 转 paused,状态全在盘,树不报废;
- **call 递归**：子 Dispatcher 返回 paused 走既有 callFrames 冒泡通道（与 ask/confirm 同款,pause 形态通用不分 reason）,逐层上浮到顶;
- **恢复**：`resume_run`/resumeSpec 对 network 暂停**不需要 answer**——回置 pending 的步骤经 next_step 自然重派,网络恢复即续跑（mcp-server 对 pause_reason=network 的 resume 走 resumeSpec,忽略 answer 载荷）。
  - **跨进程一路（33 轮 review 探针实抓补通）**：detach 后新进程 resume 走 restoreRun,其预检原只认 confirm/ask——网络暂停步是普通步（reason/act）被拒死,断网暂停的 run 跨进程永远续不了;预检按免答通道同判据（exec_events 有 network_pause 记录且该步 pending——事件随 state.json 持久化,跨进程可判）放行。

**范围注记（v2 2026-08-25 作者定 b 案——review B1-1 实抓 v1 注记与代码赋值链不符）**：网络暂停门按子实例形态分两路——

- **parallel subtask worker**（`worker: true`,launchParallelSubtask/crash 重建两处传入）：门不开,网络耗尽仍 failStep,父层收割/stale 对账兜底（worker 是同 spec 子树收窄,重跑成本低）;
- **parallel call 子实例**（launchParallelCallChild,不传 worker）：门开——子实例网络耗尽转 paused(network),父层按 U4b HITL 队列入队（^anc-exec-parallel-hitl-queue）,不占名额等 resume;网络恢复后 `resume(childInstance=<子实例>)` 经队列路由到子 dispatcher 的免答通道续跑,子树不报废。
  - call 子实例是完整 spec 实例,重跑成本高——与主线 B 半边同一保护哲学;
  - v1 注记误写"parallel 路径一律 failStep",实际 call-parallel 赋值链从未传 worker,行为本就是入队——b 案承认该行为为设计内并补测试钉死。

**可观测性（todo/0105,2026-09-25）**：网络暂停不落问题卡,但在状态账留有两样盘上痕迹——该步回置 pending、事件流最后一条是 network_pause（随 state.json 持久化）;串行调用子层的网络暂停在父实例目录 `calls/<子实例>/` 的子快照里。命令行 status 据此判出 paused（pause_reason=network,嵌套时带 call_path）,判定权威在 [[hop-cli#^anc-cli-status-nested-pause]]。本模块的暂停与恢复语义不因此改变。0081 批次曾把网络暂停写成 status 的"显式不覆盖"边界,被 0105 实撞推翻,演进来由见彼锚。

旧条款"网络失败不占带反馈重跑名额"的 L2c 文案半边保留（防 subtask worker 路径与历史 state 里的存量 NETWORK_ERROR 记录）。

**端点不可达不入网络暂停门——fail-fast（hopissues/0106,2026-09-28）**：网络暂停的前提是"必活〔等一等就好〕"——这只对**瞬时**网络故障成立（断流/重置/DNS 抖动）。连接被拒（`ECONNREFUSED`——目标端口无进程监听）不是瞬时故障,是配置指向了死端点（base_url 拼错/端口填错/provider 未启动）,等多久都不会好。把它送进暂停门=run 永远 paused、载体反复轮询无终态无报错,用户拿到的是静默挂死（hop3 真机 90s+ 实撞）。判据与处置：
- **判据**：classifyError 在归 `network` 档之前先看错误链（本体或 cause 链,与 undici 超时码同法——本体加 5 跳 `cause` 共 6 个对象,每个对象还看 undici 双栈聚合错的 `errors[]`）——带 `ECONNREFUSED`（端口无监听）、`ENOTFOUND`（主机名解析不到）或 `EPERM`（connect 被系统策略拒绝——沙箱/防火墙未放行该地址,Claude Code 沙箱内直连未白名单 IP 即此形态）错误码 → 定性为**端点不可达**（`unreachable`）,与瞬时 `network` 分档;
- **重试**：不可达不走 6 次退避——首次即判（连接拒绝是确定性结果,重试只是烧时间）;
- **终态**：抛 `ENDPOINT_UNREACHABLE:` 前缀（非 `NETWORK_ERROR:`）,executeStep 的 catch 不进暂停门,走 failStep 且 **fail_kind 传 `deterministic`**（与 CONTEXT_OVERFLOW 同款——死端点下容器 retry 每一轮都同因,重跑只是把秒败重复 N 次;记确定性后引擎按事务级直达兜底,[[exec-engine#^anc-exec-deterministic-no-retry]]）→ run `failed`;报文含 service_id、base_url、错误码三样（"配了哪个后端、指向哪、为什么连不上"——用户一眼定位）;
- **边界**：只对 `ECONNREFUSED`/`ENOTFOUND`/`EPERM` 三码分档（三者都是"配置或策略决定的确定性结果",不随时间自愈）——`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/`terminated` 维持瞬时网络待遇（它们真可能等一等就好;`EAI_AGAIN` 是 DNS 暂时失败,与 `ENOTFOUND` 的"名字不存在"不同档）;报告方 probe 判据=90s 内 failed 且错误含不可达语义,本条恒满足（首次即判,秒级）;
- **例外**：本进程里成功应答过的端点撞 `ENOTFOUND`/`ECONNREFUSED` 不按本条判,见下条（v0.41.0,hopissues/0118）。

**曾经连通过的端点不按死端点判（hopissues/0118,2026-10-04）**：上一条把 `ENOTFOUND`/`ECONNREFUSED` 当成"配置指向死端点"的确定性证据——对一个从没连上过的端点这个推断成立,对一个几秒前还在正常应答的端点不成立。实撞（0118）：standalone run 跑到一半,一次秒级 DNS 闪断让 getaddrinfo 返回 `ENOTFOUND`,上一条规则首次即判 run failed,一个并行父任务下 39 个子实例全部被杀;同一个 base_url 在闪断前后都正常应答。作者口径："成功调用现在失败的,为什么不用历史值？"——据此两层防线：

- **第一层：DNS 上一次成功结果缓存**（protocol-openai.ts `createCachingLookup`）。按主机名记住上一次解析成功的地址;DNS 查询再失败时改用这份地址去连接,请求照常发出,闪断在连接层就被吸收,上层看不到任何错误。只在查询报 `ENOTFOUND` 或 `EAI_AGAIN`（这两个才是"DNS 查不到/暂时查不到"）时退回缓存,其他错误原样上抛。接线：模块级单例 `sharedCachingLookup` 经 `longWaitFetchOptions` 合进 undici Agent 的 `connect.lookup`——三种协议共五个客户端构造点都经这个函数建连接设置,一处接线全覆盖;同一进程内所有 client（含 parallel worker 各自新建的 StepDispatcher 里的 client）共用一张缓存。用缓存地址连接时 TLS 的 servername 仍是主机名,证书校验不受影响（探针实测）;
- **第二层：曾经连通过的端点降为网络类**（dispatcher.ts 模块级 `reachedEndpoints`）。记录本进程里成功应答过（`client.create` 正常返回）的端点;这些端点再撞 `ENOTFOUND`/`ECONNREFUSED`,`unreachable` 档改归 `network` 档——走网络类 6 次退避,耗尽抛 `NETWORK_ERROR:`,进网络暂停（run paused、可续）,不再首次即判 failed。第二层兜住第一层管不到的两种情形：调用方给了函数形态的 connect（测试注入,第一层不接线）;以及 `ECONNREFUSED`——服务重启或滚动发布窗口里,刚刚还在应答的后端短暂拒绝连接,DNS 缓存管不到这一种。
- **为什么判据是"成功应答过",不是"解析成功过"**：配置写成 `localhost:9999` 而端口上没服务时,`localhost` 每次都解析成功——若按"解析成功过"降级,这种明确的配置错误会被拖成一分钟重试再暂停,违背上一条 0106 的 fail-fast 承诺。按"成功应答过"判,从没应答过的端点永远走上一条 fail-fast;0106 的 probe（`127.0.0.1:9999` 连接被拒）在本进程从未成功过,照旧首次即 failed。
- **`ECONNREFUSED` 也降级的理由**：0118 卡写明"ECONNREFUSED 同理可分流（服务重启窗口）"。同一进程里刚刚还在应答的后端拒绝连接,最可能是服务重启,几十秒内会回来;判死要杀掉整个 run（含全部子实例）,降级的代价只是约一分钟重试后进可续的网络暂停,两边代价不对称。
- **不降级的**：`EPERM`（系统策略拦截,重试无意义,不随时间自愈）;端点身份缺席（`client.endpoint` 未盖章）的 client——无从判断是否连通过,按上一条走。
- **已知边界**：两张表都只活在进程内存里,不跨进程。MCP server 重启后的第一次调用恰逢 DNS 闪断,仍按"从没连通过"fail-fast。0118 实撞发生在同一进程内（39 个子实例跑到一半）,进程内记忆覆盖这个场景;跨进程持久化要新增落盘文件与过期策略,代价大于收益,v1 不做。表不设上限与过期：键是配置里写的主机名与端点,数量与 provider 条目同量级。

**能力契约（HopTrait）——第一层 DNS 缓存**：

```
# Spec: 带上次成功结果兜底的 DNS 查询
Id: caching-lookup
Goal: 给 undici 连接层一个与 dns.lookup 同签名的查询函数——查询成功照常返回并记下结果;
      查询因 DNS 查不到而失败时,若该主机名成功解析过,用上次的结果代替报错
Inputs:
- hostname % line  # 要解析的主机名
- options % yaml  # net 传入的查询选项;只读 all(是否要全部地址)与 family(4/6/0)两键
Outputs:
- addresses % yaml  # 回调给 net 的地址,形态见 HopType LookupCallbackShape
Constraints:
- 底层查询成功:原样回调,同时把全部地址写进缓存(覆盖旧值,缓存恒为最近一次成功的结果)
- 底层查询失败且错误码是 ENOTFOUND 或 EAI_AGAIN:缓存里有该主机名且有符合 family 的地址 → 用缓存回调;否则原样回调错误
- 底层查询失败且是其他错误码:原样回调错误,不碰缓存
- 底层查询函数可注入(createCachingLookup(baseLookup)),缺省 dns.lookup;模块级单例 sharedCachingLookup 用缺省
- 写缓存时总是以 all:true 的形态存全部地址,与调用方本次要不要 all 无关
```

**能力契约（HopTrait）——接线**：

```
# Spec: 长等待连接设置接 DNS 缓存
Id: long-wait-fetch-options-lookup
Goal: longWaitFetchOptions(waitMs, extra) 在建 undici Agent 时把 sharedCachingLookup 接进 connect.lookup
Constraints:
- extra.connect 缺席 → connect: {lookup: sharedCachingLookup}
- extra.connect 是普通对象 → connect: {lookup: sharedCachingLookup, ...extra.connect}(调用方自己给了 lookup 就用调用方的)
- extra.connect 是函数(测试注入的连接器) → 原样不动,不接缓存
- headersTimeout/bodyTimeout 两个时限照旧取 waitMs,不受本条影响
```

**类型约定（HopType）**：

- **LookupCallbackShape**（回调给 net 的形态,两种,由调用方 options.all 决定）：
  - `options.all === true` → `callback(null, [{address: string, family: 4|6}, …])`——地址数组;从缓存取时按 family 过滤（family 为 4 或 6 时只留同族,0 或缺席不过滤）;
  - 否则 → `callback(null, address: string, family: 4|6)`——取过滤后的第一个地址;
  - 过滤后为空 → 视为缓存不中,原样回调底层错误。
- **DNS 缓存表**：`Map<string, Array<{address: string, family: 4|6}>>`——键=主机名原文（不改大小写）,值=最近一次成功解析的全部地址。
- **ReachedEndpointKey**（第二层记录表的键）：字符串 `${service_id}|${base_url ?? ''}`,取自 `ProtocolClient.endpoint`（defaultClient 与 getClientForService 构造后盖的章）。值语义=身份,不是地址：同一 service_id 改了 base_url 视为另一个端点,需要重新成功一次才进表。表类型 `Set<string>`,模块级（dispatcher.ts 顶层）,不随 StepDispatcher 实例。

**关键逻辑（HopSop）——第二层**：

```
# impl callLlmWithRetry 内与本条相关的两处
1. [act] resp = await client.create(request)
2. [act] 成功返回后:client.endpoint 在场 → reachedEndpoints.add(endpointKey(client.endpoint))
3. (catch 段)kind = client.classifyError(err)
4. [branch]
  4.1. [case(kind == unreachable 且 unreachableCode(err) ∈ {ENOTFOUND, ECONNREFUSED}
             且 client.endpoint 在场 且 reachedEndpoints 含 endpointKey(client.endpoint))]
    4.1.1. [act] kind = network   # 之后与普通网络错误完全同路:getMaxRetries(network) 次退避,
                                  # 耗尽抛 NETWORK_ERROR 文案,executeStep 的 catch 进网络暂停(非 worker)
  4.2. [case(kind == unreachable)] 抛 ENDPOINT_UNREACHABLE 文案(上一条,原样)
# unreachableCode(err):沿 cause 链与 errors[] 找到的第一个 UNREACHABLE_CODES 成员,与 isEndpointUnreachable 同一遍历
```

报错文案随之分开：降级后的失败走 `NETWORK_ERROR:` 文案（"网络中断（非内容问题……原文: …）"）;"配置指向了不存在或未启动的后端"这句只出现在 `ENDPOINT_UNREACHABLE:` 文案里,即只给从没连通过的端点与 `EPERM`。
| 认证失败 | 401 | AUTH_FAILURE | **不重试**，立即 abort 整个 run_spec。密钥问题无法通过重试修复。 |
| 上下文溢出 | 400 | CONTEXT_OVERFLOW | **不重试 API 调用**。按路径分治：reason/check 单发路径捕获后调用 `PromptAssembler.reassemble_aggressive(context)` 激进压缩，重试 API 调用 1 次；工具循环路径走压缩降级（见 [[#^anc-exec-toolloop-ctx-degrade]]）。两路径二次仍溢出都以 `CONTEXT_OVERFLOW:` 前缀 fail step——该前缀入确定性不重试口袋（[[exec-engine#^anc-exec-deterministic-no-retry]]），容器 retry 不原样重跑。**handleStepReady 捕获到以该前缀开头的错误时,failStep 传 fail_kind='deterministic'**（新错误产生点用枚举,todo/0116——引擎判档次只看失败原因开头,不再对整段做子串匹配;类别随失败记录走,不靠文字识别）。 |

### 退避实现

```
retry_with_backoff(fn, max_retries, base_delay_ms = 1000):
  for attempt in 1..max_retries:
    try:
      return fn()
    catch error:
      if error is non-retryable (AUTH_FAILURE / CONTEXT_OVERFLOW):
        throw error
      if attempt == max_retries:
        throw error
      delay = min(base_delay_ms * 2^(attempt - 1), 60_000) + random_jitter(0, 100)   # 封顶 60 秒;抖动固定 0–100 毫秒,不随 delay 等比放大
      sleep(delay)
```

抖动量是固定 0–100 毫秒（代码 `Math.random() * 100`），不是按 delay 的一成等比放大——抖动只为错开同一时刻重发的多路请求，封顶 60 秒的档位再加 6 秒级抖动没有意义（2026-10-11 语义审计 0156 C3 改定：此前伪代码写 `delay * 0.1`,与代码不一致）。

### 与上层 retry 的交互

API 层重试和 subtask 级 retry 是两层独立机制：
- **API 层重试**（StepDispatcher 内部）：处理瞬时网络/服务故障，对 Engine 透明——步骤要么成功完成，要么以最终失败状态到达 `hopjit submit_and_fetch_next/fail`
- **subtask 级 retry**（ExecutionEngine.fail_step）：处理步骤逻辑失败（check 失败、LLM 输出不合理等），触发重跑或 adaptive replan

API 错误不回传到 Engine 的 fail_step 除非 API 层重试全部耗尽——此时步骤以最终失败状态进入 fail_step 流程。客户端等待超时（`CLIENT_TIMEOUT:`,v0.36.0）在 API 层零重试，直接以最终失败状态进入 fail_step——要不要整步重跑归 subtask 级 retry 定。

---

## 工具循环上下文压缩降级【契约】 ^anc-exec-toolloop-ctx-degrade

**缘起（hopissues/0070，run 18a2214d，2026-09-04 立）**：MCP 独立模式引文核实任务，deepseek-v4-flash（1M 窗），step 2.1 读 11 篇原文后 cumulative 1.4M，step 3.1 再读 11 篇请求 1.05M 超墙 API 400；重试四连撞且请求只增不减（1.05M→1.08M——每轮重试追加失败反馈，行李越背越重），retry 耗尽 run failed，烧 6.2M tokens 零产出。三个窟窿：
- ①工具循环对 context_overflow 零捕获（reassembleAggressive 只挂 reason/check 单发路径，而工具循环的 tool_result 累积正是撞墙主形态）；
- ②overflow 不在确定性不重试口袋里，容器 retry 原样重跑必然同因更大；
- ③引擎不认识模型窗口，逼近墙没有预检。

本条款管窟窿①③，窟窿②归 [[exec-engine#^anc-exec-deterministic-no-retry]] 口袋清单（本次同批补入 `CONTEXT_OVERFLOW:` 前缀）。

### 触发两档

1. **预检档**：工具循环每轮发送前，若 `resource_limits.max_context_tokens` 有配置，粗估 messages 总字符量 ÷ 4（字符转 token 的粗折算）超过 `max_context_tokens × 0.8` 即先压缩再发。该键缺席则跳过预检——向后兼容，不配就只保留撞墙补救档。该键由此兼作模型窗预检线（原语义"PromptAssembler 上下文预算"保留，两用途同源：都是"引擎认识的上下文上限"）；
2. **补救档**：`callLlmWithRetry` 抛出且 `classifyError` 判 `context_overflow` 时，若本步尚未压缩过，压缩后重试一次。

### 压缩形态：任务相关摘要，不是机械剪切

作者拍板原话（2026-09-04，hopissues/0070 对焦——首版"机械剪切换一句已读"被作者否）：**"换成一句已读过没意义，不在 prompt 里的对 LLM 就是没看过，应该换成和本任务相关的摘要，其他的在文件里。"**

压缩规则：

- **范围**：messages 里 user 消息中的 tool_result 块，**跳过最近 2 轮**（尾部两个 user 消息——近轮是 LLM 正在操作的现场，动它等于抽掉手里的工作台）；只压 content 为字符串且长度超 16000 字符（≈4000 token）的块——短块压缩收益低于一次压缩调用的成本。
  - **估算边界（与压缩范围同宽,对称成立）**：estimateMessagesChars 对非字符串 content 的 tool_result 块计 0——当前引擎工具执行链恒产字符串 content（dispatcher 工具循环 rendered 恒 string），多 block 形态实际不可达；将来若改工具结果产出形态，估算与压缩两处须同步扩（0069-0070 批次 review 面二探针实证记档）；
- **压缩调用**：对每个入选块发一次独立 LLM 调用，用当前步骤 resolved 的模型（不引独立小模型路由——路由面不为此扩），prompt = 本步骤任务说明 + 材料原文 → 与本任务相关的要点，max_tokens 2048；
- **替换与标注（分立两款——对下游 LLM 如实，节选不冒充摘要）**：
  - 摘要件：摘要替换原 content，尾部追加标注 `[原文 N 字符已压缩为任务相关摘要；完整内容可重新调用工具获取]`——告诉 LLM 这是压缩件、原件从哪找回；
  - 退化件：单块压缩调用抛错时，该块退化为头部节选 8000 字符，尾部追加标注 `[原文 N 字符；压缩调用失败，以下为头部节选；完整内容可重新调用工具获取]`——头部节选不是任务相关摘要，标注若冒充摘要，下游 LLM 会把"恰好截在头部的片段"当成"已提炼的任务要点"使用，判断建立在假前提上；
- **退化路径**：逐块独立 try/catch，一块压缩失败退化节选不连坐其他块（不因压缩本身再死）；
- **留痕**：每块 recordWarn 一条（原文 N 字符→替换后 M 字符），文案随形态分流——摘要件记"任务相关摘要"、退化件记"头部节选（压缩调用失败退化）"，观测面可对账。

### 二次撞墙 = 确定性失败

压缩后重试仍 overflow（或补救档发现本步已压缩过），throw `CONTEXT_OVERFLOW: 工具循环压缩降级后仍超模型窗——单步材料量超出模型能力，拆步骤（for-each 逐份）或换更大窗的模型`。该前缀入 [[exec-engine#^anc-exec-deterministic-no-retry]] 确定性口袋——容器 retry 不原样重跑（0070 四连撞且 tokens 只增不减的实撞形态从此一撞即报）。reason/check 单发路径的激进重组后二次撞墙同样以此前缀抛出（原为裸 throw err——归一到同一个口袋入口）。

### 已知代价

- **cache_control 断点失效**：压缩改写了早轮消息，前缀变了缓存必失（[[#^anc-exec-cache-control]] 的最长前缀匹配从改写点断开）。这是预期代价——墙内生存权 > 缓存费；
- **不做引擎自动分片**：单步塞 11 篇是 spec 设计问题（该 for-each 逐篇），引擎替作者改计划越权；deep-validate 体量判据面已管跑前提示（0070 处置裁定，理由随记）。

---

## API 密钥管理【契约】

### 加载顺序（与"多模型路由"章 resolve_credential 同一契约）

**显式后端配对优先，环境继承只兜"未配置"**（与模型路由同一原则——显式 standalone 配置不被宿主环境静默击穿，v0.3.0 模型侧已立此原则，2026-08-10 凭证侧实撞后补齐：宿主 `ANTHROPIC_AUTH_TOKEN` 曾被拿去配 StandaloneConfig 选定的 DeepSeek endpoint → 后端凭证错配 401）：

0. **`HostConfig.base_url` 与 `HostConfig.api_key` 同时显式提供**（成对=显式后端选择，StandaloneConfig 解引用注入即此形态）→ 用该配对，**不看环境变量**——显式选了后端就用配对凭证，宿主 token 对别家 endpoint 无效
1. `ANTHROPIC_AUTH_TOKEN`（CC 本地代理 token；空字符串视为未设置，继续 fallback）
2. `ANTHROPIC_API_KEY`，缺省时 `HOPJIT_ANTHROPIC_API_KEY`（直连 key）
3. `HostConfig.api_key`（无 base_url 的裸注入）

`base_url` 独立解析：`HostConfig.base_url` > `ANTHROPIC_BASE_URL`（同理：显式配置优先，环境是继承 fallback）。复用模式不受影响——CC 子进程的 buildHostConfig 不设 base_url，第 0 级不命中，环境继承主路径照旧。

**SDK 隐式 env 读取必须切断**：Anthropic SDK 构造器缺省自读 `process.env.ANTHROPIC_AUTH_TOKEN` 作 `authToken`，且 authToken（Bearer 头）**优先于显式传入的 apiKey（x-api-key 头）发出**——上面整条加载顺序会被 SDK 自己捡的宿主 token 静默盖掉（2026-08-10 真机实抓：级 0 修复后 401 仍报宿主 token 尾号，defaultClient.apiKey 明明正确）。
- 故**所有 `new Anthropic({...})` 构造必须显式 `authToken: null`**，凭证只经 resolveCredential/getClientForService 解析后显式传入；
- 需要 Bearer 形态时（级 1 的 ANTHROPIC_AUTH_TOKEN）也由解析层显式传 authToken 字段，不留任何隐式通道。

### 安全约束

- 密钥**禁止**通过 CLI 参数传递（`ps aux` 可见）
- 密钥**禁止**写入 `.hopstate/` 目录（可能被 git 追踪或 iCloud 同步）
- 密钥**禁止**在 HopLog 中出现（StepDispatcher 记录 API 错误时脱敏处理）
- 多服务支持时，按 `{SERVICE_ID}_API_KEY` + `{SERVICE_ID}_BASE_URL` 模式扫描环境变量（见多模型路由章）

配置文件中的 provider 凭证只写 `api_key_env`，由配置加载层解引用后以 HostConfig 内存注入；Dispatcher 不直接读取任何配置文件 key。

---

## 多模型路由【契约】 ^anc-exec-model-routing

StepDispatcher 支持多 LLM 服务路由：不同步骤可路由到不同模型（如 reason→DeepSeek, check→Claude），实现成本优化和交叉验证。

**thinking 路由**（2026-08-20 作者拍板形态 B——与模型分档同维度的第二旋钮;2026-09-20 0100 批扩为五级优先链,第 5 级=作者定"缺省 act 关、act free/reason/check 开,除非手动开关"）：思考开关的决策链从高到低五级,第一命中生效——

1. **THINKING_EXHAUSTED 记名册**（恒最高,止血防线不被任何配置顶回）：烧穿检出步的重试轮强制 disabled;
2. **步骤级 `@thinking off|on` 标注**（0100 新增,^anc-exec-thinking-step-annotation）：单步显式开关——机械提取步标 off 省 8-9 倍费用（deepseek 实测 1.7-2 万 tok → 2 千,得分持平）,重推理步标 on 补档（Ling 实测开思考 G1 从 N2 抬到 N6）;
3. **routing_rules 每条可选 `thinking: enabled|disabled`**：按步骤类别整类生效;
4. **provider 级 `thinking` 缺省**（[[shared-providers#^anc-config-standalone-schema]] ProviderEntry thinking 键,0100 批新增）：该 provider 全部请求的兜底显式值——逐模型矫正档。
   - 路由落缺省 provider（service_id 为 default——spec 未配显式路由的形态）时回退首 provider 的 thinking 缺省（与 auth 的 defaultClient 补装同构:缺省路径不补则唯一 provider 配了键不写路由时静默失效,v0.13.0 auth 实撞同型）;
   - 治"各端点思考缺省互相相反且不可见"的隐式行为差（deepseek 缺省开/antchat 缺省关,同 spec 换模型思考行为静默翻转;实撞:Ling 历史 G1 全档在思考关下测出,推理档被低估三倍位数）;
   - 矫正样例:antchat 配 disabled 压回第 5 级的 reason 恒开（Ling 开思考费用 ×10 而切块提取实测不需要——只给重推理步 @thinking on 点名开）;
5. **引擎内建步骤类型缺省**（0100 批,作者拍分类表 2026-09-20）：**act（无 body 且未标 free）→ disabled;commit → disabled;act free / reason / check / replan → enabled**。步骤节点查不到时按步骤类型缺省判（act 按非 free 关——replan 场景调用无 step 天然走此路,级 1/级 2 随之短路,级 3/4/5 照走）。逐格理由:
   - 带 body 的任何步骤引擎直执零 LLM 不经本链;
   - act 无 body 未标 free 是 B7 反模式形态（本该补 body）,机械直出关;
   - act free 开——工具编排关思考实锤会死（循环打转 20 轮,2026-08-20）;
   - reason 开——推理本体（省钱靠 @thinking off 逐步点名,不靠整类关）;
   - check 开——判错代价不对称（判错一轮=下游几万重试,思考开销几百到几千;deepseek 判官全部好成绩在开档,Ling A/B 开档意见质量正贡献）;
   - commit 关——设计本义零裁量照单执行,思考无益（无 body 的 commit 被 B7 error 拦,实际罕经此级）;
   - replan 开——subtask free 到步展开与失败重规划共用此类别,元编程最重推理面（G3 是弱模型最弱维度）。

五级全缺省不再存在"不发参数吃端点缺省"的形态——第 5 级恒兜底,思考行为自此恒显式恒可审计（端点私有缺省从行为面退场;不认 thinking 参数的端点〔百炼代理实测〕照发吞掉无害）。参数形态各级同一（`disabled` 发 `{type:'disabled'}`;`enabled` 发 `{type:'enabled', budget_tokens: max_output/2}`）。

- **存量行为变化申报**（第 5 级不是零变化——设计如实）:deepseek 类"端点缺省开"的服务零变化;antchat 类"端点缺省关"的服务 reason/check/act free 步转为开(费用升,矫正=provider 级 disabled);变化面随批写进配置参考与 D12。
- **动因**：推理型端点（deepseek-v4-flash 等）缺省开 thinking,机械含量高的步骤边际价值远低于烧掉的预算与延迟（重档实录:90% output_tokens 是 thinking,16384/65536 双档 OUTPUT_TRUNCATED 第一凶手;`thinking:{type:'disabled'}` deepseek 端点实测认——同题 15 tokens → 1 token）。
- commit 无专条吃 act 条时 thinking 随整条继承（同 service/model 半边）。加载期文法核:枚举外值拒（静默失效是 0008③ 同病）。
- **budget 下限夹 1024**（anthropic 协议最低值——小预算+enabled 组合原发 750 违约 400,四十六审探针抓;上限夹 maxOutput-1 防倒挂）。
- 两级合并按 step_type **整条覆盖**（项目级同类别条目不写 thinking 则系统级的 thinking 随条消失——与 tool_servers 同名整体替换同一语义,项目级写全该条）。
- openai-chat 适配器暂不透传（该协议无对应参数,静默忽略即正确——thinking 是 anthropic 协议概念）。
- **使用判据（真机反证记档 2026-08-20）**：disabled 只该用在'一次性直出且模式固定'的调用面——**无 body 的 act/commit 是自主规划的多轮工具编排,恰需推理,禁配 disabled**（实撞:act disabled 下 flash 步骤2〔读原文落盘,此前 6 工具即完〕工具循环打转 20 轮 MAX_TOOL_ITERATIONS 耗尽,run 终局——thinking 省预算的收益在规划型调用面倒挂为致命退化）;带 body 的 act/check 引擎直执零 LLM 本就不发请求,配了无义。
  - 2026-09-20 五级链落地后归一注记——本段禁令针对 routing_rules 整类配 disabled〔当年实撞形态:act 整类关思考致工具循环打转〕,与级 5 的逐格缺省不冲突:级 5 恰把 act free〔真正的工具编排形态〕定为恒开,而'act 无 body 未标 free'是 B7 反模式形态〔本该带 body 的机械步〕缺省关——两者对象有别。
- hopbuild 场景结论:无安全的 disabled 面,hopjit.yaml 留端点缺省;机制保留供确有把握的场景（如纯格式转换的 reason 步）。 ^anc-exec-thinking-routing

**思考关不掉的端点：五级链结果为"关"时改发 `effort: low`**（todo/0118，2026-09-27 作者拍"配置声明关不掉，改发少想"，决策存档 todo/decision/20260927-思考关不掉的端点改发少想.md） ^anc-exec-thinking-disable-unsupported

问题：有的端点思考永远开着，请求里带 `thinking: {type: "disabled"}` 直接报 400。实测 glm-5.3-flash 报文是"该模型始终思考，不支持关闭思考；请使用 low、high 或 max"。上面五级链里会发 disabled 的有第 1、2、3、4、5 各级，其中第 4、5 级可以靠 provider 配 `thinking: enabled` 压住，但第 1 级（烧穿记名册）、第 2 级（步骤 `@thinking off`）、第 3 级（routing_rules 的 disabled）优先级都比 provider 级高，压不住。第 1 级最要命：它是运行中自动触发的止血机制，在这类端点上变成"某步烧穿 → 重试轮发 disabled → 400 → 步骤必败"。

规则：provider 配置可以声明 `thinking_disable_unsupported: true`（schema 权威 [[shared-providers#^anc-config-standalone-schema]] ProviderEntry 同名行），意思是"这个端点的思考关不掉"。

- 五级链照常计算，一级不改；
- 算出来是"开"（`{type: enabled, budget_tokens: N}`）：照常发，不管端点有没有声明——声明只影响"关"的结果；
- 算出来是"关"、且目标端点声明了关不掉：请求里**不带 thinking 键**，改带 `output_config: {effort: "low"}`。第 1、2、3、4、5 级算出的"关"一视同仁，不区分是哪一级给的；
- 没声明（字段缺席或写 false）的端点行为逐字节不变，照旧发 `{type: disabled}`；
- 同一 provider 既写 `thinking: disabled` 又写 `thinking_disable_unsupported: true` 不拒：第 4 级给出"关"，照上一条换成 effort low，含义就是"这个端点缺省尽量少想"。

为什么是 `effort: low`：这是该类端点上唯一实测有效的"少想"手段（maintainers/模型端点票.md glm-5.3-flash 节）——effort low 把思考压到约 17 个字符、总输出 14 token，两发一致答案正确；`budget_tokens` 基本无效（1024 与 16000 思考长度无可见差别），所以不走"enabled 加小预算"。报 400 的报文自己点名了 low/high/max 三个 effort 档位。语义上这等于把"关思考"在这类端点上落实为"尽量少想"：`@thinking off` 在这类端点上的含义就是最低思考档；烧穿止血的方向（先压思考、保住正文）不变。

"目标端点"怎么认：取本次请求路由到的 service_id（resolveModel 的结果，含步骤 `@model` 覆盖）。路由落缺省 provider（service_id 为 default）时回退首 provider 的声明——与第 4 级 provider 缺省的回退同一套规则、同一个取值函数，理由也相同：唯一 provider 配了声明却不写路由时，不回退就静默失效。

两条请求路径同一个点生效：单发路径 buildApiRequest 与工具循环路径 executeActWithTools 的 loopRequest 都经 resolveThinkingParam 装配思考参数，替换就做在 resolveThinkingParam 的出口，两条路径不各写一份。

**能力契约（HopTrait）**：

```
# Spec: 思考参数装配（含关不掉端点的替换）
Id: resolve-thinking-param
Goal: 为一次 LLM 请求给出实际要放进请求体的思考相关参数——五级链算出开或关;
      关的结果落到声明了关不掉的端点时,换成该端点认的最低思考档写法
Inputs:
- step_type % line  # 本次调用的步骤类别 act/commit/reason/check/replan
- step % yaml  # 当前步骤（replan 调用时缺席）
- service_id % line  # 本次请求路由到的服务（resolveModel 结果）
- route_thinking % line  # routing_rules 带出的 enabled|disabled,缺席=未配
- max_output % int  # 本次请求的 max_tokens
Outputs:
- request_fields % yaml  # 要展开进请求对象的字段,三种形态之一（见下方 HopType）
Constraints:
- 五级链的计算与本契约新增的替换彼此独立:替换只看五级链的最终结果和目标端点的声明,不看是哪一级给的结果
- 只替换"关"的结果,"开"的结果无论端点声明与否都原样发
- 未声明关不掉的端点,输出与替换规则引入前逐字节相同
- 输出里 thinking 与 output_config 两个键至多出现一个,不会同时出现
- 单发路径与工具循环路径共用本契约,不各写一份
```

**类型约定（HopType）——request_fields 的三种形态**：

- 开：`{thinking: {type: "enabled", budget_tokens: N}}`——N 为 max_output 的一半，下限夹 1024、上限夹 max_output−1（规则见上文五级链条款）；
- 关（端点未声明关不掉）：`{thinking: {type: "disabled"}}`；
- 关（端点声明了关不掉）：`{output_config: {effort: "low"}}`——effort 固定为字符串 `"low"`，不带 format 等其他 output_config 子键，也不带 thinking 键。

**关键逻辑（HopSop）**：

```
# impl resolve_thinking_param（dispatcher 私有方法;buildApiRequest 与 executeActWithTools 共用）
1. [act] decision = resolve_thinking_decision(step_type, step, route_thinking, service_id, max_output)
   # 原五级链原样搬进本子函数,一行不改:记名册 > @thinking > routing_rules > provider 缺省 > 步骤类型缺省
2. [branch] 看 decision
  2.1. [case(decision 是开)] 返回 {thinking: decision}
  2.2. [case(decision 是关)]
    2.2.1. [act] unsupported = provider_env_of(service_id, "THINKING_DISABLE_UNSUPPORTED")
       # 读 env 快照键 {SERVICE_ID}_THINKING_DISABLE_UNSUPPORTED;service_id 为 default 且本键缺席时
       # 回退首 provider 的同名键——与第 4 级读 {SID}_THINKING 共用同一个取值函数
    2.2.2. [branch] unsupported == "true" → 返回 {output_config: {effort: "low"}};否则 → 返回 {thinking: {type: "disabled"}}
```

**请求体透传**：Anthropic SDK（package.json 锁 `^0.111.0`）的 `MessageCreateParamsNonStreaming` 类型自带 `output_config?: {effort?: 'low'|'medium'|'high'|'xhigh'|'max'|null; format?: ...}` 字段，`messages.create` 只剥 `user_profile_id` 一个键，其余请求字段原样作请求体发出——不需要额外的透传入口。本地假 HTTP 服务器实抓请求体已验证（结论记在 todo/0118 处置记录与该批次 commit message）。

**协议边界**：本声明只对 anthropic 协议有意义，配置加载期对非 anthropic 协议的 provider 写 `thinking_disable_unsupported: true` 响亮拒（理由：openai-responses 适配器本就把 disabled 映成 `reasoning.effort: low`，不会 400；openai-chat 适配器不透传任何思考参数。两种协议下这个声明都不会产生任何效果，允许写就是静默失效）。

**观测（记录点在发送边界）**：hoplog 每轮 `llm.thinking` 摘要从发送口实际请求对象抄，新增一个取值 `effort:low`（请求带 `output_config.effort` 时记 `effort:<档位>`）；原有三个取值 `enabled:budget=N` / `disabled` / `absent` 不变。单发路径与工具循环路径的两处记录共用同一个摘要函数，不各写一份——probe 要核"这一步实发了 effort low"，看的就是这个字段。

**使用点清单**（规则改一处要核这几处）：

1. resolveThinkingParam 出口的替换（单发与工具循环两路径共用）；
2. 第 1 级烧穿记名册的降档（^anc-exec-thinking-exhausted"降档"条已加指针）；
3. 两处 hoplog `llm.thinking` 摘要；
4. 配置加载期文法核与 env 快照派发（mcp-server.ts loadStandaloneConfig / buildEnvSnapshot）。

**协议面**：wire 协议三档 `anthropic` | `openai-chat` | `openai-responses`（v0.7.0 双档,0020 批次扩三档,per-provider 声明——协议适配层见 ^anc-exec-protocol-adapter）。
- Anthropic 格式后端（DeepSeek `api.deepseek.com/anthropic`/代理网关 zenmux/oneapi/litellm）经 `base_url` 切换;
- OpenAI 官方生态与 Responses 兼容端点（OpenAI/DeepSeek `/v1/responses`/xAI/vLLM/Azure）走 openai-responses 适配器（LLM 工具循环原生支持——OpenAI 官方生态工具循环正路,0020 定位）;
- 仅剩 chat/completions 的端点走 openai-chat 适配器（工具循环不支持,fail-fast 指路——0025 兜底定位）。

### 凭证与模型配置

HopJIT 以 CLI 子进程方式被宿主（CC/Codex/OpenClaw/Hermes）启动，继承父进程环境变量获取凭证和模型能力。

**环境变量（第一公民）**

HopJIT 子进程自动继承宿主的环境变量，无需额外配置：

```bash
# CC 环境（子进程自动继承）
ANTHROPIC_AUTH_TOKEN=<token>              # 认证凭证（CC 用 auth token 而非 api_key）
ANTHROPIC_BASE_URL=http://127.0.0.1:9609  # 本地代理网关
ANTHROPIC_MODEL=glink/claude-opus-5[1m] # 当前模型

# 模型能力声明（CC 启动时配置）
ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="effort,thinking,1m-context"
CLAUDE_CODE_MAX_OUTPUT_TOKENS=32768

# 直连 Anthropic 场景
ANTHROPIC_API_KEY=sk-ant-...              # 标准 API key
ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选，默认直连

# DeepSeek 直连场景（原生 Anthropic 格式）
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro
ANTHROPIC_API_KEY=sk-ds-...
```

**凭证解析顺序**：

```
resolve_credential():
  // 1. auth token（CC 本地代理模式）
  if env.ANTHROPIC_AUTH_TOKEN:
    return { type: 'bearer_token', values: { token: env.ANTHROPIC_AUTH_TOKEN } }
  // 2. API key（直连模式；HOPJIT_ 前缀为引擎专属别名，优先级低于通用名）
  if env.ANTHROPIC_API_KEY ?? env.HOPJIT_ANTHROPIC_API_KEY:
    return { type: 'api_key', values: { api_key: ... } }
  // 3. HostConfig.api_key（programmatic 注入）
  if hostConfig.api_key:
    return { type: 'api_key', values: { api_key: hostConfig.api_key } }
  throw AUTH_FAILURE
```

加载顺序与"API 密钥管理"章为同一契约（环境变量 > HostConfig）。

**模型解析**：

```
resolve_default_model():
  if env.ANTHROPIC_MODEL: return env.ANTHROPIC_MODEL
  if hostConfig.model: return hostConfig.model
  return 'claude-sonnet-4-6'
```

**能力解析**：

```
resolve_capabilities():
  capabilities = parse_csv(env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
                        ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES)
  // capabilities 示例：["effort", "thinking", "1m-context"]

  max_output = int(env.HOPJIT_MAX_OUTPUT_TOKENS ?? '32768')   # CLAUDE_CODE_MAX_OUTPUT_TOKENS 已从解析链摘除（:1134 条款）,0084 批三勘正本伪代码残留
  timeout = int(env.API_TIMEOUT_MS ?? '120000')

  return { capabilities, max_output, timeout }
```

PromptAssembler 从 capabilities 提取 context 上限（如 `1m-context` → 1,000,000 tokens），用于预算管理。不在 capabilities 中声明时 fallback 到 200K。

**多服务路由场景**

单服务（只用一个后端）：环境变量足够，`ANTHROPIC_BASE_URL` 指向谁就用谁——Claude 或 DeepSeek 都走同一个 Anthropic SDK。

多服务路由（reason→DeepSeek, check→Claude）：需要同时访问两个后端，用 YAML 配置第二个服务：

```yaml
# ~/.hopjit/config.yaml
# 默认服务从环境变量继承（ANTHROPIC_*），不需要在此重复
# 只需声明额外的服务

services:
  deepseek:
    api_key_env: DEEPSEEK_API_KEY
    base_url: https://api.deepseek.com/anthropic  # 原生 Anthropic 格式
    max_output_tokens: 32768
    # capabilities: effort,thinking,1m-context

routing:
  - match: { step_type: reason }
    service_id: deepseek
    model: deepseek-v4-pro
  # 未匹配的步骤走默认服务（环境变量继承的 Anthropic）
```

**优先级总结**：环境变量 > YAML 配置 > HostConfig programmatic 注入 > 硬编码默认。

安全约束：YAML 只保存环境变量名，不保存 key；密钥禁止日志明文和 CLI 参数传递。`ANTHROPIC_AUTH_TOKEN` 不写入 `.hopstate/` 或日志。

### 协议适配层【契约】 ^anc-exec-protocol-adapter

（2026-08-12 作者定：加入 openai 协议支持；2026-09-20 0020 批扩 openai-responses——作者查证"openai 生态应该走 responses 去调用工具"后拍开工：GPT-5.4 起 chat/completions 不支持 reasoning_effort≠none 的工具调用,Responses 是 OpenAI 官方推荐且 DeepSeek/xAI/vLLM/Azure 已原生跟进,工具循环正路自此归 responses,chat 降级为兜底。）

**定位**：standalone 的 LLM 调用出口按 provider 的 wire 协议分派（anthropic/openai-chat/openai-responses 三形态）。**Anthropic 消息形状是引擎内部表示（IR）**——dispatcher 全部内部签名、HopLog 记账、测试 fixture 都用它；协议差异被压在适配器一层，openai 两适配器做双向转换，anthropic 直通零转换。

**能力契约（HopTrait）**：

```
# Spec: 协议客户端
Id: protocol-client
Goal: 按内部 IR（Anthropic 消息形状）发起一次 LLM 调用并返回 IR 形状响应；错误归一为类别枚举
Inputs:
- request % yaml   # IR：model/system(顶层字段)/messages/max_tokens/temperature/tools?/thinking?（thinking 各协议自译:anthropic 直传/openai-chat 不透传/openai-responses 映 reasoning.effort——0020 review 批补,Trait 入口与转换规则条款对齐）
Outputs:
- response % yaml  # IR：content:[{type:'text',text} | {type:'tool_use',id,name,input}]/stop_reason/usage:{input_tokens,output_tokens}——工具循环轮次响应携 tool_use 块（0020 review 批补:批前只写 text 块,工具轮响应面缺席）。stop_reason 的值集=Anthropic SDK 的 StopReason 联合类型 end_turn | max_tokens | stop_sequence | tool_use | pause_turn | refusal,另可为 null（缺席）;openai 两协议映射后 content_filter 等原值也会透传进来（见 ^anc-exec-output-abort-loud 映射条）,所以消费侧按 classifyStopReason 三分（正常三值与缺席 / max_tokens / 其余一律 aborted）判,不按枚举穷举（2026-10-11 语义审计 0156 C3 改定:此前写三值 end_turn|tool_use|max_tokens,漏 stop_sequence 与 todo/0121 之后的非正常值）
Constraints:
- classifyError(err) → 枚举 rate_limited/server_error/timeout/network/unreachable/auth/context_overflow/temperature_rejected/other（九值,与代码 LlmErrorKind 同;unreachable=端点不可达,v0.38.0 hopissues/0106 加,先于 network 判,见 ^anc-exec-network-pause）——dispatcher 重试策略按类别分派，不再 instanceof SDK 错误类
- classifyError 判 timeout 的来源:SDK 超时错误类,或错误本身/cause 链上带 undici 等待超时错误码（UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT）——后者先于裸网络文案兜底判（v0.36.0,^anc-exec-api-retry D61 条）
- 构造时带长等待连接设置、SDK 内部重试关掉（maxRetries 0）,create 给 SDK 第二参 { timeout: 单次请求等待上限 }（^anc-exec-nonstreaming-timeout,v0.36.0）
- 构造时显式传 apiKey/baseURL，切断 SDK 隐式 env 读取（openai SDK 自读 OPENAI_API_KEY 同 anthropic SDK 自读 AUTH_TOKEN——standalone 不变量 2"显式压过隐式"，401 实撞同型预防）
```

**类型约定（HopType）**：

```
HopType: ProtocolClientHandle
  Id: protocol-client-handle
  Fields:
    - protocol % line  # 枚举 anthropic/openai-chat/openai-responses（三值现役,见 shared-providers ProviderEntry）
    - create % yaml    # (request: IR) → Promise<IR 响应>
    - classifyError % yaml  # (err) → 错误类别枚举（九值,见上方 Constraints 第一条）
    - supportsToolLoop % bool  # 该协议能否承载 LLM 工具循环（anthropic/openai-responses=true,openai-chat=false）——dispatcher 工具循环闸与 reason 降级道判它,不再比对协议枚举名（能力谓词:新协议接入改一处,枚举比对散点会漏——0020 批立）
    - endpoint? % yaml  # 可选。端点身份 { service_id: line, base_url?: line }——dispatcher 构造 client 后盖章,缺省 provider 的 service_id 记 'default';两个消费点:①端点不可达 fail-fast 报文"配了哪个后端、指向哪、为什么连不上"三样（hopissues/0106）;②"曾经连通过的端点"表 reachedEndpoints 的键 `${service_id}|${base_url ?? ''}`（hopissues/0118）。见 ^anc-exec-network-pause 末两条（2026-10-11 语义审计 0156 C3 补:代码 ProtocolClient 接口早有此字段,HopType 漏列）
    - messages? % yaml  # 可选。anthropic 直通包装保留底层 SDK messages 资源引用——只为既有测试经 defaultClient.messages.create 抓 mock（"IR 不变"的守卫物证）;openai 两协议无此字段
```

**openai-chat 适配器的转换规则**：
- 请求：IR 顶层 `system` 字段 → openai `messages` 首条 system 消息；`max_tokens` 直传（兼容端点通吃；官方新模型需要 max_completion_tokens 时再按错误重试处理）；`temperature` 直传（被拒剥除重试与 anthropic 路径同一机制）
- 响应：`choices[0].message.content`（字符串）→ IR `content:[{type:'text',text}]`；`usage.prompt_tokens/completion_tokens` → `input_tokens/output_tokens`
- 错误：openai SDK 错误类（RateLimitError/InternalServerError/APIConnectionTimeoutError/APIConnectionError/AuthenticationError/BadRequestError）→ 同一类别枚举；
  - context_overflow 靠 BadRequest 文案匹配（收紧判据与 anthropic 侧同一函数——'prompt is too long'/'context_length' 等实际文案，禁裸命中 token/context 子串：旧宽松判据曾把 'invalid token' 鉴权错误误判溢出触发降级重组）

**openai-responses 适配器的转换规则（0020 批,2026-09-20）**——端点 `POST /v1/responses`,经 openai SDK `client.responses.create()` 调用（SDK v7 自带 responses 资源与 typed items 类型,适配器只写 IR↔Responses 双向转换,不写传输层）：
- 请求映射逐项：
  - IR 顶层 `system` → `instructions` 字段（Responses 的顶层 system 对应物;块数组形态拍平剥 cache_control,与 chat 侧同型转换）；
  - IR `messages` → `input` typed item 数组——text 块消息映 `{role, content}` message item;
    - assistant 消息里的 `tool_use` 块映 `{type:'function_call', call_id, name, arguments:JSON字符串}` item;
    - user 消息里的 `tool_result` 块映 `{type:'function_call_output', call_id, output}` item（IR 工具往返消息形状与 Responses typed items 一一对应,这正是工具循环可原生映射的结构基础）；
  - `max_tokens` → `max_output_tokens`;`temperature` 直传;
  - IR `tools`（Anthropic 形:name/description/input_schema）→ Responses 工具形 `{type:'function', name, description, parameters:input_schema, strict:false}`（**顶层平铺,不包 chat 的 function 壳**——DeepSeek 真机四拍探针实证 2026-09-20;strict:false=不启用 OpenAI 结构化输出严格模式,引擎工具 schema 非全字段 required、strict:true 会拒）;
  - IR `thinking` → `reasoning.effort` **两点映射**（作者拍 2026-09-20）:`{type:'disabled'}`→`{effort:'low'}`〔非真零——low 是普遍可用最低档,minimal/none 部分模型不认〕、`{type:'enabled'}`→`{effort:'high'}`〔enabled 语义即重投入档,medium=端点缺省映了等于没映〕;
    - `budget_tokens` 数值丢弃不换算——只翻译开关不发明"预算数→档位"规则;IR 无 thinking 键则不发,吃端点缺省;
    - 思考开关五级链语义自此跨 anthropic/openai-responses 两协议一致,openai-chat 仍不透传〔该协议无对应参数〕;
  - **reasoning 被拒剥除重试**（OpenAI 官方对非推理模型发 reasoning 参数 400 拒,而 provider 配置不知对面模型型别——与 temperature 剥除重试同模式:BadRequest 且文案命中 reasoning → 剥除该参数当场重发一次并记该 client 免传;剥除逻辑在适配器闭包内不进 dispatcher 重试表——reasoning 是 responses 协议私有参数,生命周期归协议适配器。DeepSeek 类端点对不认识参数静默忽略,照发无害）
- **reasoning item 工具轮回显（0020 批次阅卷抓高危后补——OpenAI 官方推理模型在 store:false 无状态形态做工具循环,要求 function_call 随其前导 reasoning item〔含 encrypted_content〕一起回显,缺席即二轮 400 拒）**：适配器闭包持**工具轮缓存**（call_id → {function_call item id, 前导 reasoning items 原样}）。
  - 响应侧收 function_call 时把它与其前导 reasoning items 按序入缓存（reasoning 仍不进 IR,引擎零感知）;
  - 请求侧转换 IR tool_use 块时查缓存命中则先回显缓存的 reasoning items 原样、function_call 带原 item id,未命中照旧只发 call_id（跨进程恢复等缓存丢失场景——宽松端点照走,严格端点该轮拒了走重试链,不比没有缓存更糟）;
  - 带工具请求同时发 `include: ['reasoning.encrypted_content']`（store:false 下取加密思考链的官方通道）;include 被拒同 reasoning 参数剥除重试模式（判据独立命中:剥除重试的文案判据为 /reasoning|include/i——include 被拒报文可能不含 reasoning 字样〔如 'Unknown parameter: include'〕,0020 review 批次抓'靠 include 值恰含 reasoning 的巧合'后补独立半边）;
  - 缓存封顶 128 键先进先出防长循环无界增长;
  - **边界如实申报（2026-09-20 二轮真机后收窄）**：真机实证面两档——DeepSeek /v1/responses（无状态宽松端点,工具循环 E2E 通过）+ **zenmux 中转 OpenAI 官方推理模型**（gpt-5.4-mini,effort=high 真出 reasoning item 含 encrypted_content,回显形态与缓存未命中退回形态双通,引擎全链工具循环 E2E completed——作者给 key 后销账）;
    - 剩余未验面=**OpenAI 官方直连**（api.openai.com 无凭证,中转层可能比直连宽松——接入时首个工具循环 run 即验收面,撞拒循 hoplog llm.request 核对回显形态）;
  - 环境注记:openai SDK（undici）缺省不认 http_proxy 环境变量,走代理才可达的端点 SDK 直连恒超时（curl 认 proxy 故探针通而 SDK 不通,易误诊端点故障）——Node 24 起 `NODE_USE_ENV_PROXY=1` 即认,宿主环境事实非适配器缺陷
- 响应映射逐项：顶层 `output` typed item 数组 → IR content 块——
  - `message` item 的 `output_text` 内容映 `{type:'text',text}`;
  - `function_call` item 映 `{type:'tool_use', id:call_id, name, input:JSON.parse(arguments)}`（arguments 解析失败按原文入 other 类错误,不静默吞）;
  - `reasoning` item 丢弃不进 IR（引擎不消费思考正文,与 anthropic thinking 块处置同口径）;
  - `status:'incomplete'` 且 `incomplete_details.reason:'max_output_tokens'` → IR `stop_reason:'max_tokens'`,其余 completed → 有 function_call item 时 `tool_use`、无则 `end_turn`（IR stop_reason 语义对齐:anthropic 侧工具轮停由 tool_use 表达）
- usage：顶层 `usage.input_tokens/output_tokens` **同名直取**（无须转名——与 chat 的 prompt/completion_tokens 不同）;`input_tokens_details.cached_tokens` → IR `cache_read_input_tokens`（Responses 比 chat 多给的缓存事实,如实入账）
- 错误：与 chat 适配器共用同一 classifyError（同 SDK 同错误类同文案判据,零分叉）
- **无状态端点兼容（最小公共面原则）**：适配器恒走"全量 input 重发"形态——不发 `previous_response_id`、恒显式发 `store:false`（OpenAI 官方缺省 store:true 会留服务端存档,显式关——standalone 不变量"显式压过隐式";DeepSeek 本就无状态,照发无害）、不用服务端会话态。
  - DeepSeek `/v1/responses` 无状态实证:恒报 store:false/previous_response_id:null,不支持的参数静默忽略;引擎 IR 本就每请求全量自含,增量态本无需求——最小公共面恰与现架构零摩擦;
  - openai 两协议的服务端工具（web_search 等 built-in tools）不下发不消费（引擎工具面走自己的 ToolProvider,见 tool-channels）;anthropic 协议的 `web_search` 走下方「web_search 请求时探测 provider 原生搜索」条款,openai 协议的对应形态归后续

**web_search 请求时探测 provider 原生搜索（todo/0153,作者 2026-10-12 拍"请求时探测"）**

spec `## Tools` 段声明的标准工具 `web_search`,在独立模式下此前只有一条落实路：`tool_servers` 里注册一个外部检索 MCP（`tool_id: web_search`,范本 `examples/hoptools-websearch.yaml`）,没注册起跑就 INIT_FAILED。2026-10-12 对本机六个 anthropic 协议 provider 实测（hop_tasks/archive/0153独立模式原生搜索探测）：deepseek 认 Anthropic 原生的服务端搜索声明（响应里是 `server_tool_use` 块 + `web_search_tool_result` 块）,智谱 glm 认自家异形（`server_tool_use` 块但工具名叫 `web_search_prime`,结果块类型是 `tool_result`,内容是一个 Python repr 字符串）,antchat 两家把服务端工具声明当成普通客户端工具、回 `tool_use` 块等引擎执行,qwen_flash 忽略声明直接作答。四种响应形态都要有确定的处置。

*为什么是请求时探测而不是配置字段或域名表*（作者三选一拍板,另两案的代价记在这里）：显式配置字段（providers[] 加 `native_search: true`,setup 对已知域名自动填）——每接一个新 provider 都要人手加一行,否则静默走不到原生搜索;按 base_url 域名自动判——第三方代理端点（antchat / dashscope 的 anthropic 兼容面）判不准,引擎被动跟着厂商域名表走,用户想关也没开关。请求时探测的代价是"可能多发一次请求、要缓存探测结果、行为取决于对面响应"——设计把多发压到只有一种响应形态会发生、缓存落在实例状态随快照持久化、每种响应形态的行为写死,三条代价各自封口。

*触发条件*：本步工具面（节点授权筛后）含 `web_search`,且本步解析出的 provider 协议是 `anthropic`（`HostConfig.protocol` 缺省值,或 `{SERVICE_ID}_PROTOCOL` 为 anthropic）。openai-chat / openai-responses 本条款不覆盖,照旧只认 tool_servers 注册。

*探测状态机*（dispatcher 私有,executeActWithTools 组 tools 数组与消费响应处各接一次;reason / check 走同一循环体,行为同）：

```
HopType: WebSearchModeTable
  Id: web-search-mode-table
  Fields:
    - modes % yaml  # Record<service_id, 'native' | 'client' | 'none'>——每个 provider 一条,本 run 内探测一次定下;随 state.json 的 web_search_modes 键持久化,resume / 跨进程恢复不重探;不写回 ~/.hopjit/config.yaml（用户配置不由引擎改）

# impl web_search_tools_for_request(tools, service_id, mode)   # 组 tools 数组时按模式决定 web_search 条目形态
1. tools 里没有 name 为 web_search 的条目 → 原样返回（本条款不触发）
2. mode 为 client → 原样返回（客户端工具形态,按 tool_servers 注册项下发;注册项不存在时 tools 里本来就没有这一条——起跑放行的是"未注册但协议是 anthropic",见下）
3. mode 为 native 或 未定 → 把 web_search 条目**替换**成服务端工具声明 {type: 'web_search_20250305', name: 'web_search', max_uses: 3}（替换不是追加——同名两条 Anthropic 400 拒;max_uses 缺省 3,v1 不开放配置）;其余工具不动
4. 注册项不存在且 mode 未定 → tools 里原本没有 web_search 条目,仍按第 3 步**追加**一条服务端工具声明（这是放行进探测的那条路）

# impl classify_web_search_response(response, had_server_decl)   # 探测轮消费响应,定模式;had_server_decl=本轮 tools 里发的是不是服务端声明
1. 本轮没发服务端声明 → 不判,返回 undefined（模式已定为 client 的后续轮,或本步没有 web_search）
2. response.content 里有 type 为 server_tool_use 的块 → 'native'。**只认块类型不看工具名**（deepseek 叫 web_search,智谱叫 web_search_prime;看名字就把智谱判丢了）
3. 否则 response.content 里有 type 为 tool_use 且 name 为 web_search 的块 → 'client'（antchat 形态：provider 把服务端声明当客户端工具,回了一个要引擎执行的调用）
4. 否则 → 'ignored'（qwen_flash 形态：声明被无视,直接作答）

# impl resolve_web_search_mode（executeActWithTools 内,每轮响应到手后、hasToolUse 判定之前）
1. mode 已定（modes[service_id] 在场） → 跳过本函数
2. kind = classify_web_search_response(response, had_server_decl);kind 为 undefined → 跳过
3. kind 为 native → modes[service_id] = 'native',写进引擎状态随下次 persist 落盘;本轮按正常循环继续——
   - assistant content 原样回显进 messages（Anthropic 原生接受 server_tool_use / web_search_tool_result 回显;智谱把 tool_result 放在 assistant content 里,回显也原样）;
   - hasToolUse 只看 tool_use 块,server_tool_use 不会把循环带进客户端工具执行;
   - 产出照旧从 text 块取。**引擎不解析搜索结果体**——模型已在服务端消费完,glm 的 Python repr 字符串对引擎是不透明块;
   - 留痕：toolCallLog 记一条 {name: <server_tool_use 的工具名>, result: 'success', args_preview: input}（hoplog tool 块可对账"这一步搜了什么"）;hoplog llm.response 的块摘要里 server_tool_use 渲染成 `[server_tool_use <名>] <input JSON>`,web_search_tool_result / tool_result 渲染成 `[<块类型> <内容长度>字]`
4. kind 为 client →
   - tool_servers 里有 web_search 注册（toolProvider.list() 含 name 或 tool_id 为 web_search 的条目） → modes[service_id] = 'client',本轮这个 tool_use 就按现行客户端工具循环执行,不多发请求;
   - 没注册 → modes[service_id] = 'none',抛 `WEB_SEARCH_UNAVAILABLE: provider <service_id> 不认原生搜索,且 tool_servers 未注册 web_search——按 examples/hoptools-websearch.yaml 注册一条,或换认原生搜索的 provider`（普通档失败,容器 retry 不会好转但不进事务级清单——换 provider 路由后重跑是合法的）
5. kind 为 ignored →
   - 有注册 → modes[service_id] = 'client',**同一请求重发一次**,tools 里 web_search 换回客户端工具形态（全链唯一一次额外请求,只在探测轮、只在这一种响应形态下发生;重发轮的响应替换本轮响应继续走循环,本轮响应只进 hoplog 不进 messages）;
   - 没注册 → modes[service_id] = 'none',抛同上 WEB_SEARCH_UNAVAILABLE
6. 探测轮请求被端点 400 拒且报文提到 tools / web_search / type（provider 整个拒收服务端声明）→ 与 kind 为 ignored 同处置（有注册重发客户端形态,没注册抛 WEB_SEARCH_UNAVAILABLE）;其余 400 照旧上抛
```

*模式定下后*：同 provider 的后续步骤直接按模式组 tools——native 每步带服务端声明,client 按注册项,不再探测;跨进程恢复时 modes 从快照回填。

*起跑对账的放行条件*（[[exec-engine#^anc-exec-tools-reconcile]] 第二调用点 dispatcher.runSpec）：对账前先把 needs 里的 `web_search` 挑出来——它未注册且缺省 provider 协议为 anthropic → 从对账 needs 里剔除,放行进探测;未注册且协议不是 anthropic → 留在 needs 里,照旧 INIT_FAILED 指路注册;已注册 → 留在 needs 里走四判。放行只看缺省协议：显式 `@model` 路由到 openai 协议 provider 的步骤若用 web_search 没注册,会在 PROTOCOL_TOOL_LOOP_UNSUPPORTED / 该协议的既有路径上失败,不在起跑期拦。

*v1 边界*：①引擎不解析搜索结果体,hoplog 只记 server_tool_use 的 input 与结果块的类型和长度;②openai 两协议不做;③max_uses 固定 3,不开放配置;④探测结果只落实例 state,不持久化到用户配置——换 run 重探一次（一次请求的代价,换来 provider 升级后自动跟上）;⑤真机端到端归作者终端（合入后用 examples/hop-fact-check.md 在 deepseek / glm 各跑一遍）。

**工具循环协议边界（0020 批次改定,原"当下边界"段翻案）**：LLM 工具循环（executeActWithTools 的 tool_use 往返）按 **supportsToolLoop 能力谓词**分道。
- anthropic 与 openai-responses 原生承载（responses 的 function_call/function_call_output typed items 与 IR tool_use/tool_result 一一映射,循环体共用零复制）;
- openai-chat 维持 fail-fast（错误码 PROTOCOL_TOOL_LOOP_UNSUPPORTED,报文指路三选一：给 act 写 hop_python body、@model 路由到 anthropic 协议 provider、或该端点若有 `/v1/responses` 面改配 protocol: openai-responses）。
- reason 工具面同谓词：supportsToolLoop=false 时退回单发零工具（不 fail-fast——reason 总能纯推理产出）;
- 翻案理由：2026-08-12"不做 openai 映射"的依据是"为兜底窗口做双协议映射不划算",当时 openai 协议只有 chat 一形态;Responses 起势后 OpenAI 官方生态的工具调用正路就是 responses（GPT-5.4 chat 限制),且其 typed items 与 IR 结构同构、映射成本远低于当年评估的 chat 映射,"不划算"前提消失（^todo-openai-tool-loop 观察账随 0020 批次销账）;
- 带 body 的 act/commit 在任何协议上照旧（body 工具走引擎白名单通道,不经 LLM 协议面）。

**正反例**：
- chat 请求/响应双向映射正例；
- responses 请求映射正例（system→instructions/工具形顶层平铺/max_output_tokens 转名）；
- responses 响应映射正例（message→text/function_call→tool_use/usage 同名直取+cached_tokens 入账）；
- responses 工具循环全链正例（tool_use 往返两轮）；function_call arguments 坏 JSON 反例；
- 无 body 带工具 act × openai-chat → fail-fast 反例；同形 act × openai-responses → 放行正例；带 body act × openai 两协议 → 正常正例；
- config protocol 三枚举放行正例、乱值拒绝反例；既有 anthropic 全量测试零改动（IR 不变的守卫）。

### 路由解析【契约】 ^anc-exec-model-resolve

```
# Spec: 模型路由解析
Id: model-resolve
Goal: 给一个待执行步骤解析出 service_id+model——spec 面三级软偏好（缺席 warn 落级沿链向下）,系统面加载期已核直取,链尾恒有缺省必有归宿不报错
Inputs:
- category % line      # 路由类别 RoutingCategory（act/commit/reason/check/replan）
- step % yaml          # 可选。StepReady（@model 标注经它取）
- spec_config % yaml   # spec Config 段（models 逐类别/model 单默认）
- model_engine % yaml  # 系统层 ModelEngine（routing_rules/default_model）
Outputs:
- resolved % yaml      # { service_id, model }
```

```
resolve_model(category, step, spec_config, model_engine):
  // category = 路由类别：act/commit(commit 无专条时回落 act 共档——回落在解析函数内,不在调用点)/
  // reason/check/replan（replan 2026-08-13 作者定升独立类别——元编程任务须会 HopSpec 的模型,
  // 原借 reason 档; confirm/ask 是介入点无 LLM 不路由;call 用子 spec 自己的 Config）
  //
  // 调用点类别忠实（2026-08-17 hopissues/hoplogic3/0003——生产调用点曾硬编码 'act',commit 步
  // 全按 act 档解析,Config.models.commit/routing_rules[commit] 永不生效静默降配;而"显式 commit
  // 分档"测试直调 resolve_model('commit') 绕过调用点,全绿掩盖=测在死路径上）：每条 LLM 调用
  // 路径传**真实步骤类别**——executeActWithTools 按 step.step_type（act/commit）,不许写死;
  // "commit 无专条吃 act 条"的共档语义由解析函数内的回落实现,调用点写死 'act' 是把回落
  // 错位到了调用点、顺带杀死了专条。测试判据同款忠实：分档测试必须穿过生产调用点
  //（喂假 LLM 断言实际请求的 model）,直调解析函数只测解析不测接线。
  //
  // 两层配置模型（作者定形 2026-08-13）：spec 层缺省**逐类别继承**系统层——
  // spec 的 models: 只写 replan: 一键,其余四类照用系统层;不是整块覆盖。
  // 两层正当性:系统层=运营者声明"环境各档用什么模型";spec 层=作者声明"本任务哪类要超/降配"。
  //
  // ── spec 面（Priority 1-3）＝软偏好（作者定 2026-08-13"有这个模型就用,否则用缺省"——
  //    与 Constraints 同哲学:spec 声明意图,环境尽力满足,满足不了不炸。分界线=写的人能否控制环境:
  //    spec 是分发面,作者对运行环境零控制权;service 缺席是环境差异不是笔误）:
  //    命中后核 service 在场性（providers 内〔大小写归一〕或环境有 {SERVICE}_API_KEY——
  //    getClientForService 既有第二通道;裸模型名/default 恒在场）。
  //    在场→用;缺席→warn 留痕后跳过该级、沿链继续向下逐级尝试直到命中（spec 三级各自独立核偏好,
  //    谁未满足谁被跳过;链尾内置缺省恒有值,必有归宿不存在全链落空）。不炸不静默——
  //    warn 记在被跳过的那级（偏好是什么/缺哪个 service）,命中级不记,日志读出"偏好未满足→实际用了谁"。
  //    落账通道不变量：warn 暂存必须在**每条 LLM 调用路径**的收尾处 flush——reason/check（无工具循环）、
  //    act/commit（有工具循环）、replan 三段管线（handleAdaptive,随 subtask 落账）三类路径都要落,
  //    不许只挂在工具循环半边（真机实撞 2026-08-13:reason 步落级 warn 悬在内存到 run 结束被丢,
  //    vitest 直调 resolveModel 测不出;同日 review 抓 replan 管线同型漏——不变量按"路径"表述,不按"步骤"）。
  // Priority 1: 步骤 @model 标注（最 specific,单步覆盖）
  if step.model_override and service_available(step.model_override):
    return parse_model_ref(step.model_override)
  // Priority 2: spec 层类别映射 Config.models[category]
  if spec_config.models?.[category] and service_available(...):
    return parse_model_ref(spec_config.models[category])
  // Priority 3: spec 层单默认 Config.model（= 全类别同值的简写,类别键比它 specific）
  if spec_config.model and service_available(...):
    return parse_model_ref(spec_config.model)
  // ── 系统面（Priority 4-5）：解析时不查 service 在场性,拿来就用——不是不检查,
  //    是检查在门口做完了：config.yaml 加载那一刻每条 routing_rules/default_model 引用的
  //    service 已逐条核"必须在 providers 内",不在直接拒绝启动（providers 就写在同一个文件里,
  //    对不上是笔误不是环境差异）。能活到运行期的系统配置引用一定有效,再查是重复劳动
  // Priority 4: 系统层类别规则 routing_rules[category]（StandaloneConfig 文件入口批 1 实装）
  for rule in model_engine.routing_rules:
    if rule.match.step_type == category:
      return { rule.service_id, rule.model }
  // Priority 5: 系统层默认
  if model_engine.default_model:
    return { model_engine.default_service_id, model_engine.default_model }
  // Priority 6: ANTHROPIC_MODEL 环境变量（仅无显式默认时继承）
  if env.ANTHROPIC_MODEL:
    return { service_id: 'default', model: env.ANTHROPIC_MODEL }
  // Priority 7: hostConfig.model fallback
  if hostConfig.model:
    return { service_id: 'default', model: hostConfig.model }
  // Priority 8: 硬编码兜底
  return { service_id: 'default', model: 'claude-sonnet-4-6' }
```

`parse_model_ref` 解析 `service/model` 格式字符串。纯 model 名（无 `/`）视为默认服务的模型（service_id 记 `default`）;带 `/` 时按第一个 `/` 切分,左边是 service_id、右边是 model（model 名本身含 `/` 的形态因此照常通过,例如 `bailian/qwen/qwen3-max` 得 service_id=bailian、model=qwen/qwen3-max）。下列三种引用抛 `INVALID_MODEL_REF` 拒收，报文带原文（2026-10-11 语义审计 0156 C3 补写，此前三条规则只在代码里）：

1. 引用是空串,或首尾带空白——空白是配置手误（`" sonnet"` 这类值直传会让端点报查无此模型,错因难定位）,统一在解析口拒;
2. 引用以 `/` 开头——service 位为空（如 `/sonnet`）;
3. 引用以 `/` 结尾——model 位为空（如 `bailian/`）。

三条都是加载期或路由期的确定性配置错误,不进重试;dispatcher 的 resolve_model 与 mcp-server 的配置核对消费同一个解析函数,报文形态一致。

### 客户端池

StepDispatcher 维护 `Map<service_id, Anthropic>` ——每个 service 是一个独立配置的 Anthropic SDK client（不同 base_url + 凭证）：

```
// 按需创建——首次使用某 service 时初始化
get_or_create_client(service_id: string):
  if clients.has(service_id): return clients.get(service_id)
  credential = identity_provider.get_credential(service_id)
  base_url = resolve_base_url(service_id)
  if service_id != 'default' and !credential: throw UNKNOWN_SERVICE
  auth = env_of(`{SERVICE_ID}_AUTH`)   // 鉴权头档（^anc-config-standalone-schema auth 字段——bearer=只认 Authorization: Bearer 的网关）
  opts = auth == 'bearer'
    ? { apiKey: null, authToken: key }  // bearer 档:走 SDK authToken 通道;apiKey 置 null 防双头（两头都发部分网关 401）
    : { apiKey: key, authToken: null }  // 缺省 api-key 档:x-api-key 头,authToken 置 null 切断 SDK 隐式 env 读取
  client = new Anthropic({ ...opts, baseURL: base_url })
  clients.set(service_id, client)
  return client
```

默认服务（service_id='default'）从环境变量构建：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`。
- **standalone 下 defaultClient 同样消费首 provider 的 auth 档**（providers[0] 快照 `{SID}_AUTH=bearer` 在场时 defaultClient 按 bearer 双臂构造——2026-09-18 review 抓缺省路径漏装:唯一 provider 配 bearer 不写显式路由时,resolveModel 落 'default' 直取 defaultClient,原构造硬编码 x-api-key 恰撞回该档要治的 InvalidApiKey）。
额外服务从 YAML 配置加载。所有服务统一走 Anthropic SDK，只是 base_url 和凭证不同。

### `@thinking` 步骤标注【契约】 ^anc-exec-thinking-step-annotation

（0100 批,2026-09-20 作者拍"单步开关需要补"——B 案:独立标注不与 @model 耦合）步骤 `>` 指令区可写 `@thinking off` 或 `@thinking on`（一步至多一条,off/on 两值,其它值解析期报错不静默）:

- **解析**：extractModelAnnotation 同族同通道——解析期从指令区剥出存 AST 步骤节点（`thinking_override?: 'on' | 'off'`）,不进执行 LLM 的 prompt;serialize 往返保留（与 @model/@src 同款纪律）;
- **消费**：请求装配层直查步骤节点（buildApiRequest 与 executeActWithTools 共用 resolveThinkingParam 单点——单发路径与工具循环路径同一条五级链,resolveModel 返回面只承载 routing_rules 半边不扩步骤覆盖）——决策链第 2 级（见 ^anc-exec-thinking-routing 五级链;记名册强制项恒压过它——止血优先,标 on 的烧穿步重试轮照样 disabled）;
- **只对可执行步骤有效**（reason/act/check/commit——与 @model 同边界）;带 body 的步骤引擎直执零 LLM,标了无义解析不拒（与 @model 同容忍——生成器可能统一带标注）;
- **构建器消费面**：hopbuild2 目标执行档规则可按目标模型档案的 thinking_off_whitelist 给机械提取/格式转换步自动带 `@thinking off`（思考型目标模型专属;非思考型模型此标注发 disabled 参数无害——端点不认 thinking 参数的〔如百炼代理〕照发不炸,实测吞掉零效果）。

### `@model` 标注解析

parser.ts 在解析 `>` 指令区时提取 `@model service/model` 标注，存入 `BaseStep.model_override`。与 `@knowledge` 提取逻辑类似——正则 `/@model\s+(\S+)/` 匹配，提取后从 instruction 文本中移除（不进入 LLM prompt）。

### build_api_request 更新

```
build_api_request(context, step_type, step):
  { service_id, model } = resolve_model(step, spec_config, model_engine)
  client = get_or_create_client(service)
  capabilities = resolve_capabilities_for_service(service)
  return {
    model: model,
    ...resolve_thinking_param(step_type, step, resolved, max_output),   # thinking 五级链单点(工具循环 loopRequest 同用——2026-09-20 review 批补,伪码原漏装配行)

    system: build_system_prompt(context),
    messages: build_messages(context),
    max_tokens: capabilities.max_output,
    temperature: select_temperature(step_type),
    tools: step_type === 'act' ? format_tools(tool_provider.list()) : undefined,
  }
  // 用 client.messages.create(request) 调用——所有 service 统一 Anthropic 格式
```

### 向后兼容

- `HostConfig.api_key` + `HostConfig.model` 仍然有效——构建默认服务的单 client
- 无 YAML + 无多服务环境变量 → 行为与 v1 完全一致（单 Anthropic client）
- 配置文件明文 key 不再兼容；StandaloneConfig 只允许 `api_key_env`

---

## 成本护栏【契约】 ^anc-exec-cost-guardrails

五个独立机制防止无限制的 API 消耗——前三个是硬闸（到上限即失败），第 4 个是单步时限，第 5 个只观测告警不拦（2026-10-11 语义审计 0156 C3 改定：此前首句写"三个"而下方实列五条，第 4 条单步超时与第 5 条上下文水位是后加的，首句未同步）。

### 1. tool_use 迭代上限

act 步骤的 tool_use loop 最多执行 N 次工具调用（默认 20，可通过 Config 覆盖）。超过上限后以 MAX_TOOL_ITERATIONS 错误 fail step，由 subtask retry 机制处理。重做轮的修正指令对这个原因单独渲染（说明是工具次数用完、不是产出形态问题，并教"文件还在接着改、省着用工具、做不完按降级交并写 no_change"），见 [[prompt-assembler#^anc-exec-l2c-retry-feedback]] 材料段"执行过程类失败"条。

```
execute_act_with_tools(context, max_iterations = host_config.resource_limits?.max_tool_iterations ?? 20):
  tools = tool_provider.list()  // 从 ToolProvider 获取可用工具定义
  iteration = 0
  while iteration < max_iterations:
    if budget_exceeded(state.cumulative_tokens, state.token_budget):
      throw BUDGET_EXCEEDED error
    response = call_llm_api(messages, tools)
    state.cumulative_tokens += response.usage.total_tokens  // 每次 LLM 调用后累计
    if response has no tool_use:
      return response.text  // LLM 判断任务完成
    for each tool_call in response.tool_use:
      result = execute_tool(tool_call.name, tool_call.args)  // 走 sandbox + provider（act 不走 authorize）
      append_to_messages(response, result)
    iteration++
  // 达到上限：统一走错误路径
  throw MAX_TOOL_ITERATIONS error
```

### 2. 全局执行预算（可选）

通过 DispatcherConfig 的 `tokenBudget` 设置全局 token 消耗上限。StepDispatcher 在每次 API 调用后累计 usage 到 `cumulative_tokens`，并同步给引擎随快照落盘（resume 重建 Dispatcher 时回填，预算护栏不被进程重启绕过——字段契约见定位节 ③）。达到上限后，run_spec 以 `BUDGET_EXCEEDED` 终止。

```
// Dispatcher 字段
cumulative_tokens: number  // 累计 token 消耗（input + output）——每次累计后 engine.setCumulativeTokens 同步,随 state.json 落盘
token_budget?: number      // tokenBudget 设置的上限（undefined = 无限制）——不落盘,宿主 resume 时重新给定

// StepDispatcher 每次 API 调用后
state.cumulative_tokens += response.usage.total_tokens
engine.setCumulativeTokens(state.cumulative_tokens)
if token_budget && state.cumulative_tokens >= token_budget:
  stop execution with BUDGET_EXCEEDED
```

### 3. Adaptive replan 熔断

在 exec-engine.md 的 Adaptive Replan 协议中定义（见 [[exec-engine]] 执行策略 > Adaptive Replan 协议 > 熔断机制）。

### 4. 单步超时（per-step timeout）

当 `host_config.resource_limits?.timeout_seconds` 有值时，StepDispatcher 在 execute_step 外层包装超时检测：

```
execute_step_with_timeout(next_resp, timeout_seconds?):
  if timeout_seconds is undefined:
    return execute_step(next_resp)     // 无超时限制

  return Promise.race([
    execute_step(next_resp),
    timeout_promise(timeout_seconds)   // reject with STEP_TIMEOUT
  ])
```

**超时触发路径**：
1. **检测方**：StepDispatcher（非 Engine）
2. **机制**：`Promise.race` + `AbortController`——超时后取消进行中的 API 调用（若有），不等待 API 返回
3. **ErrorCode**：`STEP_TIMEOUT`（不可重试，定义见 [[shared-types]]）
4. **后续路径**：StepDispatcher 调用 `engine.fail_step(step_id, 'STEP_TIMEOUT: exceeded {timeout_seconds}s')`，由 Engine 的升级链处理
5. **tool_use loop 中超时**：已执行的工具调用结果保留（已写入 messages），未执行的丢弃。超时后不回滚已完成的工具副作用

**与暂停等待的区别**：per-step timeout 只作用于**步骤执行期**（LLM 调用/工具循环），统一走 fail_step；暂停等待（confirm/ask paused）**无超时概念**（见 `^anc-exec-pause-timeout`），永久有效。

### 5. 实例级上下文体量观测与软阈值告警 ^anc-exec-ctx-watermark

**为什么（hopissues/0095 实测定论,2026-09-16 作者拍"再等着卡死?"）**：长转录任务的输入上下文与单轮延迟超线性恶化——实测 140K 时单轮 3-4 分钟,150-165K 升到 8-16 分钟,170K+ 飙到 25 分钟直至 62 分钟服务端超时零产出死亡。
- 恶化全程引擎零观测：hoplog 只记 per-step 的 input_tokens,没有"这个实例正在往墙上走"的累计视图与告警,只能事后尸检;
- 机制 2（全局预算）管的是费用总量不管单实例体量;工具循环压缩降级（v0.21.0 两档）管的是单步内 messages 撞模型窗,不管跨步的转录膨胀——本机制补的是**实例级水位线**这一层。

**做什么（三件,全部纯观测加法,零执行语义变更）**：

- **① 实例级峰值输入水位入账**：每次 LLM 调用后,以该次请求的完整输入体量（`usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`——三项合计=模型真实吃进的上下文,单看 input_tokens 会被缓存命中掩住真实体量）更新本实例的**峰值水位** `ctx_watermark`（Dispatcher 实例字段,取历史最大值——转录式任务水位单调升,取 max 对非单调形态也稳健）。
  - 落账两处：hoplog 每步 llm 块加 `ctx_input_total` 字段（当次请求实际值,与既有 input_tokens/cache_* 并排）;实例终态/暂停响应加 `ctx_watermark`（与 cumulative_tokens 并排透出,run_status 可见）。
- **② 软阈值告警**：`resource_limits.max_context_tokens` 有配置时,水位首次越过其 0.75 倍 → 经既有 pendingWarns 通道随当步落一条 warn（形态:"实例上下文水位 <水位>K 已越 max_context_tokens 的 75%（<阈值>K）——长转录延迟将超线性恶化,考虑拆步或收敛材料",0095 曲线为据）;首次越过 1.0 倍 → 再落一条升级措辞的 warn。**每档只告警一次**（水位单调,重复告警是噪声）。不配置 max_context_tokens 则本告警静默（与预检档同一开关哲学——向后兼容,零新配置键）。
- **③ 超时重试耗尽时的水位提示**：callLlmWithRetry 对 `timeout` 类错误重试耗尽（各档退避走完仍败）抛 NETWORK_ERROR 时,若实例水位已越 ②的 75% 线,错误文案追加水位提示（"输入 <N>K 已近上下文告警线,超时与体量相关的概率高——重试大概率同因,考虑拆步"）——逐次重试期间照旧安静退避不出声,网络瞬断（network 类）耗尽也不带提示,只有 timeout×体量双嫌疑时提示。**不做自动截断/自动放弃**（语义决策,不属观测批;0095 卡期望行为③的激进半边另议）。

**边界**：观测点在 callLlmWithRetry 成功/失败两侧（发送口事实边界,^anc-obs-record-at-boundary 同律——记实际请求的 usage,不在意图层估算）;复用模式不经本模块,caller 侧转录观测归 caller 生态（^anc-obs-mode-boundary 同界）;水位不入 state.json 快照（观测态非执行态,resume 后从零重累,峰值账在 hoplog 恒可溯）。
