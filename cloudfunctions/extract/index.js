const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { callLLM } = require('./llm');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SYSTEM_PROMPT = `你是私人晨报助理的提取引擎。分析用户转发的微信消息/文章，输出 JSON（不要输出任何其他文本）：
{
  "events": [{ "title": string, "startTime": "YYYY-MM-DD HH:mm", "endTime": string|null, "location": string|null, "source": string }],
  "todos": [{ "title": string, "dueDate": "YYYY-MM-DD HH:mm"|null, "source": string }],
  "bills": [{ "title": string, "amount": number, "dueDate": "YYYY-MM-DD"|null, "source": string }],
  "shoppingItems": [{ "title": string, "note": string|null, "source": string }],
  "vocabularies": [{ "word": string, "meaning": string(60字内), "source": string }],
  "collection": { "title": string, "summary": string(80字内), "tags": string[], "url": string|null, "sourceType": "article"|"message"|"link" } | null,
  "note": string|null
}
规则：
1. 相对时间基于"当前时间"推算绝对时间；
2. 只有明确的会议/约会/行程才算 event，需要去做的事算 todo；
3. 长文本（>120字）且像文章/链接内容才输出 collection；消息原文较短时 collection 为 null；
4. bills：明确的账单/扣费/还款提醒才输出（amount 是数字，单位元；没有明确金额不输出）；"需要买的东西"不算账单，进 shoppingItems；
5. shoppingItems：想买/要买的物品清单（无金额或金额只是意向价）；
6. vocabularies：外文生词及其释义（仅当原文里真的出现该词）；
7. 三类都没有时对应数组输出 []；
8. 无法归类的内容放进 note；
9. 全部字段使用简体中文（vocabularies.word 保留原文）。`;

/** 「无法判定」话术：接口超时/5xx 时既不说用户违规，也不把内部错误码抛给用户 */
const SECURITY_UNAVAILABLE_MSG = '内容暂时无法校验，请稍后再试。';
/** 明确违规话术（不透露具体命中类别） */
const SECURITY_VIOLATION_MSG = '内容未通过安全检查，请修改后再试。';
const MODERATION_COLLECTION = 'moderation_failures';

/** 文本指纹：sha256 前 32 位。同一段文本可归因，但无法还原原文。 */
function textHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/**
 * 失败留证（与 chat 同款，云函数各自部署故各自实现）：写一条 moderation_failures + 一行
 * console.error，**绝不存原文**；写库失败不影响主流程，但必须再打一条 error。
 */
async function recordModerationFailure(openid, reason, errCode, detail, text) {
  const hash = textHash(text);
  const ts = new Date().toISOString();
  console.error(`[extract] moderation ${reason}: errCode=${errCode} detail=${detail}`);
  try {
    await db.collection(MODERATION_COLLECTION).add({ data: { openid, action: 'extract', reason, errCode, detail, ts, textHash: hash } });
  } catch (err) {
    console.error('[extract] moderation record write failed:', err && (err.errMsg || err.message));
  }
}

/** msgSecCheck 异常归类：`violation` = 87014 明确违规；`unavailable` = 超时/5xx/系统繁忙（拿不到结论） */
function classifyModerationError(err) {
  const rawCode = err && (err.errCode !== undefined ? err.errCode : err.code);
  const errCode = typeof rawCode === 'number' || typeof rawCode === 'string' ? rawCode : null;
  if (errCode === 87014) return { reason: 'violation', errCode: 87014, detail: 'violation' };
  const msg = String((err && (err.errMsg || err.message)) || '');
  const timeout = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(msg);
  const server = errCode === -1 || errCode === 500 || /\b5\d\d\b/.test(msg);
  return { reason: 'unavailable', errCode, detail: timeout ? 'timeout' : server ? 'server' : 'unknown' };
}

/**
 * 内容安全：过微信 msgSecCheck，命中则拒绝。返回 `{ ok, reason }`。
 * 异常时 **fail-closed**：改前 catch 里 `return true`，超时/抖动即全量放行且线上无痕迹。
 */
