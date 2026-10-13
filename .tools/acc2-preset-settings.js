/**
 * 验收 B/D 用：在页面脚本之前注入一份预置的 user-settings。
 * 关键：Taro H5 的 storage 信封是 localStorage.setItem(key, JSON.stringify({ data: <值> }))
 * （见 node_modules/@tarojs/taro-h5/dist/index.esm.js:1319 setStorageSync）。
 * Taro.getStorageSync 读出的是**已解包**的值。
 * 这里额外塞 replyStyle / newsEnabled，用于验证 writeProfileSettings 的读-改-写是否保留其它键。
 */
(function () {
  try {
    var preset = {
      nickname: '验收昵称',
      briefingTime: '06:15',
      preferences: ['科技'],
      replyStyle: 'casual',
      newsEnabled: false
    };
    localStorage.setItem('user-settings', JSON.stringify({ data: preset }));
    window.__ACC2_PRESET__ = preset;
  } catch (e) {
    /* ignore */
  }
})();
