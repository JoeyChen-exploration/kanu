// npm run art:import：把网盘同步过来的原图（ART_RAW_DIR）转成游戏用的图，放进 packages/client/public/art/。
// 原图目录结构和文件名跟 public/art/ 一一对应，只是扩展名是 .png：cards/NEO-01.png → art/cards/NEO-01.webp。
// 按 docs/ART.md 的规格处理：卡面居中裁成 63:88 再缩到 630 × 880；头像、联系人 256 × 256；场景 1920 × 1080。
// WebP 质量从 85 往下试，直到满足体积上限（场景 300 KB，其余 150 KB）。只处理新增或改过的（比较修改时间）。
// ART_RAW_DIR 里的 prompts.csv 复制到 art-src/prompts.csv（进 git）；原图本身不进 git。处理完自动跑 art:check。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'packages/client/public/art');
const KB = 1024;
/** 认识的类别目录（和 scripts/art-check.ts 一致） */
const DIRS = ['cards', 'frames', 'rarity', 'packs', 'customers', 'contacts', 'loupe', 'wear', 'scenes', 'ui', 'items', 'binders', 'collection', 'showcase', 'tech', 'logos', 'brand'];

/** 从环境变量或仓库根目录的 .env 读 ART_RAW_DIR */
function rawDir() {
  if (process.env.ART_RAW_DIR) return process.env.ART_RAW_DIR;
  const env = path.join(ROOT, '.env');
  if (fs.existsSync(env)) {
    const m = /^ART_RAW_DIR=(.*)$/m.exec(fs.readFileSync(env, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** 每类图怎么处理：resize（cover = 居中裁切后缩放；inside = 等比缩小不放大）和体积上限 */
function specFor(rel) {
  const [dir, file] = rel.split('/');
  const base = file.replace(/\.png$/i, '');
  if (dir === 'cards' && base !== 'back') return { resize: { width: 630, height: 880, fit: 'cover' }, limit: 150 * KB };
  if (dir === 'cards' || dir === 'frames' || dir === 'wear') return { resize: { width: 630, height: 880, fit: 'cover' }, limit: 150 * KB };
  if (dir === 'customers' || dir === 'contacts') return { resize: { width: 256, height: 256, fit: 'cover' }, limit: 150 * KB };
  if (dir === 'scenes') return { resize: { width: 1920, height: 1080, fit: 'cover' }, limit: 300 * KB };
  if (dir === 'packs') return { resize: { width: 630, height: 880, fit: 'inside', withoutEnlargement: true }, limit: 150 * KB };
  return { resize: { width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }, limit: 150 * KB };
}

async function convert(src, out, spec) {
  const input = sharp(src).resize({ ...spec.resize, position: 'centre' });
  for (let q = 85; q >= 40; q -= 5) {
    const buf = await input.clone().webp({ quality: q, alphaQuality: 90, effort: 6 }).toBuffer();
    if (buf.length <= spec.limit || q === 40) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      return { quality: q, size: buf.length, over: buf.length > spec.limit };
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const RAW = rawDir();
  if (!RAW) { console.error('没有设置 ART_RAW_DIR（写在 .env 里，见 .env.example）'); process.exit(1); }
  if (!fs.existsSync(RAW)) { console.error(`ART_RAW_DIR 不存在：${RAW}`); process.exit(1); }

  const prompts = path.join(RAW, 'prompts.csv');
  if (fs.existsSync(prompts)) {
    fs.copyFileSync(prompts, path.join(ROOT, 'art-src/prompts.csv'));
    console.log('prompts.csv → art-src/prompts.csv');
  }

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const added = [], updated = [], over = [], skipped = [];
  for (const src of walk(RAW)) {
    const rel = path.relative(RAW, src).replace(/\\/g, '/');
    if (!/\.png$/i.test(rel)) continue;
    if (rel.split('/').length !== 2) { skipped.push(`${rel}（要放在 <类别>/ 下面一层）`); continue; }
    if (!DIRS.includes(rel.split('/')[0])) { skipped.push(`${rel}（不认识的目录，类别见 docs/ART.md）`); continue; }
    const out = path.join(OUT, rel.replace(/\.png$/i, '.webp'));
    const exists = fs.existsSync(out);
    if (exists && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    try {
      const r = await convert(src, out, specFor(rel));
      const line = `${rel.replace(/\.png$/i, '.webp')}  质量 ${r.quality}，${Math.ceil(r.size / KB)} KB`;
      (exists ? updated : added).push(line);
      if (r.over) over.push(line);
    } catch (e) {
      skipped.push(`${rel}（${e.message}）`);
    }
  }
  const list = (title, xs) => { if (xs.length) { console.log(`\n${title}（${xs.length}）`); for (const x of xs) console.log(`  ${x}`); } };
  list('新增', added);
  list('更新', updated);
  list('质量降到 40 还超体积上限', over);
  list('没处理', skipped);
  if (!added.length && !updated.length) console.log('\n没有新增或改过的原图。');
  console.log('');
  try { execSync('npx tsx scripts/art-check.ts', { cwd: ROOT, stdio: 'inherit' }); } catch { process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
