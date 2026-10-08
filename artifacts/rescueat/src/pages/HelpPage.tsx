import React, { useState } from 'react';
import { Layout } from '@/components/Layout';
import {
  ChevronDown, ChevronUp, ChevronLeft, HelpCircle,
  ShoppingBag, CreditCard, AlertTriangle, MessageCircle,
  Store, Banknote, Receipt, BadgePercent,
  Leaf, Smartphone, Package,
  MapPin, QrCode, Sparkles, Clock, Star, Search,
  Camera, FileCheck, Bell, ScanLine, TrendingUp,
  Lightbulb, PartyPopper, CheckCircle2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';

interface FaqItem {
  q: string;
  a: string;
}

interface FaqSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  color: string;
  items: FaqItem[];
}

/* ─────────────────────────────────────────────
   ユーザー（購入者）向け FAQ
───────────────────────────────────────────── */
const USER_FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'order',
    title: '注文・受取について',
    icon: <ShoppingBag className="w-5 h-5" />,
    color: 'bg-orange-100 text-primary',
    items: [
      {
        q: '商品の内容は事前にわかりますか？',
        a: '商品の種類によって異なります。\n\n・おすそわけ袋：中身はお楽しみのセット形式のため、具体的な中身は事前にお知らせできません。\n\n・単品商品：商品名に記載されている特定の商品を販売しています。\n\nいずれの場合も、アレルギーなどが心配な方は受取時に店舗スタッフへ直接ご確認ください。',
      },
      {
        q: '受取方法を教えてください。',
        a: '購入後に発行される「電子チケット（QRコード）」を店舗スタッフに提示してください。アプリ内「購入履歴」→該当の注文→「チケットを表示」からいつでか確認できます。',
      },
      {
        q: '受取時間に間に合わない場合はどうすればいいですか？',
        a: '受取可能時間はお店ごとに異なります。時間に間に合わない場合は、できるだけ早めに店舗へ直接ご連絡ください。時間を過ぎた場合の商品保持はお店の判断によります。',
      },
      {
        q: '注文後のキャンセルはできますか？',
        a: '購入確定後のキャンセルは原則お受けできません。食品ロス削減のためにご協力をお願いしております。やむを得ない事情がある場合は、下記のLINEサポートまでお問い合わせください。',
      },
      {
        q: 'QRコード（電子チケット）を紛失した場合は？',
        a: 'アプリにログインして「購入履歴」から再表示できます。チケットはアプリ内にいつでも保存されていますのでご安心ください。',
      },
      {
        q: '同じ店舗でまとめて複数個購入できますか？',
        a: '1回の注文につき1つのおすそわけ袋を購入いただけます。複数購入を希望の場合は、お店に在庫が残っていれば繰り返しご購入いただけます。',
      },
      {
        q: '「受取時間 18:00〜20:00」のような表示は何を意味しますか？',
        a: 'お店が指定した「商品をお渡しできる時間帯」です。この枠内に来店してQRコードをご提示ください。\n\n枠の前に到着しても商品はまだ準備中の可能性があります。枠の後に到着すると、お店が商品を引き取ってしまっている可能性があります。\n\n間に合わない場合はできるだけ早めにお店へ直接ご連絡ください。',
      },
      {
        q: '受取時間が深夜にまたがる場合（例：22:00〜翌1:00）はどう見ればよいですか？',
        a: '「22:00〜01:00」のように終了時刻が開始時刻より早い場合は「翌日にまたがる受取枠」を意味します。\n\n例：火曜日に出品 → 火曜22:00〜水曜1:00 まで受取可能。\n\nアプリは深夜またぎを自動判定し、その日のうちに受け取れるよう表示します。',
      },
      {
        q: 'まだ出品されていないお店をリクエストできますか？',
        a: 'できます。マイページの「気になるお店を運営に紹介する」から店舗情報を送信してください。事務局からそのお店にお声がけし、参加交渉をいたします。\n\n※ 必ず出品開始をお約束するものではありませんが、リクエストが多いお店は優先的にアプローチします。',
      },
    ],
  },
  {
    id: 'payment',
    title: '支払いについて',
    icon: <CreditCard className="w-5 h-5" />,
    color: 'bg-blue-100 text-blue-600',
    items: [
      {
        q: '使用できる支払い方法は何ですか？',
        a: 'クレジットカード・デビットカード（Visa / Mastercard / American Express / JCB）に対応しています。カード情報は国際基準のセキュリティ認証（PCI DSS準拠）で安全に管理されます。',
      },
      {
        q: '支払い後のキャンセル・返金はできますか？',
        a: '食品の特性上、原則として返金はお受けできません。ただし、商品未提供・二重決済など明らかなシステムトラブルの場合はご対応いたします。下記LINEサポートまでご連絡ください。',
      },
      {
        q: '領収書は発行できますか？',
        a: '発行できます。メール送付はなく、アプリ内の「購入履歴」から各自で発行する方式です。\n\n【発行手順】\n① マイページ → 「購入履歴」をタップ\n② 領収書を発行したい注文をタップ\n③ 画面下部の「印刷・保存」ボタンで印刷またはPDF保存\n\n宛名は発行画面で任意入力できます（未入力の場合はアカウント名が使用されます）。\n消費税は食品の軽減税率（8%）で自動計算されます。',
      },
      {
        q: '価格はどのように決まっていますか？',
        a: 'おすそわけ袋の価格は各店舗が設定します。通常の販売価格より大幅に割引（50〜70%オフ程度）された価格で提供されています。',
      },
      {
        q: '表示価格とお支払い金額が違うのはなぜですか？',
        a: 'いいえ、追加の手数料は一切ありません。アプリに表示されている価格には、サービス運営に必要な手数料（5%）と消費税がすべて含まれた「総額表示」になっています。表示された金額をそのままお支払いいただきます。\n\n例：表示価格 ¥530 → ご請求 ¥530（追加なし）\n例：表示価格 ¥370 → ご請求 ¥370（追加なし）\n\n領収書・購入履歴にも表示価格と同じ金額が記載されます。',
      },
      {
        q: '決済情報は安全ですか？',
        a: 'カード情報はアプリ・サーバーに一切保存されません。国際基準のセキュリティ認証（PCI DSS準拠）を持つ決済パートナーが安全に管理します。',
      },
    ],
  },
  {
    id: 'trouble',
    title: 'トラブル・その他',
    icon: <AlertTriangle className="w-5 h-5" />,
    color: 'bg-red-100 text-red-500',
    items: [
      {
        q: '受け取った商品に問題があった場合は？',
        a: '異物混入・著しく品質が低い場合は、証拠写真を添えて下記LINEサポートまでご連絡ください。内容を確認の上、対応を検討いたします。なお、おすそわけ袋の性質上、見た目や量が期待と異なる場合がありますがその場合は返金対象外となります。',
      },
      {
        q: 'お店が閉まっていた・商品を受け取れなかった場合は？',
        a: '臨時休業などでお店が閉まっており商品を受け取れなかった場合は、写真を撮っておき、LINEサポートまでご連絡ください。状況を確認のうえ、対応いたします。',
      },
      {
        q: 'アプリが正常に動作しない場合は？',
        a: 'まずアプリを再読み込み（リロード）してお試しください。それでも改善しない場合は、お使いのブラウザ・OSのバージョンを最新に更新してみてください。解決しない場合はLINEサポートまでお問い合わせください。',
      },
      {
        q: 'アカウントを削除したい場合は？',
        a: 'アプリ内「マイページ」→「アカウント設定」→「アカウント削除（退会）」から手続きできます。削除後はデータを復元できませんのでご注意ください。',
      },
      {
        q: 'お気に入り店舗はどこで確認できますか？',
        a: '画面下のナビバーにある「お気に入り」からいつでも確認できます。店舗ページのハートマークをタップして登録・解除できます。',
      },
      {
        q: '商品の写真と実物が違う場合は？',
        a: 'おすそわけ袋は「中身おまかせ」のサプライズ形式のため、商品写真はあくまでイメージです。日によって内容や見た目が変わることがあり、写真と完全に一致しないことは食品ロス削減の特性上ご了承ください。\n\nただし、明らかに腐敗・異物混入・量が著しく少ないなどの場合は、写真を添えてLINEサポートまでご連絡ください。',
      },
      {
        q: 'パスワードを忘れた場合は？',
        a: 'ログイン画面の「パスワードを忘れた方はこちら」から、登録したメールアドレスを入力してください。パスワード再設定用のメールが届きます。\n\nメールが届かない場合は、迷惑メールフォルダをご確認のうえ、それでも見当たらない場合はLINEサポートまでご連絡ください。',
      },
      {
        q: '表示名（ニックネーム）やプロフィール画像を変更したい',
        a: 'マイページ →「アカウント設定」から、いつでも変更できます。\n\n変更内容は店舗側には表示されません（受取時はQRコードで照合します）。',
      },
    ],
  },
  {
    id: 'food-safety',
    title: '食品の安全・取扱いについて',
    icon: <Leaf className="w-5 h-5" />,
    color: 'bg-green-100 text-green-600',
    items: [
      {
        q: '賞味期限・消費期限はどうなっていますか？',
        a: 'おすそわけで販売される商品は「当日中」または「翌日中」に消費することを前提とした食品が中心です。\n\n惣菜・パン・お弁当などは その日のうちに、お野菜・乳製品などは1〜2日以内に お召し上がりください。\n\n個別商品の期限が気になる場合は、受取時に店舗スタッフへ直接ご確認ください。',
      },
      {
        q: 'アレルギー情報はどこで確認できますか？',
        a: '店舗が情報を入力している商品については、商品詳細ページの「アレルギー情報」欄に表示されます。\n\nおすそわけ袋（中身おまかせ形式）は内容が日によって変わるため、店舗側で全アレルゲンを事前に把握できない場合があります。重度のアレルギーをお持ちの方は、ご注文前または受取時に必ず店舗スタッフへ直接ご確認ください。',
      },
      {
        q: '持ち帰った後の保存方法は？',
        a: '基本的に冷蔵保存（10℃以下）し、できるだけ早くお召し上がりください。\n\n・惣菜・お弁当：当日中の喫食を強く推奨\n・パン・焼き菓子：翌日中目安、長期保存する場合は冷凍\n・野菜・果物：野菜室で2〜3日以内\n・乳製品：表示の期限に従って速やかに\n\n常温で長時間放置されますと食中毒の原因となります。受取後はすみやかに冷蔵環境へ移動してください。',
      },
      {
        q: '加熱が必要な商品はどうやって見分けますか？',
        a: '揚げ物・煮物・お弁当などは、念のため再加熱してからお召し上がりいただくと安心です。電子レンジで600W 1〜2分程度を目安にしてください。\n\n刺身などの生食品はおすそわけでは原則取り扱いがありません。',
      },
    ],
  },
  {
    id: 'app-privacy',
    title: 'アプリ・通知・プライバシー',
    icon: <Smartphone className="w-5 h-5" />,
    color: 'bg-indigo-100 text-indigo-600',
    items: [
      {
        q: 'プッシュ通知の設定はどこで変更できますか？',
        a: 'マイページ →「アカウント設定」内の通知トグルから、近隣店舗の新規出品通知をいつでもオン／オフ切り替えできます。\n\nブラウザ・端末側の通知許可がオフになっている場合は、まず端末の「設定 → 通知 → ブラウザ（または「おすそわけ」アプリ）」から許可してください。',
      },
      {
        q: '位置情報はどう使われますか？',
        a: '近隣店舗の検索・地図表示・徒歩時間の計算 にのみ使用します。位置情報は端末上で都度取得され、サーバーに保存することはありません。\n\n位置情報をオフにすると地図検索や「近くのお店」機能の精度が下がりますが、それ以外の機能（お気に入り店舗・購入履歴など）は通常通りご利用いただけます。',
      },
      {
        q: 'マイタウン・月間ランキングは何ですか？',
        a: '「マイタウン」はあなたが食品ロス削減に貢献した回数に応じて街が育つビジュアル機能です。受取が増えるごとに住人や建物が増えていきます。\n\n「月間ランキング」は その月のおすそわけ受取回数 を他のユーザーと競う機能で、毎月1日にリセットされます。マイタウンのレベルや累計の食品ロス削減量はリセットされません。',
      },
      {
        q: 'ランキングに参加したくない場合は？',
        a: '参加しないこともできます。マイページ →「アカウント設定」の「ランキングに参加する」をオフにすると、あなたの順位はランキング画面に表示されなくなります。\n\nスコア（食品ロス削減量・CO2削減量）やマイタウンは引き続き表示され、いつでも再参加できます。',
      },
      {
        q: 'アプリが正常に動作しない・更新されない場合は？',
        a: 'まずページを再読み込み（リロード）してください。ホーム画面アイコンから起動した場合は、いったんアプリを終了して再度起動するとキャッシュが更新されます。\n\nそれでも改善しない場合は、ブラウザのキャッシュをクリアするか、最新OS／ブラウザに更新してください。解決しない場合はLINEサポートまでお問い合わせください。',
      },
    ],
  },
];

