const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const FREE_COLLECTION_QUOTA = 50;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 取不到微信上下文就拒绝：本函数往 events / todos / items 三个集合写 openid，
  // openid 为 undefined 会让所有无上下文调用方的记录混在同一个桶里、并共用同一份配额。
  if (!OPENID) throw new Error('no openid');
  const { events = [], todos = [], collection } = event || {};
  const now = new Date().toISOString();
  let saved = 0;

  // ⚠️ 这里**故意不校验 startTime 的格式**，只要求它非空。理由（2026-10 实测确认）：
  //   本函数的两个调用方给出的时间形态并不统一 ——
  //   · src/pages/calendar/index.tsx:169 快速添加：`${selected} ${hm}`，严格 'YYYY-MM-DD HH:mm'；
  //   · src/pages/inbox/index.tsx:378 收件箱确认：`d.time || origin.startTime`，其中 d.time
  //     来自 extract 的 LLM 产出（契约见 src/services/cloudLlm.ts:377「只有日期没有具体时刻时，
  //     该时刻留空字符串」），且用户可在草稿卡里手改。
  //   下游 getBriefing 用 `startTime: _.gte(todayStr())` 做**字符串前缀比较**（'YYYY-MM-DD' 对
  //   'YYYY-MM-DD HH:mm' 天然按日期段优先），再用 new Date() 解析，日期串同样成立。
  //   若在此加严格正则，会把「日期只有天、没有时刻」以及用户手改的时间从"可能脏"直接变成
  //   "整批存不进去"（P1 回归）—— 收益不抵风险，故保持宽松、依赖上游契约。
  const validEvent = (e) => e && e.title && e.startTime;
  const validTodo = (t) => t && t.title;

  if (!events.every(validEvent) || !todos.every(validTodo)) {
    throw new Error('invalid event/todo payload');
  }

  // 收藏配额预检必须放在**任何写入之前**。
  // 旧顺序是「先写 events/todos → 再查 items 配额 → 超限抛错」，于是配额超限时日程/待办已经
  // 入库而接口报错：用户看到「保存失败」重试一次，就多出一整套重复日程/待办（非原子写入）。
  const wantsCollection = !!(collection && collection.title && collection.summary);
  if (wantsCollection) {
    const countRes = await db.collection('items').where({ openid: OPENID }).count();
    if (countRes.total >= FREE_COLLECTION_QUOTA) {
      throw new Error('collection quota exceeded, please subscribe');
    }
  }

  for (const evt of events) {
    await db.collection('events').add({
      data: {
        openid: OPENID,
        title: String(evt.title).slice(0, 100),
        startTime: evt.startTime,
        endTime: evt.endTime || null,
        location: evt.location || null,
        source: evt.source || null,
        status: 'confirmed',
        createTime: now
      }
    });
    saved += 1;
  }

  for (const todo of todos) {
    await db.collection('todos').add({
      data: {
        openid: OPENID,
        title: String(todo.title).slice(0, 100),
        dueDate: todo.dueDate || null,
        source: todo.source || null,
        status: 'confirmed',
        createTime: now
      }
    });
    saved += 1;
  }

  if (wantsCollection) {
    await db.collection('items').add({
      data: {
        openid: OPENID,
        title: String(collection.title).slice(0, 100),
        summary: String(collection.summary).slice(0, 300),
        tags: Array.isArray(collection.tags) ? collection.tags.slice(0, 5).map(String) : [],
        url: collection.url || null,
        sourceType: ['article', 'message', 'link'].includes(collection.sourceType)
          ? collection.sourceType
          : 'message',
        createTime: now
      }
    });
    saved += 1;
  }

  return { saved };
};
