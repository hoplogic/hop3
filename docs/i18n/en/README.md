%% @trace
	id: hopjit-readme-en
	source: [[../../../README]]
	source_id: hopjit-readme
	type: translation
	last_sync: 2026-08-15T12:55+0800
	note: English translation of README.md. Consistency direction: translation follows the Chinese source; if you find errors in the source, report them, do not fix silently.
%%

# hoplogic — HOP 3.0

**hoplogic** is the official project of HOP. **HOP** is a dual-state fusion language/concept system for LLM Agents, currently at version 3.0 (concept-layer documents are uniformly labeled V3). The three names in the project each have their own role:

| Name          | What it is                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HOP 3.0** | v3.0 of the HOP language/concept layer. Concept specifications: [Core Specification](../../../docs/concepts/HopSpec V3核心规范.md) (language authority) · [Core Innovations](../../../docs/concepts/HopSpec核心创新.md) (positioning); all 13 documents in the "Concept layer" table of the [Doctree](../../../Doctree.md) |
| **HopSpec** | HOP's task specification language — declares task structure in markdown (step types, data flow, loops/branches/parallelism, human-in-the-loop points)                                                                                                     |
| **HopJIT**  | The HopSpec execution engine within the hoplogic project (npm package `@hoplogic/hopjit`, command `hopjit`) — handles flow control: execution state management, variable storage, retry/adaptive repair, None propagation, etc.                                                |

## Project main line (understand it · use it)

**Understand it** (from concepts to engineering, seven stations): ⚖️ [Engineering Implementation Chain Specification](../../../docs/concepts/工程实现链规范.md) (the meta-spec, all organizational rules) → [Core Innovations](../../../docs/concepts/HopSpec核心创新.md) (positioning) → [HopType System](../../../docs/concepts/HopType体系.md) (the architecture language: struct/trait/impl) → [ARCHITECTURE](../../../ARCHITECTURE.md) (architectural layering) → [Module Principles](../../../docs/design/module-principles.md) → [Doctree · module index](../../../Doctree.md) (chain-collection entry for the 14 modules) → [chain-enforcement](../../../docs/design/chain-enforcement.md) (machine-check guards and human responsibilities).

**Use it**: user tutorial series 01-07 (dual-carrier entry → learning to read → the three spec-writing essentials → hands-on → upgrading NL skills), start from the [tutorial start page](./tutorials/00-start-here.md). Quick reference: [USAGE.md](../../../USAGE.md).

**Maintain it** (routine operations): maintainers/RELEASING.md (maintainer-internal, not distributed in the public snapshot) (commit/release operations manual — triage, manual acceptance assertions, automated E2E, pitfall quick reference) · [STATUS.md](../../../STATUS.md) (current status) · the todo/ directory (internal) (todos and technical debt).

> 🧭 Ecosystem developers (those who will touch src/design/driver): the ten-station main line is in [D0 Ecosystem Developer Guide](./tutorials/D0-ecosystem-developer-guide.md).

Two driving modes:

- **Reuse mode (reuse)**: an outer LLM (such as Claude Code) acts as the reasoning engine, and HopJIT does pure flow control — **no API key required**. Driven by the companion `hopspec` skill.
- **Standalone mode (standalone)**: the HopJIT engine calls the LLM API directly to execute (MCP server form) — you can switch to a lightweight model to save cost, and it does not consume conversation context; one-time setup of `~/.hopjit/config.yaml` + carrier registration, see `USAGE.md` §6.

## Step 1: install the HopJIT engine

**Everything starts with this command** — without the engine installed, none of the skills, demos, or specs that follow are possible:

```bash
npm install -g @hoplogic/hopjit
```

If `hopjit --version` prints a version number, installation succeeded. The three-level naming in one sentence: the **package** you install is called `@hoplogic/hopjit`, the **command** you get is called `hopjit`, and it runs the package's `dist/cli.js`.

```bash
# Don't want a global install? You can also install into just your project (at your project root)
npm install @hoplogic/hopjit
```

> Developers (cloning this repo to change code): install and refresh via `npm run dev:install`, see "Development and releasing" below.

## Step 2: install the skill, drive from the conversation

**The everyday entry point is not the command line — it is the skill**: Claude Code uses `/hopspec run <spec>`, Codex uses `$hopspec run <spec>`; the hopjit command line is mainly the protocol interface of the driver layer, and humans only touch it directly in three places (installing skills / validating specs / packing skills, see the next section).

