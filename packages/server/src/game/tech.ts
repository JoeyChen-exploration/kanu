// 科技树（docs/TECH-TREE.md）：纯函数，读 balance.TECH_NODES 算效果和能不能买。不碰数据库、不读时钟。
import { APPRAISAL, MIDDLEMAN, POLICE, TECH_NODES, WHOLESALE, type QuestMetric, type TechCondition, type TechNode } from '@kanu/shared/balance';

export interface TechEffects {
  patience: number;
  customersPerDay: number;
  errataDetectPpm: number;
  storePacksPerDay: number;
  showcaseSlots: number;
  wholesaleDiscount: number;
  /** 每位客人换成卡贩的概率（ppm），0 = 没点 G2 */
  dealerPpm: number;
  /** S2：每 7 个营业日信誉 +weeklyRep，涨到 weeklyRepCap 为止 */
  weeklyRep: number;
  weeklyRepCap: number;
  /** S3a：巡查来的概率倍数；卖真卡涨信誉（每天最多 honestRepPerDay 次） */
  patrolMult: number;
  honestRep: number;
  honestRepPerDay: number;
  /** S3b / S4b：藏匿室格数（0 = 没有）、里面的赃卡被查出的概率 */
  hideoutSlots: number;
  hideoutDetectPpm: number;
  /** S3b：中间人按基准价的多少收 */
  middlemanPct: number;
  /** S4a：每周第一次被查出赃卡交出不扣信誉 */
  patrolWaiver: boolean;
}

/** 已点的节点合起来的效果：加法的相加，"换成某个值"的取最好的那个 */
export function techEffects(owned: Iterable<string>): TechEffects {
  const fx: TechEffects = { patience: 0, customersPerDay: 0, errataDetectPpm: APPRAISAL.errataDetect, storePacksPerDay: 0, showcaseSlots: 0, wholesaleDiscount: WHOLESALE.discount, dealerPpm: 0,
    weeklyRep: 0, weeklyRepCap: 0, patrolMult: 1, honestRep: 0, honestRepPerDay: 0, hideoutSlots: 0, hideoutDetectPpm: POLICE.detectPpm, middlemanPct: MIDDLEMAN.basePct, patrolWaiver: false };
  const ids = new Set(owned);
  for (const node of TECH_NODES) {
    if (!ids.has(node.id)) continue;
    for (const e of node.effects) {
      if (e.kind === 'patience') fx.patience += e.delta;
      else if (e.kind === 'customersPerDay') fx.customersPerDay += e.delta;
      else if (e.kind === 'storePacksPerDay') fx.storePacksPerDay += e.delta;
      else if (e.kind === 'showcaseSlots') fx.showcaseSlots += e.delta;
      else if (e.kind === 'errataDetectPpm') fx.errataDetectPpm = Math.max(fx.errataDetectPpm, e.value);
      else if (e.kind === 'wholesaleDiscount') fx.wholesaleDiscount = Math.min(fx.wholesaleDiscount, e.value);
      else if (e.kind === 'dealerPpm') fx.dealerPpm = Math.max(fx.dealerPpm, e.value);
      else if (e.kind === 'weeklyRep') { fx.weeklyRep += e.delta; fx.weeklyRepCap = Math.max(fx.weeklyRepCap, e.cap); }
      else if (e.kind === 'patrolMult') fx.patrolMult *= e.value;
      else if (e.kind === 'honestRep') { fx.honestRep += e.delta; fx.honestRepPerDay = Math.max(fx.honestRepPerDay, e.perDay); }
      else if (e.kind === 'hideout') { fx.hideoutSlots = Math.max(fx.hideoutSlots, e.slots); fx.hideoutDetectPpm = Math.min(fx.hideoutDetectPpm, e.detectPpm); }
      else if (e.kind === 'middlemanPct') fx.middlemanPct = Math.max(fx.middlemanPct, e.value);
      else if (e.kind === 'patrolWaiver') fx.patrolWaiver = true;
    }
  }
  return fx;
}

export const METRIC_NAMES: Record<QuestMetric, string> = {
  packsBought: '订货次数', packsOpened: '开包', sales: '成交', daysEnded: '打烊', collected: '图鉴点亮',
  showcaseLevel: '珍藏柜等级', showcaseCards: '珍藏柜展品', binders: '卡册', rentPaid: '按时交租', middlemanSales: '中间人成交', inspections: '放大镜查验',
};

export interface ConditionCheck { text: string; current: number; target: number; met: boolean }

export function checkCondition(c: TechCondition, ctx: { stats: Record<QuestMetric, number>; reputation: number }): ConditionCheck {
  if (c.kind === 'reputation') return { text: `信誉 ≥ ${c.min}`, current: ctx.reputation, target: c.min, met: ctx.reputation >= c.min };
  const current = ctx.stats[c.metric];
  return { text: `${METRIC_NAMES[c.metric]} ${c.target} 次`, current: Math.min(current, c.target), target: c.target, met: current >= c.target };
}

export type BuyBlock = 'owned' | 'soon' | 'exclusive' | 'requires' | 'conditions' | null;

/** 不看钱：节点本身能不能点（已点过 / 还没开放 / 二选一点了另一个 / 前置没点 / 额外条件没满足） */
export function techBlock(node: TechNode, owned: Set<string>, ctx: { stats: Record<QuestMetric, number>; reputation: number }): BuyBlock {
  if (owned.has(node.id)) return 'owned';
  if (node.soon) return 'soon';
  if (node.exclusive && owned.has(node.exclusive)) return 'exclusive';
  if (!node.requires.every((r) => owned.has(r))) return 'requires';
  if (node.anyOf && !node.anyOf.some((r) => owned.has(r))) return 'requires';
  if (!node.conditions.every((c) => checkCondition(c, ctx).met)) return 'conditions';
  return null;
}
