import { decryptJson, encryptJson, type Sodium } from '../crypto';
import { HybridLogicalClock } from './hlc';
import { maxClock, mergePayloads } from './merge';
import type {
  Entity,
  Fields,
  KeyRing,
  LocalRecord,
  LocalStore,
  PushChange,
  RecordPayload,
  ServerRecord,
  SyncTransport,
} from './types';

export interface SyncEngineOptions {
  sodium: Sodium;
  store: LocalStore;
  transport: SyncTransport;
  keyring: KeyRing;
  /** Stable per-device id (also the HLC node id). */
  deviceId: string;
  generateId: () => string;
  now?: () => number;
  pullPageSize?: number;
  pushBatchSize?: number;
}

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflictsMerged: number;
  error?: unknown;
}

type Listener = () => void;

const recordContext = (spaceId: string, id: string, keyVersion: number) =>
  `mirel/v1/record/${spaceId}/${id}/${keyVersion}`;

const MAX_PUSH_ROUNDS = 5;

/**
 * Local-first, end-to-end encrypted sync.
 *
 * Writes go to memory + the encrypted local store immediately (works offline)
 * and are marked dirty. `sync()` pushes dirty records with optimistic
 * concurrency (baseSeq), merges conflicts on-device (the server can't read
 * data), then pulls everything newer than each space's cursor.
 */
export class SyncEngine {
  private readonly entities = new Map<string, Entity>();
  private readonly payloads = new Map<string, RecordPayload>();
  /** Records we hold but can't decrypt yet (e.g. key not loaded). */
  private readonly locked = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly clock: HybridLogicalClock;
  private syncing: Promise<SyncResult> | null = null;
  /** Serialises local writes so read-modify-write of a record is atomic. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SyncEngineOptions) {
    this.clock = new HybridLogicalClock(opts.deviceId, opts.now);
  }

  // --- lifecycle -----------------------------------------------------------

  async init(): Promise<void> {
    this.entities.clear();
    this.payloads.clear();
    this.locked.clear();
    for (const record of await this.opts.store.getAll()) this.loadIntoMemory(record);
    this.emit();
  }

  /** Re-attempt decryption, e.g. after new space keys arrive. */
  async refreshLocked(): Promise<void> {
    if (this.locked.size === 0) return;
    for (const id of [...this.locked]) {
      const record = await this.opts.store.get(id);
      if (record) this.loadIntoMemory(record);
    }
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- reads ---------------------------------------------------------------

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  list(kind?: string, spaceId?: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) {
      if ((kind === undefined || e.kind === kind) && (spaceId === undefined || e.spaceId === spaceId)) out.push(e);
    }
    return out;
  }

  async pendingCount(): Promise<number> {
    return (await this.opts.store.getDirty()).length;
  }

  // --- writes (work offline) ----------------------------------------------

  create(spaceId: string, kind: string, fields: Fields): Promise<string> {
    return this.serialize(async () => {
      const current = this.opts.keyring.currentKey(spaceId);
      if (!current) throw new Error(`No key for space ${spaceId}`);
      const id = this.opts.generateId();
      const clocks: Record<string, string> = {};
      for (const key of Object.keys(fields)) clocks[key] = this.clock.tick();
      const payload: RecordPayload = { kind, fields: { ...fields }, clocks };
      await this.writeLocal(
        { id, spaceId, keyVersion: current.version, ciphertext: null, deleted: false, baseSeq: null, dirty: true, localVersion: 0 },
        payload,
      );
      return id;
    });
  }

