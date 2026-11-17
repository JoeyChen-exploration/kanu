// 柜台（SRS FR-CTR-1～5、7）。2026-11-17：顾客一位一位进门，学深空当铺：
//   GET  /api/counter                 本营业日眼前这一位 + 今天接待过的（今天一共几位不告诉玩家）
//   GET  /api/counter/:id/cards       这位顾客能接受的卡（或卡包）+ 每样的快速出售价
//   POST /api/counter/:id/offer       { instanceId | packId, price } 开价
//   POST /api/counter/:id/quick       { instanceId | packId } 快速出售（按浮动下限算，必定成交）
//   POST /api/counter/:id/dismiss     请顾客离开
//   POST /api/day/end                 今天的顾客都接待完了才能打烊，进入下一个营业日
// 上一位走了才生成下一位，需求参照玩家当时的库存。写操作都在一个事务里，要求幂等 key（dismiss 除外，它是设成目标状态）。
// 心理价位、个人浮动、今天还剩几位都不出现在响应里。
import type { FastifyInstance } from 'fastify';
import { CUSTOMER, PACKS, RARITIES, RARITY, REPUTATION, COUNTER, type CustomerType, type Rarity } from '@kanu/shared/balance';
import type { CardView, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, OfferResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { dayKey, type CustomerRow } from '../db/index.ts';
import {
  detectFake, evaluateOffer, matchesCard, matchesPack, mindPrice, mindPricePack, quickPrice, quickPricePack,
  rollCustomer, rollCustomerCount, type Demand, type SellableCard, type SellablePack,
} from '../game/customers.ts';
import { loadLines, type LineEvent } from '../content.ts';

const lines = loadLines();

/** 每个稀有度范围的"典型价"：按主题包概率加权的基准价 × 未评级系数，给没对上库存的需求定预算区间 */
function typicalPrice(rarities: Rarity[]): number {
  const odds = PACKS.themed.odds;
  const w = rarities.reduce((s, r) => s + Math.max(odds[r], 1), 0);
  return Math.round(rarities.reduce((s, r) => s + Math.max(odds[r], 1) * RARITY[r].basePrice, 0) / w * 0.85);
}

function demandText(type: string, d: Demand): string {
  if (d.kind === 'pack') return d.seriesName ? `没拆的「${d.seriesName}」卡包` : '没拆的卡包，哪种都行';
  if (d.templateName) return `「${d.templateName}」这张卡`;
  if (type === 'middleman') return '没验过的卡';
  const r = d.rarities.length === RARITIES.length ? '' : d.rarities[0] === 'N' ? `${d.rarities.join(' / ')} ` : `${d.rarities[0]} 以上的`;
  return `${d.tag ? `${d.tag}属性的` : ''}${r}卡`;
}

const toSellable = (c: CardView): SellableCard => ({ id: c.id, templateId: c.templateId, rarity: c.rarity as Rarity, tags: c.tags, style: c.style, price: c.price });

export function toCustomerView(row: CustomerRow): CustomerView {
  const demand = JSON.parse(row.demand) as Demand;
  const type = row.type as CustomerType;
  return {
    id: row.id,
    type,
    typeName: CUSTOMER[type].name,
    line: row.line,
    demand: { kind: demand.kind, text: demandText(type, demand) },
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

  const sellablePacks = (ownerId: string): SellablePack[] =>
    repo.sealedByOwner(ownerId).map((p) => ({ id: p.id, seriesId: p.series_id, price: PACKS[p.kind].price }));

  /**
   * 本营业日的状态：第一次打开柜台时决定今天来几位（不告诉玩家）；眼前没人、还有名额，就生成下一位（FR-CTR-1）。
   * 一次只有一位在等（status = waiting）。打烊后的顾客不再出现（FR-CTR-2）。只能在事务里调用。
   */
  const counterState = (ownerId: string, t: number) => {
    let player = repo.getPlayer(ownerId)!;
    if (player.day_customer_count === 0) {
      repo.setDayCustomerCount(ownerId, rollCustomerCount(rng));
      player = repo.getPlayer(ownerId)!;
    }
    const day = dayKey(player.game_day);
    let rows = repo.customersFor(ownerId, day);
    if (!rows.some((c) => c.status === 'waiting') && rows.length < player.day_customer_count) {
      const series = repo.allSeries().map((s) => ({ id: s.id, name: s.name, price: PACKS[s.kind].price }));
      const templates = repo.allTemplates().map((x) => ({ id: x.id, name: x.name, rarity: x.rarity, tags: JSON.parse(x.tags) as string[] }));
      const c = rollCustomer(rng, { inventory: repo.sellableCards(ownerId).map(toSellable), packs: sellablePacks(ownerId), templates, series, typicalPrice });
      repo.insertCustomer({
        owner_id: ownerId, day_key: day, slot: 0, seat: rows.length, type: c.type, demand: JSON.stringify(c.demand), float: c.float,
        patience: c.patience, line: say(c.type, 'greet', { demand: demandText(c.type, c.demand) }), budget_low: c.budgetLow, budget_high: c.budgetHigh, created_at: t,
      });
      rows = repo.customersFor(ownerId, day);
    }
    const current = rows.find((c) => c.status === 'waiting') ?? null;
    return {
      day: player.game_day,
      current: current ? toCustomerView(current) : null,
      served: rows.filter((c) => c.status !== 'waiting').map(toCustomerView),
      done: !current && rows.length >= player.day_customer_count,
    };
  };
  const counterTx = repo.db.transaction(counterState);

  app.get('/api/counter', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return { ok: true, ...counterTx(req.user.id, now()) } satisfies CounterResponse;
  });

  /** 打烊：今天的顾客都接待完了才行；进入下一个营业日（房租在 M5 按 RENT.everyDays 接上） */
  app.post('/api/day/end', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): EndDayResponse => {
      const replay = repo.getIdempotent<EndDayResponse>(userId, key);
      if (replay) return replay;
      const player = repo.getPlayer(userId)!;
      if (player.day_customer_count === 0) throw new ApiError(400, 'not_open', '今天还没开门，先去柜台看看顾客');
      const today = repo.customersFor(userId, dayKey(player.game_day));
      if (today.some((c) => c.status === 'waiting') || today.length < player.day_customer_count) {
        throw new ApiError(400, 'customers_waiting', '还有顾客没接待完，接待完（或请走）再打烊');
      }
      repo.advanceDay(userId);
      repo.logEvent(userId, now(), 'day_end', { day: player.game_day, customers: today.length });
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
    const type = c.type as CustomerType;
    const cards = repo.sellableCards(req.user.id)
      .filter((x) => matchesCard(toSellable(x), demand))
      .sort((a, b) => b.price - a.price)
      .map((card) => ({ card, quickPrice: quickPrice(type, toSellable(card)) }));
    const packs = repo.sealedByOwner(req.user.id)
      .map((p) => ({ view: { id: p.id, seriesId: p.series_id, name: p.name, kind: p.kind }, sell: { id: p.id, seriesId: p.series_id, price: PACKS[p.kind].price } }))
      .filter((p) => matchesPack(p.sell, demand))
      .map((p) => ({ ...p.view, quickPrice: quickPricePack(type, p.sell) }));
    return { ok: true, cards, packs } satisfies EligibleCardsResponse;
  });

  /** 开价 / 快速出售的公共流程：卖卡（instanceId）或卖没拆的卡包（packId） */
  const sell = (ownerId: string, customerId: number, item: { instanceId?: number; packId?: number }, price: number | 'quick', key: string): OfferResponse =>
    repo.db.transaction((): OfferResponse => {
      const replay = repo.getIdempotent<OfferResponse>(ownerId, key);
      if (replay) return replay;
      const t = now();
      const c = waitingCustomer(ownerId, customerId);
      const type = c.type as CustomerType;
      const demand = JSON.parse(c.demand) as Demand;
      const player = repo.getPlayer(ownerId)!;

      let mind: number;
      let ask: number;
      let authenticity = 'real';
      let finish: () => Record<string, unknown>;
      if (item.packId !== undefined) {
        const sealed = repo.getSealed(ownerId, item.packId);
        if (!sealed) throw new ApiError(400, 'bad_pack', '找不到这包卡');
        const kind = repo.seriesKind(sealed.series_id)!;
        const pack: SellablePack = { id: sealed.id, seriesId: sealed.series_id, price: PACKS[kind].price };
        if (!matchesPack(pack, demand)) throw new ApiError(400, 'not_wanted', '这位顾客不要这包卡');
        mind = mindPricePack(type, c.float, pack);
        ask = price === 'quick' ? quickPricePack(type, pack) : price;
        finish = () => { repo.deleteSealed(sealed.id); return { pack: sealed.id, seriesId: sealed.series_id }; };
      } else {
        const instanceId = Number(item.instanceId);
        const inst = repo.ownedInstance(ownerId, instanceId);
        if (!inst || inst.location !== 'inventory') throw new ApiError(400, 'bad_card', '这张卡不能卖（不在库存里，或者在珍藏柜里）');
        const view = repo.cardView(instanceId)!;
        const card = toSellable(view);
        if (!matchesCard(card, demand)) throw new ApiError(400, 'not_wanted', '这位顾客不要这张卡');
        mind = mindPrice(type, c.float, card);
        ask = price === 'quick' ? quickPrice(type, card) : price;
        authenticity = inst.authenticity;
        finish = () => { repo.deleteCard(instanceId); return { card: instanceId, template: view.templateId, style: view.style }; };
      }

      const outcome = evaluateOffer(rng, { price: ask, mind, patience: c.patience });
      let credits = player.credits;
      let reputation = player.reputation;
      let result: OfferResponse['outcome'];
      let dealPrice: number | null = null;

      if (outcome.kind === 'deal') {
        if (detectFake(rng, type, authenticity, false)) {
          // 被识破：退款、卡退回、扣信誉（FR-CTR-5）
          reputation = Math.max(REPUTATION.min, reputation - COUNTER.fakeCaughtRepLoss);
          repo.updateCustomer(c.id, { patience: 0, status: 'left', line: pick(lines.caught), counter_price: null });
          repo.logEvent(ownerId, t, 'fake_caught', { customer: c.id, item, repLoss: COUNTER.fakeCaughtRepLoss });
          result = 'caught';
        } else {
          credits += outcome.price;
          dealPrice = outcome.price;
          const sold = finish();
          repo.updateCustomer(c.id, { patience: c.patience, status: 'sold', line: say(type, 'deal'), counter_price: null });
          repo.logCredits(ownerId, t, outcome.price, 'sale', credits, { customer: c.id, type, ...sold });
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

      const state = counterState(ownerId, t);
      const response: OfferResponse = {
        ok: true, outcome: result, customer: toCustomerView(repo.getCustomer(ownerId, c.id)!),
        next: result === 'counter' || result === 'too_high' ? null : state.current, done: state.done,
        price: dealPrice, credits, reputation,
      };
      repo.putIdempotent(ownerId, key, response, t);
      return response;
    })();

  const parseItem = (body: { instanceId?: unknown; packId?: unknown } | undefined) =>
    body?.packId !== undefined ? { packId: Number(body.packId) } : { instanceId: Number(body?.instanceId) };

  app.post<{ Params: { id: string }; Body: { instanceId?: unknown; packId?: unknown; price?: unknown } }>('/api/counter/:id/offer', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const price = Number(req.body?.price);
    if (!Number.isInteger(price) || price < 1 || price > 100_000_000) return fail(reply, 400, 'bad_price', '价格要是正整数');
    return sell(req.user.id, Number.parseInt(req.params.id, 10), parseItem(req.body), price, key);
  });

  app.post<{ Params: { id: string }; Body: { instanceId?: unknown; packId?: unknown } }>('/api/counter/:id/quick', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    return sell(req.user.id, Number.parseInt(req.params.id, 10), parseItem(req.body), 'quick', key);
  });

  app.post<{ Params: { id: string } }>('/api/counter/:id/dismiss', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    return repo.db.transaction(() => {
      const c = waitingCustomer(userId, Number.parseInt(req.params.id, 10));
      repo.updateCustomer(c.id, { patience: c.patience, status: 'dismissed', line: c.line, counter_price: c.counter_price });
      const state = counterState(userId, now());
      return { ok: true, customer: toCustomerView(repo.getCustomer(userId, c.id)!), next: state.current, done: state.done };
    })();
  });
}
