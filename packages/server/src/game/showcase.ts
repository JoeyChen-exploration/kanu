// 珍藏柜展示分（DESIGN 8.1、FR-INV-11）。纯函数：只看公开的稀有度和风格，不碰真伪、品相。
import { SHOWCASE, STYLE, type Rarity, type Style } from '@kanu/shared/balance';

export interface ShowcaseEffects {
  /** 顾客预算和心理价位乘这个数 */
  priceMult: number;
  /** 每位顾客耐心多几点 */
  patienceBonus: number;
}

export const NO_SHOWCASE_EFFECTS: ShowcaseEffects = { priceMult: 1, patienceBonus: 0 };

/** 珍藏柜的展示分：每张卡 = 稀有度分 × 风格倍数，四舍五入后加起来 */
export function showcaseScore(cards: Array<{ rarity: Rarity; style: Style | string }>): number {
  return cards.reduce((s, c) => s + Math.round(SHOWCASE.rarityScore[c.rarity] * (STYLE[c.style as Style]?.mult ?? 1)), 0);
}

/** 展示分带来的效果：每 pointsPerPct 分 +1%（封顶 maxPriceBonus）；到 patienceAt 分耐心 +patienceBonus */
export function showcaseEffects(score: number): ShowcaseEffects {
  const bonus = Math.min(SHOWCASE.maxPriceBonus, Math.floor(score / SHOWCASE.pointsPerPct) / 100);
  return { priceMult: 1 + bonus, patienceBonus: score >= SHOWCASE.patienceAt ? SHOWCASE.patienceBonus : 0 };
}

/** 第 level 级有几格；超出范围按最高级算 */
export function showcaseSlots(level: number): number {
  const lv = Math.max(0, Math.min(SHOWCASE.levels.length - 1, level));
  return SHOWCASE.levels[lv]!.slots;
}
