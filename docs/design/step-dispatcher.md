%% @trace
	id: hopjit-step-dispatcher
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-23T10:39+0800
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
| 无超时语义 | 契约 | `anc-exec-pause-timeout` |
| impl resume_spec | 说明 | — |
| 独立模式 call 递归 | 契约 | `anc-exec-call-recursion` / `anc-exec-call-tool`（工具 callee 退化形态）/ `anc-exec-call-child-persist`（子实例状态落盘随父） |
| 独立模式真并行 | 契约 | `anc-exec-standalone-parallel` |
| impl execute_step | 说明 | — |
| lack_of_info 知识补充路径 | 说明 | — |
| 节点级工具授权分档下发 | 契约 | `anc-step-tool-grant` |
| reason 步工具面（standalone） | 契约 | `anc-exec-reason-tools` |
| 工具故障自报通道（reason+无 body act 的 tool_failure） | 契约 | `anc-exec-tool-failure-report` |
| ~~doc-ref 文档引用解析~~（已抽出 [[doc-ref]]） | — | `anc-exec-doc-ref-resolve` 迁 doc-ref.md |
| 算子级重试 | 契约 | `anc-exec-operator-retry` |
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
| API 密钥管理 | 契约 | — |
| 多模型路由 | 契约 | `anc-exec-model-routing` |
| 路由解析 | 契约 | `anc-exec-model-resolve` |
| 成本护栏 | 契约 | `anc-exec-cost-guardrails` |
| 上下文水位观测告警 | 契约 | `anc-exec-ctx-watermark` |
| 输出预算解析 | 契约 | `anc-exec-output-budget` |

> 跨文档引用 `^anc-exec-mode-invariants`（[[../concepts/HopSpec V3配套HopJIT运行时能力]]）是 link 不是本文定义锚点。

## 定位【契约】 ^anc-struct-step-dispatcher

> **模块版本**：step-dispatcher `v0.25.0`（2026-09-17）。本版 THINKING_EXHAUSTED 变招重试（^anc-exec-thinking-exhausted 三批——检出记名步号,该步后续重试轮 thinking 强制 disabled;R4 实撞同 run 13 次烧满 65535 正文全空 ≈85 万纯废,免预算重试无变招同型反复撞）。上版 v0.24.0 新增成本护栏第 5 机制——实例级上下文体量观测与软阈值告警（^anc-exec-ctx-watermark,hopissues/0095——长转录 150K+ 延迟超线性恶化撞超时墙全程零观测;峰值水位入账 hoplog/run_status+双档 warn+超时重试水位提示,纯观测加法零语义变更）。上版（v0.23.1）补 ^anc-step-tool-grant 设计侧锚定义节（0088 批清 0054 批挂账——内容收拢自 spec-parser 版本行文法半边与本文档消费面,TRACEABILITY ⚠ 注记随清）。上版（v0.23.0）新增 call callee 位插值解引用契约（^anc-step-call-dynamic-callee,todo/0066——resolveCalleeId 公共件/三消费点/非空字符串收紧/寻址政策零开口/executor 教学落 L0）。上版（v0.22.0）节点级工具禁用下发过滤契约（^anc-step-tool-deny,与 edit_file 同批）。前版（v0.21.0）工具循环上下文压缩降级（0070:撞墙预检+补救两档任务相关摘要压缩/二次撞墙 CONTEXT_OVERFLOW 前缀入确定性口袋）。0.x 未承诺稳定。独立模式驱动适配层；复用模式不经本模块）。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。

