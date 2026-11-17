import { afterEach, describe, expect, it } from 'vitest';
import { PACKS, PLAYER, RARITIES, SERIAL_LIMIT, SHOWCASE, STORE } from '@kanu/shared/balance';
import type { BuyPacksResponse, OpenPackResponse, SealedPacksResponse, StoreResponse } from '@kanu/shared/types';
import { loadSeries, checkSeries } from '../src/content.ts';
import { announcementFor } from '../src/routes/packs.ts';
import { openPack } from '../src/game/cards.ts';
import { seeded, type Rng } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
const buy = (app: App, h: Record<string, string>, seriesId = 'NEO', count = 1, key = idem()) =>
  app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...key }, payload: { seriesId, count } });
const openId = (app: App, h: Record<string, string>, id: number, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/packs/${id}/open`, headers: { ...h, ...key } });
/** 买一包再拆开 */
async function buyAndOpen(app: App, h: Record<string, string>, seriesId = 'NEO') {
  const b = (await buy(app, h, seriesId)).json() as BuyPacksResponse;
  return (await openId(app, h, b.packIds[0]!)).json() as OpenPackResponse;
}

describe('卡牌内容', () => {
  it('5 种卡包：4 种主题包 + 1 种典藏包，每种 20 张，稀有度构成对得上、编号不重复', () => {
    const all = loadSeries();
    for (const s of all) expect(checkSeries(s)).toEqual([]);
    expect(all.filter((s) => s.kind === 'themed')).toHaveLength(4);
    expect(all.filter((s) => s.kind === 'premium')).toHaveLength(1);
    expect(all.reduce((n, s) => n + s.cards.length, 0)).toBe(100);
    expect(new Set(all.flatMap((s) => s.cards.map((c) => c.id))).size).toBe(100);
  });
});

describe('电脑订货（DESIGN 4）', () => {
  it('列出 5 种卡包、价格和爆率', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const store = (await app.inject({ method: 'GET', url: '/api/store', headers: h })).json() as StoreResponse;
    expect(store.packs).toHaveLength(5);
    expect(store.packs.find((p) => p.seriesId === 'ELT')).toMatchObject({ kind: 'premium', price: PACKS.premium.price, cardCount: 20 });
    expect(store.packs.find((p) => p.seriesId === 'NEO')!.odds.some((o) => o.rarity === 'MR')).toBe(false);
    expect(store.packsLeftToday).toBe(STORE.packsPerDay);
  });

  it('按包买：扣钱、写流水、卡包原封不动进库存', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const r = (await buy(app, h, 'MEC', 2)).json() as BuyPacksResponse;
    expect(r.packIds).toHaveLength(2);
    expect(r.credits).toBe(PLAYER.startCredits - 2 * PACKS.themed.price);
    expect(r.packsLeftToday).toBe(STORE.packsPerDay - 2);
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: -600, why: 'store', bal: r.credits });
    const sealed = (await app.inject({ method: 'GET', url: '/api/packs', headers: h })).json() as SealedPacksResponse;
    expect(sealed.groups).toEqual([{ seriesId: 'MEC', name: '机械义体', kind: 'themed', ids: r.packIds }]);
    expect((repo.db.prepare('SELECT COUNT(*) AS n FROM card_instances').get() as { n: number }).n).toBe(0);
  });

  it('购物车一次买好几种：总价、总包数都对，限购按合计算', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const cart = (items: object[]) => app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { items } });
    const r = (await cart([{ seriesId: 'NEO', count: 2 }, { seriesId: 'ELT', count: 1 }])).json() as BuyPacksResponse;
    expect(r.packIds).toHaveLength(3);
    expect(r.credits).toBe(100000 - 2 * PACKS.themed.price - PACKS.premium.price);
    expect(r.packsLeftToday).toBe(STORE.packsPerDay - 3);
    expect((await cart([{ seriesId: 'MEC', count: 2 }, { seriesId: 'SEA', count: 1 }])).json().code).toBe('daily_limit');
    expect((await cart([{ seriesId: 'MEC', count: 1 }, { seriesId: 'XXX', count: 1 }])).json().code).toBe('bad_pack');
    expect(repo.sealedByOwner(UID)).toHaveLength(3);
  });

  it('典藏包按典藏价扣钱', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    const r = (await buy(app, h, 'ELT')).json() as BuyPacksResponse;
    expect(r.credits).toBe(10000 - PACKS.premium.price);
  });

  it('同一个幂等 key 重发只买一次（NFR-SEC-5）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const key = idem();
    const a = (await buy(app, h, 'NEO', 1, key)).json();
    const b = (await buy(app, h, 'NEO', 1, key)).json();
    expect(b).toEqual(a);
    expect(repo.getPlayer(UID)!.credits).toBe(PLAYER.startCredits - PACKS.themed.price);
  });

  it('没带幂等 key、没有这种卡包、钱不够，都拒绝且什么都不改', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/store/buy', headers: h, payload: { seriesId: 'NEO' } })).json().code).toBe('missing_idempotency_key');
    expect((await buy(app, h, 'XXX')).json().code).toBe('bad_pack');
    repo.db.prepare('UPDATE players SET credits = 100').run();
    expect((await buy(app, h)).json().code).toBe('insufficient_credits');
    expect(repo.sealedByOwner(UID)).toHaveLength(0);
  });

  it('每个营业日限购 5 包（各种合计），打烊进入下一天后重新计（FR-PACK-3）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    expect((await buy(app, h, 'NEO', 3)).statusCode).toBe(200);
    expect((await buy(app, h, 'ELT', 2)).statusCode).toBe(200);
    expect((await buy(app, h, 'SEA', 1)).json().code).toBe('daily_limit');
    repo.advanceDay(UID);
    expect((await buy(app, h, 'SEA', 1)).statusCode).toBe(200);
  });

  it('测试账号（DEV_UNLIMITED_IDS）买包不扣钱、不限购；没开 DEV_AUTH 时不生效', async () => {
    const on = setup({ devAuth: true, unlimited: UID });
    const h = await login(on.app);
    expect((await buy(on.app, h, 'ELT', STORE.packsPerDay + 3)).statusCode).toBe(200);
    expect(on.repo.getPlayer(UID)!.credits).toBe(PLAYER.startCredits);
    await on.app.close();

    const off = setup({ devAuth: false, unlimited: UID });
    cleanup = () => off.app.close();
    const h2 = await login(off.app);
    const r = (await buy(off.app, h2)).json() as BuyPacksResponse;
    expect(r.credits).toBe(PLAYER.startCredits - PACKS.themed.price);
  });
});

describe('拆包（FR-PACK-1～6）', () => {
  it('拆一包：5 张卡都来自这种卡包，卡包从库存消失，点亮图鉴，写日志', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const body = await buyAndOpen(app, h, 'SEA');
    expect(body.cards).toHaveLength(5);
    expect(body.cards.every((c) => c.seriesId === 'SEA')).toBe(true);
    expect(repo.sealedByOwner(UID)).toHaveLength(0);
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const sea = coll.series.find((s: { id: string }) => s.id === 'SEA');
    expect(sea.owned).toBe(new Set(body.cards.map((c) => c.templateId)).size);
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM events_log WHERE kind = 'pack_open'").get()).toEqual({ n: 1 });
  });

  it('同一个幂等 key 重发拆包返回同样的卡；拆过的包不能再拆', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const b = (await buy(app, h)).json() as BuyPacksResponse;
    const key = idem();
    const a = (await openId(app, h, b.packIds[0]!, key)).json();
    expect((await openId(app, h, b.packIds[0]!, key)).json()).toEqual(a);
    expect((repo.db.prepare('SELECT COUNT(*) AS n FROM card_instances').get() as { n: number }).n).toBe(5);
    expect((await openId(app, h, b.packIds[0]!)).json().code).toBe('not_found');
  });

  it('不能拆别人的卡包', async () => {
    const { app } = setup({ devAuth: true });
    cleanup = () => app.close();
    const h = await login(app);
    const b = (await buy(app, h)).json() as BuyPacksResponse;
    const other = (await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } })).json();
    const res = await openId(app, { authorization: `Bearer ${other.session}` }, b.packIds[0]!);
    expect(res.statusCode).toBe(404);
  });

  it('保底计数存库：连续 10 包没出 SSR 以上，第 10 包必出（FR-PACK-4）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, pity_count = 9').run();
    const body = await buyAndOpen(app, h);
    expect(body.cards.some((c) => ['SSR', 'UR', 'LR', 'MR'].includes(c.rarity))).toBe(true);
    expect(body.pityCount).toBe(0);
    expect(repo.getPlayer(UID)!.pity_count).toBe(0);
  });

  it('编号限定全服最多 50 张、序列号不重复，发完按标准框（FR-PACK-5）', () => {
    const { repo } = setup();
    const got: number[] = [];
    repo.db.transaction(() => {
      for (let i = 0; i < SERIAL_LIMIT + 5; i += 1) {
        const n = repo.takeSerial('ELT-20', SERIAL_LIMIT);
        if (n !== null) got.push(n);
      }
    })();
    expect(got).toEqual(Array.from({ length: SERIAL_LIMIT }, (_, i) => i + 1));
    expect(repo.serialLeft('ELT-20', SERIAL_LIMIT)).toBe(false);
  });

  it('开出 UR 以上或编号限定时播报（FR-PACK-6）', () => {
    const base = { id: 1, templateId: 'NEO-19', name: '霓虹龙·影', seriesId: 'NEO', seriesName: '霓虹街头', tags: [], flavor: null, location: 'inventory' as const, binderId: null, looseSinceDay: null, price: 0, createdAt: 0 };
    expect(announcementFor('阿奴', { ...base, rarity: 'UR', style: 'standard', serialNo: null })).toContain('UR「霓虹龙·影」');
    expect(announcementFor('阿奴', { ...base, rarity: 'SSR', style: 'serial', serialNo: 7 })).toContain('07/50');
    expect(announcementFor('阿奴', { ...base, rarity: 'SR', style: 'gold', serialNo: null })).toBeNull();
    expect(announcementFor('*坏*名字_', { ...base, rarity: 'MR', style: 'standard', serialNo: null })).toContain('\\*坏\\*名字\\_');
  });

  it('典藏包真的能开出 MR 并调用播报；主题包永远开不出 MR', async () => {
    // 稀有度抽签拿到最大的数 → 落在概率表最后一档；其他抽签给 0
    let call = 0;
    const rng: Rng = { int: (max) => (call++ % 2 === 0 ? max - 1 : 0) };
    const { app, repo, announced } = setup({ rng });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const premium = await buyAndOpen(app, h, 'ELT');
    expect(premium.cards.some((c) => c.rarity === 'MR')).toBe(true);
    expect(announced.length).toBeGreaterThan(0);
    const themed = await buyAndOpen(app, h, 'NEO');
    expect(themed.cards.some((c) => c.rarity === 'MR')).toBe(false);
  });

  it('电话批发的假卡率覆盖：fakePpm 生效（为电话批发准备）', () => {
    const rng = seeded(5);
    let fake = 0, n = 0;
    for (let i = 0; i < 4000; i += 1) {
      for (const c of openPack(rng, { packType: 'themed', pityCount: 0, fakePpm: 50_000, serialAvailable: () => true }).cards) {
        n += 1;
        if (c.authenticity !== 'real') fake += 1;
      }
    }
    expect(fake / n).toBeCloseTo(0.05, 2);
  });
});

describe('隐藏属性不出服务器（FR-INV-2、NFR-SEC-2）', () => {
  it('进货、卡包、拆包、库存、图鉴、珍藏柜、/me 的响应里都没有隐藏属性', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const store = (await app.inject({ method: 'GET', url: '/api/store', headers: h })).json();
    const bought = (await buy(app, h)).json();
    const sealed = (await app.inject({ method: 'GET', url: '/api/packs', headers: h })).json();
    const opened = (await openId(app, h, bought.packIds[0])).json();
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const show = (await app.inject({ method: 'POST', url: `/api/inventory/${opened.cards[0].id}/showcase`, headers: h, payload: { on: true } })).json();
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json();
    for (const body of [store, bought, sealed, opened, inv, coll, show, me]) expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });

  it('同一个模板、真实品相不同的两张卡，报价一样（FR-APPR-5）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '1', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: 'BL', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
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
    for (let i = 0; i < 5; i += 1) await buyAndOpen(app, h);
    const all = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    expect(all.total).toBe(25);
    for (const r of RARITIES) {
      const only = (await app.inject({ method: 'GET', url: `/api/inventory?rarity=${r}`, headers: h })).json();
      expect(only.cards.every((c: { rarity: string }) => c.rarity === r)).toBe(true);
    }
  });

  it('珍藏柜最多 3 格，可以取出', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cards } = await buyAndOpen(app, h);
    for (let i = 0; i < SHOWCASE.slots; i += 1) {
      expect((await app.inject({ method: 'POST', url: `/api/inventory/${cards[i]!.id}/showcase`, headers: h, payload: { on: true } })).statusCode).toBe(200);
    }
    const full = await app.inject({ method: 'POST', url: `/api/inventory/${cards[3]!.id}/showcase`, headers: h, payload: { on: true } });
    expect(full.json().code).toBe('showcase_full');
    await app.inject({ method: 'POST', url: `/api/inventory/${cards[0]!.id}/showcase`, headers: h, payload: { on: false } });
    expect(repo.countLocation(UID, 'showcase')).toBe(SHOWCASE.slots - 1);
  });

  it('不能动别人的卡', async () => {
    const { app, repo } = setup({ devAuth: true });
    cleanup = () => app.close();
    const h = await login(app);
    const { cards } = await buyAndOpen(app, h);
    const other = (await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/inventory/${cards[0]!.id}/showcase`, headers: { authorization: `Bearer ${other.session}` }, payload: { on: true } });
    expect(res.statusCode).toBe(404);
    expect(repo.countLocation(UID, 'showcase')).toBe(0);
  });
});

