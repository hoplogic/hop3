%% @trace
	id: hopjit-parallel-execution
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-17T22:57+0800
	note: parallel 执行设计。§U 现行权威。2026-08-11：P0/P0.5/P2 交付+真机九场景验收过；P1 生产可靠四契约设计定形（对账/超时/协作中断/收割入轨），第三件 paused 让名额摘除归 HITL 挂账。
%%

# Parallel 执行设计（统一模型：步骤级异步派发）

> **⚠️ 2026-08-10 统一模型注记（读本文必先知，覆盖 2026-08-07 注记）**：概念层已定形 **parallel 统一模型**（[[../concepts/HopSpec V3核心规范#^anc-step-parallel]] + [[../concepts/HopSpec V3核心规范#^anc-exec-gather]]，五项作者拍板见 [[rounds/call-parallel-草案]]）：parallel = **subtask/call 的 callee 并发申报 + 步骤级异步派发**——主线到标注步骤即派出、容器边界收齐；`loop for-each ... parallel` 循环头属性与"静态并行组"读法**已废除**。**本文 §U 为现行设计权威**；§1-§10 是旧通道（静态 fan-out→批量窗口→单点 join）的设计，**语义上是统一模型的退化特例，处于退役期**——代码迁移完成前锚点与机制描述保留（现行代码仍照其运行），迁移完成后归档。新旧冲突时以 §U 为准。

> **关系**：本文是 [[exec-engine#决策 4]] 的展开稿。文法与静态校验归 [[spec-parser]]；worker 上下文规则归 [[prompt-assembler]]。

## §U 统一模型（现行权威，2026-08-10） ^anc-exec-gather

> 概念权威 [[../concepts/HopSpec V3核心规范#^anc-exec-gather]]（并发执行模型六条）在设计层的整体落点即本节 U1-U7。

### U0. 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|---|---|---|
| U1 派发与收齐语义 | 【契约】 | ^anc-exec-parallel-dispatch-model |
| U2 在飞记账与名额 | 【契约】 | ^anc-exec-parallel-inflight |
| U3 收割与收齐 | 【契约】 | ^anc-exec-parallel-reap-drain |
| U4 失败路径杀活 | 【契约】 | ^anc-exec-parallel-kill |
| U4b 子实例 HITL 队列 | 【契约】 | ^anc-exec-parallel-hitl-queue |
| U5 推进条件放宽 | 【契约】 | ^anc-exec-parallel-advance |
| U6 测试正反例矩阵 | 【契约】 | ^anc-exec-parallel-test-matrix |
| U7 迁移与分期 | 【决策】 | — |
| U8 复用模式渐进协议（P2） | 【契约】 | ^anc-exec-parallel-reuse-protocol |
| P1 生产可靠四契约（U2/U3/U4 内嵌） | 【契约】 | ^anc-exec-parallel-inflight-reconcile / ^anc-exec-parallel-timeout / ^anc-exec-parallel-abort / ^anc-exec-parallel-reap-log |

### U1. 派发与收齐语义【契约】 ^anc-exec-parallel-dispatch-model

**能力契约（HopSpec 契约）**：

```
# Spec: unified_parallel_dispatch
Goal: 主线串行推进中，对标注 parallel 的步骤（subtask/call）异步派发子实例；
      容器完成条件 = 主线走完 ∧ 本容器派出的子实例全部终态并收割。
Inputs: 容器（subtask/loop 任意）、标注步骤、max_concurrent_workers（系统配置，缺省 5，含主线）
Outputs: 标注步骤输出经容器边界导出（loop→collect 列表；subtask 容器→头部具名 + →）
Constraints:
  - 派发时入参快照当时值（resolveCallParams/resolveChildParams 同源）
  - 名额=max_concurrent_workers，主线占 1 路；满员时主线阻塞在派发点
  - 标注步骤输出容器内不可消费（S12 静态拦，无 Future）；标注步骤不可消费其他标注步骤的输出（在飞）；未标注主线步骤输出照常可用（派发时快照——流水线前提）
  - 未标注步骤主线同步执行，不等在飞子实例
  - 配 1 = 全部标注退化为主线同步执行（全串行，语义等价——顺序模拟等价性）
```

**统一覆盖三形态**（同一机制，无分支实现）：循环体内标注→渐进流水线；兄弟混排→标注者并发、未标注者主线做；兄弟全标注→原静态组效果。

### U2. 在飞记账与名额【契约】 ^anc-exec-parallel-inflight

**类型约定（HopType）**：

StateFile 增可选字段 `inflight: [InflightCall]`——随既有 writeAtomic + load 通道持久化，不设独立文件。

```
struct: InflightCall
  Id: inflight-call
  Fields:
    - step_id: line         # 标注步骤 id（call 或 subtask，两派发单位共用本账）
    - iter: number          # loop 体内派发时的迭代序号（1 起）——子实例目录后缀、collect 序；兄弟位恒 1
    - child_instance: line  # 子实例 id：<step_id>.<iter>（目录：call→calls/<ci>/，subtask→parallel/<ci>/）
    - host_container: line  # 收齐点/杀活域＝最近的**任务容器**（subtask/case/loop）祖先（2026-08-13 作者定形）：case 就是 branch 下的 subtask,自身即事务即边界;branch 是唯一透明结构（[case parallel] 被派发时边界穿过 branch 落上层任务容器）;loop 无远程特权——中间隔着 subtask/case 时边界收窄到最近那层。推演根据=失败走边界 retry,边界越过更近事务则 retry 归属随远处结构漂移（抖动）,事务语义失效。同根据废弃"声明驱动穿透边界"候选（B 案:边界=沿 + → 声明链的最近声明容器,中间容器透明——穿透使失败上报越过就近事务,retry 归属抖动;讨论记录 2026-08-13,不再重议）
    - dispatched_at: line   # 派发时刻（ISO 时间戳）——crash-resume 账龄二分与超时判定的基准
    - status: line          # 枚举 inflight/killed——killed=主线失败清场终态；paused（让名额）随并行 HITL 增补
    - params: yaml          # 可选。派发时入参快照（2026-08-13 随 stale_launch 增——重拼启动命令必须用派发时值:loop 推进后 itemVar 现值≠派发时值,现算必错〔实测 iter1 重拼吃到 iter2 的值,[21,21]〕;老账无此字段时现算兜底）
```

（TS 形态是代码层投影，在 src/runtime-types.ts `InflightCall`——设计以本 HopType 为准。）

- 派发即原子落盘（防重，`dispatched` 既有语义扩展）；终态子实例收割后移出 inflight；
- 名额判定：`len(inflight where status='inflight') < max_concurrent_workers - 1`（主线占 1）；
- **crash-resume 在飞对账（P1 ✅ 设计定形）** ^anc-exec-parallel-inflight-reconcile：load/resume 后对每笔 status='inflight' 的账读子实例 `state.json` 判终态，三分支——
  - **已终态未收割** → 补收割（`reapFromChildDir` 现成——值在盘上，纯捡账，两模式同一入口）；
  - **未终态** → 重建：独立模式重起子 Dispatcher 续跑子实例（子实例自身恢复走既有 `ExecutionEngine.load`+resumeSpec；worker 门不开）；复用模式不重建进程——`advance`/`reap_and_fetch_next` 对账后响应附 `stale: string[]` 清单（**DrainWait 与 DispatchReady 都带**——2026-08-13 随 dispatch-lost 降级补：对账后主线若还有活可派,响应是 dispatch_ready,stale 只挂 drain_wait 就丢了;driver 契约=任一响应见 stale 即自查），driver 对清单项重起 worker（**如实注**：run 子实例入口撞已有目录是**重新 init 从头跑**、非断点续跑——act 可安全重做语义下结果等价,半跑状态被覆盖;真断点续跑待需求再立。2026-08-13 review 实测修正原'续跑'措辞）；
  - **子实例目录不存在** → 按账龄二分（2026-08-11 真机实撞修正：复用模式 worker 是 driver 异步后台起的，advance 续推时目录未建是**常态启动窗口**而非崩溃——无宽限期即误杀启动中的活，首轮真机 cc:parallel 实红）：
    - 账龄 ≤ 启动宽限期（`DISPATCH_GRACE_SECONDS=60`，常量——覆盖 subagent 启动延迟的保守值）→ 视为启动中，保持在飞（drain_wait 正常等待，不判死不判 stale）；
    - 账龄 > 宽限期 → **两模式分道**（2026-08-13 作者批准，真机二撞修正：cc:parallel-partial 中主 agent 收到 dispatch_ready 后合法耗时 67s 才起 worker——读文档/思考没有上界，固定宽限必然再撞；引擎单凭墙钟判"driver 有没有派活"是判不了的，**只有 driver 自己知道起没起**）：
      - **独立模式**（dispatcher 自己派发自己监护，启动=进程内动作有确定节奏）→ 判 failed 收割（FailRecord 注明 dispatch-lost），不留悬账——60s 判据成立；
      - **复用模式**（unifiedDispatch 经 CLI 通道，启动归外部 driver）→ **降级入 stale 清单**交 driver（与"未终态重建"同通道）：driver 对 stale 项自查——没起过就起：**响应同带 `stale_launch`（childInstance→launch_command 映射,引擎按账面 step_id/iter+params 重算重拼）**,driver 原样执行零手拼（与 dispatch_ready 同纪律;review 抓缝 2026-08-13:原'从 dispatch 事件重取或按协议重拼'两条路 driver 都走不通——launch_command 不落盘无从重取,手拼正是 fanout 代码化要杀的易错面）。起过就等。引擎不判死；活真丢了（driver 也认领不了）由 driver 用 `reap_and_fetch_next --status failed` 显式报败收割（下条"谎报失败只是放弃产出"容错通道现成）。**判据=模式**：`unifiedDispatch` 开而进程内无派发句柄（CLI 进程天然如此）即复用模式档；
    - 原单一"超宽限即 dispatch-lost"判死对复用模式作废——健康但起得慢的活被误杀，杀的恰是本该活的（真机实证：三路并行死的是 sale=3200 正常路，预期失败的 bad-data 路反而按设计走完）；
  - killed 项恒不复活（既有）。合理性：账面(原子落盘)+子实例状态(各自独立落盘)两真值源都在，对账是纯读合并——无新持久化状态，崩溃窗口不扩大。mcp-server restoreRun 接同一入口。正反例矩阵行 14。
- **显式报败对目录缺失的容错（复用模式收割入口）**：driver `reap_and_fetch_next --status failed` 而子实例目录不存在（worker 未启动/启动即崩溃）→ 合成 FailRecord 收割，不因缺盘面崩溃。不对称是有意的：**谎报成功会捏造产出，谎报失败只是放弃产出**——集合语义可容，故"failed 报告即权威"而"completed 报告须盘面为证"（目录缺失时 readVars 响亮报错，不静默算空产出）。正反例：报败无目录合成收割/报成无目录响亮报错。

### U3. 收割（随到随收）与收齐（收尾等待）【契约】 ^anc-exec-parallel-reap-drain

**关键逻辑（HopSop）**：

```
1. [act] 派发：主线到标注步骤 → 名额检查
  1.1. [case(有空名额)] 快照入参 → 建子实例 → inflight 记账落盘 → 启动 → 主线继续
  1.2. [case(else)] 主线阻塞于派发点，等任一在飞终态（收割腾名额）后回 1.1
2. 随到随收（贯穿全程，任一子实例终态即触发）:
  - completed → 取输出：loop 体内按 iter 写 collect 缓冲（不进轮级 scope）；
    兄弟位写容器 scope 的声明输出
  - failed 分两形态（2026-08-13 作者定"收割即 fail"——具名输出无部分可言,值空间零形态）:
    - loop collect 位 → 不贡献元素（列表变短）,FailRecord 加壳记容器级附件,名额腾出（失败 warn 挂宿主容器 id——标注步骤在父账上无 start〔派发不 start〕,挂步骤 id 成 orphan 行,0018 顺手修）
      ——唯一的部分失败例外（作者选集合语义时显式接受）。**全灭升 fail（2026-09-06 作者令"现在修"——dv-batch 七子实例全灭主线照 completed 空 reports 实撞,用户跑批量任务全死账面报完成）**:派发>0 且该批 collect 收集数=0 时,例外条款不适用（集合语义容忍"少几个"不容忍"一个没有"）——宿主 loop 当场 failStep,reason 携派发数+各子 FailRecord 摘要（首 200 字/条）,走既有升级链（祖先 retry 整组重跑=重派发;顶层无人接=实例 failed 诚实终态;祖先 on fail 照激活语义接住善后——与兜底步失败上下文供给 ^anc-exec-onfail-context 天然联动）。0 派发（输入列表空）不触发——空输入合法非全灭。多 collect 对任一为空即判（同批派发共命运）。退化窗口同判同语义（B 裁决:调度形态不改语义） ^anc-exec-parallel-allfail
    - 兄弟位具名输出 → **收割那一刻边界容器把该派发步骤记 fail**：杀域内其余在飞活
      （既有清场,兄弟活反正随边界重跑,跑完是白烧）→ 走边界容器自己的 retry/升级链。
      下游要么看到边界修复后的真值,要么根本不运行——无占位符无哨兵 None
      （原"兄弟位输出缺席走 None 传播"读法作废：None 不携带错误语义,静默失败比崩溃更隐蔽）。
      retry 归属恒=最近边界,永不抖动（收敛边界定形的推演根据）
3. 收齐（容器边界）：主线走完（兄弟序列尽/迭代尽/break）→ 等 inflight 排空
  → collect 缓冲按派发序写列表 → 容器 settle
4. 全模型仅两个等待位置：1.2 派发点、3 容器边界（S12 无 Future 禁令保证无第三个）
```

- **收割按声明产出链投递——parallel 只改时机不改拓扑（2026-09-04 作者三轮纠偏定形,决策档案 todo/decision/20260904-parallel收割须兑现声明产出链.md;D80 实撞:hopbuild2 的 loop>subtask retry=0 壳>call parallel 三层合法形态,旧收割抄近道直连"最近任务容器"的 collect——壳无 collect 值静默蒸发〔全成功也丢产物账面 completed〕、失败不投递回壳 on fail 兜底成死代码、迭代号从壳取恒 1 撞名互覆,探针三坑实证）** ^anc-exec-parallel-reap-chain：子实例终态回来时,产出/失败**写到 call/subtask 标注步骤在声明链上的位置,从那里继续执行包围容器该走的剩余路**——成功:mapCallOutputs 写步骤所在容器作用域→步标 done→既有完成传播逐层走→中间容器（如事务壳）完结时边界产出自然聚合→到达 loop 层由既有 collect 机械收;失败:failStep 语义投递回标注步骤→包围容器事务机制接手（retry/on fail 照常——壳的兜底走完照常聚合上行,U3 HopSop"兄弟位记 fail 走升级链"即本路径在兄弟位的自然特例）。收割不再直连循环缓冲——缓冲只是链条末端的实现细节。**call 直挂循环体的既有形态是本链的零中间容器特例**,行为不变（退化等价性:矩阵 2/16"配 1 与配 5 语义等价"两侧同基准）。子实例编号随派发时迭代上下文取（沿祖先链找 **loop** 祖先的计数器,非最近任务容器——壳无循环计数,旧取法恒 1 撞名）,撞名响亮拒非幂等短路。收齐点/杀活域判定不随本条改（仍=最近任务容器,U1 2026-08-13 作者定形——一处判定两种用途,本条把"收割投递/编号"两用途从中拆出走声明链,防再混）。**call/subtask 两种标注步骤同链同修**（首版只改 call 侧被阅卷 D2 探针拦下——契约主语本就是两种,subtask parallel 隔壳形态三坑同构:dispatchParallelSubtask 编号沿 loop 祖先/reapParallelSubtask 喂缓冲沿 loop 祖先+壳作用域写值+待喂账,与 call 侧同机制）。**喂缓冲/待喂账恒先于完成传播**（阅卷 D1 实抓——传播级联在末迭代触发 loop finalize 合并缓冲,后喂元素成孤儿恒丢;晚收割时序〔主线已 drain_wait〕必现,与 completeCallStep 既有"先喂后 complete"次序对齐）。待喂账 pendingChainFeeds 随快照持久（复用模式每命令一进程,失败投递与兜底走完必然跨进程——不持久=兜底产物跨进程半边照丢〔阅卷 D3〕）。**待喂账按收集对记账**（复阅实抓双重喂送后收窄——账目携 unit_var/list_var,兑现只喂账上点名的那一对且值为 null 同挡不入列;记账只对"壳声明了且属 getAsyncUnitVars 异步集"的收集对——已直喂的对不记〔再记=元素翻倍〕,串行兄弟步产的对归轮末传送带不记〔记了=收两遍;未写壳作用域时兑现穿透读 root 残值=幻影 null 入列〕。宽版语义"壳边界声明的被收集变量走待喂账"作废——照宽版重实现必重造双重喂送,复阅双探针〔双收集对×早/晚收割时序〕即验收判据）。配套静态检测归 [[spec-parser]] S16（collect 供给核+链条逐环核——写时抓"spec 真断链",本条管"链齐必须走通",两半合拢消灭静默地带）。
- collect 收割点从"轮末"移到"子实例终态时"——串行步骤产出的单项仍轮末收，标注步骤产出的单项随收割收（两通道汇入同一 collect 缓冲，按迭代序排）；
- **退化窗口的 collect 等价（BUG-B `^todo-bug-parallel-collect-serial` 修复落点）**：`getAsyncUnitVars` 把 parallel 标注步骤的输出判为"异步"（轮末传送带跳过，值须经 `__reaped_<listVar>` 缓冲汇入）。派发路径由 `reapParallelCall/Subtask` 喂该缓冲；**退化窗口（unifiedDispatch 关/配 1 同步退化）下 parallel subtask 按普通容器串行执行、无 reap 可喂**——故串行完成时引擎把其声明输出按 `[iter, value]` 喂最近 loop 的 `__reaped_` 缓冲（与收割同一通道），保证"顺序模拟等价性"成立（串行驱动下 collect 不空）。call parallel 的同步退化由 `completeCallStep` 喂同缓冲，先例对称。**失败路径同语义（B 裁决 2026-08-11 作者定：调度形态不得改变执行语义）**：退化窗口失败路径同样按部分失败集合语义——parallel subtask 重试耗尽（`markSubtaskFailed`）/parallel call 子实例终态失败（`failCallStep` 同步退化分支）时**就地消化不升级宿主**：记 reap 事件+warn、不贡献元素（collect 列表变短），主线照常推进——与派发路径"派发即推进+失败收割不贡献"同构。**此条仅限 loop collect 位**（2026-08-13 随"收割即 fail"收窄）：兄弟位具名输出失败在两种调度形态下都=边界容器该步 fail 走 retry/升级链（原"输出缺席走 None 传播"作废——等价性以新语义为基准两侧同改，调度形态不改语义的裁决不破）。**worker 子实例执行 parallel subtask 自身（subtreeRoot=该步）不适用**：那是子实例内部视角，须正常终态失败交父实例收割（否则失败被吞、父实例收到假 completed）。**升级链围栏（hopissues/0018 实装违约补条款）**：worker 内失败升级链**不得越过 subtreeRoot**——找重试预算的祖先 walk 以 subtreeRoot 为界,subtreeRoot 自身耗尽=实例终局 failed（走'无事务边界祖先'终止分支）;越界找到子树外祖先 subtask 的后果链=resetSubtaskForRetry 把 executeSubtreeOnly 预标 skipped 的子树外步骤整树放活→worker 越围栏重跑全 spec（拿空数据跑成假 completed）→内祖先 loop 轮末传送带把 unitVar 复位 null 写 root→父收割 completed+vars 含 null→collect 收 null 占位（hopkb 11 讲批实录 marked=[null×6]——'全失败'伪装成'合法空产出',正是本条要防的假 completed 的实现形态;orphan recordStepDone/Failed 同根——子树外步骤从未记 start）。凭据不丢：内层失败步骤的 FailRecord 已在同实例账上（派发路径对应物=子实例目录的 FailRecord）。三条实现契约（2026-08-11 review 探针实撞定形）：**①账面形态=done+FailRecord 凭据**（镜像派发"派发即推进、收割另账"——标 failed 会让宿主 loop 提前终态化吃掉后续迭代，与主线继续矛盾）；**②失败报告过状态门**（failCallStep 退化分支同 failStep 的 running 前置检查——绕门后 driver 重复报败会把下一轮 pending 的同 id 步骤再消费一次，loop 双倍推进静默吞迭代）；**③重试预算按迭代独立**（派发路径每子实例=全新实例各自预算；退化窗口同一节点跨迭代复用，就地消化时清 retryCounters/retryHistory——否则 iter N 耗尽的残留计数让 iter M 首败即判死，本可重试成功的迭代被吞）。矩阵行 16"配 1 与配 5 语义等价"在失败输入下恢复成立。
- **收割/收齐入轨（P1 ✅ 设计定形，观测完整性）** ^anc-exec-parallel-reap-log：`reap:` 块（child/status/at，随到随收逐条流式 append——对称 dispatch 块先例）+ `settle:` 块（容器终态化时刻+已收清单）。记录点在引擎 reapParallelCall/Subtask 与 settleHostAfterReap（两模式共用）。合理性：派发已入轨而收割不入轨=G11 对收割段全盲（真机 audit 断言只能靠账面反推）；流式 append 与缩进机制全现成。落点归 [[spec-observability]] 登记同批锚点。**全灭警示线的演进**：2026-09-01 首立为 hoplog warn（"可见性不改行为"——5/5 全灭与 0 派发账面原不可分辨）;2026-09-06 升为行为面 fail（集合语义节全灭条款）——warn 保留作观测轨迹,处置权威归集合语义节,本契约只管入轨。
- 独立模式等待原语=进程内 Promise（泳道池先例 [[step-dispatcher#^anc-exec-standalone-parallel]] 改造）；复用模式=`dispatch_ready` 介入形态交 driver（P2，先例 `fanout-next` 的 wait 响应）；
- **单活超时腾名额（P1 ✅ 设计定形）** ^anc-exec-parallel-timeout：`resource_limits.parallel_child_timeout_seconds`（**缺省不超时**——显式配置才生效，与"paused 永久有效"哲学共存：超时管 running 卡死的活性检测，不管等人）。判定=惰性：引擎在名额检查/收齐检查时按 `now - dispatched_at` 判超时项 → 判 failed 收割腾名额（FailRecord reason 注明 timeout，fail_kind=error）。**启动窗口让位**（2026-08-11 review 探针抓漏）：子实例目录未建且账龄 ≤ `DISPATCH_GRACE_SECONDS` 的项不判超时——目录未建谈不上 running 卡死，启动窗口归宽限期管（否则 timeout<grace 配置下启动中的活被超时误杀，与 U2 判死路同一竞态的第二条进路）；目录已建的项照常按账龄判。**两模式语义差（如实声明）**：独立模式 drain 等待带轮询 timer（配置了超时才轮询——卡死的活句柄永不 settle,timer 让下轮 sweep 有机会收割,粒度=min(timeout,5s)）；复用模式的活是外部会话、引擎无法主动打断——只能在下次被调用时按账判，"超时的活"若后续真回来，reap 撞已收割账幂等丢弃（同 killed 短路哲学）。合理性：dispatched_at 已在账，判定零新状态；缺省关闭零行为变化。正反例：超时收割腾名额继续派发/未配置永不超时/迟到结果丢弃。
- **收割命令分工判据（2026-08-31 hopissues/0046 教学面归因后立正面条款——此前判据全库无正面陈述,连报告方 runbook 都归纳错成"loop/非loop"）** ^anc-exec-reap-scope：`reap_and_fetch_next` 与 `submit_and_fetch_next --child-instance` 按**有无 parallel 标注**分工,不按 loop/非 loop 分：
  - **带 `parallel` 标注的 [call]/[subtask]**（引擎 dispatchParallelCall/Subtask 派发、dispatch_ready 吐给 driver 的 child）→ `reap_and_fetch_next` 收割——它依赖派发时登记的在飞名册（inflight）,收割走 reapParallelCall/Subtask 喂 collect 缓冲;
  - **无 parallel 标注的 [call]**（普通 call、串行 for-each loop 体内的 call 都是——串行 for-each 不触发派发,无在飞名册）→ `submit_and_fetch_next <call步骤号> --child-instance <子实例>` 收割——走 completeCallStep(无门控)按 output_mapping 回填父变量,loop 场景由 completeStep 级联做 collect 累积与迭代推进（串行语义:一轮收完才起下一轮,与 Python for 循环同构;迭代账全在父实例,子实例目录只是单轮作业本）。
- **reap 对无名册调用响亮拒（2026-08-31 hopissues/0046 修——原静默 no-op:reapFromChildDir 找不到 inflight 条目直接 return,误用方以为收割成功实则输出全丢,报告方在 hopbuild2 调试链上烧 30 分钟定位;误用是文档教出来的——本文档与 hop-cli.md/driver skill 均只教"通知到达就 reap"未教前提,上条判据同批补）** ^anc-exec-reap-misuse-reject：`reapFromChildDir` 找不到在飞条目时区分两种缺席——
  - **真幂等**（该 child 已被收割——判据=父账 exec_events 有该 child 的 parallel_reap 记录,**匹配带分隔符边界**:detail 形如 `<child> ok`/`<child> failed: …`,判 `startsWith(child + ' ')` 防前缀撞名——'1.1.1 ok' 不得让误用步骤号 '1.1' 的 reap 被误判幂等〔2026-08-31 review 面二推演+面三探针双实证后收紧〕）→ 保留静默 return（重复 reap 是协议允许的,幂等语义不破）。**killed 半边不在本分支**（2026-08-31 review 面一/面二抓判定位置失实后收准）：killed 条目仍挂在 inflight 账上,外层 find（不筛状态）找得到,由 reapParallelCall/Subtask 的 killed 早返回消化——缺席分支永远见不到 killed,只判"已收割"半边;
  - **误用**（无该 child 的 parallel_reap 收割记录——判据与代码同源〔2026-08-31 review 面二抓两侧不同源后对齐:设计原写"无派发记录",代码判"无收割记录";U4b paused 恢复移账路〔出账不记 reap〕存在"派发过但按收割判据算误用"的窄窗口,该形态下响亮拒的报文措辞偏严但拒收本身安全——迟到通知的 child 已无在飞账,正确出路同样是不收〕）→ 抛结构化错误 `REAP_NOT_PARALLEL`,报文指路:「reap_and_fetch_next 只服务带 parallel 标注的派发(dispatch_ready 吐出的 child);无 parallel 标注的 [call] 用 submit_and_fetch_next <步骤号> --child-instance <子实例> 收割」。CLI 层按既有 errorExit 结构化输出。
- **subtask parallel 派发门（P0.5）**：引擎 `unifiedDispatch` 开关（独立模式 dispatcher 置位；复用模式恒关→subtask parallel 按普通容器串行下钻=退化窗口零专门代码）。开启时 dfsNextStep 遇 pending subtask parallel 不进子树，吐 `dispatch_ready`（NextResponse 第八形态，P0.5 仅独立模式消费，P2 复用模式 driver 接同一形态）；子实例=同 spec 子树收窄（executeSubtreeOnly 现成），入参=resolveChildParams 快照；收割：loop 体内经 collect 缓冲按 iter 序，兄弟位声明输出直写扁平命名空间。

### U4. 失败路径杀活【契约】 ^anc-exec-parallel-kill

- **主线步骤 fail → 引擎立即终止本容器全部在飞子实例**（✅ 作者拍板：不留幻影，失败=停）；被杀记 `killed` 终态：不算 failed、不产出、resume 不复活；容器随即按既有失败升级链处置；
- 作者面无 cancel 语法（凭据不暴露不变）；break 是正常路径——照常收齐不杀；
- 独立模式：中止子 Dispatcher 执行循环——**协作式步间中断（P1 ✅ 设计定形）** ^anc-exec-parallel-abort：父杀活时对在飞子 Dispatcher 置 abort 标志，子 executionLoop 每轮迭代（取下一介入点前）检查标志，置位即返回 failed(aborted)，不打断执行中的单步（无抢占——保持简单，单步内最多再烧一步的 token）。P0 已有的账面权威（killed 迟到结果 reap 短路丢弃）作为兜底不变。合理性：executionLoop 是唯一循环点，一处检查全覆盖；抢占式中断（AbortController 贯穿 LLM/工具调用）复杂度不成比例，步间粒度够用；
- 复用模式：引擎记 killed 为账面权威 + 把"该杀清单"（kill_list）交 driver 协议执行——外部会话即使苟活，账面已终态不再被收割，语义面无幻影；
- 在飞子实例自身 fail → 部分失败集合语义（列表变短/FailRecord，概念层既有唯一例外原样）；
- 在飞 paused → 收齐照等（无超时哲学）；多子实例同时 paused 必然出现——见下节 HITL 队列契约。

### U4b. 子实例 HITL 队列（矩阵行 13 兑现,2026-08-25 作者拍板 A〔队列全量呈现〕——hopissues 0013）【契约】 ^anc-exec-parallel-hitl-queue

**子实例内 confirm/ask 不再判 failed**——暂停冒泡入队,人逐张应答,答一张续一个子实例。P0 占位（PARALLEL_HITL_TODO 判 failed）退役,hopkb"单点要问人=整讲报废"的能力缺口收口。六件套：

1. **暂停即让名额**：子实例 paused → 在飞账 `status: 'inflight'→'paused'`（新枚举值）——paused 不占并发名额（hasFreeSlot 只数 inflight）,等人期间其余派发照跑;**收齐门照等**（hasInflightFor 数 inflight+paused——等人的活没完,容器不许闭合）;
2. **问题卡即队列**：子实例暂停时其引擎已按 0028 契约落卡（calls/<child>/ 或 parallel/<child>/paused.json,零新码）——**35 轮临时清卡撤除**,卡保留即入队;dispatcher 内存队列 `pausedChildren: Map<child_instance, {pause, dispatcher}>` 持子句柄等应答;
3. **呈现全量**（方案 A）：run_status 增 `paused_queue: [{child_instance, ...ExecutionPaused}]`——全部待答卡数组,每张携 child_instance 寻址;run 整体 status:主线还能推进 → `running`+队列附带,主线只剩等人 → `paused`+队列附带（单值 paused 字段兼容:队首卡照填,老 caller 零破坏）;
4. **应答按子路由**：resume/`resume_run` 携 `child_instance`（可选参——缺省走既有顶层/call_path 路由零破坏）→ dispatcher 从 pausedChildren 取句柄,子 dispatcher.resume(step_id, answer) 续跑;续跑即**二次占名额**（paused→inflight 回置;名额满时等空位不超员）;答完照常终态收割;**跨进程应答**（37 轮 review——server 重启后队列空,caller 拿旧卡 child 来答）：队列 miss 但账上该 child 为 paused → 先走 resumeSpec 对账重派发（第 6 条恢复路）,同名 child（<step_id>.<iter> 确定性）新卡入队后按原答继续;重派发后仍无同名卡 → 结构化 rejected（CHILD_NOT_IN_QUEUE 指路重看队列,不 throw——throw 会被 mcp 錘成 failed 终态毁可恢复态,0016 同哲学）;**队列 miss 且在飞账上也无该 child 的 paused 项**（三形态:卡已答过/已终态清场/串行 call 停点被误带 child_instance——串行 call 的挂起帧走 call_path 路由本就不入本队列,caller 从卡面无从判别停点类型〔卡的 call_path 与 child_instance 字段对串行 call 停点均空〕）→ **同样结构化 rejected 不 throw**（CHILD_NOT_IN_QUEUE 指引带"若为串行 call 停点去掉 child_instance 重答"——hopissues/0094 实撞:此分支原 throw,一次可修正的参数错误把整个可恢复 run 锤成 failed 终态,41K tokens 报废;同函数跨进程恢复分支早按 0016 改结构化拒,本分支是同族漏改半边）;
5. **杀活连坐**：主线失败杀活时 paused 子实例同杀（killed——主线死了答案无处安放;卡随杀清除,同 35 轮死卡纪律）;stop_run 级联同理;
6. **跨进程恢复（重派发重暂停,36 轮 review 修正原'队列重建';分派判据 2026-08-29 随子实例落盘批再修——[[step-dispatcher#^anc-exec-call-child-persist]] 使子目录恒在,原"目录在=stale 重建"判据失效）**：paused 状态随在飞账入 state.json;crash-resume 对账时 paused 项按**退火标记**分派——子实例**无已执行 commit** → 清账+标注步骤回 pending 重派发+**残目录清场**（重跑到暂停点重新入队:subtask/call 是事务边界重跑合法,人还没答过零损失;残目录不清会误导下轮对账）;**有已执行 commit** → 走 stale 续跑（load 重建后**先复位悬空态再** runSpec 推进——盘上暂停中的 confirm/ask 步是 running 态,不复位则 runSpec 撞 WAITING_WRITEBACK 防线直接 failed,paused 分支成死代码〔0830 review 变异核证实锤:删该分支 2293 全绿,顺藤摸出分支不可达〕;复位用 recoverDanglingRunning〔悬空 running→pending,幂等重跑到暂停点重新暂停〕,已完成步骤由持久化状态跳过;重派发=commit 重放,恰是落盘要防的第④坑,此形态是"目录在场才能续"的真消费方）。stale 重建路径的 runSpec 三态分派补 paused 分支（重建后到暂停点=重新入队,与首派发 paused 分支同款——原只兜 completed/failed,paused 被 else 当失败收割:该洞在子实例纯内存时代不可达,落盘通电当场露头,U4b 重启钉 vals=[] 实锤）。配套:ExecutionEngine.load 尽力回填 rawSource（从 state.json 的 spec_path 重读原文——重派发需原文重建子实例,原 null 让恢复路直判 failed）。

**范围注记**：v1 覆盖独立模式两形态（subtask parallel/call parallel）;复用模式 driver 逐请求问人的协议扩展另批（driver 现走 stale 对账兜底不受损）。

### U5. 推进条件放宽（唯一引擎新机制）【契约】 ^anc-exec-parallel-advance

> 完成条件不动（"children 未全终态则容器未完"既有不变量原样），只放宽推进条件：**标注步骤派发即视为"主线可继续"**——豁免仅此一类，其余步骤推进语义零变化。

落点：propagateCompletion/dfsNextStep（engine-traverse）——串行 for-each 的"本轮 children 全终态才进下轮"对标注步骤改为"已派发即可进下轮"；容器 settle 判定改读"全终态 ∧ inflight 空"。⚠️ 该函数有实撞史（parallel loop 无限重跑），U6 回归矩阵是准入条件。

### U6. 测试正反例矩阵【契约】 ^anc-exec-parallel-test-matrix

实现 P0/P1 各批交付时，下表对应行的正反例**成对**落 tests/（`@v: anc-exec-parallel-*` 对应锚点）：

| # | 场景 | 正例（应发生） | 反例（应拦截/不发生） |
|---|---|---|---|
| 1 | 循环体 call/subtask 标注渐进派发 | 第 N+1 轮主线推进时第 N 轮的活在飞；满载无空窗 | 未标注步骤被异步派发 |
| 2 | 名额窗口（含主线一路） | 配 N：在飞 ≤ N−1；满员派发点阻塞、腾额即派 | 配 1：零派发全串行，结果与不标注逐字节等价 |
| 3 | 兄弟混排 | c（未标注）执行期间 a/b 照常在飞；d 在 c 完成后才派 | c 被当作 barrier（a/b 被等） |
| 4 | 收齐=容器完成条件 | 主线走完+活未完→容器保持 running；全收好才 settle | 容器 completed 时仍有在飞（幻影） |
| 5 | collect 随收割入列 | 列表按派发序排；失败活缺席（列表变短+FailRecord） | 失败槽填 None；列表按完成序乱排 |
| 6 | S12 无 Future | 容器内消费标注步骤输出→静态报错（含跨迭代引用） | 合法 spec（边界外消费）被误拦 |
| 7 | S12 申报属实 | 标注步骤 ← 兄弟输出→报依赖边 | 独立步骤误报 |
| 8 | loop 头 parallel 废除 | `[loop ... parallel]` →解析/校验报错（明确迁移提示） | 旧写法静默通过 |
| 9 | call 标注文法 | `[call id(...) parallel]` 与 `[call id parallel]` 均解析 | 括号后属性被吞（现状 parser 硬拦截回归） |
| 10 | 主线失败杀活 | 主线 fail→在飞全 killed、容器 fail；killed 不产出不复活 | 容器 failed 后子实例仍被收割/复活 |
| 11 | break 正常路径 | break→不再派发、照常收齐、不杀活、列表=已派发部分 | break 触发杀活 |
| 12 | 部分失败 | 单活 fail→主线与其余活继续；收齐后列表变短 | 单活 fail 拖垮主线 |
| 13 | 在飞 paused | 冒泡入队逐张应答（^anc-exec-parallel-hitl-queue,2026-08-25 兑现——paused 让名额/队列全量呈现/按 child 路由应答/杀活连坐/跨进程队列重建） | 子实例 paused 判 failed（P0 占位已退役）；paused 占名额饿死其余派发；容器无视等人的活提前闭合 |
| 14 | crash-resume | kill 后 resume：inflight 重建、终态补收割、未终子实例续跑 | 已 killed 复活；已收割重复收 |
| 15 | 嵌套容器 | 各容器各自收齐；内层容器整体标注→对外一个步骤 | 内层的活被外层容器收割（串账） |
| 16 | 全串行等价性 | 同一 spec 配 1 与配 5 跑出的最终 vars 语义等价 | —（顺序模拟等价性即决策 4 基石） |

### U8. 复用模式渐进协议（P2 ✅ 2026-08-11 交付+真机验收通过：audit passed + e2e:all 九场景含三并行场景全绿）【契约】 ^anc-exec-parallel-reuse-protocol

> 复用模式并行恢复的唯一路径：引擎无进程可 await，把统一模型的两个等待位置（派发点/收齐点）
> 外化为对 driver 的介入形态。**最大化复用既有机器通道**——子实例 init/submit 命令不新造。

**能力契约（HopSpec 契约）**：

```
# Spec: reuse_mode_progressive_dispatch
Goal: 复用模式 driver 消费 dispatch_ready/drain_wait 两介入形态，以后台 subagent 承载
      在飞子实例，通知驱动收割——语义与独立模式统一通道逐项等价。
Inputs: dispatch_ready（含 launch 指引）、drain_wait（在飞清单）、worker 终态通知
Outputs: 与独立模式相同的收齐结果（collect 列表/容器具名输出/部分失败/杀活账面）
Constraints:
  - 引擎是调度权威（名额判定/记账/收割合并全在引擎），driver 是句柄执行器（起 subagent、收通知、回报终态）
  - 派发防重：dispatchParallelSubtask/Call 幂等入账（既有）——driver 重复驱动同 dispatch_ready 不重派
  - 收割走机器通道：driver 只报告子实例 id+成败，输出/FailRecord 由引擎从子实例目录自取（对称 --child-instance/--failure-child 先例）
  - 收割前置：completed 报告的前提=该 child 的 launch_command 已真实执行且退出——launch 与 reap 一一配对不可跳,advance 不代替 launch;引擎侧防御=reconcileInflight 对无盘面子实例判败（谎报 completed 不捏造产出,集合语义短一项）——两层各守一半:嘱咐防跳步,引擎防谎报成害
  - 杀活：主线失败引擎记 killed（账面权威），响应附 kill_list 交 driver 尽力终止外部会话——杀不净不损语义（reap 对 killed 短路）
```

**协议流（HopSop）**：

```
1. driver 主循环收到 dispatch_ready:
  1.1. [act] 按 launch 指引起后台 worker subagent（subtask→同 spec 子树收窄 run；call→callee spec run）
       启动命令引擎拼好（launch_command，含 cd/--json/子实例定位参数——防漏参先例 ^anc-exec-parallel-launch-path 同哲学）
  1.2. [act] 立即 advance 续推主线（新命令，见下）——主线与在飞并行推进
2. worker subagent 终态通知到达:
  2.1. [act] reap_and_fetch_next <child_instance> --status completed|failed → 引擎收割（读子实例目录）+ 返回下一介入点
3. 主循环收到 drain_wait:
  3.1. [act] 等 worker 通知（不轮询）——每收一个通知走 2.1，全部收好后引擎自动终态化循环容器
4. 主线失败: 引擎响应附 kill_list → driver 尽力停对应 subagent（停不掉不影响账面）
```

**类型约定（HopType）**——cli-types 增量：

- `DispatchReady` 补 `launch_command: string`（复用模式引擎拼好；独立模式缺省——dispatcher 进程内直起不需要）与 `dispatch_kind: 'subtask' | 'call'`；
- `ExecutionFailed` 补 `kill_list?: string[]`（主线失败时在飞被杀清单，driver 尽力终止）；
- 新 CLI 命令 `reap_and_fetch_next <child-instance> --status <s>`：引擎读子实例目录收割（reapParallelSubtask/Call 既有 API）+ advanceToCaller 返回下一介入点——一次原子往返（对称 submit_and_fetch_next）；
- 新 CLI 命令 `advance`：dispatch_ready 后续推主线（advanceToCaller 薄壳——run/submit 之外主线推进的第三入口，仅此场景使用）。

**开门条件**：复用模式顶层实例 init 时 `unifiedDispatch=true`（与 can_fanout 同位：顶层开/worker 子实例关——嵌套退化串行不变式沿用）；退化窗口条款随本节交付作废。

**真机验收**（作者跑）：cc:anchor-audit 两批并发恢复 + 部分失败场景 + 杀活场景（carrier-live-e2e 矩阵补行）。

### U7. 迁移与分期【决策】（作者已拍板：旧通道退役）

- **P0 ✅（2026-08-11 交付）**（独立模式先通，派发单位=call parallel）：文法（call 属性尾巴）、S12 call parallel 新子条+S13、inflight 记账、派发/收割/收齐（drain_wait 介入形态）、杀活（账面 killed+结果丢弃——进程内子执行无强中断点，协作式中断归 P1，账面终态保证语义面无幻影，同复用模式哲学）、矩阵 1（call 形态）/2/4/5/6/7/9/10/11/12/16（测试落位：parser.test.ts 5 例/validator.test.ts 6 例/dispatcher.test.ts 7 例）。**工程偏差两条（2026-08-10 实现时标注）**：①loop 头 parallel 废除（矩阵 8）移入 P0.5——旧通道迁移前既有 for-each fan-out 仍靠它跑，P0 先加 S12 互斥子条（call parallel 不得处于旧 parallel 容器域内）防两通道混用；②派出的活内 HITL（paused）P0 判 failed 并报 PARALLEL_HITL_TODO（作者定暂不实现，见 TODO），矩阵 13 挂起；
- **P0.5 ✅（2026-08-11 交付）**（语义全库统一+旧通道整体删除，作者裁定修正——原"旧消息格式留作复用模式适配层"方案废弃：旧信封表达不了新语义〔渐进派发/收齐/杀活〕，硬塞是自欺）：
  - 文法：loop 头 parallel 废除（parser 报错+迁移提示，矩阵 8）；`LoopStep.parallel` 字段删除；`[subtask parallel]` 全库改读统一模型（异步派发申报）；
  - 引擎：subtask parallel 接入统一通道（子实例=同 spec 子树收窄，与 call 派发共用 inflight/名额/收割/收齐/杀活；兄弟位收齐点=最近封闭容器，`host_loop` 泛化为 `host_container`）；**旧通道代码整体删除**（collectParallelBatch/nextParallelBatch/joinParallel/fanoutSchedule/runParallelBatch 泳道池、CLI join_parallel/fanout-plan/fanout-next 命令）——文法废除后旧通道无触发入口，是死码；
  - **复用模式退化窗口（作者定，接受）**：新 driver 协议（P2）实装前，复用模式下 parallel 标注一律**同步执行**（call 本就 step_ready 交 caller 串行驱动、subtask 按普通容器下钻——退化天然发生，零专门代码，引擎记 warn 提示）。语义正确性由顺序模拟等价性（决策 4）兜底，仅暂无并发加速；anchor-audit 等复用模式 fan-out 消费方暂时串行，P2 恢复。**故 P2 优先级提升**；
  - 存量迁移：7 份 spec（examples ×5 + scripts/audit ×2）迁新写法；driver 文档（hopspec-skill fanout 协议段删除、hopbuild 三份"静态并行组"读法改统一口径）；全部既有 parallel 测试改造/删除回归（机制测试随通道删、语义测试迁统一通道）；矩阵行 3（兄弟混排）/15（嵌套）此时补正反例；
  - §1-§10 旧通道设计随代码删除归档；
- **P1**（生产可靠，2026-08-11 作者确认四件——原第三件「paused 让名额+多 paused 队列」摘除归 ^todo-parallel-hitl〔其前提=子实例内 HITL 被支持，作者已裁暂不实现，P1 做它无意义〕）：①crash-resume 在飞对账（矩阵 14，^anc-exec-parallel-inflight-reconcile）②单活超时腾名额（^anc-exec-parallel-timeout）③协作式杀活中断（^anc-exec-parallel-abort）④HopLog reap/settle 事件块（^anc-exec-parallel-reap-log）；附带清理：cli-types 旧类型 ParallelReady/FanoutScheduleResult/FanoutWorker/ParallelChildSpec 删除（P2 承诺）、canFanout/dispatched 旧字段评估；
- **P2 ✅（2026-08-11 交付，见 §U8）**：dispatch_ready（launch_command 引擎拼好/dispatch_kind 分派）+drain_wait 交 driver、reap_and_fetch_next/advance 两 CLI 命令、kill_list 载荷、CC 后台 subagent 编排/Codex 串行消费两载体 skill 改造；名额判定上收引擎（满员吐 drain_wait=派发点阻塞，配1同步退化 fallthrough）。**未含**：真机验收（cc:anchor-audit 并发恢复+部分失败+杀活场景，作者跑）；run_status 在飞树状进度（挂 mcp-server 增强，非协议件）。

---

# 以下为旧通道设计（❌ 已归档 2026-08-11：代码已删——collectParallelBatch/nextParallelBatch/joinParallel/fanoutSchedule/泳道池/CLI join_parallel/fanout-plan/fanout-next/driver parallel-worker 均随 P0.5 退役。本区仅存史供 P2 渐进协议设计参考，锚点不再要求代码对齐）

## 0. 一页速览

| 维度 | 结论 |
|------|------|
| **并发载体** | 复用模式由 carrier 提供 subagent：CC 用完成通知维持滑动窗口；Codex 按 barrier join 分批 fan-out；引擎只吐 children，不绑并发原语 |
| **worker↔引擎** | 与主 agent **完全对称**——都是 `run → submit_and_fetch_next` 循环，引擎对两者只讲一种语言（组装 context→StepReady→收 submit） |
| **worker 跑什么** | 持有**同一份父 spec**，但执行 scope 收窄到自己那棵 child 子树（子树外预标 skipped），`can_fanout=false` 串行跑 |
| **worker 提示词** | 走**现有 PromptAssembler 同一套 L1-L6**；task_context 写清子任务目标契约+继承约束+并行身份；step_states 子树外全 skipped→自然只为子树内步骤组装 |
| **环境标识** | `can_fanout` 布尔进 StateFile：顶层 true（fan-out）/ worker false（串行）。通用 agent 环境属性，未来自动并行化复用 |
| **跨进程安全** | 每 child 一个子实例目录 `.hopstate/<inst>/parallel/<child_id>/`，各写各的；join 单进程 merge |
| **嵌套并行** | worker can_fanout=false → 内层 parallel 自动退化串行（决策3 免费实现） |
| **一层并行** | 只最外层 parallel fan-out |
| **并发上限** | `max_concurrent_workers` 缺省 5，引擎透传，driver 排队 |

## 1. 三个机制（引擎侧，已实装雏形）

### 1a. 批量就绪 `^anc-exec-parallel-batch`

`collectParallelBatch` 找最外层 running/pending parallel，吐出其 pending 直接 children（容器）封装为 `ParallelReady`：

```jsonc
{
  "status": "parallel_ready",
  "instance_id": "<父 inst>",
  "parallel_step_id": "1",
  "children": [
    { "child_step_id": "1.1", "summary": "处理文档 A",
      "subinstance_dir": ".hopstate/<inst>/parallel/1.1",
      "params_for_child": { "doc_a": "..." } },   // 引擎从父 scope 按子树 ← 自动解析
    { "child_step_id": "1.2", ... },
    { "child_step_id": "1.3", ... }
  ],
  "max_concurrent": 5
}
```

仅 `can_fanout=true`（顶层实例）出现，worker 子实例（can_fanout=false）不可见，独立模式 dispatcher 也不置 → 不可见（保护其 switch）。

### 1b. worker 子实例隔离 `^anc-exec-parallel-subinstance`

每个 child 一个独立子实例目录（类比 call 的 `calls/`），N worker 各写各的，跨进程零竞争。**关键问题：worker 怎么只跑自己那棵子树？** → 见第 2 节。

### 1c. join merge `^anc-exec-parallel-join-merge`

N worker 全部终态后，**单进程** `join_parallel` 读各子实例 vars，按 collect 子句 merge 回父变量空间；child failed → 不贡献收集元素（列表变短，函数级 fail）。规避 N 进程并发写父态丢更新（决策9）。

## 2. worker 怎么只跑自己那棵子树（核心机制，待对齐）

### 2a. 问题

引擎执行总从 `spec.steps` 根开始，没有"从步骤 X 起跑"。若 worker 子实例拿完整父 spec 直接跑，会从 step 1 重跑、无限重入 parallel。

### 2b. 方案：范围化子树（基于现有执行链上下文体系派活）

**worker 子实例持有同一份父 spec**（不重新生根、不重编号），init 时做 **scope 掩码**：
- **保留 pending**：目标 child 子树（child 自身 + 全部后代）
- **预标 skipped**：其余一切——兄弟 child（1.2/1.3）、父 parallel 的外层下游（step 2）、其它顶层步骤
- 以**非 parallelMode** 跑（内层 parallel 退化串行）

于是 worker 的 `run`：父 parallel `1` 进入 running → 只有 `1.1` 是 pending → 引擎用**现有 PromptAssembler** 逐个为 `1.1.1`/`1.1.2`/`1.1.3` 组装执行链上下文 → worker 应答 → `1.1` 完成聚合 `summary_a` → 子实例 `completed`。

**为什么这是对的**：
- ✅ 派活完全走现有 L1-L6 执行链上下文体系（worker 看到的 StepReady.context 跟顶层 driver 一模一样），不发明新派活通道
- ✅ step_id 不变（`1.1.x` 还是 `1.1.x`）→ retry/adaptive/check 语义天然保留
- ✅ 内层 parallel 退化串行**免费**（决策3）
- ✅ `params_for_child` 注入子实例 root scope，child 的 `← doc_a` 正常读到
- ✅ join 复用 `completeCallStep` 同款逻辑

**引擎职责**（结构/控制流不归 driver）：新增 `executeSubtreeOnly(childStepId)`——init 后把子树+祖先链以外的步骤标 skipped。复用现有 `initStepStates` + skip。

### 2c. can_fanout 环境标识（已定稿，见 §6 结论1）

`can_fanout` 是**持久化的 agent 环境属性**（进 StateFile），标识当前 agent 是否允许 fan-out：
- 顶层实例 `can_fanout=true` → `advanceToCaller` 探最外层 parallel、吐 ParallelReady
- worker 子实例 `can_fanout=false` → 不探 parallel，内层 parallel 退化串行（一层并行约束）

替代原"每命令 parallelMode flag"（flag 会被 worker 的 submit 误置 true → 内层 fan-out）。语义上是通用环境标识，非 parallel 专属——未来无依赖子步骤自动并行化时复用。

## 3. worker 提示词组装（本次对齐重点）★★★

worker 是子 driver，它对子树跑标准 next→submit 循环，每步收到 `StepReady.context`（AssembledContext 6 层）。**核心问题：worker 看到的 L1-L6 该裁成什么样？** 三个子问题：

### 3a. L1 骨架 + 子任务目标（已定稿：子树视图 + 写清目标约束）

worker 是 subagent，**必须明白自己在干什么**。task_context 显式承载三部分：

1. **子任务目标契约**（最重要）：worker 负责的 child subtask 的 summary + 聚合输出声明 `+→`——即"你要交付 `summary_a: text`"。这是 worker 的验收标准。
2. **继承的 spec constraints**：worker 同样受全局 Goal/Constraints 约束（不能因为是子任务就脱离全局约束）。
3. **子树骨架 + 并行身份**：只渲染 worker 负责的 child 子树（不给兄弟分支 1.2/1.3 和下游 2——它够不着、S12 禁止跨分支引用、是噪声且可能误导），父 parallel 行标注"你负责 `1.1` 分支，与其它分支并行执行，无需关心兄弟分支"。

PromptAssembler 加"子树根"概念：worker 子实例传入 `subtreeRoot=1.1`，`buildSpecSkeleton` 从该根渲染 + 父 parallel 一行身份标注；task_context 头部加子任务目标契约段。

### 3b. L3 执行链——worker 能看到兄弟分支的产出吗？

现状 L3（`buildProgressSummary`）展示依赖步骤 + 最近完成的同级。worker 跑 `1.1` 时，`1.2`/`1.3` 在**别的进程**并发跑，worker 子实例的 step_states 里它们是 skipped。

**结论（推演，无需决策）**：worker **看不到也不该看到**兄弟分支产出——S12 保证 child 间无数据依赖，`1.1` 的任何步骤不会 `← 1.2 的输出`。L3 自然只展示 `1.1` 子树内已完成步骤。**这正是 scope 掩码方案的正确性副产物**：skipped 步骤 L3 不显示（prompt.ts:262）。

### 3c. worker 的 instruction / 输入解析

**结论（推演，无需决策）**：完全不变。worker 子实例 root scope 注入了 `params_for_child`，子树内步骤的 `←` 输入经现有 `resolveInputs` 从子实例 scope 自底向上解析，跟顶层无差别。act body、check 双槽、reason 指令组装全部复用。

### 3d. 父 driver（顶层）的提示词——它怎么"看到"并行在跑？

顶层 driver 收到 `ParallelReady`（不是 StepReady），它不是"一步上下文"而是"一批派活单"。**结论**：ParallelReady 不走 PromptAssembler（它不是某一步的执行上下文），driver SKILL.md 收到后按 children[] fan-out。join 后顶层继续收到 step 2 的正常 StepReady（此时 `summary_a/b/c` 已 merge 进父 scope，L3 正常展示三个 child 容器 done + 聚合输出）。

## 4. worker 提示词组装——拟定的最终形态（候选 A）

worker 跑 `1.1.2 [act] 组装文档 A 摘要` 时收到的 context：

```
task_context (L1):
  Goal: 对三份独立文档并行执行"抽取→校验"...
  Steps 骨架（子树视图）:
    1. [parallel] 并行处理三份文档          ← 父 parallel 头（一行，标注"你负责 1.1 分支"）
      1.1. [subtask retry=2] 处理文档 A      ← 子树根
        1.1.1. [reason] 抽取文档 A 要点
        1.1.2. [act] 组装文档 A 摘要         ← 当前
        1.1.3. [check final] 校验...
  祖先链: 1.1 [subtask] 处理文档 A | + → summary_a

progress_summary (L3):
  ✓ 1.1.1 [reason]: 抽取文档 A 要点 → points_a=...

inputs (L4): { points_a: "..." }
instruction (L5): 组装文档 A 摘要 + [ACT BODY ...]
output_schema (L6): [{ name: summary_a, type: text }]
```

**关键**：worker 完全不知道 `1.2`/`1.3`/`2` 的存在（除父 parallel 一行）。注意力全在自己这棵树。

## 5. 实装增量（对齐后落地）

| 层 | 改动 | 锚点 |
|----|------|------|
| 设计 | 本文对齐后并入 exec-engine（2b/2c）+ prompt-assembler（3a 子树骨架） | `anc-exec-parallel-subinstance` 补 scope 掩码；prompt-assembler 补 worker 子树视图 |
| 代码 engine | `executeSubtreeOnly(childStepId)`；parallelMode 进 StateFile 持久化 | 同上 |
| 代码 prompt | `buildSpecSkeleton` 支持 `subtreeRoot` 参数（worker 子实例传入） | `anc-exec-l1-skeleton` 扩 |
| 代码 cli | `run`/`init --parallel-child` 触发 executeSubtreeOnly + 子实例非 parallelMode | — |
| driver | SKILL.md parallel_ready fan-out 节 | — |

## 6. 作者已拍板结论（2026-06-16）

1. **can_fanout 布尔进 StateFile**（替代每命令 parallelMode flag）：标识"当前 agent 环境是否允许 fan-out"。顶层实例 `can_fanout=true`，worker 子实例 `can_fanout=false`（已在一个并行分支内，不再嵌套扇出 → 内层 parallel 退化串行）。
   - **语义定位**：这是 **agent 环境属性**，不是 parallel 专属开关。未来"任何无依赖子步骤自动并行化"时复用同一标识——agent 据自身环境（是否已在并行分支内）自动决定能否再 fan-out。当前先做一层并行（YAGNI：不引入 depth 整数，真要多层时再重构）。
   - 引擎：`advanceToCaller` 仅当 `can_fanout` 时探 `collectParallelBatch`；worker 子实例 init 时置 false 并持久化。

2. **worker task_context 必须写清子任务目标 + 约束（回答1 核心）**：worker（subagent）要明白自己在干什么。L1 不只截一段骨架——task_context 显式承载：
   - 该 child subtask 的**目标**（subtask summary + 它的聚合输出契约 `+→`，即"你要交付什么"）
   - 继承的 **spec 级 constraints**（worker 同样受全局约束）
   - 子树骨架（worker 负责的 child 子树视图）+ 父 parallel 一行（明示并行身份）

3. **明示并行身份（回答3）**：worker 骨架顶部父 parallel 行标注"你负责 `<child_id>` 分支，与其它分支并行执行，无需关心兄弟分支"——让 worker 不困惑为何看不到全局。

4. **subagent ↔ 引擎 = submit_and_fetch_next（架构对称性确认）**：worker 是子 driver，对其 child 子实例跑标准 `run → submit_and_fetch_next` 循环，与主 agent 对顶层实例的交互**完全对称**。引擎对主 agent 和 subagent 只讲一种语言（组装 context → 发 StepReady → 收 submit）。worker 内若再遇 call，照样 init 子实例驱动子循环——递归对称。

## 8. Driver fan-out 模型：每 child 起 subagent（2026-06-18 定稿） ^anc-exec-parallel-fanout-model

### 8a. 核心模型

driver 收到 `parallel_ready` 后，对每个 child 启动一个 **CC subagent**（`Agent` 工具，前台模式）。subagent 完整驱动该 child 子实例的 `run → submit_and_fetch_next` 循环直到终态。

```
主 driver 收到 parallel_ready
  ├─ child 1.1 → Agent("驱动 worker 1.1") → subagent 跑完 → completed/failed
  ├─ child 1.2 → Agent("驱动 worker 1.2") → subagent 跑完 → completed/failed
  └─ child 1.3 → Agent("驱动 worker 1.3") → subagent 跑完 → completed/failed
全部终态 → join_parallel → 继续主循环
```

### 8b. 简化前提（MVP）

所有 child **统一按需要 CC 介入处理**——不做 `isCallerActionPoint` 静态分析。理由：
- MVP 路径最短，先验证对称性
- 纯计算子树引擎自消化是**后续优化**（见 8f），不影响正确性

### 8c. 为什么前台不后台

`run_in_background` 模式下，CC subagent 的权限弹窗（Bash 预授权确认）被吞 → 命令无法执行 → 子实例卡死。**前台 subagent 继承主 session 的 `Bash(node *)` allow 权限**，已验证可执行 hopjit CLI。

并发限制由 `max_concurrent`（默认 5）控制——driver 分批起 subagent（每批 ≤ max_concurrent 个 Agent 调用），前一批全部返回后再起下一批。

### 8d. parallel prompt 组装（自包含派活指令）

引擎为 parallel 容器组装**完整自包含的 fan-out 指令文本**，记录到 hoplog `llm.prompt`。这段文本是"给 driver agent 的完整输入"——与 step_ready 的 `formatPromptText`（给执行 LLM 的完整输入）对称。（渲染函数 formatParallelPromptText 已随 P0.5 旧通道退役删除——本节描述的旧批量派活形态待统一模型渐进协议重建时按新形态改写,2026-08-30 review 标注。）

**自包含要求**：driver agent 拿到这段文本就能完成 fan-out→驱动→join 全流程，不依赖 SKILL.md 或外部文档。

**结构**：

```
你是 HopSpec parallel driver，负责并行调度以下 child 容器到终态后 join 合并。

═══ 任务概览 ═══
Goal: {spec goal}
Outputs: {spec outputs}
Parallel step {id} 分发 {N} 个 child（max_concurrent={M}）：
- {child_id} {summary}  params: {params_json}
- ...

═══ Fan-out：对每个 child 起一个 subagent ═══
使用 Agent 工具，每个 subagent 驱动一个 child 子实例。
并发数 ≤ max_concurrent；超出分批，前批完成后起下批。

每个 subagent prompt（已填入实际 child 参数）：
---
你是 HopSpec parallel worker，负责驱动 child {child_step_id}（{summary}）到终态。

启动命令：
node {cli_path} run {spec_path} --parallel-parent {instance_id} \
  --parallel-child {child_step_id} --state-dir .hopstate \
  --log-dir {parent_log_dir}/parallel/{child_step_id} --log-level debug \
  --params '{params_json}'

执行后读 status 循环直到 completed/failed：
- step_ready → 按 step_type 执行：
  - reason/check：推理产出 JSON（key=output_schema 变量名；check 固定 bool+text 双槽只判定不重试；信息不足输出 {"lack_of_info":"..."}）
  - act：有 hop_python body 严格逐行执行，无 body 按指令用工具执行
  - commit：同 act 但不可逆
  提交：node {cli_path} submit_and_fetch_next {step_id} --output '<JSON>' --state-dir .hopstate
- completed → 报告完成
- failed → 报告失败

Bash 纪律：每条只做一件事，不管道不链式，直接写完整 node 命令。
---

═══ Join：全部 subagent 返回后 ═══
node {cli_path} join_parallel {parallel_step_id} --state-dir .hopstate --instance {instance_id}
引擎 merge 后返回下一步 JSON，继续主循环。

═══ 错误处理 ═══
- 某 subagent 返回 failed → 不阻塞其余，join 时该 child 输出写 None
- 某 subagent 异常退出 → 视为 failed
- 含 confirm 的 child 不进并行，主 driver 串行驱动
```

**实现**（P0.5 退役——formatParallelPromptText/nextParallelBatch 均已删,历史形态归 git log;现行派发渲染走 dispatch_ready 通道,2026-08-30 review 标注）。

### 8e. 并发控制与错误处理

| 场景 | 处理 |
|------|------|
| child 数 ≤ max_concurrent | 一批 Agent 调用并行发出 |
| child 数 > max_concurrent | 分批，每批 max_concurrent 个，前批完成后起下批 |
| 某 subagent 返回 failed | 不阻塞其余，记录 fail 状态 |
| 某 subagent 异常退出 | 视为 child failed，join 时该输出写 None |
| 子树含 confirm | **引擎不扇出**，保持 pending，由主循环串行推进（见 ^anc-exec-parallel-confirm-exclude） |

### 8e-1. 含暂停点（confirm/ask）的 child 引擎级排除【契约】 ^anc-exec-parallel-confirm-exclude

含**暂停点步骤（confirm 或 ask）**的 child 子树**不能并行**——多个 worker subagent 同时跑、若各自子树都暂停在 HITL 介入点，会产生多个并发的介入请求，driver 无法干净地串行问人。这条理由对 confirm 与 ask 同等成立（两者都产生 `paused`，见 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-mode-invariants]] 第 3 条）——原谓词只查 confirm 是 ask 步骤后来才引入的历史遗留，2026-08-10 随独立模式真并行推演补全（由既有排除理由一步推演，非新决策）。原设计让 **driver 静态预检排除**（grep 子树找 confirm），但这是软约束（靠 driver 自觉，同 `@_w.json` 竞态、doc-ref 挂错层一类"靠主体记得"的脆弱性）。**改为引擎结构性排除**：

- **collectParallelBatch 过滤**：收集 parallel 的 `pendingChildren` 时，对每个 child **静态扫其子树**（`subtreeContainsPausePoint`，2026-08-10 由 `subtreeContainsConfirm` 更名扩展），含 confirm/ask 的 child **不进 batch**、保持 pending。返回的 batch 只含无暂停点的 child。
- **被排除 child 的执行**：parallel 容器仍标 running。无 confirm 的 child 并行跑完、`join_parallel` 合并后，主循环 `dfsNextStep` 下钻该（仍 running 的）parallel 容器，把剩余 pending 的含 confirm child **串行推进**（走到 confirm 自然 paused 介入点）。即"并行的归并行、要审批的归串行"，时序上并行批先行、串行批随后。
- **全部 child 都含 confirm**：batch 为空 → `nextParallelBatch` 返回 null（无可并行批次）→ 主循环直接串行驱动整个 parallel（退化为顺序执行，等价 S12 串并等价）。
- **driver 无需判断**：driver 收到 `ParallelReady.children[]` 即可放心全部 fan-out——引擎已保证其中无 confirm child。driver 侧的"静态预检"从协议中移除（不再是 driver 职责）。
- **与 max_concurrent 正交**：confirm 排除发生在 batch 收集时，并发上限作用于排除后的 batch。

> **判据 `subtreeContainsPausePoint(child)`**：DFS 遍历 child 子树所有后代步骤，遇 `step_type === 'confirm'` 或 `'ask'` 即真（两者都产生 paused，排除理由同等成立）。call 步骤的被调 spec 无法静态展开 → 保守**不**视为含暂停点（与 P8"call 无法静态验证 callee 含未兜底 commit"同哲学，留运行时）；若将来需严格，可在 call child 上要求显式标记。

### 8f. 后续优化路径（不在 MVP 范围）

**引擎自消化**：对每个 child 子树做 `isCallerActionPoint` 静态分析——如果子树内全是纯计算步骤（无 reason/check/confirm、act 有 body 且纯计算），引擎进程内直接执行（`advanceToCaller` 一路消化到 completed），不起 subagent。只把含 caller 介入点的 child 返回给 driver fan-out。

效果：N child 中 M 个纯计算引擎自消化（零网络开销），N-M 个需 CC 的才起 subagent。

### 8g. SKILL.md 表述原则

driver SKILL.md 的 `parallel_ready` 节只写**语义**：
- "对每个 child 起一个 subagent"
- "subagent 驱动标准 run→submit 循环"
- "全部终态后 join"

**不写**：具体 bash 命令模板（subagent prompt 组装时才展开）、进程管理细节、信号量实现。理由：bash 细节属实现层，写进 SKILL.md 会被 CC 照抄产生僵化命令序列。

## 9. 动态 parallel（for-each）【契约】 ^anc-exec-parallel-foreach

### 9a. 语义

parallel 容器支持 `for-each` 动态展开：spec 中定义一个 child 模板，引擎运行时按列表变量长度动态复制 N 份 child。

**语法**（2026-08-07 重构后现行文法——for-each 子句入 loop 步骤头，旧 `+ → item : for-each list` 伪输出行已废除）：
```
2. [loop for-each reviewer in reviewers, parallel] 审查员并行评审
  + → report: [text]
  2.1. [subtask] 评审模板（child 模板，运行时展开为 N 份）
    - ← reviewer, doc_content
    + → report: text
```

- `← reviewers`：声明输入列表（必须是 `[T]` 类型的已定义变量）
- `for-each reviewer in reviewers`（步骤头子句）：`reviewer` 是元素绑定名（itemVar，定义点=子句自身），`reviewers` 是遍历列表（listVar，消费边由 parser 自动合成，`- ←` 行写不写均可）。子句一处同时声明两个名字
- spec 中只写一个 child 模板——引擎运行时按 `reviewers` 列表长度动态生成 N 份 child
- 静态 parallel（无 for-each）行为完全不变

> **旧语法演进（两代皆废）**：一代=两行式（`+ → reviewer` + 独立 `for-each reviewers → reviewer`）；二代=单行伪输出行（`+ → reviewer : for-each reviewers`）——2026-08-07 重构统一为步骤头子句 `[loop for-each <item> in <list>]`，parser 对两代残留均抛 ParseError 并提示新文法。AST 形态不变（`forEach: {listVar, itemVar}`，现居 LoopStep），9b 起的引擎行为与语法变更无关。

### 9b. 引擎行为（dfsNextStep + collectParallelBatch）

**关键**：for-each parallel 在 `dfsNextStep` 中**不进入子树**——模板 child 不是可执行步骤，它是运行时展开的模板。`dfsNextStep` 遇到有 `forEach` 的 parallel 容器时，标 running 后**不进 children**，交给 `collectParallelBatch` 处理。

#### 9b'. fan-out 探测必须先于 nextStep 树遍历（for-each parallel 屏障） ^anc-exec-parallel-foreach-barrier

> **承接注记（原条款字面废止，屏障语义由 §U7 承担）**：实装已无 `nextParallelBatch`——旧 fan-out 探测通道随 P0.5 退役（src/engine.ts:1522-1523、1657 注释自陈删除），`advanceToCaller` 不再先探批。本条款守的目标——**parallel 未 join 前不得推进其下游 sibling**——现由统一派发门承担：`nextStep` 内 `unifiedDispatch` 门对 pending 的 parallel 标注步产 `dispatch_ready`、派发即入账（inflight 名册），下游 sibling 在收割（reap）齐之前不会被当作下一个可执行步返回（见 §U7）。下文保留作沿革与失效形态记录（"抢跑→No executable step found"的病理分析仍有效）。

**`advanceToCaller`（can_fanout=true，顶层 driver）必须先调 `nextParallelBatch`，命中则返回 `ParallelReady`；只有未命中才走 `nextStep` 树遍历。顺序不可颠倒。**

**为什么**：`dfsNextStep` 遇到 for-each parallel 时标 running 后 **不进子树、`continue`**（模板 child 不可执行，见 §9b）。这个 `continue` 会让循环落到 parallel 的**同级后续步骤**（如汇聚 `reason`），把它当下一个 executable 返回。若 `advanceToCaller` 先调 `nextStep`，该下游步就被 `nextStep` 标 `running` 并持久化——可它其实依赖 parallel 尚未产出的聚合输出，是**抢跑**。随后 join 完成、`advanceToCaller` 再遍历时，`dfsNextStep` 跳过已 `running` 的非容器步（既非终态也非 pending），导致**找不到可执行步 → `No executable step found`**，整条链在汇聚步前断裂。

**修复（顺序而非屏障）**：把 `nextParallelBatch` 探测提到 `nextStep` **之前**。`collectParallelBatch` 能直接命中 *pending* 的最外层 parallel 并自行标 running（engine.ts `nextParallelBatch` 内），无需 `nextStep` 先把它转 running。fan-out 命中即 `return ParallelReady`，下游步根本没机会被 `nextStep` 越过、误标——屏障效果由"先探 batch"达成，`dfsNextStep` 本身不改（改它会破坏 worker 下钻子树，见下）。

**与静态 parallel 的对比**：静态 parallel 标 running 后 `dfsNextStep` **进子树**返回某个真实 child，不会 `continue` 到下游 sibling，天然不越界——本问题是 for-each "不进子树 + continue" 特有。

**为什么不在 dfsNextStep 立屏障**：worker 子实例（can_fanout=false）退化串行，**依赖** `dfsNextStep` 下钻 running 的 for-each parallel 模板子树来执行 `{P}.1.*`（见 §9e + executeSubtreeOnly 把 parallel 祖先标 running）。若在 `dfsNextStep` 对 for-each parallel `return none`，worker 自己的子树也被挡死。故屏障只能落在 `advanceToCaller` 的 can_fanout 分支（顶层 driver 专属），不能落在共享的 `dfsNextStep`。

**屏障解除时机**：parallel 经 `joinParallel` 标 `done` 后，`nextParallelBatch` 不再命中（children 全终态），`advanceToCaller` 落到 `nextStep`，`dfsNextStep` 对 done 容器正常 `continue`、循环落到后续 sibling——此时汇聚步才被推进。即"屏障"只在 parallel `running`（fan-out 中、未 join）期间生效。

`collectParallelBatch` 匹配到 running 的 for-each parallel 时：
1. 读 `listVar` 的值（从 parent scope）
2. 按列表长度生成 N 个 `ParallelChildSpec`
3. 动态 child 的 step_id：`{parallel_id}.{idx+1}`（如 `2.1`→`2.2`→`2.3`）
4. 每个 child 的 `params_for_child` 包含 `{ [itemVar]: listVal[idx] }` + 模板 child 的其他输入
5. 列表为空 → parallel 直接标 done（无 children 可执行）

### 9c. 输出收集（join 端） ^anc-exec-parallel-foreach-join

**能力契约**（HopSpec 契约）：

```
# Spec: for-each parallel 的 join 收集
Id: join_foreach_collect
Goal: 把 N 个 worker 的单项产出按 collect 子句收进容器 listVar,落父变量空间,并标全部合成 ID 终态
Inputs:
- parallel_step_id: line   # for-each parallel 容器 id
- child_results: yaml      # 合成ID → { vars, failed }（由 CLI 收集端按期望集填充,见 9c'）
Outputs:
- merged: yaml             # listVar 列表落父空间（按合成 ID 序号排列）
Constraints:
- 必须遍历 child_results 的全部合成 ID——spec 树里只有模板 child {P}.1,用 getChildren 会漏 N-1 个
- child failed → 不贡献收集元素,列表变短（函数级 fail:列表乱序下槽位无归属,填 null 不知是谁的;
  失败不阻塞其余 child）
- 无 collect 子句时回退旧同名收集（过渡期兼容）
```

**关键逻辑**（HopSop）：

```
joinParallel(parallel_step_id, child_results):
1. [act] 按合成 ID 序号排序 child_results 的 key（{P}.1…{P}.N,列表顺序与 fan-out 一致）
2. [loop for-each 合成ID in 排序后 key] 逐 child 收集:
   [条件(child.failed)] 跳过（不贡献元素）,该合成 ID 标 failed + 记失败
   [条件(其他)] 按 collect 子句把 child.vars[unitVar] push 进 listVar,该合成 ID 标 done
3. [act] listVar 写父变量空间;容器标 done（全 failed 时按容器失败走升级链）
```

### 9c'. CLI 收集端：按期望集填充 childResults ^anc-exec-parallel-foreach-join-collect

§9c 规定引擎**消费** `childResults`；本节规定 CLI `join_parallel` 命令如何**填充**它。**收集口径 = 期望集（唯一口径，前置校验权威在 [[exec-engine#^anc-exec-parallel-join-preconditions]]）**。

**能力契约**（HopSpec 契约）：

```
# Spec: join 收集端填充
Id: join_collect_fill
Goal: 按期望 child 集读各子实例快照,填充 childResults 交 joinParallel——漏 worker 响亮拒绝,陈旧目录不混入
Inputs:
- parallel_step_id: line
- instance_dir: line       # 父实例目录（子实例在 parallel/ 下）
Outputs:
- child_results: yaml      # 期望集内全部合成 ID → { vars, failed, log }
Constraints:
- 期望集=事实来源:for-each 按 listVar 长度推算合成 ID（{P}.1…{P}.N）;静态取 spec children。
  禁用"扫 parallel/ 目录"口径——未启动的 worker 没有子目录,扫目录会静默漏掉产出残缺 merge;
  期望集外的陈旧目录（上一轮更长列表的残骸）也必须被忽略,不得混入收集
- listVar 非数组（deflate 指针/上游谎报）→ 响亮报错,不静默算 0 产出空 join
- 期望集内子实例缺失或仍含 running 步骤 → 拒绝整个 join（INVALID_STATE,非残缺 merge）
- 单 child 文件损坏 → 该 child 标 failed 不连累其余（不贡献收集元素,见 §9c）
```

**关键逻辑**（HopSop）：

```
join_parallel 收集端:
1. [act] 算期望集: [条件(forEach)] 按 listVar 长度推算 {P}.1…{P}.N（listVar 非数组即响亮报错）
         [条件(静态)] spec children
2. [loop for-each 合成ID in 期望集] 逐个核验填充:
   [条件(子实例缺失)] forEach → 拒绝 join;静态 → 跳过（child 含 confirm 退串行属合法缺失,状态在父 state）
   [条件(含 running 步骤)] 拒绝 join（worker 未跑完,driver 提前 join 被硬拦）
   [条件(读损坏)] childResults[id] = { vars:{}, failed:true }（隔离,不连累）
   [条件(其他)] childResults[id] = { vars: 子实例vars, failed: 子state含failed, log: 子hoplog目录 }
3. [act] 交 joinParallel（§9c）
```

**不变量**：期望集 = fan-out 端展开的合成 ID 集合 = childResults keys = `joinParallel` 内遍历集。任一环用 `getChildren` 截断或用目录扫描替代期望集，都会丢 child 或吞漏启动。

### 9d. 与静态 parallel 的兼容性

| | 静态 parallel | for-each parallel |
|---|---|---|
| children 来源 | spec 中逐个定义 | 运行时从列表展开 |
| dfsNextStep | 正常进入子树 | **不进入子树**（continue） |
| collectParallelBatch | 返回 spec children | 动态生成 N 个 ParallelChildSpec |
| step_id | spec 定义的 ID | 动态生成 `{parallel_id}.{idx+1}` |
| **join 收集（CLI 填充 childResults）** | spec children 即期望集 | **按 listVar 长度算期望合成 ID 集**（见 9c'） |
| **join 遍历（引擎消费 childResults）** | `getChildren(parallel)` | **childResults 全部合成 ID**（见 9c） |
| 输出 | 各 child 独立声明名 | collect 子句收集为列表（按序号,失败 child 不贡献元素） |
| S12 | 逐 child 校验 | 天然满足（同构模板） |

### 9e. worker 启动：合成 ID 解析 + itemVar 经引擎单一权威注入【契约】 ^anc-exec-parallel-foreach-worker

for-each 动态 child 的 step_id 是**合成 ID**（`{P}.{idx+1}`），spec AST 里只有一个模板 child（`{P}.1`）。worker 子实例用合成 ID（如 `--parallel-child 2.3`）启动时：

1. **合成 ID 解析回模板**：`executeSubtreeOnly` 收到合成 ID `{P}.{N}` 且 `findStepById` 命中失败时，检测父 parallel 是否有 `forEach`——若有，解析回模板 child `{P}.1` 做 scope 掩码（子树结构相同，只是 step_id 前缀不同）。`idx = N - 1` 是该 worker 在列表中的序号。

   ⚠️ 静态 parallel 的 child ID 在 AST 中真实存在，`findStepById` 直接命中，不走此分支。仅 for-each 合成 ID（命中失败）才需解析。

2. **备料清单=子树内 `- ←` 声明（串行可见 ≠ 并行可见）**：worker 是独立子实例不共享父变量空间——fan-out 只备子树内声明过的输入。子树引用未声明变量时串行跑全对（扁平空间随手可得）、parallel 后 worker 缺值且**不报错**（执行 LLM 拿不到值就靠猜——2026-08-09 anchor-audit 实撞:5.2.1 漏声明 project_root,batch 文件被写到猜的位置;历史真跑因 project_root 恰=cwd 巧合掩盖,fixture 分离两目录后现形）。机检三档已立（叶子输入声明完备性:body B4 error/ask P14 error/散文 V11 warn——散文档终审归语义审计）,作者写 spec 的处方=worker 子树引用的每个外部变量都在用它的步骤 `- ←` 声明。
3. **完整 child 入参来源：引擎单一权威，fan-out 落盘 + worker init 按 cid 回填，driver 零参与**：父引擎为每个静态/for-each child 算定完整 `params_for_child`；for-each 额外包含 `params_for_child[itemVar] = listVal[idx]`（见 [[#^anc-exec-parallel-foreach-join]] 邻接的 fan-out 逻辑）。同一次 fan-out，父引擎把每个 child 的完整 `params_for_child`（**内部真值，不 deflate**）写到该 child 的 subinstance 目录下 `params.json`（`<parentDir>/parallel/<childId>/params.json`）。worker 起 `run --parallel-parent <pid> --parallel-child <cid>` 时，其子实例目录恰好是同一路径（worker 的 instanceId = cid），init 时按自己的 cid 读取该 `params.json`，把**全部缺失键**注入 root scope；显式 `--params` 键优先，不被回填覆盖。这样静态 parallel 的外部依赖与 for-each 的 itemVar 都走同一通道。**driver 无需构造、无需透传任何参数**——`--params` 降级为可选覆盖（测试/调试注入）。

   **为何这不是"翻父自播种"**（区别在"谁决策拿哪份"）：撤销的 v1 误设计是 worker **代码自己**反解 idx、`readVars(父实例)` 读**整个父 vars**、自己挑 `listVal[idx]`——worker 替引擎做了"该拿哪份"的决策，且读到兄弟数据。而此处：(a) **权威**：拿哪份由**引擎** fan-out 时按 cid 算定并落盘，worker 只按自己的 cid 取回引擎备好的那一份，决策权仍在引擎；(b) **隔离**：worker 只读 `parallel/<自己cid>/params.json`（仅自己那份 item），**不碰父实例 vars、不碰兄弟**，[[#^anc-exec-parallel-subinstance]]「worker 与父/兄弟完全隔离」不破。worker 仍是哑执行体——区别是从"哑执行体+哑搬运的 driver 手工中转"简化为"引擎直接备料到位"。

   **❌ 禁止 worker 翻父实例自播种**（原 v1 误设计，已撤，仍然禁止）：worker 代码**不得** `readVars(父实例)` 自行反解 idx 挑 item——那违反上述权威与隔离两原则。回填只能读引擎备好的 `params/<cid>.json`（引擎单一权威落点），不是 worker 自己去父 vars 捞。

   **for-each 回填源缺失 → 硬报错（响亮失败）**：若 for-each worker init 时 itemVar 既不在 `--params`、其 `params.json` 也不存在或缺该键（引擎 fan-out 未落盘 = 引擎侧真 bug，或 worker 被手工错启动），返回 `MISSING_INPUT`（"for-each worker 缺 itemVar，引擎未按 cid 备料 params_for_child"），**响亮失败**而非静默翻父捞错值。静态 child 的缺失外部输入仍由步骤输入解析按既有 MISSING_INPUT 语义暴露。

**为什么 worker 偶然能跑通模板 ID = 合成 ID 的情况**：idx=0 时合成 ID `{P}.1` 恰好等于模板真实 ID，`findStepById` 命中、scope 掩码生效——但这是巧合，idx≥1 的 worker（`{P}.2`/`{P}.3`...）必然命中 null 分支，必须靠本节的解析逻辑救回。

**worker 形态下父 loop 不误入轮进（本锚在代码里的另一处落点）**：worker 子实例内子树跑完、`propagateCompletion` 级联到父 for-each loop 时，**不得**走串行迭代推进分支（`resetChildrenToPending` 会让 worker 无限重跑同一 batch——2026-08-08 真机审计实撞：worker 内 loop_counters 5.2:3、同批审 3 遍后 'No executable step found' failed）。守卫由两件构成：executeSubtreeOnly 的 **scope 掩码**（子树外兄弟预标 skipped、祖先标 running，见 [[#^anc-exec-parallel-subinstance]]）+ **收齐门**（`hasInflightFor` 有在飞即 return 不 finalize，engine-traverse.ts:351）；病理注释与 `@a:` 落点在 src/engine-traverse.ts:305-312。

## 10. fan-out 调度：CLI 顾问出决策、主 agent 持句柄执行【契约】 ^anc-exec-parallel-fanout-advisor

### 10a. 问题：调度算法散在 skill NL，主 agent"读散文自己算"

fan-out 的**满额滑动窗口调度**（初始起 `max_concurrent` 个 worker、任一完成即补位、批间无屏障、全部终态后 join）此前完全写在 skill 的自然语言里（`parallel-worker.md`），由主 agent 读散文**自己在脑子里维护窗口状态并拼 worker 启动命令**。这是一类 flaky 失效的温床——实测事故（ppt-html e2e）反复暴露：主 agent 漏拼 `--params`、漏加 doc-ref 所需 `cd <VAULT>`、原始串台（worker 自选 `/tmp` 输出路径互相覆盖）。根因统一为：**纯机械的调度计算被写成散文交给 LLM"发挥"**。

### 10b. 载体决策：为何调度器不能是 subagent、只能是"主 agent + 无状态 CLI 顾问"

一个诱人的方案是把调度外包给一个**专职调度 subagent**（它常驻、自己起 N 个 worker 子 subagent、自己收通知补位、自己 join）。**实测否决**（2026-07-08 嵌套/并发探针）：

- ✅ 探针证实 subagent **能**起 background 子 subagent、**能**收其完成通知、**能**满额补位（一对多并发成立）。
- ❌ 但 subagent 的生命周期是"**idle 即完成**"（Claude Code 机制：一个 agent 没有存活 background 子 agent 时即 fire 完成通知并 stop）。调度需要"起一批→等齐→补位→再等齐"跨**多个 idle 周期**持续持有全部 worker 句柄；调度 subagent 会在窗口周期中途 idle-complete，被 SendMessage 唤醒后**丢失对早批 worker 的通知投递**（探针中 t1~t4 跨 stop/resume 边界后再未收到通知）。

**结论——只有主 agent 是可靠的 worker 句柄持有者**：主 agent 是顶层对话循环，"idle"语义是"等用户/等通知"，天然常驻、不会 idle-complete。fan-out 所需的"稳定持有 N 个 worker 句柄跨整个窗口周期"只有主 agent 具备。这也追认了 [[reuse-mode-prompt-flow]] 里"fan-out 归主 agent、subagent 不嵌套"那条老契约的**物理根据**——不止是 hoplog 抢写，更是句柄可靠性。**本次不动该约束。**

故载体定为**职责分离**：
- **主 agent = 句柄执行器**（唯一可靠者）：起 worker subagent、收完成通知、照 CLI 给的命令原样执行。**不做任何调度计算、零 NL 发挥。**
- **CLI = 无状态调度顾问**：算"现在该起哪几个 / 补哪个 / 该 join 了"，拼好每个 worker 的**完整启动命令**（cwd、参数、log-dir 全部由 CLI 生成，主 agent 不拼）。

### 10c. 为何 CLI 能无状态复原窗口——状态本就在 .hopstate

CLI 每命令一进程、吐完即退（[[reuse-mode-prompt-flow#^anc-exec-reuse-process-model]]），无跨命令内存。它能当调度器**正因窗口调度所需的全部状态本就落在 `.hopstate`**，无需主 agent 记忆：

- **应起的全集**：fan-out 时 `recordParallelFanout` + 父 `state.json` 记录了 parallel 的全部 child_step_id 与 `max_concurrent`。
- **已完成/失败的子集**：每个 worker 子实例 `parallel/<cid>/state.json` 的 `step_states` 独立记着该 child 是 `done`/`failed`（worker submit 到终态时落盘，`writeAtomic` 原子写）。
- **已派发的子集（显式态，非目录推断）**：CLI 决定派发某 child 的**那一刻**，原子地在父 state 记 `dispatched:<cid>`——**不靠"子目录是否出现"推断**。原因见 10g：worker 的 `parallel/<cid>/` 目录由 worker run 进程创建，滞后于"CLI 决定派发"，若靠目录存在判断会在空窗里重复派发。**派发那一刻同时流式记 dispatch 事件到父 hoplog**（`recordParallelDispatch`，见下 10d + [[spec-observability#^anc-obs-parallel-dispatch]]）：`dispatched_at` = 引擎决定派发的时刻（"引擎动作时刻"，如实反映滑动窗口的**持续派发过程**，非 fanout 一瞬间塌缩），顾问进程 `load` 已 `HopLog.resume` 重建父句柄故能 append。
- **待起 = 全集 − 已派发**；**在跑 = 已派发 − 已终态**；**可补位 = `max_concurrent` − 在跑**。三者皆父 state 与子实例 state 的纯函数。

即"窗口状态"是 `.hopstate` 的**纯函数**，任一进程可无状态复原——这正是把它从"主 agent 脑内 NL 维护"移进 CLI 的依据。**派发权威归 CLI 落盘**（非从副作用推断），是并发正确性的基石（10g）。

### 10d. 接口契约（两个子命令）

- **`fanout-plan <parallel_step_id> --instance <id> --state-dir <dir>`**：`parallel_ready` 后主 agent 调一次。CLI 读父 state 全集，选出初始 `max_concurrent` 个 child，**原子标 `dispatched`**（10g），返回：`{ workers: [{ child_step_id, launch_command }], max_concurrent, remaining: [...] }`。`launch_command` 是可直接执行的完整 worker 启动命令（含 `cd <VAULT> &&`、全局 `--json`、`--parallel-parent/--parallel-child`、log-dir；**不含 `--params`**——完整 `params_for_child` 已由引擎按 cid 落盘并在 worker init 回填，见 [[#^anc-exec-parallel-foreach-worker]]）。全部终态时返回的 join command 同样自带全局 `--json`；driver 必须原样执行，不补 flag。
- **`fanout-next <parallel_step_id> --done <child_step_id> --status <completed|failed> --instance <id> --state-dir <dir>`**：主 agent 每收到一个 worker 完成通知即调，传该 child 的 id 与通知里的 `status`（`completed`/`failed`/`killed`→failed）。CLI 无状态复原窗口，若有待起 child 则选一个、**原子标 dispatched**，返回下一动作：`{ action: "launch", workers: [...] }`（补位）/ `{ action: "join", command: "join_parallel ..." }`（全部终态、该收敛）/ `{ action: "wait" }`（仍有在跑、队列已空）。
  - **child_step_id 从哪来**（通知只带 task-id）：`launch_command` 里已含 `--parallel-child <cid>`，主 agent 起 worker 时以 `<cid>` 作 subagent label；完成通知的 summary/result 自带该 label，主 agent 回读即得 → **映射靠命名，不靠脑内记忆**（否则又是 flaky 点）。
- **主 agent 侧极薄**：`parallel_ready` → `fanout-plan` → 起返回的 workers（后台 subagent，label=cid）→ 每个完成通知 → `fanout-next --done <cid> --status <s>` → 照 action 起补位 / 执行 join。主 agent 全程不拼命令、不数窗口、不记映射。

#### 10d-path. launch_command 的路径来源【契约】 ^anc-exec-parallel-launch-path

`launch_command` 里有两个路径需引擎持有：**CLI 入口**（`node "<cli>"`）与 **spec 文件**（`run "<spec>"`）。二者缺失时的行为**按值的来源分野**（同 [[../ARCHITECTURE#^anc-string-escape]]「看来源不看当前值」的判据思路）：

| 值 | 来源 | 缺失时行为 | 理由 |
|---|---|---|---|
| CLI 入口路径（`cliAbsPath`） | **包内自有信息** | **自解析**：`import.meta.url` 定位本包 `dist/cli.js` | 引擎与 CLI 同属一个 npm 包，"我这个包的 cli.js 在哪"是包内自指、与调用方无关；npm 局部装 / 全局装（经软链，须 `realpathSync`）/ 开发期 clone 三种布局下均成立。同源手法已在 `install-skill` 包根定位与 `--version` 读 package.json 处验证 |
| spec 文件路径（`specPath`） | **外部输入**（用户 `run <spec>` 给的） | **fail-fast 抛 `INVALID_STATE`** | 引擎无从自解析用户的 spec 在哪，编造必然错。且 fan-out 必由 `run <spec> --parallel-*` 驱动、必然带此值——缺失即调用方用法错，须在发生地暴露 |

**禁止静默降级**：曾用 `this.specPath ?? '<spec.md>'` 顶替，生成 `run "<spec.md>"` 这种**语法合法但注定跑不通**的命令交给 agent 照抄——错误延迟到 worker 执行时才以"文件不存在"面目出现，排查需回溯多层。与 doc-ref「找不到即显式失败」（[[../HopSpec V3核心规范#^anc-exec-doc-ref]]）同一原则：假装成功比立刻失败更坏。同理 `cliAbsPath` 原 fallback 是硬编码的开发期工作区路径，在独立库 / 用户项目 / npm 安装下全不成立。

#### 10d-Codex. barrier batch 消费方式【契约】 ^anc-driver-codex-batch-fanout

上述接口与 `.hopstate` level-triggered 调度计算保持不变；Codex 的差异只在**完成信号聚合方式**。Codex 主线程会等待同批 subagent 全部返回，再拿到整批结果，没有 CC 的“任一 worker 完成立即通知”回调。因此 Codex carrier 按批消费：

1. `fanout-plan` 取得首批 `workers[]`，同批派生 parallel worker。
2. 等本批全部返回；每个 worker 在返回前已经把终态原子写入自己的子实例。
3. 主线程按返回结果串行调用 `fanout-next`，每次都以 `.hopstate` 全量快照为权威：
   - `launch`：收集返回的新 workers，形成下一批；
   - `wait`：继续处理本批下一份结果；
   - `join`：立即停止上报，执行返回的 join 命令。
4. 下一批重复上述过程，直到 join。

**正确性依据**：`fanout-next` 是 level-triggered，不依赖通知增量；同批全部 worker 已先落盘，所以第一笔上报就可能直接返回 join，这是正常结果。Codex carrier 不要求机械上报完每个 child 后才 join。`--done/--status` 当前接口保持不变，本次不修改其引擎语义。

**职责边界**：本节只定义 Codex 如何消费既有顾问接口，不把批式 barrier 写进 Engine，不改变 `max_concurrent`、`dispatched`、join 完整性或 child fail 语义。Codex 主体拆分与 worker envelope 见 [[codex-driver-carrier#^anc-driver-codex-agent-roles]]。

**hoplog 记录时机（父日志的 parallel 事件流，见 [[spec-observability#^anc-obs-parallel-dispatch]]）**：
- `fanout-plan`/`fanout-next` 每把一个 cid 纳入 `toLaunch`（原子标 dispatched 后），紧接着 `recordParallelDispatch(pid, cid, logDir)` 流式 append 一条 dispatch 块（`child`/`dispatched_at`/`log`）。9 个 child 随窗口陆续派发 → 9 条 dispatch、时刻各异。
- `fanout-plan` 首次（即 fanout 展开）的 `recordParallelFanout` 字段序为 `max_concurrent → children → started_at`。注意 fanout 块由父 `run`（`nextParallelBatch`）写、dispatch 块由顾问进程写——分属两进程，但都 append 同一父 `main.yaml`（顾问 load 后 `HopLog.resume` 同一 run 目录）。
- `join_parallel` 记 `join` 块时带 `started_at`（进入 join 捕获）/`ended_at`（merge 完）+ 每 child 的 `log`（子实例 `hoplog_run_dir`）。

### 10e. 消除的失效 + 不变量

- **忘 `--params`**：命令由 CLI 拼，`--params` 本已由 itemVar 回填废弃（§9e），CLI 生成的命令不含它——结构性消除。
- **漏 `cd <VAULT>`**：`cd` 由 CLI 拼进 `launch_command`——结构性消除。
- **路径含空格拆裂参数**：`launch_command` 里所有路径插值（vault/cli/spec/state-dir/log-dir）**必须双引号包裹**——工作区绝对路径常含空格（如 iCloud `Mobile Documents`），裸插值会被 shell 拆成多参数（实测：`cd /Users/…/Mobile Documents && node …` 拆成 cd 到 `Mobile`、run 失败，worker 误报"引擎缺陷"）。`buildWorkerLaunchCommand` 对每个路径 `"${path}"` 加引号——结构性消除。这是[[ARCHITECTURE#^anc-string-escape]]（字符串转义规范·强制）shell 命令通道的落点。
- **`@file` 含空格拆裂参数**：driver/worker 的提交模板必须把 `@` 与完整路径作为**同一个双引号参数**，写成 `--output "@<output_path>"` / `--answer "@<answer_path>"`。只给路径部分加引号或完全不加引号都会让含空格工作区被 shell 拆参。`@` 仍须位于参数值首字符，CLI 才会读文件。
- **原始串台（worker 写 /tmp 互覆盖）**：worker 提交走引擎给的 `output_path`（work_zone 内、越界拒绝，见 [[exec-engine#^anc-exec-work-zone]]）；CLI 调度不改变这层，双保险仍在。
- **不变量**：① 句柄仍归主 agent（载体约束，10b）；② join 仍单进程（[[#^anc-exec-parallel-join-merge]]）；③ confirm 子树仍被引擎 batch 排除（[[#^anc-exec-parallel-confirm-exclude]]），CLI 顾问只调度引擎返回的 children；④ 满额窗口语义不变（初始 `max_concurrent`、任一完成补位、无批屏障），只是计算主体从 NL 变 CLI。

### 10f. 与 join_parallel 的关系（后续可简化点，本次不做）

现 `join_parallel` 要求主 agent 传入全部 `childResults`——但 child 输出已在各子实例 `vars.json`，属冗余搬运。`fanout-next` 返回 `action:"join"` 时可让 CLI 直接从子目录读齐结果自行 merge，主 agent 连 childResults 都不传。**本次仅规划、不实现**（`join_parallel` 现签名保持兼容），留作 §10 落地后的增量。

### 10g. 并发正确性：为何不丢、如何防重 ^anc-exec-parallel-fanout-concurrency

调度分散在多个吐完即退的 CLI 进程 + 主 agent 的多个通知回调里，必须证明两个方向的安全。

**方向一：完成信息不丢（天然保证，无需额外机制）**。三条事实叠加：
1. **worker durable 自记，与 CLI 时机无关**：worker 完成是它**自己的** submit 进程 `writeAtomic` 写 `parallel/<cid>/state.json` 的 done/failed——不经过 CLI 顾问，CLI 在不在跑都不影响。
2. **通知 happens-after 落盘**：worker subagent 的末动作是跑 submit **并等其返回**（done 已落盘）才结束 → 主 agent 才收到 `<task-notification>`。故"由 worker X 通知触发的 `fanout-next`"必见 X 已 done。
3. **CLI level-triggered（读全量快照）**：`fanout-next` 每次重扫全部 `parallel/*/state.json` 复原窗口，不依赖通知增量。
   → 最坏情况（两 worker 同刻完成、某次调用没读到 B 的 done）只是该次返回 `wait`；B 的 done 在盘上**永不丢**，B 自己的通知触发下一次 `fanout-next` 必见全量。**最后一个完成者**的通知触发的调用，由 happens-after 保证必见全体终态 → 稳返 `join`。**join 不漏、完成不漏统计。**

**方向二：防重复派发（需显式机制）**。危险不在丢、在**over-launch**：`parallel/<cid>/` 目录由 worker run 进程创建，**滞后于** CLI"决定派发 cid"那一刻。空窗内若主 agent 再问一次（同轮多通知并发调 `fanout-next`），靠"目录是否存在"判断会重复派发 cid。
- **对治（父 state 显式 `dispatched` 态 + 原子写）**：CLI 决定派发 cid 的**同一次进程内**，先原子把 `dispatched:<cid>` 写进父 state（`writeAtomic`），再返回 launch 指令。下一次调用读父 state 即知 cid 已派，`待起 = 全集 − dispatched` 自动排除——**不靠目录出现这个滞后副作用**。
- **主 agent 侧建议串行处理通知**（收一个 `fanout-next` 一个再起下一个）作为第二层防线；但即便并发，父 state 的 `dispatched` 原子标记是正确性**权威**，串行只是优化。
- **单写者优势**：`dispatched` 只由 CLI 顾问进程写（主 agent、worker 都不写），无多写竞争；worker 只写自己的子实例 state。派发权威单点落 CLI，符合 10b"节奏归引擎/调度"。

**不变式**：`dispatched ⊇ 已终态`（派发才可能完成）；`|dispatched − 已终态| ≤ max_concurrent`（窗口不超额）；全集每个 child 最终恰好被 `dispatched` 一次（不重不漏）。三者由"派发即原子标记 + level-triggered 复原"共同保证。

## 7. 已废弃的候选（存档）

- ~~worker L1 给整棵父树~~：违反隔离 + 兄弟分支无意义，否决（选子树视图，但 task_context 要补足目标/约束，见结论2）。
- ~~parallelMode 每命令 flag~~：worker submit 会误置 true → 内层 fan-out，否决（改 can_fanout 持久化，见结论1）。
- ~~parallel_depth 整数~~：当前一层并行用不上，YAGNI，否决（选 can_fanout 布尔）。
- ~~子树重新生根为独立 spec~~：要重编号 + 序列化往返 + 写临时 spec，易错，否决（选 scope 掩码 executeSubtreeOnly）。
