// 库存页（FR-INV-1、FR-INV-6，DESIGN 4.5）：珍藏柜 → 我的卡册（点开一页一页翻）→ 桌面散放的卡（会磨损）。
// 最下面保留按稀有度筛选的"全部卡"列表。点任何一张卡看详情、放进 / 取出珍藏柜。
import { useContext, useEffect, useState } from 'react';
import { LOOSE, RARITIES, SHOWCASE } from '@kanu/shared/balance';
import type {
  BinderPageResponse, BinderView, BindersResponse, CardView, InventoryResponse, MeResponse, ShowcaseResponse, ShowcaseStatus, ShowcaseUpgradeResponse,
} from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, GameDayContext, fmt } from '../Card.tsx';
import { DragGhost, FloatWindow, useDrag } from '../drag.tsx';

type Bind = ReturnType<typeof useDrag<CardView>>['bind'];

export function Inventory({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<BindersResponse | null>(null);
  const [showcase, setShowcase] = useState<CardView[]>([]);
  const [sc, setSc] = useState<ShowcaseStatus | null>(null);
  /** 同时打开的卡册浮窗（可以好几本） */
  const [openBinders, setOpenBinders] = useState<BinderView[]>([]);
  const isOpen = (id: number) => openBinders.some((b) => b.id === id);
  /** 列表里点一本：没开就打开，开着就关掉 */
  const toggleBinder = (b: BinderView) => setOpenBinders((xs) => (xs.some((x) => x.id === b.id) ? xs.filter((x) => x.id !== b.id) : [...xs, b]));
  const [selected, setSelected] = useState<CardView | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  /** 拖卡改了位置后让浮窗里的卡册页重新拉一遍 */
  const [version, setVersion] = useState(0);
  const day = useContext(GameDayContext);

  const load = async () => {
    const [b, s] = await Promise.all([api<BindersResponse>('/binders'), api<ShowcaseResponse>('/showcase')]);
    setData(b);
    setShowcase(s.cards);
    setSc(s.status);
  };

  const upgradeShowcase = async () => {
    setErr('');
    try {
      const r = await api<ShowcaseUpgradeResponse>('/showcase/upgrade', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setSc(r.status);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, []);

  const organize = async () => {
    const r = await api<{ placed: number }>('/binders/organize', { method: 'POST', body: {} });
    setMsg(r.placed ? `收进卡册 ${r.placed} 张` : '卡册没有空位了，去进货页的"用品"买本新卡册');
    await load();
  };

  const setShowcaseOn = async (card: CardView, on: boolean) => {
    setErr('');
    setMsg('');
    try {
      await api(`/inventory/${card.id}/showcase`, { method: 'POST', body: { on } });
      setSelected(null);
      setMsg(on ? `「${card.name}」放进了珍藏柜` : `「${card.name}」从珍藏柜取出来了`);
      await load();
      setVersion((v) => v + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const toggleShowcase = (card: CardView) => setShowcaseOn(card, card.location !== 'showcase');

  // 拖卡：卡册 / 桌面 → 珍藏柜 = 放进去；珍藏柜 → 卡册浮窗 / 桌面 = 取出来
  const { drag, bind } = useDrag<CardView>((card, zone) => {
    if (zone === 'showcase' && card.location !== 'showcase') void setShowcaseOn(card, true);
    else if (zone === 'stash' && card.location === 'showcase') void setShowcaseOn(card, false);
  });
  const dropping = (zone: string) => (drag ? (drag.zone === zone ? ' drop-target drop-over' : ' drop-target') : '');

  const loose = data?.loose.cards ?? [];
  return (
    <section className="page inv-layout">
      <div className="inv-col">
      <ShowcasePanel status={sc} cards={showcase} onPick={setSelected} onUpgrade={upgradeShowcase} bind={bind} dropClass={drag && drag.item.location !== 'showcase' ? dropping('showcase') : ''} />
      {!drag && <p className="hint drag-tip">按住卡牌（手机上长按）拖到珍藏柜就能放进去，拖回卡册或桌面就是取出来。</p>}

      <h2>我的卡册</h2>
      <div className="binder-list">
        {data?.binders.map((b) => (
          <button key={b.id} className={isOpen(b.id) ? 'binder-item on' : 'binder-item'} onClick={() => toggleBinder(b)}>
            <div className={`binder-cover binder-${b.kind}`} aria-hidden>{b.name.slice(0, 2)}</div>
            <div className="binder-body">
              <b>{b.name}</b>
              <span className="hint">{b.used} / {b.slots} 张 · {b.effect}</span>
              <div className="fill"><div style={{ width: `${(b.used / b.slots) * 100}%` }} /></div>
            </div>
          </button>
        ))}
      </div>
      </div>

      <div className="inv-col">
      <div className={`stash-zone${drag && drag.item.location === 'showcase' ? dropping('stash') : ''}`} data-drop="stash">
        <h2>桌面散放 <small>{loose.length} / {LOOSE.slots}</small></h2>
        {loose.length === 0
          ? <p className="hint">桌面上没有散卡。卡册满了的时候，新开的卡会先放在这里。</p>
          : (
            <>
              <p className="loose-note">散放的卡每过一天都可能磨损，品相会变差。买新卡册或者卖掉一些，把它们收起来。</p>
              <div className="grid">
                {loose.map((c) => (
                  <button key={c.id} className={drag?.item.id === c.id ? 'cell draggable dragging' : 'cell draggable'} onClick={() => setSelected(c)} {...bind(c)}>
                    <Card card={c} small />
                    <span className="cell-price">散放 {day - (c.looseSinceDay ?? day)} 天</span>
                  </button>
                ))}
              </div>
              <button className="secondary" onClick={organize}>收进卡册</button>
            </>
          )}
      </div>
      {msg && <p className="hint">{msg}</p>}

      <AllCards onPick={setSelected} />
      {err && <p className="error">{err}</p>}
      </div>

      {openBinders.map((b, i) => (
        <FloatWindow key={b.id} id={`binder-${b.id}`} cascade={i} className="float-binder" title={b.name}
          onClose={() => { setOpenBinders((xs) => xs.filter((x) => x.id !== b.id)); void load(); }} dropZone="stash">
          <div className={drag && drag.item.location === 'showcase' ? `float-drop${dropping('stash')}` : 'float-drop'}>
            <BinderPages binder={b} version={version} onPick={setSelected} bind={bind} draggingId={drag?.item.id ?? null} />
          </div>
        </FloatWindow>
      ))}
      {drag && (
        <DragGhost x={drag.x} y={drag.y}>
          <Card card={drag.item} small />
          <span className="ghost-hint">
            {drag.item.location === 'showcase'
              ? (drag.zone === 'stash' ? '松手取出' : '拖到卡册或桌面')
              : (drag.zone === 'showcase' ? '松手放进珍藏柜' : '拖到珍藏柜')}
          </span>
        </DragGhost>
      )}
      {selected && <CardSheet card={selected} onClose={() => setSelected(null)} onToggle={toggleShowcase} />}
    </section>
  );
}

/** 珍藏柜：没解锁时显示解锁按钮；解锁后显示格子、展示分和它带来的效果、升级按钮 */
function ShowcasePanel({ status, cards, onPick, onUpgrade, bind, dropClass }: {
  status: ShowcaseStatus | null;
  cards: CardView[];
  onPick: (c: CardView) => void;
  onUpgrade: () => Promise<void>;
  bind: Bind;
  /** 正在拖卡时的高亮样式 */
  dropClass: string;
}) {
  const [busy, setBusy] = useState(false);
  if (!status) return <h2>珍藏柜</h2>;
  const up = async () => { setBusy(true); try { await onUpgrade(); } finally { setBusy(false); } };
  if (status.level === 0) {
    return (
      <div className={`showcase-locked${dropClass}`} data-drop="showcase">
        <h2>珍藏柜 <small>未解锁</small></h2>
        <p className="hint">珍藏柜是店的门面：客人和别的玩家都看得到。柜里的卡越稀有，客人越舍得花钱、越有耐心。店倒闭重来时柜里的卡也会留下。</p>
        {status.next && <button className="primary" disabled={busy} onClick={up}>解锁珍藏柜（{status.next.slots} 格）· {fmt(status.next.price)} 信用点</button>}
      </div>
    );
  }
  return (
    <>
      <h2>珍藏柜 <small>{status.used} / {status.slots} · {status.level} 级</small></h2>
      <div className={`grid showcase${dropClass}`} data-drop="showcase">
        {cards.map((c) => <button key={c.id} className="cell draggable" onClick={() => onPick(c)} {...bind(c)}><Card card={c} small /></button>)}
        {Array.from({ length: Math.max(0, status.slots - cards.length) }, (_, i) => <div key={i} className="cell empty-slot">空</div>)}
      </div>
      <div className="showcase-score">
        <span>展示分 <b>{status.score}</b></span>
        <span>客人预算 <b>+{status.priceBonusPct}%</b>{status.priceBonusPct >= SHOWCASE.maxPriceBonus * 100 ? '（满）' : ''}</span>
        <span>耐心 <b>{status.patienceBonus ? `+${status.patienceBonus}` : `${SHOWCASE.patienceAt} 分 +1`}</b></span>
      </div>
      {status.next && <button className="secondary" disabled={busy} onClick={up}>升级到 {status.next.level} 级（{status.next.slots} 格）· {fmt(status.next.price)} 信用点</button>}
    </>
  );
}

/** 浮窗里的一本卡册：3 × 3 一页，左右翻；卡可以拖去珍藏柜 */
function BinderPages({ binder, version, onPick, bind, draggingId }: {
  binder: BinderView;
  /** 变了就重新拉这一页（拖卡改了位置以后） */
  version: number;
  onPick: (c: CardView) => void;
  bind: Bind;
  draggingId: number | null;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BinderPageResponse | null>(null);
  useEffect(() => { setPage(1); }, [binder.id]);
  useEffect(() => { api<BinderPageResponse>(`/binders/${binder.id}?page=${page}`).then(setData).catch(() => {}); }, [binder.id, page, version]);
  const cards = data?.cards ?? [];
  return (
    <>
      <p className="hint float-sub">{data?.binder.used ?? binder.used} / {binder.slots} 张 · {binder.effect}</p>
      <div className="binder-page">
        {cards.map((c) => (
          <button key={c.id} className={draggingId === c.id ? 'cell draggable dragging' : 'cell draggable'} onClick={() => onPick(c)} {...bind(c)}>
            <Card card={c} small />
          </button>
        ))}
        {Array.from({ length: Math.max(0, 9 - cards.length) }, (_, i) => <div key={`e${i}`} className="binder-slot" />)}
      </div>
      <div className="pager">
        <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {data?.pages ?? 1} 页</span>
        <button className="chip" disabled={!data || page >= data.pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </>
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
