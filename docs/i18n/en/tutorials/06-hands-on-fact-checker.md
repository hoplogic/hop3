%% @trace
	id: hopjit-tutorial-fact-check-en
	source: [[../../../tutorials/06-实战-事实核查器]]
	source_id: hopjit-tutorial-fact-check
	type: translation
	last_sync: 2026-08-30T07:12+0800
	note: English translation of 06-实战-事实核查器. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 6 · Hands-On: A Complete Dissection of a Fact Checker

**Goal**: read through `examples/hop-fact-check.md` section by section — a real, usable document fact checker — and see how the components covered in tutorials 03/04/05 (gatekeeping gates, deterministic computation, parallel iteration) assemble into a complete machine.
**Prerequisites**: complete [[03-explore-and-commit]], [[D10-hop-python-compute]], [[05-parallel-and-for-each]] (this tutorial assumes you know these components).

## What it does, and why it's worth copying

Give it a document, and it digs out every **factual claim** (verifiable) and every **inferred conclusion** (derived from facts), one by one, hands you a quick-view list, and then verifies them **in parallel** item by item — fact points get external-evidence searches with credibility labels on their sources; inference points get premise tracing plus reasoning-fallacy review — finally converging into a two-dimensional verdict report.

**Warm-up (30 seconds, runnable if you installed `--demo`)**: get a feel with the demo version first — it only checks first-order facts (directly verifiable claims), so the flow is short:

Claude Code command:

```
/demo-fact-check 核查 ~/.claude/skills/demo-fact-check/fact-check-sample.md
```

Codex command (skill installed inside the project):

```
$demo-fact-check 核查 .agents/skills/demo-fact-check/fact-check-sample.md
```

**This tutorial dissects the full version**, `examples/hop-fact-check.md` (in the project repository, not shipped with the npm package) — because the four advanced pieces this tutorial covers (self-check loop, inference fork, mechanical roll call, two-dimensional verdict) are precisely the ones the demo version cut for brevity. The sample input `fact-check-sample.md` is a short essay on coffee and health that **deliberately buries verifiable fact points and one leap-of-logic inference** — the last paragraph jumps from "coffee doesn't cause cancer" to "pregnant women and heart patients can rest easy". The demo version can't catch this leap (it doesn't handle reasoning); the full version nails it:

Claude Code command:

```
/hopspec run examples/hop-fact-check.md --params '{"doc_path": "examples/fact-check-sample.md"}'
```

Codex command:

```
$hopspec run examples/hop-fact-check.md --params '{"doc_path": "examples/fact-check-sample.md"}'
```

This spec is worth copying as a template because it plugs all three big pitfalls of "LLMs are unreliable workers" with structure — and **every one of those plugs is something you just learned**. The dissection below follows execution order.

## Dissection 1: the extraction phase — how to write a "self-check loop" (steps 1-2)

The naive way is a single `[reason]` step, "extract all check points" — and when the LLM misses one, you never know. Instead, this spec writes a **retry loop with a feedback channel**:

```
1  [act]              Initialize extract_gap = ""        ← feedback channel, empty at first
2  [subtask retry=2]  Extract and accept
   2.2  [reason]      Extract (← doc_content, extract_gap)
   2.3  [check final] Accept for completeness (→ extract_ok, extract_gap)
```

The mechanism, taken apart:
- `2.3 [check final]` scans the source text paragraph by paragraph to verify the list is exhaustive — **if incomplete, it sets `extract_ok=false` and writes the missing items into `extract_gap`**;
- the check failure triggers the subtask retry → 2.2 reruns, and this time its `← extract_gap` **reads what was missed last round**, patching the gaps in a targeted way instead of starting over;
- `retry=2` caps it, preventing an infinite loop (first round + 2 retries).

This is the advanced piece [[05-parallel-and-for-each]] didn't cover: **check final + a feedback variable = a self-acceptance loop**. It's fine for the LLM to miss things on the first pass; the acceptor is also the LLM, but the acceptance has the source text to compare against and an explicit criterion ("is any verifiable claim unlisted") — far more reliable than "get it right in one shot". Note that the feedback variable `extract_gap` is explicitly initialized with `[act]` in step 1 — variable declaration is a visible step in the spec, not magic.

## Dissection 2: list quick-view — informational presentation, not a confirmation stop (step 3)

```
3. [act] Generate check-point quick-view and stats
```

