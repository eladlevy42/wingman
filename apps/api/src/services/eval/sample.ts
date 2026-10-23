// Deterministic seeded sampling so a run config's `count` cap (issue #250) is
// reproducible across runs sharing the same `seed` — not cryptographic, just
// needs to be stable and give a decent spread.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns `items` unchanged when `count` is unset or covers everything —
// otherwise a `count`-sized, seed-deterministic shuffled subset.
export function sample<T>(items: T[], count: number | undefined, seed: number | undefined): T[] {
  if (count === undefined || count >= items.length) return items;

  const random = mulberry32(seed ?? 0);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}
