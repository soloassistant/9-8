import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Button, Switch, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import classnames from 'classnames';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT, useLanguageStore } from '@/store/language';
import type { LangKey } from '@/store/language';
import { apiCreateOrder, type CreateOrderPayload } from '@/services/api';
import { ordersListOwn, type CloudOrder } from '@/services/cloudOrders';
import { getPayChannel, getChannelAuth, invokePayment } from '@/services/pay';
import type { PayChannel, PayOrder } from '@/types';
import { disabledAttr } from '@/utils/buttonDisabled';
import { dayKey } from '@/utils/date';
import { copyKeyOf, resolveRenewal, shouldRemind } from '@/utils/renewal';
import type { RenewalCopyKey } from '@/utils/renewal';
import { redeemPromo } from '@/utils/promo';
import {
  EARLYBIRD_PRICE,
  formatPrice,
  listInboxNotices,
  lockPrice,
  markNoticeRead,
  readLockedPrice
} from '@/utils/subscription';
import type { LockedPriceInfo, PriceChangeNotice } from '@/utils/subscription';
import { FEATURES } from '@/utils/featureUsage';
import type { FeatureKey, UsageSummary } from '@/utils/featureUsage';
import { readUsageSummary } from '@/utils/usageLog';
import { clearReadStreak, getReadFreezeCards, getReadStreak } from '@/utils/readStreak';
import styles from '../mine/index.module.scss';

/**
 * 会员中心（2026-10-26 从「我的」页拆出）。
 *
 * 为什么单独成页：原「我的」页里订阅卡独占 526px（390×844 视口下整整 62% 屏），
 * 且排在第三位 —— 用户为了找「我买了什么、还剩多少」要在一张收银台前滚动。
 * 拆出后「我的」页回到「我是谁 + 我能用什么」的身份页，购买/账单/额度按需进入。
 *
 * 界线（和「我的」页的分工）：
 *   · 这里 = 交易与计量：方案、支付、续费提醒、账单、额度、功能记账、连续阅读；
 *   · 「我的」页 = 身份与偏好：头像、昵称、工具宫格、通知、偏好设置入口、合规。
 *
 * ⚠️ 支付链路（handleSubscribe）是**整段搬来**的，没有重写：
 *    锁价必须在 `payRes.success` 分支内、对账兜底定时器必须在卸载时清理，
 *    这两条都是踩过坑的约束（见下方各处注释），拆页时不许"顺手简化"。
 */

/** 危险操作确认按钮统一色值（设计文档第六章 B） */
const DANGER_COLOR = '#E85D2A';

/* ---------------- 续费提醒偏好（本机偏好，刻意不进 cloudSync） ---------------- */
const RENEW_REMIND_KEY = 'mb_renew_remind';
const RENEW_REMIND_DAY_KEY = 'mb_renew_remind_day';

function readRenewRemindPref(): boolean {
  try {
    const v = Taro.getStorageSync(RENEW_REMIND_KEY);
    return v === '' || v === undefined || v === null ? true : !!v;
  } catch {
    return true;
  }
}
function writeRenewRemindPref(on: boolean): void {
  try {
    Taro.setStorageSync(RENEW_REMIND_KEY, on);
  } catch (err) {
    console.warn('[MembershipPage] save renew remind pref failed:', err);
  }
}
function readRenewRemindDay(): string {
  try {
    return String(Taro.getStorageSync(RENEW_REMIND_DAY_KEY) || '');
  } catch {
    return '';
  }
}
function writeRenewRemindDay(day: string): void {
  try {
    Taro.setStorageSync(RENEW_REMIND_DAY_KEY, day);
  } catch (err) {
    console.warn('[MembershipPage] save renew remind day failed:', err);
  }
}

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

const RENEW_STATUS_KEY: Record<RenewalCopyKey, LangKey> = {
  statusNone: 'mine.renewStatusNone',
  statusActive: 'mine.renewStatusActive',
  statusExpiring: 'mine.renewStatusExpiring',
  statusToday: 'mine.renewStatusToday',
  statusExpired: 'mine.renewStatusExpired'
};