/* ─────────────────────────────────────────────
   店舗（出品者）向け FAQ
   ※ Stripeダッシュボードへのログインは不可（Custom Connect）
   ※ 振込スケジュール変更はオーナー側では不可
   ※ 売上確認はアプリ内のみ
───────────────────────────────────────────── */
const STORE_FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'store-register',
    title: '登録・出品について',
    icon: <Store className="w-5 h-5" />,
    color: 'bg-orange-100 text-primary',
    items: [
      {
        q: 'お店として出品するにはどうすればいいですか？',
        a: 'マイページの「お店を登録する」から、店舗名・住所・営業許可証などの情報をアップロードして申請してください。\n\nおすそわけ事務局が内容を確認し、通常1〜3営業日以内に審査結果をメールでご連絡します。承認後すぐに初期費用なしで出品を開始できます。\n\n【出品開始までの流れ】\n① 店舗審査（通常1〜3営業日）→ おすそわけ事務局よりメールでご連絡\n② 口座登録（店舗ダッシュボードで銀行口座を登録）\n③ 口座審査（通常1〜3営業日）→ おすそわけ事務局よりメールでご連絡\n④ 審査完了後、自動で出品機能が解除されます\n\n②・③が完了するまで出品はできません。口座審査完了後に初めて出品・販売・振込がすべて開始されます。',
      },
      {
        q: '出品価格に制限はありますか？',
        a: 'システムの都合上、最低¥50以上の価格設定が必要です。\n\n¥0（無料おすそわけ）での出品はシステム上対応しておりません。フードロス削減の観点から、通常販売価格の30〜50%程度の割引価格での出品を推奨しています。',
      },
      {
        q: '出品できる商品の種類に制限はありますか？',
        a: '当日または翌日中に消費される食品（惣菜・パン・スイーツ・弁当・野菜・乳製品など）が対象です。アルコール類・生の魚介類（刺身など）は現時点では対象外となります。\n\nご不明な場合はLINEサポートにご相談ください。',
      },
      {
        q: '2店舗目・3店舗目を追加登録できますか？',
        a: 'できます。マイページの「新しい店舗を追加登録する」から追加申請してください。\n\n2店舗目以降は、最初に登録済みの決済口座（銀行口座・本人確認情報）が自動的に引き継がれます。そのため、追加店舗では営業許可証の提出のみで手続きが完了します。\n\n売上はすべてのお店を合算して同じ口座へ振り込まれます。',
      },
      {
        q: '個人事業主で登録したが、法人に変更したい場合は？',
        a: '決済システムの仕様上、口座登録時に選択した「個人事業主 / 法人」の区分は、後から変更することができません。\n\n変更が必要な場合はLINEサポートへご連絡ください。事務局が対応します。\n\n【変更の流れ】\n① 売上残高が¥0であることを確認（残高があると旧口座に振り込まれます）\n② LINEに「業種変更希望（個人→法人）」とメッセージ\n③ 事務局が口座連携を解除します（1〜2営業日以内）\n④ 解除後、マイページの「口座を登録する」から新しい口座を登録\n⑤ 登録画面で「法人」を選択して最初から設定し直す\n\n再登録後は決済システムによる審査が行われます（通常1〜3営業日）。それまでの間、売上の受け取りは一時的に停止します。',
      },
      {
        q: 'パスワードを変更したい',
        a: '一度ログアウトしてから、ログイン画面の「パスワードを忘れた方はこちら」を選択し、登録メールアドレスを入力してください。再設定用のリンクがメールで届きます。\n\nメールが届かない場合は迷惑メールフォルダをご確認のうえ、それでも見当たらない場合はLINEサポートまでご連絡ください。',
      },
      {
        q: 'アプリ内での店舗の表示順位はどう決まりますか？',
        a: '主に「ユーザーの現在地からの距離」「お気に入り登録数」「直近の出品アクティブ状況」を組み合わせて並び替えています。\n\n表示順位を上げるためには、定期的な出品 と 商品写真・お店の説明文の充実 が効果的です。お金を払って順位を上げる「広告枠」のような仕組みは現時点ではありません。',
      },
    ],
  },
  {
    id: 'store-bag-mgmt',
    title: '出品の管理・運用',
    icon: <Package className="w-5 h-5" />,
    color: 'bg-amber-100 text-amber-700',
    items: [
      {
        q: '出品中の商品を削除・修正したい',
        a: '【削除】 店舗ダッシュボードの「商品管理」から、各商品カードのゴミ箱アイコンで削除できます。\n\n【在庫数の変更】 同じカードの「＋／−」ボタンで残り個数をその場で増減できます。\n\n【価格・受取時間・写真の変更】 現状はカード上から直接編集する機能は準備中です。一度「非公開」にして同じ内容で新規出品し直すか、削除して新規出品をお願いします（インライン編集機能は順次追加予定です）。\n\n⚠️ すでに予約が入っている商品は削除できません。お客様のご来店をお待ちいただくか、LINEサポート経由で個別対応をご相談ください。',
      },
      {
        q: '残り個数（在庫数）を変更したい',
        a: '店舗ダッシュボードの「商品管理」内、各商品カードの「＋／−」ボタンで在庫数を1個ずつ増減できます。タップで直接数値入力も可能です。\n\n変更は即時にお客様アプリへ反映されます。',
      },
      {
        q: '売り切れた後はどうなりますか？',
        a: '在庫数が0になると、自動的にお客様アプリの一覧から非表示になります（カードは「完売」表示）。\n\nまだ受取時間内であれば、在庫を1個以上に戻すことで再度購入可能になります。受取終了時刻を過ぎた商品は翌日まで自動的に非表示となります。',
      },
      {
        q: '一時的に出品を停止したい',
        a: '商品を削除せずに「非公開」にできます。商品カードの公開トグルをオフにすると、お客様アプリの一覧から非表示になります（予約済みのお客様には影響しません）。\n\nもう一度オンに戻せばすぐに再開できます。臨時休業や仕込みが間に合わない時にご活用ください。',
      },
      {
        q: '受取時間枠（pickup time）の設定の考え方は？',
        a: '「閉店30分〜1時間前」を目安に、商品をまとめて引き渡せる時間帯を設定するのがおすすめです。\n\n例：21:00閉店のお店 → 受取 19:30〜20:30\n例：ランチタイムの売れ残り → 受取 14:00〜15:00\n\n枠を狭くしすぎるとお客様が間に合わず予約が伸びにくく、広くしすぎるとオペレーションの負荷が上がります。最初は1〜2時間幅で設定し、運用しながら調整してください。',
      },
      {
        q: '受取時間が深夜にまたがる場合（例：22:00〜翌1:00）は設定できますか？',
        a: 'はい、設定できます。終了時刻が開始時刻より小さい場合（例：開始22:00／終了01:00）、自動的に「翌日にまたがる受取枠」として処理されます。\n\nバー・居酒屋・夜営業の飲食店などでお使いください。お客様のアプリには「22:00〜翌1:00」と表示されます。',
      },
      {
        q: 'アレルギー情報は入力すべきですか？',
        a: '可能な範囲で入力を強く推奨します。商品作成時の「アレルギー情報」欄に主要なアレルゲン（小麦・卵・乳・そば・落花生・えび・かに）を記載してください。\n\nおすそわけ袋（中身おまかせ形式）で日によって内容が変わる場合は「日により変動あり、受取時にご確認ください」と記載いただいて構いません。重度アレルギーのお客様への安全配慮のためご協力をお願いします。',
      },
      {
        q: '商品写真の撮り方のコツはありますか？',
        a: '【明るい場所で撮影】 自然光が入る窓際や、白色のLED照明の下が理想的です。\n\n【俯瞰アングル】 真上から撮ると中身が見やすくおすすめです。\n\n【お皿・かごに盛り付け】 袋のままより、お皿に並べた写真の方が魅力的に見えます。\n\n【1枚で全体像を伝える】 アプリでは1枚の写真がメイン表示になります。複数の商品が入る袋なら、全部並べて1枚に収めましょう。',
      },
      {
        q: '値引きの目安はどのくらいですか？',
        a: 'おすすめは「通常価格の50〜70%オフ」（つまり通常価格の30〜50%の値段）です。\n\n例：通常¥1,500の商品 → ¥500〜¥750で出品\n\n割引率が高いほどお客様が反応しやすく、廃棄予定の食品は売り切れる可能性が高まります。逆に割引が小さいと予約が入りにくく、廃棄リスクが残ります。',
      },
    ],
  },
  {
    id: 'store-payment',
    title: '売上・振込について',
    icon: <Banknote className="w-5 h-5" />,
    color: 'bg-green-100 text-green-600',
    items: [
      {
        q: '売上はいつ、どのように振り込まれますか？',
        a: '口座登録が完了すると、売上からおすそわけの手数料を差し引いた金額が自動的に登録口座へ振り込まれます。\n\n【振込の仕組み】\n① 決済確定から7日後（カレンダー日）に「振込可能」へ移動します\n② 「振込可能」になった残高は、毎月25日にまとめて自動振込されます\n\n例：5月10日に売れた場合 → 5月17日に振込可能 → 5月25日に振込\n例：5月22日に売れた場合 → 5月29日に振込可能 → 6月25日に振込\n\n店舗ダッシュボードの「売上残高」では「保留中」「振込可能」の金額をリアルタイムで確認できます。表示されている「次回:〇月〇日」は、保留中の残高が振込可能になる日以降、最初に到来する25日として計算されています。\n\nスケジュールの変更はできません。詳しくはLINEサポートまでお問い合わせください。',
      },
      {
        q: 'プラットフォーム手数料はいくらですか？',
        a: '販売成立時のみ、店舗様が登録した商品代金の20%をプラットフォーム手数料として申し受けます。初期費用・月額費用は一切かかりません。\n\nまた、決済手数料（お客様お支払い金額の3.6%）が別途かかります。\n\n例：商品代金¥500（店舗様登録価格）の場合\n・お客様お支払い：¥530（アプリ表示価格＝サービス料込み総額）\n・店舗様取り分：商品代金¥500 × 80% = ¥400\n・決済手数料：¥530 × 3.6% ≒ ¥19\n・お振込額：約¥381（¥400 − ¥19）',
      },
      {
        q: 'お客様のお支払い金額はいくらになりますか？',
        a: 'お客様には「アプリに表示される総額」をそのままお支払いいただきます（追加手数料なし）。アプリ表示価格は、店舗様が登録した商品代金にサービス手数料5%を加算し10円単位で四捨五入した「税込・サービス料込み価格」です。\n\nお客様への手数料表記は一切表示されないため、お客様は安心して買い物できます。店舗様の取り分は常に「商品代金（店舗様の登録価格）」をベースに計算されるため、表示価格化の影響は受けません。\n\n例：\n・登録価格¥350 → アプリ表示¥370 → 店舗取り分¥350×80%=¥280\n・登録価格¥500 → アプリ表示¥530 → 店舗取り分¥500×80%=¥400\n・登録価格¥800 → アプリ表示¥840 → 店舗取り分¥800×80%=¥640',
      },
      {
        q: '売上の確認はどこでできますか？',
        a: 'アプリ内「売上管理」画面からご確認いただけます。月別の売上サマリー・個別の取引履歴をいつでも確認できます。\n\n売上はおすそわけの管理システムで一括管理しているため、外部サービスへのログインは不要です。',
      },
      {
        q: '銀行通帳に「ストライプ ジャパン」と表示されるのはなぜですか？',
        a: 'おすそわけの売上振込は、決済システム「Stripe（ストライプ）」を通じて行われます。そのため、銀行の通帳やアプリには振込人名として「ストライプ ジャパン」と表示されます。\n\nこれは正常な振込です。金額と日付をご確認のうえ、売上の振込として処理してください。\n\n⚠️ この振込人名はシステム上の仕様であり、「おすそわけ」などの名称に変更することはできません。',
      },
      {
        q: 'お客様が来店しなかった場合（ノーショー）は売上はどうなりますか？',
        a: '決済はご注文時点で確定しているため、ご来店がなくても売上は通常通り発生し、所定スケジュールで振り込まれます。\n\nお客様にも「キャンセルは原則不可」とご案内しているため、来店されなかった分の商品は店舗様の判断で処分・スタッフ消費いただいて構いません。\n\n再三のノーショーや悪質な利用が続くお客様がいらっしゃいましたら、LINEサポートまでご連絡ください。事務局でアカウントの状況を確認いたします。',
      },
      {
        q: '売上データを月別に確認・出力できますか？',
        a: '店舗ダッシュボードの「売上管理」から、月別の売上サマリー・個別の取引履歴を一覧で確認できます。\n\n税務申告・会計処理用にエクスポート機能が必要な場合は、現状LINEサポートへご依頼いただければ事務局より該当期間の売上データをお送りします。今後アプリ内からの直接ダウンロード機能を順次追加予定です。',
      },
      {
        q: '振込先の銀行口座を変更したい場合は？',
        a: '振込先口座の変更はLINEサポートへご連絡ください。事務局が対応します。\n\n⚠️ 重要：口座変更の前に、必ずアプリの「売上残高」を確認してください。「保留中」「振込可能」の金額が残っている場合、口座変更を行うと旧銀行口座へ振り込まれます。旧口座を閉鎖している場合は振込が失敗する可能性があります。残高が¥0になってから変更手続きを行うことを強く推奨します。\n\n【変更の流れ】\n① 売上残高が¥0であることを確認\n② LINEサポートに「口座変更希望」とメッセージ\n③ 事務局が現在の口座連携を解除（1〜2営業日以内）\n④ 解除後、マイページに「口座を登録する」バナーが表示されます\n⑤ バナーをタップして新しい銀行口座を登録',
      },
    ],
  },
  {
    id: 'store-receipt',
    title: '領収書・税務について',
    icon: <Receipt className="w-5 h-5" />,
    color: 'bg-purple-100 text-purple-600',
    items: [
      {
        q: '購入者への領収書は発行する必要がありますか？',
        a: 'いいえ、店舗側で個別に発行する必要はありません。\n\n購入者はアプリ内「マイページ → 購入履歴」から自分で電子領収書を発行できます。領収書にはご自身の店舗名・住所・電話番号が発行元として自動表示されます。紙での領収書発行やメール対応は一切不要です。',
      },
      {
        q: '消費税の扱いはどうなりますか？',
        a: '出品価格は税込価格として設定してください。アプリ上では税込の表示価格がそのまま決済されます。\n\n税務処理については、各店舗の会計担当者または税理士にご相談ください。売上の取引履歴はアプリ内「売上管理」から確認できます。',
      },
    ],
  },
  {
    id: 'store-fee',
    title: '手数料・コスト',
    icon: <BadgePercent className="w-5 h-5" />,
    color: 'bg-blue-100 text-blue-600',
    items: [
      {
        q: '月額や初期費用はかかりますか？',
        a: 'おすそわけの利用開始にあたって、月額費用や初期費用は一切かかりません。販売成立時のみ手数料が発生する、完全成果報酬型です。\n\n売れなかった場合のコストは¥0です。',
      },
      {
        q: '振込先情報の登録に費用はかかりますか？',
        a: '口座情報の登録・維持費用は無料です。\n\n決済処理手数料（お客様お支払い金額の3.6%／件）はプラットフォーム手数料（商品代金の20%）とは別に、自動的に差し引かれます。どちらも売れた時のみ発生し、固定費は一切かかりません。',
      },
      {
        q: 'アカウントを削除したい場合は？',
        a: 'アプリ内「マイページ」→「アカウント設定」→「アカウント削除（退会）」から手続きできます。出品中のバッグは事前に削除してから退会手続きをお願いします。削除後はデータを復元できませんのでご注意ください。',
      },
    ],
  },
];

