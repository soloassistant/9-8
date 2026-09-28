// 候选资讯源尽调工具 —— 用**与生产完全相同的抓取与解析代码**实测候选源是否真的可用且新鲜。
//
// 为什么不是手抄一份 fetchText/parseRss：手抄必然发散（本项目 2026-09-24 已因「两份各自维护的
// 清单」踩过一次坑）。本工具改为**从 .tools/static-server.js 按函数名抽取源码文本并 eval**，
// 因此它与生产的抓取方式、编码处理、pubDate 口径、条目上限**逐字符一致**。
//
// 判据分四层递进（跳级会得出错误结论）：
//   第1层 可达性   HTTP 状态码 / 是否 feed
//   第2层 可解析   能抽出多少条 <item>；标题非空
//   第3层 编码     XML 声明 encoding；标题乱码分（U+FFFD 计数）
//   第4层 新鲜度   ★ 决定性：最新一条距今多久（ageDays）
// 并且**直接模拟生产闸门**：parseRss 取前 RSS_PER_SOURCE 条 → 逐条过「无 pubDate 丢弃 /
// 超 STALE_ITEM_DAYS 丢弃」→ 存活条数。存活 0 = 该源在生产里等于不存在（连续 2 次还会被
// 健康度冷却 30 分钟）。
//
// 用法：
//   node .tools/vet-feeds.js                          # 自检：测当前生产源清单（应全部 ADOPT）
//   node .tools/vet-feeds.js candidates.json          # 测候选清单 [{name,url,category}]
//   node .tools/vet-feeds.js candidates.json out.json # 结果同时落盘
//
// 候选 JSON 格式：[{"name":"少数派","url":"https://sspai.com/feed","category":"数字生活"}]
// 注意：本工具**只读**，不修改任何生产文件。

const fs = require('fs');
const path = require('path');

const SERVER_JS = path.join(__dirname, 'static-server.js');
const src = fs.readFileSync(SERVER_JS, 'utf8');

// ---------- 从生产文件抽取代码（按函数名做括号配平，抗行号漂移） ----------
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('生产文件中未找到函数 ' + name);
  let depth = 0;
  let seen = false;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; seen = true; } else if (c === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('括号未配平: ' + name);
}
function extractConst(name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('生产文件中未找到常量 ' + name);
  return m[1];
}

// eval 出的正是生产代码本体。ESLint 会报 no-eval —— 这里是有意为之：
// 唯一目的是消除「尽调用代码」与「生产代码」之间的发散，eval 是达成该目的最直接的手段。
const PROD_SRC = [
  'const FETCH_TIMEOUT = ' + extractConst('FETCH_TIMEOUT') + ';',
  'const STALE_ITEM_DAYS = ' + extractConst('STALE_ITEM_DAYS') + ';',
  'const RSS_PER_SOURCE = ' + extractConst('RSS_PER_SOURCE') + ';',
  extractFn('hash'),
  extractFn('clean'),
  extractFn('parseRss'),
  extractFn('fetchText'),
  'return { fetchText, parseRss, clean, hash, FETCH_TIMEOUT, STALE_ITEM_DAYS, RSS_PER_SOURCE };'
].join('\n');
const P = new Function(PROD_SRC)(); // eslint-disable-line no-new-func

console.log('[vet] 已从生产文件抽取：fetchText / parseRss / clean / hash；'
  + 'TIMEOUT=' + P.FETCH_TIMEOUT + 'ms  STALE_ITEM_DAYS=' + P.STALE_ITEM_DAYS + 'd  PER_SOURCE=' + P.RSS_PER_SOURCE);

// ---------- 四层实测 ----------
const FFFD = /[\uFFFD]/g;

