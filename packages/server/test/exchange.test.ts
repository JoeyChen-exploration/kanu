import { afterEach, describe, expect, it } from 'vitest';
import { EXCHANGE, RENT } from '@kanu/shared/balance';
import type { ExchangeOrderResponse, ExchangeResponse } from '@kanu/shared/types';
import { createWalletClient, type RedeemResult, type WalletClient } from '../src/wallet/client.ts';
import { retryPendingExchanges } from '../src/routes/exchange.ts';
import { sydneyDay, sydneyWeek } from '../src/time.ts';
import { NOW, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type H = Record<string, string>;
const info = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/exchange', headers: h })).json() as ExchangeResponse;
const exchange = (app: App, h: H, coins: unknown, key = idem()) => app.inject({ method: 'POST', url: '/api/exchange', headers: { ...h, ...key }, payload: { coins } as object });

/** 假旺财：mode 切换"入账 / 明确拒绝 / 不知道（404、连不上）"；记下每次调用，入账按 key 幂等 */
function fakeWallet() {
  const state = { mode: 'ok' as 'ok' | 'reject' | 'unknown', calls: [] as string[], credited: new Map<string, number>() };
  const wallet: WalletClient = {
    mode: 'live',
    balance: async () => ({ coins: 0, opened: true }),
    async redeem({ key, coins }): Promise<RedeemResult> {
      state.calls.push(key);
      if (state.mode === 'unknown') return { kind: 'unknown', reason: '旺财回 HTTP 404' };
      if (state.mode === 'reject') return { kind: 'rejected', error: '还没开户（进服满 3 天自动开户）' };
      const replay = state.credited.has(key);
      if (!replay) state.credited.set(key, coins);
      return { kind: 'ok', replay, bal: null };
    },
  };
  return { wallet, state };
}

describe('悉尼周（每周上限从周一 00:00 起算）', () => {
  it('周三、周日深夜算本周一，周一凌晨算新的一周', () => {
    expect(sydneyWeek(Date.UTC(2026, 10, 24, 13))).toBe('2026-11-23'); // 悉尼 11-25 周三 00:00（夏令时 UTC+11）
    expect(sydneyWeek(Date.UTC(2026, 10, 29, 12))).toBe('2026-11-23'); // 悉尼 11-29 周日 23:00
    expect(sydneyWeek(Date.UTC(2026, 10, 29, 13, 30))).toBe('2026-11-30'); // 悉尼 11-30 周一 00:30
    expect(sydneyDay(Date.UTC(2026, 10, 29, 13, 30))).toBe('2026-11-30');
  });
});

describe('旺财钱包客户端：兑换结果分三类（SRS 6.3）', () => {
  const live = (impl: () => Promise<Response>) => createWalletClient({ mode: 'live', port: 1, secret: 's', mockCoins: 0, fetchImpl: impl as unknown as typeof fetch });
  const req = { key: 'cardshop:1-1', userId: UID, coins: 5, week: '2026-11-23' };
  const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('200 + ok → 到账；200 + ok:false → 明确拒绝；404 / 503 / 连不上 / 看不懂 → 不知道', async () => {
    expect(await live(json(200, { ok: true, coins: 5, bal: 505 })).redeem(req)).toEqual({ kind: 'ok', replay: false, bal: 505 });
    expect(await live(json(200, { ok: true, replay: true })).redeem(req)).toMatchObject({ kind: 'ok', replay: true });
    expect(await live(json(200, { ok: false, error: '超过本周兑换上限' })).redeem(req)).toEqual({ kind: 'rejected', error: '超过本周兑换上限' });
    expect((await live(json(404, { ok: false, error: 'not found' })).redeem(req)).kind).toBe('unknown');
    expect((await live(json(503, { ok: false, error: '钱包没开' })).redeem(req)).kind).toBe('unknown');
    expect((await live(json(401, { ok: false })).redeem(req)).kind).toBe('unknown');
    expect((await live(async () => { throw new Error('ECONNREFUSED'); }).redeem(req)).kind).toBe('unknown');
    expect((await live(json(200, { hmm: 1 })).redeem(req)).kind).toBe('unknown');
  });
  it('mock：同一个 key 只入账一次，每周上限', async () => {
    const w = createWalletClient({ mode: 'mock', port: null, secret: null, mockCoins: 100 });
    expect(await w.redeem(req)).toMatchObject({ kind: 'ok', replay: false, bal: 105 });
    expect(await w.redeem(req)).toMatchObject({ kind: 'ok', replay: true });
    expect((await w.redeem({ ...req, key: 'k2', coins: EXCHANGE.weeklyCapCoins })).kind).toBe('rejected');
    expect((await w.balance(UID)).coins).toBe(105);
  });
});

describe('金币兑换接口（FR-EXCH-1～4）', () => {
  it('显示汇率和额度；留出下次摊位费；兑换扣信用点、到账；同一个 key 重发不重复', async () => {
    const { wallet, state } = fakeWallet();
    const { app, repo } = setup({ wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    const before = await info(app, h);
    expect(before).toMatchObject({ rate: EXCHANGE.creditsPerCoin, weeklyCap: EXCHANGE.weeklyCapCoins, weekUsed: 0, reserve: RENT.base, arrears: false });
    expect(before.maxCoins).toBe(Math.floor((10000 - RENT.base) / EXCHANGE.creditsPerCoin));
    expect(before.resetDay > sydneyDay(NOW)).toBe(true);

    const key = idem();
    const r = (await exchange(app, h, 100, key)).json() as ExchangeOrderResponse;
    expect(r).toMatchObject({ credits: 10000 - 100 * EXCHANGE.creditsPerCoin, order: { coins: 100, credits: 1000, status: 'done' } });
    expect((await exchange(app, h, 100, key)).json()).toMatchObject({ order: { id: r.order.id, status: 'done' } });
    expect(repo.getPlayer(UID)!.credits).toBe(9000);
    expect(state.calls).toHaveLength(1);
    const after = await info(app, h);
    expect(after).toMatchObject({ weekUsed: 100, orders: [{ id: r.order.id, status: 'done' }] });

    expect((await exchange(app, h, after.maxCoins + 1)).json().code).toBe('rent_reserve');
    for (const bad of [0, -3, 1.5, '10', null]) expect((await exchange(app, h, bad)).json().code).toBe('bad_coins');
  });

  it('每周上限：pending 和到账的都算，旺财拒绝退回的不算', async () => {
    const { wallet, state } = fakeWallet();
    const { app, repo } = setup({ wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000000').run();
    expect((await exchange(app, h, EXCHANGE.weeklyCapCoins - 10)).json().order.status).toBe('done');
    expect((await exchange(app, h, 11)).json().code).toBe('weekly_cap');
    state.mode = 'reject';
    expect((await exchange(app, h, 10)).json().order.status).toBe('failed');
    expect((await info(app, h)).weekLeft).toBe(10);
  });

  it('旺财明确拒绝：退回信用点、显示原因', async () => {
    const { wallet, state } = fakeWallet();
    state.mode = 'reject';
    const { app, repo } = setup({ wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    const r = (await exchange(app, h, 50)).json() as ExchangeOrderResponse;
    expect(r).toMatchObject({ credits: 10000, order: { status: 'failed', error: '还没开户（进服满 3 天自动开户）' } });
    const refund = repo.db.prepare("SELECT COUNT(*) AS n FROM events_log WHERE kind = 'credits' AND json_extract(data, '$.why') = 'exchange_refund'").get() as { n: number };
    expect(refund.n).toBe(1);
  });

  it('不知道到没到账（404 / 连不上）：保持 pending、不退；定时用同一个 key 重试，到账只算一次', async () => {
    const { wallet, state } = fakeWallet();
    state.mode = 'unknown';
    const { app, repo } = setup({ wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    const r = (await exchange(app, h, 30)).json() as ExchangeOrderResponse;
    expect(r).toMatchObject({ credits: 9700, order: { status: 'pending', error: null } });
    await retryPendingExchanges({ repo, wallet } as never, NOW + 600e3, { error: () => {} });
    expect(repo.getExchange(r.order.id)!.status).toBe('pending');
    state.mode = 'ok';
    await retryPendingExchanges({ repo, wallet } as never, NOW + 1200e3, { error: () => {} });
    expect(repo.getExchange(r.order.id)).toMatchObject({ status: 'done', attempts: 3 });
    // 三次都是同一个 key；之后再跑重试不会再调旺财
    expect(new Set(state.calls).size).toBe(1);
    await retryPendingExchanges({ repo, wallet } as never, NOW + 1800e3, { error: () => {} });
    expect(state.calls).toHaveLength(3);
    expect(repo.getPlayer(UID)!.credits).toBe(9700);
  });

  it('超过 24 小时还是 pending：报警、停止自动重试', async () => {
    const { wallet, state } = fakeWallet();
    state.mode = 'unknown';
    const { app, repo } = setup({ wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    const r = (await exchange(app, h, 30)).json() as ExchangeOrderResponse;
    const errors: string[] = [];
    await retryPendingExchanges({ repo, wallet } as never, NOW + (EXCHANGE.alertHours + 1) * 3600e3, { error: (m) => errors.push(m) });
    expect(errors).toHaveLength(1);
    expect(repo.getExchange(r.order.id)).toMatchObject({ status: 'pending', alerted: 1 });
    const calls = state.calls.length;
    await retryPendingExchanges({ repo, wallet } as never, NOW + (EXCHANGE.alertHours + 2) * 3600e3, { error: (m) => errors.push(m) });
    expect(state.calls.length).toBe(calls);
    expect(errors).toHaveLength(1);
  });

  it('欠租中不能兑换', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, rent_due = 3800, rent_week = 1').run();
    expect((await info(app, h))).toMatchObject({ arrears: true, maxCoins: 0 });
    expect((await exchange(app, h, 10)).json().code).toBe('arrears');
  });
});
