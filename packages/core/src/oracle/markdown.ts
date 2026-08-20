/**
 * Oracle answers in markdown meant for a chat window, not JSON. This module is
 * the whole cost of that: it turns those documents back into structured data so
 * the rest of the app never does string surgery on rules text.
 *
 * Everything is defensive. Oracle is a moving target (data is regenerated from
 * BSData daily), so a parse miss degrades to a null field and the `raw` text is
 * always kept for display and citation.
 */

import type {
  AbilityInfo,
  DetachmentData,
  EnhancementData,
  GameFlowData,
  KeywordData,
  PhaseData,
  StatProfile,
  StratagemData,
  UnitData,
  UnitSummary,
  WeaponProfile,
  WoundCalcResult,
} from "./provider.js";
import type { Edition } from "../domain/types.js";

/**
 * BSData text carries `^^**Bold^^**` markers and stray markdown. Strip them so
 * ability text reads like prose in the UI.
 */
export function cleanText(s: string): string {
  return s
    .replace(/\^\^\*\*/g, "")
    .replace(/\^\^/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Oracle stamps every response with `[Mode: 40k 11e]`. */
export function parseModeStamp(md: string): string | null {
  const m = md.match(/^\[Mode:\s*([^\]]+)\]/m);
  return m?.[1]?.trim() ?? null;
}

export function isNotFound(md: string): boolean {
  return /^No (unit|Kill Team operative|units|stratagem|stratagems|keyword|phase|detachment|enhancement|ploy)\b.*(found|matching)/im.test(
    md.trim(),
  );
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Pull every pipe table out of a document, in order. */
export function parseTables(md: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    const looksLikeHeader = line.trim().startsWith("|") && line.includes("|");
    const looksLikeSeparator = /^\s*\|[\s:|-]+\|\s*$/.test(next);

    if (looksLikeHeader && looksLikeSeparator) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      tables.push({ headers, rows });
      continue;
    }
    i += 1;
  }
  return tables;
}

