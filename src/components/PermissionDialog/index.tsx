import { View, Text } from '@tarojs/components';
import { PERMISSION_TEXT } from '@/utils/permission';
import type { PermissionName } from '@/utils/permission';
import { useT } from '@/store/language';
import styles from './index.module.scss';

interface PermissionDialogProps {
  /** 是否展示（由调用方按 permission.shouldShowDialog 判定，本组件只负责展示） */
  visible: boolean;
  /** 权限类型：麦克风 / 位置 */
  name: PermissionName;
  /** 点「同意」：调用方在此触发 ensurePermission()（微信端会拉起 Taro.authorize） */
  onAgree: () => void;
  /** 点「暂不使用」或遮罩：调用方在此关闭弹窗并记录一次拒绝 */
  onCancel: () => void;
}

/**
 * 通用敏感权限说明弹窗（C-01 麦克风 / C-02 位置，PRD 4.5）。
 * - 只负责展示与回调，**不自己判断要不要弹** —— 判定统一走 utils/permission 的 shouldShowDialog()；
 * - 文案全部来自 i18n（zh/en 双语），由 PERMISSION_TEXT 提供 key；
 * - H5 端复用同一套文案：点击同意后由浏览器原生弹窗接管。
 */
export default function PermissionDialog({ visible, name, onAgree, onCancel }: PermissionDialogProps) {
  const t = useT();
  if (!visible) return null;

  const copy = PERMISSION_TEXT[name];

  return (
    <View className={styles.mask} onClick={onCancel}>
      <View className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <Text className={styles.title}>{t(copy.titleKey)}</Text>
        <Text className={styles.desc}>{t(copy.descKey)}</Text>
        <View className={styles.actions}>
          <View className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>
            <Text className={styles.btnGhostText}>{t(copy.declineKey)}</Text>
          </View>
          <View className={`${styles.btn} ${styles.btnPrimary}`} onClick={onAgree}>
            <Text className={styles.btnPrimaryText}>{t(copy.agreeKey)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
