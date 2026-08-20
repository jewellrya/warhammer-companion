import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ruleInterpret, parseNumber } from "./rule-interpreter.js";
import { IntentSchema } from "../domain/intent.js";

/** Every rule must produce something the schema accepts. */
function intentOf(input: string) {
  const r = ruleInterpret(input);
  assert.ok(r, `no rule matched: "${input}"`);
  const parsed = IntentSchema.safeParse(r.intent);
  assert.ok(parsed.success, `intent failed validation for "${input}"`);
  return r.intent;
}

describe("rule interpreter", () => {
  it("reads spelled-out numbers", () => {
    assert.equal(parseNumber("six"), 6);
    assert.equal(parseNumber("12"), 12);
    assert.equal(parseNumber("banana"), null);
  });

  it("handles the brief's damage phrasing", () => {
    const i = intentOf("The Rhino takes six damage.");
    assert.equal(i.intent, "apply_damage");
    assert.equal(i.intent === "apply_damage" && i.amount, 6);
    assert.equal(i.intent === "apply_damage" && i.target.name, "Rhino");
  });

  it("handles damage phrased the other way round", () => {
    const i = intentOf("deal 4 damage to the Intercessors");
    assert.equal(i.intent, "apply_damage");
    assert.equal(i.intent === "apply_damage" && i.amount, 4);
  });

  it("marks mortal wounds", () => {
    const i = intentOf("Mortarion takes 3 mortal wounds");
    assert.equal(i.intent === "apply_damage" && i.mortal, true);
  });

  it("handles movement without swallowing the verb's plural", () => {
    const i = intentOf("These Plague Marines move onto the center objective.");
    assert.equal(i.intent, "move_unit");
    assert.equal(i.intent === "move_unit" && i.target.name, "Plague Marines");
    assert.equal(i.intent === "move_unit" && i.position, "the center objective");
  });

  it("flags an advance", () => {
    const i = intentOf("Deathshroud advance up the left flank");
    assert.equal(i.intent === "move_unit" && i.advanced, true);
  });

  it("handles shooting, and picks up whose side was meant", () => {
    const i = intentOf("Deathshroud shoot those Intercessors.");
    assert.equal(i.intent, "shoot");
    if (i.intent !== "shoot") return;
    assert.equal(i.attacker.name, "Deathshroud");
    assert.equal(i.target.name, "Intercessors");
  });

  it("reads 'my' and 'their' as sides", () => {
    const i = intentOf("my Plague Marines shoot their Intercessors");
    assert.equal(i.intent === "shoot" && i.attacker.side, "player");
    assert.equal(i.intent === "shoot" && i.target.side, "opponent");
  });

  it("records dice results", () => {
    assert.deepEqual(intentOf("I got 10 hits."), {
      intent: "report_roll",
      kind: "hit",
      successes: 10,
    });
    assert.deepEqual(intentOf("7 wounds"), {
      intent: "report_roll",
      kind: "wound",
      successes: 7,
    });
    assert.deepEqual(intentOf("4 failed saves"), {
      intent: "report_roll",
      kind: "save",
      successes: 4,
    });
  });

  it("treats undo as a command even though it reads like commentary", () => {
    assert.deepEqual(intentOf("Actually undo that."), {
      intent: "undo",
      count: 1,
    });
    assert.deepEqual(intentOf("scratch that"), { intent: "undo", count: 1 });
  });

  it("routes questions to Oracle instead of changing state", () => {
    for (const q of [
      "Can Mortarion charge after advancing?",
      "What does this stratagem do?",
      "Which of my models has the plasma gun?",
    ]) {
      assert.equal(intentOf(q).intent, "ask_rules", q);
    }
  });

  it("does not mistake a question for an action", () => {
    // "Can X charge" must not become a charge intent.
    const i = intentOf("Can Mortarion charge after advancing?");
    assert.equal(i.intent, "ask_rules");
  });

  it("handles phase and turn control", () => {
    assert.deepEqual(intentOf("next phase"), {
      intent: "change_phase",
      next: true,
    });
    assert.deepEqual(intentOf("shooting phase"), {
      intent: "change_phase",
      phase: "shooting",
    });
    assert.deepEqual(intentOf("end turn"), { intent: "end_turn" });
  });

  it("handles command points in both directions", () => {
    assert.equal(intentOf("I gain 1 CP").intent === "change_cp" && true, true);
    const spend = intentOf("I spend 2 CP");
    assert.equal(spend.intent === "change_cp" && spend.delta, -2);
  });

  it("only claims a stratagem when the word is present", () => {
    assert.equal(intentOf("I use the Command Re-roll stratagem").intent, "use_stratagem");
    // "use the Rhino" is not a stratagem, so no rule should claim it.
    const r = ruleInterpret("use the Rhino");
    assert.ok(r === null || r.intent.intent !== "use_stratagem");
  });

  it("returns null for input it cannot classify, rather than guessing", () => {
    assert.equal(ruleInterpret("hmm, interesting"), null);
    assert.equal(ruleInterpret(""), null);
  });
});
