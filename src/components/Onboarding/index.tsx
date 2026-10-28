/**
 * Onboarding —— 首次启动引导（设计稿 p19 / p20 两屏）。
 *
 * 层级顺序：Splash（开屏）→ ConsentGate（隐私同意）→ 本组件。App 里用
 * `!consentAgreed` 把前两层挡掉之后再渲染它，避免三个全屏层叠在一起。
 *
 * ★ 与设计稿的三处**有意偏离**（都是因为 H5 做不到，照抄就是假承诺）：
 *   1. p19 第 1 条原话「微信消息、截图、链接，一键转存」——那是小程序/客户端能力，
 *      H5 没有微信转发入口，也没有"一键"。改成收件箱真实支持的「粘贴文字、导入链接」。
 *   2. p20 的「写入日历 / 日程自动同步到系统日历」——H5 无法写系统日历，
 *      不做一个点了没反应的开关，该行整条去掉。
 *   3. p20 的「通知提醒 / 每天 7:30 推送晨报」——浏览器通知只能在页面存活时发，
 *      App 关掉就收不到。开关保留（它控制的是"要不要提醒"），但副标题如实写清边界。
 */
import { useCallback, useState } from 'react';
import { View, Text, Switch } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import styles from './index.module.scss';

export const ONBOARD_STORAGE_KEY = 'onboarded-v2';

/** 是否已经看过引导。Taro 对缺键返回空串（不是 undefined），必须显式判真值。 */
export function hasOnboarded(): boolean {
  try {
    const v = Taro.getStorageSync(ONBOARD_STORAGE_KEY);
    return v === true || v === 'true' || v === 1;
  } catch {
    // 读不到就当没看过：宁可多引导一次，也不要让新用户跳过（跳过的人看不到后面的授权说明）
    return false;
  }
}

export function markOnboarded(): void {
  try {
    Taro.setStorageSync(ONBOARD_STORAGE_KEY, true);
  } catch (err) {
    console.warn('[Onboarding] 写入引导标记失败:', err);
  }
}

/** 与「我的」页共用 user-settings（同一份偏好，改一处两边都生效） */
const SETTINGS_KEY = 'user-settings';

