// 价格：市场价、鉴定费、房租（DESIGN 5、7、9.2）。
// publicPrice 只接受公开信息：没封壳就没有分数可读，所以不可能漏出真实品相（FR-APPR-5）。
import { APPRAISAL, GRADE, RARITY, RENT, STYLE, UNGRADED_MULT, type Grade, type Rarity, type Style } from '@kanu/shared/balance';

export interface PublicCardInfo {
  rarity: Rarity;
  /** 看得见的外层风格（假卡可能仿风格，这里只管看到的样子） */
  style: Style;
  /** 封壳后公开的评分；没封壳是 null */
  publicGrade: Grade | null;
}

export interface MarketFactors {
  /** 供需系数，0.5–2.0（第三阶段） */
  supply?: number;
  /** 新闻系数（第二阶段） */
  news?: number;
}

/** 市场价 = 基准价 × 品相系数 × 风格系数 × 供需系数 × 新闻系数 */
export function publicPrice(card: PublicCardInfo, f: MarketFactors = {}): number {
  const gradeMult = card.publicGrade === null ? UNGRADED_MULT : GRADE[card.publicGrade]!.mult;
  return Math.round(RARITY[card.rarity].basePrice * gradeMult * STYLE[card.style].mult * (f.supply ?? 1) * (f.news ?? 1));
}

export function loupeFee(rarity: Rarity): number {
  return Math.round(APPRAISAL.loupe.fixed + RARITY[rarity].basePrice * APPRAISAL.loupe.pct);
}

export function labFee(rarity: Rarity, style: Style): number {
  return Math.max(APPRAISAL.lab.min, Math.round(RARITY[rarity].basePrice * STYLE[style].mult * APPRAISAL.lab.pct));
}

export function gradingFee(rarity: Rarity, style: Style): number {
  return Math.max(APPRAISAL.grading.min, Math.round(RARITY[rarity].basePrice * STYLE[style].mult * APPRAISAL.grading.pct));
}

/** 第 n 周摊位费 = base × growth^(n−1)（每个玩家自己的第几周，破产后从 1 重算） */
export function rentForWeek(week: number): number {
  return Math.round(RENT.base * RENT.growth ** (Math.max(1, week) - 1));
}
