/**
 * AI 生成合成内容标识工具（P0-2 合规硬门槛）。
 *
 * 法规依据：《人工智能生成合成内容标识办法》+ 强制性国标，2025-09-01 已强制施行。
 * 要求 AI 生成合成内容同时具备：
 * - **显式标识**：用户可直接感知（文本角标 / 音频前导语音声明）；
 * - **隐式标识**：元数据 / 文件内嵌（可被工具解析溯源）。
 *
 * 设计原则：
 * 1. 本文件是标识能力的**单一事实来源**：文案 key、标识载荷、音频前导语、审计写入全部收敛于此；
 * 2. **纯逻辑、可单测、不 import React**；唯一外部依赖是 Taro storage（与项目既有 utils 一致）；
 * 3. 法规为**强制**要求，故**不做开关/关闭能力**，只做「构造 + 序列化 + 落地 + 查询」。
 *
 * 类型就近原则：`AiLabelKind` / `AiLabelMeta` 定义在拥有它的本文件内，不修改冻结的 `src/types/index.ts`。
 */
import Taro from '@tarojs/taro';

/**
 * 标识规范版本号，对齐法规施行日（2025-09-01）。
 * 供「我的」页展示与法务页引用，改标识方案时递增并同步法务文本。
 */
export const AI_LABEL_VERSION = 'v1.0-20260901';

/** 模型供应商标识：隐式标识里用于标注内容由哪个模型产出 */
export const AI_LABEL_VENDOR = 'deepseek';

/** 音频合成隐式标识文件名前缀：使合成音频文件本身可被识别为 AIGC */
export const AI_AUDIO_FILE_PREFIX = 'aigc_';

/** 音频合成审计记录最多保留条数（避免无限增长占满 storage） */
const AUDIO_TRACE_LIMIT = 50;

/** 音频合成审计持久化 key */
const AUDIO_TRACE_KEY = 'mb_ai_audio_trace';

/**
 * 标识内容类型：
 * - text    —— 通用 AI 生成文本（对话回复等）
 * - image   —— AI 生成/选取图片
 * - audio   —— AI 合成语音（TTS 播报）
 * - summary —— AI 摘要 / 精选
 * - extract —— AI 从转发内容中提取整理的结构化结果
 */
export type AiLabelKind = 'text' | 'image' | 'audio' | 'summary' | 'extract';

/** 隐式标识载荷：随内容一并写入元数据 / 审计，供工具或本机解析溯源 */
export interface AiLabelMeta {
  /** 固定为 true，作为「本条为 AI 生成」的显式布尔标记，便于下游快速判定 */
  label: true;
  /** 标识规范版本 */
  version: string;
  /** 内容类型 */
  kind: AiLabelKind;
  /** 模型供应商标识（如 deepseek） */
  vendor: string;
  /** 生成时间戳（ms） */
  createdAt: number;
  /** 可选追踪 id：一次生成链路的唯一标识，便于审计对账 */
  traceId?: string;
}

/** 构造隐式标识载荷（纯函数，唯一入口，保证字段完整） */
export function buildAiMeta(kind: AiLabelKind, opts?: { traceId?: string; createdAt?: number }): AiLabelMeta {
  const meta: AiLabelMeta = {
    label: true,
    version: AI_LABEL_VERSION,
    kind,
    vendor: AI_LABEL_VENDOR,
    createdAt: typeof opts?.createdAt === 'number' ? opts.createdAt : Date.now()
  };
  if (opts?.traceId) meta.traceId = opts.traceId;
  return meta;
}

/**
 * 序列化隐式标识为紧凑 `key=value;` 字符串（供写入元数据）。
 * 选 `key=value` 而非 JSON 的原因：字节更短，便于嵌入音频文件名 / 元数据字段；
 * 值中出现的 `;` / `=` 做转义，避免解析歧义。
 */
export function serializeAiMeta(meta: AiLabelMeta): string {
  const escape = (v: string) => v.replace(/[;=]/g, (c) => (c === ';' ? '%3B' : '%3D'));
  const pairs: string[] = [
    `label=${meta.label ? 1 : 0}`,
    `version=${escape(meta.version)}`,
    `kind=${escape(meta.kind)}`,
    `vendor=${escape(meta.vendor)}`,
    `createdAt=${meta.createdAt}`
  ];
  if (meta.traceId) pairs.push(`traceId=${escape(meta.traceId)}`);
  return pairs.join(';');
}

/**
 * 返回**显式标识文案的 i18n key**（不返回硬编码中文，保证 zh/en 双语）。
 * 组件层用 `useT()(buildExplicitLabel(kind))` 取值即可，禁止在此硬编码文案。
 */
