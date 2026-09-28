/**
 * webSearch 云函数 —— 联网内容聚合（F15 今日情报 / F29 热点资讯流）
 *
 * action=hotspot   热点页资讯流：RSS 聚合，强制标注来源，免费可用，1 小时缓存，无 LLM 成本
 * action=briefing  今日情报：和风天气 + 偏好 RSS → 订阅档 LLM 摘要（日限额 10 次）/ 免费档原始 3 条
 *                  每一步失败均降级，绝不阻塞调用方（getBriefing 晨报生成）
 *
 * 环境变量（云开发控制台配置）：
 *   WEATHER_KEY        和风天气 Key（免费档；缺失时天气降级为 null）
 *   WEATHER_LOCATION   和风天气 location（坐标或城市 ID，选填，默认北京 116.41,39.92）
 *   LLM_API_KEY        DeepSeek Key（摘要用；缺失/失败时降级为原始资讯并标 degraded）
 *   LLM_BASE_URL       选填，默认 https://api.deepseek.com
 *   LLM_MODEL          选填，默认 deepseek-chat
 */
const cloud = require('wx-server-sdk');
const https = require('https');
const { URL } = require('url');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const INTEL_DAILY_LIMIT = 10;
const HOTSPOT_CACHE_MS = 60 * 60 * 1000; // 热点缓存 1 小时
const FETCH_TIMEOUT_MS = 6000;

/* ---------------- 内容源策略常量（全部导出，杜绝魔法数字） ---------------- */

/** 首页资讯流条数上限（配额选取后的总数） */
const HOTSPOT_ITEMS_LIMIT = 10;
/** 单源入选条数上限：防止高频源（如中新网-即时）淹没全部席位，保住广度 */
const MAX_ITEMS_PER_SOURCE = 3;
/** 源新鲜度阈值（天）：最新条目早于该值的源判定为「冻结源」，整源排除（宁缺勿滥） */
const STALE_SOURCE_DAYS = 7;
/** 连接级瞬时失败（socket hang up / ECONNRESET 等）的重试次数（仅此类失败重试，timeout/HTTP 不重试） */
const FETCH_RETRY_ON_CONN_ERROR = 1;
/** 连接级重试前的退避基数（毫秒，第 n 次重试退避 n×该值） */
const FETCH_RETRY_BACKOFF_MS = 300;
/** 免费档「今日情报」条数上限：零 LLM 成本，纯公开 RSS 原始条目（订阅档为 5 条 + LLM 提炼分组） */
const FREE_INTEL_ITEMS_LIMIT = 3;
/** 情报条目正文长度上限（服务端按码点截断，与前端 INTEL_ITEM_TEXT_MAX 语义一致） */
const INTEL_ITEM_TEXT_MAX = 80;

/**
 * RSS 源清单（公开授权源；name 为来源标注，合规要求必须展示，不转载正文只出摘要）。
 *
 * ⚠️ 维护须知（2026-09 实测校准）：
 *  · 全部为 https，全部经 fetchText()（https.get + utf8）实跑验证可解析；
 *  · 类目覆盖：科技 / AI / 商业 / 财经 / 社会 / 时事 / 数字生活 / 游戏 / 汽车 / 消费 / 教育 / 开发者；
 *  · 已淘汰的死源（勿再添加）：36氪（返回 HTML 非 RSS，静默 0 条）、虎嗅与澎湃镜像 feedx.net（10s 超时）、
 *    人民网（源冻结于 2025-06）、新华网（无 pubDate，内容停留 2022 年）、RSSHub 公共实例（超时）。
 *  · 新增源必须「能解析出带 pubDate 的条目」，否则会被下方 fetchOneSource() 健康检查判为 empty/undated/stale 并排除。
 *
 * ⚠️ 2026-09-28 多元化扩源实测记录（方法论见 .tools/vet-feeds.js + .tools/discover-feeds.js）：
 *  · 先对 70 个候选站点做 RSS autodiscovery，仅 14 个（20%）存在 feed —— 中文垂直媒体已大面积下线 RSS，
 *    因此「多元化」不能只靠加 RSS 源，必须同时扩热榜板块（见 .tools/static-server.js 的 hotBoard 注册处）。
 *  · 本轮淘汰（勿回填）：
 *      时光网      https://feed.mtime.com/comment.rss      源已死（连接失败）
 *      环球科学     https://www.huanqiukexue.com/?feed=rss2 半月更，最新 12.7 天前 → 整源被 7 天闸门丢弃
 *      SegmentFault https://segmentfault.com/feeds/questions 纯 Atom（只有 <entry>），预览侧 parseRss 恒 0 条
 *     阮一峰博客   https://feeds.feedburner.com/ruanyifeng  第三方镜像 + 超时（合规与稳定性双不合）
 *      爱搞机      https://www.igao7.com/feed              边缘：最新 3.7 天、存活 6/10，有踩闸门风险
 *      异次元软件   https://feed.iplaysoft.com/              边缘：最新 3.4 天、存活 5/10
 *  · 首页可达但**完全没有 feed**（不要再试）：果壳、丁香园、虎扑、懂球帝、新浪体育、网易体育、直播吧、
 *    下厨房、马蜂窝、穷游、自然之友、中国环境报、健康时报、生命时报、科学网、科普中国、雅昌艺术网、
 *    单向街、理想国、三联生活周刊、新周刊、读库、上海译文、译林、后浪、磨铁、界面新闻、深焦、壹心理、
 *    健康界、医学界、开源中国、中国教育报、中国国家地理、42号车库、盖世汽车、数字尾巴、品玩。
 *  · 需签名/反爬拒绝（403，不要再试）：酷安 api.coolapk.com。
 */
