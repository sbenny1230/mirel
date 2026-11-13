module.exports = {
  '*.{ts,tsx,js,jsx}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{json,md,css,yml,yaml}': ['prettier --write'],
  // Typecheck the whole project (types cross file boundaries) when TS changes.
  '*.{ts,tsx}': () => 'tsc --noEmit',
};
