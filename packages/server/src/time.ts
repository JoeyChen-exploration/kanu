// 现实时间只剩少数地方要用（金币兑换的每周上限、幂等记录过期）；营业日由玩家自己推进，见 db/index.ts 的 dayKey。
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 悉尼日历日，'YYYY-MM-DD' */
export const sydneyDay = (now: number) => dayFmt.format(new Date(now));

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', hourCycle: 'h23' });
/** 悉尼时间几点（0–23） */
export const sydneyHour = (now: number) => Number(hourFmt.format(new Date(now)));

const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', weekday: 'short' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 'YYYY-MM-DD' 加 n 天（纯字符串算，不受本机时区影响） */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 悉尼时间这周周一的日期：金币兑换的每周上限从周一 00:00 起算（和旺财 walletWeek 同一个口径） */
export const sydneyWeek = (now: number) => addDays(sydneyDay(now), -WEEKDAYS.indexOf(weekdayFmt.format(new Date(now))));
