/**
 * webSearch 云函数 —— 联网内容聚合（F15 今日情报 / F29 热点资讯流）
 *
 * action=hotspot   热点页资讯流：RSS 聚合，强制标注来源，免费可用，1 小时缓存，无 LLM 成本
 * action=briefing  今日情报：Open-Meteo 天气（免 key）+ 偏好 RSS → 订阅档 LLM 摘要（日限额 10 次）/ 免费档原始 3 条
 *                  每一步失败均降级，绝不阻塞调用方（getBriefing 晨报生成）
 *
 * 环境变量（云开发控制台配置）：
 *   （2026-10-25 起**无必配项**：天气已切 Open-Meteo 免 key，原 WEATHER_KEY/WEATHER_LOCATION 下线）
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
/** 缓存池上限：缓存存一个更宽的池（跨用户共用），出口再按各自偏好选 10 条。
 *  取 10 会让偏好只能在已截断的集合里重排 —— 实测 37 源下科学/文化/健康供给侧占 58.8%，
 *  出口只拿到 2 条，健康 0 条。 */
const HOTSPOT_POOL_SIZE = 60;
/** 偏好 tag 的保底席位数（有供给时）。
 *  只保底 1 条时，13 个 tag 会把 10 个槽直接占满，prefs=['科学'] 仍只有 1 条科学 ——
 *  偏好继续形同虚设；故命中 tag 至少占 3 席（供给不足则有多少取多少）。 */
