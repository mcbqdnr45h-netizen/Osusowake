import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import logoUrl from '@/lib/logo';
import { useAuth } from '@/contexts/AuthContext';
import { useMyStoresContext } from '@/contexts/MyStoresContext';
import { logNav, getNavEvents } from '@/lib/nav-debug';
import {
  Loader2, Ticket, Heart, User, ArrowRight, Shield, Clock, Sparkles,
} from 'lucide-react';
import { Layout } from '@/components/Layout';

// ── 一時的な認証診断パネル ──────────────────────────────────────────────
// iOS で「無言でログイン画面に戻る」原因を実機で掴むための観測専用 UI。
// 直近の auth イベント列を画面に出すだけで、挙動は一切変えない。原因特定後に削除。
function AuthDebugTrail() {
  const [hidden, setHidden] = useState(false);
  // 通常ユーザーには出さない。URL に `#authdbg` を付けた時だけ表示する。
  // 記録 (recordEvent) は裏で常時続くので、再発時に #authdbg で確認できる。
  const enabled =
    typeof window !== 'undefined' &&
    window.location.hash.toLowerCase().includes('authdbg');
  const events = getNavEvents();
  if (!enabled || hidden || events.length === 0) return null;
  const now = Date.now();
  return (
    <div
      onClick={() => setHidden(true)}
      style={{
        position: 'fixed', left: 6, right: 6, bottom: 6, zIndex: 99999,
        maxHeight: '38vh', overflowY: 'auto', background: 'rgba(20,18,16,0.92)',
        color: '#fff', fontSize: 10, lineHeight: 1.45, padding: '8px 10px',
        borderRadius: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, opacity: 0.8 }}>
        auth trail (tap to hide) — 最新が下
      </div>
      {events.map((e, i) => (
        <div key={i}>
          {`-${((now - e.t) / 1000).toFixed(1)}s ${e.msg} ${e.extra ? JSON.stringify(e.extra) : ''}`}
        </div>
      ))}
    </div>
  );
}

function AuthLoadingScreen() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-gradient-to-br from-orange-50/40 via-background to-rose-50/30">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-xl animate-pulse" />
          <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="relative w-16 h-16 rounded-2xl object-cover shadow-lg ring-1 ring-black/5" />
        </div>
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground font-medium tracking-wide">読み込み中…</p>
      </div>
      <AuthDebugTrail />
    </div>
  );
}