/* ─────────────────────────────────────────────
   使い方ステップガイド データ
───────────────────────────────────────────── */
interface GuideStep {
  num: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  tips?: string[];
  accent: string; // tailwind gradient classes
}

const USER_GUIDE_STEPS: GuideStep[] = [
  {
    num: 1,
    icon: <MapPin className="w-6 h-6" />,
    title: '近くのお店を探す',
    desc: 'ホーム画面で現在地周辺のお店が地図とリストに自動表示されます。検索バーから地名・お店の名前でも探せます。',
    tips: [
      '位置情報を許可すると徒歩◯分が表示されます',
      'お気に入り登録で次回からすぐアクセス',
    ],
    accent: 'from-orange-400 to-amber-400',
  },
  {
    num: 2,
    icon: <ShoppingBag className="w-6 h-6" />,
    title: 'おすそわけバッグを選ぶ',
    desc: '気になるバッグをタップして、価格・受取時間・残り個数をチェック。「✨ 半額以上のお得」「🌅 朝の受取」などのおすすめセクションも便利です。',
    tips: [
      '受取時間に必ず行ける枠を選びましょう',
      '残り個数が少ない商品は早めに!',
    ],
    accent: 'from-pink-400 to-rose-400',
  },
  {
    num: 3,
    icon: <CreditCard className="w-6 h-6" />,
    title: 'カードでお会計',
    desc: 'クレジット/デビットカード(Visa/Master/Amex/JCB)で一瞬で決済。表示価格がそのままお支払い金額です(追加手数料なし)。',
    tips: [
      'カード情報はアプリに保存されません',
      '次回からはワンタップで購入可能',
    ],
    accent: 'from-blue-400 to-indigo-400',
  },
  {
    num: 4,
    icon: <QrCode className="w-6 h-6" />,
    title: '電子チケット(QR)を保存',
    desc: '購入完了と同時に専用の QR チケットが発行されます。「購入履歴」からいつでも表示可能。',
    tips: [
      'スクリーンショット保存でオフラインでも安心',
      '紛失しても何度でも再表示できます',
    ],
    accent: 'from-violet-400 to-purple-400',
  },
  {
    num: 5,
    icon: <Clock className="w-6 h-6" />,
    title: '受取時間にお店へ',
    desc: '指定の受取時間内にお店へ直接お越しください。時間枠に間に合わない時は早めにお店へ電話を。',
    tips: [
      '枠の前半に行くと商品の選択肢が多め',
      '深夜またぎ(例: 22:00〜翌1:00)も対応',
    ],
    accent: 'from-emerald-400 to-teal-400',
  },
  {
    num: 6,
    icon: <ScanLine className="w-6 h-6" />,
    title: 'QR をスタッフに提示',
    desc: 'スタッフが QR をスキャンするだけで受取完了。お会計や追加の手続きは一切ありません。',
    accent: 'from-cyan-400 to-sky-400',
  },
  {
    num: 7,
    icon: <PartyPopper className="w-6 h-6" />,
    title: 'お持ち帰りして実食!',
    desc: '惣菜・お弁当は当日中、パンや野菜は1〜2日以内が目安。冷蔵保存(10℃以下)で安心です。',
    tips: [
      '揚げ物・煮物は再加熱でより美味しく',
      '中身おまかせバッグはサプライズを楽しんで!',
    ],
    accent: 'from-yellow-400 to-orange-400',
  },
  {
    num: 8,
    icon: <Star className="w-6 h-6" />,
    title: 'レビュー・お気に入り',
    desc: 'お店ページからレビュー投稿で他のユーザーの参考に。ハートマークでお気に入り登録すれば次回からすぐアクセスできます。',
    tips: [
      'マイタウンが育つ! 街がにぎやかに🏘️',
      '月間ランキングにもチャレンジ',
    ],
    accent: 'from-fuchsia-400 to-pink-400',
  },
];

