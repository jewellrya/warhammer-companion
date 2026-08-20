import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveUnit } from "./resolve.js";
import type { BattleState, BattleUnit, PlayerSide } from "./types.js";
import { freshActivation } from "./types.js";

function unit(name: string, side: PlayerSide = "player"): BattleUnit {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    side,
    ref: { name, edition: "40k_11e", resolved: true },
    name,
    modelsTotal: 5,
    modelsAlive: 5,
    woundsPerModel: 2,
    woundsTakenOnLeadModel: 0,
    activation: freshActivation(),
    effects: [],
    attachedLeaderIds: [],
    destroyed: false,
    usedAbilities: [],
  };
}

function state(units: BattleUnit[]): BattleState {
  return {
    id: "g1",
    name: "T",
    edition: "40k_11e",
    round: 1,
    activePlayer: "player",
    phase: "shooting",
    cp: { player: 12, opponent: 12 },
    vp: { player: 0, opponent: 0 },
    armies: {
      player: { name: "Mine", faction: "Death Guard" },
      opponent: { name: "Theirs", faction: "Space Marines" },
    },
    units,
    objectives: [],
    status: "active",
    createdAt: "",
    updatedAt: "",
  };
}

describe("unit resolution", () => {
  it("matches an exact name", () => {
    const s = state([unit("Plague Marines"), unit("Deathshroud Terminators")]);
    const r = resolveUnit(s, { name: "Plague Marines" });
    assert.equal(r.status, "resolved");
    assert.equal(r.status === "resolved" && r.unit.name, "Plague Marines");
  });

  it("matches a plural the user said against a singular datasheet name", () => {
    const s = state([unit("Intercessor Squad", "opponent")]);
    const r = resolveUnit(s, { name: "Intercessors" });
    assert.equal(r.status, "resolved");
  });

  it("asks rather than guessing when two units match equally", () => {
    const s = state([
      unit("Deathshroud Terminators"),
      unit("Blightlord Terminators"),
    ]);
    const r = resolveUnit(s, { name: "Terminators" });

    assert.equal(r.status, "ambiguous");
    if (r.status !== "ambiguous") return;
    assert.equal(r.candidates.length, 2);
    assert.match(r.question, /Deathshroud Terminators or Blightlord Terminators\?/);
  });

  it("does not resolve a query made only of filler words", () => {
    const s = state([unit("Intercessor Squad"), unit("Plague Marines")]);
    const r = resolveUnit(s, { name: "the squad" });
    assert.equal(r.status, "not_found");
  });

  it("does not let a short word inside one name outrank a real match", () => {
    // "Captain in Terminator Armour" contains "in"; that must not tie with
    // the squad the player actually named.
    const s = state([
      unit("Intercessor Squad", "opponent"),
      unit("Captain in Terminator Armour", "opponent"),
    ]);
    const r = resolveUnit(s, { name: "Intercessors" });

    assert.equal(r.status, "resolved");
    assert.equal(r.status === "resolved" && r.unit.name, "Intercessor Squad");
  });

  it("uses the side the user implied to disambiguate a mirror match", () => {
    const s = state([
      unit("Plague Marines", "player"),
      unit("Plague Marines", "opponent"),
    ]);

    assert.equal(resolveUnit(s, { name: "Plague Marines" }).status, "ambiguous");

    const mine = resolveUnit(s, { name: "Plague Marines", side: "player" });
    assert.equal(mine.status, "resolved");
    assert.equal(mine.status === "resolved" && mine.unit.side, "player");
  });

  it("skips destroyed units unless asked for them", () => {
    const dead = { ...unit("Plague Marines"), destroyed: true, modelsAlive: 0 };
    const s = state([dead]);

    assert.equal(resolveUnit(s, { name: "Plague Marines" }).status, "not_found");
    assert.equal(
      resolveUnit(s, { name: "Plague Marines" }, { includeDestroyed: true }).status,
      "resolved",
    );
  });

  it("breaks a tie using the activation hint before asking", () => {
    const shot = { ...unit("Plague Marines"), id: "a" };
    shot.activation.shot = true;
    const idle = { ...unit("Plague Marines"), id: "b" };

    const r = resolveUnit(state([shot, idle]), { name: "Plague Marines" }, {
      preferUnactivated: "shot",
    });

    assert.equal(r.status, "resolved");
    assert.equal(r.status === "resolved" && r.unit.id, "b");
  });

  it("reports not_found for a unit that is not in the battle", () => {
    const r = resolveUnit(state([unit("Plague Marines")]), { name: "Land Raider" });
    assert.equal(r.status, "not_found");
  });
});
