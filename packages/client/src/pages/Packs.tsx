// 进货页（DESIGN 4）：上面是库存里没拆的卡包，点了拆开、逐张翻牌；下面是电脑订货（5 种卡包，按包买，正常价、保证正品）。
import { useEffect, useState } from 'react';
import { PITY } from '@kanu/shared/balance';
import type { BindersResponse, BuyBinderResponse, BuyPacksResponse, MeResponse, OpenPackResponse, SealedPacksResponse, StoreResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, CardBack, fmt } from '../Card.tsx';
import { PackArt } from '../art.tsx';

export function Packs({ me, onChange }: { me: MeResponse; onChange: (patch: Partial<MeResponse>) => void }) {
  const [store, setStore] = useState<StoreResponse | null>(null);
  const [sealed, setSealed] = useState<SealedPacksResponse | null>(null);
  const [binders, setBinders] = useState<BindersResponse | null>(null);
  const [opened, setOpened] = useState<OpenPackResponse | null>(null);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [showOdds, setShowOdds] = useState<string | null>(null);
  /** 购物车：卡包种类 → 几包 */
  const [cart, setCart] = useState<Record<string, number>>({});
  const [err, setErr] = useState('');

  const load = async () => {
    const [s, p, b] = await Promise.all([api<StoreResponse>('/store'), api<SealedPacksResponse>('/packs'), api<BindersResponse>('/binders')]);
    setStore(s);
    setSealed(p);
    setBinders(b);
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const checkout = () => run(async () => {
    const items = Object.entries(cart).filter(([, n]) => n > 0).map(([seriesId, count]) => ({ seriesId, count }));
    const r = await api<BuyPacksResponse>('/store/buy', { method: 'POST', body: { items }, idempotencyKey: newIdempotencyKey() });
    onChange({ credits: r.credits, ...(r.packsLeftToday !== null ? { packsLeftToday: r.packsLeftToday } : {}) });
    setCart({});
    await load();
  });

  const buyBinder = (kind: string) => run(async () => {
    const r = await api<BuyBinderResponse>('/binders/buy', { method: 'POST', body: { kind }, idempotencyKey: newIdempotencyKey() });
    onChange({ credits: r.credits });
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
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const cartCost = store ? store.packs.reduce((sum, p) => sum + (cart[p.seriesId] ?? 0) * p.price, 0) : 0;
  const free = left === null;
  const canAdd = free || (left !== undefined && cartCount < left);
  const setQty = (id: string, n: number) => setCart((c) => ({ ...c, [id]: Math.max(0, n) }));

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
          <div key={`${g.seriesId}-${g.wholesale ? 'w' : 's'}`} className={`sealed kind-${g.kind}${g.wholesale ? ' wholesale' : ''}`}>
            <PackArt seriesId={g.seriesId} name={g.name} kind={g.kind} small box={g.wholesale} />
            <div className="sealed-body">
              <b>{g.name}{g.wholesale && <span className="wholesale-tag">批发</span>}</b>
              <span className="hint">{g.ids.length} 包{g.wholesale ? ' · 批发商不保证正品，拆出来拿放大镜看看' : ''}</span>
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
            <PackArt seriesId={p.seriesId} name={p.name} kind={p.kind} />
            <div className="store-body">
              <b>{p.name}</b>
              <span className="badge">{p.kindName} · {p.cardCount} 张</span>
              <button className="link" onClick={() => setShowOdds(showOdds === p.seriesId ? null : p.seriesId)}>{showOdds === p.seriesId ? '收起爆率' : '看爆率'}</button>
              {showOdds === p.seriesId && (
                <span className="odds">{p.odds.map((o) => `${o.rarity} ${o.percent}%`).join(' · ')}</span>
              )}
            </div>
            <div className="qty">
              <span className="qty-price">{free ? '免费' : fmt(p.price)}</span>
              <div className="stepper">
                <button aria-label="少一包" disabled={!cart[p.seriesId]} onClick={() => setQty(p.seriesId, (cart[p.seriesId] ?? 0) - 1)}>−</button>
                <span>{cart[p.seriesId] ?? 0}</span>
                <button aria-label="多一包" disabled={!canAdd} onClick={() => setQty(p.seriesId, (cart[p.seriesId] ?? 0) + 1)}>+</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <h2>用品 <small>卡册</small></h2>
      <p className="hint">卡要放进卡册才不会磨损；所有卡册的格数加起来就是你的库存上限。买了新卡册，桌面上的散卡会自动收进去。</p>
      <div className="store-list">
        {binders?.catalog.map((b) => (
          <div key={b.kind} className="store-pack">
            <div className={`binder-cover binder-${b.kind}`} aria-hidden>{b.name.slice(0, 2)}</div>
            <div className="store-body">
              <b>{b.name}</b>
              <span className="badge">{b.slots} 张</span>
              <span className="odds">{b.effect}</span>
            </div>
            <button className="buy" disabled={busy || (!free && me.credits < b.price)} onClick={() => buyBinder(b.kind)}>{free ? '免费' : fmt(b.price)}</button>
          </div>
        ))}
      </div>

      {cartCount > 0 && (
        <div className="cart-bar">
          <span>购物车 {cartCount} 包 · {free ? '免费' : `${fmt(cartCost)} 信用点`}</span>
          <button className="buy" disabled={busy || (!free && me.credits < cartCost)} onClick={checkout}>下单</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
