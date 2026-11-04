/**
 * 自选股同步防回归（2026-11-03）。
 *
 * 背景：`cloud-sync-meta/confirm` 曾全局共享，换账号后远端较新的空数组
 * 会静默覆盖本地 watchlist，再由本机回推空数组，导致「自选股突然没了」。
 *
 * 这是静态不变量检查（不依赖浏览器/云环境）：一旦有人删掉下面任何一条保护，
 * 脚本立刻失败。真正的端到端验证仍需在 H5 上切换两个账号执行。
 */
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

const sync = read('src/services/cloudSync.ts');
const briefing = read('src/pages/briefing/index.tsx');

const checks = [
  ['meta/confirm 按 owner 隔离', /ownerKey\(META_KEY\)/.test(sync) && /ownerKey\(CONFIRM_KEY\)/.test(sync)],
  ['迁移前备份旧全局元数据', /\$\{base\}-backup-\$\{next\}/.test(sync)],
  ['登录态变化时绑定 owner', /setSyncOwner\(session\?\.user\?\.id\)/.test(sync)],
  ['空数组不上推', /Array\.isArray\(v\) && v\.length === 0/.test(sync)],
  ['远端空数组不覆盖本地非空', /row\.value\.length === 0 && Array\.isArray\(localValue\)/.test(sync)],
  ['晨报页等待云端恢复后再读自选', /cloudSyncReady\(\)/.test(briefing)],
  ['晨报页 useDidShow 重读自选', /useDidShow[\s\S]{0,200}getWatchlist/.test(briefing)],
  // 2026-11-04：Taro 的 Text 不透传未知 props（与 tabIndex 同族），data-testid 在真实 DOM 里不落地。
  // 自动化改用稳定 className；这条断言防有人「顺手改回 data-testid」把选择器再次变成死选择器。
  ['删除按钮用稳定 className（勿回退 data-testid）', /className='watch-remove-btn'/.test(briefing) && !/data-testid='watchlist-remove'/.test(briefing)],
  // 交互事实：✕ 只在「管理」编辑态出现，删一条后自动退出编辑态。
  ['删除后自动退出管理态', /const handleRemoveStock = async[\s\S]{0,500}setQuoteOpen\(false\)/.test(briefing)]
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`\n[watchlist-sync] ${failed} 项保护缺失，疑似回退。`);
  process.exit(1);
}
console.log('\n[watchlist-sync] 全部通过。');
