// ═══════════════════════════════════════════════════════════════════════════
//  Growth コア — 成長データの集計 + 「今日やるべき完璧なチェックリスト」生成。
//  /admin/growth（管理者）と /api/board/*（俺らだけの共有ボード）の両方が使う。
// ═══════════════════════════════════════════════════════════════════════════
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import OpenAI from "openai";
import { computeUserTotal } from "./pricing.js";

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

// ── チェックリスト項目の型 ──
export type TimeSlot = "morning" | "midday" | "afternoon" | "evening" | "night";

export interface ChecklistTarget {
  label: string;           // 名指しターゲット（店名など）
  sub?: string;            // 補足（市・在庫・◯日出品なし等）
}

export interface ChecklistItem {
  id: string;
  category: "supply" | "reengage" | "instagram" | "threads" | "community" | "ops";
  timeSlot: TimeSlot;      // 時間帯（タイムライン表示のグルーピング）
  title: string;
  priority: "must" | "high" | "normal";
  estMinutes: number;      // 所要時間の目安（分）
  reason: string;          // なぜやるか（データ根拠つき）
  kpi?: string;            // この項目の“成功”の定義（今日の合格ライン）
  steps: string[];         // 具体手順
  targets?: ChecklistTarget[]; // 名指しターゲット（実店名など）
  template?: string;       // コピペ用の投稿/連絡テンプレ（実データ差し込み済）
  bestTime?: string;       // 推奨時間帯
  action?: { type: "reengage"; segment: "fav_no_purchase" | "registered_no_purchase_7d"; label: string };
  meta?: Record<string, unknown>;
}

export const TIME_SLOT_META: Record<TimeSlot, { label: string; emoji: string; hint: string }> = {
  morning:   { label: "朝イチ",   emoji: "🌅", hint: "07:30〜10:00" },
  midday:    { label: "昼",       emoji: "☀️", hint: "11:00〜14:00" },
  afternoon: { label: "午後",     emoji: "🏪", hint: "14:00〜17:00" },
  evening:   { label: "夕方",     emoji: "🌆", hint: "17:00〜19:00" },
  night:     { label: "夜",       emoji: "🌙", hint: "21:00〜23:00" },
};

export interface AppStoreMetrics {
  downloads: number;       // 累計DL（App Store Connect から手動入力）
  impressions: number;
  updatedAt: string | null;
}

// 曜日別の推奨コンテンツ（Instagram フィード/リール）
const IG_FEED_BY_DOW: Record<number, { title: string; idea: string }> = {
  0: { title: "日曜: 今週の感謝リール", idea: "今週おすそわけしてくれた店・救われた食品数をまとめてリール化。数字で社会貢献を可視化。" },
  1: { title: "月曜: お店紹介リール", idea: "1店ピックして『中の人』インタビュー風。人柄が出ると応援される。" },
  2: { title: "火曜: フードロス豆知識", idea: "『日本の食品ロス年間◯万t』などの事実 + おすそわけの解決策を1枚絵で。" },
  3: { title: "水曜: ユーザーの受取レポート", idea: "実際の中身開封写真（許可済み）。『990円で これだけ!』のお得感を前面に。" },
  4: { title: "木曜: ハウツー投稿", idea: "『予約→受取』の使い方を3ステップで図解。新規の不安を消す。" },
  5: { title: "金曜: 週末の在庫予告", idea: "土日に出そうな店・ジャンルを予告して期待感を作る。" },
  6: { title: "土曜: ビフォーアフター", idea: "『捨てられるはずだった→誰かの食卓へ』の対比。エモーショナルに。" },
};

function jstToday(): { iso: string; dow: number; label: string } {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const iso = jst.toISOString().slice(0, 10);
  const dow = jst.getUTCDay();
  const label = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
  return { iso, dow, label };
}

// 通貨整形（¥1,234）。
const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