const STORE_GUIDE_STEPS: GuideStep[] = [
  {
    num: 1,
    icon: <FileCheck className="w-6 h-6" />,
    title: '店舗情報を登録',
    desc: '店舗名・住所・営業許可証の写真をアップロードして申請。完全無料で初期費用¥0です。',
    tips: [
      '営業許可証は鮮明に撮影を',
      '審査は通常 1〜3 営業日',
    ],
    accent: 'from-orange-400 to-amber-400',
  },
  {
    num: 2,
    icon: <CheckCircle2 className="w-6 h-6" />,
    title: '事務局の審査を待つ',
    desc: 'おすそわけ事務局が内容を確認します。承認結果はメールでお知らせします。',
    accent: 'from-amber-400 to-yellow-400',
  },
  {
    num: 3,
    icon: <Banknote className="w-6 h-6" />,
    title: '振込口座を登録',
    desc: 'ダッシュボードから売上振込先の銀行口座を登録。口座審査(1〜3営業日)が完了すると出品機能が解放されます。',
    tips: [
      '個人事業主/法人は登録時のみ選択可',
      '2店舗目以降は口座情報を自動引継ぎ',
    ],
    accent: 'from-green-400 to-emerald-400',
  },
  {
    num: 4,
    icon: <Camera className="w-6 h-6" />,
    title: '商品を出品',
    desc: '写真・タイトル・通常価格・割引価格・受取時間・残り個数を入力するだけ。ものの数分で完成します。',
    tips: [
      '通常価格の50〜70%オフが反応が高い',
      '明るい場所で俯瞰アングル撮影が◎',
      '受取時間は閉店30分〜1時間前が目安',
    ],
    accent: 'from-rose-400 to-pink-400',
  },
  {
    num: 5,
    icon: <Bell className="w-6 h-6" />,
    title: '予約通知を受け取る',
    desc: 'お客様が予約するとリアルタイムでプッシュ通知。在庫数も自動で減るので管理いらず。',
    tips: [
      'ダッシュボードで予約状況を一覧確認',
      '在庫の +/− はワンタップで調整可能',
    ],
    accent: 'from-blue-400 to-cyan-400',
  },
  {
    num: 6,
    icon: <ScanLine className="w-6 h-6" />,
    title: '来店客の QR をスキャン',
    desc: 'お客様の電子チケット(QR)をダッシュボードのスキャナーで読み取り、商品をお渡しするだけ。',
    tips: [
      '受取済みは自動でステータス更新',
      'ノーショー(無断キャンセル)も売上は確定済み',
    ],
    accent: 'from-indigo-400 to-violet-400',
  },
  {
    num: 7,
    icon: <Package className="w-6 h-6" />,
    title: '商品をお渡し',
    desc: 'お会計や追加手続きは一切不要。お客様にお礼を伝えて気持ちよくお見送りを。',
    accent: 'from-violet-400 to-purple-400',
  },
  {
    num: 8,
    icon: <TrendingUp className="w-6 h-6" />,
    title: '売上は自動で振込',
    desc: '決済確定から7日後に「振込可能」、毎月25日にまとめて登録口座へ自動振込。月額・初期費用¥0、売れた時のみ手数料が発生する完全成果報酬制です。',
    tips: [
      '売上残高はダッシュボードでリアルタイム確認',
      '通帳には「ストライプ ジャパン」と表示',
      '月別売上はエクスポート可能(LINE依頼)',
    ],
    accent: 'from-emerald-400 to-teal-400',
  },
];

