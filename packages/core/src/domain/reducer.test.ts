import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, replay, advancePhase, remainingWounds } from "./reducer.js";
import type { GameEvent } from "./events.js";
import type { BattleState, Edition } from "./types.js";

let seq = 0;
function ev<T extends GameEvent["type"]>(
  type: T,
  props: Record<string, unknown> = {},
): GameEvent {
  seq += 1;
  return {
    type,
    id: `e${seq}`,
    gameId: "g1",
    seq,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    source: "system",
    ...props,
  } as GameEvent;
}

function start(edition: Edition = "40k_11e"): GameEvent[] {
  seq = 0;
  return [
    ev("battle_started", {
      name: "Test",
      edition,
      armies: {
        player: { name: "Mine", faction: "Death Guard" },
        opponent: { name: "Theirs", faction: "Space Marines" },
      },
      startingCp: { player: 12, opponent: 12 },
      objectives: [{ id: "obj-a", name: "Centre", controlledBy: null }],
    }),
  ];
}

function deploy(
  unitId: string,
  side: "player" | "opponent",
  models: number,
  wounds: number,
): GameEvent {
  return ev("unit_deployed", {
    unitId,
    side,
    name: unitId,
    ref: { name: unitId, edition: "40k_11e", resolved: true },
    modelsTotal: models,
    woundsPerModel: wounds,
  });
}

describe("reducer", () => {
  it("is pure — applying an event does not mutate the input", () => {
    const log = [...start(), deploy("squad", "player", 5, 2)];
    const before = replay(log);
    const snapshot = JSON.stringify(before);

    applyEvent(before, ev("damage_applied", { targetUnitId: "squad", amount: 3 }));

    assert.equal(JSON.stringify(before), snapshot);
  });

  it("spills damage across models the way casualty removal does", () => {
    // 5 models at 2W each. 3 damage kills one and leaves 1W on the next.
    const log = [
      ...start(),
      deploy("squad", "player", 5, 2),
      ev("damage_applied", { targetUnitId: "squad", amount: 3 }),
    ];
    const s = replay(log);
    const u = s.units[0]!;

    assert.equal(u.modelsAlive, 4);
    assert.equal(u.woundsTakenOnLeadModel, 1);
    assert.equal(remainingWounds(u), 7);
  });

  it("destroys a unit when damage exceeds its total wounds", () => {
    const log = [
      ...start(),
      deploy("squad", "player", 3, 2),
      ev("damage_applied", { targetUnitId: "squad", amount: 99 }),
    ];
    const u = replay(log).units[0]!;

    assert.equal(u.destroyed, true);
    assert.equal(u.modelsAlive, 0);
    assert.equal(remainingWounds(u), 0);
  });

  it("never takes a unit below zero models", () => {
    const log = [
      ...start(),
      deploy("squad", "player", 2, 1),
      ev("models_destroyed", { unitId: "squad", count: 10 }),
    ];
    const u = replay(log).units[0]!;

    assert.equal(u.modelsAlive, 0);
    assert.equal(u.destroyed, true);
  });

  it("ignores undone events so undo is just a re-fold", () => {
    const damage = ev("damage_applied", { targetUnitId: "squad", amount: 4 });
    const log = [...start(), deploy("squad", "player", 5, 2), damage];

    const applied = replay(log);
    assert.equal(applied.units[0]!.modelsAlive, 3);

    const undone = replay([...log.slice(0, -1), { ...damage, undone: true }]);
    assert.equal(undone.units[0]!.modelsAlive, 5);
    assert.equal(undone.units[0]!.woundsTakenOnLeadModel, 0);
  });

  it("clears activation flags when the turn passes to a side", () => {
    const log = [
      ...start(),
      deploy("a", "player", 1, 1),
      ev("unit_moved", { unitId: "a" }),
      ev("shooting_started", { attackerUnitId: "a", targetUnitId: "a" }),
    ];
    assert.equal(replay(log).units[0]!.activation.moved, true);
    assert.equal(replay(log).units[0]!.activation.shot, true);

    const next = replay([
      ...log,
      ev("turn_changed", { round: 2, activePlayer: "player" }),
    ]);
    assert.equal(next.units[0]!.activation.moved, false);
    assert.equal(next.units[0]!.activation.shot, false);
  });

  it("does not let a stratagem overdraw command points", () => {
    const log = [
      ...start(),
      ev("stratagem_used", { side: "player", name: "Big One", cpCost: 20 }),
    ];
    assert.equal(replay(log).cp.player, 0);
  });

  it("replays to the same state regardless of how the log is folded", () => {
    const log = [
      ...start(),
      deploy("a", "player", 5, 2),
      deploy("b", "opponent", 3, 3),
      ev("unit_moved", { unitId: "a", position: "centre" }),
      ev("damage_applied", { targetUnitId: "b", amount: 5 }),
      ev("command_points_changed", { side: "player", delta: -2 }),
      ev("victory_points_changed", { side: "player", delta: 5 }),
      ev("objective_claimed", { objectiveId: "obj-a", side: "player" }),
    ];

    const whole = replay(log);
    const stepwise = log.reduce<BattleState>(
      (s, e) => applyEvent(s, e),
      replay([]),
    );

    assert.deepEqual(whole, stepwise);
  });

  it("rolls the round over only when play returns to the first player", () => {
    const s = replay([...start()]);

    // End phase of the player's turn hands over without ticking the round.
    const toOpponent = advancePhase({ ...s, phase: "end" });
    assert.deepEqual(toOpponent, {
      phase: "command",
      round: 1,
      activePlayer: "opponent",
    });

    const backToPlayer = advancePhase({
      ...s,
      phase: "end",
      activePlayer: "opponent",
    });
    assert.deepEqual(backToPlayer, {
      phase: "command",
      round: 2,
      activePlayer: "player",
    });
  });

  it("keeps a deployed unit unique across a replay", () => {
    const d = deploy("a", "player", 5, 2);
    const s = replay([...start(), d, d]);
    assert.equal(s.units.length, 1);
  });
});
