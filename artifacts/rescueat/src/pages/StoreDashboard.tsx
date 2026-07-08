import React, { useState, useEffect, useRef } from 'react';
import { StoreLayout } from '@/components/StoreLayout';
import { Layout } from '@/components/Layout';
import { useMyStores } from '@/hooks/use-my-stores';
import { StoreSelector } from '@/components/StoreSelector';
import {
  useListReservations,
  useListStoreBags,
  useCreateBag,
  useUpdateReservationStatus,
  getListReservationsQueryKey,
  getListStoreBagsQueryKey,
} from '@workspace/api-client-react';
import {
  Plus, Minus, Clock, CheckCircle2, Package2, X, ChevronUp, ChevronDown,
  Loader2, AlertCircle, BarChart2, RefreshCw, Ticket, Eye, ArrowRight,
  History, CreditCard, Zap, Pencil, Trash2, Save, Store, XCircle, Search, RotateCcw,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '@/lib/authed-fetch';
import { RecurringListingsSection } from '@/components/RecurringListingsSection';
import { BagPreviewSheet } from '@/components/BagPreviewSheet';
import { normalizeBrand } from '@/lib/brand-text';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import { ImageUpload } from '@/components/ImageUpload';
import { BagManageCard, getBagStatus, type Bag, type BagRealStatus } from '@/components/BagManageCard';
import { CategoryPicker } from '@/components/CategoryPicker';
import { TimePicker } from '@/components/TimePicker';

// ─── 型 ────────────────────────────────────────────────────────────────────
type ReservationStatus = 'pending' | 'confirmed' | 'picked_up' | 'cancelled';

interface Reservation {
  id: number;
  userId: string;
  status: ReservationStatus;
  paymentStatus?: 'unpaid' | 'paid' | 'refunded';
  pickupCode: string | null;
  quantity: number;
  totalPrice: number;
  createdAt: string;
  bag: {
    id: number;
    title: string;
    pickupStart: string | null;
    pickupEnd: string | null;
    discountedPrice: number;
    originalPrice: number;
    pickupNextDay?: boolean | null;
  } | null;
}

// ─── ヘルパー ───────────────────────────────────────────────────────────────

/** UTCのISO文字列をJST(+09:00)の YYYY-MM-DD 文字列に変換する */
// ─── 収益モデル: ユーザー側「システム利用料 5%」を加算し10円単位で切り上げ ─
//  (api-server/src/routes/reservations.ts と完全同一のロジック)
//  切り上げにする理由: 四捨五入だと低額帯 (例 51円) で買い手合計 < 販売価格 になる逆転バグが発生するため。
//  例: 100円 → 100*1.05=105 → 110円 / 480円 → 504 → 510円 / 51円 → 53.55 → 60円
const BUYER_SERVICE_FEE_RATE = 0.05;
function buyerTotalJpy(merchandiseJpy: number): number {
  if (!Number.isFinite(merchandiseJpy) || merchandiseJpy <= 0) return 0;
  return Math.ceil((merchandiseJpy * (1 + BUYER_SERVICE_FEE_RATE)) / 10) * 10;
}

function toJSTDateStr(utcIso: string): string {
  // 末尾に 'Z' がない場合でも UTC として扱う（Drizzle/pg は UTC 値を返す）
  const raw = utcIso.endsWith('Z') || utcIso.includes('+') ? utcIso : utcIso + 'Z';
  const utcMs = new Date(raw).getTime();
  const jstMs = utcMs + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** 現在のJST日付を "YYYY-MM-DD" で返す */
function todayJSTStr(): string {
  return toJSTDateStr(new Date().toISOString());
}

/** "YYYY-MM-DD" に n 日加算した "YYYY-MM-DD" を返す */
function addJstDay(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * 予約の「受取日(JST)」を返す。
 *  ★ 前日出品(pickupNextDay=true)は 作成日の翌日 が受取日。
 *    これを createdAt そのままで判定すると、 前夜に売れた「明日受取」の注文を
 *    受取当日に「本日の注文」として表示できず、 店が受取対応を見落とす原因になる。
 */
function pickupDateJST(r: Reservation): string {
  const created = toJSTDateStr(r.createdAt);
  return r.bag?.pickupNextDay ? addJstDay(created, 1) : created;
}

/** 受取日が既に過ぎた（＝対応漏れ・要フォロー）予約か。 未来の受取(明日)は含めない。 */
function isPastPickupReservation(r: Reservation) {
  try { return pickupDateJST(r) < todayJSTStr(); } catch { return false; }
}

function formatPurchasedAt(iso: string) {
  try {
    return format(parseISO(iso), 'M/d HH:mm', { locale: ja });
  } catch { return '—'; }
}

function statusLabel(s: ReservationStatus) {
  if (s === 'pending')    return { text: '決済待ち', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  if (s === 'confirmed')  return { text: '確認済み', cls: 'bg-blue-50 text-blue-700 border-blue-200' };
  if (s === 'picked_up')  return { text: '受取済み', cls: 'bg-green-50 text-green-700 border-green-200' };
  return { text: 'キャンセル', cls: 'bg-gray-100 text-gray-500 border-gray-200' };
}

// ─── 過去出品の型 ─────────────────────────────────────────────────────────
interface PastBag {
  id: number;
  title: string;
  originalPrice: number;
  discountedPrice: number;
  imageUrl: string | null;
  category?: string | null;
  itemType?: string;
  hiddenFromQuickPublish?: boolean;
}


// ─── 現在時刻 (HH:MM) を返す。 出品時の受取開始デフォルト用 ──────────────
function nowHHMM(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ─── 出品時の受取終了デフォルト: 現在時刻 + 2時間、 分は次の「時」に切り上げ ──
//   例: 09:50 → 12:00  (09:50 + 2h = 11:50 → 切り上げ 12:00)
//       16:20 → 19:00  (16:20 + 2h = 18:20 → 切り上げ 19:00)
//       09:00 → 11:00  (分が 00 ちょうどなら切り上げ不要)
//   24時を超えた場合は mod 24 で翌日扱い (既存の日付またぎロジックが処理)。
function defaultPickupEndHHMM(): string {
  const d = new Date();
  let h = d.getHours() + 2;
  if (d.getMinutes() > 0) h += 1; // 分が 1 以上なら次の時に切り上げ
  h = h % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

// ─── 出品モーダル ────────────────────────────────────────────────────────
function PostBagModal({
  storeId,
  storeName,
  pastBags,
  onClose,
  onSuccess,
  onHidePastBag,
}: {
  storeId: number;
  storeName: string;
  pastBags: PastBag[];
  onClose: () => void;
  onSuccess: () => void;
  onHidePastBag: (bagId: number) => Promise<void> | void;
}) {
  const { toast } = useToast();
  const createBag = useCreateBag();
  const [mode, setMode] = useState<'quick' | 'manual'>('quick');
  const [pastBag, setPastBag] = useState<PastBag | null>(null);
  const [bagCategory, setBagCategory] = useState<string>('');
  const [aiSuggested, setAiSuggested] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [qty, setQty] = useState(3);
  // 出品時のデフォルト受取時間: 開始=現在時刻 (HH:MM)、 終了=現在時刻+2h を時単位で切り上げ。
  // useState の lazy initializer で「マウント時の現在時刻」を一度だけ評価する。
  const [quickPickupStart, setQuickPickupStart] = useState(() => nowHHMM());
  const [quickPickupEnd, setQuickPickupEnd] = useState(() => defaultPickupEndHHMM());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [itemType, setItemType] = useState<'bag' | 'item'>('bag');
  const [showPreview, setShowPreview] = useState(false); // お客様画面プレビュー
  const [pickupNextDay, setPickupNextDay] = useState(false); // 翌日受取(前日の夜に出品)
  const [twoShift, setTwoShift] = useState(false);       // 2部制(受取2枠)
  const [pickupStart2, setPickupStart2] = useState('17:00');
  const [pickupEnd2, setPickupEnd2] = useState('19:00');

  // クイックモード追加情報
  const [quickAllergyInfo, setQuickAllergyInfo] = useState('');
  const [quickPickupNote, setQuickPickupNote] = useState('');

  // 手動フォーム
  // pickupStart はマウント時の現在時刻、 pickupEnd は現在時刻+2h を時単位で切り上げ
  const [form, setForm] = useState(() => ({
    title: '',
    description: '',
    allergyInfo: '',
    pickupNote: '',
    originalPrice: 0,
    discountedPrice: 0,
    stockCount: 3,
    pickupStart: nowHHMM(),
    pickupEnd: defaultPickupEndHHMM(),
  }));
  const [editingStock, setEditingStock] = useState(false);
  const stockInputRef = useRef<HTMLInputElement>(null);

  // 画像変更ハンドラ：アップロード後に AI 自動分類を実行
  const handleImageChange = React.useCallback(async (url: string | null) => {
    setImageUrl(url);
    if (!url || url.startsWith('http')) {
      // 外部URLや null は分類しない（過去出品引き継ぎ時も含む）
      return;
    }
    try {
      setClassifying(true);
      const apiBase = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiBase}/api/suggest-category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: url }),
      });
      if (res.ok) {
        const data = (await res.json()) as { category: string | null };
        if (data.category) {
          setAiSuggested(data.category);
          setBagCategory(prev => prev || data.category!); // 未選択なら自動適用
        }
      }
    } catch {
      // 分類失敗は無視
    } finally {
      setClassifying(false);
    }
  }, []);

  // 過去の出品を選択したとき、画像・カテゴリを引き継ぐ
  // pastBag が変わるたびに両方を更新（category がない場合はリセット）
  React.useEffect(() => {
    if (!pastBag) return;
    if (pastBag.imageUrl) setImageUrl(pastBag.imageUrl);
    setBagCategory(pastBag.category ?? '');
  }, [pastBag]);

  /**
   * 受取終了時間（HH:MM）が現在時刻を過ぎているかチェック
   * 過ぎていれば true（出品ブロック対象）。
   * pickupStart >= pickupEnd の「日付またぎ」設定（例: 22:00〜02:00）の場合は
   * 終了時刻を翌日として扱い、過ぎていないものとみなす。
   */
  function isPickupEndPassed(pickupStart: string, pickupEnd: string): boolean {
    if (!pickupEnd || !/^\d{1,2}:\d{2}$/.test(pickupEnd)) return false;
    const [eh, em] = pickupEnd.split(':').map(Number);
    const now = new Date();
    const endToday = new Date(
      now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0, 0
    );

    // 日付またぎ判定: start >= end なら end は翌日扱い
    if (pickupStart && /^\d{1,2}:\d{2}$/.test(pickupStart)) {
      const [sh, sm] = pickupStart.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      if (startMin >= endMin) {
        // 翌日跨ぎ → 過ぎていないとみなす
        return false;
      }
    }
    return now.getTime() > endToday.getTime();
  }

  async function handleQuickSubmit() {
    if (!pastBag) {
      toast({ title: '商品を選択してください', variant: 'destructive' });
      return;
    }
    if (!bagCategory) {
      toast({ title: 'カテゴリを選択してください', variant: 'destructive' });
      return;
    }
    if (!imageUrl) {
      toast({ title: '写真を追加してください', variant: 'destructive' });
      return;
    }
    // ★ 時間切れチェック: 受取終了時間が現在時刻を過ぎていたら API を呼ばずに中断
    if (isPickupEndPassed(quickPickupStart, quickPickupEnd)) {
      toast({
        title: '出品できませんでした',
        description: '本日の受取時間を過ぎています。受取時間を未来の時刻に設定してください。',
        variant: 'destructive',
      });
      return;
    }
    setIsSubmitting(true);
    try {
      // ★ ユーザーが過去に設定した商品名は文字数に関わらず必ず尊重する。
      //   旧版は「4文字未満なら店舗名にフォールバック」していたため、 短い商品名
      //   (例: 「丼」「鯛茶」) が「<店舗名>のおすそわけバッグ」 に置き換わる不具合があった。
      const cleanTitle = pastBag.title?.trim() || `${storeName}のおすそわけバッグ`;
      await createBag.mutateAsync({
        storeId,
        data: {
          title: cleanTitle,
          description: `${storeName}の美味しいおすそわけです！`,
          originalPrice: Number(pastBag.originalPrice),
          discountedPrice: Number(pastBag.discountedPrice),
          stockCount: qty,
          pickupStart: quickPickupStart,
          pickupEnd: quickPickupEnd,
          imageUrl,
          category: bagCategory || undefined,
          allergyInfo: quickAllergyInfo.trim() || undefined,
          pickupNote: quickPickupNote.trim() || undefined,
          itemType: (pastBag.itemType as 'bag' | 'item') ?? 'bag',
        } as any,
      });
      // ★ 成功 toast は API が完全に成功した後のみ表示（await 後）
      toast({ title: '出品しました！', description: `${pastBag.title} × ${qty}個` });
      onSuccess();
    } catch (err: any) {
      console.error('[handleQuickSubmit] error:', err);
      const msg = err?.data?.message ?? err?.message ?? '出品に失敗しました';
      toast({ title: '出品に失敗しました', description: msg, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (itemType === 'item' && !form.title.trim()) return;
    if (form.discountedPrice <= 0) return;
    if (!bagCategory) {
      toast({ title: 'カテゴリを選択してください', variant: 'destructive' });
      return;
    }
    if (!imageUrl) {
      toast({ title: '写真を追加してください', variant: 'destructive' });
      return;
    }
    // ★ 時間切れチェック: 受取終了時間が現在時刻を過ぎていたら API を呼ばずに中断。
    //   2部制は「最後の枠(2部)」が過ぎているかで判定（1部が過ぎても2部が未来なら出品可）。
    //   ★ 翌日受取(pickupNextDay)は受取が明日なので、 今日の時刻チェックはスキップ。
    if (!pickupNextDay && isPickupEndPassed(
      twoShift ? pickupStart2 : form.pickupStart,
      twoShift ? pickupEnd2 : form.pickupEnd,
    )) {
      toast({
        title: '出品できませんでした',
        description: '本日の受取時間を過ぎています。受取時間を未来の時刻に設定してください。',
        variant: 'destructive',
      });
      return;
    }
    setIsSubmitting(true);
    try {
      await createBag.mutateAsync({
        storeId,
        data: {
          // ★ ユーザーが入力した商品名は文字数に関わらず必ず尊重する (旧 length>=2 は短い商品名を弾いていた)。
          //   空欄のときだけフォールバック: bag → 「おすそわけ袋」、 item → 「<店舗名>の商品」
          title: form.title.trim() || (itemType === 'bag' ? 'おすそわけ袋' : `${storeName}の商品`),
          description: form.description.trim() || `${storeName}の美味しいおすそわけです！`,
          originalPrice: Number(form.originalPrice),
          discountedPrice: Number(form.discountedPrice),
          stockCount: Number(form.stockCount),
          pickupStart: form.pickupStart,
          pickupEnd: form.pickupEnd,
          pickupStart2: twoShift ? pickupStart2 : null,
          pickupEnd2: twoShift ? pickupEnd2 : null,
          pickupNextDay,
          imageUrl,
          category: bagCategory || undefined,
          allergyInfo: form.allergyInfo.trim() || undefined,
          pickupNote: form.pickupNote.trim() || undefined,
          itemType,
        } as any,
      });
      // ★ 成功 toast は API が完全に成功した後のみ表示（await 後）
      toast({ title: '出品しました！' });
      onSuccess();
    } catch (err: any) {
      console.error('[handleManualSubmit] error:', err);
      const msg = err?.data?.message ?? err?.message ?? '出品に失敗しました';
      toast({ title: '出品に失敗しました', description: msg, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className="w-full max-w-full max-h-[90dvh] bg-white rounded-t-3xl overflow-hidden flex flex-col"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* モーダルヘッダー */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-lg font-black text-foreground">本日のおすそわけを出品する</h2>
            <p className="text-xs text-muted-foreground mt-0.5">今日おすそわけできる商品を選んでください</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-muted flex items-center justify-center hover:bg-muted/70 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* モード切替 */}
        <div className="px-5 pt-4 shrink-0">
          <div className="flex bg-secondary rounded-xl p-1 gap-1">
            <button
              onClick={() => setMode('quick')}
              className={`flex-1 py-2 rounded-lg text-sm font-black transition-all ${
                mode === 'quick' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground'
              }`}
            >
              ⚡ クイック出品
            </button>
            <button
              onClick={() => setMode('manual')}
              className={`flex-1 py-2 rounded-lg text-sm font-black transition-all ${
                mode === 'manual' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground'
              }`}
            >
              ✏️ 手動で入力
            </button>
          </div>
        </div>

        {/* スクロールエリア */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-4">

          {mode === 'quick' && (
            <>
              {/* ─ 過去の出品履歴リスト ─ */}
              <div>
                <p className="text-xs font-bold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" />
                  過去の出品から選ぶ
                </p>

                {pastBags.length === 0 ? (
                  /* 履歴なし */
                  <div className="bg-muted/50 rounded-2xl p-6 text-center border border-dashed border-border">
                    <Package2 className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm font-bold text-foreground">まだ出品履歴がありません</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      「手動で入力」タブから最初の商品を登録してください
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pastBags.map((bag) => {
                      const isSelected = pastBag?.id === bag.id;
                      const offPct = bag.originalPrice > 0
                        ? Math.round((1 - bag.discountedPrice / bag.originalPrice) * 100)
                        : 0;
                      // ★ 親要素を <div role="button"> にしているのは、 × ボタン (子 <button>) を
                      //   ネストしても valid HTML を維持するため (button-in-button 禁止)。
                      return (
                        <div
                          key={bag.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setPastBag(isSelected ? null : bag)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPastBag(isSelected ? null : bag);
                            }
                          }}
                          className={`relative w-full flex items-center gap-3 p-3 pr-10 rounded-2xl border-2 text-left transition-all cursor-pointer select-none ${
                            isSelected
                              ? 'border-primary bg-primary/5 shadow-sm'
                              : 'border-border bg-card hover:border-primary/30'
                          }`}
                        >
                          {/* サムネイル */}
                          {bag.imageUrl ? (
                            <img
                              src={bag.imageUrl}
                              alt={bag.title}
                              className="w-14 h-14 rounded-xl object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center shrink-0">
                              <Package2 className="w-6 h-6 text-muted-foreground" />
                            </div>
                          )}

                          {/* テキスト */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-foreground truncate">{normalizeBrand(bag.title)}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs line-through text-muted-foreground">¥{bag.originalPrice.toLocaleString()}</span>
                              <span className="text-sm font-black text-primary">¥{bag.discountedPrice.toLocaleString()}</span>
                              {offPct > 0 && (
                                <span className="text-[10px] font-bold bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full">
                                  {offPct}%OFF
                                </span>
                              )}
                            </div>
                          </div>

                          {/* チェック */}
                          {isSelected && (
                            <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                              <CheckCircle2 className="w-4 h-4 text-white" />
                            </div>
                          )}

                          {/* × ボタン (履歴から非表示) */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`「${normalizeBrand(bag.title)}」 をクイック出品リストから非表示にしますか？\n（過去の出品データは残ります）`)) {
                                if (isSelected) setPastBag(null);
                                void onHidePastBag(bag.id);
                              }
                            }}
                            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-white/80 hover:bg-red-50 hover:text-red-500 border border-border flex items-center justify-center text-muted-foreground transition-colors shadow-sm"
                            title="クイック出品リストから非表示にする"
                            aria-label="クイック出品リストから非表示にする"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ─ 詳細設定（個数・受取時間・写真）─ */}
              <AnimatePresence>
                {pastBag && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    className="space-y-4 border-t border-border pt-4"
                  >
                    {/* 個数 + 受取時間 */}
                    <div className="grid grid-cols-2 gap-3">
                      {/* 個数 */}
                      <div>
                        <p className="text-xs font-bold text-muted-foreground mb-2">出品数</p>
                        <div className="flex items-center bg-white border-2 border-border rounded-xl overflow-hidden shadow-sm h-12">
                          <button
                            type="button"
                            onClick={() => setQty(Math.max(1, qty - 1))}
                            className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors font-black text-lg"
                          >−</button>
                          <span className="flex-1 text-center text-xl font-black">{qty}</span>
                          <button
                            type="button"
                            onClick={() => setQty(Math.min(99, qty + 1))}
                            className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors font-black text-lg"
                          >＋</button>
                        </div>
                      </div>

                      {/* 受取時間 */}
                      <div>
                        <p className="text-xs font-bold text-muted-foreground mb-2">受取時間</p>
                        <div className="space-y-1.5">
                          <TimePicker value={quickPickupStart} onChange={setQuickPickupStart} label="受取 開始" />
                          <TimePicker value={quickPickupEnd} onChange={setQuickPickupEnd} label="受取 終了" />
                        </div>
                      </div>
                    </div>

                    {/* 写真（過去の画像を引き継ぎ、変更も可） */}
                    <ImageUpload value={imageUrl} onChange={handleImageChange} required />

                    {/* ラベル（必須） */}
                    <CategoryPicker
                      value={bagCategory}
                      onChange={setBagCategory}
                      classifying={classifying}
                      aiSuggested={aiSuggested}
                      required
                    />

                    {/* アレルギー情報 */}
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                        アレルギー情報 <span className="font-normal text-muted-foreground/60">（任意）</span>
                      </label>
                      <textarea
                        value={quickAllergyInfo}
                        onChange={e => setQuickAllergyInfo(e.target.value)}
                        placeholder="例：小麦、卵、乳を含む可能性があります"
                        rows={2}
                        className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 text-sm focus:border-primary outline-none transition-all resize-none"
                      />
                    </div>

                    {/* 受取メモ */}
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                        受取メモ <span className="font-normal text-muted-foreground/60">（任意）</span>
                      </label>
                      <textarea
                        value={quickPickupNote}
                        onChange={e => setQuickPickupNote(e.target.value)}
                        placeholder="例：店頭でスタッフにアプリ画面をご提示ください"
                        rows={2}
                        className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 text-sm focus:border-primary outline-none transition-all resize-none"
                      />
                    </div>

                    {/* お客様画面プレビュー: 写真の見切り・文字の折り返しを出品前に確認 */}
                    <button
                      type="button"
                      onClick={() => setShowPreview(true)}
                      className="w-full py-3 rounded-2xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5"
                    >
                      <Eye className="w-4 h-4" />お客様の画面でプレビュー
                    </button>

                    {/* 出品ボタン */}
                    <button
                      type="button"
                      onClick={handleQuickSubmit}
                      disabled={!imageUrl || !bagCategory || isSubmitting}
                      className={`w-full py-4 rounded-2xl font-black text-base flex items-center justify-center gap-2 transition-all ${
                        imageUrl && bagCategory && !isSubmitting
                          ? 'bg-primary text-white shadow-lg shadow-primary/25 active:scale-[0.98]'
                          : 'bg-muted text-muted-foreground cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting
                        ? <Loader2 className="w-5 h-5 animate-spin" />
                        : !imageUrl
                          ? '写真を追加してください'
                          : !bagCategory
                            ? 'カテゴリを選択してください'
                            : <><Plus className="w-5 h-5" />{qty}個を今すぐ出品する</>
                      }
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}

          {mode === 'manual' && (
            <form onSubmit={handleManualSubmit} className="space-y-4" noValidate>

              {/* 商品タイプ選択 */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-2">商品タイプ</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: 'bag',  emoji: '🛍', label: 'おすそわけ袋', sub: 'おまかせ詰め合わせ' },
                    { value: 'item', emoji: '🥡', label: '単品商品',    sub: '特定の商品を販売' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setItemType(opt.value);
                        setForm(f => ({ ...f, title: '', description: '' }));
                      }}
                      className={`flex flex-col items-center py-3 px-2 rounded-2xl border-2 transition-all ${
                        itemType === opt.value
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-border bg-secondary/30 text-muted-foreground'
                      }`}
                    >
                      <span className="text-2xl mb-1">{opt.emoji}</span>
                      <span className="text-xs font-black">{opt.label}</span>
                      <span className="text-[10px] mt-0.5 opacity-70">{opt.sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 商品名 */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                  商品名
                  {itemType === 'bag' && <span className="ml-1 text-[10px] font-normal text-muted-foreground/60">（デフォルト：おすそわけ袋）</span>}
                </label>
                <input
                  required
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder={itemType === 'bag' ? 'おすそわけ袋' : '例：本日の焼きたてパン、日替わり弁当など'}
                  className="w-full bg-secondary/40 border-2 border-border rounded-xl px-4 py-3 font-bold placeholder:text-muted-foreground/50 placeholder:font-normal focus:border-primary outline-none transition-all"
                />
              </div>

              {/* バッグの内容（説明） */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                  {itemType === 'bag' ? 'バッグの内容' : '商品の説明'} <span className="font-normal text-muted-foreground/60">（空欄で自動入力）</span>
                </label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder={`例：${storeName}の美味しいおすそわけです！`}
                  rows={3}
                  className="w-full bg-secondary/40 border-2 border-border rounded-xl px-4 py-3 text-sm placeholder:text-muted-foreground/50 focus:border-primary outline-none transition-all resize-none"
                />
                {!form.description.trim() && (
                  <p className="text-[11px] text-muted-foreground/70 mt-1 pl-1">
                    空欄のまま出品すると「{storeName}の美味しいおすそわけです！」が自動セットされます
                  </p>
                )}
              </div>

              {/* 価格（割引率リアルタイム表示付き） */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-muted-foreground">価格設定</label>
                  {form.originalPrice > 0 && form.discountedPrice > 0 && form.discountedPrice < form.originalPrice && (
                    <span className="flex items-center gap-1 text-xs font-black text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                      <Zap className="w-3 h-3" />
                      {Math.round((1 - form.discountedPrice / form.originalPrice) * 100)}% OFF
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-1">通常価格</p>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold text-sm">¥</span>
                      <input
                        type="number" inputMode="numeric" required
                        value={form.originalPrice === 0 ? '' : form.originalPrice}
                        onFocus={e => e.target.select()}
                        onChange={e => {
                          const raw = e.target.value.replace(/^0+(?=\d)/, '');
                          setForm({ ...form, originalPrice: raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0) });
                        }}
                        className="w-full bg-secondary/40 border-2 border-border rounded-xl pl-7 pr-3 py-3 font-bold focus:border-primary outline-none transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-1">販売価格</p>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary font-bold text-sm">¥</span>
                      <input
                        type="number" inputMode="numeric" required
                        value={form.discountedPrice === 0 ? '' : form.discountedPrice}
                        onFocus={e => e.target.select()}
                        onChange={e => {
                          const raw = e.target.value.replace(/^0+(?=\d)/, '');
                          setForm({ ...form, discountedPrice: raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0) });
                        }}
                        className="w-full bg-secondary/40 border-2 border-primary/30 rounded-xl pl-7 pr-3 py-3 font-black text-primary focus:border-primary outline-none transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </div>
                  </div>
                </div>

                {/* ★ お客様への請求額のプレビュー (システム利用料 5% を加算し10円単位四捨五入) */}
                {form.discountedPrice > 0 && (
                  <div className="mt-2 rounded-xl bg-blue-50 border border-blue-200 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-bold text-blue-900 leading-tight">
                        お客様への表示価格
                        <span className="block text-[10px] font-medium text-blue-700/80 mt-0.5">
                          システム利用料 5% 加算 (10円単位)
                        </span>
                      </div>
                      <div className="text-base font-black text-blue-700 whitespace-nowrap">
                        ¥{buyerTotalJpy(form.discountedPrice).toLocaleString()}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 在庫数（大きなステッパー＋タップ展開） */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-2">在庫数</label>
                <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 56px', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, stockCount: Math.max(1, f.stockCount - 1) }))}
                    disabled={form.stockCount <= 1}
                    style={{ height: '56px', minWidth: '56px' }}
                    className="flex items-center justify-center rounded-xl bg-secondary border-2 border-border text-foreground hover:bg-muted active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Minus className="w-5 h-5" strokeWidth={2.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingStock(true);
                      setTimeout(() => {
                        stockInputRef.current?.focus();
                        stockInputRef.current?.select();
                      }, 30);
                    }}
                    style={{ height: '56px' }}
                    className={`flex flex-col items-center justify-center rounded-xl border-2 transition-all ${
                      editingStock ? 'bg-primary/5 border-primary' : 'bg-secondary/40 border-border'
                    }`}
                  >
                    <span className="text-2xl font-black leading-none">{form.stockCount}</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {editingStock ? '編集中…' : '個（タップで入力）'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, stockCount: f.stockCount + 1 }))}
                    style={{ height: '56px', minWidth: '56px' }}
                    className="flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary/90 active:scale-95 transition-all shadow-md shadow-primary/25"
                  >
                    <Plus className="w-5 h-5" strokeWidth={2.5} />
                  </button>
                </div>
                <AnimatePresence>
                  {editingStock && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -6, height: 0 }}
                      style={{ overflow: 'hidden', marginTop: '8px' }}
                    >
                      <div style={{ position: 'relative' }}>
                        <input
                          ref={stockInputRef}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={String(form.stockCount)}
                          onChange={e => {
                            const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10);
                            setForm(f => ({ ...f, stockCount: isNaN(v) ? 1 : Math.max(1, v) }));
                          }}
                          onFocus={e => {
                            const t = e.target;
                            setTimeout(() => t.setSelectionRange(0, t.value.length), 0);
                            setTimeout(() => stockInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
                          }}
                          onBlur={() => setEditingStock(false)}
                          style={{
                            display: 'block', width: '100%', height: '56px',
                            boxSizing: 'border-box', padding: '0',
                            margin: '0', textAlign: 'center',
                            fontSize: '28px', fontWeight: 900, lineHeight: '56px',
                            border: '2px solid var(--primary)', borderRadius: '12px',
                            outline: 'none', backgroundColor: 'transparent',
                            WebkitAppearance: 'none' as React.CSSProperties['WebkitAppearance'],
                            appearance: 'none' as React.CSSProperties['appearance'],
                            color: 'var(--foreground)',
                          }}
                        />
                        <span style={{
                          position: 'absolute', right: '14px', top: '50%',
                          transform: 'translateY(-50%)', fontSize: '13px',
                          fontWeight: 700, color: 'var(--muted-foreground)',
                          pointerEvents: 'none', userSelect: 'none',
                        }}>個</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* 受取はいつ？ 当日 / 翌日（前日の夜に出して翌朝受け取り。 パン屋さん等が夜に翌朝分を出す用） */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">受け取りはいつ？</label>
                <div className="flex gap-2">
                  {([[false, '当日に受け取り'], [true, '翌日に受け取り']] as const).map(([v, label]) => (
                    <button key={String(v)} type="button" onClick={() => setPickupNextDay(v)}
                      className={`flex-1 py-2.5 rounded-xl text-[13px] font-bold transition-colors ${
                        pickupNextDay === v ? 'bg-primary text-white' : 'bg-secondary/50 text-muted-foreground'
                      }`}>{label}</button>
                  ))}
                </div>
                {pickupNextDay && (
                  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200/70 rounded-lg px-2.5 py-1.5 mt-2 leading-snug">
                    💡 今 出品して「明日」お客さんが受け取る設定です（例: 翌朝 7:00〜9:00）。 夜に翌朝分を出す時はこちら。
                  </p>
                )}
              </div>

              {/* 受取時間（開始に「今すぐ」ボタン） */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">{pickupNextDay ? '翌日 受取開始' : '受取開始'}</label>
                  <div className="flex gap-1.5 items-start">
                    <div className="flex-1 min-w-0">
                      <TimePicker value={form.pickupStart} onChange={v => setForm({ ...form, pickupStart: v })} label="受取 開始" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const now = new Date();
                        const hh = now.getHours().toString().padStart(2, '0');
                        const mm = now.getMinutes().toString().padStart(2, '0');
                        setForm({ ...form, pickupStart: `${hh}:${mm}` });
                      }}
                      className="shrink-0 px-2 py-3 bg-primary/10 text-primary text-[10px] font-black rounded-lg hover:bg-primary/20 active:bg-primary/30 transition-colors leading-tight text-center"
                    >
                      今<br />すぐ
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">{twoShift ? '1部 受取終了' : '受取終了'}</label>
                  <TimePicker value={form.pickupEnd} onChange={v => setForm({ ...form, pickupEnd: v })} label={twoShift ? '1部 受取終了' : '受取 終了'} />
                </div>
              </div>

              {/* 2部制(受取2枠): 休憩・不在の時間帯を空けて受取を2つに分ける */}
              <div className="rounded-xl border-2 border-border p-3">
                <button type="button" onClick={() => setTwoShift(v => !v)} className="w-full flex items-center justify-between gap-3">
                  <span className="text-left">
                    <span className="block text-[13px] font-black text-foreground">2部制にする（途中に休憩をはさむ）</span>
                    <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">買い出し・配達などで不在の時間帯を空けて、受取を2枠に分けられます。</span>
                  </span>
                  <span className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${twoShift ? 'bg-primary' : 'bg-secondary'}`}>
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${twoShift ? 'left-[22px]' : 'left-0.5'}`} />
                  </span>
                </button>
                {twoShift && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">2部 受取開始</label>
                      <TimePicker value={pickupStart2} onChange={setPickupStart2} label="2部 受取開始" />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">2部 受取終了</label>
                      <TimePicker value={pickupEnd2} onChange={setPickupEnd2} label="2部 受取終了" />
                    </div>
                  </div>
                )}
              </div>

              {/* 商品写真 */}
              <ImageUpload value={imageUrl} onChange={handleImageChange} required />

              {/* ラベル（AI対応・必須） */}
              <CategoryPicker
                value={bagCategory}
                onChange={setBagCategory}
                classifying={classifying}
                aiSuggested={aiSuggested}
                required
              />

              {/* アレルギー情報 */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                  アレルギー情報 <span className="font-normal text-muted-foreground/60">（任意）</span>
                </label>
                <textarea
                  value={form.allergyInfo}
                  onChange={e => setForm({ ...form, allergyInfo: e.target.value })}
                  placeholder="例：小麦、卵、乳を含む可能性があります"
                  rows={2}
                  className="w-full bg-secondary/40 border-2 border-border rounded-xl px-4 py-3 text-sm placeholder:text-muted-foreground/50 focus:border-primary outline-none transition-all resize-none"
                />
              </div>

              {/* 受取メモ */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                  受取メモ <span className="font-normal text-muted-foreground/60">（任意）</span>
                </label>
                <textarea
                  value={form.pickupNote}
                  onChange={e => setForm({ ...form, pickupNote: e.target.value })}
                  placeholder="例：店頭でスタッフにアプリ画面をご提示ください"
                  rows={2}
                  className="w-full bg-secondary/40 border-2 border-border rounded-xl px-4 py-3 text-sm placeholder:text-muted-foreground/50 focus:border-primary outline-none transition-all resize-none"
                />
              </div>

              {/* お客様画面プレビュー: 写真の見切り・文字の折り返しを出品前に確認 */}
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                className="w-full py-3 rounded-2xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5"
              >
                <Eye className="w-4 h-4" />お客様の画面でプレビュー
              </button>

              <button
                type="submit"
                disabled={isSubmitting || (itemType === 'item' && !form.title.trim()) || form.discountedPrice <= 0 || !imageUrl || !bagCategory}
                className={`w-full py-4 rounded-2xl font-black text-base flex items-center justify-center gap-2 transition-all ${
                  !isSubmitting && (itemType === 'bag' || form.title.trim()) && form.discountedPrice > 0 && imageUrl && bagCategory
                    ? 'bg-primary text-white shadow-lg shadow-primary/25 active:scale-[0.98]'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                }`}
              >
                {isSubmitting
                  ? <Loader2 className="w-5 h-5 animate-spin" />
                  : !bagCategory
                    ? 'カテゴリを選択してください'
                    : <><Plus className="w-5 h-5" />出品する</>
                }
              </button>
            </form>
          )}
        </div>
      </motion.div>

      <BagPreviewSheet
        open={showPreview}
        onOpenChange={setShowPreview}
        storeName={storeName}
        // ★ クイック出品(過去出品から選択)と手動入力でフォーム状態が別物なので、
        //   モードごとに現在の入力値をプレビューに渡す。
        data={mode === 'quick'
          ? {
              title: pastBag?.title ?? '',
              description: null,
              originalPrice: pastBag?.originalPrice,
              discountedPrice: pastBag?.discountedPrice ?? 0,
              stockCount: qty,
              pickupStart: quickPickupStart,
              pickupEnd: quickPickupEnd,
              imageUrl,
              category: bagCategory,
              allergyInfo: quickAllergyInfo,
              pickupNote: quickPickupNote,
              itemType: (pastBag?.itemType === 'item' ? 'item' : 'bag'),
            }
          : {
              title: form.title,
              description: form.description,
              originalPrice: form.originalPrice,
              discountedPrice: form.discountedPrice,
              stockCount: form.stockCount,
              pickupStart: form.pickupStart,
              pickupEnd: form.pickupEnd,
              pickupStart2: twoShift ? pickupStart2 : null,
              pickupEnd2: twoShift ? pickupEnd2 : null,
              pickupNextDay,
              imageUrl,
              category: bagCategory,
              allergyInfo: form.allergyInfo,
              pickupNote: form.pickupNote,
              itemType,
            }}
      />
    </motion.div>
  );
}

// ─── バッグ編集モーダル ────────────────────────────────────────────────────
function EditBagModal({
  bag,
  storeId,
  storeName,
  BASE,
  onClose,
  onSaved,
  onDeleted,
}: {
  bag: Bag;
  storeId: number;
  storeName: string;
  BASE: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = React.useState({
    title:          bag.title,
    stockCount:     bag.stockCount,
    pickupStart:    bag.pickupStart ?? '',
    pickupEnd:      bag.pickupEnd   ?? '',
    originalPrice:  bag.originalPrice,
    discountedPrice: bag.discountedPrice,
    itemType:       (bag.itemType ?? 'bag') as 'bag' | 'item',
    description:    bag.description  ?? '',
    allergyInfo:    bag.allergyInfo  ?? '',
    pickupNote:     bag.pickupNote   ?? '',
  });
  const [saving,   setSaving]   = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [showPreview, setShowPreview] = React.useState(false); // お客様画面プレビュー

  async function handleSave() {
    setSaving(true);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:           form.title.trim(),
          stockCount:      form.stockCount,
          pickupStart:     form.pickupStart || null,
          pickupEnd:       form.pickupEnd   || null,
          originalPrice:   form.originalPrice,
          discountedPrice: form.discountedPrice,
          itemType:        form.itemType,
          description:     form.description.trim(),
          allergyInfo:     form.allergyInfo.trim(),
          pickupNote:      form.pickupNote.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `更新に失敗しました (HTTP ${res.status})`);
      }
      toast({ title: '商品情報を更新しました ✓' });
      onSaved();
    } catch (err: any) {
      toast({ title: err.message ?? '更新に失敗しました', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      // 公開中の場合は先に非公開にしてから削除
      if (bag.isActive) {
        await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: false }),
        });
      }
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `削除に失敗しました (HTTP ${res.status})`);
      }
      toast({ title: '商品を削除しました' });
      onDeleted();
    } catch (err: any) {
      toast({ title: err.message ?? '削除に失敗しました', variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  }

  const discountPct = form.originalPrice > 0
    ? Math.round((1 - form.discountedPrice / form.originalPrice) * 100)
    : 0;

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    >
      {/* 背景オーバーレイ */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* モーダル本体 */}
      <motion.div
        className="relative bg-background rounded-t-3xl shadow-2xl max-h-[92dvh] w-full max-w-full overflow-hidden flex flex-col"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Pencil className="w-4 h-4 text-primary" />
            <h2 className="text-lg font-black text-foreground">商品を編集</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* フォーム */}
        <div className="overflow-y-auto overflow-x-hidden flex-1 px-5 py-5 space-y-5">

          {/* 商品タイプ */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-2 block">商品タイプ</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: 'bag',  emoji: '🛍', label: 'おすそわけ袋' },
                { value: 'item', emoji: '🥡', label: '単品商品' },
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, itemType: opt.value }))}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 text-sm font-black transition-all ${
                    form.itemType === opt.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border bg-secondary/30 text-muted-foreground'
                  }`}
                >
                  <span>{opt.emoji}</span>{opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* タイトル */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">商品名</label>
            <input
              type="text"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              className="w-full border border-border rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background"
              placeholder={form.itemType === 'bag' ? 'おすそわけ袋' : '例：本日のおすすめセット'}
            />
          </div>

          {/* 在庫数 */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">在庫数</label>
            <div className="flex items-center gap-3">
              <button type="button"
                onClick={() => setForm(f => ({ ...f, stockCount: Math.max(0, f.stockCount - 1) }))}
                className="w-10 h-10 rounded-xl border border-border bg-secondary flex items-center justify-center hover:bg-muted active:scale-90 transition-all"
              ><Minus className="w-4 h-4" /></button>
              <span className="w-12 text-center text-2xl font-black tabular-nums">{form.stockCount}</span>
              <button type="button"
                onClick={() => setForm(f => ({ ...f, stockCount: f.stockCount + 1 }))}
                className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center hover:bg-primary/90 active:scale-90 transition-all"
              ><Plus className="w-4 h-4" /></button>
              <span className="text-sm text-muted-foreground font-medium">個</span>
            </div>
          </div>

          {/* 受け取り時間 */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">受け取り時間</label>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <TimePicker value={form.pickupStart} onChange={v => setForm(f => ({ ...f, pickupStart: v }))} label="受取 開始" />
              </div>
              <span className="text-muted-foreground font-bold">〜</span>
              <div className="flex-1">
                <TimePicker value={form.pickupEnd} onChange={v => setForm(f => ({ ...f, pickupEnd: v }))} label="受取 終了" />
              </div>
            </div>
          </div>

          {/* 価格 */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">価格</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-bold text-muted-foreground mb-1">元値（税込）</p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold text-sm">¥</span>
                  <input type="number" inputMode="numeric" min={0}
                    value={form.originalPrice === 0 ? '' : form.originalPrice}
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const raw = e.target.value.replace(/^0+(?=\d)/, '');
                      setForm(f => ({ ...f, originalPrice: raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0) }));
                    }}
                    className="w-full border border-border rounded-xl pl-7 pr-3 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold text-muted-foreground mb-1">販売価格（税込）</p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold text-sm">¥</span>
                  <input type="number" inputMode="numeric" min={0}
                    value={form.discountedPrice === 0 ? '' : form.discountedPrice}
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const raw = e.target.value.replace(/^0+(?=\d)/, '');
                      setForm(f => ({ ...f, discountedPrice: raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0) }));
                    }}
                    className="w-full border border-border rounded-xl pl-7 pr-3 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>
            </div>
            {discountPct > 0 && (
              <p className="text-xs font-bold text-primary mt-2">{discountPct}% OFF で販売</p>
            )}

            {/* ★ お客様への請求額のプレビュー (システム利用料 5% を加算し10円単位四捨五入) */}
            {form.discountedPrice > 0 && (
              <div className="mt-2 rounded-xl bg-blue-50 border border-blue-200 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold text-blue-900 leading-tight">
                    お客様への表示価格
                    <span className="block text-[10px] font-medium text-blue-700/80 mt-0.5">
                      システム利用料 5% 加算 (10円単位)
                    </span>
                  </div>
                  <div className="text-base font-black text-blue-700 whitespace-nowrap">
                    ¥{buyerTotalJpy(form.discountedPrice).toLocaleString()}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* バッグの内容（説明） */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">バッグの内容</label>
            <textarea rows={3}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="例：焼きたてパンの詰め合わせ（種類はおまかせ）"
              className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 text-sm focus:border-primary outline-none transition-all resize-none"
            />
          </div>

          {/* アレルギー情報 */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">アレルギー情報</label>
            <textarea rows={2}
              value={form.allergyInfo}
              onChange={e => setForm(f => ({ ...f, allergyInfo: e.target.value }))}
              placeholder="例：小麦、卵、乳を含む可能性があります"
              className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 text-sm focus:border-primary outline-none transition-all resize-none"
            />
          </div>

          {/* 受取メモ */}
          <div>
            <label className="text-xs font-black text-muted-foreground uppercase tracking-widest mb-1.5 block">受取メモ</label>
            <textarea rows={2}
              value={form.pickupNote}
              onChange={e => setForm(f => ({ ...f, pickupNote: e.target.value }))}
              placeholder="例：店頭でスタッフにアプリ画面をご提示ください"
              className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 text-sm focus:border-primary outline-none transition-all resize-none"
            />
          </div>

          {/* 削除 */}
          <div className="pt-2 border-t border-border/60">
            {confirmDelete ? (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <p className="text-sm font-black text-red-700 mb-1">本当に削除しますか？</p>
                <p className="text-xs text-red-500 mb-3">この操作は取り消せません。{bag.isActive ? '公開中の場合は先に非公開にしてから削除されます。' : ''}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmDelete(false)}
                    className="flex-1 py-2 rounded-xl border border-border text-sm font-bold text-muted-foreground hover:bg-muted transition-colors">
                    キャンセル
                  </button>
                  <button type="button" onClick={handleDelete} disabled={deleting}
                    className="flex-1 py-2 rounded-xl bg-red-500 text-white text-sm font-black hover:bg-red-600 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1">
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Trash2 className="w-4 h-4" />削除する</>}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-red-200 text-red-500 text-sm font-bold hover:bg-red-50 transition-colors">
                <Trash2 className="w-4 h-4" />
                この商品を削除する
              </button>
            )}
          </div>
        </div>

        {/* 保存ボタン */}
        <div className="px-5 pb-6 pt-3 shrink-0 border-t border-border/60 bg-background space-y-2.5"
          style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
          {/* お客様画面プレビュー: 写真の見切り・文字の折り返しを保存前に確認 */}
          <button type="button" onClick={() => setShowPreview(true)}
            className="w-full py-3 rounded-2xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5">
            <Eye className="w-4 h-4" />お客様の画面でプレビュー
          </button>
          <button type="button" onClick={handleSave} disabled={saving || !form.title.trim()}
            className="w-full py-4 rounded-2xl bg-primary text-white font-black text-base flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 shadow-md shadow-primary/20">
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Save className="w-5 h-5" />変更を保存する</>}
          </button>
        </div>
      </motion.div>

      <BagPreviewSheet
        open={showPreview}
        onOpenChange={setShowPreview}
        storeName={storeName}
        data={{
          title: form.title,
          description: form.description,
          originalPrice: form.originalPrice,
          discountedPrice: form.discountedPrice,
          stockCount: form.stockCount,
          pickupStart: form.pickupStart,
          pickupEnd: form.pickupEnd,
          imageUrl: bag.imageUrl,
          category: bag.category,
          allergyInfo: form.allergyInfo,
          pickupNote: form.pickupNote,
          itemType: form.itemType,
        }}
      />
    </motion.div>
  );
}

// ─── 予約カード ──────────────────────────────────────────────────────────
function ReservationCard({
  res,
  onPickedUp,
  onCancel,
  onUndoPickup,
  loading,
}: {
  res: Reservation;
  onPickedUp: (id: number) => void;
  onCancel: (id: number) => void;
  onUndoPickup?: (id: number) => void;
  loading: boolean;
}) {
  const badge = statusLabel(res.status);
  const code = res.pickupCode ?? '------';
  const customerShort = res.userId.slice(-6).toUpperCase();

  return (
    <div className="bg-white rounded-2xl border border-orange-100 shadow-[0_2px_12px_rgba(255,140,0,0.06)] overflow-hidden">
      {/* 上部バー */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        {/* ピックアップコード */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-medium">受取コード</p>
          <p className="text-xl font-black tracking-widest text-foreground font-mono">{code}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">購入: {formatPurchasedAt(res.createdAt)}</p>
        </div>
        {/* ステータスバッジ */}
        <span className={`text-xs font-black px-2.5 py-1 rounded-full border ${badge.cls}`}>
          {badge.text}
        </span>
      </div>

      <div className="px-4 pb-3 border-t border-gray-50">
        {/* バッグ名 */}
        <p className="text-sm font-black text-foreground mt-2 mb-1">{normalizeBrand(res.bag?.title ?? '商品名なし')}</p>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {res.bag?.pickupStart}〜{res.bag?.pickupEnd}
          </span>
          <span className="flex items-center gap-1">
            <Package2 className="w-3.5 h-3.5" />
            {res.quantity}個
          </span>
          <span className="flex items-center gap-1 font-bold text-primary">
            ¥{res.totalPrice.toLocaleString()}
          </span>
        </div>

        <p className="text-[10px] text-muted-foreground/60 mt-1.5">顧客ID: #{customerShort}</p>
      </div>

      {/* 受取済みボタン（決済完了時のみ活性。未決済の予約は受取不可＝未払いでの売上計上を防ぐ） */}
      {(res.status === 'pending' || res.status === 'confirmed') && (
        <div className="px-4 pb-4">
          {res.paymentStatus === 'paid' ? (
            <button
              onClick={() => onPickedUp(res.id)}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-green-50 border border-green-200 text-green-700 font-black text-sm hover:bg-green-100 active:scale-[0.98] transition-all disabled:opacity-60"
            >
              {loading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <><CheckCircle2 className="w-4 h-4" />受取済みにする</>
              }
            </button>
          ) : (
            <div
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 font-bold text-sm cursor-not-allowed"
              title="お客様の決済が完了すると受取操作ができます"
            >
              <Clock className="w-4 h-4" />お客様の決済待ち
            </div>
          )}
          {/* 店頭で売り切れた等で渡せない時の「キャンセル・返金」。 決済済みなら自動で全額返金される。 */}
          <button
            onClick={() => onCancel(res.id)}
            disabled={loading}
            className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 rounded-xl border border-rose-200 text-rose-600 bg-rose-50/60 font-bold text-[12px] hover:bg-rose-100 active:scale-[0.98] transition-all disabled:opacity-60"
          >
            この予約をキャンセル{res.paymentStatus === 'paid' ? '・返金' : ''}
          </button>
        </div>
      )}

      {/* 受取済みの取り消し（誤タップ救済）。 受取から24h以内のみ。 返金には関与しない＝集計フラグを戻すだけ。 */}
      {res.status === 'picked_up' && onUndoPickup && (
        <div className="px-4 pb-4">
          <button
            onClick={() => onUndoPickup(res.id)}
            disabled={loading}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-gray-200 text-gray-600 bg-gray-50 font-bold text-[12px] hover:bg-gray-100 active:scale-[0.98] transition-all disabled:opacity-60"
          >
            {loading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <><RotateCcw className="w-3.5 h-3.5" />受取済みを取り消す（誤タップ用）</>
            }
          </button>
        </div>
      )}
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────
export default function StoreDashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { currentStore: store, loading: storeLoading, fetchError: storeFetchError, refetch: refetchStore, stores } = useMyStores();
  const [, navigate] = useLocation();
  const storeId = store?.id ?? null;

  // 各状態に応じて自動遷移
  useEffect(() => {
    if (storeLoading) return;
    if (!store && !storeFetchError) {
      // 店舗未登録
      navigate('/store-onboarding', { replace: true });
      return;
    }
    if (store) {
      // applied / approved / pending_review すべてダッシュボード内で処理する
      // ※ 口座未登録の場合でも自動リダイレクトはしない（ループの原因になるため）
      //   マイページのバナーから手動で /store/bank-setup に遷移してもらう
    }
  }, [store, storeLoading, storeFetchError, navigate]);

  const [showPostModal, setShowPostModal] = useState(false);
  const [markingId, setMarkingId]         = useState<number | null>(null);
  const [togglingId, setTogglingId]       = useState<number | null>(null);
  const [searchCode, setSearchCode]       = useState('');
  const [adjustingId, setAdjustingId]     = useState<number | null>(null);
  const [deletingId, setDeletingId]       = useState<number | null>(null);
  const [confirmId, setConfirmId]         = useState<number | null>(null);
  const [editingBag, setEditingBag]       = useState<Bag | null>(null);
  const [showPickedUp, setShowPickedUp]   = useState(false);
  const [showExpiredActive, setShowExpiredActive] = useState(false);

  // サマリーカードのスクロール先 ref
  const activeBagsRef   = useRef<HTMLDivElement>(null);
  const pendingRef      = useRef<HTMLDivElement>(null);
  const pickedUpRef     = useRef<HTMLDivElement>(null);

  function scrollToSection(ref: React.RefObject<HTMLDivElement | null>, open?: boolean) {
    if (open) setShowPickedUp(true);
    setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, open ? 50 : 0);
  }

  // ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
  const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
               (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

  const { data: reservations = [], isLoading: resLoading, refetch } =
    useListReservations({ storeId: storeId ?? 0 }, { query: {
      queryKey: getListReservationsQueryKey({ storeId: storeId ?? 0 }),
      enabled: !!storeId,
      // ★ 購入が発生した瞬間に「本日の受取」に即出すため、
      //   アプリ起動中は15秒間隔でポーリング + ウィンドウ復帰時に即時更新。
      //   Stripe webhook → DB 反映後、最大15秒以内には画面に出る。
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      refetchInterval: 10_000,
      refetchIntervalInBackground: false,
    } });

  const { data: bags = [], refetch: refetchBags } =
    useListStoreBags(storeId ?? 0, {
      query: {
        queryKey: getListStoreBagsQueryKey(storeId ?? 0),
        enabled: !!storeId,
        staleTime: 0,             // 常に古いと見なし必ず再取得チェック
        refetchOnMount: 'always', // 画面に戻るたびサーバーから最新取得
        // ★ 出品中→売切表示もリアルタイム化（売上発生時に在庫が即時減る）
        refetchOnWindowFocus: true,
        refetchInterval: 10_000,
        refetchIntervalInBackground: false,
      },
    });

  // Stripe ライブステータス（requirements / payouts_enabled / charges_enabled）
  // ※ 残高/振込履歴は「売上確認」 タブの StoreBalanceCard で取得する
  const { data: stripeStatus } = useQuery<{
    connected: boolean;
    accountId?: string;
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirements?: {
      currentlyDue: string[];
      eventuallyDue: string[];
      errors: { code: string; reason: string; requirement: string }[];
      pendingVerification: string[];
      disabledReason: string | null;
    };
  } | null>({
    queryKey: [`/api/stores/${storeId}/connect/status`],
    queryFn: async () => {
      if (!storeId) return null;
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/connect/status`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!storeId && !!store?.stripeAccountId,
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  const updateStatus = useUpdateReservationStatus();

  // 今日の未受取予約（★決済完了済みのみ表示。未払い=決済待ちは一覧に出さない）
  //   ★ 受取日が今日以降(!isPastPickup)＝ 前日出品の「今日受取」も、 前夜に売れた「明日受取」も拾う。
  //     受取日で判定することで、 前日出品(pickupNextDay)の注文を店が見落とさない。
  const todayPending = (reservations as Reservation[]).filter(
    r => !isPastPickupReservation(r) && r.paymentStatus === 'paid' && r.status !== 'picked_up' && r.status !== 'cancelled'
  );
  const todayPickedUp = (reservations as Reservation[]).filter(
    r => !isPastPickupReservation(r) && r.status === 'picked_up'
  );
  // 受取日が過去の未処理予約（決済完了済みで受取がまだ＝対応漏れ・要フォロー）
  // 日付フィルタに関わらず受取済みにできるようにし、売上が曖昧にならないようにする
  const oldUnprocessed = (reservations as Reservation[])
    .filter(r => isPastPickupReservation(r) && r.paymentStatus === 'paid' && r.status !== 'picked_up' && r.status !== 'cancelled')
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  // 受取コードで絞り込み（数字のみ抽出して部分一致）
  const searchDigits = searchCode.replace(/\D/g, '');
  const matchesSearch = (r: Reservation) =>
    !searchDigits || (r.pickupCode ?? '').includes(searchDigits);
  const filteredTodayPending  = todayPending.filter(matchesSearch);
  const filteredTodayPickedUp = todayPickedUp.filter(matchesSearch);
  const filteredOldUnprocessed = oldUnprocessed.filter(matchesSearch);
  const totalSearchHits = filteredTodayPending.length + filteredTodayPickedUp.length + filteredOldUnprocessed.length;
  const now = new Date();
  const todayStr = todayJSTStr();
  // JST 前日の "YYYY-MM-DD"（前日夜に出した「翌日受取／深夜またぎ」バッグは createdAt=前日 だが受取日は今日）
  const yesterdayStr = toJSTDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  // ★ 「今日の板」= 今日出品分 ＋ 前日夜に出した“今日が受取日”のバッグ（翌日受取 or 深夜またぎ）。
  //   以前は createdAt===今日 だけで絞っていたため、前日21:00に翌日受取で出したバッグ（createdAt=前日）が
  //   在庫を残していても「出品中」カウンター・出品中セクションから丸ごと漏れ、0 と誤表示されるバグがあった。
  //   getBagStatus は前日作成でも受取日が今日なら active を返す（BagManageCard.tsx L79-98）ので、
  //   原因はこの前フィルタだけ。判定基準を getBagStatus の「前日作成でも有効」条件と一致させる。
  //   2日以上前の取り残しは従来どおり除外（受付終了セクションが古いバッグで溢れない）。
  const isTodaysBoardBag = (b: any): boolean => {
    try {
      const created = toJSTDateStr(b.createdAt);
      if (created === todayStr) return true;
      if (created !== yesterdayStr) return false;
      const effEnd = b.pickupEnd2 || b.pickupEnd; // 2部制は最後の枠の終わりが期限
      const isOvernight = b.pickupStart != null && effEnd != null && effEnd < b.pickupStart;
      return b.pickupNextDay === true || isOvernight;
    } catch { return false; }
  };
  const todaysBags = (bags as any[]).filter(isTodaysBoardBag);
  const activeBags     = todaysBags.filter((b: any) => getBagStatus(b, now) === 'active');
  // 出品中（active・soldout のみ — expired は除外）
  const nonIdleBags = [...todaysBags]
    .filter((b: any) => b.isActive && getBagStatus(b, now) !== 'expired')
    .sort((a: any, b: any) => {
      // 公開中(0) → 完売(1)
      const ORD: Record<string, number> = { active: 0, soldout: 1 };
      const sa = getBagStatus(a, now);
      const sb = getBagStatus(b, now);
      const diff = (ORD[sa] ?? 9) - (ORD[sb] ?? 9);
      if (diff !== 0) return diff;
      // 公開中の中は受取開始時間が早い順
      if (sa === 'active') return (a.pickupStart || '').localeCompare(b.pickupStart || '');
      return 0;
    });
  // 受付終了（本日分・isActive=true のまま時間切れ） → 折りたたみ表示
  // ★ todaysBags をベースにすることで、昨日以前の取り残しは絶対に混入しない
  const expiredActiveBags = [...todaysBags]
    .filter((b: any) => b.isActive && getBagStatus(b, now) === 'expired');

  // クイック出品用: title で重複排除（最新 id を優先）+ オーナーが × で非表示にしたものを除外
  const deduplicatedBags: PastBag[] = React.useMemo(() => {
    const seen = new Map<string, PastBag>();
    [...(bags as any[])]
      .filter((b: any) => b.hiddenFromQuickPublish !== true)
      .sort((a: any, b: any) => b.id - a.id)
      .forEach((b: any) => {
        if (!seen.has(b.title)) {
          seen.set(b.title, {
            id: b.id,
            title: b.title,
            originalPrice: b.originalPrice,
            discountedPrice: b.discountedPrice,
            imageUrl: b.imageUrl ?? null,
            category: b.category ?? null,
            itemType: b.itemType ?? 'bag',
            hiddenFromQuickPublish: b.hiddenFromQuickPublish ?? false,
          });
        }
      });
    return Array.from(seen.values()).slice(0, 5);
  }, [bags]);

  // クイック出品履歴から × ボタンで個別非表示にする (論理削除フラグ更新)
  // ★ 物理削除しない理由: 過去の予約・売上集計と紐づくバッグデータを残しておきたい。
  //   `hidden_from_quick_publish=true` にするだけで、 オーナーの「クイック出品」 リストにのみ非表示。
  async function handleHidePastBag(bagId: number) {
    if (!storeId) return;
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenFromQuickPublish: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `非表示にできませんでした (HTTP ${res.status})`);
      }
      toast({ title: 'クイック出品から非表示にしました' });
      await queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
    } catch (err: any) {
      toast({ title: err?.message ?? '非表示にできませんでした', variant: 'destructive' });
    }
  }

  // 受取済みにする
  // ※ PUT /api/reservations/:id は buyer 本人専用 (403)。 店舗オーナーは
  //    POST /api/reservations/:id/pickup (buyer or 店舗オーナー OK) を使う。
  async function handlePickedUp(id: number) {
    setMarkingId(id);
    try {
      const res = await authedFetch(`${BASE}/api/reservations/${id}/pickup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          // 既に受取済み → エラーではなく「完了済み」として扱う
          toast({ title: 'すでに受取済みです' });
          queryClient.invalidateQueries({ queryKey: [`/api/reservations`] });
          return;
        }
        throw new Error(body.message ?? body.error ?? `更新に失敗しました (HTTP ${res.status})`);
      }
      queryClient.invalidateQueries({ queryKey: [`/api/reservations`] });
      toast({ title: '受取済みにしました ✓' });
    } catch (err: any) {
      toast({ title: err?.message ?? '更新に失敗しました', variant: 'destructive' });
    } finally {
      setMarkingId(null);
    }
  }

  // 受取済みの取り消し（誤タップ救済）。 受取から24h以内のみサーバが許可。
  //   picked_up → confirmed に戻し pickedUpAt を消すだけ。 決済/返金には一切関与しない。
  async function handleUndoPickup(id: number) {
    if (!window.confirm('この予約の「受取済み」を取り消して、受取予定に戻します。\n間違えて受取済みにしてしまった時だけ実行してください。よろしいですか？')) return;
    setMarkingId(id);
    try {
      const res = await authedFetch(`${BASE}/api/reservations/${id}/pickup/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.error === 'undo_window_expired') {
          toast({ title: body.message ?? '受取から24時間を過ぎたため取り消せません。運営（DM）までご連絡ください。', variant: 'destructive' });
          return;
        }
        if (res.status === 409 && body.error === 'not_picked_up') {
          toast({ title: 'この予約は受取済みではありません' });
          queryClient.invalidateQueries({ queryKey: [`/api/reservations`] });
          return;
        }
        throw new Error(body.message ?? body.error ?? `取り消しに失敗しました (HTTP ${res.status})`);
      }
      queryClient.invalidateQueries({ queryKey: [`/api/reservations`] });
      toast({ title: '受取済みを取り消しました ✓' });
    } catch (err: any) {
      toast({ title: err?.message ?? '取り消しに失敗しました', variant: 'destructive' });
    } finally {
      setMarkingId(null);
    }
  }

  // 店舗オーナーによるキャンセル（店頭で売り切れた等でお渡しできない時）。
  //   決済済みなら全額自動返金。 在庫は戻さない（物理在庫はもう無いため）。
  async function handleCancelReservation(id: number) {
    const r = (reservations as Reservation[]).find(x => x.id === id);
    const paid = r?.paymentStatus === 'paid';
    const msg = paid
      ? 'この予約をキャンセルして、お客様に全額返金します。\nお渡しできない場合のみ実行してください。よろしいですか？'
      : 'この予約をキャンセルします。よろしいですか？';
    if (!window.confirm(msg)) return;
    setMarkingId(id);
    try {
      const res = await authedFetch(`${BASE}/api/reservations/${id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `キャンセルに失敗しました (HTTP ${res.status})`);
      }
      queryClient.invalidateQueries({ queryKey: [`/api/reservations`] });
      if (storeId) queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
      toast({ title: paid ? 'キャンセルし、返金しました ✓' : 'キャンセルしました ✓' });
    } catch (err: any) {
      toast({ title: err?.message ?? 'キャンセルに失敗しました', variant: 'destructive' });
    } finally {
      setMarkingId(null);
    }
  }

  // 公開/非公開トグル
  async function handleToggleActive(bag: Bag) {
    if (!storeId) return;
    setTogglingId(bag.id);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !bag.isActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `更新に失敗しました (HTTP ${res.status})`);
      }
      queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
      toast({ title: bag.isActive ? '非公開にしました' : '公開しました' });
    } catch (err: any) {
      toast({ title: err.message ?? '更新に失敗しました', variant: 'destructive' });
    } finally {
      setTogglingId(null);
    }
  }

  // 在庫調整
  async function handleStockAdjust(bag: Bag, delta: number) {
    if (!storeId) return;
    const next = Math.max(0, bag.stockCount + delta);
    setAdjustingId(bag.id);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockCount: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `在庫の更新に失敗しました (HTTP ${res.status})`);
      }
      queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
    } catch (err: any) {
      toast({ title: err.message ?? '在庫の更新に失敗しました', variant: 'destructive' });
    } finally {
      setAdjustingId(null);
    }
  }

  // 削除（非公開バッグのみ）
  async function handleDeleteBag(bag: Bag) {
    if (!storeId) return;
    setDeletingId(bag.id);
    setConfirmId(null);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `削除に失敗しました (HTTP ${res.status})`);
      }
      queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
      toast({ title: '商品を削除しました' });
    } catch (err: any) {
      toast({ title: err.message ?? '削除に失敗しました', variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  }

  // ─── ローディング ────────────────────────────────────────────────────
  if (storeLoading) {
    return (
      <StoreLayout>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground font-medium">店舗情報を読み込み中...</p>
          </div>
        </div>
      </StoreLayout>
    );
  }

  // ─── 店舗未登録 ──────────────────────────────────────────────────────
  if (!store) {
    return (
      <StoreLayout>
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-sm md:max-w-2xl">
            <div className="w-16 h-16 bg-orange-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-orange-400" />
            </div>
            <h2 className="text-xl font-black mb-2">店舗が見つかりません</h2>
            <p className="text-sm text-muted-foreground mb-6">先に店舗登録を行ってください。</p>
            <a
              href="/store-onboarding"
              className="inline-flex items-center gap-2 bg-primary text-white font-bold px-6 py-3 rounded-2xl hover:bg-primary/90 transition-colors"
            >
              店舗登録を始める
            </a>
          </div>
        </div>
      </StoreLayout>
    );
  }

  // ─── 却下 ────────────────────────────────────────────────────────────
  if (store.status === 'rejected') {
    return (
      <Layout>
        <div className="flex-1 flex items-center justify-center px-6 min-h-dvh">
          <div className="text-center max-w-sm md:max-w-2xl">
            <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-5">
              <XCircle className="w-10 h-10 text-red-400" />
            </div>
            <h2 className="text-xl font-black mb-2">店舗申請が却下されました</h2>
            <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
              {store.rejectionReason
                ? `却下理由：${store.rejectionReason}`
                : '申請内容を再確認のうえ、再申請してください。'}
            </p>
            <p className="text-xs text-muted-foreground mb-6">ご不明な点はLINEサポートまでお問い合わせください。</p>
            <a
              href="/store/reapply"
              className="inline-flex items-center gap-2 bg-primary text-white font-bold px-6 py-3 rounded-2xl hover:bg-primary/90 transition-colors"
            >
              再申請する
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  // ─── 口座登録済み・Stripe KYC審査待ち ─────────────────────────────────
  if (store.status === 'applied') {
    return (
      <Layout>
        <div className="flex-1 flex items-center justify-center px-6 min-h-dvh">
          <div className="text-center max-w-sm md:max-w-2xl">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-5">
              <Clock className="w-10 h-10 text-blue-400" />
            </div>
            <h2 className="text-xl font-black mb-2">決済の本人確認中</h2>
            <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
              口座情報を受け付けました。決済システムによる本人確認がバックグラウンドで進行中です。
            </p>
            <p className="text-xs text-muted-foreground mb-6">早ければ数時間で完了します。審査通過後すぐに自動で出品が開始できます。</p>
            <a
              href="/mypage"
              className="inline-flex items-center gap-2 bg-secondary text-foreground font-bold px-6 py-3 rounded-2xl hover:bg-secondary/80 transition-colors"
            >
              マイページへ
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  // ─── 口座登録未完了（bank-setup誘導）────────────────────────────────────
  if (store.status === 'pending') {
    return (
      <Layout>
        <div className="flex-1 flex items-center justify-center px-6 min-h-dvh">
          <div className="text-center max-w-sm md:max-w-2xl">
            <div className="w-20 h-20 bg-orange-50 rounded-full flex items-center justify-center mx-auto mb-5">
              <CreditCard className="w-10 h-10 text-orange-400" />
            </div>
            {store.stripeAccountId ? (
              <>
                <h2 className="text-xl font-black mb-2">本人確認情報の修正が必要です</h2>
                <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
                  口座は登録済みです。決済システムから本人確認情報の再提出が求められています。
                </p>
                <p className="text-xs text-muted-foreground mb-6">修正後すぐに再審査が開始されます。早ければ数時間で完了します。</p>
                <a
                  href="/store/bank-setup"
                  className="inline-flex items-center gap-2 bg-primary text-white font-bold px-6 py-3 rounded-2xl hover:bg-primary/90 transition-colors"
                >
                  本人確認情報を修正する
                </a>
              </>
            ) : (
              <>
                <h2 className="text-xl font-black mb-2">口座登録を完了してください</h2>
                <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
                  出品を開始するには、振込先口座と本人確認の登録が必要です。
                </p>
                <p className="text-xs text-muted-foreground mb-6">登録完了後、決済システムの確認が通り次第すぐに自動で出品が開始できます。早ければ数時間で完了します。</p>
                <a
                  href="/store/bank-setup"
                  className="inline-flex items-center gap-2 bg-primary text-white font-bold px-6 py-3 rounded-2xl hover:bg-primary/90 transition-colors"
                >
                  口座登録に進む
                </a>
              </>
            )}
          </div>
        </div>
      </Layout>
    );
  }

  // ─── 通報フラグ（管理者確認中）────────────────────────────────────────
  if (store.status === 'pending_review') {
    return (
      <Layout>
        <div className="flex-1 flex items-center justify-center px-6 min-h-dvh">
          <div className="text-center max-w-sm md:max-w-2xl">
            <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-5">
              <Eye className="w-10 h-10 text-amber-500" />
            </div>
            <h2 className="text-xl font-black mb-2">確認中</h2>
            <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
              現在、運営スタッフがアカウントを確認しています。
            </p>
            <p className="text-xs text-muted-foreground mb-6">完了次第ご連絡します。ご不明な点はLINEサポートへお問い合わせください。</p>
            <a
              href="/mypage"
              className="inline-flex items-center gap-2 bg-secondary text-foreground font-bold px-6 py-3 rounded-2xl hover:bg-secondary/80 transition-colors"
            >
              マイページへ
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  const today = format(new Date(), 'M月d日（E）', { locale: ja });

  return (
    <StoreLayout>
      <div className="max-w-2xl mx-auto w-full space-y-5">

        {/* ── 店舗セレクター（複数店舗の場合に表示） ── */}
        {stores.length > 1 && (
          <StoreSelector className="px-0" />
        )}
        {stores.length === 1 && store && (
          <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2.5">
            <Store className="w-4 h-4 text-orange-500 shrink-0" />
            <span className="text-sm font-bold text-orange-800 truncate">{store.name}</span>
            <span className="text-[10px] font-bold text-orange-500 ml-auto shrink-0">操作中</span>
          </div>
        )}

        {/* ── カバー写真バナー ── */}
        <div className="relative w-full overflow-hidden" style={{ aspectRatio: '2/1', maxHeight: 220 }}>
          {store.imageUrl ? (
            <img
              src={store.imageUrl}
              alt={store.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-orange-100 via-amber-50 to-orange-200 flex items-center justify-center">
              <Package2 className="w-14 h-14 text-orange-300" />
            </div>
          )}
          {/* グラデーション + 店名オーバーレイ */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 px-4 pb-3 flex items-end justify-between">
            <div>
              <p className="text-white/70 text-xs font-bold mb-0.5">{today}</p>
              <h1 className="text-white text-xl font-black leading-tight drop-shadow-md">{store.name}</h1>
            </div>
            <button
              onClick={() => { refetch(); refetchBags(); }}
              className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-white hover:bg-white/30 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* プロフィール編集リンク */}
          <Link href="/store/profile-edit">
            <div className="absolute top-3 right-3 bg-white/25 backdrop-blur-sm rounded-lg px-2.5 py-1 flex items-center gap-1.5 cursor-pointer hover:bg-white/40 transition-colors">
              <Pencil className="w-3 h-3 text-white" />
              <span className="text-white text-[11px] font-bold">編集</span>
            </div>
          </Link>
        </div>

        <div className="px-4 space-y-8">

        {/* ── 振込先口座未登録のお知らせ（自動リダイレクトなし・手動遷移のみ）── */}
        {store.status === 'approved' && !store.stripeAccountId && (
          <div className="!mt-8 bg-blue-50 border border-blue-200 rounded-2xl p-4 flex items-start gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center shrink-0 mt-0.5">
              <CreditCard className="w-5 h-5 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-blue-900 text-sm">振込先口座の登録が必要です</p>
              <p className="text-xs text-blue-600 mt-0.5 leading-relaxed">売上を受け取るために口座を登録してください。登録するまで出品した商品の決済は保留されます。</p>
              <button
                onClick={() => navigate('/store/bank-setup')}
                className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-black text-blue-700 bg-blue-100 hover:bg-blue-200 px-3 py-1.5 rounded-lg transition-colors"
              >
                <CreditCard className="w-3.5 h-3.5" />
                口座を登録する
              </button>
            </div>
          </div>
        )}

        {/* ── 大きなCTAボタン ── */}
        <div className="pt-3">
        {(() => {
          // ★ 出品ボタンの無効化条件:
          //   1. Stripeアカウント未登録（store.stripeAccountId が null/undefined）
          //   2. 店舗ステータスが approved 以外（pending/applied/pending_review/rejected）
          //   3. Stripe ライブAPI判定で chargesEnabled または payoutsEnabled が false
          //   いずれか1つでも該当すれば出品不可
          const noStripeAccount = !store.stripeAccountId;
          const notApproved = store.status !== 'approved';
          const stripeApiBlocked =
            stripeStatus !== undefined &&
            stripeStatus !== null &&
            (!stripeStatus.chargesEnabled || !stripeStatus.payoutsEnabled);
          // ★ Stripe が「まだ有効化されていない」理由を区別する:
          //   - needsAction: 追加提出/エラー/拒否 など → 再提出を促す(rose)
          //   - underReview: 提出済みで Stripe が確認中 → 待つだけ(再入力不要)。
          //     新規登録直後は正常に charges/payouts=false なので、これを「再提出が必要」と
          //     誤表示していた(審査中なのに「もう一度入力してください」が出るバグ)。
          const req = stripeStatus?.requirements;
          const needsAction = !!req && (
            (req.currentlyDue?.length ?? 0) > 0 ||
            (req.errors?.length ?? 0) > 0 ||
            (req.disabledReason != null && (
              req.disabledReason.startsWith('rejected') ||
              req.disabledReason === 'requirements.past_due' ||
              req.disabledReason === 'listed'
            ))
          );
          const underReview = stripeApiBlocked && !needsAction;
          const stripeBlocked = noStripeAccount || notApproved || stripeApiBlocked;

          // 警告メッセージ — どの理由でブロックされているかを優先順位付きで判定
          const blockTitle = noStripeAccount
            ? '振込先口座の登録が必要です'
            : notApproved
              ? '審査中のため出品できません'
              : underReview
                ? 'Stripeが確認中です'
                : !stripeStatus?.chargesEnabled
                  ? '本人確認の追加対応が必要です'
                  : '入金に追加対応が必要です';
          const blockDetail = noStripeAccount
            ? '売上を受け取るための口座が未登録です。「振込先口座を登録する」から登録してください。'
            : notApproved
              ? 'Stripeの審査が完了していません。本人確認書類の提出と審査完了をお待ちください。'
              : underReview
                ? '提出いただいた情報をStripeが確認しています。承認され次第、出品できるようになります。追加の入力は不要です。'
                : !stripeStatus?.chargesEnabled
                  ? 'Stripeから本人確認の追加提出を求められています。下のボタンから対応してください。'
                  : 'Stripeから入金に関する追加対応を求められています。下のボタンから対応してください。';

          return (
            <div className="space-y-3">
              {needsAction ? (
                // Stripe側の本人確認失効/追加提出など → 強制的に再提出を促す目立つブロック
                // (審査中=underReview ではここに入らず、下の優しい amber 案内になる)
                <div className="bg-rose-50 border-2 border-rose-400 rounded-2xl p-4 shadow-md">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-rose-500 text-white flex items-center justify-center text-xl shrink-0">⚠</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-black text-rose-900">{blockTitle}</p>
                      <p className="text-xs text-rose-800 mt-1 leading-relaxed">{blockDetail}</p>
                      <p className="text-[11px] text-rose-700 mt-2 leading-relaxed">
                        ※ 本人確認が完了するまで新規出品・公開操作はすべてブロックされます。
                      </p>
                    </div>
                  </div>
                  <Link href="/store/kyc">
                    <button className="w-full bg-rose-500 hover:bg-rose-600 text-white font-black py-3 rounded-xl text-sm transition-colors">
                      本人確認書類を再提出する →
                    </button>
                  </Link>
                </div>
              ) : stripeBlocked && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-2.5">
                  <span className="text-amber-500 text-base mt-0.5">⚠️</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-black text-amber-800">{blockTitle}</p>
                    <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">{blockDetail}</p>
                  </div>
                </div>
              )}
              <motion.button
                whileTap={stripeBlocked ? undefined : { scale: 0.98 }}
                onClick={() => { if (!stripeBlocked) setShowPostModal(true); }}
                disabled={stripeBlocked}
                className={`w-full rounded-2xl py-5 flex items-center justify-center gap-3 transition-all ${
                  stripeBlocked
                    ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-60'
                    : 'bg-rose-200 text-rose-700 shadow-md hover:bg-rose-300/70'
                }`}
              >
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${stripeBlocked ? 'bg-muted-foreground/20' : 'bg-rose-300/50'}`}>
                  <Plus className="w-6 h-6" />
                </div>
                <div className="text-left">
                  <p className="font-black text-base leading-tight">本日のおすそわけを出品する</p>
                </div>
              </motion.button>
            </div>
          );
        })()}
        </div>

        {/* ── クイックサマリー（タップで各セクションへジャンプ）── */}
        <div className="grid grid-cols-3 gap-3">
          {/* 出品中 → 出品中商品セクション */}
          <button
            onClick={() => scrollToSection(activeBagsRef)}
            className="bg-orange-50 border border-orange-100 rounded-2xl p-3 text-center active:scale-95 transition-transform hover:bg-orange-100/60 cursor-pointer"
          >
            <p className="text-2xl font-black text-primary">{activeBags.length}</p>
            <p className="text-[10px] font-bold text-muted-foreground mt-0.5">出品中</p>
            <p className="text-[10px] text-orange-500/70 mt-1 font-bold">確認 →</p>
          </button>

          {/* 本日の予約 → 受取予定セクション */}
          <button
            onClick={() => scrollToSection(pendingRef)}
            className="bg-blue-50 border border-blue-100 rounded-2xl p-3 text-center active:scale-95 transition-transform hover:bg-blue-100/60 cursor-pointer"
          >
            <p className="text-2xl font-black text-blue-600">{todayPending.length}</p>
            <p className="text-[10px] font-bold text-muted-foreground mt-0.5">本日の予約</p>
            <p className="text-[10px] text-blue-500/70 mt-1 font-bold">確認 →</p>
          </button>

          {/* 本日受取済 → 受取済みセクション（展開して表示） */}
          <button
            onClick={() => scrollToSection(pickedUpRef, true)}
            className="bg-green-50 border border-green-100 rounded-2xl p-3 text-center active:scale-95 transition-transform hover:bg-green-100/60 cursor-pointer"
          >
            <p className="text-2xl font-black text-green-600">{todayPickedUp.length}</p>
            <p className="text-[10px] font-bold text-muted-foreground mt-0.5">本日受取済</p>
            <p className="text-[10px] text-green-500/70 mt-1 font-bold">確認 →</p>
          </button>
        </div>

        {/* ── 売上残高カードは「売上確認」 タブへ移動済み ── */}

        {/* ── 定期出品（毎日自動公開）パイロット店のみ表示 ── */}
        {storeId && <RecurringListingsSection storeId={storeId} storeName={store.name} />}

        {/* ── 出品中の商品（active・soldout のみ）── */}
        {nonIdleBags.length > 0 && (
          <div ref={activeBagsRef}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-black text-foreground flex items-center gap-2">
                <Eye className="w-5 h-5 text-primary" />
                出品中の商品
              </h2>
              <Link
                href="/store/bags"
                className="flex items-center gap-1 text-xs font-bold text-primary hover:underline"
              >
                すべて管理 <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            <div className="space-y-3">
              {nonIdleBags.map((bag: any) => (
                <BagManageCard
                  key={bag.id}
                  bag={bag as Bag}
                  togglingId={togglingId}
                  deletingId={deletingId}
                  adjustingId={adjustingId}
                  confirmId={confirmId}
                  onToggle={handleToggleActive}
                  onDelete={handleDeleteBag}
                  onStockAdjust={handleStockAdjust}
                  onConfirmChange={setConfirmId}
                  onEdit={bag => setEditingBag(bag)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── 受付終了（isActive のまま時間切れ）── 折りたたみ */}
        {expiredActiveBags.length > 0 && (
          <div>
            <button
              onClick={() => setShowExpiredActive(v => !v)}
              className="flex items-center gap-2 w-full text-left text-sm font-bold text-muted-foreground select-none bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 hover:bg-slate-100 transition-colors"
            >
              <Clock className="w-4 h-4 text-slate-400" />
              受付終了（本日分・{expiredActiveBags.length}件）
              <span className="ml-auto text-xs text-muted-foreground/60">
                {showExpiredActive ? '▲ 閉じる' : '▼ 表示'}
              </span>
              {showExpiredActive ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
            </button>
            <AnimatePresence>
              {showExpiredActive && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-3 mt-3 opacity-70">
                    {expiredActiveBags.map((bag: any) => (
                      <BagManageCard
                        key={bag.id}
                        bag={bag as Bag}
                        togglingId={togglingId}
                        deletingId={deletingId}
                        adjustingId={adjustingId}
                        confirmId={confirmId}
                        onToggle={handleToggleActive}
                        onDelete={handleDeleteBag}
                        onStockAdjust={handleStockAdjust}
                        onConfirmChange={setConfirmId}
                        onEdit={bag => setEditingBag(bag)}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ── 受取コード検索バー ── */}
        {(todayPending.length + todayPickedUp.length + oldUnprocessed.length) > 0 && (
          <div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={searchCode}
                onChange={(e) => setSearchCode(e.target.value)}
                placeholder="受取コードで検索（例: 916117）"
                className="w-full pl-9 pr-9 py-2.5 rounded-xl border border-border bg-white text-sm font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
              {searchCode && (
                <button
                  type="button"
                  onClick={() => setSearchCode('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full hover:bg-secondary flex items-center justify-center"
                  aria-label="クリア"
                >
                  <X className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            {searchDigits && (
              <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
                {totalSearchHits > 0
                  ? <>「<span className="font-mono font-bold text-foreground">{searchDigits}</span>」に該当する予約: <strong>{totalSearchHits}件</strong></>
                  : <>「<span className="font-mono font-bold text-foreground">{searchDigits}</span>」に該当する予約はありません</>
                }
              </p>
            )}
          </div>
        )}

        {/* ── 過去の未処理予約（pending/confirmed のまま放置） ── */}
        {filteredOldUnprocessed.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-black text-foreground flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-500" />
                未処理の過去予約
              </h2>
              <span className="text-xs font-black text-amber-700 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-full">
                {filteredOldUnprocessed.length}件
              </span>
            </div>
            {!searchDigits && (
              <div className="bg-amber-50/60 border border-amber-200 rounded-2xl p-3 mb-3">
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  <strong>受取済み</strong>になっていない過去の予約があります。お客様にお渡し済みであれば「受取済みにする」を押して完了させてください。受取済みにしないと売上集計が正確になりません。
                </p>
              </div>
            )}
            <div className="space-y-3">
              {filteredOldUnprocessed.map(res => (
                <ReservationCard
                  key={res.id}
                  res={res as Reservation}
                  onPickedUp={handlePickedUp}
                  onCancel={handleCancelReservation}
                  loading={markingId === res.id}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── 本日の受取予定リスト ── */}
        {/* id="today-pickup": ベル通知「詳細を見る」からアンカージャンプ用 */}
        <div ref={pendingRef} id="today-pickup">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-black text-foreground flex items-center gap-2">
              <Ticket className="w-5 h-5 text-primary" />
              本日の受取予定
            </h2>
            <span className="text-xs font-bold text-muted-foreground bg-secondary px-2.5 py-1 rounded-full">
              {filteredTodayPending.length}件
            </span>
          </div>

          {resLoading ? (
            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm font-medium">読み込み中...</span>
            </div>
          ) : filteredTodayPending.length === 0 ? (
            searchDigits ? (
              <div className="bg-white rounded-2xl border border-dashed border-border p-6 text-center">
                <p className="text-2xl mb-2">🔍</p>
                <p className="text-sm font-bold text-foreground">該当する本日の予約はありません</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-dashed border-border p-8 text-center">
                <p className="text-3xl mb-3">📭</p>
                <p className="text-sm font-bold text-foreground">本日の予約はまだありません</p>
                <p className="text-xs text-muted-foreground mt-1">上のボタンから商品を出品してみましょう</p>
              </div>
            )
          ) : (
            <div className="space-y-3">
              {filteredTodayPending.map(res => (
                <ReservationCard
                  key={res.id}
                  res={res as Reservation}
                  onPickedUp={handlePickedUp}
                  onCancel={handleCancelReservation}
                  loading={markingId === res.id}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── 本日受取済み（折りたたみ）── */}
        {filteredTodayPickedUp.length > 0 && (
          <div ref={pickedUpRef}>
            <button
              onClick={() => setShowPickedUp(v => !v)}
              className="flex items-center gap-2 w-full text-left text-sm font-bold text-muted-foreground select-none"
            >
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              本日の受取済み（{filteredTodayPickedUp.length}件）
              <span className="ml-auto text-xs text-muted-foreground/60">
                {showPickedUp ? '▲ 閉じる' : '▼ 表示'}
              </span>
            </button>
            <AnimatePresence>
              {showPickedUp && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 space-y-3 opacity-60">
                    {filteredTodayPickedUp.map(res => (
                      <ReservationCard
                        key={res.id}
                        res={res as Reservation}
                        onPickedUp={handlePickedUp}
                        onCancel={handleCancelReservation}
                        onUndoPickup={handleUndoPickup}
                        loading={markingId === res.id}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ── 過去の出品履歴へのリンク ── */}
        <div className="px-1 pb-2">
          <Link
            href="/store/bags"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl border border-border text-sm font-bold text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <History className="w-4 h-4" />
            過去の出品履歴を見る
          </Link>
        </div>

        </div>{/* /px-4 space-y-5 */}
      </div>

      {/* ── 出品モーダル ── */}
      <AnimatePresence>
        {showPostModal && storeId && (
          <PostBagModal
            storeId={storeId}
            storeName={store.name}
            pastBags={deduplicatedBags}
            onClose={() => setShowPostModal(false)}
            onSuccess={() => {
              setShowPostModal(false);
              queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
              refetch();
            }}
            onHidePastBag={handleHidePastBag}
          />
        )}
      </AnimatePresence>

      {/* ── 編集モーダル ── */}
      <AnimatePresence>
        {editingBag && storeId && (
          <EditBagModal
            bag={editingBag}
            storeId={storeId}
            storeName={store.name}
            BASE={BASE}
            onClose={() => setEditingBag(null)}
            onSaved={() => {
              setEditingBag(null);
              queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
            }}
            onDeleted={() => {
              setEditingBag(null);
              queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
            }}
          />
        )}
      </AnimatePresence>
    </StoreLayout>
  );
}
