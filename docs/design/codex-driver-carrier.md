%% @trace
	id: hopjit-codex-driver-carrier
	source: [[../ARCHITECTURE]], [[reuse-mode-prompt-flow]], [[parallel-execution]], [[hop-cli]]
	source_id: hopjit-design, hopjit-reuse-mode-prompt-flow, hopjit-parallel-execution, hopjit-hop-cli
	type: extend
	last_sync: 2026-08-27T12:13+0800
	note: Codex 复用模式 driver carrier 正式设计：优先按 main/segment-driver/parallel-worker 三主体拆分，以 spawn 直发结果决定 delegated/inline（2026-08-08 废 nonce probe——任务即握手+产物侧首步心跳）；定义 action envelope、规则一致性、批式 fan-out 与安装布局。
%%

# Codex Driver Carrier 设计

## 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|---|---|---|
| 定位与边界 | 契约 | `anc-driver-codex-carrier` |
| 逻辑角色与物理运行模式 | 决策+契约 | `anc-driver-codex-agent-roles` / `anc-driver-codex-inline-fallback` |
| 直发能力门（任务即握手）+ 启动心跳 | 决策+契约 | `anc-driver-codex-capability-gate` / `anc-driver-codex-first-heartbeat` |
| Action envelope | 契约 | `anc-driver-codex-action-envelope` |
| 执行规则重复 | 决策+契约 | `anc-driver-codex-rule-parity` |
| 批式 fan-out | 契约 | `anc-driver-codex-batch-fanout`（定义在 parallel-execution） |
| 安装布局 | 契约 | `anc-driver-codex-install-layout` |
| Codex 侧开发规约 | 契约 | `anc-driver-codex-dev-rules` |
| 静态验证载体 | 决策+契约 | `anc-driver-codex-static-lint` |

> **⚠️ 本文档锚点的落点性质（2026-08-01 anchor-audit 澄清）**：`^anc-driver-codex-*` 契约约束的是 **driver 载体产物**——落点在 `driver/codex/**`（SKILL.md / agents / references）与 `scripts/check-driver-carriers.mjs`（静态纪律机检），**不在 `src/*.ts`**。唯一有引擎侧落点的是 `^anc-driver-codex-install-layout`（`cli.ts` 的 install-skill codex 分支，已追溯）。故除安装布局外，其余 carrier 锚点在“设计→`src/` 代码覆盖”维度报缺失属**预期**，非追溯断链。

## 定位与边界【契约】 ^anc-driver-codex-carrier

Codex driver carrier 是 HopJIT 复用模式在 Codex 本地客户端中的驱动适配层。它把一个**逻辑 driver**拆为多个物理 agent session，但不改变 HopJIT 看到的协议：

- HopJIT 仍只输出 `NextResponse`，不感知 main、segment driver 或 worker。
- 执行节奏仍由 `completeAndAdvance` 决定。
- agent session 切换是 caller 内部实现，不是新的引擎状态。
- 正常 session 交接保留 `running`；`hopjit resume` 只用于真正的崩溃恢复。
- paused 决策、adaptive replan、parallel fan-out 与终态汇总只归 main orchestrator。

**本模块负责**：

- Codex skill 的角色拆分与装载边界
- main 与执行 agent 之间的 action envelope
- Codex barrier batch 的主会话编排规则
- Codex 专属执行规则与 CC 规则的 parity 约束
- Codex skill 安装布局

**本模块不负责**：

- HopJIT 状态机、retry/adaptive、变量或 join 算法
- Claude carrier
- Codex Cloud 或 git worktree 管理
- `codex exec` fallback
- subagent 模型分层与通用 token 优化

## 逻辑角色与物理运行模式【决策：依赖驱动】【契约】 ^anc-driver-codex-agent-roles

**触发依赖**：Codex subagent 的 barrier join、skill 按需加载，以及当前单文件 `SKILL.md` 同时承载三种身份导致的注意力污染。

Codex carrier 固定三个**逻辑角色**。角色是职责边界，不等同于物理 agent session：

| 逻辑角色 | 文件 | 生命周期 | 权限 |
|---|---|---|---|
| Main orchestrator | `driver/codex/SKILL.md` | 整个用户会话 | 参数确认、HITL、adaptive、fan-out、终态 |
| Segment driver | `driver/codex/agents/segment-driver.md` | 一个连续纯执行段 | reason/check/act/commit；遇介入点立即返回 |
| Parallel worker | `driver/codex/agents/parallel-worker.md` | 一个 parallel child 子实例 | 只驱动该 child 到 completed/failed |

物理映射由当次运行的 effective config 与实际通信能力共同决定：

- **delegated 模式**：spawn 工具在场且派生调用成功——首个 segment driver 直接带真任务派出（任务即握手，无预探测），三个逻辑角色映射到 main + subagent sessions。
- **inline 模式**：工具不存在、spawn 报错、或首步心跳判死（引擎零实例）——三个逻辑角色仍保留，Main 临时切换角色执行 segment/worker 规则；不额外创建 session。

运行目录命名是两种物理模式共享的不变量：项目根下 `.hopstate/` 只存 HopJIT 状态，`.hoplog/` 只存执行日志，`.hopspec/` 只存 driver 的发现缓存（当前为 `recent-dirs.json`）。`<STATE>` 必须固定为项目根 `.hopstate` 的绝对路径；禁止把 `.hopspec` 当 `--state-dir`。该约束不能留给模型从“项目内状态目录”自行命名，否则 inline 会受刚读取的 recent-dirs 路径干扰。

