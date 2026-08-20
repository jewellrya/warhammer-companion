/**
 * Core domain vocabulary.
 *
 * Nothing here copies Oracle data. Anything the Oracle owns (statlines, weapon
 * profiles, ability text, points) is referenced by `OracleRef` and fetched on
 * demand. What we store is the stuff Oracle cannot know: what the player owns,
 * what they brought, and what is happening on the table right now.
 */

/** Which ruleset is live. Threaded into every Oracle call. */
export type Edition = "40k_11e" | "40k_10e" | "combat_patrol" | "kill_team";

export const EDITIONS: readonly Edition[] = [
  "40k_11e",
  "40k_10e",
  "combat_patrol",
  "kill_team",
] as const;

export const EDITION_LABELS: Record<Edition, string> = {
  "40k_11e": "40K — 11th Edition",
  "40k_10e": "40K — 10th Edition",
  combat_patrol: "Combat Patrol",
  kill_team: "Kill Team",
};

/**
 * A pointer into the Warhammer data provider. `name` + `faction` is what Oracle
 * actually resolves by; `resolved` records whether a lookup has ever succeeded
 * so the UI can flag entries the AI guessed at.
 */
export interface OracleRef {
  name: string;
  faction?: string;
  edition: Edition;
  resolved: boolean;
  /** Last time a lookup confirmed this ref, ISO 8601. */
  resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// Collection — physical models the user owns
// ---------------------------------------------------------------------------

export interface CollectionItem {
  id: string;
  ref: OracleRef;
  /** How many models of this type are physically owned. */
  quantity: number;
  /** Wargear actually modelled on the minis, free text from the user. */
  wargear: string[];
  painted: number;
  /** User's own name for the squad ("Brother Kallus's lot"). */
  customName?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Army — a reusable list
// ---------------------------------------------------------------------------

export interface ArmyUnitEntry {
  id: string;
  ref: OracleRef;
  /** Models in this unit as listed. */
  modelCount: number;
  /** Points as written in the source list, not as Oracle computes them. */
  points?: number;
  wargear: string[];
  /** Enhancement name, resolved through Oracle when asked for. */
  enhancement?: string;
  isWarlord?: boolean;
  /** Entry id of the unit this character is attached to. */
  attachedTo?: string;
}

export interface Army {
  id: string;
  name: string;
  faction: string;
  detachment?: string;
  edition: Edition;
  pointsLimit?: number;
  units: ArmyUnitEntry[];
  /** The text the user pasted, kept verbatim for re-parsing and provenance. */
  sourceText?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Battle — live state, rebuilt from events
// ---------------------------------------------------------------------------

export type Phase =
  | "command"
  | "movement"
  | "shooting"
  | "charge"
  | "fight"
  | "end";

export const PHASE_ORDER: readonly Phase[] = [
  "command",
  "movement",
  "shooting",
  "charge",
  "fight",
  "end",
] as const;

export const PHASE_LABELS: Record<Phase, string> = {
  command: "Command",
  movement: "Movement",
  shooting: "Shooting",
  charge: "Charge",
  fight: "Fight",
  end: "End",
};

export type PlayerSide = "player" | "opponent";

/** Per-unit activation flags. Cleared at the start of each of that unit's turns. */
export interface UnitActivation {
  moved: boolean;
  advanced: boolean;
  fellBack: boolean;
  shot: boolean;
  charged: boolean;
  fought: boolean;
  battleShocked: boolean;
}

export function freshActivation(): UnitActivation {
  return {
    moved: false,
    advanced: false,
    fellBack: false,
    shot: false,
    charged: false,
    fought: false,
    battleShocked: false,
  };
}

export interface ActiveEffect {
  id: string;
  name: string;
  description?: string;
  /** Round the effect falls off. Omitted means it lasts until removed. */
  expiresAtRound?: number;
  source?: string;
}

/** A unit as it exists on the table right now. */
export interface BattleUnit {
  id: string;
  side: PlayerSide;
  ref: OracleRef;
  /** Display name; may be the user's nickname rather than the datasheet name. */
  name: string;
  modelsTotal: number;
  modelsAlive: number;
  /** Wounds per model, from Oracle at deploy time. */
  woundsPerModel: number;
  /** Damage on the currently-wounded model only. */
  woundsTakenOnLeadModel: number;
  activation: UnitActivation;
  effects: ActiveEffect[];
  /** Free-text where-it-is, because we are not modelling a 3D table. */
  position?: string;
  /** Unit ids of characters attached to this unit. */
  attachedLeaderIds: string[];
  /** Set when this unit is itself a leader inside another unit. */
  attachedToUnitId?: string;
  destroyed: boolean;
  /** Ability/stratagem names already used, for once-per-battle tracking. */
  usedAbilities: string[];
  armyEntryId?: string;
}

export interface Objective {
  id: string;
  name: string;
  /** Who currently holds it, or null for contested/empty. */
  controlledBy: PlayerSide | null;
}

export interface BattleState {
  id: string;
  name: string;
  edition: Edition;
  round: number;
  /** Whose turn it is within the round. */
  activePlayer: PlayerSide;
  phase: Phase;
  cp: Record<PlayerSide, number>;
  vp: Record<PlayerSide, number>;
  armies: Record<PlayerSide, { armyId?: string; name: string; faction: string }>;
  units: BattleUnit[];
  objectives: Objective[];
  status: "active" | "complete";
  winner?: PlayerSide | "draw";
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Chronicle — derived history
// ---------------------------------------------------------------------------

export interface ChronicleEntry {
  battleId: string;
  battleName: string;
  edition: Edition;
  playedAt: string;
  status: BattleState["status"];
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
  /** Standout moments, picked out of the event log deterministically. */
  highlights: string[];
  /** Prose summary. Written by the LLM when one is available. */
  narrative?: string;
}

export const OTHER_SIDE: Record<PlayerSide, PlayerSide> = {
  player: "opponent",
  opponent: "player",
};
