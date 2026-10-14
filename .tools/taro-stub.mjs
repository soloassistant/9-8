/**
 * taro-stub.mjs —— Node  harness 里的 @tarojs/taro 替身。
 *
 * 只实现被测模块真正用到的面，且**忠实复刻 Taro H5 的存储信封契约**：
 * setStorageSync 写入 localStorage 的是 JSON.stringify({ data: value })，
 * getStorageSync 只认带 data 属性的信封对象。cloudSync 的 rawGet/taroUnwrap
 * 正是按这个契约实现的 —— 桩这里偷懒改成语义，就会让被测代码在 harness 里
 * 通过、在线上失败（或反之）。
 *
 * 另提供 setTabBarItem / getCurrentPages / redirectTo 等 no-op，供 app 级模块加载时不炸。
 *
 * 存储后端：**优先 window.localStorage** —— 真实 Taro H5 的 setStorageSync 写的就是它，
 * 而 cloudSync 的 rawGet/rawSet 也直读它。桩若自用一个独立 Map，两边互相看不见，
 * 「Taro 写入 → cloudSync 读取」这类链路在 harness 里会静默失效（测了等于没测）。
 * 没有 window 的环境（纯 Node 跑）退化为内存 Map。
 */
const ls = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
const memStore = new Map();
const store = {
  set(key, value) { if (ls) ls.setItem(key, value); else memStore.set(key, value); },
  get(key) { if (ls) return ls.getItem(key); return memStore.has(key) ? memStore.get(key) : null; },
  has(key) { if (ls) return ls.getItem(key) !== null; return memStore.has(key); },
  delete(key) { if (ls) ls.removeItem(key); else memStore.delete(key); },
  clear() { if (ls) ls.clear(); else memStore.clear(); }
};

function wrap(value) {
  return JSON.stringify({ data: value === undefined ? null : value });
}
function unwrap(raw) {
  if (raw === null || raw === undefined) return '';
  let item;
  try { item = JSON.parse(raw); } catch { return ''; }
  if (item && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, 'data')) {
    return item.data;
  }
  return item;
}

const listeners = {};
const Taro = {
  ENV: 'h5',
  setStorageSync(key, value) { store.set(key, wrap(value)); },
  getStorageSync(key) { return unwrap(store.has(key) ? store.get(key) : null); },
  removeStorageSync(key) { store.delete(key); },
  clearStorageSync() { store.clear(); },
  setTabBarItem() {},
  setNavigationBarTitle() {},
  getCurrentPages() { return []; },
  redirectTo() { return Promise.resolve(); },
  navigateTo() { return Promise.resolve(); },
  switchTab() { return Promise.resolve(); },
  navigateBack() { return Promise.resolve(); },
  on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
  off(event, cb) {
    const arr = listeners[event] || [];
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  },
  emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
  /** 供 harness 直接读写底层 Map（断言信封格式） */
  __store: store
};

export default Taro;
