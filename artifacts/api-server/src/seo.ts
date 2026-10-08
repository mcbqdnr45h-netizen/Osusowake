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

// ── ストア誘導の短縮リンク (2026-08-05) ───────────────────────────────────
// Google Play / App Store の正式URLにはパッケージ名(com.yuhi.osusowake)が
// 露出する。パッケージ名は公開後に変更できないため、自ドメインの短い
// リンクを入口にして、実URLをユーザーの目に触れさせない。
//   /app     … 端末を判定して自動振り分け（LINE・SNSに貼るのはこれ1本でよい）
//   /android … Google Play
//   /ios     … App Store
const PLAY_URL  = "https://play.google.com/store/apps/details?id=com.yuhi.osusowake";
const APPLE_URL = "https://apps.apple.com/jp/app/%E3%81%8A%E3%81%99%E3%81%9D%E3%82%8F%E3%81%91/id6763268307";

seoRouter.get("/android", (_req, res) => res.redirect(302, PLAY_URL));
seoRouter.get("/ios",     (_req, res) => res.redirect(302, APPLE_URL));

// ★ Instagram / Facebook / X などの「アプリ内ブラウザ」対策 (2026-08-05)
//   iOSでApp StoreのURLへ自動リダイレクトすると、Appleが最後に
//   itms-appss:// (App Storeアプリを開く独自スキーム) へ301で飛ばす。
//   アプリ内ブラウザはこのスキームを【自動リダイレクトでは開けない】ため、
//   真っ白のまま固まる(マロがInstagramのプロフィールリンクで踏んだ現象)。
//   → アプリ内ブラウザの時だけ、その場で表示できる軽量ページを返し、
//     「ユーザーのタップ」でストアへ渡す。タップ操作ならiOSがアプリを開ける。
// ※ LINEは itms-appss:// を正しく開けるので対象外（従来どおり即リダイレクトさせる）
const IN_APP_BROWSER = /Instagram|FBAN|FBAV|FB_IAB|Twitter|TikTok|KAKAOTALK|micromessenger/i;

// iOS × アプリ内ブラウザ(Instagram等)の最終形 (2026-08-05)
//   実機検証の結果、Instagramの内蔵ブラウザは
//     ・https://apps.apple.com/... → Appleが itms-appss:// へ301 → 白画面で停止
//     ・itms-apps:// / x-safari-https:// → 独自スキームなのでタップしても【無反応】
//   つまりアプリ内ブラウザからApp Storeへ渡す方法が無い。
//   → 「Safariで開き直してもらう」しか確実な道がないため、
//      リンクのコピーと手順の提示を主役にする。
const APPLE_ID = "6763268307";

function storePage(primary: "ios" | "android"): string {
  if (primary === "android") {
    return shell(`
      <a href="${PLAY_URL}" class="b main">Google Play でひらく</a>
      <a href="${APPLE_URL}" class="b sub">iPhone の方はこちら</a>`);
  }
  // ★ iOS × Instagram等: App Storeへ渡す手段が【一つも無い】ことを実機で確認済み。
  //   押すと白画面で固まるボタンは置かず、Safariへ逃がすことだけに集中させる。
  return shell(`
    <div class="steps">
      <p class="st">iPhoneの方は Safari で開いてください</p>
      <ol>
        <li>この画面の <b>右上の「…」</b> をタップ</li>
        <li><b>「Safariで開く」</b>（または「外部ブラウザで開く」）を選ぶ</li>
      </ol>
      <p class="stn">Safariで開くと、自動でApp Storeが立ち上がります。</p>
    </div>
    <button id="cp" class="b main" type="button">リンクをコピーする</button>
    <p class="note">コピーしてSafariのアドレス欄に貼り付けてもOKです。</p>
    <a href="${PLAY_URL}" class="b sub">Android の方はこちら</a>
    <script>
    (function(){
      var b=document.getElementById('cp'), u='https://osusowakejapan.org/ios';
      b.addEventListener('click', function(){
        var done=function(){ b.textContent='コピーしました！Safariに貼り付けてください'; };
        function fallback(){
          var t=document.createElement('textarea'); t.value=u;
          t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t);
          t.select(); try{ document.execCommand('copy'); done(); }catch(e){ b.textContent=u; }
          document.body.removeChild(t);
        }
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(u).then(done, fallback);
        } else { fallback(); }
      });
    })();
    </script>`);
}

