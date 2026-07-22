import React, { useEffect, useState, useCallback } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, CheckCircle, XCircle, Pause, RefreshCw, Trash2, AlertTriangle,
  ExternalLink, FileWarning, Link2 as LinkIcon, Store, CreditCard, ShieldCheck, Mail,
} from 'lucide-react';
import { authedFetch } from '@/lib/authed-fetch';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

interface StripeRequirements {
  currently_due: string[];
  eventually_due: string[];
  errors: { code: string; reason: string; requirement: string }[];
  disabled_reason: string | null;
  pending_verification: string[];
  error?: string;
  message?: string;
}

interface AdminStoreDetail {
  id: number;
  name: string;
  status: string;
  is_active: boolean;
  category: string;
  address: string;
  city: string | null;
  image_url: string | null;
  owner_id: string | null;
  owner_email: string | null;
  created_at: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_payouts_enabled: boolean | null;
  stripe_license_file_id: string | null;
  stripe_requirements: StripeRequirements | null;
  show_on_map: boolean | null;
  bag_count: number;
  reservation_count: number;
  revenue: number | string;
  rejection_reason: string | null;
  description: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  open_time: string | null;
  close_time: string | null;
  holiday: string | null;
  pickup_hours: string | null;
  license_number: string | null;
  license_image_url: string | null;
  id_image_url: string | null;
  pledge_signed: boolean;
  legal_name: string | null;
  legal_representative: string | null;
  legal_address: string | null;
  legal_phone: string | null;
  legal_email: string | null;
  legal_other: string | null;
}

function fmt(n: number) {
  return new Intl.NumberFormat('ja-JP').format(n);
}

function statusBadge(status: string, isActive: boolean) {
  if (!isActive && status === 'approved') return { label: '一時停止', cls: 'bg-orange-100 text-orange-700' };
  switch (status) {
    case 'approved':       return { label: '承認済み',   cls: 'bg-emerald-100 text-emerald-700' };
    case 'pending_review':
    case 'pending':        return { label: '審査待ち',   cls: 'bg-amber-100 text-amber-700' };
    case 'applied':        return { label: '口座申請済', cls: 'bg-blue-100 text-blue-700' };
    case 'rejected':       return { label: '却下',       cls: 'bg-red-100 text-red-700' };
    case 'suspended':      return { label: '停止中',     cls: 'bg-red-100 text-red-700' };
    default:               return { label: status,       cls: 'bg-gray-100 text-gray-600' };
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-secondary/30 rounded-xl overflow-hidden">
      <div className="px-3 py-2 bg-secondary/50 border-b border-border/30">
        <p className="text-[11px] font-black text-foreground/70 uppercase tracking-wide">{title}</p>
      </div>
      <div className="px-3 py-2 space-y-1.5">{children}</div>
    </div>
  );
}

