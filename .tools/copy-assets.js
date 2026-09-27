// 构建后置：拷贝 tabBar PNG 与品牌素材到产物目录（Taro H5 不执行 config.copy）。
// 用法：node .tools/copy-assets.js [distDir]，默认 dist。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(root, process.argv[2] || 'dist');
const src = path.resolve(root, 'src/assets');

const jobs = [
  { from: path.join(src, 'tabbar-png'), to: path.join(dist, 'assets/tabbar-png') },
  { from: path.join(src, 'logo.png'), to: path.join(dist, 'assets/logo.png') },
  { from: path.join(src, 'share-cover.png'), to: path.join(dist, 'assets/share-cover.png') }
];

let copied = 0;
for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    console.warn('[copy-assets] missing:', job.from);
    continue;
  }
  fs.mkdirSync(path.dirname(job.to), { recursive: true });
  if (fs.statSync(job.from).isDirectory()) {
    fs.mkdirSync(job.to, { recursive: true });
    for (const f of fs.readdirSync(job.from)) {
      if (f.endsWith('.png')) {
        fs.copyFileSync(path.join(job.from, f), path.join(job.to, f));
        copied++;
      }
    }
  } else {
    fs.copyFileSync(job.from, job.to);
    copied++;
  }
}
console.log(`[copy-assets] ${copied} files -> ${dist}`);
