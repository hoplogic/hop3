%% @trace
	id: hopspec-v3-observability-yamll
	source: [[HopSpec V3核心规范]], [[HopSpec V3配套HopJIT运行时能力]]
	source_id: hopspec-v3-core, hopjit-runtime
	type: extend
	last_sync: 2026-07-09T20:01+0800
	note: 概念层——把执行日志(hoplog)的 YAMLL 文件格式立为可观测性的通用标准。承接 [[HopSpec V3核心规范]] 的 ^anc-obs-hoplog 定位，抽象出"日志作为可观测性载体"的概念级命题(格式不变量、保证的属性、为什么 YAMLL)。格式的缩进/字段/方法级实现细节留设计层 [[../design/spec-observability]]。
%%

# HopSpec V3 扩展——可观测性与 YAMLL 日志格式

> **本文定位**：把 HopJIT 执行日志（hoplog）的**文件格式**从"某个组件的实现细节"提升为**可观测性的通用标准**——一套任何 runtime 载体（复用模式的 CC、独立模式的 dispatcher、将来的 Codex 等）都应遵循的、让执行过程对人和 agent 可读可审计的日志格式约定。格式的具体缩进/字段/方法留设计层 [[../design/spec-observability]]，本文只立**概念级命题**。

可观测性是 HopJIT 继结构化编排、双态验证、自适应修复之后的**第四支柱能力**：执行过程必须留下一条完整、实时、可追溯的轨迹，供人和 agent 在出现预期外结果时还原决策链路、定位深层 bug、做安全审计。这条轨迹的载体就是 **hoplog**，其文件格式是 **YAMLL**。

## 可观测性的概念定位 ^anc-obs-concept

**hoplog 是执行的完整历史，不是应付式日志。** 它只追加、实时落盘，记录引擎在每个步骤上做了什么、交付了什么 prompt、得到什么产出、在哪些介入点由谁决策、并行时派发了谁、何时收敛。它服务两类读者——**人**（排查 bug、审计安全）和 **agent**（resume 时重建状态、跨进程续跑）。

它**不是**：进度条（那是瞬时状态）、状态文件（那是可变快照 `state.json`）、性能监控（那是指标聚合）。hoplog 是**不可变的、追加式的、结构化的事实流**。

> 概念源头见 [[HopSpec V3核心规范]] `^anc-obs-hoplog`——HopLog 的定位与核心要求（实时性/完整性/可追溯/安全审计/分级控制/resume 支持）。本文在其上抽象出"日志格式作为通用标准"这一层。

## 为什么是 YAMLL，而非 JSON/JSONL 或全文 YAML ^anc-obs-yamll-rationale

**YAMLL（YAML Lines，类比 JSONL）** 是本标准的核心选择：**日志由一串独立的 YAML 块顺序追加而成——每个块内部是合法 YAML，块与块之间不要求构成单一合法文档。**

这个选择是被两条真实约束逼出来的，不是审美偏好：

1. **流式追加 vs 全文合法的根本冲突**。执行是流式的——引擎每完成一个动作就 append 一条记录、立即落盘（进程随时可能崩溃或跨进程切换）。若要求"任何时刻整个文件是一棵合法 YAML 树"，就得在每次 append 时维护全局嵌套闭合（容器 mapping 何时闭、resume 标记落哪层、并行事件缩进对不对）。实测这在 resume/recover/多次续跑的组合下**反复失败**：顶格键提前截断父 mapping、深浅缩进相邻、同层重复 key、劈断子步。YAMLL **消除这一整类问题**——块与块独立，不存在"劈断父结构"，任何一条 append 都不可能破坏此前已落盘的块。

2. **人可读性 vs 机器可解析的兼得**。JSONL 每行一条记录、块间独立这一点和 YAMLL 一致，但 JSON 牺牲了人的阅读体验：无块级注释、多行文本要转义成一行、无缩进折叠。YAMLL 保留 YAML 的**缩进折叠**（块头缩进即执行树层级，编辑器按缩进折叠出"这一步下有哪些子步"的视图）、**多行 block scalar**（prompt/产出原文直接可读不转义）、**行内注释**。而全文单一 YAML 树又太脆（见上）。YAMLL 取两者之长：**块内享受 YAML 的可读，块间享受 JSONL 的独立。**

> 一句话总结：**流式日志的基本语义要求"先写的绝不因后写而改动"，YAMLL 是同时满足这条语义和人类可读性的最简格式。**

## 格式不变量（概念级，与实现无关） ^anc-obs-format-invariants

任何遵循本标准的 hoplog 实现，无论用什么语言、什么 runtime 载体，都必须保证以下不变量。**这些是概念级契约，不涉及具体缩进数值或字段名**（那些在设计层）：

