import { useEffect, useRef, useState } from 'react';
import { View, Text, Textarea, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import EmptyState from '@/components/EmptyState';
import { apiExtract, apiConfirmItem, apiGetBriefing, apiChat, type WorkAction } from '@/services/api';
import { useUserStore } from '@/store/user';
import { fromNow } from '@/utils/date';
import { detectConflicts, buildPlanProposal, type ConflictInfo, type PlanProposal, type PlanProposalRaw, type PlanApplyEvent } from '@/utils/schedule';
import PlanProposalCard from '@/components/PlanProposalCard';
import type { Briefing, ExtractResult } from '@/types';
import { useT } from '@/store/language';
import styles from './index.module.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const isH5 = process.env.TARO_ENV === 'h5';
/** 最多同时提取的截图张数 */
const MAX_IMAGES = 3;

/** 待确认条目（提取结果 + 本地编辑状态） */
interface DraftItem {
  key: string;
  kind: 'event' | 'todo' | 'collection';
  title: string;
  time?: string;
  summary?: string;
  tags?: string[];
  checked: boolean;
  origin: ExtractResult['events'][number] | ExtractResult['todos'][number];
}

interface HistoryRecord {
  id: string;
  text: string;
  count: number;
  time: string;
}

let draftKey = 0;

/** H5：File/Blob 转 dataURL（预览用，提交时去掉前缀取 base64） */
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function InboxPage() {
  const t = useT();
  const [content, setContent] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [note, setNote] = useState<string>('');
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  /** 冲突升级出的排班方案（S-01~S-03）：非空时用方案卡片替代旧冲突条 */
  const [conflictPlan, setConflictPlan] = useState<PlanProposal | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [mode, setMode] = useState<'extract' | 'work'>('extract');
  const [workAction, setWorkAction] = useState('summary');
  const [workBusy, setWorkBusy] = useState(false);
  const [workResult, setWorkResult] = useState('');
  const { refreshUsage } = useUserStore();

  useEffect(() => {
    // 现有日程用于「排班冲突检测」
    apiGetBriefing()
      .then(setBriefing)
      .catch((err) => console.warn('[InboxPage] load briefing for conflict check failed:', err));
  }, []);

  // 上限判定需要读「当前」张数，但粘贴监听器是 [] 依赖、闭包里的 images 永远是初始的 []，
  // 所以另备一个 ref：用来算剩余名额（避免解码用不上的 base64）并在合并时兜底。
  const imagesRef = useRef<string[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  /**
   * 一批图片文件 → dataURL → 并入已选列表。返回本次实际加入的张数。
   *
   * 上限必须在**合并那一刻**判断。原来的写法把判断放在 setImages 的 updater 里读 prev.length，
   * 但真正的 append 发生在 fileToDataURL(...).then() 回调里 —— 同一事件里 N 个 updater
   * 看到的都是 append 之前的数组，于是 MAX_IMAGES 形同虚设：一次粘贴/多选多张会把
   * 全部 base64 送进 apiExtract，白烧 token 且大概率被服务端截断。
   */
  const addImageFiles = async (files: File[]): Promise<number> => {
    const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    if (!files.length || room === 0) return 0;
    const take = files.slice(0, room);
    let urls: string[] = [];
    try {
      urls = await Promise.all(take.map((f) => fileToDataURL(f)));
    } catch (err) {
      console.warn('[InboxPage] fileToDataURL failed:', err);
      return 0;
    }
    const fresh = urls.filter((u) => u && !imagesRef.current.includes(u));
    if (!fresh.length) return 0;
    setImages((list) => {
      const merged = list.slice();
      for (const u of fresh) {
        if (merged.length >= MAX_IMAGES) break;
        if (!merged.includes(u)) merged.push(u);
      }
      return merged.length === list.length ? list : merged;
    });
    return fresh.length;
  };

  // H5：支持 Ctrl+V 直接粘贴截屏图片
  useEffect(() => {
    if (isWeapp) return undefined;
    const onPaste = (e: ClipboardEvent) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files: File[] = [];
      Array.from(items).forEach((item) => {
        if (!item.type.startsWith('image/')) return;
        const file = item.getAsFile();
        if (!file) return;
        e.preventDefault();
        files.push(file);
      });
      if (!files.length) return;
      if (imagesRef.current.length >= MAX_IMAGES) {
        Taro.showToast({ title: `最多 ${MAX_IMAGES} 张截图`, icon: 'none' });
        return;
      }
      void addImageFiles(files).then((added) => {
        if (added > 0) Taro.showToast({ title: `已添加 ${added} 张截图`, icon: 'success', duration: 1000 });
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  /** 添加截图：微信端从相册/拍照选取，H5 弹文件选择 */
  const handleAddImage = () => {
    if (images.length >= MAX_IMAGES) {
      Taro.showToast({ title: `最多 ${MAX_IMAGES} 张截图`, icon: 'none' });
      return;
    }
    if (isWeapp) {
      Taro.chooseMedia({
        count: MAX_IMAGES - images.length,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const paths = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
          if (paths.length === 0) return;
          setImages((prev) => [...prev, ...paths].slice(0, MAX_IMAGES));
          Taro.showToast({ title: '已添加截图', icon: 'success', duration: 1000 });
        },
        fail: (err) => console.info('[InboxPage] chooseMedia cancelled:', err && err.errMsg)
      });
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        void addImageFiles(files).then((added) => {
          if (added > 0) Taro.showToast({ title: `已添加 ${added} 张截图`, icon: 'success', duration: 1000 });
          else if (files.length > 0) Taro.showToast({ title: `最多 ${MAX_IMAGES} 张截图`, icon: 'none' });
        });
      };
      input.click();
    }
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  /** 把展示用的图片（tempFilePath / dataURL）转成提交用的 base64 */
  const imagesToBase64 = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const src of images) {
      if (isWeapp) {
        try {
          // readFile 异步版在 Taro 类型里返回 void，改用同步版（返回 string | ArrayBuffer）
          const data = Taro.getFileSystemManager().readFileSync(src, 'base64');
          out.push(String(data));
        } catch (err) {
          console.warn('[InboxPage] read image failed:', err);
        }
      } else {
        const b64 = String(src).split(',')[1] || '';
        if (b64.length > 100) out.push(b64);
      }
    }
    return out;
  };

  const handleExtract = async () => {
    const text = content.trim();
    if (!text && images.length === 0) {
      Taro.showToast({ title: isH5 ? '粘贴文字，或 Ctrl+V 粘贴截屏' : '先粘贴内容或添加截图', icon: 'none' });
      return;
    }
    if (extracting) return;
    setExtracting(true);
    try {
      const imagePayload = images.length > 0 ? await imagesToBase64() : [];
      const result = await apiExtract({ content: text, images: imagePayload });
      console.info('[InboxPage] extract result:', JSON.stringify(result));
      const next: DraftItem[] = [];
      result.events.forEach((evt) => {
        draftKey += 1;
        next.push({
          key: `d${draftKey}`,
          kind: 'event',
          title: evt.title,
          time: evt.startTime,
          checked: true,
          origin: evt
        });
      });
      result.todos.forEach((todo) => {
        draftKey += 1;
        next.push({
          key: `d${draftKey}`,
          kind: 'todo',
          title: todo.title,
          time: todo.dueDate,
          checked: true,
          origin: todo
        });
      });
      if (result.collection) {
        draftKey += 1;
        next.push({
          key: `d${draftKey}`,
          kind: 'collection',
          title: result.collection.title,
          summary: result.collection.summary,
          tags: result.collection.tags,
          checked: true,
          origin: result.collection
        });
      }
      setDrafts(next);
      setNote(result.note || '');
      // 排班冲突检测：提取出的日程 vs 现有日程
      setConflicts(
        detectConflicts(
          next
            .filter((d) => d.kind === 'event' && d.time)
            .map((d) => ({
              key: d.key,
              title: d.title,
              startTime: d.time as string,
              endTime: (d.origin as ExtractResult['events'][number]).endTime
            })),
          briefing?.events || []
        )
      );
      if (next.length === 0) {
        Taro.showToast({ title: '没有提取到日程或待办', icon: 'none' });
      }
    } catch (err) {
      console.error('[InboxPage] extract failed:', err);
      Taro.showToast({ title: '提取失败，请稍后再试', icon: 'none' });
    } finally {
      setExtracting(false);
    }
  };

  const handleWorkRun = async (action: WorkAction) => {
    const text = content.trim();
    if (!text) {
      Taro.showToast({ title: images.length > 0 ? '工作助手暂只支持文字，请粘贴文字内容' : '先粘贴要分析的内容', icon: 'none' });
      return;
    }
    if (workBusy) return;
    setWorkAction(action);
    setWorkBusy(true);
    try {
      const res = await apiChat(text, 'text', false, { action });
      setWorkResult(res.reply || '没有生成结果，请重试。');
    } catch (err) {
      console.error('[InboxPage] work assistant failed:', err);
      Taro.showToast({ title: '分析失败，请稍后再试', icon: 'none' });
    } finally {
      setWorkBusy(false);
    }
  };

  const copyWorkResult = () => {
    if (!workResult) return;
    Taro.setClipboardData({ data: workResult });
  };

  const switchMode = (next: 'extract' | 'work') => {
    setMode(next);
    setWorkResult('');
  };

  const toggleDraft = (key: string) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, checked: !d.checked } : d)));
  };

  const editDraftTitle = (key: string, title: string) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, title } : d)));
  };

  const editDraftTime = (key: string, time: string) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, time } : d)));
  };

  /** 采用 AI 建议时段，并移除对应冲突提示 */
  const applySuggestion = (draftKey: string, time: string) => {
    editDraftTime(draftKey, time);
    setConflicts((prev) => prev.filter((c) => c.draftKey !== draftKey));
    Taro.showToast({ title: `已改到 ${dayjs(time).format('HH:mm')}`, icon: 'none' });
  };

  /** 冲突 → 排班方案卡片（S-01~S-03）：由冲突条目构建提案，用户点选候选时段 */
  const buildConflictProposal = (list: ConflictInfo[]): PlanProposal | null => {
    if (list.length === 0) return null;
    // 按 draftKey 去重（同一草稿可能与多个日程冲突），保留首条冲突
    const seen = new Set<string>();
    const raw: PlanProposalRaw[] = [];
    list.forEach((c) => {
      if (seen.has(c.draftKey)) return;
      seen.add(c.draftKey);
      const draft = drafts.find((d) => d.key === c.draftKey);
      raw.push({
        title: c.title,
        toTime: c.startTime,
        endTime: draft ? (draft.origin as ExtractResult['events'][number]).endTime : c.endTime
      });
    });
    return raw.length > 0 ? buildPlanProposal(raw, briefing?.events || []) : null;
  };

  /** 批准方案：把选中的新时段写回对应草稿时间，然后由既有「确认入库」链路落库 */
  const handleApproveConflictPlan = (events: PlanApplyEvent[], proposal: PlanProposal) => {
    // 方案条目与冲突条目按标题 + 顺序对应，回写草稿时间
    const byTitle = new Map<string, string>();
    proposal.items.forEach((item) => {
      if (item.checked && item.toTime) byTitle.set(item.title, item.toTime);
    });
    setDrafts((prev) =>
      prev.map((d) => (byTitle.has(d.title) ? { ...d, time: byTitle.get(d.title) as string } : d))
    );
    setConflicts([]);
    setConflictPlan(null);
    Taro.showToast({ title: t('plan.savedToast', { n: events.length }), icon: 'none' });
  };

  const handleConfirm = async () => {
    const checked = drafts.filter((d) => d.checked);
    if (checked.length === 0) {
      Taro.showToast({ title: '请至少勾选一条', icon: 'none' });
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const events = checked
        .filter((d) => d.kind === 'event')
        .map((d) => {
          const origin = d.origin as ExtractResult['events'][number];
          return { ...origin, title: d.title, startTime: d.time || origin.startTime };
        });
      const todos = checked
        .filter((d) => d.kind === 'todo')
        .map((d) => {
          const origin = d.origin as ExtractResult['todos'][number];
          return { ...origin, title: d.title, dueDate: d.time || origin.dueDate };
        });
      const collection = checked.find((d) => d.kind === 'collection')?.origin as
        | ExtractResult['collection']
        | undefined;
      const res = await apiConfirmItem({ events, todos, collection });
      console.info('[InboxPage] confirmed:', res.saved);
      Taro.showToast({ title: `已入库 ${res.saved} 条`, icon: 'success' });
      const sourceLabel = images.length > 0 ? `🖼 截图×${images.length}${content.trim() ? ' + 文字' : ''}` : content.trim();
      setHistory((prev) => [
        {
          id: `h-${Date.now()}`,
          text: sourceLabel.slice(0, 40),
          count: res.saved,
          time: dayjs().toISOString()
        },
        ...prev
      ]);
      setDrafts([]);
      setConflicts([]);
      setConflictPlan(null);
      setNote('');
      setContent('');
      setImages([]);
      refreshUsage();
    } catch (err) {
      console.error('[InboxPage] confirm failed:', err);
      Taro.showToast({ title: '入库失败，请重试', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

  const kindLabel: Record<DraftItem['kind'], string> = {
    event: '日程',
    todo: '待办',
    collection: '收藏'
  };

  return (
    <View className={styles.page}>
      <View className={styles.howTo}>
        <Text className={styles.howIcon}>💡</Text>
        <Text className={styles.howText}>
          {isH5
            ? '粘贴微信里复制的内容，或直接 Ctrl+V 粘贴截屏图片；微信端点「添加截图」从相册选取。'
            : '把截屏图从相册添加进来，或在微信里复制文字粘贴，AI 自动提取日程和待办。'}
        </Text>
      </View>

      <View className={styles.inputCard}>
        <Text className={styles.inputTitle}>{t('inbox.pasteTitle')}</Text>
        {/* 模式切换：提取入库 / 工作助手分析 */}
        <View className={styles.modeTabs}>
          <View
            className={classnames(styles.modeTab, mode === 'extract' && styles.modeTabActive)}
            onClick={() => switchMode('extract')}
          >
            <Text className={styles.modeTabText}>{t('inbox.tabExtract')}</Text>
          </View>
          <View
            className={classnames(styles.modeTab, mode === 'work' && styles.modeTabActive)}
            onClick={() => switchMode('work')}
          >
            <Text className={styles.modeTabText}>{t('inbox.tabWork')}</Text>
          </View>
        </View>
        <Textarea
          className={styles.textarea}
          value={content}
          maxlength={2000}
          placeholder={
            mode === 'extract'
              ? '例：明天上午 10 点在 3 号会议室开产品评审会，会前把演示文稿更新一下'
              : '粘贴报告 / 会议记录 / 邮件 / 方案，AI 帮你总结、提炼要点、给建议'
          }
          onInput={(e) => setContent(e.detail.value)}
        />
        {mode === 'extract' ? (
          <>
            {images.length > 0 ? (
              <View className={styles.imageRow}>
                {images.map((src, idx) => (
                  <View key={src.slice(-24) + idx} className={styles.imageThumb}>
                    <Image className={styles.imagePic} src={src} mode='aspectFill' />
                    <View className={styles.imageRemove} onClick={() => removeImage(idx)}>
                      <Text className={styles.imageRemoveText}>×</Text>
                    </View>
                  </View>
                ))}
                {images.length < MAX_IMAGES ? (
                  <View className={styles.imageAdd} onClick={handleAddImage}>
                    <Text className={styles.imageAddIcon}>＋</Text>
                    <Text className={styles.imageAddText}>{t('inbox.screenshot')}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <View className={styles.actionRow}>
              <Button
                className={classnames(styles.extractButton, extracting && styles.disabled)}
                onClick={handleExtract}
              >
                {extracting ? 'AI 提取中…' : 'AI 提取'}
              </Button>
              {images.length === 0 ? (
                <Button className={styles.addButton} onClick={handleAddImage}>
                  🖼 添加截图
                </Button>
              ) : null}
            </View>
          </>
        ) : (
          <>
            {/* 工作助手：三个动作 chip，点击即分析 */}
            <View className={styles.workChips}>
              {(
                [
                  ['summary', '✍️ 总结'],
                  ['points', '📌 提取要点'],
                  ['advice', '💡 给建议']
                ] as [WorkAction, string][]
              ).map(([action, label]) => (
                <View
                  key={action}
                  className={classnames(styles.workChip, workAction === action && styles.workChipActive)}
                  onClick={() => handleWorkRun(action)}
                >
                  <Text className={styles.workChipText}>{workBusy && workAction === action ? '分析中…' : label}</Text>
                </View>
              ))}
            </View>
            {workResult ? (
              <View className={styles.workCard}>
                <Text className={styles.workText}>{workResult}</Text>
                <View className={styles.workActions}>
                  <View className={styles.copyButton} onClick={copyWorkResult}>
                    <Text className={styles.copyButtonText}>{t('inbox.copyResult')}</Text>
                  </View>
                </View>
              </View>
            ) : null}
          </>
        )}
      </View>

      {drafts.length > 0 ? (
        <View className={styles.resultCard}>
          <View className={styles.resultHeader}>
            <Text className={styles.resultTitle}>{t('inbox.resultTitle')}</Text>
            <Text className={styles.resultMeta}>{t('inbox.resultMeta')}</Text>
          </View>
          {/* P0-2 合规显式标识：提取结果由 AI 生成整理，须显著标注 */}
          <Text className={styles.resultAiLabel}>{t('ai.labelExtract')}</Text>
          {/* 冲突区：优先渲染排班方案卡片（S-01~S-03，带候选时段分级） */}
          {conflictPlan ? (
            <PlanProposalCard
              proposal={conflictPlan}
              existing={briefing?.events || []}
              showAbandon={false}
              onApprove={handleApproveConflictPlan}
              onAbandon={() => setConflictPlan(null)}
            />
          ) : conflicts.length > 0 ? (
            <View className={styles.conflictCard}>
              <Text className={styles.conflictTitle}>{t('inbox.conflictTitle')}</Text>
              {conflicts.map((c) => (
                <View key={c.draftKey + c.startTime} className={styles.conflictItem}>
                  <Text className={styles.conflictText}>
                    「{c.title}」与现有日程「{c.clashTitle}」（{c.clashTime}）时间冲突，建议改到：
                  </Text>
                  <View className={styles.suggestRow}>
                    {c.suggestions.map((s) => (
                      <View key={s} className={styles.suggestChip} onClick={() => applySuggestion(c.draftKey, s)}>
                        改到 {dayjs(s).format('HH:mm')} ✓
                      </View>
                    ))}
                  </View>
                </View>
              ))}
              {/* 升级为方案卡片：给候选时段分级（空闲/冲突/拥挤 + 理由） */}
              <View className={styles.suggestChip} onClick={() => setConflictPlan(buildConflictProposal(conflicts))}>
                {t('plan.cardTitle', { n: conflicts.length })}
              </View>
            </View>
          ) : null}
          {drafts.map((draft) => (
            <View
              key={draft.key}
              className={classnames(
                styles.itemRow,
                draft.kind === 'event' && styles.eventRow,
                draft.kind === 'todo' && styles.todoRow,
                draft.kind === 'collection' && styles.collectionRow
              )}
            >
              <View className={classnames(styles.check, draft.checked && styles.checked)} onClick={() => toggleDraft(draft.key)}>
                {draft.checked ? <Text className={styles.checkIcon}>✓</Text> : null}
              </View>
              <View className={styles.itemBody}>
                <Input
                  className={styles.itemTitleInput}
                  value={draft.title}
                  onInput={(e) => editDraftTitle(draft.key, e.detail.value)}
                />
                {draft.kind === 'collection' ? (
                  <>
                    <Text className={styles.itemSummary}>{draft.summary}</Text>
                    <View className={styles.tagRow}>
                      {(draft.tags || []).map((t) => (
                        <Text key={t} className={styles.miniTag}>
                          {t}
                        </Text>
                      ))}
                    </View>
                  </>
                ) : (
                  <Input
                    className={styles.itemTimeInput}
                    value={draft.time || ''}
                    placeholder={t('inbox.timePlaceholder')}
                    onInput={(e) => editDraftTime(draft.key, e.detail.value)}
                  />
                )}
                <Text className={styles.miniTag} style={{ marginTop: '8rpx', display: 'inline-block' }}>
                  {kindLabel[draft.kind]}
                </Text>
              </View>
            </View>
          ))}
          {note ? <Text className={styles.itemSummary}>{note}</Text> : null}
          <Button
            className={classnames(styles.confirmButton, saving && styles.disabled)}
            onClick={handleConfirm}
          >
            {saving ? '入库中…' : '确认入库'}
          </Button>
        </View>
      ) : null}

      {history.length > 0 ? (
        <>
          <Text className={styles.historyTitle}>{t('inbox.historyTitle')}</Text>
          {history.map((h) => (
            <View key={h.id} className={styles.historyItem}>
              <Text className={styles.historyIcon}>📥</Text>
              <View className={styles.historyBody}>
                <Text className={styles.historyText}>{h.text}</Text>
                <Text className={styles.historyMeta}>
                  入库 {h.count} 条 · {fromNow(h.time)}
                </Text>
              </View>
            </View>
          ))}
        </>
      ) : (
        <EmptyState icon='📥' title='收件箱还是空的' hint='粘贴一条微信消息或截屏试试，AI 会帮你拆出日程和待办' />
      )}
    </View>
  );
}

export default InboxPage;
