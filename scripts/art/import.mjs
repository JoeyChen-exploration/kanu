// npm run art:import：把网盘同步过来的原图（ART_RAW_DIR）转成游戏用的图，放进 packages/client/public/art/。
// 原图目录结构和文件名跟 public/art/ 一一对应，只是扩展名是 .png：cards/NEO-01.png → art/cards/NEO-01.webp。
// 按 docs/ART.md 的规格处理：卡面居中裁成 63:88 再缩到 630 × 880；头像、联系人 256 × 256；场景 1920 × 1080。
// WebP 质量从 85 往下试，直到满足体积上限（场景 300 KB，其余 150 KB）。只处理新增或改过的（比较修改时间）。
// 每张原图自带的生成参数（Draw Things 写在 PNG 的 XMP 里）自动写进 art-src/prompts.csv（进 git），原图目录里手记的 prompts.csv 也合进去；
// 原图本身不进 git。处理完自动跑 art:check。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'packages/client/public/art');
const KB = 1024;
/** 认识的类别目录（和 scripts/art-check.ts 一致） */
/** 代码生成的卡面（scripts/art/build.mjs），原图目录里就算有同名文件也不导入，免得覆盖 */
const CODE_ONLY = new Set(['cards/GNG-01.png']);
const DIRS = ['cards', 'frames', 'rarity', 'slab', 'packs', 'customers', 'contacts', 'loupe', 'wear', 'scenes', 'ui', 'items', 'binders', 'collection', 'showcase', 'tech', 'logos'];

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

// ---------------- 生成参数：从 PNG 的文本元数据读（Draw Things 写在 XMP 里，A1111 类工具写在 tEXt parameters 里） ----------------
const CSV_HEAD = ['file', 'model', 'prompt', 'negative', 'seed', 'steps', 'size', 'date'];

