import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase, type PublicUser } from '@/lib/supabase';
import { recordEvent } from '@/lib/nav-debug';

interface AuthContextValue {
  user: User | null;
  profile: PublicUser | null;
  session: Session | null;
  isLoading: boolean;
  isAdmin: boolean;
  pendingAdminMfa: boolean;
  signUp: (email: string, password: string, name: string, phone: string, displayName: string, onProgress?: (step: string) => void) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signUpAsStore: (email: string, password: string, name: string, phone: string, onProgress?: (step: string) => void) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signIn: (email: string, password: string, forceRole?: 'store_owner' | 'customer') => Promise<{ error: string | null; role: string | null; isAdmin?: boolean; requiresMfa?: boolean }>;
  sendAdminMfa: () => Promise<{ error: string | null }>;
  verifyAdminMfa: (code: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  resetPasswordForEmail: (email: string) => Promise<{ error: string | null }>;
  // ★ Apple / Google SSO (T004): Supabase OAuth リダイレクトフロー
  signInWithProvider: (provider: 'google' | 'apple') => Promise<{ error: string | null }>;
  // ★ 楽観的ロール更新 (登録途中のユーザーが店舗オーナー UI を見られるように)
  //   persistToCache=true で profile キャッシュ (localStorage) にも書き込み、
  //   次回起動時に古い role でブートストラップされるのを防ぐ (中断時に使用)。
  setOptimisticRole: (role: 'store_owner' | 'customer', persistToCache?: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// タイムアウト付きPromise競走（PromiseLike にも対応）
function raceTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

// 管理者セッションのタイムアウト（2時間）
const ADMIN_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ★ profile を localStorage にキャッシュ → ネットワーク不調時でも即座に role 判定
const PROFILE_CACHE_KEY = 'osusowake_profile_cache_v1';
// ★ 店舗オーナーセッションフラグ (sessionStorage):
//   このタブで一度でも「ユーザは store_owner」 と確認できたら ON にする。
//   ON の間、 fetchProfile が DB から一時的に customer を読んでも自動的に
//   store_owner にクランプする (replication lag / 一過性 RLS タイミングの保険)。
//   立つタイミング:
//     1) setOptimisticRole('store_owner') (StoreOnboarding 開始時など)
//     2) fetchProfile が DB から prof.role==='store_owner' を取得した瞬間
//     3) 初期キャッシュ読み込み時に role==='store_owner' を確認した瞬間
//   クリアされるタイミング:
//     - sign-out (manual / auto)
//     - StoreOnboarding 戻るボタンで新規登録中断
//   ※ fetchProfile では自動クリアしない。
const PENDING_STORE_OWNER_KEY = 'osusowake_pending_store_owner_v1';
function markStoreOwnerSession() {
  try { sessionStorage.setItem(PENDING_STORE_OWNER_KEY, '1'); } catch (_) {}
}
function readCachedProfile(): PublicUser | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PublicUser) : null;
    // ★ 起動時にキャッシュが store_owner ならセッションフラグも立てる
    //   (mount 直後から transient customer 読み取りを保護)
    if (parsed?.role === 'store_owner') markStoreOwnerSession();
    return parsed;
  } catch { return null; }
}
function writeCachedProfile(p: PublicUser | null) {
  try {
    if (p) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p));
    else   localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch (err) {
    console.warn('[AuthContext] writeCachedProfile failed', err);
  }
}

