import React, { useEffect } from 'react';
import { useLocation } from 'wouter';
import logoUrl from '@/lib/logo';
import { motion } from 'framer-motion';
import { ArrowRight, MapPin, Gift, Sparkles, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { logNav } from '@/lib/nav-debug';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: (d: number) => ({
    opacity: 1, y: 0,
    transition: { delay: d * 0.10, duration: 0.55, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
  }),
};

export default function Welcome() {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (isLoading || !user) return;
    // ── auth フラップ等で /welcome?redirect=/mypage に弾かれた直後でも、
    //    元のページに戻れるよう redirect クエリを優先する。
    let dest = '/';
    try {
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      if (redirect) {
        const decoded = decodeURIComponent(redirect);
        // 安全策: アプリ内パスのみ受け入れ、外部URLは拒否
        if (decoded.startsWith('/') && !decoded.startsWith('//')) {
          dest = decoded;
        }
      }
    } catch {
      // パース失敗時は / にフォールバック
    }
    logNav('Welcome(logged-in user)', dest);
    navigate(dest, { replace: true });
  }, [isLoading, user, navigate]);

  if (isLoading || user) return null;

  const params = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  );
  const redirect = params.get('redirect');
  const loginHref  = redirect ? `/login?redirect=${encodeURIComponent(redirect)}`  : '/login';
  const signupHref = redirect ? `/signup?redirect=${encodeURIComponent(redirect)}` : '/signup';

  const features = [
    { icon: MapPin,   text: 'エリア・ジャンルで絞り込み' },
    { icon: Gift,     text: 'おすそわけバッグをお得に購入' },
    { icon: Sparkles, text: '買うたびにマイタウンが育つ' },
  ];

  return (
    <div
      className="min-h-dvh flex flex-col relative overflow-hidden"
      style={{
        background: 'linear-gradient(165deg, #F08877 0%, #E8786C 45%, #D9604F 100%)',
      }}
    >
      {/* ── 装飾レイヤー（ぼかし球＋ノイズ感）── */}
      <div className="absolute inset-0 pointer-events-none">
        {/* 右上のアンバー光 */}
        <motion.div
          aria-hidden
          className="absolute top-[-15%] right-[-25%] w-[80vw] h-[80vw] max-w-md md:max-w-2xl max-h-md rounded-full"
          style={{ background: 'radial-gradient(circle at 50% 50%, rgba(255,210,150,0.42) 0%, rgba(255,210,150,0) 70%)' }}
          animate={{ scale: [1, 1.05, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* 左下のディープ光 */}
        <motion.div
          aria-hidden
          className="absolute bottom-[-20%] left-[-30%] w-[70vw] h-[70vw] max-w-sm md:max-w-2xl max-h-sm rounded-full"
          style={{ background: 'radial-gradient(circle at 50% 50%, rgba(80,20,5,0.30) 0%, rgba(80,20,5,0) 70%)' }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
        />
        {/* 浮遊する小さな光のドット */}
        <div className="absolute top-1/3 left-[15%] w-1.5 h-1.5 rounded-full bg-white/40" />
        <div className="absolute top-1/4 right-[20%] w-1 h-1 rounded-full bg-white/30" />
        <div className="absolute bottom-1/3 right-[12%] w-2 h-2 rounded-full bg-amber-200/50" />
      </div>

      {/* ── ヘッダー ── */}
      <header className="relative z-10 px-5 sm:px-7 pt-12 sm:pt-14 flex items-center justify-between">
        <motion.div custom={0} variants={rise} initial="hidden" animate="show"
          className="flex items-center gap-2.5">
          <div className="relative">
            <div aria-hidden className="absolute inset-0 rounded-[12px] bg-amber-200/30 blur-md" />
            <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="relative w-9 h-9 rounded-[11px] object-cover ring-1 ring-white/30" />
          </div>
          <span className="font-black text-[20px] tracking-[-0.03em] leading-none">
            <span className="text-white">おすそわけ</span>
          </span>
        </motion.div>

        <motion.div
          custom={0} variants={rise} initial="hidden" animate="show"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/15 backdrop-blur-sm border border-white/20"
        >
          <ShieldCheck className="w-3 h-3 text-amber-200" />
          <span className="text-[10px] font-bold text-white/90">完全無料</span>
        </motion.div>
      </header>

      {/* ── メインコピー ── */}
      <div className="relative z-10 flex-1 flex flex-col justify-center px-5 sm:px-7 pt-6 sm:pt-8 pb-4">

        {/* 大見出し */}
        <motion.div custom={1} variants={rise} initial="hidden" animate="show" className="mb-6 sm:mb-7">
          <p className="text-amber-200/90 text-[10px] font-black uppercase tracking-[0.28em] mb-3">
            おすそわけ
          </p>
          <h1 className="text-[34px] sm:text-[44px] font-black text-white leading-[1.08] tracking-[-0.025em]">
            お店の余った<br />
            おいしさを、<br />
            <span className="relative inline-block">
              <span className="text-amber-200">あなたへ。</span>
              <motion.span
                aria-hidden
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.7, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="absolute left-0 right-0 -bottom-1 h-[3px] origin-left rounded-full bg-amber-200/70"
              />
            </span>
          </h1>
          <p className="mt-4 text-[14px] text-white/80 font-medium leading-relaxed max-w-[320px]">
            まだまだ美味しい食べ物を、お得な「おすそわけバッグ」で。
          </p>
        </motion.div>

        {/* 特徴リスト（プレミアムカード化） */}
        <motion.ul custom={2} variants={rise} initial="hidden" animate="show"
          className="space-y-2 mb-7 sm:mb-9">
          {features.map(({ icon: Icon, text }, i) => (
            <motion.li
              key={text}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + i * 0.08, duration: 0.4 }}
              className="flex items-center gap-3 bg-white/12 backdrop-blur-sm border border-white/15 rounded-xl px-3.5 py-2.5"
            >
              <span className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
                <Icon className="w-3.5 h-3.5 text-amber-200" strokeWidth={2.6} />
              </span>
              <span className="text-white/95 text-[13px] font-bold">{text}</span>
            </motion.li>
          ))}
        </motion.ul>

        {/* CTA */}
        <motion.div custom={3} variants={rise} initial="hidden" animate="show" className="space-y-2.5">
          <button
            type="button"
            onClick={() => navigate(signupHref)}
            className="relative w-full overflow-hidden bg-white text-[#D9604F] font-black text-[16px] sm:text-[17px] py-[16px] sm:py-[17px] rounded-2xl shadow-xl shadow-black/20 active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
          >
              {/* 上部光沢 */}
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-1/2 rounded-t-2xl pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 100%)' }}
              />
              <span className="relative inline-flex items-center gap-2">
                はじめる（無料）
                <ArrowRight className="w-5 h-5" strokeWidth={3} />
              </span>
            </button>

          <button
            type="button"
            onClick={() => navigate(loginHref)}
            className="w-full bg-white/10 backdrop-blur-sm border border-white/30 text-white font-bold text-[15px] py-[14px] sm:py-[15px] rounded-2xl active:scale-[0.98] transition-transform hover:bg-white/15"
          >
            ログイン
          </button>

          {/* ★ 登録せずに商品を見る導線。 これが無いと未ログインで保護ページを踏んで
              /welcome に飛ばされた人が「登録かログインしか選べない行き止まり」になり、
              閲覧すらできずに離脱してしまう。 */}
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="w-full text-white/80 font-bold text-[13px] py-[10px] active:scale-[0.98] transition-transform hover:text-white underline underline-offset-4 decoration-white/40"
          >
            登録せずに商品を見てみる
          </button>
        </motion.div>
      </div>

      {/* ── フッター注記 ── */}
      <motion.p custom={4} variants={rise} initial="hidden" animate="show"
        className="relative z-10 text-center text-white/45 text-[11px] px-6 pb-8 leading-relaxed">
        登録することで利用規約およびプライバシーポリシーに同意したものとみなします
      </motion.p>
    </div>
  );
}
