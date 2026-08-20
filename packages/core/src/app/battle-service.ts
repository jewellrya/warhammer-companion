/**
 * The pipeline from the brief, in one place:
 *
 *   natural language -> interpret -> intent -> resolve against state + Oracle
 *   -> deterministic events -> reducer -> SQLite -> UI
 *
 * The split that matters: `interpret` may be wrong, so everything it produces
 * passes through resolution and validation before becoming an event. Once an
 * event exists it is fact. Oracle is consulted for rules knowledge, never for
 * what is happening on the table.
 */

import { randomUUID } from "node:crypto";
import type { NewGameEvent, GameEvent } from "../domain/events.js";
import type { Intent } from "../domain/intent.js";
import { advancePhase, replay } from "../domain/reducer.js";
import { resolveObjective, resolveUnit, type ResolveResult } from "../domain/resolve.js";
import {
  OTHER_SIDE,
  type Army,
  type BattleState,
  type BattleUnit,
  type Edition,
  type PlayerSide,
} from "../domain/types.js";
import type { Interpreter, InterpreterContext } from "../ai/interpreter.js";
import type { LLMProvider } from "../ai/provider.js";
import type { WarhammerDataProvider, SourceCitation } from "../oracle/provider.js";
import { woundTarget } from "../oracle/oracle-provider.js";
import type { Repository } from "../db/repository.js";
import { answerQuestion, type RulesAnswer } from "./rules-service.js";

export interface TurnResult {
  /** What to show the player. */
  reply: string;
  events: GameEvent[];
  state: BattleState | null;
  intent?: Intent;
  needsClarification?: { question: string; options?: string[] };
  citations?: SourceCitation[];
  /** Present when the reply came from a rules lookup. */
  answer?: RulesAnswer;
  debug?: { interpreter: string; raw?: string; confidence?: number };
}

export interface StartBattleInput {
  name: string;
  edition: Edition;
  playerArmyId?: string;
  opponentArmyId?: string;
  startingCp?: number;
  objectiveNames?: string[];
}

const DEFAULT_OBJECTIVES = [
  "Centre",
  "Left Flank",
  "Right Flank",
  "Your Home",
  "Enemy Home",
];

export class BattleService {
  constructor(
    private readonly repo: Repository,
    private readonly oracle: WarhammerDataProvider,
    private readonly interpreter: Interpreter,
    /** Used only to phrase rules answers. Facts still come from Oracle. */
    private readonly llm: LLMProvider | null = null,
  ) {}

  // -- Setup ----------------------------------------------------------------

  /**
   * Create a battle and deploy both armies. Unit wound counts come from Oracle
   * at deploy time — that is the one moment we need real datasheet numbers, and
   * caching them on the unit keeps the rest of the battle offline-fast.
   */
  async startBattle(input: StartBattleInput): Promise<BattleState> {
    const { id } = this.repo.createBattle({
      name: input.name,
      edition: input.edition,
    });

    const player = input.playerArmyId
      ? this.repo.getArmy(input.playerArmyId)
      : null;
    const opponent = input.opponentArmyId
      ? this.repo.getArmy(input.opponentArmyId)
      : null;

    const batchId = randomUUID();
    const events: NewGameEvent[] = [
      {
        type: "battle_started",
        source: "ui",
        batchId,
        name: input.name,
        edition: input.edition,
        armies: {
          player: {
            armyId: player?.id,
            name: player?.name ?? "Your Army",
            faction: player?.faction ?? "Unknown",
          },
          opponent: {
            armyId: opponent?.id,
            name: opponent?.name ?? "Enemy Army",
            faction: opponent?.faction ?? "Unknown",
          },
        },
        startingCp: {
          player: input.startingCp ?? 12,
          opponent: input.startingCp ?? 12,
        },
        objectives: (input.objectiveNames ?? DEFAULT_OBJECTIVES).map((n) => ({
          id: `obj-${n.toLowerCase().replace(/\s+/g, "-")}`,
          name: n,
          controlledBy: null,
        })),
      },
    ];

    for (const [side, army] of [
      ["player", player],
      ["opponent", opponent],
    ] as const) {
      if (!army) continue;
      for (const entry of army.units) {
        events.push(await this.deployEvent(side, entry, army.edition, batchId));
      }
    }

    this.repo.appendEvents(id, events);
    const state = this.repo.getBattleState(id)!;
    this.repo.saveSnapshot(state);
    return state;
  }

