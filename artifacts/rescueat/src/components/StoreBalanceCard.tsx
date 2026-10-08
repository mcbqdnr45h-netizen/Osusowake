import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, AlertCircle, Clock, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { authedFetch } from '@/lib/authed-fetch';
import { isNonBusinessDayYMD, shiftYMDToBusinessDay, formatYmdWithWeekday } from '@/lib/jp-business-days';

type Props = {
  storeId: number;
  stripeAccountId: string | null | undefined;
  /**
   * true の場合、 表示残高は同一 Stripe アカウントを共有する複数の承認済み店舗の
   * 合算であることを UI 上で明示する (ラベル + 注意書き)。
   */
  aggregated?: boolean;
};

// 振込予定日の土日・祝日補正は @/lib/jp-business-days に集約。
// バックエンド (stores.ts の nextPayoutDate) は anchor日を素直に返すため、
// 25日が土日祝にあたる月は「25日表示 → 実際は翌営業日着金」のズレが出る。
// そこを銀行営業日（＝Stripe payout 着金日: 土日・国民の祝日・振替休日・
// 国民の休日・年末年始を除く）に繰り下げて表示し、注意書きを出す。

function translateStripeRequirement(key: string): string {
  const map: Record<string, string> = {
    'individual.verification.document': '本人確認書類（運転免許証・マイナンバーカード等）',
    'individual.verification.additional_document': '追加書類（営業許可証等）',
    'individual.first_name_kana': '氏名（カナ・名）',
    'individual.last_name_kana': '氏名（カナ・姓）',
    'individual.first_name_kanji': '氏名（漢字・名）',
    'individual.last_name_kanji': '氏名（漢字・姓）',
    'individual.dob.day': '生年月日（日）',
    'individual.dob.month': '生年月日（月）',
    'individual.dob.year': '生年月日（年）',
    'individual.address_kanji.line1': '住所（漢字・番地）',
    'individual.address_kanji.city': '住所（漢字・市区町村）',
    'individual.address_kanji.state': '住所（漢字・都道府県）',
    'individual.address_kanji.postal_code': '郵便番号',
    'individual.address_kana.line1': '住所（カナ・番地）',
    'individual.address_kana.city': '住所（カナ・市区町村）',
    'individual.address_kana.state': '住所（カナ・都道府県）',
    'individual.phone': '電話番号',
    'individual.email': 'メールアドレス',
    'individual.id_number': 'マイナンバー',
    'external_account': '銀行口座情報',
    'tos_acceptance.date': '利用規約への同意',
    'tos_acceptance.ip': '利用規約への同意（IP）',
    'business_profile.mcc': '業種コード',
    'business_profile.url': 'ウェブサイトURL',
    'company.name': '法人名',
    'company.tax_id': '法人番号',
  };
  return map[key] ?? key;
}

function translateStripeDisabledReason(reason: string | null): string {
  if (!reason) return '';
  const map: Record<string, string> = {
    'requirements.past_due': '提出期限超過（必要書類の提出が遅延しています）',
    'requirements.pending_verification': '書類審査中',
    'listed': '制限対象リストに登録されています',
    'under_review': 'Stripeによる審査中',
    'other': 'その他の理由',
    'action_required.requested_capabilities': '必要な機能の申請が必要です',
  };
  return map[reason] ?? reason;
}

function translateStripeErrorCode(code: string): string {
  const map: Record<string, string> = {
    'verification_document_dob_mismatch': '書類の生年月日が登録情報と一致しません',
    'verification_document_name_mismatch': '書類の氏名が登録情報と一致しません',
    'verification_document_address_mismatch': '書類の住所が登録情報と一致しません',
    'verification_document_id_number_mismatch': '書類の番号が登録情報と一致しません',
    'verification_document_expired': '書類の有効期限が切れています',
    'verification_document_not_readable': '書類が読み取れません（再撮影してください）',
    'verification_document_not_uploaded': '書類がアップロードされていません',
    'verification_document_photo_mismatch': '書類の写真が一致しません',
    'verification_document_type_not_supported': 'この書類の種類は対応していません',
    'verification_document_corrupt': '書類ファイルが破損しています',
    'verification_failed_keyed_identity': '本人確認情報の照合に失敗しました',
    'verification_failed_name_match': '氏名の照合に失敗しました',
    'invalid_address_city_state_postal_code': '住所の市区町村・都道府県・郵便番号が無効です',
    'invalid_dob_age_under_18': '代表者が18歳未満のため登録できません',
    'invalid_phone_number': '電話番号が無効です',
    'bank_account_unusable': '銀行口座が使用できません',
    'bank_account_unverified': '銀行口座の確認が取れていません',
  };
  return map[code] ?? code;
}

