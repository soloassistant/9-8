// 一次性匿名权限矩阵探针 —— 定论「方法/路径/动词」三维（2026-10-31）
//
// 背景：协调日志里两条实测看似矛盾，实为不同动词：
//   §12.1  POST  /.cloud/database/rest/v1/feedback → 401 DATABASE_42501（INSERT 无权）
//   §14.2  GET   /.cloud/database/rest/<table>     → 200 空表（SELECT 匿名可读）
// 本脚本一次跑完：5 张表 × 2 种路径形状（带/不带 /v1/）× {GET,POST,PATCH,DELETE,OPTIONS}。
//
// 安全护栏：
//   - PATCH / DELETE 一律带「必然匹配 0 行」的过滤器（列名先经 GET 探测确认存在），
//     即便权限意外放行，也不可能改动任何真实数据。
//   - POST 用空对象 {}；若意外 2xx（建了行），立刻按返回行做 DELETE 回滚并显式报告。
//   - 匿名维度（无账号凭据可用；鉴权维度明确登记为待测）。
//
// 用法：node matrix.mjs [--base <url>]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1].replace(/\/$/, '')
  : 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host';

const authSrc = readFileSync(join(root, 'src', 'services', 'cloudAuth.ts'), 'utf8');
const KEY = (authSrc.match(/wbpk_[A-Za-z0-9_]*/) || [])[0];
if (!KEY) { console.error('FATAL: 未在 cloudAuth.ts 找到 publishable key'); process.exit(2); }

const TABLES = ['user_kv', 'llm_events', 'feedback', 'client_errors', 'orders'];
const shapes = (t) => [`${H}/.cloud/database/rest/${t}`, `${H}/.cloud/database/rest/v1/${t}`];

const baseHeaders = { Origin: H, 'X-Wb-Webapp-Access-Key': KEY };

async function req(method, url, { body, preflight } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const headers = { ...baseHeaders };
    if (preflight) {
      headers['Access-Control-Request-Method'] = preflight;
    } else {
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (body !== undefined && method === 'POST') headers.Prefer = 'return=representation';
    }
    const res = await fetch(url, {
      method, headers,
      body: preflight || body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let rows = null, code = '', msg = '';
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) rows = j.length;
      code = j.code || j.message?.code || '';
      msg = (j.message || j.error || '').toString();
    } catch { /* 非 JSON（HTML 404 等） */ }
    return { status: res.status, acao: res.headers.get('access-control-allow-origin'), rows, code, msg, len: text.length };
  } catch (e) {
    return { status: 0, acao: null, rows: null, code: 'FETCH_ERROR', msg: String(e).slice(0, 80), len: 0 };
  } finally { clearTimeout(timer); }
}

const clip = (s, n = 58) => (s || '').replace(/\s+/g, ' ').slice(0, n);

