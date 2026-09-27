import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import type { ITouchEvent } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import styles from './index.module.scss';
import { useT } from '@/store/language';
import type { LangKey } from '@/store/language';
import PermissionDialog from '@/components/PermissionDialog';
import {
  ensurePermission,
  isDeniedDegraded,
  openAppSetting,
  recordPermissionResult,
  shouldShowDialog
} from '@/utils/permission';
import {
  GESTURE,
  isDurationEnough,
  isMaxReached,
  isMicActive,
  isOverlayVisible,
  overlayKey,
  reduceVoiceGesture,
  shouldWarnRemaining
} from '@/utils/voiceGesture';
import type { VoiceGestureContext, VoiceGestureEvent, VoiceGestureState } from '@/utils/voiceGesture';

const isWeapp = process.env.TARO_ENV === 'weapp';

/** 同声传译插件识别 manager 最小接口（插件无官方 d.ts，仅声明实际用到的成员） */
interface WechatSISpeechManager {
  onRecognize(cb: (res: { result?: string }) => void): void;
  onStop(cb: (res: { result?: string; transcript?: string }) => void): void;
  onError(cb: (err: { msg?: string; retcode?: number }) => void): void;
  start(opts: { lang?: string; duration?: number }): void;
  stop(): void;
}

/** tick 定时器步长：兼顾「剩余 10s 提醒」与「60s 上限」的及时性 */
const TICK_MS = 500;
/** 手势类 toast 时长（PRD 5.6：取消/误触提示 1.5s） */
const TOAST_MS = 1500;

export interface VoiceResult {
  /** 录音时长（秒） */
  duration: number;
  /** 录音临时文件路径（仅微信端降级路径） */
  tempFilePath?: string;
  /** ASR 转写文本：微信端走同声传译插件时返回；插件未配置的降级路径与 H5 mock 无此字段 */
  transcript?: string;
  /** 用户是否正常松开（false = 滑动取消 / touchcancel） */
  confirmed: boolean;
}

interface VoiceButtonProps {
  disabled?: boolean;
  /** 紧凑模式：仅图标方块，用于嵌入单行输入栏 */
  compact?: boolean;
  /** 识别语种：默认中文；英语跟读场景传 en_US（同声传译插件仅支持中英） */
  asrLang?: 'zh_CN' | 'en_US';
  onResult: (result: VoiceResult) => void;
}

type TimerId = ReturnType<typeof setTimeout>;

/**
 * 按住说话按钮（v1.2 · V-01~V-04 + C-01）
 *
 * 微信端优先用「微信同声传译」插件边录边识别（transcript 直接可用）；
 * 插件未添加/加载失败时降级为 RecorderManager 纯录音（上层据此提示未配置）；
 * 其他平台（H5 预览）模拟录音时长，由上层走 mock 转写。
 *
 * 交互核心：UI 由 `utils/voiceGesture` 的纯函数状态机驱动，组件只负责
 * 「派发事件 + 执行副作用（录音启停 / toast / 震动 / 结果回调）」。
 */
