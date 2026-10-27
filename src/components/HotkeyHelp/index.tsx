import { View, Text, ScrollView } from '@tarojs/components';
import { useT } from '@/store/language';
import { HOTKEYS, formatSequence, isMacPlatform } from '@/utils/hotkeys';
import type { HotkeyGroup } from '@/utils/hotkeys';
import { useEscapeKey } from '@/hooks/useHotkeys';
import styles from './index.module.scss';

/**
 * 键盘快捷键面板（桌面端 H5）。
 *
 * 为什么必须有一份可查的清单：快捷键是**看不见的功能** —— 用户不会自己去试
 * `g` 后面跟什么。没有面板，等于这些绑定只服务于写它的人。
 * 入口有两个（都在 H5 可见）：`?` 直接打开、「我的 → 键盘快捷键」点开。
 *
 * 面板内容**不手写**，全部来自 `HOTKEYS` 表 —— 否则表改了面板不变，
 * 用户按着面板按键却没反应（这类漂移在文案与代码分离的项目里几乎必然发生）。
 */

const GROUP_ORDER: HotkeyGroup[] = ['general', 'navigate', 'input'];
const GROUP_LABEL = {
  general: 'hotkeys.groupGeneral',
  navigate: 'hotkeys.groupNavigate',
  input: 'hotkeys.groupInput'
} as const;

interface HotkeyHelpProps {
  open: boolean;
  onClose: () => void;
}

export default function HotkeyHelp({ open, onClose }: HotkeyHelpProps) {
  const t = useT();
  // Esc 关本层：走层栈，只有最上层响应 —— 面板里再叠弹窗时 Esc 只关那一层
  useEscapeKey(onClose, open);

  if (!open) return null;
  const isMac = isMacPlatform();

  return (
    <View className={styles.mask} onClick={onClose}>
      {/* 面板自身吞掉点击，避免点面板就把面板关了 */}
      <View className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <View className={styles.head}>
          <Text className={styles.title}>{t('hotkeys.title')}</Text>
          <Text className={styles.close} onClick={onClose}>
            ✕
          </Text>
        </View>
        <ScrollView scrollY className={styles.body}>
          {GROUP_ORDER.map((group) => {
            const rows = HOTKEYS.filter((h) => h.group === group);
            if (rows.length === 0) return null;
            return (
              <View className={styles.group} key={group}>
                <Text className={styles.groupTitle}>{t(GROUP_LABEL[group])}</Text>
                {rows.map((def) => (
                  <View className={styles.row} key={def.id}>
                    <Text className={styles.label}>{t(def.labelKey)}</Text>
                    <View className={styles.keys}>
                      {formatSequence(def.chord, isMac).map((caps, i) => (
                        // biome-ignore lint: 键帽是无序视觉元素，用 id+序号做 key 最稳定
                        <View className={styles.caps} key={`${def.id}-${i}`}>
                          {i > 0 ? <Text className={styles.then}>{t('hotkeys.then')}</Text> : null}
                          {caps.map((cap) => (
                            <Text className={styles.kbd} key={`${def.id}-${i}-${cap}`}>
                              {cap}
                            </Text>
                          ))}
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            );
          })}
        </ScrollView>
        <Text className={styles.hint}>{t('hotkeys.hint')}</Text>
      </View>
    </View>
  );
}
