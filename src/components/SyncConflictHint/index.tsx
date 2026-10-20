import { useEffect, useState } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import {
  getSyncConflicts,
  resolveSyncConflicts,
  subscribeSyncConflicts
} from '@/services/cloudSync';
import { useT } from '@/store/language';
import type { LangKey } from '@/store/language';
import type { SyncConflict } from '@/utils/syncConflict';
import styles from './index.module.scss';

/**
 * 同步冲突提示与裁决（2026-10-19，cloudSync 冲突检测的 UI 出口）。
 *
 * 何时出现：拉取时发现**远端较新、且本机该键有尚未推送的修改**（两台设备各自改过）。
 * 此前这一步是静默覆盖——本机未上传的修改直接消失，用户无从知晓。
 *
 * 为什么挂「我的」页：冲突是账号/数据范畴的事，与订阅、注销同一语境；
 * 且提示要一直挂到用户裁决（未裁决 = 该键同步暂停），放常驻入口最不容易漏。
 *
 * 无障碍：只渲染文本、不写 role/aria-*（Taro 的 View/Text 不透传未知属性，
 * 详见 components/Splash 的 nativeProps 说明），读屏可直接获取文本。
 */
function SyncConflictHint() {
  const t = useT();
  const [conflicts, setConflicts] = useState<SyncConflict[]>(() => getSyncConflicts());

  // subscribeSyncConflicts 订阅时立即回调一次当前快照，并返回取消订阅函数
  useEffect(() => subscribeSyncConflicts(setConflicts), []);

  if (conflicts.length === 0) return null;

  const handleResolve = async (key: string, choice: 'local' | 'remote') => {
    try {
      await resolveSyncConflicts(choice, [key]);
      Taro.showToast({
        title: t(choice === 'local' ? 'syncConflict.toastLocal' : 'syncConflict.toastRemote'),
        icon: 'none'
      });
    } catch (err) {
      // 裁决失败不静默：用户点了按钮要有反馈，否则会以为已生效
      console.error('[SyncConflictHint] resolve failed:', err);
      Taro.showToast({ title: t('syncConflict.failed'), icon: 'none' });
    }
  };

  return (
    <View className={styles.hint}>
      <Text className={styles.title}>{t('syncConflict.title')}</Text>
      <Text className={styles.desc}>{t('syncConflict.desc')}</Text>
      {conflicts.map((c) => (
        <View className={styles.item} key={c.key}>
          <Text className={styles.itemLabel}>{t(`sync.key.${c.key}` as LangKey)}</Text>
          <View className={styles.itemActions}>
            {/* 用 Text 而非 Button：flex 行内的 Button 受 taro-button-core 默认 width:100%
                影响会挤占兄弟元素（项目既有坑）；文本按钮与 mine 页 linkText 模式一致 */}
            <Text className={styles.action} onClick={() => void handleResolve(c.key, 'local')}>
              {t('syncConflict.keepLocal')}
            </Text>
            <Text className={styles.actionRemote} onClick={() => void handleResolve(c.key, 'remote')}>
              {t('syncConflict.takeRemote')}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export default SyncConflictHint
