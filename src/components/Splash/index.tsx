import { useEffect, useState } from 'react';
import { View, Image, Text } from '@tarojs/components';
import styles from './index.module.scss';

/**
 * 开屏动画（双端通用）：品牌色全屏 Splash，logo 缩放淡入 + 标题上滑，
 * 1.6s 后整体淡出卸载；点击任意处立即跳过。每次冷启动展示一次。
 */
const HOLD_MS = 1600; // 主展示时长（淡出时长在样式中 450ms，两处需保持节奏一致）

function Splash() {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('out'), HOLD_MS);
    return () => clearTimeout(t1);
  }, []);

  if (phase === 'gone') return null;

  const dismiss = () => setPhase('out');
  const onFaded = () => {
    if (phase === 'out') setPhase('gone');
  };

  return (
    <View
      className={`${styles.splash} ${phase === 'out' ? styles.fadeOut : ''}`}
      onClick={dismiss}
      onTransitionEnd={onFaded}
    >
      <View className={styles.inner}>
        <Image className={styles.logo} src={require('@/assets/logo.png')} mode='aspectFit' />
        <Text className={styles.title}>私人晨报助理</Text>
        <Text className={styles.slogan}>今天的事，晨报先知道</Text>
      </View>
      <Text className={styles.skip}>点击进入</Text>
    </View>
  );
}

export default Splash;
