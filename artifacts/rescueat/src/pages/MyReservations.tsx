import React, { useState, useEffect } from 'react';
import { Layout } from '@/components/Layout';
import { StoreLayout } from '@/components/StoreLayout';
import { useUserId } from '@/hooks/use-user';
import { useAuth } from '@/contexts/AuthContext';
import { useListReservations, useCancelReservation, getListReservationsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format, parseISO, isToday, isYesterday } from 'date-fns';
import { formatPickupTime, effectivePickupDate } from '@/lib/utils';
import { ja } from 'date-fns/locale';
import { Ticket, Clock, Star, PenLine, X, CheckCircle2, CreditCard, Ban, Trash2, Package, AlertCircle, RefreshCcw } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { ReviewModal } from '@/components/ReviewModal';
import type { ReviewTarget } from '@/components/ReviewModal';

function isPickupExpired(pickupEnd?: string | null, createdAt?: string): boolean {
  if (!pickupEnd) {
    // pickupEnd 不明なら createdAt の翌日 0時を期限とみなす（保険）
    if (!createdAt) return false;
    const created = new Date(createdAt);
    const fallback = new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1, 0, 0, 0);
    return new Date() > fallback;
  }
  const now = new Date();
  const [hStr, mStr] = pickupEnd.split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  if (isNaN(h) || isNaN(m)) return false;

  // 基準日 = createdAt の "日付" (なければ今日)。
  //   例: 22:26 に予約 → base=その日 → pickupEnd="01:00" は翌日深夜1時として解釈する。
  //   従来は「createdAt と今日が違ったら問答無用で期限切れ」だったので、
  //   日跨ぎ営業 (例 22:26〜01:00) で深夜0時を過ぎた瞬間に期限切れ扱いされていた。
  const base = createdAt ? new Date(createdAt) : now;
  let end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0);
  // ★ pickupEnd が createdAt より時刻的に早い場合のみ「日跨ぎ営業」と解釈し +24h。
  //   例: 22:26 予約 → pickupEnd 01:00 → 翌日扱い ✅
  //   例: 00:39 予約 → pickupEnd 03:00 → 同日扱い (旧ロジックは深夜=翌日にして
  //       3:00 を過ぎても期限切れにならないバグだった)
  if (end.getTime() <= base.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return now > end;
}

function dateLabel(dateStr: string): string {
  const d = parseISO(dateStr);
  if (isToday(d))     return '今日';
  if (isYesterday(d)) return '昨日';
  return format(d, 'M月d日（E）', { locale: ja });
}

