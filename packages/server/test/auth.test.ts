import { afterEach, describe, expect, it } from 'vitest';
import { PLAYER } from '@kanu/shared/balance';
import { createSessionCodec } from '../src/auth/session.ts';
import { NOW, setup } from './helpers.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

describe('登录（FR-AUTH-2/3/5/6）', () => {
  it('授权码换会话，第一次登录建档 1,500 信用点并写流水', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const res = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'good' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBe('at-123');
    expect(body.session).toMatch(/\./);
    expect(repo.getPlayer('123456789012345678')?.credits).toBe(PLAYER.startCredits);
    const log = repo.db.prepare('SELECT kind, data FROM events_log WHERE discord_id = ?').all('123456789012345678');
    expect(log).toHaveLength(1);
  });

  it('重复登录不重复建档', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'good' } });
    await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'good' } });
    const n = repo.db.prepare('SELECT COUNT(*) AS n FROM events_log').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('不是本服务器成员返回 403', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const res = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'outsider' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: 'wrong_guild' });
  });

  it('缺授权码返回 400', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const res = await app.inject({ method: 'POST', url: '/api/auth/token', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('/api/me（FR-AUTH-4/7）', () => {
  it('没带会话返回 401', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('伪造的会话不认', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const forged = createSessionCodec('another-secret').issue({ id: '123456789012345678', name: 'x', avatar: null }, NOW);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
  });

  it('只认会话里的用户 id，忽略请求里传的 id', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const { session } = (await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'good' } })).json();
    const res = await app.inject({ method: 'GET', url: '/api/me?userId=999', headers: { authorization: `Bearer ${session}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: '123456789012345678', name: '阿奴' },
      credits: PLAYER.startCredits,
      reputation: PLAYER.startReputation,
      weekNo: 1,
      wallet: { coins: 321, opened: true },
    });
  });
});

describe('开发登录', () => {
  it('没开 DEV_AUTH 时不存在', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } });
    expect(res.statusCode).toBe(404);
  });

  it('开了以后能登录，id 带 dev- 前缀', async () => {
    const { app } = setup({ devAuth: true });
    cleanup = () => app.close();
    const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } });
    expect(res.json()).toMatchObject({ ok: true, user: { id: 'dev-bob' }, accessToken: null });
  });
});

describe('维护开关（NFR-MAINT-3）', () => {
  it('KANU_DISABLED=1 时写接口返回 503，读接口照常', async () => {
    const { app } = setup({ disabled: true, devAuth: true });
    cleanup = () => app.close();
    expect((await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'a' } })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ disabled: true });
  });
});
