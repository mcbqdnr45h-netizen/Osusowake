import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { useMyStore } from '@/hooks/use-my-store';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import {
  ChevronLeft, Loader2, CheckCircle2, AlertCircle,
  ShieldCheck, User, Building2, MapPin, FileText,
  TriangleAlert, Info, ClipboardCheck,
  Camera, Upload, ImageIcon, X, BadgeCheck,
} from 'lucide-react';

// ── 電話番号ユーティリティ ────────────────────────────────────────────
/** 日本の電話番号を Stripe が要求する E.164 国際形式（+81...）に変換 */
function formatPhoneToE164(raw: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) return digits;        // すでに国際形式
  if (digits.startsWith('0')) return '+81' + digits.slice(1); // 0 → +81
  return '+81' + digits;
}

/** 日本の電話番号として有効かチェック（国内形式・国際形式どちらも可） */
function isValidJapanPhone(raw: string): boolean {
  const digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+81') && digits.length >= 12 && digits.length <= 13) return true;
  if (digits.startsWith('0')   && digits.length >= 10 && digits.length <= 11) return true;
  return false;
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

// ── Stripe requirement キー → 日本語ラベル ──────────────────────────
function translateRequirement(key: string): string {
  const map: Record<string, string> = {
    'individual.first_name': '代表者名（名・漢字）',
    'individual.last_name': '代表者名（姓・漢字）',
    'individual.first_name_kana': '代表者名（名・カナ）',
    'individual.last_name_kana': '代表者名（姓・カナ）',
    'individual.dob.day': '生年月日（日）',
    'individual.dob.month': '生年月日（月）',
    'individual.dob.year': '生年月日（年）',
    'individual.address_kanji.postal_code': '住所（郵便番号）',
    'individual.address_kanji.state': '住所（都道府県）',
    'individual.address_kanji.city': '住所（市区町村）',
    'individual.address_kanji.town': '住所（町名・番地）',
    'individual.address_kana.postal_code': 'カナ住所（郵便番号）',
    'individual.address_kana.state': 'カナ住所（都道府県）',
    'individual.address_kana.city': 'カナ住所（市区町村）',
    'individual.address_kana.town': 'カナ住所（町名・番地）',
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
    'individual.verification.document':       '本人確認書類',
    'individual.verification.document.front': '本人確認書類（表面）',
    'individual.verification.document.back':  '本人確認書類（裏面）',
    'individual.verification.additional_document':       '補足確認書類',
    'individual.verification.additional_document.front': '補足確認書類（表面）',
    'individual.verification.additional_document.back':  '補足確認書類（裏面）',
    'individual.first_name_kanji':  '代表者名（名・漢字）',
    'individual.last_name_kanji':   '代表者名（姓・漢字）',
    'individual.address_kanji.line1': '住所（番地・建物名）',
    'individual.address_kana.line1':  '住所カナ（番地・建物名）',
  };
  return map[key] ?? key;
}

// ── Stripe requirements.errors[].code → 日本語の理由・対処 ──────────
//   未知コードは Stripe の元メッセージ(英語)にフォールバックするので後退しない。
function translateStripeError(code: string | null | undefined, fallback?: string): string {
  const map: Record<string, string> = {
    // 書類の品質・読み取り
    verification_document_corrupt: '書類の画像が壊れています。別の写真で撮り直してアップロードしてください。',
    verification_document_not_readable: '書類が読み取れませんでした。明るい場所で文字がはっきり写るよう撮り直してください。',
    verification_document_failed_greyscale: '白黒画像は使用できません。カラーで撮影し直してください。',
    verification_document_too_large: '画像サイズが大きすぎます。撮影し直して再アップロードしてください。',
    verification_document_failed_copy: 'コピー（複写）は使用できません。原本を撮影してください。',
    verification_document_manipulated: '加工された画像は使用できません。未加工の原本を撮影してください。',
    verification_document_incomplete: '書類の一部しか写っていません。全体が入るよう撮り直してください。',
    verification_document_not_signed: '署名が確認できません。署名欄が写るよう撮り直してください。',
    verification_document_issue_or_expiry_date_missing: '発行日・有効期限が読み取れません。日付が写るよう撮り直してください。',
    // 書類の種類・有効性
    verification_document_expired: '書類の有効期限が切れています。有効期限内の書類をアップロードしてください。',
    verification_document_type_not_supported: 'この書類は使用できません。運転免許証・マイナンバーカード・パスポート等をご利用ください。',
    verification_document_country_not_supported: 'この発行国の書類は使用できません。日本発行の本人確認書類をご利用ください。',
    verification_document_invalid: '書類が無効です。有効な本人確認書類を再アップロードしてください。',
    // 表 / 裏 / 未提出
    verification_document_missing_front: '書類の表面が提出されていません。表面をアップロードしてください。',
    verification_document_missing_back: '書類の裏面が提出されていません。裏面をアップロードしてください。',
    verification_document_not_uploaded: '書類がアップロードされていません。本人確認書類をアップロードしてください。',
    // 一致しない系
    verification_document_name_mismatch: '書類の氏名が入力内容と一致しません。氏名を確認して修正してください。',
    verification_document_name_missing: '書類から氏名が読み取れません。氏名がはっきり写るよう撮り直してください。',
    verification_document_id_number_mismatch: '書類の番号が入力内容と一致しません。確認してください。',
    verification_document_photo_mismatch: '書類の顔写真が一致しませんでした。本人の有効な書類を再アップロードしてください。',
    verification_failed_name_match: '氏名が一致しませんでした。入力した氏名と書類が同じか確認してください。',
    verification_failed_address_match: '住所が一致しませんでした。入力した住所と書類が同じか確認してください。',
    verification_failed_document_match: '入力内容と書類が一致しませんでした。内容を確認して再提出してください。',
    verification_failed_keyed_identity: '入力された本人情報が確認できませんでした。氏名・生年月日・住所を確認してください。',
    verification_failed_other: '本人確認が完了できませんでした。書類を撮り直して再提出してください。',
    // 不正判定
    verification_document_fraudulent: 'この書類は受け付けられませんでした。有効な本人確認書類を提出してください。',
    // 入力値
    invalid_address_city_state_postal_code: '住所（都道府県・市区町村・郵便番号）が正しくありません。確認して修正してください。',
    invalid_street_address: '番地・建物名が正しくありません。確認して修正してください。',
    invalid_dob_age_under_18: '18歳未満は登録できません。',
    invalid_tos_acceptance: '利用規約への同意が確認できませんでした。もう一度同意して送信してください。',
    invalid_value_other: '入力内容に誤りがあります。該当項目を確認して修正してください。',
  };
  if (code && map[code]) return map[code];
  return fallback || '確認できませんでした。書類を撮り直して再提出してください。';
}

// ── Stripe param（ブラケット記法）→ フォームフィールド名 ──────────
function stripeParamToField(param: string | null | undefined): string | null {
  if (!param) return null;
  const map: Record<string, string> = {
    // ── 氏名（グローバル標準フィールド）──
    'individual[first_name]':        'firstNameKana',
    'individual[last_name]':         'lastNameKana',
    // ── 氏名（カナ）──
    'individual[first_name_kana]':   'firstNameKana',
    'individual[last_name_kana]':    'lastNameKana',
    // ── 氏名（漢字）— Stripe Japan 専用 ──
    'individual[first_name_kanji]':  'firstNameKanji',
    'individual[last_name_kanji]':   'lastNameKanji',
    // ── 生年月日 ──
    'individual[dob][year]':  'dobYear',
    'individual[dob][month]': 'dobMonth',
    'individual[dob][day]':   'dobDay',
    // ── 住所（漢字）── line1 は cityKanji+townKanji で構成するので townKanji を強調
    'individual[address_kanji][postal_code]': 'postalCode',
    'individual[address_kanji][state]':       'stateKanji',
    'individual[address_kanji][city]':        'cityKanji',
    'individual[address_kanji][town]':        'townKanji',
    'individual[address_kanji][line1]':       'townKanji',  // line1=city+town なので town を強調
    // ── 住所（カナ）──
    'individual[address_kana][postal_code]': 'postalCode',
    'individual[address_kana][state]':       'stateKana',
    'individual[address_kana][city]':        'cityKana',
    'individual[address_kana][town]':        'townKana',
    'individual[address_kana][line1]':       'townKana',    // line1=city+town なので town を強調
    // ── その他 ──
    'individual[phone]': 'phone',
    'individual[email]': 'email',
    'business_profile[product_description]': 'productDescription',
    'business_profile[url]': 'businessUrl',
    'business_type': 'businessType',
  };
  return map[param] ?? null;
}

// ── 共通 UI ──────────────────────────────────────────────────────────
const baseInput = 'w-full px-4 py-3 border-2 rounded-xl text-sm focus:outline-none transition-colors';
const okInput   = `${baseInput} border-gray-200 focus:border-orange-400`;
const errInput  = `${baseInput} border-red-400 bg-red-50 focus:border-red-400`;
const okSelect  = `${okInput} bg-white`;
const errSelect = `${errInput} bg-red-50`;

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      <h2 className="font-black text-gray-900 text-base flex items-center gap-2">{icon}{title}</h2>
      {children}
    </div>
  );
}

