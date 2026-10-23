// Stands in for expo-device under Vitest. `isDevice` only drives a warning in
// lib/push.ts — registration is deliberately not gated on it, because an
// Android emulator with Play Services can receive FCM and is the only surface
// push can be verified on without an Apple account (#518).
export const isDevice = true;
