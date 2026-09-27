// 全量自动体检：静态服务/API/构建一致性。用法：node check-all.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://localhost:8137';
let pass = 0, fail = 0;
const rows = [];
function report(name, ok, detail) {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(40000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // 1. 首页 + noindex
  try {
    const home = await req('GET', '/');
    report('首页 200', home.status === 200, 'status=' + home.status);
    report('noindex 防收录', /noindex/.test(home.body));
  } catch (e) { report('首页', false, e.message); }

  // 2. 热点 API：条目数/元数据/来源
  try {
    const h = JSON.parse((await req('GET', '/api/hotspot')).body);
    report('热点条目 > 20', (h.items || []).length > 20, 'items=' + (h.items || []).length);
    report('热点元数据 updatedAt', !!h.updatedAt, String(h.updatedAt || '').slice(0, 19));
    report('热点来源 >= 4 源在线', (h.sources || []).filter((s) => s.ok).length >= 4,
      (h.sources || []).map((s) => s.name + (s.ok ? ':ok' : ':fail')).join(' '));
    report('热点全部带 source 标注', (h.items || []).every((it) => it.source));
  } catch (e) { report('热点 API', false, e.message); }

  // 3. 天气 API：北京 + 城市切换
  try {
    const b1 = JSON.parse((await req('GET', '/api/briefing?city=' + encodeURIComponent('北京'))).body);
    report('天气 北京', !!(b1.weather && b1.weather.text), b1.weather ? b1.weather.text.slice(0, 30) : 'null');
    const b2 = JSON.parse((await req('GET', '/api/briefing?city=' + encodeURIComponent('上海'))).body);
    report('天气城市切换 上海', !!(b2.weather && b2.weather.text.includes('上海')), b2.weather ? b2.weather.text.slice(0, 30) : 'null');
  } catch (e) { report('天气 API', false, e.message); }

  // 4. AI 真实回复（DeepSeek，走限流额度 1 次）
  try {
    const c = JSON.parse((await req('POST', '/api/chat', { message: '用五个字回答你是谁' })).body);
    report('AI 真实回复', !!(c.reply && !c.error), (c.reply || c.error || '').slice(0, 40));
  } catch (e) { report('AI chat', false, e.message); }

  // 5. 构建一致性：dist 与 preview-snapshot 的 index.html 引用 hash 相同
  try {
    const d = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');
    const s = fs.readFileSync(path.join(__dirname, 'preview-snapshot', 'index.html'), 'utf8');
    const hx = (t) => (t.match(/[\w.-]+\.js/g) || []).sort().join(',');
    report('dist=快照 构建一致', hx(d) === hx(s) && hx(d).length > 0);
  } catch (e) { report('构建一致性', false, e.message); }

  console.log(rows.join('\n'));
  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail > 0 ? 1 : 0);
})();
