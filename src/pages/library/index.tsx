import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Input, Image, Button } from '@tarojs/components';
import Taro, { useShareAppMessage, useDidHide, useDidShow } from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import TagChip from '@/components/TagChip';
import EmptyState from '@/components/EmptyState';
import DemoDataHint from '@/components/DemoDataHint';
import { NewsCardSkeleton } from '@/components/Skeleton';
import { apiGetLibrary, apiGetHotspot, apiNewsSearch, apiVideoNews } from '@/services/api';
import { getHotspotMeta, apiAiNewsFilter, apiGetAffinity, apiSaveAffinity } from '@/services/cloud';
import { invoke } from '@/services/dataSource';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore } from '@/store/theme';
import { fromNow } from '@/utils/date';
import { openExternalPage } from '@/utils/externalLink';
import { logActivity } from '@/utils/activityLog';
import type { CollectionItem, HistoryEntry, HotspotNews } from '@/types';
import { useT } from '@/store/language';
import { readPrefs } from '@/utils/prefs';
import { getPersonalization, setPersonalization } from '@/utils/permission';
import { categoryOf, categoryLabel } from '@/utils/categoryLabel';
import {
  getTopCategories,
  recordCategorySignal,
  resetAffinity,
  exportAffinityForSync,
  mergeRemoteAffinity
} from '@/utils/categoryAffinity';
import {
  pickAffinityArm,
  recordAffinityImpression,
  recordAffinityExposure,
  recordAffinityOutcome,
  getAffinityExperimentSummary,
  resetAffinityExperiment,
  type AffinityArm,
  type AffinityExperimentSummary
} from '@/utils/affinityExperiment';
import {
  readBlockRules,
  addBlockRules,
  filterBlocked,
  buildBlockOptions,
  toggleBlockOption,
  collectBlockDrafts,
  countBlockSelected,
  type BlockRule,
  type BlockOptionGroups
} from '@/utils/blocklist';
import styles from './index.module.scss';

const TYPE_ICONS: Record<CollectionItem['sourceType'], string> = {
  article: '📄',
  message: '💬',
  link: '🔗'
};
/** sourceType 脏值兜底（云同步/旧数据可能是任意串）：未知类型渲染通用文档图标，
 *  而不是空图标（2026-10-24 审计）。口径同 cloudLlm.ts 的 sourceType 归一。 */
const TYPE_ICON_FALLBACK = '📄';

const HISTORY_KEY = 'browseHistory';
const HISTORY_LIMIT = 50;
const NEWS_FEEDBACK_KEY = 'newsFeedback';
/** U-01 骨架屏延迟：加载超过该时长才显示骨架（防快速命中缓存时闪烁） */
const SKELETON_DELAY_MS = 300;
/** 切回 tab 的数据新鲜窗口（60s）：窗口内不重拉，避免每次切回都闪骨架 + 重拉 73KB 热点 */
const LOAD_FRESH_MS = 60_000;

/** X9 分享卡片：轻量 AI 标识后缀（XX = 应用名，不引 canvas，分享图降级默认截图） */
const APP_NAME = '私人晨报助理';
/** X9 分享回跳：资讯页路径（?kw= 预填搜索关键词） */
const LIBRARY_PAGE_PATH = '/pages/library/index';
/** 竞品分析 L1：是否小程序端（决定分享按钮走原生转发还是 H5 复制链接） */
const isWeapp = process.env.TARO_ENV === 'weapp';
const isH5 = process.env.TARO_ENV === 'h5';
/** 竞品分析 X11：未成年人模式屏蔽的话题关键词（命中任一 tag 即过滤） */
const MINOR_BLOCK_KEYWORDS = ['财经', '股票', '投资', '社会'];

/** AI 精选：兴趣标签存储与预设（手动触发筛选，画像上云随 cloudSync 同步） */
const INTERESTS_KEY = 'news-interests';
const INTERESTS_CUSTOM_KEY = 'news-interests-custom';
const AI_PRESET_INTERESTS = ['AI', '数码', '职场', '财经', '健康', '出行', '国际', '教育'];

/** 类目偏好摘要上云：防抖窗口（ms）。连读多条时不需要每次点击都打云函数，攒一批再传 */
const AFFINITY_SYNC_DEBOUNCE_MS = 8000;

/**
 * 【A/B 实验口径】构造本次「AI 精选」请求的 interests。
 * - `treatment`（开启学习）：手选类目在前 + 学到的类目去重补在后 → 整体 slice(0, 8)
 *   （手选永不被学习结果挤掉；8 是服务端 interests 上限）；
 * - `control`（对照组）：**只有手选类目，绝不带上 learned**。
 *
 * 两臂除 interests 外完全一致，唯一变量就是「有没有把学习结果回灌给 AI」——
 * 若两臂发送内容相同，整个实验就是假的。
 *
 * 抽成顶层纯函数（不做 IO、不依赖 Taro），使实验口径可被单独抽出源码验证。
 */
function buildAiInterests(arm: AffinityArm, manual: string[], learned: string[]): string[] {
  if (arm === 'control') return manual.slice(0, 8);
  const merged = [...manual];
  for (const cat of learned) {
    if (!merged.includes(cat)) merged.push(cat);
  }
  return merged.slice(0, 8);
}

/** 资讯反馈取值（👍 正向 / 👎 负向） */
type FeedbackValue = 'up' | 'down';

/** N-01 反馈条状态：value=当前生效值；prev=撤销要回滚到的值（undefined = 回滚到未评价） */
interface FeedbackBar {
  value: FeedbackValue;
  prev?: FeedbackValue;
  /** 是否在 5s 窗口内展示「撤销」；重进页面为 false（改在设置-资讯偏好中恢复，PRD 4.3） */
  undoVisible: boolean;
}

/** N-01 反馈条「撤销」入口可见窗口（ms）：超时淡出撤销入口，但反馈文案持久化保留 */
export const FEEDBACK_UNDO_WINDOW_MS = 5000;

/** 一次性读取反馈存储并派生出「反馈表 + 反馈条」两份初始状态，避免重复读 storage */
function readFeedbackState(): {
  map: Record<string, FeedbackValue>;
  bars: Record<string, FeedbackBar>;
} {
  const map = readNewsFeedback();
  const bars: Record<string, FeedbackBar> = {};
  Object.entries(map).forEach(([id, value]) => {
    bars[id] = { value, prev: undefined, undoVisible: false };
  });
  return { map, bars };
}

/** 读取本地资讯反馈记录 */
function readNewsFeedback(): Record<string, 'up' | 'down'> {
  try {
    return Taro.getStorageSync(NEWS_FEEDBACK_KEY) || {};
  } catch (err) {
    console.warn('[LibraryPage] read newsFeedback failed:', err);
    return {};
  }
}

/** 资讯反馈云端落库（双端生效，失败静默）
 *
 *  2026-10-05 修复：原先调的是 `invoke('newsFeedback', { id, value })` —— **三重错误**：
 *  cloudfunctions 下根本没有 newsFeedback 这个函数（只有 webSearch）；
 *  少了 `action` 分派；字段名是 `feedback` 不是 `value`。
 *  所以收藏页的 👍/👎 从未真正落库，**weapp 端同样失效**（不是 H5 独有）。
 *  服务端按 openid 聚合最新一条，见 webSearch/index.js 的 `action === 'feedback'`。 */
async function apiNewsFeedback(id: string, value: 'up' | 'down'): Promise<void> {
  try {
    await invoke('webSearch', { action: 'feedback', id, feedback: value });
  } catch (err) {
    console.warn('[LibraryPage] apiNewsFeedback failed:', err);
  }
}

/** 记录浏览历史（v2.0，点头像在「我的-浏览历史」查看） */
export function recordBrowseHistory(entry: { id: string; title: string; source?: string }) {
  try {
    const list = Taro.getStorageSync(HISTORY_KEY) || [];
    const next = [
      { ...entry, viewedAt: dayjs().toISOString() },
      ...list.filter((it: { id: string }) => it.id !== entry.id)
    ].slice(0, HISTORY_LIMIT);
    Taro.setStorageSync(HISTORY_KEY, next);
  } catch (err) {
    console.error('[LibraryPage] record history failed:', err);
  }
}