  private async deployEvent(
    side: PlayerSide,
    entry: Army["units"][number],
    edition: Edition,
    batchId: string,
  ): Promise<NewGameEvent> {
    // Wounds-per-model is the one Oracle number the reducer needs to do
    // casualty removal, so it is resolved now rather than on every hit.
    let woundsPerModel = 1;
    let resolved = entry.ref.resolved;
    try {
      const unit = await this.oracle.getUnit(entry.ref.name, {
        edition,
        faction: entry.ref.faction,
      });
      const w = unit?.data.profiles[0]?.wounds;
      const parsed = w ? Number.parseInt(w, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) woundsPerModel = parsed;
      if (unit) resolved = true;
    } catch {
      // Oracle down at deploy time is survivable; default to 1W and carry on.
    }

    return {
      type: "unit_deployed",
      source: "system",
      batchId,
      unitId: randomUUID(),
      side,
      name: entry.ref.name,
      ref: { ...entry.ref, resolved },
      modelsTotal: entry.modelCount,
      woundsPerModel,
      armyEntryId: entry.id,
    };
  }

  // -- Reads ----------------------------------------------------------------

  getState(gameId: string): BattleState | null {
    return this.repo.getBattleState(gameId);
  }

  getEvents(gameId: string, includeUndone = false): GameEvent[] {
    return this.repo.getEvents(gameId, { includeUndone });
  }

  // -- The main loop --------------------------------------------------------

  /** One user utterance in, one turn of state + reply out. */
  async handleInput(
    gameId: string,
    input: string,
    source: "natural_language" | "voice" = "natural_language",
  ): Promise<TurnResult> {
    const state = this.repo.getBattleState(gameId);
    if (!state) {
      return { reply: "That battle does not exist.", events: [], state: null };
    }

    this.repo.appendMessage(gameId, "user", input);

    const ctx: InterpreterContext = {
      units: state.units.map((u) => ({
        name: u.name,
        side: u.side,
        alive: !u.destroyed,
      })),
      phase: state.phase,
      round: state.round,
      activePlayer: state.activePlayer,
      edition: state.edition,
      recent: this.repo
        .getMessages(gameId, 200)
        .slice(-6)
        .map((m) => `${m.role}: ${m.content}`),
    };

    const interpreted = await this.interpreter.interpret(input, ctx);
    const debug = { interpreter: this.interpreter.name };

    if (interpreted.status === "error") {
      const reply = `I couldn't interpret that: ${interpreted.message}`;
      this.repo.appendMessage(gameId, "assistant", reply, { error: true });
      return { reply, events: [], state, debug: { ...debug, raw: interpreted.raw } };
    }

    if (interpreted.status === "needs_clarification") {
      this.repo.appendMessage(gameId, "assistant", interpreted.question, {
        clarification: true,
      });
      return {
        reply: interpreted.question,
        events: [],
        state,
        needsClarification: {
          question: interpreted.question,
          options: interpreted.options,
        },
        debug: { ...debug, raw: interpreted.raw },
      };
    }

    const result = await this.applyIntent(gameId, state, interpreted.intent, input, source);
    return {
      ...result,
      intent: interpreted.intent,
      debug: { ...debug, raw: interpreted.raw, confidence: interpreted.confidence },
    };
  }

