/**
 * 验收 C 用测试桩：会话里**有 user 但没有 id**（模拟"门禁看到已登录，但建档取不到身份"）。
 * 门禁判 `s` 真值 → 放行；buildProfileFromSession 应在 user.id 缺失时抛错。
 * 同时挂 MutationObserver 记录 toast 文案（Taro.showToast 默认只显示 1.5s，
 * 探针采样时早已消失，必须在其出现的那一刻抓下来）。
 */
(function () {
  var USER = { email: 'x@y.z' }; // 关键：没有 id
  var SESSION = { user: USER };

  var listeners = [];
  var auth = {
    getSession: function () { return Promise.resolve({ data: SESSION, error: null }); },
    signInWithPassword: function () { return Promise.resolve({ data: SESSION, error: null }); },
    sendOtp: function () { return Promise.resolve({ data: { verificationId: 'v-probe', isExistingUser: true }, error: null }); },
    verifyOtp: function () { return Promise.resolve({ data: SESSION, error: null }); },
    resetPasswordForEmail: function () {
      return Promise.resolve({ data: { updateUser: function () { return Promise.resolve({ data: SESSION, error: null }); } }, error: null });
    },
    signOut: function () { return Promise.resolve({ data: null, error: null }); },
    onAuthStateChange: function (cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (f) { return f !== cb; }); };
    }
  };
  var database = {
    rpc: function (fn) {
      window.__PROBE_RPC__ = (window.__PROBE_RPC__ || []);
      window.__PROBE_RPC__.push(fn);
      return Promise.resolve([]);
    },
    from: function () { return { select: function () { return Promise.resolve({ data: [], error: null }); } }; }
  };
  var STUB = {
    createWorkBuddyCloud: function () {
      return {
        auth: auth,
        database: database,
        llm: { chat: { completions: { create: function () { return Promise.reject(new Error('probe: llm disabled')); } } } },
        storage: { upload: function () { return Promise.reject(new Error('probe: storage disabled')); } }
      };
    },
    __probe: true
  };
  try {
    Object.defineProperty(window, 'WorkBuddyCloud', { value: STUB, writable: false, configurable: false, enumerable: true });
  } catch (e) { window.WorkBuddyCloud = STUB; }
  window.__PROBE_LOGGED_IN__ = true;

  // ---- toast 抓取：任何新出现且文本命中关键字的节点都记下来 ----
  window.__ACC2_TOASTS__ = [];
  var KEYS = ['初始化失败', '加载失败', '重试'];
  try {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes || [];
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          var txt = (el && el.textContent) || '';
          for (var k = 0; k < KEYS.length; k++) {
            if (txt.indexOf(KEYS[k]) >= 0) {
              window.__ACC2_TOASTS__.push({ key: KEYS[k], text: txt.slice(0, 80), t: Date.now() });
            }
          }
        }
      }
    });
    var start = function () {
      if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
      else setTimeout(start, 10);
    };
    start();
  } catch (e) { /* ignore */ }
})();
