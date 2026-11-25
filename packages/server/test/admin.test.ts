import { afterEach, describe, expect, it } from 'vitest';
import type { MeResponse } from '@kanu/shared/types';
import type { RedeemResult, WalletClient } from '../src/wallet/client.ts';
import { idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type H = Record<string, string>;
const get = (app: App, h: H, url: string) => app.inject({ method: 'GET', url, headers: h });
const post = (app: App, h: H, url: string, payload: unknown = {}, key = idem()) => app.inject({ method: 'POST', url, headers: { ...h, ...key }, payload: payload as object });

describe('管理（FR-ADMIN）', () => {
  it('不是管理员：所有管理接口 403，首页没有管理标记', async () => {
    const { app } = setup({ admin: '999' });
    cleanup = () => app.close();
    const h = await login(app);
    expect(((await get(app, h, '/api/me')).json() as MeResponse).isAdmin).toBe(false);
    for (const url of ['/api/admin/players?q=a', `/api/admin/players/${UID}`, '/api/admin/exchanges']) expect((await get(app, h, url)).statusCode).toBe(403);
    for (const url of ['/api/admin/grant', `/api/admin/players/${UID}/day`, '/api/admin/reload-content', '/api/admin/exchanges/1/retry', '/api/admin/exchanges/1/close']) {
      expect((await post(app, h, url, { userId: UID, credits: 100, reason: 'x' })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/admin/players?q=a' })).statusCode).toBe(401);
  });

  it('查玩家：库存带隐藏属性（只给管理员），最近日志', async () => {
    const { app, repo } = setup({ admin: UID });
    cleanup = () => app.close();
    const h = await login(app);
    expect(((await get(app, h, '/api/me')).json() as MeResponse).isAdmin).toBe(true);
    repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'high_fake', grade: '6', origin: 'stolen', style: 'holo', serialNo: null, now: 1 });
    expect((await get(app, h, '/api/admin/players?q=阿')).json().players[0]).toMatchObject({ discord_id: UID });
    const d = (await get(app, h, `/api/admin/players/${UID}`)).json();
    expect(d.cards[0]).toMatchObject({ template_id: 'NEO-17', authenticity: 'high_fake', grade: '6', origin: 'stolen', style: 'holo' });
    expect(d.events.length).toBeGreaterThan(0);
    expect((await get(app, h, '/api/admin/players/nobody')).statusCode).toBe(404);
  });

  it('发放：信用点和卡、必须写原因、幂等、不能扣成负数', async () => {
    const { app, repo } = setup({ admin: UID });
    cleanup = () => app.close();
    const h = await login(app);
    const start = repo.getPlayer(UID)!.credits;
    expect((await post(app, h, '/api/admin/grant', { userId: UID, credits: 100 })).json().code).toBe('reason');
    const key = idem();
    const r = (await post(app, h, '/api/admin/grant', { userId: UID, credits: 500, templateId: 'NEO-20', style: 'gold', grade: 'BL', count: 2, reason: '内测补偿' }, key)).json();
    expect((await post(app, h, '/api/admin/grant', { userId: UID, credits: 500, templateId: 'NEO-20', count: 2, reason: '内测补偿' }, key)).json()).toEqual(r);
    expect(r).toMatchObject({ ok: true, credits: start + 500 });
    expect(r.cardIds).toHaveLength(2);
    expect(repo.getPlayer(UID)!.credits).toBe(start + 500);
    expect(repo.adminCards(UID).filter((c) => c.template_id === 'NEO-20' && c.style === 'gold' && c.grade === 'BL')).toHaveLength(2);
    expect((await post(app, h, '/api/admin/grant', { userId: UID, credits: -999_999, reason: '扣' })).json().code).toBe('bad_credits');
    expect((await post(app, h, '/api/admin/grant', { userId: UID, templateId: 'NOPE', reason: 'x' })).json().code).toBe('bad_template');
    const log = repo.adminEvents(UID).find((e) => e.kind === 'admin_grant');
    expect(log?.data).toMatchObject({ admin: UID, reason: '内测补偿' });
  });

  it('跳营业日、重新导入卡牌', async () => {
    const { app, repo } = setup({ admin: UID });
    cleanup = () => app.close();
    const h = await login(app);
    expect((await post(app, h, `/api/admin/players/${UID}/day`, { day: 7, reason: '测房租' })).json()).toEqual({ ok: true, day: 7 });
    expect(repo.getPlayer(UID)!.game_day).toBe(7);
    expect((await post(app, h, `/api/admin/players/${UID}/day`, { day: 0 })).json().code).toBe('bad_day');
    const r = (await post(app, h, '/api/admin/reload-content')).json();
    expect(r.series).toEqual(expect.arrayContaining(['NEO', 'ELT']));
    expect(r.templates).toBe(100);
  });

  it('兑换单：卡住的单子手动重试；人工关单（核实到账 / 退信用点）', async () => {
    let mode: 'unknown' | 'ok' = 'unknown';
    const wallet: WalletClient = {
      mode: 'live',
      balance: async () => ({ coins: 0, opened: true }),
      redeem: async (): Promise<RedeemResult> => (mode === 'ok' ? { kind: 'ok', replay: false, bal: 1 } : { kind: 'unknown', reason: '旺财回 HTTP 404' }),
    };
    const { app, repo } = setup({ admin: UID, wallet });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const a = (await post(app, h, '/api/exchange', { coins: 10 })).json().order.id;
    const b = (await post(app, h, '/api/exchange', { coins: 20 })).json().order.id;
    const c = (await post(app, h, '/api/exchange', { coins: 30 })).json().order.id;
    expect((await get(app, h, '/api/admin/exchanges?status=pending')).json().exchanges).toHaveLength(3);
    mode = 'ok';
    expect((await post(app, h, `/api/admin/exchanges/${a}/retry`)).json()).toMatchObject({ result: { kind: 'ok' }, exchange: { status: 'done' } });
    expect((await post(app, h, `/api/admin/exchanges/${a}/retry`)).json().code).toBe('closed');
    expect((await post(app, h, `/api/admin/exchanges/${b}/close`, { outcome: 'done' })).json().code).toBe('reason');
    expect((await post(app, h, `/api/admin/exchanges/${b}/close`, { outcome: 'done', reason: '旺财流水里有' })).json().exchange.status).toBe('done');
    const before = repo.getPlayer(UID)!.credits;
    expect((await post(app, h, `/api/admin/exchanges/${c}/close`, { outcome: 'refund', reason: '旺财流水里没有' })).json().exchange.status).toBe('failed');
    expect(repo.getPlayer(UID)!.credits).toBe(before + 300);
  });
});
