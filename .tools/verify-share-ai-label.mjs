/**
 * 验证「分享 / 剪贴板导出」链路的 AI 显式标识（合规硬门槛）。
 *
 * 覆盖三条：
 *  1. 晨报转发分享标题：share.titleAI 插值后必须带 AI 前缀，且品牌口号不丢；
 *  2. inbox 工作助手结果复制导出：剪贴板数据必须跟随 ai.labelText 标识；
 *  3. 调用点接线：briefing/inbox 源码里真的调了这些 key（防"加了 key 没接上"的假合规）。
 *
 * 运行：node .tools/verify-share-ai-label.mjs
 * 退出码 0 = 全 PASS；1 = 有 FAIL。
 */
import * as esbuild from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(REPO, '.tools');
const entry = path.join(HERE, 'verify-share-ai-label-entry.ts');

const cases = [];
const t = (name, ok, detail) => cases.push({ name, ok: ok === true, detail });

// ---- 1. 编译真实源码并在 vm 里求值 ----
const built = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  write: false,
  alias: {
    '@/store/language': path.join(REPO, 'src/store/language'),
    '@tarojs/taro': path.join(HERE, 'verify-share-ai-label-taro-stub.ts')
  },
  logLevel: 'silent'
});
const code = built.outputFiles[0].text;
const logs = [];
const sandbox = { console: { log: (...a) => logs.push(a.join(' ')) }, process: { env: {} } };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'entry.iife.js' });

let data = null;
try {
  data = JSON.parse(logs.join('\n'));
} catch {
  t('编译求值得出 JSON', false, `stdout=${JSON.stringify(logs)}`);
}

if (data) {
  const { zhShare, enShare, zhNeutral, enNeutral, zhCopyLabel, enCopyLabel } = data;

  t('中文分享标题带 AI 前缀', zhShare.startsWith('AI 整理｜'), zhShare);
  t('中文分享标题保留品牌口号', zhShare.includes('私人晨报助理'), zhShare);
  t('英文分享标题带 AI 前缀', enShare.startsWith('AI-curated｜'), enShare);
  t('英文分享标题保留品牌口号', enShare.includes('My Morning Briefing'), enShare);
  t('中文标题无未解析占位符', !zhShare.includes('{title}'), zhShare);
  t('英文标题无未解析占位符', !enShare.includes('{title}'), enShare);
  // 长度不设武断绝对值：微信对过长分享标题做**尾部省略**，故护住的是
  // 「标识在前缀 + 标识本身够短」，总长可控只做宽松护栏。
  t('AI 标识前缀落在截断可见区', zhShare.split('｜')[0].length <= 14 && enShare.split('｜')[0].length <= 14,
    `zhTag=${zhShare.split('｜')[0]} enTag=${enShare.split('｜')[0]}`);
  t('中文标题总长护栏(<=30)', zhShare.length <= 30, `zh=${zhShare.length}`);
  t('英文标题总长护栏(<=60，截断只丢尾部口号)', enShare.length <= 60, `en=${enShare.length}`);
  t('剪贴板中文标识含「AI 生成」', zhCopyLabel.includes('AI 生成'), zhCopyLabel);
  t('剪贴板英文标识含「AI-generated」', enCopyLabel.includes('AI-generated'), enCopyLabel);

  // ---- 1b. 中文/英文中性分支不得声称 AI（免费档、降级档走这条）----
  t('免费档中文标题不含 AI 字样', !zhNeutral.includes('AI'), zhNeutral);
  t('免费档英文标题不含 AI 字样', !/\bAI\b/i.test(enNeutral), enNeutral);

  // ---- 2. 调用点接线（读源码，防「有 key 无渲染点」的假合规）----
  const briefingSrc = fs.readFileSync(path.join(REPO, 'src/pages/briefing/index.tsx'), 'utf8');

  // 合规硬门槛（commit 9168386）：AI 前缀必须挂在「订阅档且未降级」的**真分支**上。
  // 免费档/降级档的情报来自公开 RSS 的本地分组、全程无 LLM，署 AI 名即虚假陈述。
  // 只断言「源码里出现了 share.titleAI」是不够的 —— 必须钉住它被门控。
  const gated = /t\(\s*intelResolved\.aiEnabled\s*&&\s*!intelResolved\.degraded\s*\?\s*'share\.titleAI'\s*:\s*'share\.title'/;
  t('briefing 分享标题受 aiEnabled && !degraded 门控', gated.test(briefingSrc), 'useShareAppMessage title');
  t('briefing 分享两条分支都在（titleAI / title）',
    briefingSrc.includes("'share.titleAI'") && briefingSrc.includes("'share.title'"), '三元两臂');
  t('briefing 不存在无条件挂 AI 前缀的调用',
    !/title:\s*t\('share\.titleAI'/.test(briefingSrc), '无门控调用必须为 0');

  const inboxSrc = fs.readFileSync(path.join(REPO, 'src/pages/inbox/index.tsx'), 'utf8');
  t('inbox 复制导出跟随 ai.labelText', inboxSrc.includes("t('ai.labelText')"), 'copyWorkResult');

  const aiLabelSrc = fs.readFileSync(path.join(REPO, 'src/utils/aiLabel.ts'), 'utf8');
  t('aiLabel 对照表登记 share.titleAI', aiLabelSrc.includes('`share.titleAI`'), 'key↔渲染点表');
}

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail ? '| ' + c.detail : ''}`);
console.log(`\n_RESULT pass=${cases.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