const RSS_SOURCES = [
  // [audit] 生活/数字生活 · 时政占比 ≈0% · 保留，低风险
  { name: '少数派', url: 'https://sspai.com/feed', tag: '数字生活' },
  // [audit] 科技 · ≈0% · 保留，低风险
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', tag: '科技' },
  // [audit] 科技 · 时政占比低（<5%，偶涉行业政策/监管新闻） · 保留，观察
  { name: 'IT之家', url: 'https://www.ithome.com/rss', tag: '科技' },
  // [audit] 科技 · 低（<5%） · 保留，低风险
  { name: '极客公园', url: 'https://www.geekpark.net/rss', tag: '科技' },
  // [audit] 科技/AI · ≈0% · 保留，低风险
  { name: '量子位', url: 'https://www.qbitai.com/feed', tag: 'AI' },
  // [audit] 财经/商业 · 低-中（10%~20%，宏观政策解读） · 观察保留；AI 精选层可对「政策解读」类降权
  { name: '钛媒体', url: 'https://www.tmtpost.com/rss', tag: '商业' },
  // [audit] 财经 · 中（20%~40%，财经政策/宏观调控） · 观察保留；标题含领导人/会议表述的条目建议 AI 精选层过滤
  { name: '经济观察报', url: 'https://www.eeo.com.cn/rss.xml', tag: '财经' },
  // [audit] 财经（国家通讯社背景） · 中-高（30%~50%，常混杂时政表述） · 建议降权或替换为市场化财经源（PM 决策）
  { name: '中新网-财经', url: 'https://www.chinanews.com.cn/rss/finance.xml', tag: '财经' },
  // [audit] 社会/时政 · 高（>50%，社会新闻大量涉突发事件报道） · 建议移除或降权（突发事件报道为许可红线，PM 决策）
  { name: '中新网-社会', url: 'https://www.chinanews.com.cn/rss/society.xml', tag: '社会' },
  // [audit] 时政 · 高（>70%，滚动时事） · 建议移除或降权（典型时政源，PM 决策）
  { name: '中新网-即时', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', tag: '时事' },

  // ↓↓↓ 2026-09-28 多元化扩源（全部经 .tools/vet-feeds.js 四层尽调 + 云函数侧兼容性实测通过）↓↓↓
  // [audit] 游戏 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.02 天）
  { name: '机核', url: 'https://www.gcores.com/rss', tag: '游戏' },
  // [audit] 汽车/新能源 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.08 天）
  { name: '车东西', url: 'https://chedongxi.com/rss', tag: '汽车' },
  // [audit] 消费/导购 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.0 天）
  { name: '什么值得买', url: 'https://post.smzdm.com/feed', tag: '消费' },
  // [audit] 教育/职教 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.1 天）
  { name: '芥末堆', url: 'https://www.jiemodui.com/feed', tag: '教育' },
  // [audit] 开发者/企业技术 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.0 天）
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', tag: '开发者' },
  // [audit] 开发者/技术社区 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.0 天）
  { name: '掘金', url: 'https://juejin.cn/rss', tag: '开发者' },
  // [audit] 数字生活/软件工具 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.2 天）
  { name: '小众软件', url: 'https://www.appinn.com/feed/', tag: '数字生活' }
];

/* ---------------- 网络与解析工具 ---------------- */

/** https GET 文本（支持一次以上重定向），非 2xx / 超时 reject */
function fetchText(url, headers = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 2) return reject(new Error('too many redirects: ' + url));
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 MorningBriefing/1.0',
          'Accept-Encoding': 'identity',
          ...headers
        },
        timeout: FETCH_TIMEOUT_MS
      },
      (res) => {
        // 重定向跟随（部分 RSS 源会 301 到 www / https 变体）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, url).href, headers, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve(raw));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
  });
}

/** 取标签内文本（兼容 CDATA） */
function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** 取链接：RSS <link>text</link> 或 Atom <link href="..." /> */
function pickLink(block) {
  const plain = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (plain && plain[1].trim()) return plain[1].trim();
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return href ? href[1] : '';
}

/** 抽取条目真实配图：media:content / media:thumbnail / enclosure(image) / 正文首个 <img>；无则 undefined */
function pickImage(block) {
  const candidates = [
    (block.match(/<media:content[^>]*url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<enclosure[^>]*type=["'][^"']*image[^"']*["'][^>]*url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["'][^"']*image/i) || [])[1],
    (block.match(/<img[^>]*src=["'](https?:\/\/[^"']+)["']/i) || [])[1]
  ];
  const url = candidates.find(Boolean);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return url.replace(/&amp;/g, '&');
}

