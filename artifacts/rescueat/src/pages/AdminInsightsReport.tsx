import React from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import { Loader2 } from 'lucide-react';

const BASE = import.meta.env.VITE_API_BASE ?? '';

// ★ 店舗様に「どんな人が、いつ買っているか」を見せるための1枚レポート (2026-08-05)
//   店から「利用してる層のデータが欲しい」と要望があったが、年齢・性別は
//   登録時に取得していないため存在しない。代わりに【いつ・どれくらい・どう買うか】
//   という行動データを見せる。店にとってはこちらの方が出品判断に直結する。
//   ※ 他店の店名・売上など、店舗様に見せてはいけない情報は一切含めない。

type Metrics = {
  // ★ activeUsers は「購入したユーザー数」であって登録者数ではない。
  //   登録ユーザー数は /admin/growth の funnel.registered を使うこと (2026-08-05 修正)。
  activeUsers: number;
  approvedStores: number;
  breakdown: {
    countConfirmed: number;
    countPickedUp: number;
    countCancelled: number;
    avgPrice: number;
  };
  hourlyHeatmap: number[][]; // [曜日0=日..6=土][時間0..23]
};

// ★ /admin/growth は res.json({ ok:true, ...data }) なので funnel は【トップレベル】。
//   growth.growth.funnel ではないので注意。
type Growth = {
  funnel?: {
    registered?: number;
    buyers?: number;
    repeatBuyers?: number;
    rates?: { buyToRepeat?: number };
  };
};

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

