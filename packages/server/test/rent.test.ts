import { afterEach, describe, expect, it } from 'vitest';
import { PAWN, PLAYER, RENT, SHOP_PRICE } from '@kanu/shared/balance';
import type { CounterResponse, EndDayResponse, MeResponse, RentActionResponse, RentResponse } from '@kanu/shared/types';
import { autoPawnPlan, nextRent, pawnQuote, rentDueToday, runDay } from '../src/game/rent.ts';
import { rentForWeek } from '../src/game/price.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const add = (repo: Repo, template = 'NEO-17') =>
  repo.insertCard({ templateId: template, ownerId: UID, authenticity: 'real', grade: '9', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
/** 把今天的客人都请走再打烊 */
async function closeDay(app: App, h: H) {
  let state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
  while (state.current) {
    await app.inject({ method: 'POST', url: `/api/counter/${state.current.id}/dismiss`, headers: h });
    state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
  }
  return (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
}
const rent = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/rent', headers: h })).json() as RentResponse;
const post = (app: App, h: H, url: string, payload: unknown = {}, key = idem()) => app.inject({ method: 'POST', url, headers: { ...h, ...key }, payload: payload as object });
/** 直接跳到这一轮的第 day 天（还没开门） */
const goto = (repo: Repo, day: number) => repo.db.prepare('UPDATE players SET game_day = ?, day_customer_count = 0').run(day);

describe('房租（纯函数，DESIGN 7）', () => {
  it('每 7 个营业日交一次，周数按这一轮自己的营业日算', () => {
    expect(runDay(1, 1)).toBe(1);
    expect([6, 7, 8, 14].map((d) => rentDueToday(d, 1))).toEqual([false, true, false, true]);
    expect(nextRent(1, 1)).toEqual({ day: 7, week: 1, amount: RENT.base });
    expect(nextRent(7, 1)).toEqual({ day: 7, week: 1, amount: RENT.base });
    expect(nextRent(8, 1)).toEqual({ day: 14, week: 2, amount: rentForWeek(2) });
    // 破产后从第 20 天重开：第 26 天交第 1 周
    expect(nextRent(20, 20)).toEqual({ day: 26, week: 1, amount: RENT.base });
    expect(rentForWeek(20)).toBe(rentForWeek(RENT.capWeek));
  });

  it('抵押按市场价 50% 给钱、60% 赎回；一键抵押从最便宜的开始，凑够就停', () => {
    expect(pawnQuote(1000)).toEqual({ loan: 1000 * PAWN.loanPct, redeem: 1000 * PAWN.redeemPct });
    const cards = [{ id: 1, price: 800 }, { id: 2, price: 100 }, { id: 3, price: 400 }, { id: 4, price: 2000 }];
    expect(autoPawnPlan(cards, 200)).toMatchObject({ picks: [{ id: 2 }, { id: 3 }], total: 250, enough: true });
    expect(autoPawnPlan(cards, 99_999)).toMatchObject({ enough: false, total: 1650 });
  });
});

describe('房租接口（FR-RENT-1～6）', () => {
  it('交租日打烊时钱够：自动扣摊位费、进入下一天；首页显示下次交租', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json() as MeResponse;
    expect(me.rent).toEqual({ owned: false, arrears: null, next: { day: 7, week: 1, amount: RENT.base }, shopPrice: SHOP_PRICE });
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    goto(repo, 6);
    expect((await closeDay(app, h)).rentPaid).toBeNull();
    const end = await closeDay(app, h);
    expect(end).toMatchObject({ day: 8, rentPaid: { amount: RENT.base, week: 1 } });
    expect(repo.getPlayer(UID)!.credits).toBe(10000 - RENT.base);
    expect((await rent(app, h)).rent.next).toEqual({ day: 14, week: 2, amount: rentForWeek(2) });
  });

  it('钱不够：进入欠租，不进下一天、柜台关门、不能换蓝图；一键抵押凑够后交租，进入下一天', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    for (let i = 0; i < 8; i += 1) add(repo, 'NEO-17');
    repo.db.prepare('UPDATE players SET credits = 100').run();
    goto(repo, 7);
    const end = await closeDay(app, h);
    expect(end).toMatchObject({ day: 7, arrears: { amount: RENT.base, week: 1 } });
    // 再按一次打烊：还是欠租，不重复扣、不进下一天
    expect((await post(app, h, '/api/day/end')).json()).toMatchObject({ day: 7, arrears: { amount: RENT.base } });
    expect(((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse)).toMatchObject({ day: 7, current: null, arrears: { amount: RENT.base } });
    repo.db.prepare('UPDATE players SET credits = 20000').run();
    expect((await post(app, h, '/api/tech/buy', { nodeId: 'C1' })).json().code).toBe('rent_reserve');
    repo.db.prepare('UPDATE players SET credits = 100').run();

    expect((await post(app, h, '/api/rent/pay')).json().code).toBe('insufficient_credits');
    const before = await rent(app, h);
    const cheapest = before.pawnable[0]!;
    const key = idem();
    const r = (await post(app, h, '/api/rent/pawn-all', {}, key)).json() as RentActionResponse;
    expect((await post(app, h, '/api/rent/pawn-all', {}, key)).json()).toEqual(r);
    expect(r.notEnough).toBe(false);
    expect(r.cards![0]!.id).toBe(cheapest.card.id);
    expect(r.credits).toBeGreaterThanOrEqual(RENT.base);
    const credits = r.credits;
    const paid = (await post(app, h, '/api/rent/pay')).json() as RentActionResponse;
    expect(paid).toMatchObject({ day: 8, credits: credits - RENT.base, rent: { arrears: null } });
    expect(repo.getPlayer(UID)!.game_day).toBe(8);
    expect(findKeys(r, HIDDEN_KEYS)).toEqual([]);
    expect(findKeys(before, HIDDEN_KEYS)).toEqual([]);
  });

  it('抵押和赎回：抵押的卡不能卖、不在卡册；7 天内按 60% 赎回；珍藏柜的卡不能抵押', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo);
    const shown = add(repo, 'NEO-13');
    repo.setLocation(shown, 'showcase');
    repo.db.prepare('UPDATE players SET credits = 0').run();
    const list = await rent(app, h);
    expect(list.pawnable.map((p) => p.card.id)).toEqual([id]);
    expect((await post(app, h, '/api/rent/pawn', { cardId: shown })).json().code).toBe('not_pawnable');
    const quote = list.pawnable[0]!;
    const r = (await post(app, h, '/api/rent/pawn', { cardId: id })).json() as RentActionResponse;
    expect(r.credits).toBe(quote.loan);
    expect(repo.sellableCards(UID).some((c) => c.id === id)).toBe(false);
    const pawns = (await rent(app, h)).pawns;
    expect(pawns).toMatchObject([{ card: { id }, loan: quote.loan, redeem: quote.redeem, dueDay: 1 + PAWN.days }]);
    expect((await post(app, h, `/api/rent/redeem/${pawns[0]!.id}`)).json().code).toBe('insufficient_credits');
    repo.db.prepare(`UPDATE players SET credits = ${quote.redeem}`).run();
    const back = (await post(app, h, `/api/rent/redeem/${pawns[0]!.id}`)).json() as RentActionResponse;
    expect(back.credits).toBe(0);
    expect(back.cards![0]!.id).toBe(id);
    expect(repo.sellableCards(UID).some((c) => c.id === id)).toBe(true);
    expect((await rent(app, h)).pawns).toEqual([]);
  });

  it('过了赎回期，抵押的卡归房东', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const id = add(repo);
    await post(app, h, '/api/rent/pawn', { cardId: id });
    goto(repo, 1 + PAWN.days);
    const end = await closeDay(app, h);
    expect(end.forfeited).toBe(1);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM card_instances WHERE id = ?').get(id)).toEqual({ n: 0 });
    expect((await rent(app, h)).pawns).toEqual([]);
  });

  it('从头开始：只留珍藏柜的卡，1,200 信用点重开，周数从 1 重算；要确认', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    add(repo);
    const shown = add(repo, 'NEO-13');
    repo.setLocation(shown, 'showcase');
    repo.insertSealed(UID, 'NEO', 'store', NOW);
    repo.db.prepare('UPDATE players SET credits = 50').run();
    goto(repo, 7);
    await closeDay(app, h);
    expect((await post(app, h, '/api/rent/bankrupt', {})).json().code).toBe('confirm');
    const r = (await post(app, h, '/api/rent/bankrupt', { confirm: true })).json() as RentActionResponse;
    expect(r).toMatchObject({ day: 8, credits: PLAYER.restartCredits, rent: { arrears: null, next: { day: 14, week: 1, amount: RENT.base } } });
    const left = repo.db.prepare('SELECT id, location FROM card_instances WHERE owner_id = ?').all(UID);
    expect(left).toEqual([{ id: shown, location: 'showcase' }]);
    expect(repo.sealedByOwner(UID)).toHaveLength(0);
  });

  it('买下店铺：不再交租；欠租时不能买', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare(`UPDATE players SET credits = ${SHOP_PRICE - 1}`).run();
    expect((await post(app, h, '/api/shop/buy')).json().code).toBe('insufficient_credits');
    repo.db.prepare(`UPDATE players SET credits = ${SHOP_PRICE + 500}`).run();
    const r = (await post(app, h, '/api/shop/buy')).json() as RentActionResponse;
    expect(r).toMatchObject({ credits: 500, rent: { owned: true, next: null } });
    expect((await post(app, h, '/api/shop/buy')).json().code).toBe('owned');
    goto(repo, 7);
    expect((await closeDay(app, h))).toMatchObject({ day: 8, rentPaid: null });
    expect(repo.getPlayer(UID)!.credits).toBe(500);
  });
});
