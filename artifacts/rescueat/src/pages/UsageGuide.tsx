import React from 'react';
import { Layout } from '@/components/Layout';
import { Link } from 'wouter';
import {
  ChevronLeft, BookOpen, Search, Heart, ShoppingBag, CreditCard, MapPin,
  Store, Camera, Banknote, BarChart2, Bell, Sparkles, CheckCircle2,
  Lightbulb, Leaf, Clock, QrCode, ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ShareAppCard } from '@/components/ShareAppCard';

interface Step {
  icon: React.ReactNode;
  color: string;
  ring: string;
  title: string;
  body: string;
  example?: string;
  tip?: string;
}

const USER_STEPS: Step[] = [
  {
    icon: <Search className="w-5 h-5" />,
    color: 'bg-sky-100 text-sky-700',
    ring: 'ring-sky-200',
    title: '近くの「おすそわけ」を探す',
    body: 'ホームのマップまたはバッグ一覧から、現在地に近いお店を表示。徒歩時間と受取可能時間が一目でわかります。',
    example: '例：「半径1km以内・残り3時間以内」 のバッグだけ絞り込み表示。',
    tip: '位置情報をオンにするとマップ精度が大幅にアップ。',
  },
  {
    icon: <Heart className="w-5 h-5" />,
    color: 'bg-rose-100 text-rose-600',
    ring: 'ring-rose-200',
    title: '気になるお店をお気に入り登録',
    body: 'ハートマークをタップでお気に入りに保存。新着の「おすそわけ」が出ると即プッシュ通知でお知らせします。',
    example: '例：通勤路にあるベーカリーを登録 → 17:00 出品開始の瞬間にスマホがピコン。',
    tip: '人気店は数分で売り切れることも。通知ONが必須です。',
  },
  {
    icon: <ShoppingBag className="w-5 h-5" />,
    color: 'bg-amber-100 text-amber-700',
    ring: 'ring-amber-200',
    title: 'バッグを選んで予約',
    body: '気になるバッグを選び「予約する」 をタップ。中身は当日のお楽しみ形式が多く、通常価格の半額〜1/3でゲットできます。',
    example: '例：通常 ¥1,500 のお弁当セットが ¥530。',
    tip: '何が入っているかドキドキ感も「おすそわけ」 の醍醐味。',
  },
  {
    icon: <CreditCard className="w-5 h-5" />,
    color: 'bg-emerald-100 text-emerald-700',
    ring: 'ring-emerald-200',
    title: 'アプリ内でお支払い',
    body: 'クレジットカード・Apple Pay・Google Pay に対応。お店での現金やりとりは一切不要。決済後すぐに6桁の受取コードが発行されます。',
    example: 'Visa / Mastercard / AMEX / JCB / Apple Pay / Google Pay に対応。',
    tip: '表示価格 = 請求金額。手数料・送料の追加なし。',
  },
  {
    icon: <MapPin className="w-5 h-5" />,
    color: 'bg-orange-100 text-primary',
    ring: 'ring-orange-200',
    title: '受取時間内にお店へ',
    body: '指定の受取時間内にお店へ行き、6桁の受取コードをスタッフに見せるだけ。あとはバッグを受け取って完了です！',
    example: '例：「18:00〜20:00」 → この間に来店して QR/コードを提示。',
    tip: '間に合わない場合は、必ずお店へ早めに直接ご連絡を。',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    color: 'bg-violet-100 text-violet-700',
    ring: 'ring-violet-200',
    title: 'レビューで応援',
    body: '受取後はぜひレビューを。お店の励みになり、地域全体の食品ロス削減につながります。',
    example: 'マイタウンが育ち、月間ランキングのスコアもアップ🌱',
  },
];

