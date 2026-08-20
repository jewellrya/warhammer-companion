import { useCallback, useEffect, useState } from "react";
import { api, EDITION_LABELS, type ChronicleEntry } from "../api.js";

/** Everything here is derived from the event log — nothing is hand-entered. */
export function ChronicleScreen({
  onOpenBattle,
}: {
  onOpenBattle: (id: string) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<ChronicleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [narrating, setNarrating] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.chronicle());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const narrate = useCallback(async (id: string) => {
    setNarrating(id);
    try {
      const updated = await api.narrate(id);
      setEntries((p) => p.map((e) => (e.battleId === id ? updated : e)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNarrating(null);
    }
  }, []);

  const wins = entries.filter((e) => e.winner === "player").length;
  const losses = entries.filter((e) => e.winner === "opponent").length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Chronicle</h1>
          <p className="sub">
            Built automatically from what actually happened in each battle.
          </p>
        </div>
        {entries.length > 0 && (
          <div className="row">
            <span className="tag">{entries.length} battles</span>
            <span className="tag">
              {wins}W · {losses}L
            </span>
          </div>
        )}
      </div>

      {error && <div className="err">{error}</div>}

      {entries.length === 0 ? (
        <div className="empty">
          No battles recorded yet. Play one and it shows up here.
        </div>
      ) : (
        entries.map((e) => (
          <div className="card" key={e.battleId} style={{ marginBottom: 10 }}>
            <div className="row spread" style={{ marginBottom: 8 }}>
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <h3>{e.battleName}</h3>
                  <span className="tag">{EDITION_LABELS[e.edition]}</span>
                  {e.status === "active" && <span className="tag warnish">in progress</span>}
                </div>
                <div className="faint small">
                  {e.armies.player.name} ({e.armies.player.faction}) vs{" "}
                  {e.armies.opponent.name} ({e.armies.opponent.faction}) ·{" "}
                  {new Date(e.playedAt).toLocaleDateString()} · {e.rounds} rounds
                </div>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => onOpenBattle(e.battleId)}>
                  Open
                </button>
                <button
                  className="btn sm"
                  disabled={narrating === e.battleId}
                  onClick={() => void narrate(e.battleId)}
                >
                  {narrating === e.battleId ? "Writing…" : "Summarise"}
                </button>
              </div>
            </div>

            <div className="row wrap" style={{ gap: 14 }}>
              <Metric label="VP" you={e.finalVp.player} them={e.finalVp.opponent} />
              <Metric
                label="Units killed"
                you={e.stats.unitsDestroyed.player}
                them={e.stats.unitsDestroyed.opponent}
              />
              <Metric
                label="Models slain"
                you={e.stats.modelsSlain.player}
                them={e.stats.modelsSlain.opponent}
              />
              <Metric
                label="Damage"
                you={e.stats.totalDamageDealt.player}
                them={e.stats.totalDamageDealt.opponent}
              />
              <Metric
                label="CP spent"
                you={e.stats.cpSpent.player}
                them={e.stats.cpSpent.opponent}
              />
            </div>

            {e.narrative && (
              <p className="small dim" style={{ marginTop: 12, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                {e.narrative}
              </p>
            )}

            {e.highlights.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h2>Notable</h2>
                {e.highlights.map((h, i) => (
                  <div key={i} className="small dim">
                    · {h}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function Metric({
  label,
  you,
  them,
}: {
  label: string;
  you: number;
  them: number;
}): JSX.Element {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ fontSize: 13 }}>
        <span className="player">{you}</span>
        <span className="faint"> / </span>
        <span className="opponent">{them}</span>
      </span>
    </div>
  );
}