// ── 「今日の完璧なチェックリスト」を “その日のデータ” から生成 ──
// 時間帯（timeSlot）で並ぶタイムライン式。実店名・実価格・実人数を全部差し込む。
export function buildDailyChecklist(growth: GrowthData, appstore: AppStoreMetrics): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const { dow, label: dateLabel } = jstToday();
  const sup = growth.supply;
  const supplyHealthy = sup.storesWithLiveBags >= 10;
  const hasLiveStock = sup.liveStockUnits > 0;
  const live = growth.liveStores;
  const top = live[0];               // 一番在庫が多いライブ店
  const topDiscount = top && top.originalPrice > 0
    ? Math.round((1 - top.discountedPrice / top.originalPrice) * 100) : 0;

  // 実店名を文面へ差し込むヘルパー（無ければ無難なプレースホルダ）。
  const storeName = (s?: GrowthLiveStore) => (s ? s.name : "お店");

  // ═══════════ 🌅 朝イチ（07:30〜10:00）═══════════

  // Threads① 価値観発信
  items.push({
    id: "threads_morning",
    category: "threads",
    timeSlot: "morning",
    title: "🧵 Threads① 朝：フードロスの“気づき”を投稿",
    priority: "high",
    estMinutes: 5,
    reason: "Threadsはテキストの共感・議論が伸びる。フードロスは社会テーマで共感されやすく、リポストで一気に広がる。宣伝でなく“価値観”を出してファンを作る枠。",
    kpi: "1投稿 + 付いた返信は全部返す",
    steps: [
      "下のテンプレをコピペ投稿（宣伝色は薄めに、想い先行で）。",
      "最後の問いかけで返信を誘う。付いた返信は全部返す（初期は会話量がアルゴリズムを動かす）。",
      "リポスト/いいねしてくれた人を1人フォローして接点を作る。",
    ],
    template:
      "日本の食品ロスは年間472万t。国民ひとりあたり、毎日おにぎり1個ぶんを捨ててる計算らしいです。\n\n『まだ食べられるのに』が悔しくて、閉店前のお店の余りをお得に買える“おすそわけ”ってアプリを作りました。\n\nみんなは食品ロス、普段気にしますか?🧵",
    bestTime: "7:30〜8:30",
  });

  // 承認待ち処理（供給の源泉）
  items.push({
    id: "ops_pending",
    category: "ops",
    timeSlot: "morning",
    title: "🏪 新規店舗の申請・承認待ちをゼロにする",
    priority: "high",
    estMinutes: 10,
    reason: "承認が遅れる＝出品開始が遅れる＝供給の機会損失。申請を溜めると店側の熱も冷める。即日さばくのが供給拡大の基本。",
    kpi: "applied / pending_review を残数0に",
    steps: [
      "神モード（/admin）の店舗セクションで applied / pending_review を開く。",
      "書類が揃っていれば即承認。不備は『どこが足りないか』を具体的に書いて差し戻し。",
      "Stripe未連携で止まってる店には登録リンクを再送（Stripe未完了＝入金できない＝出品しても無意味）。",
    ],
    bestTime: "9:00〜9:30",
  });

  // 供給の脈拍（健全ならチェック、薄ければ叩き起こし）
  if (supplyHealthy) {
    items.push({
      id: "supply_check",
      category: "supply",
      timeSlot: "morning",
      title: `✅ 供給の脈拍を確認（ライブ ${sup.storesWithLiveBags} 店 / 在庫 ${sup.liveStockUnits} 個）`,
      priority: "normal",
      estMinutes: 5,
      reason: `供給は健全ライン(10店)以上。買える店が並んでる状態を毎朝キープできてるか確認する。今ライブ ${sup.liveBags} 袋。`,
      kpi: "ライブ10店以上を維持・ジャンル偏りを検知",
      steps: [
        "ボード上部『供給の脈拍』でライブ店数が10を切ってないか確認。",
        "パン/惣菜など特定ジャンルに偏ってないか下の『今ライブの店』で見て、薄いジャンルの店に声かけ。",
      ],
      bestTime: "9:00",
    });
  } else {
    const deadTargets: ChecklistTarget[] = growth.deadStores.slice(0, 5).map((d) => ({
      label: `${d.name}`,
      sub: `${d.city || "—"}・${d.daysSinceLastBag == null ? "出品履歴なし" : `${d.daysSinceLastBag}日出品なし`}${d.orders === 0 ? "・売上0" : ""}`,
    }));
    items.push({
      id: "supply_wakeup",
      category: "supply",
      timeSlot: "morning",
      title: `🔴 最優先：死に店を叩き起こす（今ライブ ${sup.storesWithLiveBags} 店しかない）`,
      priority: "must",
      estMinutes: 30,
      reason: `いま買える在庫がある店は ${sup.storesWithLiveBags} 店だけ。ユーザーがアプリを開いても『近くに何も無い』＝離脱の最大要因。ここが全ての土台。今日まず供給を10店に戻す。`,
      kpi: "今日中に下の3店へ連絡 → 1店でも出品再開",
      steps: [
        "下の『今日連絡する店』3店に、朝のうちに連絡する（売上0・出品履歴なしを優先済み）。",
        "LINE or 電話で下のテンプレを送る。『今日の閉店前に余りそうな分だけでも、在庫1個からでOK』と超低ハードルで提案。",
        "『やり方分からん』と言われたら、店舗ダッシュボードの出品を画面共有 or その場で代理入力してあげる（初回の摩擦を運営が吸収する）。",
        "反応が無い店は営業リードに“要フォロー・○/○連絡済”とメモして翌日再アプローチ。",
      ],
      targets: deadTargets,
      template:
        "【おすそわけ運営です】いつもお世話になっております🙏\n本日、閉店前に余りそうな商品はありませんか？「サプライズバッグ」として1品・在庫1個からでも出品いただけます。\n\n・出品は3タップ、1〜2分で完了\n・売れ残りが無駄にならず、少しでも売上に\n・やり方はこちらで画面共有しながらサポートします\n\n今日の分だけでもいかがでしょう？ご返信お待ちしています！",
      bestTime: "9:30〜10:00（1日の在庫が見え始める前に種まき）",
    });
  }

  // IGストーリー① 出品予告（実店名・実価格を差し込む）
  items.push({
    id: "ig_story_morning",
    category: "instagram",
    timeSlot: "morning",
    title: "📸 インスタ ストーリー① 朝：今日の出品予告",
    priority: "high",
    estMinutes: 8,
    reason: "ストーリーは24hで消える“今”の情報と相性が最高。毎朝リマインドして来店習慣を作る。1日複数投稿が正義（表示が伸びる）。",
    kpi: "ストーリー1本 + リンクスタンプ設置",
    steps: [
      top ? `今ライブの「${storeName(top)}」の商品写真をストーリーに投稿（下に実データ入りテンプレあり）。` : "今日ライブ在庫がある店を1つ選び、商品写真をストーリーに。",
      "『@店名』でメンション（店がリポスト→拡散）。",
      "『リンク』スタンプで osusowakejapan.org へ導線。",
      "位置スタンプ（高槻市）＋『#おすそわけ #高槻グルメ #フードロス』。",
      "アンケートスタンプ『今日食べたいのは? 🍞 or 🍱』でエンゲージを稼ぐ。",
    ],
    targets: top ? [{ label: storeName(top), sub: `${top.title}・在庫${top.stock}個・${yen(computeUserTotal(top.discountedPrice))}${top.pickupStart ? `・受取${top.pickupStart}〜${top.pickupEnd ?? ""}` : ""}` }] : undefined,
    template: top
      ? `本日のおすそわけ🎁\n${top.city || "高槻"}の【${top.name}】さん\n「${top.title}」が${top.stock}個限定で登場！\n${topDiscount > 0 ? `${yen(top.originalPrice)}→${yen(computeUserTotal(top.discountedPrice))}（${topDiscount}%OFF）` : yen(computeUserTotal(top.discountedPrice))}\n${top.pickupStart ? `受取 ${top.pickupStart}〜${top.pickupEnd ?? ""}\n` : ""}売り切れ前にアプリから👇 #おすそわけ #高槻 #フードロス削減`
      : "本日のおすそわけ🎁 高槻の【店名】さんのサプライズバッグ、◯個限定！売り切れ前にアプリから👇 #おすそわけ #高槻 #フードロス削減",
    bestTime: "8:00〜9:00（通勤・朝の可処分時間）",
  });

  // ═══════════ ☀️ 昼（11:00〜14:00）═══════════

  // 再エンゲージ Push（お気に入り済・未購入）— 在庫がある日だけ
  if (hasLiveStock && growth.hotLeads.favNoPurchase > 0) {
    items.push({
      id: "reengage_fav",
      category: "reengage",
      timeSlot: "midday",
      title: `🔥 お気に入り済み・未購入 ${growth.hotLeads.favNoPurchase} 人に Push`,
      priority: "high",
      estMinutes: 3,
      reason: `お気に入りを付けたのに未購入が ${growth.hotLeads.favNoPurchase} 人。興味は示してる＝一番刈りやすい層。今日は在庫があるので撃つ価値大。`,
      kpi: "Push送信 → 当日夜に購入が増えたかファネルで確認",
      steps: [
        "下の『Pushを撃つ』ボタンを押す。",
        top ? `文面に在庫のある実店（例:「${storeName(top)}」）を匂わせると刺さる。` : "在庫のある店を匂わせる文面にする。",
        "撃ちっぱなしにせず、夜に購入数が動いたかボードのファネルで確認。",
      ],
      template: top
        ? `お気に入りのお店に空きが出ました🍞「${top.name}」の${top.title}、今なら${yen(computeUserTotal(top.discountedPrice))}。売り切れ前にチェック！`
        : "お気に入りのお店に空きが出ました🍞 気になっていたサプライズバッグ、売り切れ前にチェック！",
      bestTime: "11:00（昼食前・受取イメージが湧く）",
      action: { type: "reengage", segment: "fav_no_purchase", label: "お気に入り済み・未購入" },
    });
  }

  // IGフィード/リール（曜日出し分け）
  const feed = IG_FEED_BY_DOW[dow];
  items.push({
    id: "ig_feed",
    category: "instagram",
    timeSlot: "midday",
    title: `🎬 インスタ フィード/リール：${feed.title}`,
    priority: "normal",
    estMinutes: 25,
    reason: "ストーリーが“今”ならフィード/リールは“資産”。発見タブから新規フォロワーを連れてくる。リールが最も伸びるフォーマット。",
    kpi: "リール or フィード1本を公開",
    steps: [
      `今日のお題（${dateLabel}・${feed.title}）：${feed.idea}`,
      "冒頭2秒で数字 or 意外な事実のフックを入れて離脱を防ぐ。",
      "字幕を必ず付ける（音無し視聴が7割）。尺は15〜30秒。",
      "最後に『プロフィールのリンクから』とCTA。",
    ],
    bestTime: "昼に撮って編集 → 公開は19:00〜21:00予約でもOK",
  });

  // ═══════════ 🏪 午後（14:00〜17:00）═══════════

  // 供給が健全でも、常に翌日の種まき営業を1件は入れる
  if (supplyHealthy && growth.deadStores.length > 0) {
    const deadTargets: ChecklistTarget[] = growth.deadStores.slice(0, 3).map((d) => ({
      label: d.name,
      sub: `${d.city || "—"}・${d.daysSinceLastBag == null ? "出品履歴なし" : `${d.daysSinceLastBag}日出品なし`}`,
    }));
    items.push({
      id: "supply_seed",
      category: "supply",
      timeSlot: "afternoon",
      title: "🌱 明日の供給の種まき（休眠店に1件アプローチ）",
      priority: "normal",
      estMinutes: 15,
      reason: `供給は今は足りてるが、明日も続くとは限らない。休眠店が ${growth.deadStores.length} 店ある。毎日1件でも掘り起こせば供給は右肩上がりになる。`,
      kpi: "休眠店1店に連絡",
      steps: [
        "下の休眠店から1店選んで、朝の営業テンプレで連絡。",
        "『他店さんもこれくらい売れてます』と実績（今日の受取数など）を添えると動きやすい。",
      ],
      targets: deadTargets,
      bestTime: "14:00〜16:00",
    });
  }

  // IGストーリー② 残りわずか（実店名・実在庫）
  items.push({
    id: "ig_story_evening",
    category: "instagram",
    timeSlot: "afternoon",
    title: "📸 インスタ ストーリー② 夕方：残りわずか煽り",
    priority: "high",
    estMinutes: 5,
    reason: `緊急性(FOMO)は購入の最強トリガー。夕方に『残りわずか』を出すと閉店前の駆け込み受取が増える。今ライブ ${sup.liveBags} 袋。`,
    kpi: "ストーリー1本（在庫が残る店を名指し）",
    steps: [
      "夕方時点で在庫が残ってる店をボードの『今ライブの店』で確認。",
      "『⏰ 本日ラスト！残り◯個』とカウントダウン感を出す。",
      "リンクスタンプで即予約へ。受取済みユーザーの『美味しかった』声があればスクショで信頼補強。",
    ],
    targets: top ? [{ label: storeName(top), sub: `残り${top.stock}個・${yen(computeUserTotal(top.discountedPrice))}` }] : undefined,
    template: top
      ? `⏰ 本日ラスト！\n【${top.name}】「${top.title}」残り${top.stock}個！\nこのあと閉店で終了です。今すぐ受取予約👇\n#おすそわけ #高槻テイクアウト`
      : "⏰ 本日ラスト！【店名】残り◯個！このあと閉店で終了。今すぐ受取予約👇 #おすそわけ #高槻テイクアウト",
    bestTime: "16:30〜17:30（閉店前の駆け込み狙い）",
  });

  // ═══════════ 🌆 夕方（17:00〜19:00）═══════════

  // 再エンゲージ Push（新規7日・未購入）
  if (hasLiveStock && growth.hotLeads.registered7dNoPurchase >= 20) {
    items.push({
      id: "reengage_new",
      category: "reengage",
      timeSlot: "evening",
      title: `🔥 直近7日登録・未購入 ${growth.hotLeads.registered7dNoPurchase} 人に Push`,
      priority: "high",
      estMinutes: 3,
      reason: `登録したてで未購入の新規が ${growth.hotLeads.registered7dNoPurchase} 人。鮮度が高いうちに初回購入へ背中を押す（初回購入がリテンションの分岐点）。全体の登録→購入は ${growth.funnel.rates.registerToBuy}% しかなく、ここが最大のボトルネック。`,
      kpi: "Push送信 → 新規の初回購入を1件でも生む",
      steps: [
        "帰宅前・夕飯を考える時間に『Pushを撃つ』。",
        "初回ハードルを下げる文面（『まずは近くのお店を見てみよう』）に。",
        "反応が薄ければ次フェーズで初回クーポンを検討（今日は無料の一押しを撃つ）。",
      ],
      template: "はじめてのおすそわけ、待ってます🎁 あなたの街のお店の美味しいものをお得に。今夜受け取れるバッグを見てみよう👇",
      bestTime: "18:00〜19:00（帰宅前・夕飯検討）",
      action: { type: "reengage", segment: "registered_no_purchase_7d", label: "直近7日登録・未購入" },
    });
  }

  // ═══════════ 🌙 夜（21:00〜23:00）═══════════

  // Threads② ユーザーの声
  items.push({
    id: "threads_evening",
    category: "threads",
    timeSlot: "night",
    title: "🧵 Threads② 夜：ユーザーの声/レビュー紹介",
    priority: "normal",
    estMinutes: 5,
    reason: `満足度は高い（★${growth.reviews.avgRating || "-"}・${growth.reviews.count}件）。この“生の声”を出すと『自分も試そう』が生まれる。UGCは最強の広告。`,
    kpi: "1投稿",
    steps: [
      "実際のレビュー/DMの好意的な声を1つ紹介（個人特定しない形で）。",
      "『こういう体験を届けたい』と運営の想いを添える。",
      "アプリ名だけ出してリンクは固定表示に任せる（宣伝臭を抑える）。",
    ],
    template: "『990円のパン袋、開けたら5種類も入ってて感動した』ってレビューをもらいました…！\n捨てられるはずだったパンが、誰かの幸せな朝ごはんになる。これがやりたかったことです。#おすそわけ",
    bestTime: "21:00〜22:30",
  });

  // レビュー返信
  if (growth.reviews.count > 0) {
    items.push({
      id: "review_reply",
      category: "community",
      timeSlot: "night",
      title: "💬 新着レビューに返信する",
      priority: "normal",
      estMinutes: 8,
      reason: "レビュー返信は投稿者の再来店率を上げ、閲覧者にも『運営が丁寧』と伝わる。返信0件は機会損失。",
      kpi: "未返信レビューを残数0に",
      steps: [
        "管理画面/店舗ダッシュボードで未返信レビューを確認。",
        "感謝＋次回の後押しを一言（テンプレ化しすぎず個別に）。",
      ],
      bestTime: "夜まとめて",
    });
  }

  // 一日の振り返り（数字で締める）
  items.push({
    id: "daily_review",
    category: "ops",
    timeSlot: "night",
    title: "📊 今日の数字を振り返る（1分）",
    priority: "normal",
    estMinutes: 2,
    reason: "毎日ファネルを見る習慣が“何が効いたか”を体に刻む。Pushを撃った日は購入が動いたか、供給を増やせたかを確認して明日に活かす。",
    kpi: "購入・新規登録・ライブ店数を記録",
    steps: [
      "ボード上部のファネルで、今日 購入者が増えたか確認。",
      "Pushを撃った日は、撃つ前後で購入が動いたか比較。",
      `今日の記録：ライブ ${sup.storesWithLiveBags} 店 / 在庫 ${sup.liveStockUnits} 個 / 累計購入 ${growth.funnel.buyers} 人。明日はこれを上回る。`,
    ],
    bestTime: "寝る前",
  });

  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI 動的チェックリスト — その日の実データを分析して“今日一番効く順”に組む。
