%% @trace
	id: hopjit-tutorial-dev-concept-to-design
	source: [[../concepts/工程实现链规范]]
	source_id: hop-engineering-chain
	type: compact
	last_sync: 2026-08-11T16:30+0800
	note: D 系列 1（2026-08-11 作者定向重写：不是人读代码,而是概念-架构-模块-设计HOP三件套+AI coding 为主线）——上半场：人怎么把"想造什么"逐层收窄成 AI 可忠实实现的设计（三件套表达）
%%

# D1 · 用 AI 做工程（上）：从概念到设计

**给谁**：读完 [[D0-生态开发者导读]]、要在 HOP 生态里做真开发的人。
**先说清主线**：HOP 工程的开发方式不是"人读代码、人写代码"，而是**人驾驭 AI 做工程**——人把"要造什么"沿着**概念 → 架构 → 模块 → 设计**逐层收窄，收窄到设计层用 **HOP 三件套**表达清楚，然后交给 AI coding（下篇 [[D2-用AI做工程-AIcoding与验收]]）。本篇讲上半场：怎么收窄、每层人干什么、AI 干什么。

## 核心心智：可行域逐层收窄

每一层的产出都不是"一个确定的点"，而是**合法解的可行域**——下层在域内继续定位，到代码层收窄成一个可执行的点：

```
概念层   我们在造什么、它必须怎样        ← 可行域的初始形状
  ↓ 收窄
架构层   分几层、组件怎么交互、边界在哪
  ↓ 收窄
模块层   哪个模块管这件事、对外接口是什么
  ↓ 收窄
设计层   契约/类型/流程写死（三件套）    ← AI coding 的输入
  ↓ 收窄
代码     一个可执行的点（AI 写）
测试     验证落点还在域内（AI 写、机检守）
```

**每层内部都有两类内容**：推演产物（由上层逻辑自动锁死——AI 直接做，不问）和决策点（真有多个合法选项——**人拍板**）。这条分界是整套方法的发动机：AI 能推演的全部交给 AI，人只出现在决策点上。

## 每层人做什么、AI 做什么

| 层 | 人（拍板者） | AI（推演者） |
|---|---|---|
| 概念 | 定系统身份：造什么、安全语义、行为规则（"关键原则与规则"是下层一切推演的链源） | 帮你把想法整理成结构定义 + 原则条文，但**核心观点必须来自你** |
| 架构 | 拍分层与边界的方向选择（改了它 = 造出不同的系统） | 从概念原则推演组件划分、交互协议，标出哪些是它推演的、哪些要你拍 |
| 模块 | 核模块边界与出口清单（对外接口封闭集） | 按架构推演模块职责、依赖方向，写模块设计文档骨架 |
| 设计 | **审**三件套是否忠实传达上层意图 | **写**三件套（这是 AI 的主产出，见下） |

## 设计层的表达标准：HOP 三件套

设计文档不用自由散文——散文 AI 会"理解偏"，三件套让 AI 无处偏。下面每件配一段真实设计文档的节选，看清"锁住"具体长什么样。

### 件一：Hop契约（HopTrait）——锁能力承诺

