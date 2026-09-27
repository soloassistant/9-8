// 独立真实数据抓取脚本：RSS 聚合热点 → 输出自包含 JSON（供 GitHub Actions 定时刷新 Pages 静态数据）
// 与 static-server.js 的 /api/hotspot 保持同源实现（来源注册表一致）；本机部署时也可用它预热 dist/api/hotspot.json
// 用法：node fetch-data.js --out <path>   （默认输出 stdout）
const fs = require('fs');
const path = require('path');

const FETCH_TIMEOUT = 8000;

function fetchText(url) {
  return Promise.race([
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT))
  ]);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 剥 CDATA 与 HTML 标签，压平空白（先解码实体再剥标签） */
function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 极简 RSS 解析（无依赖） */
function parseRss(xml, source, limit) {
  const out = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, limit)) {
    const title = clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = clean((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const desc = clean((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (!title) continue;
    out.push({
      id: 'rss_' + hash(source + title),
      title,
      summary: (desc || title).slice(0, 80),
      source,
      url: link,
      tags: []
    });
  }
  return out;
}

// 资讯源注册表：与 static-server.js HOTSPOT_SOURCES 保持一致（2026-09-11 实测可用源）
const HOTSPOT_SOURCES = [
  { name: 'IT之家', fetch: () => fetchText('https://www.ithome.com/rss/').then((x) => parseRss(x, 'IT之家', 12)) },
  { name: '少数派', fetch: () => fetchText('https://sspai.com/feed').then((x) => parseRss(x, '少数派', 10)) },
  { name: '人民网', fetch: () => fetchText('https://www.people.com.cn/rss/politics.xml').then((x) => parseRss(x, '人民网', 10)) },
  { name: '爱范儿', fetch: () => fetchText('https://www.ifanr.com/feed').then((x) => parseRss(x, '爱范儿', 8)) },
  { name: '极客公园', fetch: () => fetchText('https://www.geekpark.net/rss').then((x) => parseRss(x, '极客公园', 8)) },
  { name: '钛媒体', fetch: () => fetchText('https://www.tmtpost.com/feed/').then((x) => parseRss(x, '钛媒体', 8)) },
  {
    name: '知乎日报',
    fetch: () =>
      fetchText('https://news-at.zhihu.com/api/4/news/latest')
        .then((x) => JSON.parse(x))
        .then((d) =>
          (d.stories || []).slice(0, 12).map((s) => ({
            id: 'zhihu_' + hash(String(s.title)),
            title: s.title,
            summary: s.hint || '知乎日报',
            source: '知乎日报',
            url: String(s.url || '').replace(/\\\//g, '/'),
            tags: []
          }))
        )
  }
];

/** 聚合全部源 → { items, meta }；跨源轮询交错去重 */
async function fetchHotspot() {
  const groups = [];
  const srcStatus = [];
  await Promise.all(
    HOTSPOT_SOURCES.map(async (s) => {
      let ok = false;
      try {
        const g = await s.fetch();
        if (g.length) { ok = true; groups.push(g); }
      } catch {}
      srcStatus.push({ name: s.name, count: ok ? 0 : 0, ok });
    })
  );
  for (const st of srcStatus) {
    st.count = st.ok ? groups.reduce((n, g) => n + g.filter((it) => it.source === st.name).length, 0) : 0;
  }

  const seen = new Set();
  const items = [];
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      const it = g[i];
      if (!it) continue;
      const k = it.title.slice(0, 24);
      if (!seen.has(k)) { seen.add(k); items.push(it); }
    }
  }

  return { items, meta: { updatedAt: new Date().toISOString(), stale: false, sources: srcStatus } };
}

async function main() {
  const argIdx = process.argv.indexOf('--out');
  const outPath = argIdx > -1 ? process.argv[argIdx + 1] : null;

  const { items, meta } = await fetchHotspot();
  if (!items.length) {
    console.error('[fetch-data] all sources failed - keep existing output untouched');
    process.exit(1); // Actions 侧失败退出：不覆盖上一次的好数据
  }
  const json = JSON.stringify({ items, ...meta });
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, json);
    console.log(`[fetch-data] ${items.length} items -> ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((e) => {
  console.error('[fetch-data] fatal:', e && e.message);
  process.exit(1);
});
