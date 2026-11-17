import { afterEach, describe, expect, it } from 'vitest';
import { APPRAISAL, ERRATA, PHONE, REPUTATION } from '@kanu/shared/balance';
import type { BuyPhoneResponse, CardAppraisalResponse, EndDayResponse, GradeResponse, InventoryResponse, PhoneResponse } from '@kanu/shared/types';
import { gradeCard, inspect, loupeGrade, rollErrata } from '../src/game/appraisal.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
const HIDDEN = [...HIDDEN_KEYS, 'misprint'];
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
const add = (repo: Repo, o: { template?: string; authenticity?: string; grade?: string; misprint?: boolean; collect?: boolean } = {}) =>
  repo.insertCard({
    templateId: o.template ?? 'NEO-17', ownerId: UID, authenticity: o.authenticity ?? 'real', grade: o.grade ?? '9', origin: 'legit',
    style: 'standard', serialNo: null, now: NOW, collect: o.collect ?? false, misprint: o.misprint ?? false,
  });
const info = async (app: App, h: Record<string, string>, id: number) =>
  (await app.inject({ method: 'GET', url: `/api/cards/${id}/appraisal`, headers: h })).json() as CardAppraisalResponse;
const inspectReq = (app: App, h: Record<string, string>, id: number) =>
  app.inject({ method: 'POST', url: `/api/cards/${id}/inspect`, headers: h });
const buyPhone = (app: App, h: Record<string, string>, key = idem()) =>
  app.inject({ method: 'POST', url: '/api/phone/buy', headers: { ...h, ...key } });
