import { afterEach, describe, expect, it } from 'vitest';
import { APPRAISAL, REPUTATION } from '@kanu/shared/balance';
import type { AppraiseResponse, AppraisalDeskResponse, CardAppraisalResponse, EndDayResponse, InventoryResponse } from '@kanu/shared/types';
import { eyeAuth, eyeGrade, gradeCard, labVerdict, loupeAuth, loupeGrade } from '../src/game/appraisal.ts';
import { loupeFee } from '../src/game/price.ts';
import { seeded } from '../src/game/rng.ts';
import { HIDDEN_KEYS, NOW, findKeys, idem, login, setup } from './helpers.ts';

const UID = '123456789012345678';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

type App = ReturnType<typeof setup>['app'];
type Repo = ReturnType<typeof setup>['repo'];
const add = (repo: Repo, o: { template?: string; authenticity?: string; grade?: string; origin?: string } = {}) =>
  repo.insertCard({ templateId: o.template ?? 'NEO-17', ownerId: UID, authenticity: o.authenticity ?? 'real', grade: o.grade ?? '9', origin: o.origin ?? 'legit', style: 'standard', serialNo: null, now: NOW, collect: false });
const appraise = (app: App, h: Record<string, string>, id: number, method: string, key = idem()) =>
  app.inject({ method: 'POST', url: `/api/cards/${id}/appraise`, headers: { ...h, ...key }, payload: { method } });
const info = async (app: App, h: Record<string, string>, id: number) =>
  (await app.inject({ method: 'GET', url: `/api/cards/${id}/appraisal`, headers: h })).json() as CardAppraisalResponse;
/** 把今天的客人都请走再打烊 */
async function closeDay(app: App, h: Record<string, string>) {
  let state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
  while (state.current) {
    await app.inject({ method: 'POST', url: `/api/counter/${state.current.id}/dismiss`, headers: h });
    state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json();
  }
  return (await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } })).json() as EndDayResponse;
}

describe('鉴定纯函数（DESIGN 5）', () => {
  it('真卡怎么看都是"看起来是真的"；肉眼看不出高仿；准确率按 balance', () => {
    const rng = seeded(3);
    expect(eyeAuth(rng, 'real')).toBe('looks_real');
    expect(loupeAuth(rng, 'real')).toBe('looks_real');
    const rate = (f: () => string) => { let n = 0; for (let i = 0; i < 20_000; i += 1) if (f() === 'fake') n += 1; return n / 20_000; };
    expect(rate(() => eyeAuth(rng, 'high_fake'))).toBe(0);
    expect(rate(() => eyeAuth(rng, 'low_fake'))).toBeCloseTo(APPRAISAL.eyeDetect.low_fake / 1e6, 1);
    expect(rate(() => loupeAuth(rng, 'low_fake'))).toBeCloseTo(APPRAISAL.loupeDetect.low_fake / 1e6, 1);
    expect(rate(() => loupeAuth(rng, 'high_fake'))).toBeCloseTo(APPRAISAL.loupeDetect.high_fake / 1e6, 1);
  });

  it('鉴定机构 100% 准：假卡、赃物、干净真卡', () => {
    expect(labVerdict('low_fake', 'legit')).toBe('fake');
    expect(labVerdict('real', 'stolen')).toBe('stolen');
    expect(labVerdict('real', 'legit')).toBe('verified');
  });

  it('估品相：肉眼给范围，放大镜给相邻两档且一定包含真实分', () => {
    expect([eyeGrade('2'), eyeGrade('5'), eyeGrade('8'), eyeGrade('BL')]).toEqual(['low', 'mid', 'high', 'high']);
    const rng = seeded(5);
    for (const g of ['1', '5', '9', '10', 'BL']) {
      for (let i = 0; i < 50; i += 1) expect(loupeGrade(rng, g)).toContain(g);
    }
    expect(loupeGrade(rng, 'BL')).toEqual(['10', 'BL']);
    expect(loupeGrade(rng, '1')).toEqual(['1', '2']);
  });

  it('送评：真卡分数就是真实品相；黑标四项全 10；10 分不会四项全 10；假卡拒评', () => {
    const rng = seeded(9);
    const r = gradeCard(rng, 'real', '8');
    expect(r.kind === 'slab' && r.slab.score).toBe('8');
    const bl = gradeCard(rng, 'real', 'BL');
    expect(bl.kind === 'slab' && Object.values(bl.slab.subgrades)).toEqual([10, 10, 10, 10]);
    for (let i = 0; i < 200; i += 1) {
      const ten = gradeCard(rng, 'real', '10');
      expect(ten.kind === 'slab' && Object.values(ten.slab.subgrades).every((x) => x === 10)).toBe(false);
    }
    expect(gradeCard(rng, 'high_fake', '10').kind).toBe('rejected');
  });
});