function GuestPlaceholderScreen() {
  const [, navigate] = useLocation();

  const features = [
    { icon: Ticket, label: 'お届け',     desc: '購入した商品の受取チケットを確認', tint: 'from-orange-50 to-orange-100/50',  ring: 'ring-orange-200/60',  iconBg: 'bg-gradient-to-br from-orange-100 to-orange-200/70',  iconColor: 'text-orange-600' },
    { icon: Heart,  label: 'お気に入り', desc: '気になる店舗をブックマーク',          tint: 'from-rose-50 to-rose-100/50',      ring: 'ring-rose-200/60',    iconBg: 'bg-gradient-to-br from-rose-100 to-rose-200/70',      iconColor: 'text-rose-500' },
    { icon: User,   label: 'マイページ',  desc: 'プロフィール・通知・ご利用設定',      tint: 'from-amber-50 to-amber-100/50',    ring: 'ring-amber-200/60',   iconBg: 'bg-gradient-to-br from-amber-100 to-amber-200/70',    iconColor: 'text-amber-600' },
  ] as const;

  const trustBadges = [
    { icon: Sparkles, label: '完全無料' },
    { icon: Clock,    label: '登録30秒' },
    { icon: Shield,   label: '安全・安心' },
  ] as const;

  return (
    <Layout showBottomNav>
      <AuthDebugTrail />
      {/* ── 背景：ブランドカラーのソフトグラデーション + 浮遊する装飾光 ── */}
      <div
        className="relative flex-1 min-h-0 flex flex-col items-center justify-center px-5 py-3 overflow-y-auto overflow-x-hidden"
        style={{
          background:
            'radial-gradient(120% 80% at 50% -10%, hsl(var(--primary) / 0.10) 0%, transparent 55%), ' +
            'radial-gradient(80% 60% at 100% 100%, hsl(20 85% 70% / 0.08) 0%, transparent 60%), ' +
            'linear-gradient(180deg, hsl(var(--background)) 0%, hsl(30 30% 98%) 100%)',
        }}
      >
        {/* 装飾光 — scale アニメ(transform+will-change)があると古い Android WebView で
            合成レイヤー化して filter:blur が無効になり「ぼけてない赤丸」になるため静的化。 */}
        <div
          aria-hidden
          className="absolute -top-16 -right-12 w-56 h-56 rounded-full bg-primary/15 blur-3xl pointer-events-none"
        />
        <div
          aria-hidden
          className="absolute -bottom-20 -left-12 w-64 h-64 rounded-full bg-rose-200/30 blur-3xl pointer-events-none"
        />

        {/* ── ロゴ（光るリング付き）─── */}
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 22 }}
          className="relative mb-2 md:mb-6 shrink-0"
        >
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/30 to-orange-300/30 blur-xl" />
          <div className="relative w-14 h-14 md:w-24 md:h-24 rounded-2xl md:rounded-3xl overflow-hidden ring-1 ring-black/5 shadow-lg shadow-primary/10 bg-white">
            <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-full h-full object-cover" />
          </div>
        </motion.div>

        {/* ── キャッチコピー ─── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06, duration: 0.45 }}
          className="text-center mb-1 shrink-0"
        >
          <p className="text-[9px] md:text-[12px] font-black tracking-[0.25em] text-primary/80 mb-1 md:mb-2">おすそわけ</p>
          <h1 className="text-[19px] md:text-[34px] font-black text-foreground leading-[1.3] tracking-tight">
            ログインして、<br />
            <span className="bg-gradient-to-r from-primary to-orange-500 bg-clip-text text-transparent">
              おいしいおすそわけ
            </span>を。
          </h1>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.18, duration: 0.4 }}
          className="text-[11px] md:text-[15px] text-muted-foreground text-center leading-relaxed mt-1.5 md:mt-3 mb-2.5 md:mb-5 max-w-[280px] md:max-w-[460px] shrink-0"
        >
          お店の余ったおいしさを、お得に持ち帰り。<br />
          まずは無料アカウントで始めよう。
        </motion.p>

        {/* ── 信頼バッジ ─── */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.24, duration: 0.4 }}
          className="flex items-center gap-1.5 mb-3 shrink-0"
        >
          {trustBadges.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/70 backdrop-blur-sm border border-border/60 text-[10px] font-bold text-foreground/70 shadow-sm"
            >
              <Icon className="w-2.5 h-2.5 text-primary" />
              {label}
            </span>
          ))}
        </motion.div>

        {/* ── 機能リスト（プレミアムカード）─── */}
        <div className="w-full max-w-sm md:max-w-2xl space-y-1.5 md:space-y-3 mb-3 md:mb-6">
          {features.map(({ icon: Icon, label, desc, tint, ring, iconBg, iconColor }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 + i * 0.07, type: 'spring', stiffness: 240, damping: 24 }}
              className={`flex items-center gap-2.5 md:gap-5 bg-gradient-to-r ${tint} ring-1 ${ring} rounded-2xl md:rounded-3xl px-3 py-2 md:px-6 md:py-5 shadow-sm`}
            >
              <div className={`w-8 h-8 md:w-14 md:h-14 ${iconBg} rounded-xl md:rounded-2xl flex items-center justify-center shrink-0 shadow-inner`}>
                <Icon className={`w-3.5 h-3.5 md:w-6 md:h-6 ${iconColor}`} strokeWidth={2.4} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] md:text-[18px] font-black text-foreground leading-tight">{label}</p>
                <p className="text-[10px] md:text-[14px] text-foreground/55 mt-0.5 md:mt-1 truncate">{desc}</p>
              </div>
              <ArrowRight className="w-3 h-3 md:w-5 md:h-5 text-foreground/30 shrink-0" />
            </motion.div>
          ))}
        </div>

        {/* ── CTA（プレミアムボタン）─── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55, duration: 0.4 }}
          className="w-full max-w-sm md:max-w-2xl space-y-1.5 md:space-y-3 shrink-0"
        >
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="relative w-full overflow-hidden rounded-2xl md:rounded-3xl py-3 md:py-5 font-black text-[14px] md:text-[18px] text-white shadow-lg shadow-primary/30 active:scale-[0.98] transition-transform"
            style={{
              background:
                'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(12 80% 60%) 100%)',
            }}
          >
            {/* 上部ハイライト（光沢）*/}
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-1/2 rounded-t-2xl pointer-events-none"
              style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 100%)' }}
            />
            <span className="relative inline-flex items-center justify-center gap-1.5">
              ログインする
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={2.6} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/signup')}
            className="w-full bg-white/80 backdrop-blur-sm border border-border text-foreground font-bold py-2.5 md:py-4 rounded-2xl md:rounded-3xl text-[12px] md:text-[16px] hover:bg-white active:scale-[0.98] transition-all shadow-sm"
          >
            新規登録（無料）
          </button>
        </motion.div>

        {/* ── ゲスト閲覧リンク ─── */}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 0.4 }}
          type="button"
          onClick={() => navigate('/')}
          className="mt-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          ログインせずに店舗を見る →
        </motion.button>
      </div>
    </Layout>
  );
}

