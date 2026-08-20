/**
 * Pasted army list -> Army, with every unit checked against Oracle.
 *
 * Two-stage on purpose. A structural pass handles the formats people actually
 * paste (GW app export, BattleScribe, WTC plain text) deterministically and
 * fast; the LLM is a fallback for prose the parser cannot see. Whichever ran,
 * every extracted name is then resolved against Oracle, and unresolved entries
 * are flagged rather than silently accepted.
 */

import { randomUUID } from "node:crypto";
import type { Army, ArmyUnitEntry, Edition } from "../domain/types.js";
import type { WarhammerDataProvider } from "../oracle/provider.js";
import type { LLMProvider } from "../ai/provider.js";
import { nameVariants } from "./name-variants.js";
import { extractJson } from "../ai/provider.js";

export interface ParsedListLine {
  name: string;
  modelCount?: number;
  points?: number;
  wargear: string[];
  enhancement?: string;
  isWarlord?: boolean;
}

export interface ImportResult {
  army: Army;
  /** Entries Oracle could not confirm — surfaced in the UI for the user to fix. */
  unresolved: string[];
  /** Where the structure came from, so the UI can say how confident to be. */
  method: "structured" | "llm";
  warnings: string[];
}

/** Header noise that is never a unit. */
const HEADER_RE =
  /^(?:\+{2,}|={2,}|-{3,}|army roster|roster|exported with|created with|battlescribe|new recruit|total(?:\s+points)?|character|battleline|infantry|other datasheets|dedicated transport|allied units|mounted|vehicle|monster|fortification|epic hero|beast|swarm|units?:|show\s|no force org)/i;

const FACTION_RE =
  /(?:faction|army)\s*(?:keyword)?\s*[:\-–]\s*(.+)|^\s*(?:\+\s*)?faction\s*[:\-–]\s*(.+)/i;
const DETACHMENT_RE = /detachment\s*[:\-–]?\s*(.+)/i;
const POINTS_LIMIT_RE = /\((\d{3,4})\s*(?:pts|points)\)|(\d{3,4})\s*(?:pts|points)\s*(?:list|army|total)?/i;

/**
 * A unit line. Handles:
 *   "Plague Marines (90 points)"
 *   "10x Plague Marines .......... 180"
 *   "1 Rhino [75 pts]"
 *   "Mortarion - 325"
 */
