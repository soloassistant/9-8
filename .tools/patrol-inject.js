/**
 * patrol-inject.js —— 视觉巡检的浏览器侧度量表达式。
 *
 * 由 verify-visual-patrol.mjs 读取本文件全文，经 CDP Runtime.evaluate 执行
 * （awaitPromise + returnByValue）。**本文件内容必须是一个单一表达式**（异步 IIFE）。
 *
 * 度量三件事：
 *   ① 对比度：视口内所有文字节点，逐级向上取首个不透明背景，算 WCAG 对比度；
 *      大字号（≥24px，或 ≥18.66px 且粗体）阈值 3.0，其余 4.5。rgba 前景先与背景混合。
 *   ② 固定元素遮挡：position:fixed 且可见的元素，在 顶 / 中 / 底 三个滚动位分别
 *      统计它压住了哪些「带文字的内容元素」及遮挡面积比。
 *   ③ 滚动度量：文档高度、视口高度、中部位滚动值。
 *
 * 已知边界（写进注释，免得后来者把漏报当没事）：
 *   · 背景取「逐级向上首个 alpha≥0.5 的 background-color」；途中任一祖先有
 *     background-image（渐变/图）即判不可计算并跳过 —— 图上的文字算不出可靠对比度，
 *     宁可不报也不乱报（用 skippedBgImage 计数暴露规模）。
 *   · 祖先链 opacity<1 不参与换算（少见；真出问题表现为漏报，不是误报）。
 *   · 纯 emoji / 标点文本跳过（无字母数字汉字），避免把 🤖 这类装饰图标算成缺陷。
 *   · `.taro-tabbar`（应用底部导航）整体排除：它是合法 chrome，本就该盖在内容上，
 *     页面用 padding-bottom 避让它，与「悬浮球压正文」不是一类问题。
 *   · AI 主动建议气泡（class 含 hint）排除：8 秒自动收起的一次性提示，不是常驻遮挡。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { href: location.href, contrast: [], skippedBgImage: 0, states: [] };

  const lum = (r, g, b) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parseColor = (s) => {
    const m = (s || '').match(/[\d.]+/g);
    if (!m) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
  };
  const blend = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  });
  const ratio = (a, b) => {
    const L1 = lum(a.r, a.g, a.b);
    const L2 = lum(b.r, b.g, b.b);
    const hi = Math.max(L1, L2);
    const lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cn = el.className;
    if (cn && typeof cn === 'string' && cn.trim()) s += '.' + cn.trim().split(/\s+/).slice(0, 3).join('.');
    return s.slice(0, 110);
  };
  const hasText = (el) => /[\p{Script=Han}\p{L}\p{N}]/u.test((el.innerText || '').trim());
  const bgOf = (el) => {
    let e = el;
    while (e && e !== document.documentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.5) return c;
      e = e.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // ---------- ① 对比度 ----------
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const t of nodes) {
    const txt = (t.textContent || '').trim();
    if (!txt || !/[\p{Script=Han}\p{L}\p{N}]/u.test(txt)) continue;
    const el = t.parentElement;
    if (!el || !isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < -40 || r.top > innerHeight + 40 || r.right < -40 || r.left > innerWidth + 40) continue;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    if (!bg) {
      out.skippedBgImage++;
      continue;
    }
    const effFg = fg.a < 1 ? blend(fg, bg) : fg;
    const size = parseFloat(cs.fontSize) || 14;
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const cr = ratio(effFg, bg);
    if (cr < need) {
      const key = label(el) + '|' + cs.color + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '|' + size;
      if (seen.has(key)) continue;
      seen.add(key);
      out.contrast.push({
        text: txt.slice(0, 24),
        sel: label(el),
        fg: cs.color,
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        size: Math.round(size),
        ratio: Math.round(cr * 100) / 100,
        need,
      });
    }
  }

  // ---------- ② 固定元素遮挡（顶 / 中 / 底 三个滚动位） ----------
  /**
   * 找真正的滚动容器。
   *
   * ⚠️ 2026-10-24 修正：原先直接 `window.scrollTo`，在 Taro H5 上**恒不滚动** ——
   * Taro 把页面挂进 `.taro_page`（position:absolute; height:100%; overflow-y:auto），
   * 内容在容器内滚动，documentElement.scrollHeight 永远等于 clientHeight。
   * 后果是「中/底滚动位」实际都在顶部位度量，遮挡结论整段失真（既漏掉真遮挡，
   * 也会把「滚一下就能让开」的临时重叠误报成永久遮挡）。
   * 现在优先取 `.taro_page`，兜底找第一个可滚动祖先，并把选中的容器写进输出备查。
   */
  const findScroller = () => {
    const taroPage = document.querySelector('.taro_page');
    if (taroPage && taroPage.scrollHeight > taroPage.clientHeight + 4) return taroPage;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.taro-tabbar')) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      if (el.scrollHeight > el.clientHeight + 4) return el;
    }
    return document.scrollingElement || document.documentElement;
  };
  const scroller = findScroller();
  const scrollTo = (y) => {
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo(0, y);
    else scroller.scrollTop = y;
  };
  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);

  /**
   * 等内容长稳。
   *
   * ⚠️ 2026-10-24 修正：Taro 页面内容是异步加载的（云调用 / RSS / 记忆恢复），
   * scrollHeight 会在首屏后持续增长数秒（实测简报页 854 → 1254）。若在增长期度量，
   * `maxScroll()` 拿到的是旧值，bottom 实际只滚到一小段（实测只到 92），
   * 于是「再滚 400px 就能让开」的临时重叠被误判成永久遮挡。
   * 现在轮询到高度连续两次不变再开始度量；仍设 20 次（约 6s）上限防永等。
   */
  const settle = async () => {
    let last = -1;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const h = scroller.scrollHeight;
      if (h === last) return h;
      last = h;
    }
    return last;
  };
  /** 滚动并确认到位：内容若在滚动途中又变长，重滚一次（宁多滚也不要停在错位） */
  const scrollAndConfirm = async (y) => {
    scrollTo(y);
    await sleep(400);
    if (Math.abs(scroller.scrollTop - y) > 2) {
      scrollTo(y);
      await sleep(400);
    }
  };

  const snapshot = (tag) => {
    const fixedEls = [];
    for (const el of document.querySelectorAll('body *')) {
      const cn = el.className;
      if (typeof cn === 'string' && cn.includes('hint')) continue; // 一次性建议气泡
      if (el.closest('.taro-tabbar')) continue; // 合法 chrome
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) fixedEls.push({ el, r });
    }
    const items = [];
    for (const { el, r } of fixedEls) {
      const covered = [];
      for (const other of document.querySelectorAll('body *')) {
        if (other === el || el.contains(other) || other.contains(el)) continue;
        if (other.closest('.taro-tabbar')) continue;
        if (!isVisible(other) || !hasText(other)) continue;
        const o = other.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, o.right) - Math.max(r.left, o.left));
        const iy = Math.max(0, Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top));
        if (ix <= 2 || iy <= 2) continue;
        const oArea = Math.max(1, o.width * o.height);
        covered.push({
          sel: label(other),
          ratio: Math.round(((ix * iy) / oArea) * 100) / 100,
          text: (other.innerText || '').replace(/\s+/g, ' ').slice(0, 30),
        });
      }
      covered.sort((a, b) => b.ratio - a.ratio);
      items.push({
        sel: label(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        covered: covered.slice(0, 5),
      });
    }
    out.states.push({ tag, scrollY: Math.round(scroller.scrollTop), fixed: items });
  };

  await settle();
  const topMax = maxScroll();
  snapshot('top');
  const mid = Math.min(400, maxScroll());
  await scrollAndConfirm(mid);
  snapshot('mid');
  const bottom = maxScroll();
  await scrollAndConfirm(bottom);
  snapshot('bottom');
  out.scroll = {
    scrollH: scroller.scrollHeight,
    clientH: scroller.clientHeight,
    maxScroll: bottom,
    midScrollY: mid,
    scroller: label(scroller),
    settledBeforeTop: topMax,
  };
  scrollTo(0);
  return JSON.stringify(out);
})()
