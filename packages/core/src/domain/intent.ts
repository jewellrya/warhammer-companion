/**
 * Intents are the narrow contract between the language model and the rest of
 * the app. The model's entire job is to turn an utterance into one of these.
 *
 * Deliberately loose about *entities*: an intent names a target as the user
 * said it ("the Rhino", "my terminators"). Turning that string into a unit id
 * is resolution's job (`resolve.ts`), which uses live battle state — something
 * the model should not be trusted to hold. If resolution is ambiguous we ask,
 * we never guess.
 */

import { z } from "zod";
import type { Phase, PlayerSide } from "./types.js";

/** How the user referred to something, before it means anything. */
export const TargetRefSchema = z.object({
  name: z.string().describe("The unit as the user named it"),
  side: z.enum(["player", "opponent"]).optional(),
});
export type TargetRef = z.infer<typeof TargetRefSchema>;

export const IntentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("apply_damage"),
    target: TargetRefSchema,
    amount: z.number(),
    source: TargetRefSchema.optional(),
    mortal: z.boolean().optional(),
  }),
  z.object({
    intent: z.literal("move_unit"),
    target: TargetRefSchema,
    position: z.string().optional(),
    advanced: z.boolean().optional(),
    fellBack: z.boolean().optional(),
    distance: z.number().optional(),
  }),
  z.object({
    intent: z.literal("shoot"),
    attacker: TargetRefSchema,
    target: TargetRefSchema,
    weapon: z.string().optional(),
  }),
  z.object({
    intent: z.literal("fight"),
    attacker: TargetRefSchema,
    target: TargetRefSchema,
    weapon: z.string().optional(),
  }),
  z.object({
    intent: z.literal("charge"),
    attacker: TargetRefSchema,
    target: TargetRefSchema.optional(),
    rolled: z.number().optional(),
  }),
  z.object({
    intent: z.literal("report_roll"),
    kind: z.enum(["hit", "wound", "save", "damage", "charge", "advance", "other"]),
    successes: z.number().optional(),
    total: z.number().optional(),
    values: z.array(z.number()).optional(),
  }),
  z.object({
    intent: z.literal("destroy_models"),
    target: TargetRefSchema,
    count: z.number(),
  }),
  z.object({
    intent: z.literal("change_phase"),
    phase: z
      .enum(["command", "movement", "shooting", "charge", "fight", "end"])
      .optional(),
    next: z.boolean().optional(),
  }),
  z.object({
    intent: z.literal("end_turn"),
  }),
  z.object({
    intent: z.literal("change_cp"),
    side: z.enum(["player", "opponent"]).optional(),
    delta: z.number(),
    reason: z.string().optional(),
  }),
  z.object({
    intent: z.literal("change_vp"),
    side: z.enum(["player", "opponent"]).optional(),
    delta: z.number(),
    reason: z.string().optional(),
  }),
  z.object({
    intent: z.literal("claim_objective"),
    objective: z.string(),
    side: z.enum(["player", "opponent"]).nullable().optional(),
  }),
  z.object({
    intent: z.literal("use_stratagem"),
    name: z.string(),
    side: z.enum(["player", "opponent"]).optional(),
    target: TargetRefSchema.optional(),
  }),
  z.object({
    intent: z.literal("use_ability"),
    name: z.string(),
    target: TargetRefSchema.optional(),
  }),
  z.object({
    intent: z.literal("battle_shock"),
    target: TargetRefSchema,
    shocked: z.boolean().default(true),
    rolled: z.number().optional(),
  }),
  z.object({
    intent: z.literal("heal_unit"),
    target: TargetRefSchema,
    wounds: z.number().optional(),
    modelsReturned: z.number().optional(),
  }),
  z.object({
    intent: z.literal("undo"),
    count: z.number().optional(),
  }),
  /** A rules or unit question — routed to Oracle, never to state. */
  z.object({
    intent: z.literal("ask_rules"),
    question: z.string(),
    subject: z.string().optional().describe("Unit/stratagem/keyword in question"),
    kind: z
      .enum(["unit", "stratagem", "keyword", "phase", "detachment", "enhancement", "general"])
      .optional(),
  }),
  /** Update the collection ("I bought another box of Deathshroud"). */
  z.object({
    intent: z.literal("update_collection"),
    unit: z.string(),
    quantityDelta: z.number().optional(),
    quantity: z.number().optional(),
    painted: z.number().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    intent: z.literal("record_note"),
    text: z.string(),
    target: TargetRefSchema.optional(),
  }),
  /** The model could not classify. We surface this rather than inventing one. */
  z.object({
    intent: z.literal("unknown"),
    reason: z.string().optional(),
  }),
]);

export type Intent = z.infer<typeof IntentSchema>;
export type IntentName = Intent["intent"];

/**
 * What an interpreter returns. Either a confident intent, or an explicit
 * request for clarification — the spec's "do not guess" rule made structural,
 * so ambiguity cannot silently become a wrong state change.
 */
export type InterpretationResult =
  | { status: "ok"; intent: Intent; confidence: number; raw?: string }
  | {
      status: "needs_clarification";
      question: string;
      options?: string[];
      /** Kept so answering the question can complete the original action. */
      pendingIntent?: Intent;
      raw?: string;
    }
  | { status: "error"; message: string; raw?: string };

export type ResolvedSide = PlayerSide;
export type ResolvedPhase = Phase;

/** Intents that only read — they never produce state-changing events. */
const READ_ONLY: ReadonlySet<IntentName> = new Set<IntentName>([
  "ask_rules",
  "unknown",
]);

export function isReadOnlyIntent(i: Intent): boolean {
  return READ_ONLY.has(i.intent);
}
