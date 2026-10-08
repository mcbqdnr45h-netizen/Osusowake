import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'wouter';
import type { AppSettings } from '@/hooks/use-app-settings';

interface Props {
  settings: AppSettings;
}

export default function MaintenancePage({ settings }: Props) {
  const lines = settings.maintenance_message.split('\n');
  const [tapCount, setTapCount] = useState(0);
  const [, navigate] = useLocation();

  const handleLogoTap = () => {
    const next = tapCount + 1;
    setTapCount(next);
    if (next >= 5) {
      navigate('/login');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/10 via-background to-accent/10 flex flex-col items-center justify-center px-6 py-16 text-center">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="w-full max-w-sm md:max-w-2xl w-full"
      >
        <motion.div
          animate={{ rotate: [0, -8, 8, -8, 0] }}
          transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
          className="text-7xl mb-8 select-none cursor-default"
          onClick={handleLogoTap}
        >
          🍱
        </motion.div>

        <h1 className="text-2xl font-black text-foreground mb-4 leading-tight">
          {settings.maintenance_title}
        </h1>

        <div className="text-sm text-muted-foreground leading-relaxed mb-8 space-y-1">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {[0, 1, 2].map(i => (
            <motion.div
              key={i}
              className="w-2 h-2 rounded-full bg-primary"
              animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.4 }}
            />
          ))}
        </div>

        <div className="bg-primary/8 border border-primary/20 rounded-2xl px-5 py-4">
          <p className="text-xs font-bold text-primary">おすそわけ</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            ご不便をおかけして申し訳ありません
          </p>
        </div>

        {tapCount >= 3 && tapCount < 5 && (
          <p className="mt-6 text-[11px] text-muted-foreground/50">
            あと{5 - tapCount}回タップで管理者ログイン
          </p>
        )}
      </motion.div>
    </div>
  );
}
