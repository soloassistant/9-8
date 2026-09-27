const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('sv-SE');
}

function greetingByHour(hour) {
  if (hour < 6) return '夜深了，先看看明天的安排';
  if (hour < 11) return '早上好，新的一天从晨报开始';
  if (hour < 14) return '中午好，下午的日程在这';
  if (hour < 18) return '下午好，别忘了待办清单';
  return '晚上好，为明天做好准备';
}

// ---------- 自适应信号（F21，前端 src/utils/adaptive.ts 的云函数内联版） ----------
// 云函数环境无 dayjs，用原生 Date 保持同一排序口径：mock 与真机晨报一致
const TRAVEL_KEYWORDS = /(机场|航班|飞机|高铁|火车|动车|出差|出发)/;
const URGENT_KEYWORDS = /(尽快|急|务必|今天必须|上午要)/;
const DEFAULT_EVENT_MINUTES = 60;

// ---------- 定时任务（runScheduled）----------
/** 定时任务并发度：纯串行会在几十个用户后撞上云函数超时，其后的人当天静默无晨报 */
const SCHEDULED_CONCURRENCY = 10;
/** 定时任务时间预算（毫秒）：留足余量主动退出，避免被云函数超时硬截断后无人知晓 */
const SCHEDULED_DEADLINE_MS = 15000;
/** 单次定时任务拉取的用户数上限。受 SCHEDULED_DEADLINE_MS 预算约束：1000 在 15s 预算下
 *  永远跑不完（超出部分会被明确计入 skipped，不再静默截断），属已知上限；
 *  真正规模化需要 fan-out/续跑，当前用户量下不引入那套复杂度。 */
const SCHEDULED_USER_BATCH_MAX = 1000;

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function computeAdaptive(events, todos) {
  const now = new Date();

  // 1) 日程爆满（≥4 项或总时长 ≥5h）→ 日程区前置
  const todayEvents = events.filter((e) => {
    const s = new Date(e.startTime);
    return !isNaN(s) && sameDay(s, now);
  });
  const busyMinutes = todayEvents.reduce((sum, e) => {
    let mins = DEFAULT_EVENT_MINUTES;
    if (e.endTime) {
      const diff = (new Date(e.endTime) - new Date(e.startTime)) / 60000;
      if (diff > 0) mins = diff;
    }
    return sum + mins;
  }, 0);
  const busyDay = todayEvents.length >= 4 || busyMinutes >= 300;

  // 2) 次日外地行程 → 提取目的地城市（情报切目的地天气）
  const tomorrow = new Date(now.getTime() + 86400000);
  const tripEvent = events.find((e) => {
    const s = new Date(e.startTime);
    if (isNaN(s) || !sameDay(s, tomorrow)) return false;
    return TRAVEL_KEYWORDS.test(`${e.title || ''} ${e.location || ''} ${e.source || ''}`);
  });
  let tripCity = null;
  if (tripEvent) {
    const text = `${tripEvent.title || ''} ${tripEvent.location || ''}`;
    const m = text.match(/(?:去|到|飞|抵达|前往)\s*([\u4e00-\u9fa5]{2,6})/);
    tripCity = m ? m[1] : (tripEvent.location || '').replace(/\s/g, '').slice(0, 6) || null;
  }

  // 3) 高优待办：今天 12:00 前到期或含紧急词，取最早一条
  const focus = todos
    .filter((t) => t.status !== 'done' && t.dueDate)
    .filter((t) => {
      const d = new Date(t.dueDate);
      return !isNaN(d) && sameDay(d, now) && (d.getHours() < 12 || URGENT_KEYWORDS.test(t.title || ''));
    })
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];

  return { busyDay, tripCity, focusTodo: focus ? focus.title : null, busyMinutes, todayCount: todayEvents.length };
}

// ---------- 本周复盘（P1-G，前端 src/utils/weeklyReview.ts 的云函数内联版） ----------
// 口径必须一致：与 src/utils/weeklyReview.ts 的 computeWeeklyReview 保持同一算法、同一停用词表、
// 同一窗口定义（now 当天 00:00 起往前共 7 天含今天，闭区间），任何一侧改动必须同步另一侧。
const ZH_STOP_CHARS = new Set(
  '的吗呢吧啊呀哦嘛了着过在和与及或也很就都还把被让给从到地对得之其这那有个不用里上中为以但等再又才'.split('')
);
const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'of', 'to', 'a', 'in', 'on', 'at', 'is', 'are', 'be', 'am',
  'with', 'my', 'me', 'it', 'this', 'that', 'by', 'from', 'or', 'as', 'will',
  'can', 'has', 'have', 'had', 'do', 'does', 'not', 'no', 'yes', 'ok', 'pm', 'am'
]);

