# おすそわけ 全体チェック結果 & 改善実装計画（2026-07-23）

マロ外出中に実施した全体監査。**コードは未変更**（CLAUDE.md: 計画承認までコードを書かない）。
各項目は実測値つき。承認くれたら上から順に実装する。
※ 既存 `plan.md`（6/15 定期出品の計画書）は消さずに残してある。

---

## ✅ 健全性チェック（問題なし）

| 項目 | 結果 |
|---|---|
| 型チェック（全8パッケージ） | EXIT=0 |
| ビルド（全パッケージ） | EXIT=0 |
| 本番 healthz / SPA / API | 200 / 200 / 200 |
| 管理API 未認証アクセス | 401（正しく拒否） |
| robots.txt / sitemap.xml | 200 / 200 |
| セキュリティヘッダ | HSTS preload・nosniff・referrer-policy 有／x-powered-by 無 |
| COOP/XFO の出し分け | SPAは除去・APIは付与（Stripe対応で意図通り） |
| API応答時間 | /bags 0.226s・/stores 0.214s・/settings 0.267s |
| 定期出品エンジン | ✅ 今朝 JST 07:00・08:00 に自動公開成功を実データで確認 |
| 溜まってた機能の本番反映 | メール変更・売上内訳・まちポケ高槻・3状態バナー・通知トグル・公開出品API **全部反映済** |
| 出品画像のリンク切れ | 4件とも200・正常JPEG（切れなし） |

**結論: 壊れているものは無い。以下は「もっと良くできる」改善点。**

---

## 🔴 A. 商品画像が原寸配信 ＝ 最大の無駄（最優先）

### 実測
Supabase Storage の画像を**リサイズせず原寸で**配信し、スマホの約160px枠に表示している。

| 店 | 原寸 | width=400,q=75 | 削減 |
|---|---|---|---|
| 炒飯専門店91kuppin | 169KB | 34KB | -79% |
| 松村製麺所 | 314KB | 50KB | -83% |
| Taps BURGER SHOP | 311KB | 58KB | -81% |
| 桜坂ラーメン | 536KB | 89KB | -83% |
| **合計（出品4件）** | **1332KB** | **234KB** | **-1.1MB / -82%** |

**出品4件でこれ**。供給が20件に増えれば約5MB、50件なら約13MBの無駄になる＝**供給が増えるほど悪化する**。
モバイル回線の初回表示速度に直撃し、直帰率＝機会損失に直結。

### 検証済みの事実
- Supabase の画像変換エンドポイントは**この本番プロジェクトで有効**（`/render/image/public/` が200を返すことを実測）。
- URL書き換えだけで効く: `/object/public/` → `/render/image/public/` ＋ `?width=N&quality=75`

### 実装案
1. `lib/image-utils.ts` を新設し `optimizedImage(url, width)` を追加
   - Supabase Storage の URL のときだけ書き換え、それ以外（Unsplashフォールバック等）は素通し
   - `url` が空/未定義なら素通し
2. 適用箇所（トラフィックの大きい順）
   - `components/BagCard.tsx:337-339`（発見グリッド＝最重要の絞り所。ここ1箇所で大半をカバー）
   - `pages/SearchPage.tsx:220, 382`
   - `components/StoreSelector.tsx:94` / `pages/MyReservations.tsx:388` / `pages/Orders.tsx:687`
3. 幅の指定: グリッドサムネ=400、詳細ヘッダ=800、アイコン=100

### リスク / 注意
- 低リスク（URL書き換えのみ・失敗時は元URLにフォールバック可能）
- ⚠️ **コスト確認要**: Supabase の画像変換は有料プランで「変換元画像数」課金の場合あり。
  マロが Supabase の料金プランを確認してから本適用するのが安全。
  もし課金が嫌なら代替案＝**アップロード時にリサイズして保存**（`upload` 経路で sharp 圧縮）。

---

## 🟡 B. 店舗オーナー専用コードを全ユーザーに配信

### 実測
未ログイン／一般客の初回訪問でも、店主しか使わないチャンクを **240KB(gzip)** ダウンロードしている。
（エントリ本体が464KB gzip なので **+52%** の上乗せ）

