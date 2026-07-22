import React, { useEffect, useState, useCallback } from 'react';
import { useLocation, Link } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck, TrendingUp, Users, Store, Clock, CheckCircle, XCircle,
  Pause, Send, Megaphone, RefreshCw, AlertTriangle, ChevronDown, ChevronUp,
  BadgeDollarSign, BarChart2, Bell, Settings, ToggleLeft, ToggleRight, Type, Wrench, CreditCard,
  LogOut, ExternalLink, Package, Receipt, Flag, MapPin, Trash2, FileWarning, Link2 as LinkIcon, Mail,
  Activity, Award, Calendar, Filter, Flame, TrendingDown, Zap, AlertCircle,
} from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { fetchAppSettings } from '@/hooks/use-app-settings';
import { authedFetch } from '@/lib/authed-fetch';
import AdminAdminsSection from '@/components/AdminAdminsSection';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

const STRIPE_FIELD_JA: Record<string, string> = {
  'individual.first_name_kana':          '代表者の名前（カナ）',
  'individual.last_name_kana':           '代表者の名前（カナ）',
  'individual.first_name_kanji':         '代表者の名前（漢字）',
  'individual.last_name_kanji':          '代表者の名前（漢字）',
  'individual.dob.day':                  '代表者の生年月日',
  'individual.dob.month':                '代表者の生年月日',
  'individual.dob.year':                 '代表者の生年月日',
  'individual.address_kana.postal_code': '代表者の住所（カナ）郵便番号',
  'individual.address_kana.city':        '代表者の住所（カナ）市区町村',
  'individual.address_kana.town':        '代表者の住所（カナ）町名',
  'individual.address_kana.line1':       '代表者の住所（カナ）番地',
  'individual.address_kanji.postal_code':'代表者の住所（漢字）郵便番号',
  'individual.address_kanji.city':       '代表者の住所（漢字）市区町村',
  'individual.address_kanji.town':       '代表者の住所（漢字）町名',
  'individual.address_kanji.line1':      '代表者の住所（漢字）番地',
  'individual.email':                    '代表者のメールアドレス',
  'individual.phone':                    '代表者の電話番号',
  'individual.id_number':                'マイナンバー（個人番号）',
  'individual.verification.document':    '本人確認書類',
  'business_profile.product_description':'商品・サービスの説明',
  'external_account':                    '振込先銀行口座',
  'tos_acceptance.date':                 '利用規約の同意',
  'tos_acceptance.service_agreement':    '利用規約（サービス契約）',
  'company.name':                        '法人名（漢字）',
  'company.name_kana':                   '法人名（カナ）',
};

interface Metrics {
  gmv: number;
  platformFee: number;
  activeUsers: number;
  totalStores: number;
  approvedStores: number;
  pendingStores: number;
  suspendedStores: number;
  excludeTest?: boolean;
  breakdown?: {
    gmvConfirmed: number;
    gmvPickedUp: number;
    gmvCancelled: number;
    countPending: number;
    countConfirmed: number;
    countPickedUp: number;
    countCancelled: number;
    pickupUsers: number;
    avgPrice: number;
    maxPrice: number;
    minPrice: number;
  };
  storeBreakdown?: {
    testStores: number;
    realStores: number;
  };
  dailySeries?: Array<{ date: string; gmv: number; count: number }>;
  storeRanking?: Array<{
    id: number;
    name: string;
    isTest: boolean;
    gmv: number;
    reservations: number;
    pickedUpCount: number;
    pickupRate: number;
  }>;
  hourlyHeatmap?: number[][];
  anomalies?: {
    stalePendingCount: number;
    highCancelStores: Array<{ id: number; name: string; total: number; cancelled: number; rate: number }>;
    licenseIssueCount: number;
    openReportsCount?: number;
    noStripeApprovedCount?: number;
    pendingApprovalsCount?: number;
    newSalesLeadsCount?: number;
  };
}

interface LicenseIssue {
  id: number;
  name: string;
  status: string;
  is_active: boolean;
  category: string;
  city: string | null;
  image_url: string | null;
  icon_url: string | null;
  created_at: string;
  owner_id: string | null;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  license_number: string | null;
  has_license_url: boolean;
  has_stripe_file_id: boolean;
  license_upload_failed: boolean;
  license_upload_error: string | null;
  license_upload_attempted_at: string | null;
  issue_type: 'upload_failed' | 'image_missing_but_number_set' | 'no_license_at_all' | 'unknown';
  severity: 'high' | 'medium' | 'low';
}

interface AdminStore {
  id: number;
  name: string;
  status: string;
  is_active: boolean;
  category: string;
  address: string;
  city: string;
  image_url: string | null;
  icon_url: string | null;
  owner_id: string;
  created_at: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_payouts_enabled: boolean | null;
  show_on_map: boolean | null;
  bag_count: number;
  reservation_count: number;
  revenue: number;
  rejection_reason: string | null;
  owner_store_count: number;
  owner_store_rank: number;
}

interface StripeRequirements {
  currently_due:        string[];
  eventually_due:       string[];
  errors:               { code: string; reason: string; requirement: string }[];
  disabled_reason:      string | null;
  pending_verification: string[];
  error?:               string;
  message?:             string;
}

interface AdminStoreDetail extends AdminStore {
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
  stripe_license_file_id: string | null;
  id_image_url: string | null;
  pledge_signed: boolean;
  legal_name: string | null;
  legal_representative: string | null;
  legal_address: string | null;
  legal_phone: string | null;
  legal_email: string | null;
  legal_other: string | null;
  owner_email: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_payouts_enabled: boolean | null;
  stripe_requirements: StripeRequirements | null;
}

interface Announcement {
  id: number;
  title: string;
  body: string;
  created_by: string;
  created_at: string;
}

interface SalesLead {
  id: number;
  reportedBy: string | null;
  storeName: string;
  location: string;
  memo: string | null;
  status: string;
  createdAt: string;
}

type RecurringStatus = 'live' | 'pending' | 'soldout' | 'alert' | 'withdrawn' | 'off' | 'ended';
interface RecurringMonitorListing {
  id: number;
  storeId: number;
  storeName: string;
  storeStatus: string;
  title: string;
  status: RecurringStatus;
  publishTime: string;
  daysOfWeek: number;
  pickupNextDay: boolean;
  carryOverStock: boolean;
  isActive: boolean;
  pickupStart: string | null;
  pickupEnd: string | null;
  pickupStart2: string | null;
  pickupEnd2: string | null;
  discountedPrice: number;
  originalPrice: number;
  stockCount: number;
  liveStock: number;
  liveBags: number;
  todayStock: number | null;
  latestStock: number | null;
  reservedQty: number;
  paidQty: number;
  lastPublishedDate: string | null;
  publishedToday: boolean;
  scheduledToday: boolean;
  skippedToday: boolean;
  nextPublishDate: string | null;
  updatedJst: string;
  createdJst: string;
}
interface RecurringMonitor {
  today: string;
  nowTime: string;
  summary: {
    total: number; live: number; pending: number; soldout: number; alert: number;
    withdrawn: number; off: number; ended: number; liveStock: number; reservedQty: number;
  };
  listings: RecurringMonitorListing[];
}

/** 正規化: 全角→半角・小文字化・記号空白除去 (重複店舗検出用) */
function normalizeStoreText(s: string | null | undefined): string {
  if (!s) return '';
  let t = s.normalize('NFKC');
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ').toLowerCase();
  t = t.replace(/[\s\-‐－―ー.,、。・/\\()（）「」『』【】\[\]{}<>＜＞:;:;'"`~!?！？*&%＄$#＃@＠+＋=＝]/g, '');
  return t.trim();
}
/** 電話番号の正規化 (数字のみ抽出) */
function normalizePhone(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/\D/g, '');
}

function fmt(n: number) {
  return new Intl.NumberFormat('ja-JP').format(n);
}

function statusBadge(store: AdminStore) {
  if (!store.is_active && store.status === 'approved') return { label: '一時停止', cls: 'bg-orange-100 text-orange-700' };
  switch (store.status) {
    case 'approved':      return { label: '承認済み',  cls: 'bg-emerald-100 text-emerald-700' };
    case 'pending_review':
    case 'pending':       return { label: '審査待ち',  cls: 'bg-amber-100 text-amber-700' };
    case 'applied':       return { label: '口座申請済', cls: 'bg-blue-100 text-blue-700' };
    case 'rejected':      return { label: '却下',      cls: 'bg-red-100 text-red-700' };
    case 'suspended':     return { label: '停止中',    cls: 'bg-red-100 text-red-700' };
    default:              return { label: store.status, cls: 'bg-secondary text-muted-foreground' };
  }
}

// ── 定期出品モニターの状態表示設定 ──
const RECURRING_STATUS_META: Record<RecurringStatus, { label: string; emoji: string; cls: string; dot: string; order: number }> = {
  alert:     { label: '未公開アラート', emoji: '⚠️', cls: 'bg-red-100 text-red-700 border-red-300',        dot: 'bg-red-500',    order: 0 },
  live:      { label: '出品中',        emoji: '🟢', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300', dot: 'bg-emerald-500', order: 1 },
  pending:   { label: '公開予定',      emoji: '🔵', cls: 'bg-blue-100 text-blue-700 border-blue-300',      dot: 'bg-blue-500',   order: 2 },
  soldout:   { label: '完売',          emoji: '🔴', cls: 'bg-rose-100 text-rose-700 border-rose-300',      dot: 'bg-rose-500',   order: 3 },
  withdrawn: { label: '停止(取消)',    emoji: '⚫', cls: 'bg-gray-200 text-gray-700 border-gray-300',      dot: 'bg-gray-500',   order: 4 },
  ended:     { label: '本日終了',      emoji: '🏁', cls: 'bg-slate-100 text-slate-600 border-slate-300',   dot: 'bg-slate-400',  order: 5 },
  off:       { label: '休み',          emoji: '🟡', cls: 'bg-amber-50 text-amber-700 border-amber-200',    dot: 'bg-amber-400',  order: 6 },
};
const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
/** daysOfWeek bitmask(bit0=日..bit6=土) を「毎日」「月〜金」等の短い日本語に。 */
function formatDaysOfWeek(mask: number): string {
  if ((mask & 127) === 127) return '毎日';
  const days: number[] = [];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) days.push(i);
  if (days.length === 0) return '曜日未設定';
  // 連続範囲をまとめる（例: 月火水木金 → 月〜金）
  const labels = days.map((d) => DOW_LABELS[d]);
  return labels.join('・');
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-secondary/30 rounded-xl overflow-hidden">
      <div className="px-3 py-2 bg-secondary/50 border-b border-border/30">
        <p className="text-[11px] font-black text-foreground/70 uppercase tracking-wide">{title}</p>
      </div>
      <div className="px-3 py-2 space-y-1.5">{children}</div>
    </div>
  );
}

