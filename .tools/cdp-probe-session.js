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

  // ⚠️ 查询构造器必须是**可链式且可 await 的 thenable**，而且要能扛住任意链式方法。
  //    历史：第一版 `select: () => Promise.resolve(...)` → `.select().order()` 直接抛
  //    "order is not a function"；补了 order/eq 之后又冒出 `.abortSignal()`、`.gte()`。
  //    这类洞是**无穷的**（SDK 每加一个过滤方法就再红一次），所以改用 Proxy：
  //    除了显式列出的终态方法，任何未知方法名都返回 api 自身，链式调用永远成立。
  //    桩造的假红比没有测试更糟 —— 它会让人去改本来没坏的代码。
  function makeQuery() {
    var payload = Promise.resolve({ data: [], error: null, count: 0 });
    var api = new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'then') return function (a, b) { return payload.then(a, b); };
        if (prop === 'catch') return function (b) { return payload.catch(b); };
        if (prop === 'finally') return function (f) { return payload.finally(f); };
        // 终态：返回结果本身
        if (prop === 'single' || prop === 'maybeSingle') return function () { return payload; };
        if (prop === 'insert' || prop === 'upsert') return function () { return payload; };
        if (prop === 'abortSignal') return function () { return api; };
        // 其余任何方法：继续可链式
        return function () { return api; };
      }
    });
    return api;
  }

  var database = {
    rpc: function (fn) {
      window.__PROBE_RPC__ = (window.__PROBE_RPC__ || []);
      window.__PROBE_RPC__.push(fn);
      return Promise.resolve([]);
    },
    from: function () {
      return makeQuery();
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
