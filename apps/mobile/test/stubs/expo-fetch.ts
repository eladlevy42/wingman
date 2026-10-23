// Stands in for expo/fetch under Vitest. The real module is Expo's WinterCG
// fetch and cannot resolve outside an Expo runtime; Node's own fetch has the
// same shape (including a streaming response body), which is all
// streamBarneyMessage needs.
export const fetch = globalThis.fetch;
