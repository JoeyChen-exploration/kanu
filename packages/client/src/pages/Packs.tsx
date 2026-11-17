// 进货页（DESIGN 4）：上面是库存里没拆的卡包，点了拆开、逐张翻牌；下面是电脑订货（5 种卡包，按包买，正常价、保证正品）。
import { useEffect, useState } from 'react';
import { PITY } from '@kanu/shared/balance';
import type { BuyPacksResponse, MeResponse, OpenPackResponse, SealedPacksResponse, StorePack, StoreResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, CardBack, fmt } from '../Card.tsx';

export function Packs({ me, onChange }: { me: MeResponse; onChange: (patch: Partial<MeResponse>) => void }) {
  const [store, setStore] = useState<StoreResponse | null>(null);
  const [sealed, setSealed] = useState<SealedPacksResponse | null>(null);
  const [opened, setOpened] = useState<OpenPackResponse | null>(null);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [showOdds, setShowOdds] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    const [s, p] = await Promise.all([api<StoreResponse>('/store'), api<SealedPacksResponse>('/packs')]);
    setStore(s);
    setSealed(p);
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const buy = (pack: StorePack) => run(async () => {
    const r = await api<BuyPacksResponse>('/store/buy', { method: 'POST', body: { seriesId: pack.seriesId, count: 1 }, idempotencyKey: newIdempotencyKey() });
    onChange({ credits: r.credits, ...(r.packsLeftToday !== null ? { packsLeftToday: r.packsLeftToday } : {}) });
    await load();
  });

  const open = (packId: number) => run(async () => {
    const r = await api<OpenPackResponse>(`/packs/${packId}/open`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
    setOpened(r);
    setFlipped(r.cards.map(() => false));
    onChange({ pityCount: r.pityCount });
    await load();
  });

  const flip = (i: number) => setFlipped((f) => f.map((v, j) => (j === i ? true : v)));
  const allFlipped = flipped.length > 0 && flipped.every(Boolean);
  const left = store?.packsLeftToday;

  // 正在翻牌时只显示这一包
  if (opened) {
    return (
      <section className="page">
        <h2>{opened.cards[0]?.seriesName}</h2>
        {opened.pityTriggered && <p className="pity-hit">保底触发！</p>}
        <div className="pack-cards">
          {opened.cards.map((c, i) => (
            <button key={c.id} className={`flip${flipped[i] ? ' flipped' : ''}`} onClick={() => flip(i)} aria-label={flipped[i] ? c.name : '翻开这张'}>
              <div className="flip-inner">
                <div className="flip-back"><CardBack /></div>
                <div className="flip-front"><Card card={c} /></div>
              </div>
            </button>
          ))}
        </div>
        {!allFlipped
          ? <button className="secondary" onClick={() => setFlipped((f) => f.map(() => true))}>全部翻开</button>
          : <button className="primary" onClick={() => setOpened(null)}>收进库存</button>}
      </section>
    );
  }

  return (
    <section className="page">
      <h2>我的卡包 <small>没拆的</small></h2>
      {sealed && sealed.groups.length === 0 && <p className="hint">还没有卡包，在下面电脑订货。</p>}
      <div className="sealed-list">
        {sealed?.groups.map((g) => (
          <div key={g.seriesId} className={`sealed kind-${g.kind}`}>
            <div className="pack-art small" aria-hidden>{g.name.slice(0, 2)}</div>
            <div className="sealed-body">
              <b>{g.name}</b>
              <span className="hint">{g.ids.length} 包</span>
            </div>
            <button className="chip on" disabled={busy} onClick={() => open(g.ids[0]!)}>拆一包</button>
          </div>
        ))}
      </div>

      <h2>电脑订货 <small>{left === null || left === undefined ? '测试账号不限购' : `今天还能买 ${left} 包`}</small></h2>
      <p className="hint">正常价，保证全是正品。第 {me.gameDay} 天 · 保底进度 {me.pityCount} / {PITY.packs}</p>
      <div className="store-list">
        {store?.packs.map((p) => (
          <div key={p.seriesId} className={`store-pack kind-${p.kind}`}>
            <div className="pack-art" aria-hidden>{p.name.slice(0, 2)}</div>
            <div className="store-body">
              <b>{p.name}</b>
              <span className="badge">{p.kindName} · {p.cardCount} 张</span>
              <button className="link" onClick={() => setShowOdds(showOdds === p.seriesId ? null : p.seriesId)}>{showOdds === p.seriesId ? '收起爆率' : '看爆率'}</button>
              {showOdds === p.seriesId && (
                <span className="odds">{p.odds.map((o) => `${o.rarity} ${o.percent}%`).join(' · ')}</span>
              )}
            </div>
            <button className="buy" disabled={busy || left === 0 || (left !== null && me.credits < p.price)} onClick={() => buy(p)}>
              {left === null ? '免费' : fmt(p.price)}
            </button>
          </div>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
    </section>
  );
}
