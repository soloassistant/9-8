// 原子化更新预览快照：node d:\Agent\.tools\update-snapshot.js
// 流程: dist -> staging -> 轮换 rename（毫秒级窗口，服务不会读到半成品目录）
const fs = require('fs');
const path = require('path');
const dist = path.resolve(__dirname, '..', 'dist');
const snap = path.join(__dirname, 'preview-snapshot');
const staging = path.join(__dirname, 'preview-staging');
const old = path.join(__dirname, 'preview-snapshot-old');

fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(dist, staging, { recursive: true });
fs.rmSync(old, { recursive: true, force: true });
if (fs.existsSync(snap)) fs.renameSync(snap, old);
fs.renameSync(staging, snap);
fs.rmSync(old, { recursive: true, force: true });
console.log('snapshot updated');
