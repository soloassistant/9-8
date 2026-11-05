#!/usr/bin/env node
/**
 * 启动性能 / 首屏包体实测（可反复执行，口径锁死在 catalog.json + 本脚本常量里）
 *
 * 为什么存在（2026-11-05）：
 *   340.9 / 387.3 / 339.5 这三个数在报告里被当成同一个「首屏包体」在用，但口径完全不同：
 *   340.9 是 4 个文件（app.js + 506 + 357 + app.css）、387.3 是 12 个请求、339.5 是复测。
 *   靠「临时开一次浏览器」量出来的数不可复现，chunk id 还会随构建漂移（本次实测 506→0）。
 *   ⇒ 把口径、解析规则、门禁阈值全部落到仓库里，任何人 `npm run measure:startup` 都能复现。
 *
 * 口径（唯一权威定义）：
 *   主指标 = 4 个 chunk（入口 JS + vendor JS + 首屏 route JS + 入口 CSS）的 **gzip 之和**（KB = 1024 B）。
 *   → 匹配规则**只按角色**（entry-js / vendor-js / route-js / entry-css），这是唯一真源。
 *   → chunk id 每次构建都会变（本次实测历史 506 / 357 已不存在），**禁止用 id 做判据**；
 *     catalog 里的 historicalChunkId 仅用于打印 DRIFT 注释，不参与匹配。
 *   文件名带 hash，一律从 dist/index.html（入口引用）+ app.<hash>.js 里的 webpack chunk map
 *   （__webpack_require__.u / miniCssF）解析；**不许硬编码文件名**。
 *   副指标 = 从导航开始到「首个用户交互」的全部请求 gzip 之和，只记趋势、不判达标。
 *   主指标衡量「代码体积」，副指标衡量「用户真实等待」；两者不可混为一谈。
 *
 * 单位：KB = 1024 B。gzip = 线上传输的压缩体积（CDP encodedDataLength，含响应头）。
 * 退出码：0 正常 / 1 门禁超标（仅 --gate）/ 2 产物或口径无效（缺 dist、缺 builtAt、口径被改）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, '..', '..');
const KB = 1024;

/** 口径签名：catalog.json 的规范串 sha256。改口径必须同时改这里（显式动作，防静默漂移） */
const CATALOG_SHA256 = '8286dc0ae74ee1a8f38c415a1be7c7172e35bc01a124ec62216ca40453bcc152';

/** 环境常量（写死，避免「这次是 wifi、上次是 3G」的口径漂移） */
const ENV_CONST = {
  network: 'Fast 3G',
  latencyMs: 150,
  downloadThroughput: 200 * KB, // 1.6 Mbps ≈ 200 KB/s
  uploadThroughput: 75 * KB,
  cpuThrottle: 4,
  width: 390,
  height: 844,
  dsf: 2,
  mobile: true,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  navUrl: '/index.html#/pages/briefing/index'
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  path.join(os.homedir(), '.agent-browser', 'browsers', 'chrome-154.0.8037.92', 'chrome.exe')
].filter(Boolean);

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    gate: false,
    runs: 3,
    threshold: null,
    // 允许用环境变量指向别的仓库/产物（CI 或「脚本在 worktree、被测产物在主工作区」时用）
    repo: process.env.STARTUP_PERF_REPO ? path.resolve(process.env.STARTUP_PERF_REPO) : DEFAULT_REPO,
    dist: process.env.STARTUP_PERF_DIST ? path.resolve(process.env.STARTUP_PERF_DIST) : null,
    out: process.env.STARTUP_PERF_OUT ? path.resolve(process.env.STARTUP_PERF_OUT) : null,
    catalog: null,
    headRepo: process.env.STARTUP_PERF_HEAD_REPO ? path.resolve(process.env.STARTUP_PERF_HEAD_REPO) : null,
    ackCatalogChange: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gate') o.gate = true;
    else if (a === '--runs') o.runs = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === '--threshold') o.threshold = parseFloat(argv[++i]);
    else if (a === '--repo') o.repo = path.resolve(argv[++i]);
    else if (a === '--dist') o.dist = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--catalog') o.catalog = path.resolve(argv[++i]);
    else if (a === '--head-repo') o.headRepo = path.resolve(argv[++i]);
    else if (a === '--ack-catalog-change') o.ackCatalogChange = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node .tools/startup-perf/measure-startup.mjs [--gate] [--threshold KB] [--runs N] [--repo DIR] [--dist DIR] [--out DIR] [--catalog FILE]');
      console.log('      npm run measure:startup');
      console.log('      npm run measure:startup:gate');
      console.log('      npm run measure:startup:gate -- --threshold 345   # 临时覆盖阈值（默认取 catalog.gate.defaultThresholdKB=339）');
      process.exit(0);
    }
  }
  o.dist = o.dist || path.join(o.repo, 'dist');
  o.catalog = o.catalog || path.join(HERE, 'catalog.json');
  o.out = o.out || path.join(o.repo, '.tmp-startup-perf');
  return o;
}

const args = parseArgs(process.argv.slice(2));

// ── 工具 ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class Invalid extends Error {
  constructor(msg, detail) {
    super(msg);
    this.detail = detail;
  }
}

function die(msg, detail) {
  throw new Invalid(msg, detail);
}

/** 稳定序列化：只取口径字段，desc 等说明文字不参与签名 */
function canonicalCatalog(c) {
  return JSON.stringify({
    id: c.id,
    unit: c.unit,
    metric: c.metric,
    expect: { count: c.expect.count, aliases: [...c.expect.aliases], roles: [...c.expect.roles] },
    mainSet: {
      members: c.mainSet.members.map((m) => ({ alias: m.alias, role: m.role, historicalChunkId: m.historicalChunkId ?? null }))
    },
    baseline: {
      date: c.baseline.date,
      mainKB: c.baseline.mainKB,
      remeasuredMainKB: c.baseline.remeasuredMainKB,
      source: c.baseline.source
    },
    firstScreenSources: [...c.firstScreenSources]
  });
}

