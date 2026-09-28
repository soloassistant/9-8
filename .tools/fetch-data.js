// 独立真实数据抓取脚本：RSS 聚合热点 → 输出自包含 JSON（供 GitHub Actions 定时刷新 Pages 静态数据）
// 与 static-server.js 的 /api/hotspot 保持同源实现（来源注册表一致）；本机部署时也可用它预热 dist/api/hotspot.json
// 用法：node fetch-data.js --out <path>   （默认输出 stdout）
const fs = require('fs');
const path = require('path');
// 热榜板块的零依赖取数实现（自带 6 个板块：4 个垂类 + 2 个综合榜）
const { fetchAllBoards } = require('./boards-core.js');

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

/** 极简 RSS 解析（无依赖）。tag / pubDate 口径与 static-server.js 的 parseRss 完全一致：
 *  · tag 落到条目 tags —— 前端「资讯类目筛选」依赖它；本文件此前恒为 []，线上站点因此没有类目
 *  · pubDate 只供新鲜度闸门使用，**不进响应契约**（HotspotNews 无该字段） */
function parseRss(xml, source, limit, tag) {
  const out = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, limit)) {
    const title = clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = clean((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const desc = clean((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (!title) continue;
    const pubRaw = clean((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const pubMs = pubRaw ? Date.parse(pubRaw) : NaN;
    out.push({
      id: 'rss_' + hash(source + title),
      title,
      summary: (desc || title).slice(0, 80),
      source,
      url: link,
      tags: tag ? [tag] : [],
      pubDate: Number.isFinite(pubMs) ? pubMs : null
    });
  }
  return out;
}

// 资讯源清单：**唯一事实源 = cloudfunctions/webSearch/index.js 的 RSS_SOURCES**。
//
// 为什么不再在这里手抄一份（2026-09-28 修）：本文件是历史上**第三份**源清单。
// static-server.js 早在 2026-09-24 就因「两份清单各自维护必然发散」改为运行时解析云函数清单；
// 而本文件漏改，后果是 pages 线上站点长期跑的是退化版：
//   · 还带着**已实测冻结的「人民网」**（全部无 pubDate、内容停留 2022 年）
//   · 只有 6 个 RSS 源、没有类目 tag → 线上没有类目筛选，也没有后来新增的游戏/汽车/教育/开发者等类目
//   · 没有新鲜度闸门 → 冻结源的内容会照样展示
// 现改为与 static-server.js 同款：运行时解析云函数源清单；解析失败才回退下面的兜底清单，且**必须告警**。
const CLOUD_WEBSEARCH = path.join(__dirname, '..', 'cloudfunctions', 'webSearch', 'index.js');
const RSS_PER_SOURCE = 10;
/** 条目新鲜度闸门（天）：与云函数 STALE_SOURCE_DAYS、static-server STALE_ITEM_DAYS 对齐 */
const STALE_ITEM_DAYS = 7;

function loadRssSourcesFromCloud() {
  try {
    const code = fs.readFileSync(CLOUD_WEBSEARCH, 'utf8');
    const block = code.match(/const RSS_SOURCES = \[([\s\S]*?)\n\];/);
    if (!block) throw new Error('未找到 RSS_SOURCES 数组');
    const out = [];
    const re = /\{\s*name:\s*'([^']+)'\s*,\s*url:\s*'([^']+)'\s*,\s*tag:\s*'([^']+)'\s*\}/g;
    let m;
    while ((m = re.exec(block[1]))) out.push({ name: m[1], url: m[2], tag: m[3] });
    if (!out.length) throw new Error('解析到 0 个源');
    return { list: out, err: null };
  } catch (e) {
    return { list: null, err: e.message };
  }
}

const FALLBACK_RSS = [
  { name: '少数派', url: 'https://sspai.com/feed', tag: '数字生活' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', tag: '科技' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss', tag: '科技' },
  { name: '钛媒体', url: 'https://www.tmtpost.com/rss', tag: '商业' }
];

const SHARED_RSS = loadRssSourcesFromCloud();
const RSS_SOURCES = SHARED_RSS.list || FALLBACK_RSS;
if (SHARED_RSS.err) {
  console.warn('[fetch-data] 无法从云函数解析 RSS_SOURCES（' + SHARED_RSS.err + '）→ 已回退兜底清单，两份清单可能再次发散，请尽快修复');
}

// 热榜板块**不在此处**：它们经本机 DailyHotApi(127.0.0.1:6688) 取数，而本脚本跑在 GitHub Actions
// runner 上，够不到本机服务。故 pages 线上版只有 RSS 侧内容（16 源 / 12 类目），
// 完整版（含 9 个热榜板块）需在本机或带后端的部署里跑。这是已知差异，不要靠造假数据抹平。
const HOTSPOT_SOURCES = [
  ...RSS_SOURCES.map((s) => ({
    name: s.name,
    fetch: () => fetchText(s.url).then((x) => parseRss(x, s.name, RSS_PER_SOURCE, s.tag))
  })),
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

/** 聚合全部源 → { items, meta }；跨源轮询交错去重 + 新鲜度闸门 */
async function fetchHotspot() {
  const groups = [];
  const srcStatus = [];
  const now = Date.now();
  const staleMaxAge = STALE_ITEM_DAYS * 24 * 60 * 60 * 1000;
  const dropped = { undated: 0, stale: 0 };

  await Promise.all(
    HOTSPOT_SOURCES.map(async (s) => {
      let ok = false;
      try {
        const g = await s.fetch();
        // 新鲜度闸门：只作用于 RSS 源（只有 parseRss 的条目带 pubDate）。
        // 热榜/知乎日报不带时间戳 —— 不为它们伪造日期，也不因无日期而过滤掉。
        // 这道闸门正是「人民网」这类冻结源的分界线：它 100 条全部无 pubDate，会被整源丢弃。
        if (g.length) {
          const fresh = [];
          for (const it of g) {
            if (!('pubDate' in it)) { fresh.push(it); continue; }
            if (it.pubDate == null) { dropped.undated += 1; continue; }
            if (now - it.pubDate > staleMaxAge) { dropped.stale += 1; continue; }
            fresh.push(it);
          }
          if (fresh.length) { ok = true; groups.push(fresh); }
        }
      } catch {}
      srcStatus.push({ name: s.name, count: 0, ok });
    })
  );
  // 热榜板块：走仓库自带的零依赖实现（.tools/boards-core.js），**不依赖本机 DailyHotApi 服务** ——
  // 本脚本跑在 GitHub Actions runner 上，够不到 127.0.0.1:6688，这正是线上长期没有热榜的原因。
  // 覆盖 6 个板块（含全部 4 个垂类）；微博/知乎/抖音 需 cookie，服务器环境取不到，仍在注释里记明。
  const boards = { total: 0, ok: 0, items: 0, skipped: [] };
  try {
    const r = await fetchAllBoards({ limitPerBoard: RSS_PER_SOURCE });
    boards.total = r.statuses.length;
    boards.ok = r.statuses.filter((s) => s.ok).length;
    boards.items = r.items.length;
    for (const s of r.statuses) {
      srcStatus.push({ name: s.label, count: 0, ok: s.ok, reason: s.reason || '' });
      if (!s.ok) boards.skipped.push(s.label + '(' + (s.reason || 'unknown') + ')');
    }
    // 每个板块作为独立 group 入组 → 沿用跨源轮询交错，避免单一板块霸占前列（与 static-server 同口径）
    for (const label of new Set(r.items.map((it) => it.source))) {
      const g = r.items.filter((it) => it.source === label);
      if (g.length) groups.push(g);
    }
  } catch (e) {
    boards.error = String((e && e.message) || e);
    console.warn('[fetch-data] 热榜板块整体失败（不影响 RSS 部分）：' + boards.error);
  }

  for (const st of srcStatus) {
    st.count = st.ok ? groups.reduce((n, g) => n + g.filter((it) => it.source === st.name).length, 0) : 0;
  }

  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      const it = g[i];
      if (!it) continue;
      const k = it.title.slice(0, 24);
      if (!seen.has(k)) { seen.add(k); merged.push(it); }
    }
  }

  // 剥离内部字段：pubDate 只用于上面的新鲜度闸门，不进入响应契约（与 static-server.js 同口径）
  const items = merged.map(({ pubDate, ...rest }) => rest);
  return {
    items,
    meta: { updatedAt: new Date().toISOString(), stale: false, sources: srcStatus, dropped, boards }
  };
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
