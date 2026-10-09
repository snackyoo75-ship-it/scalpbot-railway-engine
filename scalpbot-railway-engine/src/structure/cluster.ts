import type { Level } from "./levels.js";

export const KEY_LEVEL_MIN_STRENGTH = 1.5;
export const CLUSTER_ATR_MULT = 0.15;
export const AGE_DECAY_BARS = 100;

export type Cluster = {
  price: number;
  low: number;
  high: number;
  strength: number;
  isKey: boolean;
  constituents: Level[];
  /** Latest availability among constituents: the cluster as a whole is knowable from then. */
  availableAt: string;
};

/**
 * Single-linkage clustering: levels sorted by price join the current cluster when their
 * gap to the previous level is <= 0.15 * ATR14. Levels not yet available at asOfIndex are
 * dropped (no lookahead).
 *
 * strength = Σ over UNIQUE sourceIds of exp(-ageBars / 100), ageBars = asOfIndex - availableIndex.
 * Duplicate representations (same sourceId, or identical kind+price) count once, keeping the
 * youngest. Cluster price = strength-weighted mean. isKey when strength >= KEY_LEVEL_MIN_STRENGTH.
 */
export function clusterLevels(levels: Level[], atr: number, asOfIndex: number, minStrength = KEY_LEVEL_MIN_STRENGTH): Cluster[] {
  if (!(atr > 0)) return [];
  const tol = CLUSTER_ATR_MULT * atr;
  const usable = levels.filter((l) => l.availableIndex <= asOfIndex && Number.isFinite(l.price)).sort((a, b) => a.price - b.price);
  const groups: Level[][] = [];
  for (const l of usable) {
    const g = groups.at(-1);
    if (g && l.price - g.at(-1)!.price <= tol) g.push(l);
    else groups.push([l]);
  }
  return groups.map((g) => {
    const unique = new Set<Level>();
    const seen = new Set<string>();
    for (const l of [...g].sort((a, b) => b.availableIndex - a.availableIndex)) {
      const k1 = l.sourceId;
      const k2 = `${l.kind}@${l.price}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      seen.add(k2);
      unique.add(l);
    }
    let strength = 0;
    let wsum = 0;
    for (const l of unique) {
      const w = Math.exp(-(asOfIndex - l.availableIndex) / AGE_DECAY_BARS);
      strength += w;
      wsum += w * l.price;
    }
    return {
      price: wsum / strength,
      low: g[0]!.price,
      high: g.at(-1)!.price,
      strength,
      isKey: strength >= minStrength,
      constituents: g,
      availableAt: g.map((l) => l.availableAt).sort().at(-1)!,
    };
  });
}
