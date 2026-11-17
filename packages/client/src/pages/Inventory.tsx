// 库存页（FR-INV-1、FR-INV-6）：按稀有度筛选、分页，点卡片放进 / 取出珍藏柜。
import { useEffect, useState } from 'react';
import { RARITIES, SHOWCASE } from '@kanu/shared/balance';
import type { CardView, InventoryResponse } from '@kanu/shared/types';
import { api } from '../api.ts';
import { Card, fmt } from '../Card.tsx';

export function Inventory() {
  const [rarity, setRarity] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [showcase, setShowcase] = useState<CardView[]>([]);
  const [selected, setSelected] = useState<CardView | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), ...(rarity ? { rarity } : {}) });
    const [inv, sc] = await Promise.all([
      api<InventoryResponse>(`/inventory?${qs}`),
      api<InventoryResponse>('/inventory?location=showcase'),
    ]);
    setData(inv);
    setShowcase(sc.cards);
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, [rarity, page]);

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

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="page">
      <h2>珍藏柜 <small>{showcase.length} / {SHOWCASE.slots}</small></h2>
      <div className="grid showcase">
        {showcase.map((c) => <button key={c.id} className="cell" onClick={() => setSelected(c)}><Card card={c} small /></button>)}
        {Array.from({ length: SHOWCASE.slots - showcase.length }, (_, i) => <div key={i} className="cell empty-slot">空</div>)}
      </div>

      <h2>库存 <small>{data?.total ?? 0} 张</small></h2>
      <div className="filters">
        {['', ...RARITIES].map((r) => (
          <button key={r || 'all'} className={rarity === r ? 'chip on' : 'chip'} onClick={() => { setRarity(r); setPage(1); }}>{r || '全部'}</button>
        ))}
      </div>
      <div className="grid">
        {data?.cards.map((c) => <button key={c.id} className="cell" onClick={() => setSelected(c)}><Card card={c} small /></button>)}
      </div>
      {data && data.total === 0 && <p className="hint">还没有卡，去开包吧。</p>}
      {pages > 1 && (
        <div className="pager">
          <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page} / {pages}</span>
          <button className="chip" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}

      {selected && (
        <div className="sheet" onClick={() => setSelected(null)}>
          <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
            <Card card={selected} />
            {selected.flavor && <p className="flavor">"{selected.flavor}"</p>}
            <p>{selected.seriesName} · 市场价约 {fmt(selected.price)} 信用点（未评级）</p>
            <p className="hint">真伪、品相、来源都还是"?"，鉴定下一步就来。</p>
            <button className="primary" onClick={() => toggleShowcase(selected)}>
              {selected.location === 'showcase' ? '取出珍藏柜' : '放进珍藏柜'}
            </button>
            <button className="secondary" onClick={() => setSelected(null)}>关闭</button>
          </div>
        </div>
      )}
    </section>
  );
}
