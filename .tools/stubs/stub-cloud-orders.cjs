// 订单服务端桩（AC-03 门禁用）：用 globalThis.__ORDERS_RESP__ 控制返回值。
// 语义与真实 ordersListOwn 的三种结果一致：ok / no-session / db-error（+ 抛错）。
module.exports = {
  ordersListOwn: async function () {
    var v = globalThis.__ORDERS_RESP__;
    if (!v) return { ok: true, orders: [] };
    if (v.reject) throw new Error('orders stub rejected');
    return v;
  },
  // 订阅回放入口（与展示列表返回同一形状；门禁只关心 entitlement 走哪条读取路径）
  ordersListOwnForReplay: async function () {
    var v = globalThis.__ORDERS_RESP__;
    if (!v) return { ok: true, orders: [] };
    if (v.reject) throw new Error('orders stub rejected');
    return v;
  },
};
