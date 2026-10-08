import React, { useState } from 'react';
import { Layout } from '@/components/Layout';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Loader2, Database, RefreshCw, PlusCircle, Trash2 } from 'lucide-react';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

type TableStatus = 'idle' | 'loading' | 'ok' | 'error';
type TableResult = { [key: string]: string };

export default function SupabaseTest() {
  const [healthStatus, setHealthStatus] = useState<TableStatus>('idle');
  const [tables, setTables] = useState<TableResult | null>(null);
  const [writeStatus, setWriteStatus] = useState<TableStatus>('idle');
  const [writeResult, setWriteResult] = useState<any>(null);

  const runHealthCheck = async () => {
    setHealthStatus('loading');
    setTables(null);
    try {
      const res = await fetch(`${BASE}/api/supabase/health`);
      const data = await res.json();
      setTables(data.tables ?? {});
      setHealthStatus(data.status === 'ok' ? 'ok' : 'error');
    } catch {
      setHealthStatus('error');
    }
  };

  const runWriteTest = async () => {
    setWriteStatus('loading');
    setWriteResult(null);
    try {
      const email = `browser_test_${Date.now()}@rescueat.test`;
      const res = await fetch(`${BASE}/api/supabase/test-write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'customer' }),
      });
      const data = await res.json();
      setWriteResult(data);
      setWriteStatus(data.success ? 'ok' : 'error');
    } catch (e: any) {
      setWriteStatus('error');
      setWriteResult({ error: e.message });
    }
  };

  const StatusIcon = ({ status }: { status: TableStatus }) => {
    if (status === 'loading') return <Loader2 className="w-5 h-5 animate-spin text-primary" />;
    if (status === 'ok') return <CheckCircle className="w-5 h-5 text-green-500" />;
    if (status === 'error') return <XCircle className="w-5 h-5 text-destructive" />;
    return null;
  };

  return (
    <Layout>
      <div className="w-full max-w-lg md:max-w-3xl mx-auto p-4 md:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Database className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-black">Supabase 接続テスト</h1>
            <p className="text-xs text-muted-foreground">4テーブルの読み書きを確認します</p>
          </div>
        </div>

        {/* Health Check Card */}
        <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">① テーブル存在確認</h2>
            <StatusIcon status={healthStatus} />
          </div>

          <AnimatePresence>
            {tables && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-2"
              >
                {Object.entries(tables).map(([table, status]) => (
                  <div key={table} className="flex items-center justify-between bg-secondary/50 rounded-xl px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono font-bold">{table}</code>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {status === 'OK'
                        ? <><CheckCircle className="w-4 h-4 text-green-500" /><span className="text-xs text-green-600 font-bold">OK</span></>
                        : <><XCircle className="w-4 h-4 text-destructive" /><span className="text-xs text-destructive font-bold">ERROR</span></>
                      }
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={runHealthCheck}
            disabled={healthStatus === 'loading'}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-bold py-3 rounded-xl hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-60"
          >
            {healthStatus === 'loading'
              ? <><Loader2 className="w-4 h-4 animate-spin" />確認中...</>
              : <><RefreshCw className="w-4 h-4" />テーブル確認を実行</>
            }
          </button>
        </div>

        {/* Write Test Card */}
        <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">② 書き込み → 読み取り → 削除テスト</h2>
            <StatusIcon status={writeStatus} />
          </div>

          <AnimatePresence>
            {writeResult && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className={`rounded-xl p-4 text-xs font-mono whitespace-pre-wrap break-all ${
                  writeResult.success
                    ? 'bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-900 dark:text-green-200'
                    : 'bg-destructive/5 border border-destructive/20 text-destructive'
                }`}
              >
                {writeResult.success
                  ? `✅ ${writeResult.message}\n\n作成されたレコード:\nid: ${writeResult.created.id}\nemail: ${writeResult.created.email}\nrole: ${writeResult.created.role}\ncreated_at: ${writeResult.created.created_at}`
                  : `❌ エラー: ${writeResult.error}`
                }
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={runWriteTest}
            disabled={writeStatus === 'loading'}
            className="w-full flex items-center justify-center gap-2 bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-700 active:scale-95 transition-all disabled:opacity-60"
          >
            {writeStatus === 'loading'
              ? <><Loader2 className="w-4 h-4 animate-spin" />テスト中...</>
              : <><PlusCircle className="w-4 h-4" />書き込みテストを実行</>
            }
          </button>
        </div>

        {/* Info box */}
        <div className="bg-secondary/50 rounded-2xl p-4 text-xs text-muted-foreground space-y-1">
          <p className="font-bold text-foreground mb-2">テスト内容</p>
          <p>• users / stores / products / orders の4テーブル接続確認</p>
          <p>• usersテーブルへのINSERT → SELECT → DELETE</p>
          <p>• RLS（全許可ポリシー）が正常に機能しているか確認</p>
          <p className="pt-1 text-amber-600 dark:text-amber-400 font-medium">
            ※ このページは開発・テスト用です。本番では削除してください。
          </p>
        </div>
      </div>
    </Layout>
  );
}
