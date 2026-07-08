import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  Package, Store, Clock, QrCode,
  ChevronRight, Home, Copy, Check, Sparkles, Receipt,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { formatPickupTime, pickupWindowsLabel, getPickupDateLabel } from '@/lib/utils';
import confetti from 'canvas-confetti';
import { useQueryClient } from '@tanstack/react-query';
import { useUserId } from '@/hooks/use-user';
import { listReservations, getListReservationsQueryKey } from '@workspace/api-client-react';


interface OrderReceipt {
  status: string;
  reservationId: number;
  pickupCode: string | null;
  bagTitle: string | null;
  storeName: string | null;
  totalPrice: number;
  pickupStart: string | null;
  pickupEnd: string | null;
  pickupStart2?: string | null;
  pickupEnd2?: string | null;
  pickupNextDay?: boolean | null;
  bagCreatedAt?: string | null;
}

function fireConfetti() {
  const colors = ['#FF8C00', '#FFD700', '#FF4500', '#FFA07A', '#FF6347', '#FFB347', '#fff'];
  confetti({ particleCount: 140, spread: 80, origin: { y: 0.55 }, colors, scalar: 1.2 });
  const end = Date.now() + 2800;
  const frame = () => {
    confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors });
    confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  setTimeout(frame, 350);
}

