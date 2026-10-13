/* 把整个项目源码整合成单个文本文件，交给另一个 AI 阅读/修改 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目源码整合.md');

const INCLUDE = [
  'package.json',
  'project.config.json',
  'tsconfig.json',
  'babel.config.js',
  'PRD.md',
  'config/index.ts',
  'config/dev.ts',
  'config/prod.ts',
  'src',
  'cloudfunctions',
  '.tools/static-server.js',
  '.tools/llm-proxy.mjs',
  '.tools/fetch-data.js',
  '.tools/deploy-weapp.js',
  '.tools/deploy-gh-pages.cmd',
];
const EXCLUDE_DIR = ['node_modules', 'dist', '.git', 'assets', 'tabbar-png'];
const EXCLUDE_FILE = [/package-lock\.json$/, /miniprogram_npm/, /\.(png|jpg|jpeg|gif|svg|ico|webp|key|pem)$/i, /\.env/i];
const TEXT_EXT = /\.(ts|tsx|js|jsx|scss|css|json|md|txt|cmd)$/i;

const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (EXCLUDE_DIR.some((d) => name === d)) continue;
      walk(p);
    } else {
      if (!TEXT_EXT.test(name)) continue;
      if (EXCLUDE_FILE.some((r) => r.test(rel))) continue;
      if (st.size > 200 * 1024) continue;
      files.push(rel);
    }
  }
}
for (const inc of INCLUDE) {
  const p = path.join(ROOT, inc);
  if (!fs.existsSync(p)) continue;
  const st = fs.statSync(p);
  if (st.isDirectory()) walk(p);
  else files.push(inc.replace(/\\/g, '/'));
}
files.sort();

let out = `# 「私人晨报助理」项目源码整合（共 ${files.length} 个文件）\n`;
out += `> 生成时间 ${new Date().toISOString()} ｜ 排除：node_modules/dist/构建产物/图片二进制/密钥文件\n`;
out += `> 密钥全部走环境变量：LLM_API_KEY(DeepSeek)、LLM_WEB_API_KEY(通义)、WEATHER_KEY(和风)、TARO_APP_CLOUD_ENV(云环境ID)\n\n`;
out += `## 文件索引\n${files.map((f) => `- ${f}`).join('\n')}\n\n---\n`;
let total = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
  total += raw.length;
  const ext = (f.match(/\.(\w+)$/) || [, 'txt'])[1];
  // 围栏长度必须大于内容里最长的反引号串（CommonMark 规则），否则像 PRD.md 这种
  // 自带 ``` 代码块的文件会把围栏提前闭合，文档 markdown 结构从此歧义。
  const longest = (raw.match(/`+/g) || ['']).reduce((a, b) => (b.length > a.length ? b : a), '').length;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  out += `\n\n<!-- ══════════ 文件: ${f} ══════════ -->\n\n${fence}${ext}\n${raw}\n${fence}\n`;
}
fs.writeFileSync(OUT, out, 'utf8');
console.log(`OK ${files.length} files -> ${OUT}`);
console.log(`total ${(total / 1024).toFixed(0)} KB, output ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