export function StoreBalanceCard({ storeId, stripeAccountId, aggregated = false }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncingStripe, setSyncingStripe] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);

  const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
               (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

  const { data: balanceData, isLoading: balanceLoading } = useQuery({
    queryKey: [`/api/stores/${storeId}/connect/balance`],
    queryFn: async () => {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/connect/balance`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!storeId && !!stripeAccountId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: stripeStatus, isLoading: stripeStatusLoading } = useQuery<{
    connected: boolean;
    accountId?: string;
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirements?: {
      currentlyDue: string[];
      eventuallyDue: string[];
      errors: { code: string; reason: string; requirement: string }[];
      pendingVerification: string[];
      disabledReason: string | null;
    };
  } | null>({
    queryKey: [`/api/stores/${storeId}/connect/status`],
    queryFn: async () => {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/connect/status`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!storeId && !!stripeAccountId,
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  async function syncStripeStatus() {
    setSyncingStripe(true);
    try {
      const res = await authedFetch(`${BASE}/api/stores/${storeId}/stripe-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({} as any));
      if (res.ok) {
        if (data.stripeError) {
          setStripeError(data.stripeError);
          toast({ title: '⚠️ 決済連携エラーを検出しました', description: `エラーコード: ${data.stripeError}`, variant: 'destructive' });
        } else {
          setStripeError(null);
          toast({
            title: '✅ 決済情報を更新しました',
            description: `決済: ${data.chargesEnabled ? '有効' : '制限中'} / 入金: ${data.payoutsEnabled ? '有効' : '停止中'}`,
          });
          queryClient.invalidateQueries({ queryKey: [`/api/stores/${storeId}/connect/balance`] });
          queryClient.invalidateQueries({ queryKey: [`/api/stores/${storeId}/connect/status`] });
        }
      } else {
        const msg = data?.message || data?.error || `HTTP ${res.status}`;
        toast({ title: '再同期に失敗しました', description: String(msg), variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: '通信エラー', description: String(err?.message ?? err), variant: 'destructive' });
    } finally {
      setSyncingStripe(false);
    }
  }

  if (!stripeAccountId) return null;

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 shadow-[0_2px_12px_rgba(255,140,0,0.06)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-orange-50 rounded-lg flex items-center justify-center">
            <CreditCard className="w-4 h-4 text-primary" />
          </div>
          <p className="text-sm font-black text-foreground">
            売上残高{aggregated && <span className="ml-1 text-[10px] font-bold text-orange-600">（全店舗合算）</span>}
          </p>
        </div>
        {(balanceLoading || stripeStatusLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
      </div>
      {aggregated && (
        <div className="mb-3 bg-orange-50/60 border border-orange-100 rounded-xl px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
          <p className="text-[11px] text-orange-700 leading-relaxed">
            複数の店舗を運営しているため、 表示中の残高は <span className="font-bold">全店舗の売上を合算</span> した金額です。 振込先は登録口座 1つに統合されます。
          </p>
        </div>
      )}

      {stripeStatus?.requirements && (
        <div className="mb-3 rounded-xl border border-border/60 bg-secondary/20 p-3 space-y-1.5">
          <p className="text-[9px] font-black text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <span>📡</span> 決済 最新ステータス（ライブ）
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${stripeStatus.chargesEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
              決済: {stripeStatus.chargesEnabled ? '✅ 有効' : '❌ 制限中'}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${stripeStatus.payoutsEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              入金: {stripeStatus.payoutsEnabled ? '✅ 有効' : '⚠️ 停止中'}
            </span>
          </div>

          {stripeStatus.requirements.disabledReason && (
            <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
              <AlertCircle className="w-3 h-3 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] font-black text-red-700">アカウント停止理由</p>
                <p className="text-[10px] text-red-600">{translateStripeDisabledReason(stripeStatus.requirements.disabledReason)}</p>
              </div>
            </div>
          )}

          {stripeStatus.requirements.currentlyDue.length > 0 ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
              <p className="text-[10px] font-black text-amber-800 mb-1">⚠️ 提出が必要な書類 ({stripeStatus.requirements.currentlyDue.length}件)</p>
              {stripeStatus.requirements.currentlyDue.map((item, i) => (
                <p key={i} className="text-[10px] text-amber-700 leading-relaxed">・{translateStripeRequirement(item)}</p>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-emerald-700 font-bold">✅ 必要書類はすべて提出済みです</p>
          )}

          {stripeStatus.requirements.errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
              <p className="text-[10px] font-black text-red-800 mb-1">🚫 エラー ({stripeStatus.requirements.errors.length}件)</p>
              {stripeStatus.requirements.errors.map((e, i) => (
                <div key={i} className="mt-1">
                  <p className="text-[10px] text-red-700 font-black">・{translateStripeRequirement(e.requirement)}</p>
                  <p className="text-[10px] text-red-600 ml-2">{translateStripeErrorCode(e.code)}</p>
                </div>
              ))}
            </div>
          )}

          {stripeStatus.requirements.pendingVerification.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-2">
              <p className="text-[10px] font-black text-blue-800 mb-1">🔄 審査中（Stripeが確認中）</p>
              {stripeStatus.requirements.pendingVerification.map((item, i) => (
                <p key={i} className="text-[10px] text-blue-700 leading-relaxed">・{translateStripeRequirement(item)}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {balanceData && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-center">
              <p className="text-xs font-bold text-amber-600 mb-0.5">保留中</p>
              <p className="text-xl font-black text-amber-800">¥{balanceData.pending.toLocaleString()}</p>
            </div>
            <div className="bg-green-50 border border-green-100 rounded-xl p-3 text-center">
              <p className="text-xs font-bold text-green-600 mb-0.5">振込可能</p>
              <p className="text-xl font-black text-green-800">¥{balanceData.available.toLocaleString()}</p>
            </div>
          </div>

          {balanceData.pending > 0 && (
            <div className="bg-amber-50/60 border border-amber-100 rounded-xl px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs text-amber-700 font-bold">保留中とは？</p>
                <p className="text-[11px] text-amber-600 leading-relaxed mt-0.5">
                  決済から{balanceData.delayDays ?? 7}日後に「振込可能」へ移動します。振込可能になった残高は、毎月25日にまとめて銀行口座へ振込されます。
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground pt-0.5">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {balanceData.payoutSchedule?.interval === 'weekly'
                ? '週次振込（毎週月曜）'
                : balanceData.payoutSchedule?.interval === 'monthly'
                  ? `月次振込（毎月${balanceData.payoutSchedule?.monthly_anchor ?? 25}日）`
                  : '自動振込'}
            </span>
            {balanceData.nextPayoutDate && (
              <span className="font-bold text-foreground/70">
                次回: {shiftYMDToBusinessDay(balanceData.nextPayoutDate).replace(/-/g, '/')}
              </span>
            )}
          </div>
          {balanceData.nextPayoutDate && isNonBusinessDayYMD(balanceData.nextPayoutDate) && (
            <div className="bg-amber-50/70 border border-amber-100 rounded-xl px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                {/* ★ 月次/週次いずれも安全に表現するため、
                     anchor 日を明示せず「振込予定日」で統一する
                     (weekly でも同じ動作、legacy 別 anchor でも正しく表示) */}
                <p className="text-xs text-amber-700 font-bold">
                  振込予定日{formatYmdWithWeekday(balanceData.nextPayoutDate)}が土日・祝日のため、翌営業日{formatYmdWithWeekday(shiftYMDToBusinessDay(balanceData.nextPayoutDate))}に着金予定
                </p>
                <p className="text-[11px] text-amber-600 leading-relaxed mt-0.5">
                  決済システムの都合上、土日祝・年末年始の振込は翌営業日に自動で繰り下がります。ご了承ください。
                </p>
              </div>
            </div>
          )}

          {(() => {
            const payouts = (balanceData.recentPayouts ?? []) as Array<{ id: string; amount: number; arrivalDate: string; status: string }>;
            const transfers = (balanceData.platformTransfers ?? []) as Array<{ id: string; amount: number; createdDate: string; available_on: string | null }>;
            const hasActivePayouts = payouts.some(p => p.status === 'in_transit' || p.status === 'pending' || p.status === 'paid');

            return (
              <div className="border-t border-border/40 pt-2 mt-1 space-y-2">
                {payouts.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide">銀行振込履歴</p>
                    {payouts.map(p => (
                      <div key={p.id} className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-[11px] text-muted-foreground">{p.arrivalDate.replace(/-/g, '/')} 銀行着金予定</span>
                          {p.status === 'in_transit' && (
                            <span className="ml-1.5 text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">送金中</span>
                          )}
                          {p.status === 'paid' && (
                            <span className="ml-1.5 text-[10px] font-bold bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">着金済</span>
                          )}
                          {p.status === 'pending' && (
                            <span className="ml-1.5 text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">処理中</span>
                          )}
                          {p.status === 'failed' && (
                            <span className="ml-1.5 text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">失敗</span>
                          )}
                        </div>
                        <span className={`text-[11px] font-bold shrink-0 ${p.status === 'paid' ? 'text-green-700' : p.status === 'failed' ? 'text-red-600' : 'text-amber-700'}`}>
                          ¥{p.amount.toLocaleString()}
                        </span>
                      </div>
                    ))}

                    {payouts.some(p => p.status === 'in_transit') && (
                      <p className="text-[11px] text-amber-700 bg-amber-50 rounded-xl px-3 py-2">
                        🏦 現在銀行口座へ送金中です。着金予定日の翌営業日までにご確認ください。
                      </p>
                    )}
                    {payouts.every(p => p.status === 'paid') && balanceData.pending === 0 && balanceData.available === 0 && (
                      <p className="text-[11px] text-muted-foreground bg-secondary/40 rounded-xl px-3 py-2">
                        💳 振込が完了しています。銀行口座の入金をご確認ください。
                      </p>
                    )}
                  </div>
                )}

                {!hasActivePayouts && transfers.length > 0 && balanceData.pending === 0 && balanceData.available === 0 && (
                  <p className="text-[11px] text-muted-foreground bg-secondary/40 rounded-xl px-3 py-2">
                    ⏳ 売上は確認できています。振込可能日（保留期間終了後）以降、最初に到来する毎月25日に銀行口座へ振り込まれます。
                  </p>
                )}

                {!hasActivePayouts && transfers.length === 0 && balanceData.pending === 0 && balanceData.available === 0 && (
                  <p className="text-[11px] text-muted-foreground bg-secondary/40 rounded-xl px-3 py-2">
                    売上があるのに残高が¥0の場合は、LINEサポートへご連絡ください。
                  </p>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {!balanceData && !balanceLoading && (
        <p className="text-xs text-muted-foreground text-center py-2">残高情報を取得できませんでした</p>
      )}

      {stripeError && (
        <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-black text-red-700">🔴 決済連携エラー</p>
            <p className="text-[11px] text-red-600 mt-0.5">エラーコード: {stripeError}</p>
            <p className="text-[11px] text-red-500 mt-0.5">サポートまでお問い合わせください: hello@osusowakejapan.org</p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={syncStripeStatus}
        disabled={syncingStripe}
        className="mt-3 w-full flex items-center justify-center gap-1.5 bg-orange-50 hover:bg-orange-100 text-primary font-bold text-xs py-2 rounded-xl transition-colors border border-orange-200 disabled:opacity-50"
      >
        {syncingStripe
          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />同期中…</>
          : <><RefreshCw className="w-3.5 h-3.5" />決済情報を最新に更新する</>
        }
      </button>
    </div>
  );
}
