// 学习模块整合门禁：单一进度源 / 44px 热区 / 课程元数据缺失兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const page = read('src/pages/learn/index.tsx');
const sources = read('src/components/LearnSources/index.tsx');
const scss = read('src/components/LearnSources/index.module.scss');
const helper = path.join(root, 'src/utils/learnSources.ts');
const count = (text, re) => (text.match(re) || []).length;
const results = [];
const run = (name, fn) => {
  try {
    const reason = fn();
    results.push({ name, ok: reason === true, reason: reason === true ? '' : reason });
  } catch (e) {
    results.push({ name, ok: false, reason: `异常：${e.message}` });
  }
};

// 1) 同一份进度只能由 LX 展示：页面唯一 stats/progress，外部来源组件不得读进度
run('学习页只有一份统计与进度条', () => {
  if (count(page, /styles\.statsCard/g) !== 1) return 'statsCard 必须只出现 1 次';
  if (count(page, /styles\.progressTrack/g) !== 1) return 'progressTrack 必须只出现 1 次';
  if (count(page, /<LearnSources/g) !== 1) return 'LearnSources 入口块必须只出现 1 次';
  if (/PartnerEntry|PartnerSectionHeader/.test(page)) return '页面残留旧 PartnerEntry，会出现两个学习入口';
  const hit = sources.match(/getLangStats|getCourseProgress|readLearnStore|getStreak|stats\.|percent|learned|progressTrack|courseBar/);
  if (hit) return `外部来源组件读取了进度数据（${hit[0]}），会形成两套进度`;
  if (/from ['"]@\/utils\/learn['"]/.test(sources)) return '外部来源组件不得引用 @/utils/learn';
  if (count(sources, /learn-plus-card/g) !== 1) return 'Plus 卡必须只出现 1 次';
  if (count(sources, /learn-course-card/g) !== 1) return '课程源卡必须只出现 1 次';
  return true;
});

// 2) 入口卡点按热区：88rpx = 375 视口 44px（项目根字号 100vw/20，750 设计宽）
run('入口卡 min-height 88rpx（375 下 44px）', () => {
  const m = scss.match(/\.card,\s*\.courseCard\s*\{([^}]*)\}/);
  if (!m) return '未找到 .card/.courseCard 共用样式块';
  return /min-height:\s*88rpx/.test(m[1]) ? true : '.card/.courseCard 缺少 min-height: 88rpx';
});

// 3) 没有远程课程数据时必须回落到本地文案，不能渲染空标题/空来源
run('课程元数据缺失时显示兜底文案', () => {
  const code = buildSync({ entryPoints: [helper], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('exports', 'module', code)(mod.exports, mod);
  const { resolveCourseMeta } = mod.exports;
  const fb = { title: '灵犀课堂', intro: '课程由灵犀课堂提供', duration: '时长以课程页为准', source: '课程由灵犀课堂提供' };
  const empty = resolveCourseMeta(null, fb);
  for (const k of Object.keys(fb)) if (!empty[k] || empty[k].trim() !== fb[k]) return `remote=null 时 ${k} 未回落`;
  const blank = resolveCourseMeta({ title: '   ', intro: '', duration: undefined, source: null }, fb);
  for (const k of Object.keys(fb)) if (!blank[k] || blank[k].trim() !== fb[k]) return `remote 字段为空时 ${k} 未回落`;
  return true;
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` → ${r.reason}`}`);
}
if (failed > 0) {
  console.error(`FAIL ${failed}/${results.length}`);
  process.exit(1);
}
console.log(`PASS ${results.length}/${results.length}`);
