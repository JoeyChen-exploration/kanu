// 手机顶上的灵动岛 / 刘海、底下的主屏指示条。照搬旺财牌局 client/src/safe-area.js 的做法（服主 10-26 真机调过）：
// Discord 手机版的小活动是整屏的，系统的 env(safe-area-inset-*) 多半拿不到，
// 就看页面是不是占满整个屏幕、竖着拿：iPhone 顶 IOS_TOP、底 18；其他触屏手机顶 28；电脑、横屏、没占满屏幕都是 0。
// 算好写到 :root 的 --island-top / --island-bottom，样式里用 max(16px, var(--island-top)) 往下让。

/** 2026-11-17 卡奴 M0 真机实测：牌局用的 56 在卡奴首页仍被灵动岛挡住，加到 72 */
const IOS_TOP = 72;
/** 横屏时 iPhone 左右两边各让多少（灵动岛在其中一边，没真机测过，先按常见的 48） */
const IOS_SIDE = 48;

function measure() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
  document.documentElement.appendChild(probe);
  const cs = getComputedStyle(probe);
  const env = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };

  const full = Math.abs(screen.height - innerHeight) < 4 || Math.abs(screen.width - innerHeight) < 4;
  const tall = innerHeight > innerWidth;
  const ios = /iPhone|iPod/.test(navigator.userAgent);
  const touch = matchMedia('(pointer: coarse)').matches;
  const sideEnv = { left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
  probe.remove();
  // 横屏（2026-11-17 起卡奴按横屏做）：刘海 / 灵动岛跑到左边或右边，不知道转的是哪个方向，两边都让
  const side = full && !tall ? (ios ? IOS_SIDE : touch ? 24 : 0) : 0;
  return {
    top: Math.max(env.top, full && tall ? (ios ? IOS_TOP : touch ? 28 : 0) : 0),
    bottom: Math.max(env.bottom, full && tall && ios ? 18 : full && ios ? 12 : 0),
    left: Math.max(sideEnv.left, side),
    right: Math.max(sideEnv.right, side),
  };
}

function apply() {
  const s = measure();
  const st = document.documentElement.style;
  st.setProperty('--island-top', `${s.top}px`);
  st.setProperty('--island-bottom', `${s.bottom}px`);
  st.setProperty('--island-left', `${s.left}px`);
  st.setProperty('--island-right', `${s.right}px`);
}

export function installSafeArea() {
  apply();
  addEventListener('resize', apply);
  addEventListener('orientationchange', apply);
}
