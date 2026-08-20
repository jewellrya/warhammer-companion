import { useCallback, useState } from "react";
import {
  api,
  type BackendStatus,
  type RulesAnswer,
  type UnitData,
} from "../api.js";

/** Conversational lookup. Every answer shows the Oracle entity behind it. */
export function RulesScreen({
  status,
  battleId,
}: {
  status: BackendStatus | null;
  battleId: string | null;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<RulesAnswer | null>(null);
  const [unit, setUnit] = useState<UnitData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const ask = useCallback(async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setUnit(null);
    setAnswer(null);
    setShowSource(false);
    try {
      setAnswer(await api.ask(q, battleId ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [q, battleId]);

  const lookup = useCallback(async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setUnit(null);
    try {
      const r = await api.lookupUnit(q);
      setUnit(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="sub">
            Answers come from Warhammer Oracle. The source is always shown.
          </p>
        </div>
        {status && (
          <span className={`tag ${status.oracle.available ? "" : "warnish"}`}>
            {status.oracle.available
              ? `Oracle · ${status.oracle.tools.length} tools`
              : "Oracle offline"}
          </span>
        )}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row">
          <input
            className="grow"
            placeholder="Ask a rules question, or name a unit…"
            value={q}
            disabled={busy}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ask();
            }}
          />
          <button className="btn primary" disabled={busy || !q.trim()} onClick={ask}>
            Ask
          </button>
          <button className="btn" disabled={busy || !q.trim()} onClick={lookup}>
            Datasheet
          </button>
        </div>
        <div className="hints" style={{ marginTop: 9 }}>
          {[
            "What does Devastating Wounds do?",
            "How does the Shooting phase work?",
            "What does Fire Overwatch cost?",
            "Deathshroud Terminators",
          ].map((h) => (
            <button key={h} className="hint" onClick={() => setQ(h)}>
              {h}
            </button>
          ))}
        </div>
      </div>

      {busy && <p className="sub">Querying Oracle…</p>}
      {error && <div className="err">{error}</div>}

      {answer && (
        <div className="card">
          <div className="msg assistant" style={{ maxWidth: "none" }}>
            {answer.text}
          </div>
          {answer.citations.length > 0 && (
            <div className="cite">
              <span>source</span>
              {answer.citations.map((c, i) => (
                <span className="tag" key={i}>
                  {c.provider} · {c.tool}
                  {typeof c.query["unit_name"] === "string"
                    ? ` · ${String(c.query["unit_name"])}`
                    : typeof c.query["keyword"] === "string"
                      ? ` · ${String(c.query["keyword"])}`
                      : ""}
                </span>
              ))}
              <button
                className="btn sm"
                style={{ marginLeft: "auto" }}
                onClick={() => setShowSource(!showSource)}
              >
                {showSource ? "Hide" : "Show"} source text
              </button>
            </div>
          )}
          {showSource &&
            answer.sources.map((s, i) => (
              <div key={i} style={{ marginTop: 12 }}>
                <h3>{s.title}</h3>
                <div className="pre">{s.body}</div>
              </div>
            ))}
        </div>
      )}

      {unit && <Datasheet unit={unit} />}
    </div>
  );
}

function Datasheet({ unit }: { unit: UnitData }): JSX.Element {
  const ranged = unit.weapons.filter((w) => w.kind === "ranged");
  const melee = unit.weapons.filter((w) => w.kind === "melee");

  return (
    <div className="card datasheet">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h3>{unit.name}</h3>
        <div className="row">
          <span className="tag">{unit.faction}</span>
          {unit.points !== null && <span className="tag">{unit.points} pts</span>}
          <span className="tag">
            {unit.unitSize.min === unit.unitSize.max
              ? `${unit.unitSize.min} model${unit.unitSize.min === 1 ? "" : "s"}`
              : `${unit.unitSize.min}-${unit.unitSize.max} models`}
          </span>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Profile</th><th>M</th><th>T</th><th>SV</th>
            <th>W</th><th>LD</th><th>OC</th>
          </tr>
        </thead>
        <tbody>
          {unit.profiles.map((p, i) => (
            <tr key={i}>
              <td>{p.name}</td><td>{p.movement}</td><td>{p.toughness}</td>
              <td>{p.save}</td><td>{p.wounds}</td><td>{p.leadership}</td>
              <td>{p.objectiveControl}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {[
        ["Ranged", ranged],
        ["Melee", melee],
      ].map(([label, list]) =>
        (list as typeof ranged).length === 0 ? null : (
          <div key={label as string}>
            <h3 style={{ marginTop: 12 }}>{label as string}</h3>
            <table>
              <thead>
                <tr>
                  <th>Weapon</th><th>Range</th><th>A</th>
                  <th>{label === "Ranged" ? "BS" : "WS"}</th>
                  <th>S</th><th>AP</th><th>D</th><th>Keywords</th>
                </tr>
              </thead>
              <tbody>
                {(list as typeof ranged).map((w, i) => (
                  <tr key={i}>
                    <td>{w.name}</td><td>{w.range}</td><td>{w.attacks}</td>
                    <td>{w.skill}</td><td>{w.strength}</td>
                    <td>{w.armourPenetration}</td><td>{w.damage}</td>
                    <td>{w.keywords.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}

      {unit.abilities.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Abilities</h3>
          <div className="col" style={{ gap: 6, marginTop: 6 }}>
            {unit.abilities.map((a, i) => (
              <div key={i} className="small">
                <strong>{a.name}</strong>{" "}
                <span className="dim">{a.description}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {unit.keywords.length > 0 && (
        <div className="row wrap" style={{ gap: 4, marginTop: 12 }}>
          {unit.keywords.map((k) => (
            <span className="tag" key={k}>{k}</span>
          ))}
        </div>
      )}
    </div>
  );
}
