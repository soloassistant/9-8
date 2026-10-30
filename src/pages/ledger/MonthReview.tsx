import { useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { cloudLlmChat, safeParseReply } from '@/services/cloudLlm';
import { bumpLocalUsage, canChat, getAiQuota } from '@/services/aiQuota';
import { recordUsage } from '@/utils/usageLog';
import { currentMonthStr, monthEntries, summarize } from '@/utils/ledgerAggregate';
import type { LedgerEntry } from '@/types';

/**
 * AI 月度消费点评（2026-10-31，产品评估 §7.2 D）—— 记账模块的付费化最小可行版。
 *
 * 诚实边界（三条，与全仓口径一致）：
 *   · 只把**真实记账汇总**发给模型（金额/笔数/分类 Top5），模型不编数字，prompt 里明令禁止；
 *   · 额度与计数走 chat 同一套闸（canChat → 成功后 bumpLocalUsage + recordUsage('chat')），
 *     「点评消耗一次对话额度」与 AiAssistant 同口径；
 *   · 失败如实提示，不降级成假点评。
 * 合规：结尾固定带「不构成投资建议」措辞（与行情解读同款纪律）。
 */
export default function MonthReview({ entries }: { entries: LedgerEntry[] }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');

  const handleRun = async () => {
    if (busy) return;
    if (!canChat(await getAiQuota())) {
      Taro.showToast({ title: t('ledger.reviewQuota'), icon: 'none' });
      return;
    }
    setBusy(true);
    try {
      const sum = summarize(monthEntries(entries));
      if (sum.expenseCount === 0 && sum.income === 0) {
        Taro.showToast({ title: t('ledger.reviewEmpty'), icon: 'none' });
        return;
      }
      const facts = JSON.stringify({
        month: currentMonthStr(),
        expense: sum.expense,
        income: sum.income,
        expenseCount: sum.expenseCount,
        topCategories: sum.byCategory.slice(0, 5),
      });
      const raw = await cloudLlmChat({
        system:
          '你是记账助理。基于用户给的本月记账汇总做点评：钱主要花在哪、消费结构有什么值得留意的、给一条具体可行的下月建议。' +
          '只用给定数字，绝不编造数字。中文，简洁友好，不超过 160 字，纯文本输出。' +
          '结尾必须原样带上一句「以上为消费观察，不构成投资建议」。',
        userContent: facts,
      });
      if (!raw) {
        Taro.showToast({ title: t('ledger.reviewFailed'), icon: 'none' });
        return;
      }
      const parsed = safeParseReply<{ reply?: string }>(raw);
      setText((parsed && parsed.reply) || raw);
      bumpLocalUsage();
      recordUsage('chat');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        margin: '8px 0 0',
        padding: '10px 12px',
        background: 'var(--card-bg, #fff)',
        border: '1px solid var(--card-border, rgba(0,0,0,0.06))',
        borderRadius: '10px',
      }}
    >
      <Button
        style={{
          fontSize: '13px',
          lineHeight: '1.6',
          padding: '4px 12px',
          margin: 0,
          background: 'transparent',
          border: 'none',
          color: 'inherit',
        }}
        loading={busy}
        disabled={busy}
        onClick={() => void handleRun()}
      >
        {busy ? t('ledger.reviewBusy') : t('ledger.reviewBtn')}
      </Button>
      {text ? (
        <Text style={{ display: 'block', fontSize: '13px', lineHeight: 1.7, marginTop: '6px', whiteSpace: 'pre-wrap' }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}
