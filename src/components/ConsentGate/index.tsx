import { useState } from 'react';
import { View, Text, ScrollView, Button } from '@tarojs/components';
import { useT, useLanguageStore } from '@/store/language';
import { saveConsent, PRIVACY_TEXT, TERMS_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';

interface ConsentGateProps {
  /** 用户点击「同意」后回调：由调用方写 storage 标记并关闭本层 */
  onAgree: () => void;
}

/**
 * H5 首启合规同意层（应用级）。
 *
 * 历史：原先只嵌在 briefing 页内（P0 缺陷：切到收件箱/热点/日历/我的 等其它 tab 或悬浮 AI 面板
 * 时同意层不挂载，等于「可绕过同意直接使用」）。现上移到 App 外壳，覆盖所有 tab 页与 AI 助理，
 * 未同意前整屏遮罩阻断一切交互（含 TabBar 与悬浮球，因遮罩 z 高于二者且全屏覆盖）。
 *
 * 仅在网页端启用：小程序端依赖微信平台隐私弹窗机制，不在此重复弹。
 */
export default function ConsentGate({ onAgree }: ConsentGateProps) {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const [declined, setDeclined] = useState(false);

  const handleAgree = () => {
    saveConsent();
    onAgree();
  };
  const handleDecline = () => setDeclined(true);

  if (!isH5) return null;

  return (
    <View className={styles.consentMask}>
      <View className={styles.consentPanel}>
        <Text className={styles.consentTitle}>{t('consent.title')}</Text>
        {declined ? (
          <View className={styles.consentDeclinedBox}>
            <Text className={styles.consentDeclinedText}>{t('consent.declinedBody')}</Text>
          </View>
        ) : (
          <ScrollView scrollY className={styles.consentBody}>
            {/* 法务原文只有中文版：英文界面下必须先声明「以中文版为准」 */}
            {lang === 'en' ? (
              <Text className={styles.consentText}>{`${t('legal.langNotice')}\n\n`}</Text>
            ) : null}
            <Text className={styles.consentText}>{PRIVACY_TEXT}</Text>
            <Text className={styles.consentText}>{'\n\n'}</Text>
            <Text className={styles.consentText}>{TERMS_TEXT}</Text>
            <Text className={styles.consentText}>{'\n\n'}</Text>
            <Text className={styles.consentText}>{AI_SERVICES_TEXT}</Text>
          </ScrollView>
        )}
        <Text className={styles.consentHint}>{t('consent.hint')}</Text>
        <View className={styles.consentActions}>
          <Button className={styles.consentDecline} onClick={handleDecline}>
            {t('consent.decline')}
          </Button>
          <Button className={styles.consentAgree} onClick={handleAgree}>
            {t('consent.agree')}
          </Button>
        </View>
      </View>
    </View>
  );
}
