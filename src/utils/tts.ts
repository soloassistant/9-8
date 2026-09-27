/**
 * 音频晨报 TTS 工具（F20）：整份晨报转语音播报，≤3 分钟。
 * - H5：Web Speech API（SpeechSynthesis），逐句合成避免长文本卡死
 * - 微信端：同声传译插件 textToSpeech（单次约 1024 字节上限，分块请求）→
 *   InnerAudioContext 顺序播放队列；插件未配置时 onError 降级提示
 * 全局单播放通道：再次 start 会先停掉上一次。
 *
 * v1.2 增量（A2 批次）：
 * - V-05 语速可传参，范围 0.9–1.1，默认 1.0，越界 clamp + console.warn；
 * - V-06 分块播报之间插入 300ms 静默（H5 setTimeout / weapp onEnded 后延时）；
 * - V-07 场景音色表（晨报 / 资讯 / 跟读 / 夜间），显式 rate/pitch 优先于场景表；
 * - 微信端同声传译插件无 rate/pitch 参数：静默忽略并继续播报，不报错不阻断。
 *
 * v1.3 增量（P0-2 合规硬门槛，2025-09-01 强制施行）：
 * - 音频属法规明确的「生成合成内容」，补齐**显式标识**（播报开头插入 ai.audioIntro 语音前导声明）
 *   与**隐式标识**（H5 写入 utterance 元数据 + 文件名标记；微信端写本地审计供溯源）；
 * - 显式标识默认跟随场景：briefing/news/night 开启，learning 关闭（详见 shouldDiscloseAudio 注释）；
 * - 可用 `opts.audioLabel === false` 显式关闭，供学习模块等非对外内容场景透传；
 * - 标识写入全程 try/catch，任何失败仅 console.warn，**绝不阻断播报**。
 */
import Taro from '@tarojs/taro';
import {
  buildAiMeta,
  buildAudioDisclosure,
  shouldDiscloseAudio,
  markAudioName,
  serializeAiMeta,
  recordAudioTraceWithCount
} from '@/utils/aiLabel';
import { dict, useLanguageStore } from '@/store/language';

/**
 * 取音频前导声明文案（tts 无 React 上下文，此处读 store 当前语言 + 字典取值）。
 * 取值失败时返回空串——宁可少念一句声明，也不能因翻译缺失阻断播报（合规声明另有隐式标识兜底）。
 */
function resolveAudioIntroText(): string {
  try {
    const key = buildAudioDisclosure();
    const lang = useLanguageStore.getState().lang;
    return dict[lang][key] ?? dict.zh[key] ?? '';
  } catch (err) {
    console.warn('[tts] resolve audio intro failed:', err);
    return '';
  }
}

const isWeapp = process.env.TARO_ENV === 'weapp';

/** 分块上限（字）：微信 TTS 单次约 1024 字节，中文 3 字节/字，110 字留足余量 */
const CHUNK_SIZE = 110;

/** TTS 全局常量（禁止魔法数字；D1「我的」页设置项 UI 直接引用） */
export const TTS = {
  /** V-06 分块之间的静默间隔（ms） */
  GAP_MS: 300,
  /** V-05 语速下限 */
  RATE_MIN: 0.9,
  /** V-05 语速上限 */
  RATE_MAX: 1.1,
  /** V-05 默认语速（原硬编码 1.05 已改为 1.0） */
  RATE_DEFAULT: 1.0
} as const;

export interface TtsCallbacks {
  onEnd?: () => void;
  onError?: (message: string) => void;
}

/** 播报语种（学习模块按课程语种选音） */
export type TtsLang = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR';

/** V-07 播报场景：晨报 / 资讯 / 学习跟读 / 夜间（与 i18n `tts.sceneLearning` 对齐） */
export type TtsScene = 'briefing' | 'news' | 'learning' | 'night';

/** 音色档：语速 + 音调（+ 语言标签） */
export interface TtsVoiceProfile {
  /** 语速：场景表 / 设置项产出值落在 0.9–1.1；调用方显式传入值原样透传 */
  rate: number;
  /** H5 pitch；weapp 无此能力时忽略 */
  pitch: number;
  /** 语言标签 */
  lang: string;
}

/** V-07 场景 → 音色映射表；夜间由调用方按小时判定后传入 */
export const TTS_SCENE_PROFILE: Record<TtsScene, TtsVoiceProfile> = {
  briefing: { rate: 1.0, pitch: 1.0, lang: 'zh-CN' },
  news: { rate: 1.05, pitch: 1.1, lang: 'zh-CN' },
  learning: { rate: 0.9, pitch: 1.0, lang: 'zh-CN' },
  night: { rate: 0.9, pitch: 0.9, lang: 'zh-CN' }
};