/* ─────────────────── コンポーネント ─────────────────── */

function GuideStepCard({ step, isLast }: { step: GuideStep; isLast: boolean }) {
  return (
    <div className="flex gap-4">
      {/* 左カラム: アイコン + 接続線 (高さに合わせて伸縮) */}
      <div className="shrink-0 flex flex-col items-center">
        <div className="relative">
          <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${step.accent} text-white flex items-center justify-center shadow-lg shadow-black/10`} aria-hidden>
            {step.icon}
          </div>
          <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-white border-2 border-foreground/10 flex items-center justify-center text-[11px] font-black text-foreground shadow-sm" aria-label={`ステップ ${step.num}`}>
            {step.num}
          </div>
        </div>
        {!isLast && (
          <div className="flex-1 w-[2px] my-2 bg-gradient-to-b from-border via-border to-transparent min-h-[20px]" aria-hidden />
        )}
      </div>
      <div className="flex-1 min-w-0 pb-4 last:pb-0">
        <h3 className="font-black text-foreground text-base leading-tight pt-1">{step.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mt-1.5">{step.desc}</p>
        {step.tips && step.tips.length > 0 && (
          <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Lightbulb className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden />
              <span className="text-[11px] font-black text-amber-900 tracking-wide">コツ</span>
            </div>
            <ul className="space-y-1">
              {step.tips.map((t, i) => (
                <li key={i} className="text-[12px] text-amber-950 leading-snug flex gap-1.5">
                  <span className="text-amber-700 shrink-0" aria-hidden>•</span>
                  <span className="flex-1">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function GuideHero({ isStoreMode }: { isStoreMode: boolean }) {
  if (isStoreMode) {
    return (
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500 p-6 text-white shadow-xl shadow-orange-500/20">
        <div className="absolute -top-8 -right-8 w-32 h-32 bg-white/10 rounded-full blur-2xl" aria-hidden />
        <div className="absolute -bottom-12 -left-12 w-40 h-40 bg-white/10 rounded-full blur-3xl" aria-hidden />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 bg-white/20 backdrop-blur px-3 py-1 rounded-full text-[11px] font-black mb-3">
            <Store className="w-3.5 h-3.5" aria-hidden />
            店舗オーナー向け
          </div>
          <h2 className="text-2xl font-black leading-tight mb-2">8 ステップで<br/>始められます</h2>
          <p className="text-sm text-white/90 leading-relaxed">
            初期費用・月額費用は<span className="font-black">¥0</span>。<br/>
            売れた時だけ手数料をいただく完全成果報酬制。<br/>
            食品ロスを減らしながら、新しい売上を作りましょう。
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-pink-500 via-rose-500 to-orange-500 p-6 text-white shadow-xl shadow-pink-500/20">
      <div className="absolute -top-8 -right-8 w-32 h-32 bg-white/10 rounded-full blur-2xl" aria-hidden />
      <div className="absolute -bottom-12 -left-12 w-40 h-40 bg-white/10 rounded-full blur-3xl" aria-hidden />
      <div className="relative">
        <div className="inline-flex items-center gap-1.5 bg-white/20 backdrop-blur px-3 py-1 rounded-full text-[11px] font-black mb-3">
          <Sparkles className="w-3.5 h-3.5" aria-hidden />
          ユーザー向け
        </div>
        <h2 className="text-2xl font-black leading-tight mb-2">8 ステップで<br/>お得におすそわけ</h2>
        <p className="text-sm text-white/90 leading-relaxed">
          まだ美味しい食品を<span className="font-black">最大70%オフ</span>でおすそわけ。<br/>
          地球にやさしくて、お財布にもうれしい。<br/>
          初めての方もこのガイドだけで OK!
        </p>
      </div>
    </div>
  );
}

function GuideFooterCTA({ isStoreMode }: { isStoreMode: boolean }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-3">
      {isStoreMode ? (
        <>
          <Link href="/store-onboarding" className="rounded-2xl bg-primary text-primary-foreground p-4 text-center shadow-md tap-opacity">
            <Store className="w-5 h-5 mx-auto mb-1.5" />
            <p className="text-xs font-black">店舗を登録する</p>
          </Link>
          <Link href="/store-dashboard" className="rounded-2xl bg-card border border-border p-4 text-center tap-opacity">
            <Package className="w-5 h-5 mx-auto mb-1.5 text-foreground" />
            <p className="text-xs font-black text-foreground">ダッシュボードへ</p>
          </Link>
        </>
      ) : (
        <>
          <Link href="/" className="rounded-2xl bg-primary text-primary-foreground p-4 text-center shadow-md tap-opacity">
            <Search className="w-5 h-5 mx-auto mb-1.5" />
            <p className="text-xs font-black">お店を探す</p>
          </Link>
          <Link href="/orders" className="rounded-2xl bg-card border border-border p-4 text-center tap-opacity">
            <Receipt className="w-5 h-5 mx-auto mb-1.5 text-foreground" />
            <p className="text-xs font-black text-foreground">購入履歴を見る</p>
          </Link>
        </>
      )}
    </div>
  );
}

function FaqAccordion({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  const panelId = React.useId();
  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-start gap-3 py-4 px-4 text-left tap-opacity"
      >
        <span className="mt-0.5 text-primary font-black text-xs shrink-0 bg-primary/10 rounded px-1.5 py-0.5 leading-5" aria-hidden>Q</span>
        <span className="flex-1 text-sm font-semibold text-foreground leading-snug">{item.q}</span>
        {open
          ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden />
          : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 flex gap-3">
              <span className="mt-0.5 text-blue-600 font-black text-xs shrink-0 bg-blue-50 dark:bg-blue-950 rounded px-1.5 py-0.5 leading-5">A</span>
              <div className="text-sm text-muted-foreground leading-relaxed flex-1 space-y-1.5">
                {item.a.split('\n\n').map((para, pi) => (
                  <p key={pi}>{para}</p>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FaqSectionBlock({ section }: { section: FaqSection }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border/60">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${section.color}`}>
          {section.icon}
        </div>
        <h2 className="font-black text-sm text-foreground">{section.title}</h2>
      </div>
      {section.items.map((item, i) => (
        <FaqAccordion key={i} item={item} />
      ))}
    </div>
  );
}

