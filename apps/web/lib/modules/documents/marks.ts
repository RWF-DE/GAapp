// 提出の状態の印（04「提出物」の状態の印。2つの画面・ダッシュボード・CSV で同じ決め方。T19・D-55）。純粋な関数（時計は now だけ）。
// - 状態：未提出・提出済み（総務は「承認待ち」）・差し戻し・承認（v_document_status は行のない提出を未提出として出す）
// - 締切の後（late）：締切の後に「提出した」を押した提出（v_document_status の late をそのまま使う。Q6）
// - 代理（proxy）：部門長以上が代わりに提出した
// - 紙（paper）：未提出・差し戻しから承認した（承認で submitted_at がない。Q9）
// - 締切を過ぎた（overdue）：未提出・差し戻しのまま締切を過ぎた（締切ちょうどは過ぎた側：deadline ≤ now。画面を開いた時刻と
//   「読み直す」を押した時刻で決める）
import { statusOf, type DocumentStatus } from './labels';

/** 印を決める材料（v_document_status の列） */
export interface MarkSource {
  status: DocumentStatus | null;
  deadline: string;
  submitted_at: string | null;
  late: boolean | null;
  proxy: boolean | null;
}

/** 1つの提出の印 */
export interface DocumentMarks {
  status: DocumentStatus;
  late: boolean;
  proxy: boolean;
  paper: boolean;
  overdue: boolean;
}

/** 未提出か差し戻し（ファイルを足して「提出した」を待っている）か */
export function isOpenStatus(status: DocumentStatus): boolean {
  return status === 'not_submitted' || status === 'returned';
}

/** 締切を過ぎたか（締切ちょうどは過ぎた側。読めない締切は偽） */
export function deadlinePassed(deadline: string, now: number): boolean {
  const t = Date.parse(deadline);
  return !Number.isNaN(t) && t <= now;
}

/**
 * 印（04「提出物」の状態の印）。
 *
 * @example
 * documentMarks({ status: 'approved', deadline, submitted_at: null, late: false, proxy: false }, now).paper // true（紙などで受け取った）
 */
export function documentMarks(row: MarkSource, now: number): DocumentMarks {
  const status = statusOf(row.status);
  return {
    status,
    late: row.late === true,
    proxy: row.proxy === true,
    paper: status === 'approved' && row.submitted_at === null,
    overdue: isOpenStatus(status) && deadlinePassed(row.deadline, now),
  };
}
