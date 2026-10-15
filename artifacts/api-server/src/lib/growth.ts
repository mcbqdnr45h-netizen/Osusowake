// ═══════════════════════════════════════════════════════════════════════════
//  Growth コア — 成長データの集計 + 「今日やるべき完璧なチェックリスト」生成。
//  /admin/growth（管理者）と /api/board/*（俺らだけの共有ボード）の両方が使う。
// ═══════════════════════════════════════════════════════════════════════════
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const BOUGHT = sql`('confirmed','picked_up')`;

// ★ 「今まさに客に表示中」の可視条件（raw SQL 版・エイリアス sb 前提）。
//   lib/bag-visibility.ts (Drizzle版) と完全に同じ判定を、 growth.ts の生SQL集計で使うための複製。
//   これを使わないと board の「出品中の店」が地図/検索(=/api/bags, stores.ts)とズレる:
//   ・店の承認/営業状態(status='approved' AND is_active)を無視して集計してしまう
//   ・受取時間帯を過ぎた or 翌日枠外の“死んだ”バッグまで数えてしまう
//   → 実際にユーザーが買える店数と一致させるため、ここで同一フィルタに揃える。
const BAG_VISIBLE_SB = sql`(
  (sb.pickup_end IS NULL AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
  OR (sb.pickup_end IS NOT NULL AND COALESCE(sb.pickup_end_2, sb.pickup_end) >= sb.pickup_start AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo') AND COALESCE(sb.pickup_end_2, sb.pickup_end) >= TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo','HH24:MI'))
  OR (sb.pickup_end IS NOT NULL AND COALESCE(sb.pickup_end_2, sb.pickup_end) < sb.pickup_start AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
  OR (sb.pickup_end IS NOT NULL AND COALESCE(sb.pickup_end_2, sb.pickup_end) < sb.pickup_start AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day' AND COALESCE(sb.pickup_end_2, sb.pickup_end) >= TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo','HH24:MI'))
  OR (sb.pickup_next_day = true AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
  OR (sb.pickup_next_day = true AND DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day' AND (sb.pickup_end IS NULL OR COALESCE(sb.pickup_end_2, sb.pickup_end) >= TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo','HH24:MI')))
)`;

export interface GrowthDeadStore {
  id: number;
  name: string;
  city: string;
  orders: number;
  gmv: number;
  liveBags: number;
  lastBagAt: string | null;
  daysSinceLastBag: number | null;
  // ★ 休眠店の"内訳診断"用。Stripe未完了で物理的に出品不能なのか、テンプレ未作成で気付いてないだけかを切り分ける。
  hasStripeAccount: boolean;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  recurringTemplates: number;   // is_active な定期出品テンプレ数（0=未設定）
  // 出品を阻む一次原因を1語で。"stripe"=口座未完了 / "no_template"=テンプレ0だが口座OK / "idle"=テンプレ有りでも動いてない
  blocker: "stripe" | "no_template" | "idle";
}

// 今この瞬間ライブ（買える）実店舗。SNS文面やPush文面に実名・実価格を差し込むため。
export interface GrowthLiveStore {
  id: number;
  name: string;
  city: string;
  category: string | null;
  title: string;            // サプライズバッグ名
  originalPrice: number;
  discountedPrice: number;
  stock: number;
  pickupStart: string | null;
  pickupEnd: string | null;
}

