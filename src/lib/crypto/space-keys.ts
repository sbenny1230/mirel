import { fromBase64, toBase64, utf8Decode, utf8Encode } from './encoding';
import type { Sodium } from './sodium';
import type { UnlockedVault } from './vault';

/**
 * Space keys: one symmetric key per space (and key version). Everything in a
 * space is encrypted with it. Each member receives the key sealed to their
 * public key (anonymous sealed box), so the server only stores ciphertext.
 *
 * The sealed payload names its space and version, so the server can't hand a
 * member the key for space A labelled as space B.
 *
 * Known v1 limitation: sealed boxes don't authenticate the sender. Before
 * sharing ships, invites should be signed by the inviter's identity key so a
 * malicious server can't inject a space it controls. See docs/security-model.md.
 */

const KEY_BYTES = 32;

interface SealedSpaceKeyPayload {
  t: 'mirel/space-key/v1';
  spaceId: string;
  keyVersion: number;
  key: string;
}

export function generateSpaceKey(sodium: Sodium): Uint8Array {
  return sodium.randombytes_buf(KEY_BYTES);
}

export function sealSpaceKey(
  sodium: Sodium,
  spaceKey: Uint8Array,
  spaceId: string,
  keyVersion: number,
  recipientPublicKey: Uint8Array,
): string {
  const payload: SealedSpaceKeyPayload = { t: 'mirel/space-key/v1', spaceId, keyVersion, key: toBase64(spaceKey) };
  return toBase64(sodium.crypto_box_seal(utf8Encode(JSON.stringify(payload)), recipientPublicKey));
}

export function openSpaceKey(
  sodium: Sodium,
  sealed: string,
  spaceId: string,
  keyVersion: number,
  vault: UnlockedVault,
): Uint8Array {
  let payload: SealedSpaceKeyPayload;
  try {
    const opened = sodium.crypto_box_seal_open(fromBase64(sealed), vault.publicKey, vault.privateKey);
    payload = JSON.parse(utf8Decode(opened)) as SealedSpaceKeyPayload;
  } catch {
    throw new Error('Unable to open space key');
  }
  if (payload.t !== 'mirel/space-key/v1' || payload.spaceId !== spaceId || payload.keyVersion !== keyVersion) {
    throw new Error('Space key does not belong to this space');
  }
  const key = fromBase64(payload.key);
  if (key.length !== KEY_BYTES) throw new Error('Invalid space key');
  return key;
}
