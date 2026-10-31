import { useEffect, useState } from 'react';
import { View, Text, Input, Picker, Switch, Button } from '@tarojs/components';
import type { CommonEvent, PickerTimeProps } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT, useLanguageStore } from '@/store/language';
import type { LangKey } from '@/store/language';
import { disabledAttr } from '@/utils/buttonDisabled';
import { hasKeyboard, requestHotkeyHelp } from '@/hooks/useHotkeys';
import { resolveCityName } from '@/utils/weather';
import { getTtsPrefs, saveTtsPrefs, TTS_RATE_OPTIONS } from '@/utils/tts';
import type { TtsPrefs, TtsVoiceMode } from '@/utils/tts';
import PromptModal from '@/components/PromptModal';
import { collectVault, validateVault, buildVaultFilename } from '@/utils/dataVault';
import { SYNC_KEYS } from '@/services/cloudSync';
import { readWatchKeywords, saveWatchKeywords } from '@/utils/intelWatchStore';
import { CITY_TEXT } from '../mine/feedbackText';
import styles from '../mine/index.module.scss';

/**
 * 偏好设置（2026-10-26 从「我的」页拆出）。
 *
 * 为什么拆：原「我的」页里这张通用设置卡高 366px（6 行），
 * 加上订阅卡 526px，两块占了整页 1780px 的一半 —— 而它们都不是「打开 App 要看的东西」。
 * 拆出后「我的」页回到身份页，改设置这件事变成一次明确的进入。
 *
 * 界线：这里只放**会影响下次晨报长什么样**的偏好。
 *   · 放这里：称呼、推送时间、晨报提醒、所在城市、语速、音色；
 *   · 不放这里：主题/字号/语言（在外观区，即时生效可预览）、AI 个性化与推送开关
 *     （「我的」页折叠区，属低频配置）、账号与合规（法务，保留在最外侧）。
 *
 * ⚠️ 存储键与写入方式与「我的」页原实现完全一致（`user-settings` / `user-city` / TTS 偏好），
 *    否则老用户的设置会在升级后"丢一次"。拆页不改数据契约。
 */
const CUSTOM_SETTINGS_KEY = 'user-settings';

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
    console.warn('[PrefsPage] load custom failed:', err);
    return DEFAULT_CUSTOM;
  }
}

/** V-05 语速三档文案（取值来自 utils/tts.ts 的 TTS_RATE_OPTIONS） */
const TTS_RATE_LABEL: Record<'slow' | 'standard' | 'fast', LangKey> = {
  slow: 'tts.rateSlow',
  standard: 'tts.rateStandard',
  fast: 'tts.rateFast'
};

/** V-07 音色策略：跟随场景 / 固定音色 */
const TTS_VOICE_MODES: Array<{ id: TtsVoiceMode; labelKey: LangKey }> = [
  { id: 'auto', labelKey: 'tts.voiceAuto' },
  { id: 'fixed', labelKey: 'tts.voiceFixed' }
];

const isWeapp = process.env.TARO_ENV === 'weapp';