**① 自身定位**：StepDispatcher 是独立模式的驱动适配层（TypeScript 模块，文件 `src/dispatcher.ts` + `protocol-openai.ts`）——负责**调度循环**（init → next → execute → done → repeat）和**单步执行**（按步骤类型分派，经协议适配层调 LLM API——anthropic/openai 双协议，见 ^anc-exec-protocol-adapter；工具循环当下仅 anthropic）。它是 HopJIT"自带执行能力"的承载者：复用模式把执行能力交给 caller（CC），独立模式则由本组件自己调模型执行。

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
| `DirSpecProvider` | 类 | dispatcher.ts | 缺省 SpecProvider（调用方 spec 同目录寻址，standalone 入口/测试构造注入；决策见 [[shared-providers#^anc-provider-spec-default]]） | provisional |
| `ProtocolClient` / `LlmErrorKind` | 类型 | protocol-openai.ts | LLM 调用协议句柄与错误类别枚举（dispatcher 内部消费+测试） | provisional |
| `wrapAnthropicClient` / `makeOpenAiClient` | 函数 | protocol-openai.ts | 双协议客户端构造（dispatcher 构造分派消费） | provisional |

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
- `request_abort` / `request_abort_cascade`——协作式中止请求：置 aborted 标志，循环在步间检查生效（不打断执行中的单步）。`requestAbort` 只停本层（parallel 杀活对单个在飞子实例用它）；`requestAbortCascade` 递归遍历**三张在飞表**逐个下发——inflightDispatchers（parallel worker）、callFrames（暂停中的 call 子帧）、activeCallChildren（执行中的串行 call 子层：handleCallStep 在 `await 子 runSpec()` 期间子 dispatcher 不在前两张表里，进 await 前登记、结算后注销——2026-08-22 review 实抓该缺口，只遍历两表则串行 call 子树烧到自然终态）——深递归/并行场景下停整棵执行树。后者是 mcp-server `stop_run` 的消费面（[[mcp-server#^anc-mcp-stop-run]]）

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
- spec_source: text  # HopSpec markdown 原文或文件路径
- run_params: yaml   # 运行参数：Spec Inputs 的初始值（可选）

Outputs:
- result: yaml       # Spec 的 Outputs 变量集合
- status: line       # completed | failed

## Steps
1. [act] 调用 hopjit init 解析并初始化执行实例
  - ← spec_source, run_params
  + → instance_id: line  # 执行实例 ID
  > 调用 Engine 的 init_execution，传入 spec_source 和 run_params
  > 返回 instance_id；若解析或验证失败则展示 errors 并终止

2. [loop] 逐步执行直到完成或失败
  + → result, status

  2.1. [act] 调用 hopjit debug_step 获取下一步上下文
    - ← instance_id
    + → next_resp: yaml  # NextResponse（5 种形状之一）
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
          + → has_none_inputs: bool
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
              + → step_result: yaml  # 步骤输出或暂停信号
            2.2.3.1.2.2.2. [branch] 按 step_result 类型分派
              + → none
              2.2.3.1.2.2.2.1. [case] step_result 为暂停信号（confirm/commit 触发 HITL）
                2.2.3.1.2.2.2.1.1. [act] 输出暂停信号，退出循环等待外部回复
                  - ← next_resp, step_result
                  + → pause_signal: ExecutionPaused
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
        + → new_steps: text  # 新 children 的 HopSpec Steps markdown
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
    · 值 > 20000 → 预览条目（L4 yaml 缩进条目形态,^anc-exec-inputs-render 同款元信息头）:
      值位=前 20000 字符 + 明示"以下省略 N 字符";条目自带"体量: 全文 M 字符"与
      "全文: <work_zone/vars/<name>.json>（本条为节选预览;有文件工具时可读全文）"——
      全文照旧落盘（act 工具环读得到,审计有据）,与指针形态的本质区别是值位是真内容
      不是死引用,无工具的模型按预览作业,不会被逼编造
  - BodyInterpreter 的 derefFilePointer 保留（防御性——历史 state 里可能已有指针值）;**$preview 预览对象同经它解引用还原真值**（消费侧契约权威 [[shared-types#^anc-exec-deflate]] D59 $preview 段——解释器是确定性执行体,预览对象为 LLM 设计,dr18 第3攻 validate_spec 收对象确定性死实撞;$preview 只对绑定值顶层整串产生〔产生条件 typeof val==="string"〕,结构上不出现在数组元素/字段位,递归覆盖属 belt-and-suspenders）（构造 BodyExecContext 注入 `commandWhitelist`/`cmdJournal=engine.getCmdJournalFor`——subprocess.run 独立模式接线,清账归 engine.completeStep;契约权威 [[act-body#^anc-exec-subprocess-run]] 双模式条款,2026-08-30 属地登记）
  - 500 字符截断维持废除（预览是显式声明的节选,不是静默截断）
  - 复用模式零变化（driver=Claude 有 Read,4096 deflate 指针语义照旧）
```

**正反例**：standalone 中等输入（4K-20K）reason 步 prompt 含真值全文（无 $file 无预览标记）/standalone 超大输入（>20K）prompt 含前 20000 字符+省略声明+全文路径,work_zone/vars 落盘全文/复用模式同输入照旧 $file 指针/预览条目值位是真内容片段而非 `{$file:...}` 对象。

## LLM 前缀缓存注入（anthropic 协议）【契约】 ^anc-exec-cache-control

**为什么**（作者定 2026-08-16 ABC 全做之 B/C；A 分层重排见 [[prompt-assembler#^anc-exec-cache-affinity]]）：standalone 一次 run 几十次独立 API 调用共享稳定前缀，Anthropic 前缀缓存**不标不缓存**——cache_control 断点是显式 opt-in。写入 1.25×、读 0.1×，同 run 内步骤连续调用（分钟级间隔 < 5min TTL）复用 ≥1 次即回本。

**注入规则（B）**：
- **单步调用**（buildApiRequest）：system 从纯串改 content-block 数组——稳定面块（workspace + L1-static + L2-spec + spec 级 doc-ref + hop_env 表）末尾打一个 `cache_control: {type: 'ephemeral'}`；易变面（position_context + 步骤级知识等）在其后不标。tools→system→messages 前缀序下 tools 自动一并入缓存；
- **act 工具循环**（executeActWithTools）：除 system 稳定块外，每轮把**最新 user 消息**（tool_results）打滚动断点——N 轮循环逐轮增量复用，不打=每轮全价重读全部历史。**滚动=移动不是累加**：打新断点前必须先遍历 messages 清除既有 user 消息内 tool_result 块上的 cache_control 字段（system 稳定块断点不动——它在 system 数组不在 messages），保证 messages 内恒最多 1 个断点（+system 1 个=总 2）。缓存复用不靠旧标记留在原地——上一轮已缓存的前缀由 API 按最长前缀匹配自然接续。**为什么必须清（2026-09-04 review 面二 D1 实锤）**：初版只打不清，每轮新增 1 个断点从不清旧——5 轮循环即累积 6 个断点（含 system 1 个），超 Anthropic 官方上限 4 个 cache_control 块，API 直接 400 拒收，长工具循环必死；
- **低于最小可缓存长度**（~1024 token）API 自动忽略标记——小 spec 无害零分支；
- **openai-chat 协议**：适配器剥除 cache_control（OpenAI 自动前缀缓存,A 的分区重排已让它受益）——IR 恒 Anthropic 形状,剥除在 create 转换处。

**观测闭环（C）**：HopLog llm 流控字段扩 `cache_read_input_tokens`/`cache_creation_input_tokens`（response.usage 透传;openai 侧 null 如实记）——真机档跑完可算实际命中率,无观测=效果只能靠信仰。cumulativeTokens 计费口径不变（cache 读写已计入 usage.input_tokens 的计费语义由 API 侧定义,引擎照记原值）。

**正反例**：稳定块断点在场（anthropic 单步请求 system[0].cache_control）/工具循环第 2 轮最新消息带断点/openai 请求体零 cache_control 字段/小 spec 不因断点报错/HopLog llm 块含 cache 两字段（anthropic）与 null（openai）。

## Paused 恢复机制（独立模式 CITL）【契约】 ^anc-exec-paused-resume

概念层原则"CITL 暂停点一致"（[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）要求 confirm 在独立模式也产生"等待 caller 决策"状态。`runSpec()` 遇到 confirm 返回 `{ status: 'paused', pause: ExecutionPaused }` 后，caller 通过恢复机制注入决策并继续执行。commit 不暂停（授权前序完成，直接执行）。

### 统一恢复模型

**resume = 在某个 PersistenceProvider 之上从暂停点继续驱动引擎**。内存/文件只是 persistence 选择，不是两种恢复机制：

| 场景 | Persistence | 恢复入口 | 适用 |
|------|------------|---------|------|
| 短暂停（程序内审批） | MemoryPersistence | 同实例 `dispatcher.resume(stepId, answer)` | 调用方进程长活（服务、HopAnt 实例） |
| 长暂停（人工隔天审批） | FilePersistence | 跨进程 `resumeSpec(persistence, stepId, answer)` | HITL 等待跨进程生命周期 |

`resumeSpec` 内部即"从快照重建 Dispatcher + 调用同实例 resume"——两条路径汇合到同一实现。

> **实装状态（2026-06-13）**：CITL 恢复闭环已实装。`dispatcher.resume(stepId, answer)` 注入决策——confirm 将 answer 作为步骤输出 completeStep（audit hitl_decision）；commit 批准走 act tool_use 循环执行不可逆操作（allowCommit=true 放行 requires_commit 工具，audit commit authorized_by='human'），拒绝则 failStep。runSpec 遇 confirm/commit 构造 ExecutionPaused（pendingPause）返回。
> 跨进程恢复的实装形态=mcp-server 重启后 run 恢复（[[mcp-server#^anc-mcp-run-restore]]）：load 引擎 + 宿主重注入 HostConfig + 新建 Dispatcher（构造时回填 cumulative_tokens）。同进程 `dispatcher.resume` 覆盖常规路径。

### 恢复 API

**恢复能力契约（HopTrait，Spec without Steps）**：

```
# Spec: 同实例恢复
Id: dispatcher-resume
Goal: 注入 caller 对暂停步骤的决策，继续执行循环直到下一个终态/暂停点
Inputs:
- step_id: line     # 暂停的 confirm/ask 步骤
- answer: yaml      # caller 决策（注入为步骤输出）
- call_path: [line] # 可选。多层 call 暂停帧的调用链——非空则剥头下钻直达挂起帧
Outputs:
- result: yaml      # RunResult（completed/failed/paused;paused+rejected={code,message}=answer 被拒未推进,修正后可重试——0016）

# Spec: 跨进程恢复
Id: dispatcher-resume-spec
Goal: 从持久化快照重建执行状态后恢复——注入决策续跑（对账在飞、重建 worker 见 §U2）
Inputs:
- persistence: PersistenceProvider
- step_id: line
- answer: yaml
- host_config: HostConfig
Outputs:
- result: yaml      # RunResult
```

（代码层投影：dispatcher.ts `StepDispatcher.resume(stepId, answer, callPath?)` 与 `resumeSpec`——设计以本契约为准。）

### confirm 的恢复语义【决策+契约】 ^anc-exec-resume-semantics

**confirm 是唯一的暂停点**（鉴权/决策环节）。commit 不暂停——授权在前序完成（环境预授权或前置 confirm），commit 直接执行不可逆操作，如同 `git commit` 不每次重新鉴权（见概念层 `^anc-step-commit`）。

| 步骤类型 | answer 含义 | 恢复后行为 |
|---------|-----------|----------|
| confirm | 审批决策（approve/reject） | approve → bool 槽写 true，记录 hitl_decision 审计 → 继续循环；reject/deny → 全局中止 |
| ask | caller 提供的数据值 | 值直接落到 `+→` 声明变量名 → 继续循环。无 reject 全局中止语义 |
| commit | （不暂停，无 resume） | commit 直接执行：走 act tool_use 循环执行不可逆操作，记录 commit 审计（authorized_by='policy'，授权由前序建立）。需人工把关时由 Spec 作者在 commit 前置 confirm |

**confirm answer 规范化【契约】** ^anc-exec-confirm-answer：（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-confirm]] answer→输出映射）caller 注入的 answer 不直接 writeOutputs（否则原始 key 如 `value` 污染变量空间、声明的输出名永远为 None）。规范化在 **engine.completeStep 一处**集中（复用模式 CLI `submit_and_fetch_next --answer` 与独立模式 `dispatcher.resume` 共用，模式无关）：
- **决策值提取**：`answer.decision ?? answer.value ?? answer.answer ?? 单值`
- **reject 类**（reject/rejected/deny/denied/no——后两值为代码宽容同义词，2026-08-08 审计回写）→ **全局中止**（非局部 fail）：confirm 是授权否决，整条执行路径终止——`failStep` 后将所有未终态步骤标 `skipped`、执行终态 `failed`（类似 exit 全局性，终态失败）。**不走步骤级升级链**（reject 是授权否决非执行失败，且后续 commit 未必依赖 approval，数据链拦不住）。统一两模式，原 dispatcher.resume 的 reject 分支收编进 completeStep。见概念 [[../concepts/HopSpec V3核心规范#^anc-step-confirm]] reject 全局中止
- **approve 类 → bool 审批槽写 `true`**（confirm 收窄为纯审批，`+→` 仅 bool）。落到 `+→` 声明的变量名，caller 无需知道声明名

**ask answer 处理【契约】** ^anc-exec-hitl-presentation：（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]]）ask 是数据收集，与 confirm 审批正交。caller 注入的数据值直接落到 `+→` 声明的变量名——不走 confirm 的 decision 提取/reject 中止逻辑。若 caller answer 是 approve（采用默认值快捷），引擎用 `default_value`（前序推断）填充；若 answer 给具体值/选项，则用该值。（本锚点覆盖：paused 自包含介入请求组装 + ask answer 落值）

**question 与 instruction 受众分流（2026-08-25 修 #34,作者 08-24 实抓）**：paused 载荷的 `presented_data.question` 是**给人的问题面**——只由 summary 构成（confirm=`审批：<summary>` / ask=`请提供：<summary>`），**不再拼接步骤 instruction**。instruction 是 spec 作者写给执行/驱动侧的作业指引（"若 X 已给且存在直接采用不必强问"这类），受众是答题的机器方,拼进 question 等于让人读机器指令（实抓形态:question 后半段全是驱动侧判断规则）。instruction 保留为载荷独立字段（驱动侧代答判断/是否强问的参考——**driver 契约已接线**:各载体 SKILL 的 paused 节注明读 presented_data.instruction 且带 require_human:false 例外框架〔无框架裸挂"代答"=在没开门的文档里隐式开门,二审抓表述漂移〕;原表述含"呈现裁剪依据"已删——呈现裁剪与 present_inputs 禁缩略硬约束冲突,instruction 不得作为缩略呈现的依据）,数据面归 context/output_schema/default_value,呈现契约（present_inputs 纪律）不变。审计对齐:hitl 的 shown 字段与 question 同源（=summary）——instruction 不进人眼后审计再拼它="还原人当时看到了什么"失真（观测记录点必须在事实边界）;instruction 的审计痕在 paused 问题卡整卡。

**ask 零映射拒收**（hopissues/hoplogic3/0031——规范化后一个声明输出都没得到有效值 → 拒收不写表）：mapAskOutputs 三分支（声明名直配/单值提取/approve 快捷）走完后，若**全部声明输出均无有效值——undefined 或 null 都算无效**（review 复核抓漏：原判据只认 undefined，而 MCP/CLI 的 answer 走 JSON，**JSON 没有 undefined、序列化空值恰产 null**——`{value:null}` 把 null 灌满全部声明输出后穿闸，0031 病灶经 null 形态原样复发；典型形态：answer 是 `{value:"approve"}` 但前序无同名推断值可采——approve 是 confirm 的应答形态，ask 要业务值），completeStep 返回 `SCHEMA_MISMATCH` 结构化错误（报文点名缺哪些声明输出+指路"approve 快捷需前序有同名推断值"），**不写变量表、不记 hitl、卡保留、不推进**——与凭证闸（0004 ask 级）同通道形态。修前静默 ok：声明输出落 None，下游拿空输入继续跑，败因漂移到两步外（fact-check 全链实撞：步骤 3 静默吞 → 步骤 5 retry exhausted，真因与终态败因隔两步）。**部分映射容忍**：多输出声明部分有值=放行（增量应答合法，未答的落 None 由下游 None 传播语义接手）——拦的是"整个应答一个都没对上"（应答形态整体错误的机械判据），不拦"答了一半"。

**ask paused 响应的 `present_inputs` 透传【契约】**（对齐概念 [[../concepts/HopSpec V3核心规范#^anc-step-ask]] 呈交语义条款）：若 AskStep 声明了 `present_inputs: [name1, name2, ...]`（已经过 P12 校验是 ← inputs 的子集），引擎组装 paused 响应时**必须**在 `presented_data` 加 `present_inputs: [name1, name2, ...]` 字段，原样透传。driver 收到此字段非空时，**必须把 `context` 里这些字段的原文完整 dump 给 user**（用 markdown 段落/引用块/代码块），禁止只给标签/省略号/摘要后再问决定——这是 driver 契约义务，由各 runtime 载体（复用模式 SKILL.md、独立模式 dispatcher 等）落实。省略 `present_inputs` 字段（或为空）= 现行行为（driver 可缩略）。**用途**：让"草稿 → user 审 → 继续"场景（如 PPT 大纲确认、文档 P0 决策）真正保证 user 看到大段内容才作答。注：数据本身已在 `context` 里完整呈现（context 含该 ask 的全部 ← inputs 值），present_inputs 只是"必展示"标记，不是新数据通道。

commit 由 Dispatcher 直接执行（独立模式执行能力在 ToolProvider/引擎侧）——由概念层双模式定义推演：执行能力归属决定执行者。审计链：`authorized_by` 记录授权来源（policy/human），执行记录归属执行者。

本节机制满足概念层原则 5（暂停必有恢复闭环，执行必达终态，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]]）。

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
- instance_id: line  # 已有执行实例 ID
- step_id: line      # 暂停步骤 ID（CITL 恢复时必填，崩溃恢复为空）
- answer: yaml       # caller 决策（CITL 恢复时必填）

Outputs:
- result: yaml       # Spec 的 Outputs 变量集合
- status: line       # completed | failed | paused（再次暂停）

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
- **结果回填（review D5 收窄 2026-08-25）**=响应按 output_mapping 落父变量,两条合法路径——①响应为对象且 `from` 是其字段:取字段值;②响应为标量且**恰单条映射**:整值直落（唯一合法兜底形态）。其余形态（对象响应字段 miss——from 名打错;标量响应配多映射）**响亮 failStep 点名可用字段**,不整值灌错值（原实现字段 miss 时整对象兜底落变量,同值重复灌多变量零报错——灌错值温床）;output_schema 在场照 ^anc-exec-tool-shape-check 双端校验,偏差=步骤 fail 入既有升级阶梯;
- **requires_commit 语境拦截**：call 步骤位与 act 同权——requires_commit=true 的工具在 call 位拒绝（COMMIT_REQUIRED 报文指路"包进 commit 步骤的 body 调用"）;概念层"call 位同受 act 语境拦截"的落点;
- **重试语义（v1,review D9 对齐现状）**：工具 call 结果经 completeStep 落变量后步骤 done——容器重试时本步整步重跑=重调工具（与"act 可安全重做"同约:requires_commit 工具已被本位拦截,可重调面全部无不可逆副作用）;body 工具调用式的 journal 逐调用重放**不适用本形态**（那是步内多调用的中断续跑机制,本形态单调用即完成无中断窗口）;
- **复用模式对应（待落,review D3 挂账 [[todo/0027_工具一等公民三件_open|0027 四件余账]]）**：目标形态=CLI 通道 call 步骤对工具 callee 吐 tool_request（caller 执行后 --tool-result 交回）,不吐 call_protocol。**现状未实装**——CLI 通道对 call 步仍一律吐 call_protocol（工具名会进 callee 占位）,engine done 通道明文拒 call 步用 --tool-result;复用模式暂不支持工具 callee（写 spec 时工具调用用 act body 形态,双模式等价）。

## call callee 位插值解引用【契约】 ^anc-step-call-dynamic-callee

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-call]] 插值条款（2026-09-05 作者三拍："run_spec(spec_path, params) -- 这个不就是call么"定性动态派发是 call 的晚绑定形态不另造工具/"{}在hopspec中主要就是fstring语义，那就可以简化，直接用{analyzer_spec}"拍定 callee 位直接花括号无引号壳/"重要的还是给llm引导，让其明白，用call工具起类似subagent的作用"定知识供给半边并重——todo/0066 三拍原话全文在卡）。缘起：standalone 与复用模式派发能力不对等——产物 spec 要"探索后对每类对象各起一个子任务"时,复用模式有 Task 工具,standalone 执行 LLM 零派发能力;原方案 run_spec 工具被作者点破是 call 的重复发明（配额闸/收割/把关全要重造,且把派发权整个交给 act free 的 LLM）。正形=callee 位晚绑定：**结构管次数（调用点钉在步骤树上,单 call 一次/for-each 几个元素几次）、变量管对象（LLM 只能定"调谁"不能定"调几次"）**——费用失控面天然消失,收割/兜底/parallel 全复用既有链路。

**能力契约（HopSpec 契约）**：

```
# Spec: call callee 位插值解引用
Goal: `[call {表达式}(映射)]` 执行期把表达式求值成 spec Id,再走与静态 Id 完全相同的 call 链路——晚绑定只改"何时知道调谁",不改调用语义的任何一环
Constraints:
- 求值器与 f-string 同源（evalExprSync + 引擎变量空间 readVar 闭包）——表达式能力面全集（裸变量/字段取/下标）,不另开子集
- 求值结果必须是非空字符串——空值/None/对象/数字一律按解引用失败处置（callee 是标识符不是文本:对象值=上游产出形态错,响亮报错点名表达式原文与实际求值结果,不做 formatFStringValue 的对象转 JSON 静默兜底）
- 解引用成功后走完全既有链路：SpecProvider→ToolProvider 两段决议/参数过 callee Inputs 校验/子实例/独立把关/续链收割/失败单跳摘要/parallel——零新执行机制,晚绑定对下游不可见
- 寻址政策零开口：求值结果走与静态 Id 同一 provider.resolve 通道——DirSpecProvider 拒 / 与 .. 的防穿越政策自然沿用;概念层"Id 或路径"的路径含义归 provider 政策（换支持路径的 provider 即支持）,引擎不为路径形态开新分支
- 三消费点同改,一处不漏：同步 handleCallStep / parallel launchParallelCallChild / 复用模式命令占位拼装（engine 侧三处——dispatch_ready launch_command / buildCallProtocol init_command / buildStaleLaunch 重拼,均经 <CALLEE_SPEC_PATH:id> 占位——漏改则 {表达式} 原文漏进命令静默失败）
- 解引用失败（求值异常/非字符串/空串）= 步骤失败带明细（表达式原文+求值结果）进既有升级阶梯,与 UNKNOWN_SPEC 同款处置,不静默
- 解引用失败的形态分模式:独立模式（dispatcher 两消费点）=步骤失败响亮报带明细;复用模式（engine 三占位点）=warn 落账+载荷缺席（buildCallProtocol 整包不拼）或空占位（dispatch_ready/staleLaunch 的 `<CALLEE_SPEC_PATH:>`）——nextStep 途中不宜 failStep 的结构限制,失败最终在 worker 侧响亮（launchParallelCallChild 已先报）;两形态都不让 {表达式} 原文漏进命令
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

**知识供给半边（与文法半边并重,作者定"如何用要描述清楚"）**：executor 教学落 L0 worldview（收链实证现状为零——L0 叶子类型枚举行的 call 半句扩为完整心智模型:call 步骤引擎自动执行=派发独立子实例〔相当于 subagent:独立上下文/自带把关/产物自动收回〕;探索步为后续 call 备清单=每项含 callee 标识与参数,派发/等待/收割全归引擎;禁止自己在上下文里逐个扮演子任务——上下文污染/撞窗口/零并行三致命伤。落 L0 依据:全程恒定的世界观知识,L0 恒定化后加在稳定块零 cache 代价）;构建器判据落 split-patterns call 主节（何时用:生成期能枚举恒静态 Id,连调谁都要现场定才插值;正反例并排）。教学面验收判据：零先验执行 LLM 读完能答对三问——派发谁做/我产出什么/为什么不能自己扮演。

**正反例**：`[call {issue.analyzer_spec}(problem: issue.kind) parallel]` 求值 "security-analyzer" → 派发该 spec 子实例（正）/求值结果为对象 → 步骤失败点名"callee 表达式求值结果非字符串"（反）/求值出 "no-such-spec" → UNKNOWN_SPEC 与拼错静态 Id 同款（反）/静态 Id spec 全量测试零回归（正）/S12/S16 对插值形态照常判定（正——判定材料不含 callee 字段,收链实证）。

**能力契约**（HopSpec 契约）：

```
# Spec: 独立模式执行 call 步骤
Goal: 解析 callee spec 并嵌套执行，把子 Outputs 按映射回填父变量；子层 confirm/ask 直达顶层 caller
Inputs:
- call_step: CallStep         # callee_spec_id + param_mapping/output_mapping
- call_depth: number          # 本帧深度（顶层 run 为 0）
Outputs:
- step_result: yaml           # 子 Outputs 映射回父的变量集，或暂停信号
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
- `DirSpecProvider`（出口 `dispatcher.ts`）——缺省 SpecProvider（决策与寻址规则见 [[shared-providers#^anc-provider-spec-default]]）：构造入参 = 基准目录；`resolve(id)` = 读 `<基准目录>/<id>.md`，id 含 `/`、`\` 或 `..` 直接返回 null（防穿越），文件不存在返回 null

**子实例状态落盘（2026-08-29 作者定"为啥不落盘,可能比较大啊"——原 MemoryPersistence 缺省的翻案）** ^anc-exec-call-child-persist：

原设计"Dispatcher 驱动完整生命周期,无需跨进程"的推理只在"进程永不死、中间不停顿"的假设下成立——假设破了,四坑实存：①deflate 大值卸载无 work_zone（子实例大产出全量占内存+全量内联 prompt 双重放大——作者点破的正是这坑）;②子实例内 confirm/ask/escalate 暂停卡不落盘,server 重启即蒸发（MCP 0028 detach 恢复只救顶层）;③崩溃后父可 resume 子实例从零重跑白烧钱;④最重:子实例已执行 commit 后崩溃,退火标记（committed_steps）随内存死,resume 重跑=commit 重放——复用模式靠子盘上 state.json 传播退火（^anc-exec-commit-anneal 三形态传播）,standalone 子实例无盘此防线整个不存在。

行为契约（逐条,验证面）：

1. **落盘判据=父有则子有**：父引擎 instanceDir 非空 → 子引擎 stateDir=`<父instanceDir>/calls`（FilePersistence 使子实例落 `calls/<callStepId>/`——与复用模式 init --parent 的目录布局完全同构,零新布局）;父 instanceDir 为空（纯内存宿主:测试/程序内嵌入——"无跨进程"假设在该场景真成立）→ 子随纯内存,现状形态保留;
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
5. [act] 建子引擎（**状态落盘随父**:父有 instanceDir → stateDir=<父instanceDir>/calls,子落 calls/<callStepId>/——与复用模式子实例同布局;父纯内存 → 子随纯内存〔见"子实例状态落盘"条款〕;+ parentInstanceId/callStepId + 父 hoplog 卫星目录）
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

**与复用模式的对称**：两模式的子实例形态、id（callStepId）、输出回填（completeCallStep）、失败通道（failCallStep/CalleeFailure）完全同一套引擎 API——差别仅在"谁驱动子实例"（CC 起子进程链 vs Dispatcher 嵌套递归）;状态介质自子实例落盘批（^anc-exec-call-child-persist）起两模式同判据——父有 instanceDir 子落盘,父纯内存子随之。confirm 上升在复用模式天然到顶（CC 全程驱动），在独立模式经 call_path 直达——同一概念锚点两种落法。

> **实装状态（2026-08-10）**：随 v2-1 实装（[[roadmap#v2-1 独立模式（引擎自驱）]]，DEBT-04（已销,盘点见 [[todo/0028_call-能力盘点与剩余缺口_open|0028]]） 项 3）。engine 侧 Inputs 自动映射与运行时 depth 检查见 [[exec-engine]] Call 执行模型（两模式共用）。

---

## 子实例 HITL 队列（dispatcher 侧机制）【契约】 ^anc-exec-parallel-hitl-queue-dispatch

> 语义权威=[[parallel-execution#^anc-exec-parallel-hitl-queue]]（U4b 六件套,2026-08-25 作者拍板 A）。本节只登 dispatcher 侧机制件：

- **队列结构**：`pausedChildren: Map<child_instance, { pause: ExecutionPaused; dispatcher: StepDispatcher; kind: 'subtask'|'call' }>`——子 dispatcher 句柄存活等应答（与 callFrames 同哲学:挂起帧不销毁）;
- **入队点**：launchParallelSubtask/launchParallelCallChild 的 worker 终态回调 `r.status === 'paused'` 分支——原 PARALLEL_HITL_TODO 判 failed 退役:改 `engine.markInflightPaused(child)`（账 inflight→paused 让名额）+入队,**不 reap**（子实例未终态）;子引擎盘上问题卡保留（0028 契约,35 轮临时清卡撤）;
- **应答路由**：`resume(stepId, answer, callPath, childInstance?)` 第四参——携 childInstance 时从 pausedChildren 取句柄:`engine.markInflightResumed(child)`（paused→inflight 二次占名额;名额满等空位）→ 子 dispatcher.resume(stepId, answer) → 终态照常 reap、仍 paused（多暂停点）更新队列;
- **executionLoop 等待面**：drain_wait 的"无在飞句柄防死循环"判据改为"无 inflight 句柄**且无 paused 队列**"——只剩等人时不判 failed,返回 paused（队首卡+run 级 paused 语义,主线让位等人）;
- **杀活连坐**：requestAbortCascade 与主线失败杀活遍历 pausedChildren——子 dispatcher abort+子引擎 removePausedCard+账记 killed+出队。

## 独立模式真并行【契约】 ^anc-exec-standalone-parallel

由 [[exec-engine]] 决策 4（渐进升维）的 v2-1 档推演：独立模式复用引擎同一套并行三机制（批收集/worker 隔离/单点 join），并发原语选**进程内 Promise 池**——独立模式执行能力全在引擎侧，无需子进程/文件介质。S12（children 无数据依赖）保证与顺序模拟结果等价。

**worker 共享父 ToolProvider**（hopissues/0021,2026-08-20——原每 worker 构造自建 CompositeToolProvider:含 stdio mcp 成员时各 spawn 独立子进程且 close 三收点只收顶层,worker 的无人收——hopkb 实撞一天批量验证后 218 僵尸进程×600MB≈6.8GB）：四个 worker 构造位点（fan-out 派发/同步退化/call 递归/call 帧恢复）经 `DispatcherConfig.sharedToolProvider` 注入父 provider——worker 持同一引用零新建零 spawn,provider 生命周期归顶层三收点（mcp-server applyResult 终态/failed-via-throw/resume-catch）;工具面同源（同一 hostConfig）共享安全;未注入照旧自建（顶层/宿主直构语义不变）。**已知轻微面（记档不修）**：共享 provider 的 warnSink 闭包捕获父 pendingToolWarns——worker 执行期的装配 warn 堆进父暂存,随父下一步落账（挂错步但留痕在,warn 是横切诊断非步骤归因;修=per-call warn 上下文,复杂度不值当前收益）。

**能力契约**（HopSpec 契约）：

```
# Spec: 独立模式执行 parallel 批
Goal: 把 nextParallelBatch 吐出的 children 并发执行（各自内存态子引擎），全部终态后 joinParallel 合并回父
Inputs:
- batch: ParallelReady        # 引擎批量吐出的就绪 children（已排除含 confirm/ask 子树）
Outputs:
- join_result: yaml           # joinParallel 合并结果（收集列表/同名提升落父变量空间）
Constraints:
- 并发窗口 ≤ max_concurrent_workers（缺省 5）——超出的 children 排队，任一完成即补位
- 失败 child 不阻塞兄弟（全部跑到终态才 join；失败不贡献收集元素——列表变短，2026-08-09 定稿）
- worker 子引擎内 can_fanout=false（嵌套 parallel 退化串行，一层并行原则）
- worker 内暂停点不可能出现（引擎批收集已结构性排除含 confirm/ask 子树，^anc-exec-parallel-confirm-exclude）
```

**类型约定**（HopType）：无新公共类型——复用 `ParallelReady`/`ParallelChildSpec`（cli-types）与引擎 `joinParallel` 入参形状 `Record<child_id, { vars, failed, log? }>`。Dispatcher 内部件：

- `runParallelBatch(batch)`——私有方法，Promise 窗口池调度器（见下方流程）
- worker 子引擎构造：`initExecution(父spec原文, hostConfig, { params: child.params_for_child, subtreeRoot: child_step_id, parentInstanceId, callStepId: child_step_id, traceId: 父 instanceId, logDir: 父卫星 parallel/<cid>/log })`——**状态落盘随父**（父有 instanceDir → stateDir=`<父instanceDir>/parallel`,子落 `parallel/<childId>/`;父纯内存 → 子随之——^anc-exec-call-child-persist 契约条 2）、`canFanout` 不置（false，嵌套退化串行）；**spec 源=引擎留存的原文 `getRawSource()`，禁用 `serializeSpec` 重建**——序列化按设计单向有损（[[spec-parser]] 关键决策 4：body 围栏、parallel 属性等不保证保留），拿它重建 worker 源=语义静默丢失（实撞：act body 丢失 → worker 走 LLM 循环悬挂）。引擎为此在 init 留存 spec 原文（内存字段，见 [[exec-engine]]），worker/replan 后源以 AST 持久化的 spec.json 为准不受影响
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

**与复用模式的对称**：批收集（`nextParallelBatch`）、暂停点排除、join merge（`joinParallel`）全是同一套引擎 API；差别仅在 worker 载体（CC subagent 子进程 ↔ 进程内 Promise）;状态介质自子实例落盘批（^anc-exec-call-child-persist）起两模式同布局——父有 instanceDir 时 standalone worker 同落 `parallel/<childId>/`,父纯内存才走 MemoryPersistence。`can_fanout` 语义相同：顶层 Dispatcher 的引擎置 true 以启用 `advanceToCaller` 的 fan-out 探测，worker 子引擎不置。

> **实装状态（2026-08-10）**：随 v2-1 实装。dispatcher `executionLoop` 增 `parallel_ready` 分派 + `runParallelBatch` 窗口池；引擎侧零改动（三机制 v2 复用模式已备）。原"独立模式保持顺序模拟"（决策 4 v2 档注记）随本节作废。

```
# Spec: 执行单个步骤
Id: execute_step
Goal: 根据步骤类型分派执行，返回步骤输出

Inputs:
- next_resp: yaml  # StepReady（来自 hopjit debug_step，status = 'step_ready'）

Outputs:
- step_result: yaml  # 步骤输出变量，结构符合 next_resp.context.output_schema

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
      > commit 步骤直接执行，调用 requires_commit=true 的工具
      > Spec 作者通过在 commit 前显式放置 confirm 步骤来保护（非自动内嵌）
      > 验证规则 P8 在 retry/adaptive subtask 内强制要求有 confirm 兜底

  1.6. [case] step_type = call
    1.6.1. [act] 初始化子 Spec 执行实例
      - ← next_resp
      + → child_instance_id: line  # 子实例 ID
      > 调用 Engine 的 init_execution，传入 callee spec 路径、父实例 ID、call 步骤 ID 和映射后的参数
    1.6.2. 调用 run_spec：递归执行子规约
      - ← child_instance_id
      + → step_result
```

---

## lack_of_info 知识补充路径【说明】

**承接面=仅 reason**（2026-08-31 作者定 0053"只应该给 reason"——reason 交 lack_of_info 本质是触发 fail:它是 reason 唯一的语义性自报失败通道;check 不设〔"判不了"的正形=如实 false+说明,或 escalatable 的结构化 gap——三值化议过撤了,不给 escalate 发明第二触发形态〕;act 不设〔确定性/工具执行,缺信息该失败就失败〕。原实装对全部 LLM 步骤类型不加区分地接,收窄后 act/check 交该键不入本路径——check 双槽照常走 schema 校验,act 同）。reason 返回 `lack_of_info` 非空时，StepDispatcher 不立即 fail，而是尝试知识补充检索后重试：

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

## reason 步工具面（standalone）【契约】 ^anc-exec-reason-tools

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-grant]]（2026-09-01 作者拍"所以应该给 reason 提供文件工具""等同于 act 的能力，不能 commit 写"）。缘起：anchor-audit spec standalone 化六跑，第六跑死在 4.2——reason 步要读盘上 cross_compare_results.yaml，standalone reason LLM 零工具面判不了（no knowledge provider）；5.2.1.1（逐锚点读源文件判定）/6.1（逐批读盘统计）同形态。复用模式执行者（CC/Codex）天然带工具面，reason 用文件/检索是常态——standalone 的 reason 与它能力不对等，同一份 spec 两模式一活一死。

**能力契约（HopSpec 契约）**：

```
# Spec: standalone reason 步执行
Goal: reason 步在 standalone 下与复用模式能力对等——可推理、可用受控工具读料，产出仍按声明 schema 解析
Inputs:
- step: StepReady  # reason 步（无 body——reason 本无 body 形态）
Outputs:
- outputs: yaml  # 按声明 schema 解析的产出（经既有 parseStepOutput 阶梯,lack_of_info/tool_failure 前置探测照常）
Constraints:
- 工具面与无 body act 同构：basic 族恒下发（本步被禁件除外——2026-09-05 禁用半边落地,改造前本条无此括注;禁用语义见本文档 ^anc-step-tool-deny 契约节）,special 按节点 `- 工具:` 声明（^anc-step-tool-grant 分档机械原样复用,零新分档）
- requires_commit=true 的工具恒不下发（"不能 commit 写"——reason 与 act free 同一条不可逆红线;list 期过滤,非运行期拒）
- check 不入本面（判官纯判定,作者未放开;要放开另立批）
- openai 协议降级：工具循环当下仅 anthropic（^todo-openai-tool-loop 既有账）——openai 路由的 reason 退回单发零工具形态（与改造前行为逐字节一致,存量零回归;不 fail-fast——reason 不同于 act:它总能纯推理产出,工具只是增强）
```

**HopSop（执行流程）**：

```
# impl execute_reason_standalone
1. [act] 组装工具清单（basic 恒 + special 按声明 + requires_commit 过滤）——与 executeActWithTools 同一分档代码
2. [branch] 协议分派
  2.1. [case(anthropic)] 走工具循环（与 act 共用循环体:滚动 cache 断点/预算闸/超轮上限/tool_failure 终轮探测）——角色档=reason 档（L4 指引,见 prompt-assembler L0 恒定化条款）
  2.2. [case(openai)] 单发零工具（既有 executeReasonOrCheck 形态）
3. [act] 终轮文本经 parseStepOutput 既有阶梯解析（lack_of_info 前置探测在 reason 路径已接——工具循环形态下位置不变）
```

**正反例**：reason 声明 special 工具→清单含之/未声明→仅 basic/requires_commit 件恒缺席/check 步零工具面照旧单发/openai 路由 reason 单发零工具与旧行为同构/工具循环终轮 lack_of_info 照常探测。

## 节点级工具禁用的下发过滤【契约】 ^anc-step-tool-deny

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-deny]]（2026-09-05 作者拍"甲，而且是不是可以在指定节点禁止 write tool?"——与 edit_file 工具同批：edit_file 给正路，禁用行封邪路）。缘起：0038b 轮定量账坐实 hopbuild2 修错步"有树编辑工具可用仍选 write 全文回写、另一轮 create+append×8+move 分块重建全文"——说明段的文字禁令（D68"禁止整篇重写"）不牢靠，需要结构性封堵：被禁工具从下发清单整体剔除，执行 LLM 根本看不到它。

**能力契约（HopSpec 契约）**：

```
# Spec: 节点级工具禁用下发过滤
Goal: 节点声明 `- 禁工具: 名` 后,该工具对本步执行者不可见——standalone 的 API tools 字段与复用模式的 L4 工具清单同一语义
Constraints:
- 过滤位=list 期,分档过滤之前（禁用优先——被禁件无论 basic/special/已授权,先剔除;与 requires_commit 过滤同哲学:清单里没有,LLM 不会调,运行期无需新拦截）
- 管辖面比授权行宽：授权行只能开 special,禁用行能关任意件含 basic 族（这正是它存在的理由——basic 恒下发原则的唯一例外通道）
- 消费面与授权行同族：无 body act 与 reason（executeReason 复用 executeActWithTools 循环体天然生效,零额外改动）;check/commit 不收禁用行（parser 层已拒,dispatcher 不需防御）
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

概念权威 [[../concepts/HopSpec V3核心规范#^anc-step-tool-failure-exit]]（工具故障退出条款，2026-09-01 作者拍 A 案随批回收概念层——与 lack_of_info"信息不足退出"并列的同族自报出口）。2026-09-01 作者拍板 A+C（缘起：复用模式 web_search 改走 caller 原生检索后作者追问"agent 自己的 web search 出故障能感知到么"——盘出无 body act 的结构缺口）。**问题**：无 body 的 act 步工具失败落在执行 LLM 手里没有结构化出口——独立模式工具循环把失败以 `is_error:true` 回注后全归 LLM 裁量，它想如实认输也没有语义通道（act 无 lack_of_info——0053 承接面裁定"act 缺信息该失败就失败"，但**工具故障不是缺信息**：lack_of_info 的承接是补检索，act 不适用；工具故障的承接是容器重试〔瞬时故障重试即愈〕+故障原文进失败账，act 天然适用——两通道不冲突不重叠）。无出口的后果两形态：硬凑产出（静默退化——检索故障伪装成"搜不到"，业务面不可区分）或交不合 schema 的东西（被当格式错烧算子重试，失败归因记错账）。

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

**C 案：零工具成果产出的机械 warn 兜底**（与 A 独立生效,同锚同批）：独立模式工具循环（executeActWithTools）终轮（无 tool_use、即将 parseStepOutput 返回）判：`toolCallLog` 非空且**全部** failure → `hoplog.recordWarn(step_id, '本步全部 N 次工具调用均失败,产出可能建立在零工具成果上（tool 块可对账）')`。不拦截不改产出——LLM 可能合法地"工具全挂后如实交了空结果/降级说明"，warn 是审计抓手不是判决。toolCallLog 为空（本步没用工具）或有任一 success 不触发。

**配套教条两处**：L4 清单调用方式行（真身档,教条句现行文本以 [[prompt-assembler#^anc-exec-tool-manifest-supply]] 第 4 面条款为准——本节只记落位不复述措辞,逐字引用曾在 2026-09-01 自救优先改词批漂移一次,review 后改指针形态）；driver 两载体复用模式同款教条（reason 段与无 body act 条,以 `--failure` 或 tool_failure 键承载——两条路殊途同归 completeStep 早判区/failStep;含自救优先决策序与成本结构,文本以各载体文件为准）。

**正反例**：act 步产出 `{tool_failure: "web_search 连续 3 次超时"}` → failStep 且 fail_kind='tool_failure'、容器 retry 触发=正；reason 步交 tool_failure（检索故障无法推理）→ 同触发=正（作者补定后承接面含 reason）；带 body 的 act 交 tool_failure → 照走 schema 校验（body 通道有 TOOL_EXEC_ERROR 闭环）=正；check 交 tool_failure → 照走双槽 schema 校验=正（check 不设）；act 正常产出含业务字段 → 零误触=正；toolCallLog 三条全 failure 且产出正常 → warn 落账=正（C）；toolCallLog 两 failure 一 success → 不 warn=反例判据（C 只认全败）。commit 无反例可写——B7 守卫 error 级下"无 body 的 commit"进不了引擎，通道够不着的形态无法构造测试（如实记录，不硬凑假 spec）。

**判定先于 schema 校验（顺序契约,2026-08-31 补钉）**：`{lack_of_info: …}` 形态天然缺声明输出槽——lack_of_info 判定必须在 completeStep schema 校验之前,否则先被 SCHEMA_MISMATCH 打回、逃生口永不可达。此顺序原实装碰巧正确但零测试锁定,本批补钉。

**复用模式承接（2026-08-31 补齐——原零承接,教条教了一个必被 SCHEMA_MISMATCH 打回的出口）**：CLI `submit_and_fetch_next --output '{"lack_of_info": "…"}'` 对 reason 步识别该形态,转 `failStep(kind='lack_of_info')` 不走 schema 校验——两模式同语义（复用模式无 KnowledgeProvider 通道,恒直接 fail,容器 retry/adaptive 照常接手;driver 可在重跑轮自行补材料——caller 有工具,这正是复用模式此通道弱需求的原因,但通道在场胜过教而不通）。

**最多补充 1 次**：避免检索-重试循环。补充后仍 lack_of_info 则走正常 fail 错误链（subtask retry/adaptive 可能从更高层级修复）。

---

> **doc-ref 模块已抽出**：`[[文档路径#章节名]]` 确定性知识引用(提取/切片/注入)+ 解析流程契约 `^anc-struct-doc-ref` / `^anc-exec-doc-ref-resolve` 已独立成 [[doc-ref]]（被 parser/validator/engine 多方调,应独立模块独立文档;早期误挂 dispatcher 是历史,解析实归 engine.assembleBasicContext）。

---

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
- **resume 注入通道（hopissues/0016）**：`dispatcher.resume` 对 `completeStep` 返回值**必须判读**——非 `ok`（SCHEMA_MISMATCH/INVALID_STATE/HOP_ENV_CREDENTIAL_REJECTED 等）时**不进 executionLoop**,返回 `{status:'paused', rejected:{code,message}}` 原样上传（与 CLI `submit_and_fetch_next` '出错不推进'同语义——修前无条件继续循环:被拒的 ask/confirm 步保持 running 被 dfs 跳过,直奔 exit 撞完备性闸,结构化错误被吞成 'No executable step found',排查方向彻底误导;run 被錘成 failed 终态,用户连重试机会都没有）。嵌套 call 帧的拒收同形上传（settleCallResult 前判 rejected 直接透传,帧保持挂起）。
- **复用模式**（无 Dispatcher）：`hopjit submit_and_fetch_next` 遇 SCHEMA_MISMATCH 直接返回 `{ status:'error', code:'SCHEMA_MISMATCH', message }`，步骤**保持 running、不推进**（[[exec-engine#^anc-exec-advance-to-caller]] 错误不推进）→ caller（CC）读 message 自行修正、重新 submit。缺省 3 次是**对 caller 的契约建议**（写入 message），引擎不强制计次——符合"复用模式信任 caller"（[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 第 4 条沙箱同理）。

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

**工具循环 tool_result 内容渲染【契约】** ^anc-exec-tool-result-render

（2026-08-27 fact-check 真机实撞——0032 首跑 8 个事实点全判 not_found,真因是引擎渲染不是检索失败）：无 body act 的 LLM 工具循环把工具结果注回 LLM 时，`tool_result` 块的 `content` 必须是**文本**（Anthropic 协议要求 string 或 content-block 数组）。而 ToolResult.result 有两种形态：字符串（binding 层原始 text），或**对象**——CompositeToolProvider 的 unwrap 解包与 output_schema 裁剪通过面返回的就是裁剪后对象（`content_type: 'json'`，见 [[tool-interface#^anc-exec-tool-shape-check]]）。契约：

- **对象结果 → `JSON.stringify` 序列化后注入**——与 formatInputs 对对象输入的既有渲染同一形态（LLM 消费面统一 JSON 文本）；
- **字符串结果 → 原样注入**（既有行为零变化）；
- **失败结果同规则**（错误面 result 按 binding 契约恒为字符串，但防御性同判——对象错误也序列化，不出 `[object Object]`）；
- **禁止 `String()` 直转对象**——产物是 `"[object Object]"`：工具明明成功返回了完整结构，LLM 收到的却是 15 字符占位符，只能如实报"结果不可解析"。失败形态极隐蔽：run 结构上全绿（工具 success、步骤 completed、终态 completed），败因藏在业务产出里（实撞：websearch-brief 的检索走 act body 通道②结果直落变量空间不经此渲染，同一工具面同一注册文件全好；fact-check 的检索走无 body act 通道④，每次调用都成功、每次注入都是 `[object Object]`，8 个事实点全判 not_found）；
- **同族第二消费点 = BodyInterpreter 的 TOOL_EXEC_ERROR 报文**（act-body-interpreter.ts，通道②的失败面）——失败 result 经 in-process 模块守卫（只核 success 类型不核失败面 result 类型）与宿主注入 provider 两个口子可为对象，报文受众是 FailRecord→replan 与人，占位符同样吃掉适配依据，同判 JSON 序列化（review 二轮抓的 String() 残留）。三处消费点（工具循环注入 / executeCallTool 失败报文 / TOOL_EXEC_ERROR 报文）判型三目逐字同形态。

> act/commit 的执行已结构化（hop_python body，见 [[act-body#^anc-exec-act-body-interp]]）：有 body 走 `BodyInterpreter` 确定性执行（无 LLM）、**跳过 SCHEMA_MISMATCH 算子级重试**（body 非 LLM 且确定性，重做产出一样的不匹配）；无 body 回退 `executeActWithTools` 的 LLM 循环（存量零回归）。算子级 SCHEMA_MISMATCH 重试本节落地范围＝无 body 的 reason/check/act + 复用模式 done 打回；工具瞬时失败重试归 ToolProvider 内部。
>
> **`[act free]` 角色档分道（2026-08-22 随概念 free 档新增,概念 [[../concepts/HopSpec V3核心规范#^anc-step-act]]）**：无 body 的 act 执行路径不变（executeActWithTools LLM 循环）,角色指引按 free 分道,**两条消费线同源**（prompt.ts `actRoleKind` 选档 + `roleGuideText` 取档文本——review 实抓初版只接了 hoplog 记录线,standalone 真实 API 请求零角色指引,free/非 free 请求逐字节同构,设计落空）：①**standalone 请求线**——executeActWithTools 把角色档文本注入 system 尾块（易变面,不碰稳定块缓存前缀;commit 步取 commit 档;**尾块=角色段单档,不含 L0 世界观本体**——buildSystemPrompt 已发过一份 L0,尾块再带整份即同请求重复发送,2026-08-31 作者对 probe hoplog 实抓该形态每请求多烧约 1.5K 字符）;②**hoplog 记录线**——engine recordStepStart 的 prompt 渲染同选档。**标 free**：任务执行档（**"自由"一词从执行 LLM 可见面退场**——2026-08-31 作者定"当然去掉,否则无法无天了":free 是相对非 free 档的机制词,投给执行 LLM 被读成"可自由发挥",与 L4 硬约束对拉,thinking 型模型的思考散文污染有其贡献;档文措辞="可以推理、可以拆解步骤、需要时可以使用工具;L4 的执行说明与输出约束是任务边界,不是参考建议"）,并明令禁止不可逆动作（free 不可作提交载体——作者钉"act free 不能有 commit 语义"）;[act free] 语法关键词照旧（作者面词汇,作者懂它对照带 body 的 act）;**未标 free 且无 body**：维持"确定性执行禁推理"档（B7 warn 促其补 body 或标 free——执行面不变,平滑过渡）。free 步骤工具面同 act（受控工具,requires_commit 拒）。 ^anc-exec-act-free-role

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

单输出步骤：全文即值——**但先做尾部自标签收窄**（2026-08-31 作者对打回轮基准实抓:deepseek 思考散文+尾部 `intro: 值` 行的形态,全文即值把思考连标签整段收进变量,脏值再被 check 核错对象、被打回轮当基准。形态契约作者定"思考可以写在前面,但产出必须以 YAML 键值收尾",L4 输出段渲染格式例教此形态——教的和收的同一契约:响应里存在顶格 `声明名:` 打头的行时,从**最后一个**该形态行起收值〔含其块标量延续行〕,其前散文弃;不存在该行照旧全文即值〔宽容底线,业务文本不巧含键名字样时取最后一个顶格行也符合"值收尾"契约〕）。**收窄认三种标签行后继形态**（第三种 2026-09-01 doc-review 第十四次验证实撞补——`templates_content:` 空值键行+缩进嵌套列表〔6 份模板 28KB〕,旧收窄只认块标量指示符与"行内值后无正文"两形态,嵌套子结构被判"形态含糊"原样返回,散文进值 → coerce 对散文+YAML 混合体 yamlLoad 必炸 → 字符串灌列表校验判非数组,三轮烧尽步 23;模型末轮已完全照做〔读回暂存件+顶格键块交付〕,败因纯在收窄面窄）:①块标量指示符（`|`/`>` 系）→ 收延续行剥公共缩进;②行内值且后无正文 → 收行内值;③**空值键行+全缩进子结构**（标签行后每个非空行都带缩进=嵌套映射/列表延续）→ 收子结构行剥公共缩进（产出字符串交 coerce 归一层 yamlLoad 成结构值,与既有 coerce 分工不变——收窄管切散文,coerce 管字符串→结构）。标签行后存在**顶格**非空行仍判形态含糊原样返回（顶格行=子结构已终结,后续内容归属不明,不做跨段猜测）。多输出步骤：**先按 YAML 文档解析**（剥可选围栏后 yamlLoad；对象且命中任一声明键 → 按声明键提取，缺键为 null）——LLM 对"多个命名输出"天然倾向 YAML 风格作答，块标量（`key: |` 换行缩进正文）必须正确取到正文。YAML 解析不成立时回退**逐行正则**。实撞案例：DeepSeek 对 coffee-week step 2 输出 `advice: |` 块——旧逐行正则把 `|` 字符本身当值，下游周报残缺、check 正确拦截、retry 耗尽。**围栏剥除认任意语言标签**（2026-08-24 coffee4 实撞——旧正则只认 ```yaml|yml,flash 交 ```json 剥不掉,yamlLoad 对围栏行必炸走回退;与 validator parseYamlStructure 同口径 `[a-zA-Z]*`）；**回退逐行认带引号键**（同案第二缺口——thinking 模型 text 被 max_tokens 掐成残 JSON 时 yamlLoad 炸走回退,而 `"seq_hit": true` 带引号键+缩进,裸 `startsWith('key:')` 不认→null;键匹配 `/^\s*"?key"?\s*:/`,值按命中长度切+剥引号。两缺口叠加=内容完好三轮全 null 烧尽子实例——DEBT-09 response 落账首次对证"模型交了什么 vs 引擎解成什么"定罪解析层）。提示侧口径同批统一（L0 角色档教 YAML,见 [[prompt-assembler#^anc-exec-l0-worldview-impl]] 第 5 条——教的方向与解析先验一致,宽容收 JSON 不变）。

**散文导语+围栏的围栏内容单解（2026-08-30 doc-review 首跑实撞——多输出提取对"散文+围栏"形态三连 null 烧尽）** ^anc-exec-output-fence-content-retry

LLM 高频形态"散文导语＋```yaml 围栏包全部输出键（内含嵌套映射）"在原提取链必死：围栏剥除正则是**原地去标记**（散文保留）→ 剥后文本=散文+裸 YAML 混合 → yamlLoad 对散文行必炸 → 回退逐行正则不认嵌套映射键（`doc_analysis:` 行内无值）→ null。实撞:doc-review 步 7,deepseek-v4-flash 三次产出内容完好（四问回答+七条脆弱点,质量佳）,引擎三次提取 null,SCHEMA_MISMATCH 烧尽整步——与 coffee4"内容完好三轮全 null"同病族,前两修（围栏标签放宽/带引号键）都没治到"散文残留炸 yamlLoad"这半边。契约：整文 yamlLoad 失败或未命中声明键后、落回退逐行之前，**取首个围栏块内容单独再试一次 yamlLoad**（散文弃）——命中任一声明键即按声明键提取返回;多围栏拼合不做跨块猜测照旧回退（二十五审钉不动;判据=剥除首个围栏块后剩余文本仍含围栏开栏标记——工程链 review 实证旧判据"捕获组内再现 ```"在懒惰非锚定正则下恒假守卫空转:两个规整围栏块时捕获组只含首块内容,首块含声明键的多围栏被单解采纳其余键置 null,劣于承诺的回退;旧判据是从单输出锚定正则语境抄来的,换语境失义）;围栏内容也不成 YAML 再走回退逐行。与单输出"签名围栏+散文弃尾"（^anc-exec-output-parse-self-labeled）同哲学：围栏就是"这块是值"的声明,散文是给人看的评注。

**值内前置引号片段的标量修复重试（2026-08-30 doc-review 首跑二撞——中文写作高频形态"键: "引号片段"接裸文"炸整文 YAML,内容完好三连判死）** ^anc-exec-output-quoted-prefix-repair

LLM 用中文写结构化内容时高频产出这种行：`risk_point: "陶寺=尧都"是证据链推定而非定论：…`——值以带引号的片段开头、引号闭合后又接裸文本。这在 YAML 文法里是非法标量（引号开头的值必须整值被引号包住）,一行即炸整文 yamlLoad。实撞:doc-review 步 11（单输出 [yaml] 列表）,模型第 2/3 次输出肉眼完好（10 条风险点,质量好）,就因两三行这种形态整文解析失败、恢复阶梯"YAML 解析失败=真散文放弃恢复"直接弃,SCHEMA_MISMATCH 三连烧尽。与围栏病族（^anc-exec-output-fence-recovery / ^anc-exec-output-fence-content-retry）同属"内容完好、提取层判死",但病灶在值内文法不在包裹形态。契约：恢复阶梯的 YAML 解析失败后、放弃恢复之前,做**引号前缀行修复重试**——逐行找 `键: "…"裸文` 形态（正则:值位以 `"` 开头、闭合引号后**紧邻**非空白字符——取严不含"引号后空格再接文字"形态:紧邻要求同时保护了 `k: "a" # comment` 这类合法行不被误重包;空格间隔的非法形态不修复,如实走原失败路径）,把整值重包成合法带引号标量（内部引号转义）,修复后再试一次 yamlLoad;修复只动命中行,其余行原样;二次解析仍失败才判真散文放弃。四处 yamlLoad 解析点一个修复原语（同病同治）：①恢复阶梯②档（validator recoverOutputValues——声明输出的字符串值恢复）;②parseYamlStructure（validator——yaml 型 checkValue 与 coerceOutputValues 共用判据面;**注意语义**:修复接入此处=yaml 类型校验的采纳面同步放宽,含引号前缀行的字符串值修复后能过 yaml 型校验,这是有意的行为面变化不是实现细节）;③④dispatcher 多输出路径的整文与围栏内容两处（经 yamlLoadWithRepairImpl）。

**散文导语+裸 YAML（无围栏）的尾部键块单解（2026-08-31 doc-review 第十次验证实撞——提取病族第三形态,多输出侧补齐与单输出"尾部自标签收窄"同款契约）** ^anc-exec-output-tail-yaml-retry

LLM 第三种高频形态："[thinking] 思考散文＋**裸 YAML 键值块**（无任何围栏）"。原提取链必死：整文 yamlLoad 被散文行炸掉 → 无围栏,围栏内容单解（^anc-exec-output-fence-content-retry）不适用 → 回退逐行正则不认嵌套映射键（`search_results:` 行内无值,块结构在后续行）→ null → 宽容度条款把 null 归一空列表,**业务面静默空转无一处报错**。实撞:doc-review 第十次真机验证步 10,deepseek-v4-flash 4 次 web_search 全成功后交出 9 条结构化对标结果（title/url/summary 齐全,含直接对冲文档核心论断的证据）,形态=[thinking] 散文两行+裸 YAML;引擎解 null 归一 [],下游风险清单退化成"对标无结果"元提示——数据在 work_zone 落盘件里,变量流里没有。同 run 早前步骤 domain_candidates 同形态同死,一 run 两撞。

契约：多输出提取链在整文 yamlLoad 失败（或未命中声明键）、且围栏内容单解不适用（无围栏）后、落回退逐行之前,做**尾部键块单解**——找**首个顶格 `<声明键>:` 打头的行**（任一声明键命中即可）,从该行起截到文末,对这段单独再试 yamlLoad（经引号前缀修复原语,与其他解析点同罩）;解出对象且命中任一声明键 → 按声明键提取返回;仍不成 YAML → 照旧回退逐行。**与单输出"尾部自标签收窄"同一形态契约**（"思考可以写在前面,但产出必须以 YAML 键值收尾"——作者 2026-08-31 定,L4 输出格式例教的正是此形态）:单输出从最后一个自标签行收,多输出从首个声明键顶格行收（多键块内的后续键是内容不是新起点,取首不取尾）。散文行含键名字样不误触:判据是**顶格**（行首零缩进）+键名+半角冒号,思考散文里的行内提及不在顶格位。三形态阶梯全景（围栏内容单解→引号前缀修复→尾部键块单解）覆盖"散文+围栏"/"值内引号片段"/"散文+裸 YAML"——共同哲学:内容完好时提取层不判死,形态修复尽头才认真散文。

**长输出请求超时随 max_tokens 缩放** ^anc-exec-nonstreaming-timeout

**输出预算解析（按模型上限发,产出约束归 spec）【契约】** ^anc-exec-output-budget

（2026-08-27 作者定"按 LLM 的上限去设置,Ln 门限自己控制"——fact-check 真机实撞:16384 旧缺省对推理型模型两头紧,thinking 烧满全池正文零字节 OUTPUT_TRUNCATED,retry 白烧两轮;"给引擎设小池防费用"是弱模型时代的姿势,按用量计费下压池只制造截断不省钱）。max_tokens 解析链（specific→general 第一命中生效）：

1. env `HOPJIT_MAX_OUTPUT_TOKENS`（显式覆盖恒最高）
2. `resource_limits.max_output_tokens`（run/宿主级显式配置）
3. **provider 声明 `max_output_tokens`**（ProviderEntry 可选字段,schema [[shared-providers#^anc-config-standalone-schema]]——按当次请求路由到的 service 取;standalone 注入面经 `{SERVICE_ID}_MAX_OUTPUT_TOKENS` env 快照透传,与 BASE_URL/PROTOCOL 三键同族）
4. 内置缺省 **32768**（2026-08-27 从 16384 抬升——16384 是 8 月中弱模型时代定的,推理型模型 thinking+正文共池下太紧;各主流模型输出上限已在 32K-64K 档,缺省不该替模型收窄）

**原则**：引擎的 max_tokens 是"物理上限",不是"产出配额"——产出多大由 spec 各步骤的输出声明（Ln 门限）约束,LLM 自然按需产出,上限只防失控。**`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 从链中摘除**（2026-08-27 同批——该 env 的语义是"CC 宿主管自己 agent 的输出",引擎捡它=主对话 agent 的设置泄漏给引擎:用户压 CC 输出省帐,standalone 提取步跟着被压烧穿;同名变量跨两受众是误配面,0.x 干净摘）。

**观测**：HopLog llm 块记当次请求的 `max_tokens`（观测记录点在事实边界——发送口抄实际请求参数;实撞:烧穿排障时"上限是多少、哪级来的"只能翻代码答）。

（2026-08-18 buildtest 实撞——输出预算升 32768 后 SDK 拒发）：Anthropic SDK 对非流式请求按 max_tokens 估算耗时（`max_tokens/128000 × 60min`）,超 10 分钟且 **client 级 timeout 未设** → 抛 `Streaming is required for operations that may take longer than 10 minutes`（预检拒发,请求根本没出网——engine 层收到的是步骤 fail）。**预检只看 client 构造 `_options.timeout`,per-request 第二参不进预检判断**（v0.8.7 首修落在 create 第二参=修错层,复跑实证同错;SDK 0.111 源码 `timeout = this._client._options.timeout; if (!body.stream && timeout == null) → 预检抛`）。契约：**两处 `new Anthropic({...})` 构造点**（defaultClient/getClientForService per-service）**显式给 client 级 timeout**——`max(10min, resolveMaxOutputTokens()/128000 × 60min)`,与 SDK 估算同式（缺省 32768 换算约 15.4min——2026-08-27 缺省抬升随更,^anc-exec-output-budget;大预算按同一换算放宽,client 级已设即跳过预检。注:client 级 timeout 用全局解析不带 serviceId——provider 声明更大上限时实际请求可能超此换算,属已知宽松边,撞到再收）;create 第二参的 per-request timeout 保留（真实 HTTP 超时按请求精确,与预检解锁分层不冗余）。不引入流式（IR 形状不变,mock 面零迁移）；openai 协议路径无此预检不涉。

**空响应响亮失败** ^anc-exec-output-empty-loud

（2026-08-31 doc-review 第十二次验证实撞——正常收尾的空响应静默过关）：LLM 返回空文本（步 20 推定领域名,response=""、output_tokens=9 全为空白,stop_reason 正常收尾）,单输出路径 `text.trim()` 得空串照常收为值 → `domain_name: ""` 状态 completed 零重试零报错,空串灌进下游步 21 拼出 `DocReviewers//reviewers` 残路径。截断闸（^anc-exec-output-truncation-loud）只认 `stop_reason === 'max_tokens'`,正常收尾的空响应没有任何闸——这是输出提取病族第四形态（前三形态是"内容完好提取层判死",本形态相反:内容真缺提取层放行）。契约：parseStepOutput 截断判之后、取值之前,判 `text.trim()` 为空 → **抛 EMPTY_OUTPUT 响亮失败**（消息说明响应全空、含 output_tokens 实数）——反馈归因正确（"你没产出任何内容"恰是事实,与截断场景的错误归因相反）。**步级重发半边（2026-09-07 hopissues/0072 实撞后兑现——首版条款写"触发既有重试通道"但实现落进 executeStep 大 catch 直接 failStep 点燃容器:check 步瞬时空响应被当判 false 整容器重跑,叠加聚合账不清零自激死锁,hopkb 309 实例 3 例好实例报废）**：EMPTY_OUTPUT 属瞬时模型抖动（output_tokens 个位数的空喷,重试即愈——与 SCHEMA_MISMATCH 算子级重试同哲学同层）,**步骤执行层的每一个模型调用口**都经空响应重发包装（replan 流水线不属步骤执行,自有 ADAPTIVE_PIPELINE 闸不在本罩）（2026-09-07 作者拍"全口径罩"扩——原形态只包 handleStepReady 首发,同步骤内 SCHEMA 重试轮与 lack_of_info 补检索重发直调 executeStepWithTimeout,撞空响应仍一发点燃容器,0072-review 面二实抓两扇留窗;三口全包后无死角）：包装识别 `EMPTY_OUTPUT:` 前缀走**步级重发**（拦在"落 failStep 的大 catch"之前——网络暂停等其它异常原样穿透归各自通道）;**计数口径=每个调用口独立**(各自 EMPTY_RETRY_MAX 次——空响应是瞬时抖动,与外层处于第几轮 schema 重试无关,共享池会让先撞的口子吃光后撞口子的自救额度);**instruction 三出口全复原**（成功/非 EMPTY 异常/耗尽——提醒残留会成为后续重试轮的错误归因基线,包装捕获的 baseInstr 是进入时版本〔SCHEMA 重做口进入时已含反馈,复原到反馈版恰是正确语义〕）：instruction 附一行"上一次响应为空,请完整产出"防同因,重发 executeStepWithTimeout,至多 EMPTY_RETRY_MAX=2 次（首发+重发共三次,与 SCHEMA_RETRY_MAX=3 对齐）;耗尽才 failStep 转容器级 retry（闸不软化——空响应仍然一个都收不下,变的只是"收不下之后先自救再上报"）。paused 属 executeStepWithTimeout 的正常返回值不是异常,同样原样穿透包装层（不重发不计数）;每次重发落一条 recordWarn `[empty-retry]` 留痕（重发是异常处置,观测轨迹不可缺）;本闸与步级重发均属独立模式 dispatcher 的产出消费链,复用模式的产出把关归 caller（与 ^anc-exec-operator-retry 的模式分工同构）。body 步不经 LLM 无此形态天然不涉。边界：只拦"整个响应文本为空/纯空白"——模型显式产出 `键: ""` 空值属合法产出照常收（空串可以是业务值,全空响应不是）;多输出路径同罩（全空文本走到回退逐行全键 null,列表宽容度条款会把 null 归一成空列表,业务面同样静默空转）。

**输出截断响亮失败** ^anc-exec-output-truncation-loud

（2026-08-18 buildtest 实撞——静默截断产出错误归因反馈）：`stop_reason=max_tokens` 表示输出被上限掐断（thinking 型模型可把全部输出预算烧在推理上,text 空——实撞:v4-pro 16384 tokens 全 thinking,node_result="" 被当正常值收下,下游 validate 报"片段为空",重试反馈教模型"你没产出"=错误归因,同因必死）。契约：解析输出前先判 `stop_reason === 'max_tokens'` → **抛 OUTPUT_TRUNCATED 响亮失败**（消息含实际 output_tokens 与上限、指路 `HOPJIT_MAX_OUTPUT_TOKENS`/`resource_limits.max_output_tokens` 调参）——部分产出也不收（截断值是残值,收下=毒值下游）;openai 协议 `finish_reason=length` 已映射同值同治。**覆盖面=全部 LLM 响应消费点**：parseStepOutput（reason/check/act 终轮）、pipelineCall（replan 三段——二十五审抓:绕过 parseStepOutput,截断半截产出静默入 replan）、**工具循环带 tool_use 的轮次**（二十六审抓:掐在工具参数生成中途时半截参数会被直接拿去执行工具——write 类工具吃残缺参数比收残值更危险,判在工具执行前）。与守卫『禁止静默跳过』同根：预算不够是环境问题,须显式失败指路,不许装作模型没干活。

**烧穿疑似反刍,报文分流+留档线下（hopissues/hoplogic3/0060,2026-09-01 作者定轻量案"thinking 爆了直接报 thinking 异常,可能是反刍,留档线下分析即可"——弃流式检测〔动非流式既有架构不值〕;2026-09-02 二批重修:reopen 主诉 in-band 形态+留档静默失效+确定性口袋漏配+死站点删除+封顶口径写实,五面一批）**：两个截断站点（parseStepOutput 主闸、replan 流水线段）在抛错前做零成本判定,命中两形态之一即报文换 `THINKING_EXHAUSTED` 前缀并留档：
- **形态①正文全空**（thinking 通道烧穿——预算全烧推理块,零可见产出）：`stop_reason=max_tokens` 且可见正文 text 为空/全空白;
- **形态②正文高重复（in-band 反刍,二批扩——reopen 主诉）**：正文非空,但尾窗重复度越阈——非思考模式模型把反刍循环写在可见正文里（hopkb r21 实录:deepseek-v4-flash "让我重新审视" 1330 次灌满 65536,首批只判①把它放走照旧教"调大上限"）。判据=零成本纯字符串统计（`isHighlyRepetitive`）:尾窗 4000 字符按 32 字符切片,统计切片在其之前文本已出现的比率,>50% 判高重复;阈值保守（实录形态数量级越阈）,长排版正文不误触（反例钉）;常数权威=代码,本条款记语义。
两形态报文各自写实（①"正文为空"/②"正文被高度重复的循环文本填满〔in-band 形态〕"）,共同尾句:可能是思维反刍循环（常见诱因:判据/约束互相矛盾制造两难）,全文已留档 hoplog,调大上限对反刍无效。**有 tool_use 块恒不碰**（产工具参数被掐非反刍）;**工具循环轮不设分流站**（二批删——该站前提 hasToolUse=true 而分流对 tool_use 恒不碰,调用结构性空转;终轮无 tool_use 响应归 parseStepOutput 闸接住,覆盖面无洞）。正文非空且不重复的截断照旧 OUTPUT_TRUNCATED（真超限,指路调参对症）。**留档**：命中时响应全部内容块可见序列化全文经 `HopLog.recordRuminationSuspect` 落**文档级顶层块**（不过孤儿守卫——命中时点在截断抛错前,步级归属不可靠;二批修:首批经 recordStepMeta 传空步骤号被孤儿守卫拒收,留档静默失效而报文谎称已留档,mock 测试无守卫假绿未抓,review 探针实证）;**每 dispatcher 实例留档上限 5 份**（二批口径写实——父与 parallel 各子实例各自计,子实例写各自 hoplog 按文件计;超出只记一行计数 warn 不存全文;防连环反刍灌爆）。**报文尾句如实跟随留档实况**（三分支:已留档/封顶未存〔指路前 5 份〕/hoplog 未开启未留档——报文不许在未留档路径上谎称已留档,首批同病阅卷实抓）。**失败语义 deterministic**：THINKING_EXHAUSTED 前缀入 engine 确定性判据（二批补——首批只写承诺未配判据,实走满阶梯重试,反刍场景每轮烧满上限,review TE-2 实抓）,同输入重发大概率原样反刍,不烧重试预算。**不做引擎侧自动反刍终判**——报文只说"可能",是不是反刍归线下人对着留档判;重复度判据是分流触发器不是终判。**变招重试:检出即记名,该步后续重试轮 thinking 强制 disabled（三批,2026-09-17 R4 实撞——同一构建 run 内 THINKING_EXHAUSTED 13 次×烧满 65535 正文全空 ≈85 万纯废 token:免预算重试保住了预算账,但重试请求与首跑参数完全同源〔resolveModel 无 per-retry 覆盖〕,反刍绑定输入形态,同型请求反复撞;check 判官步恒不吃 L5 重试反馈〔A 案〕,其重跑是逐字节同输入,不变招=保证再反刍）**：dispatcher 持步号集合,checkThinkingExhausted 命中且有步号即记名;buildApiRequest 装配时步号在册 → thinking 强制 `{type:'disabled'}`（覆盖 route 声明与端点缺省——正文都写不出来时先降档保底拿产出,推理质量其次;deepseek anthropic 协议端点两值实测认,openai 协议 thinking 参数本就静默丢弃零影响）。记名 sticky 到 dispatcher 实例生命周期(该步此后恒降档——反刍绑定的是该步的输入形态,形态不随轮次变);replan 流水线段无步号不记名(自有 ADAPTIVE_PIPELINE 通道)。act 工具循环 thinking:disabled 打转的 2026-08-20 反证不与本条冲突——那是"全程禁"的路由配置面,本条是"烧穿后的止损降档",前提已是该步带 thinking 跑不出正文。 ^anc-exec-thinking-exhausted

**单输出自标注剥壳** ^anc-exec-output-parse-self-labeled

（2026-08-18 buildtest 实撞——单输出路径"全文即值"是包裹症盲区）：LLM 对单输出步骤也常把输出 echo 成 YAML 键形态（整包 ```yaml 围栏 + `<输出名>: |` 块标量——deepseek 系高频,提示词"裸文本直出"治不住）,单输出路径原样收下 → 围栏与标签进变量,下游机械消费（如 validate 工具）parse 错。契约：单输出取值前做**自标注剥壳**——①整包围栏（首行 ` ``` `/` ```yaml `、尾行 ` ``` `）先剥两端行；②剥后首行恰为 `<输出名>: <指示符>`（块标量指示符）→ 收余行剥公共缩进削尾空行为值；首行为 `<输出名>: <单行值>` 且无余行 → 取单行值。**签名围栏块+散文形态同剥**（三十八审 flash 实撞收窄,三十九审扩导语位——签名块前的散文导语同弃;`围栏自标注块+收尾围栏+评注散文` 形态原按"围栏须包整文"放弃剥壳,壳连散文逐字节进值落盘,5.4 反馈诊断准确但 flash 输出习惯治不住,重试打转到超时;签名在场即无歧义:首围栏内首行 echo 了输出名 → 收**围栏内**为值经②路径,围栏后散文尾巴弃——签名声明了"这块是值",尾巴是评注）。**非自标注形态原样零变化**（围栏可能是业务内容,只认"首行 echo 了输出名"的无歧义签名；`<名>: 值` 后还有多行=形态含糊,不碰；**无签名的多围栏块拼合不剥**——首尾正则会跨块误捕〔捕获组内再现 ``` 即多块〕,把中间散文与围栏标记收进值,二十五审探针抓;有签名时按上条收首围栏块）。与多输出 YAML 主路径的键提取对称。

**回退路径的块标量兜接** ^anc-exec-output-parse-fallback-block

（2026-08-18 buildtest 实撞——同一失败模式在回退路径复活）：LLM 输出 `key: |` 后正文**顶格不缩进**（markdown 正文天然顶格）→ 整文非法 YAML → yamlLoad 抛错走回退 → 逐行正则再次把 `|` 当值（毒值污染下游整条链：buildtest 中 skill_content='|' 致 header_final 全 `__UNKNOWN__`、构建循环空转到 retry 耗尽——check 拦不如源头取对）。契约：回退正则取到的值若恰为块标量指示符（`|`/`|-`/`|+`/`>`/`>-`/`>+`）→ **收块**：从该行之后收集后续行直到下一个声明键行（`^<其他声明键>:` 顶格）或文末，剥公共缩进、削尾部空行，块文本即值；值非指示符时按原样单行取值（既有行为零变化）。指示符孤行真是业务值的概率可忽略（YAML 语境里 `|` 孤行本就不是合法标量写法）。

**temperature 拒收自适应（2026-08-06 真机实撞）**：部分 Anthropic 兼容端点的新模型**拒收 temperature**（DeepSeek deepseek-v4-flash 返回 400 invalid_params "`temperature` is deprecated for this model"）。callLlmWithRetry 识别此错误（400 + 消息含 temperature）→ **剥除 temperature 立即重试一次**（同请求、不计入退避重试次数）；剥除后该端点整个 run 期免传（记 per-client 标记，避免每步都 400 一次）。语义代价可接受：这类模型不支持温度即意味着服务端固定采样策略，传与不传行为一致。

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

**构造期接线义务**：Dispatcher 构造函数装配完 CompositeToolProvider 后必须调 `engine.setToolDefsSource(provider)` 把工具注册面交给引擎——这是 L4 工具清单在独立模式渲染真身档的唯一料源；worker 经 `sharedToolProvider` 注入复用父 provider 时同样接线（接的是父 provider、接到各自的子引擎上——每个子 Dispatcher 构造点都有自己的 childEngine，清单与下发面同源不随注入支路变）（契约与禁令细节见 [[prompt-assembler#^anc-exec-tool-manifest-source]]；漏接=独立模式清单恒落复用模式通道指引档，2026-08-31 真机实抓）。

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
| 网络超时 | — | API_TIMEOUT | 指数退避重试最多 **6 次**,退避封顶 60s（1s→2s→4s→8s→16s→32s,总耐受约 2 分钟——v0.14.1 A 半边,dr17 实撞:旧 2 次×短退避总耐受 3 秒,1 分钟网络中断 43 秒烧穿全树）。耗尽走**网络暂停**（B 半边,见下——不 fail step）。 |
| 网络错误 | — | API_NETWORK_ERROR | 同上（timeout/network 同档同待遇）。 |

**网络类失败上传时挂可读前缀（2026-08-23 作者定"同意"——dr10 实撞两处 `reason: terminated`:undici fetch 断流的原始文案直接落 FailRecord,经 L2c 塞给下一轮 LLM——"上次失败原因:terminated"零信息量,LLM 会试图"修正"一个网络故障;走查者也分不清内容失败与环境失败）**：executionLoop 兜层把步骤失败原因写进 failStep 前,`classifyError` 判 `network`/`timeout` 的错误文案改写为 `NETWORK_ERROR: 网络中断（非内容问题——与产出质量无关,原文: <原文案>）`。**分类兜底按文案识别裸网络异常（2026-08-24 D61,dr14 实抓——`classifyError` 只认 SDK 错误类 instanceof,但 SDK 只包装"请求发起阶段"的错误;流读取中途断的 undici 裸 TypeError〔`terminated`〕不经包装直接穿透,落 `other` 档=0 重试+原样抛,裸文案再次进 FailRecord——D58 前缀被绕过,dr14 一子块判定器就此烧掉走兜底。探针实证:连接拒→APIConnectionError 正确归 network;流中断→裸 TypeError 漏网）**：两协议 classify 的 `other` 兜底前,message 命中 undici/Node 网络文案集（`terminated` / `fetch failed` / `socket hang up` / `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `EPIPE`,完整词或错误码形态精确匹配——不裸含子串防误伤业务文案）→ 归 `network` 档,获得 2 次重试与耗尽挂前缀的完整待遇。**网络暂停（B 半边,v0.14.1 2026-08-25 作者定 A+B——dr17 实撞:1 分钟网络中断,NETWORK_ERROR 被当普通步骤失败吃容器内容重试预算,CalleeFailure 逐层上炸,顶层三连发间隔 7-8 秒无退避全秒死,43 秒烧穿 run failed 整树报废;网络类失败与产出质量无关,烧内容预算是把'必活'〔等一等就好〕当'必死'处理）** ^anc-exec-network-pause：API 层网络/超时重试耗尽后**不进 failStep**——executeStep 的 catch 识别 `NETWORK_ERROR:` 前缀,把该步状态回置 pending（与 crash-recovery 的 running→pending 同语义:步骤未产生任何效果,重执行安全）,persist 后向上返回 `paused`,`pause_reason: 'network'`,载荷携 step_id 与网络错误原文。三条通路：

- **主线**：executionLoop 收到 network paused 即返回 caller——run 转 paused,状态全在盘,树不报废;
- **call 递归**：子 Dispatcher 返回 paused 走既有 callFrames 冒泡通道（与 ask/confirm 同款,pause 形态通用不分 reason）,逐层上浮到顶;
- **恢复**：`resume_run`/resumeSpec 对 network 暂停**不需要 answer**——回置 pending 的步骤经 next_step 自然重派,网络恢复即续跑（mcp-server 对 pause_reason=network 的 resume 走 resumeSpec,忽略 answer 载荷）。**跨进程一路（33 轮 review 探针实抓补通）**：detach 后新进程 resume 走 restoreRun,其预检原只认 confirm/ask——网络暂停步是普通步（reason/act）被拒死,断网暂停的 run 跨进程永远续不了;预检按免答通道同判据（exec_events 有 network_pause 记录且该步 pending——事件随 state.json 持久化,跨进程可判）放行。

**范围注记（v2 2026-08-25 作者定 b 案——review B1-1 实抓 v1 注记与代码赋值链不符）**：网络暂停门按子实例形态分两路——

- **parallel subtask worker**（`worker: true`,launchParallelSubtask/crash 重建两处传入）：门不开,网络耗尽仍 failStep,父层收割/stale 对账兜底（worker 是同 spec 子树收窄,重跑成本低）;
- **parallel call 子实例**（launchParallelCallChild,不传 worker）：门开——子实例网络耗尽转 paused(network),父层按 U4b HITL 队列入队（^anc-exec-parallel-hitl-queue）,不占名额等 resume;网络恢复后 `resume(childInstance=<子实例>)` 经队列路由到子 dispatcher 的免答通道续跑,子树不报废（call 子实例是完整 spec 实例,重跑成本高——与主线 B 半边同一保护哲学;v1 注记误写"parallel 路径一律 failStep",实际 call-parallel 赋值链从未传 worker,行为本就是入队——b 案承认该行为为设计内并补测试钉死）。

旧条款"网络失败不占带反馈重跑名额"的 L2c 文案半边保留（防 subtask worker 路径与历史 state 里的存量 NETWORK_ERROR 记录）。
| 认证失败 | 401 | AUTH_FAILURE | **不重试**，立即 abort 整个 run_spec。密钥问题无法通过重试修复。 |
| 上下文溢出 | 400 | CONTEXT_OVERFLOW | **不重试 API 调用**。按路径分治：reason/check 单发路径捕获后调用 `PromptAssembler.reassemble_aggressive(context)` 激进压缩，重试 API 调用 1 次；工具循环路径走压缩降级（见 [[#^anc-exec-toolloop-ctx-degrade]]）。两路径二次仍溢出都以 `CONTEXT_OVERFLOW:` 前缀 fail step——该前缀入确定性不重试口袋（[[exec-engine#^anc-exec-deterministic-no-retry]]），容器 retry 不原样重跑。 |

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
      delay = base_delay_ms * 2^(attempt - 1) + random_jitter(0, delay * 0.1)
      sleep(delay)
```

### 与上层 retry 的交互

API 层重试和 subtask 级 retry 是两层独立机制：
- **API 层重试**（StepDispatcher 内部）：处理瞬时网络/服务故障，对 Engine 透明——步骤要么成功完成，要么以最终失败状态到达 `hopjit submit_and_fetch_next/fail`
- **subtask 级 retry**（ExecutionEngine.fail_step）：处理步骤逻辑失败（check 失败、LLM 输出不合理等），触发重跑或 adaptive replan

API 错误不回传到 Engine 的 fail_step 除非 API 层重试全部耗尽——此时步骤以最终失败状态进入 fail_step 流程。

---

## 工具循环上下文压缩降级【契约】 ^anc-exec-toolloop-ctx-degrade

**缘起（hopissues/0070，run 18a2214d，2026-09-04 立）**：MCP 独立模式引文核实任务，deepseek-v4-flash（1M 窗），step 2.1 读 11 篇原文后 cumulative 1.4M，step 3.1 再读 11 篇请求 1.05M 超墙 API 400；重试四连撞且请求只增不减（1.05M→1.08M——每轮重试追加失败反馈，行李越背越重），retry 耗尽 run failed，烧 6.2M tokens 零产出。三个窟窿：①工具循环对 context_overflow 零捕获（reassembleAggressive 只挂 reason/check 单发路径，而工具循环的 tool_result 累积正是撞墙主形态）；②overflow 不在确定性不重试口袋里，容器 retry 原样重跑必然同因更大；③引擎不认识模型窗口，逼近墙没有预检。本条款管窟窿①③，窟窿②归 [[exec-engine#^anc-exec-deterministic-no-retry]] 口袋清单（本次同批补入 `CONTEXT_OVERFLOW:` 前缀）。

### 触发两档

1. **预检档**：工具循环每轮发送前，若 `resource_limits.max_context_tokens` 有配置，粗估 messages 总字符量 ÷ 4（字符转 token 的粗折算）超过 `max_context_tokens × 0.8` 即先压缩再发。该键缺席则跳过预检——向后兼容，不配就只保留撞墙补救档。该键由此兼作模型窗预检线（原语义"PromptAssembler 上下文预算"保留，两用途同源：都是"引擎认识的上下文上限"）；
2. **补救档**：`callLlmWithRetry` 抛出且 `classifyError` 判 `context_overflow` 时，若本步尚未压缩过，压缩后重试一次。

### 压缩形态：任务相关摘要，不是机械剪切

作者拍板原话（2026-09-04，hopissues/0070 对焦——首版"机械剪切换一句已读"被作者否）：**"换成一句已读过没意义，不在 prompt 里的对 LLM 就是没看过，应该换成和本任务相关的摘要，其他的在文件里。"**

压缩规则：

- **范围**：messages 里 user 消息中的 tool_result 块，**跳过最近 2 轮**（尾部两个 user 消息——近轮是 LLM 正在操作的现场，动它等于抽掉手里的工作台）；只压 content 为字符串且长度超 16000 字符（≈4000 token）的块——短块压缩收益低于一次压缩调用的成本。**估算边界（与压缩范围同宽,对称成立）**：estimateMessagesChars 对非字符串 content 的 tool_result 块计 0——当前引擎工具执行链恒产字符串 content（dispatcher 工具循环 rendered 恒 string），多 block 形态实际不可达；将来若改工具结果产出形态，估算与压缩两处须同步扩（0069-0070 批 review 面二探针实证记档）；
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

**SDK 隐式 env 读取必须切断**：Anthropic SDK 构造器缺省自读 `process.env.ANTHROPIC_AUTH_TOKEN` 作 `authToken`，且 authToken（Bearer 头）**优先于显式传入的 apiKey（x-api-key 头）发出**——上面整条加载顺序会被 SDK 自己捡的宿主 token 静默盖掉（2026-08-10 真机实抓：级 0 修复后 401 仍报宿主 token 尾号，defaultClient.apiKey 明明正确）。故**所有 `new Anthropic({...})` 构造必须显式 `authToken: null`**，凭证只经 resolveCredential/getClientForService 解析后显式传入；需要 Bearer 形态时（级 1 的 ANTHROPIC_AUTH_TOKEN）也由解析层显式传 authToken 字段，不留任何隐式通道。

### 安全约束

- 密钥**禁止**通过 CLI 参数传递（`ps aux` 可见）
- 密钥**禁止**写入 `.hopstate/` 目录（可能被 git 追踪或 iCloud 同步）
- 密钥**禁止**在 HopLog 中出现（StepDispatcher 记录 API 错误时脱敏处理）
- 多服务支持时，按 `{SERVICE_ID}_API_KEY` + `{SERVICE_ID}_BASE_URL` 模式扫描环境变量（见多模型路由章）

配置文件中的 provider 凭证只写 `api_key_env`，由配置加载层解引用后以 HostConfig 内存注入；Dispatcher 不直接读取任何配置文件 key。

---

## 多模型路由【契约】 ^anc-exec-model-routing

StepDispatcher 支持多 LLM 服务路由：不同步骤可路由到不同模型（如 reason→DeepSeek, check→Claude），实现成本优化和交叉验证。

**thinking 路由**（2026-08-20 作者拍板形态 B——与模型分档同维度的第二旋钮）：`routing_rules` 每条可选 `thinking: enabled|disabled`——命中该类别的请求带 anthropic 协议 thinking 参数（`disabled` 发 `{type:'disabled'}`;`enabled` 发 `{type:'enabled', budget_tokens: max_output/2}`;**缺省 undefined 不发参数吃端点缺省,存量零变化**）。动因：推理型端点（deepseek-v4-flash 等）缺省开 thinking,机械含量高的步骤边际价值远低于烧掉的预算与延迟（重档实录:90% output_tokens 是 thinking,16384/65536 双档 OUTPUT_TRUNCATED 第一凶手;`thinking:{type:'disabled'}` deepseek 端点实测认——同题 15 tokens → 1 token）。commit 无专条吃 act 条时 thinking 随整条继承（同 service/model 半边）。加载期文法核:枚举外值拒（静默失效是 0008③ 同病）。**budget 下限夹 1024**（anthropic 协议最低值——小预算+enabled 组合原发 750 违约 400,四十六审探针抓;上限夹 maxOutput-1 防倒挂）。两级合并按 step_type **整条覆盖**（项目级同类别条目不写 thinking 则系统级的 thinking 随条消失——与 tool_servers 同名整体替换同一语义,项目级写全该条）。openai-chat 适配器暂不透传（该协议无对应参数,静默忽略即正确——thinking 是 anthropic 协议概念）。**使用判据（真机反证记档 2026-08-20）**：disabled 只该用在'一次性直出且模式固定'的调用面——**无 body 的 act/commit 是自主规划的多轮工具编排,恰需推理,禁配 disabled**（实撞:act disabled 下 flash 步骤2〔读原文落盘,此前 6 工具即完〕工具循环打转 20 轮 MAX_TOOL_ITERATIONS 耗尽,run 终局——thinking 省预算的收益在规划型调用面倒挂为致命退化）;带 body 的 act/check 引擎直执零 LLM 本就不发请求,配了无义。hopbuild 场景结论:无安全的 disabled 面,hopjit.yaml 留端点缺省;机制保留供确有把握的场景（如纯格式转换的 reason 步）。 ^anc-exec-thinking-routing

**协议面**：wire 协议双档 `anthropic` | `openai-chat`（v0.7.0 起,per-provider 声明——协议适配层见 ^anc-exec-protocol-adapter;`openai-responses` 枚举预留未实装）。Anthropic 格式后端（DeepSeek `api.deepseek.com/anthropic`/代理网关 zenmux/oneapi/litellm）经 `base_url` 切换;OpenAI 兼容端点走 openai-chat 适配器（LLM 工具循环暂不支持,fail-fast 指路）。

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

（2026-08-12 作者定：加入 openai 协议支持；LLM 工具循环协议映射当下不做——非分期承诺，进展中看实际需求再议。）

**定位**：standalone 的 LLM 调用出口按 provider 的 wire 协议分派（anthropic/openai 两形态）。**Anthropic 消息形状是引擎内部表示（IR）**——dispatcher 全部内部签名、HopLog 记账、测试 fixture 都用它；协议差异被压在适配器一层，openai 适配器做双向转换，anthropic 直通零转换。

**能力契约（HopTrait）**：

```
# Spec: 协议客户端
Id: protocol-client
Goal: 按内部 IR（Anthropic 消息形状）发起一次 LLM 调用并返回 IR 形状响应；错误归一为类别枚举
Inputs:
- request: yaml   # IR：model/system(顶层字段)/messages/max_tokens/temperature/tools?
Outputs:
- response: yaml  # IR：content:[{type:'text',text}]/usage:{input_tokens,output_tokens}
Constraints:
- classifyError(err) → 枚举 rate_limited/server_error/timeout/network/auth/context_overflow/temperature_rejected/other——dispatcher 重试策略按类别分派，不再 instanceof SDK 错误类
- 构造时显式传 apiKey/baseURL，切断 SDK 隐式 env 读取（openai SDK 自读 OPENAI_API_KEY 同 anthropic SDK 自读 AUTH_TOKEN——standalone 不变量 2"显式压过隐式"，401 实撞同型预防）
```

**类型约定（HopType）**：

```
struct: ProtocolClientHandle
  Id: protocol-client-handle
  Fields:
    - protocol: line  # 枚举 anthropic/openai-chat（openai-responses 预留未实装,见 shared-providers ProviderEntry）
    - create: yaml    # (request: IR) → Promise<IR 响应>
    - classifyError: yaml  # (err) → 错误类别枚举
```

**openai 适配器的转换规则**：
- 请求：IR 顶层 `system` 字段 → openai `messages` 首条 system 消息；`max_tokens` 直传（兼容端点通吃；官方新模型需要 max_completion_tokens 时再按错误重试处理）；`temperature` 直传（被拒剥除重试与 anthropic 路径同一机制）
- 响应：`choices[0].message.content`（字符串）→ IR `content:[{type:'text',text}]`；`usage.prompt_tokens/completion_tokens` → `input_tokens/output_tokens`
- 错误：openai SDK 错误类（RateLimitError/InternalServerError/APIConnectionTimeoutError/APIConnectionError/AuthenticationError/BadRequestError）→ 同一类别枚举；context_overflow 靠 BadRequest 文案匹配（收紧判据与 anthropic 侧同一函数——'prompt is too long'/'context_length' 等实际文案，禁裸命中 token/context 子串：旧宽松判据曾把 'invalid token' 鉴权错误误判溢出触发降级重组）

**当下边界（作者定 2026-08-12）**：LLM 工具循环（executeActWithTools 的 tool_use 往返）不做 openai 协议映射——**无 body 且带工具的 act 路由到 openai 协议 provider 时 fail-fast**（错误码 PROTOCOL_TOOL_LOOP_UNSUPPORTED，报文指路：给 act 写 hop_python body，或该步 @model 路由到 anthropic 协议 provider）。理由：act 的架构方向是 body 确定性执行（LLM 工具循环仅是无 body 兜底窗口，见 [[../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]），为兜底窗口做双协议映射不划算；实际需求出现时再议（TODO ^todo-openai-tool-loop 记账观察）。带 body 的 act/commit 在 openai 协议上完全正常（body 工具调用走引擎白名单通道，不经 LLM 协议面）。

**正反例**：请求/响应双向映射正例；usage 映射正例；错误分类逐类别正反；无 body 带工具 act × openai → fail-fast 反例；带 body act × openai → 正常正例；config protocol: openai-chat 放行正例、乱值拒绝反例；既有 anthropic 全量测试零改动（IR 不变的守卫）。

### 路由解析【契约】 ^anc-exec-model-resolve

```
# Spec: 模型路由解析
Id: model-resolve
Goal: 给一个待执行步骤解析出 service_id+model——spec 面三级软偏好（缺席 warn 落级沿链向下）,系统面加载期已核直取,链尾恒有缺省必有归宿不报错
Inputs:
- category: line      # 路由类别 RoutingCategory（act/commit/reason/check/replan）
- step: yaml          # 可选。StepReady（@model 标注经它取）
- spec_config: yaml   # spec Config 段（models 逐类别/model 单默认）
- model_engine: yaml  # 系统层 ModelEngine（routing_rules/default_model）
Outputs:
- resolved: yaml      # { service_id, model }
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

`parse_model_ref` 解析 `service/model` 格式字符串。纯 model 名（无 `/`）视为默认服务的模型。

### 客户端池

StepDispatcher 维护 `Map<service_id, Anthropic>` ——每个 service 是一个独立配置的 Anthropic SDK client（不同 base_url + 凭证）：

```
// 按需创建——首次使用某 service 时初始化
get_or_create_client(service_id: string):
  if clients.has(service_id): return clients.get(service_id)
  credential = identity_provider.get_credential(service_id)
  base_url = resolve_base_url(service_id)
  if service_id != 'default' and !credential: throw UNKNOWN_SERVICE
  client = new Anthropic({
    apiKey: credential.values.api_key ?? credential.values.token,
    baseURL: base_url,                  // 指向 Anthropic / DeepSeek / 代理网关
  })
  clients.set(service_id, client)
  return client
```

默认服务（service_id='default'）从环境变量构建：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`。
额外服务从 YAML 配置加载。所有服务统一走 Anthropic SDK，只是 base_url 和凭证不同。

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

三个独立机制防止无限制的 API 消耗。

### 1. tool_use 迭代上限

act 步骤的 tool_use loop 最多执行 N 次工具调用（默认 20，可通过 Config 覆盖）。超过上限后以 MAX_TOOL_ITERATIONS 错误 fail step，由 subtask retry 机制处理。

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

**为什么（hopissues/0095 实测定论,2026-09-16 作者拍"再等着卡死?"）**：长转录任务的输入上下文与单轮延迟超线性恶化——实测 140K 时单轮 3-4 分钟,150-165K 升到 8-16 分钟,170K+ 飙到 25 分钟直至 62 分钟服务端超时零产出死亡。恶化全程引擎零观测：hoplog 只记 per-step 的 input_tokens,没有"这个实例正在往墙上走"的累计视图与告警,只能事后尸检。机制 2（全局预算）管的是费用总量不管单实例体量;工具循环压缩降级（v0.21.0 两档）管的是单步内 messages 撞模型窗,不管跨步的转录膨胀——本机制补的是**实例级水位线**这一层。

**做什么（三件,全部纯观测加法,零执行语义变更）**：

- **① 实例级峰值输入水位入账**：每次 LLM 调用后,以该次请求的完整输入体量（`usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`——三项合计=模型真实吃进的上下文,单看 input_tokens 会被缓存命中掩住真实体量）更新本实例的**峰值水位** `ctx_watermark`（Dispatcher 实例字段,取历史最大值——转录式任务水位单调升,取 max 对非单调形态也稳健）。落账两处：hoplog 每步 llm 块加 `ctx_input_total` 字段（当次请求实际值,与既有 input_tokens/cache_* 并排）;实例终态/暂停响应加 `ctx_watermark`（与 cumulative_tokens 并排透出,run_status 可见）。
- **② 软阈值告警**：`resource_limits.max_context_tokens` 有配置时,水位首次越过其 0.75 倍 → 经既有 pendingWarns 通道随当步落一条 warn（形态:"实例上下文水位 <水位>K 已越 max_context_tokens 的 75%（<阈值>K）——长转录延迟将超线性恶化,考虑拆步或收敛材料",0095 曲线为据）;首次越过 1.0 倍 → 再落一条升级措辞的 warn。**每档只告警一次**（水位单调,重复告警是噪声）。不配置 max_context_tokens 则本告警静默（与预检档同一开关哲学——向后兼容,零新配置键）。
- **③ 超时重试耗尽时的水位提示**：callLlmWithRetry 对 `timeout` 类错误重试耗尽（各档退避走完仍败）抛 NETWORK_ERROR 时,若实例水位已越 ②的 75% 线,错误文案追加水位提示（"输入 <N>K 已近上下文告警线,超时与体量相关的概率高——重试大概率同因,考虑拆步"）——逐次重试期间照旧安静退避不出声,网络瞬断（network 类）耗尽也不带提示,只有 timeout×体量双嫌疑时提示。**不做自动截断/自动放弃**（语义决策,不属观测批;0095 卡期望行为③的激进半边另议）。

**边界**：观测点在 callLlmWithRetry 成功/失败两侧（发送口事实边界,^anc-obs-record-at-boundary 同律——记实际请求的 usage,不在意图层估算）;复用模式不经本模块,caller 侧转录观测归 caller 生态（^anc-obs-mode-boundary 同界）;水位不入 state.json 快照（观测态非执行态,resume 后从零重累,峰值账在 hoplog 恒可溯）。
