import { describe, expect, it } from 'vitest';
import { CUSTOMER, CUSTOMER_TYPES, GRADE, GRADES, PACKS, RARITIES, STYLE, STYLES, atLeast } from '@kanu/shared/balance';
import { openPack, rollGrade, rollRarity, rollStyle, rollSubgrades } from '../src/game/cards.ts';
import { gradingFee, labFee, loupeFee, publicPrice, rentForWeek } from '../src/game/price.ts';
import { PPM, seeded } from '../src/game/rng.ts';

const always = () => true;

describe('balance.ts 的概率表', () => {
  it('每张概率表合计正好 100%', () => {
    for (const p of Object.values(PACKS)) expect(RARITIES.reduce((s, r) => s + p.odds[r], 0)).toBe(PPM);
    expect(STYLES.reduce((s, k) => s + STYLE[k].ppm, 0)).toBe(PPM);
    expect(GRADES.reduce((s, g) => s + GRADE[g]!.ppm, 0)).toBe(PPM);
    expect(CUSTOMER_TYPES.reduce((s, t) => s + CUSTOMER[t].ppm, 0)).toBe(PPM);
  });

  it('主题包每种 20 张、没有 MR；典藏包每种 20 张、有 1 张 MR', () => {
    const sum = (t: 'themed' | 'premium') => RARITIES.reduce((s, r) => s + PACKS[t].composition[r], 0);
    expect(sum('themed')).toBe(20);
    expect(sum('premium')).toBe(20);
    expect(PACKS.themed.composition.MR).toBe(0);
    expect(PACKS.themed.odds.MR).toBe(0);
    expect(PACKS.premium.composition.MR).toBe(1);
  });
});

describe('开包（FR-PACK-1）', () => {
  it('稀有度分布在概率表误差范围内（20 万张）', () => {
    const rng = seeded(1);
    const n = 200_000;
    const got = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<string, number>;
    for (let i = 0; i < n; i += 1) got[rollRarity(rng, 'themed')]! += 1;
    for (const r of RARITIES) {
      const p = PACKS.themed.odds[r] / PPM;
      const sd = Math.sqrt(n * p * (1 - p));
      expect(Math.abs(got[r]! - n * p)).toBeLessThan(5 * sd + 1);
    }
  });

  it('同一个种子结果完全一样（纯函数、可复现）', () => {
    const a = openPack(seeded(42), { packType: 'themed', pityCount: 0, serialAvailable: always });
    const b = openPack(seeded(42), { packType: 'themed', pityCount: 0, serialAvailable: always });
    expect(a).toEqual(b);
  });

  it('主题包全是真卡、正规来源', () => {
    const rng = seeded(7);
    for (let i = 0; i < 2000; i += 1) {
      for (const c of openPack(rng, { packType: 'themed', pityCount: 0, serialAvailable: always }).cards) {
        expect(c.authenticity).toBe('real');
        expect(c.origin).toBe('legit');
      }
    }
  });

  it('黑市卡包大约 25% 假卡、20% 赃物', () => {
    const rng = seeded(8);
    let fake = 0, stolen = 0, n = 0;
    for (let i = 0; i < 20_000; i += 1) {
      for (const c of openPack(rng, { packType: 'black', pityCount: 0, serialAvailable: always }).cards) {
        n += 1;
        if (c.authenticity !== 'real') fake += 1;
        if (c.origin === 'stolen') stolen += 1;
      }
    }
    expect(fake / n).toBeCloseTo(0.25, 2);
    expect(stolen / n).toBeCloseTo(0.2, 2);
  });
});

describe('外层风格（DESIGN 3.4）', () => {
  it('稀有度不够的受限风格按标准框处理', () => {
    const rng = seeded(3);
    for (let i = 0; i < 100_000; i += 1) {
      const n = rollStyle(rng, 'N', { allowSerial: true });
      expect(n === 'dark' || n === 'serial').toBe(false);
      const sr = rollStyle(rng, 'SR', { allowSerial: true });
      expect(sr).not.toBe('serial');
    }
  });

  it('编号限定发完了就不再出（FR-PACK-5）', () => {
    const rng = seeded(4);
    for (let i = 0; i < 200_000; i += 1) expect(rollStyle(rng, 'MR', { allowSerial: false })).not.toBe('serial');
  });

  it('够格时编号限定确实会出', () => {
    const rng = seeded(5);
    let serial = 0;
    for (let i = 0; i < 200_000; i += 1) if (rollStyle(rng, 'UR', { allowSerial: true }) === 'serial') serial += 1;
    expect(serial).toBeGreaterThan(50);
  });
});

