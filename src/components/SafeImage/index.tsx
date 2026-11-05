import { useEffect, useState } from 'react';
import { Image, Text, View } from '@tarojs/components';
import { thumbUrl } from '@/utils/imageUrl';
import styles from './index.module.scss';

/**
 * 统一图片组件：**加载失败时卸载 `<img>`，换成同尺寸带字占位**。
 *
 * 为什么必须卸载而不是「留着裂图」：
 * 浏览器的破图图标 + alt 文本会把一个 128rpx 的方框撑成一行乱码；小程序端则是空白块。
 * 两者都比「明确告诉用户这张图坏了」更糟。卸载后由占位块接管，尺寸由调用方 className
 * 决定（占位与 `<img>` 用同一个 class，所以不会跳版）。
 *
 * 交互口径：
 * · 失败态**不挂预览点击**（原图的预览入口已经没有意义，点了只会打开一张 403 图）；
 * · 失败态**允许冒泡**：占位块自身没有 onClick，点它等同于点外层卡片（视频卡仍能打开原文）。
 *
 * 加载策略：默认 lazy + `decoding="async"`；`priority` 用于首屏必须立刻出现的图
 * （启动 logo 等）→ eager + `fetchPriority=high`。
 */

const isH5 = process.env.TARO_ENV === 'h5';

export interface SafeImageProps {
  /** 原图 URL（会经 `thumbUrl` 改写后再加载；预览仍用原图） */
  src?: string;
  /** 尺寸/圆角等由调用方定义；占位块复用同一个 class，保证同尺寸 */
  className?: string;
  mode?: 'aspectFill' | 'aspectFit' | 'widthFix' | 'scaleToFill';
  /** 无障碍文案（H5 透传到真实 <img> 的 alt） */
  alt?: string;
  /** 是否首屏必现：true → eager + high priority */
  priority?: boolean;
  /** 失败占位文案（默认「配图加载失败」） */
  fallbackLabel?: string;
  /** 失败占位的来源标注（如「哔哩哔哩」→ 显示「来自哔哩哔哩」） */
  source?: string;
  /** 点击图片（仅在加载成功时挂载） */
  onClick?: () => void;
}

export default function SafeImage({
  src,
  className,
  mode = 'aspectFill',
  alt,
  priority = false,
  fallbackLabel = '配图加载失败',
  source,
  onClick
}: SafeImageProps) {
  const [failed, setFailed] = useState(false);

  // 换源（列表复用节点 / 数据轮换）→ 重新给这张图一次机会
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    const shown = src ? fallbackLabel : '暂无配图';
    // `safe-image-fallback` 是不经 CSS Modules 的稳定锚点：Taro 的 data-* 在部分节点
    // 不透传到真实 DOM（见 AGENTS §6.3），自动化只能按稳定 className 选。
    return (
      <View
        className={`${styles.fallback} safe-image-fallback ${className || ''}`}
        // 行内布局：调用方的 class 只负责宽高/圆角，display 必须压过它（如 .videoCover 的 block）
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}
      >
        <Text className={styles.icon}>{src ? '🖼' : '🎬'}</Text>
        <Text className={styles.label}>{shown}</Text>
        {src && source ? <Text className={styles.source}>{`来自${source}`}</Text> : null}
      </View>
    );
  }

  return (
    <Image
      src={thumbUrl(src) ?? src}
      mode={mode}
      lazyLoad={!priority}
      className={`safe-image-img ${className || ''}`}
      onClick={onClick}
      onError={() => setFailed(true)}
      nativeProps={
        isH5
          ? {
              alt: alt || '',
              // 防盗链防线：hdslb / gcores 带本应用 Referer 会 403，不带 Referer 才 200
              referrerPolicy: 'no-referrer',
              decoding: 'async',
              loading: priority ? 'eager' : 'lazy',
              fetchPriority: priority ? 'high' : 'low'
            }
          : undefined
      }
    />
  );
}