const PREF_TAG_MIN_ITEMS = 3;
/** 源新鲜度阈值（天）：最新条目早于该值的源判定为「冻结源」，整源排除（宁缺勿滥） */
const STALE_SOURCE_DAYS = 7;
/** 未来时间护栏（毫秒）：源站时钟超前或「定时发布」会让时间戳落到未来，
 *  用户侧看到的时间是错的。按 now 计、不丢条目 —— 与 .tools/fetch-data.js、
 *  .tools/static-server.js 同口径（2026-10-29 审计）。 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
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
  // ⛔ 2026-10-23 下线（执行 PM 决策）：中新网-社会 / 中新网-即时。
  //    原因：突发事件报道属许可红线；原 audit 注释已标「建议移除或降权（PM 决策）」，本次执行该决策。
  //      · 中新网-社会 https://www.chinanews.com.cn/rss/society.xml （tag 社会）
  //      · 中新网-即时 https://www.chinanews.com.cn/rss/scroll-news.xml （tag 时事）
  //    中新网-财经保留。cross-source.js 的 FEED_ORG_MAP 中三条 feed → 「中新网」的映射**保留不动**：
  //    这两条已不生效但无害，将来恢复时还能用。

  // ↓↓↓ 2026-09-28 多元化扩源（全部经 .tools/vet-feeds.js 四层尽调 + 云函数侧兼容性实测通过）↓↓↓
  // [audit] 游戏 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.02 天）
  { name: '机核', url: 'https://www.gcores.com/rss', tag: '游戏' },
  // [audit] 汽车/新能源 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.08 天）
  { name: '车东西', url: 'https://chedongxi.com/rss', tag: '汽车' },
  // [audit] 消费/导购 · 实测 2026-09-28 10/10 存活；⚠️ 2026-10-13 真实抓取复核：该源返回 HTML 落地页
  //   （非 RSS，reason=http-200-non-rss），已被健康/新鲜度守卫排除 —— 疑源改版或需换 feed。
  //   暂不移除以保留消费类目多样性，但元数据已过期，待重新校准或替换。(QA-2 real-data 复核)
  { name: '什么值得买', url: 'https://post.smzdm.com/feed', tag: '消费' },
  // [audit] 教育/职教 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.1 天）
  { name: '芥末堆', url: 'https://www.jiemodui.com/feed', tag: '教育' },
  // [audit] 开发者/企业技术 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.0 天）
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', tag: '开发者' },
  // [audit] 开发者/技术社区 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.0 天）
  { name: '掘金', url: 'https://juejin.cn/rss', tag: '开发者' },
  // [audit] 数字生活/软件工具 · ≈0% · 保留，低风险（实测 10/10 条存活，最新 0.2 天）
  { name: '小众软件', url: 'https://www.appinn.com/feed/', tag: '数字生活' },

  // ↓↓↓ 2026-10-25 免费扩源（第二轮，.tools/vet-feeds.js 生产同款口径两轮复测）↓↓↓
  // [audit] 科技/科学 · 中文科技社区，时政占比 ≈0%（10/10 存活，2091ms，最新 0.21 天，两轮 ADOPT）
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss', tag: '科技' },
  // [audit] 科技 · Ars Technica，技术深度报道，时政占比 ≈0%（10/10 存活，2354ms，最新 0.33 天，两轮 ADOPT）
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', tag: '科技' },

  // ↓↓↓ 2026-10-25 国际热点扩源（用户需求「热点加一些国际热点」）↓↓↓
  // 依据：.tmp-verify/feeds-vet3/（vet-feeds 生产口径，France24 两轮 ADOPT；
  // NPR/联合国/CNBC 首轮 TIMEOUT 次轮 ADOPT，单独复跑再 ADOPT —— 记为连续两轮通过）。
  // [audit] 国际 · France24，法广英文版，全球时事的欧洲视角（10/10 存活，3884ms，最新 0.03 天，两轮 ADOPT）
  { name: 'France24', url: 'https://www.france24.com/en/rss', tag: '国际' },
  // [audit] 国际 · NPR World，美国公共广播国际版，报道克制（10/10 存活，2891ms，最新 0.12 天）
  { name: 'NPR 国际', url: 'https://feeds.npr.org/1004/rss.xml', tag: '国际' },
  // [audit] 国际 · 联合国新闻官方中文源，全球事务权威且中立（10/10 存活，3458ms，最新 0.93 天）
  { name: '联合国新闻', url: 'https://news.un.org/feed/subscribe/zh/news/all/rss.xml', tag: '国际' },
  // [audit] 国际 · CNBC 全球版，国际财经与地缘经济（10/10 存活，2314ms，最新 0.06 天）
  { name: 'CNBC 全球', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', tag: '国际' },
  // ⚠️ 国际源会报道涉华话题，与既有英文源同级风险；订阅档 AI 精选层可对时政类降权，
  //    免费档原始条目直出 —— 与科技类英文源同一口径，不单独设闸（要设闸等真实投诉数据）。
  // 本轮淘汰（勿回填，理由留档防止重复踩坑）：
  //   V2EX        https://www.v2ex.com/index.xml        两轮 TIMEOUT（8s）
  //   cnBeta      https://rss.cnbeta.com/rss            NET-ERR（fetch failed）
  // 国际轮（2026-10-25）两轮 TIMEOUT（疑似线路不稳/受限，复跑仍超时再评估）：
  //   BBC 国际     https://feeds.bbci.co.uk/news/world/rss.xml
  //   Guardian 国际 https://www.theguardian.com/world/rss
  //   半岛电视台    https://www.aljazeera.com/xml/rss/all.xml
  //   德国之声中文  https://rss.dw.com/rdf/rss-chi-all
  //   快科技      https://news.mydrivers.com/rss.xml    HTTP 404
  //   虎嗅        https://www.huxiu.com/rss/0.xml       两轮 TIMEOUT（直连也超时，非镜像问题）
  //   GitHub Blog https://github.blog/feed/             轮1 TIMEOUT / 轮2 NET-ERR（本机网络不稳定，按最差判）
  //   The Verge   https://www.theverge.com/rss/index.xml 两轮 TIMEOUT
  //   Hacker News https://hnrss.org/frontpage           轮1 TIMEOUT / 轮2 ADOPT —— 抖动源，6s 闸门下不可靠，不接
  //   Product Hunt https://www.producthunt.com/feed     轮1 TIMEOUT / 轮2 ATOM-ONLY（parseRss 只认 <item>，预览侧恒 0 条）

  // ↓↓↓ 2026-10-23 科学 / 健康 / 文化扩源 ↓↓↓
  // 依据：.tmp-verify/feeds-vet/report.md（QA 用生产同款 https.get、FETCH_TIMEOUT_MS=6000、
  // STALE_ITEM_DAYS=7 口径复跑 25 个已尽调候选：23 可接线 + 2 个警告级不接）。
  // URL 取自同一尽调管线的 candidates.json（report.md 明细表未带 URL 列，源名逐条对齐）。

  // [audit] 科学 · NutritionFacts.org（https://nutritionfacts.org/feed/）**已尽调，不接（警告级）**：
  //   生产路径 3 次抓 2 次 8s 超时（8009/8010ms），成功一次 5210ms；超过 FETCH_TIMEOUT_MS=6000，
  //   接线会拖慢整体且大概率失败。保留记录，待其响应改善后重测。
  // [audit] 科学 · 中外对话（https://chinadialogue.net/feed）**已尽调，不接（警告级）**：
  //   生产路径 3 次耗时 4348ms（3219–4994ms），贴近 FETCH_TIMEOUT_MS=6000，且仅 2/10 条过 7 天闸门，
  //   性价比低（慢且产出少），会给整体 allSettled 拖尾。保留记录，待其响应改善后重测。

  // [audit] 科学 · NASA 官方一手科研任务新闻，权威性最高（10/10 存活，2356ms，最新 0.27 天）
  { name: 'NASA 新闻发布', url: 'https://www.nasa.gov/news-release/feed/', tag: '科学' },
  // [audit] 科学 · NASA 官方综合快讯，含每日天文图（10/10 存活，455ms，最新 0.27 天）
  { name: 'NASA 快讯', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', tag: '科学' },
  // [audit] 科学 · NASA Science，覆盖面最广（10/10 存活，1016ms，最新 0 天）
  { name: 'NASA Science', url: 'https://science.nasa.gov/feed/', tag: '科学' },
  // [audit] 科学 · 1845 年老牌科普权威，科学与人文深度兼具（10/10 存活，742ms，最新 0.21 天）
  { name: 'Scientific American', url: 'https://www.scientificamerican.com/platform/syndication/rss/', tag: '科学' },
  // [audit] 科学 · 百年独立科学新闻机构，署名规范（10/10 存活，699ms，最新 0.46 天）
  { name: 'Science News', url: 'https://www.sciencenews.org/feed', tag: '科学' },
  // [audit] 科学 · 科研通稿聚合，时效极高，深度参差（10/10 存活，1273ms，最新 0.02 天）
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', tag: '科学' },
  // [audit] 科学 · 物理/天文/科技综合（10/10 存活，1597ms，最新 0 天）
  { name: 'Phys.org', url: 'https://phys.org/rss-feed/', tag: '科学' },
  // [audit] 科学 · 天文与航天（10/10 存活，2593ms；响应体 1074KB，耗时 1.5–3.1s 波动，余量一般）
  { name: 'Space.com', url: 'https://www.space.com/feeds/all', tag: '科学' },
  // [audit] 科学 · 天文/地球科学科普（10/10 存活，2953ms，最新 0.69 天）
  { name: 'EarthSky', url: 'https://earthsky.org/feed/', tag: '科学' },
  // [audit] 科学 · 史密森学会，科学与人文交叉（10/10 存活，929ms，最新 0.32 天）
  { name: 'Smithsonian 杂志', url: 'https://www.smithsonianmag.com/rss/latest_articles/', tag: '科学' },
  // [audit] 科学 · 中文科普；更新偏慢，仅 3/10 条过 7 天闸门（最新 4.63 天）
  { name: '环球科学', url: 'https://www.huanqiukexue.com/?feed=rss2', tag: '科学' },
  // [audit] 科学 · 耶鲁环境 360，环境与气候深度报道（4/10 存活，1130ms，最新 0.84 天）
  { name: 'Yale Environment 360', url: 'https://e360.yale.edu/feed.xml', tag: '科学' },

  // [audit] 健康 · 跑步训练与运动科学（10/10 存活，455ms，最新 0.33 天）
  { name: "Runner's World", url: 'https://www.runnersworld.com/rss/all.xml/', tag: '健康' },
  // [audit] 健康 · 男性健康与健身（10/10 存活，493ms，最新 0.28 天）
  { name: "Men's Health", url: 'https://www.menshealth.com/rss/all.xml/', tag: '健康' },
  // [audit] 健康 · 户外运动与健康生活方式（10/10 存活，2320ms，最新 0.43 天）
  { name: 'Outside', url: 'https://www.outsideonline.com/feed/', tag: '健康' },
  // [audit] 健康 · 心理与行为健康（10/10 存活，984ms，最新 0.09 天）
  { name: 'Psychology Today', url: 'https://www.psychologytoday.com/us/front/feed', tag: '健康' },

  // [audit] 文化 · 影视产业权威媒体（10/10 存活，958ms，最新 0.04 天）
  { name: 'Variety', url: 'https://variety.com/feed/', tag: '文化' },
  // [audit] 文化 · 好莱坞影视工业报道（10/10 存活，315ms，最新 0.05 天）
  { name: 'Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/', tag: '文化' },
  // [audit] 文化 · 音乐榜单与产业；⚠️ 4422ms，同样接近 FETCH_TIMEOUT_MS=6000
  { name: 'Billboard', url: 'https://www.billboard.com/feed/', tag: '文化' },
  // [audit] 文化 · 音乐/流行文化（10/10 存活，1503ms，最新 0 天）
  { name: 'Rolling Stone', url: 'https://www.rollingstone.com/feed/', tag: '文化' },
  // [audit] 文化 · 独立音乐评论（10/10 存活，1288ms，最新 0.2 天）
  { name: 'Pitchfork', url: 'https://pitchfork.com/rss/news/', tag: '文化' },
  // [audit] 文化 · 独立音乐资讯（10/10 存活，510ms，最新 0.28 天）
  { name: 'Stereogum', url: 'https://stereogum.com/feed', tag: '文化' },
  // [audit] 文化 · 独立电影与影视产业（10/10 存活，800ms，最新 0.36 天）
  { name: 'IndieWire', url: 'https://www.indiewire.com/feed/rss/', tag: '文化' }
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
    // &apos; 是 XML 命名实体（NPR 等源在用），与数字实体两轨都要盖住
    .replace(/&apos;/g, "'")
    // 高频英文排版命名实体（Scientific American 等源用 &rsquo;/&ldquo;…）——
    // RSS 世界命名实体上百个，穷举不现实，按实测分布收高频的
    .replace(/&(rsquo|lsquo|rdquo|ldquo|hellip|mdash|ndash|deg|trade|times|middot|bull|eacute|egrave|agrave|ccedil|uuml|ouml|auml|szlig|reg|copy|laquo|raquo|dArr|rArr|ne|le|ge);/g,
      (m, e) => ({ rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–', deg: '°', trade: '™', times: '×', middot: '·', bull: '•', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', reg: '®', copy: '©', laquo: '«', raquo: '»', dArr: '↓', rArr: '→', ne: '≠', le: '≤', ge: '≥' }[e] || m))
    // 数字实体通用解码（2026-10-25 审计 #2）：线上 400 条实测 212 处未解码（&#8217;×74、
    // &#8230;×19、零填充 &#039; 命不中上面的字面 &#39;），集中在国际源 —— 只解 6 个命名
    // 实体等于放走绝大多数撇号/省略号。fromCodePoint 解不了的码点（越界）原样保留。
    .replace(/&#(\d{1,7});/g, (_, d) => {
      const cp = Number(d);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    // QA-2 真实数据复核：RSS 摘要里的 <a>点击查看原文></a> 链接文字是 CTA 噪声，整块去掉（含内文），
    // 否则会泄漏进情报正文；摘要场景链接不可点击，去掉无损。
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
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
    // （兼容标题与摘要之间夹的不可见/零宽字符差异 —— QA-2 实测中新网标题被重复输出）
    if (title) {
      const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const invis = '[\\s\\u00a0\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]*';
      const m = summary.match(new RegExp('^' + invis + esc + invis));
      if (m) summary = summary.slice(m[0].length).trim();
    }
    const dateStr = pickTag(b, 'pubDate') || pickTag(b, 'updated') || pickTag(b, 'published');
    let ts = dateStr ? new Date(dateStr).getTime() : 0;
    // 未来时间护栏：落在未来的时间戳按 now 计（不丢条目）—— 与 fetch-data / static-server 同口径
    if (ts > Date.now() + FUTURE_SKEW_MS) ts = Date.now();
    // content = 源自己在 feed 里发布的描述（上限 1000 码点），供站内文章视图；**不是**抓取的正文页。
    // 合规口径「不转载正文」不变：不另行抓原文，只展示源选择 syndicate 的内容 + 强制来源标注 + 原文链接。
    return {
      title,
      link,
      image,
      summary: clampSummary(summary, 120),
      content: clampSummary(summary, 1000),
      ts,
      sourceName,
      tag
    };
  });
}

/** 中间条目 → HotspotNews 输出形状（source 必填，合规标注来源） */
function toNews(it) {
  return {
    id: `web-${shortHash(it.link || it.title || it.sourceName)}`,
    title: it.title,
    summary: it.summary,
    content: it.content || undefined,
    source: it.sourceName,
    url: it.link || undefined,
    // 跨源同题合并的机构佐证（2026-10-22）：仅合并组产出，不含本条自身 source；
    // 空数组/缺失一律不字段化（JSON 序列化会丢掉 undefined，不给契约塞噪声）。
    alsoFrom:
      Array.isArray(it.alsoFrom) && it.alsoFrom.length ? it.alsoFrom.slice(0, ALSO_FROM_MAX) : undefined,
    image: it.image || undefined,
    tags: it.tag ? [it.tag] : [],
    // 无发布时间（parseRss 对无 pubDate 条目给 ts=0）：**不写 createTime**，不伪造当前时间。
    // 依据（2026-10-26）：内部排序本就把无时间条目按 ts=0 排末尾（见下方 bySource 排序注释），
    // 这里若补 now 会出现两个后果 —— ①前端 prefSelect 按 createTime 倒序，把无时间条目当最新排到最前，
    // 与内部意图相反；②突发识别 24h 时效闸把它们判成「刚发布」，旧闻/无时间条目顶掉真突发。
    createTime: Number.isFinite(it.ts) && it.ts > 0 ? new Date(it.ts).toISOString() : undefined
  };
}