function readSettings(): Record<string, unknown> {
  try {
    const v = Taro.getStorageSync(SETTINGS_KEY);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function patchSettings(patch: Record<string, unknown>): void {
  try {
    Taro.setStorageSync(SETTINGS_KEY, { ...readSettings(), ...patch });
  } catch (err) {
    console.warn('[Onboarding] 保存偏好失败:', err);
  }
}

interface OnboardingProps {
  onDone: () => void;
}

const STEPS = [
  { n: 1, titleKey: 'onb.s1.title', descKey: 'onb.s1.desc' },
  { n: 2, titleKey: 'onb.s2.title', descKey: 'onb.s2.desc' },
  { n: 3, titleKey: 'onb.s3.title', descKey: 'onb.s3.desc' }
] as const;

export default function Onboarding({ onDone }: OnboardingProps) {
  const t = useT();
  const { theme } = useThemeStore();
  const [step, setStep] = useState<1 | 2>(1);
  // ⚠️ 开关的初始值必须反映**真实权限**，不能只看偏好：偏好默认是开，
  // 但浏览器还没给权限时如果也显示"开"，用户会以为提醒已经生效 —— 那是个假开关。
  // 只有「权限已授予 且 偏好没关」才算真的开着。
  const [remind, setRemind] = useState(() => {
    if (readSettings().morningReminderEnabled === false) return false;
    if (typeof window === 'undefined') return false;
    const N = (window as unknown as { Notification?: typeof Notification }).Notification;
    return !!N && N.permission === 'granted';
  });
  const [voice, setVoice] = useState(() => readSettings().voiceEnabled !== false);
  const [permHint, setPermHint] = useState('');

  const finish = useCallback(() => {
    markOnboarded();
    onDone();
  }, [onDone]);

  /** 打开晨报提醒时顺手申请浏览器通知权限：申请失败不静默 —— 开关留在"开"但用户
   *  什么都没得到是最坏的结果，所以失败时把开关拨回去并写清原因。 */
  const toggleRemind = useCallback(
    (next: boolean) => {
      if (!next) {
        setRemind(false);
        patchSettings({ morningReminderEnabled: false });
        setPermHint('');
        return;
      }
      const N = typeof window !== 'undefined' ? (window as unknown as { Notification?: typeof Notification }).Notification : undefined;
      if (!N) {
        setPermHint(t('onb.noNotifySupport'));
        return;
      }
      if (N.permission === 'granted') {
        setRemind(true);
        patchSettings({ morningReminderEnabled: true });
        setPermHint('');
        return;
      }
      N.requestPermission()
        .then((p) => {
          if (p === 'granted') {
            setRemind(true);
            patchSettings({ morningReminderEnabled: true });
            setPermHint('');
          } else {
            setRemind(false);
            patchSettings({ morningReminderEnabled: false });
            setPermHint(t('onb.notifyDenied'));
          }
        })
        .catch(() => {
          setRemind(false);
          patchSettings({ morningReminderEnabled: false });
          setPermHint(t('onb.notifyDenied'));
        });
    },
    [t]
  );

  const toggleVoice = useCallback((next: boolean) => {
    setVoice(next);
    patchSettings({ voiceEnabled: next });
  }, []);

  return (
    <View className={styles.mask} style={brandVars(theme)}>
      <View className={styles.panel}>
        {/* 顶部动作：第 1 步可跳过，第 2 步可回上一步 */}
        <View className={styles.topRow}>
          {step === 2 ? (
            <Text className={styles.topAction} onClick={() => setStep(1)}>
              {t('onb.prev')}
            </Text>
          ) : (
            <View />
          )}
          {step === 1 ? (
            <Text className={styles.topAction} onClick={finish}>
              {t('onb.skip')}
            </Text>
          ) : (
            <View />
          )}
        </View>

        {step === 1 ? (
          <View>
            <Text className={styles.title}>{t('onb.step1Title')}</Text>
            <Text className={styles.lead}>{t('onb.step1Lead')}</Text>

            <View className={styles.cards}>
              {STEPS.map((s) => (
                <View key={s.n} className={styles.card}>
                  <View className={styles.num}>
                    <Text className={styles.numText}>{s.n}</Text>
                  </View>
                  <View className={styles.cardBody}>
                    <Text className={styles.cardTitle}>{t(s.titleKey)}</Text>
                    <Text className={styles.cardDesc}>{t(s.descKey)}</Text>
                  </View>
                </View>
              ))}
            </View>

            <Text className={styles.foot}>{t('onb.step1Foot')}</Text>
          </View>
        ) : (
          <View>
            <View className={styles.bell}>
              <Text className={styles.bellIcon}>🔔</Text>
            </View>
            <Text className={styles.titleCenter}>{t('onb.step2Title')}</Text>
            <Text className={styles.leadCenter}>{t('onb.step2Lead')}</Text>

            <View className={styles.settingCard}>
              <View className={styles.settingRow}>
                <View className={styles.settingMain}>
                  <Text className={styles.settingTitle}>{t('onb.remind')}</Text>
                  <Text className={styles.settingDesc}>{t('onb.remindDesc')}</Text>
                </View>
                <Switch checked={remind} color='#ff7a45' onChange={(e) => toggleRemind(!!e.detail.value)} />
              </View>
              <View className={styles.settingDivider} />
              <View className={styles.settingRow}>
                <View className={styles.settingMain}>
                  <Text className={styles.settingTitle}>{t('onb.voice')}</Text>
                  <Text className={styles.settingDesc}>{t('onb.voiceDesc')}</Text>
                </View>
                <Switch checked={voice} color='#ff7a45' onChange={(e) => toggleVoice(!!e.detail.value)} />
              </View>
            </View>

            {permHint ? <Text className={styles.permHint}>{permHint}</Text> : null}
            <Text className={styles.privacyLine}>{t('onb.privacy')}</Text>
          </View>
        )}

        {/* 进度点：2 步 */}
        <View className={styles.dots}>
          <View className={step === 1 ? styles.dotActive : styles.dot} />
          <View className={step === 2 ? styles.dotActive : styles.dot} />
        </View>

        <View className={styles.primaryBtn} onClick={() => (step === 1 ? setStep(2) : finish())}>
          <Text className={styles.primaryBtnText}>{step === 1 ? t('onb.next') : t('onb.enter')}</Text>
        </View>

        {step === 2 ? (
          <Text className={styles.laterBtn} onClick={finish}>
            {t('onb.later')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
