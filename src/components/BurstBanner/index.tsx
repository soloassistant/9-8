import { useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import { useLanguageStore } from '@/store/language';
// 识别逻辑抽在 utils/burst.ts（无 Taro/React 依赖），门禁可直接跑运行时断言
import { pickBurst, type BurstItem } from '@/utils/burst';
import styles from './index.module.scss';

/**
 * 突发/重大新闻**应用内横幅**（2026-10-24）
 *
 * ## 它是什么，以及它不是什么（诚实性边界）
 *
 * · **是**：打开晨报页时，在已拿到的情报条目里按「突发类关键词」挑一条顶到页首，
 *   点一下跳到热点页看原文。零额外网络请求（复用 `briefing.intel.intelItems`）。
 * · **不是**：订阅消息 / 系统推送。推送通道依赖微信模板消息（模板 ID 至今为空串），
 *   外部阻塞未解，这里不做任何「已推送给你」的暗示。
 * · **不是**：官方灾情通报。判据只是公开新闻源的**标题关键词**，必然有误报，
 *   所以横幅里常驻一行「按标题识别 · 以权威发布为准」，不写「已确认」「紧急通知」这类
 *   会被人当真的措辞。
 *
 * ## 为什么可以关掉
 *
 * 误报一次就够烦人了。关闭后当天不再出现（按自然日记忆），第二天重新评估 ——
 * 记忆键 `burst-banner-dismissed`，只是本地偏好，不进同步键。
 */

const DISMISS_KEY = 'burst-banner-dismissed';

const COPY = {
  zh: {
    label: '热点速报',
    note: '按公开新闻标题识别 · 请以权威发布为准',
    cta: '看相关报道',
    close: '关闭'
  },
  en: {
    label: 'In the news',
    note: 'Detected from public headlines · refer to official sources',
    cta: 'See coverage',
    close: 'Dismiss'
  }
};

interface Props {
  items?: BurstItem[] | null;
}

export default function BurstBanner({ items }: Props) {
  const { lang } = useLanguageStore();
  const copy = COPY[lang];
  const today = dayjs().format('YYYY-MM-DD');
  // 惰性初始化：读一次本地偏好，之后只受点击影响
  const [dismissedOn, setDismissedOn] = useState(() => {
    try {
      return String(Taro.getStorageSync(DISMISS_KEY) || '');
    } catch {
      return '';
    }
  });

  const hit = useMemo(() => pickBurst(items), [items]);
  if (!hit || dismissedOn === today) return null;

  const handleDismiss = () => {
    setDismissedOn(today);
    try {
      Taro.setStorageSync(DISMISS_KEY, today);
    } catch (err) {
      // 写不进去只影响「明天还提不提」，不影响本次关闭，故不打扰用户
      console.warn('[BurstBanner] persist dismiss failed:', err);
    }
  };

  const handleOpen = () => {
    // 热点页是 tabBar 页：navigateTo 会失败（cannot navigate to tabbar page）
    Taro.switchTab({ url: '/pages/library/index' }).catch(() => {
      Taro.showToast({ title: copy.cta, icon: 'none' });
    });
  };

  return (
    <View className={styles.wrap}>
      <View className={styles.main} onClick={handleOpen}>
        <Text className={styles.label}>
          ⚠ {copy.label} · {hit.source}
        </Text>
        <Text className={styles.text}>{hit.text}</Text>
        <Text className={styles.note}>
          {copy.note} · {copy.cta} ›
        </Text>
      </View>
      <Text className={styles.close} onClick={handleDismiss} aria-label={copy.close}>
        ×
      </Text>
    </View>
  );
}
