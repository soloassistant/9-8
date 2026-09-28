// 包装 .tools/board-probe.ts：用 DailyHotApi 自带的 tsx 跑它，并透传退出码。
//
// 为什么必须把 cwd 设为 .tools/DailyHotApi：tsx 默认按 cwd 找最近的 tsconfig；在项目根跑会读到
// 根 tsconfig（baseUrl: ""），报 `Non-relative paths are not allowed when 'baseUrl' is not set`。
// 所以 tsconfig 显式传 DailyHotApi 的，cwd 也必须是它。
//
// 两个已实测的环境坑（勿「优化」掉）：
//   1) Windows 的 .bin 里可执行名是 tsx.cmd，直接 spawn 会 EINVAL，必须 shell: true；
//      非 Windows 是 tsx，直接 spawn 即可。
//   2) 受限环境下 spawnSync 用 encoding:'utf8' 抓管道输出会抛 EBUSY —— 故统一 stdio:'inherit'
//      （子进程输出直接透传到终端），只读退出码判断成败。
//
// 用法：node .tools/verify-boards.js   （exit 0 = 9 个板块全部 条数>0 且 耗时<8000ms）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DAILYHOT = path.join(__dirname, 'DailyHotApi');
const bin = path.join(DAILYHOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const tsconfig = path.join(DAILYHOT, 'tsconfig.json');
const probe = path.join(__dirname, 'board-probe.ts');

for (const [label, p] of [['tsx', bin], ['tsconfig', tsconfig], ['board-probe.ts', probe]]) {
  if (!fs.existsSync(p)) {
    console.error('[verify-boards] 缺少 ' + label + '：' + p);
    process.exit(1);
  }
}

const r = spawnSync(bin, ['--tsconfig', tsconfig, probe], {
  cwd: DAILYHOT,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (r.error) {
  console.error('[verify-boards] 启动 tsx 失败：' + r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