/** 通道图标：键是库里存的通道名。未知通道用通用图标兜底，不猜也不崩。 */
const CHANNEL_ICON: Record<string, string> = {
  wechat: '💬',
  alipay: '💰',
  douyin: '🎵'
};
const CHANNEL_ICON_FALLBACK = '🧾';

function getOrderStatusLabel(status: string, refundStatus: string): LangKey {
  if (refundStatus === 'refunded') return 'mine.orderStatusRefunded';
  if (refundStatus === 'refunding') return 'mine.orderStatusRefunding';
  switch (status) {
    case 'paid':
      return 'mine.orderStatusPaid';
    case 'created':
      return 'mine.orderStatusCreated';
    case 'closed':
      return 'mine.orderStatusClosed';
    default:
      return 'mine.orderStatusCreated';
  }
}

/** 订单状态 → 展示色（与「我的」页原实现逐字一致） */
function getOrderStatusColor(status: string, refundStatus: string): string {
  if (refundStatus === 'refunded') return '#999999';
  if (refundStatus === 'refunding') return '#E85D2A';
  if (status === 'paid') return '#16A34A'; // 绿
  if (status === 'created') return '#F59E0B'; // 橙
  if (status === 'closed') return '#999999'; // 灰
  return '#666666';
}

/** 功能记账的展示顺序与文案键（顺序与 utils/featureUsage.ts 的 FEATURES 一致） */
const FEATURE_LABEL_KEY: Record<FeatureKey, LangKey> = {
  chat: 'mine.fUsageChat',
  extract: 'mine.fUsageExtract',
  voice: 'mine.fUsageVoice',
  search: 'mine.fUsageSearch'
};

