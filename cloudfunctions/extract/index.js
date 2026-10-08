const cloud = require('wx-server-sdk');
const { callLLM } = require('./llm');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SYSTEM_PROMPT = `你是私人晨报助理的提取引擎。分析用户转发的微信消息/文章，输出 JSON（不要输出任何其他文本）：
{
  "events": [{ "title": string, "startTime": "YYYY-MM-DD HH:mm", "endTime": string|null, "location": string|null, "source": string }],
  "todos": [{ "title": string, "dueDate": "YYYY-MM-DD HH:mm"|null, "source": string }],
  "collection": { "title": string, "summary": string(80字内), "tags": string[], "url": string|null, "sourceType": "article"|"message"|"link" } | null,
  "note": string|null
}
规则：
1. 相对时间基于"当前时间"推算绝对时间；
2. 只有明确的会议/约会/行程才算 event，需要去做的事算 todo；
3. 长文本（>120字）且像文章/链接内容才输出 collection；消息原文较短时 collection 为 null；
4. 无法归类的内容放进 note；
5. 全部字段使用简体中文。`;

/** 内容安全：过微信 msgSecCheck，命中则拒绝 */
async function securityCheck(content, openid) {
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      openid,
      scene: 1,
      content: content.slice(0, 2500)
    });
    if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
      return false;
    }
    return true;
  } catch (err) {
    // 内容安全接口异常时不阻断主流程，仅记录
    console.warn('[extract] msgSecCheck skipped:', err && err.errMsg);
    return true;
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
  const safe = await securityCheck(content || '截图提取', OPENID);
  if (!safe) {
    throw new Error('content failed security check');
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
    collection: parsed.collection || undefined,
    note: parsed.note || undefined
  };
};
