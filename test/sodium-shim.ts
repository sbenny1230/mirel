// Jest stand-in for react-native-libsodium: the same libsodium, compiled to
// wasm/JS, so crypto tests run in Node with real primitives (no mocks).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sodium = require('libsodium-wrappers-sumo');

export const ready: Promise<void> = sodium.ready;
export const loadSumoVersion = (): void => undefined;
export default sodium;
