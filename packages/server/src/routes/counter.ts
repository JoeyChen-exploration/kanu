// 柜台（SRS FR-CTR-1～5、7）：
//   GET  /api/counter                 本营业日的顾客（第一次打开时一次生成 6 位，不靠定时任务）
//   GET  /api/counter/:id/cards       这位顾客能接受的卡 + 每张的快速出售价
//   POST /api/counter/:id/offer       { instanceId, price } 开价
//   POST /api/counter/:id/quick       { instanceId } 快速出售（按浮动下限算，必定成交）
//   POST /api/counter/:id/dismiss     请顾客离开
//   POST /api/day/end                 打烊：顾客都接待完（或请走）后进入下一个营业日
// 营业日由玩家自己推进（2026-11-17 改，学深空当铺），不按悉尼时间。
// 写操作都在一个事务里，要求幂等 key。心理价位和个人浮动永远不出现在响应里。
import type { FastifyInstance } from 'fastify';
import { COUNTER, CUSTOMER, PACKS, RARITIES, RARITY, REPUTATION, type CustomerType, type Rarity } from '@kanu/shared/balance';
import type { CardView, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, OfferResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { dayKey, type CustomerRow } from '../db/index.ts';
import { detectFake, evaluateOffer, matches, mindPrice, quickPrice, rollCustomer, type Demand, type SellableCard } from '../game/customers.ts';
import { loadLines, type LineEvent } from '../content.ts';

const lines = loadLines();

/** 每个稀有度范围的"典型价"：按正规包概率加权的基准价 × 未评级系数，给没对上库存的需求定预算区间 */
function typicalPrice(rarities: Rarity[]): number {
  const odds = PACKS.themed.odds;
  const w = rarities.reduce((s, r) => s + odds[r], 0);
  return Math.round(rarities.reduce((s, r) => s + odds[r] * RARITY[r].basePrice, 0) / w * 0.85);
}

function demandText(type: string, d: Demand): string {
  if (type === 'middleman') return '没验过的卡';
  const r = d.rarities.length === RARITIES.length ? '' : d.rarities.length === 2 ? `${d.rarities.join(' / ')} ` : `${d.rarities[0]} 以上的`;
  return `${d.tag ? `${d.tag}属性的` : ''}${r}卡`;
}

const toSellable = (c: CardView): SellableCard => ({ id: c.id, rarity: c.rarity as Rarity, tags: c.tags, price: c.price });

export function toCustomerView(row: CustomerRow): CustomerView {
  const demand = JSON.parse(row.demand) as Demand;
  const type = row.type as CustomerType;
  return {
    id: row.id,
    type,
    typeName: CUSTOMER[type].name,
    line: row.line,
    demand: { ...demand, text: demandText(type, demand) },
    budgetLow: row.budget_low,
    budgetHigh: row.budget_high,
    patience: row.patience,
    maxPatience: CUSTOMER[type].patience,
    status: row.status as CustomerView['status'],
    counterPrice: row.counter_price,
  };
}

export function registerCounterRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo, rng } = deps;
  const pick = (arr: string[]) => arr[rng.int(arr.length)] ?? '';
  const say = (type: string, ev: LineEvent, vars: Record<string, string> = {}) =>
    pick(lines.byType[type]?.[ev] ?? ['……']).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

  /** 本营业日的顾客：第一次打开柜台时一次生成 customersPerDay 位（FR-CTR-1）；打烊后的不再出现（FR-CTR-2） */
  const ensureCustomers = repo.db.transaction((ownerId: string, t: number) => {
    const player = repo.getPlayer(ownerId)!;
    const day = dayKey(player.game_day);
    const existing = repo.customersFor(ownerId, day);
    if (existing.length >= COUNTER.customersPerDay) return { day: player.game_day, rows: existing };
    const inventory = repo.sellableCards(ownerId).map(toSellable);
    const allTags = [...new Set(repo.allTemplates().filter((x) => x.series_id === deps.currentSeries).flatMap((x) => JSON.parse(x.tags) as string[]))];
    for (let seat = 0; seat < COUNTER.customersPerDay; seat += 1) {
      if (existing.some((c) => c.seat === seat)) continue;
      const c = rollCustomer(rng, { inventory, allTags, typicalPrice });
      const text = demandText(c.type, c.demand);
      repo.insertCustomer({
        owner_id: ownerId, day_key: day, slot: 0, seat, type: c.type, demand: JSON.stringify(c.demand), float: c.float,
        patience: c.patience, line: say(c.type, 'greet', { demand: text }), budget_low: c.budgetLow, budget_high: c.budgetHigh, created_at: t,
      });
    }
    return { day: player.game_day, rows: repo.customersFor(ownerId, day) };
  });

  app.get('/api/counter', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { day, rows } = ensureCustomers(req.user.id, now());
    return { ok: true, customers: rows.map(toCustomerView), day } satisfies CounterResponse;
  });

  /** 打烊：还有顾客在等就不行；进入下一个营业日（房租在 M5 按 RENT.everyDays 接上） */
  app.post('/api/day/end', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): EndDayResponse => {
      const replay = repo.getIdempotent<EndDayResponse>(userId, key);
      if (replay) return replay;
      const player = repo.getPlayer(userId)!;
      const today = repo.customersFor(userId, dayKey(player.game_day));
      if (today.length < COUNTER.customersPerDay) throw new ApiError(400, 'not_open', '今天还没开门，先去柜台看看顾客');
      if (today.some((c) => c.status === 'waiting')) throw new ApiError(400, 'customers_waiting', '还有顾客在等，接待完或请走再打烊');
      repo.advanceDay(userId);
      repo.logEvent(userId, now(), 'day_end', { day: player.game_day });
      const response: EndDayResponse = { ok: true, day: player.game_day + 1 };
      repo.putIdempotent(userId, key, response, now());
      return response;
    })();
  });

  const waitingCustomer = (ownerId: string, id: number) => {
    const c = repo.getCustomer(ownerId, id);
    const player = repo.getPlayer(ownerId);
    if (!c || !player || c.day_key !== dayKey(player.game_day)) throw new ApiError(404, 'not_found', '这位顾客已经不在了');
    if (c.status !== 'waiting') throw new ApiError(400, 'gone', '这位顾客已经走了');
    return c;
  };

  app.get<{ Params: { id: string } }>('/api/counter/:id/cards', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const c = waitingCustomer(req.user.id, Number.parseInt(req.params.id, 10));
    const demand = JSON.parse(c.demand) as Demand;
    const cards = repo.sellableCards(req.user.id)
      .filter((x) => matches(toSellable(x), demand))
      .sort((a, b) => b.price - a.price)
      .map((card) => ({ card, quickPrice: quickPrice(c.type as CustomerType, toSellable(card)) }));
    return { ok: true, cards } satisfies EligibleCardsResponse;
  });

  /** 开价 / 快速出售的公共流程 */
  const sell = (ownerId: string, customerId: number, instanceId: number, price: number | 'quick', key: string): OfferResponse =>
    repo.db.transaction((): OfferResponse => {
      const replay = repo.getIdempotent<OfferResponse>(ownerId, key);
      if (replay) return replay;
      const t = now();
      const c = waitingCustomer(ownerId, customerId);
      const type = c.type as CustomerType;
      const player = repo.getPlayer(ownerId)!;
      const inst = repo.ownedInstance(ownerId, instanceId);
      if (!inst || inst.location !== 'inventory') throw new ApiError(400, 'bad_card', '这张卡不能卖（不在库存里，或者在珍藏柜里）');
      const view = repo.cardView(instanceId)!;
      const card = toSellable(view);
      if (!matches(card, JSON.parse(c.demand) as Demand)) throw new ApiError(400, 'not_wanted', '这位顾客不要这张卡');

      const ask = price === 'quick' ? quickPrice(type, card) : price;
      const outcome = evaluateOffer(rng, { price: ask, mind: mindPrice(type, c.float, card), patience: c.patience });
      let credits = player.credits;
      let reputation = player.reputation;
      let result: OfferResponse['outcome'];
      let dealPrice: number | null = null;

      if (outcome.kind === 'deal') {
        if (detectFake(rng, type, inst.authenticity, false)) {
          // 被识破：退款、卡退回、扣信誉（FR-CTR-5）
          reputation = Math.max(REPUTATION.min, reputation - COUNTER.fakeCaughtRepLoss);
          repo.updateCustomer(c.id, { patience: 0, status: 'left', line: pick(lines.caught), counter_price: null });
          repo.logEvent(ownerId, t, 'fake_caught', { customer: c.id, card: instanceId, repLoss: COUNTER.fakeCaughtRepLoss });
          result = 'caught';
        } else {
          credits += outcome.price;
          dealPrice = outcome.price;
          repo.deleteCard(instanceId);
          repo.updateCustomer(c.id, { patience: c.patience, status: 'sold', line: say(type, 'deal'), counter_price: null });
          repo.logCredits(ownerId, t, outcome.price, 'sale', credits, { customer: c.id, type, card: instanceId, template: view.templateId, style: view.style });
          result = 'deal';
        }
      } else if (outcome.kind === 'counter') {
        repo.updateCustomer(c.id, { patience: outcome.patience, status: 'waiting', line: say(type, 'counter', { price: outcome.counterPrice.toLocaleString('zh-CN') }), counter_price: outcome.counterPrice });
        result = 'counter';
      } else if (outcome.kind === 'too_high') {
        repo.updateCustomer(c.id, { patience: outcome.patience, status: 'waiting', line: say(type, 'too_high'), counter_price: c.counter_price });
        result = 'too_high';
      } else {
        repo.updateCustomer(c.id, { patience: 0, status: 'left', line: say(type, 'left'), counter_price: null });
        result = 'left';
      }
      repo.setCreditsReputation(ownerId, credits, reputation);

      const response: OfferResponse = {
        ok: true, outcome: result, customer: toCustomerView(repo.getCustomer(ownerId, c.id)!), price: dealPrice, credits, reputation,
      };
      repo.putIdempotent(ownerId, key, response, t);
      return response;
    })();

  app.post<{ Params: { id: string }; Body: { instanceId?: unknown; price?: unknown } }>('/api/counter/:id/offer', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const price = Number(req.body?.price);
    if (!Number.isInteger(price) || price < 1 || price > 100_000_000) return fail(reply, 400, 'bad_price', '价格要是正整数');
    return sell(req.user.id, Number.parseInt(req.params.id, 10), Number(req.body?.instanceId), price, key);
  });

  app.post<{ Params: { id: string }; Body: { instanceId?: unknown } }>('/api/counter/:id/quick', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    return sell(req.user.id, Number.parseInt(req.params.id, 10), Number(req.body?.instanceId), 'quick', key);
  });

  app.post<{ Params: { id: string } }>('/api/counter/:id/dismiss', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const c = waitingCustomer(req.user.id, Number.parseInt(req.params.id, 10));
    repo.updateCustomer(c.id, { patience: c.patience, status: 'dismissed', line: c.line, counter_price: c.counter_price });
    return { ok: true, customer: toCustomerView(repo.getCustomer(req.user.id, c.id)!) };
  });
}