export default function HelpPage() {
  const { profile } = useAuth();

  // URL パラメータ
  const params = new URLSearchParams(window.location.search);
  const urlMode = params.get('mode');

  // ロール固定判定: 店舗オーナー (or ?mode=store) は店舗向けのみ、 それ以外はユーザー向けのみ
  const isStoreMode = urlMode === 'store' || profile?.role === 'store_owner';

  const faqSections = isStoreMode ? STORE_FAQ_SECTIONS : USER_FAQ_SECTIONS;

  return (
    <Layout showBottomNav>
      <div className="w-full max-w-md md:max-w-2xl mx-auto px-4 pt-4 pb-28">

        {/* 戻るボタン */}
        <button
          onClick={() => window.history.back()}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1 tap-opacity"
          aria-label="前の画面に戻る"
        >
          <ChevronLeft className="w-5 h-5" />
          <span>戻る</span>
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
            <HelpCircle className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-black text-foreground">ヘルプ・お問い合わせ</h1>
            <p className="text-xs text-muted-foreground mt-0.5">よくある質問とサポート窓口</p>
          </div>
        </div>

        {/* ロール表示バッジ (固定: 切替不可) */}
        <div className="flex items-center gap-2 mb-5">
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-black ${
            isStoreMode
              ? 'bg-primary/10 text-primary'
              : 'bg-sky-100 text-sky-700'
          }`}>
            {isStoreMode ? '🏪 店舗オーナー向け' : '👤 ユーザー向け'}
          </div>
        </div>

        {/* メインコンテンツ (FAQ のみ) */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={isStoreMode ? 'store' : 'user'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            <div className="space-y-4">
              {isStoreMode && (
                <div className="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200 rounded-2xl p-4 flex items-start gap-3">
                  <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center shrink-0 mt-0.5">
                    <Store className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-black text-sm text-foreground">飲食店・食料品店の方へ</p>
                    <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                      月額・初期費用は¥0。売れた時だけ20%の手数料をいただく完全成果報酬制です。売上確認もアプリ内で完結します。
                    </p>
                  </div>
                </div>
              )}
              {faqSections.map(s => <FaqSectionBlock key={s.id} section={s} />)}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* LINE Support */}
        <div className="mt-8 bg-gradient-to-br from-[#06C755]/10 to-[#06C755]/5 border-2 border-[#06C755]/30 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-[#06C755] rounded-xl flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-black text-foreground text-sm">解決しない場合はこちら</p>
              <p className="text-xs text-muted-foreground mt-0.5">LINEで直接サポートします</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            FAQで解決しないご不明点・トラブルは、LINE公式アカウントにお気軽にメッセージをどうぞ。
            営業時間内（平日10:00〜18:00）にできるだけ早くご返信します。
          </p>
          <a
            href="https://lin.ee/x3IQZkL"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2.5 w-full bg-[#06C755] hover:bg-[#05b34c] active:scale-[0.98] transition-all text-white font-black py-4 rounded-xl shadow-md shadow-[#06C755]/25"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white shrink-0" xmlns="http://www.w3.org/2000/svg">
              <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.105.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
            </svg>
            LINEでサポートに問い合わせる
          </a>
        </div>

        {/* Legal Links */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Link href="/legal" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
            特定商取引法に基づく表記
          </Link>
          <span className="text-muted-foreground/40 text-xs">|</span>
          <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
            利用規約
          </Link>
          <span className="text-muted-foreground/40 text-xs">|</span>
          <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
            プライバシーポリシー
          </Link>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/50 mt-3">© 2025 おすそわけ All rights reserved.</p>

      </div>
    </Layout>
  );
}
