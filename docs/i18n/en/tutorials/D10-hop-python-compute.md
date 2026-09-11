%% @trace
	id: hopjit-tutorial-hop-python-en
	source: [[../../../tutorials/D10-hop_python计算体]]
	source_id: hopjit-tutorial-hop-python
	type: translation
	last_sync: 2026-08-15T13:00+0800
	note: English translation of D10-hop_python计算体. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 4 · hop_python: Lock Down What Shouldn't Require Thinking

**Goal**: learn to write hop_python compute bodies (body) for `act`/`commit` steps, and understand how "who reasons, who computes" — a core HopSpec boundary — lands in practice when writing a spec.
**Prerequisite**: complete [[03-explore-and-commit]] (act's reversibility semantics are covered there).

## Why it exists

When running coffee-week in Tutorial 1 you saw this line: "`[act]` carries a `hop_python` body — **the engine computes it itself, without even touching the LLM**; sum/max/min give the same result even after ten thousand runs."

That is the entire reason hop_python exists: **summing, splitting, concatenating, routing by threshold — these things contain zero "judgment", and having an LLM do them purely introduces nondeterminism** (it might miscalculate, might "helpfully optimize", might format differently each time). Written as a body, these steps are executed deterministically by the engine — same input, same output, always — at zero token cost.

**First, let's be clear about your role: you will mostly never write these bodies by hand.** Whether via `/hopbuild` translation ([[07-upgrading-your-skill]]) or by having an agent draft the spec for you, bodies are agent-generated — it is simply "simple logic" presented as code instead of prose: where you used to write "add up the sales", it is now `total = sum(daily_sales)` — same meaning, but the engine can lock down execution of the latter. **What you need is to read it and verify it** (is this code the logic I want), occasionally hand-tuning a line or two. This tutorial teaches to that depth.

The shape of a good spec is therefore quite clear: **what requires thinking is written as `[reason]` (given to the LLM); what doesn't is written as `[act]` + body (given to the engine); what has irreversible side effects is written as `[commit]` + body (with a gatekeeping gate in front).**

## Step 1: run a pure-computation one

Claude Code command:

```
/hopspec run examples/syntax/act-body.md --params '{"expenses": [120, 88, 1500, 260], "auto_limit": 2000}'
```

Codex command:

```
$hopspec run examples/syntax/act-body.md --params '{"expenses": [120, 88, 1500, 260], "auto_limit": 2000}'
```

This is an expense-report reconciliation: total up, find the largest single item, and determine the approval level by company rules. Both act steps carry bodies, and the whole execution **makes not a single LLM call** — you'll see it finish almost instantly, and **the monetary arithmetic can never be wrong** (which is exactly the reason not to let an LLM do mental math on money). In standalone mode, this kind of spec likewise costs not a cent in inference fees.

## Step 2: understand what a body looks like

```markdown
1. [act] 合计与找最大单笔
  - ← expenses
  + → total: number
  + → biggest: number
  > ```hop_python
  > total = sum(expenses)
  > biggest = max(expenses)
  > item_count = len(expenses)
  > ```
```

It looks like Python, but it is **not Python** — it is HopSpec's restricted orchestration dialect (that's what the `hop_` prefix means). It is deliberately kept small, precisely because agents are its main authors: **the narrower the capability surface, the fewer places an agent-generated body can hide a mistake, and the easier your verification.** It can do only four kinds of things:

1. **Basic operations**: arithmetic `+ - * / % // **`, string concatenation and repetition (`"-" * 3`), comparisons, `and/or/not`, `in`/`not in`, field/subscript access (including negative subscripts `items[-1]`), literal construction `[1, x]`/`{"k": v}`, f-strings `f"共{n}条"`;
2. **Whitelist functions**: a set of pure functions with the same names and meanings as Python's — numeric `len` `sum` `min` `max` `round` `abs` | text `lower` `upper` `strip` `split` `join` `replace` `count` `startswith` `endswith` | sequence `sorted` `reversed` `range` | predicate `any` `all` | structure `keys` `values` `get` | type conversion `int` `float` `str` `bool`. Plus tools registered by the host (such as Read/Write, called by the names in the tool list);
3. **Assignment**: local variables at will; ultimately assign values to the output variables declared with `+ →`;
4. **Reasoning-free branches**: `if <deterministic condition>:` / `elif` / `else` — the condition must be a deterministic expression (comparing sizes, membership checks), not something requiring judgment like "if the content quality is good".

