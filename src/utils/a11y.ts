/**
 * 键盘可达性基础件（2026-10-29，审计 P1：全站零可聚焦操作元素）。
 *
 * 问题：Taro 的 `View` 渲染成自定义元素 `taro-view-core`，带 `onClick` 但**没有** role /
 * tabIndex / 键盘语义。于是桌面键盘用户按 Tab 键在整站穿不过任何按钮 —— 全站 19 页
 * 一个可聚焦操作元素都没有，而产品却自带一层全局快捷键（矛盾：键盘党得先知道快捷键）。
 *
 * 做法（不改组件结构、不引入新依赖）：
 *   1. `pressableProps()` 返回一组可直接展开到 `View` 上的属性：
 *      role=button + tabIndex=0 + data-pressable 标记 + aria-label。
 *   2. `markClickableAsPressable()` **自动**把「有 onClick 的 Taro 元素」标成可操作
 *      （靠 React 挂在 DOM 上的 `__reactProps$*` 反查）。全站 239 处 onClick 不可能一一手改，
 *      而且手改必然漏 —— 见该函数上方注释。
 *   3. `activatePressable()` 由 **App 上的全局 keydown 代理**调用：
 *      Enter / Space 在「当前焦点是 [data-pressable]」时触发它的 click()。
 *      为什么不给每个元素挂 onKeyDown：`taro-view-core` 对 React 合成事件的转发
 *      只在 onClick 上稳定，键盘事件走原生 addEventListener 更可靠（一处代理管全站）。
 *   4. 焦点环写在 app.scss 的 `[data-pressable]:focus-visible` —— 用 focus-visible
 *      而不是 focus，鼠标点击不闪框，键盘 Tab 才有框。
 */

/** 可展开到 Taro View 上的属性集（类型放宽成 Record，避免和 Taro 的 ViewProps 打架） */
export interface PressableAttrs {
  role: string;
  'data-pressable': string;
  'aria-label'?: string;
}

/**
 * @param label 读屏念出来的名字。**必填**：图标按钮若没有可读名字，
 *              键盘/读屏用户等于面对一个黑洞（本仓 UI 大量是 emoji + 文案，容易漏）。
 */
export function pressableProps(label: string): PressableAttrs {
  const attrs: PressableAttrs = { role: 'button', 'data-pressable': '1' };
  if (label && label.trim()) attrs['aria-label'] = label.trim();
  return attrs;
}

/**
 * 给所有可操作元素补上 **`tabindex` 属性**（不是 React 的 `tabIndex` 属性）。
 *
 * 为什么必须运行时补（2026-10-29 实测）：`View` 渲染成自定义元素 `taro-view-core`，
 * React 对 `tabIndex` 走的是 **DOM property**（`el.tabIndex = 0`），自定义元素不会把它
 * 反射成 HTML 属性 —— 而浏览器进 Tab 序列看的是**属性**。所以写 `tabIndex={0}` 完全无效：
 * 实测连按 14 次 Tab，停靠点是 DIV/BODY 来回跳，一个可操作元素都摸不到。
 * 这里直接 setAttribute('tabindex','0')，并且用 MutationObserver 覆盖动态渲染的列表。
 */
export function ensureFocusable(root: ParentNode = document): number {
  const list = root.querySelectorAll('[data-pressable]');
  let n = 0;
  list.forEach((el) => {
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
      n += 1;
    }
  });
  return n;
}

/**
 * ── 自动识别可点击元素（2026-10-29，第二轮 a11y）──────────────────────────
 *
 * 为什么不再一处一处加 `pressableProps`：全站 19 页有 **239 处** `onClick`，
 * 手工改不但工作量巨大，而且**必然漏** —— 新写的页面又回到「只有鼠标能用」。
 * 审计原话是「pressableProps 在 23 个页面里只有 login 有 2 处，其余为 0」。
 *
 * 做法：React 18 会把组件 props 挂到宿主 DOM 节点上（`__reactProps$<随机>`）。
 * 于是可以反过来问 DOM：「这个 `taro-view-core` 上到底有没有 onClick？」
 * 有 → 它就是个可操作元素，补 role/tabindex/data-pressable，交给既有的
 * 全局 keydown 代理去响应 Enter/Space。
 *
 * 为什么不用 `addEventListener` 打挂：React 18 是**根节点事件委托**，
 * 根本不会在这些元素上逐个 addEventListener('click')，钩子打不到。
 *
 * 降级：拿不到 React 内部键（升级 React / 换渲染器）时只是**不自动标记**，
 * 不报错、不影响手工 `pressableProps` 的那几处。
 */
