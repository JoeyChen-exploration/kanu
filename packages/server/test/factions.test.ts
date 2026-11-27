import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOMER, FACTIONS, PACKS, PLAYER, STORE } from '@kanu/shared/balance';
import type { CounterResponse, EndDayResponse, FactionsResponse, RegistryResponse, StoreResponse, TributeResponse } from '@kanu/shared/types';
import { dayKey } from '../src/db/index.ts';
import { applyFaction, policeMult, tierOf, vendettaOf } from '../src/game/factions.ts';
import { rentForWeek } from '../src/game/price.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const HIDDEN = [...HIDDEN_KEYS, 'police', 'rep_police', 'repPolice'];
const factions = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/factions', headers: h })).json() as FactionsResponse;
const rep = (repo: Repo) => { const p = repo.getPlayer(UID)!; return { guild: p.rep_guild, black: p.rep_black, collectors: p.rep_collectors, police: p.rep_police }; };

let seat = 100;
function seedSale(repo: Repo, type: string, card: { origin?: string; slab?: string } = {}) {
  const cardId = repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '7', origin: card.origin ?? 'legit', style: 'standard', serialNo: null, now: NOW });
  if (card.slab) repo.db.prepare('UPDATE card_instances SET slab_score = ? WHERE id = ?').run(card.slab, cardId);
  const customerId = repo.insertCustomer({
    owner_id: UID, day_key: dayKey(1), slot: 0, seat: seat++, type,
    demand: JSON.stringify({ kind: 'card', rarities: ['SR', 'SSR', 'UR', 'LR', 'MR'], tag: null, templateId: null, templateName: null }),
    float: 3, patience: CUSTOMER[type as 'rich'].patience, line: '你好', budget_low: 1, budget_high: 2, created_at: NOW,
  });
  repo.setDayCustomerCount(UID, 50);
  return { cardId, customerId };
}
const quick = (app: App, h: H, customerId: number, cardId: number) =>
  app.inject({ method: 'POST', url: `/api/counter/${customerId}/quick`, headers: { ...h, ...idem() }, payload: { instanceId: cardId } });

describe('派系纯函数（DESIGN 8.4）', () => {
  it('等级门槛、加减夹在范围内、治安倍数 0.5～1.5', () => {
    expect([tierOf(-31), tierOf(-30), tierOf(0), tierOf(29), tierOf(30), tierOf(69), tierOf(70)]).toEqual(['hostile', 'hostile', 'stranger', 'stranger', 'known', 'known', 'ally']);
    const zero = { guild: 0, black: 0, collectors: 0, police: 0 };
    expect(applyFaction(zero, 'reportCorrect').black).toBe(-15);
    expect(applyFaction(zero, 'reportFalse').black).toBe(-5);
    expect(applyFaction(zero, 'middlemanSale', 2)).toEqual({ guild: -2, black: 10, collectors: 0, police: 0 });
    expect(applyFaction({ ...zero, police: -95 }, 'patrolBribe').police).toBe(FACTIONS.min);
    expect([policeMult(-100), policeMult(0), policeMult(100)]).toEqual([1.5, 1, 0.5]);
  });
});

