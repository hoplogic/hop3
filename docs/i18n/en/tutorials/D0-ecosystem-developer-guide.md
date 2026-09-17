%% @trace
	id: hopjit-tutorial-onboarding-en
	source: [[../../../tutorials/D0-生态开发者导读]]
	source_id: hopjit-tutorial-onboarding
	type: translation
	last_sync: 2026-08-15T13:43+0800
	note: English translation of D0-生态开发者导读. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D0 · Ecosystem Developer Guide: The Ten-Stop Project Main Line

**Who this is for**: people who want to **participate in HOP ecosystem development** — understand the concept system, read the code along anchors, contribute to the engine / driver layer / toolchain, or evaluate this project in depth. **If you just want to use it to run tasks / write specs, take the user series**: the [[00-start-here]] routing page → tutorials 01-07; you don't need to read this one.
**Structure**: the main line is **ten stops**; each stop answers one question and points to one authoritative document. The first seven stops are about "understanding" (from philosophy to engineering discipline); the last three are about "using" (from installation to building your own hopskill — shared with the user series). Walk them in order and you will have the complete picture.

---

## Main line overview

| # | Stop | Question it answers | Authoritative document |
|---|---|---|---|
| 1 | Engineering implementation chain spec | Why does this repo look the way it does? What are the rules organizing all docs and code? | `docs/concepts/工程实现链规范.md` |
| 2 | Positioning and core innovation | What is HopSpec, and what earns it the right to exist? | `docs/concepts/HopSpec核心创新.md` + `HopSpec V3核心规范.md` |
| 3 | Architecture language HopType | What language describes the architecture? What do struct/trait/impl each mean? | `docs/concepts/HopType体系.md` |
| 4 | Architecture | How is the engine layered, how do components interact? | `ARCHITECTURE.md` |
| 5 | Module principles | What counts as a healthy module? How are interface boundaries and versions managed? | `docs/design/module-principles.md` |
| 6 | Modules | Exactly which 14 modules are there? How is each one's chain collected? | `Doctree.md` "Module Index" → each module's design doc |
| 7 | Machine-check guards and human responsibility | What is guarded by machines, what must humans check? | `docs/design/chain-enforcement.md` |
| 8 | Installation | How do I get it installed? | [[01-first-run-claude-code]] steps 1-2 (Codex side: [[01-first-run-codex]]) |
| 9 | Usage | How do I run specs and handle intervention points? | [[01-first-run-claude-code]] steps 3-6 (or the Codex version) |
| 10 | Building and optimizing a hopskill | How do I turn my own workflow into a reliable hopskill? | [[07-upgrading-your-skill]] |

> Stops 8-10 are the user-series tutorials — for the full user main line (including the five spec-writing tutorials) see the [[00-start-here]] routing page.

---

## Stop 1 · Engineering implementation chain spec (⚖️ the meta-spec — close read)

`docs/concepts/工程实现链规范.md`. **Before everything else** — the four-layer chain concept → design → code → tests, the constitutional red lines (collect the chain first / design first), and the decision-vs-derivation working protocol; every document and all code in this repo is organized by it. Without reading it, you won't know why the grading tables, anchors, and the word "contract" in every later document exist at all.

**How to read**: close-read the whole thing. Self-check when done: can you explain "why the design must be finalized before touching src" and "what feasible-region narrowing layer by layer means".

## Stop 2 · Positioning and core innovation (what earns HopSpec its existence)

Read `docs/concepts/HopSpec核心创新.md` first (short; overall positioning — business logic moving from hard-coding to structured orchestration, separation of explore and commit, progressive solidification), then the §Positioning + §Step types + §Execution model sections of `docs/concepts/HopSpec V3核心规范.md`.

**How to read**: read the core-innovation doc in full; from the core spec grasp three things — among the 14 step types, **who reasons (reason), who computes (act), who gatekeeps (confirm/check)**; None propagation; and that human intervention points are language structure, not runtime politeness. Treat the remaining chapters as a dictionary for lookups (it is the largest source of `^anc-*` anchors in the whole repo).

## Stop 3 · Architecture language HopType (struct/impl/Spec)

