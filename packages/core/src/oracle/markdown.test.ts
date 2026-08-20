/**
 * Fixtures are real Warhammer Oracle output, trimmed. If Oracle changes its
 * formatting these are the tests that should fail first.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  parseGameFlow,
  isNotFound,
  parseKeyword,
  parseStratagem,
  parseUnit,
  parseUnitSummaries,
  parseWoundCalc,
} from "./markdown.js";
import { woundTarget } from "./oracle-provider.js";

const DEATHSHROUD = `[Mode: 40k 11e]

# Deathshroud Terminators

**Faction:** Death Guard — 160 pts | **Unit Size:** 3-6 models

### Unit Profiles

| Name | M | T | SV | W | LD | OC |
|---|---|---|---|---|---|---|
| Deathshroud Terminators | 5" | 7 | 2+ | 4 | 6+ | 1 |

### Ranged Weapons

| Weapon | Range | A | BS | S | AP | D | Keywords |
|---|---|---|---|---|---|---|---|
| Plaguespurt gauntlet | 12" | D6 | N/A | 3 | 0 | 1 | Anti-INFANTRY 4+, Ignores Cover, Pistol, Torrent |

### Melee Weapons

| Weapon | Range | A | WS | S | AP | D | Keywords |
|---|---|---|---|---|---|---|---|
| ➤ Manreaper - strike | Melee | 4 | 2+ | 8 | -2 | 2 | Lethal Hits |
| ➤ Manreaper - sweep | Melee | 8 | 3+ | 4 | -1 | 1 | Lethal Hits |

### Abilities

- **Silent Bodyguard**: While a ^^**Character^^** model is leading this unit, that ^^**Character^^** model has the Feel No Pain 4+ ability.
- **Death Approaches**: In your Movement phase, when this unit is set up on the battlefield using the Deep Strike ability, it can be set up anywhere.

### Keywords

Death Guard, Infantry, Terminator, Chaos, Nurgle`;

const KEYWORD = `# Deep Strike

**Game Modes:** 40k, combat_patrol

## Official Definition

Each time this unit makes an ingress move, it can be set up anywhere on the battlefield more than 8" horizontally from all enemy units.

## Plain English

Instead of deploying at the start, this unit waits in reserves and drops in later.`;

const STRATAGEM = `# Command Re-Roll

**Game:** Warhammer 40,000 | **Type:** core | **CP:** 1

**Phase:** Any phase

**When:** Just after you make a roll for a friendly unit.

**Target:** That unit or model.

**Effect:** You reroll that roll.`;

const WOUND_CALC = `# Wound Calculator — Warhammer 40,000

## Attack Profile
12 attacks | BS/WS 2+ | S5 AP-1 D2
vs T4 Sv3+ (modified to 4+)

## Results
| Step | Expected | Per-attack % |
|------|----------|-------------|
| Hits | 10.00 | 83.3% |
| Wounds | 6.67 | 66.7% |
| Unsaved wounds | 3.33 | 50.0% |
| Damage dealt | 6.67 | — |

## Key Interactions
- AP-1 modifies 3+ save to 4+`;

describe("Oracle markdown parsing", () => {
  it("parses a datasheet into structured data", () => {
    const u = parseUnit(DEATHSHROUD, "40k_11e");
    assert.ok(u);

    assert.equal(u.name, "Deathshroud Terminators");
    assert.equal(u.faction, "Death Guard");
    assert.equal(u.points, 160);
    assert.deepEqual(u.unitSize, { min: 3, max: 6 });

    assert.equal(u.profiles.length, 1);
    assert.equal(u.profiles[0]?.toughness, "7");
    assert.equal(u.profiles[0]?.wounds, "4");
    assert.equal(u.profiles[0]?.save, "2+");

    assert.equal(u.weapons.length, 3);
    assert.equal(u.weapons.filter((w) => w.kind === "ranged").length, 1);
    assert.equal(u.weapons.filter((w) => w.kind === "melee").length, 2);

    assert.deepEqual(u.keywords, [
      "Death Guard",
      "Infantry",
      "Terminator",
      "Chaos",
      "Nurgle",
    ]);
  });

  it("strips the multi-profile arrow from weapon names", () => {
    const u = parseUnit(DEATHSHROUD, "40k_11e");
    const strike = u?.weapons.find((w) => w.name.includes("strike"));
    assert.equal(strike?.name, "Manreaper - strike");
    assert.deepEqual(strike?.keywords, ["Lethal Hits"]);
    assert.equal(strike?.armourPenetration, "-2");
  });

  it("cleans BSData bold markers out of ability text", () => {
    const u = parseUnit(DEATHSHROUD, "40k_11e");
    const ability = u?.abilities.find((a) => a.name === "Silent Bodyguard");

    assert.ok(ability);
    assert.ok(!ability.description.includes("^^"));
    assert.ok(!ability.description.includes("**"));
    assert.match(ability.description, /Feel No Pain 4\+/);
    assert.equal(u?.abilities.length, 2);
  });

  it("keeps the raw document for citation", () => {
    assert.equal(parseUnit(DEATHSHROUD, "40k_11e")?.raw, DEATHSHROUD);
  });

  it("parses a search result list", () => {
    const md = `[Mode: 40k 11e]

**Plague Marines** (Death Guard) — 90pts — 6-11 models — Keywords: Death Guard, Infantry, Chaos
**Mortarion** (Death Guard) — 325pts — 1 model — Keywords: Death Guard, Monster, Epic Hero`;

    const list = parseUnitSummaries(md);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.name, "Plague Marines");
    assert.equal(list[0]?.points, 90);
    assert.deepEqual(list[0]?.unitSize, { min: 6, max: 11 });
    assert.deepEqual(list[1]?.unitSize, { min: 1, max: 1 });
  });

  it("parses a keyword entry, including the 'Official Definition' heading", () => {
    const k = parseKeyword(KEYWORD);
    assert.ok(k);
    assert.equal(k.name, "Deep Strike");
    assert.match(k.description, /more than 8" horizontally/);
    assert.match(k.plainEnglish ?? "", /waits in reserves/);
  });

  it("parses a stratagem's CP cost from the inline header", () => {
    const s = parseStratagem(STRATAGEM);
    assert.ok(s);
    assert.equal(s.name, "Command Re-Roll");
    assert.equal(s.cpCost, 1);
    assert.match(s.effect ?? "", /reroll that roll/);
  });

  it("parses the wound calculator result table", () => {
    const r = parseWoundCalc(WOUND_CALC);
    assert.equal(r.expectedHits, 10);
    assert.equal(r.expectedWounds, 6.67);
    assert.equal(r.expectedUnsaved, 3.33);
    assert.equal(r.expectedDamage, 6.67);
    assert.equal(r.interactions.length, 1);
  });

  it("recognises Oracle's not-found responses", () => {
    assert.equal(isNotFound(`No unit found matching "Blorp".`), true);
    assert.equal(isNotFound(DEATHSHROUD), false);
    assert.equal(parseUnit(`No unit found matching "Blorp".`, "40k_11e"), null);
  });

  it("cleans stray markup out of arbitrary text", () => {
    assert.equal(cleanText("^^**Bold^^**  spaced   out"), "Bold spaced out");
  });
});

describe("turn sequence", () => {
  // Oracle writes phases as numbered headings, not a bullet list. Parsing it
  // as bullets silently yields an empty phase list, which quietly disables
  // every fallback that depends on knowing what the phases are.
  const FLOW = `# Turn Sequence — 40k

## 1. Command Phase
Both players gain 1 Command Point.

## 2. Movement Phase
Move each unit up to its Movement characteristic.

## 3. Shooting Phase
Select a unit to shoot with.

## 4. Charge Phase
Declare a charge with an eligible unit.

## 5. Fight Phase
Units fight in order.`;

  it("reads the phases out of the headings", () => {
    assert.deepEqual(parseGameFlow(FLOW).phases, [
      "Command Phase",
      "Movement Phase",
      "Shooting Phase",
      "Charge Phase",
      "Fight Phase",
    ]);
  });

  it("picks out where the player is and what comes next", () => {
    const positioned = `# Turn Sequence — 40k

## → YOU ARE HERE: Command Phase
Both players gain 1 Command Point.

## **Next → Movement Phase**
Move each unit.`;

    const f = parseGameFlow(positioned);
    assert.equal(f.current, "Command Phase");
    assert.equal(f.next, "Movement Phase");
    assert.ok(f.phases.includes("Command Phase"));
  });
});

describe("wound chart", () => {
  it("follows the 40K S-vs-T table", () => {
    assert.equal(woundTarget(8, 4), 2, "S >= 2xT wounds on 2+");
    assert.equal(woundTarget(5, 4), 3, "S > T wounds on 3+");
    assert.equal(woundTarget(4, 4), 4, "S == T wounds on 4+");
    assert.equal(woundTarget(3, 4), 5, "S < T wounds on 5+");
    assert.equal(woundTarget(4, 8), 6, "S <= T/2 wounds on 6+");
    assert.equal(woundTarget(4, 9), 6);
  });
});
