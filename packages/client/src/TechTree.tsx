// 科技树页（docs/TECH-TREE.md，2026-11-18 用户定：单独一页，画成真正的树，每个节点是一项科技）。
// 根节点"卡奴小店"在最上面，往下分出五条分支（柜台、鉴定、进货、电话、店面），每层往下一格；二选一的节点左右并排。
// 同一分支的连线一直显示；跨分支的前置（虚线）只在选中节点时显示，免得满屏乱线。
// 点节点在右边看详情，按钮确认"点亮 / 追踪"。背景可以按住拖动来平移。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BLUEPRINT } from '@kanu/shared/balance';
import type { MeResponse, TechBuyResponse, TechNodeView, TechResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { fmt } from './Card.tsx';

/** 布局：每条分支两条"车道"，单个节点居中，二选一的 a 在左、b 在右 */
const LANE = 118;
const NODE_W = 106;
const NODE_H = 58;
const ROW = 92;
const GUTTER = 54;
const ROOT_Y = 34;
const LABEL_Y = 98;
const TIER1_Y = 150;
const MAX_TIER = 6;

type Pos = { x: number; y: number };

function layout(branches: TechResponse['branches']) {
  const pos = new Map<string, Pos>();
  branches.forEach((b, i) => {
    const center = GUTTER + i * 2 * LANE + LANE;
    for (const n of b.nodes) {
      const side = n.id.endsWith('a') ? -LANE / 2 : n.id.endsWith('b') ? LANE / 2 : 0;
      pos.set(n.id, { x: center + side, y: TIER1_Y + (n.tier - 1) * ROW });
    }
  });
  const width = GUTTER + branches.length * 2 * LANE + 16;
  const height = TIER1_Y + (MAX_TIER - 1) * ROW + NODE_H + 24;
  return { pos, width, height, root: { x: (GUTTER + width - 16) / 2, y: ROOT_Y } };
}

const stateOf = (n: TechNodeView) => (n.owned ? 'owned' : n.soon ? 'soon' : n.exclusive?.owned ? 'blocked' : n.unlockable ? 'ready' : n.requires.every((r) => r.owned) && (n.anyOf.length === 0 || n.anyOf.some((r) => r.owned)) ? 'open' : 'locked');

export function TechPage({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<TechResponse | null>(null);
  const [sel, setSel] = useState<string>('C1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null);

  useEffect(() => {
    const load = () => api<TechResponse>('/tech').then(setData).catch((e: Error) => setErr(e.message));
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);

  const nodes = useMemo(() => new Map((data?.branches ?? []).flatMap((b) => b.nodes).map((n) => [n.id, n])), [data]);
  const geo = useMemo(() => (data ? layout(data.branches) : null), [data]);
  if (!data || !geo) return <section className="page"><h1>科技树</h1>{err ? <p className="error">{err}</p> : <p className="hint">加载中…</p>}</section>;

  const node = nodes.get(sel) ?? null;
  const buy = async (n: TechNodeView) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<TechBuyResponse>('/tech/buy', { method: 'POST', body: { nodeId: n.id }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setMsg(`点亮了「${n.name}」：${n.effect}${r.converted > 0 ? `（用 ${fmt(Math.ceil(r.converted / BLUEPRINT.perCredit))} 信用点换了 ${fmt(r.converted)} 蓝图）` : ''}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const track = async (n: TechNodeView) => {
    setBusy(true); setErr('');
    try { setData(await api<TechResponse>('/tech/track', { method: 'POST', body: { nodeId: n.tracked ? null : n.id } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 连线：根 → 每条分支第 1 层；同分支前置实线；跨分支前置虚线（只画选中节点的）
  type Edge = { from: Pos; to: Pos; key: string; cls: string };
  const edges: Edge[] = [];
  const bottom = (p: Pos): Pos => ({ x: p.x, y: p.y + NODE_H });
  for (const n of nodes.values()) {
    const to = geo.pos.get(n.id)!;
    if (n.tier === 1) edges.push({ from: { x: geo.root.x, y: geo.root.y + 22 }, to, key: `root-${n.id}`, cls: n.owned ? 'lit' : '' });
    for (const r of [...n.requires, ...n.anyOf]) {
      const parent = nodes.get(r.id);
      if (!parent) continue;
      const cross = parent.branch !== n.branch;
      if (cross && sel !== n.id && sel !== r.id) continue;
      edges.push({ from: bottom(geo.pos.get(r.id)!), to, key: `${r.id}-${n.id}`, cls: `${cross ? 'cross' : ''}${r.owned && n.owned ? ' lit' : r.owned ? ' half' : ''}${sel === n.id || sel === r.id ? ' sel' : ''}` });
    }
  }
  const curve = (e: Edge) => {
    const my = (e.from.y + e.to.y) / 2;
    return `M ${e.from.x} ${e.from.y} C ${e.from.x} ${my}, ${e.to.x} ${my}, ${e.to.x} ${e.to.y}`;
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.tnode')) return;
    const el = scroller.current;
    if (!el) return;
    pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (!pan.current || !el) return;
    el.scrollLeft = pan.current.l - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.t - (e.clientY - pan.current.y);
  };
  const onUp = () => { pan.current = null; };

  const owned = [...nodes.values()].filter((n) => n.owned).length;
  const open = [...nodes.values()].filter((n) => !n.soon).length;

  return (
    <section className="page tech-page">
      <div className="tech-head">
        <h1>科技树</h1>
        <span className="hint">已点亮 {owned} / {open}（开放中）· 蓝图 <b>{fmt(data.blueprints)}</b> · 蓝图不够时点亮自动用信用点 1:1 换 · 永久保留</span>
      </div>
      <div className="tech-layout">
        <div className="tech-scroll" ref={scroller} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="tech-canvas" style={{ width: geo.width, height: geo.height }}>
            <svg className="tech-edges" width={geo.width} height={geo.height} aria-hidden>
              {edges.map((e) => <path key={e.key} d={curve(e)} className={`tedge ${e.cls}`} />)}
            </svg>
            {Array.from({ length: MAX_TIER }, (_, i) => (
              <span key={i} className="tier-label" style={{ top: TIER1_Y + i * ROW + NODE_H / 2 - 8 }}>{i + 1} 层</span>
            ))}
            <div className="troot" style={{ left: geo.root.x - 60, top: geo.root.y - 20 }}>🏪 卡奴小店</div>
            {data.branches.map((b, i) => (
              <div key={b.id} className="tbranch" style={{ left: GUTTER + i * 2 * LANE, top: LABEL_Y - 18, width: 2 * LANE }}>
                <b>{b.name}</b><span>{b.contact}</span>
              </div>
            ))}
            {[...nodes.values()].map((n) => {
              const p = geo.pos.get(n.id)!;
              const st = stateOf(n);
              return (
                <button
                  key={n.id}
                  className={`tnode ${st}${sel === n.id ? ' sel' : ''}${n.tracked ? ' tracked' : ''}`}
                  style={{ left: p.x - NODE_W / 2, top: p.y, width: NODE_W, height: NODE_H }}
                  onClick={() => { setSel(n.id); setMsg(''); setErr(''); }}
                >
                  <span className="tnode-id">{n.id}{n.tracked ? ' 📌' : ''}</span>
                  <span className="tnode-name">{n.name}</span>
                  <span className="tnode-sub">{n.owned ? '已点亮' : n.soon ? `第 ${n.soon} 阶段` : fmt(n.price)}</span>
                </button>
              );
            })}
          </div>
        </div>
        {node && (
          <aside className={`tech-detail ${stateOf(node)}`}>
            <div className="tech-detail-head">
              <span className="tnode-id">{node.id} · {node.branchName} · 第 {node.tier} 层</span>
              <h2>{node.name}</h2>
            </div>
            <p className="tech-effect">{node.effect}</p>
            <p className="tech-flavor">"{node.flavor}"</p>
            {node.exclusive && <p className="hint">⚖️ 和「{node.exclusive.name}」二选一，点了一个另一个就点不了</p>}
            {!node.owned && (
              <ul className="tech-conds">
                {node.requires.map((r) => <li key={r.id} className={r.owned ? 'met' : ''}>{r.owned ? '✓' : '·'} 先点「{r.name}」</li>)}
                {node.anyOf.length > 0 && <li className={node.anyOf.some((r) => r.owned) ? 'met' : ''}>{node.anyOf.some((r) => r.owned) ? '✓' : '·'} 先点其中一个：{node.anyOf.map((r) => r.name).join(' / ')}</li>}
                {node.conditions.map((c) => <li key={c.text} className={c.met ? 'met' : ''}>{c.met ? '✓' : '·'} {c.text}（{c.current} / {c.target}）</li>)}
                {node.conditionText && <li>· {node.conditionText}</li>}
              </ul>
            )}
            {node.owned
              ? <p className="tech-owned">✓ 已点亮</p>
              : node.soon
                ? <p className="hint">这项科技第 {node.soon} 阶段开放，先看看路线。</p>
                : (
                  <div className="tech-actions">
                    <button className="primary" disabled={busy || !node.unlockable || data.credits < Math.ceil(Math.max(0, node.price - data.blueprints) / BLUEPRINT.perCredit)} onClick={() => buy(node)}>
                      点亮 · {fmt(node.price)} 蓝图
                    </button>
                    <button className={node.tracked ? 'chip on' : 'chip'} disabled={busy} onClick={() => track(node)}>{node.tracked ? '取消追踪' : '📌 追踪'}</button>
                  </div>
                )}
            {msg && <p className="deal-msg">{msg}</p>}
            {err && <p className="error">{err}</p>}
          </aside>
        )}
      </div>
      <p className="hint tech-legend">
        <span className="dot owned" /> 已点亮 <span className="dot ready" /> 可以点 <span className="dot open" /> 差条件 <span className="dot locked" /> 先点前一个 <span className="dot soon" /> 之后开放 · 虚线是跨分支的前置（选中节点时显示）· 按住空白处拖动平移
      </p>
    </section>
  );
}