// ── 口径校验（变异必红 ②） ───────────────────────────────────────────────────
function loadCatalog(file) {
  if (!fs.existsSync(file)) die(`口径文件缺失: ${file}（不许跳过口径直接量）`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`口径文件不是合法 JSON: ${file}`, String(e.message));
  }
  const canon = canonicalCatalog(raw);
  const sha = sha256(canon);
  if (sha !== CATALOG_SHA256) {
    if (!args.ackCatalogChange) {
      die(
        '口径被修改（catalog 签名不匹配）',
        `期望 ${CATALOG_SHA256}\n实得 ${sha}\n` +
          '若这是有意的口径变更：同步更新 measure-startup.mjs 里的 CATALOG_SHA256，或加 --ack-catalog-change 临时放行（会写进 JSON）'
      );
    }
    console.log(`⚠ 口径变更已放行（--ack-catalog-change）：${sha}`);
  }

  const ex = raw.expect || {};
  const members = (raw.mainSet && raw.mainSet.members) || [];
  const aliases = members.map((m) => m.alias);
  const roles = members.map((m) => m.role);
  const problems = [];
  if (members.length !== ex.count) problems.push(`成员数量 ${members.length} ≠ 期望 ${ex.count}`);
  if (ex.count !== 4) problems.push(`期望成员数 ${ex.count} ≠ 4（口径必须是 4 个 chunk）`);
  for (const a of ex.aliases || []) if (!aliases.includes(a)) problems.push(`缺少成员 ${a}`);
  for (const a of aliases) if (!(ex.aliases || []).includes(a)) problems.push(`多出成员 ${a}`);
  for (const r of ex.roles || []) if (!roles.includes(r)) problems.push(`缺少角色 ${r}`);
  if (new Set(aliases).size !== aliases.length) problems.push('成员 alias 重复');
  if (problems.length) {
    die('主指标集合口径不合法', problems.join('\n') + '\n（口径被改成「只算 app.js」这类改动必须被这条拦住）');
  }
  return { catalog: raw, sha };
}

// ── 产物校验 ─────────────────────────────────────────────────────────────────
function readArtifact(dist) {
  if (!fs.existsSync(dist)) die(`被测产物缺失: ${dist}（先构建；不许用旧产物顶上）`);
  const indexPath = path.join(dist, 'index.html');
  if (!fs.existsSync(indexPath)) die(`被测产物缺失: ${indexPath}`);
  const stampPath = path.join(dist, 'build-stamp.json');
  if (!fs.existsSync(stampPath)) die(`构建清单缺失: ${stampPath}（无法确认 builtAt/head）`);
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch (e) {
    die(`构建清单不是合法 JSON: ${stampPath}`, String(e.message));
  }
  // 变异必红 ③：builtAt 缺失必须报错，不许静默跳过
  if (!stamp.builtAt || typeof stamp.builtAt !== 'string') {
    die('构建清单缺少 builtAt（无法确认产物构建时间，拒绝测量）', JSON.stringify(Object.keys(stamp)));
  }
  if (!stamp.head) die('构建清单缺少 head（无法确认产物对应 commit）');
  const builtAtMs = Date.parse(stamp.builtAt);
  if (!Number.isFinite(builtAtMs)) die(`builtAt 不是合法时间: ${stamp.builtAt}`);

  const html = fs.readFileSync(indexPath, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => {
    const attrs = m[1];
    const src = (attrs.match(/src="([^"]+)"/) || [])[1] || '';
    return { src, defer: /\bdefer\b/.test(attrs), async: /\basync\b/.test(attrs) };
  }).filter((s) => s.src);
  const styles = [...html.matchAll(/<link\b([^>]*)>/g)]
    .map((m) => m[1])
    .filter((a) => /rel="stylesheet"/.test(a))
    .map((a) => (a.match(/href="([^"]+)"/) || [])[1])
    .filter(Boolean);

  const toPath = (u) => {
    const clean = u.replace(/^\.\//, '');
    return clean.startsWith('/') ? clean : `/${clean}`;
  };
  const entry = scripts.find((s) => /^\.?\/?js\/app\.[0-9a-z]+\.js$/i.test(s.src.replace(/^\.\//, '')));
  const entryCss = styles.find((s) => /app\.[0-9a-z]+\.css$/i.test(s));
  const deferOthers = scripts.filter((s) => s.defer && !s.async && s !== entry && /\bjs\/[\w.-]+\.js$/i.test(s.src));
  if (!entry) die('入口脚本 app.<hash>.js 未在 dist/index.html 中声明', JSON.stringify(scripts));
  if (!entryCss) die('入口样式 app.<hash>.css 未在 dist/index.html 中声明', JSON.stringify(styles));
  if (deferOthers.length !== 1) {
    die(
      `index.html 中与入口同批的 defer 脚本数量异常: ${deferOthers.length}`,
      '口径假设「恰好 1 个 vendor（历史 chunk id 506）」；结构变了必须重新确认口径'
    );
  }
  const entryFile = path.join(dist, toPath(entry.src));
  if (!fs.existsSync(entryFile)) die(`产物缺失：index.html 指向 ${entry.src}，但文件不存在（哈希已切换？）`);
  const cssFile = path.join(dist, toPath(entryCss));
  if (!fs.existsSync(cssFile)) die(`产物缺失：index.html 指向 ${entryCss}，但文件不存在`);

  // webpack chunk id → hash 映射（构建清单本体，不是硬编码）
  // 直接按「u 映射段」切片再抽 "id":"hash"，比整段结构正则稳（压缩后的箭头/函数写法都见过）
  const appSrc = fs.readFileSync(entryFile, 'utf8');
  const uIdx = appSrc.indexOf('__webpack_require__.u=');
  const cssIdx = appSrc.indexOf('__webpack_require__.miniCssF=', uIdx);
  const uSeg = uIdx >= 0 ? appSrc.slice(uIdx, cssIdx > uIdx ? cssIdx : uIdx + 4000) : '';
  const chunkMap = {};
  for (const kv of uSeg.matchAll(/"(\d+)":"([0-9a-f]{6,12})"/g)) chunkMap[kv[1]] = kv[2];
  if (!Object.keys(chunkMap).length) console.log('⚠ 未解析到 webpack chunk map（__webpack_require__.u），pinned chunk id 将不可用');

  return {
    dist,
    indexPath,
    stamp,
    builtAtMs,
    html,
    entry,
    entryCss,
    vendor: deferOthers[0],
    chunkMap,
    assetPaths: {
      'entry-js': toPath(entry.src),
      'vendor-js': toPath(deferOthers[0].src),
      'entry-css': toPath(entryCss)
    }
  };
}

// ── 静态服务（必须 gzip，否则 encodedDataLength 会退化成原始体积） ──────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};
const GZIP_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);

function startServer(dist, port) {
  const served = new Map(); // pathname → { rawBytes, gzipBytes }
  const server = http.createServer((req, res) => {
    let p = '/';
    try {
      p = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    } catch {}
    if (p === '/' || p === '') p = '/index.html';
    let file = path.join(dist, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // 只对根路径回落到 index.html；其它缺失路径一律 404。
      // （曾经把 /api/briefing 也回落成 index.html，导致「接口请求」被当成 4.7KB 的 HTML 计入副指标）
      if (p === '/index.html') file = path.join(dist, 'index.html');
      else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const raw = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding'
    };
    let body = raw;
    let gz = null;
    if (GZIP_EXT.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      gz = zlib.gzipSync(raw, { level: 6 }); // level 6 = 基线口径（340.9 那套数就是这么量的）
      body = gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    served.set(p, { rawBytes: raw.length, gzipBytes: gz ? gz.length : raw.length, encoding: gz ? 'gzip' : 'identity' });
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        served,
        close: () =>
          new Promise((r) => {
            try {
              server.close(() => r());
            } catch {
              r();
            }
          })
      });
    });
  });
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 40) return reject(new Error('找不到空闲端口'));
      const s = http.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// ── Chrome / CDP ─────────────────────────────────────────────────────────────
function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  const root = path.join(os.homedir(), '.agent-browser', 'browsers');
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root).filter((d) => /chrome-/.test(d)).sort();
    for (const d of dirs.reverse()) {
      const exe = path.join(root, d, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  die('找不到 Chrome（可用 CHROME_BIN 指定）');
}

async function launchChrome(port) {
  const exe = findChrome();
  const udd = path.join(os.tmpdir(), `startup-perf-chrome-${port}-${Date.now()}`);
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--no-proxy-server',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--force-device-scale-factor=1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${udd}`,
      '--window-size=390,844',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        version = (await r.json()).Browser || null;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!version) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    die(`Chrome 未就绪（port ${port}）`);
  }
  return {
    version,
    kill() {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
      try {
        fs.rmSync(udd, { recursive: true, force: true });
      } catch {}
    }
  };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) fn(msg.params);
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeout);
    });
  }
}

