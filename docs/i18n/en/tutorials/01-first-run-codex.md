%% @trace
	id: hopjit-tutorial-codex-en
	source: [[../../../tutorials/01-第一次运行-Codex]]
	source_id: hopjit-tutorial-codex
	type: translation
	last_sync: 2026-08-30T13:41+0800
	note: English translation of 01-第一次运行-Codex.md. Consistency direction: translation follows the Chinese source; if you find errors in the source, report them, do not fix silently.
%%

# Tutorial 1 (Codex edition) · Your first run

> Using Claude Code? Read the parallel edition [[01-first-run-claude-code]]. Tutorials 02-07 that follow are shared by both carriers — wherever carrier-specific commands appear, a "Claude Code command" and a "Codex command" code box are given side by side; copy the one that's yours.

**Goal**: in the Codex CLI, go from zero installation to running a spec end to end.
**Prerequisites**: Node.js ≥ 18 and the Codex CLI installed. First install the engine with `npm install -g @hoplogic/hopjit` and `git clone` this repo (same as steps 1 and 4 of the CC edition — those two steps are carrier-independent).

> ✅ Status (2026-08-10): all execution paths of the Codex carrier passed live E2E — delegated (subagent handoff), inline (weak-model direct drive), and standalone mode (MCP server), all three green, including the HITL intervention loop. Acceptance evidence in `.e2e-evidence/`.

## Differences from the Claude Code edition: same semantics, different carriers

The two carriers drive **the same engine, the same spec, the same set of execution semantics** — the spec file needs not a single character changed. What differs is only the orchestration primitives on the carrier side:

| | Claude Code carrier | Codex carrier |
|---|---|---|
| Install location | `.claude/skills/hopspec/` | `.agents/skills/hopspec/` |
| Trigger prefix | `/hopspec` | `$hopspec` |
| Execution segment carried by | driver subagent (execution loop outsourced) | outsourced identically when subagent capability exists; otherwise Main runs it itself (inline), semantics unchanged |
| Asking the human | AskUserQuestion component | direct Q&A in the Codex conversation |

## Step 1: install

Install at the root of the project where you'll run specs:

```bash
cd <your project>
hopjit install-skill --carrier codex --demo
```

Generated layout:

```
.agents/skills/hopspec/
├── SKILL.md                    # main orchestrator: startup interaction / intervention points / final state
├── agents/
│   └── segment-driver.md       # execution segment (continuous reason/act/check loop)
└── references/                 # execution details such as discovery / execution-rules

.agents/skills/demo-coffee-week/
├── SKILL.md                    # $demo-coffee-week named demo entry
├── spec.md
└── coffee-sales.json
```

> Advanced: `--plus` additionally installs two research skills `$hop-fact-check` / `$hop-deep-research` (also project-scoped), and merges the search/browser tool config they need into `~/.hopjit/config.yaml` — after that only `export DASHSCOPE_API_KEY=<your Bailian key>` remains. Skip on first run.

## Step 2: trigger

Codex triggers skills implicitly by their description, or you can invoke explicitly with `$`:

```text
$demo-coffee-week
```

That is the shortest first run. The generic driver entry is still:

```
$hopspec run examples/data-quality.md
```

The main orchestrator first locates the hopjit CLI (a single `command -v hopjit`; if not found it errors out), then automatically chooses the execution style for the current environment (with subagent capability it outsources the execution segment, without it it runs the segment itself; if a hopjit MCP server is registered it switches to standalone mode as a whole — see below). Either way, the rhythm you see is the same: parameter confirmation → execution → intervention points asking the human → final report.

## Step 3: know where the differences are (so you don't mistake them for bugs)

- **No guessing on empty stdout**: if an advancing CLI command returns no parsable JSON, the driver stops immediately and reports `DRIVER_PROTOCOL_ERROR` — it will not guess the next step from the spec or the filename;
- **resume is for crash recovery only**: normal continuation at intervention points goes through the structured handoff between main and the execution agent, not resume — don't manually resume in the normal flow;
- **The in-carrier docs are self-contained**: `.agents/skills/hopspec/` contains no Claude Code terminology (AskUserQuestion, task-notification, etc.); if you see any in there, it was installed for the wrong carrier — reinstall with `--carrier codex`.

## Troubleshooting

| Symptom | Remedy |
|---|---|
| Codex doesn't trigger the skill | Confirm `.agents/skills/hopspec/SKILL.md` exists in the **current project** and its first line is `---`; invoke explicitly with `$hopspec run …`; if it still doesn't appear, restart Codex |
| `$demo-coffee-week` doesn't appear | Reinstall with `hopjit install-skill --carrier codex --demo --force`; you can also type `/skills` and pick from the list |
| Engine not found | `npm i -g @hoplogic/hopjit`; or in-project `npm i @hoplogic/hopjit` |
| parallel seems "stuck" | In conversation-driven mode, parallel steps currently execute sequentially (results identical) — the jobs finish one after another before it continues; just let it run to completion |

## Optional: standalone mode (switch long tasks to it)

When tasks run long, run often, or you want a lightweight model to save cost, set up standalone mode once: execution moves into a separate server process (not consuming your conversation context), and reasoning switches to the API model you designate (such as deepseek-chat). Setup steps and the full trade-off table between the two modes are in `USAGE.md` §6; **Codex + DeepSeek model users must first read `docs/WORKAROUNDS.md` W-1** (a patch for an upstream bug). The same spec works in both modes, zero modification.

## Next steps

Read the main line in order (the same track as CC users): [[02-reading-a-spec]] → [[03-explore-and-commit]] → [[D10-hop-python-compute]] → [[05-parallel-and-for-each]] → [[06-hands-on-fact-checker]] → [[07-upgrading-your-skill]] (note: the translator /hopbuild in 07 is currently provided only for the CC carrier; Codex users can translate in CC — the artifact works on both carriers).

- Carrier internals (role split, handoff protocol): `docs/design/codex-driver-carrier.md` (developer-oriented).
