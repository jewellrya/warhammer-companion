# How it works

The whole design comes down to being strict about who is allowed to know what.

- The **language model** interprets what you said and decides where to look
  things up. It never holds state and never supplies a fact.
- **Warhammer Oracle** owns Warhammer knowledge — datasheets, weapons,
  stratagems, keyword text, points.
- **Application code** owns the battle: which unit you meant, how many models
  are left, what a stratagem costs you right now.
- **SQLite** owns persistence, as an append-only log of events.

Everything below is a consequence of those four lines.

---

## The main pipeline

```
        "Deathshroud shoot those Intercessors."
                        │
       ┌────────────────▼─────────────────┐
       │ interpret                        │   pattern rules first,
       │   → Intent                       │   local model for the rest
       └────────────────┬─────────────────┘
                        │   { intent: "shoot",
                        │     attacker: { name: "Deathshroud" },
                        │     target:   { name: "Intercessors" } }
       ┌────────────────▼─────────────────┐
       │ resolve                          │   against live battle state,
       │   names → unit ids               │   + Oracle for datasheet facts
       └────────────────┬─────────────────┘
                        │   ambiguous? → ask, never guess
       ┌────────────────▼─────────────────┐
       │ GameEvent[]                      │   the only way state changes
       └────────────────┬─────────────────┘
       ┌────────────────▼─────────────────┐
       │ applyEvent(state, event)         │   pure, total, no I/O
       └────────────────┬─────────────────┘
                        ▼
              SQLite append-only log  →  UI
```

The split that matters is between *interpret* and *resolve*. Interpretation can
be wrong — it is a 7B model reading a half-sentence someone muttered over a
dice tray. So nothing it produces becomes state directly. Every intent passes
through zod validation, then entity resolution against the real battle, and only
then becomes an event. Once an event exists, it is fact.

---

## GameEvents

State is a left fold over the event log:

```ts
applyEvent(state: BattleState, event: GameEvent): BattleState
```

Pure and total — no clock, no randomness, no I/O. `replay(events)` is the only
constructor of a `BattleState`.

Making this the spine rather than an afterthought is what causes replay, undo,
correction, audit, AI debugging, and the Chronicle to all fall out of one
mechanism instead of five:

- **Undo** marks events `undone` and re-folds. Nothing is deleted, so the log
  stays a faithful record of what the player actually did.
- **Batching** groups the events from one utterance under a `batchId`, so undo
  peels off the whole action rather than a third of it.
- **Provenance** — every event carries `source` and the `rawInput` that caused
  it, which is how you debug a bad interpretation weeks later.
- **The Chronicle** is a fold over the same log. It cannot disagree with what
  happened, and a corrected event silently corrects the history too.

```jsonc
{
  "type": "damage_applied",
  "gameId": "…",
  "seq": 14,
  "targetUnitId": "…",
  "amount": 6,
  "source": "natural_language",
  "rawInput": "The Rhino takes six damage.",
  "batchId": "…"
}
```

Casualty arithmetic lives in the reducer, not the model. Damage spills across
models the way removal actually works — 3 damage into a 5-model unit at 2W each
kills one model and leaves 1W on the next.

---

## Resolution: ambiguity asks

Turning `"the terminators"` into a unit id is deliberately application code. The
model does not hold battle state and must not be the thing deciding whether you
meant one squad or the other.

Scoring is transparent — exact name beats prefix beats substring beats token
overlap — and the tie rule is strict:

```
> Deathshroud shoot those Terminators.
  Deathshroud Terminators or Blightlord Terminators?
```

Two guards worth knowing about, both learned from real misfires:

- A query made only of filler (`"the squad"`, `"that unit"`) scores zero rather
  than substring-matching whichever unit sorts first.
- Partial token matches need at least four characters in common. Without that
  floor, the `in` inside *Captain **in** Terminator Armour* tied with
  *Intercessor Squad* for the query "Intercessors".

---

## Rules questions: a retrieval loop, not a routing table

This part was rewritten once, and the reason is instructive.

The first version had a hand-written classifier — regexes mapping `"advanc"` to
the Movement phase, `"battle-shock"` to Command, and so on. It worked for the
rules I had personally thought of and nothing else. That is a lookup table
pretending to be understanding.