// ★ Supabase が localStorage に保存しているセッションを同期読み (storageKey は supabase.ts 参照)。
//    起動直後に user / session を即復元 → AuthLoadingScreen を出さずに済む。
//    バックグラウンドで initAuth が走り、 トークン期限切れなら自動リフレッシュされる。
function readCachedSupabaseSession(): { user: User | null; session: Session | null } {
  try {
    const raw = localStorage.getItem('rescueat-auth-token');
    if (!raw) return { user: null, session: null };
    const parsed = JSON.parse(raw);
    const sess = (parsed?.currentSession ?? parsed) as Session | null;
    return { user: sess?.user ?? null, session: sess };
  } catch { return { user: null, session: null }; }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // ★ 起動時のキャッシュ復元: Supabase セッション (localStorage) + Profile キャッシュ
  //    両方揃ってる「リピート起動」 では isLoading=false で開始し、 AuthLoadingScreen
  //    (フルスクリーンの「読み込み中…」) を完全にスキップする。
  //    バックグラウンドで initAuth が走って token refresh / 最新 profile 取得は継続。
  const [profile, setProfile] = useState<PublicUser | null>(() => readCachedProfile());
  const cachedSupabase = readCachedSupabaseSession();
  const [user, setUser]       = useState<User | null>(cachedSupabase.user);
  const [session, setSession] = useState<Session | null>(cachedSupabase.session);
  const [isLoading, setIsLoading]         = useState(!(cachedSupabase.user && profile));
  const [isAdmin, setIsAdmin]             = useState(false);
  const [pendingAdminMfa, setPendingAdminMfa] = useState(false);
  const isAdminRef    = useRef(false);
  const fetchingRef   = useRef(false);
  const adminLoginAt  = useRef<number | null>(null);
  const mfaPromptActiveRef = useRef(false); // mfa_required イベントの多重 OTP 送信を防ぐ
  // ★ initAuth 完走まで onAuthStateChange の fetchProfile を抑止する
  //    (adminCheck → fetchProfile の順序を全経路で保証 → adminUserMode role 上書きのレース回避)
  const initInProgressRef = useRef(true);

  // MFA 検証済みか sessionStorage で確認（同一タブのページ更新では再要求しない）
  function isMfaVerifiedInSession(): boolean {
    const ts = sessionStorage.getItem('adminMfaVerifiedAt');
    if (!ts) return false;
    return Date.now() - Number(ts) < ADMIN_SESSION_TIMEOUT_MS;
  }

  // 管理者セッションタイムアウト監視（2時間で自動ログアウト）
  useEffect(() => {
    if (!isAdmin) return;
    const timer = setInterval(() => {
      if (adminLoginAt.current && Date.now() - adminLoginAt.current > ADMIN_SESSION_TIMEOUT_MS) {
        console.warn('[AuthContext] 管理者セッションタイムアウト — 自動ログアウト');
        signOut();
      }
    }, 60 * 1000); // 1 分ごとにチェック
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // サーバが mfa_required を返した時（MFA 期限切れ / サーバ再起動でサーバ側 MFA 消失）に
  // OTP を再要求する。 authed-fetch.ts が 'admin-mfa-required' イベントを発火する。
  //   ★ AdminDashboard は複数の admin API を並列で叩くため、 イベントも連続発火する。
  //     mfaPromptActiveRef で多重 OTP 送信（メール連投）を防ぐ。
  useEffect(() => {
    function onMfaRequired() {
      // ダッシュボードは isAdmin のまま下に残し、 モーダルを上に重ねる（再認証で復帰）。
      setPendingAdminMfa(true);
      sessionStorage.removeItem('adminMfaVerifiedAt');
      if (mfaPromptActiveRef.current) return; // 既に OTP 送信済み → 再送しない
      mfaPromptActiveRef.current = true;
      supabase.auth.getSession().then(({ data }) => {
        const token = data.session?.access_token;
        if (token) {
          fetch(`${getApiBase()}/api/auth/admin-otp/send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
      });
    }
    window.addEventListener('admin-mfa-required', onMfaRequired);
    return () => window.removeEventListener('admin-mfa-required', onMfaRequired);
  }, []);

  // 管理者判定をサーバー API に委譲（メールをクライアントに露出させない）
  async function checkIsAdmin(token: string): Promise<boolean> {
    try {
      const base = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.BASE_URL : '') ?? '';
      const apiBase = base.replace(/\/$/, '') || '';
      const res = await fetch(`${apiBase}/api/auth/is-admin`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const { isAdmin: adminFlag } = await res.json();
      return Boolean(adminFlag);
    } catch {
      return false;
    }
  }

  async function fetchProfile(userId: string): Promise<void> {
    fetchingRef.current = true;
    try {
      const result = await raceTimeout(
        supabase.from('users').select('*').eq('id', userId).single().then(r => r),
        2000  // ★ 2秒でタイムアウト (5秒は長すぎ → MyPage の体感ロード短縮)
      );
      if (result && result.data) {
        const prof = result.data as PublicUser;
        // 管理者がユーザーモードでログインしている場合はsessionRoleをcustomerにする
        const adminUserMode = sessionStorage.getItem('adminUserMode') === 'true';
        // ★ 店舗登録進行中フラグ: setOptimisticRole('store_owner') で立つ。
        //   StoreOnboarding 中にトークンリフレッシュで fetchProfile が走り、 DB の
        //   customer で楽観的 store_owner を上書きして MyPage が顧客側に戻るバグの防止。
        //   実 role が store_owner になったら自動でフラグ解除する。
        const pendingStoreOwner = (() => {
          try { return sessionStorage.getItem(PENDING_STORE_OWNER_KEY) === '1'; }
          catch (_) { return false; }
        })();
        let finalProfile: PublicUser;
        if (isAdminRef.current && adminUserMode) {
          finalProfile = { ...prof, role: 'customer' as const };
        } else if (pendingStoreOwner && prof.role === 'customer') {
          finalProfile = { ...prof, role: 'store_owner' as const };
        } else {
          finalProfile = prof;
        }
        // ★ DB から store_owner が確認できた瞬間に セッションフラグを「立てる」。
        //   これが今回の根本修正:
        //   既存の店舗オーナーが onboarding を経由せずアプリを開いた場合でも、
        //   一度確認できればセッション中ずっとクランプ保護が効く。
        //   後続の fetchProfile が transient に customer を返しても in-memory
        //   が customer に化けないので、 「アプリ閉じるまでユーザー側」 が解消する。
        if (finalProfile.role === 'store_owner') markStoreOwnerSession();
        setProfile(finalProfile);
        writeCachedProfile(finalProfile); // ★ 成功時のみキャッシュ更新
      }
      // ★ タイムアウト時はキャッシュを保持。null で上書きしない (ナビが顧客側に化けるバグ防止)
    } catch (err) {
      console.warn('[AuthContext] fetchProfile error:', err);
    } finally {
      fetchingRef.current = false;
    }
  }

  async function refreshProfile() {
    if (user) await fetchProfile(user.id);
  }

  // ★ 楽観的にロールを切り替える (StoreOnboarding 開始時など)
  // 通常はキャッシュには書き込まない → リロード時は actual DB role に戻る (整合性保持)
  // store_owner への昇格時のみ sessionStorage フラグも立て、 タブ閉じるまで維持
  // (TOKEN_REFRESHED 等の再 fetchProfile による顧客側ロールバック防止)
  //
  // ★ persistToCache=true: 「中断」 や「ロール降格」 など、 次回起動でも反映したい場合に使う。
  //   profile キャッシュ (localStorage) にも書き込み、 stale な store_owner キャッシュで
  //   ブートストラップして Home→/store/dashboard→/store-onboarding に再投獄されるのを防ぐ。
  function setOptimisticRole(newRole: 'store_owner' | 'customer', persistToCache?: boolean) {
    setProfile(prev => {
      const next = prev ? { ...prev, role: newRole } : prev;
      if (persistToCache && next) writeCachedProfile(next);
      return next;
    });
    try {
      if (newRole === 'store_owner') {
        sessionStorage.setItem(PENDING_STORE_OWNER_KEY, '1');
      } else {
        sessionStorage.removeItem(PENDING_STORE_OWNER_KEY);
      }
    } catch (_) { /* sessionStorage 失敗は無視 */ }
  }

  useEffect(() => {
    let cancelled = false;

    // 絶対タイムアウト: 8秒で強制的に isLoading=false
    const absoluteTimeout = setTimeout(() => {
      if (!cancelled) {
        console.warn('[AuthContext] initAuth absolute timeout — forcing isLoading=false');
        setIsLoading(false);
      }
    }, 8000);

    const initAuth = async () => {
      try {
        const sessionResult = await raceTimeout(
          supabase.auth.getSession().then(r => r),
          6000
        );
        if (cancelled) return;

        const sess = sessionResult?.data?.session ?? null;
        setSession(sess);
        setUser(sess?.user ?? null);
        if (sess?.user) {
          // パスワードリセット中は管理者チェックをスキップ
          // 判定条件:
          //   1. URL pathname が /reset-password (PKCE/implicit 共通の最終的な経路)
          //   2. URL hash に type=recovery (implicit フロー)
          //   3. URL search に type=recovery (旧 OTP フロー)
          //   4. URL search に code= かつ token_hash= (PKCE recovery / token 直接フロー)
          const search = new URLSearchParams(window.location.search);
          const isRecoveryFlow =
            window.location.pathname === '/reset-password' ||
            window.location.hash.includes('type=recovery') ||
            search.get('type') === 'recovery' ||
            search.has('token_hash') ||
            search.has('token');

          // セッション復元時: 管理者チェック → MFA 検証 → プロフィール取得 (直列維持)
          //   ★ fetchProfile は isAdminRef.current に依存するため (adminUserMode 時の role 上書き)、
          //     並列化するとレース条件が発生する → 直列順序を必ず守る。
          //     代わりに fetchProfile タイムアウトを 5s→2s に短縮することで体感ロードを改善。
          if (sess.access_token && !isRecoveryFlow) {
            // ★ checkIsAdmin は /api/auth/is-admin への生 fetch (タイムアウト無し)。
            //   これが initAuth の直列パスで fetchProfile の前にあるため、 管理者ユーザは
            //   毎回この往復を待たされ、 回線が遅いと isLoading が 8s の絶対タイムアウトまで
            //   居座り MyPage スケルトンが長引く (マロ報告「たまに長い」の主因)。
            //   2s でキャップ: タイムアウト時は今回のパスで非管理者扱いにして即座に
            //   fetchProfile へ進む。 管理者判定は次回 onAuthStateChange/再認証で解決する。
            const adminCheck = await raceTimeout(checkIsAdmin(sess.access_token), 2000);
            if (adminCheck) {
              if (isMfaVerifiedInSession()) {
                // 同一タブ内で MFA 検証済み → そのまま管理者として続行
                isAdminRef.current = true;
                setIsAdmin(true);
                adminLoginAt.current = Date.now();
              } else {
                // MFA 未検証 → ページ更新や新しいタブでは再認証を要求、OTP も自動送信
                setPendingAdminMfa(true);
                fetch(`${getApiBase()}/api/auth/admin-otp/send`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${sess.access_token}` },
                }).catch(() => {});
              }
            }
          }
          await fetchProfile(sess.user.id);
        }
      } catch (err) {
        console.warn('[AuthContext] initAuth error:', err);
      } finally {
        clearTimeout(absoluteTimeout);
        initInProgressRef.current = false; // ★ 完了 → onAuthStateChange の fetchProfile を解禁
        if (!cancelled) setIsLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (cancelled) return;

        // ── 診断ログ: どの auth event がいつ来たか追跡 ──
        recordEvent(`auth:${event}`, { hasSession: !!session, hasUser: !!session?.user });
        // eslint-disable-next-line no-console
        console.log(`[auth] event=${event} hasSession=${!!session} hasUser=${!!session?.user} (${new Date().toLocaleTimeString()})`);

        // PASSWORD_RECOVERY: パスワードリセット中は管理者フローに入らせない
        // SIGNED_OUT: ログアウト時は何もしない
        if (event === 'PASSWORD_RECOVERY') {
          // セッションはセットするがプロフィール・管理者チェックはスキップ
          setSession(session);
          setUser(session?.user ?? null);
          return;
        }

        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          // ★ initAuth 進行中はスキップ (adminCheck 前に fetchProfile が走るレース回避)
          //   initAuth 側で adminCheck → fetchProfile が必ず実行されるので二重取得不要
          if (!fetchingRef.current && !initInProgressRef.current) {
            fetchProfile(session.user.id);
          }
        } else {
          // ★ 自動サインアウト (トークン失効・リモート無効化等) でもフラグを必ず消す。
          //    残存すると次の別ユーザがこのタブで顧客ログインした時に
          //    fetchProfile が role を store_owner にクランプするバグになる。
          try { sessionStorage.removeItem(PENDING_STORE_OWNER_KEY); } catch (_) {}
          setProfile(null);
          writeCachedProfile(null); // ★ ログアウト時はキャッシュも消す
        }
      },
    );

    // ★ Capacitor iOS: アプリをバックグラウンドにすると JS が停止し、
    //   Supabase の autoRefreshToken も止まる。再開時にアクセストークン
    //   が失効していると refresh 失敗 → SIGNED_OUT → 「開き直したら
    //   ログアウトされていた」 バグになる。
    //   App resume 時に明示的に refreshSession() を呼んで防止する。
    // ★ アンマウントが listener 登録より先に走るレースに対応するため、
    //   cleanup 完了状態を Promise で保持して必ず remove() を待つ。
    const appResumeReady = (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return null;
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('appStateChange', async ({ isActive }) => {
          if (!isActive || cancelled) return;
          // ★ refreshSession 自体が TOKEN_REFRESHED を発火 → onAuthStateChange
          //   経由で fetchProfile が走るので、ここでは fetchProfile を呼ばない
          //   (二重 fetch によるチラつき防止)。session/user の更新は listener 側に委譲。
          recordEvent('resume:refreshSession:start');
          try {
            const { data, error } = await supabase.auth.refreshSession();
            recordEvent('resume:refreshSession:done', {
              ok: !error,
              hasSession: !!data?.session,
              err: error?.message,
            });
            if (error) console.warn('[AuthContext] resume refreshSession error:', error.message);
          } catch (err) {
            recordEvent('resume:refreshSession:throw', { err: String(err) });
            console.warn('[AuthContext] resume refresh failed:', err);
          }
        });
        // ★ 登録より先に cancelled になっていたら即 remove
        if (cancelled) { handle.remove().catch(() => {}); return null; }
        return handle;
      } catch {
        return null; // Capacitor 未インストール (Web dev) は無視
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(absoluteTimeout);
      subscription.unsubscribe();
      // ★ 登録待ち完了後に必ず remove() (登録前 unmount でもリーク防止)
      appResumeReady.then(h => h?.remove().catch(() => {})).catch(() => {});
    };
  }, []);

  function getApiBase() {
    const apiBase = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_API_BASE : '') ?? '';
    if (apiBase) return apiBase as string;
    const base = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.BASE_URL : '') ?? '';
    return (base as string).replace(/\/$/, '') || '';
  }

  // メールアドレスの実在性検証（形式・MX・使い捨てメール）
  async function validateEmail(email: string): Promise<{ valid: boolean; message?: string }> {
    try {
      const res = await fetch(`${getApiBase()}/api/auth/check-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) return { valid: true }; // サーバーエラー時は通過
      const { valid, reason } = await res.json();
      if (valid) return { valid: true };
      const msg =
        reason === 'invalid_format' ? 'メールアドレスの形式が正しくありません' :
        reason === 'disposable'     ? '使い捨てメールアドレスは使用できません。普段使いのメールアドレスを入力してください' :
        reason === 'no_mx' || reason === 'domain_not_found'
                                    ? 'このメールアドレスは存在しません。正しいアドレスを入力してください'
                                    : 'メールアドレスを確認してください';
      return { valid: false, message: msg };
    } catch {
      return { valid: true }; // ネットワークエラー時は通過
    }
  }

  async function cleanupOrphanedAuthUser(token: string) {
    try {
      await fetch(`${getApiBase()}/api/auth/cleanup-user`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }
  }

  async function signUp(email: string, password: string, name: string, phone: string, displayName: string, onProgress?: (step: string) => void) {
    const normalizedPhone = phone.trim().replace(/[-\s]/g, '');
    const normalizedDisplayName = displayName.trim();

    // メール実在性のみ検証する。 電話番号は連絡先であり本人性キーではないため
    // 重複チェック(=登録ブロック)は撤廃した (2026-07-07)。 同じ電話番号でも登録可能。
    onProgress?.('入力内容を確認中…');
    const emailCheck = await validateEmail(email);
    if (!emailCheck.valid) {
      return { error: emailCheck.message ?? 'メールアドレスを確認してください', needsConfirmation: false };
    }

    onProgress?.('アカウントを作成中…');
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      return { error: translateError(error.message), needsConfirmation: false };
    }

    if (data.user) {
      // RLS バイパスのためサーバー経由でプロフィールを upsert
      const token = data.session?.access_token;
      if (!token) {
        // メール確認が必要なため session が発行されていない（確認待ち）
        // この場合は後でログイン時に create-profile が呼ばれる想定
        return { error: null, needsConfirmation: true };
      }
      onProgress?.('プロフィールを保存中…');
      const profileRes = await fetch(`${getApiBase()}/api/auth/create-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: 'customer', full_name: name.trim(), phone_number: normalizedPhone, display_name: normalizedDisplayName }),
      });
      if (!profileRes.ok) {
        const errData = await profileRes.json().catch(() => ({}));
        await cleanupOrphanedAuthUser(token);
        if (profileRes.status === 409 || errData?.error === 'phone_taken') {
          return { error: 'この電話番号は既に登録されています', needsConfirmation: false };
        }
        if (errData?.error === 'invalid_display_name' || errData?.error === 'display_name_required') {
          return { error: errData?.message ?? 'ニックネームを確認してください', needsConfirmation: false };
        }
        return { error: '登録中にエラーが発生しました。もう一度お試しください', needsConfirmation: false };
      }
    }

    const needsConfirmation = !data.session;
    return { error: null, needsConfirmation };
  }

  async function signUpAsStore(email: string, password: string, name: string, phone: string, onProgress?: (step: string) => void) {
    const normalizedPhone = phone.trim().replace(/[-\s]/g, '');

    // メール実在性のみ検証する。 電話番号は連絡先であり本人性キーではないため
    // 重複チェック(=登録ブロック)は撤廃した (2026-07-07)。 同じ電話番号でも登録可能。
    onProgress?.('入力内容を確認中…');
    const emailCheck = await validateEmail(email);
    if (!emailCheck.valid) {
      return { error: emailCheck.message ?? 'メールアドレスを確認してください', needsConfirmation: false };
    }

    onProgress?.('アカウントを作成中…');
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { intended_role: 'store_owner' } },
    });

    if (error) {
      // 「既に登録済み」の場合は店舗タブでのログインを促す
      if (error.message.includes('User already registered')) {
        return { error: 'このメールアドレスは既に登録されています。「飲食店・パートナー」タブからログインしてください。', needsConfirmation: false };
      }
      return { error: translateError(error.message), needsConfirmation: false };
    }

    if (data.user) {
      const token = data.session?.access_token;
      if (!token) {
        return { error: null, needsConfirmation: true };
      }
      onProgress?.('プロフィールを保存中…');
      const profileRes = await fetch(`${getApiBase()}/api/auth/create-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: 'store_owner', full_name: name.trim(), phone_number: normalizedPhone }),
      });
      if (!profileRes.ok) {
        const errData = await profileRes.json().catch(() => ({}));
        await cleanupOrphanedAuthUser(token);
        if (profileRes.status === 409 || errData?.error === 'phone_taken') {
          return { error: 'この電話番号は既に登録されています', needsConfirmation: false };
        }
        return { error: '登録中にエラーが発生しました。もう一度お試しください', needsConfirmation: false };
      }

      // ★ 真因対策 (ユーザ報告「戻るボタンで顧客側になる」 バグ):
      //   supabase.auth.signUp が SIGNED_IN イベントを即座に発火し、
      //   onAuthStateChange → fetchProfile が走るが、 この時点では
      //   /api/auth/create-profile の INSERT が完了していないため
      //   users 行が存在せず result.data=null → profile が null のまま放置される。
      //   そのまま /store-onboarding → 戻るボタンと進むと、 profile=null なので
      //   Layout の isStoreOwner=false で下タブが顧客側に化ける。
      //   ここで create-profile 完了直後に再度 fetchProfile を実行し、
      //   profile を store_owner に確定させる。 同時に markStoreOwnerSession で
      //   PENDING フラグも立て、 後続の transient な customer 読み出しを
      //   クランプで防御する。
      markStoreOwnerSession();
      // eslint-disable-next-line no-console
      console.log('[signUpAsStore] create-profile OK → calling fetchProfile', { userId: data.user.id, at: new Date().toLocaleTimeString() });
      try { await fetchProfile(data.user.id); } catch (_) { /* ignore */ }
      // eslint-disable-next-line no-console
      console.log('[signUpAsStore] fetchProfile done', { at: new Date().toLocaleTimeString() });
    }

    const needsConfirmation = !data.session;
    return { error: null, needsConfirmation };
  }

  // ★ signIn のフォールバック分岐で「既存の store_owner を customer に降格しない」 ためのヘルパー。
  //   /api/auth/profile が一時的に失敗しても、 以下のいずれかが「店舗オーナー」 を示している
  //   ならフォールバック role も store_owner にする (キャッシュへの customer 上書きで
  //   ユーザー側 UI に化けるバグを防止)。
  //     1) forceRole === 'store_owner'
  //     2) sessionStorage の PENDING_STORE_OWNER フラグ
  //     3) localStorage のキャッシュ済み profile.role === 'store_owner'
  function resolveFallbackRole(forceRole?: 'store_owner' | 'customer'): 'store_owner' | 'customer' {
    if (forceRole === 'store_owner') return 'store_owner';
    try {
      if (sessionStorage.getItem(PENDING_STORE_OWNER_KEY) === '1') return 'store_owner';
    } catch (_) { /* ignore */ }
    const cached = readCachedProfile();
    if (cached?.role === 'store_owner') return 'store_owner';
    return forceRole ?? 'customer';
  }

  async function signIn(email: string, password: string, forceRole?: 'store_owner' | 'customer') {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: translateError(error.message), role: null };

    // ★ iPad (iPadOS 26 WKWebView) バグ対策:
    //   onAuthStateChange リスナー経由の setUser/setSession に依存していたが、
    //   iPadOS の WebView では localStorage 書き込み完了イベントが遅延し、
    //   signIn 完了 → navigate('/mypage') 時点でまだ user が null のままになる
    //   ケースが発生 (GuestWallRoute がゲスト画面に落ちて、 Apple 審査員からは
    //   「ログインボタンを押しても元のログイン画面に戻る」 ように見える) 。
    //   ここで同期的に user/session を確定させて、 リスナーへの依存を排除する。
    if (data.session) setSession(data.session);
    if (data.user)    setUser(data.user);

    // onAuthStateChange が並走して fetchProfile を呼ばないよう制御
    fetchingRef.current = true;

    let role: string | null = forceRole ?? 'customer';
    let requiresMfaFlag = false;
    try {
      if (data.user && data.session?.access_token) {
        const token = data.session.access_token;
        const apiBase = getApiBase();

        // ── 管理者チェック（サーバー API 経由・メールをバンドルに露出させない）──
        const adminVerified = await checkIsAdmin(token);
        // 管理者の場合: isAdmin はまだ true にしない（MFA 完了後に設定）
        if (adminVerified) {
          requiresMfaFlag = true;
          setPendingAdminMfa(true);
          // OTP メール送信
          try {
            await fetch(`${apiBase}/api/auth/admin-otp/send`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch { /* メール送信エラーは UI 側で再送できるため無視 */ }
        }

        // ── ロール確定（サーバー経由で RLS バイパス・クロスログイン防止）───────
        // desiredRole: store タブ → 'store_owner', user タブ → 'customer'
        // ただし管理者はどちらのタブでもサーバーチェックをスキップ
        if (!adminVerified && forceRole) {
          const roleRes = await fetch(`${apiBase}/api/auth/update-role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ desiredRole: forceRole }),
          });
          if (!roleRes.ok) {
            const errData = await roleRes.json().catch(() => ({}));
            // ロールが合わない場合はサインアウトしてエラーを返す
            if (roleRes.status === 403) {
              recordEvent('signIn:update-role:403(forceRole)', { forceRole });
              await supabase.auth.signOut();
              fetchingRef.current = false;
              return { error: errData?.message ?? 'ログインできませんでした', role: null };
            }
            // その他のエラーはフォールスルー（プロフィール取得で補完）
            console.warn('[AuthContext] update-role error:', errData);
          } else {
            const { role: confirmedRole } = await roleRes.json();
            role = confirmedRole;
          }
        } else if (!adminVerified) {
          // user タブ（forceRole なし）でもサーバーで store_owner かチェック
          const roleRes = await fetch(`${apiBase}/api/auth/update-role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ desiredRole: 'customer' }),
          });
          if (!roleRes.ok) {
            const errData = await roleRes.json().catch(() => ({}));
            if (roleRes.status === 403) {
              // store_owner が user タブでログイン試みた → ブロック
              await supabase.auth.signOut();
              fetchingRef.current = false;
              return { error: errData?.message ?? 'このアカウントは店舗オーナー用です', role: null };
            }
          } else {
            const { role: confirmedRole } = await roleRes.json();
            role = confirmedRole;
          }
        }

        // ── プロフィール取得（Admin 経由・RLS バイパス）──────────────────────
        const profRes = await fetch(`${apiBase}/api/auth/profile`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (profRes.ok) {
          const { profile: prof } = await profRes.json();
          if (prof) {
            // ★ 権威ソース優先: /api/auth/profile (supabaseAdmin 経由・RLS バイパス) が
            //   返した prof.role を信頼する。 管理者の user タブログインのみ customer 上書き。
            //   従来は (role ?? prof.role) としていたため、 update-role が非 403 で失敗
            //   (5xx / ネットワーク) した時に role='customer' のまま prof.role を無視し、
            //   実際は店舗オーナーなのに customer をキャッシュへ書き込んでしまうバグがあった。
            const sessionRole = (!forceRole && adminVerified)
              ? 'customer'
              : (prof.role ?? role ?? 'customer');
            role = sessionRole;
            const fp1: PublicUser = {
              id: data.user.id,
              email: prof.email,
              role: sessionRole,
              full_name: prof.full_name ?? null,
              phone_number: prof.phone_number ?? null,
              display_name: prof.display_name ?? null,
              created_at: data.user.created_at,
            };
            if (sessionRole === 'store_owner') markStoreOwnerSession();
            setProfile(fp1);
            writeCachedProfile(fp1); // ★ 即座にキャッシュ → 次回起動時もスケルトン無し
          } else {
            // プロフィールが存在しない場合（まれ） → 安全側フォールバック
            role = resolveFallbackRole(forceRole);
            const fp2: PublicUser = { id: data.user.id, email: data.user.email!, role: role as import('@/lib/supabase').UserRole, full_name: null, phone_number: null, display_name: null, created_at: data.user.created_at };
            if (role === 'store_owner') markStoreOwnerSession();
            setProfile(fp2);
            writeCachedProfile(fp2);
          }
        } else {
          // プロフィール取得失敗 → フォールバック (既存の store_owner を顧客に降格しないよう注意)
          role = resolveFallbackRole(forceRole);
          const fp3: PublicUser = { id: data.user.id, email: data.user.email!, role: role as import('@/lib/supabase').UserRole, full_name: null, phone_number: null, display_name: null, created_at: data.user.created_at };
          if (role === 'store_owner') markStoreOwnerSession();
          setProfile(fp3);
          writeCachedProfile(fp3);
          console.warn('[AuthContext] profile fetch failed — using fallback');
        }
      }
    } catch (err) {
      console.warn('[AuthContext] signIn profile error:', err);
      if (data.user) {
        role = resolveFallbackRole(forceRole);
        const fp4: PublicUser = { id: data.user.id, email: data.user.email!, role: role as import('@/lib/supabase').UserRole, full_name: null, phone_number: null, display_name: null, created_at: data.user.created_at };
        if (role === 'store_owner') markStoreOwnerSession();
        setProfile(fp4);
        writeCachedProfile(fp4);
      }
    } finally {
      fetchingRef.current = false;
    }

    return { error: null, role, isAdmin: isAdminRef.current, requiresMfa: requiresMfaFlag };
  }

  // ── OTP メール送信（管理者が MFA 待機中に呼ぶ）────────────────────────────
  async function sendAdminMfa(): Promise<{ error: string | null }> {
    const token = session?.access_token;
    if (!token) return { error: 'セッションが無効です' };
    try {
      const res = await fetch(`${getApiBase()}/api/auth/admin-otp/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return { error: d?.message ?? 'コードの送信に失敗しました' };
      }
      return { error: null };
    } catch {
      return { error: 'ネットワークエラーが発生しました' };
    }
  }

  // ── OTP コード検証（成功で isAdmin=true を確定）──────────────────────────
  async function verifyAdminMfa(code: string): Promise<{ error: string | null }> {
    const token = session?.access_token;
    if (!token) return { error: 'セッションが無効です' };
    try {
      const res = await fetch(`${getApiBase()}/api/auth/admin-otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return { error: d?.message ?? '認証に失敗しました' };

      // MFA 成功 → isAdmin を確定し、sessionStorage に記録
      isAdminRef.current = true;
      setIsAdmin(true);
      setPendingAdminMfa(false);
      mfaPromptActiveRef.current = false; // 次の mfa_required で再び OTP 送信できるよう解除
      adminLoginAt.current = Date.now();
      sessionStorage.setItem('adminMfaVerifiedAt', Date.now().toString());
      return { error: null };
    } catch {
      return { error: 'ネットワークエラーが発生しました' };
    }
  }

  async function signOut() {
    recordEvent('signOut(user-initiated)');
    sessionStorage.removeItem('adminUserMode');
    sessionStorage.removeItem('adminMfaVerifiedAt');
    mfaPromptActiveRef.current = false;
    sessionStorage.removeItem(PENDING_STORE_OWNER_KEY);
    // ★ ログアウト時に前ユーザーのローカルデータを完全消去 (新規アカウントに前店舗の写真/店名が残る不具合の根本対策)
    try {
      // 店舗オンボーディング下書き (グローバルキーのため必ず消す)
      localStorage.removeItem('store-onboarding-draft-v2');
      localStorage.removeItem('store-onboarding-draft-v1');
      // プロフィールキャッシュ
      localStorage.removeItem(PROFILE_CACHE_KEY);
      // ユーザー別キャッシュ群 (myStores / favorites など) を一括掃除
      // ★ ただし osusowake_selectedStore_v1_* は「ユーザ設定」 なのでログアウトしても保持する。
      //   複数店舗オーナーが再ログイン時に最後に開いていた店舗から始められるようにするため。
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('osusowake_myStores_v1_') ||
            k.startsWith('rescueat_favorites_v1_')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch { /* localStorage 失敗は無視 */ }
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setSession(null);
    setIsAdmin(false);
    setPendingAdminMfa(false);
    isAdminRef.current = false;
    adminLoginAt.current = null;
  }

  // ── Apple / Google SSO ─────────────────────────────────────────────────
  // Supabase の OAuth リダイレクトフロー。 redirectTo は HTTPS 必須 (capacitor:// は不可) なので
  // 本番ドメイン (osusowakejapan.org) を使う。 サインアップ後 onAuthStateChange で profile が無い
  // 場合は MyPage 側で create-profile (display_name 付き) に誘導される (既存フロー流用)。
  async function signInWithProvider(provider: 'google' | 'apple'): Promise<{ error: string | null }> {
    try {
      const apiBase = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_API_BASE : '') ?? '';
      const origin = window.location.origin;
      const redirectOrigin = (apiBase || origin).replace(/\/$/, '');
      const redirectTo = `${redirectOrigin}/auth-callback`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (error) {
        const m = (error.message || '').toLowerCase();
        if (m.includes('provider is not enabled') || m.includes('unsupported provider')) {
          return { error: provider === 'apple'
            ? 'Apple ログインは現在準備中です。 メール/パスワードでお試しください'
            : 'Google ログインは現在準備中です。 メール/パスワードでお試しください' };
        }
        return { error: translateError(error.message) };
      }
      return { error: null };
    } catch (e: any) {
      return { error: e?.message ?? 'OAuth ログインに失敗しました' };
    }
  }

  async function resetPasswordForEmail(email: string): Promise<{ error: string | null }> {
    try {
      const origin = window.location.origin;
      const base = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.BASE_URL : '') ?? '';
      // ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) を使う必要がある
      //   そうしないと capacitor://localhost/api/... を叩いてしまい絶対に届かない
      const apiBase = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_API_BASE : '') ?? '';
      const API_PREFIX = (apiBase || base).replace(/\/$/, '') || '';
      // 再設定リンクの戻り先は HTTPS 必須（iOS の capacitor://localhost は Supabase に拒否される）
      // 本番デプロイの SPA は `/` 直下なので `/reset-password` にする（`/rescueat/...` ではない）
      const redirectOrigin = (apiBase || origin).replace(/\/$/, '');
      const redirectTo = `${redirectOrigin}/reset-password`;
      const res = await fetch(`${API_PREFIX}/api/auth/forgot-password`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), redirectTo }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // バックエンドが返す詳細メッセージを優先表示（未登録エラー等）
        return { error: body.message || 'エラーが発生しました。しばらくしてからお試しください' };
      }
      return { error: null };
    } catch {
      return { error: 'エラーが発生しました。しばらくしてから再試行してください' };
    }
  }

  return (
    <AuthContext.Provider value={{ user, profile, session, isLoading, isAdmin, pendingAdminMfa, signUp, signUpAsStore, signIn, sendAdminMfa, verifyAdminMfa, signOut, refreshProfile, resetPasswordForEmail, signInWithProvider, setOptimisticRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

function translateError(msg: string): string {
  const m = (msg ?? '').toString().trim();
  if (m.includes('Invalid login credentials')) return 'メールアドレスまたはパスワードが正しくありません';
  if (m.includes('Email not confirmed'))        return 'メールアドレスが未確認です。確認メールのリンクをクリックしてください';
  if (m.includes('User already registered'))   return 'このメールアドレスは既に登録されています';
  if (m.includes('Password should be at least')) return 'パスワードは6文字以上で入力してください';
  if (m.includes('rate limit'))                return 'しばらく時間をおいてから再試行してください';
  // ★ サーバー高負荷・一時障害の保険:
  //   gotrue が空ボディ / 5xx を返すと supabase-js が error.message を
  //   "{}"（空オブジェクトのJSON文字列）や "[object Object]" にすることがあり、
  //   これがそのままユーザーに露出して「赤枠に {} が出る」バグになる。
  //   意味の無い / JSON まる出し / ネットワーク系メッセージは必ず日本語の汎用文言に変換する。
  if (
    m === '' || m === '{}' || m === '[object Object]' ||
    m === 'undefined' || m === 'null' ||
    /^[[{].*[\]}]$/.test(m) ||
    /failed to fetch|networkerror|load failed|timeout|timed out|fetch failed|network request failed/i.test(m)
  ) {
    return '接続が不安定なため、ログインに失敗しました。通信環境を確認して、もう一度お試しください';
  }
  return m;
}
