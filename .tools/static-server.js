// 轻量静态服务：默认服务 dist 目录；设置 PREVIEW_ROOT 可服务固定快照，避免 Trae 持续重建导致 hash 变化
const http = require('http');
const fs = require('fs');
const path = require('path');

// 用法：node static-server.js [rootDir]
//   rootDir 可为相对项目根（如 .tools/preview-snapshot）或绝对路径；缺省服务 dist
const ROOT = process.argv[2]
  ? path.resolve(__dirname, '..', process.argv[2])
  : process.env.PREVIEW_ROOT
    ? path.resolve(__dirname, '..', process.env.PREVIEW_ROOT)
    : path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.STATIC_PORT) || 8137; // 避开 8080：Trae 体系内 8080 有代理/缓存干扰，曾返回「Add to Chat」占位页
// LLM 代理端口默认 8138；仅测试时用 LLM_PROXY_PORT 指向 mock（生产/预览不设该 env，行为不变）
const LLM_PROXY_PORT = Number(process.env.LLM_PROXY_PORT) || 8138;
const chatLimiter = new Map(); // IP -> 时间戳数组，用于 /api/chat 限流
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff': 'font/woff'
};

// ---------- 真实数据聚合实现（全部免 key 零成本；2026-09-10 实测可用源） ----------
const FETCH_TIMEOUT = 8000;
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟内存缓存，避免高频打外部源

function fetchText(url) {
  return Promise.race([
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT))
  ]);
}

/** WMO 天气码 → 中文 */
const WMO = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 剥 CDATA 与 HTML 标签，压平空白（注意：先解码实体再剥标签，IT之家正文是实体编码的 HTML） */
function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 极简 RSS 解析（无依赖，够用即可）
 *  tag：该源所属类目（来自 RSS_SOURCES），透传到条目 tags，供前端做类目分组/展示。
 *  与云函数 webSearch/index.js 的 parseFeed(xml, sourceName, tag) 口径一致 —— 两侧都标注类目，
 *  否则「多元化」只发生在数据里、用户在界面上看不见。 */
function parseRss(xml, source, limit, tag) {
  const out = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, limit)) {
    const title = clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = clean((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const desc = clean((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (!title) continue;
    // pubDate → 毫秒时间戳（解析不出来记 null）。字段口径与云函数一致。
    // 注意：这是**内部字段**，仅供 fetchHotspot 的新鲜度闸门使用，不会进入响应契约。
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

// ---------- 磁盘缓存与来源健康度 ----------
// 存储分层：L1 内存(30min) → L2 实时拉取 → L3 磁盘缓存(断源降级,标 stale) → (前端) L4 mock
const CACHE_DIR = path.join(__dirname, 'cache');
const DISK_STALE_OK = true; // 断源时允许使用过期磁盘缓存（真实数据永远好过 mock）

function diskRead(name) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8')); } catch { return null; }
}
function diskWrite(name, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(data));
  } catch {}
}

// 来源健康度：连续失败 2 次进入 30 分钟冷却，期间跳过该源（快速失败，不拖慢聚合）
// 持久化到 cache/source-health.json：重启后仍保留冷却，避免刚启动就再打坏源
const sourceHealth = new Map(); // name -> { failStreak, cooldownUntil }
const SOURCE_COOLDOWN = 30 * 60 * 1000;
/** 连接级瞬时失败（socket hang up / ECONNRESET 等）的重试次数与退避。
 *  口径与云函数 cloudfunctions/webSearch/index.js 的 shouldRetry 对齐：**仅此类失败重试一次**；
 *  timeout 不重试（代价 2×FETCH_TIMEOUT，会拖慢整个聚合，而它本就不是超时能解决的问题）、
 *  HTTP 4xx/5xx 不重试（重试无意义）。
 *  为什么值得做：源连续失败 2 次即进 30 分钟冷却，且聚合结果又被缓存 30 分钟 ——
 *  一次瞬时抖动会被**放大成「该源接下来近一小时完全不可见」**，而不是丢一条。
 *  源清单扩容到 31 个源之后，抖动命中概率同步上升，故补上这一层。 */
const CONN_RETRY_TIMES = 2;
const CONN_RETRY_BACKOFF_MS = 300;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSourceHealth() {
  const d = diskRead('source-health.json');
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v.failStreak === 'number') {
        sourceHealth.set(k, { failStreak: v.failStreak, cooldownUntil: v.cooldownUntil || 0 });
      }
    }
  }
}
function saveSourceHealth() {
  const d = {};
  for (const [k, v] of sourceHealth) d[k] = v;
  diskWrite('source-health.json', d);
}

