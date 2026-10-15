/**
 * 记账端到端验证的**数据种子**（注入 localStorage，供 CDP 探针用）。
 *
 * ⚠️⚠️ 关键：必须用 **Taro 的存储格式**，不能直接写裸JSON！
 *   Taro H5 的 setStorageSync 存的是 `JSON.stringify({data: <值>})`
 *   （见 node_modules/@tarojs/taro-h5/dist/index.cjs.js:1341），
 *   而 getStorageSync 走 getItem() → 取 `item.data`（:1425-1427）；
 *   **取不到或格式不对就返回空串 ''**（:1428），不是 undefined。
 *   所以直接 `localStorage.setItem('ledgerEntries', JSON.stringify([...]))`
 *   会让读到 undefined → 数组判空 → **卡片不渲染**，
 *   看起来像代码 bug，其实是种子写错了格式（2026-10-15 白排查半小时）。
 *
 * 本脚本与 .tools/cdp-probe-session.js 合并后作为 --init-script 注入
 * （合并是必须的：只有桩里带了 getSession 伪造会话，门禁才会放行进内页）。
 */
(function () {
  try {
    // Taro 存储格式：包一层 { data: 值 }
    var taroSet = function (key, value) {
      localStorage.setItem(key, JSON.stringify({ data: value }));
    };

    var today = new Date();
    var d =
      today.getFullYear() +
      '-' +
      String(today.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(today.getDate()).padStart(2, '0');
    var yest = new Date(today.getTime() - 86400000);
    var y =
      yest.getFullYear() +
      '-' +
      String(yest.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(yest.getDate()).padStart(2, '0');

    var nowIso = new Date().toISOString();
    // 今日 3 笔（合计 135.50，用于验证浮点与合计），昨日 1 笔 30（用于验证 delta）
    taroSet('ledgerEntries', [
      { id: 'l1', amount: 35.5, kind: 'expense', categoryId: 'cat_food', date: d, createdAt: nowIso },
      { id: 'l2', amount: 12, kind: 'expense', categoryId: 'cat_transport', date: d, createdAt: nowIso },
      { id: 'l3', amount: 88, kind: 'expense', categoryId: 'cat_shopping', date: d, createdAt: nowIso },
      { id: 'l4', amount: 30, kind: 'expense', categoryId: 'cat_food', date: y, createdAt: nowIso }
    ]);
    taroSet('ledger-categories', [
      { id: 'cat_food', name: '餐饮', icon: '🍜', kind: 'expense' },
      { id: 'cat_transport', name: '交通', icon: '🚇', kind: 'expense' },
      { id: 'cat_shopping', name: '购物', icon: '🛍️', kind: 'expense' }
    ]);
    // 日预算 100 < 今日 135.50 → 应触发超支提示
    taroSet('ledgerBudget', { daily: 100 });
  } catch (e) {
    /* 注入失败不应让探针崩 */
  }
})();