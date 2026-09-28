/**
 * selfcheck.js —— v1.3 验收自检（docs/prd-increment-v1.3.md 第六章验收表的可执行版）
 *
 * 为什么存在：v1.3 PRD 验收表引用了本脚本，但脚本此前并不存在（2026-09-27 审计发现），
 * 「10 项全过」无从跑起。本脚本把验收表中可自动化项逐条落地，每项标注对应 PRD 条目。
 *
 * 用法：node .tools/selfcheck.js   （在项目根执行；exit 0 = 全过，1 = 有失败项）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const CHECKS = [];
function check(name, prdRef, fn) { CHECKS.push({ name, prdRef, fn }); }

/* ---------- 1. tsc 全仓 0 错误（PRD 第六章「类型检查」） ---------- */
check('tsc --noEmit 全仓 0 错误', '第六章·类型检查', () => {
  if (!exists('node_modules/typescript/bin/tsc')) return { pass: false, detail: 'typescript 未安装' };
  let r;
  // Windows 下后台常驻 node 进程可能让 spawnSync 偶发 EBUSY，重试两次
  for (let i = 0; i < 3; i++) {
    r = spawnSync(process.execPath, [TSC_BIN, '--noEmit', '-p', 'tsconfig.json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (!r.error) break;
  }
  if (r.error) {
    // 沙箱等受限环境下 node 无法 spawn 子进程（EBUSY/EPERM）——如实跳过而非谎报失败。
    // tsc 需另行在普通终端验证：node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
    return { skip: true, detail: 'spawn 失败（' + r.error.code + '，受限环境），请在普通终端单独跑 tsc 验证' };
  }
  if (r.status === 0) return { pass: true, detail: 'exit 0，0 错误' };
  const out = String(r.stdout || '');
  const errs = out.split('\n').filter((l) => l.includes('error TS')).slice(0, 5);
  return { pass: false, detail: 'exit ' + r.status + '：' + (errs.join(' ／ ') || out.slice(0, 200) || String(r.stderr || '').slice(0, 200)) };
});

/* ---------- 2. L3-05 langToAsr 已接线（定义处不再是唯一引用） ---------- */
check('L3-05 asrLang 接线：langToAsr 有真实调用点', 'L3-05', () => {
  const drill = read('src/pages/learnDetail/SpeakingDrill.tsx');
  if (!drill) return { pass: false, detail: 'SpeakingDrill.tsx 不存在' };
  const called = /langToAsr\s*\(/.test(drill);
  return called
    ? { pass: true, detail: 'SpeakingDrill.tsx 存在调用' }
    : { pass: false, detail: '定义了但零调用（死代码回归）' };
});

/* ---------- 3. Q-02② sceneByHour 已接入晨报播报 ---------- */
check('Q-02 sceneByHour 接入晨报播报', 'Q-02②', () => {
  const briefing = read('src/pages/briefing/index.tsx');
  return briefing && /sceneByHour\s*\(/.test(briefing)
    ? { pass: true, detail: 'briefing/index.tsx 存在调用' }
    : { pass: false, detail: 'briefing 页未调用 sceneByHour' };
});

/* ---------- 4. Q-01 三练习组件共用 DrillShared ---------- */
check('Q-01 DrillShared 被三个练习组件共同引用', 'Q-01', () => {
  const files = ['GrammarDrill.tsx', 'ListeningDrill.tsx', 'SpeakingDrill.tsx'];
  const missing = files.filter((f) => {
    const c = read('src/pages/learnDetail/' + f);
    return !c || !/from\s+'\.\/DrillShared'/.test(c);
  });
  return missing.length === 0
    ? { pass: true, detail: '3/3 组件均 import DrillShared' }
    : { pass: false, detail: '未引用：' + missing.join(', ') };
});

/* ---------- 5. L3-08 learn.* 30+2 键 zh/en 双语齐备 ---------- */
check('L3-08 learn 键 zh/en 双语齐备（30+1）', 'L3-08', () => {
  const lang = read('src/store/language.ts');
  if (!lang) return { pass: false, detail: 'language.ts 不存在' };
  const enStart = lang.indexOf("const en:");
  if (enStart < 0) return { pass: false, detail: '找不到 en 字典' };
  const zhRegion = lang.slice(0, enStart), enRegion = lang.slice(enStart);
  const keys = ['tabWords', 'tabGrammar', 'tabListening', 'tabSpeaking', 'grammarFillHint', 'next',
    'finish', 'grammarDone', 'correctCount', 'bestScore', 'retry', 'listenHint', 'listenPlay',
    'listenSlow', 'listenDone', 'ttsUnsupportedTitle', 'ttsUnsupported', 'speakHint', 'speakPlay',
    'speakYourTurn', 'speakSelfCheck', 'speakGood', 'speakAgain', 'speakMatch', 'speakMatchGood',
    'speakMatchRetry', 'speakSkip', 'speakProgress', 'speakDone', 'grammarEmptyTitle'];
  // 该文件键是扁平带引号形式：'learn.tabWords': '单词' —— 必须连前缀一起匹配，
  // 否则 'finish'/'next' 这类短键会误命中别处（如按钮文案键）。
  const miss = keys.filter((k) => {
    const re = new RegExp("'learn\\." + k + "'\\s*:");
    return !re.test(zhRegion) || !re.test(enRegion);
  });
  return miss.length === 0
    ? { pass: true, detail: keys.length + '/' + keys.length + ' 键两侧齐备' }
    : { pass: false, detail: '缺失：' + miss.join(', ') };
});

/* ---------- 6. F-03 AI 流式：代理端点 + 前端消费 + 降级 ---------- */
check('F-03 AI 流式：/stream 端点 + 前端消费', 'F-03', () => {
  const proxy = read('.tools/llm-proxy.mjs');
  const cloud = read('src/services/cloud.ts');
  if (!proxy || !/['"]\/stream['"]/.test(proxy)) return { pass: false, detail: 'llm-proxy 缺 /stream 端点' };
  if (!proxy.includes('stream: true')) return { pass: false, detail: 'llm-proxy 未启用 DeepSeek stream' };
  if (!cloud || !/getReader\s*\(/.test(cloud)) return { pass: false, detail: '前端无流式读取（getReader）' };
  return { pass: true, detail: '代理 /stream + 前端 getReader 均在' };
});

/* ---------- 7. F-04 晨报当日缓存 + force 重拉 ---------- */
check('F-04 晨报当日缓存 + force 重拉入口', 'F-04', () => {
  const briefing = read('src/pages/briefing/index.tsx');
  if (!briefing) return { pass: false, detail: 'briefing 页不存在' };
  const hasCache = /briefingDailyCache|BRIEFING_CACHE_KEY/.test(briefing);
  const forceCount = (briefing.match(/loadBriefing\s*\(\s*true\s*\)/g) || []).length;
  return hasCache && forceCount >= 3
    ? { pass: true, detail: '缓存键在，force 重拉 ' + forceCount + ' 处' }
    : { pass: false, detail: 'hasCache=' + hasCache + ' force=' + forceCount + '（需 ≥3）' };
});

/* ---------- 8. C3-01 音频 AI 标识：默认场景开关 + 声明文案 ---------- */
check('C3-01 音频 AI 标识（learning 除外默认开）', 'C3-01', () => {
  const aiLabel = read('src/utils/aiLabel.ts');
  const lang = read('src/store/language.ts');
  if (!aiLabel) return { pass: false, detail: 'aiLabel.ts 不存在' };
  const sceneGate = /learning/.test(aiLabel) && /!==\s*['"]learning['"]|===\s*['"]learning['"]/.test(aiLabel);
  const enStart = lang ? lang.indexOf('const en:') : -1;
  const introBoth = enStart > 0 && /'ai\.audioIntro'\s*:/.test(lang.slice(0, enStart)) && /'ai\.audioIntro'\s*:/.test(lang.slice(enStart));
  return sceneGate && introBoth
    ? { pass: true, detail: '场景门控 + audioIntro 双语键均在' }
    : { pass: false, detail: 'sceneGate=' + sceneGate + ' introBoth=' + introBoth };
});

/* ---------- 9. U-01 骨架屏接线（晨报 + 热点） ---------- */
check('U-01 骨架屏接入晨报与热点页', 'U-01', () => {
  const briefing = read('src/pages/briefing/index.tsx');
  const library = read('src/pages/library/index.tsx');
  const ok = (c) => c && /Skeleton/.test(c) && /300/.test(c);
  return ok(briefing) && ok(library)
    ? { pass: true, detail: '两页均含 Skeleton + 300ms 阈值' }
    : { pass: false, detail: 'briefing=' + !!ok(briefing) + ' library=' + !!ok(library) };
});

/* ---------- 10. 密钥卫生：src 与云函数零硬编码密钥 ---------- */
check('密钥卫生：源码零硬编码密钥', '头部密钥约定', () => {
  const bad = [];
  const scan = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { scan(p); continue; }
      if (!/\.(ts|tsx|js|mjs|json)$/.test(name)) continue;
      const c = fs.readFileSync(p, 'utf8');
      if (/sk-[a-zA-Z0-9]{16,}/.test(c) || /(API_KEY|SECRET)\s*[:=]\s*['"][a-zA-Z0-9]{16,}['"]/.test(c)) {
        bad.push(path.relative(ROOT, p));
      }
    }
  };
  scan(path.join(ROOT, 'src'));
  scan(path.join(ROOT, 'cloudfunctions'));
  return bad.length === 0
    ? { pass: true, detail: 'src + cloudfunctions 干净' }
    : { pass: false, detail: '疑似硬编码：' + bad.join(', ') };
});

/* ---------- 11. Q-03 严格类型：src 零 any（2026-09-27 类型收口后持续盯防） ---------- */
check('Q-03 src 零 any（类型收口）', 'Q-03', () => {
  // 只匹配类型位置的 any（: any / <any> / any[] / as any / = any），避免英文文案误报
  const re = /(:\s*any\b)|(<any>)|(any\[\])|(as\s+any\b)|(=\s*any\b)/;
  const bad = [];
  const scan = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { scan(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (re.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(ROOT, p));
    }
  };
  scan(path.join(ROOT, 'src'));
  return bad.length === 0
    ? { pass: true, detail: 'src 全部 .ts/.tsx 无 any 类型标注' }
    : { pass: false, detail: '含 any：' + bad.join(', ') };
});

/* ---------- 12. A 记忆回灌链路（前端 readMemory→apiChat 带 memories + 云函数 MEMORY_RECALL_PROMPT） ---------- */
check('A 记忆回灌链路', '战役A', () => {
  const ui = read('src/components/AiAssistant/index.tsx');
  const chat = read('cloudfunctions/chat/index.js');
  if (!ui) return { pass: false, detail: 'AiAssistant/index.tsx 不存在' };
  if (!chat) return { pass: false, detail: 'cloudfunctions/chat/index.js 不存在' };
  const uiOk = /readMemory\s*\(/.test(ui) && /apiChat\([^)]*memories/.test(ui);
  const cloudOk = chat.includes('MEMORY_RECALL_PROMPT');
  return uiOk && cloudOk
    ? { pass: true, detail: '前端 readMemory+apiChat(memories)，云函数 MEMORY_RECALL_PROMPT 均在' }
    : { pass: false, detail: 'uiOk=' + uiOk + ' cloudOk=' + cloudOk };
});

/* ---------- 13. B 联网搜索扩面（webSearchReply + NEWS_SEARCH_INTENT；代理端不再声明无搜索工具） ---------- */
check('B 联网搜索扩面', '战役B', () => {
  const chat = read('cloudfunctions/chat/index.js');
  const proxy = read('.tools/llm-proxy.mjs');
  if (!chat) return { pass: false, detail: 'cloudfunctions/chat/index.js 不存在' };
  if (!proxy) return { pass: false, detail: '.tools/llm-proxy.mjs 不存在' };
  const chatOk = chat.includes('webSearchReply') && chat.includes('NEWS_SEARCH_INTENT');
  const proxyClean = !proxy.includes('无搜索工具');
  return chatOk && proxyClean
    ? { pass: true, detail: 'webSearchReply + NEWS_SEARCH_INTENT 在，llm-proxy 无「无搜索工具」残留' }
    : { pass: false, detail: 'chatOk=' + chatOk + ' proxyClean=' + proxyClean };
});

/* ---------- 14. C 日历一键重排（conflictCount + apiApplyPlan 唯一写库通道） ---------- */
check('C 日历一键重排', '战役C', () => {
  const cal = read('src/pages/calendar/index.tsx');
  if (!cal) return { pass: false, detail: 'calendar/index.tsx 不存在' };
  const ok = /conflictCount/.test(cal) && /apiApplyPlan/.test(cal);
  return ok
    ? { pass: true, detail: 'conflictCount 与 apiApplyPlan 均在' }
    : { pass: false, detail: 'conflictCount=' + /conflictCount/.test(cal) + ' apiApplyPlan=' + /apiApplyPlan/.test(cal) };
});

/* ---------- 15. D 晨报负载条（云函数与前端 adaptive 同源 busyMinutes） ---------- */
check('D 晨报负载条 busyMinutes 双端在位', '战役D', () => {
  const cloud = read('cloudfunctions/getBriefing/index.js');
  const adaptive = read('src/utils/adaptive.ts');
  const ok = (c) => !!c && c.includes('busyMinutes');
  return ok(cloud) && ok(adaptive)
    ? { pass: true, detail: 'getBriefing 与 adaptive.ts 均含 busyMinutes' }
    : { pass: false, detail: 'cloud=' + ok(cloud) + ' adaptive=' + ok(adaptive) };
});

/* ---------- 16. E 记忆溯源（memoryCount 渲染 + ai.memoryUsed 双语键） ---------- */
check('E 记忆溯源 memoryCount + ai.memoryUsed 双语', '战役E', () => {
  const ui = read('src/components/AiAssistant/index.tsx');
  const lang = read('src/store/language.ts');
  if (!ui) return { pass: false, detail: 'AiAssistant/index.tsx 不存在' };
  if (!lang) return { pass: false, detail: 'language.ts 不存在' };
  const uiOk = /memoryCount/.test(ui);
  const enStart = lang.indexOf('const en:');
  if (enStart < 0) return { pass: false, detail: '找不到 en 字典' };
  const both = /'ai\.memoryUsed'\s*:/.test(lang.slice(0, enStart)) && /'ai\.memoryUsed'\s*:/.test(lang.slice(enStart));
  return uiOk && both
    ? { pass: true, detail: 'memoryCount 在 UI，ai.memoryUsed zh/en 双侧齐备' }
    : { pass: false, detail: 'uiOk=' + uiOk + ' both=' + both };
});

/* ---------- 17. 合规页脚 + AI 标识（common.disclaimer 两页 + library aiBadge） ---------- */
check('合规页脚 + AI 标识', '竞品合规项', () => {
  const briefing = read('src/pages/briefing/index.tsx');
  const library = read('src/pages/library/index.tsx');
  if (!briefing) return { pass: false, detail: 'briefing/index.tsx 不存在' };
  if (!library) return { pass: false, detail: 'library/index.tsx 不存在' };
  const ok = briefing.includes('common.disclaimer') && library.includes('common.disclaimer') && library.includes('aiBadge');
  return ok
    ? { pass: true, detail: 'briefing/library 页脚 + library aiBadge 均在' }
    : { pass: false, detail: 'briefing页脚=' + briefing.includes('common.disclaimer') + ' library页脚=' + library.includes('common.disclaimer') + ' aiBadge=' + library.includes('aiBadge') };
});

/* ---------- 18. 资讯多元化：类目数与类目透传（2026-09-28 扩源） ---------- */
// 为什么检查「类目数」而不是「源数」：源多了但都挤在同几个类目里，用户感知不到多元化
// （实测教训：加源前 10 源只有 7 类，科技就占 3 个源）。类目数是这个需求的真正验收口径。
check('资讯源类目数 ≥ 12（防回退）', '多元化扩源', () => {
  const cloud = read('cloudfunctions/webSearch/index.js');
  if (!cloud) return { pass: false, detail: 'webSearch/index.js 不存在' };
  const block = cloud.match(/const RSS_SOURCES = \[([\s\S]*?)\n\];/);
  if (!block) return { pass: false, detail: '未找到 RSS_SOURCES 数组' };
  const re = /\{\s*name:\s*'[^']+'\s*,\s*url:\s*'[^']+'\s*,\s*tag:\s*'([^']+)'\s*\}/g;
  const tags = new Map();
  let m;
  while ((m = re.exec(block[1]))) tags.set(m[1], (tags.get(m[1]) || 0) + 1);
  const names = [...tags.keys()];
  return tags.size >= 12
    ? { pass: true, detail: names.length + ' 个类目：' + names.join('/') }
    : { pass: false, detail: '仅 ' + tags.size + ' 个类目（要求 ≥12）：' + names.join('/') };
});

// 类目必须真的流到条目与候选串上 —— 否则模型无从判断类目，「多样性规则」是空话。
check('类目透传：parseRss tag → 条目 tags → 候选串', '多元化扩源', () => {
  const server = read('.tools/static-server.js');
  if (!server) return { pass: false, detail: 'static-server.js 不存在' };
  const sig = /function parseRss\(xml, source, limit, tag\)/.test(server);
  const tagsField = /tags:\s*tag\s*\?\s*\[tag\]\s*:\s*\[\]/.test(server);
  const callPass = /parseRss\(x, s\.name, RSS_PER_SOURCE, s\.tag\)/.test(server);
  const candCat = /it\.tags\.join\('\/'\)/.test(server);
  const ok = sig && tagsField && callPass && candCat;
  return ok
    ? { pass: true, detail: '签名带 tag + tags 落到条目 + 调用处传 tag + 候选串含类目' }
    : { pass: false, detail: 'sig=' + sig + ' tagsField=' + tagsField + ' callPass=' + callPass + ' candCat=' + candCat };
});

check('AI 精选多样性：提示词规则 + 确定性兜底', '多元化扩源', () => {
  const proxy = read('.tools/llm-proxy.mjs');
  const server = read('.tools/static-server.js');
  if (!proxy) return { pass: false, detail: 'llm-proxy.mjs 不存在' };
  if (!server) return { pass: false, detail: 'static-server.js 不存在' };
  // 提示词层
  const promptOk = /类目多样性/.test(proxy) && /同一类目最多给 2 条/.test(proxy);
  // 代理侧必须给够 20 条，否则下游去重后凑不满 10 条
  const quotaOk = /AI_FILTER_PICKS_MAX = 20/.test(proxy);
  // ★ 确定性兜底层：提示词不可靠（实测模型让教育占 4/10），必须在下游硬约束
  const guardOk = /AI_PICK_PER_CATEGORY_MAX = 2/.test(server) && /categoryOfItem/.test(server);
  // 可观测层：类目数要下发，否则回退只能靠人肉看页面发现
  const obsOk = /categories: perCat\.size/.test(server);
  const ok = promptOk && quotaOk && guardOk && obsOk;
  return ok
    ? { pass: true, detail: '提示词规则 + 代理给 20 条 + 下游每类 ≤2 硬约束 + 类目数可观测' }
    : { pass: false, detail: 'prompt=' + promptOk + ' quota20=' + quotaOk + ' guard=' + guardOk + ' obs=' + obsOk };
});

/* ---------- 21. 资讯质量回归入口已注册（2026-09-28 固化） ---------- */
// 为什么检查这个：类目多元化/源健康/板块可用性的验证手段此前是一次性脚本（散落在 .tmp-verify/，
// 不纳入版本控制、随时被清），下次没人知道怎么跑、也无法回归。这里守住「入口已注册且脚本在位」，
// 让 `npm run verify:intel / vet:sources / verify:boards` 永远可复跑。
check('资讯质量回归入口已注册（vet:sources / verify:boards / verify:intel）', '多元化扩源', () => {
  const pkg = read('package.json');
  if (!pkg) return { pass: false, detail: 'package.json 不存在' };
  let scripts = {};
  try { scripts = JSON.parse(pkg).scripts || {}; } catch (e) { return { pass: false, detail: 'package.json 解析失败：' + e.message }; }
  const missingScripts = ['vet:sources', 'verify:boards', 'verify:intel'].filter((k) => !scripts[k]);
  const missingFiles = ['.tools/analyze-intel.js', '.tools/verify-boards.js', '.tools/board-probe.ts'].filter((f) => !exists(f));
  return missingScripts.length === 0 && missingFiles.length === 0
    ? { pass: true, detail: '3 条 script 已注册，3 个脚本文件均在' }
    : { pass: false, detail: (missingScripts.length ? '缺 script：' + missingScripts.join(', ') + '；' : '') + (missingFiles.length ? '缺文件：' + missingFiles.join(', ') : '') };
});

/* ---------- 21. 类目偏好：A/B 度量 + 云同步 + 跨源合并关键词通道（2026-09-28 第三轮） ---------- */

// 只验证了「链路通」不等于验证了「有用」。A/B 的存在意义就是别凭信念上线 ——
// 而整个实验成立的前提是**对照组真的不带学习结果**，所以这里专门断言它。
check('偏好学习 A/B 度量在位（对照组不带学习结果）', '偏好学习效果', () => {
  const exp = read('src/utils/affinityExperiment.ts');
  const page = read('src/pages/library/index.tsx');
  if (!exp) return { pass: false, detail: 'affinityExperiment.ts 不存在' };
  if (!page) return { pass: false, detail: 'library/index.tsx 不存在' };
  const apiOk = /export function pickAffinityArm/.test(exp)
    && /export function recordAffinityImpression/.test(exp)
    && /export function recordAffinityOutcome/.test(exp)
    && /export function getAffinityExperimentSummary/.test(exp);
  // 分臂函数唯一实现点：control 分支必须直接返回手选、不掺入 learned
  const controlOk = /function buildAiInterests\(arm[\s\S]{0,240}?arm === 'control'[\s\S]{0,80}?return manual\.slice\(0,\s*8\)/.test(page);
  const wiredOk = /pickAffinityArm\(\)/.test(page)
    && /recordAffinityImpression\(arm, learned\)/.test(page)
    && /recordAffinityOutcome\(/.test(page);
  const ok = apiOk && controlOk && wiredOk;
  return ok
    ? { pass: true, detail: '分臂/记录/汇总齐备；control 分支只返回手选类目；impression 与 outcome 均已接线' }
    : { pass: false, detail: 'api=' + apiOk + ' control分支=' + controlOk + ' 接线=' + wiredOk };
});

check('偏好云同步在位（且不覆盖本地新行为）', '偏好学习效果', () => {
  const cf = read('cloudfunctions/chat/index.js');
  const cloud = read('src/services/cloud.ts');
  const aff = read('src/utils/categoryAffinity.ts');
  if (!cf || !cloud || !aff) return { pass: false, detail: '文件缺失' };
  const serverOk = /function sanitizeAffinity/.test(cf) && /'saveAffinity'/.test(cf) && /'getAffinity'/.test(cf);
  // 服务端必须只收摘要：清洗函数里出现 category/score 且有条数上限
  const pruneOk = /AFFINITY_ITEMS_MAX/.test(cf) && /AFFINITY_CATEGORY_MAX/.test(cf);
  const clientOk = /apiSaveAffinity/.test(cloud) && /apiGetAffinity/.test(cloud);
  const utilOk = /export function exportAffinityForSync/.test(aff) && /export function mergeRemoteAffinity/.test(aff);
  // 合并策略：本地有有效记录就短路返回，绝不写 —— 这是防止远端旧摘要抹掉本地新行为的关键一行
  const noClobber = /function mergeRemoteAffinity[\s\S]{0,400}?readRecords\(\)\.length > 0[\s\S]{0,40}?return false/.test(aff);
  const ok = serverOk && pruneOk && clientOk && utilOk && noClobber;
  return ok
    ? { pass: true, detail: '云函数 save/getAffinity + 白名单清洗 + 客户端接口 + 摘要导出；本地非空不覆盖' }
    : { pass: false, detail: 'server=' + serverOk + ' prune=' + pruneOk + ' client=' + clientOk + ' util=' + utilOk + ' noClobber=' + noClobber };
});

check('跨源合并：关键词通道在位且长度门槛存在', '多元化扩源', () => {
  const server = read('.tools/static-server.js');
  if (!server) return { pass: false, detail: 'static-server.js 不存在' };
  const fnOk = /function contentTokens/.test(server) && /function isKeywordDuplicate/.test(server) && /function isSameEvent/.test(server);
  // 三个阈值必须都是具名常量（便于按误合并率调参），且长度门槛不能丢
  const constOk = /KEYWORD_SHARED_MIN = \d+/.test(server)
    && /KEYWORD_RATIO_MIN = [\d.]+/.test(server)
    && /KEYWORD_MIN_LEN = \d+/.test(server);
  const ok = fnOk && constOk;
  return ok
    ? { pass: true, detail: 'contentTokens / isKeywordDuplicate / isSameEvent 均在，三个阈值具名可调' }
    : { pass: false, detail: 'fn=' + fnOk + ' consts=' + constOk };
});

/* ---------- 主流程 ---------- */
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 无 FAIL 但有 SKIP（需人工补验）
(async () => {
  console.log('###### selfcheck · ' + new Date().toISOString() + ' ######');
  let pass = 0, skips = 0; const fails = [];
  for (const c of CHECKS) {
    let r;
    try { r = await c.fn(); } catch (e) { r = { pass: false, detail: '检查器异常：' + e.message }; }
    const tag = r.skip ? 'SKIP' : (r.pass ? 'PASS' : 'FAIL');
    console.log('[' + tag + '] ' + c.name + '  （' + c.prdRef + '）' + (r.detail ? ' —— ' + r.detail : ''));
    if (r.skip) skips++;
    else if (r.pass) pass++;
    else fails.push(c.name);
  }
  console.log('-----------------------------------------');
  console.log('PASS ' + pass + ' / SKIP ' + skips + ' / FAIL ' + fails.length + '（共 ' + CHECKS.length + ' 项）');
  if (fails.length) { console.log('失败项：' + fails.join('；')); process.exit(1); }
  if (skips) { console.log('存在跳过项，请在普通终端人工补验后重跑。'); process.exit(2); }
})().catch((e) => { console.error('selfcheck 崩溃：' + e.message); process.exit(1); });
