/**
 * "I bought another box of Deathshroud" -> a collection row.
 *
 * Same shape as the battle pipeline: interpret, resolve against Oracle, then
 * apply deterministically. Quantity maths happens here, not in the model — the
 * model's only job is deciding that "a box" meant +3 in this sentence.
 */

import { randomUUID } from "node:crypto";
import type { CollectionItem, Edition } from "../domain/types.js";
import type { WarhammerDataProvider } from "../oracle/provider.js";
import type { LLMProvider } from "../ai/provider.js";
import { extractJson } from "../ai/provider.js";
import type { Repository } from "../db/repository.js";
import { parseNumber } from "../ai/rule-interpreter.js";
import { nameVariants } from "./name-variants.js";

export interface CollectionUpdate {
  unit: string;
  quantityDelta?: number;
  quantity?: number;
  painted?: number;
  wargear?: string[];
  notes?: string;
  customName?: string;
}

const PROMPT = `Extract a Warhammer model-collection change into JSON.

{"unit":"datasheet name","quantityDelta":N?,"quantity":N?,"painted":N?,"wargear":["..."]?,"notes":"..."?}

- "quantityDelta" for adding/removing ("bought another box", "sold two").
- "quantity" only when the user states an absolute total ("I have 10 now").
- A typical box is 3 models for Terminator-sized kits, 10 for infantry, 1 for a vehicle or character.
- JSON only.`;

/** Handle the common phrasings without a model. */
export function ruleParseCollection(text: string): CollectionUpdate | null {
  const t = text.trim();

  // "I bought another box of Deathshroud" / "got 2 boxes of Plague Marines"
  const box = t.match(
    /\b(?:bought|got|picked up|added|acquired)\s+(?:(\d+|another|a|an|one|two|three)\s+)?(?:boxe?s?|kits?)\s+of\s+(.+?)[.!]?$/i,
  );
  if (box) {
    const word = (box[1] ?? "one").toLowerCase();
    const boxes = word === "another" || word === "a" || word === "an" ? 1 : (parseNumber(word) ?? 1);
    return { unit: (box[2] ?? "").trim(), quantityDelta: boxes, notes: `${boxes} box(es)` };
  }

  // "I bought 5 more Plague Marines"
  const models = t.match(
    /\b(?:bought|got|added|painted|finished)\s+(\d+|\w+)\s+(?:more\s+)?(.+?)[.!]?$/i,
  );
  if (models) {
    const n = parseNumber(models[1]);
    if (n !== null) {
      const isPaint = /\b(painted|finished)\b/i.test(t);
      return isPaint
        ? { unit: (models[2] ?? "").trim(), painted: n }
        : { unit: (models[2] ?? "").trim(), quantityDelta: n };
    }
  }

  // "I have 10 Plague Marines"
  const have = t.match(/\bi (?:have|own)\s+(\d+)\s+(.+?)[.!]?$/i);
  if (have) {
    return { unit: (have[2] ?? "").trim(), quantity: Number(have[1]) };
  }

  return null;
}

export class CollectionService {
  constructor(
    private readonly repo: Repository,
    private readonly oracle: WarhammerDataProvider,
    private readonly llm: LLMProvider | null = null,
  ) {}

  list(): CollectionItem[] {
    return this.repo.listCollection();
  }

  delete(id: string): void {
    this.repo.deleteCollectionItem(id);
  }

  /** Natural language in, updated row out. */
  async handleInput(
    text: string,
    edition: Edition,
  ): Promise<{ item: CollectionItem; reply: string; created: boolean }> {
    let update = ruleParseCollection(text);

    if (!update && this.llm) {
      try {
        const raw = await this.llm.chat(
          [
            { role: "system", content: PROMPT },
            { role: "user", content: text },
          ],
          { json: true, temperature: 0 },
        );
        const parsed = extractJson(raw) as CollectionUpdate;
        if (parsed?.unit) update = parsed;
      } catch {
        // Fall through to the error below.
      }
    }

    if (!update?.unit) {
      throw new Error(
        `I couldn't tell what model that was about. Try "I bought another box of Deathshroud Terminators".`,
      );
    }

    return this.apply(update, edition);
  }

