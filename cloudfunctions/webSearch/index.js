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
  // ⚠️ 极客公园（https://www.geekpark.net/rss）已于 2026-09-28 **移出 RSS 清单**：
  //    实测响应体 540–595KB（内嵌全文），单次耗时 8.6s / 16.3s / 20.0s —— 稳定超过本函数的
  //    FETCH_TIMEOUT_MS=6000 与预览侧的 8000ms，等于「挂着但取不到数」还会占用一次超时预算。
  //    预览侧热点链路已改走 DailyHotApi 的 /geekpark 板块（其上游是 mainssl.geekpark.net/api/v2
  //    的 JSON 接口，实测 2173ms / 20 条），见 .tools/static-server.js 的 hotBoard 注册处。
  //    若要在此恢复该源，必须先确认它能在 6s 内返回，否则不要回填。
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

/* ---------------- 情报内容信任过滤 ---------------- */

/**
 * 为什么需要（2026-10-08）：本文件把第三方 RSS 的 `title`/`summary` **原样**拼进
 * 今日情报（`fallbackIntel`），中间没有任何内容信任检查。RSS 是开放投稿/可被投毒的面，
 * 一条被写入指令的条目会同时污染三条出口：免费档、订阅档降级档、以及**喂给 LLM 的
 * `ranked`**（`summarize(weather, ranked)`）。所以过滤点必须在
 * `fetchAllSources()` 的出口、入库进 `hotspotCache` **之前** —— 放晚一步，
 * 毒条目已经在缓存里，也已经进过 LLM 的 prompt。
 *
 * 设计取舍：**只打高置信度信号，不做关键词黑名单**。
 * 语料里有「什么值得买」这类优惠源，天天出现 限时/好价/券/直降；按营销词过滤会
 * 每天误杀正常条目，而新闻产品的假阳性比被投毒更难被用户原谅。故规则只覆盖
 * ① 指令注入 ② 站点被篡改签名 ③ 可执行内容残留 ④ 混淆字符 ⑤ 乱码洪水。
 *
 * 失败模式：**规则过宽会把整站新闻清空**，那本身就是一次线上事故。
 * 故加 `NEWS_TRUST_MAX_DROP_RATIO` 护栏 —— 丢弃比例超阈值时**保留原列表并大声告警**，
 * 宁可漏放一条也不让产品空白；护栏触发会在日志里留下明确痕迹，便于当天修规则。
 *
 * ⚠️ 但护栏**不能无差别地作用于所有规则**：原实现对全量 `dropped` 生效，于是
 * 「唯一存活源被投毒」（`MAX_ITEMS_PER_SOURCE=3` → 列表塌缩成 3 条全毒 = 100% > 80%）
 * 会让护栏把毒条目**全部放行**，过滤被完全绕过（2026-10-08 实测复现）。
 * 因此规则按置信度分层（见 `NEWS_TRUST_HIGH_CONFIDENCE`）：
 * 高置信签名**永不 fail-open**，护栏只保护低精度启发式。
 */

/** 单条被判定为不可信时的丢弃比例上限；超过则判定「规则过宽」，回退放行。
 *  **只对低精度启发式（'zero-width' / 'mojibake'）生效**；高置信规则不受它影响。 */
const NEWS_TRUST_MAX_DROP_RATIO = 0.8;

/** 高置信规则：命中即**无条件丢弃**，护栏不得放行。
 *  这些签名在正常资讯里没有正当用途 —— 若被护栏放行，等于把攻击者内容
 *  （甚至直接进入 LLM prompt 的注入文本）交给用户：
 *   - 'defaced'：站点被篡改 / 黑产署名（`hacked by` / `被黑客攻破`）—— 标题写着 hacked by X 不可能是正常新闻；
 *   - 'active-content'：`<script>` / `javascript:` / `onerror=` 等可执行残留 —— 真新闻不需要；
 *   - 'inject'：指令注入（忽略以上指令 / `system prompt:` / 角色劫持）—— 这是针对下游 LLM 的
 *     prompt 注入，放过即把攻击文本喂进 LLM；其中 `\byou are now\b` 虽是弱特征，但它是标准角色劫持
 *     开场白，误判代价只是**单条**被丢（不是整站空白），远低于漏放注入的代价，故同样归高置信；
 *   - 'obfuscated'：bidi 覆写字符（U+202A–202E / U+2066–2069）在标题里没有正当用途；
 *   - 'empty'：无任何可判定文本的条目（确定性判定、非启发式，没有「正常空新闻」需要保护）。
 *  低精度启发式（'zero-width'、'mojibake'）**不在**此集合，仍受护栏保护。 */
