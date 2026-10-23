// In-memory stand-in for @react-native-async-storage/async-storage under
// Vitest. The real package is a native module and cannot load in Node.
//
// Only the three methods lib/session.ts uses are implemented; anything else
// should fail loudly rather than silently return undefined.
const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  // Test-only escape hatch, so a test can plant a corrupt value or start clean.
  __reset(): void {
    store.clear();
  },
};

export default AsyncStorage;
