#!/usr/bin/env node
/**
 * verify-util-logic.mjs —— utils 纯逻辑回归（2026-10-24 审计后新增）。
 *
 * 覆盖两处「不报错、但功能静默失效」的缺陷，二者都属于**看代码很难发现、
 * 跑起来也不会崩**的类型，必须用运行时断言锁住：
 *
 *   A. schedule.computeBufferMinutes 恒返回 0
 *      原实现把 prevGap/nextGap 初始化为 DEFAULT_EDGE_BUFFER_MINUTES(=0) 再 Math.min
 *      收缩 → 只要该侧有日程，间隔必被压成 0 → SCORE_MAX_BUFFER_BONUS(30) 与
 *      reason='buffer' 全是死代码，候选永远按「最早」排，产品规则「别排得背靠背」没实现。
 *      ⇒ 断言：有留白的时段必须真的拿到留白分并排到前面；紧贴前一事件的时段 buffer=0。
 *
 *   B. permission.ensurePermission 一次拒绝记两次
 *      原实现 authorizeWeapp 内写一次记录、ensurePermission 再写一次 → weapp 端
 *      一次拒绝 deniedCount +2，设计值 3 次的降级门槛实际 2 次就触发。
 *      ⇒ 断言：一次拒绝 deniedCount === 1；两次仍未降级；三次才降级。
 *
 * 编译方式同 verify-ledger-aggregate.mjs：esbuild 编译 **src 源码**再跑
 * （不从 dist 抠 —— terser 会重命名局部变量）。Taro 用 .tools/stubs 里的忠实复刻。
 *
 * 用法: node .tools/verify-util-logic.mjs
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

/** 断言铁律：cond 必须是 boolean，非 boolean 直接抛（防止 `assert('...')` 这种假绿） */
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

/**
 * 编译单个 src 模块并在隔离 vm 里求值，返回其 module.exports。
 * Taro 依赖统一 alias 到 .tools/stubs/stub-taro-storage.cjs（忠实复刻 H5 存储语义）。
 */
async function loadModule(relPath, { weapp = false, plugins = [] } = {}) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    alias: { '@tarojs/taro': TARO_STUB, '@': path.join(ROOT, 'src') },
    define: { 'process.env.TARO_ENV': JSON.stringify(weapp ? 'weapp' : 'h5') },
    plugins,
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
  return { mod: sandbox.module.exports, sandbox };
}

/* ================================================================== */
/* A. schedule：留白分必须真的生效                                      */
/* ================================================================== */
section('A. schedule.computeBufferMinutes / 候选排序');

const { mod: schedule } = await loadModule('src/utils/schedule.ts');
const DAY = '2026-10-24';
// 一个 09:00-10:00 的既有日程：十分钟贴边的 10:00 无留白，14:00 有 4h 留白（上限 240）
const EXISTING = [{ id: 'e1', title: '晨会', startTime: `${DAY} 09:00`, endTime: `${DAY} 10:00`, status: 'confirmed' }];
const candidates = schedule.suggestSlotCandidates(`${DAY} 10:00`, `${DAY} 11:00`, EXISTING, {
  limit: schedule.SCAN_NO_LIMIT,
  extended: false
});

const byStart = (t) => candidates.find((c) => c.startTime === `${DAY} ${t}`);
const at10 = byStart('10:00');
const at14 = byStart('14:00');
const at13 = byStart('13:00');

assert('候选表非空（harness 前提）', Array.isArray(candidates) && candidates.length > 0);
assert('10:00 紧贴 09:00-10:00 事件 → bufferMinutes 必须为 0', !!at10 && at10.bufferMinutes === 0);
assert('14:00 距上一事件 4h → bufferMinutes 必须为 240（封顶 MAX_BUFFER_MINUTES）',
  !!at14 && at14.bufferMinutes === 240);
assert('13:00 距上一事件 3h → bufferMinutes 必须为 180', !!at13 && at13.bufferMinutes === 180);
assert('14:00 的 reason 必须是 buffer（留白分 30 > 最早分 10）', !!at14 && at14.reason === 'buffer');
assert('14:00 分数必须高于 10:00（否则留白规则等于没实现）', !!at14 && !!at10 && at14.score > at10.score);
assert('排名第一必须是 14:00（留白最大的可用时段），而不是紧贴事件的 10:00',
  candidates[0].startTime === `${DAY} 14:00`);

