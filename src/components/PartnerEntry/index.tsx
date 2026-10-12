import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { openExternalPage } from '@/utils/externalLink';
import styles from './index.module.scss';

interface PartnerEntryProps {
  /** 左侧 emoji 图标 */
  icon: string;
  title: string;
  desc: string;
  /** 目标地址：H5 端用同源相对路径，小程序端用绝对 URL（见 src/config/partners.ts） */
  url: string;
  /**
   * 覆盖默认点击行为。默认行为是「H5 新标签打开 / 小程序复制链接」；
   * 当该产品已经**原生重做**（省心买 → pages/sxm/index），小程序端传它改为页面内跳转。
   */
  onTap?: () => void;
  /** 覆盖右侧动作文案；不传则按端取 partner.open（H5）/ partner.copy（小程序） */
  actionText?: string;
}

/** 「网页版服务」区块的小标题（与入口卡共用一份样式，故放在同一目录） */
export function PartnerSectionHeader() {
  const t = useT();
  return (
    <View className={styles.sectionHeader}>
      <Text className={styles.sectionTitle}>{t('partner.sectionTitle')}</Text>
      <Text className={styles.sectionDesc}>{t('partner.sectionDesc')}</Text>
    </View>
  );
}

/**
 * 关联产品入口卡片（灵犀课堂 / 省心买）。
 *
 * 两端行为不同，且这是**平台限制**而不是偷懒：小程序里无法内嵌网页
 * （本仓没有 web-view 页面，微信的 web-view 又只对企业主体开放），
 * 所以小程序端只能把地址复制给用户、让他自己去浏览器打开。
 * 故按钮文案也随端变化：H5「浏览器打开」/ 小程序「复制链接」。
 *
 * 外层不加 margin —— 由使用方用页面自己的类控制间距，避免把版式耦合进组件。
 */
function PartnerEntry({ icon, title, desc, url, onTap, actionText }: PartnerEntryProps) {
  const t = useT();
  const isH5 = process.env.TARO_ENV === 'h5';

  const handleTap = async () => {
    // 原生页存在时优先走页面内跳转（小程序端），不走"复制外链"
    if (onTap) {
      onTap();
      return;
    }
    const result = await openExternalPage(url);
    if (result === 'opened') return;
    // 复制成功/失败都必须让用户看见，不能"点了没反应"
    Taro.showToast({
      title: result === 'copied' ? t('partner.copyHint') : t('partner.copyFail'),
      icon: 'none',
      duration: 3000
    });
  };

  return (
    <View className={styles.card} onClick={handleTap}>
      <Text className={styles.icon}>{icon}</Text>
      <View className={styles.main}>
        <Text className={styles.title}>{title}</Text>
        <Text className={styles.desc}>{desc}</Text>
      </View>
      <Text className={styles.action}>{actionText ?? (isH5 ? t('partner.open') : t('partner.copy'))}</Text>
    </View>
  );
}

export default PartnerEntry;
