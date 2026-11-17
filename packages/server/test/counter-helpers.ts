// 柜台测试用的常量：MVP 里会出现的顾客类型（和 balance.ts 的 mvp 标记对上）。
export { COUNTER, CUSTOMER, PACKS, PLAYER, REPUTATION } from '@kanu/shared/balance';
import { CUSTOMER, CUSTOMER_TYPES } from '@kanu/shared/balance';

export const MVP_TYPES_CHECK = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);
