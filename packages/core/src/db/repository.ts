/**
 * All SQL lives here. Everything above works with domain objects.
 *
 * The event store is append-only. Undo marks `undone = 1` rather than deleting,
 * so the log stays a faithful record of what the player actually did — which is
 * what makes AI debugging and Chronicle honest.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "./schema.js";
import type { GameEvent, NewGameEvent } from "../domain/events.js";
import { replay } from "../domain/reducer.js";
import type {
  Army,
  ArmyUnitEntry,
  BattleState,
  CollectionItem,
  Edition,
} from "../domain/types.js";

export interface ChatMessageRow {
  id: string;
  gameId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface BattleSummary {
  id: string;
  name: string;
  edition: Edition;
  status: "active" | "complete";
  createdAt: string;
  updatedAt: string;
  snapshot?: BattleState;
}

const now = (): string => new Date().toISOString();

export class Repository {
  constructor(private readonly db: Db) {}

  // -- Battles --------------------------------------------------------------

  createBattle(input: {
    id?: string;
    name: string;
    edition: Edition;
  }): { id: string; createdAt: string } {
    const id = input.id ?? randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO battles (id, name, edition, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.name, input.edition, ts, ts);
    return { id, createdAt: ts };
  }

  listBattles(limit = 50): BattleSummary[] {
    const rows = this.db
      .prepare<
        [number],
        {
          id: string;
          name: string;
          edition: string;
          status: string;
          snapshot: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, name, edition, status, snapshot, created_at, updated_at
         FROM battles ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit);

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      edition: r.edition as Edition,
      status: r.status as "active" | "complete",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      snapshot: r.snapshot ? (JSON.parse(r.snapshot) as BattleState) : undefined,
    }));
  }

  getBattleRow(id: string): BattleSummary | null {
    const r = this.db
      .prepare<
        [string],
        {
          id: string;
          name: string;
          edition: string;
          status: string;
          snapshot: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, name, edition, status, snapshot, created_at, updated_at
         FROM battles WHERE id = ?`,
      )
      .get(id);
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      edition: r.edition as Edition,
      status: r.status as "active" | "complete",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      snapshot: r.snapshot ? (JSON.parse(r.snapshot) as BattleState) : undefined,
    };
  }

  deleteBattle(id: string): void {
    this.db.prepare("DELETE FROM battles WHERE id = ?").run(id);
  }

  /** Cache the folded state so listing battles does not replay every log. */
  saveSnapshot(state: BattleState): void {
    this.db
      .prepare(
        `UPDATE battles SET snapshot = ?, status = ?, name = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(state),
        state.status,
        state.name,
        state.updatedAt,
        state.id,
      );
  }

  // -- Events ---------------------------------------------------------------

  private nextSeq(gameId: string): number {
    const row = this.db
      .prepare<[string], { max: number | null }>(
        "SELECT MAX(seq) AS max FROM events WHERE game_id = ?",
      )
      .get(gameId);
    return (row?.max ?? 0) + 1;
  }

  /** Append events atomically; they share a batchId so undo peels the whole action. */
  appendEvents(gameId: string, events: NewGameEvent[]): GameEvent[] {
    if (events.length === 0) return [];

    const insert = this.db.prepare(
      `INSERT INTO events
         (id, game_id, seq, type, payload, source, raw_input, batch_id, undone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );

    const written: GameEvent[] = [];

    this.db.transaction(() => {
      let seq = this.nextSeq(gameId);
      for (const e of events) {
        const full = {
          ...e,
          id: randomUUID(),
          gameId,
          seq,
          createdAt: now(),
        } as GameEvent;

        insert.run(
          full.id,
          gameId,
          seq,
          full.type,
          JSON.stringify(full),
          full.source,
          full.rawInput ?? null,
          full.batchId ?? null,
          full.createdAt,
        );

        written.push(full);
        seq += 1;
      }
    })();

    return written;
  }

  getEvents(gameId: string, opts: { includeUndone?: boolean } = {}): GameEvent[] {
    const sql = opts.includeUndone
      ? "SELECT payload, undone FROM events WHERE game_id = ? ORDER BY seq ASC"
      : "SELECT payload, undone FROM events WHERE game_id = ? AND undone = 0 ORDER BY seq ASC";

    return this.db
      .prepare<[string], { payload: string; undone: number }>(sql)
      .all(gameId)
      .map((r) => {
        const e = JSON.parse(r.payload) as GameEvent;
        e.undone = r.undone === 1;
        return e;
      });
  }

  /** Fold the log. The only way a BattleState is produced. */
  getBattleState(gameId: string): BattleState | null {
    const row = this.getBattleRow(gameId);
    if (!row) return null;
    const events = this.getEvents(gameId);
    if (events.length === 0) return null;
    return replay(events);
  }

  /**
   * Mark the most recent live batch undone. Returns what was reversed so the
   * UI can say what it just took back.
   */
  undoLastBatch(gameId: string): GameEvent[] {
    const last = this.db
      .prepare<[string], { batch_id: string | null; seq: number }>(
        `SELECT batch_id, seq FROM events
         WHERE game_id = ? AND undone = 0 AND type != 'battle_started'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(gameId);

    if (!last) return [];

    const undone: GameEvent[] = [];

    this.db.transaction(() => {
      const rows = last.batch_id
        ? this.db
            .prepare<[string, string], { id: string; payload: string }>(
              `SELECT id, payload FROM events
               WHERE game_id = ? AND batch_id = ? AND undone = 0`,
            )
            .all(gameId, last.batch_id)
        : this.db
            .prepare<[string, number], { id: string; payload: string }>(
              `SELECT id, payload FROM events
               WHERE game_id = ? AND seq = ? AND undone = 0`,
            )
            .all(gameId, last.seq);

      const mark = this.db.prepare("UPDATE events SET undone = 1 WHERE id = ?");
      for (const r of rows) {
        mark.run(r.id);
        undone.push(JSON.parse(r.payload) as GameEvent);
      }
    })();

    return undone;
  }

  // -- Chat -----------------------------------------------------------------

  appendMessage(
    gameId: string,
    role: ChatMessageRow["role"],
    content: string,
    meta?: Record<string, unknown>,
  ): ChatMessageRow {
    const row = this.db
      .prepare<[string], { max: number | null }>(
        "SELECT MAX(seq) AS max FROM messages WHERE game_id = ?",
      )
      .get(gameId);
    const seq = (row?.max ?? 0) + 1;
    const msg: ChatMessageRow = {
      id: randomUUID(),
      gameId,
      seq,
      role,
      content,
      meta,
      createdAt: now(),
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, game_id, seq, role, content, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        gameId,
        seq,
        role,
        content,
        meta ? JSON.stringify(meta) : null,
        msg.createdAt,
      );

    return msg;
  }

  getMessages(gameId: string, limit = 200): ChatMessageRow[] {
    return this.db
      .prepare<
        [string, number],
        {
          id: string;
          game_id: string;
          seq: number;
          role: string;
          content: string;
          meta: string | null;
          created_at: string;
        }
      >(
        `SELECT * FROM messages WHERE game_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(gameId, limit)
      .map((r) => ({
        id: r.id,
        gameId: r.game_id,
        seq: r.seq,
        role: r.role as ChatMessageRow["role"],
        content: r.content,
        meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
        createdAt: r.created_at,
      }));
  }

  // -- Armies ---------------------------------------------------------------

  saveArmy(army: Army): Army {
    this.db
      .prepare(
        `INSERT INTO armies
           (id, name, faction, detachment, edition, points_limit, units, source_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           faction = excluded.faction,
           detachment = excluded.detachment,
           edition = excluded.edition,
           points_limit = excluded.points_limit,
           units = excluded.units,
           source_text = excluded.source_text,
           updated_at = excluded.updated_at`,
      )
      .run(
        army.id,
        army.name,
        army.faction,
        army.detachment ?? null,
        army.edition,
        army.pointsLimit ?? null,
        JSON.stringify(army.units),
        army.sourceText ?? null,
        army.createdAt,
        army.updatedAt,
      );
    return army;
  }

  private rowToArmy(r: {
    id: string;
    name: string;
    faction: string;
    detachment: string | null;
    edition: string;
    points_limit: number | null;
    units: string;
    source_text: string | null;
    created_at: string;
    updated_at: string;
  }): Army {
    return {
      id: r.id,
      name: r.name,
      faction: r.faction,
      detachment: r.detachment ?? undefined,
      edition: r.edition as Edition,
      pointsLimit: r.points_limit ?? undefined,
      units: JSON.parse(r.units) as ArmyUnitEntry[],
      sourceText: r.source_text ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listArmies(): Army[] {
    return this.db
      .prepare("SELECT * FROM armies ORDER BY updated_at DESC")
      .all()
      .map((r) => this.rowToArmy(r as Parameters<typeof this.rowToArmy>[0]));
  }

  getArmy(id: string): Army | null {
    const r = this.db.prepare("SELECT * FROM armies WHERE id = ?").get(id);
    return r ? this.rowToArmy(r as Parameters<typeof this.rowToArmy>[0]) : null;
  }

  deleteArmy(id: string): void {
    this.db.prepare("DELETE FROM armies WHERE id = ?").run(id);
  }

  // -- Collection -----------------------------------------------------------

  saveCollectionItem(item: CollectionItem): CollectionItem {
    this.db
      .prepare(
        `INSERT INTO collection_items
           (id, ref, quantity, wargear, painted, custom_name, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ref = excluded.ref,
           quantity = excluded.quantity,
           wargear = excluded.wargear,
           painted = excluded.painted,
           custom_name = excluded.custom_name,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .run(
        item.id,
        JSON.stringify(item.ref),
        item.quantity,
        JSON.stringify(item.wargear),
        item.painted,
        item.customName ?? null,
        item.notes ?? null,
        item.createdAt,
        item.updatedAt,
      );
    return item;
  }

  private rowToItem(r: {
    id: string;
    ref: string;
    quantity: number;
    wargear: string;
    painted: number;
    custom_name: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }): CollectionItem {
    return {
      id: r.id,
      ref: JSON.parse(r.ref) as CollectionItem["ref"],
      quantity: r.quantity,
      wargear: JSON.parse(r.wargear) as string[],
      painted: r.painted,
      customName: r.custom_name ?? undefined,
      notes: r.notes ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listCollection(): CollectionItem[] {
    return this.db
      .prepare("SELECT * FROM collection_items ORDER BY updated_at DESC")
      .all()
      .map((r) => this.rowToItem(r as Parameters<typeof this.rowToItem>[0]));
  }

  /** Match on datasheet name so "another box of Deathshroud" finds the row. */
  findCollectionItemByName(name: string): CollectionItem | null {
    const target = name.trim().toLowerCase();
    return (
      this.listCollection().find(
        (i) =>
          i.ref.name.toLowerCase() === target ||
          i.customName?.toLowerCase() === target,
      ) ?? null
    );
  }

  deleteCollectionItem(id: string): void {
    this.db.prepare("DELETE FROM collection_items WHERE id = ?").run(id);
  }
}
