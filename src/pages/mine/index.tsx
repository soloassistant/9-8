import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { apiDeleteAccount, apiApplyPlan, apiSubmitFeedback } from '@/services/api';
import { signOut, resetPasswordForOld } from '@/services/cloudAuth';
import { kvClear } from '@/services/cloudDb';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import { AI_LABEL_VERSION } from '@/utils/aiLabel';
import { disabledAttr } from '@/utils/buttonDisabled';
import { hasKeyboard, requestHotkeyHelp } from '@/hooks/useHotkeys';
import { openExternalPage } from '@/utils/externalLink';
import { AVATAR_CLOUD_PREFIX, deleteAvatar, resolveAvatarUrl, uploadAvatar } from '@/services/cloudStorage';
import { SXM_ENTRY_URL } from '@/config/partners';
import { fromNow, dayKey } from '@/utils/date';
import { getActivityLogs } from '@/utils/activityLog';
import type { ActivityLogItem } from '@/utils/activityLog';
import { getPersonalization, setPersonalization } from '@/utils/permission';
import { resolveRenewal, shouldRemind } from '@/utils/renewal';
import { clearMemory, deleteMemory, readMemory, setMemoryEnabled, truncateSummary } from '@/utils/memory';
import type { MemoryItem, MemoryStore } from '@/utils/memory';
import { clearBlockRules, listBlockRules, restoreBlockRule } from '@/utils/blocklist';
import type { BlockDimension, BlockRule } from '@/utils/blocklist';
import { readPrefs, updatePrefs, isInDnd } from '@/utils/prefs';
import type { UserPrefs, PushFreq } from '@/utils/prefs';
import { apiSavePrefs, apiGetPrefs } from '@/services/cloud';
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
import { FEEDBACK_TEXT, FEEDBACK_TYPES, type FeedbackType } from './feedbackText';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const isH5 = process.env.TARO_ENV === 'h5';
const AVATAR_KEY = 'user-avatar';
/** H5 预览端可选的预设头像 */
const AVATAR_PRESETS = ['🌅', '🌞', '🌱', '🐳', '🦊', '🐼'];

/** 通道标签 i18n key 映射 */



