// 手机顶上的灵动岛 / 刘海、底下的主屏指示条。照搬旺财牌局 client/src/safe-area.js 的做法（服主 10-26 真机调过）：
// Discord 手机版的小活动是整屏的，系统的 env(safe-area-inset-*) 多半拿不到，
// 就看页面是不是占满整个屏幕、竖着拿：iPhone 顶 56、底 18；其他触屏手机顶 28；电脑、横屏、没占满屏幕都是 0。
// 算好写到 :root 的 --island-top / --island-bottom，样式里用 max(16px, var(--island-top)) 往下让。

function measure() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.documentElement.appendChild(probe);
  const cs = getComputedStyle(probe);
  const env = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  probe.remove();

  const full = Math.abs(screen.height - innerHeight) < 4 || Math.abs(screen.width - innerHeight) < 4;
  const tall = innerHeight > innerWidth;
  const ios = /iPhone|iPod/.test(navigator.userAgent);
  const touch = matchMedia('(pointer: coarse)').matches;
  return {
    top: Math.max(env.top, full && tall ? (ios ? 56 : touch ? 28 : 0) : 0),
    bottom: Math.max(env.bottom, full && tall && ios ? 18 : 0),
  };
}

function apply() {
  const s = measure();
  const st = document.documentElement.style;
  st.setProperty('--island-top', `${s.top}px`);
  st.setProperty('--island-bottom', `${s.bottom}px`);
}

export function installSafeArea() {
  apply();
  addEventListener('resize', apply);
  addEventListener('orientationchange', apply);
}
