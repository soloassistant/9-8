/**
 * 腾讯行情直连（2026-10-25）：免费、免 key、HTTPS、CORS 全开（实测 ACAO:*）。
 * 三市场实测：sh600519 贵州茅台 / hk00700 腾讯控股 / usAAPL 苹果。
 *
 * ⚠️ 编码：接口返回 **GBK**。H5 用 fetch → arrayBuffer → TextDecoder('gbk')（浏览器原生支持）。
 *   weapp 端没有 TextDecoder，走云函数转码又卡部署凭据 —— 本模块在 weapp 返回 null，
 *   调用方如实隐藏行情卡（不做假数据，诚实性铁律）。
 *
 * ⚠️ 字段索引（2026-10-25 实测钉死，腾讯协议公开多年未变；改前先重测）：
 *   1 名称 / 2 代码 / 3 现价 / 4 昨收 / 5 今开 / 30 时间 / 31 涨跌额 / 32 涨跌幅% / 33 最高 / 34 最低
 */
import Taro from '@tarojs/taro';

/** H5-only：weapp 无 TextDecoder，编译期常量分支各自只留一端 */
const H5 = process.env.TARO_ENV === 'h5';

export interface StockQuote {
  /** 归一后的腾讯代码（sh600519 / hk00700 / usAAPL） */
  code: string;
  name: string;
  price: number;
  prevClose: number;
  /** 涨跌额（元/港币/美元） */
  change: number;
  /** 涨跌幅（百分数数值，如 1.25 = +1.25%） */
  changePct: number;
  high: number;
  low: number;
  /** 行情时间（A股为 yyyymmddHHMMSS，港美股为 "2026/10/23 16:08:14"）—— 原样透传展示 */
  timeText: string;
}

/** 自选股存储键。已进 SYNC_KEYS（2026-10-25）：跨设备同步（手机加的茅台，平板要能看到）；
 *  键标签 sync.key.watchlist 在 language.ts，同步语义与购物清单同款（数组新者赢）。 */
const WATCHLIST_KEY = 'watchlist';
/** 自选上限（2026-10-25 审计 #5 抽常量：此前上限 8 在注释与判断各写一遍，改一处必漏一处） */
export const WATCHLIST_MAX = 8;

/** 用户输入 → 腾讯代码归一。规则尽量贴近国内用户习惯：
 *  · 6 开头 6 位数字 → 沪市 sh；0/2/3 开头 6 位数字 → 深市 sz（000001 平安银行 vs sh000001 上证指数，用户要指数得自己写 sh）
 *  · 5 位纯数字 → 港股 hk（00700）
 *  · 纯字母 1-6 位 → 美股 us（AAPL）
 *  · 已带 sh/sz/hk/us 前缀 → 原样（大写 BABA 转小写 us 前缀统一）
 *  归一不了的返回 null，调用方提示格式，不猜。 */
export function normalizeStockCode(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  // us 分支禁连续点（审计 #6）：us..A 之类垃圾串不给过，宁可在下一轮提示「代码格式不对」
  if (/^s[hz]\d{6}$/.test(s) || /^hk\d{4,5}$/.test(s) || /^us[a-z]+(\.[a-z]+){0,2}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) return s[0] === '6' ? `sh${s}` : `sz${s}`;
  if (/^\d{4,5}$/.test(s)) return `hk${s}`;
  if (/^[a-z]{1,6}$/.test(s)) return `us${s}`;
  return null;
}

/** 批量拉行情（H5）。任何失败返回 []（不抛错：行情是增值内容，不配打扰主流程）。 */
export async function fetchQuotes(codes: string[]): Promise<StockQuote[]> {
  if (!H5 || codes.length === 0) return [];
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${codes.map(encodeURIComponent).join(',')}`, {
      // 行情接口无鉴权；referrerpolicy 收紧避免带本应用 origin 去撞 CDN 策略
      referrerPolicy: 'no-referrer'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out: StockQuote[] = [];
    for (const line of text.split(';')) {
      const m = line.match(/^v_[^=]+="([^"]*)"/);
      if (!m) continue;
      const f = m[1].split('~');
      if (f.length < 35 || !f[1]) continue;
      const price = Number(f[3]);
      const prevClose = Number(f[4]);
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        code: (line.match(/^v_([a-z]{2}[^=]+)=/)?.[1] || f[2] || '').toLowerCase(),
        name: f[1],
        price,
        prevClose: Number.isFinite(prevClose) ? prevClose : 0,
        change: Number(f[31]) || 0,
        changePct: Number(f[32]) || 0,
        high: Number(f[33]) || 0,
        low: Number(f[34]) || 0,
        timeText: (f[30] || '').slice(0, 19)
      });
    }
    return out;
  } catch (err) {
    console.error('[quotes] fetch failed:', err);
    return [];
  }
}

/** 读自选股（存归一后的腾讯代码）。weapp 返回 []：无解码器，行情卡整卡隐藏。 */
export function getWatchlist(): string[] {
  try {
    const v = Taro.getStorageSync(WATCHLIST_KEY);
    return Array.isArray(v) ? (v as string[]).filter((c) => typeof c === 'string' && c) : [];
  } catch (err) {
    console.error('[quotes] read watchlist failed:', err);
    return [];
  }
}

/** 加自选（去重，上限 WATCHLIST_MAX 只：行情卡一屏可读性优先）。
 *  返回新列表；**已满时返回 null** —— 调用方必须提示（静默吞掉会让用户以为加成功了，
 *  刷新后消失，属于「假成功」，2026-10-25 审计修）。 */
export function addToWatchlist(code: string): string[] | null {
  const list = getWatchlist();
  if (list.includes(code)) return list;
  if (list.length >= WATCHLIST_MAX) return null;
  list.push(code);
  try {
    Taro.setStorageSync(WATCHLIST_KEY, list);
  } catch (err) {
    console.error('[quotes] save watchlist failed:', err);
  }
  return list;
}

/** 删自选。返回新列表。 */
export function removeFromWatchlist(code: string): string[] {
  const list = getWatchlist().filter((c) => c !== code);
  try {
    Taro.setStorageSync(WATCHLIST_KEY, list);
  } catch (err) {
    console.error('[quotes] save watchlist failed:', err);
  }
  return list;
}
