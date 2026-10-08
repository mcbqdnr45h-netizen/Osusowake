import React from 'react';
import { Layout } from '@/components/Layout';
import { Link } from 'wouter';
import { ChevronLeft } from 'lucide-react';

export default function Privacy() {
  return (
    <Layout>
      <div className="w-full max-w-2xl mx-auto px-5 py-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors mb-6"
        >
          <ChevronLeft className="w-4 h-4" />
          トップへ戻る
        </Link>

        <PrivacyBody />
      </div>
    </Layout>
  );
}

export function PrivacyBody() {
  return (
        <article>
          <h1 className="text-2xl font-black text-foreground mb-1">プライバシーポリシー</h1>
          <p className="text-xs text-muted-foreground mb-8">最終更新日：2026年3月26日</p>

          <p className="text-sm text-muted-foreground leading-relaxed mb-8">
            おすそわけ 事務局（以下「当社」）は、本サービス「おすそわけ」を通じて取得する個人情報の取扱いについて、以下のとおりプライバシーポリシー（以下「本ポリシー」）を定めます。
          </p>

          <Section title="1. 収集する情報">
            <p>当社は以下の情報を収集することがあります。</p>
            <ul>
              <li><strong>利用者情報：</strong>デバイス識別子（UUID）、位置情報（GPS）、予約履歴</li>
              <li><strong>出品者情報：</strong>店舗名、住所、電話番号、店舗画像、営業時間</li>
              <li><strong>決済情報：</strong>クレジットカード情報（Stripe社が管理。当社サーバーには保存しません）</li>
              <li><strong>アクセスログ：</strong>IPアドレス、ブラウザ種別、アクセス日時</li>
            </ul>
          </Section>

          <Section title="2. 情報の利用目的">
            <p>収集した情報は以下の目的にのみ使用します。</p>
            <ul>
              <li>本サービスの提供・運営・改善</li>
              <li>予約・決済処理の実施</li>
              <li>利用者へのサービス通知・お問い合わせ対応</li>
              <li>不正利用の検知・防止</li>
              <li>統計データの作成（個人を特定できない形式）</li>
            </ul>
          </Section>

          <Section title="3. 第三者への提供">
            <p>当社は、以下の場合を除き、利用者の個人情報を第三者に提供しません。</p>
            <ul>
              <li>利用者本人の同意がある場合</li>
              <li>法令に基づく場合（裁判所・警察等からの要請）</li>
              <li>決済処理のためにStripe社へ提供する場合（Stripeのプライバシーポリシーに従います）</li>
              <li>地図表示のためにOpenStreetMap・Nominatimを利用する場合</li>
            </ul>
          </Section>

          <Section title="4. 外国にある第三者への提供">
            <p>当社は、以下の外国にある第三者へ個人情報を提供することがあります。利用者はこの点についてあらかじめ同意するものとします。</p>
            <ul>
              <li>
                <strong>Stripe, Inc.（米国）：</strong>クレジットカード決済の処理を目的として、決済に必要な情報を提供します。Stripe社は米国をはじめとする複数の国にサーバーを保有しており、情報が国外で処理される場合があります。詳細は
                <a href="https://stripe.com/jp/privacy" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 mx-1">Stripe プライバシーポリシー</a>
                をご参照ください。
              </li>
              <li>
                <strong>OpenStreetMap Foundation（英国）・Nominatim（欧州）：</strong>地図表示および住所の座標変換（ジオコーディング）を目的として、住所情報等を送信することがあります。送信された情報は各サービスのプライバシーポリシーに従って取り扱われます。
              </li>
            </ul>
            <p>これらの外国における個人情報の保護水準は日本と異なる場合がありますが、当社は各事業者が適切な保護措置を講じていることを確認の上、情報提供を行います。</p>
          </Section>

          <Section title="5. 位置情報について">
            <p>本サービスは、近くの店舗を表示するために位置情報（GPS）を使用します。位置情報の取得はお客様の許可を得た場合のみ行い、サービス提供の目的以外には使用しません。位置情報はサーバーに保存されません。</p>
          </Section>

          <Section title="6. Cookieおよびローカルストレージ">
            <p>本サービスはCookieおよびブラウザのローカルストレージを使用して、利用者の設定（お気に入り店舗、ユーザーID等）を保存します。これらはサービスの利便性向上のために使用され、広告目的には使用しません。</p>
          </Section>

          <Section title="7. データの保管・セキュリティ">
            <p>当社は収集した個人情報を適切なセキュリティ対策のもと管理します。ただし、インターネットによるデータ送受信の完全な安全性を保証することはできません。万が一、情報漏洩等のセキュリティインシデントが発生した場合は、速やかに利用者へ通知します。</p>
          </Section>

          <Section title="8. 個人情報の保存期間と廃棄">
            <p>当社は収集した個人情報を、利用目的の達成に必要な期間のみ保存します。具体的な保存期間の目安は以下のとおりです。</p>
            <ul>
              <li><strong>予約・取引履歴：</strong>取引完了日から5年間（法令上の保存義務に準拠）</li>
              <li><strong>アクセスログ：</strong>取得日から最長6ヶ月間</li>
              <li><strong>出品者登録情報：</strong>サービス退会または契約終了後、1年間</li>
              <li><strong>お問い合わせ内容：</strong>対応完了から2年間</li>
            </ul>
            <p>保存期間が経過した個人情報は、復元できない方法で速やかに廃棄または匿名化処理を行います。ただし、法令により保存が義務付けられている情報については、当該法令の定める期間にわたり保存します。</p>
            <p>
              <strong>アカウントおよび個人情報の削除について：</strong>ご自身のアカウント（個人情報）の削除を希望される場合は、アプリ内の「マイページ」→「アカウント設定」メニューから、いつでもご自身で退会手続き（アカウントおよび関連する個人情報の削除）を完結させることができます。法令上の保存義務がある情報（取引履歴等）を除き、退会と同時にご登録情報を削除いたします。お問い合わせフォームまたは下記メールアドレスへのご連絡でも対応いたします。
            </p>
          </Section>

          <Section title="9. 個人情報の開示・修正・削除">
            <p>利用者は自身の個人情報の開示・修正・削除を請求する権利を有します。</p>
            <p>
              <strong>アプリ内での削除：</strong>アカウントの退会（個人情報の削除）は、アプリ内の「マイページ」→「アカウント設定」から、いつでもご自身で手続きを完結させることができます。外部への連絡や手続き等は不要です。
            </p>
            <p>開示・修正のご要望、またはその他の個人情報に関するご請求は、アプリ内お問い合わせフォームまたは下記メールアドレスへご連絡ください。合理的な期間内に対応いたします。</p>
          </Section>

          <Section title="10. 未成年者のプライバシー">
            <p>本サービスは13歳未満の方のご利用を想定しておりません。13歳未満の方の個人情報と認識した場合は、速やかに削除いたします。</p>
          </Section>

          <Section title="11. プライバシーポリシーの変更">
            <p>当社は必要に応じて本ポリシーを変更することがあります。重要な変更がある場合は、サービス上でお知らせします。変更後も本サービスを継続利用した場合は、変更後のポリシーに同意したものとみなします。</p>
          </Section>

          <Section title="12. お問い合わせ">
            <p>本ポリシーに関するご質問・ご要望、または個人情報の開示・修正・削除のご請求は、以下のいずれかの方法にてご連絡ください。</p>
            <ul>
              <li>
                <strong>アプリ内での退会（アカウント削除）：</strong>「マイページ」→「アカウント設定」からいつでも手続きが完結できます
              </li>
              <li>
                <strong>メールアドレス：</strong>
                <a href="mailto:hello@osusowakejapan.org" className="text-primary underline underline-offset-2 ml-1">
                  hello@osusowakejapan.org
                </a>
              </li>
              <li>
                <strong>お問い合わせフォーム：</strong>
                <a href="https://forms.gle/uhMoXjjF9YzkR52a6" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 ml-1">
                  フォームはこちら
                </a>
              </li>
            </ul>
            <p className="text-muted-foreground text-xs mt-2">おすそわけ 事務局</p>
          </Section>

          <div className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground text-center">
            <p>おすそわけ 事務局</p>
          </div>
        </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-black text-foreground mb-3 pb-2 border-b border-border">{title}</h2>
      <div className="text-sm text-foreground/80 leading-relaxed space-y-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_strong]:font-bold [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}
