/**
 * marketSim.ts —— 黄金/外汇**模拟行情**引擎（纯函数 + 独立模块）。
 *
 * 定位：给 pages/trade 的专业交易终端页提供一套**可脱离页面单测**的行情与
 * 交易账本逻辑。页面只做两件事：喂事件（tick / 下单 / 平仓）、画结果。
 * 算法全部下沉在这里 —— 与本仓「算法下沉 utils、页面只喂事件」的硬约束一致。
 *
 * 诚实性：这套行情是**固定种子随机游走**，不是真实行情。页面在显眼位置
 * （左上角徽标 + 账户条「模拟 feed」）持续标注「模拟行情 · 演示数据」，
 * 不做任何伪装成真实行情的呈现（AGENTS.md §8.1）。
 *
 * 确定性设计：
 *   - 每个品种 × 每个周期的序列由「品种名 + 周期」派生的固定种子生成，
 *     同参数结果逐字节一致 → 切周期 / 键盘翻页不会跳变；
 *   - 三套序列（M5/H1/D1）各自独立生成，末根收盘统一锚定到当前现货价，
 *     因此三张图的「现在」是同一个价；
 *   - tick 也走品种自己的随机流（继续同一序列），进程内可复现。
 */

/* ============================ 基础类型 ============================ */

export type Timeframe = 'M5' | 'H1' | 'D1';

export interface Candle {
  time: number; // 毫秒时间戳（K 线起点）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolDef {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: 'gold' | 'forex';
  /** 合约规模：XAUUSD 100 盎司/手；外汇 100000 基准货币/手 */
  contractSize: number;
  /** 初始锚定价（也是「现在」的现货价起点） */
  basePrice: number;
  /** 报价小数位 */
  digits: number;
  /** 一个点（pip）的价格步长：XAU 0.1、五位数外汇 0.0001、JPY 0.01、CNH 0.0001 */
  pipSize: number;
  /** 每根 K 线的相对波动率（随机游走步长 / 价格） */
  volatility: number;
}

export type Side = 'buy' | 'sell';

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  openTime: number;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  limitPrice: number;
  sl: number | null;
  tp: number | null;
  createdAt: number;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  openPrice: number;
  closePrice: number;
  /** 已实现盈亏（含手续费，净额，USD） */
  pnl: number;
  fee: number;
  closedAt: number;
}

export interface Account {
  /** 初始余额 100,000 USD；不含浮动盈亏 */
  balance: number;
  initialBalance: number;
  leverage: number;
  positions: Position[];
  orders: PendingOrder[];
  trades: TradeRecord[];
  /** 净值曲线采样点：每笔成交（含初始点）记录一次 (时间, 净值) */
  equityCurve: Array<{ t: number; equity: number }>;
  nextId: number;
}

export interface SymbolState {
  def: SymbolDef;
  /** 当前现货价（三套序列的末根收盘都锚定它） */
  spot: number;
  /** 当日开盘价附近参照，用于涨跌幅展示 */
  prevClose: number;
  series: Record<Timeframe, Candle[]>;
  /** tick 随机流（每品种独立，进程内确定） */
  rng: () => number;
}

export interface EngineState {
  account: Account;
  symbols: Record<string, SymbolState>;
  symbolOrder: string[];
  lastTickAt: number;
}

export interface Performance {
  trades: number;
  winRate: number | null; // 0-1，无成交为 null
  profitFactor: number | null; // 盈亏比（平均盈利/平均亏损），无亏损单时 null
  maxDrawdown: number | null; // 相对峰值回落的最大百分比 0-1，无成交为 null
}

/* ============================ 品种表 ============================ */

