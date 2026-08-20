/**
 * Question -> Oracle -> answer, with the source attached.
 *
 * The model plans retrieval; the app executes it. Given a question it returns a
 * short list of Oracle lookups ("keyword: Deep Strike", "phase: Charge"), which
 * is a tool-selection problem language models are good at, and it generalises
 * to rules nobody wrote a rule for.
 *
 * Two things keep that honest. Oracle answers "not found" cheaply, so a wrong
 * plan is detected rather than believed — if every planned lookup misses, a
 * generic cascade tries the other tools before giving up. And the model only
 * ever chooses *where to look*: the answer is written strictly from what Oracle
 * returned, so a bad plan yields "I couldn't find that", never a guess.
 *
 * With no model available the cascade runs on its own over terms lifted from
 * the question. Less precise, still grounded.
 */

import type { Intent } from "../domain/intent.js";
import type { BattleState, Edition } from "../domain/types.js";
import type { SourceCitation, WarhammerDataProvider } from "../oracle/provider.js";
import type { LLMProvider } from "../ai/provider.js";
import { extractJson } from "../ai/provider.js";

export interface RulesAnswer {
  text: string;
  citations: SourceCitation[];
  /** Raw Oracle documents behind the answer, for the "show source" panel. */
  sources: { title: string; body: string }[];
}

export interface AnswerContext {
  edition: Edition;
  state?: BattleState;
  llm?: LLMProvider | null;
}

type AskRules = Extract<Intent, { intent: "ask_rules" }>;

/** The Oracle tools the planner is allowed to choose from. */
const TOOLS = [
  "keyword",
  "stratagem",
  "unit",
  "phase",
  "detachment",
  "enhancement",
] as const;
type LookupTool = (typeof TOOLS)[number];

interface Lookup {
  tool: LookupTool;
  name: string;
}

const PLAN_PROMPT = `You choose which Warhammer 40,000 reference entries to open
to answer a player's question. You do not answer the question.

Reply with JSON only:
{"lookups":[{"tool":"keyword|stratagem|unit|phase|detachment|enhancement","name":"..."}]}

- 1 to 3 lookups, most likely first.
- "name" must be the entry's proper name, not the player's phrasing:
  "advancing" -> the "Movement" phase, "battle-shocked" -> the "Command" phase.
- "keyword" covers weapon and unit abilities (Deep Strike, Devastating Wounds,
  Feel No Pain, Invulnerable Save, Lethal Hits).
- Core turn rules — Advance, Charge, Fall Back, Battle-shock, Overwatch,
  objectives, cover — are described in the "phase" that governs them.
- A question about a specific model's stats is a "unit" lookup.
- If the question is about two things (a model AND a rule), list both.
- JSON only. No commentary.`;

async function planLookups(
  question: string,
  ctx: AnswerContext,
  phases: string[],
): Promise<Lookup[]> {
  if (!ctx.llm) return [];

  const roster = ctx.state?.units
    .filter((u) => !u.destroyed)
    .map((u) => u.ref.name)
    .join(", ");

  // Naming the real phases turns "which phase covers this?" from recall into
  // a choice from a menu, which a small model is far more reliable at.
  const menu =
    phases.length > 0 ? `Phases available: ${phases.join(", ")}.` : "";

  const messages = [
    { role: "system" as const, content: PLAN_PROMPT },
    { role: "user" as const, content: menu },
    ...(roster
      ? [{ role: "user" as const, content: `Units on the table: ${roster}` }]
      : []),
    { role: "user" as const, content: `Question: ${question}` },
  ];

  try {
    // A plan is a handful of short strings; capping it stops a small model
    // from running away and blocking the answer behind a timeout.
    const raw = await ctx.llm.chat(messages, {
      json: true,
      temperature: 0,
      maxTokens: 250,
    });
    const parsed = extractJson(raw) as { lookups?: unknown };
    if (!Array.isArray(parsed.lookups)) return [];

    return parsed.lookups
      .filter(
        (l): l is Lookup =>
          typeof l === "object" &&
          l !== null &&
          TOOLS.includes((l as Lookup).tool) &&
          typeof (l as Lookup).name === "string" &&
          (l as Lookup).name.trim().length > 1,
      )
      .slice(0, 3)
      .map((l) => ({ tool: l.tool, name: l.name.trim() }));
  } catch {
    // A failed plan is not fatal; the cascade below still runs.
    return [];
  }
}

