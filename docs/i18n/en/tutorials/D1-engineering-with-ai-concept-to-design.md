%% @trace
	id: hopjit-tutorial-dev-concept-to-design-en
	source: [[../../../tutorials/D1-用AI做工程-从概念到设计]]
	source_id: hopjit-tutorial-dev-concept-to-design
	type: translation
	last_sync: 2026-08-15T13:43+0800
	note: English translation of D1-用AI做工程-从概念到设计. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D1 · Engineering with AI (Part 1): From Concept to Design

**Who this is for**: people who have finished [[D0-ecosystem-developer-guide]] and want to do real development in the HOP ecosystem.
**The main line, stated up front**: HOP engineering's development style is not "humans read code, humans write code" — it is **humans steering AI to do engineering**. The human narrows "what to build" layer by layer along **concept → architecture → module → design**, narrowing until the design layer expresses it clearly in the **HOP trio**, then hands it to AI coding (Part 2: [[D2-engineering-with-ai-coding-and-acceptance]]). This part covers the first half: how to narrow, and at each layer what the human does and what the AI does.

## The core mental model: feasible-region narrowing layer by layer

Each layer's output is not "a single determined point" but **the feasible region of legal solutions** — the layer below keeps locating within that region, until the code layer narrows it to one executable point:

```
Concept layer   What are we building, what must it be like     ← the feasible region's initial shape
  ↓ narrow
Architecture    How many layers, how components interact, where the boundaries are
  ↓ narrow
Module layer    Which module owns this, what its external interface is
  ↓ narrow
Design layer    Contracts/types/flows locked down (the trio)   ← the input to AI coding
  ↓ narrow
Code            One executable point (AI writes it)
Tests           Verify the landing point is still inside the region (AI writes, machine checks guard)
```

**Inside every layer there are two kinds of content**: derivation products (locked down automatically by the layer above — AI just does them, no asking) and decision points (genuinely multiple legal options — **the human decides**). This dividing line is the engine of the whole method: everything the AI can derive goes to the AI; the human appears only at decision points.

## At each layer, what the human does and what the AI does