  /**
   * Intent -> events. Every branch either produces events or an explanation of
   * why it could not; nothing silently no-ops.
   */
  async applyIntent(
    gameId: string,
    state: BattleState,
    intent: Intent,
    rawInput: string,
    source: "natural_language" | "voice" | "ui" = "natural_language",
  ): Promise<TurnResult> {
    const batchId = randomUUID();
    const base = { source, rawInput, batchId } as const;
    const events: NewGameEvent[] = [];
    let reply = "";
    const citations: SourceCitation[] = [];
    let answer: RulesAnswer | undefined;

    /** Resolve or bail out with a question. */
    const need = (
      ref: Parameters<typeof resolveUnit>[1],
      opts?: Parameters<typeof resolveUnit>[2],
    ): BattleUnit | ResolveResult => {
      const r = resolveUnit(state, ref, opts);
      return r.status === "resolved" ? r.unit : r;
    };

    const bail = (r: ResolveResult): TurnResult => {
      const question =
        r.status === "ambiguous"
          ? r.question
          : `I can't find a unit called "${r.status === "not_found" ? r.query : ""}" in this battle.`;
      this.repo.appendMessage(gameId, "assistant", question, {
        clarification: true,
      });
      return {
        reply: question,
        events: [],
        state,
        needsClarification: {
          question,
          options:
            r.status === "ambiguous" ? r.candidates.map((c) => c.name) : undefined,
        },
      };
    };

    switch (intent.intent) {
      case "undo": {
        const undone = this.repo.undoLastBatch(gameId);
        if (undone.length === 0) {
          reply = "Nothing left to undo.";
          break;
        }
        const next = this.repo.getBattleState(gameId)!;
        this.repo.saveSnapshot(next);
        reply = `Undone: ${undone.map((e) => describeEvent(e, next)).join(", ")}.`;
        this.repo.appendMessage(gameId, "assistant", reply, { undo: true });
        return { reply, events: [], state: next };
      }

      case "apply_damage": {
        const u = need(intent.target);
        if ("status" in u) return bail(u);

        events.push({
          ...base,
          type: "damage_applied",
          targetUnitId: u.id,
          amount: intent.amount,
          mortal: intent.mortal,
        });

        // Predict casualties from the same arithmetic the reducer will use, so
        // the reply matches the state the player is about to see.
        const before = u.modelsAlive;
        const pool = u.woundsTakenOnLeadModel + intent.amount;
        const killed = Math.min(before, Math.floor(pool / u.woundsPerModel));

        if (killed >= before) {
          events.push({ ...base, type: "unit_destroyed", unitId: u.id });
          reply = `${u.name} takes ${intent.amount} damage and is destroyed.`;
        } else {
          const remainingModels = before - killed;
          const onLead = pool % u.woundsPerModel;
          reply =
            `${u.name} takes ${intent.amount} damage. ` +
            `${remainingModels}/${u.modelsTotal} models remaining` +
            (onLead > 0 ? ` (${u.woundsPerModel - onLead}W on the lead model).` : ".");
        }
        break;
      }

      case "destroy_models": {
        const u = need(intent.target);
        if ("status" in u) return bail(u);
        events.push({
          ...base,
          type: "models_destroyed",
          unitId: u.id,
          count: intent.count,
        });
        const left = Math.max(0, u.modelsAlive - intent.count);
        if (left === 0) {
          events.push({ ...base, type: "unit_destroyed", unitId: u.id });
          reply = `${u.name} is wiped out.`;
        } else {
          reply = `${u.name} loses ${intent.count}. ${left}/${u.modelsTotal} remaining.`;
        }
        break;
      }

      case "move_unit": {
        const u = need(intent.target, { preferUnactivated: "moved" });
        if ("status" in u) return bail(u);
        events.push({
          ...base,
          type: "unit_moved",
          unitId: u.id,
          position: intent.position,
          advanced: intent.advanced,
          fellBack: intent.fellBack,
          distance: intent.distance,
        });
        const how = intent.advanced
          ? "advances"
          : intent.fellBack
            ? "falls back"
            : "moves";
        reply = `${u.name} ${how}${intent.position ? ` to ${intent.position}` : ""}.`;
        if (intent.advanced) {
          reply += " Advanced — can't shoot or charge this turn unless a rule says otherwise.";
        }
        break;
      }

      case "shoot":
      case "fight": {
        const attacker = need(intent.attacker, {
          preferUnactivated: intent.intent === "shoot" ? "shot" : "fought",
        });
        if ("status" in attacker) return bail(attacker);
        const target = need(intent.target);
        if ("status" in target) return bail(target);

        const plan = await this.planAttack(
          attacker,
          target,
          state.edition,
          intent.intent,
          intent.weapon,
        );
        if (plan.citation) citations.push(plan.citation);

        events.push({
          ...base,
          type: intent.intent === "shoot" ? "shooting_started" : "fight_started",
          attackerUnitId: attacker.id,
          targetUnitId: target.id,
          weaponName: plan.weaponName,
          attacks: plan.attacks,
          hitOn: plan.hitOn,
        });
        reply = plan.narration;
        break;
      }

      case "charge": {
        const attacker = need(intent.attacker, { preferUnactivated: "charged" });
        if ("status" in attacker) return bail(attacker);
        let targetId: string | undefined;
        if (intent.target) {
          const t = need(intent.target);
          if ("status" in t) return bail(t);
          targetId = t.id;
        }
        events.push({
          ...base,
          type: "charge_declared",
          unitId: attacker.id,
          targetUnitId: targetId,
          rolled: intent.rolled,
          succeeded: intent.rolled === undefined ? undefined : intent.rolled >= 2,
        });
        reply = attacker.activation.advanced
          ? `${attacker.name} advanced this turn — it can't normally charge. Roll 2D6 only if a rule allows it.`
          : `${attacker.name} declares a charge. Roll 2D6.`;
        break;
      }

      case "report_roll": {
        events.push({
          ...base,
          type: "roll_result",
          kind: intent.kind,
          successes: intent.successes,
          total: intent.total,
          values: intent.values,
        });
        reply = await this.narrateRoll(gameId, state, intent);
        break;
      }

      case "change_phase": {
        const next = intent.next
          ? advancePhase(state)
          : {
              phase: intent.phase ?? state.phase,
              round: state.round,
              activePlayer: state.activePlayer,
            };
        events.push({
          ...base,
          type: "phase_changed",
          phase: next.phase,
          round: next.round,
          activePlayer: next.activePlayer,
        });
        reply =
          next.activePlayer !== state.activePlayer
            ? `Round ${next.round} — ${next.activePlayer === "player" ? "your" : "opponent's"} turn, ${next.phase} phase.`
            : `${cap(next.phase)} phase.`;
        break;
      }

      case "end_turn": {
        const nextPlayer = OTHER_SIDE[state.activePlayer];
        const nextRound =
          nextPlayer === "player" ? state.round + 1 : state.round;
        events.push({
          ...base,
          type: "turn_changed",
          round: nextRound,
          activePlayer: nextPlayer,
        });
        reply = `Round ${nextRound} — ${nextPlayer === "player" ? "your" : "opponent's"} turn. Command phase.`;
        break;
      }

      case "change_cp": {
        const side = intent.side ?? state.activePlayer;
        events.push({
          ...base,
          type: "command_points_changed",
          side,
          delta: intent.delta,
          reason: intent.reason,
        });
        reply = `${sideLabel(side)} CP ${intent.delta >= 0 ? "+" : ""}${intent.delta} (now ${Math.max(0, state.cp[side] + intent.delta)}).`;
        break;
      }

      case "change_vp": {
        const side = intent.side ?? state.activePlayer;
        events.push({
          ...base,
          type: "victory_points_changed",
          side,
          delta: intent.delta,
          reason: intent.reason,
        });
        reply = `${sideLabel(side)} VP ${intent.delta >= 0 ? "+" : ""}${intent.delta} (now ${Math.max(0, state.vp[side] + intent.delta)}).`;
        break;
      }

      case "claim_objective": {
        const obj = resolveObjective(state, intent.objective);
        const side = intent.side === undefined ? state.activePlayer : intent.side;
        events.push({
          ...base,
          type: "objective_claimed",
          objectiveId: obj?.id ?? `obj-${intent.objective.toLowerCase().replace(/\s+/g, "-")}`,
          objectiveName: obj?.name ?? intent.objective,
          side,
        });
        reply = `${obj?.name ?? intent.objective} — ${side ? `held by ${sideLabel(side).toLowerCase()}` : "now contested"}.`;
        break;
      }

      case "use_stratagem": {
        const side = intent.side ?? state.activePlayer;
        // Oracle owns the CP cost; we own whether the player can pay it.
        const strat = await this.oracle
          .getStratagem(intent.name, {
            edition: state.edition,
            faction: state.armies[side].faction,
          })
          .catch(() => null);
        if (strat) citations.push(strat.source);

        const cost = strat?.data.cpCost ?? 1;
        if (state.cp[side] < cost) {
          reply = `${strat?.data.name ?? intent.name} costs ${cost}CP but ${sideLabel(side).toLowerCase()} only has ${state.cp[side]}.`;
          this.repo.appendMessage(gameId, "assistant", reply, { blocked: true });
          return { reply, events: [], state, citations };
        }

        let unitId: string | undefined;
        if (intent.target) {
          const t = need(intent.target);
          if ("status" in t) return bail(t);
          unitId = t.id;
        }

        events.push({
          ...base,
          type: "stratagem_used",
          side,
          name: strat?.data.name ?? intent.name,
          cpCost: cost,
          unitId,
        });
        reply =
          `${strat?.data.name ?? intent.name} — ${cost}CP. ${sideLabel(side)} ${side === "player" ? "have" : "has"} ${state.cp[side] - cost}CP left.` +
          (strat?.data.effect ? `\n\n${strat.data.effect}` : "");
        break;
      }

      case "use_ability": {
        let unitId: string | undefined;
        if (intent.target) {
          const t = need(intent.target);
          if ("status" in t) return bail(t);
          unitId = t.id;
        }
        events.push({
          ...base,
          type: "ability_used",
          name: intent.name,
          unitId,
          side: state.activePlayer,
        });
        reply = `${intent.name} used.`;
        break;
      }

      case "battle_shock": {
        const u = need(intent.target);
        if ("status" in u) return bail(u);
        events.push({
          ...base,
          type: "battle_shock",
          unitId: u.id,
          shocked: intent.shocked,
          rolled: intent.rolled,
        });
        reply = intent.shocked
          ? `${u.name} is Battle-shocked — OC 0, and it can't use Stratagems.`
          : `${u.name} is no longer Battle-shocked.`;
        break;
      }

      case "heal_unit": {
        const u = need(intent.target, { includeDestroyed: true });
        if ("status" in u) return bail(u);
        events.push({
          ...base,
          type: "unit_healed",
          unitId: u.id,
          wounds: intent.wounds,
          modelsReturned: intent.modelsReturned,
        });
        reply = `${u.name} recovers${intent.wounds ? ` ${intent.wounds} wounds` : ""}${
          intent.modelsReturned ? ` and returns ${intent.modelsReturned} model(s)` : ""
        }.`;
        break;
      }

      case "record_note": {
        events.push({ ...base, type: "note_recorded", text: intent.text });
        reply = "Noted.";
        break;
      }

      case "ask_rules": {
        answer = await answerQuestion(this.oracle, intent, {
          edition: state.edition,
          state,
          llm: this.llm,
        });
        reply = answer.text;
        citations.push(...answer.citations);
        this.repo.appendMessage(gameId, "assistant", reply, {
          citations: answer.citations,
        });
        return { reply, events: [], state, citations, answer };
      }

      case "update_collection": {
        reply =
          "That's a collection change — open the Collection tab and say it there so it lands on the right shelf.";
        break;
      }

      case "unknown": {
        reply = intent.reason
          ? `I'm not sure what to do with that. ${intent.reason}`
          : "I'm not sure what to do with that. Try naming a unit and an action.";
        this.repo.appendMessage(gameId, "assistant", reply, { unknown: true });
        return { reply, events: [], state };
      }
    }

    if (events.length === 0) {
      this.repo.appendMessage(gameId, "assistant", reply);
      return { reply, events: [], state, citations };
    }

    const written = this.repo.appendEvents(gameId, events);
    const next = replay(this.repo.getEvents(gameId));
    this.repo.saveSnapshot(next);
    this.repo.appendMessage(gameId, "assistant", reply, {
      eventIds: written.map((e) => e.id),
    });

    return { reply, events: written, state: next, citations };
  }

