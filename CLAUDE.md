# CLAUDE.md — おすそわけ (Food-Rescue-Map)

> 新セッション復帰用の最小ブリーフ。まずこれを読めば即戦力で動ける。
> さらに詳しい経緯は `~/.claude/projects/-Users-satouisamuhi/memory/osusowake-*.md` を参照。

## プロジェクト概要
**おすそわけ = Too Good To Go の日本版**。飲食店が閉店前の余剰食品を「サプライズバッグ」として
安価に販売し、ユーザーが予約・決済できるフードロス削減プラットフォーム。

## 構成スタック
- **iOS**: Capacitor 8。Bundle ID `com.yuhi.osusowake` / Apple Team `24P8637Y9A`。
  **リモートロード方式**（`server.url` = 本番URL を WebView で読む → Web 更新が即反映、App Store 再申請不要）。
- **Web / API**: Vite SPA (`artifacts/rescueat`) + Express (`artifacts/api-server`)。
  Fly app **`osusowake-api`**（region `sin`）で**単一オリジン配信**（Express が `STATIC_DIR` から SPA を配信＋`/api`）。
- **DB**: Supabase PostgreSQL（project ref `dqybzbsdqpbfpimapnwx`）+ Drizzle ORM。接続は Session pooler / 5432。
- **Push**: Web Push (VAPID) + iOS APNs（Key ID `6Z6R988BSK` / Team `24P8637Y9A`、`.p8` は Fly secret）。
- **決済**: Stripe（Connect destination charge、店舗20%手数料 / ユーザー5%）。
  `pk_live` は Fly secret `STRIPE_PUBLISHABLE_KEY` ＋ Dockerfile ARG（`VITE_STRIPE_PK`）に設定済。`sk_live` は Fly secret。
  ※ Checkout は pk を**ランタイムで `/api/stripe/public-config` から取得**する（焼込み値ではない）。
- **monorepo**: pnpm workspace（`artifacts/*` + `lib/*`）。

## 重要URL
| 用途 | URL |
|---|---|
| 本番 | https://osusowakejapan.org |
| API直 / Fly確認 | https://osusowake-api.fly.dev |
| staging | https://staging.osusowakejapan.org（移管後に削除可） |

## 現在の状態（2026-07-02 時点）
- ✅ **Replit → Fly 完全移行済**（apex DNS 切替完了、本番は100% Fly 配信。決済/push/iOS/webhook 稼働確認済）。
- ✅ **B**: 未払い予約の受取ガード（402）+ フロント抑止 / **C**: PWA manifest アイコン（icon-48..512.webp）完了。
- ✅ **#6 Cloudflare 移管完了**（registrar + NS = Cloudflare）。6/22 リマインダー task 削除済。
- ✅ **Replit 解約完了（2026-07-02）＝月額ゼロ化達成**。本番は Replit 非依存（DNS/TLS/mail=Cloudflare+Fly+
  ImprovMX/Resend、cron=Flyプロセス内 setInterval×5、画像/DB=Supabase、code=GitHub、secret=Fly）。
  旧Replit Neon「Production DB」は解約前確認で**全7テーブル空（0行）**＝失うデータ無しを確定済み。

## 注意事項（ハマりポイント・破壊するな）
- **Capacitor `server.url` は `https://osusowakejapan.org/` 固定**。変えると全配信が死ぬ（`artifacts/rescueat/capacitor.config.ts`）。
- **SPA 応答からは helmet の COOP / X-Frame-Options / CORP を除去必須**（無いと Stripe Elements が死ぬ）。
  **API 側の helmet は温存**（CORP cross-origin は Capacitor 用）。実装は `app.ts` の SPA 配信ブロック内ミドルウェア。
- **apex A レコードは `66.241.125.158`（Fly）のみ**（旧 Replit `34.111.179.208` は削除済）。
- **`_acme-challenge` CNAME → `osusowakejapan.org.26xdxqj.flydns.net` は Fly 証明書の自動更新に必須**。
  Cloudflare 移管後も必ず残す＆**DNS only（グレー雲）**にする。apex A も DNS only（orange proxy にしない）。
- **メール系 DNS を移管で絶対落とすな**: 受信 `MX mx1.improvmx.com`（ImprovMX）/ 送信 Resend = `send` サブの
  `MX feedback-smtp.ap-northeast-1.amazonses.com` + `TXT v=spf1 include:amazonses.com ~all` / `resend._domainkey`(DKIM) / `_dmarc`。
  全量は `.local/dns-backup-osusowakejapan-2026-05-23.txt`。
- **`flyctl deploy` は `| tail` 禁止**（pipe が失敗を握り潰す）。必ず `> log 2>&1; echo EXIT=$?` でフルログ＋実exit確認。
- **`--no-cache` 長時間ビルドは Fly ビルダのタイムアウト多発**。通常（キャッシュ利用）の短時間デプロイ推奨。
- auto-mode 安全分類器が本番 app への `flyctl deploy`/`secrets set`/`ssh console` を**断続的にブロック**する。ブロック時はユーザ実行。

## 主要ファイル
- `Dockerfile`（**リポジトリ直下**）— 単一オリジン構成（builder: rescueat+api-server を build / runtime: `/prod` + SPA を `/app/public`、`STATIC_DIR`）。
- `fly.toml`（**リポジトリ直下**）— `min_machines_running = 1`（コールドスタート回避）、PORT 8080、region sin。
- `artifacts/api-server/src/app.ts` — `/api` ルーター + SPA 静的配信 + **SPA応答の COOP/XFO/CORP 除去ミドルウェア**。
- `artifacts/rescueat/capacitor.config.ts` — iOS の `server.url`・`allowNavigation`。
- `artifacts/rescueat/public/icons/` — PWA アイコン（manifest 参照）。
- `.local/dns-backup-osusowakejapan-2026-05-23.txt` — DNS 完全バックアップ（Cloudflare 移管用）。

## デプロイ手順
```sh
cd ~/Downloads/Food-Rescue-Map \
  && flyctl deploy --app osusowake-api --remote-only > /tmp/fly-deploy.log 2>&1; echo "EXIT=$?"
# 確認: tail /tmp/fly-deploy.log でエラー無し & EXIT=0、curl https://osusowake-api.fly.dev/api/healthz
```

## ローカル開発（2プロセス）
```sh
# backend (PORT=3001, artifacts/api-server/.env を dotenv)
cd ~/Downloads/Food-Rescue-Map && pnpm --filter @workspace/api-server dev
# frontend (PORT/BASE_PATH/VITE_MAPS_API_KEY はシェルで渡す)
cd ~/Downloads/Food-Rescue-Map && PORT=5173 BASE_PATH=/ VITE_API_BASE=http://localhost:3001 \
  VITE_MAPS_API_KEY=<key> pnpm --filter @workspace/rescueat dev
```
※ 同名コピーが複数あるため pnpm は必ず `cd ~/Downloads/Food-Rescue-Map` してから。

## 関連 commit
- `705b6ab` Fly 単一オリジン配信（Dockerfile / fly.toml / app.ts COOP除去）
- `83d6b70` 未払い予約の受取ガード（B）
- `f002560` PWA manifest アイコン（C）
