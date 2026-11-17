// 开包页（FR-PACK-1、FR-PACK-6）：按钮上直接写价格（NFR-UX-3 开包不另外确认），开完逐张翻牌。
import { useState } from 'react';
import { PACKS, PITY } from '@kanu/shared/balance';
import type { MeResponse, OpenPackResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, CardBack, fmt } from '../Card.tsx';

export function Packs({ me, onChange }: { me: MeResponse; onChange: (patch: Partial<MeResponse>) => void }) {
  const [result, setResult] = useState<OpenPackResponse | null>(null);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pack = PACKS.normal;
  const allFlipped = flipped.length > 0 && flipped.every(Boolean);

  const openPack = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api<OpenPackResponse>('/packs/open', { method: 'POST', body: { packType: 'normal' }, idempotencyKey: newIdempotencyKey() });
      setResult(r);
      setFlipped(r.cards.map(() => false));
      onChange({ credits: r.credits, pityCount: r.pityCount, packsLeftToday: r.packsLeftToday });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const flip = (i: number) => setFlipped((f) => f.map((v, j) => (j === i ? true : v)));
  const flipAll = () => setFlipped((f) => f.map(() => true));
  const disabled = busy || (!me.devTools && (me.packsLeftToday <= 0 || me.credits < pack.price));

  return (
    <section className="page">
      <h2>进货</h2>
      <div className="pack-info">
        <div>第 {me.gameDay} 天，还能开 <b>{me.devTools ? '不限' : me.packsLeftToday}</b>{me.devTools ? '' : ` / ${pack.dailyLimit} 包`}</div>
        <div>保底进度 <b>{me.pityCount}</b> / {PITY.packs}（{PITY.packs} 包内必出 SSR 以上）</div>
      </div>

      {result && (
        <>
          {result.pityTriggered && <p className="pity-hit">保底触发！</p>}
          <div className="pack-cards">
            {result.cards.map((c, i) => (
              <button key={c.id} className={`flip${flipped[i] ? ' flipped' : ''}`} onClick={() => flip(i)} aria-label={flipped[i] ? c.name : '翻开这张'}>
                <div className="flip-inner">
                  <div className="flip-back"><CardBack /></div>
                  <div className="flip-front"><Card card={c} /></div>
                </div>
              </button>
            ))}
          </div>
          {!allFlipped && <button className="secondary" onClick={flipAll}>全部翻开</button>}
        </>
      )}

      <button className="primary" disabled={disabled} onClick={openPack}>
        {busy ? '开包中…' : `开正规卡包 · ${fmt(pack.price)} 信用点`}
      </button>
      {me.credits < pack.price && <p className="hint">信用点不够了，去柜台把卡卖给顾客吧。</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
