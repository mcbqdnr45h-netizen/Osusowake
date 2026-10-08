import { useEffect, useState } from 'react';
import { Clock, Package, Store, Info, AlertTriangle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { getDisplayPrice, getDisplayDiscountPercent } from '@/lib/price-display';
import { getCategoryImage, getImageFromName } from '@/lib/category-utils';
import { pickupWindowsLabel } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';

// 予約情報から購入した商品の詳細を表示するシート。
//   お客様が「あの日買った商品なんやったっけ？」を後から見返せるように、
//   商品名・写真・説明・アレルギー・元値/販売価格・受取時間・受取メモ・数量を一覧する。
//   予約に含まれる bag データ (surpriseBagsTable 全カラム) だけを使うので API 追加不要。
export interface PurchasedBagData {
  title?: string | null;
  description?: string | null;
  originalPrice?: number | null;
  discountedPrice?: number | null;
  imageUrl?: string | null;
  category?: string | null;
  allergyInfo?: string | null;
  pickupNote?: string | null;
  pickupStart?: string | null;
  pickupEnd?: string | null;
  pickupStart2?: string | null;
  pickupEnd2?: string | null;
}

export type PurchasedBagStatus =
  | 'pending'
  | 'confirmed'
  | 'picked_up'
  | 'cancelled'
  | 'expired'
  | 'no_show';

interface PurchasedBagSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bag: PurchasedBagData | null | undefined;
  storeName?: string | null;
  quantity: number;
  purchasedAt: string;
  status?: PurchasedBagStatus;
  // ★ 期限切れ判定は呼び出し側で isPickupExpired() を評価して渡す。
  //   DB 上のステータスは pending/confirmed のままでも、受取期限を過ぎていれば
  //   ユーザーには「受取期限切れ」で見せる必要がある (カード一覧と表示齟齬を防ぐ)。
  expired?: boolean;
}

