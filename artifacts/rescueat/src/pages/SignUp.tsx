import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'wouter';
import logoUrl from '@/lib/logo';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye, EyeOff, Mail, Lock, CheckCircle2, X, User, Phone, Store, ShieldCheck,
} from 'lucide-react';
import { useAuth, EMAIL_ALREADY_REGISTERED } from '@/contexts/AuthContext';
import { AuthShell, AuthPrimaryButton } from '@/components/AuthShell';
import { LegalSheet, type LegalDoc } from '@/components/LegalSheet';

export default function SignUp() {
  const [, navigate] = useLocation();
  const { signUp, signUpAsStore } = useAuth();

  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get('tab') === 'store' ? 'store' : 'user';

  const [activeTab,       setActiveTab]       = useState<'user' | 'store'>(initialTab);
  const [name,            setName]            = useState('');
  const [phone,           setPhone]           = useState('');
  const [email,           setEmail]           = useState('');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirmPw,   setShowConfirmPw]   = useState(false);
  const [agreed,          setAgreed]          = useState(false);
  const [isLoading,       setIsLoading]       = useState(false);
  const [loadingStep,     setLoadingStep]     = useState('');
  const [error,           setError]           = useState('');
  const [emailExists,     setEmailExists]     = useState(false);
  const [shakeKey,        setShakeKey]        = useState(0);
  const [done,            setDone]            = useState(false);
  const [needsConfirm,    setNeedsConfirm]    = useState(false);
  const [legalDoc,        setLegalDoc]        = useState<LegalDoc | null>(null);

  // ★ Android System WebView の日本語 IME 対策。変換確定前 (composition 中) は
  //   制御 input への state 反映でかな入力が中断されることがあるため、確定後にも
  //   確実に値を取り込む。
  const composingRef = useRef(false);

  useEffect(() => {
    setName(''); setPhone(''); setEmail('');
    setPassword(''); setConfirmPassword('');
    setAgreed(false); setError(''); setEmailExists(false);
  }, [activeTab]);

  const passwordsMatch  = confirmPassword === '' || password === confirmPassword;
  const normalizedPhone = phone.replace(/[-\s]/g, '');
  const phoneValid      = /^0[0-9]{9,10}$/.test(normalizedPhone);

  // ★ ニックネームは登録時不要 (オプトイン制ランキング参加時にのみ要求)。

  const isValid =
    name.trim().length >= 1 &&
    phoneValid &&
    email.trim() &&
    password.length >= 6 &&
    password === confirmPassword &&
    agreed &&
    !isLoading;

  function handlePhoneChange(val: string) {
    setPhone(val.replace(/[^\d\-\s]/g, ''));
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    setError('');
    setEmailExists(false);
    setIsLoading(true);
    setLoadingStep('処理中…');

    try {
      if (activeTab === 'store') {
        const { error: err, needsConfirmation: confirm } = await signUpAsStore(email, password, name.trim(), normalizedPhone, setLoadingStep);
        // ★ 既存メール (customer 等で登録済み) → 白画面にせず、 ログインして店舗登録する導線を出す
        if (err === EMAIL_ALREADY_REGISTERED) {
          setEmailExists(true);
          setError('このメールアドレスは既に登録されています。ログインしてから店舗を登録してください（アカウントの退会は不要です）。');
          setShakeKey(k => k + 1);
          return;
        }
        if (err) { setError(err); setShakeKey(k => k + 1); return; }
        setNeedsConfirm(confirm);
        setDone(true);
        // ★ GuestRoute が認証完了時に /mypage へ飛ばすため、 setTimeout を待たず
        //   即座に replace で /store-onboarding に遷移して MyPage 経由を防ぐ。
        if (!confirm) navigate('/store-onboarding', { replace: true });
      } else {
        const { error: err, needsConfirmation: confirm } = await signUp(email, password, name, phone, '', setLoadingStep);
        if (err === EMAIL_ALREADY_REGISTERED) {
          setEmailExists(true);
          setError('このメールアドレスは既に登録されています。ログインしてください。');
          setShakeKey(k => k + 1);
          return;
        }
        if (err) { setError(err); setShakeKey(k => k + 1); return; }
        setNeedsConfirm(confirm);
        setDone(true);
        if (!confirm) setTimeout(() => navigate('/'), 1200);
      }
    } catch (e: any) {
      setError(e?.message ?? '登録中にエラーが発生しました');
      setShakeKey(k => k + 1);
    } finally {
      setIsLoading(false);
      setLoadingStep('');
    }
  }

  if (done) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-background px-6">
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="flex flex-col items-center text-center max-w-sm md:max-w-2xl"
        >
          <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center mb-5">
            <span className="text-5xl">
              {needsConfirm ? '📧' : (activeTab === 'store' ? '🏪' : '🎉')}
            </span>
          </div>
          <h2 className="text-2xl font-black text-foreground mb-3">
            {needsConfirm ? '確認メールを送信しました' : (activeTab === 'store' ? 'アカウント登録完了！' : 'ようこそ！')}
          </h2>
          {needsConfirm ? (
            <>
              <p className="text-muted-foreground text-sm leading-relaxed mb-6">
                <span className="font-bold text-foreground">{email}</span> に確認メールを送りました。
                メール内のリンクをクリックして、登録を完了してください。
              </p>
              <Link
                href={activeTab === 'store' ? '/login?tab=store' : '/login'}
                className="w-full flex items-center justify-center gap-2 text-white font-black py-4 rounded-2xl"
                style={{
                  background: 'linear-gradient(180deg, #F07826 0%, #E85A0C 100%)',
                  boxShadow: '0 4px 20px rgba(242,100,25,0.30)',
                }}
              >
                ログイン画面へ
              </Link>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                {activeTab === 'store'
                  ? <>登録が完了しました。<br />続けて店舗情報を入力してください。</>
                  : 'マイページに移動します...'}
              </p>
              <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </>
          )}
        </motion.div>
      </div>
    );
  }

  const labelClass = "block text-xs font-black text-foreground/65 uppercase tracking-widest mb-2";
  const inputBase  = "w-full bg-white border border-border/80 rounded-xl pl-11 pr-4 py-3.5 text-foreground font-medium placeholder:text-muted-foreground/45 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all text-[15px]";

  const isStore = activeTab === 'store';

  return (
    <AuthShell activeTab={activeTab} onTabChange={setActiveTab} mode="signup">
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
          <div className="mb-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22 }}
              className="relative inline-block mb-4"
            >
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
                className="relative w-16 h-16 rounded-2xl flex items-center justify-center ring-1 ring-black/5 shadow-lg"
                style={{
                  background: isStore
                    ? 'linear-gradient(135deg, #FFF3E0 0%, #FFE0B2 100%)'
                    : '#FFFFFF',
                  boxShadow: '0 6px 20px rgba(242,100,25,0.18)',
                }}
              >
                {isStore
                  ? <Store className="w-7 h-7 text-primary" strokeWidth={2.4} />
                  : <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-full h-full rounded-2xl object-cover" />
                }
              </div>
            </motion.div>
            <p className="text-[10px] font-black tracking-[0.25em] text-primary/80 mb-1.5">おすそわけ</p>
            <h1 className="text-[28px] font-black text-foreground leading-tight" style={{ letterSpacing: '-0.03em' }}>
              {isStore ? (
                <>店舗オーナー登録</>
              ) : (
                <>はじめまして<span className="text-primary">。</span></>
              )}
            </h1>
            <p className="text-[13.5px] text-muted-foreground mt-2 font-medium leading-snug">
              {isStore
                ? '余剰食品をおすそわけして、新しい常連客を増やしましょう'
                : '全国の美味しいおすそわけを、もっと身近に。'
              }
            </p>
          </div>

          {/* 店舗特典バナー */}
          {isStore && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl p-4 mb-5 border border-primary/15"
              style={{ background: 'linear-gradient(135deg, rgba(242,100,25,0.06) 0%, rgba(246,174,45,0.04) 100%)' }}
            >
              <p className="text-[11px] font-black text-primary mb-2.5 tracking-widest uppercase">店舗オーナー特典</p>
              <ul className="space-y-1.5">
                {[
                  '余剰食品を手軽に出品・管理',
                  '売上は毎月25日に自動振込',
                  'プラットフォーム手数料は20%のみ',
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-foreground font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </motion.div>
          )}

          {/* ── フォーム ── */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 flex-1 md:flex-none">

            {/* 氏名 */}
            <div>
              <label className={labelClass}>氏名 <span className="text-destructive normal-case">*</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <User className="w-4 h-4 text-muted-foreground/60" />
                </div>
                <input type="text" value={name}
                  onChange={e => { setName(e.target.value); setError(''); }}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={e => { composingRef.current = false; setName((e.target as HTMLInputElement).value); }}
                  placeholder="山田 太郎" className={inputBase}
                  autoComplete="name" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  enterKeyHint="next" disabled={isLoading} required />
              </div>
              {!isStore && (
                <p className="text-[11px] text-muted-foreground/70 mt-1.5 leading-snug">
                  本名は他のユーザーには公開されません (注文時の宛名・本人確認用)
                </p>
              )}
            </div>

            {/* 電話番号 */}
            <div>
              <label className={labelClass}>電話番号 <span className="text-destructive normal-case">*</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Phone className="w-4 h-4 text-muted-foreground/60" />
                </div>
                <input type="tel" value={phone} onChange={e => handlePhoneChange(e.target.value)}
                  placeholder="090-0000-0000"
                  className={`w-full bg-white border rounded-xl pl-11 pr-4 py-3.5 text-foreground font-medium placeholder:text-muted-foreground/45 focus:ring-4 outline-none transition-all text-[15px] ${
                    phone.length > 0 && !phoneValid ? 'border-destructive focus:border-destructive focus:ring-destructive/10'
                    : phone.length > 0 && phoneValid ? 'border-green-500 focus:border-green-500 focus:ring-green-500/10'
                    : 'border-border/80 focus:border-primary focus:ring-primary/10'
                  }`}
                  autoComplete="tel" disabled={isLoading} required />
              </div>
              {/* ★ #4: 電話番号の利用目的を明示 (店舗からの受取連絡用、 マーケティング目的では使用しない) */}
              <p className="text-muted-foreground text-[11px] mt-1.5 leading-snug">
                受取時に店舗から連絡が必要な場合のみ使用します。 広告・マーケティング目的では一切使用しません。
              </p>
              {phone.length > 0 && !phoneValid && <p className="text-destructive text-[12px] font-semibold mt-1.5">正しい電話番号を入力してください（例：090-0000-0000）</p>}
              {phone.length > 0 && phoneValid  && <p className="text-green-600 text-[12px] font-semibold mt-1.5">電話番号を確認しました ✓</p>}
            </div>

            {/* メール */}
            <div>
              <label className={labelClass}>メールアドレス <span className="text-destructive normal-case">*</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Mail className="w-4 h-4 text-muted-foreground/60" />
                </div>
                <input type="email" value={email} onChange={e => { setEmail(e.target.value); setError(''); }}
                  placeholder={isStore ? 'store@example.com' : 'example@email.com'}
                  className={inputBase} autoComplete="email" disabled={isLoading} required />
              </div>
            </div>

            {/* パスワード */}
            <div>
              <label className={labelClass}>パスワード <span className="text-destructive normal-case">*</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 text-muted-foreground/60" />
                </div>
                <input type={showPassword ? 'text' : 'password'} value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="6文字以上"
                  className={`${inputBase} pr-12`}
                  autoComplete="new-password" disabled={isLoading} required />
                <motion.button type="button" whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-4 flex items-center text-muted-foreground/50 hover:text-foreground transition-colors">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </motion.button>
              </div>
              {password.length > 0 && password.length < 6 && <p className="text-destructive text-[12px] font-semibold mt-1.5">6文字以上で入力してください</p>}
            </div>

            {/* パスワード（確認） */}
            <div>
              <label className={labelClass}>パスワード（確認） <span className="text-destructive normal-case">*</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 text-muted-foreground/60" />
                </div>
                <input type={showConfirmPw ? 'text' : 'password'} value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
                  placeholder="もう一度入力"
                  className={`w-full bg-white border rounded-xl pl-11 pr-12 py-3.5 text-foreground font-medium placeholder:text-muted-foreground/45 focus:ring-4 outline-none transition-all text-[15px] ${
                    !passwordsMatch ? 'border-destructive focus:border-destructive focus:ring-destructive/10'
                    : confirmPassword.length > 0 && password === confirmPassword ? 'border-green-500 focus:border-green-500 focus:ring-green-500/10'
                    : 'border-border/80 focus:border-primary focus:ring-primary/10'
                  }`}
                  autoComplete="new-password" disabled={isLoading} required />
                <motion.button type="button" whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                  onClick={() => setShowConfirmPw(v => !v)}
                  className="absolute inset-y-0 right-4 flex items-center text-muted-foreground/50 hover:text-foreground transition-colors">
                  {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </motion.button>
              </div>
              {!passwordsMatch && <p className="text-destructive text-[12px] font-semibold mt-1.5">パスワードが一致しません</p>}
              {confirmPassword.length > 0 && password === confirmPassword && <p className="text-green-600 text-[12px] font-semibold mt-1.5">パスワードが一致しています ✓</p>}
            </div>

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
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            {/* ★ 既存メール時: ログイン → 店舗登録 の正規ルートへ (退会不要) */}
            {emailExists && (
              <button
                type="button"
                onClick={() =>
                  navigate(
                    isStore
                      ? `/login?tab=store&redirect=${encodeURIComponent('/store-onboarding')}`
                      : '/login'
                  )
                }
                className="w-full flex items-center justify-center gap-2 text-white font-black py-3.5 rounded-xl active:scale-[0.98] transition-transform"
                style={{
                  background: 'linear-gradient(180deg, #F07826 0%, #E85A0C 100%)',
                  boxShadow: '0 4px 20px rgba(242,100,25,0.30)',
                }}
              >
                {isStore ? 'ログインして店舗を登録する' : 'ログイン画面へ'}
              </button>
            )}

            <div className="flex-1 min-h-2" />

            {/* 利用規約 */}
            <motion.div
              whileTap={{ scale: 0.99 }}
              onClick={() => setAgreed(v => !v)}
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all select-none
                ${agreed ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-white hover:border-primary/30'}`}
            >
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all
                ${agreed ? 'bg-primary border-primary' : 'border-border bg-background'}`}>
                {agreed && (
                  <motion.svg initial={{ scale: 0 }} animate={{ scale: 1 }} viewBox="0 0 12 10" className="w-3 h-3">
                    <polyline points="1,5.5 4.5,9 11,1" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </motion.svg>
                )}
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setLegalDoc('terms'); }}
                  className="font-bold text-primary underline underline-offset-2 whitespace-nowrap"
                >利用規約</button>
                <span className="whitespace-nowrap">{' '}および{' '}</span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setLegalDoc('privacy'); }}
                  className="font-bold text-primary underline underline-offset-2 whitespace-nowrap"
                >プライバシーポリシー</button>
                <span className="whitespace-nowrap">に同意します</span>
              </p>
            </motion.div>

            {isStore && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                <span>登録情報は決済システムとの連携に使用されます。第三者への提供はありません。</span>
              </div>
            )}

            <AuthPrimaryButton disabled={!isValid} isLoading={isLoading} loadingText={loadingStep}>
              {isStore ? <><Store className="w-4.5 h-4.5" />店舗として登録する</> : '登録する'}
            </AuthPrimaryButton>

            <p className="text-center text-[13px] text-muted-foreground pb-3">
              すでにアカウントをお持ちですか？{' '}
              <Link
                href={isStore ? '/login?tab=store' : '/login'}
                className="text-primary font-black underline underline-offset-2"
              >
                ログイン
              </Link>
            </p>
          </form>
        </motion.div>
      </AnimatePresence>

      {/* ★ 利用規約 / プライバシーポリシーはモーダルで表示。画面遷移しないので
          入力中のフォーム内容が消えない (iOS / Android 完全同一挙動)。 */}
      <LegalSheet doc={legalDoc} onClose={() => setLegalDoc(null)} />
    </AuthShell>
  );
}