const NEWS_TRUST_HIGH_CONFIDENCE = new Set(['empty', 'active-content', 'inject', 'defaced', 'obfuscated']);

/** 指令注入：针对下游消费者（LLM 或人）的越权话术。中英双语都要覆盖。
 *  ⚠️ 只匹配**自然形态**（一律用 `\s+`），且语义收紧到真正的注入习语：
 *   - `you are now …` 必须后接冠词（`a/an/the`）+ 词边界，否则 `nowhere / nowadays / now able` 会误杀；
 *   - `disregard …(above|previous|prior)…` 必须后接被抛弃的**对象**
 *     （instructions/prompts/rules/context/messages），否则 `previously / assumptions` 会误杀。
 *  早期版本为吃下「粘连形态」把分隔符放宽成 `\s*`，尾随 `\s*` 命中零个空白 → 上述正常措辞被误判注入。
 *  「粘连形态」（归一化后无分隔，如 `ignoreallpreviousinstructions`）改由下方**去分隔骨架**负责。 */
const NEWS_TRUST_INJECT_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior)\s+(?:instructions?|prompts?|rules?|context|messages?)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:system|developer)\s*(?:prompt|message)\s*[:：]/i,
  /忽略(?:掉)?(?:以上|上面|之前|前面)(?:的)?(?:所有)?(?:指令|内容|规则|设定)/,
  /(?:请|你)?(?:务必|必须)?不要(?:告诉|告知|告诉过)(?:用户|任何人)/,
  /你(?:现在)?(?:是|扮演)(?:一个|一名)?(?:新的)?(?:助手|ai|智能体)/i,
  /系统(?:提示|设定|指令)\s*[:：]/
];

/** 站点被篡改 / 黑产投放的署名特征（自然形态，用 `\s+`）。粘连形态由骨架匹配负责。 */
const NEWS_TRUST_DEFACED_PATTERNS = [/\bhacked\s+by\b/i, /\bdefaced\s+by\b/i, /\bpwned\s+by\b/i, /被\s*(?:黑|入)客\s*攻(?:破|陷)/];

/** `stripHtml` 漏掉的**可执行**内容残留：真新闻不需要 script:/onerror=。 */
const NEWS_TRUST_ACTIVE_CONTENT_PATTERNS = [/<script[\s>]/i, /javascript\s*:/i, /\bon(?:error|load|click)\s*=/i, /<iframe[\s>]/i];

/**
 * 判定前需**删除**的不可见/格式/组合字符。**按 Unicode 类别做，不再枚举码点**
 * （枚举必漏：U+00AD / U+2061–2064 / U+034F / U+3164 / U+180E … 都曾是绕过点）。
 *  · `\p{Cf}` 格式类：ZWSP(200B) / WJ(2060) / BOM(FEFF) / 双向控制(202A–202E, 2066–2069)
 *    / **软连字符 U+00AD** / **U+2061–2064**；
 *  · `\p{Cc}` 控制类：含 `\n`/`\t`/`\r` —— 顺带把 title/summary 跨字段拼接起来（`hac`+`ked by`）；
 *  · `\p{Mn}` / `\p{Me}`：组合/包围记号（如组合重音 U+0301）；
 *  · 另补上述类别覆盖不到的已知不可见字：U+034F CGJ、U+3164 韩文填充、
 *    U+115F/U+1160 谚文填充、U+FFA0 半角谚文填充、U+180E 蒙古文元音分隔符。
 *  归一化用**删除**而非替换为空格：删除后 `java\u00ADscript:`→`javascript:`、
 *  `忽略\u00AD以上`→`忽略以上` 直接命中既有正则；替换为空格反而会打断这些签名。 */
const NEWS_TRUST_INVISIBLE_RE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u034f\u3164\u115f\u1160\uffa0\u180e]/gu;

