#!/usr/bin/env node
/**
 * verify-sxm-decision.mjs —— 省心买纯逻辑层（src/utils/sxmDecision.ts）行为回归。
 *
 * 为什么必须单独测这段：sxmDecision.ts 是**上游 vendor app.js 的原值移植**，
 * 函数签名里没有任何「拿不到就静默降级」的空间 —— resolveCityName 认不出必须返回 null、
 * buildFlightUrl 给不出深链必须 ok:false。这些「必须如实失败」的语义只靠读代码守不住，
 * 必须有可执行断言。页面（src/pages/sxm/index.tsx）只是它的消费方。
 *
 * 本 harness 用 esbuild 就地把 **src 源码**（含 ../config/sxmPlatforms 字典）bundle 成
 * ESM 后经 data: URL import —— 不碰 dist 产物（terser 会重命名，历史教训见
 * verify-extract-coerce.mjs 头注），不做 minify，保证函数名与逻辑原样保留。
 *
 * ⚠️ 断言写法教训（2026-10-15 踩过，务必保留）：t() 的第二个参数**必须是布尔**。
 *    失败分支若返回「说明原因的字符串」，非空字符串 truthy → 失败会被判成 PASS，
 *    整份测试永久假绿。本文件统一 `t(name, ok === true || reason)` 之外的严格写法：
 *    每个用例直接 return true/false，由 t() 判 `ok === true`。
 *
 * 用法: node .tools/verify-sxm-decision.mjs [--json]
 * 退出码: 0 = 全通过；1 = 有用例失败；2 = harness 自身出错
 */
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

/* ── 1. 编译被测模块（src 源码，bundle 字典依赖） ───────────────────── */
const bundled = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'utils', 'sxmDecision.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});

let SXM;
try {
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
  SXM = await import(dataUrl);
} catch (e) {
  console.error('HARNESS-ERROR  编译/加载 sxmDecision.ts 失败:', e && e.message);
  process.exit(2);
}

