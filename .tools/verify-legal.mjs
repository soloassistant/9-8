#!/usr/bin/env node
/**
 * verify:legal —— 法务条文 ↔ 真实实现的**数据流**核对
 *
 * ## 为什么需要它（上一轮为什么没查出来）
 *
 * 上一轮核对内容安全时，grep 到 `cloudfunctions/chat/index.js` 里有 `msgSecCheck` 就判定合规。
 * 但那段只在**微信云函数**里跑：H5 走 `services/cloudLlm.ts` 直连 `cloud.llm`，从请求到响应
 * 完全不经过它。同一个错误在供应商上也犯过一次：`llm.js` 里写着 `deepseek-chat`，
 * 于是「供应商 = DeepSeek」被当成「有代码依据」，没人去看 H5 的 `pickModel()` 选的是平台目录里的
 * `hy4-preview`。
 *
 * ⇒ **判断标准是「这条链路上，这个调用到底有没有发生」，不是「这个字符串在仓库里存在」。**
 *   所以本脚本的每一条都先从代码里**抽出一个事实**（模型默认值 / 通道联合类型 / 域名调用点 /
 *   函数体里两个调用的先后），再拿这个事实去要求文本；而不是反过来搜文本里有没有某个词。
 *
 * ## 三类它**不能**替你做的判断（写在这里，防止下次又拿它当免责声明）
 *   1. 「该不该这么承诺」——例如「境内服务器」缺服务商书面地域凭证、运营者主体名称缺失；
 *   2. 承诺是否超出法律要求；
 *   3. 条文之间的**语义**冲突（脚本只覆盖已枚举的 4 组绝对句）。
 *   脚本能做的是：**代码一变，逼你回来看文本**；文本里新加一句绝对话，逼你证明它。
 *
 * ## 覆盖
 *   A 供应商/模型披露    B 绝对句反证        C 坐标出境闸门
 *   D 条文↔条文一致性    E 接线（写了要能被看到）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new Error(`断言「${name}」的 cond 不是 boolean，而是 ${typeof cond}：${String(cond)}`);
  }
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
  return cond;
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/** 取一段函数体：从 `anchor` 起做花括号配对。找不到返回 ''（调用侧必须显式判空，别让它静默通过） */
function bodyOf(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  for (let p = start; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, p + 1);
    }
  }
  return '';
}

/** 拆句：条文的判定单位是「句」，不是「全文」——全文 includes 会把限定语和断言混在一起判 */
const sentencesOf = (text) =>
  text
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const legalSrc = read('src/data/legal.ts');
/** 三份文本的源码（含 ${LEGAL_VERSION} 插值，不执行） */
const TERMS = /export const TERMS_TEXT = `([\s\S]*?)`;/.exec(legalSrc)?.[1] ?? '';
const PRIVACY = /export const PRIVACY_TEXT = `([\s\S]*?)`;/.exec(legalSrc)?.[1] ?? '';
const AI_SERVICES = /export const AI_SERVICES_TEXT = `([\s\S]*?)`;/.exec(legalSrc)?.[1] ?? '';
const LEGAL_ALL = `${TERMS}\n${PRIVACY}\n${AI_SERVICES}`;

console.log('法务条文 ↔ 实现数据流核对 (verify:legal)');
console.log('──────────────────────────────────────────────────────────');

// 三份文本必须都抽到：抽不到时下面所有 includes 都是 false → 会「全红」，这是对的；
// 但更常见的是正则写错导致**全绿**（空串 includes 一切为假，其实全红，尚可）。这里显式兜底一次。
ok(
  'H0 三份文本都成功抽取（抽不到就没有后面任何结论）',
  TERMS.length > 500 && PRIVACY.length > 500 && AI_SERVICES.length > 200
);

/* ================================================================== */
/* A. 供应商 / 模型披露：先读代码里「真的会用哪个」，再要求条文写到      */
/* ================================================================== */
console.log('\n── A. 供应商与模型（代码 → 条文）──');

const llmSrc = read('cloudfunctions/chat/llm.js');
// 抽出所有 `process.env.LLM_*_MODEL || '<默认值>'` —— 这是小程序端**实际会发出去的**模型标识
const cloudModels = [
  ...new Set(
    [...llmSrc.matchAll(/process\.env\.LLM_[A-Z_]*MODEL\s*\|\|\s*'([^']+)'/g)].map((m) => m[1])
  )
];
ok(
  `A1 从 llm.js 抽出小程序端默认模型 ${cloudModels.length} 个（${cloudModels.join(' / ')}）—— 至少 2 个才算抽对`,
  cloudModels.length >= 2
);