/** 页面内 instrumentation：FCP / LCP / longtask / 首次交互打点 */
const INSTRUMENT = String.raw`
(function(){
  var P = { fcp:null, lcp:null, longtasks:[], interactionAt:null };
  window.__PM = P;
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ if(P.fcp==null && e.name==='first-contentful-paint'){ P.fcp = e.startTime; } }); }).observe({type:'paint', buffered:true}); }catch(e){}
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ P.lcp = e.startTime; }); }).observe({type:'largest-contentful-paint', buffered:true}); }catch(e){}
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ P.longtasks.push({ s:e.startTime, d:e.duration, n:e.name }); }); }).observe({type:'longtask', buffered:true}); }catch(e){}
  P.touch = function(){ P.interactionAt = performance.now(); };
  try{
    localStorage.setItem('privacy-consent', JSON.stringify({data:{agreed:true,version:'v1.7-20261024',time:Date.now()}}));
    localStorage.setItem('sxm-privacy-consent', JSON.stringify({data:true}));
    localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));
  }catch(e){}
})();
`;

async function openPage(debugPort) {
  const t = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  try {
    await cdp.send('Page.setBypassServiceWorker', { bypass: true });
  } catch {}
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: ENV_CONST.width,
    height: ENV_CONST.height,
    deviceScaleFactor: ENV_CONST.dsf,
    mobile: ENV_CONST.mobile
  });
  try {
    await cdp.send('Emulation.setLocaleOverride', { locale: ENV_CONST.locale });
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: ENV_CONST.timezone });
  } catch {}
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: ENV_CONST.cpuThrottle });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: ENV_CONST.latencyMs,
    downloadThroughput: ENV_CONST.downloadThroughput,
    uploadThroughput: ENV_CONST.uploadThroughput,
    connectionType: 'cellular3g'
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  return {
    cdp,
    targetId: t.id,
    async close() {
      try {
        await fetch(`http://127.0.0.1:${debugPort}/json/close/${t.id}`);
      } catch {}
      try {
        ws.close();
      } catch {}
    }
  };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.text || ''));
  return r.result?.value;
}

async function waitFor(cdp, expr, timeout, interval = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await evaluate(cdp, expr)) return true;
    } catch {}
    await sleep(interval);
  }
  return false;
}

