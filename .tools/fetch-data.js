// 独立真实数据抓取脚本：RSS 聚合热点 → 输出自包含 JSON（供 GitHub Actions 定时刷新 Pages 静态数据）
// 与 static-server.js 的 /api/hotspot 保持同源实现（来源注册表一致）；本机部署时也可用它预热 dist/api/hotspot.json
// 用法：node fetch-data.js --out <path>   （默认输出 stdout）
const fs = require('fs');
const path = require('path');
// 热榜板块的零依赖取数实现（自带 6 个板块：4 个垂类 + 2 个综合榜）
const { fetchAllBoards } = require('./boards-core.js');
// 与云函数共用同一份信任过滤规则（小程序端 / 线上 H5 站点两条链路不能各判各的）
const { filterNewsItems } = require('../cloudfunctions/webSearch/news-trust.js');
// 截断口径与云函数**同一份**（句边界优先）—— 2026-10-29 审计：
//   本文件此前只按码点硬切，实测线上 414 条里 274 条（66.2%）摘要恰好 80 字、半句话暴露给用户；
//   云函数那边 2026-10-22 就修好了，本链路一直没跟上（同一件事两份口径的第三次发作）。
const { clampText } = require('../cloudfunctions/webSearch/text-clamp.js');
// 机构归一口径：alsoFrom 只记机构 —— 中新网三个子 feed 互抄不是三家媒体佐证
// （2026-10-22 校准：预配额 181 条同题 5 组，跨机构 0 组，全是中新网自抄）
const { orgOfSource, ALSO_FROM_MAX } = require('../cloudfunctions/webSearch/cross-source.js');

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
    // &apos; 是 XML 命名实体（NPR 等源在用），十进制/命名两轨都要盖住
    .replace(/&apos;/g, "'")
    // 高频英文排版命名实体（Scientific American 等源用 &rsquo;/&ldquo;…）——
    // RSS 世界命名实体上百个，穷举不现实，按实测分布收高频的
    .replace(/&(rsquo|lsquo|rdquo|ldquo|hellip|mdash|ndash|deg|trade|times|middot|bull|eacute|egrave|agrave|ccedil|uuml|ouml|auml|szlig|reg|copy|laquo|raquo|dArr|rArr|ne|le|ge);/g,
      (m, e) => ({ rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–', deg: '°', trade: '™', times: '×', middot: '·', bull: '•', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', reg: '®', copy: '©', laquo: '«', raquo: '»', dArr: '↓', rArr: '→', ne: '≠', le: '≤', ge: '≥' }[e] || m))
    // 数字实体通用解码（2026-10-25 审计 #2）：与云函数 stripHtml 同修 —— 线上 hotspot.json
    // 实测 212 处 &#8217;/&#8230;/零填充 &#039; 漏进摘要（命名实体只盖住极少数）
    .replace(/&#(\d{1,7});/g, (m, d) => {
      const cp = Number(d);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/<[^>]+>/g, '')
    // 剥完标签仍可能残留**落单的尖括号**：部分源（如 InfoQ）的 description 里
    // 写着「…查看原文&lt;/a&gt;」这类不闭合标签，`<[^>]+>` 匹配不到它们，
    // 于是结尾留下一个孤零零的「>」。2026-10-12 实测 198 条里有 10 条（5.1%）这样。
    // 正文里出现裸尖括号没有任何合法用途，直接清掉。
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 「套话描述」判定：feed 的 description 只有一句引导语、没有任何信息量。
 *
 *  2026-10-29 审计实测：437 条里 10 条（全部 InfoQ中文）的 description 就是
 *  「点击查看原文」—— 它会被当摘要展示在卡片正文行，读起来像渲染残留。
 *  判定用**归一化后的整串等值**（去空白/标点后在小集合里精确匹配），不做子串匹配：
 *  「如何查看原文里的代码」这种正常标题绝不能被误杀。
 *  命中 → 按「无 description」处理：摘要回退标题（与热榜条目同行为），content 不字段化。 */
