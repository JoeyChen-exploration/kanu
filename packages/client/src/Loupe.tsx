// 放大镜的镜片和细节（2026-11-18 用户定，学深空当铺）+ 假卡识别手册（浮窗）。
// 省美术的做法：不给每张卡画细节图。镜片里 = 这张卡的卡面放大（复用卡面）+ 一套通用细节贴图（所有卡共用），
// 细节放在哪由卡的编号算固定位置（同一张卡每次看都一样，不同卡不一样）。
// 不泄露隐藏属性：细节只按放大镜的结论画（看出是假的才有破绽、品相按估计的两档画划痕、认出错版才有重影），
// 没查过的卡镜片里只有放大的卡面和正品网点。手册用同一套贴图拼示例，不另外画图。
// 贴图现在是 CSS 占位（style.css 的"放大镜细节：美术接入点"），美术到了换成图片，这里的代码不用改。
import type { CardView, InspectionView } from '@kanu/shared/types';
import { Card, VOID_CARDS } from './Card.tsx';
import { FloatWindow } from './drag.tsx';

/** 一处细节：kind 是贴图种类，x / y 是在卡面上的位置（0–100%），rot 旋转、size 大小（卡宽的百分比） */
export type DetailKind = 'ink' | 'misregister' | 'holo' | 'border' | 'scratch' | 'dust' | 'corner' | 'gap';
export interface Spot { kind: DetailKind; x: number; y: number; rot: number; size: number }

/** 按卡编号出的固定随机数（同一张卡每次都一样） */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TELLS: DetailKind[] = ['ink', 'misregister', 'holo', 'border'];

/** 品相估计的下档（BL 当 11）：分越低划痕越多 */
const lowGrade = (i: InspectionView) => (i.gradeRange[0] === 'BL' ? 11 : Number(i.gradeRange[0]));

/** 这张卡在放大镜下的细节（只按放大镜的结论算） */
export function detailSpots(cardId: number, inspection: InspectionView | null): Spot[] {
  if (!inspection) return [];
  const rnd = seeded(cardId * 7919 + 13);
  const at = (kind: DetailKind, size: number): Spot => ({ kind, x: 12 + rnd() * 76, y: 14 + rnd() * 72, rot: rnd() * 360, size });
  const spots: Spot[] = [];
  if (inspection.looks === 'fake') {
    // 两处破绽，种类按编号挑
    const first = Math.floor(rnd() * TELLS.length);
    spots.push(at(TELLS[first]!, 34), at(TELLS[(first + 1 + Math.floor(rnd() * 3)) % TELLS.length]!, 30));
  }
  const g = lowGrade(inspection);
  const scratches = g >= 9 ? 0 : g >= 7 ? 2 : g >= 4 ? 4 : 6;
  for (let i = 0; i < scratches; i += 1) spots.push(at('scratch', 22 + rnd() * 18));
  for (let i = 0; i < Math.max(0, scratches - 1); i += 1) spots.push(at('dust', 10 + rnd() * 8));
  if (g <= 5) spots.push({ kind: 'corner', x: rnd() < 0.5 ? 92 : 8, y: rnd() < 0.5 ? 6 : 94, rot: 0, size: 20 });
  if (inspection.errataFound) spots.push(at('gap', 30));
  return spots;
}