1. **只追加，不回改**（append-only）。已落盘的字节永不被后续操作修改或删除。这是流式日志的**基本语义**——违反它（如缓存后重排、close 时重写全文）即破坏可观测性的信任基础，被反复禁止。
2. **块级独立**（block autonomy）。每个事件是一个自洽的块，块内合法、可单独解析；块间不构成单一文档。机器读取时按块切分再逐块解析。
3. **实时落盘**（flush-on-record）。每条记录写入即落盘，不缓冲。保证进程任意时刻崩溃，已发生的事实都在盘上——这是 resume 能重建状态的前提。
4. **层级自表达**（self-describing hierarchy）。块的缩进/键编码它在执行树中的位置（哪一步、第几层、第几轮迭代），无需外部索引即可重建执行树骨架。
5. **单一信息源**（single source of truth）。步骤级信息记为该步骤块的字段，不另设并行的 events/audits 数组镜像同一事实——冗余即漂移之源。
6. **审计无级别豁免**（audit is unconditional）。分级控制（debug/info/warn）裁剪的是**详情的详略**，但**审计性事实**（不可逆操作、人工决策、跨 spec 调用、重规划）无视级别始终记录——安全审计不能被调低日志级别绕过。

## 可观测性保证的属性 ^anc-obs-guarantees

遵循上述格式的 hoplog，对读者兑现以下可观测性属性：

- **可还原**：从一条 hoplog 能重建"发生了什么"的完整因果链——每步的输入、交付的 prompt、产出、耗时、决策者。深层 bug 的排查不依赖复现，读日志即可定位。
- **可追溯**：跨进程、跨并行子实例的执行通过 `trace_id`（继承自顶层 instance）串联；并行 fan-out 的每个 child 有独立子日志，父日志记录"派了谁、何时派、成败、去哪看详情"，形成可导航的树。
- **可审计**：不可逆操作（commit）、人工决策（confirm 的 HITL 记录）、跨 spec 调用、自适应重规划都是审计性字段，grep 日志即提取完整审计链，无需专门的审计管道。
- **可续跑**：resume 时从已落盘的块重建状态（哪些步已完成、循环到第几轮、并行派发了谁），执行可从中断处继续——日志同时是**状态的持久化真相**。
- **可分级**：同一套格式在 debug/info/warn 三级下裁剪详略（debug 记完整 prompt 原文，info 记值与轨迹，warn 只记骨架与审计），适配"深度排查"到"轻量留痕"的不同场景，而审计与结构不变。

## 跨模式与跨载体的一致性 ^anc-obs-cross-mode

可观测性作为**通用标准**，其价值在于跨 runtime 载体一致：

- **复用模式**（CC 作推理 LLM）与**独立模式**（dispatcher 内部调 LLM）产出**同构**的 hoplog——引擎侧事件（步骤生命周期、fan-out/join、介入点、交付的 prompt）由引擎统一记入 hoplog；推理内幕与工具调用明细在复用模式下由 caller 侧工具记录，两者以"引擎交付/回收的边界"为分界。
- **并行子实例**继承父 `trace_id`，子日志目录嵌套于父 run 目录下——目录结构即关联，无需额外的关联表。
- 将来接入的其他载体（Codex 等）只要遵循本文的**格式不变量**与**保证属性**，其日志就能被同一套工具链（人读、grep 审计、resume 重建）消费——这正是"把格式立为标准"的意义：**载体可换，观测契约不变。**

---

> **引用**（概念在此立，实现细节见设计层；本文是源，设计层是 `extend` 派生）
> - [[HopSpec V3核心规范]] §HopLog `^anc-obs-hoplog` — HopLog 的概念定位与六项核心要求（本文可观测性定位的源头）
> - [[HopSpec V3配套HopJIT运行时能力]] — HopJIT 四支柱能力，可观测性是其一
> - [[../design/spec-observability]] `^anc-obs-nested-tree` — YAMLL 格式的完整实现契约（块结构、缩进 `2d`/`2d+2`、loop `#iter`、块间独立）
> - [[../design/spec-observability]] `^anc-obs-timestamp` — 时间戳格式与毫秒精度
> - [[../design/spec-observability]] `^anc-obs-parallel-dispatch` / `^anc-obs-parallel-child-satellite` — 并行 fanout/dispatch/join 事件流与 child 归子日志
> - [[../design/spec-observability]] `^anc-obs-log-levels` / `^anc-obs-audit` — 三级日志与审计字段无级别豁免
> - [[../design/spec-observability]] `^anc-obs-hoplog-flush` / `^anc-obs-hoplog-resume` — 实时流式落盘与跨进程 resume 的延迟结构化写入