  // -- Attack sequencing ----------------------------------------------------

  /**
   * Work out what to tell the player to roll. Weapon profiles come from Oracle;
   * which unit is shooting what comes from battle state.
   *
   * Deliberately partial — it narrates the first step of the sequence and lets
   * the player report results, rather than pretending to simulate a full attack
   * with modifiers we do not model yet.
   */
  private async planAttack(
    attacker: BattleUnit,
    target: BattleUnit,
    edition: Edition,
    kind: "shoot" | "fight",
    weaponHint?: string,
  ): Promise<{
    narration: string;
    weaponName?: string;
    attacks?: number;
    hitOn?: number;
    citation?: SourceCitation;
  }> {
    const verb = kind === "shoot" ? "shoots" : "fights";
    const fallback = `${attacker.name} ${verb} ${target.name}.`;

    let unit: Awaited<ReturnType<WarhammerDataProvider["getUnit"]>> = null;
    try {
      unit = await this.oracle.getUnit(attacker.ref.name, {
        edition,
        faction: attacker.ref.faction,
      });
    } catch {
      return { narration: `${fallback} (Oracle unavailable — roll it manually.)` };
    }
    if (!unit) return { narration: `${fallback} (No datasheet found.)` };

    const wanted = kind === "shoot" ? "ranged" : "melee";
    const pool = unit.data.weapons.filter((w) => w.kind === wanted);
    if (pool.length === 0) {
      return {
        narration: `${attacker.name} has no ${wanted} weapons on its datasheet.`,
        citation: unit.source,
      };
    }

    // Named weapon wins; otherwise take the unit's main gun rather than
    // whatever happens to be listed first — sidearms sort early on datasheets.
    const weapon =
      (weaponHint
        ? pool.find((w) =>
            w.name.toLowerCase().includes(weaponHint.toLowerCase()),
          )
        : undefined) ?? pickPrimaryWeapon(pool);

    const perModel = Number.parseInt(weapon.attacks, 10);
    const skill = Number.parseInt(weapon.skill, 10);
    const strength = Number.parseInt(weapon.strength, 10);

    const targetSheet = await this.oracle
      .getUnit(target.ref.name, { edition, faction: target.ref.faction })
      .catch(() => null);
    const toughness = Number.parseInt(
      targetSheet?.data.profiles[0]?.toughness ?? "",
      10,
    );

    const lines: string[] = [];
    const totalAttacks = Number.isFinite(perModel)
      ? perModel * attacker.modelsAlive
      : undefined;

    lines.push(
      `${attacker.name} → ${target.name}` +
        (pool.length > 1 ? ` (${weapon.name})` : ""),
    );

    if (totalAttacks !== undefined) {
      lines.push(
        `${totalAttacks} attacks — ${weapon.attacks} × ${attacker.modelsAlive} models.`,
      );
    } else {
      lines.push(`${weapon.attacks} attacks per model × ${attacker.modelsAlive} models.`);
    }

    if (Number.isFinite(skill)) {
      lines.push(`Hit on ${skill}+. Roll ${totalAttacks ?? "your"} dice.`);
    } else if (weapon.keywords.some((k) => /torrent/i.test(k))) {
      lines.push("Torrent — attacks hit automatically. Go straight to wounding.");
    }

    if (Number.isFinite(strength) && Number.isFinite(toughness)) {
      lines.push(
        `S${strength} vs T${toughness} — wounding on ${woundTarget(strength, toughness)}+.`,
      );
    }

    if (weapon.keywords.length > 0) {
      lines.push(`Keywords: ${weapon.keywords.join(", ")}.`);
    }

    return {
      narration: lines.join("\n"),
      weaponName: weapon.name,
      attacks: totalAttacks,
      hitOn: Number.isFinite(skill) ? skill : undefined,
      citation: unit.source,
    };
  }

