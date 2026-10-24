import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Picker, Button, Image, Input, Switch, ScrollView, Textarea } from '@tarojs/components';
import type { CommonEvent, PickerSelectorProps, PickerTimeProps } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import classnames from 'classnames';
import PromptModal from '@/components/PromptModal';
import DemoDataHint from '@/components/DemoDataHint';
import SyncConflictHint from '@/components/SyncConflictHint';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore, THEME_PRESETS } from '@/store/theme';
import { useUiScaleStore, UI_SCALE_PRESETS } from '@/store/uiScale';
import { useT, useLanguageStore, LANG_OPTIONS } from '@/store/language';
import type { LangKey } from '@/store/language';
import {
  apiCreateOrder,
  apiDeleteAccount,
  apiApplyPlan,
  apiSubmitFeedback,
  type CreateOrderPayload
} from '@/services/api';
import { getPayChannel, getChannelAuth, invokePayment } from '@/services/pay';
import type { PayChannel, PayOrder } from '@/types';
import { signOut } from '@/services/cloudAuth';
import { kvClear } from '@/services/cloudDb';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import { AI_LABEL_VERSION } from '@/utils/aiLabel';
import { disabledAttr } from '@/utils/buttonDisabled';
import { fromNow, dayKey } from '@/utils/date';
import { getActivityLogs } from '@/utils/activityLog';
import type { ActivityLogItem } from '@/utils/activityLog';
import { getPersonalization, setPersonalization } from '@/utils/permission';
import { resolveCityName } from '@/utils/weather';
import { getTtsPrefs, saveTtsPrefs, TTS_RATE_OPTIONS } from '@/utils/tts';
import type { TtsPrefs, TtsVoiceMode } from '@/utils/tts';
import { FEATURES } from '@/utils/featureUsage';
import type { FeatureKey, UsageSummary } from '@/utils/featureUsage';
import { readUsageSummary } from '@/utils/usageLog';
import { copyKeyOf, resolveRenewal, shouldRemind } from '@/utils/renewal';
import type { RenewalCopyKey } from '@/utils/renewal';
import {
  EARLYBIRD_PRICE,
  formatPrice,
  listInboxNotices,
  lockPrice,
  markNoticeRead,
  readLockedPrice
} from '@/utils/subscription';
import type { LockedPriceInfo, PriceChangeNotice } from '@/utils/subscription';
import { clearMemory, deleteMemory, readMemory, setMemoryEnabled, truncateSummary } from '@/utils/memory';
import type { MemoryItem, MemoryStore } from '@/utils/memory';
import { clearBlockRules, listBlockRules, restoreBlockRule } from '@/utils/blocklist';
import type { BlockDimension, BlockRule } from '@/utils/blocklist';
import { readPrefs, updatePrefs, isInDnd } from '@/utils/prefs';
import type { UserPrefs, PushFreq } from '@/utils/prefs';
import { apiSavePrefs, apiGetPrefs } from '@/services/cloud';
import { clearReadStreak, getReadStreak, getReadFreezeCards } from '@/utils/readStreak';
import {
  listHabits,
  removeHabit,
  setHabitAutoGuard,
  listRestorableRecords,
  undoHabitGuard,
  listHabitNotices,
  markHabitNoticeRead
} from '@/utils/habit';
import type { Habit, HabitGuardRecord, HabitNotice } from '@/utils/habit';
import { FEEDBACK_TEXT, FEEDBACK_TYPES, CITY_TEXT, type FeedbackType } from './feedbackText';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const isH5 = process.env.TARO_ENV === 'h5';
const AVATAR_KEY = 'user-avatar';
/** H5 预览端可选的预设头像 */
const AVATAR_PRESETS = ['🌅', '🌞', '🌱', '🐳', '🦊', '🐼'];

/** 通道标签 i18n key 映射 */
const CHANNEL_LABEL_KEY: Record<PayChannel, LangKey> = {
  wechat: 'mine.payChannelWechat',
  alipay: 'mine.payChannelAlipay',
  douyin: 'mine.payChannelDouyin'
};
/** 通道图标 emoji 映射（跨端零依赖，避免额外资源） */
const CHANNEL_ICON: Record<PayChannel, string> = {
  wechat: '💬',
  alipay: '💰',
  douyin: '🎵'
};
const channelIconMap = CHANNEL_ICON;
const channelLabelKey = CHANNEL_LABEL_KEY;

/** 订单状态 → i18n key（考虑 refundStatus 优先级） */
function getOrderStatusLabel(status: string, refundStatus: string): LangKey {
  if (refundStatus === 'refunded') return 'mine.orderStatusRefunded';
  if (refundStatus === 'refunding') return 'mine.orderStatusRefunding';
  switch (status) {
    case 'paid': return 'mine.orderStatusPaid';
    case 'created': return 'mine.orderStatusCreated';
    case 'closed': return 'mine.orderStatusClosed';
    default: return 'mine.orderStatusCreated';
  }
}

/** 订单状态 → 展示色（全页统一 CSS token 引用） */
function getOrderStatusColor(status: string, refundStatus: string): string {
  if (refundStatus === 'refunded') return '#999999';
  if (refundStatus === 'refunding') return '#E85D2A';
  if (status === 'paid') return '#16A34A';       // 绿
  if (status === 'created') return '#F59E0B';   // 橙
  if (status === 'closed') return '#999999';     // 灰
  return '#666666';
}

/** 危险操作确认按钮统一色值（设计文档第六章 B） */
const DANGER_COLOR = '#E85D2A';

const PLAN_LIST: Array<{ id: PayOrder['planId']; label: string }> = [
  { id: 'earlybird_monthly', label: '早鸟月付' },
  { id: 'monthly', label: '月付' },
  { id: 'yearly', label: '年付' }
];

/** 存储值保持中文，展示时按当前语言翻译 */
const PLAN_LABEL_KEY: Record<string, LangKey> = {
  earlybird_monthly: 'mine.planEarlyBird',
  monthly: 'mine.planMonthly',
  yearly: 'mine.planYearly'
};

const PREF_TAG_LABEL: Record<string, LangKey> = {
  '科技': 'mine.prefTech',
  '效率工具': 'mine.prefProductivity',
  '财经': 'mine.prefFinance',
  '健康': 'mine.prefHealth',
  '科学': 'mine.prefScience',
  '文化': 'mine.prefCulture',
  '出行': 'mine.prefTravel',
  '生活': 'mine.prefLife',
  'AI': 'mine.prefAi'
};

const REPLY_STYLE_LABEL: Record<string, LangKey> = {
  '简洁': 'mine.replyConcise',
  '均衡': 'mine.replyBalanced',
  '详细': 'mine.replyDetailed'
};

const UI_SCALE_LABEL: Record<string, LangKey> = {
  small: 'mine.uiSizeSmall',
  standard: 'mine.uiSizeStandard',
  large: 'mine.uiSizeLarge',
  xlarge: 'mine.uiSizeXlarge'
};

/** V-05 语速三档文案（取值来自 utils/tts.ts 的 TTS_RATE_OPTIONS） */
const TTS_RATE_LABEL: Record<'slow' | 'standard' | 'fast', LangKey> = {
  slow: 'tts.rateSlow',
  standard: 'tts.rateStandard',
  fast: 'tts.rateFast'
};

/** V-07 音色策略：跟随场景 / 固定音色 */
const TTS_VOICE_MODES: Array<{ id: TtsVoiceMode; labelKey: LangKey }> = [
  { id: 'auto', labelKey: 'tts.voiceAuto' },
  { id: 'fixed', labelKey: 'tts.voiceFixed' }
];

/** N-03 屏蔽维度文案（来源 / 话题标签，复用热点页同一组 key） */
const BLOCK_DIMENSION_LABEL: Record<BlockDimension, LangKey> = {
  source: 'library.blockSource',
  tag: 'library.blockTag'
};

/** X3 推送数量三档 */
const PUSH_FREQ_OPTIONS: Array<{ id: PushFreq; labelKey: LangKey }> = [
  { id: 'low', labelKey: 'settings.pushFreqLow' },
  { id: 'mid', labelKey: 'settings.pushFreqMid' },
  { id: 'high', labelKey: 'settings.pushFreqHigh' }
];

/** X3 四个推送模块（顺序即展示顺序） */
const PUSH_MODULES = ['weather', 'events', 'news', 'review'] as const;

const PUSH_MODULE_LABEL: Record<(typeof PUSH_MODULES)[number], LangKey> = {
  weather: 'settings.moduleWeather',
  events: 'settings.moduleEvents',
  news: 'settings.moduleNews',
  review: 'settings.moduleReview'
};

/**
 * C-04 注销校验词：用户需在确认弹窗内键入该词才能提交。
 * ⚠️ 这是「用户输入的校验 token」，不是界面文案，故不走 i18n；
 *    英文语境下同样要求键入「注销」二字（与 mine.deleteInputHint 提示一致）。
 */
const DELETE_CONFIRM_WORD = '注销';

/** TODO：上线前在小程序后台绑定企业微信客服后替换 */
const SERVICE_CORP_ID: string = 'TODO_CORP_ID';
/** 客服联系方式（与 legal.ts 协议承诺的「15 个工作日答复」配套；改这里要同步协议文本） */
const SERVICE_EMAIL = 'support@morningbrief.cn';
const SERVICE_WECHAT = '私人晨报助理';

const PREF_TAGS = ['科技', '效率工具', '财经', '健康', '出行', '生活', 'AI', '科学', '文化'];
const REPLY_STYLES = ['简洁', '均衡', '详细'];
const CUSTOM_SETTINGS_KEY = 'user-settings';

// 法务文本统一取自 src/data/legal.ts（与首启同意弹窗共用），勿在此重复声明
// v1.2 起 AI 记忆统一由 src/utils/memory.ts 管理，移除本页原有的 4 条演示 seed（AI_MEMORY_SEED）：
// 否则三入口（逐条删除 / 清空 / 开关）管不到 seed 数据，会出现「删了又回来」。
// 已知用户可见变更：老用户升级后原有的 4 条演示记忆不再预置，空态展示「暂无记忆」。


interface CustomSettings {
  replyStyle: string;
  newsEnabled: boolean;
  morningReminderEnabled: boolean;
}

const DEFAULT_CUSTOM: CustomSettings = {
  replyStyle: '均衡',
  newsEnabled: true,
  morningReminderEnabled: true
};

/* ---------------- 续费提醒偏好（2026-10-24） ----------------
 * 两个 key 都是**本机偏好**，刻意不进 cloudSync：
 *   · `mb_renew_remind`     —— 开关（默认开）
 *   · `mb_renew_remind_day` —— 上次提示的日期，用于"一天最多一次"的节流
 * 为什么不进同步：提醒是"在这台设备上看到的"，与账号无关；而且这是高频写（每次提示都写），
 * 进同步只会制造无意义的拉取/覆盖。功能记账（feature-usage）才需要跨端一致。 */
const RENEW_REMIND_KEY = 'mb_renew_remind';
const RENEW_REMIND_DAY_KEY = 'mb_renew_remind_day';

function readRenewRemindPref(): boolean {
  try {
    const v = Taro.getStorageSync(RENEW_REMIND_KEY);
    // 缺键返回 ''（不是 undefined）—— 默认开，所以只有明确写 false 才关
    return v === false ? false : true;
  } catch {
    return true;
  }
}

function writeRenewRemindPref(on: boolean): void {
  try {
    Taro.setStorageSync(RENEW_REMIND_KEY, on);
  } catch (err) {
    console.warn('[MinePage] save renew remind pref failed:', err);
  }
}

function readRenewRemindDay(): string {
  try {
    return String(Taro.getStorageSync(RENEW_REMIND_DAY_KEY) || '');
  } catch {
    return '';
  }
}

function writeRenewRemindDay(day: string): void {
  try {
    Taro.setStorageSync(RENEW_REMIND_DAY_KEY, day);
  } catch (err) {
    console.warn('[MinePage] save renew remind day failed:', err);
  }
}

/** 功能记账的展示顺序与文案键（顺序与 utils/featureUsage.ts 的 FEATURES 一致） */
const FEATURE_LABEL_KEY: Record<FeatureKey, LangKey> = {
  chat: 'mine.fUsageChat',
  extract: 'mine.fUsageExtract',
  voice: 'mine.fUsageVoice',
  search: 'mine.fUsageSearch'
};