The list is shown to you before the fan-out (parallel checking) — a stats line first (total / facts / inferences), then one line per point. Note this is **informational presentation, not a confirmation stop**: execution does not pause for your answer; if the list looks wrong you can abort the run at any time. This design went through a reversal: the early version put an `[ask]` confirmation stop here (the list proceeded only after human approval), but real use showed lists routinely run to dozens of items and item-by-item human review adds little — step 2's self-check loop already guards completeness, and what the human needs here is a chance to "glance for obvious derailment", not a forced stop. **When to use ask versus plain presentation** comes down to one test: will the human's answer change subsequent execution? Yes (a value or decision is needed) → ask; no (information only) → an informational step — don't interrupt people with a stop point.

## Dissection 3: parallel checking — four layers of structure at a glance (step 4)

This is the thickest section of the whole spec: four levels of nesting, each doing exactly one thing:

```
4      [loop for-each point in points, collect check_item into check_result]
4.1      [subtask retry=5 parallel]          ← parallel + per-point retry
4.1.1      [branch]                          ← fork by point type
4.1.1.1      [case point.type == "fact"]     ← fact point: search → source labeling
4.1.1.2      [case point.type == "inference"]← inference point: premise tracing → fallacy review
```

- **for-each + collect** (form one in [[05-parallel-and-for-each]]): the engine does the counting, and not a single point can be missed; results are collected into the `check_result` list;
- **`parallel` is marked on 4.1** (the loop body, not the loop header) — one worker dispatched per point, iterating and running concurrently;
- **`retry=5` is also on 4.1** — the unit of failure is "this one point"; if one point's search fails, it retries by itself without dragging down the others;
- **branch/case fork**: fact points and inference points take completely different checking paths, forked by a deterministic `case` condition (`point.type == "fact"`) — this is the container-level use of the "deterministic condition" from [[D10-hop-python-compute]]: the fork rests on a field value, not on LLM judgment;
- inside each case are the two steps **act (search, safely retriable exploration) → reason (evaluate and label, the part that needs thinking)** — exactly the division of labor from [[03-explore-and-commit]]: a failed search costs nothing to redo, and judgment goes to the reasoning step.

One small line with a big payoff: the `check_item` conclusion text is required to **contain point.id itself** — because parallel collection is out of order, items are matched up by the ID carried in their content, not by position. Copy this trick when writing your own parallel specs.

## Dissection 4: the convergence phase — LLM summarizing + machine roll call (step 5)

The convergence report is another self-check loop (5.1 converge ↔ 5.4 check final + `report_gap` feedback), but two steps in the middle are worth a closer look:

```
5.1  [reason] Converge into the report
5.2  [act]    Mechanically verify presence and downgraded items      ← the highlight
5.3  [reason] Review whether the downgrades are justified
5.4  [check final] Accept
```

**5.2 is the most beautiful step in the whole spec**: an LLM summarizing a long list is most prone to "quietly dropping a couple of items", and this spec doesn't try to reason with that habit — it uses a pure `[act]` to **run a string search in the report text for every point.id**, collecting the absent ones into `missing_ids`. Zero reasoning, zero misses, zero cost (the core argument of [[D10-hop-python-compute]]: things like counting and roll call belong to programs). Then 5.3 uses `[reason]` only for the part machines can't do — reviewing whether the downgrade verdicts are reasonable.

The **act detects + reason reviews** pairing is worth remembering: the machine owns "is it complete", the LLM owns "is it correct".

## The full picture: three pitfalls vs. three structures

| The LLM's old habit | How this spec plugs it | Component source |
|---|---|---|
| Extraction/summarization misses items | Self-check loops with check final + gap feedback variables (×2 places); act mechanical roll call | 05 / 04 |
| Iterating long lists drops items | for-each + collect, engine does the counting | 05 |
| Making key decisions unilaterally | quick-view presentation before fan-out (informational) + self-check loop guards completeness | 01 / 03 |

Plus two engineering details: parallel conclusions carry their own id (immune to out-of-order collection); when nothing is found, label it `not_found` instead of fabricating (written into Constraints, backstopped by the output constraints of the reason steps).

## Take it and make it your own

Swap the heart out of this skeleton and it becomes a different machine: replace "check points" with "to-do items" (extract → confirm → execute in parallel → summarize) and it's a task decomposer; replace them with "code files" (list files → confirm scope → review in parallel → summary report) and it's a code reviewer — in fact, the repository's anchor-audit tool is built on exactly this skeleton. **Extract-confirm-fan-out-converge + two self-check loops** — a spec master template worth memorizing.

## Next steps

- Want to translate your own natural-language skill into this kind of structure: [[07-upgrading-your-skill]] (the translator does most of the work for you);
- The case itself (for reference at any time): `examples/hop-fact-check.md`; in the same directory, `doc-review.md` and `ppt-html.md` are two more hands-on specs of different shapes.
