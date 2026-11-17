// 鉴定结论翻成给玩家看的话（放大镜查验、送评状态）
import type { CardAppraisalResponse, InspectionView } from '@kanu/shared/types';

const gradeName = (g: string) => (g === 'BL' ? '黑标' : g);

/** 放大镜结论，一句话："看起来是真的 · 品相 8–9 · 错版！" */
export function inspectionText(i: InspectionView): string {
  return [
    i.looks === 'fake' ? '看出是假卡' : '看起来是真的',
    `品相 ${i.gradeRange.map(gradeName).join('–')}`,
    ...(i.errataFound ? ['错版！'] : []),
  ].join(' · ');
}

/** 卡牌详情里列出的鉴定情况 */
export function appraisalLines(a: CardAppraisalResponse): string[] {
  const out: string[] = [];
  if (a.inspection) out.push(`放大镜：${inspectionText(a.inspection)}`);
  if (a.grading === 'pending') out.push('星港评级社：评级中，下次打烊出结果');
  if (a.grading === 'rejected') out.push('星港评级社：拒评（疑似假卡）');
  return out;
}
