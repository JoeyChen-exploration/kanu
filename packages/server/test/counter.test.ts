import { afterEach, describe, expect, it } from 'vitest';
import { COUNTER, CUSTOMER, MVP_TYPES_CHECK, PACKS, PLAYER, REPUTATION } from './counter-helpers.ts';
import type { CounterBinderPageResponse, CounterResponse, EligibleCardsResponse, OfferResponse } from '@kanu/shared/types';
import { evaluateOffer, mindPrice, mindPricePack, quickPrice, rollCustomer, rollCustomerCount, type SellableCard } from '../src/game/customers.ts';
import { seeded, type Rng } from '../src/game/rng.ts';
import { dayKey } from '../src/db/index.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
const HIDDEN = [...HIDDEN_KEYS, 'float', 'mind', 'day_customer_count', 'dayCustomerCount', 'total', 'remaining'];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];

/** 放一张卡和一位指定的顾客，返回它们的 id（心理价位 = 公开价 × 类型系数 × float） */
function seedSale(repo: Repo, opts: { type?: string; float?: number; template?: string; authenticity?: string; demand?: object; seat?: number } = {}) {
  const cardId = repo.insertCard({ templateId: opts.template ?? 'NEO-17', ownerId: UID, authenticity: opts.authenticity ?? 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
  const type = opts.type ?? 'rich';
  const customerId = repo.insertCustomer({
    owner_id: UID, day_key: dayKey(1), slot: 0, seat: opts.seat ?? 99, type,
    demand: JSON.stringify(opts.demand ?? { kind: 'card', rarities: ['SR', 'SSR', 'UR', 'LR', 'MR'], tag: null, templateId: null, templateName: null }),
    float: opts.float ?? 1, patience: CUSTOMER[type as 'rich'].patience, line: '你好', budget_low: 1, budget_high: 2, created_at: NOW,
  });
  // 让"今天一共几位"足够大，测试里卖完不会马上打烊
  repo.setDayCustomerCount(UID, 50);
  return { cardId, customerId };
}

const sellable = (repo: Repo, cardId: number): SellableCard => {
  const v = repo.cardView(cardId)!;
  return { id: v.id, templateId: v.templateId, rarity: v.rarity as SellableCard['rarity'], tags: v.tags, style: v.style, price: v.price };
};

const offer = (app: App, h: Record<string, string>, customerId: number, body: object, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/counter/${customerId}/offer`, headers: { ...h, ...key }, payload: body });
const dismiss = (app: App, h: Record<string, string>, id: number) => app.inject({ method: 'POST', url: `/api/counter/${id}/dismiss`, headers: h });
const counter = async (app: App, h: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;

describe('营业日：顾客一位一位进门（FR-CTR-1～3）', () => {
  it('打开柜台只看到眼前一位；请走后下一位才进门；一天 8–12 位，接待完才能打烊', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const endDay = () => app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    expect((await endDay()).json().code).toBe('not_open');

    let state = await counter(app, h);
    expect(state.day).toBe(1);
    expect(state.current).not.toBeNull();
    expect(state.served).toHaveLength(0);
    expect(state.done).toBe(false);
    // 再打开还是同一位
    expect((await counter(app, h)).current!.id).toBe(state.current!.id);
    expect((await endDay()).json().code).toBe('customers_waiting');

    const seen: number[] = [];
    while (state.current) {
      seen.push(state.current.id);
      const r = (await dismiss(app, h, state.current.id)).json();
      expect(r.customer.status).toBe('dismissed');
      state = await counter(app, h);
      if (state.current) expect(r.next.id).toBe(state.current.id);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(seen.length).toBeLessThanOrEqual(12);
    expect(state.done).toBe(true);
    expect(state.served).toHaveLength(seen.length);

    expect((await endDay()).json()).toMatchObject({ ok: true, day: 2 });
    expect(repo.getPlayer(UID)!.game_day).toBe(2);
    const day2 = await counter(app, h);
    expect(day2.day).toBe(2);
    expect(day2.served).toHaveLength(0);
    expect(seen.includes(day2.current!.id)).toBe(false);
  });

  it('打烊用幂等 key：同一个 key 重发只推进一天', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    let state = await counter(app, h);
    while (state.current) { await dismiss(app, h, state.current.id); state = await counter(app, h); }
    const key = idem();
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...key } });
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...key } });
    expect(repo.getPlayer(UID)!.game_day).toBe(2);
  });

  it('每天来几位按 8–12 位随机，平均 10 位', () => {
    const rng = seeded(9);
    const n = 20_000;
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 0; i < n; i += 1) { const c = rollCustomerCount(rng); sum += c; seen.add(c); }
    expect([...seen].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
    expect(sum / n).toBeCloseTo(COUNTER.customersPerDay, 1);
  });

  it('9 类顾客都会出现；怀旧老顾客点名要一张卡，开箱主播要卡包', () => {
    const rng = seeded(3);
    const seen = new Set<string>();
    const templates = [{ id: 'NEO-01', name: '霓虹路灯', rarity: 'N' as const, tags: ['霓虹'] }];
    const series = [{ id: 'NEO', name: '霓虹街头', price: PACKS.themed.price }];
    for (let i = 0; i < 5000; i += 1) {
      const c = rollCustomer(rng, { inventory: [], packs: [], templates, series, typicalPrice: () => 100 });
      seen.add(c.type);
      expect(c.budgetLow).toBeLessThan(c.budgetHigh);
      if (c.type === 'nostalgic') expect(c.demand).toMatchObject({ kind: 'card', templateId: 'NEO-01' });
      if (c.type === 'streamer') expect(c.demand.kind).toBe('pack');
    }
    expect([...seen].sort()).toEqual([...MVP_TYPES_CHECK].sort());
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
  });

  it('按心理价位开价直接成交：加钱、卡没了、写流水，下一位进门', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const mind = mindPrice('rich', 1, sellable(repo, cardId));
    const res = (await offer(app, h, customerId, { instanceId: cardId, price: mind })).json() as OfferResponse;
    expect(res.outcome).toBe('deal');
    expect(res.credits).toBe(PLAYER.startCredits + mind);
    expect(res.customer.status).toBe('sold');
    expect(res.next).not.toBeNull();
    expect(repo.ownedInstance(UID, cardId)).toBeNull();
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: mind, why: 'sale' });
  });

  it('还价之后按还价成交（还价时下一位不进门）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const mind = mindPrice('rich', 1, sellable(repo, cardId));
    const first = (await offer(app, h, customerId, { instanceId: cardId, price: Math.floor(mind * 1.1) })).json() as OfferResponse;
    expect(first.outcome).toBe('counter');
    expect(first.next).toBeNull();
    expect(first.customer.patience).toBe(CUSTOMER.rich.patience - 1);
    const second = (await offer(app, h, customerId, { instanceId: cardId, price: first.customer.counterPrice })).json() as OfferResponse;
    expect(second.outcome).toBe('deal');
  });

  it('开价太高两次，耐心用完走人', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    expect(((await offer(app, h, customerId, { instanceId: cardId, price: 99_999 })).json() as OfferResponse).outcome).toBe('too_high');
    expect(((await offer(app, h, customerId, { instanceId: cardId, price: 99_999 })).json() as OfferResponse).outcome).toBe('left');
    expect((await offer(app, h, customerId, { instanceId: cardId, price: 1 })).json().code).toBe('gone');
    expect(repo.ownedInstance(UID, cardId)).not.toBeNull();
  });

  it('快速出售按浮动下限算，必定成交', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo, { float: 0.85 });
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    const q = cards.cards.find((c) => c.card.id === cardId)!.quickPrice;
    expect(q).toBe(quickPrice('rich', sellable(repo, cardId)));
    const res = (await app.inject({ method: 'POST', url: `/api/counter/${customerId}/quick`, headers: { ...h, ...idem() }, payload: { instanceId: cardId } })).json() as OfferResponse;
    expect(res.outcome).toBe('deal');
    expect(res.price).toBe(q);
  });

  it('学生对特殊风格的卡多给钱', () => {
    const base = { id: 1, templateId: 'NEO-01', rarity: 'N' as const, tags: [], price: 100 };
    expect(mindPrice('student', 1, { ...base, style: 'holo' })).toBeGreaterThan(mindPrice('student', 1, { ...base, style: 'standard' }));
  });

  it('怀旧老顾客只要他点名的那张卡', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo, { type: 'nostalgic', template: 'NEO-19', demand: { kind: 'card', rarities: ['UR'], tag: null, templateId: 'NEO-19', templateName: '霓虹龙·影' } });
    const other = repo.insertCard({ templateId: 'MEC-19', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    expect(cards.cards.map((c) => c.card.id)).toEqual([cardId]);
    expect((await offer(app, h, customerId, { instanceId: other, price: 1 })).json().code).toBe('not_wanted');
    const counterView = (await counter(app, h)).current!;
    expect(counterView.demand.text).toContain('霓虹龙·影');
  });

  it('柜台翻卡册：每本标出符合的张数；符合的高亮、默认排前面，关掉就按原顺序', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    for (let i = 0; i < 12; i += 1) repo.insertCard({ templateId: 'MEC-19', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const { cardId, customerId } = seedSale(repo, { type: 'nostalgic', template: 'NEO-19', demand: { kind: 'card', rarities: ['UR'], tag: null, templateId: 'NEO-19', templateName: '霓虹龙·影' } });
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    const binderId = repo.bindersOf(UID)[0]!.id;
    // 原顺序是按放进去的先后：目标卡在第 2 页
    repo.db.prepare('UPDATE card_instances SET binder_id = ? WHERE owner_id = ?').run(binderId, UID);

    const stock = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    expect(stock.binders).toEqual([expect.objectContaining({ id: binderId, used: 13, matchCount: 1 })]);
    expect(stock.loose).toEqual({ count: 0, matchCount: 0 });

    const page = async (q: string) => (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/binder/${binderId}?${q}`, headers: h })).json() as CounterBinderPageResponse;
    const first = await page('page=1');
    expect(first.matchFirst).toBe(true);
    expect(first.pages).toBe(2);
    expect(first.cards[0]).toMatchObject({ card: { id: cardId }, match: true });
    expect(first.cards[0]!.quickPrice).toBeGreaterThan(0);
    expect(first.cards.slice(1).every((c) => !c.match && c.quickPrice === null)).toBe(true);

    const natural = await page('page=1&matchFirst=0');
    expect(natural.cards.some((c) => c.match)).toBe(false);
    const p2 = await page('page=2&matchFirst=0');
    expect(p2.cards.find((c) => c.match)?.card.id).toBe(cardId);

    const loose = await app.inject({ method: 'GET', url: `/api/counter/${customerId}/binder/0`, headers: h });
    expect(loose.json()).toMatchObject({ binder: { id: 0 }, cards: [] });
    expect((await app.inject({ method: 'GET', url: `/api/counter/${customerId}/binder/99999`, headers: h })).statusCode).toBe(404);
    for (const body of [stock, first, natural, p2]) expect(findKeys(body, HIDDEN)).toEqual([]);
  });

  it('开箱主播收没拆的卡包，成交后卡包从库存消失', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { customerId } = seedSale(repo, { type: 'streamer', demand: { kind: 'pack', seriesId: null, seriesName: null } });
    const packId = repo.insertSealed(UID, 'ELT', 'store', NOW);
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    expect(cards.packs.map((p) => p.id)).toEqual([packId]);
    const mind = mindPricePack('streamer', 1, { id: packId, seriesId: 'ELT', price: PACKS.premium.price });
    const res = (await offer(app, h, customerId, { packId, price: mind })).json() as OfferResponse;
    expect(res.outcome).toBe('deal');
    expect(res.price).toBe(Math.round(PACKS.premium.price * CUSTOMER.streamer.priceCoef));
    expect(repo.getSealed(UID, packId)).toBeNull();
  });

  it('同一个幂等 key 重发只成交一次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    const key = idem();
    const a = (await offer(app, h, customerId, { instanceId: cardId, price: 1 }, key)).json();
    const b = (await offer(app, h, customerId, { instanceId: cardId, price: 1 }, key)).json();
    expect(b).toEqual(a);
    expect(repo.getPlayer(UID)!.credits).toBe(PLAYER.startCredits + 1);
  });

  it('不要的卡不能卖', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { customerId } = seedSale(repo);
    const nCard = repo.insertCard({ templateId: 'NEO-01', ownerId: UID, authenticity: 'real', grade: '5', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    expect((await offer(app, h, customerId, { instanceId: nCard, price: 10 })).json().code).toBe('not_wanted');
  });

  it('珍藏柜里的卡也能在柜台卖；珍藏柜不占卡册格子', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo);
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    expect(repo.bindersOf(UID)[0]!.used).toBe(1);
    await app.inject({ method: 'POST', url: `/api/inventory/${cardId}/showcase`, headers: h, payload: { on: true } });
    expect(repo.bindersOf(UID)[0]!.used).toBe(0);

    const stock = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json() as EligibleCardsResponse;
    expect(stock.showcase).toEqual({ count: 1, matchCount: 1 });
    expect(stock.loose.matchCount).toBe(0);
    const page = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/binder/showcase`, headers: h })).json() as CounterBinderPageResponse;
    expect(page.cards).toEqual([expect.objectContaining({ card: expect.objectContaining({ id: cardId }), match: true })]);
    expect(findKeys(page, HIDDEN)).toEqual([]);

    const r = (await app.inject({ method: 'POST', url: `/api/counter/${customerId}/quick`, headers: { ...h, ...idem() }, payload: { instanceId: cardId } })).json() as OfferResponse;
    expect(r.outcome).toBe('deal');
    expect(repo.countLocation(UID, 'showcase')).toBe(0);
  });
});

describe('识破假卡（FR-CTR-5）', () => {
  it('被识破：不给钱、卡退回、扣信誉、顾客走人', async () => {
    const always: Rng = { int: () => 0 };
    const { app, repo } = setup({ rng: always });
    cleanup = () => app.close();
    const h = await login(app);
    const { cardId, customerId } = seedSale(repo, { type: 'collector', authenticity: 'low_fake' });
    const res = (await offer(app, h, customerId, { instanceId: cardId, price: 1 })).json() as OfferResponse;
    expect(res.outcome).toBe('caught');
    expect(res.credits).toBe(PLAYER.startCredits);
    expect(res.reputation).toBe(REPUTATION.start - COUNTER.fakeCaughtRepLoss);
    expect(res.customer.status).toBe('left');
    expect(repo.ownedInstance(UID, cardId)).not.toBeNull();
  });
});

describe('隐藏信息不出服务器（NFR-SEC-2）', () => {
  it('柜台所有响应里都没有心理价位、个人浮动、今天一共几位，也没有卡的隐藏属性', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const c = await counter(app, h);
    const { cardId, customerId } = seedSale(repo);
    const cards = (await app.inject({ method: 'GET', url: `/api/counter/${customerId}/cards`, headers: h })).json();
    const off = (await offer(app, h, customerId, { instanceId: cardId, price: 99_999 })).json();
    const dis = (await dismiss(app, h, customerId)).json();
    for (const body of [c, cards, off, dis]) expect(findKeys(body, HIDDEN)).toEqual([]);
  });
});
