import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP, RATE_LIMIT } from '@kanu/shared/balance';
import { runBackup } from '../src/backup.ts';
import { openDb } from '../src/db/index.ts';
import { idem, login, setup } from './helpers.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

describe('写接口限流（NFR-SEC-4）', () => {
  it(`每个玩家 1 秒内最多 ${RATE_LIMIT.writesPerSecond} 次写请求，多了回 429；读接口不限`, async () => {
    const { app } = setup({ rateLimit: RATE_LIMIT.writesPerSecond });
    cleanup = () => app.close();
    const h = await login(app);
    const codes: number[] = [];
    for (let i = 0; i < RATE_LIMIT.writesPerSecond + 2; i += 1) {
      codes.push((await app.inject({ method: 'POST', url: '/api/tech/track', headers: { ...h, ...idem() }, payload: { nodeId: 'C1' } })).statusCode);
    }
    expect(codes.slice(0, RATE_LIMIT.writesPerSecond).every((c) => c === 200)).toBe(true);
    expect(codes.slice(RATE_LIMIT.writesPerSecond)).toEqual([429, 429]);
    const r = await app.inject({ method: 'POST', url: '/api/tech/track', headers: { ...h, ...idem() }, payload: { nodeId: 'C1' } });
    expect(r.json()).toMatchObject({ ok: false, code: 'rate_limited' });
    for (let i = 0; i < 10; i += 1) expect((await app.inject({ method: 'GET', url: '/api/me', headers: h })).statusCode).toBe(200);
  });

  it('等过 1 秒又能写', async () => {
    const { app } = setup({ rateLimit: 1 });
    cleanup = () => app.close();
    const h = await login(app);
    const post = () => app.inject({ method: 'POST', url: '/api/tech/track', headers: { ...h, ...idem() }, payload: { nodeId: 'C1' } });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(429);
    await new Promise((r) => setTimeout(r, 1050));
    expect((await post()).statusCode).toBe(200);
  });
});

describe('维护开关（NFR-MAINT-3）', () => {
  it('KANU_DISABLED=1 时写接口一律 503，读接口照常', async () => {
    const { app } = setup({ disabled: true, devAuth: true });
    cleanup = () => app.close();
    const r = await app.inject({ method: 'POST', url: '/api/exchange', payload: { coins: 1 } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'maintenance' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('数据库备份（M7）', () => {
  it('在线备份出一个能打开的库；只留最近几份，不动别的文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanu-backup-'));
    const src = openDb(path.join(dir, 'live.sqlite'));
    src.db.prepare("INSERT INTO players (discord_id, display_name, credits, reputation, created_at) VALUES ('1', '甲', 42, 50, 1)").run();
    const out = path.join(dir, 'backups');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'notes.txt'), '别删我');
    // 先放 BACKUP.keep 份旧备份
    for (let i = 0; i < BACKUP.keep; i += 1) fs.writeFileSync(path.join(out, `kanu-2020-01-${String(i + 1).padStart(2, '0')}-0000.sqlite`), '');
    const r = await runBackup(src, out, Date.UTC(2026, 10, 25, 1));
    expect(r.removed).toEqual(['kanu-2020-01-01-0000.sqlite']);
    const files = fs.readdirSync(out);
    expect(files.filter((f) => f.startsWith('kanu-'))).toHaveLength(BACKUP.keep);
    expect(files).toContain('notes.txt');
    const copy = openDb(r.file);
    expect(copy.getPlayer('1')).toMatchObject({ display_name: '甲', credits: 42 });
    copy.close();
    src.close();
    fs.rmSync(dir, { recursive: true, force: true }); // 测试自己建的临时目录
  });
});
