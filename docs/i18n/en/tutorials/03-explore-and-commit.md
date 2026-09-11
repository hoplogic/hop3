%% @trace
	id: hopjit-tutorial-act-commit-en
	source: [[../../../tutorials/03-探索与提交]]
	source_id: hopjit-tutorial-act-commit
	type: translation
	last_sync: 2026-08-15T13:00+0800
	note: English translation of 03-探索与提交. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 3 · Explore and Commit: The Mechanism for Trying with Confidence

**Goal**: understand the boundary between `act` and `commit`, learn to write "exploration you can retry freely" and "commits that must land in one decisive stroke", and know where temporary files created during execution should go.
**Prerequisite**: complete [[02-reading-a-spec]] (recognizing the type names act/commit/confirm is enough).

## One question leads to everything: if it fails, do you dare start over?

LLMs fail when executing tasks, and the best remedy for failure is retrying. But for some things, **retrying is a disaster**: an email sent twice, an order submitted twice, a production file overwritten twice. In a natural-language skill, this depends on the LLM itself weighing "this step is dangerous" — misjudge once and you have an incident.

HopSpec's answer is to write "do you dare start over" into the step type — **explore/commit separation**:

|         | `act` (explore)                                  | `commit` (commit)                                           |
| ------- | ------------------------------------------ | ------------------------------------------------------ |
| Side effects     | **Must be reversible**: pure computation, queries, reads/writes in sandbox/temp areas                   | **Irreversible**: sending email, payment, writing to a production database, modifying official files                              |
| On failure     | The engine retries with confidence (retry/adaptive rerun at will)                | **Must not be placed bare inside a retry container** (only allowed with a `check final` or `confirm` gatekeeping it upstream) |
| Authorization      | Not needed                                        | Carries no authorization itself — **reaching the commit means gatekeeping was already completed upstream**                      |
| Body grammar | The same hop_python (covered next in [[D10-hop-python-compute]]) | Fully identical; the only differences are the three rows above                                        |

The freedom this boundary buys is: **inside act steps the agent can explore with its hands untied** — trial calculations, drafts, multiple versions, with zero cost to start over after failure; all irreversible consequences are isolated at explicit `commit` nodes, and a gate always stands before a commit.

## Step 1: run a complete explore → gatekeep → commit chain

Claude Code command:

```
/hopspec run examples/syntax/confirm-commit.md
```

Codex command:

```
$hopspec run examples/syntax/confirm-commit.md
```

This spec does a batch rename; its six steps walk a textbook chain:

```
1 [act]     scan the file list          ← explore: a read operation, start over at will
2 [reason]  generate a rename plan      ← reasoning: design the plan
3 [confirm] user confirms the plan      ← gatekeeping: the engine forcibly stops and waits for you
4 [act]     create a reversible backup  ← explore: backing up is a reversible preparatory action
5 [commit]  execute the rename (irreversible)  ← commit: only here does it get real
6 [reason]  generate the report
```

When it reaches step 3 it **will** stop and ask you — only after approval does step 5 happen. If you reject: global abort, all unexecuted steps are marked `skipped`, and **the commit never executes**. This isn't politeness; it's the semantics of `confirm`.

## Step 2: the three rules for writing commit

**Rule one: there must be a gate before it.** Things a human must decide go in a `confirm` (the form used in this tutorial); things machine-checkable go in a `check`. A commit without any gatekeeping fails the mental review — "reaching the commit means authorization was already completed" is its semantic premise.

**Rule two: be idempotent where possible.** Crash recovery may replay a commit, so design the body to be "harmless when replayed". See how the sample's step 5 is written:

```markdown
5. [commit] 执行批量重命名（不可逆）
  > 按 rename_plan 执行重命名（幂等设计：逐项先检查——目标名已存在且源文件
  > 已不在则视为本项已完成、跳过，避免崩溃重放时重复重命名或报错）
```

Checking by business key before acting (upsert rather than blind insert) is the most common idempotency technique.

**Rule three: don't place it bare inside a retry container.** Steps inside `[subtask retry=N]` are rerun as a whole — a bare commit inside means the irreversible action could execute N times. The exception is a gatekeeping step standing before it (`check final` or `confirm`): a rerun passes the gate first, and if the gate doesn't clear, the commit won't execute again. The validator blocks by this criterion (bare commit errors out; with upstream gatekeeping it passes) — but understand the why first.

## Step 3: work_zone — free territory for the exploration phase

Act steps "can write files freely" — write them where? Each execution unit gets an **exclusive workspace `work_zone/`** (under `.hopstate/<instance>/`, created automatically by the engine). This is the only legitimate territory for temporary files during exploration:

- **Write freely**: drafts, intermediate results, trial outputs, as many versions as you like — it exists for exploration;
- **Naturally isolated**: in parallel execution each worker has its own work_zone (directory name carries the step number), so they never collide — you don't have to think about filename conflicts for concurrency;
- **Out of bounds means rejected**: writing temp files to `/tmp` or the project root? The engine validates paths at submission time and rejects out-of-bounds writes outright — not to be difficult, but to turn "exploration doesn't dirty the outside" from self-discipline into structure;
- **Big data automatically goes here**: values passed between steps exceeding 4KB are automatically offloaded by the engine to `work_zone/vars/` on disk, passing a pointer — you don't manage this; just know large files can be found there.

**Mental model**: inside work_zone = the exploration zone (mess around however you like; a retry is a fresh start); outside work_zone = the real world (to touch it, go through commit + upstream gatekeeping).

## Step 4: who guards the boundary (awareness is enough)

For everyday spec writing, the boundaries you need are the two already covered, both enforced by the engine: **work_zone out-of-bounds validation** (a temp file written outside the workspace is rejected outright at submission) and **commit's upstream-gatekeeping rule** (the validator blocks bare commits). That already covers the safety needs of personal and team scenarios.

One level above sits the **four-dimensional sandbox** (`SandboxConfig`: filesystem / network / runtime / database declaratively delimit what act can touch) — an advanced topic reserved for **production deployment**: multi-tenancy, audit compliance, fine-grained resource boundaries, that tier of requirements. No need to configure it day to day; if interested, see `docs/design/sandbox.md`.

## This is the whole mechanism of "trying with confidence"

Look back at the core-innovation line — "lock the goal, guard the boundary, free the path":

- **Lock the goal**: Goal / Constraints / Outputs pin down the delivery contract;
- **Guard the boundary**: explore/commit separation (this tutorial) + gatekeeping gates (confirm/check) + work_zone/sandbox;
- **Free the path**: within the boundary, the agent explores autonomously, retries after failure, replans adaptively — no route it takes can cause harm.

Daring to let the agent try things itself in new scenarios comes precisely from trial-and-error being structurally caged.

## Next steps

- Continue the main line with [[D10-hop-python-compute]] — how to write act/commit's compute body;
- Complete act/commit semantics and check/confirm signature details: `docs/concepts/HopSpec V3语法参考.md` §3 (step types);
- Compensation patterns after commit failure (saga/transaction boundaries): `docs/concepts/HopSpec V3扩展-事务与补偿.md`;
- Where explore/commit separation sits in the overall innovation map: `docs/concepts/HopSpec核心创新.md`.
