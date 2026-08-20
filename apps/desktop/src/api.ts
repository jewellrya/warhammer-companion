/**
 * Typed client for the local API.
 *
 * Types are declared here rather than imported from @wh/core so the UI can be
 * bundled without pulling in node-only dependencies (better-sqlite3, the MCP
 * stdio transport). They mirror the core domain deliberately.
 */

export type Edition = "40k_11e" | "40k_10e" | "combat_patrol" | "kill_team";
export type PlayerSide = "player" | "opponent";
export type Phase =
  | "command"
  | "movement"
  | "shooting"
  | "charge"
  | "fight"
  | "end";

export const PHASE_ORDER: Phase[] = [
  "command",
  "movement",
  "shooting",
  "charge",
  "fight",
  "end",
];

export const EDITION_LABELS: Record<Edition, string> = {
  "40k_11e": "40K 11th Ed",
  "40k_10e": "40K 10th Ed",
  combat_patrol: "Combat Patrol",
  kill_team: "Kill Team",
};

export interface OracleRef {
  name: string;
  faction?: string;
  edition: Edition;
  resolved: boolean;
}

export interface UnitActivation {
  moved: boolean;
  advanced: boolean;
  fellBack: boolean;
  shot: boolean;
  charged: boolean;
  fought: boolean;
  battleShocked: boolean;
}

export interface BattleUnit {
  id: string;
  side: PlayerSide;
  ref: OracleRef;
  name: string;
  modelsTotal: number;
  modelsAlive: number;
  woundsPerModel: number;
  woundsTakenOnLeadModel: number;
  activation: UnitActivation;
  effects: { id: string; name: string; description?: string }[];
  position?: string;
  destroyed: boolean;
  usedAbilities: string[];
}

export interface Objective {
  id: string;
  name: string;
  controlledBy: PlayerSide | null;
}

export interface BattleState {
  id: string;
  name: string;
  edition: Edition;
  round: number;
  activePlayer: PlayerSide;
  phase: Phase;
  cp: Record<PlayerSide, number>;
  vp: Record<PlayerSide, number>;
  armies: Record<PlayerSide, { armyId?: string; name: string; faction: string }>;
  units: BattleUnit[];
  objectives: Objective[];
  status: "active" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface GameEvent {
  id: string;
  gameId: string;
  seq: number;
  type: string;
  createdAt: string;
  source: string;
  rawInput?: string;
  batchId?: string;
  undone?: boolean;
  [k: string]: unknown;
}

export interface SourceCitation {
  provider: string;
  tool: string;
  edition: Edition;
  query: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface TurnResult {
  reply: string;
  events: GameEvent[];
  eventDescriptions: string[];
  state: BattleState | null;
  intent?: { intent: string; [k: string]: unknown };
  needsClarification?: { question: string; options?: string[] };
  citations?: SourceCitation[];
  debug?: { interpreter: string; raw?: string; confidence?: number };
}

export interface BackendStatus {
  oracle: { available: boolean; tools: string[]; error?: string };
  llm: {
    available: boolean;
    provider: string;
    model: string;
    models: string[];
  };
  interpreter: string;
  edition: Edition;
  dbPath: string;
}

export interface ArmyUnitEntry {
  id: string;
  ref: OracleRef;
  modelCount: number;
  points?: number;
  wargear: string[];
  enhancement?: string;
  isWarlord?: boolean;
}

export interface Army {
  id: string;
  name: string;
  faction: string;
  detachment?: string;
  edition: Edition;
  pointsLimit?: number;
  units: ArmyUnitEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItem {
  id: string;
  ref: OracleRef;
  quantity: number;
  wargear: string[];
  painted: number;
  customName?: string;
  notes?: string;
  updatedAt: string;
}

export interface ChronicleEntry {
  battleId: string;
  battleName: string;
  edition: Edition;
  playedAt: string;
  status: "active" | "complete";
  winner?: PlayerSide | "draw";
  rounds: number;
  finalVp: Record<PlayerSide, number>;
  armies: Record<PlayerSide, { name: string; faction: string }>;
  stats: {
    totalDamageDealt: Record<PlayerSide, number>;
    unitsDestroyed: Record<PlayerSide, number>;
    modelsSlain: Record<PlayerSide, number>;
    stratagemsUsed: Record<PlayerSide, number>;
    cpSpent: Record<PlayerSide, number>;
  };
  highlights: string[];
  narrative?: string;
}

export interface BattleSummary {
  id: string;
  name: string;
  edition: Edition;
  status: "active" | "complete";
  createdAt: string;
  updatedAt: string;
  snapshot?: BattleState;
}

export interface RulesAnswer {
  text: string;
  citations: SourceCitation[];
  sources: { title: string; body: string }[];
}

export interface UnitData {
  name: string;
  faction: string;
  points: number | null;
  unitSize: { min: number; max: number };
  profiles: {
    name: string;
    movement: string;
    toughness: string;
    save: string;
    wounds: string;
    leadership: string;
    objectiveControl: string;
  }[];
  weapons: {
    name: string;
    range: string;
    attacks: string;
    skill: string;
    strength: string;
    armourPenetration: string;
    damage: string;
    keywords: string[];
    kind: "ranged" | "melee";
  }[];
  abilities: { name: string; description: string }[];
  keywords: string[];
  raw: string;
}

/** Server errors arrive as `{error}`; surface the message, not "500". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * In the browser, Vite proxies `/api` to the core, so relative paths work. The
 * Tauri webview has no proxy and is served from its own origin, so it needs the
 * absolute loopback URL (allowed by the CSP in tauri.conf.json).
 */
const API_BASE: string =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? "http://127.0.0.1:8787"
    : "";

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      "Can't reach the local service. Is the companion server running?",
    );
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  status: () => request<BackendStatus>("GET", "/api/status"),
  refreshStatus: () => request<BackendStatus>("POST", "/api/status/refresh"),

