import { View } from '@tarojs/components';
import styles from './index.module.scss';

/**
 * U-01 首屏骨架屏（仅加载 >300ms 时显示，防快速缓存命中的闪烁）
 * 晨报卡骨架 = 标题条 + 区块条（对齐 briefing 页 section 卡片结构）
 */
export function BriefingSkeleton() {
  return (
    <View className={styles.briefing}>
      <View className={`${styles.line} ${styles.title}`} />
      {[0, 1].map((s) => (
        <View key={s} className={styles.card}>
          <View className={`${styles.line} ${styles.head}`} />
          <View className={styles.line} />
          <View className={styles.line} />
          <View className={`${styles.line} ${styles.short}`} />
        </View>
      ))}
    </View>
  );
}

/** 热点资讯卡骨架（对齐 library 页 newsCard 结构：标题 + 两行摘要 + 元信息条） */
export function NewsCardSkeleton() {
  return (
    <View className={styles.newsCard}>
      <View className={styles.line} />
      <View className={styles.line} />
      <View className={`${styles.line} ${styles.short}`} />
      <View className={`${styles.line} ${styles.meta}`} />
    </View>
  );
}
