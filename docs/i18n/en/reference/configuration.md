%% @trace
	id: hopjit-reference-config-en
	source: [[../../../reference/配置参考]]
	source_id: hopjit-reference-config
	type: translation
	last_sync: 2026-08-15T12:55+0800
	note: English translation of 配置参考. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# HopJIT Configuration Reference

> **Nature of this document**: **the authoritative document for the outward-facing configuration contract** (author's ruling, 2026-08-13 — authority over outward contracts belongs to outward-facing docs; design docs govern the implementation). Every field, grammar, and semantic a user writes into a configuration file is governed by this document; the implementation-behavior contracts for loading/merging/validation live in the design docs ([[../../../design/shared-providers]]/[[../../../design/tool-interface]]). For onboarding guidance, see the tutorial series. ^anc-ref-config-contract

## 0. Configuration map: what lives where

**One schema, two scopes** + two in-spec configuration slots:

```
~/.hopjit/config.yaml      ← system level, travels with the person (one per machine; providers/credential references usually live here)
<project root>/hopjit.yaml ← project level, travels with the project (can go in the repo; optional — the tool surface usually lives here)
    Both files share one schema (all four sections providers/default_model/routing_rules/tool_servers optional)
    Merged section by section, project level wins: providers keyed by service_id, routing_rules keyed by step_type override same keys;
    tool_servers are unioned (tool names deduplicated across levels; a duplicate name refuses startup)

Inside a spec file:
  Config: section            ← spec level, travels with the spec — this spec's model tiering / retry depth
  step > @model annotation   ← step level — single-step model override
```

**Why one schema but two files**: the system level holds "who you are, which backends you use" (unchanged across projects); the project level holds "which tools and which tiering differences this project needs" (goes into the repo with the project). A project-level file may contain only the tool_servers section — providers are inherited from the system level. The `module:` relative path of an in-process extension module is resolved against the **directory of the config file that declares it** (a project-level declaration resolves relative to the project root).

**Every layer is optional**: everything runs with no configuration at all (reuse mode is zero-config; standalone mode's minimal configuration = one provider). Tiering is an optimization, not an obligation.

## 1. Backend services and credentials (config.yaml: providers)

The backend declaration for standalone mode. **The file never stores a key** — credentials are written only as environment variable names.

```yaml
providers:
  - service_id: deepseek        # routing identifier (alphanumeric and underscore; default is reserved)
    protocol: anthropic         # wire protocol, see table below
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash        # this provider's default model
    api_key_env: DEEPSEEK_API_KEY   # environment variable name — the only legal credential form
```

| Field | Required | Description |
|---|---|---|
| `service_id` | ✓ | Globally unique (case-normalized for dedup); the first half of a `service/model` reference |
| `protocol` | ✓ | Wire payload format: `anthropic` = Anthropic Messages API compatible; `openai-chat` = OpenAI chat/completions compatible; `openai-responses` = Responses API (**reserved, not implemented** — choosing it errors at startup and points you to openai-chat). openai-chat currently does not support the body-less act tool loop |
| `base_url` | ✓ | API endpoint |
| `model` | ✓ | This provider's default model |
| `api_key_env` | ✓ | Environment variable name reference; a plaintext key in the file is refused at startup |

The first provider is the global default backend.

## 2. Model configuration (three layers, one topic)

Model selection is one topic served by three cooperating configuration slots — **the system layer sets the environment's tier table, the spec layer writes only the differences it cares about, and the step layer does single-point overrides**.

### System-layer tiering: config.yaml `routing_rules` (optional)

```yaml
routing_rules:
  - step_type: act        # execution class (includes commit unless a separate commit entry is written) — lightweight tier
    model: deepseek/deepseek-v4-flash
  - step_type: reason     # reasoning — mid-strong tier
    model: deepseek/deepseek-v4-pro
  - step_type: check      # verification — best to switch vendors (cross-validation against same-source blind spots)
    model: bailian/qwen3.7-plus
  - step_type: replan     # replanning = metaprogramming, must be able to write HopSpec — strongest tier
    model: zhipu/glm-5.2
```

- `step_type` enum: `act` / `commit` / `reason` / `check` / `replan` (confirm/ask are intervention points with no LLM and cannot be routed);
- `commit` without its own entry uses the `act` entry (execution class shares a tier).

There is also `default_model:` (optional) — the system-level default model, `service/model` or a bare model name; the referenced service must exist in providers (a typo refuses startup).

### Spec-layer tiering: the `Config:` section

The `Config:` section sits at the head of a spec (after `Id:`/`Goal:`, before `## Inputs`). **The Config section is just a HopSchema field** — entries use `-` items at both outer and inner levels, the same style as Inputs/Outputs (one item-marking mental model across the whole spec). It currently supports two keys, both about models:

```markdown
# Spec: 订单风险审查
Id: order-risk-review
Goal: 审查订单清单,产出风险分级报告

Config:
- models:                             # per-category tiering — inherits the system layer category by category; write only the differences you care about
  - reason: deepseek/deepseek-v4-pro  # this spec's reasoning tier
  - replan: zhipu/glm-5.2             # replan tier (falls to the system tiering when the environment has no zhipu, see preference semantics)
- model: deepseek/deepseek-v4-flash   # single default — categories missing from models fall here (may be omitted; then falls to the system layer)

## Inputs
- orders: yaml  # 订单清单

## Outputs
- report: markdown  # 风险分级报告
...
```

| Key | Description |
|---|---|
| `models` | Category → model mapping. Categories = `act` (includes commit; write a separate `commit:` key to split) / `reason` / `check` / `replan`. **Key-by-key inheritance**: write only the differences you care about; unwritten categories fall to the `model` single default, then to the system layer's routing_rules — it is not a whole-block override |
| `model` | Single default — shorthand for the same value across all categories; `models` category keys take priority over it |

Both keys may be omitted — omit both and the whole spec uses the system-layer configuration.

**Preference semantics (spec-side references never blow up)**: a model reference written in a spec is a **preference** — if the environment has that service, it is used; if not, a warn is left in the execution log and this level is skipped, continuing down the priority chain (`models` key → `model` single default → system tiering → system default → built-in default), **until some level hits — the chain always ends in a default, there is always a home, no error is raised**. Specs are thereby portable by nature: a spec that wrote `zhipu/glm-5.2` runs as usual in an environment without Zhipu. System-layer configuration (providers/routing_rules/default_model) does not get preference semantics — its checks are completed at load time: a referenced service must exist in the same file's providers, and a mismatch refuses startup outright (inconsistency within your own file is a typo, not an environment difference).

### Step-layer override: the `@model` annotation

```markdown
2. [reason] 分析舆情风险
  > @model deepseek/deepseek-v4-pro
  > 综合各渠道数据评估风险等级
```

Single-step override, highest priority. Valid only on executable steps (reason/act/check/commit).

### Resolution priority (the full chain)

From specific to general; the first hit wins:

```
1. step @model annotation
2. spec Config.models[category]    ← category = act (incl. commit)/reason/check/replan
3. spec Config.model (single default)
4. system routing_rules[category]  ← commit without its own entry uses the act entry
5. system default_model
6. environment variable ANTHROPIC_MODEL   ← host environment inheritance — only Anthropic-family hosts (CC) set it;
                                Codex's model configuration lives in ~/.codex/config.toml (model= key), not exposed via env; this level is empty there
7. host HostConfig.model      ← injected by host code when the engine is embedded as a library — individual users never touch it
8. built-in default
```

> Levels 1-5 are what you configure; levels 6-7 are the "when you don't configure, the engine picks up from the runtime environment" fallback, usually of no concern: in reuse mode the engine makes no LLM calls so they never apply; standalone always has a config.yaml, so level 5 hits. **Under a Codex host, the proper way to configure the engine's model is config.yaml — there is no env shortcut.**

## 2b. Spec environment parameters (the env: section) ^anc-ref-hop-env

**Environment configuration parameters** referenced inside specs (material library paths, knowledge base locations, and other non-secret values) — uniformly prefixed `hop_env_`, written in the config file's `env:` section:

```yaml
# system-level ~/.hopjit/config.yaml or project-level <project root>/hopjit.yaml (merged key by key, project level wins)
env:
  hop_env_kb_root: ~/vaults/判据库        # full name goes in the config — what you write is what gets referenced
  hop_env_brand_root: ~/vaults/办公生产力
```

**Override chain** (later overrides earlier, key by key, not whole-block — same mental model as Config.models inheritance):

```
system-level env: section → project-level env: section → passed via start_run/params → ask a human inside the spec
```

**How a spec uses it**: reference it directly in a doc-ref path slot — `[[{hop_env_kb_root}/入库判据#完备性]]`; inside a hop_python body it is available as a read-only variable. A spec should list which hop_env parameters it needs in its description — you fill in the paths in the env: section per that list, and **never need to care "which directory am I launching from"**.

**Three hard rules**:
| Rule | Description |
|---|---|
| Read-only | A spec cannot modify hop_env_* values (a `+ →` product with this prefix = validation error); ask-a-human filling a value is the last link of the override chain and is legal |
| No credentials | Keys/tokens are **strictly forbidden** in the env: section — hop_env_* lands on disk in logs; credentials go only through `api_key_env` (environment variable name reference, never on disk) |
| Undefined means error | A spec referencing a key absent from the env: section → that step errors loudly (no silently concatenating an empty path and finding the wrong file) |

The language-semantics authority is the core spec `^anc-config-hop-env`; doc-ref expansion details (escaping, etc.) are in the syntax reference.

## 3. Tool-surface configuration (the tool_servers section)

Write a `tool_servers:` section directly in a config file (usually the project-level `hopjit.yaml`):

```yaml
tool_servers:
  - name: hopkb
    binding:
      kind: mcp
      transport: stdio
      command: hopkb-mcp
    tools:
      - name: kb_search
        requires_commit: false
```

The three binding shapes and field semantics: ^anc-ref-tool-servers

| binding.kind | Additional fields | Description |
|---|---|---|
| \`mcp\` + \`transport: http\` | \`url\`, \`auth_env\` (environment variable name) | Cloud MCP service |
| \`mcp\` + \`transport: stdio\` | \`command\`, \`args\`, \`env_passthrough\` (whitelisted passthrough) | Local MCP child process (engine-supervised start/stop) |
| \`in-process\` | \`module\` (module path, relative to the directory of the declaring config file) | Isolated tool library loaded into the engine process |

Server-level optional \`call_timeout_ms\` (per-call hard gate, default 60000). Each tool entry: \`name\` (wire name, Chinese allowed), \`tool_id\` (body call name, required when name is not a legal identifier), \`requires_commit\` (required — irreversibility marker, blocked in act / allowed in commit), \`input_schema\` (JSON Schema; may be omitted for mcp, completed from discovery), \`output_schema\` (HopSchema — field name → type, only the top level is checked), \`unwrap: json-in-text\` (response unwrapping).

**Whitelist semantics**: declared means enabled — a server reporting N tools only gets the declared ones admitted. Implementation behavior (assembly / two-sided validation / lifecycle) is in [[../../../design/tool-interface#^anc-config-tool-registry]]; guided introduction in Tutorial 08.

## 4. Full example (both levels, all fields) ^anc-ref-config-full-example

**System-level `~/.hopjit/config.yaml`** (travels with the person — backends, credential references, the environment's tiering):

```yaml
# Backend services (at least 1; the first is the default backend. Keys never enter the file — only environment variable names)
providers:
  - service_id: deepseek              # routing identifier, first half of a service/model reference
    protocol: anthropic               # deepseek natively supports the Anthropic Messages format
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    api_key_env: DEEPSEEK_API_KEY
  - service_id: bailian
    protocol: openai-chat             # Bailian's OpenAI-compatible endpoint goes through chat/completions
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen3.7-plus
    api_key_env: DASHSCOPE_API_KEY
  - service_id: zhipu                 # Zhipu GLM obtained via Bailian (same endpoint, same key — Bailian proxies multiple vendors' models;
    protocol: openai-chat             # a separate service entry keeps the zhipu/glm-5.2 reference semantics clear)
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: glm-5.2
    api_key_env: DASHSCOPE_API_KEY
  - service_id: anthropic
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-6
    api_key_env: ANTHROPIC_API_KEY

# System default model (optional; if unset, the first provider's model is used)
default_model: deepseek/deepseek-v4-flash

# System-level model tiering (optional — the environment's tier table; categories a spec doesn't configure inherit from here)
routing_rules:
  - step_type: act                    # execution class (includes commit; write a commit entry to tier it separately) — lightweight tier
    model: deepseek/deepseek-v4-flash
  - step_type: reason                 # reasoning — mid-strong tier
    model: deepseek/deepseek-v4-pro
  - step_type: check                  # verification — switch vendors for cross-validation (deepseek as workhorse, verification via qwen)
    model: bailian/qwen3.7-plus
  - step_type: replan                 # replanning = metaprogramming, must be able to write HopSpec — strongest tier
    model: zhipu/glm-5.2

# System-level shared tools (optional — tools every project needs go here; project-specific tools go project-level)
tool_servers:
  - name: bailian_search
    binding:
      kind: mcp
      transport: http
      url: https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp
      auth_env: DASHSCOPE_API_KEY
    tools:
      - name: bailian_web_search
        tool_id: web_search           # body call name (may be omitted when name is already a legal identifier)
        requires_commit: false
        output_schema:                # HopSchema: field name → type, only the top level is checked
          pages: [yaml]
        unwrap: json-in-text          # Bailian-family convention: JSON stuffed inside a text block
```

**Project-level `<project root>/hopjit.yaml`** (travels with the project, can go in the repo — write only the differences; everything else inherits section by section from the system level):

```yaml
# This project's tiering differences (optional — only reason is overridden; act/check/replan use the system level as-is)
routing_rules:
  - step_type: reason
    model: anthropic/claude-opus-5    # this project's reasoning workload is heavy, reason is over-provisioned to the strongest tier

# This project's tool surface (unioned with the system level; a tool name duplicated across levels refuses startup)
tool_servers:
  - name: hopkb                       # local MCP child process (engine-supervised start/stop)
    binding:
      kind: mcp
      transport: stdio
      command: hopkb-mcp              # reachable on PATH or an absolute path
      args: ["--kb", "./kb"]
      env_passthrough: [HOPKB_HOME]   # whitelisted passthrough — never leak the whole environment
    call_timeout_ms: 120000           # optional: this server's per-call hard gate (default 60000)
    tools:
      - name: kb_search
        requires_commit: false
        input_schema:                 # JSON Schema (may be omitted for mcp — completed via tools/list discovery)
          type: object
          properties:
            query:
              type: string
          required: [query]
        output_schema:
          hits: [yaml]
      - name: kb_write                # out-of-box write operation — calling within act is rejected; commit steps only
        requires_commit: true
  - name: word_stats_lib              # in-process extension module (isolated tool library loaded into the engine process)
    binding:
      kind: in-process
      module: ./ext-tools/word-stats.mjs   # resolved relative to this file (project root)
    tools:
      - name: word_stats
        requires_commit: false
        output_schema:
          words: int
          chars: int
```


## 5. Common recipes

**One cheap model for everything** (simplest — no tiering configured at all):
```yaml
providers:
  - service_id: ds
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-v4-flash
    api_key_env: DEEPSEEK_API_KEY
```

**Strong model for replanning only** (in the spec — the zhipu entry is in the full example's providers):
```markdown
Config:
- models:
  - replan: zhipu/glm-5.2
```

**Switch vendors for check as cross-validation** (system layer):
```yaml
routing_rules:
  - step_type: check
    model: bailian/qwen3.7-plus   # when deepseek is the workhorse, verify with another vendor against same-source blind spots
```

---

**Implementation contract pointers** (this document governs the outward grammar; the following govern implementation behavior): loading / two-level merging / validation = [[../../../design/shared-providers#^anc-config-standalone-schema]]; tool assembly / two-sided validation / lifecycle = [[../../../design/tool-interface#^anc-config-tool-registry]]; model resolution chain implementation = [[../../../design/step-dispatcher#^anc-exec-model-resolve]]. The authority for in-spec configuration slots (Config.models/@model) = [[../../../concepts/HopSpec V3核心规范#^anc-config-models-tier]].