/* ---------------- 情报内容信任过滤（共享模块） ---------------- */

/*
 * 2026-10-12：原实现在本文件内，`.tools/fetch-data.js` / `.tools/static-server.js` 无法复用，
 * 于是产出线上 H5 站点数据的两条链路**零过滤**（小程序端有、H5/gh-pages 端没有）。
 * 现已抽到 `./news-trust.js`，三处 require 同一份规则，不可能再发散。
 * 放在本目录内（而非 .tools/）是必须的：云函数部署只打包自身目录。
 * 保留 `exports.__internals` 再导出，四个 trust 单测的 require 路径不变。
 */
const { assessNewsItem, filterNewsItems, newsTextOf, findMixedScriptToken } = require('./news-trust.js');
// 机构归一口径（alsoFrom 只记机构，中新网子 feed 互抄不算多家媒体佐证）——
// 与 news-trust.js 同理由放在本目录内：云函数部署只打包自身目录。
const { orgOfSource, ALSO_FROM_MAX } = require('./cross-source.js');

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

/** 同题判定的标题归一化：小写 + 去掉全部空白/标点/符号（保守的精确相等口径）。
 *  例：「苹果 发布新手机！」与「苹果发布新手机」判为同题；「苹果发布新手机壳」不会。 */
function normTitle(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 跨源同题合并（2026-10-22）—— **必须在 selectWithQuota 之前**执行。
 *
 * 为什么必须配额前（实测教训，勿调序）：
 *  保底轮每个健康源各占 1 个席位，16 源抢 10 坑。同题的第 11 个源根本进不了池，
 *  配额后再合并一条重复都看不到；且配额后合并只会让列表**短于**目标条数
 *  （合并掉的席位不会回填），广度直接受损。配额前合并 = 同题只占 1 席，
 *  省下的席位由补足轮补进别的源的最新条目。
 *
 * 机构感知（2026-10-22 校准结论）：预配额 181 条里同题 5 组、**跨机构 0 组**，
 * 全是中新网三个子 feed 互抄。所以：
 *  · 分组用归一化标题**精确相等**（近重复判定是 static-server 四通道的领域，
 *    那边有 96 对金色基准集校准，不在这里另写一套）；
 *  · alsoFrom 只记**机构**（orgOfSource 归一后去重），同机构互抄不产生
 *    「另有 N 家媒体报道」—— 按 feed 名计数会把一家通讯社的自抄显示成多家佐证；
 *  · 代表条目取 ts 最新的一条（其 title/summary/url/source 对外可见）。
 *
 * 投毒防御（调用方保证）：fetchAllSources 已用 assessNewsItem 预筛，不可信条目
 * **不参与合并** —— 否则一条更新的投毒拷贝会 Hijack 组代表位（毒标题/毒链接
 * 替换掉合法通稿对外展示）。毒条目不进组、留作单条进配额，最终仍被
 * filterNewsItems 收掉。
 *
 * @param {Array} items 中间条目（parseFeed 产物：{title, link, image, summary, ts, sourceName, tag}）
 * @returns {Array} 合并后的中间条目；同题组（跨机构时）挂 alsoFrom（机构名数组，去重，≤ALSO_FROM_MAX）
 */
function mergeCrossSource(items) {
  const groups = new Map();
  const out = [];
  for (const it of items || []) {
    const key = normTitle(it && it.title);
    if (!key) {
      out.push(it); // 无标题条目不参与合并（也进不了任何组），原样保留
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    // 代表：ts 最新者胜出（ts=0/缺失视为最旧；全部为 0 时保持先出现者 —— 遍历稳定）
    let rep = list[0];
    for (let i = 1; i < list.length; i++) {
      if ((list[i].ts || 0) > (rep.ts || 0)) rep = list[i];
    }
    const repOrg = orgOfSource(rep.sourceName);
    const alsoFrom = [];
    const seenOrgs = new Set([repOrg]); // 代表自身机构不记佐证
    for (const it of list) {
      if (it === rep) continue;
      const org = orgOfSource(it.sourceName);
      if (seenOrgs.has(org)) continue; // 同机构（含其余子 feed 互抄）跳过
      seenOrgs.add(org);
      if (alsoFrom.length < ALSO_FROM_MAX) alsoFrom.push(org);
    }
    out.push(alsoFrom.length ? { ...rep, alsoFrom } : { ...rep });
  }
  return out;
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
  // 跨源同题合并（2026-10-22）：必须**配额前**执行 —— 保底轮每源各占 1 位，
  // 同题第 11 个源进不了池，配额后合并看不到重复（详见 mergeCrossSource 注释）。
  // 机构感知：中新网子 feed 互抄不算跨机构佐证，alsoFrom 只记机构名。
  // 投毒防御：不可信条目不参与合并（防更新的毒拷贝 Hijack 组代表位），
  // 留作单条进配额，最终仍由下方 filterNewsItems 收掉。
  const trusted = [];
  const untrusted = [];
  for (const it of allItems) (assessNewsItem(it) ? untrusted : trusted).push(it);
  const merged = mergeCrossSource(trusted).concat(untrusted);
  // 缓存池：按 HOTSPOT_POOL_SIZE 选一个宽池（跨用户共用），出口再按各用户偏好选 10 条。
  // 若这里仍按 10 条截断，后面的偏好只能重排集合内的条目，改不了集合本身。
  const raw = selectWithQuota(merged, HOTSPOT_POOL_SIZE, MAX_ITEMS_PER_SOURCE).map(toNews);
  // 内容信任过滤放在**这个出口**：早于 writeHotspotCache、早于 summarize(weather, ranked)，
  // 也早于全部消费路径（热点页缓存 / 免费档 / 订阅限额档 / 订阅降级档）。
  // 放晚一步毒条目已经进了缓存，也已经进过 LLM 的 prompt。
  const { kept: items, softItems } = filterNewsItems(raw, { label: 'webSearch' }); // 返回 { kept, dropped, softItems }
  return { items, sourceHealth, softItems: softItems || [] };
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
async function writeHotspotCache(items, sourceHealth, softItems) {
  try {
    const data = {
      key: 'hotspot',
      items,
      sourceHealth: sourceHealth || [],
      softItems: softItems || [],
      updateTime: new Date().toISOString()
    };
    await db.collection('hotspotCache').doc(HOTSPOT_CACHE_ID).set({ data });
  } catch (err) {
    console.warn('[webSearch] writeHotspotCache failed:', err && err.message);
  }
}

/* ---------------- 视频新闻：B站全站热榜（公开榜单 API） ---------------- */

/** 视频缓存固定文档 _id：与 HOTSPOT_CACHE_ID 同集合不同文档，互不覆盖 */
const VIDEO_CACHE_ID = 'video';
/** 视频缓存 TTL 与热点一致（榜单按天级更新，1 小时足够；冷缓存每用户每天最多多抓一次） */
const VIDEO_CACHE_MS = HOTSPOT_CACHE_MS;
/** 视频新闻条数：产品要的是「一项」，取榜单第 1 条；多取几条只作缓存冗余，不向下游多给 */
const VIDEO_NEWS_LIMIT = 1;

/**
 * B站排行榜接口选型（2026-10-22 实测结论，勿再重复调研）：
 *  · `x/web-interface/ranking/v2` 需 WBI 签名 —— 实测免签直连返 `code:-352`（风控），
 *    云函数现算 WBI 签名不现实（要拿 img_key/sub_key 再混合加密），放弃；
 *  · 旧版 `x/web-interface/ranking` **免签直连即返 JSON**（`code:0`，含 bvid/title/pic/
 *    author/duration/play/video_review），本条 URL 即实测可用形态。
 *    URL 里 `jsonp=jsonp?rid=0` 的怪异写法照抄自 DailyHotApi 备用通道
 *    （.tools/DailyHotApi/src/routes/bilibili.ts L116）—— 实测该形态下接口忽略 callback
 *    直接返纯 JSON，不做 JSONP 解析。
 */
const BILI_RANKING_URL =
  'https://api.bilibili.com/x/web-interface/ranking?jsonp=jsonp?rid=0&type=all&callback=__jp0';

async function readVideoCache() {
  try {
    // ① 固定 _id 优先（新写入格式）
    const byId = await db.collection('hotspotCache').doc(VIDEO_CACHE_ID).get();
    if (byId && byId.data) return byId.data;
  } catch (err) {
    // 文档/集合不存在 → 走下面的回退
  }
  try {
    // ② 回退：兼容历史自动 _id 文档；orderBy 保证读到最新的一条而非任意一条
    const res = await db
      .collection('hotspotCache')
      .where({ key: 'video' })
      .orderBy('updateTime', 'desc')
      .limit(1)
      .get();
    return res.data[0] || null;
  } catch (err) {
    // 集合不存在等场景按无缓存处理
    return null;
  }
}

/** 写视频缓存：固定 _id + set = 幂等 upsert（与 hotspot 同机制） */
async function writeVideoCache(items) {
  try {
    const data = { key: 'video', items, updateTime: new Date().toISOString() };
    await db.collection('hotspotCache').doc(VIDEO_CACHE_ID).set({ data });
  } catch (err) {
    console.warn('[webSearch] writeVideoCache failed:', err && err.message);
  }
}

/** 视频新闻：B站全站热榜第 1 条（默认 limit=1，产品口径「一项视频新闻」）。
 *
 *  合规与诚实性约定：
 *   · `source` 恒为「哔哩哔哩」、`url` 恒指向该视频页 —— 本产品**不转载视频内容**，
 *     只做带来源标注的入口，与 RSS 情报同口径；
 *   · UP主投稿标题属 UGC，**不经过 news-trust 信任过滤**（那是给进 LLM prompt 的
 *     内容防注入用的；视频条目直出前端渲染纯文本，不进任何模型）；
 *   · 任何一步失败（超时/非 200/JSON 坏/列表空）返回 []，有旧缓存则降级用旧缓存，
 *     绝不阻塞晨报其余部分。 */
async function getVideoNews(limit = VIDEO_NEWS_LIMIT) {
  const cache = await readVideoCache();
  if (cache && cache.updateTime && Date.now() - new Date(cache.updateTime).getTime() < VIDEO_CACHE_MS) {
    return (cache.items || []).slice(0, limit);
  }
  try {
    const raw = await fetchText(BILI_RANKING_URL, { Referer: 'https://www.bilibili.com/ranking/all' });
    const data = JSON.parse(raw);
    const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : [];
    const items = list
      .slice(0, 5) // 榜单前 5 里挑，给缓存留余量；向下游只给 limit 条
      .map((v) => {
        const it = v && typeof v === 'object' ? v : {};
        const bvid = String(it.bvid || '');
        const pic = typeof it.pic === 'string' ? it.pic.replace(/^http:/, 'https:') : '';
        // 旧版接口字段：author(串)/play(数)/video_review(数)/create(秒)；新版：owner.name/stat.view
        const author =
          it.owner && typeof it.owner.name === 'string'
            ? it.owner.name
            : typeof it.author === 'string'
              ? it.author
              : '';
        const play = Number.isFinite(it.play) ? it.play : Number.isFinite(it.video_review) ? it.video_review : undefined;
        const createSec = Number.isFinite(it.create) ? it.create : 0;
        return {
          id: bvid ? `bili-${bvid}` : `bili-${shortHash(String(it.title || ''))}`,
          title: String(it.title || '').slice(0, 80),
          summary: clampSummary(stripHtml(String(it.description || it.desc || '')), 120),
          content: clampSummary(stripHtml(String(it.description || it.desc || '')), 1000),
          source: '哔哩哔哩',
          url: bvid ? `https://www.bilibili.com/video/${bvid}` : undefined,
          image: safeMediaUrl(pic),
          tags: ['视频'],
          duration: typeof it.duration === 'string' ? it.duration.slice(0, 10) : undefined,
          author: author ? author.slice(0, 30) : undefined,
          play,
          createTime: createSec > 0 ? new Date(createSec * 1000).toISOString() : new Date().toISOString()
        };
      })
      .filter((it) => it.title && it.url);
    if (items.length === 0) throw new Error('bilibili ranking empty');
    await writeVideoCache(items);
    return items.slice(0, limit);
  } catch (err) {
    console.warn('[webSearch] videoNews failed:', err && err.message);
    if (cache && Array.isArray(cache.items) && cache.items.length > 0) return cache.items.slice(0, limit);
    return [];
  }
}

async function getHotspotNews() {
  const cache = await readHotspotCache();
  if (cache && cache.updateTime && Date.now() - new Date(cache.updateTime).getTime() < HOTSPOT_CACHE_MS) {
    return { items: cache.items || [], sourceHealth: cache.sourceHealth || [], softItems: cache.softItems || [], fromCache: true };
  }
  const { items, sourceHealth, softItems } = await fetchAllSources(); // allSettled，不会 throw
  if (items.length > 0) {
    await writeHotspotCache(items, sourceHealth, softItems);
    return { items, sourceHealth, softItems: softItems || [], fromCache: false };
  }
  // 全源抓取失败：有旧缓存就降级用旧的（不阻塞前端）
  if (cache && cache.items && cache.items.length > 0) {
    return { items: cache.items, sourceHealth: cache.sourceHealth || [], softItems: cache.softItems || [], fromCache: true, degraded: true };
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

/** Open-Meteo 现况（免 key、免配置）；失败返回 null，不阻塞。
 *  2026-10-25 从和风天气切过来：和风免费档也要注册取 WEATHER_KEY，而条文（legal.ts 第 2 条）
 *  只披露了 OpenMeteo —— 小程序端用和风属于「条文没披露的第三方」。切到 Open-Meteo 后
 *  两端同源（H5 的 src/utils/weather.ts 同一家），WEATHER_KEY / WEATHER_LOCATION 两个配置项
 *  整体下线，部署预检清单同步收窄。
 *  F21 语义保留：tripCity 走 geocoding 换坐标（与 H5 一致，只发城市名不发坐标）。
 *  WMO 码表与 src/utils/weather.ts、.tools/static-server.js 同表（三处手工同步，改一处要三处）。 */
const WMO_TEXT = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

async function getWeather(tripCity) {
  try {
    // 默认北京（纬度,经度）；Open-Meteo 的参数顺序是 latitude 在前 —— 和风的 location 是「经度,纬度」，别照抄
    let lat = 39.92;
    let lng = 116.41;
    let label = '北京';
    if (tripCity) {
      const geoRaw = await fetchText(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(tripCity).slice(0, 12))}&count=1&language=zh`
      );
      const hit = (JSON.parse(geoRaw).results || [])[0];
      if (!hit) {
        console.warn('[webSearch] weather geocode empty:', tripCity);
        return null;
      }
      lat = hit.latitude;
      lng = hit.longitude;
      label = hit.name || tripCity;
    }
    const raw = await fetchText(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        '&current_weather=true&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1'
    );
    const data = JSON.parse(raw);
    const cw = data.current_weather;
    if (!cw || typeof cw.temperature !== 'number') {
      console.warn('[webSearch] weather bad response: no current_weather');
      return null;
    }
    const desc = WMO_TEXT[cw.weathercode] || '多云';
    const dailyMin = data.daily && data.daily.temperature_2m_min;
    const dailyMax = data.daily && data.daily.temperature_2m_max;
    const min = dailyMin && dailyMin.length > 0 ? Math.round(dailyMin[0]) : '?';
    const max = dailyMax && dailyMax.length > 0 ? Math.round(dailyMax[0]) : '?';
    const prefix = tripCity ? `目的地${tripCity}：` : '';
    return {
      text: `${prefix}${label} ${desc}，当前 ${Math.round(cw.temperature)}°C，今日 ${min}~${max}°C`,
      updateTime: new Date().toISOString()
    };
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

/** 条目 tag（toNews 的 tags 为单元素数组）；缺失/非数组/空串兜底为「其他」 */
function itemTag(it) {
  if (!it || !Array.isArray(it.tags)) return '其他';
  const tag = it.tags[0];
  return typeof tag === 'string' && tag ? tag : '其他';
}

/** 条目时间戳（createTime 为 ISO 串，解析失败按最旧处理） */
function itemTs(it) {
  const ts = Date.parse((it && it.createTime) || '');
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 按用户偏好从**宽池**里挑 limit 条。
 *
 * 为什么不是 rankByPreferences：后者只能在给定集合内重排。集合在缓存前就被截断成 10 条，
 * 用户设了「科学」也只会在 10 条里把唯一那条科学往前挪 —— 偏好形同虚设。
 * 本函数改的是**集合**：缓存池按 HOTSPOT_POOL_SIZE 存宽池，出口按各自偏好选位。
 *
 * 三轮：
 *  ① 偏好 tag 保底：每个命中 tag 最多 PREF_TAG_MIN_ITEMS 条，总预算 ≤ limit-1（留 1 席给广度）；
 *     预算在多个偏好 tag 间按均分+余数分配，避免「排在前面的偏好 tag 吃光预算」。
 *  ② 其余 tag 各 1 条：桶大者优先（广度），同桶按最新 ts。
 *  ③ 剩余按 ts 倒序补满，尊重 MAX_ITEMS_PER_SOURCE。
 * 输出：命中偏好的条目在前，组内 ts 倒序；其余在后，ts 倒序。
 *  —— 若纯按 ts 排，更新的非偏好条目会把偏好条目压下去，用户仍觉得「设了等于没设」。
 *
 * 无偏好（undefined / 非数组 / 空数组 / 全非法元素）→ 纯时间倒序取前 limit 条。
 * 老缓存只有 10 条甚至更少时同样可用：各轮都按实际供给取，不做「池一定够宽」的假设。
 */
function selectForUser(poolItems, prefs, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HOTSPOT_ITEMS_LIMIT;
  const pool = (Array.isArray(poolItems) ? poolItems : []).filter(Boolean);
  if (!pool.length || max <= 0) return [];
  const sorted = pool.slice().sort((a, b) => itemTs(b) - itemTs(a));

  const prefTags = [];
  if (Array.isArray(prefs)) {
    for (const p of prefs) {
      if (typeof p !== 'string') continue;
      const tag = p.trim();
      if (tag && !prefTags.includes(tag)) prefTags.push(tag);
    }
  }
  if (!prefTags.length) return sorted.slice(0, max);

  const buckets = new Map();
  for (const it of sorted) {
    const tag = itemTag(it);
    if (!buckets.has(tag)) buckets.set(tag, []);
    buckets.get(tag).push(it);
  }
  const hitTags = prefTags.filter((t) => buckets.has(t)); // 池里真有货的偏好 tag，保持 prefs 顺序
  if (!hitTags.length) return sorted.slice(0, max);

  const picked = [];
  const pickedSet = new Set();
  const perSource = new Map();
  const take = (it) => {
    const src = it.source || '';
    const used = perSource.get(src) || 0;
    if (used >= MAX_ITEMS_PER_SOURCE) return false;
    picked.push(it);
    pickedSet.add(it);
    perSource.set(src, used + 1);
    return true;
  };

  // ① 偏好保底：总预算 max-1 席，均分给各偏好 tag
  const budget = Math.min(PREF_TAG_MIN_ITEMS * hitTags.length, Math.max(1, max - 1));
  const base = Math.floor(budget / hitTags.length);
  let rest = budget % hitTags.length;
  hitTags.forEach((tag) => {
    let quota = Math.min(PREF_TAG_MIN_ITEMS, base + (rest > 0 ? 1 : 0));
    if (rest > 0) rest--;
    for (const it of buckets.get(tag)) {
      if (quota <= 0 || picked.length >= max) break;
      if (take(it)) quota--;
    }
  });

  // ② 广度保底：其余 tag 各取最新 1 条
  const otherTags = [...buckets.keys()]
    .filter((t) => !hitTags.includes(t))
    .sort((a, b) => {
      const bySize = buckets.get(b).length - buckets.get(a).length;
      return bySize || itemTs(buckets.get(b)[0]) - itemTs(buckets.get(a)[0]);
    });
  for (const tag of otherTags) {
    if (picked.length >= max) break;
    for (const it of buckets.get(tag)) {
      if (take(it)) break;
    }
  }

  // ③ 补足：剩余按 ts 倒序，尊重单源上限
  for (const it of sorted) {
    if (picked.length >= max) break;
    if (pickedSet.has(it)) continue;
    take(it);
  }

  const prefSet = new Set(hitTags);
  return picked
    .slice(0, max)
    .sort((a, b) => {
      const pa = prefSet.has(itemTag(a)) ? 0 : 1;
      const pb = prefSet.has(itemTag(b)) ? 0 : 1;
      return pa - pb || itemTs(b) - itemTs(a);
    });
}

/** 热点页出口：**每源最多 1 条**，按时间倒序取前 total 个不同源。
 *
 *  为什么需要它（2026-10-23）：缓存池为「按偏好选位」扩到 HOTSPOT_POOL_SIZE 后，
 *  直接 `slice(0, 10)` 会让高产源连占 3 席（单源上限 3），十家媒体的观感塌成三家 ——
 *  「今日热点」的核心价值就是广度，不能为了偏好选位把广度换掉。
 *  原 selectWithQuota 的保底轮本就是「每源各占 1 位」，本函数还原同一口径。
 *
 *  兜底：不同源不足 total 时，第二轮允许同源补足，避免源少的时段页面变短。
 *  入参 items 必须已按 ts 倒序（缓存写入时即如此），本函数不再排序。 */
function pickDiverseHotspot(items, total) {
  if (!Array.isArray(items) || total <= 0) return [];
  const out = [];
  const taken = new Set();
  for (const it of items) {
    if (out.some((x) => x.source === it.source)) continue;
    out.push(it);
    taken.add(it);
    if (out.length >= total) break;
  }
  if (out.length < total) {
    for (const it of items) {
      if (taken.has(it)) continue;
      out.push(it);
      taken.add(it);
      if (out.length >= total) break;
    }
  }
  return out;
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
          .map((it) => ({ text: clampSummary(it.text, INTEL_ITEM_TEXT_MAX), source: String(it.source || '综合').slice(0, 20) }))
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
  // 注意（2026-10-26）：这里**刻意不写 createTime**。LLM 把多条素材改写成 3-5 句，
  // 一句可能综合了多条素材，和源条目不是一对一；按 source 猜一个时间贴上去，
  // 等于给旧闻盖新鲜时间戳，比不贴更糟。缺时间的条目在突发识别里走保守放行。
  const items = parsed.items
    .filter((it) => it && it.text)
    .slice(0, 5)
    .map((it) => ({ text: clampSummary(it.text, INTEL_ITEM_TEXT_MAX), source: String(it.source || '综合') }));
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

/** 摘要/情报正文专用：按码点截断并补省略号；**句边界优先**。
 *
 *  与 clampByCodePoint 的区别是会**告诉读者被截断了**。2026-10-12 内容质量审计实测：
 *  线上 198 条里 77 条摘要长度恰好等于上限、一条省略号都没有，读者无法区分
 *  「摘要本来就短」和「被硬切了」，观感上像是内容缺失。省略号占 1 个码点，故在 max-1 处截。
 *  2026-10-22 真实数据复验追加实测：硬截有 2/3 落在句中（"…最近B站"、"…另一拨在"），
 *  读者拿到的是半截话。改为在 max-1 范围内**优先落到句末（。！？…）、其次句读
 *  （，、；：等）**，让读者拿到完整句子；截点太靠前（不足 limit/2、内容损失过多）
 *  或整段没有句读时才退回硬截。
 *
 *  2026-10-29 审计：实现已抽到 ./text-clamp.js（**唯一事实源**）——
 *  H5 线上数据（.tools/fetch-data.js）与本地预览（.tools/static-server.js）此前仍是
 *  硬截/裸 slice，实测线上 414 条里 274 条（66.2%）摘要恰好 80 字、半句话直接暴露给用户。
 *  这里是本仓库第三次出现「同一件事两份口径」（2026-09-24 源清单、2026-10-22 clampSummary）。
 *  保留 clampSummary 这个名字是为了不动 __internals 的对外形状。 */
const { clampText: clampSummary } = require('./text-clamp.js');

/** 条目时间 → 契约可用的 ISO 串；缺失/不可解析返回 undefined。
 *
 *  2026-10-26：突发识别的 24h 时效闸此前**100% 空转** —— intelItems 只有 {text,source}，
 *  createTime 恒缺，isFresh() 对每条都保守放行。RSS 条目的时间其实一直在（toNews 从 feed
 *  的 pubDate 转成 createTime），是本出口把它丢了。这里原样透传，**不补当前时间**：
 *  缺时间就让它继续走「保守放行」，伪造 now 会把旧闻洗成新鲜。 */
function safeIsoTime(v) {
  if (typeof v !== 'string') return undefined;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

/** 降级：LLM 不可用时直接用原始资讯（标注来源，不编造）。
 *  limit 默认 5（订阅档 LLM 降级路径），免费档显式传 FREE_INTEL_ITEMS_LIMIT=3。
 *
 *  2026-10-22 增量：透传 `image`/`url`。parseFeed 的 pickImage 早就抽了配图、
 *  toNews 也带着走，是这个出口把它们丢掉的 —— 上游白抽。透传规则：
 *   · 仅放行 http/https（挡住 javascript: 等 scheme，防 XSS/钓鱼）；
 *   · 长度封顶 512，防脏数据把 payload 撑爆；
 *   · 缺失/非法一律 undefined，前端据此降级为纯文本条目（不崩、不留空图）。
 *  2026-10-26 增量：透传 `createTime`（见 safeIsoTime），让突发时效闸真正生效。
 *  LLM 订阅路径（summarize）**不跟此改动**：那里的 text 是模型改写句，与源条目
 *  不是一对一关系，硬贴源时间就是给旧闻盖新鲜章 —— 宁可不贴，走保守放行。 */
function fallbackIntel(newsItems, limit = 5) {
  const list = Array.isArray(newsItems) ? newsItems : [];
  return list.slice(0, limit).map((n) => {
    const it = n && typeof n === 'object' ? n : {};
    const title = String(it.title || '');
    const summary = String(it.summary || '');
    // 5b/5c：畸形/缺失字段不得把字面量 "undefined" 或 null 来源泄漏给用户
    const body = title || summary ? `${title}${summary ? '：' + summary : ''}` : '暂无内容';
    const createTime = safeIsoTime(it.createTime);
    // 2026-10-22 真实数据复验实测免费档 3/3 恰 80 码点、无省略号、句中斩断，读者无法区分「内容本来就短」和「被硬切了」——截断须告知读者，与 clampSummary 既有语义收口一处；省略号占 1 码点，总长不变
    return {
      text: clampSummary(body, INTEL_ITEM_TEXT_MAX),
      source: it.source != null && it.source !== '' ? String(it.source) : '综合',
      image: safeMediaUrl(it.image),
      url: safeMediaUrl(it.url),
      ...(createTime ? { createTime } : {})
    };
  });
}

/** 媒体 URL 准入：仅 http/https、≤512 码点、不含 ASCII 控制字符；其余（缺省/非串/
 *  javascript: 等 scheme/带 \t \n \r \0）一律 undefined。
 *  情报条目里的图与原文链接都走它 —— 一个入口，不可能漏放行。
 *  控制字符防线（2026-10-22 对抗性复验补）：合法 URL 从不含 U+0000-U+001F/U+007F
 *  （与 src/utils/externalLink.ts 的 isSafeExternalUrl 同口径）——RSS 属性值里
 *  混入控制字符只可能是投毒，拒掉不会误伤任何真实调用点。 */
function safeMediaUrl(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 512) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(s)) return undefined;
  return /^https?:\/\//i.test(s) ? s : undefined;
}

/** 5e：免费档/降级档兜底补源。先取主池 ranked 上限 limit 条；不足时从 soft 池
 *  （被低精度信任规则丢弃、非投毒的条目）补到 limit，避免过滤过严时用户看到空场。
 *  高置信（投毒/注入/可执行残留）条目不在 soft 池，绝不进入兜底。 */
function topUpFallback(ranked, softRanked, limit) {
  const main = fallbackIntel(ranked, limit);
  if (main.length >= limit) return main;
  const seen = new Set(main.map((x) => x.text));
  const extra = fallbackIntel(softRanked, limit).filter((x) => !seen.has(x.text));
  return main.concat(extra).slice(0, limit);
}

/* ---------------- 身份解析 ---------------- */

/** 服务端内部调用令牌是否匹配（getBriefing → webSearch 的唯一合法代传路径）。 */
function internalTokenOk(event) {
  const expected = process.env.INTERNAL_CALL_TOKEN;
  const got = event && event.__internalToken;
  // 未配置时一律判否：宁可直接拒绝内部路径，也不能退化成「谁都能代传身份」
  if (!expected || typeof got !== 'string') return false;
  if (got.length !== expected.length) return false;
  // 定长逐字节比较，避免按前缀短路泄露
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** 解析本次请求的调用者身份。
 *
 *  S-1 修复（2026-10-12 安全审计）：原实现是 `ctx.OPENID || (event && event.openid) || ''`，
 *  等于**任何客户端都能自传别人的 openid**。H5 的 database.rpc 白名单放行了 webSearch
 *  （services/dataSource.ts），攻击者只要 POST `{action:'briefing', openid:'受害者'}`，
 *  就能让 getUser() 读出他人档案并消耗他人 LLM 额度。
 *
 *  现在的契约：
 *   · 有微信上下文 → 只认 ctx.OPENID，event.openid 一律忽略（小程序路径，身份不可伪造）；
 *   · 无微信上下文 → 仅当携带配对的 INTERNAL_CALL_TOKEN 时才接受 event.openid，
 *     即只有同环境的 getBriefing 服务端路径能代传身份；
 *   · 其余解析为空串，由各 action 既有的 `no openid` 分支拒绝。 */
function resolveCallerOpenid(ctx, event) {
  if (ctx.OPENID) return ctx.OPENID;
  if (internalTokenOk(event)) return String((event && event.openid) || '');
  return '';
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const action = (event && event.action) || 'hotspot';
  try {
    if (action === 'hotspot') {
      const { items, sourceHealth } = await getHotspotNews();
      // 缓存池已扩到 HOTSPOT_POOL_SIZE（供 briefing 按偏好选位），热点页对外仍是 10 条，
      // 且必须保持**每源最多 1 条**的多样性口径 —— 扩池后直接 slice 会让高产源连占 3 席，
      // 十家媒体塌成三家（见 pickDiverseHotspot 注释）。缓存已是 ts 倒序，函数内不再排序。
      const page = pickDiverseHotspot(items, HOTSPOT_ITEMS_LIMIT);
      // data 保持既有形状（HotspotNews[]，前端按此渲染）；sourceHealth 为新增的可观测字段，前端会忽略
      return { code: 0, message: 'ok', data: page, sourceHealth };
    }

    if (action === 'videoNews') {
      // 视频新闻：B站全站热榜第 1 条（公开内容，与 hotspot 同为免 openid 口径）。
      // 失败返回 data:[] 而不是 code:-1 —— 前端据此隐藏卡片即可，无需弹错误；
      // getVideoNews 内部已有「旧缓存降级 → 空数组」两级兜底，这里不会再抛。
      const items = await getVideoNews();
      return { code: 0, message: 'ok', data: items };
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
      const openid = resolveCallerOpenid(ctx, event);
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
      // openid：优先且只认微信上下文；无上下文时需带 INTERNAL_CALL_TOKEN 才是服务端代传
      // （getBriefing 定时/聚合路径）—— 客户端自传 openid 一律忽略
      const ctx = cloud.getWXContext();
      const openid = resolveCallerOpenid(ctx, event);
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
      let softPool = [];
      try {
        const pooled = await getHotspotNews();
        news = Array.isArray(pooled.items) ? pooled.items : [];
        newsFromCache = !!pooled.fromCache;
        softPool = Array.isArray(pooled.softItems) ? pooled.softItems : [];
      } catch (err) {
        console.warn('[webSearch] briefing news unavailable:', err && err.message);
      }
      // 资讯池是宽池（HOTSPOT_POOL_SIZE），这里按**本用户偏好**选集合，不只是在已截断的 10 条里重排。
      const ranked = selectForUser(news, user && user.preferences, HOTSPOT_ITEMS_LIMIT);
      // 软新闻是另一条池（未扩池），保持原有关键词重排逻辑
      const softRanked = rankByPreferences(softPool, user && user.preferences);

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
        const intelItems = topUpFallback(ranked, softRanked, FREE_INTEL_ITEMS_LIMIT);
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
        intelItems = topUpFallback(ranked, softRanked, 5);
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
          intelItems = topUpFallback(ranked, softRanked, 5);
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
exports.HOTSPOT_POOL_SIZE = HOTSPOT_POOL_SIZE;
exports.PREF_TAG_MIN_ITEMS = PREF_TAG_MIN_ITEMS;
exports.STALE_SOURCE_DAYS = STALE_SOURCE_DAYS;
exports.FETCH_RETRY_ON_CONN_ERROR = FETCH_RETRY_ON_CONN_ERROR;
exports.FETCH_RETRY_BACKOFF_MS = FETCH_RETRY_BACKOFF_MS;
exports.FREE_INTEL_ITEMS_LIMIT = FREE_INTEL_ITEMS_LIMIT;
exports.INTEL_ITEM_TEXT_MAX = INTEL_ITEM_TEXT_MAX;
exports.RSS_SOURCES = RSS_SOURCES;
exports.__internals = { fetchText, parseFeed, stripHtml, toNews, fetchOneSource, selectWithQuota, selectForUser, pickDiverseHotspot, fetchAllSources, getHotspotNews, fallbackIntel, topUpFallback, rankByPreferences, clampByCodePoint, clampSummary, resolveCallerOpenid, internalTokenOk, assessNewsItem, filterNewsItems, newsTextOf, findMixedScriptToken, getVideoNews, safeMediaUrl, mergeCrossSource, normTitle, orgOfSource };