export const SYMBOLS: SymbolDef[] = [
  {
    symbol: 'XAUUSD',
    nameZh: '现货黄金',
    nameEn: 'Gold Spot',
    category: 'gold',
    contractSize: 100,
    basePrice: 4120.5,
    digits: 2,
    pipSize: 0.1,
    volatility: 0.0022
  },
  {
    symbol: 'EURUSD',
    nameZh: '欧元/美元',
    nameEn: 'EUR/USD',
    category: 'forex',
    contractSize: 100000,
    basePrice: 1.13384,
    digits: 5,
    pipSize: 0.0001,
    volatility: 0.0006
  },
  {
    symbol: 'GBPUSD',
    nameZh: '英镑/美元',
    nameEn: 'GBP/USD',
    category: 'forex',
    contractSize: 100000,
    basePrice: 1.33915,
    digits: 5,
    pipSize: 0.0001,
    volatility: 0.0008
  },
  {
    symbol: 'USDJPY',
    nameZh: '美元/日元',
    nameEn: 'USD/JPY',
    category: 'forex',
    contractSize: 100000,
    basePrice: 157.03,
    digits: 3,
    pipSize: 0.01,
    volatility: 0.0006
  },
  {
    symbol: 'AUDUSD',
    nameZh: '澳元/美元',
    nameEn: 'AUD/USD',
    category: 'forex',
    contractSize: 100000,
    basePrice: 0.6475,
    digits: 5,
    pipSize: 0.0001,
    volatility: 0.0009
  },
  {
    symbol: 'USDCNH',
    nameZh: '美元/离岸人民币',
    nameEn: 'USD/CNH',
    category: 'forex',
    contractSize: 100000,
    basePrice: 7.0875,
    digits: 4,
    pipSize: 0.0001,
    volatility: 0.0005
  }
];

export const TIMEFRAMES: Timeframe[] = ['M5', 'H1', 'D1'];

/** 每个周期序列长度：600 根 → 240 根/页时可向后翻 2 页 */
export const SERIES_LEN = 600;

