// @vitest-environment jsdom
// 提出状況（/documents）の画面（04「提出状況 /documents（PC）」「提出物」の段ごとの出し分け・状態の印・ファイルの扱い・書き込みの決まり・
// エラーの文言、notes/T19.md「パート B・C の約束」6・15。T19）。
// - 表（団体 × 提出物の並び・印・「—」・ファイルの数・読み上げの名前）、絞り込み（件数・薄く・0 件）、目立たせと絞り込みの解除、狭い幅の一覧、
//   空の表示、CSV、開いたときの片付け（その年度で1回）
// - 段：部門長以上（全部）・総務部門員（状況だけ。ファイル・CSV・操作・設定なし）・閲覧のみ（ページの守りが権限なし）
// - セルのシート：経過（した人の表示名）・理由とメモ・ファイル（開く・保存・外す・代理で足す）・操作（承認・差し戻し・理由の書き直し・紙での
//   承認・代わりに提出・取り消し）、(B1)（conflict で読み直した版に進める・同じ操作の重なりの not_editable・分からない後のもう一度）、下書きと
//   離れる前の確かめ、閉じると URL から外す
// - 提出物の設定：一覧、登録（画面が作った id・締切の +09:00）・送る前の確かめ・同じ題名・編集の変更なし・conflict・対象を狭めたときの数、
//   削除（件数の確かめ・片付け）、前年度から写す
// - 終了した年度：帯、書くためのものを出さない（開く・保存・CSV はできる）、管理者の年度のファイルの削除と片付け
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts の from・rpc に storage.from('documents') を足したもの）で、DB のビュー・RPC・
// RLS の直接の書き込み・Storage API の動き（版・状態・題名の一意・予約した path・409）を小さくまねる。立場は useAuth の差し替え、URL は
// next/navigation の差し替え（replace で検索のパラメータを置き換えて描き直す）、時計は Date だけを止める。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPage from '@/app/(app)/documents/page';
import { AppLink } from '@/components/common/app-link';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { DOCUMENT_CONFLICT_MESSAGE, DOCUMENT_NOT_EDITABLE_MESSAGES, STORAGE_SIGN_DENIED_MESSAGE } from '@/lib/errors';
import { DOCUMENT_FORM_MESSAGES } from '@/lib/schemas/documents';
import { REVIEW_NOTE_MESSAGES } from '@/lib/schemas/document-fields';
import { queryKeys } from '@/lib/query';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createFakeSupabase, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { LEAVE_MESSAGES } from '@/lib/unsaved-changes';
import { COPY_EXISTS_TEXT } from './doc-copy-dialog';
import { DOC_CONFLICT_NOTICE, narrowingText } from './doc-form-dialog';
import { DOCUMENT_TITLE_TAKEN_MESSAGE } from './doc-write';
import { DELETE_FILES_HELP, leftoverText } from './delete-year-files';
import { CLOSED_DOCUMENTS, DocumentsScreen, EMPTY_DOCUMENTS, EMPTY_DOCUMENTS_HINT, FILTER_EMPTY_TEXT, NO_TARGETS_TEXT } from './documents-screen';
import { DELETE_COUNT_FAILED_TEXT, DELETE_COUNTING_TEXT, deleteConfirmText } from './documents-settings';
import { PROXY_CONFIRM_TEXT, PROXY_SUBMIT_UNKNOWN, STAFF_FILES_NOTE, UNKNOWN_ACTOR } from './documents-sheet';
import { fileWindow } from './file-open';
import { NOTE_VISIBLE_HELP, RETURN_REASON_HELP } from './review-dialogs';
import { SUBMISSION_DONE_BEFORE } from './submission-write';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    membership: { status: 'idle' } as MembershipState,
    client: null as unknown,
    params: new URLSearchParams(),
    userId: 'u-admin',
    listeners,
    push: null as unknown as (href: string) => void,
    replace: null as unknown as (href: string) => void,
    reloadMembership: null as unknown as () => void,
    /** URL の検索のパラメータを置き換えて、読んでいる部品を描き直す（next/navigation の router.replace の代わり） */
    setUrl(href: string) {
      const q = href.indexOf('?');
      state.params = new URLSearchParams(q < 0 ? '' : href.slice(q + 1));
      for (const l of listeners) l();
    },
  };
  return state;
});

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: h.reloadMembership,
    setYear: vi.fn(),
    reauthenticate: async () => false,
    isRefreshing: false,
  }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (l: () => void) => {
    h.listeners.add(l);
    return () => h.listeners.delete(l);
  };
  return {
    useRouter: () => ({ push: (href: string) => h.push(href), replace: (href: string) => h.replace(href), refresh: vi.fn() }),
    usePathname: () => '/documents',
    useSearchParams: () => useSyncExternalStore(subscribe, () => h.params, () => h.params),
  };
});
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown> & { href: string; children: React.ReactNode }) => {
    const { href, children, onNavigate, prefetch, ...rest } = props;
    void prefetch;
    const onClick = (e: React.MouseEvent) => {
      e.preventDefault();
      let prevented = false;
      (onNavigate as ((ev: { preventDefault: () => void }) => void) | undefined)?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) h.push(href);
    };
    return (
      <a href={href} {...rest} onClick={onClick}>
        {children}
      </a>
    );
  },
}));
const download = vi.hoisted(() => ({ files: [] as { data: string; name: string; mime: string }[] }));
vi.mock('@/lib/download', async (orig) => ({
  ...(await orig<typeof import('@/lib/download')>()),
  downloadFile: (data: string, name: string, mime: string) => download.files.push({ data, name, mime }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

// ---------------------------------------------------------------- データ（DB と Storage の小さなまね）

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const PREV = uuid(2);
/** 画面を開いた時刻：2026-10-06（火）12:00（Asia/Tokyo） */
const NOW = '2026-10-06T03:00:00Z';
const U_ADMIN = 'u-admin';
const U_REP = 'u-rep';

interface DbGroup {
  id: string;
  name: string;
  display_name: string | null;
  category: 'stall' | 'department' | 'company' | 'rest_area';
  is_food: boolean;
  sort_order: number;
}
interface DbDoc {
  id: string;
  year_id: string;
  title: string;
  description: string | null;
  deadline: string;
  target_categories: DbGroup['category'][];
  food_only: boolean;
  submit_url: string | null;
  files_deleted_at: string | null;
  updated_at: string;
}
type Status = 'not_submitted' | 'submitted' | 'returned' | 'approved';
interface DbSub {
  document_id: string;
  group_id: string;
  status: Status;
  submitted_at: string | null;
  submitted_by: string | null;
  proxy: boolean;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  updated_at: string;
}
interface DbFile {
  id: string;
  document_id: string;
  group_id: string;
  object_path: string;
  content_type: string;
  size: number;
  created_at: string;
}

const G1: DbGroup = { id: uuid(11), name: '模擬店01', display_name: null, category: 'stall', is_food: true, sort_order: 1 };
const G2: DbGroup = { id: uuid(12), name: '模擬店02', display_name: null, category: 'stall', is_food: false, sort_order: 2 };
const G3: DbGroup = { id: uuid(13), name: '学科A', display_name: null, category: 'department', is_food: false, sort_order: 10 };
const G4: DbGroup = { id: uuid(14), name: '企業A', display_name: null, category: 'company', is_food: false, sort_order: 20 };
// 並び順が同じなら名前の順（A模擬店 は 模擬店02 より前）
const G5: DbGroup = { id: uuid(15), name: 'A模擬店', display_name: null, category: 'stall', is_food: false, sort_order: 2 };
const D_PLAN = uuid(101); // 出店計画書（締切 10/5。過ぎている。模擬店・部門）
const D_FOOD = uuid(102); // 食品の届け（締切 10/8。模擬店の飲食だけ）
const D_NOTE = uuid(103); // 保健所への報告（締切 10/20。4 区分。ファイルが要らない）

const V0 = '2026-10-01T00:00:00.123456+00:00';
let clock = 0;
const nextAt = () => `2026-10-06T03:00:${String(++clock).padStart(2, '0')}.000000+00:00`;
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const pathOf = (f: Pick<DbFile, 'id' | 'document_id' | 'group_id' | 'content_type'>) => `${Y}/${f.group_id}/${f.document_id}/${f.id}.${EXT[f.content_type]}`;
const dbFile = (id: string, document_id: string, group_id: string, over: Partial<DbFile> = {}): DbFile => {
  const f = { id, document_id, group_id, content_type: 'application/pdf', size: 1_258_291, created_at: '2026-10-05T08:00:00+00:00', ...over };
  return { object_path: pathOf(f), ...f };
};
const sub = (document_id: string, group_id: string, over: Partial<DbSub>): DbSub => ({
  document_id,
  group_id,
  status: 'not_submitted',
  submitted_at: null,
  submitted_by: null,
  proxy: false,
  reviewed_at: null,
  reviewed_by: null,
  review_note: null,
  updated_at: V0,
  ...over,
});

const db = {
  groups: [] as DbGroup[],
  docs: [] as DbDoc[],
  subs: [] as DbSub[],
  files: [] as DbFile[],
  objects: new Map<string, number>(),
  profiles: [] as { user_id: string; display_name: string }[],
  previous: [] as Record<string, unknown>[],
};
let yearStatus: YearStatus = 'requesting';

function seed() {
  db.groups = [G1, G2, G3, G4, G5];
  db.docs = [
    { id: D_PLAN, year_id: Y, title: '出店計画書', description: null, deadline: '2026-10-05T08:00:00+00:00', target_categories: ['stall', 'department'], food_only: false, submit_url: 'https://drive.google.com/drive/folders/plan', files_deleted_at: null, updated_at: V0 },
    { id: D_FOOD, year_id: Y, title: '食品の届け', description: null, deadline: '2026-10-08T08:00:00+00:00', target_categories: ['stall'], food_only: true, submit_url: null, files_deleted_at: null, updated_at: V0 },
    { id: D_NOTE, year_id: Y, title: '保健所への報告', description: null, deadline: '2026-10-20T08:00:00+00:00', target_categories: ['stall', 'department', 'company', 'rest_area'], food_only: false, submit_url: null, files_deleted_at: null, updated_at: V0 },
  ];
  db.subs = [
    sub(D_PLAN, G1.id, { status: 'approved', submitted_at: '2026-10-03T00:00:00+00:00', submitted_by: U_REP, reviewed_at: '2026-10-04T00:00:00+00:00', reviewed_by: U_ADMIN }),
    // 締切の後に提出（前に差し戻した理由が残っている）
    sub(D_PLAN, G2.id, {
      status: 'submitted',
      submitted_at: '2026-10-06T00:00:00+00:00',
      submitted_by: U_REP,
      reviewed_at: '2026-10-05T00:00:00+00:00',
      reviewed_by: U_ADMIN,
      review_note: '印鑑がありません\n押してから出し直してください',
    }),
    sub(D_PLAN, G3.id, { status: 'returned', submitted_at: '2026-10-04T00:00:00+00:00', submitted_by: U_REP, reviewed_at: '2026-10-05T00:00:00+00:00', reviewed_by: U_ADMIN, review_note: '2ページ目がありません' }),
    sub(D_FOOD, G1.id, { status: 'submitted', submitted_at: '2026-10-05T00:00:00+00:00', submitted_by: U_ADMIN, proxy: true }),
    // 紙で受け取った承認（承認した人は読めない）
    sub(D_NOTE, G4.id, { status: 'approved', reviewed_at: '2026-10-02T00:00:00+00:00', reviewed_by: 'u-gone', review_note: '10/2 に紙で受け取りました' }),
  ];
  db.files = [
    dbFile(uuid(301), D_PLAN, G1.id),
    dbFile(uuid(302), D_PLAN, G2.id, { content_type: 'image/jpeg', size: 845_000, created_at: '2026-10-05T09:00:00+00:00' }),
    dbFile(uuid(303), D_PLAN, G2.id, { created_at: '2026-10-05T10:00:00+00:00' }),
    dbFile(uuid(304), D_PLAN, G3.id),
    dbFile(uuid(305), D_FOOD, G1.id),
  ];
  db.objects = new Map(db.files.map((f) => [f.object_path, f.size]));
  // どの提出にも属さない物（開いたときの片付けで消える）
  db.objects.set(`${Y}/${G1.id}/${D_PLAN}/${uuid(399)}.pdf`, 500);
  db.profiles = [
    { user_id: U_ADMIN, display_name: '管理者テスト' },
    { user_id: U_REP, display_name: '店長テスト' },
  ];
  db.previous = [
    { document_id: uuid(501), title: '出店計画書', description: null, deadline: '2025-10-06T08:00:00+00:00', new_deadline: '2026-10-05T08:00:00+00:00', target_categories: ['stall'], food_only: false, requires_file: true, exists_in_year: true },
    { document_id: uuid(502), title: '火気の使用届', description: '様式は共有フォルダ', deadline: '2025-10-08T08:00:00+00:00', new_deadline: '2026-10-07T08:00:00+00:00', target_categories: ['stall'], food_only: true, requires_file: true, exists_in_year: false },
    { document_id: uuid(503), title: '展示物の一覧', description: null, deadline: '2025-10-10T08:00:00+00:00', new_deadline: '2026-10-09T08:00:00+00:00', target_categories: ['department'], food_only: false, requires_file: false, exists_in_year: false },
  ];
}

const isTarget = (d: DbDoc, g: DbGroup) => d.target_categories.includes(g.category) && (!d.food_only || g.is_food);
const findSub = (d: unknown, g: unknown) => db.subs.find((s) => s.document_id === d && s.group_id === g);
/** v_document_status（提出物 × 対象の団体 × 提出。行がなければ未提出） */
function statusRows() {
  const out: Record<string, unknown>[] = [];
  for (const d of db.docs) {
    for (const g of db.groups) {
      if (!isTarget(d, g)) continue;
      const s = findSub(d.id, g.id);
      out.push({
        document_id: d.id,
        group_id: g.id,
        status: s?.status ?? 'not_submitted',
        submitted_at: s?.submitted_at ?? null,
        submitted_by: s?.submitted_by ?? null,
        proxy: s?.proxy ?? false,
        late: !!s?.submitted_at && Date.parse(s.submitted_at) > Date.parse(d.deadline),
        reviewed_at: s?.reviewed_at ?? null,
        reviewed_by: s?.reviewed_by ?? null,
        review_note: s?.review_note ?? null,
        updated_at: s?.updated_at ?? null,
      });
    }
  }
  return out;
}
const fileRows = () => db.files.map((f) => ({ ...f, uploaded: db.objects.has(f.object_path), stored_size: db.objects.get(f.object_path) ?? null }));
const sameVersion = (a: string | null | undefined, b: string | null | undefined) =>
  a == null || b == null ? (a ?? null) === (b ?? null) : Date.parse(a) === Date.parse(b);
const isOpen = (s: Status) => s === 'not_submitted' || s === 'returned';

const p0001 = (message: string, details: unknown = null): FakeResult => ({
  error: { code: 'P0001', message, details: details === null ? null : JSON.stringify(details), hint: null },
  status: 400,
});
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
const storageError = (statusCode: string, code: string) => ({ __isStorageError: true, name: 'StorageApiError', message: code, status: 400, statusCode, code });
const submissionRow = (s: DbSub) => ({ ...s, year_id: Y, created_at: V0 });

/** 提出の行（なければ作る。書くときだけ） */
function ensureSub(d: string, g: string): DbSub {
  let s = findSub(d, g);
  if (!s) {
    s = sub(d, g, { updated_at: '' });
    s.updated_at = null as unknown as string;
    db.subs.push(s);
  }
  return s;
}
const versionOf = (s: DbSub | undefined) => s?.updated_at ?? null;

function rpc(name: string, a: Record<string, unknown>): FakeResult {
  const readOnly = ['document_orphan_paths', 'document_storage_usage', 'previous_year_documents', 'delete_year_document_files'];
  if (yearStatus === 'closed' && !readOnly.includes(name)) return p0001('invalid_state', { status: 'closed' });
  const doc = db.docs.find((d) => d.id === a.p_document_id);
  const group = db.groups.find((g) => g.id === a.p_group_id);
  const targetOk = !!doc && !!group && isTarget(doc, group);
  switch (name) {
    case 'approve_document': {
      if (!targetOk) return p0001('not_found');
      const cur = findSub(doc.id, group.id);
      const st = cur?.status ?? 'not_submitted';
      if (st === 'approved') return p0001('invalid_state', { status: st, reason: 'not_editable' });
      if (isOpen(st) && a.p_note == null) return p0001('invalid_input', { field: 'note', reason: 'required' });
      if (!sameVersion(versionOf(cur), a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: doc.id, group_id: group.id });
      const s = ensureSub(doc.id, group.id);
      const paper = isOpen(st);
      Object.assign(s, {
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: U_ADMIN,
        review_note: a.p_note ?? null,
        ...(paper ? { submitted_at: null, submitted_by: null, proxy: false } : {}),
        updated_at: nextAt(),
      });
      return { data: submissionRow(s) };
    }
    case 'return_document': {
      if (!targetOk) return p0001('not_found');
      const cur = findSub(doc.id, group.id);
      const st = cur?.status ?? 'not_submitted';
      if (st === 'not_submitted') return p0001('invalid_state', { status: st, reason: 'not_editable' });
      if (!sameVersion(versionOf(cur), a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: doc.id, group_id: group.id });
      Object.assign(cur!, { status: 'returned', reviewed_at: new Date().toISOString(), reviewed_by: U_ADMIN, review_note: a.p_note, updated_at: nextAt() });
      return { data: submissionRow(cur!) };
    }
    case 'submit_document': {
      if (!targetOk) return p0001('not_found');
      const cur = findSub(doc.id, group.id);
      const st = cur?.status ?? 'not_submitted';
      if (!isOpen(st)) return p0001('invalid_state', { status: st, reason: 'not_editable' });
      const mine = db.files.filter((f) => f.document_id === doc.id && f.group_id === group.id);
      if (mine.some((f) => !db.objects.has(f.object_path))) return p0001('invalid_state', { status: st, reason: 'not_uploaded' });
      if (!sameVersion(versionOf(cur), a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: doc.id, group_id: group.id });
      const s = ensureSub(doc.id, group.id);
      Object.assign(s, { status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: h.userId, proxy: true, updated_at: nextAt() });
      return { data: submissionRow(s) };
    }
    case 'withdraw_document': {
      if (!targetOk) return p0001('not_found');
      const cur = findSub(doc.id, group.id);
      if (cur?.status !== 'submitted') return p0001('invalid_state', { status: cur?.status ?? 'not_submitted', reason: 'not_editable' });
      if (!sameVersion(versionOf(cur), a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: doc.id, group_id: group.id });
      Object.assign(cur, { status: 'not_submitted', submitted_at: null, submitted_by: null, proxy: false, updated_at: nextAt() });
      return { data: submissionRow(cur) };
    }
    case 'reserve_document_file': {
      if (!targetOk) return p0001('not_found');
      const same = db.files.find((f) => f.id === a.p_file_id);
      if (same) return { data: { ...same, year_id: Y, created_by: h.userId, updated_at: same.created_at } };
      const cur = findSub(doc.id, group.id);
      if ((cur?.status ?? 'not_submitted') === 'approved') return p0001('invalid_state', { status: 'approved', reason: 'not_editable' });
      const f = dbFile(a.p_file_id as string, doc.id, group.id, { content_type: a.p_content_type as string, size: a.p_size as number, created_at: nextAt() });
      db.files.push(f);
      ensureSub(doc.id, group.id).updated_at = nextAt();
      return { data: { ...f, year_id: Y, created_by: h.userId, updated_at: f.created_at } };
    }
    case 'discard_document_file': {
      const f = db.files.find((x) => x.id === a.p_file_id);
      if (!f) return p0001('forbidden');
      const s = findSub(f.document_id, f.group_id);
      if (db.objects.has(f.object_path) && s?.status === 'approved') return p0001('invalid_state', { status: 'approved', reason: 'not_editable' });
      db.files = db.files.filter((x) => x !== f);
      if (s) s.updated_at = nextAt();
      return { data: f.object_path };
    }
    case 'document_orphan_paths':
      return { data: [...db.objects.keys()].filter((p) => p.startsWith(`${Y}/`) && !db.files.some((f) => f.object_path === p)) };
    case 'document_storage_usage': {
      const bytes = [...db.objects.values()].reduce((x, y) => x + y, 0);
      const orphans = [...db.objects.keys()].filter((p) => !db.files.some((f) => f.object_path === p)).length;
      return {
        data: [{ bucket_bytes: bytes, limit_bytes: 943718400, file_count: db.files.length, file_bytes: db.files.reduce((x, f) => x + f.size, 0), orphan_count: orphans }],
      };
    }
    case 'previous_year_documents':
      // exists_in_year は、今の年度に同じ題名の提出物があるか（写した後に読み直すと真になる）
      return { data: db.previous.map((p) => ({ ...p, exists_in_year: db.docs.some((d) => d.title === p.title) })) };
    case 'copy_previous_documents': {
      const ids = a.p_document_ids as string[];
      const out: DbDoc[] = [];
      for (const id of ids) {
        const p = db.previous.find((x) => x.document_id === id)!;
        if (db.docs.some((d) => d.title === p.title)) continue;
        const row: DbDoc = {
          id: uuid(600 + out.length),
          year_id: Y,
          title: p.title as string,
          description: (p.description as string | null) ?? null,
          deadline: p.new_deadline as string,
          target_categories: p.target_categories as DbDoc['target_categories'],
          food_only: p.food_only as boolean,
          submit_url: null,
          files_deleted_at: null,
          updated_at: nextAt(),
        };
        db.docs.push(row);
        out.push(row);
      }
      return { data: out };
    }
    case 'delete_year_document_files': {
      if (yearStatus !== 'closed') return p0001('invalid_state', { status: yearStatus, reason: 'not_closed' });
      const n = db.files.length;
      db.files = [];
      const at = new Date().toISOString();
      for (const d of db.docs) d.files_deleted_at ??= at;
      return { data: n };
    }
    default:
      return { error: { code: '42883', message: `知らない RPC：${name}` }, status: 404 };
  }
}

const DOC_COLUMNS = ['id', 'title', 'description', 'deadline', 'target_categories', 'food_only', 'submit_url', 'files_deleted_at', 'updated_at'] as const;
const docOut = (d: DbDoc) => Object.fromEntries(DOC_COLUMNS.map((k) => [k, d[k]]));
const titleTaken = (): FakeResult => ({
  error: { code: '23505', message: 'duplicate key value violates unique constraint "documents_year_id_title_key"', details: null, hint: null },
  status: 409,
});
const opOf = (call: FakeCall, op: string) => call.ops.find((o) => o.op === op);
const eqOf = (call: FakeCall) =>
  Object.fromEntries([
    ...call.ops.filter((o) => o.op === 'eq').map((o) => [o.args[0] as string, o.args[1]] as const),
    ...call.ops.filter((o) => o.op === 'match').flatMap((o) => Object.entries(o.args[0] as Record<string, unknown>)),
  ]);

/** 提出物（RLS の直接の書き込み：部門長以上で終了でない。題名は年度の中で一意） */
function documentsTable(call: FakeCall): FakeResult {
  const eq = eqOf(call);
  const insert = opOf(call, 'insert');
  const update = opOf(call, 'update');
  const del = opOf(call, 'delete');
  const writable = yearStatus !== 'closed';
  if (insert) {
    if (!writable) return { error: { code: '42501', message: 'new row violates row-level security policy for table "documents"' }, status: 403 };
    const v = insert.args[0] as DbDoc;
    if (db.docs.some((d) => d.id === v.id)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint "documents_pkey"' }, status: 409 };
    if (db.docs.some((d) => d.title === v.title)) return titleTaken();
    const row: DbDoc = { ...v, files_deleted_at: null, updated_at: nextAt() };
    db.docs.push(row);
    return { data: docOut(row) };
  }
  if (update) {
    const d = db.docs.find((x) => x.id === eq.id && x.updated_at === eq.updated_at);
    if (!d || !writable) return { data: null };
    const v = update.args[0] as Partial<DbDoc>;
    if (v.title && db.docs.some((x) => x.id !== d.id && x.title === v.title)) return titleTaken();
    Object.assign(d, v, { updated_at: nextAt() });
    return { data: { ...d } };
  }
  if (del) {
    const d = db.docs.find((x) => x.id === eq.id && x.updated_at === eq.updated_at);
    if (!d || !writable) return { data: [] };
    db.docs = db.docs.filter((x) => x !== d);
    db.subs = db.subs.filter((s) => s.document_id !== d.id);
    db.files = db.files.filter((f) => f.document_id !== d.id);
    return { data: [{ ...d }] };
  }
  if (eq.id) {
    const d = db.docs.find((x) => x.id === eq.id);
    return { data: d ? docOut(d) : null };
  }
  return { data: [...db.docs].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)).map(docOut) };
}

let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
  if (call.table.startsWith('rpc:')) return rpc(call.table.slice(4), (call.ops[0]!.args[0] ?? {}) as Record<string, unknown>);
  if (call.table === 'years') return { data: yearRow(yearStatus) };
  const eq = eqOf(call);
  switch (call.table) {
    case 'documents':
      return documentsTable(call);
    case 'groups':
      return { data: db.groups.map((g) => ({ ...g })) };
    case 'profiles':
      return { data: db.profiles };
    case 'document_submissions': {
      // 表そのもの（v_document_status と違い、今の対象から外れた団体の行も返す）
      const neq = call.ops.filter((o) => o.op === 'neq').map((o) => o.args as [keyof DbSub, unknown]);
      const rows = db.subs.filter((s) => (!eq.document_id || s.document_id === eq.document_id) && neq.every(([k, v]) => s[k] !== v));
      return { data: rows.map((s) => ({ group_id: s.group_id, status: s.status })) };
    }
    case 'v_document_status': {
      const rows = statusRows();
      if (eq.document_id) return { data: rows.find((r) => r.document_id === eq.document_id && r.group_id === eq.group_id) ?? null };
      return { data: rows };
    }
    case 'v_document_files': {
      if (role() === 'staff') return { data: [] };
      const rows = fileRows();
      if (eq.id) return { data: rows.find((r) => r.id === eq.id) ?? null };
      return { data: rows };
    }
  }
  return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
}

interface StorageCall {
  op: 'upload' | 'remove' | 'createSignedUrl';
  args: unknown[];
}
let storageCalls: StorageCall[] = [];
let storageOverride: ((c: StorageCall) => Promise<unknown> | unknown | undefined) | null = null;

async function storageOp(op: StorageCall['op'], args: unknown[]): Promise<unknown> {
  const c = { op, args };
  storageCalls.push(c);
  const o = storageOverride?.(c);
  if (o !== undefined) return o;
  if (op === 'upload') {
    const [path, blob] = args as [string, Blob];
    if (db.objects.has(path)) return { data: null, error: storageError('409', 'KeyAlreadyExists') };
    const f = db.files.find((x) => x.object_path === path);
    if (!f || yearStatus === 'closed' || blob.size > f.size) return { data: null, error: storageError('403', 'AccessDenied') };
    db.objects.set(path, blob.size);
    return { data: { path }, error: null };
  }
  if (op === 'remove') {
    const paths = args[0] as string[];
    const gone = paths.filter((p) => db.objects.has(p) && !db.files.some((f) => f.object_path === p));
    for (const p of gone) db.objects.delete(p);
    return { data: gone.map((name) => ({ name })), error: null };
  }
  const [path, , opts] = args as [string, number, { download?: string } | undefined];
  if (!db.objects.has(path)) return { data: null, error: storageError('404', 'not_found') };
  return { data: { signedUrl: `https://storage.test/sign/${path}?token=t${opts?.download ? `&download=${encodeURIComponent(opts.download)}` : ''}` }, error: null };
}

function makeClient(): AppSupabaseClient {
  const f = createFakeSupabase(handler);
  issued = f.issued;
  const inner = f.client as unknown as { from(t: string): unknown; rpc(n: string, a: unknown): unknown };
  return {
    from: (t: string) => inner.from(t),
    rpc: (name: string, args: unknown) => inner.rpc(name, args),
    storage: {
      from: (bucket: string) => {
        if (bucket !== 'documents') throw new Error(`bucket：${bucket}`);
        return {
          upload: (...a: unknown[]) => storageOp('upload', a),
          remove: (...a: unknown[]) => storageOp('remove', a),
          createSignedUrl: (...a: unknown[]) => storageOp('createSignedUrl', a),
        };
      },
    },
  } as unknown as AppSupabaseClient;
}

let prevYear: string | null = PREV;
const yearRow = (s: YearStatus): YearRow => ({
  id: Y,
  label: 'R8',
  status: s,
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: prevYear,
  updated_at: 't',
});

let currentRole: AppRole | null = 'admin';
const role = () => currentRole;

function member(r: AppRole | null, s: YearStatus, groups: GroupSummary[]): Membership {
  const year = { id: Y, label: 'R8', status: s, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role: r, groups, years: [year], latestYear: year, adminOfOpenYear: r === 'admin' && s !== 'closed' };
}

function Probe() {
  return (
    <AppLink href="/notices" data-testid="probe-nav">
      お知らせ一覧
    </AppLink>
  );
}

function renderScreen(opts: { role?: AppRole | null; status?: YearStatus; search?: string; groups?: GroupSummary[]; page?: boolean; qc?: QueryClient } = {}) {
  yearStatus = opts.status ?? 'requesting';
  currentRole = opts.role === undefined ? 'admin' : opts.role;
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(currentRole, yearStatus, opts.groups ?? []) };
  const qc = opts.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(yearStatus));
  const view = render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider>
        <Probe />
        {opts.page ? <DocumentsPage /> : <DocumentsScreen />}
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return { qc, view };
}

