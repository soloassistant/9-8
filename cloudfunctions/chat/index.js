const cloud = require('wx-server-sdk');
const { callLLM, callLLMWebSearch } = require('./llm');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const FREE_VOICE_QUOTA = 20;

/* ------------------------------------------------------------------ */
/* S-01~S-04 排班「先提议后执行」常量（禁止魔法数字）                     */
/* ------------------------------------------------------------------ */

/** action='plan' 单次最多返回的方案条目数 */
const MAX_PLAN_ITEMS = 8;
/** action='applyPlan' 单次最多落库的条目数 */
const MAX_APPLY_EVENTS = 20;
/** 纯新建批量排班单次最多落库条数（既有 F24 口径：≤5 条直排） */
const MAX_BATCH_EVENTS = 5;
/** 日程标题最大长度 */
const MAX_TITLE_LEN = 30;
/** 时间格式校验：'YYYY-MM-DD HH:mm' */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/**
 * 分流开关（主理人拍板）：涉及改期（能定位到已有日程 eventId）一律走 action='plan' 预览，不直排。
 * 置 false 可一键回退到「LLM 出 reschedule 即直接改库」的旧行为。
 */
const PLAN_PREVIEW_FOR_RESCHEDULE = true;

/* ------------------------------------------------------------------ */
/* P-02 购物文案纪律常量                                                */
/* ------------------------------------------------------------------ */

/** 禁止表述（命中即整条替换为拒答话术，PRD 5.2） */
const SHOPPING_FORBIDDEN_PATTERNS = [
  /已为你下单/,
  /已帮你购买/,
  /已锁定库存/,
  /已付款/,
  /代你支付/
];
/**
 * 越界意图词（用户说或回复里出现都算命中）。
 * 覆盖 PRD 5.2 列举的「帮我买 / 直接下单 / 付款 / 代付」等写法。
 */
const SHOPPING_ORDER_INTENT =
  /下单|购买|付款|代付|帮我买|帮我拍|替我买|代我买|给我买|直接买|拍下|加购|结算/;
/** 越界拒答话术（PRD 5.2） */
const SHOPPING_REFUSE_REPLY =
  '我可以帮你查价、比价和汇总优惠，但下单付款需要你本人在购物平台完成，我不会代替你操作。';
/** 固定免责句（PRD 5.2，回复已含则不再追加） */
const SHOPPING_DISCLAIMER = '我只帮你查价和汇总信息，不会替你下单或付款。';
const SHOPPING_DISCLAIMER_SOURCE =
  '以下价格来自公开渠道，仅供参考，请以商品页面实际价格为准。';
/** 价保提示（仅涉及已购/待购商品时出现，PRD 5.2） */
const SHOPPING_PRICE_GUARD =
  '价保提示：部分平台支持下单后 7 天内价保，建议在下单前确认该商品的价保规则。';

/** M-03：单条记忆摘要最大字数（与前端 memory.ts 的 MEMORY_SUMMARY_LIMIT 对齐） */
const MEMORY_ITEM_MAX = 20;
/** M-03：单次对话最多回传的记忆条数（防模型过量输出） */
const MEMORY_ITEMS_MAX = 5;

/** 记忆回灌上限（服务端防御）：单次最多接受的记忆条数与单条最大字数 */
const MEMORY_RECALL_MAX = 20;
const MEMORY_RECALL_ITEM_MAX = 80;

/** 记忆回灌提示词：追加在 systemContent 末尾，让各模式都吃到长期记忆 */
const MEMORY_RECALL_PROMPT =
  '【用户长期记忆】上下文中的 memories 字段是用户的长期记忆偏好，安排日程、回答问题时必须遵守（如偏好的会议时段、作息习惯），不得与之冲突。';

/* ------------------------------------------------------------------ */
/* X3 推送偏好服务端：savePrefs / getPrefs（轻量 action 分流）           */
/* ------------------------------------------------------------------ */

/**
 * 与前端 src/utils/prefs.ts UserPrefs schema 对齐的校验常量（2026-09 工单：云端 schema 对齐）。
 * 旧 schema 字段 pushEnabled/pushTime/categories 已废弃：出现即丢弃，不做迁移（user_prefs 集合是新动的）。
 */
/** 推送数量三档枚举（PushFreq） */
const PREF_PUSH_FREQS = ['low', 'mid', 'high'];
/** 免打扰时段格式：'HH:mm' 24 小时制 */
const PREF_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 四个推送模块 key（modules 白名单） */
const PREF_MODULE_KEYS = ['weather', 'events', 'news', 'review'];
/** 家长密码格式：4 位数字或空串（空串 = 清除密码） */
const PREF_PIN_RE = /^\d{4}$/;
/** user_prefs 集合（openid 主键 upsert） */
const PREFS_COLLECTION = 'user_prefs';

/**
 * X3/X6/X11/L2 偏好防御清洗（与 prefs.ts UserPrefs 全字段对齐）：
 * 白名单字段 + 布尔/枚举/格式校验，未知字段与旧 schema 字段一律丢弃。
 * 返回清洗后的对象；全部字段不合法或无有效字段时返回 null（视为无效请求）。
 */
function sanitizePrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  // L2：AI 精选总开关
  if (typeof raw.aiFilterEnabled === 'boolean') out.aiFilterEnabled = raw.aiFilterEnabled;
  // X3：推送数量三档
  if (PREF_PUSH_FREQS.indexOf(raw.pushFreq) >= 0) out.pushFreq = raw.pushFreq;
  // X3：免打扰时段起止
  if (typeof raw.dndStart === 'string' && PREF_TIME_RE.test(raw.dndStart)) out.dndStart = raw.dndStart;
  if (typeof raw.dndEnd === 'string' && PREF_TIME_RE.test(raw.dndEnd)) out.dndEnd = raw.dndEnd;
  // X3：按模块开关推送（仅收白名单 4 key）
  if (raw.modules && typeof raw.modules === 'object' && !Array.isArray(raw.modules)) {
    const mods = {};
    PREF_MODULE_KEYS.forEach((k) => {
      if (typeof raw.modules[k] === 'boolean') mods[k] = raw.modules[k];
    });
    if (Object.keys(mods).length > 0) out.modules = mods;
  }
  // X3：周末免打扰 / X6：周末轻量版 / X11：未成年人模式
  if (typeof raw.weekendQuiet === 'boolean') out.weekendQuiet = raw.weekendQuiet;
  if (typeof raw.weekendEdition === 'boolean') out.weekendEdition = raw.weekendEdition;
  if (typeof raw.minorMode === 'boolean') out.minorMode = raw.minorMode;
  // X11：家长密码（4 位数字或空串）
  if (typeof raw.parentPin === 'string' && (raw.parentPin === '' || PREF_PIN_RE.test(raw.parentPin))) {
    out.parentPin = raw.parentPin;
  }
  // 旧 schema 字段（pushEnabled/pushTime/categories）不清洗不迁移，天然被白名单丢弃
  return Object.keys(out).length > 0 ? out : null;
}

/** user_affinity 集合（openid 主键 upsert）：只存「类目名 + 分数」的聚合摘要 */
const AFFINITY_COLLECTION = 'user_affinity';
/** 服务端摘要条数上限（与客户端 exportAffinityForSync 的 10 条口径一致） */
const AFFINITY_ITEMS_MAX = 10;
/** 单条类目名长度上限（与前端 categoryAffinity 的 MAX_CATEGORY_LENGTH 对齐） */
const AFFINITY_CATEGORY_MAX = 16;
/** 分数封顶（与前端封顶口径对齐） */
const AFFINITY_SCORE_MAX = 100;

/**
 * 类目偏好摘要防御清洗（**隐私最小化**）。
 *
 * 只接受 `[{ category: string, score: number }]` 这种**聚合摘要**：绝不接收、也绝不存储
 * 逐条的原始行为日志（哪一条资讯被点了几次、什么时候点的）。原始记录是本机行为数据，
 * 留在客户端 'mb-cat-affinity' 键里就够了，上云只上「哪些类目、各多少分」。
 *
 * 白名单规则（照 sanitizePrefs 的做法）：
 * - 整体不是数组 → 视为空（返回 []，不抛错）；
 * - category：非字符串丢弃；截断 ≤16 字；trim 后为空丢弃；
 * - score：必须是有限数值，裁剪到 [0, 100] 后取整；
 * - 最多保留 10 条（超出直接丢弃）。
 * 返回清洗后的数组（可能为空数组，语义上与 null 区分：空 = 上报了但没有有效条目）。
 */
function sanitizeAffinity(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= AFFINITY_ITEMS_MAX) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.category !== 'string') continue;
    const category = item.category.trim().slice(0, AFFINITY_CATEGORY_MAX);
    if (!category) continue;
    if (typeof item.score !== 'number' || !Number.isFinite(item.score)) continue;
    const score = Math.round(Math.min(AFFINITY_SCORE_MAX, Math.max(0, item.score)));
    out.push({ category, score });
  }
  return out;
}

/** 资讯/热点类联网检索提示词：带来源要点，禁止编造 */
const WEB_NEWS_SYSTEM_PROMPT =
  '你是资讯检索助手。基于联网检索结果回答用户问题：用要点形式输出，每条要点标注来源（媒体名或链接）；禁止编造；检索不到可靠信息时明确写「未能检索到相关资讯」，不要凭训练记忆编造时效性内容。';
/** 购物/对比类联网检索提示词（与 shopping 相同比价纪律） */
const WEB_SHOPPING_SYSTEM_PROMPT =
  '你是购物比价助手。基于联网检索结果，输出该商品的实时比价：每个平台一行（平台名、价格、关键点与来源链接），最后给出最低价结论与一步建议。必须标注数据来源；检索不到可靠信息时明确写「未能获取实时价格，以下为参考建议」，禁止编造精确价格。';

/** 资讯/热点类意图（命中即走联网检索） */
const NEWS_SEARCH_INTENT = /热点|新闻|资讯|最近有什么|今天有什么/;
/** 对比类意图（命中且非 shopping 时走联网检索，同比价纪律） */
const COMPARE_SEARCH_INTENT = /对比|比较|哪款|哪个好|区别/;

/** 工作助手模式提示词（mode=work 时按 workAction 选择；修复 workAction 此前未传给 LLM 导致真机退化为普通聊天的问题） */
const WORK_SYSTEM_PROMPTS = {
  summary:
    '你是用户的工作助手。对用户提供的内容做总结：先一句结论，再分点列出核心内容，最后一行给一个行动建议。输出 JSON：{"reply": "总结(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
  points:
    '你是用户的工作助手。从用户提供的内容中提取 3-6 条关键要点，每条一行、尽量短；末尾附一行「关键数据」（没有就写「无明显数据」）。输出 JSON：{"reply": "要点(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
  advice:
    '你是用户的工作助手。基于用户提供的内容给出 3 条具体可执行的建议，每条说明「做什么、为什么」，不空洞打气。输出 JSON：{"reply": "建议(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。'
};