function canFetch(name) {
  const h = sourceHealth.get(name);
  return !h || h.cooldownUntil < Date.now();
}
function markSourceOk(name) {
  sourceHealth.set(name, { failStreak: 0, cooldownUntil: 0 });
  saveSourceHealth();
}
function markSourceFail(name) {
  const h = sourceHealth.get(name) || { failStreak: 0, cooldownUntil: 0 };
  h.failStreak += 1;
  if (h.failStreak >= 2) h.cooldownUntil = Date.now() + SOURCE_COOLDOWN;
  sourceHealth.set(name, h);
  saveSourceHealth();
}

loadSourceHealth(); // 启动即恢复持久化的来源健康度

// 用户数据轻云的持久状态必须放模块级：放请求处理器内会每请求重置，限流失效
const USER_DIR = path.join(CACHE_DIR, 'userdata');
const syncLimiter = new Map(); // IP -> 时间戳数组，防滥用（正常用户 30 秒一推，限额绰绰有余）
const aiFilterLimiter = new Map(); // /api/news/ai-filter 限流（手动触发，正常点击远低于限额）
const aiFilterCache = { key: '', at: 0, payload: null }; // 单槽缓存：同画像+同新闻 2 小时内不重复调 LLM
/** AI 精选的展示条数与**同类目硬上限**。
 *  为什么需要硬上限：提示词里写了「同类目最多 2 条」，但 2026-09-28 实测证明模型并不可靠遵守 ——
 *  一次真实调用里「教育」一个类目占了 4/10 = 40%，反而比扩源前的最大占比（32.5%）更差。
 *  只靠提示词 = 把产品指标交给概率，故改为在下游做确定性约束。
 *  算术上的好处：取 10 条且同类目 ≤2 ⟹ **必然覆盖 ≥5 个类目**，不需要再单独校验类目数。 */
const AI_PICK_MAX = 10;
const AI_PICK_PER_CATEGORY_MAX = 2;
/** 条目类目：优先取非「热榜」的标签（垂类榜是 ['热榜','开源']）；综合榜归为一类，
 *  顺带把 5 个综合榜的时政不可控敞口也压到 ≤2 条。 */
function categoryOfItem(it) {
  const t = Array.isArray(it.tags) ? it.tags : [];
  const c = t.filter((x) => x !== '热榜');
  return c.length ? c[0] : (t.includes('热榜') ? '综合热榜' : '未分类');
}

const hotspotCache = { at: 0, items: [], meta: null };

// 资讯源注册表：name 用于健康度跟踪与响应标注
// 2026-09-11 实测可用性：ifanr/geekpark/tmtpost 均返回可解析 RSS；solidot/huxiu/cnbeta/jiemian 不通已排除
// 2026-09-15 新增热榜源：经本地 DailyHotApi（6688 端口）统一取数，来源标注与 RSS 源同机制
const HOT_API = 'http://127.0.0.1:6688';

/** DailyHotApi 热榜 → 统一资讯条目（hot 为平台热度值，url 优先移动端链接）
 *  tag：垂类板块的类目（如「开源」「科学」）。综合榜不传，保持 tags=['热榜'] 的既有语义。
 *  两个标签都要留：'热榜' 是给用户看的形态标注（合规要求「热搜参考」而非新闻报道），
 *  类目是给 AI 精选做多样性判断用的 —— 合成一个会丢信息。 */
function hotBoard(route, label, limit, tag) {
  return {
    name: label,
    fetch: () =>
      fetchText(`${HOT_API}/${route}`)
        .then((x) => JSON.parse(x))
        .then((d) =>
          (d.data || []).slice(0, limit).map((it, i) => ({
            id: 'hot_' + hash(label + String(it.title)),
            title: String(it.title || '').trim(),
            summary: `${label} 第 ${i + 1} 位${it.hot ? ` · 热度 ${it.hot}` : ''}`,
            source: label,
            url: it.mobileUrl || it.url || '',
            tags: tag ? ['热榜', tag] : ['热榜']
          }))
        )
  };
}

