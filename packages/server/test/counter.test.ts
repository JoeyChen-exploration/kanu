import { afterEach, describe, expect, it } from 'vitest';
import { COUNTER, CUSTOMER, PLAYER, REPUTATION } from '@kanu/shared/balance';
import type { CounterResponse, EligibleCardsResponse, OfferResponse } from '@kanu/shared/types';
import { evaluateOffer, mindPrice, quickPrice, rollCustomer } from '../src/game/customers.ts';
import { seeded, type Rng } from '../src/game/rng.ts';
import { dayKey } from '../src/db/index.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
const HIDDEN = [...HIDDEN_KEYS, 'float', 'mind'];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

/** 放一张卡和一位指定的顾客，返回它们的 id（心理价位 = 公开价 × 类型系数 × float） */
function seedSale(repo: ReturnType<typeof setup>['repo'], opts: { type?: string; float?: number; template?: string; authenticity?: string; rarities?: string[] } = {}) {
  const cardId = repo.insertCard({ templateId: opts.template ?? 'NEO-17', ownerId: UID, authenticity: opts.authenticity ?? 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
  const type = opts.type ?? 'rich';
  const customerId = repo.insertCustomer({
    owner_id: UID, day_key: dayKey(1), slot: 0, seat: 9, type,
    demand: JSON.stringify({ rarities: opts.rarities ?? ['SR', 'SSR', 'UR', 'LR', 'MR'], tag: null }),
    float: opts.float ?? 1, patience: CUSTOMER[type as 'rich'].patience, line: '你好', budget_low: 1, budget_high: 2, created_at: NOW,
  });
  return { cardId, customerId };
}

const offer = (app: ReturnType<typeof setup>['app'], h: Record<string, string>, customerId: number, instanceId: number, price: number, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/counter/${customerId}/offer`, headers: { ...h, ...key }, payload: { instanceId, price } });

describe('营业日和顾客生成（FR-CTR-1～3）', () => {
  it('第一次打开柜台一次来 6 位，再打开还是同一批', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const a = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    expect(a.day).toBe(1);
    expect(a.customers).toHaveLength(COUNTER.customersPerDay);
    const b = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    expect(b.customers.map((c) => c.id)).toEqual(a.customers.map((c) => c.id));
  });

  it('还有顾客在等不能打烊；都请走后打烊进入下一天，来新的一批，旧顾客不能再接待', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const endDay = () => app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    expect((await endDay()).json().code).toBe('not_open');
    const day1 = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    expect((await endDay()).json().code).toBe('customers_waiting');
    for (const c of day1.customers) await app.inject({ method: 'POST', url: `/api/counter/${c.id}/dismiss`, headers: h });
    const ended = (await endDay()).json();
    expect(ended).toMatchObject({ ok: true, day: 2 });
    expect(repo.getPlayer(UID)!.game_day).toBe(2);
    const day2 = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    expect(day2.day).toBe(2);
    expect(day2.customers).toHaveLength(COUNTER.customersPerDay);
    expect(day2.customers.some((c) => day1.customers.some((x) => x.id === c.id))).toBe(false);
    const old = await app.inject({ method: 'GET', url: `/api/counter/${day1.customers[0]!.id}/cards`, headers: h });
    expect(old.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: h })).json().gameDay).toBe(2);
  });

  it('打烊用幂等 key：同一个 key 重发只推进一天', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const day1 = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    for (const c of day1.customers) await app.inject({ method: 'POST', url: `/api/counter/${c.id}/dismiss`, headers: h });
    const key = idem();
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...key } });
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...key } });
    expect(repo.getPlayer(UID)!.game_day).toBe(2);
  });

  it('MVP 只有四类顾客，需求和预算区间都有', () => {
    const rng = seeded(3);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const c = rollCustomer(rng, { inventory: [], allTags: ['龙'], typicalPrice: () => 100 });
      seen.add(c.type);
      expect(c.budgetLow).toBeLessThan(c.budgetHigh);
      expect(c.float).toBeGreaterThanOrEqual(COUNTER.floatMin);
      expect(c.float).toBeLessThan(COUNTER.floatMax);
    }
    expect([...seen].sort()).toEqual(['collector', 'middleman', 'resident', 'rich']);
  });
});

describe('出价（FR-CTR-4）', () => {
  it('判定：够心理价位成交；高出不多还价扣 1 耐心；太多扣 2；耐心用完走人', () => {
    const rng = seeded(1);
    expect(evaluateOffer(rng, { price: 100, mind: 100, patience: 3 })).toEqual({ kind: 'deal', price: 100 });
    const c = evaluateOffer(rng, { price: 110, mind: 100, patience: 3 });
    expect(c.kind).toBe('counter');
    if (c.kind === 'counter') { expect(c.patience).toBe(2); expect(c.counterPrice).toBeLessThanOrEqual(100); expect(c.counterPrice).toBeGreaterThanOrEqual(90); }
    expect(evaluateOffer(rng, { price: 200, mind: 100, patience: 3 })).toEqual({ kind: 'too_high', patience: 1 });
    expect(evaluateOffer(rng, { price: 200, mind: 100, patience: 2 })).toEqual({ kind: 'left' });
    expect(evaluateOffer(rng, { price: 110, mind: 100, patience: 1 })).toEqual({ kind: 'left' });
  });

  it('按心理价位开价直接成交：加钱、卡没了、写流水', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const card = repo.cardView(cardId)!;
    const mind = mindPrice('rich', 1, { id: cardId, rarity: 'SSR', tags: [], price: card.price });
    const res = (await offer(app, h, customerId, cardId, mind)).json() as OfferResponse;
    expect(res.outcome).toBe('deal');
    expect(res.credits).toBe(PLAYER.startCredits + mind);
    expect(res.customer.status).toBe('sold');
    expect(repo.ownedInstance(UID, cardId)).toBeNull();
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: mind, why: 'sale' });
  });

  it('还价之后按还价成交', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const mind = mindPrice('rich', 1, { id: cardId, rarity: 'SSR', tags: [], price: repo.cardView(cardId)!.price });
    const first = (await offer(app, h, customerId, cardId, Math.floor(mind * 1.1))).json() as OfferResponse;
    expect(first.outcome).toBe('counter');
    expect(first.customer.patience).toBe(CUSTOMER.rich.patience - 1);
    const second = (await offer(app, h, customerId, cardId, first.customer.counterPrice!)).json() as OfferResponse;
    expect(second.outcome).toBe('deal');
  });

  it('开价太高两次，耐心用完走人', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    expect(((await offer(app, h, customerId, cardId, 99_999)).json() as OfferResponse).outcome).toBe('too_high');
    expect(((await offer(app, h, customerId, cardId, 99_999)).json() as OfferResponse).outcome).toBe('left');
    const again = await offer(app, h, customerId, cardId, 1);
    expect(again.json().code).toBe('gone');
    expect(repo.ownedInstance(UID, cardId)).not.toBeNull();
  });

  it('快速出售按浮动下限算，必定成交', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo, { float: 0.85 });
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    const q = cards.cards.find((c) => c.card.id === cardId)!.quickPrice;
    expect(q).toBe(quickPrice('rich', { id: cardId, rarity: 'SSR', tags: [], price: repo.cardView(cardId)!.price }));
    const res = (await app.inject({ method: 'POST', url: `/api/counter/${customerId}/quick`, headers: { ...h, ...idem() }, payload: { instanceId: cardId } })).json() as OfferResponse;
    expect(res.outcome).toBe('deal');
    expect(res.price).toBe(q);
  });

  it('同一个幂等 key 重发只成交一次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const key = idem();
    const a = (await offer(app, h, customerId, cardId, 1, key)).json();
    const b = (await offer(app, h, customerId, cardId, 1, key)).json();
    expect(b).toEqual(a);
    expect(repo.getPlayer(UID)!.credits).toBe(PLAYER.startCredits + 1);
  });

  it('不要的卡、珍藏柜里的卡不能卖', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { customerId } = seedSale(repo);
    const nCard = repo.insertCard({ templateId: 'NEO-01', ownerId: UID, authenticity: 'real', grade: '5', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    expect((await offer(app, h, customerId, nCard, 10)).json().code).toBe('not_wanted');
    const cardId = repo.insertCard({ templateId: 'NEO-18', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    repo.setLocation(cardId, 'showcase');
    expect((await offer(app, h, customerId, cardId, 10)).json().code).toBe('bad_card');
  });
});

describe('识破假卡（FR-CTR-5）', () => {
  it('被识破：不给钱、卡退回、扣信誉、顾客走人', async () => {
    const always: Rng = { int: () => 0 };
    const { app, repo } = setup({ rng: always });
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo, { type: 'collector', authenticity: 'low_fake' });
    const res = (await offer(app, h, customerId, cardId, 1)).json() as OfferResponse;
    expect(res.outcome).toBe('caught');
    expect(res.credits).toBe(PLAYER.startCredits);
    expect(res.reputation).toBe(REPUTATION.start - COUNTER.fakeCaughtRepLoss);
    expect(res.customer.status).toBe('left');
    expect(repo.ownedInstance(UID, cardId)).not.toBeNull();
  });
});

describe('隐藏信息不出服务器（NFR-SEC-2）', () => {
  it('柜台所有响应里都没有心理价位、个人浮动和卡的隐藏属性', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const counter = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
    const { cardId, customerId } = seedSale(repo);
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json();
    const off = (await offer(app, h, customerId, cardId, 99_999)).json();
    const dismiss = (await app.inject({ method: 'POST', url: `/api/counter/${customerId}/dismiss`, headers: h })).json();
    for (const body of [counter, cards, off, dismiss]) expect(findKeys(body, HIDDEN)).toEqual([]);
  });
});
