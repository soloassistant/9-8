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

  const validEvent = (e) => e && e.title && e.startTime;
  const validTodo = (t) => t && t.title;

  if (!events.every(validEvent) || !todos.every(validTodo)) {
    throw new Error('invalid event/todo payload');
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

  if (collection && collection.title && collection.summary) {
    const countRes = await db.collection('items').where({ openid: OPENID }).count();
    if (countRes.total >= FREE_COLLECTION_QUOTA) {
      throw new Error('collection quota exceeded, please subscribe');
    }
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
