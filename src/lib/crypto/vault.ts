import { decryptBytes, encryptBytes } from './aead';
import { concatBytes, fromBase64, toBase64, utf8Encode, wipe } from './encoding';
import type { Sodium } from './sodium';

/**
 * The vault: a user's long-term keys, recoverable only by the user.
 *
 *   masterKey (random, 32 bytes)
 *     ├─ wrapped by Argon2id(passphrase)   → so the user can unlock on any device
 *     ├─ wrapped by hash(recovery code)    → so a forgotten passphrase isn't fatal
 *     └─ encrypts the identity private key (X25519) used to receive space keys
 *
 * Only the VaultBundle (all ciphertext + public key + KDF params) is stored on
 * the server. Changing the passphrase re-wraps the master key only.
 */

export interface KdfParams {
  alg: 'argon2id13';
  opsLimit: number;
  memLimit: number;
  /** base64 */
  salt: string;
}

export interface VaultBundle {
  version: 1;
  /** base64 X25519 public key — shareable, used by others to send you space keys. */
  publicKey: string;
  encryptedPrivateKey: string;
  passphrase: { kdf: KdfParams; wrappedMasterKey: string };
  recovery: { wrappedMasterKey: string };
}

export interface UnlockedVault {
  masterKey: Uint8Array;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Argon2id cost. 64 MiB / 3 passes is OWASP's recommended minimum and stays
 * usable on low-end phones and in browsers. Params are stored per bundle so
 * they can be raised later without breaking existing users.
 */
export const DEFAULT_KDF_COST = { opsLimit: 3, memLimit: 64 * 1024 * 1024 } as const;

export const MIN_PASSPHRASE_LENGTH = 10;

const KEY_BYTES = 32;
const RECOVERY_CODE_BYTES = 20; // 160 bits of entropy
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ctx = (userId: string, slot: string) => `mirel/v1/vault/${userId}/${slot}`;

export class WrongPassphraseError extends Error {
  constructor() {
    super('Incorrect passphrase or recovery code');
    this.name = 'WrongPassphraseError';
  }
}

export async function createVault(
  sodium: Sodium,
  userId: string,
  passphrase: string,
  cost: { opsLimit: number; memLimit: number } = DEFAULT_KDF_COST,
): Promise<{ bundle: VaultBundle; recoveryCode: string; vault: UnlockedVault }> {
  assertPassphrase(passphrase);
  const masterKey = sodium.randombytes_buf(KEY_BYTES);
  const { publicKey, privateKey } = sodium.crypto_box_keypair();

  const recoveryBytes = sodium.randombytes_buf(RECOVERY_CODE_BYTES);
  const recoveryCode = formatRecoveryCode(recoveryBytes);

  const passphraseSlot = wrapWithPassphrase(sodium, userId, masterKey, passphrase, cost);
  const recoveryKey = recoveryKeyFromBytes(sodium, recoveryBytes);
  const bundle: VaultBundle = {
    version: 1,
    publicKey: toBase64(publicKey),
    encryptedPrivateKey: encryptBytes(sodium, masterKey, privateKey, ctx(userId, 'private-key')),
    passphrase: passphraseSlot,
    recovery: { wrappedMasterKey: encryptBytes(sodium, recoveryKey, masterKey, ctx(userId, 'mk/recovery')) },
  };
  wipe(recoveryKey);
  wipe(recoveryBytes);

  return { bundle, recoveryCode, vault: { masterKey, publicKey, privateKey } };
}

export function unlockWithPassphrase(
  sodium: Sodium,
  userId: string,
  bundle: VaultBundle,
  passphrase: string,
): UnlockedVault {
  const { kdf, wrappedMasterKey } = bundle.passphrase;
  const key = deriveKey(sodium, passphrase, kdf);
  try {
    return openWithMasterKey(sodium, userId, bundle, unwrap(sodium, key, wrappedMasterKey, ctx(userId, 'mk/passphrase')));
  } finally {
    wipe(key);
  }
}

export function unlockWithRecoveryCode(
  sodium: Sodium,
  userId: string,
  bundle: VaultBundle,
  recoveryCode: string,
): UnlockedVault {
  const bytes = parseRecoveryCode(recoveryCode);
  if (!bytes) throw new WrongPassphraseError();
  const key = recoveryKeyFromBytes(sodium, bytes);
  try {
    return openWithMasterKey(sodium, userId, bundle, unwrap(sodium, key, bundle.recovery.wrappedMasterKey, ctx(userId, 'mk/recovery')));
  } finally {
    wipe(key);
    wipe(bytes);
  }
}

/** Re-wraps the master key under a new passphrase. Data and recovery code are unaffected. */
export function changePassphrase(
  sodium: Sodium,
  userId: string,
  bundle: VaultBundle,
  vault: UnlockedVault,
  newPassphrase: string,
  cost: { opsLimit: number; memLimit: number } = DEFAULT_KDF_COST,
): VaultBundle {
  assertPassphrase(newPassphrase);
  return { ...bundle, passphrase: wrapWithPassphrase(sodium, userId, vault.masterKey, newPassphrase, cost) };
}

export function lockVault(vault: UnlockedVault): void {
  wipe(vault.masterKey);
  wipe(vault.privateKey);
}

// --- recovery code -------------------------------------------------------

/** 20 random bytes → 32 Crockford base32 chars, shown as 8 groups of 4. */
export function formatRecoveryCode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Lenient parse: ignores case, spaces and dashes; maps O→0 and I/L→1. */
export function parseRecoveryCode(code: string): Uint8Array | null {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== Math.ceil((RECOVERY_CODE_BYTES * 8) / 5)) return null;
  const out = new Uint8Array(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[o++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return o === RECOVERY_CODE_BYTES ? out : null;
}

// --- internals -----------------------------------------------------------

function wrapWithPassphrase(
  sodium: Sodium,
  userId: string,
  masterKey: Uint8Array,
  passphrase: string,
  cost: { opsLimit: number; memLimit: number },
): VaultBundle['passphrase'] {
  const kdf: KdfParams = {
    alg: 'argon2id13',
    ...cost,
    salt: toBase64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)),
  };
  const key = deriveKey(sodium, passphrase, kdf);
  try {
    return { kdf, wrappedMasterKey: encryptBytes(sodium, key, masterKey, ctx(userId, 'mk/passphrase')) };
  } finally {
    wipe(key);
  }
}

