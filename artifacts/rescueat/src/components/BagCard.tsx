import React, { useState, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Clock, Gift, Heart, Navigation, ChefHat, Sparkles, Star } from 'lucide-react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  SurpriseBagWithStore,
  getBag,
  getGetBagQueryKey,
} from '@workspace/api-client-react';
import { useFavorites } from '@/hooks/useFavorites';
import { useAuth } from '@/contexts/AuthContext';
import { getCategoryIcon, getCategoryImage, getImageFromName } from '@/lib/category-utils';
import { formatPickupTime, pickupWindowsLabel, getPickupDateLabel } from '@/lib/utils';
import { useUserLocation, haversineMeters, formatDistanceLabel } from '@/hooks/use-user-location';
import { getDisplayPrice, getDisplayDiscountPercent } from '@/lib/price-display';
import { useToast } from '@/hooks/use-toast';
import { LoginNudgeSheet } from '@/components/LoginNudgeSheet';
import { StoreReviewSheet } from '@/components/StoreReviewSheet';

interface BagCardProps {
  bag: SurpriseBagWithStore;
  compact?: boolean;
}

/* ── 白エリア用 距離ピル ── */
function InfoDistanceBadge({
  storeLat,
  storeLng,
  size = 'md',
}: {
  storeLat: number;
  storeLng: number;
  size?: 'sm' | 'md';
}) {
  const { coords, loading } = useUserLocation();
  if (loading) return (
    <span className={`inline-block rounded-full bg-muted animate-pulse ${size === 'sm' ? 'w-12 h-4' : 'w-16 h-5'}`} />
  );
  if (!coords || !storeLat || !storeLng) return null;
  const meters  = haversineMeters(coords.lat, coords.lng, storeLat, storeLng);
  const minutes = Math.round(meters / 67);
  const label   = formatDistanceLabel(meters);
  const colorClass = minutes <= 5
    ? 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/60'
    : minutes <= 15
    ? 'bg-amber-50 text-amber-600 ring-1 ring-amber-200/60'
    : 'bg-sky-50 text-sky-600 ring-1 ring-sky-200/60';
  return (
    <span className={`inline-flex items-center gap-1 ${colorClass} rounded-full font-bold
      ${size === 'sm' ? 'text-[9px] px-1.5 py-[3px]' : 'text-[11px] px-2.5 py-1'}`}>
      <Navigation className={size === 'sm' ? 'w-2 h-2 shrink-0' : 'w-3 h-3 shrink-0'} />
      {label}
    </span>
  );
}

/* ── 吹き出し風「店主の一言」 ── */
function OwnerComment({ comment }: { comment: string }) {
  return (
    <div className="flex items-start gap-2 mb-3 px-0.5">
      <div className="shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
        <ChefHat className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="relative bg-amber-50/80 rounded-xl rounded-tl-sm px-2.5 py-1.5 flex-1 min-w-0">
        <div className="absolute -left-1.5 top-2 w-0 h-0
          border-t-[5px] border-t-transparent
          border-r-[7px] border-r-amber-100
          border-b-[5px] border-b-transparent" />
        <p className="text-[11px] text-amber-800/75 font-medium italic leading-snug line-clamp-2 break-all">
          {comment}
        </p>
      </div>
    </div>
  );
}

