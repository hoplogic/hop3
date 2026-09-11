%% @trace
	id: hopjit-tutorial-parallel-en
	source: [[../../../tutorials/05-并行与遍历]]
	source_id: hopjit-tutorial-parallel
	type: translation
	last_sync: 2026-08-15T12:55+0800
	note: English translation of 05-并行与遍历. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 5 · Parallel and For-Each: Let the Engine Do the Counting for You

**Goal**: learn to write "do Y for each X" and "run these things at the same time" in a spec, and understand why this is more reliable than making the LLM keep track by itself.
**Prerequisite**: complete [[02-reading-a-spec]] (step types and the `← / + →` data flow).

## Why this deserves its own tutorial

"Run a check on each file" — the most common instruction in natural-language skills, and the one that crashes most often: by item 7 the LLM forgets there are 3 more (guaranteed to happen once the context gets long). HopSpec's answer is to **hand iteration to the engine**: the engine drives a cursor by the length of the list, collecting results one by one, and only lets execution proceed once everything is in. The LLM is only responsible for "doing one" — **it never touches the counting at all**.

Parallelism is the accelerated form of the same mechanism: work items annotated `parallel` are dispatched to run simultaneously; the main line doesn't wait for them, and they are all collected before the container ends.

## Step 1: run a ready-made one first

Claude Code command:

```
/hopspec run examples/syntax/parallel-aggregate.md
```

Codex command:

```
$hopspec run examples/syntax/parallel-aggregate.md
```

This spec marks "analysis along three dimensions (statistics / trends / anomalies)" as a single `parallel` work item: when the main line reaches it, it dispatches the item and keeps going; the aggregation step that needs its output **waits for it to complete** before proceeding. That is the execution semantics of parallel: "dispatch it, proceed only once everything is collected."

> An honest note: `parallel` declares that something **may** run in parallel (the work item is self-contained, with no shared writes) — **the actual degree of concurrency is governed by the execution mode**. Standalone mode runs truly concurrently; the conversation-driven reuse mode in the current version executes these items sequentially (results are identical, it just doesn't save time; concurrency restoration is on the roadmap). The spec is written identically, down to the last character, on both sides — which is exactly the benefit of separating declaration from execution: you only declare the property; the scheduling strategy is up to the engine.

## Step 2: understand the two forms

### Form one: iteration (for-each + collect)

"Do Y for each X, collect the results into a list":

```markdown
2. [loop for-each file in file_list, collect issue into issues] Review file by file
  + → issues: [yaml]        # collected list (declared in the container header)
  2.1. [subtask parallel] Review a single file    # parallel = one dispatched per round, iterating and running concurrently
    + → issue: yaml         # per-item end: one produced per round
    2.1.1. [reason] Review
      - ← file              # file = this round's element, bound automatically by the for-each clause
      + → issue
```

Three key points:
- **`collect issue into issues`**: the per-round item `issue` is collected by the engine into the list `issues` — the item and the list are two separate variables; you only write "produce one item", the collecting is the engine's job;
- **`file` needs no declaration**: the for-each clause itself is its definition point; inside the loop body just write `← file`;
- **To run concurrently, mark `parallel` on the loop body (the child)**; without it, items are processed one at a time (also perfectly legal — slower, but conserves concurrency budget).

### Form two: sibling concurrency (several independent things at the same time)

```markdown
2. [subtask] Collect data from each channel       # container boundary = collection point
  + → social_data: yaml
  + → news_data: yaml
  2.1. [subtask parallel] Collect social media     # dispatched
    + → social_data
    ...
  2.2. [subtask parallel] Collect news             # running at the same time as 2.1
    + → news_data
    ...
```

The two channels don't depend on each other; each is marked `parallel`, and both are collected before the parent container ends. Runnable sample: `examples/syntax/sibling-parallel.md`.

## Step 3: know where the boundaries are (so you don't write an illegal spec)

`parallel` is a **promise**: this work item is self-contained and shares no writes with its siblings. The engine's validate checks it for you (dependency analysis) — violations fail immediately. Three common ones:

| What you want | The wrong way | The right way |
| --------- | -------------------- | --------------------------------------------------- |
| Concurrent loop | Mark `parallel` on the **loop header** | Mark it on the loop-body child (concurrency is a property of the work item, not the shape of the loop) |
| Feed parallel results to the next step | A sibling step directly `←` the parallel step's output | A parallel step's output can only be exported across the **container boundary** (container-header `+ →` or the collect list), and consumed outside the container |
| Retry a single failure | Add `retry` to the loop | loop has no retry — nest `[subtask retry=N]` inside the loop body; the unit of failure is a single iteration |

Two more practical semantics:
- **The degree of concurrency does not go in the spec** — the spec only declares "may run in parallel"; how wide to run (and whether to run truly concurrently at all) is up to the runtime environment (see the honest note above);
- **Partial failure doesn't blow up the whole batch**: if one worker fails, its item is not added to the collect list, and the rest are collected as usual (the list may end up shorter than the input — if a downstream step wants to verify the count, just `check` the `len`).

## Step 4: look at a real one

```bash
hopjit validate examples/fact-check-demo.md
```

Read step 4 of `examples/fact-check-demo.md` (ships with the npm package; the `/demo-fact-check` installed by `--demo` is exactly this file): `[loop for-each point in confirmed_points, collect check_item into check_result]`, with a loop body of `[subtask retry=3 parallel]` — verify each claim in parallel, with up to 3 retries per claim, results collected into a list. **Exhaustive iteration + per-item retry + overall concurrency** — three things spelled out in one line of structure (the focus① annotation from the translator in [[07-upgrading-your-skill]] refers to exactly this structure).

## Next steps

- Follow the main line to [[06-hands-on-fact-checker]] — the full assembly of the three component tutorials on one real spec;
- The complete syntax for parallel (call dispatch, pipeline form, break semantics): `docs/concepts/HopSpec V3语法参考.md` §parallel and for-each;
- How the engine schedules (the unified dispatch model, the join gate, kill semantics): `docs/design/parallel-execution.md` §U (developer-oriented).
