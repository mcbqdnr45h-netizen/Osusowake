import app from "./app";
import { pool } from "@workspace/db";
import { releaseExpiredCartReservations, cancelStaleUnpaidReservations } from "./routes/reservations";
import { sendPickupReminders } from "./lib/pickup-reminder.js";
import { runDailyEngagementNotifications } from "./lib/daily-engagement.js";
import { publishDueRecurringListings } from "./lib/recurring-publisher.js";
import { remindUnlistedStores } from "./lib/unlisted-store-reminder.js";

// ── 起動時マイグレーション（冪等・全て Supabase PostgreSQL 対象）──────────────
async function runMigrations() {
  const client = await pool.connect();
  try {
    // Supabase の接続で public スキーマが検索パスに含まれるよう設定
    await client.query(`SET search_path TO public, extensions`).catch(() => {});

    // ── store_category enum に新カテゴリを追加 ──────────────────────────────
    await client.query(`ALTER TYPE store_category ADD VALUE IF NOT EXISTS 'meals'`);
    await client.query(`ALTER TYPE store_category ADD VALUE IF NOT EXISTS 'bakery_sweets'`);
    await client.query(`ALTER TYPE store_category ADD VALUE IF NOT EXISTS 'ingredients'`);
    console.log('[migration] store_category enum values ✅');

    // ── surprise_bags.category 列が存在しない場合のみ追加 ────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surprise_bags' AND column_name='category'
        ) THEN
          ALTER TABLE surprise_bags ADD COLUMN category TEXT;
        END IF;
      END $$;
    `);
    console.log('[migration] surprise_bags.category ✅');

    // ── 旧カテゴリ値 → 新3カテゴリへ一括変換（冪等）────────────────────────
    await client.query(`
      UPDATE surprise_bags SET category =
        CASE
          WHEN category IN ('bakery', 'sweets', 'cafe', 'drinks') THEN 'bakery_sweets'
          WHEN category IN ('produce', 'supermarket')              THEN 'ingredients'
          WHEN category IN ('restaurant', 'other', 'convenience', 'meat', 'noodles', 'assorted') THEN 'meals'
        END
      WHERE category IS NOT NULL
        AND category NOT IN ('meals', 'bakery_sweets', 'ingredients');
    `);
    console.log('[migration] category remapping ✅');

    // ── stores.approval_email_sent 列が存在しない場合のみ追加 ─────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stores' AND column_name='approval_email_sent'
        ) THEN
          ALTER TABLE stores ADD COLUMN approval_email_sent BOOLEAN NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
    console.log('[migration] stores.approval_email_sent ✅');

    // ── notifications テーブルが存在しない場合のみ作成 ────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        read        BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id);
    `);
    // ── notifications.store_id 列（複数店舗フィルタ用）────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='notifications' AND column_name='store_id'
        ) THEN
          ALTER TABLE notifications ADD COLUMN store_id INTEGER;
          CREATE INDEX IF NOT EXISTS notifications_store_id_idx ON notifications (store_id);
        END IF;
      END $$;
    `);
    console.log('[migration] notifications table ✅');

    // ── users テーブル: display_name 列 ──────────────────────────────────────
    try {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='users' AND column_name='display_name'
          ) THEN
            ALTER TABLE public.users ADD COLUMN display_name TEXT;
            UPDATE public.users
              SET display_name = SPLIT_PART(email, '@', 1)
              WHERE display_name IS NULL AND email IS NOT NULL AND email <> '';
          END IF;
        END $$;
      `);
      console.log('[migration] users.display_name ✅');
    } catch (e: any) {
      console.warn('[migration] users.display_name skipped:', e.message?.split('\n')[0]);
    }

    // ── users テーブル: phone_number UNIQUE 制約を撤廃 ─────────────────────────
    //   ★ 2026-07-07: 電話番号のグローバル UNIQUE は「過去に電話番号を登録した正規
    //     ユーザーの再登録」を永久ブロックしていた（サポート報告: 電話番号が既に登録
    //     済みと出るが紐づくメールが分からず詰む）。 電話番号は NULL 可・任意入力で
    //     不正防止効果はほぼ無い一方、 正規の出店/登録を止める致命傷だったため撤廃する。
    //     本人性はメール(auth.users)が担保。 電話番号は連絡先として保持するのみ。
    //     冪等: 制約が無ければ何もしない。 起動毎に実行されても安全。
    try {
      await client.query(`ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_phone_number_key;`);
      console.log('[migration] users.phone_number UNIQUE dropped ✅');
    } catch (e: any) {
      console.warn('[migration] users.phone_number drop skipped:', e.message?.split('\n')[0]);
    }

    // ── stores 各種追加列 ─────────────────────────────────────────────────────
    const storeExtraCols = [
      ['holiday',              'TEXT'],
      ['pickup_hours',         'TEXT'],
      ['legal_name',           'TEXT'],
      ['legal_representative', 'TEXT'],
      ['legal_address',        'TEXT'],
      ['legal_phone',          'TEXT'],
      ['legal_email',          'TEXT'],
      ['legal_other',          'TEXT'],
      ['rejection_reason',     'TEXT'],
      ['icon_url',                   'TEXT'],
      ['license_upload_failed',      'BOOLEAN DEFAULT FALSE'],
      ['license_upload_error',       'TEXT'],
      ['license_upload_attempted_at','TIMESTAMPTZ'],
    ];
    for (const [col, type] of storeExtraCols) {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='stores' AND column_name='${col}'
          ) THEN
            ALTER TABLE public.stores ADD COLUMN ${col} ${type};
          END IF;
        END $$;
      `);
    }
    console.log('[migration] stores extra columns ✅');

    // ── reservations: pickup_code 列 ─────────────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='reservations' AND column_name='pickup_code'
        ) THEN
          ALTER TABLE public.reservations ADD COLUMN pickup_code TEXT;
        END IF;
      END $$;
    `);
    console.log('[migration] reservations.pickup_code ✅');

    // ── favorites テーブル ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id         SERIAL PRIMARY KEY,
        user_id    TEXT NOT NULL,
        store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT favorites_user_store_uniq UNIQUE (user_id, store_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites (user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS favorites_store_id_idx ON favorites (store_id);
    `);
    console.log('[migration] favorites table ✅');

    // ── surprise_bags: allergy_info / pickup_note 列 ─────────────────────────
    for (const col of ['allergy_info', 'pickup_note']) {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='surprise_bags' AND column_name='${col}'
          ) THEN
            ALTER TABLE public.surprise_bags ADD COLUMN ${col} TEXT;
          END IF;
        END $$;
      `);
    }
    console.log('[migration] surprise_bags.allergy_info / pickup_note ✅');

    // ── cart_reservations テーブル ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS cart_reservations (
        id             SERIAL PRIMARY KEY,
        user_id        TEXT NOT NULL,
        bag_id         INTEGER NOT NULL REFERENCES surprise_bags(id) ON DELETE CASCADE,
        reservation_id INTEGER,
        quantity       INTEGER NOT NULL DEFAULT 1,
        reserved_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at     TIMESTAMP NOT NULL,
        status         TEXT NOT NULL DEFAULT 'active'
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS cart_reservations_bag_id_status_idx ON cart_reservations (bag_id, status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS cart_reservations_reservation_id_idx ON cart_reservations (reservation_id);
    `);
    console.log('[migration] cart_reservations table ✅');

    // ── パフォーマンス用インデックス（冪等）────────────────────────────────────
    // bags 一覧: is_active + created_at フィルタで高速スキャン
    await client.query(`CREATE INDEX IF NOT EXISTS sb_active_created_idx   ON surprise_bags (is_active, created_at DESC)`);
    // バッグ → ストア JOIN キー
    await client.query(`CREATE INDEX IF NOT EXISTS sb_store_id_idx          ON surprise_bags (store_id)`);
    // status=active の期限切れ仮押さえ cleanup
    await client.query(`CREATE INDEX IF NOT EXISTS cr_status_expires_idx    ON cart_reservations (status, expires_at)`);
    // 予約一覧をユーザー軸で高速取得
    await client.query(`CREATE INDEX IF NOT EXISTS res_user_id_idx          ON reservations (user_id)`);
    // ストア一覧: 承認済みフィルタ
    await client.query(`CREATE INDEX IF NOT EXISTS stores_status_active_idx ON stores (status, is_active)`);
    console.log('[migration] performance indexes ✅');

    // ── announcements テーブル ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[migration] announcements table ✅');

    // ── web_push_subscriptions テーブル ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        endpoint    TEXT NOT NULL UNIQUE,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS wps_user_id_idx ON web_push_subscriptions (user_id);
    `);
    console.log('[migration] web_push_subscriptions table ✅');

    // ── apns_registrations テーブル ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS apns_registrations (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        device_token TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, device_token)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ar_user_id_idx ON apns_registrations (user_id);
    `);
    console.log('[migration] apns_registrations table ✅');

    // ── fcm_registrations テーブル (Android push 用) ──────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS fcm_registrations (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        device_token TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, device_token)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS fcm_user_id_idx ON fcm_registrations (user_id);
    `);
    console.log('[migration] fcm_registrations table ✅');

    // ── anonymous_push_devices テーブル (会員登録前の端末プッシュ用) ────────────
    //   ログイン前でも通知許可さえ取れれば APNs/FCM のデバイストークンは取れる。
    //   それを userId 無しで保存し、デイリー通知(出品中◯件)を非会員にも届ける。
    //   ログイン時に /push/device-token 側で同一 device_token をここから削除して
    //   apns_registrations へ移すので、二重送信は起きない。
    await client.query(`
      CREATE TABLE IF NOT EXISTS anonymous_push_devices (
        id           SERIAL PRIMARY KEY,
        device_token TEXT NOT NULL UNIQUE,
        platform     TEXT NOT NULL DEFAULT 'ios',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS apd_platform_idx ON anonymous_push_devices (platform);
    `);
    console.log('[migration] anonymous_push_devices table ✅');

    // ── anonymous_web_push_subscriptions テーブル (会員登録前のWebプッシュ用) ──
    //   ブラウザ/PWA で通知許可が取れた非会員の購読を userId 無しで保存。
    //   ログイン時に /web-push/subscribe 側で同一 endpoint をここから削除して昇格。
    await client.query(`
      CREATE TABLE IF NOT EXISTS anonymous_web_push_subscriptions (
        id         SERIAL PRIMARY KEY,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[migration] anonymous_web_push_subscriptions table ✅');

    // ── store_status enum に suspended を追加 ─────────────────────────────────
    await client.query(`ALTER TYPE store_status ADD VALUE IF NOT EXISTS 'suspended'`);
    console.log('[migration] store_status suspended ✅');

    // ── app_settings テーブル ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // デフォルト値を INSERT OR IGNORE で挿入
    await client.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('catchphrase',                   'あなたの街のおすそわけ'),
        ('sub_catchphrase',               'おいしいものを、もっとみんなへ。'),
        ('maintenance_mode',              'false'),
        ('maintenance_title',             'ただいまメンテナンス中です'),
        ('maintenance_message',           'より良いサービスのために、現在システムメンテナンスを行っています。\nしばらくお待ちください🙏'),
        ('auto_approve_stripe_verified',  'true')
      ON CONFLICT (key) DO NOTHING;
    `);
    // 管理者審査廃止に伴い auto_approve_stripe_verified をデフォルト ON に更新
    await client.query(`
      UPDATE app_settings SET value = 'true'
      WHERE key = 'auto_approve_stripe_verified' AND value = 'false';
    `);
    console.log('[migration] app_settings table ✅');

    // ── users.ranking_opt_out: オプトイン制ランキング (デフォルト非掲載) ──────
    // 仕様変更 2026-05: ニックネーム強制を廃止 → ランキングは完全オプトイン化。
    // 1) カラム保証 (既に存在する想定だが冪等に IF NOT EXISTS)
    // 2) DEFAULT を true に変更 (新規ユーザーは非掲載スタート)
    // 3) 一回限りリセット (app_settings フラグで管理): 既存ユーザー全員を非掲載に戻す
    try {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='users' AND column_name='ranking_opt_out'
          ) THEN
            ALTER TABLE public.users ADD COLUMN ranking_opt_out BOOLEAN NOT NULL DEFAULT true;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER TABLE public.users ALTER COLUMN ranking_opt_out SET DEFAULT true;
      `);
      // 一回限りリセット (オプトイン制への移行) — 同じキーが既に入っていれば skip
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM public.app_settings WHERE key = 'ranking_opt_in_reset_2026_05'
          ) THEN
            UPDATE public.users SET ranking_opt_out = true WHERE ranking_opt_out IS NOT TRUE;
            INSERT INTO public.app_settings (key, value)
              VALUES ('ranking_opt_in_reset_2026_05', 'done');
          END IF;
        END $$;
      `);
      console.log('[migration] users.ranking_opt_out (opt-in scheme) ✅');
    } catch (e: any) {
      console.warn('[migration] users.ranking_opt_out skipped:', e.message?.split('\n')[0]);
    }

    // ── ヒール: KYC完了済み(stripe_charges_enabled=true)なのに applied のまま残っている店舗を自動承認 ──
    // auto_approve_stripe_verified が ON の場合に限り実行（冪等・何度実行しても安全）
    try {
      const healResult = await client.query(`
        UPDATE stores
        SET status = 'approved', is_active = true
        WHERE status = 'applied'
          AND stripe_charges_enabled = true
          AND (SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified') = 'true'
        RETURNING id, name;
      `);
      if (healResult.rows.length > 0) {
        const healed = healResult.rows.map((r: { id: number; name: string }) => `${r.id}:${r.name}`).join(', ');
        console.log(`[migration] heal auto-approved ${healResult.rows.length} stuck stores: ${healed} ✅`);
      } else {
        console.log('[migration] heal: no stuck stores to approve ✅');
      }
    } catch (e) {
      console.warn('[migration] heal skipped:', (e as Error).message?.split('\n')[0]);
    }

    // ── ヒール: stripe_charges_enabled=false なのに applied のまま残っている店舗を pending に戻す ──
    // webhook が届かなかった場合の安全網
    try {
      const revertResult = await client.query(`
        UPDATE stores
        SET status = 'pending'
        WHERE status = 'applied'
          AND stripe_account_id IS NOT NULL
          AND stripe_charges_enabled = false
        RETURNING id, name;
      `);
      if (revertResult.rows.length > 0) {
        const reverted = revertResult.rows.map((r: { id: number; name: string }) => `${r.id}:${r.name}`).join(', ');
        console.log(`[migration] heal reverted ${revertResult.rows.length} stuck-applied→pending stores: ${reverted} ✅`);
      } else {
        console.log('[migration] heal: no stuck applied→pending stores ✅');
      }
    } catch (e) {
      console.warn('[migration] heal revert skipped:', (e as Error).message?.split('\n')[0]);
    }

    // ── stores.stripe_kyc_admin_email_sent 列 ─────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stores'
            AND column_name='stripe_kyc_admin_email_sent'
        ) THEN
          ALTER TABLE stores ADD COLUMN stripe_kyc_admin_email_sent BOOLEAN NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
    console.log('[migration] stores.stripe_kyc_admin_email_sent ✅');

    // ── stores.stripe_charges_enabled 列 ──────────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stores'
            AND column_name='stripe_charges_enabled'
        ) THEN
          ALTER TABLE stores ADD COLUMN stripe_charges_enabled BOOLEAN;
        END IF;
      END $$;
    `);
    console.log('[migration] stores.stripe_charges_enabled ✅');

    // ── stores.show_on_map 列 ─────────────────────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stores'
            AND column_name='show_on_map'
        ) THEN
          ALTER TABLE stores ADD COLUMN show_on_map BOOLEAN NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
    console.log('[migration] stores.show_on_map ✅');

    // ── stores.lat / stores.lng を real → double precision へ昇格 ──────────────
    //   real (float32) は ~7桁有効精度しかなく、 経度 135.59024 のような Osaka 域の
    //   値が ~0.0001°(~10m) 単位で量子化されて「ピンが隣の建物に表示」 バグの原因に
    //   なっていた。 double precision (float64) なら ~15桁精度で sub-mm まで保てる。
    //   既存行は real のまま保存されていた精度劣化値が float64 化されるだけで
    //   精度復元はされないため、 オーナーが再保存したタイミングで正確化される。
    {
      const r = await client.query(`
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='stores' AND column_name='lat'
         LIMIT 1
      `);
      const current = r.rows[0]?.data_type;
      if (current && current !== 'double precision') {
        await client.query(`ALTER TABLE stores ALTER COLUMN lat TYPE double precision USING lat::double precision`);
        await client.query(`ALTER TABLE stores ALTER COLUMN lng TYPE double precision USING lng::double precision`);
        console.log(`[migration] stores.lat/lng: ${current} → double precision ✅`);
      } else {
        console.log('[migration] stores.lat/lng: 既に double precision ✅');
      }
    }

    // ── sales_leads テーブル ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_leads (
        id          SERIAL PRIMARY KEY,
        reported_by TEXT,
        store_name  TEXT NOT NULL,
        location    TEXT NOT NULL,
        memo        TEXT,
        status      TEXT NOT NULL DEFAULT 'new',
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[migration] sales_leads table ✅');

    // ── surprise_bags: item_type 列 ──────────────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surprise_bags' AND column_name='item_type'
        ) THEN
          ALTER TABLE surprise_bags ADD COLUMN item_type TEXT DEFAULT 'bag';
        END IF;
      END $$;
    `);
    console.log('[migration] surprise_bags.item_type ✅');

    // ── reviews テーブル ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id             SERIAL PRIMARY KEY,
        store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        user_id        TEXT NOT NULL,
        rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment        TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reviews_reservation_unique ON reviews(reservation_id);
    `);
    // reply / replied_at カラムは後から追加された可能性があるため個別に追加
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='reviews' AND column_name='reply'
        ) THEN
          ALTER TABLE reviews ADD COLUMN reply TEXT;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='reviews' AND column_name='replied_at'
        ) THEN
          ALTER TABLE reviews ADD COLUMN replied_at TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('[migration] reviews table ✅');

    // ── admin_audit_log テーブル ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id          SERIAL PRIMARY KEY,
        admin_email VARCHAR(255) NOT NULL,
        action      VARCHAR(100) NOT NULL,
        target_id   VARCHAR(100),
        details     JSONB,
        ip_address  VARCHAR(50),
        user_agent  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS audit_log_created_idx ON admin_audit_log (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS audit_log_action_idx  ON admin_audit_log (action)`);
    // RLS 有効化（管理者 API サーバーのみ書き込み可）
    await client.query(`ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY`);
    console.log('[migration] admin_audit_log table ✅');

    // ── stores.stripe_needs_bank_reregister 列 ─────────────────────────────────
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='stores'
            AND column_name='stripe_needs_bank_reregister'
        ) THEN
          ALTER TABLE stores ADD COLUMN stripe_needs_bank_reregister BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);
    console.log('[migration] stores.stripe_needs_bank_reregister ✅');

    // ── heal: Stripe payouts 有効な店舗の license_upload_failed を一掃 ────────
    // payouts_enabled = true は Stripe KYC が完全完了している証拠。
    // 古い admin_requested_reupload フラグ等が残っていると「許可証問題あり」一覧に
    // 残り続けるので、整合性を保つために一斉クリアする（idempotent）。
    {
      const r = await client.query(`
        UPDATE stores
           SET license_upload_failed = false,
               license_upload_error  = NULL
         WHERE stripe_payouts_enabled = true
           AND (license_upload_failed = true OR license_upload_error IS NOT NULL)
        RETURNING id
      `);
      if (r.rowCount && r.rowCount > 0) {
        console.log(`[migration] heal: cleared stale license_upload_failed for ${r.rowCount} payouts-enabled stores ✅`);
      } else {
        console.log('[migration] heal: no stale license_upload_failed flags to clear ✅');
      }
    }

    // ── Stripe webhook idempotency 用テーブル（重複処理防止）─────────────────
    // 設計: 「先行 claim 型」── 受信時に INSERT を試行（status='processing'）。
    // PK 重複（23505）→ 既存 row が processing/succeeded/failed のいずれかを判定し、
    // succeeded ならスキップ、processing で stale（>10分）なら奪取、failed なら奪取して再処理。
    // これにより同一 event の並列処理を Postgres ユニーク制約で 1 つに絞り込む。
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id    TEXT PRIMARY KEY,
        event_type  TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status      TEXT NOT NULL DEFAULT 'succeeded',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE stripe_webhook_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'succeeded';`);
    await client.query(`ALTER TABLE stripe_webhook_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
    // stale processing を奪取できるよう updated_at の index を作成
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status ON stripe_webhook_events (status, updated_at);`);
    // 30日より古い succeeded イベントを削除（テーブル肥大化防止）
    await client.query(`
      DELETE FROM stripe_webhook_events
       WHERE status = 'succeeded' AND received_at < NOW() - INTERVAL '30 days';
    `);
    // 7日経過した failed/processing 行も削除（実質再送が止まる Stripe の3日リトライ＋余裕）。
    // 残しておくと Stripe が後刻同じ event_id を送信した際の重複判定が誤動作するため。
    await client.query(`
      DELETE FROM stripe_webhook_events
       WHERE status IN ('failed','processing') AND received_at < NOW() - INTERVAL '7 days';
    `);
    console.log('[migration] stripe_webhook_events table ✅');

    // ── reservations.merchandise_amount: 商品代金（5%システム利用料を加算する前の金額）
    //    新収益モデル (ユーザー側 5% システム利用料 + 店舗側 20% プラットフォーム手数料) で
    //    必要となる、totalPrice (ユーザー支払合計) とは別に保持する商品代金カラム。
    //    旧データは NULL のままで、コードは totalPrice をフォールバックとして扱う。
    await client.query(`
      ALTER TABLE reservations
      ADD COLUMN IF NOT EXISTS merchandise_amount REAL;
    `);
    console.log('[migration] reservations.merchandise_amount ✅');

    // ── users.notif_email_orders: 店舗オーナーの注文メール通知 OPT-IN カラム ─
    //    Push が来てる店舗にとっては「メール邪魔」なので、 デフォルト OFF。
    //    Settings → 通知 → 注文時のメール通知 を ON にした店舗だけ受信する。
    //
    //    歴史: 当初 OPT-OUT (default=true) で導入したが、 直後に「邪魔」の声があり
    //          反転。 反転当時、 明示的に ON にした店舗は 0 件のため、 既存行も含めて
    //          安全に一括 false に倒せる。 二度目以降の起動では (a) DEFAULT が既に
    //          false (b) 一括 UPDATE は既に走っており、 ユーザが手動 ON した行を
    //          上書きしない。
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_email_orders BOOLEAN NOT NULL DEFAULT false;
    `);
    // 既に true で作られた列があればデフォルトを false に揃える (新規 row 用)
    await client.query(`ALTER TABLE public.users ALTER COLUMN notif_email_orders SET DEFAULT false;`);
    // 一度だけ実行: opt-out 時代に true で初期化された行を false にリセット。
    // 冪等にするため一時テーブルに「反転済みフラグ」を保存する。
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM app_settings WHERE key = 'notif_email_orders_default_flipped'
        ) THEN
          UPDATE public.users SET notif_email_orders = false WHERE notif_email_orders = true;
          INSERT INTO app_settings (key, value) VALUES ('notif_email_orders_default_flipped', 'true');
        END IF;
      END $$;
    `);
    console.log('[migration] users.notif_email_orders (default OFF) ✅');

    // ── users.notif_daily_engagement: 毎日エンゲージメント通知 OPT-OUT 用カラム
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_daily_engagement BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('[migration] users.notif_daily_engagement ✅');

    // ── users.notif_new_listing: 「お気に入り外の新規出品(全体配信)」OPT-OUT 用カラム
    //   OFF にすると new-listing-broadcast の全体配信がその人だけスキップされる。
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_new_listing BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('[migration] users.notif_new_listing ✅');

    // ── users.notif_favorite_update: 「お気に入り店舗の更新」通知 OPT-OUT 用カラム
    //   OFF にすると お気に入り店の新出品プッシュ(手動出品/定期出品の初回公開)が
    //   その人だけスキップされる。 以前は localStorage のみで実配信が止まっていなかった。
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_favorite_update BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('[migration] users.notif_favorite_update ✅');

    // ── users.notif_unlisted_reminder: 店オーナー向け「未出品リマインド」OPT-OUT 用カラム
    //   OFF にすると unlisted-store-reminder のリマインドがそのオーナーだけスキップされる。
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_unlisted_reminder BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('[migration] users.notif_unlisted_reminder ✅');

    // ── users.notif_new_order: 店オーナー向け「新規注文の通知(bag_sold)」OPT-OUT 用カラム
    //   OFF にすると 自店に注文が入った際の push(payment/stripe-webhook の bag_sold)が
    //   そのオーナーだけスキップされる。 アプリ内ベル(注文履歴)は残すので注文は取りこぼさない。
    //   以前は設定トグルが localStorage のみで実配信を止められていなかった(見せかけ)。
    await client.query(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_new_order BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('[migration] users.notif_new_order ✅');

    // ── 管理者 role seed (#6 フェーズ B): ハードコード email を廃止し、 env
    // INITIAL_ADMIN_EMAILS (カンマ区切り) で初期 admin を seed する。
    // env が未設定なら何もしない (fail-safe)。 既に DB に admin が居る環境では
    // env 不要 (idempotent)。
    // auth.users への直接アクセス権が無い環境では NOTICE のみで no-op。

    // ★ 前提: users_role_check 制約に 'admin' を追加 (元々 'user'/'store_owner' のみ許可)
    await client.query(`
      DO $$
      DECLARE
        cons_name text;
      BEGIN
        SELECT conname INTO cons_name
          FROM pg_constraint
         WHERE conrelid = 'public.users'::regclass
           AND contype  = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%role%';
        IF cons_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', cons_name);
        END IF;
        ALTER TABLE public.users
          ADD CONSTRAINT users_role_check
          CHECK (role IN ('customer', 'store_owner', 'admin'));
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE '[migration] users_role_check relax: insufficient privilege (skipped)';
      END $$;
    `);
    console.log('[migration] users_role_check (allow admin) ✅');

    // architect C2 対応 (revoke 巻き戻し防止):
    //   既に DB に admin が 1 名以上居る場合、 env による seed は実行しない。
    //   これにより「revoke した admin が次回ブートで自動復活」 する隠れた privilege
    //   escalation を防ぐ。 seed は完全な bootstrap (admin=0) のときだけ動く。
    const initialAdminEmailsEnv = (process.env['INITIAL_ADMIN_EMAILS'] ?? '').trim();
    if (initialAdminEmailsEnv) {
      const { rows: adminCountRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM public.users WHERE role = 'admin'`,
      );
      const existingAdminCount = Number(adminCountRows?.[0]?.cnt ?? 0);

      if (existingAdminCount > 0) {
        console.log(
          `[migration] admin role seed: SKIPPED (existing admins=${existingAdminCount}, env ignored to prevent revoke rollback)`,
        );
      } else {
        const emails = initialAdminEmailsEnv
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.length > 0);
        if (emails.length > 0) {
          await client.query(
            `
            DO $$
            DECLARE
              target_email text;
              admin_uid uuid;
            BEGIN
              FOREACH target_email IN ARRAY $1::text[]
              LOOP
                SELECT id INTO admin_uid FROM auth.users WHERE LOWER(email) = target_email LIMIT 1;
                IF admin_uid IS NOT NULL THEN
                  UPDATE public.users
                     SET role = 'admin'
                   WHERE id = admin_uid
                     AND (role IS NULL OR role <> 'admin');
                END IF;
              END LOOP;
            EXCEPTION WHEN insufficient_privilege THEN
              RAISE NOTICE '[migration] admin role seed: cannot access auth.users (skipped)';
            END $$;
            `,
            [emails],
          );
          console.log(
            `[migration] admin role seed ✅ bootstrap (admin=0 → ${emails.length} email(s) from INITIAL_ADMIN_EMAILS)`,
          );
        }
      }
    } else {
      console.log('[migration] admin role seed: INITIAL_ADMIN_EMAILS not set, skipped');
    }

  } catch (err) {
    console.error('[migration] failed:', err);
  } finally {
    client.release();
  }
}

