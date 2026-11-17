import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOMER, PLAYER, SHOWCASE } from '@kanu/shared/balance';
import type { CounterResponse, ShowcaseResponse, ShowcaseUpgradeResponse } from '@kanu/shared/types';
import { showcaseEffects, showcaseScore, showcaseSlots } from '../src/game/showcase.ts';
import { rollCustomer } from '../src/game/customers.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
const upgrade = (app: App, h: Record<string, string>, key = idem()) =>
  app.inject({ method: 'POST', url: '/api/showcase/upgrade', headers: { ...h, ...key } });
const status = async (app: App, h: Record<string, string>) =>
  ((await app.inject({ method: 'GET', url: '/api/showcase', headers: h })).json() as ShowcaseResponse).status;

describe('珍藏柜展示分（FR-INV-11，纯函数）', () => {
  it('稀有度分 × 风格倍数，加起来', () => {
    expect(showcaseScore([])).toBe(0);
    expect(showcaseScore([{ rarity: 'UR', style: 'standard' }, { rarity: 'SR', style: 'standard' }])).toBe(SHOWCASE.rarityScore.UR + SHOWCASE.rarityScore.SR);
    expect(showcaseScore([{ rarity: 'SSR', style: 'holo' }])).toBe(Math.round(SHOWCASE.rarityScore.SSR * 1.5));
    expect(showcaseScore([{ rarity: 'N', style: 'gold' }])).toBe(0);
  });

  it('每 pointsPerPct 分 +1%（不足的不算），封顶；到门槛耐心 +1', () => {
    expect(showcaseEffects(0)).toEqual({ priceMult: 1, patienceBonus: 0 });
    expect(showcaseEffects(SHOWCASE.pointsPerPct * 3 + SHOWCASE.pointsPerPct - 1).priceMult).toBeCloseTo(1.03);
    expect(showcaseEffects(100_000).priceMult).toBeCloseTo(1 + SHOWCASE.maxPriceBonus);
    expect(showcaseEffects(SHOWCASE.patienceAt - 1).patienceBonus).toBe(0);
    expect(showcaseEffects(SHOWCASE.patienceAt).patienceBonus).toBe(SHOWCASE.patienceBonus);
    expect(showcaseSlots(0)).toBe(0);
    expect(showcaseSlots(99)).toBe(SHOWCASE.levels.at(-1)!.slots);
  });

  it('顾客的预算、心理价位（float）、耐心吃加成', () => {
    const input = { inventory: [], packs: [], templates: [{ id: 'NEO-01', name: 'x', rarity: 'N' as const, tags: [] }], series: [{ id: 'NEO', name: 'n', price: 300 }], typicalPrice: () => 1000, forceType: 'rich' as const };
    const base = rollCustomer(seeded(7), input);
    const boosted = rollCustomer(seeded(7), { ...input, showcase: { priceMult: 1.1, patienceBonus: 1 } });
    expect(boosted.float).toBeCloseTo(base.float * 1.1);
    expect(boosted.budgetHigh).toBeGreaterThan(base.budgetHigh);
    expect(boosted.patience).toBe(CUSTOMER.rich.patience + 1);
  });
});

describe('珍藏柜解锁和升级（FR-INV-11）', () => {
  it('开局没有；解锁、升级扣钱写流水，幂等；满级不能再升', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    expect(await status(app, h)).toMatchObject({ level: 0, slots: 0, used: 0, next: { level: 1, price: SHOWCASE.levels[1]!.price } });
    repo.db.prepare(`UPDATE players SET credits = ${SHOWCASE.levels[1]!.price - 1}`).run();
    expect((await upgrade(app, h)).json().code).toBe('insufficient_credits');
    expect(PLAYER.startCredits).toBeGreaterThan(0);

    repo.db.prepare('UPDATE players SET credits = 1000000').run();
    const key = idem();
    const r = (await upgrade(app, h, key)).json() as ShowcaseUpgradeResponse;
    expect((await upgrade(app, h, key)).json()).toEqual(r);
    expect(r.status).toMatchObject({ level: 1, slots: SHOWCASE.levels[1]!.slots });
    expect(r.credits).toBe(1_000_000 - SHOWCASE.levels[1]!.price);
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: -SHOWCASE.levels[1]!.price, why: 'showcase' });

    for (let lv = 2; lv < SHOWCASE.levels.length; lv += 1) await upgrade(app, h);
    const top = await status(app, h);
    expect(top).toMatchObject({ level: SHOWCASE.levels.length - 1, next: null });
    expect((await upgrade(app, h)).json().code).toBe('max_level');
  });

  it('放进珍藏柜的卡算展示分；顾客进门时吃到加成；响应里没有隐藏属性', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.setShowcaseLevel(UID, 1);
    const ids = ['NEO-19', 'NEO-20'].map((t) => repo.insertCard({ templateId: t, ownerId: UID, authenticity: 'high_fake', grade: '3', origin: 'stolen', style: 'standard', serialNo: null, now: NOW }));
    for (const id of ids) await app.inject({ method: 'POST', url: `/api/inventory/${id}/showcase`, headers: h, payload: { on: true } });
    const s = await status(app, h);
    expect(s.used).toBe(2);
    expect(s.score).toBeGreaterThan(0);
    expect(s.priceBonusPct).toBe(Math.min(SHOWCASE.maxPriceBonus * 100, Math.floor(s.score / SHOWCASE.pointsPerPct)));

    const counter = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    const c = counter.current!;
    expect(c.maxPatience).toBe(CUSTOMER[c.type as 'rich'].patience + s.patienceBonus);
    const body = (await app.inject({ method: 'GET', url: '/api/showcase', headers: h })).json();
    expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });
});
