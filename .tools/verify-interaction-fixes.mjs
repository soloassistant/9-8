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

/* ---------------- A. 热点卡片点击 → 站内文章视图 + 阅读原文（2026-10-25 演进） ----------------
   旧判据「handleNewsTap 里直接 openExternalPage」已过时：现在点卡片先开站内文章视图
   （读源 feed 自带摘要，合规口径不转载正文），「阅读原文」按钮承接原来的打开语义。 */
const lib = stripComments(read('src/pages/library/index.tsx'));
const tapFn = /const handleNewsTap = \(item: HotspotNews\) => \{([\s\S]*?)\n  \};/.exec(lib);
const tapBody = tapFn ? tapFn[1] : '';
ok('A1 handleNewsTap 函数体可定位', tapBody.length > 0);
ok('A2 点击打开站内文章视图（setArticle(item)）', /setArticle\(item\)/.test(tapBody));
const readFn = /const handleReadOriginal = \(item: HotspotNews\) => \{([\s\S]*?)\n  \};/.exec(lib);
const readBody = readFn ? readFn[1] : '';
ok('A3 阅读原文函数体可定位（打开语义的承接处）', readBody.length > 0);
ok('A4 阅读原文调用 openExternalPage(item.url)', /openExternalPage\(\s*item\.url\s*\)/.test(readBody));
ok('A5 url 缺失有如实提示（if (!item.url)）', /if\s*\(\s*!item\.url\s*\)/.test(readBody));
ok(
  'A6 复制态提示带来源（weapp 复制后告知去哪儿打开）',
  /r === 'copied'/.test(readBody) && /来源：\$\{item\.source\}，链接已复制/.test(readBody)
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
// 2026-10-25：服务端无手机号重置接口（resetPassword 仅 email、verifyOtp 对已有用户丢弃
// password），所以手机号「忘记密码」只允许诚实引导（切回短信登录），不许接假重置。
ok('D5 手机号密码页签有「忘记密码」诚实引导（forgotPhoneHint）', /forgotPhoneHint/.test(login));
ok('D6 引导点击切回验证码页签（switchTab(\'otp\')）', /switchTab\('otp'\)/.test(login));
ok('D7 引导样式已定义（forgotPhoneText）', /\.forgotPhoneText\s*\{/.test(loginScss));

/* ---------------- K. 我的页「修改密码」常驻入口（2026-10-25） ----------------
   安全措施是产品要求，所以断言框到具体行为：旧密码 sudo、双输入一致、≥8 位、诚实说明补设不可用。 */
{
  const mineSrc = stripComments(read('src/pages/mine/index.tsx'));
  ok('K1 账号卡有常驻「修改密码」入口（mine.pwdRow）', /mine\.pwdRow/.test(mineSrc));
  ok('K2 走 SDK 已登录改密契约（resetPasswordForOld）', /resetPasswordForOld\(\{ oldPassword: oldPwd, newPassword: newPwd \}\)/.test(mineSrc));
  ok('K3 新密码 ≥8 位校验', /newPwd\.length < 8/.test(mineSrc));
  ok('K4 两次输入一致性校验（防手滑锁死）', /newPwd !== confirmPwd/.test(mineSrc));
  ok('K5 弹窗三个密码输入（旧/新/确认，password 类型不回显）', /password\s*\n\s*value=\{oldPwd\}|password\s*\n\s*value=\{newPwd\}|password\s*\n\s*value=\{confirmPwd\}/.test(mineSrc));
  ok('K6 后端不可用 ≠ 旧密码错（分开提示，不误导反复试）', /res\.error\.kind === 'backend-unavailable'/.test(mineSrc));
  ok('K7 如实说明「补设密码不可用」（不编造短信重置）', /mine\.pwdHintPasswordless/.test(mineSrc));
}

/* ---------------- L. 视频精选 + 站内文章视图（2026-10-25） ---------------- */
{
  ok('L1 视频精选已接线（apiVideoNews 进并行加载）', /apiVideoNews\(\)/.test(lib));
  // 两处条件（sectionBar 与 ScrollView）都必须以非空为闸 —— 只断「存在一处」时，
  // 删掉另一处的条件照样过（2026-10-25 变异实录 NOT-CAUGHT）
  ok('L2 视频板块两处条件渲染都以非空为闸', (lib.match(/videos\.length > 0 \? \(/g) || []).length === 2);
  ok('L3 站内正文优先 content、缺失退回 summary', /item\.content \|\| item\.summary/.test(lib));
  ok('L4 文章视图带来源标注（articleSourceNote）', /library\.articleSourceNote/.test(lib));
  ok('L5 正文来自源 feed 自带内容而非抓取（webSearch content 上限 1000）', /content: clampSummary\(summary, 1000\)/.test(read('cloudfunctions/webSearch/index.js')));
  ok('L6 H5 静态管线同步 content 字段', /content: desc \? clampText\(desc, 1000\)/.test(read('.tools/fetch-data.js')));
  // ⚠️ 别断言 tsx 里的注释（stripComments 会剥掉，2026-10-25 实测 NOT 找到）——
  //    合规口径的落地锚点是**用户可见的来源说明文案**（language.ts），不是开发者注释。
  ok('L7 合规口径落在用户可见文案（源摘要 + 引导原文）', /以上为来源媒体在其订阅源中发布的摘要/.test(read('src/store/language.ts')));
}

/* ---------------- M. 我的页功能宫格（2026-10-25） ----------------
   高频功能（记账/购物/学习/搜索）的一等入口；浏览历史已并入热点页（IA 瘦身 13→12 页）。 */
{
  const mineGrid = stripComments(read('src/pages/mine/index.tsx'));
  ok('M1 功能宫格存在（styles.featureGrid + gridLedger）', /className=\{styles\.featureGrid\}/.test(mineGrid) && /mine\.gridLedger/.test(mineGrid));
  ok(
    'M2 五入口路由齐备（ledger/shopping/sxm/learn/search）',
    ['/pages/ledger/index', '/pages/shopping/index', '/pages/sxm/index', '/pages/learn/index', '/pages/search/index'].every((u) =>
      mineGrid.includes(u)
    )
  );
  // M7 断言收窄到函数体（子串匹配会被改名绕过 —— 与 M1 同坑）：两端的分支都必须在位
  const sxmFn = /const handleGridSxm = \(\) => \{([\s\S]*?)\n  \};/.exec(mineGrid);
  const sxmBody = sxmFn ? sxmFn[1] : '';
  ok('M7 省心买外放逐端镜像（H5 开 /sxm/ 服务、weapp 进原生页）',
    sxmBody.includes('if (isH5)') &&
    sxmBody.includes('openExternalPage(SXM_ENTRY_URL)') &&
    sxmBody.includes("navigateTo({ url: '/pages/sxm/index' })"));
  ok('M3 底部旧入口已去重（ledger 路由在 mine 页只出现一次）', (mineGrid.match(/pages\/ledger\/index/g) || []).length === 1);
  ok('M4 浏览历史已融入热点页（最近浏览区 + 展开标记接力）', /recentOpen/.test(lib) && /library-open-history/.test(mineGrid));
  ok('M5 宫格样式定义（featureTile + featureIcon）', /\.featureTile\s*\{/.test(read('src/pages/mine/index.module.scss')) && /\.featureIcon\s*\{/.test(read('src/pages/mine/index.module.scss')));
  ok('M6 history 页已删（路由不注册 + 文件不存在）', !/pages\/history\/index/.test(read('src/app.config.ts')) && !fs.existsSync(path.join(ROOT, 'src/pages/history/index.tsx')));
}

/* ---------------- N. 晨报页快捷工具行（2026-10-25） ----------------
   记账/购物/学习/搜索四工具融进晨报主页（用户指令「融入到前面几页」）；标签复用 mine.grid* 键。 */
{
  const brief = stripComments(read('src/pages/briefing/index.tsx'));
  ok('N1 快捷工具行存在（TOOL_TILES 四工具）', /const TOOL_TILES = \[/.test(brief) && (brief.match(/mine\.grid(Ledger|Shopping|Learn|Search)/g) || []).length >= 4);
  ok('N2 工具块点击页内跳转（navigateTo({ url: tool.url })）', /navigateTo\(\{ url: tool\.url \}\)/.test(brief));
}

/* ---------------- O. 收件箱三类扩展：账单/物品/生词（2026-10-25 挂账清偿） ---------------- */
{
  const extractFn = read('cloudfunctions/extract/index.js');
  const inboxSrc = stripComments(read('src/pages/inbox/index.tsx'));
  ok('O1 extract 提示词含三类输出（bills/shoppingItems/vocabularies）',
    /"bills":/.test(extractFn) && /"shoppingItems":/.test(extractFn) && /"vocabularies":/.test(extractFn));
  ok('O2 云函数对账单做金额过滤（amount>0 才放行 —— 0 元账单会造出脏流水）',
    /b\.amount === 'number' && b\.amount > 0/.test(extractFn));
  ok('O3 inbox 有三类展示块（账单转存记账 / 物品转存购物 / 生词复制）',
    /handleSaveBills/.test(inboxSrc) && /handleSaveShopping/.test(inboxSrc) && /handleCopyVocab/.test(inboxSrc));
  ok('O4 账单转存走本地记账数据层（addEntry + cat_subscription）',
    /addEntry\(\{/.test(inboxSrc) && /cat_subscription/.test(inboxSrc));
  ok('O5 三类结果独立于日程草稿渲染（drafts 为空也显示）',
    /bills\.length > 0 \? \(/.test(inboxSrc) && /shoppingHits\.length > 0 \? \(/.test(inboxSrc));
}

/* ---------------- P. 促销码兑换（2026-10-25，H5 端 PRO 开通路径） ---------------- */
async function loadPromo() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/promo.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    // promo.ts import Taro —— 打包侧桩掉（门禁只测纯逻辑；Taro 调用在别处有人工路径）
    external: ['@tarojs/taro'],
    logLevel: 'silent'
  });
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: { log: (...a) => console.log('[promo]', ...a), warn: () => {}, error: (...a) => console.log('[promo-err]', ...a) },
    // Taro 桩：内存版 storage。直接返回方法对象（esbuild 的 __toESM 会把它设为
    // import_taro.default —— 包一层 {default:...} 反而会多套一层命不中方法）
    require: (id) => ({ getStorageSync: () => sandbox.__store, setStorageSync: (k, v) => { sandbox.__store = v; } }),
    JSON, Math, Array, String, Number, Date
  };
  sandbox.globalThis = sandbox;
  sandbox.__store = '';
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'src/utils/promo.ts' });
  return sandbox.module.exports;
}

const promoMod = await loadPromo();
ok('P0 promo 模块可加载（SHA/ redeem 导出齐）',
  typeof promoMod.redeemPromo === 'function' && typeof promoMod._sha256HexForTest === 'function');
if (typeof promoMod._sha256HexForTest === 'function') {
  // SHA-256 标准测试向量（NIST/FIPS 180-2 公有域值）—— 实现错则一切校验皆假
  ok('P1 SHA-256 实现正确（"abc" 标准向量）',
    promoMod._sha256HexForTest('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // 自造码表测全行为（明文 TEST 码不进生产表）
  const crypto = await import('node:crypto');
  const mkCode = 'PRO-TEST-0001';
  const mkHash = crypto.createHash('sha256').update(mkCode).digest('hex');
  const goodUntil = new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10);
  const pastUntil = '2020-01-01';
  const testCodes = [
    { hash: mkHash, planDays: 30, goodUntil },
    { hash: mkHash, planDays: 30, goodUntil: pastUntil }
  ];
  ok('P2 有效码兑换成功且写凭证（30 天）',
    (() => { const r = promoMod.redeemPromo(mkCode, testCodes); return r.ok === true && !!r.expiredAt; })());
  ok('P3 错码返回 unknown（不猜、不写凭证）',
    promoMod.redeemPromo('PRO-WRNG-9999', testCodes).reason === 'unknown');
  ok('P4 格式错返回 format（防手滑长串打爆存储）',
    promoMod.redeemPromo('随便什么乱码!', testCodes).reason === 'format');
  ok('P5 活动截止码返回 expired（goodUntil 已过不可兑）',
    (() => { const codes2 = [{ hash: mkHash, planDays: 30, goodUntil: pastUntil }]; return promoMod.redeemPromo(mkCode, codes2).reason === 'expired'; })());
  ok('P6 重复兑换时长叠加（第二次在第一次到期日上顺延 60 天总量）',
    (() => {
      const codes3 = [{ hash: mkHash, planDays: 30, goodUntil }];
      const r1 = promoMod.redeemPromo(mkCode, codes3);
      const r2 = promoMod.redeemPromo(mkCode, codes3);
      const span = Math.round((Date.parse(r2.expiredAt) - Date.parse(r1.expiredAt)) / 86400000);
      return r2.ok === true && span === 30;
    })());
  ok('P7 生产码表非空且哈希形状合法（64 位十六进制，防占位符/空表上线）',
    Array.isArray(promoMod.PROMO_CODES) && promoMod.PROMO_CODES.length > 0 &&
    promoMod.PROMO_CODES.every((p) => /^[0-9a-f]{64}$/.test(p.hash)));
  // P8：兑换入口仅 H5 渲染。weapp 的兑换走 redeemCode 云函数（服务端 users 表发权益），
  // 云函数未部署前 weapp 没有入口 —— 不能放一个写本地凭证的入口：weapp 订阅态以服务端为准，
  // 本地凭证不改变云函数 getUsage 额度，会呈现「UI 说订阅了、权益没给」的假订阅。
  const promoEntryIdx = mine.indexOf('mine.promoEntry');
  ok('P8 促销码入口仅 H5 渲染（weapp 无本地凭证假订阅）',
    promoEntryIdx > 0 && mine.lastIndexOf('isH5 ? (', promoEntryIdx) > 0 &&
    mine.lastIndexOf('isH5 ? (', promoEntryIdx) < promoEntryIdx);
}

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

  // ---- 评分制（2026-10-25 升级）：时效闸 / 多源交叉 / 双词分级 ----
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const fresh = new Date(Date.now() - 3600 * 1000).toISOString();
  ok('I7 时效闸：>24h 旧闻不触发（昨天的预警不是突发）',
    burstPick([{ text: '暴雨橙色预警', source: 's1', createTime: old }]) === null);
  ok('I7b 时效闸：24h 内正常触发；createTime 缺失保守放行',
    burstPick([{ text: '暴雨橙色预警', source: 's1', createTime: fresh }]) !== null &&
    burstPick([{ text: '暴雨橙色预警', source: 's1' }]) !== null);
  const cross = burstPick([
    { text: '某地发生地震 震感明显', source: '源A' },
    { text: '地震后续：救援已抵达', source: '源B' }
  ]);
  ok('I8 多源交叉 → level 2 且带佐证来源',
    Boolean(cross) && cross.level === 2 && cross.alsoSources.includes('源B'));
  ok('I9 同源多条不算交叉（镜像稿防误升）',
    (() => {
      const r = burstPick([
        { text: '台风登陆', source: '同一家' },
        { text: '台风路径再更新', source: '同一家' }
      ]);
      return Boolean(r) && r.level === 1;
    })());
  ok('I10 单条双词命中 → level 2（如「地震+预警」同现）',
    (() => {
      const r = burstPick([{ text: '地震局发布地震预警', source: 'solo' }]);
      return Boolean(r) && r.level === 2;
    })());
  ok('I11 单源单词仍是 level 1（分级不误伤基础形态）',
    (() => {
      const r = burstPick([{ text: '某地发生爆炸', source: 's1' }]);
      return Boolean(r) && r.level === 1 && r.alsoSources.length === 0;
    })());
  // 国际源接入（2026-10-25）：英文标题也必须能触发突发识别，否则国际源的重大事件永远静默
  ok('I12 英文事件词触发（国际源标题）',
    burstPick([{ text: 'Powerful earthquake strikes region', source: 'Reuters' }]) !== null);
  // 审计 #1（2026-10-25）：句首大写实测漏报 —— 词表全小写，匹配必须 toLowerCase
  ok('I12a 句首大写也触发（Earthquake/Typhoon/Explosion 首字母大写）',
    burstPick([{ text: 'Earthquake Hits Turkey', source: 'BBC' }]) !== null &&
    burstPick([{ text: 'Typhoon Makes Landfall', source: 'NPR' }]) !== null &&
    burstPick([{ text: 'Explosion at refinery', source: 'Reuters' }]) !== null);
  ok('I12b 英文普通标题不触发（歧义短词没进表）',
    burstPick([{ text: 'New Fire TV stick review', source: 'Verge' }]) === null);
  // 审计 #3：空来源参与交叉可以，但 '(未知来源)' 占位符不得印给用户
  ok('I13 alsoSources 不含 (未知来源) 占位符',
    (() => {
      const r = burstPick([
        { text: '地震 震感明显', source: '源A' },
        { text: '地震后续', source: '' }
      ]);
      return Boolean(r) && r.level === 2 && !r.alsoSources.includes('(未知来源)');
    })());
}

/* ---------------- Q. 情报条目真实时间（2026-10-26）：让突发时效闸不再 100% 空转 ----------------
   背景（审计 Should #4）：burst.ts 的 isFresh() 早就在，但 intelItems 从来没有 createTime，
   24h 闸对每条都保守放行 —— 等于没有。修复要贯通三条生产侧：RSS pubDate → 热点契约
   （fetch-data / static-server）→ 晨报 intelItems（cloud.ts / webSearch fallbackIntel）。
   静态断言只能证明「写了字段」，所以下面的 Q4-Q6 真调 fallbackIntel 再喂 pickBurst。 */
const fetchDataSrc = stripComments(read('.tools/fetch-data.js'));
ok('Q1 聚合侧：RSS pubDate 转成响应契约 createTime（不再整体丢弃）',
  /Number\.isFinite\(pubDate\)[\s\S]{0,140}createTime:\s*new Date\(pubDate\)\.toISOString\(\)/.test(fetchDataSrc));
const staticServerSrc = stripComments(read('.tools/static-server.js'));
ok('Q2 本地预览侧：同口径透传 createTime',
  /Number\.isFinite\(pubDate\)[\s\S]{0,140}createTime:\s*new Date\(pubDate\)\.toISOString\(\)/.test(staticServerSrc));
const cloudSrc = stripComments(read('src/services/cloud.ts'));
const h5IntelMap = /intel\.intelItems = picked\.map\(\(it\) => \{([\s\S]{0,600}?)\n\s*\}\)/.exec(cloudSrc);
ok('Q3 H5 晨报映射透传可解析的 createTime（缺失不补当前时间）',
  Boolean(h5IntelMap) && /Date\.parse\(it\.createTime\)/.test(h5IntelMap[1]) &&
  /\.\.\.\(createTime \? \{ createTime \} : \{\}\)/.test(h5IntelMap[1]));
const briefTypes = stripComments(read('src/types/index.ts'));
ok('Q3b BriefingIntel.intelItems 契约含可选 createTime',
  /intelItems: Array<\{ text: string; source: string; createTime\?: string \}>/.test(briefTypes));

/** 用 vm + Proxy 桩加载 webSearch 云函数（无 wx-server-sdk 也能跑），取 __internals */
function loadWebSearchExports() {
  const file = path.join(ROOT, 'cloudfunctions/webSearch/index.js');
  const makeStub = () => {
    const target = function stub() {};
    const handler = {
      get(_t, prop) {
        if (prop === 'then') return undefined; // 避免被当成 thenable
        if (prop === Symbol.toPrimitive) return () => 'stub';
        return proxy;
      },
      apply() { return proxy; },
      construct() { return proxy; },
      has() { return true; }
    };
    const proxy = new Proxy(target, handler);
    return proxy;
  };
  const sandbox = {
    module: { exports: {} },
    exports: null,
    require: () => makeStub(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    process: { env: {} },
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 5000 });
    return sandbox.module.exports;
  } catch (err) {
    console.log(`  (webSearch 加载失败：${err && err.message})`);
    return null;
  }
}

const wsExports = loadWebSearchExports();
const fallbackIntel = wsExports && wsExports.__internals && wsExports.__internals.fallbackIntel;
ok('Q4 webSearch 降级出口可运行时调用（fallbackIntel 已导出）', typeof fallbackIntel === 'function');
if (typeof fallbackIntel === 'function') {
  const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const freshIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const oldRows = fallbackIntel([{ title: '某地暴雨预警', summary: '旧闻回放', source: '源A', createTime: oldIso }], 1);
  ok('Q5 fallbackIntel 透传真实 createTime（免费档/LLM 降级档）',
    oldRows.length === 1 && oldRows[0].createTime === oldIso);
  const noTsRows = fallbackIntel([{ title: '无时间条目', source: '源B' }], 1);
  ok('Q5b 源无时间 → 不产字段（不伪造当前时间）',
    noTsRows.length === 1 && !('createTime' in noTsRows[0]));
  const badTsRows = fallbackIntel([{ title: '坏时间条目', source: '源C', createTime: 'not-a-date' }], 1);
  ok('Q5c 时间不可解析 → 同样不产字段（走保守放行）',
    badTsRows.length === 1 && !('createTime' in badTsRows[0]));

  const toBurst = (rows) => rows.map((r) => ({ text: r.text, source: r.source, createTime: r.createTime }));
  ok('Q6 端到端：48h 前的 RSS 条目经 intelItems 后不触发突发（闸真的接上了）',
    burstPick(toBurst(oldRows)) === null);
  const freshRows = fallbackIntel([{ title: '某地暴雨预警', summary: '最新进展', source: '源A', createTime: freshIso }], 1);
  ok('Q6b 端到端对照：1h 内的同内容条目仍触发（不是把闸焊死）',
    burstPick(toBurst(freshRows)) !== null);
}

/* ---------------- R. 相对时间不撒谎 + 自选上限文案跟随常量（2026-10-26） ----------------
   ① fromNow(undefined) 的 dayjs 会当成「现在」，返回「刚刚」。热点板块/热榜条目本来没有
      发布时间，此前一律显示「刚刚发布」—— 这是给用户的假信息。新闻卡片必须缺时间不渲染。
   ② 自选上限已抽 WATCHLIST_MAX，但满额文案仍写死「8 只」（中英各一处）—— 常量改了文案会撒谎。 */
const libSrc = stripComments(read('src/pages/library/index.tsx'));
ok('R1 新闻卡片：缺 createTime 不渲染相对时间（否则 fromNow(undefined)=刚刚）',
  /\{item\.createTime \? \(\s*<Text className=\{styles\.newsTime\}>/.test(libSrc));
ok('R2 文章头：缺 createTime 不留悬空的「来源 · 」',
  /\{item\.createTime \? ` · \$\{item\.createTime\.slice\(0, 10\)\}` : ''\}/.test(libSrc));

async function loadDateModule() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/date.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'src/utils/date.ts' });
  return sandbox.module.exports;
}
const dateMod = await loadDateModule();
ok('R3 前提可复现：fromNow(undefined) 确实返回「刚刚」', dateMod.fromNow(undefined) === '刚刚');
ok('R4 前提可复现：fromNow(合法 ISO) 不会退化成「刚刚」',
  dateMod.fromNow(new Date(Date.now() - 3 * 3600 * 1000).toISOString()) === '3 小时前');

const langSrc = stripComments(read('src/store/language.ts'));
const fullQuotes = langSrc.match(/'briefing\.quoteFull':\s*'([^']*)'/g) || [];
ok('R5 自选满额文案中英各一处，且都用 {max} 占位符（不写死 8）',
  fullQuotes.length === 2 && fullQuotes.every((l) => l.includes('{max}')));
const briefSrc = stripComments(read('src/pages/briefing/index.tsx'));
ok('R6 调用处把 WATCHLIST_MAX 传进文案',
  /t\('briefing\.quoteFull',\s*\{\s*max:\s*WATCHLIST_MAX\s*\}\)/.test(briefSrc) &&
  /WATCHLIST_MAX/.test(briefSrc.split('\n').find((l) => l.includes("from '@/utils/quotes'")) || ''));

/* R7：小程序侧 toNews 对无发布时间条目**不伪造 now**。
 * 背景：parseRss 对无 pubDate 条目给 ts=0（内部按 ts=0 排末尾），而旧实现
 * `it.ts ? iso : new Date().toISOString()` 把 0 当 falsy 兜底成当前时间 ——
 * 前端 prefSelect 按 createTime 倒序会把它们当最新排到最前，突发 24h 闸也判它们新鲜。
 * 判据必须框到 toNews 的 createTime 那一行：既要求显式 undefined，也要求不是 now 兜底。 */
const wsSrc = stripComments(read('cloudfunctions/webSearch/index.js'));
const toNewsTimeLine = (wsSrc.match(/createTime:.*$/gm) || []).find((l) => l.includes('it.ts')) || '';
ok('R7 无发布时间条目不伪造 now（createTime 显式 undefined）',
  toNewsTimeLine !== '' && /undefined/.test(toNewsTimeLine) && !/new Date\(\)/.test(toNewsTimeLine));

/* ---------------- S. 假成功与「设置了没效果」（2026-10-26 诚实性收尾） ---------------- */

/* S1/S2 头像：tempFilePath 是临时文件，重启即失效 —— 直接存它并提示「已更新」是假成功。
 * 判据框到 chooseMedia 的 success 分支：必须调 saveFile 转存，且失败分支不得再谎称已保存。 */
const avatarBlock = (() => {
  const i = mine.indexOf('const doChangeAvatar');
  return i < 0 ? '' : mine.slice(i, mine.indexOf('const handleAvatarTap', i) > i ? mine.indexOf('const handleAvatarTap', i) : i + 2400);
})();
ok('S1 小程序头像转存永久文件（saveFile），不直接存 tempFilePath',
  avatarBlock !== '' && /Taro\.saveFile\(\s*\{\s*tempFilePath/.test(avatarBlock));
ok('S2 转存失败不谎称已保存（提示仅本次显示）',
  avatarBlock !== '' && /mine\.avatarTempOnly/.test(avatarBlock) && /avatarSaved/.test(avatarBlock));

/* S3 推送偏好卡片：当前无推送通道，整卡偏好不产生行为 —— 必须有如实说明且键真的被消费（不是孤儿键） */
ok('S3 推送偏好卡片有如实说明且键被消费（非孤儿键）',
  /'settings\.pushNote':/.test(langSrc) && /t\('settings\.pushNote'\)/.test(mine));

/* ---------------- T. 头像云存储接线（WorkBuddy storage，2026-10-26） ---------------- */

const storageSrc = stripComments(read('src/services/cloudStorage.ts'));
/* T1 必须走 SDK 的 storage，不许自己拼 /.cloud/storage 的 fetch —— 后者会绕过 publishableKey
 * 注入与会话管理（技能明令禁止），而且签名 URL 的鉴权也在 SDK 里。 */
ok('T1 头像存储走 SDK（storage.upload + createSignedUrl），无手写 /.cloud fetch',
  /storage\.upload\(/.test(storageSrc) && /createSignedUrl\(/.test(storageSrc) &&
  !/fetch\(\s*[`'"]\S*\/\.cloud\//.test(storageSrc));
/* T2 存储只对登录用户开放：路径里的 uid 必须来自会话，且未登录有专门分支。
 * 判据必须**框到分支语句本身**：`'no-session'` 还出现在 AvatarUploadResult 的类型联合里，
 * 只测「文件里出现过 no-session」时，把 `if (!uid) return` 改成别的 reason 也照样绿（已实证漏报一次）。 */
ok('T2 上传前判会话（no-session 分支），路径 uid 取会话而非外部输入',
  /if \(!uid\)\s*return\s*\{\s*ok:\s*false,\s*reason:\s*'no-session'\s*\}/.test(storageSrc) &&
  /const uid = session\?\.user\?\.id;/.test(storageSrc) &&
  /storage\.userPath\(uid,/.test(storageSrc));
/* T3 客户端校验类型与大小（不信任浏览器给的图） */
ok('T3 上传前校验类型与大小（AVATAR_MAX_BYTES + 白名单 MIME）',
  /AVATAR_MAX_BYTES/.test(storageSrc) && /file\.size\s*>\s*AVATAR_MAX_BYTES/.test(storageSrc) &&
  /ALLOWED_TYPES\.includes\(file\.type\)/.test(storageSrc));
/* T4 签名 URL 取不到时**不回退成空 src**（空 src 会渲染成裂图，等于对用户说「你的头像坏了」）。
 * 判据用「所有 setAvatar(url 调用 == 过了 if(url) 闸的调用」（两处：进页面换签名 URL、上传后立刻显示），
 * 这样以后新增一处裸调用也会红 —— 只测「某处有 if(url)」时，另外那处裸调用照样绿。 */
const t4Set = (mine.match(/setAvatar\(url/g) || []).length;
const t4Guarded = (mine.match(/if \(url\) setAvatar\(url\);/g) || []).length;
ok('T4 云端头像取不到 URL 时不硬渲染（setAvatar(url 全部过 if(url) 闸，回退默认不裂图）',
  t4Guarded >= 2 && t4Set === t4Guarded && /cloud avatar unresolvable/.test(mine));
/* T5 头像进同步键（跨设备）且有中英标签（标签由 verify-sync-conflict B3 兜，这里钉住键本身） */
ok('T5 user-avatar 在 SYNC_KEYS 里且云前缀常量被消费',
  /'user-avatar'/.test(stripComments(read('src/services/cloudSync.ts'))) &&
  /AVATAR_CLOUD_PREFIX \+ res\.path/.test(mine) && /AVATAR_CLOUD_PREFIX\.length/.test(mine));
/* T6 小程序端保持本地 saveFile —— 云存储只在 H5 生效，别把 weapp 分支改坏 */
ok('T6 小程序端仍走 saveFile（云端路径不影响 weapp）',
  /Taro\.saveFile\(\s*\{\s*tempFilePath/.test(mine) && /not-h5/.test(storageSrc));
/* T7 上传成功但换不出签名 URL 时**不谎称「头像已更新」**——用户眼前没有任何变化，
 * 这时报「已更新」就是假成功。必须按 url 是否真拿到分流两套文案。 */
ok('T7 取不到签名 URL 时不谎称已更新（改报「已保存、重进可见」）',
  /url \? t\('mine\.avatarSaved'\) : t\('mine\.avatarSavedNoPreview'\)/.test(mine) &&
  /'mine\.avatarSavedNoPreview':/.test(langSrc));
/* T8 依赖的 SDK 面必须在我们**实际加载的那份 SDK**里真实存在。
 * 本仓自托管 SDK（大陆 CDN 被墙，见 src/assets/wb-sdk.js）与 npm 版可能不同版本，
 * 只在类型里声明 `storage` 是自证 —— 真没有时整套头像云存储会静默降级成
 * 「云端存储暂不可用」，浏览器里看不出、只有用户点上传才知道。这里直接查产物里的方法名。 */
{
  const sdkSrc = read('src/assets/wb-sdk.js');
  const need = ['userPath(', 'sharedPath(', 'createSignedUrl(', 'upload(', 'remove(', 'exists('];
  const missing = need.filter((m) => sdkSrc.indexOf(m) < 0);
  ok('T8 自托管 SDK 真的暴露 storage 的六个方法（不靠类型声明自证）',
    sdkSrc.length > 10000 && missing.length === 0 && /storage/.test(sdkSrc));
}

console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail === 0 ? 0 : 1);