const UNIT_LINE_RE =
  /^\s*(?:[-*•]\s*)?(?:(\d+)\s*[x×]?\s+)?([A-Za-z][A-Za-z0-9'’,\-\s/]+?)\s*(?:[.\s]{2,}|\s*[-–—:]\s*|\s+)?(?:[\[(]?\s*(\d{1,4})\s*(?:pts|points|pt)?\s*[\])]?)?\s*$/;

function looksLikeHeader(line: string): boolean {
  return HEADER_RE.test(line.trim());
}

/** Wargear/enhancement sub-lines are indented or bulleted under their unit. */
function isSubLine(line: string): boolean {
  return /^\s{2,}[•\-*◦]|^\s*[•◦]\s|^\s{4,}\S/.test(line);
}

export function parseListStructurally(text: string): {
  faction?: string;
  detachment?: string;
  pointsLimit?: number;
  name?: string;
  units: ParsedListLine[];
} {
  const rawLines = text.split(/\r?\n/);
  const units: ParsedListLine[] = [];
  let faction: string | undefined;
  let detachment: string | undefined;
  let pointsLimit: number | undefined;
  let name: string | undefined;

  // First non-empty line is usually the list's name. Remember which line that
  // was so the unit pass skips it — otherwise "Death Guard Strike Force (2000
  // points)" gets imported as a 2000-point unit.
  const titleIndex = rawLines.findIndex((l) => l.trim().length > 0);
  const firstReal = titleIndex >= 0 ? rawLines[titleIndex] : undefined;
  if (firstReal && !looksLikeHeader(firstReal)) {
    const cleaned = firstReal.replace(/[\[(]?\d+\s*(?:points|pts)[\])]?/i, "").trim();
    if (cleaned.length > 0 && cleaned.length < 80) name = cleaned;
  }

  for (const [index, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (!line) continue;

    if (!pointsLimit) {
      const m = line.match(POINTS_LIMIT_RE);
      const v = m?.[1] ?? m?.[2];
      if (v) {
        const n = Number(v);
        // Only treat round numbers as a list size, not a unit's cost.
        if (n >= 500 && n % 5 === 0 && /points|pts/i.test(line)) pointsLimit = n;
      }
    }

    if (!faction) {
      const m = line.match(FACTION_RE);
      const v = (m?.[1] ?? m?.[2])?.trim();
      if (v && v.length < 60) faction = v.replace(/[+*]/g, "").trim();
    }

    if (!detachment && /detachment/i.test(line)) {
      const m = line.match(DETACHMENT_RE);
      const v = m?.[1]?.trim();
      if (v && v.length < 60) detachment = v.replace(/[+*]/g, "").trim();
    }

    // Attach wargear and enhancements to the unit above.
    if (isSubLine(raw) && units.length > 0) {
      const last = units[units.length - 1]!;
      const item = line.replace(/^[•◦\-*\s]+/, "").trim();
      if (!item) continue;
      if (/^enhancement\s*[:\-–]?\s*/i.test(item)) {
        last.enhancement = item.replace(/^enhancement\s*[:\-–]?\s*/i, "").trim();
      } else if (/warlord/i.test(item)) {
        last.isWarlord = true;
      } else if (item.length < 80) {
        last.wargear.push(item.replace(/^\d+\s*[x×]\s*/i, ""));
      }
      continue;
    }

    if (index === titleIndex) continue;
    if (looksLikeHeader(line)) continue;
    if (/^(?:faction|detachment|show|export)/i.test(line)) continue;
    // A line stating the list size is metadata, not a unit costing 2000 points.
    if (/\b\d{3,4}\s*(?:points|pts)\b/i.test(line) && /\b(?:1000|1500|2000|3000)\b/.test(line)) {
      continue;
    }

    const m = line.match(UNIT_LINE_RE);
    if (!m) continue;

    const unitName = (m[2] ?? "").trim().replace(/\s+/g, " ");
    if (unitName.length < 3 || unitName.length > 60) continue;
    // A bare number or a word like "points" is not a unit.
    if (!/[a-zA-Z]{3}/.test(unitName)) continue;

    units.push({
      name: unitName,
      modelCount: m[1] ? Number(m[1]) : undefined,
      points: m[3] ? Number(m[3]) : undefined,
      wargear: [],
    });
  }

  return { faction, detachment, pointsLimit, name, units };
}

const LIST_PROMPT = `Extract a Warhammer 40,000 army list into JSON.

Return exactly:
{"name":"...","faction":"...","detachment":"...","pointsLimit":N,
 "units":[{"name":"...","modelCount":N,"points":N,"wargear":["..."],"enhancement":"...","isWarlord":true}]}

Rules:
- "name" of each unit must be the datasheet name only — no points, no model count, no wargear.
- Omit fields you cannot determine. Never guess points values.
- Include every unit exactly once.
- JSON only.`;

async function parseListWithLLM(
  text: string,
  llm: LLMProvider,
): Promise<ReturnType<typeof parseListStructurally>> {
  const raw = await llm.chat(
    [
      { role: "system", content: LIST_PROMPT },
      { role: "user", content: text.slice(0, 8_000) },
    ],
    { json: true, temperature: 0 },
  );

  const parsed = extractJson(raw) as {
    name?: string;
    faction?: string;
    detachment?: string;
    pointsLimit?: number;
    units?: ParsedListLine[];
  };

  return {
    name: parsed.name,
    faction: parsed.faction,
    detachment: parsed.detachment,
    pointsLimit: parsed.pointsLimit,
    units: (parsed.units ?? []).map((u) => ({
      name: String(u.name ?? "").trim(),
      modelCount: u.modelCount,
      points: u.points,
      wargear: Array.isArray(u.wargear) ? u.wargear : [],
      enhancement: u.enhancement,
      isWarlord: u.isWarlord,
    })).filter((u) => u.name.length > 2),
  };
}

/**
 * Vehicles, Monsters and Epic Heroes are one model regardless of what Oracle's
 * unitSize says, and its data is wrong for several of them.
 */
function singleModelCount(unit: {
  keywords: string[];
  profiles: unknown[];
}): number | null {
  const single = /^(vehicle|monster|epic hero)$/i;
  const isSingle = unit.keywords.some((k) => single.test(k.trim()));
  return isSingle && unit.profiles.length <= 1 ? 1 : null;
}

export async function importArmyFromText(
  text: string,
  opts: {
    oracle: WarhammerDataProvider;
    edition: Edition;
    llm?: LLMProvider | null;
    name?: string;
    faction?: string;
  },
): Promise<ImportResult> {
  const warnings: string[] = [];
  let method: ImportResult["method"] = "structured";

  let parsed = parseListStructurally(text);

  // Too little structure to trust — let the model read it as prose.
  if (parsed.units.length < 2 && opts.llm) {
    try {
      const viaLlm = await parseListWithLLM(text, opts.llm);
      if (viaLlm.units.length > parsed.units.length) {
        parsed = viaLlm;
        method = "llm";
      }
    } catch (err) {
      warnings.push(
        `AI list parsing failed, used the structural parser: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (parsed.units.length === 0) {
    throw new Error(
      "I couldn't find any units in that. Paste the list with one unit per line.",
    );
  }

  const faction = opts.faction ?? parsed.faction;
  const unresolved: string[] = [];
  const entries: ArmyUnitEntry[] = [];

  // Confirm every name against Oracle. This is what turns a pasted string into
  // a real reference, and what catches OCR and typo damage early.
  for (const u of parsed.units) {
    let resolvedName = u.name;
    let resolvedFaction = faction;
    let resolved = false;
    let modelCount = u.modelCount;
    let points = u.points;

    try {
      // A list may spell a unit loosely ("Rhinos", "Terminators"); try the
      // obvious variants before calling it unresolved.
      let hit = null as Awaited<ReturnType<typeof opts.oracle.getUnit>>;
      for (const variant of nameVariants(u.name)) {
        if (hit) break;
        hit = await opts.oracle.getUnit(variant, {
          edition: opts.edition,
          faction,
        });
      }
      if (hit) {
        resolved = true;
        resolvedName = hit.data.name;
        resolvedFaction = hit.data.faction;
        // Oracle knows legal unit sizes; use the minimum when the list omitted
        // one. Its unitSize is unreliable for single-model datasheets (a Rhino
        // comes back as 2), so trust the statline count for those instead.
        if (modelCount === undefined) {
          modelCount = singleModelCount(hit.data) ?? hit.data.unitSize.min;
        }
        if (points === undefined && hit.data.points !== null) {
          points = hit.data.points;
        }
      } else {
        const search = await opts.oracle.searchUnits(u.name, {
          edition: opts.edition,
          faction,
        });
        const best = search.data[0];
        if (best) {
          resolved = true;
          resolvedName = best.name;
          resolvedFaction = best.faction;
          if (modelCount === undefined) modelCount = best.unitSize?.min ?? 1;
          if (points === undefined && best.points !== null) points = best.points;
          warnings.push(`"${u.name}" matched to "${best.name}".`);
        }
      }
    } catch (err) {
      warnings.push(
        `Oracle lookup failed for "${u.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!resolved) unresolved.push(u.name);

    entries.push({
      id: randomUUID(),
      ref: {
        name: resolvedName,
        faction: resolvedFaction,
        edition: opts.edition,
        resolved,
        ...(resolved ? { resolvedAt: new Date().toISOString() } : {}),
      },
      modelCount: modelCount ?? 1,
      points,
      wargear: u.wargear,
      enhancement: u.enhancement,
      isWarlord: u.isWarlord,
    });
  }

  // Infer the army faction from what the units actually resolved to.
  const factionCounts = new Map<string, number>();
  for (const e of entries) {
    if (!e.ref.faction) continue;
    factionCounts.set(e.ref.faction, (factionCounts.get(e.ref.faction) ?? 0) + 1);
  }
  const inferredFaction =
    [...factionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    faction ??
    "Unknown";

  const ts = new Date().toISOString();
  const army: Army = {
    id: randomUUID(),
    name: opts.name ?? parsed.name ?? `${inferredFaction} List`,
    faction: inferredFaction,
    detachment: parsed.detachment,
    edition: opts.edition,
    pointsLimit: parsed.pointsLimit,
    units: entries,
    sourceText: text,
    createdAt: ts,
    updatedAt: ts,
  };

  return { army, unresolved, method, warnings };
}