export default function VoiceButton({ disabled = false, compact = false, asrLang = 'zh_CN', onResult }: VoiceButtonProps) {
  const t = useT();

  /** 手势状态机当前状态（UI 唯一数据源） */
  const [phase, setPhase] = useState<VoiceGestureState>('Idle');
  /** 剩余 10s 文案开关（仅 Recording 态生效） */
  const [tenLeft, setTenLeft] = useState(false);
  /** C-01：麦克风独立授权说明弹窗 */
  const [permVisible, setPermVisible] = useState(false);
  /** C-01：≥3 次拒绝后的轻量提示条 + 去设置 */
  const [guideVisible, setGuideVisible] = useState(false);

  const phaseRef = useRef<VoiceGestureState>('Idle');
  const startYRef = useRef<number>(0);
  const startAtRef = useRef<number>(0);
  const touchingRef = useRef<boolean>(false);
  /** 授权弹窗期间的用户 CR 起点授权后是否仍按住，决定是否补一次录音启动 */
  const pendingStartRef = useRef<{ y: number; t: number } | null>(null);
  /** 是否丢弃本次结果（取消 / 误触 / 出错） */
  const discardRef = useRef<boolean>(false);
  /** 剩余 10s 是否已提醒过（每轮录音只提醒一次） */
  const warnFiredRef = useRef<boolean>(false);
  /** V-01 的 200ms 补录定时器 */
  const tailTimerRef = useRef<TimerId | null>(null);
  /** 倒计时 tick 定时器 */
  const tickTimerRef = useRef<TimerId | null>(null);
  /** 组件卸载标记：抑制卸载后异步回调里的 toast 与 onResult */
  const unmountedRef = useRef(false);
  const recorderRef = useRef<Taro.RecorderManager | null>(null);
  // 同声传译插件识别 manager（weapp；null = 插件不可用，走纯录音降级）
  const pluginRef = useRef<WechatSISpeechManager | null>(null);
  // onResult 用 ref 转发：避免插件事件注册一次后捕获到过期闭包（额度/状态读取错误）
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  const clearTimers = useCallback(() => {
    if (tailTimerRef.current !== null) {
      clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  /** 回到 Idle（终态由组件复位：reducer 本身不产出 Idle） */
  const resetToIdle = useCallback(() => {
    clearTimers();
    startYRef.current = 0;
    startAtRef.current = 0;
    warnFiredRef.current = false;
    discardRef.current = false;
    setTenLeft(false);
    if (phaseRef.current !== 'Idle') {
      phaseRef.current = 'Idle';
      setPhase('Idle');
    }
  }, [clearTimers]);

  const showToast = useCallback((key: LangKey, duration: number = TOAST_MS) => {
    if (unmountedRef.current) return;
    try {
      Taro.showToast({ title: t(key), icon: 'none', duration });
    } catch (err) {
      console.warn('[VoiceButton] showToast failed:', err);
    }
  }, [t]);

  /** V-04：轻震动（H5 无此能力 → 守卫后 no-op，绝不抛错） */
  const vibrateOnce = useCallback(() => {
    if (typeof Taro.vibrateShort !== 'function') return;
    try {
      void Taro.vibrateShort({ type: 'medium' });
    } catch (err) {
      console.warn('[VoiceButton] vibrate unsupported:', err);
    }
  }, []);

  const gestureCtx = useCallback((): VoiceGestureContext => ({
    startY: startYRef.current,
    startAt: startAtRef.current
  }), []);

  /** 派发手势事件：reducer 决定下一状态，组件随后执行副作用 */
  const dispatch = useCallback((event: VoiceGestureEvent): VoiceGestureState => {
    const next = reduceVoiceGesture(phaseRef.current, event, gestureCtx());
    phaseRef.current = next;
    setPhase(next);
    return next;
  }, [gestureCtx]);

  /* ------------------------------------------------------------------ */
  /* 录音引擎（weapp 插件 / 纯录音降级 / H5 空实现）                       */
  /* ------------------------------------------------------------------ */

  const startEngine = useCallback(() => {
    if (!isWeapp) return;
    try {
      if (pluginRef.current) {
        pluginRef.current.start({ lang: asrLang, duration: GESTURE.MAX_DURATION_MS });
      } else if (recorderRef.current) {
        recorderRef.current.start({ duration: GESTURE.MAX_DURATION_MS, format: 'mp3' });
      }
    } catch (err) {
      console.error('[VoiceButton] start engine failed:', err);
    }
  }, [asrLang]);

  const stopEngine = useCallback(() => {
    if (!isWeapp) return;
    try {
      if (pluginRef.current) {
        pluginRef.current.stop();
        return;
      }
      if (recorderRef.current) {
        recorderRef.current.stop();
      }
    } catch (err) {
      console.warn('[VoiceButton] stop engine failed:', err);
    }
  }, []);

  /* ------------------------------------------------------------------ */
  /* 结果回传                                                            */
  /* ------------------------------------------------------------------ */

  /** 统一出口：只有非丢弃链路才回传结果 */
  const deliver = useCallback((transcript?: string, tempFilePath?: string) => {
    if (unmountedRef.current || discardRef.current) return;
    const duration = Math.round((Date.now() - startAtRef.current) / 1000);
    const result: VoiceResult = { duration, confirmed: true };
    if (typeof transcript === 'string') result.transcript = transcript;
    if (typeof tempFilePath === 'string') result.tempFilePath = tempFilePath;
    onResultRef.current(result);
  }, []);

  /* ------------------------------------------------------------------ */
  /* 补录定时器（V-01 核心）                                              */
  /* ------------------------------------------------------------------ */

  /**
   * TailCapture 阶段：UI 已切「处理中」，但**不立即 stop**，
   * 延迟 GESTURE.TAIL_CAPTURE_MS 再停，把尾音补进本次录音。
   */
  const scheduleTailStop = useCallback(() => {
    if (tailTimerRef.current !== null) {
      clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    }
    tailTimerRef.current = setTimeout(() => {
      tailTimerRef.current = null;
      if (unmountedRef.current) return;
      stopEngine();
      // H5 / 插件不可用：没有 onStop 回调，补录结束后自行合成结果
      if (!isWeapp || (!pluginRef.current && !recorderRef.current)) {
        const elapsed = Date.now() - startAtRef.current;
        if (!isDurationEnough(startAtRef.current, Date.now())) {
          showToast('voice.tooShort', TOAST_MS);
          resetToIdle();
          return;
        }
        dispatch({ type: 'TAIL_DONE' });
        // 保留既有 H5 行为：模拟时长至少 2 秒，转写由上层 mock
        onResultRef.current({ duration: Math.max(2, Math.round(elapsed / 1000)), confirmed: true });
        resetToIdle();
      }
    }, GESTURE.TAIL_CAPTURE_MS);
  }, [dispatch, resetToIdle, showToast, stopEngine]);

  /* ------------------------------------------------------------------ */
  /* tick：10s 提醒 + 60s 上限                                            */
  /* ------------------------------------------------------------------ */

  const startTick = useCallback(() => {
    if (tickTimerRef.current !== null) clearInterval(tickTimerRef.current);
    tickTimerRef.current = setInterval(() => {
      if (unmountedRef.current || !isMicActive(phaseRef.current)) {
        clearTimers();
        return;
      }
      const now = Date.now();
      // V-04：到达 60s → 与正常松手同链路收尾（含 200ms 补录）
      if (isMaxReached(startAtRef.current, now)) {
        clearTimers();
        dispatch({ type: 'TIMEOUT' });
        showToast('voice.autoStop', TOAST_MS);
        vibrateOnce();
        if (unmountedRef.current) return;
        discardRef.current = false;
        dispatch({ type: 'TOUCH_END', t: now });
        scheduleTailStop();
        return;
      }
      // V-04：剩余 ≤10s 时切换文案并震动一次
      if (!warnFiredRef.current && shouldWarnRemaining(startAtRef.current, now)) {
        warnFiredRef.current = true;
        setTenLeft(true);
        vibrateOnce();
      }
    }, TICK_MS);
  }, [clearTimers, dispatch, scheduleTailStop, showToast, vibrateOnce]);

  /* ------------------------------------------------------------------ */
  /* 录音启动（含 C-01 权限门）                                           */
  /* ------------------------------------------------------------------ */

  const startRecording = useCallback((y: number, now: number) => {
    startYRef.current = y;
    startAtRef.current = now;
    warnFiredRef.current = false;
    discardRef.current = false;
    setTenLeft(false);
    dispatch({ type: 'TOUCH_START', y, t: now });
    startTick();
    startEngine();
  }, [dispatch, startEngine, startTick]);

  /**
   * 一次按压的完整入口：先过 C-01 麦克风权限，再进录音。
   * 弹窗只在「功能触发时」（点击语音按钮）出现，App 启动不弹。
   */
  const beginGesture = useCallback(async (y: number, now: number) => {
    setGuideVisible(false);
    if (shouldShowDialog('microphone')) {
      // 首次 / 未同意且未降级：先弹应用内说明弹窗
      pendingStartRef.current = { y, t: now };
      setPermVisible(true);
      return;
    }
    const granted = await ensurePermission('microphone');
    recordPermissionResult('microphone', granted);
    if (!granted) {
      if (isDeniedDegraded('microphone')) setGuideVisible(true);
      return;
    }
    if (unmountedRef.current) return;
    startRecording(y, now);
  }, [startRecording]);

  const handleTouchStart = useCallback((e: ITouchEvent) => {
    touchingRef.current = true;
    if (disabled) return;
    // PRD 4.1 边界：TailCapture 等非 Idle 状态不可重入
    if (phaseRef.current !== 'Idle') return;
    const touch = e.touches && e.touches[0];
    const y = touch ? touch.clientY : 0;
    void beginGesture(y, Date.now());
  }, [beginGesture, disabled]);

  const handleTouchMove = useCallback((e: ITouchEvent) => {
    if (!isMicActive(phaseRef.current)) return;
    const touch = e.touches && e.touches[0];
    const y = touch ? touch.clientY : startYRef.current;
    dispatch({ type: 'TOUCH_MOVE', y, t: Date.now() });
  }, [dispatch]);

  const handleTouchEnd = useCallback(() => {
    touchingRef.current = false;
    if (!isMicActive(phaseRef.current)) return;
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    setTenLeft(false);
    const next = dispatch({ type: 'TOUCH_END', t: Date.now() });
    switch (next) {
      // V-03：<500ms 判误触，不发送、不回调
      case 'TooShort':
        discardRef.current = true;
        stopEngine();
        showToast('voice.tooShort', TOAST_MS);
        resetToIdle();
        break;
      // V-02：取消态松手，丢弃结果
      case 'Discarded':
        discardRef.current = true;
        stopEngine();
        showToast('voice.cancelSent', TOAST_MS);
        resetToIdle();
        break;
      // V-01：UI 已切「处理中」，录音继续 200ms
      case 'TailCapture':
        discardRef.current = false;
        scheduleTailStop();
        break;
      default:
        clearTimers();
        resetToIdle();
        break;
    }
  }, [clearTimers, dispatch, resetToIdle, scheduleTailStop, showToast, stopEngine]);

  const handleTouchCancel = useCallback(() => {
    touchingRef.current = false;
    if (!isMicActive(phaseRef.current)) return;
    clearTimers();
    dispatch({ type: 'TOUCH_CANCEL' });
    // PRD 4.1 边界：touchcancel 丢弃结果且**不 toast**（避免打断来电等场景）
    discardRef.current = true;
    stopEngine();
    resetToIdle();
  }, [clearTimers, dispatch, resetToIdle, stopEngine]);

  /* ------------------------------------------------------------------ */
  /* C-01：弹窗 / 提示条交互                                              */
  /* ------------------------------------------------------------------ */

  const handlePermAgree = useCallback(async () => {
    setPermVisible(false);
    const granted = await ensurePermission('microphone');
    recordPermissionResult('microphone', granted);
    const pending = pendingStartRef.current;
    pendingStartRef.current = null;
    if (!granted) {
      if (isDeniedDegraded('microphone')) setGuideVisible(true);
      return;
    }
    if (unmountedRef.current) return;
    // 手指仍按住才补一次启动；已松开则等下一次按压（此时已同意，不会再弹窗）
    if (pending && touchingRef.current) startRecording(pending.y, pending.t);
  }, [startRecording]);

  const handlePermDecline = useCallback(() => {
    setPermVisible(false);
    pendingStartRef.current = null;
    recordPermissionResult('microphone', false);
    if (isDeniedDegraded('microphone')) setGuideVisible(true);
  }, []);

  const handleOpenSetting = useCallback(async () => {
    await openAppSetting('microphone');
    setGuideVisible(false);
  }, []);

  /* ------------------------------------------------------------------ */
  /* weapp：插件 / 纯录音初始化                                           */
  /* ------------------------------------------------------------------ */

  /** 降级路径：纯录音（无转写），上层收到无 transcript 的结果 */
  const initFallbackRecorder = () => {
    try {
      const recorder = Taro.getRecorderManager();
      recorder.onStop((res) => {
        if (unmountedRef.current || discardRef.current) return;
        if (!isDurationEnough(startAtRef.current, Date.now())) {
          showToast('voice.tooShort', TOAST_MS);
          resetToIdle();
          return;
        }
        dispatch({ type: 'TAIL_DONE' });
        // 竞态：插件在 60s 自行 stop 时可能早于 tick 判定，此处补 toast
        if (isMaxReached(startAtRef.current, Date.now())) showToast('voice.autoStop', TOAST_MS);
        deliver(undefined, res && res.tempFilePath);
        resetToIdle();
      });
      recorder.onError((err) => {
        console.error('[VoiceButton] recorder error:', err);
        if (unmountedRef.current || discardRef.current) return;
        discardRef.current = true;
        clearTimers();
        resetToIdle();
        showToast('voice.recordFail', TOAST_MS);
      });
      recorderRef.current = recorder;
    } catch (err) {
      console.error('[VoiceButton] init recorder failed:', err);
    }
  };

  useEffect(() => {
    if (!isWeapp) return;
    unmountedRef.current = false;
    // 优先探测同声传译插件（需在小程序后台添加「微信同声传译」后生效）
    try {
      const manager = Taro.requirePlugin('WechatSI').getRecordRecognitionManager() as WechatSISpeechManager;
      pluginRef.current = manager;
      manager.onRecognize((res: { result?: string }) => {
        // 中间识别结果：仅留调试日志，不驱动 UI
        if (res && res.result) console.debug('[VoiceButton] recognize:', res.result);
      });
      manager.onStop((res: { result?: string; transcript?: string }) => {
        if (unmountedRef.current || discardRef.current) return;
        if (!isDurationEnough(startAtRef.current, Date.now())) {
          showToast('voice.tooShort', TOAST_MS);
          resetToIdle();
          return;
        }
        const transcript = String((res && (res.transcript || res.result)) || '').trim();
        if (!transcript) {
          clearTimers();
          resetToIdle();
          showToast('voice.noCatch', TOAST_MS);
          return;
        }
        clearTimers();
        dispatch({ type: 'TAIL_DONE' });
        // 竞态：插件在 60s 自行 stop 时可能早于 tick 判定，此处补 toast
        if (isMaxReached(startAtRef.current, Date.now())) showToast('voice.autoStop', TOAST_MS);
        deliver(transcript);
        resetToIdle();
      });
      manager.onError((err: { msg?: string; retcode?: number }) => {
        console.error('[VoiceButton] recognize error:', err);
        if (unmountedRef.current || discardRef.current) return;
        discardRef.current = true;
        clearTimers();
        resetToIdle();
        showToast('voice.asrFail', TOAST_MS);
      });
    } catch (err) {
      console.warn('[VoiceButton] WechatSI plugin unavailable, fallback to recorder:', err);
      pluginRef.current = null;
      initFallbackRecorder();
    }
    return () => {
      unmountedRef.current = true;
      clearTimers();
      // 卸载时停掉未完成的录音/识别，避免跨页面泄漏
      try {
        pluginRef.current && pluginRef.current.stop();
      } catch {
        /* ignore */
      }
      try {
        recorderRef.current && recorderRef.current.stop();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 200ms 补录定时器必须在卸载时清除，防止跨页面回调 */
  useEffect(() => clearTimers, [clearTimers]);

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  const hintKey: LangKey | null = (() => {
    const base = overlayKey(phase);
    if (base === null) return null;
    if (phase === 'Recording' && tenLeft) return 'voice.tenLeft';
    return base;
  })();

  return (
    <View className={classnames(styles.wrapper, compact && styles.compact)}>
      {hintKey !== null && isOverlayVisible(phase) ? (
        <View className={styles.overlay}>
          <View className={styles.waveRow}>
            {phase === 'CancelPending' ? <Text className={styles.trash}>🗑</Text> : null}
            <View
              className={classnames(
                styles.wave,
                phase === 'CancelPending' && styles.waveCancel,
                (phase === 'TailCapture' || phase === 'AutoStop') && styles.waveTail
              )}
            />
          </View>
          <Text className={classnames(styles.overlayText, phase === 'CancelPending' && styles.overlayTextCancel)}>
            {t(hintKey)}
          </Text>
        </View>
      ) : null}

      {guideVisible ? (
        <View className={styles.guideBar}>
          <Text className={styles.guideText}>{t('perm.repeatDenied')}</Text>
          <View className={styles.guideAction} onClick={() => void handleOpenSetting()}>
            <Text className={styles.guideActionText}>{t('perm.goSettings')}</Text>
          </View>
        </View>
      ) : null}

      <View
        className={classnames(
          styles.button,
          compact && styles.compact,
          isMicActive(phase) && styles.recording,
          (phase === 'TailCapture' || phase === 'AutoStop') && styles.processing,
          disabled && styles.disabled
        )}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        <Text className={styles.mic}>🎙</Text>
        {!compact ? <Text className={styles.label}>{t('voice.holdTip')}</Text> : null}
      </View>

      <PermissionDialog
        visible={permVisible}
        name="microphone"
        onAgree={() => void handlePermAgree()}
        onCancel={handlePermDecline}
      />
    </View>
  );
}
