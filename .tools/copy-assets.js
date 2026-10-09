// 构建后置：拷贝 tabBar PNG 与品牌素材到产物目录（Taro H5 不执行 config.copy）。
// 用法：node .tools/copy-assets.js [distDir]，默认 dist。
//
// 额外职责（2026-10-09 补）：兜底数据 dist/api/hotspot.json 会被**每次构建清掉**
// （Taro 构建先清空产物目录）。前端兜底链第 3 跳读不到它，就只剩更新的那一跳，
// 而"发布时烘焙的数据会停在打包那一刻"这件事此前只能靠人手动备份/还原 ——
// 实践证据是它在一次构建后真的丢了（见 docs/实施手册-2026-10-09.md）。
// 因此这里在**发现它缺失时**尝试取一份当日数据补回。
// best-effort：失败只告警、绝不抛错，不阻塞构建。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(root, process.argv[2] || 'dist');
const src = path.resolve(root, 'src/assets');

// 可用 HOTSPOT_LIVE_URL 覆盖（测试负路径时指到一个必然失败的地方）
const LIVE_HOTSPOT_URL =
  process.env.HOTSPOT_LIVE_URL || 'https://soloassistant.github.io/9-8/api/hotspot.json';
const HOTSPOT_OUT = path.join(dist, 'api/hotspot.json');

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

/**
 * 兜底数据缺失时补一份 —— best-effort，任何失败都只告警。
 * 只在"文件不存在"时才发起请求，所以正常重复构建不会每次都打网络。
 */
async function ensureHotspotFallback() {
  if (fs.existsSync(HOTSPOT_OUT)) {
    console.log(`[copy-assets] hotspot fallback: 已在位 ${fs.statSync(HOTSPOT_OUT).size} B`);
    return;
  }
  try {
    const res = await fetch(LIVE_HOTSPOT_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 先校验是可解析的、并且真的是热点结构，避免把错误页当成数据写进去
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(parsed.items)) throw new Error('items 不是数组，拒绝落盘');
    fs.mkdirSync(path.dirname(HOTSPOT_OUT), { recursive: true });
    fs.writeFileSync(HOTSPOT_OUT, buf);
    console.log(
      `[copy-assets] hotspot fallback restored: ${buf.length} B, ` +
        `${parsed.items.length} items, updatedAt=${parsed.updatedAt || '(无)'}`
    );
  } catch (err) {
    console.warn(
      `[copy-assets] hotspot fallback MISSING (${(err && err.message) || err}) ` +
        `-- 离线兜底第 3 跳不可用；手动补： curl.exe -sS ${LIVE_HOTSPOT_URL} -o "${HOTSPOT_OUT}"`
    );
  }
}

ensureHotspotFallback();
