import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { motion, AnimatePresence } from 'framer-motion';
import { useMyStore } from '@/hooks/use-my-store';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import {
  Building2, ChevronLeft, Loader2, CheckCircle2,
  AlertCircle, ShieldCheck, Info, CreditCard, PartyPopper,
  User, MapPin, FileText, TriangleAlert,
  Camera, ImageIcon, BadgeCheck,
} from 'lucide-react';

// ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。Web では BASE_URL を使う
const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

// ── Stripe インスタンスはコンポーネント内でバックエンドの公開鍵を取得してから初期化する
// （テスト/本番の鍵の不一致を防ぐため、モジュールレベルでの事前ロードは行わない）
let _cachedStripePromise: Promise<Stripe | null> | null = null;
async function getStripeInstance(): Promise<Stripe | null> {
  if (_cachedStripePromise) return _cachedStripePromise;
  _cachedStripePromise = (async () => {
    try {
      const res = await fetch(`${BASE}/api/stripe/public-config`);
      if (!res.ok) throw new Error(`/api/stripe/public-config returned ${res.status}`);
      const data = await res.json() as { publishableKey: string; mode: string };
      if (!data.publishableKey) throw new Error('Stripe公開鍵が設定されていません（STRIPE_PUBLISHABLE_KEY を設定してください）');
      return await loadStripe(data.publishableKey);
    } catch (e) {
      console.error('[StripeBankSetup] Stripe公開鍵の取得に失敗:', e);
      _cachedStripePromise = null; // 次回リトライを許可
      return null;
    }
  })();
  return _cachedStripePromise;
}

// ── 画像圧縮（本人確認書類用 — Stripe送信前に軽量化）────────────────────────────
// ★ 重要: File を直接 URL.createObjectURL() で渡す。FileReader.readAsDataURL は
//   巨大HEIC（10MB+）を base64 エンコード（~13MB の文字列）してメモリ消費＋ UIスレッド
//   ブロックを引き起こし WebView がフリーズする原因。blob URL なら即時／低コスト。
//   失敗時は reject（HEIC等ブラウザ未対応形式の早期検知）。
async function compressIdImageFromFile(file: File, maxPx = 1280, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    const cleanup = () => { try { URL.revokeObjectURL(objectUrl); } catch {} };
    img.onload = () => {
      try {
        let { naturalWidth: width, naturalHeight: height } = img;
        if (!width || !height) { cleanup(); reject(new Error('画像サイズが取得できませんでした')); return; }
        if (width > maxPx || height > maxPx) {
          if (width >= height) { height = Math.round(height * maxPx / width); width = maxPx; }
          else { width = Math.round(width * maxPx / height); height = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { cleanup(); reject(new Error('画像を描画できませんでした')); return; }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        // toDataURL は圧縮後の小さな画像（~100KB）にのみ実行 → 安全
        const out = canvas.toDataURL('image/jpeg', quality);
        cleanup();
        resolve(out);
      } catch (err: any) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('この画像は読み込めませんでした。HEIC/HEIF 形式の可能性があります。iPhoneの「設定 → カメラ → フォーマット → 互換性優先」を選んでから撮り直すか、JPEG/PNG をお選びください。'));
    };
    img.src = objectUrl;
  });
}

// ── localStorage 下書き保存（ストアIDごとに分離）────────────────────────────────
// v2: storeId 単位のキーにすることで別ストアのデータが混入しないようにした
// ── Stripe エラーコード → 日本語（モジュールレベル。コンポーネント外で定義することで
//    getGroupStatus など初期化前のコードからも参照可能）
const STRIPE_ERR_CODE_LABELS: Record<string, string> = {
  verification_document_dob_mismatch:        '書類の生年月日が登録情報と一致しません',
  verification_document_name_mismatch:       '書類の氏名が登録情報と一致しません',
  verification_document_address_mismatch:    '書類の住所が登録情報と一致しません',
  verification_document_id_number_mismatch:  '書類の番号が登録情報と一致しません',
  verification_document_expired:             '書類の有効期限が切れています',
  verification_document_not_readable:        '書類が読み取れません（再撮影してください）',
  verification_document_not_uploaded:        '書類がアップロードされていません',
  verification_document_photo_mismatch:      '書類の写真が一致しません',
  verification_document_type_not_supported:  'この書類の種類は対応していません',
  verification_document_corrupt:             '書類ファイルが破損しています',
  verification_failed_keyed_identity:        '本人確認情報の照合に失敗しました',
  verification_failed_name_match:            '氏名の照合に失敗しました',
  verification_failed_address_match:         '住所の照合に失敗しました',
  verification_failed_business_iec_number:   '事業者番号の照合に失敗しました',
  verification_failed_other:                 '本人確認に失敗しました（書類の再提出が必要です）',
  verification_failed_tax_id_match:          '法人番号の照合に失敗しました',
  verification_failed_tax_id_not_issued:     '指定された法人番号が確認できません',
  verification_failed_id_number_match:       'マイナンバーの照合に失敗しました',
  verification_failed_keyed_match:           '入力情報の照合に失敗しました',
  verification_failed_document_match:        '書類記載の情報と入力情報が一致しません',
  verification_missing_owners:               '株主・受益者情報が不足しています',
  verification_missing_executives:           '役員情報が不足しています',
  verification_requires_additional_memorandum_of_associations:
                                             '追加で定款の提出が必要です',
  invalid_address_city_state_postal_code:    '住所（市区町村・都道府県・郵便番号）が無効です',
  invalid_address_highway_contract_box:      '私書箱は登録できません',
  invalid_address_private_mailbox:           '私書箱は登録できません',
  invalid_business_profile_name:             '事業名（屋号）が無効です',
  invalid_business_profile_name_denylisted:  '指定された事業名は登録できません',
  invalid_company_name_denylisted:           '指定された法人名は登録できません',
  invalid_dob_age_under_18:                  '代表者が18歳未満のため登録できません',
  invalid_dob_age_over_maximum:              '代表者の年齢が登録上限を超えています',
  invalid_phone_number:                      '電話番号が無効です',
  invalid_street_address:                    '住所（番地）が無効です',
  invalid_tax_id:                            '法人番号が無効です',
  invalid_tax_id_format:                     '法人番号の形式が正しくありません',
  invalid_url_format:                        'ウェブサイトURLの形式が正しくありません',
  invalid_url_web_presence_detected:         'ウェブサイトの実在が確認できません',
  invalid_value_other:                       '入力値が無効です',
  bank_account_unusable:                     '銀行口座が使用できません',
  bank_account_verification_failed:          '銀行口座の確認に失敗しました',
  routing_number_invalid:                    '銀行コード・支店コードが無効です',
  account_number_invalid:                    '口座番号が無効です',
  // Stripe からの「Business name and address... doesn't match government records」 系
  verification_directors_mismatch:           '取締役情報が登記情報と一致しません',
  verification_extraneous_directors:         '登録された取締役情報に余分な項目があります',
  verification_missing_directors:            '取締役情報が不足しています',
  verification_failed_representative_authority:
                                             '代表者の権限を確認できませんでした',
  verification_legal_entity_structure_mismatch:
                                             '法人形態が登記情報と一致しません',
};
function stripeErrCodeLabel(code: string): string {
  return STRIPE_ERR_CODE_LABELS[code] ?? '';
}

// ── Stripe からの英語 reason テキスト → 日本語 ──────────────────────────────
//   stripeErrCodeLabel(e.code) で拾えなかった場合の最終フォールバック。
//   既知パターンに部分一致したら日本語化、 完全に未知なら「LINEサポートへ」 と案内。
function stripeReasonLabel(reason: string): string {
  if (!reason) return '';
  const r = reason.toLowerCase();
  // 銀行関連
  if (r.includes("couldn't find the bank") || r.includes('could not find the bank') || r.includes('bank not found')) {
    return '指定された銀行コード・支店コードが見つかりません。 入力内容を再度ご確認ください。';
  }
  if (r.includes('routing_number') || r.includes('routing number')) {
    return '銀行コード・支店コードが正しくありません。';
  }
  if (r.includes('account_number') || r.includes('account number')) {
    return '口座番号が正しくありません。';
  }
  if (r.includes('account holder') || r.includes('holder name')) {
    return '口座名義（カナ）が正しくありません。';
  }
  // 本人確認・登記情報関連
  if (r.includes("doesn't match government records") || r.includes('does not match government records') ||
      r.includes('match government records')) {
    return '登録された情報が公的記録と一致しません。 アカウント情報を更新し、 一致する本人確認書類を再アップロードしてください。';
  }
  if (r.includes('not match') && r.includes('records')) {
    return '入力情報と公的記録が一致しません。 入力内容と提出書類をご確認ください。';
  }
  if (r.includes('document') && (r.includes('upload') || r.includes('verification'))) {
    return '本人確認書類の再アップロードが必要です。';
  }
  if (r.includes('multiple options matching the provided town') || (r.includes('cho-me') && r.includes('town'))) {
    // mokopan (2026-09-02): 高槻の「日吉台」は正式町名が「日吉台一〜七番町」に分かれており、
    // 町名だけでは特定できず住所1項目のせいで更新がまるごと拒否されていた
    return '町名だけでは住所を特定できませんでした。「町名」の欄に丁目・番町まで含めて入力してください（例：「日吉台」→「日吉台五番町」）。「番地・建物名」の欄には丁目・番町を入れず、番地から書いてください。';
  }
  if (r.includes('address')) {
    return '住所情報に問題があります。 入力内容をご確認ください。';
  }
  if (r.includes('name')) {
    return '氏名・法人名に問題があります。 入力内容をご確認ください。';
  }
  // 完全に未知 → 一般的な案内
  return '入力情報に問題があるため再送信が必要です。 詳細はLINEサポートにお問い合わせください。';
}

// ── 法人番号ヘルパー (2026-09-28 ConteCafe) ─────────────────────────────────
//   登記簿の「会社法人等番号」は12桁、国税庁の「法人番号」は先頭に検査用数字を
//   足した13桁で別物。12桁しか手元にない店主が0埋めして無効な番号を作ってしまう
//   事故が実際に起きたため、12桁入力は国税庁告示の計算式で正しい13桁に自動変換する。
function corporateCheckDigit(base12: string): number {
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += Number(base12[12 - n]) * (n % 2 === 1 ? 1 : 2);
  return 9 - (sum % 9);
}
/** 12桁→13桁に変換 / 13桁は検査用数字を照合。value=確定13桁, error=不正の理由 */
function normalizeCorporateNumber(raw: string): { value?: string; error?: string } {
  const d = (raw ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12) return { value: String(corporateCheckDigit(d)) + d };
  if (d.length === 13) {
    if (Number(d[0]) === corporateCheckDigit(d.slice(1))) return { value: d };
    return { error: '法人番号が正しくないようです。登記簿の12桁（会社法人等番号）をお持ちの場合は、0を足さず12桁のまま入力してください（自動で13桁に変換されます）' };
  }
  return { error: `法人番号（13桁、または登記の12桁 — 現在${d.length}桁）` };
}

