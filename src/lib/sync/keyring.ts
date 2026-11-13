import type { KeyRing } from './types';

/** Holds decrypted space keys in memory while the vault is unlocked. */
export class MemoryKeyRing implements KeyRing {
  private readonly keys = new Map<string, Map<number, Uint8Array>>();

  add(spaceId: string, version: number, key: Uint8Array): void {
    let versions = this.keys.get(spaceId);
    if (!versions) this.keys.set(spaceId, (versions = new Map()));
    versions.set(version, key);
  }

  spaceIds(): string[] {
    return [...this.keys.keys()];
  }

  currentKey(spaceId: string): { key: Uint8Array; version: number } | undefined {
    const versions = this.keys.get(spaceId);
    if (!versions || versions.size === 0) return undefined;
    const version = Math.max(...versions.keys());
    return { key: versions.get(version)!, version };
  }

  key(spaceId: string, version: number): Uint8Array | undefined {
    return this.keys.get(spaceId)?.get(version);
  }

  /** Wipe all keys (on lock / sign-out). */
  clear(): void {
    for (const versions of this.keys.values()) for (const k of versions.values()) k.fill(0);
    this.keys.clear();
  }
}
