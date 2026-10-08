import React, { useRef, useEffect, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, Check } from 'lucide-react';

const ITEM_H = 44;
const HOURS   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

function nearestMinute(m: string): string {
  return MINUTES.reduce((prev, cur) =>
    Math.abs(parseInt(cur) - parseInt(m)) < Math.abs(parseInt(prev) - parseInt(m)) ? cur : prev
  );
}

interface DrumProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}

function Drum({ value, options, onChange }: DrumProps) {
  const ref     = useRef<HTMLDivElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollTo = useCallback((idx: number, smooth = true) => {
    ref.current?.scrollTo({ top: idx * ITEM_H, behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  useEffect(() => {
    const idx = options.indexOf(value);
    if (idx !== -1) scrollTo(idx, false);
  }, []);

  const handleScroll = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      if (!ref.current) return;
      const idx = Math.max(0, Math.min(options.length - 1, Math.round(ref.current.scrollTop / ITEM_H)));
      scrollTo(idx);
      onChange(options[idx]);
    }, 100);
  }, [options, scrollTo, onChange]);

  return (
    <div className="relative flex-1 flex flex-col items-center" style={{ height: ITEM_H * 5 }}>
      <div
        className="absolute inset-x-2 rounded-xl bg-primary/10 pointer-events-none z-10"
        style={{ top: ITEM_H * 2, height: ITEM_H }}
      />
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{ background: 'linear-gradient(to bottom, var(--background) 0%, transparent 35%, transparent 65%, var(--background) 100%)' }}
      />
      <div
        ref={ref}
        onScroll={handleScroll}
        className="w-full overflow-y-scroll overscroll-contain select-none"
        style={{
          height: ITEM_H * 5,
          scrollSnapType: 'y mandatory',
          WebkitOverflowScrolling: 'touch' as any,
          scrollbarWidth: 'none' as any,
          msOverflowStyle: 'none' as any,
        }}
      >
        <div style={{ height: ITEM_H * 2 }} />
        {options.map(opt => (
          <div
            key={opt}
            onClick={() => { scrollTo(options.indexOf(opt)); onChange(opt); }}
            style={{ height: ITEM_H, scrollSnapAlign: 'center' }}
            className="flex items-center justify-center text-2xl font-black text-foreground cursor-pointer"
          >
            {opt}
          </div>
        ))}
        <div style={{ height: ITEM_H * 2 }} />
      </div>
    </div>
  );
}

interface TimePickerProps {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}

export function TimePicker({ value, onChange, label }: TimePickerProps) {
  const [open, setOpen] = useState(false);

  const parsedH = value.match(/^(\d{2}):(\d{2})$/)?.[1] ?? '09';
  const parsedM = value.match(/^(\d{2}):(\d{2})$/)?.[2] ?? '00';

  const [draftH, setDraftH] = useState(parsedH);
  const [draftM, setDraftM] = useState(nearestMinute(parsedM));

  const openSheet = () => {
    const h = value.match(/^(\d{2}):(\d{2})$/)?.[1] ?? '09';
    const m = value.match(/^(\d{2}):(\d{2})$/)?.[2] ?? '00';
    setDraftH(h);
    setDraftM(nearestMinute(m));
    setOpen(true);
  };

  const confirm = () => {
    onChange(`${draftH}:${draftM}`);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        className="w-full flex items-center gap-3 px-4 py-3 bg-secondary/50 rounded-xl border border-border/50 hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors group"
      >
        <Clock className="w-4 h-4 text-primary shrink-0" />
        <span className={`text-sm font-black flex-1 text-left ${value ? 'text-foreground' : 'text-muted-foreground'}`}>
          {value || '--:--'}
        </span>
        {/* ★ whitespace-nowrap + 360px未満では非表示: 320px級の狭い端末で
            「タ/ッ/プ/し/て/設/定」と縦に崩れるのを防ぐ(時計アイコン+時刻表示で意味は伝わる) */}
        <span className="hidden min-[360px]:inline whitespace-nowrap text-[11px] text-muted-foreground/60 font-medium group-hover:text-primary/60 transition-colors">
          タップして設定
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="tp-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <motion.div
              key="tp-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 z-[60] bg-background rounded-t-3xl px-6 pt-4 max-w-xl mx-auto shadow-2xl"
              style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
            >
              <div className="w-10 h-1.5 bg-border rounded-full mx-auto mb-5" />
              {label && (
                <p className="text-center text-sm font-bold text-muted-foreground mb-4">{label}</p>
              )}

              <div className="flex items-center gap-2 justify-center mb-6">
                <Drum value={draftH} options={HOURS}   onChange={setDraftH} />
                <span className="text-2xl font-black text-muted-foreground shrink-0 pb-1">:</span>
                <Drum value={draftM} options={MINUTES} onChange={setDraftM} />
              </div>

              <button
                type="button"
                onClick={confirm}
                className="w-full h-14 bg-primary text-primary-foreground rounded-2xl font-black text-base flex items-center justify-center gap-2 shadow-lg shadow-primary/20 active:scale-[0.98] transition-all"
              >
                <Check className="w-5 h-5" />
                {draftH}:{draftM} に設定する
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