/**
 * Candidate names to try when there is no plan, or the plan found nothing.
 * Proper-noun runs first ("Fire Overwatch", "Deep Strike"), then any unit
 * currently on the table, then the question's longest remaining words.
 */
function fallbackTerms(question: string, state?: BattleState): string[] {
  const terms: string[] = [];

  for (const u of state?.units ?? []) {
    if (question.toLowerCase().includes(u.ref.name.toLowerCase())) {
      terms.push(u.ref.name);
    }
  }

  // Runs of capitalised words, ignoring one at the start of the sentence.
  const proper = question.match(/\b[A-Z][a-z0-9'-]+(?:\s+(?:of|the|a)?\s*[A-Z][a-z0-9'-]+)*/g);
  for (const p of proper ?? []) {
    if (question.trim().startsWith(p) && p.split(/\s+/).length === 1) continue;
    terms.push(p);
  }

  const stop = new Set([
    "what", "does", "how", "can", "the", "and", "for", "with", "this", "that",
    "when", "work", "works", "mean", "means", "happen", "happens", "about",
    "rule", "rules", "unit", "model", "models", "after", "before", "from",
  ]);
  const words = question
    .replace(/[^a-zA-Z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  terms.push(...words);

  return [...new Set(terms)].slice(0, 6);
}

const ANSWER_PROMPT = `You are a Warhammer 40,000 rules assistant.

Answer the player's question using ONLY the reference material provided. It is
authoritative; your own recollection is not.

Reply with JSON only:
{"sufficient": true|false, "answer": "..."}

- "sufficient" is false when the reference does not actually contain the rule
  being asked about. Be strict: if you are filling a gap from memory, it is false.
- "answer" is direct and short — two or three sentences unless the rule genuinely
  needs more. When "sufficient" is false, say what the reference does cover.
- Never invent rules, points values, or statlines.
- No preamble, no markdown headings, no commentary outside the JSON.`;

interface DraftedAnswer {
  sufficient: boolean;
  answer: string;
}

/** Ask the model to answer, and to say whether the material was enough. */
async function draftAnswer(
  llm: LLMProvider,
  question: string,
  reference: string,
): Promise<DraftedAnswer | null> {
  try {
    const raw = await llm.chat(
      [
        { role: "system", content: ANSWER_PROMPT },
        { role: "user", content: `Reference material:\n\n${reference}` },
        { role: "user", content: `Question: ${question}` },
      ],
      { json: true, temperature: 0.1, maxTokens: 500 },
    );

    const parsed = extractJson(raw) as Partial<DraftedAnswer>;
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) return null;
    return {
      sufficient: parsed.sufficient !== false,
      answer: parsed.answer.trim(),
    };
  } catch {
    return null;
  }
}

