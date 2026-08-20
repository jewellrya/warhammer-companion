import { useCallback, useEffect, useState } from "react";
import { api, type BackendStatus, type CollectionItem } from "../api.js";

/** The collection is edited by talking to it, not by filling in a form. */
export function CollectionScreen({
  status,
}: {
  status: BackendStatus | null;
}): JSX.Element {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.listCollection());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.collectionInput(text);
      setLog((p) => [...p, `> ${text}`, r.reply]);
      setText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [text, refresh]);

  const totalModels = items.reduce((s, i) => s + i.quantity, 0);
  const totalPainted = items.reduce((s, i) => s + i.painted, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Collection</h1>
          <p className="sub">
            What you physically own. Tell it what you bought or painted.
          </p>
        </div>
        <div className="row">
          <span className="tag">{totalModels} models</span>
          <span className="tag">{totalPainted} painted</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row">
          <input
            className="grow"
            placeholder='e.g. "I bought another box of Deathshroud Terminators"'
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? "…" : "Apply"}
          </button>
        </div>

        <div className="hints" style={{ marginTop: 9 }}>
          {[
            "I bought another box of Deathshroud Terminators",
            "I painted 5 Plague Marines",
            "I have 3 Rhinos",
          ].map((h) => (
            <button key={h} className="hint" onClick={() => setText(h)}>
              {h}
            </button>
          ))}
        </div>

        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

        {log.length > 0 && (
          <div className="pre" style={{ marginTop: 12 }}>
            {log.slice(-8).join("\n")}
          </div>
        )}

        {!status?.llm.available && (
          <p className="faint small" style={{ marginTop: 8 }}>
            No local model running — common phrasings still work through the
            pattern parser.
          </p>
        )}
      </div>

      <h2>Shelf</h2>
      {items.length === 0 ? (
        <div className="empty">Nothing recorded yet.</div>
      ) : (
        items.map((i) => (
          <div className="list-item" key={i.id}>
            <div className="grow">
              <div className="row" style={{ gap: 8 }}>
                <strong>{i.customName ?? i.ref.name}</strong>
                {!i.ref.resolved && <span className="tag warnish">unconfirmed</span>}
              </div>
              <div className="faint small">
                {i.ref.faction ?? "Unknown faction"}
                {i.wargear.length > 0 ? ` · ${i.wargear.join(", ")}` : ""}
                {i.notes ? ` · ${i.notes}` : ""}
              </div>
            </div>
            <span className="mono small dim">
              {i.painted}/{i.quantity} painted
            </span>
            <button
              className="btn sm danger"
              onClick={() => {
                void api.deleteCollectionItem(i.id).then(refresh);
              }}
            >
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );
}