/** 通用对话基础提示词（既有内容保持不变） */
const BASE_SYSTEM_PROMPT =
  '你是私人晨报助理。基于用户当前日程数据及对话执行指令。输出 JSON：{"reply": "给用户的中文回复(120字内)", "action": "reschedule|done|query|schedule|batch|shopping|chat", "targetId": "事件或待办id或null", "newTime": "YYYY-MM-DD HH:mm或null", "newEvents": null}。改期指令且能定位目标时 action=reschedule；完成指令且能定位时 action=done；询问安排时 action=query；闲聊 action=chat。排班（如「帮我安排周五下午开会」）：对照已有日程找空闲时段，给 1 个建议时段和理由，action=schedule 且 newTime=建议时段，不要写库，等用户回复「确认」后再 reschedule。建议时段须与用户既有日程前后各留 ≥10 分钟间隔（缓冲），不要紧贴相邻日程起止时间（P1-F，与客户端 schedule.ts 的 SCHED_GAP_BUFFER_MINUTES=10 同一口径）。批量/周期排班（如「把周会固定到每周二上午」「下周一站会、周三下午评审、周五复盘」）时 action=batch：newEvents=[{"title":"会议名","startTime":"YYYY-MM-DD HH:mm"}]，周期会议给未来 4 次具体日期，单次批量最多 5 条，直接排入无需确认；reply 里逐条列出排入时间。当识别到购物意图（买、对比、哪个划算、值不值、求推荐商品、想买东西、预算内选什么）时，action=shopping：输出一份选购分析——拆解需求与预算、列出 2-4 个主流平台/方案的关键差异（价格、售后、物流、口碑要点）、给出明确结论和下一步。实时价格、热点资讯、产品对比等时效性问题会基于联网检索作答并标注来源；检索不可用时基于常识回答并明确标注"价格为参考，以平台实时为准"，绝不谎称是实时联网数据。';

/**
 * S-01：排班「先提议后执行」契约（追加在基础提示词之后）。
 * 分流：新建 ≤5 条 → 继续用 action='batch' 直排；涉及改期（带 eventId）→ 一律 action='plan' 只给方案。
 */
const PLAN_CONTRACT_PROMPT =
  '【排班先提议后执行】识别到排班/调整意图时遵守以下分流：① 纯新建且不超过 5 条 —— 用 action="batch"，newEvents=[{"title":"会议名","startTime":"YYYY-MM-DD HH:mm","endTime":"YYYY-MM-DD HH:mm"}]，直接排入。② 涉及改期/挪动已有日程，或用户要求先看方案再定 —— 用 action="plan"，proposals=[{"title":"会议名","fromTime":"原时间 YYYY-MM-DD HH:mm","toTime":"建议新时间 YYYY-MM-DD HH:mm","endTime":"结束时间","eventId":"已有日程 id（新建时省略）"}]，并在 reply 里说明你把它们挪到了哪些时段。**action="plan" 严禁写库**，只输出方案，等用户在卡片上勾选批准后再由客户端调用 action="applyPlan" 落库。proposals 最多 ' +
  MAX_PLAN_ITEMS +
  ' 条。';

/** P-02：购物类回复的文案纪律（三条硬约束，追加在基础提示词之后） */
const SHOPPING_DISCIPLINE_PROMPT =
  '【购物文案纪律，违反即为严重错误】① 购物类回复只允许做三类动作：查价、汇总、价保提示，不得承诺或暗示代为操作。② 当回复或用户指令中出现「下单」「购买」「付款」「代付」等意图词时，回复必须包含免责句：「' +
  SHOPPING_DISCLAIMER +
  '」或「' +
  SHOPPING_REFUSE_REPLY +
  '」。③ 严禁出现「已为你下单」「已帮你购买」「已锁定库存」「已付款」「代你支付」等表述，一旦出现会被服务端拦截改写。④ 价格须标注「' +
  SHOPPING_DISCLAIMER_SOURCE +
  '」，涉及已购/待购商品时另附「' +
  SHOPPING_PRICE_GUARD +
  '」。';

/** M-03：记忆抽取契约 —— 从对话中识别值得长期记住的稳定偏好（追加在基础提示词之后） */
const MEMORY_CONTRACT_PROMPT =
  '【记忆抽取】当用户表达了**稳定的个人偏好、习惯或长期事实**（如「我一般上午开会」「我不喝咖啡」「我住在杭州」「叫我老王」）时，在输出 JSON 中额外加一个字段 memories，值为字符串数组，每条形如「偏好在上午开会」「不喝咖啡」，每条不超过 20 字。只抽取跨对话仍然成立的信息，**不要**抽取一次性任务、临时安排或当次对话的琐事（如「明天三点开会」不抽取）。没有值得记住的内容时省略该字段或置为空数组。';

