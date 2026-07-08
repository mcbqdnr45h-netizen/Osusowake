import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bell, Sparkles, Clock, Tag } from 'lucide-react';
import { useLocation } from 'wouter';
import { shouldOfferPush, requestAllPushPermissions } from '@/lib/push-permission';

// 「あとで」を押したら再訴求まで空ける日数。
const COOLDOWN_DAYS = 7;
const LS_KEY = 'osusowake_push_nudge_at';
// 起動後この秒数だけ待ってから出す(いきなり被せない。まず地図を見せる)。
const SHOW_DELAY_MS = 3500;

// 訴求を出さないパス(管理/共有ボード/認証フローの邪魔をしない)。
const SKIP_PREFIXES = ['/admin', '/board', '/login', '/signup', '/onboarding'];

function inCooldown(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last < COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function markDismissed() {
  try {
    localStorage.setItem(LS_KEY, String(Date.now()));
  } catch {
    /* localStorage 不可環境は無視 */
  }
}

const BENEFITS = [
  { icon: Tag, text: '半額バッグの出品を見逃さない' },
  { icon: Clock, text: 'ランチ・ディナー前にお得情報' },
  { icon: Sparkles, text: '登録不要・ワンタップでオン' },
];

export function NotificationNudgeSheet() {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const skip = SKIP_PREFIXES.some((p) => location.startsWith(p));
    if (skip || inCooldown()) return;

    const timer = setTimeout(async () => {
      const ok = await shouldOfferPush();
      if (!cancelled && ok) setIsOpen(true);
    }, SHOW_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [location]);

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await requestAllPushPermissions();
    } finally {
      setBusy(false);
      markDismissed(); // 許可/拒否どちらでも、もう当面は出さない
      setIsOpen(false);
    }
  };

  const handleLater = () => {
    markDismissed();
    setIsOpen(false);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[210] flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleLater}
        >
          {/* オーバーレイ */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          {/* シート */}
          <motion.div
            className="relative w-full max-w-lg bg-card rounded-t-3xl px-6 pt-5 pb-8 z-10"
            style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ドラッグハンドル */}
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />

            {/* 閉じるボタン */}
            <button
              onClick={handleLater}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-muted flex items-center justify-center"
              aria-label="閉じる"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>

            {/* アイコン */}
            <div className="w-14 h-14 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Bell className="w-7 h-7" />
            </div>

            {/* テキスト */}
            <h2 className="text-xl font-black text-foreground text-center mb-2 leading-tight whitespace-pre-line">
              {'お得な出品を\n通知でお知らせ'}
            </h2>
            <p className="text-[13px] text-muted-foreground text-center leading-relaxed mb-4">
              毎日ランチ・ディナー前に「今日は◯件出品中」をお届け。半額バッグは早い者勝ちです。
            </p>

            {/* ベネフィットリスト */}
            <ul className="bg-secondary/40 rounded-2xl px-4 py-3 mb-5 space-y-2">
              {BENEFITS.map((b, i) => (
                <li key={i} className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center shrink-0 shadow-sm">
                    <b.icon className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="text-[12px] font-bold text-foreground leading-tight">{b.text}</span>
                </li>
              ))}
            </ul>

            {/* ボタン */}
            <div className="space-y-2.5">
              <button
                onClick={handleEnable}
                disabled={busy}
                className="w-full bg-primary text-white font-black py-3.5 rounded-2xl text-sm flex items-center justify-center gap-2 shadow-md shadow-primary/20 active:scale-[0.98] transition-transform disabled:opacity-60"
              >
                <Bell className="w-4 h-4" />
                {busy ? '設定中…' : '通知をオンにする'}
              </button>
              <button
                onClick={handleLater}
                className="w-full text-xs text-muted-foreground py-1.5"
              >
                あとで
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
