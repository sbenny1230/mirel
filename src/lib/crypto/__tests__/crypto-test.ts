import {
  changePassphrase,
  createVault,
  decryptJson,
  DecryptionError,
  encryptJson,
  formatRecoveryCode,
  fromBase64,
  generateSpaceKey,
  getSodium,
  openSpaceKey,
  parseRecoveryCode,
  sealSpaceKey,
  toBase64,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  utf8Decode,
  utf8Encode,
  WrongPassphraseError,
  type Sodium,
} from '..';

// Cheap Argon2 settings keep the suite fast; one test exercises the real defaults.
const FAST = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };
const USER = '11111111-1111-4111-8111-111111111111';
const PASS = 'correct horse battery staple';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await getSodium();
});

describe('encoding', () => {
  it('round-trips unicode through utf8', () => {
    const text = 'Loves Earl Grey ☕, crème brûlée & 🌻 sunflowers — 日本';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
  });

  it('round-trips base64 for all lengths', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = sodium.randombytes_buf(n);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(toBase64(utf8Encode('hello'))).toBe('aGVsbG8=');
  });
});

describe('aead', () => {
  it('encrypts and decrypts JSON with matching context', () => {
    const key = generateSpaceKey(sodium);
    const sealed = encryptJson(sodium, key, { likes: ['tea'] }, 'ctx-a');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('tea');
    expect(decryptJson(sodium, key, sealed, 'ctx-a')).toEqual({ likes: ['tea'] });
  });

  it('uses a fresh nonce every time', () => {
    const key = generateSpaceKey(sodium);
    expect(encryptJson(sodium, key, 1, 'c')).not.toBe(encryptJson(sodium, key, 1, 'c'));
  });

  it('rejects wrong key, wrong context and tampering', () => {
    const key = generateSpaceKey(sodium);
    const sealed = encryptJson(sodium, key, 'secret', 'ctx-a');
    expect(() => decryptJson(sodium, generateSpaceKey(sodium), sealed, 'ctx-a')).toThrow(DecryptionError);
    expect(() => decryptJson(sodium, key, sealed, 'ctx-b')).toThrow(DecryptionError);
    const raw = fromBase64(sealed.slice(3));
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptJson(sodium, key, 'v1.' + toBase64(raw), 'ctx-a')).toThrow(DecryptionError);
  });
});

describe('vault', () => {
  it('unlocks with the passphrase and recovers the same keys', async () => {
    const { bundle, vault } = await createVault(sodium, USER, PASS, FAST);
    const unlocked = unlockWithPassphrase(sodium, USER, bundle, PASS);
    expect(unlocked.masterKey).toEqual(vault.masterKey);
    expect(unlocked.privateKey).toEqual(vault.privateKey);
    expect(toBase64(unlocked.publicKey)).toBe(bundle.publicKey);
  });

  it('never stores secrets in plaintext', async () => {
    const { bundle, vault } = await createVault(sodium, USER, PASS, FAST);
    const json = JSON.stringify(bundle);
    expect(json).not.toContain(toBase64(vault.masterKey));
    expect(json).not.toContain(toBase64(vault.privateKey));
    expect(json).not.toContain(PASS);
  });

  it('rejects a wrong passphrase', async () => {
    const { bundle } = await createVault(sodium, USER, PASS, FAST);
    expect(() => unlockWithPassphrase(sodium, USER, bundle, 'not the passphrase')).toThrow(WrongPassphraseError);
  });

  it('is bound to the user id', async () => {
    const { bundle } = await createVault(sodium, USER, PASS, FAST);
    const other = '22222222-2222-4222-8222-222222222222';
    expect(() => unlockWithPassphrase(sodium, other, bundle, PASS)).toThrow(WrongPassphraseError);
  });

  it('unlocks with the recovery code, leniently formatted', async () => {
    const { bundle, recoveryCode, vault } = await createVault(sodium, USER, PASS, FAST);
    expect(recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const typed = recoveryCode.toLowerCase().replace(/-/g, ' ');
    expect(unlockWithRecoveryCode(sodium, USER, bundle, typed).masterKey).toEqual(vault.masterKey);
    expect(() => unlockWithRecoveryCode(sodium, USER, bundle, 'AAAA-BBBB')).toThrow(WrongPassphraseError);
  });

  it('changes passphrase without changing the master key', async () => {
    const { bundle, vault, recoveryCode } = await createVault(sodium, USER, PASS, FAST);
    const next = changePassphrase(sodium, USER, bundle, vault, 'a brand new passphrase', FAST);
    expect(unlockWithPassphrase(sodium, USER, next, 'a brand new passphrase').masterKey).toEqual(vault.masterKey);
    expect(() => unlockWithPassphrase(sodium, USER, next, PASS)).toThrow(WrongPassphraseError);
    expect(unlockWithRecoveryCode(sodium, USER, next, recoveryCode).masterKey).toEqual(vault.masterKey);
  });

  it('rejects short passphrases', async () => {
    await expect(createVault(sodium, USER, 'short', FAST)).rejects.toThrow(/at least/);
  });

  it('works with the production Argon2id cost', async () => {
    const { bundle } = await createVault(sodium, USER, PASS);
    expect(bundle.passphrase.kdf).toMatchObject({ alg: 'argon2id13', opsLimit: 3, memLimit: 64 * 1024 * 1024 });
    expect(() => unlockWithPassphrase(sodium, USER, bundle, PASS)).not.toThrow();
  });

  it('recovery code format round-trips', () => {
    for (let i = 0; i < 20; i++) {
      const bytes = sodium.randombytes_buf(20);
      expect(parseRecoveryCode(formatRecoveryCode(bytes))).toEqual(bytes);
    }
  });
});

describe('space keys', () => {
  it('seals a space key that only the recipient can open', async () => {
    const alice = (await createVault(sodium, USER, PASS, FAST)).vault;
    const bob = (await createVault(sodium, USER, PASS, FAST)).vault;
    const key = generateSpaceKey(sodium);
    const sealed = sealSpaceKey(sodium, key, 'space-1', 1, bob.publicKey);
    expect(openSpaceKey(sodium, sealed, 'space-1', 1, bob)).toEqual(key);
    expect(() => openSpaceKey(sodium, sealed, 'space-1', 1, alice)).toThrow();
  });

  it('refuses a key relabelled for another space or version', async () => {
    const bob = (await createVault(sodium, USER, PASS, FAST)).vault;
    const sealed = sealSpaceKey(sodium, generateSpaceKey(sodium), 'space-1', 1, bob.publicKey);
    expect(() => openSpaceKey(sodium, sealed, 'space-2', 1, bob)).toThrow(/does not belong/);
    expect(() => openSpaceKey(sodium, sealed, 'space-1', 2, bob)).toThrow(/does not belong/);
  });
});