/** 条目新鲜度闸门（天）：与云函数 webSearch/index.js 的 STALE_SOURCE_DAYS 对齐（同为 7 天）。
 *  仅作用于 RSS 源 —— 热榜源与知乎日报 API 本身不带时间戳，既不伪造日期也不参与过滤。 */
const STALE_ITEM_DAYS = 7;

/** RSS 源的**唯一事实来源 = 生产云函数 cloudfunctions/webSearch/index.js 的 RSS_SOURCES**。
 *
 *  为什么不再在这里手抄一份：2026-09-24 出现过「生产链路早已剔除冻结源人民网（其 100 条
 *  pubDate 全部 476 天前），而预览链路用的是另一份手抄清单、仍在给用户喂旧闻」——
 *  **两份各自维护的清单必然发散**，抄得再准也没用。故改为预览侧直接解析云函数的源清单。
 *
 *  解析失败（文件移动 / 数组格式改了）才回退到 FALLBACK_RSS，并且**必须大声告警**：
 *  静默回退等于把"两份清单"这个病根悄悄养回来。 */
const CLOUD_WEBSEARCH = path.join(__dirname, '..', 'cloudfunctions', 'webSearch', 'index.js');
const RSS_PER_SOURCE = 10;

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

const SHARED_RSS = loadRssSourcesFromCloud();
// [L5 合规审计] 生产唯一事实源在 cloudfunctions/webSearch/index.js 的 RSS_SOURCES（本文件只读解析，不在其旁加注释以免越权改动他人文件）。
// 逐源分类与时政占比结论见 docs/compliance-source-audit.md：中新网-即时（时政）与中新网-社会（涉突发事件）
// 时政占比高，建议移除或降权——产品决策留 PM，此处不删源。
const FALLBACK_RSS = [
  { name: '少数派', url: 'https://sspai.com/feed', tag: '数字生活' }, // [audit] 数字生活，时政占比≈0，保留
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', tag: '科技' }, // [audit] 科技，时政占比≈0，保留
  { name: 'IT之家', url: 'https://www.ithome.com/rss', tag: '科技' }, // [audit] 科技，时政占比低（偶涉行业政策），保留
  { name: '极客公园', url: 'https://www.geekpark.net/rss', tag: '科技' }, // [audit] 科技，时政占比低，保留
  { name: '钛媒体', url: 'https://www.tmtpost.com/rss', tag: '商业' }, // [audit] 财经/商业，时政占比低-中（宏观政策），观察保留
  // 2026-09-28 多元化扩源：兜底清单必须与唯一事实源保持同口径，否则一旦解析失败回退，类目又会缩回 7 类
  { name: '机核', url: 'https://www.gcores.com/rss', tag: '游戏' },
  { name: '车东西', url: 'https://chedongxi.com/rss', tag: '汽车' },
  { name: '什么值得买', url: 'https://post.smzdm.com/feed', tag: '消费' },
  { name: '芥末堆', url: 'https://www.jiemodui.com/feed', tag: '教育' },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', tag: '开发者' },
  { name: '掘金', url: 'https://juejin.cn/rss', tag: '开发者' },
  { name: '小众软件', url: 'https://www.appinn.com/feed/', tag: '数字生活' }
];
const RSS_SOURCES = SHARED_RSS.list || FALLBACK_RSS;
if (SHARED_RSS.err) {
  console.warn('[hotspot] 无法从云函数解析 RSS_SOURCES（' + SHARED_RSS.err + '）→ 已回退本地兜底清单，两份清单可能再次发散，请尽快修复');
}
console.log('[hotspot] RSS 源（' + (SHARED_RSS.list ? '来自云函数 webSearch' : '本地兜底') + '，共 ' + RSS_SOURCES.length + '）：' + RSS_SOURCES.map((s) => s.name).join(' / '));

