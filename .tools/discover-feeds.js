// RSS 源自动发现 —— 尽调前置步骤。
//
// 为什么需要它：靠猜 feed 路径（/feed、/rss.xml…）命中率极低，实测会浪费大量轮次在
// 「这个站到底有没有 feed」上。标准做法是从站点首页的 autodiscovery 标签取真实 feed 地址：
//   <link rel="alternate" type="application/rss+xml" href="/feed">
// 拿不到时再退到常见路径探测。
//
// 输出格式与 .tools/vet-feeds.js 的输入**完全兼容**，可直接管道衔接：
//   node .tools/discover-feeds.js sites.json feeds.json
//   node .tools/vet-feeds.js feeds.json vet.json
//
// 输入：[{"name":"某文化媒体","site":"https://example.com","category":"文化"}]
// 输出：[{"name":"某文化媒体","url":"https://example.com/feed","category":"文化","foundBy":"autodiscovery"}]
//
// 本工具**只读**，不修改任何生产文件。发现的 feed 是否真的可用，仍由 vet-feeds.js 判定。

const fs = require('fs');

const TIMEOUT = 8000;
const UA = { 'User-Agent': 'Mozilla/5.0' };

// 常见路径兜底（仅当 autodiscovery 失败时才逐个试）
const COMMON = ['/feed', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/feed.xml', '/feeds/all.atom.xml', '/rss/'];

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/** 从 HTML 里抽 autodiscovery feed 链接（容忍属性顺序颠倒、单双引号、相对路径） */
function discoverIn(html, baseUrl) {
  const out = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    try { out.push(new URL(href, baseUrl).toString()); } catch {}
  }
  return out;
}

async function looksLikeFeed(url) {
  try {
    const body = await fetchText(url);
    return /<item[\s>]/.test(body) || /<entry[\s>]/.test(body) || /<rss[\s>]/.test(body) || /<feed[\s>]/.test(body);
  } catch {
    return false;
  }
}

async function resolveOne(entry) {
  const site = entry.site;
  const rec = { name: entry.name, url: '', category: entry.category || '', foundBy: '', note: '' };
  try {
    const html = await fetchText(site);
    const found = discoverIn(html, site);
    if (found.length) {
      rec.url = found[0];
      rec.foundBy = 'autodiscovery' + (found.length > 1 ? '(+' + (found.length - 1) + ')' : '');
      if (found.length > 1) rec.note = '同页另有: ' + found.slice(1, 3).join(' , ');
      return rec;
    }
    // autodiscovery 无果 → 试常见路径
    for (const p of COMMON) {
      const cand = new URL(p, site).toString();
      if (await looksLikeFeed(cand)) {
        rec.url = cand;
        rec.foundBy = 'common-path';
        return rec;
      }
    }
    rec.foundBy = 'none';
    rec.note = '首页可达但未发现任何 feed（autodiscovery + 常见路径均无）';
  } catch (e) {
    rec.foundBy = 'site-unreachable';
    rec.note = String((e && e.message) || e);
  }
  return rec;
}

(async () => {
  const inFile = process.argv[2];
  const outFile = process.argv[3];
  if (!inFile) {
    console.error('用法: node .tools/discover-feeds.js <sites.json> [feeds.json]');
    process.exit(1);
  }
  const sites = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  console.log('[discover] 待发现站点 ' + sites.length + ' 个');

  const results = await Promise.all(sites.map(resolveOne));

  console.log('\n' + '='.repeat(104));
  console.log('站点'.padEnd(22) + '类目'.padEnd(12) + '方式'.padEnd(18) + '源地址');
  console.log('='.repeat(104));
  for (const r of results) {
    console.log(
      (r.name || '').slice(0, 21).padEnd(22)
      + (r.category || '').slice(0, 11).padEnd(12)
      + (r.foundBy || '').slice(0, 17).padEnd(18)
      + (r.url || ('(' + r.note + ')')).slice(0, 50)
    );
  }
  const ok = results.filter((r) => r.url);
  console.log('='.repeat(104));
  console.log('发现 feed: ' + ok.length + '/' + results.length
    + '（autodiscovery ' + results.filter((r) => r.foundBy.startsWith('autodiscovery')).length
    + ' / common-path ' + results.filter((r) => r.foundBy === 'common-path').length + '）');
  console.log('注意：发现 ≠ 可用。下一步必须用 vet-feeds.js 过四层判据（尤其新鲜度）。');

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(ok.map((r) => ({
      name: r.name, url: r.url, category: r.category, foundBy: r.foundBy
    })), null, 2));
    console.log('[discover] 已写出 ' + outFile + '（' + ok.length + ' 条，可直接喂给 vet-feeds.js）');
  }
})();
