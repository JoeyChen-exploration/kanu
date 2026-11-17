// "每天"一律按悉尼日（CLAUDE.md 第 6 条，和旺财钱包一致）。
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 悉尼日历日，'YYYY-MM-DD' */
export const sydneyDay = (now: number) => dayFmt.format(new Date(now));
