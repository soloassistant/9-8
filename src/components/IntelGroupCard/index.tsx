import { View, Text, Image, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { splitLeadSegments } from '@/utils/intelGroups';
import type { IntelGroup, IntelLeadSegment, IntelSourceRef } from '@/utils/intelGroups';
import { openExternalPage } from '@/utils/externalLink';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';

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

      {/* AI 导语：分段渲染，引用段为嵌套 <Text>（点击定位来源）。
          单条组不渲染导语（2026-10-26 IA 瘦身）——两处防线：
            · 数据层 groupIntelLocally 对单条已不再产出导语；
            · 渲染层再判一次条数，是因为云端分组路径（LLM 产出）仍可能给单条配一句
              「本组共 1 条」式导语，而它同样与标题重复、对单条无意义。
          导语真正的价值在多条时：串联 + 内联引用 [n]。 */}
      {group.items.length > 1 && group.lead ? (
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
      ) : null}

      <View className={styles.items}>
        {group.items.map((item, i) => (
          <IntelItemRow key={`${group.title}-${i}`} item={item} index={i + 1} />
        ))}
      </View>
    </View>
  );
}

/**
 * 情报单条渲染（分组内 / 平铺列表共用）：正文 + 来源 + 可选配图。
 *
 * 配图规则（2026-10-22 增量）：
 *  · `image` 存在才渲染缩略图；缺失（LLM 订阅路径按设计无图 / 源本身无图）时
 *    自动降级为纯文本行，不留空图框；
 *  · 点图 → `Taro.previewImage` 全屏看大图；点正文 → 有 `url` 时走
 *    `openExternalPage` 打开原文（H5 新标签 / 小程序复制链接，双端降级内置）。
 */
export function IntelItemRow({ item, index }: { item: IntelSourceRef; index?: number }) {
  /** 点正文打开原文：无 url 或打开失败都不打扰用户（图预览才是主交互） */
  const handleTextTap = () => {
    if (!item.url) return;
    openExternalPage(item.url).catch((err) =>
      console.warn('[IntelItemRow] openExternalPage failed:', err)
    );
  };

  /** 点缩略图全屏预览（与 library 页封面图同交互） */
  const handleImageTap = () => {
    if (!item.image) return;
    Taro.previewImage({ urls: [item.image] }).catch((err) =>
      console.warn('[IntelItemRow] previewImage failed:', err)
    );
  };

  /** 分享单条（2026-10-24 对标 weapp-benchmark P1-2：卡片才适合分享到聊天）：
   *  H5 复制「标题（来自来源）+ 链接」到剪贴板 —— 与 library 页 X9 同一降级范式，不引 canvas。
   *  weapp 走 Button open-type='share'（见渲染处），由 briefing 页 useShareAppMessage 读 dataset 响应。
   *  只分享原文标题+来源+链接：item.text 是 RSS 原标题（LLM 只产组导语，不产条目），
   *  不存在「AI 生成内容未标识」问题，故不挂 AI 后缀。 */
  const handleShare = () => {
    if (!item.url) return;
    const text = `${item.text}（来自${item.source}）\n${item.url}`;
    Taro.setClipboardData({
      data: text,
      success: () => Taro.showToast({ title: '链接已复制，去粘贴分享吧', icon: 'none' })
    }).catch((err) => console.warn('[IntelItemRow] share copy failed:', err));
  };

  return (
    <View className={styles.item}>
      <View className={styles.itemRow}>
        <View className={styles.itemMain}>
          <Text className={styles.itemText} onClick={handleTextTap}>
            {typeof index === 'number' ? <Text className={styles.itemIndex}>{`[${index}] `}</Text> : null}
            {item.text}
          </Text>
        </View>
        {item.image ? (
          <Image
            src={item.image}
            mode='aspectFill'
            lazyLoad
            className={styles.itemThumb}
            onClick={handleImageTap}
          />
        ) : null}
      </View>
      {/* 卡片底行：来源 chip（合规：来源必须可见）+ 分享按钮（有原文链接才给分享） */}
      <View className={styles.itemFoot}>
        <Text className={styles.itemSource}>{`来源：${item.source}`}</Text>
        {item.url ? (
          isWeapp ? (
            <Button
              className={styles.shareBtn}
              openType='share'
              data-intel-title={item.text}
              data-intel-url={item.url}
            >
              分享
            </Button>
          ) : (
            <Text className={styles.shareBtn} onClick={handleShare}>
              分享
            </Text>
          )
        ) : null}
      </View>
    </View>
  );
}
