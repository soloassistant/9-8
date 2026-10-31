/**
 * 首屏失败兜底 UI（2026-10-30）
 *
 * 为什么需要它 —— 实测出来的洞：
 *   `app.tsx` 原来在「启动期资源加载失败」时只做一件事：给 `#boot-skeleton` 加 `is-fail`。
 *   但那个骨架在**应用挂载成功的那一刻就被撤掉了**，于是最常见的失败形态
 *   （外壳起来了、切页的分包挂了）走到这里是：
 *     · 骨架不存在 → classList.add 静默无效
 *     · 用户看到一个没有内容、没有提示、没有重试的页面
 *   实测证据：掐掉 `js/855.*.js` 后 `ChunkLoadError` 抛出，页面 `retry: false`、
 *   可见文本还是隐私政策，用户只能自己想到刷新。
 *
 * 做法：直接插一个 fixed 覆盖层（错误路径不依赖 React 状态，避免"渲染失败还要 React 才能显示错误"）。
 *   · 幂等：已有就不重复插
 *   · 重试带 cache-busting：网关可能把坏掉的那次响应缓存住，同 URL 再请求还是一样坏
 *   · 文案说人话，不暴露 ChunkLoadError 这种词
 */

const OVERLAY_ID = 'wb-boot-failure';

/**
 * 显示首屏失败提示（幂等）。
 * @param detail 可选的技术细节，只在控制台用，不显示给用户
 */
export function showBootFailure(detail?: string): void {
  if (typeof document === 'undefined') return;
  if (detail) console.error('[boot] 首屏失败:', detail);
  if (document.getElementById(OVERLAY_ID)) return;
  const box = document.createElement('div');
  box.id = OVERLAY_ID;
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', '页面没有加载出来');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483000',
    'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
    'gap:14px', 'padding:32px 24px', 'box-sizing:border-box',
    'background:#F7F5F0', 'color:#1D2129', 'text-align:center',
    'font-size:15px', 'line-height:1.6',
    "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif"
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '页面没有加载出来';
  title.style.cssText = 'font-size:18px;font-weight:600;';

  const desc = document.createElement('div');
  desc.textContent = '多半是网络不稳或服务在抽风。点下面重试一次，通常就好了。';
  desc.style.cssText = 'max-width:22em;color:#4E5969;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重新加载';
  btn.style.cssText = [
    'margin-top:6px', 'padding:10px 26px', 'border:0', 'border-radius:999px',
    'background:#1D2129', 'color:#fff', 'font-size:15px', 'cursor:pointer',
    'min-height:44px', 'min-width:120px'
  ].join(';');
  btn.addEventListener('click', () => {
    // 带 cache-busting：换一个 query key，强制取新响应
    const { pathname, search } = window.location;
    window.location.replace(`${pathname}${search}${search ? '&' : '?'}r=${Date.now()}`);
  });

  box.appendChild(title);
  box.appendChild(desc);
  box.appendChild(btn);
  document.body.appendChild(box);

  // 把焦点给按钮：键盘用户不用 Tab 找，读屏也会先念到它
  try {
    btn.focus();
  } catch {
    /* 焦点失败不影响可见性 */
  }
}

/** 出问题的地方可能拿不到 React，也可能重复触发；测试与门禁用它清理 */
export function clearBootFailure(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}
