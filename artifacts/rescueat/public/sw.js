// ⚠️ デプロイ時にこの数字を必ず上げること（v4 → v5 → v6 ...）
// バンプしないと iOS / PWA が古いキャッシュを掴み続けます
const CACHE_NAME = 'osusowake-v30';
const BASE = '';

const PRECACHE_URLS = [
  '/',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 画像・フォントなど不変アセットの判定
function isStaticAsset(url) {
  return /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot)$/i.test(url.pathname);
}

// Vite ハッシュ付き JS / CSS の判定（不変なので cache-first で即返す）
// パターン例: /assets/index-DSYVjEJi.js  /assets/Home-Xa3bC1mP.css
function isHashedViteAsset(url) {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|mjs)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  // ── 1. 画像・フォント: cache-first（変わらないので速度優先）─────────────
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, toCache));
          }
          return response;
        });
      })
    );
    return;
  }

  // ── 2. Vite ハッシュ付き JS / CSS: cache-first（ハッシュで不変）──────────
  // ファイル名にハッシュが含まれるため、キャッシュ済みなら常に最新と同一。
  // ネットワークを待たずキャッシュから即返すことで起動白画面を解消する。
  if (isHashedViteAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, toCache));
          }
          return response;
        });
      })
    );
    return;
  }

  // ── 3. その他のスクリプト系（非ハッシュ）: network-first ──────────────────
  // hash なし JS / JSON / map などはキャッシュ汚染を避けるため network-first。
  // SPA fallback で text/html が返ってきた場合はキャッシュしない（MIME bug 防止）。
  const isScriptOrAsset =
    /\.(js|css|mjs|map|json)$/i.test(url.pathname) ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'worker';
  if (isScriptOrAsset) {
    event.respondWith(
      fetch(request).then((response) => {
        const ct = response?.headers?.get?.('content-type') || '';
        if (response && response.status === 200 && response.type !== 'opaque' && !ct.includes('text/html')) {
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, toCache));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // ── 4. HTML ナビゲーション: stale-while-revalidate ───────────────────────
  // 【起動白画面の根本対策】
  //   旧実装 (network-first) では毎回ネットワーク往復を待ってから HTML が届いた。
  //   この間 WKWebView は白い → Capacitor スプラッシュが覆えず白画面になる。
  //
  //   stale-while-revalidate に変更することで:
  //   ① キャッシュ済み HTML を即返す → JS バンドルも即ロード → #__splash が即表示
  //   ② バックグラウンドで最新 HTML をフェッチ → 次回起動時に反映
  //   Vite ハッシュ付き JS/CSS は不変なので stale HTML でも動作する。
  const isNavigation =
    request.mode === 'navigate' || request.destination === 'document';

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);

      // バックグラウンド revalidate（常に実行）
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      // キャッシュがあれば即返す（白画面ゼロ）。
      // キャッシュ未登録の場合のみネットワーク完了を待つ（初回起動）。
      if (cached) {
        // バックグラウンド更新は fire-and-forget
        networkFetch.catch(() => {});
        return cached;
      }

      // キャッシュなし (初回) → ネットワーク待ち。失敗時はオフラインフォールバック。
      const networkResponse = await networkFetch;
      if (networkResponse) return networkResponse;
      if (isNavigation) {
        const fallback = await caches.match('/');
        if (fallback) return fallback;
      }
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    })
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'おすそわけ', body: event.data.text() }; }

  const options = {
    body: payload.body || 'お知らせがあります',
    icon: '/images/logo-192.png',
    badge: '/images/logo-192.png',
    tag: payload.tag || 'osusowake',
    data: { url: payload.url || '/' },
    actions: [
      { action: 'open', title: 'アプリを開く' },
      { action: 'dismiss', title: '閉じる' },
    ],
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'おすそわけ', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      const existing = cls.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
