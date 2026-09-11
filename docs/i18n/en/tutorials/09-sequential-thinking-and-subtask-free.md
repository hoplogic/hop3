%% @trace
	id: hopjit-tutorial-seq-think-en
	source: [[../../../tutorials/09-有序思考与subtaskfree]]
	source_id: hopjit-tutorial-seq-think
	type: translation
	last_sync: 2026-08-30T15:28+0800
	note: English mirror of user-series 09 (sequential thinking & subtask free — 2026-08-30 rewrite; replan content compressed into one section, on-arrival expansion promoted to the lead role). Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# 09 · Sequential Thinking & subtask free: hand the engine work you haven't fully figured out

**Who this is for**: spec authors whose task is clear for the first half and "we'll see when we get there" for the second — and who don't want to give up engine management because of that.
**Prerequisites**: tutorials 02 (reading a spec) and 03 (explore and commit).

## One-line positioning

The most common blocker in writing a spec isn't syntax — it's that **you haven't figured it out yet**. In exploratory tasks the second half of the plan depends on what the first half produces, so it can't be pinned down before you start. HopSpec's answer is `[subtask free]` (on-arrival expansion): **declare only the contract when writing the card; when execution reaches that step, the engine stops and asks for a plan** — at that moment the real outputs from the earlier steps are in hand, so the plan is made from actual material instead of an up-front guess.

## Why some work can't be written as complete steps

Consider a realistic task: "check this batch of data, and handle the anomalies as appropriate."

The first half writes itself: read the data, run the checks, list the anomalies — crisp steps. The second half can't be written: you haven't seen what the anomalies look like yet, and how to handle them (fix the data? report upstream? file a ticket?) depends on what the checks find. Forcing a complete plan up front leaves two options, both bad:

- **Hard-code one treatment** — the moment reality produces a different shape, you're editing the spec and rerunning;
- **Enumerate every branch** — the case tree grows deeper and deeper, most branches never execute, all wasted writing.

This isn't a skill problem. **The information doesn't exist yet.** A plan that depends on information only produced at runtime should be deferred to runtime — that is the heart of "sequential thinking": do the figuring-out at the moment the evidence is in.

## How to write it: one line of contract, zero substeps

```markdown
1. [act] Run the checks
  - ← data
  + → anomalies: yaml  # each: location + symptom

2. [subtask free] Handle anomalies per analysis (on-arrival expansion — treatment depends on step 1's findings)
  - ← anomalies
  + → report: markdown  # per item: what was done + rationale
```

Under `[subtask free]` you write **no substeps at all**. What you write is the step's **contract**: what it consumes (`- ←`), what it delivers (`+ →`), and what it is for (the description).

This passes `validate` — empty children is the legal form of subtask free, not an unfinished spec.

## What happens when execution arrives

When the engine reaches a subtask free step it neither barrels ahead nor errors out. It stops and issues a **plan request** (`adaptive_needed` with `reason: "initial_plan"`). Three things worth knowing:

1. **This is not a failure.** `initial_plan` means "time to produce the first plan" — don't do failure attribution; nothing broke;
2. **The request carries real material.** `expansion_context` holds the **actual runtime values** of the `- ←` inputs — the anomaly list step 1 really produced is right there. Planning from real outputs is on-arrival expansion's essential advantage over up-front guessing. Inputs whose value is null are listed in `missing_inputs` — the plan must either arrange to fetch them or handle their absence;
3. **The plan comes from the executor (the agent), not the engine.** The engine only stops, supplies material, and validates. You (the human) normally don't need to step in, but progress is visible before and after the plan lands — call a halt any time it drifts.

The submitted plan is ordinary substep markdown. Once the engine accepts it, execution continues — and everything downstream works exactly like a hand-written subtask: retries, check rejections, the progress ledger, all of it.

## Two expansion disciplines (engine-enforced, not advice)

Runtime-generated plans have an inborn weakness: **nobody pre-reviewed them**. A plan written on the card was at least seen by you once; an on-arrival plan may go from generation to execution with no human eyes at all. So the engine welds in two rules:

- **The expansion must contain a check** — a runtime plan's only gate is the verification step it carries. Plans without one are rejected outright;
- **The expansion must not contain a commit** — irreversible actions (send / delete / publish) must be declared at card-writing time, where people can see them. Need a commit? Put it **outside** the subtask free, consuming its deliverable:

```markdown
2. [subtask free] Draft the treatment plan (on-arrival expansion)
  + → plan: markdown

3. [confirm] Review the plan
  - ← plan

4. [commit] Execute the treatment per plan
  - ← plan
```

Exploration stays exploration (reversible, engine-managed); the real thing stays the real thing (visible at card time, human-gated) — this is tutorial 03's act/commit boundary extended to the planning layer.

## Expansion has a budget, and exhausting it means asking a human

On-arrival expansion can nest (an expanded plan may itself contain a subtask free), but the count is capped — a guard against "expanding forever". On overflow the engine rejects the plan and returns a continuation protocol: **present the situation to the user and ask "continue or stop"; only with their approval can the budget be extended**. The budget was granted by a human, so extending it takes a human too — the same philosophy that prices replan circuit-breaking.

## How this relates to "replanning"

There are exactly two occasions when the engine asks for a plan. Don't mix them up:

| | On-arrival expansion (subtask free) | Replanning (adaptive replan) |
|---|---|---|
| Trigger | Reaching a container with no substeps written | The plan **failed**, and retry-with-feedback didn't save it |
| Nature | A plan form — "always meant to decide later" | Failure repair — "reality vetoed the original plan" |
| Marker | `reason: "initial_plan"` | Carries the failure record |
| Authorization | Writing `free` | Writing `adaptive` |

Replanning's full story (the three trigger conditions, four validation gates, candidate-file persistence, writing know-how) is the heaviest rung of the repair ladder: the failure record carries the world's new shape (say, upstream upgraded `amount` from a plain number to a nested object), and the engine has the LLM read it out and realign the plan — while the delivery contract and `[check final]` never move. To watch it happen live: `examples/e2e-failure/e2e-adaptive.md` — two rounds of failure, then a plan swap before your eyes. The full failure-handling picture is in [[D5-errors-and-failure-handling]].

Both share one bottom line: **the delivery contract cannot change, and check final cannot be removed** — whether the plan is a first expansion or a post-failure replacement, "what counts as done and correct" is welded to the card.

## Where /hop fits

If you use /hop to upgrade daily tasks into specs (Chinese tutorial 04-日常活交给hop; English translation pending), on-arrival expansion is its stock form — the "parts you haven't figured out yet" in the upgrade template are written precisely as `[subtask free]`. Daily work is exactly the "first half clear, second half depends" terrain this combination was born for.

## Getting started

Take a real exploratory task of yours: write 2-3 concrete steps for the first half, and collapse the entire second half into one `[subtask free]`. When execution hits the expansion point, look at two things — the real material in `expansion_context`, and the plan the agent produces from it. Compare that against what you would have written blind before starting, and the feel arrives immediately: **plans made with evidence in hand beat plans guessed in advance**.

---

**Authoritative details**: `[subtask free]` syntax and the expansion protocol are in the syntax reference's subtask section (`docs/concepts/HopSpec V3语法参考.md`); the full conceptual frame of sequential thinking (pluggable thinking strategies / stop rules / progressive solidification) is in `docs/concepts/HopSpec V3扩展-有序思考与渐进固化.md`.
