%% @trace
	id: hopjit-tutorial-dev-error-model-en
	source: [[../../../tutorials/D5-错误与异常处理]]
	source_id: hopjit-tutorial-dev-error-model
	type: translation
	last_sync: 2026-08-15T13:43+0800
	note: English translation of D5-错误与异常处理. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D4 · Errors and Failure Handling: Failure Hangs on the Structure

**Who this is for**: developers who will hit failures while writing specs, or need to debug a failed execution. User tutorial 03 covered "exploration is retryable, commits are gatekept" — this piece covers the full picture: **by what rules** the engine handles a failure once it happens, **how you declare** in the spec who owns a failure, and **where to look** for failure information when debugging.
**Authority**: `docs/concepts/HopSpec V3错误模型.md` (this piece is its teaching narrative; for details, it prevails).

## Design Philosophy: Handle Failure Like an Organization, Not Like a Program Writing try/catch

Neither traditional path is good: explicit error handling (writing "what if it breaks" after every step) buries three lines of real work under seven lines of defensiveness; exception syntax (try/catch blocks) is a purely programmer concept. HopSpec takes **the semantics of exceptions and drops the syntax of exceptions** — failure handling is not written into the flow; instead it **hangs on the structure**:

```markdown
2. [subtask retry=3] Produce and verify the weekly report     ← reads as: this bundle of work, this group owns it, three chances
```

- Transaction boundary (subtask/case) = scope of responsibility; `retry=N` = authorization quota;
- Budget exhausted = report upward — follow the structure up to the next transaction boundary;
- The human at the top of the call chain is the ultimate decision-maker.

A spec reads like a **responsibility table**, not a program. Second principle: **repair over retry, retry over giving up** — the executor is an LLM that can understand why something failed; at each level what it gets is not a binary "retry or give up", but a four-rung repair ladder (see below).

## First, Two Lines: Errors Go Through the State Machine, the Value Space Holds Only Values

This is the bedrock for understanding all failure behavior, in two sentences:

1. **The error line**: the language layer has no try/catch, no exception values, no Result types — **the atomic unit of error is the step**. The sole carrier of failure is the step state machine's `fail(reason)`, with four entry classes: the executor reports it cannot be done / a check judges false / a computation exception (body or case condition miscomputes) / an engine guard (timeout, repeatedly non-conforming schema, budget exhausted). Host exceptions never pierce out of the language surface; the exit is uniformly folded into a step fail;
2. **The value line**: `None` is an ordinary legal value (as in Python) and **carries no error semantics** — there is no gate where "consuming None auto-fails". Downstream receiving None is a business situation (conditional probing takes the fallback path, check blocks a substandard product), not error propagation.

**fail is function-level**: a fail has only two destinations — caught and repaired by some transaction boundary, or it pierces all boundaries and **terminates the whole instance**. There is no third state of "failed but keeps running downstream", so the question "how does a failure affect downstream" does not exist semantically. The only explicit exception is parallel's partial failure (see below).

## FailRecord: Failure's "exception object"

A failure is not a boolean flag; it carries information. The carrier is the **failure record**, four fields:

| Field | What it is | Who uses it |
|---|---|---|
| Failed step | Who failed | The escalation chain's locating starting point; humans locating the problem |
| reason | The real cause (human-readable; the LLM uses it to understand the failure) | The repair ladder's core input |
| fail_kind | `error` (botched it) / `lack_of_info` (missing knowledge) | The first fork routing the repair path |
| Round | Which failure this is within the same boundary | Rerun-with-feedback knows "which attempt this is, and what went wrong each time" |