  /**
   * "I got 10 hits" only means something in the context of the attack that is
   * in flight, so we look back through the log for it.
   */
  private async narrateRoll(
    gameId: string,
    state: BattleState,
    intent: Extract<Intent, { intent: "report_roll" }>,
  ): Promise<string> {
    const n = intent.successes ?? intent.total ?? 0;
    const events = this.repo.getEvents(gameId);

    const attack = [...events]
      .reverse()
      .find(
        (e): e is Extract<GameEvent, { type: "shooting_started" | "fight_started" }> =>
          e.type === "shooting_started" || e.type === "fight_started",
      );

    if (!attack) return `Recorded ${n} ${intent.kind}s.`;

    const attacker = state.units.find((u) => u.id === attack.attackerUnitId);
    const target = state.units.find((u) => u.id === attack.targetUnitId);
    if (!attacker || !target) return `Recorded ${n} ${intent.kind}s.`;

    if (intent.kind === "hit") {
      const [aSheet, tSheet] = await Promise.all([
        this.oracle
          .getUnit(attacker.ref.name, {
            edition: state.edition,
            faction: attacker.ref.faction,
          })
          .catch(() => null),
        this.oracle
          .getUnit(target.ref.name, {
            edition: state.edition,
            faction: target.ref.faction,
          })
          .catch(() => null),
      ]);

      const weapon = aSheet?.data.weapons.find(
        (w) => w.name === attack.weaponName,
      );
      const s = Number.parseInt(weapon?.strength ?? "", 10);
      const t = Number.parseInt(tSheet?.data.profiles[0]?.toughness ?? "", 10);

      if (Number.isFinite(s) && Number.isFinite(t)) {
        return `${n} hits. S${s} vs T${t} — wound on ${woundTarget(s, t)}+. Roll ${n} dice.`;
      }
      return `${n} hits recorded. Roll to wound.`;
    }

    if (intent.kind === "wound") {
      const tSheet = await this.oracle
        .getUnit(target.ref.name, {
          edition: state.edition,
          faction: target.ref.faction,
        })
        .catch(() => null);
      const save = tSheet?.data.profiles[0]?.save;
      const aSheet = await this.oracle
        .getUnit(attacker.ref.name, {
          edition: state.edition,
          faction: attacker.ref.faction,
        })
        .catch(() => null);
      const weapon = aSheet?.data.weapons.find(
        (w) => w.name === attack.weaponName,
      );
      const ap = Number.parseInt((weapon?.armourPenetration ?? "0").replace("-", ""), 10);
      const baseSave = Number.parseInt(save ?? "", 10);

      if (Number.isFinite(baseSave)) {
        const modified = baseSave + (Number.isFinite(ap) ? ap : 0);
        return `${n} wounds. ${target.name} saves on ${Math.min(7, modified)}+${
          Number.isFinite(ap) && ap > 0 ? ` (${save} modified by AP-${ap})` : ""
        }. Roll ${n} dice.`;
      }
      return `${n} wounds recorded. Roll saves.`;
    }

    if (intent.kind === "save") {
      const aSheet = await this.oracle
        .getUnit(attacker.ref.name, {
          edition: state.edition,
          faction: attacker.ref.faction,
        })
        .catch(() => null);
      const weapon = aSheet?.data.weapons.find(
        (w) => w.name === attack.weaponName,
      );
      const dmg = weapon?.damage ?? "1";
      const flat = Number.parseInt(dmg, 10);
      if (Number.isFinite(flat)) {
        return `${n} failed saves × ${dmg} damage = ${n * flat} damage to ${target.name}. Say "${target.name} takes ${n * flat} damage" to apply it.`;
      }
      return `${n} failed saves at ${dmg} damage each. Roll damage.`;
    }

    return `Recorded ${n} ${intent.kind}s.`;
  }
}

