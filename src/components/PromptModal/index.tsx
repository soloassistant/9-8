import { useEffect, useRef, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import styles from './index.module.scss';

export interface PromptModalProps {
  visible: boolean;
  title: string;
  /** 补充说明（如注销警告）；可选 */
  description?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText: string;
  cancelText: string;
  /** 次要操作（如「清除上限」）；为空则不渲染 */
  secondaryText?: string;
  /** 确认按钮用危险色（注销等不可逆操作） */
  danger?: boolean;
  onSecondary?: () => void;
  /** 允许异步：组件在 Promise 完成前会忽略重复点击 */
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * 跨端输入弹窗（H5 / 微信小程序同一套实现）。
 *
 * 为什么不用 Taro.showModal：
 *   H5 端的 showModal 只透传 title / content / 按钮文案与颜色，
 *   **`editable` 与 `placeholderText` 从未被读取**，返回值也只有 `{ cancel, confirm }`，
 *   没有 `content` 字段。于是所有依赖 `res.content` 的输入在 H5 上恒为空串：
 *   预算被静默删除、比价永远记不上、注销确认形同虚设。
 *   这里用页内 overlay + Input 自己实现，两端行为一致。
 *
 * 尺寸一律写 rpx：本项目 pxtransform 的 baseFontSize=37.5，
 * 小写 px 会被换算成一半（详见 AGENTS.md 3.3「单位陷阱一」）。
 */
export default function PromptModal({
  visible,
  title,
  description,
  placeholder,
  initialValue,
  confirmText,
  cancelText,
  secondaryText,
  danger,
  onSecondary,
  onConfirm,
  onCancel
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const [busy, setBusy] = useState(false);
  // 连点保护必须用 ref：setBusy 是异步的，同一 tick 内的第二次点击仍会读到旧值
  const busyRef = useRef(false);

  // 每次打开都回到调用方给的初始值，避免上一次残留的输入串到下一次编辑
  useEffect(() => {
    if (visible) setValue(initialValue ?? '');
  }, [visible, initialValue]);

  if (!visible) return null;

  const runConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm(value);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const runCancel = () => {
    if (busyRef.current) return;
    onCancel();
  };

  const runSecondary = () => {
    if (busyRef.current || !onSecondary) return;
    onSecondary();
  };

  return (
    <View className={styles.overlay}>
      <View className={styles.card}>
        <Text className={styles.title}>{title}</Text>
        {description ? <Text className={styles.description}>{description}</Text> : null}
        <Input
          className={styles.input}
          value={value}
          placeholder={placeholder}
          confirmType='done'
          onInput={(e) => setValue(String(e.detail.value ?? ''))}
          onConfirm={() => void runConfirm()}
        />
        <View className={styles.actions}>
          {secondaryText && onSecondary ? (
            <View
              className={`${styles.btn} ${styles.secondary} ${busy ? styles.btnDisabled : ''}`}
              onClick={runSecondary}
            >
              <Text className={styles.secondaryText}>{secondaryText}</Text>
            </View>
          ) : null}
          <View className={`${styles.btn} ${styles.cancel} ${busy ? styles.btnDisabled : ''}`} onClick={runCancel}>
            <Text className={styles.cancelText}>{cancelText}</Text>
          </View>
          <View
            className={`${styles.btn} ${styles.confirm} ${danger ? styles.danger : ''} ${
              busy ? styles.btnDisabled : ''
            }`}
            onClick={() => void runConfirm()}
          >
            <Text className={styles.confirmText}>{busy ? '…' : confirmText}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
