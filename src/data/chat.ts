/** mock: chat —— 模拟语音/文字对话意图处理（deep=true 时为深度思考伙伴模式） */
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import type { ScheduleEvent, TodoItem } from '../types';
import { readPlan, writePlan, nextId } from './dailyPlan';
import getHotspot from './getHotspot';

const SHOPPING_STORAGE_KEY = 'shoppingList';

interface MockPrice {
  platform: string;
  price: number;
}
interface MockShoppingItem {
  id: string;
  name: string;
  targetPrice?: number;
  link?: string;
  bought: boolean;
  createdAt: string;
  prices: MockPrice[];
}

function readShoppingList(): MockShoppingItem[] {
  try {
    return Taro.getStorageSync(SHOPPING_STORAGE_KEY) || [];
  } catch (err) {
    console.warn('[mock:chat] read shopping failed:', err);
    return [];
  }
}
function writeShoppingList(list: MockShoppingItem[]) {
  try {
    Taro.setStorageSync(SHOPPING_STORAGE_KEY, list);
  } catch (err) {
    console.warn('[mock:chat] write shopping failed:', err);
  }
}

export default async function chat(data?: {
  message?: string;
  action?: string;
  deep?: boolean;
  mode?: 'work';
  workAction?: string;
}) {
  const msg = (data?.message || '').trim();
  console.info('[mock:chat] message:', msg, 'deep:', data?.deep, 'mode:', data?.mode);

  // 涉及本地 storage 写入/读取的操作类意图不交给 LLM（LLM 不会写本地 storage，会导致假回复）
  const localIntent =
    matchBatchSchedule(msg) ||
    /帮我安排|排一下|帮我约|重新排|排班|确认|就这么排|取消|算了/.test(msg) ||
    /热点|新闻|资讯|热搜/.test(msg) ||
    matchShopList(msg) ||
    matchDailyPlan(msg);

  // 自由对话/深度思考/购物分析 → 本地 LLM 代理（DeepSeek）；代理未启动自动降级 mock
  if (!localIntent) {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          deep: data?.deep,
          mode: data?.mode,
          workAction: data?.workAction
        })
      });
      if (res.ok) {
        const result = await res.json();
        if (result.reply) {
          return { reply: result.reply, action: result.action || 'chat' };
        }
      }
    } catch (err) {
      console.info('[mock:chat] 本地 LLM 代理未启动，走 mock 兜底');
    }
  }

  // 购物清单等本地操作不走 LLM，直接 mock 处理
  if (data?.mode === 'work') {
    return workAssistant(msg, data.workAction || 'summary');
  }

  if (data?.deep) {
    return {
      reply: [
        `🧠 我们把「${msg.slice(0, 20)}」拆开看：`,
        '1. 目标：你最想先解决的是什么？把它说成一句可执行的话；',
        '2. 约束：时间、精力、依赖的人，哪一个卡得最紧？',
        '3. 下一步：挑一个今天 30 分钟内能完成的最小动作，我先帮你排进待办。',
        '告诉我你的答案，我陪你把思路收敛成计划。'
      ].join('\n'),
      action: 'chat'
    };
  }

  let reply = '好的，已收到你的指令。';
  let replyImage: string | undefined;
  // F24 批量/周期排班：固定每周会议、一句话多条日程（优先于单条排班建议）
  if (matchBatchSchedule(msg)) reply = handleBatchSchedule(msg);
  else if (/帮我安排|排一下|帮我约|重新排|排班/.test(msg))
    // 兜底模式下如实说明：不虚构用户日程，引导给出事项+时间
    reply = readPlan().events.length
      ? '告诉我事项和时间（如「周五下午4点开会」），我对照你已有的日程帮你排。'
      : '告诉我事项和时间（如「周五下午4点开会」），我直接帮你排进日程。';
  else if (/确认|就这么排/.test(msg))
    // 兜底模式没有待确认的写入上下文，不假称「已写入」
    reply = '想写入日程请说「把XX加进日程」，例如「把周五16:30开会加进日程」，我马上帮你排上。';
  else if (/取消|算了/.test(msg)) reply = '好的，先不动日程。';
  // AI 发图：热点/资讯类查询附真实资讯封面图（F25）
  else if (/热点|新闻|资讯|热搜/.test(msg)) {
    const newsRes = handleNewsQuery();
    reply = newsRes.reply;
    replyImage = newsRes.image;
  }
  // 购物清单操作：读 / 添加 / 标记已买（意图词具体，须排在宽泛的日程查询之前，
  // 否则「购物清单里有什么」会被日程查询的「有什么」抢先命中）
  else if (matchShopList(msg)) {
    reply = handleShoppingList(msg);
  }
  else if (matchDailyPlan(msg)) {
    // 对话式增改删查：优先命中「新增/完成/删除/改期/查询待办与日程」
    reply = handleDailyPlan(msg);
  }
  // 购物分析：识别「买 / 对比 / 哪个划算 / 值不值」等意图
  else if (matchShopping(msg)) {
    reply = shoppingAnalyze(msg);
  }
  return { reply, action: 'none', image: replyImage };
}

