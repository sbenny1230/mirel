# Mirel

Remember what matters to the people you love: likes, dislikes, favourite
moments, gift ideas, birthdays. Mirel nudges you to be intentional with them.

- **Private by design:** end-to-end encrypted, so the server only ever stores
  ciphertext. See [docs/security-model.md](docs/security-model.md).
- **Works offline:** edit anywhere, and changes sync across devices when
  you're back online.
- **One codebase:** Expo + TypeScript for iOS, Android and web
  (react-native-web).

## Stack

| Concern       | Choice                                                      |
| ------------- | ----------------------------------------------------------- |
| App           | Expo SDK 58, Expo Router, TypeScript (strict)               |
| Crypto        | libsodium via `react-native-libsodium` (wasm on web)        |
| Local storage | `expo-sqlite`, storing encrypted rows                       |
| Sync          | Custom encrypted-record sync ([src/lib/sync](src/lib/sync)) |
| Backend       | Supabase (Auth, Postgres + RLS) on the free tier            |

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + publishable key
npm test                     # crypto + sync test suites
npm run typecheck
npm run lint
npx expo start               # press w for web
```

Native modules (libsodium, SQLite) mean iOS and Android need a **development
build**, not Expo Go: `npx expo run:android`, or
`npx eas-cli@latest build --profile development`.

### Supabase setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Run [`supabase/migrations/20261113000000_init.sql`](supabase/migrations/20261113000000_init.sql),
   either in the SQL editor or with `npx supabase db push`.
3. Copy the project URL and **publishable** key into `.env.local`. Never put
   the secret/service-role key in the app.

## Project layout

```
src/app/           Expo Router screens
src/lib/crypto/    E2EE primitives, vault (passphrase + recovery code), space keys
src/lib/sync/      Offline-first sync engine, SQLite store, Supabase transport
supabase/          Database schema, row-level security, RPC functions
docs/              Security model
```

## Code quality

`npm run check` runs everything CI runs (except Semgrep):

| Tool                       | What it enforces                                                              | When            |
| -------------------------- | ----------------------------------------------------------------------------- | --------------- |
| TypeScript (strict)        | Types, including `noUncheckedIndexedAccess`                                   | pre-commit, CI  |
| ESLint + typescript-eslint | Type-aware rules: no floating promises, exhaustive switches, no `any`         | pre-commit, CI  |
| Prettier                   | Formatting                                                                    | pre-commit, CI  |
| Jest + coverage thresholds | Crypto and sync behaviour; coverage can't drop below 90% stmts / 80% branches | pre-push, CI    |
| knip                       | Unused files, exports and dependencies                                        | CI              |
| commitlint                 | [Conventional Commits](https://www.conventionalcommits.org) messages          | commit-msg hook |
| Semgrep                    | Static analysis: security, secrets, React/TS bug patterns                     | CI              |
| expo-doctor, npm audit     | Expo SDK compatibility, known-vulnerable dependencies                         | CI              |
| Dependabot                 | Weekly grouped dependency updates                                             | GitHub          |
