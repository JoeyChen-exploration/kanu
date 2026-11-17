// 鉴定台（M3，DESIGN 5，FR-APPR-1～5）。交互原则：把卡拖到台上，按按钮确认。
// 三个位置：放大镜（自己看，马上有结论，只有自己知道）、鉴定机构（验真，下次打烊出结果，赃物没收）、
// 评级社（送评，下次打烊出结果，真卡封壳、假卡拒评扣信誉）。卡从卡册浮窗、桌面散放、珍藏柜拖过来。
import { useEffect, useState } from 'react';
import { APPRAISAL } from '@kanu/shared/balance';
import type {
  AppraisalDeskResponse, AppraisalMethod, AppraisalNotes, AppraiseResponse, BinderView, BindersResponse, CardAppraisalResponse, CardView,
  MeResponse, ShowcaseResponse,
} from '@kanu/shared/types';
import { api, newIdempotencyKey } from '../api.ts';
import { Card, fmt } from '../Card.tsx';
import { DragGhost, FloatWindow, useDrag } from '../drag.tsx';
import { BinderPages } from './Inventory.tsx';

type Station = 'loupe' | 'lab' | 'grading';
const STATION_NAME: Record<Station, string> = { loupe: '放大镜', lab: '鉴定机构', grading: '星港评级社' };

/** 鉴定结论翻成给玩家看的话 */
export function describeNotes(n: AppraisalNotes): string[] {
  const out: string[] = [];
  const auth = (x: string | null) => (x === 'fake' ? '看出是假卡' : '看起来是真的');
  if (n.eyeAuth) out.push(`肉眼看真伪：${auth(n.eyeAuth)}`);
  if (n.loupeAuth) out.push(`放大镜看真伪：${auth(n.loupeAuth)}`);
  if (n.lab) out.push(`鉴定机构：${n.lab === 'pending' ? '鉴定中' : n.lab === 'verified' ? '真卡，已验真' : '假卡'}`);
  if (n.eyeGrade) out.push(`肉眼估品相：${{ low: '差（1–3）', mid: '中（4–6）', high: '好（7–10）' }[n.eyeGrade]}`);
  if (n.loupeGrade) out.push(`放大镜估品相：${n.loupeGrade.map((g) => (g === 'BL' ? '黑标' : g)).join('–')}`);
  if (n.grading) out.push(`送评：${n.grading === 'pending' ? '评级中' : n.grading === 'slab' ? '已封壳' : '被拒评（疑似假卡）'}`);
  return out;
}