/* ── compact カード本体（HorizBagCard と同一レイアウト） ── */
function CompactCardBody({
  bag, isSoldOut, isLowStock, favorited, onSoldOutFan,
}: {
  bag: SurpriseBagWithStore;
  isSoldOut: boolean;
  isLowStock: boolean;
  favorited: boolean;
  fanBurst: boolean;
  onSoldOutFan: (e: React.MouseEvent) => void;
}) {
  const { coords, loading: gpsLoading } = useUserLocation();
  const distM = (coords && bag.store.lat && bag.store.lng)
    ? haversineMeters(coords.lat, coords.lng, bag.store.lat, bag.store.lng)
    : null;
  // ★ 距離表示は全画面で formatDistanceLabel に統一(徒歩◯分ベース)。
  //   以前ここだけ独自ロジックで「◯◯m/◯◯km」を出しており、詳細画面の「徒歩◯分」と
  //   食い違って「カードの距離が実際と違う」と誤解される原因になっていた。
  const distLabel = distM != null ? formatDistanceLabel(distM) : null;
  const distMinutes = distM != null ? Math.round(distM / 67) : 99;
  const pickupDay = getPickupDateLabel((bag as { createdAt?: string }).createdAt, (bag as { pickupNextDay?: boolean }).pickupNextDay);

  return (
    <div className="flex flex-col gap-[3px]">

      {/* ① 店舗名（左）＋ 受取時間（右） — 同一行・絶対に重ならない */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className="text-[10px] text-muted-foreground font-medium truncate leading-none">
          {bag.store.name}
        </span>
        {(bag.pickupStart || bag.pickupEnd) && !isSoldOut && (
          <div className="flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
            <Clock className="w-2.5 h-2.5 shrink-0" />
            <span className="leading-none whitespace-nowrap">
              {(pickupDay.prefix ? pickupDay.prefix + ' ' : '') + formatPickupTime(bag.pickupStart, bag.pickupEnd)}
            </span>
          </div>
        )}
      </div>

      {/* ② 商品タイトル */}
      <p className={`font-black text-[14px] leading-snug line-clamp-1
        ${isSoldOut ? 'text-muted-foreground' : 'text-foreground'}`}>
        {bag.title}
      </p>

      {/* ③ 距離バッジ（左）＋ 価格（右） */}
      {!isSoldOut ? (
        <div className="flex items-end justify-between gap-1 mt-0.5">
          {/* 左: 残りわずか + 距離バッジ */}
          <div className="flex flex-col gap-0.5">
            {isLowStock && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-black text-rose-500 bg-rose-50
                px-1.5 py-[2px] rounded-full ring-1 ring-rose-200/70 leading-none w-fit">
                🔥 残り{bag.stockCount}個
              </span>
            )}
            {distLabel ? (
              <span className={`inline-flex items-center gap-0.5 rounded-full font-bold text-[10px] px-1.5 py-[2px] leading-none w-fit
                ${distMinutes <= 5
                  ? 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/70'
                  : distMinutes <= 15
                  ? 'bg-amber-50 text-amber-600 ring-1 ring-amber-200/70'
                  : 'bg-sky-50 text-sky-600 ring-1 ring-sky-200/70'}`}>
                <Navigation className="w-2.5 h-2.5 shrink-0" />
                {distLabel}
              </span>
            ) : gpsLoading ? (
              <span className="inline-block w-10 h-[14px] rounded-full bg-muted animate-pulse" />
            ) : null}
          </div>
          {/* 右: 元値 + 販売価格 (税込・サービス手数料込み) */}
          <div className="flex flex-col items-end shrink-0" data-sshide>
            {bag.originalPrice > bag.discountedPrice && (
              <span className="text-[10px] text-muted-foreground/40 line-through font-medium leading-none mb-[1px]">
                ¥{getDisplayPrice(bag.originalPrice).toLocaleString()}
              </span>
            )}
            <span className="text-[18px] font-black text-primary leading-none tracking-tight whitespace-nowrap">
              ¥{getDisplayPrice(bag.discountedPrice).toLocaleString()}
            </span>
          </div>
        </div>
      ) : (
        /* 完売時 */
        <button
          onClick={onSoldOutFan}
          className={`w-full flex items-center justify-center gap-1 py-2 rounded-xl text-[11px] font-semibold
            transition-all duration-150 tap-scale border mt-1
            ${favorited ? 'bg-rose-50 border-rose-200 text-rose-600' : 'bg-white border-rose-200/70 text-rose-500'}`}
        >
          <Heart className={`w-3 h-3 ${favorited ? 'fill-rose-500 stroke-rose-500' : 'fill-none stroke-rose-400'}`} />
          {favorited ? 'お気に入り済み ✓' : '応援する'}
        </button>
      )}
    </div>
  );
}