/** V-05 语速三档（「我的」页设置项用，与 TTS.RATE_MIN/DEFAULT/MAX 对齐） */
export const TTS_RATE_OPTIONS: Array<{ id: 'slow' | 'standard' | 'fast'; rate: number }> = [
  { id: 'slow', rate: TTS.RATE_MIN },
  { id: 'standard', rate: TTS.RATE_DEFAULT },
  { id: 'fast', rate: TTS.RATE_MAX }
];

/** 音色策略：auto=跟随场景（默认） / fixed=用户固定音色 */
export type TtsVoiceMode = 'auto' | 'fixed';

/** 播报选项：语种 + 场景音色（显式 rate/pitch 优先于场景表） */
export interface TtsOptions {
  lang?: TtsLang;
  /**
   * V-05 语速。优先级：显式传入 rate（**原样透传，不钳制、不 warn**）
   * > 场景表 / 设置项产出值（落在 0.9–1.1，越界才收敛）。
   * 显式值不钳制的原因：听力 / 跟读等既有调用方会传 0.6 做慢速播放，
   * 属既有行为，不得被静默收敛（与 `opts.lang > 场景默认 lang > 'zh-CN'` 同构）。
   */
  rate?: number;
  /** V-07：音调，缺省取场景表；weapp 无此能力时忽略 */
  pitch?: number;
  /** V-07：场景，缺省 briefing */
  scene?: TtsScene;
  /** 音色策略，缺省取持久化偏好（auto） */
  voiceMode?: TtsVoiceMode;
  /** V-06：块间静默，缺省 TTS.GAP_MS */
  gapMs?: number;
  /**
   * P0-2 音频显式标识开关（默认跟随场景：briefing/news/night 开启，learning 关闭）。
   * - 晨报 / 资讯 / 夜间播报属「向公众提供生成合成内容」，**必须**在首块内容前播报前导声明；
   * - 学习模块逐词 / 跟读发音属学习工具发音，非对外内容，且插入前导声明会严重破坏体验，
   *   故 learning 默认关闭；如需强制开启可显式传 true。
   */
  audioLabel?: boolean;
}

/** 微信同声传译插件 TTS 仅支持中英；其余语种在 weapp 端不支持发音 */
const WEAPP_TTS_LANGS: Record<TtsLang, 'zh_CN' | 'en_US' | null> = {
  'zh-CN': 'zh_CN',
  'en-US': 'en_US',
  'ja-JP': null,
  'ko-KR': null
};

/** TTS 偏好持久化 key（设计文档第六章 A：归属 utils/tts.ts） */
const TTS_PREFS_KEY = 'mb_tts_voice';

/** TTS 偏好：固定音色模式下的语速 + 音色策略 */
export interface TtsPrefs {
  /** 固定音色模式下的语速，0.9–1.1 */
  rate: number;
  /** auto=跟随场景 / fixed=用户固定音色 */
  voiceMode: TtsVoiceMode;
}

/** 默认偏好：跟随场景 + 标准语速 */
export const TTS_PREFS_DEFAULT: TtsPrefs = {
  rate: TTS.RATE_DEFAULT,
  voiceMode: 'auto'
};

/** 当前端是否支持目标语种发音（不支持时 UI 应隐藏发音按钮并提示） */
export function isTtsLangSupported(lang: TtsLang): boolean {
  if (!isWeapp) {
    // H5 依赖系统语音包，主流 WebView 对英日韩均有内置音；不支持时 startSpeak 会 onError 提示
    return true;
  }
  return WEAPP_TTS_LANGS[lang] !== null;
}

/**
 * V-05 语速收敛到 0.9–1.1，越界 console.warn（不抛错、不阻断播报）。
 * ⚠️ 只用于「设置项 / 场景表产出」的 rate：
 * - `saveTtsPrefs` / `getTtsPrefs`（「我的」页三档设置项）
 * - `resolveVoiceProfile` 中来自场景表 / 固定音色的值
 * 调用方在 `startSpeak(..., { rate })` 里显式传入的 rate **不走这里**，原样透传。
 */
export function clampRate(rate: number): number {
  if (typeof rate !== 'number' || !isFinite(rate)) return TTS.RATE_DEFAULT;
  if (rate < TTS.RATE_MIN) {
    console.warn(`[tts] rate ${rate} 低于下限 ${TTS.RATE_MIN}，已收敛`);
    return TTS.RATE_MIN;
  }
  if (rate > TTS.RATE_MAX) {
    console.warn(`[tts] rate ${rate} 高于上限 ${TTS.RATE_MAX}，已收敛`);
    return TTS.RATE_MAX;
  }
  return rate;
}

