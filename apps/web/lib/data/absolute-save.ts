// 数を絶対値で書く書き込みの、送る前の読み直しの判定（画面の設計 2.6。T09a）。
// 在庫の upsert（T10）、申請の submit_requests・申請一覧のセル・代理入力・締切後の修正（T11）で使う。
// 同じ内容を2回送っても結果は同じなので、保存できたか分からない状態は持たず、保存のたびに読み直してここで決める。
// insert を足す書き込み（振り分けの save_allocation_rows など）には使わない（版で確かめる。3.9）。

/** 読み直した結果をどうするか */
export type AbsoluteSaveDecision =
  /** DB がすでに入力と同じ（前に送って応答が届かなかった保存が通っていた）。送らずに「保存されていました」 */
  | 'saved'
  /** 入力の元（base）の後に、自分以外の人が変えた。ほかの人の保存のダイアログ（上書きする・読み直す）を出す */
  | 'conflict'
  /** 送る（入力の元を読み直した行にしてから） */
  | 'send';

/** 比べる1つ（在庫なら品目ごと、申請一覧ならセルごと、申請なら品目ごと＋提出の記録） */
export interface AbsoluteSaveEntry<V> {
  /** 送る値 */
  input: V;
  /** 入力の元（読み込んだとき・前に読み直したときの値。行がなければ null など） */
  base: V;
  /** いま読み直した値 */
  fresh: V;
  /**
   * 読み直した行が入力の元から変わったか。値ではなく行の記録（updated_at・counted_at・submitted_at、行の有無）で見る
   * （同じ数での数え直し・同じ内容での再提出は値が変わらないので、値だけでは誰かが保存したかが分からない）。
   */
  changed: boolean;
  /**
   * その変更が自分以外の人のものか（changed のときだけ見る）。在庫は counted_by が自分でない、
   * 提出の記録は updated_by が自分でない（どちらも null は自分でないとする）。
   * 省くと値で決める：読み直した値が入力の元とも入力とも違えば自分以外（申請の行。requests は書いた人を持たない）。
   */
  byOther?: boolean;
}

/**
 * 送る前に読み直した行で、送るか・保存されていたか・ほかの人の保存のダイアログを出すかを決める（2.6 の (2)〜(4)）。
 * 1. 比べるものすべてで読み直した値が入力と同じで、どれかの行が入力の元から変わっていれば 'saved'
 *    （どの行も変わっていなければ、誰も保存していないので送る。数え直し・再提出を飛ばさないため）。
 * 2. 入力の元から変わった行のどれかが自分以外の人のものなら 'conflict'（自分の書いたもの〔前に送って応答が届かなかった保存〕は数えない）。
 * 3. それ以外は 'send'。
 * 呼ぶ側は、'saved' と 'send' のとき入力の元を読み直した行にする（申請の行の updateWithLock・update_requests_after_deadline に渡す
 * updated_at も読み直した行のもの）。'conflict' で「上書きする」を選んだら、読み直した行を入力の元にして送る。
 * 読み直しが通信できないとき（isUnknownOutcome）は送らず、入力を残して unknownOutcomeMessage を出す。
 * 比べるものがなければ 'send'。
 *
 * @example
 * // 在庫（T10）：部屋の全品目。base・fresh は品目ごとの stocks の行（ない品目は undefined）
 * const decision = decideAbsoluteSave(
 *   items.map((it) => {
 *     const b = base.get(it.id), f = fresh.get(it.id);
 *     return {
 *       input: counts[it.id] ?? 0, base: b?.count ?? null, fresh: f?.count ?? null,
 *       changed: (b?.updated_at ?? null) !== (f?.updated_at ?? null),
 *       byOther: f != null && f.counted_by !== userId,
 *     };
 *   }),
 * );
 */
export function decideAbsoluteSave<V>(
  entries: readonly AbsoluteSaveEntry<V>[],
  equals: (a: V, b: V) => boolean = Object.is,
): AbsoluteSaveDecision {
  if (entries.length === 0) return 'send';
  if (entries.every((e) => equals(e.fresh, e.input)) && entries.some((e) => e.changed)) return 'saved';
  const byOther = (e: AbsoluteSaveEntry<V>) => e.byOther ?? (!equals(e.fresh, e.base) && !equals(e.fresh, e.input));
  if (entries.some((e) => e.changed && byOther(e))) return 'conflict';
  return 'send';
}
