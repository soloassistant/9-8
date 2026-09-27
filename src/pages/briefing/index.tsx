import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Input, Button, Image } from '@tarojs/components';
import Taro, { usePullDownRefresh, useDidShow, useDidHide, useShareAppMessage } from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import VoiceButton, { VoiceResult } from '@/components/VoiceButton';
import EmptyState from '@/components/EmptyState';
import PermissionDialog from '@/components/PermissionDialog';
import IntelGroupCard from '@/components/IntelGroupCard';
import HabitGuardBar from '@/components/HabitGuardBar';
import PlanProposalCard from '@/components/PlanProposalCard';
import { BriefingSkeleton } from '@/components/Skeleton';
import { resolveIntelGroups } from '@/utils/intelGroups';
import { apiGetBriefing, apiChat, apiChatStream, apiApplyPlan } from '@/services/api';
import { buildPlanProposal } from '@/utils/schedule';
import type { PlanProposal, PlanApplyEvent } from '@/utils/schedule';
import { guardHabitsOnOpen, commitHabitGuards, listRestorableRecords, undoHabitGuard, createHabit } from '@/utils/habit';
import type { HabitGuardRecord } from '@/utils/habit';
import { locateCity } from '@/services/location';
import {
  ensurePermission,
  isDeniedDegraded,
  openAppSetting,
  recordPermissionResult,
  shouldShowDialog
} from '@/utils/permission';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore } from '@/store/theme';
import { getGreeting, formatEventTime } from '@/utils/date';
import { logActivity } from '@/utils/activityLog';
import { bumpVoiceUsage } from '@/utils/usage';
import { readPlan, writePlan } from '@/data/dailyPlan';
import { computeAdaptive } from '@/utils/adaptive';
import { sceneByHour, splitTtsChunks, startSpeak, stopSpeak } from '@/utils/tts';
import { loadChatLog, saveChatLog } from '@/utils/chatLog';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT, hasAgreedConsent, saveConsent } from '@/data/legal';
import {
  beginReadSession,
  markSectionSeen,
  settleReadOnHide,
  settleReadStreakOnOpen,
  tickReadSession,
  getReadStreak,
  isTodayRead,
  migrateFromLearnStreak,
  READ_MIN_MS,
  READ_MIN_SECTIONS
} from '@/utils/readStreak';
import type { ReadSectionKind, ReadSession } from '@/utils/readStreak';
import { canPromptSubscribe, promptSubscribe, isSubscriptionStale } from '@/utils/subscribe';
import type { Briefing, ChatMessage, ScheduleEvent } from '@/types';
import { useT, useLanguageStore } from '@/store/language';
import type { LangKey } from '@/store/language';
import { readPrefs } from '@/utils/prefs';
import styles from './index.module.scss';
import shareCover from '@/assets/share-cover.png';
// 订阅模板 id 集中配置（上线三件事）：空串 = 未配置，promptSubscribe 内部 noop
import { SUBSCRIBE_TEMPLATE_ID } from '@/config/subscribe';

const isWeapp = process.env.TARO_ENV === 'weapp';
/** H5 预览端底部有 50px TabBar，输入栏需避让 */
const isH5 = process.env.TARO_ENV === 'h5';

/** 快捷指令（优化输入：点击填充输入框，减少手打成本） */
const QUICK_COMMANDS: Array<{ icon: string; labelKey: LangKey; text: string }> = [
  { icon: '📅', labelKey: 'briefing.quickSchedule', text: '帮我安排 ' },
  { icon: '✍️', labelKey: 'briefing.quickNote', text: '记一下：' },
  { icon: '✅', labelKey: 'briefing.quickDone', text: '完成了「」' },
  { icon: '🔥', labelKey: 'briefing.quickHot', text: '今天有什么热点' }
];
/** 订阅消息模板 ID：从 src/config/subscribe.ts 集中读取（未配置为空串时 promptSubscribe noop） */

/** AI 对话本地持久化 key（上限 60 条） */
const BRIEFING_CHAT_LOG_KEY = 'briefingChatLog';
/** F-04 晨报当日缓存 key：{ date: 'YYYY-MM-DD', data: Briefing }，同日二次进入秒开 */
const BRIEFING_CACHE_KEY = 'briefingDailyCache';
/** X8 连读徽章 storage key：{ last: 'YYYY-MM-DD', count: n }，进页即记当天 */
const BRIEF_STREAK_KEY = 'mb-brief-streak';

/** 读当日晨报缓存：跨日或损坏时视为未命中 */
function readBriefingCache(): Briefing | null {
  try {
    const raw = Taro.getStorageSync(BRIEFING_CACHE_KEY) as { date?: string; data?: Briefing } | undefined;
    if (raw && raw.date === dayjs().format('YYYY-MM-DD') && raw.data) return raw.data;
  } catch (err) {
    console.warn('[BriefingPage] read briefing cache failed:', err);
  }
  return null;
}

/** 写晨报当日缓存（失败仅静默，不影响主流程） */
function writeBriefingCache(data: Briefing) {
  try {
    Taro.setStorageSync(BRIEFING_CACHE_KEY, { date: dayjs().format('YYYY-MM-DD'), data });
  } catch (err) {
    console.warn('[BriefingPage] write briefing cache failed:', err);
  }
}

/**
 * X8 连读徽章：本地统计「连续打开晨报页」天数。
 * 算法：今天已记（last=今天）→ 原样返回；last=昨天 → count+1；否则（首次/断档）→ 重置 1。
 * 与 readStreak（有效阅读打卡）相互独立：本徽章只看「有没有来」，门槛低（≥2 天即显示）。
 */
function bumpBriefStreak(): number {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const raw = Taro.getStorageSync(BRIEF_STREAK_KEY) as { last?: string; count?: number } | undefined;
    if (raw && raw.last === today) {
      return typeof raw.count === 'number' && raw.count > 0 ? raw.count : 1;
    }
    const prev = raw && raw.last === yesterday && typeof raw.count === 'number' && raw.count > 0 ? raw.count : 0;
    const count = prev + 1;
    Taro.setStorageSync(BRIEF_STREAK_KEY, { last: today, count });
    return count;
  } catch (err) {
    console.warn('[BriefingPage] brief streak failed:', err);
    return 0;
  }
}

/** H5 预览时模拟语音转写的示例指令 */
const MOCK_TRANSCRIPTS = [
  '把产品评审会改到明天下午两点',
  '我今天有什么安排',
  '回复客户邮件这个待办完成了'
];
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 阅读计时心跳间隔（毫秒）：前台累计停留时长，30s 阈值下 5s 心跳精度足够且开销小 */
const READ_TICK_INTERVAL_MS = 5000;
/** 习惯自动挪动后 toast 的展示时长（毫秒）：与「5 秒撤销」窗口一致 */
const HABIT_TOAST_MS = 5000;
/** U-01 骨架屏延迟：加载超过该时长才显示骨架（防快速命中缓存时闪烁） */
const SKELETON_DELAY_MS = 300;

function BriefingPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { theme } = useThemeStore();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  // AI 对话本地持久化：重进恢复上下文（上限 60 条，超限截旧）
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const restored = loadChatLog<ChatMessage>(BRIEFING_CHAT_LOG_KEY);
    return restored;
  });
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [deepMode, setDeepMode] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { profile, usage, init, refreshUsage } = useUserStore();
  const mockIndexRef = useRef(0);
  // U-01 骨架屏：首屏加载 >300ms 才显示（briefing 到位后熄灭，下拉刷新有旧内容不闪骨架）
  const [showSkeleton, setShowSkeleton] = useState(false);
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 消息 id 计数器以恢复的历史长度为起点，避免与持久化消息 id 冲突
  const msgIdRef = useRef(messages.length);

  /* ---------------- X8 连读徽章 + X6 周末轻量版用户偏好（进页读取一次） ---------------- */
  const [briefStreak] = useState(() => bumpBriefStreak());
  // X6 用户偏好覆盖：weekendEdition=false 时不显示横幅、不做展示侧减量（生成侧标记保留但被忽略）
  const [prefsWeekendEdition] = useState(() => readPrefs().weekendEdition);
  // X4 订阅临期续订提醒条：用户关闭后本次会话内不再显示（state 即可，不落 storage）
  const [renewBarHidden, setRenewBarHidden] = useState(false);

  /* ---------------- v2.1 每日读晨报连续（streak 改挂晨报） ---------------- */
  // 阅读会话内存态（不入 storage）：只存 ref，避免心跳 setInterval 闭包读到过期 state
  const readSessionRef = useRef<ReadSession | null>(null);
  const readTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [readStreak, setReadStreak] = useState(0);
  const [todayRead, setTodayRead] = useState(false);
  // 会话序号：每次 useDidShow 递增，作为区块上报 effect 的触发钥匙
  // （否则「返回页面」时会话重建但 briefing 未变，effect 不重跑 → 区块曝光丢失）
  const [readSessionEpoch, setReadSessionEpoch] = useState(0);

  /* ---------------- v2.1 习惯自动守护（增量 3） ---------------- */
  // 待还原的守护记录（自动挪动且未撤销、仍在撤销窗口内）
  const [guardRecords, setGuardRecords] = useState<HabitGuardRecord[]>([]);
  // 高风险转方案（交 PlanProposalCard 走既有 S-01~S-04 确认链路）
  const [habitProposal, setHabitProposal] = useState<PlanProposal | null>(null);
  // 自动挪动后的 toast（5 秒内可撤销，同 memory 撤销模式）
  const [habitToast, setHabitToast] = useState<HabitGuardRecord | null>(null);
  const habitToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // briefing 引用：useDidShow 时可能尚未拿到最新 briefing，用 ref 兜住「返回页面」场景
  const briefingRef = useRef<Briefing | null>(null);

  // H5 首启合规同意（小程序端依赖微信平台隐私弹窗机制，仅网页端启用）
  const [showConsent, setShowConsent] = useState(() => isH5 && !hasAgreedConsent());
  const [consentDeclined, setConsentDeclined] = useState(false);
  const handleConsentAgree = () => {
    saveConsent();
    setConsentDeclined(false);
    setShowConsent(false);
  };
  const handleConsentDecline = () => setConsentDeclined(true);

  // 对话变化落 storage（截断由 saveChatLog 兜底）
  useEffect(() => {
    saveChatLog(BRIEFING_CHAT_LOG_KEY, messages);
  }, [messages]);

  // 转发分享（F30）：带品牌分享封面
  useShareAppMessage(() => ({
    title: t('share.title'),
    path: '/pages/briefing/index',
    imageUrl: shareCover
  }));

  /**
   * 守护结算串行化（in-flight 互斥）。
   *
   * 为什么必须有：`useDidShow` 与 `loadBriefing` 的完成回调在冷启动 / 下拉刷新时几乎同时触发，
   * 而 `guardHabitsOnOpen` 内部要 `await` 远端写库。两次并发规划会各自生成**不同 id** 的记录，
   * 于是 `commitHabitGuards` 的「按记录 id 幂等」完全失效 —— 结果是同一次冲突被重复写入两次、
   * 用户收到两条站内信、还会弹两次「已守护」。
   *
   * 用 promise 链把结算排成队列（而不是直接丢弃后一次）：
   * 后一次必然在前一次**提交完成之后**才规划，届时规划器已能看到「同习惯同日已守护」而自动跳过；
   * 若前一次因写库失败未提交，后一次会重新规划 —— 正好等价于重试，不会丢守护。
   */
  const guardQueueRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * 习惯自动守护惰性结算（与 settleReadStreakOnOpen 同构）：进页面 / 刷新晨报后调用。
   * - 低风险 → 自动挪动（记录 + 站内信），此处 toast + 5s 撤销，并尽力经既有写库通道落库；
   * - 高风险 → 生成提案交 PlanProposalCard，绝不自动挪动。
   * 逻辑全部在 utils/habit.ts（纯函数），此处只做事件翻译。
   */
  const runHabitGuard = useCallback((events: ScheduleEvent[]) => {
    const task = guardQueueRef.current.then(async () => {
      try {
        const outcome = guardHabitsOnOpen(events);
        if (outcome.autoMoved.length > 0) {
          // 顺序很重要：**先落库、确认成功后再登记本地记录与站内信**。
          // 反过来的话，写库失败会留下「已守护」记录与站内信，让用户以为日程已经改好，实际却没有。
          const payload: PlanApplyEvent[] = outcome.autoMoved.map((r) => ({
            eventId: r.eventId,
            title: r.title,
            startTime: r.toTime
          }));
          // 注意：apiApplyPlan 内部已 catch，**不会 reject**，所以必须检查返回值的 ok 而不是挂 .catch
          const result = await apiApplyPlan({ events: payload });
          if (result.ok) {
            commitHabitGuards(outcome.autoMoved);
            setHabitToast(outcome.autoMoved[0]);
            if (habitToastTimerRef.current) clearTimeout(habitToastTimerRef.current);
            habitToastTimerRef.current = setTimeout(() => setHabitToast(null), HABIT_TOAST_MS);
          } else {
            // 落库失败：不记录、不通知、不提示成功；下次进页面重新规划即等价于重试
            console.warn('[BriefingPage] habit guard apply failed, skipped recording');
          }
        }
        if (outcome.proposals.length > 0) {
          // 已有未处理的方案时不覆盖（避免打断用户就地改时段）
          setHabitProposal((prev) => prev ?? buildPlanProposal(outcome.proposals, events));
        }
        setGuardRecords(listRestorableRecords());
      } catch (err) {
        console.warn('[BriefingPage] guardHabitsOnOpen failed:', err);
      }
    });
    // 队列自身永不 reject：否则一次异常会让后续所有结算被永远跳过
    guardQueueRef.current = task.catch(() => {});
    return guardQueueRef.current;
  }, []);

  /**
   * 拉取晨报。F-04 当日缓存：非强制时先读当日快照（秒开，不发网络）；
   * 手动刷新（下拉刷新/重新定位）传 force=true 跳过缓存重拉。
   */
  const loadBriefing = useCallback(
    async (force = false) => {
      if (!force) {
        const cached = readBriefingCache();
        if (cached) {
          setBriefing(cached);
          briefingRef.current = cached;
          // 缓存命中同样要做习惯守护惰性结算（幂等）
          runHabitGuard(cached.events || []);
          return;
        }
      }
      try {
        // 首屏尚无内容时才武装骨架定时器：>300ms 显示骨架，快速命中缓存则不显示
        if (!briefingRef.current) {
          if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
          skeletonTimerRef.current = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
        }
        const data = await apiGetBriefing();
        setBriefing(data);
        briefingRef.current = data;
        writeBriefingCache(data);
        // 取得最新日程后立即守护（幂等，重复调用无副作用）
        if (data) runHabitGuard(data.events || []);
      } catch (err) {
        console.error('[BriefingPage] loadBriefing failed:', err);
        Taro.showToast({ title: t('briefing.loadFailed'), icon: 'none' });
      } finally {
        if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
        skeletonTimerRef.current = null;
        setShowSkeleton(false);
      }
    },
    [t, runHabitGuard]
  );

  /* ---------------- C-02 位置权限：功能触发式授权（App 启动严禁弹窗） ---------------- */
  const [locating, setLocating] = useState(false);
  const [showLocDialog, setShowLocDialog] = useState(false);
  const [locDeniedBar, setLocDeniedBar] = useState(false);

  /** 真正发起定位：locateCity 内部有权限闸门，未授权返回 null，不抛错 */
  const runLocate = async () => {
    setLocating(true);
    const city = await locateCity();
    setLocating(false);
    if (city) {
      setLocDeniedBar(false);
      Taro.showToast({ title: t('briefing.located') + city, icon: 'none' });
      loadBriefing(true);
    } else {
      setLocDeniedBar(isDeniedDegraded('location'));
      Taro.showToast({ title: t('briefing.locateDenied'), icon: 'none' });
    }
  };

  /** 点击定位按钮（唯一触发点）：未询问/曾拒绝 → 弹应用内说明弹窗；已同意 → 直接定位 */
  const handleLocate = async () => {
    if (locating) return;
    if (shouldShowDialog('location')) {
      setShowLocDialog(true);
      return;
    }
    // 连续拒绝达上限：不再弹窗，降级为轻量提示条 +「去设置开启」
    if (isDeniedDegraded('location')) {
      setLocDeniedBar(true);
      return;
    }
    const ok = await ensurePermission('location');
    if (!ok) {
      setLocDeniedBar(isDeniedDegraded('location'));
      Taro.showToast({ title: t('briefing.locateDenied'), icon: 'none' });
      return;
    }
    await runLocate();
  };

  /** 弹窗「同意并开启」：拉起系统授权（H5 由浏览器原生弹窗接管） */
  const handleLocAgree = async () => {
    setShowLocDialog(false);
    const ok = await ensurePermission('location');
    if (!ok) {
      setLocDeniedBar(isDeniedDegraded('location'));
      Taro.showToast({ title: t('briefing.locateDenied'), icon: 'none' });
      return;
    }
    await runLocate();
  };

  /** 弹窗「暂不使用」/ 点遮罩：记一次拒绝并展示提示条；第 3 次起不再弹窗，仅保留提示条 */
  const handleLocCancel = () => {
    setShowLocDialog(false);
    recordPermissionResult('location', false);
    setLocDeniedBar(true);
  };

  /** 提示条「去设置开启」：weapp 跳系统设置；H5 无此能力，提示平台不支持 */
  const handleOpenLocSetting = async () => {
    const ok = await openAppSetting('location');
    if (!ok) {
      Taro.showToast({ title: t('perm.platformUnsupported'), icon: 'none' });
      return;
    }
    // 从设置返回后重新对账：已授权则收起提示条
    setLocDeniedBar(isDeniedDegraded('location'));
  };

  useEffect(() => {
    init();
    loadBriefing();
  }, []);

  /* ---------------- v2.1 阅读计时与结算 ---------------- */
  /** 停掉前台心跳定时器（幂等） */
  const stopReadTimer = () => {
    if (readTimerRef.current !== null) {
      clearInterval(readTimerRef.current);
      readTimerRef.current = null;
    }
  };

  /**
   * 进入前台：先做一次性迁移标记 + 惰性补算（昨日漏打卡 / 发冻结卡），再新建会话并启动心跳。
   * 用 useDidShow（Taro 双端一致：weapp 页面显示 / H5 visibilitychange）。
   */
  useDidShow(() => {
    stopSpeak();
    // 首次进入标记旧 learn streak 已归档（幂等，仅标记不迁移天数）
    migrateFromLearnStreak();
    const settled = settleReadStreakOnOpen();
    if (settled.frozenDates.length > 0) {
      Taro.showToast({ title: t('readStreak.freezeUsed'), icon: 'none', duration: 2500 });
    } else if (settled.grantedCards > 0) {
      Taro.showToast({ title: t('readStreak.freezeGranted', { n: settled.grantedCards }), icon: 'none', duration: 2500 });
    }
    setReadStreak(getReadStreak());
    setTodayRead(isTodayRead());
    readSessionRef.current = beginReadSession();
    setReadSessionEpoch((n) => n + 1);
    stopReadTimer();
    readTimerRef.current = setInterval(() => {
      if (readSessionRef.current) {
        readSessionRef.current = tickReadSession(readSessionRef.current);
      }
    }, READ_TICK_INTERVAL_MS);
    // 习惯自动守护：返回页面时用最近一份 briefing 惰性结算（幂等，关闭 autoGuard 时零副作用）
    runHabitGuard(briefingRef.current?.events || []);
  });

  // 离开页面/切后台：停播 + 暂停计时并结算（满足阈值则打卡、同日幂等）
  useDidHide(() => {
    stopSpeak();
    setIsSpeaking(false);
    stopReadTimer();
    if (readSessionRef.current) {
      const res = settleReadOnHide(readSessionRef.current);
      readSessionRef.current = null;
      if (res.checkedIn) {
        const streak = getReadStreak();
        setReadStreak(streak);
        setTodayRead(true);
        Taro.showToast({ title: t('readStreak.toast', { n: streak }), icon: 'none', duration: 2500 });
        // 读完晨报即「签到成功」——这是订阅授权转化率最高的时机（PM 竞品分析 Top2）。
        // 仅自动弹一次（canPromptSubscribe 已保证：用户给过任何终态就收口，避免骚扰）。
        if (isWeapp && canPromptSubscribe()) {
          promptSubscribe(SUBSCRIBE_TEMPLATE_ID).then((s) => {
            if (s === 'accept') Taro.showToast({ title: t('briefing.subscribeOk'), icon: 'success' });
          });
        }
      }
    }
  });

  // 卸载兜底：清理定时器（防 H5 路由快速切换导致定时器泄漏）
  useEffect(
    () => () => {
      stopReadTimer();
      if (habitToastTimerRef.current) clearTimeout(habitToastTimerRef.current);
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
    },
    []
  );

  /**
   * 区块曝光上报：**只在「真的渲染了」时上报**，而不是组件挂载即上报。
   * 用各区块现有的渲染条件判断（避免空区块也被计入曝光，破坏「≥2 个不同区块」语义）。
   */
  useEffect(() => {
    if (!readSessionRef.current || !briefing) return;
    const kinds: Array<{ kind: ReadSectionKind; shown: boolean }> = [
      { kind: 'schedule', shown: todaySchedule.length > 0 },
      { kind: 'todo', shown: briefing.todos.length > 0 },
      { kind: 'fav', shown: briefing.digest.length > 0 },
      { kind: 'intel', shown: (briefing.intel?.intelItems?.length ?? 0) > 0 }
    ];
    kinds.forEach(({ kind, shown }) => {
      if (shown && readSessionRef.current) {
        readSessionRef.current = markSectionSeen(readSessionRef.current, kind);
      }
    });
    // todaySchedule 由 briefing 派生；readSessionEpoch 保证每次进入页面都会重跑（会话重建）
  }, [briefing, readSessionEpoch]);

  usePullDownRefresh(async () => {
    await Promise.all([loadBriefing(true), refreshUsage()]);
    Taro.stopPullDownRefresh();
  });

  const pushMessage = (
    role: ChatMessage['role'],
    content: string,
    type: ChatMessage['type'] = 'text',
    deep = false,
    image?: string
  ): string => {
    msgIdRef.current += 1;
    const id = `msg-${msgIdRef.current}`;
    setMessages((prev) => [
      ...prev,
      { id, role, type, deep, content, image, createTime: dayjs().toISOString() }
    ]);
    return id;
  };

  /** 更新一条消息内容（F-03 流式打字机追加用） */
  const appendMessage = (id: string, chunk: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)));
  };
  /** 用最终结果覆盖流式内容（F-03：done 行校正） */
  const setMessageContent = (id: string, content: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
  };
  const removeMessage = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  /** 全屏预览 AI 附图（F25）；预览失败静默（图片仍在气泡内可见） */
  const previewImage = (src: string) => {
    Taro.previewImage({ urls: [src] }).catch((err) => console.warn('[BriefingPage] previewImage failed:', err));
  };

  const askAssistant = async (message: string, type: 'text' | 'voice') => {
    if (!message.trim() || sending) return;
    setSending(true);
    pushMessage('user', message, type);
    try {
      let res: { reply: string; action: string; image?: string } | null = null;
      if (!isWeapp) {
        // F-03 H5 流式：先挂空气泡，delta 打字机追加；失败移除空气泡降级整段
        const streamId = pushMessage('assistant', '', 'text', deepMode);
        res = await apiChatStream(message, deepMode, (chunk) => appendMessage(streamId, chunk));
        if (res) {
          setMessageContent(streamId, res.reply);
        } else {
          removeMessage(streamId);
        }
      }
      if (!res) {
        res = await apiChat(message, type, deepMode);
        pushMessage('assistant', res.reply, 'text', deepMode, res.image);
      }
      logActivity(deepMode ? '🧠' : '💬', deepMode ? `深度思考：${message.slice(0, 14)}` : `AI 对话：${message.slice(0, 14)}`);
    } catch (err) {
      console.error('[BriefingPage] chat failed:', err);
      pushMessage('assistant', t('ai.fallbackReply'));
    } finally {
      setSending(false);
    }
  };

  const handleGoSearch = () => {
    Taro.navigateTo({ url: '/pages/search/index' });
  };

  /** 待办勾选完成（v2.0 F27），复用对话通道记录 */
  const handleToggleTodo = async (todoId: string, title: string) => {
    const next = new Set(doneIds);
    const finishing = !next.has(todoId);
    if (finishing) next.add(todoId);
    else next.delete(todoId);
    setDoneIds(next);
    if (!isWeapp) {
      // H5 真实落库：直写本地 plan 存储。chat 的 action 在 H5 前端不落库，靠 AI 转述会变成「假完成」
      try {
        const plan = readPlan();
        const hit = plan.todos.find((td) => td.id === todoId);
        if (hit) {
          hit.status = finishing ? 'done' : 'confirmed';
          writePlan(plan);
        }
      } catch (err) {
        console.warn('[BriefingPage] toggle todo persist failed:', err);
      }
      return;
    }
    try {
      await apiChat(finishing ? `完成了「${title}」` : `取消完成「${title}」`);
    } catch (err) {
      console.error('[BriefingPage] toggle todo failed:', err);
    }
  };

  const handleSendText = () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    askAssistant(text, 'text');
  };

  const checkVoiceQuota = (): boolean => {
    if (!usage) return true;
    if (usage.voiceQuota >= 0 && usage.voiceUsed >= usage.voiceQuota) {
      Taro.showModal({
        title: t('briefing.voiceLimitTitle'),
        content: t('briefing.voiceLimitContent'),
        confirmText: t('briefing.goSubscribe'),
        success: (res) => {
          if (res.confirm) Taro.switchTab({ url: '/pages/mine/index' });
        }
      });
      return false;
    }
    return true;
  };

  const handleVoiceResult = (result: VoiceResult) => {
    if (!result.confirmed) return;
    if (!checkVoiceQuota()) return;
    // 用量真记账：语音确认发送即计 1 次，并刷新免费额度展示
    bumpVoiceUsage();
    void refreshUsage();
    if (result.transcript) {
      // 有转写文本：微信端同声传译插件识别成功（H5 端为 mock 转写），直接进对话链路
      askAssistant(result.transcript, 'voice');
      return;
    }
    if (isWeapp) {
      // 无转写的微信端结果 = 同声传译插件未配置的降级路径（纯录音）
      Taro.showToast({ title: t('briefing.voiceNoPlugin'), icon: 'none', duration: 2000 });
      return;
    }
    // 非微信端兜底：模拟转写结果
    const transcript = MOCK_TRANSCRIPTS[mockIndexRef.current % MOCK_TRANSCRIPTS.length];
    mockIndexRef.current += 1;
    askAssistant(transcript, 'voice');
  };

  /** 订阅临期提醒条点击：force=true 手动触发（与页面常驻订阅按钮同一通道）。
   *  模板 id 跟随本页既有 SUBSCRIBE_TEMPLATE_ID（TODO 占位时 promptSubscribe 内部 noop，不弹不计数）。 */
  const handleRenewSubscribe = async () => {
    const status = await promptSubscribe(SUBSCRIBE_TEMPLATE_ID, true);
    if (status === 'accept') {
      Taro.showToast({ title: t('briefing.subscribeOk'), icon: 'success' });
    } else if (status === 'ban') {
      Taro.showToast({ title: t('briefing.subscribeBanned'), icon: 'none' });
    }
    // reject / noop：不打扰用户
  };

  const handleSubscribe = async () => {
    if (!isWeapp) {
      Taro.showToast({ title: t('briefing.subscribeWeappOnly'), icon: 'none' });
      return;
    }
    // force=true：页面常驻按钮是用户主动触发，忽略「已弹过」限制
    const status = await promptSubscribe(SUBSCRIBE_TEMPLATE_ID, true);
    if (status === 'accept') {
      Taro.showToast({ title: t('briefing.subscribeOk'), icon: 'success' });
    } else if (status === 'ban') {
      Taro.showToast({ title: t('briefing.subscribeBanned'), icon: 'none' });
    }
    // reject / noop：不打扰用户
  };

  const todayEvents = (briefing?.events || []).filter((e) => dayjs(e.startTime).isSame(dayjs(), 'day'));
  /** 今日时间线：今日日程 + 今日到期待办，按时间排序（用户需求：待办并入今日日程） */
  const todaySchedule = [
    ...todayEvents.map((e) => ({
      kind: 'event' as const,
      id: e.id,
      title: e.title,
      time: e.startTime,
      location: e.location
    })),
    ...(briefing?.todos || [])
      .filter((t) => t.dueDate && dayjs(t.dueDate).isSame(dayjs(), 'day'))
      .map((t) => ({
        kind: 'todo' as const,
        id: t.id,
        title: t.title,
        time: t.dueDate!,
        location: undefined as string | undefined
      }))
  ].sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf());
  const hasContent =
    briefing && (todaySchedule.length > 0 || briefing.todos.length > 0 || briefing.digest.length > 0);

  /* ---------------- v2.1 习惯守护：入口与撤销 ---------------- */
  /** 把今日某条日程「设为习惯」（默认不开启自动守护，需用户到「我的」页显式开启） */
  const handleAddHabit = () => {
    if (todayEvents.length === 0) {
      Taro.showToast({ title: t('habit.addNoSchedule'), icon: 'none' });
      return;
    }
    Taro.showActionSheet({ itemList: todayEvents.map((e) => e.title) })
      .then((res) => {
        const ev = todayEvents[res.tapIndex];
        if (!ev) return;
        const dur = ev.endTime ? Math.max(30, dayjs(ev.endTime).diff(dayjs(ev.startTime), 'minute')) : undefined;
        createHabit({
          title: ev.title,
          preferredStart: dayjs(ev.startTime).format('HH:mm'),
          durationMinutes: dur,
          eventId: ev.id
        });
        Taro.showToast({ title: t('habit.addedToast', { title: ev.title }), icon: 'none' });
      })
      .catch(() => {});
  };

  /**
   * 撤销一次自动挪动。
   * 顺序：**先把日程真的改回原时段，远端成功后才在本地标记已撤销**。
   * 反过来的话，写库失败会让记录被标记 undone 而从「可还原」列表消失 ——
   * 用户既没能还原，也失去了重试入口。
   * @returns 'ok' 已还原 / 'expired' 记录不存在或已超窗口 / 'failed' 远端写入失败（可重试）
   */
  const undoGuard = async (recordId: string): Promise<'ok' | 'expired' | 'failed'> => {
    const target = listRestorableRecords().find((r) => r.id === recordId);
    if (!target) return 'expired';
    const result = await apiApplyPlan({
      events: [{ eventId: target.eventId, title: target.title, startTime: target.fromTime }]
    });
    if (!result.ok) {
      // 不改本地状态：记录仍留在「可还原」列表里，用户可重试
      console.warn('[BriefingPage] restoreHabitGuard failed, record kept for retry');
      return 'failed';
    }
    undoHabitGuard(recordId);
    return 'ok';
  };

  /** 撤销结果 → 提示文案（区分「超时」与「写入失败」，后者可重试） */
  const undoToastKey = (r: 'ok' | 'expired' | 'failed'): LangKey =>
    r === 'ok' ? 'habit.undoDone' : r === 'expired' ? 'habit.undoExpired' : 'habit.undoFailed';

  /** toast 内 5 秒撤销 */
  const handleUndoHabit = async () => {
    if (!habitToast) return;
    const r = await undoGuard(habitToast.id);
    Taro.showToast({ title: t(undoToastKey(r)), icon: 'none' });
    if (habitToastTimerRef.current) clearTimeout(habitToastTimerRef.current);
    setHabitToast(null);
    setGuardRecords(listRestorableRecords());
  };

  /** 提示条内一键还原（24h 撤销窗口内） */
  const handleRestoreGuard = async (recordId: string) => {
    const r = await undoGuard(recordId);
    Taro.showToast({ title: t(undoToastKey(r)), icon: 'none' });
    setGuardRecords(listRestorableRecords());
  };

  const handleRestoreAllGuards = async () => {
    const list = listRestorableRecords();
    let okCount = 0;
    // 串行还原：避免同时打多个写请求，也让失败的那条能被独立识别
    for (const r of list) {
      if ((await undoGuard(r.id)) === 'ok') okCount += 1;
    }
    const key: LangKey = okCount > 0 ? 'habit.undoDone' : 'habit.undoFailed';
    Taro.showToast({ title: t(key), icon: 'none' });
    setGuardRecords(listRestorableRecords());
  };

  /** 批准习惯方案：透传 apiApplyPlan 落库（复用 S-01 既有确认链路） */
  const handleApproveHabitProposal = async (events: PlanApplyEvent[]) => {
    if (events.length === 0) return;
    const result = await apiApplyPlan({ events, count: events.length });
    if (result.ok) {
      Taro.showToast({ title: t('plan.savedToast', { n: result.saved }), icon: 'success' });
      setHabitProposal(null);
      loadBriefing(true); // 落库成功后强制重拉，同步更新当日缓存
    } else {
      Taro.showToast({ title: '暂时无法写入，请稍后再试', icon: 'none' });
    }
  };

  /* ---------------- 增量 2 情报分组：分组优先，无则本地兜底，均无则平铺 ---------------- */
  // 分组解析放在渲染前一次算好（纯函数，无副作用）；`briefing.intel` 为宽化读取
  const intelResolved = resolveIntelGroups(briefing?.intel);

  /** 点击导语内联引用 [n]：弹出对应条目来源（合规：来源必须可见；越界引用已被组件过滤） */
  const handleCiteClick = useCallback(
    (groupIndex: number, itemIndex: number) => {
      const group = intelResolved.groups[groupIndex];
      const ref = group?.items?.[itemIndex];
      if (!ref) return;
      Taro.showModal({
        title: group.title,
        content: `${ref.text}\n\n来源：${ref.source}`,
        showCancel: false
      });
    },
    [intelResolved]
  );

  /* ---------------- F21 晨报自适应 ---------------- */
  // 信号：优先用云端/mock 下发的 adaptive，缺失时前端同口径现算
  const adaptive = briefing ? briefing.adaptive ?? computeAdaptive(briefing.events, briefing.todos) : null;
  const busyMinutes = todayEvents.reduce((sum, e) => {
    const mins = e.endTime ? dayjs(e.endTime).diff(dayjs(e.startTime), 'minute') : 60;
    return sum + (mins > 0 ? mins : 60);
  }, 0);
  const adaptiveBanner = (() => {
    if (!adaptive) return null;
    if (adaptive.busyDay) {
      return t('briefing.adaptiveBusy', { count: todayEvents.length, hours: Math.max(1, Math.round(busyMinutes / 60)) });
    }
    if (adaptive.tripCity) return t('briefing.adaptiveTrip', { city: adaptive.tripCity });
    if (adaptive.focusTodo) return t('briefing.adaptiveFocus', { title: adaptive.focusTodo });
    return null;
  })();

  /* ---------------- 负载条：adaptive.busyMinutes 可视化 ---------------- */
  // 三档阈值与 busyDay 同口径：≥300 分钟或 ≥4 项红（爆满）、≥150 橙（偏满）、否则绿（宽松）。
  // 按分钟/600 计算填充比例（10 小时封顶）。busyMinutes 缺失（旧缓存数据）时返回 null，整块不渲染。
  const loadInfo = (() => {
    const mins = adaptive?.busyMinutes;
    if (typeof mins !== 'number' || !isFinite(mins)) return null;
    const count = typeof adaptive?.todayCount === 'number' ? adaptive.todayCount : todayEvents.length;
    const pct = Math.min(100, Math.round((mins / 600) * 100));
    const tier: 'low' | 'mid' | 'high' = mins >= 300 || count >= 4 ? 'high' : mins >= 150 ? 'mid' : 'low';
    return { mins, count, pct, tier };
  })();
  const loadFillClass = loadInfo
    ? loadInfo.tier === 'high'
      ? styles.loadFillHigh
      : loadInfo.tier === 'mid'
        ? styles.loadFillMid
        : styles.loadFillLow
    : '';

  /* ---------------- P1-G 本周复盘卡片 ---------------- */
  // weeklyReview 缺失（旧当日缓存/云函数降级）或计数全 0 且无关键词时整卡不渲染，无需迁移缓存结构
  const weeklyReview = (() => {
    const wr = briefing?.weeklyReview;
    if (!wr) return null;
    if (wr.todosDone <= 0 && wr.eventCount <= 0 && (wr.keywords || []).length === 0) return null;
    return wr;
  })();

  /* ---------------- F20 音频晨报 ---------------- */
  /** 整份晨报转播报稿：开场点名（自适应）→ 天气 → 日程 → 待办 → 精选，≤3 分钟 */
  const handleAudioToggle = () => {
    if (isSpeaking) {
      stopSpeak();
      setIsSpeaking(false);
      return;
    }
    if (!briefing) return;
    const lines: string[] = [briefing.greeting];
    if (adaptive?.focusTodo) lines.push(`先办「${adaptive.focusTodo}」`);
    if (briefing.intel?.weather) lines.push(briefing.intel.weather.text);
    if (todayEvents.length) {
      lines.push('今日日程');
      todayEvents.forEach((e) =>
        lines.push(`${formatEventTime(e.startTime)}，${e.title}${e.location ? `，地点${e.location}` : ''}`)
      );
    }
    const pendingTodos = briefing.todos.filter((td) => !doneIds.has(td.id));
    if (pendingTodos.length) {
      lines.push('待办事项');
      pendingTodos.forEach((td) => lines.push(`${td.dueDate ? `${formatEventTime(td.dueDate)}，` : ''}${td.title}`));
    }
    if (briefing.digest.length) {
      lines.push('昨日收藏精选');
      briefing.digest.forEach((d) => lines.push(d));
    }
    // V-07：晨报场景走场景音色表（22:00–07:00 自动切 night 柔和音色）；用户固定音色由 tts.ts 内的持久化偏好决定
    // X10 语音问候：问候句（含当日日期）单独作为首个 chunk 传入，与后续内容块之间由 gapMs 机制自然停顿
    const dateText = lang === 'en' ? dayjs().format('MMM D') : dayjs().format('M月D日');
    const greetingChunk = `${t('briefing.ttsGreeting')}，${dateText}`;
    startSpeak(
      [greetingChunk, ...splitTtsChunks(lines.join('。'))],
      {
        onEnd: () => setIsSpeaking(false),
        onError: (msg) => {
          setIsSpeaking(false);
          Taro.showToast({ title: msg, icon: 'none' });
        }
      },
      { scene: sceneByHour(dayjs().hour(), 'briefing') }
    );
    setIsSpeaking(true);
  };

  const lastMsgId = messages.length > 0 ? messages[messages.length - 1].id : '';

  /** 阈值展示用秒数（由毫秒常量换算，避免页面出现魔法数字） */
  const readMinSeconds = Math.round(READ_MIN_MS / 1000);

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.headerTop}>
          <View className={styles.headerMain}>
            <Text className={styles.greeting}>
              {profile ? `${profile.nickname}，${getGreeting(dayjs().hour())}` : getGreeting(dayjs().hour())}
            </Text>
            <View className={styles.dateRow}>
              <Text className={styles.date}>
                {lang === 'en' ? dayjs().format('MMM D') : dayjs().format('M月D日')}{' '}
                {(lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH)[dayjs().day()]}
              </Text>
              {profile?.subscribed ? <Text className={styles.badge}>{t('mine.badgeSubscribed')}</Text> : null}
              {/* v2.1：晨报连续阅读打卡（主 streak 已改挂晨报；今日未读时以呼吸态提示） */}
              <View className={classnames(styles.readStreak, todayRead && styles.readStreakDone)}>
                <Text className={styles.readStreakFlame}>🔥</Text>
                <Text className={styles.readStreakText}>
                  {todayRead ? t('readStreak.today') : t('readStreak.days', { n: readStreak })}
                </Text>
              </View>
              {/* X8 连读徽章：连续打开晨报页 ≥2 天时展示（与有效阅读打卡相互独立） */}
              {briefStreak >= 2 ? (
                <Text className={styles.streakBadge}>🔥 {t('briefing.streak', { n: briefStreak })}</Text>
              ) : null}
            </View>
          </View>
          <View className={styles.headerActions}>
            {hasContent ? (
              <Button
                className={classnames(styles.audioButton, isSpeaking && styles.audioButtonActive)}
                onClick={handleAudioToggle}
                aria-label={isSpeaking ? t('briefing.audioStop') : t('briefing.audioPlay')}
              >
                {isSpeaking ? '⏹' : '🔊'}
              </Button>
            ) : null}
            <Button className={styles.searchButton} onClick={handleGoSearch}>
              🔍
            </Button>
          </View>
        </View>
      </View>

      {hasContent && adaptiveBanner ? (
        <View className={styles.adaptiveBanner}>
          <Text className={styles.adaptiveIcon}>⚡</Text>
          <Text className={styles.adaptiveText}>{adaptiveBanner}</Text>
        </View>
      ) : null}

      {/* X6 周末轻量版横幅：仅生成侧标记了 weekendEdition 且用户未关闭周末版偏好时显示；
          旧当日缓存无该字段（=== true 不成立）不显示横幅 */}
      {hasContent && briefing?.weekendEdition === true && prefsWeekendEdition ? (
        <View className={styles.weekendBanner}>
          <Text className={styles.weekendIcon}>🧺</Text>
          <Text className={styles.weekendText}>{t('briefing.weekendBanner')}</Text>
        </View>
      ) : null}

      {/* X4 订阅临期续订提醒条：晨报加载完成后（有内容）且授权临期时显示，仅 weapp；可关闭（本次会话不再显示）。
          样式复用周末横幅类，语义为「横幅区提示条」。 */}
      {hasContent && isWeapp && !renewBarHidden && isSubscriptionStale() ? (
        <View className={styles.weekendBanner} onClick={handleRenewSubscribe}>
          <Text className={styles.weekendIcon}>🔔</Text>
          <Text className={styles.weekendText}>{t('subscribe.renew')}</Text>
          <Text
            className={styles.weekendIcon}
            onClick={(e) => {
              e.stopPropagation();
              setRenewBarHidden(true);
            }}
          >
            ✕
          </Text>
        </View>
      ) : null}

      {/* v2.1：今日尚未达成「有效阅读」时，给出达成门槛提示（避免用户不知为何没打卡） */}
      {hasContent && !todayRead ? (
        <View className={styles.readHintBar}>
          <Text className={styles.readHintIcon}>🔥</Text>
          <Text className={styles.readHintText}>
            {t('readStreak.progressHint', { s: readMinSeconds, k: READ_MIN_SECTIONS })}
          </Text>
        </View>
      ) : null}

      {/* v2.1 习惯守护提示条：有自动挪动记录时展示，可查看 + 一键还原 */}
      <HabitGuardBar
        records={guardRecords}
        onRestore={handleRestoreGuard}
        onRestoreAll={handleRestoreAllGuards}
        onView={() => Taro.navigateTo({ url: '/pages/mine/index' })}
      />

      {/* U-01 三态：加载中(>300ms)骨架 → 有内容淡入 → 真空态 */}
      {!briefing && showSkeleton ? (
        <BriefingSkeleton />
      ) : !hasContent ? (
        <View className={styles.section}>
          <EmptyState icon='☕' title={t('briefing.emptyTitle')} hint={t('briefing.emptyHint')} />
        </View>
      ) : (
        <View className={styles.contentFade}>
          {todaySchedule.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>📅</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionToday')}</Text>
                <Text className={styles.sectionCount}>
                  {todaySchedule.length} {t('common.itemCount')}
                </Text>
                {/* v2.1 习惯守护：把今日日程一键设为习惯（默认不自动守护） */}
                {todayEvents.length > 0 ? (
                  <Text className={styles.habitAdd} onClick={handleAddHabit}>
                    {t('habit.addFromSchedule')}
                  </Text>
                ) : null}
              </View>
              {loadInfo ? (
                <View className={styles.loadBar}>
                  <Text className={styles.loadLabel}>
                    {t('briefing.loadLabel', { hours: (loadInfo.mins / 60).toFixed(1), count: loadInfo.count })}
                  </Text>
                  <View className={styles.loadTrack}>
                    <View className={classnames(styles.loadFill, loadFillClass)} style={{ width: `${loadInfo.pct}%` }} />
                  </View>
                </View>
              ) : null}
              {/* P1-G 本周复盘卡片：紧随负载条（同区块内），样式沿用 .loadBar 系列写法 */}
              {weeklyReview ? (
                <View className={styles.weekCard}>
                  <Text className={styles.weekTitle}>{t('briefing.weekTitle')}</Text>
                  <Text className={styles.weekStat}>{t('briefing.weekTodosDone', { n: weeklyReview.todosDone })}</Text>
                  <Text className={styles.weekStat}>{t('briefing.weekEvents', { n: weeklyReview.eventCount })}</Text>
                  {(weeklyReview.keywords || []).length > 0 ? (
                    <View className={styles.weekKeywordRow}>
                      <Text className={styles.weekKeywordLabel}>{t('briefing.weekKeywords')}</Text>
                      <View className={styles.weekChips}>
                        {(weeklyReview.keywords || []).map((kw) => (
                          <Text key={kw} className={styles.weekChip}>
                            {kw}
                          </Text>
                        ))}
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}
              {todaySchedule.map((item) => {
                const done = item.kind === 'todo' && doneIds.has(item.id);
                return (
                  <View
                    key={item.id}
                    className={styles.eventItem}
                    onClick={item.kind === 'todo' ? () => handleToggleTodo(item.id, item.title) : undefined}
                  >
                    <View className={styles.timeBlock}>
                      <Text className={styles.time}>{dayjs(item.time).format('HH:mm')}</Text>
                    </View>
                    <View className={styles.eventBody}>
                      {item.kind === 'todo' ? (
                        <View className={styles.todoInline}>
                          <View className={classnames(styles.checkbox, done && styles.checkboxDone)}>
                            {done ? <Text className={styles.checkboxMark}>✓</Text> : null}
                          </View>
                          <Text className={classnames(styles.eventTitle, done && styles.todoDone)}>{item.title}</Text>
                        </View>
                      ) : (
                        <>
                          <Text className={styles.eventTitle}>{item.title}</Text>
                          {item.location ? <Text className={styles.eventLocation}>📍 {item.location}</Text> : null}
                        </>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {briefing && briefing.todos.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>✅</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionTodo')}</Text>
                <Text className={styles.sectionCount}>
                  {briefing.todos.length} {t('common.itemCount')}
                </Text>
              </View>
              {briefing.todos.map((todo) => {
                const done = doneIds.has(todo.id);
                return (
                  <View
                    key={todo.id}
                    className={styles.todoItem}
                    onClick={() => handleToggleTodo(todo.id, todo.title)}
                  >
                    <View className={classnames(styles.checkbox, done && styles.checkboxDone)}>
                      {done ? <Text className={styles.checkboxMark}>✓</Text> : null}
                    </View>
                    <Text className={classnames(styles.todoTitle, done && styles.todoDone)}>{todo.title}</Text>
                    {todo.dueDate ? <Text className={styles.todoDue}>{formatEventTime(todo.dueDate)}</Text> : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          {briefing && briefing.digest.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>📚</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionFav')}</Text>
              </View>
              {briefing.digest.map((text, i) => (
                <View key={i} className={styles.digestItem}>
                  <Text className={styles.digestText}>{text}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {briefing?.intel?.intelItems && briefing.intel.intelItems.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>🌐</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionIntel')}</Text>
              </View>
              {/* X2 栏目署名：早报员人设挂在情报（AI 精选）区块标题下方 */}
              <Text className={styles.curatorTag}>{t('library.curator')}</Text>
              {briefing.intel.weather ? (
                <View className={styles.digestItem}>
                  <View className={styles.weatherRow}>
                    <Text className={styles.digestText}>🌤 {briefing.intel.weather.text}</Text>
                    {/* C-02：定位入口双端开放（weapp 是主端，需可触达才可验证授权链路） */}
                    <Text className={styles.locateBtn} onClick={handleLocate}>
                      {locating ? t('briefing.locating') : t('briefing.locateBtn')}
                    </Text>
                  </View>
                  {/* C-02 降级提示条：位置未开启 / 多次拒绝后常驻，附「去设置开启」 */}
                  {locDeniedBar ? (
                    <View className={styles.locDeniedBar}>
                      <Text className={styles.locDeniedText}>
                        {isDeniedDegraded('location') ? t('perm.repeatDeniedLoc') : t('perm.locDeniedBar')}
                      </Text>
                      <Text className={styles.locDeniedAction} onClick={handleOpenLocSetting}>
                        {t('perm.goSettings')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              {/* 有云端/Local 分组时渲染分组卡片（主题 + 导语含内联引用 + 组内条目）；否则保持平铺 */}
              {intelResolved.groups.length > 0
                ? intelResolved.groups.map((group, gi) => (
                    <IntelGroupCard
                      key={`${group.title}-${gi}`}
                      group={group}
                      citeHint={t('briefing.intelCiteHint')}
                      onCiteClick={(itemIndex) => handleCiteClick(gi, itemIndex)}
                    />
                  ))
                : briefing.intel.intelItems.map((item, i) => (
                    <View key={i} className={styles.digestItem}>
                      <Text className={styles.digestText}>{item.text}</Text>
                      <Text className={styles.digestSource}>来源：{item.source}</Text>
                    </View>
                  ))}
              {/* 导语为 AI 生成内容：分组态额外挂显式 AI 标识（合规） */}
              {intelResolved.groups.length > 0 && !intelResolved.degraded ? (
                <Text className={styles.intelLeadTag}>{t('briefing.intelGroupLead')}</Text>
              ) : null}
              <Text className={styles.intelNote}>
                {intelResolved.degraded ? t('briefing.intelRawNote') : t('briefing.aiTag')}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {/* v2.1 高风险习惯调整方案：走既有 PlanProposalCard 确认链路，绝不自动改动 */}
      {habitProposal ? (
        <View className={styles.habitProposalWrap}>
          <Text className={styles.habitProposalHint}>
            {t('habit.proposalHint', { title: habitProposal.items[0]?.title || '' })}
          </Text>
          <PlanProposalCard
            proposal={habitProposal}
            existing={briefing?.events || []}
            onApprove={handleApproveHabitProposal}
            onAbandon={() => setHabitProposal(null)}
          />
        </View>
      ) : null}

      <View className={styles.subscribeTip}>
        <Text className={styles.tipIcon}>☀️</Text>
        <Text className={styles.tipText}>{t('briefing.subscribeHint', { time: profile?.briefingTime || '07:30' })}</Text>
        <Button className={styles.tipAction} onClick={handleSubscribe}>
          {t('briefing.subscribe')}
        </Button>
      </View>

      <View className={styles.usageHint}>
        {usage && usage.voiceQuota > 0
          ? t('briefing.voiceQuota', { used: usage.voiceUsed, total: usage.voiceQuota })
          : t('briefing.subscribedVoice')}
      </View>

      {messages.length > 0 ? (
        <React.Fragment>
          <ScrollView scrollY scrollIntoView={lastMsgId} className={styles.messages}>
            {messages.map((msg) => (
              <View key={msg.id} id={msg.id} className={classnames(styles.messageRow, msg.role === 'user' && styles.user)}>
                <View className={classnames(styles.bubble, msg.role === 'user' ? styles.user : styles.assistant)}>
                  {msg.type === 'voice' ? <Text className={styles.voiceTag}>🎙 </Text> : null}
                  {msg.deep ? <Text className={styles.deepTag}>🧠 深思 </Text> : null}
                  <Text>{msg.content}</Text>
                  {/* AI 发图（F25）：点击全屏预览 */}
                  {msg.image ? (
                    <Image
                      src={msg.image}
                      mode='aspectFill'
                      lazyLoad
                      className={styles.msgImage}
                      onClick={() => previewImage(msg.image as string)}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </ScrollView>
          <Text className={styles.aiGeneratedTag}>{t('briefing.aiTag')}</Text>
        </React.Fragment>
      ) : (
        <View className={styles.chatEmpty}>
          <Text className={styles.chatHint}>{t('briefing.chatHint')}</Text>
        </View>
      )}

      {/* X7 收尾冷知识：trivia 缺失（旧缓存/降级）不渲染 */}
      {briefing?.trivia ? (
        <View className={styles.triviaCard}>
          <Text className={styles.triviaTitle}>💡 {t('briefing.triviaTitle')}</Text>
          <Text className={styles.triviaText}>{briefing.trivia}</Text>
        </View>
      ) : null}

      {/* L3 免责页脚：晨报含天气/财经资讯，合规要求常驻 */}
      <View className={styles.disclaimerFooter}>
        <Text className={styles.disclaimerText}>{t('common.disclaimer')}</Text>
      </View>

      <View className={classnames(styles.inputBar, isH5 && styles.h5Fix, isH5 && 'h5Fixed')}>
        {inputText === '' ? (
          <View className={styles.quickRow}>
            {QUICK_COMMANDS.map((cmd) => (
              <View key={cmd.labelKey} className={styles.quickChip} onClick={() => setInputText(cmd.text)}>
                <Text className={styles.quickChipIcon}>{cmd.icon}</Text>
                <Text className={styles.quickChipLabel}>{t(cmd.labelKey)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View className={styles.inputRow}>
          <Button
            className={classnames(styles.modeButton, deepMode && styles.modeActive)}
            onClick={() => setDeepMode((v) => !v)}
            aria-label={t('briefing.deepToggle')}
          >
            🧠
          </Button>
          <Input
            className={styles.textInput}
            value={inputText}
            placeholder={deepMode ? t('briefing.deepPlaceholder') : t('briefing.inputPlaceholder')}
            onInput={(e) => setInputText(e.detail.value)}
            confirmType='send'
            onConfirm={handleSendText}
          />
          {inputText ? (
            <View className={styles.clearButton} onClick={() => setInputText('')}>
              ✕
            </View>
          ) : null}
          <VoiceButton compact disabled={sending} onResult={handleVoiceResult} />
          <Button className={styles.sendButton} onClick={handleSendText} disabled={sending}>
            {t('ai.send')}
          </Button>
        </View>
      </View>

      {/* v2.1 习惯自动挪动 toast：5 秒内可撤销（同 memory 撤销模式） */}
      {habitToast ? (
        <View className={styles.habitToast}>
          <Text className={styles.habitToastText}>
            🛡 {t('habit.guardedToast', { title: habitToast.title, time: dayjs(habitToast.toTime).format('HH:mm') })}
          </Text>
          <Text className={styles.habitToastUndo} onClick={handleUndoHabit}>
            {t('habit.undo')}
          </Text>
        </View>
      ) : null}

      {/* C-02 位置权限说明弹窗：仅用户点击定位时触发，App 启动不弹 */}
      <PermissionDialog visible={showLocDialog} name='location' onAgree={handleLocAgree} onCancel={handleLocCancel} />

      {/* H5 首启合规同意层：未同意前阻断使用（仅网页端渲染） */}
      {showConsent ? (
        <View className={styles.consentMask}>
          <View className={styles.consentPanel}>
            <Text className={styles.consentTitle}>服务协议与隐私政策</Text>
            {consentDeclined ? (
              <View className={styles.consentDeclinedBox}>
                <Text className={styles.consentDeclinedText}>
                  你未同意上述协议，暂时无法使用本服务。
                  {'\n'}如改变主意，可点击下方「同意并继续」。
                </Text>
              </View>
            ) : (
              <ScrollView scrollY className={styles.consentBody}>
                <Text className={styles.consentText}>{PRIVACY_TEXT}</Text>
                <Text className={styles.consentText}>{'\n\n'}</Text>
                <Text className={styles.consentText}>{TERMS_TEXT}</Text>
                <Text className={styles.consentText}>{'\n\n'}</Text>
                <Text className={styles.consentText}>{AI_SERVICES_TEXT}</Text>
              </ScrollView>
            )}
            <Text className={styles.consentHint}>继续使用前，请阅读并同意以上协议</Text>
            <View className={styles.consentActions}>
              <Button className={styles.consentDecline} onClick={handleConsentDecline}>
                不同意
              </Button>
              <Button className={styles.consentAgree} onClick={handleConsentAgree}>
                同意并继续
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default BriefingPage;