describe('保底（FR-PACK-4）', () => {
  it('没出 SSR 以上时计数 +1，出了清零', () => {
    const rng = seeded(11);
    for (let i = 0; i < 5000; i += 1) {
      const r = openPack(rng, { packType: 'themed', pityCount: 3, serialAvailable: always });
      const hit = r.cards.some((c) => atLeast(c.rarity, 'SSR'));
      expect(r.pityCount).toBe(hit ? 0 : 4);
    }
  });

  it('计数到第 10 包必出 SSR 以上，保底那张不是编号限定', () => {
    const rng = seeded(12);
    let triggered = 0;
    for (let i = 0; i < 5000; i += 1) {
      const r = openPack(rng, { packType: 'themed', pityCount: 9, serialAvailable: always });
      expect(r.cards.some((c) => atLeast(c.rarity, 'SSR'))).toBe(true);
      expect(r.pityCount).toBe(0);
      if (r.pityTriggered) {
        triggered += 1;
        const forced = r.cards.filter((c) => c.rarity === 'SSR');
        expect(forced.length).toBeGreaterThan(0);
      }
    }
    expect(triggered).toBeGreaterThan(0);
  });

  it('黑市卡包不吃保底', () => {
    const r = openPack(seeded(13), { packType: 'black', pityCount: 9, serialAvailable: always });
    expect(r.pityCount).toBe(9);
    expect(r.pityTriggered).toBe(false);
  });
});

describe('品相和评级（DESIGN 5.2）', () => {
  it('评分分布在误差范围内', () => {
    const rng = seeded(21);
    const n = 200_000;
    const got = new Map<string, number>();
    for (let i = 0; i < n; i += 1) { const g = String(rollGrade(rng)); got.set(g, (got.get(g) ?? 0) + 1); }
    for (const g of GRADES) {
      const p = GRADE[g]!.ppm / PPM;
      expect(Math.abs((got.get(String(g)) ?? 0) - n * p)).toBeLessThan(5 * Math.sqrt(n * p * (1 - p)) + 1);
    }
  });

  it('黑标四项全 10，普通 10 分不会四项全 10，分项都在 1–10 之间', () => {
    const rng = seeded(22);
    expect(rollSubgrades(rng, 'BL')).toEqual([10, 10, 10, 10]);
    for (let i = 0; i < 2000; i += 1) {
      expect(rollSubgrades(rng, 10).every((x) => x === 10)).toBe(false);
      for (const x of rollSubgrades(rng, 1)) expect(x).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('价格（DESIGN 5、7、9.2）', () => {
  it('没封壳的卡按未评级系数 0.85，和真实品相无关（FR-APPR-5）', () => {
    expect(publicPrice({ rarity: 'SSR', style: 'standard', publicGrade: null })).toBe(1870);
    expect(publicPrice({ rarity: 'SSR', style: 'gold', publicGrade: null })).toBe(5610);
  });

  it('封壳卡按评级系数', () => {
    expect(publicPrice({ rarity: 'UR', style: 'standard', publicGrade: 10 })).toBe(30_000);
    expect(publicPrice({ rarity: 'N', style: 'standard', publicGrade: 'BL' })).toBe(375);
  });

  it('鉴定费', () => {
    expect(loupeFee('SSR')).toBe(125);
    expect(labFee('N', 'standard')).toBe(10);
    expect(gradingFee('UR', 'gold')).toBe(2700);
  });

  it('摊位费第 8 周封顶（软赛季，周数不清零）', () => {
    expect(rentForWeek(9)).toBe(rentForWeek(8));
    expect(rentForWeek(30)).toBe(15286);
  });

  it('摊位费按 DESIGN 7 的表（2026-11-17 新手任务上线后重调）', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(rentForWeek)).toEqual([3800, 4636, 5656, 6900, 8418, 10270, 12530, 15286]);
  });
});
