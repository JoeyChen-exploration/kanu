import { afterEach, describe, expect, it } from 'vitest';
import { MIDDLEMAN, POLICE, RARITY, REPUTATION } from '@kanu/shared/balance';
import type { CounterResponse, CustomerView, EndDayResponse, HideoutResponse, OfferResponse, PatrolResolveResponse } from '@kanu/shared/types';
import { mindPrice } from '../src/game/customers.ts';
import { withDetect } from '../src/game/police.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const own = (repo: Repo, ...ids: string[]) => { for (const id of ids) repo.addTech(UID, id, 1); };
const card = (repo: Repo, origin = 'legit', template = 'NEO-17') =>
  repo.insertCard({ templateId: template, ownerId: UID, authenticity: 'real', grade: '9', origin, style: 'standard', serialNo: null, now: NOW, collect: false });
const counter = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
async function closeDay(app: App, h: H) {
  let s = await counter(app, h);
  while (s.current) { await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h }); s = await counter(app, h); }
  return (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
}
function anyCardCustomer(repo: Repo, c: CustomerView, type = 'resident') {
  repo.db.prepare('UPDATE customers SET type = ?, undercover = 0, demand = ? WHERE id = ?')
    .run(type, JSON.stringify({ kind: 'card', rarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'MR'], tag: null, templateId: null, templateName: null }), c.id);
}

describe('路线选择的纯函数', () => {
  it('中间人按基准价的 middlemanPct 收（S3b 提高）；藏匿室里的赃卡按低查出率', () => {
    const c = { id: 1, templateId: 'X', rarity: 'SR' as const, tags: [], style: 'standard', price: 999 };
    expect(mindPrice('middleman', 1, c)).toBe(Math.round(RARITY.SR.basePrice * MIDDLEMAN.basePct));
    expect(mindPrice('middleman', 1, c, 0.5)).toBe(Math.round(RARITY.SR.basePrice * 0.5));
    expect(withDetect([{ id: 1, location: 'inventory' }, { id: 2, location: 'hideout' }], 100_000))
      .toEqual([{ id: 1, detectPpm: POLICE.detectPpm }, { id: 2, detectPpm: 100_000 }]);
  });
});

describe('科技树路线（TECH-TREE 3.5）', () => {
  it('里程碑从流水里数：按时交租（补交不算）、中间人成交、放大镜查验', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    await login(app);
    repo.logCredits(UID, 1, -3800, 'rent', 0, { week: 1 });
    repo.logCredits(UID, 1, -3800, 'rent', 0, { week: 2, late: true });
    repo.logCredits(UID, 1, 100, 'sale', 0, { type: 'middleman' });
    repo.logCredits(UID, 1, 100, 'sale', 0, { type: 'resident' });
    repo.logEvent(UID, 1, 'inspect', { card: 1 });
    expect(repo.questStats(UID)).toMatchObject({ rentPaid: 1, middlemanSales: 1, inspections: 1 });
  });

  it('挂牌营业和后门生意二选一', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 1000000, reputation = 80, shop_owned = 1').run();
    own(repo, 'S1', 'S2', 'C1', 'C2', 'S3a');
    const r = (await app.inject({ method: 'POST', url: '/api/tech/buy', headers: { ...h, ...idem() }, payload: { nodeId: 'S3b' } })).json();
    expect(r.code).toBe('exclusive');
  });

  it('S2 装修：每 7 个营业日信誉 +2，涨到 80 为止', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    own(repo, 'S1', 'S2');
    repo.db.prepare('UPDATE players SET credits = 100000, shop_owned = 1, game_day = 7, day_customer_count = 0, reputation = 50').run();
    await closeDay(app, h);
    expect(repo.getPlayer(UID)!.reputation).toBe(52);
    await closeDay(app, h);
    expect(repo.getPlayer(UID)!.reputation).toBe(52);
    repo.db.prepare('UPDATE players SET game_day = 14, day_customer_count = 0, reputation = 79').run();
    await closeDay(app, h);
    expect(repo.getPlayer(UID)!.reputation).toBe(80);
  });

  it('S3a 挂牌营业：卖真卡信誉 +1，每天最多 3 次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    own(repo, 'S1', 'S2', 'C1', 'C2', 'S3a');
    repo.db.prepare('UPDATE players SET reputation = 50').run();
    for (let i = 0; i < 4; i += 1) {
      const id = card(repo);
      const c = (await counter(app, h)).current!;
      anyCardCustomer(repo, c);
      const r = (await app.inject({ method: 'POST', url: `/api/counter/${c.id}/offer`, headers: { ...h, ...idem() }, payload: { instanceId: id, price: 1 } })).json() as OfferResponse;
      expect(r.outcome).toBe('deal');
    }
    expect(repo.getPlayer(UID)!.reputation).toBe(53);
  });

  it('S3b 后门生意：中间人出价按基准价 50%', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    own(repo, 'S1', 'S2', 'C1', 'C2', 'S3b');
    const id = card(repo, 'legit', 'NEO-13');
    const c = (await counter(app, h)).current!;
    anyCardCustomer(repo, c, 'middleman');
    const want = Math.round(RARITY[repo.cardView(id)!.rarity as 'SR'].basePrice * 0.5);
    // 出价正好等于 50% 基准价：没点 S3b 时（40%）会嫌贵，点了就成交
    const r = (await app.inject({ method: 'POST', url: `/api/counter/${c.id}/offer`, headers: { ...h, ...idem() }, payload: { instanceId: id, price: want } })).json() as OfferResponse;
    expect(r).toMatchObject({ outcome: 'deal', price: want });
  });
});

