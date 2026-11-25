import { afterEach, describe, expect, it } from 'vitest';
import { DEALER } from '@kanu/shared/balance';
import type { CardAppraisalResponse, CounterResponse, CustomerView, DealerBuyResponse } from '@kanu/shared/types';
import { dealerAsk, evaluateDealerOffer, rollDealerCards } from '../src/game/dealer.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
const HIDDEN = [...HIDDEN_KEYS, 'ask'];
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const counter = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
const buy = (app: App, h: H, id: number, cardId: number, price: number, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/counter/${id}/buy`, headers: { ...h, ...key }, payload: { cardId, price } });

/** 点了 G2，请走普通客人直到来一位卡贩（换天也行） */
async function nextDealer(app: App, repo: Repo, h: H): Promise<CustomerView> {
  repo.addTech(UID, 'G1', 1);
  repo.addTech(UID, 'G2', 1);
  for (let i = 0; i < 200; i += 1) {
    const s = await counter(app, h);
    if (s.current?.type === 'dealer') return s.current;
    if (s.current) await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h });
    else await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
  }
  throw new Error('等不到卡贩');
}

describe('卡贩（纯函数）', () => {
  it('每位带 1–3 张；假卡和赃物大约按 DEALER 的概率', () => {
    const rng = seeded(5);
    const tpl = { N: ['N1'], R: ['R1'], SR: ['SR1'], SSR: ['SSR1'], UR: ['UR1'], LR: ['LR1'], MR: ['MR1'] };
    const all = Array.from({ length: 3000 }, () => rollDealerCards(rng, tpl));
    expect(all.every((x) => x.length >= DEALER.cards[0] && x.length <= DEALER.cards[1])).toBe(true);
    const cards = all.flat();
    const fake = cards.filter((c) => c.authenticity !== 'real').length / cards.length;
    const stolen = cards.filter((c) => c.origin === 'stolen').length / cards.length;
    expect(fake).toBeGreaterThan(DEALER.fakePpm / 1e6 - 0.03);
    expect(fake).toBeLessThan(DEALER.fakePpm / 1e6 + 0.03);
    expect(stolen).toBeGreaterThan(DEALER.stolenPpm / 1e6 - 0.03);
    expect(stolen).toBeLessThan(DEALER.stolenPpm / 1e6 + 0.03);
    // 没有 MR 卡的卡池：抽到 MR 会往下降，不会凭空造卡
    expect(rollDealerCards(seeded(1), { N: ['N1'] }).every((c) => c.templateId === 'N1')).toBe(true);
  });

  it('底价在市场价 askPct 之间；出价够就成交，不够还价、耐心用完就走', () => {
    const rng = seeded(2);
    for (let i = 0; i < 200; i += 1) {
      const a = dealerAsk(rng, 1000);
      expect(a).toBeGreaterThanOrEqual(1000 * DEALER.askPct[0]);
      expect(a).toBeLessThanOrEqual(1000 * DEALER.askPct[1]);
    }
    expect(evaluateDealerOffer(rng, { price: 500, ask: 500, patience: 3 })).toEqual({ kind: 'deal' });
    const c = evaluateDealerOffer(rng, { price: 100, ask: 500, patience: 3 });
    expect(c).toMatchObject({ kind: 'counter', patience: 2 });
    expect((c as { counterPrice: number }).counterPrice).toBeGreaterThanOrEqual(500);
    expect(evaluateDealerOffer(rng, { price: 100, ask: 500, patience: 1 })).toEqual({ kind: 'leave' });
  });
});

describe('卡贩接口（柜台收卡）', () => {
  it('没点 G2 不会来卡贩', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    for (let i = 0; i < 60; i += 1) {
      const s = await counter(app, h);
      expect(s.current?.type).not.toBe('dealer');
      if (s.current) await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h });
      else await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    }
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE type = 'dealer'").get()).toEqual({ n: 0 });
  });

  it('卡贩把卡摆上台面：只给公开信息（没有底价），放大镜能看；出价够就收下，带"收"字，图鉴不点亮', async () => {
    const { app, repo } = setup({ rng: seeded(3) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000000').run();
    const d = await nextDealer(app, repo, h);
    expect(d.demand.kind).toBe('sell');
    const offers = d.demand.offers!;
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(findKeys(d, HIDDEN)).toEqual([]);
    const card = offers[0]!.card;
    expect(card.location).toBe('offered');
    // 摆在台面上的卡不算库存、不能卖
    expect(repo.sellableCards(UID).some((c) => c.id === card.id)).toBe(false);
    // 放大镜能看
    const look = (await app.inject({ method: 'POST', url: `/api/cards/${card.id}/inspect`, headers: h })).json() as CardAppraisalResponse;
    expect(look.inspection).not.toBeNull();

    const before = repo.getPlayer(UID)!.credits;
    const key = idem();
    const r = (await buy(app, h, d.id, card.id, card.price, key)).json() as DealerBuyResponse;
    expect((await buy(app, h, d.id, card.id, card.price, key)).json()).toEqual(r);
    expect(r).toMatchObject({ outcome: 'deal', credits: before - card.price, card: { id: card.id, acquired: 'dealer', location: 'inventory' } });
    expect(findKeys(r, HIDDEN)).toEqual([]);
    expect(repo.sellableCards(UID).some((c) => c.id === card.id)).toBe(true);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM collection WHERE discord_id = ? AND template_id = ?').get(UID, card.templateId)).toEqual({ n: 0 });
    expect((await buy(app, h, d.id, card.id, card.price)).json().code).toBe('not_offered');
  });

  it('出价太低：卡贩还价、耐心用完就走，没收的卡删掉；请走卡贩也一样', async () => {
    const { app, repo } = setup({ rng: seeded(4) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000000').run();
    const d = await nextDealer(app, repo, h);
    const card = d.demand.offers![0]!.card;
    const r1 = (await buy(app, h, d.id, card.id, 1)).json() as DealerBuyResponse;
    expect(r1.outcome).toBe('counter');
    expect(r1.customer.demand.offers![0]!.counterPrice).toBeGreaterThan(1);
    let last = r1;
    while (last.outcome === 'counter') last = (await buy(app, h, d.id, card.id, 1)).json() as DealerBuyResponse;
    expect(last.outcome).toBe('leave');
    expect(last.customer.status).toBe('left');
    const ids = d.demand.offers!.map((o) => o.card.id);
    expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM card_instances WHERE id IN (${ids.join(',')})`).get()).toEqual({ n: 0 });

    const d2 = await nextDealer(app, repo, h);
    await app.inject({ method: 'POST', url: `/api/counter/${d2.id}/dismiss`, headers: h });
    const ids2 = d2.demand.offers!.map((o) => o.card.id);
    expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM card_instances WHERE id IN (${ids2.join(',')})`).get()).toEqual({ n: 0 });
  });

  it('钱不够、出价不是正整数都拒绝', async () => {
    const { app, repo } = setup({ rng: seeded(6) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000000').run();
    const d = await nextDealer(app, repo, h);
    const card = d.demand.offers![0]!.card;
    expect((await buy(app, h, d.id, card.id, 0)).json().code).toBe('bad_price');
    repo.db.prepare('UPDATE players SET credits = 5').run();
    expect((await buy(app, h, d.id, card.id, 10)).json().code).toBe('insufficient_credits');
  });
});