function FieldWrap({ label, hint, required, error, children }: {
  label: string; hint?: string; required?: boolean; error?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
      {error
        ? <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
            <AlertCircle className="w-3 h-3 shrink-0" />{error}
          </p>
        : hint && <p className="text-xs text-gray-400 mt-1.5">{hint}</p>
      }
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
export default function StripeKYCPage() {
  const [, navigate] = useLocation();
  const { store, loading: loadingStore, refetch } = useMyStore();
  const { session } = useAuth();

  // ── フォーム値 ──
  const [businessType, setBusinessType]       = useState<'individual' | 'company'>('individual');
  const [lastNameKanji, setLastNameKanji]     = useState('');
  const [firstNameKanji, setFirstNameKanji]   = useState('');
  const [lastNameKana, setLastNameKana]       = useState('');
  const [firstNameKana, setFirstNameKana]     = useState('');
  const [phone, setPhone]                     = useState('');
  const [email, setEmail]                     = useState('');
  const [dobYear, setDobYear]                 = useState('');
  const [dobMonth, setDobMonth]               = useState('');
  const [dobDay, setDobDay]                   = useState('');
  const [postalCode, setPostalCode]           = useState('');
  const [stateKanji, setStateKanji]           = useState('');
  const [cityKanji, setCityKanji]             = useState('');
  const [townKanji, setTownKanji]             = useState('');
  const [line1Kanji, setLine1Kanji]           = useState('');
  const [stateKana, setStateKana]             = useState('');
  const [cityKana, setCityKana]               = useState('');
  const [townKana, setTownKana]               = useState('');
  const [line1Kana, setLine1Kana]             = useState('');
  const [companyNameKanji, setCompanyNameKanji]     = useState('');
  const [companyNameKana, setCompanyNameKana]       = useState('');
  const [companyNameLatin, setCompanyNameLatin]     = useState('');
  const [companyStructure, setCompanyStructure]     = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [businessUrl, setBusinessUrl]         = useState('');

  // ── UI 状態 ──
  const [loading, setLoading]                 = useState(false);
  const [zipLoading, setZipLoading]           = useState(false);
  const [globalError, setGlobalError]         = useState<string | null>(null);
  const [fieldErrors, setFieldErrors]         = useState<Record<string, string>>({});

  // ── 本人確認書類アップロード ──
  const [docFrontFile, setDocFrontFile]       = useState<File | null>(null);
  const [docFrontPreview, setDocFrontPreview] = useState<string | null>(null);
  const [docBackFile, setDocBackFile]         = useState<File | null>(null);
  const [docBackPreview, setDocBackPreview]   = useState<string | null>(null);
  const [docLoading, setDocLoading]           = useState<'front' | 'back' | null>(null);
  const [docError, setDocError]               = useState<string | null>(null);
  const [docFrontDone, setDocFrontDone]       = useState(false);
  const [docBackDone, setDocBackDone]         = useState(false);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef  = useRef<HTMLInputElement>(null);
  const saveTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── ドラフト永続化：他のアプリに移動しても入力内容を保持 ────────────────
  const KYC_DRAFT_KEY = `osusowake_kyc_draft_${store?.id ?? 'pending'}`;

  // マウント時に保存済みドラフトを復元
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KYC_DRAFT_KEY) ?? localStorage.getItem('osusowake_kyc_draft_pending');
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.businessType)       setBusinessType(d.businessType);
      if (d.lastNameKanji)      setLastNameKanji(d.lastNameKanji);
      if (d.firstNameKanji)     setFirstNameKanji(d.firstNameKanji);
      if (d.lastNameKana)       setLastNameKana(d.lastNameKana);
      if (d.firstNameKana)      setFirstNameKana(d.firstNameKana);
      if (d.phone)              setPhone(d.phone);
      if (d.email)              setEmail(d.email);
      if (d.dobYear)            setDobYear(d.dobYear);
      if (d.dobMonth)           setDobMonth(d.dobMonth);
      if (d.dobDay)             setDobDay(d.dobDay);
      if (d.postalCode)         setPostalCode(d.postalCode);
      if (d.stateKanji)         setStateKanji(d.stateKanji);
      if (d.cityKanji)          setCityKanji(d.cityKanji);
      if (d.townKanji)          setTownKanji(d.townKanji);
      if (d.line1Kanji)         setLine1Kanji(d.line1Kanji);
      if (d.stateKana)          setStateKana(d.stateKana);
      if (d.cityKana)           setCityKana(d.cityKana);
      if (d.townKana)           setTownKana(d.townKana);
      if (d.line1Kana)          setLine1Kana(d.line1Kana);
      if (d.companyNameKanji)   setCompanyNameKanji(d.companyNameKanji);
      if (d.companyNameKana)    setCompanyNameKana(d.companyNameKana);
      if (d.companyNameLatin)   setCompanyNameLatin(d.companyNameLatin);
      if (d.companyStructure)   setCompanyStructure(d.companyStructure);
      if (d.productDescription) setProductDescription(d.productDescription);
      if (d.businessUrl)        setBusinessUrl(d.businessUrl);
    } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [KYC_DRAFT_KEY]);

  // 値変化時に500ms後に自動保存（debounced）
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(KYC_DRAFT_KEY, JSON.stringify({
          businessType, lastNameKanji, firstNameKanji, lastNameKana, firstNameKana,
          phone, email, dobYear, dobMonth, dobDay,
          postalCode, stateKanji, cityKanji, townKanji, line1Kanji,
          stateKana, cityKana, townKana, line1Kana,
          companyNameKanji, companyNameKana, companyNameLatin, companyStructure,
          productDescription, businessUrl,
        }));
      } catch (_) {}
    }, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    businessType, lastNameKanji, firstNameKanji, lastNameKana, firstNameKana,
    phone, email, dobYear, dobMonth, dobDay,
    postalCode, stateKanji, cityKanji, townKanji, line1Kanji,
    stateKana, cityKana, townKana, line1Kana,
    companyNameKanji, companyNameKana, companyNameLatin, companyStructure,
    productDescription, businessUrl,
  ]);

  type KYCResult = {
    kycComplete: boolean;
    storeStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirements: {
      currentlyDue: string[];
      eventuallyDue: string[];
      errors: { code: string; reason: string; requirement: string }[];
      pendingVerification: string[];
      disabledReason: string | null;
    };
  };
  const [result, setResult] = useState<KYCResult | null>(null);

  // ── 郵便番号→住所自動補完 ──
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
        // 住所フィールドのエラーをクリア
        setFieldErrors(prev => {
          const next = { ...prev };
          ['postalCode','stateKanji','cityKanji','townKanji','stateKana','cityKana','townKana'].forEach(k => delete next[k]);
          return next;
        });
      }
    } catch (_) {}
    finally { setZipLoading(false); }
  }, []);

  const handlePostalCodeChange = (v: string) => {
    const clean = v.replace(/\D/g, '').slice(0, 7);
    setPostalCode(clean);
    if (clean.length === 7) lookupZip(clean);
  };

  const handlePrefectureChange = (idx: string) => {
    const i = parseInt(idx);
    if (isNaN(i)) return;
    setStateKanji(PREFECTURES_KANJI[i] ?? '');
    setStateKana(PREFECTURES_KANA[i] ?? '');
  };

  // ── バリデーション ──
  const phoneValid = isValidJapanPhone(phone.trim());
  const phoneError = phone.trim().length > 0 && !phoneValid
    ? '0から始まる10〜11桁の数字で入力してください（例: 09012345678）'
    : null;

  const canSubmit =
    !loading &&
    lastNameKanji.trim() && firstNameKanji.trim() &&
    lastNameKana.trim() && firstNameKana.trim() &&
    phoneValid &&
    email.trim().includes('@') &&
    dobYear && dobMonth && dobDay &&
    postalCode.length === 7 &&
    stateKanji && cityKanji && townKanji &&
    stateKana && cityKana && townKana &&
    productDescription.trim().length >= 10 &&
    !!docFrontPreview &&
    (businessType !== 'company' || companyNameLatin.trim().length > 0);

  // ── 送信（テキスト情報 + 書類画像を一括並行送信） ──
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store || !canSubmit) return;

    setLoading(true);
    setGlobalError(null);
    setFieldErrors({});
    setDocError(null);
    setResult(null);

    try {
      // ① KYC テキスト情報送信 (authedFetch が Bearer 自動付与)
      const kycFetch = authedFetch(`/api/stores/${store.id}/connect/kyc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessType,
          ...(businessType === 'company' ? {
            companyNameKanji: companyNameKanji.trim() || undefined,
            companyNameKana:  companyNameKana.trim()  || undefined,
            companyNameLatin: companyNameLatin.trim() || undefined,
            companyStructure: companyStructure        || undefined,
          } : {}),
          representative: {
            firstNameKanji: firstNameKanji.trim(),
            lastNameKanji:  lastNameKanji.trim(),
            firstNameKana:  firstNameKana.trim(),
            lastNameKana:   lastNameKana.trim(),
            phone: phoneValid ? formatPhoneToE164(phone.trim()) : undefined,
            email: email.trim() || undefined,
            dobYear:  parseInt(dobYear),
            dobMonth: parseInt(dobMonth),
            dobDay:   parseInt(dobDay),
            postalCode,
            stateKanji, cityKanji: cityKanji.trim(), townKanji: townKanji.trim(),
            line1Kanji: line1Kanji.trim() || undefined,
            stateKana,  cityKana:  cityKana.trim(),  townKana:  townKana.trim(),
            line1Kana:  line1Kana.trim() || undefined,
          },
          businessProfile: {
            productDescription: productDescription.trim() || undefined,
            url: businessUrl.trim() || undefined,
          },
        }),
      });

      // ② 書類アップロード（表面・裏面を並行送信、authedFetch が Bearer 自動付与）
      const docFetch = (side: 'front' | 'back') => {
        const preview = side === 'front' ? docFrontPreview : docBackPreview;
        const file    = side === 'front' ? docFrontFile    : docBackFile;
        if (!preview || !file) return Promise.resolve(null);
        return authedFetch(`/api/stores/${store.id}/connect/kyc-document`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: preview, mimeType: file.type || 'image/jpeg', side }),
        });
      };

      // すべて並行実行
      const [kycRes, frontRes, backRes] = await Promise.all([
        kycFetch,
        docFetch('front'),
        docFetch('back'),
      ]);

      // ── KYC テキストエラー処理 ──
      const kycData = await kycRes.json();
      if (!kycRes.ok) {
        const fieldKey    = stripeParamToField(kycData.param);
        const stripeField = kycData.param ?? null;
        if (fieldKey) {
          setFieldErrors({ [fieldKey]: kycData.message ?? 'この項目に誤りがあります' });
          setGlobalError(
            `入力エラー${stripeField ? `（Stripeフィールド: ${stripeField}）` : ''}：赤くハイライトされた項目をご確認ください。\n${kycData.message ?? ''}`.trim()
          );
        } else {
          setGlobalError(
            stripeField
              ? `Stripeエラー（フィールド: ${stripeField}）\n${kycData.message ?? '送信に失敗しました。'}`
              : kycData.message ?? '送信に失敗しました。入力内容をご確認ください。'
          );
        }
        return;
      }

      // ── 書類アップロード結果処理 ──
      // ★ 致命的バグ修正: 書類失敗時はドラフト削除 / refetch / setResult をスキップ
      //   → ユーザーが KYC 完了画面に遷移して書類エラーを見落とすことを防ぐ
      let docFailed = false;
      if (frontRes) {
        const d = await frontRes.json();
        if (frontRes.ok) setDocFrontDone(true);
        else {
          setDocError(`書類（表面）のアップロードに失敗しました: ${d.message ?? ''}`);
          docFailed = true;
        }
      }
      if (backRes) {
        const d = await backRes.json();
        if (backRes.ok) setDocBackDone(true);
        else {
          setDocError(`書類（裏面）のアップロードに失敗しました: ${d.message ?? ''}`);
          docFailed = true;
        }
      }

      if (docFailed) {
        // 書類エラー時はドラフトを保持 (ユーザーが再アップロードできるように)
        // refetch / setResult もしない (KYC 完了画面への遷移を防ぐ)
        return;
      }

      // ── 完全成功 → ドラフト削除 + refetch ──
      try { localStorage.removeItem(KYC_DRAFT_KEY); localStorage.removeItem('osusowake_kyc_draft_pending'); } catch (_) {}
      await refetch();
      setResult(kycData);
    } catch (err: any) {
      setGlobalError(err?.message ?? '予期しないエラーが発生しました。');
    } finally {
      setLoading(false);
    }
  };

  // ── 書類ファイル選択ハンドラ ──
  const handleDocFileChange = (side: 'front' | 'back') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // ★ 同じファイルを再選択できるよう即リセット
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result as string;
      if (side === 'front') { setDocFrontFile(file); setDocFrontPreview(url); setDocFrontDone(false); }
      else                  { setDocBackFile(file);  setDocBackPreview(url);  setDocBackDone(false);  }
    };
    reader.readAsDataURL(file);
    setDocError(null);
  };

  // ── 書類アップロード → Stripe Files → accounts.update ──
  const handleDocUpload = async (side: 'front' | 'back') => {
    if (!store?.id) return;
    const file    = side === 'front' ? docFrontFile : docBackFile;
    const preview = side === 'front' ? docFrontPreview : docBackPreview;
    if (!file || !preview) return;

    setDocLoading(side);
    setDocError(null);
    try {
      const res = await authedFetch(`/api/stores/${store.id}/connect/kyc-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: preview,          // data:image/jpeg;base64,... 形式
          mimeType:    file.type || 'image/jpeg',
          side,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setDocError(data.message ?? '書類のアップロードに失敗しました');
        return;
      }

      if (side === 'front') setDocFrontDone(true);
      else                  setDocBackDone(true);

      // ストアを refetch して MyPage を即時更新
      await refetch();

      // KYC 完了 → result 画面を更新
      if (data.kycComplete) {
        setResult(prev => prev ? {
          ...prev,
          kycComplete: true,
          storeStatus: 'approved',
          requirements: { ...prev.requirements, ...data.requirements },
        } : null);
      }
    } catch (err: any) {
      setDocError(err?.message ?? '予期しないエラーが発生しました');
    } finally {
      setDocLoading(null);
    }
  };

  const fieldClass = (key: string) =>
    fieldErrors[key]
      ? (key === 'businessType' ? '' : errInput)
      : (key === 'businessType' ? '' : okInput);

  const selectFieldClass = (key: string) =>
    fieldErrors[key] ? errSelect : okSelect;

  // ── ローディング ──
  if (loadingStore) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-orange-400 animate-spin" />
      </div>
    );
  }

  // ── 店舗なし ──
  if (!store) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-orange-400 mx-auto mb-3" />
          <p className="font-black text-gray-900 mb-4">店舗が見つかりません</p>
          <button onClick={() => navigate('/store-onboarding')}
            className="bg-orange-500 text-white font-bold px-6 py-3 rounded-2xl">
            店舗申請へ
          </button>
        </div>
      </div>
    );
  }

  // ── 銀行口座未登録 ──
  if (!store.stripeAccountId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="text-center max-w-sm md:max-w-2xl">
          <AlertCircle className="w-12 h-12 text-amber-400 mx-auto mb-3" />
          <p className="font-black text-gray-900 mb-2">先に振込先口座を登録してください</p>
          <p className="text-sm text-gray-500 mb-4">KYC情報はStripe連結アカウントが必要です。</p>
          <button onClick={() => navigate('/store/bank-setup')}
            className="bg-orange-500 text-white font-bold px-6 py-3 rounded-2xl w-full">
            口座登録へ進む
          </button>
        </div>
      </div>
    );
  }

  // ── 送信完了後：結果画面 ──
  if (result) {
    const remaining = [
      ...result.requirements.currentlyDue,
      ...result.requirements.eventuallyDue,
    ].filter((v, i, a) => a.indexOf(v) === i);
    const allClear = result.kycComplete;

    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">
        <div className="max-w-lg md:max-w-3xl mx-auto px-4 pt-safe-or-4 pb-12">
          <div className="flex items-center gap-3 py-5">
            <button onClick={() => navigate('/mypage')}
              className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center">
              <ChevronLeft className="w-5 h-5 text-gray-700" />
            </button>
            <h1 className="text-xl font-black text-gray-900">送信結果</h1>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-sm p-6 text-center mb-4"
          >
            <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 ${
              allClear ? 'bg-green-100' : 'bg-amber-100'
            }`}>
              {allClear
                ? <CheckCircle2 className="w-10 h-10 text-green-500" />
                : <ClipboardCheck className="w-10 h-10 text-amber-500" />
              }
            </div>
            <h2 className="text-xl font-black text-gray-900 mb-2">
              {allClear ? '✅ Stripe連携完了！' : '情報を送信しました'}
            </h2>
            <p className="text-sm text-gray-500 leading-relaxed">
              {allClear
                ? 'すべての本人確認情報が揃い、Stripeアカウントの制限が解除されました。出品を開始できます！'
                : 'Stripeに情報を送信しました。まだ不足している項目があります。下記をご確認ください。'
              }
            </p>

            <div className="flex items-center justify-center gap-3 mt-4 flex-wrap">
              <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                result.chargesEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {result.chargesEnabled ? '✅ 支払い受取：有効' : '⏳ 支払い受取：審査中'}
              </span>
              <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${
                result.payoutsEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {result.payoutsEnabled ? '✅ 振込：有効' : '⏳ 振込：審査中'}
              </span>
            </div>
          </motion.div>

          {/* 残り不足項目 */}
          {remaining.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
              <h3 className="font-black text-gray-900 text-sm mb-3 flex items-center gap-2">
                <TriangleAlert className="w-4 h-4 text-amber-500" />
                Stripeにまだ必要な情報（{remaining.length}件）
              </h3>
              <ul className="space-y-2 mb-4">
                {remaining.map(req => (
                  <li key={req} className="flex items-start gap-2 text-sm">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mt-2 shrink-0" />
                    <span className="text-gray-700">{translateRequirement(req)}</span>
                  </li>
                ))}
              </ul>
              <button onClick={() => setResult(null)}
                className="w-full py-2.5 border-2 border-orange-400 text-orange-500 font-bold text-sm rounded-xl">
                フォームに戻って追記する
              </button>
            </div>
          )}

          {/* Stripeエラー詳細 */}
          {result.requirements.errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-5 mb-4">
              <h3 className="font-black text-red-700 text-sm mb-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />Stripeからのエラー
              </h3>
              {result.requirements.errors.map((err, i) => (
                <p key={i} className="text-sm text-red-600">
                  <span className="font-bold">{translateRequirement(err.requirement)}</span>：{translateStripeError(err.code, err.reason)}
                </p>
              ))}
            </div>
          )}

          {/* 審査中の項目 */}
          {result.requirements.pendingVerification.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 mb-4">
              <h3 className="font-black text-blue-700 text-sm mb-2 flex items-center gap-2">
                <Info className="w-4 h-4" />Stripeが審査中の項目
              </h3>
              {result.requirements.pendingVerification.map(req => (
                <p key={req} className="text-sm text-blue-600">・{translateRequirement(req)}</p>
              ))}
            </div>
          )}

          {/* ── 本人確認書類が不足している場合に結果画面でもアップロードを表示 ── */}
          {remaining.some(r => r.includes('verification.document')) && (
            <div className="bg-white rounded-2xl shadow-sm p-5 mb-4 space-y-4">
              <h3 className="font-black text-gray-900 text-sm flex items-center gap-2">
                <Camera className="w-4 h-4 text-orange-500" />本人確認書類をアップロード
              </h3>
              <p className="text-xs text-gray-500">
                運転免許証・マイナンバーカード・パスポートの表面を撮影してアップロードしてください。
              </p>

              {docError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{docError}</p>
                </div>
              )}

              {/* 表面 */}
              <input ref={frontInputRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif"
                onChange={handleDocFileChange('front')} className="hidden" />
              {docFrontPreview ? (
                <div className="relative">
                  <img loading="lazy" decoding="async" src={docFrontPreview} alt="表面" className="w-full max-h-48 object-contain rounded-xl border-2 border-gray-200 bg-gray-50" />
                  <button type="button"
                    onClick={() => { setDocFrontFile(null); setDocFrontPreview(null); setDocFrontDone(false); if (frontInputRef.current) frontInputRef.current.value = ''; }}
                    className="absolute top-2 right-2 w-7 h-7 bg-gray-800/60 rounded-full flex items-center justify-center">
                    <X className="w-4 h-4 text-white" />
                  </button>
                  {docFrontDone
                    ? <div className="flex items-center gap-1.5 text-green-600 text-xs font-bold mt-2"><BadgeCheck className="w-4 h-4" />Stripeに送信済み</div>
                    : <button type="button" disabled={docLoading === 'front'} onClick={() => handleDocUpload('front')}
                        className="mt-2 w-full py-2.5 bg-orange-500 text-white font-bold text-sm rounded-xl flex items-center justify-center gap-2 disabled:opacity-50">
                        {docLoading === 'front' ? <><Loader2 className="w-4 h-4 animate-spin" />送信中...</> : <><Upload className="w-4 h-4" />この画像を送信する</>}
                      </button>
                  }
                </div>
              ) : (
                <button type="button" onClick={() => frontInputRef.current?.click()}
                  className="w-full h-32 border-2 border-dashed border-orange-300 rounded-xl flex flex-col items-center justify-center gap-2 hover:bg-orange-50 transition-colors">
                  <Camera className="w-8 h-8 text-orange-300" />
                  <p className="text-xs text-orange-400 font-bold">タップして書類の表面を選択</p>
                  <p className="text-xs text-gray-300">JPG / PNG / HEIC 対応</p>
                </button>
              )}
            </div>
          )}

          <button onClick={() => navigate('/mypage')}
            className="w-full py-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-base rounded-2xl shadow-lg">
            マイページへ戻る
          </button>
        </div>
      </div>
    );
  }

  // ── メインフォーム ──────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">
      <div className="max-w-lg md:max-w-3xl mx-auto px-4 pt-safe-or-4 pb-12">

        {/* ヘッダー */}
        <div className="flex items-center gap-3 py-5">
          <button onClick={() => navigate('/mypage')}
            className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center active:scale-95 transition-transform">
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </button>
          <div>
            <h1 className="text-xl font-black text-gray-900">本人確認情報（KYC）</h1>
            <p className="text-xs text-gray-500">Stripeの制限解除に必要な情報を入力</p>
          </div>
        </div>

        {/* 安心バナー：所要時間 + 必要なもの */}
        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 mb-4 flex gap-3">
          <span className="text-2xl shrink-0">🪪</span>
          <div>
            <p className="text-sm font-black text-orange-700">最短3分で完了します。免許証をご準備ください</p>
            <p className="text-xs text-orange-500 mt-0.5">
              運転免許証・マイナンバーカード・パスポートのいずれか1枚。<br />
              入力情報はStripeのサーバーに直接・安全に送信されます。
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* ① 事業形態 */}
          <Section title="事業形態" icon={<Building2 className="w-5 h-5 text-orange-500" />}>
            {/* 既存Stripeアカウントがある場合：業種変更不可の注意 */}
            {store?.stripeAccountId && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 mb-3 flex items-start gap-2">
                <TriangleAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-black text-amber-800">業種はStripe連携時に固定されます</p>
                  <p className="text-[10px] text-amber-700 mt-0.5 leading-snug">
                    変更が必要な場合は再連携が必要です。
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                      await authedFetch(`${BASE}/api/stores/${store.id}/stripe-disconnect`, { method: 'POST' });
                      navigate('/store/bank-setup');
                    }}
                    className="mt-1.5 text-[10px] font-black text-amber-700 underline underline-offset-2"
                  >
                    口座を再連携して業種を変更する →
                  </button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {(['individual', 'company'] as const).map(t => (
                <button key={t} type="button"
                  onClick={() => {
                    if (store?.stripeAccountId) return;
                    setBusinessType(t);
                  }}
                  className={`py-3 rounded-xl font-bold text-sm border-2 transition-all ${
                    businessType === t ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-500'
                  } ${store?.stripeAccountId ? 'opacity-70 cursor-not-allowed' : ''}`}>
                  {t === 'individual' ? '👤 個人事業主' : '🏢 法人'}
                </button>
              ))}
            </div>
            {fieldErrors.businessType && (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />{fieldErrors.businessType}
              </p>
            )}
          </Section>

          {/* ② 法人名（法人選択時のみ） */}
          {businessType === 'company' && (
            <Section title="法人情報" icon={<Building2 className="w-5 h-5 text-orange-500" />}>
              <FieldWrap label="法人名（漢字）" required error={fieldErrors.companyNameKanji}>
                <input type="text" value={companyNameKanji} onChange={e => setCompanyNameKanji(e.target.value)}
                  placeholder="株式会社〇〇フード" required className={fieldClass('companyNameKanji')} />
              </FieldWrap>
              <FieldWrap label="法人名（カナ）" required hint="全角カタカナ" error={fieldErrors.companyNameKana}>
                <input type="text" value={companyNameKana} onChange={e => setCompanyNameKana(e.target.value)}
                  placeholder="カブシキガイシャ〇〇フード" required className={fieldClass('companyNameKana')} />
              </FieldWrap>
              <FieldWrap label="法人名（英語/ローマ字）" required hint="ラテン文字で入力（例: Kabushiki Gaisha OO Food）" error={fieldErrors.companyNameLatin}>
                <input type="text" value={companyNameLatin} onChange={e => setCompanyNameLatin(e.target.value)}
                  placeholder="Kabushiki Gaisha OO Food" required className={fieldClass('companyNameLatin')} />
              </FieldWrap>
            </Section>
          )}

          {/* ③ 代表者氏名 */}
          <Section title="代表者氏名" icon={<User className="w-5 h-5 text-orange-500" />}>
            <div className="grid grid-cols-2 gap-3">
              <FieldWrap label="姓（漢字）" required error={fieldErrors.lastNameKanji}>
                <input type="text" value={lastNameKanji} onChange={e => setLastNameKanji(e.target.value)}
                  placeholder="山田" required className={fieldClass('lastNameKanji')} />
              </FieldWrap>
              <FieldWrap label="名（漢字）" required error={fieldErrors.firstNameKanji}>
                <input type="text" value={firstNameKanji} onChange={e => setFirstNameKanji(e.target.value)}
                  placeholder="太郎" required className={fieldClass('firstNameKanji')} />
              </FieldWrap>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldWrap label="姓（カナ）" required hint="全角カタカナ" error={fieldErrors.lastNameKana}>
                <input type="text" value={lastNameKana} onChange={e => setLastNameKana(e.target.value)}
                  placeholder="ヤマダ" required className={fieldClass('lastNameKana')} />
              </FieldWrap>
              <FieldWrap label="名（カナ）" required hint="全角カタカナ" error={fieldErrors.firstNameKana}>
                <input type="text" value={firstNameKana} onChange={e => setFirstNameKana(e.target.value)}
                  placeholder="タロウ" required className={fieldClass('firstNameKana')} />
              </FieldWrap>
            </div>
            <FieldWrap label="電話番号" required hint="ハイフンなし（例: 09012345678）" error={fieldErrors.phone || phoneError || undefined}>
              <input type="tel" value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^\d+\-()]/g, ''))}
                placeholder="09012345678" inputMode="tel" required
                className={phoneError || fieldErrors.phone ? errInput : fieldClass('phone')} />
            </FieldWrap>
            <FieldWrap label="メールアドレス" required error={fieldErrors.email}>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="owner@example.com" required className={fieldClass('email')} />
            </FieldWrap>
          </Section>

          {/* ③ 生年月日 */}
          <Section title="生年月日" icon={<User className="w-5 h-5 text-orange-500" />}>
            <div className="grid grid-cols-3 gap-3">
              <FieldWrap label="年" required error={fieldErrors.dobYear}>
                <input type="number" value={dobYear} onChange={e => setDobYear(e.target.value)}
                  placeholder="1985" min={1920} max={new Date().getFullYear() - 18}
                  required inputMode="numeric" className={fieldClass('dobYear')} />
              </FieldWrap>
              <FieldWrap label="月" required error={fieldErrors.dobMonth}>
                <select value={dobMonth} onChange={e => setDobMonth(e.target.value)} required className={selectFieldClass('dobMonth')}>
                  <option value="">月</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                    <option key={m} value={m}>{m}月</option>
                  ))}
                </select>
              </FieldWrap>
              <FieldWrap label="日" required error={fieldErrors.dobDay}>
                <select value={dobDay} onChange={e => setDobDay(e.target.value)} required className={selectFieldClass('dobDay')}>
                  <option value="">日</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}日</option>
                  ))}
                </select>
              </FieldWrap>
            </div>
          </Section>

          {/* ④ 住所 */}
          <Section title="代表者（本人）の住所" icon={<MapPin className="w-5 h-5 text-orange-500" />}>
            <FieldWrap label="郵便番号（ハイフンなし7桁）" required error={fieldErrors.postalCode}>
              <div className="relative">
                <input type="text" value={postalCode} onChange={e => handlePostalCodeChange(e.target.value)}
                  placeholder="5300001" maxLength={7} inputMode="numeric" required
                  className={fieldClass('postalCode')} />
                {zipLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-orange-400 animate-spin" />}
              </div>
              {!fieldErrors.postalCode && <p className="text-xs text-gray-400 mt-1.5">7桁入力で住所を自動補完</p>}
            </FieldWrap>

            <FieldWrap label="都道府県" required error={fieldErrors.stateKanji}>
              <select value={PREFECTURES_KANJI.indexOf(stateKanji).toString()}
                onChange={e => handlePrefectureChange(e.target.value)} required className={selectFieldClass('stateKanji')}>
                <option value="-1">選択してください</option>
                {PREFECTURES_KANJI.map((p, i) => <option key={p} value={i}>{p}</option>)}
              </select>
            </FieldWrap>

            <div className="grid grid-cols-2 gap-3">
              <FieldWrap label="市区町村（漢字）" required error={fieldErrors.cityKanji}>
                <input type="text" value={cityKanji} onChange={e => setCityKanji(e.target.value)}
                  placeholder="大阪市北区" required className={fieldClass('cityKanji')} />
              </FieldWrap>
              <FieldWrap label="町名・番地（漢字）" required error={fieldErrors.townKanji}>
                <input type="text" value={townKanji} onChange={e => setTownKanji(e.target.value)}
                  placeholder="梅田1-1" required className={fieldClass('townKanji')} />
              </FieldWrap>
            </div>

            <FieldWrap label="建物名・部屋番号（任意）" error={fieldErrors.line1Kanji}>
              <input type="text" value={line1Kanji} onChange={e => setLine1Kanji(e.target.value)}
                placeholder="○○ビル 101号室" className={fieldClass('line1Kanji')} />
            </FieldWrap>

            {/* カナ住所 */}
            <div className="pt-3 border-t border-gray-100 space-y-3">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">住所（カタカナ）</p>
              <div className="grid grid-cols-2 gap-3">
                <FieldWrap label="市区町村（カナ）" required error={fieldErrors.cityKana}>
                  <input type="text" value={cityKana} onChange={e => setCityKana(e.target.value)}
                    placeholder="オオサカシキタク" required className={fieldClass('cityKana')} />
                </FieldWrap>
                <FieldWrap label="町名・番地（カナ）" required error={fieldErrors.townKana}>
                  <input type="text" value={townKana} onChange={e => setTownKana(e.target.value)}
                    placeholder="ウメダ1-1" required className={fieldClass('townKana')} />
                </FieldWrap>
              </div>
              <FieldWrap label="建物名（カナ・任意）" error={fieldErrors.line1Kana}>
                <input type="text" value={line1Kana} onChange={e => setLine1Kana(e.target.value)}
                  placeholder="○○ビル101" className={fieldClass('line1Kana')} />
              </FieldWrap>
            </div>
          </Section>

          {/* ⑤ 事業内容 */}
          <Section title="事業内容" icon={<FileText className="w-5 h-5 text-orange-500" />}>
            <FieldWrap label="サービス内容の説明" required
              hint={!fieldErrors.productDescription ? "10文字以上（例：飲食店での余剰食品のおすそわけ販売）" : undefined}
              error={fieldErrors.productDescription}>
              <textarea value={productDescription} onChange={e => setProductDescription(e.target.value)}
                placeholder="例：飲食店での余剰食品を詰め合わせた「おすそわけ袋」の販売。フードロス削減を目的とした割引価格での提供。"
                rows={4} required minLength={10}
                className={`${fieldErrors.productDescription ? errInput : okInput} resize-none`} />
              <p className="text-xs text-gray-400 mt-1">{productDescription.length} 文字</p>
            </FieldWrap>

            <FieldWrap label="ウェブサイトURL（任意）" hint="店舗のSNSや公式サイト" error={fieldErrors.businessUrl}>
              <input type="url" value={businessUrl} onChange={e => setBusinessUrl(e.target.value)}
                placeholder="https://example.com" className={fieldClass('businessUrl')} />
            </FieldWrap>
          </Section>

          {/* ⑥ 本人確認書類 */}
          <Section title="本人確認書類" icon={<Camera className="w-5 h-5 text-orange-500" />}>
            <p className="text-xs text-gray-500 leading-relaxed">
              運転免許証・マイナンバーカード・パスポートなどをアップロードしてください。<br />
              表面は必須。裏面は運転免許証など書類の種類に応じて追加してください。
            </p>

            {docError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">{docError}</p>
              </div>
            )}

            {/* 表面（必須） */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                表面 <span className="text-red-400">*</span>
              </p>
              <input ref={frontInputRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif"
                onChange={handleDocFileChange('front')} className="hidden" />

              {docFrontPreview ? (
                <div className="relative">
                  <img loading="lazy" decoding="async" src={docFrontPreview} alt="表面プレビュー"
                    className="w-full max-h-48 object-contain rounded-xl border-2 border-green-300 bg-gray-50" />
                  {!docFrontDone && (
                    <button type="button"
                      onClick={() => { setDocFrontFile(null); setDocFrontPreview(null); setDocFrontDone(false); if (frontInputRef.current) frontInputRef.current.value = ''; }}
                      className="absolute top-2 right-2 w-7 h-7 bg-gray-800/60 rounded-full flex items-center justify-center">
                      <X className="w-4 h-4 text-white" />
                    </button>
                  )}
                  {docFrontDone ? (
                    <div className="flex items-center gap-1.5 mt-2">
                      <BadgeCheck className="w-4 h-4 text-green-500" /><span className="text-xs text-green-600 font-bold">Stripeに送信済み</span>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      <button type="button" disabled={docLoading === 'front'} onClick={() => handleDocUpload('front')}
                        className="w-full py-2.5 bg-orange-500 text-white font-bold text-sm rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98]">
                        {docLoading === 'front' ? <><Loader2 className="w-4 h-4 animate-spin" />送信中...</> : <><Upload className="w-4 h-4" />この画像だけ今すぐ送信する</>}
                      </button>
                      <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                        本人確認書類の再提出だけなら、このボタンで送信できます（氏名・住所などの入力は不要です）
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => frontInputRef.current?.click()}
                  className="w-full h-36 border-2 border-dashed border-orange-300 rounded-xl flex flex-col items-center justify-center gap-2 hover:border-orange-400 hover:bg-orange-50 transition-colors">
                  <Camera className="w-9 h-9 text-orange-300" />
                  <p className="text-sm text-orange-400 font-bold">タップして表面を選択</p>
                  <p className="text-xs text-gray-300">JPG / PNG / HEIC 対応</p>
                </button>
              )}
            </div>

            {/* 裏面（任意） */}
            <div className="space-y-2 pt-3 border-t border-gray-100">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">裏面（任意）</p>
              <input ref={backInputRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif"
                onChange={handleDocFileChange('back')} className="hidden" />

              {docBackPreview ? (
                <div className="relative">
                  <img loading="lazy" decoding="async" src={docBackPreview} alt="裏面プレビュー"
                    className="w-full max-h-48 object-contain rounded-xl border-2 border-green-300 bg-gray-50" />
                  {!docBackDone && (
                    <button type="button"
                      onClick={() => { setDocBackFile(null); setDocBackPreview(null); setDocBackDone(false); if (backInputRef.current) backInputRef.current.value = ''; }}
                      className="absolute top-2 right-2 w-7 h-7 bg-gray-800/60 rounded-full flex items-center justify-center">
                      <X className="w-4 h-4 text-white" />
                    </button>
                  )}
                  {docBackDone ? (
                    <div className="flex items-center gap-1.5 mt-2">
                      <BadgeCheck className="w-4 h-4 text-green-500" /><span className="text-xs text-green-600 font-bold">Stripeに送信済み</span>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      <button type="button" disabled={docLoading === 'back'} onClick={() => handleDocUpload('back')}
                        className="w-full py-2.5 bg-orange-500 text-white font-bold text-sm rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98]">
                        {docLoading === 'back' ? <><Loader2 className="w-4 h-4 animate-spin" />送信中...</> : <><Upload className="w-4 h-4" />この画像だけ今すぐ送信する</>}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => backInputRef.current?.click()}
                  className="w-full h-28 border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center gap-2 hover:border-orange-400 hover:bg-orange-50 transition-colors">
                  <ImageIcon className="w-7 h-7 text-gray-300" />
                  <p className="text-xs text-gray-400 font-medium">裏面を追加する（任意）</p>
                </button>
              )}
            </div>
          </Section>

          {/* グローバルエラー */}
          <AnimatePresence>
            {globalError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3"
              >
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{globalError}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 書類未選択の場合の注意 */}
          {!docFrontPreview && (
            <p className="text-xs text-red-500 text-center flex items-center justify-center gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              本人確認書類（表面）を選択してから送信できます
            </p>
          )}

          {/* 送信ボタン */}
          <button type="submit" disabled={!canSubmit}
            className="w-full py-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-base rounded-2xl shadow-lg disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-opacity active:scale-[0.98]">
            {loading
              ? <><Loader2 className="w-5 h-5 animate-spin" />入力情報と書類を送信中...</>
              : <><Upload className="w-5 h-5" />入力情報と書類を一括送信する</>
            }
          </button>

          <div className="flex items-center justify-center gap-1.5 text-xs text-gray-400 pb-4">
            <ShieldCheck className="w-4 h-4" />
            <span>情報はStripeのサーバーに直接・安全に送信されます</span>
          </div>
        </form>
      </div>
    </div>
  );
}
