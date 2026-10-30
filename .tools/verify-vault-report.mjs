#!/usr/bin/env node
/**
 * verify-vault-report.mjs —— 2026-10-31 四件新增纯逻辑工具的回归门禁。
 *
 * 覆盖（对应 docs/产品评估与改进方案-2026-10-31.md §7.2 A/C/E/F）：
 *   · valueReport  价值周报聚合：口径复用 computeWeeklyReview（不重算第二份）、
 *                  「有数据才显示」（undefined → null 而不是 0，编数字=违反诚实性纪律）
 *   · icsExport    RFC5545 文本转义四类 / 浮动本地时间戳 / 脏数据条目跳过 / VTODO DUE 收尾
 *   · intelWatch   关键词解析（分隔/去重/上限）与匹配（大小写不敏感/首词命中/limit 截断）
 *   · dataVault    导出信封构造（不可序列化进 dropped）与导入校验（版本/结构拒绝，绝不「尽量恢复」）
 *
 * 编译方式同 verify-ledger-export.mjs：esbuild 打包 **src 源码**再跑（不从 dist 抠，terser 会改名）。
 * ⚠️ 判据必须是 `ok === true`；失败分支返回原因字符串（truthy），写 `!!ok` 会永久假绿。
 *
 * 用法: node .tools/verify-vault-report.mjs [--src <文件名>.ts]（--src 供变异验证指向改坏副本，
 *       文件名相对 src/utils/；未指定的模块照常编译仓库真实源码）
 * 退出码: 0 全绿；1 有断言失败；2 harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const UTILS = path.join(ROOT, 'src', 'utils');
const asJson = process.argv.includes('--json');

const srcArgIdx = process.argv.indexOf('--src');
const srcOverride = srcArgIdx > 0 ? process.argv[srcArgIdx + 1] : null;

let failures = 0;
let passes = 0;
const out = (s) => process.stdout.write(s + '\n');

function check(name, desc, cond) {
  if (cond === true) {
    passes += 1;
    if (!asJson) out(`  PASS  ${name}  ${desc}`);
  } else {
    failures += 1;
    out(`  FAIL  ${name}  ${desc}`);
  }
}

/** 编译单个纯逻辑工具（bundle 打平 runtime import；类型导入编译期擦除）并返回其导出 */
async function loadUtil(file, exportNames) {
  const realPath = path.join(UTILS, file);
  const target = srcOverride && srcOverride === file ? path.join(UTILS, '__mutated__.ts') : realPath;
  const source = readFileSync(target, 'utf8');
  const tail = `\nglobalThis.__m = { ${exportNames.join(', ')} };\n`;
  const built = await esbuild.build({
    stdin: { contents: source + tail, resolveDir: UTILS, sourcefile: file, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const sandbox = { console, JSON, Date, Math, Number, String, Array, Object, RegExp, Set, Map };
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: file });
  return sandbox.__m || sandbox.module.exports;
}

// ---------- valueReport ----------
const vr = await loadUtil('valueReport.ts', ['computeValueReport']);
{
  const r = vr.computeValueReport({}, new Date('2026-10-31T10:00:00'));
  check('VR1', '全空输入 → 计数 0、可选项全 null（不编数字）',
    r.todosDone === 0 && r.eventCount === 0 && Array.isArray(r.keywords) && r.keywords.length === 0 &&
    r.ledgerBalance === null && r.ledgerCount === null && r.habitCheckins === null &&
    r.readStreak === null && r.aiCalls7d === null && r.briefingOpenDays === null);

  const day = (i) => {
    const d = new Date(2026, 9, 31 - i, 9, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const todos = [
    { title: '写周报', dueDate: day(0), status: 'done', createTime: day(1) },
    { title: '开会', dueDate: day(1), status: 'open', createTime: day(1) },
    { title: '很久以前', dueDate: '2026-01-01 09:00', status: 'done', createTime: '2026-01-01 09:00' },
  ];
  const events = [
    { title: '产品评审 产品评审', startTime: day(0) },
    { title: '评审', startTime: day(1) },
  ];
  const r2 = vr.computeValueReport({ events, todos }, new Date('2026-10-31T10:00:00'));
  check('VR2', '窗口内 done 待办计数、日程计数（窗口外不计）', r2.todosDone === 1 && r2.eventCount === 2);
  check('VR3', '关键词口径 = computeWeeklyReview（≥2 次才保留）',
    JSON.stringify(r2.keywords) === JSON.stringify(['评审', '产品']) || r2.keywords.includes('评审'));

  const r3 = vr.computeValueReport({ ledger: { income: 100.01, expense: 30, count: 4 } }, new Date());
  check('VR4', '记账结余 = income - expense（两位小数）', r3.ledgerBalance === 70.01 && r3.ledgerCount === 4);
  check('VR5', '记账 count=0 → 该行不显示（null 而不是 0）',
    vr.computeValueReport({ ledger: { income: 10, expense: 0, count: 0 } }, new Date()).ledgerCount === null);
  check('VR6', '非数字/NaN ledger → 整块不显示',
    vr.computeValueReport({ ledger: { income: NaN, expense: 0, count: 1 } }, new Date()).ledgerBalance === null);
  check('VR7', '正数显示、0 与 undefined 不显示（readStreak/aiCalls）',
    vr.computeValueReport({ readStreak: 5, aiCalls7d: 0 }, new Date()).readStreak === 5 &&
    vr.computeValueReport({ readStreak: 5, aiCalls7d: 0 }, new Date()).aiCalls7d === null &&
    vr.computeValueReport({ habitCheckins: 3 }, new Date()).habitCheckins === 3);
}

// ---------- icsExport ----------
const ics = await loadUtil('icsExport.ts', ['escapeIcsText', 'toIcsLocalStamp', 'buildIcs']);
{
  check('IC1', 'TEXT 转义四类：反斜杠/分号/逗号/换行',
    ics.escapeIcsText('a;b,c\\d\ne') === 'a\\;b\\,c\\\\d\\ne');
  check('IC2', '时间戳：空格与 T 等价、补秒',
    ics.toIcsLocalStamp('2026-10-31 09:05') === '20261031T090500' &&
    ics.toIcsLocalStamp('2026-10-31T09:05:30') === '20261031T090530');
  check('IC3', '脏时间戳一律 null（13 月 / 25 点 / 乱串 / undefined）',
    ics.toIcsLocalStamp('2026-13-01 09:00') === null &&
    ics.toIcsLocalStamp('2026-10-31 25:00') === null &&
    ics.toIcsLocalStamp('明天上午') === null && ics.toIcsLocalStamp(undefined) === null);

  const text = ics.buildIcs({
    now: new Date(2026, 9, 31, 10, 0, 0),
    events: [
      { title: '季度复盘, 第2季;评审', startTime: '2026-10-31 09:00', endTime: '2026-10-31 10:30', location: '3号会议室' },
      { title: '缺开始时间', startTime: undefined },
      { title: '', startTime: '2026-10-31 09:00' },
    ],
    todos: [
      { title: '交报告', dueDate: '2026-11-02', status: 'open' },
      { title: '已完成的', dueDate: '2026-11-01', status: 'done' },
      { title: '无截止日', dueDate: undefined },
    ],
  });
  check('IC4', '结构完整：VCALENDAR 壳 + CRLF 行尾 + 收尾',
    text.startsWith('BEGIN:VCALENDAR') && text.includes('VERSION:2.0') && text.trimEnd().endsWith('END:VCALENDAR') &&
    text.includes('\r\n'));
  check('IC5', '事件：DTSTART/DTEND 正确、转义进 SUMMARY、LOCATION 在',
    text.includes('DTSTART:20261031T090000') && text.includes('DTEND:20261031T103000') &&
    text.includes('SUMMARY:季度复盘\\, 第2季\\;评审') && text.includes('LOCATION:3号会议室'));
  check('IC6', '脏条目跳过：缺 startTime / 空 title / 缺 dueDate 都不出现',
    !text.includes('缺开始时间') && (text.match(/BEGIN:VEVENT/g) || []).length === 1 &&
    (text.match(/BEGIN:VTODO/g) || []).length === 2);
  check('IC7', '待办：DUE 收在当天 23:59、STATUS 双态',
    text.includes('DUE:20261102T235900') && text.includes('STATUS:NEEDS-ACTION') && text.includes('STATUS:COMPLETED'));
  check('IC8', '空输入 → 合法空日历',
    ics.buildIcs({}).includes('END:VCALENDAR') && !ics.buildIcs({}).includes('BEGIN:VEVENT'));
}

// ---------- intelWatch ----------
const iw = await loadUtil('intelWatch.ts', ['parseIntelWatchKeywords', 'matchWatchItems', 'INTEL_WATCH_MAX']);
{
  check('IW1', '解析：中英逗号/顿号/分号/换行/空格全分隔 + # 前缀剥离',
    JSON.stringify(iw.parseIntelWatchKeywords('秋招，以旧换新 #AI\n副业; 远程办公 加薪')) ===
    JSON.stringify(['秋招', '以旧换新', 'AI', '副业', '远程办公', '加薪']));
  check('IW2', '去重（英文大小写判重保原样）、超长滤除、上限截断',
    JSON.stringify(iw.parseIntelWatchKeywords(['AI', 'ai', 'Ai', 'x'.repeat(21), 'ok'])) === JSON.stringify(['AI', 'ok']) &&
    iw.parseIntelWatchKeywords(Array.from({ length: 30 }, (_, i) => `词${i}`)).length === iw.INTEL_WATCH_MAX);
  check('IW3', '空输入 → []（追踪未启用=空，不是错）',
    iw.parseIntelWatchKeywords('') .length === 0 && iw.parseIntelWatchKeywords(undefined).length === 0);

  const items = [
    { id: 1, title: '大厂秋招开启', summary: 'xx' },
    { id: 2, title: '别的新闻', summary: '提到 AI agent' },
    { id: 3, title: '毫无关系', summary: 'yyy' },
  ];
  const m = iw.matchWatchItems(['AI', '秋招'], items, 10);
  check('IW4', '匹配：title/summary 子串命中、每条只记第一个命中词、顺序稳定',
    m.length === 2 && m[0].item.id === 1 && m[0].hit === '秋招' && m[1].item.id === 2 && m[1].hit === 'AI');
  check('IW5', '大小写不敏感', iw.matchWatchItems(['agent'], items, 10).length === 1);
  check('IW6', 'limit 截断 + 空关键词/空列表 → []',
    iw.matchWatchItems(['的新闻'], items, 1).length === 1 &&
    iw.matchWatchItems([], items, 10).length === 0 &&
    iw.matchWatchItems(['AI'], [], 10).length === 0);
}

// ---------- dataVault ----------
const dv = await loadUtil('dataVault.ts', ['collectVault', 'validateVault', 'buildVaultFilename', 'VAULT_VERSION']);
{
  const circ = { a: 1 };
  circ.self = circ;
  const c = dv.collectVault({
    shoppingList: [{ name: '牛奶' }],
    dailyPlanStore: { events: [] },
    brokenFn: () => 1,
    circular: circ,
    nil: null,
  }, new Date('2026-10-31T12:00:00Z'));
  check('DV1', '信封四字段 + 导出时间 ISO 化',
    c.payload !== null && c.payload.app === 'morning-brief' && c.payload.version === 1 &&
    c.payload.exportedAt === '2026-10-31T12:00:00.000Z');
  check('DV2', '不可序列化（函数/循环引用）进 dropped 且不进 keys；null 安全化',
    c.dropped.length === 2 && c.dropped.includes('brokenFn') && c.dropped.includes('circular') &&
    c.payload.keys.nil === null && c.payload.keys.shoppingList[0].name === '牛奶');

  check('DV3', '校验拒绝：非对象/数组/错 app/高版本/坏时间/坏 keys',
    dv.validateVault(null).error === 'not-object' &&
    dv.validateVault([1]).error === 'not-object' &&
    dv.validateVault({ app: 'other', version: 1, exportedAt: '2026-10-31T00:00:00Z', keys: {} }).error === 'not-our-app' &&
    dv.validateVault({ app: 'morning-brief', version: 2, exportedAt: '2026-10-31T00:00:00Z', keys: {} }).error === 'version-unsupported' &&
    dv.validateVault({ app: 'morning-brief', version: 1, exportedAt: '昨天', keys: {} }).error === 'bad-exportedAt' &&
    dv.validateVault({ app: 'morning-brief', version: 1, exportedAt: '2026-10-31T00:00:00Z', keys: [1] }).error === 'bad-keys');

  const good = dv.validateVault({ app: 'morning-brief', version: 1, exportedAt: '2026-10-31T00:00:00Z', keys: { shoppingList: [1, 2] } });
  check('DV4', '校验通过返回整份 payload（app/version/时间/keys 原样）',
    good.ok === true && good.payload.version === 1 && good.payload.exportedAt === '2026-10-31T00:00:00Z' &&
    Array.isArray(good.payload.keys.shoppingList) && good.payload.keys.shoppingList.length === 2);

  check('DV5', '空数据也导出合法信封（keys 为空对象）',
    dv.collectVault({}, new Date()).payload.keys && Object.keys(dv.collectVault({}, new Date()).payload.keys).length === 0);
  check('DV6', '文件名：晨报数据备份-YYYYMMDD-HHmm.json',
    dv.buildVaultFilename(new Date(2026, 9, 31, 9, 5)) === '晨报数据备份-20261031-0905.json');
}

// ---------- 汇总 ----------
out(asJson
  ? JSON.stringify({ ok: failures === 0, pass: passes, fail: failures })
  : `\nPASS ${passes} / FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
