// 俺らだけの成長ボード（/board）。
// 管理者権限ではなく「合言葉コード」で入れる共有ビュー。従業員も見るので危険な操作は一切なし。
// できること = 成長データ閲覧 + 今日のチェックリスト消化 + 何でも聞けるAI相談。
// ★ Push配信などの"実行"は神モード(/admin)だけ。 board は「見る・考える」専用。
import { useCallback, useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
const CODE_KEY = 'osusowake_board_code';

interface DeadStore {
  id: number; name: string; city: string; orders: number; gmv: number;
  liveBags: number; lastBagAt: string | null; daysSinceLastBag: number | null;
}
interface LiveStore {
  id: number; name: string; city: string; category: string | null; title: string;
  originalPrice: number; discountedPrice: number; stock: number;
  pickupStart: string | null; pickupEnd: string | null;
}
interface GrowthData {
  funnel: {
    registered: number; favorited: number; buyers: number; repeatBuyers: number;
    newUsers7d: number; newUsers30d: number;
    rates: { registerToFav: number; favToBuy: number; registerToBuy: number; buyToRepeat: number };
  };
  hotLeads: { favNoPurchase: number; registered7dNoPurchase: number };
  deadStores: DeadStore[];
  liveStores: LiveStore[];
  supply: { approvedActiveStores: number; storesWithLiveBags: number; liveBags: number; liveStockUnits: number };
  weeklyTrend: { week: string; newUsers: number; buyers: number; gmv: number }[];
  reviews?: { count: number; avgRating: number };
}
interface AppStoreMetrics { downloads: number; impressions: number; updatedAt: string | null }
interface NotificationReach { members: number; anonIos: number; anonWeb: number; total: number }
interface SalesForecast {
  today: { listedBags: number; listedUnits: number; soldUnits: number; revenue: number; soldOutBags: number; sellThrough: number };
  daily: { date: string; listedUnits: number; soldUnits: number; revenue: number; sellThrough: number }[];
  storePerformance: { storeId: number; name: string; category: string | null; listedUnits: number; soldUnits: number; sellThrough: number; revenue: number }[];
  categoryPerformance: { category: string; listedUnits: number; soldUnits: number; sellThrough: number }[];
  forecast: { sampleDays: number; avgSellThrough: number; bestCategory: string | null; worstCategory: string | null; note: string };
}
type TimeSlot = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';
interface ChecklistTarget { label: string; sub?: string }
interface ChecklistItem {
  id: string;
  category: 'supply' | 'reengage' | 'instagram' | 'threads' | 'community' | 'ops';
  timeSlot: TimeSlot;
  title: string;
  priority: 'must' | 'high' | 'normal';
  estMinutes: number;
  reason: string;
  kpi?: string;
  steps: string[];
  targets?: ChecklistTarget[];
  template?: string;
  bestTime?: string;
  action?: { type: 'reengage'; segment: 'fav_no_purchase' | 'registered_no_purchase_7d'; label: string };
}
interface BoardResponse {
  ok: boolean;
  growth: GrowthData;
  appstore: AppStoreMetrics;
  reach?: NotificationReach;
  sales?: SalesForecast;
  checklist: ChecklistItem[];
  checklistSource?: 'ai' | 'template';
  checkState: Record<string, boolean>;
  today: string;
}

const CAT_META: Record<ChecklistItem['category'], { label: string; emoji: string; color: string }> = {
  supply:    { label: '供給',       emoji: '📦', color: '#f97316' },
  reengage:  { label: '再エンゲージ', emoji: '🔔', color: '#e11d48' },
  instagram: { label: 'Instagram',  emoji: '📸', color: '#c026d3' },
  threads:   { label: 'Threads',    emoji: '🧵', color: '#0f172a' },
  community: { label: 'コミュニティ', emoji: '🤝', color: '#0891b2' },
  ops:       { label: '運営',       emoji: '⚙️', color: '#475569' },
};
const PRIORITY_META: Record<ChecklistItem['priority'], { label: string; color: string }> = {
  must:   { label: '必須',  color: '#dc2626' },
  high:   { label: '重要',  color: '#ea580c' },
  normal: { label: '通常',  color: '#64748b' },
};
const SLOT_ORDER: TimeSlot[] = ['morning', 'midday', 'afternoon', 'evening', 'night'];
const SLOT_META: Record<TimeSlot, { label: string; emoji: string; hint: string }> = {
  morning:   { label: '朝イチ', emoji: '🌅', hint: '07:30〜10:00' },
  midday:    { label: '昼',     emoji: '☀️', hint: '11:00〜14:00' },
  afternoon: { label: '午後',   emoji: '🏪', hint: '14:00〜17:00' },
  evening:   { label: '夕方',   emoji: '🌆', hint: '17:00〜19:00' },
  night:     { label: '夜',     emoji: '🌙', hint: '21:00〜23:00' },
};

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP');

export default function BoardPage() {
  const [code, setCode] = useState<string>(() => localStorage.getItem(CODE_KEY) || '');
  const [authed, setAuthed] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<BoardResponse | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 何でも聞けるAI相談（画像添付対応）
  const [chat, setChat] = useState<{ role: 'user' | 'assistant'; content: string; images?: string[] }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatImages, setChatImages] = useState<string[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const load = useCallback(async (c: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`${BASE}/api/board/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Board-Code': c },
        body: JSON.stringify({ code: c }),
      });
      if (res.status === 401) { setErr('合言葉が違うで'); setAuthed(false); localStorage.removeItem(CODE_KEY); return; }
      if (!res.ok) { setErr('読み込み失敗（' + res.status + '）'); return; }
      const j = (await res.json()) as BoardResponse;
      setData(j); setAuthed(true); setCode(c); localStorage.setItem(CODE_KEY, c);
    } catch {
      setErr('通信エラー');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (code) load(code); }, [code, load]);

  // ★ 日付跨ぎ対策: board を開きっぱなしで 00:00(JST) を越えたら、
  //   自動でリロードして「今日のチェックリスト」を翌日の新品(全部未チェック)に切り替える。
  //   1分ごとに現在のJST日付を server が返した data.today と比べ、ズレたら load。
  useEffect(() => {
    if (!authed || !data) return;
    const id = setInterval(() => {
      const jstNow = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (jstNow !== data.today) load(code);
    }, 60 * 1000);
    return () => clearInterval(id);
  }, [authed, data, code, load]);

  const toggleCheck = useCallback(async (item: ChecklistItem) => {
    if (!data) return;
    const next = !data.checkState[item.id];
    setData({ ...data, checkState: { ...data.checkState, [item.id]: next } });
    try {
      await fetch(`${BASE}/api/board/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Board-Code': code },
        body: JSON.stringify({ code, itemId: item.id, done: next }),
      });
    } catch { /* 楽観更新のまま */ }
  }, [data, code]);

  // 画像を長辺1280pxに縮小して data URL(JPEG)化。 巨大な生写真をそのまま投げない。
  const addChatImages = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, 4);
    for (const file of arr) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            const max = 1280;
            let { width, height } = img;
            if (width > max || height > max) {
              const r = Math.min(max / width, max / height);
              width = Math.round(width * r); height = Math.round(height * r);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load fail')); };
          img.src = url;
        });
        setChatImages((imgs) => (imgs.length >= 4 ? imgs : [...imgs, dataUrl]));
      } catch { /* skip broken image */ }
    }
  }, []);

  // 何でも聞けるAI: その日の実データ＋添付画像を見て関西弁で相談に乗る（読み取り+助言のみ）。
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if ((!msg && chatImages.length === 0) || chatBusy) return;
    const imgs = chatImages;
    const history = chat.slice(-6).map(({ role, content }) => ({ role, content })); // 履歴はテキストのみ
    setChat((c) => [...c, { role: 'user', content: msg, images: imgs.length ? imgs : undefined }]);
    setChatInput('');
    setChatImages([]);
    setChatBusy(true);
    try {
      const res = await fetch(`${BASE}/api/board/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Board-Code': code },
        body: JSON.stringify({ code, message: msg, images: imgs, history }),
      });
      const j = await res.json();
      const reply = res.ok && j.reply ? j.reply : '❌ ' + (j.message || `エラー(${res.status})`);
      setChat((c) => [...c, { role: 'assistant', content: reply }]);
    } catch {
      setChat((c) => [...c, { role: 'assistant', content: '❌ 通信エラー。もう一回試して。' }]);
    } finally {
      setChatBusy(false);
    }
  }, [chatInput, chatImages, chatBusy, chat, code]);

  const doCopy = useCallback((id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  }, []);

  const updateAppstore = useCallback(async () => {
    // App Store Connect > トレンド から手動で拾う2値。 空欄キャンセルでその値は据え置き。
    const curDl = data?.appstore.downloads || 0;
    const curImp = data?.appstore.impressions || 0;
    const dl = window.prompt('① 累計ダウンロード数（App Store Connect）\n※ 空欄OK・キャンセルで据え置き', curDl ? String(curDl) : '');
    const imp = window.prompt('② インプレッション数（App Store Connect > トレンド）\n※ 空欄OK・キャンセルで据え置き', curImp ? String(curImp) : '');
    if (dl == null && imp == null) return; // 両方キャンセル＝変更なし
    setBusy('appstore');
    try {
      await fetch(`${BASE}/api/board/appstore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Board-Code': code },
        body: JSON.stringify({
          code,
          downloads: dl == null || dl.trim() === '' ? undefined : Number(dl),
          impressions: imp == null || imp.trim() === '' ? undefined : Number(imp),
        }),
      });
      await load(code);
    } catch { /* noop */ }
    finally { setBusy(null); }
  }, [data, code, load]);

  // ── 未認証: 合言葉入力 ──
  if (!authed) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#f8f7f4', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 360, background: '#fff', borderRadius: 20, padding: 28, boxShadow: '0 8px 30px rgba(0,0,0,.08)' }}>
          <div style={{ fontSize: 32, textAlign: 'center' }}>📈</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '8px 0 4px' }}>おすそわけ 成長ボード</h1>
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', margin: '0 0 18px' }}>俺らだけの合言葉で入るで</p>
          <input
            type="password" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && input) load(input); }}
            placeholder="合言葉"
            style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 16, borderRadius: 12, border: '1.5px solid #e2e8f0', marginBottom: 12 }}
          />
          {err && <p style={{ color: '#dc2626', fontSize: 13, margin: '0 0 12px' }}>{err}</p>}
          <button
            onClick={() => input && load(input)} disabled={loading || !input}
            style={{ width: '100%', padding: '12px', fontSize: 16, fontWeight: 700, borderRadius: 12, border: 'none', background: '#16a34a', color: '#fff', opacity: loading || !input ? .6 : 1 }}
          >{loading ? '確認中…' : '入る'}</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', color: '#64748b' }}>{loading ? '読み込み中…' : (err || '—')}</div>;
  }

  const { growth, appstore, reach, sales, checklist, checklistSource, checkState } = data;
  const f = growth.funnel;
  const doneCount = checklist.filter((i) => checkState[i.id]).length;
  const progress = checklist.length ? Math.round((doneCount / checklist.length) * 100) : 0;
  const totalMin = checklist.reduce((a, i) => a + (i.estMinutes || 0), 0);
  const bySlot = checklist.reduce((acc, i) => {
    (acc[i.timeSlot] ||= []).push(i);
    return acc;
  }, {} as Record<TimeSlot, ChecklistItem[]>);

  // ファネル各段（DL数を頭に足した完全版）
  const dl = appstore.downloads || 0;
  const imp = appstore.impressions || 0;
  // App Store の数字(imp/dl)は手動入力。 未入力(0)なら“壊れた0”を出さず「未入力」を明示し、
  //   その先の比率(CVR/DL比)も計算不能なので出さない。
  const funnelSteps = [
    { label: 'インプレッション', v: imp, sub: imp ? 'App Store 表示回数' : '未入力 — 右上「編集」で入力', unset: !imp },
    { label: 'ダウンロード', v: dl, sub: dl ? (imp ? `CVR ${((dl / imp) * 100).toFixed(1)}%` : 'App Store 累計DL') : '未入力 — 右上「編集」で入力', unset: !dl },
    { label: '会員登録', v: f.registered, sub: dl ? `DLの${((f.registered / dl) * 100).toFixed(0)}%` : `${f.registered.toLocaleString('ja-JP')}人` },
    { label: 'お気に入り', v: f.favorited, sub: `登録の${f.rates.registerToFav}%` },
    { label: '初回購入', v: f.buyers, sub: `登録の${f.rates.registerToBuy}%` },
    { label: 'リピート', v: f.repeatBuyers, sub: `購入の${f.rates.buyToRepeat}%` },
  ] as { label: string; v: number; sub: string; unset?: boolean }[];
  const maxF = Math.max(...funnelSteps.map((s) => s.v), 1);

  return (
    <div style={{ minHeight: '100dvh', background: '#f8f7f4', paddingBottom: 60 }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>📈 成長ボード</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0' }}>{data.today} · 俺らだけの神モード</p>
          </div>
          <button onClick={() => load(code)} disabled={loading}
            style={{ padding: '8px 12px', borderRadius: 10, border: '1.5px solid #e2e8f0', background: '#fff', fontSize: 13, fontWeight: 600 }}>
            {loading ? '…' : '↻ 更新'}
          </button>
        </header>

        {/* 今日の進捗バー */}
        <Card>
          <Row>
            <b style={{ fontSize: 15 }}>今日のチェックリスト
              {checklistSource === 'ai' && <span style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#f3e8ff', borderRadius: 999, padding: '2px 8px', marginLeft: 8, verticalAlign: 'middle' }}>🤖 AI分析</span>}
            </b>
            <span style={{ fontSize: 13, color: '#64748b' }}>{doneCount}/{checklist.length} 完了</span>
          </Row>
          <div style={{ height: 10, borderRadius: 6, background: '#eef1f4', overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', width: `${progress}%`, background: progress === 100 ? '#16a34a' : '#22c55e', transition: 'width .3s' }} />
          </div>
        </Card>

        {/* 供給の脈拍 */}
        <Card>
          <b style={{ fontSize: 15 }}>📦 供給の脈拍（今この瞬間）</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginTop: 10 }}>
            <Stat label="出品中の店" value={growth.supply.storesWithLiveBags} danger={growth.supply.storesWithLiveBags < 10} suffix="店" />
            <Stat label="ライブ在庫" value={growth.supply.liveStockUnits} danger={growth.supply.liveStockUnits < 20} suffix="個" />
            <Stat label="ライブ袋数" value={growth.supply.liveBags} suffix="件" />
            <Stat label="承認済み店" value={growth.supply.approvedActiveStores} suffix="店" />
          </div>
          {growth.supply.storesWithLiveBags < 10 && (
            <p style={{ fontSize: 12, color: '#dc2626', margin: '10px 0 0', fontWeight: 600 }}>
              ⚠️ 在庫が薄い。買える店が10未満やと新規が「何もない」で離脱する。まず供給を叩き起こせ。
            </p>
          )}
        </Card>

        {/* 通知リーチ数（次のデイリー通知が実際に届く総数） */}
        {reach && (
          <Card>
            <Row>
              <b style={{ fontSize: 15 }}>🔔 通知リーチ数</b>
              <span style={{ fontSize: 26, fontWeight: 800, color: '#e11d48' }}>
                {reach.total.toLocaleString('ja-JP')}<span style={{ fontSize: 13, marginLeft: 2 }}>人</span>
              </span>
            </Row>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 10px' }}>
              次のデイリー通知が“今この瞬間”実際に届く宛先数（重複排除・二重送信除外済み）
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              <Stat label="会員（登録済）" value={reach.members} suffix="人" />
              <Stat label="匿名 iOS" value={reach.anonIos} suffix="台" />
              <Stat label="匿名 Web" value={reach.anonWeb} suffix="件" />
            </div>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '10px 0 0' }}>
              ※ 匿名 = 会員登録前でも通知を許可した端末。 アプリ/サイトを開くたびに増える。
            </p>
          </Card>
        )}

        {/* 販売実績 & 予測（出品した商品がちゃんと売れてるか） */}
        {sales && (
          <Card>
            <Row>
              <b style={{ fontSize: 15 }}>📊 販売実績 &amp; 予測</b>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>今日の販売率</span>
            </Row>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '4px 0 2px' }}>
              <span style={{ fontSize: 32, fontWeight: 800, color: sales.today.sellThrough >= 60 ? '#16a34a' : sales.today.sellThrough >= 30 ? '#ea580c' : '#dc2626' }}>
                {sales.today.sellThrough}<span style={{ fontSize: 15, marginLeft: 1 }}>%</span>
              </span>
              <span style={{ fontSize: 12, color: '#64748b' }}>
                {sales.today.soldUnits}/{sales.today.listedUnits}個 売れた
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginTop: 10 }}>
              <Stat label="今日の出品" value={sales.today.listedBags} suffix="袋" />
              <Stat label="今日の売上" value={sales.today.revenue} prefix="¥" />
              <Stat label="完売した袋" value={sales.today.soldOutBags} suffix="袋" />
              <Stat label="出品在庫" value={sales.today.listedUnits} suffix="個" />
            </div>

            {/* 予測ノート */}
            <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: '#fff7ed', border: '1px solid #fed7aa' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#9a3412', marginBottom: 4 }}>
                🔮 明日の出品予測（直近{sales.forecast.sampleDays}日・平均販売率 {sales.forecast.avgSellThrough}%）
              </div>
              <p style={{ fontSize: 12, color: '#7c2d12', margin: 0, lineHeight: 1.5 }}>{sales.forecast.note}</p>
            </div>

            {/* 日別: 出品 vs 売れた */}
            {sales.daily.length > 0 && (
              <div style={{ height: 170, marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>日別（出品在庫 vs 売れた個数）</div>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sales.daily} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f4" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="listedUnits" name="出品" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="soldUnits" name="売れた" fill="#16a34a" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 店別の売れ行き（直近14日） */}
            {sales.storePerformance.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>店別の売れ行き（直近14日・売れた順）</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {sales.storePerformance.slice(0, 8).map((s) => (
                    <div key={s.storeId}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                        <span style={{ color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{s.name}</span>
                        <span style={{ fontWeight: 700, color: s.sellThrough >= 60 ? '#16a34a' : s.sellThrough >= 30 ? '#ea580c' : '#dc2626' }}>
                          {s.sellThrough}% <span style={{ color: '#94a3b8', fontWeight: 500 }}>({s.soldUnits}/{s.listedUnits}個 · {yen(s.revenue)})</span>
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: '#eef1f4', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(s.sellThrough, 100)}%`, background: s.sellThrough >= 60 ? '#16a34a' : s.sellThrough >= 30 ? '#f59e0b' : '#f87171', borderRadius: 3 }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* カテゴリ別 */}
            {sales.categoryPerformance.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>ジャンル別の売れ行き（直近14日）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {sales.categoryPerformance.map((c) => (
                    <span key={c.category} style={{
                      fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 8,
                      background: c.sellThrough >= 60 ? '#dcfce7' : c.sellThrough >= 30 ? '#ffedd5' : '#fee2e2',
                      color: c.sellThrough >= 60 ? '#166534' : c.sellThrough >= 30 ? '#9a3412' : '#991b1b',
                    }}>
                      {c.category} {c.sellThrough}%（{c.soldUnits}/{c.listedUnits}）
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* アクティベーション・ファネル（完全版） */}
        <Card>
          <Row>
            <b style={{ fontSize: 15 }}>🎯 アクティベーション・ファネル</b>
            <button onClick={updateAppstore} disabled={busy === 'appstore'}
              style={{ fontSize: 11, padding: '4px 8px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
              {busy === 'appstore' ? '保存中…' : '✏️ 数字を編集'}
            </button>
          </Row>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 12px' }}>
            App Store数字は手動更新{appstore.updatedAt ? `（${appstore.updatedAt}）` : '（未設定）'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {funnelSteps.map((s, i) => {
              // 未入力(unset)の段、または直前が未入力の段では脱落率を出さない（計算不能）。
              const prevStep = i > 0 ? funnelSteps[i - 1] : null;
              const prev = prevStep && !prevStep.unset ? prevStep.v : null;
              const drop = !s.unset && prev && prev > 0 ? Math.round((1 - s.v / prev) * 100) : null;
              return (
                <div key={s.label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: '#334155' }}>{s.label} <span style={{ color: s.unset ? '#f97316' : '#94a3b8' }}>{s.sub}</span></span>
                    <span style={{ fontWeight: 700, color: s.unset ? '#cbd5e1' : '#0f172a' }}>
                      {s.unset ? '—' : s.v.toLocaleString('ja-JP')}
                      {drop != null && drop > 0 && <span style={{ color: '#dc2626', fontWeight: 600, marginLeft: 6, fontSize: 11 }}>▼{drop}%脱落</span>}
                    </span>
                  </div>
                  <div style={{ height: 20, borderRadius: 5, background: '#eef1f4', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: s.unset ? '0%' : `${Math.max((s.v / maxF) * 100, 2)}%`, background: i >= 4 ? '#16a34a' : '#60a5fa', borderRadius: 5, transition: 'width .3s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ホットリード */}
        <Card>
          <b style={{ fontSize: 15 }}>🔥 ホットリード（あと一押しで買う層）</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginTop: 10 }}>
            <HotLead label="お気に入り済・未購入" value={growth.hotLeads.favNoPurchase} />
            <HotLead label="7日以内登録・未購入" value={growth.hotLeads.registered7dNoPurchase} />
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '10px 0 0' }}>
            ※ Pushはチェックリストの再エンゲージ項目から撃てるで
          </p>
        </Card>

        {/* 週次トレンド */}
        {growth.weeklyTrend.length > 0 && (
          <Card>
            <b style={{ fontSize: 15 }}>📊 週次トレンド（新規登録 / 購入者）</b>
            <div style={{ height: 180, marginTop: 10 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={growth.weeklyTrend} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f4" />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="newUsers" name="新規" fill="#60a5fa" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="buyers" name="購入者" fill="#16a34a" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        {/* ── 今日の完璧なチェックリスト（時間帯タイムライン式）── */}
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '24px 4px 6px' }}>✅ 今日のタイムライン</h2>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 4px 14px' }}>
          {checklistSource === 'ai'
            ? 'AIが今日の実データを分析して、今日一番効く順に組んだ実行リスト。毎日中身が変わる。'
            : 'データから自動生成。上から順にやれば完璧に回る。'} 合計 約{totalMin}分・{checklist.length}タスク。
        </p>

        {SLOT_ORDER.filter((slot) => bySlot[slot]?.length).map((slot) => {
          const sm = SLOT_META[slot];
          const list = bySlot[slot];
          const slotDone = list.filter((i) => checkState[i.id]).length;
          const slotMin = list.reduce((a, i) => a + (i.estMinutes || 0), 0);
          return (
            <div key={slot} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 4px 8px' }}>
                <span style={{ fontSize: 17, fontWeight: 800 }}>{sm.emoji} {sm.label}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>{sm.hint}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: slotDone === list.length ? '#16a34a' : '#64748b', fontWeight: 600 }}>{slotDone}/{list.length} · 約{slotMin}分</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {list.map((item) => {
                  const cat = CAT_META[item.category];
                  const pri = PRIORITY_META[item.priority];
                  const done = !!checkState[item.id];
                  const isOpen = !!open[item.id];
                  return (
                    <div key={item.id} style={{ background: '#fff', borderRadius: 14, boxShadow: '0 2px 10px rgba(0,0,0,.05)', overflow: 'hidden', opacity: done ? .6 : 1, border: `1px solid ${done ? '#dcfce7' : item.priority === 'must' ? '#fecaca' : '#f1f5f9'}` }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 14 }}>
                        <button onClick={() => toggleCheck(item)} aria-label="完了切替"
                          style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 8, border: `2px solid ${done ? '#16a34a' : '#cbd5e1'}`, background: done ? '#16a34a' : '#fff', color: '#fff', fontSize: 15, lineHeight: '22px', cursor: 'pointer', marginTop: 1 }}>
                          {done ? '✓' : ''}
                        </button>
                        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen((o) => ({ ...o, [item.id]: !o[item.id] }))}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: pri.color, borderRadius: 5, padding: '2px 6px' }}>{pri.label}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: cat.color, background: cat.color + '18', borderRadius: 5, padding: '2px 6px' }}>{cat.emoji} {cat.label}</span>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>⏱ {item.estMinutes}分</span>
                          </div>
                          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 5, textDecoration: done ? 'line-through' : 'none' }}>{item.title}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{item.reason}</div>
                        </div>
                        <button onClick={() => setOpen((o) => ({ ...o, [item.id]: !o[item.id] }))}
                          style={{ flexShrink: 0, border: 'none', background: 'transparent', fontSize: 16, color: '#94a3b8', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▾</button>
                      </div>

                      {isOpen && (
                        <div style={{ padding: '0 14px 16px 50px' }}>
                          {item.kpi && (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: 10, padding: '8px 10px', marginTop: 4 }}>
                              <span style={{ fontSize: 12 }}>🎯</span>
                              <span style={{ fontSize: 12.5, color: '#166534', fontWeight: 600 }}>今日の合格ライン：{item.kpi}</span>
                            </div>
                          )}

                          {item.targets && item.targets.length > 0 && (
                            <div style={{ marginTop: 12 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
                                {item.category === 'supply' ? '今日連絡する店' : '対象'}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {item.targets.map((t, i) => (
                                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '8px 10px' }}>
                                    <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 6, background: '#f97316', color: '#fff', fontSize: 11, fontWeight: 700, textAlign: 'center', lineHeight: '20px' }}>{i + 1}</span>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontSize: 13, fontWeight: 700, color: '#9a3412' }}>{t.label}</div>
                                      {t.sub && <div style={{ fontSize: 11, color: '#c2743a' }}>{t.sub}</div>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', margin: '12px 0 6px' }}>手順</div>
                          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {item.steps.map((s, i) => (
                              <li key={i} style={{ fontSize: 13, color: '#334155', lineHeight: 1.5 }}>{s}</li>
                            ))}
                          </ol>

                          {item.template && (
                            <div style={{ marginTop: 12 }}>
                              <Row><span style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>コピペ用テンプレ（実データ入り）</span>
                                <button onClick={() => doCopy(item.id, item.template!)}
                                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: copied === item.id ? '#dcfce7' : '#fff', fontWeight: 600 }}>
                                  {copied === item.id ? '✓ コピー済' : '📋 コピー'}
                                </button>
                              </Row>
                              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, color: '#0f172a', background: '#f8fafc', border: '1px solid #eef1f4', borderRadius: 10, padding: 12, margin: '6px 0 0', fontFamily: 'inherit', lineHeight: 1.55 }}>{item.template}</pre>
                            </div>
                          )}

                          {item.bestTime && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>🕐 推奨: {item.bestTime}</div>}

                          {item.action?.type === 'reengage' && (
                            <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca', fontSize: 12.5, color: '#9f1239', lineHeight: 1.5 }}>
                              🔒 このPush配信（{item.action.label}）は<b>神モード専用</b>。実行は管理画面（/admin）からやってな。
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* 何でも聞けるAI相談 */}
        <Card style={{ marginTop: 16 }}>
          <b style={{ fontSize: 15 }}>🤖 何でも聞けるAI</b>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 10px' }}>今日の実データを見て相談に乗るで。「今日どのカテゴリが売れ残ってる？」「明日伸ばすには？」など何でも</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', marginBottom: 10 }}>
            {chat.length === 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['今日の販売率どう？', '売れ残ってるカテゴリは？', '明日 売上伸ばすには？', '叩き起こすべき店は？'].map((q) => (
                  <button key={q} onClick={() => setChatInput(q)}
                    style={{ fontSize: 12, padding: '6px 10px', borderRadius: 999, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontWeight: 600 }}>{q}</button>
                ))}
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 4 }}>
                {m.images && m.images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                    {m.images.map((src, k) => (
                      <img key={k} src={src} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 10, border: '1px solid #e2e8f0' }} />
                    ))}
                  </div>
                )}
                {m.content && (
                  <div style={{
                    fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: '9px 12px', borderRadius: 14,
                    background: m.role === 'user' ? '#16a34a' : '#f1f5f9',
                    color: m.role === 'user' ? '#fff' : '#0f172a',
                    borderBottomRightRadius: m.role === 'user' ? 4 : 14,
                    borderBottomLeftRadius: m.role === 'user' ? 14 : 4,
                  }}>{m.content}</div>
                )}
              </div>
            ))}
            {chatBusy && <div style={{ alignSelf: 'flex-start', fontSize: 13, color: '#94a3b8', padding: '9px 12px' }}>考え中…</div>}
          </div>
          {/* 添付画像プレビュー */}
          {chatImages.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {chatImages.map((src, k) => (
                <div key={k} style={{ position: 'relative' }}>
                  <img src={src} alt="" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }} />
                  <button onClick={() => setChatImages((imgs) => imgs.filter((_, j) => j !== k))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 999, border: 'none', background: '#0f172a', color: '#fff', fontSize: 12, lineHeight: '20px', textAlign: 'center', padding: 0, cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ flexShrink: 0, width: 44, height: 44, display: 'grid', placeItems: 'center', fontSize: 20, borderRadius: 12, border: '1.5px solid #e2e8f0', background: '#fff', cursor: chatBusy ? 'default' : 'pointer', opacity: chatBusy || chatImages.length >= 4 ? .5 : 1 }}>
              📎
              <input type="file" accept="image/*" multiple hidden disabled={chatBusy || chatImages.length >= 4}
                onChange={(e) => { if (e.target.files) addChatImages(e.target.files); e.target.value = ''; }} />
            </label>
            <input
              value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendChat(); }}
              onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); addChatImages(fs); } }}
              placeholder="AIに聞く…（画像も貼れるで）" disabled={chatBusy}
              style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '11px 14px', fontSize: 16, borderRadius: 12, border: '1.5px solid #e2e8f0' }}
            />
            <button onClick={sendChat} disabled={chatBusy || (!chatInput.trim() && chatImages.length === 0)}
              style={{ flexShrink: 0, padding: '0 18px', height: 44, fontSize: 15, fontWeight: 700, borderRadius: 12, border: 'none', background: '#0f172a', color: '#fff', opacity: chatBusy || (!chatInput.trim() && chatImages.length === 0) ? .5 : 1 }}>
              送信
            </button>
          </div>
        </Card>

        {/* 死に店リスト */}
        {growth.deadStores.length > 0 && (
          <Card style={{ marginTop: 16 }}>
            <b style={{ fontSize: 15 }}>😴 叩き起こすべき店（{growth.deadStores.length}）</b>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 10px' }}>承認済みやのに売上ゼロ or 今ライブ在庫が無い店</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {growth.deadStores.slice(0, 20).map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#fafafa', borderRadius: 10, fontSize: 13 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{s.city || '—'} · 注文{s.orders} · {yen(s.gmv)}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                    <div style={{ fontWeight: 700, color: s.liveBags > 0 ? '#16a34a' : '#dc2626' }}>{s.liveBags > 0 ? `在庫${s.liveBags}` : '在庫0'}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      {s.daysSinceLastBag == null ? '出品なし' : `${s.daysSinceLastBag}日出品なし`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* 今ライブの店（SNS/Push文面の素材） */}
        {growth.liveStores.length > 0 && (
          <Card style={{ marginTop: 16 }}>
            <b style={{ fontSize: 15 }}>🟢 今ライブの店（{growth.liveStores.length}）</b>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 10px' }}>今すぐ買える在庫。SNSやPushで名指しする素材はここから</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {growth.liveStores.map((s) => {
                const off = s.originalPrice > 0 ? Math.round((1 - s.discountedPrice / s.originalPrice) * 100) : 0;
                return (
                  <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: 10, fontSize: 13 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: '#65946f', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.title}{s.pickupStart ? ` · 受取${s.pickupStart}〜${s.pickupEnd ?? ''}` : ''}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                      <div style={{ fontWeight: 800, color: '#16a34a' }}>{yen(s.discountedPrice)}{off > 0 && <span style={{ fontSize: 10, marginLeft: 3 }}>-{off}%</span>}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>在庫{s.stock}個</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <p style={{ textAlign: 'center', fontSize: 11, color: '#cbd5e1', marginTop: 24 }}>
          おすそわけ 成長ボード · データはリアルタイム
        </p>
      </div>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 12px rgba(0,0,0,.05)', marginBottom: 12, ...style }}>{children}</div>;
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>{children}</div>;
}
function Stat({ label, value, suffix, prefix, danger }: { label: string; value: number; suffix?: string; prefix?: string; danger?: boolean }) {
  return (
    <div style={{ background: danger ? '#fef2f2' : '#f8fafc', borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: danger ? '#dc2626' : '#0f172a' }}>{prefix && <span style={{ fontSize: 14, fontWeight: 700, marginRight: 1 }}>{prefix}</span>}{value.toLocaleString('ja-JP')}<span style={{ fontSize: 12, fontWeight: 600, marginLeft: 2 }}>{suffix}</span></div>
    </div>
  );
}
function HotLead({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: 'linear-gradient(135deg,#fff1f2,#ffe4e6)', borderRadius: 12, padding: '12px 14px', border: '1px solid #fecdd3' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: '#e11d48' }}>{value.toLocaleString('ja-JP')}<span style={{ fontSize: 12, marginLeft: 3 }}>人</span></div>
      <div style={{ fontSize: 11.5, color: '#9f1239', marginTop: 2 }}>{label}</div>
    </div>
  );
}