function DetailRow({
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
        <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5">{label}</span>
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

// ── Growth God Mode（成長の神モード）データ型 ──
interface GrowthDeadStore {
  id: number;
  name: string;
  city: string;
  orders: number;
  gmv: number;
  liveBags: number;
  lastBagAt: string | null;
  daysSinceLastBag: number | null;
}
interface GrowthData {
  funnel: {
    registered: number;
    favorited: number;
    buyers: number;
    repeatBuyers: number;
    newUsers7d: number;
    newUsers30d: number;
    rates: {
      registerToFav: number;
      favToBuy: number;
      registerToBuy: number;
      buyToRepeat: number;
    };
  };
  hotLeads: {
    favNoPurchase: number;
    registered7dNoPurchase: number;
  };
  deadStores: GrowthDeadStore[];
  supply: {
    approvedActiveStores: number;
    storesWithLiveBags: number;
    liveBags: number;
    liveStockUnits: number;
  };
  weeklyTrend: { week: string; newUsers: number; buyers: number; gmv: number }[];
}

export default function AdminDashboard() {
  const { user, session, signOut, isLoading: authLoading, isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate('/login?redirect=%2Fadmin', { replace: true });
    }
  }, [authLoading, user, navigate]);

  const [metrics, setMetrics]             = useState<Metrics | null>(null);
  const [excludeTest, setExcludeTest]     = useState<boolean>(false);
  const [licenseIssues, setLicenseIssues] = useState<LicenseIssue[]>([]);
  const [reuploadLoading, setReuploadLoading] = useState<number | null>(null);
  const [stores, setStores]               = useState<AdminStore[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [salesLeads, setSalesLeads]       = useState<SalesLead[]>([]);
  const [recurringMon, setRecurringMon]   = useState<RecurringMonitor | null>(null);
  const [recurringFilter, setRecurringFilter] = useState<RecurringStatus | 'all'>('all');
  const [growth, setGrowth]               = useState<GrowthData | null>(null);
  const [reengageSeg, setReengageSeg]     = useState<'fav_no_purchase' | 'registered_no_purchase_7d' | null>(null);
  const [loading, setLoading]             = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const [annTitle, setAnnTitle] = useState('');
  const [annBody, setAnnBody]   = useState('');
  const [annSending, setAnnSending] = useState(false);

  const [notifTitle, setNotifTitle] = useState('');
  const [notifBody, setNotifBody]   = useState('');
  const [notifSending, setNotifSending] = useState(false);

  // ── アプリ設定 ──
  const [catchphrase,        setCatchphrase]        = useState('あなたの街のおすそわけ');
  const [subCatchphrase,     setSubCatchphrase]     = useState('おいしいものを、もっとみんなへ。');
  const [maintenanceMode,       setMaintenanceMode]       = useState(false);
  const [maintenanceTitle,      setMaintenanceTitle]      = useState('ただいまメンテナンス中です');
  const [maintenanceMessage,    setMaintenanceMessage]    = useState('より良いサービスのために、現在システムメンテナンスを行っています。\nしばらくお待ちください🙏');
  const [autoApproveStripe,     setAutoApproveStripe]     = useState(false);
  const [settingsSaving,        setSettingsSaving]        = useState(false);
  const [migratingImages,       setMigratingImages]       = useState(false);

  const [storeFilter, setStoreFilter] = useState<'all' | 'applied' | 'pending' | 'pending_review' | 'approved' | 'suspended'>('applied');
  const [showAllStores, setShowAllStores] = useState(false);
  const [expandedStore, setExpandedStore] = useState<number | null>(null);
  // 却下モーダル
  const [rejectDialog, setRejectDialog] = useState<{ storeId: number; storeName: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Stripe警告モーダル（承認後にStripe未連携が発覚した場合）
  const [stripeWarnModal, setStripeWarnModal] = useState<{
    storeName: string;
    status: {
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      hasAccount: boolean;
      currentlyDue: string[];
      errors: { code: string; reason: string; requirement: string }[];
    };
  } | null>(null);
  const [expandedLead, setExpandedLead]   = useState<number | null>(null);
  const [storeDetails, setStoreDetails]   = useState<Record<number, AdminStoreDetail>>({});
  const [detailLoading, setDetailLoading] = useState<number | null>(null);
  const [lightboxImg, setLightboxImg]     = useState<string | null>(null);
  const [syncingStripe, setSyncingStripe] = useState<number | null>(null);
  const [stripeErrors, setStripeErrors]   = useState<Record<number, string | null>>({});
  // ── Stripe アカウント手動リンク（孤立アカウント修復） ──
  const [linkStripeDialog, setLinkStripeDialog] = useState<{ storeId: number; storeName: string } | null>(null);
  const [linkStripeInput,  setLinkStripeInput]  = useState('');
  const [linkStripeLoading, setLinkStripeLoading] = useState(false);
  const [emailDialog, setEmailDialog] = useState<{ storeId: number; storeName: string; currentEmail: string | null } | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  const token = session?.access_token;

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    if (!authLoading && !isAdmin) { navigate('/'); return; }
  }, [user, isAdmin, authLoading]);

  const fetchAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [mRes, sRes, aRes, lRes, liRes, rmRes, gRes] = await Promise.all([
        authedFetch(`${BASE}/api/admin/metrics?excludeTest=${excludeTest ? '1' : '0'}`, { headers: {} }),
        authedFetch(`${BASE}/api/admin/stores`,         { headers: {} }),
        authedFetch(`${BASE}/api/admin/announcements`,  { headers: {} }),
        authedFetch(`${BASE}/api/admin/sales-leads`,    { headers: {} }),
        authedFetch(`${BASE}/api/admin/license-issues`, { headers: {} }),
        authedFetch(`${BASE}/api/admin/recurring-monitor`, { headers: {} }),
        authedFetch(`${BASE}/api/admin/growth`,         { headers: {} }),
      ]);
      if (gRes.ok) setGrowth(await gRes.json());
      if (rmRes.ok) setRecurringMon(await rmRes.json());
      if (mRes.ok) setMetrics(await mRes.json());
      if (liRes.ok) {
        const li = await liRes.json();
        setLicenseIssues(li?.items ?? []);
      }
      if (sRes.ok) {
        const storeData: AdminStore[] = await sRes.json();
        setStores(storeData);
        // Stripe アカウントを持つ店舗のステータスをバックグラウンドで自動更新
        if (storeData.some(s => s.stripe_account_id)) {
          authedFetch(`${BASE}/api/admin/stores/batch-refresh-stripe`, {
            method: 'POST',
            headers: {},
          })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data?.updated) return;
              setStores(prev => prev.map(s => {
                const updated = data.updated[s.id];
                return updated !== undefined ? { ...s, stripe_charges_enabled: updated } : s;
              }));
            })
            .catch(() => {});
        }
      }
      if (aRes.ok) setAnnouncements(await aRes.json());
      if (lRes.ok) setSalesLeads(await lRes.json());
      // 設定の読み込み（グローバルキャッシュ経由）
      const appSettings = await fetchAppSettings();
      setCatchphrase(appSettings.catchphrase);
      setSubCatchphrase(appSettings.sub_catchphrase);
      setMaintenanceMode(appSettings.maintenance_mode === 'true');
      setMaintenanceTitle(appSettings.maintenance_title);
      setMaintenanceMessage(appSettings.maintenance_message);
      setAutoApproveStripe(appSettings.auto_approve_stripe_verified === 'true');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token, excludeTest]);

  // 再アップロード要求 + 営業許可証修復ヘルパー
  const requestLicenseReupload = useCallback(async (storeId: number) => {
    if (!confirm('店主に営業許可証の再アップロードを要求しますか？')) return;
    setReuploadLoading(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/request-license-reupload`, {
        method: 'POST',
        headers: {},
      });
      if (res.ok) {
        const data = await res.json();
        alert(`✅ 要求を記録しました${data.ownerEmail ? `\n店主: ${data.ownerEmail}` : ''}`);
        await fetchAll();
      } else {
        alert('❌ 要求失敗');
      }
    } catch (e: any) {
      alert(`❌ エラー: ${e?.message ?? e}`);
    } finally {
      setReuploadLoading(null);
    }
  }, [token, fetchAll]);

  // ── ホットリード再エンゲージ Push ──
  const reengageSegment = useCallback(async (
    segment: 'fav_no_purchase' | 'registered_no_purchase_7d',
    label: string,
  ) => {
    const presets: Record<string, { title: string; body: string }> = {
      fav_no_purchase: {
        title: 'お気に入りのお店に空きが出ました🍞',
        body: '気になっていたお店のサプライズバッグ、今すぐチェック！売り切れ前に受け取ろう。',
      },
      registered_no_purchase_7d: {
        title: 'はじめてのおすそわけ、待ってます🎁',
        body: 'あなたの街のお店が余った美味しいものをお得に。近くのバッグを見てみよう！',
      },
    };
    const p = presets[segment];
    const title = window.prompt(`【${label}】に送るPush通知のタイトル`, p.title);
    if (title === null) return;
    if (!title.trim()) { alert('タイトルは必須です'); return; }
    const body = window.prompt('本文（任意）', p.body) ?? '';
    if (!confirm(`「${label}」の見込み客に Push を送信します。よろしいですか？`)) return;
    setReengageSeg(segment);
    try {
      const res = await authedFetch(`${BASE}/api/admin/growth/reengage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment, title: title.trim(), body: body.trim(), url: '/' }),
      });
      if (res.ok) {
        const data = await res.json();
        toast({ title: '✅ 送信しました', description: `${data.targeted ?? 0} 人に配信` });
      } else {
        toast({ title: '❌ 送信失敗', description: `HTTP ${res.status}`, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: '❌ エラー', description: e?.message ?? '不明なエラー', variant: 'destructive' });
    } finally {
      setReengageSeg(null);
    }
  }, [token, toast]);

  async function saveSettings() {
    setSettingsSaving(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catchphrase:                  catchphrase.trim(),
          sub_catchphrase:              subCatchphrase.trim(),
          maintenance_mode:             maintenanceMode ? 'true' : 'false',
          maintenance_title:            maintenanceTitle.trim(),
          maintenance_message:          maintenanceMessage.trim(),
          auto_approve_stripe_verified: autoApproveStripe ? 'true' : 'false',
        }),
      });
      if (res.ok) {
        await fetchAppSettings();  // グローバルキャッシュを更新
        toast({ title: maintenanceMode ? '🔧 メンテナンスモードON・設定を保存しました' : '✅ 設定を保存しました' });
      } else {
        toast({ title: 'エラー', variant: 'destructive' });
      }
    } finally {
      setSettingsSaving(false);
    }
  }

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function toggleShowOnMap(storeId: number, current: boolean | null) {
    const next = !current;
    setActionLoading(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/show-on-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showOnMap: next }),
      });
      if (res.ok) {
        toast({ title: next ? '🗺 地図に表示しました' : '🚫 地図から非表示にしました' });
        await fetchAll();
      } else {
        const d = await res.json().catch(() => ({}));
        toast({ title: 'エラー', description: d?.message ?? '更新に失敗しました', variant: 'destructive' });
      }
    } finally { setActionLoading(null); }
  }

  async function approveStore(storeId: number) {
    setActionLoading(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/approve`, {
        method: 'POST',
        headers: {},
      });
      if (res.ok) {
        const data = await res.json();
        await fetchAll();
        if (data.stripeStatus && !data.stripeStatus.ok) {
          const storeName = stores.find(st => st.id === storeId)?.name ?? '店舗';
          setStripeWarnModal({ storeName, status: data.stripeStatus });
        } else {
          toast({ title: '✅ 承認しました' });
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        if (errData?.error === 'stripe_restricted') {
          toast({
            title: '⛔ Stripe制限中のため承認できません',
            description: 'Stripeダッシュボードで書類不備を解消してから再度承認してください。',
            variant: 'destructive',
          });
        } else {
          toast({ title: 'エラー', description: errData?.message ?? '承認に失敗しました', variant: 'destructive' });
        }
      }
    } finally { setActionLoading(null); }
  }

  async function suspendStore(storeId: number) {
    if (!confirm('この店舗を一時停止しますか？')) return;
    setActionLoading(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/suspend`, {
        method: 'POST',
        headers: {},
      });
      if (res.ok) { toast({ title: '⏸ 一時停止しました' }); await fetchAll(); }
      else toast({ title: 'エラー', variant: 'destructive' });
    } finally { setActionLoading(null); }
  }

  function openRejectDialog(storeId: number, storeName: string) {
    setRejectReason('');
    setRejectDialog({ storeId, storeName });
  }

  async function confirmReject() {
    if (!rejectDialog) return;
    const { storeId } = rejectDialog;
    setActionLoading(storeId);
    setRejectDialog(null);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason: rejectReason.trim() || null }),
      });
      if (res.ok) { toast({ title: '❌ 却下しました。オーナーに通知を送信しました。' }); await fetchAll(); }
      else toast({ title: 'エラー', description: '却下に失敗しました', variant: 'destructive' });
    } finally { setActionLoading(null); }
  }

  async function deleteStore(storeId: number, storeName: string) {
    setActionLoading(storeId);
    try {
      // 削除前に detail から関連件数を取得して警告に表示
      let warn = `「${storeName}」を完全に削除しますか？\nこの操作は取り消せません。`;
      try {
        const dRes = await authedFetch(`${BASE}/api/admin/stores/${storeId}/detail`, { headers: {} });
        if (dRes.ok) {
          const d = await dRes.json();
          const counts = [
            d.bag_count              ? `商品: ${d.bag_count}件`              : null,
            d.reservation_count      ? `予約: ${d.reservation_count}件`      : null,
            d.cart_reservation_count ? `カート: ${d.cart_reservation_count}件` : null,
            d.favorite_count         ? `お気に入り: ${d.favorite_count}件`   : null,
            d.review_count           ? `レビュー: ${d.review_count}件`       : null,
            d.report_count           ? `通報: ${d.report_count}件`           : null,
            d.notification_count     ? `通知履歴: ${d.notification_count}件` : null,
          ].filter(Boolean);
          if (counts.length > 0) {
            warn = `⚠️ 「${storeName}」を完全に削除します\n\n以下の関連データも全て削除されます:\n  ・${counts.join('\n  ・')}\n\nこの操作は取り消せません。本当に実行しますか？`;
          }
        }
      } catch { /* detail 取得失敗時はデフォルト確認のみ */ }
      if (!confirm(warn)) return;

      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}`, {
        method: 'DELETE',
        headers: {},
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const c = data?.cascade ?? {};
        const cascadeMsg = Object.entries(c)
          .filter(([, n]) => (n as number) > 0)
          .map(([k, n]) => `${k}:${n}`).join(' ');
        toast({
          title: '🗑 店舗を削除しました',
          description: cascadeMsg ? `関連データも削除: ${cascadeMsg}` : undefined,
        });
        await fetchAll();
      } else {
        const d = await res.json().catch(() => ({}));
        toast({ title: 'エラー', description: d.message || d.error || '削除に失敗しました', variant: 'destructive' });
      }
    } finally { setActionLoading(null); }
  }

  async function syncStripeForStore(storeId: number) {
    if (!token) { toast({ title: 'ログインが必要です', variant: 'destructive' }); return; }
    setSyncingStripe(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/stripe-sync`, {
        method: 'POST',
        headers: {},
      });
      const data = await res.json();
      if (res.ok) {
        if (data.stripeError) {
          setStripeErrors(prev => ({ ...prev, [storeId]: data.stripeError }));
          setStores(prev => prev.map(s => s.id === storeId
            ? { ...s, stripe_charges_enabled: false, stripe_payouts_enabled: false }
            : s
          ));
          toast({ title: '⚠️ Stripe連携エラーを検出', description: `エラー: ${data.stripeError}`, variant: 'destructive' });
        } else {
          setStripeErrors(prev => ({ ...prev, [storeId]: null }));
          setStores(prev => prev.map(s => s.id === storeId
            ? { ...s, stripe_charges_enabled: data.chargesEnabled, stripe_payouts_enabled: data.payoutsEnabled }
            : s
          ));
          // storeDetails も更新（license_file_id / charges / payouts）
          setStoreDetails(prev => {
            const existing = prev[storeId];
            if (!existing) return prev;
            return {
              ...prev,
              [storeId]: {
                ...existing,
                stripe_charges_enabled: data.chargesEnabled,
                stripe_payouts_enabled: data.payoutsEnabled,
                stripe_license_file_id: data.licenseFileId ?? existing.stripe_license_file_id,
              },
            };
          });
          const fileTag = data.licenseFileId ? ` / File: ✅ 取得済み` : '';
          toast({ title: '✅ Stripe再同期完了', description: `決済: ${data.chargesEnabled ? '有効' : '制限中'} / 入金: ${data.payoutsEnabled ? '有効' : '停止中'}${fileTag}` });
        }
      } else {
        toast({ title: 'エラー', description: '再同期に失敗しました', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'エラー', description: 'サーバーへの接続に失敗しました', variant: 'destructive' });
    } finally {
      setSyncingStripe(null);
    }
  }

  async function disconnectStripe(storeId: number, storeName: string) {
    if (!confirm(`「${storeName}」のStripe口座連携を解除しますか？\n\n⚠️ 注意：保留中・振込可能の残高がある場合、その金額は旧銀行口座に振り込まれます。旧口座が閉鎖済みの場合は振込失敗のリスクがあります。\n\n残高¥0を確認してから実行することを推奨します。`)) return;
    if (!token) { toast({ title: 'ログインが必要です', variant: 'destructive' }); return; }
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/stripe-disconnect`, {
        method: 'POST',
        headers: {},
      });
      if (res.ok) {
        setStores(prev => prev.map(s => s.id === storeId ? { ...s, stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false } : s));
        setStoreDetails(prev => {
          const existing = prev[storeId];
          if (!existing) return prev;
          return { ...prev, [storeId]: { ...existing, stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_license_file_id: null } };
        });
        toast({ title: '✅ Stripe連携を解除しました', description: 'オーナーのマイページに口座再登録の案内が表示されます' });
      } else {
        toast({ title: 'エラー', description: '解除に失敗しました', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'エラー', description: 'サーバーへの接続に失敗しました', variant: 'destructive' });
    }
  }

  async function linkStripeAccount() {
    if (!linkStripeDialog || !linkStripeInput.startsWith('acct_')) return;
    setLinkStripeLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${linkStripeDialog.storeId}/link-stripe-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripeAccountId: linkStripeInput.trim() }),
      });
      if (res.ok) {
        setStores(prev => prev.map(s => s.id === linkStripeDialog.storeId
          ? { ...s, stripe_account_id: linkStripeInput.trim() } : s));
        toast({ title: '✅ Stripe IDをリンクしました', description: `店舗 #${linkStripeDialog.storeId} → ${linkStripeInput.trim()}` });
        setLinkStripeDialog(null);
        setLinkStripeInput('');
        // 続けてStripe情報を再同期
        await syncStripeForStore(linkStripeDialog.storeId);
      } else {
        const err = await res.json();
        toast({ title: 'エラー', description: err.message ?? 'リンクに失敗しました', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'エラー', description: 'サーバーへの接続に失敗しました', variant: 'destructive' });
    } finally {
      setLinkStripeLoading(false);
    }
  }

  async function changeOwnerEmail() {
    if (!emailDialog || !emailInput.trim()) return;
    setEmailLoading(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${emailDialog.storeId}/owner-email`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        const newEmail = (d.email as string) ?? emailInput.trim();
        // 展開中パネルの表示メールを即時更新
        setStoreDetails(prev => prev[emailDialog.storeId]
          ? { ...prev, [emailDialog.storeId]: { ...prev[emailDialog.storeId], owner_email: newEmail } }
          : prev);
        toast({
          title: d.unchanged ? 'メールは変更されていません' : '✅ ログインメールを変更しました',
          description: d.unchanged ? undefined : `新しいメール: ${newEmail}`,
        });
        setEmailDialog(null);
        setEmailInput('');
      } else {
        toast({ title: 'エラー', description: d.message ?? d.error ?? '変更に失敗しました', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'エラー', description: 'サーバーへの接続に失敗しました', variant: 'destructive' });
    } finally {
      setEmailLoading(false);
    }
  }

  async function sendAnnouncement() {
    if (!annTitle.trim() || !annBody.trim()) {
      toast({ title: 'タイトルと本文を入力してください', variant: 'destructive' }); return;
    }
    setAnnSending(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/announcements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: annTitle.trim(), body: annBody.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: `📣 配信完了！${data.userCount}人に送信されました` });
        setAnnTitle(''); setAnnBody('');
        await fetchAll();
      } else {
        toast({ title: 'エラー', description: data.error, variant: 'destructive' });
      }
    } finally { setAnnSending(false); }
  }

  async function sendNotification() {
    if (!notifTitle.trim()) {
      toast({ title: 'タイトルを入力してください', variant: 'destructive' }); return;
    }
    setNotifSending(true);
    try {
      const res = await authedFetch(`${BASE}/api/admin/notifications/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: notifTitle.trim(), body: notifBody.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: `🔔 通知完了！${data.sentTo}人に送信されました` });
        setNotifTitle(''); setNotifBody('');
      } else {
        toast({ title: 'エラー', description: data.error, variant: 'destructive' });
      }
    } finally { setNotifSending(false); }
  }

  async function fetchStoreDetail(storeId: number) {
    if (storeDetails[storeId] || detailLoading === storeId) return;
    setDetailLoading(storeId);
    try {
      const res = await authedFetch(`${BASE}/api/admin/stores/${storeId}/detail`, {
        headers: {},
      });
      if (res.ok) {
        const data = await res.json();
        setStoreDetails(prev => ({ ...prev, [storeId]: data }));
        // Stripe ライブ値を store リストの in-memory にも反映（バッジズレ防止）
        if (data.stripe_charges_enabled != null || data.stripe_payouts_enabled != null) {
          setStores(prev => prev.map(s => s.id === storeId
            ? {
                ...s,
                stripe_charges_enabled: data.stripe_charges_enabled ?? s.stripe_charges_enabled,
                stripe_payouts_enabled: data.stripe_payouts_enabled ?? s.stripe_payouts_enabled,
              }
            : s
          ));
        }
      }
    } finally {
      setDetailLoading(null);
    }
  }

  function toggleExpand(storeId: number) {
    if (expandedStore === storeId) {
      setExpandedStore(null);
    } else {
      setExpandedStore(storeId);
      fetchStoreDetail(storeId);
    }
  }

  const isPending = (s: AdminStore) =>
    s.status === 'pending_review' || s.status === 'pending' || s.status === 'applied';

  const filteredStores = stores.filter(s => {
    if (storeFilter === 'applied')        return s.status === 'applied';
    if (storeFilter === 'pending')        return s.status === 'pending';
    if (storeFilter === 'pending_review') return s.status === 'pending_review';
    if (storeFilter === 'approved')       return s.status === 'approved' && s.is_active;
    if (storeFilter === 'suspended')      return s.status === 'suspended' || s.status === 'rejected' || (s.status === 'approved' && !s.is_active);
    return true;
  });
  const displayedStores = showAllStores ? filteredStores : filteredStores.slice(0, 10);

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-4" />
          <p className="font-bold text-xl">アクセス権限がありません</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* ヘッダー */}
      <div className="sticky top-0 z-40 bg-white/90 backdrop-blur-xl border-b border-border/40"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-5 h-5 text-purple-600 shrink-0" />
            <span className="font-black text-foreground truncate">管理者ダッシュボード</span>
            <span className="text-[10px] font-black bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full shrink-0">神モード</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={fetchAll} className="p-2 rounded-xl hover:bg-secondary transition-colors">
              <RefreshCw className={`w-4 h-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={async () => { await signOut(); navigate('/'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 text-red-600 text-xs font-bold border border-red-200 hover:bg-red-100 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              ログアウト
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">

        {/* ── ヒーロー指標バナー ── */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <div className="rounded-3xl overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #4c1d95 0%, #5b21b6 35%, #2563eb 100%)' }}>
            <div className="px-5 pt-5 pb-3">
              <div className="flex items-center gap-2 mb-4">
                <ShieldCheck className="w-4 h-4 text-white/70" />
                <span className="text-xs font-bold text-white/70 tracking-widest uppercase">神モード 全体統計</span>
              </div>

              {/* 総売上 BIG */}
              {metrics ? (
                <>
                  <div className="mb-4">
                    <p className="text-[11px] text-white/60 font-medium mb-0.5">累計流通額 (GMV)</p>
                    <p className="text-5xl font-black text-white tracking-tight">¥{fmt(metrics.gmv)}</p>
                    <p className="text-xs text-white/60 mt-1">手数料収益 (20%): <span className="text-white/90 font-bold">¥{fmt(metrics.platformFee)}</span></p>
                  </div>

                  {/* 5つのビッグ数値 */}
                  <div className="grid grid-cols-5 gap-1.5 mb-2">
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2 text-center border border-white/10">
                      <p className="text-2xl font-black text-emerald-300">{metrics.approvedStores}</p>
                      <p className="text-[9px] text-white/60 mt-0.5 leading-tight">公開中</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2 text-center border border-white/10">
                      <p className={`text-2xl font-black ${stores.filter(s => s.status === 'applied').length > 0 ? 'text-blue-300' : 'text-white/50'}`}>
                        {stores.filter(s => s.status === 'applied').length}
                      </p>
                      <p className="text-[9px] text-white/60 mt-0.5 leading-tight">KYC審査中</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2 text-center border border-white/10">
                      <p className={`text-2xl font-black ${stores.filter(s => s.status === 'pending').length > 0 ? 'text-orange-300' : 'text-white/50'}`}>
                        {stores.filter(s => s.status === 'pending').length}
                      </p>
                      <p className="text-[9px] text-white/60 mt-0.5 leading-tight">口座未登録</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2 text-center border border-white/10">
                      <p className={`text-2xl font-black ${stores.filter(s => s.status === 'pending_review').length > 0 ? 'text-amber-300' : 'text-white/50'}`}>
                        {stores.filter(s => s.status === 'pending_review').length}
                      </p>
                      <p className="text-[9px] text-white/60 mt-0.5 leading-tight">要確認</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2 text-center border border-white/10">
                      <p className="text-2xl font-black text-sky-300">{metrics.activeUsers}</p>
                      <p className="text-[9px] text-white/60 mt-0.5 leading-tight">ユーザー数</p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-3 mb-4">
                  <div className="h-12 bg-white/10 rounded-xl animate-pulse" />
                  <div className="grid grid-cols-3 gap-2">
                    {[1,2,3].map(i => <div key={i} className="h-16 bg-white/10 rounded-xl animate-pulse" />)}
                  </div>
                </div>
              )}
            </div>

            {/* 登録店舗合計バー */}
            <div className="bg-white/5 px-5 py-3 flex items-center justify-between">
              <span className="text-[11px] text-white/60 font-medium flex items-center gap-1.5">
                <Store className="w-3 h-3" />登録店舗合計
              </span>
              <span className="text-sm font-black text-white">
                {metrics ? `${fmt(metrics.totalStores)}店` : '…'}
                {metrics?.storeBreakdown && (
                  <span className="text-[10px] text-white/50 ml-2 font-medium">
                    (実 {metrics.storeBreakdown.realStores} / テスト {metrics.storeBreakdown.testStores})
                  </span>
                )}
              </span>
            </div>
          </div>
        </motion.div>

        {/* ── 🚨 要対応サマリー (タップで該当箇所へジャンプ + CSV エクスポート) ── */}
        {(() => {
          const a = metrics?.anomalies;
          const appliedCount = stores.filter(s => s.status === 'applied').length;
          const pendingCount = stores.filter(s => s.status === 'pending').length;
          const reviewCount  = stores.filter(s => s.status === 'pending_review').length;
          const items = [
            { key: 'apply',    label: '新規申請 (KYC審査中)', n: appliedCount,                      color: 'blue',   icon: Clock,       anchor: '#stores-section', filter: 'applied' as const },
            { key: 'pending',  label: '口座未登録',           n: pendingCount,                      color: 'orange', icon: AlertCircle, anchor: '#stores-section', filter: 'pending' as const },
            { key: 'review',   label: '要確認 (審査待ち)',    n: reviewCount,                       color: 'amber',  icon: ShieldCheck, anchor: '#stores-section', filter: 'pending_review' as const },
            { key: 'reports',  label: 'ユーザ通報',           n: a?.openReportsCount ?? 0,          color: 'red',    icon: AlertTriangle, anchor: '#stores-section' },
            { key: 'license',  label: '営業許可証 問題',      n: a?.licenseIssueCount ?? 0,         color: 'red',    icon: FileWarning, anchor: '#license-section' },
            { key: 'noStripe', label: '公開中だが入金不可',   n: a?.noStripeApprovedCount ?? 0,     color: 'rose',   icon: AlertTriangle, anchor: '#stores-section', filter: 'approved' as const },
            { key: 'stale',    label: '24h+ pending',          n: a?.stalePendingCount ?? 0,         color: 'amber',  icon: Clock,       anchor: '#anomalies-section' },
            { key: 'leads',    label: '新規お店通報',         n: a?.newSalesLeadsCount ?? 0,        color: 'sky',    icon: AlertCircle, anchor: '#leads-section' },
            { key: 'cancel',   label: 'キャンセル多発店',     n: a?.highCancelStores.length ?? 0,   color: 'red',    icon: TrendingDown, anchor: '#anomalies-section' },
            { key: 'recurAlert', label: '定期出品の公開漏れ',  n: recurringMon?.summary.alert ?? 0,  color: 'red',    icon: Calendar,    anchor: '#recurring-section' },
          ];
          const visible = items.filter(i => i.n > 0);
          const totalAlerts = visible.reduce((sum, i) => sum + i.n, 0);
          const colorMap: Record<string, string> = {
            blue:   'bg-blue-50 border-blue-200 text-blue-700 active:bg-blue-100',
            orange: 'bg-orange-50 border-orange-200 text-orange-700 active:bg-orange-100',
            amber:  'bg-amber-50 border-amber-200 text-amber-700 active:bg-amber-100',
            red:    'bg-red-50 border-red-300 text-red-700 active:bg-red-100',
            rose:   'bg-rose-50 border-rose-300 text-rose-700 active:bg-rose-100',
            sky:    'bg-sky-50 border-sky-200 text-sky-700 active:bg-sky-100',
          };
          const handleJump = (it: typeof items[number]) => {
            if (it.filter) setStoreFilter(it.filter);
            setTimeout(() => {
              const el = document.querySelector(it.anchor);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
          };
          const downloadCsv = async (path: string, defaultName: string) => {
            if (!token) return;
            try {
              const r = await authedFetch(`${BASE}${path}`, { headers: {} });
              if (!r.ok) { toast({ title: 'ダウンロード失敗', description: `HTTP ${r.status}`, variant: 'destructive' }); return; }
              const blob = await r.blob();
              const url  = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = defaultName;
              document.body.appendChild(a); a.click();
              document.body.removeChild(a); URL.revokeObjectURL(url);
            } catch (err: any) {
              toast({ title: 'ダウンロード失敗', description: err?.message ?? '不明なエラー', variant: 'destructive' });
            }
          };
          return (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
              <div className="rounded-2xl border-2 bg-white p-3 shadow-sm"
                style={{ borderColor: totalAlerts > 0 ? '#fecaca' : '#e5e7eb' }}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center ${totalAlerts > 0 ? 'bg-red-100' : 'bg-emerald-100'}`}>
                      {totalAlerts > 0 ? <AlertTriangle className="w-4 h-4 text-red-600" /> : <ShieldCheck className="w-4 h-4 text-emerald-600" />}
                    </div>
                    <h2 className="text-sm font-black text-gray-900">
                      要対応 <span className={totalAlerts > 0 ? 'text-red-600' : 'text-emerald-600'}>{totalAlerts}</span> 件
                    </h2>
                  </div>
                  <button
                    onClick={fetchAll}
                    className="text-[11px] font-bold text-gray-500 active:text-gray-900 px-3 py-2 -mr-2"
                    aria-label="再読み込み"
                  >🔄 更新</button>
                </div>
                {visible.length === 0 ? (
                  <p className="text-xs text-emerald-700 font-bold py-2 text-center bg-emerald-50 rounded-lg">
                    ✨ 全て対応済み・異常なし
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {visible.map(it => {
                      const Icon = it.icon;
                      return (
                        <button
                          key={it.key}
                          onClick={() => handleJump(it)}
                          className={`min-h-[56px] rounded-xl border-2 px-3 py-2 text-left transition-colors flex items-center gap-2 ${colorMap[it.color]}`}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-bold leading-tight truncate">{it.label}</p>
                            <p className="text-lg font-black leading-tight">{it.n}件</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* CSV エクスポート */}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">📥 CSV エクスポート (Excel 対応)</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      onClick={() => downloadCsv('/api/admin/export/stores.csv', `osusowake_stores_${new Date().toISOString().slice(0,10)}.csv`)}
                      className="min-h-[44px] rounded-lg bg-gray-100 active:bg-gray-200 text-[11px] font-bold text-gray-700 px-2 py-1.5"
                    >店舗一覧</button>
                    <button
                      onClick={() => downloadCsv('/api/admin/export/reservations.csv', `osusowake_reservations_${new Date().toISOString().slice(0,10)}.csv`)}
                      className="min-h-[44px] rounded-lg bg-gray-100 active:bg-gray-200 text-[11px] font-bold text-gray-700 px-2 py-1.5"
                    >予約全件</button>
                    <button
                      onClick={() => downloadCsv('/api/admin/export/sales-summary.csv', `osusowake_sales_summary_${new Date().toISOString().slice(0,10)}.csv`)}
                      className="min-h-[44px] rounded-lg bg-gray-100 active:bg-gray-200 text-[11px] font-bold text-gray-700 px-2 py-1.5"
                    >月次売上</button>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })()}

        {/* ═══ 📈 GROWTH GOD MODE（成長の神モード） ═══ */}
        <div id="growth-section" />
        {growth && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="rounded-2xl border-2 border-emerald-200 bg-gradient-to-b from-emerald-50/60 to-white p-3 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                </div>
                <h2 className="text-sm font-black text-gray-900">📈 成長コックピット</h2>
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">GOD MODE</span>
              </div>

              {/* ① 供給の脈拍 — 今この瞬間、買える在庫があるか */}
              {(() => {
                const s = growth.supply;
                const healthy = s.storesWithLiveBags >= 10;
                return (
                  <div className={`rounded-xl border-2 p-3 ${healthy ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-300 bg-amber-50/60'}`}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Zap className={`w-3.5 h-3.5 ${healthy ? 'text-emerald-600' : 'text-amber-600'}`} />
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-600">供給の脈拍（いま買える在庫）</p>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div>
                        <p className={`text-2xl font-black leading-none ${healthy ? 'text-emerald-600' : 'text-amber-600'}`}>{s.storesWithLiveBags}</p>
                        <p className="text-[9px] font-bold text-gray-500 mt-1">出品中の店</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black leading-none text-gray-800">{s.liveBags}</p>
                        <p className="text-[9px] font-bold text-gray-500 mt-1">ライブ袋</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black leading-none text-gray-800">{s.liveStockUnits}</p>
                        <p className="text-[9px] font-bold text-gray-500 mt-1">在庫個数</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black leading-none text-gray-400">{s.approvedActiveStores}</p>
                        <p className="text-[9px] font-bold text-gray-500 mt-1">承認済み店</p>
                      </div>
                    </div>
                    {!healthy && (
                      <p className="text-[10px] font-bold text-amber-700 mt-2 leading-snug">
                        ⚠️ ライブ在庫の店が少ない。開いたユーザーに「何もない」を見せると離脱する。下の死に店を叩き起こそう。
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* ② アクティベーション・ファネル */}
              {(() => {
                const fn = growth.funnel;
                const steps = [
                  { label: '登録ユーザー', n: fn.registered, sub: `直近7日 +${fn.newUsers7d}`, color: 'bg-slate-500' },
                  { label: 'お気に入り登録', n: fn.favorited, sub: `登録の ${fn.rates.registerToFav}%`, color: 'bg-sky-500' },
                  { label: '初回購入', n: fn.buyers, sub: `登録の ${fn.rates.registerToBuy}%`, color: 'bg-emerald-500' },
                  { label: 'リピーター', n: fn.repeatBuyers, sub: `購入者の ${fn.rates.buyToRepeat}%`, color: 'bg-amber-500' },
                ];
                const max = Math.max(fn.registered, 1);
                return (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-600 mb-2">アクティベーション・ファネル</p>
                    <div className="space-y-1.5">
                      {steps.map((st) => (
                        <div key={st.label} className="flex items-center gap-2">
                          <div className="w-20 text-[10px] font-bold text-gray-600 text-right shrink-0">{st.label}</div>
                          <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden relative">
                            <div className={`${st.color} h-full rounded-full transition-all flex items-center`}
                              style={{ width: `${Math.max((st.n / max) * 100, 4)}%` }} />
                            <div className="absolute inset-0 flex items-center px-2 gap-1.5">
                              <span className="text-[11px] font-black text-gray-900">{st.n.toLocaleString()}</span>
                              <span className="text-[9px] font-bold text-gray-500">{st.sub}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* ③ ホットリード → ワンタップ再エンゲージ */}
              {(() => {
                const hl = growth.hotLeads;
                const leads = [
                  {
                    seg: 'fav_no_purchase' as const,
                    label: 'お気に入り済み・未購入',
                    n: hl.favNoPurchase,
                    hint: '興味を示したのに買ってない層。刈り取れば即GMV。',
                  },
                  {
                    seg: 'registered_no_purchase_7d' as const,
                    label: '直近7日登録・未購入',
                    n: hl.registered7dNoPurchase,
                    hint: '新鮮なうちに背中を押すべき層。',
                  },
                ];
                return (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Flame className="w-3.5 h-3.5 text-orange-500" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-600">ホットリード（あと一押しで買う）</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {leads.map((ld) => (
                        <div key={ld.seg} className="rounded-xl border-2 border-orange-200 bg-orange-50/50 p-2.5 flex flex-col">
                          <p className="text-2xl font-black text-orange-600 leading-none">{ld.n}<span className="text-xs font-bold text-gray-400 ml-1">人</span></p>
                          <p className="text-[10px] font-bold text-gray-700 mt-1 leading-tight">{ld.label}</p>
                          <p className="text-[9px] text-gray-500 mt-0.5 leading-snug flex-1">{ld.hint}</p>
                          <button
                            disabled={ld.n === 0 || reengageSeg !== null}
                            onClick={() => reengageSegment(ld.seg, ld.label)}
                            className="mt-2 min-h-[38px] rounded-lg bg-orange-500 active:bg-orange-600 disabled:opacity-40 text-white text-[11px] font-black px-2 py-1.5 flex items-center justify-center gap-1"
                          >
                            {reengageSeg === ld.seg ? '送信中…' : (<><Send className="w-3 h-3" />この層にPush</>)}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* ④ 週次成長トレンド */}
              {growth.weeklyTrend.length > 0 && (
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-600 mb-2">週次トレンド（新規登録 / 購入者 / GMV）</p>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={growth.weeklyTrend} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="week" tick={{ fontSize: 9 }} />
                      <YAxis tick={{ fontSize: 9 }} />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Bar dataKey="newUsers" name="新規登録" fill="#94a3b8" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="buyers" name="購入者" fill="#10b981" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* ⑤ 死に店舗アラート — 営業フォロー対象 */}
              {(() => {
                const dead = growth.deadStores;
                if (dead.length === 0) {
                  return <p className="text-[11px] font-bold text-emerald-700 bg-emerald-50 rounded-lg py-2 text-center">✨ 承認済み店はすべて稼働中</p>;
                }
                return (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-600">
                        死に店舗 <span className="text-red-600">{dead.length}</span> 店（承認済みだが未稼働＝営業フォロー対象）
                      </p>
                    </div>
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {dead.map((d) => {
                        const zeroSales = d.orders === 0;
                        const noBag = d.liveBags === 0;
                        return (
                          <div key={d.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-bold text-gray-900 truncate">{d.name}</p>
                              <p className="text-[9px] text-gray-500">{d.city}・#{d.id}</p>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              {zeroSales && <span className="text-[9px] font-black text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">売上0</span>}
                              {noBag && <span className="text-[9px] font-black text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">在庫なし</span>}
                              {d.daysSinceLastBag != null && d.daysSinceLastBag >= 1 && (
                                <span className="text-[9px] font-black text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">{d.daysSinceLastBag}日出品なし</span>
                              )}
                              {d.lastBagAt == null && (
                                <span className="text-[9px] font-black text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">出品履歴なし</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </motion.div>
        )}

        {/* ── 🚨 営業許可証 問題バナー ── */}
        <div id="license-section" />
        {licenseIssues.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <div className="rounded-2xl border-2 border-red-300 bg-gradient-to-br from-red-50 to-rose-50 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <FileWarning className="w-5 h-5 text-red-600" />
                <h2 className="text-sm font-black text-red-900">営業許可証 問題あり</h2>
                <span className="ml-auto text-[10px] font-black bg-red-600 text-white px-2 py-0.5 rounded-full">
                  {licenseIssues.length}件
                </span>
              </div>
              <p className="text-[11px] text-red-700/80 mb-3 leading-relaxed">
                これらの店舗は営業許可証画像が欠落しています。ASC 提出前に再アップロードを要求してください。
              </p>
              <div className="space-y-2">
                {licenseIssues.slice(0, 10).map(issue => (
                  <div key={issue.id} className="bg-white rounded-xl border border-red-200 p-3">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-sm font-black text-gray-900 truncate">{issue.name}</span>
                          {issue.severity === 'high' && (
                            <span className="text-[9px] font-black bg-red-600 text-white px-1.5 py-0.5 rounded">緊急</span>
                          )}
                          {issue.severity === 'medium' && (
                            <span className="text-[9px] font-black bg-orange-500 text-white px-1.5 py-0.5 rounded">中</span>
                          )}
                        </div>
                        <div className="text-[10px] text-gray-500 flex flex-wrap gap-x-2 gap-y-0.5">
                          <span>#{issue.id}</span>
                          <span>{issue.status}</span>
                          {issue.city && <span>{issue.city}</span>}
                          {!issue.stripe_account_id && <span className="text-amber-600 font-bold">テスト店</span>}
                        </div>
                      </div>
                    </div>
                    <div className="text-[10px] text-red-700 mb-2 bg-red-50 rounded px-2 py-1">
                      {issue.issue_type === 'upload_failed' && '⚠️ アップロード失敗'}
                      {issue.issue_type === 'image_missing_but_number_set' && '⚠️ 番号のみ登録（画像欠落）'}
                      {issue.issue_type === 'no_license_at_all' && '⚠️ 許可証情報なし'}
                      {issue.license_upload_error && (
                        <div className="mt-0.5 text-[9px] text-red-600/70 truncate">{issue.license_upload_error}</div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Link href={`/admin/store/${issue.id}`}>
                        <button className="text-[11px] font-bold text-red-700 hover:text-red-900 px-2 py-1 rounded bg-white border border-red-200">
                          詳細
                        </button>
                      </Link>
                      <button
                        onClick={() => requestLicenseReupload(issue.id)}
                        disabled={reuploadLoading === issue.id}
                        className="text-[11px] font-bold text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded disabled:opacity-50"
                      >
                        {reuploadLoading === issue.id ? '…' : '再アップ要求'}
                      </button>
                    </div>
                  </div>
                ))}
                {licenseIssues.length > 10 && (
                  <p className="text-[10px] text-red-600/70 text-center pt-1">
                    他 {licenseIssues.length - 10}件…
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── テスト店フィルタ ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
          <div className="rounded-2xl bg-white border border-gray-200 p-3 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500" />
              <div>
                <p className="text-xs font-black text-gray-900">テスト店舗を集計から除外</p>
                <p className="text-[10px] text-gray-500">stripe_account_id IS NULL の店舗を除外します</p>
              </div>
            </div>
            <button
              onClick={() => setExcludeTest(v => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${excludeTest ? 'bg-purple-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${excludeTest ? 'left-5' : 'left-0.5'}`} />
            </button>
          </div>
        </motion.div>

        {/* ── 売上ブレイクダウン ── */}
        {metrics?.breakdown && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <BadgeDollarSign className="w-4 h-4 text-emerald-600" />
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-700">売上内訳</h2>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-100">
                  <p className="text-[10px] text-emerald-700/70 font-bold">受取済み GMV</p>
                  <p className="text-xl font-black text-emerald-700">¥{fmt(metrics.breakdown.gmvPickedUp)}</p>
                  <p className="text-[10px] text-emerald-600/70 mt-0.5">{fmt(metrics.breakdown.countPickedUp)}件</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-3 border border-blue-100">
                  <p className="text-[10px] text-blue-700/70 font-bold">予約確定 GMV</p>
                  <p className="text-xl font-black text-blue-700">¥{fmt(metrics.breakdown.gmvConfirmed)}</p>
                  <p className="text-[10px] text-blue-600/70 mt-0.5">{fmt(metrics.breakdown.countConfirmed)}件</p>
                </div>
                <div className="bg-rose-50 rounded-xl p-3 border border-rose-100">
                  <p className="text-[10px] text-rose-700/70 font-bold">キャンセル</p>
                  <p className="text-xl font-black text-rose-700">¥{fmt(metrics.breakdown.gmvCancelled)}</p>
                  <p className="text-[10px] text-rose-600/70 mt-0.5">{fmt(metrics.breakdown.countCancelled)}件</p>
                </div>
                <div className="bg-purple-50 rounded-xl p-3 border border-purple-100">
                  <p className="text-[10px] text-purple-700/70 font-bold">平均購入単価</p>
                  <p className="text-xl font-black text-purple-700">¥{fmt(metrics.breakdown.avgPrice)}</p>
                  <p className="text-[10px] text-purple-600/70 mt-0.5">受取ユーザー {metrics.breakdown.pickupUsers}人</p>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── 直近30日 売上推移 ── */}
        {metrics?.dailySeries && metrics.dailySeries.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="w-4 h-4 text-purple-600" />
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-700">直近30日 売上推移</h2>
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={metrics.dailySeries} margin={{ top: 5, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 9, fill: '#6b7280' }}
                      tickFormatter={(d: string) => d.slice(5)}
                    />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e5e7eb' }}
                      formatter={(v: number) => [`¥${fmt(v)}`, 'GMV']}
                    />
                    <Line
                      type="monotone"
                      dataKey="gmv"
                      stroke="#7c3aed"
                      strokeWidth={2.5}
                      dot={{ r: 2, fill: '#7c3aed' }}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── 店舗ランキング TOP5 ── */}
        {metrics?.storeRanking && metrics.storeRanking.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Award className="w-4 h-4 text-amber-600" />
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-700">売上ランキング TOP5</h2>
              </div>
              <div className="space-y-2">
                {metrics.storeRanking.map((s, idx) => {
                  const max = metrics.storeRanking![0].gmv || 1;
                  const pct = Math.max(2, (s.gmv / max) * 100);
                  return (
                    <Link key={s.id} href={`/admin/store/${s.id}`}>
                      <div className="cursor-pointer hover:bg-gray-50 rounded-lg p-2 transition-colors">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <span className={`text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center ${
                              idx === 0 ? 'bg-amber-400 text-white' :
                              idx === 1 ? 'bg-gray-300 text-gray-700' :
                              idx === 2 ? 'bg-orange-300 text-white' :
                              'bg-gray-100 text-gray-600'
                            }`}>{idx + 1}</span>
                            <span className="text-xs font-bold text-gray-900 truncate">{s.name}</span>
                            {s.isTest && (
                              <span className="text-[9px] font-bold bg-amber-100 text-amber-700 px-1.5 rounded">テ</span>
                            )}
                          </div>
                          <span className="text-xs font-black text-purple-600 shrink-0">¥{fmt(s.gmv)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-purple-500 to-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
                          <span>{s.reservations}件 / 受取{s.pickedUpCount}</span>
                          <span className={s.pickupRate >= 0.7 ? 'text-emerald-600 font-bold' : s.pickupRate < 0.3 ? 'text-red-600 font-bold' : ''}>
                            受取率 {Math.round(s.pickupRate * 100)}%
                          </span>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── 時間帯ヒートマップ ── */}
        {metrics?.hourlyHeatmap && metrics.hourlyHeatmap.length === 7 && (() => {
          const flat = metrics.hourlyHeatmap.flat();
          const maxV = Math.max(1, ...flat);
          const days = ['日', '月', '火', '水', '木', '金', '土'];
          return (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
              <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <Flame className="w-4 h-4 text-orange-500" />
                  <h2 className="text-xs font-black uppercase tracking-widest text-gray-700">予約時間帯 ヒートマップ</h2>
                </div>
                <div className="overflow-x-auto -mx-1 px-1">
                  <div className="min-w-[480px]">
                    <div className="flex gap-px mb-1 ml-5">
                      {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="flex-1 text-[8px] text-gray-400 text-center" style={{ minWidth: 14 }}>
                          {h % 6 === 0 ? h : ''}
                        </div>
                      ))}
                    </div>
                    {metrics.hourlyHeatmap.map((row, di) => (
                      <div key={di} className="flex items-center gap-1 mb-px">
                        <div className="w-4 text-[9px] font-bold text-gray-500 text-right">{days[di]}</div>
                        <div className="flex gap-px flex-1">
                          {row.map((v, hi) => {
                            const intensity = v / maxV;
                            const bg = v === 0
                              ? '#f3f4f6'
                              : `rgba(124, 58, 237, ${0.2 + intensity * 0.8})`;
                            return (
                              <div
                                key={hi}
                                title={`${days[di]} ${hi}:00 — ${v}件`}
                                className="flex-1 h-4 rounded-sm"
                                style={{ background: bg, minWidth: 14 }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 mt-2 text-center">
                  予約作成時刻の分布（直近30日）
                </p>
              </div>
            </motion.div>
          );
        })()}

        {/* ── ファネル ── */}
        {metrics?.breakdown && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <BarChart2 className="w-4 h-4 text-blue-600" />
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-700">予約ファネル</h2>
              </div>
              {(() => {
                const b = metrics.breakdown!;
                const total = b.countPending + b.countConfirmed + b.countPickedUp + b.countCancelled;
                const stages = [
                  { label: '予約作成', count: total, color: 'bg-gray-500' },
                  { label: '確定', count: b.countConfirmed + b.countPickedUp, color: 'bg-blue-500' },
                  { label: '受取完了', count: b.countPickedUp, color: 'bg-emerald-500' },
                ];
                const cancelRate = total > 0 ? b.countCancelled / total : 0;
                return (
                  <>
                    <div className="space-y-2">
                      {stages.map((st, i) => {
                        const pct = total > 0 ? (st.count / total) * 100 : 0;
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className="font-bold text-gray-700">{st.label}</span>
                              <span className="font-black text-gray-900">{st.count}件 ({Math.round(pct)}%)</span>
                            </div>
                            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className={`h-full ${st.color} rounded-full transition-all`} style={{ width: `${Math.max(2, pct)}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
                      <span className="text-[10px] text-gray-500">キャンセル率</span>
                      <span className={`text-xs font-black ${cancelRate >= 0.3 ? 'text-red-600' : cancelRate >= 0.15 ? 'text-orange-500' : 'text-emerald-600'}`}>
                        {Math.round(cancelRate * 100)}% ({b.countCancelled}件)
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>
          </motion.div>
        )}

        {/* ── 異常検知 ── */}
        <div id="anomalies-section" />
        {metrics?.anomalies && (
          metrics.anomalies.stalePendingCount > 0 ||
          metrics.anomalies.highCancelStores.length > 0 ||
          metrics.anomalies.licenseIssueCount > 0
        ) && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16 }}>
            <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-amber-600" />
                <h2 className="text-xs font-black uppercase tracking-widest text-amber-900">異常検知</h2>
              </div>
              <div className="space-y-2">
                {metrics.anomalies.stalePendingCount > 0 && (
                  <div className="bg-white rounded-lg p-2.5 border border-amber-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-amber-600" />
                        <span className="text-xs font-bold text-gray-900">24時間以上 pending</span>
                      </div>
                      <span className="text-sm font-black text-amber-700">{metrics.anomalies.stalePendingCount}件</span>
                    </div>
                  </div>
                )}
                {metrics.anomalies.licenseIssueCount > 0 && (
                  <div className="bg-white rounded-lg p-2.5 border border-amber-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileWarning className="w-3.5 h-3.5 text-red-600" />
                        <span className="text-xs font-bold text-gray-900">許可証問題</span>
                      </div>
                      <span className="text-sm font-black text-red-700">{metrics.anomalies.licenseIssueCount}件</span>
                    </div>
                  </div>
                )}
                {metrics.anomalies.highCancelStores.map(s => (
                  <Link key={s.id} href={`/admin/store/${s.id}`}>
                    <div className="bg-white rounded-lg p-2.5 border border-amber-200 cursor-pointer hover:bg-amber-50">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <TrendingDown className="w-3.5 h-3.5 text-red-600 shrink-0" />
                          <span className="text-xs font-bold text-gray-900 truncate">{s.name}</span>
                        </div>
                        <span className="text-xs font-black text-red-700 shrink-0">
                          キャンセル率 {Math.round(s.rate * 100)}% ({s.cancelled}/{s.total})
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── 定期出品モニター（神モード：全店の自動出品を今日の状態付きで監視）── */}
        <div id="recurring-section" />
        {recurringMon && recurringMon.listings.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />定期出品モニター
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {recurringMon.today} {recurringMon.nowTime} 時点
                </span>
                <button
                  onClick={fetchAll}
                  className="text-[10px] font-bold px-2 py-1 rounded-lg bg-secondary text-muted-foreground hover:bg-border transition-colors flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />更新
                </button>
              </div>
            </div>

            {/* 未公開アラート バナー（公開時刻を過ぎたのにバッグが無い＝公開漏れ） */}
            {recurringMon.summary.alert > 0 && (
              <div className="mb-3 rounded-xl bg-red-50 border border-red-300 px-3 py-2.5 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-black text-red-800">
                    {recurringMon.summary.alert}件が公開時刻を過ぎても未公開です
                  </p>
                  <p className="text-[10px] text-red-600 leading-relaxed">
                    自動公開が漏れている可能性があります。 該当テンプレの店舗ステータス・在庫・休み設定を確認してください。
                  </p>
                </div>
              </div>
            )}

            {/* KPI サマリー（タップで絞り込み） */}
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5 mb-4">
              {([
                { key: 'all' as const,       label: '全て',   val: recurringMon.summary.total },
                { key: 'alert' as const,     label: '未公開', val: recurringMon.summary.alert },
                { key: 'live' as const,      label: '出品中', val: recurringMon.summary.live },
                { key: 'pending' as const,   label: '予定',   val: recurringMon.summary.pending },
                { key: 'soldout' as const,   label: '完売',   val: recurringMon.summary.soldout },
                { key: 'withdrawn' as const, label: '停止',   val: recurringMon.summary.withdrawn },
                { key: 'off' as const,       label: '休み',   val: recurringMon.summary.off },
              ]).map((kpi) => {
                const active = recurringFilter === kpi.key;
                const meta = kpi.key === 'all' ? null : RECURRING_STATUS_META[kpi.key];
                return (
                  <button
                    key={kpi.key}
                    onClick={() => setRecurringFilter(active ? 'all' : kpi.key)}
                    className={`rounded-xl border px-2 py-2 text-center transition-all ${
                      active ? 'ring-2 ring-offset-1 ring-primary bg-white' : 'bg-white/60 hover:bg-white'
                    } ${meta ? meta.cls : 'border-border text-foreground'}`}
                  >
                    <div className="text-lg font-black leading-none tabular-nums">{kpi.val}</div>
                    <div className="text-[9px] font-bold mt-1 flex items-center justify-center gap-0.5">
                      {meta && <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />}
                      {kpi.label}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 一覧（状態優先→公開時刻順）*/}
            <div className="space-y-2">
              {[...recurringMon.listings]
                .filter((l) => recurringFilter === 'all' || l.status === recurringFilter)
                .sort((a, b) => {
                  const oa = RECURRING_STATUS_META[a.status].order;
                  const ob = RECURRING_STATUS_META[b.status].order;
                  if (oa !== ob) return oa - ob;
                  return a.publishTime.localeCompare(b.publishTime);
                })
                .map((l) => {
                  const meta = RECURRING_STATUS_META[l.status];
                  const pickup = l.pickupStart && l.pickupEnd
                    ? `${l.pickupStart}–${l.pickupEnd}${l.pickupStart2 && l.pickupEnd2 ? ` / ${l.pickupStart2}–${l.pickupEnd2}` : ''}`
                    : null;
                  return (
                    <div key={l.id} className={`rounded-xl border bg-white overflow-hidden ${
                      l.status === 'alert' ? 'border-red-300' : 'border-border'
                    }`}>
                      <div className="flex items-stretch">
                        {/* 状態カラーバー */}
                        <div className={`w-1.5 shrink-0 ${meta.dot}`} />
                        <div className="flex-1 min-w-0 p-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-md border ${meta.cls}`}>
                                  {meta.emoji} {meta.label}
                                </span>
                                <span className="text-[10px] text-muted-foreground truncate">
                                  <Store className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                                  {l.storeName}
                                  <span className="text-muted-foreground/50"> #{l.storeId}</span>
                                </span>
                              </div>
                              <p className="text-sm font-bold text-foreground mt-1 truncate">{l.title}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-xs font-black text-foreground tabular-nums flex items-center gap-1 justify-end">
                                <Clock className="w-3 h-3 text-muted-foreground" />{l.publishTime}
                              </div>
                              <div className="text-[9px] text-muted-foreground mt-0.5">{formatDaysOfWeek(l.daysOfWeek)}</div>
                            </div>
                          </div>

                          {/* メタ行：属性チップ */}
                          <div className="flex items-center gap-1 flex-wrap mt-2">
                            {l.pickupNextDay
                              ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">前日出品→翌日受取</span>
                              : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">当日出品→当日受取</span>}
                            {l.carryOverStock && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-600">在庫持ち越し</span>}
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground tabular-nums">¥{fmt(l.discountedPrice)}</span>
                            {pickup && <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground tabular-nums">受取 {pickup}</span>}
                          </div>

                          {/* ステータス別 詳細行 */}
                          <div className="mt-2 text-[11px] text-foreground/80 leading-relaxed">
                            {l.status === 'live' && (
                              <span>在庫 <b className="tabular-nums">{l.liveStock}</b> 個公開中
                                {l.reservedQty > 0 && <> ・予約 <b className="tabular-nums">{l.reservedQty}</b>個（決済済 {l.paidQty}）</>}
                              </span>
                            )}
                            {l.status === 'pending' && (
                              <span className="text-blue-700">本日 <b>{l.publishTime}</b> に自動公開予定（在庫 {l.stockCount}個）</span>
                            )}
                            {l.status === 'soldout' && (
                              <span className="text-rose-700">本日分は完売（在庫0）{l.carryOverStock && <>・在庫を入れ直すと再開</>}</span>
                            )}
                            {l.status === 'alert' && (
                              <span className="text-red-700 font-bold">
                                {l.publishTime} を過ぎても未公開。 店舗ステータス={l.storeStatus}
                                {l.lastPublishedDate && <>・最終公開 {l.lastPublishedDate}</>}
                              </span>
                            )}
                            {l.status === 'withdrawn' && (
                              <span className="text-gray-600">店がテンプレを停止中（{l.updatedJst} 更新）。 再開するまで自動公開されません</span>
                            )}
                            {l.status === 'ended' && (
                              <span className="text-slate-500">本日は公開済み・受取窓終了。 次回 {l.nextPublishDate ?? '—'}</span>
                            )}
                            {l.status === 'off' && (
                              <span className="text-amber-700">
                                {l.skippedToday ? '本日は休みに設定' : '本日は公開曜日ではありません'}・次回 {l.nextPublishDate ?? '—'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </motion.div>
        )}

        {/* ── 店舗審査パネル ── */}
        <div id="stores-section" />
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5" />店舗管理
            </h2>
            {stores.filter(s => s.status === 'applied').length > 0 && (
              <span className="text-[11px] font-black bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                <Clock className="w-3 h-3" />{stores.filter(s => s.status === 'applied').length}件 KYC審査中
              </span>
            )}
          </div>

          {/* フィルタータブ */}
          <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
            {([
              { key: 'applied',        label: 'KYC審査中',  urgent: stores.filter(s => s.status === 'applied').length > 0 },
              { key: 'pending',        label: '口座未登録',  urgent: false },
              { key: 'pending_review', label: '要確認',      urgent: stores.filter(s => s.status === 'pending_review').length > 0 },
              { key: 'approved',       label: '公開中',       urgent: false },
              { key: 'suspended',      label: '停止/却下',    urgent: false },
              { key: 'all',            label: 'すべて',       urgent: false },
            ] as { key: typeof storeFilter; label: string; urgent: boolean }[]).map(f => {
              const tabCount = (() => {
                if (f.key === 'applied')        return stores.filter(s => s.status === 'applied').length;
                if (f.key === 'pending')        return stores.filter(s => s.status === 'pending').length;
                if (f.key === 'pending_review') return stores.filter(s => s.status === 'pending_review').length;
                if (f.key === 'approved')       return stores.filter(s => s.status === 'approved' && s.is_active).length;
                if (f.key === 'suspended')      return stores.filter(s => s.status === 'suspended' || s.status === 'rejected' || (s.status === 'approved' && !s.is_active)).length;
                return stores.length;
              })();
              return (
                <button key={f.key} onClick={() => { setStoreFilter(f.key); setShowAllStores(false); }}
                  className={`relative px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${storeFilter === f.key ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground hover:bg-secondary/80'}`}>
                  {f.label} ({tabCount})
                  {f.urgent && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-blue-500 rounded-full" />}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-28 bg-secondary/50 rounded-2xl animate-pulse" />)}
            </div>
          ) : filteredStores.length === 0 ? (
            <div className="bg-secondary/30 rounded-2xl p-8 text-center">
              <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto mb-3 opacity-60" />
              <p className="font-bold text-foreground">
                {storeFilter === 'applied'        ? 'KYC審査中の店舗はありません'
                 : storeFilter === 'pending'      ? '口座未登録の店舗はありません'
                 : storeFilter === 'pending_review'? '要確認の店舗はありません'
                 : '該当する店舗はありません'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {displayedStores.map(store => {
                const badge = statusBadge(store);
                const isProcessing = actionLoading === store.id;
                const isStorePending = isPending(store);
                const isApprovedActive = store.status === 'approved' && store.is_active;
                const isSuspended = !store.is_active || store.status === 'suspended' || store.status === 'rejected';
                return (
                  <motion.div key={store.id}
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className="bg-card border border-border/60 rounded-2xl overflow-hidden"
                  >
                    {/* タップで展開 */}
                    <button
                      type="button"
                      onClick={() => toggleExpand(store.id)}
                      className="w-full text-left"
                    >
                      <div className="p-4">
                        <div className="flex items-start gap-3">
                          {(store.icon_url || store.image_url) ? (
                            <img loading="lazy" decoding="async" src={store.icon_url || store.image_url || ''} alt={store.name} className="w-12 h-12 rounded-xl object-cover shrink-0" />
                          ) : (
                            <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-2xl">🏪</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-black text-foreground">{store.name}</h3>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                              {(store.owner_store_count ?? 1) >= 2 && (
                                <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-300 flex items-center gap-0.5">
                                  🏪 {store.owner_store_rank ?? '?'}店舗目 / 計{store.owner_store_count}店
                                </span>
                              )}
                              {store.stripe_account_id && (() => {
                                // storeDetails のライブ値を優先、なければ DB 値を使う
                                const d = storeDetails[store.id];
                                const chargesOk = d?.stripe_charges_enabled ?? store.stripe_charges_enabled;
                                const payoutsOk = d?.stripe_payouts_enabled ?? store.stripe_payouts_enabled;
                                if (stripeErrors[store.id]) {
                                  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-300">🔴 連携エラー</span>;
                                }
                                // payouts_enabled=true は完全認証済み（最優先）
                                if (payoutsOk === true) {
                                  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">✅ Stripe有効・入金可</span>;
                                }
                                if (chargesOk === true) {
                                  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700">⚠️ Stripe有効・入金停止</span>;
                                }
                                if (chargesOk === false) {
                                  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">❌ Stripe制限中</span>;
                                }
                                return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">Stripe未確認</span>;
                              })()}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{store.address}</p>
                            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                              <span className="flex items-center gap-0.5"><Package className="w-3 h-3" />{store.bag_count}個</span>
                              <span className="flex items-center gap-0.5"><Receipt className="w-3 h-3" />{store.reservation_count}件</span>
                              <span className="text-primary font-bold">¥{fmt(Number(store.revenue ?? 0))}</span>
                            </div>
                          </div>
                          <div className="shrink-0 text-muted-foreground/50">
                            {expandedStore === store.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </div>
                        </div>
                      </div>
                    </button>

                    {/* 展開詳細パネル */}
                    <AnimatePresence>
                      {expandedStore === store.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 space-y-4 border-t border-border/40 pt-3">

                            {/* 売上サマリー */}
                            <div className="grid grid-cols-3 gap-2">
                              <div className="bg-emerald-50 rounded-xl p-3 text-center">
                                <p className="text-base font-black text-emerald-700">¥{fmt(Number(store.revenue ?? 0))}</p>
                                <p className="text-[10px] text-emerald-600/70 mt-0.5">累計売上</p>
                              </div>
                              <div className="bg-sky-50 rounded-xl p-3 text-center">
                                <p className="text-base font-black text-sky-700">{store.reservation_count}</p>
                                <p className="text-[10px] text-sky-600/70 mt-0.5">総予約数</p>
                              </div>
                              <div className="bg-purple-50 rounded-xl p-3 text-center">
                                <p className="text-base font-black text-purple-700">{store.bag_count}</p>
                                <p className="text-[10px] text-purple-600/70 mt-0.5">バッグ数</p>
                              </div>
                            </div>

                            {/* 詳細ロード中スピナー */}
                            {detailLoading === store.id && (
                              <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                                <RefreshCw className="w-4 h-4 animate-spin" />詳細を取得中...
                              </div>
                            )}

                            {/* 詳細データ */}
                            {(() => {
                              const d = storeDetails[store.id];
                              if (!d) return null;

                              // ── 偽造店舗検出 (本物の店舗を勝手に登録するなりすまし対策) ──
                              const myAddrKey = normalizeStoreText(d.address) + normalizeStoreText(d.city);
                              const myNameKey = normalizeStoreText(d.name);
                              const myPhoneKey = normalizePhone(d.phone);
                              const myStripe = d.stripe_account_id;

                              const sameAddressOthers = stores.filter(s =>
                                s.id !== d.id &&
                                s.owner_id !== d.owner_id &&
                                normalizeStoreText(s.address) + normalizeStoreText(s.city) === myAddrKey &&
                                myAddrKey.length > 0
                              );
                              const sameNameOthers = stores.filter(s =>
                                s.id !== d.id &&
                                s.owner_id !== d.owner_id &&
                                normalizeStoreText(s.name) === myNameKey &&
                                myNameKey.length > 0
                              );
                              const sameStripeOthers = stores.filter(s =>
                                s.id !== d.id &&
                                s.owner_id !== d.owner_id &&
                                myStripe && s.stripe_account_id === myStripe
                              );
                              // 同電話番号は storeDetails (詳細を開いた店舗のみ) から検索
                              const samePhoneOthers = myPhoneKey
                                ? Object.values(storeDetails).filter(other =>
                                    other.id !== d.id &&
                                    other.owner_id !== d.owner_id &&
                                    normalizePhone(other.phone) === myPhoneKey
                                  )
                                : [];

                              const hasFraudWarning =
                                sameAddressOthers.length > 0 ||
                                sameNameOthers.length > 0 ||
                                sameStripeOthers.length > 0 ||
                                samePhoneOthers.length > 0;

                              // Google 検索リンク (実在性確認用)
                              const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(`${d.name} ${d.city ?? ''} ${d.address}`)}`;
                              const googleMapsSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(`${d.name} ${d.city ?? ''} ${d.address}`)}`;

                              return (
                                <div className="space-y-3">

                                  {/* 却下理由バナー */}
                                  {store.status === 'rejected' && store.rejection_reason && (
                                    <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                                      <p className="text-[11px] font-black text-red-600 mb-1">却下理由</p>
                                      <p className="text-xs text-red-700 leading-relaxed">{store.rejection_reason}</p>
                                    </div>
                                  )}

                                  {/* 🚨 偽造店舗の疑いバナー (別オーナで同名/同住所/同電話/同Stripe) */}
                                  {hasFraudWarning && (
                                    <div className="bg-red-50 border-2 border-red-400 rounded-xl p-3 space-y-2">
                                      <p className="text-[11px] font-black text-red-700 flex items-center gap-1.5">
                                        <AlertTriangle className="w-3.5 h-3.5" />
                                        🚨 重複の疑い — 偽造店舗かも
                                      </p>
                                      <div className="space-y-1 text-[11px] text-red-700">
                                        {sameAddressOthers.length > 0 && (
                                          <p>・別オーナで <b>同じ住所</b> の店舗が {sameAddressOthers.length} 件: {sameAddressOthers.map(s => `#${s.id} ${s.name}`).join(' / ')}</p>
                                        )}
                                        {sameNameOthers.length > 0 && (
                                          <p>・別オーナで <b>同じ店名</b> の店舗が {sameNameOthers.length} 件: {sameNameOthers.map(s => `#${s.id} ${s.name}`).join(' / ')}</p>
                                        )}
                                        {samePhoneOthers.length > 0 && (
                                          <p>・別オーナで <b>同じ電話番号</b> の店舗が {samePhoneOthers.length} 件: {samePhoneOthers.map(s => `#${s.id} ${s.name}`).join(' / ')}</p>
                                        )}
                                        {sameStripeOthers.length > 0 && (
                                          <p>・別オーナで <b>同じ Stripe アカウント</b> の店舗が {sameStripeOthers.length} 件: {sameStripeOthers.map(s => `#${s.id} ${s.name}`).join(' / ')}</p>
                                        )}
                                      </div>
                                      <p className="text-[10px] text-red-600 leading-relaxed">
                                        承認前に必ず本人確認 (本人確認書類・営業許可証の店名一致・電話で店舗確認) をしてください。
                                      </p>
                                    </div>
                                  )}

                                  {/* 🔍 実在性確認 — Google で店舗を検索 (営業実態の有無を確認) */}
                                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
                                    <p className="text-[10px] font-black text-blue-700 uppercase tracking-wide">🔍 実在性確認 — Google検索</p>
                                    <div className="grid grid-cols-2 gap-2">
                                      <a
                                        href={googleSearchUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-center gap-1.5 bg-white hover:bg-blue-100 border border-blue-300 text-blue-700 font-bold text-[11px] py-2 rounded-lg transition-colors"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                        Google で検索
                                      </a>
                                      <a
                                        href={googleMapsSearchUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-center gap-1.5 bg-white hover:bg-blue-100 border border-blue-300 text-blue-700 font-bold text-[11px] py-2 rounded-lg transition-colors"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                        Maps で検索
                                      </a>
                                    </div>
                                    <p className="text-[10px] text-blue-600 leading-relaxed">
                                      検索結果に同名店舗の写真・口コミがあるかで実在性を確認できます。
                                    </p>
                                  </div>

                                  {/* オーナー情報 */}
                                  <DetailSection title="👤 オーナー情報">
                                    <DetailRow label="メールアドレス" value={d.owner_email} copyable />
                                    <button
                                      type="button"
                                      onClick={() => { setEmailInput(''); setEmailDialog({ storeId: store.id, storeName: store.name, currentEmail: d.owner_email }); }}
                                      disabled={!d.owner_id}
                                      className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-bold text-violet-600 hover:underline disabled:opacity-40 disabled:no-underline"
                                    >
                                      <Mail className="w-3 h-3" />ログインメールを変更
                                    </button>
                                    <DetailRow label="オーナーID" value={d.owner_id} mono />
                                    <DetailRow label="登録日" value={new Date(d.created_at).toLocaleString('ja-JP')} />
                                  </DetailSection>

                                  {/* 基本情報 */}
                                  <DetailSection title="🏪 店舗基本情報">
                                    {d.description && <DetailRow label="説明" value={d.description} multiline />}
                                    <DetailRow label="住所" value={`${d.address}${d.city ? '（' + d.city + '）' : ''}`} />
                                    {d.phone && <DetailRow label="電話番号" value={d.phone} />}
                                    {(d.lat || d.lng) && (
                                      <DetailRow label="座標" value={`${d.lat}, ${d.lng}`}
                                        link={`https://maps.google.com/?q=${d.lat},${d.lng}`} />
                                    )}
                                    <DetailRow label="カテゴリ" value={d.category} />
                                  </DetailSection>

                                  {/* 営業時間 */}
                                  {(d.open_time || d.close_time || d.holiday || d.pickup_hours) && (
                                    <DetailSection title="🕐 営業時間">
                                      {d.open_time && <DetailRow label="開店" value={d.open_time} />}
                                      {d.close_time && <DetailRow label="閉店" value={d.close_time} />}
                                      {d.pickup_hours && <DetailRow label="受取時間" value={d.pickup_hours} />}
                                      {d.holiday && <DetailRow label="定休日" value={d.holiday} />}
                                    </DetailSection>
                                  )}

                                  {/* コンプライアンス書類 */}
                                  <DetailSection title="📋 コンプライアンス書類">
                                    <DetailRow label="誓約書署名" value={d.pledge_signed ? '✅ 署名済み' : '❌ 未署名'} />
                                    <DetailRow
                                      label="Stripe口座"
                                      value={d.stripe_account_id ? `✅ ${d.stripe_account_id}` : '❌ 未連携'}
                                      mono={!!d.stripe_account_id}
                                      copyable={!!d.stripe_account_id}
                                    />
                                    {d.stripe_account_id && (
                                      <>
                                        {/* Stripe Files API ファイルID */}
                                        {d.stripe_license_file_id ? (
                                          <DetailRow
                                            label="Stripe File ID"
                                            value={`✅ ${d.stripe_license_file_id}`}
                                            mono copyable
                                          />
                                        ) : (
                                          <div className="flex items-start justify-between gap-2">
                                            <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5 min-w-[72px]">Stripe File ID</span>
                                            {(d.stripe_charges_enabled && d.stripe_payouts_enabled) ? (
                                              <span className="text-[11px] text-muted-foreground">—（DB未記録・決済は有効）</span>
                                            ) : (
                                              <span className="text-[11px] text-amber-600 font-semibold">❌ 未提出（Stripe未送信）</span>
                                            )}
                                          </div>
                                        )}

                                        {stripeErrors[store.id] && (
                                          <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-red-700 mb-1">
                                            🔴 連携エラー: {stripeErrors[store.id]}
                                          </div>
                                        )}

                                        <DetailRow
                                          label="決済 / 入金"
                                          value={
                                            stripeErrors[store.id]
                                              ? '🔴 Stripe接続エラー — 再同期してください'
                                              : `決済: ${d.stripe_charges_enabled === true ? '✅ 有効' : d.stripe_charges_enabled === false ? '❌ 制限中' : '未確認'}　入金: ${d.stripe_payouts_enabled === true ? '✅ 有効' : d.stripe_payouts_enabled === false ? '❌ 停止中' : '未確認'}`
                                          }
                                        />

                                        {/* Stripe ライブ requirements */}
                                        {d.stripe_requirements && !d.stripe_requirements.error && (
                                          <div className="mt-2 rounded-xl border border-border bg-secondary/10 p-2.5 space-y-1.5">
                                            <p className="text-[9px] font-black text-muted-foreground uppercase tracking-wide">📡 Stripe ライブ確認事項</p>

                                            {d.stripe_requirements.disabled_reason && (
                                              <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                                                <span className="text-[10px] font-black text-red-700">停止理由:</span>
                                                <span className="text-[10px] text-red-600 font-mono">{d.stripe_requirements.disabled_reason}</span>
                                              </div>
                                            )}

                                            {d.stripe_requirements.currently_due.length > 0 ? (
                                              <div>
                                                <p className="text-[10px] font-bold text-amber-700 mb-0.5">⚠️ 今すぐ必要な項目 ({d.stripe_requirements.currently_due.length}件)</p>
                                                {d.stripe_requirements.currently_due.map((item, i) => (
                                                  <div key={i} className="text-[10px] font-mono text-amber-800 bg-amber-50 rounded px-1.5 py-0.5 mb-0.5">{item}</div>
                                                ))}
                                              </div>
                                            ) : (
                                              <p className="text-[10px] text-emerald-700 font-bold">✅ 未解決の必要項目なし</p>
                                            )}

                                            {d.stripe_requirements.errors.length > 0 && (
                                              <div>
                                                <p className="text-[10px] font-bold text-red-700 mb-0.5">🚫 エラー ({d.stripe_requirements.errors.length}件)</p>
                                                {d.stripe_requirements.errors.map((e, i) => (
                                                  <div key={i} className="text-[10px] font-mono text-red-800 bg-red-50 rounded px-1.5 py-0.5 mb-0.5">
                                                    [{e.code}] {e.requirement}: {e.reason}
                                                  </div>
                                                ))}
                                              </div>
                                            )}

                                            {d.stripe_requirements.pending_verification.length > 0 && (
                                              <p className="text-[10px] text-blue-600 font-semibold">
                                                🔄 審査中: {d.stripe_requirements.pending_verification.join(', ')}
                                              </p>
                                            )}
                                          </div>
                                        )}

                                        {d.stripe_requirements?.error && (
                                          <div className="text-[10px] text-red-600 bg-red-50 rounded-lg px-2 py-1.5 mt-1">
                                            🔴 Stripe API エラー: {d.stripe_requirements.error}
                                          </div>
                                        )}
                                      </>
                                    )}

                                    {/* ─── オーナー確認（本人確認書類）─── */}
                                    <div className="mt-3 rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                                      <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide">オーナー確認（本人確認・口座）</p>
                                      {d.id_image_url ? (
                                        <button
                                          onClick={() => setLightboxImg(d.id_image_url!)}
                                          className="block w-full"
                                        >
                                          <img
                                            src={d.id_image_url}
                                            alt="本人確認書類"
                                            className="w-full max-h-36 object-contain rounded-lg border border-border bg-background cursor-zoom-in hover:opacity-90 transition-opacity"
                                          />
                                        </button>
                                      ) : d.stripe_account_id ? (
                                        <p className="text-[11px] text-emerald-600 font-semibold">✅ Stripe共有済み（bank-setup完了）</p>
                                      ) : (
                                        <p className="text-[11px] text-amber-600 font-semibold">⚠️ 本人確認未完了（bank-setup未実施）</p>
                                      )}
                                    </div>

                                    {/* ─── この店舗の営業許可証 ─── */}
                                    <div className="mt-2 rounded-xl border border-border bg-secondary/20 p-3 space-y-2">
                                      <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide">
                                        この店舗の営業許可証
                                        {d.license_number && (
                                          <span className="ml-2 font-normal normal-case text-foreground/70">{d.license_number}</span>
                                        )}
                                      </p>
                                      {d.license_image_url ? (
                                        <button
                                          onClick={() => setLightboxImg(d.license_image_url!)}
                                          className="block w-full"
                                        >
                                          <img
                                            src={d.license_image_url}
                                            alt="営業許可証"
                                            className="w-full max-h-40 object-contain rounded-lg border border-border bg-background cursor-zoom-in hover:opacity-90 transition-opacity"
                                          />
                                        </button>
                                      ) : (
                                        <p className="text-[11px] text-destructive font-semibold">❌ 未提出（要確認）</p>
                                      )}
                                    </div>
                                  </DetailSection>

                                  {/* 特定商取引法 */}
                                  {(d.legal_name || d.legal_representative || d.legal_address || d.legal_phone || d.legal_email || d.legal_other) && (
                                    <DetailSection title="⚖️ 特定商取引法情報">
                                      {d.legal_name && <DetailRow label="屋号・法人名" value={d.legal_name} />}
                                      {d.legal_representative && <DetailRow label="代表者名" value={d.legal_representative} />}
                                      {d.legal_address && <DetailRow label="住所" value={d.legal_address} />}
                                      {d.legal_phone && <DetailRow label="電話番号" value={d.legal_phone} />}
                                      {d.legal_email && <DetailRow label="メール" value={d.legal_email} copyable />}
                                      {d.legal_other && <DetailRow label="その他" value={d.legal_other} multiline />}
                                    </DetailSection>
                                  )}
                                </div>
                              );
                            })()}

                            {/* 店舗ページリンク */}
                            <Link href={`/stores/${store.id}`}>
                              <div className="flex items-center justify-center gap-1.5 bg-secondary/60 rounded-xl py-2 text-xs font-bold text-muted-foreground hover:bg-secondary transition-colors">
                                <ExternalLink className="w-3.5 h-3.5" />
                                店舗公開ページを確認
                              </div>
                            </Link>

                            {/* アクションボタン */}
                            {/* Stripe制限中の警告（payouts_enabled=true なら非表示） */}
                            {store.stripe_account_id && store.stripe_charges_enabled === false && store.stripe_payouts_enabled !== true && (
                              <div className="mb-2 flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-bold text-red-600">
                                <XCircle className="w-3.5 h-3.5 shrink-0" />
                                {stripeErrors[store.id]
                                  ? 'Stripe連携エラーが検出されています。アカウントIDを確認してください。'
                                  : 'Stripe制限中のため承認できません。書類不備を解消してください。'
                                }
                              </div>
                            )}
                            {/* Stripe File ID 警告
                                非表示条件:
                                  - payouts_enabled = true（Stripe審査通過）
                                  - または charges_enabled = true（決済有効 = Stripe書類送信済み）
                                  - または store が approved かつ charges_enabled = true
                            */}
                            {store.stripe_account_id && storeDetails[store.id] && !storeDetails[store.id].stripe_license_file_id && store.stripe_payouts_enabled !== true && store.stripe_charges_enabled !== true && (
                              <div className="mb-2 flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[11px] font-bold text-amber-700">
                                <FileWarning className="w-3.5 h-3.5 shrink-0" />
                                ⚠️ 営業許可証が Stripe に未送信です（stripe-sync ボタンで再送信可能）
                              </div>
                            )}
                            {/* Stripe再同期ボタン */}
                            {store.stripe_account_id && (
                              <div className="mb-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => syncStripeForStore(store.id)}
                                  disabled={syncingStripe === store.id}
                                  className="flex-1 flex items-center justify-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold text-xs py-2 rounded-xl transition-colors border border-blue-200 disabled:opacity-50"
                                >
                                  {syncingStripe === store.id
                                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    : <RefreshCw className="w-3.5 h-3.5" />
                                  }
                                  Stripe再同期
                                </button>
                                <button
                                  type="button"
                                  onClick={() => disconnectStripe(store.id, store.name)}
                                  className="flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-bold text-xs py-2 px-3 rounded-xl transition-colors border border-red-200"
                                  title="口座変更・再連携のために使用"
                                >
                                  <LinkIcon className="w-3.5 h-3.5" />
                                  口座リセット
                                </button>
                              </div>
                            )}
                            {/* Stripe ID 手動リンク — stripe_account_id が未設定の店舗向け */}
                            {!store.stripe_account_id && (
                              <div className="mb-2">
                                <button
                                  type="button"
                                  onClick={() => { setLinkStripeDialog({ storeId: store.id, storeName: store.name }); setLinkStripeInput(''); }}
                                  className="w-full flex items-center justify-center gap-1.5 bg-violet-50 hover:bg-violet-100 text-violet-700 font-bold text-xs py-2 rounded-xl transition-colors border border-violet-200"
                                >
                                  <LinkIcon className="w-3.5 h-3.5" />
                                  Stripe IDを手動リンク（孤立アカウント修復）
                                </button>
                              </div>
                            )}
                            {/* 地図に表示トグル — 口座未設定でもマップに出せる */}
                            <button
                              type="button"
                              onClick={() => toggleShowOnMap(store.id, store.show_on_map)}
                              disabled={isProcessing}
                              className={`w-full mb-2 flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors border disabled:opacity-50 ${
                                store.show_on_map
                                  ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                                  : 'bg-gray-50 hover:bg-gray-100 text-gray-600 border-gray-200'
                              }`}
                            >
                              <span className="flex items-center gap-1.5">
                                🗺 地図に表示
                                {store.show_on_map
                                  ? <span className="text-[10px] px-1.5 py-0.5 bg-emerald-200 rounded">ON</span>
                                  : <span className="text-[10px] px-1.5 py-0.5 bg-gray-200 rounded">OFF</span>}
                              </span>
                              <span className="text-[10px] opacity-70">
                                {store.show_on_map ? 'タップで非表示' : 'タップで表示'}
                              </span>
                            </button>

                            <div className="flex gap-2 flex-wrap">
                              {isStorePending && (
                                <>
                                  <button onClick={() => approveStore(store.id)}
                                    disabled={isProcessing || (store.stripe_account_id != null && store.stripe_charges_enabled === false)}
                                    className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs py-2.5 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                                    {isProcessing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                                    承認する
                                  </button>
                                  <button onClick={() => openRejectDialog(store.id, store.name)} disabled={isProcessing}
                                    className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-bold text-xs py-2.5 rounded-xl transition-colors border border-red-200 disabled:opacity-50">
                                    <XCircle className="w-3.5 h-3.5" />
                                    却下
                                  </button>
                                </>
                              )}
                              {isApprovedActive && (
                                <button onClick={() => suspendStore(store.id)} disabled={isProcessing}
                                  className="flex items-center justify-center gap-1.5 bg-orange-50 hover:bg-orange-100 text-orange-600 font-bold text-xs py-2.5 px-4 rounded-xl transition-colors border border-orange-200 disabled:opacity-50">
                                  {isProcessing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                                  一時停止
                                </button>
                              )}
                              {isSuspended && !isStorePending && (
                                <button onClick={() => approveStore(store.id)}
                                  disabled={isProcessing || (store.stripe_account_id != null && store.stripe_charges_enabled === false)}
                                  className="flex items-center justify-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 font-bold text-xs py-2.5 px-4 rounded-xl transition-colors border border-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed">
                                  <CheckCircle className="w-3.5 h-3.5" />
                                  再承認する
                                </button>
                              )}
                              {/* 削除ボタン — 神モードでは全ステータスで表示。関連データも合わせてカスケード削除する */}
                              <button onClick={() => deleteStore(store.id, store.name)} disabled={isProcessing}
                                className="flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-bold text-xs py-2.5 px-3 rounded-xl transition-colors border border-red-200 disabled:opacity-50">
                                <Trash2 className="w-3.5 h-3.5" />
                                削除
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
              {filteredStores.length > 10 && (
                <button onClick={() => setShowAllStores(v => !v)}
                  className="w-full py-3 flex items-center justify-center gap-1.5 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors">
                  {showAllStores
                    ? <><ChevronUp className="w-4 h-4" />折りたたむ</>
                    : <><ChevronDown className="w-4 h-4" />残り{filteredStores.length - 10}件を表示</>}
                </button>
              )}
            </div>
          )}
        </motion.div>

        {/* ── お知らせ配信パネル ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-card border border-border/60 rounded-2xl overflow-hidden">
          <div className="px-5 pt-5 pb-5">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
              <Megaphone className="w-3.5 h-3.5" />お知らせ配信
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">タイトル</label>
                <input
                  type="text" value={annTitle} onChange={e => setAnnTitle(e.target.value)}
                  placeholder="例：今日のおすそわけ情報"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">本文</label>
                <textarea
                  value={annBody} onChange={e => setAnnBody(e.target.value)} rows={3}
                  placeholder="全ユーザーに配信されるメッセージを入力してください"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>
              <button onClick={sendAnnouncement} disabled={annSending || !annTitle.trim() || !annBody.trim()}
                className="w-full h-12 bg-primary text-white font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:scale-[0.98] shadow-sm shadow-primary/20">
                {annSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                全ユーザーに配信する
              </button>
            </div>

            {announcements.length > 0 && (
              <div className="mt-5 pt-5 border-t border-border/40">
                <p className="text-xs font-bold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <Bell className="w-3.5 h-3.5" />配信済み ({announcements.length}件)
                </p>
                <div className="space-y-2">
                  {announcements.slice(0, 5).map(ann => (
                    <div key={ann.id} className="bg-secondary/40 rounded-xl px-3 py-2.5">
                      <p className="text-xs font-bold text-foreground">{ann.title}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{ann.body}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        {new Date(ann.created_at).toLocaleString('ja-JP')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>

        {/* ── 通知ベル一斉送信パネル ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}
          className="bg-card border border-border/60 rounded-2xl overflow-hidden">
          <div className="px-5 pt-5 pb-5">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
              <Bell className="w-3.5 h-3.5" />通知ベル一斉送信
            </h2>
            <p className="text-[11px] text-muted-foreground mb-3">
              全ユーザーのアプリ内通知ベルにメッセージを送信します。
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">タイトル <span className="text-destructive">*</span></label>
                <input
                  type="text" value={notifTitle} onChange={e => setNotifTitle(e.target.value)}
                  placeholder="例：新機能のお知らせ"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1.5">本文 <span className="font-normal opacity-60">（任意）</span></label>
                <textarea
                  value={notifBody} onChange={e => setNotifBody(e.target.value)} rows={3}
                  placeholder="詳細メッセージを入力してください"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>
              <button onClick={sendNotification} disabled={notifSending || !notifTitle.trim()}
                className="w-full h-12 bg-primary text-white font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:scale-[0.98] shadow-sm shadow-primary/20">
                {notifSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                全ユーザーに通知する
              </button>
            </div>
          </div>
        </motion.div>

        {/* ── アプリ設定パネル ── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="bg-card border border-border/60 rounded-2xl overflow-hidden">
          <div className="px-5 pt-5 pb-5 space-y-5">

            {/* ─ 文言管理 ─ */}
            <div>
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
                <Type className="w-3.5 h-3.5" />文言管理
              </h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                    キャッチコピー <span className="font-normal opacity-60">（ホームの地域名表示のデフォルト）</span>
                  </label>
                  <input
                    type="text" value={catchphrase} onChange={e => setCatchphrase(e.target.value)}
                    placeholder="あなたの街のおすそわけ"
                    className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                    サブキャッチコピー <span className="font-normal opacity-60">（将来の使用向け）</span>
                  </label>
                  <input
                    type="text" value={subCatchphrase} onChange={e => setSubCatchphrase(e.target.value)}
                    placeholder="おいしいものを、もっとみんなへ。"
                    className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
            </div>

            {/* ─ メンテナンスモード ─ */}
            <div className="pt-4 border-t border-border/40">
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
                <Wrench className="w-3.5 h-3.5" />メンテナンスモード
              </h2>

              {/* トグルスイッチ */}
              <div
                onClick={() => setMaintenanceMode(v => !v)}
                className={`flex items-center justify-between px-4 py-4 rounded-2xl border-2 cursor-pointer transition-all select-none ${
                  maintenanceMode
                    ? 'border-red-400 bg-red-50'
                    : 'border-border/60 bg-secondary/30 hover:bg-secondary/50'
                }`}
              >
                <div>
                  <p className={`text-sm font-black ${maintenanceMode ? 'text-red-700' : 'text-foreground'}`}>
                    {maintenanceMode ? '🔧 メンテナンス中（ユーザーをブロック）' : 'メンテナンスモード OFF'}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {maintenanceMode
                      ? '管理者とadminページは引き続きアクセス可能'
                      : 'ONにするとすべてのユーザーにメンテナンス画面を表示'}
                  </p>
                </div>
                {maintenanceMode
                  ? <ToggleRight className="w-8 h-8 text-red-500 shrink-0" />
                  : <ToggleLeft  className="w-8 h-8 text-muted-foreground/40 shrink-0" />}
              </div>

              {/* メンテナンス画面の文言 */}
              <div className="space-y-3 mt-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">メンテナンス画面タイトル</label>
                  <input
                    type="text" value={maintenanceTitle} onChange={e => setMaintenanceTitle(e.target.value)}
                    placeholder="ただいまメンテナンス中です"
                    className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                    メンテナンス画面メッセージ <span className="font-normal opacity-60">（改行可）</span>
                  </label>
                  <textarea
                    value={maintenanceMessage} onChange={e => setMaintenanceMessage(e.target.value)} rows={3}
                    placeholder="しばらくお待ちください🙏"
                    className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm font-medium border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                  />
                </div>
              </div>
            </div>

            {/* ─ Stripe自動承認 ─ */}
            <div className="pt-4 border-t border-border/40">
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
                <CreditCard className="w-3.5 h-3.5" />Stripe認証で自動公開
              </h2>

              <div
                onClick={() => setAutoApproveStripe(v => !v)}
                className={`flex items-center justify-between px-4 py-4 rounded-2xl border-2 cursor-pointer transition-all select-none ${
                  autoApproveStripe
                    ? 'border-green-400 bg-green-50'
                    : 'border-border/60 bg-secondary/30 hover:bg-secondary/50'
                }`}
              >
                <div>
                  <p className={`text-sm font-black ${autoApproveStripe ? 'text-green-700' : 'text-foreground'}`}>
                    {autoApproveStripe ? '⚡ Stripe KYC完了で自動承認 ON' : '自動承認 OFF（手動で承認）'}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {autoApproveStripe
                      ? '店舗のStripe本人確認が完了した瞬間に自動で公開されます'
                      : 'ONにすると charges_enabled になった店舗を自動で approved + is_active にします'}
                  </p>
                </div>
                {autoApproveStripe
                  ? <ToggleRight className="w-8 h-8 text-green-500 shrink-0" />
                  : <ToggleLeft  className="w-8 h-8 text-muted-foreground/40 shrink-0" />}
              </div>

              <p className="text-[11px] text-muted-foreground mt-2 px-1">
                ※ OFFでも Stripe KYC完了時に管理者へ承認依頼メールが届きます。
              </p>
            </div>

            {/* ─ 壊れた画像の一括復旧 (data:URL → Supabase Storage) ─ */}
            <div className="pt-4 border-t border-border/40">
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-2">
                <Wrench className="w-3.5 h-3.5" />壊れた画像の一括復旧
              </h2>
              <p className="text-[11px] text-muted-foreground mb-3 px-1 leading-relaxed">
                過去のバグで <code className="text-[10px] bg-secondary px-1 py-0.5 rounded">data:image/...</code> 形式でDBに保存された店舗写真・アイコンを、Supabase Storage に正しくアップロードし直して URL を差し替えます。オーナーに再アップを依頼せずに既存データを復旧できます。
              </p>
              <button
                type="button"
                disabled={migratingImages}
                onClick={async () => {
                  if (migratingImages) return;
                  if (!confirm('壊れた画像 (data:URL) を一括で Supabase Storage に移行します。実行しますか？')) return;
                  setMigratingImages(true);
                  try {
                    const r = await authedFetch(`${BASE}/api/admin/stores/migrate-data-urls`, { method: 'POST', headers: {} });
                    const data = await r.json();
                    if (!r.ok) throw new Error(data?.message ?? 'failed');
                    const s = data.summary ?? {};
                    const fails = (data.results ?? []).filter((x: any) => x.image === 'fail' || x.icon === 'fail');
                    const failDetail = fails.length
                      ? '\n\n失敗詳細:\n' + fails.map((x: any) => `・${x.name} (id=${x.id}): ${x.error ?? ''}`).join('\n')
                      : '';
                    alert(`復旧完了\n\n対象: ${s.total ?? 0}店舗\n店舗写真: ${s.imageMigrated ?? 0}件\nアイコン: ${s.iconMigrated ?? 0}件\n失敗: ${s.failed ?? 0}件${failDetail}`);
                    void fetchAll();
                  } catch (e: any) {
                    alert(`移行失敗: ${e?.message ?? '不明なエラー'}`);
                  } finally {
                    setMigratingImages(false);
                  }
                }}
                className="w-full h-11 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-black text-sm flex items-center justify-center gap-2 transition-colors active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {migratingImages
                  ? <><RefreshCw className="w-4 h-4 animate-spin" />復旧中…（しばらくお待ちください）</>
                  : <><RefreshCw className="w-4 h-4" />壊れた画像を一括復旧する</>}
              </button>
            </div>

            {/* 保存ボタン */}
            <button onClick={saveSettings} disabled={settingsSaving}
              className={`w-full h-12 font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:scale-[0.98] shadow-sm ${
                maintenanceMode
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200'
                  : 'bg-foreground text-background hover:bg-foreground/90'
              }`}>
              {settingsSaving
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : <Settings className="w-4 h-4" />}
              {maintenanceMode ? '🔧 設定を保存してメンテナンス開始' : '設定を保存する'}
            </button>

          </div>
        </motion.div>

        {/* ── 営業リード（食品ロスのお店情報）── */}
        <div id="leads-section" />
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
          <div className="bg-card rounded-3xl"
            style={{ boxShadow: '0 4px 16px -4px rgba(10,8,6,0.1)' }}>
            <div className="px-5 pt-5 pb-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Flag className="w-4 h-4 text-orange-500" />
                  <p className="font-black text-foreground">営業リード</p>
                  <span className="text-[10px] font-bold bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full">
                    {salesLeads.filter(l => l.status === 'new').length} 件未対応
                  </span>
                </div>
              </div>

              {salesLeads.length === 0 ? (
                <div className="py-8 text-center">
                  <Flag className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">まだリードはありません</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {salesLeads.map(lead => {
                    const isExpanded = expandedLead === lead.id;
                    const badgeCls = lead.status === 'new'       ? 'bg-orange-200 text-orange-800' :
                                     lead.status === 'contacted' ? 'bg-blue-200 text-blue-800' :
                                     lead.status === 'converted' ? 'bg-green-200 text-green-800' :
                                                                   'bg-gray-200 text-gray-700';
                    const cardCls  = lead.status === 'new'       ? 'bg-orange-50 border-orange-200' :
                                     lead.status === 'contacted' ? 'bg-blue-50 border-blue-200' :
                                     lead.status === 'converted' ? 'bg-green-50 border-green-200' :
                                                                   'bg-secondary border-border';
                    return (
                      <div key={lead.id} className={`rounded-2xl border ${cardCls}`}>
                        {/* ── 行ヘッダー（常に表示）── */}
                        <button
                          type="button"
                          onClick={() => setExpandedLead(isExpanded ? null : lead.id)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-black text-sm text-foreground">{lead.storeName}</p>
                              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full shrink-0 ${badgeCls}`}>
                                {lead.status === 'new' ? '未対応' : lead.status === 'contacted' ? '連絡済み' : lead.status === 'converted' ? '成約' : 'クローズ'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                              <MapPin className="w-3 h-3 shrink-0" />
                              <span className="truncate">{lead.location}</span>
                            </div>
                          </div>
                          {isExpanded
                            ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                            : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                        </button>
                        {/* ── 展開詳細パネル ── */}
                        {isExpanded && (
                          <div className="px-4 pb-4 pt-1 space-y-3 border-t border-black/5">
                            <div>
                              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-0.5">店舗名</p>
                              <p className="text-sm font-black text-foreground">{lead.storeName}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-0.5">場所・エリア</p>
                              <div className="flex items-start gap-1.5">
                                <MapPin className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                                <p className="text-sm font-medium text-foreground">{lead.location}</p>
                              </div>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-0.5">詳細メモ</p>
                              <p className="text-sm text-foreground leading-relaxed">
                                {lead.memo || <span className="text-muted-foreground italic">（メモなし）</span>}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-0.5">報告日時</p>
                              <p className="text-xs text-muted-foreground">
                                {lead.createdAt ? new Date(lead.createdAt).toLocaleString('ja-JP') : '—'}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-1.5">対応ステータス</p>
                              <select
                                value={lead.status}
                                onChange={async (e) => {
                                  const newStatus = e.target.value;
                                  await authedFetch(`${BASE}/api/admin/sales-leads/${lead.id}`, {
                                    method:  'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body:    JSON.stringify({ status: newStatus }),
                                  });
                                  setSalesLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: newStatus } : l));
                                  // ★ トップの「要対応 N件」 (newSalesLeadsCount = status='new' の数) を再集計させる。
                                  //    これを呼ばないとリードを「連絡済み」 等に変更しても要対応カウンタが減らないバグになる。
                                  await fetchAll();
                                }}
                                className="w-full text-sm font-bold border border-border rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                              >
                                <option value="new">📌 未対応</option>
                                <option value="contacted">📞 連絡済み</option>
                                <option value="converted">✅ 成約</option>
                                <option value="closed">🚫 クローズ</option>
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── 管理者の管理 (#6 フェーズ B) ── */}
        <AdminAdminsSection currentUserId={user?.id} />

      </div>

      {/* ── 画像ライトボックス ── */}
      <AnimatePresence>
        {lightboxImg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setLightboxImg(null)}
          >
            <motion.img
              initial={{ scale: 0.85 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.85 }}
              src={lightboxImg}
              alt="書類確認"
              className="max-w-full max-h-full rounded-2xl shadow-2xl object-contain cursor-zoom-out"
              onClick={e => e.stopPropagation()}
            />
            <button
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center text-xl hover:bg-white/20 transition-colors"
              onClick={() => setLightboxImg(null)}
            >✕</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 却下理由入力モーダル ── */}
      <AnimatePresence>
        {rejectDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
            onClick={() => setRejectDialog(null)}
          >
            <motion.div
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 60, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="w-full max-w-md md:max-w-2xl bg-white rounded-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
                  <XCircle className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <p className="font-black text-foreground text-sm">審査を却下しますか？</p>
                  <p className="text-xs text-muted-foreground truncate max-w-[240px]">{rejectDialog.storeName}</p>
                </div>
              </div>
              <div className="mb-4">
                <label className="block text-xs font-black text-muted-foreground mb-2 uppercase tracking-wider">却下理由（オーナーに通知されます）</label>
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  rows={4}
                  placeholder="例：営業許可証の内容が確認できませんでした。再申請の際は、許可証の写真を鮮明なものに差し替えてください。"
                  className="w-full px-4 py-3 bg-secondary/50 rounded-xl text-sm border border-border/50 focus:outline-none focus:ring-2 focus:ring-red-300 resize-none"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground mt-1">※ 空欄の場合は理由なしで却下されます</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setRejectDialog(null)}
                  className="flex-1 py-3 rounded-xl font-bold text-sm bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmReject}
                  className="flex-1 py-3 rounded-xl font-black text-sm bg-red-500 hover:bg-red-600 text-white transition-colors"
                >
                  却下する
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Stripe 未連携 警告モーダル ── */}
      <AnimatePresence>
        {stripeWarnModal && (() => {
          const s = stripeWarnModal.status;
          // currently_due を日本語に変換して重複排除
          const dueJa = [...new Set(
            s.currentlyDue.map(f => STRIPE_FIELD_JA[f] ?? f)
          )];
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
              onClick={() => setStripeWarnModal(null)}
            >
              <motion.div
                initial={{ y: 60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 60, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="w-full max-w-md md:max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                {/* ヘッダー */}
                <div className="bg-amber-50 border-b border-amber-200 px-5 py-4 flex items-start gap-3">
                  <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center shrink-0 mt-0.5">
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-black text-amber-900 text-sm">承認完了 — Stripe未連携を検出</p>
                    <p className="text-xs text-amber-700 truncate mt-0.5">{stripeWarnModal.storeName}</p>
                  </div>
                </div>

                <div className="px-5 py-4 space-y-4">
                  {/* Stripe ステータスバッジ */}
                  <div className="flex flex-wrap gap-2">
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${s.chargesEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {s.chargesEnabled ? '✅' : '❌'} 支払受取
                    </span>
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${s.payoutsEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {s.payoutsEnabled ? '✅' : '❌'} 銀行振込
                    </span>
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${s.hasAccount ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                      {s.hasAccount ? '✅' : '❌'} Stripe口座
                    </span>
                  </div>

                  {/* 未送信フィールド一覧 */}
                  {dueJa.length > 0 && (
                    <div>
                      <p className="text-xs font-black text-foreground mb-2 uppercase tracking-wider">Stripeへ未送信の必須項目</p>
                      <ul className="space-y-1">
                        {dueJa.map((label, i) => (
                          <li key={i} className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                            {label}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Stripe エラー詳細 */}
                  {s.errors.length > 0 && (
                    <div>
                      <p className="text-xs font-black text-foreground mb-2 uppercase tracking-wider">Stripeエラー詳細</p>
                      <ul className="space-y-1.5">
                        {s.errors.map((e, i) => (
                          <li key={i} className="text-[11px] text-foreground/70 bg-secondary/50 rounded-lg px-3 py-2">
                            <span className="font-bold text-red-600">{STRIPE_FIELD_JA[e.requirement] ?? e.requirement}</span>
                            {e.reason && <span className="block text-muted-foreground mt-0.5">{e.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground bg-secondary/50 rounded-xl px-3 py-2.5">
                    店舗の承認はDB上では完了しています。オーナーにStripe KYCの再送信を依頼するか、StripeダッシュボードでAccount IDを確認してください。
                  </p>
                </div>

                <div className="px-5 pb-5">
                  <button
                    onClick={() => setStripeWarnModal(null)}
                    className="w-full py-3 rounded-xl font-black text-sm bg-amber-500 hover:bg-amber-600 text-white transition-colors active:scale-95"
                  >
                    確認しました
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ── Stripe ID 手動リンク モーダル ───────────────────────────────── */}
      <AnimatePresence>
        {linkStripeDialog && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setLinkStripeDialog(null)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-5 w-full max-w-sm md:max-w-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-4">
                <LinkIcon className="w-5 h-5 text-violet-600" />
                <h2 className="font-black text-gray-900 text-base">Stripe ID 手動リンク</h2>
              </div>
              <p className="text-xs text-gray-500 mb-1 font-medium">店舗名</p>
              <p className="text-sm font-bold text-gray-800 mb-4 truncate">{linkStripeDialog.storeName}</p>
              <p className="text-xs text-gray-500 mb-2 leading-relaxed">
                bank-setup の途中でエラーが起きて Stripe アカウントが孤立した場合、<br/>
                Stripe ダッシュボードから該当アカウントの ID（<code className="text-violet-700">acct_...</code>）をコピーして入力してください。
              </p>
              <input
                type="text"
                value={linkStripeInput}
                onChange={e => setLinkStripeInput(e.target.value)}
                placeholder="acct_1TGtRJGp2d1GdBCz"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-400 mb-4"
              />
              {linkStripeInput && !linkStripeInput.startsWith('acct_') && (
                <p className="text-xs text-red-500 mb-3">acct_ で始まるIDを入力してください</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLinkStripeDialog(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-bold text-sm"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={linkStripeAccount}
                  disabled={linkStripeLoading || !linkStripeInput.startsWith('acct_')}
                  className="flex-1 py-2.5 rounded-xl bg-violet-600 text-white font-bold text-sm hover:bg-violet-700 transition-colors disabled:opacity-40"
                >
                  {linkStripeLoading ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : 'リンクして同期'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── ログインメール変更 モーダル ───────────────────────────────── */}
      <AnimatePresence>
        {emailDialog && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setEmailDialog(null)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-5 w-full max-w-sm md:max-w-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-4">
                <Mail className="w-5 h-5 text-violet-600" />
                <h2 className="font-black text-gray-900 text-base">ログインメールを変更</h2>
              </div>
              <p className="text-xs text-gray-500 mb-1 font-medium">店舗名</p>
              <p className="text-sm font-bold text-gray-800 mb-3 truncate">{emailDialog.storeName}</p>
              <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
                ⚠️ 変更後は<strong>新しいメールでログイン</strong>する必要があります。注文通知メールの宛先もこのアドレスに変わります。同じオーナーが複数店舗を持つ場合、全店舗のログインが一括で変わります。
              </div>
              {emailDialog.currentEmail && (
                <p className="text-[11px] text-gray-500 mb-1">
                  現在: <span className="font-mono">{emailDialog.currentEmail}</span>
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
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-400 mb-4"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEmailDialog(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-bold text-sm"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={changeOwnerEmail}
                  disabled={emailLoading || !emailInput.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-violet-600 text-white font-bold text-sm hover:bg-violet-700 transition-colors disabled:opacity-40"
                >
                  {emailLoading ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : 'メールを変更する'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