function MembershipPage() {
  const { profile, usage, init } = useUserStore();
  const { theme } = useThemeStore();
  const t = useT();
  const { lang } = useLanguageStore();

  const [planId, setPlanId] = useState<PayOrder['planId']>('earlybird_monthly');
  const [paying, setPaying] = useState(false);
  const [locked, setLocked] = useState<LockedPriceInfo | null>(null);
  const [notices, setNotices] = useState<PriceChangeNotice[]>([]);
  const [remindOn, setRemindOn] = useState(true);
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(false);
  /** 未登录：既不是「没有订单」也不是「加载失败」，第三种状态 */
  const [ordersNoAuth, setOrdersNoAuth] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [readStreak, setReadStreak] = useState(0);
  const [readFreezeCards, setReadFreezeCards] = useState(0);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoErr, setPromoErr] = useState('');

  /** 支付成功后的对账兜底定时器（1800ms）；卸载时清理，避免卸载后 setState + 重复查单 */
  const payReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (payReconcileTimerRef.current) clearTimeout(payReconcileTimerRef.current);
    },
    []
  );

  /* ---------------- 订阅记录（WorkBuddy 云数据库 orders 表） ---------------- */
  // 退款要服务端调支付通道的退款接口（云函数 refundOrder）。网页端没有这条通道，
  // 所以不渲染退款按钮 —— 和「订阅记录」同一条原则：做不到的入口一个都不给。
  const refundAvailable = (() => {
    const cloud = (Taro as unknown as { cloud?: { callFunction?: unknown } }).cloud;
    return typeof cloud?.callFunction === 'function';
  })();

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(false);
    setOrdersNoAuth(false);
    const res = await ordersListOwn(20);
    setOrdersLoading(false);
    if (res.ok) {
      setOrders(res.orders);
      return;
    }
    // 三态而不是两态：没登录不该给「重试」（重试也不会变成已登录），
    // 后端故障才值得重试。旧实现在 H5 把「这条链路根本不存在」也算成失败，
    // 于是那个「重试」按钮点多少次都不会成功。
    if (res.reason === 'no-session') {
      setOrders([]);
      setOrdersNoAuth(true);
      return;
    }
    setOrdersError(true);
  }, []);

  // 每次进页面重算本地数据（别的页面可能刚发生过 AI 调用/语音）+ 重新拉账单
  useDidShow(() => {
    setLocked(readLockedPrice());
    setNotices(listInboxNotices());
    setUsageSummary(readUsageSummary());
    setReadStreak(getReadStreak());
    setReadFreezeCards(getReadFreezeCards());
    setRemindOn(readRenewRemindPref());
    void loadOrders();
  });

  useEffect(() => {
    void init();
    // 仅挂载执行一次：init 为 store 动作
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 续费状态 ---------------- */
  const renewal = useMemo(
    () =>
      resolveRenewal({
        subscribed: !!profile?.subscribed,
        expiredAt: profile?.expiredAt || undefined,
        today: dayKey()
      }),
    [profile?.subscribed, profile?.expiredAt]
  );

  const renewalStatusText = useMemo(() => {
    const k = copyKeyOf(renewal);
    const n = Math.abs(renewal.daysLeft || 0);
    return t(RENEW_STATUS_KEY[k], { n });
  }, [renewal, t]);

  useEffect(() => {
    if (!renewal.remind || !remindOn) return;
    const today = dayKey();
    if (!shouldRemind(readRenewRemindDay(), today, renewal)) return;
    // 站内提示（不是推送）：产品明确不做自动续费，也不发模板消息，这里只提醒一次/天。
    Taro.showToast({
      title:
        renewal.status === 'expired'
          ? t('mine.renewWarnExpired')
          : (renewal.daysLeft || 0) === 0
            ? t('mine.renewToastToday')
            : t('mine.renewToast', { n: renewal.daysLeft || 0 }),
      icon: 'none',
      duration: 2600
    });
    writeRenewRemindDay(today);
  }, [renewal, remindOn, t]);

  const handleToggleRemind = useCallback((next: boolean) => {
    setRemindOn(next);
    writeRenewRemindPref(next);
    // 重新打开时清掉"今天已提示过"：否则开关拨回来却什么都不会发生，用户会以为开关是坏的
    if (next) writeRenewRemindDay('');
  }, []);

  const handleReadNotice = (id: string) => {
    markNoticeRead(id);
    setNotices(listInboxNotices());
  };

  const unreadNotices = useMemo(() => notices.filter((n) => !n.read), [notices]);

  /* ---------------- 支付 ---------------- */
  const handleSubscribe = async () => {
    if (paying) return;

    const channel = getPayChannel();
    if (!channel) {
      // 网页端没有在线支付通道（getPayChannel 恒 null）。不再把人往小程序赶 ——
      // 小程序这条线不做了，指过去等于让用户去一个不存在的地方。
      Taro.showToast({ title: t('mine.payH5Unavailable'), icon: 'none', duration: 3000 });
      return;
    }

    // 已订阅用户再点「立即订阅」会**重复下单扣费** —— 先做二次确认。
    // ⚠️ 必须放在 channel 判空之后：H5 没有支付通道，不能先弹续费确认、
    //    再告诉用户「请在小程序打开」，那是一次无意义的交互往返。
    if (profile?.subscribed) {
      const ok = await new Promise<boolean>((resolve) => {
        Taro.showModal({
          title: t('mine.renewTitle'),
          content: t('mine.renewBody', { date: (profile.expiredAt || '').slice(0, 10) }),
          cancelText: t('cancel'),
          confirmText: t('mine.renewConfirm'),
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        });
      });
      if (!ok) return;
    }
    setPaying(true);

    try {
      const auth = await getChannelAuth(channel);
      const payload: CreateOrderPayload = { planId, channel };
      if (channel === 'alipay') payload.buyerId = auth?.buyerId || '';
      if (channel === 'douyin') payload.openid = auth?.openid || '';

      const result = await apiCreateOrder(payload);
      if (!result.ok) throw new Error('createOrder 返回 ok=false');
      console.info('[MembershipPage] order created:', result.orderId, 'channel:', channel, 'plan:', result.planId);

      try {
        const payRes = await invokePayment(channel, result.payment);
        if (payRes.success) {
          // 锁价（B-01）：**必须**在支付成功分支内。原先写在下单后、支付前，
          // 用户取消支付 / 支付失败同样会写入 active 锁价，getEffectivePrice 此后
          // 一直返回这个未成交价，UI 常驻「锁价 ¥6.9」——把没成交的单子当成成交价展示。
          setLocked(lockPrice(result.planId, result.price));
          Taro.showToast({ title: '支付成功', icon: 'success' });
          const paidOrderId = result.orderId;
          payReconcileTimerRef.current = setTimeout(async () => {
            try {
              await init();
              const freshProfile = useUserStore.getState().profile;
              if (!freshProfile?.subscribed || !freshProfile?.expiredAt) {
                const cloud = (
                  Taro as unknown as {
                    cloud?: {
                      callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
                    };
                  }
                ).cloud;
                if (cloud?.callFunction) {
                  const q = await cloud.callFunction({ name: 'queryOrder', data: { orderId: paidOrderId } });
                  const qRes = q as {
                    ok?: boolean;
                    paid?: boolean;
                    reconciled?: boolean;
                    channelStatus?: string;
                  } | null;
                  if (qRes?.paid) {
                    console.info('[MembershipPage] ✅ queryOrder 主动对账完成，刷新 profile');
                    await init();
                  } else {
                    console.warn('[MembershipPage] queryOrder 返回未付 channelStatus=', qRes?.channelStatus);
                  }
                }
              }
              void loadOrders();
            } catch (e) {
              console.warn('[MembershipPage] 支付后对账兜底异常:', e);
            }
          }, 1800);
        }
      } catch (payErr) {
        const msg = String(payErr?.message || payErr || '');
        // 用户主动取消（微信：cancel；支付宝/douyin：canceled、用户取消）不算失败
        if (/cancel|取消/i.test(msg)) {
          console.info('[MembershipPage] user cancelled payment');
          Taro.showToast({ title: '已取消', icon: 'none' });
        } else {
          console.error('[MembershipPage] invokePayment failed:', payErr);
          Taro.showToast({ title: '这次没付成，可以再试一次', icon: 'none' });
        }
      }
    } catch (err) {
      console.error('[MembershipPage] createOrder failed:', err);
      Taro.showToast({ title: '没能下单，网络或服务暂时不通，稍后再试', icon: 'none' });
    } finally {
      setPaying(false);
    }
  };

  const handleRefund = useCallback(
    async (orderId: string, channel: string) => {
      if (refunding) return;
      // 抖音暂不支持自动退款 → 提示联系客服
      if (channel === 'douyin') {
        Taro.showModal({
          title: t('mine.refundBtn'),
          content: t('mine.refundDouyinNote'),
          showCancel: false,
          confirmText: 'OK'
        });
        return;
      }
      try {
        const res = await Taro.showModal({
          title: t('mine.refundBtn'),
          content: t('mine.refundBtn') + '？',
          confirmColor: DANGER_COLOR
        });
        if (!res.confirm) return;
        setRefunding(true);
        const cloud = (
          Taro as unknown as {
            cloud?: { callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown> };
          }
        ).cloud;
        if (!cloud?.callFunction) {
          Taro.showToast({ title: t('mine.refundFailed'), icon: 'none' });
          return;
        }
        // 只传 orderId：refundOrder 云函数内部按订单反查通道，客户端给 channel 反而是多余的可信输入
        const callRes = await cloud.callFunction({ name: 'refundOrder', data: { orderId } });
        const r = callRes as { result?: { ok?: boolean; manualRefund?: boolean; error?: string } } | null;
        if (r?.result?.ok) {
          Taro.showToast({ title: t('mine.refundSuccess'), icon: 'success' });
          await init(); // 刷新订阅状态（refundOrder 云函数已回滚 expiredAt）
          await loadOrders();
        } else if (r?.result?.manualRefund) {
          Taro.showToast({ title: t('mine.refundDouyinNote'), icon: 'none', duration: 2500 });
        } else {
          Taro.showToast({ title: r?.result?.error || t('mine.refundFailed'), icon: 'none' });
        }
      } catch (err) {
        console.warn('[MembershipPage] handleRefund error:', err);
        Taro.showToast({ title: t('mine.refundFailed'), icon: 'none' });
      } finally {
        setRefunding(false);
      }
    },
    [refunding, t, init, loadOrders]
  );

  /* ---------------- 促销码 ---------------- */
  const handleRedeemPromo = async () => {
    if (promoBusy) return;
    setPromoErr('');
    setPromoBusy(true);
    const res = redeemPromo(promoInput);
    if (!res.ok) {
      setPromoBusy(false);
      setPromoErr(
        t(
          res.reason === 'format'
            ? 'mine.promoBadFormat'
            : res.reason === 'expired'
              ? 'mine.promoExpired'
              : 'mine.promoUnknown'
        )
      );
      return;
    }
    setPromoBusy(false);
    setPromoOpen(false);
    setPromoInput('');
    Taro.showToast({ title: t('mine.promoDone', { date: res.expiredAt || '' }), icon: 'none', duration: 3000 });
    await init();
    await loadOrders();
  };

  /* ---------------- 额度百分比 ---------------- */
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

  const currentPayChannel: PayChannel | null = getPayChannel();
  const channelLabelKey = {
    wechat: 'mine.payChannelWechat',
    alipay: 'mine.payChannelAlipay',
    douyin: 'mine.payChannelDouyin'
  } as Record<PayChannel, LangKey>;
  const isH5 = process.env.TARO_ENV === 'h5';

  const handleClearReadStreak = () => {
    Taro.showModal({
      title: t('readStreak.clearTitle'),
      content: t('readStreak.clearBody', { n: readStreak }),
      cancelText: t('cancel'),
      confirmText: t('readStreak.clearConfirm'),
      confirmColor: DANGER_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        clearReadStreak();
        setReadStreak(getReadStreak());
        setReadFreezeCards(getReadFreezeCards());
        Taro.showToast({ title: t('readStreak.cleared'), icon: 'none' });
      }
    });
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {/* ===== 订阅区（B-01 锁价文案 / B-02 涨价通知 / 三通道支付） ===== */}
      <View className={styles.subCard}>
        <Text className={styles.subTitle}>{t('mine.subTitle')}</Text>
        <Text className={styles.subDesc}>{t('mine.subDesc')}</Text>
        {profile?.subscribed ? (
          <Text className={styles.subscribedUntil}>
            {t('mine.subscribedUntil', { date: (profile.expiredAt || '').slice(0, 10) })}
          </Text>
        ) : null}

        {/* ①-b 续费管理：到期倒计时 + 到期后会怎样 + 提醒开关。
            **必须始终渲染**，分两条理由：
              ① 产品上：没订阅的人更需要知道「不会自动扣费」，藏起来等于让人猜；
              ② 工程上：H5 的 `subscribed` 恒为 false（`localProfile.buildProfileFromSession`
                 没有订阅态来源），若按「有订阅才显示」收起，这块在**唯一能跑的形态里
                 就是不可达代码**，永远测不到、也永远看不到。
            none 态**只给状态徽标 + 不自动扣费**：不给到期日、不给倒计时、不给提醒开关
            （`daysLeft` 是 null，编一个日期出来就是假信息）。 */}
        <View className={styles.renewBlock}>
          <View className={styles.renewHead}>
            <Text className={styles.renewTitle}>{t('mine.renewMgmtTitle')}</Text>
            <View className={renewal.status === 'active' ? styles.renewTagIdle : styles.renewTag}>
              <Text className={renewal.status === 'active' ? styles.renewTagTextIdle : styles.renewTagText}>
                {renewalStatusText}
              </Text>
            </View>
          </View>
          {renewal.status === 'none' ? (
            <Text className={styles.renewUntil}>{t('mine.renewNoneHint')}</Text>
          ) : (
            <Text className={styles.renewUntil}>{t('mine.renewUntil', { date: renewal.expiredAt })}</Text>
          )}
          {renewal.status === 'active' || renewal.status === 'none' ? null : (
            <Text className={styles.renewWarn}>
              {renewal.status === 'expired' ? t('mine.renewWarnExpired') : t('mine.renewWarnExpiring')}
            </Text>
          )}
          {renewal.status === 'none' ? null : (
            <View className={styles.renewSwitchRow}>
              <Text className={styles.renewSwitchLabel}>{t('mine.renewRemind')}</Text>
              <Switch
                className={styles.renewSwitch}
                checked={remindOn}
                color='#ffd24a'
                onChange={(e) => handleToggleRemind(!!e.detail.value)}
              />
            </View>
          )}
          {/* 明确写出"不自动续费"：否则用户会默认以为到期自动扣款，反而不敢开提醒 */}
          <Text className={styles.renewNote}>{t('mine.renewNoAuto')}</Text>
          {/* 促销码兑换：H5 无支付通道时的开通路径。
              **仅 H5 显示**：weapp 的兑换走 redeemCode 云函数（一码一用，服务端 users 表发权益），
              该云函数待部署三件套就绪前 weapp 没有任何兑换入口 —— 比放一个写本地凭证的
              「假订阅」入口诚实（weapp 订阅态以服务端为准，本地凭证不改变云函数额度）。 */}
          {isH5 ? (
            <Text className={styles.promoEntry} onClick={() => setPromoOpen(true)}>
              {t('mine.promoEntry')} ›
            </Text>
          ) : null}
        </View>

        {/* ① 方案卡片横排（替换原 Picker） */}
        <View className={styles.planList}>
          {PLAN_LIST.map((p) => {
            const active = p.id === planId;
            const isEarlyBird = p.id === 'earlybird_monthly';
            const priceYuan = EARLYBIRD_PRICE[p.id] / 100;
            return (
              <View
                key={p.id}
                className={classnames(
                  styles.planCard,
                  active && styles.planCardActive,
                  isEarlyBird && styles.planCardEarlyBird
                )}
                onClick={() => setPlanId(p.id)}
              >
                {isEarlyBird ? <Text className={styles.planBadge}>{t('mine.planEarlyBirdTag')}</Text> : null}
                <Text className={styles.planLabel}>{t(PLAN_LABEL_KEY[p.id])}</Text>
                <Text className={styles.planPrice}>
                  ¥{priceYuan}
                  <Text className={styles.planUnit}>
                    {p.id === 'yearly' ? t('mine.planPerYear') : t('mine.planPerMonth')}
                  </Text>
                </Text>
              </View>
            );
          })}
        </View>

        {/* ② 锁价文案常驻（B-01：价格下方、支付按钮上方） */}
        <View className={styles.lockBlock}>
          <View className={styles.lockHead}>
            <Text className={styles.lockTitle}>{t('mine.lockTitle')}</Text>
            {locked && locked.active ? <Text className={styles.lockPrice}>{formatPrice(locked.price)}</Text> : null}
          </View>
          <Text className={styles.lockBody}>{t('mine.lockBody')}</Text>
          <Text className={styles.lockLose}>{t('mine.lockLose')}</Text>
        </View>

        {/* ③ 支付按钮 + 通道提示 */}
        <View className={styles.subButtonRow}>
          <View className={styles.subButtonGroup}>
            <Button
              className={styles.subButton}
              onClick={handleSubscribe}
              loading={paying}
              disabled={disabledAttr(paying)}
            >
              {paying ? t('mine.subscribing') : profile?.subscribed ? t('mine.renew') : t('mine.subscribe')}
            </Button>
            {currentPayChannel ? (
              <View className={styles.channelTag}>
                <Text className={styles.channelIcon}>{CHANNEL_ICON[currentPayChannel]}</Text>
                <Text className={styles.channelText}>{t(channelLabelKey[currentPayChannel])}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* ===== 订阅记录 ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.ordersTitle')}</Text>
        {ordersLoading && orders.length === 0 ? (
          <Text className={styles.orderLoading}>…</Text>
        ) : ordersNoAuth ? (
          /* 未登录：既不是「没有订单」也不是「加载失败」。不给重试（重试不会让人
             变成已登录），也不说「暂无记录」（那是在替用户断言他没买过）。 */
          <Text className={styles.orderUnavailable}>{t('mine.ordersNeedLogin')}</Text>
        ) : ordersError && orders.length === 0 ? (
          /* 查询失败与「真的没有记录」必须分开：老写法把两者都渲染成 ordersEmpty，
             已付费用户查不到订单时会看到「暂无订阅记录」——这是把故障伪装成空态。
             错误态三要素 = 发生了什么 + 为什么 + 怎么办。 */
          <View className={styles.orderErrorBox}>
            <Text className={styles.orderErrorText}>{t('mine.ordersError')}</Text>
            <Text className={styles.orderRetry} onClick={() => void loadOrders()}>
              {t('common.retry')}
            </Text>
          </View>
        ) : orders.length === 0 ? (
          <Text className={styles.orderEmpty}>{t('mine.ordersEmpty')}</Text>
        ) : (
          <ScrollView scrollY className={styles.orderList}>
            {orders.map((o) => {
              // channel 来自云端行、是不可信输入：空串时 ch[0] 为 undefined，
              // .toUpperCase() 直接抛错整页崩。空值/未知值都回落到原始串展示。
              const ch = String(o.channel || '');
              const channelLabel = ch
                ? t(`mine.orderChannel${ch[0].toUpperCase()}${ch.slice(1)}` as LangKey)
                : o.channel || '—';
              const channelIcon = CHANNEL_ICON[ch] || CHANNEL_ICON_FALLBACK;
              const statusLabel = getOrderStatusLabel(o.status, o.refundStatus);
              const statusColor = getOrderStatusColor(o.status, o.refundStatus);
              const canRefund =
                refundAvailable &&
                o.status === 'paid' &&
                o.refundStatus !== 'refunded' &&
                o.refundStatus !== 'refunding';
              const date = o.createTime ? new Date(o.createTime).toISOString().slice(0, 10) : '';
              return (
                <View className={styles.orderItem} key={o.orderId}>
                  <View className={styles.orderHead}>
                    <Text className={styles.orderChannelTag}>
                      {channelIcon} {channelLabel}
                    </Text>
                    <Text className={styles.orderStatus} style={{ color: statusColor }}>
                      {statusLabel}
                    </Text>
                  </View>
                  <View className={styles.orderBody}>
                    <Text className={styles.orderPlan}>
                      {PLAN_LABEL_KEY[o.planId as PayOrder['planId']]
                        ? t(PLAN_LABEL_KEY[o.planId as PayOrder['planId']])
                        : o.planId}
                    </Text>
                    <Text className={styles.orderPrice}>
                      ¥{o.price} · {t('mine.orderMonths', { n: o.months })}
                    </Text>
                  </View>
                  <View className={styles.orderFoot}>
                    <Text className={styles.orderDate}>{date}</Text>
                    {canRefund ? (
                      <Text className={styles.orderRefundBtn} onClick={() => handleRefund(o.orderId, o.channel)}>
                        {t('mine.refundBtn')}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* B-02：调价站内信 */}
      {unreadNotices.length > 0 ? (
        <View className={styles.card}>
          {unreadNotices.map((notice) => (
            <View className={styles.noticeItem} key={notice.id}>
              <Text className={styles.noticeTitle}>{t(notice.titleKey)}</Text>
              <Text className={styles.noticeBody}>{t(notice.bodyKey, notice.params)}</Text>
              <View className={styles.noticeActions}>
                <Text className={styles.linkText} onClick={() => handleReadNotice(notice.id)}>
                  {t('mine.docRead')}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* ===== 用量与统计 ===== */}
      <View className={styles.quotaCard}>
        <Text className={styles.quotaTitle}>{t('mine.quotaTitle')}</Text>
        <View className={styles.quotaRow}>
          <View className={styles.quotaHead}>
            <Text className={styles.quotaLabel}>{t('mine.quotaVoice')}</Text>
            <Text className={styles.quotaValue}>
              {usage
                ? usage.voiceQuota < 0
                  ? t('mine.unlimited')
                  : `${usage.voiceUsed}/${usage.voiceQuota}${lang === 'zh' ? ' 条' : ''}`
                : '…'}
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
        {/* 功能记账：额度条只说明"还剩多少"，这里说明"用在哪"。 */}
        <View className={styles.usageBlock}>
          <View className={styles.usageHead}>
            <Text className={styles.usageTitle}>{t('mine.usageTitle')}</Text>
            <Text className={styles.usageRange}>{t('mine.usageWeek')}</Text>
          </View>
          {usageSummary === null ? (
            <Text className={styles.usageEmpty}>…</Text>
          ) : usageSummary.weekTotal === 0 ? (
            <Text className={styles.usageEmpty}>{t('mine.usageEmpty')}</Text>
          ) : (
            <View className={styles.usageList}>
              {FEATURES.map((f) => (
                <View className={styles.usageItem} key={f}>
                  <Text className={styles.usageName}>{t(FEATURE_LABEL_KEY[f])}</Text>
                  <Text className={styles.usageNum}>
                    {usageSummary.week[f]}
                    <Text className={styles.usageToday}>
                      {` · ${t('mine.usageToday')} ${usageSummary.today[f]}`}
                    </Text>
                  </Text>
                </View>
              ))}
            </View>
          )}
          <Text className={styles.usageNote}>{t('mine.usageNote')}</Text>
        </View>
      </View>

      {/* v2.1：晨报连续阅读（只读展示 + 清空入口；主 streak 已改挂晨报） */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('mine.readStreakTitle')}</Text>
        <View className={styles.row}>
          <Text className={styles.rowLabel}>{t('readStreak.hint')}</Text>
          <View className={styles.rowValue}>
            <Text className={styles.valueText}>{t('mine.readStreakValue', { n: readStreak })}</Text>
            {readFreezeCards > 0 ? (
              <Text className={styles.valueHint}>{t('readStreak.cardLabel', { n: readFreezeCards })}</Text>
            ) : null}
          </View>
        </View>
        {readStreak > 0 || readFreezeCards > 0 ? (
          <View className={styles.memoryActions}>
            <Text className={styles.dangerText} onClick={handleClearReadStreak}>
              {t('readStreak.clearTitle')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* 促销码兑换弹层（与反馈/城市共用半屏语言与控件样式，不引入第三套观感） */}
      {promoOpen ? (
        <View className={styles.docMask} onClick={() => setPromoOpen(false)}>
          <View className={classnames(styles.docPanel, styles.fbPanel)} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.docTitle}>{t('mine.promoTitle')}</Text>
            <Text className={styles.fbIntro}>{t('mine.promoHint')}</Text>
            <Input
              className={styles.fbInput}
              type='text'
              value={promoInput}
              maxlength={14}
              placeholder={t('mine.promoPlaceholder')}
              onInput={(e) => {
                setPromoInput(String(e.detail.value || '').toUpperCase());
                setPromoErr('');
              }}
            />
            {promoErr ? <Text className={styles.fbError}>{promoErr}</Text> : null}
            <View className={styles.fbActions}>
              <Button className={styles.fbCancel} onClick={() => setPromoOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                className={styles.fbSubmit}
                disabled={disabledAttr(promoBusy)}
                onClick={() => void handleRedeemPromo()}
              >
                {t('mine.promoSubmit')}
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default MembershipPage;
