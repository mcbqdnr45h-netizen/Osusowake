// Googleマップのデフォルト観光地アイコン(古墳・神社・天満宮など)を非表示にする
// スタイル定義。自店舗ピンを見やすくするため POIアイコンを抑制する。
// ★ Map本体と事前ウォームアップ(map-prewarm)で完全一致させる必要があるため、
//   重いMapコンポーネントを巻き込まず参照できるよう独立モジュールに切り出す。
export const MAP_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: 'poi.attraction',       elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.place_of_worship', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business',         elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.government',       elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.attraction',       elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.place_of_worship', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
];