async function vetOne(cand) {
  const t0 = Date.now();
  const r = {
    name: cand.name, url: cand.url, category: cand.category || '',
    layer1: 'pending', http: null, kind: '',
    layer2: null, layer3: { decl: '', fffd: 0, badSamples: [] },
    layer4: { ageDays: null, newest: null, oldest: null, dated: 0, survived: 0 },
    // 第 5 层：云函数 cloudfunctions/webSearch/index.js 是**另一份独立解析实现**，约束不同。
    // 一个源可能过了预览侧却死在云函数侧，所以必须单独量。
    cloud: { isHttps: null, utf8Valid: null, note: '' },
    verdict: '', reason: '', ms: 0, samples: []
  };

  let raw = '';
  try {
    raw = await P.fetchText(cand.url);
    r.http = 200;
    r.layer1 = 'ok';
  } catch (e) {
    r.layer1 = 'fail';
    const msg = String(e && e.message || e);
    r.http = (msg.match(/^HTTP (\d+)$/) || [])[1] || null;
    r.verdict = msg.includes('timeout') ? 'TIMEOUT' : (r.http ? 'HTTP-ERR' : 'NET-ERR');
    r.reason = msg;
    r.ms = Date.now() - t0;
    return r;
  }

  const hasItem = /<item[\s>]/.test(raw);
  const hasEntry = /<entry[\s>]/.test(raw);
  r.kind = hasItem ? 'rss' : hasEntry ? 'atom' : 'unknown';
  if (!hasItem && hasEntry) {
    // 生产 parseRss 只认 <item> → Atom 源在生产里恒为 0 条
    r.verdict = 'ATOM-ONLY';
    r.reason = '只有 <entry>，生产 parseRss 只认 <item>，恒为 0 条';
    r.ms = Date.now() - t0;
    return r;
  }
  if (!hasItem) {
    r.verdict = 'NON-RSS';
    r.reason = '200 但正文不是 RSS（无 <item>）';
    r.ms = Date.now() - t0;
    return r;
  }

  // 第 2 层：用生产同款 parseInts
  const items = P.parseRss(raw, cand.name, P.RSS_PER_SOURCE);
  r.layer2 = items.length;

  // 第 3 层：编码
  const decl = (raw.match(/<\?xml[^>]*encoding="([^"]+)"/i) || [])[1] || '';
  r.layer3.decl = decl || '(未声明)';
  const titles = items.map((it) => it.title);
  r.layer3.fffd = titles.join('').match(FFFD)?.length || 0;
  r.layer3.badSamples = titles.filter((t) => FFFD.test(t)).slice(0, 2);
  r.samples = titles.slice(0, 3);

  // 第 5 层：云函数兼容性 —— 必须按**原始字节**判定，不能复用上面已被 fetch 解码过的文本。
  // 云函数用 res.setEncoding('utf8') 硬解码，所以只有「字节本身是合法 UTF-8」才安全。
  r.cloud.isHttps = /^https:\/\//i.test(cand.url);
  if (!r.cloud.isHttps) r.cloud.note = 'http:// 源：云函数用 https.get，直接 ERR_INVALID_PROTOCOL';
  try {
    const resp = await fetch(cand.url, { headers: { 'User-Agent': 'Mozilla/5.0 MorningBriefing/1.0' } });
    const buf = Buffer.from(await resp.arrayBuffer());
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      r.cloud.utf8Valid = true;
    } catch {
      r.cloud.utf8Valid = false;
      r.cloud.note = (r.cloud.note ? r.cloud.note + '；' : '') + '字节非法 UTF-8：云函数硬编码 utf8 解码会整源乱码';
    }
  } catch (e) {
    r.cloud.utf8Valid = null;
    r.cloud.note = (r.cloud.note ? r.cloud.note + '；' : '') + '字节探测失败: ' + String((e && e.message) || e);
  }

  // 第 4 层：新鲜度 + 生产闸门模拟
  const now = Date.now();
  const maxAge = P.STALE_ITEM_DAYS * 24 * 60 * 60 * 1000;
  const dated = items.filter((it) => Number.isFinite(it.pubDate));
  r.layer4.dated = dated.length;
  if (dated.length) {
    const ts = dated.map((it) => it.pubDate).sort((a, b) => b - a);
    r.layer4.newest = new Date(ts[0]).toISOString().slice(0, 10);
    r.layer4.oldest = new Date(ts[ts.length - 1]).toISOString().slice(0, 10);
    r.layer4.ageDays = +((now - ts[0]) / 86400000).toFixed(2);
  }
  // 生产闸门：无 pubDate 丢弃、超期丢弃 → 存活数
  r.layer4.survived = items.filter((it) => Number.isFinite(it.pubDate) && now - it.pubDate <= maxAge).length;

  // 判定
  if (items.length === 0) { r.verdict = 'EMPTY-TITLE'; r.reason = '有 <item> 但抽不出非空标题'; }
  else if (r.layer4.dated === 0) { r.verdict = 'UNDATED'; r.reason = '前 ' + items.length + ' 条全部无 pubDate → 生产闸门整源丢弃'; }
  else if (r.layer4.survived === 0) { r.verdict = 'STALE'; r.reason = '有日期但全部早于 ' + P.STALE_ITEM_DAYS + ' 天（最新 ' + r.layer4.ageDays + ' 天前）'; }
  else if (r.layer4.ageDays > P.STALE_ITEM_DAYS) { r.verdict = 'STALE'; r.reason = '最新一条 ' + r.layer4.ageDays + ' 天前，超期'; }
  else if (r.cloud.isHttps === false || r.cloud.utf8Valid === false) { r.verdict = 'CLOUD-INCOMPAT'; r.reason = r.cloud.note; }
  else if (r.layer3.fffd > 0) { r.verdict = 'ENCODING'; r.reason = '标题含 ' + r.layer3.fffd + ' 个替换字符（乱码）'; }
  else { r.verdict = 'ADOPT'; r.reason = '存活 ' + r.layer4.survived + '/' + items.length + ' 条，最新 ' + r.layer4.ageDays + ' 天前'; }
  r.ms = Date.now() - t0;
  return r;
}