// ── 单次冷启动 ───────────────────────────────────────────────────────────────
async function oneRun({ server, debugPort, runIndex }) {
  const br = await launchChrome(debugPort);
  const page = await openPage(debugPort);
  const reqMap = new Map();
  const ledger = [];
  const cdp = page.cdp;
  cdp.on('Network.requestWillBeSent', (p) => {
    const e = {
      requestId: p.requestId,
      url: p.request.url,
      wallMs: Date.now(),
      type: null,
      initiatorType: p.initiator?.type || '',
      initiatorFn: p.initiator?.stack?.callFrames?.[0]?.functionName || '',
      encodedDataLength: null,
      status: null,
      mimeType: '',
      encoding: 'identity',
      failed: false
    };
    reqMap.set(p.requestId, e);
    ledger.push(e);
  });
  cdp.on('Network.responseReceived', (p) => {
    const e = reqMap.get(p.requestId);
    if (!e) return;
    e.type = p.type;
    e.status = p.response.status;
    e.mimeType = p.response.mimeType || '';
    e.encoding = (p.response.headers && (p.response.headers['content-encoding'] || p.response.headers['Content-Encoding'])) || 'identity';
  });
  cdp.on('Network.loadingFinished', (p) => {
    const e = reqMap.get(p.requestId);
    if (e) e.encodedDataLength = p.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (p) => {
    const e = reqMap.get(p.requestId);
    if (e) e.failed = true;
  });

  const url = `http://127.0.0.1:${server.port}${ENV_CONST.navUrl}`;
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url });

  // 等开屏（Splash）出现：它就是用户能看见的第一个可交互元素
  const splashOk = await waitFor(
    cdp,
    `(()=>{var s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');return !!s;})()`,
    20000,
    100
  );
  let clickPoint = { x: ENV_CONST.width / 2, y: ENV_CONST.height / 2 };
  if (splashOk) {
    try {
      const box = await evaluate(
        cdp,
        `(()=>{var s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');var r=s.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`
      );
      clickPoint = JSON.parse(box);
    } catch {}
  }
  // 首个用户交互：真实鼠标点击（不是 JS .click()）
  const interactionWallMs = Date.now();
  try {
    await evaluate(cdp, 'window.__PM && window.__PM.touch()');
  } catch {}
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });

  // 合规层（正常被 init script 预置跳过；兜底点一次）
  await sleep(500);
  await evaluate(
    cdp,
    `(()=>{var b=document.querySelector('[class*="consentAgree"]');if(b){b.click();return 'clicked';}return 'none';})()`
  ).catch(() => {});

  // 等首屏稳定：骨架消失 + 500ms 无长任务（上限 30s）
  await waitFor(
    cdp,
    `(()=>{var sk=document.getElementById('boot-skeleton');var c=document.getElementById('container');var P=window.__PM;if(!P||!P.fcp)return false;if(sk&&sk.isConnected&&getComputedStyle(sk).display!=='none')return false;if(!c||c.querySelectorAll('*').length<3)return false;var now=performance.now();var last=P.longtasks.length?P.longtasks[P.longtasks.length-1].s+P.longtasks[P.longtasks.length-1].d:0;return now-last>500&&now>1000;})()`,
    30000,
    100
  );
  await sleep(1000);

  const raw = await evaluate(
    cdp,
    `JSON.stringify((function(){
      var P = window.__PM || {};
      var n = performance.getEntriesByType('navigation')[0] || {};
      return {
        fcp: P.fcp, lcp: P.lcp, interactionAt: P.interactionAt,
        longtasks: P.longtasks || [],
        dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd,
        responseStart: n.responseStart, domNodes: document.querySelectorAll('*').length,
        title: document.title
      };
    })())`
  );
  const pm = JSON.parse(raw);
  const settleWallMs = Date.now();
  await page.close();
  br.kill();
  await sleep(300);

  return {
    runIndex,
    chromeVersion: br.version,
    fcp: pm.fcp == null ? null : Math.round(pm.fcp * 10) / 10,
    lcp: pm.lcp == null ? null : Math.round(pm.lcp * 10) / 10,
    dcl: pm.dcl == null ? null : Math.round(pm.dcl * 10) / 10,
    load: pm.load == null ? null : Math.round(pm.load * 10) / 10,
    interactionAt: pm.interactionAt == null ? null : Math.round(pm.interactionAt * 10) / 10,
    interactionWallMs: interactionWallMs - t0,
    settleWallMs: settleWallMs - t0,
    domNodes: pm.domNodes,
    longtasks: pm.longtasks.map((l) => ({ s: Math.round(l.s * 10) / 10, d: Math.round(l.d * 10) / 10 })),
    requests: ledger
      .filter((e) => !e.failed && e.encodedDataLength != null)
      .map((e) => {
        const u = new URL(e.url, `http://127.0.0.1:${server.port}`);
        const pn = u.pathname;
        const sv = server.served.get(pn);
        return {
          url: pn,
          type: e.type || '',
          initiator: e.initiatorType + (e.initiatorFn ? `:${e.initiatorFn}` : ''),
          encodedDataLength: e.encodedDataLength,
          decodedBytes: sv ? sv.rawBytes : 0,
          encoding: sv ? sv.encoding : e.encoding,
          status: e.status,
          wallMs: e.wallMs - t0
        };
      })
  };
}

// ── 派生指标 ─────────────────────────────────────────────────────────────────
function tbt(longtasks, fcp, endAt) {
  const from = fcp == null ? 0 : fcp;
  const to = endAt == null ? Infinity : endAt;
  let sum = 0;
  for (const l of longtasks) if (l.s >= from && l.s <= to) sum += Math.max(0, l.d - 50);
  return Math.round(sum);
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** 角色解析是唯一匹配规则；historicalChunkId 只用来报告「历史 id 已漂移」，不参与主指标匹配。 */
function resolvedMembers(artifact) {
  const { catalog } = state;
  const map = {};
  const drift = [];
  for (const m of catalog.mainSet.members) {
    const rolePath = artifact.assetPaths[m.role] || null;
    const hist = m.historicalChunkId ?? null;
    let histPath = null;
    if (hist != null) {
      const hash = artifact.chunkMap[String(hist)];
      histPath = hash ? `/js/${hist}.${hash}.js` : null;
    }
    if (hist != null) {
      drift.push({
        alias: m.alias,
        historicalChunkId: hist,
        historicalPath: histPath,
        rolePath,
        note: histPath
          ? rolePath === histPath
            ? '历史 id 与角色解析一致（仅参考）'
            : '历史 id 与角色解析不一致（仅参考，不参与匹配）'
          : '历史 chunk id 在当前构建不存在（id 已漂移）；主指标按角色解析'
      });
    }
    map[m.alias] = { role: m.role, alias: m.alias, path: rolePath, resolvedBy: rolePath ? 'role' : null, historicalChunkId: hist };
  }
  return { map, drift };
}

function pickRouteFallback(requests, exclude) {
  const cands = requests.filter(
    (r) => /\.js$/.test(r.url) && !exclude.includes(r.url) && !/wb-sdk\.js$/.test(r.url) && r.status === 200
  );
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.encodedDataLength > a.encodedDataLength ? b : a));
}

const CATEGORY = (type) =>
  type === 'Script' || type === 'Stylesheet' ? '代码' : type === 'Fetch' || type === 'XHR' ? '数据' : type === 'Image' ? '图片' : type === 'Font' ? '字体' : '其它';