/** 去分隔骨架用：只保留字母/数字（含 CJK），删除一切分隔符/标点/空白 —— 用来匹配「粘连形态」。 */
const NEWS_TRUST_NON_SIGNIFICANT_RE = /[^\p{L}\p{N}]/gu;

/** 骨架签名（作用于 `glued`，已转小写）。正常资讯里没有这些串；
 *  `\b` 在粘连形态下失效（`hackedby` 的 `d`→`b` 之间无词边界），故这里用**去分隔子串**匹配。
 *  ⚠️ 不给 `you are now` 做骨架签名：`youarenow` 会命中正常短语 `you are nowhere / you are now at`。 */
const NEWS_TRUST_SKELETON_DEFACED_RE = /(?:hacked|defaced|pwned)by/;
const NEWS_TRUST_SKELETON_INJECT_RES = [
  /ignore(?:all)?(?:previous|prior|above|earlier)(?:instructions?|prompts?|rules?)/,
  /disregard(?:all)?(?:the)?(?:above|previous|prior)(?:instructions?|prompts?|rules?|context|messages?)/
];

/** 双向文字覆写/隔离控制符（U+202A–202E、U+2066–2069）：在中文/英文资讯标题里**没有任何正当用途**，
 *  正常排版不需要它们，出现即为藏字符 → 命中即拦，不设阈值。
 *  （曾把它和零宽字符合并成一个 >2 的阈值，被单测抓到漏判：单个 RLO…PDF 对就绕过去了。）
 *  ⚠️ 对**原始**文本判定：归一化会删除 bidi 字符，若对归一化文本判定将永不命中。 */
const NEWS_TRUST_BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/;

/** 零宽字符（U+200B–200D、U+2060、U+FEFF）：emoji 序列与部分 CJK 源**会正常产生**，
 *  故不能命中即拦，按数量阈值判定。
 *  ⚠️ 对**原始**文本计数：归一化会清空计数，若对归一化文本计数将永不判 zero-width。 */
const NEWS_TRUST_ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const NEWS_TRUST_ZERO_WIDTH_MAX = 2;

/** 非 CJK/非拉丁的异体文字洪水 + U+FFFD 替换字符：典型的乱码/伪装条目。 */
const NEWS_TRUST_MOJIBAKE_RE = /[\uFFFD\u0400-\u04FF\u0370-\u03FF]/g;
const NEWS_TRUST_MOJIBAKE_MAX = 3;

/** ⚠️ 本轮**明确不覆盖**的残余：**形近字同形攻击**（如西里尔 `а` U+0430 冒充拉丁 `a`，构造 `hаcked by`）。
 *  需要 confusables 映射表做字形归一化，本轮不做。缓解：同形文字**洪水**仍会被上面的 mojibake 规则拦下
 *  （> NEWS_TRUST_MOJIBAKE_MAX），但只夹 1 个同形字的短标题会漏过 —— 已知缺口，后续以映射表补齐。 */

/** 把一个条目里参与判定的文本拼起来（title/summary/tags）。 */
function newsTextOf(item) {
  const tags = Array.isArray(item && item.tags) ? item.tags.join(' ') : '';
  return [item && item.title, item && item.summary, tags].filter(Boolean).join('\n');
}

/**
 * 判定单条是否不可信。**返回命中的规则名**，便于日志定位；可信返回 null。
 * 纯函数、无副作用、可直接单测（见 exports.__internals）。
 */
