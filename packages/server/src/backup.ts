// 数据库备份（M7 内测）：better-sqlite3 在线备份，不停服、不锁库。文件名带悉尼日期和时间，备份目录里只留最近 BACKUP.keep 份。
// 恢复：停服，把要用的备份文件复制成 DB_PATH 指向的文件（连同删掉旧的 -wal / -shm），再启动。
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP } from '@kanu/shared/balance';
import { sydneyDay } from './time.ts';

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false });

export async function runBackup(repo: { backup: (file: string) => Promise<unknown> }, dir: string, now: number): Promise<{ file: string; removed: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `kanu-${sydneyDay(now)}-${hm.format(new Date(now)).replace(':', '')}.sqlite`);
  await repo.backup(file);
  // 只动自己生成的 kanu-*.sqlite，按文件名（日期时间）排序，留最近 keep 份
  const ours = fs.readdirSync(dir).filter((f) => /^kanu-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite$/.test(f)).sort();
  const removed = ours.slice(0, Math.max(0, ours.length - BACKUP.keep));
  for (const f of removed) fs.rmSync(path.join(dir, f));
  return { file, removed };
}