/** Body of a `### Heading` section, up to the next heading of the same or higher level. */
export function sectionBody(md: string, heading: string): string | null {
  const re = new RegExp(
    `^#{1,4}\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im",
  );
  const m = md.match(re);
  if (!m || m.index === undefined) return null;
  const rest = md.slice(m.index + m[0].length);
  const nextHeading = rest.search(/^#{1,4}\s+/m);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

function toNumberOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ---------------------------------------------------------------------------
// lookup_unit
// ---------------------------------------------------------------------------

function parseStatTable(t: MarkdownTable | undefined): StatProfile[] {
  if (!t) return [];
  return t.rows
    .filter((r) => r.length >= 7)
    .map((r) => ({
      name: cleanText(r[0] ?? ""),
      movement: r[1] ?? "",
      toughness: r[2] ?? "",
      save: r[3] ?? "",
      wounds: r[4] ?? "",
      leadership: r[5] ?? "",
      objectiveControl: r[6] ?? "",
    }));
}

function parseWeaponTable(
  t: MarkdownTable | undefined,
  kind: WeaponProfile["kind"],
): WeaponProfile[] {
  if (!t) return [];
  return t.rows
    .filter((r) => r.length >= 8)
    .map((r) => ({
      // Multi-profile weapons are prefixed with "➤ ".
      name: cleanText((r[0] ?? "").replace(/^➤\s*/, "")),
      range: r[1] ?? "",
      attacks: r[2] ?? "",
      skill: r[3] ?? "",
      strength: r[4] ?? "",
      armourPenetration: r[5] ?? "",
      damage: r[6] ?? "",
      keywords:
        (r[7] ?? "") === "-"
          ? []
          : (r[7] ?? "")
              .split(",")
              .map((k) => cleanText(k))
              .filter(Boolean),
      kind,
    }));
}

function parseAbilityList(body: string | null): AbilityInfo[] {
  if (!body) return [];
  const abilities: AbilityInfo[] = [];
  // Each ability starts at "- **Name**:" and runs until the next one, or the
  // end of the section. `$(?![\s\S])` is the end-of-input anchor — JS has no
  // `\Z`, and using one silently drops the final ability of every datasheet.
  const re = /^-\s+\*\*(.+?)\*\*:\s*([\s\S]*?)(?=^-\s+\*\*|$(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    abilities.push({
      name: cleanText(m[1] ?? ""),
      description: cleanText(m[2] ?? ""),
    });
  }
  return abilities;
}

export function parseUnit(md: string, edition: Edition): UnitData | null {
  if (isNotFound(md)) return null;

  const nameMatch = md.match(/^#\s+(.+)$/m);
  if (!nameMatch) return null;

  // "**Faction:** Death Guard — 160 pts | **Unit Size:** 3-6 models"
  const header = md.match(
    /\*\*Faction:\*\*\s*(.+?)(?:\s*—\s*(\d+)\s*pts)?\s*\|\s*\*\*Unit Size:\*\*\s*(\d+)(?:-(\d+))?\s*models?/i,
  );

  const tables = parseTables(md);
  // Section order from Oracle is stable: profiles, ranged, melee.
  const profileTable = tables.find((t) => t.headers[1] === "M");
  const rangedTable = tables.find((t) => t.headers.includes("BS"));
  const meleeTable = tables.find((t) => t.headers.includes("WS"));

  const keywordsBody = sectionBody(md, "Keywords");

  const min = header?.[3] ? Number(header[3]) : 1;
  const max = header?.[4] ? Number(header[4]) : min;

  return {
    name: cleanText(nameMatch[1] ?? ""),
    faction: cleanText(header?.[1] ?? "Unknown"),
    points: header?.[2] ? Number(header[2]) : null,
    unitSize: { min, max },
    profiles: parseStatTable(profileTable),
    weapons: [
      ...parseWeaponTable(rangedTable, "ranged"),
      ...parseWeaponTable(meleeTable, "melee"),
    ],
    abilities: parseAbilityList(sectionBody(md, "Abilities")),
    keywords: keywordsBody
      ? keywordsBody
          .split(",")
          .map((k) => cleanText(k))
          .filter(Boolean)
      : [],
    edition,
    raw: md,
  };
}

// ---------------------------------------------------------------------------
// search_units
// ---------------------------------------------------------------------------

export function parseUnitSummaries(md: string): UnitSummary[] {
  if (isNotFound(md)) return [];
  const out: UnitSummary[] = [];
  // "**Name** (Faction) — 90pts — 6-11 models — Keywords: a, b, c"
  const re =
    /^\*\*(.+?)\*\*\s*\((.+?)\)\s*—\s*(\d+pts|pts N\/A)\s*—\s*(\d+)(?:-(\d+))?\s*models?\s*—\s*Keywords:\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const min = Number(m[4]);
    const max = m[5] ? Number(m[5]) : min;
    out.push({
      name: cleanText(m[1] ?? ""),
      faction: cleanText(m[2] ?? ""),
      points: toNumberOrNull(m[3]),
      unitSize: { min, max },
      keywords:
        (m[6] ?? "").trim() === "None"
          ? []
          : (m[6] ?? "")
              .split(",")
              .map((k) => cleanText(k))
              .filter(Boolean),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// stratagems / keywords / phases
// ---------------------------------------------------------------------------

/** Grab "**Label:** value" from a document. */
function labelled(md: string, label: string): string | undefined {
  const re = new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*(.+)`, "i");
  const m = md.match(re);
  return m?.[1] ? cleanText(m[1]) : undefined;
}

export function parseStratagem(md: string): StratagemData | null {
  if (isNotFound(md)) return null;
  const nameMatch = md.match(/^#\s+(.+)$/m) ?? md.match(/^\*\*(.+?)\*\*/m);
  if (!nameMatch) return null;

  const cpText =
    labelled(md, "CP Cost") ?? labelled(md, "Cost") ?? labelled(md, "CP");
  const inlineCp = md.match(/(\d+)\s*CP/i);

  return {
    name: cleanText(nameMatch[1] ?? ""),
    faction: labelled(md, "Faction"),
    detachment: labelled(md, "Detachment"),
    cpCost: toNumberOrNull(cpText) ?? (inlineCp ? Number(inlineCp[1]) : null),
    phase: labelled(md, "Phase"),
    when: labelled(md, "When") ?? sectionBody(md, "When") ?? undefined,
    target: labelled(md, "Target") ?? sectionBody(md, "Target") ?? undefined,
    effect: labelled(md, "Effect") ?? sectionBody(md, "Effect") ?? undefined,
    raw: md,
  };
}

export function parseStratagemList(md: string): StratagemData[] {
  if (isNotFound(md)) return [];
  const out: StratagemData[] = [];
  const re = /^\*\*(.+?)\*\*\s*(?:\((.+?)\))?\s*—\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const rest = m[3] ?? "";
    const cp = rest.match(/(\d+)\s*CP/i);
    out.push({
      name: cleanText(m[1] ?? ""),
      faction: m[2] ? cleanText(m[2]) : undefined,
      cpCost: cp ? Number(cp[1]) : null,
      effect: cleanText(rest),
      raw: m[0],
    });
  }
  return out;
}

