import React, { useState, useEffect, useRef } from 'react';
import { authedFetch } from '@/lib/authed-fetch';
import { Layout } from '@/components/Layout';
import { StoreLayout } from '@/components/StoreLayout';
import { useUserId } from '@/hooks/use-user';
import { useLocation, Link } from 'wouter';
import {
  ChevronLeft, User, Camera, Bell, LogOut,
  ChevronRight, Mail, Pencil, X, Check, Trash2, Lock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useAvatar, saveAvatar } from '@/hooks/use-avatar';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
// ★ ランキング設定 (参加 ON/OFF) は RankingPage に集約したため、
//    Settings 側からは関連 import / hook / state / handler を全削除済

/** 画像ファイルを max W/H にリサイズして JPEG DataURL を返す */
function resizeImageToDataUrl(file: File, maxW: number, maxH: number, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image_load_failed'));
      img.onload = () => {
        const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas_unsupported'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err instanceof Error ? err : new Error('canvas_export_failed'));
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const GENRES = ['ベーカリー', 'お弁当', 'カフェ', 'レストラン', 'スーパー', 'コンビニ', 'スイーツ', '和食'];

function TokushoModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/50 backdrop-blur-sm px-0 md:px-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="bg-card w-full md:max-w-lg rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[85dvh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-lg font-black">特定商取引法に基づく表記</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto overflow-x-hidden px-6 py-5 space-y-5">
          {[
            { label: '販売業者', value: 'おすそわけ 事務局' },
            { label: '運営責任者', value: '佐藤勇飛' },
            { label: 'お問い合わせ', value: (
              <a href="https://forms.gle/uhMoXjjF9YzkR52a6" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                Googleフォームよりお問い合わせください
              </a>
            )},
            { label: 'サービス内容', value: 'フードロス削減を目的とした飲食店・食料品店のおすそわけバッグ予約・購入プラットフォーム' },
            { label: '販売価格', value: '各商品ページに表示の価格（税込）' },
            { label: '支払方法', value: 'クレジットカード（Stripe決済）' },
            { label: '支払時期', value: '予約確定時に即時決済' },
            { label: '商品の引渡し時期', value: '各店舗の受取時間内にご来店の上、お受け取りください' },
            { label: 'キャンセル・返品規定', value: '商品の性質上、購入確定後のキャンセル・返品・交換はお受けできません。ただし、店舗側の都合による商品提供不可の場合は全額返金いたします。' },
            { label: '手数料', value: '初期費用・月額費用：0円。販売成立時のみ、販売金額の20%を手数料として申し受けます。' },
            { label: '個人情報の取扱い', value: '収集した個人情報は、サービス提供・改善の目的のみに使用し、第三者への提供は行いません。' },
          ].map(({ label, value }) => (
            <div key={label} className="border-b border-border/50 pb-4 last:border-0 last:pb-0">
              <dt className="text-xs font-black text-muted-foreground uppercase tracking-wide mb-1">{label}</dt>
              <dd className="text-sm text-foreground leading-relaxed">{value}</dd>
            </div>
          ))}
        </div>
        <div className="shrink-0 px-6 pb-6 pt-4">
          <button
            onClick={onClose}
            className="w-full bg-primary text-primary-foreground font-bold py-3.5 rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all"
          >
            閉じる
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function useLocalSettings(userId: string) {
  const key = `rescueat_settings_${userId}`;
  const raw = localStorage.getItem(key);
  const defaults = {
    displayName: 'ゲストユーザー',
    email: '',
    favoriteGenres: [] as string[],
    avatarColor: '#2D5A51',
    notifNewListing: true,
    notifFavoriteUpdate: true,
    notifNewOrder: true,
  };
  const saved = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  function save(patch: Partial<typeof defaults>) {
    const next = { ...saved, ...patch };
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  }
  return { saved, save };
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative w-12 h-7 rounded-full transition-colors duration-200 shrink-0 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none
        ${value ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span
        className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200
          ${value ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-black text-muted-foreground uppercase tracking-widest px-1 mb-2 mt-6 first:mt-0">
      {children}
    </p>
  );
}

function Row({
  icon, iconBg = 'bg-secondary', label, sublabel, right, onClick, danger = false,
}: {
  icon: React.ReactNode; iconBg?: string; label: string; sublabel?: string;
  right?: React.ReactNode; onClick?: () => void; danger?: boolean;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`w-full flex items-center gap-3.5 px-4 min-h-[56px] transition-colors
        ${onClick ? (danger ? 'hover:bg-destructive/5 active:bg-destructive/10' : 'hover:bg-secondary/60 active:bg-secondary') : ''}
        ${danger ? 'text-destructive' : 'text-foreground'}`}
    >
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 text-left min-w-0">
        <p className={`font-bold text-sm ${danger ? 'text-destructive' : 'text-foreground'}`}>{label}</p>
        {sublabel && <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>}
      </div>
      {right ?? (onClick && !danger ? <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" /> : null)}
    </Tag>
  );
}


function SettingsWrapper({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  if (profile?.role === 'store_owner') {
    return <StoreLayout>{children}</StoreLayout>;
  }
  return <Layout showBottomNav={false}>{children}</Layout>;
}

export default function Settings() {
  const userId = useUserId() || '';
  const { user, profile, signOut: authSignOut, refreshProfile } = useAuth();
  const isStoreOwner = profile?.role === 'store_owner';
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { saved, save } = useLocalSettings(userId);

  // display_name は Supabase から。★ メールの@前を初期値にしない
  //   (この欄はランキングで公開される＝メールアドレスが漏れるため)。未設定なら空。
  const initialDisplayName =
    profile?.display_name ||
    saved.displayName ||
    '';

  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [email, setEmail] = useState(user?.email ?? saved.email);
  const [favoriteGenres, setFavoriteGenres] = useState<string[]>(saved.favoriteGenres);
  const [notifNewListing, setNotifNewListing] = useState(saved.notifNewListing);
  const [notifFavoriteUpdate, setNotifFavoriteUpdate] = useState(saved.notifFavoriteUpdate);
  const [notifNewOrder, setNotifNewOrder] = useState(saved.notifNewOrder);

  // ── デイリー通知 ON/OFF はサーバー永続化 ──────────────────────────
  const [notifDailyEngagement, setNotifDailyEngagement] = useState(true);
  useEffect(() => {
    if (!user || isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/notification-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifDailyEngagement === 'boolean') setNotifDailyEngagement(d.notifDailyEngagement); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleNotifDailyEngagementToggle(val: boolean) {
    setNotifDailyEngagement(val); // 楽観的更新
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/notification-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifDailyEngagement: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifDailyEngagement(!val); // ロールバック
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ── 店舗オーナー: 注文メール通知 ON/OFF (サーバー永続化) ─────────────────────
  //    デフォルト OFF (opt-in)。 初期値 false で render → サーバ値が返ってきたら
  //    上書き。 大多数 (OFF) はチラつきゼロ。 ON 派 (少数) のみ瞬間 OFF→ON。
  const [notifEmailOrders, setNotifEmailOrders] = useState(false);
  useEffect(() => {
    if (!user || !isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/email-order-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifEmailOrders === 'boolean') setNotifEmailOrders(d.notifEmailOrders); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isStoreOwner]);

  async function handleNotifEmailOrdersToggle(val: boolean) {
    setNotifEmailOrders(val);
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/email-order-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifEmailOrders: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifEmailOrders(!val);
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ── お気に入り外の新規出品(全体配信) ON/OFF (サーバー永続化) ────────────────
  //    以前は localStorage のみで実際の配信は止まっていなかった。 サーバーに永続化して
  //    new-listing-broadcast の宛先から実際に除外されるようにする。
  useEffect(() => {
    if (!user || isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/new-listing-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifNewListing === 'boolean') setNotifNewListing(d.notifNewListing); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleNotifNewListingToggle(val: boolean) {
    setNotifNewListing(val); // 楽観的更新
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/new-listing-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifNewListing: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifNewListing(!val); // ロールバック
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ── お気に入り店舗の更新(新規出品)プッシュ ON/OFF (サーバー永続化) ─────────────
  //    以前は localStorage のみで、OFF にしてもお気に入り店の新規出品プッシュは届き続けていた。
  //    サーバーに永続化し、bags.ts / recurring-publisher.ts の配信対象から実際に除外する。
  useEffect(() => {
    if (!user || isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/favorite-update-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifFavoriteUpdate === 'boolean') setNotifFavoriteUpdate(d.notifFavoriteUpdate); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleNotifFavoriteUpdateToggle(val: boolean) {
    setNotifFavoriteUpdate(val); // 楽観的更新
    save({ notifFavoriteUpdate: val }); // localStorage にも保持
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/favorite-update-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifFavoriteUpdate: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifFavoriteUpdate(!val); // ロールバック
      save({ notifFavoriteUpdate: !val });
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ── 店舗オーナー: 未出品リマインド ON/OFF (サーバー永続化) ─────────────────────
  //    「今日まだ出品してませんよ」の毎日リマインドをオーナー単位でオフにできる。
  const [notifUnlistedReminder, setNotifUnlistedReminder] = useState(true);
  useEffect(() => {
    if (!user || !isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/unlisted-reminder-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifUnlistedReminder === 'boolean') setNotifUnlistedReminder(d.notifUnlistedReminder); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isStoreOwner]);

  async function handleNotifUnlistedReminderToggle(val: boolean) {
    setNotifUnlistedReminder(val);
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/unlisted-reminder-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifUnlistedReminder: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifUnlistedReminder(!val);
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ── 店舗オーナー: 新規注文の通知 ON/OFF (サーバー永続化 / 実効化) ─────────────────
  //    お客様が購入した直後の bag_sold プッシュをオーナー単位でオフにできる。
  //    サーバー側 storeOrderPushEnabled() が notif_new_order を見て配信を止める(ベルは残る)。
  useEffect(() => {
    if (!user || !isStoreOwner) return;
    const base = ((import.meta as any).env?.VITE_API_BASE as string)
      || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
    import('@/lib/authed-fetch').then(({ authedFetch }) =>
      authedFetch(`${base}/api/user/new-order-preference`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.notifNewOrder === 'boolean') setNotifNewOrder(d.notifNewOrder); })
        .catch(() => {})
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isStoreOwner]);

  async function handleNotifNewOrderToggle(val: boolean) {
    setNotifNewOrder(val);
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = ((import.meta as any).env?.VITE_API_BASE as string)
        || ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/new-order-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifNewOrder: val }),
      });
      if (!res.ok) throw new Error('save_failed');
    } catch {
      setNotifNewOrder(!val);
      toast({ title: '設定の保存に失敗しました', variant: 'destructive' });
    }
  }

  // ★ ランキング opt-out 関連の hook / state / handler は RankingPage 側に集約 (重複削減)

  const [editingProfile, setEditingProfile] = useState(false);
  const [saved_, setSaved_] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [showTokusho, setShowTokusho] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);

  // メール/パスワードでサインアップしたユーザーのみ「パスワード変更」を表示
  // (Google等のソーシャルログイン専用ユーザーには非表示)
  // 不明な場合は安全側 (=非表示) に倒す
  const hasEmailProvider = (() => {
    const u = user as any;
    if (!u) return false;
    const ids = u.identities;
    if (Array.isArray(ids) && ids.length > 0) {
      return ids.some((id: any) => id?.provider === 'email');
    }
    const providers = u.app_metadata?.providers;
    if (Array.isArray(providers) && providers.length > 0) {
      return providers.includes('email');
    }
    const provider = u.app_metadata?.provider;
    return provider === 'email';
  })();

  // profile が読み込まれたら display_name を同期
  useEffect(() => {
    if (profile?.display_name) {
      setDisplayName(profile.display_name);
    }
    // ★ ニックネーム未設定時にメールの@前を入れない (公開名にメールが漏れるため空のまま)。
    if (user?.email) setEmail(user.email);
  }, [profile?.display_name, user?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // Avatar initials
  const initials = displayName.trim().slice(0, 2) || 'GU';

  // ── アバター画像（端末ローカル保存・MyPage 等と共有）──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarDataUrl = useAvatar(user?.id);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  async function handleAvatarFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 同じファイルを連続で選び直しても発火するように value をクリア
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: '画像ファイルを選択してください',
        description: 'JPEG / PNG / HEIC などの画像形式が対応しています。',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast({
        title: '画像のサイズが大きすぎます',
        description: '8MB以下の画像を選んでください。',
        variant: 'destructive',
      });
      return;
    }

    setUploadingAvatar(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256, 256, 0.85);
      if (user?.id) {
        const ok = saveAvatar(user.id, dataUrl);
        if (!ok) {
          toast({
            title: '保存できませんでした',
            description: '端末の保存容量が不足しています。',
            variant: 'destructive',
          });
          return;
        }
      }
      toast({ title: 'アイコンを変更しました ✅' });
    } catch (err) {
      toast({
        title: '画像を読み込めませんでした',
        description: String(err instanceof Error ? err.message : err),
        variant: 'destructive',
      });
    } finally {
      setUploadingAvatar(false);
    }
  }

  function toggleGenre(g: string) {
    setFavoriteGenres(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
    );
  }

  async function handleSaveProfile() {
    setSavingName(true);
    try {
      // ① display_name を Supabase に保存 (authedFetch が Bearer 自動付与)
      if (displayName.trim()) {
        // ★ クライアント即時バリデーション (サーバー側でも再チェックされる)
        const { validateNickname } = await import('@/lib/nickname-validator');
        const v = validateNickname(displayName);
        if (!v.ok) {
          toast({ title: '保存に失敗しました', description: v.reason, variant: 'destructive' });
          setSavingName(false);
          return;
        }
        const { authedFetch } = await import('@/lib/authed-fetch');
        // ★ Capacitor (iOS) でも動くよう VITE_API_BASE → BASE_URL の順で解決
        const apiBase =
          ((import.meta as any).env?.VITE_API_BASE as string) ||
          ((import.meta.env.BASE_URL as string) || '').replace(/\/$/, '');
        const res = await authedFetch(`${apiBase}/api/user/display-name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: displayName.trim() }),
        });
        if (res.status === 401) throw new Error('ログインセッションが切れています。再ログインしてください。');
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
          const msg = err.message || err.error || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        await refreshProfile();
      }
      // ② その他の設定は localStorage に保存
      save({ displayName, email, favoriteGenres });
      setEditingProfile(false);
      setSaved_(true);
      setTimeout(() => setSaved_(false), 2000);
      toast({ title: '表示名を保存しました ✅' });
    } catch (err: any) {
      console.error('[Settings] saveDisplayName error:', err);
      const desc = err?.message ? String(err.message) : String(err);
      toast({ title: '保存に失敗しました', description: desc, variant: 'destructive' });
    } finally {
      setSavingName(false);
    }
  }

  async function handleLogout() {
    await authSignOut();
    navigate('/welcome');
  }

  async function handleDeleteAccount() {
    setDeletingAccount(true);

    // ── ① サーバーへ削除リクエスト (authedFetch が Bearer 自動付与) ──
    let serverDeleted = false;
    let failureMessage = 'もう一度お試しください。';
    try {
      const { authedFetch } = await import('@/lib/authed-fetch');
      const base = (import.meta.env.BASE_URL as string).replace(/\/$/, '');
      const res = await authedFetch(`${base}/api/user/account`, { method: 'DELETE' });
      if (res.ok) {
        serverDeleted = true;
      } else if (res.status === 401 || res.status === 404) {
        // 既に削除済（残っていたトークンでの再試行）も成功扱い
        serverDeleted = true;
        console.info('[Settings] account already deleted server-side (status=', res.status, ')');
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
        failureMessage = err.message || `削除に失敗しました（${res.status}）`;
        console.error('[Settings] delete API failed:', res.status, err);
      }
    } catch (err: any) {
      console.error('[Settings] deleteAccount network error:', err);
      failureMessage = String(err?.message ?? err);
    }

    // ── ② 失敗時：エラー表示して終了 ────────────────────────────
    if (!serverDeleted) {
      setDeletingAccount(false);
      setShowDeleteAccount(false);
      toast({
        title: 'アカウントの削除に失敗しました',
        description: failureMessage,
        variant: 'destructive',
      });
      return;
    }

    // ── ③ 削除成功：signOut の例外は想定内（auth.users が既に消えている → 403）──
    try {
      await authSignOut();
    } catch (signOutErr) {
      console.warn('[Settings] signOut after delete threw (expected):', signOutErr);
    }

    // ── ④ 端末ローカルに残っていた下書き等を掃除（次に同じ端末で別ユーザが
    //       オンボーディングを始めたときにゴーストデータが残らないように） ──
    try {
      localStorage.removeItem('store-onboarding-draft-v2');
      localStorage.removeItem('store-onboarding-draft-v1');
    } catch (_) {}

    setDeletingAccount(false);
    setShowDeleteAccount(false);
    toast({
      title: 'アカウントを削除しました',
      description: 'ご利用いただきありがとうございました。',
    });
    navigate('/welcome');
  }

  return (
    <SettingsWrapper>
      <AnimatePresence>
        {showTokusho && <TokushoModal onClose={() => setShowTokusho(false)} />}
        {showDeleteAccount && (
          <DeleteAccountModal
            onClose={() => setShowDeleteAccount(false)}
            onConfirm={handleDeleteAccount}
            deleting={deletingAccount}
            isStoreOwner={isStoreOwner}
          />
        )}
        {showChangePassword && user?.email && (
          <ChangePasswordModal
            email={user.email}
            onClose={() => setShowChangePassword(false)}
          />
        )}
      </AnimatePresence>
      <div className="max-w-md md:max-w-2xl mx-auto pb-16">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-4 sticky bg-background/90 backdrop-blur-sm z-10 border-b border-border/50"
          style={{ top: 'calc(var(--layout-header-height, 0px) + env(safe-area-inset-top))' }}>
          {!isStoreOwner && (
            <button
              onClick={() => navigate('/mypage')}
              className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors shrink-0"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <h1 className="text-xl font-black text-foreground">アカウント設定</h1>
        </div>

        <div className="px-4 pt-4">

          {/* ── PROFILE (店舗オーナーは店舗プロフィール画面で別途管理するため非表示) ── */}
          {!isStoreOwner && (<>
          <SectionLabel>プロフィール</SectionLabel>
          <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-1">

            {/* Avatar row */}
            <div className="flex items-center gap-4 px-4 py-5 border-b border-border/60">
              {/* hidden file input - カメラボタンから起動 */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleAvatarFileChange}
                aria-hidden="true"
              />
              <div className="relative shrink-0">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-black shadow-md overflow-hidden"
                  style={avatarDataUrl ? undefined : { background: 'linear-gradient(135deg, #2D5A51, #4A8C7F)' }}
                >
                  {avatarDataUrl ? (
                    <img
                      src={avatarDataUrl}
                      alt="プロフィールアイコン"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  aria-label="プロフィール写真を変更"
                  className="absolute -bottom-1 -right-1 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-sm hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50"
                >
                  {uploadingAvatar ? (
                    <span className="w-3 h-3 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Camera className="w-3 h-3" />
                  )}
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-foreground">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate">{email || 'メール未設定'}</p>
              </div>
              <button
                onClick={() => setEditingProfile(v => !v)}
                className="flex items-center gap-1.5 text-primary text-sm font-bold px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 transition-colors shrink-0"
              >
                <Pencil className="w-3.5 h-3.5" />
                {editingProfile ? '閉じる' : '編集'}
              </button>
            </div>

            {/* Inline edit form */}
            <AnimatePresence>
              {editingProfile && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 py-4 space-y-3 border-b border-border/60 bg-secondary/20">
                    {/* ニックネーム (任意・ランキング参加時に使用) */}
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                        ニックネーム <span className="font-normal text-muted-foreground/70">(任意)</span>
                      </label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                          type="text"
                          value={displayName}
                          onChange={e => setDisplayName(e.target.value)}
                          className="w-full bg-card border border-border rounded-xl pl-9 pr-4 py-2.5 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                          placeholder="例: たろう"
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground/70 mt-1 leading-snug">
                        ランキングに参加する時に他のユーザーへ表示される名前です。 本名ではなく公開しても良い名前を入力してください。
                      </p>
                    </div>

                    {/* Email */}
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground mb-1.5">メールアドレス</label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                          type="email"
                          value={email}
                          onChange={e => setEmail(e.target.value)}
                          className="w-full bg-card border border-border rounded-xl pl-9 pr-4 py-2.5 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                          placeholder="example@email.com"
                        />
                      </div>
                    </div>

                    {/* Save */}
                    <button
                      onClick={handleSaveProfile}
                      disabled={savingName}
                      className="w-full py-2.5 bg-primary text-primary-foreground font-black text-sm rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                      {savingName
                        ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />保存中...</>
                        : saved_
                        ? <><Check className="w-4 h-4" />保存しました！</>
                        : <>変更を保存する</>
                      }
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          </>)}

          {/* ── NOTIFICATIONS ── */}
          <SectionLabel>通知設定</SectionLabel>
          <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-1">
            {isStoreOwner ? (
              <>
                <div className="flex items-center gap-3.5 px-4 min-h-[56px] border-b border-border/60">
                  <div className="w-9 h-9 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4 text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">新規注文の通知</p>
                    <p className="text-xs text-muted-foreground">お客様が購入した直後に通知</p>
                  </div>
                  <Toggle value={notifNewOrder} onChange={handleNotifNewOrderToggle} />
                </div>

                {/* ── 注文メール通知 (デフォルト OFF・ ON にした店舗のみ受信) ── */}
                <div className="flex items-center gap-3.5 px-4 min-h-[56px] border-t border-border/60">
                  <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                    <Mail className="w-4 h-4 text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">注文時のメール通知</p>
                    <p className="text-xs text-muted-foreground">登録メールアドレスに、 注文が入った際にメールが届きます</p>
                  </div>
                  <Toggle value={notifEmailOrders} onChange={handleNotifEmailOrdersToggle} />
                </div>

                {/* ── 未出品リマインド (今日まだ出品してない時に届く毎日のお知らせ) ── */}
                <div className="flex items-center gap-3.5 px-4 min-h-[56px] border-t border-border/60">
                  <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4 text-orange-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">未出品リマインド</p>
                    <p className="text-xs text-muted-foreground">その日まだ出品がないとき、出品をおすすめする通知が届きます</p>
                  </div>
                  <Toggle value={notifUnlistedReminder} onChange={handleNotifUnlistedReminderToggle} />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3.5 px-4 min-h-[56px] border-b border-border/60">
                  <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4 text-blue-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">新しいおすそわけのお知らせ</p>
                    <p className="text-xs text-muted-foreground">新しいバッグが出たとき（1日最大5件・夜間を除く）</p>
                  </div>
                  <Toggle value={notifNewListing} onChange={handleNotifNewListingToggle} />
                </div>

                <div className="flex items-center gap-3.5 px-4 min-h-[56px] border-b border-border/60">
                  <div className="w-9 h-9 rounded-xl bg-rose-100 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4 text-rose-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">お気に入り店舗の更新</p>
                    <p className="text-xs text-muted-foreground">フォロー中の店舗が出品したとき</p>
                  </div>
                  <Toggle value={notifFavoriteUpdate} onChange={handleNotifFavoriteUpdateToggle} />
                </div>

                <div className="flex items-center gap-3.5 px-4 min-h-[56px]">
                  <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4 text-orange-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground">毎日のおすそわけ情報</p>
                    <p className="text-xs text-muted-foreground">昼前と夕方、出品があるときにお届け</p>
                  </div>
                  <Toggle value={notifDailyEngagement} onChange={handleNotifDailyEngagementToggle} />
                </div>
              </>
            )}
          </div>

          {/* ★ ランキング参加トグルは削除 (RankingPage 内にプレビュー付きトグルがあるため重複)。
                ニックネーム入力 (上のアカウント情報) は残し、 ON/OFF は RankingPage で完結させる。 */}

          {/* ── LOGOUT / DELETE ── */}
          <SectionLabel>アカウント</SectionLabel>
          <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-8">
            {hasEmailProvider && (
              <button
                onClick={() => setShowChangePassword(true)}
                className="w-full flex items-center gap-3.5 px-4 min-h-[56px] hover:bg-secondary/50 active:bg-secondary/70 transition-colors border-b border-border/60"
              >
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Lock className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 text-left">
                  <span className="block font-bold text-sm text-foreground">パスワードを変更</span>
                  <span className="block text-xs text-muted-foreground">忘れた場合は再設定メールも送れます</span>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3.5 px-4 min-h-[56px] hover:bg-destructive/5 active:bg-destructive/10 transition-colors border-b border-border/60"
            >
              <div className="w-9 h-9 rounded-xl bg-destructive/10 flex items-center justify-center shrink-0">
                <LogOut className="w-4 h-4 text-destructive" />
              </div>
              <span className="flex-1 font-bold text-sm text-destructive text-left">ログアウト</span>
            </button>
            <button
              onClick={() => setShowDeleteAccount(true)}
              className="w-full flex items-center gap-3.5 px-4 min-h-[56px] hover:bg-destructive/5 active:bg-destructive/10 transition-colors"
            >
              <div className="w-9 h-9 rounded-xl bg-destructive/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4 text-destructive" />
              </div>
              <div className="flex-1 text-left">
                <span className="block font-bold text-sm text-destructive">アカウント削除（退会）</span>
                <span className="block text-xs text-muted-foreground">全データを完全に削除します</span>
              </div>
            </button>
          </div>

          <p className="text-center text-xs text-muted-foreground pb-4">おすそわけ v1.0.0</p>
        </div>
      </div>
    </SettingsWrapper>
  );
}
