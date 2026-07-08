import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import logoUrl from '@/lib/logo';
import {
  Map, MapPin, Package, Heart, User, Menu, X,
  FileText, Shield, Store, Settings, ChevronRight, BarChart2,
  MessageCircle, HelpCircle, ExternalLink, ShieldCheck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMyStore } from '@/hooks/use-my-store';
import { useMyStoresContext } from '@/contexts/MyStoresContext';
import { useAuth } from '@/contexts/AuthContext';
import { NotificationsBell } from '@/components/NotificationsBell';
import { loadGoogleMapsScript } from '@/lib/maps-loader';
import { prewarmMap } from '@/lib/map-prewarm';

// ★ 地図タブの「意図プリフェッチ」: 指が触れた/ホバーした瞬間に Google Maps
//   スクリプト + タイルを先読みする。 タップ→遷移→mount の間 (~100-300ms) を
//   稼ぎ、 Home の idle prewarm が未完了でも即オープンできるようにする。
//   loadGoogleMapsScript / prewarmMap は共に多重呼び出し安全 (内部でガード済み)。
function prefetchMapAssets(): void {
  loadGoogleMapsScript().catch(() => { /* noop */ });
  prewarmMap();
}

interface LayoutProps {
  children: React.ReactNode;
  showBottomNav?: boolean;
  hideFooter?: boolean;
  hideHeader?: boolean;
}

