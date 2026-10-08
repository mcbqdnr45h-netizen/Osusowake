import React, { useState, useCallback } from 'react';
import { Layout } from '@/components/Layout';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, CreditCard, Trash2, CheckCircle2,
  ShieldCheck, Lock, Wifi, Star, RefreshCw, Info,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

const BRAND_META: Record<string, { label: string; color: string; textColor: string }> = {
  visa:       { label: 'Visa',       color: 'from-blue-700 to-blue-900',   textColor: 'text-blue-100'   },
  mastercard: { label: 'Mastercard', color: 'from-orange-600 to-red-700',  textColor: 'text-orange-100' },
  amex:       { label: 'Amex',       color: 'from-sky-500 to-sky-700',     textColor: 'text-sky-100'    },
  jcb:        { label: 'JCB',        color: 'from-green-600 to-green-800', textColor: 'text-green-100'  },
  discover:   { label: 'Discover',   color: 'from-orange-400 to-orange-600', textColor: 'text-orange-100' },
  unionpay:   { label: 'UnionPay',   color: 'from-red-600 to-red-800',     textColor: 'text-red-100'    },
};

function getBrandMeta(brand: string) {
  return BRAND_META[brand] ?? { label: brand.toUpperCase(), color: 'from-slate-600 to-slate-800', textColor: 'text-slate-100' };
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function CreditCardWidget({ card, onDelete, deleting }: {
  card: SavedCard;
  onDelete: () => void;
  deleting: boolean;
}) {
  const meta = getBrandMeta(card.brand);
  const expYearFull = card.expYear > 100 ? card.expYear : 2000 + card.expYear;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      className="relative"
    >
      <div className={`bg-gradient-to-br ${meta.color} rounded-2xl p-5 shadow-lg relative overflow-hidden`}>
        <div className="absolute -top-6 -right-6 w-28 h-28 bg-white/5 rounded-full" />
        <div className="absolute -bottom-8 -left-6 w-36 h-36 bg-white/5 rounded-full" />
        <Wifi className="absolute top-4 right-4 w-5 h-5 text-white/60 rotate-90" />

        <div className="flex items-start justify-between mb-6">
          <span className={`text-xs font-black tracking-widest uppercase ${meta.textColor}`}>{meta.label}</span>
          {card.isDefault && (
            <span className="flex items-center gap-1 bg-white/20 text-white text-[10px] font-black px-2 py-0.5 rounded-full">
              <Star className="w-2.5 h-2.5 fill-white" /> メイン
            </span>
          )}
        </div>

        <p className="text-white/40 text-sm tracking-[0.3em] mb-4 font-mono">
          **** **** **** {card.last4}
        </p>

        <div className="flex justify-between items-end">
          <div>
            <p className="text-white/50 text-[10px] uppercase tracking-widest mb-0.5">Stripe Saved</p>
            <p className="text-white font-bold text-sm tracking-wider">安全に保存済み</p>
          </div>
          <div className="text-right">
            <p className="text-white/50 text-[10px] uppercase tracking-widest mb-0.5">Expires</p>
            <p className="text-white font-bold text-sm">{String(card.expMonth).padStart(2,'0')}/{String(expYearFull).slice(-2)}</p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        {card.isDefault ? (
          <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-primary/10 text-primary text-sm font-bold">
            <CheckCircle2 className="w-3.5 h-3.5" />
            次回の支払いで自動使用
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-secondary/70 text-muted-foreground text-sm font-medium">
            保存済みカード
          </div>
        )}
        <button
          onClick={onDelete}
          disabled={deleting}
          className="w-11 h-11 flex items-center justify-center rounded-xl border border-destructive/30 text-destructive hover:bg-destructive/5 transition-colors shrink-0 disabled:opacity-50"
        >
          {deleting
            ? <div className="w-4 h-4 border-2 border-destructive/40 border-t-destructive rounded-full animate-spin" />
            : <Trash2 className="w-4 h-4" />}
        </button>
      </div>
    </motion.div>
  );
}

