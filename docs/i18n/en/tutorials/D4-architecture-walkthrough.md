%% @trace
	id: hopjit-tutorial-dev-architecture-en
	source: [[../../../tutorials/D4-架构讲解]]
	source_id: hopjit-tutorial-dev-architecture
	type: translation
	last_sync: 2026-08-15T13:43+0800
	note: English translation of D4-架构讲解. Consistency direction: translation follows the Chinese source; report source errors, do not fix silently.
%%

# D3 · Architecture Walkthrough: Why the Engine Looks the Way It Does

**Who this is for**: people who have read [[D1-engineering-with-ai-concept-to-design]] / [[D2-engineering-with-ai-coding-and-acceptance]] and want to hand AI **architecture-level** work (cross-module changes, adding an adapter layer, touching the Provider boundary).
**Relationship to the authoritative document**: `ARCHITECTURE.md` is the authority on architectural facts (the shared root for humans and AI); this piece is its **teaching narrative** — reordered around "why", to help you build the big picture needed to make architectural decisions. For details, the authoritative document prevails.

## The Architecture in One Sentence

**One mode-agnostic execution engine core, wrapped in two adapter shells that differ in "who produces the reasoning".**

```
                    ┌───────────────────────────────────┐
                    │      Engine core (pure logic)     │
                    │  SpecParser       parse+validate  │
                    │  ExecutionEngine  state machine   │
                    │  PromptAssembler  context assembly│
                    │  BodyInterpreter  hop_python      │
                    └──────┬───────────────┬────────────┘
              Provider interfaces    Provider interfaces
                    ┌──────┴──────────┐  ┌────┴───────────┐
                    │ Reuse-mode      │  │ Standalone-mode│
                    │ adapter         │  │ adapter        │
                    │ HopCLI          │  │ StepDispatcher │
                    │ File persistence│  │ MCP server     │
                    └──────┬──────────┘  └────┬───────────┘
                    ┌──────┴──────────┐  ┌────┴───────────┐
                    │ Carrier (driver)│  │ LLM API        │
                    │ CC / Codex      │  │ (deepseek etc.)│
                    └─────────────────┘  └────────────────┘
```

## Why It Splits This Way: Three Decisive "Becauses"

**① Because reasoning can happen in two places.** The user tutorials covered the trade-off between the two modes (reuse = the conversation LLM serves as the reasoning engine, zero configuration; standalone = the engine calls the API directly, saving cost and staying out of the conversation). Architecturally this means: **the engine core must never assume "where the reasoning is"** — it only produces "what to do next + the full context" (NextResponse); who does the reasoning is the adapter layer's business. This is the "mode-agnostic" principle: the three engine-core components behave identically in both modes.

**② Because carriers will keep multiplying.** CC, Codex, OpenCode in the future — every carrier has different primitives (CC has the Agent tool and AskUserQuestion; Codex has its own subagents and conversational Q&A). If the engine accommodated any one carrier, every new carrier would mean changing the engine. So **the engine and CLI are carrier-neutral** (pure JSON in/out, no assumptions about tool-execution capabilities), and each carrier only needs one equivalent set of **driver instructions** (side by side under `driver/`) — adding a carrier means zero engine changes. The discipline is "same semantics, per-carrier implementation": the invocation primitives may differ, but the step semantics must not drift (guarded by the machine check `check-driver-carriers`).

**③ Because the outside world must be replaceable.** File system, network, LLM APIs, knowledge bases — the engine core **never touches any of them directly**; everything goes through four Provider interfaces:

| Interface | What it governs | Implementation each mode supplies |
|---|---|---|
| PersistenceProvider | State snapshot storage/retrieval | Reuse = FilePersistence (persisted to `.hopstate/` across processes); standalone = MemoryPersistence (in-process) |
| ToolProvider | Tool execution for act steps | Standalone = DefaultToolProvider (Read/Write + sandbox); reuse = the carrier's tool surface |
| KnowledgeProvider | L2 knowledge injection | Host-injected (RAG/vector store) |
| IdentityProvider | Credentials | Host-injected or default implementation |

The one deliberate exception: HopLog execution logs are written straight to disk without going through a Provider — trace reconstructability is a principle shared by both modes; logging is an intrinsic responsibility, not environment adaptation.

## The Lifeline of One Execution (Reuse Mode)

Translating the "run a spec" experience from the user tutorials into the architectural view:

```
/hopspec run spec.md
  → carrier driver spawns a subagent running the hopjit CLI
  → SpecParser parses and validates → Engine initializes (FilePersistence writes to disk)
  → loop: Engine.next_step produces a NextResponse (6-layer context)
      ├ reason/check → carrier LLM reasons, result submitted back to the engine
      ├ act (with body) → BodyInterpreter executes deterministically, zero LLM
      ├ confirm/ask  → paused, stops for a real human
      └ parallel     → dispatch_ready dispatch signal, each worker claims a child instance
  → completed, outputs delivered
```

Standalone mode follows the same lifeline, except "carrier LLM reasons" becomes "StepDispatcher calls the LLM API directly", persistence becomes MemoryPersistence, and the outward protocol shell becomes the MCP server (four tools: start_run/run_status/resume_run/list_runs). **Who reasons at each step, and where the state lives — those are the two coordinates for understanding any execution problem.**

## Dual-State Distribution: Where Is Code, Where Is Intelligence

HOP's dual-state fusion (the HopType system) lands in this repo as: **everything deterministic is TypeScript** (Parser/Engine/Assembler/BodyInterpreter/CLI/the Dispatcher scheduling shell — all pure code, fully coverable by tests); **reasoning intelligence exists at only two mouths** — in reuse mode on the carrier side (CC/Codex's LLM), in standalone mode inside StepDispatcher's LLM calls. When handing work to AI, this distribution is your sense of boundaries: changing a TS component = changing deterministic behavior (nail it down with positive/negative examples); changing driver instructions/prompt assembly = changing intelligence-side behavior (only live e2e reveals the truth — the two legs from D2 converge here).

## Three Cautions When Handing AI Architecture-Level Work

1. **Touching the Provider boundary = touching the contract surface**: the four interfaces are the entirety of the channels between the engine core and the outside world; adding a method or changing a signature ripples through every implementation in both modes — when assigning the work, explicitly require the AI to first list the blast radius across both sides' implementations;
2. **Adding a carrier does not change the engine**: the correct path for a new carrier is a new set of driver instructions under `driver/<carrier>/` plus alignment with existing design anchors — if the AI proposes to "tweak the engine a bit to accommodate the new carrier", be wary: that is most likely breaking carrier neutrality;
3. **Layer dependencies are one-way**: shared < core < adapter, and lower layers must not import higher ones (guarded by the machine check `check-layer-imports`) — if the AI's implementation needs "the engine core to import something from the adapter layer", the abstraction is in the wrong layer; send it back to design.

## Next Steps

- [[D5-errors-and-failure-handling]] — by what rules the engine handles failure after it happens (FailRecord / escalation chain / repair ladder / crossing call boundaries);
- Authority on architectural facts (layer bridge points / component interaction diagrams / string-escaping contract / full Provider signatures): `ARCHITECTURE.md`;
- Module-level view (the 14-module inventory and each module's chain): the "module index" in `Doctree.md`;
- Principles for module work (criteria / dependency direction / split triggers): `docs/design/module-principles.md`.
