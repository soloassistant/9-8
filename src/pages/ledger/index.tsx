import { useCallback, useMemo, useState } from 'react';
import { View, Text, Input, Button, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import EmptyState from '@/components/EmptyState';
import PromptModal from '@/components/PromptModal';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT } from '@/store/language';
import {
  apiLedgerAdd,
  apiLedgerAddCategory,
  apiLedgerBudget,
  apiLedgerCategories,
  apiLedgerEntries,
  apiLedgerExport,
  apiLedgerInit,
  apiLedgerRemove,
  apiLedgerRemoveCategory,
  apiLedgerSaveBudget
} from '@/services/api';
import type { LedgerBudget, LedgerCategory, LedgerEntry, LedgerKind } from '@/types';
import {
  currentMonthStr,
  filterByRange,
  prevMonthStr,
  resolveCategory,
  summarize,
  todayStr
} from '@/utils/ledgerAggregate';
import styles from './index.module.scss';

/** 金额展示：整数部分带千分位，小数只在有值时显示（¥80 而不是 ¥80.00）。 */
function formatMoney(n: number): string {
  const v = Math.round(n * 100) / 100;
  const intPart = Math.floor(Math.abs(v));
  const frac = Math.abs(v) - intPart;
  const grouped = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = v < 0 ? '-' : '';
  return frac > 0.004 ? `${sign}¥${grouped}.${String(Math.round(frac * 100)).padStart(2, '0')}` : `${sign}¥${grouped}`;
}

/** 预算条：已用占比。超过上限时把进度截到 100%（不能让条超出容器宽度）。 */
function budgetRatio(used: number, limit?: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.max(0, Math.min(1, used / limit));
}

/**
 * 记账页。
 *
 * 设计取向：**首笔账只要两步**（金额 + 分类），备注/日期都可留空。
 * 记账功能最大的失败模式是「录入太麻烦所以没人用」，
 * 所以分类是横向 chip 一键选、预置 9 个常用项，备注收进「更多」而非必填。
 */
