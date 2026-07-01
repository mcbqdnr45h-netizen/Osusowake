import React, { useState, useCallback } from 'react';
import { useRoute, useLocation } from 'wouter';
import { Layout } from '@/components/Layout';
import { useGetBag, useCreateReservation, getListAllBagsQueryKey, getGetBagQueryKey } from '@workspace/api-client-react';
import { getCategoryImage, getCategoryIcon, getImageFromName } from '@/lib/category-utils';
import { formatPickupTime, pickupWindowsLabel, getPickupDateLabel } from '@/lib/utils';
import { normalizeBrand } from '@/lib/brand-text';
import { Clock, MapPin, AlertCircle, ChevronLeft, Minus, Plus, Info, Flag, X, ChevronDown, Star, MessageSquare, Heart, Navigation, Phone, CalendarDays, Timer, UtensilsCrossed, Store, Sparkles, TrendingDown, Package } from 'lucide-react';
import { useUserId } from '@/hooks/use-user';
import { useToast } from '@/hooks/use-toast';
import { useFavorites } from '@/hooks/useFavorites';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import { LoginNudgeSheet } from '@/components/LoginNudgeSheet';
import { getStockUrgency } from '@/lib/stock-urgency';
import { getDisplayPrice, getDisplaySavings, getDisplayDiscountPercent } from '@/lib/price-display';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { WalkTime } from '@/components/WalkTime';
import { useUserLocation, haversineMeters, metersToWalkMinutes, formatDistanceLabel } from '@/hooks/use-user-location';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const REPORT_TYPES = [
  { value: 'closed', label: '閉店している' },
  { value: 'temp_closed', label: '一時休業中・長期休業中' },
  { value: 'wrong_hours', label: '営業時間が違う' },
  { value: 'wrong_info', label: '住所・電話番号などの情報が間違っている' },
  { value: 'other', label: 'その他' },
] as const;

type ReportType = typeof REPORT_TYPES[number]['value'];

