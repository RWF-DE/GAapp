import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraftsExcept,
  clearDraftsOf,
  createDraftWriter,
  DRAFT_TTL_MS,
  draftKey,
  draftsOnSignIn,
  draftsOnSignOut,
  draftUserOf,
  loadDraft,
  pruneExpiredDrafts,
  removeDraft,
  saveDraft,
  type DraftStorage,
} from './drafts';

/** Map で持つ Storage（localStorage の代わり） */
function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** どの操作も例外を投げる Storage（プライベートブラウズ・ブロックされた保存領域） */
const brokenStorage: DraftStorage = {
  get length(): number {
    throw new Error('blocked');
  },
  key: () => {
    throw new Error('blocked');
  },
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const Y = 'yyyyyyyy-yyyy-4yyy-8yyy-yyyyyyyyyyyy';
const keyA = { userId: A, yearId: Y, screen: 'stock', target: 'room-1' };
const keyA2 = { userId: A, yearId: Y, screen: 'request', target: 'group-1' };
const keyB = { userId: B, yearId: Y, screen: 'stock', target: 'room-1' };

afterEach(() => {
  vi.useRealTimers();
});

describe('キーと読み書き', () => {
  it('キーは gaapp:draft:<user>:<year>:<画面>:<対象>', () => {
    expect(draftKey(keyA)).toBe(`gaapp:draft:${A}:${Y}:stock:room-1`);
    expect(draftKey({ userId: A, yearId: Y, screen: 'allocation' })).toBe(`gaapp:draft:${A}:${Y}:allocation`);
    expect(draftUserOf(draftKey(keyA))).toBe(A);
    expect(draftUserOf('gaapp:year:x')).toBeNull();
  });

  it('書いて読める（書いた時刻つき）', () => {
    const storage = memoryStorage();
    expect(saveDraft(keyA, { desk: 3 }, { storage, now: 1000 })).toBe(true);
    expect(loadDraft(keyA, { storage, now: 2000 })).toEqual({ value: { desk: 3 }, savedAt: 1000 });
    removeDraft(keyA, { storage });
    expect(loadDraft(keyA, { storage })).toBeNull();
  });

  it('24 時間を過ぎたら捨てる', () => {
    const storage = memoryStorage();
    saveDraft(keyA, 1, { storage, now: 0 });
    expect(loadDraft(keyA, { storage, now: DRAFT_TTL_MS })).not.toBeNull();
    expect(loadDraft(keyA, { storage, now: DRAFT_TTL_MS + 1 })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('壊れた下書きは消して null', () => {
    const storage = memoryStorage();
    storage.setItem(draftKey(keyA), '{oops');
    expect(loadDraft(keyA, { storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('期限切れをまとめて消す', () => {
    const storage = memoryStorage();
    saveDraft(keyA, 1, { storage, now: 0 });
    saveDraft(keyA2, 2, { storage, now: DRAFT_TTL_MS });
    storage.setItem('other:key', 'x');
    expect(pruneExpiredDrafts({ storage, now: DRAFT_TTL_MS + 1 })).toBe(1);
    expect([...storage.map.keys()].sort()).toEqual([draftKey(keyA2), 'other:key'].sort());
  });

  it('localStorage が使えなければ下書きなしで動く（例外を出さない）', () => {
    expect(saveDraft(keyA, 1, { storage: brokenStorage })).toBe(false);
    expect(loadDraft(keyA, { storage: brokenStorage })).toBeNull();
    expect(() => removeDraft(keyA, { storage: brokenStorage })).not.toThrow();
    expect(clearDraftsOf(A, { storage: brokenStorage })).toBe(0);
    expect(draftsOnSignIn(A, { storage: brokenStorage })).toBe(0);
    expect(saveDraft(keyA, 1, { storage: null })).toBe(false);
    // node の環境には window がない
    expect(saveDraft(keyA, 1)).toBe(false);
  });
});

describe('ログアウトとログインで消すもの（D-33 の (a)〜(c)）', () => {
  const setup = () => {
    const storage = memoryStorage();
    saveDraft(keyA, 1, { storage });
    saveDraft(keyA2, 2, { storage });
    saveDraft(keyB, 3, { storage });
    storage.setItem(`gaapp:year:${A}`, Y); // 選んだ年度（sessionStorage のキーと同じ形のもの）は下書きの関数では触らない
    return storage;
  };

  it('(a) 手動のログアウトで、その人の下書きがすべて消える（ほかの人の分は残る）', () => {
    const storage = setup();
    expect(draftsOnSignOut('manual', A, { storage })).toBe(2);
    expect(loadDraft(keyA, { storage })).toBeNull();
    expect(loadDraft(keyA2, { storage })).toBeNull();
    expect(loadDraft(keyB, { storage })?.value).toBe(3);
    expect(storage.getItem(`gaapp:year:${A}`)).toBe(Y);
  });

  it('(b) 強制の signOut（401・ほかのタブのログアウト）では残る', () => {
    const storage = setup();
    expect(draftsOnSignOut('forced', A, { storage })).toBe(0);
    expect(loadDraft(keyA, { storage })?.value).toBe(1);
    expect(loadDraft(keyA2, { storage })?.value).toBe(2);
    // 同じ人がログインし直せば戻せる
    expect(draftsOnSignIn(A, { storage })).toBe(1);
    expect(loadDraft(keyA, { storage })?.value).toBe(1);
  });

  it('(c) 別の利用者でログインすると、他人の下書きが消える', () => {
    const storage = setup();
    expect(draftsOnSignIn(B, { storage })).toBe(2);
    expect(loadDraft(keyA, { storage })).toBeNull();
    expect(loadDraft(keyA2, { storage })).toBeNull();
    expect(loadDraft(keyB, { storage })?.value).toBe(3);
  });

  it('clearDraftsOf・clearDraftsExcept は下書きのキーだけを見る', () => {
    const storage = setup();
    storage.setItem('sb-127-auth-token', 'session');
    expect(clearDraftsExcept(A, { storage })).toBe(1);
    expect(storage.getItem('sb-127-auth-token')).toBe('session');
    expect(clearDraftsOf(A, { storage })).toBe(2);
    expect(storage.getItem('sb-127-auth-token')).toBe('session');
  });
});

describe('createDraftWriter', () => {
  it('500 ms まとめて書く・flush ですぐ書く・clear で消す', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const w = createDraftWriter<number>(keyA, { storage, now: () => 42 });
    w.write(1);
    w.write(2);
    vi.advanceTimersByTime(499);
    expect(loadDraft(keyA, { storage })).toBeNull();
    vi.advanceTimersByTime(1);
    expect(loadDraft(keyA, { storage, now: 100 })).toEqual({ value: 2, savedAt: 42 });
    w.write(3);
    w.flush();
    expect(loadDraft(keyA, { storage, now: 100 })?.value).toBe(3);
    w.write(4);
    w.clear();
    vi.advanceTimersByTime(1000);
    expect(loadDraft(keyA, { storage })).toBeNull();
  });

  it('cancel は書いていない分だけを捨てる', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const w = createDraftWriter<number>(keyA, { storage, now: () => 0 });
    w.write(1);
    w.flush();
    w.write(2);
    w.cancel();
    vi.advanceTimersByTime(1000);
    expect(loadDraft(keyA, { storage, now: 0 })?.value).toBe(1);
  });
});
