import dayjs from 'dayjs';
import type { Briefing } from '../types';
import { readPlan } from './dailyPlan';
import shopping from './shopping';
import { listCollections } from './collectionStore';
import { computeAdaptive } from '../utils/adaptive';
import { computeWeeklyReview } from '../utils/weeklyReview';
import { evaluatePriceAlerts, type PricedItem, type PriceAlert } from '../utils/price';

/** mock 晨报：v1.1 的 Briefing + v1.2 新增的降价提醒（P-01） */
export type MockBriefing = Briefing & { priceAlerts: PriceAlert[] };

/**
 * 时机② 晨报生成时的降价提醒（P-01，零 API 成本）：
 * 只读 mock 购物清单里已有的价格记录做比对，绝不主动抓价。
 */
function collectPriceAlerts(): PriceAlert[] {
  try {
    const items = shopping({ action: 'list' }) as unknown as PricedItem[];
    return evaluatePriceAlerts(Array.isArray(items) ? items : []);
  } catch (err) {
    console.warn('[mock:getBriefing] price alerts failed:', err);
    return [];
  }
}

/** mock: getBriefing —— 返回今日晨报（动态读取统一的待办/日程存储，自适应排序 F21） */

// X7 收尾冷知识池：与云函数 cloudfunctions/getBriefing/index.js 的 TRIVIA_POOL 保持同一池、同一
// 确定性口径（dateStr 去 '-' 后数字 % 池长度），任何一侧改动必须同步另一侧。
const TRIVIA_POOL: string[] = [
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
function pickTrivia(dateStr: string): string {
  const n = Number(dateStr.replace(/-/g, '')) || 0;
  return TRIVIA_POOL[n % TRIVIA_POOL.length];
}

/** X6 周末轻量版：资讯条数减半（min 2 条）；非周末原样返回 */
function trimListForWeekend<T>(list: T[]): T[] {
  const n = list.length;
  if (n <= 2) return list;
  const keep = Math.max(2, Math.floor(n / 2));
  return keep >= n ? list : list.slice(0, keep);
}

export default function getBriefing(): MockBriefing {
  const plan = readPlan();
  const today = dayjs().format('YYYY-MM-DD');
  const adaptive = computeAdaptive(plan.events, plan.todos);

  // P1-G 本周复盘：真实「现在起往前 7 天（含今天）」窗口统计
  // 兜底：mock 本地存储若全是偏旧的演示日期导致窗口为空，则把窗口锚点推到远期未来，用全量数据兜底
  // （仅 H5 演示路径；窗口算法本身仍是真实 7 天逻辑，不额外造数据）
  let weeklyReview = computeWeeklyReview(plan.events, plan.todos);
  if (weeklyReview.todosDone === 0 && weeklyReview.eventCount === 0 && weeklyReview.keywords.length === 0) {
    // 演示数据：窗口内无记录，放宽为全量统计以便演示
    weeklyReview = computeWeeklyReview(plan.events, plan.todos, new Date('9999-12-31T00:00:00'));
  }

  // 自适应开场：爆满日强调日程前置；有高优待办先点名
  let greeting = '早上好，新的一天从晨报开始';
  if (adaptive.busyDay) greeting = '今天日程很满，先看日程再逐项推进';
  else if (adaptive.focusTodo) greeting = `先办「${adaptive.focusTodo}」，其他从容推进`;

  // 昨日收藏精选：读真实收藏库最近 2 条（无收藏时空数组，晨报隐藏该区块，不再造演示文章）
  // X6 周末轻量版：周末资讯类条目减半（min 2 条）——mock 侧的「资讯」即 digest
  const isWeekend = dayjs().day() === 0 || dayjs().day() === 6;
  const digestAll = listCollections()
    .slice(0, 2)
    .map((c) => `《${c.title}》：${c.summary}`);
  const digest = isWeekend ? trimListForWeekend(digestAll) : digestAll;

  return {
    date: today,
    greeting,
    events: plan.events,
    todos: plan.todos,
    digest,
    read: false,
    adaptive,
    weeklyReview,
    trivia: pickTrivia(today),
    ...(isWeekend ? { weekendEdition: true } : {}),
    priceAlerts: collectPriceAlerts()
  };
}