// 反向保护：紧贴事件的 10:00 不该拿到留白加成（score 仍应等于 free 基准 + 最早分）
assert('10:00 分数 = 100(基准) + 0(留白) + 18(最早) = 118', !!at10 && at10.score === 118);

/* ================================================================== */
/* B. permission：一次拒绝只记一次                                      */
/* ================================================================== */
section('B. permission 拒绝计数与系统侧撤销');

const { mod: perm, sandbox: permBox } = await loadModule('src/utils/permission.ts', { weapp: true });

// 授权结果由 stub 读取**沙箱内**的 globalThis 标志（不是宿主进程的），故必须设在 permBox 上
const denyAuthorize = () => {
  permBox.__AUTHORIZE_OK__ = false;
};

assert('harness 前提：weapp 分支已生效（ensurePermission / syncWithSystemSetting 可用）',
  typeof perm.ensurePermission === 'function' && typeof perm.recordPermissionResult === 'function');

// B1 一次拒绝 → deniedCount 恰好 +1
denyAuthorize();
const firstDeny = await perm.ensurePermission('microphone');
assert('B1 被拒绝时 ensurePermission 返回 false', firstDeny === false);
assert('B2 一次拒绝 deniedCount === 1（原 bug 会记成 2）', perm.readPermission('microphone').deniedCount === 1);
assert('B3 一次拒绝后仍允许弹说明弹窗（未达 3 次门槛）', perm.shouldShowDialog('microphone') === true);

// B2 第二次拒绝 → 2，仍不该降级
denyAuthorize();
await perm.ensurePermission('microphone');
assert('B4 两次拒绝 deniedCount === 2（原 bug 会是 4、直接降级）', perm.readPermission('microphone').deniedCount === 2);
assert('B5 两次拒绝仍在门槛内（shouldShowDialog 为 true）', perm.shouldShowDialog('microphone') === true);
assert('B6 两次拒绝尚未进入降级态', perm.isDeniedDegraded('microphone') === false);

// B3 第三次拒绝 → 3，此时才降级
denyAuthorize();
await perm.ensurePermission('microphone');
assert('B7 三次拒绝 deniedCount === 3', perm.readPermission('microphone').deniedCount === 3);
assert('B8 三次拒绝后才不再弹窗（shouldShowDialog 为 false）', perm.shouldShowDialog('microphone') === false);
assert('B9 三次拒绝后进入降级态（改渲染提示条 + 去设置）', perm.isDeniedDegraded('microphone') === true);

// B4 同意一次 → 计数清零。
// ⚠️ 必须换一个**未降级**的权限名：microphone 已累计 3 次拒绝，ensurePermission
// 会按设计直接 early-return false（降级后不再打扰用户），根本不会走到 authorize。
permBox.__AUTHORIZE_OK__ = true;
const agreed = await perm.ensurePermission('location');
assert('B10 授权成功返回 true', agreed === true);
assert('B11 授权成功后 agreed=true 且 deniedCount 清零',
  perm.readPermission('location').agreed === true && perm.readPermission('location').deniedCount === 0);

// B5 系统侧撤销 → 状态必须是 denied（原实现返回 unknown，会诱导再次拉系统弹窗）
permBox.__AUTH_SETTING__ = { 'scope.userLocation': false }; // 用户在系统设置里关掉了
const revoked = await perm.syncWithSystemSetting('location');
assert('B12 系统侧撤销后状态为 denied（原 bug 返回 unknown）', revoked === 'denied');
assert('B13 系统侧撤销不累加拒绝计数（用户并非主动拒绝弹窗）',
  perm.readPermission('location').deniedCount === 0 && perm.readPermission('location').agreed === false);

/* ================================================================== */
/* C. 头部问候：内容感知 + 真 i18n（2026-10-24 视觉巡检后新增）           */
/* ================================================================== */
section('C. 晨报头部问候：不谎报 + 双语');

