/**
 * 情报内容信任过滤（共享模块）—— 2026-10-12 从 webSearch/index.js 原样抽出。
 *
 * 为什么要抽成独立文件（修复 2026-10-12）：
 *   此前 `assessNewsItem` / `filterNewsItems` **只存在于 `cloudfunctions/webSearch/index.js`**，
 *   而产出「线上 H5 站点真实数据」的链路是 `.tools/fetch-data.js`（写 `dist/api/hotspot.json`）
 *   与 `.tools/static-server.js`（本地 `/api/hotspot`）—— 两者对第三方 RSS **零过滤**。
 *   后果是同一个过滤器在管小程序端、却不管 H5/gh-pages 端：
 *   投毒条目照样进 `hotspot.json`、照样渲染给用户、照样被聚合脚本读走。
 *   当时「220 条真实语料零误杀」只证明**规则不误杀**，并不证明**它在管线上数据**。
 *
 *   抽出后由三处 `require` **同一份**：
 *     - cloudfunctions/webSearch/index.js   （小程序端，走云函数）
 *     - .tools/fetch-data.js                （build 时产出 dist/api/hotspot.json → 线上站点）
 *     - .tools/static-server.js             （本地开发/自测的 /api/hotspot）
 *
 *   ⚠️ 本文件放在 cloudfunction 目录**内**（不是 .tools/）：云函数部署只打包自身目录，
 *   若让它 `require('../../.tools/news-trust.js')` 会在部署后直接崩。反向引用（.tools → cloudfunctions）
 *   只发生在本地与 GitHub Actions 的完整仓库里，是安全的。
 *
 * 规则内容未做任何改动 —— 只把 `[webSearch]` 日志前缀改成可选参数 `opts.label`，
 * 以便三条链路各自标明自己。三条链路的规则从此不可能再发散。
 */

/**
 * 为什么需要（2026-10-08）：本模块把第三方 RSS 的 `title`/`summary` 判定为可否信任。
 * RSS 是开放投稿/可被投毒的面，一条被写入指令的条目会同时污染三条出口：免费档、
 * 订阅档降级档、以及**喂给 LLM 的 `ranked`**。所以过滤点必须在条目入库进缓存
 * **之前** —— 放晚一步，毒条目已经在缓存里，也已经进过 LLM 的 prompt。
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
 *     prompt 注入，放过即把攻击文本喂进 LLM；`\byou are now\b` 虽有误判可能，但已收紧为
 *     「必须后接 AI 角色名词（assistant/ai/model/…）」——普通句式的 `You are now a subscriber`
 *     不再命中（曾误杀，见 NEWS_TRUST_INJECT_PATTERNS 注释），误判代价仅**单条**被丢；
 *   - 'obfuscated'：bidi 覆写字符（U+202A–202E / U+2066–2069）在标题里没有正当用途；
 *   - 'confusable'：一个词内跨文字系统混拼（`h<西里尔а>cked`）—— 同形字走私，正常文本不会这样；
 *   - 'empty'：无任何可判定文本的条目（确定性判定、非启发式，没有「正常空新闻」需要保护）。
 *  低精度启发式（'zero-width'、'mojibake'）**不在**此集合，仍受护栏保护。 */
const NEWS_TRUST_HIGH_CONFIDENCE = new Set(['empty', 'active-content', 'inject', 'defaced', 'obfuscated', 'confusable']);

/** 指令注入：针对下游消费者（LLM 或人）的越权话术。中英双语都要覆盖。
 *  ⚠️ 只匹配**自然形态**（一律用 `\s+`），且语义收紧到真正的注入习语：
 *   - `you are now …` 必须后接**AI 角色名词**（assistant/ai/model/chatbot/bot/helper/agent/persona/system）。
 *     只要求「冠词 + 任意名词」不够：`You are now a Premium subscriber` / `You are now a member of …`
 *     是极常见的合法英文句式，会被静默误杀（且因 inject 属高置信度、永不被护栏放回）—— 已收紧。
 *   - `disregard …(above|previous|prior)…` 必须后接被抛弃的**对象**
 *     （instructions/prompts/rules/context/messages），否则 `previously / assumptions` 会误杀。
 *  早期版本为吃下「粘连形态」把分隔符放宽成 `\s*`，尾随 `\s*` 命中零个空白 → 上述正常措辞被误判注入。
 *  「粘连形态」（归一化后无分隔，如 `ignoreallpreviousinstructions`）改由下方**去分隔骨架**负责。 */
