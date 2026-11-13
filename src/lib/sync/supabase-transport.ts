import type { SupabaseClient } from '@supabase/supabase-js';

import type { PushChange, PushResult, ServerRecord, SyncTransport } from './types';

interface RecordRow {
  id: string;
  space_id: string;
  key_version: number;
  ciphertext: string | null;
  deleted: boolean;
  seq: number;
}

/** SyncTransport backed by the `records` table and `push_records` RPC. */
export class SupabaseTransport implements SyncTransport {
  constructor(private readonly client: SupabaseClient) {}

  async pull(spaceId: string, afterSeq: number, limit: number): Promise<ServerRecord[]> {
    const { data, error } = await this.client
      .from('records')
      .select('id, space_id, key_version, ciphertext, deleted, seq')
      .eq('space_id', spaceId)
      .gt('seq', afterSeq)
      .order('seq', { ascending: true })
      .limit(limit)
      .returns<RecordRow[]>();
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      keyVersion: r.key_version,
      ciphertext: r.ciphertext,
      deleted: r.deleted,
      seq: Number(r.seq),
    }));
  }

  async push(changes: PushChange[]): Promise<PushResult[]> {
    if (changes.length === 0) return [];
    const { data, error } = await this.client.rpc('push_records', { changes });
    if (error) throw error;
    return data as PushResult[];
  }
}
