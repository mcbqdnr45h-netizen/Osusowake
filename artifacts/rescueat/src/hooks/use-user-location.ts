import { useState, useEffect, useRef } from 'react';
import * as geo from '@/lib/geo';

export interface UserCoords {
  lat: number;
  lng: number;
}

// デフォルト位置：高槻駅
export const TAKATSUKI_STATION: UserCoords = { lat: 34.8456, lng: 135.6174 };

// ── モジュールレベルのシングルトン状態 ──────────────────────────────────────
let cachedCoords: UserCoords | null = null;

export type GpsStatus = 'loading' | 'ok' | 'denied';

// GPS がすでにキャッシュされていれば 'ok'、まだなら 'loading' からスタート
let gpsStatus: GpsStatus = cachedCoords ? 'ok' : 'loading';
let autoGpsRequested = false;

type GpsListener    = (coords: UserCoords) => void;
type StatusListener = (status: GpsStatus)  => void;

const gpsListeners:    Set<GpsListener>    = new Set();
const statusListeners: Set<StatusListener> = new Set();

function setGpsStatus(s: GpsStatus) {
  gpsStatus = s;
  statusListeners.forEach(fn => fn(s));
}

export function getCachedCoords(): UserCoords | null {
  return cachedCoords;
}

export function updateCachedCoords(coords: UserCoords | null) {
  cachedCoords = coords;
  if (coords) {
    setGpsStatus('ok');
    gpsListeners.forEach(fn => fn(coords));
  }
}

function tryAutoGps(): void {
  if (autoGpsRequested) return;
  autoGpsRequested = true;

  if (!geo.isSupported()) {
    // 位置情報API非対応 → 即時 denied
    setGpsStatus('denied');
    return;
  }

  // 8秒タイムアウト付きで GPS 取得を試みる
  geo.getCurrentPosition(
    (pos) => {
      const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      cachedCoords = ll;
      setGpsStatus('ok');
      gpsListeners.forEach(fn => fn(ll));
    },
    () => {
      // 拒否 or タイムアウト → denied に確定
      setGpsStatus('denied');
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
  );
}

/**
 * ユーザーの明示的アクション（「現在地ON」ボタンタップなど）から GPS 取得を再要求する。
 * 自動初期化のロックを無視して常に再試行する。
 *
 * 戻り値: 取得した座標、または拒否/タイムアウト時は null
 */
export function requestGpsManually(): Promise<UserCoords | null> {
  return new Promise((resolve) => {
    if (!geo.isSupported()) {
      setGpsStatus('denied');
      resolve(null);
      return;
    }
    setGpsStatus('loading');
    geo.getCurrentPosition(
      (pos) => {
        const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        cachedCoords = ll;
        autoGpsRequested = true;
        setGpsStatus('ok');
        gpsListeners.forEach((fn) => fn(ll));
        resolve(ll);
      },
      (err) => {
        // 拒否 (PERMISSION_DENIED=1) かタイムアウト (TIMEOUT=3) かを区別
        setGpsStatus('denied');
        console.warn('[useUserLocation] GPS request failed:', err.code, err.message);
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  });
}

/**
 * ユーザーの現在地フック。
 *
 * 返り値:
 *   coords  - GPS 座標（未取得・拒否時は null）
 *   loading - GPS 取得中（true の間は距離スケルトンを表示）
 *   denied  - 許可拒否 or タイムアウト（距離表示を非表示にしてよい）
 *   refresh - キャッシュを再反映
 */
export function useUserLocation() {
  const [coords, setCoords]   = useState<UserCoords | null>(cachedCoords);
  const [status, setStatus]   = useState<GpsStatus>(gpsStatus);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    // すでに確定済みの状態があれば即反映
    if (cachedCoords) {
      setCoords(cachedCoords);
      setStatus('ok');
    } else if (gpsStatus !== 'loading') {
      // denied が確定済み
      setStatus(gpsStatus);
    } else {
      // GPS 取得待ち → リスナー登録
      const coordListener: GpsListener = (ll) => {
        if (mounted.current) setCoords(ll);
      };
      const statusListener: StatusListener = (s) => {
        if (mounted.current) setStatus(s);
      };
      gpsListeners.add(coordListener);
      statusListeners.add(statusListener);
      tryAutoGps();

      return () => {
        mounted.current = false;
        gpsListeners.delete(coordListener);
        statusListeners.delete(statusListener);
      };
    }

    return () => { mounted.current = false; };
  }, []);

  const refresh = () => {
    if (cachedCoords && mounted.current) setCoords(cachedCoords);
  };

  return {
    coords,
    loading: status === 'loading',
    denied:  status === 'denied',
    refresh,
  };
}

// ── 距離・時間ユーティリティ ─────────────────────────────────────────────────

export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function metersToWalkMinutes(meters: number): number {
  return Math.round(meters / 67);
}

export function formatWalkTime(minutes: number): string {
  if (minutes < 1)   return '1分未満';
  if (minutes <= 60) return `徒歩${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
}

export function formatDistanceLabel(meters: number): string {
  const minutes = metersToWalkMinutes(meters);
  if (minutes < 1)   return 'すぐそこ';
  // ★ 「徒歩◯分」は本当に歩ける範囲(〜15分・約1km)だけ表示する。
  //   以前は60分(約4km)まで徒歩表記していたが、「徒歩30分/60分」は
  //   非現実的で「遠い=面倒」という心理的マイナスになり予約を下げる。
  //   それ以上は徒歩時間を出さず、中立な距離(km)だけを淡々と示す。
  if (minutes <= 15) return `徒歩${minutes}分`;
  return `${(meters / 1000).toFixed(1)}km`;
}
