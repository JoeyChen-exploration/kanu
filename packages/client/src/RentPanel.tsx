// 房租面板（店铺页，FR-RENT-2～6）：下次摊位费、买下店铺、欠租时抵押 / 交租 / 从头开始、抵押中的卡和赎回。
import { useEffect, useState } from 'react';
import { PAWN, PLAYER } from '@kanu/shared/balance';
import type { MeResponse, RentActionResponse, RentResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { Card, fmt } from './Card.tsx';

export function RentPanel({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<RentResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [showPawn, setShowPawn] = useState(false);
  const [confirmBankrupt, setConfirmBankrupt] = useState(false);
  const [confirmShop, setConfirmShop] = useState(false);

  const load = () => api<RentResponse>('/rent').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);

  const act = async (url: string, body: object, done: (r: RentActionResponse) => string) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<RentActionResponse>(url, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits, rent: r.rent, ...(r.day ? { gameDay: r.day } : {}) });
      setMsg(done(r));
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setConfirmBankrupt(false); setConfirmShop(false); }
  };

  if (!data) return err ? <p className="error">{err}</p> : null;
  const { rent } = data;
  const short = rent.arrears ? Math.max(0, rent.arrears.amount - data.credits) : 0;
  const pawnableTotal = data.pawnable.reduce((s, p) => s + p.loan, 0);

  return (
    <section className={`rent-panel${rent.arrears ? ' arrears' : ''}`}>
      <div className="rent-head">
        <h2>摊位费</h2>
        {rent.owned
          ? <span className="rent-owner">🏪 店是你的了，不用再交摊位费</span>
          : rent.next && !rent.arrears && (
            <span>第 {rent.next.day} 天打烊时交第 {rent.next.week} 周 <b>{fmt(rent.next.amount)}</b> 信用点{rent.next.day === data.day ? '（就是今天）' : `（还有 ${rent.next.day - data.day} 天）`}</span>
          )}
      </div>

      {rent.arrears && (
        <div className="rent-arrears">
          <p><b>欠租中</b>：第 {rent.arrears.week} 周摊位费 {fmt(rent.arrears.amount)}，你有 {fmt(data.credits)}{short > 0 ? `，还差 ${fmt(short)}` : ''}。交上之前柜台关门、不能进入下一天。</p>
          <div className="rent-actions">
            {short > 0
              ? <button className="primary" disabled={busy || data.pawnable.length === 0} onClick={() => act('/rent/pawn-all', {}, (r) => (r.notEnough ? `全部抵押了 ${r.cards?.length ?? 0} 张，还是不够` : `抵押了 ${r.cards?.length ?? 0} 张（从最便宜的开始），够交租了`))}>一键抵押（最多能凑 {fmt(pawnableTotal)}）</button>
              : <button className="primary" disabled={busy} onClick={() => act('/rent/pay', {}, (r) => `交上了，进入第 ${r.day} 天`)}>交租 {fmt(rent.arrears.amount)}，进入下一天</button>}
            <button className="secondary" disabled={busy} onClick={() => setShowPawn(!showPawn)}>{showPawn ? '收起' : '自己挑卡抵押'}</button>
          </div>
        </div>
      )}

      {!rent.owned && !rent.arrears && (
        <div className="rent-shop">
          {!confirmShop
            ? <button className="secondary" disabled={busy || data.credits < rent.shopPrice} onClick={() => setConfirmShop(true)}>买下店铺 · {fmt(rent.shopPrice)}{data.credits < rent.shopPrice ? `（还差 ${fmt(rent.shopPrice - data.credits)}）` : ''}</button>
            : (
              <>
                <span className="hint">花 {fmt(rent.shopPrice)} 买下，以后不用交摊位费。确定？</span>
                <button className="primary" disabled={busy} onClick={() => act('/shop/buy', {}, () => '店是你的了！')}>确定买下</button>
                <button className="link" onClick={() => setConfirmShop(false)}>再想想</button>
              </>
            )}
        </div>
      )}

      {data.pawns.length > 0 && (
        <div className="rent-pawns">
          <h3>抵押在房东那里的卡 <small>第 {data.pawns[0]!.dueDay} 天打烊前不赎就归房东</small></h3>
          <div className="rent-grid">
            {data.pawns.map((p) => (
              <div key={p.id} className="rent-cell">
                <Card card={p.card} small />
                <button className="chip on" disabled={busy || data.credits < p.redeem} onClick={() => act(`/rent/redeem/${p.id}`, {}, () => `赎回了「${p.card.name}」`)}>赎回 {fmt(p.redeem)}</button>
                <span className="hint">到第 {p.dueDay} 天</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(showPawn || (!rent.arrears && data.pawnable.length > 0)) && (
        <details className="rent-pawnable" open={showPawn}>
          <summary>抵押卡牌换钱 <small>按市场价 {PAWN.loanPct * 100}% 给钱，{PAWN.days} 天内按 {PAWN.redeemPct * 100}% 赎回；珍藏柜的卡不收</small></summary>
          <div className="rent-grid">
            {data.pawnable.map((p) => (
              <div key={p.card.id} className="rent-cell">
                <Card card={p.card} small />
                <button className="chip" disabled={busy} onClick={() => act('/rent/pawn', { cardId: p.card.id }, () => `「${p.card.name}」抵押了 ${fmt(p.loan)}，${PAWN.days} 天内 ${fmt(p.redeem)} 赎回`)}>抵押 +{fmt(p.loan)}</button>
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="rent-bankrupt">
        <summary>从头开始</summary>
        <p className="hint">珍藏柜里的卡、图鉴、科技树都留着；信用点、珍藏柜以外的卡、没拆的卡包、店铺都清空，用 {fmt(PLAYER.restartCredits)} 信用点重开，摊位费从第 1 周算。</p>
        {!confirmBankrupt
          ? <button className="secondary danger" disabled={busy} onClick={() => setConfirmBankrupt(true)}>申请从头开始</button>
          : <button className="primary danger" disabled={busy} onClick={() => act('/rent/bankrupt', { confirm: true }, (r) => `从头开始了：第 ${r.day} 天，${fmt(r.credits)} 信用点`)}>确定，清空重来</button>}
      </details>

      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
