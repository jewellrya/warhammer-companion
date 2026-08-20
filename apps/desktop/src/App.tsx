import { useCallback, useEffect, useState } from "react";
import { api, type BackendStatus } from "./api.js";
import { HomeScreen } from "./screens/Home.js";
import { BattleScreen } from "./screens/Battle.js";
import { ArmiesScreen } from "./screens/Armies.js";
import { CollectionScreen } from "./screens/Collection.js";
import { RulesScreen } from "./screens/Rules.js";
import { ChronicleScreen } from "./screens/Chronicle.js";

export type Screen =
  | "home"
  | "battle"
  | "armies"
  | "collection"
  | "rules"
  | "chronicle";

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "◈" },
  { id: "battle", label: "Battle", icon: "⚔" },
  { id: "armies", label: "Armies", icon: "▤" },
  { id: "collection", label: "Collection", icon: "▣" },
  { id: "rules", label: "Rules", icon: "◉" },
  { id: "chronicle", label: "Chronicle", icon: "✦" },
];

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>("home");
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [activeBattleId, setActiveBattleId] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setFatal(null);
      return true;
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  /*
   * The desktop shell starts the core as a child process, and the webview is
   * ready long before it is — the first status call reliably fails on a cold
   * start. Keep retrying quietly instead of leaving the user on an error
   * screen with a button to press.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const attempt = async (elapsed: number): Promise<void> => {
      if (cancelled) return;
      const ok = await loadStatus();
      if (ok || cancelled || elapsed > 60_000) return;
      timer = window.setTimeout(() => void attempt(elapsed + 1500), 1500);
    };

    void attempt(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadStatus]);

  /** Opening a battle from any screen jumps straight to the table. */
  const openBattle = useCallback((id: string) => {
    setActiveBattleId(id);
    setScreen("battle");
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span>Warhammer</span>
          <span>Companion</span>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={screen === item.id ? "active" : ""}
              onClick={() => setScreen(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ServiceLight
            label={
              status?.oracle.available
                ? `Oracle · ${status.oracle.tools.length}`
                : "Oracle offline"
            }
            state={status?.oracle.available ? "on" : "off"}
          />
          <ServiceLight
            label={
              status?.llm.available
                ? `LLM · ${shortModel(status.llm.model)}`
                : "Rules-only mode"
            }
            state={status?.llm.available ? "on" : "warn"}
          />
          <ServiceLight
            label={status ? editionShort(status.edition) : "…"}
            state={status ? "on" : "off"}
          />
        </div>
      </aside>

      <main className="main">
        {fatal ? (
          <div className="page">
            <div className="err">{fatal}</div>
            <p className="sub" style={{ marginTop: 12 }}>
              Still trying — the local service takes a few seconds to start.
              If it doesn't appear, run{" "}
              <code className="mono">pnpm dev:server</code> and{" "}
              <button className="btn sm" onClick={() => void loadStatus()}>
                retry
              </button>
            </p>
          </div>
        ) : screen === "home" ? (
          <HomeScreen
            status={status}
            onOpenBattle={openBattle}
            onNavigate={setScreen}
            onStatusChange={loadStatus}
          />
        ) : screen === "battle" ? (
          <BattleScreen
            battleId={activeBattleId}
            onOpenBattle={openBattle}
            onNavigate={setScreen}
          />
        ) : screen === "armies" ? (
          <ArmiesScreen status={status} />
        ) : screen === "collection" ? (
          <CollectionScreen status={status} />
        ) : screen === "rules" ? (
          <RulesScreen status={status} battleId={activeBattleId} />
        ) : (
          <ChronicleScreen onOpenBattle={openBattle} />
        )}
      </main>
    </div>
  );
}

function ServiceLight({
  label,
  state,
}: {
  label: string;
  state: "on" | "off" | "warn";
}): JSX.Element {
  return (
    <div className="svc">
      <span className={`dot ${state === "on" ? "on" : state === "warn" ? "warn" : ""}`} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function shortModel(m: string): string {
  return m.split(":")[0] ?? m;
}

function editionShort(e: string): string {
  return e === "40k_11e"
    ? "40K 11e"
    : e === "40k_10e"
      ? "40K 10e"
      : e === "kill_team"
        ? "Kill Team"
        : "Combat Patrol";
}
