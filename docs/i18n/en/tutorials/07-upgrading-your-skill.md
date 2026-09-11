%% @trace
	id: hopjit-tutorial-hopskill-en
	source: [[../../../tutorials/07-升级你的自然语言skill]]
	source_id: hopjit-tutorial-hopskill
	type: translation
	last_sync: 2026-08-15T12:55+0800
	note: English translation of 07-升级你的自然语言skill. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 7 · Upgrading Your Natural-Language Skill to a hopskill

**Goal**: take one of your own **natural-language skills** (a SKILL.md written in pure prose, also called a prose skill in English docs), translate it into a HopSpec specification (a **hopskill**), run it, and feel the difference between the two.
**Prerequisite**: complete tutorial 1 (engine and skill installed). If you've read tutorials 03-05, your audit of the translation output (step 3) will go much deeper.

> Note for Codex users: the translator `/hopbuild` is currently available only on the CC carrier — do the translation in CC; the resulting spec works on both carriers.

## Why upgrade

A natural-language skill's discipline relies on the executing LLM "reading it and remembering it". Once the context gets long, three kinds of accidents reproduce reliably:

| Accident | Example |
|---|---|
| **Missed iteration items** | "Do X for each file" — by item 7 it forgets there are 3 more |
| **Skipped review** | "Continue after the user confirms" — the LLM decides on its own that "it should be fine" and continues |
| **Irreversible operations during trial-and-error** | Still debugging, and the email has already been sent |

A hopskill turns these three from "relying on memory" into **engine-enforced structure**: iteration translates to `parallel + for-each` (the engine replicates by list length and joins only when everything completes — missing an item is impossible); review translates to `confirm`/`check` (the engine pauses for a real human; the LLM has no authority to answer in their place); irreversible operations translate to `commit` with a mandatory preceding gatekeeping gate.

## Step 1: pick a natural-language skill

A good candidate looks like this: a clear step sequence, a "for each..." iteration, a "have the user confirm" review point, and a final deliverable. For your first practice run, don't pick anything too big (under 10 steps).

Don't have one at hand? The repository has a ready-made pair of teaching samples: `scripts/audit/test-coverage-audit.md` is a golden sample translated from the natural-language skill of the same name — read it first to get a feel (note: it was generated before the mark-report requirement was established — but all four mark structures are there: step 5 is parallel+for-each [traverse], 3.3 is a [check final] [verify], 2.1.2 is a commit with a preceding gate [commit]).

## Step 2: translate

Claude Code command (the translator is currently available only on the CC carrier; Codex users translate in CC, and the output works on both carriers):

```
/hopbuild .claude/skills/your-skill/SKILL.md
```

(If you give no path, it lists the candidates under your `.claude/skills/` for you to pick from.)

Everything you get asked during translation falls under "the original's intent is unclear" — the translator's principle is **faithful translation, no adding or removing business logic**; when in doubt it asks you rather than guessing. When done, it automatically runs `hopjit validate`, and only hands the spec over for your inspection once the syntax gate passes (the semantic-fidelity gate is yours).

## Step 3: read the output (the discipline-mark report)

Delivery comes with a **discipline-mark report** (focus_report) — where each of the four key disciplines landed: **traverse** (every "for each" turned into a loop), **verify** (every acceptance turned into a check), **commit** (every irreversible action turned into a commit), and **hitl** (every human decision turned into an ask/confirm). Use the report to locate the corresponding structures in the spec:

```markdown
2. [loop for-each file in files, parallel] Review file by file   ← report: traverse
   2.1. [reason] Review a single file … (the for-each child template)

3. [confirm] Human sign-off on the review conclusions            ← report: hitl

4. [commit] Submit the changes                                   ← report: commit (gate = the preceding confirm)
```

The report exists for your audit: every "for each / have the user confirm / send and submit" in the natural-language original should have a corresponding structural landing point in the spec. **Check mark by mark** — did every iteration point become a for-each (traverse)? Does every hard constraint land in a check (verify)? Is there a gate before every irreversible operation (commit)? Does every decision that needs a human actually go to a human (hitl)? (Corresponding explanations: iteration → [[05-parallel-and-for-each]], check/commit → [[03-explore-and-commit]], assembly exemplar → [[06-hands-on-fact-checker]].)

## Step 4: run it

Claude Code command:

```
/hopspec run your-generated-spec.md
```

Codex command (the spec works on both carriers):

```
$hopspec run your-generated-spec.md
```

It feels just like tutorial 1, but note the differences from running the same task with the natural-language version:

- Iteration is fanned out by the engine (parallel workers running concurrently), not the LLM going one by one from memory;
- At a confirm it **always** stops to ask you — even when the answer is "obvious";
- After an interruption, `/hopspec resume` continues from the breakpoint — an interrupted natural-language skill can only start over.

## Step 5 (optional): iterate

Translation is not a one-shot deal. After a few runs, when you want adjustments (add steps, change constraints), **edit the spec file itself** — it's plain markdown; once `hopjit validate` passes, it runs. Don't forget the spec is the sole authority: don't keep one copy of the logic in the natural-language skill and another in the spec, each edited separately.

## Step 6 (recommended): package it as a named skill

Once you're happy with the validated translation output, wrap it as an **independent named skill** — so that people who don't know HopSpec exists can use it too:

```bash
hopjit pack your-generated-spec.md
```

This generates the project-level `.claude/skills/<the spec's Id>/` (a thin SKILL.md + the spec + knowledge docs — pack output stays with the project; use `--dir` to install elsewhere, e.g. the user-level directory). From then on, a user just says "help me do XX" to trigger it; the skill guides parameter collection, and execution still goes through the hopspec driver protocol — but that's an implementation detail the user doesn't need to know. This is the complete loop: **natural-language skill → (translate) → spec → (pack) → a more reliable named skill**. From the user's perspective, "the skill got upgraded" with zero change in usage.

## The tutorial main line ends here — where to go next

You can now run, read, and write specs, and upgrade your own skills into engine-enforced hopskills. From here, take what you need:

- **Tasks getting longer and more frequent, want to switch to a lighter model to save cost** → standalone mode, one-time setup: `USAGE.md` §6;
- **Writing bigger specs** → use `examples/hop-fact-check.md` (the full version) as your exemplar — the advanced pieces like self-check loops and inference forks are explained in [[06-hands-on-fact-checker]]; the syntax authority for quick lookups: `docs/concepts/HopSpec V3语法参考.md`;
- **The translator's deeper criteria** (for auditing its output): four discipline-mark criteria/templates/counterexamples and NL phrasing → step type mapping, unified in `skills/hopbuild/hopbuild-knowledge.md`;
- **Want your spec to call external capabilities** (search / knowledge bases / cloud APIs) → [[08-connecting-mcp]];
- **Want to join HOP ecosystem development** → switch tracks to [[D0-ecosystem-developer-guide]].
