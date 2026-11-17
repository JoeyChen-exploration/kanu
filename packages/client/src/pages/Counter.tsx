// 柜台页（FR-CTR-1～5）：顾客一位一位进门（学深空当铺）。只看得到眼前这一位，处理完下一位才进来，
// 不知道下一位是谁、今天还剩几位。挑卡（或卡包）→ 开价 / 接受还价 / 快速出售 / 请走。都接待完就能打烊。
import { useEffect, useState } from 'react';
import { STORE } from '@kanu/shared/balance';
import type { CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, MeResponse, OfferResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';

const AVATAR: Record<string, string> = {
  resident: '🧑‍🔧', student: '🧒', tourist: '🧳', collector: '🧐', nostalgic: '👴',
  rich: '🤵', speculator: '📈', streamer: '🎥', middleman: '🕶️',
};
const STATUS: Record<string, string> = { sold: '成交', left: '走了', dismissed: '请走' };

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

/** 眼前这一位：顾客信息 + 挑货 + 开价 */
function Deal({ customer, onChange, onDone, onUpdate }: {
  customer: CustomerView;
  onChange: (patch: Partial<MeResponse>) => void;
  onDone: (text: string) => void;
  onUpdate: (c: CustomerView) => void;
}) {
  const [stock, setStock] = useState<EligibleCardsResponse | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

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

      {!picked && (
        <>
          {empty && <p className="hint">你手上没有他要的东西。</p>}
          <div className="grid">
            {stock?.packs.map((p) => (
              <button key={`p${p.id}`} className="cell" onClick={() => { setPicked({ kind: 'pack', id: p.id, name: p.name, price: p.quickPrice, quickPrice: p.quickPrice }); setPrice(String(p.quickPrice)); }}>
                <div className={`pack-art kind-${p.kind}`} aria-hidden>{p.name.slice(0, 2)}</div>
                <span className="cell-price">快卖 {fmt(p.quickPrice)}</span>
              </button>
            ))}
            {stock?.cards.map(({ card, quickPrice }) => (
              <button key={card.id} className="cell" onClick={() => { setPicked({ kind: 'card', id: card.id, name: card.name, price: card.price, quickPrice }); setPrice(String(card.price)); }}>
                <Card card={card} small />
                <span className="cell-price">快卖 {fmt(quickPrice)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {picked && (
        <>
          <div className="deal-card">
            <div><b>{picked.name}</b><p className="hint">{picked.kind === 'pack' ? '没拆的卡包' : `市场价约 ${fmt(picked.price)}`}</p></div>
            <button className="chip" onClick={() => setPicked(null)}>换一样</button>
          </div>
          <label className="price-input">
            开价
            <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />
            信用点
          </label>
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
