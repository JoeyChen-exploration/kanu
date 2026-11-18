import { afterEach, describe, expect, it } from 'vitest';
import { BINDERS, LOOSE, PACKS, PLAYER, STARTER_BINDER } from '@kanu/shared/balance';
import type { BinderPageResponse, BindersResponse, BuyBinderResponse, BuyPacksResponse } from '@kanu/shared/types';
import { gradeDown, wearOnce } from '../src/game/wear.ts';
import { seeded, type Rng } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
const binders = async (app: App, h: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/binders', headers: h })).json() as BindersResponse;
const buyBinder = (app: App, h: Record<string, string>, kind: string, key = idem()) =>
  app.inject({ method: 'POST', url: '/api/binders/buy', headers: { ...h, ...key }, payload: { kind } });
const addCards = (repo: Repo, n: number, template = 'NEO-01') =>
  Array.from({ length: n }, () => repo.insertCard({ templateId: template, ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW }));

describe('卡册（DESIGN 4.5）', () => {
  it('第一次登录送一本简易卡册；用品店列出 4 种卡册', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const b = await binders(app, h);
    expect(b.binders).toHaveLength(1);
    expect(b.binders[0]).toMatchObject({ kind: STARTER_BINDER, slots: BINDERS.basic.slots, used: 0 });
    expect(b.catalog.map((c) => c.kind)).toEqual(['basic', 'grid', 'humidor', 'leather']);
    expect(b.loose).toEqual({ slots: LOOSE.slots, cards: [] });
  });

  it('拆包时新卡先放进有空位的卡册，满了才散放在桌面上', async () => {
    const { app, repo } = setup({ devAuth: true, unlimited: UID });
    cleanup = () => app.close();
    const h = await login(app);
    addCards(repo, BINDERS.basic.slots - 2);
    repo.db.prepare('UPDATE card_instances SET binder_id = (SELECT id FROM binders LIMIT 1)').run();
    const bought = (await app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { seriesId: 'NEO', count: 1 } })).json() as BuyPacksResponse;
    await app.inject({ method: 'POST', url: `/api/packs/${bought.packIds[0]}/open`, headers: { ...h, ...idem() } });
    const b = await binders(app, h);
    expect(b.binders[0]!.used).toBe(BINDERS.basic.slots);
    expect(b.loose.cards).toHaveLength(3);
    expect(b.loose.cards.every((c) => c.looseSinceDay === 1 && c.binderId === null)).toBe(true);
  });

  it('卡册和桌面都放不下一包时不让拆', async () => {
    const { app, repo } = setup({ devAuth: true, unlimited: UID });
    cleanup = () => app.close();
    const h = await login(app);
    addCards(repo, BINDERS.basic.slots + LOOSE.slots - 2);
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    const bought = (await app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { seriesId: 'NEO', count: 1 } })).json() as BuyPacksResponse;
    const res = await app.inject({ method: 'POST', url: `/api/packs/${bought.packIds[0]}/open`, headers: { ...h, ...idem() } });
    expect(res.json().code).toBe('no_space');
    expect(repo.sealedByOwner(UID)).toHaveLength(1);
  });

  it('买卡册：扣钱、写流水、自动把桌面散卡收进去；幂等', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 10000').run();
    addCards(repo, 40);
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    expect((await binders(app, h)).loose.cards).toHaveLength(40 - BINDERS.basic.slots);
    const key = idem();
    const r = (await buyBinder(app, h, 'grid', key)).json() as BuyBinderResponse;
    expect((await buyBinder(app, h, 'grid', key)).json()).toEqual(r);
    expect(r.credits).toBe(10000 - BINDERS.grid.price);
    expect(r.placed).toBe(40 - BINDERS.basic.slots);
    expect((await binders(app, h)).loose.cards).toHaveLength(0);
    expect(repo.bindersOf(UID)).toHaveLength(2);
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: -BINDERS.grid.price, why: 'binder' });
  });

  it('钱不够、没有这种卡册，都拒绝', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    expect((await buyBinder(app, h, 'leather')).json().code).toBe('insufficient_credits');
    expect((await buyBinder(app, h, 'gold')).json().code).toBe('bad_binder');
  });

  it('翻卡册：一页 9 张', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    addCards(repo, 12);
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    const id = (await binders(app, h)).binders[0]!.id;
    const p1 = (await app.inject({ method: 'GET', url: `/api/binders/${id}?page=1`, headers: h })).json() as BinderPageResponse;
    const p2 = (await app.inject({ method: 'GET', url: `/api/binders/${id}?page=2`, headers: h })).json() as BinderPageResponse;
    expect(p1.cards).toHaveLength(9);
    expect(p2.cards).toHaveLength(3);
    expect(p1.pages).toBe(3);
  });

  it('卡册按稀有度从高到低排，同一张卡挨在一起', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const pick = (r: string) => (repo.db.prepare("SELECT id FROM card_templates WHERE series_id = 'NEO' AND rarity = ? ORDER BY id LIMIT 1").get(r) as { id: string }).id;
    for (const r of ['N', 'SR', 'R', 'N', 'SSR', 'R', 'N']) addCards(repo, 1, pick(r));
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    const id = (await binders(app, h)).binders[0]!.id;
    const p = (await app.inject({ method: 'GET', url: `/api/binders/${id}?page=1`, headers: h })).json() as BinderPageResponse;
    expect(p.cards.map((c) => c.rarity)).toEqual(['SSR', 'SR', 'R', 'R', 'N', 'N', 'N']);
  });

  it('打烊时只有桌面散卡会磨损（品相是隐藏的，响应里看不到）', async () => {
    const always: Rng = { int: () => 0 };
    const { app, repo } = setup({ rng: always });
    cleanup = () => app.close();
    const h = await login(app);
    const ids = addCards(repo, BINDERS.basic.slots + 2);
    await app.inject({ method: 'POST', url: '/api/binders/organize', headers: h });
    // 把今天的顾客都请走再打烊
    let state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
    while (state.current) { await app.inject({ method: 'POST', url: `/api/counter/${state.current.id}/dismiss`, headers: h }); state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json(); }
    const end = await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    expect(end.statusCode).toBe(200);
    const grades = ids.map((id) => repo.ownedInstance(UID, id)!);
    expect(grades.filter((g) => g.binder_id === null).every((g) => g.grade === '6')).toBe(true);
    expect(grades.filter((g) => g.binder_id !== null).every((g) => g.grade === '7')).toBe(true);
    for (const body of [await binders(app, h), end.json()]) expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });

  it('磨损：黑标掉成 10，最低 1 分；按概率掉', () => {
    expect(gradeDown('BL')).toBe('10');
    expect(gradeDown('1')).toBe('1');
    expect(gradeDown('8')).toBe('7');
    const rng = seeded(4);
    let worn = 0;
    for (let i = 0; i < 20_000; i += 1) if (wearOnce(rng, '8') !== '8') worn += 1;
    expect(worn / 20_000).toBeCloseTo(LOOSE.wearPpm / 1e6, 2);
  });

  it('放在防潮收藏册里的卡卖给收藏家更贵；典藏皮面册每天多来 1 位收藏家', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const [cardId] = addCards(repo, 1, 'NEO-17');
    const humidor = (await buyBinder(app, h, 'humidor')).json() as BuyBinderResponse;
    repo.placeCard(cardId!, humidor.binder.id, null);
    const svc = (await import('../src/binders.ts')).createBinderService(repo, seeded(1));
    expect(svc.priceMultiplier(UID, humidor.binder.id, 'collector')).toBeCloseTo(1 + BINDERS.humidor.collectorBonus);
    expect(svc.priceMultiplier(UID, humidor.binder.id, 'rich')).toBe(1);
    expect(svc.extraCollectors(UID)).toBe(0);
    await buyBinder(app, h, 'leather');
    expect(svc.extraCollectors(UID)).toBe(BINDERS.leather.extraCollectors);
    expect(PLAYER.startCredits).toBeGreaterThan(0);
    expect(PACKS.themed.cards).toBe(5);
  });
});
