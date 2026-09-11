%% @trace
	id: hopjit-tutorial-read-spec-en
	source: [[../../../tutorials/02-读懂一份spec]]
	source_id: hopjit-tutorial-read-spec
	type: translation
	last_sync: 2026-08-15T13:00+0800
	note: English translation of 02-读懂一份spec. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 2 · Reading a Spec: The Full Picture in Five Minutes

**Goal**: given any HopSpec file, know where to start reading, what each line is saying, and who does the work versus who does the gatekeeping. This is the foundation for all the tutorials that follow.
**Prerequisite**: complete Tutorial 1 ([[01-first-run-claude-code]] or [[01-first-run-codex]]) — you've run at least once and seen what a spec looks like.

Reading along with a real spec works best — use the one you saw in Tutorial 1:

```bash
cat examples/coffee-week.md
```

## First glance: the header is the contract, Steps is the path

A spec splits in two halves. The **header** answers "what kind of task is this":

```markdown
# Spec: 咖啡店的一周            ← Title
Goal: 汇总营业数据，产出周报     ← One-sentence goal (required)
Constraints:                    ← Constraints that must not be violated
- 统计数字必须来自确定性计算，不得估算
Inputs:                         ← Parameters supplied at run time
- daily_sales: yaml  # 7 天营业额
Outputs:                        ← What it promises to deliver
- weekly_report: markdown  # 周报
```

**Read the header before reading Steps** — Goal/Constraints/Outputs are this spec's promise to you (unchangeable, unavoidable; the engine will verify them), while Steps is merely the path that fulfills the promise. When evaluating whether someone else's spec is worth using, you should have the answer by the time you finish the header.

Under **`## Steps`** is the numbered step tree. Each step is a one-line summary:

```markdown
2. [act] 统计一周数字
```

`2.` is the step number (substeps are `2.1.`, `2.1.1.` — numbering is nesting), and `[act]` is the **step type** — the key to reading a spec is knowing these types.

## Build the big picture first: a spec is an upgraded SOP

If you've ever written an operations manual (SOP, standard operating procedure) for a new employee, you're already close to reading a spec — but first, one difference to make clear. Most everyday SOPs are **laid out sequentially**: steps are numbered straight down; when something repeats you write "go back to step 2", and when there are cases you write "if it's fresh produce, jump to step 7" — **using "jumps" to express loops and branches**. That's fine when the flow is short; but jumps cause a **complexity explosion** as the flow grows — jumps criss-cross each other, changing one place tugs on invisible places far away, and worst of all, **key control points slip out of control**: you can't point at a line and say "any path that reaches here must pass through that check", because there could always be some jump path that bypasses it.

Software engineering hit this same problem back in the 1960s, and the solution was **structured programming theory**: just three structures — **sequence, loop, branch** — suffice to describe all logic (this has been proven), at the cost of giving up jumps — and what you get in return is exactly **control points that cannot slip out of control**: a structured block has a single entry and a single exit, so a check placed on the mandatory path cannot be bypassed by any route. For today's agents this is precisely the solution to the most critical pain point — an LLM relying on its own diligence to "remember" to pass a checkpoint is unreliable; structurally unavoidable is what's reliable.

HOP applies this set of principles back to procedures written for humans, calling it **HopSop** (Hop standard operating procedure): **no jumps allowed**; loops and branches each form their own block, with indentation levels drawing the boundaries. The same picking procedure, written as HopSop:

```text
1. Receive the order; verify items and quantities
2. [loop] Pick items one by one
   2.1. Fetch from the bin location, scan to register
3. [branch] Package differently by order type
   3.1. [case(fresh produce)] Add ice packs, foam box
   3.2. [case(other)] Regular cardboard box
4. Weigh, print the shipping label, hand over for pickup
```

Compared with the flat version: "pick items one by one" is no longer "after picking one, go back to step 2" — it's a `[loop]` block whose loop body is its substep 2.1 — **where the repetition starts, what repeats, and where you go when it's done are all visible from the indentation, no jump-chasing required**. Branches likewise: two mutually exclusive `[case(…)]` entries side by side, each path clear at a glance. The whole procedure uses only three structures — sequence, loop, branch — plus hierarchical numbering. That is the entirety of HopSop's syntax.

> If you've written programs this will look familiar: `[loop]` is for, `[branch]`+`[case(…)]` is if/else — exactly the structured programming that retired goto back in the day.

HopSop can already explain process logic clearly to a human, but handing it to a machine for execution still lacks two things: **who performs each step** (a human? an LLM? a program?), and **where data comes from and goes to**. Add those two, and HopSop upgrades into HopSpec:

| | SOP / HopSop (for humans) | HopSpec (for machines) |
|---|---|---|
| Control flow | sequence/loop/branch + hierarchical numbering (**structured, no jumps**) | The same set (subtask/loop/branch+case) |
| Who does each step | Everything defaults to "you" — no need to write it | **Step types**: `[reason]` LLM thinks / `[act]` program computes as written / `[confirm]` human decides… |
| Data | Implied by context | **Explicit data flow**: `←` reads in, `+ →` produces |

So the whole trick to reading a spec is one sentence: **read the skeleton as an SOP (you already know how), then look at the two new things — "who does the work" in the square brackets, and "how data flows" on the arrows.** The rest of this tutorial covers those two things.

