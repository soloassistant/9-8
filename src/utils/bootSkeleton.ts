/**
 * 首屏骨架移除（2026-10-29，审计 P1：冷启动 9.1s 完全空白）。
 *
 * 骨架本体写在 `src/index.html` 里（内联样式 + 内联脚本，见那里的注释）：
 * 它必须在任何产物 JS/CSS 到达之前就渲染，所以不能靠模块加载。
 * 这里只负责**在 app 真的画出来之后**把它淡出移除，避免「骨架撤了但界面还没画」的白闪。
 *
 * 不依赖 Taro：小程序端没有这个 DOM，静默返回即可（同一份代码两端跑）。
 */

/** 与 index.html 里 transition 的时长一致（0.24s）+ 余量 */
const FADE_MS = 320;

function removeNow(el: HTMLElement): void {
  if (el.parentNode) el.parentNode.removeChild(el);
}

/**
 * 移除首屏骨架。
 * · 加 `is-leaving` 触发淡出；
 * · `transitionend` 时移除；`prefers-reduced-motion` 下没有过渡事件，用定时兜底。
 */
export function dismissBootSkeleton(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('boot-skeleton');
  if (!el) return;
  el.classList.add('is-leaving');
  const timer = setTimeout(() => removeNow(el), FADE_MS);
  el.addEventListener(
    'transitionend',
    () => {
      clearTimeout(timer);
      removeNow(el);
    },
    { once: true }
  );
}

/**
 * 等两帧再移除：第一帧 app 完成挂载，第二帧才真正上屏。
 * 直接同步移除会在慢设备上露出「骨架没了、内容还没画」的一瞬白屏。
 */
export function dismissBootSkeletonAfterPaint(): void {
  if (typeof requestAnimationFrame !== 'function') {
    dismissBootSkeleton();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => dismissBootSkeleton()));
}
