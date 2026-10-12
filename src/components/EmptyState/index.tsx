import { View, Text } from '@tarojs/components';
import styles from './index.module.scss';

interface EmptyStateProps {
  icon?: string;
  title: string;
  hint?: string;
  /**
   * 主行动按钮文案。**只在同时给了 onAction 时才渲染。**
   *
   * 为什么加（2026-10-12 增长审计）：空状态里写「去收件箱把微信消息转发进来」，
   * 用户却被迫自己在底栏找「收件箱」——文案指挥了一个**不可点击**的动作，
   * 激活漏斗上这是个死胡同（晨报首屏对新用户 100% 是空态）。
   */
  action?: string;
  onAction?: () => void;
}

/** 空状态占位组件 */
export default function EmptyState({ icon = '🌅', title, hint, action, onAction }: EmptyStateProps) {
  return (
    <View className={styles.container}>
      <Text className={styles.icon}>{icon}</Text>
      <Text className={styles.title}>{title}</Text>
      {hint ? <Text className={styles.hint}>{hint}</Text> : null}
      {action && onAction ? (
        <View className={styles.action} onClick={onAction}>
          <Text className={styles.actionText}>{action}</Text>
        </View>
      ) : null}
    </View>
  );
}
