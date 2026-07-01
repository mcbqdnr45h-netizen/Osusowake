import React, { useState } from 'react';
import { useParams, useLocation, Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { Layout } from '@/components/Layout';
import { useGetStore, useListAllBags, getGetStoreQueryKey, getListAllBagsQueryKey } from '@workspace/api-client-react';
import { ArrowLeft, MapPin, Clock, Star, Navigation, ChevronRight, ExternalLink, Package } from 'lucide-react';
import { getDisplayPrice } from '@/lib/price-display';
import { getCategoryLabel } from '@/lib/category-utils';
import { normalizeBrand } from '@/lib/brand-text';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';


function StarRating({ rating }: { rating?: number | null }) {
  const r = rating ?? 0;
  return (
    <div className="flex items-center gap-0.5">
      {[1,2,3,4,5].map(i => (
        <Star
          key={i}
          className={`w-3.5 h-3.5 ${i <= Math.round(r) ? 'text-amber-400 fill-amber-400' : 'text-slate-200 fill-slate-200'}`}
        />
      ))}
    </div>
  );
}

export default function StoreDetailPublic() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params.id);
  const [, navigate] = useLocation();
  const [imgError, setImgError] = useState(false);

  const { data: store, isLoading: storeLoading } = useGetStore(storeId, {
    query: {
      queryKey: getGetStoreQueryKey(storeId),
      enabled: !isNaN(storeId),
    },
  });

  const { data: allBags } = useListAllBags(
    { query: {
      queryKey: getListAllBagsQueryKey(),
      enabled: !isNaN(storeId),
    } }
  );

  // ★ API レスポンスは bag.store.id (ネスト) で来る。 旧コードは b.storeId を見ていたため
  //    常に undefined === number で false になり「現在出品中のバッグはありません」 と誤表示していた。
  const bags = (allBags ?? []).filter(
    (b: any) => (b?.store?.id ?? b?.storeId) === storeId && (b.stockCount ?? 0) > 0,
  );

  // Google Maps ルート案内リンク。 登録ピン(lat/lng)は店が手動でズレた位置に置ける(draggable)ため、
  // 表示住所と食い違うと案内先が別の場所になる。 表示している住所を基準にして一致させる。
  const mapsUrl = store?.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${store.name} ${store.address}`)}`
    : null;

  if (storeLoading) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
          <div className="w-10 h-10 rounded-full border-3 border-primary border-t-transparent animate-spin" />
          <p className="text-sm text-muted-foreground">読み込み中...</p>
        </div>
      </Layout>
    );
  }

  if (!store) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6 text-center">
          <div className="text-5xl">🏪</div>
          <p className="font-bold text-foreground">店舗が見つかりません</p>
          <button onClick={() => navigate('/')} className="text-primary text-sm font-bold underline underline-offset-2">
            ホームに戻る
          </button>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-lg md:max-w-3xl mx-auto pb-28">

        {/* ── ヒーロー写真 + 戻るボタン ── */}
        <div className="relative">
          {store.imageUrl && !imgError ? (
            <img
              src={store.imageUrl}
              alt={store.name}
              onError={() => setImgError(true)}
              className="w-full h-52 object-cover"
            />
          ) : (
            <div className="w-full h-52 bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
              <span className="text-7xl opacity-30">🏪</span>
            </div>
          )}

          {/* グラデーションオーバーレイ */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-transparent" />

          {/* 戻るボタン */}
          <button
            onClick={() => window.history.back()}
            className="absolute top-4 left-4 w-9 h-9 rounded-full bg-white/90 backdrop-blur-sm shadow-md flex items-center justify-center text-foreground hover:bg-white transition-colors active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>

        {/* ── 店舗情報 ── */}
        <div className="px-5 pt-5 space-y-5">

          {/* 店舗名・カテゴリ・評価 */}
          <div>
            <div className="flex items-start justify-between gap-2 mb-2">
              <h1 className="text-2xl font-black text-foreground leading-tight flex-1" style={{ letterSpacing: '-0.02em' }}>
                {store.name}
              </h1>
              {store.category && (
                <span className="mt-1 shrink-0 px-2.5 py-1 bg-primary/10 text-primary text-xs font-bold rounded-full">
                  {getCategoryLabel(store.category)}
                </span>
              )}
            </div>
            {store.rating != null && store.rating > 0 && (
              <div className="flex items-center gap-2">
                <StarRating rating={store.rating} />
                <span className="text-sm font-bold text-amber-600">{store.rating.toFixed(1)}</span>
              </div>
            )}
          </div>

          {/* ── ルート案内ボタン（メイン CTA）── */}
          {mapsUrl && (
            <motion.a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="flex items-center justify-center gap-2.5 w-full py-4 rounded-2xl font-black text-white text-base shadow-md shadow-primary/25 active:scale-[0.98] transition-transform"
              style={{ background: 'linear-gradient(135deg, #F26419 0%, #d44a00 100%)' }}
            >
              <Navigation className="w-5 h-5" />
              ルートを案内する
              <ExternalLink className="w-4 h-4 opacity-70" />
            </motion.a>
          )}

          {/* ── 住所・営業時間 ── */}
          <div className="bg-secondary/40 rounded-2xl divide-y divide-border/50 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <MapPin className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">住所</p>
                <p className="text-sm font-medium text-foreground leading-snug">
                  {[store.address, store.city].filter(Boolean).join('、')}
                </p>
              </div>
            </div>

            {(store.openTime || store.closeTime) && (
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Clock className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">営業時間</p>
                  <p className="text-sm font-medium text-foreground">
                    {store.openTime ?? '?'} 〜 {store.closeTime ?? '?'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* ── 店舗説明 ── */}
          {store.description && (
            <div>
              <h2 className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-2">店舗について</h2>
              <p className="text-sm text-foreground/80 leading-relaxed">{store.description}</p>
            </div>
          )}

          {/* ── 現在のおすそわけバッグ ── */}
          <div>
            <h2 className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-3">
              おすそわけバッグ
              {bags.length > 0 && (
                <span className="ml-2 text-primary normal-case font-bold">{bags.length}件</span>
              )}
            </h2>

            {bags.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center bg-secondary/30 rounded-2xl">
                <Package className="w-8 h-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground font-medium">現在出品中のバッグはありません</p>
              </div>
            ) : (
              <div className="space-y-3">
                <AnimatePresence>
                  {bags.map((bag: any, i: number) => (
                    <motion.div
                      key={bag.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                    >
                      <Link href={`${BASE}/bags/${bag.id}`}>
                        <div className="flex items-center gap-3 bg-card border border-border/60 rounded-2xl px-4 py-3.5 hover:border-primary/30 hover:bg-primary/[0.02] transition-all active:scale-[0.98] cursor-pointer">
                          <div className="flex-1 min-w-0">
                            {(bag as any).itemType === 'item' && (
                              <span className="inline-block text-[9px] font-black px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 mb-1 leading-none">🥡 単品</span>
                            )}
                            <p className="font-bold text-sm text-foreground leading-snug truncate">{normalizeBrand(bag.title)}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-base font-black text-primary">
                                ¥{getDisplayPrice(bag.discountedPrice ?? bag.price).toLocaleString()}
                              </span>
                              {bag.originalPrice && bag.discountedPrice && bag.originalPrice !== bag.discountedPrice && (
                                <span className="text-xs text-muted-foreground line-through">
                                  ¥{getDisplayPrice(bag.originalPrice).toLocaleString()}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground">残り {bag.stockCount}個</span>
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* ── Googleマップで開く（サブリンク）── */}
          {mapsUrl && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${store.name} ${store.address}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <MapPin className="w-4 h-4" />
              Googleマップで表示する
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

        </div>
      </div>
    </Layout>
  );
}
