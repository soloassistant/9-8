#!/usr/bin/env node
/**
 * 交互修复门禁（2026-10-24）
 *
 * 守 5 条用户可见的交互契约，全部来自用户实际反馈：
 *   A. 热点卡片点击必须真正打开原文（原实现只弹「来源：xxx」toast 就结束，点了等于没点）
 *   B. 晨报时间线的时间块不得被长标题压缩（flex-shrink:0 + nowrap）
 *   C. 「联系客服」必须给可执行动作（复制邮箱/公众号），不是一段不可点的静态文本
 *   D. 手机验证码通道（默认）必须有「邮箱密码登录」显式入口
 *   E. 搜索页必须接 webSearch.searchNews（全网），且失败态 ≠ 空态
 *
 * 判据纪律（AGENTS.md）：
 *   · 断言收窄到「哪个函数的哪一段」，不判「文件里出现过某符号」——import 也算，会假绿
 *   · 先剥注释（否则解释性注释会把断言喂饱）
 *   · 一律布尔严格判定，不写 `pass: !!x`
 *   · 读入即把 CRLF 归一成 LF（工作区是 CRLF，锚点写死 \n 会 0 次命中）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond === true) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
};

/* ---------------- A. 热点卡片点击 → 真正打开原文 ---------------- */
const lib = stripComments(read('src/pages/library/index.tsx'));
const tapFn = /const handleNewsTap = \(item: HotspotNews\) => \{([\s\S]*?)\n  \};/.exec(lib);
const tapBody = tapFn ? tapFn[1] : '';
ok('A1 handleNewsTap 函数体可定位', tapBody.length > 0);
ok('A2 函数体内调用 openExternalPage(item.url)', /openExternalPage\(\s*item\.url\s*\)/.test(tapBody));
ok('A3 url 缺失有如实提示（if (!item.url)）', /if\s*\(\s*!item\.url\s*\)/.test(tapBody));
ok(
  'A4 复制态提示带来源（weapp 复制后告知去哪儿打开）',
  /r === 'copied'/.test(tapBody) && /来源：\$\{item\.source\}，链接已复制/.test(tapBody)
);

/* ---------------- B. 时间块不被压缩 ---------------- */
const briefScss = stripComments(read('src/pages/briefing/index.module.scss'));
const timeBlock = /\.timeBlock\s*\{([^}]*)\}/.exec(briefScss);
const timeCls = /\.time\s*\{([^}]*)\}/.exec(briefScss);
ok('B1 .timeBlock 声明 flex-shrink: 0', Boolean(timeBlock) && /flex-shrink:\s*0/.test(timeBlock[1]));
ok('B2 .time 声明 white-space: nowrap', Boolean(timeCls) && /white-space:\s*nowrap/.test(timeCls[1]));

