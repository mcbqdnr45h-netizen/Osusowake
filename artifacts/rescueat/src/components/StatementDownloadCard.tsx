import React, { useState, useEffect } from 'react';
import { FileSpreadsheet, Download, Loader2, AlertCircle } from 'lucide-react';
import { authedFetch } from '@/lib/authed-fetch';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface PayoutRef {
  id: string;
  arrivalDate: string; // YYYY-MM-DD
  amount: number;
  status: string;
  statusLabel: string;
}
interface StatementItem {
  date: string;
  orderId: number;
  title: string;
  quantity: number;
  customerPaid: number;
  merchandise: number;
  commission: number;
  stripeFee: number;
  storeNet: number;
  status: string;
}
interface StatementResponse {
  storeName: string;
  issuer: string;
  taxNote: string;
  payout: PayoutRef;
  unmatchedAmount: number;
  items: StatementItem[];
  totals: {
    count: number; customerPaid: number; merchandise: number;
    commission: number; stripeFee: number; storeNet: number;
  };
}

const STATUS_LABEL: Record<string, string> = {
  picked_up: '受取済み',
  confirmed: '予約済み',
  pending: '未受取',
};

// CSV セル: カンマ・改行・引用符を含む場合は "" で囲みエスケープ。
// ★ CSVインジェクション対策: = + - @ 等で始まる文字列（店舗の自由入力の商品名など）を
//   そのまま出すと Excel が数式として実行し得るため、 先頭に ' を付けて無害化する。
function csvCell(v: string | number): string {
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(data: StatementResponse): string {
  const header = [
    '日付', '注文番号', '商品名', '数量',
    'お客様支払額', '商品代金', 'おすそわけ手数料(20%)', '決済手数料', '店舗受取額', '状態',
  ];
  const rows = data.items.map((it) => [
    it.date, it.orderId, it.title, it.quantity,
    it.customerPaid, it.merchandise, it.commission, it.stripeFee, it.storeNet,
    STATUS_LABEL[it.status] ?? it.status,
  ]);
  const totalRow = [
    '明細合計', '', '', data.totals.count,
    data.totals.customerPaid, data.totals.merchandise, data.totals.commission,
    data.totals.stripeFee, data.totals.storeNet, `${data.totals.count}件`,
  ];
  // 調整（返金・手数料調整等、注文に紐付かない振込内訳）と振込額。
  // 明細合計 + 調整 = 振込額 が必ず一致する（受取額はStripeの実送金額を使用）。
  const tailRows: (string | number)[][] = [];
  if (data.unmatchedAmount !== 0) {
    tailRows.push(['その他（返金・手数料調整等）', '', '', '', '', '', '', '', data.unmatchedAmount, '']);
  }
  tailRows.push(['振込額（銀行着金額）', '', '', '', '', '', '', '', data.totals.storeNet + data.unmatchedAmount, '']);
  const meta: (string | number)[][] = [
    ['売上明細書（振込単位）'],
    ['店舗名', data.storeName],
    ['振込日', `${data.payout.arrivalDate}（${data.payout.statusLabel}）`],
    ['振込額', data.payout.amount],
    ['発行元', data.issuer],
    [data.taxNote],
    [],
  ];
  const lines = [
    ...meta.map((r) => r.map(csvCell).join(',')),
    header.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
    totalRow.map(csvCell).join(','),
    ...tailRows.map((r) => r.map(csvCell).join(',')),
  ];
  // ★ BOM 付き UTF-8 → 日本語 Excel でも文字化けしない
  return '﻿' + lines.join('\r\n');
}

export function StatementDownloadCard({ storeId }: { storeId: number }) {
  const [payouts, setPayouts] = useState<PayoutRef[]>([]);
  const [payoutId, setPayoutId] = useState<string>('');
  const [listLoading, setListLoading] = useState(true);
  const [data, setData] = useState<StatementResponse | null>(null);
  const [loading, setLoading] = useState(false); // 明細取得中
  const [busy, setBusy] = useState(false);       // 共有/保存の実行中
  const [error, setError] = useState<string | null>(null);

  // 振込一覧を取得（セレクタ用）
  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    authedFetch(`${BASE}/api/stores/${storeId}/statement`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`一覧の取得に失敗しました (HTTP ${res.status})`);
        return res.json() as Promise<{ payouts: PayoutRef[] }>;
      })
      .then((d) => {
        if (cancelled) return;
        setPayouts(d.payouts ?? []);
        if (d.payouts?.length) setPayoutId(d.payouts[0].id);
      })
      .catch((e) => { if (!cancelled) setError(e?.message ?? '一覧の取得に失敗しました'); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [storeId]);

  // ★ 振込を選んだ時点で明細を先読み。 ダウンロード時に await を挟まず即 navigator.share を
  //   呼べるため、 iOS の「ユーザー操作が有効な間だけ共有できる」制約に引っかからない。
  useEffect(() => {
    if (!payoutId) { setData(null); return; }
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    authedFetch(`${BASE}/api/stores/${storeId}/statement?payout=${encodeURIComponent(payoutId)}`)
      .then(async (res) => {
        if (res.status === 401) throw new Error('ログインが必要です');
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.message ?? `取得に失敗しました (HTTP ${res.status})`);
        }
        return res.json() as Promise<StatementResponse>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? '取得に失敗しました'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [storeId, payoutId]);

  const handleDownload = async () => {
    if (!data || busy) return;
    if (data.items.length === 0) { setError('この振込に紐付く注文明細がありません'); return; }
    setBusy(true);
    setError(null);
    try {
      const csv = buildCsv(data);
      const filename = `おすそわけ_売上明細_${data.storeName}_振込${data.payout.arrivalDate}.csv`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const nav = navigator as any;

      // ── iOS/Android アプリ (Capacitor WKWebView) ──
      // WKWebView は <a download> を実行できないため、 ファイル共有対応の
      // Web Share API で「ファイルに保存 / メール送信」の共有シートを出す。
      try {
        const file = new File([blob], filename, { type: 'text/csv' });
        if (nav.canShare && nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: '売上明細書' });
          return;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return; // ユーザーがキャンセル
        // ★ 共有可能な環境（＝アプリ内）で share が失敗した場合、 <a download> は
        //   WKWebView では動かず「無反応」に見えるため、 明示的にエラーを出して終了する。
        setError('共有画面を開けませんでした。もう一度お試しください');
        return;
      }

      // ── デスクトップブラウザ ──
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Safari は即時 revoke でダウンロードが打ち切られることがあるため遅延させる
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e?.message ?? '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const itemCount = data?.items.length ?? 0;

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
        <h3 className="text-sm font-black text-foreground">売上明細書のダウンロード</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
        振込ごとの明細（含まれる注文・手数料・受取額）をCSV（Excel対応）で保存できます。銀行に着金した額との照合にご利用ください。
      </p>

      {listLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> 振込履歴を読み込み中…
        </div>
      ) : payouts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-2">
          まだ振込の履歴がありません。初回の振込後にご利用いただけます。
        </p>
      ) : (
        <>
          {/* ★ 縦積みレイアウト: 横並びだと320px級の狭い端末でボタンが潰れて
              「ダ/ウ/ン/ロ/ー/ド」と縦書きになる崩れがあった。全幅×縦積みなら全端末で安定 */}
          <div className="flex flex-col gap-2">
            <select
              value={payoutId}
              onChange={(e) => { setPayoutId(e.target.value); setError(null); }}
              className="w-full bg-secondary border border-border rounded-xl px-3 py-2.5 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {payouts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.arrivalDate.replace(/-/g, '/')} ¥{p.amount.toLocaleString()}（{p.statusLabel}）
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleDownload}
              disabled={loading || busy || itemCount === 0}
              className="w-full inline-flex items-center justify-center gap-1.5 whitespace-nowrap bg-primary text-primary-foreground font-bold text-sm px-4 py-2.5 rounded-xl hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              {(loading || busy)
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Download className="w-4 h-4" />}
              {loading ? '読込中' : busy ? '作成中' : 'ダウンロード'}
            </button>
          </div>

          {!loading && !error && data && (
            <p className="text-[11px] text-muted-foreground mt-2">
              {itemCount === 0
                ? 'この振込に紐付く注文明細がありません'
                : data.unmatchedAmount === 0
                  ? `この振込：${itemCount}件・受取額合計 ¥${data.totals.storeNet.toLocaleString()}（振込額と一致）`
                  : `明細${itemCount}件 ¥${data.totals.storeNet.toLocaleString()} ＋ その他（返金・調整等） ¥${data.unmatchedAmount.toLocaleString()} ＝ 振込額 ¥${(data.totals.storeNet + data.unmatchedAmount).toLocaleString()}`}
            </p>
          )}

        </>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
