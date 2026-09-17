%% @trace
	id: hopjit-tutorial-dev-aicoding-en
	source: [[../../../tutorials/D2-用AI做工程-AIcoding与验收]]
	source_id: hopjit-tutorial-dev-aicoding
	type: translation
	last_sync: 2026-08-15T13:43+0800
	note: English translation of D2-用AI做工程-AIcoding与验收. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D2 · Engineering with AI (Part 2): AI Coding and Acceptance

**Who this is for**: people who have finished [[D1-engineering-with-ai-concept-to-design]], whose design is finalized, and who are about to let AI touch the code.
**The main line**: AI writing code is not scary — **unconstrained AI writing code** is. This part covers three things: the rules laid down for the AI (the behavioral constitution), the complete rhythm of one change, and how humans do acceptance.

## The rules laid down for the AI: four behavioral-constitution articles

These four are written in this repo's `CLAUDE.md` (auto-loaded into every AI session) and are the AI's hard boundaries for action — you need to know them because **at acceptance time, what you check is precisely whether these four were upheld**:

1. **Collect the chain first**: before acting, the anchor implementation chain must be collected first (upstream contracts / dependencies / blast radius). An AI that writes without collecting the chain = walking blind outside the feasible region;
2. **Design first, no cross-layer shortcuts**: before changing `src/`, the corresponding `design/` must be finalized first — the AI's most common failure is jumping straight from idea to code. Machine-check criterion: a change touching src without touching design = layer skipping;
3. **Bug fixes are not exempt**: the more a bug looks like "one line fixes it", the stronger the temptation to skip layers. The order: first read the design clause governing this behavior → judge "the code didn't follow the design" vs "the design needs changing" → tests come as a positive/negative pair;
4. **Strictly no drive-by changes**: when the AI discovers another problem while executing a task, reporting it is its duty; handling it on its own is overstepping.

Plus one engine of the human-AI division of labor (covered in D1): **derivation the AI does directly; decisions must come back to the human** — an AI asking you something derivable from settled principles is a dereliction, and an AI making a real decision on its own is equally a dereliction.

## The complete rhythm of one change (the shape of the task you give the AI)

Take a real small case — "one class of validate errors lacks the step number; add it":

```
① You assign:   "Fix the validator's XX error missing the step number; follow the
                engineering chain spec, the trio, and positive/negative-example tests"
                                              ← one sentence hooks the discipline on
② AI collects the chain:  finds the anchor owning the error site → opens the
                TRACEABILITY card → reports the blast radius
③ AI judges:    message format not locked by the design → derivation, do it directly
                (if it touches contract semantics like error grading → stop and
                escalate to you for sign-off)
④ AI design-first: writes "message includes step number" into the design clause
                (before any code)
⑤ AI changes code:  changed lines carry the @a: anchor tag
⑥ AI adds tests:  positive/negative pair — positive = new message includes the step
                number; negative = scenarios that shouldn't carry it don't
⑦ Machine check:  npm run check (types/anchors/layer-direction/tests/audit
                baseline/version interlock)
⑧ Live e2e:     mandatory when the change touches carrier protocols / the execution
                chain (see "the two legs of testing" below)
⑨ You accept:   see the next section
```

**The key to task-assignment phrasing**: say the words "follow the engineering chain spec", "the trio", "positive/negative examples" out loud — they are not pleasantries, they are the anchors that hook the AI onto the discipline. This repo's historical experience: leave them unsaid and the AI cuts corners; say them and the AI's output comes with acceptance-ready structure built in.

