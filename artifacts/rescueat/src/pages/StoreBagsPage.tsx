import React, { useState, useRef, useCallback } from 'react';
import { StoreLayout } from '@/components/StoreLayout';
import { useMyStores } from '@/hooks/use-my-stores';
import { StoreSelector } from '@/components/StoreSelector';
import { useListStoreBags, useCreateBag, getListStoreBagsQueryKey } from '@workspace/api-client-react';
import {
  Plus, Minus, Package2, AlertCircle, Loader2,
  ChevronUp, ChevronDown, Zap, Lock, Clock, Eye,
} from 'lucide-react';
import { ImageUpload } from '@/components/ImageUpload';
import { CategoryPicker } from '@/components/CategoryPicker';
import { BagPreviewSheet } from '@/components/BagPreviewSheet';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';
import { BagManageCard, getBagStatus, type Bag, type BagRealStatus } from '@/components/BagManageCard';
import { authedFetch } from '@/lib/authed-fetch';
import { getDisplayPrice } from '@/lib/price-display';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

export default function StoreBagsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { currentStore: store, loading: storeLoading, stores } = useMyStores();
  const storeId = store?.id ?? null;

  const { data: bags = [], isLoading } = useListStoreBags(storeId ?? 0, {
    query: {
      queryKey: getListStoreBagsQueryKey(storeId ?? 0),
      enabled: !!storeId,
      staleTime: 0,             // 常に古いと見なし必ず再取得チェック
      refetchOnMount: 'always', // 画面に戻るたびサーバーから最新取得
      // ★ 自動更新: 他端末での出品/停止・売れ行きを最大10秒で反映（複数端末同時運用対策）。
      //   これが無く、 出品管理ページだけステータスが同期しないバグがあった（2026-06-30 濱島さん報告）。
      refetchInterval: 10_000,
      refetchOnWindowFocus: true,
    },
  });
  const createBag = useCreateBag();

  const [showForm, setShowForm]       = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [togglingId, setTogglingId]   = useState<number | null>(null);
  const [deletingId, setDeletingId]   = useState<number | null>(null);
  const [adjustingId, setAdjustingId] = useState<number | null>(null);
  const [confirmId, setConfirmId]     = useState<number | null>(null);
  const [imageUrl, setImageUrl]       = useState<string | null>(null);
  const [showPreview, setShowPreview]     = useState(false); // 新規出品のお客様画面プレビュー
  const [showEditPreview, setShowEditPreview] = useState(false); // 受取時間編集のお客様画面プレビュー

  // ★ 受取時間編集モーダル: 「編集して公開」 導線で開かれる軽量編集 UI。
  //   pickupStart/pickupEnd を更新しつつ isActive=true に切替えて即公開する。
  const [editBag, setEditBag] = useState<Bag | null>(null);
  const [editPickupStart, setEditPickupStart] = useState('18:00');
  const [editPickupEnd, setEditPickupEnd]     = useState('20:00');
  const [editAndPublish, setEditAndPublish]   = useState(false);
  const [editSubmitting, setEditSubmitting]   = useState(false);

  const [form, setForm] = useState({
    title: '',
    originalPrice: 0,
    discountedPrice: 0,
    stockCount: 3,
    pickupStart: '18:00',
    pickupEnd: '20:00',
    itemType: 'bag' as 'bag' | 'item',
  });
  const [editingStock, setEditingStock] = useState(false);
  const stockInputRef = useRef<HTMLInputElement>(null);
  const [bagCategory, setBagCategory] = useState('');
  const [aiSuggested, setAiSuggested] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);

  const handleImageChange = useCallback(async (url: string | null) => {
    setImageUrl(url);
    if (!url || url.startsWith('http')) return;
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
          setBagCategory(prev => prev || data.category!);
        }
      }
    } catch {
      // 分類失敗は無視
    } finally {
      setClassifying(false);
    }
  }, []);

  // Stripe 最低決済額バリデーション
  const STRIPE_MIN_PRICE = 50;
  const priceError = form.discountedPrice > 0 && form.discountedPrice < STRIPE_MIN_PRICE;
  const canSubmit = !isSubmitting && form.title.trim() !== '' && !!imageUrl && !priceError && form.discountedPrice >= STRIPE_MIN_PRICE;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!storeId || !form.title.trim()) return;
    if (!imageUrl) {
      toast({ title: '写真を追加してください', variant: 'destructive' });
      return;
    }
    if (form.discountedPrice < STRIPE_MIN_PRICE) {
      toast({ title: 'Stripeの決済制限により、価格は50円以上に設定してください', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      await createBag.mutateAsync({
        storeId,
        data: {
          title: form.title,
          description: '',
          originalPrice: form.originalPrice,
          discountedPrice: form.discountedPrice,
          stockCount: form.stockCount,
          pickupStart: form.pickupStart,
          pickupEnd: form.pickupEnd,
          imageUrl,
          category: bagCategory || undefined,
          itemType: form.itemType,
        },
      });
      toast({ title: '出品しました！' });
      queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
      setShowForm(false);
      setImageUrl(null);
      setBagCategory('');
      setAiSuggested(null);
      setForm({ title: '', originalPrice: 0, discountedPrice: 0, stockCount: 3, pickupStart: '18:00', pickupEnd: '20:00', itemType: 'bag' });
    } catch {
      toast({ title: '出品に失敗しました', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  }

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

  async function handleDelete(bag: Bag) {
    if (!storeId) return;
    setDeletingId(bag.id);
    setConfirmId(null);
    try {
      // ★ バックエンドは isActive=true のバッグの DELETE を 409 で拒否する仕様のため、
      //   公開中なら先に非公開化してから削除を行う (UI 上は 1 アクションに見せる)。
      if (bag.isActive) {
        const patchRes = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${bag.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: false }),
        });
        if (!patchRes.ok) {
          const body = await patchRes.json().catch(() => ({}));
          throw new Error(body.message ?? body.error ?? `非公開化に失敗しました (HTTP ${patchRes.status})`);
        }
      }
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

  // ★ 編集モーダルを開く。 受取時間が過ぎている非公開バッグの場合は
  //   「編集して公開」 モード (保存時に isActive=true) でオープン。
  function openEditModal(bag: Bag) {
    const now = new Date();
    const wouldExpire = !bag.isActive && getBagStatus({ ...bag, isActive: true }, now) === 'expired';
    setEditBag(bag);
    setEditPickupStart(bag.pickupStart ?? '18:00');
    setEditPickupEnd(bag.pickupEnd ?? '20:00');
    setEditAndPublish(wouldExpire);
  }

  async function handleEditSave() {
    if (!editBag || !storeId) return;
    setEditSubmitting(true);
    try {
      // ★ 「編集して公開」 の場合、 まず受取時間を更新してから公開フラグを ON にする。
      //   1 リクエストで送ると、 サーバ側の期限チェックが古いタイムを基に動く可能性があるので 2 段階に分ける。
      const patchBody: Record<string, unknown> = {
        pickupStart: editPickupStart,
        pickupEnd: editPickupEnd,
      };
      const r1 = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${editBag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      });
      if (!r1.ok) {
        const body = await r1.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `更新に失敗しました (HTTP ${r1.status})`);
      }
      if (editAndPublish) {
        const r2 = await authedFetch(`${BASE}/api/stores/${storeId}/bags/${editBag.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: true }),
        });
        if (!r2.ok) {
          const body = await r2.json().catch(() => ({}));
          throw new Error(body.message ?? body.error ?? `公開に失敗しました (HTTP ${r2.status})`);
        }
      }
      queryClient.refetchQueries({ queryKey: [`/api/stores/${storeId}/bags`], type: 'all' });
      toast({ title: editAndPublish ? '受取時間を更新して公開しました' : '受取時間を更新しました' });
      setEditBag(null);
    } catch (err: any) {
      toast({ title: err.message ?? '更新に失敗しました', variant: 'destructive' });
    } finally {
      setEditSubmitting(false);
    }
  }

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
    } catch {
      toast({ title: '在庫の更新に失敗しました', variant: 'destructive' });
    } finally {
      setAdjustingId(null);
    }
  }

  if (storeLoading) {
    return (
      <StoreLayout>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
        </div>
      </StoreLayout>
    );
  }

  if (!store) {
    return (
      <StoreLayout>
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div>
            <AlertCircle className="w-10 h-10 text-orange-400 mx-auto mb-3" />
            <p className="font-black text-lg">店舗情報が見つかりません</p>
          </div>
        </div>
      </StoreLayout>
    );
  }

  const now = new Date();
  const allBags    = bags as Bag[];
  const trulyActive  = allBags.filter(b => getBagStatus(b, now) === 'active');
  const sortedBags = [...allBags].sort((a, b) => {
    // ステータス優先順: 公開中(0) → 非公開(1) → 受付終了/完売(2)
    const ORDER: Record<BagRealStatus, number> = { active: 0, inactive: 1, expired: 2, soldout: 2 };
    const statusA = getBagStatus(a, now);
    const statusB = getBagStatus(b, now);
    const diff = (ORDER[statusA] ?? 9) - (ORDER[statusB] ?? 9);
    if (diff !== 0) return diff;
    // 公開中の中は受取開始時間が早い順
    if (statusA === 'active') {
      return (a.pickupStart || '').localeCompare(b.pickupStart || '');
    }
    return 0;
  });

  // KYC（決済本人確認）が完了していない場合は出品をブロック
  const kycPending = store && store.stripeChargesEnabled !== true;

  return (
    <StoreLayout>
      <div className="max-w-2xl mx-auto w-full px-4 py-5 space-y-5">

        {/* ── 複数店舗セレクター ── */}
        {stores.length > 1 && <StoreSelector />}

        {/* ── KYC審査中バナー ── */}
        {kycPending && (
          <div className="flex gap-3 items-start bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <div className="mt-0.5 shrink-0 bg-amber-100 rounded-full p-1.5">
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-bold text-amber-800">決済の本人確認が審査中です</p>
              <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                口座登録後、決済システムによる本人確認が完了するまで出品できません。
                早ければ数時間で完了します。審査通過後すぐに自動で出品が開始されます。
              </p>
            </div>
          </div>
        )}

        {/* ── ヘッダー ── */}
        <div>
          <h1 className="text-xl font-black text-foreground">出品・在庫管理</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            出品中 {trulyActive.length}件 / 全{allBags.length}件
          </p>
        </div>

        {/* ── 新規出品フォーム ── */}
        <AnimatePresence>
          {showForm && (
            <motion.form
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              onSubmit={handleSubmit}
              noValidate
              className="bg-white border-2 border-primary/20 rounded-2xl p-5 shadow-lg space-y-4"
            >
              <h3 className="font-black text-foreground">新しいおすそわけバッグ</h3>

              {/* ── 出品タイプ選択 (おすそわけ袋 / 単品) ──
                    バックエンド surprise_bags.item_type に 'bag' | 'item' で保存。
                    お客様向けカードに 🛍 おすそわけ袋 / 🥡 単品 バッジで区別表示される。 */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">出品タイプ</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, itemType: 'bag' }))}
                    className={`flex flex-col items-center gap-1 py-3 rounded-xl border-2 transition-all active:scale-95 ${
                      form.itemType === 'bag'
                        ? 'bg-orange-50 border-orange-400 shadow-sm'
                        : 'bg-secondary/40 border-border'
                    }`}
                  >
                    <span className="text-2xl leading-none">🛍</span>
                    <span className={`text-xs font-black ${form.itemType === 'bag' ? 'text-orange-600' : 'text-muted-foreground'}`}>
                      おすそわけ袋
                    </span>
                    <span className="text-[9px] text-muted-foreground leading-tight">中身おまかせ</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, itemType: 'item' }))}
                    className={`flex flex-col items-center gap-1 py-3 rounded-xl border-2 transition-all active:scale-95 ${
                      form.itemType === 'item'
                        ? 'bg-blue-50 border-blue-400 shadow-sm'
                        : 'bg-secondary/40 border-border'
                    }`}
                  >
                    <span className="text-2xl leading-none">🥡</span>
                    <span className={`text-xs font-black ${form.itemType === 'item' ? 'text-blue-600' : 'text-muted-foreground'}`}>
                      単品
                    </span>
                    <span className="text-[9px] text-muted-foreground leading-tight">商品を指定</span>
                  </button>
                </div>
              </div>

              {/* 商品名 */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">商品名</label>
                <input
                  required
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder="例：本日のお惣菜3点盛り"
                  className="w-full bg-secondary/40 border-2 border-border rounded-xl px-4 py-3 font-bold placeholder:text-muted-foreground/50 placeholder:font-normal focus:border-primary outline-none transition-all"
                />
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

                {/* ⚠️ Stripe 最低価格エラー */}
                {priceError && (
                  <div className="flex items-start gap-2 mt-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-xl">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                    <p className="text-xs font-bold text-red-600 leading-snug">
                      Stripeの決済制限により、価格は50円以上に設定してください
                    </p>
                  </div>
                )}

                {/* お客様表示価格 + 店舗受取予定額プレビュー */}
                {form.discountedPrice > 0 && (() => {
                  const price       = form.discountedPrice;
                  const userPrice   = getDisplayPrice(price);
                  const platFee     = Math.floor(price * 0.20);
                  const stripeFee   = Math.round(price * 0.036);
                  const shopAmount  = price - platFee - stripeFee;
                  return (
                    <>
                      <div className="mt-2 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2.5">
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-bold text-blue-700">お客様への表示価格</span>
                          <span className="text-sm font-black text-blue-700">¥{userPrice.toLocaleString()}</span>
                        </div>
                        <p className="text-[10px] text-blue-600/80 mt-0.5 leading-tight">
                          サービス手数料 5% 込みの総額表示
                        </p>
                      </div>
                      <div className="mt-2 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2.5 space-y-1">
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>おすそわけ 手数料 (20%)</span>
                          <span>-¥{platFee.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>Stripe 決済手数料 (3.6%)</span>
                          <span>-¥{stripeFee.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-xs font-black text-emerald-700 pt-0.5 border-t border-emerald-200">
                          <span>店舗受取予定額</span>
                          <span>¥{shopAmount.toLocaleString()}</span>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* 在庫数 ── ステッパー（カーソルバグ根絶版） */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-2">在庫数</label>

                {/* 行1：[−]  [数字表示]  [+]  ← 中央は div 表示のみ（input なし） */}
                <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 56px', gap: '8px' }}>

                  {/* − ボタン */}
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, stockCount: Math.max(1, f.stockCount - 1) }))}
                    disabled={form.stockCount <= 1}
                    style={{ height: '56px', minWidth: '56px' }}
                    className="flex items-center justify-center rounded-xl bg-secondary border-2 border-border text-foreground hover:bg-muted active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Minus className="w-5 h-5" strokeWidth={2.5} />
                  </button>

                  {/* 中央：数字を div で表示（input 不使用 → カーソル溢れゼロ） */}
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
                      editingStock
                        ? 'bg-primary/5 border-primary'
                        : 'bg-secondary/40 border-border'
                    }`}
                  >
                    <span className="text-2xl font-black leading-none">{form.stockCount}</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {editingStock ? '編集中…' : '個（タップで入力）'}
                    </span>
                  </button>

                  {/* ＋ ボタン */}
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, stockCount: f.stockCount + 1 }))}
                    style={{ height: '56px', minWidth: '56px' }}
                    className="flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary/90 active:scale-95 transition-all shadow-md shadow-primary/25"
                  >
                    <Plus className="w-5 h-5" strokeWidth={2.5} />
                  </button>
                </div>

                {/* 行2：直接入力欄（ステッパー下に全幅で展開 → 絶対配置不使用） */}
                <AnimatePresence>
                  {editingStock && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -6, height: 0 }}
                      style={{ overflow: 'hidden', marginTop: '8px' }}
                    >
                      {/* ── full-width スタンドアロン input ──
                          flex コンテナなし・padding なし・width:100% で
                          カーソルが絶対に枠外に出ない構造 */}
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
                            display: 'block',
                            width: '100%',
                            height: '56px',
                            boxSizing: 'border-box',
                            /* padding は左右とも 0 でカーソルはみ出しを防ぐ */
                            padding: '0',
                            paddingTop: '0',
                            paddingBottom: '0',
                            paddingLeft: '0',
                            paddingRight: '0',
                            margin: '0',
                            /* 中央揃え */
                            textAlign: 'center',
                            /* フォント */
                            fontSize: '28px',
                            fontWeight: 900,
                            lineHeight: '56px',
                            /* ボーダー */
                            border: '2px solid var(--primary)',
                            borderRadius: '12px',
                            outline: 'none',
                            /* 背景 */
                            backgroundColor: 'transparent',
                            background: 'transparent',
                            /* ブラウザデフォルトスタイル削除 */
                            WebkitAppearance: 'none' as React.CSSProperties['WebkitAppearance'],
                            appearance: 'none' as React.CSSProperties['appearance'],
                            color: 'var(--foreground)',
                          }}
                        />
                        {/* 「個」は input の外に重ねる（幅に干渉しない） */}
                        <span style={{
                          position: 'absolute',
                          right: '14px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          fontSize: '13px',
                          fontWeight: 700,
                          color: 'var(--muted-foreground)',
                          pointerEvents: 'none',
                          userSelect: 'none',
                        }}>
                          個
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* 受取時間（開始に「今すぐ」ボタン） */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">受取開始</label>
                  <div className="flex gap-1.5">
                    <input type="time" required value={form.pickupStart ?? ''}
                      onChange={e => setForm({ ...form, pickupStart: e.target.value })}
                      className="flex-1 min-w-0 bg-secondary/40 border-2 border-border rounded-xl px-2 py-3 font-bold focus:border-primary outline-none transition-all text-sm" />
                    <button
                      type="button"
                      onClick={() => {
                        const now = new Date();
                        const hh = now.getHours().toString().padStart(2, '0');
                        const mm = now.getMinutes().toString().padStart(2, '0');
                        setForm({ ...form, pickupStart: `${hh}:${mm}` });
                      }}
                      className="shrink-0 px-2 py-1 bg-primary/10 text-primary text-[10px] font-black rounded-lg hover:bg-primary/20 active:bg-primary/30 transition-colors leading-tight text-center"
                    >
                      今<br />すぐ
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                    受取終了 <span className="text-destructive">*</span>
                  </label>
                  <input type="time" required value={form.pickupEnd ?? ''}
                    onChange={e => setForm({ ...form, pickupEnd: e.target.value })}
                    className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-3 font-bold focus:border-primary outline-none transition-all" />
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
                    終了が開始より早い場合は翌日の時間として扱います
                  </p>
                </div>
              </div>

              <ImageUpload value={imageUrl} onChange={handleImageChange} required />

              <CategoryPicker
                value={bagCategory}
                onChange={setBagCategory}
                classifying={classifying}
                aiSuggested={aiSuggested}
              />

              {/* お客様画面プレビュー: 写真の見切り・文字の折り返しを出品前に確認 */}
              <button type="button" onClick={() => setShowPreview(true)}
                className="w-full py-3 rounded-xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5">
                <Eye className="w-4 h-4" />お客様の画面でプレビュー
              </button>

              <div className="flex gap-3">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 py-3 rounded-xl border-2 border-border font-bold text-muted-foreground hover:bg-muted transition-colors">
                  キャンセル
                </button>
                <button type="submit" disabled={!canSubmit}
                  className="flex-1 py-3 rounded-xl bg-primary text-white font-black flex items-center justify-center gap-2 shadow-md shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed hover:bg-primary/90 transition-all">
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Plus className="w-4 h-4" />出品する</>}
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        {/* 新規出品のお客様画面プレビュー */}
        <BagPreviewSheet
          open={showPreview}
          onOpenChange={setShowPreview}
          storeName={store?.name ?? ''}
          data={{
            title: form.title,
            originalPrice: form.originalPrice,
            discountedPrice: form.discountedPrice,
            stockCount: form.stockCount,
            pickupStart: form.pickupStart,
            pickupEnd: form.pickupEnd,
            imageUrl,
            category: bagCategory,
            itemType: form.itemType,
          }}
        />

        {/* ── 受取時間編集モーダル (編集して公開 導線) ── */}
        <AnimatePresence>
          {editBag && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-black/50 flex flex-col justify-end sm:items-center sm:justify-center"
              onClick={() => !editSubmitting && setEditBag(null)}
            >
              <motion.div
                initial={{ y: 40, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 40, opacity: 0 }}
                onClick={e => e.stopPropagation()}
                className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[88dvh] flex flex-col overflow-hidden"
              >
                {/* スクロール可能な本文 */}
                <div className="overflow-y-auto px-5 pt-5 pb-3 space-y-4">
                  <div>
                    <h3 className="font-black text-foreground">
                      {editAndPublish ? '受取時間を編集して公開' : '受取時間を編集'}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {editAndPublish
                        ? 'この商品は受取時間が過ぎているため、 新しい受取時間に更新してから公開します。'
                        : '受取時間を更新します。'}
                    </p>
                    <p className="text-xs font-bold text-foreground mt-2">{editBag.title}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">受取開始</label>
                      <input
                        type="time"
                        value={editPickupStart}
                        onChange={e => setEditPickupStart(e.target.value)}
                        className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 font-bold focus:border-primary outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">受取終了</label>
                      <input
                        type="time"
                        value={editPickupEnd}
                        onChange={e => setEditPickupEnd(e.target.value)}
                        className="w-full bg-secondary/40 border-2 border-border rounded-xl px-3 py-2.5 font-bold focus:border-primary outline-none transition-all"
                      />
                    </div>
                  </div>

                  {/* お客様画面プレビュー: 新しい受取時間での見え方を確認 */}
                  <button type="button" onClick={() => setShowEditPreview(true)}
                    className="w-full py-2.5 rounded-xl border border-primary/40 text-primary font-bold text-sm flex items-center justify-center gap-1.5">
                    <Eye className="w-4 h-4" />お客様の画面でプレビュー
                  </button>
                </div>

                {/* ★ 常時表示の固定フッター (sticky footer)。 セーフエリア分の余白を確保し、
                      本文が長くても下タブバーやホームインジケーターに絶対に隠れないようにする。 */}
                <div
                  className="shrink-0 flex gap-3 px-5 pt-3 border-t border-border bg-white"
                  style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
                >
                  <button
                    type="button"
                    onClick={() => setEditBag(null)}
                    disabled={editSubmitting}
                    className="flex-1 py-2.5 rounded-xl border-2 border-border font-bold text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={handleEditSave}
                    disabled={editSubmitting || !editPickupStart || !editPickupEnd}
                    className="flex-1 py-2.5 rounded-xl bg-primary text-white font-black flex items-center justify-center gap-2 shadow-md shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed hover:bg-primary/90 transition-all"
                  >
                    {editSubmitting
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : (editAndPublish ? '更新して公開' : '保存')}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 受取時間編集のお客様画面プレビュー(編集中の新しい受取時間で再現) */}
        {editBag && (
          <BagPreviewSheet
            open={showEditPreview}
            onOpenChange={setShowEditPreview}
            storeName={store?.name ?? ''}
            data={{
              title: editBag.title,
              description: editBag.description,
              originalPrice: editBag.originalPrice,
              discountedPrice: editBag.discountedPrice,
              stockCount: editBag.stockCount,
              pickupStart: editPickupStart,
              pickupEnd: editPickupEnd,
              imageUrl: editBag.imageUrl,
              category: editBag.category,
              allergyInfo: editBag.allergyInfo,
              pickupNote: editBag.pickupNote,
              itemType: (editBag.itemType === 'item' ? 'item' : 'bag'),
            }}
          />
        )}

        {/* ── 50円未満バッグ警告バナー ── */}
        {!isLoading && (() => {
          const lowPriceBags = (bags as Bag[]).filter(b => b.discountedPrice > 0 && b.discountedPrice < 50);
          if (lowPriceBags.length === 0) return null;
          return (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-black text-red-700">価格修正が必要な商品があります</p>
                  <p className="text-xs text-red-600 mt-0.5 leading-relaxed">
                    Stripeの決済制限により、販売価格が50円未満の商品は購入時にエラーが発生します。
                    速やかに50円以上に修正してください。
                  </p>
                </div>
              </div>
              <ul className="space-y-1 pl-7">
                {lowPriceBags.map(b => (
                  <li key={b.id} className="text-xs font-bold text-red-700 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                    {b.title} — 現在 ¥{b.discountedPrice}（50円以上が必要）
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {/* ── 出品中リスト ── */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">読み込み中...</span>
          </div>
        ) : (bags as Bag[]).length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-border p-10 text-center">
            <Package2 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-bold text-foreground">まだ商品がありません</p>
            <p className="text-xs text-muted-foreground mt-1">「新規出品」から商品を追加しましょう</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedBags.map(bag => (
              <BagManageCard
                key={bag.id}
                bag={bag as Bag}
                togglingId={togglingId}
                deletingId={deletingId}
                adjustingId={adjustingId}
                confirmId={confirmId}
                onToggle={handleToggleActive}
                onDelete={handleDelete}
                onStockAdjust={handleStockAdjust}
                onConfirmChange={setConfirmId}
                onEdit={openEditModal}
                hideEditItem
              />
            ))}
          </div>
        )}
      </div>
    </StoreLayout>
  );
}