export function Layout({ children, showBottomNav = true, hideFooter = false, hideHeader = false }: LayoutProps) {
  const [location] = useLocation();
  const { isApprovedOwner } = useMyStore();
  const { currentStore: activeStore, stores: ownerStores } = useMyStoresContext();
  const { user, profile, isAdmin } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  useEffect(() => { setMenuOpen(false); }, [location]);

  // ★ profile=null の一時ウィンドウ (signUpAsStore 直後の fetchProfile レース、
  //   トークンリフレッシュ中の transient 失敗 等) で下タブが顧客側に化けるのを防ぐ。
  //   PENDING_STORE_OWNER フラグが立っている = 「このセッションは店舗側」 と
  //   AuthContext が判定済み → profile が null の間も店舗ナビにフォールバック。
  //   profile が確定したら通常通り profile.role を使う (フラグより優先)。
  const pendingStoreOwner = (() => {
    try { return sessionStorage.getItem('osusowake_pending_store_owner_v1') === '1'; }
    catch { return false; }
  })();
  const isStoreOwner = profile
    ? profile.role === 'store_owner'
    : (!!user && pendingStoreOwner);
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[Layout] nav decision', { location, profileRole: profile?.role ?? null, hasUser: !!user, pendingStoreOwner, isStoreOwner, at: new Date().toLocaleTimeString() });
  }, [location, profile?.role, user, pendingStoreOwner, isStoreOwner]);
  // ★ ニックネームはランキング参加時のみ必要 (オプトイン制)。
  //   強制入力モーダルは廃止 — ニックネーム未設定でも自由にアプリを使える。

  const storeNavItems = [
    { href: '/store/dashboard', icon: Store,     label: '出品管理', isUser: false },
    { href: '/store/sales',     icon: BarChart2, label: '売上確認', isUser: false },
    ...(isStoreOwner ? [{ href: '/mypage', icon: User, label: 'マイページ', isUser: true }] : []),
  ];

  const customerNavItems = [
    { href: '/',                icon: Map,     label: '発見',       isUser: false },
    { href: '/map',             icon: MapPin,  label: 'マップ',     isUser: false },
    { href: '/my-reservations', icon: Package, label: 'マイバック',     isUser: false },
    { href: '/favorites',       icon: Heart,   label: 'お気に入り', isUser: false },
    { href: '/mypage',          icon: User,    label: 'マイページ', isUser: true },
  ];

  const navItems = isStoreOwner ? storeNavItems : customerNavItems;
  const isLoggedIn = !!user;

  const desktopNavItems = isStoreOwner
    ? [
        { href: '/store/dashboard', label: '出品管理' },
        { href: '/store/sales',     label: '売上確認' },
        { href: '/mypage',          label: 'マイページ' },
      ]
    : [
        { href: '/',                label: '発見'     },
        { href: '/map',             label: 'マップ'   },
        { href: '/my-reservations', label: 'マイバック' },
        { href: '/mypage',          label: 'マイページ' },
      ];

  return (
    <div
      className={`${hideFooter ? 'h-dvh overflow-hidden' : 'min-h-screen'} md:!pb-0 bg-background text-foreground flex flex-col font-sans overflow-x-hidden`}
      style={showBottomNav ? { paddingBottom: (isStoreOwner && showBottomNav) ? 'calc(100px + env(safe-area-inset-bottom))' : 'calc(72px + env(safe-area-inset-bottom))' } : undefined}
    >

      {/* ── モバイル専用セーフエリアスペーサー（デスクトップ非表示）── */}
      {!hideHeader && (
        <div
          className="block md:hidden shrink-0 bg-background"
          style={{ height: 'env(safe-area-inset-top)' }}
          aria-hidden="true"
        />
      )}

      {/* ── Top Header: デスクトップのみ表示（モバイルはボトムナビを使用） ── */}
      {!hideHeader && <header
        className="hidden md:block sticky top-0 z-50 shrink-0"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="bg-white/85 backdrop-blur-xl border-b border-border/40"
          style={{ boxShadow: '0 1px 0 rgba(10,8,6,0.05), 0 2px 16px rgba(10,8,6,0.04)' }}>
          <div className="max-w-7xl mx-auto px-5 h-16 flex items-center justify-between gap-4">

            {/* Logo */}
            <Link href="/" className="flex items-center gap-2.5 group shrink-0">
              <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-8 h-8 rounded-[10px] object-cover shadow-sm transition-transform duration-200 group-hover:scale-105" />
              <span className="leading-none font-black text-[19px]" style={{ letterSpacing: '-0.04em' }}>
                <span className="text-foreground">おすそわけ</span>
              </span>
            </Link>

            <div className="flex items-center gap-3">
              {/* Desktop Nav */}
              <nav className="hidden md:flex items-center gap-6">
                {desktopNavItems.map((item) => (
                  <Link key={item.href} href={item.href}
                    className={`text-sm font-semibold transition-all duration-150 relative py-1
                      ${location === item.href
                        ? 'text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                      }`}>
                    {item.label}
                    {location === item.href && (
                      <motion.div
                        layoutId="desktop-nav-indicator"
                        className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-primary rounded-full"
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                      />
                    )}
                  </Link>
                ))}
              </nav>

              {/* ベルアイコン（ログイン済みのみ）*/}
              {isLoggedIn && <NotificationsBell />}

              {/* Hamburger */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="メニューを開く"
                  className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-150 text-foreground
                    ${menuOpen ? 'bg-muted text-primary' : 'hover:bg-muted/70'}
                    ${isLoggedIn ? 'ring-2 ring-primary/20 ring-offset-1 ring-offset-background' : ''}`}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {menuOpen ? (
                      <motion.div key="x"
                        initial={{ rotate: -45, opacity: 0, scale: 0.7 }}
                        animate={{ rotate: 0,   opacity: 1, scale: 1 }}
                        exit={{ rotate: 45,    opacity: 0, scale: 0.7 }}
                        transition={{ duration: 0.14 }}>
                        <X className="w-4.5 h-4.5" />
                      </motion.div>
                    ) : (
                      <motion.div key="menu"
                        initial={{ rotate: 45, opacity: 0, scale: 0.7 }}
                        animate={{ rotate: 0,  opacity: 1, scale: 1 }}
                        exit={{ rotate: -45,   opacity: 0, scale: 0.7 }}
                        transition={{ duration: 0.14 }}>
                        <Menu className="w-4.5 h-4.5" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </button>

                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0,  scale: 1 }}
                      exit={{ opacity: 0,  y: -6, scale: 0.97 }}
                      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute right-0 mt-2 w-72 bg-card rounded-2xl overflow-hidden z-50"
                      style={{ boxShadow: '0 8px 32px rgba(10,8,6,0.12), 0 2px 8px rgba(10,8,6,0.05), 0 0 0 1px rgba(10,8,6,0.05)' }}
                    >
                      {isLoggedIn ? (
                        <Link href="/mypage"
                          className="block transition-colors duration-150 hover:bg-muted/50">
                          <div className="px-4 py-4 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                              <User className="w-5 h-5 text-primary" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-foreground truncate">{user.email}</p>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                  profile?.role === 'store_owner'
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-primary/10 text-primary'
                                }`}>
                                  {profile?.role === 'store_owner' ? '🏪 店舗オーナー' : '👤 お客様'}
                                </span>
                              </div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                          </div>
                        </Link>
                      ) : (
                        <div className="px-4 py-3.5 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <User className="w-4 h-4" />
                            <span>ゲストユーザー</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Link href="/login"
                              className="text-xs font-semibold text-primary border border-primary/30 rounded-lg px-3 py-1.5 hover:bg-primary/5 transition-colors">
                              ログイン
                            </Link>
                            <Link href="/signup"
                              className="text-xs font-semibold text-white rounded-lg px-3 py-1.5 hover:brightness-105 transition-all shadow-sm"
                              style={{ background: 'linear-gradient(180deg, #F07826 0%, #E85A0C 100%)', boxShadow: '0 2px 8px rgba(242,100,25,0.25)' }}>
                              新規登録
                            </Link>
                          </div>
                        </div>
                      )}

                      {isLoggedIn && (
                        <Link href="/settings"
                          className="flex items-center gap-3 px-4 py-2.5 border-t border-border/40 text-sm font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors duration-150">
                          <Settings className="w-4 h-4 shrink-0" />
                          アカウント設定
                        </Link>
                      )}

                      {isAdmin && (
                        <Link href="/admin"
                          className="flex items-center gap-3 px-4 py-2.5 border-t border-border/40 text-sm font-bold hover:bg-purple-50 transition-colors duration-150"
                          style={{ color: '#7c3aed' }}>
                          <ShieldCheck className="w-4 h-4 shrink-0" />
                          <span>管理者ダッシュボード</span>
                          <span className="ml-auto text-[10px] font-black bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">神モード</span>
                        </Link>
                      )}

                      {/* 規約リンク */}
                      <div className="border-t border-border/40">
                        <div className="px-4 pt-3 pb-1">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                            規約・その他
                          </p>
                        </div>
                        <div className="pb-2">
                          {[
                            { href: '/terms',          icon: FileText, label: '利用規約' },
                            { href: '/merchant-terms', icon: FileText, label: '出店者規約' },
                            { href: '/privacy',        icon: Shield,   label: 'プライバシーポリシー' },
                            { href: '/legal',          icon: Store,    label: '特定商取引に基づく表記' },
                          ].map((item) => {
                            const Icon = item.icon;
                            return (
                              <Link key={item.href} href={item.href}
                                className="flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors duration-150">
                                <Icon className="w-4 h-4 text-primary/60 shrink-0" />
                                {item.label}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </header>}

      {/* ── Main Content ─────────────────────────────────────────────── */}
      <main className="flex-1 min-h-0 w-full relative flex flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={location}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.20, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-h-0 flex flex-col w-full min-w-0"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      {!hideFooter && (
        <footer
          className={`bg-white border-t border-border/40 mt-auto ${showBottomNav ? 'hidden md:block' : ''}`}
          style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.04)' }}
        >
          {/* ─── Desktop Full Footer ─── */}
          <div className="hidden md:block max-w-7xl mx-auto px-8 pt-12 pb-8">
            <div className="grid grid-cols-4 gap-8 pb-10 border-b border-border/25">

              {/* Brand column */}
              <div className="col-span-1">
                <div className="flex items-center gap-2.5 mb-3">
                  <img loading="lazy" decoding="async" src={logoUrl} alt="おすそわけ" className="w-7 h-7 rounded-[8px] object-cover shrink-0" />
                  <span className="font-black text-[17px]" style={{ letterSpacing: '-0.03em' }}>
                    <span className="text-foreground">おすそわけ</span>
                  </span>
                </div>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  お店の味を、誰かにおすそわけしよう。<br />
                  余剰食品を、価値ある出会いに。
                </p>
              </div>

              {/* サービス */}
              <div>
                <h4 className="text-[11px] font-black uppercase tracking-widest text-muted-foreground/60 mb-4">サービス</h4>
                <ul className="space-y-2.5">
                  {[
                    { href: '/',    label: '発見' },
                    { href: '/map', label: 'マップで探す' },
                    { href: '/my-reservations', label: 'お届け管理' },
                    { href: '/favorites', label: 'お気に入り' },
                  ].map((item) => (
                    <li key={item.href}>
                      <Link href={item.href}
                        className="text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium">
                        {item.label}
                      </Link>
                    </li>
                  ))}
                  {profile?.role === 'store_owner' && isApprovedOwner && (
                    <li>
                      <Link href="/store/dashboard"
                        className="text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium">
                        店舗ダッシュボード
                      </Link>
                    </li>
                  )}
                </ul>
              </div>

              {/* 法的情報 */}
              <div>
                <h4 className="text-[11px] font-black uppercase tracking-widest text-muted-foreground/60 mb-4">法的情報</h4>
                <ul className="space-y-2.5">
                  {[
                    { href: '/terms',          label: '利用規約',              icon: FileText },
                    { href: '/merchant-terms', label: '出店者規約',            icon: FileText },
                    { href: '/privacy',        label: 'プライバシーポリシー',  icon: Shield },
                    { href: '/legal',          label: '特定商取引法に基づく表記', icon: Store },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link href={item.href}
                          className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium">
                          <Icon className="w-3.5 h-3.5 shrink-0 opacity-60" />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* サポート */}
              <div>
                <h4 className="text-[11px] font-black uppercase tracking-widest text-muted-foreground/60 mb-4">サポート</h4>
                <ul className="space-y-2.5">
                  <li>
                    <Link href="/help"
                      className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium">
                      <HelpCircle className="w-3.5 h-3.5 shrink-0 opacity-60" />
                      ヘルプ・FAQ
                    </Link>
                  </li>
                  <li>
                    <a
                      href="https://lin.ee/ZXRknd7"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium"
                    >
                      <MessageCircle className="w-3.5 h-3.5 shrink-0 opacity-60" />
                      LINEで問い合わせ
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://forms.gle/uhMoXjjF9YzkR52a6"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors font-medium"
                    >
                      <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />
                      お問い合わせフォーム
                    </a>
                  </li>
                </ul>
              </div>
            </div>

            {/* Copyright row */}
            <div className="pt-6 flex flex-col md:flex-row items-center justify-between gap-3">
              <p className="text-[12px] text-muted-foreground/55 font-medium">
                © 2026 おすそわけ. All rights reserved.
              </p>
              <p className="text-[11px] text-muted-foreground/40">
                初期費用・月額0円。成果報酬型（手数料20%）
              </p>
            </div>
          </div>

          {/* ─── Mobile Compact Footer ─── */}
          <div className="md:hidden px-5 py-6">
            {/* Legal Links */}
            <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 mb-4">
              {[
                { href: '/terms',          label: '利用規約' },
                { href: '/merchant-terms', label: '出店者規約' },
                { href: '/privacy',        label: 'プライバシー' },
                { href: '/legal',          label: '特定商取引法' },
                { href: '/help',           label: 'ヘルプ' },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-[11px] text-muted-foreground/60 hover:text-primary transition-colors font-medium"
                >
                  {item.label}
                </Link>
              ))}
            </div>

            {/* LINE Support */}
            <div className="flex justify-center mb-4">
              <a
                href="https://lin.ee/ZXRknd7"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-border/60 bg-white text-[12px] font-semibold text-muted-foreground hover:text-primary hover:border-primary/30 transition-all"
                style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}
              >
                <MessageCircle className="w-3.5 h-3.5 text-green-500" />
                LINEでサポートに問い合わせる
                <ExternalLink className="w-3 h-3 opacity-40" />
              </a>
            </div>

            <p className="text-center text-[11px] text-muted-foreground/40 font-medium">
              © 2026 おすそわけ. All rights reserved.
            </p>
          </div>
        </footer>
      )}

      {/* ── Mobile Bottom Nav ─────────────────────────────────────────── */}
      {showBottomNav && (
        <div
          className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-border/40"
          style={{
            boxShadow: '0 -1px 0 rgba(10,8,6,0.04), 0 -4px 20px rgba(10,8,6,0.05)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          {/* 店舗オーナー向け：現在操作中の店舗名バナー */}
          {isStoreOwner && activeStore && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-orange-500/95 border-b border-orange-400/30">
              <Store className="w-3 h-3 text-white/90 shrink-0" />
              <span className="text-[11px] font-black text-white truncate max-w-[200px]">{activeStore.name}</span>
              {ownerStores.length > 1 && (
                <span className="text-[9px] font-bold text-orange-200 shrink-0 ml-0.5">操作中</span>
              )}
            </div>
          )}
          <div className="flex items-stretch h-[72px] px-2">
            {navItems.map((item) => {
              const isActive =
                location === item.href ||
                (item.href === '/my-reservations' && location.startsWith('/my-reservations')) ||
                (item.href === '/favorites' && location === '/favorites') ||
                (item.href === '/store/dashboard' && (location === '/store-onboarding' || location === '/store/bank-setup')) ||
                (item.href === '/store/bags' && location.startsWith('/store/bag'));
              const Icon = item.icon;
              const isUser = item.isUser ?? (item.href === '/mypage' || item.href === '/welcome');

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onPointerEnter={item.href === '/map' ? prefetchMapAssets : undefined}
                  onTouchStart={item.href === '/map' ? prefetchMapAssets : undefined}
                  className="relative flex flex-col items-center justify-center flex-1 gap-1 min-w-0 py-2 transition-opacity duration-100 active:opacity-60"
                >
                  <div className={`relative flex items-center justify-center w-12 h-8 rounded-full transition-all duration-200
                    ${isActive ? 'bg-primary/10' : ''}`}>
                    {isActive && (
                      // layoutId の共有レイアウトアニメ(FLIP)は古い Android WebView で
                      // 位置を誤計算してバーが横にズレる。静的配置にして全エンジンで中央固定。
                      <div className="absolute -top-[8px] left-1/2 -translate-x-1/2 w-6 h-[3px] bg-primary rounded-full" />
                    )}
                    <Icon
                      className={`w-[26px] h-[26px] transition-all duration-200
                        ${isActive ? 'text-primary' : 'text-muted-foreground/55'}`}
                      strokeWidth={isActive ? 2.5 : 1.8}
                    />
                    {isUser && isLoggedIn && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full border-2 border-white" />
                    )}
                  </div>
                  <span className={`text-[11px] font-bold leading-none transition-colors duration-200
                    ${isActive ? 'text-primary' : 'text-muted-foreground/60'}`}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
