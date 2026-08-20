/**
 * The one place battle state changes.
 *
 * Pure and total: (state, event) -> state, no I/O, no clock, no randomness.
 * That is what lets us rebuild any battle by replaying its log, and lets undo
 * be "replay everything except the events marked undone".
 *
 * The LLM never reaches in here. It produces intents; intents become events;
 * events land here. Anything the model hallucinates is filtered out upstream.
 */

import type { GameEvent } from "./events.js";
import {
  freshActivation,
  OTHER_SIDE,
  PHASE_ORDER,
  type BattleState,
  type BattleUnit,
  type PlayerSide,
} from "./types.js";

function emptyState(): BattleState {
  return {
    id: "",
    name: "Untitled Battle",
    edition: "40k_11e",
    round: 1,
    activePlayer: "player",
    phase: "command",
    cp: { player: 0, opponent: 0 },
    vp: { player: 0, opponent: 0 },
    armies: {
      player: { name: "Player", faction: "Unknown" },
      opponent: { name: "Opponent", faction: "Unknown" },
    },
    units: [],
    objectives: [],
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Structural clone that keeps the unit array cheap to update in place. */
function cloneState(s: BattleState): BattleState {
  return {
    ...s,
    cp: { ...s.cp },
    vp: { ...s.vp },
    armies: { player: { ...s.armies.player }, opponent: { ...s.armies.opponent } },
    units: s.units.map((u) => ({
      ...u,
      ref: { ...u.ref },
      activation: { ...u.activation },
      effects: u.effects.map((e) => ({ ...e })),
      attachedLeaderIds: [...u.attachedLeaderIds],
      usedAbilities: [...u.usedAbilities],
    })),
    objectives: s.objectives.map((o) => ({ ...o })),
  };
}

function withUnit(
  state: BattleState,
  unitId: string,
  fn: (u: BattleUnit) => void,
): void {
  const unit = state.units.find((u) => u.id === unitId);
  if (unit) fn(unit);
}

/**
 * Total wounds a unit can still take before it is wiped. Warhammer removes
 * whole models, so the pool is (whole models - 1) * W + remaining on the
 * damaged model.
 */
export function remainingWounds(u: BattleUnit): number {
  if (u.destroyed || u.modelsAlive <= 0) return 0;
  return u.modelsAlive * u.woundsPerModel - u.woundsTakenOnLeadModel;
}

/**
 * Apply `amount` damage, spilling across models the way casualty removal does.
 * Returns how many models died, so the caller can emit ModelsDestroyed.
 */
function applyDamageToUnit(u: BattleUnit, amount: number): number {
  if (u.destroyed || amount <= 0) return 0;
  const before = u.modelsAlive;
  let pool = u.woundsTakenOnLeadModel + amount;

  const modelsKilled = Math.floor(pool / u.woundsPerModel);
  const leftover = pool % u.woundsPerModel;

  if (modelsKilled >= u.modelsAlive) {
    u.modelsAlive = 0;
    u.woundsTakenOnLeadModel = 0;
    u.destroyed = true;
    return before;
  }

  u.modelsAlive -= modelsKilled;
  u.woundsTakenOnLeadModel = leftover;
  return modelsKilled;
}

/** Clear activation flags for the side about to act. */
function resetActivations(state: BattleState, side: PlayerSide): void {
  for (const u of state.units) {
    if (u.side === side) u.activation = freshActivation();
  }
}

/** Drop effects whose expiry round has passed. */
function expireEffects(state: BattleState): void {
  for (const u of state.units) {
    u.effects = u.effects.filter(
      (e) => e.expiresAtRound === undefined || e.expiresAtRound > state.round,
    );
  }
}

export function applyEvent(prev: BattleState, event: GameEvent): BattleState {
  // Undone events are kept in the log for audit but contribute nothing.
  if (event.undone) return prev;

  const s = cloneState(prev);
  s.updatedAt = event.createdAt;

  switch (event.type) {
    case "battle_started": {
      s.id = event.gameId;
      s.name = event.name;
      s.edition = event.edition;
      s.armies = event.armies;
      s.cp = { ...event.startingCp };
      s.objectives = event.objectives.map((o) => ({ ...o }));
      s.createdAt = event.createdAt;
      s.round = 1;
      s.phase = "command";
      s.activePlayer = "player";
      s.status = "active";
      break;
    }

    case "battle_ended": {
      s.status = "complete";
      s.winner = event.winner;
      break;
    }

    case "unit_deployed": {
      // Replay must be idempotent on identity, so skip a duplicate id.
      if (s.units.some((u) => u.id === event.unitId)) break;
      s.units.push({
        id: event.unitId,
        side: event.side,
        ref: event.ref,
        name: event.name,
        modelsTotal: event.modelsTotal,
        modelsAlive: event.modelsTotal,
        woundsPerModel: event.woundsPerModel,
        woundsTakenOnLeadModel: 0,
        activation: freshActivation(),
        effects: [],
        position: event.position,
        attachedLeaderIds: [],
        destroyed: false,
        usedAbilities: [],
        armyEntryId: event.armyEntryId,
      });
      break;
    }

    case "phase_changed": {
      s.phase = event.phase;
      if (event.round !== undefined) s.round = event.round;
      if (event.activePlayer !== undefined) {
        s.activePlayer = event.activePlayer;
        resetActivations(s, event.activePlayer);
      }
      expireEffects(s);
      break;
    }

    case "turn_changed": {
      s.round = event.round;
      s.activePlayer = event.activePlayer;
      s.phase = "command";
      resetActivations(s, event.activePlayer);
      expireEffects(s);
      break;
    }

    case "unit_moved": {
      withUnit(s, event.unitId, (u) => {
        u.activation.moved = true;
        if (event.advanced) u.activation.advanced = true;
        if (event.fellBack) u.activation.fellBack = true;
        if (event.position !== undefined) u.position = event.position;
      });
      break;
    }

    case "shooting_started": {
      withUnit(s, event.attackerUnitId, (u) => {
        u.activation.shot = true;
      });
      break;
    }

    case "fight_started": {
      withUnit(s, event.attackerUnitId, (u) => {
        u.activation.fought = true;
      });
      break;
    }

    case "charge_declared": {
      withUnit(s, event.unitId, (u) => {
        if (event.succeeded !== false) u.activation.charged = true;
      });
      break;
    }

    case "damage_applied": {
      withUnit(s, event.targetUnitId, (u) => {
        applyDamageToUnit(u, event.amount);
      });
      break;
    }

    case "models_destroyed": {
      withUnit(s, event.unitId, (u) => {
        u.modelsAlive = Math.max(0, u.modelsAlive - event.count);
        u.woundsTakenOnLeadModel = 0;
        if (u.modelsAlive === 0) u.destroyed = true;
      });
      break;
    }

    case "unit_destroyed": {
      withUnit(s, event.unitId, (u) => {
        u.modelsAlive = 0;
        u.woundsTakenOnLeadModel = 0;
        u.destroyed = true;
      });
      break;
    }

    case "unit_healed": {
      withUnit(s, event.unitId, (u) => {
        if (event.wounds) {
          u.woundsTakenOnLeadModel = Math.max(
            0,
            u.woundsTakenOnLeadModel - event.wounds,
          );
        }
        if (event.modelsReturned) {
          u.modelsAlive = Math.min(
            u.modelsTotal,
            u.modelsAlive + event.modelsReturned,
          );
          if (u.modelsAlive > 0) u.destroyed = false;
        }
      });
      break;
    }

    case "command_points_changed": {
      s.cp[event.side] = Math.max(0, s.cp[event.side] + event.delta);
      break;
    }

    case "victory_points_changed": {
      s.vp[event.side] = Math.max(0, s.vp[event.side] + event.delta);
      break;
    }

    case "objective_claimed": {
      const obj = s.objectives.find((o) => o.id === event.objectiveId);
      if (obj) {
        obj.controlledBy = event.side;
      } else {
        s.objectives.push({
          id: event.objectiveId,
          name: event.objectiveName ?? event.objectiveId,
          controlledBy: event.side,
        });
      }
      break;
    }

    case "stratagem_used": {
      s.cp[event.side] = Math.max(0, s.cp[event.side] - event.cpCost);
      if (event.unitId) {
        withUnit(s, event.unitId, (u) => {
          u.usedAbilities.push(event.name);
        });
      }
      break;
    }

    case "ability_used": {
      if (event.unitId) {
        withUnit(s, event.unitId, (u) => {
          u.usedAbilities.push(event.name);
        });
      }
      break;
    }

    case "effect_applied": {
      withUnit(s, event.unitId, (u) => {
        u.effects = u.effects.filter((e) => e.id !== event.effect.id);
        u.effects.push({ ...event.effect });
      });
      break;
    }

    case "effect_removed": {
      withUnit(s, event.unitId, (u) => {
        u.effects = u.effects.filter((e) => e.id !== event.effectId);
      });
      break;
    }

    case "battle_shock": {
      withUnit(s, event.unitId, (u) => {
        u.activation.battleShocked = event.shocked;
      });
      break;
    }

    // Recorded for history and Chronicle, but carry no state change.
    case "roll_result":
    case "note_recorded":
      break;
  }

  return s;
}

/** Rebuild a battle from its log. This is the only constructor of BattleState. */
export function replay(events: readonly GameEvent[]): BattleState {
  return events.reduce<BattleState>(applyEvent, emptyState());
}

/** Next phase in sequence, rolling into the other player's turn at the end. */
export function advancePhase(state: BattleState): {
  phase: BattleState["phase"];
  round: number;
  activePlayer: PlayerSide;
} {
  const idx = PHASE_ORDER.indexOf(state.phase);
  const isLast = idx === PHASE_ORDER.length - 1;
  if (!isLast) {
    return {
      phase: PHASE_ORDER[idx + 1]!,
      round: state.round,
      activePlayer: state.activePlayer,
    };
  }
  const nextPlayer = OTHER_SIDE[state.activePlayer];
  // A round is both players' turns; the round ticks when it comes back around.
  const nextRound = nextPlayer === "player" ? state.round + 1 : state.round;
  return { phase: "command", round: nextRound, activePlayer: nextPlayer };
}
