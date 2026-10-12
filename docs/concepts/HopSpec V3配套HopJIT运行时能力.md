%% @trace
	id: hopjit-runtime
	source: [[HopSpec V3核心规范]], [[HopAnt概念]], [[HopSpec V3扩展-事务与补偿]], [[HopSpec V3扩展-有序思考与渐进固化]]
	source_id: hopspec-v3-core, cyant-concept, hopspec-v3-tx-rollback, hopspec-v3-progressive-solidification
	type: extend
	last_sync: 2026-10-06T17:21+0800
	note: HopJIT 引擎的运行时能力，配套核心规范及所有扩展。2026-07-02 增 ^anc-exec-milestone 里程碑判据（澄清当前 v0/目标 v1，偏差三义分流）；v1/v2/v3 特性清单移设计层 [[../design/roadmap]]
%%

# HopSpec V3 配套 HopJIT 运行时能力

> TODO：本文为框架梳理，待深入设计

HopSpec 定义任务结构和数据流（结构化编排），HopJIT 负责执行（运行时）。本文记录 HopJIT 的完整能力体系。

## 核心执行能力

语义契约详见 [[HopSpec V3核心规范]] 执行模型章节。

### Prompt 组装 ^anc-exec-prompt-assembly

为 `reason`/`check` 步骤按 6 层构建 context：

| 层级 | 来源 | 内容 |
|------|------|------|
| L1. Spec 契约 | Goal + Constraints + Types + Outputs | 不变的契约 |
| L2. 知识上下文 | KnowledgeLayer.retrieve | @knowledge 预检索 + lack_of_info 补充检索（可选） |
| L2d. 文档引用 | doc-ref `[[文档路径#章节名]]` 解析 | 作者钉定的确定性精确引用——读文件切章节注入，区别于 L2 模糊检索（可选） |
| L3. 执行链上下文 | 执行树 | 容器结构 + 已完成步骤产出 + loop 迭代状态 |
| L4. 步骤输入 | `- ←` 变量 | 当前步骤依赖的实际数据 |
| L5. 步骤指令 | 摘要行 + `>` | 任务目标和执行指导 |
| L6. 输出约束 | `+ →` 类型结构 | 期望的输出格式和字段 |

