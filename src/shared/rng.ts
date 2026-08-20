/**
 * A cheap deterministic PRNG (mulberry32).
 *
 * The whole city is a pure function of one integer seed, which is the single
 * most useful property in this prototype: the server never sends a network
 * over the wire, it sends the seed and both ends build the same city. It also
 * means a bad city can be reported as a number and reproduced exactly.
 */
export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [a, b). */
export const range = (r: Rng, a: number, b: number) => a + r() * (b - a);

/** Integer in [a, b], inclusive both ends. */
export const int = (r: Rng, a: number, b: number) => Math.floor(a + r() * (b - a + 1));

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** Fisher-Yates, in place, so a shuffled order is still seed-reproducible. */
export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
