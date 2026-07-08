import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import logoUrl from '@/lib/logo';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Mail, Lock, Store, CheckCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell, AuthPrimaryButton } from '@/components/AuthShell';

const SHOW_SSO = false;

export default function Login() {
  const [, navigate] = useLocation();
  const { signIn, resetPasswordForEmail, signInWithProvider } = useAuth();
  const [ssoLoading, setSsoLoading] = useState<'google' | 'apple' | null>(null);

  async function handleSso(provider: 'google' | 'apple') {
    if (ssoLoading) return;
    setError('');
    setSsoLoading(provider);
    const { error: err } = await signInWithProvider(provider);
    if (err) {
      setError(err);
      setShakeKey(k => k + 1);
      setSsoLoading(null);
    }
  }

  function getInitialTab(): 'user' | 'store' {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') === 'store' ? 'store' : 'user';
  }

  const [activeTab,  setActiveTab]  = useState<'user' | 'store'>(getInitialTab);
  const [email,      setEmail]      = useState('');
  const [password,   setPassword]   = useState('');
  const [showPw,     setShowPw]     = useState(false);
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState('');
  const [shakeKey,   setShakeKey]   = useState(0);

  // ── パスワードリセット ──
  const [showForgotPw,  setShowForgotPw]  = useState(false);
  const [forgotEmail,   setForgotEmail]   = useState('');
  const [forgotSending, setForgotSending] = useState(false);
  const [forgotSent,    setForgotSent]    = useState(false);
  const [forgotError,   setForgotError]   = useState('');

  async function handleForgotPw() {
    if (!forgotEmail.trim() || forgotSending) return;
    setForgotSending(true);
    setForgotError('');
    const { error: err } = await resetPasswordForEmail(forgotEmail);
    setForgotSending(false);
    if (err) { setForgotError(err); return; }
    setForgotSent(true);
  }

  // タブ変更時: URLを更新（リマウント時の状態リセット防止）、フォームをクリア
  function handleTabChange(tab: 'user' | 'store') {
    setActiveTab(tab);
    const base = window.location.pathname;
    window.history.replaceState(null, '', tab === 'store' ? `${base}?tab=store` : base);
    setEmail('');
    setPassword('');
    setError('');
  }

  const isValid = email.trim() && password.length >= 1 && !isLoading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    setError('');
    setIsLoading(true);

    if (activeTab === 'store') {
      // 店舗タブでログイン → ユーザーモードフラグを解除
      sessionStorage.removeItem('adminUserMode');
      const { error: err } = await signIn(email, password, 'store_owner');
      setIsLoading(false);
      if (err) {
        setError(err);
        setShakeKey(k => k + 1);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      if (redirect) {
        const decoded = decodeURIComponent(redirect);
        if (decoded.startsWith('/store/') || decoded.startsWith('/register-store') || decoded.startsWith('/store-onboarding') || decoded === '/mypage') {
          navigate(decoded, { replace: true });
          return;
        }
      }
      // ★ 店舗ログイン直後の遷移先: /store/dashboard に直接飛ばす。
      //   以前は /mypage 経由にしていたが、role 判定が完了するまでの一瞬
      //   ユーザー向け MyPage がレンダリングされて「ユーザー画面がチラつく」
      //   問題があったため、店舗ガード付きの dashboard に直行することで防止する。
      //   オンボーディング (銀行登録 / 特商法) はベル通知やマイページタブから到達可能。
      // ★ replace: true で履歴に /login を残さない (戻るボタンでログイン画面に戻る挙動防止)
      navigate('/store/dashboard', { replace: true });
    } else {
      const { error: err, role, isAdmin: adminFlag, requiresMfa } = await signIn(email, password);
      setIsLoading(false);
      if (err) {
        setError(err);
        setShakeKey(k => k + 1);
        return;
      }
      if (role === 'store_owner' && !adminFlag) {
        setError('このアカウントは店舗オーナー用です。「飲食店・パートナー」タブからログインしてください。');
        setShakeKey(k => k + 1);
        return;
      }
      // 管理者: MFA モーダルが出るのでここでは navigate しない
      if (requiresMfa) return;
      // redirect クエリがあればそこへ、なければマイページへ
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      if (redirect) {
        const decoded = decodeURIComponent(redirect);
        if (decoded.startsWith('/') && !decoded.startsWith('//')) {
          navigate(decoded, { replace: true });
          return;
        }
      }
      // ★ replace: true で履歴に /login を残さない
      navigate('/mypage', { replace: true });
    }
  }

  // ★ 二重防御: サーバー高負荷時に error が "{}" 等の無意味な文字列になっても
  //   ユーザーに生表示しない（AuthContext.translateError で基本は変換済み）。
  function displayError(raw: string): string {
    const m = (raw ?? '').toString().trim();
    if (m === '' || m === '{}' || m === '[object Object]' || /^[[{].*[\]}]$/.test(m)) {
      return '接続が不安定なため、ログインに失敗しました。もう一度お試しください';
    }
    return m;
  }

  const labelClass = "block text-xs md:text-sm font-black text-foreground/65 uppercase tracking-widest mb-2";
  const inputClass = "w-full bg-white border border-border/80 rounded-xl md:rounded-2xl pl-11 md:pl-14 pr-4 py-3.5 md:py-5 text-foreground font-medium placeholder:text-muted-foreground/45 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all text-[15px] md:text-[17px]";

  const isStore = activeTab === 'store';

  return (
    <AuthShell activeTab={activeTab} onTabChange={handleTabChange} mode="login">

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, x: isStore ? 18 : -18 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: isStore ? -18 : 18 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col flex-1 md:flex-none"
        >
          {/* ── ヒーロー（プレミアム） ── */}
          <div className="mb-7">
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22 }}
              className="relative inline-block mb-4"
            >
              {/* 光彩 */}
              <div
                aria-hidden
                className="absolute inset-0 rounded-2xl blur-xl"
                style={{
                  background: isStore
                    ? 'linear-gradient(135deg, rgba(242,100,25,0.35), rgba(246,174,45,0.25))'
                    : 'linear-gradient(135deg, rgba(242,100,25,0.30), rgba(255,180,100,0.25))',
                }}
              />
              <div
                className="relative w-16 h-16 md:w-24 md:h-24 rounded-2xl md:rounded-3xl flex items-center justify-center ring-1 ring-black/5 shadow-lg"
                style={{
                  background: isStore
                    ? 'linear-gradient(135deg, #FFF3E0 0%, #FFE0B2 100%)'
                    : '#FFFFFF',
                  boxShadow: '0 6px 20px rgba(242,100,25,0.18)',
                }}
              >
                {isStore
                  ? <Store className="w-7 h-7 md:w-12 md:h-12 text-primary" strokeWidth={2.4} />
                  : <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-full h-full rounded-2xl md:rounded-3xl object-cover" />
                }
              </div>
            </motion.div>
            <p className="text-[10px] md:text-[13px] font-black tracking-[0.25em] text-primary/80 mb-1.5">おすそわけ</p>
            <h1 className="text-[28px] md:text-[40px] font-black text-foreground leading-tight" style={{ letterSpacing: '-0.03em' }}>
              {isStore ? (
                <>店舗管理画面へ</>
              ) : (
                <>おかえりなさい</>
              )}
            </h1>
            <p className="text-[13.5px] md:text-[17px] text-muted-foreground mt-2 md:mt-4 font-medium leading-snug">
              {isStore
                ? '余剰食品をおすそわけして、新しい常連客を増やしましょう'
                : '全国の美味しいおすそわけを見つけよう'
              }
            </p>
          </div>

          {/* ── フォーム ── */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-5 flex-1 md:flex-none">

            {/* メール */}
            <div>
              <label className={labelClass}>メールアドレス</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 md:left-5 flex items-center pointer-events-none">
                  <Mail className="w-4 h-4 md:w-5 md:h-5 text-muted-foreground/60" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  placeholder={isStore ? 'store@example.com' : 'example@email.com'}
                  className={inputClass}
                  autoComplete="email"
                  disabled={isLoading}
                />
              </div>
            </div>

            {/* パスワード */}
            <div>
              <label className={labelClass}>パスワード</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 md:left-5 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 md:w-5 md:h-5 text-muted-foreground/60" />
                </div>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="パスワードを入力"
                  className={`${inputClass} pr-12`}
                  autoComplete="current-password"
                  disabled={isLoading}
                />
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                  onClick={() => setShowPw(v => !v)}
                  className="absolute inset-y-0 right-4 flex items-center text-muted-foreground/50 hover:text-foreground transition-colors"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </motion.button>
              </div>
            </div>

            {/* パスワードを忘れた方はこちら（一般ユーザー・店舗側 両方に表示） */}
            <div className="flex justify-end -mt-2">
              <button
                type="button"
                onClick={() => { setShowForgotPw(true); setForgotEmail(email); setForgotSent(false); setForgotError(''); }}
                className="text-[12px] text-primary font-bold hover:underline underline-offset-2"
              >
                パスワードを忘れた方はこちら
              </button>
            </div>

            {/* パスワードリセットパネル（常にDOMに存在、高さだけアニメーション）*/}
            {(
              <motion.div
                initial={false}
                animate={{
                  height:   showForgotPw ? 'auto' : 0,
                  opacity:  showForgotPw ? 1 : 0,
                  marginTop: showForgotPw ? undefined : 0,
                }}
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
                style={{ pointerEvents: showForgotPw ? 'auto' : 'none' }}
              >
                  <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3">
                    {forgotSent ? (
                      <div className="flex flex-col items-center gap-2 py-1">
                        <CheckCircle className="w-8 h-8 text-green-500" />
                        <p className="text-sm font-black text-foreground text-center">メールを送信しました！</p>
                        <p className="text-[12px] text-muted-foreground text-center leading-relaxed">
                          {forgotEmail} にパスワード再設定のリンクを送りました。<br/>メールをご確認ください。
                        </p>
                        <p className="text-[11px] text-muted-foreground text-center leading-relaxed bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2">
                          ※メールが届かない場合は、迷惑メールフォルダやゴミ箱を確認してください。
                        </p>
                        <button
                          type="button"
                          onClick={() => { setShowForgotPw(false); setForgotSent(false); }}
                          className="text-[12px] text-primary font-bold underline underline-offset-2 mt-1"
                        >
                          ログインに戻る
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-[12px] font-bold text-foreground">パスワード再設定メールを送信します</p>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none">
                            <Mail className="w-4 h-4 text-muted-foreground/60" />
                          </div>
                          <input
                            type="email"
                            value={forgotEmail}
                            onChange={e => setForgotEmail(e.target.value)}
                            placeholder="登録メールアドレスを入力"
                            className="w-full bg-white border border-border/80 rounded-xl pl-10 pr-4 py-3 text-sm font-medium placeholder:text-muted-foreground/45 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
                          />
                        </div>
                        {forgotError && (
                          <p className="text-[12px] text-destructive font-semibold">{forgotError}</p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setShowForgotPw(false)}
                            className="flex-1 py-2.5 rounded-xl border border-border text-sm font-bold text-muted-foreground hover:bg-muted transition-colors"
                          >
                            キャンセル
                          </button>
                          <button
                            type="button"
                            disabled={!forgotEmail.trim() || forgotSending}
                            onClick={handleForgotPw}
                            className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-black disabled:opacity-50 hover:bg-primary/90 transition-colors"
                          >
                            {forgotSending ? '送信中...' : '送信する'}
                          </button>
                        </div>
                        {/* LINE サポートリンク */}
                        <p className="text-center text-[11px] text-muted-foreground">
                          メールが届かない場合は{' '}
                          <a
                            href="https://lin.ee/V1amrv8"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold text-[#06C755] underline underline-offset-2"
                          >
                            LINEでお問い合わせ
                          </a>
                        </p>
                      </>
                    )}
                  </div>
                </motion.div>
            )}

            {/* エラー（シェイク付き） */}
            <AnimatePresence>
              {error && (
                <motion.div
                  key={shakeKey}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="shake bg-destructive/8 border border-destructive/20 text-destructive text-[13px] font-semibold px-4 py-3 rounded-xl leading-snug"
                >
                  {displayError(error)}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex-1 min-h-4" />

            <AuthPrimaryButton disabled={!isValid} isLoading={isLoading}>
              {isStore ? (
                <><Store className="w-4.5 h-4.5" />ダッシュボードへ</>
              ) : 'ログインする'}
            </AuthPrimaryButton>

            {SHOW_SSO && (
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border/60" />
                <span className="text-[11px] text-muted-foreground/60 font-semibold tracking-wider">または</span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
            )}

            {SHOW_SSO && !isStore && (
              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  disabled={!!ssoLoading || isLoading}
                  onClick={() => handleSso('apple')}
                  className="w-full flex items-center justify-center gap-2 bg-black text-white font-bold py-3.5 rounded-2xl hover:bg-black/90 active:bg-black/80 disabled:opacity-50 transition-colors text-[14px]"
                  aria-label="Apple で続ける"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M17.05 20.28c-.98.95-2.05.86-3.08.42-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.42C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                  </svg>
                  {ssoLoading === 'apple' ? '接続中…' : 'Apple で続ける'}
                </button>
                <button
                  type="button"
                  disabled={!!ssoLoading || isLoading}
                  onClick={() => handleSso('google')}
                  className="w-full flex items-center justify-center gap-2 bg-white border-2 border-border text-foreground font-bold py-3.5 rounded-2xl hover:bg-secondary/40 active:bg-secondary/60 disabled:opacity-50 transition-colors text-[14px]"
                  aria-label="Google で続ける"
                >
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
                    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
                    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
                    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
                  </svg>
                  {ssoLoading === 'google' ? '接続中…' : 'Google で続ける'}
                </button>
              </div>
            )}

            <p className="text-center text-[13px] text-muted-foreground pb-2">
              アカウントをお持ちでない方は{' '}
              <Link
                href={isStore ? '/store/signup' : '/signup'}
                className="text-primary font-black underline underline-offset-2"
              >
                新規登録
              </Link>
            </p>
          </form>
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}
