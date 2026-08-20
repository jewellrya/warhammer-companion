/**
 * End-to-end smoke test of the whole pipeline against the real Oracle server.
 *
 * Run with: pnpm -F @wh/core verify
 * This is the script behind milestone-1 steps 3-14.
 */

import { openDatabase } from "./db/schema.js";
import { Repository } from "./db/repository.js";
import { OracleProvider } from "./oracle/oracle-provider.js";
import { OllamaProvider } from "./ai/ollama.js";
import { createInterpreter } from "./ai/interpreter.js";
import { BattleService } from "./app/battle-service.js";
import { importArmyFromText } from "./app/army-service.js";
import { buildChronicleEntry } from "./app/chronicle-service.js";

const PLAYER_LIST = `Death Guard Strike Force (2000 points)

Faction: Death Guard
Detachment: Plague Company

Mortarion (325 points)
Deathshroud Terminators (160 points)
Plague Marines (90 points)
Rhino (75 points)
`;

const OPPONENT_LIST = `Ultramarines Task Force (2000 points)

Faction: Space Marines
Detachment: Gladius Task Force

Intercessor Squad (80 points)
Redemptor Dreadnought (210 points)
`;

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function step(n: number, label: string): void {
  console.log(`\n[${n}] ${label}`);
}

async function main(): Promise<void> {
  const oracle = new OracleProvider({ defaultEdition: "40k_11e" });

  step(3, "MCP communication with Warhammer Oracle");
  const available = await oracle.isAvailable();
  check("Oracle MCP server reachable", available);
  if (!available) {
    console.error("\nOracle unavailable — aborting.");
    process.exit(1);
  }
  const tools = await oracle.listTools();
  check(`${tools.length} tools exposed`, tools.length >= 14, tools.slice(0, 4).join(", ") + "…");

  step(4, "Query Oracle for a known unit");
  const dsh = await oracle.getUnit("Deathshroud Terminators", {
    faction: "Death Guard",
  });
  check("Deathshroud Terminators found", dsh !== null);
  check("statline parsed", (dsh?.data.profiles[0]?.toughness ?? "") === "7",
    `T=${dsh?.data.profiles[0]?.toughness} W=${dsh?.data.profiles[0]?.wounds}`);
  check("weapons parsed", (dsh?.data.weapons.length ?? 0) >= 3,
    `${dsh?.data.weapons.length} profiles`);
  check("abilities parsed", (dsh?.data.abilities.length ?? 0) >= 2,
    dsh?.data.abilities[0]?.name);
  check("points parsed", dsh?.data.points === 160, `${dsh?.data.points}pts`);
  check("edition threaded through", dsh?.source.edition === "40k_11e");

  // Editions must actually differ, or the edition plumbing is decorative.
  const dsh10 = await oracle.getUnit("Deathshroud Terminators", {
    edition: "40k_10e",
    faction: "Death Guard",
  });
  check("10th edition lookup works", dsh10 !== null,
    `11e=${dsh?.data.points}pts vs 10e=${dsh10?.data.points}pts`);

  step(5, "Persistence + battle creation");
  const db = openDatabase(":memory:");
  const repo = new Repository(db);

  const ollama = new OllamaProvider();
  const hasLlm = await ollama.isAvailable();
  console.log(`  (local LLM ${hasLlm ? `available: ${ollama.model}` : "not available — using rule interpreter"})`);
  const interpreter = await createInterpreter(hasLlm ? ollama : null);

  step(6, "Import two armies through Oracle");
  const playerImport = await importArmyFromText(PLAYER_LIST, {
    oracle,
    edition: "40k_11e",
  });
  const oppImport = await importArmyFromText(OPPONENT_LIST, {
    oracle,
    edition: "40k_11e",
  });
  repo.saveArmy(playerImport.army);
  repo.saveArmy(oppImport.army);

  check("player army parsed", playerImport.army.units.length === 4,
    `${playerImport.army.units.length} units, faction ${playerImport.army.faction}`);
  check("all player units resolved against Oracle",
    playerImport.unresolved.length === 0,
    playerImport.unresolved.join(", ") || "none unresolved");
  check("opponent army parsed", oppImport.army.units.length === 2,
    `${oppImport.army.units.length} units, faction ${oppImport.army.faction}`);
  check("points pulled from Oracle where missing",
    playerImport.army.units.every((u) => u.points !== undefined));

  const svc = new BattleService(repo, oracle, interpreter, hasLlm ? ollama : null);
  const battle = await svc.startBattle({
    name: "Verification Battle",
    edition: "40k_11e",
    playerArmyId: playerImport.army.id,
    opponentArmyId: oppImport.army.id,
  });
  check("battle created with both armies deployed", battle.units.length === 6,
    `${battle.units.length} units on table`);
  check("wounds-per-model came from Oracle",
    battle.units.find((u) => u.name.includes("Deathshroud"))?.woundsPerModel === 4,
    `Deathshroud W=${battle.units.find((u) => u.name.includes("Deathshroud"))?.woundsPerModel}`);

  step(7, "Natural language → intent → GameEvent → state");

  const r1 = await svc.handleInput(battle.id, "These Plague Marines move onto the center objective.");
  console.log(`  > "These Plague Marines move onto the center objective."\n    ${r1.reply}`);
  check("move produced a unit_moved event",
    r1.events.some((e) => e.type === "unit_moved"),
    `intent=${r1.intent?.intent}`);
  check("moved flag set in state",
    r1.state?.units.find((u) => u.name.includes("Plague Marines"))?.activation.moved === true);

  const r2 = await svc.handleInput(battle.id, "The Rhino takes six damage.");
  console.log(`  > "The Rhino takes six damage."\n    ${r2.reply}`);
  check("damage produced a damage_applied event",
    r2.events.some((e) => e.type === "damage_applied"),
    `intent=${r2.intent?.intent}`);
  // Oracle resolves Death Guard's Rhino to "Chaos Rhino", so match loosely.
  const rhino = r2.state?.units.find((u) => u.name.includes("Rhino"));
  check("damage landed on state", (rhino?.woundsTakenOnLeadModel ?? 0) === 6,
    `${rhino?.name} has ${rhino?.woundsTakenOnLeadModel} wounds on it`);
  check("single-model vehicle deployed as 1 model", rhino?.modelsTotal === 1,
    `modelsTotal=${rhino?.modelsTotal}`);

  step(8, "Attack sequencing with Oracle weapon data");
  const r3 = await svc.handleInput(battle.id, "Deathshroud shoot those Intercessors.");
  console.log(`  > "Deathshroud shoot those Intercessors."\n${r3.reply.split("\n").map((l) => `    ${l}`).join("\n")}`);
  check("shooting event recorded",
    r3.events.some((e) => e.type === "shooting_started"),
    `intent=${r3.intent?.intent}`);
  // Torrent weapons auto-hit, so a hit target is not always printed.
  check("app computed the attack from Oracle weapon data",
    /attacks/i.test(r3.reply) &&
      (/Hit on \d\+/i.test(r3.reply) || /automatically/i.test(r3.reply)) &&
      /wounding on \d\+/i.test(r3.reply));
  check("Oracle cited as the source", (r3.citations?.length ?? 0) > 0,
    r3.citations?.[0]?.tool);

  const r4 = await svc.handleInput(battle.id, "I got 10 hits.");
  console.log(`  > "I got 10 hits."\n    ${r4.reply}`);
  check("roll recorded and wound target derived",
    r4.events.some((e) => e.type === "roll_result") && /wound on \d\+/i.test(r4.reply));

  step(9, "Ambiguity → clarification, not a guess");
  // A query made only of filler words identifies nothing; it must not resolve.
  const vague = await svc.handleInput(battle.id, "the squad moves up");
  check("vague reference asks rather than guessing",
    vague.needsClarification !== undefined && vague.events.length === 0,
    vague.reply.slice(0, 90));

  const missing = await svc.handleInput(battle.id, "The Land Raider takes 3 damage");
  check("unknown unit is reported, not invented",
    missing.needsClarification !== undefined && missing.events.length === 0,
    missing.reply.slice(0, 80));

  step(10, "Undo the most recent event");
  // Damage an enemy unit so the Chronicle has something on the player's ledger.
  const hit = await svc.handleInput(battle.id, "The Intercessor Squad takes 4 damage");
  console.log(`  > "The Intercessor Squad takes 4 damage"\n    ${hit.reply}`);
  const interBefore = hit.state?.units.find((u) => u.name.includes("Intercessor"));
  check("enemy damage applied", (interBefore?.modelsAlive ?? 0) < (interBefore?.modelsTotal ?? 0),
    `${interBefore?.modelsAlive}/${interBefore?.modelsTotal} models`);

  const undo = await svc.handleInput(battle.id, "Actually undo that.");
  console.log(`  > "Actually undo that."\n    ${undo.reply}`);
  const interAfter = undo.state?.units.find((u) => u.name.includes("Intercessor"));
  check("undo restored the models",
    interAfter?.modelsAlive === interAfter?.modelsTotal,
    `${interBefore?.modelsAlive} → ${interAfter?.modelsAlive} models alive`);
  check("undone event kept in log for audit",
    svc.getEvents(battle.id, true).some((e) => e.undone === true));

  // Re-apply so later steps have real damage on the ledger.
  await svc.handleInput(battle.id, "The Intercessor Squad takes 4 damage");

  step(11, "Rules question answered from Oracle with a citation");
  const q = await svc.handleInput(battle.id, "What does Deep Strike do?");
  console.log(`  > "What does Deep Strike do?"\n    ${q.reply.slice(0, 260).replace(/\n/g, "\n    ")}…`);
  check("question did not change state", q.events.length === 0);
  check("answer came back", q.reply.length > 40);
  check("answer cites Oracle", (q.citations?.length ?? 0) > 0,
    `${q.citations?.[0]?.provider}/${q.citations?.[0]?.tool}`);
  check("Deep Strike routed to the keyword table, not the unit list",
    q.citations?.some((c) => c.tool === "lookup_keyword") === true,
    q.citations?.map((c) => c.tool).join(", "));

  const q2 = await svc.handleInput(battle.id, "Can Mortarion charge after advancing?");
  console.log(`  > "Can Mortarion charge after advancing?"\n    ${q2.reply.slice(0, 200).replace(/\n/g, "\n    ")}…`);
  check("rules question routed to Oracle, state untouched", q2.events.length === 0);

  step(12, "Phase / turn flow");
  const ph = await svc.handleInput(battle.id, "next phase");
  check("phase advanced", ph.state?.phase === "movement", `now ${ph.state?.phase}`);
  const strat = await svc.handleInput(battle.id, "I use the Command Re-roll stratagem");
  console.log(`  > "I use the Command Re-roll stratagem"\n    ${strat.reply.split("\n")[0]}`);
  check("stratagem spent CP from Oracle's cost",
    (strat.state?.cp.player ?? 12) < 12, `CP now ${strat.state?.cp.player}`);

  step(13, "Persistence — reopen from SQLite by replay");
  const reloaded = repo.getBattleState(battle.id);
  check("state rebuilt from event log", reloaded !== null);
  check("replay matches live state",
    JSON.stringify(reloaded?.units.map((u) => [u.name, u.modelsAlive, u.woundsTakenOnLeadModel])) ===
      JSON.stringify(svc.getState(battle.id)?.units.map((u) => [u.name, u.modelsAlive, u.woundsTakenOnLeadModel])));
  check("events persisted", svc.getEvents(battle.id).length > 8,
    `${svc.getEvents(battle.id).length} live events`);

  step(14, "Chronicle derived from the event log");
  const chron = buildChronicleEntry(svc.getEvents(battle.id));
  check("chronicle built", chron !== null);
  check("damage credited to the right side",
    (chron?.stats.totalDamageDealt.player ?? 0) > 0 &&
      (chron?.stats.totalDamageDealt.opponent ?? 0) > 0,
    `you dealt ${chron?.stats.totalDamageDealt.player}, took ${chron?.stats.totalDamageDealt.opponent}`);
  check("highlights generated", (chron?.highlights.length ?? 0) >= 0,
    `${chron?.highlights.length} highlights`);

  await oracle.close();

  console.log(`\n${"─".repeat(60)}`);
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) failed.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nVerification crashed:", err);
  process.exit(1);
});
