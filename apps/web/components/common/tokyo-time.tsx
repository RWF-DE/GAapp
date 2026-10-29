import { formatDate, formatDateTime, formatDateTimeSeconds, formatShortDateTime, formatTime, tokyoDate } from '@/lib/datetime';

const FORMATS = {
  datetime: formatDateTime,
  short: formatShortDateTime,
  time: formatTime,
} as const;

/**
 * 日時を Asia/Tokyo で表示する（`2026/10/05 18:01`。title に秒まで）。画面の設計 1.4・2.8。T09a。
 * date を渡すと日付だけ（YYYY-MM-DD の文字列はそのまま。Date・timestamptz は Asia/Tokyo の日付）。値がなければ・読めなければ empty。
 *
 * @example
 * <TokyoTime value={row.updated_at} />
 * <TokyoTime value={year.festival_start} format="date" />
 */
export function TokyoTime({
  value,
  format = 'datetime',
  empty = '—',
  className,
}: {
  value: string | Date | null | undefined;
  format?: keyof typeof FORMATS | 'date';
  empty?: string;
  className?: string;
}) {
  if (value === null || value === undefined || value === '') return <span className={className}>{empty}</span>;
  if (format === 'date') {
    // Date・timestamptz の文字列は Asia/Tokyo の日付にする（toISOString は UTC の日付になるので使わない）
    const s = tokyoDate(value);
    if (!s) return <span className={className}>{empty}</span>;
    return (
      <time dateTime={s} className={className}>
        {formatDate(s)}
      </time>
    );
  }
  const iso = typeof value === 'string' ? value : value.toISOString();
  return (
    <time dateTime={iso} title={formatDateTimeSeconds(value)} className={className}>
      {FORMATS[format](value)}
    </time>
  );
}
