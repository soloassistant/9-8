import { useCallback, useMemo, useState } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT } from '@/store/language';
import { openExternalPage } from '@/utils/externalLink';
import {
  CITY_GEO,
  QUICK_CITIES,
  SHOP_PLATFORMS,
  FOOD_PLATFORMS,
  FOOD_TIPS,
  FLIGHT_PLATFORMS,
  RAIL_OFFICIAL,
  RAIL_PLAYBOOK,
  SEAT_GUIDE,
  type FlightPlatform
} from '@/config/sxmPlatforms';
import {
  greatCircleKm,
  estimateModes,
  humanHours,
  modeVerdict,
  resolveCityName,
  buildShopUrl,
  buildFlightUrl,
  buildRailUrl,
  type FlightUrlResult
} from '@/utils/sxmDecision';
import styles from './index.module.scss';

/** 复制链接 toast 停留时长（ms），与 PartnerEntry 保持一致 */
const TOAST_MS = 3000;

const isH5 = process.env.TARO_ENV === 'h5';

type TabId = 'travel' | 'compare' | 'save';
type FieldId = 'from' | 'to';

/** Date → 'YYYY-MM-DD'（本地时区，Picker mode='date' 要求的格式） */
function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天 / 明天。上游的默认是「明天」，但必须在界面上写明这是默认值。 */
function todayIso(): string {
  return toIso(new Date());
}
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toIso(d);
}

const PICK_LABEL_KEY = {
  rail: 'sxm.pickRail',
  air: 'sxm.pickAir',
  tie: 'sxm.pickTie'
} as const;

/**
 * 省心买 · 小程序原生页（阶段 B 第一期）。
 *
 * 设计原则与上游一致：**只放跳转入口和静态字典，不编任何价格**。
 * 比价分栏显式声明「未接入比价数据源，不显示价格」，整页不出现任何价格数字；
 * 城市认不出时明说认不出，不拿默认值糊过去。
 */