const HOTSPOT_SOURCES = [
  ...RSS_SOURCES.map((s) => ({
    name: s.name,
    // tag 一并传入：类目要落到条目 tags 上，前端才能按类目分组展示（与云函数 toNews 口径一致）
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
  },
  // [L5 合规审计] 热榜源为综合类，条目由平台算法生成，时政/突发事件占比**不可控且偏高**，
  // 无法在源层面移除（源本身不是时政源）。建议在 AI 精选/前端展示层对时政类目降权——见 docs/compliance-source-audit.md
  hotBoard('weibo', '微博热搜', 10), // [audit] 综合，时政占比不可控（偏高）
  hotBoard('zhihu', '知乎热榜', 10), // [audit] 综合，时政占比不可控（偏高）
  hotBoard('baidu', '百度热点', 10), // [audit] 综合，时政占比不可控（偏高）
  hotBoard('douyin', '抖音热点', 10), // [audit] 综合，时政占比不可控（偏高）
  hotBoard('bilibili', 'B站热榜', 10), // [audit] 综合，时政占比不可控（中等）
  // ↓↓↓ 2026-09-28 多元化扩源：新增垂类板块（非综合榜，时政占比≈0，是合规上最安全的扩类目方式）↓↓↓
  // 验证方式：不起服务、不占端口，直接 import 各 route 的 handleRoute 并给假 ListContext，
  // 即「等价于请求该端点」但不引入常驻进程 —— 见 .tmp-verify/diverse-intel/verify-boards.ts 的做法。
  // 全部实测通过且**耗时都在 fetchText 的 8s 上限内**（这是只在条数之外还必须量的一项）。
  hotBoard('hellogithub', 'HelloGitHub', 10, '开源'), // [audit] 开源项目，≈0% · 实测 20 条 / 4.5s
  hotBoard('guokr', '果壳', 10, '科学'), // [audit] 科学科普，≈0% · 实测 30 条 / 0.23s
  hotBoard('dgtle', '数字尾巴', 10, '数码'), // [audit] 数码消费，≈0% · 实测 20 条 / 0.5s
  hotBoard('douban-movie', '豆瓣电影', 10, '影视') // [audit] 影视榜单，≈0% · 实测 10 条 / 0.74s
  // ⚠️ 以下板块已实测**不采纳**，勿再加：
  //   github（开源趋势）：实测单次 11.8s > fetchText 的 8s 上限 → 上线即超时，连续失败进 30 分钟冷却，纯负资产；
  //     且其 title 只取 repo 名（丢失 owner），标题形如「paperclip」可读性差。
  //   coolapk（酷安）：上游 403（需签名）。
  //   lol / v2ex / miyoushe（电竞/开发者社区/二次元）：上游连接失败（curl http=000）。
];

/** 返回 { items, meta }；meta: { updatedAt, stale, sources: [{name,count,ok}] } */
async function fetchHotspot() {
  const now = Date.now();
  if (hotspotCache.items.length && now - hotspotCache.at < CACHE_TTL) {
    return { items: hotspotCache.items, meta: hotspotCache.meta };
  }

  const groups = [];
  const srcStatus = [];
  const staleMaxAge = STALE_ITEM_DAYS * 24 * 60 * 60 * 1000;
  const dropped = { undated: 0, stale: 0 };
  await Promise.all(
    HOTSPOT_SOURCES.filter((s) => canFetch(s.name)).map(async (s) => {
      let ok = false;
      let reason = '';
      for (let attempt = 1; attempt <= CONN_RETRY_TIMES; attempt++) {
        try {
          const g = await s.fetch();
          // 新鲜度闸门：**只作用于 RSS 源**（只有 parseRss 的条目带 pubDate 字段）。
          // 热榜源 / 知乎日报 API 本身不带时间戳 —— 不为它们伪造日期，也不因无日期而过滤掉。
          if (!g.length) { reason = 'empty'; break; }
          const fresh = [];
          for (const it of g) {
            if (!('pubDate' in it)) { fresh.push(it); continue; } // 非 RSS 源：原样放行
            if (it.pubDate == null) { dropped.undated += 1; continue; } // 无日期：无法判定新鲜度，丢弃
            if (now - it.pubDate > staleMaxAge) { dropped.stale += 1; continue; } // 陈旧：丢弃
            fresh.push(it);
          }
          // 全源条目都被闸门丢弃 → 视同该源不健康（与云函数「整源排除」口径一致）。
          // 注意：这种情况**不重试** —— 内容陈旧不是瞬时故障，重试只会白等一轮。
          if (!fresh.length) { reason = 'stale'; break; }
          ok = true;
          groups.push(fresh);
          break;
        } catch (e) {
          const msg = String((e && e.message) || e);
          // 区分失败类型：只有连接级瞬时失败值得重试
          reason = /timeout/i.test(msg) ? 'timeout' : (/^HTTP \d+$/.test(msg) ? 'http-' + msg.slice(5) : 'fetch-error');
          if (reason === 'fetch-error' && attempt < CONN_RETRY_TIMES) {
            await sleepMs(CONN_RETRY_BACKOFF_MS * attempt);
            continue;
          }
          break;
        }
      }
      if (ok) markSourceOk(s.name);
      else {
        markSourceFail(s.name);
        // 不再静默：失败原因必须能被外部看到（原实现是 catch {} 后只记 ok=false，
        // 源为什么消失完全不可查，只能靠猜。云函数侧本就记录了 reason，这里补齐。）
        const h = sourceHealth.get(s.name) || {};
        console.warn('[hotspot] 源失败 ' + s.name + '：' + (reason || 'unknown')
          + '（连续失败 ' + (h.failStreak || 0) + ' 次'
          + (h.cooldownUntil > Date.now() ? '，冷却至 ' + new Date(h.cooldownUntil).toISOString() : '') + '）');
      }
      srcStatus.push({ name: s.name, count: 0, ok, reason: reason || '' });
    })
  );
  // count 需要真实条数：重新按组统计（groups 与成功源顺序无关，用 source 字段兜底）
  for (const st of srcStatus) {
    st.count = st.ok ? groups.reduce((n, g) => n + g.filter((it) => it.source === st.name).length, 0) : 0;
  }

  const seen = new Set();
  const merged = [];
  // 跨源轮询交错：避免单一来源霸占前列（合规与多样性都更好）
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      const it = g[i];
      if (!it) continue;
      const k = it.title.slice(0, 24);
      if (!seen.has(k)) { seen.add(k); merged.push(it); }
    }
  }
  // 剥离内部字段：pubDate 只用于上面的新鲜度闸门，不进入响应契约
  // （src/types/index.ts 的 HotspotNews 无该字段，且该文件已冻结）
  const items = merged.map(({ pubDate, ...rest }) => rest);

  const meta = {
    updatedAt: new Date().toISOString(),
    stale: false,
    sources: srcStatus,
    // 新鲜度闸门丢弃数（可观测）：undated=无 pubDate，stale=早于 STALE_ITEM_DAYS 天
    dropped
  };
  if (items.length) {
    hotspotCache.at = now;
    hotspotCache.items = items;
    hotspotCache.meta = meta;
    diskWrite('hotspot.json', { at: now, items, meta });
    return { items, meta };
  }

  // 全源失败（或全部冷却中）→ 磁盘缓存兜底：宁可给旧的真实数据，不给编造的 mock
  const disk = diskRead('hotspot.json');
  if (DISK_STALE_OK && disk && Array.isArray(disk.items) && disk.items.length) {
    const staleMeta = { ...(disk.meta || {}), updatedAt: disk.meta?.updatedAt || new Date(disk.at).toISOString(), stale: true };
    hotspotCache.at = now - CACHE_TTL + 60_000; // 1 分钟后重试真源，不让缓存钉死
    hotspotCache.items = disk.items;
    hotspotCache.meta = staleMeta;
    return { items: disk.items, meta: staleMeta };
  }
  return { items: [], meta };
}

