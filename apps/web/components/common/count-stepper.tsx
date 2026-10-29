'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const COUNT_STEPPER_MAX = 10000;

/** 入力の文字を整数にして min〜max に収める（数字でなければ null） */
export function parseCount(text: string, min: number, max: number): number | null {
  const t = text.normalize('NFKC').trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Math.min(max, Math.max(min, Number.parseInt(t, 10)));
}

export interface CountStepperProps {
  value: number;
  onChange: (value: number) => void;
  /** 既定 0。振り分けの行は 1（allocations.count の CHECK は 1〜10000。0 にしたいときは「削除」を案内する） */
  min?: number;
  /** 既定 10000 */
  max?: number;
  disabled?: boolean;
  /** 読み上げの名前（「長机の数」など） */
  label: string;
  className?: string;
  id?: string;
}

/**
 * ＋－ボタンと数字の入力（画面の設計 1.4。T09a）。整数だけ、min〜max に収める。`inputMode="numeric"`、
 * フォーカスで全選択、長押しの連続はしない。入力中の文字はそのまま持ち、確定（blur・Enter）で数にする。
 *
 * @example
 * <CountStepper label={`${item.name}の数`} value={counts[item.id]} onChange={(v) => set(item.id, v)} />
 * <CountStepper label="台数" min={1} value={row.count} onChange={…} />   // 振り分けの行
 */
export function CountStepper({ value, onChange, min = 0, max = COUNT_STEPPER_MAX, disabled = false, label, className, id }: CountStepperProps) {
  const [text, setText] = useState<string | null>(null); // 入力中だけ文字を持つ
  const commit = () => {
    if (text === null) return;
    const n = parseCount(text, min, max);
    setText(null);
    if (n !== null && n !== value) onChange(n);
  };
  const step = (d: number) => {
    const n = Math.min(max, Math.max(min, value + d));
    if (n !== value) onChange(n);
  };
  return (
    <div className={cn('inline-flex items-center gap-1', className)} role="group" aria-label={label}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`${label}を1減らす`}
        disabled={disabled || value <= min}
        onClick={() => step(-1)}
      >
        <Minus aria-hidden />
      </Button>
      <Input
        id={id}
        aria-label={label}
        className="w-20 text-center tabular-nums"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        disabled={disabled}
        value={text ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setText(null);
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`${label}を1増やす`}
        disabled={disabled || value >= max}
        onClick={() => step(1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
