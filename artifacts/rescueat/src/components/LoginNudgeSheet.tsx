import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, LogIn, UserPlus, ShoppingBag, Zap, Shield, Sparkles, Heart, Bell } from 'lucide-react';
import { useLocation } from 'wouter';

interface LoginNudgeSheetProps {
  isOpen: boolean;
  onClose: () => void;
  reason?: 'favorite' | 'purchase' | 'general';
}

const REASON_TEXT = {
  favorite: {
    title: 'お気に入りで\nもっとお得を逃さない',
    desc: '気になるお店を登録すると、新しいおすそわけが出た瞬間に見つけられます。',
    icon: Heart,
    iconBg: 'bg-rose-100 text-rose-500',
    benefits: [
      { icon: Bell, text: '入荷通知を受け取れる' },
      { icon: Sparkles, text: 'お気に入り店舗をすぐ表示' },
      { icon: Zap, text: '売り切れる前にゲット' },
    ],
  },
  purchase: {
    title: '30秒で登録して\n半額バッグをゲット',
    desc: 'おすそわけバッグは通常 30〜70% OFF。 食品ロスを減らしながらお得に。',
    icon: ShoppingBag,
    iconBg: 'bg-primary/10 text-primary',
    benefits: [
      { icon: Zap, text: '通常 30〜70% OFF で購入' },
      { icon: Shield, text: '完全無料・登録 30 秒' },
      { icon: Sparkles, text: 'CO₂ 削減に貢献できる' },
    ],
  },
  general: {
    title: 'おすそわけを\nもっと活用しよう',
    desc: 'アカウント登録で食品ロス削減に参加しながらお得に買い物できます。',
    icon: Sparkles,
    iconBg: 'bg-primary/10 text-primary',
    benefits: [
      { icon: Zap, text: '通常 30〜70% OFF で購入' },
      { icon: Bell, text: 'お気に入り店舗の入荷通知' },
      { icon: Shield, text: '完全無料・登録 30 秒' },
    ],
  },
};

export function LoginNudgeSheet({ isOpen, onClose, reason = 'general' }: LoginNudgeSheetProps) {
  const [, navigate] = useLocation();
  const text = REASON_TEXT[reason];

  const handleLogin = () => {
    onClose();
    navigate('/login');
  };

  const handleSignup = () => {
    onClose();
    navigate('/signup');
  };

  // ★ Portal で body 直下に出す。BagCard は Home の motion.div(transform 持ち)配下にあり、
  //   transform 祖先があると position:fixed がビューポートではなく祖先基準になって
  //   シートがページ内に流し込まれレイアウトが崩れる(完売カルーセルで発覚)。
  //   body へ逃がすことで必ず全画面オーバーレイになる(既存のソートメニューと同じ手法)。
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          {/* オーバーレイ */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          {/* シート */}
          <motion.div
            className="relative w-full max-w-lg bg-card rounded-t-3xl px-6 pt-5 pb-8 z-10"
            style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={e => e.stopPropagation()}
          >
            {/* ドラッグハンドル */}
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />

            {/* 閉じるボタン */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-muted flex items-center justify-center"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>

            {/* アイコン */}
            <div className={`w-14 h-14 ${text.iconBg} rounded-2xl flex items-center justify-center mx-auto mb-4`}>
              <text.icon className="w-7 h-7" />
            </div>

            {/* テキスト */}
            <h2 className="text-xl font-black text-foreground text-center mb-2 leading-tight whitespace-pre-line">
              {text.title}
            </h2>
            <p className="text-[13px] text-muted-foreground text-center leading-relaxed mb-4">
              {text.desc}
            </p>

            {/* ベネフィットリスト */}
            <ul className="bg-secondary/40 rounded-2xl px-4 py-3 mb-5 space-y-2">
              {text.benefits.map((b, i) => (
                <li key={i} className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
                    <b.icon className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="text-[12px] font-bold text-foreground leading-tight">{b.text}</span>
                </li>
              ))}
            </ul>

            {/* ボタン (新規登録を主役に) */}
            <div className="space-y-2.5">
              <button
                onClick={handleSignup}
                className="w-full bg-primary text-white font-black py-3.5 rounded-2xl text-sm flex items-center justify-center gap-2 shadow-md shadow-primary/20 active:scale-[0.98] transition-transform"
              >
                <UserPlus className="w-4 h-4" />
                30 秒で無料登録
              </button>
              <button
                onClick={handleLogin}
                className="w-full border-2 border-border text-foreground font-bold py-3 rounded-2xl text-sm flex items-center justify-center gap-2 hover:bg-secondary/40 active:scale-[0.98] transition-all"
              >
                <LogIn className="w-4 h-4" />
                既にアカウントをお持ちの方
              </button>
              <button
                onClick={onClose}
                className="w-full text-xs text-muted-foreground py-1.5"
              >
                あとで
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