`docs/concepts/HopType体系.md`. This project does not describe its architecture in free prose; it uses the **HopType trio**: `struct` (component identity and state boundary) / `trait` (capability contract) / `impl` (behavior implementation — HopSpec is the language of impl). Analogy with Rust: the struct/trait/impl relationship is the same, except an impl can be carried out by an LLM (dual-state fusion).

**How to read**: reading the positioning and analogy sections is enough. Only after this can you understand phrases in Stop 4's ARCHITECTURE.md such as "describes its own architecture using the struct/impl/Spec system" and "dual-state distribution", as well as the "four HopType elements" format (positioning / relations / traits / impl logic) used in the design docs.

## Stop 4 · Architecture (ARCHITECTURE.md)

`ARCHITECTURE.md`. The three-layer structure (engine core = pure flow control with zero I/O assumptions ← driver adaptation ← carrier) + the two modes (reuse / standalone) form the skeleton of the entire architecture. **Close-read**: the architecture layering, the layer bridging points (the approved closed set of cross-layer dependencies), component interaction, and the dual-state distribution (which structs are deterministic TS implementations, on which side the reasoning intelligence lives). For the teaching-narrative version (the panorama reordered by "why"), see [[D4-architecture-walkthrough]].

**Note**: ARCHITECTURE is the architecture overview, not the home of module details — the module list and each module's chain live at Stop 6.

## Stop 5 · Module principles (module-principles.md)

`docs/design/module-principles.md`. The authority on the principles of module work; five things: the four criteria of a healthy module (anchors + boundary declaration / @module attribution / independently chain-collectible / dedicated red light), the three-layer dependency-direction rule (shared < core < adapter; lower layers must not import higher ones), the **interface boundary** (export list = the closed set of the externally-depended surface; anything off the list is internal), **versioning and compatibility** (the version number is driven by compatibility changes to the export list), and the split-trigger criteria T1-T5 (no signal, no split).

**How to read**: read it through. These are the rules you must internalize before your first code change — especially "no export without a nameable consumer" and "before touching src, the corresponding module's design must be finalized first".

## Stop 6 · Modules (Doctree Module Index → collect the chain module by module)

Open the "Module Index" in `Doctree.md` — one chain per line for the 14 modules: module anchor → concept upstream → design authority → src files → tests. **This is this project's distinctive way of reading code; do not start at the first file in src/ and read onward**:

1. Pick a module (for the first one, **doc-ref** is recommended — 163 lines, complete in every part);
2. Go to its design doc and read its three staples first: the **grading table** (routes attention to decisions and contracts), the **module version block** (boundary declaration), and the **export table** (closed set of external interfaces);
3. For each `^anc-*` contract, `grep '@a: anc-xxx' src/` jumps straight to the implementing lines and `grep '@v: anc-xxx' tests/` straight to the verifying cases — **jump along anchors, don't read files sequentially**;
4. Search the same anchor in `TRACEABILITY.md` and check the full chain card.

**20-minute exercise**: walk one full chain of `anc-exec-doc-ref-resolve` (design contract → implementation → test → card). Once you've walked it, you own the general code-reading method. For big modules (exec-engine, 1900+ lines) the method is the same but collect just one contract chain — **the engine is not for reading through; it is queried by contract**.

## Stop 7 · Machine-check guards and human responsibility (chain-enforcement)

`docs/design/chain-enforcement.md`. The guard master map: who guards each link of the chain, the blank-spots ledger (which links are explicitly accepted as unguarded), and the guard admission rules. **Key insight: the three classes of guards are different in nature, and machine checks are only the first class** —

| Class | What it guards | Who executes |
|---|---|---|
| Deterministic machine checks | anchor format / layer-direction dependencies / module boundaries / tests / coverage / audit baseline | `npm run check*` + pre-commit hook + CI, **fully automated by machines** |
| Semantic audit | whether the design faithfully conveys the concepts, whether the implementation matches the contract's **intent** | **Human/LLM** runs the anchor-audit skill (mandatory before milestones/releases, G3 cadence) |
| Behavioral discipline | collect the chain first, no overstepping on decisions, "ask before acting" as the default with exceptions | **Only humans** can review this — a machine cannot check "did you collect the chain before acting" |

