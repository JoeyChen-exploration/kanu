// 柜台页（FR-CTR-1～5）：顾客一位一位进门（学深空当铺）。只看得到眼前这一位，处理完下一位才进来，
// 不知道下一位是谁、今天还剩几位。挑卡（或卡包）→ 开价 / 接受还价 / 快速出售 / 请走。都接待完就能打烊。
import { useEffect, useState } from 'react';
import { STORE } from '@kanu/shared/balance';
import type { CardView, CounterBinderPageResponse, CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, MeResponse, OfferResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';

export const AVATAR: Record<string, string> = {
  resident: '🧑‍🔧', student: '🧒', tourist: '🧳', collector: '🧐', nostalgic: '👴',
  rich: '🤵', speculator: '📈', streamer: '🎥', middleman: '🕶️',
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

type Picked = { kind: 'card' | 'pack'; id: number; name: string; price: number; quickPrice: number };

/** "符合的排前面"开关记在本机，下次进柜台还是上次的选择 */
const MATCH_FIRST_KEY = 'kanu.counter.matchFirst';
const readMatchFirst = () => { try { return localStorage.getItem(MATCH_FIRST_KEY) !== '0'; } catch { return true; } };

/** 柜台上翻一本卡册：一页 3 × 3，符合这位顾客的高亮可点，不符合的变暗 */
function BinderPicker({ customerId, binder, onBack, onPick }: {
  customerId: number;
  binder: { id: number; name: string };
  onBack: () => void;
  onPick: (card: CardView, quickPrice: number) => void;
}) {
  const [matchFirst, setMatchFirst] = useState(readMatchFirst);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CounterBinderPageResponse | null>(null);
  const [err, setErr] = useState('');
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
    <div className="binder-picker">
      <div className="picker-head">
        <button className="chip" onClick={onBack}>← 换一本</button>
        <b>{binder.name}</b>
        <button className={matchFirst ? 'chip on' : 'chip'} onClick={toggle}>符合的排前面</button>
      </div>
      <div className="binder-page">
        {cards.map(({ card, match, quickPrice }) => (
          match
            ? (
              <button key={card.id} className="cell match" onClick={() => onPick(card, quickPrice ?? 0)}>
                <Card card={card} small />
                <span className="cell-price">快卖 {fmt(quickPrice ?? 0)}</span>
              </button>
            )
            : <div key={card.id} className="cell dim" aria-disabled><Card card={card} small /></div>
        ))}
        {Array.from({ length: Math.max(0, 9 - cards.length) }, (_, i) => <div key={`e${i}`} className="binder-slot" />)}
      </div>
      <div className="pager">
        <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {data?.page ?? page} / {data?.pages ?? 1} 页</span>
        <button className="chip" disabled={!data || page >= data.pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** 眼前这一位：顾客信息 + 挑货 + 开价 */
function Deal({ customer, onChange, onDone, onUpdate }: {
  customer: CustomerView;
  onChange: (patch: Partial<MeResponse>) => void;
  onDone: (text: string) => void;
  onUpdate: (c: CustomerView) => void;
}) {
  const [stock, setStock] = useState<EligibleCardsResponse | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** 正在翻的卡册（id 0 = 桌面散放）；挑完卡点"换一样"会回到这本 */
  const [openBinder, setOpenBinder] = useState<{ id: number; name: string } | null>(null);
  const [price, setPrice] = useState('');
  const [step, setStep] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  /** 按当前步长加减开价，最低 1 */
  const bump = (d: number) => setPrice((p) => String(Math.max(1, (Number(p) || 0) + d)));

  useEffect(() => {
    api<EligibleCardsResponse>(`/counter/${customer.id}/cards`).then(setStock).catch((e: Error) => setNote(e.message));
  }, [customer.id]);

  const send = async (path: 'offer' | 'quick', p?: number) => {
    if (!picked) return;
    setBusy(true);
    setNote('');
    try {
      const item = picked.kind === 'pack' ? { packId: picked.id } : { instanceId: picked.id };
      const r = await api<OfferResponse>(`/counter/${customer.id}/${path}`, {
        method: 'POST', idempotencyKey: newIdempotencyKey(), body: { ...item, ...(p !== undefined ? { price: p } : {}) },
      });
      onChange({ credits: r.credits, reputation: r.reputation });
      if (r.outcome === 'counter') { setNote(`对方还价 ${fmt(r.customer.counterPrice ?? 0)}`); onUpdate(r.customer); }
      else if (r.outcome === 'too_high') { setNote('对方嫌太贵了'); onUpdate(r.customer); }
      else if (r.outcome === 'deal') onDone(`成交！「${picked.name}」卖了 ${fmt(r.price ?? 0)} 信用点`);
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

      {!picked && openBinder && (
        <BinderPicker customerId={customer.id} binder={openBinder} onBack={() => setOpenBinder(null)}
          onPick={(card, quickPrice) => { setPicked({ kind: 'card', id: card.id, name: card.name, price: card.price, quickPrice }); setPrice(String(card.price)); }} />
      )}

      {!picked && !openBinder && stock && (
        <>
          {empty && <p className="hint">你手上没有他要的东西。</p>}
          {stock.packs.length > 0 && (
            <>
              <h3>没拆的卡包</h3>
              <div className="grid">
                {stock.packs.map((p) => (
                  <button key={`p${p.id}`} className="cell" onClick={() => { setPicked({ kind: 'pack', id: p.id, name: p.name, price: p.quickPrice, quickPrice: p.quickPrice }); setPrice(String(p.quickPrice)); }}>
                    <div className={`pack-art kind-${p.kind}`} aria-hidden>{p.name.slice(0, 2)}</div>
                    <span className="cell-price">快卖 {fmt(p.quickPrice)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {customer.demand.kind === 'card' && (
            <>
              <h3>翻卡册找卡 <small>符合的一共 {stock.cards.length} 张</small></h3>
              <div className="binder-list">
                {stock.binders.map((b) => (
                  <button key={b.id} className={b.matchCount ? 'binder-item has-match' : 'binder-item'} onClick={() => setOpenBinder({ id: b.id, name: b.name })}>
                    <div className={`binder-cover binder-${b.kind}`} aria-hidden>{b.name.slice(0, 2)}</div>
                    <div className="binder-body">
                      <b>{b.name}</b>
                      <span className="hint">{b.used} / {b.slots} 张</span>
                    </div>
                    <span className={b.matchCount ? 'match-badge' : 'match-badge none'}>{b.matchCount ? `${b.matchCount} 张符合` : '没有符合的'}</span>
                  </button>
                ))}
                {stock.loose.count > 0 && (
                  <button className={stock.loose.matchCount ? 'binder-item has-match' : 'binder-item'} onClick={() => setOpenBinder({ id: 0, name: '桌面散放' })}>
                    <div className="binder-cover binder-loose" aria-hidden>桌面</div>
                    <div className="binder-body">
                      <b>桌面散放</b>
                      <span className="hint">{stock.loose.count} 张</span>
                    </div>
                    <span className={stock.loose.matchCount ? 'match-badge' : 'match-badge none'}>{stock.loose.matchCount ? `${stock.loose.matchCount} 张符合` : '没有符合的'}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {picked && (
        <>
          <div className="deal-card">
            <div><b>{picked.name}</b><p className="hint">{picked.kind === 'pack' ? '没拆的卡包' : `市场价约 ${fmt(picked.price)}`}</p></div>
            <button className="chip" onClick={() => setPicked(null)}>换一样</button>
          </div>
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
          <button className="secondary" disabled={busy} onClick={() => send('quick')}>快速出售 {fmt(picked.quickPrice)}（必定成交）</button>
        </>
      )}

      {note && <p className="deal-msg">{note}</p>}
      <button className="secondary" disabled={busy} onClick={dismiss}>请他离开</button>
    </div>
  );
}
