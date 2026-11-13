import { concatBytes, fromBase64, toBase64, utf8Decode, utf8Encode } from './encoding';
import type { Sodium } from './sodium';

/**
 * Authenticated encryption with XChaCha20-Poly1305.
 *
 * Output format: `v1.<base64(nonce || ciphertext+tag)>`. A random 24-byte nonce
 * per message is safe with XChaCha. `context` is authenticated (not encrypted)
 * additional data: decryption fails unless the same context is supplied, which
 * stops the server from moving a ciphertext to a different record/slot.
 */

const PREFIX = 'v1.';

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt: wrong key, wrong context or tampered data') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function encryptBytes(sodium: Sodium, key: Uint8Array, plaintext: Uint8Array, context: string): string {
  assertKey(sodium, key);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, context, null, nonce, key);
  return PREFIX + toBase64(concatBytes(nonce, ciphertext));
}

export function decryptBytes(sodium: Sodium, key: Uint8Array, sealed: string, context: string): Uint8Array {
  assertKey(sodium, key);
  if (!sealed.startsWith(PREFIX)) throw new DecryptionError('Unknown ciphertext version');
  let raw: Uint8Array;
  try {
    raw = fromBase64(sealed.slice(PREFIX.length));
  } catch {
    throw new DecryptionError('Malformed ciphertext');
  }
  const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (raw.length <= nonceLength) throw new DecryptionError('Malformed ciphertext');
  const nonce = raw.slice(0, nonceLength);
  const ciphertext = raw.slice(nonceLength);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, context, nonce, key);
  } catch {
    throw new DecryptionError();
  }
}

export function encryptJson(sodium: Sodium, key: Uint8Array, value: unknown, context: string): string {
  return encryptBytes(sodium, key, utf8Encode(JSON.stringify(value)), context);
}

export function decryptJson<T>(sodium: Sodium, key: Uint8Array, sealed: string, context: string): T {
  return JSON.parse(utf8Decode(decryptBytes(sodium, key, sealed, context))) as T;
}

function assertKey(sodium: Sodium, key: Uint8Array): void {
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error('Invalid key length');
  }
}