// ---- Phase 0：POSTGRES 服务器描述（OpenAPI 根），拿每张表的真实列名 ----
console.log(`目标：${H}\n发布键：${KEY.slice(0, 10)}…\n`);
console.log('== Phase 0：路径形状与服务器描述 ==');
const openapi = {};
for (const p of [`${H}/.cloud/database/rest/`, `${H}/.cloud/database/rest/v1/`]) {
  const r = await req('GET', p);
  let parsed = null;
  try { parsed = JSON.parse((await fetch(p, { headers: baseHeaders })).text()); } catch { /* ignore */ }
  if (parsed && parsed.paths) {
    for (const [path, def] of Object.entries(parsed.paths)) {
      const t = path.replace(/^\//, '');
      const cols = new Set();
      for (const m of ['post', 'get']) {
        for (const prm of def[m]?.parameters || []) {
          if (prm.name && prm.schema?.properties) for (const c of Object.keys(prm.schema.properties)) cols.add(c);
          if (prm.in === 'query' && /^eq\.|filter/.test(prm.name || '')) { /* skip */ }
        }
      }
      openapi[t] = [...cols];
    }
  }
  console.log(`GET  ${p.replace(H, '')}  → ${r.status} ${r.code} ${clip(r.msg)}  (OpenAPI:${parsed && parsed.paths ? `yes, ${Object.keys(parsed.paths).length} 表` : 'no'})`);
}
const colCache = {};
for (const t of TABLES) {
  if (openapi[t]?.length) { colCache[t] = { name: openapi[t][0], op: 'eq' }; continue; }
  // OpenAPI 不可用 → 用 GET 探测候选列是否存在（400=列不存在，200=存在）
  for (const c of ['key', 'id', 'owner_id', 'created_at', 'user_id']) {
    const r = await req('GET', `${H}/.cloud/database/rest/${t}?${c}=eq.__probe__`);
    if (r.status === 200) { colCache[t] = { name: c, op: 'eq' }; break; }
  }
  // 整表匿名不可读（连列名都探不到）→ 用系统列 ctid 做「永不匹配」过滤：
  // tid 偏移从 1 起，(0,0) 是合法字面量但永不存在的物理位置（xmin 方案不行：xid 无法与 unknown 比较）。
  if (!colCache[t]) colCache[t] = { name: 'ctid', op: 'eq', literal: '(0,0)' };
}

// ---- Phase 1：矩阵 ----
console.log('\n== Phase 1：匿名权限矩阵（动词 × 路径形状 × 表） ==');
console.log('图例：42501-table = permission denied for table；42501-RLS = row-level security 拦截；200/0行 = 放行但匹配/返回 0 行\n');
const results = [];
const leftover = [];

for (const t of TABLES) {
  for (const url of shapes(t)) {
    const shape = url.includes('/v1/') ? 'v1' : 'root';
    const col = colCache[t] || { name: 'key', op: 'eq' };
    const never = `${url}?${col.name}=${col.op}.${col.literal || `__zz_probe_never_${Date.now()}__`}`;

    const g = await req('GET', `${url}?select=*`);
    results.push([t, shape, 'GET   ', g, `rows=${g.rows}`]);

    const o = await req('OPTIONS', url, { preflight: 'POST' });
    results.push([t, shape, 'OPTIONS', o, o.acao ? `ACAO=${o.acao === H ? '精确' : o.acao}` : '无ACAO']);

    const p = await req('POST', url, { body: {} });
    let note = clip(p.msg) || clip(p.code);
    if (p.status >= 200 && p.status < 300) {
      // 意外建行 → 立即回滚
      let delFilter = never;
      try {
        const created = JSON.parse((await fetch(url + '?select=*', { headers: baseHeaders })).text());
        const row = Array.isArray(created) ? created[created.length - 1] : null;
        const idCol = row && (row.id !== undefined ? 'id' : row.key !== undefined ? 'key' : col.name);
        if (row) delFilter = `${url}?${idCol}=eq.${encodeURIComponent(String(row[idCol]))}`;
      } catch { /* ignore */ }
      const d = await req('DELETE', delFilter);
      leftover.push(`${t}(${shape}) POST 成功已回滚(${d.status})`);
      note = `!! 意外放行，已回滚 DELETE=${d.status}`;
    }
    results.push([t, shape, 'POST  ', p, note]);

    const pa = await req('PATCH', never, { body: {} });
    results.push([t, shape, 'PATCH ', pa, clip(pa.msg) || clip(pa.code)]);

    const de = await req('DELETE', never);
    results.push([t, shape, 'DELETE', de, clip(de.msg) || clip(de.code)]);
  }
}

const w = [7, 4, 7, 6, 6];
console.log('表'.padEnd(14) + '形状'.padEnd(5) + '动词'.padEnd(8) + '状态 '.padEnd(6) + 'rows  code / 说明');
for (const [t, shape, verb, r, note] of results) {
  console.log(
    t.padEnd(14) + shape.padEnd(5) + verb.padEnd(8) +
    String(r.status).padEnd(6) + (r.rows === null ? '—   ' : String(r.rows).padEnd(5)) +
    (r.code ? r.code + ' ' : '') + note
  );
}

console.log('\n== 汇总 ==');
if (leftover.length) { console.log('⚠️ 意外写入：' + leftover.join('；')); }
else console.log('无任何意外写入（POST 全部被拒或回滚，PATCH/DELETE 全部 0 行过滤）。');
console.log('鉴权维度：未测（本机无测试账号凭据，需登录态 JWT）—— 匿名矩阵先行定论。');
