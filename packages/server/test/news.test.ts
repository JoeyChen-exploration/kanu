import { afterEach, describe, expect, it } from 'vitest';
import { NEWS, CUSTOMER } from '@kanu/shared/balance';
import type { AdminNewsItem, AdminNewsResponse, NewsResponse } from '@kanu/shared/types';
import { newsEffects, rollNews, NEWS_KINDS } from '../src/game/news.ts';
import { rollCustomer } from '../src/game/customers.ts';
import { newsTemplates } from '../src/news.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const HIDDEN = [...HIDDEN_KEYS, 'real', 'mult', 'kind', 'target', 'template'];
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type H = Record<string, string>;
const news = async (app: App, h: H) => (await app.inject({ method: 'GET', url: '/api/news', headers: h })).json() as NewsResponse;
const publish = async (app: App, h: H, body: object) => (await app.inject({ method: 'POST', url: '/api/admin/news', headers: { ...h, ...idem() }, payload: body })).json() as { ok: true; item: AdminNewsItem };

describe('新闻纯函数（DESIGN 8.2）', () => {
  const input = { templates: newsTemplates(), series: [{ id: 'NEO', name: '霓虹街头' }, { id: 'SEA', name: '深海星港' }], tags: ['龙', '火'] };

  it('模板覆盖四种新闻；文案替换系列名 / 标签；数值在 balance 的区间里', () => {
    expect(new Set(newsTemplates().map((t) => t.kind))).toEqual(new Set(NEWS_KINDS));
    const rng = seeded(7);
    for (let i = 0; i < 500; i += 1) {
      const n = rollNews(rng, input);
      expect(n.days).toBeGreaterThanOrEqual(NEWS.days[0]);
      expect(n.days).toBeLessThanOrEqual(NEWS.days[1]);
      expect(n.title + n.body).not.toMatch(/\{(series|tag)\}/);
      if (n.kind === 'price_up') expect(n.mult).toBeGreaterThanOrEqual(NEWS.priceUp[0]);
      if (n.kind === 'price_down') expect(n.mult).toBeLessThanOrEqual(NEWS.priceDown[1]);
      if (n.kind === 'police') expect(n.mult).toBe(NEWS.policeMult);
      if (n.source === 'official') expect(n.real).toBe(true);
    }
  });

  it('大约 15% 是谣言（只会出现在小道消息里）', () => {
    const rng = seeded(11);
    const all = Array.from({ length: 20_000 }, () => rollNews(rng, input));
    const fake = all.filter((n) => !n.real).length / all.length;
    expect(fake).toBeGreaterThan(0.13);
    expect(fake).toBeLessThan(0.17);
    expect(all.filter((n) => n.source === 'rumor' && n.real).length).toBeGreaterThan(0);
  });

  it('效果合并：同系列价格相乘，标签去重，巡查取最大', () => {
    expect(newsEffects([
      { kind: 'price_up', target: 'NEO', mult: 1.5 }, { kind: 'price_down', target: 'NEO', mult: 0.8 },
      { kind: 'demand', target: '龙', mult: 1 }, { kind: 'demand', target: '龙', mult: 1 }, { kind: 'police', target: null, mult: 2 },
    ])).toEqual({ seriesMult: { NEO: 1.2 }, hotTags: ['龙'], policeMult: 2 });
  });

  it('带火的标签：收藏家点名这个标签的次数明显变多', () => {
    const roll = (hotTags: string[], seed: number) => {
      const rng = seeded(seed);
      let n = 0;
      for (let i = 0; i < 3000; i += 1) {
        const c = rollCustomer(rng, { inventory: [], packs: [], templates: [{ id: 'X', name: 'x', rarity: 'SR', tags: ['龙', '火', '水', '电'] }], series: [{ id: 'NEO', name: 'n', price: 300 }], typicalPrice: () => 1000, forceType: 'collector', hotTags });
        if (c.demand.kind === 'card' && c.demand.tag === '龙') n += 1;
      }
      return n;
    };
    expect(CUSTOMER.collector.wants.kind).toBe('card');
    expect(roll(['龙'], 3)).toBeGreaterThan(roll([], 3) * 1.8);
  });
});

describe('空间站日报（DESIGN 8.2）', () => {
  it('悉尼 8 点以前不发；8 点以后第一次请求发一条，发到频道，一天只发一条；响应里没有真假', async () => {
    let t = NOW - 12 * HOUR; // NOW 是悉尼 19:00，往前 12 小时是 07:00
    const { app, announced } = setup({ news: seeded(5), now: () => t });
    cleanup = () => app.close();
    let h = await login(app);
    expect((await news(app, h)).items).toEqual([]);
    t = NOW - 11 * HOUR; // 08:00
    const r = await news(app, h);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.date).toBe(r.today);
    expect(announced.filter((a) => a.includes('空间站日报'))).toHaveLength(1);
    t = NOW;
    expect((await news(app, h)).items).toHaveLength(1);
    expect(findKeys(r, HIDDEN)).toEqual([]);
    t = NOW + DAY;
    h = await login(app); // 会话按时间过期，拨钟以后重新登录
    expect((await news(app, h)).items).toHaveLength(2);
  });

  it('价格新闻第二天起生效：这个系列的市场价乘新闻系数，到期恢复；假新闻没效果', async () => {
    let t = NOW;
    const { app, repo } = setup({ admin: UID, now: () => t });
    cleanup = () => app.close();
    let h = await login(app);
    const card = repo.insertCard({ templateId: 'NEO-17', ownerId: UID, authenticity: 'real', grade: '7', origin: 'legit', style: 'standard', serialNo: null, now: NOW });
    const base = repo.cardView(card)!.price;
    const fake = await publish(app, h, { templateId: 'plate-fire', target: 'NEO', real: false, source: 'rumor' });
    const real = await publish(app, h, { templateId: 'reprint', target: 'NEO', real: true });
    expect(fake.item.real).toBe(false);
    expect(repo.cardView(card)!.price).toBe(base); // 当天还没生效
    t = NOW + DAY;
    await news(app, h);
    expect(repo.cardView(card)!.price).toBe(Math.round(base * real.item.mult));
    t = NOW + 4 * DAY;
    await news(app, h);
    expect(repo.cardView(card)!.price).toBe(base);
  });

  it('执法新闻：巡查和便衣倍数；只有管理员能手动发', async () => {
    let t = NOW;
    const { app, repo } = setup({ admin: UID, now: () => t });
    cleanup = () => app.close();
    let h = await login(app);
    await publish(app, h, { templateId: 'crackdown', real: true });
    t = NOW + DAY;
    h = await login(app);
    await news(app, h);
    expect(repo.newsEffects().policeMult).toBe(NEWS.policeMult);
    const admin = (await app.inject({ method: 'GET', url: '/api/admin/news', headers: h })).json() as AdminNewsResponse;
    expect(admin.items[0]).toMatchObject({ kind: 'police', real: true, manual: true });
    expect((await publish(app, h, { templateId: 'nope' })) as unknown as { code: string }).toMatchObject({ code: 'bad_news' });
  });

  it('不是管理员不能发、不能看管理页', async () => {
    const { app } = setup();
    cleanup = () => app.close();
    let h = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/admin/news', headers: h, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/news', headers: h })).statusCode).toBe(403);
  });
});