const cells = () => screen.queryAllByTestId('documents-cell');
const cellOf = (d: string, g: string) => cells().find((c) => c.getAttribute('data-document-id') === d && c.getAttribute('data-group-id') === g)!;
const loaded = () => waitFor(() => expect(screen.getByTestId('documents-table')).toBeTruthy());
const setUser = () => userEvent.setup({ advanceTimers: () => {} });
const rpcCalls = (name: string) => issued.filter((c) => c.table === `rpc:${name}`);
const rpcArgs = (c: FakeCall) => c.ops[0]!.args[0] as Record<string, unknown>;
const sheet = () => screen.getByTestId('documents-sheet');
const reads = (table: string) => issued.filter((c) => c.table === table && !opOf(c, 'insert') && !opOf(c, 'update') && !opOf(c, 'delete')).length;

async function openSheet(d: string, g: string) {
  const user = setUser();
  await loaded();
  await user.click(cellOf(d, g));
  await waitFor(() => expect(sheet()).toBeTruthy());
  return user;
}


beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  seed();
  clock = 0;
  override = null;
  storageOverride = null;
  storageCalls = [];
  prevYear = PREV;
  download.files = [];
  h.userId = U_ADMIN;
  h.client = makeClient();
  h.push = vi.fn();
  h.replace = vi.fn((href: string) => h.setUrl(href));
  h.reloadMembership = vi.fn();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  h.listeners.clear();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

