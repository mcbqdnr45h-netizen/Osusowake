import React from 'react';
import {
  Clock, Loader2, Minus, MoreVertical, Package2, Pencil, Plus, ToggleLeft, ToggleRight, Trash2,
  CalendarClock,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ★ 出品日時を「M/D HH:MM」 形式で表示 (端末タイムゾーン基準 = ほぼ JST)。
//   オーナーが「これいつ出品したやつ?」 を一目で判別するための補助情報。
function formatPostedAt(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const m  = d.getMonth() + 1;
    const dd = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${dd} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

// ★ お客様が実際に支払う金額 (販売価格にシステム利用料5%を上乗せし10円単位で切り上げ)。
//   reservations.ts / StoreDashboard の buyerTotalJpy と完全同一ロジック。
//   切り上げ理由: 四捨五入だと低額帯で買い手合計 < 販売価格 になる逆転を防ぐため。
function buyerTotalJpy(merchandiseJpy: number): number {
  if (!Number.isFinite(merchandiseJpy) || merchandiseJpy <= 0) return 0;
  return Math.ceil((merchandiseJpy * 1.05) / 10) * 10;
}

// ─── 型 ──────────────────────────────────────────────────────────────────────
export interface Bag {
  id: number;
  title: string;
  discountedPrice: number;
  originalPrice: number;
  stockCount: number;
  reservedCount?: number;
  pickupStart: string | null;
  pickupEnd: string | null;
  isActive: boolean;
  createdAt: string;
  itemType?: string | null;
  hiddenFromQuickPublish?: boolean;
  description?: string | null;
  allergyInfo?: string | null;
  pickupNote?: string | null;
  imageUrl?: string | null;
  category?: string | null;
}

export function getItemTypeLabel(itemType?: string | null): { label: string; emoji: string; cls: string } {
  if (itemType === 'item') {
    return { label: '単品', emoji: '🥡', cls: 'bg-blue-50 text-blue-600 border border-blue-200' };
  }
  return { label: 'おすそわけ袋', emoji: '🛍', cls: 'bg-orange-50 text-orange-600 border border-orange-200' };
}

export type BagRealStatus = 'active' | 'expired' | 'soldout' | 'inactive';

/** UTC ISO 文字列 → JST "YYYY-MM-DD" 変換（タイムゾーン依存ゼロ） */
function toJSTDateStrBag(utcIso: string): string {
  const raw = utcIso.endsWith('Z') || utcIso.includes('+') ? utcIso : utcIso + 'Z';
  const jstMs = new Date(raw).getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

export function getBagStatus(
  bag: { isActive: boolean; stockCount: number; pickupEnd: string | null; pickupStart?: string | null; pickupEnd2?: string | null; pickupNextDay?: boolean; createdAt: string },
  now: Date,
): BagRealStatus {
  if (!bag.isActive) return 'inactive';

  // JST 基準の日付文字列
  const jstNow       = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr     = jstNow.toISOString().slice(0, 10);
  const yesterdayStr = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createdStr   = toJSTDateStrBag(bag.createdAt);

  if (bag.pickupEnd) {
    const currentTime = jstNow.toISOString().slice(11, 16);
    // ★ 2部制(受取2枠): 期限は「最後の枠の終わり」= pickupEnd2 があればそちら（一覧の bagVisibleSql と一致）。
    const effEnd = bag.pickupEnd2 || bag.pickupEnd;

    // 深夜またぎ判定は最後の枠(effEnd)基準（例: 単枠 22:00-01:00／2部制 11:00-14:00,22:00-02:00）。
    // slot1 の pickupEnd だけ見ると2部制2枠目の日跨ぎを取りこぼし、同日に消える（一覧 bagVisibleSql と一致させる）。
    const isOvernight = bag.pickupStart != null && effEnd < bag.pickupStart;

    if (bag.pickupNextDay) {
      // 翌日受取（前日出品）: 今日出品→受取は明日なのでまだ有効。
      //   昨日出品→今日が受取日（effEnd を過ぎたら期限切れ）。 それ以前→期限切れ。
      if (createdStr !== todayStr) {
        if (createdStr === yesterdayStr) {
          if (currentTime > effEnd) return 'expired';
        } else {
          return 'expired';
        }
      }
    } else if (isOvernight) {
      if (createdStr === todayStr) {
        // 今日出品 → 翌日の pickupEnd まで有効
        return bag.stockCount === 0 ? 'soldout' : 'active';
      } else if (createdStr === yesterdayStr) {
        // 昨日出品 → 翌日（今日）の effEnd を過ぎたら期限切れ
        if (currentTime > effEnd) return 'expired';
      } else {
        return 'expired'; // 2日以上前
      }
    } else {
      // 通常バッグ：今日出品 かつ effEnd 未達ならアクティブ
      if (createdStr !== todayStr) return 'expired';
      if (currentTime > effEnd) return 'expired';
    }
  } else {
    // pickupEnd 未設定バッグ：出品日（JST）が今日でなければ期限切れとみなす
    if (createdStr !== todayStr) return 'expired';
  }

  if (bag.stockCount === 0) return 'soldout';
  return 'active';
}

export const STATUS_BADGE: Record<BagRealStatus, { text: string; cls: string }> = {
  active:   { text: '公開中',   cls: 'bg-green-50 text-green-700 border border-green-200' },
  expired:  { text: '受付終了', cls: 'bg-slate-100 text-slate-500 border border-slate-200' },
  soldout:  { text: '完売',     cls: 'bg-red-50 text-red-500 border border-red-200' },
  inactive: { text: '非公開',   cls: 'bg-gray-100 text-gray-500 border border-gray-200' },
};

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
  bag: Bag;
  togglingId: number | null;
  deletingId: number | null;
  adjustingId: number | null;
  confirmId: number | null;
  onToggle: (bag: Bag) => void;
  onDelete: (bag: Bag) => void;
  onStockAdjust: (bag: Bag, delta: number) => void;
  onConfirmChange: (id: number | null) => void;
  onEdit: (bag: Bag) => void;
  // ★ 過去履歴画面(StoreBagsPage)では onEdit が「受取時間編集」専用のため、
  //   汎用「編集」項目を出すと『編集/受取時間を編集して公開/時間編集ボタン』が
  //   すべて同じ画面に飛ぶ重複になる。 その場合は汎用「編集」を隠す。
  //   ダッシュボード(StoreDashboard)は onEdit がフル編集なので既定(false)のまま表示。
  hideEditItem?: boolean;
}

// ─── コンポーネント ───────────────────────────────────────────────────────────
// ★ 設計メモ:
//   旧 UI は「編集 / 公開トグル / 削除」 を縦に並べていたため、 件数が増えると視覚的にうるさく、
//   タップ事故も起きやすかった。 メイン操作 (公開トグル + 在庫 +/-) を残し、 サブ操作
//   (編集 / 非公開切替の代替テキスト導線 / 削除) は ⋯ メニュー (DropdownMenu) に集約。
export function BagManageCard({
  bag, togglingId, deletingId, adjustingId, confirmId,
  onToggle, onDelete, onStockAdjust, onConfirmChange, onEdit,
  hideEditItem = false,
}: Props) {
  const now       = new Date();
  const status    = getBagStatus(bag, now);
  const badge     = STATUS_BADGE[status];
  const isExpired = status === 'expired';
  const typeInfo  = getItemTypeLabel(bag.itemType);

  // ★ バグ修正: 「公開する」 を押しても受取時間が既に過ぎているバッグは
  //   即座に 'expired' 扱いとなり「受付終了」 になってしまうため、
  //   非公開バッグでも仮に isActive=true にしたら expired になるかを事前判定。
  //   その場合は「公開する」 ではなく「編集して公開」 ボタンに切替えて
  //   先に受取時間を更新してもらう導線にする。
  const wouldExpireIfActivated = !bag.isActive
    && getBagStatus({ ...bag, isActive: true }, now) === 'expired';
  const remaining = bag.stockCount - (bag.reservedCount ?? 0);
  const discountPct = bag.originalPrice > 0
    ? Math.round((1 - bag.discountedPrice / bag.originalPrice) * 100)
    : 0;

  const isToggling  = togglingId  === bag.id;
  const isDeleting  = deletingId  === bag.id;
  const isAdjusting = adjustingId === bag.id;
  const showDeleteConfirm = confirmId === bag.id;

  return (
    <div
      className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-opacity ${
        status === 'active' ? 'border-orange-100' : 'border-border opacity-70'
      }`}
    >
      <div className="px-4 pt-4 pb-3">
        {/* ── 上段：情報 + メイン操作（トグル）+ ⋯ メニュー ── */}
        <div className="flex items-start justify-between gap-3">
          {/* 左：テキスト情報 */}
          <div className="flex-1 min-w-0">
            {/* ステータスバッジ */}
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${badge.cls}`}>
                {badge.text}
              </span>
              <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${typeInfo.cls}`}>
                {typeInfo.emoji} {typeInfo.label}
              </span>
              {discountPct > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600">
                  {discountPct}%OFF
                </span>
              )}
            </div>
            {/* タイトル */}
            <p className="font-black text-foreground leading-snug">{bag.title}</p>
            {/* 価格 */}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs line-through text-muted-foreground">
                ¥{bag.originalPrice.toLocaleString()}
              </span>
              <span className="text-base font-black text-primary">
                ¥{bag.discountedPrice.toLocaleString()}
              </span>
            </div>
            {/* ★ お客様が実際に支払う金額 (システム利用料5%込み)。 店の販売価格と客の支払額の食い違いを解消。 */}
            {bag.discountedPrice > 0 && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                お客様お支払い <span className="font-bold text-foreground/80">¥{buyerTotalJpy(bag.discountedPrice).toLocaleString()}</span>
                <span className="text-muted-foreground/60">（利用料5%込み）</span>
              </p>
            )}
            {/* 受取時間 */}
            {(bag.pickupStart || bag.pickupEnd) && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <Clock className="w-3 h-3" />
                {bag.pickupStart}〜{bag.pickupEnd}
              </p>
            )}
            {/* 出品日時 (オーナー識別補助) */}
            {bag.createdAt && (
              <p className="text-[11px] text-muted-foreground/80 flex items-center gap-1 mt-0.5 tabular-nums">
                <CalendarClock className="w-3 h-3" />
                {formatPostedAt(bag.createdAt)} 出品
              </p>
            )}
          </div>

          {/* 右：メイン操作（公開トグル）+ ⋯ メニュー */}
          <div className="shrink-0 flex flex-col items-center gap-2">
            {/* 公開/非公開トグル（メイン操作） */}
            {/* ★ 受取時間が過ぎている非公開バッグはトグルでなく編集導線へ寄せる */}
            <button
              type="button"
              onClick={() => {
                if (wouldExpireIfActivated) onEdit(bag);
                else onToggle(bag);
              }}
              disabled={isToggling || isDeleting || isExpired}
              title={
                isExpired
                  ? '受付時間が終了しているため変更できません'
                  : wouldExpireIfActivated
                    ? '受取時間が過ぎています。 編集して公開してください。'
                    : undefined
              }
              className="flex flex-col items-center gap-0.5 text-muted-foreground hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isToggling
                ? <Loader2 className="w-7 h-7 animate-spin" />
                : wouldExpireIfActivated
                  ? <Pencil className="w-7 h-7 text-orange-500" />
                  : bag.isActive
                    ? <ToggleRight className={`w-8 h-8 ${isExpired ? 'text-slate-300' : 'text-primary'}`} />
                    : <ToggleLeft className="w-8 h-8 text-muted-foreground" />
              }
              <span className={`text-[9px] font-black tracking-tight ${wouldExpireIfActivated ? 'text-orange-600' : ''}`}>
                {wouldExpireIfActivated ? '時間編集' : badge.text}
              </span>
            </button>

            {/* ⋯ メニュー（編集 / 公開切替（モバイル代替） / 削除） */}
            {/* ★ modal={false} 必須: Radix デフォルトの modal=true は body に pointer-events:none を
                  かけてスクロールをロックする。 iOS WebView では稀に閉じた時に解除漏れが発生し、
                  「画面が下スクロール途中で固まる」 バグの原因になる。 小さなコンテキストメニュー
                  なのでフォーカストラップ不要 → modal=false で完全回避。 */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="w-8 h-8 rounded-xl bg-secondary hover:bg-primary/10 hover:text-primary flex items-center justify-center text-muted-foreground transition-colors"
                  title="その他の操作"
                  aria-label="その他の操作"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {/* ★ 受付終了 / 完売の過去バッグは「編集」「公開切替」 を非表示
                      理由: 既に終わった出品の受取時間を変えても意味がなく、
                      公開トグルも実質無効。 削除だけ残してメニューをシンプル化。 */}
                {!isExpired && status !== 'soldout' && (
                  <>
                    {/* ★ hideEditItem=true (過去履歴画面) では汎用「編集」を出さない。
                          そこでの onEdit は時間編集専用で、下の「受取時間を編集して公開」
                          および右側「時間編集」ボタンと完全重複するため。 */}
                    {!hideEditItem && (
                      <DropdownMenuItem
                        onSelect={(e) => { e.preventDefault(); onEdit(bag); }}
                        className="text-sm font-bold cursor-pointer"
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        編集
                      </DropdownMenuItem>
                    )}

                    {/* ★ 公開/非公開 切替 (受取時間を過ぎている非公開バッグは編集導線に切替) */}
                    {wouldExpireIfActivated ? (
                      <DropdownMenuItem
                        onSelect={(e) => { e.preventDefault(); onEdit(bag); }}
                        className="text-sm font-bold cursor-pointer text-orange-600 focus:text-orange-700 focus:bg-orange-50"
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        受取時間を編集して公開
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={(e) => { e.preventDefault(); onToggle(bag); }}
                        disabled={isToggling || isDeleting}
                        className="text-sm font-bold cursor-pointer"
                      >
                        {bag.isActive
                          ? <ToggleLeft className="w-4 h-4 mr-2" />
                          : <ToggleRight className="w-4 h-4 mr-2" />}
                        {bag.isActive ? '非公開にする' : '公開する'}
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />
                  </>
                )}

                {/* ★ 削除は受付終了/完売 でも表示 (過去出品を整理するため) */}
                <DropdownMenuItem
                  onSelect={(e) => { e.preventDefault(); onConfirmChange(bag.id); }}
                  className="text-sm font-bold cursor-pointer text-red-600 focus:text-red-700 focus:bg-red-50"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  削除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ── 削除確認バー（⋯ メニューから「削除」 を選ぶと表示） ── */}
        {/* ★ 公開中バッグも削除可能に統一。 公開中の場合は内部で「非公開→削除」 を連続実行する旨を明示。 */}
        {showDeleteConfirm && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
            <span className="text-xs font-bold text-red-700">
              {bag.isActive ? '公開中ですが、非公開にして削除しますか？' : '本当に削除しますか？'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onConfirmChange(null)}
                className="text-[11px] font-bold text-muted-foreground underline"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => onDelete(bag)}
                disabled={isDeleting}
                className="text-[11px] font-black text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg active:scale-95 transition-transform disabled:opacity-50 inline-flex items-center gap-1"
              >
                {isDeleting
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <><Trash2 className="w-3 h-3" />削除する</>}
              </button>
            </div>
          </div>
        )}

        {/* ── 下段：在庫インライン調整バー ── */}
        {/* 「残りわずか」判定: remaining ≤ 2 かつ 公開中 → 全画面共通ロジック */}
        {(() => {
          const isLowStock = status === 'active' && remaining > 0 && remaining <= 2;
          return (
        <div className={`mt-3 flex items-center gap-2 rounded-xl px-3 py-2 ${
          isLowStock ? 'bg-red-50 border border-red-100' : 'bg-secondary/40'
        }`}>
          <Package2 className={`w-3.5 h-3.5 shrink-0 ${isLowStock ? 'text-red-500' : 'text-muted-foreground'}`} />
          <span className={`text-xs font-bold ${isLowStock ? 'text-red-600' : 'text-muted-foreground'}`}>残り在庫</span>
          <span className={`text-xs font-black ml-0.5 ${isLowStock ? 'text-red-700' : 'text-foreground'}`}>
            {remaining}
            <span className={`font-medium ${isLowStock ? 'text-red-500' : 'text-muted-foreground'}`}>個</span>
          </span>
          {isLowStock && (
            <span className="text-[10px] font-black text-red-600 bg-red-100 px-1.5 py-0.5 rounded-full">
              残りわずか！
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {/* − */}
            <button
              type="button"
              onClick={() => onStockAdjust(bag, -1)}
              disabled={isAdjusting || bag.stockCount <= 0}
              className="w-7 h-7 rounded-lg bg-white border border-border flex items-center justify-center text-foreground hover:bg-muted active:scale-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
            >
              {isAdjusting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Minus className="w-3.5 h-3.5" strokeWidth={2.5} />}
            </button>

            {/* 在庫数表示 */}
            <span className="w-8 text-center text-sm font-black text-foreground tabular-nums">
              {bag.stockCount}
            </span>

            {/* ＋ */}
            <button
              type="button"
              onClick={() => onStockAdjust(bag, 1)}
              disabled={isAdjusting}
              className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-white hover:bg-primary/90 active:scale-90 transition-all disabled:opacity-30 shadow-sm"
            >
              {isAdjusting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />}
            </button>
          </div>
        </div>
          );
        })()}
      </div>
    </div>
  );
}
