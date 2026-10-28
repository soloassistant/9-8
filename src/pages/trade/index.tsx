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
  atr,
  boll,
  cancelOrder,
  closeAll,
  closePosition,
  closesOf,
  convertCurrency,
  createEngine,
  equityOf,
  feeOf,
  floatingPnlOf,
  floatingTotalOf,
  halfLotsOf,
  macd,
  modifyPosition,
  notionalUsd,
  openMarket,
  performanceOf,
  pipValueUsd,
  placeLimit,
  realizedPnlOf,
  roundTo,
  rsi,
  sma,
  tickEngine,
  usedMarginOf,
  type Candle,
  type EngineState,
  type PendingOrder,
  type Position,
  type Side,
  type Timeframe
} from '@/utils/marketSim';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';

const LEVERAGES = [1, 10, 20, 50, 100, 200, 500];
const BAR_COUNTS = [60, 120, 240];
const ATR_MULTS = [1, 2, 3];
const TICK_MS = 1000;
const AX_W = 56; // 右侧价格轴宽（px）
const TIME_H = 18; // 底部时间轴高（px）
const SPARK_LEN = 40; // 自选迷你走势的收盘根数

const FX_CURRENCIES = ['USD', 'CNH', 'EUR', 'JPY'];
const WATCH_CATS = ['all', 'gold', 'forex'] as const;
const BOOK_TABS = ['positions', 'orders', 'trades'] as const;
const TOOL_TABS = ['calc', 'sizing', 'fx'] as const;

