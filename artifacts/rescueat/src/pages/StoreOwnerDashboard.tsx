import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation, Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import { normalizeBrand } from '@/lib/brand-text';
import { StoreLayout } from '@/components/StoreLayout';
import { getBagStatus } from '@/components/BagManageCard';
import {
  Store, Package, LogOut, RefreshCw, Loader2, AlertCircle,
  ChevronRight, TrendingUp, ShoppingBag, PlusCircle,
  Minus, Plus, Power, BarChart3, Zap, ShieldAlert,
  CreditCard, ExternalLink, Clock, XCircle, FileCheck, ShieldCheck,
  Users, Calendar, ChevronDown, ChevronUp, CheckCircle2,
} from 'lucide-react';

// ── キャッシュユーティリティ ──────────────────────────────────────────
function readCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > maxAgeMs) return null;
    return data as T;
  } catch { return null; }
}
function writeCache(key: string, data: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

interface StoreData {
  id: number;
  name: string;
  address: string | null;
  status: string;
  isActive: boolean;
  stripeAccountId: string | null;
  rejectionReason?: string | null;
}

interface BagData {
  id: number;
  title: string;
  discountedPrice: number;
  originalPrice: number;
  stockCount: number;
  isActive: boolean;
  pickupStart: string | null;
  pickupEnd: string | null;
  createdAt: string;
}

interface TodaySales {
  gross: number;
  platformFee: number;
  net: number;
  count: number;
  connected: boolean;
}

interface TodayReservation {
  id: number;
  status: string;
  quantity: number;
  totalPrice: number;
  pickupCode: string | null;
  createdAt: string;
  bag: {
    title: string;
    pickupStart: string | null;
    pickupEnd: string | null;
  };
}

interface ConnectRequirements {
  currentlyDue: string[];
  eventuallyDue: string[];
  errors: { code: string; reason: string; requirement: string }[];
  pendingVerification: string[];
  disabledReason: string | null;
}

interface ConnectStatus {
  connected: boolean;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  accountId?: string;
  requirements?: ConnectRequirements;
}

function translateRequirement(key: string): string {
  const map: Record<string, string> = {
    'individual.first_name': '代表者名（名）',
    'individual.last_name': '代表者名（姓）',
    'individual.first_name_kana': '代表者名カナ（名）',
    'individual.last_name_kana': '代表者名カナ（姓）',
    'individual.dob.day': '生年月日（日）',
    'individual.dob.month': '生年月日（月）',
    'individual.dob.year': '生年月日（年）',
    'individual.address_kanji.postal_code': '住所（郵便番号）',
    'individual.address_kanji.state': '住所（都道府県）',
    'individual.address_kanji.city': '住所（市区町村）',
    'individual.address_kanji.town': '住所（町名・番地）',
    'individual.verification.document': '本人確認書類',
    'individual.verification.document.front': '本人確認書類（表面）',
    'individual.verification.document.back': '本人確認書類（裏面）',
    'individual.verification.additional_document': '営業許可証',
    'individual.verification.additional_document.front': '営業許可証（表面）',
    'individual.verification.additional_document.back': '営業許可証（裏面）',
    'external_account': '振込先口座（銀行口座）',
    'business_profile.product_description': '事業内容の説明',
    'business_profile.url': 'ウェブサイトURL',
    'tos_acceptance.date': '利用規約への同意',
    'company.verification.document': '法人確認書類',
    'company.verification.document.front': '法人確認書類（表面）',
    'individual.id_number': 'マイナンバー / 法人番号',
    'business_type': '事業形態',
  };
  const normalized = key.replace(/\[([^\]]+)\]/g, '.$1');
  return map[normalized] ?? map[key] ?? key;
}

