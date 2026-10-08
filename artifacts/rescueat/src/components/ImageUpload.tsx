import React, { useRef, useState } from 'react';
import { ImagePlus, X, RefreshCw, AlertCircle } from 'lucide-react';
import { authedFetch } from '@/lib/authed-fetch';

// ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

interface ImageUploadProps {
  value: string | null;
  onChange: (url: string | null) => void;
  required?: boolean;
}

/**
 * canvas で画像をリサイズ＋WebP圧縮して File に変換
 * - 最大辺 1200px にダウンスケール（超えていれば縮小、小さければそのまま）
 * - WebP は JPEG より 25〜35% 小さく Supabase Storage の無料枠を長持ちさせる
 * - WebP 非対応ブラウザ（古い Safari 等）は JPEG にフォールバック
 */
async function compressImage(file: File, maxWidth = 1200, quality = 0.82): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const { naturalWidth: w, naturalHeight: h } = img;

      // 長辺が maxWidth を超える場合のみ縮小（短辺基準ではなく長辺基準）
      const scale = w > maxWidth ? maxWidth / w : 1;
      const cw = Math.round(w * scale);
      const ch = Math.round(h * scale);

      const canvas = document.createElement('canvas');
      canvas.width  = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d')!;
      // 高品質ダウンスケール
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);

      // WebP を優先、非対応なら JPEG にフォールバック
      const supportsWebP = canvas.toDataURL('image/webp').startsWith('data:image/webp');
      const mimeType  = supportsWebP ? 'image/webp' : 'image/jpeg';
      const extension = supportsWebP ? '.webp'      : '.jpg';

      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return; }
          const baseName = file.name.replace(/\.[^.]+$/, '');
          resolve(new File([blob], `${baseName}${extension}`, { type: mimeType }));
        },
        mimeType,
        quality,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
    img.src = objectUrl;
  });
}

export function ImageUpload({ value, onChange, required }: ImageUploadProps) {
  const inputRef  = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress]  = useState<string>('');
  const [error, setError]        = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      setProgress('圧縮中...');
      const compressed = await compressImage(file);
      const sizeMB = (compressed.size / 1024 / 1024).toFixed(1);
      setProgress(`送信中 (${sizeMB}MB)...`);

      const formData = new FormData();
      formData.append('image', compressed);

      // ── 認証必須エンドポイント (authedFetch が Bearer 自動付与) ──
      const res = await authedFetch(`${BASE}/api/upload/bag-image`, {
        method: 'POST',
        body: formData,
      });
      if (res.status === 401) {
        throw new Error('ログインが必要です');
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message ?? d.error ?? `アップロードに失敗しました (HTTP ${res.status})`);
      }
      const { url } = await res.json();
      onChange(url);
    } catch (e: any) {
      setError(e.message ?? 'アップロードエラー');
    } finally {
      setUploading(false);
      setProgress('');
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-bold text-muted-foreground mb-1.5">
        商品写真 {required && <span className="text-red-500">*</span>}
      </label>

      {value ? (
        /* ── 画像選択済み ── */
        <div className="relative rounded-2xl overflow-hidden border-2 border-primary/30 shadow-sm">
          <img loading="lazy" decoding="async" src={value} alt="商品写真" className="w-full h-48 object-cover" />

          {/* 削除ボタン */}
          <button
            type="button"
            onClick={() => { onChange(null); setError(null); }}
            className="absolute top-2 right-2 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center text-white hover:bg-black/80 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 変更ボタン（1つ・中央下） */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/60 text-white text-xs font-bold px-3 py-1.5 rounded-full hover:bg-black/80 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            写真を変更
          </button>

          {uploading && (
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
              <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
              <p className="text-white text-xs font-bold">{progress}</p>
            </div>
          )}
        </div>
      ) : uploading ? (
        /* ── アップロード中 ── */
        <div className="w-full h-44 border-2 border-dashed border-primary/40 rounded-2xl bg-primary/5 flex flex-col items-center justify-center gap-3">
          <div className="w-9 h-9 border-[3px] border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-bold text-primary">{progress || 'アップロード中...'}</p>
        </div>
      ) : (
        /* ── 未選択 ── */
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`w-full h-44 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 transition-all group ${
            error
              ? 'border-red-400 bg-red-50 hover:border-red-500'
              : 'border-border hover:border-primary/50 hover:bg-primary/5'
          }`}
        >
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-colors ${
            error ? 'bg-red-100' : 'bg-primary/10 group-hover:bg-primary/15'
          }`}>
            <ImagePlus className={`w-7 h-7 ${error ? 'text-red-500' : 'text-primary'}`} />
          </div>
          <div className="text-center">
            <p className={`text-sm font-black ${error ? 'text-red-600' : 'text-foreground'}`}>
              タップして写真を選ぶ
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">カメラまたはライブラリから選択</p>
          </div>
        </button>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-red-500">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <p className="text-xs font-bold">{error}</p>
        </div>
      )}

      {/* ファイル選択 input — capture なし → iOS がカメラ/ライブラリ選択シートを表示
          ★ accept は image/* にする (2026-08-05)。MIMEを列挙すると Android の
            ピッカーが対象を絞り込みすぎて【写真を1枚も選べない】状態になる
            (店舗様から報告)。HEIC等も含めて選択後に canvas で webp/jpeg へ
            変換しているため、種類を広く受けても問題ない。 */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
}
