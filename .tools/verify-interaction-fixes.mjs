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
import { fileURLToPath } from 'node:url';

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

/* ---------------- D. 密码登录显式入口 ---------------- */
const login = stripComments(read('src/pages/login/index.tsx'));
ok('D1 手机通道有密码登录入口（styles.passwordHint）', /styles\.passwordHint/.test(login));
ok('D2 入口点击切到邮箱通道', /switchChannel\('email'\)/.test(login));
const loginScss = stripComments(read('src/pages/login/index.module.scss'));
ok('D3 passwordHint 样式已定义', /\.passwordHint\s*\{/.test(loginScss));

/* ---------------- E. 搜索接全网 + 失败态独立 ---------------- */
const search = stripComments(read('src/pages/search/index.tsx'));
ok('E1 搜索页调用 apiNewsSearch', /apiNewsSearch\(/.test(search));
ok('E2 失败态独立置位（setWebFailed(true)）', /setWebFailed\(true\)/.test(search));
ok('E3 null 与空数组分开处理（失败 ≠ 空）', /items === null/.test(search));
ok('E4 全网结果可打开原文（openExternalPage）', /openExternalPage\(/.test(search));

console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail === 0 ? 0 : 1);
