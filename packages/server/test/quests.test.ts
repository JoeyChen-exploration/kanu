import { afterEach, describe, expect, it } from 'vitest';
import { PLAYER, QUESTS } from '@kanu/shared/balance';
import type { BuyPacksResponse, QuestClaimResponse, QuestsResponse } from '@kanu/shared/types';
import { HIDDEN_KEYS, findKeys, idem, login, setup } from './helpers.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
const quests = async (app: App, h: Record<string, string>) => ((await app.inject({ method: 'GET', url: '/api/quests', headers: h })).json() as QuestsResponse).quests;
const claim = (app: App, h: Record<string, string>, id: string, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/quests/${id}/claim`, headers: { ...h, ...key } });

describe('任务栏 / 新手指引（FR-UI-4）', () => {
  it('按顺序列出全部任务，进度从流水里数', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const before = await quests(app, h);
    expect(before.map((q) => q.id)).toEqual(QUESTS.map((q) => q.id));
    expect(before.every((q) => !q.done && !q.claimed)).toBe(true);
    // 新玩家自带一本卡册，"买卡册"任务要 2 本才算
    expect(before.find((q) => q.id === 'buy_binder')!.progress).toBe(1);

    const bought = (await app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { seriesId: 'NEO', count: 1 } })).json() as BuyPacksResponse;
    await app.inject({ method: 'POST', url: `/api/packs/${bought.packIds[0]}/open`, headers: { ...h, ...idem() } });
    const after = await quests(app, h);
    expect(after.find((q) => q.id === 'buy_pack')).toMatchObject({ progress: 1, done: true });
    expect(after.find((q) => q.id === 'open_pack')).toMatchObject({ progress: 1, done: true });
    expect(after.find((q) => q.id === 'collect_10')!.progress).toBeGreaterThan(0);
    expect(findKeys(after, HIDDEN_KEYS)).toEqual([]);
  });

  it('做完才能领；领奖加信用点、写流水；幂等；不能领两次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    expect((await claim(app, h, 'buy_pack')).json().code).toBe('not_done');
    expect((await claim(app, h, 'nope')).statusCode).toBe(404);

    await app.inject({ method: 'POST', url: '/api/store/buy', headers: { ...h, ...idem() }, payload: { seriesId: 'NEO', count: 1 } });
    const reward = QUESTS.find((q) => q.id === 'buy_pack')!.reward;
    const credits = repo.getPlayer('123456789012345678')!.credits;
    const key = idem();
    const r = (await claim(app, h, 'buy_pack', key)).json() as QuestClaimResponse;
    expect((await claim(app, h, 'buy_pack', key)).json()).toEqual(r);
    expect(r.credits).toBe(credits + reward);
    expect(r.quests.find((q) => q.id === 'buy_pack')).toMatchObject({ claimed: true });
    expect((await claim(app, h, 'buy_pack')).json().code).toBe('claimed');
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ delta: reward, why: 'quest', quest: 'buy_pack' });
    expect(PLAYER.startCredits).toBeGreaterThan(0);
  });
});
