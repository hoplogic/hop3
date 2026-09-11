%% @trace
	id: hopjit-tutorial-first-run-en
	source: [[../../../tutorials/01-第一次运行-ClaudeCode]]
	source_id: hopjit-tutorial-first-run
	type: translation
	last_sync: 2026-08-30T13:41+0800
	note: English translation of 01-第一次运行-ClaudeCode.md. Consistency direction: translation follows the Chinese source; if you find errors in the source, report them, do not fix silently.
%%

# Tutorial 1 (Claude Code edition) · Your first run

> Using Codex? Read the parallel edition [[01-first-run-codex]]. Tutorials 02-07 that follow are shared by both carriers — wherever carrier-specific commands appear, a "Claude Code command" and a "Codex command" code box are given side by side; copy the one that's yours.

**Goal**: within 30 minutes, go from zero installation to watching a spec get driven to completion by the engine inside Claude Code.
**Prerequisites**: Node.js ≥ 18 and Claude Code installed; **no API key required** (in reuse mode, Claude Code itself is the reasoning engine).

## Step 1: install the engine

```bash
npm install -g @hoplogic/hopjit
hopjit --version
```

Seeing a version number means success. Remember the three-level naming: the **package** is called `@hoplogic/hopjit` (for installing), the **command** is called `hopjit` (for running), and it executes the package's `dist/cli.js`.

## Step 2: install the skill

```bash
hopjit install-skill --demo
```

It outputs `status: ok` (YAML format — the CLI's default output is human-oriented YAML; machines/scripts use `--json`). **Restart Claude Code** (or open a new session); typing `/` should show three skill completions:

- `/demo-coffee-week` — the demo skill installed by `--demo` (we'll use it in the next step; drop `--demo` if you don't want the demo. Demo artifacts uniformly carry the `demo-` prefix — easy to recognize and easy to delete as a batch)
- `/hopspec` — drives the engine to execute any spec (the generic driver, the protagonist of the second half of this tutorial)
- `/hopbuild` — translates natural-language skills into HopSpec (see [[07-upgrading-your-skill]])

> Advanced: `--plus` additionally installs two research skills that do real work — `/hop-fact-check` (fact checking) and `/hop-deep-research` (deep research) — and automatically merges the search/browser tool config they need into `~/.hopjit/config.yaml`. After installing, the only remaining step is `export DASHSCOPE_API_KEY=<your Bailian key>`. Skip it on your first run; come back once the demo works and you want real tasks.

## Step 3: shortest first run — say `/demo-coffee-week` in the conversation

Nothing to prepare (the demo data is bundled in the skill); just type:

```
/demo-coffee-week
```

It will confirm two parameters with you (both the demo data and the weekly target have ready defaults — just confirm your way through), then hand off to the engine to execute, and finally give you a coffee-shop weekly report. **This is the product form of a hopskill**: what the user gets is a named capability — the spec, the engine, and the driver protocol are all implementation details. You didn't see them just now, and that's intentional.

Now we switch to the technical view: how this capability is defined by a spec and driven by the engine.

## Step 4: grab a ready-made spec (technical view)

Clone this repo (examples are not published with the npm package):

```bash
git clone <this repo's URL> hoplogic && cd hoplogic
```

First use the CLI to see which specs are executable:

```bash
hopjit list examples
```

This tutorial uses `examples/coffee-week.md` (a copy ships at the same path inside the npm package — it runs from any directory even without cloning the repo; the demo data `examples/coffee-sales.json` ships in the same package) — a coffee shop's weekly report: tally a week's business numbers → judge the business condition → assemble the report → verify. Spend two minutes reading it first, and note three things:

1. **`## Inputs`**: `daily_sales` (7 days of revenue) and `weekly_target` (the weekly target) — the parameters to supply at run time (the demo data is ready; the comments say so);
2. **Step types**: `[act]` is deterministic computation with no reasoning (with a `hop_python` body — **the engine computes it itself, without even touching the LLM**; sum/max/min give the same numbers on ten thousand runs), `[reason]` is a reasoning step handed to the LLM (judging business condition, giving advice — that's where thinking belongs) — **who reasons and who computes is written plainly in the spec**. This is the core of HopSpec: lock down what should be locked down, and leave to intelligence what should be intelligent;
3. **Data flow**: `← x` reads in, `+ → y: type` produces — how variables flow between steps is clear at a glance.

Before executing, pass the validation gate (recommended for any spec):

```bash
hopjit validate examples/coffee-week.md
# → status: ok (YAML; on error, the errors list itemizes each one)
```

## Step 5: run it with the generic driver (`/hopspec run`)

The `/demo-coffee-week` of step 3 internally delegates to this very generic driver — any spec can be run this way, no need to pack it into a named skill first. Open Claude Code in the repo directory and type:

```
/hopspec run examples/coffee-week.md
```

Here is what happens next (follow along, don't panic):

1. **Parameter confirmation** — the skill reads `## Inputs`, finds the demo data in the same directory per the comments and adopts it directly (zero multiple-choice questions); you only confirm once;
2. **Execution outsourced** — the main conversation spawns a subagent to run the execution loop (this is deliberate design: mechanical step-by-step execution should not pollute your main conversation context); what you see is progress line by line at intervention-point granularity;
3. **Final state** — on completion it reports back as structured YAML (`status: completed` + the full `weekly_report`), a weekly report the shop owner can read as-is.

Execution state lives in the `.hopstate/` directory throughout (gitignore recommended, already suggested). Two commands available at any time:

```
/hopspec status    # check progress
/hopspec resume    # resume from an interruption (e.g. the Claude Code session dropped)
```

## Step 6: experience a human-in-the-loop point (the soul of HopSpec)

coffee-week is fully automatic. Switch to one that **stops to ask you**:

```
/hopspec run examples/doc-review.md
```

This spec contains `[ask]` steps (confirm the document's positioning, choose a review mode) — when execution reaches them the engine **pauses**, Claude Code presents the question and the candidate options to you, and only after you choose does it continue. Note two things:

- Stopping to ask you is not Claude Code being polite — it is **explicitly declared by the spec author with `[ask]`/`[confirm]`**: the author said a human must decide here, so the engine forces a stop, and the LLM has no authority to answer in your place;
- This is "human-machine collaboration written into the structure": where it runs fully automatic and where it must ask a human is part of the spec, not a matter of luck.

## Troubleshooting

| Symptom | Remedy |
|---|---|
| `/hopspec` not in the list | Confirm install-skill printed ok; **restart Claude Code** |
| Skill says it can't find the engine | `npm i -g @hoplogic/hopjit` and retry (the skill locates it with a single `command -v hopjit`; if not found it errors out — no multi-level probing) |
| validate reports errors | Fix the spec per the messages — errors block execution, warnings don't |
| Want a clean rerun | Don't `rm -rf .hopstate` — each run creates its own instance directory, old instances don't interfere; if you really want isolation, switch `--state-dir` |

## Next steps

Read the main line in order: [[02-reading-a-spec]] (the foundation: build the full picture in five minutes) → [[03-explore-and-commit]] → [[D10-hop-python-compute]] → [[05-parallel-and-for-each]] → [[06-hands-on-fact-checker]] → [[07-upgrading-your-skill]].

- When tasks get longer and more frequent and you want to save conversation quota or switch to a lightweight model: standalone mode, a one-time setup — `USAGE.md` §6;
- Full syntax reference: `docs/concepts/HopSpec V3语法参考.md`; engine internals: `ARCHITECTURE.md`.
