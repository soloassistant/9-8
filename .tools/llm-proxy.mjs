/**
 * 本地 LLM 代理：H5 预览端 AI 助理直接调 DeepSeek，不依赖云函数
 * 启动：node D:\Agent\.tools\llm-proxy.mjs（.mjs 后缀使 Node 以 ESM 执行，不依赖 package.json type 字段）
 * 默认端口 8138
 */
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';

// 读取 .env.local
function loadEnv() {
  const envPath = 'D:/Agent/.env.local';
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
const API_KEY = env.CODEFIX_LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
const BASE_URL = env.CODEFIX_LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL = env.CODEFIX_LLM_MODEL || 'deepseek-chat';
const PORT = 8138;

if (!API_KEY || API_KEY.startsWith('sk-在这里') || API_KEY.startsWith('sk-xxx')) {
  console.error('[llm-proxy] 未配置有效的 API KEY，请在 .env.local 填入 CODEFIX_LLM_API_KEY');
  process.exit(1);
}

console.log(`[llm-proxy] API: ${BASE_URL} | Model: ${MODEL} | Key: ${API_KEY.slice(0, 8)}...`);

// 与云函数 chat/index.js 一致的系统提示词
// X2 署名人设：早报员「小晨」——语气克制友好、少废话；只约束口吻，不改 JSON reply/action 输出契约
const PERSONA_XIAOCHEN = '你是用户的早报员「小晨」，语气克制友好、少废话。';

const SYSTEM_PROMPTS = {
  normal: PERSONA_XIAOCHEN + '你是私人晨报助理。基于用户当前日程数据及对话执行指令。输出 JSON：{"reply": "给用户的中文回复(120字内)", "action": "reschedule|done|query|schedule|batch|shopping|chat", "targetId": "事件或待办id或null", "newTime": "YYYY-MM-DD HH:mm或null", "newEvents": null}。改期指令且能定位目标时 action=reschedule；完成指令且能定位时 action=done；询问安排时 action=query；闲聊 action=chat。排班（如「帮我安排周五下午开会」）：对照已有日程找空闲时段，给 1 个建议时段和理由，action=schedule 且 newTime=建议时段。当识别到购物意图（买、对比、哪个划算、值不值、求推荐商品、想买东西、预算内选什么）时，action=shopping：输出一份选购分析——拆解需求与预算、列出 2-4 个主流平台/方案的关键差异（价格、售后、物流、口碑要点）、给出明确结论和下一步。实时价格、热点资讯、产品对比等时效性问题会基于联网检索作答并标注来源；检索不可用时基于常识回答并明确标注"价格为参考，以平台实时为准"，绝不谎称是实时联网数据。',
  deep: PERSONA_XIAOCHEN + '你是用户的深度思考伙伴。用户抛出纠结或问题时，帮其拆解：1) 关键矛盾是什么 2) 各选项的利弊 3) 给出一个可执行的下一步。语气克制友好，不空洞打气。输出 JSON：{"reply": "给用户的中文回复(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
  work: {
    summary: '你是用户的工作助手。对用户提供的内容做总结：先一句结论，再分点列出核心内容，最后一行给一个行动建议。输出 JSON：{"reply": "总结(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
    points: '你是用户的工作助手。从用户提供的内容中提取 3-6 条关键要点，每条一行、尽量短；末尾附一行「关键数据」（没有就写「无明显数据」）。输出 JSON：{"reply": "要点(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
    advice: '你是用户的工作助手。基于用户提供的内容给出 3 条具体可执行的建议，每条说明「做什么、为什么」，不空洞打气。输出 JSON：{"reply": "建议(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。'
  }
};

// 收件箱提取引擎（与云函数 extract 同款提示词）
const EXTRACT_PROMPT = `你是私人晨报助理的提取引擎。分析用户转发的微信消息/文章，输出 JSON（不要输出任何其他文本）：
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

function safeParse(text) {
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }
}

// 记忆回灌：与云函数 chat 同语义的服务端防御（仅留 string、去重截断）
function sanitizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => m.trim().slice(0, 80))
    .slice(0, 20);
}

function memoryPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  return '【用户长期记忆】以下是用户的长期记忆偏好，回答/安排日程时必须遵守（如偏好的会议时段、作息习惯）：' + memories.join('；');
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }

// /extract：收件箱 AI 提取（与云函数 extract 同款提示词；H5 端无视觉模型，截图降级为提示）
if (req.url === '/extract') {
    let fbody = '';
    req.on('data', (c) => { fbody += c; });
    req.on('end', async () => {
      try {
        const f = JSON.parse(fbody || '{}');
        const content = String(f.content || '').trim().slice(0, 5000);
        const images = Array.isArray(f.images) ? f.images.filter((s) => typeof s === 'string' && s.length > 100).slice(0, 3) : [];
        if (!content && images.length === 0) { res.writeHead(400); res.end(JSON.stringify({ error: 'content or images is required' })); return; }

        const now = new Date();
        const nowStr = `${now.toLocaleDateString('sv-SE')} ${now.toTimeString().slice(0, 5)}`;
        // 本地代理无视觉模型 key（云函数走 glm-4v-flash），截图场景诚实降级
        const imgNotice = images.length > 0
          ? `（用户另附了 ${images.length} 张截图，当前环境无法识别图片内容，如截图含日程/待办信息请在 note 中提示用户粘贴文字）\n`
          : '';
        const userContent = `当前时间：${nowStr}\n${imgNotice}用户转发内容：\n${content || '（仅截图，无文字）'}`;

        const apiRoot = BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        const llmRes = await fetch(`${apiRoot}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0.2,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: EXTRACT_PROMPT },
              { role: 'user', content: userContent }
            ]
          })
        });
        if (!llmRes.ok) {
          const errText = await llmRes.text();
          console.error('[llm-proxy] extract DeepSeek error:', llmRes.status, errText.slice(0, 200));
          res.writeHead(502);
          res.end(JSON.stringify({ error: `DeepSeek API error: ${llmRes.status}` }));
          return;
        }
        const llmData = await llmRes.json();
        const parsed = safeParse(llmData.choices?.[0]?.message?.content || '');
        if (!parsed) { res.writeHead(502); res.end(JSON.stringify({ error: 'extract failed: invalid LLM output' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          events: Array.isArray(parsed.events) ? parsed.events.slice(0, 10) : [],
          todos: Array.isArray(parsed.todos) ? parsed.todos.slice(0, 10) : [],
          collection: parsed.collection || undefined,
          note: parsed.note || undefined
        }));
      } catch (err) {
        console.error('[llm-proxy] extract error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // /filter：资讯 AI 筛选（static-server /api/news/ai-filter 转发而来）
  if (req.url === '/filter') {
    let fbody = '';
    req.on('data', (c) => { fbody += c; });
    req.on('end', async () => {
      try {
        const f = JSON.parse(fbody || '{}');
        const interests = Array.isArray(f.interests) ? f.interests.filter(Boolean).slice(0, 8) : [];
        const custom = String(f.custom || '').slice(0, 60);
        const signals = Array.isArray(f.signals) ? f.signals.filter(Boolean).slice(0, 8) : [];
        const candidates = Array.isArray(f.candidates) ? f.candidates.filter(Boolean).slice(0, 110) : [];
        if (!candidates.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'candidates required' })); return; }

        const systemContent =
          '你是新闻筛选助手。根据用户兴趣画像，从候选新闻中挑出最值得看的条目（最多10条，按相关度排序）。' +
          '规则：1) 只挑与兴趣相关或与近期关注相近的条目；若整体相关度都低，也要挑出相对最相关的3条；' +
          '2) 合规降权（优先级最高，覆盖第1条）：时政/外交/军事/突发事件监管类内容不得入选 picks；财经类最多 1 条；优先科技/数字生活/健康/教育等生活建设性议题；' +
          '3) reason 用不超过16字说明「为什么推荐给这位用户」，不要复述标题；' +
          '4) 对每个选中条目额外输出 why 字段：不超过30字的中文，回答「为什么这条值得**这个用户**看」，必须结合其 interests/custom 画像给出个人化理由（不是通用新闻价值）；' +
          '5) summary 以早报员「小晨」的口吻写（克制友好、少废话），不超过20字；' +
          '6) 严格返回 JSON：{"picks":[{"n":编号数字,"reason":"理由","why":"个人化理由(30字内)"}],"summary":"一句话概括筛选依据(20字内)"}，不要输出任何其他内容；why 缺失时允许为空字符串，但字段必须存在。';
        const userContent =
          `兴趣标签：${interests.length ? interests.join('、') : '（未设置）'}\n` +
          `自定义关注：${custom || '（无）'}\n` +
          `近期关注（参考）：${signals.length ? signals.join(' / ').slice(0, 120) : '（无）'}\n\n` +
          `候选新闻：\n${candidates.join('\n')}`;

        const apiRoot = BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        const llmRes = await fetch(`${apiRoot}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0.3,
            max_tokens: 1200,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: userContent }
            ]
          })
        });

        if (!llmRes.ok) {
          const errText = await llmRes.text();
          console.error('[llm-proxy] filter DeepSeek error:', llmRes.status, errText.slice(0, 200));
          res.writeHead(502);
          res.end(JSON.stringify({ error: `DeepSeek API error: ${llmRes.status}` }));
          return;
        }

        const llmData = await llmRes.json();
        const content = llmData.choices?.[0]?.message?.content || '';
        const parsed = safeParse(content);
        const picks = Array.isArray(parsed?.picks)
          ? parsed.picks
              .filter((p) => p && Number.isInteger(Number(p.n)) && Number(p.n) >= 1 && Number(p.n) <= candidates.length)
              .slice(0, 10)
              .map((p) => ({
                n: Number(p.n),
                reason: String(p.reason || '').slice(0, 30),
                // X1 whyItMatters 生成侧：缺失容错（空串）+ 超长截断（30 字，与提示词口径一致）
                why: String(p.why || '').trim().slice(0, 30)
              }))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ picks, summary: String(parsed?.summary || '').slice(0, 40) }));
      } catch (err) {
        console.error('[llm-proxy] filter error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // /stream：chat 流式（F-03）——DeepSeek stream:true，增量剥出 reply 文本，
  // 以 NDJSON 行下发给前端：{"t":"增量"} 若干行 → 末行 {"done":true,"reply":..,"action":..}
  if (req.url === '/stream') {
    let fbody = '';
    req.on('data', (c) => { fbody += c; });
    req.on('end', async () => {
      try {
        const f = JSON.parse(fbody || '{}');
        const message = (f.message || '').trim();
        const deep = !!f.deep;
        const mode = f.mode;
        const workAction = f.workAction;
        const memories = sanitizeMemories(f.memories);
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message is required' })); return; }

        let systemContent;
        if (mode === 'work') {
          systemContent = SYSTEM_PROMPTS.work[workAction] || SYSTEM_PROMPTS.work.summary;
        } else if (deep) {
          systemContent = SYSTEM_PROMPTS.deep;
        } else {
          systemContent = SYSTEM_PROMPTS.normal;
        }
        if (memories.length > 0) systemContent += memoryPrompt(memories);

        const apiRoot = BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        const llmRes = await fetch(`${apiRoot}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0.3,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
            stream: true,
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: message }
            ]
          })
        });
        if (!llmRes.ok) {
          const errText = await llmRes.text();
          console.error('[llm-proxy] stream DeepSeek error:', llmRes.status, errText.slice(0, 200));
          res.writeHead(502);
          res.end(JSON.stringify({ error: `DeepSeek API error: ${llmRes.status}` }));
          return;
        }

        /** 从（可能不完整的）JSON 文本中剥出 reply 字符串的已到达部分 */
        function replyFragment(text) {
          const key = text.indexOf('"reply"');
          if (key < 0) return null;
          const colon = text.indexOf(':', key);
          if (colon < 0) return null;
          let i = colon + 1;
          while (i < text.length && text[i] === ' ') i++;
          if (i >= text.length || text[i] !== '"') return null;
          let out = '';
          for (let j = i + 1; j < text.length; j++) {
            const ch = text[j];
            if (ch === '\\') {
              const nx = text[j + 1];
              if (nx === undefined) break; // 转义序列不完整，等下一个增量
              if (nx === 'n') out += '\n';
              else if (nx === 't') out += '\t';
              else if (nx === '"') out += '"';
              else if (nx === '\\') out += '\\';
              else if (nx === '/') out += '/';
              else if (nx === 'u') {
                const hex = text.slice(j + 2, j + 6);
                if (hex.length < 4) break;
                out += String.fromCharCode(parseInt(hex, 16));
                j += 4;
              }
              j++;
              continue;
            }
            if (ch === '"') return { text: out, done: true };
            out += ch;
          }
          return { text: out, done: false };
        }

        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
        const emit = (obj) => res.write(JSON.stringify(obj) + '\n');
        const decoder = new TextDecoder();
        let sseBuf = '';
        let acc = '';
        let sent = '';
        for await (const chunk of llmRes.body) {
          sseBuf += decoder.decode(chunk, { stream: true });
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content || '';
              if (delta) acc += delta;
              // reply 闭合后 replyFragment 返回的文本不再增长，天然幂等不会重复下发
              const frag = replyFragment(acc);
              if (frag && frag.text.length > sent.length) {
                emit({ t: frag.text.slice(sent.length) });
                sent = frag.text;
              }
            } catch { /* 不完整行跳过 */ }
          }
        }
        // 全量兜底解析（与 / 同口径），末行下发最终结果供前端校正
        const parsed = safeParse(acc);
        const reply = parsed?.reply || acc || '（AI 暂无回复）';
        const action = parsed?.action || 'chat';
        emit({ done: true, reply, action });
        res.end();
      } catch (err) {
        console.error('[llm-proxy] stream error:', err);
        try { res.writeHead(500); } catch { /* headers already sent */ }
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');
      const message = (data.message || '').trim();
      const deep = !!data.deep;
      const mode = data.mode;
      const workAction = data.workAction;
      const memories = sanitizeMemories(data.memories);
      if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message is required' })); return; }

      // 选系统提示词
      let systemContent;
      if (mode === 'work') {
        systemContent = SYSTEM_PROMPTS.work[workAction] || SYSTEM_PROMPTS.work.summary;
      } else if (deep) {
        systemContent = SYSTEM_PROMPTS.deep;
      } else {
        systemContent = SYSTEM_PROMPTS.normal;
      }
      if (memories.length > 0) systemContent += memoryPrompt(memories);

      // BASE_URL 兼容带/不带 /v1 结尾（如 https://api.deepseek.com/v1 或 https://api.deepseek.com）
      const apiRoot = BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      const llmRes = await fetch(`${apiRoot}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: message }
          ]
        })
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text();
        console.error('[llm-proxy] DeepSeek error:', llmRes.status, errText.slice(0, 200));
        res.writeHead(502);
        res.end(JSON.stringify({ error: `DeepSeek API error: ${llmRes.status}` }));
        return;
      }

      const llmData = await llmRes.json();
      const content = llmData.choices?.[0]?.message?.content || '';
      const parsed = safeParse(content);
      const reply = parsed?.reply || content || '（AI 暂无回复）';
      const action = parsed?.action || 'chat';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, action }));
    } catch (err) {
      console.error('[llm-proxy] error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[llm-proxy] 已启动 → http://localhost:${PORT}`);
  console.log(`[llm-proxy] AI 助理 H5 预览可直接调用 DeepSeek`);
});
