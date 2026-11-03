// 書き込みが済んで押したボタンが消えた後のフォーカス（04「自団体の提出物」「提出状況」のフォーカス。2026-11-03。レビューの F4。T19）。
// 「提出した」「提出を取り消す」・シートの承認などは、成功すると押したボタンが消える。確かめのダイアログ（共有の ConfirmDialog）は開いた元へ
// フォーカスを戻すが、元がもうなければ戻さないので、フォーカスは body に落ちて行き場をなくす。そこで、ダイアログが閉じ切ってから（閉じる動きの間は、
// ほかの要素が aria-hidden のまま）、フォーカスを失っていたときだけ、行き先（カードの題名・シートの見出し）へ移す。開いた元が残っていれば
// （止められた・理由の書き直しなど）、ダイアログが戻したまま動かさない。window・document はイベント・effect の後だけで使う。

/** 確かめのダイアログ（共有の ConfirmDialog は alertdialog）と、シートの承認・差し戻し・紙での承認のダイアログ */
export const DIALOG_SELECTOR =
  '[role="alertdialog"], [data-testid="documents-approve-dialog"], [data-testid="documents-return-dialog"], [data-testid="documents-paper-dialog"]';

/** 待つ間隔（ms）と回数（閉じる動きは 200 ms ほど。長く開いたままなら、そのダイアログの中のフォーカスを動かさない） */
const INTERVAL_MS = 25;
const TRIES = 80;

/**
 * ダイアログが閉じ切ってから、フォーカスを失っていれば（body。container を渡したときは、その入れ物そのものも〔シートは、中の要素が消えると
 * Radix がシートの入れ物にフォーカスを置く〕）target に移す。やめる関数を返す。
 *
 * @example
 * focusAfterDialogs(() => window.document.getElementById(`document-card-title-${id}`));
 * focusAfterDialogs(() => titleRef.current, () => titleRef.current?.closest('[role="dialog"]') ?? null); // シートの見出し
 */
export function focusAfterDialogs(target: () => HTMLElement | null, container: () => Element | null = () => null, selector: string = DIALOG_SELECTOR): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = TRIES;
  const settle = () => {
    // Radix は、ダイアログを外した後の最初のタスクで開いた元へフォーカスを戻す。その後に、失っていたときだけ移す
    timer = setTimeout(() => {
      const active = window.document.activeElement;
      const lost = !active || active === window.document.body || active === container();
      if (lost) target()?.focus();
    }, 0);
  };
  const tick = () => {
    if (window.document.querySelector(selector) && left-- > 0) {
      timer = setTimeout(tick, INTERVAL_MS);
      return;
    }
    settle();
  };
  timer = setTimeout(tick, 0);
  return () => clearTimeout(timer);
}