### Main orchestrator

delegated 模式下 Main 只做编排，不执行普通 `step_ready`：

1. 探测 `<CLI>`，定位 spec，确认 params。
2. 用 `start` envelope 直接派生首个 segment driver（即能力门本身，见 `^anc-driver-codex-capability-gate`）；`run` 由该 driver 执行。
3. 按返回状态处理 paused / parallel / adaptive / terminal。
4. join 或人工注入返回 `step_ready` 时，用 `continue` envelope 派生新 segment driver。

Main 禁止：

- 自己执行 `run` 或普通步骤 submit
- 把执行循环重新内嵌回 `SKILL.md`
- 替 paused 的外部决策者作答
- 派生 scheduler agent

### 单 agent 降级【决策：依赖驱动】【契约】 ^anc-driver-codex-inline-fallback

是否能派生 subagent 取决于具体宿主、会话策略、model catalog、provider、wire API 与工具注入层。Skill 不通过 shell、模型名、配置声明或工具存在性猜测：

- spawn 工具在场且派生成功：保持 main / segment driver / parallel worker 三主体隔离（任务即握手）。
- 工具不存在、spawn 报错、或首步心跳判死：进入 `INLINE_FALLBACK`，Main 临时按角色文件执行 segment loop；parallel workers 在同一会话按批内顺序串行执行。inline 启动前置双条件（agent 已确认终止 + 引擎零新实例）见 `^anc-driver-codex-first-heartbeat`。

降级只改变物理 agent session 数和并发度，不改变 HopJIT 的 `NextResponse` 状态机、工作区隔离、HITL 所有权、复合 instance 句柄或 join barrier。Main 的“不得执行普通步骤”边界在 `INLINE_FALLBACK` 下有且仅有这一项显式例外。

所有推进型 CLI 命令必须返回可解析 JSON。exit 0 但 stdout 为空或非 JSON 记为 `DRIVER_PROTOCOL_ERROR`：写命令可能已落盘，driver 不得自动重跑，也不得从 spec body、state 或命名惯例猜下一状态。

### 直发能力门：任务即握手【决策：原则性】【契约】 ^anc-driver-codex-capability-gate

**2026-08-08 作者拍板重构：废除 nonce probe，直接以 spawn 方式发真任务。** 原 nonce 握手设计（生成随机串→派探针 agent→逐字比对回显）已整体作废，本节保留其失效史作为决策依据。

**为什么废除 probe**（第四类假阳性实撞后的结构性结论）：

- **探针自带副作用**：probe 是一个带上下文的活 agent。2026-08-08 真机实撞（DeepSeek Flash，e2e 失败归档 `codex-inline-2026-08-08T14-12-02-619Z` 完整现场）：`fork_turns="none"` 隔离未生效，probe 收到完整任务上下文（spec 路径+params 一字不差），没有回 nonce 而是把整个任务跑完——双实例双执行。对含 commit 步骤的 spec，这意味着**不可逆动作执行两次**。
- **"握手失败 ≠ 没有 subagent"**：nonce 不匹配时 main 判"无能力"切 inline 自己跑，但 spawn 出来的 agent 还活着、还在干活——inline 接管制造第二个执行体。漏洞在协议结构，不在子模型质量。
- **用 LLM 聊天行为预判"发任务会不会成功"，预判本身可错**：三类旧假阳性（工具在场调用不支持/线程可建 payload 不达/传输通协议不通）之后又出第四类（探针干活）。行为探测的假阳性面是开放的；而**真任务的成功本身就是能力证明**——发生在事后、不需预判、零额外成本。

**新门：三级确定性信号，无行为探测**：

| 级 | 信号 | 性质 | 判定 |
|---|---|---|---|
| 1 | spawn 工具不在会话工具面 | 声明式，零成本 | `INLINE_FALLBACK` |
| 2 | spawn 调用报错（unsupported/invalid 等） | 确定性错误，零成本 | `INLINE_FALLBACK` |
| 3 | spawn 成功 | — | 该 agent **就是 segment driver 本尊**，带 start envelope 直接开工。任务即握手，无探针、无 nonce、无预判 |

### standalone：独立薄协议，不在降级链上【契约】 ^anc-driver-codex-standalone-dispatch

**2026-08-27 作者四改（同日推翻三改的壳半边）：双名双壳——名字即模式，装配与运行时判定全消失。** 三改（配置声明+CLI 读出+单壳双协议段）落地当日作者再审："skill 是不是可以简单点,直接指定,不要 NL LLM 来装配"——配置方案仍是把决定移进文件让 LLM 读一跳,而更彻底的形态是**决定根本不存在于运行时**。定形三件：