  update(id: string, patch: Fields): Promise<void> {
    return this.serialize(async () => {
      const record = await this.opts.store.get(id);
      const payload = this.payloads.get(id);
      if (!record || record.deleted || !payload) throw new Error(`Record ${id} not found`);
      const next: RecordPayload = { kind: payload.kind, fields: { ...payload.fields }, clocks: { ...payload.clocks } };
      for (const [key, value] of Object.entries(patch)) {
        next.fields[key] = value;
        next.clocks[key] = this.clock.tick();
      }
      await this.writeLocal({ ...record, dirty: true, localVersion: record.localVersion + 1 }, next);
    });
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const record = await this.opts.store.get(id);
      if (!record || record.deleted) return;
      await this.writeLocal({ ...record, deleted: true, dirty: true, localVersion: record.localVersion + 1 }, null);
    });
  }

  // --- sync ----------------------------------------------------------------

  /** Push then pull. Concurrent calls share one run. Never throws. */
  sync(): Promise<SyncResult> {
    this.syncing ??= this.runSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(): Promise<SyncResult> {
    const result: SyncResult = { ok: true, pushed: 0, pulled: 0, conflictsMerged: 0 };
    try {
      await this.push(result);
      await this.pull(result);
    } catch (error) {
      result.ok = false;
      result.error = error;
    }
    if (result.pulled > 0 || result.conflictsMerged > 0) this.emit();
    return result;
  }

  private async push(result: SyncResult): Promise<void> {
    const batchSize = this.opts.pushBatchSize ?? 100;
    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      const dirty = await this.opts.store.getDirty();
      if (dirty.length === 0) return;
      let conflicts = 0;
      for (let i = 0; i < dirty.length; i += batchSize) {
        const batch = dirty.slice(i, i + batchSize);
        const changes: PushChange[] = batch.map((r) => ({
          id: r.id,
          spaceId: r.spaceId,
          keyVersion: r.keyVersion,
          ciphertext: r.deleted ? null : r.ciphertext,
          deleted: r.deleted,
          baseSeq: r.baseSeq,
        }));
        const sent = new Map(batch.map((r) => [r.id, r]));
        const results = await this.opts.transport.push(changes);
        for (const res of results) {
          const snapshot = sent.get(res.id);
          if (!snapshot) continue;
          if (res.status === 'ok') {
            result.pushed++;
            await this.serialize(async () => {
              const latest = await this.opts.store.get(res.id);
              if (!latest) return;
              const unchanged = latest.localVersion === snapshot.localVersion;
              await this.opts.store.put({ ...latest, baseSeq: res.seq, dirty: unchanged ? false : latest.dirty });
            });
          } else {
            conflicts++;
            await this.serialize(() => this.absorbRemote(res.current, result));
          }
        }
      }
      if (conflicts === 0) return;
    }
  }

  private async pull(result: SyncResult): Promise<void> {
    const limit = this.opts.pullPageSize ?? 500;
    for (const spaceId of this.opts.keyring.spaceIds()) {
      let cursor = await this.opts.store.getCursor(spaceId);
      for (;;) {
        const page = await this.opts.transport.pull(spaceId, cursor, limit);
        if (page.length === 0) break;
        await this.serialize(async () => {
          for (const remote of page) {
            if (await this.absorbRemote(remote, result)) result.pulled++;
          }
          cursor = page[page.length - 1]!.seq;
          await this.opts.store.putMany([], { spaceId, seq: cursor });
        });
        if (page.length < limit) break;
      }
    }
  }

  /**
   * Integrate a server version into local state. Must run inside serialize().
   * Returns true if local state changed.
   */
  private async absorbRemote(remote: ServerRecord, result: SyncResult): Promise<boolean> {
    const local = await this.opts.store.get(remote.id);
    if (local && local.baseSeq !== null && remote.seq <= local.baseSeq) return false;

    const fresh: LocalRecord = {
      id: remote.id,
      spaceId: remote.spaceId,
      keyVersion: remote.keyVersion,
      ciphertext: remote.ciphertext,
      deleted: remote.deleted,
      baseSeq: remote.seq,
      dirty: false,
      localVersion: local?.localVersion ?? 0,
    };

    // No pending local edits, or remote deleted it (delete wins): take theirs.
    if (!local || !local.dirty || remote.deleted) {
      await this.opts.store.put(fresh);
      this.loadIntoMemory(fresh);
      return true;
    }

    result.conflictsMerged++;

    // We deleted it locally; keep the delete, now based on their version.
    if (local.deleted) {
      await this.opts.store.put({ ...local, baseSeq: remote.seq });
      return true;
    }

    const remotePayload = this.tryDecrypt(fresh);
    const localPayload = this.payloads.get(local.id);
    if (!remotePayload || !localPayload) {
      // Can't merge without keys. Keep ours *without* rebasing, so the server
      // keeps rejecting our push instead of us blindly overwriting their edit.
      result.conflictsMerged--;
      return false;
    }
    const remoteMax = maxClock(remotePayload);
    if (remoteMax) this.clock.receive(remoteMax);
    const merged = mergePayloads(localPayload, remotePayload);
    await this.writeLocal({ ...local, baseSeq: remote.seq, localVersion: local.localVersion + 1 }, merged);
    return true;
  }

  // --- internals -----------------------------------------------------------

  private async writeLocal(record: LocalRecord, payload: RecordPayload | null): Promise<void> {
    let stored = record;
    if (payload && !record.deleted) {
      const current = this.opts.keyring.currentKey(record.spaceId);
      if (!current) throw new Error(`No key for space ${record.spaceId}`);
      // Re-encrypt under the space's current key (handles key rotation).
      stored = {
        ...record,
        keyVersion: current.version,
        ciphertext: encryptJson(this.opts.sodium, current.key, payload, recordContext(record.spaceId, record.id, current.version)),
      };
    } else if (record.deleted) {
      stored = { ...record, ciphertext: null };
    }
    await this.opts.store.put(stored);
    this.setMemory(stored, payload);
    this.emit();
  }

  private loadIntoMemory(record: LocalRecord): void {
    if (record.deleted) {
      this.setMemory(record, null);
      return;
    }
    const payload = this.tryDecrypt(record);
    if (!payload) {
      this.entities.delete(record.id);
      this.payloads.delete(record.id);
      this.locked.add(record.id);
      return;
    }
    const max = maxClock(payload);
    if (max) this.clock.receive(max);
    this.setMemory(record, payload);
  }

  private setMemory(record: LocalRecord, payload: RecordPayload | null): void {
    this.locked.delete(record.id);
    if (record.deleted || !payload) {
      this.entities.delete(record.id);
      this.payloads.delete(record.id);
      return;
    }
    this.payloads.set(record.id, payload);
    this.entities.set(record.id, { id: record.id, spaceId: record.spaceId, kind: payload.kind, fields: payload.fields });
  }

  private tryDecrypt(record: LocalRecord): RecordPayload | null {
    if (!record.ciphertext) return null;
    const key = this.opts.keyring.key(record.spaceId, record.keyVersion);
    if (!key) return null;
    try {
      return decryptJson<RecordPayload>(
        this.opts.sodium,
        key,
        record.ciphertext,
        recordContext(record.spaceId, record.id, record.keyVersion),
      );
    } catch {
      return null;
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