const STORE_STEPS: Step[] = [
  {
    icon: <Store className="w-5 h-5" />,
    color: 'bg-orange-100 text-primary',
    ring: 'ring-orange-200',
    title: '店舗情報を登録して申請',
    body: '店舗名・住所・カテゴリ・営業時間・営業許可証を入力して申請。事務局が審査 (通常1〜3営業日) の上、承認します。',
    example: '初期費用・月額費用は ¥0 (完全成果報酬制)。',
    tip: '営業許可証の写真は明るい場所で文字がはっきり読める状態で。',
  },
  {
    icon: <Banknote className="w-5 h-5" />,
    color: 'bg-emerald-100 text-emerald-700',
    ring: 'ring-emerald-200',
    title: '振込先口座を登録',
    body: '決済システム (Stripe) を通じて振込先銀行口座を登録。売上は所定スケジュールでご指定口座に自動振込されます。',
    example: '個人事業主 / 法人を選択 → 1〜3営業日で口座審査完了。',
    tip: '審査完了するまで出品はできません。早めの登録を推奨。',
  },
  {
    icon: <Camera className="w-5 h-5" />,
    color: 'bg-violet-100 text-violet-700',
    ring: 'ring-violet-200',
    title: '「おすそわけ」 を出品',
    body: '当日売れ残りそうな商品を「おすそわけバッグ」 として出品。写真・通常価格・割引価格・受取時間を設定するだけ。',
    example: '例：通常 ¥1,500 のお惣菜セット → 割引 ¥530 で出品。',
    tip: '写真は俯瞰アングル + 自然光が予約率を大幅アップ。',
  },
  {
    icon: <Bell className="w-5 h-5" />,
    color: 'bg-amber-100 text-amber-700',
    ring: 'ring-amber-200',
    title: '予約が入ると通知',
    body: 'お客様が予約・決済を完了するとプッシュ通知でお知らせ。予約一覧から準備するバッグの数を確認できます。',
    example: '例：「○○バッグ ×3 予約あり」 と通知 → 閉店前にまとめて準備。',
    tip: '通知は確実に届くよう端末設定の通知許可をオンに。',
  },
  {
    icon: <QrCode className="w-5 h-5" />,
    color: 'bg-sky-100 text-sky-700',
    ring: 'ring-sky-200',
    title: '受取コードを確認して渡すだけ',
    body: 'お客様が来店したら、6桁の受取コードを確認するだけ。バッグをお渡しすれば取引完了です。現金やりとりは不要。',
    example: '例：お客様提示の「123-456」 を予約一覧から照合 → 渡す。',
    tip: '受取済みボタンを忘れずタップして取引を完了に。',
  },
  {
    icon: <BarChart2 className="w-5 h-5" />,
    color: 'bg-rose-100 text-rose-600',
    ring: 'ring-rose-200',
    title: '売上はアプリ内で確認',
    body: '「売上確認」 画面から月別・取引別の売上、 振込予定額 (保留中/振込可能)、 食品ロス削減量をいつでもチェック。会計処理にも便利です。',
    example: '例：今月の売上 / 振込予定額 / 食品ロス削減量を一覧表示。',
    tip: '振込明細は CSV エクスポートで会計ソフトへ流し込めます。',
  },
];

const USER_TIPS = [
  '通知をONにすると、お気に入り店舗の出品をいち早くキャッチできます。',
  '受取時間に間に合わない場合は早めにお店へ直接ご連絡を。',
  '中身は当日のお楽しみ形式が多いので、ドキドキ感も含めて楽しんでください。',
  'マイタウンを育てたり、月間ランキングで他のユーザーと競うこともできます。',
];

const STORE_TIPS = [
  '出品は閉店2〜3時間前がおすすめ。お客様が立ち寄りやすい時間帯になります。',
  '写真と簡単な説明を添えると予約率が大幅に上がります。',
  '受取時間は店舗の閉店時間と被らないよう30分程度の余裕を。',
  'アレルギー情報は「日により変動あり」 でも記載すると安心感が伝わります。',
];

const USER_HIGHLIGHTS = [
  { icon: <Leaf className="w-4 h-4" />, label: '食品ロス削減', color: 'text-emerald-600 bg-emerald-50' },
  { icon: <Banknote className="w-4 h-4" />, label: '半額〜1/3価格', color: 'text-amber-600 bg-amber-50' },
  { icon: <Clock className="w-4 h-4" />, label: '5ステップで完了', color: 'text-sky-600 bg-sky-50' },
];

const STORE_HIGHLIGHTS = [
  { icon: <Banknote className="w-4 h-4" />, label: '初期費用 ¥0', color: 'text-emerald-600 bg-emerald-50' },
  { icon: <Leaf className="w-4 h-4" />, label: '廃棄削減', color: 'text-amber-600 bg-amber-50' },
  { icon: <BarChart2 className="w-4 h-4" />, label: '売上自動振込', color: 'text-sky-600 bg-sky-50' },
];