function analyzeRun(run, artifact, memberMap) {
  const reqByPath = new Map();
  for (const r of run.requests) if (!reqByPath.has(r.url)) reqByPath.set(r.url, r);

  const parts = {};
  for (const [alias, m] of Object.entries(memberMap)) {
    let p = m.path;
    if (!p && m.role === 'route-js') {
      const ex = Object.values(memberMap)
        .filter((x) => x.role === 'entry-js' || x.role === 'vendor-js')
        .map((x) => x.path)
        .filter(Boolean);
      const best = pickRouteFallback(run.requests, ex);
      p = best ? best.url : null;
      m.resolvedBy = 'role:largest-non-entry-script';
      m.path = p;
    }
    const req = p ? reqByPath.get(p) : null;
    if (!req) {
      // 该成员在本次加载中没有被请求 ⇒ 口径失效，不能拿 0 顶上
      throw new Invalid(`主指标成员未被请求: ${alias} → ${p || '(无法解析)'}`, '产物或路由变了，先确认口径');
    }
    parts[alias] = {
      alias,
      role: m.role,
      url: req.url,
      encodedDataLength: req.encodedDataLength,
      decodedBytes: req.decodedBytes,
      encoding: req.encoding,
      resolvedBy: m.resolvedBy,
      historicalChunkId: m.historicalChunkId
    };
  }
  const mainBytes = Object.values(parts).reduce((a, b) => a + b.encodedDataLength, 0);
  const mainKB = mainBytes / KB;

  const sub = run.requests.filter((r) => r.wallMs <= run.interactionWallMs - 0);
  const subBytes = sub.reduce((a, b) => a + b.encodedDataLength, 0);
  const subCats = { 代码: 0, 数据: 0, 图片: 0, 字体: 0, 其它: 0 };
  for (const r of sub) subCats[CATEGORY(r.type)] += r.encodedDataLength;
  // 数据类不论是否在副指标窗口内都列出来：交互后才发起的接口不进 418.8，但用户仍在等它。
  const dataItems = run.requests
    .filter((r) => CATEGORY(r.type) === '数据' && r.encodedDataLength > 10 * KB)
    .sort((a, b) => b.encodedDataLength - a.encodedDataLength)
    .map((r) => ({ url: r.url, bytes: r.encodedDataLength, kb: r.encodedDataLength / KB, inSub: r.wallMs <= run.interactionWallMs }));

  const lt = run.longtasks;
  const ltMax = lt.length ? Math.max(...lt.map((l) => l.d)) : 0;
  return {
    parts,
    mainKB,
    mainBytes,
    subKB: subBytes / KB,
    subBytes,
    subCats,
    dataItems,
    requestCount: run.requests.length,
    subRequestCount: sub.length,
    tbtMs: tbt(lt, run.fcp, run.interactionAt == null ? null : run.interactionAt),
    longtaskCount: lt.length,
    longtaskMaxMs: ltMax
  };
}

// ── 一致性（源码 sha256 vs build-stamp） ──────────────────────────────────────
function checkConsistency(repo, artifact, catalog) {
  const files = artifact.stamp.files || {};
  const rows = [];
  let ok = 0;
  let bad = 0;
  let missing = 0;
  const mismatches = [];
  for (const [rel, want] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) {
      missing += 1;
      mismatches.push({ path: rel, status: 'MISSING' });
      continue;
    }
    const got = sha256(fs.readFileSync(abs));
    if (got === want) ok += 1;
    else {
      bad += 1;
      mismatches.push({ path: rel, status: 'MISMATCH', want, got });
    }
  }
  for (const rel of catalog.firstScreenSources) {
    const abs = path.join(repo, rel);
    const want = files[rel];
    let status;
    if (!want) status = 'NOT-IN-STAMP';
    else if (!fs.existsSync(abs)) status = 'MISSING';
    else status = sha256(fs.readFileSync(abs)) === want ? 'MATCH' : 'MISMATCH';
    rows.push({ path: rel, status, want: want || null });
  }
  return {
    firstScreen: rows,
    totals: { files: Object.keys(files).length, match: ok, mismatch: bad, missing },
    mismatches: mismatches.slice(0, 40)
  };
}