function SxmPage() {
  const t = useT();
  const { theme } = useThemeStore();

  const [tab, setTab] = useState<TabId>('travel');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 常用城市快捷键补进哪个输入框：跟随最后一次聚焦的字段，默认出发地
  const [activeField, setActiveField] = useState<FieldId>('from');
  const [date, setDate] = useState<string>(tomorrowIso());
  const [keyword, setKeyword] = useState('');

  /**
   * 统一的链接交付：两端行为不同，且这是平台限制而不是偷懒 ——
   * H5 新标签打开；小程序端本仓没有 web-view 页面（微信只对企业主体开放），
   * 只能复制给用户。复制成功/失败都必须让用户看见，不能「点了没反应」。
   */
  const deliverUrl = useCallback(
    async (url: string) => {
      if (!url) {
        Taro.showToast({ title: t('sxm.copyFail'), icon: 'none', duration: TOAST_MS });
        return;
      }
      const result = await openExternalPage(url);
      if (result === 'opened') return;
      Taro.showToast({
        title: result === 'copied' ? t('sxm.copyHint') : t('sxm.copyFail'),
        icon: 'none',
        duration: TOAST_MS
      });
    },
    [t]
  );

  const pickQuickCity = (city: string) => {
    if (activeField === 'from') setFrom(city);
    else setTo(city);
  };

  /** 出行分栏的全部派生结果（不编数字：km / 耗时都来自真实的坐标与移植算法） */
  const travel = useMemo(() => {
    const fromRaw = from.trim();
    const toRaw = to.trim();
    const fromName = fromRaw ? resolveCityName(fromRaw) : null;
    const toName = toRaw ? resolveCityName(toRaw) : null;
    const fromUnknown = fromRaw.length > 0 && fromName === null;
    const toUnknown = toRaw.length > 0 && toName === null;
    const sameCity = fromName !== null && fromName === toName;

    let km: number | null = null;
    let railUrl = '';
    let flightLinks: Array<{ platform: FlightPlatform; result: FlightUrlResult }> = [];

    if (fromName && toName && !sameCity) {
      const a = CITY_GEO[fromName];
      const b = CITY_GEO[toName];
      if (a && b) {
        km = greatCircleKm(a, b);
        railUrl = buildRailUrl(fromName, toName, date);
        flightLinks = FLIGHT_PLATFORMS.map((platform) => ({
          platform,
          result: buildFlightUrl(platform.id, fromName, toName, date)
        }));
      }
    }

    return { fromName, toName, fromUnknown, toUnknown, sameCity, km, railUrl, flightLinks };
  }, [from, to, date]);

  const verdict = travel.km === null ? null : modeVerdict(travel.km);
  const estimate = travel.km === null ? null : estimateModes(travel.km);
  const canRoute = travel.km !== null;
  const keywordReady = keyword.trim().length > 0;

  const copySearchLink = (platformId: string) => {
    if (!keywordReady) {
      Taro.showToast({ title: t('sxm.keywordEmpty'), icon: 'none', duration: TOAST_MS });
      return;
    }
    deliverUrl(buildShopUrl(platformId, keyword.trim()));
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <Text className={styles.title}>{t('sxm.title')}</Text>
        <Text className={styles.subtitle}>{t('sxm.subtitle')}</Text>
      </View>

      <View className={styles.tabs}>
        {(['travel', 'compare', 'save'] as TabId[]).map((id) => (
          <View
            key={id}
            className={id === tab ? styles.tabActive : styles.tab}
            onClick={() => setTab(id)}
          >
            <Text className={styles.tabText}>
              {t(id === 'travel' ? 'sxm.tabTravel' : id === 'compare' ? 'sxm.tabCompare' : 'sxm.tabSave')}
            </Text>
          </View>
        ))}
      </View>

      <ScrollView scrollY className={styles.body}>
        {/* ================= 出行 ================= */}
        {tab === 'travel' ? (
          <View className={styles.section}>
            <View className={styles.fieldRow}>
              <Text className={styles.fieldLabel}>{t('sxm.fromPlaceholder')}</Text>
              <Input
                className={styles.input}
                value={from}
                placeholder={t('sxm.fromPlaceholder')}
                onFocus={() => setActiveField('from')}
                onInput={(e) => setFrom(e.detail.value)}
              />
            </View>
            <View className={styles.fieldRow}>
              <Text className={styles.fieldLabel}>{t('sxm.toPlaceholder')}</Text>
              <Input
                className={styles.input}
                value={to}
                placeholder={t('sxm.toPlaceholder')}
                onFocus={() => setActiveField('to')}
                onInput={(e) => setTo(e.detail.value)}
              />
            </View>

            <View className={styles.chipBlock}>
              <Text className={styles.chipHint}>{t('sxm.quickCities')}</Text>
              <View className={styles.chips}>
                {QUICK_CITIES.map((city) => (
                  <View key={city} className={styles.chip} onClick={() => pickQuickCity(city)}>
                    <Text className={styles.chipText}>{city}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View className={styles.dateRow}>
              <Text className={styles.fieldLabel}>{t('sxm.dateLabel')}</Text>
              <Picker mode='date' value={date} start={todayIso()} onChange={(e) => setDate(String(e.detail.value))}>
                <View className={styles.dateBox}>
                  <Text className={styles.dateValue}>{date}</Text>
                </View>
              </Picker>
            </View>
            <Text className={styles.dateNote}>{t('sxm.dateHint')}</Text>

            {/* 认不出城市 / 同一城市：明说，不用默认值糊过去 */}
            {travel.fromUnknown ? (
              <View className={styles.warnCard}>
                <Text className={styles.warnText}>{t('sxm.cityUnknown', { name: from.trim() })}</Text>
              </View>
            ) : null}
            {travel.toUnknown ? (
              <View className={styles.warnCard}>
                <Text className={styles.warnText}>{t('sxm.cityUnknown', { name: to.trim() })}</Text>
              </View>
            ) : null}
            {travel.sameCity ? (
              <View className={styles.warnCard}>
                <Text className={styles.warnText}>{t('sxm.sameCity')}</Text>
              </View>
            ) : null}
            {!canRoute && !travel.fromUnknown && !travel.toUnknown && !travel.sameCity ? (
              <View className={styles.hintCard}>
                <Text className={styles.hintText}>{t('sxm.needCities')}</Text>
              </View>
            ) : null}

            {canRoute && verdict && estimate ? (
              <>
                <View className={styles.resultCard}>
                  <View className={styles.resultRow}>
                    <Text className={styles.resultLabel}>{t('sxm.distanceLabel')}</Text>
                    <Text className={styles.kmValue}>{Math.round(travel.km as number)} km</Text>
                  </View>
                  <View className={styles.verdictRow}>
                    <Text className={styles.verdictLabel}>{t('sxm.verdictLabel')}</Text>
                    <Text className={styles.verdictPick}>{t(PICK_LABEL_KEY[verdict.pick])}</Text>
                  </View>
                  <Text className={styles.verdictText}>{verdict.text}</Text>
                </View>

                <View className={styles.estimateCard}>
                  <Text className={styles.sectionTitle}>{t('sxm.estimateLabel')}</Text>
                  <View className={styles.estimateRow}>
                    <Text className={styles.estimateLabel}>{t('sxm.estRail')}</Text>
                    <Text className={styles.estimateValue}>{humanHours(estimate.rail)}</Text>
                  </View>
                  <View className={styles.estimateRow}>
                    <Text className={styles.estimateLabel}>{t('sxm.estAir')}</Text>
                    <Text className={styles.estimateValue}>{humanHours(estimate.air)}</Text>
                  </View>
                  <Text className={styles.noteText}>{t('sxm.estimateNote')}</Text>
                </View>

                {/* 火车票：12306 官方入口 */}
                <Text className={styles.sectionTitle}>{t('sxm.railOfficialTitle')}</Text>
                <View className={styles.platformCard}>
                  <Text className={styles.pfBadge}>铁</Text>
                  <View className={styles.pfMain}>
                    <Text className={styles.pfName}>{RAIL_OFFICIAL.name}</Text>
                    <Text className={styles.pfDesc}>{RAIL_OFFICIAL.desc}</Text>
                  </View>
                  <View className={styles.pfAction} onClick={() => deliverUrl(travel.railUrl)}>
                    <Text className={styles.pfActionText}>
                      {isH5 ? t('sxm.openLink') : t('sxm.copyLink')}
                    </Text>
                  </View>
                </View>

                {/* 机票平台入口：飞猪那条没有深链，必须明说 */}
                <Text className={styles.sectionTitle}>{t('sxm.flightTitle')}</Text>
                {travel.flightLinks.map(({ platform, result }) => (
                  <View key={platform.id} className={styles.platformCard}>
                    <Text className={styles.pfBadge}>{platform.abbr}</Text>
                    <View className={styles.pfMain}>
                      <Text className={styles.pfName}>
                        {platform.name}
                        {platform.tag ? <Text className={styles.pfTag}>{platform.tag}</Text> : null}
                      </Text>
                      <Text className={styles.pfDesc}>{platform.desc}</Text>
                      {result.ok ? null : (
                        <Text className={styles.pfWarn}>{t('sxm.flightNoDeeplink')}</Text>
                      )}
                    </View>
                    <View
                      className={result.ok || result.url ? styles.pfAction : styles.pfActionDisabled}
                      onClick={() => deliverUrl(result.url)}
                    >
                      <Text className={styles.pfActionText}>
                        {isH5 ? t('sxm.openLink') : t('sxm.copyLink')}
                      </Text>
                    </View>
                  </View>
                ))}

                {/* 席别建议 */}
                <Text className={styles.sectionTitle}>{t('sxm.seatGuide')}</Text>
                {SEAT_GUIDE.map((seat) => (
                  <View key={seat.n} className={styles.listItem}>
                    <Text className={styles.listName}>{seat.n}</Text>
                    <Text className={styles.listText}>{seat.d}</Text>
                  </View>
                ))}

                {/* 候补玩法 */}
                <Text className={styles.sectionTitle}>{t('sxm.railPlaybook')}</Text>
                {RAIL_PLAYBOOK.map((tip, i) => (
                  <View key={i} className={styles.listItem}>
                    <Text className={styles.listIndex}>{i + 1}</Text>
                    <Text className={styles.listText}>{tip}</Text>
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ) : null}

        {/* ================= 比价 ================= */}
        {tab === 'compare' ? (
          <View className={styles.section}>
            {/* 必须显式写在最前面：没有数据源就不显示价格 */}
            <View className={styles.disclaimer}>
              <Text className={styles.disclaimerText}>{t('sxm.compareDisclaimer')}</Text>
            </View>

            <View className={styles.fieldRow}>
              <Text className={styles.fieldLabel}>{t('sxm.compareTitle')}</Text>
              <Input
                className={styles.input}
                value={keyword}
                placeholder={t('sxm.keywordPlaceholder')}
                onInput={(e) => setKeyword(e.detail.value)}
              />
            </View>

            {SHOP_PLATFORMS.map((platform) => (
              <View key={platform.id} className={styles.platformCard}>
                <Text className={styles.pfBadge}>{platform.abbr}</Text>
                <View className={styles.pfMain}>
                  <Text className={styles.pfName}>
                    {platform.name}
                    {platform.tag ? <Text className={styles.pfTag}>{platform.tag}</Text> : null}
                  </Text>
                  <Text className={styles.pfDesc}>{platform.desc}</Text>
                </View>
                <View
                  className={keywordReady ? styles.pfAction : styles.pfActionDisabled}
                  onClick={() => copySearchLink(platform.id)}
                >
                  <Text className={styles.pfActionText}>{t('sxm.copySearch')}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* ================= 省钱 ================= */}
        {tab === 'save' ? (
          <View className={styles.section}>
            <Text className={styles.sectionTitle}>{t('sxm.saveFoodTitle')}</Text>
            {FOOD_TIPS.map((tip, i) => (
              <View key={i} className={styles.listItem}>
                <Text className={styles.listIndex}>{i + 1}</Text>
                <Text className={styles.listText}>{tip}</Text>
              </View>
            ))}

            <Text className={styles.sectionTitle}>{t('sxm.saveFoodEntry')}</Text>
            {FOOD_PLATFORMS.map((platform) => (
              <View key={platform.id} className={styles.platformCard}>
                <Text className={styles.pfBadge}>{platform.abbr}</Text>
                <View className={styles.pfMain}>
                  <Text className={styles.pfName}>
                    {platform.name}
                    {platform.tag ? <Text className={styles.pfTag}>{platform.tag}</Text> : null}
                  </Text>
                </View>
                <View className={styles.pfAction} onClick={() => deliverUrl(platform.url)}>
                  <Text className={styles.pfActionText}>
                    {isH5 ? t('sxm.openLink') : t('sxm.copyLink')}
                  </Text>
                </View>
              </View>
            ))}

            <Text className={styles.sectionTitle}>{t('sxm.savePlaybookTitle')}</Text>
            {RAIL_PLAYBOOK.map((tip, i) => (
              <View key={i} className={styles.listItem}>
                <Text className={styles.listIndex}>{i + 1}</Text>
                <Text className={styles.listText}>{tip}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

export default SxmPage;
