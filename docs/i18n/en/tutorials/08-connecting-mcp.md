%% @trace
	id: hopjit-tutorial-mcp-tools-en
	source: [[../../../tutorials/08-接入MCP服务]]
	source_id: hopjit-tutorial-mcp-tools
	type: translation
	last_sync: 2026-08-15T12:55+0800
	note: English translation of 08-接入MCP服务. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# Tutorial 8 · Connecting MCP Services: Letting a Spec Call Outside Tools

**Goal**: register an MCP service (a cloud API or a local server) as a tool your spec can call by name — search, knowledge bases, any ready-made MCP capability in the ecosystem.
**Prerequisites**: complete [[D10-hop-python-compute]] (the syntax for calling tools inside a body is covered there); use standalone mode (`USAGE.md` §6 — external tool registration currently goes through the standalone configuration surface).

## The mechanism in one minute

The spec's body contains only the **tool name**:

```markdown
1. [act] Retrieve materials
  - ← topic
  + → pages: [yaml]
  > ```hop_python
  > pages = web_search(query: topic)
  > ```
```

Who `web_search` is, how to connect, where the credentials live — **all of that sits in the environment configuration**; the spec knows nothing about it. This is deliberate design: a tool's signature is an intrinsic property of the tool; writing it into a spec means one copy per spec, which is guaranteed to drift. Register once, and every spec uses it by name.

## Registration: the two common shapes of the config file's `tool_servers:` section

Tool registration is just a `tool_servers:` section in a config file — written either in the **project-level `<project root>/hopjit.yaml`** (travels with the project, can go into the repo; recommended) or in the system-level `~/.hopjit/config.yaml` (tools shared across all projects). Both work; the two levels are unioned (all configuration fields and the two-level merge rules are in `docs/i18n/en/reference/configuration.md`).

**Shape 1: a cloud MCP service** (e.g. Alibaba Bailian's WebSearch — the process is in someone else's hands; you only manage the connection):

```yaml
tool_servers:
  - name: bailian_search            # logical server name (for log bookkeeping)
    binding:
      kind: mcp
      transport: http
      url: "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp"
      auth_env: DASHSCOPE_API_KEY   # environment variable name — the file contains no secrets
    tools:                          # whitelist: declared means enabled; undeclared tools never enter the engine
      - name: bailian_web_search
        tool_id: web_search         # call name used in the body — globally unique (omit when the original name is already legal)
        requires_commit: false
        output_schema:              # output shape (HopSpec type vocabulary)
          pages: [yaml]
        unwrap: json-in-text        # response unwrapping directive (explained below)
```

> **What `unwrap` is**: the MCP protocol specifies that tools return "content blocks" (text/image, etc.), and many providers (all four of the Bailian-family services do this) return the real structured result **as a JSON string stuffed inside a text block** — what the engine receives is a piece of "text that looks like JSON"; without unwrapping it, the engine can neither validate against `output_schema` nor let the body take fields like `pages[0]`. `unwrap: json-in-text` tells the engine: take the first text block and `JSON.parse` it; the parsed object is the real result. **The default is no unwrapping** (no need to write it when the server returns structured content directly); a parse failure is treated as a "shape deviation" (enters the adaptive ladder; the raw text goes into the failure record). How do you know whether to write it? Run once and look at the raw response in the failure record — if the content is an escaped JSON string, add this line.

**Shape 2: a local MCP server** (stdio — the engine starts the child process for you and reaps it when the run ends):

```yaml
  - name: hopkb
    binding:
      kind: mcp
      transport: stdio
      command: hopkb-mcp            # launch command (reachable on PATH or an absolute path)
      args: ["--kb", "./kb"]
      env_passthrough: [HOPKB_HOME] # whitelisted environment passthrough — never leak the whole environment
    tools:
      - name: kb_search
        requires_commit: false
        output_schema:
          hits: [yaml]
      - name: kb_write
        requires_commit: true       # out-of-box write operation — calling from act is rejected outright; commit steps only
```

## While you're at it: the "path parameters" a spec needs go in the env: section

Some specs reference material on your machine (knowledge bases, criteria documents); their description lists which `hop_env_*` parameters they need. Same config file as the tool registration — just add an `env:` section:

```yaml
env:
  hop_env_kb_root: ~/vaults/判据库   # [[{hop_env_kb_root}/入库判据#完备性]] in the spec resolves to here
```

Once filled in, the material can be found no matter which directory you launch from — you never need to care "which directory am I running from". The three hard rules (read-only / no credentials / undefined means error) and the override chain are in section 2b of `docs/i18n/en/reference/configuration.md`.

## Six rules you should know (all there to protect you)

1. **Whitelist semantics**: it doesn't matter that the server says it has 20 tools — the engine only admits the ones you declared. The server's tool surface is not endorsed wholesale;
2. **Call names are globally unique**: `tool_id` (falls back to `name` when unset) must not collide within **all registered tools + built-in tools (read/write, etc.)** — two servers both want to be called `search`? Give at least one a distinguishing `tool_id`. A conflict is never silently overridden or shadowed — **startup is refused** with the conflicting name and both sources reported. Better to fail to install than to call the wrong one;
3. **Credentials never touch disk**: `auth_env` holds only the environment variable **name**; the key lives only in the environment and in memory, forever;
4. **The authority for `requires_commit` is your declaration side** — servers' self-reports are not trusted (in practice they mislabel it). A tool marked `true` is rejected outright when called in an act step; only commit steps let it through (Tutorial 03's gatekeeping semantics extended to external tools);
5. **Execution sovereignty is one-way**: the engine calls tools; a tool can never influence the engine's execution flow in reverse (no subscriptions, no callbacks) — connecting a third-party server won't let it "move into" your execution;
6. **A fault is just a step failure — no new channel**: the server won't start, times out (default per-call hard gate of 60 seconds), returns garbage — all of it simply equals that step failing, following the retry/escalation chain you already know (the D4 set). A hung server can't hang your step to death. The raw error text goes into the failure record — for example, Bailian's "service not activated" 404 message is carried out verbatim, with a hint to activate it in the MCP marketplace.

## What a run feels like

After registering, `start_run` your spec as usual: the engine only connects to the server on the first call to that tool (lazy); call results are validated against `output_schema` before entering the variable space (wrong shape = deviation into the adaptive ladder, with the raw payload kept in the failure record for replanning to consult); when the run reaches a terminal state, local servers are shut down politely (three-stage EOF→SIGTERM→SIGKILL) — you never manage processes.

## Common problems

| Symptom | What to do |
|---|---|
| A call reports a "not activated"-style 404 | Cloud services must first be activated one by one in the provider's console (the failure record contains the original text and a hint) |
| A tool name conflict refuses startup | Give `tool_id` a different language-surface name (colliding with built-in tools like `read`/`write` is refused the same way) |
| The server reports more tools than declared | Normal — anything outside the whitelist is not admitted; a declared tool missing from the server's live list triggers a warn (declaration drifted from reality) |
| Want to see what was called and what came back | Every tool call is on record in HopLog (developers dig deeper in [[D6-diagnosing-with-hoplog]]) |

## Next steps

- Want to **write your own** tool (rather than connect an existing service): developer guide [[D7-building-your-own-tools]];
- The authoritative registration grammar (all fields / validation rules / the third, in-process shape): the tool-surface chapter of `docs/i18n/en/reference/configuration.md`.