- **双名双壳**：`/hopspec`（纯复用壳,hopspec-skill.md）与 `/hopspec-mcp`（纯 MCP 薄壳,hopspec-skill-mcp.md）**不同名并存安装**——用户敲哪个就是哪个,"指定"=调用动作本身,零判定零配置零 LLM 分发。8-16"两模式同名同用户面"反转:同名的代价是模式要靠第二信号选,双名把模式编码进名字。Codex 同构（`$hopspec`/`$hopspec-mcp`,SKILL.md/SKILL-mcp.md）;
- **description 分工=裸说时的缺省**：用户不敲斜杠命令、裸说"跑这个 spec"时,载体按 description 挑 skill——复用壳 description 写明"缺省用这个",MCP 壳写明"仅当用户明说走 MCP/standalone 时用"——裸说恒落复用,等价缺省 reuse（作者拍板不变）。这是仅存的 NL 参与面,且只在用户自己不指定时兜底;
- **三改的配置半边退役**：`driver_mode` 配置字段与 `hopjit driver-mode` 命令删除（唯一消费方是单壳 §0.5 分发,双名下无消费方=死机制,0.x 干净删——`^anc-cli-driver-mode` 锚废止）;"按项目设缺省"能力随之消失（作者确认可弃——敲命令名比记配置优先级直观）。**引擎侧双执行硬闸保留**（run 落账 `driver_channel: cli|mcp`,跨通道驱动响亮拒,权威 [[exec-engine#^anc-exec-driver-channel]]）——它与壳形态无关,双壳并存下防串台更需要它;两壳各留一行**跨通道报错指路**（收到 DRIVER_CHANNEL_MISMATCH=该 run 属另一形态,指路对应命令,不强行重试）。`install-skill` 恒装两壳,`--mcp` 语义不变（配置自举+注册 server,非模式选定）。

**历史（2026-08-27 三改,当日退役,背景保留）**：配置声明（driver_mode: reuse|mcp 两级合并）+ CLI 顾问（hopjit driver-mode 机械读出）+ 单壳双协议段（§0.5 照答案分发）。判定下沉方向正确（NL 零推断由四改继承）,但引入了配置字段、CLI 命令、双段壳三件机制去承载一个"用户敲个名字就能表达"的决定——四改用命名消解了整条判定链。

**历史（2026-08-16 装配时选定,背景保留）**：两模式壳一对一、装配时二选一（`install-skill` 复用缺省 / `--mcp` MCP 变体+注册）,运行时判定退役。该形态消除了串台的物理条件,但把"模式"钉死为装配时全局属性,无法表达"并存但缺省复用"。其核心洞察（运行时多源信号判定必然静默滑轨）由三改继承——判定仍不在 NL 运行时,只是从"装配动作"换成"配置声明+机械读出"。

**历史（2026-08-10 作者拍板,背景保留）：standalone 从降级链上拆下，独立成薄协议。** 原三层运行时分派（delegated→standalone→inline，双信号判定）作废——e2e 两次实红证明：把"查工具面可见性 + 读配置文件字段"这类环境判定放进 NL skill 运行时，main 的执行路径取决于它对多源信号的读取与判断，任何一侧信号注入不全（实撞：临时 config 只进 server env、main 查全局文件缺 `fallback_mode`）就静默滑向另一条路径——错得合规、难以觉察。复用模式（CLI 驱动）与 standalone（MCP 工具面）是**两种执行形态**，不是同一 skill 内的两个分支。

**历史（2026-08-10/16 间现役,三改后退役）：选定即静态——hopjit MCP server 已注册 = 用户 opt-in = standalone 已选定。** 注册动作即 opt-in 与费用授权的读法在"注册常驻但缺省想复用"的真实用况下失效（三改动因）,选定信号改为 driver_mode 配置声明。`fallback_mode` 字段废除的结论不变（该字段正是三改要避免的"NL 读配置字段判分支"形态——现在读配置的是 CLI 命令,不是 NL）。

**历史（2026-08-10 两轮真机实撞,判定手法背景保留）**：Codex 0.146 起 MCP 工具延迟加载（`tool_search_always_defer_mcp_tools` 固化开）,注册成功的工具也不出现在会话工具面——"工具面可见性"自查必然误判;探测型替代（list_mcp_resources 资源面恒空/`codex mcp list` 看不到 `-c` 注入）全部失效;当时的解法=`mcp__hopjit__list_runs` 试调用（只读零费用,让运行时解析）。三改后该判定整个退役——模式不再从"server 在不在场"推断;但此段实撞记录保留:MCP 壳协议段的**防误配报错**仍靠"工具调用被运行时拒绝"这一信号（driver-mode 说走 mcp 而调用被拒 = 配置与注册脱节,报错指路注册,不静默转 CLI）。

**能力契约**（Hop契约）：

```
# Spec: standalone 薄协议
Id: codex_standalone_protocol
Goal: hopjit MCP 工具面可见时,main 以纯工具调用驱动一次 HopSpec 执行到终态——零 hopjit CLI、零 subagent
Inputs:
- mcp_registered: bool    # hopjit MCP server 已注册——判定动作=list_runs 试调用成功（只读零状态零费用;
                          # 不是目视工具面——Codex 延迟加载下注册了也不可见,见上节实撞）
Outputs:
- terminal: line          # completed | failed（YAML 终态块呈现）
Constraints:
- mcp_registered 即选定 standalone,本次 run/resume 全程锁定——不判 spawn、不读配置文件、不切换执行体
  （注册=用户显式 opt-in+费用授权;运行时环境判定越少,路径越确定）
- main 不碰 hopjit CLI（执行全在 server 进程）;工具面预检由 server start_run 内置（spec 所需工具
  ⊄ DefaultToolProvider 即拒——此时 server 未建 run,零状态写入,main 如实报错停止,不转其他模式）
- HITL 不替答:paused 载荷按呈交纪律完整呈现真人,resume_run 只注入人的回答
```

**类型约定**：无新类型——消费 mcp-server 五工具既有 schema（[[mcp-server#^anc-mcp-tools]]）。

**关键逻辑**（Hop流程表达）：

```
standalone 驱动（四步薄壳）:
1. start_run(spec_path, params, state_dir) → 记 run_id;返回错误 → 如实报错停止（server 未建 run,零写入）
2. 等待经看护 subagent（主对话不轮询）——subagent 在自己窗口里适度轮询 run_status,
   到 paused/终态即停并带回完整 JSON（subagent 完成自动通知主 agent）;paused 由主 agent
   按 HITL 协议问人后 resume_run（看护只报告不替答,唯一例外=派活时明确指定的自动应答点）,
   注入后再起新看护继续等
3. completed/failed → 按呈现契约输出 YAML 终态块
4. 全程锁定:server 侧已有 run 即已有状态写入——禁止转 CLI 驱动或 subagent 重跑（双执行
   防线同一条铁律;看护 subagent 只读状态+代注指定应答点,不属重跑）
```

**看护 subagent 范式（作者定 2026-08-22"这个 watch subagent 应该成为标准范式"）**：`run_status` 是拉模式、MCP 无推送——run 完成不会主动唤醒主 agent。三种等待形态实测排序：前台 sleep 扛等待=把整个会话锁死用户插不上话（❌ 禁用）;后台裸脚本 watcher=能通知但无判断力,收到通知还得自己挖状态;**后台看护 subagent=既有完成通知（subagent 终态自动通知主 agent）又有判断力（区分 paused/终态/异常,终态 outputs 整理好带回）**——与复用模式"主 agent 只管介入点,执行段外包 driver subagent"同一架构哲学在 standalone 面的对偶。载体前提：载体有后台 subagent 能力（CC Agent 工具);无此能力的载体退化为主循环适度轮询（Codex exec 单线程形态）,但不得用长 sleep 阻塞交互。**观测隔离纪律（2026-08-27 随 #47 立,dr16 实锤:走查进度文件写在 run cwd 下,修错轮 act free 步骤 read 到它"恢复了全部 6 项缺陷"——观测材料混进被观测系统,验证结论不再纯净）**：看护/走查的进度文件与终报一律放 run 工作目录之外的独立观测目录（惯例 `/tmp/claude-502/observer-<run名>/`）,派活 prompt 写死路径并注明"严禁写 run 工作目录"。 ^anc-driver-standalone-watch

**与 delegated/inline 的关系**：spawn 能力门（上节）只在 **MCP 工具面不可见**时适用——delegated→inline 两层，回到 2026-08-08 原形态。两种形态互斥于会话工具面这一个静态事实，无运行时交叉。假死判定（首步心跳）只属 delegated 路径，不变。

**载体中立**：薄协议只消费 MCP 五工具，与载体无关——CC 载体同构适用（第一判定+四步壳+锁定纪律逐字同一套；CC 注册通道 = `.mcp.json` 或 `claude --mcp-config`，Codex = **持久注册**（config.toml `[mcp_servers]`）——两条实撞判定（2026-08-10）：⚠️① `-c mcp_servers.*` 命令行注入对 exec 运行时无效（`codex mcp list` 认它、exec 不为它起 stdio 进程，调用报 not a function）；⚠️② codex 以**干净环境**启动 stdio server（只带注册块 `env` 表内的显式值，不继承 shell 环境）——server 的凭证 fail-fast 预检会 STANDALONE_KEY_MISSING 即死（报 'was not ready for this step'），注册块必须带 **`env_vars = ["<KEY_ENV_NAME>"]`** 按名透传凭证变量（值不落盘，只写名字，key 安全红线不破；`codex mcp add` 无此 flag，需直接写 config.toml）。CC 侧落点：hopspec SKILL §0.5 形态选定（先于复用模式编排姿态）；e2e 场景 `cc:standalone` 与 `codex:standalone` 同一断言（正判据 start_run 可观测+零 CLI 写命令+零 subagent+同构 envelope）。

1. `run` 在 params 确认后直接尝试派生 start-segment driver；`list/validate/status` 不涉执行 agent。级 1/2 命中即 `INLINE_FALLBACK`，Main 按角色文件 inline 执行——此时**尚无任何 HopJIT 写命令**，降级零风险。
2. delegated segment/worker 固定 `fork_turns="none"`，以自包含 envelope 为唯一任务来源；但**不再假设隔离必然生效**（实撞已证可失效）——envelope 自包含是充分供给，隔离失效不影响正确性（agent 多看到父历史不改变其任务）。
3. 模式对**本次 HopSpec run/resume**有效；parallel 沿用同一模式。不写 `.hopspec`、不跨运行缓存（理由不变：无法稳定哈希 provider/catalog/配置修订）。

**启动心跳：假死判定用产物侧信号，不用聊天协议** ^anc-driver-codex-first-heartbeat

spawn 成功 ≠ agent 真在干活（挂死/静默/黑洞派发仍可能）。判活不再问 agent（问=又一轮行为探测），看引擎产物：

1. 派生 start-segment 后**首次 wait 用分钟级 timeout（建议 300000ms）**，不用 segment 的 3600000 长等待——这是首步心跳期限。
2. 首次 wait 返回而 agent 未完成 → 查 `<STATE>` 产物（读目录与 state.json 是观测不是执行，Main 有权）：
   - **无任何新实例** → agent 拿到任务后毫无引擎动作 = 假死。close/确认其终止后进入 `INLINE_FALLBACK`。此时零实例在场，inline 直跑无双执行风险。**判死即行动（2026-08-14 补定,flash 两轮实撞）**：判死条件成立后必须立即降级——禁止再 wait、禁止只查目录不行动（实撞形态:flash 未发 spawn 却声称"segment 已启动"进 wait,心跳返回查得空目录后干等到 480s 被掐;弱模型对"如有 close 能力…"条件从句推理失败=卡死点,指令按"spawn 从未成功→双前置天然满足零动作直降"/"spawn 成功过→close+确认再降"两情况显式短路）；
   - **已有新实例** → agent 已开工。切回 3600000 长等待。此后通信丢失/返回中取不出引擎 JSON 仍按既有不变量 `AGENT_PROTOCOL_ERROR` 停止——**首个 HopJIT 写命令之后永远禁止切 inline 重跑、禁止读 state 猜终态**（该不变量不因本次重构放松）。
3. **接管唯一性铁律**：`INLINE_FALLBACK` 只允许在「已 close/确认 agent 终止 **且** `<STATE>` 零新实例」双条件同时成立后启动。缺一不可——这是从双执行实撞直接推演的收链条款。**spawn 从未成功的退化形态**：不存在 agent 可关,第一条件空真,双条件即"零新实例"单条件——skill 指令须把这个空真显式写出（弱模型不做空真推理）。**言行自检条款**：只有真实看到 spawn 调用成功返回才允许宣称"segment 已启动"并 wait——未 spawn 即 wait 是在等不存在的人。

### Segment driver

Segment driver 是顶层纯执行段执行者：

- `start`：自己运行 `run`，取得 instance_id 后进入循环。
- `continue`：直接消费 main 传入的当前 `NextResponse`，不调用 `resume`，不重新领取步骤。
- 连续处理 `step_ready`，直到 paused / parallel_ready / adaptive_needed / terminal。
- 返回完整停止响应 + instance_id + 一行摘要。

### Parallel worker

Parallel worker 只处理一个 child：

- 首命令原样执行调度顾问给出的 `launch_command`。
- 后续 submit 固定使用 `<parent>/parallel/<child>` 复合句柄。
- 只写本 child 的 `output_path`。
- 不处理 HITL，不派生 agent，不参与 join 决策。

## Action Envelope【契约】 ^anc-driver-codex-action-envelope

### StartSegment

```json
{
  "mode": "start",
  "cli": "<完整 CLI 调用前缀>",
  "state_dir": "<绝对路径>",
  "spec_path": "<绝对路径>",
  "params": {}
}
```

### ContinueSegment

```json
{
  "mode": "continue",
  "cli": "<完整 CLI 调用前缀>",
  "state_dir": "<绝对路径>",
  "instance_id": "<父实例 ID>",
  "current_response": {
    "status": "step_ready"
  }
}
```

`current_response` 必须是 main 刚从 join、answer 或 replan 命令取得的完整 `NextResponse`。大字段沿引擎已有 `$file` 指针传递，不由 main 二次摘要。

**为什么不用 resume**：`resume` 走 `recover`，会把悬空 `running` 重置为 pending；正常 agent 交接是 caller 已持有 action、正等待回写，属于 load 语义。把正常交接伪装成 crash recovery 会破坏 `^anc-cli-state-load`。

### WorkerLaunch

```json
{
  "role": "parallel_worker",
  "child_step_id": "2.1",
  "parent_instance_id": "<id>",
  "launch_command": "<顾问返回的完整命令>",
  "cli": "<完整 CLI 调用前缀>",
  "state_dir": "<绝对路径>",
  "vault_dir": "<绝对路径>"
}
```

### AgentResult（2026-08-09 重设计：引擎 JSON 原样即返回值，废手工信封）

**返回值 = 执行 agent 最后一条引擎 NextResponse JSON 原样**。可在 JSON 之前带一行人读摘要（"执行了 N 步：..."），但 JSON 本体必须原文完整、不改写不包裹。

**为什么废除信封**（2026-08-09 flash 实撞，归档 `codex-flash-2026-08-08T16-51-31-166Z`）：旧信封 `{role, instance_id, status, response, summary}` 的逐字段信息量审计——`role`=main 自己 spawn 的天然知道；`instance_id`=`response.instance_id` 已有（引擎写的）；`status`=`response.status` 的人工复读（校验还要查"两者一致"，凭空制造誊抄不一致这种新错误）；唯一载荷是 `response`（引擎 JSON 原文）。**四个装饰字段全要 LLM 手工誊抄，而 main 的校验恰恰全盯着装饰验**——flash 把任务完整跑完（引擎 completed、outputs 齐全），只因信封没包对被判 `AGENT_PROTOCOL_ERROR`，聊天格式错误一票否决了引擎里的事实。数据是 jit 的机器真值，一路机器传递，最后一米要求 LLM 重新组装 JSON——违背"哑应答体、零加工搬运"原则，且把出错面精确压在弱模型最弱的动作上。

**main 侧消费与校验（全部对引擎真值验，不对 LLM 誊抄验）**：

- 从 agent 返回文本中取**最后一个完整 JSON 对象**（允许 JSON 前有摘要行；取不出任何 JSON 才是协议失败）；
- 校验 `status` 与 `instance_id` **直接读该 JSON 的字段**——它们是引擎写的，不是 LLM 写的；
- `role` 由 spawn 关系确定（main 派谁收谁，不需要对方自报家门）；
- worker 场景的 `child_step_id` 由 main 自己的 spawn 簿记提供（派 worker 时按 child 分配，`fanout-next --done` 用 main 侧记录，不依赖 worker 回传）；
- 取不出 JSON、或 JSON 无 `status` 字段 → 按 `AGENT_PROTOCOL_ERROR` 停止（该不变量不变）。

弱模型的交接义务由此从"按模板重新组装五字段 JSON"降为"原样粘贴 jit 给你的最后一行"——出错面趋近传输层。

## 执行规则重复【决策：依赖驱动】【契约】 ^anc-driver-codex-rule-parity

本次只拆 Codex，不重构 Claude 或公共 references，因此明确接受两份执行规则：

```text
driver/references/step-execution-rules.md
driver/codex/references/execution-rules.md
```

**接受原因**：

1. 公共文件当前含 CC 调用原语与 `node <CLI>` 形式，不是真正载体中立。
2. Codex agent 必须自包含，不能每次加载映射表再翻译 CC 原语。
3. 抽取全新共享核心会扩大为双 carrier 重构，超出本次范围。

两份文件都对齐设计锚点，不规定 CC 文本是 Codex 文本的上游。carrier 只允许在调用原语、完成通知和权限表达上不同。

### 语义签名

| 维度 | 共同契约 |
|---|---|
| 状态 | step_ready / paused / parallel_ready / adaptive_needed / completed / failed |
| reason | 根据完整 context 产出 output schema |
| check | bool 判定槽 + text 说明槽，不自行决定 retry |
| act/commit | 有 body 机械执行，无 body 按描述执行 |
| 提交 | 完整 JSON 写入 `output_path`，整包 `@file` |
| 工作区 | 只写引擎指定 work_zone |
| schema 错误 | SCHEMA_MISMATCH 修正后重交原步骤 |
| 执行失败 | `--failure` 交还引擎 |
| HITL | 执行 agent 返回 main，不替答 |
| 响应完整性 | 空 stdout / 非 JSON → DRIVER_PROTOCOL_ERROR，不重跑、不猜测 |

### Parity 保障

- `TRACEABILITY.md` 在同一锚点下登记两份 carrier 规则。
- `scripts/check-driver-carriers.mjs` 检查稳定协议标记，不比较自然语言全文。
- 修改任一侧规则时，评审必须复核另一侧；carrier 专属差异须在本节登记。

## Codex 批式 Fan-out【契约】

Codex 对现有 fanout 顾问的消费契约定义在 [[parallel-execution#^anc-driver-codex-batch-fanout]]。核心边界：

- Engine/CLI 的 level-triggered 调度算法不改。
- delegated 模式：Main 同批派生 workers，等待整批返回。
- inline 模式：Main 按 `workers[]` 顺序串行驱动本批 children；串行只改变并发度，不改变 child 隔离与 barrier。
- 按结果串行调用 `fanout-next`；收到 join 立即停止上报并执行 join。
- segment driver 与 parallel worker 都不承担调度器角色。

## 安装布局【契约】 ^anc-driver-codex-install-layout

包内源（parallel-worker.md / batch-fanout.md 已随旧并行通道退役——P0.5 统一模型 2026-08-11，本图 2026-08-26 随 hop 件新增对齐实况）：

```text
driver/codex/
├── SKILL.md              ← hopspec main orchestrator（--mcp 时装 SKILL-mcp.md 变体）
├── hop-skill.md          ← $hop 随手命令（2026-08-26 新增——单文件无 agents/references）
├── agents/
│   └── segment-driver.md
└── references/
    ├── discovery.md
    └── execution-rules.md
```

安装结果（**2026-08-27 作者定"codex 和 cc 看齐"+"只有 demo 是项目级"——正式件缺省用户级 `~/.codex/skills/`**，与 CC 的 `~/.claude/skills` 对称;Codex 官方四层扫描里 user 级=`$CODEX_HOME/skills`,同名 project>user,故文档须提示清理旧项目级残留防旧盖新。**2026-09-02 cfuse 适配**:目标 home 按 [[hop-cli#^anc-cli-carrier-home-resolution]] 解析——`--carrier codex` 读 `CODEX_HOME`(cfuse 内置 codex 会话内自动装到 `~/.codefuse/engine/codex/skills`);`--carrier cfuse-codex` 固定 `~/.codefuse/engine/codex/skills`(裸终端显式指定)）：

```text
~/.codex/skills/hopspec/      ← 用户级缺省（--dir 覆盖,语义=skills 根目录,不再拼 .agents/skills 中间层）
├── SKILL.md
├── agents/
│   └── segment-driver.md
└── references/
    ├── cli-discovery.md
    ├── discovery.md
    └── execution-rules.md
~/.codex/skills/hop/
└── SKILL.md              ← driver/codex/hop-skill.md 拷入（同 CC 的 hop 装配形态:单文件+版本戳）
```

**hop 件条款（2026-08-26 作者定"补"）**：`$hop` 与 `$hopspec` 分工同 CC 载体（成品 spec 用 hopspec、日常活用 hop）；驱动件是 CC 版 `driver/hop-skill.md` 的 Codex 适配（同语义分载体——协议 token 与 CC 版对齐，载体差异仅三处：触发形态 `$hop`、问人走对话直接问答〔规约 C9 同款〕、2b 外包按 spawn 能力降级〔无 spawn 则全自驱，无 INLINE_FALLBACK 仪式——/hop 本就缺省自驱，外包只是可选优化〕）；单文件自足，不引用 hopspec 的 agents/references。

带 `--demo` 时额外安装（**demo 恒项目级**——2026-08-27 作者定"只有 demo 是项目级":演示材料跟项目走,落 cwd 的 `.agents/skills/`,不随正式件进用户级）：

```text
<cwd>/.agents/skills/demo-coffee-week/   （demo 集三件同形态）
├── SKILL.md
├── spec.md
└── coffee-sales.json
```

Codex 显式调用为 `$demo-coffee-week`（或用 `/skills` 选择）。该薄包装定位 hopspec 的 SKILL.md（用户级 `~/.codex/skills/hopspec/` 或本项目 `.agents/skills/hopspec/`,就近取在场的那份）并委托执行，不复制 main/segment/worker 协议。

Codex 安装分支只从公共 references 复用 `cli-discovery.md`。不删除旧安装遗留文件；当前 `--force` 仍只覆盖受管目标。**旧项目级残留检测（2026-08-27 作者抓"项目级留着老 skill 只会造成版本冲突"）**：装置器检测 cwd 的 `.agents/skills/{hopspec,hop}` 正式件残留（与本次目标不同路径时）,响应带 `legacy_note` 响亮点名+给出删除命令——Codex 同名 project>user,残留会永久盖住用户级新版=静默旧版锁定;不自动删（可能是用户有意项目级钉版,删除权归人）。

开发期 `npm run dev:install` 同一次刷新安装两套用户级受管副本：CC 到 `~/.claude/skills`,Codex 到 `~/.codex/skills`。只刷新一侧会让另一侧继续加载旧协议文案；driver 源或 CLI caller 协议变更后，两套副本都必须 `--force` 覆盖。

## Codex 侧开发规约【契约】 ^anc-driver-codex-dev-rules

改动 `driver/codex/**` 前必读的封闭清单（多数有机检，标注在各条）：

**A. 文件与格式（Codex skill 机制的硬要求）**：
1. `SKILL.md` **第一行必须是 `---`**（YAML frontmatter 起始）——任何前置内容（含注释）都会让 Codex 不识别 skill（2026-08-05 真机实测：版本戳前置致 $hopspec 触发失败）。install-skill 的版本戳一律注入 frontmatter 闭合线之后；
2. frontmatter 必含 `name`（=$调用名）与 `description`（隐式触发靠它匹配，须含任务动词）；
2b. **`agents/*.md` 同样必须带非空 frontmatter（name+description）**——Codex 把 agents/ 下文件注册为子代理能力，description 空串直接被 provider 拒（400 invalid_params `tools[0].description: empty string`，2026-08-08 真机实撞：agents 文件只有 @trace 注释开头即触发）。references/*.md 仅被文内引用、不注册，无此要求。机检已入 check-driver-carriers；
3. 布局固定（SKILL.md + hop-skill.md + agents/segment-driver.md + references/{discovery,execution-rules}.md——parallel-worker/batch-fanout 已退役,hop-skill 2026-08-26 新增）——缺一即 check-driver-carriers 红。

**B. 内容纪律（机检 check-driver-carriers，挂 check:fast）**：
4. **禁 CC 原语**：AskUserQuestion / task-notification / `node <CLI>` 等 Claude Code 专属词不得出现在 driver/codex/**（自包含原则——Codex 文档只用 Codex 语汇）；
5. **协议签名对齐**：step_ready/paused/tool_request/parallel_ready/adaptive_needed/completed/failed、submit_and_fetch_next/--instance/--tool-result/output_path/SCHEMA_MISMATCH 等协议 token 必须与 CC bundle 同现——同语义分载体，允许原语不同、禁止步骤语义漂移（`^anc-driver-codex-rule-parity`）；
6. `<CLI>` 是完整调用前缀（可能是 hopjit 或 node 绝对路径），文档写法恒为 `<CLI> <command>`，不得再前置 node。

**C. 行为语义（与 CC 的三处刻意差异，不得"顺手统一"）**：
7. parallel 恒守 **barrier join**：delegated 模式批式 fan-out，inline 模式批内串行；都不引入 CC 的滑动窗口通知语义（依赖差异，`^anc-driver-codex-agent-roles` / `^anc-driver-codex-inline-fallback`）；
8. resume 仅崩溃恢复；正常续接走 envelope 交接（`^anc-driver-codex-action-envelope`：main↔segment-driver 传结构化 JSON，mode=start/continue）；
9. 问人走 Codex 对话直接问答（无 AskUserQuestion 组件可用）。

**D. 与 CC 共改的联动义务**：
10. 改执行语义（step 类型处理/提交协议/介入点）必须**双载体同步改**——先改 CC 侧（或共享 references），再对齐 Codex 侧，check-driver-carriers 的签名对齐会拦单侧改动；
11. 安装布局变更须同步 `^anc-driver-codex-install-layout` 契约 + cli.ts codex 分支 + cli.test 布局用例三处；
12. **禁写项目根 AGENTS.md**（2026-07-17 决策：那是用户的项目指令文件，驱动指令属 skill——机检有断言）。

**E. 验证义务**：
13. 改完跑 `npm run check:fast`（含 carrier lint）；涉执行语义的改动必须按下表补真机证据，未达到验收条件的项目保持“待验证”，不得以“流程走到 completed”替代协议合规。

### 真机 E2E 验收矩阵

| 场景 | 验收条件 | 当前状态（2026-08-06） |
|---|---|---|
| Skill 安装与发现 | 新会话能发现 `$hopspec`；带 `--demo` 时能直接 `$coffee-week`；`SKILL.md` 第一行是 `---` | ✅ 已验证；2026-08-06 `$coffee-week` live E2E 完成唯一 instance 与 27600 周报 |
| delegated 顶层执行段 | main 真实派生 segment driver（非 inline）；envelope 交接；返回引擎 JSON 原样；无空输出猜测 | ✅ 手工 ×2；自动 live E2E 2026-08-06 再验：ZenMux Codex delegated，main 零 HopJIT 写命令 + segment wait + 唯一 completed instance |
| 直发能力门 | spawn 不可用 → inline 完成任务；spawn 可用 → 首 segment 直发真任务完成；首步心跳期限内引擎零实例 → close+inline | ✅ 双翼真机验证（2026-08-09 e2e 全绿）：delegated 翼=codex:delegated + 15-43 归档（spawn 成、任务即握手、单实例完成）；inline 翼=codex:flash（ds4flash spawn 未成走 inline，main 恰一次 run、业务终态过，凭证 exercised_mode=inline）。心跳假死分支待真实假死场景出现时顺带验 |
| 返回值=引擎 JSON 原样 | 弱模型 segment 干完活后 main 能从其返回中取出引擎 JSON 并按真值消费（不再验手工信封） | ◐ 契约已生效（2026-08-09 e2e 全绿轮 flash 走 inline 通过，凭证 exercised_mode=inline）；**delegated 交接路径待 flash spawn 恰可用的轮次真机验**——flash 的 spawn 可用性本身在环境间抖动（16:51 轮 spawn 成、其余轮 inline），下次 exercised_mode=delegated 的通过轮即销账 |
| inline 顶层执行段 | 握手失败后不派生正式 segment；Main 全程只消费非空 JSON；不猜测 action；到 completed/failed | ✅ DeepSeek Flash 手工；自动 live E2E 2026-08-06 再验：`ds4` profile main 恰一次 run、无正式 segment、唯一 completed instance；同时抓出并修复 `.hopspec` 被误作 state-dir 的命名缺口 |
| 其余载体路径 | HITL、delegated parallel、crash resume 分别符合上文契约（inline parallel 随 inline 同降级——真实降级场景出现时顺带验） | ⬜ 待验证 |

## 验证边界【契约】

### CLI 行为测试

`tests/cli.test.ts` 只验证：

- 安装布局
- Codex reference 白名单
- 不生成 AGENTS.md
- CC 安装分支不变
- 幂等与 `--force`

### Driver 静态 Lint【决策：依赖驱动】【契约】 ^anc-driver-codex-static-lint

使用单个 Node ESM 脚本：

```text
scripts/check-driver-carriers.mjs
```

**依赖驱动来源**：HopJIT 工程是 Node ESM（`package.json type=module`、Node >=20），已有工程检查工具使用 `.mjs`。因此本检查使用 `node:fs` / `node:path`，不引入 Bash、`rg`、`grep` 依赖。**git 命令例外（2026-08-14 放宽,last_sync 机检依赖驱动）**：`last_sync 与实改脱节`检查本质是"声明时间 vs 变更历史"比对——文件 mtime 在 fresh clone/checkout 重置不可靠,唯 git log 是变更时间权威;本库本就是 git 仓库（release.sh 等已依赖）,放宽不引入新环境要求。仅此一检用 git,其余检查维持零外部命令。

**last_sync 一致性机检**【契约】 ^anc-driver-lint-last-sync

driver/ 下带 `@trace last_sync` 头的文件,**实改必须同步刷 last_sync**——手工纪律三撞（2026-08-12 SKILL.md 改收割铁律未刷/2026-08-13 又撞/2026-08-14 execution-rules.md 改 call_protocol 未刷,均事后人查才见）,按"行为纪律必须有产物侧信号"升守卫。判据（日粒度,YYYY-MM-DD 比对）：①已提交面=文件最后 commit 日期 > last_sync 日期 → 红;②未提交面=文件在 git status 脏区且 last_sync ≠ 今天 → 红（正在改的文件应随手刷）。git 不可用（非仓库/CI 浅克隆无历史）→ 显式跳过明说,不静默装绿（^anc-meta-guard-trust）。正反例:实改未刷红/改+刷绿/脏区未刷红/干净区旧 last_sync 不红（没改就不必刷）。

**路径契约**：脚本从 `import.meta.dirname` 推导仓库根目录，不依赖调用者 cwd；从仓库根、包根或 CI 中调用结果一致。

脚本同时检查：

- Codex 禁用原语、`<CLI>` 用法、角色文件存在、inline fallback 与 main 边界
- CC/Codex carrier bundle 的稳定语义签名

Markdown 内容纪律不混入 `cli.test.ts`。脚本比较稳定协议标记，不比较自然语言全文。
