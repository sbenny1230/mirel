import * as lib from 'react-native-libsodium';

/**
 * The subset of libsodium Mirel relies on.
 *
 * Restricted on purpose to functions the native (JSI) build of
 * react-native-libsodium implements, so iOS, Android, web and Jest all behave
 * identically. Notable native constraint: AEAD additional data must be a string.
 */
export interface Sodium {
  randombytes_buf(length: number): Uint8Array;

  crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: string,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: string,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;

  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash(
    keyLength: number,
    password: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;

  crypto_generichash(hashLength: number, message: Uint8Array, key?: Uint8Array | null): Uint8Array;
}

// Web needs the "sumo" build for crypto_pwhash (Argon2id). No-op on native.
lib.loadSumoVersion();

let cached: Promise<Sodium> | undefined;

/** Resolves once libsodium is initialised (instant on native, wasm load on web). */
export function getSodium(): Promise<Sodium> {
  cached ??= lib.ready.then(() => lib.default as unknown as Sodium);
  return cached;
}
