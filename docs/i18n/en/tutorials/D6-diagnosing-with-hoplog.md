%% @trace
	id: hopjit-tutorial-dev-hoplog-en
	source: [[../../../tutorials/D6-用HopLog诊断]]
	source_id: hopjit-tutorial-dev-hoplog
	type: translation
	last_sync: 2026-08-15T13:48+0800
	note: English translation of D6-用HopLog诊断. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D5 · Diagnosing with HopLog: The Complete History of an Execution

**Who this is for**: developers who need to figure out "what actually happened" in a run — it crashed, the result is wrong, it's stuck, or you suspect the AI driver didn't follow the protocol.
**One-sentence positioning**: **HopLog is the complete history of an execution, not perfunctory logging** — what prompt each step was delivered, what output came back, who made the decision at each intervention point, who was dispatched in parallel: all of it append-only, flushed to disk in real time. Debugging deep bugs **does not depend on reproduction — reading the log is enough to pin them down**.
**Authority**: concept `docs/concepts/HopSpec V3扩展-可观测性与YAMLL日志格式.md`; design `docs/design/spec-observability.md`.

## Where the files are: the directory is the navigation

```
.hoplog/
  expense-check-20260811T114605-a510/     ← one directory per run: {spec_id}-{run_id}
    main.yaml                             ← main log (the parent execution tree, start to finish)
    parallel/                             ← parallel worker child logs (only present when there is parallelism)
      2.1/…-{run_id}/main.yaml            ← each child gets its own independent, complete log
```

Remember the division of labor between the three IDs and you'll never get lost:

| ID | Shape | Purpose |
|---|---|---|
| `run_id` | `20260811T114605-a510` (timestamp + 4 hex) | Identifies a **single run** — it's the one in the directory name |
| `trace_id` | UUID | Identifies the **whole execution tree** — call/parallel child instances inherit the parent's; grep one trace_id to gather every parent and child log |
| `instance_id` | UUID (for a top-level run = trace_id) | Locates the `.hopstate/<instance_id>/` state directory |

Parallel child logs are linked by **directory nesting itself** — no grep needed: step into `parallel/<child_step_id>/` and you're in that child's complete world.

## How to read the blocks: YAMLL in three minutes

HopLog's format is called **YAMLL** (YAML Lines): the log is a sequence of **independent YAML blocks** appended in order — each block is valid YAML (readable, foldable, multi-line originals unescaped), while the blocks together do not form a single document (no append can ever corrupt content already on disk). This choice was forced by the real conflict between "streaming append vs whole-file validity" — it is not aesthetics.

A `main.yaml` reads top to bottom in three sections:

```yaml
spec_id: expense-check          # ① Header: who, which run, what level, what the inputs were
run_id: 20260811T114605-a510
trace_id: 5aa3fd08-…
level: debug
inputs: { expenses: [120, 88, 1500, 260], auto_limit: 2000 }

execution:                      # ② Execution section: one block per step; indentation = position in the execution tree
  "1":
    type: act
    summary: 合计与找最大单笔
    at: "2026-08-11 11:46:05"
    inputs: { expenses: […] }
    llm:
      prompt: |                 # debug level: the full prompt as delivered (6-layer context)
        …
    response: { total: 1968, … }
    outputs: { total: 1968, … }
    status: completed

status: completed               # ③ Final state: how the whole run ended
ended_at: "…"
```

**Reading keys**: block-header indentation = position in the execution tree (`"2.1"` is indented under `"2"`); loop iterations carry a round key (`"3.1#2"` = round 2); for each step, `inputs` (what it received) → `llm.prompt` (what context the engine delivered) → `response`/`outputs` (what it handed back) → `status` — a causal chain that closes completely.

## How to look up six common diagnostic questions

**① Which step did it fail on, and why?** Search `status: failed` to locate the failing block, then read its `reason` and `fail_kind` (the FailRecord from D4 enters the trace here). A retried step has multiple round blocks (`#2`, `#3`) — the per-round reasons are the failure history.

**② The result is wrong — who computed it wrong?** Trace backwards along the data flow: find the step whose `outputs` first contain the result variable → check whether that step's `inputs` were already wrong → if so, keep moving upstream. **Every step's ins and outs are on record** — the point where the bad value entered can always be forced out.

**③ What did the LLM actually see?** (When you suspect prompt assembly went wrong.) At debug level, `llm.prompt` is the full 6-layer context as delivered, verbatim — no need to guess "maybe it didn't see the constraint": open it and look. This is the only reliable channel for investigating "why did the AI answer this way".

**④ It's stuck — how far did it get?** Look at the last block under `execution:`: has `at` but no `status` = that step was handed off and hasn't come back (reuse mode = still waiting for the caller to submit); the block is `type: confirm/ask` = stopped at an intervention point waiting for a human. Combine with `/hopspec status` for the engine-side view.

**⑤ Who answered at the intervention point, and what did they answer?** (When you suspect the AI answered in the human's place.) The `hitl:` field of a confirm/ask block records what was presented, the options, the answer, and the decision-maker — **no `hitl:` block = nobody ever answered**. The e2e cc:paused scenario asserts exactly this: "no hitl block".

**⑥ Which parallel child had the problem?** The parent main.yaml's dispatch/harvest blocks record who was dispatched and how each fared; step into `parallel/<child_step_id>/` for that child's independent, complete log. Call child instances work the same way (parent instance's `calls/` directory + trace_id inheritance).

## Division of labor with state.json: one answers "how it happened", the other "how things stand now"

| | HopLog | `.hopstate/<inst>/state.json` |
|---|---|---|
| Nature | **Immutable stream of facts** (append-only) | **Mutable state snapshot** (updated as execution proceeds) |
| Answers | How things got here step by step (the causal chain) | What state each step is in now, the failure ledger, retry counts |
| Typical uses | Debugging, audit, postmortem | resume, repair decisions, a quick look at progress |

The usual diagnostic rhythm: state.json for a one-glance view of **the present** (which step failed, which round) → HopLog to dig into **the process** (what each round failed on, whether anything fishy is in the prompt).

## Levels and audit: verbosity is tunable, the audit is not

Three levels, each containing the next: `debug` (full prompt originals) ⊇ `info` (values and trace, the default) ⊇ `warn` (skeleton). To run: `--log-level debug` (the driver protocol's default already carries it).

**No level exempts the audit**: irreversible operations (commit), human decisions (hitl), cross-spec calls, and replanning (`replan_audit`) are **always recorded regardless of level** — the security audit cannot be circumvented by turning the log level down. Which means: even at warn level, the audit chain is complete, and a grep extracts it.

## Three handy commands

```bash
ls -t .hoplog/ | head -3                          # three most recent runs
grep -n "status: failed" .hoplog/<run>/main.yaml   # locate the failing block
grep -rn "<trace_id>" .hoplog/                     # string together every log of one execution tree
```

## Next steps

- [[D7-building-your-own-tools]] — every tool call's ins and outs are in the log; when writing tools it is your debugging console;
- Format invariants and cross-carrier consistency (why any implementation must do it this way): concept document `^anc-obs-format-invariants`;
- Authority for all block types and fields (step keys / audit fields / parallel dispatch blocks / resume markers): `docs/design/spec-observability.md`;
- Failure semantics themselves (where reason/fail_kind come from): [[D5-errors-and-failure-handling]].
