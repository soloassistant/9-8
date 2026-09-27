/**
 * 语音手势状态机（v1.2 · V-01~V-04）
 *
 * 设计约束：
 * 1. **纯函数**：`reduceVoiceGesture(state, event[, ctx])` 同输入必得同输出，不执行任何副作用；
 * 2. **零 Taro 依赖**：本文件不 import 任何运行时 API，可在 Node 环境直接单测；
 * 3. **单一阈值源**：所有时间/距离阈值集中在 `GESTURE`，组件侧禁止再写魔法数字。
 *
 * 状态语义与 PRD 4.1 状态图一一对应，详见文件末尾的 `VOICE_TRANSITIONS`。
 */
import type { LangKey } from '../store/language';

/** 语音手势状态 */
export type VoiceGestureState =
  /** 初始 / 收尾完成：按钮常态 */
  | 'Idle'
  /** touchstart：正在录音 */
  | 'Recording'
  /** touchmove 上移 ≥80px：松手即取消 */
  | 'CancelPending'
  /** touchend(≥500ms) 或到 60s：UI 已切「处理中」，录音仍继续 200ms（V-01 防吞尾音） */
  | 'TailCapture'
  /** 转写成功且时长达标：结果已回传上层 */
  | 'Sent'
  /** 取消态松手 / touchcancel：结果丢弃 */
  | 'Discarded'
  /** 时长 <500ms 或转写为空：不发送 */
  | 'TooShort'
  /** 录音达到 60s 上限：toast 后自动走 TailCapture 收尾 */
  | 'AutoStop';

/** 语音手势事件 */
export type VoiceGestureEvent =
  | { type: 'TOUCH_START'; y: number; t: number }
  | { type: 'TOUCH_MOVE'; y: number; t: number }
  | { type: 'TOUCH_END'; t: number }
  /** 来电 / 手势中断：等同取消，且不 toast（PRD 4.1 边界处理） */
  | { type: 'TOUCH_CANCEL' }
  /** TailCapture 的 200ms 补录计时结束，录音真正 stop 并拿到结果 */
  | { type: 'TAIL_DONE' }
  /** 录音时长达到 60s 上限 */
  | { type: 'TIMEOUT' };

/** 录音阈值常量（QA 回归用例直接引用这组常量，改阈值只改这里） */
export const GESTURE = {
  /** V-01：松手后继续补录的时长 */
  TAIL_CAPTURE_MS: 200,
  /** V-02：上滑判定取消的位移阈值 */
  CANCEL_DISTANCE_PX: 80,
  /** V-03：低于该时长判误触 */
  MIN_DURATION_MS: 500,
  /** V-04：录音上限 */
  MAX_DURATION_MS: 60_000,
  /** V-04：剩余多少毫秒时提示 + 震动 */
  WARN_REMAINING_MS: 10_000
} as const;

/**
 * 手势上下文：reducer 需要它来计算「位移」与「时长」。
 * 由调用方（组件）在 touchstart 时写入，之后只读。
 */
export interface VoiceGestureContext {
  /** touchstart 的 clientY（px） */
  startY: number;
  /** touchstart 时间戳（ms） */
  startAt: number;
}

/** 兜底上下文：未传 ctx 时，位移恒为 0、时长视为超长（不误判 tooShort） */
export const DEFAULT_CONTEXT: VoiceGestureContext = { startY: 0, startAt: 0 };

/** V-02：由起止 Y 坐标判定是否进入取消态（上滑 ≥80px） */
export function isCancelDistance(startY: number, currentY: number): boolean {
  return startY - currentY >= GESTURE.CANCEL_DISTANCE_PX;
}

/** V-03：时长是否达到可发送下限（≥500ms） */
export function isDurationEnough(startAt: number, now: number): boolean {
  return now - startAt >= GESTURE.MIN_DURATION_MS;
}

/** V-04：是否已到 60s 录音上限 */
export function isMaxReached(startAt: number, now: number): boolean {
  return now - startAt >= GESTURE.MAX_DURATION_MS;
}

/** V-04：是否进入「剩余 10 秒」提醒区间 */
export function shouldWarnRemaining(startAt: number, now: number): boolean {
  const remaining = GESTURE.MAX_DURATION_MS - (now - startAt);
  return remaining > 0 && remaining <= GESTURE.WARN_REMAINING_MS;
}

/** 是否处于录音进行中（麦克风仍在采集：含取消待定，此时松手才决定丢弃） */
export function isMicActive(state: VoiceGestureState): boolean {
  return state === 'Recording' || state === 'CancelPending';
}

/** 是否需要展示录音浮层（Idle 与终态不展示） */
export function isOverlayVisible(state: VoiceGestureState): boolean {
  return state === 'Recording' || state === 'CancelPending' || state === 'TailCapture' || state === 'AutoStop';
}