/** 时间框架 → 毫秒 */
export function tfMs(tf: Timeframe): number {
  if (tf === 'M5') return 5 * 60 * 1000;
  if (tf === 'H1') return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** 名义价值（USD，近似：USD 计价直乘，USD 为基准的按现货折算） */
export function notionalUsd(def: SymbolDef, lots: number, price: number): number {
  // XAUUSD / *USD 报价：名义 = 手数 × 合约 × 价
  // USDJPY / USDCNH（USD 为基准）：名义 = 手数 × 合约 × 价 ÷ 价 = 手数 × 合约（USD）
  if (def.symbol.startsWith('USD')) return lots * def.contractSize;
  return lots * def.contractSize * price;
}

/** 手续费：名义 × 0.005%（模拟费率，页面明示） */
export const FEE_RATE = 0.00005;

export function feeOf(def: SymbolDef, lots: number, price: number): number {
  return notionalUsd(def, lots, price) * FEE_RATE;
}

/** 每点价值：1 个 pip × 1 手，折 USD */
export function pipValueUsd(def: SymbolDef, price: number): number {
  const perLot = def.contractSize * def.pipSize;
  if (def.symbol.startsWith('USD')) {
    // 报价货币是 USD（XAUUSD、*USD）→ 直接是 USD
    return perLot;
  }
  // USD 为基准（USDJPY/USDCNH）→ 盈亏以报价货币计，除以现货折 USD
  return perLot / price;
}

/** 把「报价货币计价的盈亏」折成 USD */
export function toUsd(def: SymbolDef, quoteAmount: number, spot: number): number {
  if (def.symbol.startsWith('USD')) return quoteAmount; // 报价货币即 USD（XAUUSD、*USD）
  return quoteAmount / spot; // USDJPY/USDCNH：盈亏在 JPY/CNH，除以现货
}

/** 持仓浮动盈亏（USD） */
export function floatingPnlOf(state: EngineState, pos: Position): number {
  const s = state.symbols[pos.symbol];
  if (!s) return 0;
  const diff = pos.side === 'buy' ? s.spot - pos.openPrice : pos.openPrice - s.spot;
  return toUsd(s.def, diff * pos.lots * s.def.contractSize, s.spot);
}

/** 占用保证金 = Σ(手数 × 合约 × 开仓价名义) ÷ 杠杆（USD 基准对直乘合约） */
export function usedMarginOf(state: EngineState): number {
  let sum = 0;
  for (const pos of state.account.positions) {
    const s = state.symbols[pos.symbol];
    if (!s) continue;
    sum += notionalUsd(s.def, pos.lots, pos.openPrice);
  }
  return sum / Math.max(1, state.account.leverage);
}

export function realizedPnlOf(account: Account): number {
  return account.trades.reduce((acc, tr) => acc + tr.pnl, 0);
}

export function floatingTotalOf(state: EngineState): number {
  return state.account.positions.reduce((acc, pos) => acc + floatingPnlOf(state, pos), 0);
}

/** 净值 = 余额 + 浮动盈亏（余额已含已实现盈亏） */
export function equityOf(state: EngineState): number {
  return state.account.balance + floatingTotalOf(state);
}

/* ============================ 随机数与序列生成 ============================ */

/** mulberry32：小而快的确定性 PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 生成一个品种一个周期的 K 线序列（确定性）。
 * 形状：随机游走 + 两组正弦叠加（慢趋势 + 中周期摆动），
 * 让 240 根视野里能看到明显的波段，而不是纯噪声。
 * 生成后整体平移，使末根收盘 = 锚定价（三套序列的「现在」一致）。
 */
export function generateSeries(def: SymbolDef, tf: Timeframe, nowMs: number, anchorPrice: number): Candle[] {
  const rng = mulberry32(seedFrom(`${def.symbol}|${tf}|v1`));
  const step = tfMs(tf);
  const start = Math.floor(nowMs / step) * step;
  // 从锚定价往回生成：close[i] 由 close[i+1] 反推，天然末根=锚定
  const closes = new Array<number>(SERIES_LEN);
  closes[SERIES_LEN - 1] = anchorPrice;
  const vol = def.volatility * Math.sqrt(step / (60 * 1000)) * 0.35; // 周期越大波动越大
  const phase1 = (seedFrom(def.symbol) % 7) * 1.1;
  const phase2 = (seedFrom(def.symbol) % 11) * 0.7;
  for (let i = SERIES_LEN - 2; i >= 0; i--) {
    // 慢趋势 + 中周期摆动（相对幅度与单根波动同量级），让 240 根视野里有明显波段
    const wave = Math.sin(i * 0.045 + phase1) * 0.9 + Math.sin(i * 0.011 + phase2) * 1.3;
    const drift = (rng() - 0.5) * 2 * vol;
    closes[i] = closes[i + 1] * (1 - drift - wave * vol * 0.55);
  }
  const candles: Candle[] = [];
  for (let i = 0; i < SERIES_LEN; i++) {
    const open = i === 0 ? closes[0] - (rng() - 0.5) * vol * closes[0] : closes[i - 1];
    const close = closes[i];
    const body = Math.abs(close - open);
    const hi = Math.max(open, close) + body * rng() * 0.9 + close * vol * 0.25 * rng();
    const lo = Math.min(open, close) - body * rng() * 0.9 - close * vol * 0.25 * rng();
    candles.push({
      time: start - (SERIES_LEN - 1 - i) * step,
      open: roundTo(open, def.digits),
      high: roundTo(hi, def.digits),
      low: roundTo(lo, def.digits),
      close: roundTo(close, def.digits),
      volume: Math.round(400 + rng() * 1600)
    });
  }
  return candles;
}

export function roundTo(v: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

/* ============================ 技术指标（纯函数） ============================ */

/** 简单移动平均：前 n-1 个位置为 null */
export function sma(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均：首个值用首收盘 seeding */
export function ema(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface Boll { mid: Array<number | null>; up: Array<number | null>; low: Array<number | null> }

/** BOLL(N, K)：中轨 SMA(N)，上下轨 ±K 倍标准差 */
export function boll(closes: number[], period = 20, k = 2): Boll {
  const mid = sma(closes, period);
  const up: Array<number | null> = new Array(closes.length).fill(null);
  const low: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - m) * (closes[j] - m);
    const sd = Math.sqrt(sq / period);
    up[i] = m + k * sd;
    low[i] = m - k * sd;
  }
  return { mid, up, low };
}

/** RSI(N)：Wilder 平滑 */
export function rsi(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface Macd { dif: Array<number | null>; dea: Array<number | null>; hist: Array<number | null> }

/** MACD(12,26,9)：DIF=EMA12-EMA26，DEA=EMA9(DIF)，HIST=(DIF-DEA)×2 */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): Macd {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const difRaw: number[] = [];
  const difIdx: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] !== null && es[i] !== null) {
      difRaw.push((ef[i] as number) - (es[i] as number));
      difIdx.push(i);
    }
  }
  const deaSub = ema(difRaw, signal);
  const dif: Array<number | null> = new Array(closes.length).fill(null);
  const dea: Array<number | null> = new Array(closes.length).fill(null);
  const hist: Array<number | null> = new Array(closes.length).fill(null);
  for (let j = 0; j < difIdx.length; j++) {
    const i = difIdx[j];
    dif[i] = difRaw[j];
    dea[i] = deaSub[j];
    if (deaSub[j] !== null) hist[i] = (difRaw[j] - (deaSub[j] as number)) * 2;
  }
  return { dif, dea, hist };
}

