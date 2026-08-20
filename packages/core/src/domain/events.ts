/**
 * GameEvents are the only way battle state ever changes.
 *
 * State is a left fold over the event log, which is what makes replay, undo,
 * audit, correction and Chronicle generation fall out for free rather than
 * needing separate machinery. Nothing outside `reducer.ts` may mutate a
 * BattleState.
 */

import type { ActiveEffect, Objective, PlayerSide, Phase } from "./types.js";

/** Where an event came from — used for debugging the AI and for undo grouping. */
export type EventSource =
  | "natural_language"
  | "voice"
  | "ui"
  | "system"
  | "correction";

export interface GameEventBase {
  id: string;
  gameId: string;
  /** Monotonic per-battle. Assigned by the store, not the caller. */
  seq: number;
  createdAt: string;
  source: EventSource;
  /** Exactly what the user typed/said, when there was one. */
  rawInput?: string;
  /**
   * Groups events applied together from a single utterance, so undo can peel
   * off the whole action rather than one third of it.
   */
  batchId?: string;
  /** Set when this event has been undone; kept for audit rather than deleted. */
  undone?: boolean;
}

// --- Battle lifecycle -------------------------------------------------------

export interface BattleStartedEvent extends GameEventBase {
  type: "battle_started";
  name: string;
  edition: import("./types.js").Edition;
  armies: Record<PlayerSide, { armyId?: string; name: string; faction: string }>;
  startingCp: Record<PlayerSide, number>;
  objectives: Objective[];
}

export interface BattleEndedEvent extends GameEventBase {
  type: "battle_ended";
  winner?: PlayerSide | "draw";
  reason?: string;
}

export interface UnitDeployedEvent extends GameEventBase {
  type: "unit_deployed";
  unitId: string;
  side: PlayerSide;
  name: string;
  ref: import("./types.js").OracleRef;
  modelsTotal: number;
  woundsPerModel: number;
  position?: string;
  armyEntryId?: string;
}

// --- Turn structure ---------------------------------------------------------

export interface PhaseChangedEvent extends GameEventBase {
  type: "phase_changed";
  phase: Phase;
  /** Present when the phase change also rolled the turn/round over. */
  round?: number;
  activePlayer?: PlayerSide;
}

export interface TurnChangedEvent extends GameEventBase {
  type: "turn_changed";
  round: number;
  activePlayer: PlayerSide;
}

// --- Unit actions -----------------------------------------------------------

export interface UnitMovedEvent extends GameEventBase {
  type: "unit_moved";
  unitId: string;
  position?: string;
  advanced?: boolean;
  fellBack?: boolean;
  /** Inches, when the user gave a number. */
  distance?: number;
}

export interface ShootingStartedEvent extends GameEventBase {
  type: "shooting_started";
  attackerUnitId: string;
  targetUnitId: string;
  weaponName?: string;
  /** What the app worked out and told the user to roll. */
  attacks?: number;
  hitOn?: number;
}

export interface FightStartedEvent extends GameEventBase {
  type: "fight_started";
  attackerUnitId: string;
  targetUnitId: string;
  weaponName?: string;
  attacks?: number;
  hitOn?: number;
}

export interface ChargeDeclaredEvent extends GameEventBase {
  type: "charge_declared";
  unitId: string;
  targetUnitId?: string;
  succeeded?: boolean;
  rolled?: number;
}

/** Player reporting dice results back mid-sequence ("I got 10 hits"). */
export interface RollResultEvent extends GameEventBase {
  type: "roll_result";
  unitId?: string;
  kind: "hit" | "wound" | "save" | "damage" | "charge" | "advance" | "other";
  successes?: number;
  total?: number;
  values?: number[];
  note?: string;
}

export interface DamageAppliedEvent extends GameEventBase {
  type: "damage_applied";
  targetUnitId: string;
  amount: number;
  sourceUnitId?: string;
  mortal?: boolean;
}

