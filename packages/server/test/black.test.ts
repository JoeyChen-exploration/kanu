import { afterEach, describe, expect, it } from 'vitest';
import { BLACK_MARKET, FACTIONS, PACKS } from '@kanu/shared/balance';
import type { BlackBuyResponse, BlackMarketResponse, OpenPackResponse, SealedPacksResponse } from '@kanu/shared/types';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
type H = Record<string, string>;
const info = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/black', headers: h })).json() as BlackMarketResponse;
const buy = (app: App, h: H, count: number, key = idem()) => app.inject({ method: 'POST', url: '/api/black/buy', headers: { ...h, ...key }, payload: { count } });
/** 直接设黑市关系值 */
const setBlack = (repo: Repo, v: number) => repo.db.prepare('UPDATE players SET rep_black = ?').run(v);

describe('黑市卡包（DESIGN 4）', () => {
  it(`黑市关系到熟脸（${FACTIONS.knownMin}）才解锁`, async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    expect(await info(app, h)).toMatchObject({ unlocked: false, progress: { current: 0, target: FACTIONS.knownMin }, price: PACKS.black.price, fakePct: 25, stolenPct: 20 });
    expect((await buy(app, h, 1)).json().code).toBe('locked');
    setBlack(repo, FACTIONS.knownMin - 1);
    expect((await info(app, h)).unlocked).toBe(false);
    setBlack(repo, FACTIONS.knownMin);
    expect((await info(app, h)).unlocked).toBe(true);
  });

  it('每个营业日最多 3 包（和电脑订货分开算），幂等，第二天重置；不在电脑订货里出现', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    setBlack(repo, FACTIONS.knownMin);
    const key = idem();
    const r = (await buy(app, h, 2, key)).json() as BlackBuyResponse;
    expect((await buy(app, h, 2, key)).json()).toEqual(r);
    expect(r).toMatchObject({ credits: 100000 - 2 * PACKS.black.price, leftToday: BLACK_MARKET.perDay - 2 });
    expect(r.packIds).toHaveLength(2);
    expect((await buy(app, h, 2)).json().code).toBe('daily_limit');
    expect((await buy(app, h, 1)).json().leftToday).toBe(0);
    // 电脑订货的限购不受影响，列表里也没有黑市包
    const store = (await app.inject({ method: 'GET', url: '/api/store', headers: h })).json();
    expect(store.packsLeftToday).toBe(5);
    expect(store.packs.some((p: { seriesId: string }) => p.seriesId === BLACK_MARKET.seriesId)).toBe(false);
    // 我的卡包里单独一组
    const sealed = (await app.inject({ method: 'GET', url: '/api/packs', headers: h })).json() as SealedPacksResponse;
    expect(sealed.groups).toEqual([expect.objectContaining({ seriesId: BLACK_MARKET.seriesId, black: true, ids: expect.any(Array) })]);
    repo.db.prepare('UPDATE players SET game_day = game_day + 1').run();
    expect((await info(app, h)).leftToday).toBe(BLACK_MARKET.perDay);
  });

  it('拆黑市包：所有系列的卡都可能出，带"黑"字，图鉴不点亮，不动保底；假卡和赃物大约按 PACKS.black', async () => {
    const { app, repo } = setup({ rng: seeded(13) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, pity_count = 4').run();
    for (let i = 0; i < 200; i += 1) repo.insertSealed(UID, BLACK_MARKET.seriesId, 'black', NOW);
    repo.db.prepare("UPDATE binders SET kind = 'leather'").run();
    for (let i = 0; i < 3; i += 1) repo.insertBinder(UID, 'leather', NOW);
    let first: OpenPackResponse | null = null;
    for (const p of repo.sealedByOwner(UID)) {
      const r = (await app.inject({ method: 'POST', url: `/api/packs/${p.id}/open`, headers: { ...h, ...idem() } })).json() as OpenPackResponse;
      first ??= r;
    }
    expect(first!.cards).toHaveLength(PACKS.black.cards);
    expect(first!.cards.every((c) => c.acquired === 'black')).toBe(true);
    expect(first!.pityCount).toBe(4);
    expect(findKeys(first, HIDDEN_KEYS)).toEqual([]);
    const rows = repo.db.prepare("SELECT i.authenticity, i.origin, t.series_id FROM card_instances i JOIN card_templates t ON t.id = i.template_id WHERE i.owner_id = ? AND i.acquired = 'black'").all(UID) as Array<{ authenticity: string; origin: string; series_id: string }>;
    expect(rows).toHaveLength(1000);
    const fake = rows.filter((x) => x.authenticity !== 'real').length / rows.length;
    const stolen = rows.filter((x) => x.origin === 'stolen').length / rows.length;
    expect(fake).toBeGreaterThan(PACKS.black.fakePpm / 1e6 - 0.04);
    expect(fake).toBeLessThan(PACKS.black.fakePpm / 1e6 + 0.04);
    expect(stolen).toBeGreaterThan(PACKS.black.stolenPpm / 1e6 - 0.04);
    expect(stolen).toBeLessThan(PACKS.black.stolenPpm / 1e6 + 0.04);
    expect(new Set(rows.map((x) => x.series_id)).size).toBeGreaterThanOrEqual(4);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM collection WHERE discord_id = ?').get(UID)).toEqual({ n: 0 });
  });
});
