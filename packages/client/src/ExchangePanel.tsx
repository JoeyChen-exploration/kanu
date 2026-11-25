// 金币兑换（店铺页，FR-EXCH-1～4）：信用点单向换旺财金币。显示汇率、本周额度和重置时间、要扣的信用点，确认后才兑。
// 兑换单：到账 / 正在到账（旺财那边暂时没回话，会自动重试，不会丢）/ 没换成（信用点已退回）。
import { useEffect, useState } from 'react';
import type { ExchangeOrderResponse, ExchangeResponse, MeResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { fmt } from './Card.tsx';

const STATUS: Record<string, string> = { done: '已到账', pending: '正在到账', failed: '没换成，信用点已退回' };

export function ExchangePanel({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<ExchangeResponse | null>(null);
  const [coins, setCoins] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // 金币余额顺手同步到首页的统计卡
  const load = () => api<ExchangeResponse>('/exchange').then((d) => { setData(d); setCoins((c) => Math.min(c, d.maxCoins)); onChange({ wallet: d.wallet }); }).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);

  if (!data) return err ? <p className="error">{err}</p> : null;
  const cost = coins * data.rate;
  const set = (n: number) => { setConfirm(false); setCoins(Math.max(0, Math.min(data.maxCoins, Math.floor(n) || 0))); };

  const submit = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<ExchangeOrderResponse>('/exchange', { method: 'POST', body: { coins }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setMsg(r.order.status === 'done' ? `换到 ${fmt(r.order.coins)} 金币，已到账` : r.order.status === 'pending' ? `扣了 ${fmt(r.order.credits)} 信用点，金币正在到账（旺财那边暂时没回话，会自动重试，不会丢）` : `没换成：${r.order.error ?? ''}。信用点已退回`);
      setCoins(0);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setConfirm(false); }
  };

  return (
    <section className="exchange-panel">
      <div className="rent-head">
        <h2>换旺财金币</h2>
        <span><b>{data.rate}</b> 信用点 = 1 金币 · 只能单向换 · 金币余额 {data.wallet.coins === null ? '暂时查不到' : !data.wallet.opened ? '还没开户（进服满 3 天自动开户）' : fmt(data.wallet.coins)}</span>
      </div>
      <p className="hint">本周还能换 <b>{fmt(data.weekLeft)}</b> / {fmt(data.weeklyCap)} 金币，{data.resetDay} 00:00（悉尼时间）重置。{data.arrears ? '欠租中不能换。' : data.reserve > 0 ? `下次摊位费 ${fmt(data.reserve)} 信用点要留着，现在最多能换 ${fmt(data.maxCoins)} 金币。` : `现在最多能换 ${fmt(data.maxCoins)} 金币。`}</p>
      {data.maxCoins > 0 && (
        <div className="exchange-form">
          <div className="price-input">
            <button className="step-btn" disabled={busy || coins <= 0} onClick={() => set(coins - 10)} aria-label="少 10">−</button>
            <input inputMode="numeric" value={coins || ''} placeholder="0" onChange={(e) => set(Number(e.target.value.replace(/\D/g, '')))} aria-label="换多少金币" />
            <button className="step-btn" disabled={busy || coins >= data.maxCoins} onClick={() => set(coins + 10)} aria-label="多 10">+</button>
            <button className="chip" disabled={busy} onClick={() => set(data.maxCoins)}>最多</button>
          </div>
          {!confirm
            ? <button className="primary" disabled={busy || coins <= 0} onClick={() => setConfirm(true)}>换 {fmt(coins)} 金币（扣 {fmt(cost)} 信用点）</button>
            : (
              <div className="exchange-confirm">
                <span>扣 <b>{fmt(cost)}</b> 信用点，换 <b>{fmt(coins)}</b> 旺财金币。金币换不回信用点，确定？</span>
                <button className="primary" disabled={busy} onClick={submit}>确定换</button>
                <button className="link" disabled={busy} onClick={() => setConfirm(false)}>再想想</button>
              </div>
            )}
        </div>
      )}
      {data.orders.length > 0 && (
        <details className="exchange-orders">
          <summary>最近的兑换</summary>
          {data.orders.map((o) => (
            <div key={o.id} className={`exchange-order ${o.status}`}>
              <span>{new Date(o.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span>{fmt(o.credits)} 信用点 → {fmt(o.coins)} 金币</span>
              <span className="badge">{STATUS[o.status]}</span>
              {o.error && <span className="hint">{o.error}</span>}
            </div>
          ))}
        </details>
      )}
      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
