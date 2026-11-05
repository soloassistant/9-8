import { useCallback, useEffect, useRef, useState } from 'react';
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

/** 自动退场时间：落在 800–1200ms 区间，取 900ms 给低端机主线程延迟留余量 */
const AUTO_DISMISS_MS = 900;
/** 自动退场的淡出时长；点击跳过用更短的时长，保证点击后 300ms 内彻底消失 */
const AUTO_FADE_MS = 450;
const SKIP_FADE_MS = 180;
/** 过渡事件丢失时的兜底（后台标签页/动画被暂停时 onTransitionEnd 可能不触发） */
const FADE_FALLBACK_MS = 80;

/**
 * 开屏封面（双端通用）：品牌色全屏 Splash，logo 缩放淡入 + 标题上滑。
 * 默认 1s 后自动淡出退场，同时保留「点击跳过」；`prefers-reduced-motion: reduce`
 * 下直接切走、不播任何过渡/动画。
 *
 * `onGone`：真正卸载后回调。App 用它把全局快捷键**挡在开屏之后** ——
 * 开屏是不透明全屏层，按 `?` 时如果面板在它下面打开，用户看到的是「按了没反应」。
 */
interface SplashProps {
  onGone?: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function Splash({ onGone }: SplashProps) {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in');
  /** 区分自动淡出与点击跳过：决定用 450ms 还是 180ms 过渡 */
  const [skipped, setSkipped] = useState(false);
  const goneRef = useRef(false);

  useEffect(() => {
    if (phase === 'gone') {
      if (!goneRef.current) {
        goneRef.current = true;
        onGone?.();
      }
      return;
    }
    if (phase === 'in') {
      const timer = setTimeout(() => {
        if (prefersReducedMotion()) {
          setPhase('gone');
        } else {
          setSkipped(false);
          setPhase('out');
        }
      }, AUTO_DISMISS_MS);
      return () => clearTimeout(timer);
    }
    // phase === 'out'：过渡结束事件兜底，避免遮罩卡死
    const fallback = setTimeout(
      () => setPhase('gone'),
      (skipped ? SKIP_FADE_MS : AUTO_FADE_MS) + FADE_FALLBACK_MS
    );
    return () => clearTimeout(fallback);
  }, [phase, skipped, onGone]);

  const dismiss = useCallback(() => {
    if (phase !== 'in') return;
    if (prefersReducedMotion()) {
      setPhase('gone');
      return;
    }
    setSkipped(true);
    setPhase('out');
  }, [phase]);

  const onFaded = useCallback(() => {
    if (phase === 'out') setPhase('gone');
  }, [phase]);

  if (phase === 'gone') return null;

  const fadeClass = phase === 'out' ? (skipped ? styles.fadeOutFast : styles.fadeOut) : '';

  return (
    <View
      className={`${styles.splash} ${fadeClass}`}
      data-phase={phase}
      data-skip={skipped ? '1' : '0'}
      onClick={dismiss}
      onTransitionEnd={onFaded}
    >
      <View className={styles.inner}>
        <Image
          className={styles.logo}
          src={require('@/assets/logo.png')}
          mode='aspectFit'
          // 首屏必现的图：eager + high priority（默认懒加载会把它排到后面，开屏第一帧就空一块）
          nativeProps={
            isH5
              ? { alt: '', 'aria-hidden': true, decoding: 'async', loading: 'eager', fetchPriority: 'high' }
              : undefined
          }
        />
        <Text className={styles.title}>私人晨报助理</Text>
        <Text className={styles.slogan}>今天的事，晨报先知道</Text>
      </View>
      <Text className={styles.skip}>点击跳过</Text>
    </View>
  );
}

export default Splash;
