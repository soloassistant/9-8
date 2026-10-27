import { useCallback, useMemo, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import EmptyState from '@/components/EmptyState';
import PromptModal from '@/components/PromptModal';
import DemoDataHint from '@/components/DemoDataHint';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT } from '@/store/language';
import PartnerEntry, { PartnerSectionHeader } from '@/components/PartnerEntry';
import { SXM_ENTRY_URL } from '@/config/partners';
import {
  apiShoppingList,
  apiShoppingAdd,
  apiShoppingToggleBought,
  apiShoppingRemove,
  apiShoppingAddPrice,
  apiShoppingSetTargetPrice,
  apiShoppingClearTargetPrice,
  type ShoppingItem
} from '@/services/api';
import {
  evaluatePriceAlerts,
  formatAlert,
  markNotified,
  clearNotified,
  type PricedItem
} from '@/utils/price';
import styles from './index.module.scss';

/** 记价弹窗的输入示例（格式：平台 价格） */
const PRICE_INPUT_SAMPLE = '例：京东 2599';
/** 平台 + 价格（支持千分位）提取正则 */
const PRICE_PATTERN = /([一-龥A-Za-z]+)\s*([\d.,]+)/;
/** 降价提醒 toast 停留时长（ms） */
const ALERT_TOAST_MS = 3000;

/** 省心买已在小程序端原生重做，入口改为页面内跳转；H5 端保持"浏览器打开网页版"不变 */
const isH5 = process.env.TARO_ENV === 'h5';
const SXM_NATIVE_PATH = '/pages/sxm/index';

/** 结果区条目（P-03：isAd 区分 AI 推荐与推广内容，两者不得混排在同一张卡片内） */
interface ResultEntry {
  id: string;
  title: string;
  desc: string;
  isAd: boolean;
}

/**
 * 结果区内容源：当前版本无广告位，维持「无广告」状态（空数组）；
 * 接入推广时在此追加 isAd: true 的条目，页面会自动以「广告」区块独立渲染。
 */
const RESULT_ENTRIES: ResultEntry[] = [];

/** 购物清单 → 比价最小字段集（交给 utils/price.ts 做纯逻辑比对） */
function toPricedItem(item: ShoppingItem): PricedItem {
  return {
    id: item.id,
    name: item.name,
    targetPrice: item.targetPrice,
    prices: item.prices,
    lastNotifiedPrice: item.lastNotifiedPrice
  };
}

function ShoppingPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [list, setList] = useState<ShoppingItem[]>([]);
  /** 加载失败态（2026-10-24 审计）：与「真空清单」区分 —— 原来 load 失败只 console.error，
   *  list 保持 []，页面渲染「购物清单还是空的」，把「拉取失败」伪装成「真的没数据」。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  /** 输入弹窗：add = 记一条比价，target = 改心理价位 */
  const [priceDialog, setPriceDialog] = useState<
    { kind: 'add'; item: ShoppingItem } | { kind: 'target'; item: ShoppingItem } | null
  >(null);

  // 真机走云函数（云端按 openid），H5 走本地 mock storage，保证两端读到的是同一份清单
  const load = useCallback(async () => {
    try {
      const data = await apiShoppingList();
      setList(data || []);
      setLoadFailed(false);
    } catch (err) {
      console.error('[ShoppingPage] load failed:', err);
      // 不静默失败（铁律）：失败时置位 + toast，空态文案据此改为「加载失败」而不是「还是空的」
      setLoadFailed(true);
      Taro.showToast({ title: t('common.loadFailed'), icon: 'none' });
    }
  }, [t]);

  // 加载清单：首次挂载 + 每次切回本页（useDidShow 首次也会触发）时刷新，
  // 保证 AI 往清单加过商品后回来能看到最新数据
  useDidShow(() => {
    load();
  });

  /**
   * 时机① 手动更新价格后的即时比对（P-01）：命中则弹降价提醒并记录已提醒价，
   * 未命中返回 false，调用方继续走原来的「已记录比价」提示。
   */
  const runPriceCheck = useCallback((item: ShoppingItem): boolean => {
    const alerts = evaluatePriceAlerts([toPricedItem(item)]);
    if (alerts.length === 0) return false;
    alerts.forEach((alert) => markNotified(alert.itemId, alert.price));
    setList((prev) =>
      prev.map((it) => {
        const hit = alerts.find((alert) => alert.itemId === it.id);
        return hit ? { ...it, lastNotifiedPrice: hit.price } : it;
      })
    );
    Taro.showToast({ title: formatAlert(alerts[0], t), icon: 'none', duration: ALERT_TOAST_MS });
    return true;
  }, [t]);

  const addItem = async () => {
    const n = name.trim();
    if (!n) return;
    const p = Number(targetPrice.replace(/[^\d.]/g, ''));
    const added = await apiShoppingAdd({
      name: n,
      targetPrice: Number.isFinite(p) && p > 0 ? p : undefined
    });
    if (added) {
      setList((prev) => [added, ...prev]);
      setName('');
      setTargetPrice('');
      Taro.showToast({ title: '已加入购物清单', icon: 'success' });
    } else {
      // 不静默失败：apiShoppingAdd 返回 null（云端不可用/写入失败）时用户必须看见
      Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
    }
  };

  const toggleBought = async (id: string) => {
    const res = await apiShoppingToggleBought(id);
    if (res) {
      setList((prev) => prev.map((it) => (it.id === id ? { ...it, bought: res.bought } : it)));
    } else {
      Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
    }
  };

  const removeItem = (id: string) => {
    Taro.showModal({
      title: '删掉这件商品？',
      content: '删掉后就找不回来了，只能重新加一次。',
      confirmText: '删掉',
      cancelText: '留着',
      confirmColor: '#ee5a29',
      success: async (res) => {
        if (res.confirm) {
          const done = await apiShoppingRemove(id);
          if (done) setList((prev) => prev.filter((it) => it.id !== id));
        }
      }
    });
  };

  /** 记多平台价格（手动比价记录，对应 PRD F23 兜底形态）；记完立即比对心理价位 */
  const addPrice = (id: string) => {
    const item = list.find((it) => it.id === id);
    if (!item) return;
    // 用页内 PromptModal 而不是 showModal editable：后者在 H5 上不返回 content，
    // 输入永远被当成空串丢弃（详见 components/PromptModal 顶部说明）
    setPriceDialog({ kind: 'add', item });
  };

  /** 设置 / 修改心理价位（P-01：数字输入，单位元，可随时修改） */
  const editTargetPrice = (item: ShoppingItem) => {
    setPriceDialog({ kind: 'target', item });
  };

  /** PromptModal 确认：按打开时的 kind 分流到原有两个写入路径 */
  const submitPriceDialog = async (raw: string) => {
    if (!priceDialog) return;
    const { kind, item } = priceDialog;
    const input = raw.trim();

    if (kind === 'add') {
      const m = input.match(PRICE_PATTERN);
      // 空输入与格式不合都必须给用户看见提示：旧实现 `if (!input) return` 在 H5 上
      // 因为拿不到 content 而静默失败，用户点了确认却什么都没发生
      if (!input || !m) {
        Taro.showToast({ title: '格式：平台 价格', icon: 'none' });
        return;
      }
      const price = Number(m[2].replace(/,/g, ''));
      if (!Number.isFinite(price) || price <= 0) {
        Taro.showToast({ title: '格式：平台 价格', icon: 'none' });
        return;
      }
      const done = await apiShoppingAddPrice(item.id, m[1], price);
      if (!done) {
        Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
        return;
      }
      const next: ShoppingItem = { ...item, prices: done.prices };
      setList((prev) => prev.map((it) => (it.id === item.id ? { ...it, prices: done.prices } : it)));
      if (!runPriceCheck(next)) {
        Taro.showToast({ title: '已记录比价', icon: 'success' });
      }
      setPriceDialog(null);
      return;
    }

    // 心理价位沿用原来的宽松数字清洗，但空串/非法值不再静默 return
    const price = Number(input.replace(/[^\d.]/g, ''));
    if (!input || !Number.isFinite(price) || price <= 0) {
      Taro.showToast({ title: t('shopping.invalidPrice'), icon: 'none' });
      return;
    }
    const done = await apiShoppingSetTargetPrice(item.id, price);
    if (!done) {
      Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
      return;
    }
    const next: ShoppingItem = { ...item, targetPrice: done.targetPrice };
    setList((prev) => prev.map((it) => (it.id === item.id ? { ...it, targetPrice: done.targetPrice } : it)));
    runPriceCheck(next);
    setPriceDialog(null);
  };

  /** 清除心理价位（P-01）：同时清掉该商品的已提醒价，避免残留去重记录 */
  const clearTargetPrice = async (item: ShoppingItem) => {
    const done = await apiShoppingClearTargetPrice(item.id);
    if (!done) {
      Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
      return;
    }
    clearNotified(item.id);
    setList((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, targetPrice: undefined, lastNotifiedPrice: undefined } : it))
    );
  };

  const summary = useMemo(() => {
    const total = list.length;
    const bought = list.filter((it) => it.bought).length;
    return { total, bought };
  }, [list]);

  // P-03：推广内容与 AI 推荐分离，只取 isAd 的条目进广告区块
  const adEntries = RESULT_ENTRIES.filter((entry) => entry.isAd);

  const bestPrice = (prices: { price: number }[]) =>
    prices.length ? `￥${Math.min(...prices.map((p) => p.price)).toLocaleString()}` : null;

  /**
   * 明确的返回入口：H5 的 TabRouter 不渲染原生导航栏，二级页没有返回键会走进死路。
   * 优先 navigateBack（保留来源页状态），栈里只剩本页时兜底 reLaunch 回晨报。
   */
  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => {
        Taro.reLaunch({ url: '/pages/briefing/index' });
      });
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.backButton} onClick={handleBack}>
        <Text className={styles.backIcon}>‹</Text>
        <Text className={styles.backText}>{t('common.back')}</Text>
      </View>
      {/* 云端不可用、已回退本地/演示实现时如实提示（诚实性，来源 briefing.degraded） */}
      <DemoDataHint />
      <View className={styles.addBar}>
        <Input
          className={styles.nameInput}
          value={name}
          placeholder={t('shopping.addPlaceholder')}
          onInput={(e) => setName(e.detail.value)}
          confirmType='done'
          onConfirm={addItem}
        />
        <Input
          className={styles.priceInput}
          value={targetPrice}
          placeholder={t('shopping.targetPlaceholder')}
          type='digit'
          onInput={(e) => setTargetPrice(e.detail.value)}
        />
        <View className={styles.addBtn} onClick={addItem}>
          {t('shopping.add')}
        </View>
      </View>

      <View className={styles.summaryBar}>
        <Text className={styles.summaryText}>
          共 {summary.total} 件 · 已买 {summary.bought} 件
        </Text>
        <Text className={styles.summaryHint}>{t('shopping.summaryHint')}</Text>
      </View>

      <ScrollView scrollY className={styles.list}>
        {list.length === 0 ? (
          loadFailed ? (
            // 加载失败 ≠ 空清单：文案必须说清是「没读到」而不是「没有」，否则用户
            // 会以为自己清单被清空了（2026-10-24 审计，铁律「不静默失败」）
            <EmptyState icon='⚠️' title='清单没加载出来' hint='下拉刷新看看；一直不行的话，多半是服务在重启，过几分钟再来' />
          ) : (
            <EmptyState icon='🛒' title='购物清单还是空的' hint='在上方输入想买的东西，我帮你记着并跟进比价' />
          )
        ) : (
          list.map((item) => {
            const cheapest = bestPrice(item.prices);
            return (
              <View key={item.id} className={styles.card}>
                <View className={styles.cardMain} onClick={() => addPrice(item.id)}>
                  <View className={styles.head}>
                    <Text className={item.bought ? styles.nameDone : styles.name}>{item.name}</Text>
                    {item.prices.length > 0 && cheapest ? (
                      <Text className={styles.cheapest}>最低 {cheapest}</Text>
                    ) : null}
                  </View>
                  {item.prices.length > 0 ? (
                    <View className={styles.priceRow}>
                      {item.prices.map((p, i) => (
                        <Text key={i} className={styles.priceTag}>
                          {p.platform} ￥{p.price}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  <Text className={styles.hint}>{t('shopping.hint')}</Text>
                </View>

                {/* 心理价位：可设 / 可改 / 可清除 */}
                <View className={styles.targetRow}>
                  <Text className={styles.target}>{t('shopping.targetSet')}</Text>
                  <View className={styles.targetValue} onClick={() => editTargetPrice(item)}>
                    {item.targetPrice ? `￥${item.targetPrice.toLocaleString()}` : t('shopping.targetPlaceholder')}
                  </View>
                  {item.targetPrice ? (
                    <View className={styles.targetClearBtn} onClick={() => clearTargetPrice(item)}>
                      {t('shopping.targetClear')}
                    </View>
                  ) : null}
                </View>

                <View className={styles.actions}>
                  <View className={styles.actionBtn} onClick={() => toggleBought(item.id)}>
                    {item.bought ? t('shopping.unbought') : t('shopping.bought')}
                  </View>
                  <View className={styles.removeBtn} onClick={() => removeItem(item.id)}>
                    删
                  </View>
                </View>
              </View>
            );
          })
        )}

        {/* 关联产品入口：省心买是独立产品。H5 端它挂在同源子页 /sxm/，点开在浏览器打开；
            小程序端已**原生重做**（pages/sxm/index，见阶段 B 第一期），改为页面内跳转，
            不再让用户"复制链接再自己开浏览器"。
            放在推广区块**之前**，避免把「广告」标签挤到页面中部、破坏 P-03 的"推广只在末尾"约定。 */}
        <View className={styles.partnerBlock}>
          <PartnerSectionHeader />
          <PartnerEntry
            icon='🛒'
            title={t('partner.sxmTitle')}
            desc={t('partner.sxmDesc')}
            url={SXM_ENTRY_URL}
            onTap={isH5 ? undefined : () => Taro.navigateTo({ url: SXM_NATIVE_PATH })}
            actionText={isH5 ? undefined : t('partner.sxmOpen')}
          />
        </View>

        {/* P-03：推广区块独立渲染 —— 分割线 + ≥16px 间隔 + 顶部「广告」灰底标签，不与推荐混排 */}
        {adEntries.length > 0 ? (
          <View className={styles.adSection}>
            <Text className={styles.adDividerText}>{t('library.adDivider')}</Text>
            <View className={styles.adBlock}>
              <View className={styles.adLabelRow}>
                <Text className={styles.adLabel}>{t('library.adLabel')}</Text>
              </View>
              {adEntries.map((ad) => (
                <View key={ad.id} className={styles.adCard}>
                  <Text className={styles.adTitle}>{ad.title}</Text>
                  <Text className={styles.adDesc}>{ad.desc}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <PromptModal
        visible={priceDialog !== null}
        title={priceDialog?.kind === 'add' ? `给「${priceDialog.item.name}」记价格` : t('shopping.targetSet')}
        placeholder={priceDialog?.kind === 'add' ? PRICE_INPUT_SAMPLE : t('shopping.targetPlaceholder')}
        initialValue={
          priceDialog?.kind === 'target' && priceDialog.item.targetPrice ? String(priceDialog.item.targetPrice) : ''
        }
        confirmText={t('common.save')}
        cancelText={t('cancel')}
        onConfirm={(value) => void submitPriceDialog(value)}
        onCancel={() => setPriceDialog(null)}
      />
    </View>
  );
}

export default ShoppingPage;
