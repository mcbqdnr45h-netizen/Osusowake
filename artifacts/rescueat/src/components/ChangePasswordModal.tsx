import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Lock, Eye, EyeOff, Check, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

interface ChangePasswordModalProps {
  email: string;
  onClose: () => void;
}

const MIN_LEN = 8;

export function ChangePasswordModal({ email, onClose }: ChangePasswordModalProps) {
  const { resetPasswordForEmail } = useAuth();
  const { toast } = useToast();

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // パスワードを忘れた方はこちら
  const [forgotSending, setForgotSending] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  // 成功後の自動クローズタイマー (アンマウント時にクリア)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const tooShort = newPw.length > 0 && newPw.length < MIN_LEN;
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
  const sameAsCurrent = newPw.length >= MIN_LEN && newPw === currentPw;
  const canSubmit =
    !submitting &&
    currentPw.length > 0 &&
    newPw.length >= MIN_LEN &&
    confirmPw === newPw &&
    !sameAsCurrent;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // 1. 現在のパスワードで再認証
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email,
        password: currentPw,
      });
      if (signInErr) {
        setError('現在のパスワードが正しくありません');
        setSubmitting(false);
        return;
      }
      // 2. 新しいパスワードに更新
      const { error: updateErr } = await supabase.auth.updateUser({ password: newPw });
      if (updateErr) {
        setError(updateErr.message || 'パスワードの変更に失敗しました');
        setSubmitting(false);
        return;
      }
      setDone(true);
      toast({ title: 'パスワードを変更しました', duration: 3000 });
      closeTimerRef.current = setTimeout(onClose, 1200);
    } catch (e) {
      setError('通信エラーが発生しました。しばらくしてから再試行してください。');
      setSubmitting(false);
    }
  };

  const handleForgot = async () => {
    if (forgotSending || !email) return;
    setForgotSending(true);
    setForgotError(null);
    try {
      // ログイン画面の「パスワードを忘れた方」と同じ経路（サーバーからおすそわけ名義で送信）。
      //   Supabase 標準メールは届く相手や回数に制限があり、 iPhone アプリでは戻り先URLも capacitor:// になって使えない
      const { error: err } = await resetPasswordForEmail(email);
      if (err) {
        setForgotError(err);
      } else {
        setForgotSent(true);
      }
    } catch {
      setForgotError('通信エラーが発生しました。');
    } finally {
      setForgotSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm px-0 md:px-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="bg-card w-full md:max-w-md rounded-t-3xl md:rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
              <Lock className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-black text-foreground">パスワードを変更</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors"
            disabled={submitting}
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="px-6 py-10 flex flex-col items-center text-center gap-3">
            <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check className="w-7 h-7 text-emerald-600" />
            </div>
            <p className="font-bold text-foreground">パスワードを変更しました</p>
            <p className="text-xs text-muted-foreground">次回からは新しいパスワードでログインしてください。</p>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            <p className="text-xs text-muted-foreground">
              メールアドレス: <span className="font-bold text-foreground break-all">{email}</span>
            </p>

            {/* 現在のパスワード */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-foreground">現在のパスワード</label>
              <div className="relative">
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className="w-full h-11 px-3.5 pr-10 rounded-xl border border-border bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                  autoComplete="current-password"
                  placeholder="現在のパスワードを入力"
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={showCurrent ? 'パスワードを隠す' : 'パスワードを表示'}
                >
                  {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* 新しいパスワード */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-foreground">
                新しいパスワード <span className="text-muted-foreground font-normal">（8文字以上）</span>
              </label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="w-full h-11 px-3.5 pr-10 rounded-xl border border-border bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                  autoComplete="new-password"
                  placeholder="新しいパスワード"
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={showNew ? 'パスワードを隠す' : 'パスワードを表示'}
                >
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {tooShort && (
                <p className="text-[11px] text-destructive font-semibold">8文字以上で入力してください</p>
              )}
            </div>

            {/* 確認用 */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-foreground">新しいパスワード（確認）</label>
              <input
                type={showNew ? 'text' : 'password'}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl border border-border bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                autoComplete="new-password"
                placeholder="もう一度入力"
                disabled={submitting}
              />
              {mismatch && (
                <p className="text-[11px] text-destructive font-semibold">パスワードが一致しません</p>
              )}
              {sameAsCurrent && (
                <p className="text-[11px] text-amber-600 font-semibold">
                  新しいパスワードは現在のものと別にしてください
                </p>
              )}
            </div>

            {error && (
              <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-3 flex gap-2.5">
                <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive font-semibold">{error}</p>
              </div>
            )}

            {/* 送信ボタン */}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full h-12 rounded-2xl bg-primary text-primary-foreground font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-[0.99] transition"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  変更中...
                </>
              ) : (
                'パスワードを変更する'
              )}
            </button>

            {/* パスワードを忘れた方はこちら */}
            <div className="pt-2 border-t border-border">
              {forgotSent ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex gap-2.5">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-800 font-semibold leading-relaxed">
                    {email} にパスワード再設定のリンクを送りました。<br />
                    メールをご確認ください。
                  </p>
                </div>
              ) : (
                <div className="text-center space-y-1.5">
                  <button
                    type="button"
                    onClick={handleForgot}
                    disabled={forgotSending}
                    className="text-xs font-bold text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-60"
                  >
                    {forgotSending ? '送信中...' : '現在のパスワードを忘れた方はこちら'}
                  </button>
                  {forgotError && (
                    <p className="text-[11px] text-destructive font-semibold">{forgotError}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    登録メールアドレス宛に再設定リンクをお送りします
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
