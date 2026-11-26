import { afterEach, describe, expect, it } from 'vitest';
import { POLICE, REPUTATION } from '@kanu/shared/balance';
import type { CounterResponse, CustomerView, EndDayResponse, OfferResponse, PatrolResolveResponse, ReportResponse } from '@kanu/shared/types';
import { bribeCost, reportBonus, rollPatrol, undercoverFine } from '../src/game/police.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const counter = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
const stolenCard = (repo: Repo, template = 'NEO-17') =>
  repo.insertCard({ templateId: template, ownerId: UID, authenticity: 'real', grade: '9', origin: 'stolen', style: 'standard', serialNo: null, now: NOW, collect: false });
/** 把眼前这位改成"要任何卡"的普通客人，可选是便衣 */
function anyCardCustomer(repo: Repo, c: CustomerView, undercover: boolean) {
  repo.db.prepare('UPDATE customers SET type = ?, undercover = ?, demand = ? WHERE id = ?')
    .run('resident', undercover ? 1 : 0, JSON.stringify({ kind: 'card', rarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'MR'], tag: null, templateId: null, templateName: null }), c.id);
}
const offer = (app: App, h: H, customerId: number, instanceId: number, price: number) =>
  app.inject({ method: 'POST', url: `/api/counter/${customerId}/offer`, headers: { ...h, ...idem() }, payload: { instanceId, price } });

describe('便衣和巡查（纯函数）', () => {
  it('巡查大约 patrolPpm 来一次，来了每张赃卡 detectPpm 被查出', () => {
    const rng = seeded(9);
    let visits = 0, found = 0;
    const two = [{ id: 1, detectPpm: POLICE.detectPpm }, { id: 2, detectPpm: POLICE.detectPpm }];
    for (let i = 0; i < 20000; i += 1) { const r = rollPatrol(rng, two); if (r) { visits += 1; found += r.length; } }
    expect(visits / 20000).toBeCloseTo(POLICE.patrolPpm / 1e6, 1);
    expect(found / (visits * 2)).toBeCloseTo(POLICE.detectPpm / 1e6, 1);
  });
  it('打点费、罚款（最多罚到 0）、举报奖金', () => {
    expect(bribeCost([100, 300])).toBe(Math.round(400 * POLICE.bribePct));
    expect(undercoverFine(1000, 99999)).toBe(Math.max(POLICE.fineMin, 1000 * POLICE.fineMult));
    expect(undercoverFine(10, 99999)).toBe(POLICE.fineMin);
    expect(undercoverFine(1000, 30)).toBe(30);
    expect(reportBonus([100, 100])).toBe(Math.round(200 * POLICE.reportBonusPct));
  });
});

describe('便衣（DESIGN 6）', () => {
  it('赃卡卖给便衣：卡没收、不给钱、罚款、扣信誉；响应里看不出谁是便衣', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 5000').run();
    const id = stolenCard(repo);
    const price = repo.cardView(id)!.price;
    const c = (await counter(app, h)).current!;
    expect(findKeys(c, HIDDEN_KEYS)).toEqual([]);
    anyCardCustomer(repo, c, true);
    const r = (await offer(app, h, c.id, id, 1)).json() as OfferResponse;
    const fine = undercoverFine(price, 5000);
    expect(r).toMatchObject({ outcome: 'busted', fine, credits: 5000 - fine, reputation: REPUTATION.start - POLICE.bustRepLoss, customer: { status: 'busted' } });
    expect(findKeys(r, HIDDEN_KEYS)).toEqual([]);
    expect(repo.ownedInstance(UID, id)).toBeNull();
  });

  it('卖正经卡给便衣照常成交；赃卡卖给普通客人也照常成交', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const legit = repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '9', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const c1 = (await counter(app, h)).current!;
    anyCardCustomer(repo, c1, true);
    expect((await offer(app, h, c1.id, legit, 1)).json().outcome).toBe('deal');
    const hot = stolenCard(repo);
    const c2 = (await counter(app, h)).current!;
    anyCardCustomer(repo, c2, false);
    expect((await offer(app, h, c2.id, hot, 1)).json().outcome).toBe('deal');
  });
});

