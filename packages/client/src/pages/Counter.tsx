// 柜台页（FR-CTR-1～5）：一个营业日 6 位顾客一次到店；点顾客 → 挑卡 → 开价 / 快速出售 / 接受还价。
// 顾客都接待完（或请走）就能打烊，进入下一个营业日（学深空当铺，2026-11-17）。
import { useEffect, useState } from 'react';
import { STORE } from '@kanu/shared/balance';
import type { CounterResponse, CustomerView, EligibleCardsResponse, EndDayResponse, MeResponse, OfferResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';

const AVATAR: Record<string, string> = { resident: '🧑‍🔧', collector: '🧐', rich: '🤵', middleman: '🕶️' };
const STATUS: Record<string, string> = { sold: '已成交', left: '已离开', dismissed: '已请走' };

export function Counter({ onChange }: { onChange: (patch: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<CounterResponse | null>(null);
  const [active, setActive] = useState<CustomerView | null>(null);
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api<CounterResponse>('/counter').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);

  const update = (c: CustomerView) => {
    setData((d) => (d ? { ...d, customers: d.customers.map((x) => (x.id === c.id ? c : x)) } : d));
    setActive(c.status === 'waiting' ? c : null);
  };

  const endDay = async () => {
    setClosing(true);
    setErr('');
    try {
      const r = await api<EndDayResponse>('/day/end', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ gameDay: r.day, packsLeftToday: STORE.packsPerDay });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setClosing(false);
    }
  };

  const waiting = data?.customers.filter((c) => c.status === 'waiting').length ?? 0;

  return (
    <section className="page">
      <h2>柜台 · 第 {data?.day ?? '-'} 天 <small>{waiting} 位在等</small></h2>
      {data?.customers.map((c) => (
        <button key={c.id} className={`customer${c.status === 'waiting' ? '' : ' done'}`} disabled={c.status !== 'waiting'} onClick={() => setActive(c)}>
          <span className="customer-avatar" aria-hidden>{AVATAR[c.type] ?? '🙂'}</span>
          <span className="customer-body">
            <span className="customer-head">
              <b>{c.typeName}</b>
              {c.status === 'waiting' ? <Patience c={c} /> : <span className="badge">{STATUS[c.status]}</span>}
            </span>
            <span className="bubble">{c.line}</span>
            <span className="customer-meta">想要：{c.demand.text} · 预算约 {fmt(c.budgetLow)}–{fmt(c.budgetHigh)}</span>
          </span>
        </button>
      ))}
      {data && waiting === 0 && (
        <button className="primary" disabled={closing} onClick={endDay}>{closing ? '打烊中…' : `打烊，进入第 ${data.day + 1} 天`}</button>
      )}
      {data && waiting > 0 && <p className="hint">客人都接待完（或者请走）就能打烊，进入下一天。</p>}
      {err && <p className="error">{err}</p>}
      {active && <Deal customer={active} onClose={() => setActive(null)} onUpdate={update} onChange={onChange} />}
    </section>
  );
}

function Patience({ c }: { c: CustomerView }) {
  return <span className="patience" aria-label={`耐心 ${c.patience}/${c.maxPatience}`}>{'●'.repeat(c.patience)}{'○'.repeat(Math.max(0, c.maxPatience - c.patience))}</span>;
}

function Deal({ customer, onClose, onUpdate, onChange }: {
  customer: CustomerView;
  onClose: () => void;
  onUpdate: (c: CustomerView) => void;
  onChange: (patch: Partial<MeResponse>) => void;
}) {
  const [cards, setCards] = useState<EligibleCardsResponse['cards'] | null>(null);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<EligibleCardsResponse>(`/counter/${customer.id}/cards`).then((r) => setCards(r.cards)).catch((e: Error) => setMsg(e.message));
  }, [customer.id]);

  const picked = cards?.find((c) => c.card.id === pickedId) ?? null;

  const send = async (path: 'offer' | 'quick', p?: number) => {
    if (!picked) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await api<OfferResponse>(`/counter/${customer.id}/${path}`, {
        method: 'POST', idempotencyKey: newIdempotencyKey(), body: { instanceId: picked.card.id, ...(p !== undefined ? { price: p } : {}) },
      });
      onChange({ credits: r.credits, reputation: r.reputation });
      const text: Record<OfferResponse['outcome'], string> = {
        deal: `成交！收入 ${fmt(r.price ?? 0)} 信用点`,
        counter: `对方还价 ${fmt(r.customer.counterPrice ?? 0)}`,
        too_high: '对方嫌太贵了',
        left: '对方走了',
        caught: '被识破是假卡！信誉下降',
      };
      setMsg(text[r.outcome]);
      if (r.outcome === 'deal') setTimeout(() => onUpdate(r.customer), 900);
      else onUpdate(r.customer);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    const r = await api<{ customer: CustomerView }>(`/counter/${customer.id}/dismiss`, { method: 'POST', body: {} });
    onUpdate(r.customer);
  };

  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <div className="deal-head">
          <span className="customer-avatar" aria-hidden>{AVATAR[customer.type] ?? '🙂'}</span>
          <div>
            <b>{customer.typeName}</b> <Patience c={customer} />
            <p className="bubble">{customer.line}</p>
            <p className="hint">想要：{customer.demand.text} · 预算约 {fmt(customer.budgetLow)}–{fmt(customer.budgetHigh)}</p>
          </div>
        </div>

        {!picked && (
          <>
            <h3>挑一张卡</h3>
            {cards && cards.length === 0 && <p className="hint">你手上没有他要的卡。</p>}
            <div className="grid">
              {cards?.map(({ card, quickPrice }) => (
                <button key={card.id} className="cell" onClick={() => { setPickedId(card.id); setPrice(String(card.price)); }}>
                  <Card card={card} small />
                  <span className="cell-price">快卖 {fmt(quickPrice)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {picked && (
          <>
            <div className="deal-card"><Card card={picked.card} small /><div>
              <b>{picked.card.name}</b>
              <p className="hint">市场价约 {fmt(picked.card.price)}</p>
              <button className="chip" onClick={() => setPickedId(null)}>换一张</button>
            </div></div>
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

        {msg && <p className="deal-msg">{msg}</p>}
        <button className="secondary" onClick={dismiss}>请他离开</button>
        <button className="secondary" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