function GuardScreen({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-background px-6 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
        <AlertCircle className="w-8 h-8 text-muted-foreground" />
      </div>
      <p className="text-foreground font-bold mb-2">{message}</p>
      {children}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative w-14 h-7 rounded-full transition-colors duration-300 focus:outline-none ${
        checked ? 'bg-primary' : 'bg-muted-foreground/30'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      aria-checked={checked}
      role="switch"
    >
      <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform duration-300 ${
        checked ? 'translate-x-7' : 'translate-x-0'
      }`} />
    </button>
  );
}

function nowTimeStr() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
}
// ★ 出品管理ページ (StoreBagsPage) と同一の判定ロジックを使用。
//    旧実装は `pickupEnd < nowTimeStr()` のみで深夜またぎ・出品日を考慮しておらず、
//    日付が変わった直後にダッシュボードと出品管理で件数が食い違うバグになっていた。
function isBagExpired(bag: BagData): boolean {
  return getBagStatus(bag, new Date()) === 'expired';
}
function isToday(dateStr: string): boolean {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
  } catch { return false; }
}

export default function StoreOwnerDashboard() {
  const { user, profile, isLoading: authLoading, signOut } = useAuth();
  const [, navigate] = useLocation();

  const [store, setStore] = useState<StoreData | null | undefined>(undefined);
  const [bags, setBags] = useState<BagData[]>([]);
  const [todaySales, setTodaySales] = useState<TodaySales | null>(null);
  const [salesError, setSalesError] = useState(false);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [todayReservations, setTodayReservations] = useState<TodayReservation[]>([]);
  const [accountLinkLoading, setAccountLinkLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const [loadingStore, setLoadingStore] = useState(true);
  const [loadingBags, setLoadingBags] = useState(false);
  const [loadingSales, setLoadingSales] = useState(false);
  const [loadingReservations, setLoadingReservations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [emergencyStopping, setEmergencyStopping] = useState(false);
  const [emergencyStopped, setEmergencyStopped] = useState(false);

  const [flashGreen, setFlashGreen] = useState<Set<number>>(new Set());
  const flashTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const triggerFlash = (bagId: number) => {
    setFlashGreen(prev => new Set(prev).add(bagId));
    const existing = flashTimers.current.get(bagId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      setFlashGreen(prev => { const s = new Set(prev); s.delete(bagId); return s; });
      flashTimers.current.delete(bagId);
    }, 1200);
    flashTimers.current.set(bagId, t);
  };

  const fetchStore = useCallback(async (userId: string) => {
    const cacheKey = `sod_store_v1_${userId}`;
    const cached = readCache<StoreData>(cacheKey, 10 * 60 * 1000);
    if (cached) {
      setStore(cached);
      setLoadingStore(false);
      authedFetch(`/api/stores/by-owner?userId=${userId}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setStore(d); writeCache(cacheKey, d); } })
        .catch(() => {});
      return cached;
    }
    try {
      const res = await authedFetch(`/api/stores/by-owner?userId=${userId}`);
      if (res.status === 404) { setStore(null); return null; }
      if (!res.ok) throw new Error('店舗情報の取得に失敗しました');
      const data = await res.json();
      setStore(data);
      writeCache(cacheKey, data);
      return data as StoreData;
    } catch (err: any) {
      setError(err.message);
      setStore(null);
      return null;
    } finally {
      setLoadingStore(false);
    }
  }, []);

  const fetchBags = useCallback(async (storeId: number, silent = false) => {
    const cacheKey = `sod_bags_v1_${storeId}`;
    const cached = readCache<BagData[]>(cacheKey, 60 * 1000);
    if (cached && !silent) {
      setBags(cached);
      authedFetch(`/api/stores/${storeId}/bags`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setBags(d); writeCache(cacheKey, d); } })
        .catch(() => {});
      return;
    }
    if (!silent) setLoadingBags(true);
    try {
      const res = await authedFetch(`/api/stores/${storeId}/bags`);
      if (!res.ok) throw new Error('商品の取得に失敗しました');
      const data = await res.json();
      setBags(data);
      writeCache(cacheKey, data);
    } catch (err: any) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoadingBags(false);
    }
  }, []);

  const fetchTodaySales = useCallback(async (storeId: number, silent = false) => {
    const cacheKey = `sod_sales_v1_${storeId}`;
    const cached = readCache<TodaySales>(cacheKey, 30 * 1000);
    if (cached) {
      setTodaySales(cached);
      if (!silent) setLoadingSales(false);
    } else if (!silent) {
      setLoadingSales(true);
    }
    setSalesError(false);
    try {
      const res = await authedFetch(`/api/stores/${storeId}/today-sales`);
      if (res.ok) {
        const data = await res.json();
        setTodaySales(data);
        writeCache(cacheKey, data);
      } else {
        if (!cached) setSalesError(true);
      }
    } catch {
      if (!cached) setSalesError(true);
    } finally {
      if (!silent) setLoadingSales(false);
    }
  }, []);

  const fetchConnectStatus = useCallback(async (storeId: number) => {
    try {
      const res = await authedFetch(`/api/stores/${storeId}/connect/status`);
      if (res.ok) setConnectStatus(await res.json());
    } catch {}
  }, []);

  const fetchTodayReservations = useCallback(async (storeId: number, silent = false) => {
    if (!silent) setLoadingReservations(true);
    try {
      const res = await authedFetch(`/api/reservations?storeId=${storeId}`);
      if (res.ok) {
        const all = await res.json();
        const todayPending = all.filter((r: any) =>
          (r.status === 'confirmed' || r.status === 'pending') &&
          isToday(r.createdAt)
        ).map((r: any) => ({
          id: r.id,
          status: r.status,
          quantity: r.quantity,
          totalPrice: r.totalPrice,
          pickupCode: r.pickupCode,
          createdAt: r.createdAt,
          bag: {
            title: r.bag?.title ?? '不明',
            pickupStart: r.bag?.pickupStart ?? null,
            pickupEnd: r.bag?.pickupEnd ?? null,
          },
        }));
        setTodayReservations(todayPending);
      }
    } catch {}
    finally { if (!silent) setLoadingReservations(false); }
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchStore(user.id).then((s) => {
      if (s) {
        fetchBags(s.id);
        fetchTodaySales(s.id);
        fetchConnectStatus(s.id);
        fetchTodayReservations(s.id);
      }
    });
  }, [user, fetchStore, fetchBags, fetchTodaySales, fetchConnectStatus, fetchTodayReservations]);

  const handleRefresh = async () => {
    if (!store) return;
    setRefreshing(true);
    await Promise.all([
      fetchBags(store.id, false),
      fetchTodaySales(store.id, false),
      fetchConnectStatus(store.id),
      fetchTodayReservations(store.id, false),
    ]);
    setRefreshing(false);
  };

  const updateBag = useCallback(async (bagId: number, patch: Partial<{ stockCount: number; isActive: boolean }>) => {
    try {
      const res = await authedFetch(`/api/bags/${bagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('更新に失敗しました');
      const updated = await res.json();
      setBags(prev => {
        const next = prev.map(b => b.id === bagId ? { ...b, ...updated } : b);
        if (store) writeCache(`sod_bags_v1_${store.id}`, next);
        return next;
      });
      triggerFlash(bagId);
    } catch (err: any) {
      setError(err.message);
    }
  }, [store]);

  const handleStockChange = (bag: BagData, delta: number) => {
    const newCount = Math.max(0, bag.stockCount + delta);
    const autoStop = newCount === 0;
    setBags(prev => prev.map(b =>
      b.id === bag.id ? { ...b, stockCount: newCount, isActive: autoStop ? false : b.isActive } : b
    ));
    updateBag(bag.id, { stockCount: newCount, ...(autoStop ? { isActive: false } : {}) });
  };

  const handleToggleActive = (bag: BagData) => {
    const newActive = !bag.isActive;
    setBags(prev => prev.map(b => b.id === bag.id ? { ...b, isActive: newActive } : b));
    updateBag(bag.id, { isActive: newActive });
  };

  const emergencyStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEmergencyStop = async () => {
    if (bags.length === 0) return;
    setEmergencyStopping(true);
    const activeBagIds = bags.filter(b => b.isActive).map(b => b.id);
    setBags(prev => prev.map(b => ({ ...b, isActive: false })));
    await Promise.all(activeBagIds.map(id => updateBag(id, { isActive: false })));
    setEmergencyStopping(false);
    setEmergencyStopped(true);
    if (emergencyStopTimerRef.current) clearTimeout(emergencyStopTimerRef.current);
    emergencyStopTimerRef.current = setTimeout(() => setEmergencyStopped(false), 3000);
  };
  // ★ アンマウント時に全 setTimeout をクリア (リーク防止)
  useEffect(() => () => {
    if (emergencyStopTimerRef.current) clearTimeout(emergencyStopTimerRef.current);
    flashTimers.current.forEach(t => clearTimeout(t));
    flashTimers.current.clear();
  }, []);

  const handleAccountLink = useCallback(async () => {
    if (!store) return;
    setAccountLinkLoading(true);
    try {
      const currentUrl = window.location.href;
      const res = await authedFetch(`/api/stores/${store.id}/connect/account-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: currentUrl, refreshUrl: currentUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? '認証ページを取得できませんでした');
      if (data.url) window.location.href = data.url;
    } catch (err: any) {
      setError(err.message ?? '認証ページの取得に失敗しました');
      setAccountLinkLoading(false);
    }
  }, [store]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/store/login');
  };

  if (authLoading || loadingStore) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground font-medium">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!user || profile?.role !== 'store_owner') {
    return (
      <GuardScreen message="店舗オーナー専用のページです">
        <button onClick={() => navigate('/')} className="mt-4 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl font-bold text-sm">
          ホームへ
        </button>
      </GuardScreen>
    );
  }

  if (store === null) {
    return (
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center px-6 pb-16">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm md:max-w-2xl text-center space-y-5">
          <div className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center mx-auto">
            <Store className="w-10 h-10 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-foreground mb-2">店舗情報がありません</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">まだ店舗申請が完了していないか、審査中です。</p>
          </div>
          <a href="https://forms.gle/uhMoXjjF9YzkR52a6" target="_blank" rel="noopener noreferrer"
            className="w-full bg-primary text-primary-foreground font-black py-4 rounded-2xl text-base flex items-center justify-center gap-2 mb-3 active:scale-[0.98] transition-transform"
          >
            <ExternalLink className="w-4 h-4" />お問い合わせ・再申請
          </a>
          <button onClick={() => navigate('/')} className="w-full border border-border text-foreground font-bold py-3.5 rounded-2xl text-sm hover:bg-secondary/50 transition-colors">
            ホームに戻る
          </button>
        </motion.div>
      </div>
    );
  }

  if (store?.status === 'pending' || store?.status === 'pending_review' || store?.status === 'applied') {
    return (
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center px-6 pb-16">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm md:max-w-2xl text-center space-y-5">
          <div className="w-20 h-20 bg-amber-100 rounded-3xl flex items-center justify-center mx-auto">
            <Clock className="w-10 h-10 text-amber-500" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-foreground mb-2">審査中です</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">1〜2営業日以内にメールでご連絡します。もうしばらくお待ちください。</p>
          </div>
          <button onClick={() => navigate('/')} className="w-full border border-border text-foreground font-bold py-3.5 rounded-2xl text-sm">
            ホームに戻る
          </button>
        </motion.div>
      </div>
    );
  }

  if (store?.status === 'rejected') {
    return (
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center px-6 pb-16">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm md:max-w-2xl space-y-5">
          <div className="text-center">
            <div className="w-20 h-20 bg-red-100 rounded-3xl flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-10 h-10 text-red-500" />
            </div>
            <h2 className="text-2xl font-black text-foreground mb-2">申請が却下されました</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">情報を修正して再申請することができます。</p>
          </div>
          {store.rejectionReason && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
              <p className="text-xs font-black text-red-600 mb-1">却下理由</p>
              <p className="text-sm text-red-700 leading-relaxed">{store.rejectionReason}</p>
            </div>
          )}
          <Link href="/store/bank-setup"
            className="w-full bg-primary text-primary-foreground font-black py-4 rounded-2xl text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
          >
            Stripe口座を再設定する
          </Link>
        </motion.div>
      </div>
    );
  }

  // ── バッグ分類 ──
  const now = nowTimeStr();
  const activeBags   = bags.filter(b => b.isActive && b.stockCount > 0 && !isBagExpired(b));
  const expiredBags  = bags.filter(b => isBagExpired(b));
  const soldOutBags  = bags.filter(b => !isBagExpired(b) && b.stockCount === 0);
  const stoppedBags  = bags.filter(b => !isBagExpired(b) && b.isActive === false && b.stockCount > 0);
  const anyActive    = bags.some(b => b.isActive);
  const inactiveBags = [...soldOutBags, ...stoppedBags, ...expiredBags];

  const isApproved = store?.status === 'approved';

  return (
    <StoreLayout showHeader={false}>

      {/* ── ヘッダー ── */}
      <header className="sticky top-0 z-40 bg-background/90 backdrop-blur-xl border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-full max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              <Store className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="font-black text-foreground text-sm leading-tight truncate max-w-[160px]">{store?.name}</p>
              <p className="text-[10px] text-muted-foreground">店舗ダッシュボード</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={handleRefresh} disabled={refreshing}
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={handleSignOut}
              className="p-2 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="w-full max-w-2xl mx-auto px-4 py-4 space-y-4">

        {/* ── エラー ── */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="bg-destructive/10 border border-destructive/30 text-destructive text-sm font-medium px-4 py-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />{error}
              <button onClick={() => setError(null)} className="ml-auto text-lg leading-none">×</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── 緊急停止完了 ── */}
        <AnimatePresence>
          {emergencyStopped && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="bg-green-50 border border-green-300 text-green-700 text-sm font-bold px-4 py-3 rounded-xl flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />全商品を停止しました
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Stripe 認証バナー ── */}
        <AnimatePresence>
          {connectStatus !== null && !(connectStatus.detailsSubmitted && connectStatus.chargesEnabled) && !connectStatus.payoutsEnabled && (() => {
            const reqs = connectStatus.requirements;
            const currentlyDue = reqs?.currentlyDue ?? [];
            const errors = reqs?.errors ?? [];
            const pending = reqs?.pendingVerification ?? [];
            const needsDoc = currentlyDue.some(k => k.includes('verification'));
            const needsBank = currentlyDue.some(k => k.includes('external_account'));
            const needsIdentity = currentlyDue.some(k =>
              k.includes('individual.first_name') || k.includes('individual.last_name') ||
              k.includes('individual.dob') || k.includes('individual.address')
            );
            let headline = '【重要】売上の受取設定を完了してください';
            let subMessage = '';
            if (!connectStatus.connected) {
              headline = '振込先口座の登録が必要です';
              subMessage = '売上を受け取るには、まず銀行口座を登録してください。';
            } else if (errors.length > 0) {
              headline = '⚠️ 審査でエラーが発生しています';
              subMessage = errors.map(e => e.reason).join(' / ');
            } else if (pending.length > 0 && currentlyDue.length === 0) {
              headline = '⏳ Stripeが審査中です';
              subMessage = '審査が完了するまでしばらくお待ちください（通常1〜3営業日）。';
            } else if (needsDoc && needsBank) {
              headline = '⚠️ 本人確認書類と口座情報の登録が必要です';
            } else if (needsDoc) {
              headline = '⚠️ 本人確認書類をアップロードしてください';
              subMessage = '運転免許証またはマイナンバーカードの写真が必要です。';
            } else if (needsBank) {
              headline = '⚠️ 口座情報の登録が必要です';
              subMessage = '振込先の銀行口座を登録してください。';
            } else if (needsIdentity) {
              headline = '⚠️ 代表者情報の入力が必要です';
            } else if (currentlyDue.length > 0) {
              headline = `⚠️ 追加情報の入力が必要です（${currentlyDue.length}項目）`;
            }
            const isAwaitingReview = pending.length > 0 && currentlyDue.length === 0 && errors.length === 0;
            return (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className={`rounded-2xl p-4 border ${isAwaitingReview ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-300'}`}>
                <p className={`font-black text-sm mb-1 ${isAwaitingReview ? 'text-blue-700' : 'text-amber-800'}`}>{headline}</p>
                {subMessage && <p className={`text-xs mb-3 ${isAwaitingReview ? 'text-blue-600' : 'text-amber-700'}`}>{subMessage}</p>}
                {currentlyDue.length > 0 && (
                  <ul className="text-xs text-amber-700 mb-3 space-y-0.5">
                    {currentlyDue.slice(0, 5).map(k => <li key={k}>• {translateRequirement(k)}</li>)}
                    {currentlyDue.length > 5 && <li>…他{currentlyDue.length - 5}項目</li>}
                  </ul>
                )}
                {!isAwaitingReview && (
                  <button onClick={handleAccountLink} disabled={accountLinkLoading}
                    className="w-full bg-amber-500 text-white font-black py-3 rounded-xl text-sm flex items-center justify-center gap-2 hover:bg-amber-600 transition-colors disabled:opacity-60">
                    {accountLinkLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                    {accountLinkLoading ? '移動中...' : 'Stripeで設定を続ける'}
                  </button>
                )}
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* ── ① 本日の予約状況（最優先表示）── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.0 }}
          className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border/60">
            <Calendar className="w-4 h-4 text-primary" />
            <h2 className="font-black text-foreground">本日の予約状況</h2>
            {loadingReservations
              ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-1" />
              : <span className="ml-auto text-xs font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                  {todayReservations.length}件
                </span>
            }
          </div>
          {todayReservations.length === 0 ? (
            <div className="py-6 text-center px-4">
              <p className="text-sm font-bold text-muted-foreground">本日の予約はまだありません</p>
              <p className="text-xs text-muted-foreground mt-0.5">予約が入ると、ここにリアルタイムで表示されます</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {todayReservations.map(r => (
                <div key={r.id} className="px-4 py-3 flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    r.status === 'confirmed' ? 'bg-green-100' : 'bg-amber-100'
                  }`}>
                    {r.status === 'confirmed'
                      ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                      : <Clock className="w-4 h-4 text-amber-500" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-foreground truncate">{normalizeBrand(r.bag.title)}</p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
                      {r.bag.pickupStart && r.bag.pickupEnd && (
                        <span>🕐 {r.bag.pickupStart}〜{r.bag.pickupEnd}</span>
                      )}
                      <span>{r.quantity}個 · ¥{r.totalPrice.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                      r.status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {r.status === 'confirmed' ? '確定済み' : '保留中'}
                    </span>
                    {r.pickupCode && (
                      <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{r.pickupCode}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* ── ② 今日の売上カード ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
          className="bg-gradient-to-br from-primary to-primary/80 rounded-2xl p-5 text-primary-foreground shadow-lg shadow-primary/20">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary-foreground/80" />
              <span className="text-sm font-bold text-primary-foreground/80">今日の入金予定額（手数料控除後）</span>
            </div>
            {loadingSales && <Loader2 className="w-4 h-4 animate-spin text-primary-foreground/60" />}
          </div>
          {salesError ? (
            <div className="flex items-center gap-3">
              <div>
                <p className="text-2xl font-black">取得失敗</p>
                <p className="text-xs text-primary-foreground/70 mt-0.5">Stripeとの接続に一時的な問題が発生しています</p>
              </div>
              <button
                onClick={() => store && fetchTodaySales(store.id)}
                className="ml-auto shrink-0 bg-white/20 hover:bg-white/30 text-white text-xs font-bold px-3 py-2 rounded-xl transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />再取得
              </button>
            </div>
          ) : todaySales ? (
            <>
              <p className="text-4xl font-black tracking-tight mb-1">¥{todaySales.net.toLocaleString()}</p>
              <div className="flex items-center gap-4 text-xs text-primary-foreground/70 font-medium">
                <span>商品代金合計 ¥{todaySales.gross.toLocaleString()}</span>
                <span>手数料 ¥{todaySales.platformFee.toLocaleString()}</span>
                <span>{todaySales.count}件</span>
              </div>
              <p className="mt-2 text-[10px] text-primary-foreground/60 leading-relaxed">
                ※ 商品代金合計から プラットフォーム手数料 20% と Stripe決済手数料を控除した金額が、お客様への入金予定額です
              </p>
              {!todaySales.connected && (
                <div className="mt-3 bg-white/10 rounded-xl px-3 py-2 text-xs font-bold">
                  Stripe未連携のため売上データが表示できません
                </div>
              )}
            </>
          ) : (
            <div className="h-10 flex items-center">
              <p className="text-3xl font-black opacity-60">--</p>
            </div>
          )}
        </motion.div>

        {/* ── ③ KPIサマリー ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="grid grid-cols-3 gap-3">
          {[
            { label: '出品中', value: activeBags.length, icon: Package, color: 'text-primary bg-primary/10' },
            { label: '完売', value: soldOutBags.length, icon: ShoppingBag, color: 'text-orange-500 bg-orange-100' },
            { label: '停止・期限切れ', value: stoppedBags.length + expiredBags.length, icon: Power, color: 'text-muted-foreground bg-muted' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-card border border-border rounded-2xl p-3 text-center shadow-sm">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center mx-auto mb-1.5 ${color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <p className="text-2xl font-black text-foreground">{value}</p>
              <p className="text-[10px] font-bold text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </motion.div>

        {/* ── ④ 新規出品ボタン ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          {connectStatus !== null && (!connectStatus.chargesEnabled || !connectStatus.payoutsEnabled) ? (
            <div className="w-full h-14 bg-muted text-muted-foreground rounded-2xl font-black text-base flex items-center justify-center gap-2.5 opacity-60 cursor-not-allowed select-none">
              <Zap className="w-5 h-5" />
              {!connectStatus.chargesEnabled ? '決済停止中のため出品不可' : '入金停止中のため出品不可'}
            </div>
          ) : (
            <button
              onClick={() => navigate('/store/bags')}
              className="w-full h-14 bg-primary text-primary-foreground rounded-2xl font-black text-base flex items-center justify-center gap-2.5 shadow-lg shadow-primary/20 active:scale-[0.98] transition-transform"
            >
              <Zap className="w-5 h-5" />
              新しいバッグを出品する
              <ChevronRight className="w-4 h-4 ml-auto" />
            </button>
          )}
        </motion.div>

        {/* ── ⑤ 緊急停止ボタン ── */}
        <AnimatePresence>
          {isApproved && (
            <motion.button
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={handleEmergencyStop}
              disabled={emergencyStopping || !anyActive}
              className={`w-full py-4 rounded-2xl font-black text-base flex items-center justify-center gap-2.5 transition-all active:scale-[0.98] border-2 ${
                anyActive
                  ? 'bg-red-50 border-red-300 text-red-600 hover:bg-red-100'
                  : 'bg-muted border-border text-muted-foreground cursor-not-allowed'
              }`}
            >
              {emergencyStopping
                ? <><Loader2 className="w-5 h-5 animate-spin" />停止中...</>
                : <><ShieldAlert className="w-5 h-5" />緊急停止 — 全商品を一括非表示</>
              }
            </motion.button>
          )}
        </AnimatePresence>

        {/* ── ⑥ 出品中バッグ（アクティブのみ）── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-border/60">
            <BarChart3 className="w-4 h-4 text-primary" />
            <h2 className="font-black text-foreground">出品中の在庫管理</h2>
            <span className="ml-auto text-xs text-muted-foreground font-bold bg-secondary px-2 py-0.5 rounded-full">
              {activeBags.length}件
            </span>
          </div>

          {loadingBags ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
            </div>
          ) : activeBags.length === 0 ? (
            <div className="py-10 text-center px-4">
              <ShoppingBag className="w-10 h-10 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm font-bold text-muted-foreground">現在出品中の商品はありません</p>
              <p className="text-xs text-muted-foreground mt-1">「新しいバッグを出品する」から追加してください</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {activeBags.map((bag) => <BagRow key={bag.id} bag={bag} flashGreen={flashGreen} onStockChange={handleStockChange} onToggle={handleToggleActive} />)}
            </div>
          )}
        </motion.div>

        {/* ── ⑦ 完売・停止・期限切れ（折りたたみ）── */}
        {inactiveBags.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
            className="bg-card border border-border/60 rounded-2xl overflow-hidden shadow-sm">
            <button
              onClick={() => setShowInactive(v => !v)}
              className="w-full flex items-center gap-2 px-5 py-4 text-left hover:bg-secondary/30 transition-colors"
            >
              <Power className="w-4 h-4 text-muted-foreground" />
              <span className="font-black text-muted-foreground text-sm">完売・停止・期限切れ</span>
              <span className="ml-2 text-xs font-bold bg-muted text-muted-foreground px-2 py-0.5 rounded-full">{inactiveBags.length}件</span>
              <span className="ml-auto text-xs text-muted-foreground">{showInactive ? '閉じる' : '表示する'}</span>
              {showInactive ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
            </button>
            {showInactive && (
              <div className="divide-y divide-border/40 border-t border-border/40">
                {inactiveBags.map((bag) => <BagRow key={bag.id} bag={bag} flashGreen={flashGreen} onStockChange={handleStockChange} onToggle={handleToggleActive} muted />)}
              </div>
            )}
          </motion.div>
        )}

        {/* ── ⑧ 詳細機能へ ── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <button
            onClick={() => navigate('/store/dashboard')}
            className="w-full py-3.5 border-2 border-border rounded-2xl text-sm font-bold text-muted-foreground flex items-center justify-center gap-2 hover:border-primary/40 hover:text-foreground transition-colors"
          >
            <BarChart3 className="w-4 h-4" />
            分析・予約管理・詳細設定
            <ChevronRight className="w-4 h-4 ml-auto" />
          </button>
        </motion.div>
      </div>
    </StoreLayout>
  );
}

// ── バッグ行コンポーネント ─────────────────────────────────────────────
function BagRow({
  bag, flashGreen, onStockChange, onToggle, muted = false,
}: {
  bag: BagData;
  flashGreen: Set<number>;
  onStockChange: (bag: BagData, delta: number) => void;
  onToggle: (bag: BagData) => void;
  muted?: boolean;
}) {
  const isFlashing = flashGreen.has(bag.id);
  const isSoldOut  = bag.stockCount === 0;
  const isExpired  = isBagExpired(bag);

  return (
    <motion.div layout
      className={`px-4 py-4 transition-colors duration-300 ${
        muted ? 'opacity-60 bg-muted/10' :
        isSoldOut ? 'bg-orange-50/60' : ''
      }`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <p className="font-black text-foreground text-base truncate">{normalizeBrand(bag.title)}</p>
            <AnimatePresence>
              {isSoldOut && (
                <motion.span key="sold-out" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.7, opacity: 0 }}
                  className="shrink-0 text-[10px] font-black bg-orange-500 text-white px-2 py-0.5 rounded-full">
                  SOLD OUT
                </motion.span>
              )}
              {isExpired && !isSoldOut && (
                <motion.span key="expired" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.7, opacity: 0 }}
                  className="shrink-0 text-[10px] font-black bg-gray-400 text-white px-2 py-0.5 rounded-full">
                  受取時間終了
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-bold text-foreground">¥{bag.discountedPrice.toLocaleString()}</span>
            <span className="line-through ml-1.5 text-xs">¥{bag.originalPrice.toLocaleString()}</span>
            {bag.pickupStart && bag.pickupEnd && (
              <span className="ml-2 text-xs">🕐 {bag.pickupStart}〜{bag.pickupEnd}</span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <ToggleSwitch checked={bag.isActive} onChange={() => onToggle(bag)} />
          <span className="text-[9px] font-bold text-muted-foreground">
            {bag.isActive ? '出品中' : '停止中'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs font-bold text-muted-foreground w-12">残在庫</span>
        <div className="flex items-center bg-secondary rounded-2xl overflow-hidden border border-border">
          <button onClick={() => onStockChange(bag, -1)} disabled={bag.stockCount === 0}
            className="w-12 h-12 flex items-center justify-center text-foreground hover:bg-muted active:bg-muted/70 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <Minus className="w-4 h-4" />
          </button>
          <div className="w-14 text-center select-none">
            <span className={`text-2xl font-black transition-colors duration-300 ${
              isFlashing ? 'text-green-500' :
              isSoldOut ? 'text-orange-500' :
              bag.stockCount <= 2 ? 'text-orange-400' : 'text-foreground'
            }`}>{bag.stockCount}</span>
          </div>
          <button onClick={() => onStockChange(bag, +1)}
            className="w-12 h-12 flex items-center justify-center text-foreground hover:bg-muted active:bg-muted/70 transition-colors">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <span className={`text-sm font-black transition-colors duration-300 ${
          isFlashing ? 'text-green-500' :
          isSoldOut ? 'text-orange-500' :
          bag.stockCount <= 2 ? 'text-orange-400' : 'text-muted-foreground'
        }`}>{isSoldOut ? '完売' : bag.stockCount <= 2 ? '残りわずか！' : '個'}</span>
      </div>
      <AnimatePresence>
        {isSoldOut && !bag.isActive && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-[10px] font-bold text-orange-500 mt-2 flex items-center gap-1">
            ⚡ 在庫0のためユーザー側から自動的に非表示になりました
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
