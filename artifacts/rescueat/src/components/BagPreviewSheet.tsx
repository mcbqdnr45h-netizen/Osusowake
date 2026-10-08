import { Clock, Gift, Sparkles } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { getDisplayPrice, getDisplayDiscountPercent } from '@/lib/price-display';
import { getCategoryImage, getImageFromName } from '@/lib/category-utils';
import { normalizeBrand } from '@/lib/brand-text';
import { pickupWindowsLabel } from '@/lib/utils';

// 登録フォームの値からお客様画面を再現するプレビュー。
//   ★ 本物のお客様カード(BagCard)/詳細(BagDetail)と同じ CSS(画像 object-cover の見切り・
//     タイトル line-clamp-2 の折り返し・価格5%加算の表示) を使い、 体裁を事前確認できるようにする。
//   BagCard 本体はお気に入り/遷移/位置情報など副作用が多いので、 表示専用に同等のレイアウトを再現する。
export interface BagPreviewData {
  title: string;
  description?: string | null;
  originalPrice?: number | null;
  discountedPrice: number;
  stockCount: number;
  pickupStart?: string | null;
  pickupEnd?: string | null;
  pickupStart2?: string | null;
  pickupEnd2?: string | null;
  imageUrl?: string | null;
  category?: string | null;
  allergyInfo?: string | null;
  pickupNote?: string | null;
  itemType?: 'bag' | 'item';
  pickupNextDay?: boolean;
}

export function BagPreviewSheet({
  open,
  onOpenChange,
  data,
  storeName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: BagPreviewData;
  storeName: string;
}) {
  const title = (data.title || 'おすそわけ袋').trim();
  // 画像フォールバックは BagCard と同じ優先順: 登録画像 → 商品名から推測 → カテゴリ画像
  const img = data.imageUrl || getImageFromName(title, title) || getCategoryImage(data.category || '', title);
  const price = getDisplayPrice(data.discountedPrice);
  const original = getDisplayPrice(data.originalPrice);
  const pct = getDisplayDiscountPercent(data.originalPrice, data.discountedPrice);
  const pickupTime = pickupWindowsLabel(data.pickupStart, data.pickupEnd, data.pickupStart2, data.pickupEnd2);
  const dayLabel = data.pickupNextDay ? '明日' : '本日';
  const stock = data.stockCount;
  const isLowStock = stock > 0 && stock <= 2;
  const shopName = storeName?.trim() || 'あなたのお店';
  const desc = (data.description && data.description.trim())
    || `${shopName}のおすそわけです。お店の味を、ぜひ受け取ってください！`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="z-[200] max-h-[90vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>お客様にはこう見えます（プレビュー）</SheetTitle>
        </SheetHeader>
        <p className="text-[11px] text-muted-foreground mb-4">
          写真の見切り・文字の折り返しを、 登録中の内容そのままで確認できます。
        </p>

        {/* ① 一覧での見え方（マップ/検索のカード） */}
        <p className="text-[11px] font-black text-foreground/55 tracking-wider mb-1.5">① 一覧での見え方</p>
        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-6 max-w-[340px] mx-auto">
          <div className="relative aspect-[4/3] bg-muted">
            <img src={img} alt={title} className="w-full h-full object-cover" />
            {pct > 0 && (
              <span
                className="absolute top-2 right-2 inline-flex items-center gap-0.5 text-white text-[11px] font-black px-2 py-0.5 rounded-md rotate-1"
                style={{ background: pct >= 20 ? 'linear-gradient(135deg,#F07826,#E85A0C)' : '#F8854A' }}
              >
                {pct >= 20 && <Sparkles className="w-3 h-3" />}{pct}% OFF
              </span>
            )}
          </div>
          <div className="p-4 pb-3.5">
            <p className="text-[11px] text-muted-foreground font-medium truncate mb-0.5">{shopName}</p>
            <h3 className="font-bold leading-snug tracking-tight line-clamp-2 text-[15px] mb-2">{normalizeBrand(title)}</h3>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-2">
              <Clock className="w-3 h-3 shrink-0" />
              <span>受取 {dayLabel} {pickupTime}</span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                {pct > 0 && <span className="text-[11px] text-muted-foreground line-through mr-1">¥{original.toLocaleString()}</span>}
                <span className="text-xl font-black text-primary">¥{price.toLocaleString()}</span>
              </div>
              <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full ${isLowStock ? 'bg-rose-50 text-rose-600' : 'bg-muted/60 text-muted-foreground'}`}>
                <Gift className="whitespace-nowrap w-3 h-3" />残り{stock}個
              </span>
            </div>
          </div>
        </div>

        {/* ② 詳細画面での見え方 */}
        <p className="text-[11px] font-black text-foreground/55 tracking-wider mb-1.5">② 詳細画面での見え方</p>
        <div className="border border-border rounded-2xl overflow-hidden mb-4 max-w-[380px] mx-auto">
          <div className="relative w-full h-56 bg-muted">
            <img src={img} alt={title} className="w-full h-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
            <h1
              className="absolute left-4 right-4 bottom-3 text-[24px] font-black text-white leading-[1.15]"
              style={{ textShadow: '0 2px 12px rgba(0,0,0,0.45)' }}
            >
              {normalizeBrand(title)}
            </h1>
          </div>
          <div className="p-4 space-y-3">
            <div className="rounded-2xl border border-[#F2D5B6] bg-gradient-to-br from-[#FFF8F1] to-[#FFE2CB] px-4 py-3 flex items-end justify-between">
              <div>
                {pct > 0 && <span className="block text-xs text-muted-foreground line-through">¥{original.toLocaleString()}</span>}
                <span className="text-4xl font-black text-primary">¥{price.toLocaleString()}</span>
              </div>
              {pct > 0 && (
                <span className="text-white text-xs font-black px-2 py-1 rounded-lg" style={{ background: 'linear-gradient(135deg,#F07826,#E85A0C)' }}>
                  {pct}% OFF
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[13px]">
              <Clock className="w-4 h-4 text-primary shrink-0" />
              <span className="font-bold">受取時間：</span>
              <span>{dayLabel} {pickupTime}</span>
            </div>
            <div className="bg-stone-50 border border-stone-100 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
              <p className="text-[14px] text-foreground/85 leading-relaxed whitespace-pre-wrap italic">{desc}</p>
            </div>
            {data.allergyInfo && data.allergyInfo.trim() && (
              <p className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200/70 rounded-lg px-3 py-2">⚠️ アレルギー：{data.allergyInfo}</p>
            )}
            {data.pickupNote && data.pickupNote.trim() && (
              <p className="text-[12px] text-foreground/80 bg-secondary/50 rounded-lg px-3 py-2">📌 受取時の注意：{data.pickupNote}</p>
            )}
            <span className={`inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 rounded-full ${isLowStock ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
              <Gift className="w-3.5 h-3.5" />残り {stock} 個
            </span>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground text-center pb-2">
          ※ 写真の見切れ・文字の折り返しの確認用です。 実画面とは細部が異なる場合があります。
        </p>
      </SheetContent>
    </Sheet>
  );
}