// ---------------------------------------------------------------- 提出状況の表

describe('T19 提出状況：表', () => {
  it('h1・タブ・CSV・最終読み込み。団体は sort_order → 名前、提出物は締切の順。部門長以上はファイルと使った量も読み、開いたときに片付ける', async () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('提出状況');
    await loaded();
    expect(screen.getByTestId('documents-tab-status')).toBeTruthy();
    expect(screen.getByTestId('documents-tab-settings')).toBeTruthy();
    expect(screen.getByTestId('documents-csv')).toBeTruthy();
    expect(screen.getByText(/最終読み込み/)).toBeTruthy();
    expect(screen.getAllByTestId('documents-row').map((r) => r.getAttribute('data-group-id'))).toEqual([G1.id, G5.id, G2.id, G3.id, G4.id]);
    expect(screen.getAllByTestId('documents-col').map((c) => c.getAttribute('data-document-id'))).toEqual([D_PLAN, D_FOOD, D_NOTE]);
    for (const t of ['documents', 'v_document_status', 'groups', 'profiles', 'v_document_files']) expect(reads(t)).toBeGreaterThan(0);
    expect(rpcCalls('document_storage_usage').length).toBeGreaterThan(0);
    // 片付け（どの提出にも属さない物を消す）
    await waitFor(() => expect(rpcCalls('document_orphan_paths')).toHaveLength(1));
    await waitFor(() => expect(db.objects.has(`${Y}/${G1.id}/${D_PLAN}/${uuid(399)}.pdf`)).toBe(false));
  });

  it('セル：状態・印（締切の後・代理・紙・締切を過ぎた）・届いたファイルの数・読み上げの名前。対象でないセルは「—」で押せない', async () => {
    renderScreen();
    await loaded();
    const late = cellOf(D_PLAN, G2.id);
    expect(late.tagName).toBe('BUTTON');
    expect(late.getAttribute('data-status')).toBe('submitted');
    expect(late.getAttribute('data-late')).toBe('true');
    // 読み上げの名前（aria-label は中身の文字より先に読まれる）に、見えている印とファイルの数も入れる（レビューの UX-3）
    expect(late.getAttribute('aria-label')).toBe('模擬店02・出店計画書：承認待ち、締切の後、ファイル 2');
    expect(cellOf(D_FOOD, G1.id).getAttribute('aria-label')).toBe('模擬店01・食品の届け：承認待ち、代理、ファイル 1');
    expect(cellOf(D_NOTE, G4.id).getAttribute('aria-label')).toBe('企業A・保健所への報告：承認、紙');
    expect(within(late).getByTestId('documents-cell-files').textContent).toBe('ファイル 2');
    expect(late.textContent).toContain('締切の後');
    expect(cellOf(D_FOOD, G1.id).getAttribute('data-proxy')).toBe('true');
    expect(cellOf(D_NOTE, G4.id).getAttribute('data-paper')).toBe('true');
    const overdue = cellOf(D_PLAN, G5.id);
    expect(overdue.getAttribute('data-status')).toBe('not_submitted');
    expect(overdue.getAttribute('data-overdue')).toBe('true');
    expect(overdue.textContent).toContain('締切を過ぎた');
    expect(overdue.getAttribute('aria-label')).toBe('A模擬店・出店計画書：未提出、締切を過ぎた');
    // ファイルのないセルは数を出さない
    expect(within(overdue).queryByTestId('documents-cell-files')).toBeNull();
    const none = cellOf(D_FOOD, G2.id);
    expect(none.getAttribute('data-status')).toBe('none');
    expect(none.tagName).toBe('SPAN');
    expect(none.textContent).toContain('—');
    // 列の見出し：締切・締切を過ぎました・承認の数
    const col = screen.getAllByTestId('documents-col')[0]!;
    expect(col.textContent).toContain('10/5（月）17:00');
    expect(col.textContent).toContain('締切を過ぎました');
    expect(col.textContent).toContain('承認 1／4');
  });

  it('絞り込み：件数つき。押すと ?status= を置き換え、合うセルのある行と列だけを出して、合わないセルを薄くする', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const counts = Object.fromEntries(screen.getAllByTestId('documents-filter-item').map((b) => [b.getAttribute('data-status'), b.getAttribute('data-count')]));
    expect(counts).toEqual({ all: '10', not_submitted: '5', submitted: '2', returned: '1', approved: '2', overdue: '2' });
    await user.click(screen.getAllByTestId('documents-filter-item').find((b) => b.getAttribute('data-status') === 'submitted')!);
    expect(h.replace).toHaveBeenLastCalledWith('/documents?status=submitted');
    await waitFor(() => expect(screen.getAllByTestId('documents-row').map((r) => r.getAttribute('data-group-id'))).toEqual([G1.id, G2.id]));
    expect(screen.getAllByTestId('documents-col').map((c) => c.getAttribute('data-document-id'))).toEqual([D_PLAN, D_FOOD]);
    expect(cellOf(D_PLAN, G2.id).getAttribute('data-dimmed')).toBe('false');
    expect(cellOf(D_PLAN, G1.id).getAttribute('data-dimmed')).toBe('true');
  });

  it('絞り込みに合う提出がない → 「条件に合う提出はありません」', async () => {
    db.subs = db.subs.filter((s) => s.status !== 'returned');
    renderScreen({ search: 'status=returned' });
    await waitFor(() => expect(screen.getByTestId('documents-filter-empty').textContent).toContain(FILTER_EMPTY_TEXT));
    expect(screen.queryByTestId('documents-table')).toBeNull();
  });

  it('?document= の列を目立たせる。絞り込みでその列が出なければ「すべて」にする。読めない id は何もしない', async () => {
    renderScreen({ search: `document=${D_NOTE}&status=returned` });
    await loaded();
    // 保健所への報告には差し戻しがないので、絞り込みは「すべて」
    expect(screen.getAllByTestId('documents-filter-item').find((b) => b.getAttribute('data-state') === 'on')!.getAttribute('data-status')).toBe('all');
    expect(cellOf(D_NOTE, G4.id).getAttribute('data-highlighted')).toBe('true');
    expect(cellOf(D_PLAN, G1.id).getAttribute('data-highlighted')).toBe('false');
    cleanup();
    renderScreen({ search: `document=not-a-uuid&group=${uuid(999)}` });
    await loaded();
    expect(cells().every((c) => c.getAttribute('data-highlighted') === 'false')).toBe(true);
    expect(screen.queryByTestId('documents-sheet')).toBeNull();
  });

  it('狭い幅では提出物ごとの一覧（表は描かない）', async () => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('documents-list')).toBeTruthy());
    expect(screen.queryByTestId('documents-table')).toBeNull();
    const docsInList = screen.getAllByTestId('documents-list-document');
    expect(docsInList.map((d) => d.getAttribute('data-document-id'))).toEqual([D_PLAN, D_FOOD, D_NOTE]);
    const items = within(docsInList[0]!).getAllByTestId('documents-list-item');
    expect(items.map((i) => [i.getAttribute('data-group-id'), i.getAttribute('data-status')])).toEqual([
      [G1.id, 'approved'],
      [G5.id, 'not_submitted'],
      [G2.id, 'submitted'],
      [G3.id, 'returned'],
    ]);
    // 読み上げの名前は表のセルと同じ（印とファイルの数を含む）
    expect(items[2]!.getAttribute('aria-label')).toBe('模擬店02・出店計画書：承認待ち、締切の後、ファイル 2');
  });

  it('空の表示：提出物がない（部門長以上には設定の案内）・対象の団体がない', async () => {
    db.docs = [];
    db.subs = [];
    db.files = [];
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('documents-empty').textContent).toContain(EMPTY_DOCUMENTS));
    expect(screen.getByTestId('documents-empty').textContent).toContain(EMPTY_DOCUMENTS_HINT);
    cleanup();
    seed();
    db.groups = [];
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('documents-no-targets').textContent).toContain(NO_TARGETS_TEXT));
  });

  it('CSV で保存：押したときに作り、`{年度名}_提出状況.csv` で保存する', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(screen.getByTestId('documents-csv'));
    await waitFor(() => expect(download.files).toHaveLength(1));
    expect(download.files[0]!.name).toBe('R8_提出状況.csv');
    expect(download.files[0]!.data.startsWith('﻿団体,区分,提出物')).toBe(true);
  });

  it('開いたときの片付けはその年度で1回（同じタブで開き直しても送らない）', async () => {
    const { qc } = renderScreen();
    await loaded();
    await waitFor(() => expect(rpcCalls('document_orphan_paths')).toHaveLength(1));
    cleanup();
    renderScreen({ qc });
    await loaded();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rpcCalls('document_orphan_paths')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 段

describe('T19 提出状況：段ごとの出し分け', () => {
  it('総務部門員：状況だけ（設定のタブ・CSV・ファイルの数・操作なし。ファイル・使った量を読まず、片付けない）', async () => {
    h.userId = 'u-staff';
    const user = setUser();
    renderScreen({ role: 'staff' });
    await loaded();
    expect(screen.getByTestId('documents-tab-status')).toBeTruthy();
    expect(screen.queryByTestId('documents-tab-settings')).toBeNull();
    expect(screen.queryByTestId('documents-csv')).toBeNull();
    expect(screen.queryAllByTestId('documents-cell-files')).toHaveLength(0);
    expect(cellOf(D_PLAN, G2.id).getAttribute('aria-label')).toBe('模擬店02・出店計画書：承認待ち、締切の後');
    expect(reads('v_document_files')).toBe(0);
    expect(rpcCalls('document_storage_usage')).toHaveLength(0);
    expect(rpcCalls('document_orphan_paths')).toHaveLength(0);
    await user.click(cellOf(D_PLAN, G2.id));
    await waitFor(() => expect(sheet()).toBeTruthy());
    expect(within(sheet()).getByTestId('documents-sheet-staff-note').textContent).toBe(STAFF_FILES_NOTE);
    expect(within(sheet()).queryByTestId('documents-sheet-files')).toBeNull();
    for (const id of ['approve', 'return', 'paper', 'submit', 'withdraw']) expect(within(sheet()).queryByTestId(`documents-sheet-${id}`)).toBeNull();
    // 設定のタブは URL で開いても出さない
    cleanup();
    renderScreen({ role: 'staff', search: 'tab=settings' });
    await loaded();
    expect(screen.queryByTestId('documents-settings')).toBeNull();
  });

  it('閲覧のみ（店長・副店長を兼ねていても）：ページが権限なしにし、何も読まない', async () => {
    renderScreen({ role: 'viewer', page: true, groups: [{ id: G1.id, name: G1.name, year_id: Y, role: 'manager' }] });
    expect(await screen.findByText('権限がありません')).toBeTruthy();
    expect(screen.queryByTestId('documents-screen')).toBeNull();
    expect(issued.filter((c) => c.table !== 'years')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- セルのシート

describe('T19 提出状況：セルのシート', () => {
  it('セルを押すと URL に提出物と団体を入れて開く。経過（した人の表示名）・前回の差し戻しの理由・ファイル・操作。閉じると2つを外す', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    expect(h.replace).toHaveBeenLastCalledWith(`/documents?document=${D_PLAN}&group=${G2.id}`);
    expect(within(sheet()).getByTestId('documents-sheet-title').textContent).toBe('模擬店02・出店計画書');
    expect(within(sheet()).getByTestId('documents-sheet-status').textContent).toContain('承認待ち');
    expect(within(sheet()).getByTestId('documents-sheet-status').textContent).toContain('締切の後');
    expect(within(sheet()).getByTestId('documents-sheet-history').textContent).toBe('提出 2026/10/06 09:00（店長テスト）');
    const note = within(sheet()).getByTestId('documents-sheet-note');
    expect(note.textContent).toContain('前回の差し戻しの理由');
    expect(note.textContent).toContain('印鑑がありません\n押してから出し直してください');
    const files = within(sheet()).getAllByTestId('documents-sheet-file');
    expect(files.map((f) => f.textContent?.split('）')[0])).toEqual(['ファイル 1（JPEG・826 KB・10/5 18:00', 'ファイル 2（PDF・1.2 MB・10/5 19:00']);
    expect(within(sheet()).getAllByTestId('documents-sheet-file-remove')).toHaveLength(2);
    expect(within(sheet()).getByTestId('documents-sheet-approve')).toBeTruthy();
    expect(within(sheet()).getByTestId('documents-sheet-return').textContent).toBe('差し戻す');
    expect(within(sheet()).getByTestId('documents-sheet-withdraw')).toBeTruthy();
    expect(within(sheet()).queryByTestId('documents-sheet-paper')).toBeNull();
    expect(within(sheet()).queryByTestId('documents-sheet-submit')).toBeNull();
    // 提出先（T24）：新しいタブ・noopener noreferrer。ファイルを上げる欄は出さない
    const link = within(sheet()).getByTestId('documents-sheet-submit-url') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://drive.google.com/drive/folders/plan');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(sheet()).queryByTestId('documents-sheet-file-add')).toBeNull();
    expect(within(sheet()).queryByTestId('documents-sheet-file-input')).toBeNull();
    // 閉じる（×）
    await user.click(within(sheet()).getByRole('button', { name: '閉じる' }));
    expect(h.replace).toHaveBeenLastCalledWith('/documents');
    await waitFor(() => expect(screen.queryByTestId('documents-sheet')).toBeNull());
  });

  it('URL に両方あれば開いた状態で始まる。紙での承認は「紙」の印と、読めない人は「名前を表示できません」', async () => {
    renderScreen({ search: `document=${D_NOTE}&group=${G4.id}` });
    await waitFor(() => expect(sheet()).toBeTruthy());
    expect(within(sheet()).getByTestId('documents-sheet-status').textContent).toContain('紙');
    expect(within(sheet()).getByTestId('documents-sheet-history').textContent).toBe(`承認 2026/10/02 09:00（${UNKNOWN_ACTOR}）`);
    expect(within(sheet()).getByTestId('documents-sheet-note').textContent).toContain('承認のメモ');
    // 承認には「承認を取り消して差し戻す」だけ（ファイルを足す・外すは出さない）
    expect(within(sheet()).getByTestId('documents-sheet-return').textContent).toBe('承認を取り消して差し戻す');
    expect(within(sheet()).queryByTestId('documents-sheet-file-add')).toBeNull();
    // 提出先の URL がない（T24）：部門長以上には設定で入れられることを添える。ファイルがなければファイルの欄は出さない
    expect(within(sheet()).queryByTestId('documents-sheet-submit-url')).toBeNull();
    expect(within(sheet()).getByTestId('documents-sheet-no-submit-url').textContent).toBe('提出先の URL はまだありません（「提出物の設定」で入れられます）');
    expect(within(sheet()).queryByTestId('documents-sheet-files')).toBeNull();
  });

  it('承認する：メモ（任意。字数と注意）→ approve_document（開いたときの版）→「承認しました」。シートは開いたまま読み直す', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-approve'));
    const dialog = screen.getByTestId('documents-approve-dialog');
    expect(dialog.textContent).toContain(NOTE_VISIBLE_HELP);
    await user.type(within(dialog).getByTestId('documents-approve-note'), '確かめました');
    expect(within(dialog).getByTestId('documents-approve-note-count').textContent).toBe('6/1000');
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('承認しました'));
    expect(rpcArgs(rpcCalls('approve_document')[0]!)).toEqual({ p_document_id: D_PLAN, p_group_id: G2.id, p_note: '確かめました', p_base_updated_at: V0 });
    expect(screen.queryByTestId('documents-approve-dialog')).toBeNull();
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-status').getAttribute('data-status')).toBe('approved'));
    expect(within(sheet()).getByTestId('documents-sheet-note').textContent).toContain('確かめました');
    expect(cellOf(D_PLAN, G2.id).getAttribute('data-status')).toBe('approved');
  });

  it('差し戻す：理由は必須（送らない）・注意を添える → return_document →「差し戻しました」。差し戻しは今の理由を入れて「理由を書き直す」', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-return'));
    const dialog = screen.getByTestId('documents-return-dialog');
    expect(dialog.textContent).toContain(RETURN_REASON_HELP);
    await user.type(within(dialog).getByTestId('documents-return-reason'), '   ');
    await user.click(within(dialog).getByTestId('documents-return-submit'));
    expect(dialog.textContent).toContain(REVIEW_NOTE_MESSAGES.returnRequired);
    expect(rpcCalls('return_document')).toHaveLength(0);
    await user.clear(within(dialog).getByTestId('documents-return-reason'));
    await user.type(within(dialog).getByTestId('documents-return-reason'), '日付がありません');
    await user.click(within(dialog).getByTestId('documents-return-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('差し戻しました'));
    expect(rpcArgs(rpcCalls('return_document')[0]!)).toMatchObject({ p_note: '日付がありません', p_base_updated_at: V0 });
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-return').textContent).toBe('理由を書き直す'));
    await user.click(within(sheet()).getByTestId('documents-sheet-return'));
    expect((within(screen.getByTestId('documents-return-dialog')).getByTestId('documents-return-reason') as HTMLTextAreaElement).value).toBe('日付がありません');
  });

  it('紙などで受け取ったとして承認する（未提出）：メモが必須 → approve_document（版は null）', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G5.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-paper'));
    const dialog = screen.getByTestId('documents-paper-dialog');
    await user.click(within(dialog).getByTestId('documents-paper-submit'));
    expect(dialog.textContent).toContain(REVIEW_NOTE_MESSAGES.paperRequired);
    await user.type(within(dialog).getByTestId('documents-paper-note'), '10/3 に紙で受け取りました');
    await user.click(within(dialog).getByTestId('documents-paper-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('承認しました'));
    expect(rpcArgs(rpcCalls('approve_document')[0]!)).toEqual({ p_document_id: D_PLAN, p_group_id: G5.id, p_note: '10/3 に紙で受け取りました', p_base_updated_at: null });
    await waitFor(() => expect(cellOf(D_PLAN, G5.id).getAttribute('data-paper')).toBe('true'));
  });

  it('conflict：ほかの人がファイルを足して版が進んだ → 入力を残して知らせ、もう一度押すと読み直した版で送る', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-approve'));
    // 開いた後に、ほかの人がファイルを足した（版が進む）
    const bumped = nextAt();
    findSub(D_PLAN, G2.id)!.updated_at = bumped;
    const dialog = screen.getByTestId('documents-approve-dialog');
    await user.type(within(dialog).getByTestId('documents-approve-note'), 'メモ');
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('documents-review-error').textContent).toContain(DOCUMENT_CONFLICT_MESSAGE));
    expect((within(dialog).getByTestId('documents-approve-note') as HTMLTextAreaElement).value).toBe('メモ');
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('承認しました'));
    expect(rpcCalls('approve_document').map((c) => rpcArgs(c).p_base_updated_at)).toEqual([V0, bumped]);
  });

  it('同じ操作が重なった（ほかの部門長が先に承認）→ not_editable の文言（読み直しました）', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-approve'));
    Object.assign(findSub(D_PLAN, G2.id)!, { status: 'approved', reviewed_at: NOW, reviewed_by: 'u-other', updated_at: nextAt() });
    const dialog = screen.getByTestId('documents-approve-dialog');
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('documents-review-error').textContent).toBe(DOCUMENT_NOT_EDITABLE_MESSAGES.approved));
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-status').getAttribute('data-status')).toBe('approved'));
  });

  it('応答が届かず分からない → もう一度押すと、前の送信が通っていたかを読み直して「承認されていました」', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-approve'));
    const dialog = screen.getByTestId('documents-approve-dialog');
    // 1回目：DB は承認したが応答が届かず、その後の読み直しも届かない（分からないまま）
    let applied = false;
    let failReads = false;
    override = (call) => {
      if (call.table === 'rpc:approve_document' && !applied) {
        applied = true;
        rpc('approve_document', rpcArgs(call));
        failReads = true;
        return NETWORK;
      }
      return failReads && call.table === 'v_document_status' ? NETWORK : undefined;
    };
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('documents-review-error').getAttribute('data-kind')).toBe('unknown'));
    // もう一度：DB は not_editable（承認済み）。読み直すと承認なので、前の送信が通っていた
    failReads = false;
    await user.click(within(dialog).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(SUBMISSION_DONE_BEFORE.approve));
    expect(screen.queryByTestId('documents-approve-dialog')).toBeNull();
  });

  it('代わりに提出する（店長・副店長でない人）：代理の注意 → submit_document →「「{団体}」の代わりに提出しました」。その団体の店長・副店長には注意を出さない', async () => {
    db.files.push(dbFile(uuid(310), D_PLAN, G5.id));
    db.objects.set(pathOf(db.files.at(-1)!), 1_258_291);
    renderScreen();
    const user = await openSheet(D_PLAN, G5.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-submit'));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('「A模擬店」の代わりに「出店計画書」を提出しますか');
    expect(within(confirm).getByTestId('documents-proxy-confirm').textContent).toBe(PROXY_CONFIRM_TEXT);
    await user.click(within(confirm).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「A模擬店」の代わりに提出しました'));
    expect(rpcArgs(rpcCalls('submit_document')[0]!)).toEqual({ p_document_id: D_PLAN, p_group_id: G5.id, p_base_updated_at: null });
    cleanup();
    renderScreen({ groups: [{ id: G3.id, name: G3.name, year_id: Y, role: 'manager' }] });
    const user2 = await openSheet(D_PLAN, G3.id);
    await user2.click(within(sheet()).getByTestId('documents-sheet-submit'));
    expect(within(screen.getByRole('alertdialog')).getByTestId('documents-proxy-confirm').textContent).toBe('');
  });

  it('代わりに提出する：ファイルがなくても押せる（T24。ファイルは提出先に出す）。応答が届かなければ「代わりに提出する」の名前で知らせる', async () => {
    renderScreen();
    await openSheet(D_PLAN, G5.id);
    expect((within(sheet()).getByTestId('documents-sheet-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(sheet().textContent).not.toContain('ファイルを1つ以上足してください');
    cleanup();
    renderScreen();
    const user2 = await openSheet(D_NOTE, G2.id);
    override = (call) => (call.table === 'rpc:submit_document' ? NETWORK : undefined);
    await user2.click(within(sheet()).getByTestId('documents-sheet-submit'));
    await user2.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-error').textContent).toBe(PROXY_SUBMIT_UNKNOWN));
  });

  it('提出を取り消す：確かめ → withdraw_document →「提出を取り消しました」', async () => {
    renderScreen();
    const user = await openSheet(D_FOOD, G1.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-withdraw'));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('「模擬店01」の「食品の届け」の提出を取り消しますか');
    expect(within(confirm).getByTestId('documents-withdraw-confirm')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('提出を取り消しました'));
    expect(rpcArgs(rpcCalls('withdraw_document')[0]!)).toEqual({ p_document_id: D_FOOD, p_group_id: G1.id, p_base_updated_at: V0 });
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-status').getAttribute('data-status')).toBe('not_submitted'));
  });

  it('T24 の前のファイル：ファイルを上げる欄は出さず、届いたファイルは開く・保存・確かめてから外す（代理）', async () => {
    renderScreen();
    const user = await openSheet(D_PLAN, G3.id);
    expect(within(sheet()).queryByTestId('documents-sheet-file-input')).toBeNull();
    await waitFor(() => expect(within(sheet()).getAllByTestId('documents-sheet-file')).toHaveLength(1));
    expect(rpcCalls('reserve_document_file')).toHaveLength(0);
    // 開く（先にタブ）・保存（名前）
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(fileWindow, 'openBlank').mockReturnValue(tab as unknown as Window);
    const assign = vi.spyOn(fileWindow, 'assign').mockImplementation(() => {});
    await user.click(within(sheet()).getAllByTestId('documents-sheet-file-open')[0]!);
    await waitFor(() => expect(tab.location.href).toContain('https://storage.test/sign/'));
    await user.click(within(sheet()).getAllByTestId('documents-sheet-file-save')[0]!);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(new URL(assign.mock.calls[0]![0] as string).searchParams.getAll('download')).toEqual(['出店計画書_学科A_1.pdf']);
    // 外す（確かめ）
    await user.click(within(sheet()).getAllByTestId('documents-sheet-file-remove')[0]!);
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByTestId('documents-remove-confirm')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ファイル 1 を外しました'));
    expect(rpcCalls('discard_document_file')).toHaveLength(1);
    await waitFor(() => expect(within(sheet()).queryAllByTestId('documents-sheet-file')).toHaveLength(0));
  });

  it('開く・保存が 403（立場が変わった）→「ファイルを開けませんでした。立場が変わった可能性があります」（アップロードとは言わない。レビューの UX-4）', async () => {
    storageOverride = (c) => (c.op === 'createSignedUrl' ? { data: null, error: storageError('403', 'AccessDenied') } : undefined);
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(fileWindow, 'openBlank').mockReturnValue(tab as unknown as Window);
    renderScreen();
    const user = await openSheet(D_PLAN, G3.id);
    await user.click(within(sheet()).getAllByTestId('documents-sheet-file-open')[0]!);
    await waitFor(() => expect(within(sheet()).getByTestId('documents-sheet-file-error').textContent).toBe(STORAGE_SIGN_DENIED_MESSAGE));
    expect(STORAGE_SIGN_DENIED_MESSAGE).toBe('ファイルを開けませんでした。立場が変わった可能性があります');
    expect(tab.close).toHaveBeenCalled();
  });

  it('代わりに提出する・承認するが成功したら、ダイアログが閉じた後にフォーカスをシートの見出しに移す（押したボタンは消える。レビューの F4）', async () => {
    renderScreen();
    const user = await openSheet(D_NOTE, G1.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-submit'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「模擬店01」の代わりに提出しました'));
    await waitFor(() => expect(document.activeElement).toBe(within(sheet()).getByTestId('documents-sheet-title')));
    // 承認する（ダイアログ）→ 閉じた後に見出しへ
    await user.click(within(sheet()).getByTestId('documents-sheet-approve'));
    await user.click(within(screen.getByTestId('documents-approve-dialog')).getByTestId('documents-approve-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('承認しました'));
    await waitFor(() => expect(within(sheet()).queryByTestId('documents-sheet-approve')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(sheet()).getByTestId('documents-sheet-title')));
  });

  it('下書き：理由を入れたまま離れようとすると確かめ、開き直すと「戻す」で戻せる。成功したら消す', async () => {
    const { qc } = renderScreen();
    const user = await openSheet(D_PLAN, G2.id);
    await user.click(within(sheet()).getByTestId('documents-sheet-return'));
    await user.type(within(screen.getByTestId('documents-return-dialog')).getByTestId('documents-return-reason'), '日付がありません');
    // アプリの中で移る前に確かめる（ダイアログの外のリンク。押せない覆いの下なので、クリックの出来事だけを送る）
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(await screen.findByText(LEAVE_MESSAGES.navigate.title)).toBeTruthy();
    expect(h.push).not.toHaveBeenCalled();
    // 画面を離れても下書きに残る（開き直すと戻せる）
    cleanup();
    renderScreen({ qc, search: `document=${D_PLAN}&group=${G2.id}` });
    await waitFor(() => expect(sheet()).toBeTruthy());
    const user2 = setUser();
    await user2.click(within(sheet()).getByTestId('documents-sheet-return'));
    const dialog = screen.getByTestId('documents-return-dialog');
    await user2.click(within(dialog).getByRole('button', { name: '戻す' }));
    expect((within(dialog).getByTestId('documents-return-reason') as HTMLTextAreaElement).value).toBe('日付がありません');
    await user2.click(within(dialog).getByTestId('documents-return-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('差し戻しました'));
    const keys = Array.from({ length: window.localStorage.length }, (_, k) => window.localStorage.key(k) ?? '');
    expect(keys.filter((k) => k.includes(':documents:'))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 提出物の設定

async function openSettings(opts: Parameters<typeof renderScreen>[0] = {}) {
  renderScreen({ ...opts, search: 'tab=settings' });
  await waitFor(() => expect(screen.getByTestId('documents-settings')).toBeTruthy());
  return setUser();
}

async function fillNew(user: ReturnType<typeof setUser>, title: string) {
  const dialog = screen.getByTestId('doc-dialog');
  await user.type(within(dialog).getByTestId('doc-title'), title);
  fireEvent.change(within(dialog).getByTestId('doc-deadline-date'), { target: { value: '2026-10-09' } });
  await user.click(within(dialog).getAllByTestId('doc-category').find((c) => c.getAttribute('data-category') === 'stall')!);
  return dialog;
}

describe('T19 提出状況：提出物の設定', () => {
  it('一覧：締切の順に題名・締切・対象（飲食の団体だけ）・提出先（T24）・承認の数と、編集・削除。登録と前年度から写す', async () => {
    await openSettings();
    const rows = screen.getAllByTestId('documents-settings-row');
    expect(rows.map((r) => r.getAttribute('data-document-id'))).toEqual([D_PLAN, D_FOOD, D_NOTE]);
    expect(rows[0]!.textContent).toContain('10/5（月）17:00');
    expect(rows[0]!.textContent).toContain('模擬店・部門');
    const link = within(rows[0]!).getByTestId('documents-settings-submit-url') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://drive.google.com/drive/folders/plan');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rows[0]!.textContent).toContain('承認 1／4');
    expect(rows[1]!.textContent).toContain('模擬店（飲食の団体だけ）');
    expect(within(rows[2]!).queryByTestId('documents-settings-submit-url')).toBeNull();
    expect(rows[2]!.textContent).toContain('—');
    expect(screen.getAllByTestId('documents-settings-edit')).toHaveLength(3);
    expect(screen.getAllByTestId('documents-settings-delete')).toHaveLength(3);
    expect(screen.getByTestId('documents-settings-add')).toBeTruthy();
    expect(screen.getByTestId('documents-settings-copy')).toBeTruthy();
    expect(screen.queryByTestId('documents-csv')).toBeNull();
  });

  it('複製元のない年度では「前年度から写す」を出さない', async () => {
    prevYear = null;
    await openSettings();
    expect(screen.queryByTestId('documents-settings-copy')).toBeNull();
  });

  it('登録：送る前の確かめ（題名・日付・区分）→ 画面が作った id と +09:00 の締切で insert →「「{題名}」を登録しました」', async () => {
    const user = await openSettings();
    await user.click(screen.getByTestId('documents-settings-add'));
    const dialog = screen.getByTestId('doc-dialog');
    expect((within(dialog).getByTestId('doc-deadline-time') as HTMLInputElement).value).toBe('17:00');
    expect(within(dialog).queryByTestId('doc-requires-file')).toBeNull();
    expect((within(dialog).getByTestId('doc-submit-url') as HTMLInputElement).value).toBe('');
    await user.click(within(dialog).getByTestId('doc-submit'));
    expect(dialog.textContent).toContain(DOCUMENT_FORM_MESSAGES.titleRequired);
    expect(dialog.textContent).toContain(DOCUMENT_FORM_MESSAGES.dateRequired);
    expect(dialog.textContent).toContain(DOCUMENT_FORM_MESSAGES.categoryRequired);
    await fillNew(user, '  火気の使用届  ');
    expect(within(dialog).getByTestId('doc-target-count').textContent).toBe('対象の団体：3 団体');
    await user.click(within(dialog).getByTestId('doc-food-only'));
    expect(within(dialog).getByTestId('doc-target-count').textContent).toBe('対象の団体：1 団体');
    // 提出先の URL（T24）：https でなければ欄の誤りで送らない。直すと送る
    await user.type(within(dialog).getByTestId('doc-submit-url'), 'http://forms.gle/fire');
    await user.click(within(dialog).getByTestId('doc-submit'));
    expect(dialog.textContent).toContain(DOCUMENT_FORM_MESSAGES.submitUrlInvalid);
    expect(issued.some((c) => c.table === 'documents' && opOf(c, 'insert'))).toBe(false);
    await user.clear(within(dialog).getByTestId('doc-submit-url'));
    await user.type(within(dialog).getByTestId('doc-submit-url'), ' https://forms.gle/fire ');
    expect(within(dialog).getByTestId('doc-submit-url-count').textContent).toBe('22/500');
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「火気の使用届」を登録しました'));
    const insert = issued.find((c) => c.table === 'documents' && opOf(c, 'insert'))!;
    expect(opOf(insert, 'insert')!.args[0]).toMatchObject({
      year_id: Y,
      title: '火気の使用届',
      description: null,
      deadline: '2026-10-09T17:00:00+09:00',
      target_categories: ['stall'],
      food_only: true,
      submit_url: 'https://forms.gle/fire',
    });
    expect(opOf(insert, 'insert')!.args[0]).not.toHaveProperty('requires_file');
    expect((opOf(insert, 'insert')!.args[0] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.getAllByTestId('documents-settings-row')).toHaveLength(4));
  });

  it('同じ題名の提出物があれば、題名の欄の下に出して入力を残す', async () => {
    const user = await openSettings();
    await user.click(screen.getByTestId('documents-settings-add'));
    const dialog = await fillNew(user, '食品の届け');
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(dialog.textContent).toContain(DOCUMENT_TITLE_TAKEN_MESSAGE));
    expect((within(dialog).getByTestId('doc-title') as HTMLInputElement).value).toBe('食品の届け');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('編集：何も変えなければ送らずに「変更はありません」。対象を狭めると、提出の記録のある団体の数を出す', async () => {
    const user = await openSettings();
    await user.click(screen.getAllByTestId('documents-settings-edit')[0]!);
    let dialog = screen.getByTestId('doc-dialog');
    expect((within(dialog).getByTestId('doc-title') as HTMLInputElement).value).toBe('出店計画書');
    expect((within(dialog).getByTestId('doc-deadline-date') as HTMLInputElement).value).toBe('2026-10-05');
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('変更はありません'));
    expect(issued.filter((c) => c.table === 'documents' && opOf(c, 'update'))).toHaveLength(0);
    await user.click(screen.getAllByTestId('documents-settings-edit')[0]!);
    dialog = screen.getByTestId('doc-dialog');
    // 部門を外す：学科A（差し戻し）が外れる
    await user.click(within(dialog).getAllByTestId('doc-category').find((c) => c.getAttribute('data-category') === 'department')!);
    expect(within(dialog).getByTestId('doc-narrowing').textContent).toBe(narrowingText(1));
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「出店計画書」を保存しました'));
    const update = issued.find((c) => c.table === 'documents' && opOf(c, 'update'))!;
    expect(eqOf(update)).toEqual({ id: D_PLAN, updated_at: V0 });
  });

  it('編集の conflict：ほかの人が先に変えた → 読み直した版を入力の元にして入力を残し、もう一度押すと上書きする', async () => {
    const user = await openSettings();
    await user.click(screen.getAllByTestId('documents-settings-edit')[0]!);
    const dialog = screen.getByTestId('doc-dialog');
    Object.assign(db.docs.find((d) => d.id === D_PLAN)!, { description: 'ほかの人の説明', updated_at: nextAt() });
    await user.type(within(dialog).getByTestId('doc-description'), '自分の説明');
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('doc-conflict').textContent).toContain(DOC_CONFLICT_NOTICE));
    expect((within(dialog).getByTestId('doc-description') as HTMLTextAreaElement).value).toBe('自分の説明');
    await user.click(within(dialog).getByTestId('doc-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「出店計画書」を保存しました'));
    expect(db.docs.find((d) => d.id === D_PLAN)!.description).toBe('自分の説明');
  });

  it('削除：提出 N 件とファイル M 件を出して確かめ → 版を条件に delete → 片付け →「「{題名}」を削除しました」', async () => {
    const user = await openSettings();
    await user.click(screen.getAllByTestId('documents-settings-delete')[0]!);
    const confirm = screen.getByRole('alertdialog');
    // 出店計画書：未提出でない提出 3 件（承認・承認待ち・差し戻し）とファイル 4 件
    expect(confirm.textContent).toContain(deleteConfirmText(3, 4));
    expect(within(confirm).getByTestId('documents-delete-confirm')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「出店計画書」を削除しました'));
    const del = issued.find((c) => c.table === 'documents' && opOf(c, 'delete'))!;
    expect(eqOf(del)).toEqual({ id: D_PLAN, updated_at: V0 });
    // 片付け：消えた提出のファイルの物は Storage から消える
    expect([...db.objects.keys()].some((p) => p.includes(D_PLAN))).toBe(false);
    expect(deleteConfirmText(0, 0)).toBe('元に戻せません。');
  });

  it('削除の数は、今の対象から外れた団体の提出も数える（表 document_submissions をその提出物で読む。数えている間は押せない）', async () => {
    // 食品の届けは飲食の模擬店だけが対象。飲食でない模擬店02 の提出（差し戻し）とファイルは、対象から外れても残っていて、消すと一緒に消える
    db.subs.push(sub(D_FOOD, G2.id, { status: 'returned', submitted_at: '2026-10-04T00:00:00+00:00', submitted_by: U_REP, reviewed_at: '2026-10-05T00:00:00+00:00', reviewed_by: U_ADMIN, review_note: '対象の前' }));
    const f = dbFile(uuid(306), D_FOOD, G2.id);
    db.files.push(f);
    db.objects.set(f.object_path, f.size);
    let release: (() => void) | null = null;
    override = (call) =>
      call.table === 'document_submissions' && release === null
        ? new Promise<FakeResult>((resolve) => {
            release = () => resolve(handler({ ...call, table: 'document_submissions' }));
          })
        : undefined;
    const user = await openSettings();
    const row = screen.getAllByTestId('documents-settings-row').find((r) => r.getAttribute('data-document-id') === D_FOOD)!;
    await user.click(within(row).getByTestId('documents-settings-delete'));
    const confirm = screen.getByRole('alertdialog');
    // 数えている間は「削除する」を押せない
    await waitFor(() => expect(confirm.textContent).toContain(DELETE_COUNTING_TEXT));
    expect((within(confirm).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true);
    override = null;
    await act(async () => release!());
    // 対象の模擬店01 の承認待ちと、対象から外れた模擬店02 の差し戻し（2 件）。ファイルは 2 件
    await waitFor(() => expect(confirm.textContent).toContain(deleteConfirmText(2, 2)));
    const read = issued.find((c) => c.table === 'document_submissions')!;
    expect(eqOf(read)).toEqual({ document_id: D_FOOD });
    expect((within(confirm).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('削除の数を読み込めなければ「提出とファイルの記録も消えます（数を読み込めませんでした）」で確かめる（押せる）', async () => {
    override = (call) => (call.table === 'document_submissions' ? NETWORK : undefined);
    const user = await openSettings();
    await user.click(screen.getAllByTestId('documents-settings-delete')[0]!);
    const confirm = screen.getByRole('alertdialog');
    await waitFor(() => expect(confirm.textContent).toContain(DELETE_COUNT_FAILED_TEXT));
    expect((within(confirm).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('前年度から写す：同じ題名は選べない。選んだものを写して「{N} 件を写しました」', async () => {
    const user = await openSettings();
    await user.click(screen.getByTestId('documents-settings-copy'));
    const dialog = screen.getByTestId('doc-copy-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('doc-copy-item')).toHaveLength(3));
    // 説明：何の「1日目」の差かを書く（レビューの UX-6）
    expect(dialog.textContent).toContain('締切は、前年度と今年度の祭の1日目の差の日数だけずらします（時刻は同じ）。写した後に直せます。');
    const items = within(dialog).getAllByTestId('doc-copy-item');
    expect(items[0]!.getAttribute('data-exists')).toBe('true');
    expect(items[0]!.textContent).toContain(COPY_EXISTS_TEXT);
    expect(within(items[0]!).getByTestId('doc-copy-check').hasAttribute('disabled')).toBe(true);
    expect(within(items[1]!).getByTestId('doc-copy-deadline').textContent).toBe('前年度 10/8（水）17:00 → 10/7（水）17:00');
    expect((within(dialog).getByTestId('doc-copy-submit') as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(items[1]!).getByTestId('doc-copy-check'));
    await user.click(within(items[2]!).getByTestId('doc-copy-check'));
    expect(within(dialog).getByTestId('doc-copy-submit').textContent).toBe('写す（2 件）');
    await user.click(within(dialog).getByTestId('doc-copy-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 件を写しました'));
    expect(rpcArgs(rpcCalls('copy_previous_documents')[0]!)).toEqual({ p_year_id: Y, p_document_ids: [uuid(502), uuid(503)] });
    await waitFor(() => expect(screen.getAllByTestId('documents-settings-row')).toHaveLength(5));
  });
});

describe('T19 提出状況：前年度から写すの応答が届かなかったとき（レビューの T19BC-1）', () => {
  it('写せていた（応答だけが届かない）→ 前年度の一覧を読み直し、写されたものは選べなくなる（もう一度押して「0 件を写しました」にしない）', async () => {
    override = (call) => {
      if (call.table !== 'rpc:copy_previous_documents') return undefined;
      rpc('copy_previous_documents', rpcArgs(call));
      return NETWORK;
    };
    const user = await openSettings();
    await user.click(screen.getByTestId('documents-settings-copy'));
    const dialog = screen.getByTestId('doc-copy-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('doc-copy-item')).toHaveLength(3));
    const reads0 = rpcCalls('previous_year_documents').length;
    await user.click(within(within(dialog).getAllByTestId('doc-copy-item')[1]!).getByTestId('doc-copy-check'));
    await user.click(within(dialog).getByTestId('doc-copy-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('doc-copy-error').textContent).toBe('通信できませんでした。電波の良い所でもう一度'));
    // 前年度の一覧を読み直した：写された「火気の使用届」は同じ題名があるので選べない
    await waitFor(() => expect(rpcCalls('previous_year_documents').length).toBeGreaterThan(reads0));
    await waitFor(() => expect(within(dialog).getAllByTestId('doc-copy-item')[1]!.getAttribute('data-exists')).toBe('true'));
    expect(within(within(dialog).getAllByTestId('doc-copy-item')[1]!).getByTestId('doc-copy-check').hasAttribute('disabled')).toBe(true);
    expect((within(dialog).getByTestId('doc-copy-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByTestId('doc-copy-submit').textContent).toBe('写す（0 件）');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('読み直せないままもう一度押して、写されていたものが返らなかった → 「同じ題名」と言わずに、前に写されていた可能性を言う', async () => {
    let first = true;
    override = (call) => {
      if (call.table === 'rpc:copy_previous_documents' && first) {
        first = false;
        rpc('copy_previous_documents', rpcArgs(call));
        return NETWORK;
      }
      // 応答が届かなかった後の前年度の読み直しも届かない
      if (call.table === 'rpc:previous_year_documents' && !first) return NETWORK;
      return undefined;
    };
    const user = await openSettings();
    await user.click(screen.getByTestId('documents-settings-copy'));
    const dialog = screen.getByTestId('doc-copy-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('doc-copy-item')).toHaveLength(3));
    await user.click(within(within(dialog).getAllByTestId('doc-copy-item')[1]!).getByTestId('doc-copy-check'));
    await user.click(within(dialog).getByTestId('doc-copy-submit'));
    await waitFor(() => expect(within(dialog).getAllByTestId('doc-copy-error').length).toBeGreaterThan(0));
    await waitFor(() => expect((within(dialog).getByTestId('doc-copy-submit') as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByTestId('doc-copy-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('0 件を写しました（1 件は、前に写されていたか同じ題名があったので写しませんでした）'));
  });
});

// ---------------------------------------------------------------- 終了した年度

describe('T19 提出状況：終了した年度', () => {
  it('帯を出し、書くためのもの（設定の登録・編集・削除・写す、シートの操作・ファイルの追加と外す）を出さない。開く・保存・CSV はできる', async () => {
    renderScreen({ role: 'head', status: 'closed', search: `document=${D_PLAN}&group=${G2.id}` });
    await waitFor(() => expect(sheet()).toBeTruthy());
    expect(screen.getByTestId('documents-closed').textContent).toContain(CLOSED_DOCUMENTS);
    expect(screen.getByTestId('documents-csv')).toBeTruthy();
    for (const id of ['approve', 'return', 'paper', 'submit', 'withdraw', 'file-add', 'file-remove']) expect(within(sheet()).queryByTestId(`documents-sheet-${id}`)).toBeNull();
    expect(within(sheet()).getAllByTestId('documents-sheet-file-open')).toHaveLength(2);
    expect(within(sheet()).getAllByTestId('documents-sheet-file-save')).toHaveLength(2);
    // 部門長は年度のファイルを削除できない（管理者だけ）
    expect(screen.queryByTestId('documents-delete-files')).toBeNull();
    cleanup();
    renderScreen({ role: 'head', status: 'closed', search: 'tab=settings' });
    await waitFor(() => expect(screen.getByTestId('documents-settings')).toBeTruthy());
    for (const id of ['add', 'copy', 'edit', 'delete']) expect(screen.queryByTestId(`documents-settings-${id}`)).toBeNull();
  });

  it('管理者：「この年度のファイルをすべて削除（N 件・X）」→ 確かめ（理由は任意）→ 削除と片付け →「ファイル N 件を削除しました」。その後は削除した日時', async () => {
    const user = setUser();
    renderScreen({ role: 'admin', status: 'closed' });
    await loaded();
    const button = await screen.findByTestId('documents-delete-files');
    expect(button.textContent).toBe('この年度のファイルをすべて削除（5 件・5.6 MB）');
    expect(screen.getByText(DELETE_FILES_HELP)).toBeTruthy();
    await user.click(button);
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('5 件（5.6 MB）を削除します。元に戻せません。');
    await user.type(within(confirm).getByTestId('documents-delete-files-reason'), '年度の終わりの片付け');
    await user.click(within(confirm).getByRole('button', { name: 'すべて削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ファイル 5 件を削除しました'));
    expect(rpcArgs(rpcCalls('delete_year_document_files')[0]!)).toEqual({ p_year_id: Y, p_reason: '年度の終わりの片付け' });
    // 片付けで Storage の物も消えた
    expect([...db.objects.keys()].filter((p) => p.startsWith(`${Y}/`))).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('documents-files-deleted').textContent).toBe('この年度のファイルは 2026/10/06 12:00 に削除しました'));
    expect(screen.queryByTestId('documents-delete-files')).toBeNull();
  });

  it('使った量（document_storage_usage）を読み込めなければ、黙って消さずに「ファイルの件数と大きさを読み込めませんでした」と「もう一度」（レビューの T19BC-2）', async () => {
    let fail = true;
    override = (call) => (call.table === 'rpc:document_storage_usage' && fail ? NETWORK : undefined);
    const user = setUser();
    renderScreen({ role: 'admin', status: 'closed' });
    await loaded();
    const err = await screen.findByTestId('documents-usage-error');
    expect(err.textContent).toContain('ファイルの件数と大きさを読み込めませんでした：通信できませんでした。電波の良い所でもう一度');
    expect(screen.queryByTestId('documents-delete-files')).toBeNull();
    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    expect(await screen.findByTestId('documents-delete-files')).toBeTruthy();
    expect(screen.queryByTestId('documents-usage-error')).toBeNull();
  });

  it('片付けで消せなかった物が残れば「置き場から消せなかったファイルが k 件あります」と「片付ける」', async () => {
    const user = setUser();
    // 開いたときの片付けの remove が失敗する
    let failRemove = true;
    storageOverride = (c) => (c.op === 'remove' && failRemove ? { data: null, error: storageError('500', 'InternalError') } : undefined);
    renderScreen({ role: 'admin', status: 'closed' });
    await loaded();
    await waitFor(() => expect(screen.getByText(leftoverText(1))).toBeTruthy());
    failRemove = false;
    await user.click(screen.getByTestId('documents-cleanup'));
    await waitFor(() => expect(screen.queryByText(leftoverText(1))).toBeNull());
    expect(db.objects.has(`${Y}/${G1.id}/${D_PLAN}/${uuid(399)}.pdf`)).toBe(false);
  });
});

// ---------------------------------------------------------------- 読み込む JS

describe('T19 提出状況：読み込む JS', () => {
  it('/documents は CSV・写真の作り直し・ダッシュボードの組み立てと、/document の画面を最初に読まない（押したときに読む）', () => {
    const g = staticImportGraph('app/(app)/documents/page.tsx');
    expect(g.files).toContain('components/documents/documents-screen.tsx');
    expect(g.files).not.toContain('lib/modules/documents/csv.ts');
    expect(g.files).not.toContain('lib/modules/documents/image.ts');
    expect(g.files).not.toContain('lib/modules/portal.ts');
    expect(g.files).not.toContain('components/documents/document-screen.tsx');
    expect(g.packages).not.toContain('exceljs');
  });
});