// ── 致命エラー捕捉（プロセス即死を防止し、サービス継続性を確保）──────────────
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException — プロセスは継続:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection — プロセスは継続:", reason);
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ★ 先に listen する（DB 非依存で即応答）。
//   旧実装は runMigrations().then(listen) で、DB/Supabase 障害時に migration が
//   ハングすると app.listen() に到達せず public/healthz/SPA まで全滅していた
//   (ローンチ当日の全面ダウンの原因)。 サーバー起動は DB 状態から切り離す。
//
//   ★ Fly.io 等で fly-proxy から到達可能にするため 0.0.0.0 で明示 bind。
//     host 引数を省略すると環境によっては ::1 / 127.0.0.1 にしか bind されず
//     "app is not listening on the expected address" 警告で外部アクセス不能になる。
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port} — DB: Supabase PostgreSQL`);
});

// マイグレーションはバックグラウンドで実行（listen をブロックしない）。
// DB が一時的に不達でもサーバーは public/SPA/healthz を配信し続ける。
// スキーマ追加は冪等なので、DB 回復後の次回ブート or この非同期完了時に反映される。
runMigrations().catch((err) => {
  console.error("[migration] background run failed (server still serving):", err);
});

// 期限切れ仮押さえを1分ごとに自動解放（在庫復元）
setInterval(() => {
  releaseExpiredCartReservations().catch(() => {});
}, 60_000);

// 受取1時間前リマインダーを5分ごとに送信
setInterval(() => {
  sendPickupReminders().catch(() => {});
}, 5 * 60_000);

// 毎日のエンゲージメント通知（昼前11:45・夕方16:30 JST）を1分ごとにチェック
setInterval(() => {
  runDailyEngagementNotifications().catch(() => {});
}, 60_000);

// 定期出品（店が設定した公開時刻になったら翌日分を自動公開）を1分ごとにチェック
setInterval(() => {
  publishDueRecurringListings().catch(() => {});
}, 60_000);

// 未決済のまま放置された予約（pending+unpaid・30分超）を5分ごとに自動キャンセル
setInterval(() => {
  cancelStaleUnpaidReservations().catch(() => {});
}, 5 * 60_000);

// 未出品の店へ「今日まだ出品してませんよ」を毎日リマインド（既定 JST 15時台に1回）を1分ごとにチェック
setInterval(() => {
  remindUnlistedStores().catch(() => {});
}, 60_000);