export default function MyReservations() {
  const userId    = useUserId();
  const { profile } = useAuth();
  const { toast } = useToast();
  const { data: reservations, isLoading } = useListReservations(
    { userId: userId || '' },
    { query: {
      queryKey: getListReservationsQueryKey({ userId: userId || '' }),
      enabled: !!userId, refetchOnMount: 'always', staleTime: 0,
    } },
  );

  const cancelMutation = useCancelReservation();
  const queryClient    = useQueryClient();
  const [, navigate]   = useLocation();

  const [reviewTarget,  setReviewTarget]  = useState<ReviewTarget | null>(null);
  const [reviewedIds,   setReviewedIds]   = useState<Set<number>>(new Set());
  // dismiss は「自分の一覧から非表示にしたい」操作。サーバー側の予約状態は変えない
  // (受取期限切れの paid 予約を cancel API に流すと在庫が誤復元される事故になる)。
  // localStorage にユーザー単位で永続化し、リロードしても消えない動作を再現する。
  const dismissedKey = userId ? `osusowake.dismissedReservations.${userId}` : null;
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() => {
    if (typeof window === 'undefined' || !dismissedKey) return new Set();
    try {
      const raw = window.localStorage.getItem(dismissedKey);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((n): n is number => typeof n === 'number')) : new Set();
    } catch {
      return new Set();
    }
  });
  // userId が後から確定 / 切り替わるケースに対応してロードしなおす。
  // ★ 重要: ユーザーA→Bのログイン切替時に A の dismissedIds が残留しないよう、
  //   キーが変わったら必ず空に戻す → そのうえで B のキーがあれば上書き読み込み。
  useEffect(() => {
    if (typeof window === 'undefined') {
      setDismissedIds(new Set());
      return;
    }
    if (!dismissedKey) {
      setDismissedIds(new Set());
      return;
    }
    let next = new Set<number>();
    try {
      const raw = window.localStorage.getItem(dismissedKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          next = new Set(arr.filter((n): n is number => typeof n === 'number'));
        }
      }
    } catch {
      next = new Set();
    }
    setDismissedIds(next);
  }, [dismissedKey]);
  // confirmAction: モーダル用統合 state。
  //   mode='dismiss' = 期限切れ予約を一覧から消す (履歴削除)
  //   mode='cancel'  = 未払い予約を本キャンセル (Stripe PI も cancel される)
  const [confirmAction, setConfirmAction] = useState<{ id: number; mode: 'dismiss' | 'cancel' } | null>(null);
  const [cancelling,    setCancelling]    = useState(false);

  const isStoreOwner  = profile?.role === 'store_owner';
  const PageWrapper   = isStoreOwner ? StoreLayout : Layout;
  const wrapperProps  = isStoreOwner ? { showHeader: false } : {};

  type StatusCfg = {
    label: string;
    icon: React.ReactNode;
    badge: string;
    bar: string;
  };

  const statusConfig = (status: string, expired = false): StatusCfg => {
    if (status === 'pending' && expired) return {
      label: '期限切れ', icon: <AlertCircle className="w-3 h-3" />,
      badge: 'bg-slate-100 text-slate-500 border border-slate-200',
      bar: 'bg-slate-300',
    };
    if (status === 'confirmed' && expired) return {
      label: '受取期限切れ', icon: <AlertCircle className="w-3 h-3" />,
      badge: 'bg-slate-100 text-slate-500 border border-slate-200',
      bar: 'bg-slate-300',
    };
    switch (status) {
      case 'confirmed': return {
        label: '予約確定', icon: <CheckCircle2 className="w-3 h-3" />,
        badge: 'bg-primary/10 text-primary border border-primary/25',
        bar: 'bg-primary',
      };
      case 'picked_up': return {
        label: '受取完了', icon: <CheckCircle2 className="w-3 h-3" />,
        badge: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
        bar: 'bg-emerald-400',
      };
      case 'cancelled': return {
        label: 'キャンセル', icon: <Ban className="w-3 h-3" />,
        badge: 'bg-red-50 text-red-500 border border-red-200',
        bar: 'bg-red-300',
      };
      default: return {
        label: '未払い', icon: <CreditCard className="w-3 h-3" />,
        badge: 'bg-amber-50 text-amber-700 border border-amber-300',
        bar: 'bg-amber-400',
      };
    }
  };

  async function handleConfirmAction() {
    if (!confirmAction) return;
    const { id, mode } = confirmAction;
    setCancelling(true);
    try {
      if (mode === 'cancel') {
        // 未払い予約のみ本キャンセル。 サーバー側で status='cancelled' + Stripe PI cancel。
        // (受取期限切れ paid 予約に対してこれを呼ぶと在庫が誤復元されるため、
        //  paid 済み予約は dismiss モードでクライアント側非表示のみに限定する。)
        await cancelMutation.mutateAsync({ reservationId: id });
        if (userId) {
          queryClient.invalidateQueries({ queryKey: getListReservationsQueryKey({ userId }) });
        }
      }
      // どちらのモードでもクライアント側で非表示にする (dismiss は localStorage に永続化)
      setDismissedIds(prev => {
        const next = new Set([...prev, id]);
        if (typeof window !== 'undefined' && dismissedKey) {
          try { window.localStorage.setItem(dismissedKey, JSON.stringify([...next])); } catch { /* noop */ }
        }
        return next;
      });
      setConfirmAction(null);
      toast({
        title: mode === 'cancel' ? '予約をキャンセルしました' : '履歴を削除しました',
      });
    } catch {
      toast({
        title: mode === 'cancel' ? 'キャンセルに失敗しました' : '削除に失敗しました',
        variant: 'destructive',
      });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <PageWrapper {...wrapperProps as any}>
      {/* レビューモーダル */}
      <AnimatePresence>
        {reviewTarget && userId && (
          <ReviewModal
            reservation={reviewTarget}
            userId={userId}
            onClose={() => setReviewTarget(null)}
            onSuccess={() => setReviewedIds(prev => new Set([...prev, reviewTarget.id]))}
          />
        )}
      </AnimatePresence>

      {/* 確認ダイアログ (履歴削除 / 予約キャンセル 共通)
          ★ 重要: BottomNav が z-50 で fixed 配置されているため、 モーダルも z-50 だと
              DOM 順で後勝ちで BottomNav に下部ボタンが隠される。 z-[100] に引き上げて
              確実に最前面 (BottomNav の上) に重ねる。 */}
      <AnimatePresence>
        {confirmAction !== null && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm px-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !cancelling && setConfirmAction(null)}
            style={{
              // iPhone ホームインジケータ + BottomNav 高さぶんの逃がし。
              // sm 以上は items-center で中央寄せなので無害。
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 88px)',
              paddingTop: 'env(safe-area-inset-top)',
            }}
          >
            <motion.div
              className="bg-card rounded-3xl shadow-2xl w-full max-w-sm md:max-w-2xl p-6 pb-8 max-h-[80vh] overflow-y-auto overscroll-contain"
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center gap-3 mb-6">
                <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                  {confirmAction.mode === 'cancel'
                    ? <Ban className="w-7 h-7 text-red-500" />
                    : <Trash2 className="w-7 h-7 text-red-500" />}
                </div>
                <h2 className="text-lg font-black text-foreground">
                  {confirmAction.mode === 'cancel'
                    ? 'この予約をキャンセルしますか？'
                    : 'この履歴を削除しますか？'}
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {confirmAction.mode === 'cancel'
                    ? <>未払いの予約をキャンセルします。<br />この操作は取り消せません。</>
                    : <>受取期限が切れた予約をリストから削除します。<br />この操作は取り消せません。</>}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmAction(null)}
                  disabled={cancelling}
                  className="flex-1 py-3 rounded-2xl border border-border font-bold text-sm text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  戻る
                </button>
                <button
                  onClick={handleConfirmAction}
                  disabled={cancelling}
                  className="flex-1 py-3 rounded-2xl bg-red-500 text-white font-bold text-sm hover:bg-red-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {cancelling
                    ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        {confirmAction.mode === 'cancel' ? 'キャンセル中…' : '削除中…'}</>
                    : confirmAction.mode === 'cancel'
                      ? <><Ban className="w-4 h-4" />キャンセルする</>
                      : <><Trash2 className="w-4 h-4" />削除する</>
                  }
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── ページ本体 ── */}
      <div
        className="w-full overflow-x-hidden flex-1 flex flex-col"
        style={{ paddingTop: isStoreOwner ? 'calc(env(safe-area-inset-top) + 1.25rem)' : '1.25rem' }}
      >
        <h1 className="text-xl font-display font-bold text-foreground mb-4 px-4">マイバック</h1>

        {/* userId が null (Supabase Auth セッション解決前) の間は query が enabled:false で
            isLoading=false になるため、 そのまま render すると一瞬「まだ購入履歴がありません」が
            出てしまう。 userId 未確定の間もスケルトンを出して空状態のチラつきを防ぐ。 */}
        {(isLoading || userId === null) ? (
          <div className="divide-y divide-border/40">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="px-4 py-3.5 flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-muted animate-pulse shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="h-3 bg-muted rounded animate-pulse w-3/4" />
                  <div className="h-2.5 bg-muted rounded animate-pulse w-1/2" />
                  <div className="h-2 bg-muted rounded animate-pulse w-1/3" />
                </div>
                <div className="w-12 h-5 bg-muted rounded animate-pulse shrink-0" />
              </div>
            ))}
          </div>
        ) : (() => {
          const sorted = [...(reservations ?? [])]
            .filter(r => {
              if (dismissedIds.has(r.id)) return false;
              if (r.status === 'cancelled')   return false;
              return true;
            })
            // 新しい順（降順）
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

          if (sorted.length === 0) {
            return (
              <div className="flex-1 flex items-center justify-center px-4 pb-4">
                <div className="w-full text-center py-12 bg-card border border-border border-dashed rounded-3xl">
                  <Package className="w-14 h-14 text-muted-foreground mx-auto mb-4 opacity-40" />
                  <h2 className="text-base font-bold text-foreground mb-2">まだ購入履歴がありません</h2>
                  <p className="text-muted-foreground mb-6 text-sm">
                    気になるおすそわけバッグを見つけて、<br />フードロス削減に貢献しましょう！
                  </p>
                  <Link href="/">
                    <span className="bg-primary text-primary-foreground font-bold px-6 py-2.5 rounded-full shadow-md shadow-primary/20 inline-block cursor-pointer text-sm">
                      バッグを探す
                    </span>
                  </Link>
                </div>
              </div>
            );
          }

          // 日付ごとにグルーピング
          const groups: { label: string; items: typeof sorted }[] = [];
          for (const res of sorted) {
            const label = dateLabel(res.createdAt);
            const last  = groups[groups.length - 1];
            if (last && last.label === label) {
              last.items.push(res);
            } else {
              groups.push({ label, items: [res] });
            }
          }

          return (
            <div>
              {groups.map(group => (
                <div key={group.label}>
                  {/* 日付ヘッダー */}
                  <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
                    <span className="text-[11px] font-bold text-muted-foreground tracking-wide">{group.label}</span>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>

                  <AnimatePresence mode="popLayout">
                    <div className="divide-y divide-border/30">
                      {group.items.map((res, i) => {
                        const expired         = isPickupExpired(res.bag?.pickupEnd, res.createdAt);
                        const cfg             = statusConfig(res.status, expired);
                        const alreadyReviewed = (res as any).hasReview || reviewedIds.has(res.id);
                        const isFaded         = res.status === 'picked_up' || ((res.status === 'pending' || res.status === 'confirmed') && expired);
                        const showDismiss     = (res.status === 'pending' || res.status === 'confirmed') && expired;
                        const storeId         = res.storeId ?? res.store?.id;

                        return (
                          <motion.div
                            key={res.id}
                            layout
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: isFaded ? 0.78 : 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                            transition={{ delay: i * 0.04 }}
                            className="relative bg-card overflow-hidden"
                          >
                            {/* 左アクセントバー */}
                            <div className={`absolute left-0 top-0 bottom-0 w-1 ${cfg.bar}`} />

                            {/* カード本体 */}
                            <div className="pl-5 pr-4 py-3.5 flex items-start gap-3">

                              {/* 店舗画像 */}
                              <Link href={`/stores/${storeId}`} className="shrink-0">
                                {(res.store?.iconUrl || res.store?.imageUrl) ? (
                                  <img
                                    src={res.store.iconUrl || res.store.imageUrl}
                                    alt={res.store?.name ?? ''}
                                    loading="lazy"
                                    decoding="async"
                                    className={`w-11 h-11 rounded-xl object-cover active:scale-95 transition-transform ${isFaded ? 'grayscale opacity-60' : ''}`}
                                  />
                                ) : (
                                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg ${isFaded ? 'bg-slate-100' : 'bg-primary/10'}`}>
                                    🛍️
                                  </div>
                                )}
                              </Link>

                              {/* 左カラム：テキスト情報（flex-1 + min-w-0 で絶対に溢れない） */}
                              <div className="flex-1 min-w-0 overflow-hidden">

                                {/* 店舗名 */}
                                <p className={`text-[11px] font-semibold truncate leading-tight mb-0.5 ${isFaded ? 'text-muted-foreground/60' : 'text-foreground/60'}`}>
                                  {res.store?.name ?? '—'}
                                </p>

                                {/* 商品名＋数量 */}
                                <p className={`text-[13px] font-black leading-snug truncate ${isFaded ? 'text-muted-foreground' : 'text-foreground'}`}>
                                  {res.bag?.title ?? '—'}
                                  <span className={`text-[11px] font-semibold ml-1 ${isFaded ? 'text-muted-foreground/60' : 'text-foreground/50'}`}>
                                    ×{res.quantity}
                                  </span>
                                </p>

                                {/* 受取時間帯 */}
                                {(res.bag?.pickupStart || res.bag?.pickupEnd) && (
                                  <p className="text-[10px] text-muted-foreground/60 mt-0.5 flex items-center gap-0.5">
                                    <Clock className="w-2.5 h-2.5 shrink-0" />
                                    <span className="truncate">{formatPickupTime(res.bag.pickupStart, res.bag.pickupEnd, effectivePickupDate((res.bag as { createdAt?: string }).createdAt, (res.bag as { pickupNextDay?: boolean }).pickupNextDay) ?? res.createdAt)}</span>
                                  </p>
                                )}

                                {/* 購入時刻 */}
                                <p className="text-[10px] text-muted-foreground/50 mt-0.5 tabular-nums">
                                  {format(parseISO(res.createdAt), 'HH:mm')}
                                </p>

                                {/* アクションボタン */}
                                {((res.status === 'confirmed' && !expired) || (res.status === 'pending' && !expired) || res.status === 'picked_up' || showDismiss) && (
                                  <div className="flex items-center flex-wrap gap-2 mt-2">
                                    {res.status === 'confirmed' && !expired && (
                                      // ★ iOS WebView でも確実にタップが拾われるよう <button> + onClick で実装
                                      // （以前は <Link> + <span> だったが、稀にタップが拾われない事象あり）
                                      <button
                                        type="button"
                                        onClick={() => navigate(`/orders/${res.id}`)}
                                        className="inline-flex items-center gap-1.5 bg-primary text-white text-[11px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap shadow-sm shadow-primary/20 active:scale-95 transition-transform"
                                      >
                                        <Ticket className="w-3 h-3" />
                                        チケットを表示
                                      </button>
                                    )}
                                    {res.status === 'pending' && !expired && (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => navigate(`/checkout/${res.id}`, { state: { from: '/my-reservations' } })}
                                          className="inline-flex items-center gap-1.5 bg-amber-500 text-white text-[11px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap shadow-sm shadow-amber-300/30 active:scale-95 transition-transform"
                                        >
                                          <CreditCard className="w-3 h-3" />
                                          決済する
                                        </button>
                                        {/* キャンセルボタン: 決済画面で離脱した未払い予約をユーザ自身で取り消せるようにする */}
                                        <button
                                          type="button"
                                          onClick={() => setConfirmAction({ id: res.id, mode: 'cancel' })}
                                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-red-500 px-2 py-1.5 rounded-lg hover:bg-red-50 transition-colors"
                                        >
                                          <Ban className="w-3 h-3" />
                                          キャンセル
                                        </button>
                                      </>
                                    )}
                                    {res.status === 'picked_up' && (
                                      alreadyReviewed ? (
                                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-500">
                                          <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                                          口コミ投稿済
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setReviewTarget({ id: res.id, storeId: storeId ?? 0, store: res.store })}
                                          className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-300 text-amber-700 text-[11px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap active:scale-95 transition-transform"
                                        >
                                          <PenLine className="w-3 h-3" />
                                          口コミを書く
                                        </button>
                                      )
                                    )}
                                    {showDismiss && (
                                      <>
                                        {/* 再購入ボタン */}
                                        {(res.bag?.id ?? res.bagId) && (
                                          <Link href={`/bags/${res.bag?.id ?? res.bagId}`}>
                                            <span className="inline-flex items-center gap-1.5 bg-primary text-white text-[11px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap shadow-sm shadow-primary/20 active:scale-95 transition-transform cursor-pointer">
                                              <RefreshCcw className="w-3 h-3" />
                                              再購入する
                                            </span>
                                          </Link>
                                        )}
                                        {/* 削除ボタン */}
                                        <button
                                          type="button"
                                          onClick={() => setConfirmAction({ id: res.id, mode: 'dismiss' })}
                                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors"
                                        >
                                          <X className="w-3 h-3" />
                                          削除
                                        </button>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* 右カラム：ステータス＋価格（shrink-0 で圧縮されない） */}
                              <div className="shrink-0 flex flex-col items-end gap-1.5 ml-1">
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold leading-none whitespace-nowrap ${cfg.badge}`}>
                                  {cfg.icon}
                                  {cfg.label}
                                </span>
                                <span className={`text-[14px] font-black tabular-nums leading-none ${isFaded ? 'text-muted-foreground' : 'text-primary'}`}>
                                  ¥{res.totalPrice.toLocaleString()}
                                </span>
                              </div>

                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </AnimatePresence>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </PageWrapper>
  );
}
