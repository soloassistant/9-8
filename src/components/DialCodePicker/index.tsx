import type { CSSProperties } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import { useLanguageStore, useT } from '@/store/language';
import { DIAL_CODES } from '@/data/dialCodes';
import styles from './index.module.scss';

export interface DialCodePickerProps {
  visible: boolean;
  /** 当前选中的区号（不带 `+`），用于高亮 */
  value: string;
  onSelect(code: string): void;
  onClose(): void;
}

/**
 * 国际区号选择底部弹层（H5 / 微信小程序同一套实现）。
 *
 * 为什么**不用** Taro 的 `Picker`：
 *   1) 本项目已在 PromptModal 上踩过 Taro H5 组件透传不全的坑（见
 *      `src/components/PromptModal/index.tsx` 头注释：showModal 在 H5 上根本不读
 *      `editable` / `placeholderText`）。原生 Picker 的选中态与滚动位置同样难以在 H5 下
 *      稳定控制，跨端表现不一致。
 *   2) 原生 Picker 的遮罩层由运行时自己创建，无头浏览器里难以确定性驱动与断言；
 *      自绘弹层可以给每个选项挂 `id` / `data-code`，自动化测试能直接定位点击。
 *
 * 尺寸一律 rpx（本项目 pxtransform baseFontSize=37.5，写 px 会被缩成一半）；
 * 遮罩用内联 style 的 `position: fixed` + rgba 黑，与登录页 `overlayStyle` 一致
 * （rpx 在 H5 的 fixed 定位上不可靠）。
 */
export default function DialCodePicker({ visible, value, onSelect, onClose }: DialCodePickerProps) {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);

  // 关闭时不渲染：避免 24 个节点常驻，也免得自动化在不可见状态下误点到选项
  if (!visible) return null;

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 'var(--z-dialog)'
  };

  return (
    <View style={overlayStyle} onClick={onClose}>
      {/* 面板内的点击不能冒泡到遮罩，否则选一项就会连带关闭（虽然结果相同，但会打断滚动/误触） */}
      <View className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <View className={styles.header}>
          <Text className={styles.title}>{t('auth.dialCode')}</Text>
        </View>
        {/* 24 项必须可滚动；高度受面板 60vh 上限约束 */}
        <ScrollView className={styles.list} scrollY>
          {DIAL_CODES.map((entry) => {
            const active = entry.code === value;
            return (
              <View
                key={entry.code}
                id={`dialcode-option-${entry.code}`}
                data-code={entry.code}
                className={`${styles.option} ${active ? styles.optionActive : ''}`}
                onClick={() => onSelect(entry.code)}
              >
                <Text className={`${styles.optionText} ${active ? styles.optionTextActive : ''}`}>
                  {`+${entry.code}  ${lang === 'zh' ? entry.nameZh : entry.nameEn}`}
                </Text>
                {active ? <Text className={styles.check}>✓</Text> : null}
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}
