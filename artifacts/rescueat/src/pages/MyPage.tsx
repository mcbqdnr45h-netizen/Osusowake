import React, { useEffect, useState, useCallback } from 'react';
import { Layout } from '@/components/Layout';
import { useUserId } from '@/hooks/use-user';
import { useMyStores } from '@/hooks/use-my-stores';
import { useListReservations, getListReservationsQueryKey, useGetMonthlyRanking, getGetMonthlyRankingQueryKey } from '@workspace/api-client-react';
import { User, Leaf, ShoppingBag, Heart, ChevronRight, Settings, HelpCircle, LogOut, Store as StoreIcon, CreditCard, Receipt, Mail, Scale, Star, Clock, XCircle, FileCheck, Camera, MessageSquare, Bell, Megaphone, CheckCircle, CheckCheck, Flag, ShieldCheck, AlertTriangle, Trash2, Trophy, BookOpen } from 'lucide-react';
import { ShareAppCard } from '@/components/ShareAppCard';
import { ImpactShareButton } from '@/components/ImpactShareButton';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { MyTown } from '@/components/MyTown';
import { Link, useLocation } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { authedFetch } from '@/lib/authed-fetch';
import { useAvatar } from '@/hooks/use-avatar';
import { normalizeBrand } from '@/lib/brand-text';

