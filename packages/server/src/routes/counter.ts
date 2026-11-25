// 柜台（SRS FR-CTR-1～5、7）。2026-11-17：顾客一位一位进门，学深空当铺：
//   GET  /api/counter                 本营业日眼前这一位 + 今天接待过的（今天一共几位不告诉玩家）
//   GET  /api/counter/:id/cards       这位顾客能接受的卡（或卡包）+ 每样的快速出售价 + 每本卡册里符合的张数
//   GET  /api/counter/:id/binder/:binderId?page=&matchFirst=  按这位顾客翻卡册（0 = 桌面散放），符合的高亮 / 排前面
//   POST /api/counter/:id/offer       { instanceId | packId, price } 开价
//   POST /api/counter/:id/quick       { instanceId | packId } 快速出售（按浮动下限算，必定成交）
//   POST /api/counter/:id/dismiss     请顾客离开
//   POST /api/day/end                 今天的顾客都接待完了才能打烊，进入下一个营业日
// 上一位走了才生成下一位，需求参照玩家当时的库存。写操作都在一个事务里，要求幂等 key（dismiss 除外，它是设成目标状态）。
// 心理价位、个人浮动、今天还剩几位都不出现在响应里。
import { techEffects } from '../game/tech.ts';
import type { FastifyInstance } from 'fastify';
import { BINDER_PAGE_SIZE, BINDERS, CUSTOMER, PACKS, RARITIES, RARITY, RENT, REPUTATION, COUNTER, WHOLESALE, DEALER, type BinderKind, type CustomerType, type Rarity } from '@kanu/shared/balance';
import type { CardView, DealerBuyResponse, CounterBinderPageResponse, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, OfferResponse, ReceiveResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { dayKey, type CustomerRow } from '../db/index.ts';
import {
  detectFake, evaluateOffer, matchesCard, matchesPack, mindPrice, mindPricePack, quickPrice, quickPricePack,
  rollCustomer, rollCustomerCount, type Demand, type SellableCard, type SellablePack,
} from '../game/customers.ts';
import { loadLines, type LineEvent } from '../content.ts';
import { grandChancePpm, showcaseEffects, showcaseScore } from '../game/showcase.ts';
import { finishDay } from '../day.ts';
import { dealerAsk, evaluateDealerOffer, rollDealerCards } from '../game/dealer.ts';
import { rentDueToday, runDay } from '../game/rent.ts';
import { rentForWeek } from '../game/price.ts';
import { chance } from '../game/rng.ts';

const lines = loadLines();

/** 每个稀有度范围的"典型价"：按主题包概率加权的基准价 × 未评级系数，给没对上库存的需求定预算区间 */
function typicalPrice(rarities: Rarity[]): number {
  const odds = PACKS.themed.odds;
  const w = rarities.reduce((s, r) => s + Math.max(odds[r], 1), 0);
  return Math.round(rarities.reduce((s, r) => s + Math.max(odds[r], 1) * RARITY[r].basePrice, 0) / w * 0.85);
}

function demandText(type: string, d: Demand): string {
  if (d.kind === 'sell') return `急着出手 ${d.offers.length} 张卡，你出价收`;
  if (d.kind === 'delivery') return `送来「${d.seriesName}」一盒 ${d.packs} 包，货到付款 ${d.price.toLocaleString('zh-CN')} 信用点`;
  if (d.kind === 'pack') return d.seriesName ? `没拆的「${d.seriesName}」卡包` : '没拆的卡包，哪种都行';
  if (d.templateName) return `「${d.templateName}」这张卡`;
  if (type === 'middleman') return '没验过的卡';
  const r = d.rarities.length === RARITIES.length ? '' : d.rarities[0] === 'N' ? `${d.rarities.join(' / ')} ` : `${d.rarities[0]} 以上的`;
  return `${d.tag ? `${d.tag}属性的` : ''}${r}卡`;
}

const toSellable = (c: CardView): SellableCard => ({ id: c.id, templateId: c.templateId, rarity: c.rarity as Rarity, tags: c.tags, style: c.style, price: c.price });

/** card：按 id 取卡的公开信息（卡贩摆上台面的卡要用）；卡贩心里的底价 ask 绝不放进来 */
export function toCustomerView(row: CustomerRow, card: (id: number) => CardView | null = () => null): CustomerView {
  const demand = JSON.parse(row.demand) as Demand;
  const type = row.type as CustomerType;
  return {
    id: row.id,
    type,
    typeName: CUSTOMER[type].name,
    line: row.line,
    demand: {
      kind: demand.kind, text: demandText(type, demand),
      ...(demand.kind === 'delivery' ? { delivery: { orderId: demand.orderId, seriesId: demand.seriesId, seriesName: demand.seriesName, packs: demand.packs, price: demand.price } } : {}),
      ...(demand.kind === 'sell' ? { offers: demand.offers.flatMap((o) => { const c = card(o.cardId); return c ? [{ card: c, status: o.status, counterPrice: o.counter }] : []; }) } : {}),
    },
    budgetLow: row.budget_low,
    budgetHigh: row.budget_high,
    patience: row.patience,
    maxPatience: Math.max(row.max_patience ?? 0, row.patience, CUSTOMER[type].patience),
    status: row.status as CustomerView['status'],
    counterPrice: row.counter_price,
  };
}

export function registerCounterRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo, rng } = deps;
  const view = (row: CustomerRow) => toCustomerView(row, (id) => repo.cardView(id));

  /** 卡贩走了（请走、耐心用完、收完）：没收下的卡从玩家名下删掉 */
  const releaseOffers = (demand: Demand) => {
    if (demand.kind !== 'sell') return;
    for (const o of demand.offers) if (o.status === 'open') repo.deleteCard(o.cardId);
  };
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
    // 卡册效果（典藏皮面册）带来的额外收藏家：排在当天最后几位
    const extra = deps.binders!.extraCollectors(ownerId);
    const tech = techEffects(repo.techOwned(ownerId));
    if (player.day_customer_count === 0) {
      // 科技树 C2 二号柜台：每天多来几位
      repo.setDayCustomerCount(ownerId, rollCustomerCount(rng, extra + tech.customersPerDay));
      player = repo.getPlayer(ownerId)!;
    }
    const day = dayKey(player.game_day);
    let rows = repo.customersFor(ownerId, day);
    // 电话批发的货：隔日送达，到日子了、今天还有名额，下一位就是送货员（占一个名额，2026-11-18 用户定）
    const order = repo.pendingOrder(ownerId);
    const due = order && player.game_day >= order.ordered_day + WHOLESALE.deliveryDays;
    const courierHere = order && rows.some((c) => c.type === 'courier' && (JSON.parse(c.demand) as Demand & { orderId?: number }).orderId === order.id);
    if (order && due && !courierHere && !rows.some((c) => c.status === 'waiting') && rows.length < player.day_customer_count) {
      const demand: Demand = { kind: 'delivery', orderId: order.id, seriesId: order.series_id, seriesName: order.series_name, packs: order.packs, price: order.price };
      repo.insertCustomer({
        owner_id: ownerId, day_key: day, slot: 0, seat: rows.length, type: 'courier', demand: JSON.stringify(demand), float: 1,
        patience: CUSTOMER.courier.patience, max_patience: CUSTOMER.courier.patience, line: say('courier', 'greet', { demand: demandText('courier', demand) }),
        budget_low: order.price, budget_high: order.price, created_at: t,
      });
      rows = repo.customersFor(ownerId, day);
    }
    if (!rows.some((c) => c.status === 'waiting') && rows.length < player.day_customer_count) {
      const series = repo.allSeries().map((s) => ({ id: s.id, name: s.name, price: PACKS[s.kind].price }));
      const templates = repo.allTemplates().map((x) => ({ id: x.id, name: x.name, rarity: x.rarity, tags: JSON.parse(x.tags) as string[] }));
      // 珍藏柜是门面：按顾客进门那一刻柜里的卡算展示分，抬高预算、心理价位和耐心；分够高还可能引来大藏家
      const score = showcaseScore(repo.showcaseCards(ownerId).map((x) => ({ rarity: x.rarity as Rarity, style: x.style })));
      const showcase = showcaseEffects(score);
      const forceType: CustomerType | undefined = rows.length >= player.day_customer_count - extra ? 'collector'
        : grandChancePpm(score) > 0 && chance(rng, grandChancePpm(score)) ? 'grand' : undefined;
      // 科技树 G2 卡贩门路：这一位有 dealerPpm 的概率是卡贩，带 1–3 张卡来卖（DESIGN 4 柜台收卡）
      if (!forceType && tech.dealerPpm > 0 && chance(rng, tech.dealerPpm)) {
        const byRarity: Partial<Record<Rarity, string[]>> = {};
        for (const x of templates) (byRarity[x.rarity as Rarity] ||= []).push(x.id);
        const offers = rollDealerCards(rng, byRarity).map((dc) => {
          const cardId = repo.insertCard({ templateId: dc.templateId, ownerId, authenticity: dc.authenticity, grade: String(dc.grade), origin: dc.origin, style: dc.style, serialNo: null, now: t, collect: false, acquired: 'dealer', location: 'offered' });
          return { cardId, ask: dealerAsk(rng, repo.cardView(cardId)!.price), counter: null, status: 'open' as const };
        });
        const demand: Demand = { kind: 'sell', offers };
        const patience = DEALER.patience + tech.patience;
        repo.insertCustomer({
          owner_id: ownerId, day_key: day, slot: 0, seat: rows.length, type: 'dealer', demand: JSON.stringify(demand), float: 1,
          patience, max_patience: patience, line: say('dealer', 'greet', { demand: demandText('dealer', demand) }), budget_low: 0, budget_high: 0, created_at: t,
        });
        rows = repo.customersFor(ownerId, day);
        const cur = rows.find((c) => c.status === 'waiting') ?? null;
        return { day: player.game_day, current: cur ? view(cur) : null, served: rows.filter((c) => c.status !== 'waiting').map(view), done: false, arrears: player.rent_due > 0 ? { amount: player.rent_due, week: player.rent_week } : null };
      }
      // 科技树 C1 霓虹招牌：所有顾客耐心 +1
      const rolled = rollCustomer(rng, { inventory: repo.sellableCards(ownerId).map(toSellable), packs: sellablePacks(ownerId), templates, series, typicalPrice, forceType, showcase });
      const c = { ...rolled, patience: rolled.patience + tech.patience };
      repo.insertCustomer({
        owner_id: ownerId, day_key: day, slot: 0, seat: rows.length, type: c.type, demand: JSON.stringify(c.demand), float: c.float,
        patience: c.patience, max_patience: c.patience, line: say(c.type, 'greet', { demand: demandText(c.type, c.demand) }), budget_low: c.budgetLow, budget_high: c.budgetHigh, created_at: t,
      });
      rows = repo.customersFor(ownerId, day);
    }
    const current = rows.find((c) => c.status === 'waiting') ?? null;
    return {
      day: player.game_day,
      current: current ? view(current) : null,
      served: rows.filter((c) => c.status !== 'waiting').map((r) => view(r)),
      done: !current && rows.length >= player.day_customer_count,
      arrears: player.rent_due > 0 ? { amount: player.rent_due, week: player.rent_week } : null,
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
      const t = now();
      // 欠租中：不进下一天，先去店铺页交租 / 抵押（FR-RENT-2）
      if (player.rent_due > 0) {
        return { ok: true, day: player.game_day, appraisals: [], arrears: { amount: player.rent_due, week: player.rent_week } } satisfies EndDayResponse;
      }
      // 交租日（这一轮第 7、14、21……天）打烊时扣摊位费；店主不交（FR-RENT-1）
      let rentPaid: EndDayResponse['rentPaid'] = null;
      if (player.shop_owned !== 1 && rentDueToday(player.game_day, player.run_start_day)) {
        const week = runDay(player.game_day, player.run_start_day) / RENT.everyDays;
        const amount = rentForWeek(week);
        if (player.credits < amount) {
          repo.setArrears(userId, amount, week);
          repo.logEvent(userId, t, 'rent_arrears', { day: player.game_day, week, amount, credits: player.credits });
          const response: EndDayResponse = { ok: true, day: player.game_day, appraisals: [], arrears: { amount, week } };
          repo.putIdempotent(userId, key, response, t);
          return response;
        }
        const credits = player.credits - amount;
        repo.setCreditsPity(userId, credits, player.pity_count);
        repo.logCredits(userId, t, -amount, 'rent', credits, { week });
        rentPaid = { amount, week };
      }
      // 打烊结算：散卡磨损、进入下一天、过期抵押归房东、评级社出结果
      const { day, appraisals, forfeited } = finishDay(deps, userId, t, { customers: today.length });
      const response: EndDayResponse = { ok: true, day, appraisals, rentPaid, forfeited };
      repo.putIdempotent(userId, key, response, now());
      return response;
    })();
  });

  /** 快速出售价（含卡册加价） */
  const cardQuick = (ownerId: string, type: CustomerType, card: CardView) =>
    Math.round(quickPrice(type, toSellable(card)) * deps.binders!.priceMultiplier(ownerId, card.binderId, type));

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
    const userId = req.user.id;
    const matched = repo.sellableCards(userId).filter((x) => matchesCard(toSellable(x), demand));
    const cards = [...matched]
      .sort((a, b) => b.price - a.price)
      .map((card) => ({ card, quickPrice: cardQuick(userId, type, card) }));
    const packs = repo.sealedByOwner(userId)
      .map((p) => ({ view: { id: p.id, seriesId: p.series_id, name: p.name, kind: p.kind }, sell: { id: p.id, seriesId: p.series_id, price: PACKS[p.kind].price } }))
      .filter((p) => matchesPack(p.sell, demand))
      .map((p) => ({ ...p.view, quickPrice: quickPricePack(type, p.sell) }));
    const countIn = (binderId: number) => matched.filter((c) => c.location === 'inventory' && c.binderId === binderId).length;
    const binders = repo.bindersOf(userId).map((b) => {
      const spec = BINDERS[b.kind as BinderKind];
      return { id: b.id, kind: b.kind, name: spec.name, used: b.used, slots: spec.slots, matchCount: countIn(b.id) };
    });
    const loose = { count: repo.looseCards(userId).length, matchCount: matched.filter((c) => c.location === 'inventory' && c.binderId === null).length };
    const showcase = { count: repo.countLocation(userId, 'showcase'), matchCount: matched.filter((c) => c.location === 'showcase').length };
    return { ok: true, cards, packs, binders, loose, showcase } satisfies EligibleCardsResponse;
  });

  /** 按这位顾客翻一本卡册（binderId = 0 是桌面散放）：一页 9 张，符合的高亮；matchFirst=1 时符合的排前面（按市场价从高到低） */
  app.get<{ Params: { id: string; binderId: string }; Querystring: { page?: string; matchFirst?: string } }>('/api/counter/:id/binder/:binderId', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    const c = waitingCustomer(userId, Number.parseInt(req.params.id, 10));
    const demand = JSON.parse(c.demand) as Demand;
    const type = c.type as CustomerType;
    const binderId = Number.parseInt(req.params.binderId, 10);
    let binder: CounterBinderPageResponse['binder'];
    let all: CardView[];
    if (req.params.binderId === 'showcase') {
      binder = { id: -1, kind: 'showcase', name: '珍藏柜' };
      all = repo.inventory(userId, { location: 'showcase', page: 1, pageSize: 1000 }).cards;
    } else if (binderId === 0) {
      binder = { id: 0, kind: 'loose', name: '桌面散放' };
      all = repo.looseCards(userId);
    } else {
      const b = repo.getBinder(userId, binderId);
      if (!b) return fail(reply, 404, 'not_found', '找不到这本卡册');
      binder = { id: b.id, kind: b.kind, name: BINDERS[b.kind as BinderKind].name };
      all = repo.allBinderCards(b.id);
    }
    const matchFirst = req.query.matchFirst !== '0';
    let rows = all.map((card) => ({ card, match: matchesCard(toSellable(card), demand) }));
    if (matchFirst) rows = [...rows.filter((r) => r.match).sort((a, b) => b.card.price - a.card.price), ...rows.filter((r) => !r.match)];
    const pages = Math.max(1, Math.ceil(rows.length / BINDER_PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1));
    const cards = rows.slice((page - 1) * BINDER_PAGE_SIZE, page * BINDER_PAGE_SIZE)
      .map((r) => ({ ...r, quickPrice: r.match ? cardQuick(userId, type, r.card) : null }));
    return { ok: true, binder, page, pages, matchFirst, cards } satisfies CounterBinderPageResponse;
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
        if (!inst || (inst.location !== 'inventory' && inst.location !== 'showcase')) throw new ApiError(400, 'bad_card', '这张卡现在不能卖');
        const view = repo.cardView(instanceId)!;
        const card = toSellable(view);
        if (!matchesCard(card, demand)) throw new ApiError(400, 'not_wanted', '这位顾客不要这张卡');
        // 卡册效果：放在好卡册里的卡卖得贵一点（心理价位和快速出售价一起乘）
        const mult = deps.binders!.priceMultiplier(ownerId, view.binderId, type);
        mind = Math.round(mindPrice(type, c.float, card) * mult);
        ask = price === 'quick' ? Math.round(quickPrice(type, card) * mult) : price;
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
        ok: true, outcome: result, customer: view(repo.getCustomer(ownerId, c.id)!),
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

  // 送货员：收货、付钱（货到付款）。钱不够就拒绝，可以请走（= 拒收，订单取消）
  app.post<{ Params: { id: string } }>('/api/counter/:id/receive', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const customerId = Number.parseInt(req.params.id, 10);
    return repo.db.transaction((): ReceiveResponse => {
      const replay = repo.getIdempotent<ReceiveResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const c = waitingCustomer(userId, customerId);
      const demand = JSON.parse(c.demand) as Demand;
      if (demand.kind !== 'delivery') throw new ApiError(400, 'not_courier', '这位不是送货员');
      const order = repo.getOrder(userId, demand.orderId);
      if (!order || order.status !== 'pending') throw new ApiError(400, 'order_gone', '这张订单已经处理过了');
      const player = repo.getPlayer(userId)!;
      const free = deps.config.devUnlimitedIds.has(userId);
      const cost = free ? 0 : order.price;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：货款 ${cost}，你有 ${player.credits}。付不起可以请他走（拒收）`);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      const box = repo.nextBoxId();
      const packIds = Array.from({ length: order.packs }, () => repo.insertSealed(userId, order.series_id, 'phone', t, box));
      repo.setOrderStatus(order.id, 'delivered');
      repo.updateCustomer(c.id, { patience: c.patience, status: 'received', line: say('courier', 'deal'), counter_price: null });
      repo.logCredits(userId, t, -cost, free ? 'wholesale_test_free' : 'wholesale', credits, { order: order.id, seriesId: order.series_id, box });
      repo.logEvent(userId, t, 'wholesale', { day: player.game_day, order: order.id, seriesId: order.series_id, box, packs: packIds.length });
      const state = counterState(userId, t);
      const response: ReceiveResponse = { ok: true, credits, cost, packIds, next: state.current, done: state.done };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  // 卡贩：出价收台面上的一张卡（幂等）。够他的底价就成交（扣信用点、卡进卡册 / 桌面）；不够他还价，耐心减 1，用完就走（没收的卡删掉）
  app.post<{ Params: { id: string }; Body: { cardId?: number; price?: number } }>('/api/counter/:id/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): DealerBuyResponse => {
      const replay = repo.getIdempotent<DealerBuyResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const c = waitingCustomer(userId, Number.parseInt(req.params.id, 10));
      const demand = JSON.parse(c.demand) as Demand;
      if (demand.kind !== 'sell') throw new ApiError(400, 'not_dealer', '这位不是来卖卡的');
      const offer = demand.offers.find((o) => o.cardId === req.body?.cardId);
      if (!offer || offer.status !== 'open') throw new ApiError(400, 'not_offered', '这张卡不在台面上了');
      const price = req.body?.price;
      if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) throw new ApiError(400, 'bad_price', '出价要是正整数');
      const player = repo.getPlayer(userId)!;
      if (player.credits < price) throw new ApiError(400, 'insufficient_credits', `信用点不够：出价 ${price}，你有 ${player.credits}`);
      const outcome = evaluateDealerOffer(rng, { price, ask: offer.ask, patience: c.patience });
      let credits = player.credits;
      let status = c.status;
      let patience = c.patience;
      let line = c.line;
      if (outcome.kind === 'deal') {
        if (deps.binders!.space(userId).total < 1) throw new ApiError(400, 'no_space', '卡册和桌面都满了，先腾个位置再收');
        credits -= price;
        repo.setCreditsPity(userId, credits, player.pity_count);
        repo.setLocation(offer.cardId, 'inventory');
        deps.binders!.placeNew(userId, [offer.cardId], player.game_day);
        offer.status = 'bought';
        offer.counter = null;
        repo.logCredits(userId, t, -price, 'dealer_buy', credits, { customer: c.id, card: offer.cardId });
        line = say('dealer', 'deal');
        if (demand.offers.every((o) => o.status === 'bought')) status = 'sold';
      } else if (outcome.kind === 'counter') {
        offer.counter = outcome.counterPrice;
        patience = outcome.patience;
        line = say('dealer', 'counter', { price: outcome.counterPrice.toLocaleString('zh-CN') });
      } else {
        patience = 0;
        status = 'left';
        line = say('dealer', 'left');
        releaseOffers(demand);
      }
      repo.db.prepare('UPDATE customers SET demand = ? WHERE id = ?').run(JSON.stringify(demand), c.id);
      repo.updateCustomer(c.id, { patience, status, line, counter_price: null });
      repo.logEvent(userId, t, 'dealer_offer', { customer: c.id, card: offer.cardId, price, outcome: outcome.kind });
      const state = counterState(userId, t);
      const response: DealerBuyResponse = {
        ok: true, outcome: outcome.kind, credits, customer: view(repo.getCustomer(userId, c.id)!),
        card: outcome.kind === 'deal' ? repo.cardView(offer.cardId) : null, next: state.current, done: state.done,
      };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post<{ Params: { id: string } }>('/api/counter/:id/dismiss', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    return repo.db.transaction(() => {
      const c = waitingCustomer(userId, Number.parseInt(req.params.id, 10));
      // 请走送货员 = 拒收：订单取消，不扣钱（今天也不能再订）
      const demand = JSON.parse(c.demand) as Demand;
      if (demand.kind === 'delivery') {
        const order = repo.getOrder(userId, demand.orderId);
        if (order?.status === 'pending') repo.setOrderStatus(order.id, 'refused');
        repo.logEvent(userId, now(), 'wholesale_refused', { order: demand.orderId });
      }
      releaseOffers(demand);
      repo.updateCustomer(c.id, { patience: c.patience, status: 'dismissed', line: c.line, counter_price: c.counter_price });
      const state = counterState(userId, now());
      return { ok: true, customer: view(repo.getCustomer(userId, c.id)!), next: state.current, done: state.done };
    })();
  });
}