/* ── 通常（非compact）カード本体 ── */
function FullCardBody({
  bag, isSoldOut, isLowStock, avgRating, reviewCount, trimmedComment,
  favorited, fanBurst, onSoldOutFan,
}: {
  bag: SurpriseBagWithStore;
  isSoldOut: boolean;
  isLowStock: boolean;
  avgRating: number | null | undefined;
  reviewCount: number | undefined;
  trimmedComment: string | null | undefined;
  favorited: boolean;
  fanBurst: boolean;
  onSoldOutFan: (e: React.MouseEvent) => void;
}) {
  const pickupDay = getPickupDateLabel((bag as { createdAt?: string }).createdAt, (bag as { pickupNextDay?: boolean }).pickupNextDay);
  return (
    <>
      {/* 商品タイトル */}
      <div className="mb-2">
        <h3 className={`font-bold leading-snug tracking-tight line-clamp-2
          ${isSoldOut ? 'text-muted-foreground' : 'text-foreground text-[15px]'}`}>
          {bag.title}
        </h3>
        {avgRating && !isSoldOut && (
          <div className="flex items-center gap-1 mt-1">
            <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />
            <span className="text-[12px] font-black text-amber-500">{Number(avgRating).toFixed(1)}</span>
            {reviewCount ? (
              <span className="text-[11px] text-muted-foreground font-medium">({reviewCount}件)</span>
            ) : null}
          </div>
        )}
      </div>

      {/* 距離バッジ */}
      {!isSoldOut && bag.store.lat && bag.store.lng && (
        <div className="mb-2.5">
          <InfoDistanceBadge storeLat={bag.store.lat} storeLng={bag.store.lng} size="md" />
        </div>
      )}

      {/* 店主の一言 */}
      {trimmedComment && !isSoldOut && (
        <OwnerComment comment={trimmedComment} />
      )}

      {/* 完売時 */}
      {isSoldOut ? (
        <div className="space-y-2 mt-2">
          <p className="text-xs text-muted-foreground/60 text-center font-medium">
            次のおすそわけをお楽しみに 🌸
          </p>
          <button
            onClick={onSoldOutFan}
            className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold
              transition-all duration-150 tap-scale border
              ${favorited
                ? 'bg-rose-50 border-rose-200 text-rose-600'
                : 'bg-white border-rose-200/70 text-rose-500 hover:bg-rose-50/80'
              } ${fanBurst ? 'scale-105' : ''}`}
          >
            <Heart className={`w-4 h-4 transition-all ${favorited ? 'fill-rose-500 stroke-rose-500' : 'fill-none stroke-rose-400'}`} />
            {favorited ? 'お気に入り済み ✓' : 'このお店を応援する'}
          </button>
        </div>
      ) : (
        <>
          {/* 受取時間 ＋ 残り在庫 */}
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/60 px-2.5 py-1.5 rounded-lg">
              <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="font-semibold">受取 {(pickupDay.prefix ? pickupDay.prefix + ' ' : '') + pickupWindowsLabel(bag.pickupStart, bag.pickupEnd, (bag as { pickupStart2?: string | null }).pickupStart2, (bag as { pickupEnd2?: string | null }).pickupEnd2)}</span>
            </div>
            <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg
              ${isLowStock ? 'bg-rose-50 text-rose-600 font-semibold' : 'text-muted-foreground bg-muted/60 font-semibold'}`}>
              <Gift className={`w-3.5 h-3.5 shrink-0 ${isLowStock ? 'text-rose-500' : 'text-primary'}`} />
              <span>残り {bag.stockCount} 個</span>
            </div>
          </div>
          {/* 価格エリア */}
          <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid rgba(10,8,6,0.07)' }} data-sshide>
            <div className="flex flex-col">
              {bag.originalPrice > bag.discountedPrice ? (
                <>
                  <span className="text-[10px] text-muted-foreground/70 font-medium mb-0.5">定価</span>
                  <span className="text-sm text-muted-foreground/60 line-through decoration-rose-400/40 font-semibold leading-tight">
                    ¥{getDisplayPrice(bag.originalPrice).toLocaleString()}
                  </span>
                </>
              ) : (
                <span className="text-[10px] text-muted-foreground/50 font-medium">特別価格</span>
              )}
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-primary/60 font-semibold tracking-wide mb-0.5">おすそわけ価格</span>
              <span className="text-2xl font-black text-primary leading-none whitespace-nowrap tracking-tight">
                ¥{getDisplayPrice(bag.discountedPrice).toLocaleString()}
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function BagCard({ bag, compact = false }: BagCardProps) {
  const discountPercent = getDisplayDiscountPercent(bag.originalPrice, bag.discountedPrice);
  const isSoldOut  = bag.stockCount <= 0;
  const isLowStock = bag.stockCount > 0 && bag.stockCount <= 2;
  // ★ 「もう買えない」理由。 ended-today API が endReason を返す:
  //   sold_out = 本当に完売 / ended = 受取時間切れ(完売ではない)。
  //   店に嘘をつかない(=売れてないのに完売表示しない)ため、 バッジ文言を出し分ける。
  const isEnded    = isSoldOut && (bag as { endReason?: 'sold_out' | 'ended' }).endReason === 'ended';
  const closedLabel = isEnded ? '本日終了' : '完売御礼';
  const { isFavorite, toggle } = useFavorites();
  const { user } = useAuth();
  const { toast } = useToast();
  const storeId   = bag.store.id;
  const favorited = isFavorite(storeId);
  const [burst, setBurst]               = useState(false);
  const [imgLoaded, setImgLoaded]       = useState(false);
  const [imgError,  setImgError]        = useState(false);
  const [fanBurst, setFanBurst]         = useState(false);
  const [showLoginNudge, setShowLoginNudge] = useState(false);
  const [showReviews, setShowReviews]   = useState(false);

  function handleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!user) { setShowLoginNudge(true); return; }
    const wasNotFavorited = !favorited;
    toggle(storeId);
    if (wasNotFavorited) {
      setBurst(true);
      setTimeout(() => setBurst(false), 500);
    }
  }

  function handleSoldOutFan(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!user) { setShowLoginNudge(true); return; }
    const wasNotFavorited = !favorited;
    toggle(storeId);
    if (wasNotFavorited) {
      setFanBurst(true);
      setTimeout(() => setFanBurst(false), 500);
      toast({
        title: '💌 お気に入り登録しました！',
        description: '準備が整い次第、通知機能でお知らせできるようになります',
        duration: 4000,
      });
    } else {
      toast({ title: 'お気に入りから削除しました', duration: 2000 });
    }
  }

  const fallbackImg = getImageFromName(bag.title, bag.id) || getCategoryImage(bag.store.category, bag.id);
  const imgSrc = imgError
    ? fallbackImg
    : (bag.imageUrl || bag.store.imageUrl || fallbackImg);
  const storeComment = (bag as any).description as string | null | undefined;
  const trimmedComment = storeComment
    ? storeComment.length > 36 ? storeComment.slice(0, 35) + '…' : storeComment
    : null;
  const avgRating = (bag.store as any).avgRating as number | null | undefined;
  const reviewCount = (bag.store as any).reviewCount as number | undefined;

  // ── タップ即時プリフェッチ ─────────────────────────────────────────────
  // 商品詳細ページが「たまに遅い」原因対策:
  //   1. BagDetail の JS チャンク (React.lazy) を先読みでダウンロード
  //   2. /bags/:id の API レスポンスも React Query にプリフェッチ投入
  // pointerdown は click より約 50〜200ms 早く発火するので、 指を離す頃には
  // チャンクとデータの両方が揃ってる → ページ遷移が体感ほぼ即時になる。
  const queryClient = useQueryClient();
  const handlePrefetch = useCallback(() => {
    if (isSoldOut) return;
    // チャンク先読み (ブラウザが同一 import を重複排除)
    import('@/pages/BagDetail').catch(() => { /* 失敗は無視 */ });
    // API レスポンス先読み
    queryClient.prefetchQuery({
      queryKey: getGetBagQueryKey(bag.id),
      queryFn: () => getBag(bag.id),
      staleTime: 30_000,
    }).catch(() => { /* 失敗は無視 */ });
  }, [bag.id, isSoldOut, queryClient]);

  return (<>
    <Link
      href={isSoldOut ? '#' : `/bags/${bag.id}`}
      className={[
        'group block w-full relative rounded-2xl overflow-hidden bg-card',
        'transition-all duration-250 ease-out',
        isSoldOut
          ? 'opacity-50 cursor-not-allowed grayscale'
          : 'cursor-pointer hover:-translate-y-1 hover:shadow-[0_12px_32px_rgba(10,8,6,0.14),0_4px_8px_rgba(10,8,6,0.06)]',
      ].join(' ')}
      style={{
        boxShadow: '0 2px 8px -1px rgba(10,8,6,0.08), 0 1px 3px -1px rgba(10,8,6,0.04)',
      }}
      onClick={(e) => isSoldOut && e.preventDefault()}
      onPointerDown={handlePrefetch}
      onMouseEnter={handlePrefetch}
    >
      {/* ── 画像エリア ── */}
      {/* 暖色グラデ背景: 画像が白/透明/壊れていても寂しくならないように */}
      <div
        className={`relative w-full overflow-hidden ${compact ? 'aspect-[16/9]' : 'aspect-[4/3]'}`}
        style={{
          background:
            'radial-gradient(circle at 30% 20%, rgba(255,180,140,0.45) 0%, transparent 55%),' +
            'linear-gradient(135deg, #fde2c8 0%, #f5b893 100%)',
        }}
      >

        {!imgLoaded && <div className="absolute inset-0 skeleton-shimmer" />}

        {/* ★ key={imgSrc} で URL 変更時に <img> 自体を再マウントさせる。
              iOS/Safari の <img> 再利用時に古い decode 済みビットマップが残り
              「複数バッグの写真が同じに見える」 表示バグを防ぐ防御層。 */}
        <img
          key={imgSrc}
          src={imgSrc}
          alt={bag.store.name}
          loading="lazy"
          decoding="async"
          onLoad={() => setImgLoaded(true)}
          onError={() => { setImgError(true); setImgLoaded(true); }}
          className={`w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]
            ${imgLoaded ? 'img-fade-in' : 'opacity-0'}`}
        />

        {/* グラデーション */}
        <div className={`absolute inset-0 pointer-events-none
          ${compact
            ? 'bg-gradient-to-t from-black/40 via-transparent to-transparent'
            : 'bg-gradient-to-t from-black/65 via-black/10 to-transparent'}`} />

        {compact ? (
          /* ─── compact モード: HorizBagCard と同じシンプルオーバーレイ ─── */
          <>
            {/* 左上: 割引バッジ */}
            {!isSoldOut && discountPercent > 0 && (
              <span className="absolute top-2 left-2 bg-primary text-primary-foreground text-[10px] font-black px-1.5 py-[3px] rounded-lg shadow-sm" data-sshide>
                {discountPercent}% OFF
              </span>
            )}
            {/* 右上: 評価 + ハート (完売オーバーレイより上に置いてタップを拾わせる) */}
            <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
              {avgRating && !isSoldOut && (
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setShowReviews(true); }}
                  className="flex items-center gap-0.5 bg-emerald-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-lg shadow-sm tap-scale-sm"
                >
                  <Star className="w-2 h-2 fill-white shrink-0" />
                  {Number(avgRating).toFixed(1)}
                </button>
              )}
              <button
                onClick={handleFavorite}
                className={`w-6 h-6 flex items-center justify-center rounded-full tap-scale-sm transition-all duration-150
                  ${favorited
                    ? 'bg-rose-500 shadow-[0_1px_6px_rgba(239,68,68,0.45)]'
                    : 'bg-white/85 backdrop-blur-sm shadow-[0_1px_4px_rgba(0,0,0,0.15)]'
                  } ${burst ? 'scale-125' : ''}`}
                aria-label={favorited ? 'お気に入りから削除' : 'お気に入りに追加'}
              >
                <Heart className={`w-3 h-3 transition-all duration-150
                  ${favorited ? 'fill-white stroke-white' : 'fill-none stroke-rose-400'}`} />
              </button>
            </div>
            {/* 完売オーバーレイ (表示のみ。 pointer-events-none でハート/評価ボタンのタップを塞がない) */}
            {isSoldOut && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                <span className="bg-white/90 text-foreground text-[10px] font-black px-2 py-1 rounded-lg">{closedLabel} {isEnded ? '🌙' : '🌸'}</span>
              </div>
            )}
          </>
        ) : (
          /* ─── 通常モード: リッチオーバーレイ ─── */
          <>
            {/* 左上: 店舗名チップ */}
            <div className="absolute top-2.5 left-2.5">
              <div className="bg-white/92 backdrop-blur-sm px-2.5 py-1 rounded-full text-[11px] font-semibold
                shadow-[0_1px_4px_rgba(0,0,0,0.12)] flex items-center gap-1.5 text-foreground max-w-[58%]">
                <span className="text-sm leading-none">{getCategoryIcon(bag.store.category)}</span>
                <span className="truncate">{bag.store.name}</span>
              </div>
            </div>
            {/* 右上: 評価・ハート・割引バッジ */}
            <div className="absolute top-2.5 right-2.5 flex flex-col items-end gap-1.5">
              {avgRating && !isSoldOut && (
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setShowReviews(true); }}
                  className="flex items-center gap-0.5 bg-emerald-500 active:bg-emerald-600 text-white font-black px-2 py-0.5 rounded-full text-[11px] shadow-[0_2px_8px_rgba(16,185,129,0.45)] backdrop-blur-sm tap-scale-sm"
                >
                  <Star className="w-2.5 h-2.5 fill-white shrink-0" />
                  {Number(avgRating).toFixed(1)}
                </button>
              )}
              <button
                onClick={handleFavorite}
                className={`w-8 h-8 flex items-center justify-center rounded-full transition-all duration-150 tap-scale-sm
                  ${favorited
                    ? 'bg-rose-500 shadow-[0_2px_8px_rgba(239,68,68,0.35)]'
                    : 'bg-white/90 backdrop-blur-sm shadow-[0_1px_4px_rgba(0,0,0,0.12)]'
                  } ${burst ? 'scale-125' : ''}`}
                aria-label={favorited ? 'お気に入りから削除' : 'お気に入りに追加'}
              >
                <Heart className={`w-4 h-4 transition-all duration-150
                  ${favorited ? 'fill-white stroke-white' : 'fill-none stroke-rose-400'}`} />
              </button>
              {isSoldOut ? (
                <div className="bg-gray-800/75 text-white/85 font-bold px-2.5 py-0.5 rounded-full text-[10px] backdrop-blur-sm">
                  {isEnded ? '本日終了' : '完売'}
                </div>
              ) : (
                <>
                  {discountPercent > 0 && (
                    <div data-sshide className={`flex items-center gap-0.5 text-white font-black px-2.5 py-0.5 rounded-full text-[11px] rotate-1
                      ${discountPercent >= 20
                        ? 'bg-gradient-to-r from-[#F07826] to-[#E85A0C] shadow-[0_2px_10px_rgba(240,120,38,0.45)]'
                        : 'bg-primary shadow-[0_2px_8px_rgba(255,140,0,0.30)]'
                      }`}>
                      {discountPercent >= 20 && <Sparkles className="w-2.5 h-2.5 shrink-0" />}
                      {discountPercent}% OFF
                    </div>
                  )}
                  {isLowStock && (
                    <div className="flex items-center gap-0.5 bg-rose-500 text-white font-bold px-2 py-0.5 rounded-full text-[10px] animate-pulse shadow-[0_2px_8px_rgba(239,68,68,0.40)]">
                      🔥 残りわずか！
                    </div>
                  )}
                </>
              )}
            </div>
            {/* 完売 / 本日終了 スタンプ (時間切れは嘘にならないよう文言・色を変える) */}
            {isSoldOut && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className={`border-[3px] rounded-xl px-4 py-2 rotate-[-12deg] backdrop-blur-[1px]
                  ${isEnded ? 'border-indigo-400/60' : 'border-red-500/70'}`}>
                  <span className={`text-2xl font-black tracking-widest leading-none block text-center drop-shadow
                    ${isEnded ? 'text-indigo-300/90' : 'text-red-400/90'}`}
                    style={{ fontFamily: 'Outfit, sans-serif' }}>
                    {closedLabel}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── カード情報エリア ── */}
      <div className={compact ? 'px-3 pt-2 pb-3' : 'p-4 pb-3.5'}>
        {compact ? (
          <CompactCardBody
            bag={bag}
            isSoldOut={isSoldOut}
            isLowStock={isLowStock}
            favorited={favorited}
            fanBurst={fanBurst}
            onSoldOutFan={handleSoldOutFan}
          />
        ) : (
          <FullCardBody
            bag={bag}
            isSoldOut={isSoldOut}
            isLowStock={isLowStock}
            avgRating={avgRating}
            reviewCount={reviewCount}
            trimmedComment={trimmedComment}
            favorited={favorited}
            fanBurst={fanBurst}
            onSoldOutFan={handleSoldOutFan}
          />
        )}
      </div>
    </Link>
    <LoginNudgeSheet
      isOpen={showLoginNudge}
      onClose={() => setShowLoginNudge(false)}
      reason="favorite"
    />

    {/* 口コミシート */}
    <AnimatePresence>
      {showReviews && avgRating && (
        <StoreReviewSheet
          storeId={storeId}
          storeName={bag.store.name}
          avgRating={avgRating}
          reviewCount={reviewCount ?? 0}
          onClose={() => setShowReviews(false)}
        />
      )}
    </AnimatePresence>
  </>);
}