// ── 完全保護（管理・チェックアウトなど）────────────────────────────────────
export function ProtectedRoute({
  component: Component,
  requireRole,
}: {
  component: React.ComponentType;
  requireRole?: 'customer' | 'store_owner';
}) {
  const { user, profile, isLoading } = useAuth();
  const { stores, loading: storesLoading } = useMyStoresContext();
  const [location, navigate] = useLocation();

  // store_owner ルートかつ profile.role が customer の場合でも
  // stores をロード中 OR stores がある = 整合修正待ちの可能性 → 待機
  const hasStores = stores.length > 0;
  const isStoreRoleReconciling =
    requireRole === 'store_owner' &&
    profile?.role !== 'store_owner' &&
    (storesLoading || hasStores);

  const [profileWaitExpired, setProfileWaitExpired] = useState(false);
  useEffect(() => {
    if (!isLoading && user && requireRole && !profile) {
      const t = setTimeout(() => {
        console.warn('[ProtectedRoute] profile still null after 3s — proceeding anyway');
        setProfileWaitExpired(true);
      }, 3000);
      return () => clearTimeout(t);
    }
    setProfileWaitExpired(false);
    return undefined;
  }, [isLoading, user, profile, requireRole]);

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      const redirect = encodeURIComponent(location);
      logNav('ProtectedRoute(no user)', `/welcome?redirect=${redirect}`, { from: location, requireRole });
      navigate(`/welcome?redirect=${redirect}`, { replace: true });
      return;
    }

    if (requireRole && profile && !storesLoading) {
      if (profile.role !== requireRole) {
        // store_owner ルートで store を持っているなら整合修正待ち → リダイレクトしない
        if (requireRole === 'store_owner' && hasStores) return;
        if (requireRole === 'store_owner') {
          logNav('ProtectedRoute(role mismatch, customer on store route)', '/', { from: location, profileRole: profile.role });
          navigate('/', { replace: true });
        } else {
          logNav('ProtectedRoute(role mismatch, store on customer route)', '/store/dashboard', { from: location, profileRole: profile.role });
          navigate('/store/dashboard', { replace: true });
        }
      }
    }
  }, [isLoading, user, profile, requireRole, location, navigate, storesLoading, hasStores]);

  if (isLoading) return <AuthLoadingScreen />;
  if (!user) return null;
  if (requireRole && !profile && !profileWaitExpired) return <AuthLoadingScreen />;
  // store_owner ルートで整合修正待ちの間はローディング表示（誤リダイレクト防止）
  if (isStoreRoleReconciling) return <AuthLoadingScreen />;
  if (requireRole && profile && profile.role !== requireRole && !hasStores) return null;

  return <Component />;
}

