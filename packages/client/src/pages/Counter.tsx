// 柜台页（FR-CTR-1～5）：顾客一位一位进门（学深空当铺）。只看得到眼前这一位，处理完下一位才进来，
// 不知道下一位是谁、今天还剩几位。挑卡（或卡包）→ 开价 / 接受还价 / 快速出售 / 请走。都接待完就能打烊。
import { useEffect, useRef, useState } from 'react';
import { COUNTER, CUSTOMER, type CustomerType } from '@kanu/shared/balance';
import type { CardAppraisalResponse, CardView, InspectionView, CounterBinderPageResponse, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, MeResponse, OfferResponse, ReceiveResponse, DealerBuyResponse, PatrolResolveResponse, PatrolView, ReportResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';
import { ART, ArtImg, CustomerAvatar, PackArt } from '../art.tsx';
import { DragGhost, FloatWindow, useDrag } from '../drag.tsx';
import { inspectionText } from '../appraisalText.ts';
import { FakeGuide, LoupeLens } from '../Loupe.tsx';
import { PHONE_ZONE, dropOnPhone } from '../Phone.tsx';

export const AVATAR: Record<string, string> = {
  resident: '🧑‍🔧', student: '🧒', tourist: '🧳', collector: '🧐', nostalgic: '👴',
  rich: '🤵', speculator: '📈', streamer: '🎥', middleman: '🕶️', grand: '🎩', courier: '📦', dealer: '🧥',
};
const STATUS: Record<string, string> = { sold: '成交', left: '走了', dismissed: '请走', received: '收货', reported: '举报', busted: '被便衣抓了' };
/** 开价时每次加减多少，玩家自己选 */
const STEPS = [1, 10, 100, 1000];

export function Counter({ onChange, onGo }: { onChange: (patch: Partial<MeResponse>) => void; onGo?: (tab: string) => void }) {
  const [data, setData] = useState<CounterResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 打开的卡册浮窗放在这一层：下一位客人进门时浮窗不关，内容按新客人重新高亮 */
  const [openBinders, setOpenBinders] = useState<OpenBinder[]>([]);
  /** 柜台台面上摆着的东西也放在这一层：换客人时留着 */
  const [table, setTable] = useState<Item[]>([]);
  /** 假卡识别手册（道具浮窗）开着没有 */
  const [guide, setGuide] = useState(false);

  const load = () => api<CounterResponse>('/counter').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);

  /** 一位顾客的结果出来后：显示一句结果，下一位进门 */
  const afterResult = (text: string) => {
    setMsg(text);
    void load();
  };

  const endDay = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api<EndDayResponse>('/day/end', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ gameDay: r.day });
      // 今天还能订几包（算上科技树批发证）、交租后的信用点和下次房租，从服务器重新拿
      api<MeResponse>('/me').then((m) => onChange({ packsLeftToday: m.packsLeftToday, credits: m.credits, rent: m.rent })).catch(() => {});
      // 鉴定机构 / 评级社在打烊时出结果
      // 星港评级社在打烊时出结果
      const notes = r.appraisals.map((a) => `「${a.name}」${a.outcome === 'slab'
        ? `封壳了：${a.score === 'BL' ? '黑标' : `${a.score} 分`}${a.errata ? '，还是错版！' : ''}`
        : '被评级社拒评（疑似假卡），信誉下降'}`);
      if (r.rentPaid) notes.unshift(`交了第 ${r.rentPaid.week} 周摊位费 ${fmt(r.rentPaid.amount)}`);
      if (r.forfeited) notes.push(`${r.forfeited} 张抵押的卡过了赎回期，归房东了`);
      if (r.patrol) notes.push(`治安巡查来了，查出 ${r.patrol.cards.length} 张赃卡`);
      else if (r.patrolClean) notes.push('治安巡查来店里转了一圈，什么都没查出来');
      // 黑市追杀（DESIGN 8.4）
      if (r.vendetta === 'hit') notes.unshift('打烊锁门的时候，几个人从暗处走了出来……你被黑市"清理"了。店没了，只剩珍藏柜里的卡，一切从头开始');
      else if (r.vendetta === 'hunted') notes.push('回家路上总觉得有人跟着你（黑市盯上你了，去店铺页看看）');
      else if (r.vendetta === 'ultimatum') notes.push('黑市带话：拿钱来摆平，不然后果自负（店铺页）');
      else if (r.vendetta === 'warn') notes.push('门缝里塞进来一张纸条："最近话挺多啊。"');
      setMsg(notes.join('；'));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <section className="page"><p className="hint">开门中…</p>{err && <p className="error">{err}</p>}</section>;

  // 整个柜台页是"拿回来"的区域：台面上的东西拖到台面外面任何地方都算拿回来
  return (
    <section className="page counter-page" data-drop="back">
      <h2>柜台 · 第 {data.day} 天 <small>已接待 {data.served.length} 位</small></h2>
      {msg && <p className="deal-msg">{msg}</p>}

      {data.current?.type === 'courier' && (
        <Delivery key={data.current.id} customer={data.current} onChange={onChange} onDone={afterResult} />
      )}
      {data.current?.type === 'dealer' && (
        <DealerDeal key={data.current.id} customer={data.current} onChange={onChange} onDone={afterResult} onUpdate={(c) => setData({ ...data, current: c })} />
      )}
      {data.current && data.current.type !== 'courier' && data.current.type !== 'dealer' && (
        <Deal key={data.current.id} customer={data.current} onChange={onChange} onDone={afterResult} onUpdate={(c) => setData({ ...data, current: c })}
          openBinders={openBinders} setOpenBinders={setOpenBinders} table={table} setTable={setTable} guide={guide} setGuide={setGuide} />
      )}

      {data.patrol && <Patrol key={data.patrol.id} patrol={data.patrol} onChange={onChange} onDone={(t) => { setMsg(t); void load(); }} />}
      {data.arrears && (
        <div className="closing rent-arrears">
          <p><b>交不起摊位费</b>：第 {data.arrears.week} 周 {fmt(data.arrears.amount)} 信用点。柜台先关门，交上之前不能进入下一天。去店铺页抵押卡牌凑钱，或者从头开始。</p>
          <button className="primary" onClick={() => onGo?.('shop')}>去店铺页处理</button>
        </div>
      )}
      {data.done && !data.arrears && (
        <div className="closing">
          <p>今天的客人都走了。</p>
          <button className="primary" disabled={busy} onClick={endDay}>{busy ? '打烊中…' : `打烊，进入第 ${data.day + 1} 天`}</button>
        </div>
      )}

      {data.served.length > 0 && (
        <details className="served">
          <summary>今天接待过的 {data.served.length} 位</summary>
          {[...data.served].reverse().map((c) => (
            <div key={c.id} className="served-row">
              <CustomerAvatar type={c.type} id={c.id} emoji={AVATAR[c.type] ?? '🙂'} className="served-avatar" />
              <span>{c.typeName}</span>
              <span className="badge">{STATUS[c.status]}</span>
            </div>
          ))}
        </details>
      )}
      {err && <p className="error">{err}</p>}
      {guide && <FakeGuide onClose={() => setGuide(false)} />}
    </section>
  );
}