const BOILERPLATE_DESC = new Set([
  '点击查看原文', '查看原文', '阅读原文', '阅读全文', '点击阅读原文', '阅读更多', '查看更多',
  '点击查看详情', '查看详情', '阅读详情', '全文如下', 'readmore', 'seemore', 'vieworiginal',
  'continuereading', 'more', '详情', '原文'
]);
function isBoilerplateDesc(s) {
  const n = String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return n !== '' && BOILERPLATE_DESC.has(n);
}

/** 剥 URL 查询串里的追踪参数。
 *
 *  2026-10-29 任务3 审计实测：437 条里 20 条带 utm_*（爱范儿 / InfoQ 的 RSS feed 自带），
 *  还见过 fr=/from=/spm= 这类站点统计参数。危害有三：链接更长、同一篇文章变成两个 URL、
 *  用户每次点开都在向第三方回传「从 RSS 来」的归因信息。
 *
 *  只剥查询参数、不动路径与 hash；白名单外的一律保留 —— 宁可少剥，不可误伤
 *  （百度热点的 ?wd=、Solidot 的 ?sid= 都是内容本体，必须活着）。
 *  只用于 fetch-data 链路；小程序 webSearch 云函数那条链路的 URL 不在此改（口径变更要单独过）。 */
function cleanUrl(u) {
  const s = String(u || '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const base = s.slice(0, q);
  if (!base) return s; // 只有查询串的怪链接，原样保留
  const kept = s.slice(q + 1).split('&').filter((kv) => {
    const k = kv.split('=')[0].toLowerCase();
    return k !== '' && !k.startsWith('utm_') &&
      !['spm', 'fr', 'from', 'ref', 'scene', 'share_from', 'share_token', 'nsukey'].includes(k);
  });
  return kept.length ? base + '?' + kept.join('&') : base;
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
    const descRaw = clean((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    // 套话描述（「点击查看原文」这类）按无描述处理，别让它混进摘要/content
    const desc = isBoilerplateDesc(descRaw) ? '' : descRaw;
    if (!title) continue;
    const pubRaw = clean((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const pubMs = pubRaw ? Date.parse(pubRaw) : NaN;
    out.push({
      id: 'rss_' + hash(source + title),
      title,
      summary: clampText(desc || title, 80),
      // 站内文章视图用：源自己在 feed 里发布的描述（上限 1000 码点），不是抓取的正文页；
      // 与 webSearch 云函数的 content 字段同语义（2026-10-25）。无 description 不字段化。
      content: desc ? clampText(desc, 1000) : undefined,
      source,
      url: cleanUrl(link),
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
/** 未来时间护栏（毫秒）：源站时钟超前或「定时发布」会让 pubDate 落到未来，
 *  落进 createTime 后用户看到的时间是错的（实测线上 1 条：InfoQ 的时间戳比现在晚 1.5 小时）。
 *  处置：**按 now 计**，不丢条目 —— 丢条目是更重的代价，而「不晚于现在」是保守且诚实的说法。 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** 连接级瞬时失败的重试次数与退避 —— 与 static-server.js 的 CONN_RETRY_TIMES / CONN_BACKOFF_MS 同口径。
 *  为什么线上抓取也需要它（2026-09-29 复检实测）：整夜 20 次刷新的历史里，
 *  芥末堆 / 掘金 / 经济观察报 / 车东西 / 小众软件 / 机核 / InfoQ中文 都出现过间歇失败，
 *  条目数因此在 **143~220** 之间波动（±35%）。一次瞬时抖动就让整批内容消失，
 *  与「源连续失败即被整源丢弃」叠加后放大成用户可见的内容缺失。 */
const CONN_RETRY_TIMES = 2;
const CONN_BACKOFF_MS = 300;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const dropped = { undated: 0, stale: 0, futureSkew: 0 };

  await Promise.all(
    HOTSPOT_SOURCES.map(async (s) => {
      let ok = false;
      let reason = '';
      for (let attempt = 1; attempt <= CONN_RETRY_TIMES; attempt++) {
        try {
          const g = await s.fetch();
          if (!g.length) { reason = 'empty'; break; }
          // 新鲜度闸门：只作用于 RSS 源（只有 parseRss 的条目带 pubDate）。
          // 热榜/知乎日报不带时间戳 —— 不为它们伪造日期，也不因无日期而过滤掉。
          // 这道闸门正是「人民网」这类冻结源的分界线：它 100 条全部无 pubDate，会被整源丢弃。
          const fresh = [];
          for (const it of g) {
            if (!('pubDate' in it)) { fresh.push(it); continue; }
            if (it.pubDate == null) { dropped.undated += 1; continue; }
            if (now - it.pubDate > staleMaxAge) { dropped.stale += 1; continue; }
            // 未来时间护栏：落在未来的时间戳按 now 计（不丢条目）
            if (it.pubDate > now + FUTURE_SKEW_MS) { it.pubDate = now; dropped.futureSkew += 1; }
            fresh.push(it);
          }
          // 整源条目都被闸门丢掉 → 视同不健康（与云函数「整源排除」口径一致）；内容陈旧不是瞬时故障，不重试
          if (!fresh.length) { reason = 'stale'; break; }
          ok = true;
          groups.push(fresh);
          break;
        } catch (e) {
          const msg = String((e && e.message) || e);
          reason = /timeout/i.test(msg) ? 'timeout' : (/^HTTP \d+$/.test(msg) ? 'http-' + msg.slice(5) : 'network');
          // 仅连接级瞬时失败重试一次（与 static-server.js 同口径）：timeout / HTTP 错误重试无意义
          if (reason === 'network' && attempt < CONN_RETRY_TIMES) { await sleepMs(CONN_BACKOFF_MS * attempt); continue; }
          break;
        }
      }
      // 不再静默：失败原因必须能被外部看到。
      // 修因（2026-09-29 复检）：本文件此前是 `catch {}` + 只记 ok，导致整夜 20 次刷新里
      // 「知乎日报 20/20 失败、芥末堆/掘金/经济观察报等间歇失败」全部呈现为 reason=undefined，
      // 无法归因 —— 同一缺陷早已在 static-server.js 修过，这里漏改。
      if (!ok) console.warn('[fetch-data] 源失败 ' + s.name + '：' + (reason || 'unknown'));
      srcStatus.push({ name: s.name, count: 0, ok, reason: reason || '' });
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

  // 同题只留主条目（标题前 24 字符相等判同题，既有口径）；其余来源按**机构**并入
  // alsoFrom（2026-10-22，与云函数 mergeCrossSource / static-server 同口径）——
  // 中新网子 feed 互抄按 feed 名计数会把一家通讯社显示成多家媒体佐证。
  const seen = new Map(); // 标题前缀 → 主条目
  const merged = [];
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      const it = g[i];
      if (!it) continue;
      const k = it.title.slice(0, 24);
      const main = seen.get(k);
      if (!main) {
        seen.set(k, it);
        merged.push(it);
        continue;
      }
      if (it.source && orgOfSource(it.source) !== orgOfSource(main.source)) {
        const org = orgOfSource(it.source);
        if (!main.alsoFrom) main.alsoFrom = [];
        if (main.alsoFrom.length < ALSO_FROM_MAX && !main.alsoFrom.includes(org)) main.alsoFrom.push(org);
      }
    }
  }

  // 内容信任过滤（2026-12 修复）：此前本链路**完全没有**信任过滤，而小程序端（走 webSearch 云函数）有。
  // 产出 dist/api/hotspot.json 的是这里 —— 也就是线上 H5/gh-pages 站点真正读的那份数据。
  // 后果：一条被投毒的 RSS 条目能绕过小程序端的过滤，直接进线上站点、进用户视野。
  // 现在 require 的是与云函数**同一份** rules（cloudfunctions/webSearch/news-trust.js），不可能再发散。
  // 位置放在跨源合并之后、pubDate 剥离之前：此时 entry 仍带 pubDate，可被 NEWS_TRUST_* 全字段判定。
  const trust = filterNewsItems(merged, { label: 'fetch-data' });
  dropped.untrusted = trust.dropped.length;
  if (trust.dropped.length) {
    dropped.trustReasons = trust.dropped.reduce((acc, d) => {
      acc[d.reason] = (acc[d.reason] || 0) + 1;
      return acc;
    }, {});
  }

  // 内部字段 → 响应契约（2026-10-26）：pubDate 此前被**整体丢弃**，于是 hotspot.json 里的
  // 条目没有 createTime，晨报 intelItems 拿不到真实发布时间，突发识别 24h 时效闸对现有数据
  // 恒放行（100% 空转）。现在把 RSS 发布时间转成契约字段 createTime（ISO）。
  // 无 pubDate 的条目（热榜/板块）保持原样 —— 不伪造当前时间，消费侧按「缺时间保守放行」处理。
  const items = trust.kept.map(({ pubDate, ...rest }) =>
    Number.isFinite(pubDate) ? { ...rest, createTime: new Date(pubDate).toISOString() } : rest
  );
  return {
    items,
    meta: { updatedAt: new Date().toISOString(), stale: false, sources: srcStatus, dropped, boards }
  };
}

/** 防回退守卫：一次抖动抓到的「劣化快照」不得覆盖掉上一份好数据。
 *
 *  为什么需要（2026-09-29 实测）：本机一次抓取拿到 124 条、13/23 个源正常（10 个源超时），
 *  而当天早些时候同一脚本拿到 203~222 条。原实现只在「抓到 0 条」时才不覆盖 ——
 *  「抓到很少」照样会把好数据换成坏的，用户看到的就是内容忽然少一半、类目从 18 掉到 10。
 *
 *  规则：新份数 < 上一份 × REGRESS_RATIO，且上一份还「够新」（< REGRESS_FRESH_MS）→ 拒绝覆盖。
 *  超过新鲜窗口就接受劣化数据：宁可内容少一点，也不要让一份陈旧快照被无限期钉住。
 *  注意这是**宽度**守卫，不是质量守卫 —— 条数正常但内容错的快照它拦不住，别当成万能。 */
const REGRESS_RATIO = 0.7;
const REGRESS_FRESH_MS = 6 * 60 * 60 * 1000;

/** 返回 null 表示允许写入；返回字符串表示拒绝写入的原因 */
function guardRegression(outPath, newCount) {
  if (!outPath) return null;
  let prevRaw;
  let prevStat;
  try {
    prevStat = fs.statSync(outPath);
    prevRaw = fs.readFileSync(outPath, 'utf8');
  } catch {
    return null; // 首次写入 / 文件不存在
  }
  let prevCount = 0;
  try {
    const prev = JSON.parse(prevRaw);
    prevCount = Array.isArray(prev.items) ? prev.items.length : 0;
  } catch {
    return null; // 上一份坏了就别拿它当基准
  }
  if (prevCount <= 0) return null;
  const ageMs = Date.now() - prevStat.mtimeMs;
  if (ageMs >= REGRESS_FRESH_MS) return null; // 上一份已不新鲜，接受当前结果
  if (newCount >= prevCount * REGRESS_RATIO) return null;
  return `新快照 ${newCount} 条 < 上一份 ${prevCount} 条的 ${Math.round(REGRESS_RATIO * 100)}%（上一份仅 ${Math.round(ageMs / 60000)} 分钟前）`;
}

async function main() {
  const argIdx = process.argv.indexOf('--out');
  const outPath = argIdx > -1 ? process.argv[argIdx + 1] : null;

  const { items, meta } = await fetchHotspot();
  if (!items.length) {
    console.error('[fetch-data] all sources failed - keep existing output untouched');
    process.exit(1); // Actions 侧失败退出：不覆盖上一次的好数据
  }

  const rejected = guardRegression(outPath, items.length);
  if (rejected) {
    // 不覆盖是**成功**（保住了好数据），故退出码 0：Actions 那步不会变红，
    // 且 gh-pages 的「无变化则跳过提交」逻辑会自然生效。
    console.warn('[fetch-data] 拒绝覆盖：' + rejected + ' → 保留上一份，本次不写入');
    meta.dropped = { ...(meta.dropped || {}), regressionGuard: items.length };
    if (!outPath) process.stdout.write(JSON.stringify({ items, ...meta }));
    return;
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
