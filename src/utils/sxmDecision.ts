/**
 * 省心买 · 纯逻辑层（不依赖 Taro / DOM / 网络 / 存储，无副作用）。
 *
 * 为什么单独成文件：这些函数是**上游 app.js 的原值移植**，属于有明确对错的算法，
 * 必须能脱离小程序/浏览器运行时被独立断言（见 .tmp-verify 的验证脚本）。
 * 因此本文件：
 *   - 不 import Taro、不访问 window/document、不读写 storage、不打印日志；
 *   - 只用**相对路径**引入静态字典（便于用 esbuild 直接 bundle 出断言程序）。
 *
 * 边界语义（原样保留，不许"优化"）：
 *   modeVerdict —— km<500 rail、<900 rail、<1300 tie、<2000 air、其余 air。
 *   即 km 正好 900 是 tie、正好 1300 是 air、正好 2000 是 air。
 */
import {
  CITY_AIR,
  CITY_ALIAS,
  FLIGHT_PLATFORMS,
  RAIL_OFFICIAL,
  SHOP_PLATFORMS
} from '../config/sxmPlatforms';

/** 地球半径（公里），原值来自 vendor/shengxinmai/app.js */
const R_EARTH = 6371;

/**
 * 两点大圆（直线）距离，单位公里。
 * 逐字移植 vendor/shengxinmai/app.js 的 greatCircle，a / b 都是 [纬度, 经度]。
 */
export function greatCircleKm(a: [number, number], b: [number, number]): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/**
 * 门到门耗时粗估（小时）。原值移植 app.js。
 * 高铁：含停站有效速度约 250km/h，再加进出站与安检约 0.5h。
 * 飞机：巡航约 700km/h，但必须再加往返机场 + 安检 + 提前到达约 3h。
 * 这两个系数是常识层面的经验值，只用于量级判断 —— 卡片上必须标明是粗估。
 */
export function estimateModes(km: number): { rail: number; air: number } {
  return { rail: km / 250 + 0.5, air: km / 700 + 3.0 };
}

/** 4.78 → 「4 小时 45 分」。原值移植 app.js（取整到 15 分钟）。 */
export function humanHours(h: number): string {
  const total = Math.round((h * 60) / 15) * 15;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return `${mm} 分钟`;
  return mm === 0 ? `${hh} 小时` : `${hh} 小时 ${mm} 分`;
}

/** 给结论，而不是把两个数字丢给用户自己算。文案逐字照抄 app.js。 */
export function modeVerdict(km: number): { pick: 'rail' | 'air' | 'tie'; text: string } {
  if (km < 500)
    return {
      pick: 'rail',
      text: '这么近就别去机场了。算上往返和安检，飞机一点都不快，高铁准点率还高得多。'
    };
  if (km < 900)
    return {
      pick: 'rail',
      text: '高铁更稳。飞机虽然天上快，但那 3 小时机场时间省不掉，加上准点率，往往还是高铁省心。'
    };
  if (km < 1300)
    return {
      pick: 'tie',
      text: '两者门到门时间很接近，看具体时刻。想省钱看高铁二等座，想省体力看飞机。'
    };
  if (km < 2000)
    return {
      pick: 'air',
      text: '这条线飞机明显划算，门到门能省几个小时。除非你要在沿线中途下车。'
    };
  return { pick: 'air', text: '距离太远，飞机基本是唯一现实选择。也可以看看有没有夕发朝至的卧铺当省钱方案。' };
}

/** 认不出时归一化时允许剥离的行政后缀 */
const CITY_SUFFIXES = ['市', '省'];

/**
 * 把用户输入解析成标准城市名，认不出返回 null。
 *
 * 顺序：CITY_ALIAS 别名 → CITY_AIR 标准名 → 剥掉尾部「市」「省」后重查这两者。
 * 只做精确匹配（不做模糊匹配、不猜、不返回默认城市）—— 认不出就该让调用方明说认不出。
 */