function ReportModal({ storeId, storeName, userId, onClose }: {
  storeId: number;
  storeName: string;
  userId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [reportType, setReportType] = useState<ReportType | ''>('');
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    if (!reportType) return;
    setIsSubmitting(true);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType, comment }),
      });
      if (res.status === 401) {
        toast({ title: 'ログインが必要です', description: '通報するにはログインしてください', variant: 'destructive' });
        onClose();
        return;
      }
      if (res.status === 429) {
        toast({ title: '報告済みです', description: 'この店舗は24時間以内に既に報告されています', variant: 'destructive' });
        onClose();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `送信に失敗しました (HTTP ${res.status})`);
      }
      setDone(true);
    } catch (err: any) {
      toast({ title: '送信に失敗しました', description: err?.message ?? 'もう一度お試しください', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="bg-card w-full md:max-w-md md:rounded-2xl rounded-t-3xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="px-6 py-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-lg font-black">店舗情報を報告する</h3>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[220px]">{storeName}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {done ? (
            <div className="py-6 text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Flag className="w-8 h-8 text-primary" />
              </div>
              <h4 className="font-black text-lg mb-2">ご報告ありがとうございます</h4>
              <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                報告内容を受け付けました。管理者が確認し、必要に応じて店舗情報を更新します。
              </p>
              <button
                onClick={onClose}
                className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl hover:bg-primary/90 transition-all"
              >
                閉じる
              </button>
            </div>
          ) : (
            <>
              {/* Report Type */}
              <div className="mb-4">
                <label className="block text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wide">
                  報告の種類 <span className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <select
                    value={reportType}
                    onChange={e => setReportType(e.target.value as ReportType)}
                    className="w-full appearance-none bg-secondary border border-border rounded-xl px-4 py-3 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary pr-10"
                  >
                    <option value="">選択してください</option>
                    {REPORT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>

              {/* Comment */}
              <div className="mb-5">
                <label className="block text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wide">
                  詳細（任意）
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="具体的な状況をご記入ください（例：2025年5月に閉店しました）"
                  maxLength={300}
                  rows={3}
                  className="w-full bg-secondary border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-none"
                />
                <div className="text-right text-xs text-muted-foreground/60 mt-1">{comment.length}/300</div>
              </div>

              {/* Notice */}
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-5 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>虚偽の報告はサービス利用制限の対象となります。報告は24時間に1回のみ受け付けます。</p>
              </div>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={!reportType || isSubmitting}
                className="w-full bg-primary text-primary-foreground font-bold py-3.5 rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Flag className="w-4 h-4" />
                    報告を送信する
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function StarsDisplay({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'w-6 h-6' : size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star
          key={n}
          className={`${cls} ${n <= Math.round(rating) ? 'fill-amber-400 text-amber-400' : 'fill-none text-border'}`}
        />
      ))}
    </div>
  );
}

interface ReviewData {
  reviews: Array<{ id: number; userId: string; rating: number; comment: string | null; createdAt: string; reply: string | null; repliedAt: string | null }>;
  avgRating: number | null;
  count: number;
}

export default function BagDetail() {
  const [, params] = useRoute('/bags/:id');
  const bagId = params?.id ? parseInt(params.id) : 0;
  const userId = useUserId();
  const { user } = useAuth();
  const { toast } = useToast();
  const { isFavorite, toggle } = useFavorites();

  // ★★★ 「商品カードをタップしてもたまにロード画面が出る」根本対策 ★★★
  //   原因: pointerdown プリフェッチは ~50-200ms しか前倒し出来ず、
  //         ネット往復 (200-400ms) より遅い iOS / 弱回線では isLoading=true
  //         → スケルトン表示 → ようやく描画 という体感ラグが残る。
  //   対策: バッグ一覧 (listAllBags) は Home / Search で常時キャッシュされており、
  //         /bags/:id と完全に同じ SurpriseBagWithStore スキーマを返す。
  //         この一覧キャッシュから該当 ID を抜き出して useGetBag の initialData
  //         に与えれば、 isLoading は最初から false 確定 → スケルトン無しで
  //         即座に詳細ページが描画される。 裏で fresh fetch が走り、 差分が
  //         あれば数十 ms 後に静かに上書きされるだけ (UX 影響無し)。
  const queryClient = useQueryClient();
  const initialBag = React.useMemo(() => {
    if (!bagId) return undefined;
    const cachedList = queryClient.getQueryData<any[]>(getListAllBagsQueryKey());
    return cachedList?.find(b => b.id === bagId);
  }, [bagId, queryClient]);

  const { data: bag, isLoading, error } = useGetBag(bagId, {
    query: {
      queryKey: getGetBagQueryKey(bagId),
      // initialData があると React Query は即座に data として採用し isLoading=false 確定。
      // staleTime と組み合わせて「キャッシュ即時表示 → 30秒以内なら裏フェッチもスキップ」。
      initialData: initialBag,
      staleTime: 30_000,
    },
  });
  const createReservation = useCreateReservation();

  const [, navigate] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const cameFromCheckout = searchParams.get('from') === 'checkout';
  const [quantity, setQuantity] = useState(1);
  const [showReport,    setShowReport]    = useState(false);
  const [heroImgLoaded, setHeroImgLoaded] = useState(false);
  const [heroImgError,  setHeroImgError]  = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [showLoginNudge, setShowLoginNudge] = useState(false);
  const [loginNudgeReason, setLoginNudgeReason] = useState<'favorite' | 'purchase'>('purchase');

  function requireLogin(reason: 'favorite' | 'purchase') {
    setLoginNudgeReason(reason);
    setShowLoginNudge(true);
  }
  const { coords: userCoords } = useUserLocation();

  // 受取時間が過ぎているか判定（JST基準・深夜またぎ対応）
  const isExpired = React.useMemo(() => {
    if (!bag) return false; // 読み込み中
    const nowJST       = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const createdJST   = new Date(new Date(bag.createdAt as string).getTime() + 9 * 60 * 60 * 1000);
    const todayStr     = nowJST.toISOString().slice(0, 10);
    const yesterdayStr = new Date(nowJST.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const createdStr   = createdJST.toISOString().slice(0, 10);
    const currentTime  = nowJST.toISOString().slice(11, 16);

    // ★ pickupEnd 未設定: 出品日(JST)が今日でなければ期限切れ（他の全判定と統一。
    //   以前はここで一律 false を返し、 一覧/購入(410)と詳細表示が食い違っていた）。
    if (!bag.pickupEnd) return createdStr !== todayStr;

    // 2部制(受取2枠): 期限は「最後の枠の終わり」= pickupEnd2 があればそちら。
    const effEnd = (bag as { pickupEnd2?: string | null }).pickupEnd2 || bag.pickupEnd;

    // ★ 翌日受取（前日出品 pickupNextDay）: 今日出品→受取は明日なのでまだ有効。
    //   昨日出品→今日が受取日（pickupEnd を過ぎたら期限切れ）。 それ以前→期限切れ。
    //   これが無く、 前日出品バッグの詳細が「受取時間が終了しました」と誤表示されていた（2026-06-30 報告）。
    if ((bag as { pickupNextDay?: boolean }).pickupNextDay) {
      if (createdStr === todayStr)     return false;
      if (createdStr === yesterdayStr) return currentTime > effEnd;
      return true;
    }

    // 深夜またぎバッグ（例: pickupStart=23:00, pickupEnd=01:00）
    const isOvernightBag = bag.pickupStart != null && bag.pickupEnd < bag.pickupStart;
    if (isOvernightBag) {
      if (createdStr === todayStr)     return false;           // 今日出品 → 翌日まで有効
      if (createdStr === yesterdayStr) return currentTime > effEnd; // 昨日出品
      return true;
    }

    // 通常バッグ
    if (createdStr !== todayStr) return true;
    return currentTime > effEnd;
  }, [bag]);

  const { data: reviewData } = useQuery<ReviewData>({
    queryKey: ['store-reviews', bag?.store?.id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/stores/${bag!.store.id}/reviews`);
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    enabled: !!bag?.store?.id,
  });

  if (isLoading) {
    return (
      <Layout showBottomNav={false}>
        <div className="p-4 md:p-8 max-w-3xl mx-auto animate-pulse">
          <div className="h-64 bg-muted rounded-3xl mb-8" />
          <div className="h-8 bg-muted rounded w-1/2 mb-4" />
          <div className="h-4 bg-muted rounded w-1/3" />
        </div>
      </Layout>
    );
  }

  // 410 (期限切れ) または 404 (存在しない)
  if (!bag) {
    const isExpiredError = (error as any)?.status === 410;
    if (isExpiredError) {
      return (
        <Layout showBottomNav={false}>
          <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full max-w-sm md:max-w-2xl"
            >
              {/* Icon */}
              <div className="relative w-28 h-28 mx-auto mb-6">
                <div className="w-28 h-28 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                  <Clock className="w-14 h-14 text-amber-500" />
                </div>
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.3, type: 'spring', stiffness: 300 }}
                  className="absolute -bottom-1 -right-1 w-9 h-9 bg-destructive rounded-full flex items-center justify-center border-2 border-background"
                >
                  <AlertCircle className="w-5 h-5 text-white" />
                </motion.div>
              </div>

              {/* Text */}
              <h2 className="text-2xl font-black mb-3">受取時間が終了しました</h2>
              <p className="text-muted-foreground text-sm leading-relaxed mb-8">
                この商品の受取時間は既に過ぎています。<br />
                他のおすそわけバッグを見てみましょう！
              </p>

              {/* CTA: 商品を探す */}
              <motion.a
                href={`${BASE}/`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground font-black text-base rounded-2xl px-6 py-4 shadow-lg hover:bg-primary/90 active:scale-95 transition-all mb-3"
              >
                🛍️ 他の商品を探す
              </motion.a>

              {/* サブ: 前のページへ */}
              <button
                onClick={() => window.history.back()}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors py-2 underline underline-offset-2"
              >
                前のページに戻る
              </button>
            </motion.div>
          </div>
        </Layout>
      );
    }
    // ネットワーク/サーバーエラー（404以外の失敗）
    const httpStatus = (error as any)?.status as number | undefined;
    const isNetworkErr = !httpStatus || httpStatus >= 500;
    return (
      <Layout showBottomNav={false}>
        <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 text-center gap-5">
          <div className="w-20 h-20 rounded-3xl bg-muted flex items-center justify-center text-4xl">
            {isNetworkErr ? '📡' : '🔍'}
          </div>
          <div>
            <p className="font-black text-foreground text-lg mb-1">
              {isNetworkErr ? '通信エラーが発生しました' : '商品が見つかりません'}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {isNetworkErr
                ? '通信状況を確認して、もう一度お試しください。'
                : 'この商品は存在しないか、削除されました。'}
            </p>
          </div>
          {isNetworkErr ? (
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-primary text-white rounded-2xl font-bold text-sm hover:bg-primary/90 transition-colors"
            >
              再読み込み
            </button>
          ) : (
            <a href={`${BASE}/`} className="px-6 py-3 bg-primary text-white rounded-2xl font-bold text-sm hover:bg-primary/90 transition-colors">
              商品を探す
            </a>
          )}
        </div>
      </Layout>
    );
  }

  const discountPercent = getDisplayDiscountPercent(bag.originalPrice, bag.discountedPrice);
  const displayDiscountedPrice = getDisplayPrice(bag.discountedPrice);
  const displayOriginalPrice = getDisplayPrice(bag.originalPrice);
  const displaySavings = getDisplaySavings(bag.originalPrice, bag.discountedPrice);
  const isSoldOut = bag.stockCount <= 0;
  const isUnavailable = isExpired || isSoldOut;

  const handleReserve = () => {
    if (!user) { requireLogin('purchase'); return; }

    createReservation.mutate({
      data: {
        bagId: bag.id,
        quantity,
        userId: userId ?? ''
      }
    }, {
      onSuccess: (data) => {
        // 予約成功 → 在庫が減ったので bag/listAllBags キャッシュを invalidate。
        // (initialData 戦略により再訪時に古い在庫が見える可能性を排除)
        queryClient.invalidateQueries({ queryKey: getGetBagQueryKey(bag.id) });
        queryClient.invalidateQueries({ queryKey: getListAllBagsQueryKey() });
        navigate(`/checkout/${data.id}`);
      },
      onError: (err) => {
        toast({
          title: "予約に失敗しました",
          description: err.message || "もう一度お試しください。",
          variant: "destructive"
        });
      }
    });
  };

  return (<>
    <LoginNudgeSheet
      isOpen={showLoginNudge}
      onClose={() => setShowLoginNudge(false)}
      reason={loginNudgeReason}
    />
    <Layout showBottomNav={false}>
      <AnimatePresence>
        {showReport && userId && (
          <ReportModal
            storeId={bag.store.id}
            storeName={bag.store.name}
            userId={userId}
            onClose={() => setShowReport(false)}
          />
        )}
      </AnimatePresence>

      <div className="relative w-full max-w-3xl mx-auto md:py-8 md:px-4">

        {/* Mobile Header Back Button */}
        <div className="absolute top-4 left-4 z-50 md:hidden">
          <button
            onClick={() => cameFromCheckout ? navigate('/') : window.history.back()}
            className="w-10 h-10 bg-background/80 backdrop-blur rounded-full flex items-center justify-center shadow-md border border-border"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-card md:rounded-3xl shadow-sm border-x border-b md:border border-border/50 overflow-hidden"
        >
          {/* Hero Image（shimmer + フェードイン + プレミアム仕上げ）*/}
          {/* 暖色グラデ背景 + radial アクセント — 画像が白/透明/壊れていても寂しくならないように */}
          <div
            className="relative h-56 md:h-80 w-full overflow-hidden"
            style={{
              background:
                'radial-gradient(circle at 30% 20%, rgba(255,180,140,0.55) 0%, transparent 55%),' +
                'radial-gradient(circle at 75% 80%, rgba(255,140,120,0.45) 0%, transparent 50%),' +
                'linear-gradient(135deg, #fde2c8 0%, #f9c8a4 50%, #f2a98a 100%)',
            }}
          >
            {/* shimmer スケルトン（ロード前） */}
            {!heroImgLoaded && !heroImgError && (
              <div className="absolute inset-0 skeleton-shimmer" />
            )}
            <img
              src={
                heroImgError
                  ? (getImageFromName(bag.title, bag.id) || getCategoryImage(bag.store.category, bag.id))
                  : (bag.imageUrl || bag.store.imageUrl || getImageFromName(bag.title, bag.id) || getCategoryImage(bag.store.category, bag.id))
              }
              alt={bag.store.name}
              loading="eager"
              decoding="async"
              onLoad={() => setHeroImgLoaded(true)}
              onError={() => { setHeroImgError(true); setHeroImgLoaded(true); }}
              className={`w-full h-full object-cover transition-all duration-700 ease-out ${heroImgLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-105'}`}
            />
            {/* 階層的グラデ: 上部に薄いダーク (ステータスバー視認性) + 下部に深いダーク (テキスト視認性) */}
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/40 to-transparent pointer-events-none" />
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/40 to-transparent pointer-events-none" />
            {/* 微細なビネット (両端) */}
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.18) 100%)' }} />

            <div className="absolute bottom-7 left-6 right-6">
              <h1 className="text-[28px] md:text-4xl font-black text-white leading-[1.15] tracking-tight" style={{ textShadow: '0 2px 12px rgba(0,0,0,0.45)' }}>
                {normalizeBrand(bag.title)}
              </h1>
            </div>
          </div>

          <div className="p-6 md:p-8 space-y-8">
            {/* 店舗ヘッダー — refine-b 風 (タイトルの下に店名 + ⭐ + 📍) */}
            <div className="flex items-center justify-between gap-3 -mt-2">
              <div className="min-w-0 flex-1">
                <h2 className="font-black text-foreground text-lg leading-tight truncate">
                  {bag.store.name}
                </h2>
                <div className="flex items-center gap-3 mt-1.5 text-[13px] text-muted-foreground font-medium flex-wrap">
                  {reviewData?.avgRating != null && reviewData.count > 0 ? (
                    <span className="flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" strokeWidth={0} />
                      <span className="font-bold text-foreground tabular-nums">
                        {reviewData.avgRating.toFixed(1)}
                      </span>
                      <span className="text-muted-foreground/70">({reviewData.count})</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-muted-foreground/70">
                      <Star className="w-3.5 h-3.5" strokeWidth={2} />
                      <span>口コミなし</span>
                    </span>
                  )}
                  {bag.store.lat && bag.store.lng && userCoords ? (() => {
                    const meters = haversineMeters(userCoords.lat, userCoords.lng, bag.store.lat!, bag.store.lng!);
                    return (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" strokeWidth={2.2} />
                        {formatDistanceLabel(meters)}
                      </span>
                    );
                  })() : bag.store.city ? (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5" strokeWidth={2.2} />
                      {bag.store.city}
                    </span>
                  ) : null}
                </div>
              </div>
              {/* 店舗アイコン (右) */}
              {bag.store.iconUrl ? (
                <div className="w-12 h-12 rounded-2xl overflow-hidden shrink-0 ring-1 ring-border shadow-sm">
                  <img src={bag.store.iconUrl} alt={bag.store.name} loading="lazy" className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-2xl leading-none">{getCategoryIcon(bag.store.category)}</span>
                </div>
              )}
            </div>

            {/* 受取時間終了バナー */}
            {isExpired && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl overflow-hidden border border-amber-300 dark:border-amber-700"
              >
                <div className="bg-amber-50 dark:bg-amber-950/40 px-5 py-4 flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-400/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-black text-amber-900 dark:text-amber-200 text-base mb-0.5">
                      受取時間が終了しました
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                      この商品の受取時間（〜{bag.pickupEnd}）は既に過ぎています。<br />
                      他のおすそわけバッグを探してみましょう！
                    </p>
                  </div>
                </div>
                <a
                  href={`${BASE}/`}
                  className="flex items-center justify-center gap-2 w-full bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-white font-black text-sm py-3.5 transition-all"
                >
                  🛍️ 他の商品を探す
                </a>
              </motion.div>
            )}

            {/* ── 価格ブロック (プレミアム仕上げ) ───────────────────── */}
            <div>
              {/* 価格カード — 洗練されたフレーム */}
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#FFF8F1] via-[#FFEFE0] to-[#FFE2CB] dark:from-stone-900/60 dark:via-stone-900/40 dark:to-stone-900/30 border border-[#F2D5B6] dark:border-stone-800 px-5 py-5 shadow-sm">
                {/* 装飾用 円 */}
                <div aria-hidden className="absolute -top-12 -right-10 w-40 h-40 rounded-full bg-gradient-to-br from-[#FFD3A8]/40 to-transparent blur-2xl pointer-events-none" />

                <div className="relative flex items-end justify-between gap-4 flex-wrap" data-sshide>
                  {/* 左: メイン価格 */}
                  <div>
                    {discountPercent > 0 && (
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[10px] font-black tracking-[0.18em] uppercase text-[#8B2906] dark:text-amber-400">
                          特別価格
                        </span>
                        <span className="h-px flex-1 bg-gradient-to-r from-[#B5390B]/30 to-transparent w-8" />
                      </div>
                    )}
                    <div className="flex items-baseline gap-1 leading-none">
                      <span className="text-2xl font-bold text-[#7B4F2C] dark:text-[#C4956A]">¥</span>
                      <span
                        className="text-[60px] md:text-7xl font-black text-[#5C3A1F] dark:text-[#C4956A] tracking-[-0.04em] tabular-nums"
                        style={{ fontFeatureSettings: '"tnum"' }}
                      >
                        {displayDiscountedPrice.toLocaleString()}
                      </span>
                    </div>
                    {displayOriginalPrice > displayDiscountedPrice && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground/70 font-bold uppercase tracking-[0.1em]">
                          通常
                        </span>
                        <span className="text-sm text-muted-foreground/60 line-through font-medium tabular-nums">
                          ¥{displayOriginalPrice.toLocaleString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 右: 割引バッジ + お得額（縦積み） */}
                  {(discountPercent > 0 || displaySavings > 0) && (
                    <div className="flex flex-col items-end gap-2 shrink-0 pb-1">
                      {discountPercent > 0 && (
                        <motion.span
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                          className="inline-flex items-center bg-gradient-to-br from-[#D44613] to-[#8B2906] text-white font-black text-[14px] px-3.5 py-1.5 rounded-full shadow-lg shadow-[#B5390B]/30 tracking-wider"
                          style={{ letterSpacing: '0.04em' }}
                        >
                          {discountPercent}% OFF
                        </motion.span>
                      )}
                      {displaySavings > 0 && (
                        <motion.span
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ type: 'spring', stiffness: 380, damping: 22, delay: 0.08 }}
                          className="inline-flex items-center gap-1 bg-white/85 dark:bg-emerald-950/60 backdrop-blur-sm text-emerald-700 dark:text-emerald-300 font-black text-[12px] px-2.5 py-1 rounded-full border border-emerald-200/80 dark:border-emerald-900/60"
                        >
                          <TrendingDown className="w-3 h-3" strokeWidth={3} />
                          <span className="tabular-nums" style={{ fontFeatureSettings: '"tnum"' }}>
                            ¥{displaySavings.toLocaleString()} お得
                          </span>
                        </motion.span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 受取情報カード — アイコン付き行 */}
              <div className="mt-4 rounded-2xl border border-border/60 bg-card overflow-hidden divide-y divide-border/40">
                {/* 在庫 */}
                {(() => {
                  const urgency = getStockUrgency(bag.stockCount);
                  const iconBg =
                    urgency.level === 'sold-out' ? 'bg-stone-100 dark:bg-stone-900/40' :
                    urgency.level === 'critical' ? 'bg-rose-50 dark:bg-red-950/30' :
                    urgency.level === 'low'      ? 'bg-amber-50 dark:bg-amber-950/30' :
                                                   'bg-emerald-50 dark:bg-emerald-950/30';
                  const iconColor =
                    urgency.level === 'sold-out' ? 'text-stone-400' :
                    urgency.level === 'critical' ? 'text-rose-600 dark:text-rose-300' :
                    urgency.level === 'low'      ? 'text-amber-600 dark:text-amber-300' :
                                                   'text-emerald-600 dark:text-emerald-300';
                  const labelColor =
                    urgency.level === 'sold-out' ? 'text-muted-foreground' :
                    urgency.level === 'critical' ? 'text-rose-700 dark:text-rose-300' :
                    urgency.level === 'low'      ? 'text-amber-700 dark:text-amber-300' :
                                                   'text-foreground';
                  const dotBg =
                    urgency.level === 'critical' ? 'bg-rose-500' :
                    urgency.level === 'low'      ? 'bg-amber-500' :
                                                   'bg-emerald-500';
                  return (
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
                        <Package className={`w-4 h-4 ${iconColor}`} strokeWidth={2.4} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-muted-foreground/90 uppercase tracking-[0.1em] mb-0.5">在庫</div>
                        <div className="flex items-center gap-1.5">
                          {urgency.level !== 'sold-out' && urgency.pulse && (
                            <span className="relative flex w-2 h-2 shrink-0">
                              <span className={`absolute inline-flex h-full w-full rounded-full ${dotBg} opacity-50 animate-ping`} />
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${dotBg}`} />
                            </span>
                          )}
                          <span className={`text-sm font-bold ${labelColor}`}>{urgency.label}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* 受取時間 */}
                {bag.pickupStart && (
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center shrink-0">
                      <Clock className="w-4 h-4 text-amber-600 dark:text-amber-300" strokeWidth={2.4} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-bold text-muted-foreground/90 uppercase tracking-[0.1em] mb-0.5 flex items-center gap-1.5">
                        受取時間
                        {getPickupDateLabel((bag as { createdAt?: string }).createdAt, (bag as { pickupNextDay?: boolean }).pickupNextDay).isTomorrow && (
                          <span className="normal-case tracking-normal text-[10px] font-black text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">🌙 明日受け取り</span>
                        )}
                      </div>
                      <div className="text-sm font-bold text-foreground tabular-nums">
                        {(() => { const p = getPickupDateLabel((bag as { createdAt?: string }).createdAt, (bag as { pickupNextDay?: boolean }).pickupNextDay).prefix; return (p ? p + ' ' : '') + pickupWindowsLabel(bag.pickupStart, bag.pickupEnd, (bag as { pickupStart2?: string | null }).pickupStart2, (bag as { pickupEnd2?: string | null }).pickupEnd2); })()}
                      </div>
                    </div>
                  </div>
                )}

                {/* 徒歩距離 */}
                {bag.store.lat && bag.store.lng && userCoords && (() => {
                  const meters = haversineMeters(userCoords.lat, userCoords.lng, bag.store.lat!, bag.store.lng!);
                  return (
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/30 flex items-center justify-center shrink-0">
                        <Navigation className="w-4 h-4 text-sky-600 dark:text-sky-300" strokeWidth={2.4} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-muted-foreground/90 uppercase tracking-[0.1em] mb-0.5">距離</div>
                        <div className="text-sm font-bold text-foreground">{formatDistanceLabel(meters)}</div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* グラデーション区切り線 */}
            <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

            {/* Description — 吹き出し (refine-b 風) */}
            <div>
              <h3 className="font-black text-lg mb-3 flex items-center gap-2">
                <Info className="w-5 h-5 text-primary" /> バッグの内容
              </h3>
              <div className="relative rounded-2xl bg-gradient-to-br from-stone-50 to-stone-100/40 dark:from-stone-900/40 dark:to-stone-900/20 border border-border/50 px-5 py-4 mt-1">
                {/* 三角ポインター (上向き) */}
                <div
                  aria-hidden
                  className="absolute -top-[7px] left-7 w-3 h-3 bg-stone-50 dark:bg-stone-900/40 rotate-45 border-l border-t border-border/50"
                />
                <p className="relative text-foreground/85 leading-relaxed whitespace-pre-wrap text-[14px] italic">
                  「{bag.description || bag.store.description || `${bag.store.name}のお料理がランダムに入ったお得なサプライズバッグです。お店の味を、ぜひ受け取ってください！`}」
                </p>
              </div>
              {bag.description && bag.store.description && (
                <div className="mt-3 bg-secondary/50 rounded-xl px-4 py-3.5 border border-border/40">
                  <p className="text-[11px] font-black text-primary mb-1.5 uppercase tracking-[0.1em]">お店のPR</p>
                  <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{bag.store.description}</p>
                </div>
              )}
            </div>

            {/* グラデーション区切り線 */}
            <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

            {/* ── 店舗情報（完全版）──────────────────────────────── */}
            <div>
              <h3 className="font-black text-lg mb-4 flex items-center gap-2">
                <Store className="w-5 h-5 text-primary" />
                店舗情報
              </h3>

              <div className="rounded-2xl border border-border/60 overflow-hidden divide-y divide-border/40 bg-gradient-to-b from-card to-stone-50/30 dark:to-stone-900/20 shadow-sm">

                {/* 店舗名 + フォローボタン (洗練されたヘッダー) */}
                <div className="flex items-start justify-between gap-3 px-4 py-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    {/* 店舗アイコン: iconUrl があれば優先表示 (角丸スクエア + シャドウ) */}
                    {bag.store.iconUrl ? (
                      <div className="w-12 h-12 rounded-2xl overflow-hidden shrink-0 ring-2 ring-white dark:ring-stone-800 shadow-md">
                        <img
                          src={bag.store.iconUrl}
                          alt={bag.store.name}
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center shrink-0 ring-1 ring-primary/10 shadow-sm">
                        <span className="text-2xl leading-none">{getCategoryIcon(bag.store.category)}</span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="font-black text-[15px] text-foreground leading-snug line-clamp-2 break-all">
                        {bag.store.name}
                      </div>
                      {bag.store.city && (
                        <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1 font-medium">
                          <MapPin className="w-3 h-3" strokeWidth={2.5} />
                          {bag.store.city}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { if (!user) { requireLogin('favorite'); return; } toggle(bag.store.id); }}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold border transition-all active:scale-95 shrink-0 mt-0.5
                      ${isFavorite(bag.store.id)
                        ? 'bg-gradient-to-br from-rose-500 to-rose-600 text-white border-transparent shadow-md shadow-rose-500/30'
                        : 'bg-card text-rose-500 border-rose-200 hover:bg-rose-50 hover:border-rose-300'
                      }`}
                  >
                    <Heart className={`w-3.5 h-3.5 ${isFavorite(bag.store.id) ? 'fill-white stroke-white' : 'fill-none stroke-rose-500'}`} strokeWidth={2.5} />
                    {isFavorite(bag.store.id) ? 'フォロー中' : 'フォロー'}
                  </button>
                </div>

                {/* 住所 + 埋込地図 (タップで地図アプリ起動) */}
                {bag.store.address && (
                  <div className="px-4 py-3.5">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${bag.store.name} ${bag.store.address}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 mb-3 -mx-2 px-2 py-1.5 rounded-xl hover:bg-muted/60 active:bg-muted transition-colors"
                    >
                      <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">住所（タップで地図を開く）</div>
                        <div className="text-sm text-primary font-bold leading-relaxed underline underline-offset-2 decoration-primary/40">{bag.store.address}</div>
                      </div>
                    </a>
                    {/* 埋込地図・タップ先ともに「店名 + 表示している住所」を基準にする。
                        店名を含めると Google がその住所にある店舗POIを名前付き(例:ベーカリービーチアイランド)で表示する。
                        住所も併記するので、店POIが未登録でも住所へフォールバックし場所ズレしない。
                        登録ピン(lat/lng)は店が手動でズレた位置に置ける(draggable)ため使わない。 */}
                    <div className="rounded-2xl overflow-hidden border border-border/60 shadow-sm bg-muted/30">
                      <iframe
                        src={`https://www.google.com/maps?q=${encodeURIComponent(`${bag.store.name} ${bag.store.address}`)}&z=16&output=embed`}
                        width="100%"
                        height="180"
                        style={{ border: 0, display: 'block' }}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        title={`${bag.store.name}の地図`}
                      />
                    </div>
                  </div>
                )}

                {/* 電話番号 */}
                {(bag.store as any).phone && (
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <Phone className="w-4 h-4 text-primary shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">電話番号</div>
                      <a
                        href={`tel:${(bag.store as any).phone}`}
                        className="text-sm font-bold text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                      >
                        {(bag.store as any).phone}
                      </a>
                    </div>
                  </div>
                )}

                {/* 営業時間 */}
                {((bag.store as any).openTime || (bag.store as any).closeTime) && (
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <Clock className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">営業時間</div>
                      <div className="text-sm font-bold text-foreground">
                        {(bag.store as any).openTime ?? '—'}
                        {(bag.store as any).closeTime ? ` 〜 ${(bag.store as any).closeTime}` : ''}
                      </div>
                    </div>
                  </div>
                )}

                {/* 受取時間の説明文 */}
                {(bag.store as any).pickupHours && (
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <Timer className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">受取時間について</div>
                      <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{(bag.store as any).pickupHours}</div>
                    </div>
                  </div>
                )}

                {/* 定休日 */}
                {(bag.store as any).holiday && (
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <CalendarDays className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">定休日</div>
                      <div className="text-sm text-foreground font-medium">{(bag.store as any).holiday}</div>
                    </div>
                  </div>
                )}

                {/* アレルギー情報 */}
                {bag.allergyInfo && (
                  <div className="flex items-start gap-3 px-4 py-3.5 bg-amber-50/60 dark:bg-amber-950/20">
                    <UtensilsCrossed className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide mb-0.5">アレルギー情報</div>
                      <div className="text-sm text-amber-900 dark:text-amber-200 leading-relaxed whitespace-pre-wrap">{bag.allergyInfo}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Bag-specific pickup note */}
            {bag.pickupNote && (
              <div className="bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900 rounded-2xl p-4 flex gap-3 text-sky-800 dark:text-sky-200">
                <Info className="w-5 h-5 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-bold mb-1">受取メモ</p>
                  <p className="whitespace-pre-wrap">{bag.pickupNote}</p>
                </div>
              </div>
            )}

            {/* 汎用アレルギー注意（allergyInfo未設定時のみ表示） */}
            {!bag.allergyInfo && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-2xl p-4 flex gap-3 text-amber-800 dark:text-amber-200">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div className="text-sm">
                  <p className="font-bold mb-1">アレルギーについて</p>
                  <p>サプライズバッグの内容は日によって異なります。重度のアレルギーをお持ちの方はご遠慮ください。</p>
                </div>
              </div>
            )}

            {/* Reviews Section */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-primary" /> 口コミ・評価
                </h3>
                {reviewData && reviewData.count > 0 && (
                  <span className="text-xs text-muted-foreground">{reviewData.count}件</span>
                )}
              </div>

              {/* Avg rating summary */}
              {reviewData && reviewData.avgRating !== null ? (
                <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-2xl px-6 py-6 mb-6">
                  <div className="flex items-center gap-6">
                    {/* 左列：スコア＋星＋件数 */}
                    <div className="flex flex-col items-center justify-center shrink-0 min-w-[72px]">
                      <div
                        className="font-black text-amber-500 leading-tight"
                        style={{ fontSize: '3rem', lineHeight: 1.1 }}
                      >
                        {reviewData.avgRating.toFixed(1)}
                      </div>
                      <div className="mt-2"><StarsDisplay rating={reviewData.avgRating} size="md" /></div>
                      <div className="text-xs text-muted-foreground mt-1.5">{reviewData.count}件の口コミ</div>
                    </div>

                    {/* 右列：棒グラフ */}
                    <div className="flex-1 flex flex-col justify-center gap-2">
                      {[5, 4, 3, 2, 1].map(star => {
                        const starCount = reviewData.reviews.filter(r => r.rating === star).length;
                        const pct = reviewData.count > 0 ? (starCount / reviewData.count) * 100 : 0;
                        return (
                          <div key={star} className="flex items-center gap-2 text-xs">
                            <span className="w-3 text-right font-bold text-muted-foreground shrink-0">{star}</span>
                            <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />
                            <div className="flex-1 h-2 bg-amber-100 dark:bg-amber-900/40 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-amber-400 rounded-full transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="w-4 text-right text-muted-foreground shrink-0">{starCount}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : reviewData && reviewData.count === 0 ? (
                <div className="rounded-2xl p-8 text-center mb-5 bg-gradient-to-br from-amber-50/70 to-orange-50/50 border border-amber-100/60">
                  <div className="text-5xl mb-3 leading-none select-none" aria-hidden>🍱</div>
                  <p className="font-black text-foreground text-[15px] mb-1.5">まだ口コミがありません</p>
                  <p className="text-sm text-muted-foreground/80 leading-relaxed">
                    最初のレビュアーになりませんか？<br />
                    受け取った感想が次のお客様の<br />大きな参考になります
                  </p>
                </div>
              ) : (
                <div className="h-20 bg-secondary/50 rounded-2xl animate-pulse mb-5" />
              )}

              {/* Review list */}
              {reviewData && reviewData.reviews.length > 0 && (
                <div className="space-y-3">
                  {(showAllReviews ? reviewData.reviews : reviewData.reviews.slice(0, 3)).map((review, idx) => (
                    <motion.div
                      key={review.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="bg-secondary/30 rounded-2xl p-4 border border-border/50"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-primary/10 rounded-full flex items-center justify-center text-xs font-black text-primary">
                            {review.userId.slice(0, 2).toUpperCase()}
                          </div>
                          <StarsDisplay rating={review.rating} size="sm" />
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          {format(parseISO(review.createdAt), 'yyyy/MM/dd')}
                        </span>
                      </div>
                      {review.comment && (
                        <p className="text-sm text-foreground leading-relaxed pl-9">{review.comment}</p>
                      )}
                      {review.reply && (
                        <div className="mt-3 ml-9 bg-primary/5 border border-primary/15 rounded-xl px-3 py-2.5">
                          <p className="text-[11px] font-black text-primary mb-1">オーナーより</p>
                          <p className="text-xs text-foreground leading-relaxed">{review.reply}</p>
                        </div>
                      )}
                    </motion.div>
                  ))}

                  {reviewData.reviews.length > 3 && (
                    <button
                      onClick={() => setShowAllReviews(v => !v)}
                      className="w-full flex items-center justify-center gap-1.5 py-3 text-sm font-bold text-primary hover:bg-primary/5 rounded-xl transition-colors border border-primary/20"
                    >
                      {showAllReviews ? '口コミを閉じる' : `すべての口コミを見る（${reviewData.reviews.length}件）`}
                      <ChevronDown className={`w-4 h-4 transition-transform ${showAllReviews ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Report Button */}
            <div className="pt-2">
              <button
                onClick={() => {
                  if (!userId) {
                    toast({ title: 'ユーザー情報が見つかりません', description: 'ページを再読み込みしてください', variant: 'destructive' });
                    return;
                  }
                  setShowReport(true);
                }}
                className="flex items-center gap-2 text-xs text-muted-foreground hover:text-destructive transition-colors py-1"
              >
                <Flag className="w-3.5 h-3.5" />
                この店舗の情報を報告する
              </button>
            </div>
          </div>
        </motion.div>

        {/* Bottom Sticky CTA（プレミアム仕上げ・safe-area対応）*/}
        <div
          className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-xl border-t border-border/60 shadow-[0_-12px_40px_rgba(0,0,0,0.08)] z-50 md:sticky md:bg-transparent md:backdrop-blur-none md:border-none md:shadow-none md:mt-6"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0px)' }}
        >
          <div className="px-4 pt-3.5 max-w-3xl mx-auto">
            <div className="flex items-center gap-3">

              {/* 数量ステッパー (洗練) */}
              <div className="bg-stone-100 dark:bg-stone-800/60 rounded-2xl flex items-center p-1 h-[56px] border border-stone-200/80 dark:border-stone-700/60 shadow-inner">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1 || isUnavailable}
                  className="w-11 h-full flex items-center justify-center rounded-xl text-foreground/80 hover:bg-white dark:hover:bg-stone-700 active:scale-90 disabled:opacity-25 transition-all"
                  aria-label="減らす"
                >
                  <Minus className="w-4 h-4" strokeWidth={2.8} />
                </button>
                <div
                  className="w-9 text-center font-black text-lg select-none text-foreground tabular-nums"
                  style={{ fontFeatureSettings: '"tnum"' }}
                >
                  {quantity}
                </div>
                <button
                  onClick={() => setQuantity(Math.min(bag.stockCount, quantity + 1))}
                  disabled={quantity >= bag.stockCount || isUnavailable}
                  className="w-11 h-full flex items-center justify-center rounded-xl text-foreground/80 hover:bg-white dark:hover:bg-stone-700 active:scale-90 disabled:opacity-25 transition-all"
                  aria-label="増やす"
                >
                  <Plus className="w-4 h-4" strokeWidth={2.8} />
                </button>
              </div>

              {/* 購入する CTA (グラデ + グロー + プレス感) */}
              <button
                onClick={handleReserve}
                disabled={isUnavailable || createReservation.isPending}
                className={`relative flex-1 h-[56px] rounded-2xl font-black text-[15px] tracking-wide overflow-hidden transition-all duration-200 flex items-center justify-center gap-2 group
                  ${isUnavailable
                    ? 'bg-stone-200 dark:bg-stone-800 text-muted-foreground shadow-none cursor-not-allowed'
                    : 'bg-gradient-to-br from-[#C44214] via-[#B5390B] to-[#8B2906] text-white shadow-lg shadow-[#B5390B]/35 hover:shadow-xl hover:shadow-[#B5390B]/45 hover:-translate-y-[1px] active:translate-y-0 active:shadow-md'
                  }`}
              >
                {/* グロス効果 (上部の光) */}
                {!isUnavailable && (
                  <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/20 to-transparent pointer-events-none" />
                )}
                {createReservation.isPending ? (
                  <div className="w-5 h-5 border-[2.5px] border-white/30 border-t-white rounded-full animate-spin" />
                ) : isExpired ? (
                  <span className="relative flex items-center gap-2">
                    <Clock className="w-4 h-4" strokeWidth={2.5} />
                    受取時間が終了しました
                  </span>
                ) : isSoldOut ? (
                  <span className="relative">完売しました</span>
                ) : (
                  <span className="relative flex items-center gap-2">
                    <span>購入する</span>
                    <span className="text-white/95 font-black tabular-nums" style={{ fontFeatureSettings: '"tnum"' }} data-sshide>
                      ¥{(getDisplayPrice(bag.discountedPrice) * quantity).toLocaleString()}
                    </span>
                  </span>
                )}
              </button>
            </div>
            {!isUnavailable && (() => {
              const urgency = getStockUrgency(bag.stockCount);
              if (urgency.level === 'critical') {
                return (
                  <div className="flex items-center justify-center gap-1.5 mt-2.5 mb-1 text-[11px] md:hidden font-bold">
                    <span className={`inline-block w-1 h-1 rounded-full ${urgency.dotClass} animate-pulse`} />
                    <span className="text-muted-foreground">残りわずか</span>
                    <span className={`tabular-nums ${urgency.toneClass}`} style={{ fontFeatureSettings: '"tnum"' }}>
                      {bag.stockCount}個
                    </span>
                    <span className="text-muted-foreground">！お早めに</span>
                  </div>
                );
              }
              if (urgency.level === 'low') {
                return (
                  <div className="flex items-center justify-center gap-1.5 mt-2.5 mb-1 text-[11px] md:hidden font-bold">
                    <span className={`inline-block w-1 h-1 rounded-full ${urgency.dotClass}`} />
                    <span className="text-muted-foreground">あと</span>
                    <span className={`tabular-nums ${urgency.toneClass}`} style={{ fontFeatureSettings: '"tnum"' }}>
                      {bag.stockCount}個
                    </span>
                    <span className="text-muted-foreground">で完売</span>
                  </div>
                );
              }
              return (
                <div className="flex items-center justify-center gap-1.5 mt-2.5 mb-1 text-[11px] text-muted-foreground/70 md:hidden font-bold">
                  <span className={`inline-block w-1 h-1 rounded-full ${urgency.dotClass}`} />
                  <span>在庫あり</span>
                </div>
              );
            })()}
            {isExpired && (
              <div className="text-center mt-2.5 mb-1 text-[11px] text-muted-foreground md:hidden flex items-center justify-center gap-1 font-bold">
                <Clock className="w-3 h-3" />
                本日の受取時間（〜{bag.pickupEnd}）が終了しました
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 特商法リンク */}
      <div className="text-center py-4 px-4 border-t border-border/30">
        <a
          href="/legal"
          className="text-xs text-muted-foreground/60 hover:text-muted-foreground underline transition-colors"
        >
          特定商取引法に基づく表記
        </a>
      </div>
    </Layout>
  </>);
}