const grade = (app: App, h: Record<string, string>, id: number, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/cards/${id}/grade`, headers: { ...h, ...key } });
/** 把今天的客人都请走再打烊 */
async function closeDay(app: App, h: Record<string, string>) {
  let state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
  while (state.current) {
    await app.inject({ method: 'POST', url: `/api/counter/${state.current.id}/dismiss`, headers: h });
    state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
  }
  return (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
}

describe('鉴定纯函数（DESIGN 5，2026-11-17 重定）', () => {
  it('放大镜：真卡总是"看起来是真的"；识破率、认错版率按 balance；估品相两档一定包含真实分', () => {
    const rng = seeded(3);
    const rate = (f: () => boolean) => { let n = 0; for (let i = 0; i < 20_000; i += 1) if (f()) n += 1; return n / 20_000; };
    expect(rate(() => inspect(rng, { authenticity: 'real', grade: '7', misprint: false }).looks === 'fake')).toBe(0);
    expect(rate(() => inspect(rng, { authenticity: 'low_fake', grade: '7', misprint: false }).looks === 'fake')).toBeCloseTo(APPRAISAL.loupeDetect.low_fake / 1e6, 1);
    expect(rate(() => inspect(rng, { authenticity: 'high_fake', grade: '7', misprint: false }).looks === 'fake')).toBeCloseTo(APPRAISAL.loupeDetect.high_fake / 1e6, 1);
    expect(rate(() => inspect(rng, { authenticity: 'real', grade: '7', misprint: true }).errataFound)).toBeCloseTo(APPRAISAL.errataDetect / 1e6, 1);
    expect(rate(() => inspect(rng, { authenticity: 'real', grade: '7', misprint: false }).errataFound)).toBe(0);
    expect(rate(() => rollErrata(rng))).toBeCloseTo(ERRATA.ppm / 1e6, 2);
    for (const g of ['1', '5', '9', '10', 'BL']) for (let i = 0; i < 50; i += 1) expect(loupeGrade(rng, g)).toContain(g);
    expect(loupeGrade(rng, 'BL')).toEqual(['10', 'BL']);
  });

  it('送评：真卡分数就是真实品相、错版公开认定；黑标四项全 10；假卡拒评', () => {
    const rng = seeded(9);
    const r = gradeCard(rng, { authenticity: 'real', grade: '8', misprint: true });
    expect(r.kind === 'slab' && r.slab).toMatchObject({ score: '8', errata: true });
    const bl = gradeCard(rng, { authenticity: 'real', grade: 'BL', misprint: false });
    expect(bl.kind === 'slab' && Object.values(bl.slab.subgrades)).toEqual([10, 10, 10, 10]);
    expect(gradeCard(rng, { authenticity: 'high_fake', grade: '10', misprint: false }).kind).toBe('rejected');
  });
});

describe('放大镜（柜台道具）', () => {
  it('免费；每张卡只查一次，再拖上去还是同一个结论；不改卡价；响应里没有隐藏属性', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo, { grade: '9', misprint: true });
    const credits = repo.getPlayer(UID)!.credits;
    const price = (await info(app, h, id)).card.price;
    const a = (await inspectReq(app, h, id)).json() as CardAppraisalResponse;
    expect(a.inspection!.looks).toBe('looks_real');
    expect(a.inspection!.gradeRange).toContain('9');
    expect(a.canInspect).toBe(false);
    expect((await inspectReq(app, h, id)).json()).toEqual(a);
    expect(repo.getPlayer(UID)!.credits).toBe(credits);
    expect(a.card.price).toBe(price);
    expect(findKeys(a, HIDDEN)).toEqual([]);
  });
});

describe('电话 + 送评（星港评级社）', () => {
  it('没电话不能送评；买电话扣钱写流水、幂等、不能买两次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const id = add(repo);
    expect((await grade(app, h, id)).json().code).toBe('no_phone');
    const key = idem();
    const r = (await buyPhone(app, h, key)).json() as BuyPhoneResponse;
    expect((await buyPhone(app, h, key)).json()).toEqual(r);
    expect(r.credits).toBe(100000 - PHONE.price);
    expect((await buyPhone(app, h)).json().code).toBe('owned');
    const phone = (await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse;
    expect(phone.owned).toBe(true);
  });

  it('送评：送走不能卖；打烊出结果；真卡封壳按分定价、错版公开 × 倍数、点亮图鉴；假卡拒评扣信誉', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, phone = 1').run();
    const real = add(repo, { grade: '9', misprint: true });
    const fake = add(repo, { authenticity: 'high_fake', template: 'NEO-18' });
    const ungraded = (await info(app, h, real)).card.price;
    const g = (await grade(app, h, real)).json() as GradeResponse;
    expect(g.card).toMatchObject({ location: 'grading' });
    await grade(app, h, fake);
    expect(repo.sellableCards(UID).map((c) => c.id)).not.toContain(real);
    expect((await inspectReq(app, h, real)).json().code).toBe('cannot_inspect');
    expect((await grade(app, h, real)).json().code).toBe('cannot_grade');
    const phone = (await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse;
    expect(phone.grading.map((c) => c.id).sort()).toEqual([real, fake].sort());
    expect(findKeys(phone, HIDDEN)).toEqual([]);
    const rep = repo.getPlayer(UID)!.reputation;

    const end = await closeDay(app, h);
    expect(end.appraisals.find((a) => a.cardId === real)).toMatchObject({ outcome: 'slab', score: '9', errata: true });
    expect(end.appraisals.find((a) => a.cardId === fake)).toMatchObject({ outcome: 'rejected' });
    const slabbed = (await info(app, h, real)).card;
    expect(slabbed.slab).toMatchObject({ score: '9', errata: true });
    // 9 分系数 2.0、未评级 0.85，错版再 × ERRATA.mult
    expect(slabbed.price).toBe(Math.round((ungraded / 0.85) * 2 * ERRATA.mult));
    expect((await info(app, h, real)).canGrade).toBe(false);
    expect((await info(app, h, fake)).card.gradeRejected).toBe(true);
    expect(repo.getPlayer(UID)!.reputation).toBe(Math.max(REPUTATION.min, rep - APPRAISAL.gradeRejectRepLoss));
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory?location=inventory', headers: h })).json() as InventoryResponse;
    expect(inv.cards.map((c) => c.id)).toEqual(expect.arrayContaining([real, fake]));
    // 来路不明的真卡封壳后点亮图鉴，被拒评的不点亮
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const neo = coll.series.find((s: { id: string }) => s.id === 'NEO');
    expect(neo.cards.find((c: { templateId: string }) => c.templateId === 'NEO-17').owned).toBe(true);
    expect(neo.cards.find((c: { templateId: string }) => c.templateId === 'NEO-18').owned).toBe(false);
    expect(findKeys(end, HIDDEN)).toEqual([]);
  });

  it('钱不够、别人的卡都拒绝', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo, { template: 'ELT-20' });
    repo.db.prepare('UPDATE players SET credits = 0, phone = 1').run();
    expect((await grade(app, h, id)).json().code).toBe('insufficient_credits');
    expect((await inspectReq(app, h, 999_999)).statusCode).toBe(404);
  });
});