describe('鉴定接口（FR-APPR-1～5）', () => {
  it('肉眼 / 放大镜马上出结论；每种方式只能做一次，结论不变；放大镜收费写流水；一条线不提另一条线', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo, { grade: '9' });
    const eye = (await appraise(app, h, id, 'eye_auth')).json() as AppraiseResponse;
    expect(eye.notes).toMatchObject({ eyeAuth: 'looks_real', eyeGrade: null, loupeGrade: null });
    expect((await appraise(app, h, id, 'eye_auth')).json().code).toBe('cannot_appraise');

    const before = repo.getPlayer(UID)!.credits;
    const lg = (await appraise(app, h, id, 'loupe_grade')).json() as AppraiseResponse;
    expect(lg.notes.loupeGrade).toContain('9');
    expect(lg.notes.eyeAuth).toBe('looks_real');
    expect(lg.credits).toBe(before - loupeFee(lg.card.rarity as 'SR'));
    expect(lg.can.loupe_grade).toBe(false);
    const last = repo.db.prepare("SELECT data FROM events_log WHERE kind = 'credits' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(last.data)).toMatchObject({ why: 'appraise_loupe_grade', card: id });
    // 看品相不改价格（没封壳一律未评级价）
    expect(lg.card.price).toBe((await info(app, h, id)).card.price);
    for (const body of [eye, lg, await info(app, h, id)]) expect(findKeys(body, HIDDEN_KEYS)).toEqual([]);
  });

  it('幂等：同一个 key 重试只扣一次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo);
    const key = idem();
    const a = (await appraise(app, h, id, 'loupe_auth', key)).json();
    expect((await appraise(app, h, id, 'loupe_auth', key)).json()).toEqual(a);
  });

  it('鉴定机构：送走不能卖，打烊出结果；真卡已验真并点亮图鉴；假卡告诉主人；赃物没收', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const real = add(repo);
    const fake = add(repo, { authenticity: 'low_fake', template: 'NEO-18' });
    const stolen = add(repo, { origin: 'stolen', template: 'NEO-19' });
    for (const id of [real, fake, stolen]) expect((await appraise(app, h, id, 'lab')).statusCode).toBe(200);

    const desk = (await app.inject({ method: 'GET', url: '/api/appraisal', headers: h })).json() as AppraisalDeskResponse;
    expect(desk.lab.map((c) => c.id).sort()).toEqual([real, fake, stolen].sort());
    expect(desk.lab.every((c) => c.readyDay === desk.day + APPRAISAL.lab.days)).toBe(true);
    expect(repo.sellableCards(UID).map((c) => c.id)).not.toContain(real);
    expect(findKeys(desk, HIDDEN_KEYS)).toEqual([]);

    const end = await closeDay(app, h);
    const byId = new Map(end.appraisals.map((a) => [a.cardId, a.outcome]));
    expect(byId.get(real)).toBe('verified');
    expect(byId.get(fake)).toBe('fake');
    expect(byId.get(stolen)).toBe('stolen');
    expect(repo.ownedInstance(UID, stolen)).toBeNull();
    const r = await info(app, h, real);
    expect(r.card).toMatchObject({ verified: true, location: 'inventory' });
    expect(r.can.lab).toBe(false);
    expect((await info(app, h, fake)).notes.lab).toBe('fake');
    expect((await info(app, h, fake)).card.verified).toBe(false);
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    const neo = coll.series.find((s: { id: string }) => s.id === 'NEO');
    expect(neo.cards.find((c: { templateId: string }) => c.templateId === 'NEO-17').owned).toBe(true);
    expect(neo.cards.find((c: { templateId: string }) => c.templateId === 'NEO-18').owned).toBe(false);
    expect(findKeys(end, HIDDEN_KEYS)).toEqual([]);
  });

  it('送评：真卡封壳、按评分定价、不能再送评；假卡拒评、打公开标记、扣信誉', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000').run();
    const real = add(repo, { grade: '10' });
    const fake = add(repo, { authenticity: 'high_fake', template: 'NEO-18' });
    const ungraded = (await info(app, h, real)).card.price;
    await appraise(app, h, real, 'grading');
    await appraise(app, h, fake, 'grading');
    expect((await appraise(app, h, real, 'eye_auth')).json().code).toBe('cannot_appraise');
    const rep = repo.getPlayer(UID)!.reputation;

    const end = await closeDay(app, h);
    expect(end.appraisals.find((a) => a.cardId === real)).toMatchObject({ outcome: 'slab', score: '10' });
    expect(end.appraisals.find((a) => a.cardId === fake)).toMatchObject({ outcome: 'rejected' });
    const slabbed = (await info(app, h, real)).card;
    expect(slabbed.slab?.score).toBe('10');
    expect(Object.keys(slabbed.slab!.subgrades).sort()).toEqual(['centering', 'corners', 'edges', 'surface']);
    expect(slabbed.price).toBeGreaterThan(ungraded * 5);
    expect((await info(app, h, real)).can).toMatchObject({ grading: false, eye_grade: false, loupe_grade: false });
    expect((await info(app, h, fake)).card.gradeRejected).toBe(true);
    expect(repo.getPlayer(UID)!.reputation).toBe(Math.max(REPUTATION.min, rep - APPRAISAL.gradeRejectRepLoss));
    // 回来的卡放回卡册或桌面（在库存里能找到）
    const inv = (await app.inject({ method: 'GET', url: '/api/inventory?location=inventory', headers: h })).json() as InventoryResponse;
    expect(inv.cards.map((c) => c.id)).toEqual(expect.arrayContaining([real, fake]));
  });

  it('钱不够、没有这种方式、别人的卡都拒绝', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    const id = add(repo, { template: 'ELT-20' });
    repo.db.prepare('UPDATE players SET credits = 0').run();
    expect((await appraise(app, h, id, 'grading')).json().code).toBe('insufficient_credits');
    expect((await appraise(app, h, id, 'xray')).json().code).toBe('bad_method');
    expect((await appraise(app, h, 999_999, 'eye_auth')).statusCode).toBe(404);
  });
});
