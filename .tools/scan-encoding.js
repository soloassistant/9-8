// 扫描本轮改动过的文件里的 U+FFFD（编码损坏）与 GBK 乱码残留，并打印上下文。
const fs = require('fs');
const files = [
  'D:/Agent/cloudfunctions/webSearch/index.js',
  'D:/Agent/src/services/localProfile.ts',
  'D:/Agent/src/services/api.ts',
  'D:/Agent/docs/未完成任务交接单-2026-10-08.md',
  'D:/Agent/.tools/test-trust-filter.js',
  'D:/Agent/.tools/test-trust-filter-incident.js',
  'D:/Agent/.tools/test-trust-filter-corpus.js',
  'D:/Agent/.tools/verify-auth-wiring.js',
  'D:/Agent/.tools/fixtures/incident-2026-10-08-poisoned-feed.json'
];

let total = 0;
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.log(`SKIP  ${f} (不存在)`);
    continue;
  }
  const s = fs.readFileSync(f, 'utf8');
  const lines = s.split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    if (l.includes('\uFFFD')) hits.push({ n: i + 1, why: 'U+FFFD', line: l.trim() });
  });
  // GBK 乱码特征：常见错码片段（只在中文源码里查）
  if (/\.(js|ts|tsx|md|json)$/.test(f)) {
    lines.forEach((l, i) => {
      if (/鏂囧瓧|鏄庣|绉戠|鐧ㄥ|鍔犺浇|锛宲|鈥揿|鈥揙|涓撳]/i.test(l)) hits.push({ n: i + 1, why: 'GBK乱码', line: l.trim() });
    });
  }
  if (!hits.length) {
    console.log(`CLEAN ${f.replace('D:/Agent/', '')}`);
  } else {
    total += hits.length;
    console.log(`DIRTY ${f.replace('D:/Agent/', '')}  (${hits.length} 处)`);
    hits.forEach((h) => console.log(`      ${h.n}  [${h.why}]  ${h.line.slice(0, 110)}`));
  }
}
console.log(total ? `\n共 ${total} 处待修` : '\n全部干净');
process.exit(total ? 1 : 0);