/** 去 HTML 标签与实体，压成单行摘要。
 *  顺序很重要：必须**先解实体再剥标签** —— 否则 `&lt;script&gt;` 会在剥标签之后被解码成 `<script>` 复活。
 *  标签正则要求 `<` 后紧跟可选 `/` 与字母，避免把纯文本比较符（`x < 3 && y > 2`）当标签吃掉。
 *  `&amp;` 最后解，避免 `&amp;lt;` 被二次解码成 `<`。 */
function stripHtml(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 短 hash：由链接生成稳定 id */
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  return h.toString(36);
}

/** 解析 RSS2.0 / Atom 文本 → 中间条目 [{ title, link, image, summary, ts }] */
function parseFeed(xml, sourceName, tag) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 12).map((b) => {
    const title = stripHtml(pickTag(b, 'title'));
    const link = pickLink(b);
    const image = pickImage(b);
    let summary = stripHtml(
      pickTag(b, 'description') || pickTag(b, 'summary') || pickTag(b, 'content')
    );
    // 部分源 description 以标题开头，去重避免摘要重复
    if (title && summary.startsWith(title)) summary = summary.slice(title.length).trim();
    const dateStr = pickTag(b, 'pubDate') || pickTag(b, 'updated') || pickTag(b, 'published');
    const ts = dateStr ? new Date(dateStr).getTime() : 0;
    return { title, link, image, summary: summary.slice(0, 120), ts, sourceName, tag };
  });
}

/** 中间条目 → HotspotNews 输出形状（source 必填，合规标注来源） */
function toNews(it) {
  return {
    id: `web-${shortHash(it.link || it.title || it.sourceName)}`,
    title: it.title,
    summary: it.summary,
    source: it.sourceName,
    url: it.link || undefined,
    image: it.image || undefined,
    tags: it.tag ? [it.tag] : [],
    createTime: it.ts ? new Date(it.ts).toISOString() : new Date().toISOString()
  };
}

/* ---------------- F29 全网资讯搜索（Bing News RSS 主通道 + LLM 联网兜底） ---------------- */

/** LLM 联网搜索兜底（通义 DashScope enable_search，需 LLM_WEB_API_KEY）；未配置/失败返回 [] */
async function searchNewsByLLM(keyword) {
  const apiKey = process.env.LLM_WEB_API_KEY;
  if (!apiKey) return [];
  const base = process.env.LLM_WEB_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = process.env.LLM_WEB_MODEL || 'qwen-plus';
  const body = JSON.stringify({
    model,
    temperature: 0.4,
    enable_search: true, // 通义 Qwen OpenAI 兼容模式开启联网检索
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是新闻检索助手。基于联网搜索结果查找与关键词相关的近期新闻，输出 JSON：{"items":[{"title":"标题","summary":"一句话摘要(60字内)","source":"媒体名","url":"原文链接，没有则空字符串"}]}，最多 6 条，禁止编造来源和链接。'
      },
      { role: 'user', content: `今天是 ${new Date().toISOString().slice(0, 10)}。关键词：${keyword}` }
    ]
  });
  try {
    const endpoint = new URL('/chat/completions', base);
    const raw = await new Promise((resolve, reject) => {
      const req = https.request(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 20000
        },
        (res) => {
          let resp = '';
          res.on('data', (chunk) => (resp += chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(resp);
              if (res.statusCode !== 200) return reject(new Error(`LLM ${res.statusCode}`));
              resolve(data.choices[0].message.content);
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('LLM search timeout')));
      req.write(body);
      req.end();
    });
    const parsed = safeParse(raw);
    const list = (parsed && parsed.items) || (Array.isArray(parsed) ? parsed : []);
    return list
      .filter((it) => it && it.title)
      .slice(0, 10)
      .map((it, i) => ({
        id: `llm-${shortHash(`${it.url || ''}${it.title}${i}`)}`,
        title: String(it.title).slice(0, 80),
        summary: String(it.summary || '').slice(0, 120),
        source: String(it.source || '网络资讯').slice(0, 20),
        url: it.url || undefined,
        image: undefined,
        tags: ['搜索'],
        createTime: new Date().toISOString()
      }));
  } catch (err) {
    console.warn('[webSearch] searchNews llm failed:', err && err.message);
    return [];
  }
}

/** 全网新闻检索瀑布：① Bing News RSS（免费直连）→ ② LLM 联网兜底；全部失败返回 []，不阻塞 */
async function searchNewsOnline(keyword) {
  const kw = String(keyword || '').trim().slice(0, 30);
  if (!kw) return [];
  const url = `https://cn.bing.com/news/search?q=${encodeURIComponent(kw)}&format=RSS&setmkt=zh-CN`;
  try {
    const xml = await fetchText(url);
    const items = parseFeed(xml, '必应新闻', '搜索').filter((it) => it.title);
    if (items.length) return items.slice(0, 10).map(toNews);
  } catch (err) {
    console.warn('[webSearch] searchNews bing failed:', err && err.message);
  }
  return searchNewsByLLM(kw);
}

/* ---------------- 源健康检查 + 新鲜度守卫 + 配额选取 ---------------- */

/** 从 fetchText 抛出的错误里归类失败原因（timeout / http-4xx / http-5xx / fetch-error） */
function classifyFetchError(err) {
  const msg = String((err && err.message) || err || '');
  if (/timeout/i.test(msg)) return 'timeout';
  if (/HTTP 4\d\d/.test(msg)) return 'http-4xx';
  if (/HTTP 5\d\d/.test(msg)) return 'http-5xx';
  return 'fetch-error';
}

