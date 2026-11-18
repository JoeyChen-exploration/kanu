import { afterEach, describe, expect, it } from 'vitest';
import { APPRAISAL, PACKS, PLAYER, SHOWCASE, STORE, TECH_NODES, WHOLESALE } from '@kanu/shared/balance';
import type { MeResponse, PhoneResponse, QuestsResponse, ShowcaseResponse, TechBuyResponse, TechResponse } from '@kanu/shared/types';
import { techBlock, techEffects } from '../src/game/tech.ts';
import { inspect } from '../src/game/appraisal.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
const buy = (app: App, h: Record<string, string>, nodeId: string, key = idem()) =>
  app.inject({ method: 'POST', url: '/api/tech/buy', headers: { ...h, ...key }, payload: { nodeId } });
const tree = async (app: App, h: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/tech', headers: h })).json() as TechResponse;
const price = (id: string) => TECH_NODES.find((n) => n.id === id)!.price;

describe('科技树效果（纯函数）', () => {
  it('没点任何节点时是基础值；点了按表加', () => {
    expect(techEffects([])).toEqual({ patience: 0, customersPerDay: 0, errataDetectPpm: APPRAISAL.errataDetect, storePacksPerDay: 0, showcaseSlots: 0, wholesaleDiscount: WHOLESALE.discount });
    const all = techEffects(TECH_NODES.map((n) => n.id));
    expect(all).toEqual({ patience: 1, customersPerDay: 1, errataDetectPpm: 900_000, storePacksPerDay: 1, showcaseSlots: 2, wholesaleDiscount: 0.75 });
  });

  it('放大镜认错版的概率可以传进去', () => {
    const card = { authenticity: 'real', grade: '8', misprint: true };
    const rate = (ppm: number) => { const rng = seeded(3); let n = 0; for (let i = 0; i < 4000; i += 1) if (inspect(rng, card, ppm).errataFound) n += 1; return n / 4000; };
    expect(rate(APPRAISAL.errataDetect)).toBeCloseTo(APPRAISAL.errataDetect / 1e6, 1);
    expect(rate(900_000)).toBeCloseTo(0.9, 1);
  });
});

describe('科技树规则（纯函数）', () => {
  it('二选一、任一前置', () => {
    const ctx = { stats: { packsBought: 0, packsOpened: 0, sales: 0, daysEnded: 0, collected: 0, showcaseLevel: 0, showcaseCards: 0, binders: 0 }, reputation: 50 };
    const a = { ...TECH_NODES.find((n) => n.id === 'C4a')!, soon: undefined, requires: [] };
    expect(techBlock(a, new Set(), ctx)).toBeNull();
    expect(techBlock(a, new Set(['C4b']), ctx)).toBe('exclusive');
    const c5 = { ...TECH_NODES.find((n) => n.id === 'C5')!, soon: undefined };
    expect(techBlock(c5, new Set(['P1']), ctx)).toBe('requires');
    expect(techBlock(c5, new Set(['P1', 'C4b']), ctx)).toBeNull();
  });
});

describe('科技树接口（docs/TECH-TREE.md MVP）', () => {
  it('列出 5 条分支整棵树（32 个节点），开放的是 MVP 6 个；第 2 层要前置和里程碑', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const t = await tree(app, h);
    expect(t.branches.map((b) => b.id)).toEqual(['counter', 'appraisal', 'goods', 'phone', 'store']);
    const nodes = t.branches.flatMap((b) => b.nodes);
    expect(nodes).toHaveLength(32);
    expect(nodes.filter((n) => !n.soon).map((n) => n.id).sort()).toEqual(['A1', 'C1', 'C2', 'G1', 'P1', 'S1']);
    expect(nodes.find((n) => n.id === 'C4a')).toMatchObject({ soon: 2, exclusive: { id: 'C4b' }, unlockable: false });
    expect(nodes.find((n) => n.id === 'C5')!.anyOf.map((r) => r.id)).toEqual(['C4a', 'C4b']);
    // 每个前置都指向树上真有的节点
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) for (const r of [...n.requires, ...n.anyOf]) expect(ids.has(r.id)).toBe(true);
    expect(t.blueprints).toBe(0);
    const c2 = nodes.find((n) => n.id === 'C2')!;
    expect(c2).toMatchObject({ unlockable: false, owned: false, requires: [{ id: 'C1', owned: false }], conditions: [{ current: 0, target: 10, met: false }] });
    expect(nodes.find((n) => n.id === 'C1')!.unlockable).toBe(true);
    expect(findKeys(t, HIDDEN_KEYS)).toEqual([]);
  });

  it('买节点：扣信用点、写流水、幂等；不能重复买；前置 / 条件 / 钱不够都拒绝', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 20000').run();
    expect((await buy(app, h, 'C2')).json().code).toBe('requires');
    const key = idem();
    const r = (await buy(app, h, 'C1', key)).json() as TechBuyResponse;
    expect((await buy(app, h, 'C1', key)).json()).toEqual(r);
    expect(r).toMatchObject({ credits: 20000 - price('C1'), blueprints: 0, converted: price('C1'), node: { id: 'C1', owned: true } });
    expect((await buy(app, h, 'C1')).json().code).toBe('owned');
    expect((await buy(app, h, 'C2')).json().code).toBe('conditions');
    const log = repo.db.prepare("SELECT COUNT(*) AS n FROM events_log WHERE kind = 'credits' AND json_extract(data, '$.why') = 'blueprints'").get() as { n: number };
    expect(log.n).toBe(1);
    repo.db.prepare('UPDATE players SET credits = 100').run();
    expect((await buy(app, h, 'A1')).json().code).toBe('insufficient_credits');
    expect((await buy(app, h, 'Z9')).json().code).toBe('not_found');
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    expect((await buy(app, h, 'C3')).json().code).toBe('soon');
  });

  it('蓝图先用，不够的部分用信用点 1:1 换', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 5000, blueprints = 1000').run();
    const r = (await buy(app, h, 'A1')).json() as TechBuyResponse;
    expect(r).toMatchObject({ credits: 5000 - (price('A1') - 1000), blueprints: 0, converted: price('A1') - 1000 });
  });

  it('成交满 10 笔就能点二号柜台，第二天起每天多来 1 位', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 20000').run();
    await buy(app, h, 'C1');
    for (let i = 0; i < 10; i += 1) repo.logCredits(UID, 1, 10, 'sale', 20000, {});
    expect(((await buy(app, h, 'C2')).json() as TechBuyResponse).node.owned).toBe(true);
    // 同一个随机种子：有 C2 的店一天的顾客数比没有的多 1
    const count = async (withTech: boolean) => {
      const s = setup({ rng: seeded(42) });
      const hh = await login(s.app);
      if (withTech) { s.repo.addTech(UID, 'C2', 1); s.repo.addTech(UID, 'C1', 1); }
      await s.app.inject({ method: 'GET', url: '/api/counter', headers: hh });
      const p = s.repo.getPlayer(UID)!;
      const first = s.repo.customersFor(UID, `g${p.game_day}`)[0]!;
      await s.app.close();
      return { n: p.day_customer_count, patience: first.patience };
    };
    const base = await count(false);
    const tech = await count(true);
    expect(tech.n).toBe(base.n + 1);
    expect(tech.patience).toBe(base.patience + 1);
  });

  it('批发证、保险柜、零号台熟人：限购 +1、珍藏柜 +2 格、批发价 7.5 折', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, phone = 1, showcase_level = 1').run();
    const me = async () => (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json() as MeResponse;
    const slots = async () => ((await app.inject({ method: 'GET', url: '/api/showcase', headers: h })).json() as ShowcaseResponse).status.slots;
    const box = async () => ((await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse).wholesale.offers.find((o) => o.seriesId === 'NEO')!.boxPrice;
    expect((await me()).packsLeftToday).toBe(STORE.packsPerDay);
    expect(await slots()).toBe(SHOWCASE.levels[1]!.slots);
    expect(await box()).toBe(Math.round(PACKS.themed.price * WHOLESALE.discount) * WHOLESALE.boxPacks);
    for (const id of ['G1', 'S1', 'P1']) await buy(app, h, id);
    expect((await me()).packsLeftToday).toBe(STORE.packsPerDay + 1);
    expect(await slots()).toBe(SHOWCASE.levels[1]!.slots + 2);
    expect(await box()).toBe(Math.round(PACKS.themed.price * 0.75) * WHOLESALE.boxPacks);
    // 限购真的放宽了：一次买 6 包
    const r = await app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { seriesId: 'NEO', count: STORE.packsPerDay + 1 } });
    expect(r.json().ok).toBe(true);
    // 没解锁珍藏柜时，保险柜不白给格子
    repo.db.prepare('UPDATE players SET showcase_level = 0').run();
    expect(await slots()).toBe(0);
  });

  it('任务栏追踪节点：显示条件进度，点了之后不再显示', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare(`UPDATE players SET credits = ${PLAYER.startCredits + 10000}`).run();
    const quests = async () => (await app.inject({ method: 'GET', url: '/api/quests', headers: h })).json() as QuestsResponse;
    expect((await quests()).tracked).toBeNull();
    const t = (await app.inject({ method: 'POST', url: '/api/tech/track', headers: h, payload: { nodeId: 'C2' } })).json() as TechResponse;
    expect(t.branches[0]!.nodes.find((n) => n.id === 'C2')!.tracked).toBe(true);
    expect((await quests()).tracked).toMatchObject({ id: 'C2', conditions: [{ target: 10 }] });
    await app.inject({ method: 'POST', url: '/api/tech/track', headers: h, payload: { nodeId: 'C1' } });
    await buy(app, h, 'C1');
    expect((await quests()).tracked).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/tech/track', headers: h, payload: { nodeId: 'nope' } })).json().code).toBe('not_found');
  });
});