/** 通用对话完整提示词 */
const DEFAULT_SYSTEM_PROMPT =
  BASE_SYSTEM_PROMPT + PLAN_CONTRACT_PROMPT + SHOPPING_DISCIPLINE_PROMPT + MEMORY_CONTRACT_PROMPT;

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getUsage(openid) {
  const res = await db
    .collection('usage')
    .where({ openid, month: monthStart() })
    .limit(1)
    .get();
  if (res.data.length > 0) return res.data[0];
  const doc = { openid, month: monthStart(), voiceUsed: 0, updatedAt: new Date().toISOString() };
  await db.collection('usage').add({ data: doc });
  return doc;
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get();
  return res.data.length > 0 ? res.data[0] : null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
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

/** 购物清单操作：读 / 添加 / 标记已买 / 记比价（真机 AI 也认领购物清单） */
async function handleShoppingList(openid, message) {
  const col = db.collection('shopping');
  const list = () => col.where({ openid }).orderBy('createdAt', 'desc').limit(100).get();

  // 1) 添加：「把 XX 加进/加入/添加到 购物清单」或「购物清单加 XX」
  const addMatch = message.match(/把?([\u4e00-\u9fa5A-Za-z0-9（）()]{1,16}?)(?:加(?:入|进)|添加到|加到|记入)购物清单/);
  if (addMatch) {
    const name = addMatch[1].trim();
    await col.add({ data: { openid, name, bought: false, createdAt: new Date().toISOString(), prices: [] } });
    return { reply: `✅ 已把「${name}」加进购物清单。说「帮我看下购物清单」就能展示，或去「我的 → 购物清单」记比价。`, action: 'shopping' };
  }

  const res = await list();
  const items = res.data;

  // 2) 标记已买：「把 XX 标记已买」
  const doneMatch = message.match(/(?:把)?\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{2,16})\s*(?:标记)?(?:为)?已买/);
  if (doneMatch) {
    const name = doneMatch[1];
    const hit = items.find((it) => !it.bought && it.name.includes(name));
    if (hit) {
      await col.doc(hit._id).update({ data: { bought: true } });
      return { reply: `🎉 已把「${hit.name}」标记为已买，为你记账。`, action: 'shopping' };
    }
    return { reply: `清单里没找到「${name}」。可以说「把${name}加进购物清单」添加。`, action: 'shopping' };
  }

  // 3) 读取清单
  if (/购物清单|清单/.test(message)) {
    const notBought = items.filter((it) => !it.bought);
    if (notBought.length === 0) {
      return {
        reply: items.length === 0
          ? '🛒 购物清单还是空的。说「把XX加进购物清单」就能添加想买的东西。'
          : `🛒 你清单里 ${items.filter((it) => it.bought).length} 件都已买了，没有待购的。要加新的就说「把XX加进购物清单」。`,
        action: 'shopping'
      };
    }
    const lines = [`🛒 你购物清单里还有 ${notBought.length} 件待购：`];
    notBought.forEach((it, i) => {
      const tag = it.prices && it.prices.length
        ? `（已比价，最低￥${Math.min(...it.prices.map((p) => p.price))}）`
        : it.targetPrice
          ? `（目标 ￥${it.targetPrice}，未比价）`
          : '（未比价）';
      lines.push(`${i + 1}. ${it.name} ${tag}`);
    });
    lines.push('\n需要的话我可以帮其中某件做比价分析，或说「把XX标记已买」。');
    return { reply: lines.join('\n'), action: 'shopping' };
  }

  return null;
}

/** 规则兜底：LLM 不可用时保证基础指令可用 */
async function ruleFallback(openid, message) {
  if (/完成|办完|搞定了/.test(message)) {
    const todos = await db
      .collection('todos')
      .where({ openid, status: 'confirmed' })
      .orderBy('dueDate', 'asc')
      .limit(1)
      .get();
    if (todos.data.length > 0) {
      await db.collection('todos').doc(todos.data[0]._id).update({ data: { status: 'done' } });
      return { reply: `已把「${todos.data[0].title}」标记完成。`, action: 'todo_done' };
    }
  }
  const todosRes = await db
    .collection('todos')
    .where({ openid, status: 'confirmed' })
    .orderBy('dueDate', 'asc')
    .limit(5)
    .get();
  const eventsRes = await db
    .collection('events')
    .where({ openid, status: 'confirmed' })
    .orderBy('startTime', 'asc')
    .limit(5)
    .get();
  const lines = [];
  if (eventsRes.data.length > 0) {
    lines.push(`你有 ${eventsRes.data.length} 个日程：${eventsRes.data.map((e) => e.title).join('、')}`);
  }
  if (todosRes.data.length > 0) {
    lines.push(`${todosRes.data.length} 项待办：${todosRes.data.map((t) => t.title).join('、')}`);
  }
  return { reply: lines.join('\n') || '你目前没有日程和待办，享受清净吧。', action: 'query' };
}

/* ------------------------------------------------------------------ */
/* P-02 购物文案兜底改写（服务端最后一道防线，失败不影响正常回复）        */
/* ------------------------------------------------------------------ */

/**
 * 购物类回复兜底：
 * ① 命中禁止表述 → 整条替换为拒答话术
 * ② 命中下单/购买/付款/代付 意图且回复不含免责句 → 追加拒答话术
 */
function sanitizeShoppingReply(reply, message) {
  const text = String(reply || '');
  if (!text) return text;
  const hitForbidden = SHOPPING_FORBIDDEN_PATTERNS.some((re) => re.test(text));
  if (hitForbidden) return SHOPPING_REFUSE_REPLY;
  const hasDisclaimer =
    text.indexOf(SHOPPING_DISCLAIMER) >= 0 ||
    text.indexOf(SHOPPING_DISCLAIMER_SOURCE) >= 0 ||
    text.indexOf(SHOPPING_REFUSE_REPLY) >= 0;
  const hitIntent = SHOPPING_ORDER_INTENT.test(text) || SHOPPING_ORDER_INTENT.test(String(message || ''));
  if (hitIntent && !hasDisclaimer) return `${text}\n${SHOPPING_REFUSE_REPLY}`;
  return text;
}