describe('藏匿室（S3b / S4b）', () => {
  it('没点后门生意就没有；点了 3 格（地下仓 6 格）；里面的卡不能卖，取出来放回卡册', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const ids = [card(repo, 'stolen'), card(repo, 'stolen'), card(repo), card(repo)];
    const hide = (id: number, on = true) => app.inject({ method: 'POST', url: `/api/inventory/${id}/hideout`, headers: h, payload: { on } });
    expect((await hide(ids[0]!)).json().code).toBe('hideout_locked');
    own(repo, 'S1', 'S2', 'C1', 'C2', 'S3b');
    const info = (await app.inject({ method: 'GET', url: '/api/hideout', headers: h })).json() as HideoutResponse;
    expect(info).toMatchObject({ slots: 3, detectPct: 20, cards: [] });
    for (const id of ids.slice(0, 3)) expect((await hide(id)).json().card.location).toBe('hideout');
    expect((await hide(ids[3]!)).json().code).toBe('hideout_full');
    expect(repo.sellableCards(UID).some((c) => ids.slice(0, 3).includes(c.id))).toBe(false);
    const after = (await app.inject({ method: 'GET', url: '/api/hideout', headers: h })).json() as HideoutResponse;
    expect(after.cards).toHaveLength(3);
    expect(findKeys(after, HIDDEN_KEYS)).toEqual([]);
    expect((await hide(ids[0]!, false)).json().card.location).toBe('inventory');
    own(repo, 'S4b');
    expect(((await app.inject({ method: 'GET', url: '/api/hideout', headers: h })).json() as HideoutResponse)).toMatchObject({ slots: 6, detectPct: 10 });
    // 巡查的清单里藏匿室的卡带着位置（按低查出率算）
    expect(repo.stolenCards(UID)).toEqual(expect.arrayContaining([{ id: ids[1], location: 'hideout' }, { id: ids[0], location: 'inventory' }]));
  });
});

describe('S4a 治安备案', () => {
  it('每周第一次交出不扣信誉，同一周第二次照扣', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    own(repo, 'S1', 'S2', 'C1', 'C2', 'S3a', 'S4a');
    repo.db.prepare('UPDATE players SET reputation = 60, game_day = 3').run();
    const patrol = (day: number) => {
      const id = card(repo, 'stolen');
      return Number(repo.db.prepare("INSERT INTO patrols (owner_id, day, cards, bribe, created_at) VALUES (?, ?, ?, 100, 1)").run(UID, day, JSON.stringify([id])).lastInsertRowid);
    };
    const p1 = patrol(3);
    expect((await counter(app, h)).patrol).toMatchObject({ id: p1, surrenderRepLoss: 0 });
    const r1 = (await app.inject({ method: 'POST', url: `/api/patrol/${p1}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'surrender' } })).json() as PatrolResolveResponse;
    expect(r1.reputation).toBe(60);
    const p2 = patrol(5);
    expect((await counter(app, h)).patrol).toMatchObject({ id: p2, surrenderRepLoss: POLICE.surrenderRepLoss });
    const r2 = (await app.inject({ method: 'POST', url: `/api/patrol/${p2}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'surrender' } })).json() as PatrolResolveResponse;
    expect(r2.reputation).toBe(Math.max(REPUTATION.min, 60 - POLICE.surrenderRepLoss));
    // 下一周（第 8 天起）又能免一次
    const p3 = patrol(9);
    expect((await counter(app, h)).patrol).toMatchObject({ id: p3, surrenderRepLoss: 0 });
  });
});
