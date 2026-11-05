/** 热点页滑动窗口虚拟列表：只挂载 [start,end)，上下占位撑开滚动条；测量读一次布局、8ms 切片写缓存。小程序全量渲染。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const FIRST_WINDOW = 14; // 首窗卡数
const STEP = 12; // 每次扩展条数
const MAX_WINDOW = 42; // 同时挂载上限
const EST_ADVANCE = 320; // 未测卡推进高度估算（px，含卡间距）
const GAP_FALLBACK = 16; // 最后一张卡补的卡间距
const OVERSCAN_PX = 1200; // 哨兵提前量 ≈1.5 屏
const NEAR_BOTTOM_PX = 300; // 距文档底阈值 → 切尾窗
const IDLE_BUDGET_MS = 8; // 批量补算切片预算
const LIST_ATTR = 'data-news-list';
const IS_H5 = process.env.TARO_ENV === 'h5';
const SUPPORTED =
  IS_H5 && typeof window !== 'undefined' && typeof IntersectionObserver === 'function';

type Range = { start: number; end: number };

export type VirtualNewsList<T> = {
  slice: T[];
  start: number;
  end: number;
  total: number;
  topH: number;
  bottomH: number;
  loadMore: () => void;
};

export function useVirtualNewsList<T extends { id: string }>(
  list: T[],
  resetKey: string
): VirtualNewsList<T> {
  const total = list.length;
  // 上限覆盖整张列表时虚拟化没有意义；MAX_WINDOW=9999 即整表直出（等价于关掉虚拟化）
  const virtual = SUPPORTED && total > MAX_WINDOW;

  const [range, setRange] = useState<Range>(() => ({
    start: 0,
    end: Math.min(FIRST_WINDOW, total)
  }));
  const [heightVersion, setHeightVersion] = useState(0); // 只为触发占位重算
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const heightsRef = useRef<Map<string, number>>(new Map());
  const pendingRef = useRef<Array<{ id: string; advance: number }>>([]);
  const flushRef = useRef<(deadline?: IdleDeadline) => void>(() => {});
  const lockRef = useRef(false);

  // 列表由空变满时 reset effect 尚未跑：先把渲染窗口兜到首窗，避免一帧空白
  const view = useMemo(() => {
    if (!virtual) return { start: 0, end: total };
    const end = range.end > 0 ? range.end : Math.min(FIRST_WINDOW, total);
    return { start: Math.min(range.start, Math.max(0, end - MAX_WINDOW)), end };
  }, [range.start, range.end, total, virtual]);

  const avgAdvance = useCallback(() => {
    const vals = Array.from(heightsRef.current.values());
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : EST_ADVANCE;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback((d) => flushRef.current(d), { timeout: 200 });
    else setTimeout(() => flushRef.current(), 0);
  }, []);

  // 缓存写回按 8ms 切片；读布局在 measureRendered 里一次完成
  flushRef.current = (deadline?: IdleDeadline) => {
    const q = pendingRef.current;
    const t0 = performance.now();
    let changed = false;
    while (q.length) {
      const { id, advance } = q.shift() as { id: string; advance: number };
      const prev = heightsRef.current.get(id);
      if (!prev || Math.abs(prev - advance) > 3) { heightsRef.current.set(id, advance); changed = true; }
      if (deadline ? deadline.timeRemaining() < 1 : performance.now() - t0 > IDLE_BUDGET_MS) break;
    }
    if (q.length) scheduleFlush();
    else if (changed) setHeightVersion((v) => v + 1);
  };

  const measureRendered = useCallback(() => {
    if (!virtual) return;
    const root = typeof document !== 'undefined' ? document.querySelector(`[${LIST_ATTR}]`) : null;
    if (!root) return;
    const els = Array.from(root.querySelectorAll('[data-news-id]')) as HTMLElement[];
    if (!els.length) return;

    // 一次性读完矩形（读与读之间没有写 → 只触发一次 layout）
    const rects = els.map((el) => el.getBoundingClientRect());
    pendingRef.current = els
      .map((el, i) => {
        const delta = i + 1 < els.length ? rects[i + 1].top - rects[i].top : 0;
        return { id: el.getAttribute('data-news-id') || '', advance: delta > 40 ? delta : rects[i].height + GAP_FALLBACK };
      })
      .filter((x) => x.id);
    scheduleFlush();
  }, [scheduleFlush, virtual]);

  // 窗口/列表变化后测一次（只改高度缓存，不改卡片内容）
  useEffect(() => {
    if (!virtual) return;
    const raf = requestAnimationFrame(measureRendered);
    return () => cancelAnimationFrame(raf);
  }, [view.start, view.end, list, measureRendered, virtual]);

  // 上下占位：上方用实测、下方用均值；O(n)=列表长度，可忽略
  const { topH, bottomH } = useMemo(() => {
    const avg = avgAdvance();
    let top = 0, bottom = 0;
    for (let i = 0; i < view.start; i++) top += heightsRef.current.get(list[i].id) ?? avg;
    for (let i = view.end; i < total; i++) bottom += heightsRef.current.get(list[i].id) ?? avg;
    return { topH: Math.round(top), bottomH: Math.round(bottom) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.start, view.end, total, list, avgAdvance, heightVersion]);

  /** 扩窗；超过上限时裁掉已测过的头部条目（未测满不裁，避免滚动跳） */
  const grow = useCallback(
    (dir: 'up' | 'down') => {
      if (!virtual || lockRef.current) return;
      const r = rangeRef.current;
      let next: Range;
      if (dir === 'down' && r.end < total) {
        const end = Math.min(total, r.end + STEP);
        let start = r.start;
        if (end - start > MAX_WINDOW) {
          const cut = end - MAX_WINDOW;
          for (let i = r.start; i < cut; i++) if (!heightsRef.current.has(list[i].id)) return;
          start = cut;
        }
        next = { start, end };
      } else if (dir === 'up' && r.start > 0) {
        const start = Math.max(0, r.start - STEP);
        let end = r.end;
        if (end - start > MAX_WINDOW) {
          const cut = start + MAX_WINDOW;
          for (let i = cut; i < r.end; i++) if (!heightsRef.current.has(list[i].id)) return;
          end = cut;
        }
        next = { start, end };
      } else {
        return;
      }
      rangeRef.current = next;
      setRange(next);
      lockRef.current = true;
      requestAnimationFrame(() => {
        lockRef.current = false;
      });
    },
    [list, total, virtual]
  );

  /** 尾窗 seek：一次到列表最后一条；切完后把视口钉在底部，避免停在旧的中段空白 */
  const seekTail = useCallback(() => {
    if (!virtual || lockRef.current || rangeRef.current.end >= total) return;
    const next = { start: Math.max(0, total - MAX_WINDOW), end: total };
    rangeRef.current = next;
    setRange(next);
    lockRef.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const doc = document.scrollingElement || document.documentElement;
        doc.scrollTop = doc.scrollHeight;
        lockRef.current = false;
      })
    );
  }, [total, virtual]);

  // 哨兵进出窗；窗口变化后重连（哨兵位置随 DOM 变了）
  useEffect(() => {
    if (!virtual) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) grow(e.target.getAttribute('data-sentinel') === 'bottom' ? 'down' : 'up');
      },
      { root: null, rootMargin: `${OVERSCAN_PX}px 0px` }
    );
    const top = document.querySelector('[data-sentinel="top"]');
    const bottom = document.querySelector('[data-sentinel="bottom"]');
    if (top) io.observe(top);
    if (bottom) io.observe(bottom);
    return () => io.disconnect();
  }, [view.start, view.end, grow, virtual]);

  // 距底 <300px → 切尾窗（页面滚动容器可能是 window 或 .taro_page，用捕获监听统一处理）
  useEffect(() => {
    if (!virtual) return;
    let raf = 0;
    const onScroll = (e: Event) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const doc = document.scrollingElement || document.documentElement;
        const el = e.target instanceof Element ? (e.target as HTMLElement) : null;
        const st = el ? el.scrollTop : window.scrollY || doc.scrollTop;
        const vh = el ? el.clientHeight : doc.clientHeight;
        const sh = el ? el.scrollHeight : doc.scrollHeight;
        if (sh <= vh + 1) return; // 忽略横向 ScrollView
        if (st + vh >= sh - NEAR_BOTTOM_PX) seekTail();
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener('scroll', onScroll, true); if (raf) cancelAnimationFrame(raf); };
  }, [seekTail, virtual]);

  // 筛选/搜索/刷新：回首窗并清空高度缓存（避免旧高度串到新列表）
  useEffect(() => {
    if (!virtual) return;
    heightsRef.current.clear();
    pendingRef.current = [];
    const next = { start: 0, end: Math.min(FIRST_WINDOW, total) };
    rangeRef.current = next;
    setHeightVersion((v) => v + 1);
    setRange(next);
    // total 故意不进依赖：列表由空变满时不二次重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, virtual]);

  const slice = useMemo(
    () => (virtual ? list.slice(view.start, view.end) : list),
    [list, view.start, view.end, virtual]
  );

  return {
    slice,
    start: view.start,
    end: view.end,
    total,
    topH: virtual ? topH : 0,
    bottomH: virtual ? bottomH : 0,
    loadMore: () => grow('down')
  };
}