**Anything outside the four kinds is illegal** — no `for`/`while` (to iterate, promote to a `loop` step, see [[05-parallel-and-for-each]]), no `import`, no functions outside the whitelist. Indentation accepts spaces only.

**Semantics align with Python (zero mental switching)** — a few points worth knowing:

- **None detection**: both `x is None` and `x == None` work (`is` is restricted to None checks);
- **Equality is strict**: `"3" == 3` is false (cross-type values are unequal, no error) — no implicit conversion will "help" you into trouble;
- **Comparisons require same types**: numbers compare with numbers, strings compare lexicographically, lists compare element by element; comparing a number against a string for ordering = a computation error (that step fails), never a silently wrong result;
- **List `+` is concatenation**: `[1] + [2]` gives `[1, 2]`, same as Python.

This strictness isn't harshness — a body's entire value is determinism; better to fail than silently miscompute.

## Step 3: what happens when you get it wrong (three outcomes, none ambiguous)

| What you wrote | Outcome |
|---|---|
| Loop keywords, functions outside the whitelist | `hopjit validate` rejects on the spot — **blocked before execution** |
| Syntactically legal but uncomputable (e.g. subtracting from a string) | The step is treated as failed and follows the spec's retry/failure propagation — **never a silently wrong value** |
| Forcing something that requires reasoning into a body | You can't — a body has no capacity for "judgment"; this is **a signal you should be using `[reason]`** |

The last row deserves expanding: if an agent, while drafting, squeezes something that requires judgment into a deterministic condition (or you're tempted to when hand-tuning), don't settle — "this depends on the situation" is exactly the boundary between reasoning and computation. Split the judgment part into an upstream `[reason]` step (producing an explicit variable), and let the body only consume the judgment's result:

```markdown
2. [reason] Evaluate the repair strategy   # requires thinking
  - ← issues
  + → fix_strategy: yaml          # explicit output: the strategy object
3. [act] Apply the repairs                 # requires no thinking
  - ← raw_data, fix_strategy
  + → clean_data: [yaml]
  > ```hop_python
  > if fix_strategy.clip_enabled:      # consume the judgment result — this is a deterministic condition
  >     cleaned = clip_outliers(data: raw_data, threshold: fix_strategy.z_threshold)
  > else:
  >     cleaned = raw_data
  > clean_data = cleaned
  > ```
```

## Step 4: commit — the same grammar, one more gate

`[commit]` uses the same body grammar as `[act]`; the difference lies in semantics and rules — the previous tutorial [[03-explore-and-commit]] covered them thoroughly (irreversible, must have a gate in front, be idempotent where possible). Sample: `examples/syntax/confirm-commit.md`.

## When not to write a body

An `act` without a body is also legal — it executes by natural-language description (in reuse mode, the carrier completes it with tools). Rule of thumb: **whatever can be written clearly with the four kinds of capability should be a body** (buying determinism + zero inference cost); only what genuinely needs the carrier's tool surface for free play (like "open a browser and take a screenshot") stays in natural language.

## Next steps

- Continue the main line with [[05-parallel-and-for-each]] — handing "do Y for each X" to the engine;
- Full grammar and the complete whitelist: `docs/concepts/HopSpec V3语法参考.md` §5 (hop_python body), §4 (case condition expressions — a read-only subset of the same grammar);
- How variables flow between steps and how to write accumulators: same document, §6 (variable semantics);
- More samples: `examples/syntax/` (act-body / confirm-commit / loop-branch).
