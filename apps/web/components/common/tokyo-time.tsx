import { formatDate, formatDateTime, formatDateTimeSeconds, formatShortDateTime, formatTime } from '@/lib/datetime';

const FORMATS = {
  datetime: formatDateTime,
  short: formatShortDateTime,
  time: formatTime,
} as const;

/**
 * 日時を Asia/Tokyo で表示する（`2026/10/05 18:01`。title に秒まで）。画面の設計 1.4・2.8。T09a。
 * date を渡すと日付だけ（YYYY-MM-DD の文字列。1日目など）。値がなければ empty。
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
    const s = typeof value === 'string' ? value : value.toISOString().slice(0, 10);
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
