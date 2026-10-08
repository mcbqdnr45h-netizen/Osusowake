// Supabase Storage の画像を表示サイズに合わせて配信するためのユーティリティ。
//
// 背景: 出品写真は原寸 (170KB〜540KB) のまま配信され、 スマホでは 160px 程度の枠に
// 縮小表示されていた。 出品 4 件で 1.3MB — 供給が増えるほど無駄が増える構造だった。
// Supabase Storage の画像変換エンドポイントを通すと同じ絵が 34〜89KB (-82%) になる。
//
//   変換前: .../storage/v1/object/public/<bucket>/<path>
//   変換後: .../storage/v1/render/image/public/<bucket>/<path>?width=400&resize=contain&quality=75
//
// ★ resize=contain は必須。 省くと Supabase の既定は cover で、 しかも height を
//   指定しないと「元の高さのまま」扱いになる (1023x825 → 400x825 の縦長クロップ)。
//   その画像を CSS の object-cover が引き伸ばすため、 カード写真が激しく拡大された
//   状態で表示される不具合が出た (2026-07-23 本番で発生)。 contain なら縦横比を
//   保ったまま長辺を width に収める (1023x825 → 400x323) ＝ 元の見た目と同じ。
//
// ※ Supabase の画像変換は課金対象になる場合がある。 止めたいときは
//   IMAGE_TRANSFORM_ENABLED を false にすれば全箇所が原寸配信に戻る。
const IMAGE_TRANSFORM_ENABLED = true;

const SUPABASE_OBJECT_PATH = '/storage/v1/object/public/';
const SUPABASE_RENDER_PATH = '/storage/v1/render/image/public/';

/** 用途ごとの推奨幅 (実際の表示幅の約2倍 = Retina 対応) */
export const IMG_W = {
  icon: 100,
  thumb: 400,
  hero: 800,
} as const;

/**
 * Supabase Storage の画像 URL を、 指定幅にリサイズして配信する URL に変換する。
 * Supabase 以外の URL (Unsplash のフォールバック画像・data: URL など) や
 * 空の値はそのまま返す — 変換できないものを壊さないことを最優先にしている。
 */
export function optimizedImage(
  url: string | null | undefined,
  width: number = IMG_W.thumb,
  quality: number = 75,
): string | undefined {
  if (!url) return undefined;
  if (!IMAGE_TRANSFORM_ENABLED) return url;
  if (!url.includes(SUPABASE_OBJECT_PATH)) return url;

  const rendered = url.replace(SUPABASE_OBJECT_PATH, SUPABASE_RENDER_PATH);
  const sep = rendered.includes('?') ? '&' : '?';
  // resize=contain を外すな (既定の cover だと縦横比が壊れて拡大表示になる)
  return `${rendered}${sep}width=${width}&resize=contain&quality=${quality}`;
}