**Two directly reusable standard phrasings** (one for pushing, one for review — verbatim from this repo's practice):

> **Push implementation**:
> "推动，严格按照工程链规范实现，落实设计 HOP 三件套，实现时同步设计代码一致性，保持设计合理性，测试时保障正反例覆盖。"

> **Engineering chain review**:
> "根据锚点做工程链 review，检查设计三件套完整性，设计合理性，设计代码一致性，和测试正反例覆盖。"

The first is for assigning / pushing forward — it hooks all five essentials at once (engineering chain spec / the trio / design-code consistency / design soundness / positive-negative examples); the second is for stage acceptance — the review's four check dimensions are the acceptance checklist itself, and the AI will verify clause by clause along the anchors and file its findings by dimension. Used together they form the "push a stretch → review a stretch" rhythm — the steadiest loop for steering AI through long-range engineering.

## The two legs of testing: positive/negative coverage + end-to-end on the real machine

The tests the AI adds must stand on both legs; missing either one makes it a false assurance:

**Leg one: sound positive/negative coverage**. Not "there are tests", but **every boundary touched is pinned from both sides** — positives prove the new behavior holds, negatives prove old behavior wasn't collaterally broken and exception paths aren't waved through. The most common padding in AI-written tests is positives only (test what you changed, everyone's happy); at acceptance, go straight for the negatives: is what the negative pins down the very boundary this change introduced or moved? Coverage numbers are only a reference — **boundary coverage is the criterion**.

**Leg two: end-to-end tests on the real machine, not skippable**. All-green unit tests prove "the parts are individually correct"; they cannot prove "it runs when mounted in the real carrier" — this repo's hard-won history: mocks all green while the real machine went red three rounds (codex's MCP registration channel, the clean environment, the approval layer — each one exposed only on the real machine).

The thing to remember about live e2e: one command before release (for routine quick checks use `test:live:smoke`):

```bash
npm run test:live:core
```

It runs the full chain in the **real CC/Codex carriers** (not mocks): dual-carrier execution handoff, weak-model long-range driving, the demo named skill, standalone mode (MCP server), parallel dispatch — every scenario has deterministic assertions, and passing evidence lands in `.e2e-evidence/`, from which the release gate verifies "both green and fresh". The batch entry runs a **task pool at concurrency 5** (total time ≈ the bottleneck scenario, about 8 minutes; if you hit rate limits, downshift with `HOPSPEC_E2E_CONCURRENCY=3`). The same family has several specialized batches; pick by what you changed:

| Command | What it tests | When to run |
| ---------------------------- | ------------------------------------------ | -------------------- |
| `npm run test:live:smoke`    | Routine tier, four smokes (tool three-channel / mcp binding / multi-run isolation / large-input inline; zero/single LLM, ~2min) | Run casually after engine changes |
| `npm run test:live:core`     | Release tier, 15 scenarios (9 happy + 6 failure paths; two concurrent waves, ~13min) | After changing carrier protocols, the execution chain, or failure semantics; mandatory before release |
| `npm run test:live:deep`     | Trigger tier, LLM quality surface (audit deep-check / primer blind test / flash weak-model long-range; single items runnable) | After changing prompt assembly / primer / capability gates, per the trigger clauses |
| `npm run test:e2e:<carrier>:<scenario>` | Any single scenario above (e.g. `test:e2e:codex:standalone`) | Pinpointing a problem, re-verifying a fix |

All of these are **scripted one-shot verifications** (scenario assertions + evidence on disk); the only difference is **who presses Enter**: whatever the AI's sandbox can run, the AI runs itself; whatever it can't (can't start the codex app-server, can't reach the LLM endpoint), **the same script** goes to a human who runs one command in a terminal and pastes back the output — skipping because "my environment can't run it" is not allowed. **The AI's duty is to write the script down to "one command + an unambiguous criterion"**, so whoever runs it gets the same judgeable result, rather than shoving testing responsibility onto the human.

When assigning work, say this one out loud too (beyond "测试时保障正反例覆盖" in the push phrasing, add for carrier-protocol-touching work: "**verify with live e2e; whatever you can't run, write me an acceptance script**").

## Human acceptance: check the chain, don't read the code line by line

After the AI delivers, your acceptance actions in descending cost-effectiveness order:

1. **Are the machine checks green**: `npm run check` all green is the floor — types, anchor format, layer-direction dependencies, all tests, audit baseline, version interlock; the machine has already done the first round for you. For carrier-protocol-touching changes, also check that the live e2e evidence (`.e2e-evidence/`) is fresh;
2. **Is the chain aligned**: what the design clause says = what the code does = what the tests pin down? Spot-check along the anchors (`grep '@a: <anchor>' src/`, `grep '@v: <anchor>' tests/`) — focus on whether **the tests' negatives** pin the very boundary moved this time (positives-only is the most common padding in AI-written tests);
3. **Was any decision overstepped**: does the AI's report show anything changed "in passing" beyond the task, anything it should have asked you but didn't;
4. **Semantic audit (milestone tier)**: machine checks cannot judge "does the design faithfully convey the concept's intent" — before releases/milestones run anchor-audit (the semantic-audit skill; human/LLM verifies the full set along the anchors).

**Reading code line by line is not on the list** — not that you can't, but it has the lowest cost-effectiveness: once the trio has locked the degrees of freedom, the machine checks have held the deterministic forms, and the chain alignment has verified faithfulness, the marginal return of line-by-line reading is very small. Your attention should go to decision points and boundaries (the negatives).

## Three failure classes and their remedies (the pathology of acceptance)

| Failure | Symptom | Remedy |
|---|---|---|
| Feasible-region drift | The AI's implementation "looks right" but violates some upstream principle — because the boundary wasn't in its context | Collect the chain first (require chain collection when assigning) |
| Cross-layer shortcut | src changed, design untouched — the AI jumped straight from idea to code | Machine check hard-blocks + assignment phrasing hooks the discipline |
| Role confusion | The AI decided in your place, or conversely brought a derivable matter to you as a question | Acceptance check #3 + good assignments state the settled decisions clearly |

## Standing tool quick reference

| What you need | Command / place |
|---|---|
| Full machine check | `npm run check` (fast version `check:fast`) |
| Locate a contract's full-chain footprint | `grep -n "<anchor>" TRACEABILITY.md` |
| Try a change locally | `npm run dev:install` (rebuilds dist + refreshes skill; run at repo root) |
| Semantic audit | `/hopspec run scripts/audit/anchor-audit.md` (supports per-module runs) |
| Routine commit/release checklist | the maintainer operations manual (internal, not distributed in the public snapshot; manual layer, follow it every time) |
| New module | eight-item checklist delivered in one change (`chain-enforcement.md` §1c-2) |

## Next step

To assign the AI **architecture-level** work (cross-module, touching Provider boundaries, adding a carrier): first read [[D4-architecture-walkthrough]] to build the panorama.

## The essence of this method

Four-layer narrowing (concept-architecture-module-design) + the trio's expression + the anchor chain + machine-check guards together solve one problem: **making AI's productive capacity usable without losing control**. Human attention is freed from "writing code, reading code" and concentrated on the two things only humans can truly do — **setting direction (decisions) and holding boundaries (acceptance)**. This is also the HopSpec language's own philosophy (lock the goal, hold the boundaries, free the path) applied isomorphically to the engineering process: free the path for the AI developer, and guarantee correctness with structure rather than surveillance.
