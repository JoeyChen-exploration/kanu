// 房租、抵押、破产（DESIGN 7，FR-RENT-1～6）：纯函数，不碰数据库、不读时钟。
// "第几周"按玩家这一轮自己的营业日算：从头开始（破产）后从 1 重算。
import { PAWN, RENT } from '@kanu/shared/balance';
import { rentForWeek } from './price.ts';

/** 这一轮的第几个营业日（runStartDay = 这一轮开始那天的 game_day） */
export const runDay = (gameDay: number, runStartDay: number) => Math.max(1, gameDay - runStartDay + 1);

/** 今天打烊要不要交租（第 7、14、21……天） */
export const rentDueToday = (gameDay: number, runStartDay: number) => runDay(gameDay, runStartDay) % RENT.everyDays === 0;

/** 今天（或下一个）交租日：哪个营业日、这一轮的第几周、多少钱 */
export function nextRent(gameDay: number, runStartDay: number): { day: number; week: number; amount: number } {
  const d = runDay(gameDay, runStartDay);
  const dueRun = Math.ceil(d / RENT.everyDays) * RENT.everyDays;
  const week = dueRun / RENT.everyDays;
  return { day: gameDay + (dueRun - d), week, amount: rentForWeek(week) };
}

/** 抵押：按市场价 loanPct 折算给钱，days 个营业日内按 redeemPct 赎回 */
export function pawnQuote(marketPrice: number): { loan: number; redeem: number } {
  return { loan: Math.floor(marketPrice * PAWN.loanPct), redeem: Math.ceil(marketPrice * PAWN.redeemPct) };
}

/**
 * 一键抵押（FR-RENT-4）：从市场价最低的卡开始抵押，凑够 need 就停。
 * 返回要抵押的卡（按顺序）和抵押后能拿到多少；不够时 enough = false（全部抵押完还差）。
 */
export function autoPawnPlan<T extends { id: number; price: number }>(cards: T[], need: number): { picks: T[]; total: number; enough: boolean } {
  const sorted = [...cards].sort((a, b) => a.price - b.price || a.id - b.id);
  const picks: T[] = [];
  let total = 0;
  for (const c of sorted) {
    if (total >= need) break;
    const { loan } = pawnQuote(c.price);
    if (loan <= 0) continue;
    picks.push(c);
    total += loan;
  }
  return { picks, total, enough: total >= need };
}
