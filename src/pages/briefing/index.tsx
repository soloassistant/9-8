import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Input, Button, Image } from '@tarojs/components';
import Taro, { usePullDownRefresh, useDidHide, useShareAppMessage } from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import VoiceButton, { VoiceResult } from '@/components/VoiceButton';
import EmptyState from '@/components/EmptyState';
import { apiGetBriefing, apiChat } from '@/services/api';
import { locateCity } from '@/services/location';
import { useUserStore } from '@/store/user';
import { brandVars, useThemeStore } from '@/store/theme';
import { getGreeting, formatEventTime } from '@/utils/date';
import { logActivity } from '@/utils/activityLog';
import { computeAdaptive } from '@/utils/adaptive';
import { splitTtsChunks, startSpeak, stopSpeak } from '@/utils/tts';
import { loadChatLog, saveChatLog } from '@/utils/chatLog';
import { TERMS_TEXT, PRIVACY_TEXT, AI_SERVICES_TEXT, hasAgreedConsent, saveConsent } from '@/data/legal';
import type { Briefing, ChatMessage } from '@/types';
import { useT, useLanguageStore } from '@/store/language';
import type { LangKey } from '@/store/language';
import styles from './index.module.scss';
import shareCover from '@/assets/share-cover.png';

const isWeapp = process.env.TARO_ENV === 'weapp';
/** H5 预览端底部有 50px TabBar，输入栏需避让 */
const isH5 = process.env.TARO_ENV === 'h5';

/** 快捷指令（优化输入：点击填充输入框，减少手打成本） */
const QUICK_COMMANDS: Array<{ icon: string; labelKey: LangKey; text: string }> = [
  { icon: '📅', labelKey: 'briefing.quickSchedule', text: '帮我安排 ' },
  { icon: '✍️', labelKey: 'briefing.quickNote', text: '记一下：' },
  { icon: '✅', labelKey: 'briefing.quickDone', text: '完成了「」' },
  { icon: '🔥', labelKey: 'briefing.quickHot', text: '今天有什么热点' }
];
/** 订阅消息模板 ID：上线前在小程序后台申请后替换（TODO） */
const SUBSCRIBE_TEMPLATE_ID = 'TODO_TEMPLATE_ID';

