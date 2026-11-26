// npm run art:build：生成"代码"类美术素材（docs/ART.md"制作"列标为代码的）。
// 每张图先生成 SVG 存进 art-src/svg/（进 git，方便看和改），再用 sharp 导出到 packages/client/public/art/。
// 配色沿用 Activity 图标（暗物质 K），见 art-src/palette.json；卡框镂空按 ART.md"卡面安全区"的像素。
// 文字（稀有度、卡背 K）用 Unbounded 900 转成矢量路径，不依赖系统字体。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import opentype from 'opentype.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'packages/client/public/art');
const SRC = path.join(ROOT, 'art-src/svg');
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'art-src/palette.json'), 'utf8'));
const L = P.layout;
const font = opentype.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@fontsource/unbounded/files/unbounded-latin-900-normal.woff')).buffer);

/** 把一段文字转成居中在 (cx, cy)、宽不超过 maxW、高 size 的路径 */
function textPath(text, cx, cy, size, maxW, attrs = '') {
  let s = size;
  let p = font.getPath(text, 0, 0, s);
  let bb = p.getBoundingBox();
  if (bb.x2 - bb.x1 > maxW) { s = (size * maxW) / (bb.x2 - bb.x1); p = font.getPath(text, 0, 0, s); bb = p.getBoundingBox(); }
  const dx = cx - (bb.x1 + bb.x2) / 2;
  const dy = cy - (bb.y1 + bb.y2) / 2;
  p = font.getPath(text, dx, dy, s);
  return `<path d="${p.toPathData(2)}" ${attrs}/>`;
}

