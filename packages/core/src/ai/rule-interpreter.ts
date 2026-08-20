/**
 * Deterministic pattern interpreter.
 *
 * Two jobs. It is the fallback when no local model is installed, so the app is
 * useful out of the box; and it front-runs the model for the phrasings that
 * dominate real play ("6 damage to the Rhino", "next phase", "undo"), which is
 * both faster and more reliable than a 7B model on the same input.
 *
 * It only claims an utterance it is confident about. Anything else returns null
 * and the LLM gets it.
 */

import type { Intent } from "../domain/intent.js";

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  a: 1, an: 1,
};

export function parseNumber(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (/^-?\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;

/** Strip possessives and articles so "my Rhino" and "the Rhino" match alike. */
function cleanTarget(s: string): string {
  return s
    .replace(/^(the|my|our|their|his|her|its|a|an|those|these|that|this)\s+/gi, "")
    .replace(/[.,!?;:]+$/, "")
    .trim();
}

function target(name: string, side?: "player" | "opponent") {
  return { name: cleanTarget(name), ...(side ? { side } : {}) };
}

/** "their Intercessors" / "enemy Rhino" tells us which side without asking. */
function sideFromPhrase(phrase: string): "player" | "opponent" | undefined {
  if (/\b(their|enemy|opponent'?s?|his|her|hostile)\b/i.test(phrase)) {
    return "opponent";
  }
  if (/\b(my|our|mine)\b/i.test(phrase)) return "player";
  return undefined;
}

type Rule = { re: RegExp; build: (m: RegExpMatchArray) => Intent | null };

const RULES: Rule[] = [
  // --- undo / corrections ---
  {
    re: /^(?:actually\s+)?(?:undo|revert|take that back|scratch that|nevermind|never mind)(?:\s+(?:the\s+)?last\s+(\d+))?/i,
    build: (m) => ({ intent: "undo", count: parseNumber(m[1]) ?? 1 }),
  },

  // --- damage ---
  {
    // "The Rhino takes six damage" / "Rhino took 6 wounds"
    re: new RegExp(
      `^(.+?)\\s+(?:takes?|took|suffers?|suffered|has taken)\\s+${NUM}\\s*(mortal\\s+)?(?:damage|wounds?|dmg)`,
      "i",
    ),
    build: (m) => {
      const amount = parseNumber(m[2]);
      if (amount === null) return null;
      return {
        intent: "apply_damage",
        target: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
        amount,
        ...(m[3] ? { mortal: true } : {}),
      };
    },
  },
  {
    // "deal 6 damage to the Rhino" / "6 damage to the Rhino"
    re: new RegExp(
      `^(?:deal|do|apply|put)?\\s*${NUM}\\s*(mortal\\s+)?(?:damage|wounds?|dmg)\\s+(?:to|on)\\s+(.+)$`,
      "i",
    ),
    build: (m) => {
      const amount = parseNumber(m[1]);
      if (amount === null) return null;
      return {
        intent: "apply_damage",
        target: target(m[3] ?? "", sideFromPhrase(m[3] ?? "")),
        amount,
        ...(m[2] ? { mortal: true } : {}),
      };
    },
  },

  // --- casualties ---
  {
    re: new RegExp(
      `^(?:i\\s+)?(?:lose|lost|remove|kill(?:ed)?)\\s+${NUM}\\s+(?:models?|guys?)(?:\\s+(?:from|of|on)\\s+(?:the\\s+)?(.+))?$`,
      "i",
    ),
    build: (m) => {
      const count = parseNumber(m[1]);
      if (count === null || !m[2]) return null;
      return { intent: "destroy_models", target: target(m[2]), count };
    },
  },
  {
    re: new RegExp(`^(.+?)\\s+lose[sd]?\\s+${NUM}\\s+models?$`, "i"),
    build: (m) => {
      const count = parseNumber(m[2]);
      if (count === null) return null;
      return {
        intent: "destroy_models",
        target: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
        count,
      };
    },
  },

  // --- movement ---
  {
    // "These Plague Marines move onto the center objective."
    // Longest verb forms first: "move" would otherwise match inside "moves"
    // and leave the trailing "s" glued to the position.
    re: /^(.+?)\s+(?:moves|moved|move|advances|advanced|advance|falls back|fall back|fell back)\b\s*(?:(?:on)?to|towards?|into|onto|up to|behind|in front of|up|forward)?\s*(.*)$/i,
    build: (m) => {
      const raw = m[0] ?? "";
      const advanced = /\badvanc/i.test(raw);
      const fellBack = /\bf(?:ell|all|alls) back\b/i.test(raw);
      const dist = raw.match(/(\d+)\s*(?:"|''|inches|inch|in)\b/i);
      const pos = (m[2] ?? "").trim().replace(/[.,!?]+$/, "");
      return {
        intent: "move_unit",
        target: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
        ...(pos && !/^\d+\s*("|inches|inch)?$/i.test(pos) ? { position: pos } : {}),
        ...(advanced ? { advanced: true } : {}),
        ...(fellBack ? { fellBack: true } : {}),
        ...(dist?.[1] ? { distance: Number(dist[1]) } : {}),
      };
    },
  },

  // --- shooting / fighting / charging ---
  {
    re: /^(.+?)\s+(?:shoot|shoots|shot|fire|fires|fired|target|targets)\s+(?:at\s+)?(?:the\s+)?(.+)$/i,
    build: (m) => ({
      intent: "shoot",
      attacker: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
      target: target(m[2] ?? "", sideFromPhrase(m[2] ?? "")),
    }),
  },
  {
    re: /^(.+?)\s+(?:fight|fights|fought|attack|attacks|attacked|melee|charge into)\s+(?:the\s+)?(.+)$/i,
    build: (m) => ({
      intent: "fight",
      attacker: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
      target: target(m[2] ?? "", sideFromPhrase(m[2] ?? "")),
    }),
  },
  {
    re: /^(.+?)\s+(?:charge|charges|charged)\s+(?:the\s+)?(.+)$/i,
    build: (m) => ({
      intent: "charge",
      attacker: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
      target: target(m[2] ?? "", sideFromPhrase(m[2] ?? "")),
    }),
  },

  // --- dice reporting ---
  {
    // "I got 10 hits" / "10 hits" / "7 wounds" / "4 failed saves"
    re: new RegExp(
      `^(?:i\\s+(?:got|rolled|made|scored)\\s+)?${NUM}\\s+(?:(failed|unsaved|successful|passed)\\s+)?(hits?|wounds?|saves?|sixes)\\b`,
      "i",
    ),
    build: (m) => {
      const n = parseNumber(m[1]);
      if (n === null) return null;
      const noun = (m[3] ?? "").toLowerCase();
      const kind = noun.startsWith("hit")
        ? "hit"
        : noun.startsWith("wound")
          ? "wound"
          : noun.startsWith("save")
            ? "save"
            : "other";
      return { intent: "report_roll", kind, successes: n };
    },
  },

  // --- phase / turn ---
  {
    re: /^(?:go to |move to |switch to |start )?(?:the )?(command|movement|shooting|charge|fight|end)\s*phase$/i,
    build: (m) => ({
      intent: "change_phase",
      phase: (m[1] ?? "").toLowerCase() as
        | "command" | "movement" | "shooting" | "charge" | "fight" | "end",
    }),
  },
  {
    re: /^(?:next phase|advance phase|move on|continue)$/i,
    build: () => ({ intent: "change_phase", next: true }),
  },
  {
    re: /^(?:end (?:my )?turn|pass turn|next turn|end of turn)$/i,
    build: () => ({ intent: "end_turn" }),
  },

  // --- resources ---
  {
    re: new RegExp(`^(?:i\\s+)?(?:gain|gained|get|got|add)\\s+${NUM}\\s*(?:cp|command points?)`, "i"),
    build: (m) => {
      const n = parseNumber(m[1]);
      return n === null ? null : { intent: "change_cp", delta: n };
    },
  },
  {
    re: new RegExp(`^(?:i\\s+)?(?:spend|spent|use[d]?|lose|lost)\\s+${NUM}\\s*(?:cp|command points?)`, "i"),
    build: (m) => {
      const n = parseNumber(m[1]);
      return n === null ? null : { intent: "change_cp", delta: -n };
    },
  },
  {
    re: new RegExp(`^(?:i\\s+)?(?:score[d]?|gain(?:ed)?|get|got)\\s+${NUM}\\s*(?:vp|victory points?|points?)`, "i"),
    build: (m) => {
      const n = parseNumber(m[1]);
      return n === null ? null : { intent: "change_vp", delta: n };
    },
  },

  // --- objectives ---
  {
    re: /^(?:i\s+)?(?:claim|claimed|take|took|hold|holding|control)\s+(?:the\s+)?(.+?)\s*objective$/i,
    build: (m) => ({ intent: "claim_objective", objective: (m[1] ?? "").trim() }),
  },

  // --- stratagems ---
  {
    re: /^(?:i\s+)?(?:use|used|play|played|activate)\s+(?:the\s+)?(.+?)(?:\s+stratagem)?$/i,
    build: (m) => {
      const name = (m[1] ?? "").trim();
      // Only claim this when the word "stratagem" was actually present;
      // otherwise "use the Rhino" would be misread.
      if (!/stratagem/i.test(m[0] ?? "")) return null;
      return { intent: "use_stratagem", name };
    },
  },

  // --- battle shock ---
  {
    re: /^(.+?)\s+(?:is|are|got|gets|becomes?)\s+battle[- ]?shocked$/i,
    build: (m) => ({
      intent: "battle_shock",
      target: target(m[1] ?? "", sideFromPhrase(m[1] ?? "")),
      shocked: true,
    }),
  },
];

/** Questions go to Oracle, never to state. Detected before action rules run. */
const QUESTION_RE =
  /^(?:can|could|does|do|is|are|what|which|when|where|how|why|who|should|would|will|explain|tell me|remind me|show me|look ?up)\b|\?\s*$/i;

const HISTORY_RE =
  /\b(?:what happened|last game|previous (?:game|battle)|our last|history|record)\b/i;

export interface RuleMatch {
  intent: Intent;
  confidence: number;
}

export function ruleInterpret(input: string): RuleMatch | null {
  const text = input.trim();
  if (!text) return null;

  // Undo is checked first: "undo that" reads as a command, not a question.
  const undo = RULES[0];
  if (undo) {
    const m = text.match(undo.re);
    if (m) {
      const intent = undo.build(m);
      if (intent) return { intent, confidence: 0.99 };
    }
  }

  if (QUESTION_RE.test(text) && !HISTORY_RE.test(text)) {
    return {
      intent: { intent: "ask_rules", question: text },
      confidence: 0.7,
    };
  }

  for (const rule of RULES.slice(1)) {
    const m = text.match(rule.re);
    if (!m) continue;
    const intent = rule.build(m);
    if (intent) return { intent, confidence: 0.9 };
  }

  return null;
}
