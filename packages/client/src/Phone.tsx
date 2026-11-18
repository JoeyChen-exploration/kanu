// 电话（道具浮窗，2026-11-17 用户定）：花信用点买；里面两个号码——星港评级社（送评）、批发商（整盒订货，DESIGN 4）。
// 送评：把卡（从库存页 / 柜台的卡册浮窗、台面、桌面）拖到电话的评级社上，再按"送评"。下次打烊出结果。
// 各页面的拖拽在松手到电话上时广播 PHONE_DROP，电话自己接住。
import { useEffect, useState } from 'react';
import { APPRAISAL, ERRATA, PHONE, WHOLESALE } from '@kanu/shared/balance';
import type { BuyPhoneResponse, CardAppraisalResponse, CardView, GradeBatchResponse, MeResponse, PhoneResponse, WholesaleResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { Card, fmt } from './Card.tsx';
import { FloatWindow } from './drag.tsx';

/** 卡被拖到电话上：各页面广播这个事件，电话接住 */
export const PHONE_DROP = 'kanu:phone-drop';
/** 拖拽时电话的放卡区域（data-drop） */
export const PHONE_ZONE = 'phone';
export const dropOnPhone = (card: CardView) => window.dispatchEvent(new CustomEvent<CardView>(PHONE_DROP, { detail: card }));

export function Phone({ onClose, onChange }: { onClose: () => void; onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<PhoneResponse | null>(null);
  /** 放进电话、等着一起寄去送评的卡（可以好几张） */
  const [slot, setSlot] = useState<CardAppraisalResponse[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = () => api<PhoneResponse>('/phone').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const onDrop = (e: Event) => {
      const card = (e as CustomEvent<CardView>).detail;
      setErr(''); setMsg('');
      api<CardAppraisalResponse>(`/cards/${card.id}/appraisal`)
        .then((r) => {
          if (!r.canGrade) { setErr(`「${r.card.name}」${r.card.slab ? '已经封壳了' : r.card.gradeRejected ? '被评级社拒评过' : '已经在评级社了'}`); return; }
          setSlot((xs) => (xs.some((x) => x.card.id === r.card.id) ? xs : xs.length >= PHONE.gradingBatch ? (setErr(`一次最多寄 ${PHONE.gradingBatch} 张`), xs) : [...xs, r]));
        })
        .catch((x: Error) => setErr(x.message));
    };
    window.addEventListener(PHONE_DROP, onDrop);
    window.addEventListener(WRITE_EVENT, load);
    return () => { window.removeEventListener(PHONE_DROP, onDrop); window.removeEventListener(WRITE_EVENT, load); };
  }, []);

  const buy = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<BuyPhoneResponse>('/phone/buy', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const send = async () => {
    if (!slot.length) return;
    setBusy(true); setErr('');
    try {
      const r = await api<GradeBatchResponse>('/phone/grade', { method: 'POST', body: { cardIds: slot.map((x) => x.card.id) }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setMsg(`${r.cards.length} 张卡寄去星港评级社了（${fmt(r.cost)} 信用点），下次打烊出结果`);
      setSlot([]);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const total = slot.reduce((s, x) => s + x.gradingFee, 0);

  /** 打给批发商订一盒：马上到货，去进货页拆 */
  const order = async (seriesId: string, name: string) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<WholesaleResponse>('/phone/wholesale', { method: 'POST', body: { seriesId }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setMsg(`「${name}」一盒 ${r.packIds.length} 包到货了（${fmt(r.cost)} 信用点），去进货页的"我的卡包"拆`);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <FloatWindow id="phone" className="float-phone" title="📞 电话" onClose={onClose}>
      {!data ? <p className="hint">接通中…</p> : !data.owned
        ? (
          <div className="phone-buy">
            <p>店里还没装电话。装了电话可以打给<b>星港评级社</b>送评（真卡封壳出分，按分数卖高价），还能打给批发商整盒订货（便宜，但不保证正品）。</p>
            <button className="primary" disabled={busy} onClick={buy}>买一部电话 · {fmt(PHONE.price)} 信用点</button>
          </div>
        )
        : (
          <>
            <div className="phone-contact" data-drop={PHONE_ZONE}>
              <div className="phone-contact-head"><b>星港评级社</b><span className="hint">送评</span></div>
              {slot.length > 0
                ? (
                  <>
                    <div className="phone-slot">
                      {slot.map((x) => (
                        <div key={x.card.id} className="phone-slot-card">
                          <Card card={x.card} small />
                          <span className="cell-price">{fmt(x.gradingFee)}</span>
                          <button className="link" onClick={() => setSlot((xs) => xs.filter((y) => y.card.id !== x.card.id))}>拿走</button>
                        </div>
                      ))}
                    </div>
                    <button className="primary" disabled={busy} onClick={send}>送评 {slot.length} 张 · 合计 {fmt(total)}</button>
                    <p className="hint">还可以接着往里拖（最多 {PHONE.gradingBatch} 张）</p>
                  </>
                )
                : <p className="station-empty">把卡拖到这里送评，可以放好几张</p>}
              <p className="hint station-hint">真卡封壳出分（1–10、四个分项、黑标），错版会公开认定、价格再 ×{ERRATA.mult}；送了假卡被拒评，信誉 −{APPRAISAL.gradeRejectRepLoss}。先用柜台上的放大镜看看再送。</p>
              {data.grading.length > 0 && (
                <div className="station-away">
                  <span className="hint">评级中：</span>
                  {data.grading.map((c) => <span key={c.id} className="badge">{c.name}（第 {c.readyDay} 天出结果）</span>)}
                </div>
              )}
            </div>
            <div className="phone-contact">
              <div className="phone-contact-head"><b>批发商</b><span className="hint">整盒订货 · 今天还能订 {data.wholesale.leftToday} 盒</span></div>
              <div className="wholesale-offers">
                {data.wholesale.offers.map((o) => (
                  <div key={o.seriesId} className={`wholesale-offer kind-${o.kind}`}>
                    <div className="pack-art" aria-hidden>{o.name.slice(0, 2)}</div>
                    <div className="wholesale-offer-body">
                      <b>{o.name}</b>
                      <span>一盒 {o.packs} 包 · <b>{fmt(o.boxPrice)}</b> <s>{fmt(o.normalPrice)}</s></span>
                    </div>
                    <button className="chip on" disabled={busy || data.wholesale.leftToday <= 0} onClick={() => order(o.seriesId, o.name)}>订一盒</button>
                  </div>
                ))}
              </div>
              <p className="hint station-hint">比电脑订货便宜，马上到货，但批发商不保证正品：每张卡约 {WHOLESALE.fakePpm / 10_000}% 是假卡。拆出来的卡带"批"字，用柜台上的放大镜看看再卖。每天只能订一盒。</p>
            </div>
          </>
        )}
      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </FloatWindow>
  );
}
