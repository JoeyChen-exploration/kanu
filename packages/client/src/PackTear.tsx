// 撕卡包（2026-11-25 用户定）：卡包放大摆在中间，顶部一条锯齿封口。
// 鼠标在封口上横着滑过去（不用按键）；手机上按住拖过去。滑过的地方沿锯齿亮起一道光，滑过 TEAR.done 就撕开：
// 封口翻飞出去、包口透光，这时才请求服务器拆包（服务器权威）。失败就把封口复原，卡包不消耗。
import { useRef, useState } from 'react';
import { PackArt } from './art.tsx';

/** 封口高度（占卡包高度的比例）、锯齿数、滑过多少算撕开、撕开后等动画多久 */
const TEAR = { strip: 0.18, teeth: 14, amp: 0.022, done: 0.75, flyMs: 650 };

/** 锯齿线上的点（0–100 坐标），从左到右 */
const zigzag = Array.from({ length: TEAR.teeth * 2 + 1 }, (_, i) => {
  const x = (i / (TEAR.teeth * 2)) * 100;
  const y = (TEAR.strip + (i % 2 ? TEAR.amp : -TEAR.amp)) * 100;
  return [x, y] as const;
});
const pts = (xs: ReadonlyArray<readonly [number, number]>) => xs.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ');
const STRIP_CLIP = `polygon(0% 0%, 100% 0%, ${pts([...zigzag].reverse())})`;
const BODY_CLIP = `polygon(${pts(zigzag)}, 100% 100%, 0% 100%)`;
const LINE = zigzag.map(([x, y]) => `${x},${y}`).join(' ');

export interface TearPack { id: number; seriesId: string; name: string; kind: string; wholesale?: boolean }

/** onTear：撕开那一刻去拆包（请求服务器）；onDone：动画放完、拆包也成功了，换成翻牌 */
export function PackTear({ pack, onTear, onDone, onCancel }: { pack: TearPack; onTear: () => Promise<void>; onDone: () => void; onCancel: () => void }) {
  const [phase, setPhase] = useState<'ready' | 'torn' | 'error'>('ready');
  const [span, setSpan] = useState<{ min: number; max: number; at: number } | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);

  const progress = span ? (span.max - span.min) / 100 : 0;

  const tear = async (from: 1 | -1) => {
    if (phase === 'torn') return;
    setDir(from);
    setPhase('torn');
    setErr('');
    try { navigator.vibrate?.(25); } catch { /* 不支持就算了 */ }
    const wait = new Promise((r) => window.setTimeout(r, TEAR.flyMs));
    try {
      await Promise.all([onTear(), wait]);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setPhase('error');
      setSpan(null);
    }
  };

  /** 指针在封口那一带横着走：记下这一趟走过的最左、最右，离开封口带就重来 */
  const track = (e: React.PointerEvent) => {
    if (phase === 'torn') return;
    const el = ref.current;
    if (!el) return;
    if (e.pointerType !== 'mouse' && !pressed.current) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = (e.clientY - r.top) / r.height;
    const inBand = y > -0.06 && y < TEAR.strip + 0.12 && x >= -4 && x <= 104;
    if (!inBand) { if (span) setSpan(null); return; }
    const cx = Math.max(0, Math.min(100, x));
    const next = span ? { min: Math.min(span.min, cx), max: Math.max(span.max, cx), at: cx } : { min: cx, max: cx, at: cx };
    setSpan(next);
    if ((next.max - next.min) / 100 >= TEAR.done) void tear(cx >= (next.min + next.max) / 2 ? 1 : -1);
  };

  return (
    <div className="tear-stage">
      <p className="tear-hint">{phase === 'torn' ? '撕开了！' : '沿着顶部的锯齿线滑过去，撕开卡包'}</p>
      <div
        ref={ref}
        className={`tear-pack kind-${pack.kind}${phase === 'torn' ? ' torn' : ''}`}
        onPointerMove={track}
        onPointerDown={(e) => { pressed.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); track(e); }}
        onPointerUp={() => { pressed.current = false; if (phase !== 'torn') setSpan(null); }}
        onPointerCancel={() => { pressed.current = false; setSpan(null); }}
        onPointerLeave={() => { if (phase !== 'torn') setSpan(null); }}
        style={{ '--tear-dir': dir } as React.CSSProperties}
      >
        <div className="tear-body" style={{ clipPath: BODY_CLIP }}>
          <PackArt seriesId={pack.seriesId} name={pack.name} kind={pack.kind} box={pack.wholesale} className="tear-art" />
        </div>
        <div className="tear-strip" style={{ clipPath: STRIP_CLIP }}>
          <PackArt seriesId={pack.seriesId} name={pack.name} kind={pack.kind} box={pack.wholesale} className="tear-art" />
        </div>
        {phase === 'torn' && <div className="tear-glow" />}
        <svg className="tear-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <defs>
            <clipPath id="tear-cut"><rect x={span?.min ?? 0} y="0" width={phase === 'torn' ? 100 : span ? span.max - span.min : 0} height="100" /></clipPath>
          </defs>
          <polyline points={LINE} className="tear-dash" />
          <polyline points={LINE} className="tear-cut" clipPath="url(#tear-cut)" />
        </svg>
        {span && phase !== 'torn' && <span className="tear-spark" style={{ left: `${span.at}%`, top: `${TEAR.strip * 100}%` }} />}
        <div className="tear-progress" aria-hidden><span style={{ width: `${Math.min(1, progress / TEAR.done) * 100}%` }} /></div>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="tear-actions">
        <button className="link" disabled={phase === 'torn'} onClick={() => void tear(1)}>直接撕开</button>
        <button className="link" disabled={phase === 'torn'} onClick={onCancel}>先不拆</button>
      </div>
    </div>
  );
}