export interface GrowthData {
  funnel: {
    registered: number;
    favorited: number;
    buyers: number;
    repeatBuyers: number;
    newUsers7d: number;
    newUsers30d: number;
    rates: { registerToFav: number; favToBuy: number; registerToBuy: number; buyToRepeat: number };
  };
  hotLeads: { favNoPurchase: number; registered7dNoPurchase: number };
  deadStores: GrowthDeadStore[];
  liveStores: GrowthLiveStore[];
  supply: { approvedActiveStores: number; storesWithLiveBags: number; liveBags: number; liveStockUnits: number };
  weeklyTrend: { week: string; newUsers: number; buyers: number; gmv: number }[];
  gmvTotal: number;
  reviews: { count: number; avgRating: number };
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export async function buildGrowthData(): Promise<GrowthData> {
  const funnelRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM public.users)::int AS registered,
      (SELECT COUNT(DISTINCT user_id) FROM favorites)::int AS favorited_users,
      (SELECT COUNT(DISTINCT user_id) FROM reservations WHERE status IN ${BOUGHT})::int AS buyers,
      (SELECT COUNT(*) FROM (SELECT user_id FROM reservations WHERE status IN ${BOUGHT} GROUP BY user_id HAVING COUNT(*) >= 2) t)::int AS repeat_buyers,
      (SELECT COUNT(*) FROM public.users WHERE created_at > now() - interval '7 days')::int AS new_users_7d,
      (SELECT COUNT(*) FROM public.users WHERE created_at > now() - interval '30 days')::int AS new_users_30d
  `);
  const f = funnelRes.rows[0] as any;

  const hotRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(DISTINCT fa.user_id) FROM favorites fa
        WHERE NOT EXISTS (SELECT 1 FROM reservations r WHERE r.user_id = fa.user_id AND r.status IN ${BOUGHT}))::int AS fav_no_purchase,
      (SELECT COUNT(*) FROM public.users u
        WHERE u.created_at > now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.user_id = u.id::text AND r.status IN ${BOUGHT}))::int AS registered_7d_no_purchase
  `);
  const h = hotRes.rows[0] as any;

  const deadRes = await db.execute(sql`
    WITH sold AS (
      SELECT store_id, COUNT(*)::int AS orders, COALESCE(SUM(total_price),0)::int AS gmv
      FROM reservations WHERE status IN ${BOUGHT} GROUP BY store_id
    ),
    lastbag AS (
      SELECT store_id, MAX(created_at) AS last_bag_at,
             COUNT(*) FILTER (WHERE is_active AND stock_count > 0)::int AS live_bags
      FROM surprise_bags GROUP BY store_id
    ),
    tpl AS (
      SELECT store_id, COUNT(*) FILTER (WHERE is_active)::int AS active_templates
      FROM recurring_listings GROUP BY store_id
    )
    SELECT s.id, s.name, s.city,
           COALESCE(sold.orders,0)::int AS orders,
           COALESCE(sold.gmv,0)::int AS gmv,
           COALESCE(lb.live_bags,0)::int AS live_bags,
           lb.last_bag_at,
           EXTRACT(DAY FROM now() - lb.last_bag_at)::int AS days_since_last_bag,
           (s.stripe_account_id IS NOT NULL) AS has_stripe_account,
           COALESCE(s.stripe_charges_enabled, false) AS stripe_charges_enabled,
           COALESCE(s.stripe_payouts_enabled, false) AS stripe_payouts_enabled,
           COALESCE(tpl.active_templates, 0)::int AS recurring_templates
    FROM stores s
    LEFT JOIN sold ON sold.store_id = s.id
    LEFT JOIN lastbag lb ON lb.store_id = s.id
    LEFT JOIN tpl ON tpl.store_id = s.id
    WHERE s.status = 'approved'
      AND (COALESCE(sold.orders,0) = 0 OR COALESCE(lb.live_bags,0) = 0)
    ORDER BY COALESCE(sold.gmv,0) ASC, lb.last_bag_at ASC NULLS FIRST
  `);
  const deadStores: GrowthDeadStore[] = deadRes.rows.map((r: any) => {
    const hasStripeAccount = r.has_stripe_account === true;
    const stripeChargesEnabled = r.stripe_charges_enabled === true;
    const stripePayoutsEnabled = r.stripe_payouts_enabled === true;
    const recurringTemplates = Number(r.recurring_templates);
    // 出品を物理的に阻む壁を優先判定: Stripe(charges)未完了なら出品不能 → まずそこ。
    // 口座OKでテンプレ0なら「定期出品を見つけてない」導線問題。テンプレ有りで動いてないなら idle。
    const blocker: GrowthDeadStore["blocker"] = !stripeChargesEnabled ? "stripe" : recurringTemplates === 0 ? "no_template" : "idle";
    return {
      id: Number(r.id), name: r.name, city: r.city,
      orders: Number(r.orders), gmv: Number(r.gmv), liveBags: Number(r.live_bags),
      lastBagAt: r.last_bag_at, daysSinceLastBag: r.days_since_last_bag == null ? null : Number(r.days_since_last_bag),
      hasStripeAccount, stripeChargesEnabled, stripePayoutsEnabled, recurringTemplates, blocker,
    };
  });

  // 今ライブの実店舗（在庫の多い順）。SNS/Push文面に実名・実価格を差し込む素材。
  const liveRes = await db.execute(sql`
    SELECT s.id, s.name, s.city, s.category,
           sb.title, sb.original_price, sb.discounted_price, sb.stock_count,
           sb.pickup_start, sb.pickup_end
    FROM surprise_bags sb
    JOIN stores s ON s.id = sb.store_id
    WHERE sb.is_active AND sb.stock_count > 0
      AND s.status = 'approved' AND s.is_active
      AND ${BAG_VISIBLE_SB}
    ORDER BY sb.stock_count DESC, sb.discounted_price ASC
    LIMIT 20
  `);
  const liveStores: GrowthLiveStore[] = liveRes.rows.map((r: any) => ({
    id: Number(r.id), name: r.name, city: r.city, category: r.category ?? null,
    title: r.title, originalPrice: Number(r.original_price), discountedPrice: Number(r.discounted_price),
    stock: Number(r.stock_count), pickupStart: r.pickup_start ?? null, pickupEnd: r.pickup_end ?? null,
  }));

  // ★ 供給集計は「今まさに客に表示中（=地図/検索に出る）」の定義に完全一致させる。
  //   is_active AND stock_count>0 だけだと、承認前/停止中の店や受取時間帯を過ぎた
  //   死んだバッグまで数えて board の「出品中の店」が実態(8)とズレる。
  //   store の承認/営業状態 + 可視条件(BAG_VISIBLE_SB) を全カウントに適用する。
  const supplyRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM stores WHERE status='approved' AND is_active)::int AS approved_active_stores,
      (SELECT COUNT(DISTINCT sb.store_id) FROM surprise_bags sb JOIN stores s ON s.id = sb.store_id
         WHERE sb.is_active AND sb.stock_count>0 AND s.status='approved' AND s.is_active AND ${BAG_VISIBLE_SB})::int AS stores_with_live_bags,
      (SELECT COUNT(*) FROM surprise_bags sb JOIN stores s ON s.id = sb.store_id
         WHERE sb.is_active AND sb.stock_count>0 AND s.status='approved' AND s.is_active AND ${BAG_VISIBLE_SB})::int AS live_bags,
      (SELECT COALESCE(SUM(sb.stock_count),0) FROM surprise_bags sb JOIN stores s ON s.id = sb.store_id
         WHERE sb.is_active AND sb.stock_count>0 AND s.status='approved' AND s.is_active AND ${BAG_VISIBLE_SB})::int AS live_stock_units
  `);
  const supply = supplyRes.rows[0] as any;

  const trendRes = await db.execute(sql`
    WITH weeks AS (
      SELECT generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS wk
    ),
    u AS (
      SELECT date_trunc('week', created_at) AS wk, COUNT(*)::int AS n
      FROM public.users WHERE created_at > now() - interval '8 weeks' GROUP BY 1
    ),
    r AS (
      SELECT date_trunc('week', created_at) AS wk, COUNT(DISTINCT user_id)::int AS buyers, COALESCE(SUM(total_price),0)::int AS gmv
      FROM reservations WHERE status IN ${BOUGHT} AND created_at > now() - interval '8 weeks' GROUP BY 1
    )
    SELECT to_char(weeks.wk, 'MM/DD') AS week,
           COALESCE(u.n,0)::int AS new_users, COALESCE(r.buyers,0)::int AS buyers, COALESCE(r.gmv,0)::int AS gmv
    FROM weeks LEFT JOIN u ON u.wk = weeks.wk LEFT JOIN r ON r.wk = weeks.wk
    ORDER BY weeks.wk ASC
  `);
  const weeklyTrend = trendRes.rows.map((r: any) => ({
    week: r.week, newUsers: Number(r.new_users), buyers: Number(r.buyers), gmv: Number(r.gmv),
  }));

  const extraRes = await db.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(total_price),0) FROM reservations WHERE status IN ${BOUGHT})::int AS gmv_total,
      (SELECT COUNT(*) FROM reviews)::int AS review_count,
      (SELECT COALESCE(ROUND(AVG(rating)::numeric,2),0) FROM reviews)::float AS avg_rating
  `);
  const ex = extraRes.rows[0] as any;

  const registered = Number(f.registered);
  const favorited = Number(f.favorited_users);
  const buyers = Number(f.buyers);
  const repeatBuyers = Number(f.repeat_buyers);

  return {
    funnel: {
      registered, favorited, buyers, repeatBuyers,
      newUsers7d: Number(f.new_users_7d), newUsers30d: Number(f.new_users_30d),
      rates: {
        registerToFav: pct(favorited, registered),
        favToBuy: pct(buyers, favorited),
        registerToBuy: pct(buyers, registered),
        buyToRepeat: pct(repeatBuyers, buyers),
      },
    },
    hotLeads: { favNoPurchase: Number(h.fav_no_purchase), registered7dNoPurchase: Number(h.registered_7d_no_purchase) },
    deadStores,
    liveStores,
    supply: {
      approvedActiveStores: Number(supply.approved_active_stores),
      storesWithLiveBags: Number(supply.stores_with_live_bags),
      liveBags: Number(supply.live_bags),
      liveStockUnits: Number(supply.live_stock_units),
    },
    weeklyTrend,
    gmvTotal: Number(ex.gmv_total),
    reviews: { count: Number(ex.review_count), avgRating: Number(ex.avg_rating) },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  販売実績 & 予測 — 「出品した商品がちゃんと売れてるか」を数字で可視化。
//  board(俺らだけ)専用。 出品ごとの初期在庫は履歴カラムが無いので
//  初期在庫 = 現在庫(stock_count) + そのバッグの売れた数(reservations) で復元する。
//  売上判定は他の集計と同じ BOUGHT(=confirmed/picked_up) に統一。
// ═══════════════════════════════════════════════════════════════════════════
export interface SalesForecast {
  today: {
    listedBags: number;    // 今日(JST)出品されたバッグ数
    listedUnits: number;   // 今日出品された総在庫(初期在庫の合計)
    soldUnits: number;     // そのうち売れた個数
    revenue: number;       // 今日出品分から出た売上(¥)
    soldOutBags: number;   // 完売したバッグ数(在庫0かつ実売あり)
    sellThrough: number;   // 販売率 = soldUnits / listedUnits (%)
  };
  daily: { date: string; listedUnits: number; soldUnits: number; revenue: number; sellThrough: number }[];
  storePerformance: {      // 店別の売れ行き(直近14日)。 よく売れる/売れ残るを一目で。
    storeId: number; name: string; category: string | null;
    listedUnits: number; soldUnits: number; sellThrough: number; revenue: number;
  }[];
  categoryPerformance: { category: string; listedUnits: number; soldUnits: number; sellThrough: number; revenue: number }[];
  breakdown: {             // 売上内訳: 取扱高(GMV)がどう分かれるか(今日/直近14日/累計)。
    period: string;        // "今日" | "直近14日" | "累計"
    orders: number;        // 成約(confirmed/picked_up)注文数
    gmv: number;           // 取扱高 = お客様支払総額(¥)
    platformRevenue: number; // おすそわけ売上 = 店20%手数料 + ユーザー5%利用料(Stripe手数料前)
    storePayout: number;   // 店舗への入金原資 = 商品代金の80%(Stripe手数料前)
    takeRate: number;      // おすそわけの手数料率 % = platformRevenue / gmv
  }[];
  forecast: {              // 「明日出品したら売れそうか」の推定(直近実績ベース)。
    sampleDays: number;    // 実績に使った日数
    avgSellThrough: number;// 直近14日の平均販売率(%)
    bestCategory: string | null;  // 一番売れてるジャンル
    worstCategory: string | null; // 一番売れ残るジャンル
    note: string;
  };
}

const jstDateExpr = sql`DATE(sb.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')`;

export async function buildSalesForecast(): Promise<SalesForecast> {
  // バッグ単位で「初期在庫・売れた数・売上」を復元する共通CTE(直近14日出品分)。
  const bagSalesCte = sql`
    bag_sales AS (
      SELECT sb.id, sb.store_id, sb.stock_count,
             ${jstDateExpr} AS d,
             (sb.stock_count + COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ${BOUGHT}),0))::int AS initial_units,
             COALESCE(SUM(r.quantity)     FILTER (WHERE r.status IN ${BOUGHT}),0)::int AS sold_units,
             COALESCE(SUM(r.total_price)  FILTER (WHERE r.status IN ${BOUGHT}),0)::int AS revenue
      FROM surprise_bags sb
      LEFT JOIN reservations r ON r.bag_id = sb.id
      WHERE sb.created_at > NOW() - INTERVAL '14 days'
      GROUP BY sb.id
    )`;

  // 日別
  const dailyRes = await db.execute(sql`
    WITH ${bagSalesCte}
    SELECT to_char(d, 'MM/DD') AS date, d AS d_raw,
           SUM(initial_units)::int AS listed_units,
           SUM(sold_units)::int AS sold_units,
           SUM(revenue)::int AS revenue,
           COUNT(*)::int AS listed_bags,
           COUNT(*) FILTER (WHERE stock_count <= 0 AND sold_units > 0)::int AS soldout_bags
    FROM bag_sales GROUP BY d ORDER BY d ASC`);
  const daily = dailyRes.rows.map((r: any) => ({
    date: r.date,
    listedUnits: Number(r.listed_units),
    soldUnits: Number(r.sold_units),
    revenue: Number(r.revenue),
    sellThrough: pct(Number(r.sold_units), Number(r.listed_units)),
  }));

  // 今日(JST)分。 日別クエリと同じ CTE から今日の行を切り出す。
  const jstIso = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const todayRes = await db.execute(sql`
    WITH ${bagSalesCte}
    SELECT COUNT(*)::int AS listed_bags,
           COALESCE(SUM(initial_units),0)::int AS listed_units,
           COALESCE(SUM(sold_units),0)::int AS sold_units,
           COALESCE(SUM(revenue),0)::int AS revenue,
           COUNT(*) FILTER (WHERE stock_count <= 0 AND sold_units > 0)::int AS soldout_bags
    FROM bag_sales WHERE d = ${jstIso}::date`);
  const t = todayRes.rows[0] as any;
  const today = {
    listedBags: Number(t.listed_bags),
    listedUnits: Number(t.listed_units),
    soldUnits: Number(t.sold_units),
    revenue: Number(t.revenue),
    soldOutBags: Number(t.soldout_bags),
    sellThrough: pct(Number(t.sold_units), Number(t.listed_units)),
  };

  // 店別(直近14日)。 出品在庫がある店だけ、売れた数の多い順。
  const storeRes = await db.execute(sql`
    WITH ${bagSalesCte}
    SELECT bs.store_id, s.name, s.category,
           SUM(bs.initial_units)::int AS listed_units,
           SUM(bs.sold_units)::int AS sold_units,
           SUM(bs.revenue)::int AS revenue
    FROM bag_sales bs JOIN stores s ON s.id = bs.store_id
    GROUP BY bs.store_id, s.name, s.category
    HAVING SUM(bs.initial_units) > 0
    ORDER BY sold_units DESC, listed_units DESC
    LIMIT 30`);
  const storePerformance = storeRes.rows.map((r: any) => ({
    storeId: Number(r.store_id), name: r.name, category: r.category ?? null,
    listedUnits: Number(r.listed_units), soldUnits: Number(r.sold_units),
    sellThrough: pct(Number(r.sold_units), Number(r.listed_units)), revenue: Number(r.revenue),
  }));

  // カテゴリ別(直近14日)。 明日どのジャンルを出品すれば売れるかの当たりを付ける。
  const catRes = await db.execute(sql`
    WITH ${bagSalesCte}
    SELECT COALESCE(s.category::text, 'その他') AS category,
           SUM(bs.initial_units)::int AS listed_units,
           SUM(bs.sold_units)::int AS sold_units,
           SUM(bs.revenue)::int AS revenue
    FROM bag_sales bs JOIN stores s ON s.id = bs.store_id
    GROUP BY COALESCE(s.category::text, 'その他')
    HAVING SUM(bs.initial_units) > 0
    ORDER BY sold_units DESC`);
  const categoryPerformance = catRes.rows.map((r: any) => ({
    category: r.category,
    listedUnits: Number(r.listed_units), soldUnits: Number(r.sold_units),
    sellThrough: pct(Number(r.sold_units), Number(r.listed_units)),
    revenue: Number(r.revenue),
  }));

  // 売上内訳: 成約注文(confirmed/picked_up)の支払額を「おすそわけ売上 / 店舗入金」に分解。
  //   店舗入金原資 = floor(商品代金 × 0.80)  ／  おすそわけ売上 = 支払額 − 店舗入金原資
  //   (商品代金 = merchandise_amount。旧データ(NULL)は total_price を商品代金とみなす = payment.ts と同一)
  //   ※ Stripe手数料は店舗負担のため、おすそわけ純利は platformRevenue 満額。
  const merch = sql`COALESCE(r.merchandise_amount, r.total_price)`;
  const payout = sql`FLOOR(${merch} * 0.80)`;
  const rJst = sql`DATE(r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')`;
  const bdRes = await db.execute(sql`
    SELECT
      -- 累計
      COUNT(*)::int                                        AS orders_all,
      COALESCE(SUM(r.total_price),0)::int                  AS gmv_all,
      COALESCE(SUM(${payout}),0)::int                      AS payout_all,
      -- 直近14日
      COUNT(*) FILTER (WHERE r.created_at > NOW() - INTERVAL '14 days')::int                       AS orders_14,
      COALESCE(SUM(r.total_price) FILTER (WHERE r.created_at > NOW() - INTERVAL '14 days'),0)::int  AS gmv_14,
      COALESCE(SUM(${payout})     FILTER (WHERE r.created_at > NOW() - INTERVAL '14 days'),0)::int  AS payout_14,
      -- 今日(JST)
      COUNT(*) FILTER (WHERE ${rJst} = ${jstIso}::date)::int                       AS orders_today,
      COALESCE(SUM(r.total_price) FILTER (WHERE ${rJst} = ${jstIso}::date),0)::int  AS gmv_today,
      COALESCE(SUM(${payout})     FILTER (WHERE ${rJst} = ${jstIso}::date),0)::int  AS payout_today
    FROM reservations r
    WHERE r.status IN ${BOUGHT}`);
  const bd = bdRes.rows[0] as any;
  const mkBreakdown = (period: string, orders: number, gmv: number, storePayout: number) => ({
    period, orders, gmv, storePayout,
    platformRevenue: gmv - storePayout,
    takeRate: pct(gmv - storePayout, gmv),
  });
  const breakdown = [
    mkBreakdown('今日',    Number(bd.orders_today), Number(bd.gmv_today), Number(bd.payout_today)),
    mkBreakdown('直近14日', Number(bd.orders_14),    Number(bd.gmv_14),    Number(bd.payout_14)),
    mkBreakdown('累計',    Number(bd.orders_all),   Number(bd.gmv_all),   Number(bd.payout_all)),
  ];

  // 予測: 直近14日の平均販売率 + 一番売れる/売れ残るジャンル。
  const totalListed = daily.reduce((a, d) => a + d.listedUnits, 0);
  const totalSold = daily.reduce((a, d) => a + d.soldUnits, 0);
  const avgSellThrough = pct(totalSold, totalListed);
  // 販売率でのジャンル最良/最悪(在庫が十分あるジャンルのみ)。
  const catBySell = categoryPerformance.filter((c) => c.listedUnits >= 3);
  const bestCategory = catBySell.length ? catBySell.reduce((a, b) => (b.sellThrough > a.sellThrough ? b : a)).category : null;
  const worstCategory = catBySell.length ? catBySell.reduce((a, b) => (b.sellThrough < a.sellThrough ? b : a)).category : null;
  const note =
    totalListed === 0
      ? "まだ出品データが無い。 出品が増えれば売れ行きと予測がここに出る。"
      : `直近${daily.length}日で ${totalListed}個出品し ${totalSold}個(${avgSellThrough}%)売れた。` +
        (bestCategory ? ` 「${bestCategory}」が最も捌け、` : "") +
        (worstCategory && worstCategory !== bestCategory ? `「${worstCategory}」が売れ残りやすい。` : "") +
        " 明日の出品はよく売れるジャンル・実績店を優先すると完売率が上がる。";

  return {
    today, daily, storePerformance, categoryPerformance, breakdown,
    forecast: { sampleDays: daily.length, avgSellThrough, bestCategory, worstCategory, note },
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  店舗サポート（毎日更新）— 手動出品してくれた店に、状況別の営業アプローチを自動生成。
//  board(俺らだけ)専用。「出してくれた店に、定期出品化や販売改善のアプローチを毎日かける」ため。
//
//  対象     : 直近30日に "手動出品"(recurring_listing_id IS NULL)が1回でもある承認店。
//  除外     : 定期出品テンプレの受取曜日(daysOfWeek)が週4日以上ある店(=もう定期に乗ってる)。
//  状況判定 : 連続手動→定期化を勧める / 売れ残り→販売サポート / 出品途切れ→再開の声かけ 等。
//  出力     : 店ごとに数字＋そのままDM/連絡に使えるコピペ営業文。
// ════════════════════════════════════════════════════════════════════════════
export type OutreachSituation =
  | "convert_to_recurring"  // 連続で手動出品・定期未設定 → 定期化を勧める(最優先)
  | "low_sales"             // 売れ残りがち → 販売サポート
  | "went_quiet"            // 出品が途切れた → 再開の声かけ
  | "partial_recurring"     // 定期を週1〜3日だけ設定 → 残り営業日も定期化
  | "steady";               // 安定して手動出品・売れてる → 頃合いで定期化案内

export interface StoreOutreachItem {
  storeId: number;
  storeName: string;
  city: string | null;
  situation: OutreachSituation;
  headline: string;          // 絵文字つき見出し
  manualStreak: number;      // 今日/昨日から遡った連続手動出品日数
  manualDaysRecent: number;  // 直近30日で手動出品した日数
  daysSinceManual: number;   // 最後の手動出品からの経過日数
  listedUnits: number;       // 直近14日の手動出品 総在庫(復元)
  soldUnits: number;         // うち売れた数
  sellThrough: number;       // 販売率 %
  recurringDays: number;     // 定期テンプレの受取曜日数(0=未設定)
  message: string;           // コピペ用 営業文(実データ差し込み済)
}

export interface StoreOutreach {
  generatedAt: string;       // JST "YYYY-MM-DD"
  items: StoreOutreachItem[];
  note: string;
}

// 連続日数: 'YYYY-MM-DD' の降順配列から、最新日を起点に1日刻みで途切れるまでの連続数。
//   最新出品が今日 or 昨日(JST)なら「現在進行中の連続」とみなす。それ以前で途切れてたら 0。
function computeManualStreak(datesDesc: string[], todayJst: string): number {
  if (datesDesc.length === 0) return 0;
  const dayMs = 24 * 3600 * 1000;
  const today = new Date(todayJst + "T00:00:00Z").getTime();
  const latest = new Date(datesDesc[0] + "T00:00:00Z").getTime();
  // 最新出品が今日/昨日でなければ「今の連続」ではない
  if (today - latest > dayMs) return 0;
  let streak = 1;
  for (let i = 1; i < datesDesc.length; i++) {
    const prev = new Date(datesDesc[i - 1] + "T00:00:00Z").getTime();
    const cur = new Date(datesDesc[i] + "T00:00:00Z").getTime();
    if (prev - cur === dayMs) streak++;
    else break;
  }
  return streak;
}

export async function buildStoreOutreach(): Promise<StoreOutreach> {
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const rows = (await db.execute(sql`
    WITH manual_dates AS (
      SELECT store_id,
             array_agg(DISTINCT to_char(created_at + interval '9 hours', 'YYYY-MM-DD') ORDER BY to_char(created_at + interval '9 hours', 'YYYY-MM-DD') DESC) AS dates,
             MAX(created_at) AS last_manual_at
      FROM surprise_bags
      WHERE recurring_listing_id IS NULL
        AND created_at > now() - interval '30 days'
      GROUP BY store_id
    ),
    bag_sold AS (
      SELECT sb.store_id, sb.id AS bag_id,
             sb.stock_count + COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ${BOUGHT}), 0) AS listed_units,
             COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ${BOUGHT}), 0) AS sold_units
      FROM surprise_bags sb
      LEFT JOIN reservations r ON r.bag_id = sb.id
      WHERE sb.recurring_listing_id IS NULL
        AND sb.created_at > now() - interval '14 days'
      GROUP BY sb.store_id, sb.id, sb.stock_count
    ),
    sell AS (
      SELECT store_id, SUM(listed_units)::int AS listed_units, SUM(sold_units)::int AS sold_units
      FROM bag_sold GROUP BY store_id
    ),
    rec AS (
      SELECT store_id,
             MAX(length(regexp_replace((days_of_week)::bit(7)::text, '0', '', 'g'))) FILTER (WHERE is_active) AS recurring_days
      FROM recurring_listings GROUP BY store_id
    )
    SELECT s.id, s.name, s.city,
           md.dates,
           EXTRACT(DAY FROM now() - md.last_manual_at)::int AS days_since_manual,
           COALESCE(sell.listed_units, 0)::int AS listed_units,
           COALESCE(sell.sold_units, 0)::int AS sold_units,
           COALESCE(rec.recurring_days, 0)::int AS recurring_days
    FROM stores s
    JOIN manual_dates md ON md.store_id = s.id
    LEFT JOIN sell ON sell.store_id = s.id
    LEFT JOIN rec ON rec.store_id = s.id
    WHERE s.status = 'approved'
      AND COALESCE(rec.recurring_days, 0) < 4
  `)).rows as any[];

  const items: StoreOutreachItem[] = rows.map((r) => {
    const name = String(r.name);
    const city = r.city ? String(r.city) : null;
    const dates: string[] = Array.isArray(r.dates) ? r.dates.map(String) : [];
    const manualStreak = computeManualStreak(dates, todayJst);
    const manualDaysRecent = dates.length;
    const daysSinceManual = Number(r.days_since_manual ?? 0);
    const listedUnits = Number(r.listed_units);
    const soldUnits = Number(r.sold_units);
    const sellThrough = pct(soldUnits, listedUnits);
    const recurringDays = Number(r.recurring_days);

    let situation: OutreachSituation;
    let headline: string;
    let message: string;

    if (recurringDays === 0 && manualStreak >= 3) {
      situation = "convert_to_recurring";
      headline = `🔁 ${manualStreak}日連続で手動出品中 → 定期出品を案内`;
      message =
        `${name}さん、毎日の出品ありがとうございます！${manualStreak}日連続で手動で出してくださってますね。` +
        `実は「定期出品」を一度設定しておくと、毎日決まった時間に自動で同じ内容が出せて、この手間がまるごとゼロになります。` +
        `お忙しい中の毎日の作業がなくなるので、ぜひ一度設定をご案内させてください。数分で終わります。`;
    } else if (listedUnits >= 3 && sellThrough < 30) {
      situation = "low_sales";
      headline = `📉 販売率${sellThrough}% → 売れ行きサポート`;
      message =
        `${name}さん、いつも出品ありがとうございます。直近2週間の販売率が${sellThrough}%（${soldUnits}/${listedUnits}個）で、` +
        `少し売れ残りが出ているようです。改善のヒントとして、①受取時間を少し早める ②価格をあと少しお得に ③写真を明るく撮り直す、` +
        `のどれかで完売率がぐっと上がる店舗さんが多いです。よければ一緒に見直しましょう！`;
    } else if (daysSinceManual >= 3) {
      situation = "went_quiet";
      headline = `😴 ${daysSinceManual}日 出品なし → 再開の声かけ`;
      message =
        `${name}さん、お世話になっております。ここ${daysSinceManual}日ほど出品がお休みのようですが、お変わりないですか？` +
        `「今日は余りそう」という日がありましたら、ぜひ一袋からでもおすそわけをお願いします。楽しみに待っているお客様がいます！`;
    } else if (recurringDays >= 1 && recurringDays <= 3) {
      situation = "partial_recurring";
      headline = `➕ 定期 週${recurringDays}日設定済 → 残り営業日も定期化`;
      message =
        `${name}さん、定期出品のご活用ありがとうございます（現在 週${recurringDays}日）。` +
        `残りの営業日も定期出品に加えておくと、出し忘れなく毎日自動でおすそわけが出せて、集客の取りこぼしが減ります。` +
        `曜日を追加するだけなので、よければご案内します。`;
    } else {
      situation = "steady";
      const rateNote = listedUnits > 0 ? `（販売率${sellThrough}%）` : "";
      headline = `👍 安定出品中${rateNote} → 頃合いで定期化`;
      message =
        `${name}さん、いつも安定して出品いただきありがとうございます${listedUnits > 0 ? `（直近の販売率${sellThrough}%）` : ""}。` +
        `毎日の出品作業をもっと楽にする「定期出品」もありますので、タイミングを見てご案内できればと思います。引き続きよろしくお願いします！`;
    }

    return {
      storeId: Number(r.id), storeName: name, city, situation, headline,
      manualStreak, manualDaysRecent, daysSinceManual,
      listedUnits, soldUnits, sellThrough, recurringDays, message,
    };
  });

  // 優先度順（インパクトの大きい順）に並べる。同順位は補助指標で。
  const rank: Record<OutreachSituation, number> = {
    convert_to_recurring: 0, low_sales: 1, went_quiet: 2, partial_recurring: 3, steady: 4,
  };
  items.sort((a, b) => {
    if (rank[a.situation] !== rank[b.situation]) return rank[a.situation] - rank[b.situation];
    if (a.situation === "convert_to_recurring") return b.manualStreak - a.manualStreak;
    if (a.situation === "low_sales") return a.sellThrough - b.sellThrough;
    if (a.situation === "went_quiet") return b.daysSinceManual - a.daysSinceManual;
    return b.soldUnits - a.soldUnits;
  });

  const convertN = items.filter((i) => i.situation === "convert_to_recurring").length;
  const lowN = items.filter((i) => i.situation === "low_sales").length;
  const quietN = items.filter((i) => i.situation === "went_quiet").length;
  const note =
    items.length === 0
      ? "今日アプローチ対象の手動出品店はありません（対象店が全員 定期出品4日以上か、直近30日 手動出品なし）。"
      : `本日のアプローチ対象 ${items.length}店。` +
        (convertN ? ` 定期化案内 ${convertN}店、` : "") +
        (lowN ? ` 販売サポート ${lowN}店、` : "") +
        (quietN ? ` 再開の声かけ ${quietN}店。` : "") +
        " 上から優先度順。文面はそのままコピーして連絡に使えます。";

  return { generatedAt: todayJst, items, note };
}

export interface AppStoreMetrics {
  downloads: number;       // 累計DL（App Store Connect から手動入力）
  impressions: number;
  updatedAt: string | null;
}