| チャンク | gzip |
|---|---|
| BarChart（売上グラフ） | 140KB |
| StoreDashboard | 34KB |
| BagManageCard | 21KB |
| StoreOwnerDashboard | 11KB |
| Orders / BagPreviewSheet / StoreBagsPage / StoreSalesPage 他 | 34KB |

### 原因（特定済み）
`artifacts/rescueat/src/App.tsx:201-212`
起動1.5秒後の `setTimeout` で店舗系チャンクを**ロール判定なしで無条件**プリフェッチしている。

### 実装案
既存の認証キャッシュを使い、**過去に店主と確認できたブラウザだけ**プリフェッチする。

```ts
// App.tsx（判定ソースは AuthContext と同じキー。変えるなら両方直す）
const __isStoreOwnerBrowser = (): boolean => {
  try {
    if (sessionStorage.getItem('osusowake_pending_store_owner_v1') === '1') return true;
    const raw = localStorage.getItem('osusowake_profile_cache_v1');
    return !!raw && (JSON.parse(raw) as { role?: string })?.role === 'store_owner';
  } catch { return false; }
};
```
`setTimeout(...)` の先頭で `if (!__isStoreOwnerBrowser()) return;`

### 影響
- 店主: 2回目以降は今まで通り先読み（体感不変）。初回ログイン時だけ都度ロード（1回のみ）
- 一般客/未ログイン: **240KB 削減**
- リスク: 低

---

## 🟡 C. 本番にデバッグログが出っぱなし

### 実測
本番コンソールに `[auth] event=INITIAL_SESSION hasSession=false hasUser=false` `[Layout] nav decision` `[SW] registered` が出力される。
フロントに `console.log` が **23箇所**、うち `lib/push-debug.ts` `lib/nav-debug.ts` は**デバッグ専用モジュールが本番稼働**。
`vite.config` に `drop_console` 相当の設定なし。

### 実装案
本番ビルドでのみ `console.log` / `console.debug` を除去（`console.error` / `warn` は残す＝障害調査に必要）。
vite の esbuild 設定に `pure: ['console.log','console.debug']` を追加、または該当ログを削除。

### 影響
- 内部状態（認証状態）のコンソール露出を止める／バンドル微減
- リスク: 低

---

## 🟢 D. `/api/settings` が二重取得

`hooks/use-app-settings.ts:31` が react-query ではなく生の `fetch` のため、複数コンポーネントから呼ばれて重複リクエストになっている（実測で初回2回）。
→ react-query 化すれば自動で重複排除。リスク低・効果小。

---

## 🟢 E. Content-Security-Policy 未設定（任意）

他のセキュリティヘッダは良好だが CSP のみ無し。XSS の多層防御として有効。
ただし Stripe / Google Maps / Supabase を許可リスト化する必要があり、雑に入れると決済や地図が壊れる。
→ 導入するなら `Content-Security-Policy-Report-Only` で1週間観測してから本適用を推奨。急ぎではない。

---

## 📊 F. 事業面の所見（コードの話ではない）

現在ライブ出品は **4件 / 4店舗**（炒飯専門店91kuppin・松村製麺所・Taps BURGER SHOP・桜坂ラーメン）。
定期出品エンジンは正常に動いているので、**技術ではなく供給（出品する店の数）が引き続きボトルネック**。
Aの画像最適化は「供給が増えたときに効く先行投資」でもある。

---

## 推奨する実施順

1. **B（店舗チャンク）** — 効果240KB・リスク最小・コスト影響なし → まずこれ
2. **C（デバッグログ）** — 同上、ついでに実施
3. **A（画像最適化）** — 効果最大(-1.1MB)だが **Supabase課金の確認が先**
4. D → E は余裕があれば

**A/B/C をまとめて1回のデプロイで出すのが効率的。**
デプロイは分類器がブロックするのでマロ実行:
```
cd ~/Downloads/Food-Rescue-Map && flyctl deploy --app osusowake-api --remote-only > /tmp/fly-deploy.log 2>&1; echo EXIT=$?
```
