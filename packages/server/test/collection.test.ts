import { afterEach, describe, expect, it } from 'vitest';
import { STYLES, stylesFor } from '@kanu/shared/balance';
import type { CollectionResponse } from '@kanu/shared/types';
import { HIDDEN_KEYS, NOW, findKeys, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type Repo = ReturnType<typeof setup>['repo'];
const add = (repo: Repo, templateId: string, style: string, authenticity = 'real') =>
  repo.insertCard({ templateId, ownerId: UID, authenticity, grade: '7', origin: 'legit', style: style as 'standard', serialNo: style === 'serial' ? 1 : null, now: NOW });

describe('图鉴：五本册 + 大师图鉴（DESIGN 3.6，FR-INV-5、FR-INV-12）', () => {
  it('每个稀有度只列可能出的风格：N 没有暗物质和编号，SSR 六种都有', () => {
    expect(stylesFor('N')).not.toContain('dark');
    expect(stylesFor('N')).not.toContain('serial');
    expect(stylesFor('SR')).toContain('dark');
    expect(stylesFor('SR')).not.toContain('serial');
    expect(stylesFor('SSR')).toEqual([...STYLES]);
  });

  it('每种风格有过就点亮（卖掉也算），手上几张分开数；全部风格都有过才算大师', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const n = 'NEO-01';
    const nStyles = stylesFor('N');
    const ids = nStyles.map((s) => add(repo, n, s));
    add(repo, n, 'holo');
    repo.deleteCard(ids[0]!); // 卖掉标准框那张，仍然算有过

    const body = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json() as CollectionResponse;
    expect(body.series).toHaveLength(5);
    const neo = body.series.find((s) => s.id === 'NEO')!;
    const card = neo.cards.find((c) => c.templateId === n)!;
    expect(card.styles.map((s) => s.style)).toEqual(nStyles);
    expect(card.styles.find((s) => s.style === 'standard')).toMatchObject({ owned: true, count: 0 });
    expect(card.styles.find((s) => s.style === 'holo')).toMatchObject({ owned: true, count: 2 });
    expect(card.master).toBe(true);
    expect(neo.master).toBe(1);
    expect(neo.kind).toBe('themed');
    expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });

  it('只差一种风格就不算大师；假卡不点亮', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    add(repo, 'NEO-01', 'standard');
    add(repo, 'NEO-01', 'holo', 'low_fake');
    const body = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json() as CollectionResponse;
    const card = body.series.find((s) => s.id === 'NEO')!.cards.find((c) => c.templateId === 'NEO-01')!;
    expect(card.styles.find((s) => s.style === 'holo')!.owned).toBe(false);
    expect(card.master).toBe(false);
  });
});
