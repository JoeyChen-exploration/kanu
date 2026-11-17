import { afterEach, describe, expect, it } from 'vitest';
import { PACKS, PLAYER, RARITIES, SERIAL_LIMIT, SHOWCASE } from '@kanu/shared/balance';
import type { OpenPackResponse } from '@kanu/shared/types';
import { loadSeries, checkSeries } from '../src/content.ts';
import { announcementFor } from '../src/routes/packs.ts';
import type { Rng } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

const open = async (app: ReturnType<typeof setup>['app'], headers: Record<string, string>, extra: Record<string, string> = idem()) =>
  app.inject({ method: 'POST', url: '/api/packs/open', headers: { ...headers, ...extra }, payload: { packType: 'normal' } });

describe('卡牌内容', () => {
  it('每个系列的稀有度张数和 DESIGN 3.2 一致、编号不重复', () => {
    for (const s of loadSeries()) expect(checkSeries(s)).toEqual([]);
  });
});

describe('开包（FR-PACK-1～5）', () => {
  it('扣 300 信用点，发 5 张卡，写流水，点亮图鉴', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const res = await open(app, h);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OpenPackResponse;
    expect(body.cards).toHaveLength(5);
    expect(body.credits).toBe(PLAYER.startCredits - PACKS.normal.price);
    expect(body.packsLeftToday).toBe(PACKS.normal.dailyLimit - 1);
    expect(repo.getPlayer('123456789012345678')!.credits).toBe(body.credits);
    const log = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id").all() as Array<{ data: string }>;
    expect(JSON.parse(log.at(-1)!.data)).toMatchObject({ delta: -300, why: 'pack', bal: body.credits });
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const ownedIds = new Set(body.cards.map((c) => c.templateId));
    expect(coll.series[0].owned).toBe(ownedIds.size);
  });

  it('同一个幂等 key 重发只扣一次钱、返回同样的卡（NFR-SEC-5）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const key = idem();
    const a = (await open(app, h, key)).json();
    const b = (await open(app, h, key)).json();
    expect(b).toEqual(a);
    expect(repo.getPlayer('123456789012345678')!.credits).toBe(PLAYER.startCredits - PACKS.normal.price);
    expect((repo.db.prepare('SELECT COUNT(*) AS n FROM card_instances').get() as { n: number }).n).toBe(5);
  });

  it('没带幂等 key 拒绝', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/packs/open', headers: h, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_idempotency_key');
  });

  it('信用点不够时拒绝，什么都不改', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100').run();
    const res = await open(app, h);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('insufficient_credits');
    expect((repo.db.prepare('SELECT COUNT(*) AS n FROM card_instances').get() as { n: number }).n).toBe(0);
  });

  it('每个营业日限购 5 包，打烊进入下一天后重新计（FR-PACK-3）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    for (let i = 0; i < PACKS.normal.dailyLimit; i += 1) expect((await open(app, h)).statusCode).toBe(200);
    const sixth = await open(app, h);
    expect(sixth.json().code).toBe('daily_limit');
    repo.advanceDay('123456789012345678');
    expect((await open(app, h)).statusCode).toBe(200);
  });

  it('测试账号（DEV_UNLIMITED_IDS）开包不扣钱、不限购；没开 DEV_AUTH 时不生效', async () => {
    const on = setup({ devAuth: true, unlimited: '123456789012345678' });
    const h = await login(on.app);
    for (let i = 0; i < PACKS.normal.dailyLimit + 2; i += 1) expect((await open(on.app, h)).statusCode).toBe(200);
    expect(on.repo.getPlayer('123456789012345678')!.credits).toBe(PLAYER.startCredits);
    await on.app.close();

    const off = setup({ devAuth: false, unlimited: '123456789012345678' });
    cleanup = () => off.app.close();
    const h2 = await login(off.app);
    const body = (await open(off.app, h2)).json() as OpenPackResponse;
    expect(body.credits).toBe(PLAYER.startCredits - PACKS.normal.price);
  });

  it('保底计数存库：连续 10 包没出 SSR 以上，第 10 包必出（FR-PACK-4）', async () => {
    let t = NOW;
    const { app, repo } = setup({ now: () => t });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, pity_count = 9').run();
    const body = (await open(app, h)).json() as OpenPackResponse;
    expect(body.cards.some((c) => ['SSR', 'UR', 'LR', 'MR'].includes(c.rarity))).toBe(true);
    expect(body.pityCount).toBe(0);
    expect(repo.getPlayer('123456789012345678')!.pity_count).toBe(0);
    t += 1;
  });

  it('编号限定全服最多 50 张、序列号不重复，发完按标准框（FR-PACK-5）', async () => {
    // 每次抽签都给 0：稀有度永远是 N（不够格出编号），所以直接测仓库层的占号
    const { app, repo } = setup();
    cleanup = () => app.close();
    const got: number[] = [];
    repo.db.transaction(() => {
      for (let i = 0; i < SERIAL_LIMIT + 5; i += 1) {
        const n = repo.takeSerial('NEO-053', SERIAL_LIMIT);
        if (n !== null) got.push(n);
      }
    })();
    expect(got).toEqual(Array.from({ length: SERIAL_LIMIT }, (_, i) => i + 1));
    expect(repo.serialLeft('NEO-053', SERIAL_LIMIT)).toBe(false);
  });

  it('开出 UR 以上或编号限定时播报（FR-PACK-6）', () => {
    const base = { id: 1, templateId: 'NEO-048', name: '霓虹龙·影', seriesId: 'NEO', seriesName: '霓虹纪元', tags: [], flavor: null, location: 'inventory' as const, price: 0, createdAt: 0 };
    expect(announcementFor('阿奴', { ...base, rarity: 'UR', style: 'standard', serialNo: null })).toContain('UR「霓虹龙·影」');
    expect(announcementFor('阿奴', { ...base, rarity: 'SSR', style: 'serial', serialNo: 7 })).toContain('07/50');
    expect(announcementFor('阿奴', { ...base, rarity: 'SR', style: 'gold', serialNo: null })).toBeNull();
    expect(announcementFor('*坏*名字_', { ...base, rarity: 'MR', style: 'standard', serialNo: null })).toContain('\\*坏\\*名字\\_');
  });

  it('真的开出 UR 时会调用 notifier', async () => {
    // 稀有度抽签拿到最大的数 → 落在概率表最后一档（MR）；其他抽签给 0
    let call = 0;
    const rng: Rng = { int: (max) => (call++ % 2 === 0 ? max - 1 : 0) };
    const { app, announced } = setup({ rng });
    cleanup = () => app.close();
    const h = await login(app);
    const body = (await open(app, h)).json() as OpenPackResponse;
    expect(body.cards.some((c) => c.rarity === 'MR')).toBe(true);
    expect(announced.length).toBeGreaterThan(0);
  });
});

