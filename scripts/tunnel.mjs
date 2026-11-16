// 开发隧道：cloudflared 把本机 Vite（5173）暴露成 https://*.trycloudflare.com，填进 Developer Portal 的 URL Mapping。
// 刚装完 cloudflared、终端还没重开时 PATH 里找不到它，这里再去默认安装位置找一次。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const candidates = [
  'cloudflared',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
];
const bin = candidates.find((c) => (c.includes('\\') ? fs.existsSync(c) : spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0));
if (!bin) {
  console.error('找不到 cloudflared。Windows 上装：winget install --id Cloudflare.cloudflared，装完重开终端。');
  process.exit(1);
}

const port = process.env.VITE_PORT || 5173;
console.log(`用 ${bin} 开隧道 → http://localhost:${port}`);
console.log('看到 https://xxxx.trycloudflare.com 后，把 xxxx.trycloudflare.com（不带 https://）填进 URL Mapping 的根路径 /。每次重开地址都会变。\n');
const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
