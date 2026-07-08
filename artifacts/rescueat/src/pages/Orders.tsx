import React, { useState } from 'react';
import { Layout } from '@/components/Layout';
import { StoreLayout } from '@/components/StoreLayout';
import { useLocation } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { useUserId } from '@/hooks/use-user';
import { useToast } from '@/hooks/use-toast';
import { useListReservations, getListReservationsQueryKey } from '@workspace/api-client-react';
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '@/lib/authed-fetch';
import { normalizeBrand } from '@/lib/brand-text';
import { pickupWindowsLabel } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Receipt, ShoppingBag, CheckCircle2, XCircle,
  Clock, Store, Printer, Share2, ChevronRight, X,
  QrCode, Leaf, FileDown, Loader2,
} from 'lucide-react';

type ReservationStatus = 'pending' | 'confirmed' | 'picked_up' | 'cancelled' | 'no_show';

const STATUS_META: Record<ReservationStatus, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  picked_up: {
    label: '受取完了',
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  confirmed: {
    label: '確認済み',
    color: 'text-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  pending: {
    label: '処理中',
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  cancelled: {
    label: 'キャンセル',
    color: 'text-rose-500',
    bg: 'bg-rose-50 dark:bg-rose-900/20',
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
  no_show: {
    label: '未受取',
    color: 'text-slate-500',
    bg: 'bg-slate-50 dark:bg-slate-900/20',
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
};

function formatDate(dateStr?: string | null) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDateShort(dateStr?: string | null) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── 受け取り「日付＋時間帯」を bag から算出 ─────────────────────────────
//   ★ 2026-07-03 事故対応: 前日出品（pickupNextDay=夜に公開して受取は翌日）のバッグで、
//     購入履歴が「購入日」しか出しておらず、お客様が“見た日＝受取日”と誤解して
//     まだ開いてない前日に来店→受け取れない事故が発生（anpan）。
//   対策: 購入履歴・受取コード欄に「実際の受取日（前日出品は +1日）＋受取時間帯」を明示する。
//   bag.createdAt = 公開日（JST）。pickupNextDay の受取日は公開日の翌日。同日出品は公開日当日。
const PICKUP_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function pickupInfo(bag: any): { dateLabel: string; window: string; nextDay: boolean } | null {
  if (!bag || !bag.createdAt) return null;
  const created = new Date(bag.createdAt);
  if (isNaN(created.getTime())) return null;
  // 公開日を JST の暦日で確定し（getPickupDateLabel と同一ロジック）、前日出品なら +1 日。
  // デバイスのタイムゾーンに依存しないよう UTC で日付演算する。
  const jstYmd = created.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  const [y, m, d] = jstYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + (bag.pickupNextDay ? 1 : 0)));
  const dateLabel = `${dt.getUTCMonth() + 1}月${dt.getUTCDate()}日(${PICKUP_WEEKDAYS[dt.getUTCDay()]})`;
  const window = pickupWindowsLabel(bag.pickupStart, bag.pickupEnd, bag.pickupStart2, bag.pickupEnd2);
  return { dateLabel, window, nextDay: !!bag.pickupNextDay };
}

// ── 6桁受取コード（OrderTicket.tsx の toDisplayCode と同一ロジック）──────────
//   pickupCode が6桁数字ならそれを、旧 RES-XXXX データは予約IDから確定的に導出。
//   ★ 濱島さん報告（2026-07）: 接客中にお客様が受取コードを探せず困る → 購入履歴の
//     各カードにも6桁コードを大きく表示して、すぐ見つけられるようにする。
function toDisplayCode(pickupCode: string | null | undefined, reservationId: number): string {
  if (pickupCode && /^\d{6}$/.test(pickupCode)) return pickupCode;
  const n = ((reservationId * 48271 + 23456) % 900000) + 100000;
  return String(n);
}

function ReceiptModal({ reservation, onClose }: { reservation: any; onClose: () => void }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [savingPdf, setSavingPdf] = useState(false);
  const status    = (reservation.status as ReservationStatus) || 'pending';
  const orderId   = `ORD-${String(reservation.id).padStart(8, '0')}`;
  const total     = Math.round(reservation.totalPrice);
  const TAX_RATE  = 0.08;                                  // 食品は軽減税率 8%
  const preTax    = Math.floor(total / (1 + TAX_RATE));
  const taxAmount = total - preTax;
  const co2Saved  = 2.5;

  // 宛名入力（任意）。入力があればそれを優先、なければDBのdisplay_name、それもなければ「お客様」
  const [recipientInput, setRecipientInput] = useState('');
  const profileName = profile?.display_name?.trim() || profile?.full_name?.trim() || '';
  // 「様」を付けるか: 実名がある場合のみ付ける。「お客様」には付けない
  const displayName = recipientInput.trim() || profileName || 'お客様';
  const showSama    = !!(recipientInput.trim() || profileName);
  const storeName     = reservation.store?.name  || '店舗名';
  const bagTitle = normalizeBrand(reservation.bag?.title) || 'おすそわけバッグ';

  // 半角数字 → 全角数字。漢字と em が揃って高さズレを解消する
  // (Noto Sans JP/Hiragino Sans でも半角数字は ~75-80% em で漢字より低く見えるため)
  const toZenkakuDigits = (s: string | number) =>
    String(s).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));

  const issueDateStr = (() => {
    const d = reservation.createdAt ? new Date(reservation.createdAt) : new Date();
    return `${toZenkakuDigits(d.getFullYear())}年${toZenkakuDigits(d.getMonth() + 1)}月${toZenkakuDigits(d.getDate())}日`;
  })();

  // ── 決済方法の正確な表示 (Apple Pay / Google Pay / カード判別) ────────────
  // 領収書を開いたタイミングで Stripe API から PaymentIntent → Charge → wallet.type
  // を取得し、 「Apple Pay (Visa)」「Google Pay (Mastercard)」「クレジットカード (JCB)」
  // のように表示する。 取得失敗 / mock 決済 / Stripe 未設定時は「クレジットカード」 にフォールバック。
  const apiBase = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
                  (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');
  const { data: pmData } = useQuery<{ wallet: string | null; brand: string | null; last4: string | null } | null>({
    queryKey: [`/api/reservations/${reservation.id}/payment-method`],
    queryFn: async () => {
      try {
        const res = await authedFetch(`${apiBase}/api/reservations/${reservation.id}/payment-method`);
        if (!res.ok) return null;
        return res.json();
      } catch { return null; }
    },
    enabled: !!reservation.id,
    staleTime: 5 * 60_000,
  });
  const paymentMethodLabel = (() => {
    const brandMap: Record<string, string> = {
      visa: 'Visa', mastercard: 'Mastercard', amex: 'AMEX',
      jcb: 'JCB', discover: 'Discover', diners: 'Diners', unionpay: 'UnionPay',
    };
    const brand = pmData?.brand ? (brandMap[pmData.brand] ?? pmData.brand.toUpperCase()) : null;
    const wallet = pmData?.wallet;
    if (wallet === 'apple_pay') return brand ? `Apple Pay (${brand})` : 'Apple Pay';
    if (wallet === 'google_pay') return brand ? `Google Pay (${brand})` : 'Google Pay';
    if (wallet === 'samsung_pay') return brand ? `Samsung Pay (${brand})` : 'Samsung Pay';
    if (wallet === 'link') return brand ? `Link (${brand})` : 'Link';
    return brand ? `クレジットカード (${brand})` : 'クレジットカード';
  })();

  // iOS Capacitor (WKWebView) では window.print() が無効なので
  // ネイティブアプリ判定して、 ネイティブでは案内 + Share へ誘導する
  const isNativeApp = (): boolean => {
    try {
      const w = window as any;
      if (w?.Capacitor?.isNativePlatform?.()) return true;
      const ua = navigator.userAgent || '';
      // iOS WKWebView (in-app webview) のヒューリスティック判定
      const isIOSStandalone = /iPhone|iPad|iPod/i.test(ua) && !/Safari/i.test(ua);
      return isIOSStandalone;
    } catch { return false; }
  };

  function handlePrint() {
    if (isNativeApp()) {
      // iOS アプリ内では window.print() が機能しない。
      // スクリーンショット保存 を案内し、 Share Sheet も併用できるようにする。
      const text = `おすそわけ 電子領収書\n${storeName}\n${bagTitle}\n金額: ¥${total.toLocaleString()}\n注文番号: ${orderId}\n発行日: ${issueDateStr}`;
      const fallbackAlert = () => {
        toast({
          title: 'スクリーンショットで保存してください',
          description: 'アプリ画面をスクリーンショットすると、領収書をカメラロールに保存できます',
          duration: 6000,
        });
      };
      if ((navigator as any).share) {
        (navigator as any)
          .share({ title: 'おすそわけ 電子領収書', text })
          .catch((err: any) => {
            // ユーザーがキャンセルしただけ (AbortError) の場合は何も案内しない。
            // それ以外の失敗 (NotAllowedError 等) はスクリーンショット案内へフォールバック。
            const name = err?.name || '';
            if (name !== 'AbortError') fallbackAlert();
          });
      } else {
        fallbackAlert();
      }
      return;
    }

    const receiptEl = document.getElementById('receipt-printable');
    if (!receiptEl) { window.print(); return; }

    // 既存の印刷コンテナがあれば削除（念のため）
    const existing = document.getElementById('osusowake-print-root');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    // 領収書のHTMLをクローンして <body> 直下に挿入
    // → モーダルの overflow/max-height 制約から完全に切り離す
    const printRoot = document.createElement('div');
    printRoot.id = 'osusowake-print-root';
    printRoot.appendChild(receiptEl.cloneNode(true));
    document.body.appendChild(printRoot);

    // 印刷ダイアログを開き、完了後にクローンを削除
    // ★ iOS Safari など `afterprint` が発火しないブラウザ・印刷キャンセル時にも
    //    確実にクリーンアップするため、 mediaQueryList と setTimeout の double-fail-safe を追加。
    //    残ったままだと他ページ (商品詳細など) の下部に領収書 DOM が見えてしまう。
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const el = document.getElementById('osusowake-print-root');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      window.removeEventListener('afterprint', cleanup);
      try { mql?.removeEventListener?.('change', mqlListener); } catch { /* noop */ }
    };
    window.addEventListener('afterprint', cleanup);

    // matchMedia('print') の change → 印刷モード解除を検知 (Safari 系の保険)
    let mql: MediaQueryList | null = null;
    let mqlListener: (e: MediaQueryListEvent) => void = () => {};
    try {
      mql = window.matchMedia('print');
      mqlListener = (e) => { if (!e.matches) cleanup(); };
      mql.addEventListener?.('change', mqlListener);
    } catch { /* unsupported */ }

    // どの環境でも 30 秒で確実に消す最終フォールバック
    setTimeout(cleanup, 30_000);

    window.print();
  }

  async function handleShare() {
    const text = `おすそわけ 電子領収書\n${storeName}\n${bagTitle}\n金額: ¥${total.toLocaleString()}\n${orderId}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'おすそわけ 電子領収書', text }); } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        toast({ title: '領収書情報をコピーしました' });
      } catch {
        toast({
          title: 'シェアに対応していないデバイスです',
          variant: 'destructive',
        });
      }
    }
  }

  // ── 領収書を PDF にして保存／共有（スマホ＝iOS共有シート、PC＝ダウンロード）──
  //   PDF生成ライブラリは遅延ロード（起動速度に影響させない）。
  //   Tailwind v4 の oklch 色に対応するため html2canvas-pro を使用。
  async function handleSavePdf() {
    const el = document.getElementById('receipt-printable');
    if (!el || savingPdf) return;
    setSavingPdf(true);
    // ★ #receipt-printable は overflow-y-auto なので、画面外の下部(注文情報/登録番号/
    //   フッター)がそのままだと撮れず PDF が途中で切れる。オフスクリーンに「全高」の
    //   クローンを置いてキャプチャする（元の表示はフラッシュさせない）。
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.cssText = el.getAttribute('style') || '';
    clone.style.position = 'fixed';
    clone.style.left = '-10000px';
    clone.style.top = '0';
    clone.style.width = `${el.offsetWidth}px`;
    clone.style.maxHeight = 'none';
    clone.style.height = 'auto';
    clone.style.overflow = 'visible';
    clone.style.background = '#ffffff';
    document.body.appendChild(clone);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas-pro'),
        import('jspdf'),
      ]);
      // Google Fonts (Noto Sans JP) は unicode-range で subset 分割されているため、
      // 領収書に含まれる漢字の subset が WebView 起動直後で未ロードのことがある。
      // 未ロード状態で html2canvas が走ると、漢字だけ system font (Mincho 系) に
      // フォールバックして数字との高さが揃わない。確実にロード完了まで待つ。
      if ((document as any).fonts?.ready) {
        try { await (document as any).fonts.ready; } catch {}
      }
      const canvas = await html2canvas(clone, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
      });
      // PDFページを領収書サイズにフィット（A4固定だと大量の余白が出るため）
      const wPx = canvas.width / 2;
      const hPx = canvas.height / 2;
      const pdf = new jsPDF({ unit: 'px', format: [wPx, hPx], orientation: hPx >= wPx ? 'portrait' : 'landscape' });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, wPx, hPx);
      const fileName = `osusowake-receipt-${orderId}.pdf`;
      const file = new File([pdf.output('blob')], fileName, { type: 'application/pdf' });
      const nav = navigator as any;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: 'おすそわけ 電子領収書' });
      } else {
        pdf.save(fileName);
      }
    } catch (e: any) {
      // 共有キャンセル(AbortError)は無視。それ以外は通知。
      if (e?.name !== 'AbortError') {
        toast({ title: 'PDFの作成に失敗しました。もう一度お試しください。', variant: 'destructive' });
      }
    } finally {
      document.body.removeChild(clone);
      setSavingPdf(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 z-50 flex items-end print:hidden"
        onClick={onClose}
      >
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className="w-full max-w-lg md:max-w-3xl mx-auto bg-white rounded-t-3xl shadow-2xl max-h-[95dvh] flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          {/* ── ドラッグハンドル + 閉じる（固定ヘッダー）─── */}
          <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0 print:hidden">
            <div className="flex-1 flex justify-center">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {/* ── 宛名入力（任意・印刷対象外）─── */}
          <div className="px-6 pb-3 shrink-0 print:hidden">
            <label className="block text-[11px] text-gray-400 font-sans mb-1 tracking-wider">
              宛名（任意）
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={recipientInput}
                onChange={e => setRecipientInput(e.target.value)}
                placeholder={profileName || 'お客様'}
                maxLength={30}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-100 transition-colors font-sans"
              />
              <span className="text-sm text-gray-500 font-sans shrink-0">様</span>
            </div>
            <p className="text-[10px] text-gray-300 mt-1 font-sans">
              未入力の場合：{profileName ? `「${profileName}」（アカウント名）` : '「お客様」'}を使用
            </p>
          </div>

          {/* ══════════════════════════════════════
              領収書本体（印刷対象）
          ══════════════════════════════════════ */}
          <div
            id="receipt-printable"
            className="px-6 pb-4 flex-1 overflow-y-auto overflow-x-hidden"
            style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif", fontVariantNumeric: 'lining-nums tabular-nums' }}
          >
            {/* ── タイトル ─────────────── */}
            <div className="text-center mb-5 border-b-2 border-t-2 border-gray-800 py-3">
              <h2
                className="text-2xl font-bold tracking-[0.4em] text-gray-900"
                style={{ fontFamily: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif' }}
              >領　収　書</h2>
              <p className="text-[10px] text-gray-400 tracking-wider mt-0.5">OFFICIAL RECEIPT</p>
            </div>

            {/* ── 番号・発行日 ─────────── */}
            <div className="flex justify-between text-xs text-gray-500 mb-4 tabular-nums">
              <span className="whitespace-nowrap">No. {orderId}</span>
              <span className="whitespace-nowrap">発行日: {issueDateStr}</span>
            </div>

            {/* ── 宛名 ─────────────────── */}
            <div className="mb-4 pb-2 border-b border-gray-300">
              <div className="flex items-end gap-2">
                <span className="text-lg font-bold text-gray-900 tracking-wide">{displayName}</span>
                {showSama && (
                  <span className="text-base text-gray-700 mb-0.5">様</span>
                )}
              </div>
              <p className="text-[11px] text-gray-400 font-sans mt-0.5">下記の通り、正に領収いたしました。</p>
            </div>

            {/* ── 金額（フォーマル二重線） ─ */}
            <div className="my-5">
              <div
                className="border-4 border-gray-800 rounded px-5 py-4 text-center relative"
                style={{ boxShadow: 'inset 0 0 0 2px white, inset 0 0 0 3px #1f2937' }}
              >
                <p className="text-[11px] text-gray-500 mb-1 tracking-widest">合計金額（税込）</p>
                <p
                  className="text-2xl font-bold tracking-[0.15em] text-gray-900"
                  style={{ fontFamily: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif' }}
                >
                  一　金　<span className="text-3xl text-gray-900">{total.toLocaleString()}</span>　円　也
                </p>
              </div>
            </div>

            {/* ── 但し書き ──────────────── */}
            <div className="mb-5 text-sm text-gray-700">
              <span className="mr-2">但し：</span>
              <span className="font-bold">{bagTitle}</span>
              <span className="ml-1">代として</span>
            </div>

            {/* ── 内訳テーブル ─────────── */}
            <div className="mb-5">
              <table className="w-full text-sm border-collapse tabular-nums">
                <thead>
                  <tr className="border-b-2 border-gray-800">
                    <th className="text-left py-1.5 text-xs text-gray-600 font-bold">項目</th>
                    <th className="text-right py-1.5 text-xs text-gray-600 font-bold">金額</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-200">
                    <td className="py-1.5 text-gray-700">小計（税抜）</td>
                    <td className="py-1.5 text-right text-gray-700 whitespace-nowrap">¥{preTax.toLocaleString()}</td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-1.5 text-gray-600">
                      <span className="whitespace-nowrap">消費税（軽減税率 ８％）</span>
                      <span className="ml-1 inline-block align-middle text-[10px] bg-green-100 text-green-700 px-1 py-0.5 rounded font-bold whitespace-nowrap">食品</span>
                    </td>
                    <td className="py-1.5 text-right text-gray-600 whitespace-nowrap">¥{taxAmount.toLocaleString()}</td>
                  </tr>
                  <tr className="border-b-2 border-gray-800 font-bold">
                    <td className="py-2 text-gray-900">合計（税込）</td>
                    <td className="py-2 text-right text-gray-900 whitespace-nowrap">¥{total.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-[10px] text-gray-400 mt-1.5">
                ※ 軽減税率（８％）対象：食料品
              </p>
            </div>

            {/* ── 商品・注文情報 ────────── */}
            <div className="bg-gray-50 rounded-lg px-4 py-3 mb-5 text-xs text-gray-600 space-y-1 border border-gray-200 tabular-nums">
              <div className="flex justify-between gap-3">
                <span className="shrink-0">ご注文番号</span>
                <span className="font-mono font-bold text-gray-800 whitespace-nowrap">{orderId}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0">お買上げ店舗</span>
                <span className="font-bold text-gray-800 text-right">{storeName}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0">商品名</span>
                <span className="font-bold text-gray-800 text-right">{bagTitle}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0">数量</span>
                <span className="font-bold text-gray-800 whitespace-nowrap">{toZenkakuDigits(reservation.quantity)}個</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0">お支払い方法</span>
                <span className="font-bold text-gray-800 text-right whitespace-nowrap">{paymentMethodLabel}</span>
              </div>
              {/* インボイス制度: 適格請求書発行事業者登録番号 (T + 13桁) を入力済み店舗のみ表示。
                  発行元欄は廃止 (店舗名は上部「店舗」 行で既に表示済み)。 一般領収書として
                  発行元名称の記載義務はなく、 国税庁 NTA 公表サイト Web-API 連携も不要。 */}
              {(reservation.store as any)?.qualifiedInvoiceNumber && (
                <div className="flex justify-between gap-3">
                  <span className="shrink-0">登録番号</span>
                  <span className="font-mono tracking-wide font-bold text-gray-800 whitespace-nowrap">
                    {(reservation.store as any).qualifiedInvoiceNumber}
                  </span>
                </div>
              )}
            </div>

            {/* ── 環境貢献バッジ ────────── */}
            <div className="mt-5 flex justify-end">
              <div className="border border-emerald-300 bg-emerald-50 rounded-xl px-3 py-2 flex items-center gap-2">
                <Leaf className="w-4 h-4 text-emerald-600 shrink-0" />
                <div>
                  <p className="text-[10px] font-bold text-emerald-700 leading-tight">環境貢献実績</p>
                  <p className="text-xs font-black text-emerald-800">CO₂ {co2Saved}kg 削減</p>
                </div>
                <span className="text-[9px] text-emerald-500 font-sans">おすそわけ</span>
              </div>
            </div>

            {/* ── フッター ─────────────── */}
            <p className="text-center text-[9px] text-gray-400 font-sans mt-4">
              本書はアプリ内「購入履歴」から発行した電子領収書です。<br />
              印刷またはPDFとして保存してご使用ください。<br />
              おすそわけ — お店の余ったおいしさを、あなたへ。
            </p>
          </div>

          {/* ── アクションボタン（常に表示・印刷時は非表示）── */}
          <div className="px-6 pb-6 flex gap-2 shrink-0 print:hidden border-t border-gray-100 pt-4 bg-white">
            <button
              onClick={handleShare}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-50 transition-colors"
            >
              <Share2 className="w-4 h-4" />
              シェア
            </button>
            <button
              onClick={handleSavePdf}
              disabled={savingPdf}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-50 transition-colors disabled:opacity-60"
            >
              {savingPdf ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              PDF保存
            </button>
            <button
              onClick={handlePrint}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-gray-900 text-white font-bold text-sm hover:bg-gray-800 transition-colors"
            >
              <Printer className="w-4 h-4" />
              印刷
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export default function Orders() {
  const userId = useUserId() || '';
  const { profile } = useAuth();
  const [, navigate] = useLocation();
  const { data: reservations, isLoading } = useListReservations(
    { userId },
    {
      query: {
        queryKey: getListReservationsQueryKey({ userId }),
        enabled: !!userId,
        // 購入履歴は受取直後にも必ず最新を反映するため、マウント時に常に再取得する
        refetchOnMount: 'always',
        staleTime: 0,
      },
    }
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'picked_up' | 'cancelled'>('all');

  const isStoreOwner = profile?.role === 'store_owner';

  const filtered = (reservations || [])
    .filter(r => {
      if (filter === 'all') return true;
      if (filter === 'picked_up') return r.status === 'picked_up';
      if (filter === 'cancelled') return r.status === 'cancelled' || (r.status as string) === 'no_show';
      return true;
    })
    // 新規順（新しい購入を上に）。createdAt 同着は id 降順で安定化。
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (b.id ?? 0) - (a.id ?? 0);
    });

  // 領収書は受取完了 (picked_up) のみ発行可能。 キャンセル/no_show/未受取は不可。
  const selectedRaw = reservations?.find(r => r.id === selectedId);
  const selected = selectedRaw?.status === 'picked_up' ? selectedRaw : null;

  const totalSpent = (reservations || [])
    .filter(r => r.status === 'picked_up')
    .reduce((s, r) => s + r.totalPrice, 0);

  const PageWrapper = isStoreOwner ? StoreLayout : Layout;
  const wrapperProps = isStoreOwner ? { showHeader: false } : { showBottomNav: false };

  return (
    <PageWrapper {...wrapperProps as any}>
      <div className="w-full max-w-md md:max-w-2xl mx-auto pb-16 overflow-x-hidden">
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 pb-4 sticky top-0 bg-background/90 backdrop-blur-sm z-10 border-b border-border/50"
          style={{ paddingTop: isStoreOwner ? 'calc(env(safe-area-inset-top) + 1rem)' : '1rem' }}
        >
          <button
            onClick={() => navigate('/mypage')}
            className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black text-foreground leading-tight">購入履歴</h1>
            <p className="text-xs text-muted-foreground">Order History</p>
          </div>
        </div>

        <div className="px-4 pt-5">
          {/* Summary card */}
          <div className="bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 rounded-2xl p-4 mb-5 flex gap-4">
            <div className="flex-1 text-center">
              <p className="text-2xl font-black text-primary">{reservations?.filter(r => r.status === 'picked_up').length ?? 0}</p>
              <p className="text-[11px] font-bold text-primary/70 mt-0.5">受取完了</p>
            </div>
            <div className="w-px bg-primary/20" />
            <div className="flex-1 text-center">
              <p className="text-2xl font-black text-primary">¥{totalSpent.toLocaleString()}</p>
              <p className="text-[11px] font-bold text-primary/70 mt-0.5">総購入額</p>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="flex gap-2 mb-4">
            {[
              { key: 'all', label: 'すべて' },
              { key: 'picked_up', label: '完了' },
              { key: 'cancelled', label: 'キャンセル' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key as typeof filter)}
                className={`px-3 py-1.5 rounded-full text-xs font-black transition-all
                  ${filter === key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Orders list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-secondary/50 rounded-2xl p-10 text-center">
              <ShoppingBag className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-bold text-muted-foreground text-sm">注文履歴がありません</p>
              <p className="text-xs text-muted-foreground mt-1">おすそわけバッグを受け取ると、ここに表示されます</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(r => {
                const status = (r.status as ReservationStatus) || 'pending';
                const meta = STATUS_META[status] || STATUS_META.pending;
                const pi = pickupInfo(r.bag);
                return (
                  <motion.button
                    key={r.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => setSelectedId(r.id)}
                    className="w-full max-w-[calc(100vw-2rem)] bg-card border border-border rounded-2xl overflow-hidden text-left hover:bg-secondary/30 active:scale-[0.99] transition-all shadow-sm"
                  >
                    <div className="flex items-center gap-3 p-4 w-full min-w-0">
                      {/* Store image */}
                      <div className="w-12 h-12 bg-muted rounded-xl overflow-hidden shrink-0">
                        <img
                          src={r.store?.iconUrl || r.store?.imageUrl || 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=200&q=70'}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </div>

                      {/* Main info */}
                      <div className="flex-1 min-w-0">
                        {/* Row 1: store name + badge */}
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <p className="font-black text-sm text-foreground truncate min-w-0 flex-1">{r.store?.name || '店舗不明'}</p>
                          <span className={`flex items-center gap-0.5 ${meta.bg} ${meta.color} px-1.5 py-0.5 rounded-full text-[10px] font-black shrink-0 whitespace-nowrap`}>
                            {meta.icon}
                            {meta.label}
                          </span>
                        </div>
                        {/* Row 2: bag title */}
                        <p className="text-xs text-muted-foreground truncate min-w-0">{normalizeBrand(r.bag?.title) || 'おすそわけバッグ'}</p>
                        {/* Row 3: 受取日時 + price
                            ★ 以前は購入日(createdAt)を出していて、前日出品バッグで
                              「受取日」と誤解される事故があった。実際の受取日+時間帯を出す。 */}
                        <div className="flex items-center justify-between gap-2 mt-2">
                          {pi ? (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                              <Clock className="w-3 h-3 shrink-0 text-primary" />
                              <span className="truncate">
                                <span className="font-bold text-foreground">受取 {pi.dateLabel}</span>
                                {pi.window && <span className="ml-1">{pi.window}</span>}
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                              <Store className="w-3 h-3 shrink-0" />
                              <span className="shrink-0">{formatDateShort(r.createdAt)}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 shrink-0">
                            {status === 'picked_up' && (
                              <span className="flex items-center gap-0.5 bg-primary/10 text-primary text-[10px] font-black px-1.5 py-0.5 rounded-full border border-primary/20">
                                <Receipt className="w-3 h-3" />
                                領収書
                              </span>
                            )}
                            <span className="font-black text-foreground text-sm">¥{r.totalPrice.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>

                      {/* Chevron — 外側に独立させてクリッピングを防ぐ */}
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </div>

                    {/* ── 受取コード（未受取＝pending/confirmed のみ大きく表示）──
                        濱島さん報告対応: お店で提示する6桁コードを購入履歴からすぐ見つけられるように。
                        受取完了・キャンセルは提示不要なので出さない。 */}
                    {(status === 'pending' || status === 'confirmed') && (
                      <div className="mx-4 mb-3 -mt-1 space-y-2">
                        {/* ★ 受け取り日時を最優先で明示（前日出品で来店日を誤解する事故の再発防止） */}
                        {pi && (
                          <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-300/60 dark:border-amber-700/40 rounded-xl px-3 py-2">
                            <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <p className="text-[10px] font-bold text-amber-700/80 dark:text-amber-400/80 leading-tight">受け取り日時（この日時にご来店ください）</p>
                              <p className="text-sm font-black text-amber-800 dark:text-amber-300 leading-tight mt-0.5">
                                {pi.dateLabel}{pi.window && <span className="ml-1.5">{pi.window}</span>}
                              </p>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
                          <span className="flex items-center gap-1.5 text-[11px] font-bold text-primary/80 shrink-0">
                            <QrCode className="w-3.5 h-3.5" />
                            お店に見せる受取コード
                          </span>
                          <span className="font-mono font-black text-xl tracking-[0.25em] text-primary tabular-nums whitespace-nowrap">
                            {toDisplayCode((r as any).pickupCode, r.id)}
                          </span>
                        </div>
                      </div>
                    )}
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Receipt modal */}
      <AnimatePresence>
        {selected && (
          <ReceiptModal reservation={selected} onClose={() => setSelectedId(null)} />
        )}
      </AnimatePresence>
    </PageWrapper>
  );
}
