import type { RecordPayload } from './types';

/**
 * Field-level last-writer-wins merge. Commutative, associative and idempotent,
 * so devices converge regardless of the order they see edits in.
 */
export function mergePayloads(a: RecordPayload, b: RecordPayload): RecordPayload {
  const fields: RecordPayload['fields'] = {};
  const clocks: RecordPayload['clocks'] = {};
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const key of keys) {
    const winner = pick(a, b, key);
    const value = winner.fields[key];
    if (value !== undefined) fields[key] = value;
    const clock = winner.clocks[key];
    if (clock !== undefined) clocks[key] = clock;
  }
  // `kind` is immutable after creation; the min keeps the merge symmetric.
  return { kind: a.kind <= b.kind ? a.kind : b.kind, fields, clocks };
}

function pick(a: RecordPayload, b: RecordPayload, key: string): RecordPayload {
  const ca = a.clocks[key] ?? '';
  const cb = b.clocks[key] ?? '';
  if (ca !== cb) return ca > cb ? a : b;
  // Same stamp means same write; tie-break on value only for robustness.
  return JSON.stringify(a.fields[key] ?? null) >= JSON.stringify(b.fields[key] ?? null) ? a : b;
}

export function maxClock(payload: RecordPayload): string | undefined {
  let max: string | undefined;
  for (const c of Object.values(payload.clocks)) if (max === undefined || c > max) max = c;
  return max;
}
