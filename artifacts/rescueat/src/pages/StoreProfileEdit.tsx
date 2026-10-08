import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { StoreLayout } from '@/components/StoreLayout';
import { useMyStore } from '@/hooks/use-my-store';
import { useToast } from '@/hooks/use-toast';
import { ChevronLeft, Camera, Save, Clock, CalendarX2, Store, FileText, Phone, MapPin, Loader2, MapPinned, X as XIcon, ChevronDown } from 'lucide-react';
import { TimePicker } from '@/components/TimePicker';
import { motion } from 'framer-motion';
import { authedFetch } from '@/lib/authed-fetch';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { ImageCropper } from '@/components/ImageCropper';
import { PlaceSearchMap, PlaceResult } from '@/components/PlaceSearchMap';

function dataUrlToFile(dataUrl: string, filename: string): File {
  const [meta, b64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

// ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

const CATEGORY_OPTIONS = [
  { value: 'meals',         label: '料理・お惣菜',  emoji: '🍱' },
  { value: 'bakery_sweets', label: 'パン・スイーツ', emoji: '🥐' },
  { value: 'ingredients',   label: '食材・その他',  emoji: '🍎' },
];

type StoreProfile = {
  name: string;
  description: string;
  imageUrl: string;
  iconUrl: string;
  phone: string;
  address: string;
  city: string;
  openTime: string;
  closeTime: string;
  holiday: string;
  pickupHours: string;
  category: string;
  qualifiedInvoiceNumber: string;
  lat: number | null;
  lng: number | null;
};

export default function StoreProfileEdit() {
  const [, navigate] = useLocation();
  const { store, loading } = useMyStore();
  const { signOut } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState<StoreProfile>({
    name: '',
    description: '',
    imageUrl: '',
    iconUrl: '',
    phone: '',
    address: '',
    city: '',
    openTime: '',
    closeTime: '',
    holiday: '',
    pickupHours: '',
    category: 'other',
    qualifiedInvoiceNumber: '',
    lat: null,
    lng: null,
  });
  const [showMapEditor, setShowMapEditor] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [previewUrl, setPreviewUrl]       = useState('');
  const [iconPreviewUrl, setIconPreviewUrl] = useState('');
  const fileRef     = useRef<HTMLInputElement>(null);
  const iconFileRef = useRef<HTMLInputElement>(null);
  // ★ ユーザが編集を始めたら、バックグラウンド再取得結果で上書きしないためのフラグ
  const dirtyRef = useRef(false);

  // ★ Stale-While-Revalidate パターン:
  //   1) useMyStore で既に持ってる店舗データで「即座に」 form を埋める (1〜2秒のラグを解消)
  //   2) その上でバックグラウンドで /api/stores/${id} を叩いて最新値で上書き
  //      ただし: store 切替/アンマウント時は AbortController で打ち切り、
  //      既に編集中 (dirty) なら入力を尊重してフォームには適用しない (画像 preview のみ更新)。
  useEffect(() => {
    if (!store) return;
    // store が変わったら dirty を一旦リセット (新しい店舗の編集開始)
    dirtyRef.current = false;

    // 1) 即時に既存データで埋める
    setForm(f => ({
      ...f,
      name:         store.name         ?? '',
      description:  store.description  ?? '',
      imageUrl:     store.imageUrl     ?? '',
      iconUrl:      store.iconUrl      ?? '',
      phone:        store.phone        ?? '',
      address:      store.address      ?? '',
      city:         store.city         ?? '',
      openTime:     store.openTime     ?? '',
      closeTime:    store.closeTime    ?? '',
      holiday:      store.holiday      ?? '',
      pickupHours:  store.pickupHours  ?? '',
      category:     store.category     ?? 'meals',
      qualifiedInvoiceNumber: (store as any).qualifiedInvoiceNumber ?? '',
      lat:          (store as any).lat  ?? null,
      lng:          (store as any).lng  ?? null,
    }));
    setPreviewUrl(store.imageUrl ?? '');
    setIconPreviewUrl(store.iconUrl ?? '');

    // 2) バックグラウンドで最新値を取得して上書き (AbortController で安全に打ち切り)
    const ac = new AbortController();
    const targetStoreId = store.id;
    authedFetch(`${BASE}/api/stores/${store.id}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        // 別店舗に切り替わった後の遅延レスポンスは無視
        if (targetStoreId !== store.id) return;
        // ユーザが既に編集を始めてる場合はフォームを上書きしない
        if (dirtyRef.current) return;
        setForm({
          name:         data.name         ?? '',
          description:  data.description  ?? '',
          imageUrl:     data.imageUrl     ?? '',
          iconUrl:      data.iconUrl      ?? '',
          phone:        data.phone        ?? '',
          address:      data.address      ?? '',
          city:         data.city         ?? '',
          openTime:     data.openTime     ?? '',
          closeTime:    data.closeTime    ?? '',
          holiday:      data.holiday      ?? '',
          pickupHours:  data.pickupHours  ?? '',
          category:     data.category     ?? 'meals',
          qualifiedInvoiceNumber: data.qualifiedInvoiceNumber ?? '',
          lat:          data.lat ?? null,
          lng:          data.lng ?? null,
        });
        setPreviewUrl(data.imageUrl ?? '');
        setIconPreviewUrl(data.iconUrl ?? '');
      })
      .catch(err => {
        // AbortError は意図的な打ち切りなので無視
        if ((err as any)?.name !== 'AbortError') {
          // 通信エラーは黙殺 (即時表示で既に form は埋まってる)
        }
      });
    return () => ac.abort();
  }, [store]);

  // ★ form が変わった時点で dirty マーク (バックグラウンド再取得から保護)
  //    setForm がコンテキスト同期由来か手動編集由来かを完璧に区別するのは難しいので、
  //    入力ハンドラ側で dirty を立てる方針にする (各 onChange 経路で dirtyRef.current = true)。
  function markDirty() { dirtyRef.current = true; }

  const [cropperFile, setCropperFile] = useState<File | null>(null);
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCropperFile(file);
  };

  const uploadCroppedImage = async (dataUrl: string) => {
    setUploading(true);
    try {
      const file = dataUrlToFile(dataUrl, 'store-photo.jpg');
      const fd = new FormData();
      fd.append('image', file);
      const res = await authedFetch(`${BASE}/api/upload/bag-image`, { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { message?: string }));
        throw new Error(data.message || `送信失敗 (HTTP ${res.status})`);
      }
      const { url } = await res.json();
      setPreviewUrl(url);
      setForm(f => ({ ...f, imageUrl: url }));
      markDirty();
    } catch (err) {
      toast({
        title: 'アップロードエラー',
        description: err instanceof Error ? err.message : '画像の送信に失敗しました',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  // ★ アイコン値を DB に即保存するユーティリティ。
  //   保存ボタン押し忘れ問題と、フォーム他項目との競合を回避するため
  //   「iconUrl だけ」の最小 PATCH を別投げする (allowed list で iconUrl のみ更新される)。
  const persistIconUrl = async (newIconUrl: string): Promise<boolean> => {
    if (!store) return false;
    const url = `${BASE}/api/stores/${store.id}/profile`;
    const body = JSON.stringify({ iconUrl: newIconUrl });
    let res = await authedFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (res.status === 401) {
      try {
        const { data: { session } } = await supabase.auth.refreshSession();
        if (session?.access_token) {
          res = await authedFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
        }
      } catch (e) {
        console.warn('[StoreProfileEdit] icon refreshSession failed:', e);
      }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { message?: string }));
      throw new Error(data.message || `保存失敗 (HTTP ${res.status})`);
    }
    return true;
  };

  // ★ 地図ピン用アイコンの選択 (正方形推奨・自動で角丸表示)
  //   アップロード成功直後に DB へ即保存し、保存ボタン押し忘れによる「設定したのに反映されない」
  //   問題を完全に防ぐ。
  //   ★ 地図側 fetch 制限 (5MB) と転送量を抑えるため、アップロード前に必ず 256x256 にリサイズする。
  //      これで Supabase ストレージ容量も大幅節約 (1MB 越え → 数十KB)。
  // canvas → Blob 変換 (iOS Safari 等の toBlob 未対応環境では toDataURL → Blob にフォールバック)
  const canvasToJpegBlob = async (canvas: HTMLCanvasElement, quality = 0.85): Promise<Blob> => {
    if (typeof canvas.toBlob === 'function') {
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob(resolve, 'image/jpeg', quality);
        } catch {
          resolve(null);
        }
      });
      if (blob) return blob;
    }
    // fallback: toDataURL → fetch → blob
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const r = await fetch(dataUrl);
    return await r.blob();
  };

  const resizeIconToSquare = async (file: File, size = 256): Promise<Blob> => {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
      r.onerror = () => reject(new Error('読み込み失敗'));
      r.readAsDataURL(file);
    });
    const img: HTMLImageElement = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('画像のデコードに失敗しました'));
      im.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas未対応');
    // center-crop して正方形にしてから縮小 (アスペクト比維持・歪み防止)
    const srcSize = Math.min(img.width, img.height);
    const sx = (img.width - srcSize) / 2;
    const sy = (img.height - srcSize) / 2;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
    return await canvasToJpegBlob(canvas, 0.85);
  };

  const handleIconChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'ファイルが大きすぎます', description: '10MB 以下の画像を選択してください', variant: 'destructive' });
      return;
    }
    setIconUploading(true);
    try {
      // ★ アップロード前に 256x256 JPEG に必ず圧縮する。
      //    リサイズ失敗時は原画像へフォールバックせず明示エラーで返す
      //    (大きい原画像が地図側 5MB 制限に引っかかって絵文字に戻る再発を防ぐ)。
      let uploadBlob: Blob;
      try {
        uploadBlob = await resizeIconToSquare(file, 256);
      } catch (resizeErr) {
        const msg = resizeErr instanceof Error ? resizeErr.message : '画像処理エラー';
        throw new Error(`画像のリサイズに失敗しました (${msg})。別の画像でお試しください。`);
      }
      // 安全装置: 256x256 JPEG はほぼ確実に 200KB 未満。1MB 超なら不正系として弾く。
      if (uploadBlob.size > 1024 * 1024) {
        throw new Error('リサイズ後の画像サイズが想定外に大きいため中止しました。別の画像でお試しください。');
      }
      const fd = new FormData();
      fd.append('image', uploadBlob, 'icon.jpg');
      const res = await authedFetch(`${BASE}/api/upload/bag-image`, { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { message?: string }));
        throw new Error(data.message || `送信失敗 (HTTP ${res.status})`);
      }
      const { url } = await res.json();
      // フォーム & プレビュー更新
      setIconPreviewUrl(url);
      setForm(f => ({ ...f, iconUrl: url }));
      // DB に即保存 (失敗時はトーストでロールバック表示)
      try {
        await persistIconUrl(url);
        toast({ title: 'アイコンを保存しました', description: '地図のピンに反映されます' });
      } catch (saveErr) {
        toast({
          title: 'アイコンの保存に失敗しました',
          description: saveErr instanceof Error ? saveErr.message : '通信を確認して再度お試しください',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'アップロードエラー',
        description: err instanceof Error ? err.message : 'アイコンの送信に失敗しました',
        variant: 'destructive',
      });
    } finally {
      setIconUploading(false);
    }
  };

  const handleIconRemove = async () => {
    setIconPreviewUrl('');
    setForm(f => ({ ...f, iconUrl: '' }));
    try {
      await persistIconUrl('');
      toast({ title: 'アイコンを削除しました' });
    } catch (err) {
      toast({
        title: 'アイコンの削除に失敗しました',
        description: err instanceof Error ? err.message : '通信を確認して再度お試しください',
        variant: 'destructive',
      });
    }
  };

  const handleSave = async () => {
    // ★ store がまだロードされていない時にサイレント無反応にしない（旧版ではユーザーが
    //    「ボタンを押しても何も起こらない」と感じる致命的 UX バグの原因だった）
    if (!store) {
      toast({
        title: '店舗情報の読み込み中です',
        description: '少し待ってから再度お試しください。改善しない場合は再ログインしてください。',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    const url = `${BASE}/api/stores/${store.id}/profile`;
    try {
      // ── 1st attempt ──
      let res = await authedFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      // ── 401 fallback: Supabase access_token が期限切れ等の場合、refreshSession して 1 回だけ retry ──
      // (iOS Capacitor で稀に auto-refresh が間に合わずに 401 が返るケースの救済)
      if (res.status === 401) {
        try {
          const { data: { session } } = await supabase.auth.refreshSession();
          if (session?.access_token) {
            res = await authedFetch(url, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(form),
            });
          }
        } catch (refreshErr) {
          console.warn('[StoreProfileEdit] refreshSession failed:', refreshErr);
        }
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        if (res.status === 401) {
          // ★ retry 後も 401 ならセッション完全失効。AuthContext 上で user が残ったまま
          //    /login に navigate しても GuestRoute 側が user 有り判定で即 redirect 先 (/store/profile-edit)
          //    に戻されて無限ループになる。signOut で AuthContext を完全クリアしてから navigate する。
          toast({
            title: 'ログインの有効期限が切れました',
            description: '再ログインしてからもう一度お試しください。',
            variant: 'destructive',
          });
          try {
            await signOut();
          } catch (signOutErr) {
            console.warn('[StoreProfileEdit] signOut after 401 failed:', signOutErr);
          }
          navigate('/login?tab=store&redirect=' + encodeURIComponent('/store/profile-edit'));
          return;
        }
        const msg = body?.message || body?.error || `HTTP ${res.status}`;
        throw new Error(String(msg));
      }
      toast({ title: '保存しました', description: '店舗プロフィールを更新しました' });
      navigate('/mypage');
    } catch (err: any) {
      console.error('[StoreProfileEdit] save error:', err);
      toast({ title: '保存に失敗しました', description: String(err?.message ?? err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // ★ store がキャッシュ/コンテキストから既に取れてる場合はスピナーを出さない (体感即表示)。
  //    本当に空の初回ロード (loading && !store) のみフルスピナー表示。
  if (loading && !store) {
    return (
      <StoreLayout showHeader={false}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </StoreLayout>
    );
  }

  return (
    <StoreLayout showHeader={false}>

      {/* ══════════════════════════════════════════════════
          固定タイトルバー
          - 画面最上部（top:0）に fixed 配置
          - padding-top で iPhone ノッチを確実に回避
          - z-50 でカバー写真の上に重ねる
      ══════════════════════════════════════════════════ */}
      <div
        className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-xl border-b border-border/50 shadow-sm"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center gap-3 px-4 h-14 max-w-xl md:max-w-3xl mx-auto">
          {/* 戻るボタン */}
          <button
            type="button"
            onClick={() => navigate('/mypage')}
            className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 active:scale-90 transition-all shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* タイトル */}
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-black text-foreground leading-tight">店舗プロフィール編集</h1>
            <p className="text-[10px] text-muted-foreground mt-0.5">お客様に表示される情報を編集</p>
          </div>

          {/* 保存ボタン */}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || uploading || iconUploading}
            className="flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-60 hover:bg-primary/90 active:scale-95 transition-all shadow-md shadow-primary/20 shrink-0"
          >
            {saving
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Save className="w-4 h-4" />}
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          スクロールコンテンツ
          - padding-top で固定タイトルバーの高さ分だけ下にずらす
            (14px safe-area + 56px bar = 70px 基準)
          - カバー写真をコンテンツの先頭・全幅で表示
      ══════════════════════════════════════════════════ */}
      <div
        className="w-full max-w-xl md:max-w-3xl mx-auto w-full pb-10"
        style={{ paddingTop: 'calc(56px + env(safe-area-inset-top))' }}
      >

        {/* ── カバー写真（全幅・ヒーロー表示） ── */}
        <div
          className="relative w-full cursor-pointer group overflow-hidden"
          style={{ aspectRatio: '2 / 1' }}
          onClick={() => fileRef.current?.click()}
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="カバー写真"
              className="w-full h-full object-cover"
            />
          ) : (
            /* プレースホルダー：オレンジグラデーション背景 */
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-orange-50 to-orange-100 border-b border-orange-200">
              <div className="w-16 h-16 rounded-full bg-white/80 flex items-center justify-center shadow-sm">
                <Camera className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-bold text-primary">カバー写真を追加</p>
                <p className="text-xs text-muted-foreground mt-0.5">タップして写真を選択</p>
              </div>
            </div>
          )}

          {/* ホバー/タップ時オーバーレイ */}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
            {uploading ? (
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            ) : (
              <>
                <Camera className="w-8 h-8 text-white" />
                <span className="text-white font-bold text-sm">写真を変更</span>
              </>
            )}
          </div>

          {/* アップロード中プログレスバー */}
          {uploading && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
              <div className="h-full bg-primary animate-pulse" style={{ width: '60%' }} />
            </div>
          )}
        </div>

        {/* 写真サイズヒント */}
        <div className="flex items-center justify-between px-4 py-2 bg-orange-50/60 border-b border-orange-100">
          <p className="text-[11px] text-muted-foreground">JPG・PNG・WEBP / 推奨サイズ 1200×600px</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="text-[11px] font-bold text-primary hover:underline"
          >
            変更する
          </button>
        </div>

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />

        {/* ── 地図ピン用アイコン (任意) ───────────────────────────────────── */}
        <div className="px-4 pt-5">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white border border-border rounded-2xl overflow-hidden shadow-sm"
          >
            <div className="px-5 pt-5 pb-3 border-b border-border/50">
              <h2 className="font-black text-sm flex items-center gap-2">
                <MapPinned className="w-4 h-4 text-primary" />
                地図のピンに使うアイコン
                <span className="ml-auto text-[10px] font-bold text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">任意</span>
              </h2>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                マップ画面で表示されるオリジナルピンに使います。未設定なら、カテゴリ絵文字のピンが自動で表示されます。<br />
                <span className="text-[10px] text-muted-foreground/80">推奨: 正方形・PNG/JPG・512×512px 程度</span>
              </p>
            </div>
            <div className="p-5 flex items-center gap-4">
              {/* アイコンプレビュー (正方形・角丸 → 円形) */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => iconFileRef.current?.click()}
                  disabled={iconUploading}
                  className="w-20 h-20 rounded-full overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100 border-2 border-primary/30 shadow-sm flex items-center justify-center hover:scale-105 active:scale-95 transition-transform disabled:opacity-60"
                  aria-label="アイコンを変更"
                >
                  {iconPreviewUrl ? (
                    <img loading="lazy" decoding="async" src={iconPreviewUrl} alt="店舗アイコン" className="w-full h-full object-cover" />
                  ) : iconUploading ? (
                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  ) : (
                    <Camera className="w-6 h-6 text-primary" />
                  )}
                </button>
                {/* 削除ボタン */}
                {iconPreviewUrl && !iconUploading && (
                  <button
                    type="button"
                    onClick={handleIconRemove}
                    className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-white border border-border shadow-md flex items-center justify-center hover:bg-red-50 active:scale-90 transition-all"
                    aria-label="アイコンを削除"
                  >
                    <XIcon className="w-3.5 h-3.5 text-red-500" />
                  </button>
                )}
              </div>

              {/* 説明と切替ボタン */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-foreground">
                  {iconPreviewUrl ? 'カスタムアイコン設定済み' : 'まだ設定されていません'}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                  {iconPreviewUrl
                    ? 'お客様のマップ上にこのアイコンが表示されます'
                    : 'カテゴリ絵文字のピンで表示されます'}
                </p>
                <button
                  type="button"
                  onClick={() => iconFileRef.current?.click()}
                  disabled={iconUploading}
                  className="mt-2 text-xs font-bold text-primary hover:underline disabled:opacity-60"
                >
                  {iconUploading ? 'アップロード中…' : iconPreviewUrl ? 'アイコンを変更' : 'アイコンを選ぶ'}
                </button>
              </div>
            </div>
          </motion.div>
          <input ref={iconFileRef} type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
        </div>

        {/* ── フォームカード群 ── */}
        <div className="px-4 py-5 space-y-5">

          {/* 基本情報 */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white border border-border rounded-2xl overflow-hidden shadow-sm"
          >
            <div className="px-5 pt-5 pb-3 border-b border-border/50">
              <h2 className="font-black text-sm flex items-center gap-2">
                <Store className="w-4 h-4 text-primary" />基本情報
              </h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">店舗名</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => { markDirty(); setForm(f => ({ ...f, name: e.target.value })); }}
                  placeholder="例：おすそわけ食堂 渋谷店"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                  <Phone className="w-3.5 h-3.5" />電話番号
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => { markDirty(); setForm(f => ({ ...f, phone: e.target.value })); }}
                  placeholder="例：090-0000-0000"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />住所
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={e => { markDirty(); setForm(f => ({ ...f, address: e.target.value })); }}
                  placeholder="例：東京都渋谷区神南1-2-3"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                {/* ── 地図ピンの位置調整 (折りたたみ式) ── */}
                <button
                  type="button"
                  onClick={() => setShowMapEditor(v => !v)}
                  className="mt-2 w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-secondary/30 hover:bg-secondary/60 active:bg-secondary/80 rounded-xl text-xs font-bold text-muted-foreground border border-border/40 transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <MapPinned className="w-3.5 h-3.5" />
                    地図ピンの位置を調整
                    {form.lat && form.lng && (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground/60">
                        ({form.lat.toFixed(5)}, {form.lng.toFixed(5)})
                      </span>
                    )}
                  </span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${showMapEditor ? 'rotate-180' : ''}`} />
                </button>
                {showMapEditor && (
                  <div className="mt-3 space-y-2">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      地図のピンをドラッグするか、検索バーでお店を検索してピンを正しい位置に合わせてください。マップ上の表示位置がズレている場合に修正できます。
                    </p>
                    <PlaceSearchMap
                      lat={form.lat ?? undefined}
                      lng={form.lng ?? undefined}
                      onPlace={(p: PlaceResult) => {
                        markDirty();
                        setForm(f => ({ ...f, lat: p.lat, lng: p.lng }));
                      }}
                      onPinMove={(lat, lng) => {
                        markDirty();
                        setForm(f => ({ ...f, lat, lng }));
                      }}
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-2">カテゴリ</label>
                <div className="flex gap-2">
                  {CATEGORY_OPTIONS.map(opt => (
                    <button
                      key={opt.value} type="button"
                      onClick={() => { markDirty(); setForm(f => ({ ...f, category: opt.value })); }}
                      className={`flex-1 flex flex-col items-center gap-1 py-3 rounded-xl border-2 font-bold text-xs transition-all active:scale-95 ${
                        form.category === opt.value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-secondary/50 text-foreground hover:border-primary/40'
                      }`}
                    >
                      <span className="text-xl">{opt.emoji}</span>
                      <span className="leading-tight text-center">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>

          {/* PR文 */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="bg-white border border-border rounded-2xl overflow-hidden shadow-sm"
          >
            <div className="px-5 pt-5 pb-3 border-b border-border/50">
              <h2 className="font-black text-sm flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />お店の紹介文（PR）
              </h2>
            </div>
            <div className="p-5">
              <textarea
                value={form.description}
                onChange={e => { markDirty(); setForm(f => ({ ...f, description: e.target.value })); }}
                rows={4}
                placeholder="お店の魅力、こだわり、おすそわけバッグの特徴などをPRしましょう！"
                className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
              <p className="text-xs text-muted-foreground mt-1.5">{form.description.length} 文字</p>
            </div>
          </motion.div>

          {/* 営業時間・定休日 */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-white border border-border rounded-2xl overflow-hidden shadow-sm"
          >
            <div className="px-5 pt-5 pb-3 border-b border-border/50">
              <h2 className="font-black text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" />営業時間・受取時間
              </h2>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">営業開始</label>
                  <TimePicker
                    value={form.openTime}
                    onChange={v => { markDirty(); setForm(f => ({ ...f, openTime: v })); }}
                    label="営業開始時間"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">営業終了</label>
                  <TimePicker
                    value={form.closeTime}
                    onChange={v => { markDirty(); setForm(f => ({ ...f, closeTime: v })); }}
                    label="営業終了時間"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">受取可能な時間帯（説明文）</label>
                <input
                  type="text"
                  value={form.pickupHours}
                  onChange={e => { markDirty(); setForm(f => ({ ...f, pickupHours: e.target.value })); }}
                  placeholder="例：18:00〜21:00（平日）、17:00〜20:00（土日）"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                  <CalendarX2 className="w-3.5 h-3.5" />定休日
                </label>
                <input
                  type="text"
                  value={form.holiday}
                  onChange={e => { markDirty(); setForm(f => ({ ...f, holiday: e.target.value })); }}
                  placeholder="例：毎週水曜日・年末年始"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
          </motion.div>

          {/* 適格請求書 (インボイス) 登録番号 */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.25 }}
            className="bg-card rounded-2xl p-5 shadow-sm border border-border/50"
          >
            <h2 className="text-sm font-black text-foreground mb-4 flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />適格請求書発行事業者登録番号
              <span className="text-[10px] font-bold text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">任意</span>
            </h2>
            <div className="space-y-2">
              <input
                type="text"
                value={form.qualifiedInvoiceNumber}
                onChange={e => {
                  markDirty();
                  // T + 数字以外は弾き、 大文字統一、 最大14文字 (T + 13桁)
                  const v = e.target.value.toUpperCase().replace(/[^T0-9]/g, '').slice(0, 14);
                  setForm(f => ({ ...f, qualifiedInvoiceNumber: v }));
                }}
                placeholder="例：T1234567890123"
                inputMode="text"
                autoCapitalize="characters"
                className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono tracking-wider"
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                インボイス制度 (2023年10月開始) の登録事業者の方は、 国税庁発行の登録番号 (T + 13桁の数字) を入力してください。 入力すると、 お客様向け領収書に自動で記載され「適格請求書」 として機能します。 未入力の場合は領収書に「※当店は適格請求書発行事業者ではありません」 と表示されます。
              </p>
              {form.qualifiedInvoiceNumber && !/^T\d{13}$/.test(form.qualifiedInvoiceNumber) && (
                <p className="text-[11px] font-bold text-amber-600">
                  ⚠️ 登録番号は「T + 13桁の数字」 (合計14文字) で入力してください
                </p>
              )}
            </div>
          </motion.div>

          {/* 保存ボタン（下部） */}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || uploading || iconUploading}
            className="w-full h-14 bg-primary text-white rounded-2xl font-black text-base flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all shadow-lg shadow-primary/25 disabled:opacity-60"
          >
            {saving
              ? <Loader2 className="w-5 h-5 animate-spin" />
              : <Save className="w-5 h-5" />}
            {saving ? '保存中...' : 'プロフィールを保存する'}
          </button>
        </div>
      </div>
      {cropperFile && (
        <ImageCropper
          file={cropperFile}
          aspect={2}
          onCancel={() => setCropperFile(null)}
          onConfirm={(dataUrl) => {
            setCropperFile(null);
            void uploadCroppedImage(dataUrl);
          }}
        />
      )}
    </StoreLayout>
  );
}