## The full landscape of step types: one division-of-labor table

All 14 types say one and the same thing — **who does this step**. Memorize them in four groups by who performs the work (the commonly used ones are just the nine in the first three groups):

| Group        | Type              | Who executes     | One-liner                             |
| -------- | --------------- | ------- | ------------------------------- |
| **Thinking**  | `reason`        | LLM     | Reasoning, analysis, generation — things that require judgment                |
| **Non-thinking** | `act`           | Engine/tools   | Deterministic computation and reversible operations, safe to retry                |
|          | `commit`        | Engine/tools   | **Irreversible** side effects (send/pay/write official files), always preceded by gatekeeping  |
| **Gatekeeping**  | `check`         | LLM or engine | Verifies an existing output: pass/fail + failure reason; failing triggers a retry       |
|          | `confirm`       | **Human**   | Approval gate: approve/reject; reject aborts globally |
|          | `ask`           | **Human**   | Requests data: ask a human for a value (confirm a parameter, pick an option)             |
| **Orchestration**  | `subtask`       | —       | Packages several steps into a unit retryable as a whole (`retry=N`)     |
|          | `loop for-each` | Engine      | Executes per item over a list; the engine does the counting                    |
|          | `branch`/`case` | Engine      | Takes different paths by deterministic condition                     |
|          | `call`          | Engine      | Invokes another spec (like a function call)               |

(The rest: `loop` general loop, `break`/`continue`/`exit` control flow — look them up in the syntax reference when you encounter them.)

**Quick judgments while reading a spec**: on seeing `[reason]`, think "what does the LLM need to judge here"; on `[act]`, think "this is deterministic; if it fails it retries"; on `[confirm]`/`[ask]`, think "execution will stop and come find me here"; on `[commit]`, look **backward** for its gatekeeping gate — if you can't find one, be suspicious.

## Data flow: two arrows to understand the variables

Indented lines under each step declare data in and out:

```markdown
2. [act] 统计一周数字
  - ← daily_sales                 ← read in: something produced earlier (or from Inputs)
  + → total: number  # 周营业额   ← output: variable name: type # description
  + → best_day: number  # 最好一天
```

There are just two rules: **the x in `← x` must have appeared earlier** (some step's `+ →` or the header Inputs); **the y produced by `+ → y` is usable by any later step**. Following the arrows lets you draw the whole spec's data pipeline — which step's output feeds which step, at a glance. Beyond the basic types `number`/`text`/`bool`/`yaml`, there are also lists `[T]` and structures custom-defined in the header `Types:`.

## Containers and intervention points: how to read the tree structure

**Containers** (subtask/loop/branch) do no work themselves; they govern their substeps:

```markdown
4. [subtask retry=2] 产出并核验周报      ← container: retried as a whole, at most 2 times
  4.1. [act] 组装周报                    ← does the work
  4.2. [check final] 周报核验            ← gatekeeping: fails → all of 4 reruns
```

This is the most common container pattern: **work + a closing check = a self-verifying retry unit**. When the check fails, what reruns is the entire container (4.1 runs again too), capped by `retry=2`. The `final` modifier means this verification **cannot be bypassed on any successful path** — it is the executable incarnation of the header's Constraints.

**Intervention points** (confirm/ask) are where execution genuinely stops. When reading a spec, circle them and you'll know where this task is "fully automatic" versus "will come find me" — this is explicitly designed by the spec author, not random runtime behavior. In Tutorial 1, when coffee-week stopped at "confirm the weekly target" to ask you, that was step 1's `[ask]` at work.

## Practice: read coffee-week in three minutes

Read through `examples/coffee-week.md` (30 lines) with the method above:

1. **Header**: Goal = produce a weekly report; Constraints = numbers must be deterministically computed (which is why the tallying is an act, not a reason — the constraint landed on the type choice); two Inputs, one Output;
2. **Skeleton**: `1[ask] confirm target → 2[act] tally → 3[reason] judge business status → 4[subtask retry=2]{ 4.1[act] assemble → 4.2[check final] verify }`;
3. **Division of labor at a glance**: the human appears once (confirming the target), the LLM thinks twice (judging, assembling), the engine computes once (tallying), and the machine gatekeeps once (verifying);
4. **Data pipeline**: `daily_sales → total/best_day/… → verdict/advice → weekly_report`.

Reading at this level is enough to move on to all the later tutorials.

> Along the way you've also understood one of HOP's design choices: **write the process clearly for humans in SOP form first; when a machine needs to take over, promote it to a spec** — just add "who does the work" and the data flow, with the control-flow skeleton unchanged, word for word. The HopSop syntax for human-facing writing is detailed in `docs/concepts/HopSop标准作业流程.md`.

## Next steps

Read the three writing tutorials in order to learn to write your own:

- [[03-explore-and-commit]] — the act/commit boundary and the mechanism for trying things with confidence (learn safety first);
- [[D10-hop-python-compute]] — how to write act's deterministic compute body;
- [[05-parallel-and-for-each]] — how to write "do Y for each X" without missing anything (then learn efficiency).

Full syntax at your fingertips: `docs/concepts/HopSpec V3语法参考.md` (this tutorial is its reading-oriented digest; when they conflict, the reference wins).