const NEWS_TRUST_INJECT_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior)\s+(?:instructions?|prompts?|rules?|context|messages?)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)?\s*(?:helpful\s+|new\s+|ai\s+)?(?:assistant|ai|model|chatbot|bot|helper|agent|persona|system)\b/i,
  // 「抛弃规则」这一类**指令从句**：比人设词更稳——人设词无法穷举（`you are now a pirate`），
  // 而「忘掉/忽略规则」本身就是越权指令。`(?:(?:the|all|your|any)\s+)*` 以吃下 `forget all your rules`。
  // 负向前瞻排除 `forget the rules **of** X` 这类**讨论式**标题（`of/for/about/in…` 引出宾语，
  // 说明被讨论的是规则本身，不是在给助手下指令）——否则正常标题会被误杀。
  /\b(?:ignore|forget|disregard)\s+(?:(?:the|all|your|any|these|those)\s+)*(?:rules|instructions?|prompts?|guidelines|restrictions?|directives?)\b(?!\s+(?:of|for|about|in|on|to|when|regarding|behind|around)\b)/i,
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
 * · `\p{Cf}` 格式类：ZWSP(200B) / WJ(2060) / BOM(FEFF) / 双向控制(202A–202E, 2066–2069)
 *    / **软连字符 U+00AD** / **U+2061–2064**；
 * · `\p{Cc}` 控制类：含 `\n`/`\t`/`\r` —— 顺带把 title/summary 跨字段拼接起来（`hac`+`ked by`）；
 * · `\p{Mn}` / `\p{Me}`：组合/包围记号（如组合重音 U+0301）；
 * · 另补上述类别覆盖不到的已知不可见字：U+034F CGJ、U+3164 韩文填充、
 *    U+115F/U+1160 谚文填充、U+FFA0 半角谚文填充、U+180E 蒙古文元音分隔符。
 * 归一化用**删除**而非替换为空格：删除后 `java\u00ADscript:`→`javascript:`、
 *  `忽略\u00AD以上`→`忽略以上` 直接命中既有正则；替换为空格反而会打断这些签名。 */
const NEWS_TRUST_INVISIBLE_RE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u034f\u3164\u115f\u1160\uffa0\u180e]/gu;

/** 骨架用的「透明字符」集 —— 删除后相邻词会粘连，用于捕捉「被不可见字/分隔符拆开」的签名。
 *  ⚠️ 这里**刻意不含句子标点**（, . ; : ! ? ( ) " ' 等）。正常英文安全新闻常见写法
 *  `Website hacked, by an unknown group` 若把逗号也删掉 → `websitehackedby…`，与投毒签名
 *  `hackedby` **完全同形** → 正常资讯被静默误杀（本轮修复的根因）。
 *  包含：`\p{Cf}` 格式类 / `\p{Cc}` 控制类（含 `\n`，顺带跨字段拼接）/ `\p{Mn}\p{Me}` 组合记号 /
 *  `\p{Zs}\p{Zl}\p{Zp}` 各类空白（NBSP 经 NFKC 已变普通空格，此处仍列 `\p{Zs}` 兜底）/
 *  类别覆盖不到的已知不可见字（**U+2800 盲文空白属 So、U+3164/U+115F/U+1160/U+FFA0 属 Lo**，
 *  须显式列出）/ **词内**分隔符（连字符、下划线、中点、项目符号）——
 *  `h-a-c-k-e-d` / `h_a_c_k_e_d` 这种逐字拆分是可见的混淆手法，应当照旧命中。 */
const NEWS_TRUST_TRANSPARENT_RE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}\u034f\u3164\u115f\u1160\uffa0\u180e\u2800\-_\u00b7\u2022]/gu;

/** 骨架签名（作用于 `glued`，已转小写）。正常资讯里没有这些串；
 *  `\b` 在粘连形态下失效（`hackedby` 的 `d`→`b` 之间无词边界），故这里用**去分隔子串**匹配。
 *  ⚠️ 不给 `you are now` 做骨架签名：`youarenow` 会命中正常短语 `you are nowhere / you are now at`。 */
