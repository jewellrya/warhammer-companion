import { useCallback, useEffect, useState } from "react";
import {
  api,
  EDITION_LABELS,
  type Army,
  type BackendStatus,
  type BattleSummary,
} from "../api.js";
import type { Screen } from "../App.js";

export function HomeScreen({
  status,
  onOpenBattle,
  onNavigate,
  onStatusChange,
}: {
  status: BackendStatus | null;
  onOpenBattle: (id: string) => void;
  onNavigate: (s: Screen) => void;
  onStatusChange: () => void;
}): JSX.Element {
  const [battles, setBattles] = useState<BattleSummary[]>([]);
  const [armies, setArmies] = useState<Army[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([api.listBattles(), api.listArmies()]);
      setBattles(b);
      setArmies(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = battles.filter((b) => b.status === "active");

  const startBattle = useCallback(
    async (playerArmyId?: string, opponentArmyId?: string) => {
      setBusy(true);
      try {
        const s = await api.createBattle({
          name: `Battle — ${new Date().toLocaleDateString()}`,
          playerArmyId,
          opponentArmyId,
        });
        onOpenBattle(s.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onOpenBattle],
  );

  const seed = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.seed();
      onOpenBattle(r.battleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onOpenBattle]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Warhammer Companion</h1>
          <p className="sub">
            Local-first battle tracker, rules assistant and collection memory.
          </p>
        </div>
        <div className="row">
          <button className="btn" disabled={busy} onClick={seed}>
            Demo battle
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void startBattle(armies[0]?.id, armies[1]?.id)
            }
          >
            New battle
          </button>
        </div>
      </div>

      {error && <div className="err" style={{ marginBottom: 14 }}>{error}</div>}

      {active.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h2>Continue</h2>
          {active.map((b) => (
            <div className="list-item" key={b.id}>
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{b.name}</strong>
                  <span className="tag">{EDITION_LABELS[b.edition]}</span>
                </div>
                <div className="faint small">
                  {b.snapshot
                    ? `Round ${b.snapshot.round} · ${b.snapshot.phase} phase · ${
                        b.snapshot.units.filter((u) => !u.destroyed).length
                      } units alive`
                    : "Not started"}
                  {" · "}
                  {new Date(b.updatedAt).toLocaleString()}
                </div>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => onOpenBattle(b.id)}>
                  Open
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    void api.deleteBattle(b.id).then(refresh);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="grid two">
        <section className="card">
          <h2>Armies</h2>
          {armies.length === 0 ? (
            <p className="faint small">
              None yet. Paste a list on the Armies screen and it gets resolved
              against Oracle automatically.
            </p>
          ) : (
            armies.slice(0, 5).map((a) => (
              <div className="row spread" key={a.id} style={{ padding: "4px 0" }}>
                <span className="truncate">{a.name}</span>
                <span className="faint small mono">
                  {a.units.length} units
                </span>
              </div>
            ))
          )}
          <button
            className="btn sm"
            style={{ marginTop: 10 }}
            onClick={() => onNavigate("armies")}
          >
            Manage armies
          </button>
        </section>

        <section className="card">
          <h2>Rules Library</h2>
          <div className="col" style={{ gap: 6 }}>
            <StatusLine
              label="Warhammer Oracle (MCP)"
              ok={status?.oracle.available ?? false}
              detail={
                status?.oracle.available
                  ? `${status.oracle.tools.length} tools available`
                  : (status?.oracle.error ?? "not connected")
              }
            />
            <StatusLine
              label="Local language model"
              ok={status?.llm.available ?? false}
              detail={
                status?.llm.available
                  ? `${status.llm.provider} · ${status.llm.model}`
                  : "not running — pattern interpreter in use"
              }
            />
            <StatusLine
              label="Supplemental documents"
              ok={false}
              detail="not imported yet"
            />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => onNavigate("rules")}>
              Open Rules
            </button>
            <button
              className="btn sm"
              onClick={() => {
                void api.refreshStatus().then(onStatusChange);
              }}
            >
              Re-check
            </button>
          </div>
        </section>
      </div>

      {battles.filter((b) => b.status === "complete").length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2>Recent battles</h2>
          {battles
            .filter((b) => b.status === "complete")
            .slice(0, 5)
            .map((b) => (
              <div className="list-item" key={b.id}>
                <span className="grow truncate">{b.name}</span>
                <span className="faint small">
                  {new Date(b.updatedAt).toLocaleDateString()}
                </span>
                <button className="btn sm" onClick={() => onOpenBattle(b.id)}>
                  Open
                </button>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

function StatusLine({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}): JSX.Element {
  return (
    <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
      <span className={`dot ${ok ? "on" : "warn"}`} style={{ marginTop: 6 }} />
      <div className="grow">
        <div className="small">{label}</div>
        <div className="faint small truncate">{detail}</div>
      </div>
    </div>
  );
}