// ── ゲストウォール（タブページ：未ログインはプレースホルダー表示）────────────
export function GuestWallRoute({
  component: Component,
}: {
  component: React.ComponentType;
}) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <AuthLoadingScreen />;
  if (!user) return <GuestPlaceholderScreen />;
  return <Component />;
}

// ── ゲスト専用（ログイン済みなら自動リダイレクト）────────────────────────────
export function GuestRoute({
  component: Component,
}: {
  component: React.ComponentType;
}) {
  const { user, profile, isLoading, refreshProfile } = useAuth();
  const [, navigate] = useLocation();

  // ★ 白画面バグの安全網: 登録/ログイン直後は profile 行の作成・取得がレースで
  //   遅れることがあり、「user あり・profile なし」が続くと下の描画が null のまま
  //   = 真っ白で固まっていた。profile を定期リトライし、それでも来なければ
  //   公開ホームへ逃がす (ログイン自体は成立しており Home は profile 不要で動く)。
  useEffect(() => {
    if (isLoading || !user || profile) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts <= 4) {
        refreshProfile().catch(() => { /* ignore */ });
      } else {
        clearInterval(timer);
        logNav('GuestRoute(profile timeout fallback)', '/');
        navigate('/', { replace: true });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [isLoading, user, profile, refreshProfile, navigate]);

  useEffect(() => {
    if (isLoading || !user) return;

    // redirect クエリがある場合はそこへ
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    if (redirect) {
      const decoded = decodeURIComponent(redirect);
      if (decoded.startsWith('/') && !decoded.startsWith('//')) {
        logNav('GuestRoute(redirect param)', decoded);
        navigate(decoded, { replace: true });
        return;
      }
    }

    // ★ 店舗新規登録の直後 (PENDING フラグあり) は MyPage を経由させず
    //   /store-onboarding へ直行する (profile 確定前でも判定可能)
    let pendingStoreOwner = false;
    try { pendingStoreOwner = sessionStorage.getItem('osusowake_pending_store_owner_v1') === '1'; }
    catch { /* ignore */ }
    if (pendingStoreOwner) {
      logNav('GuestRoute(pending store owner)', '/store-onboarding', { role: profile?.role ?? null });
      navigate('/store-onboarding', { replace: true });
      return;
    }

    // profile が確定してからロールで振り分け
    if (profile) {
      // ★ store_owner は /store/dashboard へ直行。/mypage 経由だと一瞬
      //   顧客向け MyPage が描画されて「ユーザー画面がチラつく」 バグになる。
      if (profile.role === 'store_owner') {
        logNav('GuestRoute(logged-in store_owner)', '/store/dashboard', { role: profile.role });
        navigate('/store/dashboard', { replace: true });
      } else {
        logNav('GuestRoute(logged-in customer)', '/mypage', { role: profile.role });
        navigate('/mypage', { replace: true });
      }
    }
  }, [isLoading, user, profile, navigate]);

  if (isLoading) return null;
  // ログイン済み (user あり) なら遷移完了までローディングを表示する。
  // ★ 旧実装の null (真っ白) は登録直後の profile レースで「白画面で固まる」
  //   と誤認される元凶だった。ロゴ+スピナーで「処理中」であることを見せる。
  if (user) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-background gap-4">
        <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-16 h-16 rounded-2xl object-cover shadow-lg ring-1 ring-black/5" />
        <div className="flex items-center gap-2 text-muted-foreground text-sm font-bold">
          <span className="inline-block w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          アカウントを準備しています…
        </div>
      </div>
    );
  }

  return <Component />;
}