export function Appraisal({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [desk, setDesk] = useState<AppraisalDeskResponse | null>(null);
  const [binders, setBinders] = useState<BindersResponse | null>(null);
  const [showcase, setShowcase] = useState<CardView[]>([]);
  /** 每个位置上摆着的卡和它的鉴定信息 */
  const [placed, setPlaced] = useState<Partial<Record<Station, CardAppraisalResponse>>>({});
  const [open, setOpen] = useState<Array<{ id: string; name: string; binder?: BinderView }>>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    const [d, b, s] = await Promise.all([api<AppraisalDeskResponse>('/appraisal'), api<BindersResponse>('/binders'), api<ShowcaseResponse>('/showcase')]);
    setDesk(d); setBinders(b); setShowcase(s.cards);
  };
  useEffect(() => { load().catch((e: Error) => setErr(e.message)); }, []);

  const put = async (station: Station, card: CardView) => {
    setErr(''); setMsg('');
    try {
      const r = await api<CardAppraisalResponse>(`/cards/${card.id}/appraisal`);
      setPlaced((p) => ({ ...p, [station]: r }));
    } catch (e) { setErr((e as Error).message); }
  };
  const { drag, bind } = useDrag<CardView>((card, zone) => { if (zone === 'loupe' || zone === 'lab' || zone === 'grading') void put(zone, card); });

  const run = async (station: Station, method: AppraisalMethod) => {
    const cur = placed[station];
    if (!cur) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<AppraiseResponse>(`/cards/${cur.card.id}/appraise`, { method: 'POST', body: { method }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      if (method === 'lab' || method === 'grading') {
        setPlaced((p) => ({ ...p, [station]: undefined }));
        setMsg(`「${r.card.name}」送去${STATION_NAME[station]}了，下次打烊出结果`);
        await load();
        setVersion((v) => v + 1);
      } else {
        setPlaced((p) => ({ ...p, [station]: { ...cur, card: r.card, notes: r.notes, can: r.can } }));
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const toggle = (id: string, name: string, binder?: BinderView) =>
    setOpen((xs) => (xs.some((x) => x.id === id) ? xs.filter((x) => x.id !== id) : [...xs, { id, name, binder }]));
  const zoneClass = (z: Station) => (drag ? (drag.zone === z ? ' drop-target drop-over' : ' drop-target') : '');
  const loose = binders?.loose.cards ?? [];

  return (
    <section className="page appraisal-page">
      <h2>鉴定台 <small>把卡拖到下面的位置上，再按按钮</small></h2>
      <div className="stations">
        <StationBox station="loupe" cls={zoneClass('loupe')} data={placed.loupe} busy={busy} onClear={() => setPlaced((p) => ({ ...p, loupe: undefined }))}
          hint="自己看：马上有结论，只有你知道，不改卡价。每张卡每种看法只能看一次。">
          {(d) => (
            <>
              <button className="chip" disabled={busy || !d.can.eye_auth} onClick={() => run('loupe', 'eye_auth')}>肉眼看真伪 · 免费</button>
              <button className="chip" disabled={busy || !d.can.loupe_auth} onClick={() => run('loupe', 'loupe_auth')}>放大镜看真伪 · {fmt(d.fees.loupe)}</button>
              <button className="chip" disabled={busy || !d.can.eye_grade} onClick={() => run('loupe', 'eye_grade')}>肉眼估品相 · 免费</button>
              <button className="chip" disabled={busy || !d.can.loupe_grade} onClick={() => run('loupe', 'loupe_grade')}>放大镜估品相 · {fmt(d.fees.loupe)}</button>
            </>
          )}
        </StationBox>
        <StationBox station="lab" cls={zoneClass('lab')} data={placed.lab} busy={busy} onClear={() => setPlaced((p) => ({ ...p, lab: undefined }))}
          hint={`验真：100% 准，真卡拿到公开的"已验真"。注意：赃物会被当场没收。下次打烊出结果。`} away={desk?.lab}>
          {(d) => <button className="primary" disabled={busy || !d.can.lab} onClick={() => run('lab', 'lab')}>送去验真 · {fmt(d.fees.lab)}</button>}
        </StationBox>
        <StationBox station="grading" cls={zoneClass('grading')} data={placed.grading} busy={busy} onClear={() => setPlaced((p) => ({ ...p, grading: undefined }))}
          hint={`送评：真卡封壳出分（1–10、四个分项、黑标），按分数定价。送了假卡会被拒评，信誉 −${APPRAISAL.gradeRejectRepLoss}。最好先验真。下次打烊出结果。`} away={desk?.grading}>
          {(d) => <button className="primary" disabled={busy || !d.can.grading} onClick={() => run('grading', 'grading')}>送评 · {fmt(d.fees.grading)}</button>}
        </StationBox>
      </div>
      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}

      <h3>从哪里拿卡</h3>
      <div className="binder-list">
        {binders?.binders.map((b) => (
          <button key={b.id} className={open.some((x) => x.id === `b${b.id}`) ? 'binder-item on' : 'binder-item'} onClick={() => toggle(`b${b.id}`, b.name, b)}>
            <div className={`binder-cover binder-${b.kind}`} aria-hidden>{b.name.slice(0, 2)}</div>
            <div className="binder-body"><b>{b.name}</b><span className="hint">{b.used} / {b.slots} 张</span></div>
          </button>
        ))}
        {showcase.length > 0 && (
          <button className={open.some((x) => x.id === 'showcase') ? 'binder-item on' : 'binder-item'} onClick={() => toggle('showcase', '珍藏柜')}>
            <div className="binder-cover binder-showcase" aria-hidden>珍藏</div>
            <div className="binder-body"><b>珍藏柜</b><span className="hint">{showcase.length} 张</span></div>
          </button>
        )}
        {loose.length > 0 && (
          <button className={open.some((x) => x.id === 'loose') ? 'binder-item on' : 'binder-item'} onClick={() => toggle('loose', '桌面散放')}>
            <div className="binder-cover binder-loose" aria-hidden>桌面</div>
            <div className="binder-body"><b>桌面散放</b><span className="hint">{loose.length} 张</span></div>
          </button>
        )}
      </div>

      {open.map((o, i) => (
        <FloatWindow key={o.id} id={`appraise-${o.id}`} cascade={i} className="float-binder" title={o.name} onClose={() => toggle(o.id, o.name)}>
          {o.binder
            ? <BinderPages binder={o.binder} version={version} onPick={() => {}} bind={bind} draggingId={drag?.item.id ?? null} />
            : (
              <div className="binder-page">
                {(o.id === 'loose' ? loose : showcase).map((c) => (
                  <button key={c.id} className={drag?.item.id === c.id ? 'cell draggable dragging' : 'cell draggable'} {...bind(c)}><Card card={c} small /></button>
                ))}
              </div>
            )}
        </FloatWindow>
      ))}
      {drag && (
        <DragGhost x={drag.x} y={drag.y}>
          <Card card={drag.item} small />
          <span className="ghost-hint">{drag.zone ? `松手放到${STATION_NAME[drag.zone as Station] ?? ''}` : '拖到鉴定台上'}</span>
        </DragGhost>
      )}
    </section>
  );
}

/** 鉴定台上的一个位置：空着时是放卡的地方；放了卡显示卡、已有结论和按钮；下面列出送走的卡 */
function StationBox({ station, cls, data, busy, hint, away, onClear, children }: {
  station: Station; cls: string; data?: CardAppraisalResponse; busy: boolean; hint: string; away?: CardView[];
  onClear: () => void; children: (d: CardAppraisalResponse) => React.ReactNode;
}) {
  const notes = data ? describeNotes(data.notes) : [];
  return (
    <div className={`station station-${station}${cls}`} data-drop={station}>
      <div className="station-head"><b>{STATION_NAME[station]}</b></div>
      {data
        ? (
          <div className="station-card">
            <div className="station-art"><Card card={data.card} small /></div>
            <div className="station-info">
              <b>{data.card.name}</b>
              {notes.length ? <ul className="station-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : <p className="hint">还没鉴定过</p>}
              <div className="station-actions">{children(data)}</div>
              <button className="link" disabled={busy} onClick={onClear}>拿走</button>
            </div>
          </div>
        )
        : <p className="station-empty">把卡拖到这里</p>}
      <p className="hint station-hint">{hint}</p>
      {away && away.length > 0 && (
        <div className="station-away">
          <span className="hint">在{STATION_NAME[station]}：</span>
          {away.map((c) => <span key={c.id} className="badge">{c.name}（第 {c.readyDay} 天出结果）</span>)}
        </div>
      )}
    </div>
  );
}
