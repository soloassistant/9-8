// healthConsent 门禁用：只实现被 import 的五个同步闸门函数，不碰真实网络/存储。
// 真实语义（先摘范围、取消待发、等在途、删云端）由静态断言 A1–A4 钉住；
// 这里只让运行时断言能跑进「弹窗文案按端选择」那段代码。
module.exports = {
  cancelPendingPush: function () {},
  isSyncKeyExcluded: function () { return false; },
  purgeSyncKeysFromCloud: function () { return Promise.resolve('deleted'); },
  setSyncKeyExcluded: function () {},
  waitForPushIdle: function () { return Promise.resolve(); }
};
