/**
 * HTTP surface over the core services.
 *
 * Hand-rolled rather than pulled from a framework: the whole API is ~20 routes
 * on localhost, and keeping the dependency list short matters more here than
 * routing sugar. Everything is JSON in, JSON out.
 */

import { randomUUID } from "node:crypto";
import {
  answerQuestion,
  buildChronicleEntry,
  importArmyFromText,
  describeEvent,
  type Edition,
} from "@wh/core";
import type { AppContext } from "./context.js";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (
  req: Req,
  ctx: AppContext,
) => Promise<unknown> | unknown;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function body<T>(req: Req): T {
  if (req.body === null || typeof req.body !== "object") {
    throw new HttpError(400, "Expected a JSON object body");
  }
  return req.body as T;
}

function need(value: string | undefined | null, what: string): string {
  if (!value) throw new HttpError(400, `Missing ${what}`);
  return value;
}

/** Routes are matched as `METHOD /literal/:param` patterns. */
export const routes: { method: string; pattern: string; handler: Handler }[] = [
  // -- status ---------------------------------------------------------------
  {
    method: "GET",
    pattern: "/api/status",
    handler: async (_req, ctx) => ctx.status(),
  },
  {
    method: "POST",
    pattern: "/api/status/refresh",
    handler: async (_req, ctx) => ctx.refresh(),
  },

  // -- oracle passthrough ---------------------------------------------------
  {
    method: "POST",
    pattern: "/api/oracle/unit",
    handler: async (req, ctx) => {
      const b = body<{ name: string; faction?: string; edition?: Edition }>(req);
      const r = await ctx.oracle.getUnit(need(b.name, "name"), {
        faction: b.faction,
        edition: b.edition,
      });
      if (!r) throw new HttpError(404, `No datasheet found for "${b.name}"`);
      return r;
    },
  },
  {
    method: "POST",
    pattern: "/api/oracle/search",
    handler: async (req, ctx) => {
      const b = body<{ query: string; faction?: string; edition?: Edition }>(req);
      return ctx.oracle.searchUnits(need(b.query, "query"), {
        faction: b.faction,
        edition: b.edition,
      });
    },
  },
  {
    method: "POST",
    pattern: "/api/oracle/ask",
    handler: async (req, ctx) => {
      const b = body<{ question: string; edition?: Edition; battleId?: string }>(req);
      const state = b.battleId ? ctx.battles.getState(b.battleId) : undefined;
      return answerQuestion(
        ctx.oracle,
        { intent: "ask_rules", question: need(b.question, "question") },
        {
          edition: b.edition ?? state?.edition ?? ctx.config.edition,
          state: state ?? undefined,
          llm: ctx.llm,
        },
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/oracle/tool",
    handler: async (req, ctx) => {
      const b = body<{ tool: string; args?: Record<string, unknown> }>(req);
      const text = await ctx.oracle.rawTool(need(b.tool, "tool"), b.args ?? {});
      return { text };
    },
  },

  // -- battles --------------------------------------------------------------
  {
    method: "GET",
    pattern: "/api/battles",
    handler: (_req, ctx) => ctx.repo.listBattles(),
  },
  {
    method: "POST",
    pattern: "/api/battles",
    handler: async (req, ctx) => {
      const b = body<{
        name?: string;
        edition?: Edition;
        playerArmyId?: string;
        opponentArmyId?: string;
        startingCp?: number;
      }>(req);
      return ctx.battles.startBattle({
        name: b.name?.trim() || "New Battle",
        edition: b.edition ?? ctx.config.edition,
        playerArmyId: b.playerArmyId,
        opponentArmyId: b.opponentArmyId,
        startingCp: b.startingCp,
      });
    },
  },
  {
    method: "GET",
    pattern: "/api/battles/:id",
    handler: (req, ctx) => {
      const id = req.path.split("/")[3]!;
      const state = ctx.battles.getState(id);
      if (!state) throw new HttpError(404, "Battle not found");
      return {
        state,
        events: ctx.battles.getEvents(id),
        messages: ctx.repo.getMessages(id),
      };
    },
  },
  {
    method: "DELETE",
    pattern: "/api/battles/:id",
    handler: (req, ctx) => {
      ctx.repo.deleteBattle(req.path.split("/")[3]!);
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: "/api/battles/:id/input",
    handler: async (req, ctx) => {
      const id = req.path.split("/")[3]!;
      const b = body<{ text: string; source?: "natural_language" | "voice" }>(req);
      const result = await ctx.battles.handleInput(
        id,
        need(b.text, "text"),
        b.source ?? "natural_language",
      );
      return {
        ...result,
        // Pre-render event descriptions; the UI should not know event shapes.
        eventDescriptions: result.events.map((e) =>
          describeEvent(e, result.state ?? undefined),
        ),
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/battles/:id/undo",
    handler: async (req, ctx) => {
      const id = req.path.split("/")[3]!;
      return ctx.battles.applyIntent(
        id,
        ctx.battles.getState(id) ??
          (() => {
            throw new HttpError(404, "Battle not found");
          })(),
        { intent: "undo" },
        "undo",
        "ui",
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/battles/:id/intent",
    handler: async (req, ctx) => {
      // Direct intent injection — used by UI buttons so the phase control and
      // the chat box go through exactly the same path.
      const id = req.path.split("/")[3]!;
      const b = body<{ intent: Record<string, unknown>; label?: string }>(req);
      const state = ctx.battles.getState(id);
      if (!state) throw new HttpError(404, "Battle not found");
      return ctx.battles.applyIntent(
        id,
        state,
        b.intent as Parameters<typeof ctx.battles.applyIntent>[2],
        b.label ?? "(ui)",
        "ui",
      );
    },
  },
  {
    method: "GET",
    pattern: "/api/battles/:id/events",
    handler: (req, ctx) => {
      const id = req.path.split("/")[3]!;
      return ctx.battles.getEvents(id, req.query.get("all") === "1");
    },
  },

  // -- armies ---------------------------------------------------------------
  {
    method: "GET",
    pattern: "/api/armies",
    handler: (_req, ctx) => ctx.repo.listArmies(),
  },
  {
    method: "POST",
    pattern: "/api/armies/import",
    handler: async (req, ctx) => {
      const b = body<{ text: string; name?: string; edition?: Edition }>(req);
      const result = await importArmyFromText(need(b.text, "text"), {
        oracle: ctx.oracle,
        edition: b.edition ?? ctx.config.edition,
        llm: ctx.llm,
        name: b.name,
      });
      ctx.repo.saveArmy(result.army);
      return result;
    },
  },
  {
    method: "DELETE",
    pattern: "/api/armies/:id",
    handler: (req, ctx) => {
      ctx.repo.deleteArmy(req.path.split("/")[3]!);
      return { ok: true };
    },
  },

  // -- collection -----------------------------------------------------------
  {
    method: "GET",
    pattern: "/api/collection",
    handler: (_req, ctx) => ctx.collection.list(),
  },
  {
    method: "POST",
    pattern: "/api/collection/input",
    handler: async (req, ctx) => {
      const b = body<{ text: string; edition?: Edition }>(req);
      return ctx.collection.handleInput(
        need(b.text, "text"),
        b.edition ?? ctx.config.edition,
      );
    },
  },
  {
    method: "DELETE",
    pattern: "/api/collection/:id",
    handler: (req, ctx) => {
      ctx.collection.delete(req.path.split("/")[3]!);
      return { ok: true };
    },
  },

  // -- chronicle ------------------------------------------------------------
  {
    method: "GET",
    pattern: "/api/chronicle",
    handler: (_req, ctx) => ctx.chronicle.list(),
  },
  {
    method: "GET",
    pattern: "/api/chronicle/:id",
    handler: (req, ctx) => {
      const entry = buildChronicleEntry(
        ctx.repo.getEvents(req.path.split("/")[3]!),
      );
      if (!entry) throw new HttpError(404, "No history for that battle");
      return entry;
    },
  },
  {
    method: "POST",
    pattern: "/api/chronicle/:id/narrate",
    handler: async (req, ctx) => {
      const entry = await ctx.chronicle.narrate(req.path.split("/")[3]!);
      if (!entry) throw new HttpError(404, "No history for that battle");
      return entry;
    },
  },

  // -- sample data ----------------------------------------------------------
  {
    method: "POST",
    pattern: "/api/seed",
    handler: async (_req, ctx) => seedSampleData(ctx),
  },
];

/** Two Oracle-resolved armies plus a battle, for a one-click demo. */
export async function seedSampleData(ctx: AppContext): Promise<{
  battleId: string;
  armies: { id: string; name: string; unresolved: string[] }[];
}> {
  const player = await importArmyFromText(
    `Death Guard Strike Force

Faction: Death Guard
Detachment: Plague Company

Mortarion
Deathshroud Terminators
Plague Marines
Rhino
`,
    { oracle: ctx.oracle, edition: ctx.config.edition, name: "Death Guard Strike Force" },
  );

  const opponent = await importArmyFromText(
    `Ultramarines Task Force

Faction: Space Marines
Detachment: Gladius Task Force

Intercessor Squad
Redemptor Dreadnought
Captain in Terminator Armour
`,
    { oracle: ctx.oracle, edition: ctx.config.edition, name: "Ultramarines Task Force" },
  );

  ctx.repo.saveArmy(player.army);
  ctx.repo.saveArmy(opponent.army);

  const battle = await ctx.battles.startBattle({
    name: `Battle ${new Date().toLocaleDateString()}`,
    edition: ctx.config.edition,
    playerArmyId: player.army.id,
    opponentArmyId: opponent.army.id,
  });

  return {
    battleId: battle.id,
    armies: [player, opponent].map((r) => ({
      id: r.army.id,
      name: r.army.name,
      unresolved: r.unresolved,
    })),
  };
}

/** Match a request path against a `:param` pattern. */
export function matchRoute(
  method: string,
  path: string,
): (typeof routes)[number] | null {
  const parts = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pat = route.pattern.split("/").filter(Boolean);
    if (pat.length !== parts.length) continue;
    const ok = pat.every(
      (seg, i) => seg.startsWith(":") || seg === parts[i],
    );
    if (ok) return route;
  }
  return null;
}

export { randomUUID };
