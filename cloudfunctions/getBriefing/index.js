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

  return { busyDay, tripCity, focusTodo: focus ? focus.title : null };
}

/**
 * 订阅用户追加「今日情报」（webSearch 云函数：天气+偏好RSS+LLM摘要，订阅专属）。
 * tripCity：次日外地行程目的地（adaptive 计算），透传 webSearch 切目的地天气。
 * 懒加载策略：不在定时触发器里调 LLM（逐用户串行会超 cron 时长），而是用户首次
 * 打开晨报时补充并落库，之后直接随缓存晨报返回；任何失败降级为 null，不阻塞晨报。
 */
async function attachIntel(openid, tripCity) {
  try {
    const userRes = await db.collection('users').where({ openid }).limit(1).get();
    const user = userRes.data[0];
    const subscribed = !!(user && user.subscribed && user.expiredAt && new Date(user.expiredAt) > new Date());
    if (!subscribed) return null;
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

/** 聚合某用户的晨报数据 */
async function aggregate(openid) {
  const eventsRes = await db
    .collection('events')
    .where({ openid, status: 'confirmed', startTime: _.gte(todayStr()) })
    .orderBy('startTime', 'asc')
    .limit(20)
    .get();
  const todosRes = await db
    .collection('todos')
    .where({ openid, status: 'confirmed' })
    .orderBy('dueDate', 'asc')
    .limit(20)
    .get();
  const itemsRes = await db
    .collection('items')
    .where({ openid, createTime: _.gte(new Date(Date.now() - 86400000).toISOString()) })
    .orderBy('createTime', 'desc')
    .limit(5)
    .get();

  const hour = new Date().getHours();
  const adaptive = computeAdaptive(eventsRes.data, todosRes.data);

  // 自适应开场（F21）：爆满日强调日程前置；有高优待办先点名
  let greeting = greetingByHour(hour);
  if (adaptive.busyDay) greeting = '今天日程很满，先看日程再逐项推进';
  else if (adaptive.focusTodo) greeting = `先办「${adaptive.focusTodo}」，其他从容推进`;

  return {
    date: todayStr(),
    greeting,
    events: eventsRes.data,
    todos: todosRes.data,
    digest: itemsRes.data.map((it) => `《${it.title}》：${it.summary}`),
    read: false,
    adaptive
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
  const usersRes = await db.collection('users').limit(1000).get();
  for (const user of usersRes.data) {
    try {
      const briefing = await aggregate(user.openid);
      const dup = await db
        .collection('briefings')
        .where({ openid: user.openid, date: todayStr() })
        .limit(1)
        .get();
      if (dup.data.length === 0) {
        await db.collection('briefings').add({ data: { openid: user.openid, ...briefing } });
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
    } catch (err) {
      console.error('[getBriefing.scheduled] user failed:', user.openid, err && err.errMsg);
    }
  }
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
      const intel = await attachIntel(OPENID, doc.adaptive && doc.adaptive.tripCity);
      if (intel) {
        doc.intel = intel;
        await db.collection('briefings').doc(doc._id).update({ data: { intel } }).catch(() => {});
      }
    }
    return doc;
  }

  const briefing = await aggregate(OPENID);
  const intel = await attachIntel(OPENID, briefing.adaptive && briefing.adaptive.tripCity);
  if (intel) briefing.intel = intel;
  await db.collection('briefings').add({ data: { openid: OPENID, ...briefing } });
  return briefing;
};

// 兼容旧触发器显式指定的 handler
exports.scheduled = runScheduled;