export function buildExplicitLabel(kind: AiLabelKind): 'ai.labelText' | 'ai.labelAudio' | 'ai.labelExtract' | 'ai.labelSummary' {
  switch (kind) {
    case 'audio':
      return 'ai.labelAudio';
    case 'summary':
      return 'ai.labelSummary';
    case 'extract':
      return 'ai.labelExtract';
    // text / image 统一落到通用文本标识
    case 'text':
    case 'image':
    default:
      return 'ai.labelText';
  }
}

/**
 * 判断某播报场景是否必须附加音频显式标识（前导语音声明）。
 *
 * 判断依据（合规口径）：
 * - 法规要求「向公众提供生成合成内容」须显式标识；晨报 / 资讯 / 夜间播报是对外提供的内容产品，**必须标识**；
 * - 学习模块（learning）的单词 / 跟读发音属**学习工具发音**，非向公众提供生成合成内容，
 *   且逐词播报插入前导声明会严重破坏学习体验，同时该内容亦非 AI 生成的知识结论；
 * 故 learning 默认关闭，其余场景默认开启。
 */
export function shouldDiscloseAudio(scene?: string): boolean {
  return scene !== 'learning';
}

/**
 * 音频**显式标识**：返回播报开头必须念出来的那句话（i18n key）。
 * 由 tts.ts 在首块内容前插入，确保「语音里真的被念出来」，而非仅在 UI 上标注。
 */
export function buildAudioDisclosure(): 'ai.audioIntro' {
  return 'ai.audioIntro';
}

/**
 * 音频**隐式标识**：给合成音频文件名加上可识别前缀与版本号，使文件本身可被溯源。
 * 注：微信端文件名由插件返回，无法改写（拿不到控制权），该函数主要用于 H5 / 服务端命名链路。
 */
export function markAudioName(name: string, meta: AiLabelMeta): string {
  const base = typeof name === 'string' && name ? name : 'audio';
  // 幂等守卫：已带 AIGC 前缀的名字直接返回，避免二次调用叠加成 aigc_..._aigc_...
  if (base.startsWith(AI_AUDIO_FILE_PREFIX)) return base;
  // 版本号里的 `-` 换成 `.`，避免破坏文件扩展名判定的常规约定
  const ver = meta.version.replace(/-/g, '.');
  return `${AI_AUDIO_FILE_PREFIX}${ver}_${base}`;
}

/** 音频合成审计记录：一次合成写一条，使「某次合成确实是 AI 生成」可被查询 */
export interface AiAudioTrace {
  /** 审计记录 id */
  id: string;
  /** 隐式标识载荷 */
  meta: AiLabelMeta;
  /** 本次播报的文本块数量 */
  chunkCount: number;
  /** 落库时间（ms） */
  recordedAt: number;
}

/** 读取全部音频合成审计记录（读失败返回空数组） */
export function readAudioTraces(): AiAudioTrace[] {
  try {
    const raw = Taro.getStorageSync(AUDIO_TRACE_KEY);
    if (Array.isArray(raw)) return raw as AiAudioTrace[];
  } catch (err) {
    console.warn('[aiLabel] read audio traces failed:', err);
  }
  return [];
}

/**
 * 记录一条音频合成审计（微信端 speakWeapp 成功路径调用一次，不每块写）。
 * 任何写入失败都 try/catch + console.warn，**绝不阻断播报**（合规记录是旁路能力）。
 */
export function recordAudioTrace(meta: AiLabelMeta): AiAudioTrace | null {
  try {
    const trace: AiAudioTrace = {
      id: `${meta.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      meta,
      chunkCount: 0,
      recordedAt: Date.now()
    };
    const prev = readAudioTraces();
    const next = [trace, ...prev].slice(0, AUDIO_TRACE_LIMIT);
    Taro.setStorageSync(AUDIO_TRACE_KEY, next);
    return trace;
  } catch (err) {
    console.warn('[aiLabel] record audio trace failed:', err);
    return null;
  }
}

/**
 * 记录一次播报的音频审计（携带块数量）。与 recordAudioTrace 同源，供 tts.ts 在
 * 「一次播报开始」时写入一条完整记录，避免每块写导致审计爆炸。
 */
export function recordAudioTraceWithCount(meta: AiLabelMeta, chunkCount: number): AiAudioTrace | null {
  const trace = recordAudioTrace(meta);
  if (!trace) return null;
  try {
    const count = typeof chunkCount === 'number' && chunkCount >= 0 ? chunkCount : 0;
    const prev = readAudioTraces();
    const next = prev.map((t) => (t.id === trace.id ? { ...t, chunkCount: count } : t));
    Taro.setStorageSync(AUDIO_TRACE_KEY, next);
    return { ...trace, chunkCount: count };
  } catch (err) {
    console.warn('[aiLabel] update audio trace count failed:', err);
    return trace;
  }
}

