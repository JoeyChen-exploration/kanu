// 柜台页（FR-CTR-1～5）：顾客一位一位进门（学深空当铺）。只看得到眼前这一位，处理完下一位才进来，
// 不知道下一位是谁、今天还剩几位。挑卡（或卡包）→ 开价 / 接受还价 / 快速出售 / 请走。都接待完就能打烊。
import { useEffect, useState } from 'react';
import { STORE } from '@kanu/shared/balance';
import type { CardView, CounterBinderPageResponse, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, MeResponse, OfferResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';
import { DragGhost, FloatWindow, useDrag } from '../drag.tsx';

export const AVATAR: Record<string, string> = {
  resident: '🧑‍🔧', student: '🧒', tourist: '🧳', collector: '🧐', nostalgic: '👴',
  rich: '🤵', speculator: '📈', streamer: '🎥', middleman: '🕶️', grand: '🎩',
};
const STATUS: Record<string, string> = { sold: '成交', left: '走了', dismissed: '请走' };
/** 开价时每次加减多少，玩家自己选 */
const STEPS = [1, 10, 100, 1000];

export function Counter({ onChange }: { onChange: (patch: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<CounterResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

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
      onChange({ gameDay: r.day, packsLeftToday: STORE.packsPerDay });
      setMsg('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <section className="page"><p className="hint">开门中…</p>{err && <p className="error">{err}</p>}</section>;

  return (
    <section className="page">
      <h2>柜台 · 第 {data.day} 天 <small>已接待 {data.served.length} 位</small></h2>
      {msg && <p className="deal-msg">{msg}</p>}

      {data.current && (
        <Deal key={data.current.id} customer={data.current} onChange={onChange} onDone={afterResult} onUpdate={(c) => setData({ ...data, current: c })} />
      )}

      {data.done && (
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
              <span aria-hidden>{AVATAR[c.type] ?? '🙂'}</span>
              <span>{c.typeName}</span>
              <span className="badge">{STATUS[c.status]}</span>
            </div>
          ))}
        </details>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Patience({ c }: { c: CustomerView }) {
  return <span className="patience" aria-label={`耐心 ${c.patience}/${c.maxPatience}`}>{'●'.repeat(c.patience)}{'○'.repeat(Math.max(0, c.maxPatience - c.patience))}</span>;
}


/** 放上柜台台面的东西：一张卡或一包没拆的卡包 */
type Item =
  | { kind: 'card'; id: number; name: string; price: number; quickPrice: number; card: CardView }
  | { kind: 'pack'; id: number; name: string; price: number; quickPrice: number; packKind: string };

const cardItem = (card: CardView, quickPrice: number): Item => ({ kind: 'card', id: card.id, name: card.name, price: card.price, quickPrice, card });

/** 台面上和拖动影子里画这件东西 */
function ItemArt({ item }: { item: Item }) {
  return item.kind === 'card'
    ? <Card card={item.card} small />
    : <div className={`pack-art kind-${item.packKind}`} aria-hidden>{item.name.slice(0, 2)}</div>;
}

/** "符合的排前面"开关记在本机，下次进柜台还是上次的选择 */
const MATCH_FIRST_KEY = 'kanu.counter.matchFirst';
const readMatchFirst = () => { try { return localStorage.getItem(MATCH_FIRST_KEY) !== '0'; } catch { return true; } };

/** 柜台卡册浮窗的内容：一页 3 × 3，符合这位顾客的高亮、能拖上台面（轻点也行），不符合的变暗 */
function BinderPicker({ customerId, binder, onPick, bind, draggingId }: {
  customerId: number;
  binder: { id: number | 'showcase'; name: string };
  onPick: (item: Item) => void;
  bind: (item: Item) => ReturnType<ReturnType<typeof useDrag<Item>>['bind']>;
  draggingId: number | null;
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
  return (
    <>
      <div className="picker-head">
        <span className="hint">发光的卡拖到柜台上</span>
        <button className={matchFirst ? 'chip on' : 'chip'} onClick={toggle}>符合的排前面</button>
      </div>
      <div className="binder-page">
        {cards.map(({ card, match, quickPrice }) => {
          if (!match) return <div key={card.id} className="cell dim" aria-disabled><Card card={card} small /></div>;
          const item = cardItem(card, quickPrice ?? 0);
          return (
            <button key={card.id} className={draggingId === card.id ? 'cell match draggable dragging' : 'cell match draggable'} onClick={() => onPick(item)} {...bind(item)}>
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

/**
 * 眼前这一位。交互原则（DESIGN 4.5，2026-11-17 用户定）：东西靠拖，结果靠按钮确认。
 * 把要卖的卡从卡册浮窗（或卡包）拖到柜台台面上 → 调价 → 按"开价 / 接受还价 / 快速出售"。
 * 台面上留了客人那一侧，以后客人卖卡给你时，他的卡也摆在台面上。
 */
function Deal({ customer, onChange, onDone, onUpdate }: {
  customer: CustomerView;
  onChange: (patch: Partial<MeResponse>) => void;
  onDone: (text: string) => void;
  onUpdate: (c: CustomerView) => void;
}) {
  const [stock, setStock] = useState<EligibleCardsResponse | null>(null);
  const [onCounter, setOnCounter] = useState<Item | null>(null);
  /** 柜台上打开的卡册浮窗（id 0 = 桌面散放） */
  const [openBinder, setOpenBinder] = useState<{ id: number | 'showcase'; name: string } | null>(null);
  const [price, setPrice] = useState('');
  const [step, setStep] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  /** 按当前步长加减开价，最低 1 */
  const bump = (d: number) => setPrice((p) => String(Math.max(1, (Number(p) || 0) + d)));

  useEffect(() => {
    api<EligibleCardsResponse>(`/counter/${customer.id}/cards`).then(setStock).catch((e: Error) => setNote(e.message));
  }, [customer.id]);

  /** 放上台面：开价先填市场价（卡包填快卖价），玩家再调 */
  const place = (item: Item) => {
    setOnCounter(item);
    setPrice(String(item.kind === 'card' ? item.price : item.quickPrice));
    setNote('');
  };
  const { drag, bind } = useDrag<Item>((item, zone) => { if (zone === 'counter') place(item); });

  const send = async (path: 'offer' | 'quick', p?: number) => {
    if (!onCounter) return;
    setBusy(true);
    setNote('');
    try {
      const item = onCounter.kind === 'pack' ? { packId: onCounter.id } : { instanceId: onCounter.id };
      const r = await api<OfferResponse>(`/counter/${customer.id}/${path}`, {
        method: 'POST', idempotencyKey: newIdempotencyKey(), body: { ...item, ...(p !== undefined ? { price: p } : {}) },
      });
      onChange({ credits: r.credits, reputation: r.reputation });
      if (r.outcome === 'counter') { setNote(`对方还价 ${fmt(r.customer.counterPrice ?? 0)}`); onUpdate(r.customer); }
      else if (r.outcome === 'too_high') { setNote('对方嫌太贵了'); onUpdate(r.customer); }
      else if (r.outcome === 'deal') onDone(`成交！「${onCounter.name}」卖了 ${fmt(r.price ?? 0)} 信用点`);
      else if (r.outcome === 'caught') onDone('被识破是假货！信誉下降');
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
  const dropClass = drag ? (drag.zone === 'counter' ? ' drop-target drop-over' : ' drop-target') : '';
  const open = (id: number | 'showcase', name: string) => setOpenBinder(openBinder?.id === id ? null : { id, name });

  return (
    <div className="visitor">
      <div className="visitor-head">
        <span className="visitor-avatar" aria-hidden>{AVATAR[customer.type] ?? '🙂'}</span>
        <div>
          <b>{customer.typeName}</b> <Patience c={customer} />
          <p className="bubble">{customer.line}</p>
          <p className="hint">想要：{customer.demand.text} · 预算约 {fmt(customer.budgetLow)}–{fmt(customer.budgetHigh)}</p>
        </div>
      </div>

      {/* 柜台台面：上半是客人那一侧（以后客人卖卡时摆在这里），下半是你放上来的东西 */}
      <div className={`counter-top${dropClass}`} data-drop="counter">
        <div className="counter-side customer-side" aria-hidden />
        <div className="counter-side my-side">
          {onCounter
            ? (
              <div className="counter-item">
                <ItemArt item={onCounter} />
                <div className="counter-item-info">
                  <b>{onCounter.name}</b>
                  <span className="hint">{onCounter.kind === 'pack' ? '没拆的卡包' : `市场价约 ${fmt(onCounter.price)}`}</span>
                  <button className="chip" onClick={() => setOnCounter(null)}>拿回</button>
                </div>
              </div>
            )
            : <p className="counter-empty">{drag ? '松手放到柜台上' : '把要卖的卡拖到柜台上'}</p>}
        </div>
      </div>

      {onCounter && (
        <>
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
          <button className="secondary" disabled={busy} onClick={() => send('quick')}>快速出售 {fmt(onCounter.quickPrice)}（必定成交）</button>
        </>
      )}
      {note && <p className="deal-msg">{note}</p>}

      {stock && (
        <div className="counter-sources">
          {empty && <p className="hint">你手上没有他要的东西。</p>}
          {stock.packs.length > 0 && (
            <>
              <h3>没拆的卡包 <small>拖到柜台上</small></h3>
              <div className="grid">
                {stock.packs.map((p) => {
                  const item: Item = { kind: 'pack', id: p.id, name: p.name, price: p.quickPrice, quickPrice: p.quickPrice, packKind: p.kind };
                  return (
                    <button key={`p${p.id}`} className={drag?.item.kind === 'pack' && drag.item.id === p.id ? 'cell draggable dragging' : 'cell draggable'} onClick={() => place(item)} {...bind(item)}>
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
                    matchCount={b.matchCount} on={openBinder?.id === b.id} onClick={() => open(b.id, b.name)} />
                ))}
                {stock.showcase.count > 0 && (
                  <SourceButton cover="珍藏" coverClass="binder-showcase" name="珍藏柜" sub={`${stock.showcase.count} 张`}
                    matchCount={stock.showcase.matchCount} on={openBinder?.id === 'showcase'} onClick={() => open('showcase', '珍藏柜')} />
                )}
                {stock.loose.count > 0 && (
                  <SourceButton cover="桌面" coverClass="binder-loose" name="桌面散放" sub={`${stock.loose.count} 张`}
                    matchCount={stock.loose.matchCount} on={openBinder?.id === 0} onClick={() => open(0, '桌面散放')} />
                )}
              </div>
            </>
          )}
        </div>
      )}

      <button className="secondary" disabled={busy} onClick={dismiss}>请他离开</button>

      {openBinder && (
        <FloatWindow id="counter-binder" className="float-binder" title={openBinder.name} onClose={() => setOpenBinder(null)}>
          <BinderPicker customerId={customer.id} binder={openBinder} onPick={place} bind={bind}
            draggingId={drag?.item.kind === 'card' ? drag.item.id : null} />
        </FloatWindow>
      )}
      {drag && (
        <DragGhost x={drag.x} y={drag.y}>
          <ItemArt item={drag.item} />
          <span className="ghost-hint">{drag.zone === 'counter' ? '松手放到柜台上' : '拖到柜台上'}</span>
        </DragGhost>
      )}
    </div>
  );
}