/**
 * Best guess at the weapon a player means when they just say "shoot".
 * Ranks by expected damage output, and demotes pistols and sidearms, which are
 * rarely the intended profile but often appear first on the datasheet.
 */
function pickPrimaryWeapon<
  T extends { attacks: string; damage: string; strength: string; keywords: string[] },
>(pool: T[]): T {
  const dice = (s: string): number => {
    const m = s.match(/^(\d*)D(\d+)(?:\s*\+\s*(\d+))?$/i);
    if (m) {
      const count = m[1] ? Number(m[1]) : 1;
      const faces = Number(m[2]);
      return count * ((faces + 1) / 2) + (m[3] ? Number(m[3]) : 0);
    }
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 1;
  };

  const score = (w: T): number => {
    const base = dice(w.attacks) * dice(w.damage) * (dice(w.strength) || 1);
    const isSidearm = w.keywords.some((k) => /pistol/i.test(k));
    return isSidearm ? base * 0.25 : base;
  };

  return [...pool].sort((a, b) => score(b) - score(a))[0]!;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sideLabel(side: PlayerSide): string {
  return side === "player" ? "You" : "Opponent";
}

/** Short human description of an event, for undo messages and the feed. */
export function describeEvent(e: GameEvent, state?: BattleState): string {
  const unitName = (id?: string): string =>
    (id && state?.units.find((u) => u.id === id)?.name) || "unit";

  switch (e.type) {
    case "damage_applied":
      return `${e.amount} damage to ${unitName(e.targetUnitId)}`;
    case "models_destroyed":
      return `${e.count} models lost from ${unitName(e.unitId)}`;
    case "unit_destroyed":
      return `${unitName(e.unitId)} destroyed`;
    case "unit_moved":
      return `${unitName(e.unitId)} moved${e.position ? ` to ${e.position}` : ""}`;
    case "shooting_started":
      return `${unitName(e.attackerUnitId)} shooting ${unitName(e.targetUnitId)}`;
    case "fight_started":
      return `${unitName(e.attackerUnitId)} fighting ${unitName(e.targetUnitId)}`;
    case "charge_declared":
      return `${unitName(e.unitId)} charge`;
    case "phase_changed":
      return `phase → ${e.phase}`;
    case "turn_changed":
      return `round ${e.round}, ${e.activePlayer}`;
    case "command_points_changed":
      return `CP ${e.delta >= 0 ? "+" : ""}${e.delta}`;
    case "victory_points_changed":
      return `VP ${e.delta >= 0 ? "+" : ""}${e.delta}`;
    case "objective_claimed":
      return `${e.objectiveName ?? "objective"} claimed`;
    case "stratagem_used":
      return `${e.name} (${e.cpCost}CP)`;
    case "ability_used":
      return e.name;
    case "roll_result":
      return `${e.successes ?? "?"} ${e.kind}s`;
    case "battle_shock":
      return `${unitName(e.unitId)} battle-shock`;
    case "unit_healed":
      return `${unitName(e.unitId)} healed`;
    case "note_recorded":
      return "note";
    case "battle_started":
      return "battle started";
    case "battle_ended":
      return "battle ended";
    case "unit_deployed":
      return `${e.name} deployed`;
    case "effect_applied":
      return `${e.effect.name} applied`;
    case "effect_removed":
      return "effect removed";
  }
}