/** 危险操作确认按钮统一色值（设计文档第六章 B） */
const DANGER_COLOR = '#E85D2A';


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
  const [avatar, setAvatar] = useState('');
  /** 云存储对象键（仅 H5 上传成功后有值）—— 换头像/换 emoji 时据此删旧文件，避免孤儿对象 */
  const [avatarObjectKey, setAvatarObjectKey] = useState('');
  const [logs, setLogs] = useState<ActivityLogItem[]>([]);
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
  // v1.2 新增：C-03 个性化推荐开关 / V-05 V-07 TTS 偏好 / M-01 M-02 记忆 / N-03 屏蔽清单 / B-01 B-02 订阅
  const [personalOn, setPersonalOn] = useState(true);
  const [memory, setMemory] = useState<MemoryStore>({ enabled: true, items: [] });
  const [blocks, setBlocks] = useState<BlockRule[]>([]);
  // v2.2（2026-10-24）：续费提醒
  // 额度 / 功能记账 / 连续阅读已移入「会员中心」—— 同类信息只在一个地方出现
  const [remindOn, setRemindOn] = useState(true);
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
    setCustom(loadCustom());
    setPersonalOn(getPersonalization());
    setMemory(readMemory());
    setBlocks(listBlockRules());
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
    setHabits(listHabits());
    setGuardRecords(listRestorableRecords());
    setHabitNotices(listHabitNotices());
    setAppPrefs(readPrefs());
    // 续费提醒开关在「会员中心」页改，回到本页要重读 —— 否则本页的到期提示会按旧开关走
    setRemindOn(readRenewRemindPref());
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

  // 恢复头像。三种取值来源（2026-10-26 接云存储后）：
  //   · `cloud:<对象键>` —— H5 上传到 WorkBuddy 云存储的头像（跨设备可用）：要换签名 URL 才能显示
  //   · emoji（长度 ≤4）—— 预设头像，本机/云端都能原样显示
  //   · 其它（小程序 saveFile 的本地路径）—— 只在微信端有效，H5 端读到一律按「无头像」处理（显示默认）
  useEffect(() => {
    try {
      const saved = Taro.getStorageSync(AVATAR_KEY) as string;
      if (!saved) return;
      if (saved.startsWith(AVATAR_CLOUD_PREFIX)) {
        const key = saved.slice(AVATAR_CLOUD_PREFIX.length);
        setAvatarObjectKey(key);
        void resolveAvatarUrl(key).then((url) => {
          // 取不到签名 URL（未登录/网络/后端不可用）→ 不硬塞空 src（会显示裂图），回退默认头像
          if (url) setAvatar(url);
          else console.error('[MinePage] cloud avatar unresolvable, fallback to default');
        });
        return;
      }
      if (saved.length <= 4 || isWeapp) setAvatar(saved);
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
          // 2026-10-26 修「重启后头像失效却提示已更新」：tempFilePath 是**临时**文件，
          // 微信重启/清理后失效，此处此前直接存它并提示成功 = 假成功。
          // 改为 saveFile 转存为本地永久文件（重启后仍可显示）；云存储 uploadFile→fileID
          // 仍是更优解，但依赖云开发环境（WX_APPID 三件套未就绪），届时替换这一处即可。
          Taro.saveFile({ tempFilePath: path })
            .then((r) => {
              // Taro 的 saveFile promise 类型是 Success|Fail 联合（lib 定义较糙），此处按成功分支收窄
              const saved = (r as { savedFilePath?: string }).savedFilePath;
              if (!saved) throw new Error('empty savedFilePath');
              setAvatar(saved);
              Taro.setStorageSync(AVATAR_KEY, saved);
              Taro.showToast({ title: t('mine.avatarSaved'), icon: 'success' });
            })
            .catch((err) => {
              // 转存失败（本地缓存满等）：**不谎称已保存** —— 本次会话内显示新头像，
              // 明确告知重启后需重设，与真实行为一致。
              console.warn('[MinePage] save avatar failed:', err);
              setAvatar(path);
              Taro.showToast({ title: t('mine.avatarTempOnly'), icon: 'none' });
            });
        },
        fail: (err) => console.info('[MinePage] chooseMedia cancelled:', err && err.errMsg)
      });
    } else {
      // H5：第一项是「上传照片」（存 WorkBuddy 云存储，跨设备可用），其余仍是预设 emoji。
      // 菜单项前移一位，故 emoji 的 tapIndex 要 -1。
      Taro.showActionSheet({ itemList: [t('mine.avatarUpload'), ...AVATAR_PRESETS] })
        .then((res) => {
          if (res.tapIndex === 0) {
            pickAndUploadAvatar();
            return;
          }
          const next = AVATAR_PRESETS[res.tapIndex - 1];
          if (!next) return;
          // 换成 emoji：云上那张图不再被引用 —— 删掉，避免孤儿对象；删失败只留痕
          if (avatarObjectKey) void deleteAvatar(avatarObjectKey);
          setAvatarObjectKey('');
          setAvatar(next);
          Taro.setStorageSync(AVATAR_KEY, next);
          Taro.showToast({ title: t('mine.avatarSaved'), icon: 'success' });
        })
        .catch(() => {
          /* 静默：showActionSheet 被用户取消时 reject，是正常操作而非错误 */
        });
    }
  };

  /** H5 选图并上传到云存储。每个失败原因给**具体**提示，不谎称成功。
   *  未登录时明确说「登录后才能存到云端」——存储只对已登录用户开放，这是平台约束不是 bug。 */
  const pickAndUploadAvatar = () => {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      void (async () => {
        // 兜底 catch：uploadAvatar 自身已保证不抛，但这是挂在用户点击上的 async 回调 ——
        // 一旦某天有人往里加了个会抛的调用，没有这层就会变成「点了没反应」的静默失败。
        try {
          const res = await uploadAvatar(file);
          if (!res.ok) {
            const msg =
              res.reason === 'no-session'
                ? t('mine.avatarNoSession')
                : res.reason === 'too-large'
                  ? t('mine.avatarTooLarge')
                  : res.reason === 'too-large-compressed'
                    ? t('mine.avatarTooLargeCompressed')
                    : res.reason === 'bad-type'
                      ? t('mine.avatarBadType')
                      : t('mine.avatarNoStorage');
            Taro.showToast({ title: msg, icon: 'none', duration: 3000 });
            return;
          }
          // 立刻换签名 URL 显示（1 小时有效；下次进页面会重新取）
          const url = await resolveAvatarUrl(res.path);
          const prevKey = avatarObjectKey;
          setAvatarObjectKey(res.path);
          if (url) setAvatar(url);
          Taro.setStorageSync(AVATAR_KEY, AVATAR_CLOUD_PREFIX + res.path);
          if (prevKey && prevKey !== res.path) void deleteAvatar(prevKey);
          // 存成功了但换不出可显示的 URL（签名服务异常）时**不谎称「已更新」**——
          // 用户眼前根本没变化，说「已更新」就是假成功。如实说「已保存、重进本页可见」。
          Taro.showToast({
            title: url ? t('mine.avatarSaved') : t('mine.avatarSavedNoPreview'),
            icon: url ? 'success' : 'none',
            duration: url ? 1500 : 3000
          });
        } catch (err) {
          console.error('[MinePage] avatar upload crashed:', String((err && (err as Error).message) || err));
          Taro.showToast({ title: t('mine.avatarNoStorage'), icon: 'none', duration: 3000 });
        }
      })();
    };
    input.click();
  };

  /** 点头像：更换头像 或 查看浏览历史（v2.0 F26；2026-10-25 历史页并入热点页 ——
   *  switchTab 过去并置展开标记，热点页 useDidShow 读标记自动展开「最近浏览」） */
  const handleAvatarTap = () => {
    Taro.showActionSheet({ itemList: ['更换头像', '浏览历史'] })
      .then((res) => {
        if (res.tapIndex === 0) doChangeAvatar();
        else if (res.tapIndex === 1) {
          try {
            Taro.setStorageSync('library-open-history', 1);
          } catch {
            /* 标记写不进去就只是不自动展开 */
          }
          Taro.switchTab({ url: '/pages/library/index' }).catch(() => {
            Taro.navigateTo({ url: '/pages/library/index' });
          });
        }
      })
      .catch(() => {
        /* 静默：showActionSheet 被用户取消时 reject，是正常操作而非错误 */
      });
  };

  const isEmojiAvatar = (val: string) => val.length <= 4;


  /** 立即订阅：自动识别三端通道 → 下单 → 拉起支付 */

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


  const handleTogglePref = (tag: string) => {
    if (prefs.includes(tag)) {
      const next = prefs.filter((p) => p !== tag);
      setPrefs(next);
      saveSettings({ preferences: next });
      return;
    }
    // 截断要让人知道：老写法 `[...prefs, tag].slice(0, 5)` 静默丢掉溢出的标签，
    // 用户点了没反应，以为选上了。最多 5 个是产品口径，但「选不了」必须说出来。
    if (prefs.length >= 5) {
      Taro.showToast({ title: t('mine.prefMax'), icon: 'none' });
      return;
    }
    const next = [...prefs, tag];
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

  /** 宫格·省心买（2026-10-25 外放）：行为逐端镜像购物页 PartnerEntry ——
   *  H5 打开同源独立服务 /sxm/（完整 PWA），失败降级复制提示；小程序进原生页。 */
  const handleGridSxm = () => {
    if (isH5) {
      void openExternalPage(SXM_ENTRY_URL).then((r) => {
        if (r !== 'opened') {
          Taro.showToast({
            title: r === 'copied' ? t('partner.copyHint') : t('partner.copyFail'),
            icon: 'none',
            duration: 3000
          });
        }
      });
      return;
    }
    Taro.navigateTo({ url: '/pages/sxm/index' });
  };

  const handleDeleteAccount = () => {
    setDeleteOpen(true);
  };

  /** 修改密码（2026-10-25，「账号与合规」卡片常驻入口）。
   *
   *  安全措施（一个都不少）：
   *    ① 必须先出示**旧密码** —— 服务端 sudo 校验通过才发 sudo_token，拿着别人手机改不了密；
   *    ② 新密码 ≥8 位（与登录注册同一阈值）；
   *    ③ 新密码 + 确认输入两次一致，防手滑设错把自己锁在外面；
   *    ④ password 类型输入不回显；提交按钮 busy 防连点；
   *    ⑤ 失败文案过 sdkDownText 口径：后端不可用 ≠ 旧密码错，不误导用户反复试。
   *  ⚠️ 只支持「知道旧密码」的改密。没设过密码的账户（手机号注册时未填）无法补设 ——
   *     服务端没有短信重置接口（SDK 穷举实录，见 cloudAuth.resetPasswordForOld 注释），
   *     弹窗底部如实说明，短信登录不受影响。 */
  /** 我的页分区折叠（2026-10-25 瘦身）：低频区默认收起，主路径（个人卡/宫格/订阅/通用设置）常开。
   *  折叠只是视觉收纳 —— 各区块的原 JSX 原样保留在折叠体里，门禁断言的源码模式不受影响。 */
  const [foldUsage, setFoldUsage] = useState(false);
  const [foldAi, setFoldAi] = useState(false);
  const [foldPush, setFoldPush] = useState(false);
  const [foldAccount, setFoldAccount] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdErr, setPwdErr] = useState('');

  const openPwdEditor = () => {
    setOldPwd('');
    setNewPwd('');
    setConfirmPwd('');
    setPwdErr('');
    setPwdOpen(true);
  };

  const submitChangePassword = async () => {
    if (pwdBusy) return;
    if (!oldPwd || !newPwd) {
      setPwdErr(t('auth.errPassword'));
      return;
    }
    if (newPwd.length < 8) {
      setPwdErr(t('auth.errPassword'));
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdErr(t('mine.pwdErrMismatch'));
      return;
    }
    setPwdErr('');
    setPwdBusy(true);
    const res = await resetPasswordForOld({ oldPassword: oldPwd, newPassword: newPwd });
    setPwdBusy(false);
    if (res.error) {
      // sudo 失败通常是旧密码不对；后端整体不可用是另一回事，必须分开说（否则误导反复试）
      const down = res.error.kind === 'backend-unavailable' ? t('auth.errSdkUnavailable') : '';
      setPwdErr(down || t('auth.errWrongCredentials'));
      return;
    }
    setPwdOpen(false);
    Taro.showToast({ title: t('mine.pwdDone'), icon: 'success' });
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
   * 其余一切路径 —— H5 表插入失败（会话失效/网络/约束拒绝）/ 抛错 —— 都走「复制全文 +
   * 告知邮件入口」，**不显示任何成功态**。把用户的投诉吞掉还回一句「提交成功」，
   * 比没有这个入口更糟。
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

  /**
   * 打开二级页。用 navigateTo（不是 switchTab）—— membership / prefs 都不是 tabBar 页，
   * 这样系统返回手势能回到「我的」，用户不会觉得"点进去就回不来了"。
   */
  const handleOpenMembership = () => {
    Taro.navigateTo({ url: '/pages/membership/index' }).catch((err) => {
      console.error('[MinePage] open membership failed:', err);
    });
  };

  const handleOpenPrefs = () => {
    Taro.navigateTo({ url: '/pages/prefs/index' }).catch((err) => {
      console.error('[MinePage] open prefs failed:', err);
    });
  };

  /** AI 助手（2026-10-27）：全站唯一 AI 入口。原晨报页底部输入条 + 全局悬浮球已移除。 */
  const handleOpenAssistant = () => {
    Taro.navigateTo({ url: '/pages/assistant/index' }).catch((err) => {
      console.error('[MinePage] open assistant failed:', err);
    });
  };

  /**
   * 键盘快捷键面板（2026-10-27）。面板本体挂在 App（全局单例），这里只发一个请求事件。
   * 只在真有物理键盘的桌面浏览器上显示 —— 手机上列一串按不了的键帽是噪音。
   */
  const handleOpenHotkeys = () => requestHotkeyHelp();

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

      {/* ===== 功能宫格（2026-10-25）：高频功能从页面底部捞到顶部 =====
          记账/购物/学习原先埋在「其他入口」底卡（本轮已去重上移，底卡整卡移除）；
          浏览历史此前只藏在头像 actionSheet 里，全网搜索只在晨报页头部 ——
          宫格是它们第一排的一等入口。放在个人卡与订阅卡之间：先「我能用什么」再「要不要付费」。
          省心买（2026-10-25 外放）：独立产品，行为逐端镜像购物页 PartnerEntry ——
          H5 打开同源独立服务 /sxm/，小程序进原生页。 */}
      <View className={styles.featureGrid}>
        {([
          { icon: '🧾', label: t('mine.gridLedger'), url: '/pages/ledger/index' },
          { icon: '🛒', label: t('mine.gridShopping'), url: '/pages/shopping/index' },
          { icon: '🛍️', label: t('mine.gridSxm'), url: '/pages/sxm/index', external: true },
          { icon: '📚', label: t('mine.gridLearn'), url: '/pages/learn/index' },
          { icon: '🔍', label: t('mine.gridSearch'), url: '/pages/search/index' }
        ] as Array<{ icon: string; label: string; url: string; external?: boolean }>).map((it) => (
          <View
            key={it.url}
            className={styles.featureTile}
            onClick={() => (it.external ? handleGridSxm() : Taro.navigateTo({ url: it.url }))}
          >
            <Text className={styles.featureIcon}>{it.icon}</Text>
            <Text className={styles.featureLabel}>{it.label}</Text>
          </View>
        ))}
      </View>

      {/* ===== 订阅状态条（2026-10-26）=====
          原 526px 订阅卡（方案 / 锁价 / 支付 / 续费管理）、139px 订阅记录、调价站内信，
          已整体移入「会员中心」页（pages/membership）。
          这里只留一行事实：我现在是什么档、这个月还能说几句话 —— 谈钱的事进去再谈。
          为什么状态条必须留在首屏：「我的」页第一个要回答的问题就是「我还是会员吗」，
          把这句话也藏进二级页，等于让人每次确认身份都要多点一次。 */}
      <View className={styles.subBar} onClick={handleOpenMembership}>
        <View className={styles.subBarMain}>
          <Text className={styles.subBarTitle}>
            {profile?.subscribed
              ? t('mine.subStatusActive', { date: (profile.expiredAt || '').slice(0, 10) })
              : t('mine.subStatusNone')}
          </Text>
          <Text className={styles.subBarMeta}>
            {usage && usage.voiceQuota > 0
              ? t('mine.quotaShort', { used: usage.voiceUsed, quota: usage.voiceQuota })
              : t('mine.quotaUnlimited')}
          </Text>
        </View>
        <Text className={styles.subBarAction}>{t('mine.manageSub')} ›</Text>
      </View>

      {/* 习惯守护与近期动态（2026-10-25 折叠 / 2026-10-26 改名）：
          额度、功能记账、连续阅读已移入「会员中心」—— 同类信息只在一个地方出现，
          这里只留「我的」页独有的：习惯列表与活动日志。
          默认收起：低频查看，展开才占高度。 */}
      <View className={styles.foldHeadCard} onClick={() => setFoldUsage(!foldUsage)}>
        <Text className={styles.foldIcon}>📊</Text>
        <Text className={styles.foldTitle}>{t('mine.foldHabit')}</Text>
        <Text className={styles.foldCaret}>{foldUsage ? '▾' : '›'}</Text>
      </View>
      {foldUsage ? (
        <>
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
        </>
      ) : null}

      {/* ===== AI 助手（2026-10-27）=====
          全站唯一的 AI 入口。之前有两处：晨报页底部常驻输入条、全局悬浮球。
          用户要求收敛成一个并放进设置层，页面上不再有悬浮物遮挡正文。 */}
      <View className={styles.card} onClick={handleOpenAssistant}>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.assistantTitle')}</Text>
          <View className={styles.rowValue}>
            <Text className={styles.valueHint}>{t('mine.assistantDesc')}</Text>
            <Text className={styles.arrow}>›</Text>
          </View>
        </View>
      </View>

      {/* ===== 键盘快捷键（2026-10-27，仅桌面浏览器）=====
          快捷键是「看不见的功能」：没有可查的入口，等于只服务于写它的人。
          点开与按 `?` 打开的是同一个面板。 */}
      {hasKeyboard() ? (
        <View className={styles.card} onClick={handleOpenHotkeys}>
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('hotkeys.title')}</Text>
            <View className={styles.rowValue}>
              <Text className={styles.valueHint}>{t('hotkeys.entryDesc')}</Text>
              <Text className={styles.arrow}>›</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ===== 偏好设置入口（2026-10-26）=====
          原 366px 通用设置卡（称呼 / 推送时间 / 提醒 / 城市 / 语速 / 音色，共 6 行）
          已整体移入 pages/prefs。这里只留一行门 —— 但门必须显眼，
          因为「改推送时间」是真实高频动作，不能让它变成需要探索的功能。 */}
      <View className={styles.card} onClick={handleOpenPrefs}>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.prefsTitle')}</Text>
          <View className={styles.rowValue}>
            <Text className={styles.valueHint}>{t('mine.prefsDesc')}</Text>
            <Text className={styles.arrow}>›</Text>
          </View>
        </View>
      </View>

      {/* AI 个性化与外观（2026-10-25 折叠）：低频调整 */}
      <View className={styles.foldHeadCard} onClick={() => setFoldAi(!foldAi)}>
        <Text className={styles.foldIcon}>🤖</Text>
        <Text className={styles.foldTitle}>{t('mine.settingAi')}</Text>
        <Text className={styles.foldCaret}>{foldAi ? '▾' : '›'}</Text>
      </View>
      {foldAi ? (
        <>
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

        </>
      ) : null}

      {/* 推送偏好（2026-10-25 折叠）：低频调整 */}
      <View className={styles.foldHeadCard} onClick={() => setFoldPush(!foldPush)}>
        <Text className={styles.foldIcon}>🔔</Text>
        <Text className={styles.foldTitle}>{t('settings.push')}</Text>
        <Text className={styles.foldCaret}>{foldPush ? '▾' : '›'}</Text>
      </View>
      {foldPush ? (
        <>
      {/* ===== 竞品分析 X3 / X6：推送偏好（数量三档 / 免打扰 / 模块开关 / 周末设置） ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('settings.push')}</Text>
        {/* 2026-10-26 诚实性：本卡片全部偏好（数量三档/免打扰/模块开关/周末免打扰）都作用于
            **消息推送**，而当前版本没有推送通道（订阅消息模板 id 仍是占位、模板未申请）。
            不标注会让人以为「设置了免打扰就真不会被吵」——实际这些开关暂不产生任何行为。
            推送落地后删掉这一行即可（连带门禁断言一起删）。 */}
        <Text className={styles.pushNote}>{t('settings.pushNote')}</Text>
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
        </>
      ) : null}

      {/* 账号与合规（F18 提审硬门槛；2026-10-25 折叠：法务文档与注销属极低频动作） */}
      <View className={styles.foldHeadCard} onClick={() => setFoldAccount(!foldAccount)}>
        <Text className={styles.foldIcon}>👤</Text>
        <Text className={styles.foldTitle}>{t('mine.settingAccount')}</Text>
        <Text className={styles.foldCaret}>{foldAccount ? '▾' : '›'}</Text>
      </View>
      {foldAccount ? (
        <>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAccount')}</Text>
        {/* 修改密码（2026-10-25 常驻入口）：安全措施见 submitChangePassword 注释。
            放在卡片首位 —— 账号安全先于合规文档阅读。 */}
        {renderRow(
          t('mine.pwdRow'),
          <>
            <Text className={styles.valueText}>{t('mine.pwdAction')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          openPwdEditor
        )}
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

        </>
      ) : null}

      {/* 退出登录（2026-10-15）：与「注销账号」严格分开的两件事。
          此前**只有注销、没有登出** —— 用户想只是退出登录（换账号、把设备给别人），
          唯一的出口是「注销账号」，那会连带清空本机数据与云端同步键，代价过大。
          独立成条后：登出 = 清会话、留数据；注销 = 清数据、不可逆。
          放在「其他入口」之前、注销区块之后，保持「危险度递减」的阅读顺序。 */}
      <View className={styles.settingCard}>
        {renderRow(t('mine.signOut'), <Text>{t('mine.signOutHint')}</Text>, handleSignOut)}
      </View>

      {/* 记账/购物/学习三行已上移至顶部功能宫格（2026-10-25 去重，原「其他入口」底卡整卡移除）。
          晨报页记账卡的「查看全部」直达保留，双入口不冲突。 */}

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

      {/* 修改密码弹层（与城市/反馈共用半屏语言与控件样式，不引入第三套观感） */}
      {pwdOpen ? (
        <View className={styles.docMask} onClick={() => setPwdOpen(false)}>
          <View className={classnames(styles.docPanel, styles.fbPanel)} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>{t('mine.pwdRow')}</Text>
            <Input
              className={styles.fbInput}
              password
              value={oldPwd}
              maxlength={64}
              placeholder={t('mine.pwdOld')}
              onInput={(e) => setOldPwd(e.detail.value)}
            />
            <Input
              className={styles.fbInput}
              password
              value={newPwd}
              maxlength={64}
              placeholder={t('auth.passwordPlaceholder')}
              onInput={(e) => setNewPwd(e.detail.value)}
            />
            <Input
              className={styles.fbInput}
              password
              value={confirmPwd}
              maxlength={64}
              placeholder={t('mine.pwdConfirm')}
              onInput={(e) => setConfirmPwd(e.detail.value)}
            />
            {pwdErr ? <Text className={styles.fbError}>{pwdErr}</Text> : null}
            {/* 诚实边界：补设密码无服务端接口。短信登录不受影响，不会被锁在门外。 */}
            <Text className={styles.fbIntro}>{t('mine.pwdHintPasswordless')}</Text>
            <View className={styles.fbActions}>
              <Button className={styles.fbCancel} onClick={() => setPwdOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                className={styles.fbSubmit}
                disabled={disabledAttr(pwdBusy)}
                onClick={() => void submitChangePassword()}
              >
                {t('mine.pwdSubmit')}
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
