// npm run art:check：按 docs/ART.md"验收"检查 packages/client/public/art/ 里的图。
// 不加依赖：自己读 WebP / PNG 的文件头拿尺寸和透明通道。有错误时退出码 1。
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOMER_TYPES } from '@kanu/shared/balance';

const ROOT = path.resolve(import.meta.dirname, '..');
const ART = path.join(ROOT, 'packages/client/public/art');
const SERIES_DIR = path.join(ROOT, 'packages/server/content/series');

const KB = 1024;
const LIMIT = { scene: 300 * KB, other: 150 * KB };
const STYLES = ['standard', 'holo', 'ice', 'gold', 'dark', 'serial'];
const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'MR'];
const LOUPE = ['halftone', 'ink', 'misregister', 'holo', 'border', 'scratch', 'dust', 'gap'];
const CONTACTS = ['adeng', 'glasses', 'courier7', 'operator0', 'tam'];

const series = fs.readdirSync(SERIES_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(SERIES_DIR, f), 'utf8')) as { id: string; cards: Array<{ id: string }> });
const cardIds = new Set(series.flatMap((s) => s.cards.map((c) => c.id)));
const seriesIds = series.map((s) => s.id);

interface Info { width: number; height: number; alpha: boolean; format: 'webp' | 'png' }

/** 读文件头：PNG 看 IHDR 和 tRNS；WebP 看 VP8X / VP8L / VP8 */
export function readImage(buf: Buffer): Info | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const colorType = buf[25]!;
    const alpha = colorType === 4 || colorType === 6 || buf.includes(Buffer.from('tRNS'));
    return { width, height, alpha, format: 'png' };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const flags = buf[20]!;
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, alpha: (flags & 0x10) !== 0, format: 'webp' };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), alpha: ((bits >> 28) & 1) === 1, format: 'webp' };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, alpha: false, format: 'webp' };
    }
  }
  return null;
}

type Rule = { dims?: [number, number]; square?: boolean; landscape?: boolean; portrait?: boolean; minDims?: [number, number]; alpha?: boolean; limit?: number };

/** 按目录和文件名决定规则；返回 null 表示名字不对 */
function ruleFor(dir: string, name: string): { rule: Rule; key: string } | string {
  const base = name.replace(/\.(webp|png)$/, '');
  switch (dir) {
    case 'cards':
      if (base === 'back') return { key: 'cards/back', rule: { dims: [630, 880] } };
      return cardIds.has(base) ? { key: `cards/${base}`, rule: { dims: [630, 880] } } : `卡编号 ${base} 不在 content/series 里`;
    case 'frames': return STYLES.includes(base) ? { key: `frames/${base}`, rule: { dims: [630, 880], alpha: true } } : `卡框名只能是 ${STYLES.join(' ')}`;
    case 'rarity': return RARITIES.includes(base) ? { key: `rarity/${base}`, rule: { square: true, alpha: true } } : `稀有度只能是 ${RARITIES.join(' ')}`;
    case 'packs': {
      const m = /^([A-Z]+)(-box)?$/.exec(base);
      return m && seriesIds.includes(m[1]!) ? { key: `packs/${base}`, rule: { portrait: !m[2] } } : `卡包名要是 <系列编号> 或 <系列编号>-box，系列编号：${seriesIds.join(' ')}`;
    }
    case 'customers': {
      const m = /^([a-z]+)-([1-3])$/.exec(base);
      return m && (CUSTOMER_TYPES as readonly string[]).includes(m[1]!) ? { key: `customers/${base}`, rule: { dims: [256, 256] } } : `顾客头像要是 <类型>-<1~3>，类型：${CUSTOMER_TYPES.join(' ')}`;
    }
    case 'contacts': return CONTACTS.includes(base) ? { key: `contacts/${base}`, rule: { dims: [256, 256] } } : `联系人 id 只能是 ${CONTACTS.join(' ')}`;
    case 'loupe': return LOUPE.includes(base) ? { key: `loupe/${base}`, rule: { dims: [256, 256], alpha: true } } : `放大镜细节只能是 ${LOUPE.join(' ')}`;
    case 'wear': return ['1', '2', '3'].includes(base) ? { key: `wear/${base}`, rule: { dims: [630, 880], alpha: true } } : '磨损只能是 1 2 3';
    case 'scenes': return /^[a-z0-9-]+$/.test(base) ? { key: `scenes/${base}`, rule: { landscape: true, minDims: [1920, 1080], limit: LIMIT.scene } } : '文件名用小写英文、数字、短横线';
    case 'brand':
      return /^[a-z0-9-]+$/.test(base) ? { key: `brand/${base}`, rule: { limit: 600 * KB } } : '文件名用小写英文、数字、短横线';
    case 'ui': case 'items': case 'binders': case 'collection': case 'showcase': case 'tech': case 'logos':
      return /^[a-z0-9-]+$/.test(base) ? { key: `${dir}/${base}`, rule: { alpha: dir === 'ui' || dir === 'items' || dir === 'tech' || dir === 'logos' } } : '文件名用小写英文、数字、短横线';
    default: return `不认识的目录 art/${dir}/`;
  }
}

