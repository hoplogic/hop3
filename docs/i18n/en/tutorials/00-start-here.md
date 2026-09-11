%% @trace
	id: hopjit-tutorial-index-en
	source: [[../../../tutorials/00-新人导读]]
	source_id: hopjit-tutorial-index
	type: translation
	last_sync: 2026-08-30T15:28+0800
	note: English translation of 00-新人导读.md. Consistency direction: translation follows the Chinese source; if you find errors in the source, report them, do not fix silently.
%%

# Tutorial 0 · Start here: which kind of reader are you?

Two kinds of readers, two series — pick the right track first, don't read them mixed together.

## 🙋 I want to **use** it: run tasks, write specs, make my own skills reliable

Take the **user series** (numbers indicate order):

| # | Article | One line |
|---|---|---|
| 1 | [[01-first-run-claude-code]] or [[01-first-run-codex]] | Pick one entry (by the tool you use), get your first spec running in 30 minutes |
| 2 | [[02-reading-a-spec]] | The foundation: build the full picture in five minutes — who thinks, who does the gatekeeping, how data flows |
| 3 | [[03-explore-and-commit]] | Learn to stay out of trouble first: reversible exploration vs irreversible commits — the antidote to deleted repos and deleted emails |
| 4 | 04-日常活交给hop (Chinese only for now) | Daily use: /hop upgrades the task at hand into engine-managed execution — progress on the books, gates never skipped, resumable after interruption |
| 5 | [[05-parallel-and-for-each]] | Efficiency: hand "do Y for each X" to the engine to do the counting |
| 6 | [[06-hands-on-fact-checker]] | Assembling the parts: a section-by-section dissection of a real, usable fact checker |
| 7 | [[07-upgrading-your-skill]] | Translate the NL skill you already have into a hopskill enforced by the engine |
| 8 | [[08-connecting-mcp]] | Advanced: register MCP services (search / knowledge base / cloud APIs) as tools a spec can call |
| 9 | [[09-sequential-thinking-and-subtask-free]] | Advanced: hand half-planned work to the engine — subtask free on-arrival expansion, the two disciplines, and where replanning differs |

Quick reference when in a hurry: `USAGE.md` (install and run on one page); trade-offs between the two execution modes (start with reuse / switch long tasks to standalone): `USAGE.md` §6. Configuration field lookup: `docs/reference/配置参考.md` (the formal reference — model tiers / credentials / tool registration, all fields and precedence).

**How deep you read is up to you**: only running ready-made skills → reading up to 1 is enough; want to understand other people's specs → up to 2; want the engine to manage your daily tasks → up to 4; want to write your own → 5-6; have existing NL skills → 7; need to connect external tools/services → 8; exploratory work → 9.

## 🛠 I want to **contribute to development**: understand the concept system, contribute to the engine/toolchain

Take the **ecosystem developer series**: [[D0-ecosystem-developer-guide]] (the ten-station main line: from the engineering implementation chain specification to module chain-collection and machine-check guards) → [[D1-engineering-with-ai-concept-to-design]] (first half: concept → architecture → module → design, narrowing layer by layer; designs expressed with the HOP trio — humans make decisions, AI does the derivation) → [[D2-engineering-with-ai-coding-and-acceptance]] (second half: how to hand work to AI, the discipline of AI coding, humans accepting via machine checks and anchor chains — checking the chain rather than reading code line by line) → D3-hopissues与todo的使用 (Chinese only for now: the two ledgers — internal todo/ cards and the cross-project hopissues channel) → [[D4-architecture-walkthrough]] (why the engine looks the way it does: mode-agnostic core + dual adapter shells + Provider boundary; build the full picture before assigning architecture-level work) → [[D5-errors-and-failure-handling]] (failures hang on the structure: FailRecord / repair ladder / uncaught termination / call boundary crossing) → [[D6-diagnosing-with-hoplog]] (the complete history of an execution: how to read the blocks, how to look up six common diagnostic questions) → [[D7-building-your-own-tools]] (the two routes, in-process vs MCP; interface contracts and responsibility charters) → [[D10-hop-python-compute]] (the restricted compute body the agent ghost-writes: four capability classes, the whitelist, read-and-verify is all you need; D8 model-and-tool config and D9 Obsidian plugin are Chinese-only for now).

> If you're unsure which track, use this test: **are you changing specs or src/**? Only writing specs and building skills — user; going to touch `src/`, `docs/design/`, or the driver layer — developer (and must read `docs/concepts/工程实现链规范.md` before starting). The two tracks aren't mutually exclusive; developers usually walk through the user series once first to build intuition.
