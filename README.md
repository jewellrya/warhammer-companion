# Warhammer Companion

A local-first desktop companion for Warhammer 40,000. You talk to it the way you
talk across the table, and it keeps the battle straight.

```
> These Plague Marines move onto the center objective.
  Plague Marines moves to the center objective.

> Deathshroud shoot those Intercessors.
  ROUND 1 — SHOOTING
  Deathshroud Terminators → Intercessor Squad
  D6 attacks per model × 3 models.
  Torrent — attacks hit automatically. Go straight to wounding.
  S3 vs T4 — wounding on 5+.

> I got 10 hits.
  10 hits. S3 vs T4 — wound on 5+. Roll 10 dice.

> Can Mortarion charge after advancing?
  No. After Advancing, a unit can't declare a charge this turn.
  source: warhammer-oracle · lookup_phase · Movement

> Actually undo that.
  Undone: 4 damage to Intercessor Squad.
```

It is an AI referee, a live battle tracker, an army and collection memory, and a
battle historian. Everything runs on your machine — SQLite for storage, Ollama
for language, [Warhammer Oracle](https://github.com/gregario/warhammer-oracle)
over MCP for Warhammer knowledge. No accounts, no API keys, no paid services.

---

## Quick start

```bash
pnpm install
pnpm build

# Recommended. Without it the app runs in a reduced pattern-matching mode.
brew install ollama && ollama serve
ollama pull qwen2.5:7b-instruct

pnpm check       # verify Oracle + LLM + SQLite are reachable
pnpm desktop     # launch the app
```

Prefer not to build the Rust shell? Run it in a browser instead:

```bash
pnpm dev:server  # API on 127.0.0.1:8787
pnpm dev:ui      # UI on http://localhost:5273
```

Then open **Home → Demo battle** for two Oracle-resolved armies and a live game
in one click.

**Full setup, configuration and troubleshooting → [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**

---

## What it does

| Screen | |
|---|---|
| **Battle** | The main interface. Round/turn/phase/CP/VP across the top, both armies down the left with live wound bars and activation flags, conversation and battle log in the middle, one input box at the bottom. |
| **Armies** | Paste a list in any format. Every unit is matched against Oracle; anything it can't confirm is flagged rather than silently accepted. |
| **Collection** | What you physically own. *"I bought another box of Deathshroud Terminators"* → +3 models, correct faction. |
| **Rules** | Conversational lookup. Every answer shows the Oracle entry it came from. |
| **Chronicle** | Win/loss, kills, damage and objective history, folded automatically out of the event log. Narrated by the local model. |

You rarely type into a form. The AI reads what you say, paste, or import, and
maintains the structured records behind it.

---

## How it works

Four rules hold the design together:

**The model interprets language and plans retrieval — it never holds state and
never supplies facts.** It turns an utterance into an `Intent`, and decides which
Oracle entries to open. It does *not* decide which unit "the terminators" means
(that is read from the battle) or recall a rule from memory (that comes from
Oracle).

**Oracle owns Warhammer knowledge; the app owns the battle.** Datasheets,
weapons, stratagem costs and keyword text come from Oracle every time. How many
models are left in a squad is ours. Nothing Oracle owns is copied into our
schema.

**Events are the only way state changes.** `applyEvent(state, event)` is pure
and total, so replay, undo, correction, audit and the Chronicle all fall out of
one log rather than five mechanisms. Undo marks events undone and re-folds;
nothing is deleted.

**Ambiguity asks.** If two units match what you said, you get *"Deathshroud
Terminators or Blightlord Terminators?"* — never a coin flip.

```
natural language → interpret → Intent → resolve against battle state + Oracle
                 → GameEvent[] → pure reducer → SQLite → UI
```

**The full picture — retrieval loop, Oracle integration gotchas, data model,
extension points → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

---

## Verifying it

```bash
pnpm test                 # 48 unit tests: reducer, resolution, parsers, interpreter
pnpm -F @wh/core verify   # the whole pipeline against a live Oracle server
```

`verify` prints a pass/fail line per step: MCP handshake, unit lookup in both
editions, army import, battle creation, natural-language commands, attack
sequencing, ambiguity handling, undo, a rules question, SQLite replay, and
Chronicle generation.

---

## Status

Working end to end: the Tauri desktop app with a managed Node core, Oracle over
MCP across all 14 tools, army import, the full natural-language → event → state
→ SQLite → UI pipeline, attack sequencing from real datasheet values, undo,
grounded rules Q&A with citations, conversational collection updates, Chronicle
statistics, and all six screens.

Not built yet, by choice: voice input (the mic button is wired but disabled —
the plan is local faster-whisper feeding the same input path), document RAG (the
tables exist so imports aren't lost), and full rules simulation — the attack
sequence narrates and records rather than automatically applying every modifier
and aura. The event model is built to grow into that.

---

## Licence

MIT for this application. Unit data comes from the
[BSData](https://github.com/BSData) community project via Warhammer Oracle.
Warhammer 40,000 rules and settings are the intellectual property of Games
Workshop; this is a personal-use reference tool.