**One command to install** (automatically expands the package's `driver/` source into the correct layout, no manual cp needed):

```bash
# Claude Code (default, installs to .claude/skills/)
hopjit install-skill

# Want an out-of-the-box demo: --demo additionally installs the /coffee-week named skill (with demo data; once installed, say /coffee-week in a conversation to receive a coffee-shop weekly report)
hopjit install-skill --demo

# Codex (installs to the current project's .agents/skills/hopspec/ by default)
hopjit install-skill --carrier codex

# Codex out-of-the-box demo: additionally installs .agents/skills/coffee-week/, use $coffee-week in the conversation
hopjit install-skill --carrier codex --demo

# Overwrite an existing Codex skill (when you have modified the skill and want to reset it)
hopjit install-skill --carrier codex --force
```

Layout expanded by `install-skill` (CC):

```
.claude/skills/
├── hopspec/
│   ├── SKILL.md          # main skill (source driver/hopspec-skill.md, renamed)
│   └── references/       # carrier-neutral shared files (cli-discovery / driver-subagent / …)
└── skills/hopbuild/
    ├── SKILL.md
    └── references/
```

At startup the skill **bootstraps discovery** of the hopjit location (global command → project node_modules → in-package dist → dev-time fallback), so no paths need hardcoding — see `references/cli-discovery.md`.

Then, inside Claude Code:

```
/hopspec run <spec.md>          # drive execution of a spec
/hopspec list [dir]             # list executable specs
/hopbuild                 # translate a natural-language skill into a hopskill
```

For the Codex carrier see `driver/codex/SKILL.md`. After installation it can be triggered implicitly by its description, or invoked explicitly with `$hopspec run examples/data-quality.md`; with `--demo`, use `$coffee-week` directly. When subagent capability is available it uses batched fan-out; without that capability it automatically degrades to inline serial execution — barrier/HITL/state semantics unchanged.

> The getting-started demo ships with the package: `install-skill --demo` installs the named skill for the corresponding carrier — type `/coffee-week` in CC, or `$coffee-week` in Codex; both use the bundled demo data to directly produce a weekly report. Technical users can still run arbitrary specs through the generic hopspec driver.

## The CLI is the driver layer's protocol interface, not the human entry point

The only commands a human needs to type are the one-time installation (`npm install` + `hopjit install-skill`, see above). All the remaining subcommands — `validate` / `pack` / `run` / `submit_and_fetch_next` / `status` / `resume` / `join_parallel` / `fanout-plan` / `fanout-next` / `debug_step` / `vars` / `list` — are invoked by agents (skill / dispatcher): validation is gated automatically by `/hopbuild` at generation time, packing is run by it at delivery time, and execution state is driven by `/hopspec`. Machine consumption uniformly uses `--json` (the default output is human-oriented YAML, for agents to relay or for humans to read when troubleshooting). Full table in [USAGE.md](../../../USAGE.md) §5.

## Development and releasing (maintainers)

```bash
# After cloning, everything runs at this repo's root (npm run reads the current directory's package.json; wrong directory gives ENOENT)
git clone <this repo> hoplogic && cd hoplogic

# One command for development (self-healing: the first run does npm install/npm link automatically; afterwards just rerun it after changing code/driver)
# Does four things: install dependencies (only if missing) → rebuild dist → add global symlink (only if not yet linked) → install the latest skill to ~/.claude/skills
npm run dev:install
npm run dev:install -- --demo    # also installs the demo skill: /coffee-week for CC, $coffee-week for Codex

# Release: eleven-step checklist (full check / tarball asset verification / version / publish / global update / install skill / push tag), stops at the first failed step
npm run release
```

The complete operations manual for every commit/release (triage, manual acceptance assertions, pitfall quick reference) is in maintainers/RELEASING.md (maintainer-internal, not distributed in the public snapshot).

## Dependencies

- **Runtime dependencies**: `commander` (CLI) + `@anthropic-ai/sdk` (used only by the StepDispatcher in standalone mode; never triggered in reuse mode).
- Reuse mode (skill-driven) **requires no API key** — reasoning is carried by the outer LLM.

## Important files at the repo root

| File | What it does | Who uses it, and when |
|---|---|---|
| [Doctree.md](../../../Doctree.md) | The root of the repo-wide document index — what documents exist, what derives from what | Enter here to find any document |
| [USAGE.md](../../../USAGE.md) | Getting-started quick reference (install and run, on one page) | Users, for a quick lookup after installing |
| [ARCHITECTURE.md](../../../ARCHITECTURE.md) | Architecture overview — layering / bridge points / component interactions / dual-state distribution | Required reading before understanding the system (station 4 of the main line) |
| maintainers/RELEASING.md (maintainer-internal, not distributed in the public snapshot) | **Maintainer operations manual** — pre-commit/pre-release triage, manual acceptance assertions, automated E2E timing, pitfall quick reference | Maintainers, **for every commit/release** (read the tutorial once, use this every time) |
| [STATUS.md](../../../STATUS.md) | Current status snapshot — version / health / what's in progress / outstanding debt | To know what the project looks like right now (the only document allowed to be stale) |
| the todo/ directory (internal) | Live todo cards + technical debt register (one card per file; the filename carries the state) | Pick tasks and scan open cards before taking over work |
| [TRACEABILITY.md](../../../TRACEABILITY.md) | Five-layer anchor traceability cards (concept → design → code → test) | Search anchors when tracing a feature's full-chain landing points |
| [audits/](../../../audits/) + [scripts/audit/](../../../scripts/audit/) | **Audit toolchain** — anchor-audit (anchor-chain semantic audit spec, three blocks: scan machine check / semantic audit / repair) + test-coverage-audit + scan.py/cross_compare.py | Maintainers, run the semantic audit before milestones/releases (release gate ④a checks its artifacts) |
| [CLAUDE.md](../../../CLAUDE.md) | Agent engineering conventions (implementation chain discipline, machine-check entry points) | The rules for agents before starting work |

## Further reading

- The getting-started demos ship with the npm package (coffee-week first run → data-quality → doc-review + their demo data + GETTING-STARTED); the project repo's `examples/` — full end-to-end exemplars.
- HopSpec v3 syntax and execution semantics: [Core Specification](../../../docs/concepts/HopSpec V3核心规范.md) · [Syntax Reference](../../../docs/concepts/HopSpec V3语法参考.md) · [Companion Runtime Capabilities](../../../docs/concepts/HopSpec V3配套HopJIT运行时能力.md).

## License

MPL-2.0 (Mozilla Public License 2.0) — file-level copyleft: if you modify a source file of this project you must release that file under the same license, but it may be combined with closed-source code and used commercially. Full text in [LICENSE](../../../LICENSE).
