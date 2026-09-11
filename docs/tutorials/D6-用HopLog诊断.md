%% @trace
	id: hopjit-tutorial-dev-hoplog
	source: [[../concepts/HopSpec V3扩展-可观测性与YAMLL日志格式]]
	source_id: hopspec-v3-observability
	type: compact
	last_sync: 2026-08-30T15:28+0800
	note: D 系列 5——HopLog 诊断实用篇：它是什么（完整历史非应付日志）→ 文件在哪 → 块怎么读 → 六个常见诊断问题的查法 → 与 state.json 分工 → 级别与审计
%%

# D6 · 用 HopLog 诊断：执行的完整历史

**给谁**：要排查一次执行"到底发生了什么"的开发者——跑挂了、结果不对、卡住不动、怀疑 AI 驱动没按协议来。
**一句话定位**：**HopLog 是执行的完整历史，不是应付式日志**——每步交付了什么 prompt、得到什么产出、谁在介入点做了决策、并行派了谁，全部只追加、实时落盘。深层 bug 的排查**不依赖复现，读日志即可定位**。
**权威**：概念 `docs/concepts/HopSpec V3扩展-可观测性与YAMLL日志格式.md`；设计 `docs/design/spec-observability.md`。

## 文件在哪：目录即导航

```
.hoplog/
  expense-check-20260811T114605-a510/     ← 一次运行一个目录：{spec_id}-{run_id}
    main.yaml                             ← 主日志（父执行树全程）
    parallel/                             ← 并行 worker 子日志（有并行才有）
      2.1/…-{run_id}/main.yaml            ← 每个 child 一棵独立完整日志
```

三个 ID 分工记住就不会迷路：

| ID | 长相 | 用途 |
|---|---|---|
| `run_id` | `20260811T114605-a510`（时间戳+4hex） | 标识**单次运行**——目录名里的就是它 |
| `trace_id` | UUID | 标识**整棵执行树**——call/parallel 子实例继承父的，grep 一个 trace_id 找齐父子全部日志 |
| `instance_id` | UUID（顶层运行 = trace_id） | 定位 `.hopstate/<instance_id>/` 状态目录 |

并行子日志靠**目录嵌套即关联**——不用 grep，进 `parallel/<child_step_id>/` 就是那个 child 的完整世界。

## 块怎么读：YAMLL 三分钟

HopLog 的格式叫 **YAMLL**（YAML Lines）：日志是一串**独立 YAML 块**顺序追加——块内是合法 YAML（可读、可折叠、多行原文不转义），块间不构成单一文档（任何一条追加都不可能破坏之前落盘的内容）。这是被"流式追加 vs 全文合法"的真实冲突逼出来的选择，不是审美。

一份 `main.yaml` 从上到下三段：

```yaml
spec_id: expense-check          # ① 头部：谁、哪次、什么级别、输入是什么
run_id: 20260811T114605-a510
trace_id: 5aa3fd08-…
level: debug
inputs: { expenses: [120, 88, 1500, 260], auto_limit: 2000 }

execution:                      # ② 执行段：每步一个块，缩进即执行树层级
  "1":
    type: act
    summary: 合计与找最大单笔
    at: "2026-08-11 11:46:05"
    inputs: { expenses: […] }
    llm:
      prompt: |                 # debug 级：交付的完整 prompt 原文（6 层上下文）
        …
    response: { total: 1968, … }
    outputs: { total: 1968, … }
    status: completed

status: completed               # ③ 终态：整次运行的结局
ended_at: "…"
```

**读法要点**：块头缩进 = 执行树位置（`"2.1"` 缩在 `"2"` 下）；loop 迭代带轮次键（`"3.1#2"` = 第 2 轮）；每步的 `inputs`（它拿到什么）→ `llm.prompt`（引擎交付了什么上下文）→ `response`/`outputs`（它交回什么）→ `status`，一条因果链完整闭合。

## 六个常见诊断问题的查法

**① 挂在哪一步、为什么？** 搜 `status: failed` 定位失败块，读它的 `reason` 与 `fail_kind`（D4 讲的 FailRecord 在这里入轨）。retry 过的步骤有多个轮次块（`#2`、`#3`）——逐轮 reason 就是失败历史。

**② 结果不对，是谁算错的？** 沿数据流反查：结果变量在哪步的 `outputs` 首次出现 → 看该步 `inputs` 是否已经错了 → 是则再往上游步骤查。**每步的进出都在案**，错值的引入点一定能逼出来。

**③ LLM 到底看到了什么？**（怀疑 prompt 组装有问题时）debug 级日志的 `llm.prompt` 是交付的完整 6 层上下文原文——不用猜"它是不是没看到约束"，打开看。这是排查"AI 为什么这么答"的唯一可靠通道。

**④ 卡住不动，走到哪了？** 看 `execution:` 最后一个块：有 `at` 没 `status` = 该步交付出去还没回（复用模式=还在等 caller submit）；块是 `type: confirm/ask` = 停在介入点等人。配合 `/hopspec status` 看引擎侧状态。

**⑤ 介入点是谁答的、答了什么？**（怀疑 AI 替答时）confirm/ask 块的 `hitl:` 字段记录呈现了什么、选项、回答、决策者——**没有 `hitl:` 块 = 没人答过**。e2e 的 cc:paused 场景断言的正是"无 hitl 块"。

**⑥ 并行哪个 child 出的事？** 父 main.yaml 的派发/收割块记录派了谁、成败；进 `parallel/<child_step_id>/` 看该 child 的独立完整日志。call 子实例同理（父实例 `calls/` 目录 + trace_id 继承）。

## 与 state.json 的分工：一个查"怎么发生"，一个查"现在怎样"

| | HopLog | `.hopstate/<inst>/state.json` |
|---|---|---|
| 性质 | **不可变事实流**（只追加） | **可变状态快照**（随执行更新） |
| 回答 | 怎么一步步走到这的（因果链） | 现在每步什么状态、失败账、重试计数 |
| 典型用途 | 排查 bug、审计、复盘 | resume、修复决策、快速看进度 |

诊断的节奏通常是：state.json 一眼看**现状**（哪步 failed、第几轮）→ HopLog 深挖**过程**（那几轮各败在哪、prompt 里有没有猫腻）。

## 级别与审计：能调详略，不能关审计

三级向下包含：`debug`（完整 prompt 原文）⊇ `info`（值与轨迹，缺省）⊇ `warn`（骨架）。跑法：`--log-level debug`（driver 协议缺省已带）。

**审计无级别豁免**：不可逆操作（commit）、人工决策（hitl）、跨 spec 调用、重规划（`replan_audit`）**无视级别始终记录**——安全审计不能被调低日志级别绕过。这意味着：即便 warn 级的日志，审计链也是完整的，grep 即提取。

## 顺手的三条命令

```bash
ls -t .hoplog/ | head -3                          # 最近三次运行
grep -n "status: failed" .hoplog/<run>/main.yaml   # 定位失败块
grep -rn "<trace_id>" .hoplog/                     # 串起一棵执行树的全部日志
```

## 下一步

- [[D7-开发自己的工具]]——工具调用的进出都在日志里，写工具时它是你的调试台；
- 格式不变量与跨载体一致性（为什么任何实现都必须这样）：概念文档 `^anc-obs-format-invariants`；
- 全部块类型与字段权威（步骤键/审计字段/parallel 派发块/resume 标记）：`docs/design/spec-observability.md`；
- 失败语义本身（reason/fail_kind 怎么来的）：[[D5-错误与异常处理]]。