const weatherCache = new Map(); // city → { at, payload }
async function fetchWeather(city) {
  const now = Date.now();
  const hit = weatherCache.get(city);
  if (hit && now - hit.at < CACHE_TTL) return hit.payload;

  try {
    const geoRaw = await fetchText(
      'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh'
    );
    const loc = (JSON.parse(geoRaw).results || [])[0];
    if (!loc) return { weather: null };

    const fcRaw = await fetchText(
      'https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1'
    );
    const fc = JSON.parse(fcRaw);
    const cw = fc.current_weather;
    const daily = fc.daily || {};
    if (!cw) return { weather: null };
    const desc = WMO[cw.weathercode] || '多云';
    const min = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : '?';
    const max = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : '?';
    const text = loc.name + ' ' + desc + '，当前 ' + Math.round(cw.temperature) + '°C，今日 ' + min + '~' + max + '°C';
    const payload = { weather: { text, updateTime: new Date().toISOString() }, stale: false };
    weatherCache.set(city, { at: now, payload });
    diskWrite(`weather_${hash(city)}.json`, { at: now, payload });
    return payload;
  } catch (e) {
    // Open-Meteo 拉取失败 → 该城市磁盘缓存兜底（标 stale）；从未成功过才返回 null（前端降级 mock）
    const disk = diskRead(`weather_${hash(city)}.json`);
    if (DISK_STALE_OK && disk && disk.payload && disk.payload.weather) {
      const stale = { ...disk.payload, stale: true };
      weatherCache.set(city, { at: now - CACHE_TTL + 60_000, payload: stale });
      return stale;
    }
    return { weather: null };
  }
}