// ── 环境指纹 ─────────────────────────────────────────────────────────────────
function resolveHead(headRepo) {
  try {
    const dotgit = path.join(headRepo, '.git');
    if (!fs.existsSync(dotgit)) return { head: null, note: '无 .git' };
    let gitDir = dotgit;
    let commonDir = dotgit;
    if (fs.statSync(dotgit).isFile()) {
      // linked worktree：.git 是文件，内容为 "gitdir: <path>"
      const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return { head: null, note: '.git 文件无 gitdir' };
      gitDir = path.resolve(headRepo, m[1].trim());
      const cFile = path.join(gitDir, 'commondir');
      commonDir = fs.existsSync(cFile) ? path.resolve(gitDir, fs.readFileSync(cFile, 'utf8').trim()) : gitDir;
    }
    const headFile = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headFile)) return { head: null, note: '无 .git/HEAD' };
    const head = fs.readFileSync(headFile, 'utf8').trim();
    if (/^ref: refs\//.test(head)) {
      const refName = head.replace(/^ref:\s*/, '');
      const refPath = path.join(commonDir, refName);
      if (fs.existsSync(refPath)) return { head: fs.readFileSync(refPath, 'utf8').trim(), note: 'ref' };
      const packed = path.join(commonDir, 'packed-refs');
      if (fs.existsSync(packed)) {
        const line = fs.readFileSync(packed, 'utf8').split('\n').find((l) => l.includes(refName));
        if (line) return { head: line.split(' ')[0], note: 'packed-refs' };
      }
      return { head: null, note: 'ref 不存在' };
    }
    return { head, note: 'detached' };
  } catch (e) {
    return { head: null, note: String(e.message) };
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const pad = (s, n) => {
  s = String(s);
  // 中文按 2 个宽度估算，保证表格不歪
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
};
const kb = (b) => (b / KB).toFixed(1);

function printEnv(env) {
  console.log('\n── 环境指纹 ─────────────────────────────────────────────');
  console.log(`repo(src)          ${env.repo}`);
  console.log(`dist(被测产物)     ${env.dist}`);
  console.log(`head(build-stamp)  ${env.stampHead}`);
  console.log(`head(repo HEAD)    ${env.repoHead || '(不可用)'}  [${env.repoHeadNote}]`);
  console.log(`builtAt            ${env.builtAt}`);
  console.log(`dirty              ${env.dirty}  treeDirtyCount=${env.treeDirtyCount}`);
  console.log(`node               ${env.node}`);
  console.log(`chrome             ${env.chrome}`);
  console.log(`network            ${env.network}（latency ${env.latencyMs}ms / down ${env.downKB}KB/s / up ${env.upKB}KB/s）`);
  console.log(`cpu                4x（Emulation.setCPUThrottlingRate）`);
  console.log(`viewport           ${env.width}x${env.height} @${env.dsf}x  locale=${env.locale}  tz=${env.timezone}`);
  console.log(`cache              disabled（Network.setCacheDisabled + 每次独立 Chrome）`);
}

function printRuns(runs) {
  console.log('\n── 三次冷启动原始值（每次都是全新 Chrome + 禁缓存 + Fast 3G + CPU 4x） ─────');
  const head = [5, 11, 11, 8, 9, 9, 9, 9, 8, 9, 9];
  const titles = ['run', '主指标KB', '副指标KB', '请求数', 'FCP ms', 'LCP ms', 'DCL ms', 'load ms', '长任务', '最长 ms', 'TBT ms'];
  console.log(titles.map((t, i) => pad(t, head[i])).join(''));
  const line = (label, vals) => console.log(vals.map((v, i) => pad(v == null ? '-' : v, head[i])).join(''));
  runs.forEach((r, i) => {
    const a = r.analysis;
    line(String(i + 1), [i + 1, kb(a.mainBytes), kb(a.subBytes), a.requestCount, r.fcp, r.lcp, r.dcl, r.load, a.longtaskCount, a.longtaskMaxMs, a.tbtMs]);
  });
  const med = runs.medians;
  line('MED', ['MED', kb(med.mainBytes), kb(med.subBytes), med.requestCount, med.fcp, med.lcp, med.dcl, med.load, med.longtaskCount, med.longtaskMaxMs, med.tbtMs]);
}

function printRequests(run, memberPaths) {
  console.log('\n── 请求明细（中位数那一次；gzip=encodedDataLength，含响应头） ──────────');
  console.log(pad('URL', 46) + pad('gzip B', 10) + pad('KB', 7) + pad('解压 B', 10) + pad('enc', 9) + pad('主集合', 7) + '类型');
  for (const r of [...run.requests].sort((a, b) => b.encodedDataLength - a.encodedDataLength)) {
    const isMain = memberPaths.includes(r.url) ? '●' : '';
    console.log(
      pad(r.url.length > 44 ? r.url.slice(0, 43) + '…' : r.url, 46) +
        pad(r.encodedDataLength, 10) +
        pad(kb(r.encodedDataLength), 7) +
        pad(r.decodedBytes, 10) +
        pad(r.encoding, 9) +
        pad(isMain, 7) +
        (r.type || '-')
    );
  }
}

function printSummary(state, med, diff) {
  const { catalog } = state;
  const ct = state.consistency.totals;
  console.log('\n── 汇总（中位数；KB = 1024 B） ─────────────────────────────');
  console.log('口径提示：主指标衡量「代码体积」；副指标衡量「用户真实等待」（含接口数据/图片）。两者别混着说「首屏变小了」。');
  if (ct.mismatch || ct.missing) {
    console.log(`⚠ 产物与源码不一致，以下数字不代表当前分支（MISMATCH ${ct.mismatch} / MISSING ${ct.missing}）`);
  }
  console.log(`主指标(gzip)      ${kb(med.mainBytes)} KB  [measured]  基线 ${catalog.baseline.mainKB} / 复测 ${catalog.baseline.remeasuredMainKB}`);
  if (diff) console.log(`  vs 上一次 JSON    ${diff.deltaKB >= 0 ? '+' : ''}${diff.deltaKB.toFixed(1)} KB（${diff.prevMainKB.toFixed(1)} → ${kb(med.mainBytes)}）`);
  console.log(`副指标(gzip)      ${kb(med.subBytes)} KB  [measured，仅趋势，不判达标]  ${med.subRequestCount} 个请求`);
  console.log('  副指标构成（按类型，gzip）：');
  const totalSub = med.subBytes || 1;
  for (const [k, v] of Object.entries(med.subCats || {})) {
    console.log(`    ${pad(k, 5)} ${pad(kb(v), 8)} KB  ${((v / totalSub) * 100).toFixed(1)}%`);
  }
  if (med.dataItems && med.dataItems.length) {
    const inSub = med.dataItems.filter((d) => d.inSub);
    const outSub = med.dataItems.filter((d) => !d.inSub);
    console.log('  数据类 >10KB（单列；它们进首屏，但一律不进主指标）：');
    for (const d of inSub) console.log(`    ${pad(d.url, 46)} ${pad(kb(d.bytes), 8)} KB  [在副指标窗口内]`);
    for (const d of outSub) console.log(`    ${pad(d.url, 46)} ${pad(kb(d.bytes), 8)} KB  [交互后才发起，未计入副指标]`);
    if (!inSub.length) console.log(`    ⚠ 副指标窗口内没有数据类；上面这些接口都不在 ${kb(med.subBytes)} KB 里，不能把它们算进「首屏包体」。`);
  } else {
    console.log('  数据类 >10KB：无');
  }
  console.log(`请求数            ${med.requestCount}`);
  console.log(`FCP               ${med.fcp == null ? '-' : med.fcp + ' ms'}  [measured]`);
  console.log(`LCP               ${med.lcp == null ? '-' : med.lcp + ' ms'}  [measured]`);
  console.log(`DCL               ${med.dcl == null ? '-' : med.dcl + ' ms'}  [measured]`);
  console.log(`load              ${med.load == null ? '-' : med.load + ' ms'}  [measured]`);
  console.log(`长任务            ${med.longtaskCount} 次 / 最长 ${med.longtaskMaxMs} ms  [measured]`);
  console.log(`TBT(FCP→首次交互) ${med.tbtMs} ms  [estimated：由 measured 长任务推导 Σ(长任务-50ms)]`);
  console.log('\n── 主指标 4 个 chunk（中位数那一次） ────────────────────────');
  for (const p of Object.values(med.parts)) {
    console.log(
      pad(p.alias, 9) +
        pad(kb(p.encodedDataLength), 9) +
        'KB  ' +
        pad(p.url, 42) +
        ` [${p.resolvedBy}]`
    );
  }
  if (state.drift.length) {
    console.log('\n⚠ DRIFT 口径漂移（历史 chunk id 不参与匹配；主指标按角色解析）');
    for (const d of state.drift) {
      const resolved = med.parts && med.parts[d.alias] ? med.parts[d.alias].url : '(缺)';
      console.log(`  ${d.alias}: 历史 id ${d.historicalChunkId} ${d.historicalPath ? `→ ${d.historicalPath}` : '在当前构建不存在'}；主指标按角色 → ${resolved}（${d.note}）`);
    }
    console.log('  ⇒ 历史数字只能按「角色规则」横向比较，不能按 chunk id 逐字节比较；chunk id 每次构建都会变，禁止用它做判据。');
  }
  console.log('\n── 被测代码一致性（src sha256 vs build-stamp） ─────────────');
  for (const r of state.consistency.firstScreen) {
    console.log(pad(r.path, 44) + r.status);
  }
  const t = state.consistency.totals;
  console.log(`全量输入 ${t.files} 个：MATCH ${t.match} / MISMATCH ${t.mismatch} / MISSING ${t.missing}`);
  if (t.mismatch || t.missing) {
    console.log('MISMATCH 明细（最多 40 条）：');
    for (const m of state.consistency.mismatches) console.log(`  ${m.status}  ${m.path}`);
    console.log('  ⇒ 产物不是用当前源码构建的：包体/运行时的数不能代表当前分支。');
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const state = { catalog: null };

(async () => {
  fs.mkdirSync(args.out, { recursive: true });
  const { catalog, sha: catalogSha } = loadCatalog(args.catalog);
  state.catalog = catalog;
  const artifact = readArtifact(args.dist);
  const { map: memberMap, drift } = resolvedMembers(artifact);
  state.drift = drift;
  const consistency = checkConsistency(args.repo, artifact, catalog);
  state.consistency = consistency;

  const serverPort = await findFreePort(9380);
  const debugPort = await findFreePort(9390);
  const server = await startServer(artifact.dist, serverPort);
  fs.mkdirSync(args.out, { recursive: true });

  console.log('══════════════════════════════════════════════════════════════');
  console.log(' 晨报 · 启动性能 / 首屏包体实测');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`口径              ${catalog.id}（${catalog.metric}，${catalog.unit}）`);
  console.log(`catalog sha256    ${catalogSha}${catalogSha !== CATALOG_SHA256 ? '  ⚠ 已放行变更' : ''}`);
  console.log(`dist              ${artifact.dist}`);
  console.log(`入口              ${artifact.assetPaths['entry-js']}`);
  console.log(`vendor            ${artifact.assetPaths['vendor-js']}`);
  console.log(`样式              ${artifact.assetPaths['entry-css']}`);
  if (consistency.totals.mismatch || consistency.totals.missing) {
    console.log('');
    console.log(`⚠ 产物与源码不一致，以下数字不代表当前分支（MISMATCH ${consistency.totals.mismatch} / MISSING ${consistency.totals.missing}）`);
  }
  if (drift.length) {
    console.log('');
    console.log('⚠ 口径漂移（醒目提示）：历史 chunk id 已不可用，主指标改按「角色」解析。');
    for (const d of drift) {
      console.log(`  ${d.alias}: 历史 id ${d.historicalChunkId} ${d.historicalPath ? `→ ${d.historicalPath}` : '在当前构建不存在'}；按角色 → ${d.rolePath || '(route 角色运行时补全)'}`);
    }
    console.log('  ⇒ 历史数字只能按角色规则横向比，不能按 chunk id 逐字节比。');
  }

  const runs = [];
  let chromeVersion = null;
  try {
    for (let i = 0; i < args.runs; i++) {
      console.log(`\n冷启动 ${i + 1}/${args.runs} …`);
      const run = await oneRun({ server, debugPort, runIndex: i });
      chromeVersion = run.chromeVersion;
      run.analysis = analyzeRun(run, artifact, memberMap);
      runs.push(run);
      console.log(
        `  主指标 ${kb(run.analysis.mainBytes)} KB ｜ 副指标 ${kb(run.analysis.subBytes)} KB ｜ FCP ${run.fcp == null ? '-' : run.fcp} ｜ DCL ${run.dcl == null ? '-' : run.dcl} ｜ load ${run.load == null ? '-' : run.load} ｜ 长任务 ${run.analysis.longtaskCount}/${run.analysis.longtaskMaxMs}ms`
      );
      await sleep(600);
    }
  } finally {
    await server.close();
  }
  if (runs.length !== args.runs) die(`只完成 ${runs.length}/${args.runs} 次冷启动`);

  const med = {
    mainBytes: median(runs.map((r) => r.analysis.mainBytes)),
    subBytes: median(runs.map((r) => r.analysis.subBytes)),
    requestCount: median(runs.map((r) => r.analysis.requestCount)),
    subRequestCount: median(runs.map((r) => r.analysis.subRequestCount)),
    fcp: median(runs.map((r) => r.fcp)),
    lcp: median(runs.map((r) => r.lcp)),
    dcl: median(runs.map((r) => r.dcl)),
    load: median(runs.map((r) => r.load)),
    longtaskCount: median(runs.map((r) => r.analysis.longtaskCount)),
    longtaskMaxMs: median(runs.map((r) => r.analysis.longtaskMaxMs)),
    tbtMs: median(runs.map((r) => r.analysis.tbtMs)),
    subCats: Object.fromEntries(Object.keys(runs[0].analysis.subCats).map((k) => [k, median(runs.map((r) => r.analysis.subCats[k]))])),
    dataItems: runs[0].analysis.dataItems,
    parts: (() => {
      const out = {};
      const aliases = Object.keys(runs[0].analysis.parts);
      for (const alias of aliases) {
        const first = runs[0].analysis.parts[alias];
        out[alias] = { ...first, encodedDataLength: median(runs.map((r) => r.analysis.parts[alias].encodedDataLength)) };
      }
      return out;
    })()
  };
  runs.medians = med;

  const headRepo = args.headRepo || args.repo;
  const repoHead = resolveHead(headRepo);
  const env = {
    repo: args.repo,
    dist: artifact.dist,
    stampHead: artifact.stamp.head,
    repoHead: repoHead.head,
    repoHeadNote: repoHead.note,
    builtAt: artifact.stamp.builtAt,
    dirty: artifact.stamp.dirty,
    treeDirtyCount: artifact.stamp.treeDirtyCount,
    node: process.version,
    chrome: chromeVersion || 'unknown',
    network: ENV_CONST.network,
    latencyMs: ENV_CONST.latencyMs,
    downKB: ENV_CONST.downloadThroughput / KB,
    upKB: ENV_CONST.uploadThroughput / KB,
    cpuThrottle: ENV_CONST.cpuThrottle,
    width: ENV_CONST.width,
    height: ENV_CONST.height,
    dsf: ENV_CONST.dsf,
    locale: ENV_CONST.locale,
    timezone: ENV_CONST.timezone
  };

  // 中位数那一次（用于明细表）
  const target = runs.reduce((best, r) => (Math.abs(r.analysis.mainBytes - med.mainBytes) < Math.abs(best.analysis.mainBytes - med.mainBytes) ? r : best), runs[0]);
  const memberPaths = Object.values(med.parts).map((p) => p.url);

  printEnv(env);
  printRuns(runs);
  printRequests(target, memberPaths);

  // 与上一版 JSON diff
  let diff = null;
  try {
    const prev = fs
      .readdirSync(args.out)
      .filter((f) => /^startup-perf-.*\.json$/.test(f))
      .map((f) => path.join(args.out, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (prev) {
      const p = JSON.parse(fs.readFileSync(prev, 'utf8'));
      const prevKB = p.median && p.median.mainKB;
      if (typeof prevKB === 'number') diff = { prevFile: prev, prevMainKB: prevKB, deltaKB: med.mainBytes / KB - prevKB };
    }
  } catch {}

  printSummary(state, med, diff);

  const json = {
    schema: 'startup-perf/1',
    metricId: catalog.id,
    unit: catalog.unit,
    metric: catalog.metric,
    knowledge: {
      mainMetric: '4 个 chunk（entry-js / vendor-js / route-js / entry-css）的 gzip 之和；只按角色解析，chunk id 不作判据',
      subMetric: '导航→首个用户交互的全部请求 gzip 之和（仅趋势）；按 代码/数据/图片/字体/其它 分类',
      meaning: '主指标衡量代码体积；副指标衡量用户真实等待，两者不可混为「首屏包体」',
      gzipSource: 'CDP Network.loadingFinished.encodedDataLength（含响应头）',
      decodedSource: '本地静态服务实际发送的解压字节数',
      evidence: { main: 'measured', sub: 'measured', fcp: 'measured', lcp: 'measured', dcl: 'measured', load: 'measured', longtask: 'measured', tbt: 'estimated(derived)' }
    },
    catalogResolution: 'role-only',
    catalogSha256: catalogSha,
    catalogAcknowledged: args.ackCatalogChange && catalogSha !== CATALOG_SHA256,
    catalogDrift: drift,
    env,
    consistency,
    runs: runs.map((r) => ({
      index: r.runIndex,
      fcp: r.fcp,
      lcp: r.lcp,
      dcl: r.dcl,
      load: r.load,
      interactionAt: r.interactionAt,
      interactionWallMs: r.interactionWallMs,
      domNodes: r.domNodes,
      longtasks: r.longtasks,
      mainKB: r.analysis.mainKB,
      subKB: r.analysis.subKB,
      mainBytes: r.analysis.mainBytes,
      subBytes: r.analysis.subBytes,
      subCats: r.analysis.subCats,
      dataItems: r.analysis.dataItems,
      requestCount: r.analysis.requestCount,
      subRequestCount: r.analysis.subRequestCount,
      tbtMs: r.analysis.tbtMs,
      longtaskCount: r.analysis.longtaskCount,
      longtaskMaxMs: r.analysis.longtaskMaxMs,
      parts: r.analysis.parts,
      requests: r.requests
    })),
    median: {
      ...med,
      mainKB: med.mainBytes / KB,
      subKB: med.subBytes / KB,
      evidence: {
        main: 'measured',
        sub: 'measured',
        fcp: 'measured',
        lcp: 'measured',
        dcl: 'measured',
        load: 'measured',
        longtask: 'measured',
        tbt: 'estimated'
      }
    },
    baseline: catalog.baseline,
    diff,
    gate: {
      thresholdKB: args.threshold == null ? catalog.gate.defaultThresholdKB : args.threshold,
      thresholdSource: args.threshold == null ? `catalog.gate.defaultThresholdKB=${catalog.gate.defaultThresholdKB}（基线 ${catalog.baseline.remeasuredMainKB} 向下取整）` : '--threshold 命令行覆盖',
      over: med.mainBytes / KB > (args.threshold == null ? catalog.gate.defaultThresholdKB : args.threshold)
    },
    generatedAt: new Date().toISOString()
  };

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const jsonPath = path.join(args.out, `startup-perf-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(args.out, 'latest.json'), JSON.stringify(json, null, 2));
  console.log(`\nJSON              ${jsonPath}`);

  if (args.gate) {
    const threshold = json.gate.thresholdKB;
    const over = med.mainBytes / KB - threshold;
    console.log('\n── 门禁 ──────────────────────────────────────────────────');
    if (over > 0) {
      console.log(`✗ 超标：主指标 ${kb(med.mainBytes)} KB > 阈值 ${threshold} KB，超出 ${over.toFixed(1)} KB（${((over / threshold) * 100).toFixed(1)}%）`);
      console.log(`  默认阈值来自 catalog.gate.defaultThresholdKB（基线 ${catalog.baseline.remeasuredMainKB} 向下取整）；收紧阈值请同时修改 catalog，不要用脚本自动放宽。`);
      console.log('  临时覆盖：npm run measure:startup:gate -- --threshold 345');
      process.exit(1);
    }
    console.log(`✓ 通过：主指标 ${kb(med.mainBytes)} KB ≤ 阈值 ${threshold} KB（余量 ${Math.abs(over).toFixed(1)} KB）`);
    process.exit(0);
  }
  console.log('\n（report 模式：不判达标；判据请用 npm run measure:startup:gate）');
})().catch((e) => {
  if (e instanceof Invalid) {
    console.error(`\n✗ 无法测量：${e.message}`);
    if (e.detail) console.error(e.detail);
    process.exit(2);
  }
  console.error('\n✗ 测量失败：', e && e.stack ? e.stack : e);
  process.exit(2);
});
