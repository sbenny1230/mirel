import type { PushChange, PushResult, ServerRecord, SyncTransport } from '../types';

/**
 * In-memory stand-in for the `records` table + `push_records` RPC, with the
 * same semantics as supabase/migrations (optimistic concurrency on baseSeq,
 * server-assigned increasing seq, tombstones without content).
 */
export class FakeServer {
  readonly records = new Map<string, ServerRecord>();
  private seq = 0;

  transport(): FakeTransport {
    return new FakeTransport(this);
  }

  push(changes: PushChange[]): PushResult[] {
    return changes.map((c) => {
      const current = this.records.get(c.id);
      if (current && current.spaceId !== c.spaceId) throw new Error('record belongs to another space');
      if (current && current.seq !== c.baseSeq) {
        return { id: c.id, status: 'conflict', current: { ...current } };
      }
      const seq = ++this.seq;
      this.records.set(c.id, {
        id: c.id,
        spaceId: c.spaceId,
        keyVersion: c.keyVersion,
        ciphertext: c.deleted ? null : c.ciphertext,
        deleted: c.deleted,
        seq,
      });
      return { id: c.id, status: 'ok', seq };
    });
  }

  pull(spaceId: string, afterSeq: number, limit: number): ServerRecord[] {
    return [...this.records.values()]
      .filter((r) => r.spaceId === spaceId && r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class FakeTransport implements SyncTransport {
  online = true;
  pushCalls = 0;

  constructor(private readonly server: FakeServer) {}

  async pull(spaceId: string, afterSeq: number, limit: number): Promise<ServerRecord[]> {
    this.assertOnline();
    return this.server.pull(spaceId, afterSeq, limit);
  }

  async push(changes: PushChange[]): Promise<PushResult[]> {
    this.assertOnline();
    this.pushCalls++;
    return this.server.push(changes);
  }

  private assertOnline(): void {
    if (!this.online) throw new Error('Network request failed');
  }
}
