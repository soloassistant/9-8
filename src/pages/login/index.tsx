import React, { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import { useT } from '@/store/language';
import {
  needsAuthGate,
  isCloudReady,
  getSession,
  signInWithPassword,
  sendEmailCode,
  verifyEmailCode,
  requestPasswordReset
} from '@/services/cloudAuth';
import styles from './index.module.scss';

/** 阶段：校验中 → 显示登录表单。已登录不在这里"放行渲染"，而是**跳转到应用首页**。 */
type Phase = 'checking' | 'form';
type Tab = 'password' | 'otp' | 'signup' | 'forgot';

/** 「获取验证码」同一次流程里的凭据。**必须活在事件之外** ——
 *  SDK 约定：获取验证码与提交验证是两个独立动作，提交时**不得再次发送**（否则每个码都作废）。 */
interface PendingOtp {
  email: string;
  verificationId: string;
  isExistingUser: boolean;
}

const RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 进入门禁：**未登录一律不得进入应用**（H5 / 发布版）。
 *
 * 为什么要有它：发布版是公开链接，此前任何人拿到链接就能进入，而 H5 的数据隔离用的是
 * localStorage 里自生成的 UUID —— 等于没有身份。现在进入前必须通过云服务邮箱认证。
 *
 * 平台差异（有意为之）：
 *   · H5 / 发布版：走云服务邮箱认证。未登录时**由 app.tsx 重定向到本页**（独立页面，
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
  const [tab, setTab] = useState<Tab>('password');
  const [email, setEmail] = useState('');
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
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const clearMsg = () => {
    setError('');
    setNotice('');
  };

  /** 切页签时清空验证码凭据：换了方式/邮箱就必须重新取码，不能拿旧 challenge 去提交 */
  const switchTab = (next: Tab) => {
    setTab(next);
    setPending(null);
    setResetTicket(null);
    setCode('');
    setPassword('');
    clearMsg();
  };

  const ensureEmail = (): boolean => {
    if (!EMAIL_RE.test(email.trim())) {
      setError(t('auth.errEmail'));
      return false;
    }
    return true;
  };

  const doSendCode = async () => {
    if (busy || countdown > 0) return;
    if (!ensureEmail()) return;
    clearMsg();
    setBusy(true);
    const res = await sendEmailCode(email.trim());
    setBusy(false);
    if (res.error) {
      setError(res.error.message || t('auth.errGeneric'));
      return;
    }
    setPending({
      email: email.trim(),
      verificationId: res.data.verificationId,
      isExistingUser: !!res.data.isExistingUser
    });
    setCountdown(RESEND_SECONDS);
    setNotice(t('auth.otpSent'));
  };

  /** 提交验证码。**这里绝不调用 sendEmailCode** —— 重发只在「获取验证码」按钮上发生。 */
  const submitOtp = async (withPassword: boolean) => {
    if (busy) return;
    if (!pending || pending.email !== email.trim()) {
      setError(t('auth.errCodeNeeded'));
      return;
    }
    if (withPassword && password.length < 8) {
      setError(t('auth.errPassword'));
      return;
    }
    clearMsg();
    setBusy(true);
    const res = await verifyEmailCode({
      email: pending.email,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code.trim(),
      // 邮箱新账号必须有密码；老账号登录不传 —— 由服务端返回的 isExistingUser 决定，不看当前页签
      password: pending.isExistingUser ? undefined : password
    });
    setBusy(false);
    if (res.error) {
      setError(res.error.message || t('auth.errGeneric'));
      return;
    }
    setPending(null);
    goToApp();
  };

  const submitPassword = async () => {
    if (busy) return;
    if (!ensureEmail()) return;
    if (password.length < 8) {
      setError(t('auth.errPassword'));
      return;
    }
    clearMsg();
    setBusy(true);
    const res = await signInWithPassword(email.trim(), password);
    setBusy(false);
    if (res.error) {
      // 不区分「邮箱不存在」与「密码错」—— 避免暴露账号是否存在
      setError(t('auth.errWrongCredentials'));
      return;
    }
    goToApp();
  };

  const startReset = async () => {
    if (busy) return;
    if (!ensureEmail()) return;
    clearMsg();
    setBusy(true);
    const res = await requestPasswordReset(email.trim());
    setBusy(false);
    if (res.error) {
      setError(res.error.message || t('auth.errGeneric'));
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
      setError(res.error.message || t('auth.errGeneric'));
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
      Taro.redirectTo({ url: '/pages/briefing/index' }).catch(() => {});
    });
  }

  const handleSubmit = () => {
    if (busy) return;
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

  return (
    <View className={styles.screen}>
      <View className={styles.card}>
        <Text className={styles.brand}>{t('app.title')}</Text>
        <Text className={styles.title}>{t('auth.title')}</Text>
        <Text className={styles.subtitle}>{t('auth.subtitle')}</Text>

        <View className={styles.tabs}>
          {(['password', 'otp', 'signup', 'forgot'] as Tab[]).map((k) => (
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

        <View className={styles.field}>
          <Text className={styles.label}>{t('auth.email')}</Text>
          <Input
            className={styles.input}
            type='text'
            value={email}
            placeholder={t('auth.emailPlaceholder')}
            onInput={(e) => setEmail(String(e.detail.value || ''))}
          />
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
                  placeholder={t('auth.codePlaceholder')}
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
            {/* 老账号用验证码登录不需要密码；新邮箱必须有密码（否则账号永远无法用密码登录） */}
            {tab === 'signup' || (pending && !pending.isExistingUser) ? (
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
                className={styles.input}
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
        {/* 用户报「收不到验证码」时，最常见的原因就是进了垃圾箱或地址写错 —— 直接给排查方向，
            而不是让用户在"已发送"和"没收到"之间干等 */}
        {notice && (tab === 'otp' || tab === 'signup') ? (
          <Text className={styles.hint}>{t('auth.otpSentHint')}</Text>
        ) : null}
        {error ? <Text className={styles.error}>{error}</Text> : null}

        <View className={`${styles.submit} ${busy ? styles.btnDisabled : ''}`} onClick={handleSubmit}>
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
    </View>
  );
}
