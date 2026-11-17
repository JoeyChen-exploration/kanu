// 图鉴页（FR-INV-5、FR-INV-12，DESIGN 3.6）：五本图鉴册，一个系列一本。
// 点一本打开浮窗（可以同时开好几本），一页 3 × 3 翻；点一张卡再开一个浮窗，看它每种卡面（外层风格）的收集情况。
// 普通图鉴 = 每张卡有过一张；大师图鉴 = 每张卡可能出的每种风格都有过（不可能出的风格不算）。
import { useEffect, useState } from 'react';
import { BINDER_PAGE_SIZE, STYLE, type Style } from '@kanu/shared/balance';
import type { CollectionEntry, CollectionResponse } from '@kanu/shared/types';
import { api } from '../api.ts';
import { Card } from '../Card.tsx';
import { FloatWindow } from '../drag.tsx';

type Series = CollectionResponse['series'][number];

/** 有过的风格里最稀有的那种（册子里用它画这张卡） */
const showStyle = (c: CollectionEntry): Style =>
  (c.styles.filter((s) => s.owned).sort((a, b) => STYLE[b.style as Style].mult - STYLE[a.style as Style].mult)[0]?.style ?? 'standard') as Style;

export function Collection() {
  const [data, setData] = useState<CollectionResponse | null>(null);
  const [err, setErr] = useState('');
  /** 打开的图鉴册、打开的卡面浮窗（都可以同时好几个） */
  const [books, setBooks] = useState<string[]>([]);
  const [cards, setCards] = useState<string[]>([]);
  useEffect(() => { api<CollectionResponse>('/collection').then(setData).catch((e: Error) => setErr(e.message)); }, []);

  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const all = data?.series ?? [];
  const total = all.reduce((n, s) => n + s.total, 0);
  const owned = all.reduce((n, s) => n + s.owned, 0);
  const master = all.reduce((n, s) => n + s.master, 0);
  const entry = (id: string) => all.flatMap((s) => s.cards).find((c) => c.templateId === id);

  return (
    <section className="page">
      <h2>图鉴 <small>普通 {owned} / {total} · 大师 {master} / {total}</small></h2>
      <p className="hint">普通图鉴：每张卡有过一张就点亮。大师图鉴：同一张卡的每种卡面（闪卡、金框、暗物质……）都收集过。点开册子，再点一张卡看它的卡面。</p>
      <div className="book-shelf">
        {all.map((s) => (
          <button key={s.id} className={`book${books.includes(s.id) ? ' on' : ''} book-${s.kind}`} onClick={() => setBooks(toggle(books, s.id))}>
            <div className="book-spine" aria-hidden />
            <div className="book-cover">
              <b>{s.name}</b>
              <span className="book-sub">{s.kind === 'premium' ? '典藏图鉴' : '图鉴'}</span>
              <div className="book-progress">
                <span>普通 {s.owned} / {s.total}</span>
                <div className="fill"><div style={{ width: `${(s.owned / s.total) * 100}%` }} /></div>
                <span>大师 {s.master} / {s.total}</span>
                <div className="fill master"><div style={{ width: `${(s.master / s.total) * 100}%` }} /></div>
              </div>
            </div>
          </button>
        ))}
      </div>
      {err && <p className="error">{err}</p>}

      {books.map((id, i) => {
        const s = all.find((x) => x.id === id);
        return s && (
          <FloatWindow key={id} id={`book-${id}`} cascade={i} className="float-binder" title={<>{s.name} <small>{s.owned} / {s.total}</small></>}
            onClose={() => setBooks(books.filter((x) => x !== id))}>
            <BookPages series={s} onPick={(c) => setCards(cards.includes(c.templateId) ? cards : [...cards, c.templateId])} />
          </FloatWindow>
        );
      })}
      {cards.map((id, i) => {
        const c = entry(id);
        return c && (
          <FloatWindow key={id} id={`card-faces-${i}`} cascade={i} className="float-faces" title={<>{c.name} <small>{c.rarity}</small></>}
            onClose={() => setCards(cards.filter((x) => x !== id))}>
            <CardFaces card={c} />
          </FloatWindow>
        );
      })}
    </section>
  );
}

/** 一本图鉴册：一页 3 × 3 */
function BookPages({ series, onPick }: { series: Series; onPick: (c: CollectionEntry) => void }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(series.cards.length / BINDER_PAGE_SIZE));
  const cards = series.cards.slice((page - 1) * BINDER_PAGE_SIZE, page * BINDER_PAGE_SIZE);
  return (
    <>
      <p className="hint float-sub">大师 {series.master} / {series.total} · 点一张卡看它的各种卡面</p>
      <div className="binder-page">
        {cards.map((c) => {
          const got = c.styles.filter((s) => s.owned).length;
          return (
            <button key={c.templateId} className={c.owned ? 'cell book-cell' : 'cell book-cell locked'} onClick={() => onPick(c)}>
              {c.owned
                ? <Card card={{ ...c, style: showStyle(c), serialNo: null }} small />
                : <div className="card small silhouette"><div className="card-face">?</div></div>}
              {c.master && <span className="master-star" title="大师图鉴已集齐">★</span>}
              <span className="cell-price">卡面 {got} / {c.styles.length}{c.count ? ` · 手上 ${c.count}` : ''}</span>
            </button>
          );
        })}
        {Array.from({ length: Math.max(0, BINDER_PAGE_SIZE - cards.length) }, (_, i) => <div key={`e${i}`} className="binder-slot" />)}
      </div>
      <div className="pager">
        <button className="chip" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button className="chip" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </>
  );
}

/** 一张卡的各种卡面：有过的亮着（写手上几张），没有过的变暗 */
function CardFaces({ card }: { card: CollectionEntry }) {
  const got = card.styles.filter((s) => s.owned).length;
  const missing = Object.keys(STYLE).filter((s) => !card.styles.some((x) => x.style === s)).map((s) => STYLE[s as Style].name);
  return (
    <>
      <p className="hint float-sub">卡面 {got} / {card.styles.length}{card.master ? ' · ★ 大师图鉴已集齐' : ''}</p>
      <div className="faces">
        {card.styles.map((s) => (
          <figure key={s.style} className={s.owned ? 'face' : 'face locked'}>
            <Card card={{ ...card, style: s.style as Style, serialNo: null }} small />
            <figcaption>
              <b>{s.name}</b>
              <span>{s.owned ? (s.count ? `手上 ${s.count} 张` : '有过') : '未收集'}</span>
            </figcaption>
          </figure>
        ))}
      </div>
      {missing.length > 0 && <p className="hint">{card.rarity} 卡不出{missing.join('、')}，不算进大师图鉴。</p>}
    </>
  );
}
