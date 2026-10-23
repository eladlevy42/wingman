// Stands in for expo-crypto under Vitest, which runs in Node and has no Expo
// runtime. Only randomUUID is implemented — the one export useBarneyChat uses —
// and it delegates to Node's own crypto so the values are still real UUIDs.
import { randomUUID as nodeRandomUUID } from "node:crypto";

export function randomUUID(): string {
  return nodeRandomUUID();
}