export interface ModelsDestroyedEvent extends GameEventBase {
  type: "models_destroyed";
  unitId: string;
  count: number;
  killedByUnitId?: string;
}

export interface UnitDestroyedEvent extends GameEventBase {
  type: "unit_destroyed";
  unitId: string;
  killedByUnitId?: string;
}

export interface UnitHealedEvent extends GameEventBase {
  type: "unit_healed";
  unitId: string;
  wounds?: number;
  modelsReturned?: number;
}

// --- Resources & scoring ----------------------------------------------------

export interface CommandPointsChangedEvent extends GameEventBase {
  type: "command_points_changed";
  side: PlayerSide;
  delta: number;
  reason?: string;
}

export interface VictoryPointsChangedEvent extends GameEventBase {
  type: "victory_points_changed";
  side: PlayerSide;
  delta: number;
  reason?: string;
}

export interface ObjectiveClaimedEvent extends GameEventBase {
  type: "objective_claimed";
  objectiveId: string;
  objectiveName?: string;
  side: PlayerSide | null;
}

// --- Rules interactions -----------------------------------------------------

export interface AbilityUsedEvent extends GameEventBase {
  type: "ability_used";
  unitId?: string;
  side?: PlayerSide;
  name: string;
  targetUnitId?: string;
  note?: string;
}

export interface StratagemUsedEvent extends GameEventBase {
  type: "stratagem_used";
  side: PlayerSide;
  name: string;
  cpCost: number;
  unitId?: string;
  targetUnitId?: string;
}

export interface EffectAppliedEvent extends GameEventBase {
  type: "effect_applied";
  unitId: string;
  effect: ActiveEffect;
}

export interface EffectRemovedEvent extends GameEventBase {
  type: "effect_removed";
  unitId: string;
  effectId: string;
}

export interface BattleShockEvent extends GameEventBase {
  type: "battle_shock";
  unitId: string;
  shocked: boolean;
  rolled?: number;
}

/** Free-form annotation. Never changes state; shows in the feed and Chronicle. */
export interface NoteRecordedEvent extends GameEventBase {
  type: "note_recorded";
  text: string;
  unitId?: string;
}

export type GameEvent =
  | BattleStartedEvent
  | BattleEndedEvent
  | UnitDeployedEvent
  | PhaseChangedEvent
  | TurnChangedEvent
  | UnitMovedEvent
  | ShootingStartedEvent
  | FightStartedEvent
  | ChargeDeclaredEvent
  | RollResultEvent
  | DamageAppliedEvent
  | ModelsDestroyedEvent
  | UnitDestroyedEvent
  | UnitHealedEvent
  | CommandPointsChangedEvent
  | VictoryPointsChangedEvent
  | ObjectiveClaimedEvent
  | AbilityUsedEvent
  | StratagemUsedEvent
  | EffectAppliedEvent
  | EffectRemovedEvent
  | BattleShockEvent
  | NoteRecordedEvent;

export type GameEventType = GameEvent["type"];

/**
 * What the caller supplies; the store fills in id/seq/createdAt/gameId.
 *
 * Distributes over the union — a plain `Omit` on a union collapses to the keys
 * every member shares, which would throw away every event's own payload.
 */
export type NewGameEvent<T extends GameEvent = GameEvent> = T extends unknown
  ? Omit<T, "id" | "seq" | "createdAt" | "gameId"> & { gameId?: string }
  : never;

/** Events the feed should render as a battle beat rather than chat noise. */
const MAJOR: ReadonlySet<GameEventType> = new Set<GameEventType>([
  "battle_started",
  "battle_ended",
  "phase_changed",
  "turn_changed",
  "models_destroyed",
  "unit_destroyed",
  "stratagem_used",
  "objective_claimed",
  "battle_shock",
]);

export function isMajorEvent(e: GameEvent): boolean {
  return MAJOR.has(e.type);
}