const DRAFT_KEY_PREFIX = 'bank-setup-draft-v2-';
const BUSINESS_TYPE_KEY = 'store-business-type';
function loadSavedBusinessType(): 'individual' | 'company' {
  try { const v = localStorage.getItem(BUSINESS_TYPE_KEY); return v === 'company' ? 'company' : 'individual'; } catch (_) { return 'individual'; }
}
// ★ 生年月日の月/日のゼロ埋めを外す (2026-08-05)
//   Stripe API は月/日を2桁ゼロ埋め('08')で返すが、フォームの月・日は<select>で
//   option の value はゼロ埋めなし('8')。文字列が一致しないと select は空欄になり、
//   「他の項目は引き継がれるのに生年月日だけ入らない」状態になる
//   (1〜9月・1〜9日が全滅。年は<input type=number>なので影響なし)。
//   Stripeからの取り込みと、端末に残った旧ドラフトの復元の【両方】で通すこと。
// ★ 郵便番号は必ず「半角数字7桁」に正規化してから state に入れる (2026-08-05)。
//   全角数字やハイフン付き("569-1123")のまま入ると、送信ボタンが押せない/
//   サーバーが空文字を Stripe に送って更新まるごと失敗する、のどちらかになる。
function normalizeZip(v: string): string {
  return (v ?? '')
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, 7);
}

function stripDobPad(v: string): string {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? String(n) : '';
}

type DraftState = {
  lastNameKanji: string; firstNameKanji: string;
  lastNameKana: string;  firstNameKana: string;
  phone: string; email: string;
  dobYear: string; dobMonth: string; dobDay: string;
  postalCode: string;
  stateKanji: string; cityKanji: string; townKanji: string; line1Kanji: string;
  stateKana: string;  cityKana: string;  townKana: string;  line1Kana: string;
  productDescription: string; businessUrl: string;
  bankName: string; bankCode: string; branchCode: string;
  accountNumber: string; holderName: string;
  companyNameKanji?: string; companyNameKana?: string;
  companyNameLatin?: string; companyTaxId?: string;
  companyStructure?: string;
  representativeTitle?: string;
};
function draftKey(storeId: number) { return `${DRAFT_KEY_PREFIX}${storeId}`; }
function saveDraft(storeId: number, d: DraftState) {
  try { localStorage.setItem(draftKey(storeId), JSON.stringify(d)); } catch (_) {}
}
function loadDraft(storeId: number): Partial<DraftState> {
  // 旧 v1 キーを削除してクリーンアップ
  try { localStorage.removeItem('bank-setup-draft-v1'); } catch (_) {}
  try { const r = localStorage.getItem(draftKey(storeId)); return r ? JSON.parse(r) : {}; } catch (_) { return {}; }
}
function clearDraft(storeId: number) {
  try { localStorage.removeItem(draftKey(storeId)); } catch (_) {}
}

// ── 全角カタカナ → 半角カタカナ変換（Stripe JP 口座名義に必要）──────────────────
function toHalfWidthKana(str: string): string {
  const map: Record<string, string> = {
    'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ',
    'カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
    'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ',
    'タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
    'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ',
    'ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
    'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ',
    'ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ',
    'ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ',
    'ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
    'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ',
    'ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
    'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ',
    'バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
    'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ',
    'ァ':'ｧ','ィ':'ｨ','ゥ':'ｩ','ェ':'ｪ','ォ':'ｫ',
    'ッ':'ｯ','ャ':'ｬ','ュ':'ｭ','ョ':'ｮ',
    'ー':'ｰ','・':'･','「':'｢','」':'｣','。':'｡','、':'､',
    '　':' ',
  };
  return str.split('').map(c => map[c] ?? c).join('');
}

// ── 都道府県リスト ──────────────────────────────────────────────────
const PREFECTURES_KANJI = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
  '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
  '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
  '熊本県','大分県','宮崎県','鹿児島県','沖縄県',
];
const PREFECTURES_KANA = [
  'ホッカイドウ','アオモリケン','イワテケン','ミヤギケン','アキタケン','ヤマガタケン','フクシマケン',
  'イバラキケン','トチギケン','グンマケン','サイタマケン','チバケン','トウキョウト','カナガワケン',
  'ニイガタケン','トヤマケン','イシカワケン','フクイケン','ヤマナシケン','ナガノケン','ギフケン',
  'シズオカケン','アイチケン','ミエケン','シガケン','キョウトフ','オオサカフ','ヒョウゴケン',
  'ナラケン','ワカヤマケン','トットリケン','シマネケン','オカヤマケン','ヒロシマケン','ヤマグチケン',
  'トクシマケン','カガワケン','エヒメケン','コウチケン','フクオカケン','サガケン','ナガサキケン',
  'クマモトケン','オオイタケン','ミヤザキケン','カゴシマケン','オキナワケン',
];

function translateRequirement(key: string): string {
  const map: Record<string, string> = {
    'individual.first_name': '代表者名（名）',
    'individual.last_name': '代表者名（姓）',
    'individual.first_name_kana': '代表者名カナ（名）',
    'individual.last_name_kana': '代表者名カナ（姓）',
    'individual.dob.day': '生年月日（日）',
    'individual.dob.month': '生年月日（月）',
    'individual.dob.year': '生年月日（年）',
    'individual.address_kanji.postal_code': '住所（郵便番号）',
    'individual.address_kanji.state': '住所（都道府県）',
    'individual.address_kanji.city': '住所（市区町村）',
    'individual.address_kanji.town': '住所（町名）',
    'individual.address_kana.state': 'カナ住所（都道府県）',
    'individual.address_kana.city': 'カナ住所（市区町村）',
    'individual.address_kana.town': 'カナ住所（町名）',
    'business_profile.product_description': '事業内容の説明',
    'business_profile.url': 'ウェブサイトURL',
    'business_type': '事業形態',
    'tos_acceptance.date': '利用規約への同意',
    'external_account': '振込先口座',
    'company.name': '法人名',
    'company.name_kana': '法人名（カナ）',
    'representative.first_name': '代表者名（名）',
    'representative.last_name': '代表者名（姓）',
    'representative.first_name_kana': '代表者名カナ（名）',
    'representative.last_name_kana': '代表者名カナ（姓）',
    'representative.dob.day': '代表者 生年月日（日）',
    'representative.dob.month': '代表者 生年月日（月）',
    'representative.dob.year': '代表者 生年月日（年）',
    'representative.address_kanji.state': '代表者住所（都道府県）',
    'representative.relationship.representative': '代表者の関係性確認',
  };
  return map[key] ?? key;
}

// ── Stripe フィールド → セクショングループ マッピング ─────────────────────────
const STRIPE_FIELD_TO_GROUP: Record<string, string> = {
  'individual.first_name': 'name', 'individual.last_name': 'name',
  'individual.first_name_kanji': 'name', 'individual.last_name_kanji': 'name',
  'individual.first_name_kana': 'name', 'individual.last_name_kana': 'name',
  'individual.phone': 'name', 'individual.email': 'name',
  'representative.first_name': 'name', 'representative.last_name': 'name',
  'representative.first_name_kanji': 'name', 'representative.last_name_kanji': 'name',
  'representative.first_name_kana': 'name', 'representative.last_name_kana': 'name',
  'representative.relationship.representative': 'name',
  'individual.dob.day': 'dob', 'individual.dob.month': 'dob', 'individual.dob.year': 'dob',
  'representative.dob.day': 'dob', 'representative.dob.month': 'dob', 'representative.dob.year': 'dob',
  'individual.address_kanji.postal_code': 'address', 'individual.address_kanji.state': 'address',
  'individual.address_kanji.city': 'address', 'individual.address_kanji.town': 'address',
  'individual.address_kanji.line1': 'address', 'individual.address_kana.postal_code': 'address',
  'individual.address_kana.state': 'address', 'individual.address_kana.city': 'address',
  'individual.address_kana.town': 'address', 'individual.address_kana.line1': 'address',
  'representative.address_kanji.state': 'address', 'representative.address_kanji.city': 'address',
  'representative.address_kanji.postal_code': 'address',
  'business_profile.product_description': 'business', 'business_profile.url': 'business',
  'business_profile.mcc': 'business',
  'external_account': 'bank',
  'individual.verification.document': 'document', 'individual.verification.document.front': 'document',
  'individual.verification.document.back': 'document', 'individual.id_number': 'document',
  'individual.verification.additional_document': 'bizLicense',
  'individual.verification.additional_document.front': 'bizLicense',
  'individual.verification.additional_document.back': 'bizLicense',
  'company.verification.document': 'bizLicense', 'company.verification.document.front': 'bizLicense',
  'company.name': 'company', 'company.name_kana': 'company', 'company.name_kanji': 'company',
  'company.tax_id': 'company', 'company.structure': 'company',
  'business_type': 'businessType',
};

type StripeGroupStatus = { type: 'error'; reasons: string[] } | { type: 'required' } | { type: 'ok' } | null;

// ── 共通 UI パーツ ──────────────────────────────────────────────────
const inputClass = 'w-full px-4 py-3 border-2 border-gray-200 rounded-xl text-sm focus:border-orange-400 focus:outline-none transition-colors';
const selectClass = 'w-full px-4 py-3 border-2 border-gray-200 rounded-xl text-sm focus:border-orange-400 focus:outline-none transition-colors bg-white';