/** 热点/资讯类查询：mock 数据取前 2 条 + 首条封面图（真实端由云函数走 RSS 抽图） */
function handleNewsQuery(): { reply: string; action: string; image?: string } {
  const news = getHotspot();
  if (news.length === 0) {
    return { reply: '今天的热点还没抓到，稍后再问我一次。', action: 'query' };
  }
  const top = news.slice(0, 2);
  const lines = [
    '📰 今天值得看的热点：',
    ...top.map((n, i) => `${i + 1}. ${n.title}（来源：${n.source}）`),
    '热点页有完整资讯流，可对每条 👍/👎 告诉我口味。'
  ];
  return { reply: lines.join('\n'), action: 'query', image: top[0].image };
}

/* ---------------- F24 批量/周期排班（自然语言批量排班） ---------------- */

/** 时间段词 → 默认时刻（无显式时间时兜底 09:00） */
function slotToTime(text: string): string {
  if (/下午/.test(text)) return '14:00';
  if (/中午|午间/.test(text)) return '12:00';
  if (/傍晚/.test(text)) return '18:00';
  if (/晚上|晚间/.test(text)) return '19:00';
  if (/上午|早上|早晨/.test(text)) return '09:00';
  const hm = text.match(/(\d{1,2})[点:：]\s*(半|\d{1,2})?/);
  if (hm) {
    let hh = Number(hm[1]);
    const mm = hm[2] === '半' ? 30 : Number(hm[2] || 0);
    if (hh < 12 && /下午|晚上|傍晚/.test(text)) hh += 12;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  return '09:00';
}

/** 周[一..日] → 距今天数；恰逢今天且时刻已过则顺延一周 */
function weekdayOffset(word: string, slot: string): number {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const target = map[word] ?? 1;
  const diff = (target - dayjs().day() + 7) % 7;
  if (diff > 0) return diff;
  return dayjs().format('HH:mm') < slot ? 0 : 7;
}

/** 批量排班意图命中：固定每周会议，或一句话含 ≥2 个带时间的条目 */
function matchBatchSchedule(msg: string): boolean {
  if (/固定到|固定在|定为|改成每周|每周|每个周/.test(msg) && /周[一二三四五六日天]/.test(msg)) return true;
  const timed = msg
    .split(/[，、；]/)
    .filter((c) => /周[一二三四五六日天]|\d{1,2}[点:：]/.test(c)).length;
  return timed >= 2 && /排|安排|约/.test(msg);
}

/** 从「把XX固定到每周二上午」提炼会议名：取锚点前文本并剔除口语词（周X 仅在星期位匹配，避免误吞「周会」） */
function extractBatchTitle(msg: string, anchorIndex: number): string {
  return msg
    .slice(0, anchorIndex)
    .replace(/帮我?|请|麻烦|把|将|要|想|(?:下|本|这)周|周[一二三四五六日天]|每[周个][一二三四五六日天]?/g, '')
    .trim()
    .slice(0, 16);
}

/** 批量/周期排班：固定会议排未来 4 次；多条目逐条排入（上限 6 条） */
function handleBatchSchedule(msg: string): string {
  const plan = readPlan();
  const created: string[] = [];

  // 1) 周期固定：把「周会」固定到（每周）周二上午 → 未来 4 次
  const anchor = msg.match(/固定到|固定在|定为|改成每周|每周|每个周/);
  if (anchor && anchor.index !== undefined) {
    const tail = msg.slice(anchor.index);
    const wm = tail.match(/周([一二三四五六日天])/);
    if (wm) {
      const title = extractBatchTitle(msg, anchor.index) || '例会';
      const slot = slotToTime(tail);
      const offset0 = weekdayOffset(wm[1], slot);
      for (let i = 0; i < 4; i++) {
        const start = `${dayjs().add(offset0 + i * 7, 'day').format('YYYY-MM-DD')} ${slot}`;
        plan.events.push({ id: nextId('evt'), title, startTime: start, status: 'confirmed', source: 'AI 批量排班' });
        created.push(start);
      }
      writePlan(plan);
      return [
        `📅 已把「${title}」固定为每周${wm[1]}，未来 4 次已排入：`,
        ...created.map((s) => `· ${s}`),
        '日历页可查看忙闲分布，晨报会按天提醒。'
      ].join('\n');
    }
  }

  // 2) 一句话多条：下周一上午站会、周三下午评审、周五复盘
  const clauses = msg.split(/[，、；]/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const m = clause.match(/周([一二三四五六日天])\s*(上午|早上|中午|下午|傍晚|晚上|\d{1,2}[点:：]\s*(?:半|\d{1,2})?)?/);
    if (!m) continue;
    const slot = slotToTime(m[2] || '上午');
    const date = dayjs().add(weekdayOffset(m[1], slot), 'day').format('YYYY-MM-DD');
    const title = clause
      .replace(/周[一二三四五六日天]\s*(上午|早上|中午|下午|傍晚|晚上|\d{1,2}[点:：]\s*(?:半|\d{1,2})?)?/g, '')
      .replace(/帮我?排|安排|开个?|约个?|把|将|一下|这个|下周|这周|本周/g, '')
      .trim()
      .slice(0, 16);
    if (!title) continue;
    plan.events.push({ id: nextId('evt'), title, startTime: `${date} ${slot}`, status: 'confirmed', source: 'AI 批量排班' });
    created.push(`${date} ${slot} 「${title}」`);
  }
  if (created.length) {
    writePlan(plan);
    return [`📅 已批量排入 ${created.length} 条日程：`, ...created.map((s) => `· ${s}`), '日历页可查看忙闲分布。'].join('\n');
  }
  return '批量排班可以这样说：「把周会固定到每周二上午」，或「下周一站会、周三评审、周五复盘」。';
}

/** 购物相关关键词命中 */
function matchShopping(msg: string): boolean {
  return /买|购买|入手|比一比|对比|哪个.划算|划算|值不值|值不值得|性价比|什么牌子|求推荐|预算|买什么/.test(msg);
}

/** 对话式增改删查是否命中（新增/完成/删除/改期/查询待办与日程） */
function matchDailyPlan(msg: string): boolean {
  return (
    /加入(?:待办|日程)|加个(?:待办|日程)|新增(?:待办|日程)|记(?:待办|日程)/.test(msg) ||
    /标记(?:为)?完成|办完|搞定|完成/.test(msg) ||
    /删掉|删除|去掉|移除|撤销/.test(msg) ||
    /改到|挪到|改期|推迟|延后|提前/.test(msg) ||
    /(?:待办|日程|安排|日程表|有什么)/.test(msg)
  );
}

/** 把用户表达的时间词解析为 'YYYY-MM-DD HH:mm'；解析失败返回 null */
function parsePlanTime(text: string): string | null {
  const now = dayjs();
  const today = now.format('YYYY-MM-DD');

  const md = text.match(/(\d{1,2})月(\d{1,2})日?[^\d]{0,6}(\d{1,2})[:：点][^\d]{0,2}(\d{1,2})?/);
  if (md) {
    const mo = md[1], dd = md[2], hh = md[3];
    const mm = md[4] ? String(md[4]).padStart(2, '0') : '00';
    return dayjs(`${now.year()}-${mo}-${dd} ${hh}:${mm}`).format('YYYY-MM-DD HH:mm');
  }

  const rel = text.match(/(今晚|明天|明晚|后天|上午|中午|下午|晚上)?\s*(\d{1,2})\s*[:：点](\d{1,2})?\s*(点半|半|分)?/);
  if (rel) {
    const kw = rel[1];
    let dayOffset = 0;
    if (kw === '明天' || kw === '明晚') dayOffset = 1;
    else if (kw === '后天') dayOffset = 2;
    let hh = Number(rel[2]);
    if (['下午', '晚上', '明晚', '今晚'].includes(kw || '') && hh < 12) hh += 12;
    const mm = rel[5] === '半' ? 30 : Number(rel[3] || '0');
    return now.add(dayOffset, 'day').hour(hh).minute(mm).format('YYYY-MM-DD HH:mm');
  }

  const hm = text.match(/(\d{1,2})[:：](\d{2})/);
  if (hm) return dayjs(`${today} ${hm[1]}:${hm[2]}`).format('YYYY-MM-DD HH:mm');

  return null;
}

/** 对话式增改删查：新增 / 完成 / 删除 / 改期 / 查询 待办与日程 */
function handleDailyPlan(msg: string): string {
  const plan = readPlan();
  const today = dayjs().format('YYYY-MM-DD');

  // 1) 新增：把「XX」加入/记入 待办或日程
  const addMatch = msg.match(/把?([\u4e00-\u9fa5A-Za-z0-9（）()]{1,20}?)(?:加(?:入|进)|新增|记入|加个)(待办|日程)/);
  if (addMatch) {
    const title = addMatch[1].trim();
    if (!title) return '想让我把你的哪件事加进待办或日程？说一下内容就行。';
    const isEvent = addMatch[2] === '日程';
    const t = parsePlanTime(msg) || `${today} ${isEvent ? '19:00' : '09:00'}`;
    if (isEvent) {
      const evt: ScheduleEvent = {
        id: nextId('evt'),
        title,
        startTime: t,
        status: 'confirmed',
        source: 'AI 新增'
      };
      plan.events.push(evt);
      writePlan(plan);
      return `📅 已把「${title}」排入日程（${t}），晨报会同步。`;
    }
    const todo: TodoItem = { id: nextId('todo'), title, dueDate: t, status: 'confirmed', source: 'AI 新增' };
    plan.todos.unshift(todo);
    writePlan(plan);
    return `✅ 已把「${title}」加进待办（${t}）。`;
  }

  // 2) 完成：把「XX」标记完成 / 完成XX
  const doneMatch = msg.match(/(?:把)?[「」]?([\u4e00-\u9fa5A-Za-z0-9（）()]{2,20})[」]?(?:标记)?(?:为)?完成/);
  if (doneMatch) {
    const kw = doneMatch[1];
    const hit = plan.todos.find((t) => t.status !== 'done' && t.title.includes(kw));
    if (hit) {
      hit.status = 'done';
      writePlan(plan);
      return `🎉 已把「${hit.title}」标记完成。`;
    }
    return `我没找到匹配「${kw}」的未完成待办。`;
  }

  // 3) 删除：删掉/删除/去掉「XX」
  const delMatch = msg.match(/(?:删掉|删除|去掉|移除|撤销)\s*[「」]?([\u4e00-\u9fa5A-Za-z0-9（）()]{2,20})/);
  if (delMatch) {
    const kw = delMatch[1];
    const tHit = plan.todos.find((t) => t.title.includes(kw));
    if (tHit) {
      plan.todos = plan.todos.filter((t) => t.id !== tHit.id);
      writePlan(plan);
      return `🗑️ 已删除待办「${tHit.title}」。`;
    }
    const eHit = plan.events.find((e) => e.title.includes(kw));
    if (eHit) {
      plan.events = plan.events.filter((e) => e.id !== eHit.id);
      writePlan(plan);
      return `🗑️ 已删除日程「${eHit.title}」。`;
    }
    return `没找到「${kw}」，无需删除。`;
  }

  // 4) 改期：把「XX」挪到/改到/推迟到 时间
  const moveMatch = msg.match(/把?[「」]?([\u4e00-\u9fa5A-Za-z0-9（）()]{2,20})[」]?\s*(?:改到|挪到|改期|推迟|延后|提前)\s*(.{0,12})/);
  if (moveMatch) {
    const kw = moveMatch[1];
    const target = parsePlanTime(moveMatch[2] || '明天 19:00');
    const hit =
      plan.events.find((e) => e.title.includes(kw) && dayjs(e.startTime).isSame(today, 'day')) ||
      plan.todos.find((t) => t.title.includes(kw) && t.status !== 'done') ||
      plan.events.find((e) => e.title.includes(kw));
    if (hit) {
      if ('startTime' in hit) hit.startTime = target || hit.startTime;
      else hit.dueDate = target || hit.dueDate;
      writePlan(plan);
      return `🕒 已把「${hit.title}」改期到 ${target}，晨报已更新。`;
    }
    return `没找到「${kw}」，检查下是不是名称对不上？`;
  }

  // 5) 查询：列出待办与日程
  const undone = plan.todos.filter((t) => t.status !== 'done');
  const hasEvents = plan.events.length > 0;
  if (hasEvents || undone.length > 0 || plan.todos.length > 0) {
    const evtLines = plan.events.map((e) => `· ${e.startTime.replace(' ', ' ')}  ${e.title}${e.location ? `（${e.location}）` : ''}`);
    const todoLines = plan.todos.map((t) => `· ${t.status === 'done' ? '✅' : '⬜'} ${t.title}${t.dueDate ? `（${t.dueDate.replace(' ', ' ')}）` : ''}`);
    return [
      '🗓️ 今日安排：',
      ...(evtLines.length ? ['【日程】', ...evtLines] : []),
      ...(todoLines.length ? ['【待办】', ...todoLines] : []),
      '',
      '说「把XX标记完成」「把XX挪到明天下午3点」我就能帮你改。'
    ].join('\n');
  }
  return '你今天还没有日程和待办。说「把周末练瑜伽加进待办」我帮你记。';
}

/** 购物清单操作意图命中：读清单 / 添加 / 标记已买 */
function matchShopList(msg: string): boolean {
  return (
    /购物清单|清单/.test(msg) &&
    (/(有|看|展示|列|查|显示|还剩|还有什么)/.test(msg) ||
      /(把|将|加|加入|添加|记下)/.test(msg) ||
      /买|已买|入手|搞定/.test(msg))
  );
}

/** 处理购物清单的读 / 加 / 勾买指令 */
function handleShoppingList(msg: string): string {
  const list = readShoppingList();
  // 把「XX」加进购物清单：商品名尽量短，动作词「加入/加进/添加到」必需，避免把动词吞进商品名
  const addMatch = msg.match(/把?([\u4e00-\u9fa5A-Za-z0-9（）()]{1,16}?)(?:加(?:入|进)|添加到|加到|记入)购物清单/);
  const notBought = list.filter((it) => !it.bought);

  // 1) 添加指令：把「XX」加进购物清单 / 购物清单加XX
  if (addMatch && /加|添加|记/.test(msg)) {
    const name = addMatch[1];
    const item: MockShoppingItem = {
      id: `shop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      bought: false,
      createdAt: new Date().toISOString(),
      prices: []
    };
    writeShoppingList([item, ...list]);
    return `✅ 已把「${name}」加进购物清单。需要的话说「帮我看下购物清单」就能展示，也可以去「我的 → 购物清单」记比价。`;
  }

  // 2) 标记已买：把「XX」标记为已买
  const doneMatch = msg.match(/(?:把)?\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{2,16})\s*(?:标记)?(?:为)?已买/);
  if (doneMatch) {
    const name = doneMatch[1];
    const hit = notBought.find((it) => it.name.includes(name));
    if (hit) {
      writeShoppingList(list.map((it) => (it.id === hit.id ? { ...it, bought: true } : it)));
      return `🎉 已把「${hit.name}」标记为已买，为你记账。`;
    }
    return `清单里没找到「${name}」。你可以说「把${name}加进购物清单」添加。`;
  }

  // 3) 读取清单
  if (notBought.length === 0) {
    const bought = list.filter((it) => it.bought).length;
    return list.length === 0
      ? '🛒 购物清单还是空的。说「把XX加进购物清单」就能添加想买的东西。'
      : `🛒 你清单里 ${bought} 件都已买了，没有待购的。要加新的就说「把XX加进购物清单」。`;
  }
  const lines = [
    `🛒 你购物清单里还有 ${notBought.length} 件待购：`,
    ...notBought.map((it, i) => {
      const cheapest = it.prices.length
        ? `（已比价，最低￥${Math.min(...it.prices.map((p) => p.price))}）`
        : it.targetPrice
        ? `（目标 ￥${it.targetPrice}，未比价）`
        : '（未比价）';
      return `${i + 1}. ${it.name} ${cheapest}`;
    })
  ];
  lines.push('\n需要的话我可以帮其中某件做比价分析，或说「把XX标记已买」。');
  return lines.join('\n');
}

/**
 * 购物分析（离线兜底形态）：
 * 真实联网比价需搜索 API + 云函数，当前为常识层参考估算；合规要求：绝不冒充实时报价。
 */
function shoppingAnalyze(msg: string): string {
  const item = (msg.match(/买[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{2,12})/) || [])[1] || '该商品';
  const budget = (msg.match(/预算[^0-9]{0,3}(\d+)/) || [])[1] || null;
  const rows = [
    ['京东自营', '￥2,899', '★★★★☆', '次日达 · 官方售后'],
    ['天猫官方旗舰', '￥2,949', '★★★★☆', '赠品较多 · 7天无理由'],
    ['拼多多百亿补贴', '￥2,659', '★★★☆☆', '价格最低 · 需蹲券'],
    ['实体线下门店', '￥3,099', '★★★★★', '可上手体验 · 报价可谈']
  ];
  const cheapest = rows.reduce((a, b) => {
    const p = (s: string) => Number(s.replace(/[^\d]/g, ''));
    return p(a[1]) < p(b[1]) ? a : b;
  });
  const lines = [
    `🔍 帮你从常识层面梳理「${item}」的选购思路（离线参考，非实时报价）…`,
    '',
    '📊 平台对比（参考价 · 非实时，以下单页面实际价格为准）',
    ...rows.map((r) => `${r[0]}  ${r[1]}  ${r[2]}  ${r[3]}`),
    '',
    `✅ 参考结论：示例价位中 ${cheapest[0]} 最低（${cheapest[1]}），适合预算敏感的入手。`
  ];
  if (budget) {
    const b = Number(budget);
    lines.push(`\n按你 ${budget} 元预算看，${rows.every((r) => b < Number(r[1].replace(/[^\d]/g, ''))) ? '各平台都超了预算，建议加一点预算或换个型号。' : '首选在预算内 + 售后好的那一档。'}`);
  }
  lines.push(
    '\n💡 需要的话我可以：1) 把它加进购物清单跟进降价  2) 换个价格区间继续比。',
    '（提示：以上为参考估算，非实时报价；下单前请以平台实际价格为准。）'
  );
  return lines.join('\n');
}

/** 工作助手（模拟）：对粘贴内容做总结 / 提取要点 / 给建议 */
function workAssistant(content: string, workAction: string): { reply: string; action: string } {
  if (!content) {
    return { reply: '请先粘贴要分析的工作内容（报告、会议记录、邮件、方案均可）。', action: 'chat' };
  }
  // 从内容中抽取「关键信息」让模拟结果有真实感：句子、数字、时间、人名样式的词
  const sentences = content
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  const pick = (i: number) => sentences[i % Math.max(sentences.length, 1)] || '（相关内容）';
  const keyFacts = content.match(/[\d,.\d]+[%万亿元天分钟小时个月周]|Q[1-4]|周[一二三四五六日]|\d{1,2}[月日]\d{0,2}[日号]?/g) || [];
  const factsLabel = keyFacts.length > 0 ? `内容里的关键数据：${keyFacts.slice(0, 5).join('、')}` : '内容以描述性信息为主，没有明显数据。';

  if (workAction === 'points') {
    const lines = [
      '📌 提取的关键要点：',
      '',
      ...sentences.slice(0, 5).map((s, i) => `${i + 1}. ${s.slice(0, 40)}${s.length > 40 ? '…' : ''}`),
      '',
      factsLabel,
      '',
      '（预览端为模拟提取，正式版由大模型逐句精炼）'
    ];
    return { reply: lines.join('\n'), action: 'chat' };
  }

  if (workAction === 'advice') {
    const lines = [
      '💡 内容亮点：',
      `这份材料整体结构清晰，${pick(0).slice(0, 24)}…部分信息量最大。`,
      '',
      '给你 3 条建议：',
      `1. ${keyFacts.length > 0 ? '把散落的数字（' + keyFacts.slice(0, 3).join('、') + '）整理成一张对照表，汇报时更有说服力' : '给每个部分加一句「结论先行」的标题，读者 10 秒能抓住重点'}；`,
      `2. 「${pick(1).slice(0, 16)}…」这部分建议补充下一步责任人和截止时间，避免议而不决；`,
      '3. 结尾加一段「风险与需要的支持」，向上汇报时更容易拿到资源。',
      '',
      '（预览端为模拟建议，正式版由大模型结合内容深度分析）'
    ];
    return { reply: lines.join('\n'), action: 'chat' };
  }

  // summary
  const lines = [
    '✍️ 内容总结',
    '',
    '【背景】',
    pick(0).slice(0, 40) + (pick(0).length > 40 ? '…' : ''),
    '',
    '【关键要点】',
    `· ${pick(1).slice(0, 30)}…`,
    `· ${pick(2).slice(0, 30)}…`,
    `· ${factsLabel}`,
    '',
    '【结论与行动项】',
    `· 内容核心围绕「${content.slice(0, 12)}…」展开，建议优先处理上面第 1 条要点相关事项。`,
    '',
    '（预览端为模拟总结，正式版由大模型生成）'
  ];
  return { reply: lines.join('\n'), action: 'chat' };
}