/** 叠在卡面上的细节层：正品网点一直有（中性，不泄露）；其余按 spots 画 */
export function DetailLayer({ spots }: { spots: Spot[] }) {
  return (
    <div className="detail-layer" aria-hidden>
      <div className="detail-halftone" />
      {spots.map((s, i) => (
        <span key={i} className={`detail detail-${s.kind}`}
          style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.size}%`, transform: `translate(-50%, -50%) rotate(${s.rot}deg)` }} />
      ))}
    </div>
  );
}

/** 放大后的卡面 + 细节；errata 时再叠一层错开的重影（错版的"印了两次"，代码做，不用美术） */
function Zoomed({ card, spots, errata }: { card: Pick<CardView, 'name' | 'rarity' | 'style' | 'tags' | 'serialNo'> & Partial<CardView>; spots: Spot[]; errata: boolean }) {
  // 彩蛋卡（纯黑卡面）：镜片里也是纯黑，不画细节贴图和错版重影；真伪、品相的结论照常用文字给
  const isVoid = !!card.templateId && VOID_CARDS.has(card.templateId);
  return (
    <div className="zoom-card">
      <Card card={card} small />
      {errata && !isVoid && <div className="zoom-ghost"><Card card={card} small /></div>}
      {!isVoid && <DetailLayer spots={spots} />}
    </div>
  );
}

const LENS = 150;
const ZOOM = 2.6;

/**
 * 跟着放大镜走的镜片：rect 是被看的那张卡在屏幕上的位置，(px, py) 是放大镜指着的点。
 * 镜片画在指尖上方（手机上手指不挡住），里面是这张卡在这一点附近放大 ZOOM 倍。
 */
export function LoupeLens({ x, y, rect, card, inspection }: {
  x: number; y: number; rect: DOMRect; card: CardView; inspection: InspectionView | null;
}) {
  const px = Math.min(Math.max(x - rect.left, 0), rect.width);
  const py = Math.min(Math.max(y - rect.top, 0), rect.height);
  return (
    <div className="loupe-lens" style={{ left: x, top: y - 90, width: LENS, height: LENS }}>
      <div className="loupe-lens-inner" style={{ width: rect.width, left: LENS / 2 - px * ZOOM, top: LENS / 2 - py * ZOOM, transform: `scale(${ZOOM})` }}>
        <Zoomed card={card} spots={detailSpots(card.id, inspection)} errata={!!inspection?.errataFound} />
      </div>
      <div className="loupe-lens-glare" />
      {!inspection && <span className="loupe-lens-hint">停一下……</span>}
    </div>
  );
}

/** 手册里的一个静态镜片：把示例卡在 (fx, fy)% 这一点放大 */
function StaticLens({ spots, errata = false, fx, fy, label }: { spots: Spot[]; errata?: boolean; fx: number; fy: number; label: string }) {
  const w = 64;
  const h = (w * 88) / 63;
  return (
    <figure className="guide-lens">
      <div className="loupe-lens static" style={{ width: 120, height: 120 }}>
        <div className="loupe-lens-inner" style={{ width: w, left: 60 - (fx / 100) * w * ZOOM, top: 60 - (fy / 100) * h * ZOOM, transform: `scale(${ZOOM})` }}>
          <Zoomed card={SAMPLE} spots={spots} errata={errata} />
        </div>
        <div className="loupe-lens-glare" />
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

const SAMPLE = { name: '霓虹龙', rarity: 'SR', style: 'standard', tags: [], serialNo: null };
const one = (kind: DetailKind, size = 34): Spot[] => [{ kind, x: 50, y: 45, rot: 20, size }];

/** 假卡识别手册（道具浮窗）：真卡和各种破绽、品相、错版的放大对照，用同一套细节贴图拼 */
export function FakeGuide({ onClose }: { onClose: () => void }) {
  const pages: Array<{ title: string; note: string; good: StaticLensProps; bad: StaticLensProps[] }> = [
    {
      title: '油墨和套色',
      note: '真卡的网点细而均匀。假卡常见油墨晕开成一团，或者几种颜色没对齐、边上冒出彩色细边。',
      good: { spots: [], fx: 50, fy: 45, label: '真卡：网点清楚' },
      bad: [{ spots: one('ink'), fx: 50, fy: 45, label: '油墨晕开' }, { spots: one('misregister'), fx: 50, fy: 45, label: '套色错位' }],
    },
    {
      title: '防伪闪光和边框',
      note: '真卡的防伪闪光是细碎的、角度一变就变色。假卡的闪光是一整块死板的彩虹，或者边框印歪了。',
      good: { spots: [], fx: 50, fy: 45, label: '真卡' },
      bad: [{ spots: one('holo'), fx: 50, fy: 45, label: '闪光不对' }, { spots: one('border', 40), fx: 50, fy: 45, label: '边框歪了' }],
    },
    {
      title: '品相（不是假卡）',
      note: '划痕、灰尘、边角磨损说明品相差，不代表是假的。放大镜会估一个两档的范围，9 分以上才值得送评。',
      good: { spots: [], fx: 50, fy: 45, label: '9–10 分：干净' },
      bad: [
        { spots: [{ kind: 'scratch', x: 40, y: 40, rot: 30, size: 30 }, { kind: 'scratch', x: 60, y: 55, rot: 120, size: 26 }], fx: 50, fy: 48, label: '7–8 分：有划痕' },
        { spots: [{ kind: 'scratch', x: 45, y: 40, rot: 10, size: 34 }, { kind: 'scratch', x: 55, y: 52, rot: 70, size: 30 }, { kind: 'dust', x: 50, y: 46, rot: 0, size: 14 }, { kind: 'dust', x: 40, y: 55, rot: 0, size: 10 }], fx: 48, fy: 48, label: '1–3 分：又划又脏' },
      ],
    },
    {
      title: '错版（值钱！）',
      note: '错版是印刷厂出错的真卡：整张印了两次（有重影），或者某块颜色漏印。送评被认定后价格翻好几倍。',
      good: { spots: [], fx: 50, fy: 45, label: '正常' },
      bad: [{ spots: [], errata: true, fx: 50, fy: 40, label: '重影' }, { spots: one('gap', 30), fx: 50, fy: 45, label: '漏印' }],
    },
  ];
  return (
    <FloatWindow id="fake-guide" className="float-guide" title="📕 假卡识别手册" onClose={onClose}>
      <p className="hint float-sub">拿放大镜看卡时对照着看。高仿的破绽很小，放大镜也可能漏看。</p>
      {pages.map((p) => (
        <section key={p.title} className="guide-section">
          <h3>{p.title}</h3>
          <div className="guide-row">
            <StaticLens {...p.good} />
            {p.bad.map((b) => <StaticLens key={b.label} {...b} />)}
          </div>
          <p className="hint">{p.note}</p>
        </section>
      ))}
    </FloatWindow>
  );
}

type StaticLensProps = { spots: Spot[]; errata?: boolean; fx: number; fy: number; label: string };
