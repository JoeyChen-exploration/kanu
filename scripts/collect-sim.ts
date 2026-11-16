// 收集难度模拟（DESIGN 3.6）：只开正规包、只靠自己（不交易），集齐普通图鉴要开多少包。
// 用法：npm run sim:collect [-- --runs 2000 --seed 7]
import { RARITIES, RARITY } from '@kanu/shared/balance';
import { openPack } from '../packages/server/src/game/cards.ts';
import { seeded } from '../packages/server/src/game/rng.ts';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const RUNS = arg('runs', 2000);
const rng = seeded(arg('seed', 7));
const total = RARITIES.reduce((s, r) => s + RARITY[r].perSeries, 0);
const MAX_PACKS = 100_000;

const res = { half: [] as number[], oneUR: [] as number[], noMR: [] as number[], all: [] as number[] };
for (let i = 0; i < RUNS; i += 1) {
  const seen = new Set<string>();
  let packs = 0, pity = 0;
  let half = 0, oneUR = 0, noMR = 0;
  while (seen.size < total && packs < MAX_PACKS) {
    packs += 1;
    const r = openPack(rng, { packType: 'normal', pityCount: pity, serialAvailable: () => true });
    pity = r.pityCount;
    for (const c of r.cards) seen.add(`${c.rarity}-${c.templateIndex}`);
    if (!half && seen.size >= total / 2) half = packs;
    if (!oneUR && seen.has('UR-0')) oneUR = packs;
    if (!noMR && seen.size - (seen.has('MR-0') ? 1 : 0) >= total - 1) noMR = packs;
  }
  res.half.push(half); res.oneUR.push(oneUR); res.noMR.push(noMR); res.all.push(packs);
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (xs: number[], p: number) => sorted(xs)[Math.floor(p * xs.length)]!;
const weeks = (packs: number, perDay: number) => (packs / perDay / 7).toFixed(1);

console.log(`集齐普通图鉴（一个系列 ${total} 张），只开正规包、不交易，${RUNS} 次\n`);
for (const [key, name] of [['half', '集齐一半'], ['oneUR', '拿到某一张指定 UR'], ['noMR', '除 MR 外全齐'], ['all', '整套全齐']] as const) {
  const m = q(res[key], 0.5);
  console.log(`${name.padEnd(10, '　')} 中位 ${String(m).padStart(5)} 包（P25 ${q(res[key], 0.25)}，P75 ${q(res[key], 0.75)}）≈ 每天 2 包 ${weeks(m, 2)} 周，每天 5 包 ${weeks(m, 5)} 周`);
}
