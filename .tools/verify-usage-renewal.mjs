#!/usr/bin/env node
/**
 * verify-usage-renewal.mjs —— 「功能记账 + 续费管理」的行为回归（2026-10-24 新增）
 *
 * 为什么需要这一层：
 *   这两个功能都属于「不报错、但静默错得很彻底」的类型 ——
 *   · 记账口径错了（把降级 mock 也记上），用户看到的用量是假的，而且**越用越离谱**；
 *   · 续费判定错了（今天到期判成已过期），用户会在还有效时看到「已过期」。
 *   二者都不会抛异常、也不会让页面白屏，靠人点一遍很难发现，必须用运行时断言锁住。
 *
 * 分组：
 *   A. utils/featureUsage.ts —— 洗数据 / 累加 / 裁剪 / 汇总（纯逻辑，esbuild + vm）
 *   B. utils/renewal.ts      —— 状态判定 / 天数 / 提醒节流（纯逻辑）
 *   C. 接线 —— 只记**真实路径**：mock 分支、失败分支一律不许记（读源码 + 框到具体分支）
 *   D. UI 契约 —— 页面真的渲染了、文案中英齐全、颜色对比度算得出来 ≥4.5
 *   E. 云同步 —— feature-usage 在 SYNC_KEYS 里、占位是对象、sync.key.* 中英标签齐全
 *
 * 用法: node .tools/verify-usage-renewal.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARO_STUB = path.join(ROOT, '.tools', 'stubs', 'stub-taro-storage.cjs');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;

/** 断言铁律：cond 必须是 boolean，非 boolean 直接抛（防 `assert('...')` 这种假绿） */
function assert(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new Error(`断言「${name}」的 cond 不是 boolean，而是 ${typeof cond}：${String(cond)}`);
  }
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

async function loadModule(relPath) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    alias: { '@tarojs/taro': TARO_STUB },
    logLevel: 'silent'
  });
  const code = built.outputFiles[0].text;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    JSON,
    Math
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relPath });
  return sandbox.module.exports;
}