// ---------- 入口 ----------
function currentProdSources() {
  // 同样从生产文件解析源清单（与 static-server.js 的 loadRssSourcesFromCloud 同款正则）
  const cloud = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'webSearch', 'index.js'), 'utf8');
  const block = cloud.match(/const RSS_SOURCES = \[([\s\S]*?)\n\];/);
  const re = /\{\s*name:\s*'([^']+)'\s*,\s*url:\s*'([^']+)'\s*,\s*tag:\s*'([^']+)'\s*\}/g;
  const out = [];
  let m;
  while (block && (m = re.exec(block[1]))) out.push({ name: m[1], url: m[2], category: m[3] });
  return out;
}

(async () => {
  const argFile = process.argv[2];
  const outFile = process.argv[3];
  let list;
  if (argFile) {
    list = JSON.parse(fs.readFileSync(argFile, 'utf8'));
  } else {
    list = currentProdSources();
    console.log('[vet] 未给候选文件 → 自检模式：实测当前生产源清单（共 ' + list.length + ' 个），预期全部 ADOPT');
  }

  const round1 = await Promise.all(list.map(vetOne));
  const round2 = await Promise.all(list.map(vetOne)); // 第二轮：识别偶发抖动（每轮丢的源是否不同）

  const byName2 = new Map(round2.map((r) => [r.name, r]));
  console.log('\n' + '='.repeat(112));
  console.log(
    '源名'.padEnd(16) + '类目'.padEnd(12) + '判定'.padEnd(12)
    + '条数'.padEnd(6) + '存活'.padEnd(6) + '最新(天)'.padEnd(10) + '编码'.padEnd(10) + '云函数'.padEnd(12) + '轮2'.padEnd(12) + '耗时ms'
  );
  console.log('='.repeat(112));
  for (const r of round1) {
    const r2 = byName2.get(r.name);
    const cloudCol = r.cloud.isHttps === false ? 'http-✗'
      : r.cloud.utf8Valid === false ? '非UTF8-✗'
        : r.cloud.utf8Valid === true ? 'https+UTF8-✓' : '字节探测失败';
    console.log(
      r.name.slice(0, 15).padEnd(16)
      + r.category.slice(0, 11).padEnd(12)
      + r.verdict.padEnd(12)
      + String(r.layer2 ?? '-').padEnd(6)
      + String(r.layer4.survived ?? '-').padEnd(6)
      + String(r.layer4.ageDays ?? '-').padEnd(10)
      + (r.layer3.decl || '-').slice(0, 9).padEnd(10)
      + cloudCol.padEnd(12)
      + (r2 ? r2.verdict : '-').padEnd(12)
      + String(r.ms)
    );
  }

  const adopt = round1.filter((r) => r.verdict === 'ADOPT' && (byName2.get(r.name) || {}).verdict === 'ADOPT');
  const flaky = round1.filter((r) => r.verdict !== (byName2.get(r.name) || {}).verdict);
  console.log('='.repeat(112));
  console.log('两轮均 ADOPT: ' + adopt.length + '/' + round1.length);
  if (flaky.length) {
    console.log('!! 两轮判定不一致（偶发抖动，需人工判读）:');
    for (const f of flaky) console.log('   ' + f.name + ' : 轮1=' + f.verdict + ' 轮2=' + (byName2.get(f.name) || {}).verdict);
  }

  const rejects = round1.filter((r) => r.verdict !== 'ADOPT');
  if (rejects.length) {
    console.log('\n--- 未通过明细（含淘汰原因，可直接写进源清单维护注释防止回填）---');
    for (const r of rejects) console.log('  [' + r.verdict + '] ' + r.name + ' <' + r.url + '> — ' + r.reason);
  }

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), round1, round2 }, null, 2));
    console.log('\n[vet] 结果已写入 ' + outFile);
  }
})();