export function PurchasedBagSheet({
  open,
  onOpenChange,
  bag,
  storeName,
  quantity,
  purchasedAt,
  status,
  expired,
}: PurchasedBagSheetProps) {
  // ★ Sheet 閉じアニメーション対策: bag=null 直後に return null してしまうと、
  //    Radix の Portal がアンマウントされ slide-out-to-bottom アニメが飛ぶ。
  //    close 開始→アニメ完了までは直前の bag/props をキャッシュして表示続行する。
  const [snapshot, setSnapshot] = useState<{
    bag: PurchasedBagData;
    storeName?: string | null;
    quantity: number;
    purchasedAt: string;
    status?: PurchasedBagStatus;
    expired?: boolean;
  } | null>(null);

  useEffect(() => {
    if (bag) {
      setSnapshot({ bag, storeName, quantity, purchasedAt, status, expired });
    }
  }, [bag, storeName, quantity, purchasedAt, status, expired]);

  useEffect(() => {
    if (!open) {
      // Sheet の slide-out-to-bottom は 300ms (sheet.tsx)。 少し余裕を持って400ms後に破棄。
      const t = setTimeout(() => setSnapshot(null), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const active = snapshot ?? (bag ? { bag, storeName, quantity, purchasedAt, status, expired } : null);
  if (!active) return null;

  const rawTitle = active.bag.title?.trim();
  const title = rawTitle && rawTitle.length > 0 ? rawTitle : 'おすそわけ袋';
  // ★ img fallback: 生の imageUrl → 商品名からの推測 → カテゴリプール。
  //    data: スキーム (旧データ由来の可能性) は防御的に弾いておく。 svg XSS は img タグでは
  //    発火しないが、大きい base64 で画面が壊れるケースを避ける意味でも安全策。
  const safeUrl = active.bag.imageUrl && !/^data:/i.test(active.bag.imageUrl) ? active.bag.imageUrl : null;
  const fallbackImg = getImageFromName(title, title) || getCategoryImage(active.bag.category || '', title);
  const img = safeUrl || fallbackImg;

  const price = getDisplayPrice(active.bag.discountedPrice ?? 0);
  const original = getDisplayPrice(active.bag.originalPrice);
  const pct = getDisplayDiscountPercent(active.bag.originalPrice, active.bag.discountedPrice ?? 0);
  // ★ line-through ゲートは fee-adjusted 表示価格で比較する。 raw で判定すると
  //    10円未満の差が丸めで同額になり「¥110 ~~¥110~~」の恥ずかしい表示になる。
  const showOriginalStrike = original > price && pct > 0;

  const pickupTime = pickupWindowsLabel(
    active.bag.pickupStart,
    active.bag.pickupEnd,
    active.bag.pickupStart2,
    active.bag.pickupEnd2,
  ).replace(/^\s*\/\s*/, ''); // 万一 window1 空 + window2 のみの奇形入力の " / xxx" を掃除
  const shopName = active.storeName?.trim() || 'お店';
  const description = active.bag.description?.trim() || null;
  const allergy = active.bag.allergyInfo?.trim() || null;
  const pickupNote = active.bag.pickupNote?.trim() || null;

  // ★ 期限切れは呼び出し側で判定して渡す (DB status とは別軸)。
  //    expired=true なら status 種別に関わらず「受取期限切れ」を優先表示する。
  const statusLabel = expiredOrStatusLabel(active.status, active.expired);

  // ★ 購入日は Postgres timestamp 由来なので通常は有効 ISO だが、
  //    万一パース失敗しても throw させない。
  const purchasedAtLabel = safeFormatDate(active.purchasedAt);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="z-[200] max-h-[92vh] overflow-y-auto rounded-t-3xl px-0 pb-[calc(env(safe-area-inset-bottom)+12px)]"
      >
        <SheetHeader className="px-5">
          <SheetTitle className="text-base font-black flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" />
            購入した商品の詳細
          </SheetTitle>
          <SheetDescription className="sr-only">
            購入した袋の商品名・受取時間・受取メモなどをまとめて表示します。
          </SheetDescription>
        </SheetHeader>

        {/* Hero image */}
        <div className="relative w-full aspect-[16/10] bg-muted mt-3">
          <img
            src={img}
            alt={title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={(e) => {
              // 画像 URL が切れていても壊れアイコンを露出しない。 カテゴリプールへ差し替え。
              const fallback = getCategoryImage(active.bag.category || '', title);
              if (fallback && e.currentTarget.src !== fallback) {
                e.currentTarget.src = fallback;
              }
            }}
          />
          {pct > 0 && (
            <span
              className="absolute top-3 right-3 inline-flex items-center gap-1 text-white text-xs font-black px-2.5 py-1 rounded-md shadow"
              style={{ background: pct >= 20 ? 'linear-gradient(135deg,#F07826,#E85A0C)' : '#F8854A' }}
            >
              {pct}% OFF
            </span>
          )}
          <span className="absolute top-3 left-3 inline-flex items-center gap-1 bg-white/95 backdrop-blur text-foreground text-[10.5px] font-bold px-2.5 py-1 rounded-md shadow">
            {statusLabel}
          </span>
        </div>

        <div className="px-5 py-4">
          {/* Store name (親に min-w-0 を入れないと truncate が効かない) */}
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1 min-w-0">
            <Store className="w-3 h-3 shrink-0" />
            <span className="truncate min-w-0">{shopName}</span>
          </div>

          {/* Title + quantity */}
          <h3 className="text-lg font-black leading-snug mb-2">
            {title}
            <span className="text-sm font-bold text-muted-foreground ml-2">×{quantity}</span>
          </h3>

          {/* Price
             ★ React は「短絡評価の値をそのまま描画」する仕様なので、
               `{original && ...}` は original===0 の時に "0" が可視テキストとして残る。
               必ず boolean に落として比較する (JSX 描画バグの典型)。 */}
          {price > 0 && (
            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-2xl font-black text-primary">¥{price}</span>
              {showOriginalStrike ? (
                <span className="text-xs text-muted-foreground line-through">¥{original}</span>
              ) : null}
            </div>
          )}

          {/* Description */}
          {description && (
            <div className="mb-4 p-3 bg-muted/40 rounded-xl">
              <div className="text-[10.5px] font-black text-foreground/60 tracking-wider mb-1.5 flex items-center gap-1">
                <Info className="w-3 h-3" /> 商品の説明
              </div>
              <p className="text-[12.5px] leading-relaxed text-foreground/90 whitespace-pre-wrap">{description}</p>
            </div>
          )}

          {/* Allergy */}
          {allergy && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <div className="text-[10.5px] font-black text-amber-700 tracking-wider mb-1.5 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> アレルギー情報
              </div>
              <p className="text-[12.5px] leading-relaxed text-amber-900 whitespace-pre-wrap">{allergy}</p>
            </div>
          )}

          {/* 受取情報グループ: 受取時間 + 受取メモをまとめて上部に。
             受取メモは「受取場所」「店員への合言葉」など、受取前に確認したい情報が入るので、
             見落とし防止のため受取時間の直下に強調表示する。
             ★ 受取メモは「そもそも存在する」ことをユーザーに認識してもらうため、
                店が設定していない場合も見出しは残して「特にありません」を表示する。 */}
          <div className="mb-4 p-3.5 bg-primary/5 rounded-xl border border-primary/15">
            <div className="text-[10.5px] font-black text-primary tracking-wider mb-2 flex items-center gap-1">
              <Clock className="w-3 h-3" /> 受取に関する情報
            </div>
            {pickupTime && (
              <div className="mb-2.5 text-[12.5px]">
                <span className="text-[10.5px] font-bold text-muted-foreground">受取時間　</span>
                <span className="font-semibold text-foreground/90">{pickupTime}</span>
              </div>
            )}
            <div className="text-[12.5px]">
              <div className="text-[10.5px] font-bold text-muted-foreground mb-1">受取メモ（お店より）</div>
              {pickupNote ? (
                <p className="leading-relaxed text-foreground/90 whitespace-pre-wrap">{pickupNote}</p>
              ) : (
                <p className="text-muted-foreground/70 italic">特にありません</p>
              )}
            </div>
          </div>

          {/* Purchase date */}
          {purchasedAtLabel && (
            <div className="mt-4 pt-3 border-t border-border text-[11px] text-muted-foreground">
              購入日：{purchasedAtLabel}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ステータス表示ラベルの選択。 expired=true なら DB status を無視して「受取期限切れ」。
function expiredOrStatusLabel(status: PurchasedBagStatus | undefined, expired?: boolean): string {
  if (expired) return '受取期限切れ';
  switch (status) {
    case 'picked_up': return '受取完了';
    case 'confirmed': return '予約中';
    case 'pending':   return '未払い';
    case 'cancelled': return 'キャンセル済';
    case 'expired':   return '受取期限切れ';
    case 'no_show':   return '受取なし';
    default:          return '予約';
  }
}

function safeFormatDate(iso: string): string {
  try {
    const d = parseISO(iso);
    if (isNaN(d.getTime())) return '';
    return format(d, 'yyyy年M月d日 HH:mm', { locale: ja });
  } catch {
    return '';
  }
}
