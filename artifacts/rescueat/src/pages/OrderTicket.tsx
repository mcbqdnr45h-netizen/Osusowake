import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useRoute, useLocation } from 'wouter';
import { Layout } from '@/components/Layout';
import { useGetReservation } from '@workspace/api-client-react';
import { formatPickupTime, effectivePickupDate } from '@/lib/utils';
import { normalizeBrand } from '@/lib/brand-text';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useMotionValue, useTransform, animate, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Clock, MapPin, CheckCircle2,
  ChevronRight, AlertCircle, Leaf,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { toUserErrorMessage } from '@/lib/error-message';
import { ReviewModal } from '@/components/ReviewModal';
import { useUserId } from '@/hooks/use-user';
import { authedFetch } from '@/lib/authed-fetch';

// ─── localStorage helpers ─────────────────────────────────────────────────

const storageKey = (id: number) => `rescueat_ticket_${id}`;

interface TicketRecord {
  status: 'picked_up';
  pickedUpAt: string;
}

function readTicket(id: number): TicketRecord | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TicketRecord;
    return parsed.status === 'picked_up' ? parsed : null;
  } catch { return null; }
}

function writeTicket(id: number, record: TicketRecord) {
  try { localStorage.setItem(storageKey(id), JSON.stringify(record)); } catch {}
}

// ─── 6桁コード変換（既存RES-XXXXも対応）───────────────────────────────────

function toDisplayCode(pickupCode: string | null | undefined, reservationId: number): string {
  if (pickupCode && /^\d{6}$/.test(pickupCode)) return pickupCode;
  // Legacy RES-XXXX → derive display code deterministically
  const n = ((reservationId * 48271 + 23456) % 900000) + 100000;
  return String(n);
}

// ─── Date formatters ──────────────────────────────────────────────────────

function formatDatetime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).replace(/\//g, '/');
}


// ─── 6桁コード表示 ────────────────────────────────────────────────────────

