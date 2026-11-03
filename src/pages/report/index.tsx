import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { brandVars, useThemeStore } from '@/store/theme';
import { useT } from '@/store/language';
import { apiGetBriefing } from '@/services/api';
import { computeValueReport } from '@/utils/valueReport';
import type { LedgerEntry } from '@/types';
import { filterByRange, summarize } from '@/utils/ledgerAggregate';
import { getReadStreak } from '@/utils/readStreak';
import { readUsageSummary } from '@/utils/usageLog';
import { countBriefingOpenDays, listBriefingArchive, type BriefingArchiveEntry } from '@/utils/briefingArchive';
import styles from '../mine/index.module.scss';

/**
 * 周报与晨报存档（2026-10-31，产品评估 §7.2 A/B）。
 *
 * A 价值周报：把近 7 天「做了多少事 / 花了多少账 / 连续读了几天」汇总成一张用户自己的账
 *   （付费动机①「时间账算得清」的落地件）。口径纪律：待办/日程/关键词 = computeWeeklyReview
 *   （与晨报页本周复盘卡同源）；「有数据才显示」—— 没有的行不渲染，绝不显示 0。
 * B 晨报存档：近 7 天每日定版回看（写入点在晨报页 loadBriefing，同日覆盖）。
 *
 * 数据源全部现读本地（本页不改任何数据）；briefing 用真加载（同一 apiGetBriefing 通路）。
 */
function ReportPage() {
  const { theme } = useThemeStore();
  const t = useT();
  const [archive, setArchive] = useState<BriefingArchiveEntry[]>(() => listBriefingArchive());
  const [openIdx, setOpenIdx] = useState<number>(-1);
  const [rows, setRows] = useState<null | {
    todosDone: number;
    eventCount: number;
    keywords: string[];
    ledgerBalance: number | null;
    ledgerCount: number | null;
    readStreak: number | null;
    aiCalls7d: number | null;
    openDays: number | null;
  }>(null);

  useDidShow(() => {
    setArchive(listBriefingArchive());
    void (async () => {
      let events = [] as never[];
      let todos = [] as never[];
      try {
        const b = await apiGetBriefing();
        events = (b?.events || []) as never[];
        todos = (b?.todos || []) as never[];
      } catch (err) {
        console.warn('[ReportPage] briefing load failed:', err);
      }
      // 记账：近 7 天窗口，口径 = ledgerAggregate（分单位累加，避免浮点尾差）
      let ledger: { income: number; expense: number; count: number } | null = null;
      try {
        const entries = (Taro.getStorageSync('ledgerEntries') || []) as LedgerEntry[];
        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const to = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        const from = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
        const sum = summarize(filterByRange(entries, from, to));
        ledger = { income: sum.income, expense: sum.expense, count: sum.expenseCount };
      } catch (err) {
        console.warn('[ReportPage] ledger read failed:', err);
      }
      const r = computeValueReport({
        events,
        todos,
        ledger,
        readStreak: getReadStreak(),
        aiCalls7d: readUsageSummary().weekTotal,
        briefingOpenDays: countBriefingOpenDays(),
      });
      setRows({
        todosDone: r.todosDone,
        eventCount: r.eventCount,
        keywords: r.keywords,
        ledgerBalance: r.ledgerBalance,
        ledgerCount: r.ledgerCount,
        readStreak: r.readStreak,
        aiCalls7d: r.aiCalls7d,
        openDays: r.briefingOpenDays,
      });
    })();
  });

  const numRow = (label: string, v: number | null, suffix?: string) =>
    v === null ? null : (
      <View className={styles.row} key={label}>
        <Text className={styles.rowLabel}>{label}</Text>
        <Text className={styles.valueText}>
          {v}
          {suffix || ''}
        </Text>
      </View>
    );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {/* ===== A 价值周报 ===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('report.weekTitle')}</Text>
        {rows === null ? (
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('common.loading')}</Text>
          </View>
        ) : (
          <>
            {numRow(t('report.weekTodos'), rows.todosDone, ` ${t('report.unitItems')}`)}
            {numRow(t('report.weekEvents'), rows.eventCount, ` ${t('report.unitItems')}`)}
            {numRow(t('report.openDays'), rows.openDays, ` ${t('report.unitDays')}`)}
            {numRow(t('report.readStreak'), rows.readStreak, ` ${t('report.unitDays')}`)}
            {numRow(t('report.aiCalls'), rows.aiCalls7d, ` ${t('report.unitTimes')}`)}
            {numRow(
              rows.ledgerBalance !== null && rows.ledgerBalance < 0 ? t('report.ledgerOut') : t('report.ledgerIn'),
              rows.ledgerBalance === null ? null : Math.abs(rows.ledgerBalance)
            )}
            {rows.keywords.length > 0 ? (
              <View className={styles.row}>
                <Text className={styles.rowLabel}>{t('report.weekKeywords')}</Text>
                <Text className={styles.valueText}>{rows.keywords.join(' · ')}</Text>
              </View>
            ) : null}
          </>
        )}
      </View>

      {/* ===== B 晨报存档（近 7 天）===== */}
      <View className={styles.card}>
        <Text className={styles.cardTitle}>{t('report.archiveTitle')}</Text>
        {archive.length === 0 ? (
          <View className={styles.row}>
            <Text className={styles.rowLabel}>{t('report.archiveEmpty')}</Text>
          </View>
        ) : (
          archive.map((e, idx) => (
            <View key={e.date}>
              <View
                className={styles.row}
                onClick={() => setOpenIdx(openIdx === idx ? -1 : idx)}
              >
                <Text className={styles.rowLabel}>{e.date}</Text>
                <Text className={styles.valueText}>
                  {openIdx === idx ? '▴' : '▾'} {e.payload.greeting}
                </Text>
              </View>
              {openIdx === idx ? (
                <View className={styles.row}>
                  <Text className={styles.rowLabel}>
                    {t('report.archiveDigest', { n: e.payload.events.length, m: e.payload.todos.length })}
                  </Text>
                </View>
              ) : null}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

export default ReportPage;
