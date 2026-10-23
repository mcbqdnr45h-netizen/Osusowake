# syntax=docker/dockerfile:1
# おすそわけ — Fly.io 用 Dockerfile（単一オリジン: SPA + API を1イメージで配信）
# build context は monorepo ルート（pnpm workspace 全体が必要）。
#   - builder: workspace を install → フロント(rescueat) と API(api-server) をビルド
#   - runtime: api-server の本番依存(/prod) + rescueat の静的成果物(/app/public) を1プロセス配信
# api-server(app.ts) は STATIC_DIR が指すディレクトリを express.static で配信し、
# /api 以外の GET は index.html へフォールバックする（SPA ルーティング）。

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:24.22.1-slim AS builder
# native モジュール(sharp 等)の install script 用ビルドツール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app
COPY . .
ENV CI=true
RUN pnpm install --frozen-lockfile

# ── フロントのビルド時公開設定 ─────────────────────────────────────────────────
# すべてクライアント JS に焼き込まれる「公開値」。リポジトリ/イメージに焼いて安全。
# （Stripe publishable key・Maps key・Supabase anon key はいずれも公開鍵）
# 本番と同値をデフォルトに固定 → `flyctl deploy` で build-arg 未指定でも正しい bundle になる。
# 値を変える時は `flyctl deploy --build-arg VITE_XXX=...` で上書き可能。
ARG VITE_SUPABASE_URL=https://dqybzbsdqpbfpimapnwx.supabase.co
ARG VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxeWJ6YnNkcXBiZnBpbWFwbnd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTcyMzgsImV4cCI6MjA4OTY3MzIzOH0.oEZDaDldnTJ190VRt7hsbrypwQ05RaI1OUhQOLjO6pc
ARG VITE_API_BASE=
ARG VITE_MAPS_API_KEY=AIzaSyBBrxGOOK9Ob_ie7wRn8sw8NFNVBa_WVwY
ARG VITE_GOOGLE_MAP_ID=6e0130660ca9e4014cd00116
ARG VITE_STRIPE_PK=pk_live_51TCspv2dGOazl8RiQ1qqScKCjyQEaYxFTVf5lI5gYJkIPuKMwLI81T4q5FV8sVKzT12LoilMhM15gOGknbg8alrs00c8uepepr

# vite.config.ts は process.env から Maps/Stripe 公開鍵を読む（define）
ENV VITE_MAPS_API_KEY=$VITE_MAPS_API_KEY
ENV STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PK
# app コードは import.meta.env を読む → vite が .env.production から注入
RUN printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_ANON_KEY=%s\nVITE_API_BASE=%s\nVITE_GOOGLE_MAP_ID=%s\n' \
      "$VITE_SUPABASE_URL" "$VITE_SUPABASE_ANON_KEY" "$VITE_API_BASE" "$VITE_GOOGLE_MAP_ID" \
      > artifacts/rescueat/.env.production

RUN pnpm --filter @workspace/rescueat build
RUN pnpm --filter @workspace/api-server build
# api-server の本番依存と成果物を /prod に切り出す（pnpm v10 の deploy は --legacy 必須）
RUN pnpm --filter=@workspace/api-server deploy --prod --legacy /prod

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24.22.1-slim AS runtime
# 外向き TLS(Supabase/Stripe/APNs) 用の証明書
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# app.ts がこのディレクトリを SPA 静的配信のルートにする
ENV STATIC_DIR=/app/public
WORKDIR /app
COPY --from=builder /prod ./
COPY --from=builder /app/artifacts/rescueat/dist/public ./public
EXPOSE 8080
CMD ["node", "dist/index.cjs"]