export async function answerQuestion(
  oracle: WarhammerDataProvider,
  intent: AskRules,
  ctx: AnswerContext,
): Promise<RulesAnswer> {
  const question = intent.question;
  const citations: SourceCitation[] = [];
  const sources: { title: string; body: string }[] = [];
  const tried = new Set<string>();

  const add = (title: string, body: string, c: SourceCitation): void => {
    sources.push({ title, body });
    citations.push(c);
  };

  const faction = ctx.state?.armies[ctx.state.activePlayer]?.faction;

  /** Run one lookup. Returns whether it found anything. */
  async function run(tool: LookupTool, name: string): Promise<boolean> {
    const key = `${tool}:${name.toLowerCase()}`;
    if (tried.has(key)) return false;
    tried.add(key);

    const opts = { edition: ctx.edition, faction };
    const hit = await (tool === "keyword"
      ? oracle.getKeyword(name, { edition: ctx.edition })
      : tool === "stratagem"
        ? oracle.getStratagem(name, opts)
        : tool === "unit"
          ? oracle.getUnit(name, opts)
          : tool === "phase"
            ? oracle.getPhase(name, { edition: ctx.edition })
            : tool === "detachment"
              ? oracle.getDetachment(name, opts)
              : oracle.getEnhancement(name, opts));

    if (!hit) return false;
    add(hit.data.name, hit.data.raw, hit.source);
    return true;
  }

  // The turn sequence is the authoritative list of phases, and it is cached
  // after the first call, so this costs nothing per question.
  const flow = await oracle
    .getGameFlow({ edition: ctx.edition })
    .catch(() => null);
  const phases =
    flow?.data.phases
      .map((p) => p.replace(/\s*phase\b.*$/i, "").trim())
      .filter((p) => p.length > 2 && p.length < 20) ?? [];

  /**
   * Read every phase description. A conceptual question ("what happens if a
   * unit is battle-shocked") names no entry at all — the rule lives inside
   * whichever phase governs it. There are only a handful and they are cached,
   * so reading them all is cheaper than maintaining a concept-to-phase table.
   */
  let sweptPhases = false;
  async function sweepPhases(): Promise<void> {
    sweptPhases = true;
    for (const phase of phases) {
      await run("phase", phase);
    }
  }

  try {
    // 1. Let the model say where to look.
    for (const lookup of await planLookups(question, ctx, phases)) {
      await run(lookup.tool, lookup.name);
      if (sources.length >= 3) break;
    }

    // 2. Nothing landed — the plan was wrong, or there was no model. Try each
    //    candidate term against every tool until something answers.
    if (sources.length === 0) {
      const order: LookupTool[] = [
        "keyword",
        "stratagem",
        "unit",
        "phase",
        "detachment",
        "enhancement",
      ];
      outer: for (const term of fallbackTerms(question, ctx.state)) {
        for (const tool of order) {
          if (await run(tool, term)) break outer;
        }
      }
    }

    // 3. Nothing named in the question exists as an entry — read the phases.
    if (sources.length === 0 && phases.length > 0) await sweepPhases();

    // 4. Still nothing. A free-text search is the widest net Oracle offers.
    if (sources.length === 0) {
      for (const term of fallbackTerms(question, ctx.state).slice(0, 2)) {
        const [units, strats] = await Promise.all([
          oracle.searchUnits(term, { edition: ctx.edition, faction }),
          oracle.searchStratagems(term, { edition: ctx.edition, faction }),
        ]);
        if (strats.data.length > 0) {
          add(
            `Stratagems matching "${term}"`,
            strats.data.map((s) => `${s.name}: ${s.effect ?? ""}`).join("\n"),
            strats.source,
          );
        }
        if (units.data.length > 0) {
          add(
            `Units matching "${term}"`,
            units.data
              .map(
                (u) =>
                  `${u.name} (${u.faction})${u.points ? ` — ${u.points}pts` : ""} — ${u.keywords.join(", ")}`,
              )
              .join("\n"),
            units.source,
          );
        }
        if (sources.length > 0) break;
      }
    }
  } catch (err) {
    return {
      text: `I couldn't reach the rules database: ${
        err instanceof Error ? err.message : String(err)
      }`,
      citations: [],
      sources: [],
    };
  }

  if (sources.length === 0) {
    return {
      text:
        "I couldn't find anything on that in Warhammer Oracle. " +
        "Try naming the exact unit, stratagem, or keyword.",
      citations: [],
      sources: [],
    };
  }

  const reference = (): string =>
    sources
      .map((s) => `--- ${s.title} ---\n${s.body}`)
      .join("\n\n")
      .slice(0, 12_000);

  if (!ctx.llm) return { text: reference(), citations, sources };

  let draft = await draftAnswer(ctx.llm, question, reference());

  // The model just told us the material did not contain the rule. Rather than
  // guessing in advance which questions need broader context — a table that
  // would need a new entry for every rule — widen once on its own signal and
  // let it try again.
  if (draft && !draft.sufficient && !sweptPhases) {
    try {
      await sweepPhases();
      if (sources.length > 0) {
        const second = await draftAnswer(ctx.llm, question, reference());
        // Keep the retry only if it actually did better.
        if (second && (second.sufficient || !draft)) draft = second;
      }
    } catch {
      // Widening is best-effort; the first draft still stands.
    }
  }

  return { text: draft?.answer ?? reference(), citations, sources };
}