function shell(inner: string): string {
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>おすそわけ｜アプリをダウンロード</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#FBF8F4;color:#2A2623;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
.w{width:100%;max-width:380px;text-align:center}
.logo{font-size:30px;font-weight:900;letter-spacing:.02em;margin-bottom:6px;color:#E8786C}
.lead{font-size:14px;color:#8A7E79;line-height:1.7;margin-bottom:24px}
.b{display:block;width:100%;padding:17px 16px;border-radius:16px;font-weight:800;font-size:16px;
text-decoration:none;margin-bottom:12px;border:0;font-family:inherit;-webkit-tap-highlight-color:transparent}
.main{background:#E8786C;color:#fff;box-shadow:0 6px 18px rgba(232,120,108,.32)}
.main:active{transform:scale(.985)}
.sub{background:#fff;color:#2A2623;border:1.5px solid #E7E1DA;font-size:14px;padding:14px 16px}
.steps{background:#FFF4F1;border:1px solid #F6DDD7;border-radius:16px;padding:14px 16px;margin:4px 0 14px;text-align:left}
.st{font-size:15px;font-weight:900;color:#C9564A;margin-bottom:10px}
.stn{font-size:12px;color:#8A7E79;margin-top:10px;line-height:1.7}
.steps ol{margin:0;padding-left:1.2em}
.steps li{font-size:14px;color:#4A423E;line-height:2.0}
</style></head><body><div class="w">
<div class="logo">おすそわけ</div>
<p class="lead">まだ食べられるのに捨てられる食品を、<br>おトクにおすそわけ。</p>
${inner}
</div></body></html>`;
}

seoRouter.get("/app", (req, res) => {
  const ua = String(req.headers["user-agent"] ?? "");
  const isAndroid = /android/i.test(ua);
  const isIOS     = /iphone|ipad|ipod/i.test(ua);
  res.set("Cache-Control", "no-store");

  // アプリ内ブラウザ: 自動遷移させず、タップで渡す軽量ページ
  if (IN_APP_BROWSER.test(ua) && (isAndroid || isIOS)) {
    return res.type("html").send(storePage(isAndroid ? "android" : "ios"));
  }
  // 通常のブラウザ: 今まで通り即リダイレクト
  if (isAndroid) return res.redirect(302, PLAY_URL);
  if (isIOS)     return res.redirect(302, APPLE_URL);
  return res.redirect(302, "https://osusowakejapan.org/");
});

// ── アプリとサイトの紐付けファイル (2026-08-12) ───────────────────────────────
// これが無いと、LINEやメールに貼った osusowakejapan.org のリンクを踏んでも
// 【ブラウザが開くだけでアプリが開かない】。SPAのフォールバックがHTMLを返して
// いたため、OS側の検証も失敗し続けていた。
//   Android: /.well-known/assetlinks.json  + AndroidManifest の intent-filter
//   iOS    : /.well-known/apple-app-site-association + Associated Domains
// ※ Android は「Play アプリ署名」を使っているため、ここに載せるべき指紋は
//   Play Console の【アプリ署名鍵証明書 SHA-256】。アップロード鍵とは別物なので、
//   環境変数 ANDROID_CERT_SHA256 で追加できるようにしておく（カンマ区切りで複数可）。
const ANDROID_UPLOAD_SHA256 =
  "C4:0A:30:A4:E1:A3:AE:2D:3B:C4:31:59:F4:5F:36:69:78:EE:18:71:58:CE:A8:9A:44:06:C6:0F:CB:D9:3B:A9";

seoRouter.get("/.well-known/assetlinks.json", (_req, res) => {
  const extra = (process.env["ANDROID_CERT_SHA256"] ?? "")
    .split(",").map(v => v.trim()).filter(Boolean);
  const fingerprints = Array.from(new Set([...extra, ANDROID_UPLOAD_SHA256]));
  res
    .type("application/json")
    .set("Cache-Control", "public, max-age=3600")
    .send(JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.yuhi.osusowake",
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ], null, 2));
});

seoRouter.get("/.well-known/apple-app-site-association", (_req, res) => {
  res
    .type("application/json")
    .set("Cache-Control", "public, max-age=3600")
    .send(JSON.stringify({
      applinks: {
        apps: [],
        details: [
          {
            appID: "24P8637Y9A.com.yuhi.osusowake",
            paths: ["*"],
          },
        ],
      },
    }, null, 2));
});