What runs now:

```
question
  → model plans lookups     {"lookups":[{"tool":"keyword","name":"Deep Strike"}]}
  → app executes them against Oracle
  → model drafts an answer AND reports {"sufficient": true|false}
  → if insufficient: widen (read every phase description) and draft once more
  → answer + citations
```

Choosing which reference to open is tool selection, which models are good at,
and it generalises to rules nobody wrote a rule for.

Two things keep it honest:

1. **Oracle answers "not found" cheaply.** A wrong plan is detected rather than
   believed. If every planned lookup misses, a generic cascade tries the other
   tools, then a free-text search.
2. **The model only chooses where to look.** The answer is written strictly from
   what Oracle returned, so a bad plan produces *"I couldn't find that"* — never
   an invention.

The sufficiency flag is what removes the need for a concept-to-phase map. Ask
*"what happens if a unit is battle-shocked?"* and no Oracle entry has that name
— the rule lives inside the Command phase text. The model reports the material
was insufficient, the app reads all five phase descriptions, and the second
draft answers correctly. Nobody had to write down that battle-shock lives in the
Command phase.

With no model available the cascade runs on its own over terms lifted from the
question. Less precise, still grounded.

---

## Where the language model is, and is not

| Job | Who does it |
|---|---|
| Understanding an utterance | model (with a pattern fast path) |
| Deciding which unit you meant | **app**, from battle state |
| Deciding which Oracle entry to open | model |
| Supplying a rule, statline, or points value | **Oracle**, never the model |
| Casualty and CP arithmetic | **app**, in the reducer |
| Writing an answer or battle report | model, from Oracle text only |

The pattern interpreter in `ai/rule-interpreter.ts` handles the phrasings that
dominate real play — `"the Rhino takes six damage"`, `"next phase"`, `"undo"`.
It runs first because it is faster and more reliable than a 7B model on the same
input, and it is what makes the app usable with no model installed at all.

Conversation history is never treated as authoritative state. The log is.

---

## Warhammer Oracle integration

Oracle sits behind one interface, so it can be replaced, supplemented with a
document library, or cached, without touching battle logic:

```ts
interface WarhammerDataProvider {
  getUnit(name, opts):        Promise<Sourced<UnitData> | null>
  searchUnits(query, opts):   Promise<Sourced<UnitSummary[]>>
  getStratagem(name, opts):   Promise<Sourced<StratagemData> | null>
  getKeyword(name, opts):     Promise<Sourced<KeywordData> | null>
  getPhase(name, opts):       Promise<Sourced<PhaseData> | null>
  getGameFlow(opts):          Promise<Sourced<GameFlowData>>
  calculateWounds(input):     Promise<Sourced<WoundCalcResult>>
  getDetachment(name, opts) / getEnhancement(name, opts)
}
```

Every result is `Sourced<T>` — the data plus a `SourceCitation` recording
provider, tool, edition, and the exact query. That citation is what the UI
prints under an answer.

Nothing Oracle owns is copied into our schema. Armies and collection entries
store an `OracleRef` (name, faction, edition, whether a lookup has ever
confirmed it) and look up the rest on demand. The single exception is
wounds-per-model, cached onto a unit at deploy time because the reducer needs it
synchronously to do casualty removal.

### Three things that will bite you

All handled in `packages/core/src/oracle/`, all found the hard way:

**It answers in markdown, not JSON.** Every tool returns a formatted document
meant for a chat window. `markdown.ts` parses datasheets, keyword entries,
stratagems, phases and wound tables back into structured data, keeping the raw
text for citation. Parsers degrade to null fields rather than throwing, because
Oracle's data is regenerated from BSData daily.

**`game_mode` is not one vocabulary.** It splits three ways, and sending the
wrong value is a hard schema rejection, not a fallback:

| Tools | Accepts |
|---|---|
| `lookup_unit`, `search_units`, `compare_units` | `40k_11e`, `40k_10e`, `combat_patrol`, `kill_team` |
| `lookup_keyword`, `lookup_phase`, `game_flow`, `wound_calculator` | `40k`, `combat_patrol`, `kill_team` — the edition split is rejected |
| `lookup_detachment`, `lookup_enhancement` | `40k_11e`, `40k_10e` only |
| `lookup_stratagem`, `search_stratagems`, `lookup_ploy`, … | no `game_mode` at all |

`gameModeFor(tool, edition)` maps per tool. The active edition is explicit in
`BattleState` and threaded into every call.

**Tool errors arrive as ordinary content with an `isError` flag.** They do not
throw. Without checking that flag, a rejected call gets parsed as though it were
data — which is exactly how the `game_mode` problem stayed hidden.

One more, at the data level: BSData copies a datasheet into every allied
faction's catalogue, so *Plague Marines* exists under Chaos Daemons, Chaos
Knights and Death Guard alike. Without a hint Oracle returns whichever sorts
first. The collection service breaks that tie using the factions you already
own — data we hold ourselves.

---

## Persistence

```
armies              reusable lists; units stored as OracleRefs
collection_items    physical models owned
battles             identity + a cached state snapshot
events              the source of truth for every battle
messages            conversation transcript
documents           supplemental rule imports (table exists; retrieval not built)
document_chunks     future embeddings
```

`events` is authoritative. The `snapshot` column on `battles` exists only so the
Home screen can list games without replaying every log — deleting it would lose
nothing. Migrations are numbered and run on open.

---

## Process layout

```
┌──────────────────────────────────────────────┐
│ Tauri shell (Rust)                           │
│   window + child-process lifecycle only      │
│   ┌────────────────────────────────────────┐ │
│   │ webview: React UI                      │ │
│   └───────────────┬────────────────────────┘ │
└───────────────────┼──────────────────────────┘
                    │ HTTP, 127.0.0.1:8787
┌───────────────────▼──────────────────────────┐
│ Node core (@wh/server + @wh/core)            │
│   domain · reducer · SQLite · services       │
└───────┬──────────────────────────┬───────────┘
        │ MCP over stdio           │ HTTP
┌───────▼──────────┐      ┌────────▼───────────┐
│ Warhammer Oracle │      │ Ollama             │
└──────────────────┘      └────────────────────┘
```

The Rust layer is deliberately thin: it owns the window and the lifetime of the
Node core, and nothing else. All domain logic lives in TypeScript so there is
one implementation of the rules rather than two, and the identical code path
runs in the browser and in the packaged app.

The core binds to loopback only.

### Layout

```
packages/core/
  domain/      types, GameEvent union, reducer, intents, resolution
  oracle/      WarhammerDataProvider, MCP client, markdown parsers
  ai/          LLMProvider, Ollama, rule + LLM interpreters
  db/          schema, migrations, repository
  app/         battle, rules, army, collection, chronicle services
apps/server/   local HTTP API over core
apps/desktop/  React UI + src-tauri shell
```

---

## Extending it

**Another data source.** Implement `WarhammerDataProvider`. Nothing above
`oracle/` mentions MCP or markdown.

**Another model backend.** Implement `LLMProvider` — two methods,
`isAvailable()` and `chat()`. `createInterpreter()` picks the best available at
startup and falls back to patterns.

**A new game action.** Add a variant to the `GameEvent` union, handle it in the
reducer, add it to `IntentSchema`, and add a branch in `applyIntent`. The
compiler will find every place that needs updating, because every switch over
the union is exhaustive.

**Voice.** The mic button is wired but disabled. Local speech-to-text should
produce a transcript and call the same `handleInput` path as typed text, with
`source: "voice"`. No other layer needs to change.

**Supplemental documents.** The tables exist. The intended shape is
extract → chunk → embed → local vector search, retrieved alongside Oracle and
merged into the same reference block the answer step already consumes.

---

## Deliberately not built

- Voice input.
- Document RAG — tables exist so imports are not lost; no extraction yet.
- Full rules simulation. The attack sequence narrates and records; it does not
  automatically apply every modifier, aura and stratagem effect. The event model
  is built to grow into that, one event type at a time.
- Model-to-model wound allocation and leaders attaching to bodyguard units are
  in the schema but not driven by the UI.