export default function CheckoutSuccess() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const userId = useUserId();
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [codeCopied, setCodeCopied] = useState(false);
  const [confettiFired, setConfettiFired] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const sessionId    = params.get('session_id');
  const reservationId = params.get('reservation_id');

  // ★ 決済成功直後に予約一覧 (マイバッグ / 購入履歴 / マイページ統計) のキャッシュを無効化 + 事前取得。
  //   - invalidateQueries(refetchType:'all'): inactive な query も即 stale + 次回マウントで即 refetch。
  //   - prefetchQuery: マイバッグ / 購入履歴 で実際に使う queryKey を事前に取得しておくことで、
  //     ユーザがボトムナビで遷移した瞬間に「ローディング無し」で最新データが表示される。
  function refreshReservationCaches() {
    try {
      // 1) 既存キャッシュを全部 stale に + active なら即 refetch
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0];
          return typeof k === 'string' && k.startsWith('/api/reservations');
        },
        refetchType: 'all',
      });
      // 在庫数 (買った直後の残数表示) も最新化
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0];
          return typeof k === 'string' && (
            k.startsWith('/api/stores') || k.startsWith('/api/bags')
          );
        },
        refetchType: 'all',
      });

      // 2) マイバッグ / 購入履歴 / マイページ統計 で使う queryKey を実際に prefetch。
      //    こうしないと「未訪問の画面」へ初回遷移時はキャッシュ空でローディングが出てしまう。
      if (userId) {
        const params = { userId };
        queryClient.prefetchQuery({
          queryKey: getListReservationsQueryKey(params),
          queryFn: ({ signal }) => listReservations(params, { signal }),
        });
      }
    } catch { /* noop */ }
  }

  useEffect(() => {
    if (!sessionId || !reservationId) { setLoading(false); return; }
    // ★ verify 結果を待たずに即座にキャッシュ更新を発火 (Stripe verify 往復の 1〜2 秒を待たない)。
    refreshReservationCaches();

    fetch(`/api/checkout/verify?session_id=${sessionId}&reservation_id=${reservationId}`)
      .then(r => r.json())
      .then((data) => {
        setReceipt(data);
        setLoading(false);
        // verify 完了後にもう一度 (webhook で confirmed/paid 確定済みのデータで上書き)
        refreshReservationCaches();
      })
      .catch(() => setLoading(false));
    // userId は遅延ロードされる事があるため依存に含めると二重発火リスクあり → 意図的に空配列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // userId が後から確定したら、その時点で prefetch を一度走らせて即表示を保証
  useEffect(() => {
    if (userId) refreshReservationCaches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!loading && !confettiFired) { setConfettiFired(true); fireConfetti(); }
  }, [loading]);

  useEffect(() => {
    window.history.pushState(null, '', window.location.href);
    const handlePop = () => navigate('/my-reservations');
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [navigate]);

  function copyCode() {
    if (!receipt?.pickupCode) return;
    navigator.clipboard.writeText(receipt.pickupCode).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  }

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground font-medium">決済を確認中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-8 overflow-hidden">
      <div className="max-w-md md:max-w-2xl mx-auto">

        {/* ── おもてなしヘッダー ── */}
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 18 }}
          className="flex flex-col items-center text-center mb-7"
        >
          <div className="relative mb-5">
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15, type: 'spring', stiffness: 300 }}
              className="w-28 h-28 bg-gradient-to-br from-orange-100 to-amber-100 rounded-full flex items-center justify-center shadow-lg shadow-orange-200/60 border-4 border-white"
            >
              <span className="text-6xl leading-none select-none">🧑‍🍳</span>
            </motion.div>
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 1.3, 1], opacity: [0, 1, 1] }}
              transition={{ delay: 0.5, duration: 0.45 }}
              className="absolute -top-1 -right-1 w-9 h-9 bg-gradient-to-br from-amber-400 to-orange-500 rounded-full flex items-center justify-center shadow-lg"
            >
              <Sparkles className="w-4 h-4 text-white" />
            </motion.div>
          </div>

          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-3xl font-black text-foreground leading-tight"
          >
            ナイスおすそわけ！
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="text-muted-foreground text-sm mt-2 leading-relaxed font-medium"
          >
            お店でお待ちしています 🎉
          </motion.p>
        </motion.div>

        {/* ── おすそわけ受付票 ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-card border border-border rounded-3xl overflow-hidden shadow-sm mb-4"
        >
          <div className="bg-gradient-to-r from-primary to-orange-400 px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-white" />
              <span className="text-white font-black text-sm tracking-wide">おすそわけ受付票</span>
            </div>
            {reservationId && (
              <span className="text-white/80 text-xs font-mono bg-white/15 px-2 py-1 rounded-lg">
                #{String(reservationId).padStart(6, '0')}
              </span>
            )}
          </div>

          <div className="p-5 space-y-4">
            {receipt?.storeName && (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Store className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">お店</p>
                  <p className="font-black text-foreground text-base">{receipt.storeName}</p>
                </div>
              </div>
            )}

            {receipt?.bagTitle && (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Package className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">商品</p>
                  <p className="font-bold text-foreground">{receipt.bagTitle}</p>
                </div>
              </div>
            )}

            {(receipt?.pickupStart || receipt?.pickupEnd) && (() => {
              // ★ 受取「日付」も明示する（前日出品バッグで来店日を誤解する事故の再発防止）。
              //   bagCreatedAt(公開日・JST) + pickupNextDay で実際の受取日を算出。
              const label = getPickupDateLabel(receipt.bagCreatedAt, receipt.pickupNextDay ?? false);
              let dateLabel = '';
              if (receipt.bagCreatedAt) {
                const created = new Date(receipt.bagCreatedAt);
                if (!isNaN(created.getTime())) {
                  const jstYmd = created.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
                  const [yy, mm, dd] = jstYmd.split('-').map(Number);
                  const dt = new Date(Date.UTC(yy, mm - 1, dd + (receipt.pickupNextDay ? 1 : 0)));
                  const wd = ['日', '月', '火', '水', '木', '金', '土'][dt.getUTCDay()];
                  dateLabel = `${dt.getUTCMonth() + 1}月${dt.getUTCDate()}日(${wd})`;
                }
              }
              const windowLabel = pickupWindowsLabel(receipt.pickupStart, receipt.pickupEnd, receipt.pickupStart2, receipt.pickupEnd2) || formatPickupTime(receipt.pickupStart, receipt.pickupEnd);
              return (
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                    <Clock className="w-4 h-4 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                      受け取り日時
                      {label.isTomorrow && (
                        <span className="normal-case tracking-normal text-[10px] font-black text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">🌙 明日</span>
                      )}
                    </p>
                    <p className="font-black text-foreground text-base text-amber-700">
                      {dateLabel && <span>{dateLabel} </span>}{windowLabel}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">この日時にご来店ください</p>
                  </div>
                </div>
              );
            })()}

            {receipt?.totalPrice !== undefined && (
              <div className="flex items-center justify-between pt-4 border-t border-border/60">
                <span className="text-sm font-bold text-muted-foreground">お支払い金額</span>
                <span className="text-2xl font-black text-foreground">¥{receipt.totalPrice.toLocaleString()}</span>
              </div>
            )}
          </div>
        </motion.div>

        {/* ── 受取コード ── */}
        {receipt?.pickupCode && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.38 }}
            className="bg-card border-2 border-primary/30 rounded-3xl p-5 mb-4 shadow-sm"
          >
            <div className="flex items-center gap-2 mb-3">
              <QrCode className="w-4 h-4 text-primary" />
              <p className="text-sm font-black text-foreground">お店での受取コード</p>
              <span className="ml-auto text-[10px] bg-primary/10 text-primary font-bold px-2 py-0.5 rounded-full">
                店員に見せてください
              </span>
            </div>
            <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-2xl py-6 flex items-center justify-center mb-3 border border-primary/15">
              <span className="text-5xl font-black font-mono tracking-[0.3em] text-primary">
                {receipt.pickupCode}
              </span>
            </div>
            <button
              onClick={copyCode}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-border hover:bg-muted transition-colors text-sm font-bold text-muted-foreground tap-scale"
            >
              {codeCopied ? (
                <><Check className="w-4 h-4 text-green-500" /><span className="text-green-500">コピーしました！</span></>
              ) : (
                <><Copy className="w-4 h-4" />コードをコピー</>
              )}
            </button>
          </motion.div>
        )}

        {/* ── ナビゲーション（導線強化）── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.62 }}
          className="space-y-3"
        >
          {/* メインCTA：予約内容を確認する */}
          <button
            onClick={() => navigate('/my-reservations')}
            className="w-full bg-primary text-white rounded-2xl font-black text-base flex items-center justify-center gap-2.5 py-4 hover:bg-primary/90 transition-all shadow-md shadow-primary/25 tap-scale"
          >
            <Receipt className="w-5 h-5 shrink-0" />
            <span>予約内容を確認する</span>
            <ChevronRight className="w-4 h-4 ml-auto shrink-0" />
          </button>

          {/* 説明テキスト */}
          <p className="text-center text-xs text-muted-foreground px-2">
            受取コードやお店の情報は「お届け」タブから<br className="hidden sm:inline" />いつでも確認できます
          </p>

          {/* サブCTA：トップに戻る */}
          <button
            onClick={() => navigate('/')}
            className="w-full bg-secondary text-foreground rounded-2xl font-bold text-base flex items-center justify-center gap-2.5 py-3.5 hover:bg-secondary/80 transition-all border border-border tap-scale"
          >
            <Home className="w-5 h-5 shrink-0" />
            <span>トップに戻る</span>
          </button>
        </motion.div>


        {/* 底部余白（safe-area対応） */}
        <div className="pb-safe-4 mt-4" />

      </div>
    </div>
  );
}