So what **humans must focus on** are the latter two classes: run a full semantic audit before each release; during review, watch "did this change collect the chain, were the decisions that should have been escalated escalated, were v1 deviations annotated". **All machine checks green ≠ chain healthy** — that sentence appears at the tail of every report precisely to stop you from mistaking class one's green for the whole.

## Stop 8 · Installation

[[01-first-run-claude-code]] steps 1-2: `npm i -g @hoplogic/hopjit` + `hopjit install-skill`. Quick version in `USAGE.md` §1-2. **Reuse mode needs no API key at all** — this is not a convenience trick but an architectural decision (reasoning is carried by the outer LLM; the engine is pure flow control).

## Stop 9 · Usage

[[01-first-run-claude-code]] steps 3-6: `/demo-coffee-week` as the shortest first run (the named-skill product form) → the validate gate → the `/hopspec run` generic driver → experience the ask/confirm intervention points ("stopping to ask you is a structure declared by the spec author, not the LLM's politeness"). Codex carrier entry and differences: [[01-first-run-codex]]. **The trade-off between the two modes** (reuse mode: zero-config onboarding; for long tasks switch to standalone mode — independent sandbox, swappable lightweight model to save cost, at the price of one-time configuration) is in `USAGE.md` §6. For daily quick reference use the command table in `USAGE.md` §5.

## Stop 10 · Building and optimizing a hopskill

[[07-upgrading-your-skill]]: several classes of reliably reproducible accidents (missed traversal / skipped verification / irreversibility during trial-and-error / decisions that should have gone to a human) → `/hopbuild` translation → discipline-mark report audit (four mark classes: traverse / verify / commit / hitl) → `hopjit pack` into a named skill. For deeper optimization consult `skills/hopbuild/hopbuild-knowledge.md` (unified knowledge file: four-mark criteria / step-type quick reference) and `docs/concepts/HopSpec V3语法参考.md`. The loop: **natural-language skill → (translate) → spec → (pack) → a more reliable named skill**.

---

## After the walk: your first change

> The hands-on development pair (main line = concept-architecture-module-design with the HOP trio + AI coding): [[D1-engineering-with-ai-concept-to-design]] → [[D2-engineering-with-ai-coding-and-acceptance]].

Two behavioral-constitution rules (violating them is simply wrong): **collect the chain first** (Stop 6's method is exactly chain collection) and **design first** (before touching src, the corresponding design must be finalized). The rhythm: `ls todo/` and pick a small item (the filename carries the state; an open card is ready to work on) → change the design → change the code (`@a:`) → add tests (`@v:`) → file the TRACEABILITY card → `npm run check`. If a change touches the driver/engine and you want to try it in local CC: `npm run dev:install` (rebuilds dist + installs the latest skill, refreshed as a pair); releasing goes through `npm run release` (ten-step checklist). **`npm run` must be executed at this repo's root** (it reads the current directory's package.json; running elsewhere gives ENOENT — calling `<repo>/scripts/dev-install.sh` directly works from any directory, the script cds by itself). A red machine check is not a nuisance — it is blocking rework on your behalf. **Creating a new module** is the heaviest gatekeeping tier of chain collection — the agent delivers the module eight-item checklist (`chain-enforcement.md` §1c-2) in a single change (the human only checks that everything was delivered). Once you become a routine maintainer, the per-operation checklists for commit/release are in the maintainer operations manual (internal, not distributed in the public snapshot; manual layer: used every time, no need to come back to this tutorial).

## Standing quick reference

| What you need | Where to go |
|---|---|
| Find any document | `Doctree.md` (the doc root) |
| Locate a feature's full-chain footprint | search the anchor in `TRACEABILITY.md` |
| Current project status | `STATUS.md` (allowed to be stale; numbers come with regeneration commands) |
| The rules before touching anything | `CLAUDE.md` (meta-spec summary + machine-check entry points) |
| Write / look up spec syntax | `docs/concepts/HopSpec V3语法参考.md` |