完整定义、示例及知识注入双路径详见 [[HopSpec V3核心规范#^anc-exec-prompt-assembly]]。

### 失败传播与 None 管理 ^anc-exec-none-propagation

- `hop_status: ok | fail`，fail 时自动记录 FailRecord（失败步骤/reason 真因/fail_kind/轮次）
- **fail 不碰值空间**（2026-08-09 定稿）：失败步骤已写下的变量原样保留，引擎不清理不回滚；None 来源只有显式重置（`= Null`）与声明未产出两种，**无"消费 None 自动 fail"闸**——需要容错时用 `branch` 探测 None 走降级
- parallel 标注步骤（派出去的活）fail → 主线与其余在跑的活不受影响；失败的活**不贡献收集元素（列表变短，不填 None）**，FailRecord 随附，由收齐后的消费步骤决定是否可接受部分结果
- 主线步骤 fail → 本容器在跑的活**全部杀死**（killed 终态，不留幻影），容器整体 fail

### 分层重试与自适应 ^anc-exec-retry-adaptive

- `retry`：机械重试，逻辑不变，失败原因记录供诊断
- `retry + adaptive`：LLM 分析失败原因并重规划子步骤，改策略不改目标
- 重试耗尽 → fail → 沿 `call` 链逐层上报，每层 caller 在自己的 retry/adaptive 范围内修复
- HITL 兜底：调用链顶端人类做终极决策
- **上下文超窗降级（独立模式）**：单步材料量逼近或超出模型上下文窗时，引擎两段降级——发送前预检（配置了上下文预算线时，逼近线即把早轮工具返回的原文压缩成任务相关摘要，原件仍在文件里可重新获取）＋撞墙补救（首次超窗压缩后重试一次）。压缩后仍超窗＝该步材料量确定超出模型能力，快速失败并指路（拆步骤逐份处理或换更大窗的模型），**不进机械重试**——同样的请求重发必然同样超窗，重试只烧预算

### 容器编排 ^anc-exec-container-output

- `subtask`：主线顺序执行 children；标注 `parallel` 的 child 异步派发（主线不等它，容器完成前收齐——见核心规范「并发执行模型」）
- `branch/case`：条件分派，无匹配 case 时静默跳过（`+ →` 输出为 `None`）。全局进度中记录分支匹配结果（命中的 case 或无匹配）
- `loop`：循环控制，支持 break/continue

### 执行状态管理

进度、结果、折叠等运行时状态，不属于 HopSpec 规范范围，由 HopJIT 自行管理。

### 执行前合法性校验 ^anc-exec-validation

Spec 在执行前必须通过合法性校验——把"人/agent 写的文本规约"放行为"可执行数据结构"前的质量闸门。校验跑核心规范定义的全部验证规则（见 [[HopSpec V3核心规范#^anc-rule-v3-all]]），按 error/warn 二分：

- **error**——破坏执行语义或结构（步骤 ID 非法、变量引用悬空、类型无效、控制流破损）。**阻断执行**：有 error 的 spec 不予执行
- **warn**——不破坏正确性、仅影响可读性/健壮性（交付物声明未产出、loop 缺显式终止、commit 缺 approval 声明）。**不阻断**，但必须**透传给调用方**——警告被吞掉等于不存在

校验是**独立可调用**的：既可作为执行前的单独检查（不创建实例、只返回 error+warn 全集），也内嵌在初始化流程中（error 阻断初始化、warn 随初始化结果透传）。具体命令/接口见 [[../design/hop-cli]]。

## 双模式驱动 ^anc-exec-dual-mode

HopSpec 的执行需要两种资源：**推理智能**（reason/check 步骤的 LLM）和**执行能力**（act 步骤的工具）。这两种资源从哪来，定义了 HopJIT 的两种驱动模式：

| | 复用模式（reuse） | 独立模式（standalone） |
|---|---------|---------|
| **推理智能** | Caller 自身（CC / 上层 agent 就是 LLM） | 引擎内部调 LLM API |
| **执行能力** | Caller 的工具集 | ToolProvider |
| **HopJIT 的角色** | 纯流控器（状态机 + 变量 + 控制流） | 完整执行器 |
| **交互形态** | 命令式——caller 反复问"下一步是什么" | 委托式——caller 给任务等结果 |
| **状态生命周期** | 每命令独立进程，状态外置存活（文件） | 引擎活在整个执行期，状态在内存 |
| **典型场景** | `/hopspec run`（CC 是大脑，零额外 LLM 费用） | HopAnt `run_spec`（无人值守，可路由低成本模型） |

两种模式不是互斥的部署选项，而是**同一个引擎核心的两种驱动方式**。 ^anc-exec-dual-mode-principle

### 引擎与 driver 的角色 ^anc-exec-engine-driver-roles

复用模式有两个角色，职责严格分立：

- **引擎（HopJIT）**：确定性状态机，**不推理**。持有执行状态、变量作用域、流控（subtask/loop/branch/retry-adaptive/失败升级），决定"下一步是什么"与**整个执行节奏**。它够不到推理；工具面按执行主体原则分派（2026-09-05）——body 内的工具调用引擎自有 provider 命中即直执，只有 caller 会话专属工具（MCP/宿主能力）够不到、经 `tool_request` 交 caller。
- **driver（caller）**：有推理力 + 能执行工具的 agent（CC / Codex / 任意满足"能推理+能跑工具"的 runtime）。引擎让它推理就推理（reason/check）、让它执行就执行（含工具 act）、让它问人就问人（confirm）。
- **关系**：引擎是"确定的流程控制大脑"，driver 是"善变但强的手"。**HopSpec 让确定的引擎指挥善变的 driver，而非反过来**——这是"控制流不归 LLM"在复用模式的落地。传统 agent 的失控源于流程在 LLM 脑子里（善变、跑偏、忘步骤）；HopSpec 把流程固化为 spec + 引擎状态机，driver 降级为受指挥的执行器。

### 模式无关原则 ^anc-exec-mode-invariants

引擎核心（状态机、变量作用域、retry/adaptive、失败升级、prompt 组装）与驱动方式无关。两种模式必须保证以下原则：

1. **确定性流控**：同一 spec + 同一输入序列 → 同一状态轨迹
2. **HopLog 记录一致，记录分界=执行能力归属**：HopLog 在两种模式下记录同样的**引擎侧事件**（步骤状态流转、变量输入输出、暂停决策），流控轨迹可还原。执行内幕（LLM 交互、工具调用明细）由执行者记录：独立模式执行在引擎侧，HopLog 全量记录；复用模式执行在 caller 侧，由 caller 生态的观测工具记录（如 ccglass 记录 CC 会话），两份记录通过 instance_id 关联
3. **CITL 暂停点一致**：confirm 在两种模式都产生 `paused` 状态——引擎 `next` 遇 confirm 一律返回 `status: paused`（含 presented_data + response_options），不降级为普通 step_ready。差别仅在决策注入通道：复用模式 caller 用 CLI 注入（每命令独立进程，注入即落盘），独立模式在暂停点回调 caller。commit 不在此列——授权由前序 confirm 建立，commit 直接执行（见 [[HopSpec V3核心规范#^anc-step-commit]]）
4. **沙箱语义一致，强制力分级**：SandboxConfig 的边界定义相同（两个路径域 work_zone / workspace 的写权限,与 store 数据面的两 schema 写权限,见 [[HopSpec V3核心规范#^anc-exec-store]]）。独立模式由 ToolProvider **强制**拦截；复用模式下 caller 持有自己的工具，沙箱是**契约**——caller（如 CC）读取 SandboxConfig 自律遵守，HopJIT 无法技术强制。选择复用模式即信任 caller
5. **暂停必有恢复闭环**：每个 CITL 暂停点必须存在恢复路径——caller 任何时候注入决策，执行都能从暂停点继续。paused 是合法的稳定状态，可以无限期等待；引擎**绝不替 caller 做决策**——不可逆操作的授权只能来自 caller，没有"超时默认批准"。暂停任务的终结由**系统级垃圾回收**承担：超期未完成的执行实例被 GC 清理（终态 cancelled）——GC 回收资源，不做业务决策
6. **执行节奏归引擎**：driver 是哑应答体——它**只**在引擎指定的 **caller 介入点**（reason/check 需推理、confirm 需决策、act/commit 的**引擎够不着的单个工具调用**需 caller 工具）应答，干完即交回。**act/commit 的 hop_python body 一律由引擎解释执行**（复用模式亦然）——引擎逐行推进，工具调用按执行主体原则分派（2026-09-05：引擎自有 provider 命中即直执入账；文件工具等不再外发），撞到 provider 外的工具（caller 会话专属：MCP/宿主能力）才暂停发 `tool_request`（工具名+已求值参数），caller 只执行**这一个工具**并交回结果，body 的编排逻辑、中间变量、输出组装全在引擎手里。为什么：把整个 body 文本交给 LLM"忠实执行"，工具实现半径必然膨胀（2026-08-04 实证：`count_outliers(z_threshold:3)` 被顺带实现整套 IQR 通道——编排忠实但语义膨胀，产出 shape 随执行 LLM 漂移）；caller 连 body 都看不见，膨胀就没有落点——"无推理、确定性"从纪律约束升为**结构保证**。跨进程恢复用**确定性重放**：state 记录本步已完成的工具结果序列（tool_journal），新进程从头重放 body、撞第 N 个工具调用查 journal——有则代入继续，无则发 tool_request；body 除工具调用外纯确定性，重放零副作用、天然崩溃安全。**何时推进、哪些中间步由引擎自己消化（纯计算 body、容器进入/推进、分支选择等纯状态机转移）、推进到哪个介入点停，全由引擎决定，driver 无节奏选择权**。这是原则 1（确定性流控）在 driver 交互层的延伸——若 driver 能自由选择推进时机/粒度，控制流就部分回到了善变的 LLM 手里，违背"控制流不归 LLM"。落地：driver 交活与领取下一指令是**一次原子往返**（见 [[#^anc-exec-advance-to-caller]]），引擎在这个往返里把节奏定死

**推论**：引擎核心不依赖任何驱动方式特有的资源——不假设有文件系统（复用模式跨进程需要、独立模式不需要），不假设有 LLM SDK，不假设有工具执行能力。状态存哪、谁调 LLM、谁执行工具，都是驱动层的决策。

## 执行实例状态 ^anc-exec-instance-states

HopSpec 有两个层次的状态，过去只定义了步骤级，实例级一直隐含未明，现补齐：

- **步骤级 `hop_status`**：`ok | fail`，单个步骤的执行结果。权威定义见 [[HopSpec V3错误模型]]。fail 触发升级链（就近事务边界重试阶梯，未捕获则实例终止）。
- **实例级状态**：整个执行实例（一次 run）的生命周期状态，与步骤级正交：

| 实例状态 | 含义 | 可续 | 与步骤级的关系 |
|---------|------|------|--------------|
| **running** | 正在推进 | — | 有步骤处于 running |
| **paused** | CITL 暂停，等待有权决策者注入决策 | ✅ 合法稳定态，可无限期等 | confirm 暂停，步骤保持 running |
| **completed** | 所有步骤终态且无未兜底失败 | — | 所有步骤 done/skipped |
| **failed** | 失败耗尽 retry/adaptive，逐层上报至顶层仍未修复 | ✅ 保留状态供诊断 | 某步骤 fail 传播到顶 |
| **cancelled** | 主动取消 / GC 超期擦除 | ❌ 状态已作废 | 与步骤级无关，是资源回收 |

**failed ≠ cancelled**：failed 是执行结果（做不到），保留完整状态供 caller 诊断、上报、人工介入；cancelled 是资源回收（不做了），状态作废。二者都是终态，但 failed 可被 caller 在更广上下文里接续修复，cancelled 不可续。

**paused 不是 fail**：confirm 暂停是"等决策"的合法稳定态，不是失败——它不触发升级链，不消耗 retry。这是与传统框架"超时即失败"的本质区别（原则 5：引擎绝不替 caller 决策）。

## 断点续执行 ^anc-exec-durable-resume

**核心命题：任何中断点都可持久化，任意时刻可从中断点恢复续执行。** 这是 HopJIT 面向 Caller 的产品能力——任务可以中断、搁置、隔天接着跑，而非一次性必须跑完。它是上文原则 5「暂停必有恢复闭环」的持久化底座：恢复闭环保证"暂停态可恢复"，断点续执行保证"恢复跨得过进程边界与时间间隔"。

中断点有两类来源，对应两种**语义不同**的恢复路径——关键差异在于如何对待 `running` 步骤：

| 中断来源 | 触发 | 恢复路径 | 对 running 的处理 |
|---------|------|---------|-----------------|
| **正常中断**（加载续执行） | 进程正常结束（复用模式每命令独立进程）、CITL 暂停、主动搁置 | **load** | **保留**——running 是"已交付 caller、正等回写/决策"的合法持久态，不是悬空 |
| **崩溃中断**（崩溃恢复） | 进程异常崩溃，步骤执行到一半 | **recover** | **重置 pending 幂等重跑**——崩溃时的 running 是悬空的，无回写记录 |

**load 与 recover 必须分离**：复用模式下 `running` 是跨进程的合法稳定态——`next` 把步骤设 running 并落盘、交付给 caller，下一进程的 `done` 回写结果。这与 `paused`（见 [[#^anc-exec-instance-states]]）同理：都是"已交付、等 caller 动作"的稳定态。若加载时一律按崩溃恢复重置 running，正常的 next→done 跨进程流会被打断（done 读到 pending）。因此：日常推进与查询（next/done/status/vars 等）走 **load**（保留 running）；只有显式的崩溃恢复入口走 **recover**（重置悬空 running）。引擎无法仅凭 running 状态本身区分"已交付"与"崩溃悬空"——故由**调用入口**显式选择 load 还是 recover，而非引擎自行判断。

**可续的边界**：可续是常态——只要实例状态被持久化，任意时刻都能恢复。唯一例外是**终态 cancelled**：主动取消、或 GC 超期擦除（原则 5）的实例，状态已作废，**不可续**。cancelled 与 failed 不同——failed 是执行失败仍保留状态供诊断/上报，cancelled 是资源回收、任务作废。

**实例状态包含可变的 AST 快照**：一个执行实例的持久化状态不只是"执行到哪"（步骤状态/变量），还包括**当前执行的 AST 本身**。常态下 AST 在 init 后不变；但 **adaptive replan 会改 AST**（替换 subtask 的 children）——此时实例的 AST 快照必须随之更新持久化，否则跨进程恢复后 AST 不反映 replan（执行逻辑回退）。**这要求区分两个"spec"**：
- **spec 源文件**（作者写的程序，SSR DocTree 权威）：不可变，只离线经审迭代（渐进固化把经验回填到这里）
- **运行时 AST 快照**（实例持久化里的 spec，`.hopstate/<inst>/spec.json`）：**可变**，反映当前执行逻辑，随 replan 演化——它是"这次执行的程序当前态"，本就该跟着执行走，与 spec 源不可变不矛盾

**与双模式的关系**：
- **复用模式**天然跨进程——状态本就外置存活（文件），断点续执行是其固有属性
- **独立模式**默认状态在内存、进程内活完整生命周期；但要支持"暂停后跨进程隔天恢复"，需把暂停态持久化。这是断点续执行对独立模式的增量要求

**暂停的介入请求跨进程可得（问题卡,2026-08-25 作者定——hopissues/hoplogic3/0028）**：CITL 暂停的介入请求（问什么、给人看的材料全文、可选项）是"可续"语义的一部分——**凡 HITL 请求离开发起进程（detach 长跑/定时批,人不在进程里）,它必须是一张自足的问题卡**：任何进程任何时刻可取全文,人读到即可拍板不追问背景。载荷只活在发起进程内存（进程一退即灭）不满足本契约——那等于"暂停可恢复"只对守在进程边上的人成立。落地形态（暂停即随实例状态落卡、答案消化即销卡）归设计层。

**职责边界**：本能力定义"可续"这一语义契约（什么可续、恢复后什么行为）。具体机制——暂停态存哪（独立快照文件 vs 折进引擎状态快照）、恢复时谁重建引擎——属设计层决策，见 [[../design/exec-engine]] 与 [[../design/step-dispatcher]]。

## 有序思考与渐进固化

核心规范定义了 Spec 的两种形态：有 Steps（具体实现）和无 Steps（HopTrait，Hop契约）。当 HopJIT 收到 HopTrait 时，启动有序思考能力：从零生成执行路径，试跑验证，成功经验渐进固化。adaptive 重规划是同一能力的受限版本——作用域限定在 subtask 的 children 内，额外输入为失败原因和原步骤结构。

这是 HopSpec"锁定目标，放开路径"理念的极致体现：Spec 作者只提供 WHAT，HopJIT 负责 HOW。

详见 [[HopSpec V3扩展-有序思考与渐进固化]]。

### 探索验证闭环

```
评估复杂度与置信度
       ↓ 置信度不足
搜索（外部信源 / 知识库 / Spec 库，按约定）
       ↓
有序思考（生成 Steps）
       ↓
在验证环境中试跑
       ↓
验证
       ↓ fail → 带失败上下文重新思考
       ↓ pass
交付结果 + 候选 spec 入库
```

生成的 Steps 禁止包含 `commit`（沙盒试跑，无不可逆副作用）。

### 渐进固化

1. **动态 → 候选**：首次成功后自动存入 Spec 库
2. **候选 → 验证**：多次执行、不同输入验证，鲁棒性确认
3. **验证 → 沉淀**：人工审查后成为可复用最佳实践
4. **沉淀 → 降级**：连续失败超过阈值时降级为候选，重新进入验证流程

已沉淀的 Spec 可被后续有序思考查询复用，也可通过 `call` 直接调用。

## 基础设施

以上能力依赖三项基础设施。安全模型的语义（什么是安全的、什么需要审批）属于概念层定义，具体实现（用哪个容器、连哪个知识库）属于部署配置。

### 执行沙箱

沙箱模型定义见本文 [[#^anc-config-sandbox-model]]（四种资源类型：filesystem / network / runtime / database）。

HopJIT 在运行时负责强制沙箱边界：
- **StepDispatcher**：act 步骤调用 `requires_commit=true` 的工具时自动拦截，返回 COMMIT_REQUIRED 错误
- **execute 内部检查**：写操作校验路径在 workspace_dir 内，读操作校验 read_access 权限，网络请求校验 trusted_hosts
- **路径安全**：所有路径参数经 `realpath()` 解析，路径穿越和 symlink 逃逸被拒绝

### 变量传递与受众分流 ^anc-exec-audience-routing

引擎对外传递变量值（NextResponse 五形态）时面对三类受众，限制根源不同、最优策略不同，必须分流处理而非一刀切阈值。

| 受众 | 通道 | 限制根源 | 策略 | 阈值 |
|---|---|---|---|---|
| **人**（user，UI 显示） | `paused.presented_data.context`（confirm/ask） | 阅读疲劳；渐进披露 UX | 内联可读片段 + 超阈给"完整内容见文件"链接 | 5K 字符（`HUMAN_PREVIEW_THRESHOLD`） |
| **agent**（LLM driver） | `step_ready.context.inputs` / `parallel_ready.children[].params_for_child` | context window 总额；信号噪声比；"lost in the middle" | 小值原样内联；大值卸到 `work_zone/vars/<name>.json` 走 `$file` 指针，agent 按需 Read | 4K 字节（`DEFLATE_THRESHOLD`，单值阈） |
| **hopjit 引擎**（CLI 参数） | `--output @file` / `--params @file` 等 | bash `ARG_MAX`（macOS 256K / Linux 2M / POSIX 兜底 4K / Linux 单参 128K 硬上限） | `@file` 协议（已实装） | 无内联截断，文件即真值 |

**设计原则**：
1. **受众识别由出口类型决定**：paused → 人；step_ready/parallel_ready → agent；CLI 参数 → hopjit。同一变量流向不同出口走不同通道，引擎在构造各 NextResponse 形态时各自走该出口的格式化策略。
2. **整体流控 vs 单值截断**：agent 通道是"单值阈"，限的是"单变量内联到 prompt 的字节数"；prompt 总额预算（`BudgetConfig.total`）是另一维度的整体流控（L1-L6 分层），两者正交。
3. **超阈卸载到 work_zone**：人和 agent 超阈值时都不丢数据，而是写 `<inst>/work_zone/vars/<name>.json`（见 [[../design/exec-engine#^anc-exec-work-zone]]）并返回 `$file` 指针；人通道再附 5K preview 让 user 可即时阅读，agent 通道纯指针由 agent 决定何时 Read。
4. **历史教训（V1 偏差）**：早期 PromptAssembler 对 step inputs 一刀截断到 2000 字符加 `[TRUNCATED]` 标记，违反受众分流——人看到截断版无法决策（ppt-html step 4 暴露），agent 看到含损值无法基于真值推理。换成"按阈值卸载到 $file"是受众一致化的修法。

行业最佳实践印证（Anthropic context engineering、Codex CLI compaction、Lost-in-the-middle 等 2026 资料）：context 是有限资源、token 累积 O(N²)、层级化分级、大值外部存储卸载——本设计已对齐。

> **次级优化**（待 TODO）：agent 内部还可按 driver 类型差异化（主 driver `canFanout=true` context window 已用一阵，紧；worker subagent `canFanout=false` 是 fresh context，余量大，单值阈可放宽到 20K）。本节阈值为 v1 一刀切，子化留待实测压力下做。

### 验证环境

为有序思考生成的动态 Steps 提供安全试跑环境——复用执行沙箱模型，额外约束：

- 生成的 Steps 禁止包含 `commit`（沙盒试跑，无不可逆副作用）
- 资源限制：CPU、内存、时间的合理约束，防止探索失控
- 状态清理：每次重试前清理上一轮的临时状态

### 知识库

为有序思考和 adaptive 重规划提供领域知识支撑：

- 查询接口：按任务目标和约束检索相关知识
- 知识范围：领域文档、历史经验、最佳实践

### Spec 库

已沉淀的 HopSpec 的存储和检索：

- 查询：检索已有 Spec，作为规划参考或直接复用
- 存入：有序思考成功后，自动存为候选
- 固化流转：动态 → 候选 → 验证 → 沉淀 → 降级 的状态管理
- 版本管理：同一任务的 Spec 随经验迭代演进

## 四维度能力模型（概念探索阶段） ^anc-exec-capability-model

> 本节 2026-10-06 自 [[HopAnt概念]] 迁入（作者定甲案：HopAnt 文档只讲实体与生命周期,引擎给 spec 供能力的内部模型归本文）。锚点随节原名迁移,追溯链不断。本节描述的是**引擎侧**的能力供给结构,仍在概念探索阶段;与之对应的设计层是 [[../design/shared-providers]]（Provider 三件套）;实装现状（2026-10-04 清查）：Capability 对应 ToolProvider 已有,Knowledge 只有接口,Data 与 Identity 零实装。

### 四维度能力模型 ^anc-struct-cyant

HopSpec 定义逻辑（做什么、怎么做）,引擎在四个维度上给 Spec 供能力与记忆（用什么做、状态存在哪）。一个 HopAnt 实体的 spec 跑起来时,就是运行在这四维度之上：
- **提供能力**：工具集、API、知识库、推理能力——Spec 中的 `act`/`call` 实际调用的是 HopAnt 提供的能力
- **记录状态**：跨 Spec 执行的持久状态（记忆、配置、累积数据），实例各自持有

**Spec 不感知供能力的是谁**：Spec 照常写 Goal/Inputs/Outputs/Steps,四维度的具体绑定由部署配置给（HopAnt 实体里是入口 spec 头 + 本机适配记录,见 [[HopAnt概念#^anc-struct-hopant-layout]]）,不是语法的事。

四个维度各答一问：去哪找知识？能用什么工具？数据存在哪？以谁的身份执行？关注点分离,各自一个 HopType。

> **Knowledge vs Data 判定原则**：只要是**知识**（术语、术语关系、Spec 逻辑、文档语义），走 KnowledgeLayer；不是知识的**结构化信息**（数据库表、API 返回、配置状态），走 DataLayer。四个维度不是严格正交（Knowledge 和 Data 在数据源层面可能重叠），而是关注点分离——检索语义 vs 查询结构。v1 聚焦三类知识：术语、术语关系、Spec 逻辑。

#### 四维度的组合与两个顶层契约

```
HopType: HopAnt
  Id: cyant
  Fields:
    - knowledge % KnowledgeLayer    # 知识检索能力
    - capability % CapabilityLayer  # 工具与执行环境
    - data % DataLayer              # 数据访问
    - identity % IdentityLayer      # 身份与权限
  Specs:
    - run_spec    # 通过 ExecutionEngine 执行 HopSpec
    - introspect  # 返回自身能力摘要（可用工具/知识域/权限范围）
```

四个维度各是一个 HopType;顶层两个契约（run_spec / introspect）是 HopTrait,下面用 HopSpec 结构写（它们是运行层契约,不是设计记法）：

```
# Spec: 执行 HopSpec
Id: run_spec
Goal: 在当前实例的能力和权限上下文中执行指定 Spec，支持 HITL 挂起/恢复

Inputs:
- spec_id % line            # 要执行的 Spec 标识
- inputs % yaml             # Spec 的输入参数
- execution_id % line       # 恢复执行时传入（首次执行为空）
- options % yaml            # 执行选项（超时/重试/日志级别，可选）

Outputs:
- execution_id % line       # 本次执行标识（用于恢复）
- status % enum(completed, waiting_human, failed, timeout)
- result % yaml             # completed 时：Spec 执行结果（Outputs 的值）
- checkpoint % yaml         # waiting_human 时：当前步骤、等待的 check 内容、已有上下文
- trace % yaml              # 执行轨迹摘要（步骤序列/耗时/工具调用记录）

Constraints:
- Spec 必须已注册或可解析
- 执行受当前 IdentityLayer 的权限约束
- 执行环境受 CapabilityLayer.sandbox 约束（沙箱由宿主环境注入，见下）
- 超时由 options 或 CapabilityLayer.resource_limits 决定
- waiting_human 时执行状态必须可序列化持久化，凭 execution_id 可恢复
- completed / failed / timeout 为终态，不可恢复
```

```
# Spec: 自省能力
Id: introspect
Goal: 返回当前实例的能力摘要,供其他实例发现和选择协作对象

Inputs:
- scope % enum(all, knowledge, capability, data, identity)  # 查询范围（默认 all）

Outputs:
- specs % [line]            # 可执行的 Spec 列表
- tools % [line]            # 可用工具列表
- knowledge_domains % [line] # 知识域标识列表
- permissions % yaml        # 权限摘要

Constraints:
- 只返回当前身份有权查看的信息
- 不泄露内部实现细节（如 API key、内部路径）
```

| 维度 | 职责 | 核心问题 |
|------|------|---------|
| **KnowledgeLayer** | 知识检索与积累 | 步骤执行时去哪里找上下文知识？ |
| **CapabilityLayer** | 工具与执行环境 | 能用什么工具、在什么沙箱内？ |
| **DataLayer** | 数据访问与持久化 | 结构化数据从哪来、往哪存？ |
| **IdentityLayer** | 身份与权限 | 谁在执行、以谁的身份调 API、边界在哪？ |

#### 与执行引擎五组件的关系

四维度是能力供给面,执行引擎是消费它们的机器：

```
四维度能力模型
  ├─ KnowledgeLayer   ← PromptAssembler 从这里动态检索知识
  ├─ CapabilityLayer  ← StepDispatcher 从这里获取工具和沙箱
  ├─ DataLayer        ← ExecutionEngine 从这里读写数据
  ├─ IdentityLayer    ← 所有 API 调用以这里的身份进行
  │
  └─ .run_spec()      → ExecutionEngine + StepDispatcher + PromptAssembler
                        （执行基础设施是 HopAnt 调用 Engine 的内部实现）
```

HopJIT 执行引擎由 5 个组件构成,是 `run_spec` 的内部实现：

- **SpecParser**：将 HopSpec 文本解析为 AST，校验验证规则 ^anc-struct-spec-parser
- **ExecutionEngine**：执行状态机——管理步骤状态、变量命名空间、retry/adaptive、失败升级（函数级 fail） ^anc-struct-exec-engine
- **PromptAssembler**：为 reason/check 步骤组装 6 层 prompt context（L1 Spec 契约 → L6 输出约束） ^anc-struct-prompt-assembler
- **StepDispatcher**：步骤分派——按类型路由执行（reason→调 LLM、act→调工具、confirm→暂停等待） ^anc-struct-step-dispatcher
- **HopCLI**：Agent 与执行引擎的交互接口（init / next / done / fail / status） ^anc-struct-hop-cli


#### 四维度逐个定义

##### KnowledgeLayer（知识） ^anc-layer-knowledge

**HopTrait（Hop契约）**：

```
# Spec: 检索相关知识
Id: retrieve
Goal: 根据查询从已注册知识源中检索相关片段

Types:
  KnowledgeFragment:
    - source_id % line              # 来自哪个知识源
    - content % text                # 片段内容
    - relevance % enum(high, medium, low)  # 相关度

Inputs:
- query % text              # 检索查询
- max_results % int      # 最大返回条数（默认 10）

Outputs:
- fragments % [KnowledgeFragment]   # 检索结果列表

Constraints:
- 按相关度降序排列
- 去重（同一来源同一段落不重复）
```

**HopType**（2026-08 分离形态存量,成员另起 `# Spec:` 块;现行聚合写法见 [[HopType体系#^anc-hoptype-block]]）：

```
HopType: KnowledgeLayer
  Id: knowledge-layer
  Types:
    KnowledgeSource:
      - id % line                     # 知识源标识
      - type % enum(file_glob, grep, rag)  # v1 三种知识源类型
      - config % yaml                 # 类型相关配置（路径/endpoint/索引名）
  Fields:
    - sources % [KnowledgeSource]   # 已注册的知识源
  Specs:
    - retrieve     # impl trait
```

v1 最小集：一个 `retrieve` trait 就够。知识源的类型和检索策略由 KnowledgeSource 自身决定——注册时声明，retrieve 时路由。

**HopJIT 映射**：PromptAssembler 的 L2 知识上下文层由 KnowledgeLayer 驱动，双路径注入：主动路径（Spec `@knowledge` 声明预检索）和被动路径（`lack_of_info` 触发补充检索，标注来源步骤）。详见 [[HopSpec V3核心规范#^anc-exec-prompt-assembly]]。

##### CapabilityLayer（能力） ^anc-layer-capability

**HopTrait（Hop契约）**：

```
# Spec: 执行工具调用
Id: execute_tool
Goal: 在沙箱约束内执行指定工具

Inputs:
- tool_name % line          # 工具名称
- tool_args % yaml          # 工具参数

Outputs:
- result % text             # 执行结果
- success % bool            # 是否成功

Constraints:
- 工具必须在已注册列表中
- 执行受沙箱策略约束（路径/命令/网络）
- 超过 resource_limits 时拒绝执行
```

**HopType**（2026-08 分离形态存量,成员另起 `# Spec:` 块;现行聚合写法见 [[HopType体系#^anc-hoptype-block]]）：

```
HopType: CapabilityLayer
  Id: capability-layer
  Fields:
    - tools % [ToolDef]             # 可用工具注册表（待细化）
    - sandbox % SandboxConfig       # 沙箱配置（由宿主环境注入，见下）
    - api_clients % [ApiClient]     # LLM 和外部 API 客户端（待细化）
    - resource_limits % yaml        # 资源限制（token 预算/工具调用上限/超时）
  Specs:
    - execute_tool    # impl trait
    - list_tools      # 返回当前可用工具及其 schema
    - register_tool   # 动态注册新工具
```

**HopJIT 映射**：替代 StepDispatcher 硬编码的 Bash/Read/Write 工具——act 步骤通过 `CapabilityLayer.execute_tool()` 调用注册的工具，工具副作用级别由 `requires_commit` 声明，执行范围由沙箱配置约束。

**沙箱与宿主环境**：sandbox 由宿主环境（如 Claude Code）在实例化时注入，定义 act 步骤能安全触及的资源边界。沙箱覆盖四种资源类型： ^anc-config-sandbox-model

**① 受控文件目录（filesystem）**： ^anc-config-sandbox-filesystem
- workspace_dir：宿主分配的工作区子目录，act 步骤可自由写、删、试验
- read_access：三级读取控制——allowed（可自由读）、denied（禁止，如密钥文件）、confirm_required（需 confirm 后读取）
- workspace 外的写/删/移动 = commit 级别

**② 网络访问（network）**： ^anc-config-sandbox-network
- web search / fetch 按域名可信分级，宿主配置可信域名白名单
- 可信域名内的只读查询（search/fetch）= act 级别
- 不可信域名或有副作用的网络操作（POST/PUT/发邮件）= commit 级别

**③ 已安装库与工具（runtime）**： ^anc-config-sandbox-runtime
- 声明当前环境可用的运行时能力：uv python / TypeScript / PDF 解析 / OCR 等
- act 步骤可调用已声明的库执行本地计算（在 workspace 内）
- 安装新库、修改系统依赖 = commit 级别

**④ 数据库（database）**： ^anc-config-sandbox-database
- 临时库（temp_databases）：act 步骤可自由读写——临时库可重建，重做安全
- 只读库（readonly_databases）：act 步骤可查询，写入需 commit
- 未声明的数据库：全部禁止访问
- schema 变更（CREATE/DROP/ALTER）：始终需要 commit
- 典型场景：agent 在临时库做数据清洗（act），验证通过后写入生产库（commit）

**工具副作用声明**：每个工具注册时声明 `requires_commit`——标记该工具是否有不可逆副作用。act 步骤中 `requires_commit=true` 的工具调用被 StepDispatcher 自动拦截。Spec 作者可选择在 commit 前放置 confirm 步骤来保护不可逆操作。 ^anc-exec-requires-commit

安全模型的核心原则：**act 步骤内一切操作可安全重做**（workspace 内自由试验 + 只读外部访问 + 本地计算），commit 步骤的安全性由 Spec 流程保障（作者显式设计 confirm 保护），而非运行时自动审批。 ^anc-exec-sandbox-principle

##### DataLayer（数据） ^anc-layer-data

**HopTrait（Hop契约）**：

```
# Spec: 查询数据
Id: query_data
Goal: 从已注册数据源执行结构化查询

Inputs:
- source_id % line          # 目标数据源
- query % text              # 查询表达式（SQL / 文件路径 / API 请求）

Outputs:
- rows % yaml               # 查询结果
- row_count % int        # 结果行数

Constraints:
- 只读操作，不修改数据源
- 查询超时由 DataSource 配置决定
```

**HopType**（2026-08 分离形态存量,成员另起 `# Spec:` 块;现行聚合写法见 [[HopType体系#^anc-hoptype-block]]）：

```
HopType: DataLayer
  Id: data-layer
  Fields:
    - connections % [DataSource]    # 数据源注册（待细化）
    - schema_cache % yaml           # 已知数据结构缓存（待细化）
    - state_dir % line              # .hopstate/ 路径
  Specs:
    - query_data   # impl trait
    - persist      # 持久化执行产物（超越 vars.json 的 KV）
    - discover     # 发现数据源 schema
```

**HopJIT 映射**：替代 vars.json 的扁平 KV——步骤可查询数据库、读写结构化文件、与外部数据服务交互。

##### IdentityLayer（身份） ^anc-layer-identity

**HopTrait（Hop契约）**：

```
# Spec: 获取服务凭证
Id: get_credential
Goal: 按服务标识获取身份凭证（API key、ak/sk、token 等）

Inputs:
- service_id % line         # 目标服务标识（'tavily' / 'openai' / 'anthropic' 等）

Outputs:
- credential % yaml         # 凭证信息（type + values）

Constraints:
- 凭证不可日志明文输出
- 未注册服务返回 null，调用方决定是否 fail
```

**HopType**（2026-08 分离形态存量,成员另起 `# Spec:` 块;现行聚合写法见 [[HopType体系#^anc-hoptype-block]]）：

```
HopType: IdentityLayer
  Id: identity-layer
  Fields:
    - credentials % yaml            # 服务凭证注册表（service_id → Credential）
    - llm % ModelEngine             # LLM 绑定配置 ^anc-config-model-engine
  Specs:
    - get_credential  # impl trait：按 service_id 查找凭证
    - list_services  # 列出已注册的可用服务
    - authenticate   # 验证身份（API key 有效性/用户 session）（v2+）
    - audit_log      # 记录操作审计日志（谁/何时/做了什么/以谁的身份）（v2+）
```

**ModelEngine 细化**：

```
- ModelEngine:  # LLM 多模型绑定配置
  - default_service % line  # 默认 LLM 服务标识（如 'anthropic'）
  - default_model % line  # 默认模型（如 'claude-sonnet-4-6'）
  - routing_rules % [ModelRoute]  # 按步骤类型/标注路由到不同模型

- ModelRoute:  # 模型路由规则
  - match % line  # 匹配条件：step_type 值（reason/check/act）
  - service % line  # 目标服务标识
  - model % line  # 目标模型名
```

**路由优先级**（从高到低）： ^anc-exec-model-routing

1. 步骤级 `@model` 标注——步骤 `>` 指令区声明 `@model service/model`，最高优先级
2. Spec 级 `Config.model`——整个 Spec 的默认模型
3. `ModelEngine.routing_rules`——按 step_type 匹配的全局规则（如 reason→DeepSeek, check→Claude）
4. `ModelEngine.default_model`——兜底默认

典型场景：reason 步骤用 DeepSeek V4 Pro 做主推理（成本低、速度快），check 步骤用 Claude 做独立核验（交叉验证，避免模型自我一致性偏差）。

**HopJIT 映射**：替代 config.json 的单 api_key 硬编码——步骤调用外部服务（搜索 API、外部 LLM 等）时通过 `get_credential(service_id)` 获取凭证。工具的副作用级别由 ToolDef.requires_commit 声明，act 步骤中自动拦截不可逆工具，IdentityLayer 专注凭证管理。ModelEngine 管理 LLM 调用的模型选择和路由。

**凭证传递**：HopJIT 以 CLI 子进程方式被宿主启动，通过继承环境变量获取凭证——`ANTHROPIC_AUTH_TOKEN`（CC 本地代理） 或 `ANTHROPIC_API_KEY`（直连），加 `ANTHROPIC_BASE_URL`（代理网关）和 `ANTHROPIC_MODEL`（当前模型）。多服务路由时按 `{SERVICE_ID}_API_KEY` + `{SERVICE_ID}_BASE_URL` 模式扩展。YAML 配置文件（`~/.hopjit/config.yaml`）作为 fallback 和路由规则存储。

## 里程碑分期与偏差判据 ^anc-exec-milestone

上文列的是 HopJIT 能力体系的**目标全集**。工程落地分阶段推进——**里程碑**（v1 / v2 / v3）标记"哪一阶段做到哪"。本锚点定义**里程碑是什么、当前处在哪、偏差怎么归类**（判据）；各里程碑的**具体特性清单**在设计层路线图 [[../design/roadmap]]（避免概念层堆实现细节，路线图随实现演进）。里程碑是 HopJIT 产品的能力分期，非通用方法论，故定义在本运行时能力文档（与 `^anc-exec-dual-mode` 等能力锚点同处），而非工程实现链规范。

### 里程碑 = 产品能力分期，与模块 semver 正交【契约】

项目里"v-版本"有两个**完全独立、却都叫 v** 的概念，混用是"v1 偏差"混乱的根源，必须显式分开：

| 维度 | 语义化模块版本 | 里程碑分期 |
|---|---|---|
| **形态** | `v0.1.0`（semver 数字） | `v1` / `v2` / `v3`（阶段名） |
| **轴** | 单模块对外接口稳不稳定 | 整个引擎的功能能力边界 |
| **粒度** | 模块 | 产品 |
| **定义处** | `[[工程实现链规范#^anc-meta-module-evolution]]` | 本锚点 `^anc-exec-milestone` + 清单 [[../design/roadmap]] |

**两线正交、不互相换算**：模块 semver 由"该模块接口兼容性变化"驱动（见 `^anc-meta-module-evolution`）；里程碑由"产品做到哪个能力阶段"驱动。二者共用"v"字面纯属巧合——`hop-cli v0.1.0` 讲的是 CLI 契约稳定性，`里程碑 v1` 讲的是产品能力阶段，**不得用"v"字面互指**（如"v1 ≈ 所有模块 0.x"是伪耦合：模块接口稳定不等于引擎到了 v1 能力，引擎迈 v2 也不必然要求模块破坏性变更）。

### 当前处在 v0（开发中），目标 v1【契约】

**关键澄清**：里程碑序号从 **v1 起标"第一个可发布的能力完整里程碑"**——不是"当前状态"。当前 semver 是 `v0.x`（未发布、接口未承诺稳定），对应里程碑上的 **v0 = 朝 v1 推进的开发中状态**。

- **v0（当前）**：semver `0.x`。复用模式已端到端跑通，能力仍在补完。**"v1 偏差"= 距 v1 目标尚差的已登记债**（不是"v1 里故意砍的"——早期措辞误导，本质是欠 v1 的债）。
- **v1（第一个可发布里程碑）**：复用模式做扎实到**能力完整可对外用 + 接口稳定到敢升 `1.0.0`**。达成 v1 ⇔ semver 从 0.x 升 1.0.0。
- **v2 / v3**：v1 之后的能力扩张（v2 能力上台阶、v3 生态层）。各档特性见 [[../design/roadmap]]。

> `v2+` 等模糊筐不再使用——特性归属以 roadmap 清单为准。所有 "V3" 若指产品是 HopSpec V3（与里程碑无关），指里程碑才是本文的 v3。

### 偏差三义分流判据【契约】

同一个"v1 偏差"词曾被当三种性质完全不同的东西混用，处置各异——标注时必须先归类：

1. **里程碑分期**（计划内、留待后续里程碑，非缺陷）：如独立模式真并行留 v2。这**不是债，是路线图**。措辞标 **`v2 计划` / `v3 计划`**，指回 [[../design/roadmap]]，审计不当缺陷报。
2. **已登记工程债**（设计定了、代码简化了、当场标注在案）：CLAUDE.md「工程偏差允许先实现，但必须当场在设计层标注」的产物——真·设计↔代码不一致，但已知可追。**这就是"欠 v1 的债"**，转入 **`TODO.md` DEBT backlog** 逐项处置（每项：位置 / 影响 / 触发条件）。补全时若改接口，按 `^anc-meta-module-evolution` 第 5 条同时标注"接口如何变、谁受影响"。
3. **变更记录**（其实是"已修正的旧做法"，误挂"偏差"名）：如早期 inputs 一刀截断已被受众分流替换。不是待办，是历史沿革——措辞改叫 **"变更记录 / 已修正"**，归 changelog 性质，不再污染偏差台账。

> **三处落点分工**：本锚点定义**判据**（是什么、怎么分类，产品侧）；[[../design/roadmap]] 是**里程碑特性清单**（义1 路线图的家）；[[../../TODO]] DEBT backlog 是**已登记债台账**（义2 的家）。`[[工程实现链规范#^anc-meta-module-evolution]]` 第 5 条定义偏差标注**怎么写**（方法论侧、通用）。

## 待设计

- [ ] Prompt 组装的 token 预算管理策略
- [ ] 验证环境的实现方案（容器化 / 进程隔离 / 虚拟执行）
- [ ] 知识库的索引和检索策略（向量检索 / 关键词 / 混合）
- [ ] Spec 库的存储格式和检索协议
- [ ] 固化流转的自动化判定（多少次成功算"验证通过"）
- [ ] 有序思考重试时失败上下文的摘要策略（避免 token 膨胀）
- [ ] 有序思考的 spec 生成质量保障——需要什么级别的 LLM