/** 取某个类名的所有 scss 规则体（与 verify-contrast-strong.mjs 同一套口径） */
function blocksOf(src, className) {
  const re = new RegExp(`(^|\\n)[ \\t]*\\.${className}\\s*\\{`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** 剥 scss 注释：比"某字符串是否出现"时先剥，否则解释性注释会自己命中自己 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ---------------- WCAG 对比度（真算，不是比对字符串） ---------------- */
const hex2rgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1
  };
};
const lum = (c) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const over = (src, dst) => ({
  r: src.r * src.a + dst.r * (1 - src.a),
  g: src.g * src.a + dst.g * (1 - src.a),
  b: src.b * src.a + dst.b * (1 - src.a),
  a: 1
});
const ratio = (a, b) => {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const round2 = (n) => Math.round(n * 100) / 100;

/* ================================================================== */
/* A. featureUsage：洗数据 / 累加 / 裁剪 / 汇总                          */
/* ================================================================== */
section('A. utils/featureUsage.ts');
const fu = await loadModule('src/utils/featureUsage.ts');
const TODAY = '2026-10-24';

{
  // A1 洗脏数据：云同步会把各种东西写回来，一次脏值不洗掉会永久污染展示
  const dirty = {
    [TODAY]: { chat: 3, extract: 0, voice: -2, search: 'abc', hack: 9 },
    'not-a-day': { chat: 100 },
    '2026-02-31': { chat: 5 }, // 非法日期（会被 dayjs 顺延成 3-03），必须丢
    '2026-10-20': { chat: 1 }
  };
  const clean = fu.parseBuckets(dirty);
  assert('A1 非法日期键被丢弃（not-a-day / 2026-02-31）',
    !('not-a-day' in clean) && !('2026-02-31' in clean));
  assert('A1 未知功能字段与负数/非数字被丢弃，合法的 chat 保留',
    clean[TODAY] && clean[TODAY].chat === 3 && !('hack' in clean[TODAY]) &&
      !('voice' in clean[TODAY]) && !('search' in clean[TODAY]));
  assert('A1 0 值不落库（省同步体积）', !('extract' in clean[TODAY]));
  assert('A1 非对象整体输入 → 空账本（不是抛错、也不是返回原值）',
    Object.keys(fu.parseBuckets('oops')).length === 0 && Object.keys(fu.parseBuckets([1, 2])).length === 0);
}

{
  // A2 bump 是纯函数 + 同日累加
  const base = { [TODAY]: { chat: 1 } };
  const next = fu.bump(base, TODAY, 'chat', 2);
  assert('A2 bump 不改入参（纯函数）', base[TODAY].chat === 1);
  assert('A2 同日同功能累加 = 3', next[TODAY].chat === 3);
  assert('A2 新增功能不覆盖已有功能',
    fu.bump(base, TODAY, 'extract')[TODAY].chat === 1 &&
      fu.bump(base, TODAY, 'extract')[TODAY].extract === 1);
  assert('A2 非法日期不写入',
    Object.keys(fu.bump({}, 'x', 'chat')).length === 0);
  assert('A2 非法次数不写入',
    Object.keys(fu.bump({}, TODAY, 'chat', 0)).length === 0);
}

{
  // A3 裁剪：窗口外 + 未来日期都要掉（未来日期会让"今天"永远查不到）
  const map = {
    '2026-10-24': { chat: 1 },
    '2026-10-18': { chat: 1 }, // 距今 6 天，留
    '2026-08-01': { chat: 1 }, // 远超窗口，删
    '2026-12-01': { chat: 1 } // 未来（时钟被调过），删
  };
  const pruned = fu.prune(map, TODAY, 7);
  assert('A3 窗口内保留（今天 + 6 天前）', '2026-10-24' in pruned && '2026-10-18' in pruned);
  assert('A3 窗口外被裁掉（60 天外的老数据）', !('2026-08-01' in pruned));
  assert('A3 未来日期被裁掉（否则"今天"永远查不到记录）', !('2026-12-01' in pruned));
}

{
  // A4 汇总：边界必须是"含今天在内 7 天"，第 8 天不算
  const map = {
    '2026-10-24': { chat: 2, voice: 1 }, // 今天
    '2026-10-18': { chat: 4 }, // 第 7 天（含）
    '2026-10-17': { chat: 8 } // 第 8 天（不含）
  };
  const s = fu.summarize(map, TODAY);
  assert('A4 今日 chat=2 voice=1', s.today.chat === 2 && s.today.voice === 1);
  assert('A4 今日合计 = 3', s.todayTotal === 3);
  assert('A4 近 7 天含第 7 天、不含第 8 天：chat = 2+4 = 6', s.week.chat === 6);
  assert('A4 近 7 天合计 = 7', s.weekTotal === 7);
  assert('A4 四项永远齐全（没用到的是 0，不是 undefined）',
    fu.FEATURES.every((f) => typeof s.week[f] === 'number'));
}

assert('A5 FEATURES 顺序稳定（UI 展示顺序依赖它）',
  fu.FEATURES.join(',') === 'chat,extract,voice,search');

/* ================================================================== */
/* B. renewal：状态判定 / 天数 / 提醒节流                                */
/* ================================================================== */
section('B. utils/renewal.ts');
const rn = await loadModule('src/utils/renewal.ts');

{
  const none = rn.resolveRenewal({ subscribed: false, expiredAt: '2026-11-01', today: TODAY });
  assert('B1 未订阅 → status=none', none.status === 'none');
  assert('B1 未订阅时 daysLeft 必须是 null（不许编一个数字出来）', none.daysLeft === null);
  assert('B1 未订阅时不提醒', none.remind === false);
  // 未订阅落到 statusActive 会给没订阅的人显示「订阅有效」（甚至「有效 n 天」）—— 编事实。
  assert('B1b 未订阅的文案键必须是 statusNone（落到 statusActive 就是编一个「订阅有效」）',
    rn.copyKeyOf(none) === 'statusNone');

  assert('B2 到期日非法（空串/undefined/2026-02-31）→ none',
    rn.resolveRenewal({ subscribed: true, expiredAt: '', today: TODAY }).status === 'none' &&
      rn.resolveRenewal({ subscribed: true, today: TODAY }).status === 'none' &&
      rn.resolveRenewal({ subscribed: true, expiredAt: '2026-02-31', today: TODAY }).status === 'none');

  const active = rn.resolveRenewal({ subscribed: true, expiredAt: '2026-11-08', today: TODAY });
  assert('B3 15 天后到期 → active，且不提醒', active.status === 'active' && active.remind === false && active.daysLeft === 15);

  const edge8 = rn.resolveRenewal({ subscribed: true, expiredAt: '2026-11-01', today: TODAY });
  assert('B4 恰好 8 天 → 仍 active（提醒窗口是 ≤7 天）', edge8.status === 'active' && edge8.daysLeft === 8);

  const edge7 = rn.resolveRenewal({ subscribed: true, expiredAt: '2026-10-31', today: TODAY });
  assert('B4 恰好 7 天 → expiring 且要提醒', edge7.status === 'expiring' && edge7.daysLeft === 7 && edge7.remind === true);

  const today0 = rn.resolveRenewal({ subscribed: true, expiredAt: TODAY, today: TODAY });
  assert('B5 今天到期 → expiring 而不是 expired（当天仍有效）',
    today0.status === 'expiring' && today0.daysLeft === 0);
  assert('B5 今天到期的文案键是 statusToday', rn.copyKeyOf(today0) === 'statusToday');

  const expired = rn.resolveRenewal({ subscribed: true, expiredAt: '2026-10-20', today: TODAY });
  assert('B6 已过期 → status=expired，daysLeft=-4，且要提醒',
    expired.status === 'expired' && expired.daysLeft === -4 && expired.remind === true);
  assert('B6 过期文案键是 statusExpired', rn.copyKeyOf(expired) === 'statusExpired');

  assert('B7 带时间的 ISO 串取前 10 位（服务端 expiredAt 是 ISO）',
    rn.resolveRenewal({ subscribed: true, expiredAt: '2026-11-01T00:00:00.000Z', today: TODAY }).daysLeft === 8);

  assert('B8 同一天重复进页面只提醒一次', rn.shouldRemind(TODAY, TODAY, edge7) === false);
  assert('B8 换一天会再次提醒', rn.shouldRemind('2026-10-23', TODAY, edge7) === true);
  assert('B8 从未提醒过 → 提醒', rn.shouldRemind('', TODAY, edge7) === true);
  assert('B8 不需要提醒时永远不提醒（active 的 info）',
    rn.shouldRemind('', TODAY, active) === false);
}

/* ================================================================== */
/* C. 接线：只记真实路径，mock / 失败分支一律不记                        */
/* ================================================================== */
section('C. 记账接线（源码断言，框到具体分支）');

{
  const cloud = read('src/services/cloud.ts');

  // C1 callFunction('chat'|'extract') 的成功分支里有 recordUsage
  const okIdx = cloud.indexOf('if (ai) {');
  const mockIdx = cloud.indexOf('fallback to mock: ${name}');
  const recIdx = cloud.indexOf("recordUsage(name === 'chat' ? 'chat' : 'extract')");
  assert('C1 找到 AI 成功分支与 mock 分支（harness 前提）', okIdx > -1 && mockIdx > -1);
  assert('C1 recordUsage 落在 if(ai) 分支内、且在 mock 分支之前',
    recIdx > okIdx && recIdx < mockIdx);
  // 反向：mock 分支（`markDegraded(name)` 之后那段）里不许再出现 recordUsage
  const afterMock = cloud.slice(mockIdx, cloud.indexOf('return mockModule.default(data) as T', mockIdx));
  assert('C1 mock 降级分支内没有任何 recordUsage（记了就是虚报用量）',
    afterMock.length > 0 && !afterMock.includes('recordUsage'));

  // C2 流式路径：只在拿到 res 之后记 —— 必须框到**函数体内**再判，
  // 否则「守卫之前多插一次 recordUsage」这种变异照样能过（守卫之后那次还在）。
  // 注意：本仓 CRLF 混存，先归一再用 '\n}' 找顶层闭合（内层闭合都是缩进的）。
  const cloudN = cloud.replace(/\r\n/g, '\n');
  const streamFn = cloudN.indexOf('export async function chatCloudStream(');
  const streamEnd = cloudN.indexOf('\n}', streamFn);
  const streamBody = streamFn > -1 && streamEnd > streamFn ? cloudN.slice(streamFn, streamEnd + 2) : '';
  const streamOk = streamBody.indexOf('const res = await chatViaCloudLlm({ message, deep, memories })');
  const streamGuard = streamBody.indexOf('if (!res) return null', streamOk);
  const streamRec = streamBody.indexOf("recordUsage('chat')");
  const streamRecCount = streamBody.split("recordUsage('chat')").length - 1;
  assert('C2 流式对话在 if(!res) return null 之后才记账（空回包不算消耗）',
    streamFn > -1 && streamOk > -1 && streamGuard > streamOk && streamRec > streamGuard);
  assert('C2 流式函数体内 recordUsage(chat) 只出现一次（两次 = 同一次调用计两笔）',
    streamRecCount === 1);
}

{
  const api = read('src/services/api.ts');
  const fnStart = api.indexOf('export async function apiNewsSearch');
  const body = api.slice(fnStart, api.indexOf('/** 资讯反馈', fnStart));
  const successIdx = body.indexOf('payload.code === 0');
  const recIdx = body.indexOf("recordUsage('search')");
  const nullIdx = body.indexOf('return null');
  assert('C3 全网搜索只在 code===0 的 JSON 路径里记账',
    fnStart > -1 && recIdx > successIdx && recIdx < nullIdx);
  // 失败分支（catch 里）不许记
  const catchPart = body.slice(body.indexOf('catch (err)'));
  assert('C3 搜索失败/异常分支不记账（失败不是消耗）', !catchPart.includes('recordUsage'));
}

{
  // 2026-10-27：语音记账随 AI 对话搬进 AiAssistant（晨报页底部输入栏已撤）。
  // 判据不变：记账必须发生在 H5 守卫之后，且与月度额度计数同源。
  const bp = read('src/components/AiAssistant/index.tsx');
  const guard = bp.indexOf('if (!isWeapp) {');
  const voiceRec = bp.indexOf("recordUsage('voice')");
  const bump = bp.indexOf('bumpVoiceUsage();');
  assert('C4 语音记账在 H5 守卫之后（H5 没有转写能力，不该记语音消耗）',
    guard > -1 && voiceRec > guard);
  assert('C4 语音记账与月度额度计数在同一处（两套口径同源）',
    bump > -1 && Math.abs(voiceRec - bump) < 400);
}

/* ================================================================== */
/* D. UI 契约：真的渲染了 / 文案中英齐全 / 颜色算得出来                    */
/* ================================================================== */
section('D. 会员中心 UI 与配色');

{
  // 2026-10-27：额度卡与续费管理随交易区搬到「会员中心」页（我的页只留身份与偏好）。
  // 判据一字未改，只换锚点文件。
  const mine = read('src/pages/membership/index.tsx');
  assert('D1 额度卡渲染「功能记账」标题与四项明细',
    mine.includes("t('mine.usageTitle')") && mine.includes('FEATURES.map(') &&
      mine.includes('FEATURE_LABEL_KEY[f]'));
  assert('D1 记账有时间范围标签与"只记真实调用"的说明（不许让用户以为在监控内容）',
    mine.includes("t('mine.usageWeek')") && mine.includes("t('mine.usageNote')"));
  assert('D1 空账本走独立空态（不是把 0 渲染成一条记录）', mine.includes("t('mine.usageEmpty')"));

  // D2 续费块**必须无条件渲染**。这不是风格偏好：
  // H5 的 buildProfileFromSession 把 subscribed 硬编码为 false（无订阅态来源），
  // 若按「有订阅才显示」收起，这块在**唯一能跑的形态里就是不可达代码** —— 永远看不到、也永远测不到。
  assert('D2 续费块无条件渲染（没订阅也要看到「不会自动扣费」）',
    mine.includes('<View className={styles.renewBlock}>') &&
      !mine.includes("{renewal.status !== 'none' ? ("));
  assert('D2 续费块有状态徽标 + 到期日 + 提醒开关 + 不自动续费说明',
    mine.includes('{renewalStatusText}') && mine.includes("t('mine.renewUntil'") &&
      mine.includes('onChange={(e) => handleToggleRemind') && mine.includes("t('mine.renewNoAuto')"));
  // none 态不许给日期/开关：daysLeft 是 null，编个日期出来就是假信息
  const noneHintIdx = mine.indexOf("t('mine.renewNoneHint')");
  const untilIdx = mine.indexOf("t('mine.renewUntil'");
  assert('D2 未订阅时给的是「没有订阅」的说明，不是到期日（不编日期）',
    noneHintIdx > -1 && untilIdx > noneHintIdx);
  // ⚠️ 锚点必须带 `{`：上一行的守卫是 `{renewal.status === 'active' || renewal.status === 'none' ? null : (`
  // 它**包含**了下面这个子串，用不带 `{` 的 indexOf 会命中它 → 变异删掉开关守卫也照样 PASS（假绿）。
  const switchGuard = mine.indexOf("{renewal.status === 'none' ? null : (");
  assert('D2 未订阅时不渲染提醒开关（开关只对已订阅的人有意义）',
    switchGuard > -1 && switchGuard < mine.indexOf('styles.renewSwitchRow'));
  assert('D2 提醒受偏好开关控制（关掉就不弹）', mine.includes('if (!renewal.remind || !remindOn) return;'));
  assert('D2 提醒写入"已提示日期"做节流（一天一次）', mine.includes('writeRenewRemindDay(today)'));
}

{
  // D3 i18n 中英齐全：逐个 key 在 zh/en 各出现一次，且值不相同（防"英文里写中文"）
  const langSrc = read('src/store/language.ts');
  const keys = [
    'mine.usageTitle', 'mine.usageToday', 'mine.usageWeek', 'mine.usageEmpty', 'mine.usageNote',
    'mine.fUsageChat', 'mine.fUsageExtract', 'mine.fUsageVoice', 'mine.fUsageSearch',
    'mine.renewMgmtTitle', 'mine.renewStatusNone', 'mine.renewNoneHint',
    'mine.renewStatusActive', 'mine.renewStatusExpiring',
    'mine.renewStatusToday', 'mine.renewStatusExpired', 'mine.renewUntil',
    'mine.renewWarnExpiring', 'mine.renewWarnExpired', 'mine.renewNoAuto',
    'mine.renewRemind', 'mine.renewToast', 'mine.renewToastToday',
    'sync.key.feature-usage'
  ];
  const missing = keys.filter((k) => {
    const hits = langSrc.split(`'${k}':`).length - 1;
    return hits !== 2;
  });
  assert(`D3 ${keys.length} 个新文案键在中英字典里各出现一次（缺/重的：${missing.join(',') || '无'}）`,
    missing.length === 0);
  const dupTitle = langSrc.split(`'mine.renewTitle':`).length - 1;
  assert('D3 没有和既有「确认续费」弹窗的 mine.renewTitle 撞名（撞名 TS1117）', dupTitle === 2);
}

{
  // D4 配色必须真算：续费块压在 --brand-strong 上，浅色卡片用 tertiary
  const scss = stripComments(read('src/pages/mine/index.module.scss'));
  const brandStrong = hex2rgb('#c7371a'); // = theme.scss 的 $color-primary-strong
  const white = hex2rgb('#ffffff');

  const tagText = blocksOf(scss, 'renewTagText')[0] || '';
  const tagBg = blocksOf(scss, 'renewTag')[0] || '';
  const stops = (tagBg.match(/#[0-9a-f]{6}/gi) || []).map(hex2rgb);
  const tagFg = (tagText.match(/#[0-9a-f]{6}/i) || [''])[0];
  const tagWorst = stops.length && tagFg ? Math.min(...stops.map((s) => ratio(hex2rgb(tagFg), s))) : 0;
  assert(`D4 到期徽标：深棕字压金底最坏档 = ${round2(tagWorst)}:1 ≥ 4.5（金色只能配深字）`, tagWorst >= 4.5);

  const idleBg = blocksOf(scss, 'renewTagIdle')[0] || '';
  const idleOverlay = /rgba\(0,\s*0,\s*0,\s*([\d.]+)\)/.exec(idleBg);
  const idleAlpha = idleOverlay ? Number(idleOverlay[1]) : 1;
  const idleComposited = over({ ...hex2rgb('#000000'), a: idleAlpha }, brandStrong);
  const idleRatio = ratio(white, idleComposited);
  assert(`D4 有效态徽标：白字压压暗层 = ${round2(idleRatio)}:1 ≥ 4.5`, idleRatio >= 4.5);

  const until = blocksOf(scss, 'renewUntil')[0] || '';
  const untilA = /rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(until);
  const untilRatio = untilA
    ? ratio(over({ ...white, a: Number(untilA[1]) }, brandStrong), brandStrong)
    : 0;
  assert(`D4 到期日小字：${untilA ? Math.round(Number(untilA[1]) * 100) : 0}% 白压深底 = ${round2(untilRatio)}:1 ≥ 4.5`,
    untilRatio >= 4.5);

  const note = blocksOf(scss, 'usageNote')[0] || '';
  assert('D4 记账说明用 tertiary（#657080 白底 4.9:1），不是禁用灰 #c9cdd4（1.5:1）',
    note.includes('$color-text-tertiary') && !note.includes('$color-text-disabled'));
  const usageName = blocksOf(scss, 'usageName')[0] || '';
  assert('D4 功能名用 secondary（白底 ≈7.5:1）', usageName.includes('$color-text-secondary'));
}

/* ================================================================== */
/* E. 云同步：feature-usage 必须登记且占位类型正确                        */
/* ================================================================== */
section('E. 云同步登记');

{
  const sync = read('src/services/cloudSync.ts');
  const block = sync.slice(sync.indexOf('const SYNC_KEYS = ['), sync.indexOf('] as const;') + 1);
  assert('E1 feature-usage 在 SYNC_KEYS 里（否则换手机账本就是空的）',
    block.includes("'feature-usage'"));
  const placeholders = sync.slice(sync.indexOf('const REMOVE_PLACEHOLDER'), sync.indexOf('};', sync.indexOf('const REMOVE_PLACEHOLDER')));
  assert('E1 删除占位是空对象（写成 \'\' 会让云端旧计数删不掉）',
    /'feature-usage':\s*\{\}/.test(placeholders));
}

console.log('──────────────────────────────────────────────────────────');
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail > 0 ? 1 : 0);