/** 简易 sleep（毫秒），仅用于连接级重试的短退避 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 抓取单个源并做健康评估（**不抛错**，失败也在 health 里如实记录）。
 *
 * 返回 `{ health, items }`：
 *  · health = { name, tag, ok, items, reason, newest, ageDays?, error?, retried? }
 *  · items 仅在该源判定为健康时非空（异常源一律给 []，即「整源排除」）。
 *
 * 重试策略：**仅对连接级瞬时失败（reason=fetch-error，如 socket hang up / ECONNRESET）重试一次**。
 * 不对 timeout 重试（代价 2×FETCH_TIMEOUT_MS，会拖慢整个 allSettled）、
 * 不对 HTTP 4xx/5xx 重试（重试无意义）。重试过则 health.retried=true，便于区分「首抓即成功」与「重试才成功」。
 *
 * reason 取值：
 *  · ok                —— 健康，采纳
 *  · timeout/http-4xx/http-5xx/fetch-error —— 网络层失败
 *  · empty             —— HTTP 200 但解析出 0 条（如源改版）
 *  · http-200-non-rss  —— HTTP 200 但正文根本不是 feed（如 36氪 返回 HTML 落地页）
 *  · undated           —— 有条目但全部无 pubDate，无法判定新鲜度（默认排除，不盲目采信）
 *  · stale             —— 最新条目早于 STALE_SOURCE_DAYS 天（冻结源，整源排除）
 *  · parse-error       —— 解析阶段异常
 *  · crash             —— Promise 意外 reject（兜底）
 */
async function fetchOneSource(src) {
  const health = { name: src.name, tag: src.tag, ok: false, items: 0, reason: 'unknown' };
  let xml;
  let attempt = 0;
  for (;;) {
    try {
      xml = await fetchText(src.url);
      break;
    } catch (err) {
      const reason = classifyFetchError(err);
      health.reason = reason;
      health.error = String((err && err.message) || err);
      // 连接被重置等「快失败」重试一次；timeout / HTTP 错误不重试
      if (reason === 'fetch-error' && attempt < FETCH_RETRY_ON_CONN_ERROR) {
        attempt += 1;
        health.retried = true;
        console.warn(`[webSearch] source conn-error, retry #${attempt}: ${src.name} err=${health.error}`);
        await sleep(FETCH_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return { health, items: [] };
    }
  }
  let parsed;
  try {
    parsed = parseFeed(xml, src.name, src.tag);
  } catch (err) {
    health.reason = 'parse-error';
    health.error = String((err && err.message) || err);
    return { health, items: [] };
  }
  // 只认「有标题」的条目（无标题无法展示，也无来源标注价值）
  const items = parsed.filter((it) => it.title);
  health.items = items.length;
  if (items.length === 0) {
    // 关键修复：区分「是 feed 但空了」与「HTTP 200 但压根不是 feed」——两者都曾长期静默
    health.reason = /<item[\s>]|<entry[\s>]|<channel[\s>]|<feed[\s>]/i.test(xml) ? 'empty' : 'http-200-non-rss';
    return { health, items: [] };
  }
  // 新鲜度守卫：以「最新条目时间」为准（条数多不代表内容新）
  const dated = items.map((it) => it.ts).filter((t) => t > 0);
  if (!dated.length) {
    health.reason = 'undated';
    return { health, items: [] };
  }
  const newest = Math.max(...dated);
  health.newest = new Date(newest).toISOString();
  health.ageDays = Math.round(((Date.now() - newest) / 86400000) * 100) / 100;
  if (health.ageDays > STALE_SOURCE_DAYS) {
    health.reason = 'stale';
    return { health, items: [] };
  }
  health.ok = true;
  health.reason = 'ok';
  return { health, items };
}

/**
 * 配额选取：先把「广度」坐实，再谈「时效」。
 *
 *  · 保底轮：每个健康源各取 1 条（各自最新条目），使冷门源不被高频源挤没；
 *  · 补足轮：剩余条目全局按时间倒序补齐到 total，任一源不超过 perSourceMax；
 *  · 展示顺序：最终整表按时间倒序（最新在前）。
 *
 * @param {Array} items 已合并的中间条目（仅来自健康源）
 * @param {number} total 目标条数
 * @param {number} perSourceMax 单源上限
 */
function selectWithQuota(items, total, perSourceMax) {
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.sourceName)) bySource.set(it.sourceName, []);
    bySource.get(it.sourceName).push(it);
  }
  // 每源内部按时间倒序（无时间条 ts=0 排末尾）
  for (const list of bySource.values()) list.sort((a, b) => b.ts - a.ts);

  const picked = [];
  const pickedCount = new Map();
  // 保底轮：源按「自身最新条目时间」倒序，最新的源先占位（源数 > total 时只保底前 total 个）
  const order = [...bySource.entries()].sort((a, b) => (b[1][0] ? b[1][0].ts : 0) - (a[1][0] ? a[1][0].ts : 0));
  for (const [name, list] of order) {
    if (picked.length >= total) break;
    picked.push(list[0]);
    pickedCount.set(name, 1);
  }
  // 补足轮：剩余条目全局倒序，尊重单源上限
  const rest = [];
  for (const [name, list] of bySource) {
    for (let i = pickedCount.get(name) || 0; i < list.length; i++) rest.push(list[i]);
  }
  rest.sort((a, b) => b.ts - a.ts);
  for (const it of rest) {
    if (picked.length >= total) break;
    const used = pickedCount.get(it.sourceName) || 0;
    if (used >= perSourceMax) continue;
    picked.push(it);
    pickedCount.set(it.sourceName, used + 1);
  }
  // 展示顺序：整表按时间倒序
  return picked.slice(0, total).sort((a, b) => b.ts - a.ts);
}

