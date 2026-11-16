// 故意破产 mock 模拟：保守路线（只开正规包、每天 2 包、每周卖 42 张），比较不同打法一个赛季能"存下"多少信用点。
// "存下" = 兑成金币的 + 投进科技树的（两者破产都不丢）。买店花的 50,000 不算存下（但换来了不交租）。
// 简化：卖价 = 卡的公开价（未评级 0.85 × 风格），不建模顾客溢价、送评、科技树效果。
// 这是 2026-11-17 的一次性 mock，正式的经济模拟是 SRS 里的 scripts/sim.ts（M1）。
// 用法：node scripts/mock/bankruptcy-sim.mjs
//   环境变量 G=租金每周倍率（默认 1.5）、SHOP=买店价（默认 50000）、ONLY=1 只跑"回到第 1 周 + 租金保证金"那组
const RAR = [ // [名字, 正规包概率, 基准价]
  ['N', 0.64, 25], ['R', 0.24, 100], ['SR', 0.08, 400], ['SSR', 0.032, 1500],
  ['UR', 0.006, 6000], ['LR', 0.0015, 20000], ['MR', 0.0005, 60000],
];
const STYLE = [[0.80, 1], [0.12, 1.5], [0.05, 2], [0.025, 3], [0.0045, 6], [0.0005, 10]];
const PACK = 300, PACKS_PER_WEEK = 14, SALES_PER_WEEK = 42, START = 1500, RESTART = 1200, SHOP = Number(process.env.SHOP||50000);
const rent = (n) => Math.round(1000 * Number(process.env.G||1.5) ** (n - 1));

let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (table, pIdx) => { let r = rnd(); for (const row of table) { r -= row[pIdx]; if (r <= 0) return row; } return table.at(-1); };
function card() {
  const [, , base] = pick(RAR, 1);
  const [, mult] = pick(STYLE, 0);
  return Math.round(base * 0.85 * mult);
}

// rule: 破产后周数怎么算。reset = 回到第 1 周（现行）；back2 = 往回退 2 周；keep = 不回退
function season(strategy, rule, reserve = false) {
  let credits = START, week = 1, shop = false, inv = [], saved = 0, bankrupts = 0;
  for (let w = 1; w <= 8; w += 1) {
    // 进货 + 卖卡
    const buy = Math.min(PACKS_PER_WEEK, Math.floor(credits / PACK));
    credits -= buy * PACK;
    for (let i = 0; i < buy * 5; i += 1) inv.push(card());
    inv.sort((a, b) => b - a);
    credits += inv.slice(0, SALES_PER_WEEK).reduce((s, v) => s + v, 0);
    inv = inv.slice(SALES_PER_WEEK);
    const keepForPacks = PACK * PACKS_PER_WEEK; // 留下周进货的钱

    if (strategy === 'shop' && !shop && credits >= SHOP + keepForPacks) { credits -= SHOP; shop = true; }

    if (shop) { // 买了店：多出来的钱存下
      const extra = Math.max(0, credits - keepForPacks); saved += extra; credits -= extra; continue;
    }
    const due = rent(week);
    const dumpNow = (strategy === 'bk-cycle' && week >= 3) || (strategy === 'bk-late' && due > 5000);
    if (dumpNow) {
      // 交租前把钱全存走（兑金币 / 点科技树），然后交不起 → 破产
      const out = reserve ? Math.max(0, credits - due) : credits; saved += out; credits = 0;
      inv = inv.slice(0, 0); // 库存清空（珍藏柜留 1 张，这里忽略不计）
      credits = RESTART; bankrupts += 1;
      week = rule === 'reset' ? 1 : rule === 'back2' ? Math.max(1, week - 2) : week + 1;
      continue;
    }
    if (credits >= due) {
      credits -= due; week += 1;
      if (strategy !== 'shop') { const extra = Math.max(0, credits - keepForPacks); saved += extra; credits -= extra; }
    } else { // 真交不起
      saved += 0; credits = RESTART; inv = []; bankrupts += 1;
      week = rule === 'reset' ? 1 : rule === 'back2' ? Math.max(1, week - 2) : week + 1;
    }
  }
  saved += credits; // 赛季末剩下的也算（假设最后一周兑掉 / 点掉）
  return { saved, shop, bankrupts };
}

const N = 5000;
const strategies = { shop: '攒够就买店', rent: '不买店、一直交租', 'bk-late': '租金超过 5,000 前故意破产', 'bk-cycle': '每到第 3 周就故意破产' };
const weekly = []; for (let i = 0; i < 2000; i += 1) { let v = 0; for (let k = 0; k < 70; k += 1) v += card(); weekly.push(v); }
weekly.sort((a,b)=>a-b); console.log('每周 70 张卡总价值：中位', weekly[1000], '平均', Math.round(weekly.reduce((a,b)=>a+b,0)/2000), '（扣掉卡包 4,200 和租金前）');
for (const [rule, reserve] of [['reset', false], ['back2', false], ['keep', false], ['reset', true]]) {
  console.log(`\n=== 破产后周数：${{ reset: '回到第 1 周（现行）', back2: '往回退 2 周', keep: '不回退' }[rule]}`);
  for (const [k, name] of Object.entries(strategies)) {
    seed = 12345; const xs = [];
    let shops = 0, bks = 0;
    for (let i = 0; i < N; i += 1) { const r = season(k, rule, reserve); xs.push(r.saved); shops += r.shop; bks += r.bankrupts; }
    xs.sort((a, b) => a - b);
    const med = xs[N >> 1], mean = Math.round(xs.reduce((s, v) => s + v, 0) / N);
    console.log(`${name.padEnd(16, '　')} 存下 中位 ${String(med).padStart(7)}  平均 ${String(mean).padStart(7)}  买店率 ${(shops / N * 100).toFixed(0).padStart(3)}%  平均破产 ${(bks / N).toFixed(1)} 次`);
  }
}
