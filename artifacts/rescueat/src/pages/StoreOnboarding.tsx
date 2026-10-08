import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Layout } from '@/components/Layout';
import { useLocation } from 'wouter';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useMyStores } from '@/hooks/use-my-stores';
import { authedFetch } from '@/lib/authed-fetch';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, CheckCircle2, Leaf, Loader2, AlertTriangle,
  ShieldCheck, Camera, MapPinned, X as XIcon, FileText, AlertCircle,
} from 'lucide-react';
import { PlaceSearchMap, PlaceResult } from '@/components/PlaceSearchMap';
import { ImageCropper } from '@/components/ImageCropper';

// ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

const CATEGORY_OPTIONS = [
  { value: 'meals',         label: '料理・お惣菜',  emoji: '🍱' },
  { value: 'bakery_sweets', label: 'パン・スイーツ', emoji: '🥐' },
  { value: 'ingredients',   label: '食材・その他',  emoji: '🍎' },
];

async function compressImage(file: File, maxPx = 1200, quality = 0.80): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxPx || height > maxPx) {
          if (width >= height) { height = Math.round(height * maxPx / width); width = maxPx; }
          else { width = Math.round(width * maxPx / height); height = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const ONBOARDING_DRAFT_KEY = 'store-onboarding-draft-v2';
type OnboardingDraft = {
  name: string; address: string; city: string; category: string;
  phone: string; imageUrl: string; iconUrl: string;
  pledgeSigned: boolean;
  pinLat: number | null; pinLng: number | null;
  // ★ 2店舗目登録 (引き継ぎモード) 用: 営業許可証番号は draft 保存
  //    画像 (base64) は localStorage 容量を超えるため保存しない
  bizLicenseNumber: string;
};

// ── 店舗アイコン用 (地図ピンに表示) ────────────────────────────────────
//   StoreProfileEdit と同じロジックを onboarding にも持ち込む。
//   ・正方形 256x256 JPEG にリサイズしてからアップロード
//   ・地図側の 5MB fetch 制限と Supabase 容量を抑える
async function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.85): Promise<Blob> {
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise<Blob | null>((resolve) => {
      try { canvas.toBlob(resolve, 'image/jpeg', quality); } catch { resolve(null); }
    });
    if (blob) return blob;
  }
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const r = await fetch(dataUrl);
  return await r.blob();
}

async function resizeIconToSquare(file: File, size = 256): Promise<Blob> {
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
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;
  ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
  return await canvasToJpegBlob(canvas, 0.85);
}
function saveOnboardingDraft(d: Partial<OnboardingDraft>) {
  try { localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(d)); } catch (_) {}
}
function loadOnboardingDraft(): Partial<OnboardingDraft> {
  try { const r = localStorage.getItem(ONBOARDING_DRAFT_KEY); return r ? JSON.parse(r) : {}; } catch (_) { return {}; }
}
function clearOnboardingDraft() {
  try {
    localStorage.removeItem(ONBOARDING_DRAFT_KEY);
    localStorage.removeItem('store-onboarding-draft-v1'); // 旧バージョンも掃除
  } catch (_) {}
}

