// ログイン後に戻るページの扱い。外部のサイトへ飛ばされないよう、同じサイトのパスだけを受け付ける。

const NEXT_KEY = 'gaapp.auth.next';

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** next に使えるパス（basePath を除いた、/ で始まる同じサイトのパス）だけを返す。だめなら '/' */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/';
  // //example や /\example はブラウザが別のホストとして扱うので拒否する。制御文字も拒否する
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || hasControlChar(next)) {
    return '/';
  }
  // ログインの画面そのものには戻さない（ループを防ぐ）
  if (next.startsWith('/login') || next.startsWith('/auth/')) return '/';
  return next;
}

/** Google から戻るまでの間、戻り先を sessionStorage に置く（リダイレクト URL にはクエリを付けない） */
export function rememberNext(next: string): void {
  try {
    sessionStorage.setItem(NEXT_KEY, safeNextPath(next));
  } catch {
    // 保存できなくてもログインはできる（トップに戻る）
  }
}

export function takeRememberedNext(): string {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return safeNextPath(v);
  } catch {
    return '/';
  }
}

/** Supabase Auth のリダイレクト先（basePath 込み）。Supabase の Redirect URLs に登録しておく */
export function oauthCallbackUrl(origin: string, basePath: string): string {
  return `${origin}${basePath}/auth/callback/`;
}

const HOOK_REJECTION = '学校の Google アカウントでログインしてください';

/**
 * Supabase Auth がリダイレクト先に付けたエラーを、画面に出す文言に直す。
 * URL の文字列をそのまま表示しない（他人が作ったリンクで任意の文言を出させないため）。
 */
export function loginErrorMessage(params: URLSearchParams): string | null {
  const error = params.get('error');
  const description = params.get('error_description') ?? '';
  if (!error && !description) return null;
  if (description.includes(HOOK_REJECTION)) {
    return '学校の Google アカウントでログインしてください。個人のアカウントではログインできません。';
  }
  if (error === 'access_denied') return 'ログインがキャンセルされました。';
  return 'ログインに失敗しました。もう一度お試しください。';
}
