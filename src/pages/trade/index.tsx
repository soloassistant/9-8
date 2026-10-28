/**
 * pages/trade —— 专业交易终端（黄金/外汇，模拟行情）。
 *
 * 定位与边界（诚实性铁律）：
 *   · 行情是本仓 utils/marketSim.ts 生成的**固定种子随机游走**，不是真实行情；
 *     顶部左上角常驻「模拟行情 · 演示数据」徽标，账户条标注「模拟 feed」，
 *     不做任何伪装成真实行情的呈现。
 *   · 绩效统计（胜率/盈亏比/回撤）从本会话真实成交记录推导，没有成交显示 —。
 *
 * 结构：顶部账户条 + 左（自选/绩效）中（三窗格图表）右（下单/持仓）+ 底部工具条。
 * 图表用**原生 canvas**（页面内 document.createElement，H5-only 路径）：
 *   · 图表层 + overlay 层两块画布：mousemove 只重绘 overlay（十字光标 + 图例），
 *     tick 才重绘底层；卸载时 removeEventListener 全部清理。
 *   · 颜色经页面根元素的 CSS 自定义属性读取（单一来源仍是 theme.scss 的 $t-term-*）。
 * 非网页端（weapp）渲染「交易终端仅网页版可用」占位，保证双端编译干净。
 *
 * 尺寸说明：本页 module.scss 使用大写 PX（自成体系的桌面终端 UI，需要真实像素，
 * 小写 px 会被 pxtransform 按 375 设计稿换算）——页面级例外，见该文件头部注释。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import { Input, Text, View } from '@tarojs/components';
import classnames from 'classnames';
import { useT } from '@/store/language';
import { isComposing, isEditableTarget } from '@/utils/hotkeys';
import {
  SYMBOLS,
  TIMEFRAMES,
  applyRealSpot,
  atr,
  boll,
  closesOf,
  convertCurrency,
  createEngine,
  equityOf,
  macd,
  pipValueUsd,
  reanchorSeries,
  rsi,
  sma,
  tickEngine,
  type Candle,
  type EngineState,
  type Side,
  type Timeframe
} from '@/utils/marketSim';
import { fetchRealQuotes, FEED_SYMBOL_MAP } from '@/utils/marketFeed';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';

const BAR_COUNTS = [60, 120, 240];
const TICK_MS = 1000;
/** 真实行情轮询间隔。腾讯免密接口按次计费，10s 对单品种足够顺滑也不至于打爆 */
const REAL_FEED_MS = 10000;
const AX_W = 56; // 右侧价格轴宽（px）
const TIME_H = 18; // 底部时间轴高（px）
const SPARK_LEN = 40; // 自选迷你走势的收盘根数

const FX_CURRENCIES = ['USD', 'CNH', 'EUR', 'JPY'];
const WATCH_CATS = ['all', 'gold', 'forex'] as const;
const TOOL_TABS = ['calc', 'sizing', 'fx'] as const;

type Indicator = 'rsi' | 'macd';
type ToolTab = (typeof TOOL_TABS)[number];
type WatchCat = (typeof WATCH_CATS)[number];

/* ============================ 图表模型（渲染期纯计算） ============================ */

interface ChartModel {
  view: Candle[];
  indicator: Indicator;
  ma5: Array<number | null>;
  ma10: Array<number | null>;
  ma20: Array<number | null>;
  ma60: Array<number | null>;
  bollMid: Array<number | null>;
  bollUp: Array<number | null>;
  bollLow: Array<number | null>;
  rsiArr: Array<number | null>;
  macdDif: Array<number | null>;
  macdDea: Array<number | null>;
  macdHist: Array<number | null>;
  atrVal: number | null;
  minP: number;
  maxP: number;
  maxVol: number;
  macdAbs: number;
  spot: number;
  digits: number;
  pagesTotal: number;
}

function buildChartModel(eng: EngineState, symbol: string, tf: Timeframe, count: number, page: number, indicator: Indicator): ChartModel | null {
  const s = eng.symbols[symbol];
  if (!s) return null;
  const all = s.series[tf];
  const end = Math.max(count, all.length - page * count);
  const start = Math.max(0, end - count);
  const view = all.slice(start, end);
  const closes = closesOf(view);
  const b = boll(closes, 20, 2);
  const a = atr(all.slice(Math.max(0, all.length - 60)), 14);
  let atrVal: number | null = null;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== null) {
      atrVal = a[i];
      break;
    }
  }
  // 价格范围：K 线全幅 + BOLL 上下轨（把轨道画进视野）
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of view) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  }
  for (const arr of [b.up, b.low]) {
    for (const v of arr) {
      if (v === null) continue;
      if (v > maxP) maxP = v;
      if (v < minP) minP = v;
    }
  }
  const pad = (maxP - minP) * 0.06 || minP * 0.001;
  minP -= pad;
  maxP += pad;
  let maxVol = 1;
  for (const c of view) if (c.volume > maxVol) maxVol = c.volume;
  let macdAbs = 1e-9;
  const m = macd(closes, 12, 26, 9);
  for (const arr of [m.dif, m.dea, m.hist]) {
    for (const v of arr) if (v !== null && Math.abs(v) > macdAbs) macdAbs = Math.abs(v);
  }
  return {
    view,
    indicator,
    ma5: sma(closes, 5),
    ma10: sma(closes, 10),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    bollMid: b.mid,
    bollUp: b.up,
    bollLow: b.low,
    rsiArr: rsi(closes, 14),
    macdDif: m.dif,
    macdDea: m.dea,
    macdHist: m.hist,
    atrVal,
    minP,
    maxP,
    maxVol,
    macdAbs,
    spot: s.spot,
    digits: s.def.digits,
    pagesTotal: Math.max(1, Math.floor(all.length / count))
  };
}

