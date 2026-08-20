/**
 * Chronicle is derived, never entered.
 *
 * Every statistic here is a fold over the event log, which means it cannot
 * disagree with what happened — and a corrected or undone event changes the
 * history automatically. Only the prose summary comes from the model, and it is
 * given the computed numbers rather than being asked to count.
 */

import type { GameEvent } from "../domain/events.js";
import { replay } from "../domain/reducer.js";
import type { ChronicleEntry, PlayerSide } from "../domain/types.js";
import type { Repository } from "../db/repository.js";
import type { LLMProvider } from "../ai/provider.js";

function zero(): Record<PlayerSide, number> {
  return { player: 0, opponent: 0 };
}

export function buildChronicleEntry(events: GameEvent[]): ChronicleEntry | null {
  const live = events.filter((e) => !e.undone);
  if (live.length === 0) return null;

  const state = replay(live);
  const start = live.find((e) => e.type === "battle_started");
  if (!start) return null;

  const sideOf = (unitId?: string): PlayerSide | null =>
    state.units.find((u) => u.id === unitId)?.side ?? null;

  const stats: ChronicleEntry["stats"] = {
    totalDamageDealt: zero(),
    unitsDestroyed: zero(),
    modelsSlain: zero(),
    stratagemsUsed: zero(),
    cpSpent: zero(),
  };

  const highlights: string[] = [];
  const damageByUnit = new Map<string, number>();

  for (const e of live) {
    switch (e.type) {
      case "damage_applied": {
        // Damage is credited to whoever was NOT holding the unit that took it.
        const victim = sideOf(e.targetUnitId);
        if (victim) {
          const dealer: PlayerSide = victim === "player" ? "opponent" : "player";
          stats.totalDamageDealt[dealer] += e.amount;
        }
        if (e.sourceUnitId) {
          damageByUnit.set(
            e.sourceUnitId,
            (damageByUnit.get(e.sourceUnitId) ?? 0) + e.amount,
          );
        }
        break;
      }
      case "models_destroyed": {
        const victim = sideOf(e.unitId);
        if (victim) {
          stats.modelsSlain[victim === "player" ? "opponent" : "player"] += e.count;
        }
        break;
      }
      case "unit_destroyed": {
        const victim = sideOf(e.unitId);
        const name = state.units.find((u) => u.id === e.unitId)?.name;
        if (victim) {
          stats.unitsDestroyed[victim === "player" ? "opponent" : "player"] += 1;
        }
        if (name) highlights.push(`${name} was destroyed.`);
        break;
      }
      case "stratagem_used": {
        stats.stratagemsUsed[e.side] += 1;
        stats.cpSpent[e.side] += e.cpCost;
        highlights.push(
          `${e.side === "player" ? "You" : "The opponent"} used ${e.name} (${e.cpCost}CP).`,
        );
        break;
      }
      case "objective_claimed": {
        if (e.side) {
          highlights.push(
            `${e.objectiveName ?? "An objective"} was taken by ${
              e.side === "player" ? "you" : "the opponent"
            }.`,
          );
        }
        break;
      }
      case "battle_shock": {
        if (e.shocked) {
          const name = state.units.find((u) => u.id === e.unitId)?.name;
          if (name) highlights.push(`${name} failed Battle-shock.`);
        }
        break;
      }
      default:
        break;
    }
  }

  // Standout attacker, if any unit clearly did the most work.
  const topDamage = [...damageByUnit.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topDamage) {
    const name = state.units.find((u) => u.id === topDamage[0])?.name;
    if (name) {
      highlights.unshift(`${name} dealt ${topDamage[1]} damage across the game.`);
    }
  }

  const ended = live.find(
    (e): e is Extract<GameEvent, { type: "battle_ended" }> =>
      e.type === "battle_ended",
  );

  return {
    battleId: state.id,
    battleName: state.name,
    edition: state.edition,
    playedAt: state.createdAt,
    status: state.status,
    winner: ended?.winner ?? state.winner,
    rounds: state.round,
    finalVp: { ...state.vp },
    armies: {
      player: {
        name: state.armies.player.name,
        faction: state.armies.player.faction,
      },
      opponent: {
        name: state.armies.opponent.name,
        faction: state.armies.opponent.faction,
      },
    },
    stats,
    highlights: highlights.slice(0, 12),
  };
}

export class ChronicleService {
  constructor(
    private readonly repo: Repository,
    private readonly llm: LLMProvider | null = null,
  ) {}

  list(): ChronicleEntry[] {
    return this.repo
      .listBattles(100)
      .map((b) => buildChronicleEntry(this.repo.getEvents(b.id)))
      .filter((e): e is ChronicleEntry => e !== null);
  }

  get(battleId: string): ChronicleEntry | null {
    return buildChronicleEntry(this.repo.getEvents(battleId));
  }

  /** Prose over the computed stats. The model narrates; it does not count. */
  async narrate(battleId: string): Promise<ChronicleEntry | null> {
    const entry = this.get(battleId);
    if (!entry) return null;
    if (!this.llm) return entry;

    const facts = [
      `Battle: ${entry.battleName} (${entry.edition})`,
      `${entry.armies.player.name} (${entry.armies.player.faction}) vs ${entry.armies.opponent.name} (${entry.armies.opponent.faction})`,
      `Rounds played: ${entry.rounds}`,
      `Victory points — you ${entry.finalVp.player}, opponent ${entry.finalVp.opponent}`,
      `Units destroyed — by you ${entry.stats.unitsDestroyed.player}, by them ${entry.stats.unitsDestroyed.opponent}`,
      `Models slain — by you ${entry.stats.modelsSlain.player}, by them ${entry.stats.modelsSlain.opponent}`,
      `Damage dealt — you ${entry.stats.totalDamageDealt.player}, them ${entry.stats.totalDamageDealt.opponent}`,
      `CP spent — you ${entry.stats.cpSpent.player}, them ${entry.stats.cpSpent.opponent}`,
      entry.winner ? `Result: ${entry.winner}` : "Result: unfinished",
      "",
      "Notable moments:",
      ...entry.highlights.map((h) => `- ${h}`),
    ].join("\n");

    try {
      const narrative = await this.llm.chat(
        [
          {
            role: "system",
            content:
              "Write a short battle report — two paragraphs, past tense, grounded. " +
              "Use only the facts given; invent no events, names, or numbers. " +
              "Some grim Warhammer flavour is welcome but keep it terse.",
          },
          { role: "user", content: facts },
        ],
        { temperature: 0.6 },
      );
      return { ...entry, narrative: narrative.trim() };
    } catch {
      return entry;
    }
  }
}
