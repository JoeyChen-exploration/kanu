// 收集难度模拟（DESIGN 3.6）：只靠自己（不交易），集齐普通图鉴要开多少包。
// 现阶段 5 种卡包（4 种主题包 + 1 种典藏包），每种 20 张。玩家轮流买这 5 种（各占 1/5）。
// 用法：npm run sim:collect [-- --runs 2000 --seed 7]
import { RARITIES, type Rarity } from '@kanu/shared/balance';
import { loadSeries } from '../packages/server/src/content.ts';
import { openPack } from '../packages/server/src/game/cards.ts';
import { seeded } from '../packages/server/src/game/rng.ts';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const RUNS = arg('runs', 2000);
const rng = seeded(arg('seed', 7));
const MAX_PACKS = 200_000;

const series = loadSeries().map((s) => ({
  ...s,
  byRarity: Object.fromEntries(RARITIES.map((r) => [r, s.cards.filter((c) => c.rarity === r).map((c) => c.id)])) as Record<Rarity, string[]>,
}));
const total = series.reduce((n, s) => n + s.cards.length, 0);

const res = { oneSeries: [] as number[], half: [] as number[], allButTop: [] as number[], all: [] as number[] };
for (let i = 0; i < RUNS; i += 1) {
  const seen = new Set<string>();
  let packs = 0, pity = 0;
  let oneSeries = 0, half = 0, allButTop = 0;
  const topIds = new Set(series.flatMap((s) => [...s.byRarity.LR, ...s.byRarity.MR]));
  while (seen.size < total && packs < MAX_PACKS) {
    const s = series[packs % series.length]!;
    packs += 1;
    const counts = Object.fromEntries(RARITIES.map((r) => [r, s.byRarity[r].length])) as Record<Rarity, number>;
    const r = openPack(rng, { packType: s.kind, pityCount: pity, templateCounts: counts, serialAvailable: () => true });
    pity = r.pityCount;
    for (const c of r.cards) seen.add(s.byRarity[c.rarity][c.templateIndex]!);
    if (!oneSeries && series.some((x) => x.cards.every((c) => seen.has(c.id)))) oneSeries = packs;
    if (!half && seen.size >= total / 2) half = packs;
    if (!allButTop && [...seen].filter((id) => !topIds.has(id)).length >= total - topIds.size) allButTop = packs;
  }
  res.oneSeries.push(oneSeries); res.half.push(half); res.allButTop.push(allButTop); res.all.push(packs);
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (xs: number[], p: number) => sorted(xs)[Math.floor(p * xs.length)]!;
const days = (packs: number, perDay: number) => (packs / perDay).toFixed(0);

console.log(`集齐普通图鉴（${series.length} 种卡包、${total} 张），只靠自己开包、不交易，5 种轮流买，${RUNS} 次\n`);
for (const [key, name] of [['half', '集齐一半'], ['oneSeries', '集齐任意一种卡包'], ['allButTop', '除 LR / MR 外全齐'], ['all', '全部集齐']] as const) {
  const m = q(res[key], 0.5);
  console.log(`${name.padEnd(10, '　')} 中位 ${String(m).padStart(6)} 包（P25 ${q(res[key], 0.25)}，P75 ${q(res[key], 0.75)}）≈ 每天 5 包 ${days(m, 5)} 个营业日`);
}
