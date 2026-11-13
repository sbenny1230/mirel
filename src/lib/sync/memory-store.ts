import type { LocalRecord, LocalStore } from './types';

/** Non-persistent LocalStore, used in tests and as a fallback. */
export class MemoryLocalStore implements LocalStore {
  private readonly records = new Map<string, LocalRecord>();
  private readonly cursors = new Map<string, number>();

  async getAll(): Promise<LocalRecord[]> {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  async get(id: string): Promise<LocalRecord | undefined> {
    const r = this.records.get(id);
    return r && { ...r };
  }

  async put(record: LocalRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async putMany(records: LocalRecord[], cursor?: { spaceId: string; seq: number }): Promise<void> {
    for (const r of records) this.records.set(r.id, { ...r });
    if (cursor) this.cursors.set(cursor.spaceId, cursor.seq);
  }

  async getDirty(): Promise<LocalRecord[]> {
    return [...this.records.values()].filter((r) => r.dirty).map((r) => ({ ...r }));
  }

  async getCursor(spaceId: string): Promise<number> {
    return this.cursors.get(spaceId) ?? 0;
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.cursors.clear();
  }
}