/** 读取 TTS 偏好（无记录 / 读失败返回默认：跟随场景 + 标准语速） */
export function getTtsPrefs(): TtsPrefs {
  try {
    const raw = Taro.getStorageSync(TTS_PREFS_KEY);
    if (raw && typeof raw === 'object') {
      const parsed = raw as Partial<TtsPrefs>;
      const rate = typeof parsed.rate === 'number' ? clampRate(parsed.rate) : TTS.RATE_DEFAULT;
      const voiceMode: TtsVoiceMode = parsed.voiceMode === 'fixed' ? 'fixed' : 'auto';
      return { rate, voiceMode };
    }
  } catch (err) {
    console.warn('[tts] read prefs failed:', err);
  }
  return { ...TTS_PREFS_DEFAULT };
}

/** 写入 TTS 偏好（局部更新；未传字段沿用旧值），返回写入后的完整偏好 */
export function saveTtsPrefs(patch: Partial<TtsPrefs>): TtsPrefs {
  const prev = getTtsPrefs();
  const next: TtsPrefs = {
    rate: typeof patch.rate === 'number' ? clampRate(patch.rate) : prev.rate,
    voiceMode: patch.voiceMode === 'fixed' ? 'fixed' : patch.voiceMode === 'auto' ? 'auto' : prev.voiceMode
  };
  try {
    Taro.setStorageSync(TTS_PREFS_KEY, next);
  } catch (err) {
    console.warn('[tts] save prefs failed:', err);
  }
  return next;
}

/**
 * V-07 解析最终音色：
 * - voiceMode='fixed'：忽略场景，用持久化的固定语速（音调 1.0）；
 * - voiceMode='auto'：取场景表（缺省 briefing）；
 * - 场景表 / 设置项产出的 rate 落在 0.9–1.1（越界收敛）；
 * - 调用方显式传入的 rate **原样透传、不钳制**（如听力 / 跟读慢速 0.6 属既有行为）。
 */
export function resolveVoiceProfile(
  scene: TtsScene | undefined,
  voiceMode: TtsVoiceMode = 'auto',
  rate?: number
): TtsVoiceProfile {
  const sceneKey: TtsScene = scene ?? 'briefing';
  const sceneProfile = TTS_SCENE_PROFILE[sceneKey];
  const base: TtsVoiceProfile =
    voiceMode === 'fixed'
      ? { rate: clampRate(getTtsPrefs().rate), pitch: 1.0, lang: 'zh-CN' }
      : {
          rate: clampRate(sceneProfile.rate),
          pitch: sceneProfile.pitch,
          lang: sceneProfile.lang
        };
  // 优先级：显式传入 rate（不钳制） > 场景表 / 固定音色 rate
  const finalRate = typeof rate === 'number' && isFinite(rate) ? rate : base.rate;
  return { rate: finalRate, pitch: base.pitch, lang: base.lang };
}

/** 由小时数推断场景：22:00–07:00 → night，其余沿用 fallback */
export function sceneByHour(hour: number, fallback: TtsScene = 'briefing'): TtsScene {
  const h = typeof hour === 'number' && isFinite(hour) && hour >= 0 && hour <= 23 ? hour : new Date().getHours();
  return h >= 22 || h < 7 ? 'night' : fallback;
}

/** 解析本次播报是否附加音频显式标识：显式 opts.audioLabel 优先，缺省跟随场景 */
function resolveAudioLabelOn(opts?: TtsOptions): boolean {
  if (typeof opts?.audioLabel === 'boolean') return opts.audioLabel;
  return shouldDiscloseAudio(opts?.scene);
}

/**
 * 在首个内容块前插入音频显式标识（前导语音声明），返回新块数组。
 * 若前导文案为空（翻译缺失等异常）则原样返回，保证播报不被打断。
 */
function withAudioDisclosure(chunks: string[], opts?: TtsOptions): string[] {
  if (!resolveAudioLabelOn(opts)) return chunks;
  const intro = resolveAudioIntroText();
  if (!intro) return chunks;
  return [intro, ...chunks];
}

