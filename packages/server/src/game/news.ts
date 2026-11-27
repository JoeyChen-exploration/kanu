// 新闻（DESIGN 8.2）：纯函数。抽一条日报、算今天生效的效果。随机源由调用方传入。
import { NEWS } from '@kanu/shared/balance';
import { between, chance, pickPpm, type Rng } from './rng.ts';

export type NewsKind = 'price_up' | 'price_down' | 'demand' | 'police';
export const NEWS_KINDS: NewsKind[] = ['price_up', 'price_down', 'demand', 'police'];
export interface NewsTemplate { id: string; kind: NewsKind; title: string; body: string }

export interface RolledNews {
  templateId: string;
  kind: NewsKind;
  /** 系列编号（price_*）、标签（demand）；police 是 null */
  target: string | null;
  title: string;
  body: string;
  source: 'official' | 'rumor';
  /** 隐藏：假新闻没有效果 */
  real: boolean;
  mult: number;
  days: number;
}

const fill = (s: string, target: string) => s.replaceAll('{series}', target).replaceAll('{tag}', target);

/** 选好模板和对象后定数值和真假；opts 里给了就用给的（管理员手动发新闻） */
export function rollNews(rng: Rng, input: {
  templates: NewsTemplate[];
  series: Array<{ id: string; name: string }>;
  tags: string[];
  /** 管理员指定 */
  templateId?: string;
  target?: string;
  real?: boolean;
  source?: 'official' | 'rumor';
}): RolledNews {
  let tpl: NewsTemplate;
  if (input.templateId) {
    const t = input.templates.find((x) => x.id === input.templateId);
    if (!t) throw new Error(`没有新闻模板 ${input.templateId}`);
    tpl = t;
  } else {
    const kind = pickPpm(rng, NEWS_KINDS, (k) => NEWS.kindPpm[k]);
    const pool = input.templates.filter((t) => t.kind === kind);
    tpl = pool[rng.int(pool.length)]!;
  }
  let target: string | null = null;
  let name = '';
  if (tpl.kind === 'price_up' || tpl.kind === 'price_down') {
    const s = input.target ? input.series.find((x) => x.id === input.target) : input.series[rng.int(input.series.length)];
    if (!s) throw new Error(`没有系列 ${input.target}`);
    target = s.id;
    name = s.name;
  } else if (tpl.kind === 'demand') {
    const tag = input.target ?? input.tags[rng.int(input.tags.length)];
    if (!tag || !input.tags.includes(tag)) throw new Error(`没有标签 ${input.target}`);
    target = tag;
    name = tag;
  }
  const range = tpl.kind === 'price_up' ? NEWS.priceUp : tpl.kind === 'price_down' ? NEWS.priceDown : null;
  const mult = range ? Math.round(between(rng, range[0], range[1]) * 100) / 100 : tpl.kind === 'police' ? NEWS.policeMult : 1;
  const days = NEWS.days[0] + rng.int(NEWS.days[1] - NEWS.days[0] + 1);
  const source = input.source ?? (chance(rng, NEWS.rumorPpm) ? 'rumor' : 'official');
  const real = input.real ?? (source === 'official' || !chance(rng, NEWS.rumorFakePpm));
  return { templateId: tpl.id, kind: tpl.kind, target, title: fill(tpl.title, name), body: fill(tpl.body, name), source, real, mult, days };
}

export interface NewsEffectInput { kind: string; target: string | null; mult: number }

/** 今天生效的真新闻合起来的效果：同一系列的价格倍数相乘，巡查倍数取最大 */
export function newsEffects(rows: NewsEffectInput[]) {
  const seriesMult: Record<string, number> = {};
  const hotTags: string[] = [];
  let policeMult = 1;
  for (const r of rows) {
    if ((r.kind === 'price_up' || r.kind === 'price_down') && r.target) seriesMult[r.target] = Math.round((seriesMult[r.target] ?? 1) * r.mult * 100) / 100;
    else if (r.kind === 'demand' && r.target && !hotTags.includes(r.target)) hotTags.push(r.target);
    else if (r.kind === 'police') policeMult = Math.max(policeMult, r.mult);
  }
  return { seriesMult, hotTags, policeMult };
}