http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // /api/chat 同源反代 → 本地 LLM 代理（8138，DeepSeek）：公网访客走隧道也能用 AI，key 始终留在本机
  if (req.method === 'POST' && urlPath === '/api/chat') {
    // 简单 IP 限流：每 IP 每小时最多 20 次，防止公网访客薅干 DeepSeek 余额
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    if (!chatLimiter.has(ip)) chatLimiter.set(ip, []);
    const hits = chatLimiter.get(ip).filter((t) => now - t < 3600_000);
    if (hits.length >= 20) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '试用额度已用完（每小时20次），请稍后再试' }));
    }
    hits.push(now);
    chatLimiter.set(ip, hits);
    if (chatLimiter.size > 5000) { // 防内存无限增长
      for (const [k, v] of chatLimiter) if (v.every((t) => now - t >= 3600_000)) chatLimiter.delete(k);
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const proxyReq = http.request(
        { host: '127.0.0.1', port: LLM_PROXY_PORT, path: '/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        (pr) => { res.writeHead(pr.statusCode || 502, { 'Content-Type': 'application/json' }); pr.pipe(res); }
      );
      proxyReq.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'llm proxy down' }));
      });
      proxyReq.end(body);
    });
    return;
  }

  // ---------- 真实数据聚合（v1.3 零成本：Open-Meteo 天气 + RSS/JSON 资讯，内存30min+磁盘持久缓存） ----------
  if (req.method === 'GET' && urlPath === '/api/hotspot') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const keyword = (params.get('kw') || '').trim().toLowerCase();
    fetchHotspot()
      .then(({ items, meta }) => {
        const out = keyword
          ? items.filter((it) => (it.title + (it.summary || '')).toLowerCase().includes(keyword))
          : items;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          items: out,
          updatedAt: meta?.updatedAt || null,
          stale: !!meta?.stale,
          sources: meta?.sources || [],
          // 新鲜度闸门丢弃数：不下发就等于没算 —— 「源冻住了」必须能被外部看到，否则又是一个静默失败
          dropped: meta?.dropped || { undated: 0, stale: 0 }
        }));
      })
      .catch(() => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      });
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/briefing') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const city = (params.get('city') || '北京').slice(0, 12);
    fetchWeather(city)
      .then((p) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(p)); })
      .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ weather: null })); });
    return;
  }

  // ---------- 系统状态（试用页状态模块）：零 LLM 成本 ----------
  // AI 代理只做 TCP 连通性探测（不发任何 LLM 请求，不烧余额）；
  // 资讯部分复用 fetchHotspot()（30min 内存缓存，冷缓存时才真正出网）。
  if (req.method === 'GET' && urlPath === '/api/status') {
    const net = require('net');
    const aiOk = await new Promise((resolve) => {
      const s = net.connect(LLM_PROXY_PORT, '127.0.0.1');
      s.setTimeout(1500);
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
    try {
      const { items, meta } = await fetchHotspot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hotspot: {
          count: items.length,
          updatedAt: meta?.updatedAt || null,
          stale: !!meta?.stale,
          dropped: meta?.dropped || { undated: 0, stale: 0 },
          sources: meta?.sources || []
        },
        aiProxy: { online: aiOk, port: LLM_PROXY_PORT }
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hotspot: null, aiProxy: { online: aiOk, port: LLM_PROXY_PORT } }));
    }
    return;
  }

  // ---------- 用户数据轻云（微信云开发就绪前的过渡）：按 userId 隔离的 JSON 文件 ----------
  function readBody(cb) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413); res.end('too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => cb(Buffer.concat(chunks)));
  }
  function userFile(rawId) {
    const id = String(rawId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (id.length < 6) return null;
    return path.join(USER_DIR, id + '.json');
  }
  function limited(bucket, max, windowMs) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    if (!bucket.has(ip)) bucket.set(ip, []);
    const hits = bucket.get(ip).filter((t) => now - t < windowMs);
    if (hits.length >= max) { bucket.set(ip, hits); return true; }
    hits.push(now);
    bucket.set(ip, hits);
    return false;
  }

  // GET /api/user/data?userId=xxx → 拉取该用户全部云端数据（未注册过返回空集）
  if (req.method === 'GET' && urlPath === '/api/user/data') {
    if (limited(syncLimiter, 60, 60_000)) { res.writeHead(429); return res.end('too many'); }
    const file = userFile(new URL(req.url, 'http://x').searchParams.get('userId'));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!file) return res.end(JSON.stringify({ updatedAt: 0, data: {} }));
    fs.readFile(file, 'utf8', (err, txt) => res.end(err ? JSON.stringify({ updatedAt: 0, data: {} }) : txt));
    return;
  }

  // POST /api/user/sync { userId, data: { key: { v, ts } } } → 按 key 保留较新版本（防旧设备覆盖新数据）
  if (req.method === 'POST' && urlPath === '/api/user/sync') {
    if (limited(syncLimiter, 60, 60_000)) { res.writeHead(429); return res.end('too many'); }
    readBody((body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { return res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
      const file = userFile(payload && payload.userId);
      if (!file || !payload.data || typeof payload.data !== 'object') return res.end(JSON.stringify({ ok: false, error: 'bad payload' }));
      let existing = { updatedAt: 0, data: {} };
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const merged = { ...(existing.data || {}) };
      for (const k of Object.keys(payload.data)) {
        const inc = payload.data[k];
        if (!inc || typeof inc !== 'object' || !('v' in inc)) continue;
        const cur = merged[k];
        if (!cur || (Number(inc.ts) || 0) >= (Number(cur.ts) || 0)) merged[k] = { v: inc.v, ts: Number(inc.ts) || 0 };
      }
      try {
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), data: merged }));
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.end(JSON.stringify({ ok: false, error: 'write failed' }));
      }
    });
    return;
  }

  // ---------- 资讯 AI 精选（手动触发；候选打包 → 8138 /filter → DeepSeek JSON mode；2h 单槽缓存） ----------
  if (req.method === 'POST' && urlPath === '/api/news/ai-filter') {
    if (limited(aiFilterLimiter, 30, 60_000)) { res.writeHead(429); return res.end('too many'); }
    readBody((body) => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const interests = Array.isArray(payload.interests)
        ? payload.interests.map((s) => String(s).slice(0, 12)).filter(Boolean).slice(0, 8)
        : [];
      const custom = String(payload.custom || '').slice(0, 60);
      const signals = Array.isArray(payload.signals)
        ? payload.signals.map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 8)
        : [];
      fetchHotspot()
        .then(({ items, meta }) => {
          if (!items.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ items: [], summary: '', updatedAt: null }));
          }
          const fingerprint = hash(JSON.stringify(interests) + '|' + custom + '|' + items.map((it) => it.id).join(','));
          const now = Date.now();
          if (aiFilterCache.key === fingerprint && now - aiFilterCache.at < 2 * 60 * 60 * 1000) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ...aiFilterCache.payload, cached: true }));
          }
          // 候选串带上 [来源·类目]：类目由数据自己带（RSS 源 tag / 垂类板块 tag），
          // 而不是把「哪个源属于哪个类目」硬编码进上游提示词 —— 那样一改源清单就失真。
          const candidates = items.slice(0, 110).map((it, i) => {
            const tags = Array.isArray(it.tags) && it.tags.length ? '·' + it.tags.join('/') : '';
            return `${i + 1}. [${it.source}${tags}] ${it.title}`;
          });
          const fbody = JSON.stringify({ interests, custom, signals, candidates });
          const proxyReq = http.request(
            {
              host: '127.0.0.1', port: LLM_PROXY_PORT, path: '/filter', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fbody) },
              timeout: 45000
            },
            (pr) => {
              const chunks = [];
              pr.on('data', (c) => chunks.push(c));
              pr.on('end', () => {
                try {
                  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  const picks = Array.isArray(parsed.picks) ? parsed.picks : [];
                  const pickedItems = picks
                    .map((p) => {
                      const it = items[Number(p.n) - 1];
                      if (!it) return null;
                      // X1 whyItMatters：上游 /filter 的 why 字段（≤30字，个人化推荐理由）→ 映射到条目。
                      // 容错：缺失/非字符串 → 不产出该字段（undefined 会被 JSON.stringify 丢弃）；
                      // 超长 → 截断 30 字。旧缓存 payload 无该字段时原样透传，照常工作。
                      const why = typeof p.why === 'string' ? p.why.trim().slice(0, 30) : '';
                      return { ...it, aiReason: String(p.reason || ''), ...(why ? { whyItMatters: why } : {}) };
                    })
                    .filter(Boolean);
                  // 确定性多样性兜底：按模型给的相关度顺序贪心取，同类目超过上限则跳过（留作备用但不展示）。
                  // 提示词不可靠（实测教育占 4/10），这里是唯一能保证结果的地方。
                  const perCat = new Map();
                  const diverseItems = [];
                  let trimmed = 0;
                  for (const it of pickedItems) {
                    const c = categoryOfItem(it);
                    const used = perCat.get(c) || 0;
                    if (used < AI_PICK_PER_CATEGORY_MAX && diverseItems.length < AI_PICK_MAX) {
                      perCat.set(c, used + 1);
                      diverseItems.push(it);
                    } else trimmed += 1;
                  }
                  if (trimmed) {
                    console.warn('[ai-filter] 同类目去重：模型给 ' + pickedItems.length + ' 条，按每类 ≤'
                      + AI_PICK_PER_CATEGORY_MAX + ' 截到 ' + diverseItems.length + ' 条（丢弃 ' + trimmed + ' 条备用）');
                  }
                  const out = {
                    items: diverseItems,
                    summary: String(parsed.summary || ''),
                    updatedAt: meta?.updatedAt || null,
                    aiFiltered: true,
                    // 可观测：把「实际覆盖了几个类目」下发出去。不下发就等于没测 ——
                    // 否则多样性回退只能靠人肉看页面发现（这次的 4/10 就是这么发现的）。
                    categories: perCat.size,
                    trimmedByCategory: trimmed
                  };
                  aiFilterCache.key = fingerprint;
                  aiFilterCache.at = now;
                  aiFilterCache.payload = out;
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(out));
                } catch {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'bad filter response' }));
                }
              });
            }
          );
          proxyReq.on('timeout', () => proxyReq.destroy(new Error('filter timeout')));
          proxyReq.on('error', () => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'llm proxy down' }));
          });
          proxyReq.end(fbody);
        })
        .catch(() => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'hotspot unavailable' }));
        });
    });
    return;
  }

  let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      const ext = path.extname(urlPath).toLowerCase();
      // 只对浏览器地址栏请求（无扩展名或 .html/.htm）做 SPA 兜底；JS/CSS 等静态资源未命中直接 404，
      // 绝不能再返回 index.html —— 否则把 HTML 当 JS 执行会触发 SyntaxError: Unexpected token '<'
      if (ext === '' || ext === '.html' || ext === '.htm') {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('Not Found'); }
          // index.html 禁止缓存：否则浏览器拿旧 html 引用已删除的旧 chunk → 白屏
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found: ' + urlPath);
    }
    const ext = path.extname(file).toLowerCase();
    // 带 hash 文件名的构建产物可永久缓存；其余（如 index.html）禁止缓存
    const immutable = /\.(js|css|png|jpg|svg|woff2?)$/.test(ext) && /[\w]{8,}\./.test(path.basename(file));
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`static server on http://localhost:${PORT} -> ${ROOT}`));
