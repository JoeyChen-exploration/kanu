// 美术接入（docs/ART.md）：图片放在 packages/client/public/art/，按名字找。
// 缺图时回退到现在代码画的占位，不报错——美术可以一张一张地放进去。
// 加载失败过的地址记在内存里，同一次打开不会反复请求。
import { useState, type ReactNode } from 'react';

const missing = new Set<string>();

/** 依次试 srcs 里的图，第一张能加载的就显示；都没有就显示 fallback */
export function ArtImg({ srcs, fallback, className, alt = '' }: { srcs: string[]; fallback: ReactNode; className?: string; alt?: string }) {
  const [, bump] = useState(0);
  const src = srcs.find((s) => !missing.has(s));
  if (!src) return <>{fallback}</>;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      draggable={false}
      onError={() => { missing.add(src); bump((n) => n + 1); }}
    />
  );
}

/** 各类图的路径（和 docs/ART.md "做好的图放在哪"一致） */
export const ART = {
  card: (templateId: string) => `/art/cards/${templateId}.webp`,
  frame: (style: string) => `/art/frames/${style}.webp`,
  rarity: (rarity: string) => `/art/rarity/${rarity}.webp`,
  cardBack: '/art/cards/back.webp',
  pack: (seriesId: string) => `/art/packs/${seriesId}.webp`,
  box: (seriesId: string) => `/art/packs/${seriesId}-box.webp`,
  customer: (type: string, n: number) => `/art/customers/${type}-${n}.webp`,
  contact: (id: string) => `/art/contacts/${id}.webp`,
};

/** 卡包包装：有图显示图，没图显示现在的色块 + 系列名前两个字 */
export function PackArt({ seriesId, name, kind, small, box, className = '' }: { seriesId?: string; name: string; kind?: string; small?: boolean; box?: boolean; className?: string }) {
  const placeholder = <div className={`pack-art${small ? ' small' : ''}${kind ? ` kind-${kind}` : ''} ${className}`} aria-hidden>{name.slice(0, 2)}</div>;
  if (!seriesId) return placeholder;
  const srcs = box ? [ART.box(seriesId), ART.pack(seriesId)] : [ART.pack(seriesId)];
  return <ArtImg srcs={srcs} className={`pack-art pack-img${small ? ' small' : ''} ${className}`} fallback={placeholder} />;
}

/** 顾客头像：每类 1–3 个变体，按顾客 id 挑一个；没有这个变体就用 1 号；都没有显示 emoji */
export function CustomerAvatar({ type, id, emoji, className = 'visitor-avatar' }: { type: string; id?: number; emoji: string; className?: string }) {
  const n = id ? (id % 3) + 1 : 1;
  const srcs = n === 1 ? [ART.customer(type, 1)] : [ART.customer(type, n), ART.customer(type, 1)];
  return <ArtImg srcs={srcs} className={`${className} avatar-img`} fallback={<span className={className} aria-hidden>{emoji}</span>} />;
}