//  固定テンプレ(buildDailyChecklist)と違い、毎日データに応じて中身が変わる。
//  失敗時(キー無し/APIエラー/JSON壊れ)は必ず固定テンプレにフォールバックして board を壊さない。
// ═══════════════════════════════════════════════════════════════════════════

const CHECKLIST_CATEGORIES = ["supply", "reengage", "instagram", "threads", "community", "ops"] as const;
const CHECKLIST_SLOTS = ["morning", "midday", "afternoon", "evening", "night"] as const;
const CHECKLIST_PRIORITIES = ["must", "high", "normal"] as const;
const SLOT_RANK: Record<TimeSlot, number> = { morning: 0, midday: 1, afternoon: 2, evening: 3, night: 4 };

const checklistOpenai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy",
});

// AI に渡す「今日の全実データ」を、そのまま根拠にできる密度のテキストにまとめる。
function checklistDataDump(growth: GrowthData, appstore: AppStoreMetrics, sales: SalesForecast | null): string {
  const { iso, dow, label } = jstToday();
  const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];
  const f = growth.funnel;
  const sup = growth.supply;
  const L: string[] = [];
  L.push(`日付: ${iso}(${DOW_JP[dow]}曜) / 表示ラベル ${label}`);
  L.push(`■ファネル(累計): 登録${f.registered} / お気に入り${f.favorited} / 購入者${f.buyers} / リピーター${f.repeatBuyers}`);
  L.push(`  新規 直近7日${f.newUsers7d}・30日${f.newUsers30d}`);
  L.push(`  転換率: 登録→お気に入り${f.rates.registerToFav}% / お気に入り→購入${f.rates.favToBuy}% / 登録→購入${f.rates.registerToBuy}% / 購入→リピート${f.rates.buyToRepeat}%`);
  L.push(`■累計GMV: ${yen(growth.gmvTotal)} / レビュー ${growth.reviews.count}件(平均★${growth.reviews.avgRating || "-"})`);
  L.push(`■供給: 承認稼働店${sup.approvedActiveStores} / 今ライブの店${sup.storesWithLiveBags} / ライブ袋${sup.liveBags} / ライブ在庫${sup.liveStockUnits}個`);
  L.push(`■ホットリード: お気に入り済み未購入${growth.hotLeads.favNoPurchase}人 / 登録7日以内未購入${growth.hotLeads.registered7dNoPurchase}人`);
  if (sales) {
    const t = sales.today, fc = sales.forecast;
    L.push(`■今日の販売実績: 出品${t.listedBags}袋/在庫${t.listedUnits}個/売れた${t.soldUnits}個/完売${t.soldOutBags}袋/売上${yen(t.revenue)}/販売率${t.sellThrough}%`);
    L.push(`■販売傾向(直近${fc.sampleDays}日): 平均販売率${fc.avgSellThrough}% / 好調カテゴリ:${fc.bestCategory ?? "—"} / 不調カテゴリ:${fc.worstCategory ?? "—"}`);
    if (fc.note) L.push(`  所見: ${fc.note}`);
    if (sales.daily?.length) {
      L.push(`■日別販売率(直近): ` + sales.daily.slice(-7).map((d) => `${d.date} ${d.soldUnits}/${d.listedUnits}個(${d.sellThrough}%)`).join(" / "));
    }
    if (sales.categoryPerformance?.length) {
      L.push(`■カテゴリ別(売れた/出品): ` + sales.categoryPerformance.map((c) => `${c.category} ${c.soldUnits}/${c.listedUnits}(${c.sellThrough}%)`).join(" / "));
    }
    if (sales.storePerformance?.length) {
      L.push(`■店別 売れ行き上位: ` + sales.storePerformance.slice(0, 6).map((s) => `${s.name} ${s.soldUnits}/${s.listedUnits}個`).join(" / "));
    }
  }
  if (growth.liveStores.length) {
    L.push(`■今ライブの店(名指し可): ` + growth.liveStores.slice(0, 8).map((s) => `${s.name}[${s.category ?? "その他"}] ${s.title}・在庫${s.stock}・${yen(computeUserTotal(s.discountedPrice))}${s.pickupStart ? `・受取${s.pickupStart}〜${s.pickupEnd ?? ""}` : ""}`).join(" / "));
  }
  if (growth.deadStores.length) {
    L.push(`■叩き起こすべき休眠店(名指し可): ` + growth.deadStores.slice(0, 8).map((d) => `${d.name}(${d.city || "—"}・${d.daysSinceLastBag == null ? "出品履歴なし" : `${d.daysSinceLastBag}日出品なし`}${d.orders === 0 ? "・売上0" : ""})`).join(" / "));
  }
  L.push(`■App Store: DL${appstore.downloads} / インプレ${appstore.impressions}`);
  return L.join("\n");
}

