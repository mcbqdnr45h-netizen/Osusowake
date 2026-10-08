import React, { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListAllBagsQueryKey } from '@workspace/api-client-react';
import { authedFetch } from '@/lib/authed-fetch';
import { useToast } from '@/hooks/use-toast';
import { TimePicker } from '@/components/TimePicker';
import { ImageUpload } from '@/components/ImageUpload';
import { CategoryPicker } from '@/components/CategoryPicker';
import { Repeat, Plus, Trash2, Moon, Power, EyeOff, Pencil, Eye, Zap } from 'lucide-react';
import { BagPreviewSheet } from '@/components/BagPreviewSheet';
import { pickupWindowsLabel } from '@/lib/utils';

const BASE = ((import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE) || '';

// 通常出品と同一の収益モデル: お客様にはシステム利用料5%を加算し10円単位で切り上げ。
const BUYER_SERVICE_FEE_RATE = 0.05;
function buyerTotalJpy(merchandiseJpy: number): number {
  if (!Number.isFinite(merchandiseJpy) || merchandiseJpy <= 0) return 0;
  return Math.ceil((merchandiseJpy * (1 + BUYER_SERVICE_FEE_RATE)) / 10) * 10;
}

interface Listing {
  id: number;
  title: string;
  description: string | null;
  originalPrice: number;
  discountedPrice: number;
  stockCount: number;
  pickupStart: string | null;
  pickupEnd: string | null;
  pickupStart2: string | null;  // 2部制(受取2枠)の2枠目
  pickupEnd2: string | null;
  imageUrl: string | null;
  category: string | null;
  itemType: string | null;
  allergyInfo: string | null;
  pickupNote: string | null;
  publishTime: string;
  daysOfWeek: number;
  pickupNextDay: boolean;
  isActive: boolean;
  carryOverStock: boolean;   // 在庫持ち越しモード（毎日リセットしない・手動更新）
  skipDate: string | null;
  skipDates: string | null;   // 休みカレンダー: "YYYY-MM-DD" カンマ区切り
  lastPublishedDate: string | null;
  todayStock: number | null; // 今日公開したバッグの在庫合計（未公開なら null）。 0=本日完売
  nextPublishDate: string;   // 次に自動公開される JST 日付（「休む」対象の公開日）
  nextPickupDate: string;    // その回の受取日（前日出品なら公開日+1）
  hasLiveBag: boolean;       // いま客に表示中(is_active かつ notExpired)のバッグがあるか
  liveStock: number;         // いま表示中バッグの残り在庫合計
  carryOverSoldOut: boolean; // 持ち越しモードで完売して止まっている（在庫を入れ直すまで再開しない）
  liveReservedQty: number;   // 公開中バッグの有効予約(未受取・未キャンセル)の合計個数
  livePaidQty: number;       // うち決済済み(paid)の個数（取り下げ時の返金注意用）
}

const DOW: { bit: number; label: string }[] = [
  { bit: 1 << 0, label: '日' },
  { bit: 1 << 1, label: '月' },
  { bit: 1 << 2, label: '火' },
  { bit: 1 << 3, label: '水' },
  { bit: 1 << 4, label: '木' },
  { bit: 1 << 5, label: '金' },
  { bit: 1 << 6, label: '土' },
];

function daysLabel(mask: number): string {
  if (mask === 127) return '毎日';
  const on = DOW.filter((d) => (mask & d.bit) !== 0).map((d) => d.label);
  return on.length ? `${on.join('・')}曜` : '曜日未設定';
}

/** JST の YYYY-MM-DD（「今夜だけ停止」中かの判定用） */
function jstToday(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return p; // en-CA = YYYY-MM-DD
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
/** "YYYY-MM-DD" → "M/D(曜)"。 不正値は空文字。 */
function fmtMD(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

/** 休みカレンダー: 当月＋翌月を表示し、 日付タップで「休み」をトグルする（過去日は不可）。 */
function SkipCalendar({ value, onChange }: { value: string[]; onChange: (dates: string[]) => void }) {
  const today = jstToday();
  const [by, bm] = today.split('-').map(Number);
  const sel = new Set(value);
  const toggle = (d: string) => {
    const next = new Set(sel);
    if (next.has(d)) next.delete(d); else next.add(d);
    onChange(Array.from(next).sort());
  };
  const months = [0, 1].map((off) => {
    const base = new Date(Date.UTC(by, bm - 1 + off, 1));
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + 1; // 1-12
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { year, month, firstDow, daysIn };
  });
  return (
    <div className="space-y-3">
      {months.map(({ year, month, firstDow, daysIn }) => (
        <div key={`${year}-${month}`} className="rounded-xl border border-border p-2.5">
          <p className="text-[12px] font-black text-foreground mb-1.5">{year}年{month}月</p>
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY.map((w) => (
              <div key={w} className="text-center text-[10px] font-bold text-muted-foreground py-0.5">{w}</div>
            ))}
            {Array.from({ length: firstDow }).map((_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: daysIn }).map((_, i) => {
              const day = i + 1;
              const ds = `${year}-${pad2(month)}-${pad2(day)}`;
              const isPast = ds < today;
              const isSel = sel.has(ds);
              return (
                <button
                  key={ds}
                  type="button"
                  disabled={isPast}
                  onClick={() => toggle(ds)}
                  className={`h-9 rounded-lg text-[13px] font-bold transition-colors ${
                    isPast
                      ? 'text-muted-foreground/30'
                      : isSel
                        ? 'bg-amber-500 text-white'
                        : 'bg-secondary/40 text-foreground'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">タップで「休み」に設定（オレンジ＝休み）。その日は自動出品されません。曜日設定はそのまま、特定の日だけ休めます。</p>
    </div>
  );
}

export function RecurringListingsSection({ storeId, storeName = '' }: { storeId: number; storeName?: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // 停止/削除でバッグが連動停止した時、 「出品中の商品」 と地図を即再取得して表示ラグをなくす。
  const invalidateBags = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [`/api/stores/${storeId}/bags`] });
    queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
    queryClient.invalidateQueries({ queryKey: getListAllBagsQueryKey() });
  }, [queryClient, storeId]);
  const [enabled, setEnabled] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null); // 編集中の定期出品ID（null=新規）
  const [publishingId, setPublishingId] = useState<number | null>(null); // 「今すぐ公開」送信中のID（連打防止）

  // ── フォーム ──
  const [title, setTitle] = useState('');
  const [originalPrice, setOriginalPrice] = useState('');
  const [discountedPrice, setDiscountedPrice] = useState('');
  const [stockCount, setStockCount] = useState('3');
  const [pickupStart, setPickupStart] = useState('07:00');
  const [pickupEnd, setPickupEnd] = useState('09:00');
  const [twoShift, setTwoShift] = useState(false);   // 2部制(受取2枠)
  const [pickupStart2, setPickupStart2] = useState('17:00');
  const [pickupEnd2, setPickupEnd2] = useState('19:00');
  const [publishTime, setPublishTime] = useState('21:00');
  const [days, setDays] = useState(127);
  const [pickupNextDay, setPickupNextDay] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState<'bag' | 'item'>('bag');
  const [description, setDescription] = useState('');
  const [allergyInfo, setAllergyInfo] = useState('');
  const [pickupNote, setPickupNote] = useState('');
  const [skipDates, setSkipDates] = useState<string[]>([]); // 休みカレンダーで選んだ日付
  const [carryOverStock, setCarryOverStock] = useState(false); // 在庫持ち越しモード
  const [showPreview, setShowPreview] = useState(false); // お客様画面プレビュー

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/recurring`);
      if (res.ok) {
        const data = await res.json();
        setEnabled(!!data.enabled);
        setListings(Array.isArray(data.listings) ? data.listings : []);
      } else {
        setEnabled(false);
      }
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => { load(); }, [load]);

  // パイロット対象外 / 読み込み中は何も表示しない
  if (loading || !enabled) return null;

  // フォームを初期状態に戻す（新規/編集どちらの後始末にも使う）
  function resetForm() {
    setEditingId(null);
    setTitle(''); setOriginalPrice(''); setDiscountedPrice(''); setStockCount('3');
    setPickupStart('07:00'); setPickupEnd('09:00'); setPublishTime('21:00');
    setTwoShift(false); setPickupStart2('17:00'); setPickupEnd2('19:00');
    setDays(127); setPickupNextDay(false);
    setImageUrl(null); setCategory(''); setItemType('bag');
    setDescription(''); setAllergyInfo(''); setPickupNote('');
    setSkipDates([]);
    setCarryOverStock(false);
  }

  // 「追加」= 新規フォームを開く（前回値をクリア）
  function openNewForm() {
    resetForm();
    setShowForm(true);
  }

  // 「編集」= 既存テンプレの値をフォームに流し込んで開く
  function startEdit(l: Listing) {
    setEditingId(l.id);
    setTitle(l.title ?? '');
    setOriginalPrice(l.originalPrice ? String(l.originalPrice) : '');
    setDiscountedPrice(l.discountedPrice ? String(l.discountedPrice) : '');
    setStockCount(String(l.stockCount ?? 1));
    setPickupStart(l.pickupStart ?? '07:00');
    setPickupEnd(l.pickupEnd ?? '09:00');
    setTwoShift(!!(l.pickupStart2 && l.pickupEnd2));
    setPickupStart2(l.pickupStart2 ?? '17:00');
    setPickupEnd2(l.pickupEnd2 ?? '19:00');
    setPublishTime(l.publishTime ?? '21:00');
    setDays(l.daysOfWeek ?? 127);
    setPickupNextDay(!!l.pickupNextDay);
    setImageUrl(l.imageUrl ?? null);
    setCategory(l.category ?? '');
    setItemType((l.itemType === 'item' ? 'item' : 'bag'));
    setDescription(l.description ?? '');
    setAllergyInfo(l.allergyInfo ?? '');
    setPickupNote(l.pickupNote ?? '');
    setSkipDates(l.skipDates ? l.skipDates.split(',').map((s) => s.trim()).filter(Boolean) : []);
    setCarryOverStock(!!l.carryOverStock);
    setShowForm(true);
  }

  // 新規=POST / 編集=PATCH を分岐して保存
  async function save() {
    if (itemType === 'item' && !title.trim()) { toast({ title: '商品名を入力してください（単品商品は必須）', variant: 'destructive' }); return; }
    if (!imageUrl) { toast({ title: '写真を追加してください', variant: 'destructive' }); return; }
    if (!category) { toast({ title: 'カテゴリを選択してください', variant: 'destructive' }); return; }
    if (Number(discountedPrice) < 50) { toast({ title: '価格は50円以上に設定してください', variant: 'destructive' }); return; }
    if (Number(stockCount) < 1) { toast({ title: '在庫数は1以上に設定してください', variant: 'destructive' }); return; }
    if (days === 0) { toast({ title: '公開する曜日を1つ以上選んでください', variant: 'destructive' }); return; }
    setSaving(true);
    const body = {
      title: title.trim() || 'おすそわけ袋',
      description: description.trim() || undefined,
      originalPrice: Number(originalPrice) || Number(discountedPrice),
      discountedPrice: Number(discountedPrice),
      stockCount: Number(stockCount) || 1,
      pickupStart, pickupEnd, publishTime, daysOfWeek: days, pickupNextDay,
      // 2部制(受取2枠): トグルONの時だけ送る。OFFなら null でクリア。
      pickupStart2: twoShift ? pickupStart2 : null,
      pickupEnd2: twoShift ? pickupEnd2 : null,
      imageUrl,
      category,
      itemType,
      allergyInfo: allergyInfo.trim() || undefined,
      pickupNote: pickupNote.trim() || undefined,
      skipDates,
      carryOverStock,
    };
    try {
      const res = editingId
        ? await authedFetch(`${BASE}/api/recurring/${editingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await authedFetch(`${BASE}/api/stores/${storeId}/recurring`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || (editingId ? '更新に失敗しました' : '登録に失敗しました'));
      }
      toast({
        title: editingId ? '定期出品を更新しました' : '定期出品を登録しました',
        description: `${daysLabel(days)} ${publishTime} に自動公開します`,
      });
      setShowForm(false);
      resetForm();
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || (editingId ? '更新に失敗しました' : '登録に失敗しました'), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function patchListing(id: number, body: Record<string, unknown>, okMsg?: string) {
    try {
      const res = await authedFetch(`${BASE}/api/recurring/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('更新に失敗しました');
      if (okMsg) toast({ title: okMsg });
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || '更新に失敗しました', variant: 'destructive' });
    }
  }

  async function skipTonight(l: Listing) {
    try {
      const res = await authedFetch(`${BASE}/api/recurring/${l.id}/skip-tonight`, { method: 'POST' });
      if (!res.ok) throw new Error('停止に失敗しました');
      const label = l.nextPickupDate === jstToday() ? '今日' : fmtMD(l.nextPickupDate);
      toast({ title: `${label}の受取分を1回休みます`, description: 'その次からはまた自動で公開されます' });
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || '停止に失敗しました', variant: 'destructive' });
    }
  }

  // いま公開中の分だけ取り下げる（定期出品は継続）。 公開後に「今日は余らなかった」と分かった時用。
  //   予約済みの客がいる場合は「取り下げても予約は有効＝渡すか返金が必要」と必ず警告してから実行。
  async function withdrawNow(l: Listing) {
    let msg = 'いま公開中の分を取り下げますか？（定期出品はこのまま続きます）';
    if (l.liveReservedQty > 0) {
      const paidNote = l.livePaidQty > 0 ? `（うち決済済み ${l.livePaidQty}個）` : '';
      msg =
        `⚠️ このバッグは既に ${l.liveReservedQty}個 予約済みです${paidNote}。\n\n` +
        '取り下げても、この予約は有効なまま残ります（自動キャンセル・自動返金はしません）。\n' +
        'お渡しできない場合は、お客様への返金対応が必要です。\n\n' +
        'それでも取り下げますか？';
    }
    if (!window.confirm(msg)) return;
    try {
      const res = await authedFetch(`${BASE}/api/recurring/${l.id}/withdraw-now`, { method: 'POST' });
      if (!res.ok) throw new Error('取り下げに失敗しました');
      toast({ title: 'いま公開中の分を取り下げました', description: '定期出品は継続します（次回からまた自動公開）' });
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || '取り下げに失敗しました', variant: 'destructive' });
    }
  }

  // 次回の公開時刻を待たずに、今すぐお客様に出す。
  //   ★ 完売後に在庫を入れ直しても、客に見えるのは「今日つくられた分」だけなので、
  //     在庫を足すだけでは並ばない（あんぱん店の指摘）。これを押すと今日の分として作り直す。
  async function publishNow(l: Listing) {
    if (publishingId !== null) return;   // 連打で2回送るのを防ぐ
    const when = l.pickupNextDay ? '明日' : '今日';
    if (!window.confirm(`在庫${l.stockCount}個を今すぐお客様に公開しますか？（受け取りは${when}）`)) return;
    setPublishingId(l.id);
    try {
      const res = await authedFetch(`${BASE}/api/recurring/${l.id}/publish-now`, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as { message?: string; mode?: string; stock?: number };
      if (!res.ok) throw new Error(data.message || '公開に失敗しました');
      // 在庫数はサーバーが実際に出した値を使う（別端末で変更されていた場合に嘘を表示しないため）
      const shown = data.stock ?? l.stockCount;
      toast({
        title: '今すぐ公開しました',
        description: data.mode === 'restock'
          ? `すでに公開中の分の在庫を${shown}個に更新しました`
          : `お客様の画面に並びました（在庫${shown}個）`,
      });
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || '公開に失敗しました', variant: 'destructive' });
    } finally {
      setPublishingId(null);
    }
  }

  async function remove(id: number) {
    if (!window.confirm('この定期出品を削除しますか？（自動公開が止まります）')) return;
    try {
      const res = await authedFetch(`${BASE}/api/recurring/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('削除に失敗しました');
      toast({ title: '定期出品を削除しました' });
      await load();
      invalidateBags();
    } catch (e) {
      toast({ title: (e as Error).message || '削除に失敗しました', variant: 'destructive' });
    }
  }

  const today = jstToday();
  // 在庫モード説明の例文で使う数（入力中の在庫数。 未入力/不正なら 5 を仮置き）。
  const exN = (() => { const n = Number(stockCount); return Number.isInteger(n) && n >= 1 ? n : 5; })();

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-primary" />
          <h2 className="text-base font-black text-foreground">定期出品（毎日自動公開）</h2>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={openNewForm}
            className="flex items-center gap-1 text-primary font-black text-sm"
          >
            <Plus className="w-4 h-4" />追加
          </button>
        )}
      </div>
      <div className="mb-4 rounded-xl bg-secondary/40 px-3.5 py-3 leading-relaxed">
        <p className="text-[12px] text-foreground font-bold mb-1">一度登録すれば、毎日自動で出品されます（投稿の手間ゼロ）。</p>
        <p className="text-[11px] text-muted-foreground">
          <span className="font-bold text-foreground">例）</span> 夜<span className="font-bold text-foreground">21:00</span>に自動で出品 → お客さんが翌朝<span className="font-bold text-foreground">7:00〜9:00</span>に受け取り。<br />
          余らない日はその回だけ休めます。<span className="font-bold text-foreground">前日の夜に出品する設定</span>は、出品時刻より前（受取日の前夜まで）に「休む」を押してください。<br />
          すでに公開済みの分は<span className="font-bold text-foreground">「今の分を取り下げる」</span>で引っ込められます（定期出品は続きます）。
        </p>
      </div>

      {/* 登録 / 編集フォーム */}
      {showForm && (
        <div className="rounded-2xl border border-border bg-white p-4 mb-4 space-y-3">
          <p className="text-sm font-black text-foreground">{editingId ? '定期出品を編集' : '定期出品を追加'}</p>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">写真 <span className="text-destructive normal-case">＊必須</span></label>
            <div className="mt-1">
              <ImageUpload value={imageUrl} onChange={setImageUrl} required />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">種別</label>
            <div className="flex gap-2 mt-1">
              {([['bag', 'サプライズバッグ'], ['item', '単品商品']] as const).map(([v, lbl]) => (
                <button key={v} type="button" onClick={() => setItemType(v)}
                  className={`flex-1 py-2 rounded-xl text-sm font-bold transition-colors ${
                    itemType === v ? 'bg-primary text-white' : 'bg-secondary/50 text-muted-foreground'
                  }`}>{lbl}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">
              商品名 {itemType === 'item'
                ? <span className="text-destructive normal-case">＊必須</span>
                : <span className="text-muted-foreground normal-case font-medium">（任意）</span>}
            </label>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={itemType === 'bag' ? '空欄なら「おすそわけ袋」' : '例: チーズバーガー'}
              className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
          </div>
          <div>
            <CategoryPicker value={category} onChange={setCategory} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">通常価格(任意)</label>
              <input value={originalPrice} onChange={(e) => setOriginalPrice(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric" placeholder="1000"
                className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
            </div>
            <div>
              <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">販売価格 <span className="text-destructive normal-case">＊必須</span></label>
              <input value={discountedPrice} onChange={(e) => setDiscountedPrice(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric" placeholder="500"
                className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
            </div>
          </div>
          {Number(discountedPrice) > 0 && (
            <div className="rounded-xl bg-blue-50 border border-blue-200 px-3 py-2.5 flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-blue-900 leading-tight">
                お客様への表示価格
                <span className="block text-[10px] font-medium text-blue-700/80 mt-0.5">システム利用料 5% 加算（10円単位）</span>
              </div>
              <div className="text-base font-black text-blue-700 whitespace-nowrap">¥{buyerTotalJpy(Number(discountedPrice)).toLocaleString()}</div>
            </div>
          )}
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">{carryOverStock ? '在庫数（最初に出す数・以降は売れ残りを引き継ぎ）' : '在庫数（毎日この数で出品）'}</label>
            <input value={stockCount} onChange={(e) => setStockCount(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric" placeholder="3"
              className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
          </div>
          {/* 在庫モード切替 */}
          <div className="rounded-xl border border-border p-3">
            <button type="button" onClick={() => setCarryOverStock(v => !v)} className="w-full flex items-center justify-between gap-3">
              <span className="text-left">
                <span className="block text-[13px] font-black text-foreground">在庫を持ち越す（毎日リセットしない）</span>
                <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">
                  パン屋さんなど、日によって数が変わる店向け。 オフ＝毎日同じ数で自動出品（安定店向け）。
                </span>
              </span>
              <span className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${carryOverStock ? 'bg-primary' : 'bg-secondary'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${carryOverStock ? 'left-[22px]' : 'left-0.5'}`} />
              </span>
            </button>
            {/* ★ 説明は常に表示（トグルをONにしなくても両モードの違いが分かるように）。 */}
            <p className={`text-[11px] rounded-lg px-2.5 py-1.5 mt-2 leading-snug border ${carryOverStock ? 'text-amber-800 bg-amber-50 border-amber-200/70' : 'text-sky-900 bg-sky-50 border-sky-200/70'}`}>
              {carryOverStock ? (
                <>
                  💡 <span className="font-bold">オン中（持ち越し）</span>：毎日 自動で再出品しますが、 在庫は<span className="font-bold">前日の売れ残りを引き継ぎます</span>（毎日リセットしません）。<br />
                  {exN >= 2 ? (
                    <>例）{exN}個で開始 → 1個売れたら翌日は{exN - 1}個…と減り、 <span className="font-bold">合計{exN}個を超えて売れません</span>（過剰販売を防止）。</>
                  ) : (
                    <>例）{exN}個で開始 → 売れたら「完売」表示。 <span className="font-bold">合計{exN}個を超えて売れません</span>（過剰販売を防止）。</>
                  )} 完売したら止まり、 <span className="font-bold">編集（鉛筆）から在庫を入れ直すと再開</span>します。 ※日によって数が変わる店・日持ち品向け。
                </>
              ) : (
                <>
                  💡 <span className="font-bold">オフ中（通常）</span>：毎日 <span className="font-bold">同じ数で自動出品</span>します（毎日リセット）。<br />
                  例）{exN}個に設定 → 毎日{exN}個ずつ出品。 数が安定している店向け。 <span className="font-bold">オンにすると「売れ残りを翌日に引き継ぐ」</span>モードに切り替わります。
                </>
              )}
            </p>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">受取時間</label>
            <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">お客さんが商品を取りに来られる時間帯（例: 翌朝 7:00〜9:00）</p>
            <div className="grid grid-cols-2 gap-3">
              <TimePicker value={pickupStart} onChange={setPickupStart} label={twoShift ? '1部 開始' : '受取 開始'} />
              <TimePicker value={pickupEnd} onChange={setPickupEnd} label={twoShift ? '1部 終了' : '受取 終了'} />
            </div>
            {/* 2部制(受取2枠): 休憩・不在の時間帯を空けて、 受取時間を2つに分ける */}
            <div className="rounded-xl border border-border p-3 mt-3">
              <button type="button" onClick={() => setTwoShift(v => !v)} className="w-full flex items-center justify-between gap-3">
                <span className="text-left">
                  <span className="block text-[13px] font-black text-foreground">2部制にする（途中に休憩をはさむ）</span>
                  <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">
                    買い出し・配達・銀行などで不在の時間帯を空けて、 受取を2枠に分けられます。
                  </span>
                </span>
                <span className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${twoShift ? 'bg-primary' : 'bg-secondary'}`}>
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${twoShift ? 'left-[22px]' : 'left-0.5'}`} />
                </span>
              </button>
              {twoShift && (
                <div className="mt-3">
                  <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">2部（休憩明け）の受取時間。 例: 1部 11:00〜14:00 / 2部 17:00〜19:00</p>
                  <div className="grid grid-cols-2 gap-3">
                    <TimePicker value={pickupStart2} onChange={setPickupStart2} label="2部 開始" />
                    <TimePicker value={pickupEnd2} onChange={setPickupEnd2} label="2部 終了" />
                  </div>
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">出品するタイミング</label>
            <div className="flex gap-2 mt-1">
              {([[false, '当日に出品', '同日に受け取り'], [true, '前日の夜に出品', '翌日に受け取り']] as const).map(([v, t, sub]) => (
                <button key={String(v)} type="button"
                  onClick={() => { setPickupNextDay(v); if (v) setPublishTime((p) => (p < '15:00' ? '18:00' : p)); }}
                  className={`flex-1 py-2.5 rounded-xl text-[13px] font-bold leading-tight transition-colors ${
                    pickupNextDay === v ? 'bg-primary text-white' : 'bg-secondary/50 text-muted-foreground'
                  }`}>
                  {t}<br /><span className="text-[10px] font-medium opacity-80">{sub}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">公開する時刻</label>
            <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">
              {pickupNextDay
                ? '受け取り日の【前日】この時刻に自動出品されます（例: 21:00 → 翌朝に受け取り）'
                : '受け取り日の【当日】この時刻に自動出品されます（例: 17:00 → 同日夕方に受け取り）'}
            </p>
            <TimePicker value={publishTime} onChange={setPublishTime} label="この時刻に自動公開" />
            {pickupNextDay && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200/70 rounded-lg px-2.5 py-1.5 mt-2 leading-snug">
                💡 翌日受け取りは <span className="font-bold">前日の夜（18〜21時頃）</span> に出すのが一般的です。 朝に出すと丸1日表示され続けます。
              </p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">受け取る曜日（営業日）</label>
            <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">お客さんが受け取りに来る曜日を選択。 定休日は外してください（出品タイミングは自動で調整されます）</p>
            <div className="flex gap-1.5 mt-1.5">
              {DOW.map((d) => {
                const on = (days & d.bit) !== 0;
                return (
                  <button key={d.bit} type="button"
                    onClick={() => setDays((m) => m ^ d.bit)}
                    className={`w-9 h-9 rounded-full text-sm font-black transition-colors ${
                      on ? 'bg-primary text-white' : 'bg-secondary/50 text-muted-foreground'
                    }`}>
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">休みの日（不定休・特定日）</label>
            <p className="text-[11px] text-muted-foreground mb-1.5 leading-snug">曜日設定に加えて、 カレンダーで「この日は休み」を指定できます（その日は自動出品されません）。</p>
            <SkipCalendar value={skipDates} onChange={setSkipDates} />
          </div>
          <div className="rounded-xl bg-primary/5 border border-primary/20 px-3.5 py-3">
            <p className="text-[11px] font-black text-primary mb-1">📋 設定の確認</p>
            <p className="text-[12px] text-foreground leading-relaxed">
              <span className="font-bold">{daysLabel(days)}</span>に受け取り。
              {pickupNextDay ? '前日' : '当日'}の<span className="font-bold">{publishTime}</span>に自動出品 → 受け取りは<span className="font-bold">{pickupWindowsLabel(pickupStart, pickupEnd, twoShift ? pickupStart2 : null, twoShift ? pickupEnd2 : null)}</span>。
            </p>
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">商品説明（任意）</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              placeholder="例: 当日焼いたパンの詰め合わせです"
              className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1 resize-none" />
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">アレルギー情報（任意）</label>
            <input value={allergyInfo} onChange={(e) => setAllergyInfo(e.target.value)} placeholder="例: 小麦・卵・乳"
              className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
          </div>
          <div>
            <label className="text-[11px] font-black text-foreground/65 uppercase tracking-wider">受取時の注意（任意）</label>
            <input value={pickupNote} onChange={(e) => setPickupNote(e.target.value)} placeholder="例: レジで「おすそわけ」とお伝えください"
              className="w-full bg-white border border-border rounded-xl px-3 py-2.5 text-[15px] mt-1" />
          </div>
          {/* お客様画面プレビュー: 写真の見切り・文字の折り返しを登録前に確認 */}
          <button type="button" onClick={() => setShowPreview(true)}
            className="w-full py-2.5 rounded-xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5">
            <Eye className="w-4 h-4" />お客様の画面でプレビュー
          </button>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => { setShowForm(false); resetForm(); }}
              className="flex-1 py-3 rounded-xl border border-border font-bold text-sm">キャンセル</button>
            <button type="button" onClick={save} disabled={saving}
              className="flex-1 py-3 rounded-xl bg-primary text-white font-black text-sm disabled:opacity-50">
              {saving ? '保存中…' : editingId ? '更新する' : '登録する'}
            </button>
          </div>
          <BagPreviewSheet
            open={showPreview}
            onOpenChange={setShowPreview}
            storeName={storeName}
            data={{
              title, description,
              originalPrice: Number(originalPrice) || Number(discountedPrice),
              discountedPrice: Number(discountedPrice),
              stockCount: Number(stockCount) || 0,
              pickupStart, pickupEnd,
              pickupStart2: twoShift ? pickupStart2 : null,
              pickupEnd2: twoShift ? pickupEnd2 : null,
              imageUrl, category, allergyInfo, pickupNote,
              itemType, pickupNextDay,
            }}
          />
        </div>
      )}

      {/* 一覧 */}
      <div className="space-y-2.5">
        {listings.length === 0 && !showForm && (
          <p className="text-sm text-muted-foreground text-center py-6">まだ定期出品はありません。「追加」から登録してください。</p>
        )}
        {listings.map((l) => {
          // 休みは全てカレンダー(skip_dates=受取日ベース)に集約。 クイック「休む」もここに入る。
          const skipDatesArr = (l.skipDates ? l.skipDates.split(',').map((s) => s.trim()) : [])
            .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
          const upcomingSkips = skipDatesArr.filter((d) => d >= today).sort();
          // 次回の受取日が休みか（バッジ＆クイック「休む」ボタン無効化に使用）
          const nextIsHoliday = skipDatesArr.includes(l.nextPickupDate);
          const nextAlreadySkipped = nextIsHoliday;
          return (
            <div key={l.id} className={`rounded-2xl border p-3.5 ${l.isActive ? 'border-border bg-white' : 'border-border/60 bg-secondary/20'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-3 min-w-0">
                  {l.imageUrl && <img loading="lazy" decoding="async" src={l.imageUrl} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-black text-foreground text-[15px] truncate">{l.title}</p>
                    <p className="text-[12px] text-muted-foreground mt-0.5">
                      {daysLabel(l.daysOfWeek)}に受け取り ・ {l.pickupNextDay ? '前日' : '当日'}<span className="font-bold text-foreground">{l.publishTime}</span>出品 ・ ¥{Number(l.discountedPrice).toLocaleString()} ・ 在庫{l.stockCount}
                    </p>
                    {l.pickupStart && l.pickupEnd && (
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5">受取 {pickupWindowsLabel(l.pickupStart, l.pickupEnd, l.pickupStart2, l.pickupEnd2)}</p>
                    )}
                    {upcomingSkips.length > 0 && (
                      <p className="text-[11px] text-amber-700 mt-0.5">
                        休み予定: {upcomingSkips.slice(0, 3).map((d) => fmtMD(d)).join('・')}{upcomingSkips.length > 3 ? ` 他${upcomingSkips.length - 3}日` : ''}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      {l.carryOverStock && <span className="text-[10px] font-black text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full">在庫持ち越し</span>}
                      {/* 状態は必ず1つだけ。 上から優先（停止 > いま出品中 > 完売 > 休み > 次回公開待ち）。 */}
                      {(() => {
                        const pill = (cls: string, text: string) => (
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${cls}`}>{text}</span>
                        );
                        if (!l.isActive) return pill('text-muted-foreground bg-secondary', '停止中');
                        if (l.hasLiveBag) return pill('text-blue-700 bg-blue-100',
                          `🟢 いま出品中・残り${l.liveStock}個${l.liveReservedQty > 0 ? `（予約${l.liveReservedQty}件）` : ''}`);
                        if (l.carryOverSoldOut) return pill('text-rose-700 bg-rose-100', '完売・在庫を入れ直すと再開');
                        if (nextIsHoliday) return pill('text-amber-700 bg-amber-100', `${fmtMD(l.nextPickupDate)}は休み`);
                        if (l.todayStock === 0) return pill('text-rose-700 bg-rose-100', '本日完売・次回また公開');
                        return pill('text-green-700 bg-green-100',
                          `次回 ${l.nextPublishDate === today ? '今日' : fmtMD(l.nextPublishDate)} ${l.publishTime} に公開`);
                      })()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => startEdit(l)} aria-label="編集"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-primary">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => remove(l.id)} aria-label="削除"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button type="button" onClick={() => patchListing(l.id, { isActive: !l.isActive }, l.isActive ? '停止しました' : '再開しました')}
                  className="flex-1 py-2 rounded-xl border border-border font-bold text-[12px] flex items-center justify-center gap-1">
                  <Power className="w-3.5 h-3.5" />{l.isActive ? '停止する' : '再開する'}
                </button>
                {l.isActive && (
                  <button type="button" onClick={() => skipTonight(l)} disabled={nextAlreadySkipped}
                    className="flex-1 py-2 rounded-xl border border-border font-bold text-[12px] flex items-center justify-center gap-1 disabled:opacity-40">
                    <Moon className="w-3.5 h-3.5" />
                    {nextAlreadySkipped
                      ? '休み予約済み'
                      : l.nextPickupDate === today
                        ? '今日の分を休む'
                        : `${fmtMD(l.nextPickupDate)}分を休む`}
                  </button>
                )}
              </div>
              {/* 次回の公開時刻を待たずに出す。いま出品中の時は出さない（二重に並べる操作を見せない）。 */}
              {l.isActive && !l.hasLiveBag && (
                <button type="button" onClick={() => publishNow(l)} disabled={publishingId !== null}
                  className="w-full mt-2 py-2 rounded-xl border border-primary/30 text-primary bg-primary/5 font-bold text-[12px] flex items-center justify-center gap-1 disabled:opacity-50">
                  <Zap className="w-3.5 h-3.5" />
                  {publishingId === l.id ? '公開しています…' : '今すぐ公開する（次回を待たない）'}
                </button>
              )}
              {l.isActive && l.hasLiveBag && (
                <button type="button" onClick={() => withdrawNow(l)}
                  className="w-full mt-2 py-2 rounded-xl border border-rose-200 text-rose-700 bg-rose-50 font-bold text-[12px] flex items-center justify-center gap-1">
                  <EyeOff className="w-3.5 h-3.5" />いま公開中の分を取り下げる（定期は継続）
                  {l.liveReservedQty > 0 && <span className="ml-1 text-[10px] font-black">・予約{l.liveReservedQty}件</span>}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
