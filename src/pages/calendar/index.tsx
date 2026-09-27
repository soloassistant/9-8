import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Button, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs, { Dayjs } from 'dayjs';
import classnames from 'classnames';
import EmptyState from '@/components/EmptyState';
import PlanProposalCard from '@/components/PlanProposalCard';
import { apiGetBriefing, apiChat, apiConfirmItem, apiApplyPlan } from '@/services/api';
import { readPlan, writePlan } from '@/data/dailyPlan';
import { brandVars, useThemeStore } from '@/store/theme';
import { formatEventTime } from '@/utils/date';
import { logActivity } from '@/utils/activityLog';
import { isOverlap, hasGapBuffer, buildPlanProposal, DEFAULT_DURATION_MINUTES, SCHED_GAP_BUFFER_MINUTES } from '@/utils/schedule';
import type { PlanProposal, PlanApplyEvent } from '@/utils/schedule';
import type { Briefing, TodoItem } from '@/types';
import { useT, useLanguageStore } from '@/store/language';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAYS_FULL_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_FULL_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 一键重排：空闲槽扫描步长（分钟） */
const RESCHEDULE_STEP_MINUTES = 30;
/** 一键重排：顺延当日上界（小时），超出即视为当天无空闲槽 */
const RESCHEDULE_END_HOUR = 22;

function CalendarPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { theme } = useThemeStore();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [month, setMonth] = useState(() => dayjs());
  const [selected, setSelected] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  /** 手动快速添加日程（真实录入入口，不再只有 AI 提取一条路） */
  const [addTitle, setAddTitle] = useState('');
  const [addTime, setAddTime] = useState('09:00');
  /** 一键重排提案（S-01：仅预览，勾选确认后才经 apiApplyPlan 落库） */
  const [rescheduleProposal, setRescheduleProposal] = useState<PlanProposal | null>(null);

  const loadBriefing = useCallback(async () => {
    try {
      setBriefing(await apiGetBriefing());
    } catch (err) {
      console.error('[CalendarPage] load failed:', err);
      Taro.showToast({ title: '日历加载失败', icon: 'none' });
    }
  }, []);

  useEffect(() => {
    loadBriefing();
  }, []);

  /** 42 格月视图：从当月首个所在周的周日开始 */
  const cells = useMemo(() => {
    const first = month.startOf('month').startOf('week');
    return Array.from({ length: 42 }, (_, i) => first.add(i, 'day'));
  }, [month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, number>();
    (briefing?.events || []).forEach((e) => {
      const key = dayjs(e.startTime).format('YYYY-MM-DD');
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }, [briefing]);

  const todosByDay = useMemo(() => {
    const map = new Map<string, number>();
    (briefing?.todos || []).forEach((t) => {
      if (doneIds.has(t.id)) return;
      const key = t.dueDate ? dayjs(t.dueDate).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }, [briefing, doneIds]);

  /** F24 忙闲统计：本月日程/待办/忙日（日程 ≥3 场的天数）与最忙星期 */
  const monthStats = useMemo(() => {
    const prefix = month.format('YYYY-MM');
    const events = (briefing?.events || []).filter((e) => dayjs(e.startTime).format('YYYY-MM') === prefix);
    const todos = (briefing?.todos || []).filter((td) => td.dueDate && dayjs(td.dueDate).format('YYYY-MM') === prefix);
    const byDay = new Map<string, number>();
    events.forEach((e) => {
      const key = dayjs(e.startTime).format('YYYY-MM-DD');
      byDay.set(key, (byDay.get(key) || 0) + 1);
    });
    const byWeekday = new Array<number>(7).fill(0);
    let busyDays = 0;
    byDay.forEach((count, key) => {
      if (count >= 3) busyDays += 1;
      byWeekday[dayjs(key).day()] += count;
    });
    const peak = byWeekday.indexOf(Math.max(...byWeekday));
    // 该星期 ≥2 场才展示「最忙星期」，避免日程极少时的误导
    const peakLabel = byWeekday[peak] >= 2 ? (lang === 'en' ? WEEKDAYS_FULL_EN[peak] : WEEKDAYS_FULL_ZH[peak]) : null;
    return { events: events.length, todos: todos.length, busyDays, peakLabel };
  }, [briefing, month, lang]);

  const selectedDate = dayjs(selected);
  const dayEvents = (briefing?.events || []).filter((e) => dayjs(e.startTime).format('YYYY-MM-DD') === selected);
  /** 无截止日期的待办默认归入今日（与晨报页"今日日程"口径一致） */
  const dayTodos = (briefing?.todos || []).filter(
    (t) => (t.dueDate ? dayjs(t.dueDate).format('YYYY-MM-DD') === selected : selected === dayjs().format('YYYY-MM-DD'))
  );

  /** 冲突检测：当天日程两两做时间重叠判断（endTime 为空的按项目缺省时长语义处理——
   *  复用 schedule.ts 的 isOverlap，其内部对空 endTime 按 DEFAULT_DURATION_MINUTES=90 兜底，
   *  项目无 DEFAULT_EVENT_MINUTES 常量，不重复造轮子） */
  const conflictCount = useMemo(() => {
    const list = dayEvents;
    let n = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (isOverlap(list[i].startTime, list[i].endTime, list[j].startTime, list[j].endTime)) n += 1;
      }
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefing, selected]);

  /** 切换日期时收起重排提案（提案只属于选中那天） */
  useEffect(() => {
    setRescheduleProposal(null);
  }, [selected]);

  const handleToggleTodo = async (todo: TodoItem) => {
    const next = new Set(doneIds);
    const finishing = !next.has(todo.id);
    if (finishing) next.add(todo.id);
    else next.delete(todo.id);
    setDoneIds(next);
    if (finishing) logActivity('✅', `完成待办：${todo.title.slice(0, 14)}`);
    if (!isWeapp) {
      // H5 真实落库：直写本地 plan 存储，刷新后完成状态不丢
      try {
        const plan = readPlan();
        const hit = plan.todos.find((td) => td.id === todo.id);
        if (hit) {
          hit.status = finishing ? 'done' : 'confirmed';
          writePlan(plan);
        }
      } catch (err) {
        console.warn('[CalendarPage] toggle todo persist failed:', err);
      }
      return;
    }
    try {
      // 复用对话通道记录状态（真实端由 confirmItem 扩展承接）
      await apiChat(finishing ? `完成了「${todo.title}」` : `取消完成「${todo.title}」`);
    } catch (err) {
      console.error('[CalendarPage] toggle todo failed:', err);
    }
  };

  /** 快速添加：写入当前选中日期（H5 本地 confirmItem 落库，weapp 走云函数），完成后刷新视图 */
  const handleQuickAdd = async () => {
    const title = addTitle.trim();
    if (!title) {
      Taro.showToast({ title: '先填写事项名称', icon: 'none' });
      return;
    }
    const hm = /^([0-1]?\d|2[0-3]):[0-5]\d$/.test(addTime.trim()) ? addTime.trim() : '09:00';
    try {
      const res = await apiConfirmItem({
        events: [{ title: title.slice(0, 24), startTime: `${selected} ${hm}`, source: '手动添加' }],
        todos: []
      });
      setAddTitle('');
      await loadBriefing();
      Taro.showToast({ title: `已添加日程（${res.saved} 条）`, icon: 'success' });
    } catch (err) {
      console.error('[CalendarPage] quick add failed:', err);
      Taro.showToast({ title: '添加失败，请重试', icon: 'none' });
    }
  };

  /** 单向写入手机系统日历（小程序支持写入、不支持读取） */
  const handleWriteSystemCalendar = async () => {
    if (!isWeapp) {
      Taro.showToast({ title: '微信端可写入手机日历', icon: 'none' });
      return;
    }
    if (dayEvents.length === 0) {
      Taro.showToast({ title: '当天没有日程', icon: 'none' });
      return;
    }
    try {
      for (const evt of dayEvents) {
        await Taro.addPhoneCalendar({
          title: evt.title,
          startTime: dayjs(evt.startTime).unix(),
          endTime: evt.endTime ? dayjs(evt.endTime).unix() : dayjs(evt.startTime).add(1, 'hour').unix(),
          location: evt.location,
          description: evt.source ? `来源：${evt.source}` : undefined,
          alarm: true,
          alarmOffset: 15 * 60
          // Taro 类型把 endTime 标为 string，微信运行时实际收 unix 秒（wx.addPhoneCalendar 文档），双段断言屏蔽该类型缺陷
        } as unknown as Taro.addPhoneCalendar.Option);
      }
      Taro.showToast({ title: `已写入 ${dayEvents.length} 条日程`, icon: 'success' });
    } catch (err) {
      console.error('[CalendarPage] addPhoneCalendar failed:', err);
      Taro.showToast({ title: '写入失败，请检查日历权限', icon: 'none' });
    }
  };

  /**
   * 一键重排提案（按 buildPlanProposal 语义本地构造 raw，再交其组装补候选）：
   * - 按开始时间排序，首件事保持不动；
   * - 后续与已占时段重叠的日程，从原开始时间起按 30 分钟步进顺延，
   *   落到当日第一个不重叠的空闲槽（22:00 前截止），保留原时长（endTime 缺省按
   *   DEFAULT_DURATION_MINUTES=90）与地点（走 eventId 更新，未传字段云端不覆盖）；
   * - P1-F：新时段与前后相邻事件各留 ≥ SCHED_GAP_BUFFER_MINUTES 分钟（不背靠背），
   *   找不到带间隙的槽时回退为无缓冲槽并置 noBufferFallback 标注，不直接失败；
   * - 保守策略：已顺延事件的原时段仍视为占用，避免链式腾挪；找不到空闲槽的条目保持原状不入提案。
   */
  const buildRescheduleRaw = () => {
    const sorted = [...dayEvents].sort((a, b) => dayjs(a.startTime).valueOf() - dayjs(b.startTime).valueOf());
    if (sorted.length < 2) return [];
    // placed：重排模拟中的已占时段（初值 = 全部原时段）；下标与 sorted 一一对应，供排除「自身原时段」
    const placed = sorted.map((e) => ({ startTime: e.startTime, endTime: e.endTime || undefined }));
    const dayEnd = dayjs(`${selected} ${String(RESCHEDULE_END_HOUR).padStart(2, '0')}:00`);
    const raw: Array<{ title: string; fromTime: string; toTime: string; endTime?: string; eventId: string; noBufferFallback?: boolean }> = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const evt = sorted[i];
      // 触发检查排除自身原时段（placed[i]），否则自重叠恒真、无冲突事件也会被冗余重排
      const clashWithOthers = placed.some(
        (p, idx) => idx !== i && isOverlap(evt.startTime, evt.endTime, p.startTime, p.endTime)
      );
      if (!clashWithOthers) continue;
      const durationMin =
        evt.endTime && dayjs(evt.endTime).isValid()
          ? Math.max(1, dayjs(evt.endTime).diff(dayjs(evt.startTime), 'minute'))
          : DEFAULT_DURATION_MINUTES;
      // 候选的占位参照：除自身原时段外的全部已占时段（原时段保留占用，供后续事件避让）
      const others = placed.filter((_, idx) => idx !== i);
      /** 顺延扫描：requireGap=true 时要求与相邻事件各留 ≥10 分钟 */
      const findSlot = (requireGap: boolean): string | null => {
        let cursor = dayjs(evt.startTime);
        while (cursor.add(durationMin, 'minute').valueOf() <= dayEnd.valueOf()) {
          const candStart = cursor.format('YYYY-MM-DD HH:mm');
          const candEnd = cursor.add(durationMin, 'minute').format('YYYY-MM-DD HH:mm');
          const clashFree = !others.some((p) => isOverlap(candStart, candEnd, p.startTime, p.endTime));
          const gapOk = !requireGap || hasGapBuffer(candStart, candEnd, others, SCHED_GAP_BUFFER_MINUTES);
          if (clashFree && gapOk) return candStart;
          cursor = cursor.add(RESCHEDULE_STEP_MINUTES, 'minute');
        }
        return null;
      };
      let newStart = findSlot(true);
      let noBuffer = false;
      if (!newStart) {
        // P1-F：无带间隙槽 → 回退无缓冲并标注（不直接失败）
        newStart = findSlot(false);
        noBuffer = true;
      }
      if (newStart) {
        // endTime 随新起点平移（保留原时长），避免顺延后出现 end ≤ start 的坏数据
        const newEnd = evt.endTime
          ? dayjs(newStart).add(durationMin, 'minute').format('YYYY-MM-DD HH:mm')
          : undefined;
        raw.push({
          title: evt.title,
          fromTime: evt.startTime,
          toTime: newStart,
          endTime: newEnd,
          eventId: evt.id,
          noBufferFallback: noBuffer || undefined
        });
        // 顺延后新时段占用；原时段保持占用（保守，见上注释）
        placed.push({ startTime: newStart, endTime: newEnd });
      }
    }
    return raw;
  };

  /** 点「一键重排」：生成提案预览（不写库，S-01） */
  const handleStartReschedule = () => {
    const raw = buildRescheduleRaw();
    if (raw.length === 0) {
      Taro.showToast({ title: t('calendar.rescheduleNoSlot'), icon: 'none' });
      return;
    }
    // buildPlanProposal(raw, existing)：toTime 无冲突则沿用，冲突时自动落 ranked 候选
    setRescheduleProposal(buildPlanProposal(raw, dayEvents));
  };

  /** 确认落库：唯一写库通道 apiApplyPlan（S-01）。内部已 catch 不 reject，必须检查返回值 ok */
  const handleApproveReschedule = async (events: PlanApplyEvent[], src: PlanProposal) => {
    const result = await apiApplyPlan({ events, proposalId: src.id, count: events.length });
    if (result.ok) {
      Taro.showToast({ title: t('calendar.rescheduleSaved', { n: result.saved }), icon: 'success' });
      setRescheduleProposal(null);
      await loadBriefing(); // 刷新当天数据
    } else {
      Taro.showToast({ title: t('calendar.rescheduleFailed'), icon: 'none' });
    }
  };

  const monthLabel = month.format('YYYY年M月');

  const renderCell = (d: Dayjs) => {
    const key = d.format('YYYY-MM-DD');
    const inMonth = d.isSame(month, 'month');
    const isToday = d.isSame(dayjs(), 'day');
    const isSelected = key === selected;
    const evtCount = eventsByDay.get(key) || 0;
    const todoCount = todosByDay.get(key) || 0;
    return (
      <View
        key={key}
        className={classnames(
          styles.cell,
          evtCount >= 3 ? styles.cellHot : evtCount >= 1 && styles.cellWarm,
          !inMonth && styles.dim,
          isSelected && styles.selected,
          isToday && styles.today
        )}
        onClick={() => setSelected(key)}
      >
        <Text className={styles.cellDay}>{d.date()}</Text>
        <View className={styles.dots}>
          {evtCount > 0 ? <View className={styles.dotEvent} /> : null}
          {todoCount > 0 ? <View className={styles.dotTodo} /> : null}
        </View>
      </View>
    );
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.panel}>
        <View className={styles.monthBar}>
          <Button
            className={styles.navButton}
            onClick={() => setMonth((m) => m.subtract(1, 'month'))}
            aria-label='上个月'
          >
            ‹
          </Button>
          <Text className={styles.monthLabel}>{monthLabel}</Text>
          <Button
            className={styles.navButton}
            onClick={() => setMonth((m) => m.add(1, 'month'))}
            aria-label='下个月'
          >
            ›
          </Button>
        </View>

        <View className={styles.weekHead}>
          {WEEK_HEAD.map((w) => (
            <Text key={w} className={styles.weekDay}>
              {w}
            </Text>
          ))}
        </View>
        <View className={styles.grid}>{cells.map(renderCell)}</View>

        <View className={styles.legend}>
          <View className={styles.legendItem}>
            <View className={styles.dotEvent} />
            <Text className={styles.legendText}>{t('calendar.legendSchedule')}</Text>
          </View>
          <View className={styles.legendItem}>
            <View className={styles.dotTodo} />
            <Text className={styles.legendText}>{t('calendar.legendTodo')}</Text>
          </View>
        </View>

        {/* F24 忙闲统计：本月日程 / 待办 / 忙日 / 最忙星期 */}
        <View className={styles.statsBar}>
          <Text className={styles.statsTitle}>{t('calendar.statsTitle')}</Text>
          {monthStats.events + monthStats.todos === 0 ? (
            <Text className={styles.statsEmpty}>{t('calendar.statsEmpty')}</Text>
          ) : (
            <View className={styles.statsRow}>
              <View className={styles.statItem}>
                <Text className={styles.statValue}>{monthStats.events}</Text>
                <Text className={styles.statLabel}>{t('calendar.statsEvents')}</Text>
              </View>
              <View className={styles.statItem}>
                <Text className={styles.statValue}>{monthStats.todos}</Text>
                <Text className={styles.statLabel}>{t('calendar.statsTodos')}</Text>
              </View>
              <View className={styles.statItem}>
                <Text className={styles.statValue}>{monthStats.busyDays}</Text>
                <Text className={styles.statLabel}>{t('calendar.statsBusy')}</Text>
              </View>
              {monthStats.peakLabel ? (
                <View className={styles.statItem}>
                  <Text className={styles.statValue}>{monthStats.peakLabel}</Text>
                  <Text className={styles.statLabel}>{t('calendar.statsPeak')}</Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </View>

      <View className={styles.dayPanel}>
        <View className={styles.dayHeader}>
          <Text className={styles.dayTitle}>
            {selectedDate.isSame(dayjs(), 'day') ? '今天 · ' : ''}
            {selectedDate.format('M月D日')}{' '}
            {['周日', '周一', '周二', '周三', '周四', '周五', '周六'][selectedDate.day()]}
          </Text>
          <Button className={styles.syncButton} onClick={handleWriteSystemCalendar}>
            写入手机日历
          </Button>
        </View>

        <View className={styles.quickAdd}>
          <Input
            className={styles.qaTitle}
            value={addTitle}
            placeholder='手动添加日程，如：产品评审会'
            maxlength={24}
            onInput={(e) => setAddTitle(e.detail.value)}
            confirmType='done'
            onConfirm={handleQuickAdd}
          />
          <Input
            className={styles.qaTime}
            value={addTime}
            maxlength={5}
            onInput={(e) => setAddTime(e.detail.value)}
            onConfirm={handleQuickAdd}
          />
          <View className={styles.qaBtn} onClick={handleQuickAdd}>
            添加
          </View>
        </View>

        {/* 冲突条 + 一键重排（S-01：有冲突才渲染，无冲突不留空壳；提案预览替换冲突条） */}
        {rescheduleProposal ? (
          <View className={styles.rescheduleWrap}>
            <PlanProposalCard
              proposal={rescheduleProposal}
              existing={dayEvents}
              onApprove={handleApproveReschedule}
              onAbandon={() => setRescheduleProposal(null)}
            />
          </View>
        ) : conflictCount > 0 ? (
          <View className={styles.conflictBar}>
            <Text className={styles.conflictText}>{t('calendar.conflictCount', { n: conflictCount })}</Text>
            <View className={styles.rescheduleBtn} onClick={handleStartReschedule}>
              <Text className={styles.rescheduleBtnText}>{t('calendar.rescheduleBtn')}</Text>
            </View>
          </View>
        ) : null}

        {dayEvents.length === 0 && dayTodos.length === 0 ? (
          <EmptyState icon='🗓' title='这一天没有安排' hint='转发消息到收件箱，或直接告诉助理帮你安排' />
        ) : (
          <>
            {dayEvents.map((evt) => (
              <View key={evt.id} className={styles.eventRow}>
                <View className={styles.timeTag}>
                  <Text className={styles.timeText}>{dayjs(evt.startTime).format('HH:mm')}</Text>
                </View>
                <View className={styles.eventBody}>
                  <Text className={styles.eventTitle}>{evt.title}</Text>
                  {evt.location ? <Text className={styles.eventLoc}>📍 {evt.location}</Text> : null}
                </View>
              </View>
            ))}
            {dayTodos.map((todo) => {
              const done = doneIds.has(todo.id);
              return (
                <View key={todo.id} className={styles.todoRow} onClick={() => handleToggleTodo(todo)}>
                  <View className={classnames(styles.todoCheck, done && styles.todoChecked)}>
                    {done ? <Text className={styles.checkMark}>✓</Text> : null}
                  </View>
                  <Text className={classnames(styles.todoTitle, done && styles.todoDone)}>{todo.title}</Text>
                  {todo.dueDate ? <Text className={styles.todoDue}>{formatEventTime(todo.dueDate)}</Text> : null}
                </View>
              );
            })}
          </>
        )}
      </View>
    </View>
  );
}

export default CalendarPage;