function deriveKey(sodium: Sodium, passphrase: string, kdf: KdfParams): Uint8Array {
  if (kdf.alg !== 'argon2id13') throw new Error(`Unsupported KDF: ${kdf.alg}`);
  return sodium.crypto_pwhash(
    KEY_BYTES,
    utf8Encode(passphrase.normalize('NFKC')),
    fromBase64(kdf.salt),
    kdf.opsLimit,
    kdf.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

function recoveryKeyFromBytes(sodium: Sodium, bytes: Uint8Array): Uint8Array {
  // High-entropy input, so a fast domain-separated hash is sufficient.
  return sodium.crypto_generichash(KEY_BYTES, concatBytes(utf8Encode('mirel/v1/recovery-key'), bytes));
}

function unwrap(sodium: Sodium, key: Uint8Array, sealed: string, context: string): Uint8Array {
  try {
    return decryptBytes(sodium, key, sealed, context);
  } catch {
    throw new WrongPassphraseError();
  }
}

function openWithMasterKey(sodium: Sodium, userId: string, bundle: VaultBundle, masterKey: Uint8Array): UnlockedVault {
  const privateKey = decryptBytes(sodium, masterKey, bundle.encryptedPrivateKey, ctx(userId, 'private-key'));
  return { masterKey, privateKey, publicKey: fromBase64(bundle.publicKey) };
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.trim().length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}