无 Steps 的 spec 形态（Goal / Inputs / Outputs / Constraints），回答"这个能力承诺什么"。看真例——mcp-server 的"重启后恢复 run"契约（[[../design/mcp-server#^anc-mcp-run-restore]] 节选）：

```
# Spec: 从快照恢复 paused run
Id: restore_run
Goal: server 重启后,把 .hopstate/<runId>/ 快照重建为注册表内可 resume 的 run
Inputs:
- run_id: line           # 待恢复实例 id
- state_dir: line        # 快照目录（缺省 .hopstate）
Outputs:
- entry: yaml            # 重建的 RunEntry（state=paused）,或结构化错误
Constraints:
- 快照不存在 → RUN_NOT_FOUND（真不存在,不误恢复）
- 快照损坏/凭证缺失 → RESTORE_FAILED（结构化返回,不炸 server;快照未动,修好可重试）
- 恢复后注入的 step_id 必须指向 confirm/ask 步骤——坏输入拒于状态变更前
```

**读它的方法**：Goal 一句话定使命；Inputs/Outputs 定数据形状；**Constraints 是灵魂**——每条都是一个错误路径的显式裁决（快照不存在怎么办、损坏怎么办、坏输入何时拒）。AI 拿到这份契约写代码时，**每个 if 分支都有出处**，不存在"我觉得这里该报个错"的发挥空间。你审它时逐条问：还有哪个失败情形没裁决？

另一个真例：[[../design/codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]（standalone 薄协议——注意它的 Constraints 怎么把"全程锁定、不切换执行体"写成不可违反的条款）。

### 件二：HopType——锁组件结构

组件的类型描述，**四要素**缺一不合格（描述规范权威：[[../concepts/HopType体系#^anc-hoptype-desc-spec]]）。看真例——ExecutionEngine 的定位节骨架（[[../design/exec-engine#^anc-struct-exec-engine]]，此处抽其结构）：

```
① 自身定位：ExecutionEngine 是 HopJIT 的执行状态机——驱动规约从初始化到终态。
   管理四件事：步骤状态机 / 变量空间 / retry-adaptive / 崩溃恢复
② 与其他 HopType 的关系：被 CLI（复用模式）与 Dispatcher（独立模式）驱动；
   状态经 PersistenceProvider 落盘；prompt 组装委托 PromptAssembler…
③ 主要 traits 与主要成员：（分组逐条——生命周期组 init/load/recover、
   调度组 next_step/complete_step/fail_step、访问器组…每个成员一句话职责）
④ 核心 impl 的主要 HopSpec 逻辑：（关键行为的流程表达，见件三）
```

**四要素各锁一个漂移点**：①防"它到底管什么"含糊（边界句必须写"管四件事"这种可数清单）；②防组件关系靠猜（谁驱动它、它委托谁，连线显式）；③防成员职责漂移（每个方法一句话承诺，AI 加方法时你能立刻看出"这不属于任何组"）；④防关键逻辑藏在代码里（升到设计层用件三表达）。**成员超过 5 个必须分组**——不分组的长清单没人真读。

### 件三：HopSop——锁关键逻辑，并逐条兑现契约

顺序/循环/分支 + 分层编号（用户教程 02 教的同一套语法，语法标准：[[../concepts/HopSop标准作业流程#^anc-flow-core-requirements]]）。看真例——restoreRun 的完整关键逻辑（**与件一是同一个能力**：契约定承诺，这里定怎么兑现）：

```
1. [条件(<state_dir>/<run_id>/state.json 不存在)] 返回 RUN_NOT_FOUND
2. ExecutionEngine.load(instanceDir) 重建引擎
   > load 保留 running——paused 的 confirm/ask 步骤即 running 态
   > 损坏即 RESTORE_FAILED
3. 用 server 当前 config.yaml 重建 HostConfig + 重建缺省 DirSpecProvider
   → engine.setHostConfig 重接
4. 新建 StepDispatcher（构造时从引擎回填 cumulative_tokens——预算跨重启延续）
5. 注册回内存注册表（state=paused）→ resumeRun 照常注入答案续跑

resumeRun 未命中分支:
[条件(runId 不在注册表)] restoreRun → 错误则原样返回,成功则继续
[条件(恢复的 entry 无 paused 载荷)] step_id 按 spec 结构预检
   （须为 confirm/ask,否则 INVALID_STATE 拒且保持 paused）
```

> 语法提醒：HopSop **只有**顺序、`[循环]`、`[分支]`+`[条件()]`、`[子任务]`——普通步骤不带任何方括号标注。它刻意**不含** HopSpec 的步骤类型（`[act]`/`[reason]`…）与数据流：谁执行、数据怎么流是升格为 HopSpec 时才补的（见用户教程 02 的对照表）。设计文档里若见流程块混入 `[act]`，那是笔误——两种语言的边界要守住。

**关键读法：流程逐条兑现契约的 Constraints**——把件一的契约拿过来对照，一条不多一条不少：

| 契约 Constraints 说 | 流程哪一步兑现 |
|---|---|
| 快照不存在 → RUN_NOT_FOUND | 第 1 步的条件分支 |
| 快照损坏 → RESTORE_FAILED（不炸 server） | 第 2 步附注"损坏即 RESTORE_FAILED" |
| Provider 不可序列化 → 用当前 config 重新注入 | 第 3 步（config.yaml 重建 + setHostConfig 重接） |
| 坏 step_id 拒于状态变更前 | 未命中分支的预检（INVALID_STATE 且保持 paused） |

这个对照就是**审 HopSop 的方法**：契约每条 Constraints 必须能在流程里指出兑现点——指不出 = 流程漏了裁决；流程里多出契约没提的行为 = 该回头补契约（自由发挥的苗头）。AI 写码时同理：流程五步是函数骨架逐条对应，附注是微契约（第 4 步的"预算跨重启延续"漏了就是设计代码不一致），验收沿这两层对照走。

### 三件怎么配合

一个能力的完整设计 = **契约（承诺什么）+ 类型（谁来承载）+ 流程（怎么做到）**。本节的贯穿样本 restore_run 三件齐全：契约裁决全部错误路径 → 类型约定"无新类型，复用 RunEntry"（不需要新结构也要显式说——沉默会让 AI 自由发明一个） → 流程逐条兑现契约并给出函数骨架。三个自由度全锁住，AI 剩下的工作就是忠实翻译——**"翻译成代码只是几个 if"正是设计改定的判据**。原文全貌见 [[../design/mcp-server#^anc-mcp-run-restore]]。

> **📖 读这些文档，强烈建议用 Obsidian 打开本仓库**（把 `hoplogic3/` 当 vault）：上面的 `[[双链]]` 与 `#^锚点` 都变成可点击跳转——点契约链接直达那一节、锚点反向链接一键看"谁引用了这条契约"、图谱视图直观看到概念→设计的派生网。纯文本编辑器里这些链接只是字符串，链的可导航性丢一半。

**为什么非要这三样**：AI coding 最大的失效是"发挥"——把你没说死的地方按它的想象补齐。三件套的本质就是把三个发挥空间（承诺、结构、逻辑）全部显式锁死。

## 锚点：把各层缝成一条链

每条设计契约带 `^anc-*` 锚点，代码实现点标 `@a: anc-*`，测试验证点标 `@v: anc-*`，`TRACEABILITY.md` 汇总成卡。这不是文档卫生——它是**人驾驭 AI 的缰绳**：

- 给 AI 派活时，让它先**收链**（沿锚点把前序契约、依赖、波及面收齐）——AI 在可行域内工作而不是凭记忆发挥；
- 验收 AI 产出时，沿同一条链核对——设计说的、代码做的、测试钉的三层是否对齐；
- 一条实用命令顶过通读：`grep -n "<锚点>" TRACEABILITY.md` 开卡看全链。

## 动手练：给一个真实模块走一遍"读设计"

拿 `docs/design/doc-ref.md`（163 行，五脏俱全）验证你已建立的视角：

1. 开头**分级表**——哪些节是【契约】（锁死）哪些是【说明】（可读可跳）；
2. **定位节**——这就是 HopType 四要素的实例：它是什么、跟 parser/engine 怎么连；
3. 找一条【契约】节读——注意它如何把行为写死到"AI 没有发挥空间"的程度；
4. `grep -n "anc-exec-doc-ref-resolve" TRACEABILITY.md` 开卡——看这条契约在代码与测试的落点。**你不需要读那些代码**——你需要知道的是链在、可核。

## 下一步

[[D2-用AI做工程-AIcoding与验收]]——下半场：设计改定之后，怎么给 AI 派活、AI 按什么纪律写码写测试、人怎么用机检和链验收。
