'use client';

// 提出先を開くリンク（T24。D-62。04「提出物」の提出先）。/document のカード・/documents のシートと設定の一覧が使う。
// 提出物のファイルは学校の Google Workspace のドライブ・フォームに出す。アプリはドライブに書き込まず、URL を新しいタブで開くだけ
// （`target="_blank" rel="noopener noreferrer"`。開いた先から window.opener でこのページを触らせず、Referer も送らない）。href には
// DB の CHECK と同じ形（https・空白と制御文字なし・500 字まで）の URL だけを入れ、ほかの形なら何も出さない（submitUrlHref）。
// 出せる人・見られる人はドライブの共有の設定で決まる（アプリは確かめない）。
import { ExternalLink } from 'lucide-react';
import { submitUrlHref } from '@/lib/modules/documents/submit-url';
import { cn } from '@/lib/utils';

/** リンクの文字 */
export const SUBMIT_LINK_TEXT = '提出先を開く';

export function SubmitLink({
  url,
  testId,
  className,
  label = SUBMIT_LINK_TEXT,
}: {
  url: string | null | undefined;
  testId: string;
  className?: string;
  label?: string;
}) {
  const href = submitUrlHref(url);
  if (!href) return null;
  return (
    <a
      data-testid={testId}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:no-underline', className)}
    >
      {label}
      <ExternalLink aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">（新しいタブ）</span>
    </a>
  );
}
