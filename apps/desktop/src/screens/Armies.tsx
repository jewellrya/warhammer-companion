import { useCallback, useEffect, useState } from "react";
import { api, EDITION_LABELS, type Army, type BackendStatus } from "../api.js";

const SAMPLE = `Death Guard Strike Force (2000 points)

Faction: Death Guard
Detachment: Plague Company

Mortarion
Deathshroud Terminators
  Manreaper
Plague Marines
Rhino
Biologus Putrifier`;

export function ArmiesScreen({
  status,
}: {
  status: BackendStatus | null;
}): JSX.Element {
  const [armies, setArmies] = useState<Army[]>([]);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    unresolved: string[];
    warnings: string[];
    method: string;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setArmies(await api.listArmies());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doImport = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.importArmy(text, name.trim() || undefined);
      setResult({
        unresolved: r.unresolved,
        warnings: r.warnings,
        method: r.method,
      });
      setText("");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [text, name, refresh]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Armies</h1>
          <p className="sub">
            Paste a list in any format. Units are matched against Oracle — no
            forms to fill in.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Import a list</h2>
        <div className="col">
          <input
            placeholder="List name (optional — inferred from the text)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            rows={9}
            placeholder="Paste your army list here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row spread">
            <div className="row">
              <button
                className="btn primary"
                disabled={busy || !text.trim()}
                onClick={doImport}
              >
                {busy ? "Resolving against Oracle…" : "Import list"}
              </button>
              <button className="btn" onClick={() => setText(SAMPLE)}>
                Use sample
              </button>
            </div>
            <span className="faint small">
              {status?.llm.available
                ? "Structural parser, with the local model as fallback"
                : "Structural parser (no local model running)"}
            </span>
          </div>
        </div>

        {error && <div className="err" style={{ marginTop: 12 }}>{error}</div>}

        {result && (
          <div style={{ marginTop: 12 }} className="col">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="tag">parsed via {result.method}</span>
              {result.unresolved.length === 0 ? (
                <span className="tag">all units resolved</span>
              ) : (
                <span className="tag warnish">
                  {result.unresolved.length} unresolved
                </span>
              )}
            </div>
            {result.unresolved.length > 0 && (
              <p className="small faint">
                Oracle couldn't confirm: {result.unresolved.join(", ")}. They're
                saved, but flagged.
              </p>
            )}
            {result.warnings.map((w, i) => (
              <p key={i} className="small faint">
                {w}
              </p>
            ))}
          </div>
        )}
      </div>

      <h2>Saved armies</h2>
      {armies.length === 0 ? (
        <div className="empty">No armies yet.</div>
      ) : (
        armies.map((a) => (
          <div key={a.id} style={{ marginBottom: 6 }}>
            <div className="list-item">
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{a.name}</strong>
                  <span className="tag">{EDITION_LABELS[a.edition]}</span>
                  {a.units.some((u) => !u.ref.resolved) && (
                    <span className="tag warnish">unconfirmed entries</span>
                  )}
                </div>
                <div className="faint small">
                  {a.faction}
                  {a.detachment ? ` · ${a.detachment}` : ""} · {a.units.length}{" "}
                  units ·{" "}
                  {a.units.reduce((sum, u) => sum + (u.points ?? 0), 0)} pts
                </div>
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() => setOpen(open === a.id ? null : a.id)}
                >
                  {open === a.id ? "Hide" : "Units"}
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    void api.deleteArmy(a.id).then(refresh);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            {open === a.id && (
              <div className="card" style={{ marginTop: 4 }}>
                <table className="datasheet" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th>Models</th>
                      <th>Points</th>
                      <th>Wargear</th>
                      <th>Oracle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.units.map((u) => (
                      <tr key={u.id}>
                        <td>
                          {u.ref.name}
                          {u.isWarlord && <span className="tag" style={{ marginLeft: 5 }}>WL</span>}
                        </td>
                        <td>{u.modelCount}</td>
                        <td>{u.points ?? "—"}</td>
                        <td>{u.wargear.join(", ") || "—"}</td>
                        <td style={{ color: u.ref.resolved ? "var(--good)" : "var(--warn)" }}>
                          {u.ref.resolved ? "matched" : "unconfirmed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
