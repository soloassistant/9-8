/**
 * stub-cloud-auth.cjs —— verify-util-logic.mjs 的云端桩（2026-10-26）
 *
 * 为什么需要它：`cloudStorage.ts` 的失败语义（不抛、返回 {ok:false, reason}）无法用静态断言证明 ——
 * 「会不会 reject」只有真的跑一遍才知道。而真实的 cloudAuth 在 Node 里跑不起来（要真会话）。
 * 所以这里复刻 cloudAuth 的**契约**（getSession / getCloudClient），并让 storage 的行为可切换。
 *
 * 忠实点（按 storage/code-generation.md）：
 *   · 方法返回 `{ data, error }`，失败不抛；
 *   · `userPath()` 在**发请求前**校验路径，非法时**抛** CloudStoragePathError
 *     —— 这正是被测 bug 的来源，桩必须复刻「抛」而不是「返回 error」。
 *
 * 用法：测试侧 `__setMode('path-throw')` → 调被测函数 → 断言 `__calls`。
 */
'use strict';

let mode = 'ok';
const calls = { userPath: 0, upload: 0, createSignedUrl: 0, remove: 0 };
const session = { user: { id: 'user-A' } };

function pathError(msg) {
  const e = new Error(msg);
  e.name = 'CloudStoragePathError';
  return e;
}

const storage = {
  userPath(uid, sub) {
    calls.userPath += 1;
    if (mode === 'path-throw') throw pathError('invalid path: must be under users/<uid>/');
    if (!uid) throw pathError('userPath requires a uid');
    return `users/${uid}/${sub}`;
  },
  sharedPath(uid, sub) {
    return `shared/${uid}/${sub}`;
  },
  async upload(path) {
    calls.upload += 1;
    if (mode === 'upload-error') return { data: null, error: { code: 'storage_error', message: 'boom' } };
    return { data: { path }, error: null };
  },
  async createSignedUrl(path) {
    calls.createSignedUrl += 1;
    if (mode === 'sign-fail') return { data: null, error: { code: 'sign_error', message: 'nope' } };
    if (mode === 'sign-throw') throw pathError('invalid path');
    return { data: { signedUrl: 'https://signed.example/' + path }, error: null };
  },
  async exists() {
    return { data: true, error: null };
  },
  async remove() {
    calls.remove += 1;
    if (mode === 'remove-fail') return { data: null, error: { code: 'remove_error', message: 'no' } };
    return { data: {}, error: null };
  }
};

function client() {
  return { auth: {}, database: {}, llm: {}, storage };
}

module.exports = {
  __setMode(m) {
    mode = m;
  },
  __calls: calls,
  __reset() {
    calls.userPath = 0;
    calls.upload = 0;
    calls.createSignedUrl = 0;
    calls.remove = 0;
  },
  getSession: async () => (mode === 'no-session' ? null : session),
  getCloudClient: async () => (mode === 'no-storage' ? { auth: {}, database: {} } : client())
};