function weeklyInWindow(dateStr, now) {
  if (!dateStr) return false;
  const d = new Date(String(dateStr).replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  return d.getTime() >= start && d.getTime() <= end;
}

function weeklyExtractTokens(title) {
  if (!title) return [];
  const tokens = [];
  const zhRuns = String(title).match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      let stopped = false;
      for (const ch of bigram) {
        if (ZH_STOP_CHARS.has(ch)) {
          stopped = true;
          break;
        }
      }
      if (!stopped) tokens.push(bigram);
    }
  }
  const words = String(title).toLowerCase().match(/[a-z]{3,}/g) || [];
  for (const w of words) {
    if (!EN_STOPWORDS.has(w)) tokens.push(w);
  }
  return tokens;
}

/** 本周复盘统计：todosDone=窗口内 done 待办数（窗口锚点 dueDate||createTime）、eventCount=窗口内日程数（锚点 startTime）、
 *  keywords=窗口内 event/todo 标题合并计频 top5（中文 2 字滑窗 bigram / 英文小写整词 ≥3 字母，出现 ≥2 次才保留） */
function computeWeeklyReview(events, todos, now = new Date()) {
  const weekEvents = (events || []).filter((e) => weeklyInWindow(e && e.startTime, now));
  const weekTodos = (todos || []).filter((t) => weeklyInWindow(t && (t.dueDate || t.createTime), now));
  const todosDone = weekTodos.filter((t) => t.status === 'done').length;

  const freq = new Map();
  const bump = (token) => freq.set(token, (freq.get(token) || 0) + 1);
  weekEvents.forEach((e) => weeklyExtractTokens(e.title).forEach(bump));
  weekTodos.forEach((t) => weeklyExtractTokens(t.title).forEach(bump));

  const keywords = Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]) // 稳定排序：同频保持首次出现序
    .slice(0, 5)
    .map(([word]) => word);

  return { todosDone, eventCount: weekEvents.length, keywords };
}

// ---------- 收尾冷知识（X7）+ 周末轻量版（X6） ----------
// 冷知识池：无害的科技/生活冷知识。选取必须**确定性**（日期 % 池长度），同一天缓存与重拉结果一致；
// 口径与前端 src/data/getBriefing.ts 完全一致（dateStr 去掉 '-' 后的数字 % 池长度），任何一侧改动必须同步另一侧。
const TRIVIA_POOL = [
  '蜂蜜是极少数几乎不会变质的食物之一，考古学家曾在古墓中发现三千年前仍可食用的蜂蜜。',
  '章鱼有三颗心脏，其中两颗负责给鳃供血，一颗负责全身循环。',
  '香蕉在植物学上属于浆果，而草莓反而不是。',
  '闪电通道的温度可达约三万摄氏度，接近太阳表面温度的五倍。',
  '人类大脑约六成由脂肪构成，是体内脂肪比例最高的器官之一。',
  '蜂鸟是唯一能倒着飞的鸟类。',
  '猫的鼻纹和人类指纹一样，独一无二。',
  '长颈鹿的脖子虽然很长，但颈椎只有七块，和人类一样多。',
  '咖啡豆其实是咖啡树的种子，植物学上并不属于豆类。',
  '微波炉的发明灵感，来自工程师口袋里被雷达设备融化的巧克力。',
  '骆驼的驼峰里储存的是脂肪，而不是水。',
  '打喷嚏时的气流速度可以超过每小时一百五十公里。',
  '北极熊的皮肤其实是黑色的，毛发是透明中空的。',
  '太空没有大气散射，宇航员看到的太空背景是纯黑色的，即使身处「白天」。',
  '世界上最短的商用机场跑道位于加勒比海的萨巴岛，只有约四百米。',
  '鸵鸟的眼睛比它的大脑还大。'
];

/** 确定性选取当日冷知识：日期数字 % 池长度（不用随机数，同日恒定） */
function pickTrivia(dateStr) {
  const n = Number(String(dateStr).replace(/-/g, '')) || 0;
  return TRIVIA_POOL[n % TRIVIA_POOL.length];
}

/** X6 周末轻量版：周六/周日生成时标记 weekendEdition（工作日缺省不标记） */
function isWeekendToday() {
  const dow = new Date().getDay();
  return dow === 0 || dow === 6;
}

/**
 * X6 周末资讯减量：条数减半（min 2 条）。
 * 只在周末标记存在时调用；条目本身 ≤2 条或减半后不足 2 条时保持原样（不少于 2 条语义）。
 */