function Row({
  label, value, mono = false, multiline = false, copyable = false, link,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  multiline?: boolean;
  copyable?: boolean;
  link?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  if (!value) {
    return (
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5 min-w-[72px]">{label}</span>
        <span className="text-[11px] text-muted-foreground/40 italic">未入力</span>
      </div>
    );
  }
  async function copy() {
    await navigator.clipboard.writeText(value!);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const textEl = multiline
    ? <p className={`text-[11px] text-foreground leading-relaxed ${mono ? 'font-mono break-all' : ''}`}>{value}</p>
    : <span className={`text-[11px] text-foreground break-all ${mono ? 'font-mono' : 'font-medium'}`}>{value}</span>;
  return (
    <div className="flex items-start justify-between gap-2 min-w-0">
      <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5 min-w-[72px]">{label}</span>
      <div className="flex items-start gap-1 min-w-0 flex-1">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-blue-600 underline break-all">{value}</a>
        ) : textEl}
        {copyable && (
          <button onClick={copy}
            className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:bg-border transition-colors">
            {copied ? '✓' : 'コピー'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdminStorePage() {
  const [, params] = useRoute('/admin/store/:id');
  const [, navigate] = useLocation();
  const { user, isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const storeId = Number(params?.id);

  const [store, setStore] = useState<AdminStoreDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [syncingStripe, setSyncingStripe] = useState(false);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [linkStripeDialog, setLinkStripeDialog] = useState(false);
  const [linkStripeInput, setLinkStripeInput] = useState('');
  const [linkStripeLoading, setLinkStripeLoading] = useState(false);
  const [emailDialog, setEmailDialog] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate('/login?redirect=%2Fadmin', { replace: true }); return; }
    if (!isAdmin) { navigate('/'); return; }
  }, [authLoading, user, isAdmin, navigate]);

  const fetchDetail = useCallback(async () => {
    if (!storeId || isNaN(storeId)) { setError('無効なID'); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/detail`, { headers: {} });
      if (!res.ok) { setError('店舗が見つかりません'); return; }
      const data = await res.json();
      setStore(data);
    } catch (e: any) {
      setError(e?.message ?? 'エラー');
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => { if (user && isAdmin) fetchDetail(); }, [fetchDetail, user, isAdmin]);

  async function approveStore() {
    if (!store) return;
    setActionLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/approve`, {
        method: 'POST', headers: {},
      });
      if (res.ok) {
        toast({ title: '✅ 承認しました' });
        fetchDetail();
      } else {
        const d = await res.json();
        toast({ title: 'エラー', description: d.error, variant: 'destructive' });
      }
    } finally { setActionLoading(false); }
  }

  async function suspendStore() {
    if (!store) return;
    setActionLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/suspend`, {
        method: 'POST', headers: {},
      });
      if (res.ok) { toast({ title: '⏸ 一時停止しました' }); fetchDetail(); }
      else { const d = await res.json(); toast({ title: 'エラー', description: d.error, variant: 'destructive' }); }
    } finally { setActionLoading(false); }
  }

  async function toggleShowOnMap() {
    if (!store) return;
    const next = !store.show_on_map;
    setActionLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/show-on-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showOnMap: next }),
      });
      if (res.ok) {
        toast({ title: next ? '🗺 地図に表示しました' : '🚫 地図から非表示にしました' });
        fetchDetail();
      } else {
        const d = await res.json();
        toast({ title: 'エラー', description: d.error, variant: 'destructive' });
      }
    } finally { setActionLoading(false); }
  }

  async function rejectStore() {
    if (!store || !rejectReason.trim()) return;
    setActionLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (res.ok) {
        toast({ title: '❌ 却下しました' });
        setRejectDialog(false);
        setRejectReason('');
        fetchDetail();
      } else {
        const d = await res.json();
        toast({ title: 'エラー', description: d.error, variant: 'destructive' });
      }
    } finally { setActionLoading(false); }
  }

  async function deleteStore() {
    if (!store) return;
    // detail に既に件数が入っているので、それを確認ダイアログに反映
    const counts = [
      store.bag_count          ? `商品: ${store.bag_count}件`        : null,
      store.reservation_count  ? `予約: ${store.reservation_count}件` : null,
      (store as any).cart_reservation_count ? `カート: ${(store as any).cart_reservation_count}件` : null,
      (store as any).favorite_count    ? `お気に入り: ${(store as any).favorite_count}件` : null,
      (store as any).review_count      ? `レビュー: ${(store as any).review_count}件`    : null,
      (store as any).report_count      ? `通報: ${(store as any).report_count}件`        : null,
      (store as any).notification_count ? `通知履歴: ${(store as any).notification_count}件` : null,
    ].filter(Boolean);
    const warn = counts.length > 0
      ? `⚠️ 「${store.name}」を完全に削除します\n\n以下の関連データも全て削除されます:\n  ・${counts.join('\n  ・')}\n\nこの操作は取り消せません。本当に実行しますか？`
      : `「${store.name}」を完全に削除しますか？この操作は取り消せません。`;
    if (!window.confirm(warn)) return;

    setActionLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}`, {
        method: 'DELETE', headers: {},
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const c = data?.cascade ?? {};
        const cascadeMsg = Object.entries(c)
          .filter(([, n]) => (n as number) > 0)
          .map(([k, n]) => `${k}:${n}`).join(' ');
        toast({
          title: '🗑 削除しました',
          description: cascadeMsg ? `関連データも削除: ${cascadeMsg}` : undefined,
        });
        navigate('/admin');
      } else {
        const d = await res.json();
        toast({ title: 'エラー', description: d.error, variant: 'destructive' });
      }
    } finally { setActionLoading(false); }
  }

  async function syncStripe() {
    if (!store) return;
    setSyncingStripe(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/stripe-sync`, {
        method: 'POST', headers: {},
      });
      const data = await res.json();
      if (res.ok) {
        const fileTag = data.licenseFileId ? ' / File: ✅ 取得済み' : '';
        toast({
          title: '✅ Stripe 再同期完了',
          description: `決済: ${data.chargesEnabled ? '有効' : '制限中'} / 入金: ${data.payoutsEnabled ? '有効' : '停止中'}${fileTag}`,
        });
        fetchDetail();
      } else {
        toast({ title: 'エラー', description: data.error ?? data.message, variant: 'destructive' });
      }
    } finally { setSyncingStripe(false); }
  }

  async function linkStripe() {
    if (!store || !linkStripeInput.trim()) return;
    setLinkStripeLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/link-stripe-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripeAccountId: linkStripeInput.trim() }),
      });
      if (res.ok) {
        toast({ title: '✅ Stripe ID をリンクしました' });
        setLinkStripeDialog(false);
        setLinkStripeInput('');
        fetchDetail();
      } else {
        const d = await res.json();
        toast({ title: 'エラー', description: d.error, variant: 'destructive' });
      }
    } finally { setLinkStripeLoading(false); }
  }

  async function changeOwnerEmail() {
    if (!store || !emailInput.trim()) return;
    setEmailLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${store.id}/owner-email`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        toast({
          title: d.unchanged ? 'メールは変更されていません' : '✅ ログインメールを変更しました',
          description: d.unchanged ? undefined : `新しいメール: ${d.email}`,
        });
        setEmailDialog(false);
        setEmailInput('');
        fetchDetail();
      } else {
        toast({ title: 'エラー', description: d.message ?? d.error, variant: 'destructive' });
      }
    } finally { setEmailLoading(false); }
  }

  if (authLoading || (!user && !error)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-background pb-safe-bottom">
      {/* Lightbox */}
      <AnimatePresence>
        {lightboxImg && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setLightboxImg(null)}
          >
            <motion.img
              initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
              src={lightboxImg} alt="画像" className="max-w-full max-h-full rounded-xl shadow-2xl object-contain"
              onClick={e => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 却下ダイアログ */}
      <AnimatePresence>
        {rejectDialog && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center"
            onClick={() => setRejectDialog(false)}
          >
            <motion.div
              initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-lg md:max-w-3xl bg-background rounded-t-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-black text-foreground mb-3">却下理由を入力</h3>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                rows={4}
                placeholder="例：営業許可証と店舗名が一致していないため"
                className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm border border-border/50 focus:outline-none focus:ring-2 focus:ring-destructive/30 mb-4"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setRejectDialog(false)}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-secondary text-foreground"
                >キャンセル</button>
                <button
                  onClick={rejectStore}
                  disabled={!rejectReason.trim() || actionLoading}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-destructive text-white disabled:opacity-40"
                >
                  {actionLoading ? '処理中…' : '却下する'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stripe IDリンクダイアログ */}
      <AnimatePresence>
        {linkStripeDialog && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center"
            onClick={() => setLinkStripeDialog(false)}
          >
            <motion.div
              initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-lg md:max-w-3xl bg-background rounded-t-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-black text-foreground mb-1">Stripe ID を手動リンク</h3>
              <p className="text-xs text-muted-foreground mb-3">acct_... 形式の Connected Account ID を入力</p>
              <input
                value={linkStripeInput}
                onChange={e => setLinkStripeInput(e.target.value)}
                placeholder="acct_xxxxxxxxxxxxxxxx"
                className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-mono border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 mb-4"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setLinkStripeDialog(false)}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-secondary text-foreground"
                >キャンセル</button>
                <button
                  onClick={linkStripe}
                  disabled={!linkStripeInput.trim() || linkStripeLoading}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-primary text-white disabled:opacity-40"
                >
                  {linkStripeLoading ? '処理中…' : 'リンクする'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ログインメール変更ダイアログ */}
      <AnimatePresence>
        {emailDialog && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center"
            onClick={() => setEmailDialog(false)}
          >
            <motion.div
              initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-lg md:max-w-3xl bg-background rounded-t-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-black text-foreground mb-1">ログインメールを変更</h3>
              <p className="text-xs text-muted-foreground mb-2">
                このオーナーが<strong>ログインに使うメールアドレス</strong>を変更します。
              </p>
              <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
                ⚠️ 変更後は<strong>新しいメールでログイン</strong>する必要があります。注文通知メールの宛先もこのアドレスに変わります。同じオーナーが複数店舗を持つ場合、全店舗のログインが一括で変わります。
              </div>
              {store?.owner_email && (
                <p className="text-[11px] text-muted-foreground mb-1">
                  現在: <span className="font-mono">{store.owner_email}</span>
                </p>
              )}
              <input
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                placeholder="new-email@example.com"
                className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-mono border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 mb-4"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setEmailDialog(false)}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-secondary text-foreground"
                >キャンセル</button>
                <button
                  onClick={changeOwnerEmail}
                  disabled={!emailInput.trim() || emailLoading}
                  className="flex-1 py-3 rounded-xl text-sm font-bold bg-primary text-white disabled:opacity-40"
                >
                  {emailLoading ? '処理中…' : 'メールを変更する'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ヘッダー */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border/40 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/admin')} className="p-2 -ml-2 rounded-xl hover:bg-secondary transition-colors">
          <ArrowLeft className="w-5 h-5 text-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-black text-muted-foreground uppercase tracking-widest">神モード / 店舗詳細</p>
          {store && <p className="text-sm font-black text-foreground truncate">{store.name}</p>}
        </div>
        {store && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusBadge(store.status, store.is_active).cls}`}>
            {statusBadge(store.status, store.is_active).label}
          </span>
        )}
      </div>

      {/* コンテンツ */}
      <div className="max-w-lg md:max-w-3xl mx-auto px-4 py-4 space-y-4">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-red-700">{error}</p>
            <button onClick={fetchDetail} className="mt-3 text-xs text-red-600 underline">再試行</button>
          </div>
        )}

        {store && !loading && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

            {/* 店舗画像 + 基本情報 */}
            <div className="bg-card border border-border/60 rounded-2xl p-4 flex items-start gap-3">
              {store.image_url ? (
                <img loading="lazy" decoding="async" src={store.image_url} alt={store.name}
                  className="w-16 h-16 rounded-xl object-cover shrink-0" />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-3xl">🏪</div>
              )}
              <div className="flex-1 min-w-0">
                <h1 className="font-black text-foreground text-base">{store.name}</h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {store.address}{store.city ? `（${store.city}）` : ''}
                </p>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                  <span>バッグ {store.bag_count}個</span>
                  <span>予約 {store.reservation_count}件</span>
                  <span className="text-primary font-bold">¥{fmt(Number(store.revenue ?? 0))}</span>
                </div>
              </div>
            </div>

            {/* メトリクス */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3 text-center border border-emerald-100">
                <p className="text-base font-black text-emerald-700">¥{fmt(Number(store.revenue ?? 0))}</p>
                <p className="text-[10px] text-emerald-600/70 mt-0.5">累計売上</p>
              </div>
              <div className="bg-sky-50 rounded-xl p-3 text-center border border-sky-100">
                <p className="text-base font-black text-sky-700">{store.reservation_count}</p>
                <p className="text-[10px] text-sky-600/70 mt-0.5">総予約数</p>
              </div>
              <div className="bg-purple-50 rounded-xl p-3 text-center border border-purple-100">
                <p className="text-base font-black text-purple-700">{store.bag_count}</p>
                <p className="text-[10px] text-purple-600/70 mt-0.5">バッグ数</p>
              </div>
            </div>

            {/* 却下理由 */}
            {store.status === 'rejected' && store.rejection_reason && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <p className="text-[11px] font-black text-red-600 mb-1">却下理由</p>
                <p className="text-xs text-red-700 leading-relaxed">{store.rejection_reason}</p>
              </div>
            )}

            {/* Google検索 */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
              <p className="text-[10px] font-black text-blue-700 uppercase tracking-wide">🔍 実在性確認</p>
              <div className="grid grid-cols-2 gap-2">
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(`${store.name} ${store.city ?? ''} ${store.address}`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 bg-white hover:bg-blue-100 border border-blue-300 text-blue-700 font-bold text-[11px] py-2 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />Google検索
                </a>
                <a
                  href={`https://www.google.com/maps/search/${encodeURIComponent(`${store.name} ${store.city ?? ''} ${store.address}`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 bg-white hover:bg-blue-100 border border-blue-300 text-blue-700 font-bold text-[11px] py-2 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />Mapsで検索
                </a>
              </div>
            </div>

            {/* オーナー情報 */}
            <Section title="👤 オーナー情報">
              <Row label="メール" value={store.owner_email} copyable />
              <button
                onClick={() => { setEmailInput(''); setEmailDialog(true); }}
                disabled={!store.owner_id}
                className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-bold text-primary hover:underline disabled:opacity-40 disabled:no-underline"
              >
                <Mail className="w-3 h-3" />ログインメールを変更
              </button>
              <Row label="オーナーID" value={store.owner_id} mono />
              <Row label="登録日" value={new Date(store.created_at).toLocaleString('ja-JP')} />
            </Section>

            {/* 基本情報 */}
            <Section title="🏪 店舗基本情報">
              {store.description && <Row label="説明" value={store.description} multiline />}
              <Row label="住所" value={`${store.address}${store.city ? '（' + store.city + '）' : ''}`} />
              {store.phone && <Row label="電話番号" value={store.phone} />}
              {(store.lat || store.lng) && (
                <Row label="座標" value={`${store.lat}, ${store.lng}`}
                  link={`https://maps.google.com/?q=${store.lat},${store.lng}`} />
              )}
              <Row label="カテゴリ" value={store.category} />
            </Section>

            {/* 営業時間 */}
            {(store.open_time || store.close_time || store.holiday || store.pickup_hours) && (
              <Section title="🕐 営業時間">
                {store.open_time && <Row label="開店" value={store.open_time} />}
                {store.close_time && <Row label="閉店" value={store.close_time} />}
                {store.pickup_hours && <Row label="受取時間" value={store.pickup_hours} />}
                {store.holiday && <Row label="定休日" value={store.holiday} />}
              </Section>
            )}

            {/* コンプライアンス */}
            <Section title="📋 コンプライアンス書類">
              <Row label="誓約書署名" value={store.pledge_signed ? '✅ 署名済み' : '❌ 未署名'} />
              <Row
                label="Stripe口座"
                value={store.stripe_account_id ? `✅ ${store.stripe_account_id}` : '❌ 未連携'}
                mono={!!store.stripe_account_id}
                copyable={!!store.stripe_account_id}
              />

              {store.stripe_account_id && (
                <>
                  {store.stripe_license_file_id ? (
                    <Row label="Stripe File ID" value={`✅ ${store.stripe_license_file_id}`} mono copyable />
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5 min-w-[72px]">Stripe File ID</span>
                      {(store.stripe_charges_enabled && store.stripe_payouts_enabled) ? (
                        <span className="text-[11px] text-muted-foreground">—（DB未記録・決済は有効）</span>
                      ) : (
                        <span className="text-[11px] text-amber-600 font-semibold">❌ 未提出（Stripe未送信）</span>
                      )}
                    </div>
                  )}

                  <Row
                    label="決済 / 入金"
                    value={`決済: ${store.stripe_charges_enabled === true ? '✅ 有効' : store.stripe_charges_enabled === false ? '❌ 制限中' : '未確認'}　入金: ${store.stripe_payouts_enabled === true ? '✅ 有効' : store.stripe_payouts_enabled === false ? '❌ 停止中' : '未確認'}`}
                  />

                  {store.stripe_requirements && !store.stripe_requirements.error && (
                    <div className="mt-2 rounded-xl border border-border bg-secondary/10 p-2.5 space-y-1.5">
                      <p className="text-[9px] font-black text-muted-foreground uppercase tracking-wide">📡 Stripe ライブ確認事項</p>
                      {store.stripe_requirements.disabled_reason && (
                        <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                          <span className="text-[10px] font-black text-red-700">停止理由:</span>
                          <span className="text-[10px] text-red-600 font-mono">{store.stripe_requirements.disabled_reason}</span>
                        </div>
                      )}
                      {store.stripe_requirements.currently_due.length > 0 ? (
                        <div>
                          <p className="text-[10px] font-bold text-amber-700 mb-0.5">
                            ⚠️ 今すぐ必要な項目 ({store.stripe_requirements.currently_due.length}件)
                          </p>
                          {store.stripe_requirements.currently_due.map((item, i) => (
                            <div key={i} className="text-[10px] font-mono text-amber-800 bg-amber-50 rounded px-1.5 py-0.5 mb-0.5">{item}</div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px] text-emerald-700 font-bold">✅ 未解決の必要項目なし</p>
                      )}
                      {store.stripe_requirements.errors.length > 0 && (
                        <div>
                          <p className="text-[10px] font-bold text-red-700 mb-0.5">🚫 エラー ({store.stripe_requirements.errors.length}件)</p>
                          {store.stripe_requirements.errors.map((e, i) => (
                            <div key={i} className="text-[10px] font-mono text-red-800 bg-red-50 rounded px-1.5 py-0.5 mb-0.5">
                              [{e.code}] {e.requirement}: {e.reason}
                            </div>
                          ))}
                        </div>
                      )}
                      {store.stripe_requirements.pending_verification.length > 0 && (
                        <p className="text-[10px] text-blue-600 font-semibold">
                          🔄 審査中: {store.stripe_requirements.pending_verification.join(', ')}
                        </p>
                      )}
                    </div>
                  )}
                  {store.stripe_requirements?.error && (
                    <div className="text-[10px] text-red-600 bg-red-50 rounded-lg px-2 py-1.5 mt-1">
                      🔴 Stripe API エラー: {store.stripe_requirements.error}
                    </div>
                  )}
                </>
              )}

              {/* 本人確認書類 */}
              <div className="mt-3 rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide">オーナー確認（本人確認・口座）</p>
                {store.id_image_url ? (
                  <button onClick={() => setLightboxImg(store.id_image_url!)} className="block w-full">
                    <img loading="lazy" decoding="async" src={store.id_image_url} alt="本人確認書類"
                      className="w-full max-h-36 object-contain rounded-lg border border-border bg-background cursor-zoom-in hover:opacity-90 transition-opacity" />
                  </button>
                ) : store.stripe_account_id ? (
                  <p className="text-[11px] text-emerald-600 font-semibold">✅ Stripe共有済み（bank-setup完了）</p>
                ) : (
                  <p className="text-[11px] text-amber-600 font-semibold">⚠️ 本人確認未完了（bank-setup未実施）</p>
                )}
              </div>

              {/* 営業許可証 */}
              <div className="mt-2 rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide">
                  この店舗の営業許可証
                  {store.license_number && (
                    <span className="ml-2 font-normal normal-case text-foreground/70">{store.license_number}</span>
                  )}
                </p>
                {store.license_image_url ? (
                  <button onClick={() => setLightboxImg(store.license_image_url!)} className="block w-full">
                    <img loading="lazy" decoding="async" src={store.license_image_url} alt="営業許可証"
                      className="w-full max-h-40 object-contain rounded-lg border border-border bg-background cursor-zoom-in hover:opacity-90 transition-opacity" />
                  </button>
                ) : store.stripe_payouts_enabled ? (
                  <p className="text-[11px] text-emerald-600 font-semibold">
                    ✅ Stripe で本人確認・許可証ともに承認済み（DB画像は未保管）
                  </p>
                ) : store.stripe_license_file_id ? (
                  <p className="text-[11px] text-blue-600 font-semibold">
                    ✅ Stripe にアップロード済み（DB画像は未保管）
                  </p>
                ) : (
                  <p className="text-[11px] text-destructive font-semibold">❌ 未提出（要確認）</p>
                )}
              </div>
            </Section>

            {/* 特定商取引法 */}
            {(store.legal_name || store.legal_representative || store.legal_address || store.legal_phone || store.legal_email || store.legal_other) && (
              <Section title="⚖️ 特定商取引法情報">
                {store.legal_name && <Row label="屋号・法人名" value={store.legal_name} />}
                {store.legal_representative && <Row label="代表者名" value={store.legal_representative} />}
                {store.legal_address && <Row label="住所" value={store.legal_address} />}
                {store.legal_phone && <Row label="電話番号" value={store.legal_phone} />}
                {store.legal_email && <Row label="メール" value={store.legal_email} copyable />}
                {store.legal_other && <Row label="その他" value={store.legal_other} multiline />}
              </Section>
            )}

            {/* 店舗公開ページ */}
            <Link href={`/stores/${store.id}`}>
              <div className="flex items-center justify-center gap-1.5 bg-secondary/60 rounded-xl py-3 text-xs font-bold text-muted-foreground hover:bg-secondary transition-colors cursor-pointer">
                <ExternalLink className="w-3.5 h-3.5" />
                店舗公開ページを確認
              </div>
            </Link>

            {/* アクションエリア */}
            <div className="space-y-2">
              {/* Stripe 警告 */}
              {store.stripe_account_id && store.stripe_charges_enabled === false && store.stripe_payouts_enabled !== true && (
                <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-bold text-red-600">
                  <XCircle className="w-3.5 h-3.5 shrink-0" />
                  Stripe制限中のため承認できません。書類不備を解消してください。
                </div>
              )}
              {store.stripe_account_id && !store.stripe_license_file_id && store.stripe_payouts_enabled !== true && store.stripe_charges_enabled !== true && (
                <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[11px] font-bold text-amber-700">
                  <FileWarning className="w-3.5 h-3.5 shrink-0" />
                  ⚠️ 営業許可証が Stripe に未送信です
                </div>
              )}

              {/* Stripe 操作ボタン */}
              {store.stripe_account_id && (
                <div className="flex gap-2">
                  <button
                    onClick={syncStripe}
                    disabled={syncingStripe}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold text-xs py-2.5 rounded-xl transition-colors border border-blue-200 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncingStripe ? 'animate-spin' : ''}`} />
                    Stripe再同期
                  </button>
                </div>
              )}
              {!store.stripe_account_id && (
                <button
                  onClick={() => { setLinkStripeDialog(true); setLinkStripeInput(''); }}
                  className="w-full flex items-center justify-center gap-1.5 bg-violet-50 hover:bg-violet-100 text-violet-700 font-bold text-xs py-2.5 rounded-xl transition-colors border border-violet-200"
                >
                  <LinkIcon className="w-3.5 h-3.5" />
                  Stripe IDを手動リンク（孤立アカウント修復）
                </button>
              )}

              {/* 地図に表示トグル — 口座未設定でもマップに出せる */}
              <button
                onClick={toggleShowOnMap}
                disabled={actionLoading}
                className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-colors border disabled:opacity-50 ${
                  store.show_on_map
                    ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                    : 'bg-gray-50 hover:bg-gray-100 text-gray-600 border-gray-200'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  🗺 地図に表示
                  {store.show_on_map ? <span className="text-[10px] px-1.5 py-0.5 bg-emerald-200 rounded">ON</span>
                                      : <span className="text-[10px] px-1.5 py-0.5 bg-gray-200 rounded">OFF</span>}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {store.show_on_map ? 'タップで非表示に' : 'タップで表示する'}
                </span>
              </button>

              {/* 主アクションボタン */}
              <div className="flex gap-2 flex-wrap">
                {(store.status === 'pending_review' || store.status === 'pending' || store.status === 'applied') && (
                  <>
                    <button
                      onClick={approveStore}
                      disabled={actionLoading || (store.stripe_account_id != null && store.stripe_charges_enabled === false)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm py-3 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {actionLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      承認する
                    </button>
                    <button
                      onClick={() => setRejectDialog(true)}
                      disabled={actionLoading}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-bold text-sm py-3 rounded-xl transition-colors border border-red-200 disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      却下
                    </button>
                  </>
                )}
                {store.status === 'approved' && store.is_active && (
                  <button
                    onClick={suspendStore}
                    disabled={actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-orange-50 hover:bg-orange-100 text-orange-600 font-bold text-sm py-3 rounded-xl transition-colors border border-orange-200 disabled:opacity-50"
                  >
                    {actionLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
                    一時停止
                  </button>
                )}
                {(!store.is_active || store.status === 'suspended' || store.status === 'rejected') && !(store.status === 'pending_review' || store.status === 'pending' || store.status === 'applied') && (
                  <button
                    onClick={approveStore}
                    disabled={actionLoading || (store.stripe_account_id != null && store.stripe_charges_enabled === false)}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 font-bold text-sm py-3 rounded-xl transition-colors border border-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <CheckCircle className="w-4 h-4" />
                    再承認する
                  </button>
                )}
                {/* 神モードでは全ステータスで削除可能。関連データもサーバ側でカスケード削除される */}
                <button
                  onClick={deleteStore}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-bold text-sm py-3 px-4 rounded-xl transition-colors border border-red-200 disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                  削除
                </button>
              </div>
            </div>

            {/* 再読み込みボタン */}
            <button
              onClick={fetchDetail}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground py-2 hover:text-foreground transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              データを更新
            </button>

          </motion.div>
        )}
      </div>
    </div>
  );
}