const svg = (w, h, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;
const stops = (colors) => colors.map((c, i) => `<stop offset="${(i / (colors.length - 1)) * 100}%" stop-color="${c}"/>`).join('');
/** 确定的伪随机（改了种子才会变），保证每次生成一模一样 */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

async function write(rel, svgText, { quality = 92, png = false } = {}) {
  const svgPath = path.join(SRC, rel.replace(/\.(webp|png)$/, '.svg'));
  fs.mkdirSync(path.dirname(svgPath), { recursive: true });
  fs.writeFileSync(svgPath, svgText);
  const out = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const img = sharp(Buffer.from(svgText), { density: 72 });
  if (png) await img.png({ compressionLevel: 9 }).toFile(out);
  else await img.webp({ quality, alphaQuality: 90, effort: 6 }).toFile(out);
  const kb = Math.ceil(fs.statSync(out).size / 1024);
  console.log(`  ${rel.padEnd(28)} ${kb} KB`);
}

// ---------------- 卡框：外框带 + 镂空窗口 + 名牌条 + 角标座 ----------------
const W = L.width, H = L.height, B = L.band;
function frameSvg(style) {
  const outer = `M${L.outerRadius},0 H${W - L.outerRadius} A${L.outerRadius},${L.outerRadius} 0 0 1 ${W},${L.outerRadius} V${H - L.outerRadius} A${L.outerRadius},${L.outerRadius} 0 0 1 ${W - L.outerRadius},${H} H${L.outerRadius} A${L.outerRadius},${L.outerRadius} 0 0 1 0,${H - L.outerRadius} V${L.outerRadius} A${L.outerRadius},${L.outerRadius} 0 0 1 ${L.outerRadius},0 Z`;
  const r = L.windowRadius;
  const inner = `M${B + r},${B} H${W - B - r} A${r},${r} 0 0 1 ${W - B},${B + r} V${H - B - r} A${r},${r} 0 0 1 ${W - B - r},${H - B} H${B + r} A${r},${r} 0 0 1 ${B},${H - B - r} V${B + r} A${r},${r} 0 0 1 ${B + r},${B} Z`;
  const fills = {
    standard: `<linearGradient id="band" x1="0" y1="0" x2="1" y2="1">${stops([P.deep[2], P.deep[1], P.deep[0], P.deep[1], P.deep[2]])}</linearGradient>`,
    holo: `<linearGradient id="band" x1="0" y1="0" x2="1" y2="1">${stops([...P.laser, P.laser[0]])}</linearGradient>`,
    ice: `<linearGradient id="band" x1="0" y1="1" x2="1" y2="0">${stops(['#1b2a4d', P.laser[0], '#e9fbff', P.laser[1], '#1b2a4d'])}</linearGradient>`,
    gold: `<linearGradient id="band" x1="0" y1="0" x2="1" y2="1">${stops([...P.gold, P.gold[1]])}</linearGradient>`,
  };
  const line = { standard: P.neon, holo: '#ffffff', ice: '#e9fbff', gold: P.gold[0] }[style];
  const plateTop = L.plate.top;
  const defs = `${fills[style]}
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.deep[0]}" stop-opacity="0.55"/><stop offset="1" stop-color="${P.deep[0]}" stop-opacity="0.88"/></linearGradient>
    <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="win"><path d="${inner}"/></clipPath>`;
  // 碎冰：外框带上的冰裂纹
  let extra = '';
  if (style === 'ice') {
    const rnd = rng(7);
    const lines = [];
    for (let i = 0; i < 46; i += 1) {
      const side = i % 4;
      const t = rnd();
      const [x, y] = side === 0 ? [t * W, rnd() * B] : side === 1 ? [W - rnd() * B, t * H] : side === 2 ? [t * W, H - rnd() * B] : [rnd() * B, t * H];
      const a = rnd() * Math.PI * 2, len = 10 + rnd() * 26;
      lines.push(`M${x.toFixed(1)},${y.toFixed(1)} l${(Math.cos(a) * len).toFixed(1)},${(Math.sin(a) * len).toFixed(1)}`);
    }
    extra = `<path d="${lines.join(' ')}" stroke="#ffffff" stroke-opacity="0.7" stroke-width="1.6" fill="none"/>`;
  }
  if (style === 'holo') {
    extra = `<path d="${outer} ${inner}" fill-rule="evenodd" fill="url(#sheen)" opacity="0.55"/>`;
  }
  const sheenDef = style === 'holo' ? `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.3" spreadMethod="repeat" gradientTransform="scale(0.25)"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` : '';
  const goldEngrave = style === 'gold'
    ? `<path d="${outer}" fill="none" stroke="${P.gold[2]}" stroke-width="3"/><rect x="${B / 2}" y="${B / 2}" width="${W - B}" height="${H - B}" rx="${L.outerRadius - B / 2}" fill="none" stroke="${P.gold[0]}" stroke-opacity="0.7" stroke-width="1.5"/>`
    : '';
  const badge = L.badge;
  const body = `
    <path d="${outer} ${inner}" fill-rule="evenodd" fill="url(#band)"/>
    ${extra}${goldEngrave}
    <g clip-path="url(#win)">
      <rect x="${B}" y="${plateTop}" width="${W - 2 * B}" height="${H - B - plateTop}" fill="url(#plate)"/>
      <rect x="${B}" y="${plateTop}" width="${W - 2 * B}" height="3" fill="${line}" opacity="0.9" filter="url(#glow)"/>
      <circle cx="${badge.x + badge.size / 2}" cy="${badge.y + badge.size / 2}" r="${badge.size / 2 + 6}" fill="${P.deep[0]}" fill-opacity="0.55"/>
    </g>
    <path d="${inner}" fill="none" stroke="${line}" stroke-width="3" opacity="0.95" filter="url(#glow)"/>`;
  return svg(W, H, body, defs + sheenDef);
}

// ---------------- 稀有度角标：深色圆章 + 彩色描边 + 字 ----------------
function raritySvg(r) {
  const S = L.badge.size;
  const c = P.rarity[r];
  const ring = Array.isArray(c) ? 'url(#ring)' : c;
  const defs = `${Array.isArray(c) ? `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">${stops(c)}</linearGradient>` : ''}
    <radialGradient id="core" cx="0.5" cy="0.4" r="0.6">${stops([P.deep[2], P.deep[1], P.deep[0]])}</radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  const R = S / 2 - 8;
  const hex = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(S / 2 + R * Math.cos(a)).toFixed(1)},${(S / 2 + R * Math.sin(a)).toFixed(1)}`; }).join(' ');
  const body = `<polygon points="${hex}" fill="url(#core)" stroke="${ring}" stroke-width="6" filter="url(#glow)"/>
    ${textPath(r, S / 2, S / 2 + 2, r.length >= 3 ? 30 : r.length === 2 ? 38 : 50, S - 40, `fill="${Array.isArray(c) ? 'url(#ring)' : P.highlight}" stroke="${ring}" stroke-width="${Array.isArray(c) ? 0 : 1.5}"`)}`;
  return svg(S, S, body, defs);
}

// ---------------- 卡背：暗物质深底 + 网格 + K ----------------
function backSvg() {
  const defs = `<radialGradient id="bg" cx="0.5" cy="0.45" r="0.75">${stops([P.deep[2], P.deep[1], P.deep[0]])}</radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M42 0 H0 V42" fill="none" stroke="${P.neon}" stroke-opacity="0.12" stroke-width="1"/></pattern>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  const body = `<rect width="${W}" height="${H}" rx="${L.outerRadius}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" rx="${L.outerRadius}" fill="url(#grid)"/>
    <rect x="${B}" y="${B}" width="${W - 2 * B}" height="${H - 2 * B}" rx="${L.windowRadius}" fill="none" stroke="${P.neon}" stroke-width="3" filter="url(#glow)"/>
    <circle cx="${W / 2}" cy="${H / 2 - 20}" r="170" fill="none" stroke="${P.glow}" stroke-width="10" opacity="0.8" filter="url(#glow)"/>
    ${textPath('K', W / 2, H / 2 - 20, 230, 260, `fill="${P.highlight}" stroke="${P.neon}" stroke-width="4" filter="url(#glow)"`)}
    ${textPath('KANU', W / 2, H - 120, 52, 300, `fill="${P.neon}" opacity="0.9"`)}`;
  return svg(W, H, body, defs);
}

// ---------------- 放大镜细节：256 × 256 透明，所有卡共用（CSS 会按格子拉伸） ----------------
function loupeSvg(name) {
  const S = 256, rnd = rng(name.length * 977 + name.charCodeAt(0));
  const blur = (d) => `<filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${d}"/></filter>`;
  switch (name) {
    case 'halftone': { // 正品网点：整齐的小点阵（可平铺）
      const dots = [];
      for (let y = 4; y < S; y += 8) for (let x = (y / 8) % 2 ? 8 : 4; x < S; x += 8) dots.push(`<circle cx="${x}" cy="${y}" r="1.6"/>`);
      return svg(S, S, `<g fill="#120a1c" fill-opacity="0.45">${dots.join('')}</g>`);
    }
    case 'ink': { // 油墨晕开：不规则的深色团 + 毛边
      const blobs = Array.from({ length: 9 }, () => `<circle cx="${(90 + rnd() * 76).toFixed(0)}" cy="${(90 + rnd() * 76).toFixed(0)}" r="${(22 + rnd() * 34).toFixed(0)}"/>`).join('');
      return svg(S, S, `<g fill="#1a0a24" fill-opacity="0.75" filter="url(#f)">${blobs}</g>`, blur(6));
    }
    case 'misregister': { // 套色错位：青、品红两道错开的色边
      return svg(S, S, `<rect x="40" y="0" width="18" height="${S}" fill="#00e6ff" fill-opacity="0.75"/><rect x="150" y="0" width="18" height="${S}" fill="#ff00aa" fill-opacity="0.75"/><rect x="58" y="0" width="12" height="${S}" fill="#ffe600" fill-opacity="0.45"/>`);
    }
    case 'holo': { // 防伪闪光不对：颜色顺序乱、发灰的彩条
      return svg(S, S, `<rect width="${S}" height="${S}" rx="12" fill="url(#g)" opacity="0.8"/>`, `<linearGradient id="g" x1="0" x2="1">${stops(['#ff004c', '#ffb700', '#3dff6b', '#00b7ff', '#b100ff'])}</linearGradient>`);
    }
    case 'border': { // 边框歪：一条斜着的白边
      return svg(S, S, `<path d="M0,${S * 0.4} L${S},${S * 0.58} L${S},${S * 0.64} L0,${S * 0.46} Z" fill="#ffffff" fill-opacity="0.9"/>`);
    }
    case 'scratch': { // 划痕：几道细白线
      const lines = Array.from({ length: 5 }, (_, i) => { const y = 40 + i * 42 + rnd() * 10; return `<path d="M${(rnd() * 30).toFixed(0)},${y.toFixed(0)} Q${S / 2},${(y + (rnd() - 0.5) * 30).toFixed(0)} ${(S - rnd() * 30).toFixed(0)},${(y + (rnd() - 0.5) * 20).toFixed(0)}" stroke="#fff" stroke-opacity="${(0.5 + rnd() * 0.4).toFixed(2)}" stroke-width="${(1.5 + rnd() * 2).toFixed(1)}" fill="none"/>`; });
      return svg(S, S, lines.join(''));
    }
    case 'dust': { // 灰尘：散落的亮点和小絮
      const specks = Array.from({ length: 60 }, () => `<circle cx="${(rnd() * S).toFixed(0)}" cy="${(rnd() * S).toFixed(0)}" r="${(0.8 + rnd() * 3).toFixed(1)}" fill="#fff" fill-opacity="${(0.3 + rnd() * 0.5).toFixed(2)}"/>`);
      return svg(S, S, specks.join(''));
    }
    case 'gap': { // 漏印：一块没印上的米白色，边缘参差
      const pts = Array.from({ length: 18 }, (_, i) => { const a = (i / 18) * Math.PI * 2, r = 80 + rnd() * 34; return `${(S / 2 + Math.cos(a) * r * 1.1).toFixed(0)},${(S / 2 + Math.sin(a) * r * 0.8).toFixed(0)}`; }).join(' ');
      return svg(S, S, `<polygon points="${pts}" fill="#f5f0e4" fill-opacity="0.92"/>`);
    }
    default: throw new Error(name);
  }
}

// ---------------- 散放磨损：630 × 880 透明，叠在卡面上 ----------------
function wearSvg(level) {
  const rnd = rng(100 + level);
  const parts = [`<rect width="${W}" height="${H}" fill="#9a9a9a" fill-opacity="${[0, 0.08, 0.12, 0.16][level]}"/>`];
  const specks = Array.from({ length: 40 + level * 30 }, () => `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * H).toFixed(0)}" r="${(1 + rnd() * 3).toFixed(1)}" fill="#fff" fill-opacity="${(0.15 + rnd() * 0.35).toFixed(2)}"/>`);
  parts.push(specks.join(''));
  if (level >= 2) {
    for (let i = 0; i < 3 + level * 2; i += 1) {
      const x = rnd() * W, y = rnd() * H, a = -0.6 + rnd() * 1.2, len = 120 + rnd() * 260;
      parts.push(`<path d="M${x.toFixed(0)},${y.toFixed(0)} l${(Math.cos(a) * len).toFixed(0)},${(Math.sin(a) * len).toFixed(0)}" stroke="#fff" stroke-opacity="${(0.35 + rnd() * 0.3).toFixed(2)}" stroke-width="${(1.2 + rnd() * 1.6).toFixed(1)}"/>`);
    }
  }
  if (level >= 3) {
    // 卷角：右上角折起来（和 CSS 的 clip-path 对齐：顶边 88%、右边 9%）
    const x0 = W * 0.88, y0 = H * 0.09;
    parts.push(`<path d="M${x0},0 L${W},${y0} L${x0 - 10},${y0 + 14} Z" fill="#d8d2c4"/><path d="M${x0},0 L${x0 - 10},${y0 + 14}" stroke="#00000066" stroke-width="3"/>`);
  }
  return svg(W, H, parts.join(''));
}

async function main() {
  console.log('生成代码类美术素材：');
  for (const style of ['standard', 'holo', 'ice', 'gold']) await write(`frames/${style}.webp`, frameSvg(style));
  for (const r of Object.keys(P.rarity)) await write(`rarity/${r}.webp`, raritySvg(r));
  await write('cards/back.webp', backSvg(), { quality: 88 });
  // 彩蛋卡 GNG-01 打工人（2026-11-26）：纯黑卡面，玩家凑近看会在自己屏幕上看到自己的倒影。不加任何反光、划痕、文字
  await write('cards/GNG-01.webp', svg(W, H, `<rect width="${W}" height="${H}" fill="#000000"/>`), { quality: 90 });
  for (const n of ['halftone', 'ink', 'misregister', 'holo', 'border', 'scratch', 'dust', 'gap']) await write(`loupe/${n}.webp`, loupeSvg(n));
  for (const lv of [1, 2, 3]) await write(`wear/${lv}.webp`, wearSvg(lv));
}

main().catch((e) => { console.error(e); process.exit(1); });