/**
 * 并发抓取全部源（单源失败不影响整体），做健康检查 + 新鲜度守卫 + 配额选取。
 *
 * 返回 `{ items, sourceHealth }`：
 *  · items        —— HotspotNews[]（供热点页/briefing 使用）
 *  · sourceHealth —— [{name, ok, items, reason, ...}]，源健康快照，供排查「哪个源又烂了」
 *
 * 向后兼容：旧调用方若只关心数组，可解构 `{ items }`；异常源逐条 console.warn（含源名 + 原因分类）。
 */
async function fetchAllSources() {
  const results = await Promise.allSettled(RSS_SOURCES.map((src) => fetchOneSource(src)));
  const sourceHealth = [];
  const allItems = [];
  results.forEach((r, i) => {
    const src = RSS_SOURCES[i];
    if (r.status === 'fulfilled') {
      sourceHealth.push(r.value.health);
      allItems.push(...r.value.items);
    } else {
      sourceHealth.push({
        name: src.name,
        tag: src.tag,
        ok: false,
        items: 0,
        reason: 'crash',
        error: String((r.reason && r.reason.message) || r.reason)
      });
    }
  });
  // 关键修复：异常源必须「有声」，不再像 36氪 那样静默 0 条
  for (const h of sourceHealth) {
    if (h.ok) continue;
    const detail = [
      `source=${h.name}`,
      `reason=${h.reason}`,
      h.newest ? `newest=${h.newest} ageDays=${h.ageDays}` : '',
      h.error ? `err=${h.error}` : ''
    ]
      .filter(Boolean)
      .join(' ');
    console.warn(`[webSearch] source unhealthy: ${detail}`);
  }
  const items = selectWithQuota(allItems, HOTSPOT_ITEMS_LIMIT, MAX_ITEMS_PER_SOURCE).map(toNews);
  return { items, sourceHealth };
}

/* ---------------- hotspot：热点页资讯流 ---------------- */

/** 热点缓存的固定文档 _id：并发冷缓存下多个调用 upsert 到同一条，而不是各自 .add() 出重复孤儿文档 */
const HOTSPOT_CACHE_ID = 'hotspot';

async function readHotspotCache() {
  try {
    // ① 固定 _id 优先（新写入格式）
    const byId = await db.collection('hotspotCache').doc(HOTSPOT_CACHE_ID).get();
    if (byId && byId.data) return byId.data;
  } catch (err) {
    // 文档/集合不存在 → 走下面的回退
  }
  try {
    // ② 回退：兼容历史自动 _id 文档；orderBy 保证读到最新的一条而非任意一条
    const res = await db
      .collection('hotspotCache')
      .where({ key: 'hotspot' })
      .orderBy('updateTime', 'desc')
      .limit(1)
      .get();
    return res.data[0] || null;
  } catch (err) {
    // 集合不存在等场景按无缓存处理
    return null;
  }
}

/** 写缓存：固定 _id + set = 幂等 upsert（并发下最后一次写胜出，不产生重复文档） */
async function writeHotspotCache(items, sourceHealth) {
  try {
    const data = {
      key: 'hotspot',
      items,
      sourceHealth: sourceHealth || [],
      updateTime: new Date().toISOString()
    };
    await db.collection('hotspotCache').doc(HOTSPOT_CACHE_ID).set({ data });
  } catch (err) {
    console.warn('[webSearch] writeHotspotCache failed:', err && err.message);
  }
}

async function getHotspotNews() {
  const cache = await readHotspotCache();
  if (cache && cache.updateTime && Date.now() - new Date(cache.updateTime).getTime() < HOTSPOT_CACHE_MS) {
    return { items: cache.items || [], sourceHealth: cache.sourceHealth || [], fromCache: true };
  }
  const { items, sourceHealth } = await fetchAllSources(); // allSettled，不会 throw
  if (items.length > 0) {
    await writeHotspotCache(items, sourceHealth);
    return { items, sourceHealth, fromCache: false };
  }
  // 全源抓取失败：有旧缓存就降级用旧的（不阻塞前端）
  if (cache && cache.items && cache.items.length > 0) {
    return { items: cache.items, sourceHealth: cache.sourceHealth || [], fromCache: true, degraded: true };
  }
  throw new Error('所有 RSS 源抓取失败');
}

/* ---------------- briefing：今日情报（免费档原始 3 条 / 订阅档 LLM 提炼 3-5 条 + 分组） ---------------- */

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get();
  return res.data[0] || null;
}

function isSubscribed(user) {
  return !!(user && user.subscribed && user.expiredAt && new Date(user.expiredAt) > new Date());
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE');
}