function LibraryPage() {
  const t = useT();
  const theme = useThemeStore((s) => s.theme);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [news, setNews] = useState<HotspotNews[]>([]);
  const [hotMeta, setHotMeta] = useState<ReturnType<typeof getHotspotMeta>>(null);
  /** 视频精选（2026-10-25）：webSearch action=videoNews 的 B 站热榜；空数组 = 板块隐藏 */
  const [videos, setVideos] = useState<HotspotNews[]>([]);
  /** 站内文章视图（2026-10-25）：点卡片先进来读，正文 = 源 feed 自带摘要（不抓正文页） */
  const [article, setArticle] = useState<HotspotNews | null>(null);
  /** 最近浏览（2026-10-25，IA 瘦身）：浏览历史从独立页并入热点页 —— 在哪看的就在哪回看。
   *  默认折叠；清空走 showModal 二次确认。pages/history 已删（-1 页）。 */
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);

  const refreshRecent = useCallback(() => {
    try {
      setRecent((Taro.getStorageSync(HISTORY_KEY) || []) as HistoryEntry[]);
    } catch (err) {
      console.error('[LibraryPage] load history failed:', err);
      setRecent([]);
    }
  }, []);

  /** 头像 actionSheet「浏览历史」等入口的接力：置标记 → 本页 useDidShow 自动展开 */
  const consumeOpenHistoryFlag = useCallback(() => {
    try {
      if (Taro.getStorageSync('library-open-history')) {
        setRecentOpen(true);
        Taro.removeStorageSync('library-open-history');
      }
    } catch {
      /* 标记读不到就不展开，不影响主流程 */
    }
  }, []);

  const handleClearRecent = () => {
    if (recent.length === 0) return;
    Taro.showModal({
      title: t('library.recentTitle'),
      content: t('library.recentClearConfirm').replace('{n}', String(recent.length)),
      confirmText: t('mine.clear'),
      confirmColor: '#E85D2A',
      success: (res) => {
        if (res.confirm) {
          try {
            Taro.removeStorageSync(HISTORY_KEY);
          } catch (err) {
            console.error('[LibraryPage] clear history failed:', err);
          }
          setRecent([]);
          Taro.showToast({ title: t('common.cleared'), icon: 'success' });
        }
      }
    });
  };
  const [activeNewsTag, setActiveNewsTag] = useState('全部');
  // F29 全网搜索：回车触发；真机走 webSearch 云函数（Bing News RSS），H5 预览/云端空结果走本地过滤兜底
  const [searchMode, setSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<HotspotNews[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeTag, setActiveTag] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  // U-01 骨架屏：首屏加载 >300ms 才显示 3 张资讯卡骨架
  const [showSkeleton, setShowSkeleton] = useState(false);
  // N-01：一次性派生反馈表与反馈条初始态（重进页面仍显示已评价，但撤销入口不再展示）
  const initialFeedback = useMemo(readFeedbackState, []);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackValue>>(initialFeedback.map);
  const [feedbackBars, setFeedbackBars] = useState<Record<string, FeedbackBar>>(initialFeedback.bars);
  /** 每条反馈的「撤销窗口」定时器，页面卸载时统一清理，避免内存泄漏 */
  const undoTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** 类目偏好上云的防抖定时器：连续浏览时合并成一次上报 */
  const affinitySyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 骨架屏延时器 + 存活标记：useDidShow 反复触发时要能取消上一轮定时器 */
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  /** 请求序号：快速切页时让旧请求的结果/清理逻辑失效，避免旧数据覆盖新数据 */
  const loadSeq = useRef(0);
  /** 最近一次**成功**加载完成时间：useDidShow 据此做 60s 新鲜窗口判断 */
  const lastLoadedAt = useRef(0);
  /** 是否已有数据：有数据时切回 tab 不再挂骨架屏。
   *  ⚠️ 必须用 ref 而非 items.length —— load 是 [] 依赖，直接读 items 会永远读到初值 0。 */
  const hasDataRef = useRef(false);

  // N-02：屏蔽规则（来源 + 话题标签）与半屏选择器状态
  const [blockRules, setBlockRules] = useState<BlockRule[]>(() => readBlockRules());
  const [blockTarget, setBlockTarget] = useState<HotspotNews | null>(null);
  const [blockOptions, setBlockOptions] = useState<BlockOptionGroups>({ source: [], tag: [] });

  // C-03 内容侧：右上角常驻「关闭个性化推荐」入口（与「我的」页开关共享 mb_personalization）
  const [personalOn, setPersonalOn] = useState<boolean>(() => getPersonalization());
  const { refreshUsage, profile } = useUserStore();

  // 竞品分析 L2/X11 读取侧：偏好单次读取（设置页改后重进页面生效，与 storage 读写约定一致）
  const [aiFilterEnabled] = useState(() => readPrefs().aiFilterEnabled);
  const [minorMode] = useState(() => readPrefs().minorMode);
  // 竞品分析 X5：「为什么推荐给你」按条目展开态（默认收起，界面克制）
  const [expandedReasons, setExpandedReasons] = useState<Record<string, boolean>>({});

  // AI 精选（手动触发）：兴趣画像 = 手动标签 + 自定义关键词；结果只增不改，不阻塞原始列表
  const [aiInterests, setAiInterests] = useState<string[]>(() => {
    try {
      return Taro.getStorageSync(INTERESTS_KEY) || [];
    } catch {
      return [];
    }
  });
  const [aiCustom, setAiCustom] = useState<string>(() => {
    try {
      return Taro.getStorageSync(INTERESTS_CUSTOM_KEY) || '';
    } catch {
      return '';
    }
  });
  const [aiEditing, setAiEditing] = useState(false);
  const [aiPicks, setAiPicks] = useState<HotspotNews[] | null>(null);
  const [aiSummary, setAiSummary] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  // 类目偏好闭环的展示态：与 storage 同源，学到新偏好后立即反映到 AI 精选面板
  const [affinityCats, setAffinityCats] = useState<string[]>(() => getTopCategories(3));
  // 偏好学习 A/B 效果：与统计存储同源，记一次 impression/hit 后刷新即可让面板那行立即更新
  const [abSummary, setAbSummary] = useState<AffinityExperimentSummary>(() =>
    getAffinityExperimentSummary()
  );

  const toggleInterest = (tag: string) =>
    setAiInterests((prev) =>
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag].slice(0, 8)
    );

  const saveInterests = () => {
    const custom = aiCustom.trim();
    setAiCustom(custom);
    setAiEditing(false);
    try {
      Taro.setStorageSync(INTERESTS_KEY, aiInterests);
      Taro.setStorageSync(INTERESTS_CUSTOM_KEY, custom);
    } catch (err) {
      console.warn('[LibraryPage] save interests failed:', err);
    }
    Taro.showToast({ title: t('library.aiSaved'), icon: 'none', duration: 1200 });
  };

  /** 记录信号后同步展示态，保证「面板上显示的偏好」与「回灌给 AI 的偏好」始终一致 */
  const syncAffinity = () => setAffinityCats(getTopCategories(3));

  /** 记录 A/B 结果后同步展示态（impression / hit 变化后那一行立即刷新） */
  const syncAb = () => setAbSummary(getAffinityExperimentSummary());

  /**
   * 上报类目偏好摘要到云端。隐私最小化：只传 exportAffinityForSync() 的「类目名 + 分数」
   * 摘要，逐条原始行为记录不出本机。**失败静默降级**（apiSaveAffinity 内部已吞异常并返回
   * false），云同步不可用不影响任何本地行为与 UI。H5 无云函数通道时是 no-op。
   */
  const pushAffinity = () => {
    // 原名 items，会遮蔽本页的 items 状态（收藏列表），已改名以免误读。
    const payload = exportAffinityForSync();
    if (!payload.length) return;
    apiSaveAffinity(payload).catch(() => {
      /* 静默：上云失败不影响本地偏好 */
    });
  };

  /** 防抖上报：连续点击/反馈只在停下来 AFFINITY_SYNC_DEBOUNCE_MS 后打一次云函数 */
  const scheduleAffinitySync = () => {
    if (affinitySyncTimer.current) clearTimeout(affinitySyncTimer.current);
    affinitySyncTimer.current = setTimeout(() => {
      affinitySyncTimer.current = null;
      pushAffinity();
    }, AFFINITY_SYNC_DEBOUNCE_MS);
  };

  /** 兴趣画像信号：👍 反馈过的资讯标题 + 最近浏览标题（随请求带给 AI 参考，不展示） */
  const readSignals = (): string[] => {
    const upTitles = Object.entries(feedbackMap)
      .filter(([, v]) => v === 'up')
      .map(([id]) => visibleNews.find((n) => n.id === id)?.title || '');
    let history: { title: string }[] = [];
    try {
      history = Taro.getStorageSync(HISTORY_KEY) || [];
    } catch {
      /* 忽略 */
    }
    return [...upTitles, ...history.map((h) => h.title)].filter(Boolean).slice(0, 8);
  };

  const handleAiFilter = async () => {
    if (aiLoading) return;
    setAiLoading(true);
    // 【类目偏好闭环的消费点 + A/B 实验点】学习到的类目是否回灌给 AI，由当日分臂决定：
    //   treatment = 手选 + 学习结果（见 buildAiInterests），control = 只有手选。
    // 两臂其余参数（custom、signals）完全一致，唯一变量就是「有没有回灌学习结果」。
    const arm = pickAffinityArm();
    const learned = getTopCategories(3);
    const interests = buildAiInterests(arm, aiInterests, learned);
    // 无论哪一臂都要记 impression：对照组也要记下「若启用学习会是哪些类目」，
    // 否则两臂没有同一个命中率口径，实验无法比较。
    recordAffinityImpression(arm, learned);
    setAffinityCats(learned);
    syncAb();
    const res = await apiAiNewsFilter(visibleNews, interests, aiCustom.trim(), readSignals());
    setAiLoading(false);
    if (!res) {
      Taro.showToast({ title: t('library.aiFail'), icon: 'none' });
      return;
    }
    setAiPicks(res.items);
    setAiSummary(res.summary);
    if (res.items.length) logActivity('✨', `AI 精选资讯 ${res.items.length} 条`);
    // A/B 归因（条目级曝光）：记下本次**实际展示了哪些条目**，让后续点击能按条目确证而非只看类目。
    // id 缺失/非字符串的脏条目不进存储（recordAffinityExposure 内部还会再收窄一次）。
    recordAffinityExposure(
      arm,
      res.items
        .filter((it) => !!it && typeof it.id === 'string' && it.id.length > 0)
        .map((it) => ({ id: it.id, category: categoryOf(it.tags) }))
    );
  };

  /** 清除类目偏好：清存储 → 立即清空面板那一行（局部态）→ 同步清云端摘要 → toast */
  const handleResetAffinity = () => {
    resetAffinity();
    setAffinityCats([]);
    // 必须同时清掉云端摘要：否则本地清空后「本地为空」正好满足合并条件，
    // 下次启动会把云端旧摘要合并回来，让「清除」看起来失效。空数组即清空信号。
    if (affinitySyncTimer.current) {
      clearTimeout(affinitySyncTimer.current);
      affinitySyncTimer.current = null;
    }
    apiSaveAffinity([]).catch(() => {
      /* 静默：云端清不掉也不影响本地已清除的状态 */
    });
    Taro.showToast({ title: t('library.affinityResetDone'), icon: 'none' });
  };

  /** 重置 A/B 统计：清统计计数 → 刷新该行（样本归零后自动回到「样本不足」）→ toast */
  const handleResetAb = () => {
    resetAffinityExperiment();
    syncAb();
    Taro.showToast({ title: t('library.abResetDone'), icon: 'none' });
  };

  /**
   * 挂载时拉取云端偏好摘要并合并：只有本地完全没有记录时才采用远端（换设备/重装恢复），
   * 本地有记录一律保留本地（远端可能是旧快照，不能覆盖刚产生的行为）。
   * 失败静默降级（apiGetAffinity 返回 null），不影响本地任何状态。
   */
  useEffect(() => {
    let alive = true;
    apiGetAffinity()
      .then((remote) => {
        if (!alive || remote === null) return;
        if (mergeRemoteAffinity(remote)) syncAffinity();
      })
      .catch(() => {
        /* 静默：云同步不可用不影响本地偏好 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 页面隐藏时补一次上报：兜住「上了云但还没到防抖窗口就切走」的情况 */
  useDidHide(() => {
    if (affinitySyncTimer.current) {
      clearTimeout(affinitySyncTimer.current);
      affinitySyncTimer.current = null;
    }
    pushAffinity();
  });

  useEffect(() => {
    // 竞品分析 X9：转发回跳预填搜索关键词（?kw=），用户可直接再点「搜索」复现该条资讯
    const kw = Taro.getCurrentInstance().router?.params?.kw;
    if (kw) setKeyword(decodeURIComponent(String(kw)));
  }, []);

  /**
   * 加载资讯库 + 热点。
   * 从「挂载 effect」改为 useDidShow 驱动：去收件箱收藏一条再切回来，
   * 原来不会重新拉数据（页面没卸载），看到的一直是旧列表。
   */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    // 上一轮未结束又触发（快速切页）时，先取消旧的骨架屏定时器，避免两个定时器互抢
    if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
    // 骨架屏只服务「首屏 / 数据被清空后的冷启动」：已有数据时切回 tab 不闪骨架。
    // ⚠️ 用 hasDataRef 而不是 items.length：load 是 [] 依赖，读 items 会拿到闭包里的初值。
    if (!hasDataRef.current) {
      skeletonTimer.current = setTimeout(() => {
        if (aliveRef.current && seq === loadSeq.current) setShowSkeleton(true);
      }, SKELETON_DELAY_MS);
    }
    try {
      // 视频精选（2026-10-25）：失败/为空 = []，板块整个隐藏（免费增值内容不配打扰，见 apiVideoNews）
      const [lib, hotspot, vids] = await Promise.all([
        apiGetLibrary(),
        apiGetHotspot().catch(() => []),
        apiVideoNews()
      ]);
      if (!aliveRef.current || seq !== loadSeq.current) return;
      setItems(lib);
      setNews(hotspot);
      setVideos(vids);
      refreshRecent();
      consumeOpenHistoryFlag();
      // 数据来源元信息（mock/真机 webSearch 路径为 null，不显示来源栏）
      setHotMeta(getHotspotMeta());
      refreshUsage();
      // 只有**成功结束**才记时间：失败时保持旧值，下次切回 tab 仍会重试而不是被窗口挡住
      lastLoadedAt.current = Date.now();
      hasDataRef.current = lib.length > 0;
    } catch (err) {
      // 错误痕迹与是否已卸载无关，始终记录
      console.error('[LibraryPage] load failed:', err);
      if (aliveRef.current && seq === loadSeq.current) {
        Taro.showToast({ title: t('common.loadFailed'), icon: 'none' });
      }
    } finally {
      // 只有最新一轮请求才有资格清理定时器与收起骨架屏
      if (seq === loadSeq.current) {
        if (skeletonTimer.current) {
          clearTimeout(skeletonTimer.current);
          skeletonTimer.current = null;
        }
        if (aliveRef.current) {
          setLoading(false);
          setShowSkeleton(false);
        }
      }
    }
    // t 仅用于失败文案、refreshUsage 为 store 动作；语言切换无需重跑请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useDidShow(() => {
    // 最近浏览不受新鲜窗口限制：本页自己写的记录（点击资讯卡）与外部入口的展开标记都要即时反映
    refreshRecent();
    consumeOpenHistoryFlag();
    // 60s 新鲜窗口：页面没卸载时数据仍在，每次切回都重拉只会闪骨架 + 白耗一次热点请求。
    // 首次进入 lastLoadedAt=0，必然加载；失败不更新时间，下次切回会重试。
    if (Date.now() - lastLoadedAt.current < LOAD_FRESH_MS) return;
    void load();
  });

  /** 卸载时清掉延时器与存活标记：定时器不能在页面卸载后再 setState */
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      if (skeletonTimer.current) {
        clearTimeout(skeletonTimer.current);
        skeletonTimer.current = null;
      }
    };
  }, []);

  /** 竞品分析 X11：命中屏蔽关键词的条目（tag 包含「财经/股票/投资/社会」任一即命中） */
  const hitMinorBlock = (item: HotspotNews) =>
    item.tags.some((tg) => MINOR_BLOCK_KEYWORDS.some((kw) => tg.includes(kw)));

  /** N-02：按屏蔽清单过滤后的可见资讯（单一数据源，下方所有派生都基于它） */
  const visibleNews = useMemo(() => filterBlocked(news, blockRules), [news, blockRules]);

  /** 竞品分析 X11：未成年人模式下的最终可见列表（在屏蔽清单之上再过滤敏感话题） */
  const minorVisibleNews = useMemo(
    () => (minorMode ? visibleNews.filter((n) => !hitMinorBlock(n)) : visibleNews),
    [visibleNews, minorMode]
  );

  const tags = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => item.tags.forEach((tag) => set.add(tag)));
    return ['全部', ...Array.from(set)];
  }, [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (activeTag === '全部' || item.tags.includes(activeTag)) &&
          (!keyword ||
            item.title.includes(keyword) ||
            item.summary.includes(keyword) ||
            item.tags.some((tag) => tag.includes(keyword)))
      ),
    [items, activeTag, keyword]
  );

  /** 资讯分类频道（F29）：全部 + 出现过的类目（X11：基于门控后列表）。
   *  两处刻意的改动（2026-09-28 扩源后）：
   *  1) **按条目数降序**，不再是插入序 —— 插入序取决于抓取返回顺序，等于「最先遇到的 8 个」，
   *     而不是「最有内容的 8 个」；源清单扩容后这个偏差会直接暴露给用户。
   *  2) **去掉 slice(0, 8)** —— 类目从 9 个扩到 18 个后，截断 8 个意味着有 10 个类目在界面上
   *     完全点不到，「多元化」在 UI 上等于没做。chip 行本就是横向 ScrollView，不做任意上限。 */
  const newsTags = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const n of minorVisibleNews) for (const tg of n.tags) cnt.set(tg, (cnt.get(tg) || 0) + 1);
    return ['全部', ...[...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([tg]) => tg)];
  }, [minorVisibleNews]);

  const newsFiltered = useMemo(
    () =>
      minorVisibleNews.filter(
        (n) =>
          (activeNewsTag === '全部' || n.tags.includes(activeNewsTag)) &&
          (!keyword || n.title.includes(keyword) || n.summary.includes(keyword))
      ),
    [minorVisibleNews, activeNewsTag, keyword]
  );

  const handleCopy = (item: CollectionItem) => {
    Taro.setClipboardData({
      data: `${item.title}\n${item.summary}`,
      success: () => Taro.showToast({ title: '摘要已复制', icon: 'success' })
    }).catch((err) => console.error('[LibraryPage] copy failed:', err));
  };

  const handleNewsTap = (item: HotspotNews) => {
    recordBrowseHistory({ id: item.id, title: item.title, source: item.source });
    // 类目偏好学习（点击 = 弱信号）；存下来的类目会在 handleAiFilter 里回灌给 AI 精选
    const category = categoryOf(item.tags);
    recordCategorySignal(category, 'tap');
    // A/B 归因：优先按条目归因（itemId ∈ 本次曝光 ids → 确认「展示过且被点了」），
    // 不在曝光内时退回类目级判据；两条路径都受归因窗口约束
    recordAffinityOutcome(category, item.id);
    syncAffinity();
    syncAb();
    // 云同步：防抖合并，避免每次点击都打云函数
    scheduleAffinitySync();
    logActivity('🔥', `浏览热点：${item.title.slice(0, 14)}`);
    // 浏览历史并入本页（2026-10-25）：刚记录的立刻反映到「最近浏览」区
    refreshRecent();

    // ★ 2026-10-25 演进：先开**站内文章视图**（读源 feed 自带的摘要，合规口径「不转载正文」
    // 不变——不另行抓原文页），想看全文再点「阅读原文」→ openExternalPage（见 handleReadOriginal）。
    // 2026-10-24 修的「点了没反应」问题由本视图承接：卡片点击必有下文。
    setArticle(item);
  };

  /** 「阅读原文」：与 2026-10-24 修的打开语义完全一致（H5 新标签 / weapp 复制链接告知 / url 缺失如实提示），
   *  只是从 handleNewsTap 挪进文章视图 —— 原实现逻辑原样保留，别在重构里丢行为。 */
  const handleReadOriginal = (item: HotspotNews) => {
    if (!item.url) {
      Taro.showToast({ title: '该条暂无原文链接', icon: 'none', duration: 1800 });
      return;
    }
    void openExternalPage(item.url)
      .then((r) => {
        if (r === 'copied') {
          Taro.showToast({ title: `来源：${item.source}，链接已复制`, icon: 'none', duration: 2200 });
        } else if (r === 'failed') {
          Taro.showToast({ title: '该条链接无法打开', icon: 'none', duration: 1800 });
        }
        // 'opened'（H5 新标签已开）：不再弹 toast 干扰
      })
      .catch(() => {
        /* openExternalPage 内部已降级，不叠加错误弹窗 */
      });
  };

  /** 点封面图全屏预览（F29）；不触发卡片浏览行为 */
  const handleNewsImageTap = (item: HotspotNews) => {
    if (!item.image) return;
    Taro.previewImage({ urls: [item.image] }).catch((err) =>
      console.warn('[LibraryPage] previewImage failed:', err)
    );
  };

  /** 竞品分析 X9 H5 降级：复制「标题（来自 App·[AI 精选]）+ 链接」到剪贴板（不引 canvas）。
   *  「·AI 精选」后缀带门控（合规）：仅 AI 精选面板产出（确经 LLM 挑选）的条目才挂，
   *  与卡片 L1「AI」角标（showAiBadge）同口径；普通 RSS 热点摘掉该后缀，避免虚假归因。 */
  const handleShareNewsH5 = (item: HotspotNews, aiPicked: boolean) => {
    const from = aiPicked ? `（来自${APP_NAME}·AI 精选）` : `（来自${APP_NAME}）`;
    const text = `${item.title}${from}\n${item.url || ''}`;
    Taro.setClipboardData({
      data: text,
      success: () => Taro.showToast({ title: '链接已复制，去粘贴分享吧', icon: 'none' })
    }).catch((err) => console.warn('[LibraryPage] share copy failed:', err));
  };

  /** 竞品分析 X9 小程序端：条目转发标题/路径（点击卡片上「分享」按钮时 res.target 携带 data-* 参数）。
   *  AI 标识门控同 handleShareNewsH5：dataset.newsAi==='1'（卡片 L1「AI」角标亮起）才挂「·AI 精选」。 */
  useShareAppMessage((res) => {
    const ds = (res?.target as { dataset?: { newsTitle?: string; newsUrl?: string; newsAi?: string } } | undefined)
      ?.dataset;
    if (ds?.newsTitle) {
      const from = ds.newsAi === '1' ? `（来自${APP_NAME}·AI 精选）` : `（来自${APP_NAME}）`;
      return {
        title: `${ds.newsTitle}${from}`,
        path: `${LIBRARY_PAGE_PATH}?kw=${encodeURIComponent(ds.newsTitle)}`
      };
    }
    return { title: t('library.hotTitle'), path: LIBRARY_PAGE_PATH };
  });

  /** 全网搜索（F29）：搜索键触发；云端无结果时回退本地热点过滤 */
  /** 搜索请求序号：用来丢弃「过期回包」。
   *  没有它时：连按两次搜索，慢的旧关键词响应会盖掉新关键词的结果；
   *  点「清空」也不取消在途请求，旧结果会自己冒回来。 */
  const searchSeqRef = useRef(0);

  const handleNewsSearch = async () => {
    const kw = keyword.trim();
    // 先占号：此后任何新搜索或清空都会让本次请求作废
    const seq = ++searchSeqRef.current;
    if (!kw) {
      setSearchMode(false);
      setSearchResults([]);
      return;
    }
    setSearchMode(true);
    setSearching(true);
    const online = await apiNewsSearch(kw);
    // 期间已发起新搜索或点了清空 → 本次结果作废，不许写回 state
    if (seq !== searchSeqRef.current) return;
    const local = minorVisibleNews.filter(
      (n) => n.title.includes(kw) || n.summary.includes(kw) || n.tags.some((tg) => tg.includes(kw))
    );
    // 联网结果与本地兜底结果统一过一遍屏蔽清单
    setSearchResults(filterBlocked(online && online.length ? online : local, blockRules));
    setSearching(false);
    if (online && online.length) {
      logActivity('🔎', `全网搜索：${kw.slice(0, 14)}`);
    }
  };

  /** 清空关键词并退出全网搜索模式 */
  const handleClearSearch = () => {
    // 作废在途请求 + 收掉 loading：否则清空后旧结果会自己冒回来，且转圈不会停
    searchSeqRef.current += 1;
    setKeyword('');
    setSearchMode(false);
    setSearchResults([]);
    setSearching(false);
  };

  /** 反馈写盘：统一 try/catch，失败只 warn 不阻塞 */
  const persistFeedback = (nextMap: Record<string, FeedbackValue>) => {
    try {
      Taro.setStorageSync(NEWS_FEEDBACK_KEY, nextMap);
    } catch (err) {
      console.warn('[LibraryPage] persist newsFeedback failed:', err);
    }
  };

  /** N-01：到点后淡出「撤销」入口（反馈文案保留，重进页面也不再展示撤销） */
  const scheduleUndoHide = (id: string) => {
    const timer = undoTimers.current[id];
    if (timer) clearTimeout(timer);
    undoTimers.current[id] = setTimeout(() => {
      delete undoTimers.current[id];
      setFeedbackBars((prev) => {
        const bar = prev[id];
        if (!bar || !bar.undoVisible) return prev;
        return { ...prev, [id]: { ...bar, undoVisible: false } };
      });
    }, FEEDBACK_UNDO_WINDOW_MS);
  };

  /** 资讯反馈（F22 + N-01）：👍 有用 / 👎 不感兴趣；再点一次取消；本地持久化 + 云端落库 */
  const handleNewsFeedback = (item: HotspotNews, value: FeedbackValue) => {
    const current = feedbackMap[item.id];
    const next = current === value ? undefined : value;
    const nextMap = { ...feedbackMap };
    if (next) nextMap[item.id] = next;
    else delete nextMap[item.id];

    // 同步 setState：下一帧即呈现已选态与反馈条，远快于 PRD 要求的 200ms
    setFeedbackMap(nextMap);
    setFeedbackBars((prev) => {
      const bars = { ...prev };
      if (next) bars[item.id] = { value: next, prev: current, undoVisible: true };
      else delete bars[item.id];
      return bars;
    });
    persistFeedback(nextMap);

    if (next) {
      scheduleUndoHide(item.id);
    } else if (undoTimers.current[item.id]) {
      clearTimeout(undoTimers.current[item.id]);
      delete undoTimers.current[item.id];
    }

    if (next) {
      // 反馈是强于点击的信号（👍 加权 / 👎 抵消）。本函数是**切换语义**（再点一次 = 取消），
      // 所以只在 next 有值时记一次；取消（next === undefined）时不记，避免「点两次 = 双倍负分」。
      recordCategorySignal(categoryOf(item.tags), next);
      syncAffinity();
      scheduleAffinitySync();
      logActivity(next === 'up' ? '👍' : '👎', `资讯反馈：${item.title.slice(0, 14)}`);
      Taro.showToast({ title: t('library.feedbackSaved'), icon: 'none', duration: 1200 });
      // 云端落库（真机生效；取消反馈只改本地，云端按最新一条聚合）
      // 失败静默：apiNewsFeedback 内部已 catch 并记录云同步失败、永不 reject（services/api.ts:144），
      // 此处仅为兜底；本地反馈已生效，线上落库失败无需打扰用户。
      apiNewsFeedback(item.id, next).catch(() => {});
    }
  };

  /**
   * N-01：5s 内撤销 —— 回滚到点击前的评价状态。
   * 存在旧值时用旧值覆盖云端聚合（回滚权重）；原本未评价时云端无「取消」语义，仅回滚本地。
   */
  const handleUndoFeedback = (item: HotspotNews) => {
    const bar = feedbackBars[item.id];
    if (!bar) return;
    if (undoTimers.current[item.id]) {
      clearTimeout(undoTimers.current[item.id]);
      delete undoTimers.current[item.id];
    }
    const nextMap = { ...feedbackMap };
    if (bar.prev) nextMap[item.id] = bar.prev;
    else delete nextMap[item.id];
    setFeedbackMap(nextMap);
    setFeedbackBars((prev) => {
      const bars = { ...prev };
      if (bar.prev) bars[item.id] = { value: bar.prev, prev: undefined, undoVisible: false };
      else delete bars[item.id];
      return bars;
    });
    persistFeedback(nextMap);
    // 失败静默：同 handleFeedback —— apiNewsFeedback 内部已吞并记录云同步失败、永不 reject，
    // 本地回滚已生效，云端聚合回滚失败无需打扰用户。
    if (bar.prev) apiNewsFeedback(item.id, bar.prev).catch(() => {});
  };

  /** 页面卸载时清理全部撤销定时器 */
  useEffect(
    () => () => {
      Object.values(undoTimers.current).forEach((timer) => clearTimeout(timer));
    },
    []
  );

  /* ------------------------ N-02 不再展示此类 ------------------------ */

  /** 打开半屏选择器：默认勾选当前条目的来源与主标签 */
  const openBlockPicker = (item: HotspotNews) => {
    setBlockTarget(item);
    setBlockOptions(buildBlockOptions(visibleNews, item));
  };

  const closeBlockPicker = () => {
    setBlockTarget(null);
    setBlockOptions({ source: [], tag: [] });
  };

  const handleToggleBlockOption = (key: string) => {
    setBlockOptions((prev) => toggleBlockOption(prev, key));
  };

  /** 确认屏蔽：写入清单 → 立即移除命中条目 → toast（可在资讯偏好中恢复） */
  const confirmBlock = () => {
    const target = blockTarget;
    if (!target) return;
    const drafts = collectBlockDrafts(blockOptions);
    if (!drafts.length) return;

    const nextRules = addBlockRules(drafts);
    setBlockRules(nextRules);
    // 该条即时移除：热点列表 / AI 精选 / 搜索结果三处同时生效
    setNews((prev) => filterBlocked(prev, nextRules));
    setSearchResults((prev) => filterBlocked(prev, nextRules));
    setAiPicks((prev) => (prev ? filterBlocked(prev, nextRules) : prev));

    // 一并清掉该条的反馈记录，避免恢复后残留旧的降权标记
    const nextMap = { ...feedbackMap };
    delete nextMap[target.id];
    setFeedbackMap(nextMap);
    setFeedbackBars((prev) => {
      const bars = { ...prev };
      delete bars[target.id];
      return bars;
    });
    persistFeedback(nextMap);
    if (undoTimers.current[target.id]) {
      clearTimeout(undoTimers.current[target.id]);
      delete undoTimers.current[target.id];
    }

    closeBlockPicker();
    logActivity('🚫', t('library.blockToast'));
    Taro.showToast({ title: t('library.blockToast'), icon: 'none', duration: 2000 });
  };

  const renderBlockOptionGroup = (
    options: BlockOptionGroups['source'],
    dimensionTitle: string
  ) => (
    <>
      <Text className={styles.blockGroupTitle}>{dimensionTitle}</Text>
      {options.length ? (
        <View className={styles.blockOptions}>
          {options.map((option) => (
            <Text
              key={option.key}
              className={classnames(styles.blockOption, option.selected && styles.blockOptionActive)}
              onClick={() => handleToggleBlockOption(option.key)}
            >
              {option.value}
            </Text>
          ))}
        </View>
      ) : (
        <Text className={styles.blockEmpty}>—</Text>
      )}
    </>
  );

  /** N-02 半屏屏蔽选择器（来源 / 话题标签 两维度多选） */
  const renderBlockSheet = () => {
    const selectedCount = countBlockSelected(blockOptions);
    return (
      <View className={styles.blockMask} onClick={closeBlockPicker}>
        <View className={styles.blockSheet} onClick={(e) => e.stopPropagation()}>
          <View className={styles.blockSheetHead}>
            <Text className={styles.blockSheetTitle}>{t('library.blockTitle')}</Text>
            <Text className={styles.blockSheetClose} onClick={closeBlockPicker}>
              ✕
            </Text>
          </View>
          <ScrollView scrollY className={styles.blockBody}>
            {renderBlockOptionGroup(blockOptions.source, t('library.blockSource'))}
            {renderBlockOptionGroup(blockOptions.tag, t('library.blockTag'))}
          </ScrollView>
          <View className={styles.blockFoot}>
            <Text
              className={classnames(styles.blockBtn, styles.blockCancelBtn)}
              onClick={closeBlockPicker}
            >
              {t('cancel')}
            </Text>
            <Text
              className={classnames(
                styles.blockBtn,
                styles.blockConfirmBtn,
                selectedCount === 0 && styles.blockConfirmDisabled
              )}
              onClick={() => {
                if (selectedCount > 0) confirmBlock();
              }}
            >
              {t('library.blockEntry')}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  /* ------------------- C-03 内容侧个性化拒绝入口 ------------------- */

  const handlePersonalOff = () => {
    setPersonalization(false);
    setPersonalOn(false);
    Taro.showToast({ title: t('library.personalOffToast'), icon: 'none', duration: 2000 });
  };

  /** PRO 角标 / 空态 CTA 点击：跳 mine 订阅页（switchTab 因为 mine 是 TabBar） */
  const handleGoSubscribe = () => {
    Taro.switchTab({ url: '/pages/mine/index' }).catch(() => {
      Taro.navigateTo({ url: '/pages/mine/index' });
    });
  };

  /** N-01 反馈条：降权/加权文案 + 5s 内「撤销」+（负反馈时）「不再展示此类」 */
  const renderFeedbackBar = (item: HotspotNews) => {
    const bar = feedbackBars[item.id];
    if (!bar) return null;
    return (
      <View className={styles.feedbackBar} onClick={(e) => e.stopPropagation()}>
        <Text className={styles.feedbackBarText}>
          {bar.value === 'up' ? t('library.feedbackUpDone') : t('library.feedbackDownDone')}
        </Text>
        <View className={styles.feedbackBarActions}>
          {bar.undoVisible ? (
            <Text className={styles.feedbackBarUndo} onClick={() => handleUndoFeedback(item)}>
              {t('library.undo')}
            </Text>
          ) : null}
          {bar.value === 'down' ? (
            <Text className={styles.feedbackBarBlock} onClick={() => openBlockPicker(item)}>
              {t('library.blockEntry')}
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  /** 视频卡（2026-10-25）：B 站热榜视频，横滑条。封面 + 时长角标 + 播放量；
   *  点击走 handleNewsTap 同一链路（历史/归因/站内文章视图），阅读原文进 B 站页面。 */
  const renderVideoCard = (item: HotspotNews) => {
    const playText =
      typeof item.play === 'number' && item.play >= 10000
        ? `${(item.play / 10000).toFixed(1)}万`
        : typeof item.play === 'number'
          ? String(item.play)
          : '';
    return (
      <View key={item.id} className={styles.videoCard} onClick={() => handleNewsTap(item)}>
        <View className={styles.videoCoverWrap}>
          {item.image ? (
            <Image src={item.image} mode='aspectFill' lazyLoad className={styles.videoCover} />
          ) : null}
          {item.duration ? <Text className={styles.videoDuration}>{item.duration}</Text> : null}
        </View>
        <Text className={styles.videoTitle}>{item.title}</Text>
        <Text className={styles.videoMeta}>
          {item.source}
          {playText ? ` · ▶ ${playText}` : ''}
        </Text>
      </View>
    );
  };

  /** 站内文章视图（2026-10-25）：正文 = 源 feed 自带的摘要/描述（content，缺失退回 summary），
   *  **不抓取正文页** —— 合规口径「不转载正文只出摘要」不变；想看全文走「阅读原文」。 */
  const renderArticleView = (item: HotspotNews) => {
    // alsoFrom 从这里取（与卡片 multiSourceCount 同源）：文章视图需要具体媒体名列表
    const alsoFrom = (item as { alsoFrom?: unknown }).alsoFrom;
    const alsoFromList = Array.isArray(alsoFrom) ? (alsoFrom as string[]) : [];
    return (
    <View className={styles.blockMask} onClick={() => setArticle(null)}>
      <View className={styles.articleSheet} onClick={(e) => e.stopPropagation()}>
        <View className={styles.articleHead}>
          <Text className={styles.articleTitle}>{item.title}</Text>
          <Text className={styles.articleMeta}>
            {item.source}
            {item.createTime ? ` · ${item.createTime.slice(0, 10)}` : ''}
          </Text>
          {/* ② 多来源并列（竞品倒推 2026-10-25，Particle 模式）：同一事件的其他来源媒体名。
              数据（alsoFrom）服务端早就在传，此前只在卡片角落显示条数 —— 文章视图里
              把"还有谁在报"直接列出来，多源可交叉核验，提高 AI 时代的可信度。 */}
          {alsoFromList.length > 0 ? (
            <Text className={styles.articleAlsoFrom}>
              {t('library.articleAlsoFrom', { sources: alsoFromList.slice(0, 4).join(' · ') })}
            </Text>
          ) : null}
        </View>
        {item.image ? (
          <Image src={item.image} mode='widthFix' lazyLoad className={styles.articleImage} />
        ) : null}
        <Text className={styles.articleBody}>{item.content || item.summary}</Text>
        <Text className={styles.articleSourceNote}>{t('library.articleSourceNote')}</Text>
        <View className={styles.articleCta}>
          {item.url ? (
            <Button
              className={styles.articleCtaBtn}
              onClick={() => {
                setArticle(null);
                handleReadOriginal(item);
              }}
            >
              <Text className={styles.articleCtaText}>{t('library.readOriginal')}</Text>
            </Button>
          ) : null}
          <Button className={styles.articleCloseBtn} onClick={() => setArticle(null)}>
            <Text className={styles.articleCtaText}>{t('cancel')}</Text>
          </Button>
        </View>
      </View>
    </View>
    );
  };

  /** 资讯卡片（原始列表与 AI 精选共用；showReason 时视为 AI 筛选条目：L1 角标 + X5 推荐理由） */
  const renderNewsCard = (item: HotspotNews, showReason: boolean) => {
    const fb = feedbackMap[item.id];    const showAiBadge = showReason || !!item.aiReason;
    const reasonExpanded = !!expandedReasons[item.id];
    // 跨源同事件合并（服务端可选字段 alsoFrom）：类型可能尚未声明该字段，
    // 且运行时可能缺失或非数组 —— 用 unknown + Array.isArray 收窄，不做任何假设。
    const alsoFrom = (item as { alsoFrom?: unknown }).alsoFrom;
    const multiSourceCount = Array.isArray(alsoFrom) ? alsoFrom.length : 0;
    return (
      <View key={item.id} className={styles.newsCard} onClick={() => handleNewsTap(item)}>
        {item.image ? (
          <Image
            src={item.image}
            mode='aspectFill'
            lazyLoad
            className={styles.newsImage}
            // 无障碍（2026-10-12）：配图是**独立可点**的预览入口，读屏用户需要名字。
            // Taro 的 Image 没有 alt 属性，H5 端唯一能透传到真实 <img> 的入口是 nativeProps
            // （见 @tarojs/components/dist/esm/image-*.js 的 render：h("img", {...nativeProps})），
            // 且 nativeProps 仅 h5 支持，故只在 H5 端传。取新闻标题作为等价文本。
            nativeProps={isH5 ? { alt: item.title } : undefined}
            onClick={(e) => {
              e.stopPropagation();
              handleNewsImageTap(item);
            }}
          />
        ) : null}
        <View className={styles.newsTitleRow}>
          <Text className={styles.newsTitle}>{item.title}</Text>
          {/* 竞品分析 L1：AI 筛选条目标题旁「AI」小角标 */}
          {showAiBadge ? <Text className={styles.aiBadge}>AI</Text> : null}
        </View>
        <Text className={styles.newsSummary}>{item.summary}</Text>
        {/* 竞品分析 X1：Why it matters（缺失不渲染，不占位） */}
        {item.whyItMatters ? (
          <Text className={styles.whyItMatters}>{item.whyItMatters}</Text>
        ) : null}
        {/* 竞品分析 X5：「为什么推荐给你」可点击展开，内容 = aiReason（默认收起，界面克制） */}
        {showReason && item.aiReason ? (
          <View className={styles.aiReasonWrap}>
            <Text
              className={styles.whyToggle}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedReasons((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
              }}
            >
              {t('library.whyTitle')}
              {reasonExpanded ? ' ▲' : ' ▼'}
            </Text>
            {reasonExpanded ? (
              <Text className={styles.whyReasonText}>{item.aiReason}</Text>
            ) : null}
          </View>
        ) : null}
        <View className={styles.newsMeta}>
          <Text className={styles.newsSource}>来源 · {item.source}</Text>
          {/* 同事件多来源标注：仅在 alsoFrom 非空时显示（n = 其他来源数 + 1 个本来源） */}
          {multiSourceCount > 0 ? (
            <Text className={styles.newsSource}>
              {t('library.multiSource', { n: multiSourceCount + 1 })}
            </Text>
          ) : null}
          {/* 缺发布时间就不显示（2026-10-26）：fromNow(undefined) 里 dayjs(undefined)=当前时间，
              会返回「刚刚」—— 热榜/板块条目本就没有发布时间，此前被一致显示成「刚刚发布」，
              属于给用户假信息。RSS 条目本轮起带 createTime，正常显示真实相对时间。 */}
          {item.createTime ? (
            <Text className={styles.newsTime}>{fromNow(item.createTime)}</Text>
          ) : null}
        </View>
        <View className={styles.feedbackRow} onClick={(e) => e.stopPropagation()}>
          <Text
            className={classnames(styles.feedbackBtn, fb === 'up' && styles.feedbackSelected)}
            onClick={() => handleNewsFeedback(item, 'up')}
          >
            👍 {t('library.feedbackUp')}
          </Text>
          <Text
            className={classnames(styles.feedbackBtn, fb === 'down' && styles.feedbackSelected)}
            onClick={() => handleNewsFeedback(item, 'down')}
          >
            👎 {t('library.feedbackDown')}
          </Text>
          {/* 竞品分析 X9：有原文链接的条目提供分享——weapp 原生转发 / H5 复制链接降级 */}
          {item.url ? (
            isWeapp ? (
              <Button
                className={styles.shareBtn}
                openType='share'
                data-news-title={item.title}
                data-news-url={item.url}
                data-news-ai={showAiBadge ? '1' : ''}
              >
                分享
              </Button>
            ) : (
              <Text className={styles.shareBtn} onClick={() => handleShareNewsH5(item, showAiBadge)}>
                分享
              </Text>
            )
          ) : null}
        </View>
        {renderFeedbackBar(item)}
      </View>
    );
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {/* 云端不可用、已回退本地/演示实现时如实提示（诚实性，来源 briefing.degraded） */}
      <DemoDataHint />
      {/* 竞品分析 X11：未成年人模式低调横幅 */}
      {minorMode ? (
        <View className={styles.minorBanner}>
          <Text className={styles.minorBannerText}>{t('library.minorBanner')}</Text>
        </View>
      ) : null}
      <View className={styles.searchBar}>
        <Text className={styles.searchIcon}>🔍</Text>
        <Input
          className={styles.searchInput}
          value={keyword}
          placeholder={t('library.searchPlaceholder')}
          confirmType='search'
          onInput={(e) => setKeyword(e.detail.value)}
          onConfirm={() => handleNewsSearch()}
        />
        {keyword ? (
          <Text className={styles.searchGo} onClick={() => handleNewsSearch()}>
            {t('library.searchGo')}
          </Text>
        ) : null}
        {keyword ? (
          <Text className={styles.searchClear} onClick={handleClearSearch}>
            ✕
          </Text>
        ) : null}
      </View>

      {/* U-01：加载 >300ms 时显示热点流骨架（3 张资讯卡），快速命中缓存不显示 */}
      {loading && showSkeleton ? (
        <View className={styles.hotspot}>
          {[0, 1, 2].map((i) => (
            <NewsCardSkeleton key={i} />
          ))}
        </View>
      ) : null}

      {searchMode || newsFiltered.length > 0 ? (
        <View className={classnames(styles.hotspot, styles.contentFade)}>
          {/* C-03 内容侧：个性化推荐开启时，内容区右上角常驻拒绝入口 */}
          {personalOn && !searchMode ? (
            <View className={styles.personalRow}>
              <Text className={styles.personalOffEntry} onClick={handlePersonalOff}>
                {t('library.personalOffEntry')}
              </Text>
            </View>
          ) : null}
          <View className={styles.sectionBar}>
            <Text className={styles.sectionBarIcon}>{searchMode ? '🔎' : '🔥'}</Text>
            <Text className={styles.sectionBarTitle}>
              {searchMode ? `${t('library.searchOnlineTitle')} · ${keyword.trim().slice(0, 12)}` : t('library.hotTitle')}
            </Text>
            <Text className={styles.sectionBarHint}>{searchMode ? t('library.searchOnlineHint') : t('library.hotHint')}</Text>
          </View>
          {!searchMode && hotMeta ? (
            <View className={styles.dataMetaBar}>
              {/* 源名**必须限量**：登录态实测 640px 视口下 23 个源名铺满 4 行，
                  把首屏的资讯全挤走了（2026-10-12）。这里只列前 3 个 + 总数，
                  完整清单在「我的」页与 AI 标识说明里可查。 */}
              <Text className={styles.dataMetaText}>
                {t('library.dataUpdated')} {dayjs(hotMeta.updatedAt || Date.now()).format('MM-DD HH:mm')}
                {hotMeta.stale ? ` · ${t('library.dataStale')}` : ''}
                {(() => {
                  const okNames = hotMeta.sources.filter((s) => s.ok).map((s) => s.name);
                  if (!okNames.length) return '';
                  const shown = okNames.slice(0, 3).join('/');
                  const rest = okNames.length - 3;
                  return ` · ${t('library.dataSources')}${shown}${rest > 0 ? t('library.dataSourcesMore').replace('{n}', String(rest)) : ''}`;
                })()}
              </Text>
            </View>
          ) : null}
          {/* 竞品分析 L2：aiFilterEnabled=false 时不渲染 AI 精选面板（不展示 AI 筛选标记，列表即全部） */}
          {!searchMode && aiFilterEnabled ? (
            <View className={styles.aiPanel}>
              <View className={styles.aiHead}>
                <Text className={styles.aiHeadIcon}>✨</Text>
                <Text className={styles.aiHeadTitle}>{t('library.aiTitle')}</Text>
                <Text className={styles.aiHeadHint}>{t('library.aiHint')}</Text>
                <Text className={styles.aiEditBtn} onClick={() => setAiEditing(!aiEditing)}>
                  {aiEditing ? t('library.aiHide') : t('library.aiEdit')}
                </Text>
              </View>
              {/* 类目偏好闭环：把「学到了什么」摆在明面上（可一键清除）。
                  学习结果同时会经 handleAiFilter 回灌给 AI，界面与实际生效口径一致。 */}
              <View className={styles.aiTipRow}>
                <Text className={styles.aiTipText}>
                  {affinityCats.length
                    ? `${t('library.affinityTitle')} · ${t('library.affinityDesc', {
                        cats: affinityCats.map((c) => categoryLabel(c, t)).join('、')
                      })}`
                    : t('library.affinityEmpty')}
                </Text>
                {affinityCats.length ? (
                  <Text className={styles.aiEditBtn} onClick={handleResetAffinity}>
                    {t('library.affinityReset')}
                  </Text>
                ) : null}
              </View>
              {/* 偏好学习效果（A/B）：按天切换开关学习的一天 vs 不开关的一天，比两臂命中率。
                  样本不足时只提示「样本还太少」，不给结论（小样本下百分比没有意义）。 */}
              <View className={styles.aiTipRow}>
                <Text className={styles.aiTipText}>
                  {abSummary.enough
                    ? `${t('library.abTitle')} · ${t('library.abLine', {
                        a: Math.round(abSummary.treatment.rate * 100),
                        b: Math.round(abSummary.control.rate * 100),
                        n: abSummary.samples
                      })}`
                    : `${t('library.abTitle')} · ${t('library.abInsufficient')}`}
                </Text>
                <Text className={styles.aiEditBtn} onClick={handleResetAb}>
                  {t('library.abReset')}
                </Text>
              </View>
              {aiEditing ? (
                <View className={styles.aiEditor}>
                  <View className={styles.aiChips}>
                    {AI_PRESET_INTERESTS.map((tag) => (
                      <TagChip
                        key={tag}
                        label={tag}
                        active={aiInterests.includes(tag)}
                        onClick={() => toggleInterest(tag)}
                      />
                    ))}
                  </View>
                  <Input
                    className={styles.aiCustomInput}
                    value={aiCustom}
                    placeholder={t('library.aiCustomPlaceholder')}
                    onInput={(e) => setAiCustom(e.detail.value)}
                  />
                  <Text className={styles.aiSaveBtn} onClick={saveInterests}>
                    {t('library.aiSave')}
                  </Text>
                </View>
              ) : null}
              {aiLoading ? (
                <View className={styles.aiTipRow}>
                  <Text className={styles.aiTipText}>{t('library.aiLoading')}</Text>
                </View>
              ) : null}
              {!aiLoading && !aiPicks ? (
                <View className={styles.aiTipRow}>
                  <Text className={styles.aiTipText}>{t('library.aiEmpty')}</Text>
                  <Text className={styles.aiGoBtn} onClick={handleAiFilter}>
                    {t('library.aiGenerate')}
                  </Text>
                </View>
              ) : null}
              {!aiLoading && aiPicks ? (
                <View className={styles.aiResult}>
                  {/* 竞品分析 X2：栏目署名（AI 精选顶部，小标题感） */}
                  <Text className={styles.curatorLine}>{t('library.curator')}</Text>
                  {/* 竞品分析 L1：AI 筛选显式说明 */}
                  <Text className={styles.aiNoteLine}>{t('library.aiFilteredNote')}</Text>
                  {aiSummary ? <Text className={styles.aiSummary}>{aiSummary}</Text> : null}
                  {/* 竞品分析 X11：AI 精选同样过未成年人话题门控 */}
                  {aiPicks.filter((item) => !minorMode || !hitMinorBlock(item)).length ? (
                    aiPicks
                      .filter((item) => !minorMode || !hitMinorBlock(item))
                      .map((item) => renderNewsCard(item, true))
                  ) : (
                    <Text className={styles.aiTipText}>{t('library.aiNone')}</Text>
                  )}
                  <Text className={styles.aiLabel}>{t('library.aiLabel')}</Text>
                  <Text className={styles.aiAgainBtn} onClick={handleAiFilter}>
                    {t('library.aiRegenerate')}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {/* 最近浏览（2026-10-25，IA 瘦身）：浏览历史从独立页并入热点 —— 在哪看的就在哪回看。
              无记录整段隐藏；默认折叠（一行摘要），展开才显示明细与清空。 */}
          {!searchMode && recent.length > 0 ? (
            <View className={styles.recentCard}>
              <View className={styles.recentHead} onClick={() => setRecentOpen(!recentOpen)}>
                <Text className={styles.recentIcon}>🕘</Text>
                <Text className={styles.recentTitle}>{t('library.recentTitle')}</Text>
                <Text className={styles.recentCount}>{recent.length}</Text>
                <Text className={styles.recentCaret}>{recentOpen ? '▾' : '›'}</Text>
              </View>
              {recentOpen ? (
                <View className={styles.recentList}>
                  {recent.map((h) => (
                    <View key={`${h.id}-${h.viewedAt}`} className={styles.recentItem}>
                      <View className={styles.recentItemBody}>
                        <Text className={styles.recentItemTitle}>{h.title}</Text>
                        {h.source ? <Text className={styles.recentItemSource}>{h.source}</Text> : null}
                      </View>
                      <Text className={styles.recentItemTime}>{fromNow(h.viewedAt)}</Text>
                    </View>
                  ))}
                  <Button className={styles.recentClear} onClick={handleClearRecent}>
                    {t('mine.clear')}
                  </Button>
                </View>
              ) : null}
            </View>
          ) : null}
          {/* 视频精选（2026-10-25）：webSearch action=videoNews 的 B 站热榜。
              空数组整段隐藏（apiVideoNews 失败也是 []），不显示空态不报错 —— 免费增值内容。 */}
          {!searchMode && videos.length > 0 ? (
            <View className={styles.sectionBar}>
              <Text className={styles.sectionBarIcon}>🎬</Text>
              <Text className={styles.sectionBarTitle}>{t('library.videoSectionTitle')}</Text>
            </View>
          ) : null}
          {!searchMode && videos.length > 0 ? (
            <ScrollView scrollX className={styles.videoScroll} showScrollbar={false} enhanced>
              {videos.map((v) => renderVideoCard(v))}
            </ScrollView>
          ) : null}
          {!searchMode && newsTags.length > 2 ? (
            <View className={styles.filterBar}>
              <ScrollView scrollX className={styles.chipScroll}>
                {newsTags.map((tag) => (
                  <TagChip
                    key={tag}
                    label={categoryLabel(tag, t)}
                    active={tag === activeNewsTag}
                    onClick={() => setActiveNewsTag(tag)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
          {searchMode && searching ? (
            <View className={styles.searchingTip}>
              <Text className={styles.searchingText}>{t('library.searchSearching')}</Text>
            </View>
          ) : null}
          {(searchMode ? searchResults : newsFiltered).map((item) => renderNewsCard(item, false))}
          {/* 竞品分析 L3：资讯列表底部常驻免责声明（次级色、小号、居中） */}
          <View className={styles.disclaimerFooter}>
            <Text className={styles.disclaimerText}>{t('common.disclaimer')}</Text>
          </View>
          {searchMode && !searching && searchResults.length === 0 ? (
            <EmptyState
              icon='🔎'
              title={t('library.searchEmpty')}
              hint={t('library.searchEmptyHint')}
            />
          ) : null}
        </View>
      ) : null}

      <View className={styles.sectionBar}>
        <Text className={styles.sectionBarIcon}>🔖</Text>
        <Text className={styles.sectionBarTitle}>{t('library.favTitle')}</Text>
        {/* PRO 角标：仅非订阅用户可见，点击跳订阅 */}
        {!profile?.subscribed ? (
          <Text className={styles.proBadge} onClick={handleGoSubscribe}>⚡ PRO</Text>
        ) : null}
        <Text className={styles.sectionBarHint}>{t('library.favHint')}</Text>
      </View>

      <View className={styles.filterBar}>
        <ScrollView scrollX className={styles.chipScroll}>
          {tags.map((tag) => (
            <TagChip
              key={tag}
              label={categoryLabel(tag, t)}
              active={tag === activeTag}
              onClick={() => setActiveTag(tag)}
            />
          ))}
        </ScrollView>
      </View>

      <View className={styles.list}>
        {filtered.map((item) => (
          <View key={item.id} className={styles.card} onClick={() => handleCopy(item)}>
            <View className={styles.cardHeader}>
              <Text className={styles.typeIcon}>{TYPE_ICONS[item.sourceType] || TYPE_ICON_FALLBACK}</Text>
              <Text className={styles.title}>{item.title}</Text>
              <Text className={styles.time}>{fromNow(item.createTime)}</Text>
            </View>
            <Text className={styles.summary}>{item.summary}</Text>
            <View className={styles.tagRow}>
              {item.tags.map((tg) => (
                <TagChip key={tg} label={categoryLabel(tg, t)} />
              ))}
            </View>
          </View>
        ))}
      </View>

      {!loading && filtered.length === 0 ? (
        <EmptyState
          icon='🔖'
          title={
            keyword
              ? t('library.favSearchEmptyTitle')
              : activeTag === '全部'
                ? t('library.favEmptyAllTitle')
                : t('library.favEmptyTagTitle')
          }
          hint={
            keyword
              ? t('library.favSearchEmptyHint')
              : t('library.favEmptyAllHint')
          }
          action={!profile?.subscribed ? t('library.favEmptyProCta') : undefined}
          onAction={!profile?.subscribed ? handleGoSubscribe : undefined}
        />
      ) : null}

      {blockTarget ? renderBlockSheet() : null}

      {/* 站内文章视图（2026-10-25）：点资讯卡先进这里读，想看全文再「阅读原文」出站 */}
      {article ? renderArticleView(article) : null}
    </View>
  );
}

export default LibraryPage;