interface PaneRect { x: number; y: number; w: number; h: number }
interface ChartLayout {
  price: PaneRect;
  vol: PaneRect;
  ind: PaneRect;
  barW: number;
}

/* ============================ 画布小工具（仅 H5 路径调用） ============================ */

function fitCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function ensureCanvas(container: HTMLElement, store: Map<HTMLElement, HTMLCanvasElement>): HTMLCanvasElement | null {
  let canvas = store.get(container);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    // 只把「还在 static 流」的容器升为 relative；像 chartBox 这种本身
    // position:absolute 的定位容器不能覆盖（覆盖会塌成 0 高）。
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(canvas);
    store.set(container, canvas);
  }
  return canvas;
}

type ColorMap = Record<string, string>;

/** 从页面根元素读 CSS 自定义属性 —— 颜色单一来源是 theme.scss 的 $t-term-* token */
function readTermColors(root: HTMLElement | null): ColorMap {
  if (!root) return {};
  const cs = window.getComputedStyle(root);
  const pick = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    bg: pick('--t-bg'),
    panel: pick('--t-panel'),
    line: pick('--t-line'),
    text: pick('--t-text'),
    dim: pick('--t-text-dim'),
    up: pick('--t-up'),
    down: pick('--t-down'),
    gold: pick('--t-gold'),
    ma5: pick('--t-ma5'),
    ma10: pick('--t-ma10'),
    ma20: pick('--t-ma20'),
    ma60: pick('--t-ma60'),
    boll: pick('--t-boll')
  };
}