/**
 * 模型 → 供应商名的映射**故意写死在脚本里**：
 * 多出一个模型而这里没登记 ⇒ 下面 A2 会红 ⇒ 逼人回来看条文要不要披露这家新供应商。
 * 这就是「代码一变，逼你回看文案」的具体实现。
 */
const VENDOR_OF = {
  'deepseek-chat': 'DeepSeek',
  'qwen-plus': '通义千问'
};

for (const m of cloudModels) {
  ok(`A1 小程序端模型 ${m} 已在条文中披露（代码真的会用它发出去）`, LEGAL_ALL.includes(m));
  const vendor = VENDOR_OF[m];
  // 必须**同句**同时出现供应商名与模型标识：只在别处提一句「如通义千问」是举例，不是披露。
  const paired = sentencesOf(LEGAL_ALL).some((s) => s.includes(m) && Boolean(vendor) && s.includes(vendor));
  ok(
    `A2 模型 ${m} 与供应商名（${vendor || '未登记'}）在同一句里成对出现 —— 模型标识 ≠ 供应商名，用户看不懂前者`,
    Boolean(vendor) && paired
  );
}
ok(
  `A2 模型→供应商对照表覆盖了 llm.js 的全部 ${cloudModels.length} 个模型（漏登记就红）`,
  cloudModels.every((m) => Boolean(VENDOR_OF[m]))
);

// H5：模型由平台目录下发，条文若写死具体标识就必须带「平台目录」限定
const cl = read('src/services/cloudLlm.ts');
const pickBody = bodyOf(cl, 'export async function pickModel');
ok('A3 H5 pickModel 仍然从 models.list() 取模型（不在前端硬编码模型 id）',
  pickBody.includes('models.list()') && !/cachedModel\s*=\s*'[^']+'/.test(pickBody));
const h5ModelSent = sentencesOf(LEGAL_ALL).find((s) => s.includes('hy4-preview'));
ok('A3 条文里的 H5 模型标识必须带「平台目录」限定（否则把「平台下发」写成固定供应商承诺）',
  Boolean(h5ModelSent) && h5ModelSent.includes('平台目录'));

// 出网域名：代码里真的在请求 + 条文里真的披露了这家
const DOMAINS = [
  { host: 'api.bigdatacloud.net', vendor: 'BigDataCloud', file: 'src/services/location.ts' },
  { host: 'api.open-meteo.com', vendor: 'OpenMeteo', file: 'src/utils/weather.ts' }
];
for (const d of DOMAINS) {
  ok(`A4 ${d.host} 在 ${d.file} 里真的被请求（不是只写在条文里）`, read(d.file).includes(d.host));
  ok(`A4 ${d.host} 的供应商 ${d.vendor} 已在条文披露`, LEGAL_ALL.includes(d.vendor));
}

/* ================================================================== */
/* B. 绝对句反证：唯一 / 全部 / 仅 / 一键 —— 上一轮 8 处不实有 5 处藏在这里 */
/* ================================================================== */
console.log('\n── B. 绝对句反证（条文 → 代码）──');

// B1 「唯一」：逐句过白名单。新加一句「XX 是唯一…」就会红，逼人拿出证明。
// ⚠️ 2026-10-24：原白名单里有 /转发是唯一入口/ —— 但那句本身是错的（真实入口是粘贴 /
// Ctrl+V 截屏 / 相册选图，见 pages/inbox），白名单等于把不实表述固化。白名单必须**空**：
// 只要想留一句「唯一」，就得先证明它，证明不了就别写「唯一」。
const UNIQ_ALLOW = [];
const uniqSents = sentencesOf(LEGAL_ALL).filter((s) => s.includes('唯一'));
ok(
  `B1 「唯一」类绝对句逐句已复核（${uniqSents.length} 句：${uniqSents.map((s) => s.slice(0, 14)).join(' / ') || '无'}）`,
  uniqSents.every((s) => UNIQ_ALLOW.some((r) => r.test(s)))
);