function main() {
  const errors: string[] = [];
  const found = new Set<string>();
  if (!fs.existsSync(ART)) {
    console.log('packages/client/public/art/ 还没有，什么都没检查。');
    return;
  }
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(ART)) {
    const rel = path.relative(ART, file).replace(/\\/g, '/');
    const parts = rel.split('/');
    if (parts[parts.length - 1]!.startsWith('.')) continue;
    if (parts.length !== 2) { errors.push(`${rel}：要放在 art/<类别>/ 下面一层`); continue; }
    const [dir, name] = parts as [string, string];
    if (!/\.(webp|png)$/.test(name)) { errors.push(`${rel}：只收 .webp 和 .png`); continue; }
    const r = ruleFor(dir, name);
    if (typeof r === 'string') { errors.push(`${rel}：${r}`); continue; }
    if (found.has(r.key)) { errors.push(`${rel}：同名的 .webp 和 .png 只能留一个`); continue; }
    found.add(r.key);
    const buf = fs.readFileSync(file);
    const info = readImage(buf);
    if (!info) { errors.push(`${rel}：读不出图片格式（文件坏了，或者扩展名和内容不符）`); continue; }
    if (info.format !== name.split('.').pop()) errors.push(`${rel}：扩展名是 .${name.split('.').pop()}，内容其实是 ${info.format}`);
    const { rule } = r;
    const limit = rule.limit ?? LIMIT.other;
    if (buf.length > limit) errors.push(`${rel}：${Math.ceil(buf.length / KB)} KB，超过 ${limit / KB} KB`);
    const size = `${info.width} × ${info.height}`;
    if (rule.dims && (info.width !== rule.dims[0] || info.height !== rule.dims[1])) errors.push(`${rel}：${size}，要 ${rule.dims[0]} × ${rule.dims[1]}`);
    if (rule.square && info.width !== info.height) errors.push(`${rel}：${size}，要正方形`);
    if (rule.portrait && info.height <= info.width) errors.push(`${rel}：${size}，要竖版`);
    if (rule.landscape && info.width <= info.height) errors.push(`${rel}：${size}，要横版`);
    if (rule.minDims && (info.width < rule.minDims[0] || info.height < rule.minDims[1])) errors.push(`${rel}：${size}，至少 ${rule.minDims[0]} × ${rule.minDims[1]}`);
    if (rule.alpha && !info.alpha) errors.push(`${rel}：要带透明通道`);
  }

  // 进度：MVP 要的几类各到了多少
  const count = (prefix: string) => [...found].filter((k) => k.startsWith(prefix)).length;
  const cardFaces = [...found].filter((k) => k.startsWith('cards/') && k !== 'cards/back').length;
  console.log('美术进度（MVP）');
  console.log(`  卡面        ${cardFaces} / ${cardIds.size}`);
  console.log(`  卡背        ${found.has('cards/back') ? 1 : 0} / 1`);
  console.log(`  卡框        ${count('frames/')} / ${STYLES.length}（MVP 先要 standard holo ice gold）`);
  console.log(`  稀有度角标  ${count('rarity/')} / ${RARITIES.length}`);
  console.log(`  卡包包装    ${[...found].filter((k) => /^packs\/[A-Z]+$/.test(k)).length} / ${seriesIds.length}，整盒 ${[...found].filter((k) => k.endsWith('-box')).length} / ${seriesIds.length}`);
  console.log(`  顾客头像    ${count('customers/')}（${CUSTOMER_TYPES.length} 类，每类 1–3 个）`);
  console.log(`  联系人      ${count('contacts/')} / ${CONTACTS.length}`);
  console.log(`  放大镜细节  ${count('loupe/')} / ${LOUPE.length}`);
  console.log(`  磨损        ${count('wear/')} / 3`);
  if (errors.length) {
    console.log(`\n有 ${errors.length} 个问题：`);
    for (const e of errors) console.log(`  ✗ ${e}`);
    process.exitCode = 1;
  } else {
    console.log('\n没有问题 ✓');
  }
}

main();