function TimelineStep({ step, index, isLast }: { step: Step; index: number; isLast: boolean }) {
  return (
    <div className="relative flex gap-4">
      {/* 番号バッジ + 縦線 */}
      <div className="flex flex-col items-center shrink-0">
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-base text-white bg-gradient-to-br from-primary to-orange-500 shadow-md shadow-orange-200 ring-4 ring-white`}>
          {index + 1}
        </div>
        {!isLast && (
          <div className="flex-1 w-0.5 bg-gradient-to-b from-orange-200 via-orange-100 to-transparent my-1 min-h-[24px]" />
        )}
      </div>

      {/* カード */}
      <div className={`flex-1 min-w-0 mb-5 bg-card border border-border rounded-2xl p-4 shadow-sm hover:shadow-md transition-shadow`}>
        <div className="flex items-start gap-3 mb-2">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${step.color} ring-2 ${step.ring}`}>
            {step.icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-black text-foreground text-sm leading-snug">{step.title}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{step.body}</p>

        {step.example && (
          <div className="mt-3 bg-muted/50 border border-border rounded-xl px-3 py-2">
            <p className="text-[11px] font-bold text-foreground/70 leading-relaxed">{step.example}</p>
          </div>
        )}

        {step.tip && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 leading-relaxed">
            <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="font-medium">{step.tip}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UsageGuide() {
  const { profile } = useAuth();
  const urlMode = new URLSearchParams(window.location.search).get('mode');
  // URL の ?mode= が最優先 (store_owner でも ?mode=user で切替可)、 ない時のみ role フォールバック
  const isStoreMode = urlMode === 'store'
    ? true
    : urlMode === 'user'
      ? false
      : profile?.role === 'store_owner';

  const steps = isStoreMode ? STORE_STEPS : USER_STEPS;
  const tips = isStoreMode ? STORE_TIPS : USER_TIPS;
  const highlights = isStoreMode ? STORE_HIGHLIGHTS : USER_HIGHLIGHTS;

  return (
    <Layout showBottomNav>
      <div className="w-full max-w-md md:max-w-2xl mx-auto px-4 pt-4 pb-28">
        <button
          onClick={() => window.history.back()}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1 tap-opacity"
          aria-label="前の画面に戻る"
        >
          <ChevronLeft className="w-5 h-5" />
          <span>戻る</span>
        </button>

        {/* Hero */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-orange-50 via-amber-50 to-rose-50 border border-orange-100 p-5 mb-5">
          <div className="absolute -top-8 -right-8 w-32 h-32 bg-orange-200/30 rounded-full blur-2xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-rose-200/30 rounded-full blur-2xl pointer-events-none" />

          <div className="relative">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shrink-0 shadow-sm ring-2 ring-orange-100">
                <BookOpen className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-black text-foreground leading-tight">使い方ガイド</h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isStoreMode ? 'お店の方向け：出品から売上確認まで' : '初めての方へ：予約から受取までの流れ'}
                </p>
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-2 mb-1">
              {highlights.map((h, i) => (
                <div key={i} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-black ${h.color}`}>
                  {h.icon}
                  <span>{h.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* モードバッジ + 切替 */}
        <div className="flex items-center justify-between gap-2 mb-5">
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-black ${
            isStoreMode ? 'bg-primary/10 text-primary' : 'bg-sky-100 text-sky-700'
          }`}>
            {isStoreMode ? '🏪 店舗オーナー編' : '👤 ユーザー編'}
          </div>
          {!isStoreMode && profile?.role === 'store_owner' && (
            <Link
              href="/usage-guide?mode=store"
              className="text-[11px] font-bold text-muted-foreground hover:text-primary underline underline-offset-2"
            >
              店舗オーナー編を見る →
            </Link>
          )}
        </div>

        {/* タイムライン */}
        <div className="mb-6">
          {steps.map((s, i) => (
            <TimelineStep key={i} step={s} index={i} isLast={i === steps.length - 1} />
          ))}
        </div>

        {/* 完了バナー */}
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-4 mb-6 text-white shadow-md shadow-emerald-200">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-sm leading-tight">
                {isStoreMode ? 'これでお店も食品ロス削減の仲間入り' : 'たったこれだけ。今日から始められます'}
              </p>
              <p className="text-[11px] text-white/90 mt-0.5 leading-relaxed">
                {isStoreMode ? '廃棄が売上に変わり、お客様も増える好循環。' : 'お得 × おいしい × 地球にやさしい、 1人1食からのアクション。'}
              </p>
            </div>
          </div>
        </div>

        {/* 使いこなしのコツ */}
        <div className="bg-card border border-border rounded-2xl p-4 mb-6 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 bg-amber-100 rounded-xl flex items-center justify-center shrink-0">
              <Lightbulb className="w-4 h-4 text-amber-600" />
            </div>
            <p className="font-black text-sm text-foreground">使いこなしのコツ</p>
          </div>
          <ul className="space-y-2.5">
            {tips.map((tip, i) => (
              <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground leading-relaxed">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 font-black text-[10px] shrink-0 mt-0.5">
                  ✓
                </span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* シェア */}
        <div className="mb-6">
          <ShareAppCard variant={isStoreMode ? 'store' : 'user'} />
        </div>

        {/* FAQ 誘導 */}
        <div className="bg-gradient-to-br from-sky-50 to-indigo-50 border border-sky-100 rounded-2xl p-4 text-center">
          <p className="text-xs text-foreground/70 mb-3 leading-relaxed">
            さらに詳しい質問は<br className="sm:hidden" />よくあるご質問をご覧ください
          </p>
          <Link
            href={isStoreMode ? '/help?mode=store' : '/help'}
            className="inline-flex items-center gap-1.5 text-sm font-black text-primary hover:underline"
          >
            よくあるご質問を見る
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </Layout>
  );
}
