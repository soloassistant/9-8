import { useCallback, useEffect, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import EmptyState from '@/components/EmptyState';
import { brandVars, useThemeStore } from '@/store/theme';
import type { HistoryEntry } from '@/types';
import { useT } from '@/store/language';
import { disabledAttr } from '@/utils/buttonDisabled';
import styles from './index.module.scss';

const HISTORY_KEY = 'browseHistory';

function HistoryPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [list, setList] = useState<HistoryEntry[]>([]);

  const loadHistory = useCallback(() => {
    try {
      setList(Taro.getStorageSync(HISTORY_KEY) || []);
    } catch (err) {
      console.error('[HistoryPage] load failed:', err);
      setList([]);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleClear = () => {
    if (list.length === 0) return;
    Taro.showModal({
      title: '清空浏览历史',
      content: `将删除 ${list.length} 条浏览记录，此操作不可恢复。`,
      confirmText: '清空',
      confirmColor: '#E85D2A',
      success: (res) => {
        if (res.confirm) {
          try {
            Taro.removeStorageSync(HISTORY_KEY);
          } catch (err) {
            console.error('[HistoryPage] clear failed:', err);
          }
          setList([]);
          Taro.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  };

  /**
   * 明确的返回入口：H5 的 TabRouter 不渲染原生导航栏，二级页没有返回键会走进死路。
   * 优先 navigateBack（保留来源页状态），栈里只剩本页时兜底 reLaunch 回晨报。
   */
  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => {
        Taro.reLaunch({ url: '/pages/briefing/index' });
      });
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.backButton} onClick={handleBack}>
        <Text className={styles.backIcon}>‹</Text>
        <Text className={styles.backText}>{t('common.back')}</Text>
      </View>
      <View className={styles.header}>
        <Text className={styles.hint}>{t('history.hint')}</Text>
        <Button className={styles.clearButton} onClick={handleClear} disabled={disabledAttr(list.length === 0)}>
          {t('mine.clear')}
        </Button>
      </View>

      {list.map((item) => (
        <View key={`${item.id}-${item.viewedAt}`} className={styles.item}>
          <View className={styles.itemBody}>
            <Text className={styles.itemTitle}>{item.title}</Text>
            {item.source ? <Text className={styles.itemSource}>来源 · {item.source}</Text> : null}
          </View>
          <Text className={styles.itemTime}>{dayjs(item.viewedAt).format('M月D日 HH:mm')}</Text>
        </View>
      ))}

      {list.length === 0 ? (
        <EmptyState
          icon='🕘'
          title='还没有浏览记录'
          hint='去「热点」页看看今天的资讯，回来看过的都会记在这里'
        />
      ) : null}
    </View>
  );
}

export default HistoryPage;
