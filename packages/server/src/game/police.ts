// 便衣和巡查（DESIGN 6、8.3）：纯函数，随机源由调用方传入。
import { POLICE } from '@kanu/shared/balance';
import { chance, type Rng } from './rng.ts';

/**
 * 打烊后来不来查店（patrolPpm × patrolMult）；来了，每张赃卡按自己的查出率（藏匿室里的低）被查出。
 * 不来返回 null，来了没查出返回 []
 */
export function rollPatrol(rng: Rng, stolen: Array<{ id: number; detectPpm: number }>, patrolMult = 1): number[] | null {
  if (!chance(rng, Math.round(POLICE.patrolPpm * patrolMult))) return null;
  return stolen.filter((c) => chance(rng, c.detectPpm)).map((c) => c.id);
}

/** 打点：这些卡市场价合计 × bribePct */
export const bribeCost = (prices: number[]) => Math.round(prices.reduce((s, p) => s + p, 0) * POLICE.bribePct);

/** 卖赃卡给便衣的罚款：max(fineMin, 市场价 × fineMult)，最多罚到 0 */
export const undercoverFine = (marketPrice: number, credits: number) => Math.min(Math.max(0, credits), Math.max(POLICE.fineMin, Math.round(marketPrice * POLICE.fineMult)));

/** 举报卡贩的奖金：他货里赃卡的市场价合计 × reportBonusPct */
export const reportBonus = (stolenPrices: number[]) => Math.round(stolenPrices.reduce((s, p) => s + p, 0) * POLICE.reportBonusPct);

/** 每张赃卡的查出率：藏匿室里的按 hideoutDetectPpm，其余按 POLICE.detectPpm */
export const withDetect = (cards: Array<{ id: number; location: string }>, hideoutDetectPpm: number) =>
  cards.map((c) => ({ id: c.id, detectPpm: c.location === 'hideout' ? hideoutDetectPpm : POLICE.detectPpm }));
