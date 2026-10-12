---
name: hop
description: hop is the single entry point for HopSpec: a task as a structured spec (goal, steps, checks) that the hopjit engine runs step by step — progress recorded, checks enforced, interrupted runs resume. For you, the executing LLM: (1) no bookkeeping — step, outputs and passed checks live in the engine record, not your context; (2) no scheduling — order, parallelism, branches, loops and retries run from the spec; (3) reliability by structure — checks cannot be skipped, irreversible actions need human review or a final check, resume continues from the record. Use hop for: (a) multi-step work needing a progress record, verification or resume (research, batch edits, check runs) — it becomes an engine-managed task card; (b) running a HopSpec file or installed HopAnt; (c) translating a skill into HopSpec or revising a spec; (d) hop's own setup, upgrade and health check; for an external MCP tool it points the way; (e) "continue the last task" — resumes the open record. One-line answers needing no record stay out.
user-invocable: true
---

%% @trace
	id: hopjit-opencode-driver-hop
	source: [[hop-skill]]
	source_id: hopjit-driver-hop
	type: adapt
	last_sync: 2026-10-12T11:15+0800
	note: /hop 的 opencode 载体适配（适配基准=Codex 版 driver/codex/hop-skill.md——作者抓"在 codex /hop 都能用,为什么在 opencode 不装?"撤销上一批"v1 不装"裁定后补装;同语义分载体不许步骤语义漂移）。载体差异三处:触发=隐式（opencode 按 description 触发,用户说 hop/继续上次的活即中）/问人=question 内置工具（opencode-driver-carrier 映射表）/外包与阅卷按 subagent 能力降级（无 subagent 全自驱+判据硬化,零仪式——opencode 有内置 general subagent,常态可外移）。布局契约 [[opencode-driver-carrier#^anc-driver-opencode-install-layout]]。演进随 CC 版同批,归 git log。
%%

# hop — HopSpec 的总入口（opencode 载体）

把你正要干的活（或对话里已经列出的 plan）升格为一份 HopSpec 跑起来，是 hop 五条路里的主路，也是本篇正文讲的那一条。先说 hop 是什么、对你有什么用、什么时候该进来：

**HopSpec** 是把一件活写成带目标、步骤、核验点的结构化规约，交给 hopjit 引擎按步执行：进度有账、把关由引擎强制、中断可续。

**对你（执行的 LLM）的好处**：

- 卸掉记账压力——走到哪一步、每步产出了什么、哪些把关过了，全在引擎账上，不占你的上下文，不靠你记；
- 复杂任务的调度不靠你自己撑——顺序、并行、分支、循环、重试由引擎按规约执行，你只管干好当前一步；
- 可靠性由结构保证——核验点跳不过去，不可逆动作前必过人审或终检，中途断了从账上接着跑，不会从头来过也不会漏步。

**什么时候用 hop**：

① 多步骤、要留进度、要独立核验、中断后要能接着干的活（调研写报告、改一批文件、跑一组核对）——hop 把它升格成任务卡交给引擎管；
② 跑一份现成的 HopSpec 文件，或已装的 HopAnt 工具；
③ 把自然语言 skill 翻译成 HopSpec，或修订一份已有 spec；
④ hop 自身的安装、升级、体检从 hop 走，用户不需要记 hopjit 子命令；要把外部 MCP 工具接进 hop，hop 给指路；
⑤ 用户说"继续上次的活 / 接着干"——接上手头活的账。

一句话能答完、不需要留痕的活不进 hop。

**主路**（第①条）：**你自己驱动、自己干活**——引擎只管三件事：**顺序不乱、把关不跳、进展有账**（对话断了活不死，回来接着跑）。

其余四条从「0. 分派」节按用户说的话分派出去（现成 spec 按 hopspec 协议跑、构建修订按 hopbuild / hopfix、明说 MCP 独立模式按 hopspec-mcp）；hop 自身的安装、升级、体检现在落在「0. 分派」节的 MCP 可达性检查里（setup 补注册、doctor 体检），其余维护流程待补。主路恒复用模式——推进用 hopjit 的复用驱动工具（不调 start_run）、不做参数仪式；执行缺省在当前会话（活是当前会话的活，上下文就在这里），例外规则见下"步骤的注意力管理"。

## 用法（七动作：开 / 列 / 切 / 改 / 归档 / 总结 / 决策）

```
hop 查一下X的三个来源,写成报告发给我   ← 开新活（说"hop"或直接描述要管护的活）
hop                                  ← 有当前活:续跑;没有:列清单
hop list                             ← 手头活清单(各到哪步、停在哪)
hop 2  或  hop 合同                   ← 切到那个活,接着干
hop archive 2                        ← 归档(不要了/干完收起;不删,历史全留)
hop distill 2                        ← 总结(把干完的活总结成一个可复用的 Hop 流程元件〔即 HopAnt〕,落本项目 hop_tasks/ants/)
hop 决策                              ← 把挂着的待拍决策点逐个说清楚请人拍板,拍板过程存档
```

hop 是**独立的 plan/执行工具**：多个活并存、随开随切——像 todo 管理器,但每个活是一份可控可靠的 spec：有账、可执行、可续跑、有把关。

## 前置：CLI 定位

首次动作前按 `command -v hopjit` 定位一次 CLI，命中固化为 `<CLI>` 前缀（完整调用前缀,可能是 hopjit 或 node 绝对路径,文中恒写 `<CLI> <command>`）；不中直接报错请用户装好（`npm i -g @hoplogic/hopjit`）重试，不翻目录找替代。

## 执行流程

### 0. 分派：用户给的是什么，走哪条路

hop 是唯一入口，进来先判用户给的是什么，五条路：

**进分派之前先确认 hopjit 的 MCP 工具在本会话可用（todo/0146）**：驱动任务的推进优先用 hopjit 的 MCP 工具（下面第 2 节）。工具按名放行后推进不逐条弹窗;改用 `hopjit` 命令行推进时,每条命令参数都不同,几乎每条都要确认。opencode 的 MCP 注册在用户级 opencode 配置（`~/.config/opencode/opencode.jsonc`）,装 skill 时已写好且 server 已启用（`mcp.hopjit.enabled: true`）;独立模式专属的五个工具（`hopjit_start_run` / `hopjit_run_status` / `hopjit_resume_run` / `hopjit_list_runs` / `hopjit_stop_run`）由 setup 在同文件 `tools` 节关掉——它们在本会话里本来就看不见,这是预期形态,不是故障。每次 hop 进来按下面三种情况处理：

- **工具可见**（能调 hopjit 的 `server_status` 工具）→ 后面一律用 MCP 工具推进。server_status 报"独立模式不可用"只影响用户点名走 MCP 独立模式那一条路,不影响主路;
- **没注册**（配置里没有 `mcp.hopjit`——用户只装了包没跑 setup,或配置文件是后来才建的）→ 跑一次 `hopjit --json setup --carrier opencode`（幂等）补上,把响应里的 `permission_note` 转告用户;本会话改用命令行推进;
- **已注册但驱动工具不可见**（`hopjit_server_status` 调不到——server 起不来,或用户自己把 `enabled` 改成了 false）→ 跑 `hopjit --json doctor`（体检,只报不改——这一支正是工具调不到的情形,所以走命令行;其他时候用户说"体检一下 / 为什么用不了"调 `hopjit_doctor`,同一份报告）,看响应 `items` 里 `status` 为 `fail` 或 `warn` 的项,把它们的 `detail` 与 `hint` 原样告诉用户（`enabled` 被改成 false 时 `mcp_registered` 那项是 warn,hint 会说改回 `true` 后新开会话）。opencode 配置是用户级配置,改不改由用户定,你不改。本会话改用命令行推进。

改用命令行时告诉用户一句"本会话 hopjit 工具不可用,改用命令行驱动,每条命令可能需要确认"。不为此给驱动命令添加命令放行规则——驱动命令参数每次不同,前缀规则要么放不住,要么放得太宽。hop 自己的管理动作——体检、HopAnt 的查装适配封装分享——同样不走命令放行,它们各有 hopjit 的 MCP 工具（`hopjit_doctor` 与 `hopjit_ant_list` / `hopjit_ant_install` / `hopjit_ant_adapt` / `hopjit_ant_remove` / `hopjit_ant_bootstrap` / `hopjit_ant_pack` / `hopjit_ant_share`,与 `hopjit doctor` / `hopjit ant *` 同名参数同一份响应）;MCP 不可用时按 USAGE.md 命令行手册回退,用户不需要知道有 `hopjit` 这个命令（todo/0154）。不改写 `~/.hopjit/config.yaml`（那是用户的独立模式配置,与主路无关）。

**先查已有的 HopAnt**（todo/0142 子卡 B,作者 2026-10-07 定;2026-10-10 加项目级）：HopAnt 是现成的 HopSpec 工具,每个一个目录、一份入口 spec `<id>.md`,住两个地方——**项目级** `<项目>/hop_tasks/ants/<id>/`（这个项目里总结出来的,跟项目走）与**用户级** `~/.hopjit/ants/<id>/`（装进来的,跟人走,所有项目可用）。用户说的活不是一句话能答完的,先读两张索引：先 `hop_tasks/ants/index.md` 再 `~/.hopjit/ants/index.md`——一行一个 HopAnt,写着它的 id、标题和 Goal;同 id 以项目级为准（它是为这个项目改过的版本）;两张都不存在就是没有任何 HopAnt,跳过这一段。只读这两张表,不逐个打开入口 spec。命中（用户要的活就是某个 HopAnt 的标题或 Goal 说的事）→ 按下面"一份现成的 HopSpec 文件"那一路跑它的入口 spec `<命中那一级的根>/<id>/<id>.md`,跑之前做两件事：

1. **核适配状态**：调 `hopjit_ant_list`（命令行回退 `hopjit --json ant list`）,看该 id 的 `adapt_state`（两级都列,每行带 `scope`,同 id 看项目级那行）。`adapted` 直接跑;`never`（装上后没适配过）或 `stale`（适配后 spec 头变了、或目录是从别的机器拷来的）先调 `hopjit_ant_adapt`（`id` 传该 id;命令行回退 `hopjit --json ant adapt <id>`）——报告 `ok: true`（引擎同时写了适配戳）就跑;有缺口就把报告里的 `hints` 原样告诉用户（缺哪个工具注册、哪个凭证变量、哪条命令）,补齐之前不跑。
2. **工作区是用户的项目目录**：HopAnt 是工具,用户发起 hop 时所在的项目是它加工的对象,HopAnt 自己的目录只读。复用模式调 hopjit 的 `run` 工具（`spec_path = <入口 spec 绝对路径>`）,工作区缺省是载体拉起 server 时的项目根,与用户项目不同时显式传 `workspace_dir`——**值取本会话启动时所在的项目目录**（你的运行环境在会话开头告诉过你的那个工作目录,不是执行命令时 shell 当下的 cwd——同一会话里 `cd` 过别处 cwd 就变了,用户看不见这个变化）。起跑响应里有 `workspace_dir`,第一行进展就把它告诉用户一句（"这个活在 <目录> 上跑"）。命令行回退：`hopjit --json run <入口 spec 绝对路径> --workspace <项目根绝对路径> --state-dir .hopstate`——项目根写明传,不靠 cwd;不传则引擎取进程 cwd,结果不可预期;用户要求走独立模式时调 hopjit MCP 的 `start_run`,必须显式传 `workspace_dir=<项目目录绝对路径>`——MCP server 的 cwd 不一定是用户项目。

起跑时引擎还会核一遍依赖：入口 spec `## Tools` 段声明的工具（标准工具 `web_search` 除外）必须在 `~/.hopjit/config.yaml` 或项目 `hopjit.yaml` 的 `tool_servers` 里注册,静态 `call` 的目标必须是同目录的 spec、已装的 HopAnt 或已注册的工具。核不过返回 `INIT_FAILED`,带 `missing_tools` / `missing_calls` / `hints`——把 hints 告诉用户,不绕过。宿主自己挂的 MCP 工具没在 hopjit 里注册同样核不过,这是有意的：同一份 spec 换到独立模式也要能找到这个工具。没命中任何 HopAnt 就按下面五条路走。

- **一句话能答完、不需要留痕的**（算个数、翻译一段）→ 直接答，不进 hop。hop 不劫持对话。
- **复杂的、需要可控可靠保障的活**（多步骤、要进度记录、要独立核验、中断后要能接着干）→ 下面第 1 节起的升格流程：建任务卡、引擎管进度与把关。这是 hop 的主路。
- **一份现成的 HopSpec 文件**（用户给了路径，或指名跑某个示例 / 已总结出的 HopAnt）→ 不升格，直接按 `hopspec` skill 的协议跑（同目录下的 `hopspec/SKILL.md`，模型可调、用户菜单不显示）：参数确认、介入点问人、终态按契约呈现。**对用户只说一句固定开场白："现在有现成的 HopSpec 流程，下面按 HopSpec 运行。"**——分派表是给你选路的规则,"用户给了一份现成的 HopSpec 文件——按 hopspec 协议跑,不升格"这类话是念规则给自己听,不进用户可见消息（作者 2026-10-12 抓"这个描述也很土"）。`hop list` 不列它——它不是"手头的活"。
- **构建 / 翻译 / 修订 HopSpec**：把自然语言 skill 翻成 spec → 按 `hopbuild` skill；改一份已有 spec 的几处 → 按 `hopfix` skill。`hopbuild2` 是实验件，只在用户点名"hopbuild2"时用，不自动选。
- **用户明说"走 MCP / standalone"** → 按 `hopspec-mcp` skill 的协议跑：spec 在 hopjit server 进程里由它自己的 LLM 执行，本对话只做启动、介入点应答和结果呈现。

拿不准用户要的是哪条，问一句，不猜。

**运维场景的特殊规则按需读**：活涉及 ssh / 远端机器 / 多台环境，或项目 `hopjit.yaml` 里有 `environments:` 段，先读本目录 `references/hop-ops.md`（机器分级、按机器写已批准命令前缀、测试机整机放行）。其他活不用读它。

### 1. 升格：todo plan → spec（一个样例，不是一套规范）

**先分流，再消歧，先查有没有现成流程可复用，然后才从头升格**：

- **分流——这活该进 hop 吗**：进 hop 的活恒享全套（建卡+进展账+把关），判据是**要不要留进度记录、要不要中断后能接着干、要不要独立核验把关**。对话里一句话能答完、不需要留痕的（"3+5 等于几""这段话翻译一下"），自然语言直接干，别建任务；拿不准就问用户一句。**没有"轻任务降配"——进来就是全套，嫌重说明它不该进来**；
- **消歧——关键输入缺失或目标多义时，先问清再建卡**：缺城市的天气查询先只问城市；"把刚才的机制简化"这类范围含混的话不许直接开任务——问清范围前不产生实例；
- **轻任务减编排不减把关**：简单活不必照抄下面样例的多段结构，但 **check 不减**——核验避免幻觉是应该的（一次性查询恰是幻觉面最大的场景，check 逼你对着产出如实判一次，是价值本体不是重量）。轻任务缺省形态 = 执行步 + check（如 `act free → check final`），不是裸单步；
- **查现成流程——从头写 spec 之前，先看有没有现成的 HopAnt 可复用**（总结的消费半边——只存不用等于白总结;2026-10-10 起与「0. 分派」节"先查本机装的 HopAnt"是同一次扫描,这里只讲它在升格流程里的位置）：动手扫之前**先给用户一行提示**："我先看看已有的流程里有没有可复用的——想跳过就说'直接开'"（这一步不静默做：用户看得见才知道你在干什么、才知道有跳过的口子）。然后读两张索引——先本项目的 `hop_tasks/ants/index.md`（这个项目总结出的流程）,再 `~/.hopjit/ants/index.md`（装进来的）;一行一个 HopAnt,写着 id、标题、Goal,同 id 以项目级为准。命中分两档：**完全同类**（标题或 Goal 就是用户要的事）→ 告诉用户"这类活有现成的 HopAnt（上次<某活>总结的）,直接跑它？"——同意即按分派节"一份现成的 HopSpec 文件"那一路跑它的入口 spec（先核适配状态）;**大体同类**（差一截）→ 以它的入口 spec 为底稿建一张新任务卡,底稿上改,照常走 hop 全套（建卡+进展账+把关）——不直接改 HopAnt 自己的 spec（那是演化,归另一动作）;没有现成的才从头写。**用户说"直接开"（或"别查了/从头来"）→ 跳过本步径直建卡**（作者定 2026-08-28——用户比你清楚这活是不是新东西，明示直开就不拿清单打断;分流与消歧不随之跳）。**用户问"哪些可以复用/有什么现成的"** → 调 `hopjit_ant_list` 列清单（id+标题+适配状态,带 scope——项目级的是本项目总结的,用户级的是装进来的）,这也是查询动作，人问就答。两张索引都不存在就是还没总结过也没装过任何 HopAnt，静默跳过此步零仪式。

把任务（或你已列出的 plan）写成 spec。**粗没关系——后面还没想清楚的段落，写成 `[subtask free]` 到步展开**（引擎一等形态，作者定 2026-08-27：本质是到这步以后，做一个本步的 plan-do-check-retry-pass 展开）：

```markdown
2. [subtask free] 后面的活（到步展开）
  - ← 前面的产出
  + → 交付物 % text  # 说明
```

底下**一个子步都不用写**。执行到这里引擎自己停下来向你要计划——响应是 `adaptive_needed` 且带 `reason: "initial_plan"`（**这不是失败**，别做失败归因），`expansion_context` 里是 ← 输入的**实际值**（拿真产出定计划，不是盲规划；null 值项见 `missing_inputs`——计划里安排取数或按缺失处理）；你出子步骤提交（`--replan`，协议同"边跑边改计划"节），引擎接续执行;展开次数超上限时引擎拒收并在报文里给续批协议——**把情况原文呈给用户问"继续还是收手"，用户批了才照报文指引重交，你无权替答**（预算是人给的,追加也须人批）——**展开计划本身不过阅卷**（出计划、提交的都是你,引擎两闸是把关方;恒外移的只有 check final 的判定,别把"阅卷外移"误解成一切计划都要外移）。两条展开纪律引擎强制：**展开物必须含 check**（运行时出的计划无人预审，check 是唯一把关）；**展开物禁 commit**（不可逆动作必须写卡时显式声明——要 commit 写在 subtask free 外面消费其交付物）。中文写法 `[子任务 开放]`。样例：

```markdown
# Spec: 调研X并出报告
Id: hop-20260826-1
Goal: 查清 X 的现状,交叉核对后成文发出

## Outputs
- report % markdown  # 调研报告

## Steps
1. [act free] 查 X 的三个独立来源
  + → sources % yaml  # 来源与要点

2. [reason] 交叉核对,整理要点
  - ← sources
  + → digest % text  # 核对后的要点

3. [subtask] 成文并把关
  - ← digest
  + → report % markdown  # 调研报告
  3.1. [act free] 写初稿
    - ← digest
    + → report % markdown
  3.2. [check final] 核对:来源全覆盖、结论与要点一致
    - ← report
    + → ok % bool  # 判定
    + → note % text  # 缺口

4. [commit] 发出去
  - ← report
```

升格要点（就这几条，其余随意）：

- 每行一个类型标：干活 `[act]` / 思考 `[reason]` / 机器或自查把关 `[check]` / 要问用户 `[ask]`/`[confirm]` / **不可逆动作（发送/删除/发布）必须 `[commit]`**——这是最容易标错的一个：凡是"做了就收不回"的都是 commit，不是 act；
- `[commit]` 前面必须站着 `[check final]` 或 `[confirm]`（引擎 P8 会拦，先懂为什么：授权完成才许不可逆）；
- **改仓库正式文件的活，改动阶段进 worktree**（2026-08-30 作者抓实撞后立——修复步标 act free 直改共享工作区=把 commit 的事标成 act 混过把关，正是上一条最容易犯的形态）：会写 src/docs/tests 这类要留下来的文件的步骤，在独立 worktree 里改+自测（`WT=<目录>; git worktree add "$WT" <基线>`——act"可逆"对改文件场景的物理兑现：主区物理未被碰、并行会话撞不了车、弃区即完全回滚）；`[check final]` 对 worktree 里的成品验收；**合入主区+推送整体归 `[commit]` 步**（把关过了才把改动请出隔离区）；弃区路径恒用建区时的同一变量不手打。只写 work_zone/临时区的活照旧，不加仪式；
- `[check]` 步的输出槽是**恰好一个 bool 型（判定）+ 一个 text 型（说明）**——槽位看的是类型不是名字，`ok`/`note` 是惯用名不是强制名（多 check 不撞名时用语义前缀）；check 须在 subtask 内（顶层平铺是 C6 error）；
- `[check final]` 是收尾把关——**它后面不能再有干活的步骤**（把关完只许 commit/exit，写计划时把关放段落末尾，探索性步骤都排它前面）；
- **产出链完整**（P11/报告类常撞）：每个步骤 `- ←` 引用的变量必须来自前序步骤 `+ →` 或 Inputs——凭空引用是 V1 error；交付物变量（Outputs 声明的）必须有某一步真的产出它，缺产出步是 P11 error；
- Goal 一句话 + Outputs 一个交付物（引擎兜底"做完=什么"的验收面）；
- **带 body 的步骤，说明与 body 功能保持一致**（作者定 2026-08-30——说人话说完整）：`>` 说明如实说清 body 在干什么，不许说明写"核对清单"而 body 里藏着别的动作。判据：只读说明的人对这步的预期与实际零偏差；
- **对话结晶必须落卡（充分供给,不吝啬 token——必做非可选）**：对话里已拍的板、定过的口径、排除项、材料指针，**全文写进任务卡的背景/参考节**。判据：新会话或子代理**读卡即接手，零追问**。语境不落卡，跨会话续跑只剩引擎的结构账；且阅卷子代理（见下"阅卷外移"）的供给全靠卡——语境缺席它只能盲判；
- **写卡时列出 `## 已批准命令`**——这是任务卡的一个段，授权只对这张卡起的 run 有效；普通对话里跑命令与它无关，照旧走载体。把这个活要跑的命令前缀一行一条写进去（放 Config 之后、Steps 之前），之后这些命令经 hopjit 按卡放行，不再逐条过载体的权限弹窗。**清单管的是"这个任务允许跑什么"，不管在哪一步跑**——同一条命令在 act 步骤里跑是探索（可重跑），在 `[commit]` 步骤里跑是提交（前面必须过 check final 或 confirm，才执行一次），探索态还是提交态由步骤类型定，引擎按态把关，不靠清单区分。commit 步骤要跑的命令也从这张清单来——写卡时把它写进 `[commit]` 的 hop_python body（`subprocess.run([...], cwd: ...)`），引擎执行到那一步时直接跑 body，不再临场调工具；body 里的命令不在清单上同样被拒。所以写卡时要同时想好两件事：清单列全，不可逆的那条放进 commit 的 body。前缀写到能区分意图的那一层：`- python3 scripts/ssh_exec.py --config configs/x.json` 放行所有以它开头的调用，`python3 evil.py` 不行；`- git status` 放行 `git status --short`，不放行 `git push`——要 push 就单独列 `- git push`，并把它放进 commit 步骤。首项不能是 hopjit。不必问用户要不要列——这是升格的一部分，用户在任务卡里能看到；
- **关键词语言随项目走**（2026-09-03 language 特性落地）：写卡前看项目 `hopjit.yaml` 有没有 `language: zh`——有就用中文关键词写任务卡（`[探索 开放]`/`[检查 终检]`/`## 目标`,对照表在语法参考 §12）,没有或写 en 就用英文。两种语言引擎恒等价,写"错"不报错,跟着项目缺省走是为了产物风格统一。**存量 spec 转语言用 `<CLI> lang <spec文件> --to zh|en`**——先自动备份（同目录 `.bak.时间戳` 文件）再原地改写,只动关键词不动变量名/说明/body,转换引病会拒绝写回。用户说"把这份 spec 转成中文关键词/转回英文"就是要这个命令。**用户要改项目语言缺省**（"以后生成的都用中文关键词"）→ 改 `hopjit.yaml` 的 `language:` 键值——这是给用户干活的正当配置修改,改完口头确认一句"项目语言缺省已改为中文,之后 hopbuild 生成物与树读回都是中文关键词";改之前该文件里没有 language 键就加一行,有就改值,别的键一个不碰；
- 上面几条覆盖高频实撞坑；更复杂的形态（loop/case/for-each/类型面/中文关键词）**用时读引擎包内语法参考全量**（`<npm root -g 输出>/@hoplogic/hopjit/docs/concepts/HopSpec V3语法参考.md`——随包分发,源码库内同路径）——别凭印象写复杂结构，validate 报错拿着代号对文档改。

任务卡落 **`hop_tasks/<任务名>/<任务名>.md`**（一任务一目录——任务的材料/草稿/证据全住自己目录里,归档挪一个目录全走,不纠结多文件同步;卡文件与目录**同名**而非固定名 `spec.md`——Obsidian 双链按文件名解析,同名制下 `[[<任务名>]]` 照常可链不撞车）。**起名自动**：从任务话语提炼语义名,语言与用户话语一致（中文任务中文名——HopSpec 的中文标识符是一等公民;不转写不翻译）,撞名加日期后缀;`# Spec:` 标题即清单显示名。

**任务卡结构**——任务文件不是纯计划,是**计划+语境同体**的卡：spec 段落（Goal/Outputs/Steps——引擎读）之外,加叙事段落（人和 LLM 读,引擎无视,doc-ref 可引用进执行 prompt）：

```markdown
## 背景            ← 为什么干这活、来源、对话里已拍的口径（开工时写,口径变更时更）
## 参考            ← 材料链接、相关卡、[[双链]]（可省）
## 处置记录        ← 关键判断/口径变更/意外发现,逐条追加（行格式:
                     - YYYY-MM-DD <一句话>）——记"为什么",不记流水（流水在引擎账上）
```

**为什么**：跨会话续跑时执行状态引擎有账,但**语境**（为什么改版/口径是什么/上一段撞了什么）只活在对话里——对话没了语境就没了。卡式结构让新会话/复跑者读卡即接上;归档后计划+语境成对,总结有完整原料。**背景/参考等内容章节引擎缺省全程供给执行 LLM**（写进卡=喂给引擎,不需要任何引用或标记——2026-08-27 作者定'写在 spec 文件的内容章节就是缺省要供给的内容';处置记录是惯例名单成员天然不进 prompt〔2026-08-29 A 案:标题免带标记;其它想留给人的节用 `(不供给)` 显式标〕）。**处置记录是给下一个读者写的**,不是日志。

两条纪律：**节序**——spec 段在前、叙事段在后、处置记录恒居文件末（追加恒尾部,机械安全不碰契约区）;**计划镜像归引擎**——改计划（replan）后文件 Steps 节由引擎写回同步,你不手工改文件的 spec 段——写回落地前的过渡期,改完计划口头提醒用户"文件里的步骤节暂以引擎账为准"。

### 2. 自驱循环（你就是执行者）

**⚠️ 执行恒在当前会话——禁止调 `hopjit_start_run`，检测到 MCP 注册也不用，不管任务多大**（hopissues/0071 实撞立规 2026-09-04：driver 觉得"任务量大，交引擎自跑更高效"调了 start_run——引擎独立模式用裸 API 模型自跑，读两批原文即撞 1M 上下文墙，烧 6.2M tokens 后 retry 耗尽失败，最后还是回会话分批干完。教训：hop 的活是本会话的活，上下文在这里，效率判断不覆盖协议——`start_run` 是 MCP 独立模式的入口，永远不是 hop 的）。觉得任务太大想交引擎自跑？两条正路：在会话内分批做（大面积翻查外包 agent，见"步骤的注意力管理"）；或向用户明说建议改走 MCP 独立模式，用户点头才换轨。

**推进 run 用 hopjit 的复用驱动工具（todo/0146）**：hopjit MCP 的 `run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `status` / `resume` / `abort` / `validate` 七个工具，与同名 `hopjit` 子命令是同一套引擎调用、同一份响应。工具本身不调 LLM——返回的步骤仍由你在本会话里干完，再提交。与 start_run 的区别就在这里：start_run 让 server 自己的模型去干活，驱动工具只记账推进。参数是结构化字段，没有 shell、管道、引号转义，放行后推进不弹窗。opencode 的 MCP 工具名形态是 `<server>_<tool>`：下文写裸名的工具（`run`、`approve_commit` 等），实际调用名都带 `hopjit_` 前缀，如 `hopjit_run`、`hopjit_approve_commit`。"0. 分派"判定工具不可见时，用本节末尾"命令行回退"里的等价命令。

```
run(spec_path = "hop_tasks/<任务名>/<任务名>.md", workspace_dir = "<项目根绝对路径>")
→ step_ready: 步骤1，响应里有 instance_id、output_path 与 workspace_dir（起跑后把 workspace_dir 告诉用户一句："这个活在 <目录> 上跑"）
（就在本会话干活——该搜就搜、该读就读、该写就写,上下文全在）
submit_and_fetch_next(step_id = "1", instance_id = "<id>", output = {"sources": <值>})
→ step_ready: 步骤2 …循环到终态
```

- **`output` 的协议**（实撞:首提原始 YAML 被 JSON parser 拒）：传与输出槽同名的对象——步骤声明 `+ → weather_data % yaml` 就传 `output = {"weather_data": <值>}`，不是把值本身裸贴；大产出写到响应给的 `output_path`（work_zone 内）再传 `output = "@<该路径>"`（`@` 只贴最前面，路径须在 work_zone 内）。其余提交形态（`failure` / `replan` / `child_instance` / `tool_result` / `answer` 等）一次只给一个，字段名与 CLI 的 `--` 参数同名；
- `state_dir` 缺省 `.hopstate`，可省；`workspace_dir` 缺省载体拉起 server 时的项目根——**建议恒显式传会话启动时的项目目录**（server 的 cwd 用户看不见,显式传了响应与 hoplog 头里的 workspace_dir 才是你能向用户交代的那个值）；省略 `instance_id` 取最新实例，同时开着几个活时显式传；
- 响应原样就是完整 JSON，直接读，不截断不摘录；
- **commit 批准停点**：每个 `[commit]` 步骤第一次执行前，引擎先做安全分析：body 里的动作全部可逆或低危（新建文件、追加、建目录、移动、写入前已把旧版本留存进回收站的覆盖与删除、只写 work_zone 的写入）时直接执行，不出现停点，你什么也不用做；有动作会销毁内容且找不回（`keep: 0` 的覆盖与删除）、运行命令、发通知或调外部工具时，由 hopjit 配置的模型分析一次——模型判全部安全同样直接执行、以后不再问，否则转人工，响应是 `status: paused`、`pause_reason: commit`；本宿主没有分析模型（命令行 hopjit 不配置分析模型）或分析出错时也转人工。你自己不做安全判断。`presented_data.context` 带 `step_id`、`fingerprint`（指纹）、`analysis`、`body` 原文;`analysis` 是 `{summary, actions, recommendation, model, source}`——`actions` 每条有 `line`（动作所在的 spec 行号）、`category`（动作种类）、`verdict`（`safe` 或 `human`，`human` 是需要人确认的）、`consequence`（这个动作执行后的后果，已经写成不懂代码的人也读得懂的话）;`source` 为 `template` 表示没有分析模型或分析出错，后果说明来自固定模板。`presented_data.response_options` 是三个选项：`once`"只批准这一次"、`task`"这一步以后都通过"、`deny`"不批准"。大部分用户不懂代码，所以**代码不先贴**：先用一句话讲 `analysis.summary`，再逐条列出 verdict 为 `human` 的动作的 `consequence`，最后讲 `analysis.recommendation`;用户要看代码时再贴 `context.body`。然后用 question 工具（不可用时降级普通文本消息）给出这三个选项——**这一问就是批准**。对话里这一问就是批准，载体对 approve_commit 弹不弹窗与批准无关。用户选"只批准这一次"或"这一步以后都通过" → `approve_commit(instance_id, step_id, fingerprint, scope)`（`fingerprint` 取 `context.fingerprint`，`scope` 取所选项的 value：`once` 或 `task`），再 `resume(instance_id)` 续跑，引擎执行 body；用户选"不批准" → 不调 approve_commit，告诉用户这一步没执行，问是改 spec 重跑还是 `abort`。**禁止**替用户回答，也不许自己判断这一步安全就调 approve_commit——安全分析已经由引擎和分析模型做过，转到人这里只认人的选择。指纹只覆盖 body 原文，body 改了指纹就变，引擎重新分析、重新问。"只批准这一次"只在本次运行里有效：本次运行里 for-each 的各轮、并行子实例、续跑都不再停，下次运行这份 spec 还会再问;选"这一步以后都通过"之后，这一步的 body 不变就一直直接执行。提交前 HOP 的核验（check final）或确认（confirm）照常把关。被拒返回 COMMIT_NOT_APPROVED 时，报文里写着完整的 approve_commit 参数，照报文做（先按上面的方式讲给用户听并用三个选项问，用户选批准后再调）。带 body 的 commit 不能用 submit_and_fetch_next 提交产出（返回 COMMIT_BODY_ENGINE_ONLY），产出只能由引擎执行 body 得到；
- **目录批准停点**：任务卡（或 HopAnt 的入口 spec）在 `## Config` 的 `dirs` 里声明了项目之外的目录、而本机还没批过这份清单时，起跑后的第一个响应是 `status: paused`、`pause_reason: dirs`，`presented_data.context` 里有 `dirs`（一行一个：`path` 与 `mode`，mode 是 `read` 只读或 `readwrite` 读写）和 `dirs_hash`。把清单逐条给用户看（路径 + 只读/读写），一句话说清"这个活要碰项目之外的这几个目录，读写的那几个 commit 步骤会往里写文件"，问用户同不同意。同意 → 调 hopjit 的 `approve_dirs(instance_id, dirs_hash)`，再 `resume(instance_id)` 续跑；不同意 → 不批准，按用户的意思改卡（去掉或换目录）重跑或 `abort`。对话里这一问就是批准，每份清单只问这一次；载体对 approve_dirs 弹不弹窗与批准无关。**不替用户回答这一问，用户没明确同意不调 approve_dirs**。同一份清单批过一次后，重跑、续跑都不再停；spec 改了声明、或 Inputs 传了不同的目录，清单哈希变了会重新问。写任务卡时就知道要碰外部目录的，可以在起跑时带 `approve_dirs = true`（命令行 `--approve-dirs`）直接记账跳过停点——写卡的人就是批准的人。并行子实例与 call 子实例不再问：它们继承父的清单（引擎经启动命令透传），父批过即可；只有 call 的子 spec 自带 `dirs` 时它自己的首个响应才会再停一次，按同款处理；

**卡上已批准的命令有两种执行方式，核的是同一张清单。** act 步骤里，agent 临场拼参数、调 `hopjit_run_approved_command` 执行——这是探索态，随时可重跑。`[commit]` 步骤里，命令写在 body 里（写卡时定死），引擎到这一步直接执行，agent 不调工具——这是提交态，引擎保证 check final 或 confirm 已经过了，执行一次。两态的区别在步骤类型，不在清单。本段讲前者的调用方式。调用它不改变谁在干活：推理与产出仍在本会话。

调用形态（参数值的来源写死，不要猜）：

```
hopjit_run_approved_command(
  state_dir   = run 响应里 work_zone 路径的上两级（即 .hopstate 的绝对路径）,
  instance_id = 本 run 的 instance_id,
  argv        = ["python3", "scripts/ssh_exec.py", "--config", "configs/x.json", "exec", "node1", "nvidia-smi"],
  cwd         = 可省（缺省工作区根;在 worktree 或临时区里跑就传那个目录的绝对路径——任意目录都行,授权看的是 argv）,
  caller_step = 当前步号,如 "3.2"
)
```

argv 是列表，一项一个词，不拼 shell 字符串，没有管道和重定向。返回 `{returncode, stdout, stderr, duration_ms, truncated}`——非零 returncode 是正常返回，按业务判；stdout/stderr 各 64KB 截断并注明，要全文就让命令自己写文件再 read。每次执行的 argv/cwd/returncode/耗时都进该 run 的 hoplog，人不再逐条点批准，改为事后可查。

两种拒绝各怎么办：

- `APPROVAL_REQUIRED`（命令不在卡上）：**这不是让你换个办法跑，是任务的授权范围要不要扩，归人决定。** 停下来问用户一句，说清三件事：这条命令是干什么的、是可逆探索还是会留下不可逆后果、为什么这个活需要它。用户说批 → 把前缀加进任务卡 `## 已批准命令` 节，`abort` 当前 run，用改好的卡重新 `run`（授权清单在 run 起跑时拍快照，跑着改不生效；已完成的步骤都是可逆探索，重跑无害）。用户说不批 → 这一条走载体的 Bash，照常弹窗批一次。**不许自己把命令加进卡、不许被拒后改走 Bash 绕过。**
- `COMMAND_FAILED`（命令本身跑挂：超时、找不到可执行文件、输出撞上限）：按报文修命令或 timeout 再调，不换通道。

边界不变：`[commit]` 前置 check final/confirm、`confirm`/`ask` 停下问真人，一律照旧——run_approved_command 替代的只是载体逐条弹窗那一层，不替代卡上的闸；`hopjit` 自身恒拒。载体侧放行：`hopjit setup --carrier opencode` 已把 server 启用、把独立模式专属工具在 `tools` 节关掉,输出里的 `permission_note` 只剩一件事——在 opencode 里放行 hopjit 的 MCP 工具（按 `hopjit_<工具名>` 粒度）。没放行之前每次调用会弹确认;走到已批准命令那一步工具缺席（server 起不来）：停下按本段 APPROVAL_REQUIRED 同款处置问用户，不要改走别的通道。

- 过程 `[check]` 步（非 final）如实判——**这正是引擎存在的意义**：判 false 会带你的失败说明重跑，不许"觉得差不多就 true"；
- **`[check final]` 阅卷外移**（三权分拆：出题、答题在你，**阅卷不在你**）：走到 check final 时，只要会话有派 subagent 的能力（opencode 内置 general 子代理,常态在场），就**恒外移**给一个全新子代理判定，无自由裁量。为什么：自驱把"写计划的、干活的、判合格的"压进同一个你——自己出题自己答题自己阅卷，判据再严也总有能绕的缝。派法三条：
  1. 阅卷子代理拿三样：**待判产出物全文 + check final 的判据原文 + 任务卡的背景/参考节**——**不给执行过程叙事**：阅卷人只对着产出与判据判，不被"我为什么这么做"说服；
  2. 子代理回 ok/note 判定与理由，**向引擎 submit 的仍是你**（哑搬运——不改判、不软化 note；不服判定就修产出重来，不许换个说法再问一遍）；
  3. 无 subagent 能力时降级为判据硬化自判（见下条纪律，此时判据是唯一防线）；
- **check 判据编写纪律**（出题时刻锁死——写卡时你还没有交付压力，此刻写死的判据引擎起跑后就禁改）：判据必须是**执行者不能单方面满足的形态**——具体、可核对、指向产出物本身。**禁"或标注即可"式后门**；采信他人结论必须逐条给出采信理由，"同构""同理"不算理由；
- `[confirm]`/`[ask]` 停点**用 question 内置工具问用户**，等真人回答后注入（`submit_and_fetch_next(step_id, answer = {"value": "<用户给的真实值>"})`,命令行回退 `--answer '{"value":"<用户给的真实值>"}'`）——不替答；`presented_data.present_inputs` 非空时先把这些字段原文完整展示再问，不缩略；
- **终态呈现分两层**：**契约层**——outputs 全字段完整交付,不摘要不漏不改写,跨载体不变;**渲染层**——单一 `text/markdown` 输出用你自己的呈现长处直接展示（可读的答复就是答复,不必套 YAML 壳）,多字段/结构化输出保底 YAML 块防漏（多行字符串用 literal block）。**终态后顺手归档**——跑完确认交付即把任务目录挪 `hop_tasks/archive/`（归档规则写在管理节没人执行，动作提示挂在流程出口上）；
- **手机通知（用户要了才发——引擎挂点,driver 只翻译意图）**：用户话语有钉钉通知意图（"跑完钉钉通知我/钉我"——点名钉钉/钉渠道才算;光说"通知我"=对话里回话不推手机）或任务卡写明 → 起跑时带上渠道名（`run(..., notify = "dingtalk")`,命令行是 `--notify dingtalk`——值就是用户点名的渠道名）——渠道入任务的账,终态/停点引擎自动推卡片。**通知只在命令行推进时发出**（本版 MCP 驱动工具只记渠道不发送）：用户要钉钉通知的活,整个 run 用命令行推进。发不发判断恒归引擎（话语渠道×凭证二与门,无配置文件环节),你只翻译意图不自行拼发送。发送失败引擎留 `[notify]` 行 → 转告用户一句(多半是 DINGTALK_WEBHOOK 凭证没配)照常干活;

**命令行回退**（"0. 分派"判定 hopjit 工具在本会话不可用时）：每个驱动工具对应一条同名 `hopjit` 子命令，响应相同。全部子命令、参数约定与 /hop 话语→命令→MCP 工具的对应表见包内 `USAGE.md`（`npm root -g` 下 `@hoplogic/hopjit/USAGE.md`）。常用四条：

```bash
<CLI> --json run hop_tasks/<任务名>/<任务名>.md --workspace <项目根绝对路径> --state-dir .hopstate
<CLI> --json submit_and_fetch_next 1 --output '{"sources": <值>}' --state-dir .hopstate --instance <id>
<CLI> --json approve_commit <步骤号> --fingerprint <停点载荷里的 fingerprint> --scope once|task --state-dir .hopstate --instance <id>
<CLI> --json resume --state-dir .hopstate --instance <id>
```

- 每条命令只做一件事：不链式、不管道、不截断输出。`| head -c 400` 这类截断会触发载体的管道检查而多一次确认，还会丢掉响应后半截的字段（`instance_id`、`output_path` 常在后面）——响应再长也原样读完；
- 每条命令带全局 `--json`（缺省输出 YAML 给人看,机器消费显式要 JSON）；`--output` 的协议与工具的 `output` 相同，大产出用 `--output @<work_zone 内相对路径>`（绝不写进 JSON 字段值）；
- commit 批准停点同样会出现，而且命令行 hopjit 不配置分析模型，需要模型判的动作都会转人工停下（`analysis.source` 为 `template`）：与工具路径同一做法——先用大白话讲 `context.analysis`、代码不先贴，用 question 工具（不可用时降级普通文本消息）给出三个选项，用户选前两项后跑上面的 `approve_commit` 命令（`--scope` 取所选项的 value）再 `resume`，选"不批准"则不跑。对话里这一问才是批准，载体对这条命令的确认不算；
- 任务卡 `## 已批准命令` 上的命令：命令行没有 `run_approved_command` 的对应子命令,回退期间这些命令直接在终端跑——每条都过载体的确认,由用户当场逐条批准,代替工具路径上的事后查账。只跑卡上列着的命令（argv 以卡上某行前缀逐项开头）;卡上没有的照 `APPROVAL_REQUIRED` 那条处理,先停下问用户;
- 目录批准停点同样会出现：把清单（路径 + 只读/读写）给用户看，在对话里问同不同意，同意后跑 `<CLI> --json approve_dirs <停点载荷里的 dirs_hash> --state-dir .hopstate --instance <id>` 再 `resume`，不同意则不跑；起跑时也可直接带 `--approve-dirs` 跳过停点；
- 同一个 run 可以在工具与命令行之间切换（两者认领同一条驱动通道），新会话里工具恢复可用就换回工具。

### 2b. 步骤的注意力管理（缺省自驱，机械翻查可外包）

缺省**当前会话自己执行每一步**——上下文在场是 hop 的立身之本。两类例外（方向恰反，别混）：**check final 的判定恒外移**（上节"阅卷外移"——那是把裁量权拿走，不是省注意力）；**大面积机械翻查步可外包**（跨很多文件的核对/审计、长时间轮询等待、批量清点），全量结果灌回主对话会把后续步骤的判断力淹掉。这类步骤**在 subagent 能力可用时**可以派子代理承担**翻查半边**，规则三条：

1. **外包的只是翻查，判断与提交归你**——子代理带回"发现+证据+建议"，裁定真伪、决定怎么办、向引擎 submit 的永远是你；
2. **派活输入必须自带该步全部所需上下文**——子代理看不到本对话：把步骤契约（要产出什么）、对话里已定的口径、要查证的具体疑点写全再派。派完不自查同一件事（别重复烧）；
3. **拿不准某步算不算"机械翻查"就不外包**——判断类、创作类、需要对话语境的**执行**步骤永远留在当前会话（此条管的是"谁干活"；check final 的"谁判卷"归阅卷外移条管，不受此条豁免——判定恰恰必须离开执行语境）。

subagent 能力不可用时就全部自驱——/hop 本就缺省自驱，外包只是可选优化，没有降级仪式。

### 3. 进展呈现（核心体验面）

每完成一步，给用户一行：

```
✅ 1 查来源（3 源已取）
✅ 2 交叉核对
▶️ 3.1 写初稿…
```

用户随时问进度：调 hopjit 的 `status(instance_id)`（命令行回退：`<CLI> --json status --state-dir .hopstate --instance <id>`），渲染成上面的形态（机器 JSON 不直接示人）。

### 4. 边跑边改计划（主动 replan）

干到某步发现**后面的计划**不对：

```
submit_and_fetch_next(step_id = "<subtask-id>", instance_id = "<id>", replan = "<新的未执行部分 markdown>", proactive = true)
```

命令行回退：`<CLI> --json submit_and_fetch_next <subtask-id> --replan '<markdown>' --proactive --state-dir .hopstate --instance <id>`。

三条规矩（引擎强制，先懂为什么）：

- **只能改未执行的部分**——已做的是历史；正在做的这步做完再生效（发现当前方向就错了？那就别提交产出，改完计划再继续——效果一样且不需要新机制）；
- **`[check final]` 不许改掉或跳过**——改路径可以，拆把关不行（随时可改计划的自由，靠把关点不可动来定价）;
- 交付契约（Outputs）不许改——改策略不改目标。

### 5. 列 / 切 / 归档（多活并存的管理面）

**目录约定**（纯 driver 层，引擎零感知）：

```
hop_tasks/
  <任务名>/
    <任务名>.md      ← 任务卡（spec+叙事,引擎读它;与目录同名——[[双链]]可达）
    …               ← 该任务的材料/草稿/证据,自由放（任务的东西住任务的家）
  current            ← 当前活指针（一行 instance_id）
  archive/<任务名>/   ← 归档=挪整个目录（不删——历史即账;总结从这里捞原料）
  ants/<id>/          ← 项目级 HopAnt（总结 distill 的产物;与 ~/.hopjit/ants/ 同布局,查找时项目级先;非任务卡,list 不列它）
.hopstate/           ← 运行时状态照旧隐藏（机器账,人不直接读）
```

> **Obsidian/vault 增益**（零机制,天然获得）：hop_tasks/ 在 vault 内时,任务卡可被 hopspec 插件可视化（步骤大纲=进度概览、commit 橙色=风险点一眼可见）;材料引用直接写 `[[双链]]`——doc-ref 引擎语义与 Obsidian 双链本就是同一文法;archive/ 即可检索的工作史。

**`hop list`**（账驱动——任务↔实例的对应关系不另建映射，直接从引擎账上读）：

1. 扫 `.hopstate/*/state.json`，读每份的 `spec_path`（该实例执行的 spec 文件绝对路径）；
2. 只留 `spec_path` 落在本项目 `hop_tasks/` 下（不含 `archive/` 与 `specs/`——直接跑成品流程文件的实例不是"手头的活",不进清单）**且该任务卡现在还在活跃区**（`hop_tasks/<任务名>/` 下能找到同名卡——账上的 spec_path 是开工时的历史路径,归档挪目录不改账,光看账会把已归档的活误列回来）的实例；同一任务文件有多个实例时取最新的一个（state.json 修改时间最新）；
3. 对留下的每个实例调 `status(instance_id = <id>)`（命令行回退：`<CLI> --json status --state-dir .hopstate --instance <id>`）取进度（completed/total、current_step、是否停在确认点），渲染清单：

```
你手头的活:
▶️ 1. 调研X报告      3/5 步   ← 当前
⏸️ 2. 合同条款核对    1/4 步   (停在:需要你确认口径)
✅ 3. 周报            已完成
```

**切换**：说"hop 2"（序号）或 "hop 合同"（名字模糊匹配，多个命中就列出来问）→ 更新 `hop_tasks/current` → 展示该活进度 → 接着干。无参 hop 一声：有 current 续当前活；无则列清单问开新的还是接旧的。**current 失效自愈**：current 指向的实例查不到 / 文件已在 archive/ / current 文件缺失，一律按"无 current"走（列清单），顺手删掉失效的 current 文件——不报错不中断（指针是便利品，账才是权威）。

**归档 `hop archive <n>`（不是 delete——没有 delete）**：`hop_tasks/<任务名>/` **整个目录**挪入 `hop_tasks/archive/`（卡与材料一把全走——目录制的意义所在）；`.hopstate` 实例目录与 hoplog 一律不动（历史即账）。**归档的正是当前活时，同步删 `hop_tasks/current`**（不清会留悬空指针——下次说 hop 会续一个已收起的活）。归档的活不进 list 缺省视图（`hop list all` 可看）；想恢复就挪回来，账还在，续跑照常。跑完的活确认交付后同走归档（完成≠消失）。

**收没干完的活时，先问一句意图**（对用户零新词汇，一个"收起来"动作盖两种机制处置）：活还没跑完就要归档时，用人话问：**"这个活还没干完——是不要了，还是先收起来、回头接着干？"**

- 答**"不要了"** → 先调 `abort(instance_id = <id>, reason = "<用户的话>")`（命令行回退：`<CLI> --json abort --reason '<用户的话>' --state-dir .hopstate --instance <id>`）（把引擎账记为已放弃——不终止的话账上永远显示"进行中"，谎报状态），再挪目录归档。abort 是看不见的水管，**不向用户解释这个机制动作**。**废弃时若有半成品要交付**：交付物必须向用户标注"这活没走完最后的核对"——终检随实例消失了，这件事要对用户可见，不许把没把关的产出当正品交；
- 答**"回头再干"** → 只挪目录，账保留，恢复照续（上一段的承诺不变）；
- 活已干完 → 什么都不问，直接收。**收干完的活时顺口带一句**："这个流程要不要总结下来？下次同类活直接跑,也能分享给别人。"——对用户说话不先抛 HopAnt 这个词（作者 2026-10-10 定"元蚁概念还不流行"）;用户点头后不说过渡句,开头定位一句"总结成一个可复用的 Hop 流程元件（即 HopAnt）,落在本项目 hop_tasks/ants/ 下"（学名只在这一句括注一次,之后说"这个流程元件"或直接说 id）,紧接着给**人话摘要**让用户确认——这个流程叫什么、输入是哪几个参数、分几步各干什么、哪几步有把关（check / confirm / commit）;**spec 全文不贴**,用户要看才给（作者 2026-10-10 抓"你准备把整个 spec 显示给人看？"）;"先给你过目"这类预告也不说（过目是你要做的动作,不是要宣布的话）——一句话提示不强推，用户没接话就只归档（动作提示挂流程出口上，与"终态后顺手归档"同理）。

**中断与接续（plan 不随对话死——核心价值）**：对话断了/新会话，hop 一声即回到当前活的进度上继续。**不必特意点名 hop**：同一会话里活跑着，说"继续"就继续（协议在场）。**用户只说"继续"而话语没点名对象时**（新会话开口、或会话里刚干过别的事）：查账（current/status）发现有没干完的 hop 活 → **先跟用户确认一句再续**——"你是要继续《<任务名>》吗？上次干到 <进度>，停在 <哪步>"——确认了才续，不确认不动（"继续"可能指对话里别的事，猜错就是拿着别人的话头干自己的活）；明确说"继续上次的活/上次那个活到哪了"的，意图已点名，直接按无参 hop 走。

### 6. 总结：干完的活 → 一个 HopAnt（`hop distill <n>`）

一个活跑通了，你手里就多了一份**被实战验证过的流程**。总结把它从"一次性的任务卡"升格为**一个可复用的 Hop 流程元件（即 HopAnt）**,落本项目的 `hop_tasks/ants/<id>/`（作者定 2026-10-10"总结成 hopant,而且应该有项目级 hopant 位置"——以前先落一份裸 spec 再问要不要封,中间形态取消）——今后同类活 hop 分派直接命中它、`call <id>` 能调它、能装到别的机器、能分享。**触发从宽：用户的话里有"总结"的意思就主动做**——"总结一下这个活""沉淀下来""下次还要干这种事""固化成流程"，不必等 distill 子命令或"可复用"这种精确措辞（`hop distill <n>` 是显式形态，留给要指定对象的场合）。对象缺省=刚干完/最近归档的活；活没干完不总结——没跑通的流程没有"实战验证过"可言，先干完（用户对没干完的活说"总结"，多半要的是进展汇报，给汇报即可）。

**不只 hop 任务能总结——对话里直干完的活同样能总结（作者定 2026-08-28）**："把刚才这个 PR 审查流程总结成可复用的"——活没走 hop 管护、没有引擎账，也照总结。原料换成对话里的实际执行轨迹（真实走过的步骤序/中途撞的坑与修正/已拍的口径），四动作照做，外加一条 hop 任务总结没有的活：**步骤类型现判**——对话轨迹没有类型标注，哪步是不可逆动作必须标 commit、哪里该补 check，此刻按升格要点判。验证面如实降档：对话直干没有引擎强制的把关记录，总结出的 HopAnt 里的 check 是"该有"而非"验过"——诚实写明，不冒充与 hop 任务同级的实战验证。

**原料读三处（关键：拿终态，不拿初版）**：

- **任务卡的 Steps 终态**——replan 后引擎已把生效计划写回文件，这就是"跑通的那版"；开工时的初版只活在 git/hoplog 里，不是总结对象；
- **引擎账上的展开物**——`[subtask free]` 到步展开的实际子步只在引擎账上（status/hoplog，此场景属"用户要求复盘"，可以读）。这段结构这次跑出来若是稳定形态，固化为显式子步；本质仍是"到时候看情况"的，保留 free；
- **任务卡的背景/处置记录**——口径与"为什么"，供泛化时判断哪些是通用约束、哪些是这一次的专有语境；处置记录本身不带进 HopAnt。

**总结四动作**（先改出一份 spec 草稿,放任务卡目录下）：

1. **参数化**：这一次的具体值（对象名/路径/日期/阈值）提为 `Inputs`；实跑值降级为示范参数（写进输入注释，或并排放一份 sample 文件——examples 里 fact-check-sample 的同款形态）；
2. **结构固化**：展开物按上条判"固化 vs 保留 free"；这次没走到的分支（case else、失败路径）补审一眼——实战没验证过的路径，在草稿对应步骤的 `>` 说明里如实标注"未经实跑验证"，不冒充全验证；
3. **把关强化**：这次 check 打回抓过的缺口**写死进判据**——被实战抓过的坑是总结出的 HopAnt 里最值钱的资产，一次性任务里"下次注意"的教训在这里变成引擎强制；缺 check 的段落顺手补上（成品 spec 的把关标准只高不低）；
4. **语境泛化**：背景节改写成通用使用说明（这份 spec 干什么、输入怎么备、适用/不适用什么场景——内容章节缺省供给，写的就是未来每次执行的口径）；"这一次"的专有语境全部剥离。

**落盘与验收**：草稿先 `hopjit_validate`（命令行回退：`hopjit --json validate <文件>`）必须 0 error；草稿开头加一行指回原任务（`[[<任务名>]]`——出处可溯，归档目录里躺着完整的实跑原料）;`Id:` 行写语义名（小写字母、数字、连字符,就是将来的 HopAnt id）。**给用户过目确认后才落定**——总结是"发布"性质的动作：从此这个 HopAnt 会被反复跑，写错会被反复复制，这一眼比任何一次任务内 check 都值。过目的形态是人话摘要（名字 / 输入参数 / 步骤与把关点）,不是 spec 全文——用户要看全文才给。**摘要末尾的确认问句固定写"按此封装成 Hop 流程元件？"**（作者 2026-10-12 定——"封装"是这个动作的全名,"Hop 流程元件"是对用户用的名字）：不把本文给你看的机制词（"封""落""落定"）端给用户,也不换成"保存 / 可以用了 / 定下来"这类泛词——用户要的是一个指向明确的选择,不是一个模糊的催促。实撞：agent 照着下一段的旧文"封成 HopAnt"对用户问"封吗？",用户追问三次才问出一句人话。

**用户确认后,调 `hopjit_ant_pack` 把草稿封装成项目级 HopAnt**。调用方式（`spec_path` 传草稿路径,`out` 传本项目的 `hop_tasks/ants`——产物 `hop_tasks/ants/<id>/` **就地是活的项目级 HopAnt,不用再装**;spec 引用了同目录的知识文件会随包拷入，另有要带的文件放进 `assets`。命令行回退 `hopjit --json ant pack <草稿路径> --out hop_tasks/ants [--assets <文件>]`）。它会**对账入口 spec 的文件头**：从 act/commit 步骤的 body 里扫出实际调用的工具和 `subprocess.run` 的命令首项，与 `## Tools` 段、`## 已批准命令` 段比对，少声明的补上、多声明的删掉（标准工具 `web_search` 声明了就保留；`- 工具:` 授权行里的名字也算使用面，但内建工具名和 `*` 不算；act free / reason 步没有 body，它们的工具面只由授权行表达）。响应里 `pack.reconciled` 列出每一条增删——**把这张表读给用户看**（"总结时给 spec 头补了 X、删了 Y"）。**`tools_added` 里出现了非标准工具时要提醒用户**：补入的那一行是占位签名 `名(input)`，在别的机器装之前得按工具的真实参数改签名，不改的话适配会报参数不符（标准工具 `web_search` 补的是标准签名，不用改）。`HOPANT_DOC_MISSING` 错误（doc-ref 指向的文件找不到、引用越出 spec 所在目录、或 `assets` 的文件不存在）会拒绝不写——把缺的文件名告诉用户。封装完成后顺手调 `hopjit_ant_adapt` 核一遍适配（本机当然齐,写上适配戳,下次分派直接跑）。原任务目录照常归档，一动不动。

**修订同过目**：改一个已总结出的 HopAnt（复用中发现要改、或用户要求更新）——先把 `hop_tasks/ants/<id>/<id>.md` 拷一份 `<id>.orig.md` 再改,改完 validate 0 error + 用户过目确认才生效（改坏同样被反复复制）,再 `hopjit_ant_adapt` 重做适配。项目级 HopAnt 在 .gitignore 里不入 git，`<id>.orig.md` 是唯一一份备份。要给队友或别的机器 → 走下面的分享。

**分享：HopAnt → 给别人的包（作者定 2026-10-09 子卡 E）**。用户话语里有"分享/打包给别人/发给 X/发布"这类意思且对象是一个或几个 HopAnt（本项目 `hop_tasks/ants/index.md` 或 `~/.hopjit/ants/index.md` 里有的——本项目总结的不用先装到用户级就能分享）→ 调 `hopjit_ant_share`（`ids` 传 id 列表,`out` / `name` / `pkg_version` 按需;命令行回退 `hopjit --json ant share <id> [<id>…] --out <目录> [--name <包名>] [--pkg-version <v>]`）。这台机器**第一次**分享（`~/.hopjit/config.yaml` 还没有 `owner_id`）而调用又没带 `owner` 时，工具不写包，返回 `owner_prompt_required: true` 与 `owner_default`（缺省归属标识，形如 `用户名-主机名`）——**在对话里问用户**："分享包会带上归属标识 `<owner_default>`，用这个还是改一个？"用户答了带 `owner: <值>` 重调（用户说"就这个"也带，值取 owner_default）。成功后这个值记进 `~/.hopjit/config.yaml` 的 `owner_id`，之后再分享直接用它，不带 `owner` 也不再问（作者定的"答过不再问"）；用户想换标识时才带 `owner: <新值>`。它做四件核：入口 spec 头与目录一致、spec / 知识附件 / 脚本里没有凭证值（只许环境变量名）、本机面（`inner_store/`、`*.orig.md`）不在包里、有谱系的写谱系——任一不过即拒绝不写并点名文件行，把原因原样告诉用户。凭证那一核是三层证据综合研判（已知厂商密钥形态 / 高熵随机串 / 凭证键名加像密钥的值），只有强证据才拒；弱证据写进响应 `credential_scan.warnings`，包照常写——**把 warnings 逐条念给用户让人自己过一眼**，再把 `credential_scan.disclaimer` 那句原样告诉用户一次：这道扫描是启发式的尽力防线，不保证无漏，不把密钥写进 hop 文档和代码是用户自己的责任，密钥请经环境变量取用。产物 `<out>/<name>/`（`package.json` + `ants/<id>/…`）是目录形态的 HopAnt 包，用户要压缩自己 `tar czf`，要发 git 自己 `git init && push`——本版只做目录。

### 7. 决策：把待拍的板逐个说清楚，拍板过程存档（`hop 决策`，作者定 2026-09-04）

用户说 `hop 决策`（或"有什么要我拍的""待决策的过一遍"这类话）时，进入决策会话。三段式：**收集 → 逐个呈报拍板 → 存档**。

**① 收集待决策点**。扫当前对话里挂着的决策点（上报过但还没拍的、刚冒出来的），加上任务卡背景节/todo 卡里标了"待作者拍板/待拍/decision pending"的项。列个清单先给用户看一眼（一行一个,只写标题）："手头有 N 个要你拍的板：1…… 2…… 一个一个来。"没有待决策点就如实说"目前没有挂着的板"，不硬凑。

**② 逐个呈报，一次只呈一个**。每个决策点按元规范"上报决策上下文自足"四件套呈报，判据是**没跟着干活的人一遍读懂、不追问任何背景就能拍板**：

1. **问题怎么来的**——这个决策点从哪冒出来（哪次实撞/哪份报告/哪个改动被拦），来龙去脉讲全；
2. **现状事实**——盘点数据、涉及范围、已核实的机制真相。技术名词第一次出现就地解释（"保护壳（一个事务容器,作用是子树失败时降级兜底不炸整层）"这种写法）,不用只有干活的人才懂的代号；
3. **每个备选做什么、代价是什么**——不是只给标签：每条路展开说"选它之后会发生什么、要干哪些活、什么东西变好、什么东西变差、风险在哪、代价多大（能量化就量化）"。正反两面都说,不许把倾向项写得全是好话；
4. **倾向与理由**——明确说倾向哪个,理由逐条。

呈报后用 question 内置工具请拍板（列出选项,倾向项放第一个标"推荐",等用户回答）。**拍完一个再呈下一个**——不许把 N 个决策点挤进一条消息一把问完（用户对着一坨并排的问题没法逐个深想,这正是本机制要消灭的形态）。用户对某个点追问就地展开,追问后改了倾向如实改。

**③ 每拍完一个板,当场存档**。落 `todo/decision/`（目录不存在则建）,一板一文件,命名 `YYYYMMDD-<短语义名>.md`。内容结构（呈报原文+拍板结果全存,判据是三个月后翻出来不需要任何对话记忆就能看懂当时为什么这么定）：

```markdown
# 决策：<标题一句话>

- 时间：<date '+%Y-%m-%dT%H:%M%z' 取真实时间>
- git 版本：<git rev-parse --short HEAD>（<当前分支/detached>）
- 拍板人：作者
- 结论：**<选了哪项>**

## 背景（问题怎么来的）
<呈报原文第 1 部分>

## 现状事实
<呈报原文第 2 部分>

## 备选与代价
<呈报原文第 3 部分,逐案全文>

## 倾向与理由
<呈报时的倾向与理由;拍板结果与倾向不一致时,把用户改选的理由（用户说了就记,没说就写"作者未述理由"）单独一行记上>

## 拍板过程
<拍板时用户的原话/选项;有追问往返的,把追问与解答的要点逐条记下——追问暴露的信息缺口正是下次呈报要长记性的地方>

## 落地去向
<这个板拍完由哪个批次/哪张卡承接,落地后回填 commit 号——建档时先写承接处,落地补号>
```

存档后给用户一行确认："已存档 todo/decision/<文件名>"。全部拍完后收尾一句总结（拍了几个、各自结论一行、落地去向）。

三条纪律：

- **存档是给未来读者写的**,不是会话日志——呈报文字本来就按"零背景读懂"写,原样入档即可;禁止入档时压缩成只有当事人读得懂的摘要;
- **决策文件不改写历史**：拍过的板事后要翻案,新开一份决策文件记新板并在两份里互相指路（`翻案自/被翻案于 <文件名>`）,旧文件原文不动——决策档案是账,不是现行规则库（现行规则归设计文档与任务卡）;
- **git 版本号记录的是拍板时刻主区 HEAD**——决策依据的代码现场可回溯（`git show <号>` 即到当时）;若拍板发生在 worktree 语境,主区 HEAD 与 worktree 基线都记。

## 输出纪律

- **压缩后不凭记忆驱动**（skill 正文走对话通道，上下文压缩时会退化成摘要——协议细节最先丢）：发现自己对协议细节不确定（--output 怎么传、阅卷怎么派、归档先问什么——刚经历过压缩的典型体感），**先重读盘上的本 skill 文件再继续**，不凭模糊记忆猜协议。盘上真身恒新鲜，缺的只是"去重读"这个动作；任务状态本就不怕压缩（引擎账+任务卡在盘上，hop 一声 一声即接续）；
- **hoplog 分场景**：正常执行与状态判断**不翻 hoplog**（状态权威=引擎响应与 status，拿日志猜状态必错）；**用户明确要求复盘、诊断或审计时可以读**，引用过程证据要与 state/响应对账——日志是过程记录，不覆盖状态权威；
- 对用户零行话：不说 spec/介入点/replan/abort/实例，说"计划/需要你确认/改一下后面的步骤/这活还没干完"。
- **派活文字零黑话（2026-08-28 作者定——对 LLM 更要说人话,不是更可以省）**：给 subagent 的派活 prompt、任务卡、阅卷包判据，全部用完整的话写——判据、停止条件、命令逐条写全，不用只有写的人自己懂的缩写代号。LLM 对压缩表述的理解比人更容易出错且非常不稳定：人读不懂会反问，LLM 不会反问、按猜的理解直接执行且不出声，误解指令的 subagent 会带着错误理解跑完全程（实撞：看护 subagent 把"返回即下班"理解成可以中途交卷，两次误收工）。
- **读原料用只读文件工具，不走 shell（2026-10-11 作者抓"这些为什么要用 bash？"）**：分派、列活、切活、总结时要读的东西——两级 `index.md`、`hop_tasks/current`、`.hopstate/*/state.json`、任务卡的 Steps 终态与处置记录、HopAnt 入口 spec——全部是"看"不是"做"，一律用opencode 的只读文件读取 / 文件搜索 / 内容搜索工具（read / glob / grep）；`ls` / `cat` / `head` / `sed -n` / `grep -n` / `diff` 这类只读查看不经 shell。原因：载体对 shell 命令逐条弹窗，弹窗里是一坨管道，用户看不出你在干什么；只读工具免弹窗、意图可读。实撞：总结一个天气流程本来只要两次管理工具调用（`ant_pack` / `ant_adapt`），却为了找原料拼了七八条 `ls | grep` / `cat` / `diff <(…)`，每条弹一次窗。shell 只留给真正要执行的动作：任务卡《已批准命令》上的命令（走 `run_approved_command`）、build / 测试、git 的写操作。
