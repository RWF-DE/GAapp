// 楽観ロックの更新と一意のキーの insert の、応答が届かなかったとき・止められたときの判定（画面の設計 2.6 の (B1)。T09a）。
// マスタ〔団体・場所・品目・距離〕（T09）、ルールのシートと有効・無効の切り替え（T12）、今年の使用（setRoomUsable。T09・T13）で使う。
// 送り直しても DB が二重の書き込みを止める（updated_at が進んでいれば conflict、一意のキーがあれば 23505）ので、
// 確かめるためだけの状態（「確かめる」のボタン・押せなくした保存のボタン・未確定の印・送った値の控え）は持たず、
// 応答が届かなかったその場と、conflict・not_found・23505 で止められたときに、対象の行を1回読み直してここで決める。
// save_allocation_rows など、送り直すと二重になりうる書き込みには使わない（2.6 の (B2)。版で確かめる）。
import { classifyError } from '@/lib/errors';

/** 読み直した行をどうするか */
export type LockedWriteOutcome =
  /** 読み直した行の書いた列が入力と同じ。成功と同じに扱う（「保存されていました」と知らせ、閉じて関係するクエリを読み直す） */
  | 'saved'
  /** 入力と違い、行の版が入力の元から進んだ・行ができた・なくなった。今までの conflict の扱い（読み直した行を入力の元にして入力を残す） */
  | 'changed'
  /**
   * 入力と違い、行の版が入力の元のまま（誰も保存していない）。応答が届かなかったときは unknownOutcomeMessage()、
   * conflict・not_found・23505 の後なら今までの conflict の扱い（読み直した行を入力の元にする）
   */
  | 'not-saved'
  /** 読み直せなかった。入力を残す。応答が届かなかったときは unknownOutcomeMessage()、止められた後なら「読み直せませんでした」と読み直すボタン */
  | 'unread';

export interface SettleLockedWriteOptions<Row> {
  /** 対象の行を1行読む（更新は主キー、insert は一意のキー）。なければ null。失敗したら投げる */
  reread: () => Promise<Row | null>;
  /** 読み直した行の、書いた列が入力と同じか */
  matches: (row: Row) => boolean;
  /** 入力の元の版（読み込んだときの updated_at。insert のように行がなかったときは null） */
  baseVersion: string | null;
  /** 行の版（updated_at。受け取った文字列のまま比べる） */
  versionOf: (row: Row) => string | null;
}

/**
 * 応答が届かなかった書き込み（isUnknownOutcome）と、conflict・not_found・23505 で止められた書き込み（isLockRejection）の後に、
 * 対象の行を読み直して決める（2.6 の (B1)）。
 * 1. reread が投げたら 'unread'。
 * 2. 行があり matches(row) なら 'saved'（自分の前の送信が後から通っていた。ほかの人が同じ値にしていたときも同じ）。
 * 3. 行の版（行がなければ null）が baseVersion と同じなら 'not-saved'。
 * 4. それ以外は 'changed'（版が進んだ・行ができた・なくなった）。
 * 自分の前の送信（値が今の入力と違う）が後から通っていた場合も 'changed' になる（ほかの人の変更に見える。上書きするかは利用者が決める）。
 *
 * @example
 * // 団体の表示名の更新（T09）。g は入力の元の行
 * try {
 *   await updateWithLock(supabase, 'groups', { id: g.id }, g.updated_at, patch);
 *   done('保存しました');
 * } catch (e) {
 *   if (!isUnknownOutcome(e) && !isLockRejection(e)) throw e; // forbidden などは 2.5 の表のとおり
 *   const outcome = await settleLockedWrite({
 *     reread: async () => {
 *       const res = await supabase.from('groups').select(COLUMNS.groups).eq('id', g.id).maybeSingle();
 *       if (res.error) throw toAppError(res.error, res.status);
 *       return res.data;
 *     },
 *     matches: (row) => row.display_name === patch.display_name,
 *     baseVersion: g.updated_at,
 *     versionOf: (row) => row.updated_at,
 *   });
 *   if (outcome === 'saved') return done('保存されていました');
 *   if (isUnknownOutcome(e) && (outcome === 'not-saved' || outcome === 'unread')) return keepInput(unknownOutcomeMessage());
 *   if (outcome === 'unread') return keepInput('ほかの人が変えた可能性がありますが、読み直せませんでした', { showReload: true });
 *   // changed（と、止められた後の not-saved）：今までの conflict の扱い。読み直した行を入力の元にして入力を残す。
 *   // 応答が届かなかった後の changed は、e が network なので conflict の文言を作って出す
 *   const c = isLockRejection(e) ? classifyError(e) : appError('conflict', 'lock_conflict').info;
 *   return showConflict(messageFor(c));
 * }
 */
export async function settleLockedWrite<Row>(opts: SettleLockedWriteOptions<Row>): Promise<LockedWriteOutcome> {
  let row: Row | null;
  try {
    row = await opts.reread();
  } catch {
    return 'unread';
  }
  if (row !== null && row !== undefined && opts.matches(row)) return 'saved';
  const version = row === null || row === undefined ? null : opts.versionOf(row);
  return version === opts.baseVersion ? 'not-saved' : 'changed';
}

/**
 * 楽観ロックの更新・一意のキーの insert が DB に止められた失敗か（2.6 の (B1) の 3）。
 * classifyError の kind が conflict（updateWithLock の lock_conflict、insert の 23505、setRoomUsable の lock_conflict）か
 * not_found（lock_missing）。forbidden（lock_unchanged。RLS）は含めない（年度の行と立場を読み直す）。
 */
export function isLockRejection(e: unknown, status?: number | null): boolean {
  const kind = classifyError(e, status).kind;
  return kind === 'conflict' || kind === 'not_found';
}