const CLICKABLE_SELECTOR = 'taro-view-core, taro-text-core, taro-button-core';

/** 已经扫过的节点（避免每次 DOM 变动全量重扫，长列表上那是 O(n²)） */
const scanned = new WeakSet<Element>();

/** 取 React 挂在这个 DOM 节点上的 props（拿不到返回 null，属正常降级） */
function reactProps(el: Element): Record<string, unknown> | null {
  const keys = Object.keys(el);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].startsWith('__reactProps$')) {
      const p = (el as unknown as Record<string, unknown>)[keys[i]];
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
    }
  }
  return null;
}

/** 读屏名字：优先 aria-label，其次元素自身文字（截断 60 字，卡片标题常常很长） */
function readableName(el: Element): string {
  const own = el.getAttribute('aria-label');
  if (own && own.trim()) return own.trim();
  const raw = (el as HTMLElement).innerText || el.textContent || '';
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * 把 root 子树里「有 onClick 但没被标记」的元素标成可操作。
 * 返回新标记的数量（门禁与调试用）。
 */
export function markClickableAsPressable(root: ParentNode = document): number {
  if (typeof document === 'undefined') return 0;
  const roots: Element[] = [];
  if (root instanceof Element && root.matches(CLICKABLE_SELECTOR)) roots.push(root);
  root.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => roots.push(el));

  let n = 0;
  for (const el of roots) {
    if (scanned.has(el)) continue;
    scanned.add(el);
    if (el.hasAttribute('data-pressable')) continue; // 手工标过的别再动，尊重作者写的 aria-label
    const props = reactProps(el);
    if (!props || typeof props.onClick !== 'function') continue;
    el.setAttribute('role', 'button');
    el.setAttribute('data-pressable', '1');
    el.setAttribute('tabindex', '0');
    const label = readableName(el);
    if (label) el.setAttribute('aria-label', label);
    n += 1;
  }
  return n;
}

/** 观察 DOM 变化，给新出现的可操作元素补 tabindex。返回 disconnect */
export function observePressables(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
  const pending = new Set<Element>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    for (const el of batch) markClickableAsPressable(el);
    ensureFocusable();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  };

  // 首屏已存在的节点扫一遍；之后只看新增子树（React 每次插入的都在里面）
  markClickableAsPressable(document.body);
  ensureFocusable();

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType === 1 && !scanned.has(n as Element)) pending.add(n as Element);
      });
    }
    if (pending.size) schedule();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => mo.disconnect();
}

/** 焦点是否落在输入类元素上（这些元素自己就该吃空格/回车，不能被代理抢走） */
function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * 全局 keydown 代理：把 Enter / Space 翻译成「点击当前聚焦的可操作元素」。
 * 返回是否处理了这次按键（调用方据此决定要不要 preventDefault）。
 *
 * 三条让路规则（与 hotkeys 层的铁律一致）：
 *   · 输入框里按回车 = 提交/换行，不归这里管；
 *   · 带修饰键（⌘/Ctrl/Alt/Shift）不处理 —— 那是快捷键层/浏览器的事；
 *   · IME 组字中（isComposing）不处理 —— 中文输入法里选词会按空格/回车。
 */
export function activatePressable(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return false;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!active || isTextEntry(active)) return false;
  // 焦点可能落在内部子节点上（View 里套 Text），向上找最近的可操作祖先
  const host = active.closest ? active.closest('[data-pressable]') : null;
  if (!host) return false;
  (host as HTMLElement).click();
  return true;
}
