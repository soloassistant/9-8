import { useState } from 'react';
import { View, Image, Text } from '@tarojs/components';
import styles from './index.module.scss';

/**
 * 开屏封面（双端通用）：品牌色全屏 Splash，logo 缩放淡入 + 标题上滑。
 * 不自动关闭——等用户点击封面任意处才淡出进入应用（450ms 过渡后卸载）。
 */
function Splash() {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in');

  if (phase === 'gone') return null;

  const onFaded = () => {
    if (phase === 'out') setPhase('gone');
  };

  return (
    <View
      className={`${styles.splash} ${phase === 'out' ? styles.fadeOut : ''}`}
      onClick={() => setPhase('out')}
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
