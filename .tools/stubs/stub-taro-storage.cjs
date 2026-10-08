// 忠实复刻 @tarojs/taro-h5 的存储语义（依据 node_modules/@tarojs/taro-h5/dist/index.cjs.js:1341/1383/1416）：
//   setStorageSync(k,v) → localStorage.setItem(k, JSON.stringify({data:v}))
//   getStorageSync(k)   → 解包返回 {data} 里的 data；缺失返回 ''
//   removeStorageSync(k)→ localStorage.removeItem(k)
// 用 globalThis 兜底存储，保证即使被 esbuild 内联成两份，读写仍是同一份状态。
var S = (globalThis.__STORE__ = globalThis.__STORE__ || new Map());
function unwrap(raw) {
  try {
    var o = JSON.parse(raw);
    if (o && typeof o === 'object' && 'data' in o) return o.data;
    return o;
  } catch (e) {
    return '';
  }
}
module.exports = {
  setStorageSync: function (k, v) { S.set(k, JSON.stringify({ data: v === undefined ? '' : v })); },
  getStorageSync: function (k) { return S.has(k) ? unwrap(S.get(k)) : ''; },
  removeStorageSync: function (k) { S.delete(k); },
  // localProfile 不直接用下面这些，但保留以免将来 import 面变大：
  getStorage: function (o) { var v = module.exports.getStorageSync(o.key); return v === '' ? Promise.reject({ errMsg: 'data not found' }) : Promise.resolve({ data: v }); },
  setStorage: function (o) { module.exports.setStorageSync(o.key, o.data); return Promise.resolve(); },
};