// B2 登录通道：从 login 的联合类型读真实通道数，再要求文本同时提到两种
const loginSrc = read('src/pages/login/index.tsx');
const channelUnion = /type IdChannel = ([^;]+);/.exec(loginSrc)?.[1] ?? '';
const channels = [...channelUnion.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
ok(
  `B2 从 login 的 IdChannel 读出 ${channels.length} 个通道（${channels.join('+')}；读不到视为断言失败）`,
  channels.length >= 2
);
ok('B2 条文同时提到「邮箱」与「手机号」两种登录标识', LEGAL_ALL.includes('邮箱') && LEGAL_ALL.includes('手机号'));
ok(
  'B2 条文不含「仅支持邮箱 / 只支持邮箱 / 邮箱为唯一」这类与代码相反的断言',
  !/仅支持邮箱|只支持邮箱|邮箱为唯一|唯一登录方式/.test(LEGAL_ALL)
);

// B3 「不会提供给第三方」必须带共享条款的限定，否则与《隐私政策》三自相矛盾
const noThirdSents = sentencesOf(LEGAL_ALL).filter((s) => s.includes('不会将你的个人数据提供给第三方'));
ok(
  'B3 「不会将个人数据提供给第三方」句已带《隐私政策》第三条限定（不加限定就和共享条款打架）',
  noThirdSents.length > 0 && noThirdSents.every((s) => s.includes('《隐私政策》第三条'))
);

// B4 内容安全：先查 H5 侧到底有没有过滤实现，再决定文本能不能无条件陈述
const h5FilterSrc =
  read('src/services/cloud.ts') + read('src/services/cloudLlm.ts') + read('src/services/api.ts');
const h5HasFilter = /msgSecCheck|security\.msgSecCheck/.test(h5FilterSrc);
const wxChat = read('cloudfunctions/chat/index.js');
const wxHasFilter = wxChat.includes('security.msgSecCheck');
ok('B4 小程序端确实调用了 security.msgSecCheck（条文里那部分承诺是有依据的）', wxHasFilter);
const filterSents = sentencesOf(AI_SERVICES).filter((s) => s.includes('安全过滤'));
ok(
  `B4 内容安全过滤句已按端限定（H5 实测${h5HasFilter ? '有' : '无'}实现 → 必须写清哪端有）`,
  filterSents.length > 0 &&
    filterSents.every((s) => (h5HasFilter ? true : s.includes('小程序端') && s.includes('网页端')))
);

// B5 「一键注销」不得声称删掉账号本身（H5 没有删号接口，只能走客服）
const oneClickSents = sentencesOf(LEGAL_ALL).filter((s) => s.includes('一键注销'));
ok(
  'B5 「一键注销」句没有声称连账号一起删掉（账号删除必须指向客服/其他条款）',
  oneClickSents.length > 0 &&
    oneClickSents.every((s) => !s.includes('删除账号') && (!s.includes('账号本身') || s.includes('见第')))
);
ok('B5 全文给出「联系客服」作为删号出口（否则用户无路可走）', LEGAL_ALL.includes('联系客服'));

// B6 实现侧：登出 ≠ 注销。文案说「一键注销 = 清本地 + 清云端」，代码顺序必须对得上
const mineSrc = read('src/pages/mine/index.tsx');
const signOutBody = bodyOf(mineSrc, 'const handleSignOut = () =>');
ok(
  'B6 登出流程不使用 clearStorageSync（那是注销语义；混用会把用户数据一起清掉）',
  signOutBody.length > 0 && !signOutBody.includes('clearStorageSync')
);
const delBody = bodyOf(mineSrc, 'const confirmDeleteAccount = async (typed: string) =>');
ok('B6 注销流程先 kvClear 再 signOut（顺序反了 RLS 会拒绝删除，变成「登出但云端还在」）',
  delBody.includes('kvClear') && delBody.includes('signOut') &&
    delBody.indexOf('kvClear') < delBody.indexOf('signOut'));

/* ================================================================== */
/* C. 坐标出境：条文说「单独同意」，代码里就必须真有这个闸门且顺序正确     */
/* ================================================================== */
console.log('\n── C. 坐标出境与同意闸门 ──');

const locSrc = read('src/services/location.ts');
const getLocBody = bodyOf(locSrc, 'export async function locateCity');
const consentIdx = getLocBody.indexOf('ensureCrossBorderConsent()');
const geoIdx = getLocBody.indexOf('Taro.getLocation');
ok('C1 locateCity 函数体里同时存在出境同意闸门与定位调用（缺一个就说明链路变了）',
  consentIdx > -1 && geoIdx > -1);
ok('C1 顺序必须是 出境同意闸门 → Taro.getLocation（挪到后面等于先采集后同意）',
  consentIdx > -1 && geoIdx > -1 && consentIdx < geoIdx);

// 只挑**肯定句**：条文里「不会发送你的位置坐标」「不会获取你的坐标」是否定承诺，
// 拿「授权/同意」去要求它们是误报（第一版就这么误杀了 2 句）。
const NEGATED = /不会发送|不发送|不会获取|不获取|不收集|不采集|不存储/;
const coordSents = sentencesOf(LEGAL_ALL).filter(
  (s) => s.includes('坐标') && (s.includes('发送') || s.includes('出境')) && !NEGATED.test(s)
);
ok(
  `C2 凡「坐标 + 发送/出境」的肯定句都写了「主动授权 / 单独同意」（${coordSents.length} 句；否定句已排除）`,
  coordSents.length > 0 && coordSents.every((s) => s.includes('授权') || s.includes('同意'))
);

/* ================================================================== */
/* D. 条文 ↔ 条文：只对着代码看永远发现不了的内部矛盾                     */
/* ================================================================== */
console.log('\n── D. 条文之间的一致性 ──');

// D1 同一组供应商必须两边都提（一边写、另一边漏 = 用户读到的是两套事实）
const AI_VENDORS = ['DeepSeek', '通义千问', 'WorkBuddy'];
const missD1 = AI_VENDORS.filter((v) => PRIVACY.includes(v) !== AI_SERVICES.includes(v));
ok(
  `D1 《隐私政策》三 与《第三方 AI 服务说明》的供应商集合一致（不一致：${missD1.join(',') || '无'}）`,
  missD1.length === 0
);

// D2 模型标识集合也必须一致（改一处忘另一处，用户会看到两个不同答案）
const idsIn = (t) => ['deepseek-chat', 'qwen-plus', 'hy4-preview'].filter((id) => t.includes(id));
ok(
  `D2 两份 AI 文本披露的模型标识集合相同（PRIVACY=${idsIn(PRIVACY).join(',') || '空'}；AI=${idsIn(AI_SERVICES).join(',') || '空'}）`,
  JSON.stringify(idsIn(PRIVACY)) === JSON.stringify(idsIn(AI_SERVICES)) && idsIn(PRIVACY).length >= 2
);

// D3 版本号必须靠插值，不许手写（手写会漂，且不会随 LEGAL_VERSION 触达老用户）
ok(
  'D3 三份文本的版本行都用 ${LEGAL_VERSION} 插值',
  [TERMS, PRIVACY, AI_SERVICES].every((t) => t.includes('版本：${LEGAL_VERSION}'))
);

// D4 「注销删全部数据」类表述必须与第四条第 5 项（账号另走客服）口径一致，不能自相矛盾
const delAllSents = sentencesOf(LEGAL_ALL).filter((s) => s.includes('全部数据'));
ok(
  'D4 「全部数据」只出现在「客服要求删除」的语境，不作为一键注销的承诺',
  delAllSents.every((s) => s.includes('客服') || s.includes('提出') || s.includes('申请'))
);

/* ================================================================== */
/* E. 接线：文本写了、也真的渲染出来                                      */
/* ================================================================== */
console.log('\n── E. 渲染与同意版本接线 ──');

const gateSrc = read('src/components/ConsentGate/index.tsx');
const RENDER_KEYS = ['PRIVACY_TEXT', 'TERMS_TEXT', 'AI_SERVICES_TEXT'];
ok('E1 首启同意弹窗渲染三份文本（写了不渲染 = 用户根本看不到）',
  RENDER_KEYS.every((k) => gateSrc.includes(k)));
ok('E1 「我的」半屏查看层也渲染三份（同意之后仍需可查）', RENDER_KEYS.every((k) => mineSrc.includes(k)));
ok('E2 同意记录按 LEGAL_VERSION 比对（改文案不递增 = 对老用户静默改条款）',
  legalSrc.includes('rec.version === LEGAL_VERSION'));

console.log('──────────────────────────────────────────────────────────');
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail > 0 ? 1 : 0);