Three properties: **accumulated round by round, never overwritten** (failure history stays complete), **retained with the instance state** (auditable at any time), **wrapped across call boundaries with the kernel untouched** (a child instance's failure record is passed verbatim as the kernel, plus a callee-identity shell — a mechanical criterion that forbids the driver side from free-text paraphrasing).

**Where to look when debugging**: the execution-state failure records are in `.hopstate/<instance>/state.json` (`step_fail_reasons`); the human-readable trace is in `.hoplog/<run>/main.yaml` (each round's failure reason/fail_kind enters the trace in real time). Both sides keep their own record: the former participates in repair decisions, the latter is read-only postmortem material.

## After a fail: Escalation Chain + Four-Rung Repair Ladder

After a step fails, the engine follows a fixed procedure:

```
step fails
  → find the nearest transaction boundary (walk up ancestors to the closest subtask/case;
    a subtask is always a built-in boundary, retry defaults to 3)
      ├ none found → uncaught failure, instance terminates
      └ found → check the budget (retry=N is that container's total failure budget;
        any child's fail draws from the same budget)
          ├ exhausted → the container itself fails, and as "one step" recursively looks
          │        outward for a boundary (= level-by-level escalation; when an outer layer
          │        takes over and reruns, the inner budget resets — the outer layer gives
          │        the subtree a fresh round of chances)
          └ not exhausted → repair by descending order of confidence:
              Rung 1  Rerun with feedback    failure cause injected into the rerun context,
                      structure unchanged (most trustworthy; without adaptive, use it repeatedly)
              Rung 2  Select a pre-declared alternative path (adaptive, when one matches)
                      — a selection, not a generation
              Rung 3  Replan based on an alternative path — modify with scaffolding
              Rung 4  Replan from scratch — the low-confidence fallback; the product is
                      sedimented via HopLog (next time the same error hits Rung 2)
```

Whichever rung, **the delivery contract (`+ →`) and `[check final]` are untouchable** — change the strategy, not the goal.

**A rerun is a brand-new round**: the container's subtree walks again from the top, and tool calls happen anew (old results are not reused — the old result may be exactly the cause of failure); but **variables are naturally retained** — the previous round's residue is repair material (the foundation of the `last_err` feedback pattern); for a variable that needs a clean start each round, declare an initial value with `= Null` to reset it. The self-check loop in the hop-fact-check example dissected in user tutorial 06 (check final writes the gap → retry patches it in a targeted way) is the textbook use of this mechanism.

## Uncaught Failure: Instance Termination

When no boundary can be found to take over, **the instance terminates immediately, is judged failed, and reports to the caller** — exactly isomorphic to an uncaught exception terminating a function. Two paths lead here: there was no boundary to begin with (a flat spec, steps not grouped into a subtask); or exhaustion all the way to the top. On termination the value space is not cleaned up; the caller receives "failed + failure records + partial outputs".

**The key inversion**: failure interrupting execution is the **default**, requiring nothing from the author; it is **tolerating** failure that requires touching the structure — wrap in a transaction boundary (grant repair chances), use parallel (a collection's partial-failure semantics), or use branch to demote "a probe that may fail" into a business branch. When writing a spec, the question to ask yourself is not "where do I add error handling" but "which bundle of work am I willing to give retry chances, and how many".

## parallel's Partial Failure: The Only Explicit Exception

Inside a parallel container, one child's fail **does not interrupt** running siblings; the failed child contributes no collected element (**the list gets shorter**), and the failure record is booked as usual; whether the partial result is acceptable is at the discretion of the consuming step after join (want to verify the count? just check `len`). This is the collection semantics the author explicitly opts into by choosing the parallel structure — collection operations are naturally best-effort — not an engine default of failure tolerance.

## The call Boundary: Failure Propagation Across Functions

`call` is a function call; its failure-propagation semantics are symmetric to success backfill:

- Child instance failed → the call step fails, and the child instance's failure record is **passed with a shell added** (kernel untouched + callee-identity shell) — equivalent to an exception crossing functions with its full stack trace, rather than a catch leaving only a one-line manual summary;
- `fail_kind` is inherited across the boundary: if the child failed due to `lack_of_info`, the parent layer supplements knowledge before retrying, instead of burning budget on it as an ordinary error;
- Rerunning a call = re-invoking the entire child spec;
- **confirm is not part of this**: an authorization pause does not bubble up level by level; it goes straight to the empowered decision-maker — "empowered" is a global property, not a stack property.

The full supervision chain: **subtask repairs locally → exhaustion reports to the caller → each caller layer repairs with broader context → the human at the top makes the ultimate decision**. This is catch-reason-repair-or-escalate, not catch-and-rethrow.

## Hands-On Verification: Three Ready-Made Failure Scenarios

The failure path has a whole batch of live e2e (six scenarios, already merged into the release gate `npm run test:live:core`), three of which map exactly onto this piece's three mechanisms; the specs are all in `examples/e2e-failure/`:

| Scenario | Mechanism verified | Section here |
|---|---|---|
| `cc:repair` | check fails → last_err feedback → the rerun round fixes it → completed | Repair ladder rung 1 + natural variable retention |
| `cc:uncaught` | computation exception + no boundary → instance terminates, later steps skipped, earlier outputs remain | Uncaught failure |
| `cc:call-fail` | child spec fails → CalleeFailure kernel crosses the boundary untouched → parent failed | call-boundary shelled passing |

Read these three specs + run them once and look at the hoplog, and every concept in this piece has a physical counterpart.

## Next Steps

- [[D6-diagnosing-with-hoplog]] — how to read failure records in the logs, and how to look up six common diagnostic questions;
- The authoritative error-model full text (including the outlook on transaction and compensation extensions): `docs/concepts/HopSpec V3错误模型.md`;
- Assertion details of the failure-scenario e2e: `docs/design/carrier-live-e2e.md`, the failure-path scenario group.
