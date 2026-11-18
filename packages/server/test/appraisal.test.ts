import { afterEach, describe, expect, it } from 'vitest';
import { APPRAISAL, ERRATA, PACKS, PHONE, REPUTATION, WHOLESALE } from '@kanu/shared/balance';
import type {
  BuyPhoneResponse, CardAppraisalResponse, CounterResponse, CustomerView, EndDayResponse, GradeBatchResponse, GradeResponse, InventoryResponse, PhoneResponse,
  ReceiveResponse, WholesaleResponse,
} from '@kanu/shared/types';
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

  it('一次寄好几张：合计扣钱、一起送走、一起出结果；有一张不能送就整批不动；幂等', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, phone = 1').run();
    const ids = [add(repo, { grade: '8' }), add(repo, { grade: '9', template: 'NEO-18' }), add(repo, { grade: '7', template: 'NEO-19' })];
    const fees = await Promise.all(ids.map(async (id) => (await info(app, h, id)).gradingFee));
    const batch = (ks: number[], key = idem()) => app.inject({ method: 'POST', url: '/api/phone/grade', headers: { ...h, ...key }, payload: { cardIds: ks } });

    // 先单独送一张，再整批送（含这张）→ 整批不动、不扣钱
    await grade(app, h, ids[0]!);
    const before = repo.getPlayer(UID)!.credits;
    expect((await batch(ids)).json().code).toBe('cannot_grade');
    expect(repo.getPlayer(UID)!.credits).toBe(before);
    expect((await info(app, h, ids[1]!)).card.location).toBe('inventory');

    const key = idem();
    const r = (await batch(ids.slice(1), key)).json() as GradeBatchResponse;
    expect((await batch(ids.slice(1), key)).json()).toEqual(r);
    expect(r.cost).toBe(fees[1]! + fees[2]!);
    expect(r.credits).toBe(before - r.cost);
    expect(r.cards.every((c) => c.location === 'grading')).toBe(true);
    expect((await batch([])).json().code).toBe('no_cards');
    expect((await batch(Array.from({ length: PHONE.gradingBatch + 1 }, (_, i) => i + 1))).json().code).toBe('too_many');

    const end = await closeDay(app, h);
    expect(end.appraisals.map((a) => a.cardId).sort()).toEqual([...ids].sort());
    expect(findKeys(r, HIDDEN)).toEqual([]);
  });

  it('电话批发：下单不扣钱；隔日送达，送货员作为第二天第一位顾客来柜台、占一个名额；收货付款进库存；一天一次', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 1000000').run();
    const wholesale = (key = idem()) => app.inject({ method: 'POST', url: '/api/phone/wholesale', headers: { ...h, ...key }, payload: { seriesId: 'NEO' } });
    expect((await wholesale()).json().code).toBe('no_phone');
    repo.db.prepare('UPDATE players SET phone = 1').run();

    const phone = (await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse;
    const neo = phone.wholesale.offers.find((o) => o.seriesId === 'NEO')!;
    expect(neo.boxPrice).toBe(Math.round(PACKS.themed.price * WHOLESALE.discount) * WHOLESALE.boxPacks);
    expect(neo.boxPrice).toBeLessThan(neo.normalPrice);
    expect(phone.wholesale.leftToday).toBe(WHOLESALE.perDay);

    // 先开门，第一位顾客进来；再打电话下单
    const first = ((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).current!;
    const key = idem();
    const r = (await wholesale(key)).json() as WholesaleResponse;
    expect((await wholesale(key)).json()).toEqual(r);
    expect(r.order).toMatchObject({ seriesId: 'NEO', packs: WHOLESALE.boxPacks, price: neo.boxPrice });
    expect(repo.getPlayer(UID)!.credits).toBe(1_000_000);
    expect((await wholesale()).json().code).toBe('wholesale_limit');
    const after = (await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse;
    expect(after.wholesale).toMatchObject({ leftToday: 0, pending: { orderId: r.order.orderId, arriveDay: 1 + WHOLESALE.deliveryDays } });

    // 当天不送：请走今天所有顾客，没有一位是送货员
    let cur: CustomerView | null = first;
    while (cur) {
      expect(cur.type).not.toBe('courier');
      cur = (await app.inject({ method: 'POST', url: `/api/counter/${cur.id}/dismiss`, headers: h })).json().next as CustomerView | null;
    }
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    // 第二天第一位就是送货员
    const next = ((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).current!;
    expect(next.type).toBe('courier');
    expect(next.demand.delivery).toMatchObject({ orderId: r.order.orderId, packs: WHOLESALE.boxPacks, price: neo.boxPrice });
    // 送货员不买卡
    expect((await app.inject({ method: 'GET', url: `/api/counter/${next.id}/cards`, headers: h })).json().cards).toEqual([]);

    const rk = idem();
    const recv = (await app.inject({ method: 'POST', url: `/api/counter/${next.id}/receive`, headers: { ...h, ...rk } })).json() as ReceiveResponse;
    expect((await app.inject({ method: 'POST', url: `/api/counter/${next.id}/receive`, headers: { ...h, ...rk } })).json()).toEqual(recv);
    expect(recv.packIds).toHaveLength(WHOLESALE.boxPacks);
    expect(recv.cost).toBe(neo.boxPrice);
    expect(recv.credits).toBe(1_000_000 - neo.boxPrice);
    expect(((await app.inject({ method: 'GET', url: '/api/phone', headers: h })).json() as PhoneResponse).wholesale.pending).toBeNull();
    const served = ((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).served;
    expect(served.find((c) => c.id === next.id)!.status).toBe('received');

    // 拆一包：带批发标记、图鉴不点亮（来路不明，要送评封壳才点亮）
    const opened = (await app.inject({ method: 'POST', url: `/api/packs/${recv.packIds[0]}/open`, headers: { ...h, ...idem() } })).json();
    expect(opened.cards.every((c: { acquired: string }) => c.acquired === 'wholesale')).toBe(true);
    const coll = (await app.inject({ method: 'GET', url: '/api/collection', headers: h })).json();
    expect(coll.series.find((s: { id: string }) => s.id === 'NEO').owned).toBe(0);
    expect(findKeys(opened, HIDDEN)).toEqual([]);
  });

  it('拒收：请走送货员，订单取消、不扣钱；钱不够收不了货', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100, phone = 1').run();
    const r = (await app.inject({ method: 'POST', url: '/api/phone/wholesale', headers: { ...h, ...idem() }, payload: { seriesId: 'MEC' } })).json() as WholesaleResponse;
    await closeDay(app, h);
    const courier = ((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).current!;
    expect(courier.type).toBe('courier');
    expect((await app.inject({ method: 'POST', url: `/api/counter/${courier.id}/receive`, headers: { ...h, ...idem() } })).json().code).toBe('insufficient_credits');
    await app.inject({ method: 'POST', url: `/api/counter/${courier.id}/dismiss`, headers: h });
    expect(repo.getOrder(UID, r.order.orderId)!.status).toBe('refused');
    expect(repo.getPlayer(UID)!.credits).toBe(100);
    expect(repo.sealedByOwner(UID)).toHaveLength(0);
  });

  it('打烊前名额用完才下单：第二天照样送到', async () => {
    const { app, repo } = setup();
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000, phone = 1').run();
    let state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    while (state.current) {
      await app.inject({ method: 'POST', url: `/api/counter/${state.current.id}/dismiss`, headers: h });
      state = (await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse;
    }
    await app.inject({ method: 'POST', url: '/api/phone/wholesale', headers: { ...h, ...idem() }, payload: { seriesId: 'SEA' } });
    expect(((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).done).toBe(true);
    await app.inject({ method: 'POST', url: '/api/day/end', headers: { ...h, ...idem() } });
    expect(((await app.inject({ method: 'GET', url: '/api/counter', headers: h })).json() as CounterResponse).current!.type).toBe('courier');
  });

  it('批发包的假卡率按 WHOLESALE.fakePpm（大约），电脑订货的一张假卡都没有', async () => {
    const { app, repo } = setup({ rng: seeded(11) });
    cleanup = () => app.close();
    const h = await login(app);
    repo.db.prepare('UPDATE players SET credits = 100000000, phone = 1').run();
    // 绕过每天一次：直接塞 200 包批发包和 100 包电脑包
    for (let i = 0; i < 200; i += 1) repo.insertSealed(UID, 'NEO', 'phone', NOW, 1);
    for (let i = 0; i < 100; i += 1) repo.insertSealed(UID, 'MEC', 'store', NOW);
    repo.db.prepare("UPDATE binders SET kind = 'leather'").run();
    for (let i = 0; i < 3; i += 1) repo.insertBinder(UID, 'leather', NOW);
    for (const p of repo.sealedByOwner(UID)) await app.inject({ method: 'POST', url: `/api/packs/${p.id}/open`, headers: { ...h, ...idem() } });
    const rate = (acq: string) => {
      const rows = repo.db.prepare("SELECT authenticity FROM card_instances WHERE owner_id = ? AND acquired = ?").all(UID, acq) as Array<{ authenticity: string }>;
      return { n: rows.length, fake: rows.filter((x) => x.authenticity !== 'real').length / rows.length };
    };
    const w = rate('wholesale');
    const s = rate('store');
    expect(w.n).toBe(1000);
    expect(w.fake).toBeGreaterThan(WHOLESALE.fakePpm / 1e6 / 2);
    expect(w.fake).toBeLessThan((WHOLESALE.fakePpm / 1e6) * 2);
    expect(s.fake).toBe(0);
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