/**
 * 通用联网检索回复：调 callLLMWebSearch（通义 enable_search）。
 * 未配置 LLM_WEB_API_KEY 或检索失败时返回 null，由调用方保留主模型回答，绝不阻塞对话。
 */
async function webSearchReply(systemPrompt, message) {
  try {
    const reply = await callLLMWebSearch(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      false
    );
    return reply ? String(reply) : null;
  } catch (err) {
    console.warn('[chat] web search failed, keep main-model reply:', err && err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* S-01 排班：现有日程查询（补 title / fromTime）                        */
/* ------------------------------------------------------------------ */

/** 按 id 查日程：优先用已加载的上下文缓存，未命中再查库；不属于本人返回 null */
async function lookupEvent(openid, id, cache) {
  if (!id) return null;
  if (Array.isArray(cache)) {
    const hit = cache.find((e) => e && e._id === id);
    if (hit) return hit;
  }
  try {
    const res = await db.collection('events').doc(id).get();
    if (res.data && res.data.openid === openid) return res.data;
  } catch (err) {
    console.warn('[chat] lookupEvent failed:', err && (err.errMsg || err.message));
  }
  return null;
}

/**
 * 分流归一化（主理人拍板规则）：
 * - batch 且任意条目带 eventId（涉及改期）→ 转 action='plan'，不写库
 * - reschedule（单条改期）→ 转 action='plan'，不写库（PLAN_PREVIEW_FOR_RESCHEDULE 可关）
 * - 纯新建 batch → 维持 action='batch' 直排
 */
async function normalizePlanAction(openid, result, eventCache) {
  if (!result || typeof result !== 'object') return result;

  if (result.action === 'batch' && Array.isArray(result.newEvents)) {
    const hasEventId = result.newEvents.some((e) => e && e.eventId);
    if (hasEventId) {
      const proposals = [];
      const list = result.newEvents.slice(0, MAX_PLAN_ITEMS);
      for (let i = 0; i < list.length; i += 1) {
        const e = list[i] || {};
        const evt = e.eventId ? await lookupEvent(openid, String(e.eventId), eventCache) : null;
        proposals.push({
          title: String(e.title || (evt && evt.title) || '日程').slice(0, MAX_TITLE_LEN),
          fromTime: (evt && evt.startTime) || '',
          toTime: String(e.startTime || (evt && evt.startTime) || ''),
          endTime: e.endTime ? String(e.endTime) : '',
          eventId: e.eventId ? String(e.eventId) : ''
        });
      }
      result.newEvents = undefined;
      result.action = 'plan';
      result.proposals = proposals.filter((p) => TIME_RE.test(p.toTime));
      return result;
    }
  }

  if (PLAN_PREVIEW_FOR_RESCHEDULE && result.action === 'reschedule' && result.targetId && result.newTime) {
    const evt = await lookupEvent(openid, String(result.targetId), eventCache);
    result.action = 'plan';
    result.proposals = [
      {
        title: String((evt && evt.title) || '日程').slice(0, MAX_TITLE_LEN),
        fromTime: (evt && evt.startTime) || '',
        toTime: String(result.newTime),
        endTime: '',
        eventId: String(result.targetId)
      }
    ].filter((p) => TIME_RE.test(p.toTime));
    result.targetId = null;
    result.newTime = null;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* S-01 落库：action='applyPlan'                                        */
/* ------------------------------------------------------------------ */

/**
 * 排班方案落库：eventId 存在走 update，否则 add。
 * 返回协议：{ code, message, data:{ saved, ids, proposalId } }。
 * 单条失败只 console.warn，不影响其余条目；全部失败也返回 code=0 + saved=0（不阻断对话）。
 */
async function handleApplyPlan(openid, event) {
  const proposalId = (event && event.proposalId) ? String(event.proposalId) : '';
  const raw = event && Array.isArray(event.events) ? event.events : [];
  const items = raw
    .slice(0, MAX_APPLY_EVENTS)
    .map((e) => ({
      eventId: e && e.eventId ? String(e.eventId) : '',
      title: String((e && e.title) || '日程').slice(0, MAX_TITLE_LEN),
      startTime: String((e && e.startTime) || ''),
      endTime: e && e.endTime ? String(e.endTime) : ''
    }))
    .filter((e) => TIME_RE.test(e.startTime));

  if (items.length === 0) {
    return { code: 0, message: 'no valid event', data: { saved: 0, ids: [], proposalId } };
  }

  const ids = [];
  const now = new Date().toISOString();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      if (item.eventId) {
        // 改期：校验归属后只更新时间字段
        const doc = await db.collection('events').doc(item.eventId).get();
        if (!doc.data || doc.data.openid !== openid) continue;
        const update = { startTime: item.startTime, updatedAt: now };
        if (TIME_RE.test(item.endTime)) update.endTime = item.endTime;
        await db.collection('events').doc(item.eventId).update({ data: update });
        ids.push(item.eventId);
      } else {
        const doc = {
          openid,
          title: item.title,
          startTime: item.startTime,
          status: 'confirmed',
          source: 'AI 排班方案',
          createdAt: now
        };
        if (TIME_RE.test(item.endTime)) doc.endTime = item.endTime;
        const add = await db.collection('events').add({ data: doc });
        if (add && add._id) ids.push(add._id);
      }
    } catch (err) {
      console.warn('[chat] applyPlan item failed:', err && (err.errMsg || err.message));
    }
  }

  return { code: 0, message: 'ok', data: { saved: ids.length, ids, proposalId } };
}

/** 内容安全拒答话术（命中 msgSecCheck 时使用）。不暴露具体命中原因，避免被用来试探规则。 */
const CHAT_REFUSE_REPLY = '抱歉，这条内容我不能处理。请换一个说法，或者换个话题聊聊？';

/**
 * 内容安全：过微信 msgSecCheck。返回 true=放行，false=命中违规需拒答。
 *
 * 【为什么必须加】本函数是**深度合成（AI 问答）**的主要出口，微信《小程序深度合成服务运营指引》
 * 把「用户输入内容」与「深度合成输出内容」的内容安全检测列为**强制项**，也是代码审核的
 * 常见驳回原因。extract / getBriefing 早已接入（见各自 config.json 声明的
 * `security.msgSecCheck` 权限），chat 此前**完全缺失** —— 审核会因「输入/输出存在安全风险」驳回。
 *
 * 【异常时 fail-open】与 extract 的既有做法一致：接口抖动时不阻断主流程，只告警。
 * 理由是聊天是主交互路径，因安全接口超时把整条对话打断，用户损失大于收益；
 * 代价是异常窗口内的内容不过检 —— 已在日志里显式标出（`skipped`），便于事后归因。
 */
async function securityCheck(content, openid) {
  const text = String(content || '').slice(0, 2500);
  if (!text.trim()) return true;
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      openid,
      scene: 1,
      content: text
    });
    if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[chat] msgSecCheck skipped:', err && err.errMsg);
    return true;
  }
}

