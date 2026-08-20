# Getting started

Everything runs on your machine. There is no account, no API key, and nothing
leaves your laptop.

---

## What you need

| | Required? | Why |
|---|---|---|
| **Node 20+** | yes | Runs the core, the API, and the Warhammer Oracle server |
| **pnpm** | yes | Workspace manager (`npm i -g pnpm`) |
| **Rust** | for the desktop app | Builds the Tauri shell. Browser mode works without it |
| **Ollama** | strongly recommended | The local language model. Without it the app runs in a reduced pattern-matching mode |

Warhammer Oracle itself needs no install — it is fetched through `npx` the first
time the app asks it a question.

### Installing the optional pieces

```bash
# Rust (only needed for the desktop window)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Ollama + a model
brew install ollama
ollama serve                        # leave running, or use the menu-bar app
ollama pull qwen2.5:7b-instruct     # ~4.7 GB
```

Any instruction-tuned model that can emit JSON will work. Set a different one
with `OLLAMA_MODEL`. Smaller models are faster but hand back worse retrieval
plans; larger ones are slower per question but need fewer retries.

---

## Setup

```bash
pnpm install
pnpm build
pnpm check
```

`pnpm check` is the health report. A good one looks like this:

```
Warhammer Companion — environment check

[  ok  ] SQLite      /Users/you/.warhammer-companion/companion.db
[  ok  ] Oracle      14 tools: lookup_unit, lookup_keyword, lookup_phase, …
[  ok  ] Local LLM   ollama / qwen2.5:7b-instruct

Interpreter in use: ollama:qwen2.5:7b-instruct
[  ok  ] Sample query  Deathshroud Terminators → 160pts, T7, 3 weapons
```

The first run is slower than the rest — `npx` is downloading Warhammer Oracle,
and Ollama is loading the model into memory.

> It is `pnpm check`, not `pnpm doctor`. `doctor` is a built-in pnpm command and
> silently shadows a script of the same name.

---

## Running it

### Desktop app

```bash
pnpm desktop
```

This starts Vite, compiles the Tauri shell, opens the window, and launches the
Node core as a child process. The first build compiles a few hundred Rust
crates and takes a couple of minutes; after that it is seconds.

The window may show *"Can't reach the local service"* for a moment on a cold
start — the webview is ready before the core is. It retries on its own and
clears within a few seconds.

### Browser

Useful if you would rather not build the Rust shell, or you are working on the
UI and want fast reloads.

```bash
pnpm dev:server   # API on 127.0.0.1:8787
pnpm dev:ui       # UI on http://localhost:5273
```

Both modes talk to the same database and behave identically.

---

## First five minutes

1. **Home → "Demo battle"** builds two Oracle-resolved armies and drops you into
   a live game. Fastest way to see the whole thing work.
2. On the **Battle** screen, type into the box at the bottom:

   ```
   These Plague Marines move onto the center objective.
   The Rhino takes six damage.
   Deathshroud shoot those Intercessors.
   I got 10 hits.
   7 wounds
   ```

   Watch the left panel update as you go — wound bars, activation flags, model
   counts. Battle events render as log entries; ordinary chat does not.
3. Ask a rules question in the same box: *"Can Mortarion charge after
   advancing?"* Answers cite the Oracle entry they came from.
4. Type **"Actually undo that."**
5. **Armies** → paste any army list and it resolves against Oracle.
6. **Collection** → *"I bought another box of Deathshroud Terminators."*

---

## Configuration

Set these in your shell, or a `.env` you source before starting.

| Variable | Default | Purpose |
|---|---|---|
| `WH_DB_PATH` | `~/.warhammer-companion/companion.db` | Where the SQLite file lives |
| `WH_PORT` | `8787` | Local API port |
| `WH_EDITION` | `40k_11e` | Default edition for new battles |
| `ORACLE_COMMAND` | `npx -y -p warhammer-oracle warhammer-oracle-11e` | How to launch Oracle |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model used for interpretation |
| `WH_EXTERNAL_CORE` | unset | Set to `1` so the Tauri shell won't start its own core |

The API binds to `127.0.0.1` only. It holds your collection and drives a local
model; neither belongs on a network interface.

---

## Verifying it properly

```bash
pnpm test    # 48 unit tests — reducer, resolution, Oracle parsers, interpreter
```

```bash
pnpm -F @wh/core verify
```

`verify` is the real one. It runs the entire pipeline against a live Warhammer
Oracle server and prints a pass/fail line for each step: MCP handshake, unit
lookup in both editions, army import, battle creation, natural-language
commands, attack sequencing, ambiguity handling, undo, a rules question, SQLite
replay, and Chronicle generation. If something is broken, this tells you where.

---

## Troubleshooting

**`Oracle offline` in the sidebar**
First contact downloads the package through `npx`, so it needs network access
once. After that it is fully local. To pin a local checkout instead:

```bash
export ORACLE_COMMAND="node /path/to/warhammer-oracle/dist/index.js"
```

**`Rules-only mode` in the sidebar**
Ollama is not reachable, or the configured model is not pulled. The app still
works — a deterministic pattern interpreter handles the common phrasings — but
it will not understand unusual wording, and rules answers come back as raw
Oracle text rather than prose.

```bash
ollama serve
ollama list                     # is your model actually there?
ollama pull qwen2.5:7b-instruct
```

**"Port 8787 is already in use"**
Another copy of the core is running — often a `pnpm dev:server` left over from
earlier. Use it, stop it, or set `WH_PORT`. The Tauri shell detects an existing
core and reuses it rather than starting a rival.

**`better-sqlite3` fails to load**
It is a native module and needs to match your Node version:

```bash
pnpm -F @wh/core rebuild better-sqlite3
```

**Answers are slow**
Each rules question is one or two model round trips. On a 7B model that is
roughly 2–6 seconds. Oracle lookups are cached per process, so repeated
questions about the same unit are much faster than the first.

**Starting over**

```bash
rm -rf ~/.warhammer-companion
```

Deletes every battle, army, and collection record. There is no undo for this.
