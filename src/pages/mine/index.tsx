import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Picker, Button, Image, Input, Switch, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import classnames from 'classnames';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore, THEME_PRESETS } from '@/store/theme';
import { useUiScaleStore, UI_SCALE_PRESETS } from '@/store/uiScale';
import { useT, useLanguageStore, LANG_OPTIONS } from '@/store/language';
import type { LangKey } from '@/store/language';
import { apiCreateOrder, apiDeleteAccount } from '@/services/api';
import { LEARNING_ROUTES } from '@/pages/learn/routes.host';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import { fromNow } from '@/utils/date';
import { getActivityLogs } from '@/utils/activityLog';
import type { ActivityLogItem } from '@/utils/activityLog';
import type { PayOrder } from '@/types';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const isH5 = process.env.TARO_ENV === 'h5';
const AVATAR_KEY = 'user-avatar';
/** H5 预览端可选的预设头像 */
const AVATAR_PRESETS = ['🌅', '🌞', '🌱', '🐳', '🦊', '🐼'];

const PLAN_LIST: Array<{ id: PayOrder['planId']; label: string }> = [
  { id: 'earlybird_monthly', label: '早鸟月付' },
  { id: 'monthly', label: '月付' },
  { id: 'yearly', label: '年付' }
];

/** 存储值保持中文，展示时按当前语言翻译 */
const PLAN_LABEL_KEY: Record<string, LangKey> = {
  earlybird_monthly: 'mine.planEarlyBird',
  monthly: 'mine.planMonthly',
  yearly: 'mine.planYearly'
};

const PREF_TAG_LABEL: Record<string, LangKey> = {
  '科技': 'mine.prefTech',
  '效率工具': 'mine.prefProductivity',
  '财经': 'mine.prefFinance',
  '健康': 'mine.prefHealth',
  '出行': 'mine.prefTravel',
  '生活': 'mine.prefLife',
  'AI': 'mine.prefAi'
};

const REPLY_STYLE_LABEL: Record<string, LangKey> = {
  '简洁': 'mine.replyConcise',
  '均衡': 'mine.replyBalanced',
  '详细': 'mine.replyDetailed'
};

const UI_SCALE_LABEL: Record<string, LangKey> = {
  small: 'mine.uiSizeSmall',
  standard: 'mine.uiSizeStandard',
  large: 'mine.uiSizeLarge',
  xlarge: 'mine.uiSizeXlarge'
};

/** TODO：上线前在小程序后台绑定企业微信客服后替换 */
const SERVICE_CORP_ID = 'TODO_CORP_ID';

const PREF_TAGS = ['科技', '效率工具', '财经', '健康', '出行', '生活', 'AI'];
const REPLY_STYLES = ['简洁', '均衡', '详细'];
const CUSTOM_SETTINGS_KEY = 'user-settings';
const AI_MEMORY_KEY = 'ai-memory';

const AI_MEMORY_SEED = [
  '称呼偏好：喜欢被叫「晨友」',
  '起床习惯：工作日 7:00 起，晨报偏好 7:30 推送',
  '常搜内容：效率工具、行业资讯',
  '沟通偏好：回复偏简洁，先给结论'
];

// 法务文本统一取自 src/data/legal.ts（与首启同意弹窗共用），勿在此重复声明


interface CustomSettings {
  replyStyle: string;
  newsEnabled: boolean;
  morningReminderEnabled: boolean;
}

const DEFAULT_CUSTOM: CustomSettings = {
  replyStyle: '均衡',
  newsEnabled: true,
  morningReminderEnabled: true
};

function loadCustom(): CustomSettings {
  try {
    return { ...DEFAULT_CUSTOM, ...(Taro.getStorageSync(CUSTOM_SETTINGS_KEY) || {}) };
  } catch (err) {
    return DEFAULT_CUSTOM;
  }
}