function trimIntelForWeekend(intel) {
  if (!intel || !Array.isArray(intel.intelItems)) return intel;
  const n = intel.intelItems.length;
  if (n <= 2) return intel;
  const keep = Math.max(2, Math.floor(n / 2));
  if (keep >= n) return intel;
  return { ...intel, intelItems: intel.intelItems.slice(0, keep) };
}

// ---------- 降价提醒（P-01）----------
// 零 API 成本：不主动抓价，只在「晨报生成时」读 shopping 集合里已有的价格记录做比对。
// 算法与前端 src/utils/price.ts 的 evaluatePriceAlerts 保持一致（云函数无 dayjs，纯原生实现）。
// 命中条件：最低记录价 <= 心理价位，且与 lastNotifiedPrice 不同（同价位不重复提醒）。
function evaluatePriceAlerts(items) {
  const alerts = [];
  for (const item of items || []) {
    const target = Number(item && item.targetPrice);
    if (!isFinite(target) || target <= 0) continue;

    const prices = Array.isArray(item.prices) ? item.prices : [];
    let lowest = null;
    for (const record of prices) {
      const price = Number(record && record.price);
      if (!isFinite(price) || price <= 0) continue;
      if (!lowest || price < lowest.price) {
        lowest = { platform: (record && record.platform) || '', price };
      }
    }
    if (!lowest || lowest.price > target) continue;

    const last = Number(item.lastNotifiedPrice);
    if (isFinite(last) && last === lowest.price) continue; // 同价位不重复提醒

    alerts.push({
      itemId: item.id,
      name: item.name || '',
      price: lowest.price,
      targetPrice: target,
      platform: lowest.platform
    });
  }
  return alerts;
}

/** 读购物清单并比对心理价位；命中后写回 lastNotifiedPrice 保证同一价位只提醒一次。任何失败降级为空数组 */
async function collectPriceAlerts(openid) {
  try {
    const res = await db.collection('shopping').where({ openid }).limit(50).get();
    const items = (res.data || []).map((d) => ({
      id: d._id,
      name: d.name || '',
      targetPrice: d.targetPrice,
      prices: Array.isArray(d.prices) ? d.prices : [],
      lastNotifiedPrice: d.lastNotifiedPrice
    }));
    const alerts = evaluatePriceAlerts(items);
    for (const alert of alerts) {
      await db
        .collection('shopping')
        .doc(alert.itemId)
        .update({ data: { lastNotifiedPrice: alert.price } })
        .catch(() => {});
    }
    return alerts;
  } catch (err) {
    console.warn('[getBriefing] collectPriceAlerts failed:', err && (err.errMsg || err.message));
    return [];
  }
}

/**
 * 降价提醒订阅消息推送（P-01）。
 * 模板 ID 走环境变量 PRICE_ALERT_TEMPLATE_ID：**读不到（未配置）直接跳过**，
 * 只在晨报内展示；任何异常只 warn，绝不阻断晨报生成。
 */
async function pushPriceAlert(openid, alerts) {
  const templateId = process.env.PRICE_ALERT_TEMPLATE_ID;
  if (!templateId || !Array.isArray(alerts) || alerts.length === 0) return 0;
  let sent = 0;
  for (const alert of alerts) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: 'pages/shopping/index',
        data: {
          thing1: { value: String(alert.name).slice(0, 20) },
          amount2: { value: String(alert.price) },
          thing3: { value: String(alert.targetPrice) }
        }
      });
      sent += 1;
    } catch (err) {
      console.warn('[getBriefing] price alert push failed:', err && (err.errMsg || err.message));
    }
  }
  return sent;
}

/**
 * 追加「今日情报」（webSearch 云函数：天气 + 偏好排序 RSS；订阅档再走 LLM 提炼）。
 * 免费/订阅用户都会拿到情报 —— 档位由 webSearch 内部判定，免费档零 LLM 成本。
 * tripCity：次日外地行程目的地（adaptive 计算），透传 webSearch 切目的地天气。
 * 懒加载策略：不在定时触发器里调 LLM（逐用户串行会超 cron 时长），而是用户首次
 * 打开晨报时补充并落库，之后直接随缓存晨报返回；任何失败降级为 null，不阻塞晨报。
 */
async function attachIntel(openid, tripCity) {
  try {
    const res = await cloud.callFunction({
      name: 'webSearch',
      data: { action: 'briefing', openid, tripCity: tripCity || undefined }
    });
    const payload = res && res.result;
    if (payload && payload.code === 0 && payload.data) return payload.data;
    console.warn('[getBriefing] attachIntel bad payload:', payload && payload.message);
    return null;
  } catch (err) {
    console.warn('[getBriefing] attachIntel failed:', err && (err.errMsg || err.message));
    return null;
  }
}