export default function AdminInsightsReport() {
  const { isAdmin, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [growth, setGrowth] = React.useState<Growth | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/');
  }, [isAdmin, authLoading, navigate]);

  React.useEffect(() => {
    if (authLoading || !isAdmin) return;
    (async () => {
      try {
        const [mRes, gRes] = await Promise.all([
          authedFetch(`${BASE}/api/admin/metrics?excludeTest=1`, { headers: {} }),
          authedFetch(`${BASE}/api/admin/growth`, { headers: {} }),
        ]);
        if (!mRes.ok) throw new Error('データを取得できませんでした');
        setMetrics(await mRes.json());
        if (gRes.ok) setGrowth(await gRes.json());
      } catch (e: any) {
        setErr(e?.message ?? 'エラーが発生しました');
      } finally {
        setLoading(false);
      }
    })();
  }, [isAdmin, authLoading]);

  if (authLoading || loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#FBF8F4]">
        <Loader2 className="w-7 h-7 animate-spin text-[#E8786C]" />
      </div>
    );
  }
  if (err || !metrics) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#FBF8F4] p-6 text-center">
        <p className="text-sm text-gray-600">{err ?? 'データがありません'}</p>
      </div>
    );
  }

  const b = metrics.breakdown;
  const totalOrders = b.countConfirmed + b.countPickedUp;
  // 受取率: 予約が成立したうちフラグが受取済みになった割合
  const pickupRate = totalOrders > 0 ? Math.round((b.countPickedUp / totalOrders) * 100) : null;

  const funnel = growth?.funnel ?? {};
  const registered = Number(funnel.registered ?? 0);
  const buyers = Number(funnel.buyers ?? 0);
  const repeat = Number(funnel.repeatBuyers ?? 0);
  const repeatRate = buyers > 0 ? Math.round((repeat / buyers) * 100) : null;

  // 時間帯の集計（全曜日を合算）
  const byHour = new Array(24).fill(0);
  const byDow = new Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = metrics.hourlyHeatmap?.[d]?.[h] ?? 0;
      byHour[h] += v;
      byDow[d] += v;
    }
  }
  const hourTotal = byHour.reduce((a, c) => a + c, 0);
  const topHours = byHour
    .map((count, hour) => ({ hour, count }))
    .filter(x => x.count > 0)
    .sort((a, b2) => b2.count - a.count)
    .slice(0, 3);
  const maxHour = Math.max(1, ...byHour);
  const maxDow = Math.max(1, ...byDow);

  const Stat = ({ value, label, note }: { value: string; label: string; note?: string }) => (
    <div className="bg-white rounded-2xl border border-[#EFE7E0] px-4 py-4">
      <p className="text-[26px] leading-none font-black text-[#E8786C] tracking-tight">{value}</p>
      <p className="text-[13px] font-black text-[#2A2623] mt-2">{label}</p>
      {note && <p className="text-[11px] text-[#8A7E79] mt-1 leading-relaxed">{note}</p>}
    </div>
  );

  return (
    <div className="min-h-dvh bg-[#FBF8F4] py-8 px-5 print:bg-white">
      <div className="w-full max-w-3xl mx-auto">

        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <p className="text-[11px] font-black tracking-[0.16em] text-[#E8786C]">OSUSOWAKE / USER INSIGHTS</p>
            <h1 className="text-[26px] font-black text-[#2A2623] mt-1">おすそわけ 利用データ</h1>
          </div>
          <button
            onClick={() => window.print()}
            className="print:hidden shrink-0 text-xs font-black bg-[#2A2623] text-white px-4 py-2.5 rounded-xl"
          >
            印刷 / PDF保存
          </button>
        </div>
        <p className="text-xs text-[#8A7E79] mb-6">
          店舗様向け資料。時間帯データは直近30日の実績です。
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat
            value={(registered || metrics.activeUsers).toLocaleString()}
            label="登録ユーザー数"
            note={`高槻・北摂エリア／うち購入経験あり ${buyers.toLocaleString()}人`}
          />
          <Stat value={metrics.approvedStores.toLocaleString()} label="参加店舗数" note="審査通過済み" />
          <Stat
            value={pickupRate != null ? `${pickupRate}%` : '—'}
            label="受取率"
            note="決済済みの予約のうち、受け取られた割合"
          />
          <Stat
            value={repeatRate != null ? `${repeatRate}%` : '—'}
            label="リピート率"
            note="一度買った方が再び購入した割合"
          />
        </div>

        <div className="bg-white rounded-2xl border border-[#EFE7E0] p-5 mb-5">
          <h2 className="text-sm font-black text-[#2A2623] mb-1">よく売れる時間帯</h2>
          <p className="text-[11px] text-[#8A7E79] mb-4">
            お客様が予約したタイミング（直近30日・全店舗合計）
          </p>

          {hourTotal === 0 ? (
            <p className="text-xs text-[#8A7E79]">まだ十分なデータがありません。</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-5">
                {topHours.map((t, i) => (
                  <div
                    key={t.hour}
                    className={`px-3.5 py-2 rounded-xl text-sm font-black ${
                      i === 0
                        ? 'bg-[#E8786C] text-white'
                        : 'bg-[#FFF4F1] text-[#C9564A] border border-[#F6DDD7]'
                    }`}
                  >
                    {i === 0 ? '最も多い ' : ''}{t.hour}時台
                    <span className="font-bold text-[11px] ml-1.5 opacity-80">
                      {Math.round((t.count / hourTotal) * 100)}%
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-end gap-[3px] h-24">
                {byHour.map((v, h) => (
                  <div key={h} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-[3px] bg-[#E8786C]"
                      style={{ height: `${Math.max(2, (v / maxHour) * 84)}px`, opacity: v === 0 ? 0.12 : 0.35 + (v / maxHour) * 0.65 }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-[#A79E99] mt-1.5 font-bold">
                <span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>23時</span>
              </div>
            </>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-[#EFE7E0] p-5 mb-5">
          <h2 className="text-sm font-black text-[#2A2623] mb-1">曜日ごとの動き</h2>
          <p className="text-[11px] text-[#8A7E79] mb-4">直近30日・全店舗合計</p>
          <div className="space-y-2">
            {byDow.map((v, d) => (
              <div key={d} className="flex items-center gap-3">
                <span className="w-6 text-xs font-black text-[#2A2623]">{DOW[d]}</span>
                <div className="flex-1 h-3.5 bg-[#F5EFE9] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#E8786C] rounded-full"
                    style={{ width: `${Math.max(2, (v / maxDow) * 100)}%`, opacity: 0.45 + (v / maxDow) * 0.55 }}
                  />
                </div>
                <span className="w-10 text-right text-[11px] font-bold text-[#8A7E79]">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-3 mb-6">
          <div className="bg-white rounded-2xl border border-[#EFE7E0] p-5">
            <h2 className="text-sm font-black text-[#2A2623] mb-3">お客様の買い方</h2>
            <dl className="space-y-2.5 text-[13px]">
              <div className="flex justify-between">
                <dt className="text-[#6B615C]">平均購入金額</dt>
                <dd className="font-black text-[#2A2623]">¥{Math.round(b.avgPrice).toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#6B615C]">これまでの購入数</dt>
                <dd className="font-black text-[#2A2623]">{totalOrders.toLocaleString()}件</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#6B615C]">購入されたお客様</dt>
                <dd className="font-black text-[#2A2623]">{buyers.toLocaleString()}人</dd>
              </div>
            </dl>
          </div>

          <div className="bg-[#FFF4F1] rounded-2xl border border-[#F6DDD7] p-5">
            <h2 className="text-sm font-black text-[#C9564A] mb-2">この数字の読み方</h2>
            <ul className="text-[12px] text-[#6B615C] leading-relaxed space-y-1.5 list-disc pl-4">
              <li>お客様は<b>事前に決済を済ませて</b>来店します。出した個数以上の方は来ません。</li>
              <li>受取率が高いほど、当日の対応が読みやすくなります。</li>
              <li>よく売れる時間帯の<b>1〜2時間前に出品</b>すると、売り切れやすくなります。</li>
            </ul>
          </div>
        </div>

        <p className="text-[10px] text-[#A79E99] leading-relaxed">
          ※ 本データはおすそわけ全体の集計値です。個人が特定される情報は含まれません。<br />
          ※ 年齢・性別は取得していないため含まれません。数値は集計時点のものです。
        </p>
      </div>
    </div>
  );
}
