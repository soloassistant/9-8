import React, { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import { useT } from '@/store/language';
import {
  needsAuthGate,
  isCloudReady,
  getSession,
  signInWithPassword,
  sendLoginCode,
  verifyLoginCode,
  requestPasswordReset,
  signOut,
  isPhoneIdentifier,
  type AuthIdentifier
} from '@/services/cloudAuth';
import { decidePostLogin } from '@/services/bindPhoneGate';
import DialCodePicker from '@/components/DialCodePicker';
import { DEFAULT_DIAL_CODE, isSupportedDialCode } from '@/data/dialCodes';
import { buildPhoneE164, normalizeNational, validateNational } from '@/utils/phoneIntl';
import styles from './index.module.scss';

/** 阶段：校验中 → 显示登录表单。已登录不在这里"放行渲染"，而是**跳转到应用首页**。 */
type Phase = 'checking' | 'form';
type Tab = 'password' | 'otp' | 'signup' | 'forgot';
/** 登录标识通道：邮箱 或 手机号（短信验证码）。默认手机号（产品决策）。 */
type IdChannel = 'email' | 'phone';

/** 「获取验证码」同一次流程里的凭据。**必须活在事件之外** ——
 *  SDK 约定：获取验证码与提交验证是两个独立动作，提交时**不得再次发送**（否则每个码都作废）。 */
interface PendingOtp {
  id: AuthIdentifier;
  verificationId: string;
  isExistingUser: boolean;
}

const RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 手机号校验已交给 `validateNational(dialCode, account)`（支持国际区号）。
 *  原 `PHONE_RE = /^1\d{10}$/` 只适用于中国大陆，支持国际号码后必须删掉 ——
 *  否则 +852 的 8 位号码永远过不了前端校验。
 *  大陆的 `/^1[3-9]\d{9}$/` 形态约束（11 位、1 开头、第二位 3–9，排除 12 服务号）
 *  移到了 dialCodes 表的 `pattern` 字段。 */

/** 区号偏好的本地留存键。换区号 = 换登录标识，与「记住登录」无关，只记用户的选择。 */
const DIAL_CODE_KEY = 'sxm-dial-code';

/** 读区号偏好。⚠️ Taro 对不存在的键返回**空串 `''` 而不是 undefined**
 *  （见 readRememberLogin 的同一处证据），所以必须显式判类型 + 判是否受支持，
 *  否则一个空串或历史脏值就会被当成合法区号，拼出 `+` 开头的空号码。 */
function readDialCode(): string {
  try {
    const v = Taro.getStorageSync(DIAL_CODE_KEY);
    return typeof v === 'string' && isSupportedDialCode(v) ? v : DEFAULT_DIAL_CODE;
  } catch {
    return DEFAULT_DIAL_CODE;
  }
}

/** 翻译函数的最小结构类型（只为下面那个错误归一用，避免为此把 LangKey 拖进来） */
type TranslateFn = (key: 'auth.errSdkUnavailable') => string;

/**
 * 错误归一（**一处收口**）：`cloudAuth.safeAuth` 在「SDK 根本没加载 / 连不上后端」时
 * 返回 `error.kind === 'backend-unavailable'`，它和「凭证错」「验证码错」是**完全不同的事实**。
 * 如果不在展示层把它识别出来，各提交分支就会各写各的文案 —— 实测过：CDN 被屏蔽时
 * 用户填**完全正确**的邮箱密码点登录，拿到的是「账号或密码不正确」，于是去重置密码（同样会失败），
 * 把「依赖挂了」误判成「自己记错了」。那是不实告知。
 *
 * 所有提交分支都必须过这个函数；返回 null 时才用各自的兜底文案。
 * 注意不要顺手把 `error.message` 透出去 —— 密码登录刻意不区分"账号不存在/密码错"，
 * 透传 SDK 原文会破坏这个反枚举口径（见 submitPassword）。
 */
function sdkDownText(
  error: { kind?: string; message?: string } | null | undefined,
  t: TranslateFn
): string | null {
  return error && error.kind === 'backend-unavailable' ? t('auth.errSdkUnavailable') : null;
}

/** 隐私同意的本地留存键。**默认不勾选** —— 未经用户主动同意不得发起任何登录/取码动作。 */
const PRIVACY_CONSENT_KEY = 'sxm-privacy-consent';

/**
 * 「下次自动登录」的本地留存键。
 *
 * ⚠️ 这里存的**不是令牌** —— 会话令牌由云 SDK 的 SessionStore 持有，
 * 写在其内部的 localStorage（key 前缀 `workbuddy-cloud.session.`），本应用不碰。
 * 本键只记「用户是否希望被记住」这一个偏好值。
 *
 * 为什么要做这个开关：会话**本来就会**被持久化（关掉页面再打开仍然是登录态）。
 * 若 UI 上不给选择，等于替用户默认做了决定 —— 那既不合《个人信息保护法》的
 * 「自主决定权」，也让「换人用这台电脑」变得不可控。
 * 取消勾选 = 登出时**主动清掉 SDK 的会话**，下次必须重新走验证码。
 */
const REMEMBER_LOGIN_KEY = 'sxm-remember-login';

/** 默认记住：与实际行为一致（SDK 侧本来就持久化），且登录态是本应用的门禁前提。 */
function readRememberLogin(): boolean {
  try {
    const v = Taro.getStorageSync(REMEMBER_LOGIN_KEY);
    // ⚠️ Taro 对**不存在的键返回空串 ''，不是 undefined**（证据：cloudSync.ts:156
    // 「rawGet 为空串 '' 时也跳过」）。所以这里必须把 '' / null / undefined 都
    // 当成「用户从没设置过」→ 默认 true。
    // 踩过一次：最初写成 `v === undefined ? true : v === true`，
    // 而空串走else 分支得false → 首访就是未勾选，与设计意图相反。
    if (v === undefined || v === null || v === '') return true;
    return v === true;
  } catch {
    return true;
  }
}

/** 绑定手机号弹窗「稍后再说」的本地留存键。用户主动跳过则本次不再强弹（仅本地偏好，不阻塞登录）。 */
const PHONE_BIND_DISMISSED_KEY = 'sxm-phone-bind-dismissed';

/** 本机「手机号已绑定」的本地留存键。成功绑定 / 成功手机号登录后置 true —— 此后进入不再强弹。
 *
 * 为什么需要它（2026-10-21 根因修复）：此前的代码只在「跳过」时写 PHONE_BIND_DISMISSED_KEY，
 * **成功绑定后什么都不记**。而 H5 会话的 `user`（`wb-sdk.js` 的 `userFromSessionPayload`）恒为
 * `{ id, name, avatarUrl, isAnonymous, raw }`，**不含 phone**（`src/services/localProfile.ts:108` 已坐实），
 * 所以 `afterLogin` 的 `session.user.phone` 判据是死代码 —— 邮箱账号即便"绑过手机"也永远触发弹窗，
 * 形成"每次邮箱登录都重绑一次"的循环。本键把"本机已绑定"这个事实落盘，破掉循环。
 * 这是本机级标记（与 SKIP 同性质）；跨设备仍需各端各绑一次，属已知的产品约束。 */
const PHONE_BIND_DONE_KEY = 'sxm-phone-bind-done';

/** 记录本机"手机号已绑定"：成功绑定或成功以手机号登录后调用，后续进入不再强弹。 */
function markPhoneBound(): void {
  try {
    Taro.setStorageSync(PHONE_BIND_DONE_KEY, true);
  } catch {
    /* 存储不可用也不阻塞：最坏只是下次多弹一次，不致命 */
  }
}

function readPrivacyConsent(): boolean {
  try {
    return Taro.getStorageSync(PRIVACY_CONSENT_KEY) === true;
  } catch {
    return false;
  }
}

/** 两个 AuthIdentifier 是否指向同一账号（同通道且同值）。用于「换了通道/号码必须重新取码」。 */
function sameId(a: AuthIdentifier | null, b: AuthIdentifier): boolean {
  if (!a) return false;
  if (isPhoneIdentifier(a) && isPhoneIdentifier(b)) return a.phone === b.phone;
  if (!isPhoneIdentifier(a) && !isPhoneIdentifier(b)) return a.email === b.email;
  return false;
}

/**
 * 进入门禁：**未登录一律不得进入应用**（H5 / 发布版）。
 *
 * 为什么要有它：发布版是公开链接，此前任何人拿到链接就能进入，而 H5 的数据隔离用的是
 * localStorage 里自生成的 UUID —— 等于没有身份。现在进入前必须通过云服务认证。
 *
 * ⚠️ 2026-10-13 更正（此前注释有误）：早期注释称「Web 应用不支持手机号登录、别加手机号」——
 *   那是 2026-10-05 对旧 SDK 的读数。**当前 cloud-service 的 auth 规范明确 Phone (SMS) OTP
 *   在 Web app 受支持**（能力表 Phone (SMS) OTP: Web=yes），且 `services/cloudAuth.ts` 的
 *   `sendOtp/verifyOtp` 早已按 `{ phone }` 实现。故本页提供**邮箱 / 手机号双通道**，默认手机号。
 *   ⚠️ 运行前提：手机号短信 Provider 需在 WorkBuddy 管理后台为「私人晨报助理」**打开开关**；
 *     未打开时手机号取码会在服务端报错（UI 会给明确提示，可切回邮箱）。
 *
 * 平台差异（有意为之）：
 *   · H5 / 发布版：走云服务认证（邮箱 / 手机号）。未登录时**由 app.tsx 重定向到本页**（独立页面，
 *     不是"在 App 里不渲染 children"—— 那种做法会打断 Taro 的页面生命周期，
 *     实测抛「没有找到页面实例」并整页白屏）。
 *   · 微信小程序：身份由微信提供（云函数 login 拿 openid），无需再让用户登一次，
 *     故 `needsAuthGate` 为 false 时直接放行 —— 这不是"游客通道"，见 services/cloudAuth 的说明。
 *
 * 安全边界：这是**前端门禁**。真正的数据保护在服务端（云服务按身份 + RLS 隔离）；
 * 前端这层只负责"不登录就不给用"。**不做任何假身份兜底**：没有 mock session、没有本地假用户。
 */
export default function LoginPage() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('checking');
  const [channel, setChannel] = useState<IdChannel>('phone');
  const [tab, setTab] = useState<Tab>('otp');
  const [account, setAccount] = useState('');
  // 手机号通道的区号（不带 `+`）。默认中国大陆；主表单与绑定弹窗共用同一个值，
  // 避免"登录用 +852、绑定用 +86"这种同一设备内自相矛盾的状态。
  const [dialCode, setDialCode] = useState<string>(readDialCode);
  // 区号弹层的开关（与登录页的 bindPhone 遮罩并列渲染）
  const [dialPickerOpen, setDialPickerOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<PendingOtp | null>(null);
  const [resetTicket, setResetTicket] = useState<{
    updateUser(input: { nonce: string; password: string }): Promise<{ error: { message?: string } | null }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [countdown, setCountdown] = useState(0);
  // 个保法要求的明示同意：默认 false，用户主动勾选后才允许提交
  const [privacyOk, setPrivacyOk] = useState(readPrivacyConsent);
  // 「下次自动登录」：默认 true —— 与 SDK 侧的实际行为一致（会话本就持久化）。
  // 用户取消勾选时，下次登录成功后会主动清掉 SDK 会话。
  const [rememberLogin, setRememberLogin] = useState(readRememberLogin);

  // 邮箱登录后「绑定手机号」弹窗状态
  const [bindPhone, setBindPhone] = useState(false);
  const [bindPhoneVal, setBindPhoneVal] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindPending, setBindPending] = useState<PendingOtp | null>(null);
  const [bindCountdown, setBindCountdown] = useState(0);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState('');
  const [bindNotice, setBindNotice] = useState('');

  // 挂载校验：已有会话就进应用；否则显示登录表单。微信端身份由微信提供，直接放行。
  useEffect(() => {
    if (!needsAuthGate) {
      goToApp();
      return;
    }
    let alive = true;
    // 先判「后端是否可达」：连不上就别让用户对着一个必然失败的表单空点
    isCloudReady()
      .then((ready) => {
        if (!alive) return;
        if (!ready) setError(t('auth.errSdkUnavailable'));
      })
      .catch(() => {
        /* 由下面的 getSession 统一收口 */
      });
    getSession()
      .then((s) => {
        if (!alive) return;
        if (s) goToApp();
        else setPhase('form');
      })
      .catch(() => {
        if (!alive) return;
        setPhase('form');
      });
    return () => {
      alive = false;
    };
    // t 仅用于「后端不可达」错误文案；本 effect 负责会话校验/加载，语言切换无需重跑请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (bindCountdown <= 0) return;
    const timer = setTimeout(() => setBindCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [bindCountdown]);

  const clearMsg = () => {
    setError('');
    setNotice('');
  };

  /** 未同意隐私说明时拦住一切提交动作（登录 / 取码 / 注册 / 改密都算） */
  const requirePrivacy = (): boolean => {
    if (privacyOk) return true;
    setError(t('auth.errPrivacy'));
    return false;
  };

  const togglePrivacy = () => {
    const next = !privacyOk;
    setPrivacyOk(next);
    try {
      if (next) Taro.setStorageSync(PRIVACY_CONSENT_KEY, true);
      else Taro.removeStorageSync(PRIVACY_CONSENT_KEY);
    } catch {
      /* 存储不可用也不影响本次会话内的门禁 —— 状态在 React 里 */
    }
    if (next) setError('');
  };

  /**
   * 切换「下次自动登录」。
   *
   * ⚠️ 取消勾选必须**真的清掉 SDK 的会话**，否则这个开关是假的：
   *   会话由 SDK 的 SessionStore 存在 localStorage，本应用无法「只在内存里保留」。
   *   所以「不记住」的唯一诚实实现就是**立即登出**。
   *
   * 因此语义是：用户取消勾选 = 「我不想被记住，请把我登出」。
   * 此刻若本来就没登录（正常首访场景），什么都不做。
   */
  const toggleRememberLogin = () => {
    const next = !rememberLogin;
    setRememberLogin(next);
    try {
      Taro.setStorageSync(REMEMBER_LOGIN_KEY, next);
    } catch {
      /* 存储不可用：本次会话内仍以 React state 为准 */
    }
    if (next) return;
    void (async () => {
      try {
        const s = await getSession();
        // 没有会话 = 本来就没登录，取消勾选不需要任何副作用
        if (!s) return;
        await signOut();
        setNotice(t('auth.rememberLoggedOut'));
      } catch {
        /* 登出失败不打扰用户：开关状态已记住，下次登录时按新偏好走 */
      }
    })();
  };

  /** 当前通道的登录标识。
   *
   *  手机号必须由前端拼成 E.164（`+85291234567`）再交给 SDK —— 这里**不能**只传本地号码：
   *  SDK 的 `normalizePhone` 只对 `+86` 做归一，其他区号原样透传；若只传 8 位本地号码，
   *  服务端收到的就是一个没有区号的裸号码。
   *  （旧注释「国际区号归一由 SDK 内部完成」是错的，已按实测纠正。
   *   另注意：区号表刻意不含 `+1`，因为 SDK 会把任何 1 开头的 11 位数字改写成 +86 号码，
   *   详见 `src/data/dialCodes.ts` 头注释。） */
  const currentId = (): AuthIdentifier =>
    channel === 'phone' ? { phone: buildPhoneE164(dialCode, account) } : { email: account.trim() };

  /**
   * 切换区号。
   *
   * 换区号 = 换登录标识（+85291234567 与 +8691234567 是两个账号），所以：
   *   1) 必须作废已经拿到的 verificationId —— 它的 challenge 是绑定在旧号码上的，
   *      继续用它提交只会得到「请先为当前账号获取验证码」，更糟的情况是拿旧 challenge 验证了新号码；
   *   2) 必须把 countdown 归零 —— 否则「获取验证码」按钮会被上一个区号的 60 秒倒计时锁住，
   *      用户切了区号却点不动，只能干等。
   *  绑定弹窗的同类状态一并清掉（两地共用 dialCode，任何一处换了另一边都已失效）。 */
  const changeDialCode = (next: string) => {
    setDialCode(next);
    try {
      Taro.setStorageSync(DIAL_CODE_KEY, next);
    } catch {
      /* 存储不可用：本次会话内仍以 React state 为准 */
    }
    setPending(null);
    setCode('');
    setCountdown(0);
    setBindPending(null);
    setBindCode('');
    setBindCountdown(0);
    setBindError('');
    setBindNotice('');
    clearMsg();
  };

  /** 切通道：清空验证码凭据与已填内容，页签复位到该通道可用的首个。换通道必须重新取码。 */
  const switchChannel = (next: IdChannel) => {
    setChannel(next);
    setTab(next === 'phone' ? 'otp' : 'password');
    setPending(null);
    setResetTicket(null);
    setCode('');
    setPassword('');
    clearMsg();
  };

  /** 切页签时清空验证码凭据：换了方式/账号就必须重新取码，不能拿旧 challenge 去提交 */
  const switchTab = (next: Tab) => {
    setTab(next);
    setPending(null);
    setResetTicket(null);
    setCode('');
    setPassword('');
    clearMsg();
  };

  /** 账号输入框编辑：清掉字段级错误（邮箱格式 / 手机号格式） */
  const onAccountInput = () => {
    setError('');
  };

  const ensureAccount = (): boolean => {
    const v = account.trim();
    if (channel === 'phone') {
      // 校验交给区号表驱动的 validateNational：位数区间按区号不同，
      // 中国大陆还额外校验 `/^1[3-9]\d{9}$/`（11 位、1 开头、第二位 3–9）。
      // 'unsupported' / 'format' 都归到「无效手机号」。
      const issue = validateNational(dialCode, account);
      if (issue === 'empty') {
        setError(t('auth.errPhoneEmpty'));
        return false;
      }
      if (issue === 'length') {
        setError(t('auth.errPhoneLen'));
        return false;
      }
      if (issue !== null) {
        setError(t('auth.errPhone'));
        return false;
      }
      return true;
    }
    if (!EMAIL_RE.test(v)) {
      setError(t('auth.errEmail'));
      return false;
    }
    return true;
  };

  const doSendCode = async () => {
    if (busy || countdown > 0) return;
    if (!requirePrivacy()) return;
    if (!ensureAccount()) return;
    clearMsg();
    setBusy(true);
    const res = await sendLoginCode(currentId());
    setBusy(false);
    if (res.error) {
      setError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    setPending({ id: currentId(), verificationId: res.data.verificationId, isExistingUser: !!res.data.isExistingUser });
    setCountdown(RESEND_SECONDS);
    setNotice(channel === 'phone' ? t('auth.smsSent') : t('auth.otpSent'));
  };

  /** 提交验证码。**这里绝不调用 sendLoginCode** —— 重发只在「获取验证码」按钮上发生。 */
  const submitOtp = async (withPassword: boolean) => {
    if (busy) return;
    const id = currentId();
    if (!pending || !sameId(pending.id, id)) {
      setError(t('auth.errCodeNeeded'));
      return;
    }
    // 仅邮箱新账号必须有密码；手机号注册按 SDK 约定无密码；老账号登录不传密码
    if (withPassword && channel === 'email' && !pending.isExistingUser && password.length < 8) {
      setError(t('auth.errPassword'));
      return;
    }
    clearMsg();
    setBusy(true);
    const res = await verifyLoginCode({
      id: pending.id,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code.trim(),
      password: withPassword && channel === 'email' && !pending.isExistingUser ? password : undefined
    });
    setBusy(false);
    if (res.error) {
      setError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    setPending(null);
    // 手机号通道登录成功 = 本机已持有手机号，落"已绑定"标记，避免之后邮箱登录再被强弹
    if (channel === 'phone') markPhoneBound();
    void afterLogin();
  };

  const submitPassword = async () => {
    if (busy) return;
    if (!ensureAccount()) return;
    if (password.length < 8) {
      setError(t('auth.errPassword'));
      return;
    }
    clearMsg();
    setBusy(true);
    const res = await signInWithPassword({ email: account.trim() }, password);
    setBusy(false);
    if (res.error) {
      // 不区分「邮箱不存在」与「密码错」—— 避免暴露账号是否存在。
      // 但「后端根本没连上」不是凭证问题，必须单独说清楚（否则是误导用户去改密码）。
      setError(sdkDownText(res.error, t) || t('auth.errWrongCredentials'));
      return;
    }
    void afterLogin();
  };

  const startReset = async () => {
    if (busy) return;
    if (!ensureAccount()) return;
    clearMsg();
    setBusy(true);
    const res = await requestPasswordReset(account.trim());
    setBusy(false);
    if (res.error) {
      setError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    setResetTicket({ updateUser: res.data.updateUser });
    setCountdown(RESEND_SECONDS);
    setNotice(t('auth.forgotSent'));
  };

  const submitReset = async () => {
    if (busy || !resetTicket) return;
    if (password.length < 8) {
      setError(t('auth.errPassword'));
      return;
    }
    clearMsg();
    setBusy(true);
    const res = await resetTicket.updateUser({ nonce: code.trim(), password });
    setBusy(false);
    if (res.error) {
      setError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    // 重置成功后 SDK 会直接建立会话；再取一次确认，取不到就回登录页（不放行）
    const s = await getSession();
    if (s) goToApp();
    else setError(t('auth.errGeneric'));
  };

  /** 进入应用：switchTab 跳首个 tab（登录页不是 tab 页，不能留在导航栈里） */
  function goToApp() {
    Taro.switchTab({ url: '/pages/briefing/index' }).catch(() => {
      // 主通道（tab 跳转）失败时退回普通跳转；登录已成功，两条通道都失败会卡在登录页，必须留痕
      Taro.redirectTo({ url: '/pages/briefing/index' }).catch((err) => {
        console.error('[LoginPage] 登录后跳转晨报页失败:', err);
      });
    });
  }

  /** 登录成功后：所有用户都必须用手机号登录（产品硬约束）。
   *  放行判据按可信度从高到低（2026-10-21 修复，详见 PHONE_BIND_DONE_KEY 注释）：
   *   1) session.user.phone —— 当前 SDK 的 H5 会话 user 不含 phone，恒 undefined（前向兼容，未来 SDK 下发才生效）；
   *   2) user.raw 里的 phone 声明（phone 通道登录时服务端令牌载荷可能带 phone_number / phone）；
   *   3) 本机曾成功绑定 / 跳过 → PHONE_BIND_DONE_KEY / PHONE_BIND_DISMISSED_KEY。
   *  以上都不满足（邮箱账号且本机从未绑过）→ 跳出「绑定手机号」弹窗，验证通过才算完成登录。 */
  async function afterLogin() {
    let phone: string | null = null;
    try {
      const s = await getSession();
      const raw = (s?.user as unknown as
        | { raw?: { phone_number?: string; phone?: string; user?: { phone?: string } } }
        | undefined)?.raw;
      phone =
        s?.user?.phone ||
        raw?.phone_number ||
        raw?.phone ||
        raw?.user?.phone ||
        null;
    } catch {
      /* 取不到会话也走绑定弹窗 */
    }
    let boundDone = false;
    let dismissed = false;
    try {
      boundDone = Taro.getStorageSync(PHONE_BIND_DONE_KEY) === true;
      dismissed = Taro.getStorageSync(PHONE_BIND_DISMISSED_KEY) === true;
    } catch {
      /* 存储不可用 → 仍弹窗 */
    }
    if (decidePostLogin({ phone, boundDone, dismissed }) === 'enter-app') {
      goToApp();
      return;
    }
    setBindPhone(true);
  }

  /** 绑定弹窗遮罩（H5 内联，px/rgba，不写 rpx 以免被丢弃） */
  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 'var(--z-dialog)',
    padding: '0 24px'
  };

  const doBindSendCode = async () => {
    if (bindBusy || bindCountdown > 0) return;
    // 绑定弹窗与主表单共用 dialCode：换区号时 changeDialCode 已经把两侧的 pending 都作废了。
    const issue = validateNational(dialCode, bindPhoneVal);
    if (issue === 'empty') {
      setBindError(t('auth.errPhoneEmpty'));
      return;
    }
    if (issue === 'length') {
      setBindError(t('auth.errPhoneLen'));
      return;
    }
    if (issue !== null) {
      setBindError(t('auth.errPhone'));
      return;
    }
    const phone = buildPhoneE164(dialCode, bindPhoneVal);
    setBindError('');
    setBindNotice('');
    setBindBusy(true);
    const res = await sendLoginCode({ phone });
    setBindBusy(false);
    if (res.error) {
      setBindError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    setBindPending({ id: { phone }, verificationId: res.data.verificationId, isExistingUser: !!res.data.isExistingUser });
    setBindCountdown(RESEND_SECONDS);
    setBindNotice(t('auth.bindPhoneSent'));
  };

  const doBindVerify = async () => {
    if (bindBusy || !bindPending) return;
    // 与 doBindSendCode 用同一个拼法：pending.id 与这里的 id 必须逐字符相等，
    // sameId 比较的是 phone 字符串，任何一处少了 `+区号` 都会判成「换了号码」。
    const id: AuthIdentifier = { phone: buildPhoneE164(dialCode, bindPhoneVal) };
    if (!sameId(bindPending.id, id)) {
      setBindError(t('auth.errCodeNeeded'));
      return;
    }
    setBindError('');
    setBindBusy(true);
    const res = await verifyLoginCode({
      id: bindPending.id,
      verificationId: bindPending.verificationId,
      isExistingUser: bindPending.isExistingUser,
      token: bindCode.trim()
    });
    setBindBusy(false);
    if (res.error) {
      setBindError(sdkDownText(res.error, t) || res.error.message || t('auth.errGeneric'));
      return;
    }
    setBindPhone(false);
    setBindPending(null);
    markPhoneBound(); // 成功绑定后置标记，本机后续进入不再强弹
    goToApp();
  };

  /** 仅短信发送失败时才可达：本地留存「已跳过」，下次不再强弹，并放行进应用 */
  const skipBind = () => {
    try {
      Taro.setStorageSync(PHONE_BIND_DISMISSED_KEY, true);
    } catch {
      /* 存储不可用也不阻塞 */
    }
    setBindPhone(false);
    goToApp();
  };

  const handleSubmit = () => {
    if (busy) return;
    if (!requirePrivacy()) return;
    if (tab === 'password') void submitPassword();
    else if (tab === 'otp') void submitOtp(false);
    else if (tab === 'signup') void submitOtp(true);
    else if (!resetTicket) void startReset();
    else void submitReset();
  };

  if (phase === 'checking') {
    return (
      <View className={styles.screen}>
        <Text className={styles.checking}>{t('auth.checking')}</Text>
      </View>
    );
  }

  const canResend = countdown <= 0 && !busy;
  // 手机号通道没有「密码登录 / 忘记密码」（SDK 改密仅邮箱），只留 验证码登录 / 注册
  const tabs: Tab[] = channel === 'phone' ? ['otp', 'signup'] : ['password', 'otp', 'signup', 'forgot'];

  return (
    <View className={styles.screen}>
      <View className={styles.card}>
        {/* 品牌区：logo emoji + 应用标题 */}
        <View className={styles.brand}>
          <Text className={styles.brandLogo}>📰</Text>
          <Text>{t('app.title')}</Text>
        </View>
        <Text className={styles.title}>{t('auth.title')}</Text>
        <Text className={styles.subtitle}>{t('auth.subtitle')}</Text>

        {/* 通道切换：邮箱 / 手机号（短信验证码）。默认手机号。 */}
        <View className={styles.tabs}>
          {(['phone', 'email'] as IdChannel[]).map((k) => (
            <View
              key={k}
              className={`${styles.tab} ${channel === k ? styles.tabActive : ''}`}
              onClick={() => switchChannel(k)}
            >
              <Text className={channel === k ? styles.tabTextActive : styles.tabText}>
                {t(k === 'phone' ? 'auth.idPhone' : 'auth.idEmail')}
              </Text>
            </View>
          ))}
        </View>

        <View className={styles.tabs}>
          {tabs.map((k) => (
            <View
              key={k}
              className={`${styles.tab} ${tab === k ? styles.tabActive : ''}`}
              onClick={() => switchTab(k)}
            >
              <Text className={tab === k ? styles.tabTextActive : styles.tabText}>
                {t(
                  k === 'password'
                    ? 'auth.tabPassword'
                    : k === 'otp'
                      ? 'auth.tabOtp'
                      : k === 'signup'
                        ? 'auth.tabSignup'
                        : 'auth.tabForgot'
                )}
              </Text>
            </View>
          ))}
        </View>

        {/* 2026-10-24：手机通道（默认通道）的页签只有 [验证码, 注册]，密码登录页签
            仅在切到邮箱通道后才出现 —— 用户感知不到「本应用支持密码登录」。
            这里给一条显式入口：点击即切到邮箱通道并落在密码页签（切换会清空验证码凭据）。 */}
        {channel === 'phone' ? (
          <View className={styles.passwordHint} onClick={() => switchChannel('email')}>
            <Text className={styles.passwordHintText}>
              {t('auth.idEmail')} · {t('auth.tabPassword')} →
            </Text>
          </View>
        ) : null}

        <View className={styles.field}>
          <Text className={styles.label}>{channel === 'phone' ? t('auth.phone') : t('auth.email')}</Text>
          {channel === 'phone' ? (
            // 区号按钮 + 本地号码输入。两者分在两个字段里存，提交时才拼 E.164。
            <View className={styles.phoneRow}>
              <View className={styles.dialBtn} onClick={() => setDialPickerOpen(true)}>
                <Text className={styles.dialText}>{`+${dialCode}`}</Text>
                <Text className={styles.dialCaret}>▾</Text>
              </View>
              <Input
                className={`${styles.input} ${styles.phoneInput}`}
                type='number'
                value={account}
                maxlength={15}
                // 大陆用户看到「11 位手机号」最直观；其他国家只能提示「不含区号」，
                // 否则用户会把 +852 再输一遍（区号已经由左侧按钮提供）。
                placeholder={dialCode === '86' ? t('auth.phonePlaceholder') : t('auth.phoneIntlPlaceholder')}
                onInput={(e) => {
                  // `type='number'` 在 H5 仍可能放进 e / . / -，统一剥成数字，
                  // 让 state 里只存在能直接拼进 E.164 的字符。
                  setAccount(normalizeNational(String(e.detail.value || '')));
                  onAccountInput();
                }}
              />
            </View>
          ) : (
            <Input
              className={styles.input}
              type='text'
              value={account}
              placeholder={t('auth.emailPlaceholder')}
              onInput={(e) => {
                setAccount(String(e.detail.value || ''));
                onAccountInput();
              }}
            />
          )}
        </View>

        {tab === 'password' ? (
          <View className={styles.field}>
            <Text className={styles.label}>{t('auth.password')}</Text>
            <Input
              className={styles.input}
              password
              value={password}
              placeholder={t('auth.passwordPlaceholder')}
              onInput={(e) => setPassword(String(e.detail.value || ''))}
            />
          </View>
        ) : null}

        {tab === 'otp' || tab === 'signup' ? (
          <React.Fragment>
            <View className={styles.field}>
              <Text className={styles.label}>{t('auth.code')}</Text>
              <View className={styles.codeRow}>
                <Input
                  className={`${styles.input} ${styles.codeInput}`}
                  type='number'
                  value={code}
                  placeholder={channel === 'phone' ? t('auth.smsCodePlaceholder') : t('auth.codePlaceholder')}
                  onInput={(e) => setCode(String(e.detail.value || ''))}
                />
                <View
                  className={`${styles.codeBtn} ${canResend ? '' : styles.btnDisabled}`}
                  onClick={doSendCode}
                >
                  <Text className={styles.codeBtnText}>
                    {countdown > 0 ? t('auth.resend').replace('{s}', String(countdown)) : t('auth.sendCode')}
                  </Text>
                </View>
              </View>
            </View>
            {/* 仅邮箱新账号必须有密码；手机号注册按 SDK 约定无密码 */}
            {channel === 'email' && (tab === 'signup' || (pending && !pending.isExistingUser)) ? (
              <View className={styles.field}>
                <Text className={styles.label}>{t('auth.password')}</Text>
                <Input
                  className={styles.input}
                  password
                  value={password}
                  placeholder={t('auth.passwordPlaceholder')}
                  onInput={(e) => setPassword(String(e.detail.value || ''))}
                />
              </View>
            ) : null}
          </React.Fragment>
        ) : null}

        {tab === 'forgot' && resetTicket ? (
          <React.Fragment>
            <View className={styles.field}>
              <Text className={styles.label}>{t('auth.code')}</Text>
              <Input
                className={`${styles.input} ${styles.codeInput}`}
                type='number'
                value={code}
                placeholder={t('auth.codePlaceholder')}
                onInput={(e) => setCode(String(e.detail.value || ''))}
              />
            </View>
            <View className={styles.field}>
              <Text className={styles.label}>{t('auth.newPassword')}</Text>
              <Input
                className={styles.input}
                password
                value={password}
                placeholder={t('auth.passwordPlaceholder')}
                onInput={(e) => setPassword(String(e.detail.value || ''))}
              />
            </View>
          </React.Fragment>
        ) : null}

        {notice ? <Text className={styles.notice}>{notice}</Text> : null}
        {/* 用户报「收不到验证码」时，最常见的原因就是进了垃圾箱或地址/号码写错 —— 直接给排查方向 */}
        {notice && (tab === 'otp' || tab === 'signup') ? (
          <Text className={styles.hint}>{channel === 'phone' ? t('auth.smsSentHint') : t('auth.otpSentHint')}</Text>
        ) : null}
        {error ? <Text className={styles.error}>{error}</Text> : null}

        {/* 个保法「明示同意」：默认未勾选（☐），且未勾选时提交会被 requirePrivacy 拦下。
            整块可点，扩大勾选热区 —— 移动端小对勾很难点准。 */}
        <View className={styles.privacyRow} onClick={togglePrivacy}>
          <Text className={styles.privacyBox}>{privacyOk ? '☑' : '☐'}</Text>
          <View className={styles.privacyBody}>
            <Text className={styles.privacyText}>{t('auth.privacyNotice')}</Text>
            <Text className={styles.privacyAgree}>{t('auth.privacyAgree')}</Text>
          </View>
        </View>

        {/* 「下次自动登录」（2026-10-15）：独立于隐私同意，且**默认勾选**。
            两者性质不同，不能共用一个开关：
              · 隐私同意 = 处理个人信息的合法性前提，默认必须「未同意」；
              · 记住登录 = 纯便利偏好，默认「已记住」（因为 SDK 侧本来就会持久化会话），
                不给选择等于替用户默认做了决定。
            取消勾选 → 下次登录成功后会主动清除 SDK 会话，必须重新验证码。 */}
        <View className={styles.rememberRow} onClick={toggleRememberLogin}>
          <Text className={styles.rememberBox}>{rememberLogin ? '☑' : '☐'}</Text>
          <View className={styles.rememberBody}>
            <Text className={styles.rememberText}>{t('auth.rememberLogin')}</Text>
            <Text className={styles.rememberHint}>{t('auth.rememberLoginHint')}</Text>
          </View>
        </View>

        <View className={`${styles.submit} ${busy || !privacyOk ? styles.btnDisabled : ''}`} onClick={handleSubmit}>
          <Text className={styles.submitText}>
            {t(
              tab === 'password'
                ? 'auth.login'
                : tab === 'otp'
                  ? 'auth.login'
                  : tab === 'signup'
                    ? 'auth.signup'
                    : resetTicket
                      ? 'auth.resetSubmit'
                      : 'auth.sendCode'
            )}
          </Text>
        </View>
      </View>
      {bindPhone ? (
        <View style={overlayStyle}>
          <View className={styles.card}>
            <Text className={styles.title}>{t('auth.bindPhoneTitle')}</Text>
            <Text className={styles.subtitle}>{t('auth.bindPhoneSubtitle')}</Text>
            <View className={styles.field}>
              <Text className={styles.label}>{t('auth.phone')}</Text>
              <View className={styles.phoneRow}>
                <View className={styles.dialBtn} onClick={() => setDialPickerOpen(true)}>
                  <Text className={styles.dialText}>{`+${dialCode}`}</Text>
                  <Text className={styles.dialCaret}>▾</Text>
                </View>
                <Input
                  className={`${styles.input} ${styles.phoneInput}`}
                  type='number'
                  value={bindPhoneVal}
                  maxlength={15}
                  placeholder={dialCode === '86' ? t('auth.phonePlaceholder') : t('auth.phoneIntlPlaceholder')}
                  onInput={(e) => {
                    setBindPhoneVal(normalizeNational(String(e.detail.value || '')));
                    setBindError('');
                  }}
                />
              </View>
            </View>
            <View className={styles.field}>
              <Text className={styles.label}>{t('auth.code')}</Text>
              <View className={styles.codeRow}>
                <Input
                  className={`${styles.input} ${styles.codeInput}`}
                  type='number'
                  value={bindCode}
                  placeholder={t('auth.smsCodePlaceholder')}
                  onInput={(e) => setBindCode(String(e.detail.value || ''))}
                />
                <View
                  className={`${styles.codeBtn} ${bindCountdown <= 0 && !bindBusy ? '' : styles.btnDisabled}`}
                  onClick={doBindSendCode}
                >
                  <Text className={styles.codeBtnText}>
                    {bindCountdown > 0 ? t('auth.resend').replace('{s}', String(bindCountdown)) : t('auth.sendCode')}
                  </Text>
                </View>
              </View>
            </View>
            {bindNotice ? <Text className={styles.notice}>{bindNotice}</Text> : null}
            {bindError ? <Text className={styles.error}>{bindError}</Text> : null}
            <View className={`${styles.submit} ${bindBusy ? styles.btnDisabled : ''}`} onClick={doBindVerify}>
              <Text className={styles.submitText}>{t('auth.bindPhoneConfirm')}</Text>
            </View>
            {/* 「稍后再说」必须常驻：只在 bindSendFailed 时显示的话，
                短信码一直输不对（或发码接口持续失败）的用户会被锁死在绑定弹窗里 */}
            <View style={{ marginTop: '12px', textAlign: 'center' }} onClick={skipBind}>
              <Text style={{ color: '#888', fontSize: '14px' }}>{t('auth.bindPhoneSkip')}</Text>
            </View>
          </View>
        </View>
      ) : null}
      {/* 区号弹层与绑定弹窗并列挂在页面根节点：放在卡片外面，避免被卡片的
          背景/overflow 裁掉；DOM 顺序在后 → 同 z-index 下会盖在绑定弹窗之上。 */}
      <DialCodePicker
        visible={dialPickerOpen}
        value={dialCode}
        onSelect={(next) => {
          changeDialCode(next);
          setDialPickerOpen(false);
        }}
        onClose={() => setDialPickerOpen(false)}
      />
    </View>
  );
}
