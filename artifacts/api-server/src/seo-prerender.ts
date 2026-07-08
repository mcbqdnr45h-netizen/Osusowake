// ── SEO: クローラー向けサーバーサイド本文/メタ注入 (dynamic rendering) ──────────
//
// おすそわけは純CSR(client-side-render)の Vite SPA なので、初回 index.html の
// <body> には実質テキストが無い。Googlebot は JS 実行するとはいえ、初回HTMLに
// タイトル/説明/本文/構造化データが入っていた方が確実にインデックス・スニペット
// 表示・ローカル検索順位で有利になる (特に JS を実行しない SNS/AI 検索 bot 向けの
// OGP/JSON-LD は初回HTMLに無いと成立しない)。
//
// ★ 方針: 「bot の User-Agent の時だけ」index.html を書き換えて返す (dynamic
//   rendering)。実ユーザー・Capacitor WebView は UA が bot でないため、一切
//   変更のかからない素の index.html にフォールスルーする。よってアプリ/Stripe/
//   スプラッシュ/リモートロードには物理的に無影響。
//
// seo.ts (robots/sitemap) と同じく SPA catch-all より前にマウントする。
import fs from "node:fs";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

const BASE = "https://osusowakejapan.org";
const DEFAULT_OG_IMAGE = `${BASE}/opengraph.jpg`;

// ── クローラー判定 ────────────────────────────────────────────────────────────
// 検索エンジン + 主要SNSプレビュー + AI検索 bot を対象にする。実ブラウザ・
// Capacitor WKWebView (UA に "Mobile/… おすそわけ" 等) は一切マッチしない。
const CRAWLER_RE =
  /(googlebot|google-inspectiontool|storebot-google|bingbot|adidxbot|slurp|duckduckbot|baiduspider|yandex(bot)?|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|embedly|pinterest(bot)?|slackbot|slack-imgproxy|vkshare|w3c_validator|whatsapp|applebot|discordbot|telegrambot|line-poker|petalbot|bytespider|ahrefsbot|semrushbot|mj12bot|dotbot|screaming\s?frog|chrome-lighthouse|gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot|claude-web|anthropic-ai|amazonbot|bingpreview)/i;

export function isCrawler(ua: string | undefined): boolean {
  if (!ua) return false;
  return CRAWLER_RE.test(ua);
}

