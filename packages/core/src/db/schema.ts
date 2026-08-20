/**
 * SQLite schema.
 *
 * `events` is the source of truth for battles — battle rows carry only
 * identity and a cached snapshot so the Home screen does not have to replay
 * every log to list games. Deleting the snapshot column would lose nothing.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE armies (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        faction     TEXT NOT NULL,
        detachment  TEXT,
        edition     TEXT NOT NULL,
        points_limit INTEGER,
        units       TEXT NOT NULL,
        source_text TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE collection_items (
        id          TEXT PRIMARY KEY,
        ref         TEXT NOT NULL,
        quantity    INTEGER NOT NULL DEFAULT 0,
        wargear     TEXT NOT NULL DEFAULT '[]',
        painted     INTEGER NOT NULL DEFAULT 0,
        custom_name TEXT,
        notes       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE battles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        edition     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        snapshot    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        game_id     TEXT NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        source      TEXT NOT NULL,
        raw_input   TEXT,
        batch_id    TEXT,
        undone      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_events_game_seq ON events(game_id, seq);
      CREATE INDEX idx_events_game ON events(game_id, seq);
      CREATE INDEX idx_events_batch ON events(batch_id);

      CREATE TABLE messages (
        id          TEXT PRIMARY KEY,
        game_id     TEXT NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        meta        TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX idx_messages_game ON messages(game_id, seq);
    `,
  },
  {
    id: 2,
    sql: `
      -- Imported supplemental documents. The retrieval layer on top of this is
      -- deliberately not built yet; the table exists so imports are not lost.
      CREATE TABLE documents (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        kind        TEXT NOT NULL,
        edition     TEXT,
        source_path TEXT,
        text        TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );

      CREATE TABLE document_chunks (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        text        TEXT NOT NULL,
        embedding   BLOB,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX idx_chunks_doc ON document_chunks(document_id, ordinal);
    `,
  },
];

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL keeps the UI readable while a battle is being written to.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const applied = new Set(
    db
      .prepare<[], { id: number }>("SELECT id FROM _migrations")
      .all()
      .map((r) => r.id),
  );

  const record = db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.id, new Date().toISOString());
    })();
  }
}