export function parseKeyword(md: string): KeywordData | null {
  if (isNotFound(md)) return null;
  const nameMatch = md.match(/^#\s+(.+)$/m);
  if (!nameMatch) return null;
  const plain =
    sectionBody(md, "Plain English") ?? sectionBody(md, "In Plain English");
  const examplesBody = sectionBody(md, "Examples");
  return {
    name: cleanText(nameMatch[1] ?? ""),
    description:
      sectionBody(md, "Official Definition") ??
      sectionBody(md, "Definition") ??
      sectionBody(md, "Rule") ??
      cleanText(md.replace(/^#.+$/m, "").slice(0, 800)),
    plainEnglish: plain ? cleanText(plain) : undefined,
    examples: examplesBody
      ? examplesBody
          .split("\n")
          .map((l) => cleanText(l.replace(/^[-*]\s*/, "")))
          .filter(Boolean)
      : undefined,
    raw: md,
  };
}

function bulletList(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+\.)\s+/.test(l))
    .map((l) => cleanText(l.replace(/^([-*]|\d+\.)\s+/, "")))
    .filter(Boolean);
}

export function parsePhase(md: string): PhaseData | null {
  if (isNotFound(md)) return null;
  const nameMatch = md.match(/^#\s+(.+)$/m);
  if (!nameMatch) return null;
  return {
    name: cleanText(nameMatch[1] ?? ""),
    steps: bulletList(sectionBody(md, "Steps")),
    tips: bulletList(sectionBody(md, "Tips")),
    raw: md,
  };
}

export function parseGameFlow(md: string): GameFlowData {
  // Oracle writes the sequence as headings — "## 1. Command Phase", and when a
  // current phase is supplied, "## → YOU ARE HERE: Command Phase" and
  // "## **Next → Movement Phase**". Bullets are only a fallback.
  const phases: string[] = [];
  const headingRe = /^#{2,3}\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(md)) !== null) {
    const name = cleanText(m[1] ?? "")
      .replace(/^\d+\.\s*/, "")
      .replace(/^→\s*/, "")
      .replace(/^YOU ARE HERE:\s*/i, "")
      .replace(/^Next\s*→\s*/i, "")
      .trim();
    if (name.length > 2 && name.length < 40) phases.push(name);
  }

  const current = md.match(/YOU ARE HERE:\s*(.+?)\s*$/im)?.[1];
  const next = md.match(/Next\s*→\s*(.+?)\*{0,2}\s*$/im)?.[1];

  return {
    phases: phases.length > 0 ? phases : bulletList(md).filter((l) => l.length < 80),
    current: current ? cleanText(current) : undefined,
    next: next ? cleanText(next) : undefined,
    raw: md,
  };
}

// ---------------------------------------------------------------------------
// wound_calculator
// ---------------------------------------------------------------------------

export function parseWoundCalc(md: string): WoundCalcResult {
  const tables = parseTables(md);
  const results = tables.find((t) => t.headers[0]?.toLowerCase() === "step");

  const pick = (label: string): number | null => {
    const row = results?.rows.find((r) =>
      (r[0] ?? "").toLowerCase().includes(label.toLowerCase()),
    );
    return toNumberOrNull(row?.[1]);
  };

  return {
    expectedHits: pick("hits"),
    expectedWounds: pick("wounds"),
    expectedUnsaved: pick("unsaved"),
    expectedDamage: pick("damage dealt"),
    interactions: bulletList(sectionBody(md, "Key Interactions")),
    raw: md,
  };
}

// ---------------------------------------------------------------------------
// detachments / enhancements
// ---------------------------------------------------------------------------

export function parseDetachment(md: string): DetachmentData | null {
  if (isNotFound(md)) return null;
  const nameMatch = md.match(/^#\s+(.+)$/m);
  if (!nameMatch) return null;
  return {
    name: cleanText(nameMatch[1] ?? ""),
    faction: labelled(md, "Faction"),
    ability:
      sectionBody(md, "Detachment Rule") ??
      sectionBody(md, "Detachment Ability") ??
      undefined,
    enhancements: bulletList(sectionBody(md, "Enhancements")).map((e) =>
      e.replace(/:.*$/, "").trim(),
    ),
    stratagems: bulletList(sectionBody(md, "Stratagems")).map((e) =>
      e.replace(/:.*$/, "").trim(),
    ),
    raw: md,
  };
}

export function parseEnhancement(md: string): EnhancementData | null {
  if (isNotFound(md)) return null;
  const nameMatch = md.match(/^#\s+(.+)$/m);
  if (!nameMatch) return null;
  return {
    name: cleanText(nameMatch[1] ?? ""),
    faction: labelled(md, "Faction"),
    detachment: labelled(md, "Detachment"),
    points: toNumberOrNull(labelled(md, "Points") ?? md.match(/(\d+)\s*pts/i)?.[0]),
    effect: sectionBody(md, "Effect") ?? undefined,
    raw: md,
  };
}