function MinePage() {
  const { profile, usage, init, saveSettings } = useUserStore();
  const { theme, setTheme } = useThemeStore();
  const { id: scaleId, setScale } = useUiScaleStore();
  const t = useT();
  const { lang, setLang } = useLanguageStore();
  const [planId, setPlanId] = useState<PayOrder['planId']>('earlybird_monthly');
  const [paying, setPaying] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [logs, setLogs] = useState<ActivityLogItem[]>([]);
  // 设置项（自独立设置页合并而来）
  const [nickname, setNickname] = useState('');
  const [prefs, setPrefs] = useState<string[]>([]);
  const [custom, setCustom] = useState<CustomSettings>(DEFAULT_CUSTOM);
  const [memory, setMemory] = useState<string[]>([]);
  const [docView, setDocView] = useState<'terms' | 'privacy' | 'ai' | null>(null);

  useEffect(() => {
    init();
  }, []);

  // profile 就绪后回填设置项 + 读取本地自定义设置/AI 记忆
  useEffect(() => {
    if (profile) {
      setNickname(profile.nickname);
      setPrefs(profile.preferences || []);
    }
    setCustom(loadCustom());
    try {
      const saved = Taro.getStorageSync(AI_MEMORY_KEY);
      setMemory(Array.isArray(saved) && saved.length ? saved : AI_MEMORY_SEED);
    } catch (err) {
      setMemory(AI_MEMORY_SEED);
    }
  }, [profile]);

  // 每次切回「我的」页刷新近期动态（最新 3 条）
  useDidShow(() => {
    setLogs(getActivityLogs().slice(0, 3));
  });

  // 恢复本地头像（微信端为本地/临时图片路径，H5 端为 emoji）
  useEffect(() => {
    try {
      const saved = Taro.getStorageSync(AVATAR_KEY) as string;
      if (saved) setAvatar(saved);
    } catch (err) {
      console.warn('[MinePage] restore avatar failed:', err);
    }
  }, []);

  const doChangeAvatar = () => {
    if (isWeapp) {
      Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        success: (res) => {
          const path = res.tempFiles?.[0]?.tempFilePath;
          if (!path) return;
          // TODO：正式版将图片上传到云存储（Taro.cloud.uploadFile）后使用 fileID
          setAvatar(path);
          Taro.setStorageSync(AVATAR_KEY, path);
          Taro.showToast({ title: '头像已更新', icon: 'success' });
        },
        fail: (err) => console.info('[MinePage] chooseMedia cancelled:', err && err.errMsg)
      });
    } else {
      Taro.showActionSheet({ itemList: AVATAR_PRESETS })
        .then((res) => {
          const next = AVATAR_PRESETS[res.tapIndex];
          if (!next) return;
          setAvatar(next);
          Taro.setStorageSync(AVATAR_KEY, next);
          Taro.showToast({ title: '头像已更新', icon: 'success' });
        })
        .catch(() => {});
    }
  };

  /** 点头像：更换头像 或 查看浏览历史（v2.0 F26） */
  const handleAvatarTap = () => {
    Taro.showActionSheet({ itemList: ['更换头像', '浏览历史'] })
      .then((res) => {
        if (res.tapIndex === 0) doChangeAvatar();
        else if (res.tapIndex === 1) Taro.navigateTo({ url: '/pages/history/index' });
      })
      .catch(() => {});
  };

  const isEmojiAvatar = (val: string) => val.length <= 4;

  const voicePercent = useMemo(() => {
    if (!usage) return 0;
    if (usage.voiceQuota < 0) return 0;
    return Math.min(100, Math.round((usage.voiceUsed / usage.voiceQuota) * 100));
  }, [usage]);

  const collectionPercent = useMemo(() => {
    if (!usage) return 0;
    if (usage.collectionQuota < 0) return 0;
    return Math.min(100, Math.round((usage.collectionCount / usage.collectionQuota) * 100));
  }, [usage]);

  const handleSubscribe = async () => {
    if (paying) return;
    setPaying(true);
    try {
      const order = await apiCreateOrder(planId);
      console.info('[MinePage] order created:', order.orderId);
      // TODO：微信支付需要主体资质与商户号，接入后替换为 Taro.requestPayment(order.payment)
      Taro.showModal({
        title: '开发环境提示',
        content: `已创建模拟订单：${PLAN_LIST.find((p) => p.id === planId)?.label} ¥${order.price}。微信支付将在主体资质就绪后接入。`,
        showCancel: false
      });
    } catch (err) {
      console.error('[MinePage] createOrder failed:', err);
      Taro.showToast({ title: '下单失败，请稍后再试', icon: 'none' });
    } finally {
      setPaying(false);
    }
  };

  // ===== 设置项处理（自独立设置页合并而来） =====
  const memorySummary = useMemo(() => t('mine.memoryCount', { n: memory.length }), [memory, t]);

  const persistCustom = (patch: Partial<CustomSettings>) => {
    const next = { ...custom, ...patch };
    setCustom(next);
    try {
      Taro.setStorageSync(CUSTOM_SETTINGS_KEY, next);
    } catch (err) {
      console.error('[MinePage] persist custom failed:', err);
    }
  };

  const handleBlurNickname = () => {
    const name = nickname.trim();
    if (!profile || !name || name === profile.nickname) return;
    saveSettings({ nickname: name });
  };

  const handleChangeTime = (e) => {
    saveSettings({ briefingTime: e.detail.value as string });
  };

  const handleTogglePref = (tag: string) => {
    const next = prefs.includes(tag) ? prefs.filter((t) => t !== tag) : [...prefs, tag].slice(0, 5);
    setPrefs(next);
    saveSettings({ preferences: next });
  };

  const handleReplyStyle = (e) => {
    const idx = Number(e.detail.value);
    persistCustom({ replyStyle: REPLY_STYLES[idx] || '均衡' });
  };

  const handleClearMemory = () => {
    Taro.showModal({
      title: '清空 AI 记忆',
      content: '助理将忘记你的习惯与偏好（不影响日程和待办数据）。',
      confirmText: '清空',
      confirmColor: '#E85D2A',
      success: (res) => {
        if (res.confirm) {
          try {
            Taro.setStorageSync(AI_MEMORY_KEY, []);
          } catch (err) {
            console.error('[MinePage] clear memory failed:', err);
          }
          setMemory([]);
          Taro.showToast({ title: '已清空，将重新学习', icon: 'success' });
        }
      }
    });
  };

  const handleOpenPrivacyManage = () => {
    const openPrivacyContract = (Taro as unknown as { openPrivacyContract?: (opt?: Record<string, unknown>) => Promise<unknown> })
      .openPrivacyContract;
    if (isWeapp && typeof openPrivacyContract === 'function') {
      openPrivacyContract
        .call(Taro, {})
        .catch(() => Taro.showToast({ title: '请在微信「设置-隐私」中管理授权', icon: 'none' }));
    } else {
      Taro.showToast({ title: '微信端可管理隐私授权', icon: 'none' });
    }
  };

  const handleDeleteAccount = () => {
    Taro.showModal({
      title: '注销账号',
      content: '将永久删除你的日程、待办、收藏与全部个人数据，此操作不可恢复。确定继续？',
      confirmText: '确认注销',
      confirmColor: '#E85D2A',
      success: (res) => {
        if (!res.confirm) return;
        apiDeleteAccount()
          .then(() => {
            try {
              Taro.clearStorageSync();
            } catch (err) {
              console.error('[MinePage] clear storage failed:', err);
            }
            Taro.showToast({ title: '已注销，数据已删除', icon: 'success' });
            setTimeout(() => Taro.reLaunch({ url: '/pages/briefing/index' }), 1200);
          })
          .catch((err) => {
            console.error('[MinePage] deleteAccount failed:', err);
            Taro.showToast({ title: '注销失败，请稍后再试', icon: 'none' });
          });
      }
    });
  };

  const handleContactService = () => {
    const fallback = () => {
      Taro.showModal({
        title: '联系客服',
        content: '工作时间 9:00-21:00\n微信搜索公众号「私人晨报助理」留言\n或发邮件至 support@morningbrief.cn',
        confirmText: '知道了',
        showCancel: false
      });
    };
    if (isWeapp) {
      const openChat = (Taro as unknown as { openCustomerServiceChat?: (opt: Record<string, unknown>) => void })
        .openCustomerServiceChat;
      if (typeof openChat === 'function') {
        try {
          openChat({ corpId: SERVICE_CORP_ID, extInfo: { url: '' }, fail: fallback });
        } catch (err) {
          console.warn('[MinePage] openCustomerServiceChat failed:', err);
          fallback();
        }
      } else {
        fallback();
      }
    } else {
      fallback();
    }
  };

  const renderRow = (label: string, valueNode: React.ReactNode, onClick?: () => void) => (
    <View className={styles.row} onClick={onClick}>
      <Text className={styles.rowLabel}>{label}</Text>
      <View className={styles.rowValue}>{valueNode}</View>
    </View>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.userCard}>
        <Button className={styles.avatarBtn} onClick={handleAvatarTap}>
          <View className={styles.avatar}>
            {avatar ? (
              isEmojiAvatar(avatar) ? (
                <Text className={styles.avatarText}>{avatar}</Text>
              ) : (
                <Image className={styles.avatarImg} src={avatar} mode='aspectFill' />
              )
            ) : (
              <Text className={styles.avatarText}>🌅</Text>
            )}
          </View>
          <Text className={styles.avatarEdit}>{t('mine.avatarEdit')}</Text>
        </Button>
        <View className={styles.userBody}>
          <Text className={styles.nickname}>{profile?.nickname || '晨友'}</Text>
          <Text className={styles.userMeta}>
            {profile?.subscribed && profile?.expiredAt
              ? `订阅至 ${profile.expiredAt.slice(0, 10)}`
              : t('mine.freeUser')}
          </Text>
        </View>
        {profile?.subscribed ? (
          <View className={styles.subBadge}>
            <Text className={styles.subBadgeText}>
              {profile.isEarlyBird ? t('mine.earlyBirdBadge') : t('mine.memberBadge')}
            </Text>
          </View>
        ) : null}
      </View>

      <View className={styles.subCard}>
        <Text className={styles.subTitle}>{t('mine.subTitle')}</Text>
        <Text className={styles.subDesc}>{t('mine.subDesc')}</Text>
        <View className={styles.subActions}>
          <Picker
            mode='selector'
            range={PLAN_LIST.map((p) => t(PLAN_LABEL_KEY[p.id]))}
            value={PLAN_LIST.findIndex((p) => p.id === planId)}
            onChange={(e) => setPlanId(PLAN_LIST[Number(e.detail.value)].id)}
          >
            <View className={styles.priceTag}>
              <Text>
                <Text className={styles.price}>¥6.9</Text>
                <Text className={styles.priceNote}>
                  {t('mine.priceNote', { plan: t(PLAN_LABEL_KEY[planId]) })}
                </Text>
              </Text>
            </View>
          </Picker>
          <Button className={styles.subButton} onClick={handleSubscribe}>
            {paying ? t('mine.subscribing') : t('mine.subscribe')}
          </Button>
        </View>
      </View>

      <View className={styles.quotaCard}>
        <Text className={styles.quotaTitle}>{t('mine.quotaTitle')}</Text>
        <View className={styles.quotaRow}>
          <View className={styles.quotaHead}>
            <Text className={styles.quotaLabel}>{t('mine.quotaVoice')}</Text>
            <Text className={styles.quotaValue}>
              {usage ? (usage.voiceQuota < 0 ? t('mine.unlimited') : `${usage.voiceUsed}/${usage.voiceQuota}${lang === 'zh' ? ' 条' : ''}`) : '…'}
            </Text>
          </View>
          <View className={styles.bar}>
            <View
              className={voicePercent >= 90 ? styles.barFillWarning : styles.barFill}
              style={{ width: `${voicePercent}%` }}
            />
          </View>
        </View>
        <View className={styles.quotaRow}>
          <View className={styles.quotaHead}>
            <Text className={styles.quotaLabel}>{t('mine.quotaFav')}</Text>
            <Text className={styles.quotaValue}>
              {usage
                ? usage.collectionQuota < 0
                  ? t('mine.unlimited')
                  : `${usage.collectionCount}/${usage.collectionQuota}${lang === 'zh' ? ' 条' : ''}`
                : '…'}
            </Text>
          </View>
          <View className={styles.bar}>
            <View
              className={collectionPercent >= 90 ? styles.barFillWarning : styles.barFill}
              style={{ width: `${collectionPercent}%` }}
            />
          </View>
        </View>
      </View>

      {/* 近期动态：最新 3 条日志（v2.0） */}
      <View className={styles.logCard}>
        <Text className={styles.logTitle}>{t('mine.recent')}</Text>
        {logs.length > 0 ? (
          logs.map((log) => (
            <View className={styles.logRow} key={log.id}>
              <Text className={styles.logIcon}>{log.icon}</Text>
              <Text className={styles.logText}>{log.text}</Text>
              <Text className={styles.logTime}>{fromNow(log.time)}</Text>
            </View>
          ))
        ) : (
          <Text className={styles.logEmpty}>
            {t('mine.recentEmpty')}
          </Text>
        )}
      </View>

      {/* ===== 设置项（自独立设置页合并：通用 / AI 个性化 / 外观 / 账号与合规） ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingGeneral')}</Text>
        {renderRow(
          t('mine.nickname'),
          <Input
            className={styles.input}
            value={nickname}
            maxlength={12}
            placeholder={t('mine.nicknamePlaceholder')}
            onInput={(e) => setNickname(e.detail.value)}
            onBlur={handleBlurNickname}
          />
        )}
        <Picker mode='time' value={profile?.briefingTime || '07:30'} onChange={handleChangeTime}>
          {renderRow(
            t('mine.briefingTime'),
            <>
              <Text className={styles.valueText}>{profile?.briefingTime || '07:30'}</Text>
              <Text className={styles.arrow}>›</Text>
            </>
          )}
        </Picker>
        {renderRow(
          t('mine.briefingRemind'),
          <Switch
            checked={custom.morningReminderEnabled}
            color={theme.color}
            onChange={(e) => persistCustom({ morningReminderEnabled: e.detail.value })}
          />
        )}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAi')}</Text>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.prefTags')}</Text>
          <Text className={styles.valueHint}>{t('mine.prefMax')}</Text>
        </View>
        <View className={styles.tagList}>
          {PREF_TAGS.map((tag) => (
            <View
              key={tag}
              className={classnames(styles.tag, prefs.includes(tag) && styles.tagActive)}
              onClick={() => handleTogglePref(tag)}
            >
              <Text className={classnames(styles.tagText, prefs.includes(tag) && styles.tagTextActive)}>
                {t(PREF_TAG_LABEL[tag] || '')}
              </Text>
            </View>
          ))}
        </View>
        <Picker
          mode='selector'
          range={REPLY_STYLES.map((s) => t(REPLY_STYLE_LABEL[s]))}
          value={REPLY_STYLES.indexOf(custom.replyStyle)}
          onChange={handleReplyStyle}
        >
          {renderRow(
            t('mine.replyStyle'),
            <>
              <Text className={styles.valueText}>{t(REPLY_STYLE_LABEL[custom.replyStyle] || '')}</Text>
              <Text className={styles.arrow}>›</Text>
            </>
          )}
        </Picker>
        {renderRow(
          t('mine.aiMemory'),
          <>
            <Text className={styles.valueText}>{memorySummary}</Text>
            <Text className={styles.linkText} onClick={handleClearMemory}>
              {t('mine.clear')}
            </Text>
          </>
        )}
        {renderRow(
          t('mine.hotNews'),
          <Switch
            checked={custom.newsEnabled}
            color={theme.color}
            onChange={(e) => persistCustom({ newsEnabled: e.detail.value })}
          />
        )}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAppearance')}</Text>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.uiColor')}</Text>
          <View className={styles.swatchList}>
            {THEME_PRESETS.map((preset) => (
              <View
                key={preset.id}
                className={classnames(styles.swatch, theme.id === preset.id && styles.swatchActive)}
                style={{ background: preset.color }}
                onClick={() => setTheme(preset.id)}
              >
                {theme.id === preset.id ? <Text className={styles.swatchCheck}>✓</Text> : null}
              </View>
            ))}
          </View>
        </View>
        {/* 界面大小：H5 端通过 --ui-scale 调节 rem 基准，即时生效（weapp 端 rpx 字号暂不支持全局缩放） */}
        {isH5 ? (
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('mine.uiSize')}</Text>
            <View className={styles.scaleList}>
              {UI_SCALE_PRESETS.map((p) => (
                <View
                  key={p.id}
                  className={classnames(styles.scaleChip, scaleId === p.id && styles.scaleChipActive)}
                  onClick={() => setScale(p.id)}
                >
                  <Text className={classnames(styles.scaleText, scaleId === p.id && styles.scaleTextActive)}>
                    {t(UI_SCALE_LABEL[p.id])}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {/* 语言切换：中 / EN，全局即时生效 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.uiLang')}</Text>
          <View className={styles.scaleList}>
            {LANG_OPTIONS.map((opt) => (
              <View
                key={opt.id}
                className={classnames(styles.scaleChip, lang === opt.id && styles.scaleChipActive)}
                onClick={() => setLang(opt.id)}
              >
                <Text className={classnames(styles.scaleText, lang === opt.id && styles.scaleTextActive)}>
                  {opt.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* 账号与合规（F18 提审硬门槛） */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingAccount')}</Text>
        {renderRow(
          t('mine.terms'),
          <Text className={styles.arrow} onClick={() => setDocView('terms')}>
            ›
          </Text>,
          () => setDocView('terms')
        )}
        {renderRow(
          t('mine.privacy'),
          <Text className={styles.arrow} onClick={() => setDocView('privacy')}>
            ›
          </Text>,
          () => setDocView('privacy')
        )}
        {renderRow(
          t('mine.aiNotice'),
          <Text className={styles.arrow} onClick={() => setDocView('ai')}>
            ›
          </Text>,
          () => setDocView('ai')
        )}
        {renderRow(
          t('mine.privacyManage'),
          <>
            <Text className={styles.valueText}>{t('mine.manageAuth')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          handleOpenPrivacyManage
        )}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('mine.service')}</Text>
          <View className={styles.rowValue}>
            <Text className={styles.linkText} onClick={handleContactService}>
              {t('mine.feedback')}
            </Text>
          </View>
        </View>
        {renderRow(
          t('mine.deleteAccount'),
          <>
            <Text className={styles.dangerText}>{t('mine.deleteData')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          handleDeleteAccount
        )}
      </View>

      {/* 其他入口 */}
      <View className={styles.settingCard}>
        <View className={styles.settingRow} onClick={() => Taro.navigateTo({ url: LEARNING_ROUTES.home })}>
          <Text className={styles.settingLabel}>{t('mine.learn')}</Text>
          <View className={styles.settingValue}>
            <Text>{t('mine.learnDesc')}</Text>
            <Text className={styles.entryArrow}>›</Text>
          </View>
        </View>
        <View className={styles.settingRow} onClick={() => Taro.navigateTo({ url: '/pages/shopping/index' })}>
          <Text className={styles.settingLabel}>{t('mine.shopping')}</Text>
          <View className={styles.settingValue}>
            <Text>{t('mine.shoppingDesc')}</Text>
            <Text className={styles.entryArrow}>›</Text>
          </View>
        </View>
      </View>

      <View className={styles.privacyCard}>
        <Text className={styles.privacyText}>
          {t('mine.privacyNote')}
        </Text>
      </View>

      {/* 协议/隐私半屏查看层 */}
      {docView ? (
        <View className={styles.docMask} onClick={() => setDocView(null)}>
          <View className={styles.docPanel} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>
              {docView === 'terms' ? t('mine.terms') : docView === 'privacy' ? t('mine.privacy') : t('mine.aiNotice')}
            </Text>
            <ScrollView scrollY className={styles.docBody}>
              <Text className={styles.docText}>
                {docView === 'terms' ? TERMS_TEXT : docView === 'privacy' ? PRIVACY_TEXT : AI_SERVICES_TEXT}
              </Text>
            </ScrollView>
            <Button className={styles.docClose} onClick={() => setDocView(null)}>
              {t('mine.docRead')}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default MinePage;