/** 月度 usage 文档（与 chat/getUsage 同一集合约定）。
 *  配额读写失败一律「放行」：宁可失去限额保护，也不能让整包情报（新闻+天气+LLM 都正常）因
 *  一次 usage 写失败而整体返回 code:-1 —— 这与文件头「每一步失败均降级，绝不阻塞调用方」一致。
 *  降级态返回的文档**无 _id**，下游 consumeIntelQuota 依此跳过写入。 */
async function getUsageDoc(openid) {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  let res;
  try {
    res = await db.collection('usage').where({ openid, month }).limit(1).get();
  } catch (err) {
    console.warn('[webSearch] usage read failed, quota disabled:', err && err.message);
    return { openid, month, voiceUsed: 0 }; // 无 _id：标记「不可写」
  }
  if (res.data.length > 0) return res.data[0];
  const doc = { openid, month, voiceUsed: 0, updatedAt: new Date().toISOString() };
  try {
    const added = await db.collection('usage').add({ data: doc });
    return { _id: added._id, ...doc };
  } catch (err) {
    // usage 写失败不应让整包情报失败：降级为内存态文档（无 _id），配额检查放行、不消耗
    console.warn('[webSearch] usage create failed, quota disabled:', err && err.message);
    return doc;
  }
}

/** 检查今日情报限额（日 10 次）；返回 { allowed, limited }，不消耗额度（只有真调 LLM 才计费） */
async function checkIntelQuota(openid) {
  const usage = await getUsageDoc(openid);
  const used = usage.intelDate === todayStr() ? usage.intelUsed || 0 : 0;
  return { allowed: used < INTEL_DAILY_LIMIT, limited: used >= INTEL_DAILY_LIMIT, usage };
}

/** 消耗一次今日情报额度。配额不可写（降级态，无 _id）时直接跳过，不阻塞也不抛错 */
async function consumeIntelQuota(usage) {
  if (!usage || !usage._id) return;
  const today = todayStr();
  const intelUsed = usage.intelDate === today ? (usage.intelUsed || 0) + 1 : 1;
  await db
    .collection('usage')
    .doc(usage._id)
    .update({ data: { intelUsed, intelDate: today, updatedAt: new Date().toISOString() } });
}

/** 和风天气现况（免费档）；未配 KEY 或失败返回 null，不阻塞。
 *  F21：传入 tripCity 时改查目的地天气（和风 location 支持中文城市名），失败回退默认位置。 */
async function getWeather(tripCity) {
  const key = process.env.WEATHER_KEY;
  if (!key) return null;
  const loc = tripCity
    ? encodeURIComponent(String(tripCity).slice(0, 12))
    : process.env.WEATHER_LOCATION || '116.41,39.92';
  try {
    const raw = await fetchText(
      `https://devapi.qweather.com/v7/weather/now?location=${loc}`,
      { 'X-QW-Api-Key': key }
    );
    const data = JSON.parse(raw);
    if (data.code !== '200' || !data.now) {
      console.warn('[webSearch] weather bad response:', data.code);
      return null;
    }
    const n = data.now;
    const wind = n.windDir ? `，${n.windDir}${n.windScale || ''}级` : '';
    const prefix = tripCity ? `目的地${tripCity}：` : '';
    return { text: `${prefix}${n.text} ${n.temp}°C${wind}`, updateTime: new Date().toISOString() };
  } catch (err) {
    console.warn('[webSearch] weather failed:', err && err.message);
    return null;
  }
}

/** 按用户偏好关键词把资讯前置（无偏好保持原序） */
function rankByPreferences(items, prefs) {
  const keywords = Array.isArray(prefs) ? prefs.filter((k) => typeof k === 'string' && k) : [];
  if (!keywords.length) return items;
  return items
    .map((it) => ({
      it,
      hit: keywords.filter((k) => `${it.title} ${it.summary}`.includes(k)).length
    }))
    .sort((a, b) => b.hit - a.hit)
    .map((s) => s.it);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        /* fallthrough */
      }
    }
    return null;
  }
}

/** 情报分组：组数上限（与前端 intelGroups.INTEL_GROUP_MAX 对齐，兜底防脏数据） */
const INTEL_GROUP_MAX = 4;
/** 单组条目数上限（与前端对齐） */
const INTEL_GROUP_ITEMS_MAX = 6;
/** 组标题长度上限 */
const INTEL_GROUP_TITLE_MAX = 12;
/** 导语长度上限 */
const INTEL_LEAD_MAX = 60;

/** 校验并收敛 LLM 返回的分组（不抛错；不合规则返回 []，由前端降级兜底） */
function normalizeLlmGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const groups = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const items = Array.isArray(g.items)
      ? g.items
          .filter((it) => it && it.text)
          .slice(0, INTEL_GROUP_ITEMS_MAX)
          .map((it) => ({ text: clampByCodePoint(it.text, INTEL_ITEM_TEXT_MAX), source: String(it.source || '综合').slice(0, 20) }))
      : [];
    if (!items.length) continue;
    const lead = String(g.lead || '').slice(0, INTEL_LEAD_MAX).trim();
    if (!lead) continue;
    const title = String(g.title || '').slice(0, INTEL_GROUP_TITLE_MAX).trim() || '综合资讯';
    groups.push({ title, lead, items });
    if (groups.length >= INTEL_GROUP_MAX) break;
  }
  return groups;
}

