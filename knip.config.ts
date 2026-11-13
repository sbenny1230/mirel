import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    // Library modules are public entry points, consumed by screens as they land.
    'src/lib/*/index.ts',
    'src/lib/supabase.ts',
    'src/lib/sync/sqlite-store.ts',
    'test/**/*.ts',
  ],
  ignoreDependencies: [
    // Needed for the next milestone (UUIDs, OAuth sign-in); remove once used.
    'expo-crypto',
    'expo-web-browser',
    // False positive: knip's Expo plugin assumes it; app.json doesn't use updates.
    'expo-updates',
  ],
};

export default config;
