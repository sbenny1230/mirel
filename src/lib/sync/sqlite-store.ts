import * as SQLite from 'expo-sqlite';

import type { LocalRecord, LocalStore } from './types';

/**
 * Persistent LocalStore on expo-sqlite (iOS, Android and web via wasm).
 *
 * Rows hold the same end-to-end-encrypted ciphertext the server has, so data
 * at rest on the device is encrypted even without SQLCipher. One database per
 * signed-in user keeps accounts on a shared device fully separate.
 */

interface Row {
  id: string;
  space_id: string;
  key_version: number;
  ciphertext: string | null;
  deleted: number;
  base_seq: number | null;
  dirty: number;
  local_version: number;
}

const SCHEMA_VERSION = 1;

export async function openSqliteStore(userId: string): Promise<SqliteLocalStore> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid user id');
  const db = await SQLite.openDatabaseAsync(`mirel-${userId}.db`);
  await migrate(db);
  return new SqliteLocalStore(db, userId);
}

export async function deleteSqliteStore(userId: string): Promise<void> {
  await SQLite.deleteDatabaseAsync(`mirel-${userId}.db`);
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      id            TEXT PRIMARY KEY NOT NULL,
      space_id      TEXT NOT NULL,
      key_version   INTEGER NOT NULL,
      ciphertext    TEXT,
      deleted       INTEGER NOT NULL DEFAULT 0,
      base_seq      INTEGER,
      dirty         INTEGER NOT NULL DEFAULT 0,
      local_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS records_dirty ON records (dirty) WHERE dirty = 1;
    CREATE TABLE IF NOT EXISTS cursors (
      space_id TEXT PRIMARY KEY NOT NULL,
      seq      INTEGER NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

const toRecord = (r: Row): LocalRecord => ({
  id: r.id,
  spaceId: r.space_id,
  keyVersion: r.key_version,
  ciphertext: r.ciphertext,
  deleted: r.deleted === 1,
  baseSeq: r.base_seq,
  dirty: r.dirty === 1,
  localVersion: r.local_version,
});

const UPSERT = `
  INSERT INTO records (id, space_id, key_version, ciphertext, deleted, base_seq, dirty, local_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    space_id = excluded.space_id, key_version = excluded.key_version, ciphertext = excluded.ciphertext,
    deleted = excluded.deleted, base_seq = excluded.base_seq, dirty = excluded.dirty,
    local_version = excluded.local_version`;

const params = (r: LocalRecord) =>
  [r.id, r.spaceId, r.keyVersion, r.ciphertext, r.deleted ? 1 : 0, r.baseSeq, r.dirty ? 1 : 0, r.localVersion] as const;

export class SqliteLocalStore implements LocalStore {
  constructor(
    private readonly db: SQLite.SQLiteDatabase,
    readonly userId: string,
  ) {}

  async getAll(): Promise<LocalRecord[]> {
    return (await this.db.getAllAsync<Row>('SELECT * FROM records')).map(toRecord);
  }

  async get(id: string): Promise<LocalRecord | undefined> {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE id = ?', id);
    return row ? toRecord(row) : undefined;
  }

  async put(record: LocalRecord): Promise<void> {
    await this.db.runAsync(UPSERT, ...params(record));
  }

  async putMany(records: LocalRecord[], cursor?: { spaceId: string; seq: number }): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const r of records) await this.db.runAsync(UPSERT, ...params(r));
      if (cursor) {
        await this.db.runAsync(
          'INSERT INTO cursors (space_id, seq) VALUES (?, ?) ON CONFLICT (space_id) DO UPDATE SET seq = excluded.seq',
          cursor.spaceId,
          cursor.seq,
        );
      }
    });
  }

  async getDirty(): Promise<LocalRecord[]> {
    return (await this.db.getAllAsync<Row>('SELECT * FROM records WHERE dirty = 1')).map(toRecord);
  }

  async getCursor(spaceId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ seq: number }>('SELECT seq FROM cursors WHERE space_id = ?', spaceId);
    return row?.seq ?? 0;
  }

  async clear(): Promise<void> {
    await this.db.execAsync('DELETE FROM records; DELETE FROM cursors;');
  }
}
