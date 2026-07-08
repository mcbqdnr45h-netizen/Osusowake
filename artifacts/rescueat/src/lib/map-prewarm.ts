// 地図の事前ウォームアップ。
// 発見(Home)タブに滞在中のアイドル時間に、画面外で本番と同じ中心・同じ
// MAP_STYLES の隠しMapを1回だけ生成してタイルを読み込む。これでHTTPタイル
// キャッシュとMapsエンジンが温まり、実際に地図を開いた時の初回 tilesloaded が
// キャッシュからほぼ即座に発火する。
//
// ★ MAP_STYLES を実マップと完全一致させるのが肝。styledタイルはURLが異なるため、
//   デフォルトタイルを温めても意味がない。
import { loadGoogleMapsScript } from './maps-loader';
import { MAP_STYLES } from './map-styles';
import { getCachedCoords, TAKATSUKI_STATION } from '@/hooks/use-user-location';

let warmed = false;

export function prewarmMap(): void {
  if (warmed) return;
  if (typeof window === 'undefined') return;
  warmed = true;

  const run = () => {
    loadGoogleMapsScript()
      .then(() => {
        const gMaps = (window as any).google?.maps;
        if (!gMaps?.Map) return;

        const center = getCachedCoords() ?? TAKATSUKI_STATION;

        // 画面外の隠しコンテナ（実サイズ相当）。
        const host = document.createElement('div');
        host.style.cssText =
          'position:fixed;left:-10000px;top:0;width:414px;height:800px;' +
          'pointer-events:none;opacity:0;z-index:-1;';
        document.body.appendChild(host);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          try { gMaps.event.clearInstanceListeners(map); } catch { /* noop */ }
          try { document.body.removeChild(host); } catch { /* noop */ }
        };

        const map = new gMaps.Map(host, {
          center,
          zoom: 14,
          disableDefaultUI: true,
          clickableIcons: false,
          backgroundColor: '#f2f0eb',
          styles: MAP_STYLES,
        });

        // タイルが読み込めたら少し待ってから破棄（キャッシュは残る）。
        gMaps.event.addListenerOnce(map, 'tilesloaded', () => {
          setTimeout(cleanup, 300);
        });

        // 安全弁：6秒でどのみち破棄。
        setTimeout(cleanup, 6000);
      })
      .catch(() => { /* noop */ });
  };

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1500);
  }
}