function SixDigitCode({ code }: { code: string }) {
  const digits = code.replace(/\D/g, '').slice(0, 6).padStart(6, '0');
  const first = digits.slice(0, 3);
  const second = digits.slice(3, 6);

  return (
    <div className="flex items-center justify-center gap-2 select-none w-full max-w-full">
      {/* 前3桁 */}
      <div className="flex gap-1">
        {first.split('').map((d, i) => (
          <motion.div
            key={`a${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className="w-8 h-11 bg-primary/10 border-2 border-primary/25 rounded-xl flex items-center justify-center"
          >
            <span className="font-mono font-black text-[22px] text-primary tracking-tight">{d}</span>
          </motion.div>
        ))}
      </div>
      {/* セパレーター */}
      <span className="text-lg font-black text-primary/30 mb-0.5 shrink-0">–</span>
      {/* 後3桁 */}
      <div className="flex gap-1">
        {second.split('').map((d, i) => (
          <motion.div
            key={`b${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: (i + 3) * 0.06 }}
            className="w-8 h-11 bg-primary/10 border-2 border-primary/25 rounded-xl flex items-center justify-center"
          >
            <span className="font-mono font-black text-[22px] text-primary tracking-tight">{d}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ─── スワイプスライダー ────────────────────────────────────────────────────

function SwipeSlider({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);

  const THUMB = 60;
  const PAD = 4;
  const trackWidth = trackRef.current?.offsetWidth ?? 340;
  const maxX = trackWidth - THUMB - PAD * 2;

  const fill = useTransform(x, [0, maxX * 0.5], [0, 1]);
  const labelOpacity = useTransform(x, [0, maxX * 0.25], [1, 0]);

  const onDragEnd = useCallback(async () => {
    if (confirming) return;
    if (x.get() >= maxX * 0.78) {
      setConfirming(true);
      await animate(x, maxX, { duration: 0.12 });
      try {
        await onConfirm();
        setDone(true);
      } catch {
        await animate(x, 0, { type: 'spring', stiffness: 320, damping: 32 });
      } finally {
        setConfirming(false);
      }
    } else {
      animate(x, 0, { type: 'spring', stiffness: 320, damping: 32 });
    }
  }, [confirming, x, maxX, onConfirm]);

  if (done) return null;

  return (
    <div
      ref={trackRef}
      className="relative rounded-2xl overflow-hidden select-none"
      style={{ height: 68, background: '#e8f0ee' }}
    >
      {/* 緑塗り */}
      <motion.div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(90deg, #2D5A51 0%, #3d7a6e 100%)',
          opacity: fill,
        }}
      />
      {/* ラベル */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center gap-2 pointer-events-none"
        style={{ opacity: labelOpacity }}
      >
        <ChevronRight className="w-4 h-4 text-primary/50" />
        <span className="text-sm font-black text-primary/70 tracking-wide">右にスワイプして受取完了</span>
        <ChevronRight className="w-4 h-4 text-primary/50" />
      </motion.div>
      {/* サム */}
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: maxX }}
        dragElastic={0}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        style={{ x, position: 'absolute', top: PAD, left: PAD, width: THUMB, height: THUMB }}
        className="rounded-xl bg-primary shadow-lg shadow-primary/40 flex items-center justify-center cursor-grab active:cursor-grabbing z-10"
      >
        {confirming
          ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          : <ChevronRight className="w-7 h-7 text-white" />}
      </motion.div>
    </div>
  );
}

// ─── 受取済みスタンプ ─────────────────────────────────────────────────────

function PickedUpStamp({ pickedUpAt }: { pickedUpAt: string }) {
  return (
    <motion.div
      initial={{ scale: 0.4, opacity: 0, rotate: -15 }}
      animate={{ scale: 1, opacity: 1, rotate: -5 }}
      transition={{ type: 'spring', stiffness: 260, damping: 17, delay: 0.05 }}
      className="flex flex-col items-center gap-4"
    >
      {/* スタンプ枠 */}
      <div
        className="relative border-[4px] border-slate-300 rounded-3xl px-10 py-6 text-center"
        style={{ boxShadow: 'inset 0 0 0 2px #cbd5e1, 0 0 0 1px #e2e8f0' }}
      >
        {/* チェックアイコン */}
        <CheckCircle2 className="w-12 h-12 text-slate-300 mx-auto mb-2" />
        {/* テキスト */}
        <p className="text-[28px] font-black text-slate-400 tracking-[0.15em]">受取済み</p>
        <p className="text-xs font-bold text-slate-400/60 tracking-widest mt-0.5">PICKED UP ✓</p>
      </div>

      {/* 完了日時 */}
      <div className="text-center">
        <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-wider mb-1">完了日時</p>
        <p className="text-base font-black text-slate-500">{pickedUpAt}</p>
      </div>
    </motion.div>
  );
}

// ─── メインページ ──────────────────────────────────────────────────────────

export default function OrderTicket() {
  const [, params] = useRoute('/orders/:id');
  const reservationId = params?.id ? parseInt(params.id) : 0;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const userId = useUserId();

  const queryClient = useQueryClient();
  const { data: reservation, isLoading, refetch } = useGetReservation(reservationId);

  // localStorage から初期状態を読み込み
  const [ticket, setTicket] = useState<TicketRecord | null>(() => readTicket(reservationId));
  const [showReview, setShowReview] = useState(false);

  // 初回ロード時のステータスを記録（セッション中の変化と区別するため）
  const initialStatusRef = useRef<string | null>(null);
  // このセッションでボタン操作により受取完了した場合は true（レビューモーダル優先）
  const justCompletedRef = useRef(false);
  // 自動遷移用タイマー群（モーダル未表示時のフォールバック / レビューモーダル表示用 / 409遷移用）
  // すべて ref で保持し、アンマウント・モーダル表示・遷移時にまとめて解除する
  const autoNavTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showReviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigatingRef      = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (autoNavTimerRef.current) {
      clearTimeout(autoNavTimerRef.current);
      autoNavTimerRef.current = null;
    }
    if (showReviewTimerRef.current) {
      clearTimeout(showReviewTimerRef.current);
      showReviewTimerRef.current = null;
    }
  }, []);

  // 履歴へ戻る（重複呼び出し防止 + タイマー解除）
  const goToHistory = useCallback(() => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    clearAllTimers();
    queryClient.invalidateQueries({ predicate: q => q.queryKey.join('/').includes('reservations') });
    navigate('/my-reservations');
  }, [navigate, queryClient, clearAllTimers]);

  // アンマウント時にタイマー解除
  useEffect(() => {
    return () => clearAllTimers();
  }, [clearAllTimers]);

  // ★ レビューモーダルが表示されたら、フォールバック自動遷移タイマーを解除する
  //    （レビュー入力中に強制遷移されてしまうのを防ぐ）
  useEffect(() => {
    if (showReview && autoNavTimerRef.current) {
      clearTimeout(autoNavTimerRef.current);
      autoNavTimerRef.current = null;
    }
  }, [showReview]);

  // DBのステータスと同期
  useEffect(() => {
    if (reservation?.status === 'picked_up' && !ticket) {
      const record: TicketRecord = { status: 'picked_up', pickedUpAt: new Date().toISOString() };
      writeTicket(reservationId, record);
      setTicket(record);
    }
  }, [reservation?.status, reservationId, ticket]);

  // 最初から受取済みの場合は履歴（マイ予約）へ自動遷移
  // ※ このセッションでボタン操作した場合（justCompletedRef）はレビューモーダル優先のためスキップ
  useEffect(() => {
    if (justCompletedRef.current) return;

    // localStorage に受取済み記録がある場合は即遷移（API待ち不要）
    if (ticket?.status === 'picked_up') {
      navigate('/my-reservations');
      return;
    }
    if (!reservation) return;
    // 初回ロード時のステータスを記録
    if (initialStatusRef.current === null) {
      initialStatusRef.current = reservation.status;
    }
    // ページを開いた時点ですでに picked_up なら履歴へ
    if (initialStatusRef.current === 'picked_up') {
      navigate('/my-reservations');
    }
  }, [reservation, ticket, navigate]);

  const handleConfirmPickup = useCallback(async () => {
    const res = await authedFetch(`/api/reservations/${reservationId}/pickup`, { method: 'POST' });

    if (res.status === 409) {
      // 既に使用済み → 即座に履歴へ
      const record: TicketRecord = { status: 'picked_up', pickedUpAt: new Date().toISOString() };
      writeTicket(reservationId, record);
      setTicket(record);
      toast({ title: 'このチケットは既に使用済みです', description: '履歴に戻ります' });
      // タイマーを ref で保持してアンマウント・goToHistory 時に解除されるようにする
      autoNavTimerRef.current = setTimeout(() => goToHistory(), 600);
      throw new Error('already_used');
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error('[OrderTicket] confirmPickup failed:', res.status, errBody);
      toast({
        title: '受取に失敗しました',
        description: toUserErrorMessage(
          { ...errBody, status: res.status },
          'お店のスタッフにお声がけください',
        ),
        variant: 'destructive',
      });
      throw new Error('failed');
    }

    // ボタン操作による完了 → 自動遷移を一時停止（レビューモーダル優先）
    justCompletedRef.current = true;
    const record: TicketRecord = { status: 'picked_up', pickedUpAt: new Date().toISOString() };
    writeTicket(reservationId, record);
    setTicket(record);
    await refetch();
    queryClient.invalidateQueries({ predicate: q => q.queryKey.join('/').includes('reservations') });
    toast({ title: '受取完了 ✅', description: 'お食事をお楽しみください！' });

    if (userId) {
      // userId が取れていればレビューモーダルを優先表示。
      // フォールバック自動遷移（5秒）を予約するが、モーダル表示時は useEffect で解除される。
      // → モーダルが実際に開いた瞬間にタイマー解除 → ユーザーがゆっくり書ける。
      // → モーダルが何らかの理由で開かない場合のみ5秒後に履歴へ。
      showReviewTimerRef.current = setTimeout(() => setShowReview(true), 800);
      autoNavTimerRef.current   = setTimeout(() => goToHistory(), 5000);
    } else {
      // userId 取得失敗 → レビューモーダルは表示せず1.2秒後に履歴へ
      autoNavTimerRef.current = setTimeout(() => goToHistory(), 1200);
    }
  }, [reservationId, refetch, toast, userId, goToHistory, queryClient]);

  // ─── ローディング ──
  if (isLoading || !reservation) {
    return (
      <Layout showBottomNav={false}>
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Layout>
    );
  }

  const isPickedUp = !!(ticket || reservation.status === 'picked_up');
  const isCancelled = reservation.status === 'cancelled';
  const displayCode = toDisplayCode(reservation.pickupCode, reservationId);
  const pickedUpAtStr = ticket?.pickedUpAt ? formatDatetime(ticket.pickedUpAt) : formatDatetime(new Date().toISOString());

  return (
    <Layout showBottomNav={false}>
      {/* ─── 受取完了後レビューモーダル ─── */}
      <AnimatePresence>
        {showReview && userId && reservation && (
          <ReviewModal
            reservation={{
              id: reservationId,
              storeId: reservation.storeId,
              store: reservation.store,
            }}
            userId={userId}
            onClose={() => {
              setShowReview(false);
              goToHistory();
            }}
          />
        )}
      </AnimatePresence>

      <div className="max-w-md md:max-w-none mx-auto pb-10 overflow-x-hidden w-full">

        {/* ヘッダー */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-4 sticky top-0 md:top-16 bg-background/90 backdrop-blur-sm z-10 border-b border-border/40">
          <button
            onClick={() => navigate('/my-reservations')}
            className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-black text-foreground">電子チケット</h1>
            <p className="text-[11px] text-muted-foreground font-mono">#{String(reservationId).padStart(8, '0')}</p>
          </div>
          <div className="ml-auto">
            <AnimatePresence mode="wait">
              {isPickedUp ? (
                <motion.span key="done" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                  className="bg-slate-100 text-slate-500 text-xs font-black px-3 py-1 rounded-full"
                >受取済み</motion.span>
              ) : isCancelled ? (
                <motion.span key="cancel" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-rose-50 text-rose-500 text-xs font-black px-3 py-1 rounded-full"
                >キャンセル</motion.span>
              ) : (
                <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-primary/10 text-primary text-xs font-black px-3 py-1 rounded-full"
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary mr-1.5 animate-pulse" />
                  未受取
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="px-4 pt-4 space-y-4">

          {/* 案内バナー（未受取のみ） */}
          <AnimatePresence>
            {!isPickedUp && !isCancelled && (
              <motion.div
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="bg-primary text-primary-foreground rounded-2xl px-4 py-3.5 shadow-lg shadow-primary/20"
              >
                <p className="text-sm font-black text-center leading-relaxed break-words">
                  お店の人にこの<span className="text-yellow-300">6桁のコード</span>と画面を見せてください
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 店舗情報 */}
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className={`bg-card border border-border rounded-2xl p-4 shadow-sm transition-all duration-500 ${isPickedUp ? 'opacity-50 grayscale' : ''}`}
          >
            <div className="flex gap-3 items-center mb-3">
              <div className="w-12 h-12 bg-muted rounded-xl overflow-hidden shrink-0">
                <img
                  src={reservation.store?.iconUrl || reservation.store?.imageUrl || 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=200&q=70'}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-foreground">{reservation.store?.name}</p>
                <p className="text-sm text-muted-foreground truncate">{normalizeBrand(reservation.bag?.title)} × {reservation.quantity}</p>
                <p className="text-xs font-bold text-primary mt-0.5" data-sshide>¥{reservation.totalPrice.toLocaleString()}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-secondary/60 rounded-xl px-3 py-2 flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-xs font-bold">{formatPickupTime(reservation.bag?.pickupStart, reservation.bag?.pickupEnd, effectivePickupDate((reservation.bag as { createdAt?: string })?.createdAt, (reservation.bag as { pickupNextDay?: boolean })?.pickupNextDay) ?? reservation.createdAt)}</span>
              </div>
              <div className="bg-secondary/60 rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-xs font-bold truncate">{reservation.store?.city || reservation.store?.address}</span>
              </div>
            </div>
          </motion.div>

          {/* ── チケット本体 ── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}
            className={`bg-card rounded-3xl overflow-hidden shadow-lg transition-all duration-500
              ${isPickedUp ? 'border-2 border-slate-200' : 'border-2 border-primary/20 shadow-primary/10'}`}
          >
            {/* トップライン */}
            <div className={`h-2 ${isPickedUp ? 'bg-slate-200' : 'bg-gradient-to-r from-primary via-[#3a7367] to-[#3d7a6e]'}`} />

            <div className="px-5 py-7 text-center">
              <AnimatePresence mode="wait">
                {isPickedUp ? (
                  /* 受取済みスタンプ */
                  <motion.div key="stamp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-4">
                    <PickedUpStamp pickedUpAt={pickedUpAtStr} />

                    <motion.div
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                      className="mt-5 flex items-center justify-center gap-4 bg-secondary/50 rounded-2xl py-3 px-4"
                    >
                      <div className="flex items-center gap-1.5 text-emerald-600">
                        <Leaf className="w-4 h-4" />
                        <span className="text-sm font-black">CO₂ 2.5kg削減</span>
                      </div>
                    </motion.div>
                  </motion.div>

                ) : isCancelled ? (
                  /* キャンセル */
                  <motion.div key="cancel" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="py-8 flex flex-col items-center gap-3"
                  >
                    <AlertCircle className="w-12 h-12 text-rose-300" />
                    <p className="font-black text-rose-400 text-lg">キャンセル済み</p>
                    <p className="text-xs text-muted-foreground">この予約はキャンセルされました</p>
                  </motion.div>

                ) : (
                  /* アクティブ コード */
                  <motion.div key="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <p className="text-[10px] font-black text-primary/60 uppercase tracking-[0.2em] mb-5">
                      受取用コード
                    </p>

                    {/* 6桁コード */}
                    <SixDigitCode code={displayCode} />

                    <p className="text-[11px] text-muted-foreground mt-5">
                      購入日時: {formatDatetime(reservation.createdAt)}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ミシン目 + フッター */}
            {!isCancelled && (
              <>
                <div className="flex items-center px-3 py-3">
                  <div className="w-4 h-4 rounded-full bg-background border border-border -ml-6 shrink-0" />
                  <div className="flex-1 border-t-2 border-dashed border-border/60 mx-2" />
                  <div className="w-4 h-4 rounded-full bg-background border border-border -mr-6 shrink-0" />
                </div>
                <div className={`px-6 py-3.5 flex justify-between items-center text-[11px] font-mono transition-all duration-500
                  ${isPickedUp ? 'bg-slate-50 text-slate-400' : 'bg-primary/5 text-primary/50'}`}
                >
                  <span>#{String(reservationId).padStart(8, '0')}</span>
                  <span className="font-black tracking-wide">おすそわけ</span>
                  <span data-sshide>¥{reservation.totalPrice.toLocaleString()}</span>
                </div>
              </>
            )}
          </motion.div>

          {/* ── スワイプ or 使用済みメッセージ ── */}
          {!isCancelled && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
              <AnimatePresence mode="wait">
                {isPickedUp ? (
                  <motion.div
                    key="used"
                    initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                    className="space-y-3"
                  >
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-center gap-3">
                      <CheckCircle2 className="w-5 h-5 text-slate-400 shrink-0" />
                      <p className="text-sm font-bold text-slate-400">このチケットは既に使用済みです</p>
                    </div>
                    {/* ★ 確実に履歴へ戻れるボタン（モーダルが出ない場合の保険） */}
                    <button
                      type="button"
                      onClick={goToHistory}
                      className="w-full h-12 rounded-2xl bg-primary text-white font-black text-sm flex items-center justify-center gap-2 shadow-md shadow-primary/25 active:scale-[0.98] transition-all"
                    >
                      履歴に戻る
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </motion.div>
                ) : (
                  <motion.div key="swipe" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
                    <p className="text-xs text-center text-muted-foreground font-bold">
                      コードを確認後、お店の方と一緒にスワイプ
                    </p>
                    <SwipeSlider onConfirm={handleConfirmPickup} />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

        </div>
      </div>
    </Layout>
  );
}
