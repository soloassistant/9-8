#!/usr/bin/env node
/**
 * verify-ledger-briefing.mjs —— 晨报「今日账单」卡片端到端回归（记账功能的核心呈报位）。
 *
 * 用法: node .tools/verify-ledger-briefing.mjs [--json]
 * 退出码: 0 = 通过（或环境缺 Chrome/dist 时 SKIP）；1 = 不达标；2 = harness 自身出错
 *
 * ⚠️⚠️ 两个踩过的坑，都写在这里，别再重蹈：
 *
 * 1. **种子数据必须用 Taro 的存储格式**：`{data: <值>}` 的 JSON。
 *    Taro H5 的 setStorageSync 写 `JSON.stringify({data})`（taro-h5/dist/index.cjs.js:1341），
 *    getStorageSync 取 `item.data`，**取不到返回空串 ''**（:1428）。
 *    直接 `localStorage.setItem(key, JSON.stringify([...]))` 会让读到 undefined →
 *    数组判空 → **卡片不渲染**，极像代码 bug，其实是种子格式错（白排查半小时）。
 *
 * 2. **`--init-script` 只接受文件路径**，且**必须与会话桩合并**：
 *    只写 localStorage 种子而不带 getSession 伪造会话，门禁会把页面踢回登录页。
 *    本脚本自动把 `.tools/seed-ledger.js` 拼在 `.tools/cdp-probe-session.js` 之后。
 *
 * 断言的数值是**算出来的**，不是抄的：
 *   今日 35.50 + 12 + 88 = 135.50；昨日 30 → delta +105.50；日预算 100 → 超支。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const STUB = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const SEED = path.join(ROOT, '.tools', 'seed-ledger.js');
const MERGED = path.join(ROOT, '.tools', '.seed-merged.tmp.js');
const asJson = process.argv.includes('--json');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // ⚠️ 必须 path.resolve(DIST, '.'+url)：Windows 下 path.join 会丢 DIST 前缀 → 全站 403
    let file = path.resolve(DIST, '.' + url);
    if (!file.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function runProbe(url, expr, waitMs, initScript) {
  return new Promise((resolve) => {
    const args = [PROBE, url, '375', '812', '--expr', expr, '--wait', String(waitMs),
      '--init-script', initScript,
      '--block-url', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', '--logs'];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, parsed: null, stdout: out, stderr: `${err}\nspawn: ${e.message}` }));
    child.on('close', (code) => {
      let parsed = null;
      // ⚠️ 探针输出是 JSON.stringify(x, null, 2) —— 多行格式化 JSON。
      //    取「最后一非空行」必然只拿到 "}"（2026-10-15 踩过）。要 parse 整个 stdout。
      try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
      resolve({ code, parsed, stdout: out, stderr: err });
    });
  });
}

const PAGE_EXPR = `(() => {
  const txt = (document.body && document.body.innerText) || '';
  const has = (s) => txt.indexOf(s) >= 0;
  return JSON.stringify({
    ready: document.readyState,
    navigatedOk: location.protocol === 'http:' || location.protocol === 'https:',
    isBriefing: location.hash.indexOf('briefing') >= 0,
    bodyLen: txt.length,
    // 种子数据是否被 Taro 正确读出（验证格式对不对，别把种子问题误判成代码问题）
    seedReadable: (() => {
      try {
        const raw = localStorage.getItem('ledgerEntries');
        if (!raw) return false;
        const o = JSON.parse(raw);
        return !!(o && o.data && o.data.length === 4);
      } catch (e) { return false; }
    })(),
    hasCardTitle: has('今日账单'),
    hasTotal: has('135.50'),
    hasYesterdayDelta: has('105.50'),
    hasTopCategory: has('购物'),
    hasOverHint: has('超日预算'),
    hasViewAll: has('查看全部'),
    i18nLeak: (txt.match(/ledger\\.[a-zA-Z]+|briefing\\.[a-zA-Z]+/g) || []).slice(0, 5)
  });
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const skip = (reason) => { console.log(asJson ? JSON.stringify({ status: 'SKIP', reason }) : `[SKIP] ${reason}`); return 0; };
  if (!chrome) return skip('未找到 Chrome（需 CHROME_BIN 或本机已装 Chrome）');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) return skip('dist 不存在，先跑 build + copy-assets');
  if (!fs.existsSync(SEED) || !fs.existsSync(STUB)) return skip('缺少 seed-ledger.js 或 cdp-probe-session.js');

  process.env.CHROME_BIN = chrome;
  // 合并：先会话桩（决定门禁放行），后记账种子（决定卡片内容）
  fs.writeFileSync(MERGED, fs.readFileSync(STUB, 'utf8') + '\n' + fs.readFileSync(SEED, 'utf8'));

  const { server, port } = await serveDist();
  let r;
  try {
    // 等 12s：晨报要加载热点/情报/冷知识等多路数据，且 useDidShow 里的记账读取是异步的
    r = await runProbe(`http://127.0.0.1:${port}/#/pages/briefing/index`, PAGE_EXPR, 12000, MERGED);
  } finally {
    server.close();
    try { fs.unlinkSync(MERGED); } catch { /* 临时文件删不掉不影响结论 */ }
  }

  const v = r.parsed && r.parsed.value;
  const d = v && typeof v === 'string' ? JSON.parse(v) : v;
  if (!d) {
    console.log(asJson ? JSON.stringify({ status: 'FAIL', why: '探针未取到页面数据', probeCode: r.code }, null, 2)
      : `[FAIL] 探针未取到页面数据\n${r.stdout.slice(0, 800)}`);
    return 1;
  }
  if (!d.navigatedOk) {
    console.log(asJson ? JSON.stringify({ status: 'FAIL', why: `页面未真正加载（title=${d.title}）`, detail: d }, null, 2)
      : `[FAIL] 页面未真正加载 —— 先查服务，别当成记账卡片的问题`);
    return 1;
  }
  // 种子没被读出来时，后续断言全部无意义 —— 先单独报这一条，避免误导
  if (!d.seedReadable) {
    console.log(asJson
      ? JSON.stringify({ status: 'FAIL', why: '种子数据未被 Taro 正确读出（格式问题，非代码 bug）—— 其余断言无意义', detail: d }, null, 2)
      : '[FAIL] 种子数据未被 Taro 正确读出 —— 检查 .tools/seed-ledger.js 是否用了 {data:...} 包装');
    return 1;
  }

  const checks = [
    { name: '停在晨报页', pass: d.isBriefing === true, got: String(d.isBriefing) },
    { name: '种子数据被 Taro 正确读出', pass: d.seedReadable === true, got: String(d.seedReadable) },
    { name: '卡片标题「今日账单」出现', pass: d.hasCardTitle === true, got: String(d.hasCardTitle) },
    { name: '今日合计 =135.50（35.50+12+88）', pass: d.hasTotal === true, got: String(d.hasTotal) },
    { name: '较昨日 +105.50（135.50 − 30）', pass: d.hasYesterdayDelta === true, got: String(d.hasYesterdayDelta) },
    { name: '分类 Top 出现「购物」（88 最大）', pass: d.hasTopCategory === true, got: String(d.hasTopCategory) },
    { name: '超日预算提示出现（135.50 > 100）', pass: d.hasOverHint === true, got: String(d.hasOverHint) },
    { name: '「查看全部」入口存在', pass: d.hasViewAll === true, got: String(d.hasViewAll) },
    { name: 'i18n 无 key 漏翻', pass: Array.isArray(d.i18nLeak) && d.i18nLeak.length === 0, got: JSON.stringify(d.i18nLeak || []) }
  ];

  const pass = checks.every((c) => c.pass);
  const out = { status: pass ? 'PASS' : 'FAIL', checks, detail: d };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n晨报「今日账单」卡片 —— ${out.status}`);
    for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.got}`);
  }
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[verify-ledger-briefing] crashed:', err && err.message ? err.message : err);
  process.exit(2);
});