const BRIEFING = readFileSync(path.join(ROOT, 'src/pages/briefing/index.tsx'), 'utf8');
const DATE_TS = readFileSync(path.join(ROOT, 'src/utils/date.ts'), 'utf8');
const LANG = readFileSync(path.join(ROOT, 'src/store/language.ts'), 'utf8');

// C1 原 getGreeting 在 12–14 点写死「下午的日程在这」，当天没日程就是谎报；且硬编码中文。
// 只看 import 语句：源码注释里会解释「原 getGreeting 如何谎报」，用 includes 会误伤注释。
assert('C1 晨报页不再 import getGreeting（谎报 + 假 i18n 的源头已移除）',
  /import\s*\{[^}]*\bgetGreeting\b[^}]*\}\s*from/.test(BRIEFING) === false);
assert('C2 utils/date.ts 不再导出 getGreeting（防止死实现回流）',
  /export function getGreeting/.test(DATE_TS) === false);
assert('C3 头部问候有「数据未到」守卫：briefing 为空时只说时间基调，不得断言今天没有安排',
  /\{?const headerGreeting = !briefing[\s\S]{0,80}greetingBase/.test(BRIEFING) ||
    /!briefing\s*\n?\s*\?/.test(BRIEFING));
// C4 四种事实分支齐备：接下来 / 已结束 / 剩余待办 / 无安排
//   2026-10-30 放宽（为什么改 / 改前是什么行为）：
//   改前：判据要求「无安排」必须以 greet.empty 的形式**待在标题里**。
//   改后：判据只要求「无安排」这个**事实不许消失** —— 要么标题里还有 greet.empty，
//         要么它已明确移交到概览卡的轻量说明（briefing.leanOverview 在页面里被用上，
//         且中英各一份）。
//   为什么改：同一轮重构把「没有安排」从标题里挪走了 —— 概览那一行已经写着同一件事，
//   标题再补一句等于同一件事说两遍，还把标题顶成两行。判据锁死「写在标题里」
//   就成了对实现细节的误判（实测：这条把 verify:util 判红，连带整套变异跑不起来）。
//   判别力不减：两处都拿掉 ⇒ 事实消失 ⇒ 这里照样判红。
assert('C4 四种事实分支齐备：接下来 / 已结束 / 剩余待办 / 无安排',
  ['greet.next', 'greet.allDone', 'greet.todoOnly'].every((k) => BRIEFING.includes(k)) &&
    (BRIEFING.includes('greet.empty') ||
      (BRIEFING.includes('briefing.leanOverview') &&
        (LANG.match(/'briefing\.leanOverview':/g) || []).length === 2)));
assert('C5 时间基调五档齐备（夜/早/午/下午/晚）',
  ['greet.night', 'greet.morning', 'greet.noon', 'greet.afternoon', 'greet.evening'].every((k) =>
    BRIEFING.includes(k)));
assert('C6 九个 greet.* 键中英各一份（18 处定义）',
  ['night', 'morning', 'noon', 'afternoon', 'evening', 'next', 'allDone', 'todoOnly', 'empty'].every(
    (k) => (LANG.match(new RegExp(`'greet\\.${k}':`, 'g')) || []).length === 2
  ));
assert('C7 昵称是邮箱时不展示（上市产品不会用邮箱称呼用户）',
  /displayName[\s\S]{0,120}includes\('@'\)/.test(BRIEFING));

/* ================================================================== */
section('D. cloudStorage：失败必须返回结构化结果，绝不 reject');

/* 为什么这组必须是**行为级**：静态断言只能证明「代码里写了 try/catch」，
 * 证不了「抛出来的那一刻函数真的不 reject」。而这条正是 2026-10-26 发现的真缺陷：
 * SDK 的 userPath() 在发请求前就校验路径并抛 CloudStoragePathError，原实现把它写在 try 外，
 * 异常一路冒到调用方那个没有 catch 的 async 回调 → 用户点了上传**什么都不发生**。
 * 桩必须复刻「userPath 会抛」这个行为（返回 error 就测不出这个 bug）。 */
const AUTH_STUB = path.join(ROOT, '.tools', 'stubs', 'stub-cloud-auth.cjs');
const stubAuthPlugin = {
  name: 'stub-cloud-auth',
  setup(build) {
    // external:true 让 bundle 里留下 require(...) —— 这样测试侧 __setMode 与运行时是**同一个实例**
    // （inline 进 bundle 的话是两份模块，setMode 改不到被测代码看到的那个）。
    build.onResolve({ filter: /(^|\/)cloudAuth$/ }, () => ({ path: AUTH_STUB, external: true }));
  }
};
const { mod: cloudStorage } = await loadModule('src/services/cloudStorage.ts', { plugins: [stubAuthPlugin] });
const authStub = require(AUTH_STUB);

const pngFile = (bytes = 10) => new File([new Uint8Array(bytes)], 'a.png', { type: 'image/png' });
/** 把「reject」也变成一个可断言的值 —— 否则 reject 会让整个 harness 崩掉，看起来像脚本坏了 */
async function settle(promise) {
  try {
    return await promise;
  } catch (e) {
    return { threw: String((e && e.message) || e) };
  }
}

// D1 正常链路：走了 SDK、路径由 userPath 生成在 users/<uid>/ 下
authStub.__reset();
authStub.__setMode('ok');
const d1 = await settle(cloudStorage.uploadAvatar(pngFile()));
assert('D1 正常上传返回对象键且路径在 users/<uid>/ 下（不接受外部拼的键）',
  d1.ok === true && String(d1.path).startsWith('users/user-A/avatars/') && authStub.__calls.upload === 1);

// D2 ★ 回归本体：userPath 抛 CloudStoragePathError 时不得冒泡
authStub.__reset();
authStub.__setMode('path-throw');
const d2 = await settle(cloudStorage.uploadAvatar(pngFile()));
authStub.__setMode('ok');
assert('D2 userPath 抛 CloudStoragePathError 时不冒泡（返回 ok:false；冒泡=点了没反应）',
  d2 && d2.threw === undefined && d2.ok === false);

// D3 upload 返回 error（SDK 的正常失败形态）→ ok:false，且不谎称成功
authStub.__reset();
authStub.__setMode('upload-error');
const d3 = await settle(cloudStorage.uploadAvatar(pngFile()));
authStub.__setMode('ok');
assert('D3 upload 返回 error 时 ok:false 且 reason=failed', d3.ok === false && d3.reason === 'failed');

// D4/D5 签名 URL 取不到（返回 error / 抛）都必须给 null，调用方才能回退默认头像
authStub.__setMode('sign-fail');
const d4 = await settle(cloudStorage.resolveAvatarUrl('users/user-A/avatars/1.png'));
authStub.__setMode('sign-throw');
const d5 = await settle(cloudStorage.resolveAvatarUrl('users/user-A/avatars/1.png'));
authStub.__setMode('ok');
assert('D4 签名返回 error 时给 null（调用方回退默认头像，不塞空 src）', d4 === null);
assert('D5 签名抛错时也给 null（不 reject）', d5 === null);

// D6 删除旧头像失败只留痕，不能影响「换头像」这一步的成功与否
authStub.__setMode('remove-fail');
const d6 = await settle(cloudStorage.deleteAvatar('users/user-A/avatars/1.png'));
authStub.__setMode('ok');
assert('D6 删除失败返回 false 且不抛（最坏结果是孤儿文件）', d6 === false);

// D7/D8 前置条件不满足给**具体** reason，而不是笼统的 failed
// （D7 要断言「未发起上传」，所以必须先清计数 —— 第一版漏了 reset，D1/D3 的计数残留导致假红）
authStub.__reset();
authStub.__setMode('no-session');
const d7 = await settle(cloudStorage.uploadAvatar(pngFile()));
authStub.__setMode('no-storage');
const d8 = await settle(cloudStorage.uploadAvatar(pngFile()));
authStub.__setMode('ok');
assert('D7 无会话时 reason=no-session 且未发起上传', d7.reason === 'no-session' && authStub.__calls.upload === 0);
assert('D8 无 storage 时 reason=no-storage', d8.reason === 'no-storage');

console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail > 0 ? 1 : 0);