const CHECKLIST_SYSTEM = `あなたは「おすそわけ」(=Too Good To Go の日本版フードロス削減アプリ、高槻市中心)のグロース戦略責任者です。
飲食店が閉店前の余剰食品を「サプライズバッグ」として安く売り、ユーザーが予約・決済します(店舗手数料20%/ユーザー5%)。集客チャネルはInstagram(ストーリー/リール)・Threads・プッシュ通知・店舗の新規開拓。
渡された「今日の実データ」だけを根拠に、今日この事業を伸ばすための"実行チェックリスト"を作ってください。

【最重要】毎日同じ内容にしない。今日の数字から今日一番のボトルネックを自分で特定し、そこに重み付けした構成にすること。
例: 供給(ライブ店)が薄い日は休眠店の叩き起こしを最優先(must)に。逆に供給が十分なら需要喚起(Push/SNS)や不調カテゴリの是正に寄せる。
販売率が低いカテゴリがあれば「そのカテゴリの出品数を絞る/価格を見直す」等の具体アクションを入れる。登録→購入率が低ければ新規の初回購入を促す施策を厚く。曜日も加味する(週末は在庫予告、平日夜は帰宅前Push等)。

【厳守】
- データに無い店名・数字を創作しない。店名を出す時は渡された「今ライブの店」「休眠店」リストの名前だけを使う。
- 各項目は具体的で、読んだ人がすぐ動ける手順(steps)にする。抽象論禁止。
- template(コピペ文面)を付ける場合、実店名・実価格・実在庫を差し込む。
- Push配信やDB操作の"実行ボタン"は無い(実行は別の管理画面)。チェックリストは「何をどうやるか」の指示に徹する。

【出力形式】必ず次のJSONのみを返す(前後に文章を付けない):
{"items":[{"id":"英数字スラッグ","category":"supply|reengage|instagram|threads|community|ops","timeSlot":"morning|midday|afternoon|evening|night","title":"絵文字付き短いタイトル","priority":"must|high|normal","estMinutes":整数,"reason":"なぜ今日これをやるか(必ず今日の実数字を引用)","kpi":"今日の合格ライン","steps":["手順1","手順2"],"targets":[{"label":"店名","sub":"補足"}],"template":"コピペ文面(任意)","bestTime":"推奨時間帯"}]}
項目数は6〜9個。targetsとtemplateとbestTimeは任意(不要なら省略)。日本語、口調は簡潔でよい。`;

