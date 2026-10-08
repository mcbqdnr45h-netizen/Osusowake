import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { Flag, MapPin, Store, FileText, ChevronLeft, CheckCircle, SendHorizontal } from 'lucide-react';
import { Layout } from '@/components/Layout';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

export default function SalesLeadForm() {
  const [, navigate] = useLocation();
  const [storeName, setStoreName] = useState('');
  const [location, setLocation]   = useState('');
  const [memo, setMemo]           = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!storeName.trim() || !location.trim()) {
      setError('店舗名と場所（大まかな住所やエリア）は必須です');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/sales-leads`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ storeName, location, memo }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'エラーが発生しました');
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || '送信に失敗しました。もう一度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout>
      <div className="min-h-screen bg-background">
        {/* ヘッダー */}
        <div className="sticky z-40 bg-white/90 backdrop-blur-xl border-b border-border/40"
          style={{ top: 'env(safe-area-inset-top)' }}>
          <div className="w-full max-w-lg md:max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
            <button
              onClick={() => navigate('/mypage')}
              className="p-2 -ml-2 rounded-xl hover:bg-secondary transition-colors"
            >
              <ChevronLeft className="w-5 h-5 text-foreground" />
            </button>
            <div className="flex items-center gap-2">
              <Flag className="w-4 h-4 text-primary" />
              <span className="font-black text-foreground">食品ロスのお店を教えて</span>
            </div>
          </div>
        </div>

        <div className="w-full max-w-lg md:max-w-3xl mx-auto px-4 py-6 space-y-5">
          <AnimatePresence mode="wait">
            {submitted ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center justify-center text-center gap-5 pt-12"
              >
                <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle className="w-10 h-10 text-green-500" />
                </div>
                <div className="space-y-2">
                  <p className="text-xl font-black text-foreground">ありがとうございます！</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    情報を受け付けました。<br/>
                    おすそわけのスタッフが直接お伺いします🙏
                  </p>
                </div>
                <button
                  onClick={() => navigate('/mypage')}
                  className="mt-4 px-8 py-3 rounded-2xl bg-primary text-white font-black text-sm hover:bg-primary/90 transition-colors"
                >
                  マイページに戻る
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-5"
              >
                {/* ヒーローバナー */}
                <div
                  className="rounded-3xl px-5 py-5 space-y-2"
                  style={{ background: 'linear-gradient(135deg, #FFF3E8 0%, #FFE0C2 100%)', border: '2px solid rgba(242,100,25,0.2)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🏪</span>
                    <p className="font-black text-foreground">食品ロスで困っているお店はありませんか？</p>
                  </div>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    「あそこのパン屋さん、毎日余ってそう…」そんな気づきを教えてください。<br/>
                    おすそわけスタッフが直接お話を聞きに伺います。
                  </p>
                </div>

                {/* フォーム */}
                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* 店舗名 */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-black text-foreground flex items-center gap-1.5">
                      <Store className="w-3.5 h-3.5 text-primary" />
                      店舗名・お店の種類
                      <span className="text-[10px] font-bold text-destructive ml-1">必須</span>
                    </label>
                    <input
                      type="text"
                      value={storeName}
                      onChange={e => setStoreName(e.target.value)}
                      placeholder="（例）高槻市の〇〇ベーカリー"
                      maxLength={100}
                      className="w-full bg-card border border-border/80 rounded-2xl px-4 py-3.5 text-sm font-medium placeholder:text-muted-foreground/40 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
                      style={{ boxShadow: '0 1px 4px -1px rgba(10,8,6,0.06)' }}
                    />
                  </div>

                  {/* 場所 */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-black text-foreground flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-primary" />
                      場所（大まかな住所やエリア）
                      <span className="text-[10px] font-bold text-destructive ml-1">必須</span>
                    </label>
                    <input
                      type="text"
                      value={location}
                      onChange={e => setLocation(e.target.value)}
                      placeholder="（例）大阪府高槻市駅前通り、梅田の近く"
                      maxLength={200}
                      className="w-full bg-card border border-border/80 rounded-2xl px-4 py-3.5 text-sm font-medium placeholder:text-muted-foreground/40 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all"
                      style={{ boxShadow: '0 1px 4px -1px rgba(10,8,6,0.06)' }}
                    />
                  </div>

                  {/* メモ */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-black text-foreground flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      一言メモ
                      <span className="text-[10px] text-muted-foreground ml-1">任意</span>
                    </label>
                    <textarea
                      value={memo}
                      onChange={e => setMemo(e.target.value)}
                      placeholder="夕方18時ごろにお弁当が余っているようです"
                      maxLength={400}
                      rows={3}
                      className="w-full bg-card border border-border/80 rounded-2xl px-4 py-3.5 text-sm font-medium placeholder:text-muted-foreground/40 focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all resize-none"
                      style={{ boxShadow: '0 1px 4px -1px rgba(10,8,6,0.06)' }}
                    />
                    <p className="text-[11px] text-muted-foreground/60 text-right">{memo.length}/400</p>
                  </div>

                  {/* エラー */}
                  <AnimatePresence>
                    {error && (
                      <motion.p
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="text-sm font-semibold text-destructive bg-destructive/5 border border-destructive/20 px-4 py-3 rounded-xl"
                      >
                        {error}
                      </motion.p>
                    )}
                  </AnimatePresence>

                  {/* 送信ボタン */}
                  <button
                    type="submit"
                    disabled={submitting || !storeName.trim() || !location.trim()}
                    className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-primary text-white font-black text-base disabled:opacity-50 hover:bg-primary/90 transition-all tap-scale"
                    style={{ boxShadow: '0 4px 14px -2px rgba(242,100,25,0.4)' }}
                  >
                    <SendHorizontal className="w-5 h-5" />
                    {submitting ? '送信中...' : 'おすそわけに教える'}
                  </button>
                </form>

                <p className="text-[11px] text-center text-muted-foreground/50 leading-relaxed">
                  送信いただいた情報はおすそわけの営業担当のみが閲覧します。<br/>
                  個人情報は含めないようにしてください。
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Layout>
  );
}