/** 情报是否有可展示内容（空情报不落库，否则「资讯源临时全挂」会被缓存一整天） */
function hasIntelContent(intel) {
  if (!intel) return false;
  const n = Array.isArray(intel.intelItems) ? intel.intelItems.length : 0;
  return n > 0 || !!intel.weather;
}

/** 聚合某用户的晨报数据 */
async function aggregate(openid) {
  // 三次查询互不依赖：并发发出，省掉 2 个串行 RTT
  // （定时路径上百用户、以及用户首次打开晨报，都走这里）
  // 查询条件/排序/limit 与改动前逐字一致；任一 reject 行为与原串行一致，由上层统一处理
  const [eventsRes, todosRes, itemsRes] = await Promise.all([
    db
      .collection('events')
      .where({ openid, status: 'confirmed', startTime: _.gte(todayStr()) })
      .orderBy('startTime', 'asc')
      .limit(20)
      .get(),
    db
      .collection('todos')
      .where({ openid, status: 'confirmed' })
      .orderBy('dueDate', 'asc')
      .limit(20)
      .get(),
    db
      .collection('items')
      .where({ openid, createTime: _.gte(new Date(Date.now() - 86400000).toISOString()) })
      .orderBy('createTime', 'desc')
      .limit(5)
      .get()
  ]);

  const hour = new Date().getHours();
  const adaptive = computeAdaptive(eventsRes.data, todosRes.data);

  // 自适应开场（F21）：爆满日强调日程前置；有高优待办先点名
  let greeting = greetingByHour(hour);
  if (adaptive.busyDay) greeting = '今天日程很满，先看日程再逐项推进';
  else if (adaptive.focusTodo) greeting = `先办「${adaptive.focusTodo}」，其他从容推进`;

  // P-01 时机②：晨报生成时比对心理价位（复用已有价格记录，零 API 成本）
  const priceAlerts = await collectPriceAlerts(openid);

  // P1-G 本周复盘：过去 7 天 events/todos 查询（events 只取 confirmed 与主查询同口径；
  // todos 不能限 status——completed 态是 'done'，主查询只查 confirmed 会漏掉已完成项）。
  // 失败不阻塞晨报（v1.3 原则）：降级为不返回 weeklyReview 字段，前端整卡不渲染。
  let weeklyReview;
  try {
    const [weekEventsRes, weekTodosRes] = await Promise.all([
      db
        .collection('events')
        .where({ openid, status: 'confirmed', startTime: _.gte(todayStr(-6)) })
        .limit(100)
        .get(),
      db.collection('todos').where({ openid }).limit(100).get()
    ]);
    weeklyReview = computeWeeklyReview(weekEventsRes.data, weekTodosRes.data);
  } catch (err) {
    console.warn('[getBriefing] weeklyReview failed:', err && (err.errMsg || err.message));
  }

  // X6 周末轻量版 + X7 冷知识：工作日不标记 weekendEdition（缺省），trivia 按日期确定性选取
  const weekendEdition = isWeekendToday();

  return {
    date: todayStr(),
    greeting,
    events: eventsRes.data,
    todos: todosRes.data,
    digest: itemsRes.data.map((it) => `《${it.title}》：${it.summary}`),
    read: false,
    adaptive,
    priceAlerts,
    trivia: pickTrivia(todayStr()),
    ...(weekendEdition ? { weekendEdition: true } : {}),
    ...(weeklyReview ? { weeklyReview } : {})
  };
}

/**
 * 定时批量晨报 + 订阅消息推送。
 * 云开发定时触发器默认触发 exports.main（event.Type='Timer'），故 main 内路由；
 * 保留 exports.scheduled 以兼容控制台显式指定 handler 的旧触发器配置。
 * 订阅消息模板 ID 通过环境变量 SUBSCRIBE_TEMPLATE_ID 注入。
 */