// AI応答(JSON)を検証して ChecklistItem[] に変換。 壊れてたら null を返す(=フォールバック)。
function coerceChecklistItems(raw: unknown): ChecklistItem[] | null {
  const obj = raw as { items?: unknown };
  const arr = Array.isArray(obj?.items) ? obj.items : Array.isArray(raw) ? (raw as unknown[]) : null;
  if (!arr || arr.length === 0) return null;
  const out: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") continue;
    const category = (CHECKLIST_CATEGORIES as readonly string[]).includes(r.category as string) ? (r.category as ChecklistItem["category"]) : "ops";
    const timeSlot = (CHECKLIST_SLOTS as readonly string[]).includes(r.timeSlot as string) ? (r.timeSlot as TimeSlot) : "midday";
    const priority = (CHECKLIST_PRIORITIES as readonly string[]).includes(r.priority as string) ? (r.priority as ChecklistItem["priority"]) : "normal";
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    const reason = typeof r.reason === "string" ? r.reason.trim() : "";
    const steps = Array.isArray(r.steps) ? r.steps.filter((s) => typeof s === "string" && s.trim()).map((s) => String(s).trim()) : [];
    if (!title || steps.length === 0) continue; // タイトルor手順が無い項目は捨てる
    let id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 40) : `ai_${i}`;
    if (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    const targets = Array.isArray(r.targets)
      ? r.targets.filter((t) => t && typeof (t as any).label === "string").map((t) => ({ label: String((t as any).label).slice(0, 80), sub: typeof (t as any).sub === "string" ? String((t as any).sub).slice(0, 120) : undefined })).slice(0, 8)
      : undefined;
    out.push({
      id, category, timeSlot, title: title.slice(0, 120), priority,
      estMinutes: Number.isFinite(Number(r.estMinutes)) ? Math.max(1, Math.min(120, Math.round(Number(r.estMinutes)))) : 10,
      reason: reason.slice(0, 600),
      kpi: typeof r.kpi === "string" && r.kpi.trim() ? r.kpi.trim().slice(0, 160) : undefined,
      steps: steps.slice(0, 8),
      targets: targets && targets.length ? targets : undefined,
      template: typeof r.template === "string" && r.template.trim() ? r.template.trim().slice(0, 1200) : undefined,
      bestTime: typeof r.bestTime === "string" && r.bestTime.trim() ? r.bestTime.trim().slice(0, 80) : undefined,
    });
  }
  if (out.length < 4) return null; // 少なすぎ＝分析失敗とみなしフォールバック
  out.sort((a, b) => SLOT_RANK[a.timeSlot] - SLOT_RANK[b.timeSlot]);
  return out;
}

