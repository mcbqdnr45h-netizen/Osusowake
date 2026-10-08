import React, { useEffect, useState } from 'react';
import { Layout } from '@/components/Layout';
import { StoreLayout } from '@/components/StoreLayout';
import { Heart, Store, ArrowRight, MapPin, CalendarClock, HandHeart } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Link, useLocation } from 'wouter';
import { useListAllBags, useListStores } from '@workspace/api-client-react';
import { useFavorites } from '@/hooks/useFavorites';
import { BagCard } from '@/components/BagCard';
import { getCategoryIcon } from '@/lib/category-utils';
import { motion, AnimatePresence } from 'framer-motion';
import { authedFetch } from '@/lib/authed-fetch';
import { useToast } from '@/hooks/use-toast';
import { optimizedImage, IMG_W } from '@/lib/image-utils';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** JST の YYYY-MM-DD（出品リクエストの「今日はもう送った」判定用） */
function jstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
function fmtNextDrop(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const today = jstToday();
  if (dateStr === today) return '今日';
  return `${m}/${d}(${wd})`;
}

export default function FavoritesPage() {
  const { profile } = useAuth();
  const { favorites, toggle, isFavorite } = useFavorites();
  const { data: bags, isLoading: bagsLoading } = useListAllBags();
  const { data: stores, isLoading: storesLoading } = useListStores();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const isLoading = bagsLoading || storesLoading;
  const isStoreOwner = profile?.role === 'store_owner';

  const favoriteStores = stores?.filter(s => isFavorite(s.id)) ?? [];

  const favoriteBags = bags?.filter(b => isFavorite(b.store.id)) ?? [];

  // ── 各お気に入り店の「次回出品予定」(公開API・PIIなし) ──
  const [nextDrops, setNextDrops] = useState<Record<number, { pickupDate: string; pickupStart: string | null; pickupEnd: string | null } | null>>({});
  useEffect(() => {
    let alive = true;
    const ids = favoriteStores.map(s => s.id).filter(id => !(id in nextDrops));
    if (ids.length === 0) return;
    Promise.all(ids.map(async id => {
      try {
        const r = await fetch(`${BASE}/api/stores/${id}/next-drop`);
        const d = await r.json();
        return [id, d?.next ?? null] as const;
      } catch { return [id, null] as const; }
    })).then(pairs => {
      if (!alive) return;
      setNextDrops(prev => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteStores.map(s => s.id).join(',')]);

  // ── 出品リクエスト（1店1日1回） ──
  const [requested, setRequested] = useState<Set<number>>(() => {
    const set = new Set<number>();
    try {
      const today = jstToday();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const m = k?.match(/^listing-req-(\d+)-(.+)$/);
        if (m && m[2] === today) set.add(Number(m[1]));
      }
    } catch { /* localStorage不可でもボタンは動く */ }
    return set;
  });
  const [requesting, setRequesting] = useState<number | null>(null);

  async function requestListing(storeId: number, storeName: string) {
    if (requested.has(storeId) || requesting !== null) return;
    setRequesting(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/request-listing`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((d as { message?: string }).message || '送信に失敗しました');
      try { localStorage.setItem(`listing-req-${storeId}-${jstToday()}`, '1'); } catch { /* noop */ }
      setRequested(prev => new Set(prev).add(storeId));
      toast({
        title: (d as { already?: boolean }).already ? 'リクエスト済みです' : `🙏 ${storeName} にリクエストを送りました`,
        description: (d as { already?: boolean }).already ? '本日分はすでに届いています' : '出品されるとプッシュ通知でお知らせします',
      });
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally { setRequesting(null); }
  }

  const content = (
    <div
      className="w-full"
      style={{ paddingTop: isStoreOwner ? 'calc(env(safe-area-inset-top) + 1.25rem)' : '1.25rem' }}
    >

        {/* Header */}
        <div className="flex items-center gap-3 mb-5 px-4">
          <div className="w-10 h-10 bg-rose-100 rounded-full flex items-center justify-center shrink-0">
            <Heart className="w-5 h-5 fill-rose-500 text-rose-500" />
          </div>
          <div>
            <h1 className="text-xl font-black">お気に入り</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {favoriteStores.length > 0
                ? `${favoriteStores.length}店舗をフォロー中`
                : 'お気に入りの店舗をフォローしましょう'}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 gap-2.5 px-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-52 bg-card rounded-2xl animate-pulse border border-border" />
            ))}
          </div>
        ) : favoriteStores.length === 0 ? (
          /* ── Empty State ── */
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4"
          >
            <div className="relative mb-6">
              <div className="w-28 h-28 bg-rose-50 border-2 border-rose-100 rounded-full flex items-center justify-center">
                <Heart className="w-14 h-14 text-rose-200" strokeWidth={1.5} />
              </div>
              <div className="absolute -bottom-1 -right-1 text-3xl">🛍️</div>
            </div>
            <h2 className="text-xl font-black mb-2 text-foreground">
              まだお気に入り店舗がありません
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-xs md:max-w-xl mb-8">
              お店のカードにある <Heart className="inline w-3.5 h-3.5 text-rose-400" /> をタップして、<br />
              お気に入りの店舗をフォローしましょう！
            </p>
            <Link href="/">
              <button className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-8 py-3.5 rounded-full shadow-lg hover:bg-primary/90 transition-all active:scale-95">
                お店を探してみる
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
          </motion.div>
        ) : (
          <>
            {/* フォロー中の店舗（情報付きカード） */}
            <div className="mb-5 px-4">
              <h2 className="text-sm font-bold text-muted-foreground mb-3 uppercase tracking-wide">フォロー中の店舗</h2>
              <div className="space-y-2.5">
                {favoriteStores.map(store => {
                  const liveCount = favoriteBags.filter(b => b.store.id === store.id).length;
                  const next = nextDrops[store.id];
                  const isReq = requested.has(store.id);
                  return (
                    <div key={store.id} className="bg-card border border-border rounded-2xl p-3.5">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => navigate(`/stores/${store.id}`)}
                          className="w-11 h-11 rounded-xl overflow-hidden bg-secondary shrink-0 flex items-center justify-center text-lg">
                          {(store as { iconUrl?: string | null }).iconUrl
                            ? <img src={optimizedImage((store as { iconUrl?: string | null }).iconUrl, IMG_W.icon)} alt="" className="w-full h-full object-cover" />
                            : <span>{getCategoryIcon(store.category)}</span>}
                        </button>
                        <button type="button" onClick={() => navigate(`/stores/${store.id}`)} className="flex-1 min-w-0 text-left">
                          <p className="font-black text-foreground text-[15px] truncate">{store.name}</p>
                          <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
                            <span>{getCategoryIcon(store.category)}</span>
                            {(store as { city?: string | null }).city && (<><MapPin className="w-3 h-3 shrink-0" />{(store as { city?: string | null }).city}</>)}
                          </p>
                        </button>
                        <button type="button" onClick={() => toggle(store.id)} aria-label="お気に入り解除"
                          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0">
                          <Heart className="w-5 h-5 fill-rose-500 text-rose-500" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-2.5">
                        {liveCount > 0 ? (
                          <span className="text-[11px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                            🟢 いま出品中 {liveCount}件
                          </span>
                        ) : next ? (
                          <span className="text-[11px] font-black text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full flex items-center gap-1">
                            <CalendarClock className="w-3 h-3" />
                            次回 {fmtNextDrop(next.pickupDate)}{next.pickupStart ? ` ${next.pickupStart}〜` : ''} 受取
                          </span>
                        ) : (
                          <span className="text-[11px] font-bold text-muted-foreground bg-secondary/60 px-2.5 py-1 rounded-full">
                            出品予定は未定
                          </span>
                        )}
                        {/* 出品リクエスト: 出品中の店には出さない（意味がないため） */}
                        {liveCount === 0 && (
                          <button
                            type="button"
                            onClick={() => requestListing(store.id, store.name)}
                            disabled={isReq || requesting === store.id}
                            className={`ml-auto text-[11px] font-black px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors ${
                              isReq
                                ? 'bg-secondary text-muted-foreground'
                                : 'bg-rose-500 text-white active:scale-95'
                            }`}
                          >
                            <HandHeart className="w-3.5 h-3.5" />
                            {isReq ? 'リクエスト済み' : requesting === store.id ? '送信中…' : '出品リクエスト'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Bags from Favorited Stores */}
            <div>
              <h2 className="text-sm font-bold text-muted-foreground mb-3 uppercase tracking-wide flex items-center gap-1.5 px-4">
                <Store className="w-3.5 h-3.5" />
                お気に入り店舗の出品中バッグ
                {favoriteBags.length > 0 && (
                  <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-full font-black text-xs">
                    {favoriteBags.length}件
                  </span>
                )}
              </h2>

              {favoriteBags.length === 0 ? (
                <div className="mx-4 text-center py-12 bg-card rounded-2xl border-2 border-dashed border-border">
                  <div className="text-4xl mb-3">😴</div>
                  <p className="font-bold text-foreground mb-1">現在出品中のバッグはありません</p>
                  <p className="text-xs text-muted-foreground">
                    お気に入り店舗が出品したら、ここに表示されます
                  </p>
                </div>
              ) : (
                <AnimatePresence>
                  <motion.div
                    className="grid grid-cols-2 gap-2.5 px-3"
                    initial="hidden"
                    animate="show"
                    variants={{
                      hidden: { opacity: 0 },
                      show: { opacity: 1, transition: { staggerChildren: 0.06 } },
                    }}
                  >
                    {favoriteBags.map(bag => (
                      <motion.div
                        key={bag.id}
                        variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
                      >
                        <BagCard bag={bag} compact />
                      </motion.div>
                    ))}
                  </motion.div>
                </AnimatePresence>
              )}
            </div>
          </>
        )}
      </div>
  );

  if (isStoreOwner) return <StoreLayout showHeader={false}>{content}</StoreLayout>;
  return <Layout>{content}</Layout>;
}
