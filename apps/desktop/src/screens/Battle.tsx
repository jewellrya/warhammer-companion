import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  PHASE_ORDER,
  type BattleState,
  type BattleUnit,
  type ChatMessage,
  type GameEvent,
  type Phase,
  type PlayerSide,
  type SourceCitation,
  type TurnResult,
} from "../api.js";
import type { Screen } from "../App.js";

/**
 * The main interface. Layout follows the brief: state across the top, both
 * rosters on the left, conversation + event feed in the middle, input at the
 * bottom. Everything the player might need mid-turn is visible without a click.
 */

/** A rendered line in the feed — chat and battle events interleaved by time. */
type FeedItem =
  | { kind: "chat"; id: string; role: ChatMessage["role"]; text: string; meta?: Record<string, unknown> }
  | {
      kind: "event";
      id: string;
      header: string;
      lines: string[];
      citations?: SourceCitation[];
    };

export function BattleScreen({
  battleId,
  onOpenBattle,
  onNavigate,
}: {
  battleId: string | null;
  onOpenBattle: (id: string) => void;
  onNavigate: (s: Screen) => void;
}): JSX.Element {
  const [state, setState] = useState<BattleState | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const { state: s, messages, events } = await api.getBattle(id);
      setState(s);
      setFeed(buildInitialFeed(messages, events, s));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (battleId) void load(battleId);
  }, [battleId, load]);

  // Keep the newest entry visible; the feed is the thing being read.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed, busy]);

  const applyResult = useCallback((result: TurnResult, echo?: string) => {
    setFeed((prev) => {
      const next = [...prev];
      if (echo) {
        next.push({ kind: "chat", id: `u-${Date.now()}`, role: "user", text: echo });
      }

      if (result.events.length > 0 && result.state) {
        next.push(
          renderEventGroup(result.events, result.eventDescriptions, result.state, result.reply),
        );
      } else {
        next.push({
          kind: "chat",
          id: `a-${Date.now()}`,
          role: "assistant",
          text: result.reply,
          meta: {
            clarification: Boolean(result.needsClarification),
            citations: result.citations,
          },
        });
      }
      return next;
    });
    if (result.state) setState(result.state);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!battleId || !text.trim() || busy) return;
      setBusy(true);
      setInput("");
      setFeed((p) => [
        ...p,
        { kind: "chat", id: `u-${Date.now()}`, role: "user", text },
      ]);
      try {
        applyResult(await api.sendInput(battleId, text));
        setError(null);
      } catch (err) {
        setFeed((p) => [
          ...p,
          {
            kind: "chat",
            id: `e-${Date.now()}`,
            role: "assistant",
            text: err instanceof Error ? err.message : String(err),
            meta: { error: true },
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [battleId, busy, applyResult],
  );

  const runIntent = useCallback(
    async (intent: Record<string, unknown>, label: string) => {
      if (!battleId || busy) return;
      setBusy(true);
      try {
        applyResult(await api.sendIntent(battleId, intent, label));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [battleId, busy, applyResult],
  );

  const undo = useCallback(async () => {
    if (!battleId || busy) return;
    setBusy(true);
    try {
      const result = await api.undo(battleId);
      setFeed((p) => [
        ...p,
        {
          kind: "chat",
          id: `a-${Date.now()}`,
          role: "assistant",
          text: result.reply,
          meta: { undo: true },
        },
      ]);
      if (result.state) setState(result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [battleId, busy]);

  if (!battleId) return <NoBattle onOpenBattle={onOpenBattle} onNavigate={onNavigate} />;
  if (loading && !state) {
    return (
      <div className="page">
        <p className="sub">Loading battle…</p>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="page">
        <div className="err">{error ?? "Battle not found."}</div>
      </div>
    );
  }

  return (
    <div className="battle">
      <TopBar state={state} onPhase={runIntent} onUndo={undo} busy={busy} />

      <div className="battle-body">
        <Roster state={state} onQuick={send} />

        <div className="conversation">
          <div className="feed" ref={feedRef}>
            {feed.map((item) =>
              item.kind === "event" ? (
                <EventCard key={item.id} item={item} />
              ) : (
                <ChatBubble key={item.id} item={item} />
              ),
            )}
            {busy && <div className="thinking">Working…</div>}
            {error && <div className="err">{error}</div>}
          </div>

          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            busy={busy}
            state={state}
          />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ top bar

function TopBar({
  state,
  onPhase,
  onUndo,
  busy,
}: {
  state: BattleState;
  onPhase: (intent: Record<string, unknown>, label: string) => void;
  onUndo: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <div className="topbar">
      <div className="stat">
        <span className="stat-label">Round</span>
        <span className="stat-value">{state.round}</span>
      </div>

      <div className="stat">
        <span className="stat-label">Turn</span>
        <span className={`stat-value ${state.activePlayer}`}>
          {state.activePlayer === "player" ? "You" : "Opponent"}
        </span>
      </div>

      <div className="phases">
        {PHASE_ORDER.map((p) => (
          <button
            key={p}
            className={state.phase === p ? "on" : ""}
            disabled={busy}
            onClick={() => onPhase({ intent: "change_phase", phase: p }, `${p} phase`)}
          >
            {p.slice(0, 3).toUpperCase()}
          </button>
        ))}
      </div>

      <div className="stat">
        <span className="stat-label">CP</span>
        <span className="stat-value">
          <span className="player">{state.cp.player}</span>
          <span className="faint"> / </span>
          <span className="opponent">{state.cp.opponent}</span>
        </span>
      </div>

      <div className="stat">
        <span className="stat-label">VP</span>
        <span className="stat-value">
          <span className="player">{state.vp.player}</span>
          <span className="faint"> / </span>
          <span className="opponent">{state.vp.opponent}</span>
        </span>
      </div>

      <div className="row" style={{ marginLeft: "auto" }}>
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => onPhase({ intent: "change_phase", next: true }, "next phase")}
        >
          Next phase
        </button>
        <button
          className="btn sm"
          disabled={busy}
          onClick={() => onPhase({ intent: "end_turn" }, "end turn")}
        >
          End turn
        </button>
        <button className="btn sm" disabled={busy} onClick={onUndo}>
          Undo
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- roster

function Roster({
  state,
  onQuick,
}: {
  state: BattleState;
  onQuick: (text: string) => void;
}): JSX.Element {
  const sides: PlayerSide[] = ["player", "opponent"];
  return (
    <div className="roster">
      {sides.map((side) => {
        const units = state.units.filter((u) => u.side === side);
        const alive = units.filter((u) => !u.destroyed).length;
        return (
          <div className="roster-group" key={side}>
            <div className="roster-head">
              <span className={`name ${side}`}>{state.armies[side].name}</span>
              <span className="mono faint small">
                {alive}/{units.length}
              </span>
            </div>
            {units.length === 0 ? (
              <p className="faint small" style={{ padding: "4px 3px" }}>
                Nothing deployed.
              </p>
            ) : (
              units.map((u) => (
                <UnitRow key={u.id} unit={u} onQuick={onQuick} />
              ))
            )}
          </div>
        );
      })}

      {state.objectives.length > 0 && (
        <div className="roster-group">
          <div className="roster-head">
            <span className="name">Objectives</span>
          </div>
          {state.objectives.map((o) => (
            <div className="unit" key={o.id} onClick={() => onQuick(`I claim the ${o.name} objective`)}>
              <div className="unit-top">
                <span className="unit-name">{o.name}</span>
                <span
                  className={`unit-count ${o.controlledBy ?? ""}`}
                  style={{
                    color: o.controlledBy
                      ? o.controlledBy === "player"
                        ? "var(--player)"
                        : "var(--opponent)"
                      : undefined,
                  }}
                >
                  {o.controlledBy === "player"
                    ? "YOU"
                    : o.controlledBy === "opponent"
                      ? "OPP"
                      : "—"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One unit's live state, readable without opening anything. */
function UnitRow({
  unit,
  onQuick,
}: {
  unit: BattleUnit;
  onQuick: (text: string) => void;
}): JSX.Element {
  const totalWounds = unit.modelsTotal * unit.woundsPerModel;
  const left = Math.max(
    0,
    unit.modelsAlive * unit.woundsPerModel - unit.woundsTakenOnLeadModel,
  );
  const pct = totalWounds > 0 ? (left / totalWounds) * 100 : 0;
  const tone = pct > 60 ? "" : pct > 25 ? "hurt" : "critical";

  const a = unit.activation;
  const flags: [string, boolean][] = [
    ["MOV", a.moved],
    ["ADV", a.advanced],
    ["SHT", a.shot],
    ["CHG", a.charged],
    ["FGT", a.fought],
  ];

  return (
    <div
      className={`unit ${unit.destroyed ? "dead" : ""}`}
      onClick={() => onQuick(`Tell me about ${unit.name}`)}
      title={unit.ref.resolved ? unit.ref.name : `${unit.ref.name} (unconfirmed)`}
    >
      <div className="unit-top">
        <span className="unit-name">
          {unit.name}
          {!unit.ref.resolved && <span className="tag warnish" style={{ marginLeft: 5 }}>?</span>}
        </span>
        <span className="unit-count">
          {unit.modelsAlive}/{unit.modelsTotal}
          {unit.woundsPerModel > 1 && !unit.destroyed && (
            <span className="faint">
              {" "}
              · {unit.woundsPerModel - unit.woundsTakenOnLeadModel}W
            </span>
          )}
        </span>
      </div>

      {!unit.destroyed && (
        <div className="hp">
          <div className={`hp-fill ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}

      {!unit.destroyed && (
        <div className="flags">
          {flags.map(([label, on]) => (
            <span key={label} className={`flag ${on ? "on" : ""}`}>
              {label}
            </span>
          ))}
          {a.battleShocked && <span className="flag shock">SHOCK</span>}
          {unit.effects.map((e) => (
            <span key={e.id} className="flag on">
              {e.name.slice(0, 10)}
            </span>
          ))}
        </div>
      )}

      {unit.position && <div className="unit-pos">{unit.position}</div>}
    </div>
  );
}

// --------------------------------------------------------------------- feed

function ChatBubble({ item }: { item: Extract<FeedItem, { kind: "chat" }> }): JSX.Element {
  if (item.role === "user") {
    return <div className="msg user">{item.text}</div>;
  }
  const meta = item.meta ?? {};
  const cls = meta["error"] ? "error" : meta["clarification"] ? "clarify" : "";
  const citations = meta["citations"] as SourceCitation[] | undefined;

  return (
    <div className={`msg assistant ${cls}`}>
      {item.text}
      {citations && citations.length > 0 && <Citations list={citations} />}
    </div>
  );
}

function EventCard({ item }: { item: Extract<FeedItem, { kind: "event" }> }): JSX.Element {
  return (
    <div className="event-card">
      <div className="event-head">{item.header}</div>
      {item.lines.map((line, i) => (
        <div
          key={i}
          className={line.startsWith("  ") ? "event-detail" : "event-line"}
        >
          {line.trim()}
        </div>
      ))}
      {item.citations && item.citations.length > 0 && (
        <Citations list={item.citations} />
      )}
    </div>
  );
}

function Citations({ list }: { list: SourceCitation[] }): JSX.Element {
  const unique = [...new Map(list.map((c) => [`${c.provider}:${c.tool}`, c])).values()];
  return (
    <div className="cite">
      <span>source</span>
      {unique.map((c) => (
        <span className="tag" key={`${c.provider}:${c.tool}`}>
          {c.provider} · {c.tool}
        </span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- composer

const HINTS = [
  "Deathshroud shoot the Intercessors",
  "The Rhino takes six damage",
  "I got 10 hits",
  "Next phase",
  "Can Mortarion charge after advancing?",
  "Actually undo that",
];

function Composer({
  value,
  onChange,
  onSend,
  busy,
  state,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  state: BattleState;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow the box with the text, up to the CSS max-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  }, [value]);

  return (
    <div className="composer">
      <div className="hints">
        {HINTS.map((h) => (
          <button key={h} className="hint" onClick={() => onChange(h)}>
            {h}
          </button>
        ))}
      </div>

      <div className="composer-row">
        <textarea
          ref={ref}
          value={value}
          disabled={busy}
          placeholder={`Round ${state.round}, ${state.phase} phase — say what happens…`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend(value);
            }
          }}
        />
        <button
          className="mic"
          disabled
          title="Voice input arrives with local Whisper support"
        >
          ◍
        </button>
        <button
          className="btn primary"
          disabled={busy || !value.trim()}
          onClick={() => onSend(value)}
          style={{ height: 38 }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- empty state

function NoBattle({
  onOpenBattle,
  onNavigate,
}: {
  onOpenBattle: (id: string) => void;
  onNavigate: (s: Screen) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Battle</h1>
      </div>
      <div className="empty">
        <p>No battle open.</p>
        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api
                .seed()
                .then((r) => onOpenBattle(r.battleId))
                .catch((e: unknown) =>
                  setErr(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Building…" : "Start a demo battle"}
          </button>
          <button className="btn" onClick={() => onNavigate("home")}>
            Go to Home
          </button>
        </div>
        {err && (
          <div className="err" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

const PHASE_LABEL: Record<Phase, string> = {
  command: "COMMAND",
  movement: "MOVEMENT",
  shooting: "SHOOTING",
  charge: "CHARGE",
  fight: "FIGHT",
  end: "END",
};

/**
 * Turn a batch of events plus the assistant's narration into one log card.
 * The header carries round/phase so scrolling back reads like a battle log.
 */
function renderEventGroup(
  events: GameEvent[],
  descriptions: string[],
  state: BattleState,
  reply: string,
): Extract<FeedItem, { kind: "event" }> {
  const header = `ROUND ${state.round} — ${PHASE_LABEL[state.phase]}`;
  const lines = reply.split("\n").filter((l) => l.trim().length > 0);

  // Show the raw event list only when it adds something the prose didn't.
  const extras = descriptions.filter(
    (d) => !lines.some((l) => l.toLowerCase().includes(d.toLowerCase().slice(0, 14))),
  );

  return {
    kind: "event",
    id: events[0]?.id ?? `ev-${Date.now()}`,
    header,
    lines: [...lines, ...extras.map((e) => `  ${e}`)],
  };
}

/** Rebuild the feed after reopening a battle, interleaving chat and events. */
function buildInitialFeed(
  messages: ChatMessage[],
  events: GameEvent[],
  state: BattleState,
): FeedItem[] {
  const items: FeedItem[] = [];

  const deployed = events.filter((e) => e.type === "unit_deployed").length;
  const started = events.find((e) => e.type === "battle_started");
  if (started) {
    items.push({
      kind: "event",
      id: started.id,
      header: "BATTLE START",
      lines: [
        `${state.armies.player.name} vs ${state.armies.opponent.name}`,
        `${deployed} units deployed · ${state.cp.player} CP each`,
      ],
    });
  }

  for (const m of messages) {
    items.push({
      kind: "chat",
      id: m.id,
      role: m.role,
      text: m.content,
      meta: m.meta,
    });
  }

  return items;
}
