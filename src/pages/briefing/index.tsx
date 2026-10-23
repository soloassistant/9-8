import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Input, Button, Image } from '@tarojs/components';
import Taro, { usePullDownRefresh, useDidShow, useDidHide, useShareAppMessage } from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import VoiceButton, { VoiceResult } from '@/components/VoiceButton';
import EmptyState from '@/components/EmptyState';
import PermissionDialog from '@/components/PermissionDialog';
import IntelGroupCard, { IntelItemRow } from '@/components/IntelGroupCard';
import HabitGuardBar from '@/components/HabitGuardBar';
import PlanProposalCard from '@/components/PlanProposalCard';
import { BriefingSkeleton } from '@/components/Skeleton';
import { resolveIntelGroups } from '@/utils/intelGroups';
import type { IntelSourceRef } from '@/utils/intelGroups';
import { formatPlayCount } from '@/utils/videoNews';
import type { VideoNewsItem } from '@/utils/videoNews';
import { apiGetBriefing, apiChat, apiChatStream, apiApplyPlan, apiLedgerBudget, apiLedgerCategories, apiLedgerEntries, apiGetVideoNews, apiTodoSetStatus } from '@/services/api';
import { buildTodayBrief, resolveCategory, type TodayBrief } from '@/utils/ledgerAggregate';
import { buildPlanProposal } from '@/utils/schedule';
import type { PlanProposal, PlanApplyEvent } from '@/utils/schedule';
import { guardHabitsOnOpen, commitHabitGuards, listRestorableRecords, undoHabitGuard, createHabit } from '@/utils/habit';
import type { HabitGuardRecord } from '@/utils/habit';
import { locateCity } from '@/services/location';
import { openExternalPage } from '@/utils/externalLink';
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
import { computeAdaptive } from '@/utils/adaptive';
import { sceneByHour, splitTtsChunks, startSpeak, stopSpeak } from '@/utils/tts';
import { loadChatLog, saveChatLog } from '@/utils/chatLog';
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
import type { Briefing, ChatMessage, LedgerBudget, LedgerCategory, LedgerEntry, ScheduleEvent, TodoItem } from '@/types';
import { useT, useLanguageStore } from '@/store/language';
import type { LangKey } from '@/store/language';
import { readPrefs } from '@/utils/prefs';
import shareCover from '@/assets/share-cover.png';
// 订阅模板 id 集中配置（上线三件事）：空串 = 未配置，promptSubscribe 内部 noop
import { SUBSCRIBE_TEMPLATE_ID } from '@/config/subscribe';
import styles from './index.module.scss';

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
  /* 记账（v2.0 F23 · 晨报呈报）：**刻意不放进 Briefing 类型**。
     记账数据是本地 storage 里的高频可写数据，若塞进 briefing 会连带触发
     briefingDailyCache 的当日缓存 —— 而缓存会把当天首次取到的 briefing 冻住
     （briefing/index.tsx:80-88），于是「下午记了一笔、晚上重开晨报仍看不到」，
     且用户无从得知。独立 state + 每次 useDidShow 重读，语义才对。 */
  const [ledgerBrief, setLedgerBrief] = useState<TodayBrief | null>(null);
  /** 视频新闻（B站热榜第 1 条）：与 briefing 解耦的独立 state。
   *  为什么不并进 getBriefing 的 payload：视频源（B站榜单 API）与 RSS/LLM 情报是
   *  两套抓取链路，并进 payload 会让任一侧失败互相牵连；且它免登录、可被 H5 静态站
   *  直接调用。失败即空数组 —— 调用方不渲染卡片，不弹错误、不给假数据。 */
  const [videoNews, setVideoNews] = useState<VideoNewsItem[]>([]);
  /** 最近一次算出的账单摘要。仅供 useDidShow 里的日志读 —— React state 在闭包里是stale 的，
   *  直接打ledgerBrief 永远打出 null，排查时会误判成「没算出来」。 */
  const ledgerBriefRef = useRef<TodayBrief | null>(null);
  const [ledgerCats, setLedgerCats] = useState<LedgerCategory[]>([]);
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

  // 对话变化落 storage（截断由 saveChatLog 兜底）
  useEffect(() => {
    saveChatLog(BRIEFING_CHAT_LOG_KEY, messages);
  }, [messages]);

  // 转发分享（F30）：带品牌分享封面
  // 标题 AI 显式标识须门控（合规硬门槛）：仅订阅档 AI 启用且未降级才挂「AI 整理｜」前缀，
  // 与免责页脚（common.disclaimerAI）同一口径；免费档/降级档转发不得声称 AI 整理 ——
  // 免费档情报来自公开 RSS 的本地分组、全程无 LLM，署 AI 名即对功能能力的虚假陈述。
  useShareAppMessage(() => ({
    title: t(intelResolved.aiEnabled && !intelResolved.degraded ? 'share.titleAI' : 'share.title', { title: t('share.title') }),
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
    // 视频新闻：与 briefing 解耦加载，失败静默（不渲染卡片）。云端 1 小时缓存，
    // 每次进页面重取只是为了拿到当日更新，代价是一次轻量 RPC。
    // apiGetVideoNews 内部已过 normalizeVideoItems 收敛，这里直接落 state。
    apiGetVideoNews()
      .then(setVideoNews)
      .catch((err) => console.warn('[BriefingPage] videoNews load failed:', err));
    // 仅挂载执行一次：init 为 store 动作，loadBriefing 为 useCallback；语言切换无需重跑拉取，故二者都不列入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 记账呈报：每次进入前台都重读（而不是只读一次）——
    // 用户可能在别的页面（购物页/我的页）之外直接加了一笔，也可能跨了零点。
    void (async () => {
      try {
        const [entries, cats, budget] = await Promise.all([
          apiLedgerEntries(),
          apiLedgerCategories(),
          apiLedgerBudget()
        ]);
        setLedgerCats(cats);
        const brief = buildTodayBrief(entries as LedgerEntry[], budget as LedgerBudget);
        ledgerBriefRef.current = brief;
        setLedgerBrief(brief);
        // 用 console.error 而非 warn：生产构建会剔除 console.warn（app.tsx:174 有注释），
        // 用 warn 的话线上排查时这条痕迹根本不存在。
        console.error(
          '[BriefingPage] ledger brief loaded:',
          JSON.stringify({ entries: (entries as LedgerEntry[]).length, cats: cats.length, brief: ledgerBriefRef.current })
        );
      } catch (err) {
        // 记账读失败**不阻塞晨报**：整张卡片不显示即可，绝不能因此白屏
        console.warn('[BriefingPage] ledger brief load failed:', err);
      }
    })();
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
    // todaySchedule 由 briefing 派生，briefing 变化已覆盖其重算；且它声明在本组件后段（约 650 行），
    // 渲染期在 deps 里引用会直接触发 TDZ 报错（TS2448/TS2454），故不列入；readSessionEpoch 保证每次进页面重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        res = await apiChatStream(message, deepMode, (chunk) => appendMessage(streamId, chunk), undefined, {
          onThinking: () => setMessageContent(streamId, t('ai.thinking')),
          onClear: () => setMessageContent(streamId, ''),
        });
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

  /** 待办勾选完成：走确定性写库接口，不经过 LLM 对话通道。 */
  const handleToggleTodo = async (todoId: string, title: string) => {
    const next = new Set(doneIds);
    const finishing = !next.has(todoId);
    if (finishing) next.add(todoId);
    else next.delete(todoId);
    // 状态变更不再经过 LLM 通道：LLM 只负责理解自然语言指令，不承担状态写入。
    // 先落库、成功才更新 UI —— 否则写失败时勾选态留在界面上，刷新后回退就是「假完成」。
    const res = await apiTodoSetStatus({
      id: todoId,
      status: finishing ? 'done' : 'confirmed'
    });
    if (!res.ok) {
      Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
      return;
    }
    setDoneIds(next);
    if (finishing) logActivity('✅', `完成待办：${title.slice(0, 14)}`);
  };

  const handleSendText = () => {
    const text = inputText.trim();
    // 先守卫再清空：发送中再次回车/点发送时，旧写法会清掉输入却发不出去
    if (!text || sending) return;
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

  /** PRO 角标点击：直接跳 mine 订阅页（switchTab 因为 mine 是 TabBar） */
  const handleGoSubscribe = () => {
    Taro.switchTab({ url: '/pages/mine/index' }).catch(() => {
      // 理论上 switchTab 对 TabBar 页面不会失败；兜底 navigateTo 防止编译目标缺 TabBar
      Taro.navigateTo({ url: '/pages/mine/index' });
    });
  };

  const handleVoiceResult = (result: VoiceResult) => {
    // 诚实性 & 额度：H5 没有语音转写能力，绝不能拿预置文案冒充用户说的话，更不能扣额度。
    // 必须放在 checkVoiceQuota / bumpVoiceUsage 之前 —— 提前 return 才不会记账。
    if (!isWeapp) {
      Taro.showToast({ title: t('briefing.voiceWeappOnly'), icon: 'none' });
      return;
    }
    if (!result.confirmed) return;
    if (!checkVoiceQuota()) return;
    // 用量真记账：语音确认发送即计 1 次，并刷新免费额度展示
    bumpVoiceUsage();
    void refreshUsage();
    if (result.transcript) {
      // 有转写文本：微信端同声传译插件识别成功，直接进对话链路
      askAssistant(result.transcript, 'voice');
      return;
    }
    // 无转写的微信端结果 = 同声传译插件未配置的降级路径（纯录音）
    Taro.showToast({ title: t('briefing.voiceNoPlugin'), icon: 'none', duration: 2000 });
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
      // 类型谓词：把「filter 恰好滤掉了空 dueDate」这件事从**运行期巧合**升级成
      // 类型系统保证，否则下面只能靠 `todo.dueDate!` 非空断言 —— 一旦 filter 条件被改动，
      // 断言不会报错，运行期会静默把 undefined 当成时间塞进时间线。
      // 注：这里的 `todo` 原名 `t`，会遮蔽上面的 i18n `t`（useT()），已改名以免误调用。
      .filter((todo): todo is TodoItem & { dueDate: string } => Boolean(todo.dueDate) && dayjs(todo.dueDate).isSame(dayjs(), 'day'))
      .map((todo) => ({
        kind: 'todo' as const,
        id: todo.id,
        title: todo.title,
        time: todo.dueDate,
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
      .catch(() => {
        /* 静默：showActionSheet 被用户取消时 reject，是正常操作而非错误；
           createHabit 自身已把习惯落本地，失败亦无 UI 反馈诉求 */
      });
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
      Taro.showToast({ title: t('common.writeFailed'), icon: 'none' });
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
    // Number.isFinite：上面已用 typeof 收窄为 number，两者对 number 行为完全一致，
    // 且避免全局 isFinite 的隐式字符串强转（isFinite('5') === true）。
    if (typeof mins !== 'number' || !Number.isFinite(mins)) return null;
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
              {profile?.subscribed ? (
                <Text className={styles.badge}>{t('mine.badgeSubscribed')}</Text>
              ) : (
                <Text className={styles.proBadge} onClick={handleGoSubscribe}>
                  ⚡ PRO
                </Text>
              )}
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
            {/* 记账卡片：独立于 hasContent 门禁 —— 记账与日程无关，
           用户「今天没安排日程但记了账」时也必须能看到账单。
           早前把它放进 contentFade 内，结果被 hasContent（仅看日程/待办/收藏）挡住，
           实测：数据算对了、state 更新了，卡片就是不渲染（2026-10-15）。 */}
{/* 记账卡片（v2.0 F23 · 「每天早上呈报」的落点）：
    位置在「今日日程」之后、「待办」之前 —— 与调研建议一致：记账属「当日概览」，
    排在待办/收藏/情报这些参考类之前符合信息优先级。
    ⚠️ 一律「有数据才渲染」：今天没记账时显示空态卡会占掉晨报首屏黄金位，
    而记账又是新功能、多数用户初期没有数据 —— 那里应该留给日程。 */}
      {ledgerBrief && ledgerBrief.count > 0 ? (
        <View className={styles.section}>
          <View className={styles.sectionHeader}>
            <Text className={styles.sectionIcon}>🧾</Text>
            <Text className={styles.sectionTitle}>{t('briefing.sectionLedger')}</Text>
            <Text className={styles.sectionCount}>
              {ledgerBrief.count} {t('briefing.ledgerCount')}
            </Text>
          </View>

          <View style={{ display: 'flex', alignItems: 'baseline', gap: '16rpx', padding: '0 32rpx' }}>
            <Text style={{ fontSize: '44rpx', fontWeight: '700', color: 'var(--brand, #e85d2a)' }}>
              ¥{ledgerBrief.expense.toFixed(2)}
            </Text>
            <Text style={{ fontSize: '26rpx', color: '#86909c' }}>{t('briefing.ledgerToday')}</Text>
          </View>

          {/* 较昨日：昨日为 0 时 deltaFromYesterday 为 null，此时**整行不渲染** ——
              显示成「+100%」会是误导性的百分比（分母为 0）。 */}
          {ledgerBrief.deltaFromYesterday !== null ? (
            <Text style={{ fontSize: '26rpx', color: '#86909c', padding: '8rpx 32rpx 0' }}>
              {ledgerBrief.deltaFromYesterday > 0
                ? `${t('briefing.ledgerMore')} ¥${Math.abs(ledgerBrief.deltaFromYesterday).toFixed(2)}`
                : ledgerBrief.deltaFromYesterday < 0
                  ? `${t('briefing.ledgerLess')} ¥${Math.abs(ledgerBrief.deltaFromYesterday).toFixed(2)}`
                  : t('briefing.ledgerSame')}
            </Text>
          ) : null}

          {ledgerBrief.income > 0 ? (
            <Text style={{ fontSize: '26rpx', color: 'var(--brand-deep, #e85d2a)', padding: '8rpx 32rpx 0' }}>
              {t('briefing.ledgerIncome')} ¥{ledgerBrief.income.toFixed(2)}
            </Text>
          ) : null}

          {ledgerBrief.topCategories.length > 0 ? (
            <View style={{ padding: '12rpx 32rpx 0' }}>
              {ledgerBrief.topCategories.map((c) => {
                const cat = resolveCategory(ledgerCats, c.categoryId);
                return (
                  <Text
                    key={c.categoryId}
                    style={{ fontSize: '26rpx', color: '#4e5969', display: 'block', padding: '2rpx 0' }}
                  >
                    {cat.icon} {cat.name} ¥{c.amount.toFixed(2)}
                  </Text>
                );
              })}
            </View>
          ) : null}

          {ledgerBrief.overDaily ? (
            <View style={{ padding: '12rpx 32rpx 0' }}>
              <Text style={{ fontSize: '26rpx', color: '#f53f3f' }}>
                ⚠️ {t('ledger.overDaily', { amount: `¥${(ledgerBrief.dailyBudget ?? 0).toFixed(2)}` })}
              </Text>
            </View>
          ) : null}

          <Text
            style={{ fontSize: '26rpx', color: 'var(--brand, #e85d2a)', padding: '12rpx 32rpx 0' }}
            onClick={() => Taro.navigateTo({ url: '/pages/ledger/index' })}
          >
            {t('briefing.ledgerViewAll')} ›
          </Text>
        </View>
      ) : null}
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
          {/* 空态带**可点的主行动**：文案让用户「去收件箱」，这句话以前是指不动的
              （EmptyState 原本只有 icon/title/hint 三个 prop），用户得自己在底栏
              找「收件箱」。晨报首屏对新用户 100% 是这个空态 —— 它就是激活漏斗的第一步，
              不该是死胡同（2026-10-12 增长审计）。 */}
          <EmptyState
            icon='☕'
            title={t('briefing.emptyTitle')}
            // 云端没接通导致的空态，必须说明白原因 —— 否则用户会以为是自己没转发内容，
            // 反复去收件箱试。「去复制消息」对他此刻毫无意义（云端都没接）。
            // 判据用 briefing.intel.degraded，而不是 !briefing.intel：
            // 前者只由 cloud.ts 的 catch 置位，语义精确；后者在新用户首次进站时也成立。
            hint={briefing?.intel?.degraded ? t('briefing.degraded') : t('briefing.emptyHint')}
            action={t('briefing.emptyCta')}
            onAction={() => {
              Taro.switchTab({ url: '/pages/inbox/index' }).catch(() => {
                // 主通道（tab 跳转）失败时退回普通跳转；两条通道都失败才是真故障，必须留痕
                Taro.redirectTo({ url: '/pages/inbox/index' }).catch((err) => {
                  console.error('[BriefingPage] 跳转收件箱失败:', err);
                });
              });
            }}
          />
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
                {/* 订阅用户 + AI 启用中 → PRO 角标（AI 提炼专属标识） */}
                {profile?.subscribed && intelResolved.aiEnabled && !intelResolved.degraded ? (
                  <Text className={styles.sectionProTag}>PRO</Text>
                ) : null}
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
                    // 宽化读取： BriefingIntel.intelItems 的类型是冻结文件里的 {text,source}，
                    // 云端 fallback 路径实际还带 image/url（2026-10-22 增量）——按 intelGroups.ts
                    // 的 IntelSourceRef 读，缺字段时自动降级纯文本，不会崩。
                    <IntelItemRow key={i} item={item as IntelSourceRef} />
                  ))}
              {/* 只有「确实由 AI 生成」的导语才挂 AI 署名（合规）：必须本档位启用 AI（aiEnabled）
                  且未降级。免费档 aiEnabled=false、导语来自 groupIntelLocally 的纯文本拼接
                  （如「科技前沿：共 1 条相关资讯」），并非 AI 生成 —— 挂此署名会与下方
                  「暂不含 AI 提炼」文案自相矛盾，构成 AI 虚假归因。 */}
              {intelResolved.groups.length > 0 && intelResolved.aiEnabled && !intelResolved.degraded ? (
                <Text className={styles.intelLeadTag}>{t('briefing.intelGroupLead')}</Text>
              ) : null}
              {/* intelNote：三态文案（免费档/降级/正常）；免费档带内联 CTA 跳订阅 */}
              {!intelResolved.aiEnabled ? (
                <View className={styles.intelNote}>
                  <Text className={styles.intelNoteText}>{t('briefing.intelFreeNote')}</Text>
                  <Text className={styles.intelNoteCta} onClick={handleGoSubscribe}>
                    ⚡ {t('briefing.intelFreeCta')} →
                  </Text>
                </View>
              ) : intelResolved.degraded ? (
                <Text className={styles.intelNote}>{t('briefing.intelRawNote')}</Text>
              ) : (
                <Text className={styles.intelNote}>{t('briefing.aiTag')}</Text>
              )}
            </View>
          ) : null}
        </View>
      )}

      {/* 视频新闻（B站热榜第 1 条）：独立于 hasContent 门禁 —— 与记账卡片同理由，
          视频资讯与当天有没有日程无关；放进 contentFade 会被「三皆空」的空态吃掉
          （2026-10-15 记账卡片踩过的坑，见本节上方注释）。
          有数据才渲染：拿不到（RPC 失败/榜单为空）就整卡不出现，不留空壳。 */}
      {videoNews.length > 0 ? (
        <View className={styles.section}>
          <View className={styles.sectionHeader}>
            <Text className={styles.sectionIcon}>🎬</Text>
            <Text className={styles.sectionTitle}>{t('briefing.videoSection')}</Text>
          </View>
          {videoNews.map((v) => {
            const play = formatPlayCount(v.play);
            return (
              <View
                key={v.id}
                className={styles.videoCard}
                onClick={() => {
                  // 打开原文：H5 新标签 / 小程序复制链接（openExternalPage 内置双端降级）；
                  // 'copied'/'failed' 都必须让用户看见，不能「点了没反应」
                  openExternalPage(v.url)
                    .then((r) => {
                      if (r === 'copied') Taro.showToast({ title: t('sxm.copyHint'), icon: 'none', duration: 2000 });
                      else if (r === 'failed') Taro.showToast({ title: t('sxm.copyFail'), icon: 'none', duration: 2000 });
                    })
                    .catch((err) => console.warn('[BriefingPage] video open failed:', err));
                }}
              >
                <View className={styles.videoCoverWrap}>
                  {v.image ? (
                    <Image src={v.image} mode='aspectFill' lazyLoad className={styles.videoCover} />
                  ) : (
                    <View className={styles.videoCoverFallback}>
                      <Text className={styles.videoCoverFallbackIcon}>🎬</Text>
                    </View>
                  )}
                  {/* 播放角标 + 时长：相对封面容器（position:relative）内绝对定位，
                      徽章自身只做背景+圆角，无变换/裁剪，双端渲染一致 */}
                  <View className={styles.videoCoverBadge}>
                    <Text className={styles.videoCoverBadgeText}>▶ {v.duration || '视频'}</Text>
                  </View>
                </View>
                <View className={styles.videoBody}>
                  <Text className={styles.videoTitle}>{v.title}</Text>
                  <Text className={styles.videoMeta}>
                    {v.source}
                    {v.author ? ` · ${v.author}` : ''}
                    {play ? ` · ${t('briefing.videoPlays', { n: play })}` : ''}
                  </Text>
                </View>
              </View>
            );
          })}
          {/* 来源与入口性质声明：合规要求来源可见 + 明示「只做入口不转载」 */}
          <Text className={styles.videoDisclaimer}>{t('briefing.videoDisclaimer')}</Text>
        </View>
      ) : null}

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

      {/* L3 免责页脚：晨报含天气/财经资讯，合规要求常驻。
    合规修正（2026-10-12）：「内容由 AI 整理」只在**本档位确实走了 AI 且未降级**时才署名 ——
    免费档情报来自公开 RSS 的本地分组，全程无 AI，署 AI 名即对功能能力的虚假陈述。 */}
      <View className={styles.disclaimerFooter}>
        <Text className={styles.disclaimerText}>
          {t(intelResolved.aiEnabled && !intelResolved.degraded ? 'common.disclaimerAI' : 'common.disclaimer')}
        </Text>
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
            disabled={sending}
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
    </View>
  );
}

export default BriefingPage;