const NEWS_TRUST_SKELETON_DEFACED_RE = /(?:hacked|defaced|pwned)by/;
const NEWS_TRUST_SKELETON_INJECT_RES = [
  /ignore(?:all)?(?:previous|prior|above|earlier)(?:instructions?|prompts?|rules?)/,
  /disregard(?:all)?(?:the)?(?:above|previous|prior)(?:instructions?|prompts?|rules?|context|messages?)/
];

/** 双向文字覆写/隔离控制符（U+202A–202E、U+2066–2069）：在中文/英文资讯标题里**没有任何正当用途**，
 * 正常排版不需要它们，出现即为藏字符 → 命中即拦，不设阈值。
 *  （曾把它和零宽字符合并成一个 >2 的阈值，被单测抓到漏判：单个 RLO…PDF 对就绕过去了。）
 *  ⚠️ 对**原始**文本判定：归一化会删除 bidi 字符，若对归一化文本判定将永不命中。 */
const NEWS_TRUST_BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/;

/** 零宽字符（U+200B–200D、U+2060、U+FEFF）：emoji 序列与部分 CJK 源**会正常产生**，
 *  故不能命中即拦，按数量阈值判定。
 *  ⚠️ 对**原始**文本计数：归一化会清空计数，若对归一化文本计数将永不判 zero-width。 */
const NEWS_TRUST_ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const NEWS_TRUST_ZERO_WIDTH_MAX = 2;

/** U+FFFD 替换字符洪水：**编码损坏**（mojibake）的真信号。这里只看 U+FFFD。
 *  ⚠️ 早期版本把西里尔(U+0400–04FF)/希腊(U+0370–03FF)码点也算进来并做「计数 > 3」判定，
 *  后果有二（本轮实测）：① 正常俄语/希腊语资讯被**整条误杀**；② 是否存活还取决于同一列表里
 *  其他条目的构成 —— 与中文混排时（丢弃比 1/3）被静默删除，整列都是外文时（丢弃比 100%）
 *  又被护栏 fail-open 放回。这种「随列表构成而变」的行为不是任何人会设计的，已废弃；
 *  同形字改由下方**混拼词**规则负责。 */
const NEWS_TRUST_MOJIBAKE_RE = /[\uFFFD]/g;
const NEWS_TRUST_MOJIBAKE_MAX = 3;

/** 混拼词（同形字走私）检测用的字符类别。 */
const NEWS_TRUST_LATIN_RE = /\p{Script=Latin}/u;
const NEWS_TRUST_LETTER_RE = /\p{L}/u;
/** CJK：中日韩文字本身**大量**与拉丁字母混排（`AI 技术` / `Rust 编程`），属正常，必须排除。 */
const NEWS_TRUST_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 找出「混拼词」——**一个词内部同时含拉丁字母与「非拉丁且非 CJK」的字母**。
 * 正常多语言文本总是「整词同一文字系统」（`Российские` / `Η` / `AI`）；只有
 * `h<西里尔 а>cked` 这种**跨文字系统拼同一个词**才是同形字走私的特征。
 * 这一条取代了原来「按码点范围计数」的 mojibake：既**消掉正常外文误杀**，
 * 又把覆盖从西里尔/希腊**扩展到**亚美尼亚/格鲁吉亚/切罗基/科普特等同形字来源。
 * ⚠️ 已知残余（本轮**不做**）：拉丁系**内部**的同形字（拉丁 IPA `ɑ` U+0251 / `ɡ` U+0261
 * 冒充 a/g）——它们本身就是 `\p{Script=Latin}`，任何基于文字系统的规则都不可能捕获，
 * 需 confusables 映射表。缓解：此类攻击仍需攻击者刻意构造，且自然形态的签名
 * （`hacked by` 等）另由通道 1/2 拦截。
 * @returns {string|null} 命中的词，未命中返回 null
 */
function findMixedScriptToken(text) {
  const tokens = String(text || '').split(/[^\p{L}\p{N}]+/u);
  for (const tk of tokens) {
    if (!tk) continue;
    let hasLatin = false;
    let hasOther = false;
    for (const ch of tk) {
      if (NEWS_TRUST_LATIN_RE.test(ch)) hasLatin = true;
      else if (NEWS_TRUST_LETTER_RE.test(ch) && !NEWS_TRUST_CJK_RE.test(ch)) hasOther = true;
      if (hasLatin && hasOther) return tk;
    }
  }
  return null;
}