exports.main = async (event) => {
  // 身份只认微信上下文：本函数跑在微信云开发里，`cloud.getWXContext().OPENID` 才是权威身份。
  // **不接受 event.openid** —— 接受调用方自传的身份，等于让调用方自证身份（谁都能填别人的 openid）；
  // 平台文档（cloud-service/references/database/code-generation.md）也明确要求身份由会话自动附带、
  // 不得由客户端传 user id/openid。H5 侧要读用户数据，应在应用数据库建 PostgreSQL 函数用 auth.uid()。
  // 取不到就拒绝：chat 会读写 todos / events / user_prefs / user_affinity / shopping / usage
  // 六个集合，openid 为 undefined 会让所有用户互相可见对方数据。
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('no openid');
  const message = (event && event.message ? String(event.message) : '').trim();
  const deep = !!(event && event.deep);
  const mode = event && event.mode;
  const workAction = event && event.workAction;
  const action = event && event.action;

  // 记忆回灌：前端随请求带来的用户长期记忆（服务端防御性清洗，超限截断）
  const memories = Array.isArray(event && event.memories)
    ? event.memories
        .filter((m) => typeof m === 'string' && m.trim())
        .map((m) => m.trim().slice(0, MEMORY_RECALL_ITEM_MAX))
        .slice(0, MEMORY_RECALL_MAX)
    : [];

  // S-01 落库分支：独立返回 { code, message, data }，不消耗语音额度、不需要 message
  // （前端 apiApplyPlan 只传 action='applyPlan' + events，没有 message）
  if (action === 'applyPlan') {
    return handleApplyPlan(OPENID, event);
  }

  // X3 推送偏好上报：event.prefs 白名单清洗后按 openid 主键 upsert 到 user_prefs 集合。
  // 独立分流：不消耗语音额度、不需要 message。
  if (action === 'savePrefs') {
    const prefs = sanitizePrefs(event && event.prefs);
    if (!prefs) return { saved: false, error: 'invalid prefs' };
    const now = new Date().toISOString();
    const existing = await db.collection(PREFS_COLLECTION).where({ openid: OPENID }).limit(1).get();
    if (existing.data.length > 0) {
      await db.collection(PREFS_COLLECTION).doc(existing.data[0]._id).update({
        data: { ...prefs, updatedAt: now }
      });
    } else {
      await db.collection(PREFS_COLLECTION).add({
        data: { openid: OPENID, ...prefs, createdAt: now, updatedAt: now }
      });
    }
    return { saved: true };
  }

  // X3 推送偏好读取：返回该 openid 的偏好。savePrefs 把 prefs 字段展开存在文档顶层，
  // 这里用 sanitizePrefs 再清洗一次：剔除 openid/_id/createdAt/updatedAt 等非 prefs 字段
  // 与旧 schema 残留，只回传对齐 schema 的字段；从未上报过返回 { prefs: null }
  if (action === 'getPrefs') {
    const existing = await db.collection(PREFS_COLLECTION).where({ openid: OPENID }).limit(1).get();
    if (existing.data.length === 0) return { prefs: null };
    return { prefs: sanitizePrefs(existing.data[0]) };
  }

  // 类目偏好摘要上报：event.affinity 白名单清洗后按 openid 主键 upsert 到 user_affinity 集合。
  // 【隐私最小化】只存「类目名 + 分数」的聚合摘要，逐条原始行为日志一律不接收、不存储
  // （见 sanitizeAffinity 的说明）。独立分流：不消耗语音额度、不需要 message。
  // 与 savePrefs 的差别：非数组直接判为无效请求；是数组（哪怕清洗后为空）都照常落库。
  if (action === 'saveAffinity') {
    if (!Array.isArray(event && event.affinity)) return { saved: false, error: 'invalid affinity' };
    const affinity = sanitizeAffinity(event.affinity);
    const now = new Date().toISOString();
    const existing = await db.collection(AFFINITY_COLLECTION).where({ openid: OPENID }).limit(1).get();
    if (existing.data.length > 0) {
      await db
        .collection(AFFINITY_COLLECTION)
        .doc(existing.data[0]._id)
        .update({ data: { affinity, updatedAt: now } });
    } else {
      await db
        .collection(AFFINITY_COLLECTION)
        .add({ data: { openid: OPENID, affinity, createdAt: now, updatedAt: now } });
    }
    return { saved: true, count: affinity.length };
  }

  // 类目偏好摘要读取：返回该 openid 的摘要。与 getPrefs 同理，用 sanitizeAffinity 再清洗一次
  // （剔除 openid/_id/createdAt/updatedAt 等非 affinity 字段与脏数据）；从未上报返回 { affinity: null }。
  if (action === 'getAffinity') {
    const existing = await db.collection(AFFINITY_COLLECTION).where({ openid: OPENID }).limit(1).get();
    if (existing.data.length === 0) return { affinity: null };
    const affinity = sanitizeAffinity(existing.data[0].affinity);
    return { affinity: affinity.length > 0 ? affinity : null };
  }

  if (!message) throw new Error('message is required');

  // 用户输入过内容安全（深度合成类目强制项）。放在额度校验之前：违规内容不该消耗用户语音额度。
  if (!(await securityCheck(message, OPENID))) {
    return { reply: CHAT_REFUSE_REPLY, action: 'chat' };
  }

  // 额度校验：订阅用户不限次
  const user = await getUser(OPENID);
  const isSubscribed = !!(user && user.subscribed && user.expiredAt && new Date(user.expiredAt) > new Date());
  if (!isSubscribed) {
    const usage = await getUsage(OPENID);
    if (usage.voiceUsed >= FREE_VOICE_QUOTA) {
      throw new Error('voice quota exceeded, please subscribe');
    }
    await db.collection('usage').doc(usage._id).update({
      data: { voiceUsed: _.inc(1), updatedAt: new Date().toISOString() }
    });
  }

  // 购物清单指令优先于通用对话（读 / 加 / 勾买都直接落库）
  if (
    /购物清单|清单/.test(message) &&
    (/(有|看|展示|列|查|显示|还剩|还有什么)/.test(message) ||
      /(把|将|加|加入|添加|记下)/.test(message) ||
      /买|已买|入手|搞定/.test(message))
  ) {
    const shop = await handleShoppingList(OPENID, message);
    if (shop) {
      // P-02：购物清单回复同样过一遍文案兜底
      return { ...shop, reply: sanitizeShoppingReply(shop.reply, message) };
    }
  }

  // 上下文：近 5 条日程 + 5 条待办（+ 用户长期记忆）
  const [eventsRes, todosRes] = await Promise.all([
    db.collection('events').where({ openid: OPENID, status: 'confirmed' }).orderBy('startTime', 'asc').limit(5).get(),
    db.collection('todos').where({ openid: OPENID, status: 'confirmed' }).orderBy('dueDate', 'asc').limit(5).get()
  ]);
  const contextData = {
    now: `${new Date().toLocaleDateString('sv-SE')} ${new Date().toTimeString().slice(0, 5)}`,
    events: eventsRes.data.map((e) => ({ id: e._id, title: e.title, startTime: e.startTime })),
    todos: todosRes.data.map((t) => ({ id: t._id, title: t.title, dueDate: t.dueDate }))
  };
  if (memories.length > 0) contextData.memories = memories;
  const context = JSON.stringify(contextData);

  let result;
  try {
    let systemContent =
      mode === 'work'
        ? WORK_SYSTEM_PROMPTS[workAction] || WORK_SYSTEM_PROMPTS.summary
        : deep
          ? '你是用户的深度思考伙伴。用户抛出纠结或问题时，帮其拆解：1) 关键矛盾是什么 2) 各选项的利弊 3) 给出一个可执行的下一步。语气克制友好，不空洞打气。输出 JSON：{"reply": "给用户的中文回复(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。'
          : DEFAULT_SYSTEM_PROMPT;
    // 记忆回灌：有长期记忆时在 system 层显式声明必须遵守（work/deep/默认模式都吃到）
    if (memories.length > 0) systemContent += MEMORY_RECALL_PROMPT;
    const raw = await callLLM(
      [
        { role: 'system', content: systemContent },
        { role: 'user', content: `我的数据：${context}\n我的指令：${message}` }
      ],
      true
    );
    result = safeParse(raw);
  } catch (err) {
    console.warn('[chat] LLM failed, fallback to rules:', err && err.message);
  }

  if (!result || !result.reply) {
    if (mode === 'work') {
      return { reply: 'AI 服务暂时不可用，请稍后再试，或把内容拆短一些重试。', action: 'chat' };
    }
    const fallback = await ruleFallback(OPENID, message);
    return fallback;
  }

  // 联网检索扩面：shopping（比价纪律）、资讯/热点类（带来源要点，不做购物兜底改写）、
  // 对比类（同比价纪律）。未配置 LLM_WEB_API_KEY 或检索失败时保留主模型回答，不阻塞对话。
  let usedWebSearch = false;
  if (result.action === 'shopping') {
    const webReply = await webSearchReply(WEB_SHOPPING_SYSTEM_PROMPT, message);
    if (webReply) {
      result.reply = webReply;
      usedWebSearch = true;
    }
    // P-02：联网比价文案同样过一遍兜底改写（禁语拦截 + 免责句补齐）
    result.reply = sanitizeShoppingReply(result.reply, message);
  } else if (NEWS_SEARCH_INTENT.test(message)) {
    const webReply = await webSearchReply(WEB_NEWS_SYSTEM_PROMPT, message);
    if (webReply) {
      result.reply = webReply;
      usedWebSearch = true;
    }
  } else if (COMPARE_SEARCH_INTENT.test(message)) {
    const webReply = await webSearchReply(WEB_SHOPPING_SYSTEM_PROMPT, message);
    if (webReply) {
      result.reply = webReply;
      usedWebSearch = true;
    }
  }

  // S-01 分流归一化：涉及改期（有 eventId）一律降级为 action='plan' 预览，不写库
  await normalizePlanAction(OPENID, result, eventsRes.data);

  // 执行动作
  if (result.action === 'reschedule' && result.targetId && result.newTime) {
    try {
      const evt = await db.collection('events').doc(result.targetId).get();
      if (evt.data && evt.data.openid === OPENID) {
        await db.collection('events').doc(result.targetId).update({
          data: { startTime: result.newTime }
        });
      }
    } catch (err) {
      console.warn('[chat] reschedule failed:', err && err.errMsg);
    }
  } else if (result.action === 'done' && result.targetId) {
    try {
      const todo = await db.collection('todos').doc(result.targetId).get();
      if (todo.data && todo.data.openid === OPENID) {
        await db.collection('todos').doc(result.targetId).update({
          data: { status: 'done' }
        });
      }
    } catch (err) {
      console.warn('[chat] done failed:', err && err.errMsg);
    }
  } else if (result.action === 'batch' && Array.isArray(result.newEvents) && result.newEvents.length > 0) {
    // F24 批量/周期排班：LLM 解析出的多条日程一次落库（服务端 add 支持数组批量写入）
    // 说明：走到这里说明是「纯新建」（normalizePlanAction 已把带 eventId 的改期转为 plan）
    const docs = result.newEvents
      .slice(0, MAX_BATCH_EVENTS)
      .map((e) => ({
        openid: OPENID,
        title: String((e && e.title) || '日程').slice(0, MAX_TITLE_LEN),
        startTime: String((e && e.startTime) || ''),
        status: 'confirmed',
        source: 'AI 批量排班',
        createdAt: new Date().toISOString()
      }))
      .filter((d) => TIME_RE.test(d.startTime));
    if (docs.length > 0) {
      try {
        await db.collection('events').add({ data: docs });
      } catch (err) {
        console.warn('[chat] batch schedule failed:', err && err.errMsg);
      }
    }
  }

  // 工作助手/深思/联网检索/批量排班/排班方案回复较长，放宽截断；普通对话维持 120 字
  const longReply =
    deep ||
    mode === 'work' ||
    usedWebSearch ||
    result.action === 'shopping' ||
    result.action === 'batch' ||
    result.action === 'plan';
  const maxLen = longReply ? 500 : 120;
  let replyText = String(result.reply).slice(0, maxLen);
  // 注意：plan 的免责/说明类文案由 sanitizeShoppingReply 在截断前补齐，此处不再追加


  // AI 发图：热点/资讯类查询附带真实资讯封面图（webSearch RSS 抽取，1h 缓存零成本；失败不影响回复）
  let image = undefined;
  if (/热点|新闻|资讯|热搜/.test(String(message))) {
    try {
      const hs = await cloud.callFunction({ name: 'webSearch', data: { action: 'hotspot' } });
      const payload = hs && hs.result;
      const first = payload && payload.code === 0 && Array.isArray(payload.data) ? payload.data[0] : null;
      if (first && first.image) {
        image = first.image;
        if (!replyText.includes(first.title)) {
          replyText = `${replyText}\n📰 ${first.title}（来源：${first.source}）`;
        }
      }
    } catch (err) {
      console.warn('[chat] news image attach failed:', err && (err.errMsg || err.message));
    }
  }

  // P-02 最后一道防线：任何 action 的回复都不允许出现禁止表述（命中即整条替换为拒答话术）
  if (SHOPPING_FORBIDDEN_PATTERNS.some((re) => re.test(replyText))) {
    replyText = SHOPPING_REFUSE_REPLY;
  }

  // 深度合成**输出**侧内容安全（与输入侧同为类目强制项）。放在最后一道禁语防线之后、
  // 组装 payload 之前 —— 此处 replyText 已是最终将要返回给用户的文本（含联网改写、截断、配图追加）。
  if (!(await securityCheck(replyText, OPENID))) {
    replyText = CHAT_REFUSE_REPLY;
  }

  const payload = { reply: replyText, action: result.action || 'chat', image };
  // S-01：action='plan' 时把方案原文带回前端，由 schedule.ts 组装卡片（云侧不写库）
  if (result.action === 'plan' && Array.isArray(result.proposals) && result.proposals.length > 0) {
    payload.proposals = result.proposals;
  }
  // M-03：把模型抽取的长期偏好带回前端，由 memory.ts 落 storage 并展示可撤销 toast
  if (Array.isArray(result.memories)) {
    const memories = result.memories
      .map((m) => String(m || '').trim().slice(0, MEMORY_ITEM_MAX))
      .filter(Boolean)
      .slice(0, MEMORY_ITEMS_MAX);
    if (memories.length > 0) payload.memories = memories;
  }
  return payload;
};