/**
 * 送货员（2026-11-18 用户定）：电话批发的货送到柜台，整盒摆在台面客人那一侧，货到付款。
 * 收货付款 → 10 包进"我的卡包"；拒收 → 订单取消、不扣钱。占当天一个客人名额。
 */
function Delivery({ customer, onChange, onDone }: { customer: CustomerView; onChange: (p: Partial<MeResponse>) => void; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const d = customer.demand.delivery;
  const receive = async () => {
    setBusy(true); setNote('');
    try {
      const r = await api<ReceiveResponse>(`/counter/${customer.id}/receive`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      onDone(`收下「${d?.seriesName}」一盒 ${r.packIds.length} 包，付了 ${fmt(r.cost)} 信用点。去进货页的"我的卡包"拆`);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  const refuse = async () => {
    setBusy(true);
    try {
      await api(`/counter/${customer.id}/dismiss`, { method: 'POST', body: {} });
      onDone('拒收了，送货员把货拉回去了（不扣钱）');
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="visitor delivery">
      <div className="deal-main">
        <div className="visitor-head">
          <CustomerAvatar type="courier" id={customer.id} emoji={AVATAR.courier!} />
          <div>
            <b>{customer.typeName}</b>
            <p className="bubble">{customer.line}</p>
            <p className="hint">电话批发的货，货到付款。批发商不保证正品，拆出来的卡带"批"字。</p>
          </div>
        </div>
        <div className="counter-top">
          <div className="counter-side customer-side delivery-side">
            {d && (
              <div className="delivery-box">
                <ArtImg srcs={[ART.box(d.seriesId)]} className="box-art box-img" fallback={<div className="box-art" aria-hidden><span>{d.seriesName.slice(0, 2)}</span><small>× {d.packs}</small></div>} />
                <div>
                  <b>「{d.seriesName}」一盒 {d.packs} 包</b>
                  <p className="hint">货款 <b className="price-strong">{fmt(d.price)}</b> 信用点</p>
                </div>
              </div>
            )}
          </div>
          <div className="counter-side my-side"><p className="counter-empty">收下后整盒进"我的卡包"</p></div>
        </div>
        <button className="primary" disabled={busy || !d} onClick={receive}>收货付款 {d ? fmt(d.price) : ''}</button>
        <button className="secondary" disabled={busy} onClick={refuse}>拒收（不扣钱，订单取消）</button>
        {note && <p className="deal-msg">{note}</p>}
      </div>
    </div>
  );
}

/**
 * 卡贩（柜台收卡，DESIGN 4 / 6）：他把 1–3 张卡摆在台面客人那一侧，每张标着市场价（未评级）。
 * 放大镜照样拖到卡上查验（收之前先验，假卡、赃物都有可能）；点一张卡出价收，他嫌少会还价，耐心用完就走。
 */
function DealerDeal({ customer, onChange, onDone, onUpdate }: { customer: CustomerView; onChange: (p: Partial<MeResponse>) => void; onDone: (text: string) => void; onUpdate: (c: CustomerView) => void }) {
  const offers = customer.demand.offers ?? [];
  const [sel, setSel] = useState<number | null>(offers.find((o) => o.status === 'open')?.card.id ?? null);
  const current = offers.find((o) => o.card.id === sel) ?? null;
  const [price, setPrice] = useState(() => Math.max(1, Math.round((current?.card.price ?? 100) * 0.5)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [looks, setLooks] = useState<Record<number, InspectionView | null>>({});
  const asking = useRef(new Set<number>());

  const choose = (id: number) => {
    const o = offers.find((x) => x.card.id === id);
    if (!o || o.status !== 'open') return;
    setSel(id);
    setPrice(o.counterPrice ?? Math.max(1, Math.round(o.card.price * 0.5)));
  };
  const inspectCard = async (cardId: number) => {
    if (looks[cardId] || asking.current.has(cardId)) return;
    asking.current.add(cardId);
    try {
      const r = await api<CardAppraisalResponse>(`/cards/${cardId}/inspect`, { method: 'POST', body: {} });
      if (r.inspection) { setLooks((m) => ({ ...m, [cardId]: r.inspection })); setNote(`🔍「${r.card.name}」：${inspectionText(r.inspection)}`); }
    } catch (e) { setNote((e as Error).message); } finally { asking.current.delete(cardId); }
  };
  const loupe = useDrag<'loupe'>((_, zone) => { if (zone.startsWith('card-')) void inspectCard(Number(zone.slice(5))); });
  const hoverId = loupe.drag?.zone?.startsWith('card-') ? Number(loupe.drag.zone.slice(5)) : null;
  useEffect(() => {
    if (hoverId === null) return;
    const t = window.setTimeout(() => void inspectCard(hoverId), LOUPE_DWELL_MS);
    return () => window.clearTimeout(t);
  }, [hoverId]);
  // 以前查过的卡，结论带出来
  useEffect(() => {
    for (const o of offers) {
      if (looks[o.card.id] !== undefined) continue;
      api<CardAppraisalResponse>(`/cards/${o.card.id}/appraisal`).then((r) => setLooks((m) => ({ ...m, [o.card.id]: r.inspection }))).catch(() => {});
    }
  }, [customer.id]);
  const lensRect = hoverId !== null ? document.querySelector(`[data-drop="card-${hoverId}"] .card`)?.getBoundingClientRect() ?? null : null;
  const lensCard = hoverId !== null ? offers.find((o) => o.card.id === hoverId)?.card ?? null : null;

  const offer = async (p: number) => {
    if (!current) return;
    setBusy(true); setNote('');
    try {
      const r = await api<DealerBuyResponse>(`/counter/${customer.id}/buy`, { method: 'POST', body: { cardId: current.card.id, price: p }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      if (r.outcome === 'deal') {
        const name = current.card.name;
        if (r.customer.status === 'sold') onDone(`收下「${name}」，花了 ${fmt(p)}。卡贩的货都收完了`);
        else { onUpdate(r.customer); setNote(`收下「${name}」，花了 ${fmt(p)}`); const next = r.customer.demand.offers?.find((o) => o.status === 'open'); if (next) { setSel(next.card.id); setPrice(Math.max(1, Math.round(next.card.price * 0.5))); } }
      } else if (r.outcome === 'counter') {
        onUpdate(r.customer);
        const cp = r.customer.demand.offers?.find((o) => o.card.id === current.card.id)?.counterPrice ?? p;
        setNote(`他还价 ${fmt(cp)}`);
        setPrice(cp);
      } else onDone('卡贩嫌你出价太低，走了');
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true);
    try { await api(`/counter/${customer.id}/dismiss`, { method: 'POST', body: {} }); onDone('请卡贩离开了'); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  // 举报：觉得他的货是赃物（DESIGN 6）。对了有奖金、信誉 +，错了信誉 −
  const [confirmReport, setConfirmReport] = useState(false);
  const report = async () => {
    setBusy(true);
    try {
      const r = await api<ReportResponse>(`/counter/${customer.id}/report`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits, reputation: r.reputation });
      onDone(r.correct ? `举报对了！他的货里有赃物，治安局给了 ${fmt(r.bonus)} 信用点奖金，信誉上升` : '举报错了：他的货是干净的，信誉下降');
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); setConfirmReport(false); }
  };

  return (
    <div className="visitor dealer">
      <div className="deal-main">
        <div className="visitor-head">
          <CustomerAvatar type="dealer" id={customer.id} emoji={AVATAR.dealer!} />
          <div>
            <b>{customer.typeName}</b> <Patience c={customer} />
            <p className="bubble">{customer.line}</p>
            <p className="hint">来卖卡的：属性全不知道，可能是假卡、也可能是赃物。先拿放大镜看看再出价。收来的卡带"收"字，送评封壳后才点亮图鉴。</p>
          </div>
        </div>
        <div className="counter-top">
          <div className="counter-side customer-side dealer-side">
            {offers.map((o) => (
              <div key={o.card.id} data-drop={`card-${o.card.id}`} className={`dealer-offer${sel === o.card.id ? ' on' : ''}${o.status === 'bought' ? ' bought' : ''}${loupe.drag && hoverId === o.card.id ? ' loupe-over' : ''}`} onClick={() => choose(o.card.id)}>
                <Card card={o.card} small />
                <span className="cell-price">市场价 {fmt(o.card.price)}</span>
                {o.status === 'bought' ? <span className="badge">已收下</span> : o.counterPrice ? <span className="badge">还价 {fmt(o.counterPrice)}</span> : null}
                {looks[o.card.id] && <span className="hint">🔍 {inspectionText(looks[o.card.id]!)}</span>}
              </div>
            ))}
          </div>
          <button className={loupe.drag ? 'loupe-tool lifted' : 'loupe-tool'} title="放大镜：拖到卡上查验" aria-label="放大镜" {...loupe.bind('loupe')}>🔍</button>
          <div className="counter-side my-side">
            {current && current.status === 'open'
              ? (
                <div className="dealer-bid">
                  <span>收「{current.card.name}」出价</span>
                  <div className="price-input">
                    <button className="step-btn" disabled={busy || price <= 10} onClick={() => setPrice(Math.max(1, price - 10))} aria-label="少 10">−</button>
                    <input inputMode="numeric" value={price} onChange={(e) => setPrice(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1))} />
                    <button className="step-btn" disabled={busy} onClick={() => setPrice(price + 10)} aria-label="多 10">+</button>
                  </div>
                </div>
              )
              : <p className="counter-empty">点卡贩那边的一张卡，出价收</p>}
          </div>
        </div>
        {current && current.status === 'open' && (
          <>
            <button className="primary" disabled={busy} onClick={() => offer(price)}>出价 {fmt(price)} 收下</button>
            {current.counterPrice && current.counterPrice !== price && <button className="secondary" disabled={busy} onClick={() => offer(current.counterPrice!)}>接受还价 {fmt(current.counterPrice)}</button>}
          </>
        )}
        <button className="secondary" disabled={busy} onClick={dismiss}>请他离开（没收的卡他带走）</button>
        {!confirmReport
          ? <button className="secondary danger" disabled={busy} onClick={() => setConfirmReport(true)}>🚨 举报他卖赃物</button>
          : <div className="exchange-confirm"><span>举报对了有奖金、信誉 +；他的货是干净的就是错举，信誉 −。确定？</span><button className="primary danger" disabled={busy} onClick={report}>确定举报</button><button className="link" onClick={() => setConfirmReport(false)}>算了</button></div>}
        {note && <p className="deal-msg">{note}</p>}
      </div>
      {loupe.drag && lensRect && lensCard && <LoupeLens x={loupe.drag.x} y={loupe.drag.y} rect={lensRect} card={lensCard} inspection={looks[lensCard.id] ?? null} />}
      {loupe.drag && <DragGhost x={loupe.drag.x} y={loupe.drag.y}><span className="loupe-ghost" aria-hidden>🔍</span></DragGhost>}
    </div>
  );
}

/** 治安巡查（DESIGN 8.3）：查出赃卡，二选一处理完柜台才开门 */
function Patrol({ patrol, onChange, onDone }: { patrol: PatrolView; onChange: (p: Partial<MeResponse>) => void; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const resolve = async (choice: 'surrender' | 'bribe') => {
    setBusy(true); setErr('');
    try {
      const r = await api<PatrolResolveResponse>(`/patrol/${patrol.id}/resolve`, { method: 'POST', body: { choice }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits, reputation: r.reputation });
      onDone(choice === 'surrender' ? `交出了 ${patrol.cards.length} 张赃卡，信誉下降` : `打点了 ${fmt(patrol.bribe)} 信用点，卡留下了`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="closing patrol">
      <p><b>🚨 治安巡查</b>：这几张卡在失窃登记表上。处理完才能开门。</p>
      <div className="rent-grid">
        {patrol.cards.map((c) => <div key={c.id} className="rent-cell"><Card card={c} small /><span className="cell-price">市场价 {fmt(c.price)}</span></div>)}
      </div>
      <div className="rent-actions">
        <button className="secondary" disabled={busy} onClick={() => resolve('surrender')}>交出（没收，信誉 −{patrol.surrenderRepLoss}）</button>
        <button className="primary" disabled={busy} onClick={() => resolve('bribe')}>打点 {fmt(patrol.bribe)} 信用点（卡留下）</button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function Patience({ c }: { c: CustomerView }) {
  return <span className="patience" aria-label={`耐心 ${c.patience}/${c.maxPatience}`}>{'●'.repeat(c.patience)}{'○'.repeat(Math.max(0, c.maxPatience - c.patience))}</span>;
}


type OpenBinder = { id: number | 'showcase'; name: string };

/** 放上柜台台面的东西：一张卡或一包没拆的卡包 */
type Item =
  | { kind: 'card'; id: number; name: string; price: number; quickPrice: number; card: CardView }
  | { kind: 'pack'; id: number; name: string; price: number; quickPrice: number; packKind: string; seriesId: string };

const cardItem = (card: CardView, quickPrice: number): Item => ({ kind: 'card', id: card.id, name: card.name, price: card.price, quickPrice, card });

/** 台面上和拖动影子里画这件东西 */
function ItemArt({ item }: { item: Item }) {
  return item.kind === 'card'
    ? <Card card={item.card} small />
    : <PackArt seriesId={item.seriesId} name={item.name} kind={item.packKind} />;
}

/** "符合的排前面"开关记在本机，下次进柜台还是上次的选择 */
const MATCH_FIRST_KEY = 'kanu.counter.matchFirst';
const readMatchFirst = () => { try { return localStorage.getItem(MATCH_FIRST_KEY) !== '0'; } catch { return true; } };

/** 柜台卡册浮窗的内容：一页 3 × 3，符合这位顾客的高亮、能拖上台面（轻点也行），不符合的变暗 */
function BinderPicker({ customerId, binder, onPick, bind, draggingId, onTable, onCards }: {
  customerId: number;
  binder: { id: number | 'showcase'; name: string };
  onPick: (item: Item) => void;
  bind: (item: Item) => BindProps;
  draggingId: number | null;
  /** 已经摆在台面上的卡（卡册里标"已在台面"） */
  onTable: Set<number>;
  /** 把这一页的卡报上去（放大镜的镜片要用卡面） */
  onCards: (cards: CardView[]) => void;
}) {
  const [matchFirst, setMatchFirst] = useState(readMatchFirst);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CounterBinderPageResponse | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setPage(1); }, [binder.id]);
  useEffect(() => {
    api<CounterBinderPageResponse>(`/counter/${customerId}/binder/${binder.id}?page=${page}&matchFirst=${matchFirst ? 1 : 0}`)
      .then(setData).catch((e: Error) => setErr(e.message));
  }, [customerId, binder.id, page, matchFirst]);
  const toggle = () => {
    const next = !matchFirst;
    try { localStorage.setItem(MATCH_FIRST_KEY, next ? '1' : '0'); } catch { /* 存不了就算了 */ }
    setMatchFirst(next);
    setPage(1);
  };
  const cards = data?.cards ?? [];
  useEffect(() => { onCards(cards.map((c) => c.card)); }, [data]);
  return (
    <>
      <div className="picker-head">
        <span className="hint">发光的卡拖到柜台上</span>
        <button className={matchFirst ? 'chip on' : 'chip'} onClick={toggle}>符合的排前面</button>
      </div>
      <div className="binder-page">
        {cards.map(({ card, match, quickPrice }) => {
          if (!match) return <div key={card.id} className="cell dim" aria-disabled><Card card={card} small /></div>;
          if (onTable.has(card.id)) {
            return <div key={card.id} className="cell on-table" aria-disabled><Card card={card} small /><span className="cell-price">已在台面</span></div>;
          }
          const item = cardItem(card, quickPrice ?? 0);
          return (
            <button key={card.id} className={draggingId === card.id ? 'cell match draggable dragging' : 'cell match draggable'} onClick={() => onPick(item)} {...bind(item)} data-drop={`card-${card.id}`}>
              <Card card={card} small />
              <span className="cell-price">快卖 {fmt(quickPrice ?? 0)}</span>
            </button>
          );
        })}
        {Array.from({ length: Math.max(0, 9 - cards.length) }, (_, i) => <div key={`e${i}`} className="binder-slot" />)}
      </div>
      <div className="pager">
        <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {data?.page ?? page} / {data?.pages ?? 1} 页</span>
        <button className="chip" disabled={!data || page >= data.pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
      {err && <p className="error">{err}</p>}
    </>
  );
}

/** 卡册列表里的一项（卡册 / 珍藏柜 / 桌面散放），标出有几张符合 */
function SourceButton({ cover, coverClass, name, sub, matchCount, on, onClick }: {
  cover: string; coverClass: string; name: string; sub: string; matchCount: number; on: boolean; onClick: () => void;
}) {
  return (
    <button className={`binder-item${matchCount ? ' has-match' : ''}${on ? ' on' : ''}`} onClick={onClick}>
      <div className={`binder-cover ${coverClass}`} aria-hidden>{cover}</div>
      <div className="binder-body">
        <b>{name}</b>
        <span className="hint">{sub}</span>
      </div>
      <span className={matchCount ? 'match-badge' : 'match-badge none'}>{matchCount ? `${matchCount} 张符合` : '没有符合的'}</span>
    </button>
  );
}

/** 拖着的东西：从哪里拖起来的（货源 / 台面），拖回去时要知道 */
type Dragging = { item: Item; from: 'source' | 'table' };
type BindProps = ReturnType<ReturnType<typeof useDrag<Dragging>>['bind']>;
const keyOf = (it: Item) => `${it.kind}-${it.id}`;

/**
 * 眼前这一位。交互原则（DESIGN 4.5，2026-11-17 用户定）：东西靠拖，结果靠按钮确认。
 * 柜台台面能摆好几样（COUNTER.tableSlots）：从卡册浮窗 / 卡包列表拖上来，从台面拖到别处就是拿回来。
 * 点台面上的一样选中它 → 调价 → 按"开价 / 接受还价 / 快速出售"。台面上的东西换客人时留着，
 * 不符合新客人要求的变暗。台面上留了客人那一侧，以后客人卖卡给你时，他的卡也摆在台面上。
 */
/**
 * 开价参考（2026-11-18 用户定：开价不超过市场价，客人就不会不满意）。只用公开信息：
 * 稳卖价 = 快速出售价（这类顾客最低肯出的价，不低于市场价）；最多 ≈ 稳卖价 × (1 + premium 上限) / (1 + 下限)。
 * 珍藏柜加成会让真实上限再高一点，所以写"约"。黑市中间人不看市场价。
 */
function PriceGuide({ type, typeName, quick, price }: { type: string; typeName: string; quick: number; price: number }) {
  const spec = CUSTOMER[type as CustomerType];
  if (!spec) return null;
  if (type === 'middleman') return <p className="price-guide">黑市中间人不看市场价，只按稀有度基准价的四成收：开 {fmt(quick)} 以内一定成交。</p>;
  const [lo, hi] = spec.premium;
  const top = Math.round((quick * (1 + hi)) / (1 + lo));
  const zone = price <= quick ? 'safe' : price <= top ? 'gamble' : 'over';
  return (
    <p className={`price-guide ${zone}`}>
      开 <b>{fmt(quick)}</b> 以内一定成交；这位{typeName}最多可能出到约 <b>{fmt(top)}</b>。
      {price > 0 && <span className="price-zone">{zone === 'safe' ? '稳卖' : zone === 'gamble' ? '赌一把：他可能还价' : '太贵了，他大概不会出这么多'}</span>}
    </p>
  );
}

/** 放大镜在一张卡上停多久算查验（毫秒，界面手感，不是游戏数值） */
const LOUPE_DWELL_MS = 300;

function Deal({ customer, onChange, onDone, onUpdate, openBinders, setOpenBinders, table, setTable, guide, setGuide }: {
  customer: CustomerView;
  onChange: (patch: Partial<MeResponse>) => void;
  onDone: (text: string) => void;
  onUpdate: (c: CustomerView) => void;
  /** 柜台上同时打开的卡册浮窗（id 0 = 桌面散放，showcase = 珍藏柜）；放在上一层，换客人时不关 */
  openBinders: OpenBinder[];
  setOpenBinders: (f: (xs: OpenBinder[]) => OpenBinder[]) => void;
  /** 台面上的东西；放在上一层，换客人时留着 */
  table: Item[];
  setTable: (f: (xs: Item[]) => Item[]) => void;
  /** 假卡识别手册开着没有（放在上一层，换客人时不关） */
  guide: boolean;
  setGuide: (v: boolean) => void;
}) {
  const [stock, setStock] = useState<EligibleCardsResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [step, setStep] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  /** 按当前步长加减开价，最低 1 */
  const bump = (d: number) => setPrice((p) => String(Math.max(1, (Number(p) || 0) + d)));

  useEffect(() => {
    api<EligibleCardsResponse>(`/counter/${customer.id}/cards`).then(setStock).catch((e: Error) => setNote(e.message));
  }, [customer.id]);

  // 这位客人要不要台面上的每一样：按服务器给的"符合的卡 / 卡包"对一遍，顺便换成这位客人的快卖价
  const wanted = new Map<string, number>();
  for (const c of stock?.cards ?? []) wanted.set(`card-${c.card.id}`, c.quickPrice);
  for (const p of stock?.packs ?? []) wanted.set(`pack-${p.id}`, p.quickPrice);
  const selected = table.find((it) => keyOf(it) === selectedKey && wanted.has(keyOf(it))) ?? null;
  const selectedQuick = selected ? wanted.get(keyOf(selected)) ?? selected.quickPrice : 0;

  const select = (it: Item) => {
    if (!wanted.has(keyOf(it))) { setNote(`${customer.typeName}不要「${it.name}」`); return; }
    setSelectedKey(keyOf(it));
    setPrice(String(it.kind === 'card' ? it.price : wanted.get(keyOf(it)) ?? it.quickPrice));
    setNote('');
  };
  /** 放上台面（已经在台面上就只是选中它） */
  const place = (it: Item) => {
    if (!table.some((x) => keyOf(x) === keyOf(it))) {
      if (table.length >= COUNTER.tableSlots) { setNote(`台面最多摆 ${COUNTER.tableSlots} 样，先拖回去几样`); return; }
      setTable((xs) => [...xs, it]);
    }
    select(it);
  };
  const takeBack = (it: Item) => {
    setTable((xs) => xs.filter((x) => keyOf(x) !== keyOf(it)));
    if (selectedKey === keyOf(it)) setSelectedKey(null);
  };
  // 拖到台面 = 放上去；台面上的拖到别处（卡册浮窗、货源、页面空白处）= 拿回来；拖到电话的评级社上 = 准备送评
  const onCounterZone = (zone: string) => zone === 'counter' || table.some((t) => t.kind === 'card' && zone === `card-${t.id}`);
  const { drag, bind } = useDrag<Dragging>(({ item, from }, zone) => {
    if (zone === PHONE_ZONE) { if (item.kind === 'card') dropOnPhone(item.card); return; }
    if (onCounterZone(zone) && from === 'source') place(item);
    else if (!onCounterZone(zone) && from === 'table') takeBack(item);
  });
  const sourceBind = (it: Item): BindProps => bind({ item: it, from: 'source' });

  // 放大镜（柜台上的道具，学深空当铺）：拿着放大镜在卡上停一下（或松手）就是查验。每张卡只查一次，结论不变，只有自己知道。
  // 镜片里是这张卡的放大卡面 + 按结论画的细节（Loupe.tsx）
  const [looks, setLooks] = useState<Record<number, InspectionView | null>>({});
  /** 看得到的卡（台面、卡册浮窗里的），镜片要用卡面 */
  const seen = useRef(new Map<number, CardView>());
  for (const it of table) if (it.kind === 'card') seen.current.set(it.id, it.card);
  const asking = useRef(new Set<number>());
  const inspectCard = async (cardId: number) => {
    if (looks[cardId] || asking.current.has(cardId)) return;
    asking.current.add(cardId);
    try {
      const r = await api<CardAppraisalResponse>(`/cards/${cardId}/inspect`, { method: 'POST', body: {} });
      if (r.inspection) {
        setLooks((m) => ({ ...m, [cardId]: r.inspection }));
        setNote(`🔍「${r.card.name}」：${inspectionText(r.inspection)}`);
      }
    } catch (e) { setNote((e as Error).message); } finally { asking.current.delete(cardId); }
  };
  const loupe = useDrag<'loupe'>((_, zone) => { if (zone.startsWith('card-')) void inspectCard(Number(zone.slice(5))); });
  // 在一张卡上停 LOUPE_DWELL_MS 就算查验（不用松手），镜片里马上出现细节
  const hoverId = loupe.drag?.zone?.startsWith('card-') ? Number(loupe.drag.zone.slice(5)) : null;
  useEffect(() => {
    if (hoverId === null) return;
    const t = window.setTimeout(() => void inspectCard(hoverId), LOUPE_DWELL_MS);
    return () => window.clearTimeout(t);
  }, [hoverId]);
  // 台面上的卡以前查过的，把结论也带出来
  useEffect(() => {
    for (const it of table) {
      if (it.kind !== 'card' || looks[it.id] !== undefined) continue;
      api<CardAppraisalResponse>(`/cards/${it.id}/appraisal`)
        .then((r) => setLooks((m) => ({ ...m, [it.id]: r.inspection })))
        .catch(() => {});
    }
  }, [table]);
  const lensRect = hoverId !== null ? document.querySelector(`[data-drop="card-${hoverId}"] .card`)?.getBoundingClientRect() ?? null : null;
  const lensCard = hoverId !== null ? seen.current.get(hoverId) ?? null : null;

  const send = async (path: 'offer' | 'quick', p?: number) => {
    if (!selected) return;
    setBusy(true);
    setNote('');
    try {
      const item = selected.kind === 'pack' ? { packId: selected.id } : { instanceId: selected.id };
      const r = await api<OfferResponse>(`/counter/${customer.id}/${path}`, {
        method: 'POST', idempotencyKey: newIdempotencyKey(), body: { ...item, ...(p !== undefined ? { price: p } : {}) },
      });
      onChange({ credits: r.credits, reputation: r.reputation });
      if (r.outcome === 'counter') { setNote(`对方还价 ${fmt(r.customer.counterPrice ?? 0)}`); onUpdate(r.customer); }
      else if (r.outcome === 'too_high') { setNote('对方嫌太贵了'); onUpdate(r.customer); }
      else if (r.outcome === 'deal') {
        takeBack(selected); // 卖掉了，从台面上拿走
        onDone(`成交！「${selected.name}」卖了 ${fmt(r.price ?? 0)} 信用点`);
      } else if (r.outcome === 'caught') onDone('被识破是假货！信誉下降');
      else if (r.outcome === 'busted') { takeBack(selected); onDone(`对方是便衣！「${selected.name}」是赃卡，被没收，罚款 ${fmt(r.fine ?? 0)}，信誉下降`); }
      else onDone(`${customer.typeName}走了`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await api(`/counter/${customer.id}/dismiss`, { method: 'POST', body: {} });
      onDone(`请${customer.typeName}离开了`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const empty = stock && stock.cards.length === 0 && stock.packs.length === 0;
  const fromSource = drag?.item.from === 'source';
  const dropClass = fromSource ? (drag?.zone === 'counter' ? ' drop-target drop-over' : ' drop-target') : '';
  const open = (id: number | 'showcase', name: string) =>
    setOpenBinders((xs) => (xs.some((x) => x.id === id) ? xs.filter((x) => x.id !== id) : [...xs, { id, name }]));
  const isOpen = (id: number | 'showcase') => openBinders.some((b) => b.id === id);
  const draggingKey = drag ? keyOf(drag.item.item) : null;

  return (
    <div className="visitor">
      <div className="deal-main">
        <div className="visitor-head">
          <CustomerAvatar type={customer.type} id={customer.id} emoji={AVATAR[customer.type] ?? '🙂'} />
          <div>
            <b>{customer.typeName}</b> <Patience c={customer} />
            <p className="bubble">{customer.line}</p>
            <p className="hint">想要：{customer.demand.text} · 预算约 {fmt(customer.budgetLow)}–{fmt(customer.budgetHigh)}</p>
          </div>
        </div>

        {/* 柜台台面：上半是客人那一侧（以后客人卖卡时摆在这里），下半是你放上来的东西 */}
        <div className={`counter-top${dropClass}`} data-drop="counter">
          <div className="counter-side customer-side" aria-hidden />
          {/* 放大镜：柜台上的道具，按住拖到卡上查验 */}
          <button className={loupe.drag ? 'loupe-tool lifted' : 'loupe-tool'} title="放大镜：拖到卡上查验" aria-label="放大镜" {...loupe.bind('loupe')}>🔍</button>
          <button className="guide-tool" title="假卡识别手册" aria-label="假卡识别手册" onClick={() => setGuide(!guide)}>📕</button>
          <div className="counter-side my-side">
            {table.length === 0 && <p className="counter-empty">{fromSource ? '松手放到柜台上' : '把要卖的卡拖到柜台上，可以摆好几张'}</p>}
            {table.map((it) => {
              const k = keyOf(it);
              const ok = wanted.has(k);
              const hover = loupe.drag && it.kind === 'card' && loupe.drag.zone === `card-${it.id}`;
              const cls = `table-item draggable${selected && keyOf(selected) === k ? ' on' : ''}${ok ? '' : ' unwanted'}${draggingKey === k ? ' dragging' : ''}${hover ? ' loupe-over' : ''}`;
              return (
                <button key={k} className={cls} onClick={() => select(it)} {...bind({ item: it, from: 'table' })} data-drop={it.kind === 'card' ? `card-${it.id}` : undefined}>
                  <ItemArt item={it} />
                  <span className="cell-price">{ok ? `快卖 ${fmt(wanted.get(k)!)}` : '这位不要'}</span>
                  {it.kind === 'card' && looks[it.id] && <span className="look-chip">🔍 {inspectionText(looks[it.id]!)}</span>}
                </button>
              );
            })}
          </div>
        </div>
        {table.length > 0 && <p className="hint table-tip">点一张选中它再开价；拖到台面外面就是拿回来（台面 {table.length} / {COUNTER.tableSlots}）</p>}

        {selected && (
          <div className="offer-box">
            <p className="offer-title"><b>{selected.name}</b> <span className="hint">{selected.kind === 'pack' ? '没拆的卡包' : `市场价约 ${fmt(selected.price)}`}</span></p>
            <PriceGuide type={customer.type} typeName={customer.typeName} quick={selectedQuick} price={Number(price) || 0} />
            <div className="price-input">
              <span>开价</span>
              <button className="step-btn" aria-label={`减 ${step}`} disabled={!price || Number(price) <= 1} onClick={() => bump(-step)}>−</button>
              <input inputMode="numeric" aria-label="开价" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />
              <button className="step-btn" aria-label={`加 ${step}`} onClick={() => bump(step)}>+</button>
            </div>
            <div className="step-choices">
              <span className="hint">每次加减</span>
              {STEPS.map((s) => (
                <button key={s} className={step === s ? 'chip on' : 'chip'} onClick={() => setStep(s)}>{fmt(s)}</button>
              ))}
            </div>
            <button className="primary" disabled={busy || !price} onClick={() => send('offer', Number(price))}>开价 {price ? fmt(Number(price)) : ''}</button>
            {customer.counterPrice !== null && (
              <button className="secondary" disabled={busy} onClick={() => send('offer', customer.counterPrice!)}>接受还价 {fmt(customer.counterPrice)}</button>
            )}
            <button className="secondary" disabled={busy} onClick={() => send('quick')}>快速出售 {fmt(selectedQuick)}（必定成交）</button>
          </div>
        )}
        {note && <p className="deal-msg">{note}</p>}
        <button className="secondary" disabled={busy} onClick={dismiss}>请他离开</button>
      </div>

      {stock && (
        <div className="counter-sources">
          {empty && <p className="hint">你手上没有他要的东西。</p>}
          {stock.packs.length > 0 && (
            <>
              <h3>没拆的卡包 <small>拖到柜台上</small></h3>
              <div className="grid">
                {stock.packs.map((p) => {
                  const item: Item = { kind: 'pack', id: p.id, name: p.name, price: p.quickPrice, quickPrice: p.quickPrice, packKind: p.kind, seriesId: p.seriesId };
                  return (
                    <button key={`p${p.id}`} className={draggingKey === keyOf(item) ? 'cell draggable dragging' : 'cell draggable'} onClick={() => place(item)} {...sourceBind(item)}>
                      <ItemArt item={item} />
                      <span className="cell-price">快卖 {fmt(p.quickPrice)}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {customer.demand.kind === 'card' && (
            <>
              <h3>翻卡册找卡 <small>符合的一共 {stock.cards.length} 张</small></h3>
              <div className="binder-list">
                {stock.binders.map((b) => (
                  <SourceButton key={b.id} cover={b.name.slice(0, 2)} coverClass={`binder-${b.kind}`} name={b.name} sub={`${b.used} / ${b.slots} 张`}
                    matchCount={b.matchCount} on={isOpen(b.id)} onClick={() => open(b.id, b.name)} />
                ))}
                {stock.showcase.count > 0 && (
                  <SourceButton cover="珍藏" coverClass="binder-showcase" name="珍藏柜" sub={`${stock.showcase.count} 张`}
                    matchCount={stock.showcase.matchCount} on={isOpen('showcase')} onClick={() => open('showcase', '珍藏柜')} />
                )}
                {stock.loose.count > 0 && (
                  <SourceButton cover="桌面" coverClass="binder-loose" name="桌面散放" sub={`${stock.loose.count} 张`}
                    matchCount={stock.loose.matchCount} on={isOpen(0)} onClick={() => open(0, '桌面散放')} />
                )}
              </div>
            </>
          )}
        </div>
      )}

      {openBinders.map((b, i) => (
        <FloatWindow key={String(b.id)} id={`counter-binder-${b.id}`} cascade={i} className="float-binder" title={b.name}
          onClose={() => setOpenBinders((xs) => xs.filter((x) => x.id !== b.id))}>
          <BinderPicker customerId={customer.id} binder={b} onPick={place} bind={sourceBind}
            draggingId={drag?.item.item.kind === 'card' ? drag.item.item.id : null}
            onTable={new Set(table.filter((t) => t.kind === 'card').map((t) => t.id))}
            onCards={(cs) => { for (const c of cs) seen.current.set(c.id, c); }} />
        </FloatWindow>
      ))}
      {loupe.drag && lensRect && lensCard && (
        <LoupeLens x={loupe.drag.x} y={loupe.drag.y} rect={lensRect} card={lensCard} inspection={looks[lensCard.id] ?? null} />
      )}
      {loupe.drag && (
        <DragGhost x={loupe.drag.x} y={loupe.drag.y}>
          <span className="loupe-ghost" aria-hidden>🔍</span>
          {!lensCard && <span className="ghost-hint">拿到要查验的卡上停一下</span>}
        </DragGhost>
      )}
      {drag && (
        <DragGhost x={drag.x} y={drag.y}>
          <ItemArt item={drag.item.item} />
          <span className="ghost-hint">
            {drag.item.from === 'source'
              ? (drag.zone === 'counter' ? '松手放到柜台上' : '拖到柜台上')
              : (drag.zone === 'counter' ? '拖到台面外面拿回来' : '松手拿回来')}
          </span>
        </DragGhost>
      )}
    </div>
  );
}