| Layer | Human (the one who signs off) | AI (the one who derives) |
|---|---|---|
| Concept | Sets the system's identity: what to build, safety semantics, behavior rules ("key principles and rules" is the chain source for all downstream derivation) | Helps you organize ideas into structural definitions + principle clauses, but **the core viewpoints must come from you** |
| Architecture | Signs off on directional choices of layering and boundaries (change it = you build a different system) | Derives component partitioning and interaction protocols from the concept principles, marking which parts it derived and which need your sign-off |
| Module | Verifies module boundaries and export lists (the closed set of external interfaces) | Derives module responsibilities and dependency directions from the architecture, drafts module design doc skeletons |
| Design | **Reviews** whether the trio faithfully conveys the upstream intent | **Writes** the trio (this is the AI's main output, see below) |

## The design layer's standard of expression: the HOP trio

Design docs do not use free prose — with prose, AI "understands it its own way"; the trio leaves AI nowhere to drift. Each piece below comes with an excerpt from a real design doc, so you can see concretely what "locked down" looks like.

### Piece one: the Hop contract (HopTrait) — locks the capability promise

The Steps-less spec form (Goal / Inputs / Outputs / Constraints), answering "what does this capability promise". A real example — the mcp-server "restore run after restart" contract (excerpt from [[../../../design/mcp-server#^anc-mcp-run-restore]]):

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

**How to read it**: Goal states the mission in one sentence; Inputs/Outputs fix the data shapes; **Constraints are the soul** — each one is an explicit ruling on an error path (what if the snapshot doesn't exist, what if it's corrupted, when to reject bad input). When the AI writes code against this contract, **every if-branch has a source**; there is no room for "I feel like an error should go here" improvisation. When you review it, ask clause by clause: which failure scenario is still unruled?

Another real example: [[../../../design/codex-driver-carrier#^anc-driver-codex-standalone-dispatch]] (the standalone thin protocol — notice how its Constraints turn "locked for the whole run, no switching the executing body" into an inviolable clause).

### Piece two: HopType — locks the component structure

The component's type description; **four elements**, and missing any one disqualifies it (the descriptive-spec authority: [[../../../concepts/HopType体系#^anc-hoptype-desc-spec]]). A real example — the skeleton of ExecutionEngine's positioning section ([[../../../design/exec-engine#^anc-struct-exec-engine]], structure abstracted here):

```
① 自身定位：ExecutionEngine 是 HopJIT 的执行状态机——驱动规约从初始化到终态。
   管理四件事：步骤状态机 / 变量空间 / retry-adaptive / 崩溃恢复
② 与其他 HopType 的关系：被 CLI（复用模式）与 Dispatcher（独立模式）驱动；
   状态经 PersistenceProvider 落盘；prompt 组装委托 PromptAssembler…
③ 主要 traits 与主要成员：（分组逐条——生命周期组 init/load/recover、
   调度组 next_step/complete_step/fail_step、访问器组…每个成员一句话职责）
④ 核心 impl 的主要 HopSpec 逻辑：（关键行为的流程表达，见件三）
```

**Each of the four elements locks one drift point**: ① prevents vagueness about "what exactly does it own" (the boundary sentence must be a countable list like "manages four things"); ② prevents component relations resting on guesswork (who drives it, whom it delegates to — the wiring is explicit); ③ prevents member responsibilities from drifting (one-sentence promise per method; when the AI adds a method you can immediately see "this belongs to no group"); ④ prevents key logic hiding inside the code (it is lifted to the design layer and expressed with piece three). **More than 5 members must be grouped** — nobody actually reads an ungrouped long list.

### Piece three: HopSop — locks the key logic, and honors the contract clause by clause

Sequence / loop / branch + hierarchical numbering (the same syntax taught in user tutorial 02; the syntax standard: [[../../../concepts/HopSop标准作业流程#^anc-flow-core-requirements]]). A real example — the complete key logic of restoreRun (**the same capability as piece one**: the contract sets the promise, this sets how it is honored):

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

> Syntax reminder: HopSop has **only** sequence, `[循环]` (loop), `[分支]` (branch) + `[条件()]` (condition), and `[子任务]` (subtask) — ordinary steps carry no bracket annotation at all. It deliberately **excludes** HopSpec's step types (`[act]`/`[reason]`…) and data flow: who executes and how data flows are filled in only when upgrading to HopSpec (see the comparison table in user tutorial 02). If you see `[act]` mixed into a flow block in a design doc, that is a typo — the boundary between the two languages must be held.

**The key reading method: the flow honors the contract's Constraints clause by clause** — put piece one's contract next to it and match, not one more and not one less:

| The contract's Constraints say | Which flow step honors it |
|---|---|
| Snapshot doesn't exist → RUN_NOT_FOUND | the conditional branch at step 1 |
| Snapshot corrupted → RESTORE_FAILED (doesn't crash the server) | step 2's annotation "corrupted means RESTORE_FAILED" |
| Provider not serializable → re-inject with current config | step 3 (rebuild from config.yaml + reconnect via setHostConfig) |
| Bad step_id rejected before any state change | the miss branch's precheck (INVALID_STATE, stays paused) |

This matching is exactly **the method for reviewing a HopSop**: every Constraints clause of the contract must have a nameable honoring point in the flow — can't point to one = the flow missed a ruling; the flow contains behavior the contract never mentioned = go back and amend the contract (a sprout of improvisation). Same when the AI writes code: the five flow steps map one-to-one onto the function skeleton, and the annotations are micro-contracts (dropping step 4's "budget continues across restarts" is a design-code inconsistency); acceptance walks these two layers of matching.

### How the three pieces work together

The complete design of one capability = **contract (what is promised) + type (who carries it) + flow (how it is achieved)**. This section's running sample, restore_run, has all three: the contract rules on every error path → the type states "no new type; reuse RunEntry" (even when no new structure is needed, say so explicitly — silence lets the AI freely invent one) → the flow honors the contract clause by clause and yields the function skeleton. With all three degrees of freedom locked, the AI's remaining job is faithful translation — **"translating into code is just a few ifs" is precisely the criterion for a finalized design**. For the full original, see [[../../../design/mcp-server#^anc-mcp-run-restore]].

> **📖 To read these docs, opening this repo in Obsidian is strongly recommended** (treat `hoplogic3/` as a vault): the `[[wiki-links]]` and `#^anchors` above all become clickable jumps — click a contract link to land on that section, use an anchor's backlinks to see "who references this contract" in one step, and see the concept→design derivation network visually in graph view. In a plain-text editor these links are just strings, and half of the chain's navigability is lost.

**Why exactly these three**: AI coding's biggest failure mode is "improvisation" — filling in whatever you left unsaid with its own imagination. The essence of the trio is to explicitly lock down all three improvisation spaces (promise, structure, logic).

## Anchors: stitching the layers into one chain

Every design contract carries a `^anc-*` anchor, implementation points in code are tagged `@a: anc-*`, verification points in tests are tagged `@v: anc-*`, and `TRACEABILITY.md` gathers them into cards. This is not documentation hygiene — it is **the reins by which humans steer AI**:

- When assigning work to the AI, have it **collect the chain** first (gather the upstream contracts, dependencies, and blast radius along the anchors) — the AI works inside the feasible region instead of improvising from memory;
- When accepting the AI's output, verify along the same chain — do the three layers align: what the design says, what the code does, what the tests pin down;
- One practical command beats reading everything: `grep -n "<anchor>" TRACEABILITY.md` opens the card and shows the whole chain.

## Hands-on: walk "reading a design" on a real module

Take `docs/design/doc-ref.md` (163 lines, complete in every part) and validate the perspective you've built:

1. The **grading table** at the top — which sections are 【契约】(contract, locked) and which are 【说明】(explanation, skimmable);
2. The **positioning section** — an instance of the four HopType elements: what it is, how it connects to parser/engine;
3. Pick one 【契约】section and read it — notice how it nails the behavior down to the point where "the AI has no room to improvise";
4. `grep -n "anc-exec-doc-ref-resolve" TRACEABILITY.md` opens the card — see where this contract lands in code and tests. **You do not need to read that code** — what you need to know is that the chain exists and is checkable.

## Next step

[[D2-engineering-with-ai-coding-and-acceptance]] — the second half: once the design is finalized, how to assign work to the AI, what discipline the AI writes code and tests under, and how humans use machine checks and the chain for acceptance.