describe('内容改版：删掉的旧卡停用', () => {
  it('内容里没有的旧模板标成停用：不出现在图鉴和开包里，玩家手上的卡照常保留', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare("INSERT INTO card_templates (id, series_id, name, rarity, tags) VALUES ('NEO-999', 'NEO', '旧卡', 'N', '[]')").run();
    repo.insertCard({ templateId: 'NEO-999', ownerId: UID, authenticity: 'real', grade: '5', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const { importAllSeries } = await import('../src/content.ts');
    importAllSeries(repo);
    expect(repo.templatesFor('NEO', 'N').some((t) => t.id === 'NEO-999')).toBe(false);
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    expect(coll.series.find((s: { id: string }) => s.id === 'NEO').total).toBe(20);
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory', headers: h })).json();
    expect(inv.cards.some((c: { templateId: string }) => c.templateId === 'NEO-999')).toBe(true);
  });
});

describe('测试工具：设置信用点', () => {
  it('测试账号可以把信用点设成任意数，写流水；普通账号和没开 DEV_AUTH 时接口不存在', async () => {
    const on = setup({ devAuth: true, unlimited: UID });
    const h = await login(on.app);
    expect((await on.app.inject({ method: 'GET', url: '/api/me', headers: h })).json().devTools).toBe(true);
    const r = await on.app.inject({ method: 'POST', url: '/api/dev/credits', headers: h, payload: { credits: 88888 } });
    expect(r.json()).toMatchObject({ ok: true, credits: 88888 });
    expect(on.repo.getPlayer(UID)!.credits).toBe(88888);
    const other = (await on.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { name: 'bob' } })).json();
    expect((await on.app.inject({ method: 'POST', url: '/api/dev/credits', headers: { authorization: `Bearer ${other.session}` }, payload: { credits: 1 } })).statusCode).toBe(404);
    await on.app.close();

    const off = setup({ devAuth: false, unlimited: UID });
    cleanup = () => off.app.close();
    const h2 = await login(off.app);
    expect((await off.app.inject({ method: 'GET', url: '/api/me', headers: h2 })).json().devTools).toBe(false);
    expect((await off.app.inject({ method: 'POST', url: '/api/dev/credits', headers: h2, payload: { credits: 1 } })).statusCode).toBe(404);
  });
});
