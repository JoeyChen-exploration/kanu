// 随机源接口。game/ 里的函数只通过它拿随机数（CLAUDE.md 第 4 条）：
// 服务器传 crypto 实现（src/rng.ts），测试和模拟脚本传可复现的 seeded 实现。

export interface Rng {
  /** [0, maxExclusive) 内均匀分布的整数 */
  int(maxExclusive: number): number;
}

/** 可复现的伪随机源（mulberry32），只给测试和模拟用，不能用在线上 */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (max) => Math.floor(next() * max) };
}

export const PPM = 1_000_000;

/** 以 ppm（百万分之几）为单位判定一次：ppm = 250_000 表示 25% */
export const chance = (rng: Rng, ppm: number) => rng.int(PPM) < ppm;

/** 按 ppm 权重从表里抽一项，keys 决定顺序（顺序固定，结果才可复现） */
export function pickPpm<K extends string | number>(rng: Rng, keys: readonly K[], ppmOf: (k: K) => number): K {
  const total = keys.reduce((s, k) => s + ppmOf(k), 0);
  let r = rng.int(total);
  for (const k of keys) {
    r -= ppmOf(k);
    if (r < 0) return k;
  }
  return keys[keys.length - 1]!;
}

/** [min, max) 内的小数，精度 1e-6 */
export const between = (rng: Rng, min: number, max: number) => min + (rng.int(PPM) / PPM) * (max - min);
