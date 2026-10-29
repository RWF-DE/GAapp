// キャスター机交換 /swaps の操作の出し分け（画面の設計 3.10、04「キャスター机交換」。T13）。純粋関数。
import type { ConsentStatus } from '@gaapp/shared';
import type { SwapRow } from '@/lib/data/swaps';

export type SwapOp = 'asked' | 'accepted' | 'declined' | 'not_asked';

export interface SwapOpOption {
  op: SwapOp;
  label: string;
  /** 押せない理由（押せるなら null） */
  disabledReason: string | null;
}

/**
 * 振り分け中に出す操作（ほかの状態では何も出さない）。
 * - 依頼：未依頼なら「依頼済みにする」。依頼済み・了承・拒否で、今の置き換え台数が依頼した台数より増えていれば「依頼し直す」。
 *   置き換えの行がなければ押せない（set_consent の no_rows）。
 * - 「了承」「拒否」：総務が団体の代わりに記録する。今と同じ状況のものは出さない。
 * - 「未依頼に戻す」：依頼済み・拒否のときだけ。了承のときは出さない（not_asked は行の固定を変えないので、
 *   了承で固定した置き換えの行が固定のまま残るため。了承を取り消すときは「拒否」か、振り分け画面で固定を外す）。
 */
export function swapOps(row: Pick<SwapRow, 'status' | 'current' | 'asked'>, allocating: boolean): SwapOpOption[] {
  if (!allocating) return [];
  const out: SwapOpOption[] = [];
  const noRows = row.current === 0 ? '置き換えの行がないので依頼できません' : null;
  // 依頼した台数より増えていると set_consent の accepted は conflict になるので、先に依頼し直してもらう
  const grown = row.asked !== null && row.current > row.asked ? '依頼した台数より増えています。依頼し直してください' : null;
  if (row.status === 'not_asked') out.push({ op: 'asked', label: '依頼済みにする', disabledReason: noRows });
  else if (grown) out.push({ op: 'asked', label: '依頼し直す', disabledReason: null });
  if (row.status !== 'accepted') out.push({ op: 'accepted', label: '了承', disabledReason: grown });
  if (row.status !== 'declined') out.push({ op: 'declined', label: '拒否', disabledReason: null });
  if (row.status === 'asked' || row.status === 'declined') out.push({ op: 'not_asked', label: '未依頼に戻す', disabledReason: null });
  return out;
}

/** 操作の確認の文（ダイアログの説明） */
export function swapOpDescription(op: SwapOp, row: Pick<SwapRow, 'current' | 'asked'>): string {
  switch (op) {
    case 'asked':
      return `今の置き換え台数 ${row.current} 台を、団体に見せる台数（依頼した台数）として記録します。団体代表は「自団体の振り分け」で了承・不了承を答えます。`;
    case 'accepted':
      return `総務が団体の代わりに了承を記録します。置き換えの行（今 ${row.current} 台）が固定されます。`;
    case 'declined':
      return '総務が団体の代わりに拒否を記録します。置き換えの行の固定が外れます。振り分け画面で『最小変更で再実行』をすると、この団体の置き換えが消えます。';
    case 'not_asked':
      return '未依頼に戻します。依頼した台数は残ります。';
  }
}

/** 記録した後の知らせ */
export const SWAP_DONE: Record<SwapOp, string> = {
  asked: '依頼済みにしました',
  accepted: '了承を記録しました',
  declined: '拒否を記録しました',
  not_asked: '未依頼に戻しました',
};

/** 状況の印の色 */
export function statusTone(s: ConsentStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (s) {
    case 'accepted':
      return 'default';
    case 'declined':
      return 'destructive';
    case 'asked':
      return 'secondary';
    case 'not_asked':
      return 'outline';
  }
}
