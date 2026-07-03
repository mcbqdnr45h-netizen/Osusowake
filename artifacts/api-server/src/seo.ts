// ── SEO: robots.txt + sitemap.xml ─────────────────────────────────────────────
// SPA フォールバック (app.ts の app.get(/^\/(?!api\/).*/)) が全ての非 /api GET を
// index.html で返すため、これを入れないと /robots.txt も /sitemap.xml も HTML が返り
// クローラが「サイトマップ無し・robots 無し」と判断してしまう。 このルータを SPA
// フォールバックより前にマウントすることで、正しい text/plain・application/xml を返す。
//
// sitemap は静的な公開ルート + 承認済み店舗ページ (/stores/:id) を動的に列挙する。
// 店舗の抽出条件は routes/stores.ts の公開一覧 (GET /stores) と同一 (is_active かつ
// show_on_map もしくは 承認済み+Stripe有効)。
import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

const BASE = "https://osusowakejapan.org";

// 公開・インデックス対象の静的ルート (認証不要・意味のあるコンテンツ)。
// dashboard / checkout / settings 等の非公開・無価値ページは含めない (robots で Disallow)。
const STATIC_ROUTES: { path: string; priority: string; changefreq: string }[] = [
  { path: "/",              priority: "1.0", changefreq: "daily" },
  { path: "/search",        priority: "0.9", changefreq: "daily" },
  { path: "/map",           priority: "0.9", changefreq: "daily" },
  { path: "/get",           priority: "0.7", changefreq: "weekly" },
  { path: "/welcome",       priority: "0.6", changefreq: "monthly" },
  { path: "/register-store",priority: "0.6", changefreq: "monthly" },
  { path: "/help",          priority: "0.5", changefreq: "monthly" },
  { path: "/guide",         priority: "0.5", changefreq: "monthly" },
  { path: "/usage-guide",   priority: "0.5", changefreq: "monthly" },
  { path: "/terms",         priority: "0.3", changefreq: "yearly" },
  { path: "/privacy",       priority: "0.3", changefreq: "yearly" },
  { path: "/merchant-terms",priority: "0.3", changefreq: "yearly" },
  { path: "/tokusho",       priority: "0.3", changefreq: "yearly" },
  { path: "/legal",         priority: "0.3", changefreq: "yearly" },
];

export const seoRouter = Router();

seoRouter.get("/robots.txt", (_req, res) => {
  const body = [
    "User-agent: *",
    "Allow: /",
    // 非公開・認証・決済系はクロール不要 (インデックスさせない)。
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /checkout/",
    "Disallow: /orders",
    "Disallow: /mypage",
    "Disallow: /my-reservations",
    "Disallow: /settings",
    "Disallow: /payment-methods",
    "Disallow: /favorites",
    "Disallow: /store/dashboard",
    "Disallow: /store-dashboard",
    "Disallow: /store/bags",
    "Disallow: /store/sales",
    "Disallow: /store/bank-setup",
    "Disallow: /store/kyc",
    "Disallow: /auth-callback",
    "Disallow: /reset-password",
    "Disallow: /verify-email",
    "",
    `Sitemap: ${BASE}/sitemap.xml`,
    "",
  ].join("\n");
  res.type("text/plain; charset=utf-8").send(body);
});

seoRouter.get("/sitemap.xml", async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  let storeIds: number[] = [];
  try {
    const rows = await db
      .select({ id: storesTable.id })
      .from(storesTable)
      .where(sql`${storesTable.isActive} = true AND (
        coalesce(${storesTable.showOnMap}, false) = true
        OR (${storesTable.status} = 'approved' AND coalesce(${storesTable.stripeChargesEnabled}, false) = true)
      )`);
    storeIds = rows.map((r) => r.id);
  } catch (err) {
    // 店舗が取れなくても静的ルートだけで sitemap は返す (500 にしない)。
    console.error("[sitemap] store query failed:", err);
  }

  const urls: string[] = [];
  for (const r of STATIC_ROUTES) {
    urls.push(
      `  <url><loc>${BASE}${r.path}</loc><lastmod>${today}</lastmod>` +
      `<changefreq>${r.changefreq}</changefreq><priority>${r.priority}</priority></url>`
    );
  }
  for (const id of storeIds) {
    urls.push(
      `  <url><loc>${BASE}/stores/${id}</loc><lastmod>${today}</lastmod>` +
      `<changefreq>daily</changefreq><priority>0.8</priority></url>`
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.join("\n") +
    `\n</urlset>\n`;

  res
    .type("application/xml; charset=utf-8")
    .set("Cache-Control", "public, max-age=3600")
    .send(xml);
});