export function trueRange(c: Candle, prevClose: number | null): number {
  if (prevClose === null) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** ATR(N)：Wilder 平滑，返回与输入对齐的数组（前 N 位 null） */
export function atr(candles: Candle[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(candles[i], candles[i - 1].close);
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trueRange(candles[i], candles[i - 1].close)) / period;
    out[i] = prev;
  }
  return out;
}

/** 收盘价序列快捷方式 */
export function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/* ============================ 引擎 ============================ */

export interface CreateEngineOptions {
  nowMs?: number;
  initialBalance?: number;
  leverage?: number;
}

/**
 * 建引擎：全部品种的三套序列 + 初始账户（余额 100,000 USD、无持仓）。
 * 纯函数式入口：不碰全局状态、不设定时器 —— 定时器归页面管。
 */
export function createEngine(opts: CreateEngineOptions = {}): EngineState {
  const nowMs = opts.nowMs ?? Date.now();
  const initialBalance = opts.initialBalance ?? 100000;
  const leverage = opts.leverage ?? 100;
  const symbols: Record<string, SymbolState> = {};
  for (const def of SYMBOLS) {
    const spot = def.basePrice;
    const series = {
      M5: generateSeries(def, 'M5', nowMs, spot),
      H1: generateSeries(def, 'H1', nowMs, spot),
      D1: generateSeries(def, 'D1', nowMs, spot)
    };
    symbols[def.symbol] = {
      def,
      spot,
      prevClose: series.D1[SERIES_LEN - 2].close,
      series,
      rng: mulberry32(seedFrom(`${def.symbol}|tick|v1`))
    };
  }
  const account: Account = {
    balance: initialBalance,
    initialBalance,
    leverage,
    positions: [],
    orders: [],
    trades: [],
    equityCurve: [{ t: nowMs, equity: initialBalance }],
    nextId: 1
  };
  return { account, symbols, symbolOrder: SYMBOLS.map((d) => d.symbol), lastTickAt: nowMs };
}

/**
 * 一跳行情：每品种现货小幅随机波动 → 更新三套序列的末根 K 线
 * （收盘/最高/最低/量）→ 触及的限价单自动成交。
 * 原地修改 state；返回本跳成交的订单数（页面可用于提示）。
 */
/** 末根 K 线跟随现货：跨过当前周期边界则开新 K（tick 与真实价注入共用同一条路） */
function followSpotWithSeries(s: SymbolState, nowMs: number, rng: () => number): void {
  for (const tf of TIMEFRAMES) {
    const arr = s.series[tf];
    const bucket = Math.floor(nowMs / tfMs(tf)) * tfMs(tf);
    const last = arr[arr.length - 1];
    if (bucket > last.time) {
      arr.push({
        time: bucket,
        open: s.spot,
        high: s.spot,
        low: s.spot,
        close: s.spot,
        volume: Math.round(50 + rng() * 200)
      });
      if (arr.length > SERIES_LEN) arr.shift();
    } else {
      last.close = s.spot;
      if (s.spot > last.high) last.high = s.spot;
      if (s.spot < last.low) last.low = s.spot;
      last.volume += Math.round(rng() * 8);
    }
  }
}

export function tickEngine(state: EngineState, nowMs: number): number {
  state.lastTickAt = nowMs;
  let filled = 0;
  for (const sym of state.symbolOrder) {
    const s = state.symbols[sym];
    const def = s.def;
    // 现货微幅波动（相对波动率的 1/40 每秒，随机流延续）
    const step = s.spot * def.volatility * 0.025 * (s.rng() - 0.5) * 2;
    s.spot = Math.max(roundTo(s.spot + step, def.digits), def.pipSize);
    followSpotWithSeries(s, nowMs, s.rng);
    // 涨跌幅基准（prevClose）保持当日锚定不随 tick 走，涨跌幅才有意义
  }
  // 限价单触发：买入挂单在现货 ≤ 限价时成交，卖出反之
  const remain: PendingOrder[] = [];
  for (const od of state.account.orders) {
    const s = state.symbols[od.symbol];
    if (!s) continue;
    const hit = od.side === 'buy' ? s.spot <= od.limitPrice : s.spot >= od.limitPrice;
    if (hit) {
      openPosition(state, od.symbol, od.side, od.lots, od.limitPrice, od.sl, od.tp, nowMs);
      filled++;
    } else {
      remain.push(od);
    }
  }
  state.account.orders = remain;
  return filled;
}