/**
 * 纯函数状态机。
 *
 * @param state 当前状态
 * @param event 手势事件
 * @param ctx 手势上下文（touchstart 的起点与时间）；省略时用 `DEFAULT_CONTEXT`
 * @returns 下一个状态；无关事件返回原状态（幂等，可安全重复派发）
 */
export function reduceVoiceGesture(
  state: VoiceGestureState,
  event: VoiceGestureEvent,
  ctx: VoiceGestureContext = DEFAULT_CONTEXT
): VoiceGestureState {
  switch (state) {
    /* Idle：只认 touchstart；TailCapture 期间重复 touchstart 被忽略（PRD 4.1 边界处理） */
    case 'Idle':
      if (event.type === 'TOUCH_START') return 'Recording';
      return state;

    case 'Recording':
      if (event.type === 'TOUCH_MOVE') {
        return isCancelDistance(ctx.startY, event.y) ? 'CancelPending' : 'Recording';
      }
      if (event.type === 'TOUCH_END') {
        return isDurationEnough(ctx.startAt, event.t) ? 'TailCapture' : 'TooShort';
      }
      if (event.type === 'TOUCH_CANCEL') return 'Discarded';
      if (event.type === 'TIMEOUT') return 'AutoStop';
      return state;

    case 'CancelPending':
      if (event.type === 'TOUCH_MOVE') {
        // 回退到 <80px 自动恢复录音态（V-02）
        return isCancelDistance(ctx.startY, event.y) ? 'CancelPending' : 'Recording';
      }
      if (event.type === 'TOUCH_END' || event.type === 'TOUCH_CANCEL') return 'Discarded';
      if (event.type === 'TIMEOUT') return 'AutoStop';
      return state;

    case 'AutoStop':
      // 60s 到点：与正常松手走同一条收尾链路（先 toast 再自动补录 200ms）
      if (event.type === 'TOUCH_END') return 'TailCapture';
      // 竞态保护：插件在 60s 自行 stop 时，可能早于组件补发的 TOUCH_END 回调
      if (event.type === 'TAIL_DONE') return 'Sent';
      return state;

    case 'TailCapture':
      if (event.type === 'TAIL_DONE') return 'Sent';
      return state;

    /* 终态：等待组件执行副作用后自行复位到 Idle，此间忽略一切手势事件 */
    case 'Sent':
    case 'Discarded':
    case 'TooShort':
      return state;

    default:
      return state;
  }
}

/** 状态 → overlay 文案 key（null = 不展示 overlay） */
export function overlayKey(state: VoiceGestureState): LangKey | null {
  switch (state) {
    case 'Recording': return 'voice.listening';
    case 'CancelPending': return 'voice.cancelHint';
    case 'TailCapture': return 'voice.processing';
    case 'AutoStop': return 'voice.autoSending';
    default: return null;
  }
}

/** 状态转移表（供 QA 回归用例与文档核对，运行期不使用） */
export const VOICE_TRANSITIONS: ReadonlyArray<{
  from: VoiceGestureState;
  event: VoiceGestureEvent['type'];
  to: VoiceGestureState;
  note: string;
}> = [
  { from: 'Idle', event: 'TOUCH_START', to: 'Recording', note: '按住开始录音（C-01 授权通过后才进入）' },
  { from: 'Recording', event: 'TOUCH_MOVE', to: 'CancelPending', note: '上移 ≥80px 进入取消态' },
  { from: 'Recording', event: 'TOUCH_MOVE', to: 'Recording', note: '位移 <80px 维持录音' },
  { from: 'Recording', event: 'TOUCH_END', to: 'TailCapture', note: '≥500ms：补录 200ms 后 stop' },
  { from: 'Recording', event: 'TOUCH_END', to: 'TooShort', note: '<500ms：判误触，不发送' },
  { from: 'Recording', event: 'TOUCH_CANCEL', to: 'Discarded', note: '来电/中断：丢弃且不 toast' },
  { from: 'Recording', event: 'TIMEOUT', to: 'AutoStop', note: '到达 60s 上限' },
  { from: 'CancelPending', event: 'TOUCH_MOVE', to: 'Recording', note: '回退 <80px 恢复录音' },
  { from: 'CancelPending', event: 'TOUCH_END', to: 'Discarded', note: '取消态松手，toast 已取消发送' },
  { from: 'CancelPending', event: 'TOUCH_CANCEL', to: 'Discarded', note: '取消态中断' },
  { from: 'CancelPending', event: 'TIMEOUT', to: 'AutoStop', note: '取消态也受 60s 硬上限约束' },
  { from: 'AutoStop', event: 'TOUCH_END', to: 'TailCapture', note: '到点自动补录 200ms' },
  { from: 'AutoStop', event: 'TAIL_DONE', to: 'Sent', note: '竞态保护：插件自行 stop 先回调' },
  { from: 'TailCapture', event: 'TAIL_DONE', to: 'Sent', note: '拿到转写结果并回传' }
];