/** 按句切分（不依赖正则 lookbehind，兼容低版本 WebView） */
export function splitTtsChunks(text: string): string[] {
  const clean = text.replace(/\s*\n+\s*/g, '。').replace(/([。！？；])+/g, '$1');
  const sentences = clean.split(/([。！？；])/);
  const parts: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const body = (sentences[i] || '').trim();
    const mark = sentences[i + 1] || '';
    if (body) parts.push(body + mark);
  }
  const chunks: string[] = [];
  let buf = '';
  for (const seg of parts) {
    if (buf && (buf + seg).length > CHUNK_SIZE) {
      chunks.push(buf);
      buf = seg;
    } else {
      buf += seg;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

/* ---------------- 全局播放通道状态 ---------------- */

let activeStop: (() => void) | null = null;

/** 停止当前播报（幂等） */
export function stopSpeak() {
  if (activeStop) {
    const fn = activeStop;
    activeStop = null;
    fn();
  }
}

/** 是否正在播报 */
export function isSpeaking(): boolean {
  return activeStop !== null;
}

/* ---------------- H5：Web Speech API ---------------- */

function speakH5(chunks: string[], cb: TtsCallbacks, opts?: TtsOptions) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    cb.onError?.('当前浏览器不支持语音合成');
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  // P0-2 音频显式标识：在首块内容前插入前导语音声明（默认跟随场景，learning 关闭）
  const speakChunks = withAudioDisclosure(chunks, opts);
  // P0-2 音频隐式标识：构造本次播报的标识载荷，写入 utterance 元数据
  const labelOn = resolveAudioLabelOn(opts);
  const meta = buildAiMeta('audio');
  const metaText = serializeAiMeta(meta);
  // V-07 音色解析：显式 rate 原样透传（不钳制）> 场景表 / 固定音色；pitch 同理
  const profile = resolveVoiceProfile(opts?.scene, opts?.voiceMode ?? getTtsPrefs().voiceMode, opts?.rate);
  const pitch = typeof opts?.pitch === 'number' ? opts.pitch : profile.pitch;
  // V-06 块间静默
  const gapMs = typeof opts?.gapMs === 'number' && opts.gapMs >= 0 ? opts.gapMs : TTS.GAP_MS;
  let index = 0;
  let stopped = false;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGap = () => {
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
  };
  const finish = () => {
    clearGap();
    activeStop = null;
    cb.onEnd?.();
  };
  const stop = () => {
    stopped = true;
    clearGap();
    synth.cancel();
    activeStop = null;
  };
  const next = () => {
    if (stopped) return;
    if (index >= speakChunks.length) {
      finish();
      return;
    }
    const utter = new SpeechSynthesisUtterance(speakChunks[index++]);
    utter.lang = opts?.lang || profile.lang || 'zh-CN';
    utter.rate = profile.rate;
    utter.pitch = pitch;
    // P0-2 音频隐式标识（诚实说明）：
    // Web Speech API 的 SpeechSynthesisUtterance 只是浏览器内存里的普通 JS 对象，
    // 它**不会**把任何字段序列化进合成音频，也**不会**传给平台 TTS 引擎，utterance 被 GC 后即消失。
    // 因此下面挂载的属性**不是文件级隐式标识**——H5 端受 Web Speech API 能力所限，无法实现文件级隐式标识。
    // 保留它的真实价值仅为：给本进程内其它代码一个「本次播报为 AI 合成」的运行时标记（如调试/审计）。
    // 合规的真正兜底在别处：weapp 端由 recordAudioTraceWithCount 写本地可查询审计；
    // H5 端目前无文件级落地能力，属诚实的合规降级，不做假实现。
    if (labelOn) {
      try {
        (utter as unknown as Record<string, unknown>).aiLabel = meta;
        (utter as unknown as Record<string, unknown>).aiLabelText = metaText;
        (utter as unknown as Record<string, unknown>).name = markAudioName('speech', meta);
      } catch (err) {
        console.warn('[tts] attach h5 audio label failed:', err);
      }
    }
    utter.onend = () => {
      if (stopped) return;
      // 最后一块播完直接收尾，不再追加停顿
      if (index >= speakChunks.length) {
        finish();
        return;
      }
      clearGap();
      gapTimer = setTimeout(next, gapMs);
    };
    utter.onerror = () => {
      if (!stopped) {
        stop();
        cb.onError?.('语音播报中断');
      }
    };
    synth.speak(utter);
  };
  activeStop = stop;
  next();
}

/* ---------------- 微信端：同声传译插件 TTS + 音频队列 ---------------- */

/** 插件能力限制（无 rate/pitch）只提示一次，避免每次播报刷日志 */
let weappParamLimitLogged = false;

/** 同声传译插件最小接口（插件无官方 d.ts，仅声明实际用到的 textToSpeech） */
interface WechatSITtsPlugin {
  textToSpeech(opts: {
    lang: string;
    tts: boolean;
    content: string;
    success?: (res: { filename?: string; retcode?: number }) => void;
    fail?: (err?: unknown) => void;
  }): void;
}

function speakWeapp(chunks: string[], cb: TtsCallbacks, opts?: TtsOptions) {
  let plugin: WechatSITtsPlugin | null = null;
  try {
    plugin = Taro.requirePlugin('WechatSI');
  } catch (err) {
    console.warn('[tts] WechatSI plugin unavailable:', err);
  }
  if (!plugin || typeof plugin.textToSpeech !== 'function') {
    cb.onError?.('语音合成插件未配置，暂无法播报');
    return;
  }
  // 微信端降级：插件不支持 rate/pitch，静默忽略参数继续播报（PRD Q2 已知限制）
  if (!weappParamLimitLogged && (typeof opts?.rate === 'number' || typeof opts?.pitch === 'number')) {
    weappParamLimitLogged = true;
    console.info('[tts] 微信同声传译插件不支持 rate/pitch，已忽略音色参数按默认音色播报');
  }
  // 语种映射：插件仅支持中英，日语/韩语已在 isTtsLangSupported 前置拦截，这里兜底回中文
  const pluginLang = (opts?.lang && WEAPP_TTS_LANGS[opts.lang]) || 'zh_CN';
  const gapMs = typeof opts?.gapMs === 'number' && opts.gapMs >= 0 ? opts.gapMs : TTS.GAP_MS;
  // P0-2 音频显式标识：微信端文件名由插件返回无法改写，故显式标识靠「前导语音声明」保证；
  // 隐式标识靠「一次播报写一条本地审计」（见下方 traced 标记）。
  const speakChunks = withAudioDisclosure(chunks, opts);
  const queue = [...speakChunks];
  // 本次播报是否附加标识 + 是否已写过审计（一次播报只写一条，不每块写）
  const labelOn = resolveAudioLabelOn(opts);
  let traced = false;
  let audio: Taro.InnerAudioContext | null = null;
  let stopped = false;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGap = () => {
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
  };
  const finish = () => {
    clearGap();
    activeStop = null;
    cb.onEnd?.();
    stop();
  };
  const stop = () => {
    stopped = true;
    clearGap();
    if (audio) {
      try {
        audio.stop();
        audio.destroy();
      } catch (err) {
        /* 已销毁 */
      }
    }
    audio = null;
    activeStop = null;
  };

  const requestNext = () => {
    if (stopped) return;
    const chunk = queue.shift();
    if (chunk === undefined) {
      finish();
      return;
    }
    plugin.textToSpeech({
      lang: pluginLang,
      tts: true,
      content: chunk,
      success: (res: { filename?: string }) => {
        if (stopped) return;
        if (!res || !res.filename) {
          stop();
          cb.onError?.('语音合成失败');
          return;
        }
        // P0-2 音频隐式标识：首次合成成功时写一条本地审计（时间/块数/标识载荷），
        // 使「某次合成确实是 AI 生成」可被查询。只写一次，失败不阻断播报。
        if (labelOn && !traced) {
          traced = true;
          recordAudioTraceWithCount(buildAiMeta('audio'), speakChunks.length);
        }
        audio = Taro.createInnerAudioContext();
        audio.src = res.filename;
        audio.onEnded(() => {
          if (audio) {
            try {
              audio.destroy();
            } catch (err) {
              /* 已销毁 */
            }
            audio = null;
          }
          if (stopped) return;
          // V-06 块间静默：队列还有下一块才插入 300ms 间隔
          if (queue.length === 0) {
            finish();
            return;
          }
          clearGap();
          gapTimer = setTimeout(requestNext, gapMs);
        });
        audio.onError(() => {
          if (!stopped) {
            stop();
            cb.onError?.('音频播放失败');
          }
        });
        audio.play();
      },
      fail: (err: unknown) => {
        console.warn('[tts] textToSpeech fail:', err);
        if (!stopped) {
          stop();
          cb.onError?.('语音合成失败');
        }
      }
    });
  };

  activeStop = stop;
  requestNext();
}

/** 开始播报：自动覆盖上一次未完成的播报；学习模块可传语种/语速，晨报传场景 */
export function startSpeak(chunks: string[], cb: TtsCallbacks = {}, opts?: TtsOptions) {
  stopSpeak();
  if (!chunks.length) {
    cb.onError?.('没有可播报的内容');
    return;
  }
  if (isWeapp) speakWeapp(chunks, cb, opts);
  else speakH5(chunks, cb, opts);
}
