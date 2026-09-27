import { View, Text } from '@tarojs/components';
import { splitLeadSegments } from '@/utils/intelGroups';
import type { IntelGroup, IntelLeadSegment } from '@/utils/intelGroups';
import styles from './index.module.scss';

/**
 * 单组情报渲染：主题名 + AI 导语（分段 + 内联引用）+ 组内条目。
 *
 * 内联引用渲染（双端可行，架构定案）：
 * 外层一个 `<Text>`，内部**嵌套**若干 `<Text>` 子节点 —— 普通文本段直接渲染，
 * 引用段以 `.cite` 样式 + 点击回调定位来源。**不使用 HTML**（微信小程序不支持）；
 * `<Text>` 上挂 `onClick` 在 weapp 与 H5 均被 Taro 支持。
 */
interface IntelGroupCardProps {
  /** 分组数据（已归一化，items 非空） */
  group: IntelGroup;
  /** 引用的可访问性文案（点击引用时弹出，合规：来源必须可见） */
  citeHint: string;
  /** 点击内联引用：回传 0-based 条目索引，由调用方决定滚动/弹出来源 */
  onCiteClick?: (index: number) => void;
}

export default function IntelGroupCard({ group, citeHint, onCiteClick }: IntelGroupCardProps) {
  // 越界校验用条目数：`[n]` 序号超出此值 → 降级为纯文本，不让 UI 崩
  const segments: IntelLeadSegment[] = splitLeadSegments(group.lead, group.items.length);

  /** 点击引用：仅当引用段带合法 index 时回调（越界段为纯文本，无 index） */
  const handleCite = (seg: IntelLeadSegment) => {
    if (seg.type !== 'cite' || typeof seg.index !== 'number') return;
    if (seg.index < 0 || seg.index >= group.items.length) return;
    if (onCiteClick) onCiteClick(seg.index);
  };

  return (
    <View className={styles.card}>
      <View className={styles.head}>
        <Text className={styles.title}>{group.title}</Text>
      </View>

      {/* AI 导语：分段渲染，引用段为嵌套 <Text>（点击定位来源） */}
      <Text className={styles.lead}>
        {segments.map((seg, i) =>
          seg.type === 'cite' ? (
            <Text
              key={`cite-${i}`}
              className={styles.cite}
              aria-label={`${citeHint} ${seg.text}`}
              onClick={() => handleCite(seg)}
            >
              {seg.text}
            </Text>
          ) : (
            <Text key={`text-${i}`}>{seg.text}</Text>
          )
        )}
      </Text>

      <View className={styles.items}>
        {group.items.map((item, i) => (
          <View key={`${group.title}-${i}`} className={styles.item}>
            <Text className={styles.itemText}>
              <Text className={styles.itemIndex}>{`[${i + 1}]`} </Text>
              {item.text}
            </Text>
            <Text className={styles.itemSource}>{`来源：${item.source}`}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
