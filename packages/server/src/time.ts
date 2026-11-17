// 现实时间只剩少数地方要用（金币兑换的每周上限、幂等记录过期）；营业日由玩家自己推进，见 db/index.ts 的 dayKey。
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 悉尼日历日，'YYYY-MM-DD' */
export const sydneyDay = (now: number) => dayFmt.format(new Date(now));
