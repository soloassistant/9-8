/**
 * 登录后「是否还须强弹绑定手机号」的纯决策（2026-10-21 从 login/index.tsx 的
 * afterLogin 抽离，便于单测与回归守护）。
 *
 * 为什么抽出来：原 afterLogin 把「取会话 → 读本地标记 → 分支」揉在一个 async 闭包里，
 * 既没法单测，也正是在这儿埋了「邮箱账号永远强弹、且绑定成功也不记标记」的回归坑
 * （详见 PHONE_BIND_DONE_KEY 注释与 2026-10-21 的修复）。
 *
 * 判据可信度从高到低：
 *   1) 会话 user 带 phone —— 当前 H5 会话 user 不含 phone（wb-sdk 的 userFromSessionPayload
 *      无此字段），恒 undefined；这里保留是为了前向兼容未来 SDK 下发 phone 的情况。
 *   2) 本机曾成功绑定（boundDone）/ 曾主动跳过（dismissed）→ 不再强弹。
 * 都不满足（邮箱账号且本机从未绑过）→ 强弹「绑定手机号」，验证通过才算完成登录。
 */
export type BindDecision = 'enter-app' | 'show-bind';

export interface PostLoginInput {
  /** 会话 user 携带的手机号（H5 会话通常没有，恒 undefined）。 */
  phone?: string | null;
  /** 本机曾成功绑定手机号（doBindVerify 成功后 markPhoneBound 写入）。 */
  boundDone?: boolean;
  /** 本机曾主动跳过绑定（skipBind 写入，仅本地偏好，不阻塞登录）。 */
  dismissed?: boolean;
}

export function decidePostLogin(input: PostLoginInput): BindDecision {
  if (input.phone) return 'enter-app';
  if (input.boundDone || input.dismissed) return 'enter-app';
  return 'show-bind';
}