function LedgerPage() {
  const t = useT();
  const { theme } = useThemeStore();

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [categories, setCategories] = useState<LedgerCategory[]>([]);
  const [budget, setBudget] = useState<LedgerBudget>({});
  const [amount, setAmount] = useState('');
  const [tab, setTab] = useState<LedgerKind>('expense');
  const [pickedCategory, setPickedCategory] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  /** 预算编辑弹窗：记录正在编辑哪一档，null = 关闭 */
  const [budgetEdit, setBudgetEdit] = useState<'daily' | 'monthly' | null>(null);

  const reload = useCallback(async () => {
    apiLedgerInit();
    const [e, c, b] = await Promise.all([apiLedgerEntries(), apiLedgerCategories(), apiLedgerBudget()]);
    setEntries(e);
    setCategories(c);
    setBudget(b);
  }, []);

  useDidShow(() => {
    void reload();
  });

  const today = todayStr();
  const month = currentMonthStr();
  /** 正在编辑那一档的当前上限（用于回填与是否展示「清除上限」） */
  const budgetEditValue = budgetEdit ? budget[budgetEdit] : undefined;

  const monthList = useMemo(() => filterByRange(entries, `${month}-01`, `${month}-31`), [entries, month]);
  const monthSum = useMemo(() => summarize(monthList, budget), [monthList, budget]);
  const todaySum = useMemo(() => summarize(filterByRange(entries, today, today), budget), [entries, today, budget]);
  const prevSum = useMemo(() => {
    const pm = prevMonthStr();
    return summarize(filterByRange(entries, `${pm}-01`, `${pm}-31`), {});
  }, [entries]);

  const tabCategories = useMemo(
    () => categories.filter((c) => c.kind === tab),
    [categories, tab]
  );

  // 切换支出/收入时把选中分类重置：两类分类 id 不同，
  // 保留旧选择会让 addEntry 因「分类方向不匹配」静默失败（data/ledger.ts 有此校验）。
  const switchTab = useCallback(
    (next: LedgerKind) => {
      setTab(next);
      setPickedCategory('');
    },
    []
  );

  const submit = useCallback(async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      Taro.showToast({ title: t('ledger.invalidAmount'), icon: 'none' });
      return;
    }
    if (!pickedCategory) {
      Taro.showToast({ title: t('ledger.pickCategory'), icon: 'none' });
      return;
    }
    const created = await apiLedgerAdd({ amount: n, kind: tab, categoryId: pickedCategory });
    if (!created) {
      Taro.showToast({ title: t('ledger.addFailed'), icon: 'none' });
      return;
    }
    setAmount('');
    await reload();
    // 超预算即时提示：晨报卡片是「事后呈报」，这里给「当场反馈」，
    // 避免用户记完超支了却要等到第二天才知道。
    const after = await summarize(filterByRange(await apiLedgerEntries(), today, today), await apiLedgerBudget());
    if (after.overDaily) {
      Taro.showToast({ title: t('ledger.overDailyNow'), icon: 'none', duration: 2200 });
    } else {
      Taro.showToast({ title: t('ledger.added'), icon: 'success' });
    }
  }, [amount, pickedCategory, tab, today, reload, t]);

  const remove = useCallback(
    (id: string) => {
      // 删除真实财务记录必须有二次确认 + 结果反馈（2026-10-24 审计）：
      // 原先点一下即硬删除、无确认无提示无撤销，误触一行就丢一条账目。
      // 与购物清单删除（pages/shopping 的 showModal 确认）保持同一口径；
      // 失败也必须 toast —— 铁律「不静默失败」。
      Taro.showModal({
        title: t('ledger.deleteTitle'),
        content: t('ledger.deleteConfirm'),
        confirmColor: '#ee5a29',
        success: async (res) => {
          if (!res.confirm) return;
          const ok = await apiLedgerRemove(id);
          if (ok) {
            await reload();
            Taro.showToast({ title: t('ledger.deleted'), icon: 'success' });
          } else {
            Taro.showToast({ title: t('common.saveFailed'), icon: 'none' });
          }
        }
      });
    },
    [reload, t]
  );

  /**
   * 保存预算。
   *
   * 注意：空输入**不再**表示「取消上限」。
   * 旧实现依赖 Taro.showModal 的 editable，但 H5 端那个 API 不读取 editable、
   * 也不返回 content —— 拿到的一直是空串，于是「点开预算 → 确定」就静默删掉了上限。
   * 现在「清除上限」是弹窗里的独立次要操作，空输入一律按非法输入提示，不改数据。
   */
  const saveBudget = useCallback(
    async (raw: string) => {
      if (!budgetEdit) return;
      const value = raw.trim();
      if (!value) {
        Taro.showToast({ title: t('ledger.invalidAmount'), icon: 'none' });
        return;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        Taro.showToast({ title: t('ledger.invalidAmount'), icon: 'none' });
        return;
      }
      setBudget(await apiLedgerSaveBudget({ ...budget, [budgetEdit]: n }));
      setBudgetEdit(null);
    },
    [budgetEdit, budget, t]
  );

  /** 清除某一档上限：只删这一个 key，另一档保持不变 */
  const clearBudget = useCallback(async () => {
    if (!budgetEdit) return;
    const next: LedgerBudget = { ...budget };
    delete next[budgetEdit];
    setBudget(await apiLedgerSaveBudget(next));
    setBudgetEdit(null);
  }, [budgetEdit, budget]);

  const addCat = useCallback(async () => {
    const name = newCatName.trim();
    if (!name) return;
    const created = await apiLedgerAddCategory(name, tab);
    if (!created) {
      Taro.showToast({ title: t('ledger.catDuplicate'), icon: 'none' });
      return;
    }
    setNewCatName('');
    const c = await apiLedgerCategories();
    setCategories(c);
    setPickedCategory(created.id);
  }, [newCatName, tab, t]);

  const delCat = useCallback(
    async (id: string) => {
      const ok = await apiLedgerRemoveCategory(id);
      if (!ok) {
        Taro.showToast({ title: t('ledger.catInUse'), icon: 'none', duration: 2000 });
        return;
      }
      setCategories(await apiLedgerCategories());
    },
    [t]
  );

  // 导出：ActionSheet 选 CSV / JSON → apiLedgerExport → 四态各自 toast。
  // busy 守卫防连点（导出中再点会叠出第二个 ActionSheet/第二次下载）。
  const exportData = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      let format: 'csv' | 'json';
      try {
        const res = await Taro.showActionSheet({ itemList: [t('ledger.exportCsv'), t('ledger.exportJson')] });
        // index 0=CSV / 1=JSON；越界值按取消处理（不导出）
        if (res.tapIndex !== 0 && res.tapIndex !== 1) return;
        format = res.tapIndex === 0 ? 'csv' : 'json';
      } catch (err) {
        // 用户取消（errMsg 含 cancel）不做事；ActionSheet 打开失败本身留痕
        const msg = (err as { errMsg?: string })?.errMsg || '';
        if (!msg.includes('cancel')) console.warn('[LedgerPage] showActionSheet failed:', err);
        return;
      }
      const result = await apiLedgerExport(format);
      if (result === 'ok') {
        Taro.showToast({
          title: t(format === 'csv' ? 'ledger.exportCsvOk' : 'ledger.exportJsonOk'),
          icon: 'success'
        });
      } else if (result === 'copied') {
        // 小程序端降级剪贴板：如实告知用户，不假装下载成功
        Taro.showToast({ title: t('ledger.exportCopied'), icon: 'none', duration: 3000 });
      } else if (result === 'empty') {
        Taro.showToast({ title: t('ledger.exportEmpty'), icon: 'none' });
      } else {
        Taro.showToast({ title: t('ledger.exportFailed'), icon: 'none' });
      }
    } finally {
      setExportBusy(false);
    }
  }, [exportBusy, t]);

  // 明细按日分组展示；月内已有数据则不再显示全部（避免长列表淹没概览）
  const grouped = useMemo(() => {
    const map = new Map<string, LedgerEntry[]>();
    monthList.forEach((e) => {
      const arr = map.get(e.date) || [];
      arr.push(e);
      map.set(e.date, arr);
    });
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [monthList]);

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

  /* ---------------- 桌面右栏（p56/p57 的三栏版式） ----------------
     只做汇总类信息，不改原有手机版式的任何交互：手机上 .rail 是 display:none。
     数据全部来自本月账目，不新增任何统计口径。 */
  const railCats = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const e of monthList) {
      if (e.kind !== 'expense') continue;
      byCat.set(e.categoryId, (byCat.get(e.categoryId) || 0) + e.amount);
    }
    const total = [...byCat.values()].reduce((a, b) => a + b, 0);
    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 3).map(([id, amount]) => ({
      id,
      name: resolveCategory(categories, id).name,
      icon: resolveCategory(categories, id).icon,
      amount,
      share: total > 0 ? Math.round((amount / total) * 100) : 0
    }));
    // 只列前 3 名时，占比加起来必然不足 100%（第 4 名起没地方去）。
    // 补一行「其他」把剩下的钱和百分点收口 —— 否则用户看到 96% 会以为数字算错了。
    if (sorted.length > 3) {
      const restAmount = sorted.slice(3).reduce((sum, [, v]) => sum + v, 0);
      const shownShare = top.reduce((sum, c) => sum + c.share, 0);
      top.push({
        id: '__rest',
        name: t('ledger.railOther'),
        icon: '·',
        amount: restAmount,
        share: Math.max(0, 100 - shownShare)
      });
    }
    return top;
  }, [monthList, categories, t]);

  const railRecent = useMemo(
    () => [...monthList].sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0)).slice(0, 4),
    [monthList]
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.backButton} onClick={handleBack}>
        <Text className={styles.backIcon}>‹</Text>
        <Text className={styles.backText}>{t('common.back')}</Text>
      </View>
      <View className={styles.head}>
        <View className={styles.monthRow}>
          <Text className={styles.monthLabel}>
            {month} · {t('ledger.monthExpense')}
          </Text>
          <View>
            <Text className={styles.monthAmount}>{formatMoney(monthSum.expense)}</Text>
            {monthSum.income > 0 ? (
              <Text className={styles.incomeLabel}>　{t('ledger.income')} {formatMoney(monthSum.income)}</Text>
            ) : null}
          </View>
        </View>
        <Text className={styles.monthLabel}>
          {t('ledger.lastMonth')} {formatMoney(prevSum.expense)}
        </Text>

        <View className={styles.budgetRow}>
          <View
            className={budget.daily !== undefined && todaySum.overDaily ? `${styles.budgetChip} ${styles.budgetChipOver}` : styles.budgetChip}
            onClick={() => setBudgetEdit('daily')}
          >
            <Text className={styles.budgetCap}>{t('ledger.dailyBudget')}</Text>
            <Text className={styles.budgetVal}>
              {formatMoney(todaySum.expense)}
              {budget.daily !== undefined ? ` / ${formatMoney(budget.daily)}` : ''}
            </Text>
            {budget.daily !== undefined ? (
              <View className={styles.bar}>
                <View
                  className={todaySum.overDaily ? `${styles.barFill} ${styles.barFillOver}` : styles.barFill}
                  style={{ width: `${budgetRatio(todaySum.expense, budget.daily) * 100}%` }}
                />
              </View>
            ) : null}
          </View>

          <View
            className={budget.monthly !== undefined && monthSum.overMonthly ? `${styles.budgetChip} ${styles.budgetChipOver}` : styles.budgetChip}
            onClick={() => setBudgetEdit('monthly')}
          >
            <Text className={styles.budgetCap}>{t('ledger.monthlyBudget')}</Text>
            <Text className={styles.budgetVal}>
              {formatMoney(monthSum.expense)}
              {budget.monthly !== undefined ? ` / ${formatMoney(budget.monthly)}` : ''}
            </Text>
            {budget.monthly !== undefined ? (
              <View className={styles.bar}>
                <View
                  className={monthSum.overMonthly ? `${styles.barFill} ${styles.barFillOver}` : styles.barFill}
                  style={{ width: `${budgetRatio(monthSum.expense, budget.monthly) * 100}%` }}
                />
              </View>
            ) : null}
          </View>
        </View>

        {todaySum.overDaily || monthSum.overMonthly ? (
          <View className={styles.overHint}>
            <Text>⚠️</Text>
            <Text>
              {todaySum.overDaily && budget.daily !== undefined
                ? t('ledger.overDaily', { amount: formatMoney(budget.daily) })
                : t('ledger.overMonthly', { amount: formatMoney(budget.monthly ?? 0) })}
            </Text>
          </View>
        ) : null}
      </View>

      {monthSum.byCategory.length > 0 ? (
        <View className={styles.catBlock}>
          <View className={styles.catTitleRow}>
            <Text className={styles.catTitle}>{t('ledger.monthByCategory')}</Text>
            {/* 导出入口：照 briefing habitAdd 的 Text 文字按钮范式 ——
                flex 行里用 Button 会被 taro-button-core 默认 width:100% 挤爆布局
                （见本文件 SCSS 的 .addBtn:233-244 注释），故用 Text + onClick */}
            <Text
              className={styles.catExport}
              style={exportBusy ? { opacity: 0.5 } : undefined}
              onClick={() => void exportData()}
            >
              {t('ledger.export')}
            </Text>
          </View>
          {monthSum.byCategory.slice(0, 5).map((c) => {
            const cat = resolveCategory(categories, c.categoryId);
            return (
              <View key={c.categoryId} className={styles.catItem}>
                <Text className={styles.catIcon}>{cat.icon}</Text>
                <Text className={styles.catName}>{cat.name}</Text>
                <Text className={styles.catCount}>×{c.count}</Text>
                <Text className={styles.catAmount}>{formatMoney(c.amount)}</Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {grouped.length === 0 ? (
        <EmptyState icon='🧾' title={t('ledger.empty')} hint={t('ledger.emptyHint')} />
      ) : (
        <View className={styles.list}>
          {grouped.map(([date, list]) => (
            <View key={date}>
              <View className={styles.dayHeader}>
                {date === today ? t('ledger.today') : date}
              </View>
              {list.map((e) => {
                const cat = resolveCategory(categories, e.categoryId);
                return (
                  <View key={e.id} className={styles.row} onClick={() => remove(e.id)}>
                    <Text className={styles.rowIcon}>{cat.icon}</Text>
                    <View className={styles.rowMain}>
                      <Text className={styles.rowTitle}>{cat.name}</Text>
                      {e.note ? <Text className={styles.rowNote}>{e.note}</Text> : null}
                    </View>
                    <Text className={e.kind === 'income' ? `${styles.rowAmount} ${styles.rowAmountIncome}` : styles.rowAmount}>
                      {e.kind === 'income' ? '+' : '-'}
                      {formatMoney(e.amount)}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      )}

      {/* 录入区：金额输入 + 分类选择 + 记账 */}
      <View className={styles.addBar}>
        <Input
          className={styles.addInput}
          type='digit'
          value={amount}
          placeholder={t('ledger.amountPlaceholder')}
          focus={false}
          onInput={(e) => setAmount(e.detail.value)}
        />
        <Button className={styles.addBtn} onClick={() => setSheetOpen(true)}>
          {pickedCategory ? resolveCategory(categories, pickedCategory).name : t('ledger.pickCategory')}
        </Button>
        <Button className={styles.addBtn} onClick={() => void submit()}>
          {t('ledger.record')}
        </Button>
      </View>

      {sheetOpen ? (
        <View className={styles.mask} onClick={() => setSheetOpen(false)}>
          <View className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.sheetTitle}>{t('ledger.pickCategory')}</Text>
            <View className={styles.tabs}>
              <Button
                className={tab === 'expense' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                onClick={() => switchTab('expense')}
              >
                {t('ledger.kindExpense')}
              </Button>
              <Button
                className={tab === 'income' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                onClick={() => switchTab('income')}
              >
                {t('ledger.kindIncome')}
              </Button>
            </View>

            <ScrollView className={styles.catGrid} scrollY>
              {tabCategories.map((c) => (
                <Button
                  key={c.id}
                  className={pickedCategory === c.id ? `${styles.catChip} ${styles.catChipActive}` : styles.catChip}
                  onClick={() => setPickedCategory(c.id)}
                >
                  {c.icon} {c.name}
                </Button>
              ))}
            </ScrollView>

            <View className={styles.catManage}>
              <Text className={styles.budgetCap} onClick={() => setManageOpen(!manageOpen)}>
                {t('ledger.manageCategories')}
              </Text>
              {manageOpen ? (
                <View>
                  {tabCategories.map((c) => (
                    <View key={c.id} className={styles.manageRow}>
                      <Text className={styles.manageName}>
                        {c.icon} {c.name}
                      </Text>
                      <Text className={styles.delBtn} onClick={() => void delCat(c.id)}>
                        {t('ledger.delete')}
                      </Text>
                    </View>
                  ))}
                  <View className={styles.addCatRow}>
                    <Input
                      className={styles.addCatInput}
                      value={newCatName}
                      placeholder={t('ledger.newCatPlaceholder')}
                      onInput={(e) => setNewCatName(e.detail.value)}
                    />
                    <Button className={styles.smallBtn} onClick={() => void addCat()}>
                      {t('ledger.addCat')}
                    </Button>
                  </View>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

      {/* 桌面右栏：≥1200px 才显示（样式里控制），手机上完全不占位 */}
      <View className={styles.rail}>
        <View className={styles.railCard}>
          <Text className={styles.railTitle}>{t('ledger.railCats')}</Text>
          {railCats.length === 0 ? (
            <Text className={styles.railEmpty}>{t('ledger.railEmpty')}</Text>
          ) : (
            railCats.map((c) => (
              <View key={c.id} className={styles.railRow}>
                <Text className={styles.railRowName}>
                  {c.icon} {c.name}
                </Text>
                <Text className={styles.railRowVal}>{formatMoney(c.amount)}</Text>
                <Text className={styles.railRowPct}>{c.share}%</Text>
              </View>
            ))
          )}
        </View>

        <View className={styles.railCard}>
          <Text className={styles.railTitle}>{t('ledger.railRecent')}</Text>
          {railRecent.length === 0 ? (
            <Text className={styles.railEmpty}>{t('ledger.railEmpty')}</Text>
          ) : (
            railRecent.map((e) => (
              <View key={e.id} className={styles.railRow}>
                <Text className={styles.railRowName}>
                  {resolveCategory(categories, e.categoryId).icon}{' '}
                  {e.note || resolveCategory(categories, e.categoryId).name}
                </Text>
                <Text className={e.kind === 'income' ? styles.railRowIncome : styles.railRowVal}>
                  {e.kind === 'income' ? '+' : '-'}
                  {formatMoney(e.amount)}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>

      <PromptModal
        visible={budgetEdit !== null}
        title={budgetEdit === 'daily' ? t('ledger.budgetDailyTitle') : t('ledger.budgetMonthlyTitle')}
        placeholder={t('ledger.budgetPlaceholder')}
        // 回填当前上限：用户想微调时不必重新输一遍
        initialValue={budgetEditValue !== undefined ? String(budgetEditValue) : ''}
        confirmText={t('ledger.saveBudget')}
        cancelText={t('cancel')}
        // 只有已设过上限才提供「清除」，避免对一个本就不存在的值做无意义操作
        secondaryText={budgetEditValue !== undefined ? t('ledger.clearBudget') : undefined}
        onSecondary={() => void clearBudget()}
        onConfirm={(value) => void saveBudget(value)}
        onCancel={() => setBudgetEdit(null)}
      />
    </View>
  );
}

export default LedgerPage;