/**
 * LLM 摘要（DeepSeek，与 chat 云函数同约定）；失败 throw 由上层降级。
 *
 * v2.2（增量 2）：prompt 升级为「一次产出分组结构」——在既有 intelItems 基础上**新增 groups**，
 * **不新增 LLM 调用次数**（同一通道、同一请求，只是把「3-5 条短句」升级为「2-4 组，每组导语+条目」）。
 * 返回 `{ items, groups }`：`items` 为既有平铺口径（向后兼容），`groups` 为分组（可能为空）。
 */
async function summarize(weather, newsItems) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY not configured');
  const base = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.LLM_MODEL || 'deepseek-chat';
  const material = [
    weather ? `[天气] ${weather.text}` : '',
    ...newsItems.slice(0, 8).map((n, i) => `[${i + 1}][${n.source}] ${n.title}：${n.summary}`)
  ]
    .filter(Boolean)
    .join('\n');
  const payload = JSON.stringify({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是私人晨报编辑。基于给定天气与资讯素材，输出两样东西：' +
          '① items：3-5 条「今日情报」短句，每条 ≤40 字，说清事件与对用户的实际影响或建议，source 标注该条来源媒体名（必须来自素材）；' +
          '② groups：2-4 个主题分组，每组含 title（主题名，≤12 字）、lead（1-2 句导语，≤60 字，说明该主题下的整体态势）、' +
          'items（该组下的资讯条目，每条含 text ≤40 字与 source）。' +
          '导语 lead 中如需引用本组条目，必须用 [n] 标记（n 为本组 items 的 1-based 序号，如 [1]、[2]），不得引用不存在的序号。' +
          '输出 JSON：{"items":[{"text":"...","source":"来源名"}],"groups":[{"title":"...","lead":"...","items":[{"text":"...","source":"来源名"}]}]}。' +
          '不得编造素材里没有的信息。'
      },
      { role: 'user', content: material }
    ]
  });
  const content = await new Promise((resolve, reject) => {
    const endpoint = new URL('/chat/completions', base);
    const req = https.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 25000
      },
      (res) => {
        let resp = '';
        res.on('data', (chunk) => (resp += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(resp);
            if (res.statusCode !== 200) return reject(new Error(`LLM ${res.statusCode}: ${resp.slice(0, 200)}`));
            resolve(data.choices[0].message.content);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('LLM request timeout')));
    req.write(payload);
    req.end();
  });
  const parsed = safeParse(content);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('LLM output invalid');
  const items = parsed.items
    .filter((it) => it && it.text)
    .slice(0, 5)
    .map((it) => ({ text: clampByCodePoint(it.text, INTEL_ITEM_TEXT_MAX), source: String(it.source || '综合') }));
  if (!items.length) throw new Error('LLM output empty');
  // 分组为**可选增强**：LLM 未按结构返回时降级为 []（前端会走本地兜底），不影响 intelItems 主链路
  const groups = normalizeLlmGroups(parsed.groups);
  return { items, groups };
}