export default function StoreOnboarding() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user, profile, isLoading: authLoading, setOptimisticRole, refreshProfile } = useAuth();
  const { currentStore: existingStore, loading: storeLoading, hasExistingStripeAccount, refetch: refetchStores } = useMyStores();

  // ★ 退会直後・セッション失効時など user が null になった場合は
  //    onboarding 画面に居座らせず Welcome に戻す（「ログインが必要です」エラーで詰まるのを防ぐ）
  useEffect(() => {
    if (!authLoading && !user) {
      try { localStorage.removeItem(ONBOARDING_DRAFT_KEY); } catch (_) {}
      navigate('/welcome');
    }
  }, [authLoading, user, navigate]);

  // ★ StoreOnboarding 開始時に楽観的にロールを store_owner にする
  // → 戻るボタンで MyPage に行っても「お客様」表示にならず、店舗ナビが出る
  // submit 完了で実際のロールが DB 上で更新される (refreshProfile で同期)
  //
  // ★ 重要: sessionStorage フラグは「マウントと同時に同期的に」立てる必要がある。
  //   useEffect だと paint 後実行のため、 その隙間に fetchProfile (TOKEN_REFRESHED 等)
  //   が走ると profile=customer で上書きされ、 キャッシュも customer になり、
  //   戻るボタン押下時に MyPage で「メンバー」 表示になるバグの原因になる。
  //   → useLayoutEffect + 初回 render 前に sessionStorage を立てて、 fetchProfile が
  //     どのタイミングで走ってもフラグを見て store_owner にクランプされるよう保証する。
  const flagSetOnceRef = useRef(false);
  if (!flagSetOnceRef.current) {
    try {
      sessionStorage.setItem('osusowake_pending_store_owner_v1', '1');
    } catch (_) { /* ignore */ }
    flagSetOnceRef.current = true;
  }
  useLayoutEffect(() => {
    if (user && profile && profile.role === 'customer') {
      setOptimisticRole('store_owner');
    }
  }, [user, profile, setOptimisticRole]);

  // ?add=1 が付いている場合は「追加登録モード」→ 既存店舗リダイレクトをスキップ
  const isAddMode = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('add') === '1'
    : false;

  // Stripe引き継ぎモード: 追加モード かつ 既存のStripeアカウントあり
  // → 本人確認・銀行口座は自動引き継ぎ。営業許可証のみ提出。
  const isInherited = isAddMode && hasExistingStripeAccount;

  // ★ draft はマウント時に1回だけ読む (再レンダリングで読み直さない)
  const obDraftRef = useRef<Partial<OnboardingDraft> | null>(null);
  if (obDraftRef.current === null) obDraftRef.current = loadOnboardingDraft();
  const obDraft = obDraftRef.current;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pledgeSigned, setPledgeSigned] = useState<boolean>(obDraft.pledgeSigned ?? false);
  const [pinPos, setPinPos] = useState<{ lat: number; lng: number } | null>(
    obDraft.pinLat != null && obDraft.pinLng != null ? { lat: obDraft.pinLat, lng: obDraft.pinLng } : null
  );
  const [imagePreview, setImagePreview] = useState<string>(obDraft.imageUrl ?? '');
  const [iconPreview, setIconPreview] = useState<string>(obDraft.iconUrl ?? '');
  const [iconUploading, setIconUploading] = useState(false);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // ── 営業許可証 (2店舗目登録 = isInherited 時に必須・1店舗目は bank-setup で別途) ──
  //   画像 base64 はサーバへ送信するためにのみ保持し、 draft 保存はしない (容量回避)。
  const [bizLicensePreview, setBizLicensePreview] = useState<string>('');
  const [bizLicenseMime, setBizLicenseMime] = useState<string>('image/jpeg');
  const [bizLicenseNumber, setBizLicenseNumber] = useState<string>(obDraft.bizLicenseNumber ?? '');
  const [bizLicenseError, setBizLicenseError] = useState<string | null>(null);
  const bizLicenseInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name:          obDraft.name     ?? '',
    address:       obDraft.address  ?? '',
    city:          obDraft.city     ?? '',
    category:      obDraft.category ?? '',
    phone:         obDraft.phone    ?? '',
    imageUrl:      obDraft.imageUrl ?? '',
    iconUrl:       obDraft.iconUrl  ?? '',
  });

  // ★ ファイル input の ref (同じファイル再選択時に value をリセットするため)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const iconFileRef  = useRef<HTMLInputElement>(null);

  // ★ 初回ロード後は2度とスピナー画面に戻らない (form アンマウント = 入力消失を防ぐ)
  const hasInitializedRef = useRef(false);
  if (!storeLoading) hasInitializedRef.current = true;

  // 追加モードでない場合のみ、既存店舗があればダッシュボードへリダイレクト
  useEffect(() => {
    if (isAddMode) return;
    if (storeLoading) return;
    if (!existingStore) return;
    if (existingStore.stripeAccountId) {
      navigate('/store/dashboard');
    } else {
      navigate('/store/bank-setup');
    }
  }, [existingStore, storeLoading, navigate, isAddMode]);

  // 入力内容を自動保存（フォーム変化から1秒後）— 全フィールドを保存
  useEffect(() => {
    const t = setTimeout(() => {
      saveOnboardingDraft({
        name: form.name,
        address: form.address,
        city: form.city,
        category: form.category,
        phone: form.phone,
        imageUrl: form.imageUrl,
        iconUrl: form.iconUrl,
        pledgeSigned,
        pinLat: pinPos?.lat ?? null,
        pinLng: pinPos?.lng ?? null,
        bizLicenseNumber, // 営業許可証番号のみ保存 (画像は容量大なので除外)
      });
    }, 600);
    return () => clearTimeout(t);
  }, [form.name, form.address, form.city, form.category, form.phone, form.imageUrl, form.iconUrl, pledgeSigned, pinPos, bizLicenseNumber]);

  // 警告が表示中のとき、フィールドが埋まったら警告をリアルタイム更新
  useEffect(() => {
    if (validationWarnings.length === 0) return;
    const updated: string[] = [];
    if (!form.imageUrl)                         updated.push('店舗写真が未入力です。');
    if (!form.iconUrl)                          updated.push('店舗アイコン（地図ピン用）が未入力です。');
    if (!form.name.trim())                      updated.push('店名が未入力です。');
    if (!form.address.trim())                   updated.push('住所が未入力です。');
    if (!form.city.trim())                      updated.push('市区町村が未入力です。');
    if (!form.category)                         updated.push('ジャンルが未選択です。');
    if (!pledgeSigned)                          updated.push('利用規約への同意が未完了です。');
    if (isInherited && !bizLicensePreview)      updated.push('この店舗の営業許可証画像が未提出です。');
    if (isInherited && !bizLicenseNumber.trim()) updated.push('この店舗の営業許可証番号が未入力です。');
    setValidationWarnings(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.imageUrl, form.iconUrl, form.name, form.address, form.city, form.phone, form.category, pledgeSigned, bizLicensePreview, bizLicenseNumber, isInherited]);

  const handlePlaceSelected = (place: PlaceResult) => {
    setForm(f => ({
      ...f,
      address: place.address || '',
      city: place.city || '',
      name: f.name || place.name || '',
    }));
    if (place.lat && place.lng) setPinPos({ lat: place.lat, lng: place.lng });
  };

  // クロッパーで位置調整 → 確定後に form へ反映
  const [cropperFile, setCropperFile] = useState<File | null>(null);
  const handleImageFile = (f: File) => {
    setCropperFile(f);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── 店舗アイコン (地図ピン用) — 256x256 JPEG にリサイズしてサーバへアップロード ──
  const handleIconFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'ファイルが大きすぎます', description: '10MB 以下の画像を選択してください', variant: 'destructive' });
      return;
    }
    setIconUploading(true);
    try {
      let uploadBlob: Blob;
      try {
        uploadBlob = await resizeIconToSquare(file, 256);
      } catch (resizeErr) {
        const msg = resizeErr instanceof Error ? resizeErr.message : '画像処理エラー';
        throw new Error(`アイコンのリサイズに失敗しました (${msg})。 別の画像でお試しください。`);
      }
      if (uploadBlob.size > 1024 * 1024) {
        throw new Error('リサイズ後のサイズが想定外に大きいため中止しました。 別の画像でお試しください。');
      }
      const fd = new FormData();
      fd.append('image', uploadBlob, 'icon.jpg');
      const res = await authedFetch(`${BASE}/api/upload/bag-image`, { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { message?: string }));
        throw new Error(data.message || `送信失敗 (HTTP ${res.status})`);
      }
      const { url } = await res.json();
      setForm(prev => ({ ...prev, iconUrl: url }));
      setIconPreview(url);
    } catch (err) {
      toast({
        title: 'アイコンのアップロードに失敗しました',
        description: err instanceof Error ? err.message : '通信を確認して再度お試しください',
        variant: 'destructive',
      });
    } finally {
      setIconUploading(false);
    }
  };

  const handleIconRemove = () => {
    setForm(prev => ({ ...prev, iconUrl: '' }));
    setIconPreview('');
  };

  // ── 営業許可証ファイル選択ハンドラ ─────────────────────────────────────
  //   2店舗目登録 (isInherited=true) では必須。 PDF はそのまま、 画像は圧縮してから保持。
  //   サーバ側 (/stores/apply) の body.licenseImageBase64 に dataURL をそのまま送る。
  const handleBizLicenseFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを再選択できるよう即リセット
    if (!file) return;
    setBizLicenseError(null);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error('ファイルサイズが大きすぎます (10MB 以下にしてください)。');
      }
      if (file.type === 'application/pdf') {
        // PDF はそのまま dataURL 化 (基本的に元から軽量)
        const raw: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target?.result as string);
          reader.onerror = () => reject(new Error('PDFが読み込めませんでした。'));
          reader.readAsDataURL(file);
        });
        setBizLicenseMime('application/pdf');
        setBizLicensePreview(raw);
      } else {
        // 画像は compressImage で圧縮 (容量とアップロード速度を両立)
        const compressed = await compressImage(file);
        // compressImage の戻り値は image/jpeg 固定なので mime もそれに合わせる
        setBizLicenseMime('image/jpeg');
        setBizLicensePreview(compressed);
      }
    } catch (err: any) {
      setBizLicenseError(err?.message ?? 'ファイルを取り込めませんでした。 JPEG・PNG・PDF を選んでください。');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast({ title: 'ログインが必要です', variant: 'destructive' });
      return;
    }

    // 追加モードでない場合のみ、既存店舗があればリダイレクト（再送信ガード）
    if (!isAddMode && existingStore && !storeLoading) {
      if (existingStore.stripeAccountId) {
        navigate('/store/dashboard');
      } else {
        navigate('/store/bank-setup');
      }
      return;
    }

    // 未入力項目を収集 → ひとつでも欠けていたら送信をブロック
    const warnings: string[] = [];
    if (!form.imageUrl)                         warnings.push('店舗写真が未入力です。');
    if (!form.iconUrl)                          warnings.push('店舗アイコン（地図ピン用）が未入力です。');
    if (!form.name.trim())                      warnings.push('店名が未入力です。');
    if (!form.address.trim())                   warnings.push('住所が未入力です。');
    if (!form.city.trim())                      warnings.push('市区町村が未入力です。');
    if (!form.category)                         warnings.push('ジャンルが未選択です。');
    if (!pledgeSigned)                          warnings.push('利用規約への同意が未完了です。');
    // ★ 住所の構造チェック (適当入力ブロック) — server 側 /stores/apply と完全に同じルール
    //   「大阪府大阪市旭区」 のような市レベルのみの入力を UX 良く事前にブロックする。
    {
      const addr = form.address.trim();
      const hasDigit = /[0-9０-９一二三四五六七八九十]/.test(addr);
      const hasStruct = /(丁目|番地|番|号|号室|階|F|f|[0-9０-９]\s*[\-－‐ー][0-9０-９])/.test(addr);
      if (addr && (addr.length < 10 || !hasDigit || !hasStruct)) {
        warnings.push('住所が不正です。 番地・建物名まで正確に入力してください (例: 大阪府大阪市旭区○○町1-2-3 ○○ビル1階)。');
      }
    }
    // ★ 位置情報 (pinPos) 必須 — Google Places から座標を取得しない手書き入力を防ぐ
    if (!pinPos) {
      warnings.push('位置情報が取得できていません。 検索ボックスからお店を選び直してください。');
    }
    // ★ 2店舗目登録 (引き継ぎモード) では営業許可証は必須
    if (isInherited && !bizLicensePreview)      warnings.push('この店舗の営業許可証画像が未提出です。');
    if (isInherited && !bizLicenseNumber.trim()) warnings.push('この店舗の営業許可証番号が未入力です。');
    // ★ 営業許可証番号フォーマット検証 (server 側と同等)
    if (isInherited && bizLicenseNumber.trim()) {
      const norm = bizLicenseNumber.trim().normalize('NFKC');
      const digits = norm.replace(/[^0-9]/g, '');
      if (norm.length < 5 || digits.length < 4) {
        warnings.push('営業許可証番号の形式が正しくありません。 通常10桁前後の番号です (例: 第123456号、 大阪市1234567号)。');
      }
    }
    setValidationWarnings(warnings);
    if (warnings.length > 0) return;
    if (!user.id) {
      toast({ title: 'ログイン情報を取得できませんでした', description: 'いったんログアウトして再度ログインしてください。', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      // ★ authedFetch を使用 — Bearer トークン (Supabase session) を自動付与
      //    素の fetch だと requireAuth が 401「ログインが必要です」 を返してしまう
      const res = await authedFetch(`${BASE}/api/stores/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ownerId: user.id,
          name: form.name.trim(),
          address: form.address.trim(),
          city: form.city.trim(),
          category: form.category,
          phone: form.phone.trim() || null,
          imageUrl: form.imageUrl || null,
          iconUrl: form.iconUrl || null,
          lat: pinPos?.lat ?? null,
          lng: pinPos?.lng ?? null,
          pledgeSigned: true,
          // ★ 2店舗目登録時 (isInherited): 営業許可証 (画像 dataURL + 番号) を送信。
          //    1店舗目では bank-setup で別途送るので onboarding では送らない。
          licenseImageBase64: isInherited && bizLicensePreview ? bizLicensePreview : undefined,
          licenseNumber: isInherited && bizLicenseNumber.trim() ? bizLicenseNumber.trim() : undefined,
        }),
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 404 || res.status === 503 || res.status === 502) {
          throw new Error('サーバーに接続できませんでした。少し時間をおいて再度お試しください。');
        }
        // ★ 409 license_duplicate: 営業許可証番号の重複 (自店舗 / 他店舗どちらも)
        //    食品衛生法上 1施設1番号原則 → 別の正しい番号を入力してもらう
        if (res.status === 409 && body?.error === 'license_duplicate') {
          console.warn('[StoreOnboarding] 営業許可証番号 重複', body);
          toast({
            title: 'この営業許可証番号は使用できません',
            description:
              body?.message ||
              'この営業許可証番号は既に登録されています。 番号にお間違いがないかご確認ください。',
            variant: 'destructive',
          });
          // draft / 画面状態は保持 (番号だけ修正して再送信できるように)
          return;
        }
        // ★ 409 self_duplicate: 同オーナが同じ店名+住所を二重登録しようとした場合
        //    → トーストで通知 + draft クリア + 既存店舗リスト (マイページ) へ戻す
        if (res.status === 409 && body?.error === 'self_duplicate') {
          console.warn('[StoreOnboarding] 自己重複 — 既存店舗へ戻ります', body);
          toast({
            title: 'すでに登録されているお店です',
            description:
              body?.message ||
              '同じ店名・住所のお店が既に登録されています。 マイページの「所有店舗」 から既存のお店をご確認ください。',
            variant: 'destructive',
          });
          clearOnboardingDraft();
          try { refetchStores(); } catch (_) {}
          navigate('/mypage');
          return;
        }
        const msg = body?.message || body?.error || `登録に失敗しました（HTTP ${res.status}）`;
        throw new Error(msg);
      }

      // ★ レスポンス本文取得 (JSON 失敗時はテキストでフォールバック → 原因特定ログ)
      const rawText = await res.text().catch(() => '');
      let responseBody: any = null;
      try { responseBody = JSON.parse(rawText); } catch { /* JSON でない */ }

      if (!responseBody?.id) {
        console.error('[StoreOnboarding] ❌ 登録レスポンスに id がない:', { status: res.status, contentType: res.headers.get('content-type'), bodyPreview: rawText.slice(0, 200) });
        // ★ サーバー側では INSERT 成功している可能性が高い (JSON経路の問題のみ) → 即座に確認
        try {
          const check = await authedFetch(`${BASE}/api/stores/by-owner?userId=${encodeURIComponent(user.id)}`, { cache: 'no-store' });
          if (check.ok) {
            const checkStore = await check.json().catch(() => null);
            if (checkStore?.id) {
              console.log('[StoreOnboarding] ✅ 確認: 店舗は実際には作成されている → 続行');
              clearOnboardingDraft();
              refetchStores();
              // ★ サーバ側で users.role=store_owner に更新済み。
              //   refreshProfile() は 2s タイムアウトで失敗する可能性があるため、
              //   キャッシュ (localStorage) にも先に store_owner を書き込んで
              //   次回コールドスタート時に「メンバー」表示にならないよう保証する。
              setOptimisticRole('store_owner', true);
              try { await refreshProfile(); } catch (_) {}
              if (isInherited) {
                toast({
                  title: '審査リクエストを送信しました',
                  description: '管理者の承認後、 公開・出品が可能になります (通常 1〜2 営業日)。',
                });
                navigate('/mypage');
              } else {
                navigate('/store/bank-setup');
              }
              return;
            }
          }
        } catch (recoverErr) {
          console.warn('[StoreOnboarding] 復旧チェック失敗:', recoverErr);
        }
        toast({
          title: '登録が完了しませんでした',
          description: 'データの保存を確認できませんでした。再度お試しください。',
          variant: 'destructive',
        });
        return;
      }

      clearOnboardingDraft();

      // 店舗リストを即時更新してから遷移する
      refetchStores();
      // ★ サーバ側で users.role=store_owner に更新済み。
      //   refreshProfile() は 2s タイムアウトで失敗する可能性があるため、
      //   キャッシュ (localStorage) にも先に store_owner を書き込んで
      //   次回コールドスタート時に「メンバー」表示にならないよう保証する。
      setOptimisticRole('store_owner', true);
      // ★ DB の users.role が server 側で store_owner に更新されているので profile を再取得
      try { await refreshProfile(); } catch (_) {}

      if (isInherited) {
        // ★ Stripe 再有効化フロー: 引き継いだ既存アカウントが charges_enabled=false の場合、
        //    bank-setup に誘導して再有効化を促す。 そうでなければマイページへ。
        if (responseBody?.requiresStripeReauth === true) {
          toast({
            title: '決済設定の更新が必要です',
            description:
              '銀行口座 / 本人確認の情報を更新する必要があります。 続けて手続きを行ってください。',
          });
          navigate('/store/bank-setup');
        } else {
          // Stripe 引き継ぎ正常 → bank-setup スキップ → マイページへ
          toast({
            title: '審査リクエストを送信しました',
            description: '管理者の承認後、 公開・出品が可能になります (通常 1〜2 営業日)。',
          });
          navigate('/mypage');
        }
      } else {
        // 初回登録 → bank-setup へ
        navigate('/store/bank-setup');
      }
    } catch (err: unknown) {
      clearTimeout(timeout);

      if (err instanceof Error && err.name === 'AbortError') {
        console.warn('[StoreOnboarding] タイムアウト — 店舗作成を確認中...');
        try {
          const check = await authedFetch(`${BASE}/api/stores/by-owner?userId=${encodeURIComponent(user.id)}`, { cache: 'no-store' });
          if (check.ok) {
            const checkStore = await check.json().catch(() => null);
            clearOnboardingDraft();
            refetchStores();
            // ★ 店舗作成は完了している (サーバ側で users.role=store_owner 更新済)
            //   キャッシュにも store_owner を書き込み、 次回起動時に「メンバー」 表示にならないよう保証
            if (checkStore?.id) setOptimisticRole('store_owner', true);
            if (isInherited) {
              navigate('/mypage');
            } else {
              navigate(checkStore?.stripeAccountId ? '/store/dashboard' : '/store/bank-setup');
            }
            return;
          }
        } catch (_) {}
        toast({ title: 'サーバーへの接続がタイムアウトしました', description: 'ネットワーク状況を確認して、もう一度お試しください。', variant: 'destructive' });
      } else {
        console.warn('[StoreOnboarding] apply error:', err);
        toast({
          title: '登録に失敗しました',
          description: err instanceof Error ? err.message : '時間をおいて再度お試しください。',
          variant: 'destructive',
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ★ 初回ロードのみスピナーを表示。以降は refetch 中でも form をアンマウントしない
  //    (storeLoading が true → false → true で form が消える = 入力が消える バグの根本対策)
  if (storeLoading && !hasInitializedRef.current) {
    return (
      <Layout showBottomNav={false} hideHeader={true}>
        <div className="flex-1 flex items-center justify-center min-h-dvh">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout showBottomNav={false} hideHeader={true}>
      <div className="w-full max-w-xl md:max-w-3xl mx-auto px-4 py-6">

        {/* ヘッダー */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => {
              // ── 戻るボタン: 登録を「一旦中断」して戻る ──
              //
              // ★ ロールは絶対に変更しない (customer に降格しない)。
              //   過去にここで customer 降格していたため、 戻るボタンを押すと
              //   マイページで「メンバー」 表示になるバグの原因だった。
              //
              //   旧コードで降格が必要だった理由: Home.tsx が store_owner を
              //   問答無用で /store/dashboard に送り、 店舗ゼロだとそこから
              //   /store-onboarding に再送される無限ループ対策。
              //   → 今は Home.tsx 側で「店舗ゼロの store_owner はリダイレクト
              //     しない」 修正を入れたので、 ここで降格する必要がなくなった。
              //
              // 遷移先:
              //   - 追加モード or Stripe 完成済店舗あり → /store/dashboard
              //   - それ以外 (新規/未完成) → /mypage (バナーから再開可能)
              //
              // ★★ sessionStorage の pending フラグ取り扱い (重要):
              //   - 既存店舗あり (DB role=store_owner 確定) → フラグはクリアしない。
              //     クリアしてしまうと、 直後の fetchProfile (TOKEN_REFRESHED 等) が
              //     DB から一時的に customer を返した場合にクランプが効かず、
              //     in-memory profile が customer に化けて MyPage 下タブが
              //     お客さん側 (ホーム/お気に入り/マイページ) に切り替わる。
              //     これがユーザ報告の「戻るボタン押すとユーザー側になる」 バグの真因。
              //   - 既存店舗なし (= 真の新規登録中断) → DB は本当に customer なので
              //     フラグをクリアして customer 表示に戻す (アプリ全体の整合性のため)。
              //
              // ドラフト (localStorage) は保持 → MyPage バナーから再開可能。
              // 「真の新規登録中断」 と判定できるのは、 既存店舗が無く、 かつ
              // 現在の profile.role も store_owner ではない場合のみ。
              // useMyStores が読み込み中の場合や、 既に store_owner として
              // ログイン済みの場合は、 フラグをクリアしない (店舗側 UI を維持)。
              const hasAnyStore = !storeLoading && !!existingStore;
              const isAlreadyStoreOwner = profile?.role === 'store_owner';
              const profileLoaded = profile !== null && profile !== undefined;
              const isTrueNewAbort = profileLoaded && !storeLoading && !hasAnyStore && !isAlreadyStoreOwner;
              const flagBefore = (() => { try { return sessionStorage.getItem('osusowake_pending_store_owner_v1'); } catch { return null; } })();
              // eslint-disable-next-line no-console
              console.log('[onb-back] clicked', { profileRole: profile?.role ?? null, profileLoaded, storeLoading, hasAnyStore, isAlreadyStoreOwner, isTrueNewAbort, flagBefore, at: new Date().toLocaleTimeString() });
              if (isTrueNewAbort) {
                try {
                  sessionStorage.removeItem('osusowake_pending_store_owner_v1');
                } catch (_) { /* ignore */ }
                // eslint-disable-next-line no-console
                console.log('[onb-back] PENDING flag cleared!');
              }

              const isRealCompletedStore =
                !storeLoading && !!existingStore && !!existingStore.stripeAccountId;
              if (isAddMode || isRealCompletedStore) {
                navigate('/store/dashboard', { replace: true });
              } else {
                navigate('/mypage', { replace: true });
              }
            }}
            className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black">{isAddMode ? '店舗を追加する' : 'お店を登録する'}</h1>
            <p className="text-xs text-muted-foreground">
              {isInherited ? '営業許可証のみ提出してください' : 'おすそわけに参加して、フードロスを減らしましょう'}
            </p>
          </div>
        </div>

        {/* 引き継ぎバナー（追加モード＋Stripe済みの場合） */}
        {isInherited && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-5 bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex gap-3"
          >
            <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-black text-emerald-800">本人確認・口座情報は引き継がれます</p>
              <p className="text-xs text-emerald-700 mt-0.5 leading-relaxed">
                1店舗目で登録済みの免許証・銀行口座は、この店舗にも自動的に紐付けられます。
                <strong>営業許可証だけ</strong>この店舗のものをアップロードしてください。
              </p>
            </div>
          </motion.div>
        )}

        <motion.form
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          onSubmit={handleSubmit}
          noValidate
          className="space-y-5"
        >
          {/* 料金案内（初回のみ） */}
          {!isInherited && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex gap-3 text-sm">
              <Leaf className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-black text-foreground">完全成果報酬型</div>
                <div className="text-muted-foreground">初期費用・月額0円。売れた分だけ手数料20%</div>
              </div>
            </div>
          )}

          {/* 店舗写真 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-2">
              店舗写真 <span className="text-destructive">*</span>
            </label>
            <label className="block cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleImageFile(file);
                }}
              />
              <div className={`relative w-full aspect-video rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 overflow-hidden transition-all
                ${imagePreview ? 'border-primary/40' : 'border-red-300 bg-red-50/40 hover:border-primary/40 hover:bg-primary/5'}`}>
                {imagePreview ? (
                  <img loading="lazy" decoding="async" src={imagePreview} alt="" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-2xl">📷</div>
                    <span className="text-sm font-bold text-muted-foreground">タップして写真を追加</span>
                    <span className="text-xs text-muted-foreground/60">JPG・PNG・HEIC対応</span>
                  </>
                )}
              </div>
            </label>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
              店舗詳細・商品カードのトップに表示されます。
            </p>
          </div>

          {/* 店舗アイコン (地図ピン用) — 必須 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-2 flex items-center gap-1.5">
              <MapPinned className="w-4 h-4 text-primary" />
              店舗アイコン <span className="text-destructive">*</span>
            </label>
            <input
              ref={iconFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleIconFile}
            />
            <div
              className={`flex items-center gap-4 p-4 rounded-2xl border-2 border-dashed transition-all
              ${iconPreview ? 'border-primary/40 bg-white' : 'border-red-300 bg-red-50/40'}`}
            >
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => iconFileRef.current?.click()}
                  disabled={iconUploading}
                  className="w-20 h-20 rounded-full overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100 border-2 border-primary/30 shadow-sm flex items-center justify-center hover:scale-105 active:scale-95 transition-transform disabled:opacity-60"
                  aria-label="アイコンを選ぶ"
                >
                  {iconPreview ? (
                    <img loading="lazy" decoding="async" src={iconPreview} alt="店舗アイコン" className="w-full h-full object-cover" />
                  ) : iconUploading ? (
                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  ) : (
                    <Camera className="w-6 h-6 text-primary" />
                  )}
                </button>
                {iconPreview && !iconUploading && (
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
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-foreground">
                  {iconPreview ? 'アイコンを設定しました' : 'アイコンを選んでください'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  マップのアイコンにも表示されます。お店のロゴや看板写真がおすすめです（正方形・512×512px 推奨）。
                </p>
                <button
                  type="button"
                  onClick={() => iconFileRef.current?.click()}
                  disabled={iconUploading}
                  className="mt-2 text-xs font-bold text-primary hover:underline disabled:opacity-60"
                >
                  {iconUploading ? 'アップロード中…' : iconPreview ? 'アイコンを変更' : 'アイコンを選ぶ'}
                </button>
              </div>
            </div>
          </div>

          {/* 店名 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-1.5">
              店名 <span className="text-destructive">*</span>
            </label>
            <input
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-background border border-input rounded-xl px-4 py-3.5 font-bold text-base focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none transition-all"
              placeholder="例: 幸福堂ベーカリー"
            />
          </div>

          {/* 地図検索 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-2">
              お店の場所
              {pinPos && <span className="text-xs font-normal ml-2 text-emerald-600">✓ 位置を取得しました</span>}
            </label>
            <PlaceSearchMap
              lat={pinPos?.lat}
              lng={pinPos?.lng}
              onPlace={handlePlaceSelected}
              onPinMove={(lat, lng) => setPinPos({ lat, lng })}
            />
          </div>

          {/* 住所 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-1.5">
              住所 <span className="text-destructive">*</span>
            </label>
            <input
              required
              value={form.address}
              onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
              className="w-full bg-background border border-input rounded-xl px-4 py-3.5 font-medium text-base focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none transition-all"
              placeholder="検索すると自動入力されます"
            />
          </div>

          {/* 市区町村 */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-1.5">
              市区町村 <span className="text-destructive">*</span>
            </label>
            <input
              required
              value={form.city}
              onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
              className="w-full bg-background border border-input rounded-xl px-4 py-3.5 font-medium text-base focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none transition-all"
              placeholder="例: 高槻市"
            />
          </div>

          {/* 店舗電話番号 (任意) */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-1.5">
              店舗電話番号 <span className="text-muted-foreground/60 font-normal">（任意）</span>
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              className="w-full bg-background border border-input rounded-xl px-4 py-3.5 font-medium text-base focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none transition-all"
              placeholder="例: 072-639-9628"
              inputMode="tel"
            />
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              入力されている場合は決済審査・トラブル対応の連絡先として使用します。空欄でも申請できます。
            </p>
          </div>

          {/* ジャンル */}
          <div>
            <label className="block text-sm font-bold text-muted-foreground mb-2">
              ジャンル <span className="text-destructive">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, category: opt.value }))}
                  className={`py-3 px-2 rounded-xl border-2 font-bold text-sm flex flex-col items-center gap-1 transition-all active:scale-95
                    ${form.category === opt.value ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card hover:border-primary/40'}`}
                >
                  <span className="text-2xl">{opt.emoji}</span>
                  <span className="text-xs">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── 営業許可証 (2店舗目登録時のみ必須) ──────────────────────────── */}
          {isInherited && (
            <div className="bg-orange-50/60 border border-orange-200 rounded-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-orange-500" />
                <h3 className="font-black text-foreground">営業許可証 <span className="text-destructive">*</span></h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                この店舗の営業許可証を提出してください。 食品衛生法に基づく許可証の画像 (または PDF) と許可証番号が必須です。
              </p>

              <input
                ref={bizLicenseInputRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={handleBizLicenseFile}
              />

              <button
                type="button"
                onClick={() => bizLicenseInputRef.current?.click()}
                className={`relative w-full aspect-video rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 overflow-hidden transition-colors ${
                  bizLicensePreview
                    ? 'border-orange-400 bg-orange-50'
                    : 'border-red-300 bg-red-50/40 hover:border-orange-300 hover:bg-orange-50'
                }`}
              >
                {bizLicensePreview ? (
                  bizLicenseMime === 'application/pdf' ? (
                    <>
                      <FileText className="w-12 h-12 text-orange-500" />
                      <span className="text-sm font-bold text-orange-700">PDF を読み込みました</span>
                      <span className="text-xs text-muted-foreground">タップして変更</span>
                    </>
                  ) : (
                    <>
                      <img loading="lazy" decoding="async" src={bizLicensePreview} alt="営業許可証プレビュー" className="absolute inset-0 w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center gap-1">
                        <Camera className="w-7 h-7 text-white opacity-80" />
                        <span className="text-sm text-white font-bold">タップして変更</span>
                      </div>
                    </>
                  )
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center">
                      <FileText className="w-6 h-6 text-orange-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-bold text-gray-600">タップして書類を追加</p>
                      <p className="text-xs text-gray-400 mt-0.5">JPG・PNG・HEIC・PDF 対応</p>
                    </div>
                  </>
                )}
              </button>

              {bizLicenseError && (
                <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {bizLicenseError}
                </p>
              )}

              <div>
                <label className="block text-sm font-bold text-muted-foreground mb-1.5">
                  営業許可証番号 <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={bizLicenseNumber}
                  onChange={e => setBizLicenseNumber(e.target.value)}
                  className="w-full bg-background border border-input rounded-xl px-4 py-3 text-base font-medium focus:ring-2 focus:ring-orange-400/40 focus:border-orange-400 outline-none transition-all"
                  placeholder="例: 第○○号"
                />
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                  許可証に記載された番号を入力してください。
                </p>
              </div>
            </div>
          )}

          {/* 誓約チェック */}
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5">
            <div className="flex items-start gap-3">
              <div
                onClick={() => setPledgeSigned(v => !v)}
                className={`mt-0.5 shrink-0 w-6 h-6 rounded-lg border-2 flex items-center justify-center cursor-pointer transition-all
                  ${pledgeSigned ? 'bg-primary border-primary' : 'bg-background border-border hover:border-primary/60'}`}
              >
                {pledgeSigned && <CheckCircle2 className="w-4 h-4 text-primary-foreground" />}
              </div>
              <div
                className="text-sm leading-relaxed text-foreground cursor-pointer"
                onClick={() => setPledgeSigned(v => !v)}
              >
                <span className="font-black block mb-1">出店者規約・利用規約への同意 <span className="text-destructive">*</span></span>
                食品衛生法を遵守し、営業許可証に基づいて営業していることを誓約します。また、おすそわけの
                <a
                  href="/merchant-terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary font-bold underline underline-offset-2 mx-0.5"
                >出店者規約</a>
                および
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary font-bold underline underline-offset-2 mx-0.5"
                >利用規約</a>
                に同意の上、申請します。
              </div>
            </div>
          </div>

          {/* 未入力警告パネル */}
          <AnimatePresence>
            {validationWarnings.length > 0 && (
              <motion.div
                key="validation-warnings"
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3.5"
              >
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  <span className="text-sm font-black text-amber-700">入力内容をご確認ください</span>
                </div>
                <ul className="space-y-1">
                  {validationWarnings.map((msg, i) => (
                    <li key={i} className="text-sm text-amber-700 flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5">・</span>
                      <span>{msg}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 送信ボタン */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-primary text-primary-foreground font-black text-lg py-4 rounded-2xl flex items-center justify-center gap-2 shadow-lg shadow-primary/25 hover:bg-primary/90 active:scale-[0.99] transition-all disabled:opacity-70 min-h-[56px]"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                登録中...
              </>
            ) : isInherited ? (
              '店舗を登録する →'
            ) : (
              '登録して口座設定へ →'
            )}
          </button>

          <p className="text-center text-xs text-muted-foreground pb-4">
            {isInherited
              ? '口座・本人確認は1店舗目の情報を引き継ぎます'
              : '登録後すぐに口座情報の入力へ進みます'}
          </p>
        </motion.form>
      </div>
      {cropperFile && (
        <ImageCropper
          file={cropperFile}
          aspect={2}
          onCancel={() => setCropperFile(null)}
          onConfirm={async (dataUrl) => {
            // ★ 即仮プレビュー（アップロード中の体感を良くする）
            setImagePreview(dataUrl);
            setCropperFile(null);
            // ★ data: URL のまま DB に保存すると API 側で NULL に潰されて iconUrl にフォールバック
            //   されてしまい、アイコンと店舗写真が同じ URL になる不具合の原因になる。
            //   アイコンと同様に Supabase Storage へアップロードして正規 URL を取得する。
            try {
              const blob = await (await fetch(dataUrl)).blob();
              if (blob.size > 5 * 1024 * 1024) {
                throw new Error('リサイズ後のサイズが想定外に大きいため中止しました。');
              }
              const fd = new FormData();
              fd.append('image', blob, 'store-image.jpg');
              const res = await authedFetch(`${BASE}/api/upload/bag-image`, { method: 'POST', body: fd });
              if (!res.ok) {
                const data = await res.json().catch(() => ({} as { message?: string }));
                throw new Error(data.message || `送信失敗 (HTTP ${res.status})`);
              }
              const { url } = await res.json();
              setForm(prev => ({ ...prev, imageUrl: url }));
              setImagePreview(url);
            } catch (err) {
              toast({
                title: '店舗写真のアップロードに失敗しました',
                description: err instanceof Error ? err.message : '通信を確認して再度お試しください',
                variant: 'destructive',
              });
              // 失敗時はプレビューと imageUrl をクリアして、ユーザに再アップを促す
              setImagePreview('');
              setForm(prev => ({ ...prev, imageUrl: '' }));
            }
          }}
        />
      )}
    </Layout>
  );
}
