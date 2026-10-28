/**
 * 真实行情喂价（免费免密，浏览器直连）。
 *
 * 数据源：腾讯行情 qt.gtimg.cn。选它的实测依据（2026-10-28，本机走大陆代理）：
 *   - CORS 全开：响应头 `Access-Control-Allow-Origin: *`，浏览器可直接 fetch；
 *   - 大陆可达：Yahoo（429 限流）、Binance（502）、stooq（JS 反爬）在同类网络全部不可用；
 *   - 免密钥、无配额协商成本。
 *
 * 覆盖面（如实）：只有 **实时报价**（现价/昨收/开高低/时间），且实测仅 `hf_` 外盘系列可用
 * （hf_XAU 现货黄金、hf_GC COMEX 金等）；腾讯没有对外盘开放的 K 线端点（fqkline/mkline/
 * minute 对 hf_ 全部 param error），也没有可用的外汇代码（fx_* 全部 none_match）。
 * ⇒ 本模块只做「现价真实」：XAUUSD 的现价与涨跌幅来自腾讯；K 线仍是 marketSim 的
 *    模拟推演（图表上有常驻水印），外汇品种整体模拟。页面角标必须如实区分这两层。
 *
 * 编码注意：qt.gtimg.cn 返回 GBK，品种中文名会乱码 —— 我们只解析数字字段，不受影响。
 */

export interface RealQuote {
  price: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  time: string | null;
}

/** 应用品种 → 腾讯代码。只登记**实测可用**的映射，宁缺毋滥。 */
export const FEED_SYMBOL_MAP: Record<string, string> = {
  XAUUSD: 'hf_XAU'
};

export const FEED_CODES = Object.values(FEED_SYMBOL_MAP);

export const FEED_ENDPOINT = 'https://qt.gtimg.cn/q=';

/**
 * 解析 qt.gtimg.cn 的响应体。纯函数，可单测。
 * 行格式：`v_hf_XAU="4058.73,-0.03,4058.73,4059.08,4070.74,4055.79,09:28:00,4060.13,4061.17,0,0,0,2026-10-28,...";`
 * 字段口径（实测）：0=现价 4=最高 5=最低 6=时间 7=开盘 8=昨收。缺失/非数字一律置 null，
 * 只有现价合法才产出条目 —— 宁可少报一条，不报一条假价。
 */
export function parseTencentQuotes(raw: string): Record<string, RealQuote> {
  const out: Record<string, RealQuote> = {};
  const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    const f = m[2].split(',');
    const price = Number.parseFloat(f[0]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const num = (i: number): number | null => {
      const v = Number.parseFloat(f[i]);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    out[code] = {
      price,
      prevClose: num(8),
      open: num(7),
      high: num(4),
      low: num(5),
      time: f[6] || null
    };
  }
  return out;
}

/**
 * 拉一次实时报价。任何失败（网络/超时/非 200/空解析）返回 null，
 * 调用方据此回退模拟态 —— 报价失败绝不能编一个价格出来。
 */
export async function fetchRealQuotes(codes: string[], timeoutMs = 8000): Promise<Record<string, RealQuote> | null> {
  if (codes.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(FEED_ENDPOINT + codes.join(','), { signal: controller.signal });
    if (!res.ok) return null;
    const raw = await res.text();
    const parsed = parseTencentQuotes(raw);
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
