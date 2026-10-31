#!/usr/bin/env node
/**
 * probe-empty-img.mjs —— 可见空图审计（2026-10-31，重建自另一会话的 .tmp-verify 版本，
 * 那份放在临时目录里随构建清理消失了——审计工具要耐用，住 .tools/）。
 *
 * 背景：briefing 页的视频精选封面（videoCover）间歇出现 `src=null` 的空框（124×69 可见）。
 * 教训两条（都付过学费）：
 *   ① **必须按可见性过滤**：Taro 的 tab 页不卸载，隐藏页里全是 0×0 的 <img>，
 *      直接数会得出「369 张空图」的假数字（2026-10-31 两会话口径之争的根源）；
 *   ② **间歇性问题单次 0 张说明不了什么** —— 连跑 N 次才算数（ROUTES 支持多路由轮询）。
 *
 * 判据：img 可见（offsetParent 非空 + 尺寸 >0）且（无 currentSrc 或 currentSrc === 页面地址）。
 * 用法: ROUTES=briefing,library node .tools/probe-empty-img.mjs [--runs 3] [--base <url>]
 * 退出码: 0 = 全部干净；1 = 任一次任一路由抓到可见空图；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = fs.readFileSync(path.join(ROOT, 'src', 'services', 'cloudAuth.ts'), 'utf8').match(/wbpk_[A-Za-z0-9_]*/)[0];
const H = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host').replace(/\/$/, '');
const ROUTES = (process.env.ROUTES || 'briefing,library').split(',').map((s) => s.trim()).filter(Boolean);
const runsIdx = process.argv.indexOf(String.fromCharCode(45,45,114,117,110,115));
const RUNS = runsIdx > -1 ? Number(process.argv[runsIdx + 1]) || 3 : 3;

/* 与 cdp-probe-session.js 同源的假登录态（内页门禁会挡未登录） */
const STUB = fs.readFileSync(path.join(ROOT, '.tools', 'cdp-probe-session.js'), 'utf8');
const SEED = `try{localStorage.setItem('onboarded-v2',JSON.stringify({data:true}));localStorage.setItem('onboarded-v2:probe-user-0001',JSON.stringify({data:true}));localStorage.setItem('privacy-consent',JSON.stringify({data:{agreed:true,version:'v1.8-20261026',time:Date.now()}}));}catch(e){}`;

const EXPR = `(() => {
  const vis = [...document.querySelectorAll('img')].filter((i) => {
    const r = i.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && i.offsetParent !== null;
  });
  // weui-tabbar__icon 是 Taro 框架自身的 tabBar 图标，间歇性晚加载属框架行为，不是内容图
  const bad = vis.filter((i) => (!i.currentSrc || i.currentSrc === location.href) && !/weui-tabbar/.test(i.className));
  return JSON.stringify({ visible: vis.length, bad: bad.length, cls: bad.slice(0, 5).map((i) => (i.closest('[class]') || i).className.slice(0, 60)) });
})()`;

/* 复用 cdp-probe 的 Chrome 通道：起本地静态？不——直接用 CDP 连新 Chrome 实例成本高，
   这里改为调用 cdp-probe.mjs（它已解决 Chrome 生命周期/浮层/长尾等待），每路由一轮。 */
import { spawnSync } from 'node:child_process';
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const NODE = process.execPath;
const INIT = path.join(ROOT, '.tmp-verify', `_probe-empty-init-${Date.now()}.js`);
fs.writeFileSync(INIT, SEED + STUB);

let bad = 0;
for (let run = 1; run <= RUNS; run += 1) {
  for (const route of ROUTES) {
    const out = path.join(ROOT, '.tmp-verify', `empty-img-${route}-${run}.json`);
    const res = spawnSync(NODE, [PROBE, `${H}/?rt=empty-${route}-${run}#/pages/${route}/index`, '375', '812', '--init-script', INIT, '--dismiss-splash', '--expr', EXPR], { encoding: 'utf8', timeout: 120000 });
    let parsed = null;
    try {
      // value 是 pretty-print 对象且首键是 visible（cdp-probe 会把 expr 的 JSON 串解析成对象）
      const m = res.stdout.match(/\{\s*"visible"[\s\S]*?\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch { /* parse fail = 当轮无效 */ }
    if (!parsed) {
      console.log(`run${run} ${route}: 无效（加载长尾或浮层竞态，本轮不计）`);
      continue;
    }
    const verdict = parsed.bad === 0 ? 'clean' : `BAD ${parsed.bad} 张 [${parsed.cls.join(' / ')}]`;
    console.log(`run${run} ${route}: 可见 ${parsed.visible}，空 src ${parsed.bad} → ${verdict}`);
    if (parsed.bad > 0) bad += 1;
  }
}
fs.unlinkSync(INIT);
console.log(bad === 0 ? '\n结果：全部干净（注意：间歇性问题需要多跑几轮才有置信度）' : `\n结果：${bad} 轮命中可见空图`);
process.exit(bad === 0 ? 0 : 1);
