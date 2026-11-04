/**
 * H5 端 AI 内容安全最小实现（X11）。
 *
 * 现状（改前）：`msgSecCheck` 只在微信云函数（chat/extract）里调用；H5 直接走
 * WorkBuddy LLM 网关，输入与输出都没有任何过滤，法律文档也如实写着「网页端尚未接入」。
 *
 * 这是一个**本地关键词红线护栏**，不是第三方内容审核：
 *   · 覆盖几类明确违法违规的请求/输出（制作爆炸物、制毒、侵害未成年人、教唆自残、
 *     洗钱套现、代写代考），命中即拒答；
 *   · 只做归一化 + 正则，不联网、不上传文本、不落盘 —— 不引入新的第三方与出境；
 *   · **不宣称等效于平台审核**：对方要求/法律文档仍写明「小程序端 msgSecCheck /
 *     网页端本地关键词护栏」。
 */
export interface SafetyVerdict {
  ok: boolean;
  /** 命中类别，用于埋点/提示文案（不包含命中的原文，避免日志二次留存） */
  category?: string;
}

const RULES: Array<{ category: string; re: RegExp }> = [
  // 爆炸物 / 危险品制作
  { category: 'explosive', re: /(制作|自制|配制|合成|组装)[^。\n]{0,18}(炸弹|炸药|雷管|爆炸物|燃烧弹)/ },
  // 毒品制作
  { category: 'drugs', re: /(制作|提炼|合成|配制)[^。\n]{0,18}(冰毒|海洛因|毒品|麻古|K粉)/ },
  // 侵害未成年人
  { category: 'minor', re: /(未成年|儿童|幼女|萝莉)[^。\n]{0,12}(裸照|色情|性行为|性交|视频)/ },
  // 教唆自残 / 自杀方法
  { category: 'self-harm', re: /(自杀|自残)[^。\n]{0,12}(方法|教程|怎么做|步骤|无痛)/ },
  // 洗钱 / 套现
  { category: 'fraud', re: /(银行卡|信用卡|收款码)[^。\n]{0,12}(套现|洗钱|跑分|代收)/ },
  // 代写代考
  { category: 'cheat', re: /(代写|代考|枪手)[^。\n]{0,10}(论文|作业|考试|四六级|雅思)/ }
];

/** 全角→半角、去零宽字符、压缩空白，避免用空格/全角绕过关键词 */
function normalize(text: string): string {
  return text
    .replace(/[\u3000]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function screenContent(text: string): SafetyVerdict {
  if (!text || typeof text !== 'string') return { ok: true };
  const s = normalize(text);
  for (const rule of RULES) {
    if (rule.re.test(s)) return { ok: false, category: rule.category };
  }
  return { ok: true };
}

/** 命中时的统一拒答（不含原文回显，避免二次传播） */
export const SAFETY_REFUSAL_ZH =
  '这个请求涉及违法违规内容，我不能协助。可以换个问题，或通过「我的 → 反馈」联系人工。';
export const SAFETY_REFUSAL_EN =
  'This request involves unlawful content, so I can’t help with it. Please rephrase, or contact us via Me → Feedback.';

export function safetyRefusal(lang: 'zh' | 'en'): string {
  return lang === 'en' ? SAFETY_REFUSAL_EN : SAFETY_REFUSAL_ZH;
}
