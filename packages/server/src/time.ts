// "每天"一律按悉尼日（CLAUDE.md 第 6 条，和旺财钱包一致）。
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 悉尼日历日，'YYYY-MM-DD' */
export const sydneyDay = (now: number) => dayFmt.format(new Date(now));

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 悉尼时间的小时（含分钟的小数，如 13.5 = 13:30） */
export function sydneyHour(now: number): number {
  const [h, m] = hourFmt.format(new Date(now)).split(':').map(Number);
  return h! + m! / 60;
}

/** 今天悉尼时间 hour 点整的时间戳（精确到分钟）；已经过了返回 null */
export function todaySydneyHourAt(now: number, hour: number): number | null {
  const diff = (hour - sydneyHour(now)) * 3600e3;
  if (diff <= 0) return null;
  // sydneyHour 只精确到分钟，now 里多出来的秒数用 floor 去掉
  return Math.floor((now + diff) / 60e3) * 60e3;
}
