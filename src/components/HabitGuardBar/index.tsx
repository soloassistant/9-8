import { View, Text } from '@tarojs/components';
import dayjs from 'dayjs';
import { useT } from '@/store/language';
import type { HabitGuardRecord } from '@/utils/habit';
import styles from './index.module.scss';

export interface HabitGuardBarProps {
  /** 待展示的守护记录（自动挪动且未撤销、在撤销窗口内） */
  records: HabitGuardRecord[];
  /** 一键还原单条记录 */
  onRestore: (recordId: string) => void;
  /** 全部还原（可选） */
  onRestoreAll?: () => void;
  /** 展开查看明细（可选，缺省不显示「查看」） */
  onView?: () => void;
}

/**
 * 晨报页「习惯已守护」提示条：纯展示组件。
 * 只把 record 翻译成文案与事件，不碰任何 storage / 网络（逻辑全在 utils/habit.ts）。
 */
function HabitGuardBar({ records, onRestore, onRestoreAll, onView }: HabitGuardBarProps) {
  const t = useT();
  if (!records || records.length === 0) return null;

  const first = records[0];
  const moreCount = records.length - 1;
  const firstTime = dayjs(first.toTime).format('HH:mm');

  return (
    <View className={styles.bar}>
      <View className={styles.head}>
        <Text className={styles.icon}>🛡</Text>
        <Text className={styles.title}>{t('habit.guardTitle')}</Text>
        {moreCount > 0 ? (
          <Text className={styles.more} onClick={onView}>
            {t('habit.guardBarMore', { n: records.length })}
          </Text>
        ) : null}
      </View>
      <Text className={styles.body}>{t('habit.guardBarText', { title: first.title, time: firstTime })}</Text>
      <View className={styles.actions}>
        <Text className={styles.link} onClick={() => onRestore(first.id)}>
          {t('habit.restore')}
        </Text>
        {records.length > 1 && onRestoreAll ? (
          <Text className={styles.link} onClick={onRestoreAll}>
            {t('habit.restoreAll')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default HabitGuardBar;