/** 市价/限价成交共用的开仓：挂手续费（净额进余额），刷新净值曲线 */
function openPosition(
  state: EngineState,
  symbol: string,
  side: Side,
  lots: number,
  price: number,
  sl: number | null,
  tp: number | null,
  nowMs: number
): Position {
  const s = state.symbols[symbol];
  const fee = feeOf(s.def, lots, price);
  state.account.balance -= fee;
  const pos: Position = {
    id: `P${state.account.nextId++}`,
    symbol,
    side,
    lots: roundTo(lots, 2),
    openPrice: roundTo(price, s.def.digits),
    sl,
    tp,
    openTime: nowMs
  };
  state.account.positions.push(pos);
  sampleEquity(state, nowMs);
  return pos;
}

/** 市价下单 */
export function openMarket(
  state: EngineState,
  symbol: string,
  side: Side,
  lots: number,
  nowMs: number,
  sl: number | null = null,
  tp: number | null = null
): Position {
  return openPosition(state, symbol, side, lots, state.symbols[symbol].spot, sl, tp, nowMs);
}

/** 限价挂单 */
export function placeLimit(
  state: EngineState,
  symbol: string,
  side: Side,
  lots: number,
  limitPrice: number,
  nowMs: number,
  sl: number | null = null,
  tp: number | null = null
): PendingOrder {
  const od: PendingOrder = {
    id: `O${state.account.nextId++}`,
    symbol,
    side,
    lots: roundTo(lots, 2),
    limitPrice: roundTo(limitPrice, state.symbols[symbol].def.digits),
    sl,
    tp,
    createdAt: nowMs
  };
  state.account.orders.push(od);
  return od;
}

export function cancelOrder(state: EngineState, orderId: string): boolean {
  const before = state.account.orders.length;
  state.account.orders = state.account.orders.filter((o) => o.id !== orderId);
  return state.account.orders.length < before;
}

/** 改单（委托价可改；改完返回是否成功） */
export function modifyOrder(state: EngineState, orderId: string, patch: Partial<Pick<PendingOrder, 'limitPrice' | 'sl' | 'tp'>>): boolean {
  const od = state.account.orders.find((o) => o.id === orderId);
  if (!od) return false;
  if (patch.limitPrice !== undefined) od.limitPrice = patch.limitPrice;
  if (patch.sl !== undefined) od.sl = patch.sl;
  if (patch.tp !== undefined) od.tp = patch.tp;
  return true;
}

/** 改持仓的止盈/止损 */
export function modifyPosition(state: EngineState, positionId: string, sl: number | null, tp: number | null): boolean {
  const pos = state.account.positions.find((p) => p.id === positionId);
  if (!pos) return false;
  pos.sl = sl;
  pos.tp = tp;
  return true;
}

/**
 * 平仓（可部分）：按现价结算，净盈亏 = 价差盈亏 − 平仓手续费。
 * 部分手数向下取整到 0.01；剩量 < 0.01 时视为全平。
 */
export function closePosition(state: EngineState, positionId: string, lots?: number, nowMs: number = Date.now()): TradeRecord | null {
  const idx = state.account.positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return null;
  const pos = state.account.positions[idx];
  const s = state.symbols[pos.symbol];
  const closeLots = lots === undefined ? pos.lots : Math.min(roundTo(Math.floor(lots * 100) / 100, 2), pos.lots);
  if (closeLots <= 0) return null;
  const diff = pos.side === 'buy' ? s.spot - pos.openPrice : pos.openPrice - s.spot;
  const gross = toUsd(s.def, diff * closeLots * s.def.contractSize, s.spot);
  const fee = feeOf(s.def, closeLots, s.spot);
  const net = gross - fee;
  state.account.balance += net;
  const rec: TradeRecord = {
    id: `T${state.account.nextId++}`,
    symbol: pos.symbol,
    side: pos.side,
    lots: closeLots,
    openPrice: pos.openPrice,
    closePrice: s.spot,
    pnl: roundTo(net, 2),
    fee: roundTo(fee, 2),
    closedAt: nowMs
  };
  state.account.trades.unshift(rec);
  if (closeLots >= pos.lots - 1e-9) {
    state.account.positions.splice(idx, 1);
  } else {
    pos.lots = roundTo(pos.lots - closeLots, 2);
  }
  sampleEquity(state, nowMs);
  return rec;
}