async function runScheduled() {
  const templateId = process.env.SUBSCRIBE_TEMPLATE_ID;
  const startedAt = Date.now();
  const usersRes = await db.collection('users').limit(SCHEDULED_USER_BATCH_MAX).get();
  const users = (usersRes && usersRes.data) || [];
  const total = users.length;
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  /**
   * 处理单个用户：**先查重再聚合** —— 今日晨报已生成的用户（如当天已打开过）直接复用，
   * 不再白跑 aggregate() 的 3~4 次查询。单个用户失败只 warn，不影响他人。
   */
  const processOne = async (user) => {
    if (Date.now() - startedAt >= SCHEDULED_DEADLINE_MS) {
      skipped += 1; // 预算耗尽：明确记为跳过，不做半截工作
      return;
    }
    try {
      const dup = await db
        .collection('briefings')
        .where({ openid: user.openid, date: todayStr() })
        .limit(1)
        .get();
      let briefing;
      if (dup.data.length === 0) {
        briefing = await aggregate(user.openid);
        await db.collection('briefings').add({ data: { openid: user.openid, ...briefing } });
        // 降价提醒推送：模板 ID 未配置时 pushPriceAlert 内部直接跳过，不影响主流程
        await pushPriceAlert(user.openid, briefing.priceAlerts);
      } else {
        briefing = dup.data[0]; // 已存在：直接复用，含 events/todos，够发订阅消息
      }
      if (templateId && user.subscribeAccepted) {
        await cloud.openapi.subscribeMessage.send({
          touser: user.openid,
          templateId,
          page: 'pages/briefing/index',
          data: {
            thing1: { value: `你有 ${briefing.events.length} 个日程、${briefing.todos.length} 项待办` },
            time2: { value: user.briefingTime || '07:30' }
          }
        });
      }
      ok += 1;
    } catch (err) {
      failed += 1;
      // errMsg 是微信 SDK 错误的字段，普通 Error 没有 —— 两者都要取，否则失败原因恒为 undefined
      console.error('[getBriefing.scheduled] user failed:', user.openid, err && (err.errMsg || err.message));
    }
  };

  // 分片并发：每批 SCHEDULED_CONCURRENCY 个并行，批次间串行推进；
  // 不一次性 Promise.all 全部用户（会打爆数据库连接与内存）。
  // 每批开始前与每个用户处理前都检查时间预算，超预算则明确跳过剩余用户并计数。
  for (let i = 0; i < users.length; i += SCHEDULED_CONCURRENCY) {
    if (Date.now() - startedAt >= SCHEDULED_DEADLINE_MS) {
      skipped += users.length - i;
      break;
    }
    await Promise.all(users.slice(i, i + SCHEDULED_CONCURRENCY).map(processOne));
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = { total, ok, failed, skipped, elapsedMs };
  // 有声：此前无返回值、无汇总日志，超时/失败完全静默（不报错、不崩溃，只是无声少给了一些人）
  const line = `[getBriefing.scheduled] total=${total} ok=${ok} failed=${failed} skipped=${skipped} elapsedMs=${elapsedMs}`;
  if (failed > 0 || skipped > 0) console.error(line);
  else console.log(line);
  return summary;
}

exports.main = async (event = {}) => {
  // 定时触发器无 OPENID（getWXContext 为空），必须先于用户路径分流
  if (event.Type === 'Timer' || event.TriggerName) return runScheduled();

  const { OPENID } = cloud.getWXContext();
  const today = todayStr();

  // 已有今日晨报直接返回
  const existing = await db
    .collection('briefings')
    .where({ openid: OPENID, date: today })
    .limit(1)
    .get();
  if (existing.data.length > 0) {
    const doc = existing.data[0];
    // 晨报已有但缺今日情报（如由定时器生成）：首次打开时懒加载补充
    if (!doc.intel) {
      const rawIntel = await attachIntel(OPENID, doc.adaptive && doc.adaptive.tripCity);
      if (rawIntel) {
        // X6：周末生成的晨报补挂情报时同步减量（与 aggregate 生成口径一致）
        const intel = doc.weekendEdition === true ? trimIntelForWeekend(rawIntel) : rawIntel;
        doc.intel = intel; // 本次请求照常返回给用户
        if (hasIntelContent(intel)) {
          // 仅非空情报落库，避免「源临时全挂」被缓存一整天
          await db.collection('briefings').doc(doc._id).update({ data: { intel } }).catch(() => {});
        }
      }
    }
    return doc;
  }

  const briefing = await aggregate(OPENID);
  const intel = await attachIntel(OPENID, briefing.adaptive && briefing.adaptive.tripCity);
  if (intel) {
    // X6：周末轻量版情报减量（min 2 条）
    briefing.intel = briefing.weekendEdition === true ? trimIntelForWeekend(intel) : intel;
  }
  await db.collection('briefings').add({ data: { openid: OPENID, ...briefing } });
  // 新生成的晨报顺带推送降价提醒；未配置 PRICE_ALERT_TEMPLATE_ID 时静默跳过
  await pushPriceAlert(OPENID, briefing.priceAlerts);
  return briefing;
};

// 兼容旧触发器显式指定的 handler
exports.scheduled = runScheduled;
