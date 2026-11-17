// 任务栏（FR-UI-4，2026-11-17 用户定）：固定在右上角的窗口，顶部三角收起 / 展开（状态记在本机）。
// 一开始是新手指引：按顺序显示前几条没领奖的任务，点任务跳到对应页面，做完点"领取"拿信用点。
// 以后科技树上线，玩家可以在这里追踪节点的解锁条件。
import { useEffect, useRef, useState } from 'react';
import { QUEST_BAR } from '@kanu/shared/balance';
import type { MeResponse, QuestClaimResponse, QuestView, QuestsResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { fmt } from './Card.tsx';

const OPEN_KEY = 'kanu.questbar.open';
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };

export function QuestBar({ onGo, onChange }: { onGo: (tab: string) => void; onChange: (p: Partial<MeResponse>) => void }) {
  const [quests, setQuests] = useState<QuestView[] | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const timer = useRef<number | null>(null);

  // 进来拉一次；之后每次有写操作成功（买包、拆包、成交、打烊……）都重新拉
  useEffect(() => {
    const load = () => api<QuestsResponse>('/quests').then((r) => setQuests(r.quests)).catch(() => {});
    void load();
    const onWrite = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 250);
    };
    window.addEventListener(WRITE_EVENT, onWrite);
    return () => window.removeEventListener(WRITE_EVENT, onWrite);
  }, []);

  const toggle = () => {
    const next = !open;
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* 存不了就算了 */ }
    setOpen(next);
  };

  const claim = async (q: QuestView) => {
    setBusy(q.id);
    try {
      const r = await api<QuestClaimResponse>(`/quests/${q.id}/claim`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      setQuests(r.quests);
      onChange({ credits: r.credits });
      setFlash(`+${fmt(r.reward)} 信用点`);
      window.setTimeout(() => setFlash(''), 1800);
    } catch { /* 进度变了就等下次刷新 */ } finally {
      setBusy(null);
    }
  };

  if (!quests) return null;
  const pending = quests.filter((q) => !q.claimed);
  // 能领奖的置顶，而且全部显示（不被"只显示几条"挤掉）；剩下的位置按顺序补上接下来要做的
  const claimable = pending.filter((q) => q.done);
  const todo = pending.filter((q) => !q.done);
  const shown = [...claimable, ...todo.slice(0, Math.max(0, QUEST_BAR.visible - claimable.length))];
  const ready = claimable.length;
  const doneCount = quests.length - pending.length;

  return (
    <aside className={open ? 'quest-bar open' : 'quest-bar'} aria-label="任务栏">
      <button className="quest-head" onClick={toggle} aria-expanded={open}>
        <span className="quest-tri" aria-hidden>{open ? '▲' : '▼'}</span>
        <b>任务</b>
        <span className="quest-count">{doneCount} / {quests.length}</span>
        {ready > 0 && <span className="quest-ready">{ready} 个可领</span>}
      </button>
      {open && (
        <div className="quest-body">
          {flash && <p className="quest-flash">{flash}</p>}
          {shown.length === 0 && <p className="hint">新手任务都完成了。科技树上线后，可以在这里追踪节点的解锁条件。</p>}
          {shown.map((q) => (
            <div key={q.id} className={q.done ? 'quest done' : 'quest'}>
              <button className="quest-main" onClick={() => onGo(q.tab)} title="去看看">
                <span className="quest-title">{q.title}</span>
                <span className="quest-hint">{q.hint}</span>
                <span className="quest-prog"><span style={{ width: `${(q.progress / q.target) * 100}%` }} /></span>
                <span className="quest-num">{q.progress} / {q.target}</span>
              </button>
              {q.done
                ? <button className="quest-claim" disabled={busy === q.id} onClick={() => claim(q)}>领取 +{fmt(q.reward)}</button>
                : <span className="quest-reward">奖励 {fmt(q.reward)}</span>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
