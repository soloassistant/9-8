/**
 * pages/notify —— 通知（设计稿 p17）。
 *
 * 数据只来自 notifyLog：应用里真实发生过的事件（晨报生成、提取完成…）。
 * 没有事件时就是空态 —— 不用假条目把页面填满（用户会照通知去收件箱找，找不到就是骗）。
 */
import { useCallback, useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import {
  KEEP_DAYS,
  formatNotifyTime,
  groupNotify,
  listNotify,
  type NotifyEntry,
  type NotifyKind
} from '@/data/notifyLog';
import styles from './index.module.scss';

const KIND_ICON: Record<NotifyKind, string> = {
  briefing: '📄',
  extract: '✓',
  reminder: '⏰',
  system: 'ⓘ'
};

export default function NotifyPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [entries, setEntries] = useState<NotifyEntry[]>([]);
  const [now, setNow] = useState(Date.now());

  const reload = useCallback(() => {
    setNow(Date.now());
    setEntries(listNotify());
  }, []);

  useDidShow(reload);

  const groups = useMemo(() => groupNotify(entries, now), [entries, now]);

  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/briefing/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={handleBack}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('notify.title')}</Text>
        <Text className={styles.keep}>{t('notify.keep', { days: KEEP_DAYS })}</Text>
      </View>

      {groups.length === 0 ? (
        <View className={styles.emptyBox}>
          <Text className={styles.emptyIcon}>🔔</Text>
          <Text className={styles.emptyTitle}>{t('notify.empty')}</Text>
          <Text className={styles.emptyDesc}>{t('notify.emptyDesc')}</Text>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.key} className={styles.group}>
            <Text className={styles.groupLabel}>{t(`notify.group.${g.key}`)}</Text>
            <View className={styles.card}>
              {g.items.map((e) => (
                <View key={e.id} className={styles.row}>
                  <View className={`${styles.badge} ${styles[`badge_${e.kind}`] || ''}`}>
                    <Text className={styles.badgeText}>{KIND_ICON[e.kind]}</Text>
                  </View>
                  <View className={styles.rowMain}>
                    <Text className={styles.rowTitle}>{e.title}</Text>
                    <Text className={styles.rowDesc}>{e.desc}</Text>
                  </View>
                  <Text className={styles.rowTime}>{formatNotifyTime(e.at, now)}</Text>
                </View>
              ))}
            </View>
          </View>
        ))
      )}
    </View>
  );
}