function assessNewsItem(item) {
  const raw = newsTextOf(item);
  if (!raw.trim()) return 'empty';
  // 归一化（**仅用于判定**，不改变展示内容）：
  //  ① NFKC —— 消全角/兼容字符（ｈａｃｋｅｄ → hacked）；
  //  ② 删除不可见/格式/组合/控制字符（按 Unicode 类别，见 NEWS_TRUST_INVISIBLE_RE）；
  //  ③ 去分隔骨架 glued —— 只留字母/数字，匹配「跨字段拆词 / 逐字夹心」的粘连形态。
  const text = raw.normalize('NFKC').replace(NEWS_TRUST_INVISIBLE_RE, '');
  const glued = text.replace(NEWS_TRUST_NON_SIGNIFICANT_RE, '').toLowerCase();

  // 通道 1：自然文本（严格语义）。高置信签名先判 —— 于是「原始含不可见字符 + 归一化后命中高置信签名」
  // 会返回高置信 reason，不会被降级成低精度 zero-width 而被护栏放回。
  for (const re of NEWS_TRUST_ACTIVE_CONTENT_PATTERNS) {
    if (re.test(text)) return 'active-content';
  }
  for (const re of NEWS_TRUST_INJECT_PATTERNS) {
    if (re.test(text)) return 'inject';
  }
  for (const re of NEWS_TRUST_DEFACED_PATTERNS) {
    if (re.test(text)) return 'defaced';
  }
  // 通道 2：去分隔骨架（粘连形态，同样属高置信）。
  if (NEWS_TRUST_SKELETON_DEFACED_RE.test(glued)) return 'defaced';
  for (const re of NEWS_TRUST_SKELETON_INJECT_RES) {
    if (re.test(glued)) return 'inject';
  }
  // 低精度启发式与 bidi：对**原始**文本判定/计数（归一化会把它们删掉/清零，否则永不命中）。
  if (NEWS_TRUST_BIDI_RE.test(raw)) return 'obfuscated'; // 高置信
  const zw = (raw.match(NEWS_TRUST_ZERO_WIDTH_RE) || []).length;
  if (zw > NEWS_TRUST_ZERO_WIDTH_MAX) return 'zero-width'; // 低精度：emoji / 部分 CJK 源会正常产生
  const moj = (text.match(NEWS_TRUST_MOJIBAKE_RE) || []).length;
  if (moj > NEWS_TRUST_MOJIBAKE_MAX) return 'mojibake'; // 低精度：乱码洪水
  return null;
}

/**
 * 过滤一批条目。返回 `{ kept, dropped }`（`dropped` 仅用于日志，不进返回体）。
 *
 * 护栏按置信度分层（修复 2026-10-08「唯一存活源被投毒」绕过）：
 *  - 高置信规则（`NEWS_TRUST_HIGH_CONFIDENCE`）**永不 fail-open** —— 一律丢弃并留在 `dropped`；
 *  - 低精度启发式（'zero-width' / 'mojibake'）仍受护栏保护：丢弃比例 > `NEWS_TRUST_MAX_DROP_RATIO`
 *    时视为「规则过宽」，把**它们**放回 kept（fail-open），避免启发式误清空整站。
 * 这样既保住护栏「防整站空白」的初衷，又堵住「毒源成为唯一存活源即全量放行」的绕过点。
 */
function filterNewsItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { kept: list, dropped: [] };
  const kept = [];
  const high = []; // 高置信丢弃（含原条目引用，便于日志展示）
  const low = []; // 低精度丢弃（可能被护栏放回）
  for (const it of list) {
    const reason = assessNewsItem(it);
    if (!reason) {
      kept.push(it);
      continue;
    }
    const rec = {
      item: it,
      title: String((it && it.title) || '').slice(0, 60),
      source: (it && it.source) || '',
      reason
    };
    (NEWS_TRUST_HIGH_CONFIDENCE.has(reason) ? high : low).push(rec);
  }
  // 护栏只作用于低精度类；高置信条目无条件丢弃，永不放回。
  let guardrailTriggered = false;
  if (low.length && low.length / list.length > NEWS_TRUST_MAX_DROP_RATIO) {
    guardrailTriggered = true;
    for (const rec of low) kept.push(rec.item);
  }
  if (high.length || low.length) {
    const brief = (arr) => arr.slice(0, 5).map((r) => ({ title: r.title, source: r.source, reason: r.reason }));
    console.warn(
      `[webSearch] trust filter: high-dropped=${high.length} ` +
        `low-dropped=${guardrailTriggered ? 0 : low.length}` +
        (guardrailTriggered
          ? ` guardrail=ON(低精度 ${low.length}/${list.length} > ${Math.round(
              NEWS_TRUST_MAX_DROP_RATIO * 100
            )}%，已放回)`
          : ' guardrail=off') +
        ` kept=${kept.length}/${list.length}`,
      JSON.stringify({ high: brief(high), low: brief(low) })
    );
  }
  const dropped = high
    .concat(guardrailTriggered ? [] : low)
    .map((r) => ({ title: r.title, source: r.source, reason: r.reason }));
  return { kept, dropped };
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
  const raw = selectWithQuota(allItems, HOTSPOT_ITEMS_LIMIT, MAX_ITEMS_PER_SOURCE).map(toNews);
  // 内容信任过滤放在**这个出口**：早于 writeHotspotCache、早于 summarize(weather, ranked)，
  // 也早于全部消费路径（热点页缓存 / 免费档 / 订阅限额档 / 订阅降级档）。
  // 放晚一步毒条目已经进了缓存，也已经进过 LLM 的 prompt。
  const { kept: items } = filterNewsItems(raw); // filterNewsItems 返回 { kept, dropped }
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

    // action=aiFilter：资讯 AI 精选。2026-10-05 新增，把 .tools 侧的 /api/news/ai-filter
    // 能力搬上云函数 —— 原先只有本地 static-server 有，H5 生产环境无后端，该功能始终 404。
    //
    // **候选由前端自带**（event.candidates），不在这里重新抓热点：客户端列表可能已按用户
    // 偏好排序 / 过滤，服务端再抓一份会出现「页面显示的 A、模型挑的 B」对不上的情况。
    //
    // 本分支**不涉及任何用户数据**，故不需要 openid —— 这也是它能被 H5 安全调用的前提。
    // 2 小时单槽缓存与「同类目硬去重」都留在前端做：云函数是无状态的，进程内缓存不可靠，
    // 而客户端本来就有 categoryOf() 与该批条目，去重放在数据所在处最自然。
    if (action === 'aiFilter') {
      const interests = Array.isArray(event && event.interests)
        ? event.interests.map((s) => String(s).slice(0, 12)).filter(Boolean).slice(0, 8)
        : [];
      const custom = String((event && event.custom) || '').slice(0, 60);
      const signals = Array.isArray(event && event.signals)
        ? event.signals.map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 8)
        : [];
      const candidates = Array.isArray(event && event.candidates)
        ? event.candidates.filter(Boolean).slice(0, 110)
        : [];
      if (!candidates.length) return { code: -1, message: 'candidates required', data: null };

      const apiKey = process.env.LLM_API_KEY;
      if (!apiKey) return { code: -1, message: 'LLM_API_KEY not configured', data: null };
      const base = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
      const model = process.env.LLM_MODEL || 'deepseek-chat';

      const systemContent =
        '你是新闻筛选助手。根据用户兴趣画像，从候选新闻中挑出最值得看的条目，按相关度从高到低排序，最多输出 20 条。' +
        '规则：1) 只挑与兴趣相关或与近期关注相近的条目；若整体相关度都低，也要挑出相对最相关的 6 条；' +
        '2) 合规降权（优先级最高，覆盖第1条）：时政/外交/军事/突发事件监管类内容不得入选 picks；财经类最多 1 条；优先科技/数字生活/健康/教育等生活建设性议题；' +
        '3) 类目多样性（优先级仅次于合规）：候选条目格式为「编号. [来源·类目] 标题」，请据此判断每条的类目；' +
        '同一类目最多给 2 条；请把不同类目的条目都排进这 20 条里 —— 给出 20 条是为了让下游按类目去重后仍能凑满 10 条，' +
        '所以同类目的备用条目请排在后面，不要用同一类目占满靠前的位置；' +
        '4) reason 用不超过16字说明「为什么推荐给这位用户」，不要复述标题；' +
        '5) 对每个选中条目额外输出 why 字段：不超过30字的中文，回答「为什么这条值得**这个用户**看」，必须结合其 interests/custom 画像给出个人化理由（不是通用新闻价值）；' +
        '6) summary 以早报员「小晨」的口吻写（克制友好、少废话），不超过20字；' +
        '7) 严格返回 JSON：{"picks":[{"n":编号数字,"reason":"理由","why":"个人化理由(30字内)"}],"summary":"一句话概括筛选依据(20字内)"}，不要输出任何其他内容；why 缺失时允许为空字符串，但字段必须存在。';
      const userContent =
        `兴趣标签：${interests.length ? interests.join('、') : '（未设置）'}\n` +
        `自定义关注：${custom || '（无）'}\n` +
        `近期关注（参考）：${signals.length ? signals.join(' / ').slice(0, 120) : '（无）'}\n\n` +
        `候选新闻：\n${candidates.join('\n')}`;

      try {
        // 20 条 picks（每条含 reason+why）token 量不小，2600 是为了不被截断成不可解析的 JSON
        const body = JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 2600,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent }
          ]
        });
        const endpoint = new URL('/chat/completions', base);
        const content = await new Promise((resolve, reject) => {
          const req = https.request(
            endpoint,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body)
              },
              timeout: 45000
            },
            (res) => {
              let resp = '';
              res.on('data', (chunk) => (resp += chunk));
              res.on('end', () => {
                try {
                  const data = JSON.parse(resp);
                  if (res.statusCode !== 200) {
                    return reject(new Error(`LLM ${res.statusCode}: ${resp.slice(0, 160)}`));
                  }
                  resolve(data.choices[0].message.content);
                } catch (err) {
                  reject(err);
                }
              });
            }
          );
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('aiFilter LLM timeout')));
          req.write(body);
          req.end();
        });

        const parsed = safeParse(content);
        const upper = candidates.length;
        const picks = Array.isArray(parsed && parsed.picks)
          ? parsed.picks
              .filter((p) => p && Number.isInteger(Number(p.n)) && Number(p.n) >= 1 && Number(p.n) <= upper)
              .slice(0, 20)
              .map((p) => ({
                n: Number(p.n),
                reason: String(p.reason || '').slice(0, 30),
                // why 缺失容错：非字符串 → 空串；超长截断 30 字（与提示词口径一致）
                why: String(p.why || '').trim().slice(0, 30)
              }))
          : [];
        return {
          code: 0,
          message: 'ok',
          data: { picks, summary: String((parsed && parsed.summary) || '').slice(0, 40) }
        };
      } catch (err) {
        console.warn('[webSearch] aiFilter failed:', err && err.message);
        return { code: -1, message: 'aiFilter failed', data: null };
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
        // 免费档：零 LLM 成本。公开 RSS 原始条目 + 天气，**按设计**不做 AI 提炼。
        // groups 留空 → 前端 resolveIntelGroups() 走 groupIntelLocally 本地兜底分组。
        //
        // ⚠️ `degraded` 的语义是「**本该有 AI 却没拿到**」，不是「这条内容来自 RSS」。
        // 免费档没有 AI 就没有降级，硬编码 degraded:true 会让前端**永久**对免费用户
        // 显示「AI 提炼暂不可用」——明明没坏，却一直显示坏了。故：
        //   degraded:false —— 语义正确：没有东西失败；
        //   aiEnabled:false —— 前端据此把标识换成「免费版·来自公开 RSS」这类**档位说明**，
        //                       而不是错误提示（前端 utils/intelGroups.ts 已按此字段分叉）。
        const intelItems = fallbackIntel(ranked, FREE_INTEL_ITEMS_LIMIT);
        console.log(
          `[webSearch] briefing tier=free items=${intelItems.length} weather=${!!weather} fromCache=${newsFromCache}`
        );
        return {
          code: 0,
          message: 'ok',
          data: {
            subscribed: false,
            limited: false,
            weather,
            intelItems,
            groups: [],
            degraded: false,
            aiEnabled: false
          }
        };
      }

      if (news.length === 0 && !weather) {
        return {
          code: 0,
          message: 'ok',
          // 订阅档本该有 AI 却没有内容 → 真的降级，必须让前端显示错误提示而非档位说明
          data: {
            subscribed: true,
            limited: false,
            weather: null,
            intelItems: [],
            groups: [],
            degraded: true,
            aiEnabled: true
          }
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
      // aiEnabled:true —— 订阅档**按设计**有 AI，所以这里的 degraded 是真的降级语义
      //（限额耗尽 / LLM 失败 / 无内容），前端应显示「AI 提炼暂不可用」。
      return {
        code: 0,
        message: 'ok',
        data: { subscribed: true, limited: quota.limited, weather, intelItems, groups, degraded, aiEnabled: true }
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
exports.__internals = { fetchText, parseFeed, toNews, fetchOneSource, selectWithQuota, fetchAllSources, getHotspotNews, fallbackIntel, rankByPreferences, clampByCodePoint, assessNewsItem, filterNewsItems, newsTextOf };