export default function PaymentMethods() {
  const { session } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const token = session?.access_token;

  // ── React Query でキャッシュ first 表示。 2 回目以降は即時 ──
  const cardsQuery = useQuery<SavedCard[]>({
    queryKey: ['payment-methods', token ? 'authed' : 'guest'],
    queryFn: async () => {
      if (!token) return [];
      const res = await fetch(`${BASE}/api/payment/methods`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.methods ?? [];
    },
    enabled: !!token,
    staleTime: 60_000,
  });
  const cards = cardsQuery.data ?? [];
  const loading = cardsQuery.isLoading;
  const fetchCards = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
  }, [queryClient]);
  const setCards = useCallback((updater: (prev: SavedCard[]) => SavedCard[]) => {
    queryClient.setQueryData<SavedCard[]>(
      ['payment-methods', token ? 'authed' : 'guest'],
      (prev) => updater(prev ?? []),
    );
  }, [queryClient, token]);

  async function handleDelete(methodId: string) {
    if (!session?.access_token) return;
    setDeletingId(methodId);
    try {
      const res = await fetch(`${BASE}/api/payment/methods/${methodId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setCards(prev => prev.filter(c => c.id !== methodId));
        toast({ title: 'カードを削除しました' });
      } else {
        toast({ title: '削除に失敗しました', variant: 'destructive' });
      }
    } catch {
      toast({ title: '削除に失敗しました', variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Layout showBottomNav={false}>
      <div className="w-full max-w-md md:max-w-2xl mx-auto pb-16">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-4 sticky bg-background/90 backdrop-blur-sm z-10 border-b border-border/50"
          style={{ top: 'calc(4rem + env(safe-area-inset-top))' }}>
          <button
            onClick={() => navigate('/mypage')}
            className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-black text-foreground leading-tight">支払い管理</h1>
            <p className="text-xs text-muted-foreground">Payment Methods</p>
          </div>
          <button
            onClick={fetchCards}
            disabled={loading}
            className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="px-4 pt-5 space-y-4">

          {/* お知らせ: カードはStripeが管理 */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 flex gap-3">
            <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-black text-blue-800 mb-0.5">カードは支払い時に自動保存されます</p>
              <p className="text-xs text-blue-700 leading-relaxed">
                初回購入時に「このカードを保存する」を選ぶと、次回から入力なしでワンタップ決済できます。カード情報はStripeのセキュアなサーバーで管理されます。
              </p>
            </div>
          </div>

          {/* Cards list */}
          {loading ? (
            <div className="space-y-4">
              {[1, 2].map(i => (
                <div key={i} className="h-40 bg-secondary/50 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              {cards.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-secondary/50 rounded-2xl p-10 text-center"
                >
                  <CreditCard className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                  <p className="font-bold text-muted-foreground text-sm">保存済みカードがありません</p>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    購入時に「このカードを保存する」を<br />選ぶと、ここに表示されます
                  </p>
                </motion.div>
              ) : (
                cards.map(card => (
                  <CreditCardWidget
                    key={card.id}
                    card={card}
                    onDelete={() => handleDelete(card.id)}
                    deleting={deletingId === card.id}
                  />
                ))
              )}
            </AnimatePresence>
          )}

          {/* 使い方説明 */}
          <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
            <p className="text-xs font-black text-foreground">💡 2回目以降の支払いの流れ</p>
            {[
              { step: '1', text: '商品ページから「予約する」をタップ' },
              { step: '2', text: '「お支払い」画面で決済ボタンをタップ' },
              { step: '3', text: 'Stripeの画面に保存済みカードが自動表示' },
              { step: '4', text: '確認して「支払う」→ 完了！カード入力不要' },
            ].map(({ step, text }) => (
              <div key={step} className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-[11px] font-black shrink-0">
                  {step}
                </div>
                <p className="text-xs text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>

          {/* Security badges */}
          <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-4 h-4 text-slate-500" />
              <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Security</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: <Lock className="w-3.5 h-3.5" />, label: 'PCI DSS準拠', sub: '最高水準のセキュリティ' },
                { icon: <Wifi className="w-3.5 h-3.5" />, label: 'SSL/TLS暗号化', sub: '全通信を暗号化' },
                { icon: <ShieldCheck className="w-3.5 h-3.5" />, label: 'カード番号不保持', sub: 'Stripeが安全に管理' },
                { icon: <CheckCircle2 className="w-3.5 h-3.5" />, label: '国際認定基盤', sub: '世界標準の決済システム' },
              ].map(({ icon, label, sub }) => (
                <div key={label} className="flex items-start gap-2 bg-white dark:bg-slate-800 rounded-xl p-2.5">
                  <div className="w-6 h-6 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-500 shrink-0 mt-0.5">
                    {icon}
                  </div>
                  <div>
                    <p className="text-[11px] font-black text-slate-600 dark:text-slate-300">{label}</p>
                    <p className="text-[10px] text-slate-400">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
