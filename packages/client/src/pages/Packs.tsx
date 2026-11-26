// 进货页（DESIGN 4）：上面是库存里没拆的卡包，点了拆开、逐张翻牌；下面是电脑订货（5 种卡包，按包买，正常价、保证正品）。
import { useEffect, useRef, useState } from 'react';
import { PITY } from '@kanu/shared/balance';
import type { BlackBuyResponse, BlackMarketResponse, BindersResponse, BuyBinderResponse, BuyPacksResponse, MeResponse, OpenPackResponse, SealedPacksResponse, StoreResponse } from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, CardBack, fmt } from '../Card.tsx';
import { PackArt } from '../art.tsx';
import { PackTear, type TearPack } from '../PackTear.tsx';

export function Packs({ me, onChange }: { me: MeResponse; onChange: (patch: Partial<MeResponse>) => void }) {
  const [store, setStore] = useState<StoreResponse | null>(null);
  const [sealed, setSealed] = useState<SealedPacksResponse | null>(null);
  const [binders, setBinders] = useState<BindersResponse | null>(null);
  const [opened, setOpened] = useState<OpenPackResponse | null>(null);
  /** 正在撕的那一包（撕开动画放完才显示拆包结果） */
  const [tearing, setTearing] = useState<TearPack | null>(null);
  const torn = useRef<OpenPackResponse | null>(null);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [showOdds, setShowOdds] = useState<string | null>(null);
  /** 黑市（DESIGN 4）：解锁进度、今天还能买几包 */
  const [black, setBlack] = useState<BlackMarketResponse | null>(null);
  const [blackCount, setBlackCount] = useState(1);
  /** 购物车：卡包种类 → 几包 */
  const [cart, setCart] = useState<Record<string, number>>({});
  const [err, setErr] = useState('');

  const load = async () => {
    const [s, p, b, bm] = await Promise.all([api<StoreResponse>('/store'), api<SealedPacksResponse>('/packs'), api<BindersResponse>('/binders'), api<BlackMarketResponse>('/black')]);
    setBlack(bm);
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

  const buyBlack = () => run(async () => {
    const r = await api<BlackBuyResponse>('/black/buy', { method: 'POST', body: { count: blackCount }, idempotencyKey: newIdempotencyKey() });
    onChange({ credits: r.credits });
    setBlackCount(1);
    await load();
  });

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

  /** 撕开那一刻：请求服务器拆包（同一包只发一次，幂等 key 跟着这次撕） */
  const tearOpen = async () => {
    if (!tearing) return;
    torn.current = await api<OpenPackResponse>(`/packs/${tearing.id}/open`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
  };
  /** 撕开动画放完：换成翻牌 */
  const showTorn = () => {
    const r = torn.current;
    if (!r) return;
    torn.current = null;
    setTearing(null);
    setOpened(r);
    setFlipped(r.cards.map(() => false));
    onChange({ pityCount: r.pityCount });
    void load().catch(() => {});
  };

  const flip = (i: number) => setFlipped((f) => f.map((v, j) => (j === i ? true : v)));
  const allFlipped = flipped.length > 0 && flipped.every(Boolean);
  const left = store?.packsLeftToday;
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const cartCost = store ? store.packs.reduce((sum, p) => sum + (cart[p.seriesId] ?? 0) * p.price, 0) : 0;
  const free = left === null;
  const canAdd = free || (left !== undefined && cartCount < left);
  const setQty = (id: string, n: number) => setCart((c) => ({ ...c, [id]: Math.max(0, n) }));

  // 正在撕包时只显示这一包
  if (tearing) {
    return (
      <section className="page">
        <h2>{tearing.name}{tearing.wholesale && <span className="wholesale-tag">批发</span>}{tearing.black && <span className="wholesale-tag black-tag">黑市</span>}</h2>
        <PackTear pack={tearing} onTear={tearOpen} onDone={showTorn} onCancel={() => setTearing(null)} />
      </section>
    );
  }

  // 正在翻牌时只显示这一包
  if (opened) {
    return (
      <section className="page">
        <h2>{opened.cards[0]?.acquired === 'black' ? '黑市货' : opened.cards[0]?.seriesName}</h2>
        {opened.pityTriggered && <p className="pity-hit">保底触发！</p>}
        <div className="pack-cards">
          {opened.cards.map((c, i) => (
            <button key={c.id} className={`flip deal-in${flipped[i] ? ' flipped' : ''}`} style={{ animationDelay: `${i * 90}ms` }} onClick={() => flip(i)} aria-label={flipped[i] ? c.name : '翻开这张'}>
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
              <b>{g.name}{g.wholesale && <span className="wholesale-tag">批发</span>}{g.black && <span className="wholesale-tag black-tag">黑市</span>}</b>
              <span className="hint">{g.ids.length} 包{g.wholesale ? ' · 批发商不保证正品，拆出来拿放大镜看看' : ''}</span>
            </div>
            <button className="chip on" disabled={busy} onClick={() => setTearing({ id: g.ids[0]!, seriesId: g.seriesId, name: g.name, kind: g.kind, wholesale: g.wholesale, black: g.black })}>拆一包</button>
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
      {black && (
        <section className={`black-market${black.unlocked ? '' : ' locked'}`}>
          <h2>🕶️ 黑市 <small>{black.unlocked ? (black.leftToday === null ? '测试账号不限购' : `今天还能买 ${black.leftToday} / ${black.perDay} 包`) : '还没门路'}</small></h2>
          {!black.unlocked
            ? <p className="hint">黑市不跟生人做买卖。黑市关系到熟脸（{black.progress.target}）才给你门路，现在 {black.progress.current} / {black.progress.target}。在柜台把卡卖给黑市中间人最涨关系（店铺页看派系）。</p>
            : (
              <>
                <p className="hint">一包 {black.price} 信用点、5 张，稀有卡更多（{black.odds.filter((o) => ['SSR', 'UR', 'LR', 'MR'].includes(o.rarity)).map((o) => `${o.rarity} ${o.percent}%`).join(' · ')}），所有系列的卡都可能出。<b>不保证正品：每张约 {black.fakePct}% 是假卡、{black.stolenPct}% 是赃物</b>，没有保底。拆出来的卡带"黑"字，用放大镜看过再卖；赃物小心便衣和巡查。</p>
                <div className="black-buy">
                  <div className="stepper">
                    <button aria-label="少一包" disabled={blackCount <= 1} onClick={() => setBlackCount(blackCount - 1)}>−</button>
                    <span>{blackCount}</span>
                    <button aria-label="多一包" disabled={black.leftToday !== null && blackCount >= black.leftToday} onClick={() => setBlackCount(blackCount + 1)}>+</button>
                  </div>
                  <button className="buy" disabled={busy || black.leftToday === 0 || me.credits < black.price * blackCount} onClick={buyBlack}>买 {blackCount} 包 · {fmt(black.price * blackCount)}</button>
                </div>
              </>
            )}
        </section>
      )}

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