describe('巡查（DESIGN 8.3）', () => {
  /** 一直打烊，直到巡查查出东西 */
  async function untilPatrol(app: App, h: H): Promise<EndDayResponse> {
    for (let i = 0; i < 300; i += 1) {
      let s = await counter(app, h);
      while (s.current) { await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h }); s = await counter(app, h); }
      const end = (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
      if (end.patrol) return end;
    }
    throw new Error('等不到巡查');
  }

  it('查出赃卡：柜台不开门；交出就没收、扣信誉，之后照常开门', async () => {
    const { app, repo } = setup({ rng: seeded(21) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, shop_owned = 1').run();
    const id = stolenCard(repo);
    const end = await untilPatrol(app, h);
    expect(end.patrol!.cards.map((c) => c.id)).toEqual([id]);
    expect(findKeys(end, HIDDEN_KEYS)).toEqual([]);
    const s = await counter(app, h);
    expect(s).toMatchObject({ current: null, done: false, patrol: { id: end.patrol!.id } });
    const rep = repo.getPlayer(UID)!.reputation;
    const r = (await app.inject({ method: 'POST', url: `/api/patrol/${end.patrol!.id}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'surrender' } })).json() as PatrolResolveResponse;
    expect(r).toMatchObject({ choice: 'surrender', reputation: Math.max(REPUTATION.min, rep - POLICE.surrenderRepLoss) });
    expect(repo.ownedInstance(UID, id)).toBeNull();
    expect((await counter(app, h)).current).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/patrol/${end.patrol!.id}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'bribe' } })).json().code).toBe('resolved');
  });

  it('打点：付钱、卡留下；钱不够只能交出', async () => {
    const { app, repo } = setup({ rng: seeded(22) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, shop_owned = 1').run();
    const id = stolenCard(repo, 'NEO-20');
    const end = await untilPatrol(app, h);
    const bribe = end.patrol!.bribe;
    expect(bribe).toBe(bribeCost([repo.cardView(id)!.price]));
    repo.db.prepare('UPDATE players SET credits = ?').run(bribe - 1);
    expect((await app.inject({ method: 'POST', url: `/api/patrol/${end.patrol!.id}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'bribe' } })).json().code).toBe('insufficient_credits');
    repo.db.prepare('UPDATE players SET credits = ?').run(bribe + 10);
    const r = (await app.inject({ method: 'POST', url: `/api/patrol/${end.patrol!.id}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'bribe' } })).json() as PatrolResolveResponse;
    expect(r).toMatchObject({ choice: 'bribe', credits: 10 });
    expect(repo.ownedInstance(UID, id)).not.toBeNull();
  });

  it('没有赃卡：巡查来了也查不出东西，不挡开门', async () => {
    const { app, repo } = setup({ rng: seeded(23) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, shop_owned = 1').run();
    let clean = 0;
    for (let i = 0; i < 60; i += 1) {
      let s = await counter(app, h);
      expect(s.patrol ?? null).toBeNull();
      while (s.current) { await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h }); s = await counter(app, h); }
      const end = (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
      expect(end.patrol ?? null).toBeNull();
      if (end.patrolClean) clean += 1;
    }
    expect(clean).toBeGreaterThan(0);
  });
});

describe('举报卡贩', () => {
  async function dealer(app: App, repo: Repo, h: H): Promise<CustomerView> {
    repo.addTech(UID, 'G1', 1);
    repo.addTech(UID, 'G2', 1);
    for (let i = 0; i < 300; i += 1) {
      const s = await counter(app, h);
      if (s.current?.type === 'dealer') return s.current;
      if (s.patrol) await app.inject({ method: 'POST', url: `/api/patrol/${s.patrol.id}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'surrender' } });
      else if (s.current) await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h });
      else await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    }
    throw new Error('等不到卡贩');
  }

  it('他货里有赃物：举报对了，奖金、信誉 +，赃卡没收；没有：举报错了，信誉 −', async () => {
    const { app, repo } = setup({ rng: seeded(31) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000000, shop_owned = 1').run();
    const d = await dealer(app, repo, h);
    const ids = d.demand.offers!.map((o) => o.card.id);
    repo.db.prepare(`UPDATE card_instances SET origin = 'stolen' WHERE id = ${ids[0]}`).run();
    repo.db.prepare(`UPDATE card_instances SET origin = 'unknown' WHERE id IN (${ids.slice(1).join(',') || 0})`).run();
    const before = repo.getPlayer(UID)!;
    const r = (await app.inject({ method: 'POST', url: `/api/counter/${d.id}/report`, headers: { ...h, ...idem() } })).json() as ReportResponse;
    expect(r).toMatchObject({ correct: true, bonus: reportBonus([d.demand.offers![0]!.card.price]), credits: before.credits + r.bonus, reputation: Math.min(REPUTATION.max, before.reputation + POLICE.reportRepGain) });
    expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM card_instances WHERE id IN (${ids.join(',')})`).get()).toEqual({ n: 0 });

    const d2 = await dealer(app, repo, h);
    const ids2 = d2.demand.offers!.map((o) => o.card.id);
    repo.db.prepare(`UPDATE card_instances SET origin = 'unknown' WHERE id IN (${ids2.join(',')})`).run();
    const rep2 = repo.getPlayer(UID)!.reputation;
    const r2 = (await app.inject({ method: 'POST', url: `/api/counter/${d2.id}/report`, headers: { ...h, ...idem() } })).json() as ReportResponse;
    expect(r2).toMatchObject({ correct: false, bonus: 0, reputation: Math.max(REPUTATION.min, rep2 - POLICE.falseReportRepLoss) });
  });
});
