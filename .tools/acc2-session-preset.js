/**
 * 测试用注入脚本：伪造一个"已登录"的云服务 SDK。
 *
 * ⚠️ 只用于本地验证内页布局（未登录时门禁会把人挡在登录页，内页永远测不到）。
 *    通过 CDP 的 addScriptToEvaluateOnNewDocument 在页面脚本之前注入，
 *    **不进入任何构建产物、不提交**。
 *
 * 覆盖面：
 *   auth.getSession / onAuthStateChange / signOut
 *   database.rpc  → 返回空数组（各页的列表会渲染空态，但布局容器照常生成）
 *   llm.chat.completions.create → 恒定 reject，便于看降级路径
 *   storage → 最小占位
 */
(function () {
  var USER = { id: 'probe-user-0001', email: 'probe@example.test' };
  var SESSION = { user: USER };

  var listeners = [];
  var auth = {
    getSession: function () {
      return Promise.resolve({ data: SESSION, error: null });
    },
    signInWithPassword: function () {
      return Promise.resolve({ data: SESSION, error: null });
    },
    sendOtp: function () {
      return Promise.resolve({ data: { verificationId: 'v-probe', isExistingUser: true }, error: null });
    },
    verifyOtp: function () {
      return Promise.resolve({ data: SESSION, error: null });
    },
    resetPasswordForEmail: function () {
      return Promise.resolve({
        data: { updateUser: function () { return Promise.resolve({ data: SESSION, error: null }); } },
        error: null,
      });
    },
    signOut: function () {
      return Promise.resolve({ data: null, error: null });
    },
    onAuthStateChange: function (cb) {
      listeners.push(cb);
      return function () {
        listeners = listeners.filter(function (f) { return f !== cb; });
      };
    },
  };

  var database = {
    rpc: function (fn) {
      window.__PROBE_RPC__ = (window.__PROBE_RPC__ || []);
      window.__PROBE_RPC__.push(fn);
      return Promise.resolve([]);
    },
    from: function () {
      return {
        select: function () { return Promise.resolve({ data: [], error: null }); },
      };
    },
  };

  var STUB = {
    createWorkBuddyCloud: function () {
      return {
        auth: auth,
        database: database,
        llm: {
          chat: {
            completions: {
              create: function () {
                return Promise.reject(new Error('probe: llm disabled'));
              },
            },
          },
        },
        storage: {
          upload: function () { return Promise.reject(new Error('probe: storage disabled')); },
        },
      };
    },
    __probe: true,
  };

  // 关键：CDN 上的真 SDK 会 `window.WorkBuddyCloud = {...}`，若可写就会**静默覆盖测试桩**，
  // 于是"已登录"的测试态失效、页面被门禁踢回登录页 —— 测出来的就是登录页而不是内页。
  // 定义为不可写/不可配置属性，让 SDK 的赋值失败（sloppy 模式下静默失败），桩得以保留。
  try {
    Object.defineProperty(window, 'WorkBuddyCloud', {
      value: STUB,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (e) {
    window.WorkBuddyCloud = STUB;
  }
  window.__PROBE_LOGGED_IN__ = true;
})();

/* ===== 验收 B/D 追加：在会话桩之上预置 user-settings（Taro 信封 {data:值}） ===== */
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
  } catch (e) { /* ignore */ }
})();
