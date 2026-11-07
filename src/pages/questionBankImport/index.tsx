/**
 * pages/questionBankImport —— 题库批量导入入口页（从题库列表头部进入）。
 *
 * 输入 → 确认（dryRun 预演，不写盘）→ 写入中 / 完成，三态不许合并。
 * 写入复用 `importQuestionBank` 的 batchSize / onProgress，不另写一套分批循环。
 * 失败批次显式列出，成功批次已保留不回滚；被拒与重复都按行展开
 * （row / field / code / message），不只给总数。
 */
import { useCallback, useState } from 'react';
import { View, Text, Textarea, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT, type LangKey } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import { disabledAttr } from '@/utils/buttonDisabled';
import { createQuestionBankRepo } from '@/data/questionBankRepo';
import { importQuestionBank, type ImportDuplicate, type ImportProgress, type ImportResult } from '@/data/questionBankImport';
import styles from '../questionBank/shared.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const BATCH_SIZE = 50;

type Phase = { kind: 'input' } | { kind: 'confirm'; text: string; preview: ImportResult }
  | { kind: 'importing'; progress: ImportProgress | null } | { kind: 'done'; result: ImportResult };

export default function QuestionBankImportPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [expanded, setExpanded] = useState(false);

  const backToList = useCallback(() => {
    Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/questionBank/index' }));
  }, []);

  const readFail = (err: unknown) => {
    console.warn('[QuestionBankImport] read file failed:', err);
    Taro.showToast({ title: t('qbImport.fileReadFailed'), icon: 'none' });
  };

  const applyFile = (name: string, content: string) => { setFileName(name); setText(content); };

  const pickFile = () => {
    if (isWeapp) {
      Taro.chooseMessageFile({
        count: 1, type: 'file', fail: readFail,
        success: (res) => {
          const file = res.tempFiles && res.tempFiles[0];
          if (!file) return;
          try { applyFile(file.name, String(Taro.getFileSystemManager().readFileSync(file.path, 'utf8'))); }
          catch (err) { readFail(err); }
        }
      });
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,application/json,text/csv';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (file) void file.text().then((content) => applyFile(file.name, content)).catch(readFail);
    };
    input.click();
  };

  const preview = () => {
    try {
      const result = importQuestionBank(createQuestionBankRepo(Taro), text, { dryRun: true });
      setExpanded(false);
      setPhase({ kind: 'confirm', text, preview: result });
    } catch (err) {
      console.error('[QuestionBankImport] preview failed:', err);
      Taro.showToast({ title: t('qbImport.readFailed'), icon: 'none' });
    }
  };

  const runImport = (source: string) => {
    setPhase({ kind: 'importing', progress: null });
    // 导入本身是同步的：先让「正在写入」渲染出来，再执行分批写入
    setTimeout(() => {
      try {
        const result = importQuestionBank(createQuestionBankRepo(Taro), source, {
          batchSize: BATCH_SIZE,
          onProgress: (progress) => setPhase({ kind: 'importing', progress })
        });
        setPhase({ kind: 'done', result });
      } catch (err) {
        console.error('[QuestionBankImport] write failed:', err);
        Taro.showToast({ title: t('qbImport.readFailed'), icon: 'none' });
        setPhase({ kind: 'input' });
      }
    }, 0);
  };

  const renderInput = () => (
    <View>
      <View className={styles.fileRow}>
        <Button className={styles.importPrimary} onClick={pickFile}>{t('qbImport.chooseFile')}</Button>
        {fileName ? <Text className={styles.fileName}>{fileName}</Text> : null}
      </View>
      <Textarea className={styles.importTextarea} value={text} maxlength={-1}
        placeholder={t('qbImport.placeholder')} onInput={(e) => setText(e.detail.value)} />
      <View className={styles.actions}>
        <Button className={styles.importPrimary} disabled={disabledAttr(!text.trim())} onClick={preview}>{t('qbImport.preview')}</Button>
      </View>
    </View>
  );

  const renderConfirm = (source: string, p: ImportResult) => {
    const write = p.candidates.length;
    return (
      <View className={styles.result}>
        <Text className={styles.resultGood}>{t('qbImport.confirm')}</Text>
        <Text className={styles.explanation}>{t('qbImport.confirmSummary', { n: write, m: p.duplicates.length })}</Text>
        {p.rejected.length > 0 ? <Text className={styles.explanation}>{t('qbImport.confirmRejected', { k: p.rejected.length })}</Text> : null}
        <View className={styles.actions}>
          <View className={styles.secondaryBtn} onClick={() => setPhase({ kind: 'input' })}><Text>{t('common.cancel')}</Text></View>
          <Button className={styles.importPrimary} disabled={disabledAttr(write === 0)} onClick={() => runImport(source)}>
            {t('qbImport.confirm')}
          </Button>
        </View>
      </View>
    );
  };

  const renderImporting = (progress: ImportProgress | null) => (
    <View className={styles.result}>
      <Text className={styles.resultGood}>{t('qbImport.importing')}</Text>
      {progress ? (
        <View>
          <View className={styles.progressTrack}>
            <View className={styles.progressBar} style={{ width: `${Math.round((progress.processed / Math.max(1, progress.total)) * 100)}%` }} />
          </View>
          <Text className={styles.explanation}>
            {t('qbImport.progress', {
              batch: progress.batch, processed: progress.processed, total: progress.total,
              imported: progress.imported, rejected: progress.rejected, duplicates: progress.duplicates
            })}
          </Text>
        </View>
      ) : null}
    </View>
  );

  const countItem = (label: LangKey, value: number) => (
    <View className={styles.countItem}><Text className={styles.countValue}>{value}</Text><Text className={styles.countLabel}>{t(label)}</Text></View>
  );
  const reasonLabel = (reason: ImportDuplicate['reason']) =>
    reason === 'existing' ? t('qbImport.dupReason.existing') : reason === 'within-batch' ? t('qbImport.dupReason.within-batch') : t('qbImport.dupReason.id');

  const renderDone = (result: ImportResult) => (
    <View>
      <Text className={styles.resultGood}>{t('qbImport.doneTitle')}</Text>
      <View className={styles.counts}>
        {countItem('qbImport.imported', result.imported)}
        {countItem('qbImport.rejected', result.rejected.length)}
        {countItem('qbImport.duplicates', result.duplicates.length)}
      </View>
      {result.failedBatches > 0 ? <Text className={styles.resultBad}>{t('qbImport.failedBatches', { batches: result.failedBatchIndexes.join(', ') })}</Text> : null}
      <View className={styles.detailToggle} onClick={() => setExpanded((v) => !v)}>
        <Text>{expanded ? '▲' : '▼'} {t('qbImport.details')}</Text>
      </View>
      {expanded ? (
        <View className={styles.detailList}>
          {result.rejected.length > 0 ? (
            <View>
              <Text className={styles.badge}>{t('qbImport.rejected')} · {result.rejected.length}</Text>
              {result.rejected.map((r, i) => (
                <Text key={`r${i}`} className={styles.detailRow}>{r.row} · {r.field} · {r.code} · {r.message}</Text>
              ))}
            </View>
          ) : null}
          {result.duplicates.length > 0 ? (
            <View>
              <Text className={styles.badge}>{t('qbImport.duplicates')} · {result.duplicates.length}</Text>
              {result.duplicates.map((d, i) => (
                <Text key={`d${i}`} className={styles.detailRow}>{d.row} · {reasonLabel(d.reason)} · {d.matchedId}</Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <View className={styles.actions}>
        <Button className={styles.importPrimary} onClick={backToList}>{t('qb.backToList')}</Button>
      </View>
    </View>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={backToList}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('qb.openImport')}</Text>
      </View>
      {phase.kind === 'input' ? renderInput() : null}
      {phase.kind === 'confirm' ? renderConfirm(phase.text, phase.preview) : null}
      {phase.kind === 'importing' ? renderImporting(phase.progress) : null}
      {phase.kind === 'done' ? renderDone(phase.result) : null}
    </View>
  );
}