  /**
   * Factions the user actually plays, newest first. BSData copies a datasheet
   * into every allied faction's catalogue, so "Plague Marines" exists under
   * Chaos Daemons, Chaos Knights and Death Guard alike; without a hint Oracle
   * returns whichever sorts first. What the user already owns is the best
   * available tiebreaker, and it is data we hold ourselves.
   */
  private preferredFactions(): string[] {
    const counts = new Map<string, number>();
    const bump = (f?: string): void => {
      if (!f) return;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    };
    for (const i of this.repo.listCollection()) bump(i.ref.faction);
    for (const a of this.repo.listArmies()) {
      bump(a.faction);
      for (const u of a.units) bump(u.ref.faction);
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([f]) => f);
  }

  async apply(
    update: CollectionUpdate,
    edition: Edition,
  ): Promise<{ item: CollectionItem; reply: string; created: boolean }> {
    // Resolve through Oracle so the shelf uses real datasheet names.
    let name = update.unit;
    let faction: string | undefined;
    let resolved = false;
    let boxSize = 1;

    const preferred = this.preferredFactions();

    try {
      const variants = nameVariants(update.unit);

      // Try the user's own factions first, so an ambiguous name lands on the
      // army they actually play rather than an arbitrary allied catalogue.
      let hit = null as Awaited<ReturnType<typeof this.oracle.getUnit>>;
      outer: for (const variant of variants) {
        for (const f of preferred) {
          const candidate = await this.oracle.getUnit(variant, {
            edition,
            faction: f,
          });
          if (
            candidate &&
            candidate.data.name.toLowerCase().includes(variant.toLowerCase())
          ) {
            hit = candidate;
            break outer;
          }
        }
      }

      // No faction context matched — take the first variant Oracle recognises.
      for (const variant of variants) {
        if (hit) break;
        hit = await this.oracle.getUnit(variant, { edition });
      }

      if (hit) {
        name = hit.data.name;
        faction = hit.data.faction;
        resolved = true;
        boxSize = hit.data.unitSize.min;
      } else {
        const search = await this.oracle.searchUnits(update.unit, { edition });
        const best =
          search.data.find((u) => preferred.includes(u.faction)) ??
          search.data[0];
        if (best) {
          name = best.name;
          faction = best.faction;
          resolved = true;
          boxSize = best.unitSize?.min ?? 1;
        }
      }
    } catch {
      // Unresolved is fine; the row is still recorded and flagged.
    }

    const existing = this.repo.findCollectionItemByName(name);
    const ts = new Date().toISOString();

    // "a box" means a datasheet's worth of models, which Oracle tells us.
    const delta =
      update.quantityDelta !== undefined && update.notes?.includes("box")
        ? update.quantityDelta * boxSize
        : update.quantityDelta;

    if (existing) {
      const quantity =
        update.quantity ?? Math.max(0, existing.quantity + (delta ?? 0));
      const item: CollectionItem = {
        ...existing,
        quantity,
        painted: update.painted ?? existing.painted,
        wargear: update.wargear ?? existing.wargear,
        notes: update.notes ?? existing.notes,
        customName: update.customName ?? existing.customName,
        updatedAt: ts,
      };
      this.repo.saveCollectionItem(item);
      return {
        item,
        created: false,
        reply: `${name}: ${quantity} models${
          item.painted > 0 ? ` (${item.painted} painted)` : ""
        }.`,
      };
    }

    // You cannot have painted more models than you own, so a paint-only update
    // for an unknown unit implies owning at least that many.
    const painted = update.painted ?? 0;
    const quantity = Math.max(update.quantity ?? delta ?? boxSize, painted);

    const item: CollectionItem = {
      id: randomUUID(),
      ref: {
        name,
        faction,
        edition,
        resolved,
        ...(resolved ? { resolvedAt: ts } : {}),
      },
      quantity: Math.max(0, quantity),
      wargear: update.wargear ?? [],
      painted,
      customName: update.customName,
      notes: update.notes,
      createdAt: ts,
      updatedAt: ts,
    };
    this.repo.saveCollectionItem(item);

    const action =
      painted > 0 && update.quantityDelta === undefined
        ? `Recorded ${painted} painted ${name}`
        : `Added ${name} × ${item.quantity}`;

    return {
      item,
      created: true,
      reply:
        `${action}${resolved && faction ? ` (${faction})` : ""}` +
        (resolved ? "." : " — I couldn't confirm that name against Oracle."),
    };
  }
}
