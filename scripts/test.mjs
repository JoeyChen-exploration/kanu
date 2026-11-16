// 跑 vitest。Windows 上从小写盘符（d:\）启动时，vitest 会被当成两个模块加载而报
// "failed to find the current suite"，所以先切到真实路径（大写盘符）再跑。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const cwd = fs.realpathSync.native(process.cwd());
const r = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
