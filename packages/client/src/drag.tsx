// 拖卡和浮窗（库存页用）。用 pointer 事件自己实现，手机和电脑都能用：
//   - 鼠标：按住移动超过几像素就开始拖
//   - 手指：长按一下（LONG_PRESS_MS）再拖；没等到就移动，算滚动页面
// 放下的位置用 elementFromPoint 找最近的 [data-drop] 区域。轻点（没拖起来）照常触发 onClick。
import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';

const MOUSE_THRESHOLD = 6;
const LONG_PRESS_MS = 250;
const TOUCH_SLOP = 10;

export interface DragState<T> { item: T; x: number; y: number; zone: string | null }

/** 拖东西：返回当前拖着的东西（画影子用）、给可拖元素的 onPointerDown、给可拖元素的 onClickCapture（拖完不触发点击） */
export function useDrag<T>(onDrop: (item: T, zone: string) => void) {
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  const dragRef = useRef<DragState<T> | null>(null);
  const pending = useRef<{ item: T; x0: number; y0: number; id: number; mouse: boolean; timer: number | null } | null>(null);
  const justDragged = useRef(false);
  const startRef = useRef<(x: number, y: number) => void>(() => {});
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const set = (d: DragState<T> | null) => { dragRef.current = d; setDrag(d); };
  const zoneAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null)?.dataset.drop ?? null;

  useEffect(() => {
    const start = (x: number, y: number) => {
      const p = pending.current;
      if (!p) return;
      if (p.timer) window.clearTimeout(p.timer);
      pending.current = null;
      set({ item: p.item, x, y, zone: zoneAt(x, y) });
      navigator.vibrate?.(15);
    };
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (p && e.pointerId === p.id) {
        const dist = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
        if (p.mouse && dist > MOUSE_THRESHOLD) start(e.clientX, e.clientY);
        else if (!p.mouse && dist > TOUCH_SLOP) { if (p.timer) window.clearTimeout(p.timer); pending.current = null; }
        return;
      }
      if (dragRef.current) set({ ...dragRef.current, x: e.clientX, y: e.clientY, zone: zoneAt(e.clientX, e.clientY) });
    };
    const end = (e: PointerEvent) => {
      if (pending.current) { if (pending.current.timer) window.clearTimeout(pending.current.timer); pending.current = null; }
      const d = dragRef.current;
      if (!d) return;
      set(null);
      justDragged.current = true;
      window.setTimeout(() => { justDragged.current = false; }, 50);
      const zone = e.type === 'pointerup' ? zoneAt(e.clientX, e.clientY) : null;
      if (zone) dropRef.current(d.item, zone);
    };
    // 拖着的时候别让手机滚动页面
    const touchmove = (e: TouchEvent) => { if (dragRef.current) e.preventDefault(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    document.addEventListener('touchmove', touchmove, { passive: false });
    startRef.current = start;
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.removeEventListener('touchmove', touchmove);
    };
  }, []);

  const bind = useCallback((item: T) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const mouse = e.pointerType === 'mouse';
      const { clientX: x0, clientY: y0, pointerId: id } = e;
      const timer = mouse ? null : window.setTimeout(() => {
        const p = pending.current;
        if (p && p.id === id) startRef.current(x0, y0);
      }, LONG_PRESS_MS);
      pending.current = { item, x0, y0, id, mouse, timer };
    },
    onClickCapture: (e: ReactMouseEvent) => { if (justDragged.current) { e.stopPropagation(); e.preventDefault(); } },
    // 手机长按会弹系统菜单，卡牌上不需要
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  }), []);

  return { drag, bind };
}

/** 跟着手指 / 鼠标走的影子 */
export function DragGhost({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <div className="drag-ghost" style={{ left: x, top: y }}>{children}</div>;
}

const readPos = (key: string): { x: number; y: number } | null => {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v && typeof v.x === 'number' ? v : null; } catch { return null; }
};

/**
 * 道具浮窗（卡册、新手手册……）：拖着标题栏移到屏幕任意位置；每种浮窗的位置分别记在本机，下次打开还在原处。
 * 第一次打开时水平居中。
 */
export function FloatWindow({ id, title, onClose, children, dropZone, className = '' }: {
  /** 记位置用，每种浮窗一个 */
  id: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  dropZone?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const posKey = `kanu.float.${id}`;
  const [pos, setPos] = useState(() => readPos(posKey) ?? { x: -1, y: 64 });
  const grab = useRef<{ dx: number; dy: number; id: number } | null>(null);

  const clamp = useCallback((x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 320;
    return { x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)), y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 48)) };
  }, []);
  useEffect(() => {
    // x = -1 表示还没摆过：居中
    setPos((p) => (p.x < 0 ? clamp((window.innerWidth - (ref.current?.offsetWidth ?? 320)) / 2, p.y) : clamp(p.x, p.y)));
    const onResize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const style: CSSProperties = { left: Math.max(0, pos.x), top: pos.y, visibility: pos.x < 0 ? 'hidden' : undefined };
  return (
    <div ref={ref} className={`float-window ${className}`} style={style} data-drop={dropZone} role="dialog">
      <div
        className="float-title"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          grab.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, id: e.pointerId };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!grab.current || grab.current.id !== e.pointerId) return;
          setPos(clamp(e.clientX - grab.current.dx, e.clientY - grab.current.dy));
        }}
        onPointerUp={() => {
          grab.current = null;
          try { localStorage.setItem(posKey, JSON.stringify(pos)); } catch { /* 存不了就算了 */ }
        }}
      >
        <span className="float-grip" aria-hidden>⠿</span>
        <span className="float-name">{title}</span>
        <button className="chip" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className="float-body">{children}</div>
    </div>
  );
}