type Indicator = 'rsi' | 'macd';
type BookTab = (typeof BOOK_TABS)[number];
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
  const [leverage, setLeverage] = useState(100);
  const [levOpen, setLevOpen] = useState(false);

  // 下单面板
  const [orderSide, setOrderSide] = useState<Side>('buy');
  const [lots, setLots] = useState('0.10');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [bookTab, setBookTab] = useState<BookTab>('positions');
  const [confirmBox, setConfirmBox] = useState<{ body: string; onOk: () => void } | null>(null);
  const [editing, setEditing] = useState<{ id: string; sl: string; tp: string } | null>(null);

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

  /* ---------- 派生数值（每 tick 重算；都从引擎读，不在 state 里存副本） ---------- */
  const selDef = SYMBOLS.find((d) => d.symbol === selected) ?? SYMBOLS[0];
  const spot = eng ? eng.symbols[selected].spot : selDef.basePrice;
  const prevClose = eng ? eng.symbols[selected].prevClose : selDef.basePrice;
  const lotsNum = Number.parseFloat(lots) || 0;
  const orderPrice = orderType === 'limit' ? Number.parseFloat(limitPrice) || spot : spot;
  const estNotional = notionalUsd(selDef, lotsNum, orderPrice);
  const estMargin = estNotional / Math.max(1, leverage);
  const estFee = feeOf(selDef, lotsNum, orderPrice);
  const estPipValue = pipValueUsd(selDef, spot);
  const equity = eng ? equityOf(eng) : 100000;
  const usedMargin = eng ? usedMarginOf(eng) : 0;
  const freeMargin = equity - usedMargin;
  const floatPnl = eng ? floatingTotalOf(eng) : 0;
  const realizedPnl = eng ? realizedPnlOf(eng.account) : 0;
  const slNum = Number.parseFloat(sl);
  const slLoss = !Number.isNaN(slNum) && lotsNum > 0
    ? (Math.abs(orderPrice - slNum) / selDef.pipSize) * estPipValue * lotsNum
    : null;
  const slLossPct = slLoss !== null && equity > 0 ? (slLoss / equity) * 100 : null;
  const perf = eng
    ? performanceOf(eng)
    : { trades: 0, winRate: null, profitFactor: null, maxDrawdown: null };

  const chartModel = useMemo(
    () => (eng ? buildChartModel(eng, selected, tf, count, page, indicator) : null),
    // tick 是重算钥匙：行情每秒变 → 模型跟着变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eng, selected, tf, count, page, indicator, tick]
  );

  /* ---------- refs：画布容器 / 颜色 / 光标 / 绘制期快照 ---------- */
  const rootRef = useRef<HTMLElement | null>(null);
  const chartBoxRef = useRef<HTMLElement | null>(null);
  const equityBoxRef = useRef<HTMLElement | null>(null);
  const sparkRefs = useRef<Map<string, HTMLElement>>(new Map());
  // 三个独立画布仓：主图底层 / 主图 overlay / 侧栏小图 —— overlay 与底层
  // 必须是两块物理画布（mousemove 只重绘 overlay，tick 才重绘底层），
  // 若共用仓会拿到同一块 canvas，clearRect 会把蜡烛图整个擦掉。
  const baseStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const overlayStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const sideStore = useRef<Map<HTMLElement, HTMLCanvasElement>>(new Map());
  const colorsRef = useRef<ColorMap>({});
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
    const eqBox = equityBoxRef.current;
    if (eqBox) {
      const canvas = ensureCanvas(eqBox, sideStore.current);
      const rect = eqBox.getBoundingClientRect();
      const ctx = canvas && fitCanvas(canvas, rect.width, rect.height);
      if (ctx) {
        ctx.clearRect(0, 0, rect.width, rect.height);
        const pts = eng.account.equityCurve;
        if (pts.length >= 2) {
          let min = Infinity;
          let max = -Infinity;
          for (const p of pts) {
            if (p.equity < min) min = p.equity;
            if (p.equity > max) max = p.equity;
          }
          const pad = (max - min) * 0.15 || 10;
          min -= pad;
          max += pad;
          ctx.strokeStyle = c.gold;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          pts.forEach((p, i) => {
            const x = (i / (pts.length - 1)) * (rect.width - 4) + 2;
            const y = rect.height - 2 - ((p.equity - min) / (max - min)) * (rect.height - 4);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
          // 初始余额基准虚线
          ctx.strokeStyle = c.line;
          ctx.setLineDash([2, 3]);
          const y0 = rect.height - 2 - ((eng.account.initialBalance - min) / (max - min)) * (rect.height - 4);
          ctx.beginPath();
          ctx.moveTo(0, y0);
          ctx.lineTo(rect.width, y0);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = c.dim;
          ctx.font = '10px monospace';
          ctx.fillText(t('trade.equityEmpty'), 6, rect.height / 2);
        }
      }
    }
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
  }, [eng, t]);

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

  /* ---------- 交易动作 ---------- */
  const submitOrder = (): void => {
    if (!eng || lotsNum < 0.01) {
      Taro.showToast({ title: t('trade.errLots'), icon: 'none' });
      return;
    }
    const slV = Number.isNaN(slNum) ? null : slNum;
    const tpNum = Number.parseFloat(tp);
    const tpV = Number.isNaN(tpNum) ? null : tpNum;
    if (orderType === 'market') {
      openMarket(eng, selected, orderSide, lotsNum, Date.now(), slV, tpV);
      Taro.showToast({ title: t('trade.doneMarket'), icon: 'none' });
    } else {
      placeLimit(eng, selected, orderSide, lotsNum, orderPrice, Date.now(), slV, tpV);
      Taro.showToast({ title: t('trade.doneLimit'), icon: 'none' });
      setLimitPrice('');
    }
    setTick((v) => v + 1);
  };

  const askCloseRow = (pos: Position): void => {
    if (!eng) return;
    const est = floatingPnlOf(eng, pos);
    setConfirmBox({
      body: t('trade.confirmCloseBody', {
        lots: pos.lots.toFixed(2),
        symbol: pos.symbol,
        pnl: fmtSigned(est)
      }),
      onOk: () => {
        if (eng) closePosition(eng, pos.id, undefined, Date.now());
        setConfirmBox(null);
        setTick((v) => v + 1);
      }
    });
  };

  const askCloseAll = (): void => {
    if (!eng || eng.account.positions.length === 0) return;
    const est = floatingTotalOf(eng);
    const n = eng.account.positions.length;
    setConfirmBox({
      body: t('trade.confirmCloseAllBody', { n, pnl: fmtSigned(est) }),
      onOk: () => {
        if (eng) closeAll(eng, undefined, Date.now());
        setConfirmBox(null);
        setTick((v) => v + 1);
      }
    });
  };

  const applySlTp = (pos: Position): void => {
    if (!eng || !editing || editing.id !== pos.id) return;
    const slV = Number.parseFloat(editing.sl);
    const tpV = Number.parseFloat(editing.tp);
    modifyPosition(eng, pos.id, Number.isNaN(slV) ? null : slV, Number.isNaN(tpV) ? null : tpV);
    setEditing(null);
    setTick((v) => v + 1);
  };

  /** ATR 止盈损：买入 SL=价−N×ATR / TP=价+N×ATR，卖出镜像 */
  const fillAtr = (mult: number, kind: 'sl' | 'tp'): void => {
    const a = chartModel?.atrVal;
    if (!a) return;
    const base = orderType === 'limit' ? orderPrice : spot;
    const v =
      kind === 'sl'
        ? orderSide === 'buy'
          ? base - mult * a
          : base + mult * a
        : orderSide === 'buy'
          ? base + mult * a
          : base - mult * a;
    const fixed = roundTo(v, selDef.digits).toFixed(selDef.digits);
    if (kind === 'sl') setSl(fixed);
    else setTp(fixed);
  };

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
      {/* ===== 顶部账户条 ===== */}
      <View className={styles.topbar}>
        <View className={styles.demoBadge}>{t('trade.demoBadge')}</View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.netAsset')}</Text>
          <Text className={styles.statValue}>{equity.toFixed(2)}</Text>
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.freeMargin')}</Text>
          <Text className={styles.statValue}>{freeMargin.toFixed(2)}</Text>
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.usedMargin')}</Text>
          <Text className={styles.statValue}>{usedMargin.toFixed(2)}</Text>
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.floatPnl')}</Text>
          <Text className={classnames(styles.statValue, floatPnl >= 0 ? styles.up : styles.down)}>
            {fmtSigned(floatPnl)}
          </Text>
        </View>
        <View className={styles.statItem}>
          <Text className={styles.statLabel}>{t('trade.realizedPnl')}</Text>
          <Text className={classnames(styles.statValue, realizedPnl >= 0 ? styles.up : styles.down)}>
            {fmtSigned(realizedPnl)}
          </Text>
        </View>
        <View className={styles.levWrap}>
          <View className={styles.levBtn} onClick={() => setLevOpen((o) => !o)}>
            1:{leverage} ▾
          </View>
          {levOpen && (
            <View className={styles.levMenu}>
              {LEVERAGES.map((l) => (
                <View
                  key={l}
                  className={classnames(styles.levItem, l === leverage && styles.levItemActive)}
                  onClick={() => {
                    setLeverage(l);
                    eng.account.leverage = l;
                    setLevOpen(false);
                  }}
                >
                  1:{l}
                </View>
              ))}
            </View>
          )}
        </View>
        <View className={styles.feed}>
          <View className={styles.feedDot} />
          <Text>{t('trade.feedLabel')}</Text>
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
        <View className={styles.perfCard}>
          <View className={styles.panelTitle}>{t('trade.perfTitle')}</View>
          <View className={styles.perfGrid}>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.perfWinRate')}</Text>
              <Text className={styles.perfValue}>
                {perf.winRate === null ? '—' : `${(perf.winRate * 100).toFixed(1)}%`}
              </Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.perfProfitFactor')}</Text>
              <Text className={styles.perfValue}>
                {perf.profitFactor === null ? '—' : perf.profitFactor.toFixed(2)}
              </Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.perfTrades')}</Text>
              <Text className={styles.perfValue}>{perf.trades}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.perfMaxDd')}</Text>
              <Text className={styles.perfValue}>
                {perf.maxDrawdown === null ? '—' : `${(perf.maxDrawdown * 100).toFixed(1)}%`}
              </Text>
            </View>
          </View>
          <View
            ref={(el) => {
              equityBoxRef.current = el as HTMLElement | null;
            }}
            className={styles.equityBox}
          />
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

      {/* ===== 右栏：下单 + 持仓/委托/成交 ===== */}
      <View className={styles.rightPanel}>
        <View className={styles.orderCard}>
          <View className={styles.sideTabs}>
            <View
              className={classnames(styles.sideTab, orderSide === 'buy' && styles.sideTabBuy)}
              onClick={() => setOrderSide('buy')}
            >
              {t('trade.sideBuy')}
            </View>
            <View
              className={classnames(styles.sideTab, orderSide === 'sell' && styles.sideTabSell)}
              onClick={() => setOrderSide('sell')}
            >
              {t('trade.sideSell')}
            </View>
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>{t('trade.lots')}</Text>
            <Input className={styles.numInput} type='digit' value={lots} onInput={(e) => setLots(e.detail.value)} />
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>{t('trade.orderType')}</Text>
            <View className={styles.segGroup}>
              <View
                className={classnames(styles.segBtn, orderType === 'market' && styles.segBtnActive)}
                onClick={() => setOrderType('market')}
              >
                {t('trade.typeMarket')}
              </View>
              <View
                className={classnames(styles.segBtn, orderType === 'limit' && styles.segBtnActive)}
                onClick={() => setOrderType('limit')}
              >
                {t('trade.typeLimit')}
              </View>
            </View>
          </View>
          {orderType === 'limit' && (
            <View className={styles.fieldRow}>
              <Text className={styles.fieldLabel}>{t('trade.limitPrice')}</Text>
              <Input
                className={styles.numInput}
                type='digit'
                value={limitPrice}
                placeholder={spot.toFixed(selDef.digits)}
                onInput={(e) => setLimitPrice(e.detail.value)}
              />
            </View>
          )}
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>{t('trade.slLabel')}</Text>
            <Input className={styles.numInput} type='digit' value={sl} onInput={(e) => setSl(e.detail.value)} />
          </View>
          <View className={styles.atrRow}>
            <Text className={styles.fieldLabel}>{t('trade.atrSl')}</Text>
            {ATR_MULTS.map((m) => (
              <View key={m} className={styles.atrBtn} onClick={() => fillAtr(m, 'sl')}>
                {m}×ATR
              </View>
            ))}
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>{t('trade.tpLabel')}</Text>
            <Input className={styles.numInput} type='digit' value={tp} onInput={(e) => setTp(e.detail.value)} />
          </View>
          <View className={styles.atrRow}>
            <Text className={styles.fieldLabel}>{t('trade.atrTp')}</Text>
            {ATR_MULTS.map((m) => (
              <View key={m} className={styles.atrBtn} onClick={() => fillAtr(m, 'tp')}>
                {m}×ATR
              </View>
            ))}
          </View>
          <View className={styles.estGrid}>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estNotional')}</Text>
              <Text className={styles.perfValue}>{estNotional.toFixed(2)}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estMargin')}</Text>
              <Text className={styles.perfValue}>{estMargin.toFixed(2)}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estFee')}</Text>
              <Text className={styles.perfValue}>{estFee.toFixed(2)}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estPipValue')}</Text>
              <Text className={styles.perfValue}>{estPipValue.toFixed(2)}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estMarginPct')}</Text>
              <Text className={styles.perfValue}>{equity > 0 ? `${((estMargin / equity) * 100).toFixed(1)}%` : '—'}</Text>
            </View>
            <View className={styles.perfRow}>
              <Text className={styles.perfLabel}>{t('trade.estSlLoss')}</Text>
              <Text className={styles.perfValue}>
                {slLoss === null ? '—' : `${fmtSigned(-slLoss)} (${slLossPct === null ? '—' : `${slLossPct.toFixed(1)}%`})`}
              </Text>
            </View>
          </View>
          <View
            className={classnames(styles.submitBtn, orderSide === 'buy' ? styles.submitBuy : styles.submitSell)}
            onClick={submitOrder}
          >
            {orderSide === 'buy'
              ? t('trade.submitBuy', { lots: lotsNum.toFixed(2) })
              : t('trade.submitSell', { lots: lotsNum.toFixed(2) })}
          </View>
        </View>

        <View className={styles.bookHead}>
          <View className={styles.bookTabs}>
            {BOOK_TABS.map((tab) => (
              <View
                key={tab}
                className={classnames(styles.bookTab, bookTab === tab && styles.bookTabActive)}
                onClick={() => setBookTab(tab)}
              >
                {t(`trade.tab.${tab}`)}
              </View>
            ))}
          </View>
          {bookTab === 'positions' && eng.account.positions.length > 0 && (
            <View className={styles.closeAllBtn} onClick={askCloseAll}>
              {t('trade.closeAllBtn')}
            </View>
          )}
        </View>
        <View className={styles.bookArea}>
          <View className={styles.bookTable}>
            {bookTab === 'positions' && (
              <>
                {eng.account.positions.length === 0 && (
                  <View className={styles.emptyHint}>{t('trade.emptyPositions')}</View>
                )}
                {eng.account.positions.map((pos) => {
                  const pDef = SYMBOLS.find((d) => d.symbol === pos.symbol) ?? SYMBOLS[0];
                  const pnl = floatingPnlOf(eng, pos);
                  const posMargin = notionalUsd(pDef, pos.lots, pos.openPrice) / Math.max(1, leverage);
                  const retPct = posMargin > 0 ? (pnl / posMargin) * 100 : 0;
                  const half = halfLotsOf(pos.lots);
                  const sNow = eng.symbols[pos.symbol];
                  return (
                    <View key={pos.id} className={styles.posRow}>
                      <View className={styles.posLine}>
                        <Text className={pos.side === 'buy' ? styles.up : styles.down}>
                          {pos.side === 'buy' ? t('trade.sideBuyShort') : t('trade.sideSellShort')} {pos.lots.toFixed(2)}
                          {t('trade.lotsUnit')}
                        </Text>
                        <Text className={classnames(styles.posPnl, pnl >= 0 ? styles.up : styles.down)}>
                          {fmtSigned(pnl)} ({fmtPct(retPct)})
                        </Text>
                      </View>
                      <View className={styles.posLine}>
                        <Text className={styles.dimText}>
                          {pos.symbol} {pos.openPrice.toFixed(pDef.digits)} → {sNow.spot.toFixed(pDef.digits)}
                        </Text>
                        <View className={styles.posBtns}>
                          <View
                            className={classnames(styles.miniBtn, half === null && styles.miniBtnDisabled)}
                            onClick={() => {
                              if (half === null) return;
                              closePosition(eng, pos.id, half, Date.now());
                              setTick((v) => v + 1);
                            }}
                          >
                            {t('trade.halfClose')}
                          </View>
                          <View
                            className={styles.miniBtn}
                            onClick={() =>
                              setEditing((cur) =>
                                cur && cur.id === pos.id
                                  ? null
                                  : {
                                      id: pos.id,
                                      sl: pos.sl === null ? '' : String(pos.sl),
                                      tp: pos.tp === null ? '' : String(pos.tp)
                                    }
                              )
                            }
                          >
                            {t('trade.editSlTp')}
                          </View>
                          <View className={classnames(styles.miniBtn, styles.miniBtnDanger)} onClick={() => askCloseRow(pos)}>
                            {t('trade.closeRow')}
                          </View>
                        </View>
                      </View>
                      {editing && editing.id === pos.id && (
                        <View className={styles.sltpEdit}>
                          <Input
                            className={styles.sltpInput}
                            type='digit'
                            placeholder={t('trade.slLabel')}
                            value={editing.sl}
                            onInput={(e) => setEditing({ ...editing, sl: e.detail.value })}
                          />
                          <Input
                            className={styles.sltpInput}
                            type='digit'
                            placeholder={t('trade.tpLabel')}
                            value={editing.tp}
                            onInput={(e) => setEditing({ ...editing, tp: e.detail.value })}
                          />
                          <View className={styles.miniBtn} onClick={() => applySlTp(pos)}>
                            {t('trade.apply')}
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </>
            )}
            {bookTab === 'orders' && (
              <>
                {eng.account.orders.length === 0 && <View className={styles.emptyHint}>{t('trade.emptyOrders')}</View>}
                {eng.account.orders.map((od: PendingOrder) => (
                  <View key={od.id} className={styles.posRow}>
                    <View className={styles.posLine}>
                      <Text className={od.side === 'buy' ? styles.up : styles.down}>
                        {od.side === 'buy' ? t('trade.sideBuyShort') : t('trade.sideSellShort')} {od.lots.toFixed(2)}
                        {t('trade.lotsUnit')}
                      </Text>
                      <Text className={styles.dimText}>
                        @ {od.limitPrice.toFixed((SYMBOLS.find((d) => d.symbol === od.symbol) ?? SYMBOLS[0]).digits)}
                      </Text>
                    </View>
                    <View className={styles.posLine}>
                      <Text className={styles.dimText}>{od.symbol}</Text>
                      <View className={styles.posBtns}>
                        <View
                          className={styles.miniBtn}
                          onClick={() => {
                            cancelOrder(eng, od.id);
                            setTick((v) => v + 1);
                          }}
                        >
                          {t('trade.orderCancel')}
                        </View>
                      </View>
                    </View>
                  </View>
                ))}
              </>
            )}
            {bookTab === 'trades' && (
              <>
                {eng.account.trades.length === 0 && <View className={styles.emptyHint}>{t('trade.emptyTrades')}</View>}
                {eng.account.trades.slice(0, 30).map((tr) => (
                  <View key={tr.id} className={styles.posRow}>
                    <View className={styles.posLine}>
                      <Text className={tr.side === 'buy' ? styles.up : styles.down}>
                        {tr.side === 'buy' ? t('trade.sideBuyShort') : t('trade.sideSellShort')} {tr.lots.toFixed(2)}
                        {t('trade.lotsUnit')} {tr.symbol}
                      </Text>
                      <Text className={classnames(styles.posPnl, tr.pnl >= 0 ? styles.up : styles.down)}>
                        {fmtSigned(tr.pnl)}
                      </Text>
                    </View>
                    <View className={styles.posLine}>
                      <Text className={styles.dimText}>
                        {tr.openPrice.toFixed(2)} → {tr.closePrice.toFixed(2)}
                      </Text>
                      <Text className={styles.dimText}>
                        -{tr.fee.toFixed(2)} {t('trade.feeUnit')}
                      </Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </View>
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

      {/* ===== 平仓确认弹窗 ===== */}
      {confirmBox && (
        <View className={styles.confirmMask} onClick={() => setConfirmBox(null)}>
          <View
            className={styles.confirmCard}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <View className={styles.confirmTitle}>{t('trade.confirmCloseTitle')}</View>
            <View className={styles.confirmBody}>{confirmBox.body}</View>
            <View className={styles.confirmActions}>
              <View className={styles.btnGhost} onClick={() => setConfirmBox(null)}>
                {t('trade.confirmCancel')}
              </View>
              <View className={styles.btnDanger} onClick={confirmBox.onOk}>
                {t('trade.confirmOk')}
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

export default TradePage;