/** 续费状态文案（键由 utils/renewal.ts 的 copyKeyOf 决定，映射放这里是为了 i18n 类型安全） */
const RENEW_STATUS_KEY: Record<RenewalCopyKey, LangKey> = {
  statusActive: 'mine.renewStatusActive',
  statusExpiring: 'mine.renewStatusExpiring',
  statusToday: 'mine.renewStatusToday',
  statusExpired: 'mine.renewStatusExpired'
};

function loadCustom(): CustomSettings {
  try {
    return { ...DEFAULT_CUSTOM, ...(Taro.getStorageSync(CUSTOM_SETTINGS_KEY) || {}) };
  } catch (err) {
    return DEFAULT_CUSTOM;
  }
}

function MinePage() {
  const { profile, usage, init, saveSettings } = useUserStore();
  const { theme, setTheme } = useThemeStore();
  const { id: scaleId, setScale } = useUiScaleStore();
  const t = useT();
  const { lang, setLang } = useLanguageStore();
  const [planId, setPlanId] = useState<PayOrder['planId']>('earlybird_monthly');
  const [paying, setPaying] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [logs, setLogs] = useState<ActivityLogItem[]>([]);
  // 设置项（自独立设置页合并而来）
  const [nickname, setNickname] = useState('');
  const [prefs, setPrefs] = useState<string[]>([]);
  const [custom, setCustom] = useState<CustomSettings>(DEFAULT_CUSTOM);
  const [docView, setDocView] = useState<'terms' | 'privacy' | 'ai' | null>(null);
  /** 注销二次确认弹窗 */
  const [deleteOpen, setDeleteOpen] = useState(false);
  // === 意见反馈（2026-10-24）：主动投诉/建议通道 ===
  // 草稿在关闭弹层后**保留**（mask 误触不该丢已写的内容），只有真正提交成功才清空。
  const [fbOpen, setFbOpen] = useState(false);
  const [fbType, setFbType] = useState<FeedbackType>('suggestion');
  const [fbContent, setFbContent] = useState('');
  const [fbContact, setFbContact] = useState('');
  const [fbSending, setFbSending] = useState(false);
  // === 天气城市手动设置（2026-10-24）===
  // user-city 此前只有 GPS 逆地理编码会写：拒绝定位就永远是「北京」，天气静默显示错城市。
  const [city, setCity] = useState(() => {
    try {
      return String(Taro.getStorageSync('user-city') || '');
    } catch {
      return '';
    }
  });
  const [cityOpen, setCityOpen] = useState(false);
  const [cityDraft, setCityDraft] = useState('');
  const [cityChecking, setCityChecking] = useState(false);
  // v1.2 新增：C-03 个性化推荐开关 / V-05 V-07 TTS 偏好 / M-01 M-02 记忆 / N-03 屏蔽清单 / B-01 B-02 订阅
  const [personalOn, setPersonalOn] = useState(true);
  const [ttsPrefs, setTtsPrefs] = useState<TtsPrefs>({ rate: 1.0, voiceMode: 'auto' });
  const [memory, setMemory] = useState<MemoryStore>({ enabled: true, items: [] });
  const [blocks, setBlocks] = useState<BlockRule[]>([]);
  const [locked, setLocked] = useState<LockedPriceInfo | null>(null);
  const [notices, setNotices] = useState<PriceChangeNotice[]>([]);
  // v2.2（2026-10-24）：功能记账 + 续费提醒
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [remindOn, setRemindOn] = useState(true);
  // v2.1：晨报连续阅读（只读展示 + 清空入口）
  const [readStreak, setReadStreak] = useState(0);
  const [readFreezeCards, setReadFreezeCards] = useState(0);
  // v2.1：习惯守护（列表 + 自动守护开关 + 守护记录 + 站内信）
  const [habits, setHabits] = useState<Habit[]>([]);
  const [guardRecords, setGuardRecords] = useState<HabitGuardRecord[]>([]);
  // === 订阅记录 / 退款 ===
  interface OrderSummary {
    orderId: string;
    channel: PayChannel;
    planId: string;
    price: number;
    months: number;
    status: string;
    payStatus?: string;
    refundStatus: string;
    createTime: string;
    paidTime?: string | null;
  }
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [habitNotices, setHabitNotices] = useState<HabitNotice[]>([]);
  // 竞品分析本轮：L2 AI 精选 / X3 推送偏好 / X6 周末轻量版 / X11 未成年人模式（mb-prefs 统一契约）
  const [appPrefs, setAppPrefs] = useState<UserPrefs>(() => readPrefs());
  const [dndActive, setDndActive] = useState(false);
  /** X11 家长密码弹层：set = 首次开启设置密码；verify = 关闭前校验 */
  const [pinOverlay, setPinOverlay] = useState<null | { mode: 'set' | 'verify' }>(null);
  const [pinInput, setPinInput] = useState('');

  useEffect(() => {
    init();
    // 仅挂载执行一次：init 为 store 动作，重渲染/语言切换无需重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // profile 就绪后回填设置项 + 读取本地自定义设置 / 个性化开关 / TTS 偏好 / 记忆 / 屏蔽清单 / 锁价与站内信
  useEffect(() => {
    if (profile) {
      setNickname(profile.nickname);
      setPrefs(profile.preferences || []);
    }
    setCustom(loadCustom());
    setPersonalOn(getPersonalization());
    setTtsPrefs(getTtsPrefs());
    setMemory(readMemory());
    setBlocks(listBlockRules());
    setLocked(readLockedPrice());
    setNotices(listInboxNotices());
    setReadStreak(getReadStreak());
    setReadFreezeCards(getReadFreezeCards());
    setHabits(listHabits());
    setGuardRecords(listRestorableRecords());
    setHabitNotices(listHabitNotices());
    setAppPrefs(readPrefs());
  }, [profile]);

  // ========== 订阅记录 + 退款 ==========
  const [ordersError, setOrdersError] = useState(false);
  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(false);
    try {
      const cloud = (Taro as unknown as { cloud?: { callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown> } }).cloud;
      if (!cloud?.callFunction) return;
      const res = await cloud.callFunction({ name: 'ordersList', data: { limit: 20 } });
      const r = res as { result?: { ok?: boolean; orders?: OrderSummary[] } } | null;
      if (r?.result?.ok && Array.isArray(r.result.orders)) {
        setOrders(r.result.orders);
      } else {
        // 云函数明确回 ok:false = 服务端拒绝（不是网络抖动），同样算失败：
        // 老写法在这里静默返回，orders 停在空数组 → 用户看到「暂无订阅记录」，
        // 把「查询失败」伪装成「你没订阅过」。已付费用户会误以为自己被吞了订单。
        setOrdersError(true);
      }
    } catch (e) {
      console.warn('[MinePage] loadOrders failed:', e);
      setOrdersError(true);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  const handleRefund = useCallback(async (orderId: string, channel: PayChannel) => {
    if (refunding) return;
    // 抖音暂不支持自动退款 → 提示联系客服
    if (channel === 'douyin') {
      Taro.showModal({
        title: t('mine.refundBtn'),
        content: t('mine.refundDouyinNote'),
        showCancel: false,
        confirmText: 'OK'
      });
      return;
    }
    try {
      const res = await Taro.showModal({
        title: t('mine.refundBtn'),
        content: t('mine.refundBtn') + '？',
        confirmColor: DANGER_COLOR
      });
      if (!res.confirm) return;
      setRefunding(true);
      const cloud = (Taro as unknown as { cloud?: { callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown> } }).cloud;
      if (!cloud?.callFunction) {
        Taro.showToast({ title: t('mine.refundFailed'), icon: 'none' });
        return;
      }
      const callRes = await cloud.callFunction({ name: 'refundOrder', data: { orderId } });
      const r = callRes as { result?: { ok?: boolean; manualRefund?: boolean; error?: string } } | null;
      if (r?.result?.ok) {
        Taro.showToast({ title: t('mine.refundSuccess'), icon: 'success' });
        await init(); // 刷新订阅状态（refundOrder 云函数已回滚 expiredAt）
        await loadOrders();
      } else if (r?.result?.manualRefund) {
        Taro.showToast({ title: t('mine.refundDouyinNote'), icon: 'none', duration: 2500 });
      } else {
        Taro.showToast({ title: r?.result?.error || t('mine.refundFailed'), icon: 'none' });
      }
    } catch (e) {
      console.warn('[MinePage] handleRefund error:', e);
      Taro.showToast({ title: t('mine.refundFailed'), icon: 'none' });
    } finally {
      setRefunding(false);
    }
  }, [refunding, t, init, loadOrders]);

  // 每次切回「我的」页刷新近期动态（最新 3 条）+ 可能被其他页面改动过的共享状态
  useDidShow(() => {
    setLogs(getActivityLogs().slice(0, 3));
    setMemory(readMemory());
    setBlocks(listBlockRules());
    setPersonalOn(getPersonalization());
    setLocked(readLockedPrice());
    setNotices(listInboxNotices());
    setReadStreak(getReadStreak());
    setReadFreezeCards(getReadFreezeCards());
    setHabits(listHabits());
    setGuardRecords(listRestorableRecords());
    setHabitNotices(listHabitNotices());
    setAppPrefs(readPrefs());
    // 功能记账：每次进页面重算（别的页面可能刚发生过 AI 调用/语音）
    setUsageSummary(readUsageSummary());
    setRemindOn(readRenewRemindPref());
    void loadOrders();
  });

  /* ---------------- 续费管理（2026-10-24） ---------------- */
  // 判定全在 utils/renewal.ts（纯函数、有断言）。这里只负责「拿 profile → 决定要不要提示」。
  // profile 是异步来的（store.init），所以放在依赖 profile 的 effect 里，而不是 useDidShow：
  // 冷启动时 useDidShow 早于 profile 落库，在那里判会永远判成 status='none'。
  const renewal = useMemo(
    () =>
      resolveRenewal({
        subscribed: !!profile?.subscribed,
        expiredAt: profile?.expiredAt || undefined,
        today: dayKey()
      }),
    [profile?.subscribed, profile?.expiredAt]
  );

  useEffect(() => {
    if (!renewal.remind || !remindOn) return;
    const today = dayKey();
    if (!shouldRemind(readRenewRemindDay(), today, renewal)) return;
    // 站内提示（不是推送）：产品明确不做自动续费，也不发模板消息，这里只提醒一次/天。
    Taro.showToast({
      title:
        renewal.status === 'expired'
          ? t('mine.renewWarnExpired')
          : (renewal.daysLeft || 0) === 0
            ? t('mine.renewToastToday')
            : t('mine.renewToast', { n: renewal.daysLeft || 0 }),
      icon: 'none',
      duration: 2600
    });
    writeRenewRemindDay(today);
  }, [renewal, remindOn, t]);

  /** 到期状态一句话（有效 / 还剩 N 天 / 今天到期 / 已过期 N 天） */
  const renewalStatusText = useMemo(() => {
    const k = copyKeyOf(renewal);
    const n = Math.abs(renewal.daysLeft || 0);
    return t(RENEW_STATUS_KEY[k], { n });
  }, [renewal, t]);

  const handleToggleRemind = useCallback((next: boolean) => {
    setRemindOn(next);
    writeRenewRemindPref(next);
    // 重新打开时清掉"今天已提示过"：否则开关拨回来却什么都不会发生，用户会以为开关是坏的
    if (next) writeRenewRemindDay('');
  }, []);

  // 偏好变化（或重新回到本页）后重算免打扰状态，辅助说明用
  useEffect(() => {
    setDndActive(isInDnd());
  }, [appPrefs]);

  /* ---------------- X3 偏好云上报（仅 weapp；失败静默，不影响本机写入） ---------------- */
  const prefsReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 支付成功后的对账兜底定时器（1800ms）；卸载时清理，避免卸载后 setState + 重复查单 */
  const payReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载清理：偏好上报防抖 + 支付对账两个定时器都必须取消。
  // 原实现只清了 undoTimers（library 页同款），这两个漏了 —— 快速切走时会触发
  // 一次无谓的云函数调用 / 卸载后 setState（2026-10-24 审计）。
  useEffect(
    () => () => {
      if (prefsReportTimerRef.current) clearTimeout(prefsReportTimerRef.current);
      if (payReconcileTimerRef.current) clearTimeout(payReconcileTimerRef.current);
    },
    []
  );
  /** 设置变更后的 1s 防抖上报：连续切换只上报最后一次 */
  const queuePrefsReport = (next: UserPrefs) => {
    if (!isWeapp) return;
    if (prefsReportTimerRef.current) clearTimeout(prefsReportTimerRef.current);
    prefsReportTimerRef.current = setTimeout(() => {
      prefsReportTimerRef.current = null;
      // apiSavePrefs 内部已 catch 返回 false，此处再兜一层确保不外抛
      apiSavePrefs(next).catch(() => {});
    }, 1000);
  };
  /** 统一偏好提交入口：本机落盘 + 触发防抖云上报 */
  const commitPrefs = (patch: Partial<UserPrefs>): UserPrefs => {
    const next = updatePrefs(patch);
    setAppPrefs(next);
    queuePrefsReport(next);
    return next;
  };
  // 启动时拉云端偏好合并（仅 weapp，页面首载一次）。
  // 合并取舍：UserPrefs 没有可靠的「更新时间」字段可判本地/云端谁更新（云端 updatedAt 与本机时钟不可比），
  // 二选一采用「云端存在即覆盖本地」——云端值是本端最后一次成功上报的快照，单设备场景与本地一致；
  // 换机/重装场景以云端为准可让偏好跟随账号，代价是本机清数据后的新改动可能被云端旧值盖回。
  useEffect(() => {
    if (!isWeapp) return;
    apiGetPrefs()
      .then((cloudPrefs) => {
        if (!cloudPrefs) return;
        setAppPrefs(updatePrefs(cloudPrefs));
      })
      .catch(() => {
        /* 静默：apiGetPrefs 内部已吞异常并记录、失败返回 null（services/cloud.ts:240），
           拉不到云端偏好就沿用本地值，属预期降级，不打扰用户 */
      });
  }, []);

  // 恢复本地头像（微信端为本地/临时图片路径，H5 端为 emoji）
  useEffect(() => {
    try {
      const saved = Taro.getStorageSync(AVATAR_KEY) as string;
      if (saved) setAvatar(saved);
    } catch (err) {
      console.warn('[MinePage] restore avatar failed:', err);
    }
  }, []);

  const doChangeAvatar = () => {
    if (isWeapp) {
      Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        success: (res) => {
          const path = res.tempFiles?.[0]?.tempFilePath;
          if (!path) return;
          // TODO：正式版将图片上传到云存储（Taro.cloud.uploadFile）后使用 fileID
          setAvatar(path);
          Taro.setStorageSync(AVATAR_KEY, path);
          Taro.showToast({ title: '头像已更新', icon: 'success' });
        },
        fail: (err) => console.info('[MinePage] chooseMedia cancelled:', err && err.errMsg)
      });
    } else {
      Taro.showActionSheet({ itemList: AVATAR_PRESETS })
        .then((res) => {
          const next = AVATAR_PRESETS[res.tapIndex];
          if (!next) return;
          setAvatar(next);
          Taro.setStorageSync(AVATAR_KEY, next);
          Taro.showToast({ title: '头像已更新', icon: 'success' });
        })
        .catch(() => {
          /* 静默：showActionSheet 被用户取消时 reject，是正常操作而非错误 */
        });
    }
  };

  /** 点头像：更换头像 或 查看浏览历史（v2.0 F26） */
  const handleAvatarTap = () => {
    Taro.showActionSheet({ itemList: ['更换头像', '浏览历史'] })
      .then((res) => {
        if (res.tapIndex === 0) doChangeAvatar();
        else if (res.tapIndex === 1) Taro.navigateTo({ url: '/pages/history/index' });
      })
      .catch(() => {
        /* 静默：showActionSheet 被用户取消时 reject，是正常操作而非错误 */
      });
  };

  const isEmojiAvatar = (val: string) => val.length <= 4;

  const voicePercent = useMemo(() => {
    if (!usage) return 0;
    if (usage.voiceQuota < 0) return 0;
    return Math.min(100, Math.round((usage.voiceUsed / usage.voiceQuota) * 100));
  }, [usage]);

  const collectionPercent = useMemo(() => {
    if (!usage) return 0;
    if (usage.collectionQuota < 0) return 0;
    return Math.min(100, Math.round((usage.collectionCount / usage.collectionQuota) * 100));
  }, [usage]);

  /** 当前编译目标的支付通道（三端自动识别；H5 为 null） */
  const currentPayChannel: PayChannel | null = getPayChannel();

  /** B-02：只展示未读的调价站内信 */
  const unreadNotices = useMemo(() => notices.filter((n) => !n.read), [notices]);

  /** 立即订阅：自动识别三端通道 → 下单 → 拉起支付 */
  const handleSubscribe = async () => {
    if (paying) return;

    // 1. 自动识别当前编译目标对应的支付通道
    const channel = getPayChannel();
    if (!channel) {
      // H5 端无真实支付能力：提示用户到小程序端
      Taro.showToast({ title: '请在微信/支付宝/抖音小程序中打开', icon: 'none', duration: 2500 });
      return;
    }

    // 已订阅用户再点「立即订阅」会**重复下单扣费** —— 先做二次确认。
    // ⚠️ 必须放在 channel 判空之后：H5 没有支付通道，不能先弹续费确认、
    //    再告诉用户「请在小程序打开」，那是一次无意义的交互往返。
    if (profile?.subscribed) {
      const ok = await new Promise<boolean>((resolve) => {
        Taro.showModal({
          title: t('mine.renewTitle'),
          content: t('mine.renewBody', { date: (profile.expiredAt || '').slice(0, 10) }),
          cancelText: t('cancel'),
          confirmText: t('mine.renewConfirm'),
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        });
      });
      if (!ok) return;
    }
    setPaying(true);

    try {
      // 2. 通道特定鉴权（alay→buyerId, douyin→openid, wechat→无）
      const auth = await getChannelAuth(channel);
      const payload: CreateOrderPayload = { planId, channel };
      if (channel === 'alipay') payload.buyerId = auth?.buyerId || '';
      if (channel === 'douyin') payload.openid = auth?.openid || '';

      // 3. 调云函数下单（小程序端走真云函数，H5 端在 services/cloud.ts 自动降级到 src/data/createOrder.ts mock）
      const result = await apiCreateOrder(payload);
      if (!result.ok) throw new Error('createOrder 返回 ok=false');
      console.info('[MinePage] order created:', result.orderId, 'channel:', channel, 'plan:', result.planId);

      // 4. 拉起小程序原生支付
      try {
        const payRes = await invokePayment(channel, result.payment);
        if (payRes.success) {
          // 5. 锁价（B-01：首次成功订阅自动早鸟锁价；已锁时内部跳过）
          // ⚠️ 必须在支付成功分支内：原先锁价写在下单后、支付前，用户取消支付 /
          //    支付失败同样会写入 active 锁价，getEffectivePrice 此后一直返回这个
          //    未成交价，UI 常驻「锁价 ¥6.9」——把没成交的单子当成成交价展示。
          setLocked(lockPrice(result.planId, result.price));
          Taro.showToast({ title: '支付成功', icon: 'success' });
          // 对账兜底：先 init 拉 profile；如果 pay-callback 还没到（支付宝/抖音 HTTP 稍慢），
          // profile 还是未订阅 → 立刻调 queryOrder 云函数查通道真相（会完成对账），再 init 刷新 UI
          const paidOrderId = result.orderId;
          // 定时器存 ref：用户支付后立刻切走页面时，卸载清理会 clearTimeout，
          // 避免回调在卸载后 setState + 重复查单（2026-10-24 审计）。
          payReconcileTimerRef.current = setTimeout(async () => {
            try {
              await init();
              // init 之后如果 profile 还是未订阅，补一次主动查单
              const freshProfile = useUserStore.getState().profile;
              if (!freshProfile?.subscribed || !freshProfile?.expiredAt) {
                // 小程序端 Taro.cloud 可用，queryOrder 只认 orderId（云函数间调用无 openid 校验）
                const cloud = (Taro as unknown as { cloud?: { callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown> } }).cloud;
                if (cloud?.callFunction) {
                  const q = await cloud.callFunction({ name: 'queryOrder', data: { orderId: paidOrderId } });
                  // queryOrder 返回 { ok, paid, reconciled, channelStatus }
                  const qRes = q as { ok?: boolean; paid?: boolean; reconciled?: boolean; channelStatus?: string } | null;
                  if (qRes?.paid) {
                    console.info('[MinePage] ✅ queryOrder 主动对账完成，刷新 profile');
                    await init();
                  } else {
                    console.warn('[MinePage] queryOrder 返回未付 channelStatus=', qRes?.channelStatus);
                  }
                }
              }
            } catch (e) {
              console.warn('[MinePage] 支付后对账兜底异常:', e);
            }
          }, 1800);
        }
      } catch (payErr) {
        const msg = String(payErr?.message || payErr || '');
        // 用户主动取消（微信：cancel；支付宝/douyin：canceled、用户取消）不算失败
        if (/cancel|取消/i.test(msg)) {
          console.info('[MinePage] user cancelled payment');
          Taro.showToast({ title: '已取消', icon: 'none' });
        } else {
          console.error('[MinePage] invokePayment failed:', payErr);
          Taro.showToast({ title: '支付未完成，请重试', icon: 'none' });
        }
      }
    } catch (err) {
      console.error('[MinePage] createOrder failed:', err);
      Taro.showToast({ title: '下单失败，请稍后再试', icon: 'none' });
    } finally {
      setPaying(false);
    }
  };

  /** B-02：标记调价站内信已读 */
  const handleReadNotice = (id: string) => {
    markNoticeRead(id);
    setNotices(listInboxNotices());
  };

  // ===== 设置项处理（自独立设置页合并而来） =====
  const memorySummary = useMemo(() => t('mine.memoryCount', { n: memory.items.length }), [memory, t]);

  /** P1-E 记忆溯源次行文案：chat 来源显示「时间 · 来自「短语」」，seed 显示「时间 · 初始化内置」，旧数据缺字段兜底「—」 */
  const memoryItemMeta = (item: MemoryItem): string => {
    const date = item.createdAt ? fromNow(item.createdAt) : '';
    const snippet = item.sourceSnippet ? item.sourceSnippet : '';
    if (!date && !snippet) return '—';
    if (item.source === 'seed' || !snippet) {
      return t('mine.memoryMetaSeed', { date: date || '—' });
    }
    return t('mine.memoryMetaChat', { date, snippet });
  };

  const persistCustom = (patch: Partial<CustomSettings>) => {
    const next = { ...custom, ...patch };
    setCustom(next);
    try {
      Taro.setStorageSync(CUSTOM_SETTINGS_KEY, next);
    } catch (err) {
      console.error('[MinePage] persist custom failed:', err);
    }
  };

  const handleBlurNickname = () => {
    const name = nickname.trim();
    if (!profile || !name || name === profile.nickname) return;
    saveSettings({ nickname: name });
  };

  // Picker mode='time' 的 onChange 事件：value 即 'HH:mm'（Taro 官方事件类型）
  const handleChangeTime = (e: CommonEvent<PickerTimeProps.ChangeEventDetail>) => {
    saveSettings({ briefingTime: e.detail.value });
  };

  const handleTogglePref = (tag: string) => {
    const next = prefs.includes(tag) ? prefs.filter((p) => p !== tag) : [...prefs, tag].slice(0, 5);
    setPrefs(next);
    saveSettings({ preferences: next });
  };

  const handleReplyStyle = (e: CommonEvent<PickerSelectorProps.ChangeEventDetail>) => {
    const idx = Number(e.detail.value);
    persistCustom({ replyStyle: REPLY_STYLES[idx] || '均衡' });
  };

  /* ---------------- C-03 个性化推荐开关 ---------------- */
  const handleTogglePersonal = (on: boolean) => {
    setPersonalOn(on);
    setPersonalization(on);
    if (!on) {
      Taro.showToast({ title: t('library.personalOffToast'), icon: 'none' });
    }
  };

  /* ---------------- V-05 / V-07 TTS 设置项 ---------------- */
  const handlePickRate = (rate: number) => {
    setTtsPrefs(saveTtsPrefs({ rate }));
  };

  const handlePickVoiceMode = (voiceMode: TtsVoiceMode) => {
    setTtsPrefs(saveTtsPrefs({ voiceMode }));
  };

  /* ---------------- M-01 / M-02 记忆管理三入口 ---------------- */
  const handleToggleMemory = (on: boolean) => {
    setMemoryEnabled(on);
    setMemory(readMemory());
  };

  /** ② 逐条删除（二次确认） */
  const handleDeleteMemoryItem = (item: MemoryItem) => {
    Taro.showModal({
      title: t('mine.memoryDeleteTitle'),
      content: t('mine.memoryDeleteBody', { text: truncateSummary(item.content) }),
      cancelText: t('cancel'),
      confirmText: t('mine.memoryItemDelete'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        deleteMemory(item.id);
        setMemory(readMemory());
      }
    });
  };

  /** ③ 清空全部记忆（二次确认，明示条数与不可恢复） */
  const handleClearMemory = () => {
    Taro.showModal({
      title: t('mine.memoryClearTitle'),
      content: t('mine.memoryClearBody', { n: memory.items.length }),
      cancelText: t('cancel'),
      confirmText: t('mine.memoryClearConfirm'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        clearMemory();
        setMemory(readMemory());
      }
    });
  };

  /* ---------------- v2.1 晨报连续阅读：清空入口（二次确认，复用 memory 清空的同构写法） ---------------- */
  const handleClearReadStreak = () => {
    Taro.showModal({
      title: t('readStreak.clearTitle'),
      content: t('readStreak.clearBody', { n: readStreak }),
      cancelText: t('cancel'),
      confirmText: t('readStreak.clearConfirm'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        clearReadStreak();
        setReadStreak(getReadStreak());
        setReadFreezeCards(getReadFreezeCards());
        Taro.showToast({ title: t('readStreak.cleared'), icon: 'none' });
      }
    });
  };

  /* ---------------- v2.1 习惯守护：列表 / 开关 / 还原 / 站内信 ---------------- */
  /** 未读习惯站内信（仅展示未读，与价格通知同构） */
  const unreadHabitNotices = useMemo(() => habitNotices.filter((n) => !n.read), [habitNotices]);

  /** 重新拉取习惯相关本地状态（任何变更后统一刷新，避免多处遗漏） */
  const reloadHabitState = () => {
    setHabits(listHabits());
    setGuardRecords(listRestorableRecords());
    setHabitNotices(listHabitNotices());
  };

  /** 切换自动守护开关（默认关闭，开启即用户显式授权自动调整） */
  const handleToggleHabitGuard = (id: string, on: boolean) => {
    setHabitAutoGuard(id, on);
    reloadHabitState();
    Taro.showToast({ title: on ? t('habit.autoGuardOn') : t('habit.autoGuardOff'), icon: 'none' });
  };

  /** 删除习惯（二次确认，复用 memory 删除的同构写法） */
  const handleRemoveHabit = (habit: Habit) => {
    Taro.showModal({
      title: t('habit.removeTitle'),
      content: t('habit.removeBody', { title: habit.title }),
      cancelText: t('cancel'),
      confirmText: t('habit.removeConfirm'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        removeHabit(habit.id);
        reloadHabitState();
      }
    });
  };

  /**
   * 撤销窗口内一键还原某次自动挪动。
   * 顺序：**先把日程改回原时段，远端成功后才在本地标记已撤销** ——
   * 否则写库失败会让记录从可还原列表消失、用户失去重试入口，却看到「已还原」。
   */
  const handleRestoreGuardRecord = async (record: HabitGuardRecord) => {
    const target = listRestorableRecords().find((r) => r.id === record.id);
    if (!target) {
      Taro.showToast({ title: t('habit.undoExpired'), icon: 'none' });
      reloadHabitState();
      return;
    }
    const result = await apiApplyPlan({
      events: [{ eventId: target.eventId, title: target.title, startTime: target.fromTime }]
    });
    if (!result.ok) {
      // 不改本地状态：记录仍留在可还原列表里，用户可重试
      console.warn('[MinePage] restoreHabitGuard failed, record kept for retry');
      Taro.showToast({ title: t('habit.undoFailed'), icon: 'none' });
      reloadHabitState();
      return;
    }
    undoHabitGuard(record.id);
    Taro.showToast({ title: t('habit.undoDone'), icon: 'none' });
    reloadHabitState();
  };

  /** 标记习惯站内信已读 */
  const handleReadHabitNotice = (id: string) => {
    markHabitNoticeRead(id);
    setHabitNotices(listHabitNotices());
  };

  /* ---------------- N-03 资讯偏好（屏蔽清单管理） ---------------- */
  const handleRestoreBlock = (rule: BlockRule) => {
    setBlocks(restoreBlockRule(rule.id));
  };

  const handleClearBlocks = () => {
    Taro.showModal({
      title: t('library.blockClear'),
      content: t('library.blockClearConfirm'),
      cancelText: t('cancel'),
      confirmText: t('library.blockClear'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        clearBlockRules();
        setBlocks(listBlockRules());
      }
    });
  };

  /* ---------------- L2 AI 精选开关（与资讯页共享 mb-prefs，实时生效） ---------------- */
  const handleToggleAiFilter = (on: boolean) => {
    commitPrefs({ aiFilterEnabled: on });
  };

  /* ---------------- X3 推送偏好 ---------------- */
  const handlePickPushFreq = (freq: PushFreq) => {
    commitPrefs({ pushFreq: freq });
  };

  const handlePickDndStart = (e: CommonEvent<PickerTimeProps.ChangeEventDetail>) => {
    commitPrefs({ dndStart: e.detail.value });
  };

  const handlePickDndEnd = (e: CommonEvent<PickerTimeProps.ChangeEventDetail>) => {
    commitPrefs({ dndEnd: e.detail.value });
  };

  const handleToggleModule = (key: (typeof PUSH_MODULES)[number], on: boolean) => {
    commitPrefs({ modules: { ...appPrefs.modules, [key]: on } });
  };

  /* ---------------- X11 未成年人模式（家长控制，辅助性质非安全凭据） ---------------- */
  const closePinOverlay = () => {
    setPinOverlay(null);
    setPinInput('');
  };

  /** 开启：未设密码先走设置弹层（弹层内数字键盘 Input）；已设密码直接开启。关闭：必须先校验密码 */
  const handleToggleMinorMode = (on: boolean) => {
    if (on) {
      if (appPrefs.parentPin) {
        commitPrefs({ minorMode: true });
      } else {
        setPinInput('');
        setPinOverlay({ mode: 'set' });
      }
    } else {
      setPinInput('');
      setPinOverlay({ mode: 'verify' });
    }
  };

  const handlePinSubmit = () => {
    const overlay = pinOverlay;
    if (!overlay) return;
    const pin = pinInput.trim();
    if (!/^\d{4}$/.test(pin)) {
      Taro.showToast({ title: '请输入 4 位数字密码', icon: 'none' });
      return;
    }
    if (overlay.mode === 'set') {
      // parentPin 仅用于家长控制的辅助校验，非安全凭据（本机存储可被清除）
      commitPrefs({ parentPin: pin, minorMode: true });
      Taro.showToast({ title: t('settings.parentPinSet'), icon: 'success' });
      closePinOverlay();
    } else {
      if (pin !== appPrefs.parentPin) {
        Taro.showToast({ title: '密码不正确，请重试', icon: 'none' });
        setPinInput('');
        return;
      }
      commitPrefs({ minorMode: false });
      Taro.showToast({ title: '已退出未成年人模式', icon: 'none' });
      closePinOverlay();
    }
  };

  /** 密码遗忘：重置入口，双重确认并诚实提示控制为辅助性质 */
  const handleResetParentPin = () => {
    Taro.showModal({
      title: t('settings.pinReset'),
      content: t('settings.pinResetConfirm'),
      cancelText: t('cancel'),
      confirmText: '继续',
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        Taro.showModal({
          title: '再次确认',
          content: '确定要重置家长密码吗？重置后未成年人模式将关闭。',
          cancelText: t('cancel'),
          confirmText: '确认重置',
          confirmColor: DANGER_COLOR,
          success: (res2) => {
            if (!res2.confirm) return;
            commitPrefs({ parentPin: '', minorMode: false });
            Taro.showToast({ title: '已重置', icon: 'none' });
          }
        });
      }
    });
  };

  const handleOpenPrivacyManage = () => {
    const openPrivacyContract = (Taro as unknown as { openPrivacyContract?: (opt?: Record<string, unknown>) => Promise<unknown> })
      .openPrivacyContract;
    if (isWeapp && typeof openPrivacyContract === 'function') {
      openPrivacyContract
        .call(Taro, {})
        .catch(() => Taro.showToast({ title: '请在微信「设置-隐私」中管理授权', icon: 'none' }));
    } else {
      Taro.showToast({ title: '微信端可管理隐私授权', icon: 'none' });
    }
  };

  /**
   * C-04 注销：我的（Tab）→ 账号与合规区块 → 账号注销行 → 弹窗内输入「注销」并确认 = 3 步。
   * 输入校验与确认合并在同一个 editable showModal 内，不新增层级。
   */
  /**
   * 退出登录（2026-10-15）。
   *
   * 与「注销账号」的分工（本条存在的全部理由）：
   *   · **登出** = 清掉云SDK 会话 + 本机的登录偏好，**保留全部业务数据**
   *     （日程/记账/购物清单/学习进度都在，换号登录后还在）；
   *   · **注销** = 不可逆，清本机 + 清云端 user_kv。
   * 此前只有后者，用户想换个账号只能注销，代价与意图严重不匹配。
   *
   * ⚠️ 清本机时**只删登录态相关键，不碰数据键**：
   *   一律用 removeStorageSync 精确删，而不是 Taro.clearStorageSync() ——
   *   后者会把记账、日程这些同步键一起清掉，用户重登后数据全没了，
   *   那就不是「退出登录」而是「注销账号」了。
   */
  const handleSignOut = () => {
    void (async () => {
      try {
        await signOut();
        // 清「下次自动登录」偏好：既然用户主动登出了，下次不该再被自动记住。
        // 反过来不清会让下次打开又被自动登录 —— 与「我刚退出了」的意图相反。
        try {
          Taro.removeStorageSync('sxm-remember-login');
        } catch {
          /* 存储不可用不影响登出本身 */
        }
        // 回到登录页：必须走 reLaunch 而非 navigateBack ——
        // 门禁在 App 层（app.tsx 的 useDidShow），留在栈里会显示一堆受保护页面。
        Taro.reLaunch({ url: '/pages/login/index' });
      } catch (err) {
        console.error('[MinePage] signOut failed:', err);
        Taro.showToast({ title: t('common.loadFailed'), icon: 'none' });
      }
    })();
  };

  const handleDeleteAccount = () => {
    setDeleteOpen(true);
  };

  /** 注销二次确认：必须逐字输入 DELETE_CONFIRM_WORD，H5 与小程序同一判据 */
  const confirmDeleteAccount = async (typed: string) => {
    // 旧实现在 showModal 拿不到 content（H5 的全部情况）时用 `: true` 兜底，
    // 等于 H5 上点一次确认就执行 kvClear + signOut + 清本机 —— 不可逆且无法挽回。
    // 现在没有兜底：内容不匹配一律拦下，弹窗保持打开让用户重输。
    if (typed.trim() !== DELETE_CONFIRM_WORD) {
      Taro.showToast({ title: t('mine.deleteInputMismatch'), icon: 'none' });
      return;
    }
    setDeleteOpen(false);
    // 删除成功后的收尾（清本机数据 → 完成提示 → 回首页），两端共用
    const finishDelete = () => {
      try {
        Taro.clearStorageSync();
      } catch (err) {
        console.error('[MinePage] clear storage failed:', err);
      }
      Taro.showToast({ title: t('mine.deleteDone'), icon: 'none' });
      setTimeout(() => Taro.reLaunch({ url: '/pages/briefing/index' }), 1200);
    };
    // C-04 注销分端语义（2026-10-08 修正 H5 死路，2026-10-15 修正数据保留）：
    //   · h5：没有微信上下文（deleteAccount 云函数只认 getWXContext().OPENID，必抛 no openid），
    //     故 H5 不再调那个注定失败的云函数 —— 但**不等于服务端没有数据可删**。
    //     2026-10-13 H5 迁移后，cloudSync 的 18 个 SYNC_KEYS（购物清单/日程/浏览历史/
    //     学习进度/AI 记忆/聊天记录/设置…）是真写进云数据库 user_kv 的，owner_id 由
    //     DEFAULT auth.uid() 填充。此前这里只登出 + 清本机，**云端那份原封不动留着**
    //     （cloudDb.kvClear 有定义、零调用点），用户以为注销了，数据还在。
    //     故 H5 的「注销」= 先清云端同步键 → 登出 → 清本机。
    //     ⚠️ 顺序不可换：kvClear 依赖会话身份（RLS 按 auth.uid() 过滤），
    //        先 signOut 会让删除请求被数据库侧拒绝，data 变成「登出但云端还在」。
    //   · weapp：保持原逻辑，调 deleteAccount 真删服务端数据。
    if (process.env.TARO_ENV === 'h5') {
      // 清云端同步键。失败**不阻断**注销（不能因为云端抖动把用户卡在注销页），
      // 但必须留痕 —— 静默失败会变成又一份「以为删了其实没删」的数据。
      kvClear()
        .then((n) => {
          if (n === null) {
            console.warn('[MinePage] kvClear returned null — 云端同步键可能未清除，需人工核查');
          } else {
            console.info('[MinePage] cloud user_kv cleared, rows =', n);
          }
        })
        .catch((err) => {
          console.error('[MinePage] kvClear failed:', err);
        })
        // 无论云端结果如何都继续：signOut 自身吞掉登出失败；
        // 即便登出异常也继续清本机数据并回到门禁
        .then(() => signOut())
        .then(finishDelete)
        .catch(finishDelete);
    } else {
      apiDeleteAccount()
        .then(finishDelete)
        .catch((err) => {
          console.error('[MinePage] deleteAccount failed:', err);
          Taro.showToast({ title: '注销失败，请稍后再试', icon: 'none' });
        });
    }
  };

  const handleContactService = () => {
    /** 复制 + 明确告知下一步；复制失败如实提示，不静默 */
    const copy = (data: string, okText: string) => {
      Taro.setClipboardData({ data })
        .then(() => Taro.showToast({ title: okText, icon: 'none', duration: 2400 }))
        .catch(() => Taro.showToast({ title: '复制失败，请手动记录', icon: 'none' }));
    };

    const showServiceInfo = () => {
      Taro.showModal({
        title: '客服服务时间',
        content: `每天 9:00–21:00\n邮箱：${SERVICE_EMAIL}\n微信公众号：${SERVICE_WECHAT}\n我们会在 15 个工作日内答复`,
        confirmText: '知道了',
        showCancel: false
      });
    };

    /**
     * 2026-10-24 升级：原实现只弹一段纯文本（邮箱不可点、不可复制），用户必须自己抄下来
     * 再离开 App —— 与协议承诺的「我的-联系客服」落差太大。现在给可执行动作。
     */
    const showContactActions = () => {
      Taro.showActionSheet({
        itemList: [`复制客服邮箱（${SERVICE_EMAIL}）`, `复制公众号名（${SERVICE_WECHAT}）`, '客服服务时间']
      })
        .then((res) => {
          if (res.tapIndex === 0) copy(SERVICE_EMAIL, '邮箱已复制，去邮件 App 发给我们');
          else if (res.tapIndex === 1) copy(SERVICE_WECHAT, '公众号名已复制，去微信搜索');
          else showServiceInfo();
        })
        // 用户取消：不打扰、不报错
        .catch(() => undefined);
    };

    // 仅在客服 ID 已真实配置时才调 openCustomerServiceChat；
    // TODO 占位时调用必然 fail 再回退（无意义的失败请求），直接给可执行的联系方式
    if (isWeapp && SERVICE_CORP_ID !== 'TODO_CORP_ID') {
      const openChat = (Taro as unknown as { openCustomerServiceChat?: (opt: Record<string, unknown>) => void })
        .openCustomerServiceChat;
      if (typeof openChat === 'function') {
        try {
          openChat({ corpId: SERVICE_CORP_ID, extInfo: { url: '' }, fail: showContactActions });
          return;
        } catch (err) {
          console.warn('[MinePage] openCustomerServiceChat failed:', err);
        }
      }
    }
    showContactActions();
  };

  const fbCopy = FEEDBACK_TEXT[lang];

  /**
   * 关闭反馈弹层：**不清草稿**。
   * 误触遮罩就丢掉刚打完的一段字，是最容易让人放弃反馈的那种细节。
   */
  const closeFeedback = () => setFbOpen(false);

  /**
   * 提交意见反馈。
   *
   * 诚实性铁律：只有云端真实落库（`apiSubmitFeedback` 返回 true）才可以说「已收到」。
   * 其余一切路径 —— H5 无 RPC 通道 / 云端写失败 / 抛错 —— 都走「复制全文 + 告知邮件入口」，
   * **不显示任何成功态**。把用户的投诉吞掉还回一句「提交成功」，比没有这个入口更糟。
   */
  const handleSubmitFeedback = async () => {
    if (fbSending) return;
    const content = fbContent.trim();
    const contact = fbContact.trim();
    if (!content) {
      Taro.showToast({ title: fbCopy.emptyHint, icon: 'none' });
      return;
    }
    setFbSending(true);
    let landed = false;
    try {
      landed = await apiSubmitFeedback({ type: fbType, content, contact, page: 'mine' });
    } catch (err) {
      console.error('[MinePage] submitFeedback failed:', err);
      landed = false;
    }
    setFbSending(false);
    if (landed) {
      setFbContent('');
      setFbContact('');
      setFbOpen(false);
      Taro.showToast({ title: fbCopy.success, icon: 'none', duration: 2600 });
      return;
    }
    // 未落库：复制成可直接粘贴的邮件正文，明确告诉用户下一步
    const typeLabel = (FEEDBACK_TYPES.find((o) => o.id === fbType) || FEEDBACK_TYPES[0])[lang];
    const mailBody = `${fbCopy.title} · ${typeLabel}\n\n${content}${contact ? `\n\n${fbCopy.contactLabel}: ${contact}` : ''}`;
    let copied = false;
    try {
      await Taro.setClipboardData({ data: mailBody });
      copied = true;
    } catch (err) {
      console.error('[MinePage] copy feedback failed:', err);
    }
    Taro.showModal({
      title: copied ? fbCopy.copiedTitle : fbCopy.copyFailedTitle,
      content: `${copied ? fbCopy.copiedBody : fbCopy.copyFailedBody}\n\n${SERVICE_EMAIL}`,
      confirmText: lang === 'zh' ? '知道了' : 'Got it',
      showCancel: false
    });
  };

  const cityCopy = CITY_TEXT[lang];
  /** 未设置时如实标注「默认」—— 别让用户以为定位成功过 */
  const cityLabel = city || cityCopy.defaultTag;

  const openCityEditor = () => {
    setCityDraft(city);
    setCityOpen(true);
  };

  /**
   * 保存天气城市。
   *
   * 关键点：存的是 **Open-Meteo 回传的规范地名**，不是用户原文。
   * 先校验再落库 —— 「已保存」必须意味着「下游 geocode 一定能解析出这个城市」，
   * 否则用户会得到一条看起来成功、实际天气还是错的消息。
   */
  const handleSaveCity = async () => {
    if (cityChecking) return;
    const name = cityDraft.trim();
    if (!name) {
      Taro.showToast({ title: cityCopy.empty, icon: 'none' });
      return;
    }
    setCityChecking(true);
    let canonical: string | null = null;
    try {
      canonical = await resolveCityName(name);
    } catch (err) {
      console.error('[MinePage] resolveCity failed:', err);
      canonical = null;
    }
    setCityChecking(false);
    if (!canonical) {
      Taro.showToast({ title: cityCopy.notFound, icon: 'none', duration: 2400 });
      return;
    }
    try {
      Taro.setStorageSync('user-city', canonical);
    } catch (err) {
      // 写盘失败不能报成功：提示重试，并保持弹层打开（草稿还在）
      console.error('[MinePage] save city failed:', err);
      Taro.showToast({ title: cityCopy.saveFailed, icon: 'none' });
      return;
    }
    setCity(canonical);
    setCityOpen(false);
    Taro.showToast({ title: `${cityCopy.savedPrefix}：${canonical}`, icon: 'none', duration: 2200 });
  };

  const renderRow = (label: string, valueNode: React.ReactNode, onClick?: () => void) => (
    <View className={styles.row} onClick={onClick}>
      <Text className={styles.rowLabel}>{label}</Text>
      <View className={styles.rowValue}>{valueNode}</View>
    </View>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {/* 云端不可用、已回退本地/演示实现时如实提示（诚实性，来源 briefing.degraded） */}
      <DemoDataHint />
      {/* 跨设备同步冲突（本机未上传的修改 vs 云端较新版本）：未裁决前挂着，不静默丢数据 */}
      <SyncConflictHint />
      <View className={styles.userCard}>
        <Button className={styles.avatarBtn} onClick={handleAvatarTap}>
          <View className={styles.avatar}>
            {avatar ? (
              isEmojiAvatar(avatar) ? (
                <Text className={styles.avatarText}>{avatar}</Text>
              ) : (
                // 无障碍（2026-10-12）：头像给**有意义的 alt**（此前是空 alt + aria-hidden，按纯装饰处理）。
                // 理由：头像是「我是谁」的身份图像，给出名字比留白更有用；外层按钮的「点头像」文字
                // 表达的是**动作**，不能替代头像自身的含义。
                // Taro 的 Image 没有 alt 属性，H5 端唯一能透传到真实 <img> 的入口是 nativeProps
                // （见 @tarojs/components/dist/esm/image-*.js 的 render：h("img", {...nativeProps})），
                // 且 nativeProps 仅 h5 支持，故只在 H5 端传。
                <Image
                  className={styles.avatarImg}
                  src={avatar}
                  mode='aspectFill'
                  nativeProps={isH5 ? { alt: t('mine.avatarAlt') } : undefined}
                />
              )
            ) : (
              <Text className={styles.avatarText}>🌅</Text>
            )}
          </View>
          <Text className={styles.avatarEdit}>{t('mine.avatarEdit')}</Text>
        </Button>
        <View className={styles.userBody}>
          {/* ⚠️ 不要在这里给"占位昵称"（原为 `|| '晨友'`）。档案取不到时（会话失效 / init 失败）
              显示一个名字，等于让用户以为"登录好了"—— 这正是本轮在修的"假身份"问题本身。
              空串只是没有名字，不是错误声明。（`07:30` 那处不同：那是应用的默认值，不是身份。） */}
          <Text className={styles.nickname}>{profile?.nickname || ''}</Text>
          <Text className={styles.userMeta}>
            {profile?.subscribed && profile?.expiredAt
              ? `订阅至 ${profile.expiredAt.slice(0, 10)}`
              : t('mine.freeUser')}
          </Text>
        </View>
        {profile?.subscribed ? (
          <View className={styles.subBadge}>
            <Text className={styles.subBadgeText}>
              {profile.isEarlyBird ? t('mine.earlyBirdBadge') : t('mine.memberBadge')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* ===== 订阅区（B-01 锁价文案 / B-02 涨价通知 / 三通道支付） ===== */}
      <View className={styles.subCard}>
        <Text className={styles.subTitle}>{t('mine.subTitle')}</Text>
        <Text className={styles.subDesc}>{t('mine.subDesc')}</Text>
        {profile?.subscribed ? (
          <Text className={styles.subscribedUntil}>
            {t('mine.subscribedUntil', { date: (profile.expiredAt || '').slice(0, 10) })}
          </Text>
        ) : null}

        {/* ①-b 续费管理（2026-10-24）：到期倒计时 + 到期后会怎样 + 提醒开关。
            只在**有订阅**时出现 —— 没订阅过的用户看到"到期提醒"只会困惑。 */}
        {renewal.status !== 'none' ? (
          <View className={styles.renewBlock}>
            <View className={styles.renewHead}>
              <Text className={styles.renewTitle}>{t('mine.renewMgmtTitle')}</Text>
              <View className={renewal.status === 'active' ? styles.renewTagIdle : styles.renewTag}>
                <Text className={renewal.status === 'active' ? styles.renewTagTextIdle : styles.renewTagText}>
                  {renewalStatusText}
                </Text>
              </View>
            </View>
            <Text className={styles.renewUntil}>{t('mine.renewUntil', { date: renewal.expiredAt })}</Text>
            {renewal.status === 'active' ? null : (
              <Text className={styles.renewWarn}>
                {renewal.status === 'expired' ? t('mine.renewWarnExpired') : t('mine.renewWarnExpiring')}
              </Text>
            )}
            <View className={styles.renewSwitchRow}>
              <Text className={styles.renewSwitchLabel}>{t('mine.renewRemind')}</Text>
              <Switch
                className={styles.renewSwitch}
                checked={remindOn}
                color='#ffd24a'
                onChange={(e) => handleToggleRemind(!!e.detail.value)}
              />
            </View>
            {/* 明确写出"不自动续费"：否则用户会默认以为到期自动扣款，反而不敢开提醒 */}
            <Text className={styles.renewNote}>{t('mine.renewNoAuto')}</Text>
          </View>
        ) : null}

        {/* ① 方案卡片横排（替换原 Picker） */}
        <View className={styles.planList}>
          {PLAN_LIST.map((p) => {
            const active = p.id === planId;
            const isEarlyBird = p.id === 'earlybird_monthly';
            const priceYuan = EARLYBIRD_PRICE[p.id] / 100;
            return (
              <View
                key={p.id}
                className={classnames(
                  styles.planCard,
                  active && styles.planCardActive,
                  isEarlyBird && styles.planCardEarlyBird
                )}
                onClick={() => setPlanId(p.id)}
              >
                {isEarlyBird ? <Text className={styles.planBadge}>{t('mine.planEarlyBirdTag')}</Text> : null}
                <Text className={styles.planLabel}>{t(PLAN_LABEL_KEY[p.id])}</Text>
                <Text className={styles.planPrice}>
                  ¥{priceYuan}
                  <Text className={styles.planUnit}>
                    {p.id === 'yearly' ? t('mine.planPerYear') : t('mine.planPerMonth')}
                  </Text>
                </Text>
              </View>
            );
          })}
        </View>

        {/* ② 锁价文案常驻（B-01：价格下方、支付按钮上方） */}
        <View className={styles.lockBlock}>
          <View className={styles.lockHead}>
            <Text className={styles.lockTitle}>{t('mine.lockTitle')}</Text>
            {locked && locked.active ? <Text className={styles.lockPrice}>{formatPrice(locked.price)}</Text> : null}
          </View>
          <Text className={styles.lockBody}>{t('mine.lockBody')}</Text>
          <Text className={styles.lockLose}>{t('mine.lockLose')}</Text>
        </View>

        {/* ③ 支付按钮 + 通道提示 */}
        <View className={styles.subButtonRow}>
          <View className={styles.subButtonGroup}>
            <Button className={styles.subButton} onClick={handleSubscribe} loading={paying} disabled={disabledAttr(paying)}>
              {paying
                ? t('mine.subscribing')
                : profile?.subscribed
                  ? t('mine.renew')
                  : t('mine.subscribe')}
            </Button>
            {currentPayChannel ? (
              <View className={styles.channelTag}>
                <Text className={styles.channelIcon}>{channelIconMap[currentPayChannel]}</Text>
                <Text className={styles.channelText}>{t(channelLabelKey[currentPayChannel])}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* ===== 订阅记录 ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.ordersTitle')}</Text>
        {ordersLoading && orders.length === 0 ? (
          <Text className={styles.orderLoading}>…</Text>
        ) : ordersError && orders.length === 0 ? (
          /* 查询失败与「真的没有记录」必须分开：老写法把两者都渲染成 ordersEmpty，
             已付费用户查不到订单时会看到「暂无订阅记录」——这是把故障伪装成空态。
             20 款 App 调研的共同结论：错误态三要素 = 发生了什么 + 为什么 + 怎么办。 */
          <View className={styles.orderErrorBox}>
            <Text className={styles.orderErrorText}>{t('mine.ordersError')}</Text>
            <Text className={styles.orderRetry} onClick={() => void loadOrders()}>
              {t('common.retry')}
            </Text>
          </View>
        ) : orders.length === 0 ? (
          <Text className={styles.orderEmpty}>{t('mine.ordersEmpty')}</Text>
        ) : (
          <ScrollView scrollY className={styles.orderList}>
            {orders.map((o) => {
              // channel 是云函数返回的不可信输入：空串时 o.channel[0] 为 undefined，
              // .toUpperCase() 直接抛错整页崩（2026-10-24 审计）。空值/未知值
              // 都回落到原始串展示，绝不让一条脏数据带崩整个订阅记录列表。
              const ch = String(o.channel || '');
              const channelLabel = ch
                ? t(`mine.orderChannel${ch[0].toUpperCase()}${ch.slice(1)}` as LangKey)
                : o.channel || '—';
              const statusLabel = getOrderStatusLabel(o.status, o.refundStatus);
              const statusColor = getOrderStatusColor(o.status, o.refundStatus);
              const canRefund = o.status === 'paid' && o.refundStatus !== 'refunded' && o.refundStatus !== 'refunding';
              const date = o.createTime ? new Date(o.createTime).toISOString().slice(0, 10) : '';
              return (
                <View className={styles.orderItem} key={o.orderId}>
                  <View className={styles.orderHead}>
                    <Text className={styles.orderChannelTag}>
                      {channelIconMap[o.channel]} {channelLabel}
                    </Text>
                    <Text className={styles.orderStatus} style={{ color: statusColor }}>{statusLabel}</Text>
                  </View>
                  <View className={styles.orderBody}>
                    <Text className={styles.orderPlan}>{PLAN_LABEL_KEY[o.planId as PayOrder['planId']] ? t(PLAN_LABEL_KEY[o.planId as PayOrder['planId']]) : o.planId}</Text>
                    <Text className={styles.orderPrice}>¥{o.price} · {t('mine.orderMonths', { n: o.months })}</Text>
                  </View>
                  <View className={styles.orderFoot}>
                    <Text className={styles.orderDate}>{date}</Text>
                    {canRefund ? (
                      <Text
                        className={styles.orderRefundBtn}
                        onClick={() => handleRefund(o.orderId, o.channel)}
                      >
                        {t('mine.refundBtn')}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* B-02：调价站内信（本轮不发生实际调价，仅在有通知时渲染） */}
      {unreadNotices.length > 0 ? (
        <View className={styles.card}>
          {unreadNotices.map((notice) => (
            <View className={styles.noticeItem} key={notice.id}>
              <Text className={styles.noticeTitle}>{t(notice.titleKey)}</Text>
              <Text className={styles.noticeBody}>{t(notice.bodyKey, notice.params)}</Text>
              <View className={styles.noticeActions}>
                <Text className={styles.linkText} onClick={() => handleReadNotice(notice.id)}>
                  {t('mine.docRead')}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View className={styles.quotaCard}>
        <Text className={styles.quotaTitle}>{t('mine.quotaTitle')}</Text>
        <View className={styles.quotaRow}>
          <View className={styles.quotaHead}>
            <Text className={styles.quotaLabel}>{t('mine.quotaVoice')}</Text>
            <Text className={styles.quotaValue}>
              {usage ? (usage.voiceQuota < 0 ? t('mine.unlimited') : `${usage.voiceUsed}/${usage.voiceQuota}${lang === 'zh' ? ' 条' : ''}`) : '…'}
            </Text>
          </View>
          <View className={styles.bar}>
            <View
              className={voicePercent >= 90 ? styles.barFillWarning : styles.barFill}
              style={{ width: `${voicePercent}%` }}
            />
          </View>
        </View>
        <View className={styles.quotaRow}>
          <View className={styles.quotaHead}>
            <Text className={styles.quotaLabel}>{t('mine.quotaFav')}</Text>
            <Text className={styles.quotaValue}>
              {usage
                ? usage.collectionQuota < 0
                  ? t('mine.unlimited')
                  : `${usage.collectionCount}/${usage.collectionQuota}${lang === 'zh' ? ' 条' : ''}`
                : '…'}
            </Text>
          </View>
          <View className={styles.bar}>
            <View
              className={collectionPercent >= 90 ? styles.barFillWarning : styles.barFill}
              style={{ width: `${collectionPercent}%` }}
            />
          </View>
        </View>
        {/* 功能记账（2026-10-24）：额度条只说明"还剩多少"，这里说明"用在哪"。
            数据来自 utils/usageLog.ts（按天聚合、只记真实调用）。 */}
        <View className={styles.usageBlock}>
          <View className={styles.usageHead}>
            <Text className={styles.usageTitle}>{t('mine.usageTitle')}</Text>
            <Text className={styles.usageRange}>{t('mine.usageWeek')}</Text>
          </View>
          {usageSummary === null ? (
            <Text className={styles.usageEmpty}>…</Text>
          ) : usageSummary.weekTotal === 0 ? (
            <Text className={styles.usageEmpty}>{t('mine.usageEmpty')}</Text>
          ) : (
            <View className={styles.usageList}>
              {FEATURES.map((f) => (
                <View className={styles.usageItem} key={f}>
                  <Text className={styles.usageName}>{t(FEATURE_LABEL_KEY[f])}</Text>
                  <Text className={styles.usageNum}>
                    {usageSummary.week[f]}
                    <Text className={styles.usageToday}>
                      {` · ${t('mine.usageToday')} ${usageSummary.today[f]}`}
                    </Text>
                  </Text>
                </View>
              ))}
            </View>
          )}
          <Text className={styles.usageNote}>{t('mine.usageNote')}</Text>
        </View>
      </View>

      {/* v2.1：晨报连续阅读（只读展示 + 清空入口；主 streak 已改挂晨报） */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.readStreakTitle')}</Text>
        {renderRow(
          t('readStreak.hint'),
          <>
            <Text className={styles.valueText}>{t('mine.readStreakValue', { n: readStreak })}</Text>
            {readFreezeCards > 0 ? (
              <Text className={styles.valueHint}>{t('readStreak.cardLabel', { n: readFreezeCards })}</Text>
            ) : null}
          </>
        )}
        {readStreak > 0 || readFreezeCards > 0 ? (
          <View className={styles.memoryActions}>
            <Text className={styles.dangerText} onClick={handleClearReadStreak}>
              {t('readStreak.clearTitle')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* v2.1 习惯守护：习惯列表 + 自动守护开关（默认关闭）+ 撤销窗口内一键还原 */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.habitSection')}</Text>
        <Text className={styles.habitHint}>{t('habit.sectionHint')}</Text>
        {habits.length > 0 ? (
          habits.map((habit) => (
            <View className={styles.row} key={habit.id}>
              <View className={styles.rowMain}>
                <Text className={styles.rowLabel}>{habit.title}</Text>
                <Text className={styles.valueHint}>
                  {habit.preferredStart} · {t('habit.durationLabel', { n: habit.durationMinutes })}
                </Text>
              </View>
              <Switch
                checked={habit.autoGuard}
                color={theme.color}
                onChange={(e) => handleToggleHabitGuard(habit.id, e.detail.value)}
              />
              <Text className={styles.memoryDelete} onClick={() => handleRemoveHabit(habit)}>
                {t('habit.removeConfirm')}
              </Text>
            </View>
          ))
        ) : (
          <Text className={styles.memoryEmpty}>{t('habit.none')}</Text>
        )}
        {/* 风险提示：自动守护默认关闭，开启即用户显式授权 */}
        <View className={styles.noticeBar}>
          <Text className={styles.noticeBarText}>{t('habit.autoGuardRisk')}</Text>
        </View>
        {/* 守护记录：仅在撤销窗口内展示，可一键还原到原时段 */}
        {guardRecords.length > 0 ? (
          <View className={styles.subSection}>
            <Text className={styles.subSectionTitle}>{t('habit.history')}</Text>
            {guardRecords.map((rec) => (
              <View className={styles.blockItem} key={rec.id}>
                <Text className={styles.blockValue}>
                  {t('habit.guardBarText', { title: rec.title, time: rec.toTime.slice(-5) })}
                </Text>
                <Text className={styles.linkText} onClick={() => handleRestoreGuardRecord(rec)}>
                  {t('habit.restore')}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* v2.1 习惯守护站内信（独立 mb_habit_notices，仅展示未读） */}
      {unreadHabitNotices.length > 0 ? (
        <View className={styles.card}>
          {unreadHabitNotices.map((notice) => (
            <View className={styles.noticeItem} key={notice.id}>
              <Text className={styles.noticeTitle}>{t(notice.titleKey)}</Text>
              <Text className={styles.noticeBody}>{t(notice.bodyKey, notice.params)}</Text>
              <View className={styles.noticeActions}>
                <Text className={styles.linkText} onClick={() => handleReadHabitNotice(notice.id)}>
                  {t('mine.docRead')}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* 近期动态：最新 3 条日志（v2.0） */}
      <View className={styles.logCard}>
        <Text className={styles.logTitle}>{t('mine.recent')}</Text>
        {logs.length > 0 ? (
          logs.map((log) => (
            <View className={styles.logRow} key={log.id}>
              <Text className={styles.logIcon}>{log.icon}</Text>
              <Text className={styles.logText}>{log.text}</Text>
              <Text className={styles.logTime}>{fromNow(log.time)}</Text>
            </View>
          ))
        ) : (
          <Text className={styles.logEmpty}>
            {t('mine.recentEmpty')}
          </Text>
        )}
      </View>

      {/* ===== 设置项（自独立设置页合并：通用 / AI 个性化 / 外观 / 账号与合规） ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingGeneral')}</Text>
        {renderRow(
          t('mine.nickname'),
          <Input
            className={styles.input}
            value={nickname}
            maxlength={12}
            placeholder={t('mine.nicknamePlaceholder')}
            onInput={(e) => setNickname(e.detail.value)}
            onBlur={handleBlurNickname}
          />
        )}
        <Picker mode='time' value={profile?.briefingTime || '07:30'} onChange={handleChangeTime}>
          {renderRow(
            t('mine.briefingTime'),
            <>
              <Text className={styles.valueText}>{profile?.briefingTime || '07:30'}</Text>
              <Text className={styles.arrow}>›</Text>
            </>
          )}
        </Picker>
        {renderRow(
          t('mine.briefingRemind'),
          <Switch
            checked={custom.morningReminderEnabled}
            color={theme.color}
            onChange={(e) => persistCustom({ morningReminderEnabled: e.detail.value })}
          />
        )}
        {/* 天气城市（2026-10-24）：手动兜底，见 CITY_TEXT 注释 —— 拒绝定位不再等于「永远是北京」。
            文案复用既有的 sync.key.user-city（'所在城市' / 'City'），不新增 i18n 键。 */}
        {renderRow(
          t('sync.key.user-city'),
          <>
            <Text className={styles.valueText}>{cityLabel}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          openCityEditor
        )}
        {/* V-05 语速三档（取值来自 utils/tts.ts 的 TTS_RATE_OPTIONS） */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('tts.rateLabel')}</Text>
          <View className={styles.scaleList}>
            {TTS_RATE_OPTIONS.map((opt) => (
              <View
                key={opt.id}
                className={classnames(styles.scaleChip, ttsPrefs.rate === opt.rate && styles.scaleChipActive)}
                onClick={() => handlePickRate(opt.rate)}
              >
                <Text className={classnames(styles.scaleText, ttsPrefs.rate === opt.rate && styles.scaleTextActive)}>
                  {t(TTS_RATE_LABEL[opt.id])}
                </Text>
              </View>
            ))}
          </View>
        </View>
        {/* V-07 音色策略：跟随场景 / 固定音色 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('tts.voiceLabel')}</Text>
          <View className={styles.scaleList}>
            {TTS_VOICE_MODES.map((mode) => (
              <View
                key={mode.id}
                className={classnames(styles.scaleChip, ttsPrefs.voiceMode === mode.id && styles.scaleChipActive)}
                onClick={() => handlePickVoiceMode(mode.id)}
              >
                <Text
                  className={classnames(styles.scaleText, ttsPrefs.voiceMode === mode.id && styles.scaleTextActive)}
                >
                  {t(mode.labelKey)}
                </Text>
              </View>
            ))}
          </View>
        </View>
        {/* 微信端同声传译插件无 rate/pitch 参数（PRD Q2 已知限制），显式标注 */}
        {isWeapp ? <Text className={styles.platformHint}>{t('perm.platformUnsupported')}</Text> : null}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAi')}</Text>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.prefTags')}</Text>
          <Text className={styles.valueHint}>{t('mine.prefMax')}</Text>
        </View>
        <View className={styles.tagList}>
          {PREF_TAGS.map((tag) => (
            <View
              key={tag}
              className={classnames(styles.tag, prefs.includes(tag) && styles.tagActive)}
              onClick={() => handleTogglePref(tag)}
            >
              <Text className={classnames(styles.tagText, prefs.includes(tag) && styles.tagTextActive)}>
                {t(PREF_TAG_LABEL[tag] || '')}
              </Text>
            </View>
          ))}
        </View>
        <Picker
          mode='selector'
          range={REPLY_STYLES.map((s) => t(REPLY_STYLE_LABEL[s]))}
          value={REPLY_STYLES.indexOf(custom.replyStyle)}
          onChange={handleReplyStyle}
        >
          {renderRow(
            t('mine.replyStyle'),
            <>
              <Text className={styles.valueText}>{t(REPLY_STYLE_LABEL[custom.replyStyle] || '')}</Text>
              <Text className={styles.arrow}>›</Text>
            </>
          )}
        </Picker>

        {/* ===== M-01 / M-02 记忆管理三入口 ===== */}
        <View className={styles.memoryBlock}>
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('mine.aiMemory')}</Text>
            <Text className={styles.valueText}>{memorySummary}</Text>
          </View>
          {/* M-01 说明条：常驻，明示「开关 ≠ 删除」 */}
          <View className={styles.noticeBar}>
            <Text className={styles.noticeBarText}>{t('mine.memoryNotice')}</Text>
          </View>
          {/* ③ 全局开关：关闭后 AI 不再读写，已有条目保留 */}
          <View className={styles.row}>
            <View className={styles.rowMain}>
              <Text className={styles.rowLabel}>{t('mine.memorySwitch')}</Text>
              <Text className={styles.valueHint}>{t('mine.memorySwitchHint')}</Text>
            </View>
            <Switch
              checked={memory.enabled}
              color={theme.color}
              onChange={(e) => handleToggleMemory(e.detail.value)}
            />
          </View>
          {/* ① 逐条删除：每条右侧红色文字按钮（与开关间距 ≥12px，见 scss .memoryList） */}
          {memory.items.length > 0 ? (
            <View className={styles.memoryList}>
              {memory.items.map((item) => (
                <View className={styles.memoryItem} key={item.id}>
                  <View className={styles.memoryMain}>
                    <Text className={styles.memoryText}>{item.content}</Text>
                    {/* P1-E 溯源次行：时间 + 来源短语；旧数据缺字段时兜底「—」 */}
                    <Text className={styles.memoryMeta}>
                      {memoryItemMeta(item)}
                    </Text>
                  </View>
                  <Text className={styles.memoryDelete} onClick={() => handleDeleteMemoryItem(item)}>
                    {t('mine.memoryItemDelete')}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text className={styles.memoryEmpty}>{t('mine.memoryEmpty')}</Text>
          )}
          {/* ② 清空全部记忆 */}
          <View className={styles.memoryActions}>
            <Text className={styles.dangerText} onClick={handleClearMemory}>
              {t('mine.memoryClearTitle')}
            </Text>
          </View>
          {/* L4 记忆隐私声明：合规要求逐字展示键值，纯声明不可交互 */}
          <Text className={styles.memoryPrivacy}>{t('settings.memoryPrivacy')}</Text>
        </View>
        {renderRow(
          t('mine.hotNews'),
          <Switch
            checked={custom.newsEnabled}
            color={theme.color}
            onChange={(e) => persistCustom({ newsEnabled: e.detail.value })}
          />
        )}
        {/* C-03 个性化推荐开关（与热点页右上角入口共享 mb_personalization） */}
        <View className={styles.row}>
          <View className={styles.rowMain}>
            <Text className={styles.rowLabel}>{t('mine.personalLabel')}</Text>
            <Text className={styles.valueHint}>{t('mine.personalHint')}</Text>
          </View>
          <Switch checked={personalOn} color={theme.color} onChange={(e) => handleTogglePersonal(e.detail.value)} />
        </View>
        {/* L2 AI 精选开关：与资讯页共享 mb-prefs，变更即时落盘实时生效 */}
        <View className={styles.row}>
          <View className={styles.rowMain}>
            <Text className={styles.rowLabel}>{t('settings.aiFilter')}</Text>
            <Text className={styles.valueHint}>{t('settings.aiFilterDesc')}</Text>
          </View>
          <Switch
            checked={appPrefs.aiFilterEnabled}
            color={theme.color}
            onChange={(e) => handleToggleAiFilter(e.detail.value)}
          />
        </View>
        {/* N-03 资讯偏好：已屏蔽的来源 / 标签，逐条可恢复 */}
        <View className={styles.subSection}>
          <Text className={styles.subSectionTitle}>{t('library.blockSection')}</Text>
          {blocks.map((rule) => (
            <View className={styles.blockItem} key={rule.id}>
              <Text className={styles.blockDim}>{t(BLOCK_DIMENSION_LABEL[rule.dimension])}</Text>
              <Text className={styles.blockValue}>{rule.value}</Text>
              <Text className={styles.linkText} onClick={() => handleRestoreBlock(rule)}>
                {t('library.blockRestore')}
              </Text>
            </View>
          ))}
          {/* 空态：屏蔽清单为空时给出占位文案，避免整块空白被误认为加载失败 */}
          {blocks.length === 0 ? (
            <Text className={styles.valueHint}>{t('mine.blockEmpty')}</Text>
          ) : null}
          {blocks.length > 0 ? (
            <View className={styles.memoryActions}>
              <Text className={styles.dangerText} onClick={handleClearBlocks}>
                {t('library.blockClear')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* ===== 竞品分析 X3 / X6：推送偏好（数量三档 / 免打扰 / 模块开关 / 周末设置） ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('settings.push')}</Text>
        {/* ① 推送数量三档 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('settings.pushFreq')}</Text>
          <View className={styles.scaleList}>
            {PUSH_FREQ_OPTIONS.map((opt) => (
              <View
                key={opt.id}
                className={classnames(styles.scaleChip, appPrefs.pushFreq === opt.id && styles.scaleChipActive)}
                onClick={() => handlePickPushFreq(opt.id)}
              >
                <Text
                  className={classnames(styles.scaleText, appPrefs.pushFreq === opt.id && styles.scaleTextActive)}
                >
                  {t(opt.labelKey)}
                </Text>
              </View>
            ))}
          </View>
        </View>
        {/* ② 免打扰时段：起 / 止两个 time picker（跨零点由 isInDnd 处理） */}
        <View className={styles.row}>
          <View className={styles.rowMain}>
            <Text className={styles.rowLabel}>{t('settings.dnd')}</Text>
            {dndActive ? <Text className={styles.valueHint}>{t('settings.dndActive')}</Text> : null}
          </View>
          <View className={styles.scaleList}>
            <Picker mode='time' value={appPrefs.dndStart} onChange={handlePickDndStart}>
              <View className={styles.scaleChip}>
                <Text className={styles.scaleText}>{appPrefs.dndStart}</Text>
              </View>
            </Picker>
            <Text className={styles.dndSep}>–</Text>
            <Picker mode='time' value={appPrefs.dndEnd} onChange={handlePickDndEnd}>
              <View className={styles.scaleChip}>
                <Text className={styles.scaleText}>{appPrefs.dndEnd}</Text>
              </View>
            </Picker>
          </View>
        </View>
        {/* ③ 四个模块开关 */}
        {PUSH_MODULES.map((key) => (
          <View className={styles.row} key={key}>
            <Text className={styles.rowLabel}>{t(PUSH_MODULE_LABEL[key])}</Text>
            <Switch
              checked={appPrefs.modules[key]}
              color={theme.color}
              onChange={(e) => handleToggleModule(key, e.detail.value)}
            />
          </View>
        ))}
        {/* ④ 周末免打扰 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('settings.weekendQuiet')}</Text>
          <Switch
            checked={appPrefs.weekendQuiet}
            color={theme.color}
            onChange={(e) => commitPrefs({ weekendQuiet: e.detail.value })}
          />
        </View>
        {/* X6 周末轻量版 */}
        <View className={styles.row}>
          <View className={styles.rowMain}>
            <Text className={styles.rowLabel}>{t('settings.weekendEdition')}</Text>
            <Text className={styles.valueHint}>{t('settings.weekendEditionDesc')}</Text>
          </View>
          <Switch
            checked={appPrefs.weekendEdition}
            color={theme.color}
            onChange={(e) => commitPrefs({ weekendEdition: e.detail.value })}
          />
        </View>
      </View>

      {/* ===== 竞品分析 X11：未成年人模式（设置侧，家长控制为辅助性质非安全凭据） ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('settings.minorMode')}</Text>
        <View className={styles.row}>
          <View className={styles.rowMain}>
            <Text className={styles.rowLabel}>{t('settings.minorMode')}</Text>
            <Text className={styles.valueHint}>{t('settings.minorModeDesc')}</Text>
          </View>
          <Switch
            checked={appPrefs.minorMode}
            color={theme.color}
            onChange={(e) => handleToggleMinorMode(e.detail.value)}
          />
        </View>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('settings.parentPin')}</Text>
          <Text className={styles.valueText}>{appPrefs.parentPin ? t('settings.parentPinSet') : '未设置'}</Text>
        </View>
        {appPrefs.parentPin ? (
          <View className={styles.memoryActions}>
            <Text className={styles.dangerText} onClick={handleResetParentPin}>
              {t('settings.pinReset')}
            </Text>
          </View>
        ) : null}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAppearance')}</Text>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.uiColor')}</Text>
          <View className={styles.swatchList}>
            {THEME_PRESETS.map((preset) => (
              <View
                key={preset.id}
                className={classnames(styles.swatch, theme.id === preset.id && styles.swatchActive)}
                style={{ background: preset.color }}
                onClick={() => setTheme(preset.id)}
              >
                {theme.id === preset.id ? <Text className={styles.swatchCheck}>✓</Text> : null}
              </View>
            ))}
          </View>
        </View>
        {/* 界面大小：H5 端通过 --ui-scale 调节 rem 基准，即时生效（weapp 端 rpx 字号暂不支持全局缩放） */}
        {isH5 ? (
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('mine.uiSize')}</Text>
            <View className={styles.scaleList}>
              {UI_SCALE_PRESETS.map((p) => (
                <View
                  key={p.id}
                  className={classnames(styles.scaleChip, scaleId === p.id && styles.scaleChipActive)}
                  onClick={() => setScale(p.id)}
                >
                  <Text className={classnames(styles.scaleText, scaleId === p.id && styles.scaleTextActive)}>
                    {t(UI_SCALE_LABEL[p.id])}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {/* 语言切换：中 / EN，全局即时生效 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.uiLang')}</Text>
          <View className={styles.scaleList}>
            {LANG_OPTIONS.map((opt) => (
              <View
                key={opt.id}
                className={classnames(styles.scaleChip, lang === opt.id && styles.scaleChipActive)}
                onClick={() => setLang(opt.id)}
              >
                <Text className={classnames(styles.scaleText, lang === opt.id && styles.scaleTextActive)}>
                  {opt.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* 账号与合规（F18 提审硬门槛） */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAccount')}</Text>
        {renderRow(
          t('mine.terms'),
          <Text className={styles.arrow} onClick={() => setDocView('terms')}>
            ›
          </Text>,
          () => setDocView('terms')
        )}
        {renderRow(
          t('mine.privacy'),
          <Text className={styles.arrow} onClick={() => setDocView('privacy')}>
            ›
          </Text>,
          () => setDocView('privacy')
        )}
        {renderRow(
          t('mine.aiNotice'),
          <Text className={styles.arrow} onClick={() => setDocView('ai')}>
            ›
          </Text>,
          () => setDocView('ai')
        )}
        {renderRow(
          t('mine.privacyManage'),
          <>
            <Text className={styles.valueText}>{t('mine.manageAuth')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          handleOpenPrivacyManage
        )}
        {/* P0-2 合规可见性：只读展示 AI 标识说明与标识规范版本（法规强制，无开关） */}
        {renderRow(
          t('ai.metaHint'),
          <Text className={styles.valueText}>{t('ai.labelVersion', { version: AI_LABEL_VERSION })}</Text>
        )}
        {/* 投诉/建议通道（2026-10-24 升级）：
            原来这行只弹一个 showActionSheet（复制邮箱 / 复制公众号）—— 用户想「反映问题」得先
            自己抄联系方式、离开 App、再写邮件，等于把投诉推给了用户的耐心。现在主路径是
            页内表单直接提交；人工联系降为表单底部的次级入口（handleContactService）。
            整行可点（不只是右侧小字），热区 ≥44px。 */}
        {renderRow(
          t('mine.service'),
          <>
            <Text className={styles.linkText}>{t('mine.feedback')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          () => setFbOpen(true)
        )}
        {/* C-04：注销不可逆提示 + 15 个工作日处理时限（页内明示） */}
        <Text className={styles.deleteWarn}>{t('mine.deleteWarn')}</Text>
        {renderRow(
          t('mine.deleteAccount'),
          <>
            <Text className={styles.dangerText}>{t('mine.deleteData')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          handleDeleteAccount
        )}
      </View>

      {/* 退出登录（2026-10-15）：与「注销账号」严格分开的两件事。
          此前**只有注销、没有登出** —— 用户想只是退出登录（换账号、把设备给别人），
          唯一的出口是「注销账号」，那会连带清空本机数据与云端同步键，代价过大。
          独立成条后：登出 = 清会话、留数据；注销 = 清数据、不可逆。
          放在「其他入口」之前、注销区块之后，保持「危险度递减」的阅读顺序。 */}
      <View className={styles.settingCard}>
        {renderRow(t('mine.signOut'), <Text>{t('mine.signOutHint')}</Text>, handleSignOut)}
      </View>

      {/* 其他入口 */}
      <View className={styles.settingCard}>
        <View className={styles.settingRow} onClick={() => Taro.navigateTo({ url: '/pages/learn/index' })}>
          <Text className={styles.settingLabel}>{t('mine.learn')}</Text>
          <View className={styles.settingValue}>
            <Text>{t('mine.learnDesc')}</Text>
            <Text className={styles.entryArrow}>›</Text>
          </View>
        </View>
        <View className={styles.settingRow} onClick={() => Taro.navigateTo({ url: '/pages/shopping/index' })}>
          <Text className={styles.settingLabel}>{t('mine.shopping')}</Text>
          <View className={styles.settingValue}>
            <Text>{t('mine.shoppingDesc')}</Text>
            <Text className={styles.entryArrow}>›</Text>
          </View>
        </View>
        {/* 记账（v2.0 F23）：放在购物清单正下方 —— 两者的心智模型相邻（都是「花钱」相关），
            且这是记账页唯一的常驻入口；晨报卡片另有「查看全部」直达。 */}
        <View className={styles.settingRow} onClick={() => Taro.navigateTo({ url: '/pages/ledger/index' })}>
          <Text className={styles.settingLabel}>{t('mine.ledger')}</Text>
          <View className={styles.settingValue}>
            <Text>{t('mine.ledgerDesc')}</Text>
            <Text className={styles.entryArrow}>›</Text>
          </View>
        </View>
      </View>

      <View className={styles.privacyCard}>
        <Text className={styles.privacyText}>
          {t('mine.privacyNote')}
        </Text>
      </View>

      {/* 协议/隐私半屏查看层 */}
      {docView ? (
        <View className={styles.docMask} onClick={() => setDocView(null)}>
          <View className={styles.docPanel} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>
              {docView === 'terms' ? t('mine.terms') : docView === 'privacy' ? t('mine.privacy') : t('mine.aiNotice')}
            </Text>
            <ScrollView scrollY className={styles.docBody}>
              <Text className={styles.docText}>
                {/* 法务原文只有中文版：英文界面下必须先声明「以中文版为准」，
                    不能让用户以为读到的是英文条款（诚实性，2026-10-12） */}
                {lang === 'en' ? `${t('legal.langNotice')}\n\n` : ''}
                {docView === 'terms' ? TERMS_TEXT : docView === 'privacy' ? PRIVACY_TEXT : AI_SERVICES_TEXT}
              </Text>
            </ScrollView>
            <Button className={styles.docClose} onClick={() => setDocView(null)}>
              {t('mine.docRead')}
            </Button>
          </View>
        </View>
      ) : null}

      {/* X11 家长密码弹层：数字键盘 Input，双端一致（showModal editable 在 H5 兼容性不可靠） */}
      {pinOverlay ? (
        <View className={styles.docMask} onClick={closePinOverlay}>
          <View className={styles.docPanel} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>
              {pinOverlay.mode === 'set' ? t('settings.pinSetTitle') : t('settings.pinVerifyTitle')}
            </Text>
            <Text className={styles.pinHint}>
              {pinOverlay.mode === 'set'
                ? '设置 4 位数字密码，仅用于家长控制，非安全凭据'
                : '请输入已设置的 4 位家长密码以关闭未成年人模式'}
            </Text>
            <Input
              className={styles.pinInput}
              type='number'
              password
              maxlength={4}
              value={pinInput}
              placeholder='4 位数字'
              onInput={(e) => setPinInput(e.detail.value)}
            />
            <View className={styles.pinActions}>
              <Button className={styles.pinCancel} onClick={closePinOverlay}>
                {t('cancel')}
              </Button>
              <Button className={styles.docClose} onClick={handlePinSubmit}>
                确定
              </Button>
            </View>
          </View>
        </View>
      ) : null}

      {/* 意见反馈弹层（2026-10-24）：类型四选 + 描述 + 可选联系方式。
          选择半屏层而不是新页面：反馈是「顺手说一句」，跳页会丢掉当前上下文，
          且不新增路由 = 不动 app.config、不增加首屏分包体积。
          提交按钮**只在提交中**才 disabled —— 内容为空时按下去要有 toast 说明缺什么，
          按了没反应才是更差的体验。 */}
      {fbOpen ? (
        <View className={styles.docMask} onClick={closeFeedback}>
          <View className={classnames(styles.docPanel, styles.fbPanel)} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>{fbCopy.title}</Text>
            <ScrollView scrollY className={styles.fbScroll}>
              <Text className={styles.fbIntro}>{fbCopy.intro}</Text>
              <Text className={styles.fbLabel}>{fbCopy.typeLabel}</Text>
              <View className={styles.fbTypes}>
                {FEEDBACK_TYPES.map((opt) => (
                  <View
                    key={opt.id}
                    className={classnames(styles.fbChip, fbType === opt.id && styles.fbChipActive)}
                    onClick={() => setFbType(opt.id)}
                  >
                    <Text className={classnames(styles.fbChipText, fbType === opt.id && styles.fbChipTextActive)}>
                      {opt[lang]}
                    </Text>
                  </View>
                ))}
              </View>
              <Text className={styles.fbLabel}>{fbCopy.contentLabel}</Text>
              <Textarea
                className={styles.fbTextarea}
                value={fbContent}
                maxlength={500}
                placeholder={fbCopy.contentPlaceholder}
                onInput={(e) => setFbContent(e.detail.value)}
              />
              <Text className={styles.fbCount}>{fbContent.length}/500</Text>
              <Text className={styles.fbLabel}>{fbCopy.contactLabel}</Text>
              <Input
                className={styles.fbInput}
                value={fbContact}
                maxlength={80}
                placeholder={fbCopy.contactPlaceholder}
                onInput={(e) => setFbContact(e.detail.value)}
              />
              {/* H5 没有 feedback 的 RPC 通道：提交前就说清实际送达方式，不留到点完才告知 */}
              {isWeapp ? null : <Text className={styles.fbNote}>{fbCopy.h5Note}</Text>}
            </ScrollView>
            <View className={styles.fbActions}>
              <Button className={styles.fbCancel} onClick={closeFeedback}>
                {t('cancel')}
              </Button>
              <Button
                className={styles.fbSubmit}
                disabled={disabledAttr(fbSending)}
                onClick={() => void handleSubmitFeedback()}
              >
                {fbSending ? fbCopy.submitting : fbCopy.submit}
              </Button>
            </View>
            {/* 人工通道不丢：原来的「复制邮箱 / 复制公众号 / 服务时间」action sheet 挂在这里 */}
            <Text className={styles.fbService} onClick={handleContactService}>
              {fbCopy.service}
            </Text>
          </View>
        </View>
      ) : null}

      {/* 天气城市编辑弹层（与反馈共用半屏语言与控件样式，不引入第三套观感） */}
      {cityOpen ? (
        <View className={styles.docMask} onClick={() => setCityOpen(false)}>
          <View className={classnames(styles.docPanel, styles.fbPanel)} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>{t('sync.key.user-city')}</Text>
            <Text className={styles.fbIntro}>{cityCopy.hint}</Text>
            <Input
              className={styles.fbInput}
              value={cityDraft}
              maxlength={20}
              placeholder={cityCopy.placeholder}
              onInput={(e) => setCityDraft(e.detail.value)}
            />
            <View className={styles.fbActions}>
              <Button className={styles.fbCancel} onClick={() => setCityOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                className={styles.fbSubmit}
                disabled={disabledAttr(cityChecking)}
                onClick={() => void handleSaveCity()}
              >
                {cityChecking ? cityCopy.saving : cityCopy.save}
              </Button>
            </View>
          </View>
        </View>
      ) : null}

      <PromptModal
        visible={deleteOpen}
        title={t('mine.deleteTitle')}
        description={t('mine.deleteWarn')}
        placeholder={t('mine.deleteInputHint')}
        initialValue=''
        confirmText={t('mine.deleteSubmit')}
        cancelText={t('cancel')}
        danger
        onConfirm={(value) => void confirmDeleteAccount(value)}
        onCancel={() => setDeleteOpen(false)}
      />
    </View>
  );
}

export default MinePage;