function FormSection({ title, icon, children, stripeStatus }: {
  title: string; icon: React.ReactNode; children: React.ReactNode;
  stripeStatus?: StripeGroupStatus;
}) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm overflow-hidden ${stripeStatus?.type === 'error' ? 'ring-2 ring-red-400' : stripeStatus?.type === 'ok' ? 'ring-1 ring-green-300' : ''}`}>
      <div className={`px-5 py-3.5 flex items-center justify-between gap-2 ${stripeStatus?.type === 'error' ? 'bg-red-50' : stripeStatus?.type === 'ok' ? 'bg-green-50' : 'bg-white'}`}>
        <h2 className="font-black text-gray-900 text-base flex items-center gap-2">{icon}{title}</h2>
        {stripeStatus?.type === 'error' && (
          <span className="text-[10px] font-black bg-red-500 text-white px-2 py-0.5 rounded-full shrink-0">要修正</span>
        )}
        {stripeStatus?.type === 'ok' && (
          <span className="text-[10px] font-black bg-green-500 text-white px-2 py-0.5 rounded-full shrink-0 flex items-center gap-0.5">✓ 確認済み</span>
        )}
        {stripeStatus?.type === 'required' && (
          <span className="text-[10px] font-black bg-orange-400 text-white px-2 py-0.5 rounded-full shrink-0">入力が必要</span>
        )}
      </div>
      {stripeStatus?.type === 'error' && stripeStatus.reasons.length > 0 && (
        <div className="mx-5 mt-3 bg-red-50 border border-red-200 rounded-xl p-3">
          <p className="text-xs font-black text-red-700 mb-1">⚠️ 修正が必要な内容</p>
          {stripeStatus.reasons.map((r, i) => (
            <p key={i} className="text-xs text-red-600 leading-relaxed">• {r}</p>
          ))}
        </div>
      )}
      <div className="px-5 pb-5 pt-4 space-y-4">
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1.5">{hint}</p>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
export default function StripeBankSetup() {
  const [location, navigate] = useLocation();
  const { store, loading: loadingStore, fetchError, refetch } = useMyStore();
  const { session, refreshProfile } = useAuth();
  const notifiedRef = useRef(false);

  // ── URL パラム or localStorage から事業形態を復元 ──
  const urlType = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('type');
  // URLパラムが明示的に指定された場合のみ引き継ぐ。それ以外は常に個人事業主スタート
  const initialBusinessType: 'individual' | 'company' = urlType === 'company' ? 'company' : 'individual';

  // ── 銀行口座情報 ──（draft は store.id 確定後に useEffect で復元）
  const [bankName, setBankName]           = useState('');
  const [bankCode, setBankCode]           = useState('');
  const [branchCode, setBranchCode]       = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [holderName, setHolderName]       = useState('');
  const [tosAgreed, setTosAgreed]         = useState(false);
  const [tosTime, setTosTime]             = useState<number | null>(null);

  // ── KYC: 事業形態 ──
  const [businessType, setBusinessType] = useState<'individual' | 'company'>(initialBusinessType);

  // ── KYC: 法人情報（法人の場合のみ） ──
  const [companyNameKanji, setCompanyNameKanji]         = useState('');
  const [companyNameKana, setCompanyNameKana]           = useState('');
  const [companyNameLatin, setCompanyNameLatin]         = useState('');
  const [companyTaxId, setCompanyTaxId]                 = useState('');
  const [companyStructure, setCompanyStructure]         = useState('');
  const [representativeTitle, setRepresentativeTitle]   = useState('代表取締役');

  // ── KYC: 代表者氏名 ──
  const [lastNameKanji, setLastNameKanji]   = useState('');
  const [firstNameKanji, setFirstNameKanji] = useState('');
  const [lastNameKana, setLastNameKana]     = useState('');
  const [firstNameKana, setFirstNameKana]   = useState('');
  const [phone, setPhone]                   = useState('');
  const [email, setEmail]                   = useState('');

  // ── KYC: 生年月日 ──
  const [dobYear, setDobYear]   = useState('');
  const [dobMonth, setDobMonth] = useState('');
  const [dobDay, setDobDay]     = useState('');

  // ── KYC: 住所 ──
  const [postalCode, setPostalCode] = useState('');
  const [stateKanji, setStateKanji] = useState('');
  const [cityKanji, setCityKanji]   = useState('');
  const [townKanji, setTownKanji]   = useState('');
  const [line1Kanji, setLine1Kanji] = useState('');
  const [stateKana, setStateKana]   = useState('');
  const [cityKana, setCityKana]     = useState('');
  const [townKana, setTownKana]     = useState('');
  const [line1Kana, setLine1Kana]   = useState('');

  // ── KYC: 事業内容 ──
  const [productDescription, setProductDescription] = useState('');
  const [businessUrl, setBusinessUrl]               = useState('');

  // ── store.id が確定したら、そのストア専用ドラフトを読み込んで復元 ──
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    if (!store?.id || draftLoadedRef.current) return;
    draftLoadedRef.current = true;
    const d = loadDraft(store.id);
    if (d.bankName)           setBankName(d.bankName);
    if (d.bankCode)           setBankCode(d.bankCode);
    if (d.branchCode)         setBranchCode(d.branchCode);
    if (d.accountNumber)      setAccountNumber(d.accountNumber);
    if (d.holderName)         setHolderName(d.holderName);
    if (d.companyNameKanji)   setCompanyNameKanji(d.companyNameKanji);
    if (d.companyNameKana)    setCompanyNameKana(d.companyNameKana);
    if (d.companyNameLatin)   setCompanyNameLatin(d.companyNameLatin);
    if (d.companyTaxId)       setCompanyTaxId(d.companyTaxId);
    if (d.representativeTitle) setRepresentativeTitle(d.representativeTitle);
    if (d.lastNameKanji)      setLastNameKanji(d.lastNameKanji);
    if (d.firstNameKanji)     setFirstNameKanji(d.firstNameKanji);
    if (d.lastNameKana)       setLastNameKana(d.lastNameKana);
    if (d.firstNameKana)      setFirstNameKana(d.firstNameKana);
    if (d.phone)              setPhone(d.phone);
    if (d.email)              setEmail(d.email);
    if (d.dobYear)            setDobYear(d.dobYear);
    // ★ 端末に保存された下書きに、旧バグ時代のゼロ埋め値('08')が残っている場合がある。
    //   そのまま入れると<select>のoption値('8')と一致せず空欄のままになり、しかも
    //   下書きが「値あり」扱いになるためStripeからの再取得もスキップされ、
    //   【アプリを入れ直すまで永久に生年月日が入らない】状態になる(高槻駅 2026-08-05)。
    if (d.dobMonth)           setDobMonth(stripDobPad(d.dobMonth));
    if (d.dobDay)             setDobDay(stripDobPad(d.dobDay));
    if (d.postalCode)         setPostalCode(normalizeZip(d.postalCode));
    if (d.stateKanji)         setStateKanji(d.stateKanji);
    if (d.cityKanji)          setCityKanji(d.cityKanji);
    if (d.townKanji)          setTownKanji(d.townKanji);
    if (d.line1Kanji)         setLine1Kanji(d.line1Kanji);
    if (d.stateKana)          setStateKana(d.stateKana);
    if (d.cityKana)           setCityKana(d.cityKana);
    if (d.townKana)           setTownKana(d.townKana);
    if (d.line1Kana)          setLine1Kana(d.line1Kana);
    if (d.productDescription) setProductDescription(d.productDescription);
    if (d.businessUrl)        setBusinessUrl(d.businessUrl);
  }, [store?.id]);

  // ── 本人確認書類 ──
  const [docFrontFile, setDocFrontFile]       = useState<File | null>(null);
  const [docFrontPreview, setDocFrontPreview] = useState<string | null>(null);
  const [docBackFile, setDocBackFile]         = useState<File | null>(null);
  const [docBackPreview, setDocBackPreview]   = useState<string | null>(null);
  const [docError, setDocError]               = useState<string | null>(null);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef  = useRef<HTMLInputElement>(null);

  // ── 営業許可証 ──
  const [bizLicenseFile, setBizLicenseFile]       = useState<File | null>(null);
  const [bizLicensePreview, setBizLicensePreview] = useState<string | null>(null);
  const [bizLicenseNumber, setBizLicenseNumber]   = useState('');
  const bizLicenseInputRef = useRef<HTMLInputElement>(null);

  // ── UI 状態 ──
  const [loading, setLoading]           = useState(false);
  const [zipLoading, setZipLoading]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [done, setDone]                 = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  // ── Stripe フィールドエラー取得（再送信モード時）──
  const [stripeReqs, setStripeReqs] = useState<{
    currentlyDue: string[];
    errors: { code: string; reason: string; requirement: string }[];
    pendingVerification: string[];
  } | null>(null);

  useEffect(() => {
    if (!store?.stripeAccountId || !store?.id) return;
    // charges/payoutsどちらかが停止中のときStripeの具体的なエラー情報を取得する
    const stripeHasIssue =
      store.stripeChargesEnabled === false || store.stripePayoutsEnabled === false;
    if (!stripeHasIssue) return;
    authedFetch(`${BASE}/api/stores/${store.id}/connect/status`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.requirements) {
          setStripeReqs({
            currentlyDue:        data.requirements.currentlyDue       ?? [],
            errors:              (data.requirements.errors ?? []).map((e: any) => ({
              code: e.code ?? '', reason: e.reason ?? '', requirement: e.requirement ?? '',
            })),
            pendingVerification: data.requirements.pendingVerification ?? [],
          });
        }
      })
      .catch(() => {});
  }, [store?.id, store?.stripeAccountId, store?.stripeChargesEnabled, store?.stripePayoutsEnabled]);

  // ── Stripe 保存済みデータ取得（再申請時のフォーム事前入力用）──
  const stripeDataLoadedRef = useRef(false);
  useEffect(() => {
    if (!store?.stripeAccountId || !store?.id) return;
    if (stripeDataLoadedRef.current) return;
    stripeDataLoadedRef.current = true;
    authedFetch(`${BASE}/api/stores/${store.id}/connect/account-data`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.hasAccount || !data.individual) return;
        const ind = data.individual;
        const biz = data.business ?? {};
        const draft = store.id ? loadDraft(store.id) : {};
        // Stripeの実際の事業形態でフォームを合わせる（localStorage/URLパラムの食い違いを防ぐ）
        if (data.businessType === 'individual' || data.businessType === 'company') {
          setBusinessType(data.businessType);
        }
        // 不備・要再提出フィールドのセット（これらは空欄のまま = ユーザーに入力させる）
        const rejected = new Set<string>(data.rejectedFields ?? []);
        const ok = (stripeKeys: string[]) => stripeKeys.every(k => !rejected.has(k));
        // ドラフトにない & Stripeで問題なかった項目だけ事前入力
        if (!draft.lastNameKanji   && ind.lastNameKanji   && ok(['individual.last_name_kanji',  'individual.last_name']))  setLastNameKanji(ind.lastNameKanji);
        if (!draft.firstNameKanji  && ind.firstNameKanji  && ok(['individual.first_name_kanji', 'individual.first_name'])) setFirstNameKanji(ind.firstNameKanji);
        if (!draft.lastNameKana    && ind.lastNameKana    && ok(['individual.last_name_kana']))   setLastNameKana(ind.lastNameKana);
        if (!draft.firstNameKana   && ind.firstNameKana   && ok(['individual.first_name_kana']))  setFirstNameKana(ind.firstNameKana);
        // 電話番号は常にStripe側データで上書き（draftに +81 形式が残っている可能性があるため）
        if (ind.phone && ok(['individual.phone'])) setPhone(ind.phone);
        if (!draft.email           && ind.email           && ok(['individual.email']))             setEmail(ind.email);
        if (!draft.dobYear         && ind.dobYear         && ok(['individual.dob.year']))          setDobYear(ind.dobYear);
        if (!draft.dobMonth        && ind.dobMonth        && ok(['individual.dob.month']))         setDobMonth(stripDobPad(ind.dobMonth));
        if (!draft.dobDay          && ind.dobDay          && ok(['individual.dob.day']))           setDobDay(stripDobPad(ind.dobDay));
        if (!draft.postalCode      && ind.postalCode      && ok(['individual.address_kanji.postal_code'])) setPostalCode(normalizeZip(ind.postalCode));
        if (!draft.stateKanji      && ind.stateKanji      && ok(['individual.address_kanji.state']))       setStateKanji(ind.stateKanji);
        if (!draft.cityKanji       && ind.cityKanji       && ok(['individual.address_kanji.city']))        setCityKanji(ind.cityKanji);
        if (!draft.townKanji       && ind.townKanji       && ok(['individual.address_kanji.town']))        setTownKanji(ind.townKanji);
        // 建物名は常にStripe側データで上書き（draftに city+town が混入していた可能性があるため）
        if (ok(['individual.address_kanji.line1'])) setLine1Kanji(ind.line1Kanji ?? '');
        if (!draft.stateKana       && ind.stateKana       && ok(['individual.address_kana.state']))        setStateKana(ind.stateKana);
        if (!draft.cityKana        && ind.cityKana        && ok(['individual.address_kana.city']))         setCityKana(ind.cityKana);
        if (!draft.townKana        && ind.townKana        && ok(['individual.address_kana.town']))         setTownKana(ind.townKana);
        if (ok(['individual.address_kana.line1'])) setLine1Kana(ind.line1Kana ?? '');
        if (!draft.productDescription && biz.productDescription && ok(['business_profile.product_description'])) setProductDescription(biz.productDescription);
        if (!draft.businessUrl        && biz.url          && ok(['business_profile.url']))                 setBusinessUrl(biz.url);
        if (data.company && data.businessType === 'company') {
          if (!draft.companyNameKanji && data.company.nameKanji && ok(['company.name_kanji'])) setCompanyNameKanji(data.company.nameKanji);
          if (!draft.companyNameKana  && data.company.nameKana  && ok(['company.name_kana']))  setCompanyNameKana(data.company.nameKana);
          if (!draft.companyStructure && data.company.structure && ok(['company.structure']))   setCompanyStructure(data.company.structure);
        }
      })
      .catch(() => {});
  }, [store?.id, store?.stripeAccountId]);

  // ── グループ単位のStripeステータスを計算するヘルパー ──
  const getGroupStatus = (group: string): StripeGroupStatus => {
    if (!stripeReqs || !store?.stripeAccountId) return null;
    const errorsForGroup = stripeReqs.errors.filter(
      e => STRIPE_FIELD_TO_GROUP[e.requirement] === group
    );
    if (errorsForGroup.length > 0) {
      return { type: 'error', reasons: errorsForGroup.map(e => stripeErrCodeLabel(e.code) || stripeReasonLabel(e.reason)).filter(Boolean) };
    }
    const requiredForGroup = stripeReqs.currentlyDue.some(
      f => STRIPE_FIELD_TO_GROUP[f] === group
    );
    if (requiredForGroup) return { type: 'required' };
    return { type: 'ok' };
  };

  // ── 下書き自動保存（30秒ごと + state変化から2秒後）──
  const draftStateRef = useRef<DraftState>({
    lastNameKanji, firstNameKanji, lastNameKana, firstNameKana,
    phone, email, dobYear, dobMonth, dobDay,
    postalCode, stateKanji, cityKanji, townKanji, line1Kanji,
    stateKana, cityKana, townKana, line1Kana,
    productDescription, businessUrl,
    bankName, bankCode, branchCode, accountNumber, holderName,
    companyNameKanji, companyNameKana, companyNameLatin, companyTaxId, representativeTitle,
  });
  useEffect(() => {
    draftStateRef.current = {
      lastNameKanji, firstNameKanji, lastNameKana, firstNameKana,
      phone, email, dobYear, dobMonth, dobDay,
      postalCode, stateKanji, cityKanji, townKanji, line1Kanji,
      stateKana, cityKana, townKana, line1Kana,
      productDescription, businessUrl,
      bankName, bankCode, branchCode, accountNumber, holderName,
      companyNameKanji, companyNameKana, companyNameLatin, companyTaxId, representativeTitle,
    };
    if (store?.id) {
      const t = setTimeout(() => saveDraft(store.id, draftStateRef.current), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [store?.id, lastNameKanji, firstNameKanji, lastNameKana, firstNameKana,
      phone, email, dobYear, dobMonth, dobDay,
      postalCode, stateKanji, cityKanji, townKanji, line1Kanji,
      stateKana, cityKana, townKana, line1Kana,
      productDescription, businessUrl,
      bankName, bankCode, branchCode, accountNumber, holderName,
      companyNameKanji, companyNameKana, companyNameLatin, companyTaxId, representativeTitle]);

  // 30秒おきにも保存
  useEffect(() => {
    const interval = setInterval(() => {
      if (store?.id) saveDraft(store.id, draftStateRef.current);
    }, 30_000);
    return () => clearInterval(interval);
  }, [store?.id]);

  // ── 郵便番号自動補完 ──
  const lookupZip = useCallback(async (zip: string) => {
    const clean = zip.replace(/\D/g, '');
    if (clean.length !== 7) return;
    setZipLoading(true);
    try {
      const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${clean}`);
      const data = await res.json();
      const addr = data?.results?.[0];
      if (addr) {
        const prefIdx = PREFECTURES_KANJI.indexOf(addr.address1);
        if (prefIdx >= 0) {
          setStateKanji(PREFECTURES_KANJI[prefIdx]);
          setStateKana(PREFECTURES_KANA[prefIdx]);
        }
        setCityKanji(addr.address2 ?? '');
        setTownKanji(addr.address3 ?? '');
        setCityKana(addr.kana2 ?? '');
        setTownKana(addr.kana3 ?? '');
      }
    } catch (_) {}
    finally { setZipLoading(false); }
  }, []);

  const handlePostalCodeChange = (v: string) => {
    // ★ 日本語入力のままだと全角数字(５６９...)が入る。旧実装はこれを丸ごと捨てて
    //   いたため郵便番号が空になり、サーバー側でStripeへ空文字が送られて
    //   再提出が丸ごと失敗していた(2026-08-05)。半角に直してから数字だけ残す。
    const clean = v
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\D/g, '')
      .slice(0, 7);
    setPostalCode(clean);
    if (clean.length === 7) lookupZip(clean);
  };

  const handlePrefectureChange = (idx: string) => {
    const i = parseInt(idx);
    if (isNaN(i)) return;
    setStateKanji(PREFECTURES_KANJI[i] ?? '');
    setStateKana(PREFECTURES_KANA[i] ?? '');
  };

  const handleDocFileChange = (side: 'front' | 'back') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // ★ 同じファイルを再選択できるよう即リセット
    if (!file) return;
    setDocError(null);
    // ★ File を直接 blob URL 経由で渡し、巨大HEICでもメモリを圧迫せず Image にロード。
    //   失敗時のみエラー表示（巨大 dataURL を state に入れない）。
    try {
      const compressed = await compressIdImageFromFile(file);
      if (side === 'front') { setDocFrontFile(file); setDocFrontPreview(compressed); }
      else                  { setDocBackFile(file);  setDocBackPreview(compressed);  }
    } catch (err: any) {
      setDocError(err?.message ?? '画像を取り込めませんでした。JPEG または PNG で撮り直してください。');
    }
  };

  const handleBizLicenseChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // ★ 同じファイルを再選択できるよう即リセット
    if (!file) return;
    // ★ PDF はそのまま data URL に変換（PDFは元から軽量）。画像は blob URL 経由で圧縮。
    try {
      if (file.type === 'application/pdf') {
        const raw: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target?.result as string);
          reader.onerror = () => reject(new Error('PDFが読み込めませんでした。'));
          reader.readAsDataURL(file);
        });
        setBizLicenseFile(file);
        setBizLicensePreview(raw);
      } else {
        const compressed = await compressIdImageFromFile(file);
        setBizLicenseFile(file);
        setBizLicensePreview(compressed);
      }
    } catch (err: any) {
      setDocError(err?.message ?? 'ファイルを取り込めませんでした。JPEG・PNG・PDF を選んでください。');
    }
  };

  const handleTosChange = (checked: boolean) => {
    setTosAgreed(checked);
    setTosTime(checked ? Date.now() : null);
  };

  // ── バリデーション：不足項目リスト ──
  const missingFields: string[] = [];
  if (businessType === 'company' && !companyNameKanji.trim()) missingFields.push('法人名（漢字）');
  if (businessType === 'company' && !companyNameKana.trim())  missingFields.push('法人名（カナ）');
  if (businessType === 'company' && !companyNameLatin.trim()) missingFields.push('法人名（ローマ字）— 必須');
  const taxIdNorm = businessType === 'company' ? normalizeCorporateNumber(companyTaxId) : null;
  if (businessType === 'company' && !taxIdNorm?.value) missingFields.push(taxIdNorm?.error ?? '法人番号');
  if (!lastNameKanji.trim() || !firstNameKanji.trim()) missingFields.push('代表者氏名（漢字）');
  if (!lastNameKana.trim()   || !firstNameKana.trim())  missingFields.push('代表者氏名（カタカナ）');
  if (phone.trim().length < 10)  missingFields.push(`電話番号（現在${phone.trim().length}桁 / 10桁以上）`);
  if (!email.trim().includes('@')) missingFields.push('メールアドレス（正しい形式で入力）');
  if (!dobYear || !dobMonth || !dobDay)                 missingFields.push('生年月日');
  if (postalCode.length !== 7)                          missingFields.push('郵便番号（7桁）');
  if (!stateKanji)                                      missingFields.push('都道府県');
  if (!cityKanji.trim() || !townKanji.trim())           missingFields.push('住所（市区町村・町名）漢字');
  if (!line1Kanji.trim())                                missingFields.push('住所（番地・建物名）漢字');
  if (!cityKana.trim()  || !townKana.trim())            missingFields.push('住所（市区町村・町名）カナ');
  if (!line1Kana.trim())                                 missingFields.push('住所（番地・建物名）カナ');
  if (productDescription.trim().length < 10)            missingFields.push(`事業内容の説明（現在${productDescription.trim().length}文字 / 10文字以上必要）`);
  // 口座登録済み && Stripeから「external_account再登録が必要」フラグが立っていない場合のみスキップ
  const bankAlreadyRegistered = !!store?.stripeAccountId && !store?.stripeNeedsBankReregister;
  if (!bankAlreadyRegistered) {
    if (!bankName.trim())        missingFields.push('銀行名');
    if (bankCode.length !== 4)   missingFields.push(`銀行コード（${bankCode.length}桁 → 4桁で入力）`);
    if (branchCode.length !== 3) missingFields.push(`支店コード（${branchCode.length}桁 → 3桁で入力）`);
    if (!accountNumber.trim())   missingFields.push('口座番号');
    if (!holderName.trim())      missingFields.push('口座名義（カタカナ）');
  }
  if (!docFrontPreview)                                 missingFields.push('本人確認書類（表面）の写真');
  if (!docBackPreview)                                  missingFields.push('本人確認書類（裏面）の写真');
  if (!bizLicensePreview)                               missingFields.push('営業許可証の画像');
  if (!bizLicenseNumber.trim())                         missingFields.push('営業許可証番号');
  if (!tosAgreed)                                       missingFields.push('利用規約への同意');

  const canSubmit = !loading && missingFields.length === 0;

  // ── 送信 ──
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store || !tosAgreed || !tosTime || !canSubmit) return;

    setLoading(true);
    setError(null);
    setSubmitStatus('口座情報を検証中...');

    // 90秒タイムアウト用 AbortController
    const controller = new AbortController();
    abortRef.current = controller;
    // APIが早期にレスポンスを返すので30秒で十分
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 30_000);

    try {
      let bankTokenId: string | null = null;

      if (bankAlreadyRegistered) {
        // 口座登録済み → トークン生成不要（KYC情報のみ再送）
        setSubmitStatus('本人確認情報をサーバーに送信中...');
      } else {
        // ① Stripe.js で銀行口座トークン生成（バックエンドと同じ公開鍵を使用）
        setSubmitStatus('決済サーバーに接続中...');
        const stripe = await getStripeInstance();
        if (!stripe) throw new Error('Stripeの読み込みに失敗しました。STRIPE_PUBLISHABLE_KEY の設定を確認してください。');

        const routingNumber = bankCode.trim().padStart(4, '0') + branchCode.trim().padStart(3, '0');
        // Stripe JP は半角カタカナを要求するため自動変換
        const holderNameHalf = toHalfWidthKana(holderName.trim());
        const result = await (stripe as any).createToken('bank_account', {
          country: 'JP', currency: 'jpy',
          routing_number: routingNumber,
          account_number: accountNumber.trim(),
          account_holder_name: holderNameHalf,
          account_holder_type: 'individual',
        });

        if (result.error) {
          // ★ Stripe.js の英語エラーメッセージを日本語化してから表示
          const rawMsg = result.error.message ?? '';
          const rawCode = (result.error as any).code ?? '';
          const localized =
            stripeErrCodeLabel(rawCode) ||
            stripeReasonLabel(rawMsg) ||
            '口座情報が正しくありません。 入力内容をご確認ください。';
          setError(localized);
          return;
        }
        bankTokenId = result.token.id;
        setSubmitStatus('登録情報をサーバーに送信中...');
      }

      // ② 全データを一括送信（口座登録 + KYC + 書類アップロード + DB approved 更新）
      const res = await authedFetch(`${BASE}/api/stores/${store.id}/connect/bank-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          bankToken:    bankTokenId,
          tosTimestamp: tosTime,
          businessType,
          kycData: {
            firstNameKanji: firstNameKanji.trim(),
            lastNameKanji:  lastNameKanji.trim(),
            firstNameKana:  firstNameKana.trim(),
            lastNameKana:   lastNameKana.trim(),
            phone:          phone.trim(),
            email:          email.trim() || undefined,
            dobYear:        parseInt(dobYear),
            dobMonth:       parseInt(dobMonth),
            dobDay:         parseInt(dobDay),
            postalCode,
            stateKanji, cityKanji: cityKanji.trim(), townKanji: townKanji.trim(),
            line1Kanji: line1Kanji.trim() || undefined,
            stateKana,  cityKana:  cityKana.trim(),  townKana:  townKana.trim(),
            line1Kana:  line1Kana.trim() || undefined,
            productDescription: productDescription.trim() || undefined,
            businessUrl:        businessUrl.trim() || undefined,
            ...(businessType === 'company' ? {
              companyNameKanji:     companyNameKanji.trim()              || undefined,
              companyNameKana:      companyNameKana.trim()               || undefined,
              companyNameLatin:     companyNameLatin.trim()              || undefined,
              // 12桁(登記番号)は検査用数字を付けた正式な13桁に変換して送信 (2026-09-28)
              companyTaxId:         taxIdNorm?.value ?? (companyTaxId.replace(/-/g, '').trim() || undefined),
              companyStructure:     companyStructure                     || undefined,
              representativeTitle:  representativeTitle.trim()           || '代表取締役',
            } : {}),
          },
          // 本人確認書類（base64 data URL のまま送信）
          docFrontBase64: docFrontPreview,
          docFrontMime:   docFrontFile?.type ?? 'image/jpeg',
          docBackBase64:  docBackPreview ?? undefined,
          docBackMime:    docBackFile?.type ?? undefined,
          // 営業許可証
          bizLicenseBase64:   bizLicensePreview ?? undefined,
          bizLicenseMime:     bizLicenseFile?.type ?? undefined,
          bizLicenseNumber:   bizLicenseNumber.trim() || undefined,
        }),
      });
      clearTimeout(timeoutId);

      const data = await res.json();
      if (!res.ok) {
        const hint = data.param ? `（項目: ${data.param}）` : '';
        setError(`${data.message ?? '登録に失敗しました。'}${hint}`);
        return;
      }

      // kycWarning: 個人情報フィールドが不足している場合のみ（書類未送信は対象外）
      if (data.kycWarning) {
        // ★ 2026-08-05 実態どおりに書き分ける。
        //   旧実装は常に「個人情報の一部が正しく送信されませんでした」だけを出していたが、
        //   本人確認書類は別経路で送信済みなので、店主が「全部失敗した」と誤解して
        //   同じ書類を何度も送り直す原因になっていた(高槻駅)。
        const missing: string[] = Array.isArray(data.kycMissingFields) ? data.kycMissingFields : [];
        const labels = Array.from(new Set(missing.map((f: string): string | null => {
          if (/dob/.test(f))                        return '生年月日';
          if (/(first_name|last_name)/.test(f))     return 'お名前（漢字・カナ）';
          if (/postal_code/.test(f))                return '郵便番号';
          if (/address/.test(f))                    return 'ご住所';
          if (/phone/.test(f))                      return '電話番号';
          if (/email/.test(f))                      return 'メールアドレス';
          if (/id_number/.test(f))                  return 'マイナンバー・法人番号';
          if (/tos_acceptance/.test(f))             return '利用規約への同意';
          if (/external_account|bank/.test(f))      return '振込先口座';
          if (/business_profile|product_description|url|mcc/.test(f)) return '事業内容の情報';
          return null;
        }).filter((v): v is string => v !== null)));

        const head = data.docsReceived
          ? '✅ 本人確認書類は受け付けました。\n\n⚠️ ただし、お客様情報の更新だけが完了しませんでした。'
          : '⚠️ お客様情報の更新が完了しませんでした。';
        // ★ 2026-09-02 サーバーが返す Stripe の具体的なエラー文 (kycErrorMessage) を表示する。
        //   旧実装はこれを無視して汎用文だけを出しており、mokopan は「住所の町名が
        //   特定できない」という明確な原因を知らされないまま何度も再提出していた。
        const stripeMsg = typeof data.kycErrorMessage === 'string' && data.kycErrorMessage.trim()
          ? (stripeReasonLabel(data.kycErrorMessage) || data.kycErrorMessage)
          : '';
        const body = labels.length > 0
          ? `\n\n【ご確認いただきたい項目】\n${labels.map(l => `・${l}`).join('\n')}\n\n上記を身分証の記載どおりに直して、もう一度送信してください。`
          : stripeMsg
            ? `\n\n【エラー内容】\n${stripeMsg}\n\n修正のうえ、もう一度送信してください。`
            : '\n\n入力内容をご確認のうえ、もう一度送信してください。';
        const tail = data.docsReceived
          ? '\n\n※書類は届いていますので、同じ書類を何度も送り直す必要はありません。'
          : '';
        setError(head + body + tail);
        try { await refetch(); } catch (_) {}
        return;
      }

      // ③ 完了 → 下書き削除・プロフィール更新・マイページへ
      setSubmitStatus('登録完了！');
      if (store?.id) clearDraft(store.id);
      try { await refreshProfile(); } catch (_) {}
      try { await refetch(); } catch (_) {}
      navigate('/mypage');
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        // タイムアウト → ステータスは applied 更新済みなのでマイページへ
        setSubmitStatus('処理完了！');
        if (store?.id) clearDraft(store.id);
        try { await refreshProfile(); } catch (_) {}
        try { await refetch(); } catch (_) {}
        navigate('/mypage');
        return;
      }
      // エラー → 画面はそのまま、エラーメッセージ表示（入力内容は保持）
      console.error('[StripeBankSetup] エラー:', err);
      setError(err?.message ?? '予期しないエラーが発生しました。');
    } finally {
      setLoading(false);
      setSubmitStatus('');
      abortRef.current = null;
    }
  };

  // ────────── ローディング ──────────
  if (loadingStore) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-orange-400 animate-spin" />
      </div>
    );
  }

  // ────────── 店舗なし（取得エラー or 未登録）──────────
  if (!store) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="text-center max-w-sm md:max-w-2xl">
          <AlertCircle className="w-12 h-12 text-orange-400 mx-auto mb-3" />
          <p className="font-black text-gray-900 mb-1">
            {fetchError ? '読み込みに失敗しました' : '店舗が見つかりません'}
          </p>
          <p className="text-sm text-gray-500 mb-4">
            {fetchError
              ? 'ネットワーク状況を確認して、再度お試しください。'
              : '先に店舗申請を完了してください。'}
          </p>
          {fetchError ? (
            <button onClick={refetch}
              className="bg-primary text-white font-bold px-6 py-3 rounded-2xl w-full mb-3">
              再読み込み
            </button>
          ) : null}
          <button onClick={() => navigate('/store-onboarding')}
            className={`font-bold px-6 py-3 rounded-2xl w-full ${fetchError ? 'bg-white text-orange-500 border-2 border-orange-300' : 'bg-orange-500 text-white'}`}>
            店舗申請へ
          </button>
        </div>
      </div>
    );
  }

  // ────────── 口座登録済み（Stripeアカウント連携済み、または申請中）──────────
  // 通過（フォームを表示）する条件:
  //   - status === 'rejected'（再設定のため通過）
  //   - stripeAccountId が null（STEP1 が失敗したまま、またはまだ未登録）
  //   - stripeChargesEnabled === false（Stripe 情報が不完全 → 再送信が必要）
  //   - stripePayoutsEnabled === false（入金停止 → 本人確認書類の再提出が必要）
  const stripeIncomplete = !!store.stripeAccountId && (
    store.stripeChargesEnabled === false ||
    store.stripePayoutsEnabled === false
  );
  const noStripeAccount  = !store.stripeAccountId;
  if (
    store.status !== 'rejected' &&
    !noStripeAccount &&
    !stripeIncomplete
  ) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="text-center max-w-sm md:max-w-2xl">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-10 h-10 text-green-500" />
          </div>
          <h2 className="text-xl font-black text-gray-900 mb-2">
            {store.stripeAccountId ? '口座登録が完了しています' : '申請を受け付けました'}
          </h2>
          <p className="text-sm text-gray-500 mb-4 leading-relaxed">
            {store.stripeAccountId
              ? '口座・本人確認情報の登録が完了しています。'
              : '口座・本人確認情報の申請を受け付けました。'}
          </p>
          {!store.stripeAccountId && (
            <div className="text-left bg-orange-50 border border-orange-200 rounded-2xl p-4 mb-4 space-y-2 w-full">
              <p className="text-xs font-black text-orange-900 flex items-center gap-1.5">⏱️ 審査期間：通常 1〜3営業日</p>
              <p className="text-xs text-orange-700 leading-relaxed">審査結果（承認・修正依頼ともに）は<strong>おすそわけ事務局</strong>よりメールでご連絡します。</p>
              <div className="border-t border-orange-200 pt-2">
                {/* ★ 振込スケジュールは Stripe 側で monthly / anchor=25 に固定しており、
                    「初回だけ7営業日後」という仕組みは存在しない(旧表記は誤り 2026-08-05)。
                    7日は「決済→振込可能になるまでの保留期間」であって振込日ではない。 */}
                <p className="text-xs font-black text-orange-900 flex items-center gap-1.5">💰 振込：毎月25日（初回も同じ）</p>
                <p className="text-[11px] text-orange-700 leading-relaxed">売上は決済から約7日後に「振込可能」になり、その後最初に来る25日にまとめて振り込まれます。</p>
              </div>
            </div>
          )}
          <button onClick={() => navigate('/mypage')}
            className="bg-orange-500 text-white font-bold px-6 py-3 rounded-2xl w-full">
            マイページへ
          </button>
        </div>
      </div>
    );
  }

  // ── Stripe コード → 日本語変換 ──────────────────────────────────────────────
  const stripeReqLabel = (key: string) => ({
    'individual.verification.document':            '本人確認書類（運転免許証・マイナンバーカード等）',
    'individual.verification.additional_document': '追加書類（営業許可証等）',
    'individual.first_name_kana':  '氏名（カナ・名）',
    'individual.last_name_kana':   '氏名（カナ・姓）',
    'individual.first_name_kanji': '氏名（漢字・名）',
    'individual.last_name_kanji':  '氏名（漢字・姓）',
    'individual.dob.day':   '生年月日（日）',
    'individual.dob.month': '生年月日（月）',
    'individual.dob.year':  '生年月日（年）',
    'individual.address_kanji.line1':      '住所（漢字・番地）',
    'individual.address_kanji.city':       '住所（漢字・市区町村）',
    'individual.address_kanji.state':      '住所（漢字・都道府県）',
    'individual.address_kanji.postal_code':'郵便番号',
    'individual.address_kana.line1':       '住所（カナ・番地）',
    'individual.address_kana.city':        '住所（カナ・市区町村）',
    'individual.address_kana.state':       '住所（カナ・都道府県）',
    'individual.phone': '電話番号',
    'individual.email': 'メールアドレス',
    'individual.id_number': 'マイナンバー',
    'external_account': '銀行口座情報',
  } as Record<string, string>)[key] ?? key;

  // ────────── Stripe 情報不完全（chargesEnabled/payoutsEnabled=false）── 再送信バナーを表示 ──
  const incompleteWarning = stripeIncomplete ? (
    <div className="mx-4 mt-4 mb-0 bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
      <div className="flex gap-3">
        <span className="text-amber-500 text-xl mt-0.5">⚠️</span>
        <div>
          <p className="text-sm font-bold text-amber-800">
            {store.stripeChargesEnabled === false ? '決済情報が不完全です' : '入金が一時停止中です'}
          </p>
          <p className="text-xs text-amber-700 mt-1 leading-relaxed">
            {store.stripeChargesEnabled === false
              ? '前回の登録で一部の情報が送信されませんでした。フォームを再入力して再送信してください。'
              : '本人確認書類の提出または修正が必要です。下記の内容をご確認ください。'}
          </p>
        </div>
      </div>

      {/* 具体的なエラー詳細 */}
      {stripeReqs && stripeReqs.errors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 space-y-1.5">
          <p className="text-[11px] font-black text-red-800">🚫 修正が必要な内容（{stripeReqs.errors.length}件）</p>
          {stripeReqs.errors.map((e, i) => (
            <div key={i}>
              <p className="text-[11px] font-bold text-red-700">・{stripeReqLabel(e.requirement)}</p>
              <p className="text-[11px] text-red-600 ml-3">{stripeErrCodeLabel(e.code) || stripeReasonLabel(e.reason) || '入力情報を再確認してください'}</p>
            </div>
          ))}
        </div>
      )}

      {stripeReqs && stripeReqs.currentlyDue.length > 0 && (
        <div className="bg-amber-100 border border-amber-300 rounded-xl px-3 py-2.5 space-y-1">
          <p className="text-[11px] font-black text-amber-900">📋 提出が必要な項目（{stripeReqs.currentlyDue.length}件）</p>
          {stripeReqs.currentlyDue.map((item, i) => (
            <p key={i} className="text-[11px] text-amber-800">・{stripeReqLabel(item)}</p>
          ))}
        </div>
      )}

      {stripeReqs && stripeReqs.pendingVerification.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 flex items-center gap-2">
          <span className="text-blue-500 text-sm">🔄</span>
          <p className="text-[11px] font-bold text-blue-800">
            審査中: {stripeReqs.pendingVerification.map(stripeReqLabel).join('・')}
          </p>
        </div>
      )}
    </div>
  ) : null;

  // ────────── 完了後：成功画面 ──────────
  if (done) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          className="text-center max-w-sm md:max-w-2xl w-full"
        >
          <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 className="w-12 h-12 text-green-500" />
          </div>
          <h2 className="text-2xl font-black text-gray-900 mb-2">登録完了！</h2>
          <p className="text-sm text-gray-500 leading-relaxed mb-4">
            口座情報・本人確認書類・代表者情報をすべて送信しました。
          </p>
          {/* 審査期間・振込スケジュール */}
          <div className="text-left bg-orange-50 border border-orange-200 rounded-2xl p-4 mb-4 space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-xl shrink-0">⏱️</span>
              <div>
                <p className="text-sm font-black text-orange-900">審査期間の目安</p>
                <p className="text-xs text-orange-700 leading-relaxed mt-0.5">
                  通常<strong>1〜3営業日</strong>で審査が完了します。審査結果（承認・修正依頼ともに）は<strong>おすそわけ事務局</strong>よりメールでご連絡します。
                </p>
              </div>
            </div>
            <div className="border-t border-orange-200" />
            <div className="flex items-start gap-3">
              <span className="text-xl shrink-0">💰</span>
              <div>
                <p className="text-sm font-black text-orange-900">売上の振込スケジュール</p>
                <p className="text-xs text-orange-700 leading-relaxed mt-0.5">
                  振込は<strong>毎月25日</strong>です（初回も同じ）。その日までに「振込可能」になっている残高が、まとめて口座へ振り込まれます。
                  ※売上は決済から約7日後に「振込可能」へ移動し、その後最初に到来する25日に振込されます（例：5月22日の売上 → 5月29日に振込可能 → 6月25日に振込）。
                </p>
              </div>
            </div>
          </div>
          <button
            onClick={() => navigate('/mypage')}
            className="w-full py-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-base rounded-2xl shadow-lg active:scale-[0.98] transition-transform"
          >
            マイページへ
          </button>
        </motion.div>
      </div>
    );
  }

  // ────────── メインフォーム ──────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">
      <div className="w-full max-w-lg md:max-w-3xl mx-auto px-4 pt-safe-or-4 pb-12">

        {/* ヘッダー */}
        <div className="flex items-center gap-3 py-5">
          <button onClick={() => navigate('/mypage')}
            className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center active:scale-95 transition-transform">
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </button>
          <div>
            <h1 className="text-xl font-black text-gray-900">口座登録 & 本人確認</h1>
            <p className="text-xs text-gray-500">売上受取口座と本人確認情報を設定します</p>
          </div>
        </div>

        {/* 「あとで設定する」ボタン — 入金有効でない & 却下中でない場合のみ表示 */}
        {store.status !== 'rejected' && store.stripePayoutsEnabled !== true && (
          <button
            onClick={() => navigate('/mypage')}
            className="w-full mb-4 px-4 py-3 bg-white border border-amber-200 rounded-2xl flex items-center justify-between gap-3 active:scale-[0.99] transition-transform shadow-sm"
          >
            <div className="text-left">
              <p className="text-sm font-black text-gray-800">あとで設定する</p>
              <p className="text-[11px] text-gray-500 mt-0.5">マイページからいつでも続きができます</p>
            </div>
            <div className="flex items-center gap-1 text-amber-600 shrink-0">
              <span className="text-xs font-bold">マイページへ</span>
              <ChevronLeft className="w-4 h-4 rotate-180" />
            </div>
          </button>
        )}

        {/* トップバナー：却下→赤 / Stripe入金有効→お祝い / それ以外→次のステップ案内 */}
        {store.status === 'rejected' ? (
          <motion.div
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, type: 'spring', stiffness: 200, damping: 20 }}
            className="rounded-2xl mb-5 border border-red-200 bg-red-50 overflow-hidden"
          >
            <div className="bg-red-500 px-5 py-3 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-white shrink-0" />
              <p className="text-white font-black text-sm">申請が却下されました — 修正が必要です</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs font-black text-red-600 mb-1.5">却下理由</p>
              <p className="text-sm text-red-700 leading-relaxed">
                {store.rejectionReason ?? '口座情報または本人確認情報に不備があります。下記フォームで修正して再申請してください。'}
              </p>
              <p className="text-xs text-red-400 mt-3 leading-relaxed">
                {bankAlreadyRegistered
                  ? <>下記フォームで<strong className="text-red-500">本人確認情報を修正</strong>して送信してください。口座情報は変更不要です。</>
                  : <>下記フォームで<strong className="text-red-500">口座情報・本人確認情報を修正</strong>して送信してください。</>
                }
                送信後、管理者が再審査します。
              </p>
            </div>
          </motion.div>
        ) : store.stripePayoutsEnabled === true ? (
          /* ✅ Stripe の payouts_enabled が true の場合のみお祝い表示 */
          <motion.div
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, type: 'spring', stiffness: 200, damping: 20 }}
            className="relative overflow-hidden rounded-2xl mb-5 shadow-md"
            style={{ background: 'linear-gradient(135deg, #FF8C00 0%, #FF6B00 60%, #E55A00 100%)' }}
          >
            <div className="absolute -top-6 -right-6 w-28 h-28 bg-white/10 rounded-full pointer-events-none" />
            <div className="absolute -bottom-4 -left-4 w-20 h-20 bg-white/5 rounded-full pointer-events-none" />
            <div className="relative px-5 py-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-11 h-11 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center shrink-0">
                  <PartyPopper className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-white/80 text-[11px] font-bold tracking-widest uppercase leading-none mb-0.5">CONGRATULATIONS</p>
                  <p className="text-white font-black text-lg leading-tight">審査が完了しました！</p>
                </div>
              </div>
              <p className="text-white/90 text-sm leading-relaxed">
                おめでとうございます🎊 売上の受け取りが有効になりました。<strong className="text-white">おすそわけ袋の出品</strong>を始めましょう。
              </p>
            </div>
          </motion.div>
        ) : (
          /* 📋 Stripe審査が完了するまでは次のステップ案内を表示 */
          <motion.div
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, type: 'spring', stiffness: 200, damping: 20 }}
            className="rounded-2xl mb-5 overflow-hidden border border-orange-200"
            style={{ background: 'linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 100%)' }}
          >
            <div className="px-5 py-3 flex items-center gap-2" style={{ background: 'linear-gradient(90deg, #FF8C00 0%, #FF6B00 100%)' }}>
              <FileText className="w-4 h-4 text-white shrink-0" />
              <p className="text-white font-black text-sm">STEP 2 ／ 口座・本人確認の登録</p>
            </div>
            <div className="px-5 py-4 space-y-2">
              <p className="text-sm font-black text-orange-900">基本情報の入力が完了しました</p>
              <p className="text-xs text-orange-700 leading-relaxed">
                次に、<strong>口座情報・本人確認書類・営業許可証</strong>を登録してください。登録後に審査が行われ、審査が通ると売上の受け取りが可能になります。
              </p>
              <div className="flex items-start gap-2 pt-1 bg-orange-100/60 rounded-xl p-2">
                <span className="text-orange-500 text-sm mt-0.5">⏱️</span>
                <div>
                  <p className="text-[11px] font-black text-orange-800">審査期間：通常 1〜3営業日</p>
                  <p className="text-[11px] text-orange-600 leading-relaxed mt-0.5">振込：毎月25日（初回も同じ。売上は決済の約7日後に振込可能になります）</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-orange-400 text-xs mt-0.5">⚠️</span>
                <p className="text-[11px] text-orange-600 leading-relaxed">
                  この画面で登録が完了するまで、出品した商品の売上は受け取れません。必ず最後まで入力して送信してください。
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* セキュリティ説明 */}
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-5 flex gap-3">
          <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
          <p className="text-sm text-blue-700 leading-relaxed">
            口座・本人確認情報は安全なサーバーで直接処理されます。おすそわけのサーバーには口座番号は一切保存されません。
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">

          {/* Stripe 不完全バナー（chargesEnabled=false の再送信時） */}
          {incompleteWarning}

          {/* ── Stripe フィールドエラー サマリーバナー ── */}
          {stripeReqs && stripeReqs.errors.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded-2xl p-4 flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-black text-red-800">
                  修正依頼が届いています（{stripeReqs.errors.length}件）
                </p>
                <p className="text-xs text-red-700 mt-1 leading-relaxed">
                  赤枠のセクションのみ修正して再送信してください。緑の「確認済み」セクションは変更不要です。
                </p>
              </div>
            </div>
          )}

          {/* ── ① 事業形態 ── */}
          <FormSection title="事業形態" icon={<Building2 className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('businessType')}>
            <div className="grid grid-cols-2 gap-3">
              {([
                { t: 'individual' as const, emoji: '👤', label: '個人事業主' },
                { t: 'company'    as const, emoji: '🏢', label: '法人' },
              ]).map(({ t, emoji, label }) => (
                <button key={t} type="button"
                  onClick={() => {
                    setBusinessType(t);
                    try { localStorage.setItem('store-business-type', t); } catch (_) {}
                  }}
                  className={`relative py-3 px-2 rounded-xl font-bold text-sm border-2 transition-all flex flex-col items-center gap-0.5 ${
                    businessType === t ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-500'
                  }`}>
                  {businessType === t && (
                    <span className="absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full bg-orange-500 flex items-center justify-center">
                      <svg viewBox="0 0 10 10" className="w-2 h-2 fill-none stroke-white stroke-[1.8]"><polyline points="2,5.5 4.2,7.5 8,3" /></svg>
                    </span>
                  )}
                  <span className="text-lg">{emoji}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {businessType === 'individual'
                ? '個人事業主として登録されます。マイナンバー等の個人情報が必要です。'
                : '法人として登録されます。法人名（登記簿上の名称）と代表者情報が必要です。'}
            </p>
          </FormSection>

          {/* ── ①-b 法人情報（法人のみ表示）── */}
          {businessType === 'company' && (
            <FormSection title="法人情報" icon={<Building2 className="w-5 h-5 text-orange-500" />}
              stripeStatus={getGroupStatus('company')}>
              <Field label="法人名（漢字・登記簿上の名称）" required hint="例：株式会社〇〇フード">
                <input type="text" value={companyNameKanji} onChange={e => setCompanyNameKanji(e.target.value)}
                  placeholder="株式会社〇〇フード" required={businessType === 'company'} className={inputClass} />
              </Field>
              <Field label="法人名（カナ）" required hint="全角カタカナ（例：カブシキガイシャ〇〇フード）">
                <input type="text" value={companyNameKana} onChange={e => setCompanyNameKana(e.target.value)}
                  placeholder="カブシキガイシャ〇〇フード" required={businessType === 'company'} className={inputClass} />
              </Field>
              <Field label="法人名（ローマ字・英語）" required hint="必須項目。例：Kabushiki Gaisha XX Food">
                <input type="text" value={companyNameLatin} onChange={e => setCompanyNameLatin(e.target.value)}
                  placeholder="Kabushiki Gaisha XX Food" required={businessType === 'company'} className={inputClass} />
              </Field>
              <Field label="法人番号（13桁 または 登記の12桁）" required hint="国税庁の法人番号（13桁）。登記簿の12桁（会社法人等番号）しかお手元にない場合は、そのまま12桁で入力してください（自動で13桁に変換されます）">
                <input type="text" value={companyTaxId} onChange={e => setCompanyTaxId(e.target.value.replace(/[^\d-]/g, ''))}
                  placeholder="0000000000000" maxLength={13} inputMode="numeric" className={inputClass} />
                {(() => {
                  const d = companyTaxId.replace(/[^0-9]/g, '');
                  if (d.length === 12) {
                    const v = normalizeCorporateNumber(d);
                    return <p className="text-xs text-emerald-600 font-bold mt-1">✓ 登記の12桁ですね。法人番号 {v.value} として送信します</p>;
                  }
                  if (d.length === 13 && normalizeCorporateNumber(d).error) {
                    return <p className="text-xs text-red-500 font-bold mt-1">⚠️ この13桁は法人番号として正しくないようです。12桁の登記番号に0を足していませんか？その場合は0を消して12桁のまま入力してください</p>;
                  }
                  return <p className="text-xs text-gray-400 mt-1">{d.length} / 13 桁</p>;
                })()}
              </Field>
            </FormSection>
          )}

          {/* ── ② 代表者氏名 ── */}
          <FormSection title={businessType === 'company' ? '代表者（法人代表）の氏名' : '代表者氏名'} icon={<User className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('name')}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="姓（漢字）" required>
                <input type="text" value={lastNameKanji} onChange={e => setLastNameKanji(e.target.value)}
                  placeholder="山田" required className={inputClass} />
              </Field>
              <Field label="名（漢字）" required>
                <input type="text" value={firstNameKanji} onChange={e => setFirstNameKanji(e.target.value)}
                  placeholder="太郎" required className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="姓（カナ）" required hint="全角カタカナ">
                <input type="text" value={lastNameKana} onChange={e => setLastNameKana(e.target.value)}
                  placeholder="ヤマダ" required className={inputClass} />
              </Field>
              <Field label="名（カナ）" required hint="全角カタカナ">
                <input type="text" value={firstNameKana} onChange={e => setFirstNameKana(e.target.value)}
                  placeholder="タロウ" required className={inputClass} />
              </Field>
            </div>
            <Field label="電話番号" required hint="ハイフンなし（例: 09012345678）">
              <input type="tel" value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^\d+\-()]/g, ''))}
                placeholder="09012345678" inputMode="tel" required className={inputClass} />
            </Field>
            <Field label="メールアドレス" required>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="owner@example.com" required className={inputClass} />
            </Field>
            {businessType === 'company' && (
              <Field label="代表者の役職" required hint="例：代表取締役、CEO">
                <input type="text" value={representativeTitle} onChange={e => setRepresentativeTitle(e.target.value)}
                  placeholder="代表取締役" className={inputClass} />
              </Field>
            )}
          </FormSection>

          {/* ── ③ 生年月日 ── */}
          <FormSection title="生年月日" icon={<User className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('dob')}>
            <div className="grid grid-cols-3 gap-3">
              <Field label="年" required>
                {/* autoComplete="bday-year" + maxLength=4 で iOS Keychain / Safari 履歴の
                    誤推測 (1003455 のような 7 桁が勝手に入るバグ) を防止。
                    onChange でも 4 桁以下のみ受け付けるよう slice する保険を入れる。 */}
                <input
                  type="number"
                  value={dobYear}
                  onChange={e => setDobYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="1985"
                  min={1920}
                  max={new Date().getFullYear() - 18}
                  maxLength={4}
                  required
                  inputMode="numeric"
                  autoComplete="bday-year"
                  className={inputClass}
                />
              </Field>
              <Field label="月" required>
                <select value={dobMonth} onChange={e => setDobMonth(e.target.value)} required autoComplete="bday-month" className={selectClass}>
                  <option value="">月</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                    <option key={m} value={m}>{m}月</option>
                  ))}
                </select>
              </Field>
              <Field label="日" required>
                <select value={dobDay} onChange={e => setDobDay(e.target.value)} required autoComplete="bday-day" className={selectClass}>
                  <option value="">日</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}日</option>
                  ))}
                </select>
              </Field>
            </div>
          </FormSection>

          {/* ── ④ 住所 ── */}
          <FormSection title={businessType === 'company' ? '代表者（法人代表）の住所' : '代表者（本人）の住所'} icon={<MapPin className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('address')}>
            <Field label="郵便番号（ハイフンなし7桁）" required>
              <div className="relative">
                <input type="text" value={postalCode} onChange={e => handlePostalCodeChange(e.target.value)}
                  placeholder="5300001" maxLength={7} inputMode="numeric" required className={inputClass} />
                {zipLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-orange-400 animate-spin" />}
              </div>
              <p className="text-xs text-gray-400 mt-1.5">7桁入力で住所を自動補完します</p>
            </Field>

            <Field label="都道府県" required>
              <select value={PREFECTURES_KANJI.indexOf(stateKanji).toString()}
                onChange={e => handlePrefectureChange(e.target.value)} required className={selectClass}>
                <option value="-1">選択してください</option>
                {PREFECTURES_KANJI.map((p, i) => <option key={p} value={i}>{p}</option>)}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="市区町村（漢字）" required>
                <input type="text" value={cityKanji} onChange={e => setCityKanji(e.target.value)}
                  placeholder="大阪市北区" required className={inputClass} />
              </Field>
              <Field label="町名（漢字）" required hint="番地は次の欄に入力してください">
                <input type="text" value={townKanji} onChange={e => setTownKanji(e.target.value)}
                  placeholder="梅田" required className={inputClass} />
              </Field>
            </div>

            <Field label="番地・建物名（漢字）" required hint="例：1-2-22 ○○ビル101号室">
              <input type="text" value={line1Kanji} onChange={e => setLine1Kanji(e.target.value)}
                placeholder="1-2-22 ○○ビル101号室" required className={inputClass} />
            </Field>

            {/* カナ住所 */}
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">住所（カタカナ）</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="市区町村（カナ）" required>
                  <input type="text" value={cityKana} onChange={e => setCityKana(e.target.value)}
                    placeholder="オオサカシキタク" required className={inputClass} />
                </Field>
                <Field label="町名（カナ）" required hint="全角カタカナ・番地は次の欄へ">
                  <input type="text" value={townKana} onChange={e => setTownKana(e.target.value)}
                    placeholder="ウメダ" required className={inputClass} />
                </Field>
              </div>
              <Field label="番地・建物名（カナ）" required hint="例：1-2-22 ○○ビル101">
                <input type="text" value={line1Kana} onChange={e => setLine1Kana(e.target.value)}
                  placeholder="1-2-22 ○○ビル101" required className={inputClass} />
              </Field>
            </div>
          </FormSection>

          {/* ── ⑤ 事業内容 ── */}
          <FormSection title="事業内容" icon={<FileText className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('business')}>
            <Field label="サービス内容の説明" required hint="10文字以上（例：飲食店での余剰食品のおすそわけ販売）">
              <textarea value={productDescription} onChange={e => setProductDescription(e.target.value)}
                placeholder="例：飲食店での余剰食品を詰め合わせた「おすそわけ袋」の販売。フードロス削減を目的とした割引価格での提供。"
                rows={4} required minLength={10} className={`${inputClass} resize-none`} />
              <p className="text-xs text-gray-400 mt-1.5">{productDescription.length} 文字</p>
            </Field>
            <Field label="ウェブサイトURL（任意）" hint="店舗のSNSや公式サイト">
              <input type="url" value={businessUrl} onChange={e => setBusinessUrl(e.target.value)}
                placeholder="https://example.com" className={inputClass} />
            </Field>
          </FormSection>

          {/* ── ⑥⑦ 銀行情報・口座情報 ── */}
          {bankAlreadyRegistered ? (
            <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-3">
              <BadgeCheck className="w-5 h-5 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-bold text-green-800">振込先口座は登録済みです</p>
                <p className="text-xs text-green-700 mt-0.5">再入力不要です。本人確認情報のみ送信します。</p>
              </div>
            </div>
          ) : (
            <>
          <FormSection title="銀行情報" icon={<Building2 className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('bank')}>
            <Field label="銀行名" required>
              <input type="text" value={bankName} onChange={e => setBankName(e.target.value)}
                placeholder="例：三菱UFJ銀行" required className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="銀行コード（4桁）" required>
                <input type="text" value={bankCode}
                  onChange={e => setBankCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="0005" maxLength={4} inputMode="numeric" required
                  className={`${inputClass} font-mono tracking-widest`} />
              </Field>
              <Field label="支店コード（3桁）" required>
                <input type="text" value={branchCode}
                  onChange={e => setBranchCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="001" maxLength={3} inputMode="numeric" required
                  className={`${inputClass} font-mono tracking-widest`} />
              </Field>
            </div>
          </FormSection>

          <FormSection title="口座情報" icon={<CreditCard className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('bank')}>
            <Field label="口座番号" required>
              <input type="text" value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 7))}
                placeholder="1234567" maxLength={7} inputMode="numeric" required
                className={`${inputClass} font-mono tracking-widest`} />
            </Field>
            <Field label="口座名義（カタカナ）" required hint="通帳に記載されているカタカナ表記で入力してください（全角・半角どちらでも可）">
              <input type="text" value={holderName} onChange={e => setHolderName(e.target.value)}
                placeholder="サトウ タロウ" required className={inputClass} />
            </Field>
          </FormSection>
            </>
          )}

          {/* ── ⑧ 本人確認書類 ── */}
          <FormSection title={businessType === 'company' ? '代表者の本人確認書類' : '本人確認書類'} icon={<BadgeCheck className="w-5 h-5 text-orange-500" />}
            stripeStatus={getGroupStatus('document')}>
            <p className="text-sm text-gray-500 -mt-1 mb-3">
              {businessType === 'company'
                ? '代表者（法人代表）の運転免許証・マイナンバーカード・パスポートなど。'
                : '運転免許証・マイナンバーカード・パスポートなど。'}
              <span className="text-red-500 font-medium">表面・裏面ともに必須</span>です。
            </p>
            {/* hidden inputs */}
            {/* ★ accept は image/* のみ。複数MIME列挙（image/jpeg,image/png）は
                iOS WKWebView の Take Photo 経路でカメラインテントが固まる事例があるため
                単一 wildcard に統一（同アプリ内 ImageUpload.tsx と同じパターン）。
                HEIC は URL.createObjectURL → Image() で WKWebView がネイティブデコード可能。 */}
            <input ref={frontInputRef} type="file" accept="image/*" className="hidden"
              onChange={handleDocFileChange('front')} />
            <input ref={backInputRef}  type="file" accept="image/*" className="hidden"
              onChange={handleDocFileChange('back')}  />

            <div className="grid grid-cols-2 gap-3">
              {/* 表面 */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-bold text-gray-600">表面 <span className="text-red-500">*</span></p>
                <button type="button" onClick={() => frontInputRef.current?.click()}
                  className={`relative w-full aspect-[3/2] rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 overflow-hidden transition-colors ${
                    docFrontPreview ? 'border-orange-400 bg-orange-50' : 'border-gray-300 bg-gray-50 hover:border-orange-300'
                  }`}>
                  {docFrontPreview ? (
                    <>
                      <img loading="lazy" decoding="async" src={docFrontPreview} alt="表面プレビュー" className="absolute inset-0 w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center gap-1">
                        <Camera className="w-6 h-6 text-white opacity-80" />
                        <span className="text-xs text-white font-medium">タップして変更</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-6 h-6 text-gray-400" />
                      <span className="text-xs text-gray-500">タップして選択</span>
                    </>
                  )}
                </button>
              </div>

              {/* 裏面 */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-bold text-gray-600">裏面 <span className="text-red-500">*</span></p>
                <button type="button" onClick={() => backInputRef.current?.click()}
                  className={`relative w-full aspect-[3/2] rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 overflow-hidden transition-colors ${
                    docBackPreview ? 'border-orange-400 bg-orange-50' : 'border-gray-300 bg-gray-50 hover:border-orange-300'
                  }`}>
                  {docBackPreview ? (
                    <>
                      <img loading="lazy" decoding="async" src={docBackPreview} alt="裏面プレビュー" className="absolute inset-0 w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center gap-1">
                        <Camera className="w-6 h-6 text-white opacity-80" />
                        <span className="text-xs text-white font-medium">タップして変更</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-6 h-6 text-gray-400" />
                      <span className="text-xs text-gray-500">タップして選択</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {docError && (
              <p className="text-xs text-red-500 mt-2 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {docError}
              </p>
            )}
          </FormSection>

          {/* ── ⑨ 営業許可証 ── */}
          <FormSection title="営業許可証" icon={<FileText className="w-5 h-5 text-orange-500" />}>
            <p className="text-sm text-gray-500 -mt-1 mb-3">
              食品衛生法に基づく営業許可証の画像をアップロードしてください。
              <span className="text-red-500 font-medium ml-1">必須</span>
            </p>

            <input
              ref={bizLicenseInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={handleBizLicenseChange}
            />

            <button
              type="button"
              onClick={() => bizLicenseInputRef.current?.click()}
              className={`relative w-full aspect-video rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 overflow-hidden transition-colors ${
                bizLicensePreview
                  ? 'border-orange-400 bg-orange-50'
                  : 'border-red-300 bg-red-50/40 hover:border-orange-300 hover:bg-orange-50'
              }`}
            >
              {bizLicensePreview ? (
                <>
                  <img loading="lazy" decoding="async" src={bizLicensePreview} alt="営業許可証プレビュー" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center gap-1">
                    <Camera className="w-7 h-7 text-white opacity-80" />
                    <span className="text-sm text-white font-bold">タップして変更</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center">
                    <FileText className="w-6 h-6 text-orange-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-bold text-gray-600">タップして書類を追加</p>
                    <p className="text-xs text-gray-400 mt-0.5">JPG・PNG・HEIC・PDF 対応</p>
                  </div>
                </>
              )}
            </button>

            {!bizLicensePreview && (
              <p className="text-xs text-red-500 mt-2 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                営業許可証は必須です。書類の画像を添付してください。
              </p>
            )}

            {/* 許可証番号 */}
            <div className="mt-3">
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                営業許可証番号 <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={bizLicenseNumber}
                onChange={e => setBizLicenseNumber(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-base font-medium focus:ring-2 focus:ring-orange-400/40 focus:border-orange-400 outline-none transition-all"
                placeholder="例: 第○○号"
              />
              <p className="text-xs text-gray-400 mt-1.5">許可証に記載の番号を入力してください（必須）</p>
            </div>
          </FormSection>

          {/* ── ToS ── */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <button type="button" role="checkbox" aria-checked={tosAgreed}
                onClick={() => handleTosChange(!tosAgreed)}
                className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors ${
                  tosAgreed ? 'bg-orange-500 border-orange-500' : 'border-gray-300 bg-white'
                }`}>
                {tosAgreed && <CheckCircle2 className="w-4 h-4 text-white" />}
              </button>
              <p className="text-sm text-gray-700 leading-relaxed">
                <a href="/terms" target="_blank" rel="noopener noreferrer"
                  className="text-orange-600 font-bold underline underline-offset-2"
                  onClick={e => e.stopPropagation()}>
                  おすそわけの利用規約
                </a>
                および
                <a href="https://stripe.com/jp/connect-account/legal" target="_blank" rel="noopener noreferrer"
                  className="text-orange-600 font-bold underline underline-offset-2"
                  onClick={e => e.stopPropagation()}>
                  Stripe連結アカウント利用規約
                </a>
                に同意します
              </p>
            </label>
          </div>

          {/* エラー */}
          <AnimatePresence>
            {error && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 送信中インジケーター */}
          {loading && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-orange-500 animate-spin shrink-0" />
              <div>
                <p className="text-sm font-bold text-orange-700">
                  {submitStatus || '店舗情報の最終設定中です...'}
                </p>
                <p className="text-xs text-orange-600">通常10秒ほどで完了します</p>
              </div>
            </div>
          )}

          {/* 不足項目リスト（ボタンが押せない理由を表示） */}
          <AnimatePresence>
            {!canSubmit && !loading && missingFields.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4"
              >
                <p className="text-xs font-black text-amber-800 mb-2 flex items-center gap-1.5">
                  <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                  あと {missingFields.length} 項目を入力するとボタンが押せます
                </p>
                <ul className="space-y-1">
                  {missingFields.map(f => (
                    <li key={f} className="text-xs text-amber-700 flex items-center gap-1.5">
                      <span className="w-1 h-1 bg-amber-500 rounded-full shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 送信ボタン */}
          <button type="submit" disabled={!canSubmit}
            className="w-full py-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-base rounded-2xl shadow-lg disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-opacity active:scale-[0.98]">
            {loading
              ? <><Loader2 className="w-5 h-5 animate-spin" />処理中...</>
              : <>登録して出品を始める</>
            }
          </button>

          <div className="flex items-center justify-center gap-1.5 text-xs text-gray-400 pb-4">
            <ShieldCheck className="w-4 h-4" />
            <span>情報は安全なサーバーで処理されます</span>
          </div>
        </form>
      </div>
    </div>
  );
}
