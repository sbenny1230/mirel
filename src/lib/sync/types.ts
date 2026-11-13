export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Fields = Record<string, Json>;

/**
 * What actually gets encrypted. `kind` lives inside the ciphertext so the
 * server can't even tell a note from a gift idea. Each field carries its own
 * hybrid-logical-clock stamp so concurrent offline edits merge per field.
 */
export interface RecordPayload {
  kind: string;
  fields: Fields;
  clocks: Record<string, string>;
}

/** A row as the server stores it: routing metadata + opaque ciphertext. */
export interface ServerRecord {
  id: string;
  spaceId: string;
  keyVersion: number;
  /** null for tombstones — deleted content is not retained. */
  ciphertext: string | null;
  deleted: boolean;
  /** Server-assigned, strictly increasing within a space. */
  seq: number;
}

export interface PushChange {
  id: string;
  spaceId: string;
  keyVersion: number;
  ciphertext: string | null;
  deleted: boolean;
  /** The server seq this edit was based on; null for a record the server hasn't seen. */
  baseSeq: number | null;
}

export type PushResult =
  | { id: string; status: 'ok'; seq: number }
  | { id: string; status: 'conflict'; current: ServerRecord };

export interface SyncTransport {
  /** Records in `spaceId` with seq > afterSeq, ascending by seq. */
  pull(spaceId: string, afterSeq: number, limit: number): Promise<ServerRecord[]>;
  push(changes: PushChange[]): Promise<PushResult[]>;
}

/** A record as persisted on the device. Still encrypted at rest. */
export interface LocalRecord {
  id: string;
  spaceId: string;
  keyVersion: number;
  ciphertext: string | null;
  deleted: boolean;
  baseSeq: number | null;
  /** Has local changes the server hasn't acknowledged. */
  dirty: boolean;
  /** Bumped on every local write; lets an in-flight push detect newer edits. */
  localVersion: number;
}

export interface LocalStore {
  getAll(): Promise<LocalRecord[]>;
  get(id: string): Promise<LocalRecord | undefined>;
  put(record: LocalRecord): Promise<void>;
  /** Atomically writes records and (optionally) advances a space's pull cursor. */
  putMany(records: LocalRecord[], cursor?: { spaceId: string; seq: number }): Promise<void>;
  getDirty(): Promise<LocalRecord[]>;
  getCursor(spaceId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface KeyRing {
  spaceIds(): string[];
  currentKey(spaceId: string): { key: Uint8Array; version: number } | undefined;
  key(spaceId: string, version: number): Uint8Array | undefined;
}

/** A decrypted record, as the UI sees it. */
export interface Entity {
  id: string;
  spaceId: string;
  kind: string;
  fields: Fields;
}
