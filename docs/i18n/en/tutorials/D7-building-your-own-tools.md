%% @trace
	id: hopjit-tutorial-dev-tool-authoring-en
	source: [[../../../tutorials/D7-开发自己的工具]]
	source_id: hopjit-tutorial-dev-tool-authoring
	type: translation
	last_sync: 2026-08-15T13:48+0800
	note: English translation of D7-开发自己的工具. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D6 · Building Your Own Tools: Adding Capabilities to the Engine

**Who this is for**: developers who want to add a spec-callable tool to HopJIT — domain computation, private-system integration, any capability the built-in tools (read/write etc.) don't cover.
**Prerequisites**: user tutorial [[08-connecting-mcp]] (the registration and calling surface lives there — this one covers **how to build** the thing you register).
**Authority**: registration grammar (what the user writes) in `docs/i18n/en/reference/configuration.md`; binding implementation contracts in `docs/design/tool-interface.md`.

## Choose your route first: two binding tiers

| | **in-process extension module** | **MCP server** |
|---|---|---|
| Form | One JS module, loaded into the engine process | Independent process/service, communicating over the MCP protocol |
| Performance | Function call, zero serialization | Every call goes through a protocol layer |
| Isolation | **None** — it crashes = the engine crashes | Process isolation; a crash is just that one call failing |
| State | No lifecycle (pure functions are best) | Can hold state (connection pools, caches, sessions) |
| Language | JS/TS | Any (MCP SDKs cover the mainstream languages) |
| Suited for | Lightweight deterministic computation, domain logic with no external dependencies | Stateful services, heavy dependencies, non-JS implementations, things meant to be reused by many parties |

**Selection in one sentence**: pure-functional light computation goes in-process (fast, simple); anything stateful, needing isolation, or that is already a service goes MCP. When unsure, pick MCP — isolation is always the safer default.

## Route one: in-process module (up and running in five minutes)

**The interface contract is just two exports** (`^anc-exec-inprocess-binding`): `execute(name, args)` required, `close()` optional. The reference example `examples/ext-tools/word-stats.mjs` is a template in its entirety:

```js
// A file in your own repository — it does not enter the engine repo (the engine stays domain-agnostic)
export function execute(name, args) {
  if (name === 'word_stats') {
    const text = String(args.text ?? '');
    const words = text.split(/\s+/).filter(Boolean);
    return {
      result: { words: words.length, chars: text.length },
      success: true,
      content_type: 'json',
    };
  }
  return { result: `unknown tool: ${name}`, success: false, content_type: 'text' };
}

export function close() { /* only needs implementing if you have resources to release */ }
```

Three fields in the return value: `result` (string or structured object), `success`, `content_type` (text/json). **An exception thrown inside the module will not blow up the engine** — the engine catches it and reports `EXT_TOOL_ERROR`; that one call fails and enters the escalation chain. But this is a safety net, not a license: your duty is to handle foreseeable errors inside the module.

**Registration** (the third shape of the config file's `tool_servers:` section — usually written in the project-level `hopjit.yaml`):

```yaml
tool_servers:
  - name: word_stats_lib
    binding:
      kind: in-process
      module: ./ext-tools/word-stats.mjs   # relative to the directory of the declaring config file
    tools:
      - name: word_stats
        requires_commit: false
        input_schema:            # in-process has no discovery source — the declaration is the sole origin-side validation source
          type: object
          properties:
            text:
              type: string
          required: [text]
        output_schema:
          words: int
          chars: int
```

**The in-process responsibility charter** (loading = your assertion of the three points below):

1. **Audit status**: it runs inside the engine process, and the engine's machine checks cannot check your library — **declaring the load = the operator's assertion of that module's audit status; the responsibility travels with the declaration**. Your tool library lives in its own repository and follows its own repository's engineering chain (not a single line enters the engine repo);
2. **Mark irreversible operations truthfully with `requires_commit: true`** — this is the sole basis for act interception; mislabeling it means bypassing the entire explore/commit separation (Tutorial 03);
3. **Schemas, truthfully**: in-process has no tools/list discovery — the `input_schema` you declare is the entirety of origin-side validation. No declaration = the origin waves everything through (validation responsibility slides into the inside of your module).

## Route two: MCP server

Write a server with any language's MCP SDK (stdio or Streamable HTTP); implementing `initialize` + `tools/list` + `tools/call` is enough — **the engine consumes only this minimal subset**; session-oriented capabilities (subscriptions/callbacks/sampling) will go unheard even if you write them: one-way execution sovereignty is a hard property.

Points to note when targeting HopJIT (the rest is the same as Tutorial 08's registration surface):

- **Write `tools/list` seriously**: tools without an `input_schema` declared on the registration side are backfilled from your tools/list — your schema is the origin-side validation source;
- **annotations are not trusted**: the authority for `requires_commit` is the user's declaration side — what you mark doesn't matter; what the user declares is what counts. So **write down clearly** in your documentation which tools have side effects, so users can declare correctly;
- **Write error messages in plain language**: the raw response text of a failed call goes into the FailRecord and is consumed by replan — a bare "internal error" helps no one; error messages with context are your tool's contribution to the repair ladder;
- **A hard 60-second gate per call** (users can override it per server): for long operations, either paginate internally or tell users in your docs to adjust `call_timeout_ms`;
- **stdio servers need not manage lifecycle**: the engine spawns you and, at run's final state, performs a three-stage polite shutdown (EOF→SIGTERM→SIGKILL) — all you need is to respond to EOF correctly and exit.

This repo's own `hopjit-mcp` (standalone server, see [[D4-architecture-walkthrough]]) is a complete instance of this route — four tools, annotations complete, errors structured.

## Testing your tool

- **in-process**: the module is pure JS — unit-test it directly (following `word-stats`'s usage: normal input / unknown tool name returns `success: false` / on a thrown exception the engine reports EXT_TOOL_ERROR and the process survives — the last one is the engine's positive/negative pair; you test the first two);
- **MCP server**: first, detached from the engine, verify the initialize/tools/list/tools/call trio with MCP Inspector or hand-rolled JSON-RPC; then attach the engine, run a spec that calls it, and read the HopLog (every call's ins and outs are on record — [[D6-diagnosing-with-hoplog]]);
- **End to end** (D2's two legs, in their tool-shaped form): write a minimal spec that really calls your tool and runs to completed — "it works when installed in the real engine" can only be proven by this step.

## Next steps

- The user-facing side of registration and calling: [[08-connecting-mcp]];
- All contract details (two-end validation / lifecycle master diagram / CompositeToolProvider assembly): `docs/design/tool-interface.md`;
- How tool-call failures enter the repair ladder: [[D5-errors-and-failure-handling]].