/**
 * その日の実データを AI が分析して作る動的チェックリスト。
 *   キー未設定 or 失敗時は固定テンプレ(buildDailyChecklist)にフォールバック。
 */
export async function buildDailyChecklistAI(
  growth: GrowthData,
  appstore: AppStoreMetrics,
  sales: SalesForecast | null,
): Promise<{ items: ChecklistItem[]; source: "ai" | "template" }> {
  const hasKey = !!(process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  if (!hasKey) return { items: buildDailyChecklist(growth, appstore), source: "template" };
  try {
    const dump = checklistDataDump(growth, appstore, sales);
    const completion = await checklistOpenai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHECKLIST_SYSTEM },
        { role: "user", content: `＝＝＝ 今日の実データ ＝＝＝\n${dump}\n＝＝＝\n上のデータだけを根拠に、今日の実行チェックリストをJSONで返して。` },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "";
    const parsed = coerceChecklistItems(JSON.parse(content));
    if (parsed) return { items: parsed, source: "ai" };
    console.warn("[checklist-ai] JSON検証に失敗→テンプレにフォールバック");
  } catch (err: any) {
    console.error("[checklist-ai] 生成失敗→テンプレにフォールバック:", err?.message ?? err);
  }
  return { items: buildDailyChecklist(growth, appstore), source: "template" };
}
