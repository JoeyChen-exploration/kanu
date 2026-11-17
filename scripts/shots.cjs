// 本机截图检查版式：用旺财牌局装好的 playwright-core + Chromium（只读借用），打开本机 Vite（5173）。
// 用法：npm run shots（先 npm run dev）→ 截图存到 .scratch/shots/（D 盘，不进 git）
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../wangcai-cards/node_modules/playwright-core'));

const OUT = path.join(__dirname, '..', '.scratch', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SIZES = [
  ['phone-landscape', 844, 390],
  ['16x9', 1280, 720],
  ['3x2', 1080, 720],
  ['square', 800, 760],
  ['portrait', 390, 844],
  ['pip', 480, 270],
];
const TABS = ['店铺', '柜台', '库存'];

(async () => {
  const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/');
  await page.fill('.dev-login input', 'layout-check');
  await page.click('.dev-login button');
  await page.waitForSelector('.tabs button');
  // 第一次进会自动打开新手手册，先关掉
  const close = page.locator('.float-window.booklet button[aria-label="关闭"]');
  if (await close.count()) await close.click();
  for (const [name, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of TABS) {
      const btn = page.locator('.tabs button', { hasText: tab });
      if (await btn.isVisible()) await btn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${name}-${tab}.png`) });
      if (name === 'pip') break;
    }
  }
  await browser.close();
  console.log('ok', fs.readdirSync(OUT).length);
})().catch((e) => { console.error(e); process.exit(1); });
