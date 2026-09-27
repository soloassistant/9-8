/**
 * 晨报自适应信号计算（F21 晨报自适应排序）
 * 三条规则（PRD）：
 *   1. 日程爆满（≥4 项或总时长 ≥5h）→ 日程区前置
 *   2. 次日外地行程（出行关键词命中）→ 情报切目的地天气
 *   3. 高优待办（今天 12 点前到期或标题含急）→ 开场点名
 * 纯函数、双端共用：mock getBriefing 与晨报页都调用，保证排序口径一致。
 */
import dayjs from 'dayjs';
import type { BriefingAdaptive, ScheduleEvent, TodoItem } from '../types';

/** 出行关键词：命中即视为次日有外地行程 */
const TRAVEL_KEYWORDS = /(机场|航班|飞机|高铁|火车|动车|出差|出发)/;
/** 紧急待办关键词 */
const URGENT_KEYWORDS = /(尽快|急|务必|今天必须|上午要)/;

/** 无结束时间的日程按 1 小时估算 busy 时长 */
const DEFAULT_EVENT_MINUTES = 60;

export function computeAdaptive(events: ScheduleEvent[], todos: TodoItem[]): BriefingAdaptive {
  const now = dayjs();

  // 1) 日程爆满检测
  const todayEvents = events.filter((e) => dayjs(e.startTime).isSame(now, 'day'));
  const busyMinutes = todayEvents.reduce((sum, e) => {
    const mins = e.endTime ? dayjs(e.endTime).diff(dayjs(e.startTime), 'minute') : DEFAULT_EVENT_MINUTES;
    return sum + (mins > 0 ? mins : DEFAULT_EVENT_MINUTES);
  }, 0);
  const busyDay = todayEvents.length >= 4 || busyMinutes >= 300;

  // 2) 次日外地行程 → 提取目的地城市
  const tomorrow = now.add(1, 'day');
  const tripEvent = events.find(
    (e) =>
      dayjs(e.startTime).isSame(tomorrow, 'day') &&
      TRAVEL_KEYWORDS.test(`${e.title} ${e.location || ''} ${e.source || ''}`)
  );
  let tripCity: string | null = null;
  if (tripEvent) {
    const m = `${tripEvent.title} ${tripEvent.location || ''}`.match(/(?:去|到|飞|抵达|前往)\s*([\u4e00-\u9fa5]{2,6})/);
    tripCity = m ? m[1] : (tripEvent.location || '').replace(/\s/g, '').slice(0, 6) || null;
  }

  // 3) 高优待办：今天 12:00 前到期，或标题含紧急词，取最早一条
  const focus = todos
    .filter((t) => t.status !== 'done' && t.dueDate && dayjs(t.dueDate).isSame(now, 'day'))
    .filter((t) => dayjs(t.dueDate).hour() < 12 || URGENT_KEYWORDS.test(t.title))
    .sort((a, b) => dayjs(a.dueDate!).valueOf() - dayjs(b.dueDate!).valueOf())[0];

  return {
    busyDay,
    tripCity,
    focusTodo: focus ? focus.title : null,
    // 负载条透出：busyMinutes 数值本身（busyDay 只保留布尔结论），todayCount 当日日程数
    busyMinutes,
    todayCount: todayEvents.length
  };
}