/** 把一个条目里参与判定的文本拼起来（title/summary/tags）。 */
function newsTextOf(item) {
  const tags = Array.isArray(item && item.tags) ? item.tags.join(' ') : '';
  return [item && item.title, item && item.summary, tags].filter(Boolean).join('\n');
}

/**
 * 判定单条是否不可信。**返回命中的规则名**，便于日志定位；可信返回 null。
 * 纯函数、无副作用、可直接单测。
 */
function assessNewsItem(item) {
  const raw = newsTextOf(item);
  if (!raw.trim()) return 'empty';
  // 归一化（**仅用于判定**，不改变展示内容）：
  //  ① NFKC —— 消全角/兼容字符（ｈａｃｋｅｄ → hacked）；
  //  ② 删除不可见/格式/组合/控制字符（按 Unicode 类别，见 NEWS_TRUST_INVISIBLE_RE）；
  //  ③ 去「透明字符」骨架 glued —— 删掉空白与不可见字后相邻词会粘连，用于匹配「跨字段拆词 /
  //     逐字夹心」的粘连形态；**句子标点被保留作屏障**，否则正常标题 `hacked, by` 会与投毒
  //     签名 `hackedby` 同形（本轮修复的误杀，见 NEWS_TRUST_TRANSPARENT_RE）。
  const text = raw.normalize('NFKC').replace(NEWS_TRUST_INVISIBLE_RE, '');
  const glued = text.replace(NEWS_TRUST_TRANSPARENT_RE, '').toLowerCase();

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
  // 通道 3：混拼词（同形字走私）—— 高置信：一个词内部跨文字系统混拼没有正当用途。
  if (findMixedScriptToken(text)) return 'confusable';
  // 低精度启发式与 bidi：对**原始**文本判定/计数（归一化会把它们删掉/清零，否则永不命中）。
  if (NEWS_TRUST_BIDI_RE.test(raw)) return 'obfuscated'; // 高置信
  const zw = (raw.match(NEWS_TRUST_ZERO_WIDTH_RE) || []).length;
  if (zw > NEWS_TRUST_ZERO_WIDTH_MAX) return 'zero-width'; // 低精度：emoji / 部分 CJK 源会正常产生
  const moj = (text.match(NEWS_TRUST_MOJIBAKE_RE) || []).length;
  if (moj > NEWS_TRUST_MOJIBAKE_MAX) return 'mojibake'; // 低精度：U+FFFD 编码损坏
  return null;
}

/**
 * 过滤一批条目。返回 `{ kept, dropped }`（`dropped` 仅用于日志，不进返回体）。
 *
 * @param {any[]} items 待判定条目
 * @param {{label?:string}} [opts] `label` 只用于日志前缀，便于三条链路各自标明自己
 *
 * 护栏按置信度分层（修复 2026-10-08「唯一存活源被投毒」绕过）：
 *  - 高置信规则（`NEWS_TRUST_HIGH_CONFIDENCE`）**永不 fail-open** —— 一律丢弃并留在 `dropped`；
 *  - 低精度启发式（'zero-width' / 'mojibake'）仍受护栏保护：丢弃比例 > `NEWS_TRUST_MAX_DROP_RATIO`
 *    时视为「规则过宽」，把**它们**放回 kept（fail-open），避免启发式误清空整站。
 *  这样既保住护栏「防整站空白」的初衷，又堵住「毒源成为唯一存活源即全量放行」的绕过点。
 */
function filterNewsItems(items, opts) {
  const label = (opts && opts.label) || 'news-trust';
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
      `[${label}] trust filter: high-dropped=${high.length} ` +
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
    .map((r) => ({ title: r.title, source: r.source, reason: r.reason, item: r.item }));
  // softItems：低精度启发式丢弃、且未被护栏放回的条目（高置信条目永不进入）。
  // 用途：免费档「今日情报」在被高置信过滤后不足 3 条时，用它们兜底补源，
  // 但高置信（投毒/注入/可执行残留）条目绝不进入兜底池。
  const softItems = (guardrailTriggered ? [] : low)
    .map((r) => r.item)
    .filter(Boolean);
  return { kept, dropped, softItems };
}

module.exports = {
  assessNewsItem,
  filterNewsItems,
  newsTextOf,
  findMixedScriptToken,
  NEWS_TRUST_HIGH_CONFIDENCE,
  NEWS_TRUST_MAX_DROP_RATIO
};