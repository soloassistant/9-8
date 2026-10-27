import { useEffect, useState } from 'react';
import { View, Image, Text } from '@tarojs/components';
import styles from './index.module.scss';

/**
 * 无障碍用：Taro 的 `<Image>` **没有 alt 属性**（ImageProps 未声明），H5 端唯一能把属性
 * 透传到内层 `<img>` 的入口是 `nativeProps`（见 @tarojs/components/dist/collection/components/image/image.js：
 * `h("img", {...nativeProps})`）；类型里的 `imgProps` 在 4.1.9 的 H5 实现里**根本没有被读取**，
 * 用它写 alt 属于假修。`nativeProps` 官方标注仅 h5 支持，故只在 H5 端传。
 */
const isH5 = process.env.TARO_ENV === 'h5';
/** 品牌 logo 纯装饰（标题文字已表达同样信息）→ 空 alt + aria-hidden */

/**
 * 开屏封面（双端通用）：品牌色全屏 Splash，logo 缩放淡入 + 标题上滑。
 * 不自动关闭——等用户点击封面任意处才淡出进入应用（450ms 过渡后卸载）。
 *
 * `onGone`：真正卸载后回调。App 用它把全局快捷键**挡在开屏之后** ——
 * 开屏是不透明全屏层，按 `?` 时如果面板在它下面打开，用户看到的是「按了没反应」。
 */
interface SplashProps {
  onGone?: () => void;
}

function Splash({ onGone }: SplashProps) {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in');

  useEffect(() => {
    if (phase === 'gone') onGone?.();
  }, [phase, onGone]);

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
        <Image
          className={styles.logo}
          src={require('@/assets/logo.png')}
          mode='aspectFit'
          nativeProps={isH5 ? { alt: '', 'aria-hidden': true } : undefined}
        />
        <Text className={styles.title}>私人晨报助理</Text>
        <Text className={styles.slogan}>今天的事，晨报先知道</Text>
      </View>
      <Text className={styles.skip}>点击进入</Text>
    </View>
  );
}

export default Splash;
