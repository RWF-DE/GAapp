'use client';

// シフト表・作業一覧のダイアログの、送った後の知らせ（04「シフト表」「作業一覧」のエラーと読み直し。(B1)。T20）。締切と予定の
// ダイアログの SubmitNotice と同じ形：conflict（読み直した今の行）・消えていた・保存できたか分からない・止められた後に読み直せなかった
// （「読み直す」つき）・そのほかの失敗（ErrorBanner）。testid はダイアログごとに渡す。
import { ErrorBanner } from '@/components/common/error-banner';
import { Button } from '@/components/ui/button';
import type { MessageContext } from '@/lib/errors';

/** 止められた後に読み直せなかった（「読み直しました」とは言わない） */
export const REREAD_FAILED_NOTICE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';
/** 「読み直す」でもまた読み直せなかった */
export const REREAD_AGAIN_FAILED_MESSAGE = 'まだ読み直せませんでした。通信を確かめてから、もう一度「読み直す」を押してください（入力は残してあります）';
/** 送るボタンを押せないとき（書けない・権限か年度の状態が変わった）の足もとの文 */
export const CANNOT_SAVE_TEXT = '今の立場・年度の状態では保存できません';

/** 送った後の知らせ */
export type WriteNoticeState =
  /** ほかの人が先に変えた（lines は読み直した今の値の説明） */
  | { type: 'conflict'; message: string; lines: readonly string[] }
  /** 消えていた */
  | { type: 'missing'; message: string }
  /** 文言だけの知らせ（保存できたか分からない・同じ名前があるなど） */
  | { type: 'message'; message: string; kind: string }
  /** 止められた後に読み直せなかった（「読み直す」つき） */
  | { type: 'unread' }
  /** そのほかの失敗（ErrorBanner） */
  | { type: 'error'; error: unknown; context?: MessageContext };

const BOX = 'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm';

export function WriteNotice({
  state,
  testIds,
  onReload,
  onReread,
  rereading = false,
}: {
  state: WriteNoticeState | null;
  /** conflict・missing・ほか（message・unread・error）の testid */
  testIds: { conflict: string; missing: string; error: string };
  onReload: () => void;
  onReread?: () => void;
  rereading?: boolean;
}) {
  if (!state) return null;
  switch (state.type) {
    case 'conflict':
      return (
        <div role="alert" data-testid={testIds.conflict} data-submit-error className={BOX}>
          <p className="font-medium text-destructive">{state.message}</p>
          {state.lines.map((l, k) => (
            <p key={k} className="[overflow-wrap:anywhere]">
              {l}
            </p>
          ))}
        </div>
      );
    case 'missing':
      return (
        <div role="alert" data-testid={testIds.missing} data-submit-error className={BOX}>
          <p className="font-medium text-destructive">{state.message}</p>
          <p>入力は残してあります。必要なら写してから閉じてください。</p>
        </div>
      );
    case 'message':
      return (
        <div role="alert" data-testid={testIds.error} data-kind={state.kind} data-submit-error className={BOX}>
          <p className="font-medium text-destructive">{state.message}</p>
        </div>
      );
    case 'unread':
      return (
        <div role="alert" data-testid={testIds.error} data-kind="unread" data-submit-error className={BOX}>
          <p className="font-medium text-destructive">{REREAD_FAILED_NOTICE}</p>
          {onReread ? (
            <Button size="sm" variant="outline" onClick={onReread} disabled={rereading} aria-busy={rereading || undefined}>
              {rereading ? '読み直しています…' : '読み直す'}
            </Button>
          ) : null}
        </div>
      );
    case 'error':
      return (
        <div data-testid={testIds.error} data-kind="error" data-submit-error>
          <ErrorBanner error={state.error} context={state.context} onReload={onReload} />
        </div>
      );
  }
}

/** ネイティブの select（Input と同じ見た目。マスタ設定と同じ） */
export const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';