// ── HTML エスケープ (注入する動的テキストは必ず通す) ──────────────────────────
function escapeHtml(s: unknown): string {
  const str = s == null ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON-LD を <script> に安全に埋め込む (</script> や < を無害化)。
function jsonLd(obj: unknown): string {
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

// ── 注入メタの型 ──────────────────────────────────────────────────────────────
interface SeoMeta {
  title: string;
  description: string;
  canonical: string;      // 絶対URL
  ogType: string;         // "website" | "article" | "business.business" 等
  ogImage: string;        // 絶対URL
  jsonLd?: object[];      // 構造化データ (複数可)
  bodyHtml: string;       // #root に注入する実テキスト本文
  noindex?: boolean;      // true の時は robots meta で noindex (非公開店舗等)
}

// ── ホーム (/) — 最優先。サービス説明 + 出店募集導線 (供給がボトルネック) ──────
function homeMeta(): SeoMeta {
  const title =
    "おすそわけ｜フードロス削減サプライズバッグ｜ご近所のお店からおトクにシェア";
  const description =
    "おすそわけは、飲食店の閉店前に余ったおいしい食品を「サプライズバッグ」としておトクに受け取れるフードロス削減アプリ。ご近所のパン屋・お惣菜・カフェから、毎日更新されるおすそわけバッグをお得な価格でゲット。飲食店の出店(無料)も募集中です。";
  return {
    title,
    description,
    canonical: `${BASE}/`,
    ogType: "website",
    ogImage: DEFAULT_OG_IMAGE,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "おすそわけ",
        url: BASE,
        logo: `${BASE}/images/logo.jpg`,
        description,
        sameAs: [],
      },
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "おすそわけ",
        url: BASE,
        inLanguage: "ja-JP",
        potentialAction: {
          "@type": "SearchAction",
          target: `${BASE}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      },
    ],
    bodyHtml: `
      <main>
        <h1>おすそわけ ─ ご近所のお店からフードロスをおトクにシェア</h1>
        <p>おすそわけは、飲食店やパン屋・お惣菜店・カフェで、その日に売り切れずに残ったおいしい食品を「サプライズバッグ」としておトクな価格で受け取れる、フードロス削減マーケットプレイスです。まだ食べられるのに廃棄されてしまう食品を、お客さんとお店で無理なくシェアします。</p>
        <h2>おすそわけの使い方</h2>
        <ol>
          <li>アプリやウェブでお近くのお店のサプライズバッグを探す</li>
          <li>好きなバッグを予約・お支払い</li>
          <li>お店の受取時間に取りに行く</li>
        </ol>
        <p>毎日新しいおすそわけバッグが登録されます。<a href="/search">サプライズバッグを探す</a> ／ <a href="/map">地図でお店を探す</a> ／ <a href="/guide">使い方ガイド</a></p>
        <h2>飲食店・お店を営む方へ ─ 出店募集中</h2>
        <p>おすそわけでは、フードロスを減らしながら売上につなげたい飲食店・小売店を募集しています。出店・掲載は無料。売れ残りそうな商品をサプライズバッグとして登録するだけで、新しいお客さんとの出会いが生まれます。<a href="/register-store">お店を登録する（出店のご案内）</a></p>
      </main>
    `,
  };
}

// ── 静的コンテンツページ (title/description/最小本文) ─────────────────────────
const STATIC_CONTENT: Record<string, { title: string; description: string; h1: string; body: string }> = {
  "/search": {
    title: "サプライズバッグを探す｜おすそわけ",
    description: "お近くのお店のおトクなサプライズバッグを探そう。毎日更新されるおすそわけバッグでフードロス削減。",
    h1: "サプライズバッグを探す",
    body: "お近くの飲食店・パン屋・お惣菜店から、その日のおすそわけバッグをおトクな価格で予約できます。",
  },
  "/map": {
    title: "地図でお店を探す｜おすそわけ",
    description: "地図からお近くのおすそわけ対応店を探そう。フードロス削減サプライズバッグを販売中のお店を表示。",
    h1: "地図でお店を探す",
    body: "地図上でお近くのおすそわけ対応店を探せます。現在地周辺のサプライズバッグを見つけましょう。",
  },
  "/get": {
    title: "アプリを入手｜おすそわけ",
    description: "おすそわけアプリをダウンロードして、ご近所のフードロス削減サプライズバッグをおトクにゲット。",
    h1: "おすそわけアプリを入手",
    body: "iOS / Android でおすそわけをご利用いただけます。ご近所のお店のサプライズバッグをおトクに。",
  },
  "/register-store": {
    title: "お店を登録する（出店のご案内）｜おすそわけ",
    description: "飲食店・小売店の出店募集。フードロスを減らしながら売上に。掲載無料でサプライズバッグを販売できます。",
    h1: "おすそわけに出店しませんか",
    body: "売れ残りそうな商品をサプライズバッグとして登録するだけ。掲載無料で、フードロス削減と新規顧客の獲得を両立できます。",
  },
  "/guide": {
    title: "使い方ガイド｜おすそわけ",
    description: "おすそわけの使い方をわかりやすく解説。サプライズバッグの探し方・予約・受け取りまで。",
    h1: "おすそわけ 使い方ガイド",
    body: "サプライズバッグの探し方から予約・お支払い・お店での受け取りまで、おすそわけの使い方をご案内します。",
  },
  "/usage-guide": {
    title: "使い方ガイド｜おすそわけ",
    description: "おすそわけの使い方をわかりやすく解説。サプライズバッグの探し方・予約・受け取りまで。",
    h1: "おすそわけ 使い方ガイド",
    body: "サプライズバッグの探し方から予約・お支払い・お店での受け取りまで、おすそわけの使い方をご案内します。",
  },
  "/help": {
    title: "ヘルプ・よくある質問｜おすそわけ",
    description: "おすそわけのよくある質問とヘルプ。予約・お支払い・受け取りに関するご案内。",
    h1: "ヘルプ・よくある質問",
    body: "おすそわけのご利用に関するよくある質問とサポート情報をまとめています。",
  },
  "/welcome": {
    title: "ようこそ｜おすそわけ",
    description: "おすそわけへようこそ。ご近所のお店からフードロス削減サプライズバッグをおトクにシェア。",
    h1: "おすそわけへようこそ",
    body: "ご近所のお店から、まだ食べられるおいしい食品をおトクな価格でおすそわけ。",
  },
  "/terms": {
    title: "利用規約｜おすそわけ",
    description: "おすそわけの利用規約。",
    h1: "利用規約",
    body: "おすそわけサービスの利用規約です。",
  },
  "/privacy": {
    title: "プライバシーポリシー｜おすそわけ",
    description: "おすそわけのプライバシーポリシー。",
    h1: "プライバシーポリシー",
    body: "おすそわけにおける個人情報の取り扱いについて。",
  },
  "/merchant-terms": {
    title: "出店規約｜おすそわけ",
    description: "おすそわけの出店(店舗)向け規約。",
    h1: "出店規約",
    body: "おすそわけに出店される店舗向けの規約です。",
  },
  "/tokusho": {
    title: "特定商取引法に基づく表記｜おすそわけ",
    description: "おすそわけの特定商取引法に基づく表記。",
    h1: "特定商取引法に基づく表記",
    body: "特定商取引法に基づく表記を掲載しています。",
  },
  "/legal": {
    title: "法的情報｜おすそわけ",
    description: "おすそわけの法的情報。",
    h1: "法的情報",
    body: "おすそわけに関する法的情報を掲載しています。",
  },
};

function staticMeta(path: string): SeoMeta | null {
  const c = STATIC_CONTENT[path];
  if (!c) return null;
  return {
    title: c.title,
    description: c.description,
    canonical: `${BASE}${path}`,
    ogType: "website",
    ogImage: DEFAULT_OG_IMAGE,
    bodyHtml: `<main><h1>${escapeHtml(c.h1)}</h1><p>${escapeHtml(c.body)}</p><p><a href="/">おすそわけ トップへ</a></p></main>`,
  };
}

// ── 店舗詳細 (/stores/:id) — ローカル検索の本命 ───────────────────────────────
type PublicStoreRow = {
  id: number;
  name: string | null;
  description: string | null;
  address: string | null;
  city: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
  imageUrl: string | null;
  openTime: string | null;
  closeTime: string | null;
  rating: number | null;
};

async function storeMeta(idRaw: string): Promise<SeoMeta | null> {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return null;

  let row: PublicStoreRow | undefined;
  try {
    // sitemap と同一の可視条件 (is_active かつ 地図表示 もしくは 承認+Stripe有効)。
    const rows = await db
      .select({
        id: storesTable.id,
        name: storesTable.name,
        description: storesTable.description,
        address: storesTable.address,
        city: storesTable.city,
        category: storesTable.category,
        lat: storesTable.lat,
        lng: storesTable.lng,
        imageUrl: sql<string | null>`CASE WHEN ${storesTable.imageUrl} LIKE 'data:%' OR ${storesTable.imageUrl} IS NULL THEN CASE WHEN ${storesTable.iconUrl} LIKE 'data:%' THEN NULL ELSE ${storesTable.iconUrl} END ELSE ${storesTable.imageUrl} END`,
        openTime: storesTable.openTime,
        closeTime: storesTable.closeTime,
        rating: storesTable.rating,
      })
      .from(storesTable)
      .where(sql`${storesTable.id} = ${id} AND ${storesTable.isActive} = true AND (
        coalesce(${storesTable.showOnMap}, false) = true
        OR (${storesTable.status} = 'approved' AND coalesce(${storesTable.stripeChargesEnabled}, false) = true)
      )`)
      .limit(1);
    row = rows[0] as PublicStoreRow | undefined;
  } catch (err) {
    console.error("[seo-prerender] store query failed:", err);
    return null; // DB エラー時は素の SPA にフォールバック
  }

  if (!row || !row.name) return null; // 非公開/存在しない → 素の SPA

  const name = row.name;
  const cityPart = row.city ? `${row.city}の` : "";
  const catPart = row.category ? `${row.category}・` : "";
  const title = `${name}｜${row.city ? row.city + "の" : ""}おすそわけ サプライズバッグ`;
  const descBase = row.description && row.description.trim().length > 0
    ? row.description.trim()
    : `${cityPart}${catPart}おすそわけ対応店。まだ食べられるおいしい食品を、サプライズバッグとしておトクな価格でご用意しています。`;
  const description = descBase.slice(0, 120);

  const hours =
    row.openTime && row.closeTime ? `${row.openTime}〜${row.closeTime}` : "";

  // JSON-LD: LocalBusiness/Restaurant。住所・座標・営業時間・評価を含める。
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name,
    url: `${BASE}/stores/${row.id}`,
    description,
  };
  if (row.imageUrl) ld.image = row.imageUrl.startsWith("http") ? row.imageUrl : `${BASE}${row.imageUrl}`;
  if (row.category) ld.servesCuisine = row.category;
  if (row.address) {
    ld.address = {
      "@type": "PostalAddress",
      streetAddress: row.address,
      addressLocality: row.city ?? undefined,
      addressCountry: "JP",
    };
  }
  if (row.lat != null && row.lng != null) {
    ld.geo = { "@type": "GeoCoordinates", latitude: row.lat, longitude: row.lng };
  }
  if (hours) ld.openingHours = hours;
  if (row.rating != null && row.rating > 0) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: row.rating,
      bestRating: 5,
    };
  }

  const body = `
    <main>
      <h1>${escapeHtml(name)}</h1>
      ${row.category ? `<p>カテゴリ: ${escapeHtml(row.category)}</p>` : ""}
      ${row.address ? `<p>住所: ${escapeHtml(row.address)}</p>` : ""}
      ${hours ? `<p>営業時間: ${escapeHtml(hours)}</p>` : ""}
      <p>${escapeHtml(descBase)}</p>
      <p>${escapeHtml(name)}のサプライズバッグをおすそわけで予約できます。フードロス削減にご協力を。</p>
      <p><a href="/search">他のお店のサプライズバッグを探す</a> ／ <a href="/">おすそわけ トップへ</a></p>
    </main>
  `;

  return {
    title,
    description,
    canonical: `${BASE}/stores/${row.id}`,
    ogType: "business.business",
    ogImage: (ld.image as string) ?? DEFAULT_OG_IMAGE,
    jsonLd: [ld],
    bodyHtml: body,
  };
}

// ── path → SeoMeta 解決 ──────────────────────────────────────────────────────
async function resolveSeoForPath(rawPath: string): Promise<SeoMeta | null> {
  // クエリ/末尾スラッシュを正規化
  const path = rawPath.replace(/\/+$/, "") || "/";

  if (path === "/") return homeMeta();

  const storeMatch = path.match(/^\/stores\/([^/]+)$/);
  if (storeMatch) return storeMeta(storeMatch[1]);

  return staticMeta(path);
}

// ── index.html への注入 ───────────────────────────────────────────────────────
function injectSeo(template: string, meta: SeoMeta): string {
  let html = template;

  // <title>
  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(meta.title)}</title>`
  );

  // <meta name="description">
  html = html.replace(
    /<meta\s+name="description"[^>]*>/i,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`
  );

  // OGP (既存の og:title / og:description / og:type / og:image を差し替え)
  html = html
    .replace(/<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${escapeHtml(meta.title)}" />`)
    .replace(/<meta\s+property="og:description"[^>]*>/i, `<meta property="og:description" content="${escapeHtml(meta.description)}" />`)
    .replace(/<meta\s+property="og:type"[^>]*>/i, `<meta property="og:type" content="${escapeHtml(meta.ogType)}" />`)
    .replace(/<meta\s+property="og:image"[^>]*>/i, `<meta property="og:image" content="${escapeHtml(meta.ogImage)}" />`);

  // </head> の直前に canonical / og:url / twitter card / robots / JSON-LD を追加
  const headExtra = [
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}" />`,
    meta.noindex ? `<meta name="robots" content="noindex,follow" />` : ``,
    ...(meta.jsonLd ?? []).map((o) => jsonLd(o)),
  ].filter(Boolean).join("\n    ");

  html = html.replace(/<\/head>/i, `    ${headExtra}\n  </head>`);

  // #root に実テキスト本文を注入 (createRoot が JS 描画時に置換するので実ユーザー影響なし。
  //   ここに来るのは bot のみ)。
  html = html.replace(
    /<div id="root">\s*<\/div>/i,
    `<div id="root">${meta.bodyHtml}</div>`
  );

  // ★ クローラー向けには SPA エントリ (module script) を除去する。
  //   これを残すと Googlebot が JS を実行 → React (createRoot) が #root を再描画し、
  //   上で注入した本文を消して「空の #root」= レンダリング後DOMが実質空になり、
  //   Google に「ソフト 404」と判定されてインデックス不可になる (2026-07-08 GSC
  //   ライブテストで /stores/138 が「ソフト404」となり実測確認)。
  //   module script を外せば注入本文が最終DOMにそのまま残り、確実にクロール・
  //   インデックスされる (= 本来やりたい prerender と等価)。 インライン script
  //   (スプラッシュ制御 / SW 登録) は type=module ではないので影響を受けない。
  //   ※ この分岐に来るのは bot UA のみ。実ユーザー・Capacitor WebView は素の
  //     index.html (module script 込み) を受け取るので SPA 起動には一切無影響。
  html = html.replace(
    /<script\b[^>]*\btype=["']module["'][^>]*>\s*<\/script>/gi,
    ""
  );

  return html;
}

// ── Express ミドルウェア ──────────────────────────────────────────────────────
// STATIC_DIR ブロック内 (indexPath 確定後)、SPA catch-all の直前にマウントする。
export function createCrawlerSeoMiddleware(indexPath: string) {
  let template: string | null = null;
  const loadTemplate = (): string => {
    if (template == null) template = fs.readFileSync(indexPath, "utf8");
    return template;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // GET 以外・非 bot・/api/* は対象外 (catch-all / static に委ねる)。
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) return next();
    if (!isCrawler(req.headers["user-agent"])) return next();

    let meta: SeoMeta | null = null;
    try {
      meta = await resolveSeoForPath(req.path);
    } catch (err) {
      console.error("[seo-prerender] resolve failed:", err);
      return next();
    }
    if (!meta) return next(); // SEO 対象外ルート → 素の SPA

    try {
      const out = injectSeo(loadTemplate(), meta);
      res
        .type("text/html; charset=utf-8")
        .set("Cache-Control", "public, max-age=600")
        .send(out);
    } catch (err) {
      console.error("[seo-prerender] inject failed:", err);
      return next();
    }
  };
}
