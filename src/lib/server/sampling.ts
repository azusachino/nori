/** mulberry32: a small seeded PRNG, uniform in [0, 1). The same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type SampleStrategy = 'random' | 'weak'

/** How much more likely an exercise is to be drawn by the `weak` strategy. */
export const WEAK_WEIGHTS = { incorrect: 4, due: 3, notDue: 1, unattempted: 2 } as const

/**
 * Draws `count` of `pool` without replacement, in draw order. Each item's
 * chance follows `weight` (Efraimidis-Spirakis: the largest u^(1/w) win), so
 * equal weights give a uniform draw. The same seed, pool order and weights
 * give the same draw.
 */
export function sampleWeighted<T>(pool: T[], count: number, seed: number, weight: (item: T) => number): T[] {
  const random = seededRandom(seed)
  return pool
    .map((item, index) => ({ item, index, key: Math.pow(random(), 1 / weight(item)) }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.item)
}
