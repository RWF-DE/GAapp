// 未保存の入力の下書き（画面の設計 1.4・1.3 の (a)〜(c)、D-33。T09a）。
// ブラウザの戻る・iOS のタブの破棄・別のアプリへの切り替えは止められないので、入力を localStorage に写して開き直したときに
// 戻せるようにする。保存の代わりにはしない（保存に成功したら消す）。
// キー：`gaapp:draft:<user_id>:<year_id>:<画面>:<部屋・団体など>`。24 時間で捨てる。
// 読み書きは try/catch で包み、localStorage が使えなければ下書きなしで動く。
//
// 消す決まり（D-33）：
// - (a) 手動のログアウト：確かめた後に、その人の下書きをすべて消す（clearDraftsOf）。
// - (b) 401 などでの強制の signOut・ほかのタブのログアウト：消さない（キーに user_id があるので別の人には出ず、
//   同じ人がログインし直せば戻せる）。
// - (c) 前と違う user_id でログインした：自分以外の下書きを消す（clearDraftsExcept。(b) で残った前の人の下書きを共用 PC に残さない）。
// 画面（AuthProvider・UnsavedChangesGuard。段 C）は draftsOnSignOut・draftsOnSignIn を呼ぶ。

export const DRAFT_PREFIX = 'gaapp:draft:';
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAFT_WRITE_DELAY_MS = 500;

export interface DraftKey {
  userId: string;
  yearId: string;
  /** 画面（stock・request・requests・allocation など） */
  screen: string;
  /** 部屋・団体など（画面の中で下書きを分けるもの。なければ省く） */
  target?: string;
}

export interface Draft<T> {
  value: T;
  /** 書いた時刻（ミリ秒） */
  savedAt: number;
}

/** 使う Storage（テストでは差し替える）。使えなければ null */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export function browserStorage(): DraftStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(k: DraftKey): string {
  return `${DRAFT_PREFIX}${[k.userId, k.yearId, k.screen, ...(k.target ? [k.target] : [])].join(':')}`;
}

/** キーの user_id（下書きのキーでなければ null） */
export function draftUserOf(key: string): string | null {
  if (!key.startsWith(DRAFT_PREFIX)) return null;
  const rest = key.slice(DRAFT_PREFIX.length);
  const i = rest.indexOf(':');
  return i < 0 ? null : rest.slice(0, i);
}

function allDraftKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
  }
  return keys;
}

function removeKeys(storage: DraftStorage | null, pick: (key: string) => boolean): number {
  if (!storage) return 0;
  try {
    const keys = allDraftKeys(storage).filter(pick);
    for (const k of keys) storage.removeItem(k);
    return keys.length;
  } catch {
    return 0;
  }
}

/** 下書きを書く（入力のたびに呼ぶなら createDraftWriter で 500 ms まとめる）。書けなければ false */
export function saveDraft<T>(k: DraftKey, value: T, opts: { now?: number; storage?: DraftStorage | null } = {}): boolean {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return false;
  try {
    const d: Draft<T> = { value, savedAt: opts.now ?? Date.now() };
    storage.setItem(draftKey(k), JSON.stringify(d));
    return true;
  } catch {
    return false; // 容量の超過・プライベートブラウズなど
  }
}

/** 下書きを読む。24 時間を過ぎたもの・壊れたものは消して null */
export function loadDraft<T>(k: DraftKey, opts: { now?: number; storage?: DraftStorage | null } = {}): Draft<T> | null {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return null;
  const key = draftKey(k);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const d = JSON.parse(raw) as Partial<Draft<T>>;
    const now = opts.now ?? Date.now();
    if (typeof d?.savedAt !== 'number' || !('value' in d) || now - d.savedAt > DRAFT_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return { value: d.value as T, savedAt: d.savedAt };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // 使えない Storage
    }
    return null;
  }
}

/** 保存に成功したとき・「捨てる」を押したときに消す */
export function removeDraft(k: DraftKey, opts: { storage?: DraftStorage | null } = {}): void {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  try {
    storage?.removeItem(draftKey(k));
  } catch {
    // 使えない Storage
  }
}

/** その人の下書きをすべて消す（(a) 手動のログアウト） */
export function clearDraftsOf(userId: string, opts: { storage?: DraftStorage | null } = {}): number {
  return removeKeys(opts.storage === undefined ? browserStorage() : opts.storage, (key) => draftUserOf(key) === userId);
}

/** 自分以外の下書きを消す（(c) 前と違う user_id でログインした） */
export function clearDraftsExcept(userId: string, opts: { storage?: DraftStorage | null } = {}): number {
  return removeKeys(opts.storage === undefined ? browserStorage() : opts.storage, (key) => draftUserOf(key) !== userId);
}

/** 期限の切れた下書きを消す（アプリを開いたときに呼んでよい） */
export function pruneExpiredDrafts(opts: { now?: number; storage?: DraftStorage | null } = {}): number {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!storage) return 0;
  const now = opts.now ?? Date.now();
  return removeKeys(storage, (key) => {
    try {
      const d = JSON.parse(storage.getItem(key) ?? 'null') as Partial<Draft<unknown>> | null;
      return typeof d?.savedAt !== 'number' || now - d.savedAt > DRAFT_TTL_MS;
    } catch {
      return true;
    }
  });
}

/** ログアウトの種類：manual（ヘッダーのボタン）・forced（401 などでの強制の signOut・ほかのタブのログアウト） */
export type SignOutKind = 'manual' | 'forced';

/** ログアウトのときの下書きの扱い（(a) は消す、(b) は残す）。消した件数を返す */
export function draftsOnSignOut(kind: SignOutKind, userId: string | null, opts: { storage?: DraftStorage | null } = {}): number {
  if (kind !== 'manual' || !userId) return 0;
  return clearDraftsOf(userId, opts);
}

/** ログインしたとき（user_id が決まったとき）の下書きの扱い（(c) 自分以外を消す）。消した件数を返す */
export function draftsOnSignIn(userId: string, opts: { storage?: DraftStorage | null } = {}): number {
  return clearDraftsExcept(userId, opts);
}

/**
 * 入力のたびに呼ぶ書き手（500 ms まとめて書く）。画面を離れるとき・保存の直前は flush、保存に成功したら clear。
 *
 * @example
 * const writer = useMemo(() => createDraftWriter({ userId, yearId, screen: 'stock', target: roomId }), [userId, yearId, roomId]);
 * onChange={(v) => { setCounts(v); writer.write(v); }}
 * onSaved={() => writer.clear()}
 */
export function createDraftWriter<T>(k: DraftKey, opts: { delayMs?: number; storage?: DraftStorage | null; now?: () => number } = {}) {
  const delay = opts.delayMs ?? DRAFT_WRITE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) saveDraft(k, pending.value, { storage: opts.storage, now: opts.now?.() });
    pending = null;
  };
  return {
    write(value: T) {
      pending = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    /** 書いていない分を捨て、下書きも消す（保存に成功したとき・「捨てる」） */
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      removeDraft(k, { storage: opts.storage });
    },
    /** 書いていない分を捨てる（下書きは残す） */
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