/** AI 对话本地持久化 key（上限 60 条） */
const BRIEFING_CHAT_LOG_KEY = 'briefingChatLog';
/** H5 预览时模拟语音转写的示例指令 */
const MOCK_TRANSCRIPTS = [
  '把产品评审会改到明天下午两点',
  '我今天有什么安排',
  '回复客户邮件这个待办完成了'
];
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function BriefingPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { theme } = useThemeStore();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  // AI 对话本地持久化：重进恢复上下文（上限 60 条，超限截旧）
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const restored = loadChatLog<ChatMessage>(BRIEFING_CHAT_LOG_KEY);
    return restored;
  });
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [deepMode, setDeepMode] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { profile, usage, init, refreshUsage } = useUserStore();
  const mockIndexRef = useRef(0);
  // 消息 id 计数器以恢复的历史长度为起点，避免与持久化消息 id 冲突
  const msgIdRef = useRef(messages.length);

  // H5 首启合规同意（小程序端依赖微信平台隐私弹窗机制，仅网页端启用）
  const [showConsent, setShowConsent] = useState(() => isH5 && !hasAgreedConsent());
  const [consentDeclined, setConsentDeclined] = useState(false);
  const handleConsentAgree = () => {
    saveConsent();
    setConsentDeclined(false);
    setShowConsent(false);
  };
  const handleConsentDecline = () => setConsentDeclined(true);

  // 对话变化落 storage（截断由 saveChatLog 兜底）
  useEffect(() => {
    saveChatLog(BRIEFING_CHAT_LOG_KEY, messages);
  }, [messages]);

  // 转发分享（F30）：带品牌分享封面
  useShareAppMessage(() => ({
    title: t('share.title'),
    path: '/pages/briefing/index',
    imageUrl: shareCover
  }));

  const loadBriefing = useCallback(async () => {
    try {
      const data = await apiGetBriefing();
      setBriefing(data);
    } catch (err) {
      console.error('[BriefingPage] loadBriefing failed:', err);
      Taro.showToast({ title: t('briefing.loadFailed'), icon: 'none' });
    }
  }, [t]);

  // 定位授权（用户点击触发）：定位 → 换城市 → 存 storage → 刷新晨报天气
  const [locating, setLocating] = useState(false);
  const handleLocate = async () => {
    if (locating) return;
    setLocating(true);
    const city = await locateCity();
    setLocating(false);
    if (city) {
      Taro.showToast({ title: t('briefing.located') + city, icon: 'none' });
      loadBriefing();
    } else {
      Taro.showToast({ title: t('briefing.locateDenied'), icon: 'none' });
    }
  };

  useEffect(() => {
    init();
    loadBriefing();
  }, []);

  usePullDownRefresh(async () => {
    await Promise.all([loadBriefing(), refreshUsage()]);
    Taro.stopPullDownRefresh();
  });

  // 离开页面即停播（F20：全局单播放通道，stopSpeak 幂等）
  useDidHide(() => {
    stopSpeak();
    setIsSpeaking(false);
  });

  const pushMessage = (
    role: ChatMessage['role'],
    content: string,
    type: ChatMessage['type'] = 'text',
    deep = false,
    image?: string
  ) => {
    msgIdRef.current += 1;
    setMessages((prev) => [
      ...prev,
      { id: `msg-${msgIdRef.current}`, role, type, deep, content, image, createTime: dayjs().toISOString() }
    ]);
  };

  /** 全屏预览 AI 附图（F25）；预览失败静默（图片仍在气泡内可见） */
  const previewImage = (src: string) => {
    Taro.previewImage({ urls: [src] }).catch((err) => console.warn('[BriefingPage] previewImage failed:', err));
  };

  const askAssistant = async (message: string, type: 'text' | 'voice') => {
    if (!message.trim() || sending) return;
    setSending(true);
    pushMessage('user', message, type);
    try {
      const res = await apiChat(message, type, deepMode);
      pushMessage('assistant', res.reply, 'text', deepMode, res.image);
      logActivity(deepMode ? '🧠' : '💬', deepMode ? `深度思考：${message.slice(0, 14)}` : `AI 对话：${message.slice(0, 14)}`);
    } catch (err) {
      console.error('[BriefingPage] chat failed:', err);
      pushMessage('assistant', t('ai.fallbackReply'));
    } finally {
      setSending(false);
    }
  };

  const handleGoSearch = () => {
    Taro.navigateTo({ url: '/pages/search/index' });
  };

  /** 待办勾选完成（v2.0 F27），复用对话通道记录 */
  const handleToggleTodo = async (todoId: string, title: string) => {
    const next = new Set(doneIds);
    const finishing = !next.has(todoId);
    if (finishing) next.add(todoId);
    else next.delete(todoId);
    setDoneIds(next);
    try {
      await apiChat(finishing ? `完成了「${title}」` : `取消完成「${title}」`);
    } catch (err) {
      console.error('[BriefingPage] toggle todo failed:', err);
    }
  };

  const handleSendText = () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    askAssistant(text, 'text');
  };

  const checkVoiceQuota = (): boolean => {
    if (!usage) return true;
    if (usage.voiceQuota >= 0 && usage.voiceUsed >= usage.voiceQuota) {
      Taro.showModal({
        title: t('briefing.voiceLimitTitle'),
        content: t('briefing.voiceLimitContent'),
        confirmText: t('briefing.goSubscribe'),
        success: (res) => {
          if (res.confirm) Taro.switchTab({ url: '/pages/mine/index' });
        }
      });
      return false;
    }
    return true;
  };

  const handleVoiceResult = (result: VoiceResult) => {
    if (!result.confirmed) return;
    if (!checkVoiceQuota()) return;
    if (result.transcript) {
      // 有转写文本：微信端同声传译插件识别成功（H5 端为 mock 转写），直接进对话链路
      askAssistant(result.transcript, 'voice');
      return;
    }
    if (isWeapp) {
      // 无转写的微信端结果 = 同声传译插件未配置的降级路径（纯录音）
      Taro.showToast({ title: t('briefing.voiceNoPlugin'), icon: 'none', duration: 2000 });
      return;
    }
    // 非微信端兜底：模拟转写结果
    const transcript = MOCK_TRANSCRIPTS[mockIndexRef.current % MOCK_TRANSCRIPTS.length];
    mockIndexRef.current += 1;
    askAssistant(transcript, 'voice');
  };

  const handleSubscribe = async () => {
    if (!isWeapp) {
      Taro.showToast({ title: t('briefing.subscribeWeappOnly'), icon: 'none' });
      return;
    }
    try {
      // Taro 类型把仅支付宝的 entityIds 标为必填（weapp 运行时只需 tmplIds），@ts-expect-error 屏蔽
      // @ts-expect-error TS2345: Taro 类型定义缺陷
      const res = await Taro.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TEMPLATE_ID] });
      console.info('[BriefingPage] subscribe result:', res[SUBSCRIBE_TEMPLATE_ID]);
      if (res[SUBSCRIBE_TEMPLATE_ID] === 'accept') {
        Taro.showToast({ title: t('briefing.subscribeOk'), icon: 'success' });
      }
    } catch (err) {
      console.error('[BriefingPage] subscribe failed:', err);
      Taro.showToast({ title: t('briefing.subscribeFail'), icon: 'none' });
    }
  };

  const todayEvents = (briefing?.events || []).filter((e) => dayjs(e.startTime).isSame(dayjs(), 'day'));
  /** 今日时间线：今日日程 + 今日到期待办，按时间排序（用户需求：待办并入今日日程） */
  const todaySchedule = [
    ...todayEvents.map((e) => ({
      kind: 'event' as const,
      id: e.id,
      title: e.title,
      time: e.startTime,
      location: e.location
    })),
    ...(briefing?.todos || [])
      .filter((t) => t.dueDate && dayjs(t.dueDate).isSame(dayjs(), 'day'))
      .map((t) => ({
        kind: 'todo' as const,
        id: t.id,
        title: t.title,
        time: t.dueDate!,
        location: undefined as string | undefined
      }))
  ].sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf());
  const hasContent =
    briefing && (todaySchedule.length > 0 || briefing.todos.length > 0 || briefing.digest.length > 0);

  /* ---------------- F21 晨报自适应 ---------------- */
  // 信号：优先用云端/mock 下发的 adaptive，缺失时前端同口径现算
  const adaptive = briefing ? briefing.adaptive ?? computeAdaptive(briefing.events, briefing.todos) : null;
  const busyMinutes = todayEvents.reduce((sum, e) => {
    const mins = e.endTime ? dayjs(e.endTime).diff(dayjs(e.startTime), 'minute') : 60;
    return sum + (mins > 0 ? mins : 60);
  }, 0);
  const adaptiveBanner = (() => {
    if (!adaptive) return null;
    if (adaptive.busyDay) {
      return t('briefing.adaptiveBusy', { count: todayEvents.length, hours: Math.max(1, Math.round(busyMinutes / 60)) });
    }
    if (adaptive.tripCity) return t('briefing.adaptiveTrip', { city: adaptive.tripCity });
    if (adaptive.focusTodo) return t('briefing.adaptiveFocus', { title: adaptive.focusTodo });
    return null;
  })();

  /* ---------------- F20 音频晨报 ---------------- */
  /** 整份晨报转播报稿：开场点名（自适应）→ 天气 → 日程 → 待办 → 精选，≤3 分钟 */
  const handleAudioToggle = () => {
    if (isSpeaking) {
      stopSpeak();
      setIsSpeaking(false);
      return;
    }
    if (!briefing) return;
    const lines: string[] = [briefing.greeting];
    if (adaptive?.focusTodo) lines.push(`先办「${adaptive.focusTodo}」`);
    if (briefing.intel?.weather) lines.push(briefing.intel.weather.text);
    if (todayEvents.length) {
      lines.push('今日日程');
      todayEvents.forEach((e) =>
        lines.push(`${formatEventTime(e.startTime)}，${e.title}${e.location ? `，地点${e.location}` : ''}`)
      );
    }
    const pendingTodos = briefing.todos.filter((td) => !doneIds.has(td.id));
    if (pendingTodos.length) {
      lines.push('待办事项');
      pendingTodos.forEach((td) => lines.push(`${td.dueDate ? `${formatEventTime(td.dueDate)}，` : ''}${td.title}`));
    }
    if (briefing.digest.length) {
      lines.push('昨日收藏精选');
      briefing.digest.forEach((d) => lines.push(d));
    }
    startSpeak(splitTtsChunks(lines.join('。')), {
      onEnd: () => setIsSpeaking(false),
      onError: (msg) => {
        setIsSpeaking(false);
        Taro.showToast({ title: msg, icon: 'none' });
      }
    });
    setIsSpeaking(true);
  };

  const lastMsgId = messages.length > 0 ? messages[messages.length - 1].id : '';

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.headerTop}>
          <View className={styles.headerMain}>
            <Text className={styles.greeting}>
              {profile ? `${profile.nickname}，${getGreeting(dayjs().hour())}` : getGreeting(dayjs().hour())}
            </Text>
            <View className={styles.dateRow}>
              <Text className={styles.date}>
                {lang === 'en' ? dayjs().format('MMM D') : dayjs().format('M月D日')}{' '}
                {(lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH)[dayjs().day()]}
              </Text>
              {profile?.subscribed ? <Text className={styles.badge}>{t('mine.badgeSubscribed')}</Text> : null}
            </View>
          </View>
          <View className={styles.headerActions}>
            {hasContent ? (
              <Button
                className={classnames(styles.audioButton, isSpeaking && styles.audioButtonActive)}
                onClick={handleAudioToggle}
                aria-label={isSpeaking ? t('briefing.audioStop') : t('briefing.audioPlay')}
              >
                {isSpeaking ? '⏹' : '🔊'}
              </Button>
            ) : null}
            <Button className={styles.searchButton} onClick={handleGoSearch}>
              🔍
            </Button>
          </View>
        </View>
      </View>

      {hasContent && adaptiveBanner ? (
        <View className={styles.adaptiveBanner}>
          <Text className={styles.adaptiveIcon}>⚡</Text>
          <Text className={styles.adaptiveText}>{adaptiveBanner}</Text>
        </View>
      ) : null}

      {!hasContent ? (
        <View className={styles.section}>
          <EmptyState icon='☕' title={t('briefing.emptyTitle')} hint={t('briefing.emptyHint')} />
        </View>
      ) : (
        <>
          {todaySchedule.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>📅</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionToday')}</Text>
                <Text className={styles.sectionCount}>
                  {todaySchedule.length} {t('common.itemCount')}
                </Text>
              </View>
              {todaySchedule.map((item) => {
                const done = item.kind === 'todo' && doneIds.has(item.id);
                return (
                  <View
                    key={item.id}
                    className={styles.eventItem}
                    onClick={item.kind === 'todo' ? () => handleToggleTodo(item.id, item.title) : undefined}
                  >
                    <View className={styles.timeBlock}>
                      <Text className={styles.time}>{dayjs(item.time).format('HH:mm')}</Text>
                    </View>
                    <View className={styles.eventBody}>
                      {item.kind === 'todo' ? (
                        <View className={styles.todoInline}>
                          <View className={classnames(styles.checkbox, done && styles.checkboxDone)}>
                            {done ? <Text className={styles.checkboxMark}>✓</Text> : null}
                          </View>
                          <Text className={classnames(styles.eventTitle, done && styles.todoDone)}>{item.title}</Text>
                        </View>
                      ) : (
                        <>
                          <Text className={styles.eventTitle}>{item.title}</Text>
                          {item.location ? <Text className={styles.eventLocation}>📍 {item.location}</Text> : null}
                        </>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {briefing && briefing.todos.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>✅</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionTodo')}</Text>
                <Text className={styles.sectionCount}>
                  {briefing.todos.length} {t('common.itemCount')}
                </Text>
              </View>
              {briefing.todos.map((todo) => {
                const done = doneIds.has(todo.id);
                return (
                  <View
                    key={todo.id}
                    className={styles.todoItem}
                    onClick={() => handleToggleTodo(todo.id, todo.title)}
                  >
                    <View className={classnames(styles.checkbox, done && styles.checkboxDone)}>
                      {done ? <Text className={styles.checkboxMark}>✓</Text> : null}
                    </View>
                    <Text className={classnames(styles.todoTitle, done && styles.todoDone)}>{todo.title}</Text>
                    {todo.dueDate ? <Text className={styles.todoDue}>{formatEventTime(todo.dueDate)}</Text> : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          {briefing && briefing.digest.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>📚</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionFav')}</Text>
              </View>
              {briefing.digest.map((text, i) => (
                <View key={i} className={styles.digestItem}>
                  <Text className={styles.digestText}>{text}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {briefing?.intel?.intelItems && briefing.intel.intelItems.length > 0 ? (
            <View className={styles.section}>
              <View className={styles.sectionHeader}>
                <Text className={styles.sectionIcon}>🌐</Text>
                <Text className={styles.sectionTitle}>{t('briefing.sectionIntel')}</Text>
              </View>
              {briefing.intel.weather ? (
                <View className={styles.digestItem}>
                  <View className={styles.weatherRow}>
                    <Text className={styles.digestText}>🌤 {briefing.intel.weather.text}</Text>
                    {!isWeapp ? (
                      <Text className={styles.locateBtn} onClick={handleLocate}>
                        {locating ? t('briefing.locating') : t('briefing.locateBtn')}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ) : null}
              {briefing.intel.intelItems.map((item, i) => (
                <View key={i} className={styles.digestItem}>
                  <Text className={styles.digestText}>{item.text}</Text>
                  <Text className={styles.digestSource}>来源：{item.source}</Text>
                </View>
              ))}
              <Text className={styles.intelNote}>
                {briefing.intel.degraded ? t('briefing.intelRawNote') : t('briefing.aiTag')}
              </Text>
            </View>
          ) : null}
        </>
      )}

      <View className={styles.subscribeTip}>
        <Text className={styles.tipIcon}>☀️</Text>
        <Text className={styles.tipText}>{t('briefing.subscribeHint', { time: profile?.briefingTime || '07:30' })}</Text>
        <Button className={styles.tipAction} onClick={handleSubscribe}>
          {t('briefing.subscribe')}
        </Button>
      </View>

      <View className={styles.usageHint}>
        {usage && usage.voiceQuota > 0
          ? t('briefing.voiceQuota', { used: usage.voiceUsed, total: usage.voiceQuota })
          : t('briefing.subscribedVoice')}
      </View>

      {messages.length > 0 ? (
        <React.Fragment>
          <ScrollView scrollY scrollIntoView={lastMsgId} className={styles.messages}>
            {messages.map((msg) => (
              <View key={msg.id} id={msg.id} className={classnames(styles.messageRow, msg.role === 'user' && styles.user)}>
                <View className={classnames(styles.bubble, msg.role === 'user' ? styles.user : styles.assistant)}>
                  {msg.type === 'voice' ? <Text className={styles.voiceTag}>🎙 </Text> : null}
                  {msg.deep ? <Text className={styles.deepTag}>🧠 深思 </Text> : null}
                  <Text>{msg.content}</Text>
                  {/* AI 发图（F25）：点击全屏预览 */}
                  {msg.image ? (
                    <Image
                      src={msg.image}
                      mode='aspectFill'
                      lazyLoad
                      className={styles.msgImage}
                      onClick={() => previewImage(msg.image as string)}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </ScrollView>
          <Text className={styles.aiGeneratedTag}>{t('briefing.aiTag')}</Text>
        </React.Fragment>
      ) : (
        <View className={styles.chatEmpty}>
          <Text className={styles.chatHint}>{t('briefing.chatHint')}</Text>
        </View>
      )}

      <View className={classnames(styles.inputBar, isH5 && styles.h5Fix, isH5 && 'h5Fixed')}>
        {inputText === '' ? (
          <View className={styles.quickRow}>
            {QUICK_COMMANDS.map((cmd) => (
              <View key={cmd.labelKey} className={styles.quickChip} onClick={() => setInputText(cmd.text)}>
                <Text className={styles.quickChipIcon}>{cmd.icon}</Text>
                <Text className={styles.quickChipLabel}>{t(cmd.labelKey)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View className={styles.inputRow}>
          <Button
            className={classnames(styles.modeButton, deepMode && styles.modeActive)}
            onClick={() => setDeepMode((v) => !v)}
            aria-label={t('briefing.deepToggle')}
          >
            🧠
          </Button>
          <Input
            className={styles.textInput}
            value={inputText}
            placeholder={deepMode ? t('briefing.deepPlaceholder') : t('briefing.inputPlaceholder')}
            onInput={(e) => setInputText(e.detail.value)}
            confirmType='send'
            onConfirm={handleSendText}
          />
          {inputText ? (
            <View className={styles.clearButton} onClick={() => setInputText('')}>
              ✕
            </View>
          ) : null}
          <VoiceButton compact disabled={sending} onResult={handleVoiceResult} />
          <Button className={styles.sendButton} onClick={handleSendText} disabled={sending}>
            {t('ai.send')}
          </Button>
        </View>
      </View>

      {/* H5 首启合规同意层：未同意前阻断使用（仅网页端渲染） */}
      {showConsent ? (
        <View className={styles.consentMask}>
          <View className={styles.consentPanel}>
            <Text className={styles.consentTitle}>服务协议与隐私政策</Text>
            {consentDeclined ? (
              <View className={styles.consentDeclinedBox}>
                <Text className={styles.consentDeclinedText}>
                  你未同意上述协议，暂时无法使用本服务。
                  {'\n'}如改变主意，可点击下方「同意并继续」。
                </Text>
              </View>
            ) : (
              <ScrollView scrollY className={styles.consentBody}>
                <Text className={styles.consentText}>{PRIVACY_TEXT}</Text>
                <Text className={styles.consentText}>{'\n\n'}</Text>
                <Text className={styles.consentText}>{TERMS_TEXT}</Text>
                <Text className={styles.consentText}>{'\n\n'}</Text>
                <Text className={styles.consentText}>{AI_SERVICES_TEXT}</Text>
              </ScrollView>
            )}
            <Text className={styles.consentHint}>继续使用前，请阅读并同意以上协议</Text>
            <View className={styles.consentActions}>
              <Button className={styles.consentDecline} onClick={handleConsentDecline}>
                不同意
              </Button>
              <Button className={styles.consentAgree} onClick={handleConsentAgree}>
                同意并继续
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default BriefingPage;