/** PNG 里所有 tEXt / zTXt / iTXt 文本块：{ 关键字: 内容 } */
function pngTexts(buf) {
  const out = {};
  if (buf.readUInt32BE(0) !== 0x89504e47) return out;
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const z = d.indexOf(0);
      const key = d.toString('latin1', 0, z);
      try {
        if (type === 'tEXt') out[key] = d.toString('latin1', z + 1);
        else if (type === 'zTXt') out[key] = zlib.inflateSync(d.subarray(z + 2)).toString('utf8');
        else {
          const compressed = d[z + 1] === 1;
          let p = d.indexOf(0, z + 3) + 1; // 跳过语言标签
          p = d.indexOf(0, p) + 1; // 跳过翻译后的关键字
          out[key] = compressed ? zlib.inflateSync(d.subarray(p)).toString('utf8') : d.subarray(p).toString('utf8');
        }
      } catch { /* 坏块跳过 */ }
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

const unxml = (s) => s.replace(/&#xA;/gi, '\n').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** "提示词\n-负面\nSteps: 16, Seed: …, Size: …, Model: …"（Draw Things 的 dc:description，和 A1111 的 parameters 差不多） */
function parseParamText(text) {
  const lines = text.split('\n');
  const tail = lines.findIndex((l) => /^Steps:\s*\d+/.test(l));
  const head = tail >= 0 ? lines.slice(0, tail) : lines;
  const kv = Object.fromEntries((tail >= 0 ? lines[tail] : '').split(/,\s*/).map((x) => x.split(/:\s*/)).filter((x) => x.length >= 2).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
  const negIdx = head.findIndex((l) => /^-|^Negative prompt:/i.test(l));
  const prompt = (negIdx >= 0 ? head.slice(0, negIdx) : head).join('\n').trim();
  const negative = negIdx >= 0 ? head.slice(negIdx).join('\n').replace(/^-|^Negative prompt:\s*/i, '').trim() : '';
  return { model: kv.Model ?? '', prompt, negative, seed: kv.Seed ?? '', steps: kv.Steps ?? '', size: kv.Size ?? '' };
}

/** 读一张原图的生成参数；读不出来返回 null */
export function readGenParams(buf) {
  const t = pngTexts(buf);
  const xmp = t['XML:com.adobe.xmp'];
  if (xmp) {
    const uc = /<exif:UserComment>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
    if (uc) {
      try {
        const j = JSON.parse(unxml(uc[1]));
        return { model: j.model ?? '', prompt: j.c ?? '', negative: j.uc ?? '', seed: String(j.seed ?? ''), steps: String(j.steps ?? ''), size: j.size ?? '' };
      } catch { /* 不是 JSON 就看文字版 */ }
    }
    const desc = /<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
    if (desc) return parseParamText(unxml(desc[1]));
  }
  if (t.parameters) return parseParamText(t.parameters);
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}
const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/** 读 CSV 成 Map(file → 行对象)；表头不对的文件当空 */
function readPrompts(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const head = rows.shift() ?? [];
  for (const r of rows) {
    const o = Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? '']));
    if (o.file) map.set(o.file, o);
  }
  return map;
}
function writePrompts(file, map) {
  const lines = [CSV_HEAD.join(','), ...[...map.values()].sort((a, b) => a.file.localeCompare(b.file)).map((o) => CSV_HEAD.map((h) => csvCell(o[h] ?? '')).join(','))];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

async function main() {
  const RAW = rawDir();
  if (!RAW) { console.error('没有设置 ART_RAW_DIR（写在 .env 里，见 .env.example）'); process.exit(1); }
  if (!fs.existsSync(RAW)) { console.error(`ART_RAW_DIR 不存在：${RAW}`); process.exit(1); }

  // 提示词表：仓库里已有的 + 原图目录手记的 prompts.csv，再用每张原图自带的生成参数补全 / 覆盖
  const PROMPTS = path.join(ROOT, 'art-src/prompts.csv');
  const prompts = readPrompts(PROMPTS);
  for (const [k, v] of readPrompts(path.join(RAW, 'prompts.csv'))) prompts.set(k, { ...prompts.get(k), ...v });
  const fromMeta = [];
  const noMeta = [];

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const added = [], updated = [], over = [], skipped = [];
  for (const src of walk(RAW)) {
    const rel = path.relative(RAW, src).replace(/\\/g, '/');
    if (!/\.png$/i.test(rel)) continue;
    // 根目录的文件（prompts.csv、card-prompts.csv、README.txt、icon-1024.png……）不是要导入的原图，不处理也不报错
    if (rel.split('/').length === 1) continue;
    if (rel.split('/').length !== 2) { skipped.push(`${rel}（要放在 <类别>/ 下面一层）`); continue; }
    if (CODE_ONLY.has(rel)) { skipped.push(`${rel}（这张卡面是代码生成的，见 scripts/art/build.mjs，不导入）`); continue; }
    if (!DIRS.includes(rel.split('/')[0])) { skipped.push(`${rel}（不认识的目录，类别见 docs/ART.md）`); continue; }
    const out = path.join(OUT, rel.replace(/\.png$/i, '.webp'));
    const exists = fs.existsSync(out);
    const stale = !exists || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
    // 新图、改过的图、表里还没有的图：读生成参数写进提示词表
    if (stale || !prompts.has(rel)) {
      const meta = readGenParams(fs.readFileSync(src));
      if (meta) {
        prompts.set(rel, { file: rel, ...meta, date: new Date(fs.statSync(src).mtimeMs).toISOString().slice(0, 10) });
        fromMeta.push(rel);
      } else if (!prompts.has(rel)) noMeta.push(rel);
    }
    if (!stale) continue;
    try {
      const r = await convert(src, out, specFor(rel));
      const line = `${rel.replace(/\.png$/i, '.webp')}  质量 ${r.quality}，${Math.ceil(r.size / KB)} KB`;
      (exists ? updated : added).push(line);
      if (r.over) over.push(line);
    } catch (e) {
      skipped.push(`${rel}（${e.message}）`);
    }
  }
  writePrompts(PROMPTS, prompts);
  const list = (title, xs) => { if (xs.length) { console.log(`\n${title}（${xs.length}）`); for (const x of xs) console.log(`  ${x}`); } };
  list('从原图读到生成参数，写进 art-src/prompts.csv', fromMeta);
  list('原图里没有生成参数，prompts.csv 里也没记（请手动补）', noMeta);
  list('新增', added);
  list('更新', updated);
  list('质量降到 40 还超体积上限', over);
  list('没处理', skipped);
  if (!added.length && !updated.length) console.log('\n没有新增或改过的原图。');
  console.log('');
  try { execSync('npx tsx scripts/art-check.ts', { cwd: ROOT, stdio: 'inherit' }); } catch { process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