describe('派系接口（DESIGN 8.4）', () => {
  it('开局三个派系都是 0、陌生；不返回治安关系', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const r = await factions(app, h);
    expect(r.factions.map((f) => [f.id, f.value, f.tier])).toEqual([['guild', 0, 'stranger'], ['black', 0, 'stranger'], ['collectors', 0, 'stranger']]);
    expect(r.registryLeft).toBeNull();
    expect(findKeys(r, HIDDEN)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('治安关系');
  });

  it('卖给中间人：黑市 +5、商会 −1；卖真卡给普通客人商会 +1（每天最多 3 次，赃卡不算）；9 分封壳卖给收藏家：协会 +3', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    let s = seedSale(repo, 'middleman');
    expect((await quick(app, h, s.customerId, s.cardId)).json().outcome).toBe('deal');
    expect(rep(repo)).toMatchObject({ black: 5, guild: -1 });
    s = seedSale(repo, 'rich', { origin: 'stolen' });
    await quick(app, h, s.customerId, s.cardId);
    expect(rep(repo).guild).toBe(-1);
    for (let i = 0; i < 4; i += 1) {
      s = seedSale(repo, 'rich');
      expect((await quick(app, h, s.customerId, s.cardId)).json().outcome).toBe('deal');
    }
    expect(rep(repo).guild).toBe(-1 + FACTIONS.realSalePerDay);
    s = seedSale(repo, 'collector', { slab: '8' });
    await quick(app, h, s.customerId, s.cardId);
    expect(rep(repo).collectors).toBe(0);
    s = seedSale(repo, 'collector', { slab: '9' });
    expect((await quick(app, h, s.customerId, s.cardId)).json().outcome).toBe('deal');
    expect(rep(repo).collectors).toBe(3);
  });

  it('买黑市包：黑市 +2、商会 −1、治安 −1（每包）', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, rep_black = ?').run(FACTIONS.knownMin);
    const r = await app.inject({ method: 'POST', url: '/api/black/buy', headers: { ...h, ...idem() }, payload: { count: 2 } });
    expect(r.statusCode).toBe(200);
    expect(rep(repo)).toEqual({ guild: -2, black: FACTIONS.knownMin + 4, collectors: 0, police: -2 });
  });

  it('巡查打点治安 −10，交出 +2', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const a = repo.insertPatrol({ ownerId: UID, day: 1, cards: [], bribe: 100, now: NOW });
    await app.inject({ method: 'POST', url: `/api/patrol/${a}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'bribe' } });
    expect(rep(repo).police).toBe(-10);
    const b = repo.insertPatrol({ ownerId: UID, day: 1, cards: [], bribe: 100, now: NOW });
    const res = await app.inject({ method: 'POST', url: `/api/patrol/${b}/resolve`, headers: { ...h, ...idem() }, payload: { choice: 'surrender' } });
    expect(rep(repo)).toMatchObject({ police: -8, black: -5 });
    expect(findKeys(res.json(), HIDDEN)).toEqual([]);
  });

  it('正规商会盟友：电脑订货打折、每天多买 2 包', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET rep_guild = ?').run(FACTIONS.allyMin);
    const store = (await app.inject({ method: 'GET', url: '/api/store', headers: h })).json() as StoreResponse;
    expect(store.packsLeftToday).toBe(STORE.packsPerDay + FACTIONS.guildAlly.storePacks);
    const p = store.packs[0]!;
    expect(p.price).toBe(Math.round(PACKS[p.kind as keyof typeof PACKS].price * FACTIONS.guildAlly.storeDiscount));
    expect((await factions(app, h)).factions[0]!.perks[0]!.active).toBe(true);
  });

  it('黑市盟友查失窃登记表：每周 3 次，幂等；没到盟友不能查', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const card = (origin: string) => repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '7', origin, style: 'standard', serialNo: null, now: NOW });
    const stolen = card('stolen');
    const legit = card('legit');
    const check = (cardId: number, key = idem()) => app.inject({ method: 'POST', url: '/api/factions/registry', headers: { ...h, ...key }, payload: { cardId } });
    expect((await check(stolen)).json().code).toBe('locked');
    repo.db.prepare('UPDATE players SET rep_black = ?').run(FACTIONS.allyMin);
    expect((await factions(app, h)).registryLeft).toBe(FACTIONS.registryPerWeek);
    const key = idem();
    const a = (await check(stolen, key)).json() as RegistryResponse;
    expect(a).toEqual({ ok: true, cardId: stolen, onRegistry: true, registryLeft: 2 });
    expect((await check(stolen, key)).json()).toEqual(a);
    expect(findKeys(a, HIDDEN)).toEqual([]);
    expect(((await check(legit)).json() as RegistryResponse).onRegistry).toBe(false);
    await check(legit);
    expect((await check(legit)).json().code).toBe('weekly_limit');
  });
});

describe('黑市追杀（DESIGN 8.4）', () => {
  /** 接待完今天的客人、打烊 */
  const endDay = async (app: App, h: H) => {
    const counter = async () => (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    let s = await counter();
    while (s.current) { await app.inject({ method: 'POST', url: `/api/counter/${s.current.id}/dismiss`, headers: h }); s = await counter(); }
    return (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
  };

  it('阶段：−60 警告、−80 最后通牒、−100 被盯上', () => {
    expect([vendettaOf(-59), vendettaOf(-60), vendettaOf(-80), vendettaOf(-99), vendettaOf(-100)]).toEqual([null, 'warn', 'ultimatum', 'ultimatum', 'hunted']);
  });

  it('打烊时带上追杀阶段；被盯上后迟早被清理：等同破产，珍藏柜保留，黑市关系回到 afterHit', async () => {
    const { app, repo } = setup({ rng: seeded(5) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, shop_owned = 1, rep_black = ?').run(FACTIONS.vendetta.warnMax);
    expect((await endDay(app, h)).vendetta).toBe('warn');
    const kept = repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    repo.setLocation(kept, 'showcase');
    const lost = repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    repo.db.prepare('UPDATE players SET rep_black = ?').run(FACTIONS.vendetta.hitMax);
    let end: EndDayResponse | null = null;
    for (let i = 0; i < 60; i += 1) {
      end = await endDay(app, h);
      if (end.vendetta === 'hit') break;
      expect(end.vendetta).toBe('hunted');
    }
    expect(end!.vendetta).toBe('hit');
    expect(end!.patrol ?? null).toBeNull();
    const p = repo.getPlayer(UID)!;
    expect(p).toMatchObject({ credits: PLAYER.restartCredits, shop_owned: 0, rep_black: FACTIONS.vendetta.afterHit, run_start_day: end!.day });
    expect(repo.ownedInstance(UID, kept)).toBeTruthy();
    expect(repo.ownedInstance(UID, lost)).toBeFalsy();
    expect((await endDay(app, h)).vendetta).not.toBe('hit');
  });

  it('最后通牒可以交摆平费（当前周摊位费），黑市关系回到 tributeTo；没到最后通牒不能交', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const tribute = () => app.inject({ method: 'POST', url: '/api/factions/tribute', headers: { ...h, ...idem() } });
    repo.db.prepare('UPDATE players SET credits = 100000, rep_black = ?').run(FACTIONS.vendetta.warnMax);
    expect((await factions(app, h)).vendetta).toEqual({ stage: 'warn', tribute: null, hitPct: 25 });
    expect((await tribute()).json().code).toBe('not_needed');
    repo.db.prepare('UPDATE players SET rep_black = ?').run(FACTIONS.vendetta.ultimatumMax);
    const cost = rentForWeek(1);
    expect((await factions(app, h)).vendetta).toEqual({ stage: 'ultimatum', tribute: cost, hitPct: 25 });
    const r = (await tribute()).json() as TributeResponse;
    expect(r).toEqual({ ok: true, credits: 100000 - cost, paid: cost, black: FACTIONS.vendetta.tributeTo });
    expect(repo.getPlayer(UID)!.rep_black).toBe(FACTIONS.vendetta.tributeTo);
    expect((await factions(app, h)).vendetta).toBeNull();
  });
});