/** 全平（按品种可选）；返回成交笔数 */
export function closeAll(state: EngineState, symbol?: string, nowMs: number = Date.now()): number {
  const ids = state.account.positions.filter((p) => !symbol || p.symbol === symbol).map((p) => p.id);
  let n = 0;
  for (const id of ids) {
    if (closePosition(state, id, undefined, nowMs)) n++;
  }
  return n;
}

function sampleEquity(state: EngineState, nowMs: number): void {
  const eq = equityOf(state);
  const curve = state.account.equityCurve;
  const last = curve[curve.length - 1];
  if (last && nowMs - last.t < 1000) {
    last.equity = eq; // 同一秒内的多笔合并为一个点
  } else {
    curve.push({ t: nowMs, equity: eq });
  }
  if (curve.length > 500) curve.shift();
}

/** 半平仓手数：向下取整到 0.01；不足 0.02 手时返回 null（无法半平） */
export function halfLotsOf(lots: number): number | null {
  const half = Math.floor((lots / 2) * 100) / 100;
  if (half < 0.01) return null;
  return roundTo(half, 2);
}

/* ============================ 绩效统计（从真实成交推导） ============================ */

/**
 * 胜率 / 盈亏比 / 交易次数 / 最大回撤 —— 全部从 account.trades 与净值曲线推导。
 * 没有成交记录时返回 0 次数与 null（页面显示 —），**不编造任何数字**。
 */
export function performanceOf(state: EngineState): Performance {
  const trades = state.account.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  // 最大回撤：按净值曲线（含每笔已实现盈亏落点）
  let peak = -Infinity;
  let mdd: number | null = null;
  for (const pt of state.account.equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > 0 && (mdd === null || dd > mdd)) mdd = dd;
  }
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: avgLoss > 0 ? avgWin / avgLoss : null,
    maxDrawdown: mdd
  };
}

/* ============================ 汇率换算（模拟） ============================ */

/**
 * 模拟汇率：直接取引擎内相关品种的现货价。
 * 返回各币种对 1 USD 的汇率（1 USD = ? X）。
 */
export function fxRatesOf(state: EngineState): Record<string, number> {
  return {
    USD: 1,
    CNH: state.symbols.USDCNH ? state.symbols.USDCNH.spot : 7.0875,
    EUR: state.symbols.EURUSD ? 1 / state.symbols.EURUSD.spot : 0.882,
    JPY: state.symbols.USDJPY ? state.symbols.USDJPY.spot : 157.03
  };
}

export function convertCurrency(state: EngineState, amount: number, from: string, to: string): number {
  const rates = fxRatesOf(state);
  const usd = amount / (rates[from] ?? 1);
  return usd * (rates[to] ?? 1);
}

/* ============================ 真实行情注入（2026-10-28） ============================ */

/**
 * 把外部真实价注入引擎的**唯一收口**：现价、涨跌幅基准与三套序列的末根全部对齐。
 * 与 tickEngine 的差别：真实价直接赋值（不叠加随机步进）；K 线跟随复用同一条路。
 * 只对真实源覆盖到的品种生效（当前仅 XAUUSD，见 marketFeed.FEED_SYMBOL_MAP），
 * 其余品种继续走模拟——页面角标必须如实区分，不许拿真实价冒充全真实行情。
 */
export function applyRealSpot(
  state: EngineState,
  symbol: string,
  price: number,
  prevClose: number | null,
  nowMs: number
): boolean {
  const s = state.symbols[symbol];
  if (!s || !Number.isFinite(price) || price <= 0) return false;
  s.spot = roundTo(price, s.def.digits);
  if (prevClose !== null && Number.isFinite(prevClose) && prevClose > 0) {
    s.prevClose = roundTo(prevClose, s.def.digits);
  }
  followSpotWithSeries(s, nowMs, s.rng);
  return true;
}

/**
 * 首次拿到真实价时把整段模拟序列重新锚定到真实价。
 * 不重锚的话，模拟历史（锚在 basePrice 4120 附近）与真实现价（如 4058）之间
 * 会出现一根断崖 K 线，图表视觉上是坏的。重锚后历史仍是模拟推演（角标照实标注），
 * 但与真实现价连续。注意：会改变该品种的浮动盈亏基准，只在首次接入时调用。
 */
export function reanchorSeries(state: EngineState, symbol: string, price: number, nowMs: number): void {
  const s = state.symbols[symbol];
  if (!s || !Number.isFinite(price) || price <= 0) return;
  for (const tf of TIMEFRAMES) s.series[tf] = generateSeries(s.def, tf, nowMs, price);
  s.spot = roundTo(price, s.def.digits);
}
