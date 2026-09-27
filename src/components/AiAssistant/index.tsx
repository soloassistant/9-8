import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Input, Image } from '@tarojs/components';
import type { ITouchEvent } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import { apiChat, apiChatStream, apiApplyPlan, apiGetBriefing } from '@/services/api';
import { useT } from '@/store/language';
import { loadChatLog, saveChatLog } from '@/utils/chatLog';
import { buildPlanProposal, type PlanProposal, type PlanProposalRaw, type PlanApplyEvent } from '@/utils/schedule';
import { readMemory, writeMemory, undoMemory, memoryToast, MEMORY_UNDO_WINDOW_MS, type MemoryItem } from '@/utils/memory';
import type { ScheduleEvent } from '@/types';
import PlanProposalCard from '@/components/PlanProposalCard';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';
/** AI 助理对话本地持久化 key（上限 60 条，由 saveChatLog 截断） */
const AI_LOG_KEY = 'aiAssistantLog';

/** 视口尺寸（px）；H5 读 window，weapp 兜底 getWindowInfo */
const getViewport = () => {
  if (isH5 && typeof window !== 'undefined') {
    return { w: window.innerWidth, h: window.innerHeight };
  }
  try {
    const info = Taro.getWindowInfo();
    return { w: info.windowWidth, h: info.windowHeight };
  } catch {
    return { w: 375, h: 667 };
  }
};

/** 各页面上下文对应的默认主动建议 */
const CONTEXT_HINTS: Record<string, string> = {
  briefing: '帮我梳理一下今天的时间安排',
  inbox: '帮我把转发的内容提取成日程和待办',
  hotspot: '帮我总结一下今天的热点新闻',
  calendar: '把今天的待办整理给我看看',
  mine: '介绍一下订阅方案和语音额度',
  search: '告诉我你想找什么，我帮你搜',
  history: '看看我最近浏览过什么',
  settings: '帮我检查一下我的设置',
  shopping: '帮我看下购物清单，哪些值得跟进比价'
};

interface AiAssistantProps {
  /** 页面标识，用于生成默认主动建议 */
  context?: string;
  /** 页面主动传入的动态建议（如搜索无结果时），优先于默认建议 */
  activeHint?: string;
  /** 额外抬升距离（rpx），用于避让晨报页常驻输入栏 */
  offset?: number;
}

interface AssistantMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** AI 附带图片（F25：热点封面等真实内容图） */
  image?: string;
  /** 排班方案（S-01：AI 只提议，勾选后由 apiApplyPlan 落库） */
  proposal?: PlanProposal;
  /** P1-E 记忆溯源：本次随请求发送的记忆条数（仅在携带排班提案的回复上记录） */
  memoryCount?: number;
  /** P1-E 记忆溯源：本次发送的记忆明细（footnote 展开面板逐条展示） */
  memoryItems?: MemoryItem[];
  createTime: string;
}

/** 记忆写入 toast 状态（M-03：底部 toast + 5s 撤销） */
interface MemoryToastState {
  text: string;
  ids: string[];
}

