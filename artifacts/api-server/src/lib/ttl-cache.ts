// ── 超軽量 in-memory TTL キャッシュ（公開読み取りエンドポイント高速化用）──────────
//
// 目的:
//   /api/bags, /api/stores は「全ユーザーに同じ結果」を返す公開一覧で、
//   ローンチ時は多数のクライアントが 60 秒間隔で refetch するため、同一クエリが
//   秒間何度も DB に飛んで重かった（1 リクエスト ~1.5s）。
//   数秒だけ結果をメモリ保持して使い回すことで、大半のリクエストを DB を叩かず
//   即返しにし、DB 負荷とレスポンス遅延を同時に下げる。
//
// 設計:
//   - プロセス内 Map。単一マシン運用（min_machines_running=1）なので十分。
//   - stale-while-error: 取得に失敗しても直近の値があれば返す（可用性優先）。
//   - 同時多発リクエストの thundering herd を防ぐため、進行中の Promise を共有する。
//
// 整合性:
//   在庫は予約確定時にサーバー側で再検証されるため、数秒の一覧鮮度落ちは許容範囲。

type Entry<T> = {
  value: T | undefined;
  expires: number;      // 有効期限 (Date.now() ミリ秒)
  inflight?: Promise<T>; // 取得中の共有 Promise（herd 防止）
};

const store = new Map<string, Entry<unknown>>();

/**
 * key の結果を最大 ttlMs だけキャッシュして返す。
 * 期限切れなら loader() で再取得。取得中の重複呼び出しは同じ Promise を共有する。
 * 再取得に失敗した場合、直近の値があればそれを返す（stale-while-error）。
 */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  if (hit && hit.value !== undefined && hit.expires > now) {
    return hit.value;
  }
  if (hit?.inflight) {
    return hit.inflight;
  }

  const entry: Entry<T> = hit ?? { value: undefined, expires: 0 };
  entry.inflight = (async () => {
    try {
      const value = await loader();
      entry.value = value;
      entry.expires = Date.now() + ttlMs;
      return value;
    } catch (err) {
      // stale-while-error: 直近値があれば延命して返す
      if (entry.value !== undefined) {
        entry.expires = Date.now() + Math.min(ttlMs, 3000);
        return entry.value;
      }
      throw err;
    } finally {
      entry.inflight = undefined;
    }
  })();

  store.set(key, entry as Entry<unknown>);
  return entry.inflight;
}

/** 明示的にキャッシュを無効化（書き込み後などに呼ぶ。前方一致で複数キー消去可）。 */
export function invalidate(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
