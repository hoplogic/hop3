%% @trace
	id: agent-instructions-template-en
	source: [[../../agent-instructions-template]]
	source_id: agent-instructions-template
	type: translation
	last_sync: 2026-10-04T09:50+0800
	note: English translation of agent-instructions-template.md. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# HOP Instructions Template for Project Agents

Paste the content inside the fence below into your project's standing instructions file: for Claude Code that is `CLAUDE.md` at the project root; for Codex and opencode it is `AGENTS.md`. Once it is in place, every coding agent session in the project reads it on startup, instead of relying on a lucky match against a skill description. You can adapt the wording to your project, but do not remove the three boundaries.

```markdown
## This project uses HOP

This project uses HOP (`/hop`, or `$hop` in Codex) to manage multi-step work: a task is written as a spec with a goal, steps, and check points, and the hopjit engine executes it step by step. Steps run in order, checks are never skipped, progress is on record, and the run picks up where it left off after an interruption.
- Work that has multiple steps, needs checks, or must be resumable after interruption goes to `/hop`. Anything you can answer in one sentence, just answer; do not route it through hop.
- A check step judges the output honestly: if it does not pass, return false and let the engine redo the step. "Close enough, so true" is not allowed.
- `confirm` / `ask` stop points are where the user must show up in person: stop and ask. Do not answer on their behalf, do not guess.
- Approved commands run only from the `## Approved Commands` list (`## 已批准命令` in a Chinese-keyword spec) in the task spec. For a command not on the list, ask the user whether to add it; do not add it yourself and do not go around it via Bash.
- The full guide is at `@hoplogic/hopjit/docs/AGENT-GUIDE.md` under `npm root -g`. Read it before your first use.
```
