// 库存页（FR-INV-1、FR-INV-6，DESIGN 4.5）：珍藏柜 → 我的卡册（点开一页一页翻）→ 桌面散放的卡（会磨损）。
// 最下面保留按稀有度筛选的"全部卡"列表。点任何一张卡看详情、放进 / 取出珍藏柜。
import { useContext, useEffect, useState } from 'react';
import { LOOSE, RARITIES, SHOWCASE } from '@kanu/shared/balance';
import type { BinderPageResponse, BinderView, BindersResponse, CardView, InventoryResponse } from '@kanu/shared/types';
import { api } from '../api.ts';
import { Card, GameDayContext, fmt } from '../Card.tsx';

export function Inventory() {
  const [data, setData] = useState<BindersResponse | null>(null);
  const [showcase, setShowcase] = useState<CardView[]>([]);
  const [openBinder, setOpenBinder] = useState<BinderView | null>(null);
  const [selected, setSelected] = useState<CardView | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const day = useContext(GameDayContext);

  const load = async () => {
    const [b, sc] = await Promise.all([api<BindersResponse>('/binders'), api<InventoryResponse>('/inventory?location=showcase')]);
    setData(b);
    setShowcase(sc.cards);
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, []);

  const organize = async () => {
    const r = await api<{ placed: number }>('/binders/organize', { method: 'POST', body: {} });
    setMsg(r.placed ? `收进卡册 ${r.placed} 张` : '卡册没有空位了，去进货页的"用品"买本新卡册');
    await load();
  };

  const toggleShowcase = async (card: CardView) => {
    setErr('');
    try {
      await api(`/inventory/${card.id}/showcase`, { method: 'POST', body: { on: card.location !== 'showcase' } });
      setSelected(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (openBinder) return <BinderViewer binder={openBinder} onBack={() => { setOpenBinder(null); void load(); }} onPick={setSelected} selected={selected} onToggle={toggleShowcase} />;

  const loose = data?.loose.cards ?? [];
  return (
    <section className="page">
      <h2>珍藏柜 <small>{showcase.length} / {SHOWCASE.slots}</small></h2>
      <div className="grid showcase">
        {showcase.map((c) => <button key={c.id} className="cell" onClick={() => setSelected(c)}><Card card={c} small /></button>)}
        {Array.from({ length: Math.max(0, SHOWCASE.slots - showcase.length) }, (_, i) => <div key={i} className="cell empty-slot">空</div>)}
      </div>

      <h2>我的卡册</h2>
      <div className="binder-list">
        {data?.binders.map((b) => (
          <button key={b.id} className="binder-item" onClick={() => setOpenBinder(b)}>
            <div className={`binder-cover binder-${b.kind}`} aria-hidden>{b.name.slice(0, 2)}</div>
            <div className="binder-body">
              <b>{b.name}</b>
              <span className="hint">{b.used} / {b.slots} 张 · {b.effect}</span>
              <div className="fill"><div style={{ width: `${(b.used / b.slots) * 100}%` }} /></div>
            </div>
          </button>
        ))}
      </div>

      <h2>桌面散放 <small>{loose.length} / {LOOSE.slots}</small></h2>
      {loose.length === 0
        ? <p className="hint">桌面上没有散卡。卡册满了的时候，新开的卡会先放在这里。</p>
        : (
          <>
            <p className="loose-note">散放的卡每过一天都可能磨损，品相会变差。买新卡册或者卖掉一些，把它们收起来。</p>
            <div className="grid">
              {loose.map((c) => (
                <button key={c.id} className="cell" onClick={() => setSelected(c)}>
                  <Card card={c} small />
                  <span className="cell-price">散放 {day - (c.looseSinceDay ?? day)} 天</span>
                </button>
              ))}
            </div>
            <button className="secondary" onClick={organize}>收进卡册</button>
          </>
        )}
      {msg && <p className="hint">{msg}</p>}

      <AllCards onPick={setSelected} />
      {err && <p className="error">{err}</p>}
      {selected && <CardSheet card={selected} onClose={() => setSelected(null)} onToggle={toggleShowcase} />}
    </section>
  );
}

/** 一本卡册：3 × 3 一页，左右翻 */
function BinderViewer({ binder, onBack, onPick, selected, onToggle }: {
  binder: BinderView;
  onBack: () => void;
  onPick: (c: CardView | null) => void;
  selected: CardView | null;
  onToggle: (c: CardView) => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BinderPageResponse | null>(null);
  useEffect(() => { api<BinderPageResponse>(`/binders/${binder.id}?page=${page}`).then(setData).catch(() => {}); }, [binder.id, page]);
  const cards = data?.cards ?? [];
  return (
    <section className="page">
      <button className="chip" onClick={onBack}>← 返回库存</button>
      <h2>{binder.name} <small>{binder.used} / {binder.slots} 张</small></h2>
      <div className="binder-page">
        {cards.map((c) => <button key={c.id} className="cell" onClick={() => onPick(c)}><Card card={c} small /></button>)}
        {Array.from({ length: Math.max(0, 9 - cards.length) }, (_, i) => <div key={`e${i}`} className="binder-slot" />)}
      </div>
      <div className="pager">
        <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {data?.pages ?? 1} 页</span>
        <button className="chip" disabled={!data || page >= data.pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
      {selected && <CardSheet card={selected} onClose={() => onPick(null)} onToggle={onToggle} />}
    </section>
  );
}

/** 全部卡：按稀有度筛选、分页（折叠起来） */
function AllCards({ onPick }: { onPick: (c: CardView) => void }) {
  const [rarity, setRarity] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const qs = new URLSearchParams({ page: String(page), location: 'inventory', ...(rarity ? { rarity } : {}) });
    api<InventoryResponse>(`/inventory?${qs}`).then(setData).catch(() => {});
  }, [open, rarity, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <details className="served" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>全部卡（按稀有度找）</summary>
      <div className="filters">
        {['', ...RARITIES].map((r) => (
          <button key={r || 'all'} className={rarity === r ? 'chip on' : 'chip'} onClick={() => { setRarity(r); setPage(1); }}>{r || '全部'}</button>
        ))}
      </div>
      <div className="grid">
        {data?.cards.map((c) => <button key={c.id} className="cell" onClick={() => onPick(c)}><Card card={c} small /></button>)}
      </div>
      {pages > 1 && (
        <div className="pager">
          <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page} / {pages}</span>
          <button className="chip" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
    </details>
  );
}

function CardSheet({ card, onClose, onToggle }: { card: CardView; onClose: () => void; onToggle: (c: CardView) => Promise<void> }) {
  const day = useContext(GameDayContext);
  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <Card card={card} />
        {card.flavor && <p className="flavor">"{card.flavor}"</p>}
        <p>{card.seriesName} · 市场价约 {fmt(card.price)} 信用点（未评级）</p>
        {card.looseSinceDay !== null && <p className="loose-note">散放在桌面上 {day - card.looseSinceDay} 天，可能已经磨损</p>}
        <p className="hint">真伪、品相、来源都还是"?"，鉴定下一步就来。</p>
        <button className="primary" onClick={() => onToggle(card)}>{card.location === 'showcase' ? '取出珍藏柜' : '放进珍藏柜'}</button>
        <button className="secondary" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
