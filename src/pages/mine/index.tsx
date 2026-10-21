import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Picker, Button, Image, Input, Switch, ScrollView } from '@tarojs/components';
import type { CommonEvent, PickerSelectorProps, PickerTimeProps } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import classnames from 'classnames';
import DemoDataHint from '@/components/DemoDataHint';
import SyncConflictHint from '@/components/SyncConflictHint';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore, THEME_PRESETS } from '@/store/theme';
import { useUiScaleStore, UI_SCALE_PRESETS } from '@/store/uiScale';
import { useT, useLanguageStore, LANG_OPTIONS } from '@/store/language';
import type { LangKey } from '@/store/language';
import { apiCreateOrder, apiDeleteAccount, apiApplyPlan, type CreateOrderPayload } from '@/services/api';
import { getPayChannel, getChannelAuth, invokePayment } from '@/services/pay';
import type { PayChannel } from '@/types';
import { signOut } from '@/services/cloudAuth';
import { kvClear } from '@/services/cloudDb';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import { AI_LABEL_VERSION } from '@/utils/aiLabel';
import { fromNow } from '@/utils/date';
import { getActivityLogs } from '@/utils/activityLog';
import type { ActivityLogItem } from '@/utils/activityLog';
import { getPersonalization, setPersonalization } from '@/utils/permission';
import { getTtsPrefs, saveTtsPrefs, TTS_RATE_OPTIONS } from '@/utils/tts';
import type { TtsPrefs, TtsVoiceMode } from '@/utils/tts';
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
import type { PayOrder } from '@/types';
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
const SERVICE_CORP_ID = 'TODO_CORP_ID';

const PREF_TAGS = ['科技', '效率工具', '财经', '健康', '出行', '生活', 'AI'];
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
  // v1.2 新增：C-03 个性化推荐开关 / V-05 V-07 TTS 偏好 / M-01 M-02 记忆 / N-03 屏蔽清单 / B-01 B-02 订阅
  const [personalOn, setPersonalOn] = useState(true);
  const [ttsPrefs, setTtsPrefs] = useState<TtsPrefs>({ rate: 1.0, voiceMode: 'auto' });
  const [memory, setMemory] = useState<MemoryStore>({ enabled: true, items: [] });
  const [blocks, setBlocks] = useState<BlockRule[]>([]);
  const [locked, setLocked] = useState<LockedPriceInfo | null>(null);
  const [notices, setNotices] = useState<PriceChangeNotice[]>([]);
  // v2.1：晨报连续阅读（只读展示 + 清空入口）
  const [readStreak, setReadStreak] = useState(0);
  const [readFreezeCards, setReadFreezeCards] = useState(0);
  // v2.1：习惯守护（列表 + 自动守护开关 + 守护记录 + 站内信）
  const [habits, setHabits] = useState<Habit[]>([]);
  const [guardRecords, setGuardRecords] = useState<HabitGuardRecord[]>([]);
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
  });

  // 偏好变化（或重新回到本页）后重算免打扰状态，辅助说明用
  useEffect(() => {
    setDndActive(isInDnd());
  }, [appPrefs]);

  /* ---------------- X3 偏好云上报（仅 weapp；失败静默，不影响本机写入） ---------------- */
  const prefsReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

      // 4. 锁价（B-01：首次成功订阅自动早鸟锁价；已锁时内部跳过）
      setLocked(lockPrice(result.planId, result.price));

      // 5. 拉起小程序原生支付
      try {
        const payRes = await invokePayment(channel, result.payment);
        if (payRes.success) {
          Taro.showToast({ title: '支付成功', icon: 'success' });
          // 主动查单：pay-callback 云函数异步回写 users.expiredAt
          // 用 init() 拉最新 profile，避免用户付完还要等下次进 mine 才看到订阅状态
          // 短延时 1.5s 给 pay-callback 足够时间处理（微信 cloudPay 回调快，支付宝/抖音 HTTP 稍慢）
          setTimeout(() => { void init(); }, 1500);
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
    // Taro 类型滞后：editable 尚未进入 showModal.Option 类型定义，需断言（沿用既有写法）
    Taro.showModal({
      title: t('mine.deleteTitle'),
      content: t('mine.deleteWarn'),
      editable: true,
      placeholderText: t('mine.deleteInputHint'),
      cancelText: t('cancel'),
      confirmText: t('mine.deleteSubmit'),
      confirmColor: DANGER_COLOR,
      // showModal 的成功回调结果类型：confirm / cancel / errMsg 来自 Taro 官方类型；
      // editable 输入框的回填字段 content 微信侧有、Taro 类型里没有，故下方仍显式断言读取。
      success: (res: Taro.showModal.SuccessCallbackResult) => {
        if (!res.confirm) return;
        // 平台不支持 editable 时 content 缺失，退化为「一次确认」兜底，仍 ≤3 步
        const typed = (res as unknown as { content?: string }).content;
        const matched = typeof typed === 'string' ? typed.trim() === DELETE_CONFIRM_WORD : true;
        if (!matched) {
          Taro.showToast({ title: t('mine.deleteInputMismatch'), icon: 'none' });
          return;
        }
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
      }
    } as unknown as Taro.showModal.Option);
  };

  const handleContactService = () => {
    const fallback = () => {
      Taro.showModal({
        title: '联系客服',
        content: '工作时间 9:00-21:00\n微信搜索公众号「私人晨报助理」留言\n或发邮件至 support@morningbrief.cn',
        confirmText: '知道了',
        showCancel: false
      });
    };
    if (isWeapp) {
      const openChat = (Taro as unknown as { openCustomerServiceChat?: (opt: Record<string, unknown>) => void })
        .openCustomerServiceChat;
      if (typeof openChat === 'function') {
        try {
          openChat({ corpId: SERVICE_CORP_ID, extInfo: { url: '' }, fail: fallback });
        } catch (err) {
          console.warn('[MinePage] openCustomerServiceChat failed:', err);
          fallback();
        }
      } else {
        fallback();
      }
    } else {
      fallback();
    }
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
            <Button className={styles.subButton} onClick={handleSubscribe} loading={paying} disabled={paying}>
              {paying ? t('mine.subscribing') : t('mine.subscribe')}
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
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.service')}</Text>
          <View className={styles.rowValue}>
            <Text className={styles.linkText} onClick={handleContactService}>
              {t('mine.feedback')}
            </Text>
          </View>
        </View>
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
    </View>
  );
}

export default MinePage;