function PrefsPage() {
  const { profile, saveSettings } = useUserStore();
  const { theme } = useThemeStore();
  const t = useT();
  const { lang } = useLanguageStore();

  const [nickname, setNickname] = useState('');
  const [custom, setCustom] = useState<CustomSettings>(DEFAULT_CUSTOM);
  const [ttsPrefs, setTtsPrefs] = useState<TtsPrefs>({ rate: 1.0, voiceMode: 'auto' });
  const [city, setCity] = useState(() => {
    try {
      return String(Taro.getStorageSync('user-city') || '');
    } catch {
      return '';
    }
  });
  const [cityOpen, setCityOpen] = useState(false);
  const [cityDraft, setCityDraft] = useState('');
  const [cityChecking, setCityChecking] = useState(false);

  useEffect(() => {
    if (profile) setNickname(profile.nickname);
  }, [profile]);

  useEffect(() => {
    setCustom(loadCustom());
    setTtsPrefs(getTtsPrefs());
  }, []);

  const persistCustom = (patch: Partial<CustomSettings>) => {
    const next = { ...custom, ...patch };
    setCustom(next);
    try {
      Taro.setStorageSync(CUSTOM_SETTINGS_KEY, next);
    } catch (err) {
      console.error('[PrefsPage] persist custom failed:', err);
    }
  };

  const handleBlurNickname = () => {
    const name = nickname.trim();
    if (!profile) return;
    if (name === profile.nickname) return;
    // 清空昵称不能静默 return —— 用户会以为「已保存为空」，实际什么也没发生。
    if (!name) {
      Taro.showToast({ title: t('mine.nicknameEmpty'), icon: 'none' });
      setNickname(profile.nickname);
      return;
    }
    void saveSettings({ nickname: name });
  };

  // Picker mode='time' 的 onChange 事件：value 即 'HH:mm'（Taro 官方事件类型）
  const handleChangeTime = (e: CommonEvent<PickerTimeProps.ChangeEventDetail>) => {
    void saveSettings({ briefingTime: e.detail.value });
  };

  const handlePickRate = (rate: number) => {
    setTtsPrefs(saveTtsPrefs({ rate }));
  };

  const handlePickVoiceMode = (voiceMode: TtsVoiceMode) => {
    setTtsPrefs(saveTtsPrefs({ voiceMode }));
  };

  const cityCopy = CITY_TEXT[lang];
  /** 未设置时如实标注「默认」—— 别让用户以为定位成功过 */
  const cityLabel = city || cityCopy.defaultTag;

  const openCityEditor = () => {
    setCityDraft(city);
    setCityOpen(true);
  };

  /**
   * 保存天气城市。存的是 **Open-Meteo 回传的规范地名**，不是用户原文。
   * 先校验再落库 —— 「已保存」必须意味着「下游 geocode 一定能解析出这个城市」，
   * 否则用户会得到一条看起来成功、实际天气还是错的消息。
   */
  const handleSaveCity = async () => {
    if (cityChecking) return;
    const name = cityDraft.trim();
    if (!name) {
      Taro.showToast({ title: cityCopy.empty, icon: 'none' });
      return;
    }
    setCityChecking(true);
    let canonical: string | null = null;
    try {
      canonical = await resolveCityName(name);
    } catch (err) {
      console.error('[PrefsPage] resolveCity failed:', err);
      canonical = null;
    }
    setCityChecking(false);
    if (!canonical) {
      Taro.showToast({ title: cityCopy.notFound, icon: 'none', duration: 2400 });
      return;
    }
    try {
      Taro.setStorageSync('user-city', canonical);
    } catch (err) {
      // 写盘失败不能报成功：提示重试，并保持弹层打开（草稿还在）
      console.error('[PrefsPage] save city failed:', err);
      Taro.showToast({ title: cityCopy.saveFailed, icon: 'none' });
      return;
    }
    setCity(canonical);
    setCityOpen(false);
    Taro.showToast({ title: `${cityCopy.savedPrefix}：${canonical}`, icon: 'none', duration: 2200 });
  };

  /** 键盘快捷键面板由 App 持有（全局单例），本页只发一个打开请求 */
  const handleOpenHotkeys = () => requestHotkeyHelp();

  // ===== 数据保险箱（2026-10-31）：全量导出 / 导入（docs 评估 §7.2 F + 设置缺口②）=====
  // 键清单单一事实源 = cloudSync.SYNC_KEYS；导入校验必须先过 dataVault.validateVault
  // （结构/版本不对一律拒绝，绝不「尽量恢复」——这是唯一会覆盖用户数据的路径）。
  const [vaultImportOpen, setVaultImportOpen] = useState(false);

  const handleVaultExport = async () => {
    const entries: Record<string, unknown> = {};
    for (const k of SYNC_KEYS) {
      try {
        entries[k] = Taro.getStorageSync(k);
      } catch {
        entries[k] = null;
      }
    }
    const { payload, dropped } = collectVault(entries);
    const json = JSON.stringify(payload, null, 2);
    if (process.env.TARO_ENV === 'h5') {
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildVaultFilename();
      // 必须先挂到 DOM 再 click（与记账导出同款，游离节点个别浏览器不触发下载）
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      await Taro.setClipboardData({ data: json });
    }
    if (dropped.length) {
      Taro.showToast({ title: t('prefs.vaultDropped').replace('{n}', String(dropped.length)), icon: 'none', duration: 2400 });
    }
  };

  const handleVaultImport = async (raw: string) => {
    // 体量护栏：正常备份 ~几十 KB，2MB 开外基本是粘错了东西
    if (raw.length > 2_000_000) {
      Taro.showToast({ title: t('prefs.vaultImportBad'), icon: 'none' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      Taro.showToast({ title: t('prefs.vaultImportBad'), icon: 'none' });
      return;
    }
    const res = validateVault(parsed);
    if (!res.ok) {
      Taro.showToast({ title: t('prefs.vaultImportBad'), icon: 'none' });
      return;
    }
    const keys = Object.keys(res.payload.keys);
    for (const k of keys) {
      Taro.setStorageSync(k, res.payload.keys[k]);
    }
    setVaultImportOpen(false);
    Taro.showToast({ title: t('prefs.vaultImportOk').replace('{n}', String(keys.length)), icon: 'success', duration: 2200 });
  };

  // ===== 追踪关键词（2026-10-31，产品评估 §7.2 E）：命中进晨报「追踪」区 =====
  const [watchWords, setWatchWords] = useState<string[]>(() => readWatchKeywords());
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchDraft, setWatchDraft] = useState('');

  const handleWatchSave = async (raw: string) => {
    const words = saveWatchKeywords(raw);
    setWatchWords(words);
    setWatchOpen(false);
    Taro.showToast({
      title: words.length ? t('prefs.watchSaved').replace('{n}', String(words.length)) : t('prefs.watchCleared'),
      icon: 'success',
      duration: 2000,
    });
  };

  const renderRow = (label: string, valueNode: React.ReactNode, onClick?: () => void) => (
    <View className={styles.row} onClick={onClick}>
      <Text className={styles.rowLabel}>{label}</Text>
      <View className={styles.rowValue}>{valueNode}</View>
    </View>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.settingGeneral')}</Text>
        {/* 周报与晨报存档入口（2026-10-31，产品评估 §7.2 A/B）：个人数据视图，v1 先挂在设置页，
            IA 是否独立成「我的」入口留给下一轮（我的页高度已顶满，别硬塞）。 */}
        {renderRow(
          t('prefs.reportEntry'),
          <>
            <Text className={styles.valueHint}>{t('prefs.reportEntryDesc')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          () => void Taro.navigateTo({ url: '/pages/report/index' })
        )}
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
        {/* 追踪关键词：命中进晨报「追踪」区；存 intel-watchlist（与自选股 watchlist 是两码事） */}
        {renderRow(
          t('prefs.watchTitle'),
          <>
            <Text className={styles.valueText}>
              {watchWords.length ? t('prefs.watchCount').replace('{n}', String(watchWords.length)) : t('prefs.watchOff')}
            </Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          () => {
            setWatchDraft(watchWords.join('，'));
            setWatchOpen(true);
          }
        )}
        {/* 天气城市：手动兜底，拒绝定位不再等于「永远是北京」。
            文案复用既有的 sync.key.user-city（'所在城市' / 'City'），不新增 i18n 键。 */}
        {renderRow(
          t('sync.key.user-city'),
          <>
            <Text className={styles.valueText}>{cityLabel}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          openCityEditor
        )}
        {/* V-05 语速三档 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('tts.rateLabel')}</Text>
          <View className={styles.scaleList}>
            {TTS_RATE_OPTIONS.map((opt) => (
              <View
                key={opt.id}
                className={classnames(styles.scaleChip, ttsPrefs.rate === opt.rate && styles.scaleChipActive)}
                onClick={() => handlePickRate(opt.rate)}
              >
                <Text className={classnames(styles.scaleText, ttsPrefs.rate === opt.rate && styles.scaleTextActive)}>
                  {t(TTS_RATE_LABEL[opt.id])}
                </Text>
              </View>
            ))}
          </View>
        </View>
        {/* V-07 音色策略：跟随场景 / 固定音色 */}
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('tts.voiceLabel')}</Text>
          <View className={styles.scaleList}>
            {TTS_VOICE_MODES.map((mode) => (
              <View
                key={mode.id}
                className={classnames(styles.scaleChip, ttsPrefs.voiceMode === mode.id && styles.scaleChipActive)}
                onClick={() => handlePickVoiceMode(mode.id)}
              >
                <Text
                  className={classnames(styles.scaleText, ttsPrefs.voiceMode === mode.id && styles.scaleTextActive)}
                >
                  {t(mode.labelKey)}
                </Text>
              </View>
            ))}
          </View>
        </View>
        {/* 微信端同声传译插件无 rate/pitch 参数（PRD Q2 已知限制），显式标注 */}
        {isWeapp ? <Text className={styles.platformHint}>{t('perm.platformUnsupported')}</Text> : null}
      </View>

      {/* 天气城市编辑弹层（与反馈/促销码共用半屏语言与控件样式，不引入第三套观感） */}
      {cityOpen ? (
        <View className={styles.docMask} onClick={() => setCityOpen(false)}>
          <View className={classnames(styles.docPanel, styles.fbPanel)} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>{t('sync.key.user-city')}</Text>
            <Text className={styles.fbIntro}>{cityCopy.hint}</Text>
            <Input
              className={styles.fbInput}
              value={cityDraft}
              maxlength={20}
              placeholder={cityCopy.placeholder}
              onInput={(e) => setCityDraft(e.detail.value)}
            />
            <View className={styles.fbActions}>
              <Button className={styles.fbCancel} onClick={() => setCityOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                className={styles.fbSubmit}
                disabled={disabledAttr(cityChecking)}
                onClick={() => void handleSaveCity()}
              >
                {cityChecking ? cityCopy.saving : cityCopy.save}
              </Button>
            </View>
          </View>
        </View>
      ) : null}
      {/* ===== 键盘快捷键（2026-10-27，仅桌面浏览器）=====
          快捷键是「看不见的功能」：没有可查的入口，等于只服务于写它的人。
          点开与按 `?` 打开的是同一个面板（面板本体挂在 App，是全局单例，这里只发请求）。
          ⚠️ 放这里而不是「我的」页：我的页三个入口已经把高度顶到 1.8 屏上限的 99%
          （640 视口 1427/1440px），再塞一张卡等于给下一个人埋雷；
          而且「键位表」本来就属于设置项，不属于身份信息。 */}
      {hasKeyboard() ? (
        <View className={styles.card}>
          {renderRow(
            t('hotkeys.title'),
            <>
              <Text className={styles.valueHint}>{t('hotkeys.entryDesc')}</Text>
              <Text className={styles.arrow}>›</Text>
            </>,
            handleOpenHotkeys
          )}
        </View>
      ) : null}

      {/* ===== 数据保险箱（2026-10-31）=====
          日程/待办/收藏/记忆/学习进度都是用户资产，此前没有任何「带走数据」的入口。
          放 prefs 不放「我的」：它是配置行为，且我的页高度已顶满（见 hotkeys 卡的注释）。
          键清单单一事实源 = cloudSync.SYNC_KEYS；导入先过 validateVault，拒绝即拒绝。 */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('prefs.vaultTitle')}</Text>
        {renderRow(
          t('prefs.vaultExport'),
          <>
            <Text className={styles.valueHint}>{t('prefs.vaultExportHint')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          () => void handleVaultExport()
        )}
        {renderRow(
          t('prefs.vaultImport'),
          <>
            <Text className={styles.valueHint}>{t('prefs.vaultImportHint')}</Text>
            <Text className={styles.arrow}>›</Text>
          </>,
          () => setVaultImportOpen(true)
        )}
      </View>
      <PromptModal
        visible={vaultImportOpen}
        title={t('prefs.vaultImport')}
        description={t('prefs.vaultImportDesc')}
        placeholder={t('prefs.vaultImportPlaceholder')}
        confirmText={t('prefs.vaultImportGo')}
        cancelText={t('cancel')}
        onConfirm={handleVaultImport}
        onCancel={() => setVaultImportOpen(false)}
      />
      <PromptModal
        visible={watchOpen}
        title={t('prefs.watchTitle')}
        description={t('prefs.watchDesc')}
        placeholder={t('prefs.watchPlaceholder')}
        initialValue={watchDraft}
        confirmText={t('prefs.watchSave')}
        cancelText={t('cancel')}
        onConfirm={handleWatchSave}
        onCancel={() => setWatchOpen(false)}
      />
    </View>
  );
}

export default PrefsPage;