/** 按 Unicode 码点截断，避免切断 emoji 代理对产生乱码（`slice` 按 UTF-16 码元，会切坏代理对） */
function clampByCodePoint(s, max) {
  const chars = Array.from(String(s == null ? '' : s));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** 降级：LLM 不可用时直接用原始资讯（标注来源，不编造）。
 *  limit 默认 5（订阅档 LLM 降级路径），免费档显式传 FREE_INTEL_ITEMS_LIMIT=3。 */
function fallbackIntel(newsItems, limit = 5) {
  return (Array.isArray(newsItems) ? newsItems : []).slice(0, limit).map((n) => ({
    text: clampByCodePoint(`${n.title}${n.summary ? '：' + n.summary : ''}`, INTEL_ITEM_TEXT_MAX),
    source: n.source
  }));
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const action = (event && event.action) || 'hotspot';
  try {
    if (action === 'hotspot') {
      const { items, sourceHealth } = await getHotspotNews();
      // data 保持既有形状（HotspotNews[]，前端按此渲染）；sourceHealth 为新增的可观测字段，前端会忽略
      return { code: 0, message: 'ok', data: items, sourceHealth };
    }

    if (action === 'searchNews') {
      // F29 全网搜索：Bing News RSS 按关键词全网检索，结果带来源标注（合规）
      const kw = String((event && event.keyword) || '').trim();
      if (!kw) return { code: -1, message: 'keyword required', data: null };
      const items = await searchNewsOnline(kw);
      return { code: 0, message: 'ok', data: items };
    }

    if (action === 'feedback') {
      // F22 资讯反馈：记录 👍/👎 到 newsFeedback 集合，数据驱动内容瘦身
      const ctx = cloud.getWXContext();
      const openid = ctx.OPENID || (event && event.openid) || '';
      if (!openid) return { code: -1, message: 'no openid', data: null };
      const newsId = String((event && event.id) || '').slice(0, 64);
      const value = (event && event.feedback) === 'up' ? 'up' : 'down';
      if (!newsId) return { code: -1, message: 'id required', data: null };
      try {
        await db.collection('newsFeedback').add({
          data: { openid, newsId, value, createdAt: new Date().toISOString() }
        });
        return { code: 0, message: 'ok', data: { id: newsId, feedback: value } };
      } catch (err) {
        console.warn('[webSearch] feedback write failed:', err && err.message);
        return { code: -1, message: 'feedback write failed', data: null };
      }
    }

    if (action === 'briefing') {
      // openid：优先取微信上下文（前端直接调用）；无上下文时允许服务端
      // （getBriefing 定时/聚合路径）显式传入——同环境云函数间调用无 OPENID
      const ctx = cloud.getWXContext();
      const openid = ctx.OPENID || (event && event.openid) || '';
      if (!openid) return { code: -1, message: 'no openid', data: null };

      const user = await getUser(openid);
      const subscribed = isSubscribed(user);

      // 天气与资讯免费；LLM 摘要才计费，故仅 LLM 前消耗额度
      // F21：getBriefing 传入 tripCity（次日外地行程）时切目的地天气
      const tripCity = (event && event.tripCity) || undefined;
      const weather = await getWeather(tripCity);

      // 资讯统一走 getHotspotNews()：数据库共享缓存（hotspotCache，TTL 1 小时，全用户共用），
      // 避免每个用户每天首次打开都重新抓 10 个源；代价是情报最多滞后 1 小时
      // （与热点页同源，可接受）。抓取全失败时它 throw，这里降级为空资讯，不阻塞情报返回。
      let news = [];
      let newsFromCache = false;
      try {
        const pooled = await getHotspotNews();
        news = Array.isArray(pooled.items) ? pooled.items : [];
        newsFromCache = !!pooled.fromCache;
      } catch (err) {
        console.warn('[webSearch] briefing news unavailable:', err && err.message);
      }
      const ranked = rankByPreferences(news, user && user.preferences);

      if (!subscribed) {
        // 免费档：零 LLM 成本。公开 RSS 原始条目 + 天气，不做 AI 提炼；
        // groups 留空 → 前端 resolveIntelGroups() 走 groupIntelLocally 本地兜底分组，
        // degraded:true → 前端挂「资讯来自公开 RSS…（AI 提炼暂不可用）」标识。
        const intelItems = fallbackIntel(ranked, FREE_INTEL_ITEMS_LIMIT);
        console.log(
          `[webSearch] briefing tier=free items=${intelItems.length} weather=${!!weather} fromCache=${newsFromCache}`
        );
        return {
          code: 0,
          message: 'ok',
          data: { subscribed: false, limited: false, weather, intelItems, groups: [], degraded: true }
        };
      }

      if (news.length === 0 && !weather) {
        return {
          code: 0,
          message: 'ok',
          data: { subscribed: true, limited: false, weather: null, intelItems: [], groups: [], degraded: true }
        };
      }
      const quota = await checkIntelQuota(openid);
      let intelItems = [];
      // v2.2：groups 为可选增强字段；降级/限额路径下为 []，前端会走本地兜底分组
      let groups = [];
      let degraded = true;
      if (quota.limited) {
        intelItems = fallbackIntel(ranked);
        console.log(
          `[webSearch] briefing tier=pro limited=true items=${intelItems.length} fromCache=${newsFromCache}`
        );
      } else {
        try {
          const summarized = await summarize(weather, ranked);
          intelItems = summarized.items;
          groups = summarized.groups;
          degraded = false;
        } catch (err) {
          console.warn('[webSearch] summarize degraded:', err && err.message);
          intelItems = fallbackIntel(ranked);
        }
        await consumeIntelQuota(quota.usage).catch((err) =>
          console.warn('[webSearch] consume quota failed:', err && err.message)
        );
      }
      // intelItems 保留（向后兼容旧前端/旧缓存）；groups 新增（分组 + 导语 + 内联引用）
      return {
        code: 0,
        message: 'ok',
        data: { subscribed: true, limited: quota.limited, weather, intelItems, groups, degraded }
      };
    }

    return { code: -1, message: 'unknown action: ' + action, data: null };
  } catch (err) {
    console.error('[webSearch] failed:', err && err.message);
    return { code: -1, message: String((err && err.message) || 'error'), data: null };
  }
};

/* ---------------- 导出（常量 + 内部工具，供运维/自测引用；不影响云函数 main 契约） ---------------- */

exports.HOTSPOT_ITEMS_LIMIT = HOTSPOT_ITEMS_LIMIT;
exports.MAX_ITEMS_PER_SOURCE = MAX_ITEMS_PER_SOURCE;
exports.STALE_SOURCE_DAYS = STALE_SOURCE_DAYS;
exports.FETCH_RETRY_ON_CONN_ERROR = FETCH_RETRY_ON_CONN_ERROR;
exports.FETCH_RETRY_BACKOFF_MS = FETCH_RETRY_BACKOFF_MS;
exports.FREE_INTEL_ITEMS_LIMIT = FREE_INTEL_ITEMS_LIMIT;
exports.INTEL_ITEM_TEXT_MAX = INTEL_ITEM_TEXT_MAX;
exports.RSS_SOURCES = RSS_SOURCES;
exports.__internals = { fetchText, parseFeed, toNews, fetchOneSource, selectWithQuota, fetchAllSources, getHotspotNews, fallbackIntel, rankByPreferences, clampByCodePoint };
