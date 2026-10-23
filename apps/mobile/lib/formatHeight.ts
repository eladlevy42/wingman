// Renders a centimetre value with its imperial equivalent, e.g. 175 → 175 cm
// (5'9"). The label doubles as the value sent back to the engine, so the stored
// height is a readable string carrying both units.
//
// Ported verbatim from apps/web/src/components/BarneyChat.tsx. It lives in lib/
// here rather than inside the component because the string it produces is what
// gets persisted on the profile — the two clients must format it identically, so
// it is worth testing on its own.
export function formatHeight(cm: number): string {
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${cm} cm (${feet}'${inches}")`;
}
