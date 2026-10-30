/**
 * Service Worker 注册（2026-10-30）
 *
 * 为什么要有：线上托管环境会偶发卡住**单个**资源请求 —— 实测同一个 157 KB 分包，
 * 两次 curl 分别 1.39s 和 18.8s（TTFB 就 11s），而 616 KB 的主包只要 1 秒出头。
 * 这个抖动与文件大小无关，砍包体治不了；而网关又不给 Cache-Control，
 * 浏览器只能每次重新下载。唯一能让**重复访问**不受它影响的办法就是本地缓存。
 *
 * 策略全部写在 src/assets/sw.js 里（构建时把 VERSION 换成构建输入哈希）。
 * 这里只负责注册，且刻意做得「不成功也无所谓」：
 *   · 只在安全上下文注册（https / localhost）。file:// 与 http 局域网地址直接跳过。
 *   · 失败只记一条日志，绝不影响页面本身。
 *   · 等 load 之后再注册，不和首屏抢带宽。
 */
export function registerServiceWorker(): void {
  if (process.env.TARO_ENV !== 'h5') return;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const { protocol, hostname } = window.location;
  const secure = protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
  if (!secure) return;

  const doRegister = () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // 不弹提示、不重试：SW 是纯加速层，缺了只是慢，不是坏了
      console.error('[sw] 注册失败（不影响功能）:', err && err.message);
    });
  };

  if (document.readyState === 'complete') doRegister();
  else window.addEventListener('load', doRegister, { once: true });
}