  listBattles: () => request<BattleSummary[]>("GET", "/api/battles"),
  createBattle: (input: {
    name?: string;
    edition?: Edition;
    playerArmyId?: string;
    opponentArmyId?: string;
  }) => request<BattleState>("POST", "/api/battles", input),
  getBattle: (id: string) =>
    request<{
      state: BattleState;
      events: GameEvent[];
      messages: ChatMessage[];
    }>("GET", `/api/battles/${id}`),
  deleteBattle: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/battles/${id}`),
  sendInput: (id: string, text: string) =>
    request<TurnResult>("POST", `/api/battles/${id}/input`, { text }),
  sendIntent: (id: string, intent: Record<string, unknown>, label?: string) =>
    request<TurnResult>("POST", `/api/battles/${id}/intent`, { intent, label }),
  undo: (id: string) => request<TurnResult>("POST", `/api/battles/${id}/undo`),

  listArmies: () => request<Army[]>("GET", "/api/armies"),
  importArmy: (text: string, name?: string, edition?: Edition) =>
    request<{
      army: Army;
      unresolved: string[];
      method: string;
      warnings: string[];
    }>("POST", "/api/armies/import", { text, name, edition }),
  deleteArmy: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/armies/${id}`),

  listCollection: () => request<CollectionItem[]>("GET", "/api/collection"),
  collectionInput: (text: string) =>
    request<{ item: CollectionItem; reply: string; created: boolean }>(
      "POST",
      "/api/collection/input",
      { text },
    ),
  deleteCollectionItem: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/collection/${id}`),

  chronicle: () => request<ChronicleEntry[]>("GET", "/api/chronicle"),
  narrate: (id: string) =>
    request<ChronicleEntry>("POST", `/api/chronicle/${id}/narrate`),

  ask: (question: string, battleId?: string) =>
    request<RulesAnswer>("POST", "/api/oracle/ask", { question, battleId }),
  lookupUnit: (name: string, faction?: string, edition?: Edition) =>
    request<{ data: UnitData; source: SourceCitation }>(
      "POST",
      "/api/oracle/unit",
      { name, faction, edition },
    ),
  searchUnits: (query: string, faction?: string) =>
    request<{
      data: { name: string; faction: string; points: number | null; keywords: string[] }[];
      source: SourceCitation;
    }>("POST", "/api/oracle/search", { query, faction }),

  seed: () =>
    request<{ battleId: string; armies: { id: string; name: string; unresolved: string[] }[] }>(
      "POST",
      "/api/seed",
    ),
};