function AiAssistant({ context = '', activeHint, offset = 0 }: AiAssistantProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  // AI 对话本地持久化：重进恢复上下文；恢复后打开面板不再重复欢迎语（messages.length > 0）
  const [messages, setMessages] = useState<AssistantMsg[]>(() => loadChatLog<AssistantMsg>(AI_LOG_KEY));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 记忆写入 toast（M-03）：底部展示 + 5s 内可撤销
  const [memoryToastState, setMemoryToastState] = useState<MemoryToastState | null>(null);
  // P1-E 记忆溯源：展开明细面板的消息 id（null = 全部收起）
  const [memoryPanelMsgId, setMemoryPanelMsgId] = useState<string | null>(null);
  // 现有日程：方案卡片换时段时重跑冲突检测用（S-02）
  const existingEventsRef = useRef<ScheduleEvent[]>([]);
  // 消息 id 计数器以恢复的历史长度为起点，避免与持久化消息 id 冲突
  const msgIdRef = useRef(messages.length);

  // 对话变化落 storage（截断由 saveChatLog 兜底）
  useEffect(() => {
    saveChatLog(AI_LOG_KEY, messages);
  }, [messages]);
  /** 自动弹出的主动建议每会话只弹一次，避免骚扰 */
  const hintShownRef = useRef(false);

  const suggestion = useMemo(() => activeHint || CONTEXT_HINTS[context] || '', [activeHint, context]);

  /** 主动建议气泡：动态建议即时显示；默认建议延迟一次；面板打开时隐藏 */
  useEffect(() => {
    if (open) {
      setHintVisible(false);
      return;
    }
    if (!suggestion) return;
    if (activeHint) {
      setHintVisible(true);
      return;
    }
    if (!hintShownRef.current) {
      hintShownRef.current = true;
      const timer = setTimeout(() => setHintVisible(true), 1200);
      return () => clearTimeout(timer);
    }
  }, [open, activeHint, suggestion]);

  /** 气泡 8s 自动收起 */
  useEffect(() => {
    if (!hintVisible) return;
    const timer = setTimeout(() => setHintVisible(false), 8000);
    return () => clearTimeout(timer);
  }, [hintVisible]);

  /** P1-E 记忆溯源附加字段（仅在携带排班提案的回复上带） */
  interface MemoryTrace {
    memoryCount: number;
    memoryItems: MemoryItem[];
  }

  const push = useCallback(
    (
      role: AssistantMsg['role'],
      content: string,
      image?: string,
      proposal?: PlanProposal,
      memory?: MemoryTrace
    ): string => {
      msgIdRef.current += 1;
      const id = `ai-msg-${msgIdRef.current}`;
      setMessages((prev) => [
        ...prev,
        {
          id,
          role,
          content,
          image,
          proposal,
          memoryCount: memory?.memoryCount,
          memoryItems: memory?.memoryItems,
          createTime: dayjs().toISOString()
        }
      ]);
      return id;
    },
    []
  );

  /** F-03 流式打字机追加 / done 校正 / 失败移除 */
  const appendMsg = useCallback((id: string, chunk: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)));
  }, []);
  const setMsgContent = useCallback((id: string, content: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
  }, []);
  /** 局部更新消息字段（P1-E：流式完成后补记 memoryCount/memoryItems） */
  const patchMsg = useCallback((id: string, patch: Partial<AssistantMsg>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);
  const removeMsg = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /** 加载现有日程（方案卡片换时段时重跑冲突检测用）；失败静默降级为空数组 */
  const loadExistingEvents = useCallback(async () => {
    try {
      const briefing = await apiGetBriefing();
      existingEventsRef.current = briefing?.events || [];
    } catch (err) {
      console.warn('[AiAssistant] load briefing for conflict check failed:', err);
      existingEventsRef.current = [];
    }
  }, []);

  /** 记忆写入 toast + 5s 撤销（M-03 / M-04）：撤销后写入抑制列表，本轮不再重复写入 */
  const memoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showMemoryToast = useCallback((items: MemoryItem[]) => {
    if (items.length === 0) return;
    const toast = memoryToast(items);
    const text = t(toast.key, toast.params);
    const ids = items.map((item) => item.id);
    setMemoryToastState({ text, ids });
    if (memoryTimerRef.current) clearTimeout(memoryTimerRef.current);
    memoryTimerRef.current = setTimeout(() => setMemoryToastState(null), MEMORY_UNDO_WINDOW_MS);
  }, [t]);

  const handleUndoMemory = useCallback(() => {
    if (!memoryToastState) return;
    undoMemory(memoryToastState.ids);
    if (memoryTimerRef.current) clearTimeout(memoryTimerRef.current);
    setMemoryToastState(null);
    Taro.showToast({ title: t('memory.undone'), icon: 'none' });
  }, [memoryToastState, t]);

  // 卸载时清理 toast 定时器
  useEffect(
    () => () => {
      if (memoryTimerRef.current) clearTimeout(memoryTimerRef.current);
    },
    []
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || sending) return;
      setSending(true);
      push('user', content);
      // 记忆回灌：发消息时读取用户长期记忆（开关关闭/读取失败则空数组），随请求带给模型
      const memStore = readMemory();
      // P1-E：保留明细（content/createdAt/source）供溯源 footnote；发送侧只取 content
      const memItems = memStore.enabled ? memStore.items.slice(0, 20) : [];
      const memories = memItems.map((m) => m.content);
      const memoryTrace: MemoryTrace | undefined = memItems.length > 0 ? { memoryCount: memItems.length, memoryItems: memItems } : undefined;
      try {
        let res: { reply: string; action: string; image?: string; proposals?: PlanProposalRaw[]; memories?: string[] } | null =
          null;
        if (isH5) {
          // F-03 H5 流式：空气泡打字机追加；失败移除空气泡降级整段 apiChat
          const streamId = push('assistant', '');
          const streamed = await apiChatStream(content, false, (chunk) => appendMsg(streamId, chunk), memories);
          if (streamed) {
            setMsgContent(streamId, streamed.reply);
            // P1-E：流式完成后与降级路径汇合——action='plan'（即排班提案回复）时补记记忆溯源
            if (streamed.action === 'plan' && memoryTrace) {
              patchMsg(streamId, memoryTrace);
            }
            res = streamed;
          } else {
            removeMsg(streamId);
          }
        }
        if (!res) {
          res = await apiChat(content, 'text', false, undefined, memories);

          // S-01：AI 返回排班提案时，前端补齐候选时段与冲突标记（云函数不写库）
          let proposal: PlanProposal | undefined;
          if (res.action === 'plan' && Array.isArray(res.proposals) && res.proposals.length > 0) {
            if (existingEventsRef.current.length === 0) await loadExistingEvents();
            proposal = buildPlanProposal(res.proposals, existingEventsRef.current);
          }
          // P1-E：仅携带排班提案的回复记录记忆溯源，普通回复不显示 footnote
          push('assistant', res.reply, res.image, proposal, proposal ? memoryTrace : undefined);

          // M-03：云函数返回记忆条目时写入并展示 toast（P1-E：附带当前对话原文作溯源短语）
          if (Array.isArray(res.memories) && res.memories.length > 0) {
            showMemoryToast(writeMemory(res.memories, 'chat', content));
          }
        }
      } catch (err) {
        console.error('[AiAssistant] chat failed:', err);
        push('assistant', '抱歉，我刚刚走神了，请再说一次。');
      } finally {
        setSending(false);
      }
    },
    [sending, push, appendMsg, setMsgContent, patchMsg, removeMsg, loadExistingEvents, showMemoryToast]
  );

  /** 批准方案：透传 apiApplyPlan 落库（S-01），成功后 toast 并从消息中移除卡片 */
  const handleApprovePlan = useCallback(
    async (events: PlanApplyEvent[], src: PlanProposal, msgId: string) => {
      if (events.length === 0) return;
      const result = await apiApplyPlan({ events, proposalId: src.id, count: events.length });
      if (result.ok) {
        Taro.showToast({ title: t('plan.savedToast', { n: result.saved }), icon: 'success' });
        // 落库成功后移除卡片，日历页立即可见（PRD 4.2）
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, proposal: undefined } : m)));
        // 日程已变更，刷新本地缓存供后续冲突检测
        await loadExistingEvents();
      } else {
        Taro.showToast({ title: '暂时无法写入，请稍后再试', icon: 'none' });
      }
    },
    [t, loadExistingEvents]
  );

  /** 放弃方案：二次确认后移除卡片，不写库、不残留草稿（PRD 4.2） */
  const handleAbandonPlan = useCallback(
    (msgId: string) => {
      Taro.showModal({
        title: t('plan.abandonTitle'),
        content: t('plan.abandonBody'),
        confirmText: t('plan.abandonTitle').slice(0, 4),
        success: (res) => {
          if (!res.confirm) return;
          setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, proposal: undefined } : m)));
        }
      });
    },
    [t]
  );

  /** 全屏预览 AI 附图（F25）；失败静默 */
  const previewImage = useCallback((src?: string) => {
    if (!src) return;
    Taro.previewImage({ urls: [src] }).catch((err) => console.warn('[AiAssistant] previewImage failed:', err));
  }, []);

  const handleFabTap = () => {
    // 拖动结束后浏览器会补发一次合成 click，250ms 内的点击视为拖动余波，忽略
    if (Date.now() - lastDragEndRef.current < 250) return;
    setOpen(true);
    setHintVisible(false);
    if (messages.length === 0) {
      const greeting = suggestion ? `你好，我是你的 AI 助理 🤖\n\n需要我帮你做点什么？比如：「${suggestion}」` : '你好，我是你的 AI 助理 🤖 需要我帮你做点什么？';
      push('assistant', greeting);
    }
  };

  /** 悬浮球拖动位置（px，视口坐标）；null = 默认右下角。拖动状态存在 ref 中避免拖动中额外重渲染 */
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(null);
  const fabRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);
  const lastDragEndRef = useRef(0);

  /** 取 fab 的 DOM 元素：H5 端 Taro 不转发 ref，改用稳定 id 查询 */
  const getFabEl = (): HTMLElement | null => {
    if (isH5 && typeof document !== 'undefined') {
      return document.getElementById('ai-fab');
    }
    return (fabRef.current as HTMLElement | null) ?? null;
  };

  const beginDrag = useCallback(
    (x: number, y: number) => {
      const rect = getFabEl()?.getBoundingClientRect?.() ?? null;
      // base 取当前实际位置：首次拖动时读 fab 的视口坐标，之后以 fabPos 为基准
      const base = fabPos ?? { x: rect?.left ?? 0, y: rect?.top ?? 0 };
      dragState.current = {
        startX: x,
        startY: y,
        baseX: base.x,
        baseY: base.y,
        width: rect?.width ?? 54,
        height: rect?.height ?? 54,
        moved: false
      };
      // 拖动时收起建议气泡：气泡比球宽，会影响 wrapper 按坐标定位的准确性
      setHintVisible(false);
    },
    [fabPos]
  );

  const updateDrag = useCallback((x: number, y: number) => {
    const d = dragState.current;
    if (!d) return;
    const dx = x - d.startX;
    const dy = y - d.startY;
    // 位移 6px 以内视为点击，不进入拖动
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    d.moved = true;
    const { w: vw, h: vh } = getViewport();
    // 钳制在视口内：四周留 8px；H5 底部额外避让 TabBar（约 50px + 余量）
    const maxX = Math.max(8, vw - d.width - 8);
    const maxY = Math.max(8, vh - d.height - (isH5 ? 58 : 8));
    setFabPos({
      x: Math.min(Math.max(d.baseX + dx, 8), maxX),
      y: Math.min(Math.max(d.baseY + dy, 8), maxY)
    });
  }, []);

  const finishDrag = useCallback(() => {
    const d = dragState.current;
    dragState.current = null;
    if (d?.moved) lastDragEndRef.current = Date.now();
  }, []);

  /** 触屏按下（weapp 路径；H5 走下方原生绑定）：move/end 由 onTouchMove/onTouchEnd props 提供
   *  参数用 Taro 的 ITouchEvent（实际只读 touches[0] 坐标） */
  const handleFabTouchStart = (e: ITouchEvent) => {
    const p0 = e.touches?.[0];
    if (!p0 || isH5) return;
    beginDrag(p0.clientX, p0.clientY);
  };

  const handleFabTouchMove = (e: ITouchEvent) => {
    const p0 = e.touches?.[0];
    if (p0) updateDrag(p0.clientX, p0.clientY);
  };

  /** H5：Taro 组件不转发 onMouseDown 等非标事件，故用原生绑定挂到 fab 元素上；
      move/up 挂 window，鼠标/手指移出球体也能继续拖动 */
  useEffect(() => {
    if (!isH5 || typeof window === 'undefined') return;
    const el = getFabEl();
    if (!el || typeof el.addEventListener !== 'function') return;

    const startWith = (x: number, y: number) => {
      beginDrag(x, y);
      const move = (ev: MouseEvent) => updateDrag(ev.clientX, ev.clientY);
      const touchMove = (ev: TouchEvent) => {
        const p = ev.touches?.[0];
        if (p) updateDrag(p.clientX, p.clientY);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('touchmove', touchMove);
        window.removeEventListener('touchend', up);
        window.removeEventListener('touchcancel', up);
        finishDrag();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('touchmove', touchMove, { passive: true });
      window.addEventListener('touchend', up);
      window.addEventListener('touchcancel', up);
    };

    const onMouseDown = (ev: Event) => {
      const me = ev as MouseEvent;
      startWith(me.clientX, me.clientY);
    };
    const onTouchStart = (ev: Event) => {
      const p0 = (ev as TouchEvent).touches?.[0];
      if (p0) startWith(p0.clientX, p0.clientY);
    };

    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('touchstart', onTouchStart);
    return () => {
      el.removeEventListener?.('mousedown', onMouseDown);
      el.removeEventListener?.('touchstart', onTouchStart);
    };
  }, [beginDrag, updateDrag, finishDrag]);

  /** 点击主动建议气泡：唤起面板并直接发送 */
  const handleHintTap = () => {
    setHintVisible(false);
    setOpen(true);
    if (suggestion) sendMessage(suggestion);
  };

  const handleHintClose = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setHintVisible(false);
  };

  const lastMsgId = messages.length > 0 ? messages[messages.length - 1].id : '';

  const fabStyle = { bottom: `calc(${isH5 ? '50px' : '0px'} + env(safe-area-inset-bottom) + ${100 + offset}rpx)` };

  /** 拖过位后位置生效：wrapper 从「全宽贴底」切换为「按坐标定位」 */
  const wrapperStyle = fabPos
    ? { left: fabPos.x, top: fabPos.y, right: 'auto', bottom: 'auto', padding: 0 }
    : fabStyle;

  /** 拖动事件：H5 由上方 useEffect 原生绑定（Taro 不转发鼠标事件），weapp 走 touch props */
  const fabDragProps = isH5
    ? { id: 'ai-fab' }
    : { ref: fabRef, onTouchStart: handleFabTouchStart, onTouchMove: handleFabTouchMove, onTouchEnd: finishDrag };

  return (
    <View className={styles.wrapper} style={wrapperStyle}>
      {hintVisible && suggestion ? (
        <View className={styles.hintBubble} onClick={handleHintTap}>
          <Text className={styles.hintText}>💡 {suggestion}</Text>
          <View className={styles.hintClose} onClick={handleHintClose}>
            ✕
          </View>
        </View>
      ) : null}

      <View id='ai-fab' className={styles.fab} onClick={handleFabTap} {...fabDragProps}>
        <Text className={styles.fabIcon}>🤖</Text>
      </View>

      {open ? (
        <View className={styles.panel}>
          <View className={styles.panelHeader}>
            <Text className={styles.panelTitle}>{t('ai.title')}</Text>
            <View className={styles.panelClose} onClick={() => setOpen(false)}>
              ✕
            </View>
          </View>

          <ScrollView scrollY scrollIntoView={lastMsgId} className={styles.msgList}>
            {messages.map((m) => (
              <View
                key={m.id}
                id={m.id}
                className={classnames(styles.msgRow, m.role === 'user' && styles.msgRowUser)}
              >
                <View
                  className={classnames(styles.msgBubble, m.role === 'user' ? styles.msgBubbleUser : styles.msgBubbleAi)}
                >
                  <Text className={styles.msgText}>{m.content}</Text>
                  {/* AI 发图（F25）：点击全屏预览 */}
                  {m.image ? (
                    <Image
                      src={m.image}
                      mode='aspectFill'
                      lazyLoad
                      className={styles.msgImage}
                      onClick={() => previewImage(m.image)}
                    />
                  ) : null}
                  {/* 排班方案卡片（S-01~S-03）：勾选后由 apiApplyPlan 落库 */}
                  {m.proposal ? (
                    <PlanProposalCard
                      proposal={m.proposal}
                      existing={existingEventsRef.current}
                      onApprove={(events, src) => handleApprovePlan(events, src, m.id)}
                      onAbandon={() => handleAbandonPlan(m.id)}
                    />
                  ) : null}
                  {/* P0-2 合规显式标识：AI 回复气泡底部标注「AI 生成内容」（用户消息不标） */}
                  {m.role === 'assistant' ? (
                    <Text className={styles.msgLabel}>{t('ai.labelText')}</Text>
                  ) : null}
                  {/* P1-E 记忆溯源：仅携带排班提案的回复显示；点击展开/收起本次发送的记忆明细 */}
                  {m.role === 'assistant' && m.memoryCount && m.memoryItems && m.memoryItems.length > 0 ? (
                    <View className={styles.memoryFootnote}>
                      <Text
                        className={styles.memoryFootnoteText}
                        onClick={() => setMemoryPanelMsgId(memoryPanelMsgId === m.id ? null : m.id)}
                      >
                        {memoryPanelMsgId === m.id ? '▾ ' : '▸ '}
                        {t('ai.memoryUsed', { n: m.memoryCount })}
                      </Text>
                      {memoryPanelMsgId === m.id ? (
                        <View className={styles.memoryPanel}>
                          {m.memoryItems.map((item) => (
                            <View key={item.id} className={styles.memoryPanelRow}>
                              <Text className={styles.memoryPanelContent}>{item.content}</Text>
                              <Text className={styles.memoryPanelMeta}>
                                {dayjs(item.createdAt).format('MM-DD HH:mm')} · {item.source === 'seed' ? '初始' : '对话'}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              </View>
            ))}
          </ScrollView>

          {/* 记忆写入 toast + 5s 撤销（M-03 / M-04） */}
          {memoryToastState ? (
            <View className={styles.memoryToast}>
              <Text className={styles.memoryToastText}>💭 {memoryToastState.text}</Text>
              <View className={styles.memoryUndo} onClick={handleUndoMemory}>
                <Text className={styles.memoryUndoText}>{t('memory.undo')}</Text>
              </View>
            </View>
          ) : null}

          <View className={styles.inputRow}>
            <Input
              className={styles.input}
              value={input}
              placeholder={t('ai.placeholder')}
              confirmType='send'
              onInput={(e) => setInput(e.detail.value)}
              onConfirm={() => {
                sendMessage(input);
                setInput('');
              }}
            />
            <View
              className={classnames(styles.sendBtn, sending && styles.sendBtnDisabled)}
              onClick={() => {
                sendMessage(input);
                setInput('');
              }}
            >
              {sending ? '…' : t('ai.send')}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default AiAssistant;