function fmtSigned(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtTime(ts: number, tf: Timeframe): string {
  const d = new Date(ts);
  if (tf === 'D1') return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ============================ 页面 ============================ */

function TradePage() {
  const t = useT();

  /* ---------- 引擎（进程内惰性建一份；weapp 不建，用不到） ---------- */
  const engineRef = useRef<EngineState | null>(null);
  if (isH5 && engineRef.current === null) engineRef.current = createEngine();
  const eng = engineRef.current;

  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);

  /* ---------- 交互状态 ---------- */
  const [selected, setSelected] = useState('XAUUSD');
  const [watchCat, setWatchCat] = useState<WatchCat>('all');
  const [tf, setTf] = useState<Timeframe>('M5');
  const [count, setCount] = useState(120);
  const [page, setPage] = useState(0); // 0 = 最新一页
  const [indicator, setIndicator] = useState<Indicator>('rsi');

  // 下单面板

  // 底部工具
  const [tool, setTool] = useState<ToolTab>('calc');
  const [calcDir, setCalcDir] = useState<Side>('buy');
  const [calcLots, setCalcLots] = useState('0.10');
  const [calcEntry, setCalcEntry] = useState('');
  const [calcTarget, setCalcTarget] = useState('');
  const [calcSl, setCalcSl] = useState('');
  const [riskPct, setRiskPct] = useState('1');
  const [slPips, setSlPips] = useState('');
  const [fxAmount, setFxAmount] = useState('1000');
  const [fxFrom, setFxFrom] = useState('USD');

  /* ---------- 生命周期：定时器在页面建立、useDidHide/卸载清理 ---------- */
  useDidShow(() => setRunning(true));
  useDidHide(() => setRunning(false));
  useEffect(() => {
    if (!isH5 || !running || !eng) return;
    const timer = setInterval(() => {
      tickEngine(eng, Date.now());
      setTick((v) => v + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [running, eng]);

  /* ---------- 真实行情喂价（黄金现价，腾讯免密源） ----------
     一处收口：真实价通过 applyRealSpot 注入引擎 spot，图表/报价/下单/浮盈全部自然跟随。
     首次成功先 reanchorSeries 把模拟历史锚到真实价（否则会出现断崖K线），
     之后每轮只贴现价。失败静默回退模拟态 —— 报价失败绝不能编一个价格。 */
  const realAnchorDoneRef = useRef(false);
  const [realFeed, setRealFeed] = useState(false);
  useEffect(() => {
    if (!isH5 || !running || !eng) return;
    let alive = true;
    const pull = async () => {
      const quotes = await fetchRealQuotes(Object.values(FEED_SYMBOL_MAP));
      if (!alive || !quotes) return;
      let applied = false;
      for (const [sym, code] of Object.entries(FEED_SYMBOL_MAP)) {
        const q = quotes[code];
        if (!q) continue;
        const nowMs = Date.now();
        if (!realAnchorDoneRef.current) {
          reanchorSeries(eng, sym, q.price, nowMs);
          realAnchorDoneRef.current = true;
        }
        if (applyRealSpot(eng, sym, q.price, q.prevClose, nowMs)) applied = true;
      }
      if (applied) {
        setRealFeed(true);
        setTick((v) => v + 1);
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), REAL_FEED_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running, eng]);

  /* ---------- 派生数值（每 tick 重算；都从引擎读，不在 state 里存副本） ---------- */
  const selDef = SYMBOLS.find((d) => d.symbol === selected) ?? SYMBOLS[0];
  const spot = eng ? eng.symbols[selected].spot : selDef.basePrice;
  const prevClose = eng ? eng.symbols[selected].prevClose : selDef.basePrice;
  const spotChg = prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : 0;
  // 计算器/风控仍需要的派生（现价驱动的纯计算，不下单）
  const estPipValue = pipValueUsd(selDef, spot);
  const equity = eng ? equityOf(eng) : 100000;

  const chartModel = useMemo(
    () => (eng ? buildChartModel(eng, selected, tf, count, page, indicator) : null),
    // tick 是重算钥匙：行情每秒变 → 模型跟着变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eng, selected, tf, count, page, indicator, tick]
  );

  /* ---------- refs：画布容器 / 颜色 / 光标 / 绘制期快照 ---------- */
  const rootRef = useRef<HTMLElement | null>(null);
  const chartBoxRef = useRef<HTMLElement | null>(null);
  const sparkRefs = useRef<Map<string, HTMLElement>>(new Map());
  // 三个独立画布仓：主图底层 / 主图 overlay / 侧栏小图 —— overlay 与底层
  // 必须是两块物理画布（mousemove 只重绘 overlay，tick 才重绘底层），
  // 若共用仓会拿到同一块 canvas，clearRect 会把蜡烛图整个擦掉。
  const baseStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const overlayStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const sideStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const colorsRef = useRef<ColorMap>({});
  // 图表绘制回调刻意用空依赖（走 ref 取值），水印文字也走 ref 以便语言切换后生效
  const simWatermarkRef = useRef(t('trade.simWatermark'));
  simWatermarkRef.current = t('trade.simWatermark');
  const modelRef = useRef<ChartModel | null>(chartModel);
  const layoutRef = useRef<ChartLayout | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const prevCloseRef = useRef(prevClose);
  const selectedRef = useRef(selected);
  modelRef.current = chartModel;
  prevCloseRef.current = prevClose;
  selectedRef.current = selected;

  /* ---------- 挂载：读颜色、放开外壳 20rem 限宽、卸载清理 ---------- */
  useEffect(() => {
    if (!isH5) return;
    colorsRef.current = readTermColors(rootRef.current);
    // 终端页要占满窗口（1280/1920 三栏不塌）：与 briefing 的 body.briefing-desktop
    // 同一手法（app.scss 对应放行），卸载时移除，不污染其它页面。
    document.body.classList.add('trade-terminal');
    setTick((v) => v + 1); // 颜色就位后触发一次绘制
    const base = baseStore.current;
    const overlay = overlayStore.current;
    const side = sideStore.current;
    return () => {
      document.body.classList.remove('trade-terminal');
      for (const store of [base, overlay, side]) {
        store.forEach((canvas) => canvas.remove());
        store.clear();
      }
    };
  }, []);

  /* ---------- 绘制：主图三窗格（K 线 + MA + BOLL / 成交量 / RSI|MACD） ---------- */
  const drawBase = useCallback(() => {
    const box = chartBoxRef.current;
    const model = modelRef.current;
    if (!isH5 || !box || !model) return;
    const canvas = ensureCanvas(box, baseStore.current);
    if (!canvas) return;
    const rect = box.getBoundingClientRect();
    const ctx = fitCanvas(canvas, rect.width, rect.height);
    const c = colorsRef.current;
    if (!ctx || !c.bg) return;
    const W = rect.width;
    const H = rect.height;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);

    const plotW = Math.max(10, W - AX_W);
    const bodyH = Math.max(40, H - TIME_H);
    const priceH = bodyH * 0.58;
    const volH = bodyH * 0.2;
    const indH = bodyH - priceH - volH;
    const price = { x: 0, y: 0, w: plotW, h: priceH };
    const vol = { x: 0, y: priceH, w: plotW, h: volH };
    const ind = { x: 0, y: priceH + volH, w: plotW, h: indH };
    const barW = plotW / model.view.length;
    layoutRef.current = { price, vol, ind, barW };

    const yOf = (v: number): number => price.y + price.h - ((v - model.minP) / (model.maxP - model.minP)) * price.h;

    // 诚实水印：历史K线永远是模拟推演（真实源只覆盖黄金现价）。画在右下角，
    // 避开顶部图例与OHLC读数，保证任何光标位置都可见。
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = c.dim;
    ctx.textAlign = 'right';
    ctx.fillText(simWatermarkRef.current, W - 8, H - TIME_H - 6);
    ctx.textAlign = 'start';
    const line = (arr: Array<number | null>, color: string, map: (v: number) => number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v === null) {
          started = false;
          continue;
        }
        const x = i * barW + barW / 2;
        const y = map(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    };

    // 网格 + 价格轴
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const v = model.minP + ((model.maxP - model.minP) * g) / 4;
      const y = yOf(v);
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.fillStyle = c.dim;
      ctx.textAlign = 'left';
      ctx.fillText(v.toFixed(model.digits), plotW + 4, y);
    }
    for (let g = 1; g < 8; g++) {
      const x = (plotW * g) / 8;
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, bodyH);
      ctx.stroke();
    }

    // 蜡烛（实体最窄 1.5px，细周期下也保持可读的阴阳实体）
    const bw = Math.max(1.5, barW * 0.62);
    for (let i = 0; i < model.view.length; i++) {
      const k = model.view[i];
      const up = k.close >= k.open;
      ctx.strokeStyle = up ? c.up : c.down;
      ctx.fillStyle = up ? c.up : c.down;
      const x = i * barW + barW / 2;
      ctx.beginPath();
      ctx.moveTo(x, yOf(k.high));
      ctx.lineTo(x, yOf(k.low));
      ctx.stroke();
      const yO = yOf(k.open);
      const yC = yOf(k.close);
      const top = Math.min(yO, yC);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1, Math.abs(yC - yO)));
    }

    // BOLL 三轨 + MA
    line(model.bollUp, c.boll, yOf);
    line(model.bollLow, c.boll, yOf);
    line(model.bollMid, c.boll, yOf);
    line(model.ma5, c.ma5, yOf);
    line(model.ma10, c.ma10, yOf);
    line(model.ma20, c.ma20, yOf);
    line(model.ma60, c.ma60, yOf);

    // 最新价虚线 + 价签
    const lastUp = model.spot >= prevCloseRef.current;
    const yLast = yOf(model.spot);
    ctx.strokeStyle = lastUp ? c.up : c.down;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yLast);
    ctx.lineTo(plotW, yLast);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastUp ? c.up : c.down;
    ctx.fillRect(plotW, yLast - 8, AX_W, 16);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(model.spot.toFixed(model.digits), plotW + 4, yLast);

    // 成交量窗格
    const vTop = vol.y + 12;
    const vH = Math.max(4, vol.h - 14);
    for (let i = 0; i < model.view.length; i++) {
      const k = model.view[i];
      const up = k.close >= k.open;
      const h = (k.volume / model.maxVol) * vH;
      ctx.fillStyle = up ? c.up : c.down;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(i * barW + (barW - bw) / 2, vTop + vH - h, bw, h);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(0, vol.y + 0.5);
    ctx.lineTo(plotW, vol.y + 0.5);
    ctx.moveTo(0, vol.y + vol.h - 0.5);
    ctx.lineTo(plotW, vol.y + vol.h - 0.5);
    ctx.stroke();

    // 指标窗格
    const iTop = ind.y + 12;
    const iH = Math.max(4, ind.h - 14);
    if (model.indicator === 'rsi') {
      ctx.strokeStyle = c.line;
      ctx.setLineDash([2, 3]);
      for (const lv of [30, 70]) {
        const y = iTop + iH - (lv / 100) * iH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.fillStyle = c.dim;
        ctx.fillText(String(lv), plotW + 4, y);
      }
      ctx.setLineDash([]);
      line(model.rsiArr, c.ma20, (v) => iTop + iH - (v / 100) * iH);
    } else {
      const y0 = iTop + iH / 2;
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(plotW, y0);
      ctx.stroke();
      const scale = (v: number): number => y0 - (v / model.macdAbs) * (iH / 2);
      for (let i = 0; i < model.macdHist.length; i++) {
        const v = model.macdHist[i];
        if (v === null) continue;
        ctx.fillStyle = v >= 0 ? c.up : c.down;
        const y = scale(v);
        ctx.fillRect(i * barW + (barW - bw) / 2, Math.min(y0, y), bw, Math.abs(y - y0));
      }
      line(model.macdDif, c.ma5, scale);
      line(model.macdDea, c.ma10, scale);
    }

    // 时间轴
    ctx.fillStyle = c.dim;
    const n = model.view.length;
    for (let g = 0; g <= 4; g++) {
      const idx = Math.min(n - 1, Math.round((g / 4) * (n - 1)));
      const x = Math.min(plotW - 44, idx * barW + barW / 2);
      ctx.fillText(fmtTime(model.view[idx].time, tfRef.current), x, H - TIME_H / 2);
    }
    // 窗格分隔线
    ctx.strokeStyle = c.line;
    for (const y of [price.h, price.h + vol.h]) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
  }, []);

  /* ---------- 绘制：overlay（十字光标三窗格联动 + 图例） ---------- */
  const drawOverlay = useCallback(() => {
    const box = chartBoxRef.current;
    const model = modelRef.current;
    const layout = layoutRef.current;
    if (!isH5 || !box || !model || !layout) return;
    const canvas = ensureCanvas(box, overlayStore.current);
    if (!canvas) return;
    const rect = box.getBoundingClientRect();
    const ctx = fitCanvas(canvas, rect.width, rect.height);
    const c = colorsRef.current;
    if (!ctx || !c.bg) return;
    ctx.clearRect(0, 0, rect.width, rect.height);

    const { price, vol, ind, barW } = layout;
    const hover = hoverRef.current;
    const idx = hover
      ? Math.max(0, Math.min(model.view.length - 1, Math.floor(hover.x / barW)))
      : model.view.length - 1;
    const k = model.view[idx];
    const up = k.close >= k.open;

    // 十字线：垂直线贯穿三窗格，水平线只在光标所在窗格（含轴上数值标签）
    if (hover) {
      const x = idx * barW + barW / 2;
      ctx.strokeStyle = c.dim;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ind.y + ind.h);
      ctx.stroke();
      const inPane = (p: PaneRect): boolean => hover.y >= p.y && hover.y <= p.y + p.h;
      for (const p of [price, vol, ind]) {
        if (!inPane(p)) continue;
        ctx.beginPath();
        ctx.moveTo(0, hover.y);
        ctx.lineTo(p.w, hover.y);
        ctx.stroke();
        let label = '';
        if (p === price) {
          const v = model.maxP - ((hover.y - p.y) / p.h) * (model.maxP - model.minP);
          label = v.toFixed(model.digits);
        } else if (p === vol) {
          label = String(Math.round(((p.y + p.h - hover.y) / p.h) * model.maxVol));
        } else if (model.indicator === 'rsi') {
          const v = 100 - ((hover.y - (p.y + 12)) / Math.max(1, p.h - 14)) * 100;
          label = v.toFixed(1);
        } else {
          const mid = p.y + 12 + (p.h - 14) / 2;
          const v = ((mid - hover.y) / Math.max(1, (p.h - 14) / 2)) * model.macdAbs;
          label = v.toFixed(model.digits);
        }
        ctx.setLineDash([]);
        ctx.fillStyle = c.panel;
        ctx.fillRect(p.w, hover.y - 8, AX_W, 16);
        ctx.fillStyle = c.text;
        ctx.fillText(label, p.w + 4, hover.y);
        ctx.setLineDash([3, 3]);
      }
      ctx.setLineDash([]);
    }

    // 图例（三窗格顶部，跟随光标所在 K 线；移出恢复最新一根）
    const legend = (y: number, parts: Array<{ s: string; col: string }>): void => {
      let x = 6;
      ctx.font = '10px monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      for (const p of parts) {
        ctx.fillStyle = p.col;
        ctx.fillText(p.s, x, y);
        x += ctx.measureText(p.s).width + 8;
      }
    };
    const fmt = (v: number): string => v.toFixed(model.digits);
    const dirCol = up ? c.up : c.down;
    const maV = (arr: Array<number | null>): string => (arr[idx] === null ? '—' : fmt(arr[idx] as number));
    legend(4, [
      { s: selectedRef.current, col: c.gold },
      { s: `O ${fmt(k.open)}`, col: dirCol },
      { s: `H ${fmt(k.high)}`, col: dirCol },
      { s: `L ${fmt(k.low)}`, col: dirCol },
      { s: `C ${fmt(k.close)}`, col: dirCol }
    ]);
    legend(18, [
      { s: `MA5 ${maV(model.ma5)}`, col: c.ma5 },
      { s: `MA10 ${maV(model.ma10)}`, col: c.ma10 },
      { s: `MA20 ${maV(model.ma20)}`, col: c.ma20 },
      { s: `MA60 ${maV(model.ma60)}`, col: c.ma60 },
      { s: `BOLL ${maV(model.bollUp)}/${maV(model.bollMid)}/${maV(model.bollLow)}`, col: c.boll }
    ]);
    legend(vol.y + 4, [{ s: `${t('trade.volLabel')} ${k.volume}`, col: c.dim }]);
    if (model.indicator === 'rsi') {
      const v = model.rsiArr[idx];
      legend(ind.y + 4, [{ s: `RSI(14) ${v === null ? '—' : v.toFixed(2)}`, col: c.ma20 }]);
    } else {
      const dv = (v: number | null): string => (v === null ? '—' : v.toFixed(model.digits));
      legend(ind.y + 4, [
        { s: `MACD(12,26,9) DIF ${dv(model.macdDif[idx])}`, col: c.ma5 },
        { s: `DEA ${dv(model.macdDea[idx])}`, col: c.ma10 },
        { s: `HIST ${dv(model.macdHist[idx])}`, col: dirCol }
      ]);
    }
  }, [t]);

  /* ---------- 绘制：净值曲线 + 自选迷你走势 ---------- */
  const drawSideCanvases = useCallback(() => {
    if (!isH5 || !eng) return;
    const c = colorsRef.current;
    if (!c.bg) return;
    // 自选迷你走势（近 SPARK_LEN 根 M5 收盘）
    for (const def of SYMBOLS) {
      const box = sparkRefs.current.get(def.symbol);
      if (!box) continue;
      const canvas = ensureCanvas(box, sideStore.current);
      const rect = box.getBoundingClientRect();
      const ctx = canvas && fitCanvas(canvas, rect.width, rect.height);
      if (!ctx) continue;
      ctx.clearRect(0, 0, rect.width, rect.height);
      const closes = closesOf(eng.symbols[def.symbol].series.M5).slice(-SPARK_LEN);
      if (closes.length < 2) continue;
      let min = Math.min(...closes);
      let max = Math.max(...closes);
      if (max - min < 1e-9) max = min + 1e-9;
      ctx.strokeStyle = closes[closes.length - 1] >= closes[0] ? c.up : c.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      closes.forEach((v, i) => {
        const x = (i / (closes.length - 1)) * rect.width;
        const y = rect.height - 1 - ((v - min) / (max - min)) * (rect.height - 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [eng]);

  /* ---------- 模型变化 → 重绘底层与 overlay ---------- */
  useEffect(() => {
    if (!isH5) return;
    drawBase();
    drawOverlay();
    drawSideCanvases();
  }, [drawBase, drawOverlay, drawSideCanvases, chartModel, tick]);

  /* 只读调试句柄：供 .tools/cdp-probe.mjs --expr 做渲染态探针（K线数/翻页/持仓）。
     只暴露快照读取，不暴露任何改状态的能力。 */
  useEffect(() => {
    if (!isH5) return;
    (window as unknown as Record<string, unknown>).__tradeProbe = {
      model: () => modelRef.current,
      engine: () => engineRef.current
    };
  }, [chartModel]);

  /* ---------- 图表鼠标事件：mousemove 只重绘 overlay，tick 才重绘底层 ---------- */
  useEffect(() => {
    if (!isH5) return;
    const box = chartBoxRef.current;
    if (!box) return;
    const onMove = (e: MouseEvent): void => {
      const r = box.getBoundingClientRect();
      hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      drawOverlay();
    };
    const onLeave = (): void => {
      hoverRef.current = null;
      drawOverlay();
    };
    const onResize = (): void => {
      drawBase();
      drawOverlay();
      drawSideCanvases();
    };
    box.addEventListener('mousemove', onMove);
    box.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);
    return () => {
      box.removeEventListener('mousemove', onMove);
      box.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, [drawOverlay, drawBase, drawSideCanvases]);

  /* ---------- 键盘 ← → 翻页（IME 让路：isComposing / keyCode 229 / 'Process'） ---------- */
  const pageMaxRef = useRef(1);
  pageMaxRef.current = chartModel ? chartModel.pagesTotal - 1 : 1;
  const tfRef = useRef<Timeframe>(tf);
  tfRef.current = tf;
  useEffect(() => {
    if (!isH5) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isComposing(e)) return; // 输入法组字中一律让路
      if (isEditableTarget(e.target)) return; // 输入框聚焦时不劫持方向键
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPage((p) => Math.min(p + 1, pageMaxRef.current));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPage((p) => Math.max(p - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 底部工具：盈亏计算器（切方向镜像目标价/止损价）
  const switchCalcDir = (): void => {
    const next: Side = calcDir === 'buy' ? 'sell' : 'buy';
    const entry = Number.parseFloat(calcEntry);
    if (!Number.isNaN(entry)) {
      const mirror = (v: string, setter: (s: string) => void): void => {
        const num = Number.parseFloat(v);
        if (!Number.isNaN(num)) setter((2 * entry - num).toFixed(selDef.digits));
      };
      mirror(calcTarget, setCalcTarget);
      mirror(calcSl, setCalcSl);
    }
    setCalcDir(next);
  };

  const calcEntryN = Number.parseFloat(calcEntry);
  const calcTargetN = Number.parseFloat(calcTarget);
  const calcSlN = Number.parseFloat(calcSl);
  const calcLotsN = Number.parseFloat(calcLots) || 0;
  const calcPoints = !Number.isNaN(calcEntryN) && !Number.isNaN(calcTargetN)
    ? Math.abs(calcTargetN - calcEntryN) / selDef.pipSize
    : null;
  const calcPnl = calcPoints !== null
    ? ((calcTargetN - calcEntryN) / selDef.pipSize) * (calcDir === 'buy' ? 1 : -1) * estPipValue * calcLotsN
    : null;
  const calcRR =
    !Number.isNaN(calcEntryN) && !Number.isNaN(calcTargetN) && !Number.isNaN(calcSlN) && Math.abs(calcEntryN - calcSlN) > 1e-12
      ? Math.abs(calcTargetN - calcEntryN) / Math.abs(calcEntryN - calcSlN)
      : null;
  const calcGrade = calcRR === null ? null : calcRR >= 3 ? 'A' : calcRR >= 2 ? 'B' : calcRR >= 1 ? 'C' : 'D';

  // 仓位风控：反推建议手数
  const riskN = Number.parseFloat(riskPct) || 0;
  const slPipsN = Number.parseFloat(slPips) || 0;
  const suggestLots =
    riskN > 0 && slPipsN > 0
      ? Math.max(0.01, Math.floor(((equity * riskN) / 100 / (slPipsN * estPipValue)) * 100) / 100)
      : null;

  const fxAmountN = Number.parseFloat(fxAmount) || 0;

  /* ---------- 非网页端：占位（hooks 已全部走完，保持调用顺序稳定） ---------- */
  if (!isH5) {
    return (
      <View className={styles.page}>
        <View className={styles.weappHint}>
          <Text>{t('trade.desktopOnly')}</Text>
        </View>
      </View>
    );
  }
  if (!eng) return null;

  const watchList = SYMBOLS.filter(
    (d) => watchCat === 'all' || d.category === watchCat
  );
  const clock = fmtClock(eng.lastTickAt);

  return (
    <View
      ref={(el) => {
        rootRef.current = el as HTMLElement | null;
      }}
      className={styles.page}
    >
      {/* ===== 顶部行情条（只读分析版：无账户、无杠杆、无下单） ===== */}
      <View className={styles.topbar}>
        {/* 返回入口：≥1024px 时外壳 TabBar 被 .trade-terminal 隐藏（终端占满窗口），
            这个页面自己就成了唯一的离场通道。没有它，用户在桌面端只能靠浏览器后退。 */}
        <View
          className={styles.backBtn}
          onClick={() => {
            Taro.navigateBack().catch(() => {
              // 直接从外链/刷新进入时没有上一页：回晨报（tabBar 页只能 switchTab）
              Taro.switchTab({ url: '/pages/briefing/index' }).catch((err) => {
                console.error('[TradePage] 返回晨报失败:', err);
              });
            });
          }}
        >
          <Text className={styles.backIcon}>←</Text>
          <Text className={styles.backLabel}>{t('trade.back')}</Text>
        </View>
        <View className={styles.demoBadge}>
          {realFeed ? t('trade.feedRealBadge') : t('trade.demoBadge')}
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{selDef.nameZh}</Text>
          <Text className={classnames(styles.statValue, spotChg >= 0 ? styles.up : styles.down)}>
            {spot.toFixed(selDef.digits)}
          </Text>
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.changePct')}</Text>
          <Text className={classnames(styles.statValue, spotChg >= 0 ? styles.up : styles.down)}>
            {fmtPct(spotChg)}
          </Text>
        </View>
        <View className={styles.feed}>
          <View className={classnames(styles.feedDot, realFeed && styles.feedDotReal)} />
          <Text>{t(realFeed ? 'trade.feedLabelReal' : 'trade.feedLabel')}</Text>
        </View>
        <View className={styles.clock}>
          <Text>{clock}</Text>
        </View>
      </View>

      {/* ===== 左栏：自选行情 + 绩效 + 净值曲线 ===== */}
      <View className={styles.leftPanel}>
        <View className={styles.panelTitle}>{t('trade.watchlist')}</View>
        <View className={styles.wlTabs}>
          {WATCH_CATS.map((cat) => (
            <View
              key={cat}
              className={classnames(styles.wlTab, watchCat === cat && styles.wlTabActive)}
              onClick={() => setWatchCat(cat)}
            >
              {t(`trade.cat.${cat}`)}
            </View>
          ))}
        </View>
        <View className={styles.wlList}>
          {watchList.map((def) => {
            const s = eng.symbols[def.symbol];
            const chg = s.prevClose > 0 ? ((s.spot - s.prevClose) / s.prevClose) * 100 : 0;
            return (
              <View
                key={def.symbol}
                className={classnames(styles.wlRow, selected === def.symbol && styles.wlRowActive)}
                onClick={() => setSelected(def.symbol)}
              >
                <View>
                  <View className={styles.wlName}>{def.nameZh}</View>
                  <View className={styles.wlSym}>{def.symbol}</View>
                </View>
                <View
                  ref={(el) => {
                    if (el) sparkRefs.current.set(def.symbol, el as HTMLElement);
                  }}
                  className={styles.wlSpark}
                />
                <View className={styles.wlRight}>
                  <Text className={classnames(styles.wlPrice, chg >= 0 ? styles.up : styles.down)}>
                    {s.spot.toFixed(def.digits)}
                  </Text>
                  <Text className={classnames(styles.wlChange, chg >= 0 ? styles.up : styles.down)}>
                    {fmtPct(chg)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      {/* ===== 中栏：三窗格图表 ===== */}
      <View className={styles.centerPanel}>
        <View className={styles.chartToolbar}>
          <View className={styles.ctGroup}>
            {TIMEFRAMES.map((f) => (
              <View
                key={f}
                className={classnames(styles.ctBtn, tf === f && styles.ctBtnActive)}
                onClick={() => {
                  setTf(f);
                  setPage(0);
                }}
              >
                {t(`trade.tf.${f}`)}
              </View>
            ))}
          </View>
          <View className={styles.ctDivider} />
          <View className={styles.ctGroup}>
            {BAR_COUNTS.map((n) => (
              <View
                key={n}
                className={classnames(styles.ctBtn, count === n && styles.ctBtnActive)}
                onClick={() => {
                  setCount(n);
                  setPage(0);
                }}
              >
                {n}
              </View>
            ))}
          </View>
          <View className={styles.ctDivider} />
          <View className={styles.ctGroup}>
            {(['rsi', 'macd'] as const).map((m) => (
              <View
                key={m}
                className={classnames(styles.ctBtn, indicator === m && styles.ctBtnActive)}
                onClick={() => setIndicator(m)}
              >
                {m.toUpperCase()}
              </View>
            ))}
          </View>
          <View className={styles.pageIndicator}>
            {t('trade.pageIndicator', { cur: page + 1, total: chartModel?.pagesTotal ?? 1 })}
          </View>
          <View className={styles.keyHint}>{t('trade.keyHint')}</View>
        </View>
        <View className={styles.chartWrap}>
          <View
            ref={(el) => {
              chartBoxRef.current = el as HTMLElement | null;
            }}
            className={styles.chartBox}
          />
        </View>
      </View>

      {/* ===== 底部工具条 ===== */}
      <View className={styles.bottomBar}>
        <View className={styles.toolTabs}>
          {TOOL_TABS.map((m) => (
            <View
              key={m}
              className={classnames(styles.toolTab, tool === m && styles.toolTabActive)}
              onClick={() => setTool(m)}
            >
              {t(`trade.tool.${m}`)}
            </View>
          ))}
        </View>
        {tool === 'calc' && (
          <View className={styles.toolPanel}>
            <View className={styles.toolField}>
              <View className={classnames(styles.segBtn, styles.segBtnWide, calcDir === 'buy' && styles.segBtnActive)} onClick={switchCalcDir}>
                {calcDir === 'buy' ? t('trade.sideBuyShort') : t('trade.sideSellShort')}
              </View>
            </View>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.lots')}</Text>
              <Input className={styles.toolInput} type='digit' value={calcLots} onInput={(e) => setCalcLots(e.detail.value)} />
            </View>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.calcEntry')}</Text>
              <Input className={styles.toolInput} type='digit' value={calcEntry} onInput={(e) => setCalcEntry(e.detail.value)} />
            </View>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.calcTarget')}</Text>
              <Input className={styles.toolInput} type='digit' value={calcTarget} onInput={(e) => setCalcTarget(e.detail.value)} />
            </View>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.slLabel')}</Text>
              <Input className={styles.toolInput} type='digit' value={calcSl} onInput={(e) => setCalcSl(e.detail.value)} />
            </View>
            <View className={styles.toolResult}>
              <View className={styles.resItem}>
                <Text className={styles.resLabel}>{t('trade.calcPoints')}</Text>
                <Text className={styles.resValue}>{calcPoints === null ? '—' : calcPoints.toFixed(1)}</Text>
              </View>
              <View className={styles.resItem}>
                <Text className={styles.resLabel}>{t('trade.calcPnl')}</Text>
                <Text className={classnames(styles.resValue, (calcPnl ?? 0) >= 0 ? styles.up : styles.down)}>
                  {calcPnl === null ? '—' : fmtSigned(calcPnl)}
                </Text>
              </View>
              <View className={styles.resItem}>
                <Text className={styles.resLabel}>{t('trade.calcRR')}</Text>
                <Text className={styles.resValue}>{calcRR === null ? t('trade.needSl') : `${calcRR.toFixed(2)} ${calcGrade}`}</Text>
              </View>
            </View>
          </View>
        )}
        {tool === 'sizing' && (
          <View className={styles.toolPanel}>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.sizingRisk')}</Text>
              <Input className={styles.toolInput} type='digit' value={riskPct} onInput={(e) => setRiskPct(e.detail.value)} />
            </View>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.sizingDist')}</Text>
              <Input className={styles.toolInput} type='digit' value={slPips} onInput={(e) => setSlPips(e.detail.value)} />
            </View>
            <View className={styles.toolResult}>
              <View className={styles.resItem}>
                <Text className={styles.resLabel}>{t('trade.sizingResult')}</Text>
                <Text className={styles.resValue}>
                  {suggestLots === null ? '—' : `${suggestLots.toFixed(2)} ${t('trade.lotsUnit')}`}
                </Text>
              </View>
            </View>
          </View>
        )}
        {tool === 'fx' && (
          <View className={styles.toolPanel}>
            <View className={styles.toolField}>
              <Text className={styles.toolLabel}>{t('trade.fxAmount')}</Text>
              <Input className={styles.toolInput} type='digit' value={fxAmount} onInput={(e) => setFxAmount(e.detail.value)} />
            </View>
            <View className={styles.toolSegs}>
              {FX_CURRENCIES.map((cur) => (
                <View
                  key={cur}
                  className={classnames(styles.segBtn, fxFrom === cur && styles.segBtnActive)}
                  onClick={() => setFxFrom(cur)}
                >
                  {cur}
                </View>
              ))}
            </View>
            <View className={styles.toolResult}>
              {FX_CURRENCIES.filter((cur) => cur !== fxFrom).map((cur) => (
                <View key={cur} className={styles.resItem}>
                  <Text className={styles.resLabel}>{cur}</Text>
                  <Text className={styles.resValue}>{convertCurrency(eng, fxAmountN, fxFrom, cur).toFixed(2)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>


    </View>
  );
}

export default TradePage;