export default function MyPage() {
  const userId = useUserId();
  const { currentStore: store, stores, selectedStoreId, setSelectedStoreId, loading: loadingStore, fetchError, isApprovedOwner, needsBankSetup, refetch } = useMyStores();
  const [location, navigate] = useLocation();
  const { user, profile, session, isLoading: authLoading, signOut, isAdmin } = useAuth();
  const { toast } = useToast();
  // Settings で端末ローカル保存されたユーザアイコン (なければ null → デフォルトアイコン)
  const userAvatarUrl = useAvatar(user?.id);

  // MyPageが表示されるたびに最新データを取得（bank-setup完了後の古いキャッシュ表示を防ぐ）
  useEffect(() => {
    refetch();
  }, [location]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ロール修正は App.tsx の RoleReconciler が全ページで自動実行するため不要 ──

  const { data: reservations } = useListReservations({ userId: userId || '' }, {
    query: {
      queryKey: getListReservationsQueryKey({ userId: userId || '' }),
      enabled: !!userId,
    },
  });

  // ★ 累計値 (foodSavedKg / co2Saved / MyTown level の元になる pickedUpCount) は
  //    全予約 (月次フィルタ無し) ベースで算出。 ランキングは月次でリセットされても
  //    この累計値とマイタウンのレベルは絶対にリセットしない仕様。
  const pickedUpReservations = reservations?.filter(r => r.status === 'picked_up') || [];
  const pickedUpCount  = pickedUpReservations.length;
  const foodSavedKg    = +(pickedUpCount * 0.5).toFixed(1);
  const co2Saved       = +(pickedUpCount * 2.5).toFixed(1);

  // ★ 月次ランキング情報 (MyTown セクションの「現在の月間順位」表示用)
  //    refetchInterval で 60秒毎に自動更新、 staleTime で重複フェッチ抑制。
  const { data: monthlyRanking } = useGetMonthlyRanking(
    { limit: 1 },
    {
      query: {
        queryKey: getGetMonthlyRankingQueryKey({ limit: 1 }),
        staleTime: 60_000,
        refetchInterval: 60_000,
        enabled: !!userId,
      },
    },
  );

  // ── Stripe ライブステータス（payouts_enabled を DB 固定値ではなく API から取得）──
  // ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
  const BASE_URL = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
                   (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');
  const storeId = store?.id;
  const { data: stripeStatus } = useQuery<{
    connected: boolean;
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirements?: {
      currentlyDue: string[];
      pendingVerification: string[];
      errors: { code: string; requirement: string }[];
      disabledReason: string | null;
    };
  } | null>({
    queryKey: [`/api/stores/${storeId}/connect/status`],
    queryFn: async () => {
      if (!storeId) return null;
      // ★ iOS WKWebView の URL キャッシュを完全回避：no-store + cache-busting query
      const bust = `_=${Date.now()}`;
      const res = await authedFetch(`${BASE_URL}/api/stores/${storeId}/connect/status?${bust}`, { cache: 'no-store' });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!storeId && !!store?.stripeAccountId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // ── お知らせ（通知）──
  const [notifications, setNotifications] = useState<{ id: number; title: string; body: string; type: string; read: boolean; createdAt: string; storeId?: number | null }[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  // ★ A案: 設定モーダル削除済 → 設定リストは MyPage 本体にインライン表示。 showSettings/scroll-lock は不要。

  const fetchNotifications = useCallback(() => {
    if (!userId || !session?.access_token) return;
    // ★ ヘッダーのベル (NotificationsBell) と完全に同じ「全通知」を取得する。
    //   以前は storeId で絞っていたが、ヘッダーのベルは絞らないため未読数がズレ、
    //   「2つのベルが連動していない」ように見えていた → フィルタ撤廃で単一ソース化。
    authedFetch(`${BASE_URL}/api/notifications`)
      .then(r => r.ok ? r.json() : { notifications: [], unreadCount: 0 })
      .then(d => { setNotifications(d.notifications || []); setUnreadCount(d.unreadCount || 0); })
      .catch((err) => { console.warn('[MyPage] notifications fetch failed', err); });
  }, [userId, session?.access_token]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // ★ Home の 🔔 (NotificationsBell) で markRead/markAllRead されたら MyPage 側も同期。
  //   逆方向 (MyPage→Home) も同じイベントで同期される (markNotificationRead 内で dispatch)。
  useEffect(() => {
    const handler = () => { fetchNotifications(); };
    window.addEventListener('notifications:changed', handler);
    return () => window.removeEventListener('notifications:changed', handler);
  }, [fetchNotifications]);

  // ★ 「詳細を見る」 タップ時に既読化: API + 楽観更新 + Home 同期 broadcast。
  const markNotificationRead = useCallback(async (id: number) => {
    if (!session?.access_token) return;
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await authedFetch(`${BASE_URL}/api/notifications/${id}/read`, { method: 'PATCH' });
      window.dispatchEvent(new CustomEvent('notifications:changed', { detail: { id, read: true } }));
    } catch (err) {
      console.warn('[MyPage] markRead failed', err);
    }
  }, [session?.access_token]);

  // ★ 「すべて既読」: サーバーの read-all はユーザー全体を既読化する（storeId 非依存）。
  //   楽観更新 + broadcast でヘッダーのベル (NotificationsBell) とも即同期。
  const markAllNotificationsRead = useCallback(async () => {
    if (!session?.access_token) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await authedFetch(`${BASE_URL}/api/notifications/read-all`, { method: 'PATCH' });
      window.dispatchEvent(new CustomEvent('notifications:changed', { detail: { all: true } }));
    } catch (err) {
      console.warn('[MyPage] markAllRead failed', err);
    }
  }, [session?.access_token]);

  async function handleLogout() {
    await signOut();
    navigate('/welcome');
  }

  async function handleDeleteAccount() {
    if (!session?.access_token) return;
    setDeletingAccount(true);

    // ── ① サーバーに削除リクエスト ──────────────────────────────
    let serverDeleted = false;
    try {
      const res = await authedFetch(`${BASE_URL}/api/user/account`, {
        method: 'DELETE',
      });
      if (res.ok) {
        serverDeleted = true;
      } else {
        // すでに削除済（401: ユーザー消滅後のトークン）も成功扱い
        if (res.status === 401 || res.status === 404) {
          serverDeleted = true;
          console.info('[MyPage] account already deleted server-side (status=', res.status, ')');
        } else {
          const errBody = await res.json().catch(() => ({} as { error?: string; message?: string }));
          console.error('[MyPage] delete API failed:', res.status, errBody);
        }
      }
    } catch (err) {
      console.error('[MyPage] delete fetch error:', err);
    }

    // ── ② 削除失敗ならエラー toast を出して終了 ──────────────────
    if (!serverDeleted) {
      setDeletingAccount(false);
      setShowDeleteConfirm(false);
      toast({
        title: 'アカウントの削除に失敗しました',
        description: 'しばらくしてから再試行してください。',
        variant: 'destructive',
      });
      return;
    }

    // ── ③ 削除成功：signOut の失敗は想定内（auth.users 既に削除済 → 403）──
    // signOut のエラーは catch して握り潰す。失敗しても navigate はする。
    try {
      await signOut();
    } catch (signOutErr) {
      console.warn('[MyPage] signOut after delete threw (expected):', signOutErr);
    }

    setDeletingAccount(false);
    setShowDeleteConfirm(false);
    toast({
      title: 'アカウントを削除しました',
      description: 'ご利用いただきありがとうございました。',
    });
    navigate('/welcome');
  }

  const isStoreOwner = profile?.role === 'store_owner';

  // ★ profile 読み込み待ちのタイムアウト (1000ms 経ったら諦めて描画する → 永久スケルトン防止)
  //    fetchProfile のタイムアウトを 5s→2s に短縮済みなので、1000ms で十分余裕がある。
  //    キャッシュヒット時 (2回目以降) は即座に描画される。
  //    ★ 1000ms は role flash 防止と永久ロード防止のバランス点 (architect 推奨範囲)。
  const [profileWaitElapsed, setProfileWaitElapsed] = useState(false);
  useEffect(() => {
    if (profile) { setProfileWaitElapsed(true); return; }
    const t = setTimeout(() => setProfileWaitElapsed(true), 1000);
    return () => clearTimeout(t);
  }, [profile]);

  // Auth確定前はスケルトン表示でフラッシュを防ぐ
  // ★ profile が未ロード時もスケルトンを出す (店舗オーナーがカスタマー画面でフラッシュするバグ防止)
  // ★ ただし最大1.2秒まで - それ以上は profile=null でも描画する (永久ロード防止)
  // ★ store の読み込み待ちはスケルトンを出さない（profile が決まれば店舗カードはインラインローダーで表示）
  if (authLoading || (user && !profile && !profileWaitElapsed)) {
    return (
      <Layout showBottomNav>
        <div className="w-full py-8 px-4 animate-pulse">
          <div className="h-8 w-32 bg-muted rounded-xl mb-6" />
          <div className="bg-card border border-border rounded-2xl p-5 mb-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-muted rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-5 w-40 bg-muted rounded-lg" />
                <div className="h-4 w-24 bg-muted rounded-lg" />
              </div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-4 border-b border-border last:border-0">
                <div className="w-10 h-10 bg-muted rounded-full shrink-0" />
                <div className="h-4 flex-1 bg-muted rounded-lg" />
                <div className="w-4 h-4 bg-muted rounded" />
              </div>
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  const pageContent = (
    <div
      // ★ A案: MyTown を縮小カード化したため flex-1 はもう不要。 通常の縦スクロールページに戻す。
      className="w-full px-4"
      style={{ paddingTop: '1.5rem' }}
    >
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-black text-foreground">マイページ</h1>
          <div className="flex items-center gap-2">
            {userId && (
              <button
                onClick={() => setShowNotifications(v => !v)}
                className="relative p-2 rounded-xl bg-secondary/60 hover:bg-secondary transition-colors">
                <Bell className="w-5 h-5 text-foreground" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-destructive text-white text-[10px] font-black rounded-full flex items-center justify-center px-1">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
            )}
            {/* ★ A案: 歯車アイコンは廃止。 設定リストは MyPage 本体にインライン表示。 */}
          </div>
        </div>

        {/* お知らせパネル */}
        {showNotifications && (
          <div className="bg-card rounded-2xl border border-border mb-4 overflow-hidden"
            style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.08)' }}>
            <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
              <span className="font-black text-sm text-foreground flex items-center gap-1.5">
                <Bell className="w-4 h-4 text-primary" />お知らせ
              </span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllNotificationsRead}
                    className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:text-primary/80 transition-colors">
                    <CheckCheck className="w-3.5 h-3.5" />すべて既読
                  </button>
                )}
                <button onClick={() => setShowNotifications(false)} className="text-xs text-muted-foreground hover:text-foreground">閉じる</button>
              </div>
            </div>
            {notifications.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">お知らせはありません</p>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {notifications.slice(0, 8).map(n => {
                  const isRejected = n.type === 'store_rejected';
                  const isApproved = n.type === 'store_approved';
                  // ★ body 末尾の [bag:ID] トークンを抽出 (NotificationsBell.tsx と同じ)
                  const bagMatch = n.body?.match(/\s*\[bag:(\d+)\]\s*$/);
                  const bagId = bagMatch ? Number(bagMatch[1]) : null;
                  const cleanBody = (n.body || '').replace(/\s*\[bag:\d+\]\s*$/, '').trim();
                  // ★ 通知種別→遷移先 (NotificationsBell.tsx と一貫)
                  //   - new_bag: bag id があれば商品詳細へ、 なければホーム
                  //   - purchase_confirmed / pickup_reminder: 予約一覧 (受取コード/QR が見える)
                  const linkHref =
                    n.type === 'pickup_reminder'      ? '/my-reservations' :
                    n.type === 'purchase_confirmed'   ? '/my-reservations' :
                    n.type === 'bag_sold'             ? '/store/dashboard' :
                    n.type === 'store_approved'       ? '/store/bank-setup' :
                    n.type === 'store_rejected'       ? '/store/reapply' :
                    n.type === 'store_action_required'? '/store/dashboard' :
                    n.type === 'new_bag'              ? (bagId ? `/bags/${bagId}` : n.storeId ? `/stores/${n.storeId}` : null) :
                    null;
                  return (
                  <div key={n.id} className={`px-4 py-3 border-b border-border/30 last:border-0 ${!n.read ? 'bg-primary/[0.03]' : ''} ${isRejected ? 'bg-red-50/50' : isApproved ? 'bg-green-50/50' : ''}`}>
                    <div className="flex items-start gap-2.5">
                      {(() => {
                        switch (n.type) {
                          case 'new_bag':         return <ShoppingBag className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />;
                          case 'bag_sold':        return <Receipt className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />;
                          case 'pickup_reminder': return <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />;
                          case 'store_approved':  return <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />;
                          case 'store_rejected':  return <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />;
                          default:                return <Megaphone className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />;
                        }
                      })()}
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-bold ${isRejected ? 'text-red-700' : isApproved ? 'text-green-700' : !n.read ? 'text-foreground' : 'text-muted-foreground'}`}>{normalizeBrand(n.title)}</p>
                        <p className={`text-[11px] mt-0.5 leading-relaxed whitespace-pre-wrap ${isRejected ? 'text-red-600' : 'text-muted-foreground'}`}>{normalizeBrand(cleanBody)}</p>
                        <div className="flex items-center justify-between mt-1">
                          <p className="text-[10px] text-muted-foreground/50">
                            {new Date(n.createdAt).toLocaleDateString('ja-JP')}
                          </p>
                          {linkHref && (
                            <Link href={linkHref}>
                              <span
                                onClick={() => { if (!n.read) markNotificationRead(n.id); }}
                                className="inline-flex items-center gap-0.5 text-[11px] font-black text-primary hover:text-primary/80 transition-colors cursor-pointer">
                                詳細を見る<ChevronRight className="w-3 h-3" />
                              </span>
                            </Link>
                          )}
                        </div>
                        {isRejected && (
                          <Link href="/store/reapply">
                            <span
                              onClick={() => { if (!n.read) markNotificationRead(n.id); }}
                              className="inline-flex items-center gap-1 mt-2 text-[11px] font-black text-white bg-red-500 hover:bg-red-600 px-2.5 py-1 rounded-full transition-colors">
                              <ChevronRight className="w-3 h-3" />修正して再申請する
                            </span>
                          </Link>
                        )}
                        {isApproved && (
                          <Link href="/store/bank-setup">
                            <span
                              onClick={() => { if (!n.read) markNotificationRead(n.id); }}
                              className="inline-flex items-center gap-1 mt-2 text-[11px] font-black text-white bg-green-500 hover:bg-green-600 px-2.5 py-1 rounded-full transition-colors">
                              <ChevronRight className="w-3 h-3" />口座・本人確認を登録する
                            </span>
                          </Link>
                        )}
                      </div>
                      {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Profile Card（プレミアム） */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="relative overflow-hidden rounded-2xl p-3.5 mb-2"
          style={{
            background:
              profile?.role === 'store_owner'
                ? 'linear-gradient(135deg, #FFFBF2 0%, #FFF3DC 100%)'
                : 'linear-gradient(135deg, #FFFFFF 0%, #FFF8F4 100%)',
            boxShadow: '0 2px 12px -2px rgba(10,8,6,0.10), 0 1px 3px -1px rgba(10,8,6,0.05)',
            border: '1px solid rgba(242,100,25,0.10)',
          }}
        >
          {/* 背景装飾（淡い光） */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-8 -right-8 w-24 h-24 rounded-full"
            style={{
              background:
                profile?.role === 'store_owner'
                  ? 'radial-gradient(circle, rgba(245,158,11,0.18) 0%, transparent 70%)'
                  : 'radial-gradient(circle, rgba(242,100,25,0.14) 0%, transparent 70%)',
            }}
          />

          <div className="relative flex items-center gap-3">
            {/* アバター（光彩リング付き） */}
            <div className="relative shrink-0">
              <div
                aria-hidden
                className="absolute inset-0 rounded-full blur-md"
                style={{
                  background:
                    profile?.role === 'store_owner'
                      ? 'radial-gradient(circle, rgba(245,158,11,0.45) 0%, transparent 70%)'
                      : 'radial-gradient(circle, rgba(242,100,25,0.40) 0%, transparent 70%)',
                }}
              />
              <div
                className="relative w-12 h-12 rounded-full flex items-center justify-center text-white ring-2 ring-white shadow-md overflow-hidden"
                style={
                  // 一般ユーザがアイコン写真を設定している場合は写真背景、それ以外はグラデーション
                  profile?.role !== 'store_owner' && userAvatarUrl
                    ? undefined
                    : {
                        background:
                          profile?.role === 'store_owner'
                            ? 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)'
                            : 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(12 80% 60%) 100%)',
                      }
                }
              >
                {profile?.role === 'store_owner' ? (
                  // ★ 統一: 登録時の丸アイコン (iconUrl) があれば表示、 なければ汎用 StoreIcon
                  store?.iconUrl ? (
                    <img
                      src={store.iconUrl}
                      alt={store.name}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <StoreIcon className="w-5 h-5" strokeWidth={2.4} />
                  )
                ) : userAvatarUrl ? (
                  <img
                    src={userAvatarUrl}
                    alt="アイコン"
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <User className="w-5 h-5" strokeWidth={2.4} />
                )}
              </div>
              {user && profile?.role === 'store_owner' && isApprovedOwner && (
                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 ring-2 ring-white flex items-center justify-center">
                  <CheckCircle className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              {user ? (
                <>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h2 className="text-[16px] font-black text-foreground truncate leading-tight tracking-tight">
                      {profile?.role === 'store_owner' && store?.name
                        ? store.name
                        : profile?.display_name || user.email?.split('@')[0] || user.email}
                    </h2>
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md shrink-0 leading-none
                      ${profile?.role === 'store_owner'
                        ? 'bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/20'
                        : 'bg-primary/10 text-primary ring-1 ring-primary/15'
                      }`}>
                      {profile?.role === 'store_owner' ? '店舗オーナー' : 'メンバー'}
                    </span>
                  </div>
                  {profile?.role === 'store_owner' && store?.name ? (
                    isApprovedOwner ? (
                      <p className="text-[11px] text-green-600 font-bold mt-1 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" strokeWidth={2.5} />
                        決済連携済み・公式パートナー
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-600 font-bold mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" strokeWidth={2.5} />
                        公式パートナー（審査中）
                      </p>
                    )
                  ) : (
                    <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground">
                      <Mail className="w-3 h-3 shrink-0" />
                      <span className="truncate">{user.email}</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-[16px] font-black text-foreground leading-tight">ゲストユーザー</h2>
                  <p className="text-[12px] text-muted-foreground mt-1">
                    <Link href="/login" className="text-primary font-black underline underline-offset-2">ログイン</Link>
                    {' '}または{' '}
                    <Link href="/signup" className="text-primary font-black underline underline-offset-2">新規登録</Link>
                  </p>
                </>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── おすそわけスコア + 月間ランキング（カスタマーのみ・横並び 50/50）── */}
        {/* ★ A案 v3: スコア (左) と ランキング (右) を半分ずつのカード 2 枚に並べる。
              ・ 「食品ロス削減量」 と「今月の月間順位」 は性格が近いため隣接配置。
              ・ 各カードはほぼ同じ高さ (~118px) でビジュアル統一。 */}
        {!isStoreOwner && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-3 grid grid-cols-2 gap-2.5"
          >
            {/* ── 左: スコアカード ── */}
            <div
              className="relative overflow-hidden rounded-2xl px-3 py-3 flex flex-col justify-between"
              style={{
                background: 'linear-gradient(135deg, #FF8C00 0%, #FF6B00 60%, #E55A00 100%)',
                minHeight: '118px',
              }}
            >
              <div className="absolute -top-3 -right-3 w-14 h-14 bg-white/10 rounded-full" />
              <div className="relative">
                <p className="text-white/75 text-[10px] font-bold leading-none mb-1.5">
                  食品ロス削減量
                </p>
                <div className="flex items-end gap-1">
                  <span className="text-2xl font-black text-white leading-none">{foodSavedKg}</span>
                  <span className="text-white/90 text-xs font-bold mb-0.5">kg</span>
                </div>
              </div>
              <div className="relative flex items-center gap-2 text-white/85 text-[10px] font-bold mt-1.5">
                <span className="flex items-center gap-0.5">
                  <ShoppingBag className="w-2.5 h-2.5" />
                  {pickedUpCount}回
                </span>
                <span className="opacity-60">・</span>
                <span className="flex items-center gap-0.5">
                  <Leaf className="w-2.5 h-2.5" />
                  CO₂ {co2Saved}kg
                </span>
              </div>
              <p className="relative text-white/90 text-[11px] font-bold mt-1 truncate">
                {pickedUpCount === 0
                  ? '🌟 最初の一歩から'
                  : pickedUpCount < 5
                  ? '🌾 素敵なスタート！'
                  : pickedUpCount < 15
                  ? '🌿 街が育っています'
                  : '🏆 街の守護者'}
              </p>
              <div className="relative">
                <ImpactShareButton
                  pickedUpCount={pickedUpCount}
                  foodSavedKg={foodSavedKg}
                  co2Saved={co2Saved}
                />
              </div>
            </div>

            {/* ── 右: 月間ランキング 連動カード ──
                ★ rank=-1 は opt-out (Settings で非表示中) を意味する。 */}
            <button
              type="button"
              onClick={() => navigate('/ranking')}
              className="group bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 border border-amber-200/70 rounded-2xl px-3 py-3 flex flex-col justify-between text-left active:scale-[0.98] transition-transform shadow-sm"
              style={{ minHeight: '118px' }}
              aria-label="今月のおすそわけランキングを見る"
            >
              <div className="flex items-center gap-1.5">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-yellow-300 to-amber-500 text-white flex items-center justify-center shrink-0 shadow">
                  <Trophy className="w-3.5 h-3.5" strokeWidth={2.4} />
                </div>
                <p className="text-[10px] font-bold text-amber-700 leading-tight flex-1 min-w-0">
                  今月のランキング
                </p>
                <ChevronRight className="w-4 h-4 text-amber-600 shrink-0 group-active:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-1">
                {monthlyRanking ? (
                  monthlyRanking.optedOut ? (
                    <div className="text-[13px] font-black text-foreground leading-tight">
                      参加しよう！
                    </div>
                  ) : monthlyRanking.myRank && monthlyRanking.myRank.rank > 0 ? (
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-black text-foreground leading-none">
                        {monthlyRanking.myRank.rank}
                      </span>
                      <span className="text-xs font-bold text-muted-foreground">位</span>
                    </div>
                  ) : (
                    <div className="text-base font-black text-foreground leading-tight">
                      圏外
                    </div>
                  )
                ) : (
                  <div className="h-5 w-16 bg-amber-200/40 rounded animate-pulse" />
                )}
              </div>
              {monthlyRanking && (
                <p className="text-[10px] text-muted-foreground font-bold leading-tight mt-1 truncate">
                  {monthlyRanking.optedOut
                    ? 'タップして街への貢献を見せよう'
                    : monthlyRanking.nextRankDelta === 0
                      ? '🏆 頂点キープ中！'
                      : `あと${monthlyRanking.nextRankDelta}回でランクアップ`}
                </p>
              )}
            </button>
          </motion.div>
        )}

        {/* ── マイタウン（カスタマーのみ・インライン表示）── */}
        {/* ★ デッドスペース完全消去:
              ① flex-1 で親(MyPage コンテナ)の残スペースを全部吸収
              ② min-h の絶対安全網 — calc(100dvh - ヘッダ/プロフィール/スコア/ボトムナビ ≒ 460px)
                 で、 flex 計算が iOS Safari/PWA で空転しても確実に縦に伸びる。 dvh は
                 アドレスバー表示状態に追従するモバイル単位。 */}
        {!isStoreOwner && (
          <div className="-mx-4 mb-3">
            {/* ── マイタウン 縮小カード (タップで詳細ページへ) ─────────────
                ★ 旧フルワイドのランキングカードは スコアカード横の 50/50 配置に
                  統合済み (上の grid grid-cols-2 ブロック参照)。 ここはマイタウン
                  サムネのみ (110px、 タップで /my-town へ)。 */}
            <button
              type="button"
              onClick={() => navigate('/my-town')}
              className="mx-4 group block w-[calc(100%-2rem)] rounded-2xl overflow-hidden border border-border bg-card relative active:scale-[0.99] transition-transform"
              style={{ height: '110px', boxShadow: '0 2px 12px -2px rgba(10,8,6,0.10)' }}
              aria-label="マイタウンを大きく見る"
            >
              <div className="absolute inset-0">
                <MyTown purchaseCount={pickedUpCount} stretch />
              </div>
              {/* 下部グラデーション + ラベル (タップ可能アフォーダンス) */}
              <div
                className="absolute inset-x-0 bottom-0 px-3 py-1.5 flex items-center gap-2 text-white"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.0) 100%)' }}
              >
                <span className="text-[11px] font-black flex-1">マイタウンをもっと見る</span>
                <ChevronRight className="w-4 h-4 group-active:translate-x-0.5 transition-transform" />
              </div>
            </button>
          </div>
        )}

        {/* ── カスタマー: 設定リスト (旧モーダルをインライン化) ─────────────
            ★ A案: 歯車タップ → モーダル の動線を撤廃し、 MyTown の下に常時表示。 */}
        {!isStoreOwner && (
          <div className="space-y-3 mb-4">
            {/* 購入履歴 */}
            <div className="bg-card rounded-2xl overflow-hidden"
              style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.07)' }}>
              <Link
                href="/orders"
                className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 active:bg-secondary/70 transition-colors"
              >
                <div className="w-9 h-9 bg-primary/10 text-primary rounded-full flex items-center justify-center shrink-0">
                  <Receipt className="w-4 h-4" />
                </div>
                <div className="flex-1 font-bold text-foreground text-sm">購入履歴・領収書</div>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </Link>
            </div>

            {/* アカウント・サポート */}
            <div>
              <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">アカウント・サポート</p>
              <div className="bg-card rounded-2xl overflow-hidden"
                style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.07)' }}>
                <Link
                  href="/settings"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 active:bg-secondary/70 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-secondary text-foreground rounded-full flex items-center justify-center shrink-0">
                    <Settings className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-foreground text-sm">アカウント設定</div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/report-store"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 active:bg-secondary/70 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center shrink-0">
                    <Flag className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-foreground text-sm">気になるお店を運営に紹介する</div>
                    <div className="text-xs text-muted-foreground mt-0.5">まだ「おすそわけ」 を始めていないお店を運営にお知らせいただけます</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/usage-guide"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 active:bg-secondary/70 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                    <BookOpen className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-foreground text-sm">使い方ガイド</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">予約から受取までの流れを6ステップで</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/help"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 active:bg-secondary/70 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-secondary text-foreground rounded-full flex items-center justify-center shrink-0">
                    <HelpCircle className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-foreground text-sm">ヘルプ・お問い合わせ</div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 py-3 px-4 hover:bg-destructive/5 active:bg-destructive/10 transition-colors text-left text-destructive border-b border-border"
                >
                  <div className="w-9 h-9 bg-destructive/10 text-destructive rounded-full flex items-center justify-center shrink-0">
                    <LogOut className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-sm">ログアウト</div>
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="w-full flex items-center gap-3 py-3 px-4 hover:bg-rose-50 active:bg-rose-100 transition-colors text-left"
                >
                  <div className="w-9 h-9 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center shrink-0">
                    <Trash2 className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-sm text-rose-600">アカウントを削除する</div>
                    <div className="text-[10px] text-rose-400 mt-0.5">退会・全データを削除します</div>
                  </div>
                </button>
              </div>
            </div>

            {/* おすそわけを広める */}
            <div>
              <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">おすそわけを広める</p>
              <ShareAppCard variant="user" />
            </div>

            {/* 法的情報リンク */}
            <div className="pt-2 pb-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Link href="/tokusho" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                特定商取引法に基づく表記
              </Link>
              <span className="text-muted-foreground/30 text-xs">|</span>
              <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                利用規約
              </Link>
              <span className="text-muted-foreground/30 text-xs">|</span>
              <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                プライバシーポリシー
              </Link>
              <p className="w-full text-center text-[10px] text-muted-foreground/40 mt-1">© 2025 おすそわけ All rights reserved.</p>
            </div>
          </div>
        )}

        {/* ── 店舗オーナー：接続エラー中（リトライ待機）── */}
        {profile?.role === 'store_owner' && !loadingStore && store === null && fetchError && (
          <div className="mb-4 bg-muted/50 border border-border rounded-2xl p-5 flex items-center gap-3">
            <div className="w-8 h-8 border-[3px] border-primary border-t-transparent rounded-full animate-spin shrink-0" />
            <div>
              <p className="font-bold text-foreground text-sm">店舗情報を確認中...</p>
              <p className="text-xs text-muted-foreground mt-0.5">しばらくお待ちください</p>
            </div>
          </div>
        )}

        {/* ── 店舗オーナー：未申請バナー（store が存在しない場合のみ） ── */}
        {profile?.role === 'store_owner' && !loadingStore && store === null && !fetchError && (
          <div className="mb-4 bg-gradient-to-br from-orange-50 to-amber-50 border-2 border-primary/30 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center shrink-0">
                <FileCheck className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="font-black text-foreground text-base">店舗申請がまだ完了していません</p>
                <p className="text-xs text-muted-foreground mt-0.5">審査通過後すぐに出品できます</p>
              </div>
            </div>
            <button
              onClick={() => navigate('/store-onboarding')}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold py-3 px-4 rounded-lg shadow-md flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <FileCheck className="w-5 h-5" />
              店舗情報を登録して申請する
            </button>
          </div>
        )}

        {/* ── 店舗オーナー：振込先口座が未登録（approved + stripeAccountId なし） ── */}
        {profile?.role === 'store_owner' && !loadingStore && needsBankSetup && (
          <div className="mb-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center shrink-0">
                <CreditCard className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="font-black text-foreground text-base">振込先口座の登録が必要です</p>
                <p className="text-xs text-muted-foreground mt-0.5">売上を受け取るための口座を登録してください</p>
              </div>
            </div>
            <button
              onClick={() => navigate('/store/bank-setup')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg shadow-md flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <CreditCard className="w-5 h-5" />
              振込先口座を登録する
            </button>
          </div>
        )}

        {/* ── 店舗オーナー：口座登録済み・審査待ちバナー（applied） ── */}
        {profile?.role === 'store_owner' && !loadingStore && store?.status === 'applied' && (
          <div className="mb-4 bg-gradient-to-br from-amber-50 to-yellow-50 border-2 border-amber-300 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center shrink-0">
                <Clock className="w-6 h-6 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-foreground text-base">申請受付完了 — 審査中</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  口座・本人確認情報を受け付けました。決済システムの審査がバックグラウンドで進行中です。早ければ数時間で完了します。
                </p>
              </div>
              <span className="ml-auto text-[10px] font-black bg-amber-100 text-amber-700 px-2 py-1 rounded-full shrink-0">審査中</span>
            </div>
          </div>
        )}

        {/* ── 店舗オーナー：管理者の最終承認待ちバナー（pending_review） ── */}
        {/*    2 店舗目以降の新規追加時 = 親アカウントの Stripe を流用するが、
                住所・営業許可証の真正性を admin が目視確認するまで非公開 (出品ブロック)。 */}
        {profile?.role === 'store_owner' && !loadingStore && store?.status === 'pending_review' && (
          <div className="mb-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center shrink-0">
                <Clock className="w-6 h-6 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-foreground text-base">管理者の最終承認待ち</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  申請内容 (住所・営業許可証) を管理者が確認しています。 承認後に公開・出品が可能になります。 通常 1〜2 営業日。
                </p>
              </div>
              <span className="ml-auto text-[10px] font-black bg-blue-100 text-blue-700 px-2 py-1 rounded-full shrink-0">審査中</span>
            </div>
          </div>
        )}

        {/* ── 店舗オーナー：承認済み・Stripe連携完了（緑バッジ — ライブAPI判定） ── */}
        {/* ★ レイアウトシフト対策:
              - 承認済みオーナー (大半のユーザ) は緑バナーが最終形 = 36px。
              - loadingStore (=useMyStore 解決前) は role だけで判定して同じ
                36px の緑「確認中…」プレースホルダを先出ししておく。
                こうすれば 「ヘッダ → 何もない → 突然バナー出現」 の段差が消える。
              - min-h は 36px のみ。ここを大きくすると下に空白ができて見栄えが悪い (旧版バグ)。
              - amber/red の昇格時はコンテンツ自体が増えるため、 そのケースだけは
                許容の押下げが起きる。 大半のユーザには無関係。 */}
        {profile?.role === 'store_owner' && (loadingStore || isApprovedOwner) && (
          <div className="mb-3 min-h-[36px]">{(() => {
          if (loadingStore) {
            // ストア情報取得中もバナーの場所を確保。承認状態が分かるまで「確認中」を表示。
            return (
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2">
                <FileCheck className="w-4 h-4 text-green-600 shrink-0" />
                <p className="text-xs font-black text-green-800 flex-1">✅ 公式アカウント認証済み・出品可能</p>
                <span className="text-[9px] font-black bg-green-200 text-green-800 px-2 py-0.5 rounded-full shrink-0">確認中…</span>
              </div>
            );
          }
          const payoutsOk  = stripeStatus?.payoutsEnabled;
          const chargesOk  = stripeStatus?.chargesEnabled;
          // ★ stripeStatus が null/undefined（取得失敗 or fetch 未完了）は「確認中」扱い。
          //   以前は null → loaded 扱いでフォールスルー → 誤って RED「再連携が必要」を表示していた。
          const isLoaded   = stripeStatus != null;
          if (!isLoaded) return (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2">
              <FileCheck className="w-4 h-4 text-green-600 shrink-0" />
              <p className="text-xs font-black text-green-800 flex-1">✅ 公式アカウント認証済み・出品可能</p>
              <span className="text-[9px] font-black bg-green-200 text-green-800 px-2 py-0.5 rounded-full shrink-0">確認中…</span>
            </div>
          );
          if (payoutsOk && chargesOk) return (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2">
              <FileCheck className="w-4 h-4 text-green-600 shrink-0" />
              <p className="text-xs font-black text-green-800 flex-1">✅ 公式アカウント認証済み・出品可能</p>
              <span className="text-[9px] font-black bg-green-200 text-green-800 px-2 py-0.5 rounded-full shrink-0">有効</span>
            </div>
          );
          if (chargesOk && !payoutsOk) {
            // pending_verification に書類が含まれていれば審査中 → ボタン不要
            const pending = stripeStatus?.requirements?.pendingVerification ?? [];
            const docUnderReview = pending.some(k =>
              k.includes('verification') || k.includes('document') || k.includes('individual')
            );
            return (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <p className="text-xs font-black text-amber-800 flex-1">⚠️ 決済受付中・入金一時停止</p>
                  <span className="text-[9px] font-black bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full shrink-0">入金停止</span>
                </div>
                {docUnderReview ? (
                  <>
                    <p className="text-[10px] text-amber-700 leading-snug">
                      本人確認書類はStripeに提出済みです。審査完了後（通常1〜3営業日）に入金が再開されます。
                    </p>
                    <div className="flex items-center gap-1.5 bg-amber-100 rounded-lg px-2 py-1.5">
                      <span className="text-amber-600 text-sm">🔄</span>
                      <p className="text-[10px] font-black text-amber-800">書類審査中です。しばらくお待ちください。</p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] text-amber-700 leading-snug">Stripeより本人確認書類の提出が必要です。このまま放置すると決済も停止されます。</p>
                    <button
                      onClick={() => navigate('/store/bank-setup')}
                      className="w-full py-1.5 text-[11px] font-black bg-amber-600 text-white rounded-lg"
                    >
                      本人確認書類を提出する →
                    </button>
                  </>
                )}
              </div>
            );
          }
          // ★ RED は chargesEnabled が **明示的に false** の時だけ出す。
          //   undefined（取得失敗 fallback で {chargesEnabled: undefined} になり得るケース）や
          //   {connected:true, chargesEnabled:false, payoutsEnabled:false} の API fallback 等で
          //   誤って「再連携が必要」と表示されるのを防ぐ（タップスバーガー等の誤警告対策）。
          if (chargesOk === false) return (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <p className="text-xs font-black text-red-800 flex-1">❌ 決済口座の再連携が必要です</p>
                <span className="text-[9px] font-black bg-red-200 text-red-800 px-2 py-0.5 rounded-full shrink-0">要再連携</span>
              </div>
              <p className="text-[10px] text-red-700 leading-snug">
                登録済みの決済アカウントにアクセスできません。口座情報を再度登録してください。
              </p>
              <button
                onClick={async () => {
                  if (!storeId) return;
                  // ★ Capacitor (iOS) では VITE_API_BASE が必須。 同ページ上部の BASE_URL 定義
                  //   と同じパターンに揃える ( import.meta.env.BASE_URL だけだと iOS で空になり
                  //   /api/... が WebView 自身に向かい 404)。
                  await authedFetch(`${BASE_URL}/api/stores/${storeId}/stripe-disconnect`, { method: 'POST' });
                  navigate('/store/bank-setup');
                }}
                className="w-full py-1.5 text-[11px] font-black bg-red-600 text-white rounded-lg"
              >
                口座を再連携する →
              </button>
            </div>
          );
          // それ以外（chargesEnabled が undefined 等）は安全側で「確認中」表示
          return (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2">
              <FileCheck className="w-4 h-4 text-green-600 shrink-0" />
              <p className="text-xs font-black text-green-800 flex-1">✅ 公式アカウント認証済み・出品可能</p>
              <span className="text-[9px] font-black bg-green-200 text-green-800 px-2 py-0.5 rounded-full shrink-0">確認中…</span>
            </div>
          );
        })()}</div>
        )}

        {/* ── 神モード（管理者専用） ── */}
        {isAdmin && (
          <Link
            href="/admin"
            className="flex items-center gap-3 mb-3 rounded-2xl px-4 py-3 overflow-hidden relative
              bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600
              shadow-[0_4px_20px_rgba(124,58,237,0.40)]
              hover:shadow-[0_6px_24px_rgba(124,58,237,0.55)] hover:-translate-y-0.5
              tap-scale transition-all duration-200"
          >
            <div className="absolute inset-0 opacity-20 pointer-events-none"
              style={{ backgroundImage: 'radial-gradient(circle at 20% 50%, white 0%, transparent 60%)' }} />
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center shrink-0 backdrop-blur-sm border border-white/30">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <div className="font-black text-white text-sm leading-tight">⚡️ 神モード</div>
              <div className="text-white/70 text-[11px] mt-0.5">管理者ダッシュボード</div>
            </div>
            <ChevronRight className="w-4 h-4 text-white/60" />
          </Link>
        )}

        {/* ── 店舗オーナー：設定コンテンツをインライン表示 ── */}
        {isStoreOwner && (
          <div className="mt-4 space-y-3">

            {/* ── 所有店舗一覧（多店舗対応） ── */}
            {stores.length > 0 && (
              <div>
                <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">所有店舗</p>
                <div className="space-y-2">
                  {stores.map(s => {
                    // ★ 「公開中」バッジは Stripe 連携が完全に成立してから表示する
                    //   stripeAccountId が無い / chargesEnabled が true でない / payoutsEnabled が true でない場合は「セットアップ未完了」
                    const stripeFullyReady =
                      !!s.stripeAccountId &&
                      s.stripeChargesEnabled === true &&
                      s.stripePayoutsEnabled === true;
                    const statusMap: Record<string, { label: string; cls: string }> = {
                      approved:      !s.stripeAccountId
                        ? { label: 'セットアップ未完了', cls: 'bg-orange-100 text-orange-700' }
                        : s.stripeChargesEnabled === false
                          ? { label: '決済停止中', cls: 'bg-red-100 text-red-700' }
                          : s.stripePayoutsEnabled === false
                            ? { label: '入金停止中', cls: 'bg-amber-100 text-amber-800' }
                            : stripeFullyReady
                              ? { label: '公開中',     cls: 'bg-emerald-100 text-emerald-700' }
                              : { label: '審査中',     cls: 'bg-blue-100 text-blue-700' },
                      pending_review:{ label: '確認中',         cls: 'bg-amber-100 text-amber-700' },
                      applied:       { label: '口座登録済み', cls: 'bg-blue-100 text-blue-700' },
                      rejected:      { label: '却下',         cls: 'bg-red-100 text-red-700' },
                      pending:       s.stripeAccountId
                        ? { label: '本人確認が必要', cls: 'bg-amber-100 text-amber-700' }
                        : { label: 'セットアップ未完了', cls: 'bg-orange-100 text-orange-700' },
                    };
                    const st = statusMap[s.status] ?? { label: s.status, cls: 'bg-gray-100 text-gray-600' };
                    const isSelected = s.id === selectedStoreId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedStoreId(s.id)}
                        className={`w-full text-left rounded-2xl overflow-hidden flex items-center gap-3 px-4 py-3 transition-all active:scale-[0.98] ${
                          isSelected
                            ? 'bg-orange-50 border-2 border-orange-400'
                            : 'bg-card border-2 border-transparent hover:border-orange-200'
                        }`}
                        style={!isSelected ? { boxShadow: '0 2px 8px -1px rgba(10,8,6,0.07)' } : undefined}
                      >
                        <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 relative bg-orange-100 flex items-center justify-center">
                          {/* ★ 統一: 店舗写真 (imageUrl) ではなく登録時の丸アイコン (iconUrl) を表示 */}
                          {s.iconUrl
                            ? <img loading="lazy" decoding="async" src={s.iconUrl} alt={s.name} className="w-full h-full object-cover" />
                            : <StoreIcon className="w-5 h-5 text-orange-400" />
                          }
                          {isSelected && (
                            <div className="absolute inset-0 bg-orange-500/20 flex items-center justify-center">
                              <CheckCircle className="w-4 h-4 text-orange-600" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`font-bold text-sm truncate ${isSelected ? 'text-orange-700' : 'text-foreground'}`}>{s.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{s.address}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {isSelected && (
                            <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-orange-500 text-white">操作中</span>
                          )}
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                        </div>
                      </button>
                    );
                  })}
                  {/* 追加ボタン */}
                  <button
                    onClick={() => navigate('/store-onboarding?add=1')}
                    className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-orange-300 text-orange-500 font-bold text-sm py-3 rounded-2xl hover:bg-orange-50 active:scale-98 transition-all"
                  >
                    <StoreIcon className="w-4 h-4" />
                    新しい店舗を追加登録する
                  </button>
                </div>
              </div>
            )}

            {/* 店舗管理 */}
            <div>
              <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">店舗管理</p>
              <div className="bg-card rounded-2xl overflow-hidden"
                style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.07)' }}>
                {store?.status === 'pending' && (
                  <Link
                    href="/store/bank-setup"
                    className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border last:border-0"
                  >
                    <div className="w-9 h-9 bg-orange-100 text-orange-500 rounded-full flex items-center justify-center shrink-0">
                      <CreditCard className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-foreground text-sm">
                        {store?.stripeAccountId ? '本人確認書類の提出が必要です' : '口座・本人確認の登録が必要です'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {store?.stripeAccountId ? '口座は登録済みです。本人確認書類をご提出ください' : '振込先口座と本人確認の登録が必要です'}
                      </div>
                    </div>
                    <span className="text-[10px] font-black bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full">未完了</span>
                  </Link>
                )}
                {(store?.status === 'pending_review' || store?.status === 'applied') && (
                  <Link
                    href="/store-dashboard"
                    className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border last:border-0"
                  >
                    <div className="w-9 h-9 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center shrink-0">
                      <Clock className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-foreground text-sm">
                        {store?.status === 'applied' ? '決済の本人確認 — 審査中' : '確認中'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {store?.status === 'applied'
                          ? '早ければ数時間で完了します'
                          : '運営スタッフが確認中です'}
                      </div>
                    </div>
                    <span className="text-[10px] font-black bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full">審査中</span>
                  </Link>
                )}
                {store?.status === 'rejected' && (
                  <Link
                    href="/store/reapply"
                    className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border last:border-0"
                  >
                    <div className="w-9 h-9 bg-red-100 text-red-500 rounded-full flex items-center justify-center shrink-0">
                      <XCircle className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-foreground text-sm">店舗申請が却下されました</div>
                      <div className="text-xs text-muted-foreground">
                        {store.rejectionReason
                          ? `理由：${store.rejectionReason.slice(0, 30)}${store.rejectionReason.length > 30 ? '…' : ''}`
                          : '店舗情報を修正して再申請する'}
                      </div>
                    </div>
                    <span className="text-[10px] font-black bg-red-100 text-red-500 px-2 py-0.5 rounded-full">再申請</span>
                  </Link>
                )}
                {isApprovedOwner && (
                  <Link
                    href="/store/profile-edit"
                    className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border"
                  >
                    <div className="w-9 h-9 bg-orange-100 text-orange-500 rounded-full flex items-center justify-center shrink-0">
                      <Camera className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-foreground text-sm">店舗プロフィール編集</div>
                      <div className="text-xs text-muted-foreground">カバー写真・紹介文・営業時間など</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </Link>
                )}
                {isApprovedOwner && (
                  <Link
                    href="/store/reviews"
                    className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors"
                  >
                    <div className="w-9 h-9 bg-amber-100 text-amber-500 rounded-full flex items-center justify-center shrink-0">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-foreground text-sm">お客様からのレビュー</div>
                      <div className="text-xs text-muted-foreground">レビュー確認・返信管理</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </Link>
                )}
              </div>
            </div>

            {/* アカウント・サポート */}
            <div>
              <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">アカウント・サポート</p>
              <div className="bg-card rounded-2xl overflow-hidden"
                style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.07)' }}>
                <Link
                  href="/report-store"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center shrink-0">
                    <Flag className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-foreground text-sm">気になるお店を運営に紹介する</div>
                    <div className="text-xs text-muted-foreground">まだ「おすそわけ」 を始めていないお店を運営にお知らせいただけます</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/usage-guide?mode=store"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                    <BookOpen className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-foreground text-sm">使い方ガイド</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">出品から売上確認までを6ステップで</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/help"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-secondary text-foreground rounded-full flex items-center justify-center shrink-0">
                    <HelpCircle className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-foreground text-sm">ヘルプ・お問い合わせ</div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/settings"
                  className="flex items-center gap-3 py-3 px-4 hover:bg-secondary/50 transition-colors border-b border-border"
                >
                  <div className="w-9 h-9 bg-secondary text-foreground rounded-full flex items-center justify-center shrink-0">
                    <Settings className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-foreground text-sm">アカウント設定</div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </Link>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 py-3 px-4 hover:bg-destructive/5 transition-colors text-left text-destructive border-b border-border"
                >
                  <div className="w-9 h-9 bg-destructive/10 text-destructive rounded-full flex items-center justify-center shrink-0">
                    <LogOut className="w-4 h-4" />
                  </div>
                  <div className="flex-1 font-bold text-sm">ログアウト</div>
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="w-full flex items-center gap-3 py-3 px-4 hover:bg-rose-50 transition-colors text-left"
                >
                  <div className="w-9 h-9 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center shrink-0">
                    <Trash2 className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-bold text-sm text-rose-600">アカウントを削除する</div>
                    <div className="text-[10px] text-rose-400 mt-0.5">全データが削除されます</div>
                  </div>
                </button>
              </div>
            </div>

            {/* おすそわけを広める */}
            <div>
              <p className="text-[11px] font-black text-muted-foreground uppercase tracking-wider mb-1.5 px-1">おすそわけを広める</p>
              <ShareAppCard variant="store" />
            </div>

            {/* 法的情報リンク */}
            <div className="pt-2 pb-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Link href="/tokusho" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                特定商取引法に基づく表記
              </Link>
              <span className="text-muted-foreground/30 text-xs">|</span>
              <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                利用規約
              </Link>
              <span className="text-muted-foreground/30 text-xs">|</span>
              <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                プライバシーポリシー
              </Link>
              <p className="w-full text-center text-[10px] text-muted-foreground/40 mt-1">© 2025 おすそわけ All rights reserved.</p>
            </div>

          </div>
        )}

      </div>
  );

  // ★ A案: 旧 settingsSheet (フルスクリーンモーダル) は廃止。
  //   設定リストは MyPage 本体に直接インライン表示する (上部の `!isStoreOwner` ブロック内)。

  // 退会(アカウント削除) は共通モーダル DeleteAccountModal を使用。
  // - 一般ユーザ: 「退会する」 入力 + 削除ボタン
  // - 店舗オーナー: 「退会する」 入力 + 「最終確認」 フェーズ (誤操作防止)
  const deleteConfirmModal = (
    <AnimatePresence>
      {showDeleteConfirm && (
        <DeleteAccountModal
          onClose={() => !deletingAccount && setShowDeleteConfirm(false)}
          onConfirm={handleDeleteAccount}
          deleting={deletingAccount}
          isStoreOwner={isStoreOwner}
        />
      )}
    </AnimatePresence>
  );

  return (
    <>
      <Layout>{pageContent}</Layout>
      {deleteConfirmModal}
    </>
  );
}