export function resolveCityName(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  const direct = CITY_ALIAS[raw] ?? (raw in CITY_AIR ? raw : null);
  if (direct) return direct;

  for (const suffix of CITY_SUFFIXES) {
    if (!raw.endsWith(suffix)) continue;
    const stripped = raw.slice(0, -suffix.length);
    if (!stripped) continue;
    const hit = CITY_ALIAS[stripped] ?? (stripped in CITY_AIR ? stripped : null);
    if (hit) return hit;
  }
  return null;
}

/** 只替换第一次出现，与上游 `p.url.replace('{q}', enc(q))` 的语义一致 */
function replaceOnce(template: string, token: string, value: string): string {
  return template.replace(token, value);
}

/**
 * 电商搜索链接：把模板里的 {q} 换成 URL 编码后的关键词。
 * 平台 id 不存在时返回空串（调用方必须自己处理，不许拿模板当结果）。
 */
export function buildShopUrl(platformId: string, keyword: string): string {
  const platform = SHOP_PLATFORMS.find((p) => p.id === platformId);
  if (!platform) return '';
  return replaceOnce(platform.url, '{q}', encodeURIComponent(keyword));
}

/**
 * 机票链接构造结果。
 *
 * `ok:false` 是**一等公民**，不是异常：上游有三个平台入口，其中一个（飞猪）的模板是
 * **裸首页、不含任何占位符**。如果按"替换完就返回字符串"的老写法，会把出发地/目的地/日期
 * 悄悄丢掉却仍然返回一个看起来正常的 URL —— 那是在骗用户。所以这里用显式结果类型把
 * 「这个平台给不出深链」这件事暴露给 UI，由 UI 明说。
 */
export type FlightUrlResult =
  | { ok: true; platformId: string; url: string }
  | {
      ok: false;
      platformId: string;
      /** 可用的部分产物：no-deeplink 时是裸首页，其余情况为空串 */
      url: string;
      reason: 'unknown-platform' | 'unknown-city' | 'no-deeplink';
    };

/** 机票模板里出现过的占位符（用于判定"裸首页"） */
const FLIGHT_PLACEHOLDERS = ['{dep}', '{arr}', '{depCity}', '{arrCity}', '{date}'] as const;

/**
 * 机票链接：用 CITY_AIR 补三字码，语义严格对齐 app.js 的替换顺序 ——
 *   {dep}/{arr}          → 三字码小写
 *   {depCity}/{arrCity}  → URL 编码的城市名
 *   {date}               → 原样日期字符串
 * 每一处只替换第一次出现。
 */
export function buildFlightUrl(
  platformId: string,
  dep: string,
  arr: string,
  date: string
): FlightUrlResult {
  const platform = FLIGHT_PLATFORMS.find((p) => p.id === platformId);
  if (!platform) {
    return { ok: false, platformId, url: '', reason: 'unknown-platform' };
  }

  const hasPlaceholder = FLIGHT_PLACEHOLDERS.some((token) => platform.url.includes(token));
  if (!hasPlaceholder) {
    return { ok: false, platformId, url: platform.url, reason: 'no-deeplink' };
  }

  const depCode = CITY_AIR[dep];
  const arrCode = CITY_AIR[arr];
  if (!depCode || !arrCode) {
    return { ok: false, platformId, url: '', reason: 'unknown-city' };
  }

  let url = platform.url;
  url = replaceOnce(url, '{dep}', depCode.toUpperCase().toLowerCase());
  url = replaceOnce(url, '{arr}', arrCode.toUpperCase().toLowerCase());
  url = replaceOnce(url, '{depCity}', encodeURIComponent(dep));
  url = replaceOnce(url, '{arrCity}', encodeURIComponent(arr));
  url = replaceOnce(url, '{date}', date);
  return { ok: true, platformId, url };
}

/**
 * 火车票链接：12306 官方入口。
 * 语义对齐 app.js 的 `RAIL_OFFICIAL.url.replace('{from}', enc(from)).replace('{to}', enc(to)).replace('{date}', iso)`。
 * 站名用城市名 URL 编码，日期原样透传。
 */
export function buildRailUrl(from: string, to: string, date: string): string {
  let url = RAIL_OFFICIAL.url;
  url = replaceOnce(url, '{from}', encodeURIComponent(from));
  url = replaceOnce(url, '{to}', encodeURIComponent(to));
  url = replaceOnce(url, '{date}', date);
  return url;
}