/* ── 2. 用例框架（ok 必须恒为 true/false，见头注） ───────────────────── */
let pass = 0, fail = 0;
const t = (name, ok) => {
  if (ok === true) { pass++; if (!asJson) console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${ok === false ? '' : '  → ' + ok}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── 3. 断言 ───────────────────────────────────────────────────────── */

/* 3.1 greatCircleKm：北京→上海大圆距离 ≈ 1067km（公开地理常识值，容差 ±10） */
{
  const km = SXM.greatCircleKm([39.9042, 116.4074], [31.2304, 121.4737]);
  t('greatCircleKm 北京→上海 ≈ 1067km（容差±10）', near(km, 1067, 10));
  t('greatCircleKm 同点距离为 0', SXM.greatCircleKm([39.9042, 116.4074], [39.9042, 116.4074]) === 0);
  const km2 = SXM.greatCircleKm([31.2304, 121.4737], [39.9042, 116.4074]);
  t('greatCircleKm 对称性（往返一致）', near(km, km2, 1e-9));
}

/* 3.2 estimateModes：系数原值 250km/h+0.5h / 700km/h+3h */
{
  const m = SXM.estimateModes(1000);
  t('estimateModes(1000).rail = 4.5h', near(m.rail, 4.5, 1e-9));
  t('estimateModes(1000).air = 1000/700+3h', near(m.air, 1000 / 700 + 3, 1e-9));
}

/* 3.3 humanHours：取整到 15 分钟，原样保留的格式语义 */
{
  t('humanHours(4.78) = 「4 小时 45 分」', SXM.humanHours(4.78) === '4 小时 45 分');
  t('humanHours(0.4) = 「30 分钟」（0.4h=24min，按 15 分钟取整后为 30）', SXM.humanHours(0.4) === '30 分钟');
  t('humanHours(0.01) = 「0 分钟」（极小值取整到 0，不隐藏）', SXM.humanHours(0.01) === '0 分钟');
  t('humanHours(2) = 「2 小时」（整点不带分钟位）', SXM.humanHours(2) === '2 小时');
}

/* 3.4 modeVerdict 边界语义 —— 头注铁律：正好 900=tie、正好 1300=air、正好 2000=air */
{
  const at = (km) => SXM.modeVerdict(km).pick;
  t('modeVerdict(499) = rail', at(499) === 'rail');
  t('modeVerdict(500) = rail', at(500) === 'rail');
  t('modeVerdict(899) = rail', at(899) === 'rail');
  t('modeVerdict(900) = tie（铁律：正好 900 是 tie）', at(900) === 'tie');
  t('modeVerdict(1299) = tie', at(1299) === 'tie');
  t('modeVerdict(1300) = air（铁律：正好 1300 是 air）', at(1300) === 'air');
  t('modeVerdict(1999) = air', at(1999) === 'air');
  t('modeVerdict(2000) = air（铁律：正好 2000 是 air）', at(2000) === 'air');
  t('modeVerdict(5000) = air 且切换远端文案', at(5000) === 'air' && SXM.modeVerdict(5000).text.includes('距离太远'));
  t('modeVerdict 每个 pick 都带非空 text', ['rail', 'tie', 'air'].every((p) => SXM.modeVerdict(p === 'rail' ? 100 : p === 'tie' ? 1000 : 3000).text.length > 0));
}

/* 3.5 resolveCityName：三条路径 + 认不出必须 null（不许猜） */
{
  const r = SXM.resolveCityName;
  t('resolveCityName(北京) = 北京（CITY_AIR 直查）', r('北京') === '北京');
  t('resolveCityName(沪) = 上海（别名）', r('沪') === '上海');
  t('resolveCityName(蓉城) = 成都（别名）', r('蓉城') === '成都');
  t('resolveCityName(北京市) = 北京（别名直查优先于剥离）', r('北京市') === '北京');
  t('resolveCityName(三亚市) = 三亚（市 后缀剥离路径）', r('三亚市') === '三亚');
  t('resolveCityName(内蒙古省) = null（省 后缀剥离后仍认不出，不猜）', r('内蒙古省') === null);
  t('resolveCityName(纽约) = null（不在字典不猜）', r('纽约') === null);
  t('resolveCityName(空串) = null', r('') === null);
  t('resolveCityName(纯空格) = null', r('   ') === null);
  t('resolveCityName 前后空格被 trim', r('  上海  ') === '上海');
}

/* 3.6 buildShopUrl：{q} URL 编码；未知平台返回空串（不许拿模板当结果） */
{
  const url = SXM.buildShopUrl('tb', '无线 耳机');
  t('buildShopUrl(tb) 含编码后的关键词', url.includes('q=' + encodeURIComponent('无线 耳机')));
  t('buildShopUrl(tb) 落到淘宝搜索域', url.startsWith('https://s.taobao.com/search?'));
  t('buildShopUrl(未知 id) = 空串', SXM.buildShopUrl('nope', 'x') === '');
  t('buildShopUrl(jd) 含 enc=utf-8', SXM.buildShopUrl('jd', '手机').includes('enc=utf-8'));
}

/* 3.7 buildFlightUrl：ok:false 是一等公民（深链语义如实暴露） */
{
  const ok = SXM.buildFlightUrl('ctrip', '北京', '上海', '2026-10-22');
  t('buildFlightUrl(ctrip) ok:true', ok.ok === true);
  t('buildFlightUrl(ctrip) 三字码小写代入 oneway-bjs-sha', ok.ok === true && ok.url.includes('oneway-bjs-sha'));
  t('buildFlightUrl(ctrip) 日期原样透传', ok.ok === true && ok.url.includes('depdate=2026-10-22'));

  const qn = SXM.buildFlightUrl('qunar', '北京', '上海', '2026-10-22');
  t('buildFlightUrl(qunar) depCity 走 URL 编码', qn.ok === true && qn.url.includes(`searchDepartureAirport=${encodeURIComponent('北京')}`));

  const fl = SXM.buildFlightUrl('fliggy', '北京', '上海', '2026-10-22');
  t('buildFlightUrl(fliggy) ok:false + reason=no-deeplink（裸首页）', fl.ok === false && fl.reason === 'no-deeplink');
  t('buildFlightUrl(fliggy) 仍给出可点首页（部分产物）', fl.ok === false && fl.url === 'https://www.fliggy.com/');

  const bad = SXM.buildFlightUrl('ctrip', '北京', '纽约', '2026-10-22');
  t('buildFlightUrl(未知城市) ok:false + reason=unknown-city', bad.ok === false && bad.reason === 'unknown-city' && bad.url === '');

  const np = SXM.buildFlightUrl('nope', '北京', '上海', '2026-10-22');
  t('buildFlightUrl(未知平台) ok:false + reason=unknown-platform', np.ok === false && np.reason === 'unknown-platform');
}

/* 3.8 buildRailUrl：12306 官方入口，站名编码 + 日期原样 */
{
  const url = SXM.buildRailUrl('北京', '上海', '2026-10-22');
  t('buildRailUrl 含编码后的 from', url.includes('fs=' + encodeURIComponent('北京')));
  t('buildRailUrl 含编码后的 to', url.includes('ts=' + encodeURIComponent('上海')));
  t('buildRailUrl 日期原样透传', url.includes('date=2026-10-22'));
  t('buildRailUrl 落在 12306 官方域', url.startsWith('https://kyfw.12306.cn/'));
}

/* ── 4. 汇总 ───────────────────────────────────────────────────────── */
if (asJson) {
  console.log(JSON.stringify({ pass, fail }, null, 2));
} else {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`);
}
process.exit(fail === 0 ? 0 : 1);
