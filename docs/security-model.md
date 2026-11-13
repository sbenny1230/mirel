# Mirel security model

Mirel stores sensitive notes about other people. The goal: **the server (and
whoever operates it) can never read user content.** All encryption happens on
the device.

## What the server can and cannot see

| Server can see (plaintext)                                  | Server cannot see (encrypted)                          |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Account email, user ids                                     | Names, photos, birthdays, notes, gift ideas, prices    |
| Space ids and who is a member of which space                | Record type (person / note / gift / occasion …)        |
| Record ids, sequence numbers, timestamps, deleted flag      | Space names, tags, facts, anything typed into the app  |
| Ciphertext sizes                                            | Passphrase, recovery code, master/private/space keys   |
| Reminder send times (once email reminders ship)             |                                                        |

## Keys

```
passphrase ──Argon2id(64 MiB, 3 passes, random salt)──► wraps ─┐
recovery code (160-bit random) ──BLAKE2b──────────────► wraps ─┼─► master key (random)
                                                                │        │
                                                                │        └─ encrypts ─► X25519 identity private key
space key (random, per space + version) ──sealed box──► each member's identity public key
records ──XChaCha20-Poly1305(space key, AD = space/record/key-version)──► ciphertext
```

- Code: [`src/lib/crypto`](../src/lib/crypto). Primitives come from libsodium
  (`react-native-libsodium` on native, its wasm build on web and in tests).
- The **vault bundle** (`user_keys.bundle`) holds only ciphertext, the public
  key and KDF parameters. Argon2 parameters are stored per bundle so the cost
  can be raised later.
- **Associated data** binds each ciphertext to its slot, so the server can't
  swap ciphertexts between records, spaces, key versions or users without
  decryption failing. This is covered by tests.
- **Passphrase change** re-wraps the master key only. **Recovery** uses the
  recovery code. If a user loses both, their data is unrecoverable. That is
  the point, and onboarding must say so clearly.

## Sync

- Code: [`src/lib/sync`](../src/lib/sync), with the server side in
  [`supabase/migrations`](../supabase/migrations).
- Clients can only *read* rows in spaces they belong to (RLS). All writes go
  through the `push_records` / `create_space` security-definer functions,
  which check membership and enforce optimistic concurrency.
- Conflicts are merged **on the device**, because the server can't read the
  data. A delete wins over a concurrent edit, and deleted rows keep no
  ciphertext.
- Data at rest on the device is the same E2EE ciphertext (SQLite), decrypted
  only into memory while the vault is unlocked.

## Known gaps (to fix before the features that depend on them ship)

1. **Sender authentication for shared spaces.** Sealed boxes are anonymous.
   A malicious server could seal a key it controls to a user and present it
   as a new shared space. Before sharing ships: sign invites and space-key
   grants with an Ed25519 identity key, and show a safety number or
   fingerprint for out-of-band verification.
2. **Removing a member** must rotate the space key (new version, re-encrypt
   or encrypt-on-next-write). The engine already re-encrypts under the
   current key version on every write.
3. **Metadata.** Record counts, sizes and edit timing are visible. Padding
   ciphertexts to size buckets would reduce what leaks through sizes.
4. **Web is the weakest platform.** Keys live in page memory, and any XSS
   would be fatal. Needs a strict Content Security Policy, no third-party
   scripts, and unlocking each session.
5. **Device key storage.** The plan is to keep the unlocked master key in
   `expo-secure-store` behind biometrics, so users don't re-type the
   passphrase on every launch. Not built yet.
6. **External review.** Get a professional review of this design before
   public launch.