describe('隐藏属性不出服务器（FR-INV-2、NFR-SEC-2）', () => {
  it('开包、库存、图鉴、珍藏柜、/me 的响应里都没有隐藏属性', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const opened = (await open(app, h)).json();
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const show = (await app.inject({ method: 'POST', url: `/api/inventory/${opened.cards[0].id}/showcase`, headers: h, payload: { on: true } })).json();
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json();
    for (const body of [opened, inv, coll, show, me]) expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });

  it('同一个模板、真实品相不同的两张卡，报价一样（FR-APPR-5）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.insertCard({ templateId: 'NEO-043', ownerId: '123456789012345678', authenticity: 'real', grade: '1', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    repo.insertCard({ templateId: 'NEO-043', ownerId: '123456789012345678', authenticity: 'real', grade: 'BL', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    expect(inv.cards[0].price).toBe(inv.cards[1].price);
  });
});

describe('库存和珍藏柜（FR-INV-1、FR-INV-6）', () => {
  it('分页、按稀有度筛选', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    for (let i = 0; i < 5; i += 1) await open(app, h);
    const all = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    expect(all.total).toBe(25);
    expect(all.cards).toHaveLength(25);
    for (const r of RARITIES) {
      const only = (await app.inject({ method: 'GET', url: `/api/inventory?rarity=${r}`, headers: h })).json();
      expect(only.cards.every((c: { rarity: string }) => c.rarity === r)).toBe(true);
    }
  });

  it('珍藏柜最多 3 格，可以取出', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cards } = (await open(app, h)).json() as OpenPackResponse;
    for (let i = 0; i < SHOWCASE.slots; i += 1) {
      expect((await app.inject({ method: 'POST', url: `/api/inventory/${cards[i]!.id}/showcase`, headers: h, payload: { on: true } })).statusCode).toBe(200);
    }
    const full = await app.inject({ method: 'POST', url: `/api/inventory/${cards[3]!.id}/showcase`, headers: h, payload: { on: true } });
    expect(full.json().code).toBe('showcase_full');
    await app.inject({ method: 'POST', url: `/api/inventory/${cards[0]!.id}/showcase`, headers: h, payload: { on: false } });
    expect(repo.countLocation('123456789012345678', 'showcase')).toBe(SHOWCASE.slots - 1);
  });

  it('不能动别人的卡', async () => {
    const { app, repo } = setup({ devAuth: true });
    cleanup = () => app.close();
    const h = await login(app);
    const { cards } = (await open(app, h)).json() as OpenPackResponse;
    const other = (await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/inventory/${cards[0]!.id}/showcase`, headers: { authorization: `Bearer ${other.session}` }, payload: { on: true } });
    expect(res.statusCode).toBe(404);
    expect(repo.countLocation('123456789012345678', 'showcase')).toBe(0);
  });
});

describe('测试工具：设置信用点', () => {
  it('测试账号可以把信用点设成任意数，写流水；普通账号和没开 DEV_AUTH 时接口不存在', async () => {
    const on = setup({ devAuth: true, unlimited: '123456789012345678' });
    const h = await login(on.app);
    expect((await on.app.inject({ method: 'GET', url: '/api/me', headers: h })).json().devTools).toBe(true);
    const r = await on.app.inject({ method: 'POST', url: '/api/dev/credits', headers: h, payload: { credits: 88888 } });
    expect(r.json()).toMatchObject({ ok: true, credits: 88888 });
    expect(on.repo.getPlayer('123456789012345678')!.credits).toBe(88888);
    const other = (await on.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } })).json();
    expect((await on.app.inject({ method: 'POST', url: '/api/dev/credits', headers: { authorization: `Bearer ${other.session}` }, payload: { credits: 1 } })).statusCode).toBe(404);
    await on.app.close();

    const off = setup({ devAuth: false, unlimited: '123456789012345678' });
    cleanup = () => off.app.close();
    const h2 = await login(off.app);
    expect((await off.app.inject({ method: 'GET', url: '/api/me', headers: h2 })).json().devTools).toBe(false);
    expect((await off.app.inject({ method: 'POST', url: '/api/dev/credits', headers: h2, payload: { credits: 1 } })).statusCode).toBe(404);
  });
});
