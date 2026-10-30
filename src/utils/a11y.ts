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
 * ★ 怎么判断「这个 Taro 元素自己有没有点击处理器」—— 试错记录，别再走回头路：
 *   ① `el.tabIndex` / props 里的 `onClick`：拿不到。Taro 的 `View` 只是普通 props 透传，
 *      渲染成自定义元素后 `__reactProps$*` 上只有 `style / children / dangerouslySetInnerHTML`，
 *      实测 4611 个元素里 `onClick` 命中 **0**。
 *   ② 顺着 `__reactFiber$*` 往上找 `memoizedProps.onClick`：能命中 2121 个，**但会把
 *      卡片里每一层子节点都算进去**（祖先的处理器被后代替继承）—— 一张卡会变成 10 个 Tab 停靠点。
 *   ③ 正解：Taro 的 H5 运行时是**逐元素 `addEventListener('click')`**（不是 React 18
 *      那种根委托）。所以包装一次 `EventTarget.prototype.addEventListener`，
 *      把「注册过 click 的 TARO-* 元素」记下来，就是精确答案。
 *      实测同一页面：注册 2124 个、可见 2121 个，样本全是真按钮（「全部」「⚡ PRO」「关闭个性化推荐」）。
 *
 * 代价：包装了全局 `addEventListener`。所以只做一件事 —— type === 'click' 且是 TARO-*
 * 就记一笔，然后原样转发；不改行为、不吞异常。拿不到（旧浏览器/被别的库先包装）
 * 就静默不标记，手工 `pressableProps` 的那几处照旧工作。
 */
const CLICKABLE_SELECTOR = 'taro-view-core, taro-text-core, taro-button-core';

/** 注册过原生 click 的 Taro 元素（精确的「自己可点」名单） */
const clickBound = new WeakSet<Element>();

let listenerPatched = false;

/** 包装一次 addEventListener，记录哪些 Taro 元素自己挂了 click（幂等） */
export function patchClickTracking(): void {
  if (listenerPatched) return;
  if (typeof EventTarget === 'undefined' || !EventTarget.prototype.addEventListener) return;
  listenerPatched = true;
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function patchedAddEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'click') {
      const el = this as unknown as Element;
      // 只看 Taro 自定义元素：React 根委托、window/document 的监听一概不记
      if (el && typeof el.tagName === 'string' && el.tagName.indexOf('TARO-') === 0) clickBound.add(el);
    }
    return orig.call(this, type, listener, options);
  } as typeof EventTarget.prototype.addEventListener;
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
 * 把 root 子树里「自己挂了 click 但还没被标记」的元素标成可操作。
 * 返回新标记的数量（门禁与调试用）。
 *
 * ⚠️ 不要用「扫过就永久跳过」的 WeakSet：元素可能先插入 DOM、后挂监听，
 *    一次性跳过会把它们永久漏掉。代价是每次新增子树都重扫一遍，
 *    但扫描范围只有这次新增的子树，不是整页。
 */
export function markClickableAsPressable(root: ParentNode = document): number {
  if (typeof document === 'undefined') return 0;
  const roots: Element[] = [];
  if (root instanceof Element && root.matches(CLICKABLE_SELECTOR)) roots.push(root);
  root.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => roots.push(el));

  let n = 0;
  for (const el of roots) {
    if (el.hasAttribute('data-pressable')) continue; // 手工标过的别再动，尊重作者写的 aria-label
    if (!clickBound.has(el)) continue; // 没挂 click = 不是可操作元素（含遮罩/弹层的吞点击节点）
    el.setAttribute('role', 'button');
    el.setAttribute('data-pressable', '1');
    el.setAttribute('tabindex', '0');
    const label = readableName(el);
    if (label) el.setAttribute('aria-label', label);
    n += 1;
  }
  return n;
}

/**
 * 观察 DOM 变化，给新出现的可操作元素补 tabindex。返回 disconnect
 *
 * ⚠️ 必须在**任何 Taro 元素渲染之前**调用 `patchClickTracking()`，
 *    否则首屏那批元素的 click 监听已经挂完，包装器看不到它们
 *    （首屏会漏标，用户 Tab 到导航后再也摸不到正文）。
 */
export function observePressables(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
  patchClickTracking();
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
        if (n.nodeType === 1) pending.add(n as Element);
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

// ★ 模块加载即接上包装（不是等 observePressables 被调）。
//   原因：`observePressables()` 在 app.tsx 的 useEffect 里跑，那时首屏元素
//   （开屏、隐私弹窗、首个页面）**已经创建并挂好 click 监听**了 —— 包装器看不到它们，
//   首屏就漏标。模块求值发生在这之前，是唯一稳的时点。
//   小程序端没有 EventTarget 的 DOM 语义，patchClickTracking 自己会 return。
if (typeof window !== 'undefined') patchClickTracking();
