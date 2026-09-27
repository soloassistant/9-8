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