/* ---------------- C. 客服给可执行动作 ---------------- */
const mine = stripComments(read('src/pages/mine/index.tsx'));
const svcFn = /const handleContactService = \(\) => \{([\s\S]*?)\n  \};/.exec(mine);
const svcBody = svcFn ? svcFn[1] : '';
ok('C1 handleContactService 函数体可定位', svcBody.length > 0);
ok('C2 提供可执行动作（showActionSheet）', /showActionSheet\(/.test(svcBody));
ok('C3 一键复制联系方式（setClipboardData）', /setClipboardData\(/.test(svcBody));
ok(
  'C4 TODO 占位时不调用必失败的客服 API（有守卫）',
  /SERVICE_CORP_ID !== 'TODO_CORP_ID'/.test(svcBody)
);

/* ---------------- D. 手机号密码登录（2026-10-25：从「切邮箱」绕行入口升为手机通道真实页签） ---------------- */
const login = stripComments(read('src/pages/login/index.tsx'));
ok('D1 手机通道页签含密码登录（otp, password, signup）', /channel === 'phone' \? \['otp', 'password', 'signup'\]/.test(login));
ok('D2 密码登录标识随通道取值（currentId：手机号 E.164 / 邮箱）', /signInWithPassword\(currentId\(\), password\)/.test(login));
ok('D3 旧的「切邮箱」绕行入口已移除', !/passwordHint/.test(login));
const loginScss = stripComments(read('src/pages/login/index.module.scss'));
ok('D4 passwordHint 样式已删除', !/\.passwordHint\s*\{/.test(loginScss));

/* ---------------- E. 搜索接全网 + 失败态独立 ---------------- */
const search = stripComments(read('src/pages/search/index.tsx'));
ok('E1 搜索页调用 apiNewsSearch', /apiNewsSearch\(/.test(search));
ok('E2 失败态独立置位（setWebFailed(true)）', /setWebFailed\(true\)/.test(search));
ok('E3 null 与空数组分开处理（失败 ≠ 空）', /items === null/.test(search));
ok('E4 全网结果可打开原文（openExternalPage）', /openExternalPage\(/.test(search));

/* ---------------- F. 意见反馈：提交结果必须真实，不许谎报成功 ---------------- */
// 用户原话「有问题咋办投诉通道」。这组断言守的是**诚实性**而不是按钮存不存在：
// 只有云端落库成功才能说「已收到」，其余路径一律复制+邮件，且必须当场说明。
const fbFn = /const handleSubmitFeedback = async \(\) => \{([\s\S]*?)\n  \};/.exec(mine);
const fbBody = fbFn ? fbFn[1] : '';
ok('F1 handleSubmitFeedback 函数体可定位', fbBody.length > 0);
ok('F2 空内容有就地提示（不静默返回）', /if \(!content\)/.test(fbBody) && /fbCopy\.emptyHint/.test(fbBody));
const landedBlock = /if \(landed\) \{([\s\S]*?)\n    \}/.exec(fbBody);
const landedBody = landedBlock ? landedBlock[1] : '';
ok(
  'F3 只有 landed 分支才清空并关闭弹层',
  landedBody.length > 0 && /setFbContent\(''\)/.test(landedBody) && /setFbOpen\(false\)/.test(landedBody)
);
ok('F4 landed 分支才出现成功文案（fbCopy.success）', /fbCopy\.success/.test(landedBody));
// 全局只能有一处 success 文案 —— 若未落库分支也报成功，这里会数到 2
ok('F5 全文仅一处「已收到」成功文案', (mine.match(/fbCopy\.success/g) || []).length === 1);
const fbTail = fbBody.split('if (landed)')[1] || '';
ok(
  'F6 未落库路径复制全文并说明去向（复制 + 邮件弹窗，且弹的是失败口径）',
  /setClipboardData\(/.test(fbTail) &&
    /Taro\.showModal\(/.test(fbTail) &&
    /SERVICE_EMAIL/.test(fbTail) &&
    // 收紧点（变异实测）：只判「有 showModal」会被「弹窗标题改成成功文案」骗过，
    // 必须判弹的**是哪一句** —— 未落库路径只能弹 copied/copyFailed 两种标题。
    /copied \? fbCopy\.copiedTitle : fbCopy\.copyFailedTitle/.test(fbTail)
);
ok('F7 关闭弹层不清草稿（误触不丢已写内容）', (() => {
  const line = /const closeFeedback = [^\n]*/.exec(mine);
  return Boolean(line) && !line[0].includes('setFbContent');
})());
ok(
  'F8 仅在提交中禁用按钮（空内容时按下要有 toast 说明）',
  /disabled=\{disabledAttr\(fbSending\)\}/.test(mine) && !/disabledAttr\(fbSending \|\|/.test(mine)
);
ok('F9 反馈入口整行可点（renderRow 第三参数 setFbOpen）', (() => {
  const row = /t\('mine\.service'\)([\s\S]{0,400}?)setFbOpen\(true\)/.exec(mine);
  return Boolean(row);
})());
ok('F10 H5 在提交前就说明实际送达方式', /fbCopy\.h5Note/.test(mine));
// 前端类型白名单与云函数 TYPES 必须逐项一致：单边增删会让云端结构化拒绝
ok('F11 反馈类型白名单与云函数 TYPES 一致', (() => {
  const cloud = stripComments(read('cloudfunctions/feedback/index.js'));
  const t = /const TYPES = \[([^\]]*)\]/.exec(cloud);
  const fe = read('src/pages/mine/feedbackText.ts').match(/id: '([a-z]+)'/g) || [];
  if (!t) return false;
  const a = t[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  const b = fe.map((s) => s.replace(/id: '/, '').replace(/'/, '')).sort();
  return a.length === 4 && a.join(',') === b.join(',');
})());

/* ---------------- G. 天气城市可手动设置（不再「永远是北京」）---------------- */
// user-city 此前只有 GPS 逆地理编码会写；拒绝定位 = 天气静默显示错城市。
const weather = stripComments(read('src/utils/weather.ts'));
const resolveFn = /export async function resolveCityName[\s\S]*?\n\}/.exec(weather);
const resolveBody = resolveFn ? resolveFn[0] : '';
ok('G1 resolveCityName 存在且走 geocoding', resolveBody.length > 0 && /geocoding-api\.open-meteo\.com/.test(resolveBody));
const saveCityFn = /const handleSaveCity = async \(\) => \{([\s\S]*?)\n  \};/.exec(mine);
const saveCityBody = saveCityFn ? saveCityFn[1] : '';
ok('G2 handleSaveCity 函数体可定位', saveCityBody.length > 0);
// 顺序断言：必须先校验、后落库。写反了就是「已保存但天气还是错」
const iResolve = saveCityBody.indexOf('resolveCityName(');
const iStore = saveCityBody.indexOf("setStorageSync('user-city'");
ok('G3 先校验后落库（resolveCityName 在 setStorageSync 之前）', iResolve > -1 && iStore > -1 && iResolve < iStore);
ok('G4 查不到城市时不落库（if (!canonical) 分支在落库之前）', (() => {
  const guard = saveCityBody.indexOf('if (!canonical)');
  // ⚠️ 必须显式要求 iResolve > -1：校验调用被删掉时 iResolve = -1，
  // 只写 `guard > iResolve` 会**恒真**（变异实测：删掉 resolveCityName 后本条仍绿）
  return iResolve > -1 && guard > iResolve && guard < iStore;
})());
ok('G5 存的是规范地名而不是用户原文', /setStorageSync\('user-city', canonical\)/.test(saveCityBody));
ok('G6 未设置时如实标注默认城市', /city \|\| cityCopy\.defaultTag/.test(mine));

/* ---------------- H. 突发新闻横幅：可看、可关、不冒充推送 ---------------- */
// 用户问「如果突发新闻是否有弹窗」。做的是**应用内横幅**：推送通道外部阻塞（模板 ID 空串），
// 所以这组断言重点守「别把标题关键词识别包装成官方通报」。
const burst = stripComments(read('src/components/BurstBanner/index.tsx'));
const burstUtil = stripComments(read('src/utils/burst.ts'));
const pickFn = /export function pickBurst[\s\S]*?\n\}/.exec(burstUtil);
const pickBody = pickFn ? pickFn[0] : '';
ok('H1 pickBurst 在 utils/burst.ts 且无命中返回 null（不退化挑第一条）',
  pickBody.length > 0 && /return null;/.test(pickBody) && !/items\[0\]/.test(pickBody));
// 识别逻辑只许有一份：组件里再写一份副本，改一边就漂移（行为断言会测不到组件那份）
ok('H1b 组件从 utils/burst 引入，不自留副本',
  /from '@\/utils\/burst'/.test(burst) && !/export function pickBurst/.test(burst));
ok('H2 横幅渲染里常驻免责说明（{copy.note}）',
  /styles\.note[\s\S]{0,80}\{copy\.note\}/.test(burst));
ok('H3 关键词表不含标题党词（否则天天亮）',
  !/震惊|揭秘|重磅|终于|炸裂/.test(burst));
const brief = stripComments(read('src/pages/briefing/index.tsx'));
ok('H4 已挂载到晨报页且复用 intelItems（零额外请求）',
  /<BurstBanner items=\{briefing\?\.intel\?\.intelItems\}/.test(brief));
ok('H5 关闭按自然日生效（dismissedOn === today）', /dismissedOn === today/.test(burst));
ok('H6 跳热点页用 switchTab（tabBar 页 navigateTo 必失败）',
  /Taro\.switchTab\(\{ url: '\/pages\/library\/index' \}\)/.test(burst));
ok('H7 不冒充推送（无订阅消息/推送调用）',
  !/requestSubscribeMessage|sendSubscribeMessage|cloud\.openapi/.test(burst));

/* ---------------- I. 突发识别：运行时行为断言（不是「文件里有这个函数」）---------------- */
// 静态断言只能证明「代码里写了关键词表」，证明不了「普通新闻不会触发横幅」。
// 这里把 src/utils/burst.ts 用 esbuild 编译后真调一遍（同 verify-util-logic 的口径）。
async function loadBurst() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/burst.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    logLevel: 'silent'
  });
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON,
    Math,
    Array,
    String
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'src/utils/burst.ts' });
  return sandbox.module.exports;
}

const burstMod = await loadBurst();
const burstPick = burstMod.pickBurst;
ok('I0 pickBurst 可从编译产物取到（typeof function）', typeof burstPick === 'function');
if (typeof burstPick === 'function') {
  const hit = burstPick([
    { text: '今日推荐：三款轻量笔记软件横评', source: '少数派' },
    { text: '四川宜宾发生 4.8 级地震，暂无人员伤亡报告', source: '中国地震台网' }
  ]);
  ok('I1 命中事件词时返回该条', Boolean(hit) && hit.text.includes('地震') && hit.source === '中国地震台网');
  ok('I2 普通新闻不触发（返回 null）', burstPick([{ text: 'iPhone 18 上手体验', source: '爱范儿' }]) === null);
  ok('I3 空数组 / undefined / null 均返回 null',
    burstPick([]) === null && burstPick(undefined) === null && burstPick(null) === null);
  ok('I4 标题党词不触发（不用「震惊/重磅」当判据）',
    burstPick([{ text: '震惊！这款重磅新品终于来了', source: 'x' }]) === null);
  const first = burstPick([
    { text: 'A 台风路径更新', source: 's1' },
    { text: 'B 暴雨橙色预警', source: 's2' }
  ]);
  ok('I5 多条命中取第一条（顺序稳定）', Boolean(first) && first.source === 's1');
  const noSource = burstPick([{ text: '突发：某地发生事故', source: undefined }]);
  ok('I6 source 缺失不抛错且回落空串', Boolean(noSource) && noSource.source === '');
}

console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail === 0 ? 0 : 1);
