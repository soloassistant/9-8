// @tarojs/taro 最小桩：只提供 language.ts 实际用到的 storage 读写。
// 目的：编译真实 language.ts 源码时不必把整个 Taro 运行时拖进 vm。
// 配套文件：verify-share-ai-label.mjs / verify-sync-conflict.mjs。
const store = new Map();
export default {
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => store.set(k, v)
};