export function BagCardSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="rounded-2xl overflow-hidden bg-card"
      style={{ boxShadow: '0 2px 8px -1px rgba(10,8,6,0.06), 0 1px 3px -1px rgba(10,8,6,0.03)' }}>
      <div className={`w-full skeleton-shimmer ${compact ? 'aspect-[16/9]' : 'aspect-[4/3]'}`} />
      {compact ? (
        <div className="p-3 flex flex-col gap-0">
          {/* タイトル */}
          <div className="h-3 skeleton-shimmer rounded-full w-full mb-1.5" />
          <div className="h-3 skeleton-shimmer rounded-full w-3/4 mb-2" />
          {/* 距離バッジ */}
          <div className="h-4 skeleton-shimmer rounded-full w-14 mb-1" />
          {/* 受取時間 */}
          <div className="h-3 skeleton-shimmer rounded-full w-24 mb-3" />
          {/* 在庫+価格 */}
          <div className="flex items-end justify-between pt-2 border-t border-border/20">
            <div className="h-2.5 skeleton-shimmer rounded-full w-12" />
            <div className="h-5 skeleton-shimmer rounded-full w-14" />
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="h-4.5 skeleton-shimmer rounded-full w-3/4" />
          <div className="flex items-start gap-2">
            <div className="w-6 h-6 shrink-0 skeleton-shimmer rounded-full" />
            <div className="flex-1 h-8 skeleton-shimmer rounded-xl" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 skeleton-shimmer rounded-lg w-24" />
            <div className="h-7 skeleton-shimmer rounded-lg w-20" />
          </div>
          <div className="flex justify-between items-end pt-1"
            style={{ borderTop: '1px solid rgba(10,8,6,0.07)' }}>
            <div className="space-y-1.5">
              <div className="h-2.5 skeleton-shimmer rounded-full w-8" />
              <div className="h-3.5 skeleton-shimmer rounded-full w-16" />
            </div>
            <div className="h-8 skeleton-shimmer rounded-full w-24" />
          </div>
        </div>
      )}
    </div>
  );
}
