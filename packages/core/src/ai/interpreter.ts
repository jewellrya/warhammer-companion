/**
 * Natural language -> Intent.
 *
 * Order matters: deterministic rules first, model second. The model is asked
 * for a single JSON object matching the intent schema and its output is
 * validated with zod before anything downstream sees it — an intent that fails
 * validation becomes `unknown`, never a guess.
 *
 * The prompt gets the unit names currently on the table. That is what lets the
 * model say "Deathshroud Terminators" when the user said "the terminators",
 * and lets it hand back a clarification instead of picking one at random.
 */

import { z } from "zod";
import { IntentSchema, type Intent, type InterpretationResult } from "../domain/intent.js";
import { extractJson, type ChatMessage, type LLMProvider } from "./provider.js";
import { ruleInterpret } from "./rule-interpreter.js";

export interface InterpreterContext {
  /** Units on the table, so the model resolves against reality. */
  units: { name: string; side: "player" | "opponent"; alive: boolean }[];
  phase: string;
  round: number;
  activePlayer: "player" | "opponent";
  edition: string;
  /** Last few turns of conversation, for "them"/"it"/"again". */
  recent?: string[];
}

const SYSTEM_PROMPT = `You translate a Warhammer 40,000 player's speech into ONE structured intent.

Reply with a single JSON object and nothing else.

Intent shapes:
{"intent":"apply_damage","target":{"name":"..."},"amount":N,"mortal":bool?}
{"intent":"move_unit","target":{"name":"..."},"position":"..."?,"advanced":bool?,"fellBack":bool?,"distance":N?}
{"intent":"shoot","attacker":{"name":"..."},"target":{"name":"..."},"weapon":"..."?}
{"intent":"fight","attacker":{"name":"..."},"target":{"name":"..."}}
{"intent":"charge","attacker":{"name":"..."},"target":{"name":"..."}?,"rolled":N?}
{"intent":"report_roll","kind":"hit|wound|save|damage|charge|advance|other","successes":N?,"total":N?}
{"intent":"destroy_models","target":{"name":"..."},"count":N}
{"intent":"change_phase","phase":"command|movement|shooting|charge|fight|end"?,"next":bool?}
{"intent":"end_turn"}
{"intent":"change_cp","delta":N,"side":"player|opponent"?,"reason":"..."?}
{"intent":"change_vp","delta":N,"side":"player|opponent"?,"reason":"..."?}
{"intent":"claim_objective","objective":"...","side":"player|opponent"|null?}
{"intent":"use_stratagem","name":"...","side":"player|opponent"?,"target":{"name":"..."}?}
{"intent":"use_ability","name":"...","target":{"name":"..."}?}
{"intent":"battle_shock","target":{"name":"..."},"shocked":bool}
{"intent":"heal_unit","target":{"name":"..."},"wounds":N?,"modelsReturned":N?}
{"intent":"undo","count":N?}
{"intent":"ask_rules","question":"...","subject":"..."?,"kind":"unit|stratagem|keyword|phase|detachment|enhancement|general"?}
{"intent":"update_collection","unit":"...","quantityDelta":N?,"quantity":N?,"painted":N?}
{"intent":"record_note","text":"..."}
{"intent":"unknown","reason":"..."}

Rules:
- Any question about how rules work is "ask_rules". Never change state to answer a question.
- Use the exact unit name from the battle roster when the user's phrasing clearly points to one of them.
- If the phrasing matches TWO OR MORE roster units equally well, do NOT pick one. Reply:
  {"intent":"unknown","reason":"ambiguous: <Unit A> or <Unit B>?"}
- "my"/"our" means side "player". "their"/"enemy"/"opponent's" means side "opponent".
- Numbers spelled as words become digits.
- Output JSON only. No commentary, no markdown fences.`;

function buildContextMessage(ctx: InterpreterContext): string {
  const alive = ctx.units.filter((u) => u.alive);
  const roster =
    alive.length === 0
      ? "(no units deployed)"
      : alive
          .map((u) => `- ${u.name} [${u.side === "player" ? "yours" : "enemy"}]`)
          .join("\n");

  const recent =
    ctx.recent && ctx.recent.length > 0
      ? `\n\nRecent conversation:\n${ctx.recent.slice(-4).join("\n")}`
      : "";

  return `Battle state — round ${ctx.round}, ${ctx.phase} phase, ${
    ctx.activePlayer === "player" ? "your" : "opponent's"
  } turn, edition ${ctx.edition}.

Units on the table:
${roster}${recent}`;
}

export interface Interpreter {
  readonly name: string;
  interpret(
    input: string,
    ctx: InterpreterContext,
  ): Promise<InterpretationResult>;
}

/** Rules only. Used when no model is installed. */
export class MockInterpreter implements Interpreter {
  readonly name = "mock";

  async interpret(
    input: string,
    _ctx: InterpreterContext,
  ): Promise<InterpretationResult> {
    const hit = ruleInterpret(input);
    if (hit) {
      return { status: "ok", intent: hit.intent, confidence: hit.confidence };
    }
    return {
      status: "ok",
      intent: {
        intent: "unknown",
        reason: "No pattern matched and no language model is configured.",
      },
      confidence: 0.2,
    };
  }
}

/** Rules first, then the model. */
export class LLMInterpreter implements Interpreter {
  readonly name: string;

  constructor(
    private readonly llm: LLMProvider,
    /** Skip the fast path; useful for testing the model in isolation. */
    private readonly rulesFirst = true,
  ) {
    this.name = `${llm.name}:${llm.model}`;
  }

  async interpret(
    input: string,
    ctx: InterpreterContext,
  ): Promise<InterpretationResult> {
    if (this.rulesFirst) {
      const hit = ruleInterpret(input);
      // Questions are handed to the model, which is better at pulling out the
      // subject; everything else the rules matched is already trustworthy.
      if (hit && hit.intent.intent !== "ask_rules") {
        return { status: "ok", intent: hit.intent, confidence: hit.confidence };
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildContextMessage(ctx) },
      { role: "user", content: `Player said: "${input}"` },
    ];

    let raw: string;
    try {
      raw = await this.llm.chat(messages, { json: true, temperature: 0 });
    } catch (err) {
      // Model unreachable mid-game: fall back rather than losing the input.
      const hit = ruleInterpret(input);
      if (hit) return { status: "ok", intent: hit.intent, confidence: hit.confidence };
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      return {
        status: "error",
        message: "Model did not return usable JSON.",
        raw,
      };
    }

    const result = IntentSchema.safeParse(parsed);
    if (!result.success) {
      return {
        status: "error",
        message: `Model produced an intent that failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        raw,
      };
    }

    const intent: Intent = result.data;

    // The prompt encodes ambiguity as unknown+"ambiguous:"; promote it to a
    // real clarification request so the UI can ask the question.
    if (intent.intent === "unknown" && intent.reason?.startsWith("ambiguous:")) {
      const question = intent.reason.replace(/^ambiguous:\s*/, "");
      return {
        status: "needs_clarification",
        question: question.endsWith("?") ? question : `${question}?`,
        raw,
      };
    }

    return { status: "ok", intent, confidence: 0.85, raw };
  }
}

/** Pick the best interpreter available right now. */
export async function createInterpreter(
  llm: LLMProvider | null,
): Promise<Interpreter> {
  if (llm && (await llm.isAvailable())) return new LLMInterpreter(llm);
  return new MockInterpreter();
}