async function securityCheck(content, openid) {
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      openid,
      scene: 1,
      content: content.slice(0, 2500)
    });
    const result = (res && res.result) || {};
    if (result.suggest && result.suggest !== 'pass') {
      // errCode 留 null：结论来自正常返回而非异常，别和接口错误码混用同一个字段
      const label = typeof result.label === 'number' ? result.label : null;
      await recordModerationFailure(openid, 'violation', null, `suggest:${result.suggest}/label:${label}`, content);
      return { ok: false, reason: 'violation' };
    }
    return { ok: true };
  } catch (err) {
    const verdict = classifyModerationError(err);
    await recordModerationFailure(openid, verdict.reason, verdict.errCode, verdict.detail, content);
    return { ok: false, reason: verdict.reason };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        /* fallthrough */
      }
    }
    return null;
  }
}

exports.main = async (event) => {
  // 身份只认微信上下文：本函数跑在微信云开发里，`cloud.getWXContext().OPENID` 才是权威身份。
  // **不接受 event.openid** —— 接受调用方自传的身份，等于让调用方自证身份（谁都能填别人的 openid）；
  // 平台文档也要求身份由会话自动附带、不得由客户端传 user id/openid。
  // 取不到就拒绝：openid 为 undefined 时 msgSecCheck 无主体，且下游会以 undefined 身份落库。
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('no openid');
  const content = (event && event.content ? String(event.content) : '').trim();
  // 截图/图片提取：base64 数组（不含 dataURL 前缀），最多 3 张
  const images = Array.isArray(event && event.images)
    ? event.images.filter((s) => typeof s === 'string' && s.length > 100).slice(0, 3)
    : [];
  if (!content && images.length === 0) throw new Error('content or images is required');
  if (content.length > 5000) throw new Error('content too long (max 5000)');

  // TODO：图片内容安全走 security.imgSecCheck（需 base64 -> Buffer），当前先检查文字部分
  const check = await securityCheck(content || '截图提取', OPENID);
  if (!check.ok) {
    // 两种拒绝给不同的话术：明确违规 = 改内容；接口不可用 = 稍后再试（不透出错误码）
    throw new Error(check.reason === 'unavailable' ? SECURITY_UNAVAILABLE_MSG : SECURITY_VIOLATION_MSG);
  }

  const now = new Date();
  const nowStr = `${now.toLocaleDateString('sv-SE')} ${now.toTimeString().slice(0, 5)}`;

  // 多模态：有截图时切换视觉模型（GLM-4V-Flash 免费且国内备案；可用 LLM_VISION_MODEL/LLM_VISION_BASE_URL 覆盖）
  let userMessage;
  const llmOptions = {};
  if (images.length > 0) {
    llmOptions.model = process.env.LLM_VISION_MODEL || 'glm-4v-flash';
    llmOptions.base = process.env.LLM_VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    // 视觉模型是独立供应商（默认智谱），必须用独立 key；未配 LLM_VISION_API_KEY 则回退主力 key（同供应商时才可用）
    llmOptions.apiKey = process.env.LLM_VISION_API_KEY || process.env.LLM_API_KEY;
    userMessage = [
      ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
      {
        type: 'text',
        text: `当前时间：${nowStr}\n${content ? `用户附言：\n${content}` : '请从截图中提取日程、待办或值得收藏的内容'}`
      }
    ];
  } else {
    userMessage = `当前时间：${nowStr}\n用户转发内容：\n${content}`;
  }

  const raw = await callLLM(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    true,
    llmOptions
  );
  const parsed = safeParse(raw);
  if (!parsed) {
    console.error('[extract] bad LLM output:', raw);
    throw new Error('extract failed: invalid LLM output');
  }

  return {
    events: Array.isArray(parsed.events) ? parsed.events.slice(0, 10) : [],
    todos: Array.isArray(parsed.todos) ? parsed.todos.slice(0, 10) : [],
    // 三类扩展（2026-10-25）：账单/购物/生词。金额过滤——没有正数金额的"账单"转存记账
    // 会造出 0 元流水，宁可丢弃（字段缺失的老客户端拿到的数组里也不该有脏数据）
    bills: (Array.isArray(parsed.bills) ? parsed.bills : [])
      .filter((b) => b && typeof b.amount === 'number' && b.amount > 0)
      .slice(0, 10),
    shoppingItems: (Array.isArray(parsed.shoppingItems) ? parsed.shoppingItems : [])
      .filter((s) => s && typeof s.title === 'string' && s.title)
      .slice(0, 10),
    vocabularies: (Array.isArray(parsed.vocabularies) ? parsed.vocabularies : [])
      .filter((v) => v && typeof v.word === 'string' && v.word)
      .slice(0, 10),
    collection: parsed.collection || undefined,
    note: parsed.note || undefined
  };
};
