/**
 * Turning what the user said into which unit they meant.
 *
 * This is deliberately application code, not model work. The model does not
 * hold battle state and must not be the thing deciding whether "my terminators"
 * is one unit or two. Scoring is transparent and the tie rule is strict: when
 * two candidates are equally good, we ask.
 */

import type { BattleState, BattleUnit, PlayerSide } from "./types.js";
import type { TargetRef } from "./intent.js";

export type ResolveResult =
  | { status: "resolved"; unit: BattleUnit }
  | { status: "ambiguous"; question: string; candidates: BattleUnit[] }
  | { status: "not_found"; query: string };

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words too common in unit names to distinguish anything. */
const STOP = new Set([
  "squad", "unit", "the", "of", "and", "a", "an", "my", "their", "team",
  "in", "with", "on", "at", "to",
]);

/** Crude singulariser so "Intercessors" matches "Intercessor Squad". */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function tokens(s: string): string[] {
  return normalise(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/**
 * 0 means no match. Higher is better. Exact name wins outright; otherwise we
 * reward how much of the query the candidate covers.
 */
function score(query: string, unit: BattleUnit): number {
  const q = normalise(query);
  const name = normalise(unit.name);
  const datasheet = normalise(unit.ref.name);

  if (q === name || q === datasheet) return 1000;

  const qt = tokens(query);
  // A query made only of filler ("the squad", "that unit") identifies nothing.
  // Matching it on substring would silently pick whoever sorts first.
  if (qt.length === 0) return 0;

  if (name.startsWith(q) || datasheet.startsWith(q)) return 800;
  if (name.includes(q) || datasheet.includes(q)) return 600;

  const nameTokens = new Set([...tokens(unit.name), ...tokens(unit.ref.name)]);
  let matched = 0;
  for (const t of qt) {
    if (nameTokens.has(t)) {
      matched += 1;
      continue;
    }
    // Partial token match ("termie" -> "terminator") is worth less, and needs
    // a real prefix in common — without a floor, a two-letter word like "in"
    // matches almost anything and makes unrelated units look equally likely.
    for (const nt of nameTokens) {
      const shared = Math.min(nt.length, t.length);
      if (shared >= 4 && (nt.startsWith(t) || t.startsWith(nt))) {
        matched += 0.5;
        break;
      }
    }
  }
  if (matched === 0) return 0;

  // Coverage of the query matters more than length of the unit's name.
  return Math.round((matched / qt.length) * 400);
}

export interface ResolveOptions {
  /** Restrict to one side, when the utterance said "my" or "their". */
  side?: PlayerSide;
  /** Include destroyed units — needed for corrections about dead squads. */
  includeDestroyed?: boolean;
  /** Prefer a unit that has not acted this phase, for activation commands. */
  preferUnactivated?: "shot" | "moved" | "charged" | "fought";
}

export function resolveUnit(
  state: BattleState,
  ref: TargetRef | string,
  opts: ResolveOptions = {},
): ResolveResult {
  const query = typeof ref === "string" ? ref : ref.name;
  const side = opts.side ?? (typeof ref === "string" ? undefined : ref.side);

  let pool = state.units;
  if (!opts.includeDestroyed) pool = pool.filter((u) => !u.destroyed);
  if (side) pool = pool.filter((u) => u.side === side);

  const scored = pool
    .map((unit) => ({ unit, s: score(query, unit) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length === 0) return { status: "not_found", query };

  const best = scored[0]!;
  const tied = scored.filter((x) => x.s === best.s);

  if (tied.length === 1) return { status: "resolved", unit: best.unit };

  // Equal scores: try the activation hint before giving up and asking.
  if (opts.preferUnactivated) {
    const flag = opts.preferUnactivated;
    const idle = tied.filter((x) => !x.unit.activation[flag]);
    if (idle.length === 1) return { status: "resolved", unit: idle[0]!.unit };
  }

  // Still tied. Ask — never pick.
  const candidates = tied.map((x) => x.unit);
  return {
    status: "ambiguous",
    question: `${candidates
      .slice(0, -1)
      .map((c) => c.name)
      .join(", ")} or ${candidates[candidates.length - 1]!.name}?`,
    candidates,
  };
}

/** Objectives resolve the same way but the space is small and flat. */
export function resolveObjective(
  state: BattleState,
  query: string,
): { id: string; name: string } | null {
  const q = normalise(query);
  const exact = state.objectives.find((o) => normalise(o.name) === q);
  if (exact) return { id: exact.id, name: exact.name };

  const partial = state.objectives.filter(
    (o) => normalise(o.name).includes(q) || q.includes(normalise(o.name)),
  );
  if (partial.length === 1) return { id: partial[0]!.id, name: partial[0]!.name };
  return null;
}

/** The side an intent refers to, defaulting to whoever is acting. */
export function resolveSide(
  state: BattleState,
  explicit?: PlayerSide | null,
): PlayerSide {
  return explicit ?? state.activePlayer;
}
