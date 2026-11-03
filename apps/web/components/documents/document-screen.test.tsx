// @vitest-environment jsdom
// 自団体の提出物（/document）の画面（04「自団体の提出物 /document（スマホ）」「提出物」のファイルの扱い・書き込みの決まり・エラーの文言、
// notes/T19.md「パート B・C の約束」6・15。T19）。
// - カード（締切の早い順・状態の印・締切と相対の言い方・説明・差し戻しの枠・承認・代理・紙・ファイルが要らない）、空、終了した年度、
//   `?document=`、団体の選択
// - ファイル：選んだファイルの確かめ（形・中身・数・大きさ・写真の作り直し）→ 予約 → 上げる → 読み直し、失敗と「もう一度」（同じ file_id・
//   409 はもう届いていた）、予約の invalid_state で止める、too_many_orphans の片付けと予約し直し、外す（確かめ・届いていないものは確かめない）、
//   開く（先にタブ）・保存（名前）、アップロード中の離れる前の確かめ
// - 提出した・取り消す：確かめのダイアログ、成功（締切の後）、conflict、invalid_state（not_editable・no_file）、応答が届かなかったとき
//   （提出されていました・分からない・その後のもう一度）、読み直せなかったときの「読み直す」、最新でない年度の確かめ
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts の from・rpc に storage.from('documents') を足したもの）で、v_document_status・
// v_document_files の読み取りと RPC・Storage を DB と Storage API の動き（版・状態・予約した path・409・403）で小さくまねる。
// 立場は useAuth の差し替え、時計は Date だけを止める（画面を開いた時刻）。写真の作り直し（image.ts）は動的 import を偽にする。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '@/components/common/app-link';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import type { GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import {
  DOCUMENT_CONFLICT_MESSAGE,
  DOCUMENT_FILES_LOCKED_MESSAGES,
  DOCUMENT_NOT_EDITABLE_MESSAGES,
  DOCUMENT_STATE_MESSAGES,
  STORAGE_ERROR_MESSAGES,
  STORAGE_SIGN_DENIED_MESSAGE,
} from '@/lib/errors';
import {
  FILE_EMPTY_MESSAGE,
  FILE_HINT,
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
  FILES_FULL_MESSAGE,
  IMAGE_DECODE_MESSAGE,
  MAX_FILE_BYTES,
  SUBMIT_BLOCKERS,
  tooManyFilesMessage,
} from '@/lib/modules/documents/files';
import { queryKeys } from '@/lib/query';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createFakeSupabase, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { LEAVE_MESSAGES } from '@/lib/unsaved-changes';
import { NO_FILE_TEXT, RETURNED_HINT } from './document-card';
import { SAVE_BLOCKED_TEXT } from './document-file-list';
import {
  CLOSED_DOCUMENT_REP,
  DocumentScreen,
  EMPTY_DOCUMENT_REP,
  REMOVE_CONFIRM_TEXT,
  SUBMIT_CONFIRM_TEXT,
  submittedMessage,
  WITHDRAW_CONFIRM_TEXTS,
} from './document-screen';
import { fileWindow, POPUP_BLOCKED_MESSAGE } from './file-open';
import { REREAD_AGAIN_FAILED_MESSAGE, REREAD_FAILED_NOTICE, SUBMISSION_DONE_BEFORE, SUBMISSION_UNKNOWN } from './submission-write';
import { DISCARD_UNKNOWN_MESSAGE, FILE_STATE_TEXTS, UPLOADING_LEAVE_MESSAGE, UPLOADING_LEAVE_MESSAGES } from './use-document-uploader';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  client: null as unknown,
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  reloadMembership: vi.fn(),
  setYear: vi.fn(),
  /** 写真の作り直し（image.ts の reencodeJpeg の偽物） */
  reencode: vi.fn(async (file: Blob): Promise<Blob> => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'small'], { type: 'image/jpeg' }).slice(0, file.size > 0 ? 9 : 0, 'image/jpeg')),
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: 'u-rep' } } },
    reloadMembership: h.reloadMembership,
    setYear: h.setYear,
    reauthenticate: async () => false,
    isRefreshing: false,
  }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, refresh: vi.fn() }),
  usePathname: () => '/document',
  useSearchParams: () => h.params,
}));
vi.mock('next/link', () => ({
  // Next の Link と同じく、移る前に onNavigate を呼び、preventDefault されたら移らない（AppLink の未保存の入力の確かめ）
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
// 写真の作り直しは、JPEG を選んだときに動的 import される（その import も偽にする）
vi.mock('@/lib/modules/documents/image', () => ({ reencodeJpeg: (file: Blob) => h.reencode(file) }));

// jsdom にないもの（Radix の Dialog が使う）
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

// ---------------------------------------------------------------- データ

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const Y_NEXT = uuid(2);
const G1: GroupSummary = { id: uuid(11), name: '模擬店01', year_id: Y, role: 'manager' };
const G2: GroupSummary = { id: uuid(12), name: '模擬店02', year_id: Y, role: 'deputy_manager' };
/** 画面を開いた時刻：2026-10-06（火）12:00（Asia/Tokyo） */
const NOW = '2026-10-06T03:00:00Z';
const D_PLAN = uuid(101); // 未提出・ファイルが要る（締切 10/10）
const D_FOOD = uuid(102); // 差し戻し（締切 10/8）
const D_REPORT = uuid(103); // ファイルが要らない（締切 10/20）
const D_DONE = uuid(104); // 承認（紙・メモ。締切 10/1）
const D_SENT = uuid(105); // 提出済み（代理・締切の後・前回の差し戻しの理由。締切 10/3）

interface DbStatus {
  document_id: string;
  group_id: string;
  title: string;
  description: string | null;
  deadline: string;
  requires_file: boolean;
  status: 'not_submitted' | 'submitted' | 'returned' | 'approved';
  submitted_at: string | null;
  proxy: boolean;
  late: boolean;
  reviewed_at: string | null;
  review_note: string | null;
  updated_at: string | null;
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

const V0 = '2026-10-01T00:00:00.123456+00:00';
const status = (document_id: string, over: Partial<DbStatus>): DbStatus => ({
  document_id,
  group_id: G1.id,
  title: `書類${document_id.slice(-3)}`,
  description: null,
  deadline: '2026-10-10T08:00:00+00:00',
  requires_file: true,
  status: 'not_submitted',
  submitted_at: null,
  proxy: false,
  late: false,
  reviewed_at: null,
  review_note: null,
  updated_at: null,
  ...over,
});
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const pathOf = (f: Pick<DbFile, 'id' | 'document_id' | 'group_id' | 'content_type'>) => `${Y}/${f.group_id}/${f.document_id}/${f.id}.${EXT[f.content_type]}`;
const dbFile = (id: string, document_id: string, over: Partial<DbFile> = {}): DbFile => {
  const f = { id, document_id, group_id: G1.id, content_type: 'application/pdf', size: 1_258_291, created_at: '2026-10-05T08:00:00+00:00', ...over };
  return { object_path: pathOf(f), ...f };
};

function seed() {
  db.statuses = [
    status(D_PLAN, { title: '出店計画書', description: '様式は総務の共有フォルダ\n  2ページ目も忘れずに' }),
    status(D_FOOD, {
      title: '食品の届け',
      deadline: '2026-10-08T08:00:00+00:00',
      status: 'returned',
      submitted_at: '2026-10-04T01:00:00+00:00',
      reviewed_at: '2026-10-05T06:30:00+00:00',
      review_note: '印鑑がありません\n押してから出し直してください',
      updated_at: V0,
    }),
    status(D_REPORT, { title: '保健所への報告', deadline: '2026-10-20T08:00:00+00:00', requires_file: false }),
    status(D_DONE, {
      title: '誓約書',
      deadline: '2026-10-01T08:00:00+00:00',
      status: 'approved',
      reviewed_at: '2026-10-02T00:00:00+00:00',
      review_note: '10/2 に紙で受け取りました',
      updated_at: V0,
    }),
    status(D_SENT, {
      title: '電気の申請',
      deadline: '2026-10-03T08:00:00+00:00',
      status: 'submitted',
      submitted_at: '2026-10-04T00:00:00+00:00',
      proxy: true,
      late: true,
      review_note: '前の理由',
      updated_at: V0,
    }),
    status(uuid(199), { group_id: G2.id, title: 'ほかの団体の書類' }),
  ];
  db.files = [dbFile(uuid(301), D_FOOD), dbFile(uuid(302), D_SENT, { content_type: 'image/png', size: 2048 })];
  db.objects = new Map(db.files.map((f) => [f.object_path, f.size]));
}

const db = { statuses: [] as DbStatus[], files: [] as DbFile[], objects: new Map<string, number>() };
let yearStatus: YearStatus = 'requesting';
let clock = 0;
const nextAt = () => `2026-10-06T03:00:${String(++clock).padStart(2, '0')}.000000+00:00`;
const isOpen = (s: DbStatus['status']) => s === 'not_submitted' || s === 'returned';
const sameVersion = (a: string | null | undefined, b: string | null | undefined) =>
  a == null || b == null ? (a ?? null) === (b ?? null) : Date.parse(a) === Date.parse(b);
const findStatus = (d: unknown, g: unknown) => db.statuses.find((s) => s.document_id === d && s.group_id === g);

const p0001 = (message: string, details: unknown = null): FakeResult => ({
  error: { code: 'P0001', message, details: details === null ? null : JSON.stringify(details), hint: null },
  status: 400,
});
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
/** storage-js の StorageApiError（本文の statusCode・code。HTTP の status は 400） */
const storageError = (statusCode: string, code: string) => ({ __isStorageError: true, name: 'StorageApiError', message: code, status: 400, statusCode, code });

/** 提出の行（RPC の返り値。document_submissions） */
const submissionRow = (s: DbStatus) => ({
  document_id: s.document_id,
  group_id: s.group_id,
  year_id: Y,
  status: s.status,
  submitted_at: s.submitted_at,
  submitted_by: s.submitted_at ? 'u-rep' : null,
  proxy: s.proxy,
  reviewed_at: s.reviewed_at,
  reviewed_by: null,
  review_note: s.review_note,
  created_at: V0,
  updated_at: s.updated_at,
});

function rpc(name: string, a: Record<string, unknown>): FakeResult {
  if (yearStatus === 'closed' && name !== 'document_orphan_paths') return p0001('invalid_state', { status: 'closed' });
  switch (name) {
    case 'reserve_document_file': {
      const s = findStatus(a.p_document_id, a.p_group_id);
      if (!s) return p0001('not_found');
      const same = db.files.find((f) => f.id === a.p_file_id);
      if (same) {
        if (same.document_id !== a.p_document_id || same.content_type !== a.p_content_type || same.size !== a.p_size) {
          return p0001('invalid_input', { field: 'file_id', reason: 'in_use' });
        }
        return { data: { ...same, year_id: Y, created_by: 'u-rep', updated_at: same.created_at } };
      }
      if (!isOpen(s.status)) return p0001('invalid_state', { status: s.status, reason: 'not_editable' });
      const mine = db.files.filter((f) => f.document_id === s.document_id && f.group_id === s.group_id);
      if (mine.length >= 5) return p0001('invalid_state', { status: s.status, reason: 'too_many_files' });
      const f = dbFile(a.p_file_id as string, s.document_id, { content_type: a.p_content_type as string, size: a.p_size as number, created_at: nextAt() });
      db.files.push(f);
      s.updated_at = nextAt();
      return { data: { ...f, year_id: Y, created_by: 'u-rep', updated_at: f.created_at } };
    }
    case 'discard_document_file': {
      const f = db.files.find((x) => x.id === a.p_file_id);
      if (!f) return p0001('forbidden');
      const s = findStatus(f.document_id, f.group_id)!;
      if (db.objects.has(f.object_path) && !isOpen(s.status)) return p0001('invalid_state', { status: s.status, reason: 'not_editable' });
      db.files = db.files.filter((x) => x !== f);
      s.updated_at = nextAt();
      return { data: f.object_path };
    }
    case 'submit_document': {
      const s = findStatus(a.p_document_id, a.p_group_id);
      if (!s) return p0001('not_found');
      if (!isOpen(s.status)) return p0001('invalid_state', { status: s.status, reason: 'not_editable' });
      const mine = db.files.filter((f) => f.document_id === s.document_id && f.group_id === s.group_id);
      if (s.requires_file && mine.length === 0) return p0001('invalid_state', { status: s.status, reason: 'no_file' });
      if (mine.some((f) => !db.objects.has(f.object_path))) return p0001('invalid_state', { status: s.status, reason: 'not_uploaded' });
      if (!sameVersion(s.updated_at, a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: s.document_id, group_id: s.group_id });
      s.status = 'submitted';
      s.submitted_at = new Date().toISOString();
      s.late = Date.parse(s.submitted_at) > Date.parse(s.deadline);
      s.updated_at = nextAt();
      return { data: submissionRow(s) };
    }
    case 'withdraw_document': {
      const s = findStatus(a.p_document_id, a.p_group_id);
      if (!s) return p0001('not_found');
      if (s.status !== 'submitted') return p0001('invalid_state', { status: s.status, reason: 'not_editable' });
      if (!sameVersion(s.updated_at, a.p_base_updated_at as string | null)) return p0001('conflict', { document_id: s.document_id, group_id: s.group_id });
      Object.assign(s, { status: 'not_submitted', submitted_at: null, proxy: false, late: false, updated_at: nextAt() });
      return { data: submissionRow(s) };
    }
    case 'document_orphan_paths':
      return { data: [...db.objects.keys()].filter((p) => p.split('/')[1] === G1.id && !db.files.some((f) => f.object_path === p)) };
    default:
      return { error: { code: '42883', message: `知らない RPC：${name}` }, status: 404 };
  }
}

let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];
const eqOf = (call: FakeCall) => Object.fromEntries(call.ops.filter((o) => o.op === 'eq').map((o) => [o.args[0] as string, o.args[1]]));

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
  if (call.table.startsWith('rpc:')) return rpc(call.table.slice(4), (call.ops[0]!.args[0] ?? {}) as Record<string, unknown>);
  if (call.table === 'years') return { data: yearRow(yearStatus) };
  const eq = eqOf(call);
  if (call.table === 'v_document_status') {
    const rows = db.statuses
      .filter((s) => eq.year_id === Y && s.group_id === eq.group_id)
      .sort((x, y) => Date.parse(x.deadline) - Date.parse(y.deadline) || x.title.localeCompare(y.title));
    return { data: rows.map((s) => ({ ...s })) };
  }
  if (call.table === 'v_document_files') {
    const rows = db.files
      .filter((f) => eq.year_id === Y && f.group_id === eq.group_id)
      .map((f) => ({ ...f, uploaded: db.objects.has(f.object_path), stored_size: db.objects.get(f.object_path) ?? null }));
    return { data: rows };
  }
  return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
}

interface StorageCall {
  op: 'upload' | 'remove' | 'createSignedUrl';
  args: unknown[];
}
let storageCalls: StorageCall[] = [];
let storageOverride: ((c: StorageCall) => Promise<unknown> | unknown | undefined) | null = null;

/** Storage API の動き：予約した path にだけ上げられる（書ける提出・申告以下の大きさ）、同じ path の2回目は 409、行のある物は消えない */
async function storageOp(op: StorageCall['op'], args: unknown[]): Promise<unknown> {
  const c = { op, args };
  storageCalls.push(c);
  const o = storageOverride?.(c);
  if (o !== undefined) return o;
  if (op === 'upload') {
    const [path, blob] = args as [string, Blob];
    if (db.objects.has(path)) return { data: null, error: storageError('409', 'KeyAlreadyExists') };
    const f = db.files.find((x) => x.object_path === path);
    const s = f && findStatus(f.document_id, f.group_id);
    if (!f || !s || !isOpen(s.status) || yearStatus === 'closed' || blob.size > f.size) return { data: null, error: storageError('403', 'AccessDenied') };
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

const yearRow = (s: YearStatus): YearRow => ({
  id: Y,
  label: 'R8',
  status: s,
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: null,
  updated_at: 't',
});

function member(groups: GroupSummary[], s: YearStatus, latest = true): Membership {
  const year = { id: Y, label: 'R8', status: s, festival_start: '2026-10-17' };
  const next = { id: Y_NEXT, label: 'R9', status: 'preparing' as const, festival_start: '2027-10-16' };
  return {
    displayName: 'テスト',
    year,
    role: null,
    groups,
    years: latest ? [year] : [next, year],
    latestYear: latest ? year : next,
    adminOfOpenYear: false,
  };
}

function Probe() {
  const setYear = useGuardedSetYear();
  return (
    <>
      <AppLink href="/notices" data-testid="probe-nav">
        お知らせ一覧
      </AppLink>
      <button type="button" data-testid="probe-year" onClick={() => void setYear(Y_NEXT)}>
        年度
      </button>
    </>
  );
}

function renderScreen(opts: { groups?: GroupSummary[]; status?: YearStatus; search?: string; latest?: boolean } = {}) {
  yearStatus = opts.status ?? 'requesting';
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(opts.groups ?? [G1], yearStatus, opts.latest ?? true) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(yearStatus));
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider>
        <Probe />
        <DocumentScreen />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const cards = () => screen.queryAllByTestId('document-card');
const cardOf = (id: string) => cards().find((c) => c.getAttribute('data-document-id') === id)!;
const filesOf = (id: string) => within(cardOf(id)).queryAllByTestId('document-file');
const loaded = () => waitFor(() => expect(cards().length).toBeGreaterThan(0));
const setUser = () => userEvent.setup({ advanceTimers: () => {} });
const rpcCalls = (name: string) => issued.filter((c) => c.table === `rpc:${name}`);
const rpcArgs = (c: FakeCall) => c.ops[0]!.args[0] as Record<string, unknown>;
const storageOf = (op: StorageCall['op']) => storageCalls.filter((c) => c.op === op);
const reads = () => issued.filter((c) => c.table === 'v_document_status').length;

const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]; // %PDF-1.7
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const fileOf = (head: number[], size: number, type = 'application/pdf', name = 'scan.pdf') => {
  const bytes = new Uint8Array(size);
  bytes.set(head.slice(0, size));
  return new File([bytes], name, { type });
};
const pdf = (size = 4000) => fileOf(PDF_HEAD, size);

/** カードの「ファイルを追加」の input にファイルを選ぶ（hidden の input に直接 change を送る） */
function choose(documentId: string, files: File[]) {
  const input = within(cardOf(documentId)).getByTestId('document-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  seed();
  clock = 0;
  override = null;
  storageOverride = null;
  storageCalls = [];
  h.client = makeClient();
  h.reencode.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- カード

describe('T19 自団体の提出物：カード', () => {
  it('h1・団体の名前・最終読み込みと「読み直す」。カードは締切の早い順で、その団体の分だけ（2本を並行に読む）', async () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('自団体の提出物');
    await loaded();
    expect(screen.getByTestId('document-group-name').textContent).toBe('模擬店01');
    expect(screen.getByText(/最終読み込み/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy();
    expect(cards().map((c) => c.getAttribute('data-document-id'))).toEqual([D_DONE, D_SENT, D_FOOD, D_PLAN, D_REPORT]);
    expect(screen.queryByText('ほかの団体の書類')).toBeNull();
    const views = issued.filter((c) => c.table === 'v_document_status' || c.table === 'v_document_files');
    expect(views.map((c) => [c.table, eqOf(c)])).toEqual([
      ['v_document_status', { year_id: Y, group_id: G1.id }],
      ['v_document_files', { year_id: Y, group_id: G1.id }],
    ]);
    // 団体が1つなら団体の選択は出さない
    expect(screen.queryByTestId('document-group-select')).toBeNull();
  });

  it('未提出：題名・状態・締切（相対の言い方）・説明（改行を残す）・ファイルの追加と説明・押せない「提出した」と理由', async () => {
    renderScreen();
    await loaded();
    const c = cardOf(D_PLAN);
    expect(c.getAttribute('data-status')).toBe('not_submitted');
    expect(c.getAttribute('data-late')).toBe('false');
    expect(within(c).getByTestId('document-card-title').textContent).toBe('出店計画書');
    expect(within(c).getByTestId('document-card-status').textContent).toBe('未提出');
    const deadline = within(c).getByTestId('document-card-deadline');
    expect(deadline.textContent).toBe('締切 10/10（土）17:00あと 4 日');
    expect(deadline.getAttribute('data-overdue')).toBe('false');
    const desc = within(c).getByTestId('document-card-description');
    expect(desc.textContent).toBe('様式は総務の共有フォルダ\n  2ページ目も忘れずに');
    expect(desc.className).toContain('whitespace-pre-wrap');
    expect(within(c).queryByTestId('document-card-no-file')).toBeNull();
    expect(within(c).getByTestId('document-file-add').textContent).toBe('ファイルを追加');
    expect(within(c).getByTestId('document-file-hint').textContent).toBe(FILE_HINT);
    const input = within(c).getByTestId('document-file-input');
    expect(input.getAttribute('accept')).toBe('application/pdf,image/jpeg,image/png');
    expect(input.hasAttribute('multiple')).toBe(true);
    const submit = within(c).getByTestId('document-submit') as HTMLButtonElement;
    expect(submit.textContent).toBe('提出した');
    expect(submit.disabled).toBe(true);
    expect(within(c).getByTestId('document-submit-hint').textContent).toBe(SUBMIT_BLOCKERS.noFile);
    expect(within(c).queryByTestId('document-withdraw')).toBeNull();
  });

  it('差し戻し：目立つ枠に日時・理由（改行を残す）・直してからの文。ファイルは外せて、締切を過ぎていなければ注意の色にしない', async () => {
    renderScreen();
    await loaded();
    const c = cardOf(D_FOOD);
    expect(within(c).getByTestId('document-card-status').textContent).toBe('差し戻し');
    const box = within(c).getByTestId('document-returned');
    expect(box.textContent).toContain('差し戻されました（10/5 15:30）');
    expect(within(box).getByTestId('document-returned-reason').textContent).toBe('理由：印鑑がありません\n押してから出し直してください');
    expect(box.textContent).toContain(RETURNED_HINT);
    expect(within(c).getByTestId('document-card-deadline').textContent).toBe('締切 10/8（木）17:00あと 2 日');
    const [f] = filesOf(D_FOOD);
    expect(f!.getAttribute('data-state')).toBe('uploaded');
    expect(within(f!).getByTestId('document-file-label').textContent).toBe('ファイル 1（PDF・1.2 MB・10/5 17:00）');
    expect(within(f!).getByTestId('document-file-open')).toBeTruthy();
    expect(within(f!).getByTestId('document-file-save')).toBeTruthy();
    expect(within(f!).getByTestId('document-file-remove')).toBeTruthy();
    expect((within(c).getByTestId('document-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(within(c).queryByTestId('document-submit-hint')).toBeNull();
  });

  it('提出済み：提出の日時・前回の差し戻しの理由・代理・締切の後。ファイルは外せず、「提出を取り消す」だけ', async () => {
    renderScreen();
    await loaded();
    const c = cardOf(D_SENT);
    expect(c.getAttribute('data-late')).toBe('true');
    expect(within(c).getByTestId('document-card-status').textContent).toBe('提出済み（総務の確認待ち）');
    expect(within(c).getByTestId('document-card-late').textContent).toBe('締切の後');
    expect(within(c).getByTestId('document-submitted-at').textContent).toBe('提出しました（10/4 09:00）');
    expect(within(c).getByTestId('document-previous-reason').textContent).toBe('前回の差し戻しの理由：前の理由');
    expect(within(c).getByTestId('document-card-proxy').textContent).toBe('総務が代わりに提出しました');
    // 締切は過ぎているが、提出済みなので注意の印は付けない（相対の言い方は出す）
    const deadline = within(c).getByTestId('document-card-deadline');
    expect(deadline.textContent).toContain('締切を過ぎました');
    expect(deadline.getAttribute('data-overdue')).toBe('false');
    const [f] = filesOf(D_SENT);
    expect(within(f!).getByTestId('document-file-label').textContent).toBe('ファイル 1（PNG・2 KB・10/5 17:00）');
    expect(within(f!).queryByTestId('document-file-remove')).toBeNull();
    expect(within(c).queryByTestId('document-file-add')).toBeNull();
    expect(within(c).queryByTestId('document-submit')).toBeNull();
    expect(within(c).getByTestId('document-withdraw').textContent).toBe('提出を取り消す');
  });

  it('承認（紙などで受け取った）：承認の日時とメモ・紙の文。操作は出さない。ファイルが要らない提出物の文', async () => {
    renderScreen();
    await loaded();
    const c = cardOf(D_DONE);
    expect(within(c).getByTestId('document-card-status').textContent).toBe('承認');
    expect(within(c).getByTestId('document-approved').textContent).toContain('承認されました（10/2 09:00）');
    expect(within(c).getByTestId('document-approved-note').textContent).toBe('メモ：10/2 に紙で受け取りました');
    expect(within(c).getByTestId('document-card-paper').textContent).toBe('紙などで受け取りました');
    expect(within(c).queryByRole('button')).toBeNull();
    const r = cardOf(D_REPORT);
    expect(within(r).getByTestId('document-card-no-file').textContent).toBe(NO_FILE_TEXT);
    expect((within(r).getByTestId('document-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('未提出・差し戻しで締切を過ぎていれば注意の印（締切ちょうどは過ぎた側）。「読み直す」を押した時刻で決め直す', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    expect(within(cardOf(D_FOOD)).getByTestId('document-card-deadline').getAttribute('data-overdue')).toBe('false');
    vi.setSystemTime(new Date('2026-10-08T08:00:00Z'));
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-card-deadline').getAttribute('data-overdue')).toBe('true'));
    expect(within(cardOf(D_FOOD)).getByTestId('document-card-deadline').textContent).toContain('締切を過ぎました');
    expect(within(cardOf(D_PLAN)).getByTestId('document-card-deadline').textContent).toContain('あと 2 日');
  });

  it('`?document=` のカードを目立たせる（ない・形の違う値なら何もしない）', async () => {
    renderScreen({ search: `document=${D_FOOD}` });
    await loaded();
    expect(cardOf(D_FOOD).getAttribute('data-highlighted')).toBe('true');
    expect(cards().filter((c) => c.getAttribute('data-highlighted') === 'true')).toHaveLength(1);
    cleanup();
    renderScreen({ search: 'document=xyz' });
    await loaded();
    expect(cards().filter((c) => c.getAttribute('data-highlighted') === 'true')).toHaveLength(0);
  });

  it('対象の提出物がなければ空の文', async () => {
    db.statuses = [];
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('document-empty').textContent).toContain(EMPTY_DOCUMENT_REP));
  });

  it('2つの団体：`?group=` の団体を読み、選択を変えると URL を置き換える（合わない値は最初の団体）', async () => {
    const user = setUser();
    renderScreen({ groups: [G1, G2], search: `group=${G2.id}` });
    await waitFor(() => expect(screen.getByTestId('document-group-name').textContent).toBe('模擬店02'));
    await waitFor(() => expect(cards().map((c) => within(c).getByTestId('document-card-title').textContent)).toEqual(['ほかの団体の書類']));
    const select = screen.getByTestId('document-group-select') as HTMLSelectElement;
    expect(select.value).toBe(G2.id);
    await user.selectOptions(select, G1.id);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(`/document?group=${G1.id}`, undefined));
    cleanup();
    renderScreen({ groups: [G1, G2], search: 'group=other' });
    await waitFor(() => expect(screen.getByTestId('document-group-name').textContent).toBe('模擬店01'));
  });

  it('終了した年度：帯を出し、ファイルを足す・外す・提出・取り消しを出さない（開く・保存は出す）', async () => {
    renderScreen({ status: 'closed' });
    await loaded();
    expect(screen.getByTestId('document-closed').textContent).toBe(CLOSED_DOCUMENT_REP);
    for (const id of [D_PLAN, D_FOOD, D_SENT, D_REPORT]) {
      const c = cardOf(id);
      expect(within(c).queryByTestId('document-file-add')).toBeNull();
      expect(within(c).queryByTestId('document-file-remove')).toBeNull();
      expect(within(c).queryByTestId('document-submit')).toBeNull();
      expect(within(c).queryByTestId('document-withdraw')).toBeNull();
    }
    expect(within(cardOf(D_FOOD)).getByTestId('document-file-open')).toBeTruthy();
    expect(within(cardOf(D_FOOD)).getByTestId('document-file-save')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- ファイル

describe('T19 自団体の提出物：ファイルを足す', () => {
  it('予約 → 上げる（upsert: false）→ 読み直し。予約の形・大きさは選んだ物、path は予約が返したもの。アップロード中は操作を止める', async () => {
    let release: () => void = () => {};
    storageOverride = (c) => {
      if (c.op !== 'upload') return undefined;
      return new Promise((resolve) => {
        release = () => {
          storageOverride = null;
          resolve(storageOp('upload', c.args).then((r) => (storageCalls.pop(), r)));
        };
      });
    };
    renderScreen();
    await loaded();
    const before = reads();
    choose(D_PLAN, [pdf(4000)]);
    const c = () => cardOf(D_PLAN);
    await waitFor(() => expect(within(c()).getByTestId('document-uploading').textContent).toContain('アップロード中…（1/1）'));
    expect(within(c()).getByTestId('document-uploading').textContent).toContain(UPLOADING_LEAVE_MESSAGE);
    expect((within(c()).getByTestId('document-file-add') as HTMLButtonElement).disabled).toBe(true);
    expect(within(c()).getByTestId('document-submit-hint').textContent).toBe(SUBMIT_BLOCKERS.uploading);
    const [reserve] = rpcCalls('reserve_document_file');
    const args = rpcArgs(reserve!);
    expect(args).toMatchObject({ p_document_id: D_PLAN, p_group_id: G1.id, p_content_type: 'application/pdf', p_size: 4000 });
    expect(args.p_file_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [up] = storageOf('upload');
    expect(up!.args[0]).toBe(`${Y}/${G1.id}/${D_PLAN}/${args.p_file_id as string}.pdf`);
    expect(up!.args[2]).toEqual({ contentType: 'application/pdf', upsert: false });
    await act(async () => release());
    await waitFor(() => expect(within(c()).queryByTestId('document-uploading')).toBeNull());
    expect(reads()).toBeGreaterThan(before);
    const [f] = filesOf(D_PLAN);
    expect(f!.getAttribute('data-state')).toBe('uploaded');
    expect(within(f!).getByTestId('document-file-label').textContent).toBe('ファイル 1（PDF・4 KB・10/6 12:00）');
    expect((within(c()).getByTestId('document-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('読み上げ：カードに1つの role="status" をいつも置き、中身だけを変える。上げているファイルは行として出し、終わったら「ファイル N つをアップロードしました」（レビューの UX-2）', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    storageOverride = (c) => {
      if (c.op !== 'upload') return undefined;
      return new Promise((resolve) => {
        gate.release = () => {
          storageOverride = null;
          resolve(storageOp('upload', c.args).then((r) => (storageCalls.pop(), r)));
        };
      });
    };
    renderScreen();
    await loaded();
    const region = within(cardOf(D_PLAN)).getByRole('status');
    expect(region.textContent).toBe('');
    choose(D_PLAN, [pdf(4000)]);
    await waitFor(() => expect(within(cardOf(D_PLAN)).getByRole('status').textContent).toContain('アップロード中…（1/1）'));
    // 差し込み直さない（同じ要素の中身だけが変わる）
    expect(within(cardOf(D_PLAN)).getByRole('status')).toBe(region);
    // 上げているファイルは、届く前から行として出す（番号・形・大きさと「アップロード中…」。開く・保存・外すは出さない）
    await waitFor(() => expect(filesOf(D_PLAN)).toHaveLength(1));
    const [pending] = filesOf(D_PLAN);
    expect(pending!.getAttribute('data-state')).toBe('uploading');
    expect(within(pending!).getByTestId('document-file-label').textContent).toBe('ファイル 1（PDF・4 KB）');
    expect(pending!.textContent).toContain(FILE_STATE_TEXTS.uploading);
    expect(within(pending!).queryByTestId('document-file-open')).toBeNull();
    expect(within(pending!).queryByTestId('document-file-remove')).toBeNull();
    await waitFor(() => expect(gate.release).not.toBeNull());
    await act(async () => gate.release!());
    await waitFor(() => expect(within(cardOf(D_PLAN)).queryByTestId('document-uploading')).toBeNull());
    expect(within(cardOf(D_PLAN)).getByRole('status')).toBe(region);
    expect(region.textContent).toBe('');
    expect(toast.success).toHaveBeenCalledWith('ファイル 1 つをアップロードしました');
    expect(filesOf(D_PLAN).map((f) => f.getAttribute('data-state'))).toEqual(['uploaded']);
    expect(within(filesOf(D_PLAN)[0]!).getByTestId('document-file-label').textContent).toBe('ファイル 1（PDF・4 KB・10/6 12:00）');
  });

  it('上げている間は、どのカードの「保存」も押せず理由を出す（ページを離れる確かめを出さない）。「開く」は押せる。終われば押せる（レビューの F2）', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    storageOverride = (c) => (c.op === 'upload' ? new Promise((r) => (gate.release = () => r({ data: {}, error: null }))) : undefined);
    const assign = vi.spyOn(fileWindow, 'assign').mockImplementation(() => {});
    renderScreen();
    await loaded();
    const saveOf = () => within(filesOf(D_FOOD)[0]!).getByTestId('document-file-save') as HTMLButtonElement;
    expect(saveOf().disabled).toBe(false);
    choose(D_PLAN, [pdf(100)]);
    await waitFor(() => expect(saveOf().disabled).toBe(true));
    expect(within(cardOf(D_FOOD)).getByText(SAVE_BLOCKED_TEXT)).toBeTruthy();
    expect(saveOf().getAttribute('aria-describedby')).toBeTruthy();
    expect((within(filesOf(D_FOOD)[0]!).getByTestId('document-file-open') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveOf());
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(gate.release).not.toBeNull());
    await act(async () => gate.release!());
    await waitFor(() => expect(saveOf().disabled).toBe(false));
    expect(within(cardOf(D_FOOD)).queryByText(SAVE_BLOCKED_TEXT)).toBeNull();
  });

  it('複数を選んだ順に1つずつ（PDF・PNG はそのまま、JPEG は作り直した物を送り、予約の size は作り直した大きさ）', async () => {
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(3000), fileOf(PNG_HEAD, 2000, 'image/png', 'a.png'), fileOf(JPEG_HEAD, 900_000, 'image/jpeg', 'b.jpg')]);
    await waitFor(() => expect(filesOf(D_PLAN)).toHaveLength(3));
    expect(h.reencode).toHaveBeenCalledTimes(1);
    expect(rpcCalls('reserve_document_file').map((c) => [rpcArgs(c).p_content_type, rpcArgs(c).p_size])).toEqual([
      ['application/pdf', 3000],
      ['image/png', 2000],
      ['image/jpeg', 9],
    ]);
    expect(storageOf('upload').map((c) => (c.args[1] as Blob).size)).toEqual([3000, 2000, 9]);
    await waitFor(() => expect(filesOf(D_PLAN).map((f) => f.getAttribute('data-state'))).toEqual(['uploaded', 'uploaded', 'uploaded']));
    expect(toast.success).toHaveBeenCalledWith('ファイル 3 つをアップロードしました');
  });

  it('選んだファイルの確かめ：形（先頭のバイト）・中身・数・大きさ・写真が読めない。1つでも合わなければどれも送らない', async () => {
    renderScreen();
    await loaded();
    const err = () => within(cardOf(D_PLAN)).getByTestId('document-file-error').textContent;
    // 名前と形は PDF でも中身が PDF でない
    choose(D_PLAN, [pdf(100), fileOf([0x50, 0x4b, 0x03, 0x04], 100, 'application/pdf', 'x.pdf')]);
    await waitFor(() => expect(err()).toBe(FILE_TYPE_MESSAGE));
    choose(D_PLAN, [new File([], 'empty.pdf', { type: 'application/pdf' })]);
    await waitFor(() => expect(err()).toBe(FILE_EMPTY_MESSAGE));
    choose(D_PLAN, Array.from({ length: 6 }, () => pdf(100)));
    await waitFor(() => expect(err()).toBe(tooManyFilesMessage(5)));
    choose(D_PLAN, [fileOf(PNG_HEAD, MAX_FILE_BYTES + 1, 'image/png', 'big.png')]);
    await waitFor(() => expect(err()).toBe(FILE_SIZE_MESSAGE));
    h.reencode.mockRejectedValueOnce(new Error('decode'));
    choose(D_PLAN, [pdf(100), fileOf(JPEG_HEAD, 100, 'image/jpeg', 'p.jpg')]);
    await waitFor(() => expect(err()).toBe(IMAGE_DECODE_MESSAGE));
    expect(rpcCalls('reserve_document_file')).toHaveLength(0);
    expect(storageOf('upload')).toHaveLength(0);
    // ファイルの名前はどこにも出さない
    expect(cardOf(D_PLAN).textContent).not.toContain('.pdf');
  });

  it('数はその提出のファイル（届いていないもの・失敗を含む）と合わせて 5 つまで。5 つあれば「ファイルを追加」を押せない', async () => {
    db.files.push(...[1, 2, 3, 4].map((k) => dbFile(uuid(400 + k), D_FOOD)));
    for (const f of db.files) db.objects.set(f.object_path, f.size);
    renderScreen();
    await loaded();
    const c = cardOf(D_FOOD);
    expect(filesOf(D_FOOD)).toHaveLength(5);
    expect((within(c).getByTestId('document-file-add') as HTMLButtonElement).disabled).toBe(true);
    expect(within(c).getByTestId('document-file-hint').textContent).toBe(FILES_FULL_MESSAGE);
  });

  it('通信が切れた：「アップロードできませんでした」と「もう一度」「外す」。もう一度は同じ file_id で予約し直し、409 はもう届いていた', async () => {
    storageOverride = (c) => (c.op === 'upload' ? { data: null, error: { __isStorageError: true, name: 'StorageUnknownError', message: 'x', originalError: new TypeError('Failed to fetch') } } : undefined);
    const user = setUser();
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(500)]);
    await waitFor(() => expect(filesOf(D_PLAN)[0]?.getAttribute('data-state')).toBe('failed'));
    const f = filesOf(D_PLAN)[0]!;
    expect(f.textContent).toContain(FILE_STATE_TEXTS.failed);
    expect(within(cardOf(D_PLAN)).getByTestId('document-file-error').textContent).toBe('通信できませんでした。電波の良い所でもう一度');
    expect(within(cardOf(D_PLAN)).getByTestId('document-submit-hint').textContent).toBe(SUBMIT_BLOCKERS.notUploaded);
    expect(within(f).getByTestId('document-file-remove')).toBeTruthy();
    const fileId = rpcArgs(rpcCalls('reserve_document_file')[0]!).p_file_id;
    // 実は届いていた（応答だけが切れた）。もう一度は同じ file_id・同じ path で、409 は成功と同じ
    const path = storageOf('upload')[0]!.args[0] as string;
    db.objects.set(path, 500);
    storageOverride = null;
    await user.click(within(f).getByTestId('document-file-retry'));
    await waitFor(() => expect(filesOf(D_PLAN)[0]?.getAttribute('data-state')).toBe('uploaded'));
    const again = rpcCalls('reserve_document_file');
    expect(again).toHaveLength(2);
    expect(rpcArgs(again[1]!).p_file_id).toBe(fileId);
    expect(storageOf('upload').map((c) => c.args[0])).toEqual([path, path]);
    expect(within(cardOf(D_PLAN)).queryByTestId('document-file-error')).toBeNull();
    expect(db.files.filter((x) => x.document_id === D_PLAN)).toHaveLength(1);
  });

  it('Storage が拒んだ（403）：失敗の印と文言、年度の行と立場を読み直す。次のファイルは送る', async () => {
    let n = 0;
    storageOverride = (c) => (c.op === 'upload' && n++ === 0 ? { data: null, error: storageError('403', 'AccessDenied') } : undefined);
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(100), pdf(200)]);
    await waitFor(() => expect(filesOf(D_PLAN).map((f) => f.getAttribute('data-state'))).toEqual(['failed', 'uploaded']));
    expect(within(cardOf(D_PLAN)).getByTestId('document-file-error').textContent).toBe(STORAGE_ERROR_MESSAGES.storage_denied);
    expect(h.reloadMembership).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('ファイル 1 つをアップロードしました');
  });

  it('予約が invalid_state（ほかの人が提出した）：残りは送らずに止め、読み直して今の状態を出す', async () => {
    db.statuses.find((s) => s.document_id === D_PLAN)!.status = 'submitted';
    db.statuses.find((s) => s.document_id === D_PLAN)!.submitted_at = '2026-10-06T02:00:00Z';
    // 画面は未提出のまま読んでいる
    override = (call) => {
      if (call.table !== 'v_document_status' || reads() > 1) return undefined;
      return { data: db.statuses.filter((s) => s.group_id === G1.id).map((s) => (s.document_id === D_PLAN ? { ...s, status: 'not_submitted', submitted_at: null } : { ...s })) };
    };
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(100), pdf(200)]);
    await waitFor(() => expect(cardOf(D_PLAN).getAttribute('data-status')).toBe('submitted'));
    expect(rpcCalls('reserve_document_file')).toHaveLength(1);
    expect(storageOf('upload')).toHaveLength(0);
    expect(within(cardOf(D_PLAN)).getByTestId('document-file-error').textContent).toBe(DOCUMENT_FILES_LOCKED_MESSAGES.submitted);
    expect(filesOf(D_PLAN)).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('予約が too_many_orphans：document_orphan_paths の path を消してから、同じ file_id で予約し直す（GET で読む）', async () => {
    const orphan = `${Y}/${G1.id}/${D_PLAN}/${uuid(999)}.pdf`;
    db.objects.set(orphan, 10);
    let first = true;
    override = (call) => {
      if (call.table === 'rpc:reserve_document_file' && first) {
        first = false;
        return p0001('invalid_state', { status: 'not_submitted', reason: 'too_many_orphans' });
      }
      return undefined;
    };
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(100)]);
    await waitFor(() => expect(filesOf(D_PLAN)[0]?.getAttribute('data-state')).toBe('uploaded'));
    const reserves = rpcCalls('reserve_document_file');
    expect(reserves).toHaveLength(2);
    expect(rpcArgs(reserves[1]!).p_file_id).toBe(rpcArgs(reserves[0]!).p_file_id);
    expect(rpcCalls('document_orphan_paths')).toHaveLength(1);
    expect(storageOf('remove').map((c) => c.args[0])).toEqual([[orphan]]);
    expect(db.objects.has(orphan)).toBe(false);
  });

  it('アップロード中に離れる・年度を切り替えるときは「アップロード中です。離れると、残りのファイルは送られません」で確かめる（下書きの文は出さない。やめれば移らない）', async () => {
    let release: () => void = () => {};
    storageOverride = (c) => (c.op === 'upload' ? new Promise((r) => (release = () => r({ data: {}, error: null }))) : undefined);
    const user = setUser();
    renderScreen();
    await loaded();
    choose(D_PLAN, [pdf(100)]);
    await waitFor(() => expect(within(cardOf(D_PLAN)).getByTestId('document-uploading')).toBeTruthy());
    fireEvent.click(screen.getByTestId('probe-nav'));
    const leave = await screen.findByRole('alertdialog');
    expect(within(leave).getByRole('heading').textContent).toBe(UPLOADING_LEAVE_MESSAGES.navigate.title);
    expect(leave.textContent).toContain('離れると、残りのファイルは送られません。');
    expect(leave.textContent).not.toContain('下書き');
    expect(leave.textContent).not.toContain(LEAVE_MESSAGES.navigate.title);
    expect(within(leave).getByRole('button', { name: '移る' })).toBeTruthy();
    await user.click(within(leave).getByRole('button', { name: 'やめる（アップロードを続ける）' }));
    expect(h.push).not.toHaveBeenCalled();
    // 年度の切り替えも同じ文（ボタンは「切り替える」）。やめれば切り替えない
    await user.click(screen.getByTestId('probe-year'));
    const year = await screen.findByRole('alertdialog');
    expect(within(year).getByRole('heading').textContent).toBe(UPLOADING_LEAVE_MESSAGES.year.title);
    expect(year.textContent).toContain('離れると、残りのファイルは送られません。');
    expect(year.textContent).not.toContain('下書き');
    await user.click(within(year).getByRole('button', { name: 'やめる（アップロードを続ける）' }));
    expect(h.setYear).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(within(cardOf(D_PLAN)).queryByTestId('document-uploading')).toBeNull());
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(h.push).toHaveBeenCalledWith('/notices');
  });
});

describe('T19 自団体の提出物：外す・開く・保存', () => {
  it('届いたファイルは確かめてから外す（discard → すぐ remove → 読み直し）', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const [f] = filesOf(D_FOOD);
    const path = db.files.find((x) => x.document_id === D_FOOD)!.object_path;
    await user.click(within(f!).getByTestId('document-file-remove'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('ファイル 1 を外しますか');
    expect(dialog.textContent).toContain(REMOVE_CONFIRM_TEXT);
    expect(within(dialog).getByTestId('document-remove-confirm')).toBeTruthy();
    expect(rpcCalls('discard_document_file')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(filesOf(D_FOOD)).toHaveLength(0));
    expect(rpcArgs(rpcCalls('discard_document_file')[0]!)).toEqual({ p_file_id: uuid(301) });
    expect(storageOf('remove').map((c) => c.args[0])).toEqual([[path]]);
    expect(db.objects.has(path)).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('ファイル 1 を外しました');
  });

  it('外すの応答が届かず、読み直してもある：確かめを開いたまま「外せたか分かりません」', async () => {
    override = (call) => (call.table === 'rpc:discard_document_file' ? NETWORK : undefined);
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-remove'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(DISCARD_UNKNOWN_MESSAGE));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(filesOf(D_FOOD)).toHaveLength(1);
  });

  it('届いていないファイル（ほかのタブの予約）は「届いていません」と「外す」。確かめずに外す', async () => {
    db.files.push(dbFile(uuid(310), D_PLAN));
    const user = setUser();
    renderScreen();
    await loaded();
    const [f] = filesOf(D_PLAN);
    expect(f!.getAttribute('data-state')).toBe('missing');
    expect(f!.textContent).toContain(FILE_STATE_TEXTS.missing);
    expect(within(f!).queryByTestId('document-file-open')).toBeNull();
    expect(within(cardOf(D_PLAN)).getByTestId('document-submit-hint').textContent).toBe(SUBMIT_BLOCKERS.notUploaded);
    await user.click(within(f!).getByTestId('document-file-remove'));
    await waitFor(() => expect(filesOf(D_PLAN)).toHaveLength(0));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rpcCalls('discard_document_file')).toHaveLength(1);
  });

  it('提出済みの届いていないファイルも外せる（状態によらない）。届いたファイルの外すが止められたら文言と読み直し', async () => {
    db.files.push(dbFile(uuid(311), D_SENT));
    // 画面が読んだ後に、ほかの人が提出した（届いたファイルは外せない）
    const user = setUser();
    renderScreen();
    await loaded();
    const pending = filesOf(D_SENT).find((f) => f.getAttribute('data-state') === 'missing')!;
    await user.click(within(pending).getByTestId('document-file-remove'));
    await waitFor(() => expect(filesOf(D_SENT)).toHaveLength(1));

    db.statuses.find((s) => s.document_id === D_FOOD)!.status = 'submitted';
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-remove'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    expect(within(cardOf(D_FOOD)).getByTestId('document-file-error').textContent).toBe(DOCUMENT_FILES_LOCKED_MESSAGES.submitted);
    expect(filesOf(D_FOOD)).toHaveLength(1);
  });

  it('開く：押したときに先に空のタブを開き（opener を外す）、署名つき URL（60 秒）を入れる。開けなければ知らせる', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(fileWindow, 'openBlank').mockReturnValue(tab as unknown as Window);
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-open'));
    await waitFor(() => expect(tab.location.href).toContain('https://storage.test/sign/'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.opener).toBeNull();
    const [sign] = storageOf('createSignedUrl');
    expect(sign!.args.slice(0, 2)).toEqual([db.files[0]!.object_path, 60]);
    expect(sign!.args[2]).toBeUndefined();
    // URL は画面のどこにも残さない
    expect(document.body.innerHTML).not.toContain('storage.test');

    open.mockReturnValue(null);
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-open'));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-file-error').textContent).toBe(POPUP_BLOCKED_MESSAGE));
    expect(storageOf('createSignedUrl')).toHaveLength(1);

    // URL を作れない（消された）：タブを閉じて知らせ、読み直す
    open.mockReturnValue(tab as unknown as Window);
    db.objects.clear();
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-open'));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-file-error').textContent).toBe(STORAGE_ERROR_MESSAGES.storage_missing));
    expect(tab.close).toHaveBeenCalled();
  });

  it('開く・保存が 403（立場が変わった・ログインが切れた）→「ファイルを開けませんでした。立場が変わった可能性があります」（アップロードとは言わない。レビューの UX-4）', async () => {
    storageOverride = (c) => (c.op === 'createSignedUrl' ? { data: null, error: storageError('403', 'AccessDenied') } : undefined);
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(fileWindow, 'openBlank').mockReturnValue(tab as unknown as Window);
    const assign = vi.spyOn(fileWindow, 'assign').mockImplementation(() => {});
    const user = setUser();
    renderScreen();
    await loaded();
    const err = () => within(cardOf(D_FOOD)).getByTestId('document-file-error').textContent;
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-open'));
    await waitFor(() => expect(err()).toBe(STORAGE_SIGN_DENIED_MESSAGE));
    expect(err()).not.toContain('アップロード');
    expect(tab.close).toHaveBeenCalled();
    // 立場を読み直す（forbidden）
    expect(h.reloadMembership).toHaveBeenCalled();
    await user.click(within(filesOf(D_FOOD)[0]!).getByTestId('document-file-save'));
    await waitFor(() => expect(storageOf('createSignedUrl')).toHaveLength(2));
    await waitFor(() => expect(err()).toBe(STORAGE_SIGN_DENIED_MESSAGE));
    expect(assign).not.toHaveBeenCalled();
  });

  it('保存：「{提出物}_{団体}_{n}.{拡張子}」の download つきの署名つき URL へ移る', async () => {
    const assign = vi.spyOn(fileWindow, 'assign').mockImplementation(() => {});
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(within(filesOf(D_SENT)[0]!).getByTestId('document-file-save'));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const [sign] = storageOf('createSignedUrl');
    expect(sign!.args[1]).toBe(60);
    // 名前は storage-js に渡さず、返った URL に一度だけ符号化して足す（storage-js 2.118 は download を二重に符号化するため）
    expect(sign!.args[2]).toBeUndefined();
    expect(new URL(assign.mock.calls[0]![0] as string).searchParams.getAll('download')).toEqual(['電気の申請_模擬店01_1.png']);
  });
});

// ---------------------------------------------------------------- 提出・取り消し

async function submitCard(user: ReturnType<typeof setUser>, documentId: string) {
  await user.click(within(cardOf(documentId)).getByTestId('document-submit'));
  return screen.findByRole('alertdialog');
}

describe('T19 自団体の提出物：提出した・取り消す', () => {
  it('確かめのダイアログ（ファイルの数）→ submit_document（版はカードの updated_at）→ 読み直して提出済み・「提出を取り消す」', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const dialog = await submitCard(user, D_FOOD);
    expect(dialog.textContent).toContain('「食品の届け」を提出しますか');
    expect(dialog.textContent).toContain(SUBMIT_CONFIRM_TEXT);
    expect(within(dialog).getByTestId('document-submit-confirm').textContent).toBe('ファイル 1 つを提出します。');
    await user.click(within(dialog).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    expect(rpcArgs(rpcCalls('submit_document')[0]!)).toEqual({ p_document_id: D_FOOD, p_group_id: G1.id, p_base_updated_at: V0 });
    expect(toast.success).toHaveBeenCalledWith('「食品の届け」を提出しました');
    expect(within(cardOf(D_FOOD)).getByTestId('document-withdraw')).toBeTruthy();
    // 前の差し戻しの理由は、前回の差し戻しの理由として小さく出る
    expect(within(cardOf(D_FOOD)).getByTestId('document-previous-reason').textContent).toContain('印鑑がありません');
  });

  it('ファイルが要らない提出物は「ファイルなしで提出します。」。行のない提出は版 null で送る。締切の後なら「（締切の後）」', async () => {
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    const user = setUser();
    renderScreen();
    await loaded();
    const dialog = await submitCard(user, D_REPORT);
    expect(within(dialog).getByTestId('document-submit-confirm').textContent).toBe('ファイルなしで提出します。');
    await user.click(within(dialog).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_REPORT).getAttribute('data-status')).toBe('submitted'));
    expect(rpcArgs(rpcCalls('submit_document')[0]!).p_base_updated_at).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('「保健所への報告」を提出しました（締切の後）');
    expect(cardOf(D_REPORT).getAttribute('data-late')).toBe('true');
    expect(submittedMessage('x', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')).toBe('「x」を提出しました');
  });

  it('同じ操作が重なった（副店長が先に提出した）：invalid_state の not_editable を読み直して「すでに提出されています」', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const s = db.statuses.find((x) => x.document_id === D_FOOD)!;
    Object.assign(s, { status: 'submitted', submitted_at: '2026-10-06T02:59:00Z', updated_at: nextAt() });
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    expect(within(cardOf(D_FOOD)).getByTestId('document-error').textContent).toBe(DOCUMENT_NOT_EDITABLE_MESSAGES.submitted);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('conflict（読んだ後にほかの人がファイルを足した）：読み直して文言。もう一度押すと読み直した版で送る', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    // ほかの人（副店長）が届いたファイルを足した：版が進む
    const extra = dbFile(uuid(320), D_FOOD, { size: 10 });
    db.files.push(extra);
    db.objects.set(extra.object_path, 10);
    const s = db.statuses.find((x) => x.document_id === D_FOOD)!;
    s.updated_at = nextAt();
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-error').textContent).toBe(DOCUMENT_CONFLICT_MESSAGE));
    await waitFor(() => expect(filesOf(D_FOOD)).toHaveLength(2));
    const dialog = await submitCard(user, D_FOOD);
    expect(within(dialog).getByTestId('document-submit-confirm').textContent).toBe('ファイル 2 つを提出します。');
    await user.click(within(dialog).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    const sent = rpcCalls('submit_document').map((c) => rpcArgs(c).p_base_updated_at);
    expect(sent).toEqual([V0, s.updated_at === null ? null : expect.any(String)]);
    expect(sent[1]).not.toBe(V0);
    expect(within(cardOf(D_FOOD)).queryByTestId('document-error')).toBeNull();
  });

  it('invalid_state の no_file（読んだ後にほかの人がファイルを外した）：文言と読み直し、年度の行と立場も読み直す', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const path = db.files[0]!.object_path;
    db.files = db.files.filter((f) => f.document_id !== D_FOOD);
    db.objects.delete(path);
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-error').textContent).toBe(DOCUMENT_STATE_MESSAGES.no_file));
    await waitFor(() => expect(filesOf(D_FOOD)).toHaveLength(0));
    expect(h.reloadMembership).toHaveBeenCalled();
  });

  it('応答が届かなかったが届いていた：読み直すと提出済みなので「提出されていました」', async () => {
    let lost = true;
    override = (call) => {
      if (call.table === 'rpc:submit_document' && lost) {
        lost = false;
        rpc('submit_document', rpcArgs(call));
        return NETWORK;
      }
      return undefined;
    };
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    expect(toast.success).toHaveBeenCalledWith(SUBMISSION_DONE_BEFORE.submit);
    expect(within(cardOf(D_FOOD)).queryByTestId('document-error')).toBeNull();
  });

  it('応答が届かず読み直せない：「提出できたか分かりません」。もう一度で not_editable が返り、読み直すと提出済みなら「提出されていました」', async () => {
    let mode: 'lost' | 'normal' = 'lost';
    override = (call) => {
      if (mode !== 'lost') return undefined;
      if (call.table === 'rpc:submit_document') {
        rpc('submit_document', rpcArgs(call));
        return NETWORK;
      }
      if (call.table === 'v_document_status') return NETWORK;
      return undefined;
    };
    const user = setUser();
    renderScreen();
    // 最初の読み込みは通す
    mode = 'normal';
    await loaded();
    mode = 'lost';
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-error').textContent).toBe(SUBMISSION_UNKNOWN.submit));
    expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('returned');
    mode = 'normal';
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_FOOD).getAttribute('data-status')).toBe('submitted'));
    expect(toast.success).toHaveBeenCalledWith(SUBMISSION_DONE_BEFORE.submit);
    expect(within(cardOf(D_FOOD)).queryByTestId('document-error')).toBeNull();
  });

  it('止められた後に読み直せない：「…読み直せませんでした」と「読み直す」。読み直せなければ文を変え、読めたら消す', async () => {
    let failReads = false;
    override = (call) => (failReads && call.table === 'v_document_status' ? NETWORK : undefined);
    const user = setUser();
    renderScreen();
    await loaded();
    db.statuses.find((x) => x.document_id === D_FOOD)!.updated_at = nextAt();
    failReads = true;
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    const note = () => within(cardOf(D_FOOD)).getByTestId('document-error');
    await waitFor(() => expect(note().textContent).toContain(REREAD_FAILED_NOTICE));
    expect(note().getAttribute('data-kind')).toBe('unread');
    await user.click(within(cardOf(D_FOOD)).getByTestId('document-reread'));
    await waitFor(() => expect(note().textContent).toContain(REREAD_AGAIN_FAILED_MESSAGE));
    failReads = false;
    await user.click(within(cardOf(D_FOOD)).getByTestId('document-reread'));
    await waitFor(() => expect(within(cardOf(D_FOOD)).queryByTestId('document-error')).toBeNull());
  });

  it('「提出した」「提出を取り消す」が成功したら、確かめのダイアログが閉じた後にフォーカスをそのカードの題名に移す（押したボタンは消える。レビューの F4）', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    const titleOf = (id: string) => within(cardOf(id)).getByTestId('document-card-title');
    const dialog = await submitCard(user, D_REPORT);
    await user.click(within(dialog).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(cardOf(D_REPORT).getAttribute('data-status')).toBe('submitted'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(titleOf(D_REPORT)));
    expect(titleOf(D_REPORT).getAttribute('tabindex')).toBe('-1');
    // 取り消し
    await user.click(within(cardOf(D_SENT)).getByTestId('document-withdraw'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(cardOf(D_SENT).getAttribute('data-status')).toBe('not_submitted'));
    await waitFor(() => expect(document.activeElement).toBe(titleOf(D_SENT)));
  });

  it('提出を取り消す：確かめのダイアログ → withdraw_document（版はカードの updated_at）→ 未提出', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    await user.click(within(cardOf(D_SENT)).getByTestId('document-withdraw'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('「電気の申請」の提出を取り消しますか');
    expect(dialog.textContent).toContain(WITHDRAW_CONFIRM_TEXTS[0]);
    expect(within(dialog).getByTestId('document-withdraw-confirm').textContent).toBe(WITHDRAW_CONFIRM_TEXTS[1]);
    await user.click(within(dialog).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(cardOf(D_SENT).getAttribute('data-status')).toBe('not_submitted'));
    expect(rpcArgs(rpcCalls('withdraw_document')[0]!)).toEqual({ p_document_id: D_SENT, p_group_id: G1.id, p_base_updated_at: V0 });
    expect(toast.success).toHaveBeenCalledWith('「電気の申請」の提出を取り消しました');
    // 取り消した後は、ファイルを外せて「提出した」を押せる
    expect(within(cardOf(D_SENT)).getByTestId('document-file-remove')).toBeTruthy();
    expect(within(cardOf(D_SENT)).getByTestId('document-submit')).toBeTruthy();
  });

  it('取り消しが重なった（総務が先に承認した）：「すでに承認されています。読み直しました」と承認のカード', async () => {
    const user = setUser();
    renderScreen();
    await loaded();
    Object.assign(db.statuses.find((x) => x.document_id === D_SENT)!, { status: 'approved', reviewed_at: '2026-10-06T02:00:00Z', updated_at: nextAt() });
    await user.click(within(cardOf(D_SENT)).getByTestId('document-withdraw'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(cardOf(D_SENT).getAttribute('data-status')).toBe('approved'));
    expect(within(cardOf(D_SENT)).getByTestId('document-error').textContent).toBe(DOCUMENT_NOT_EDITABLE_MESSAGES.approved);
  });

  it('終了した（invalid_state の closed）：年度の行と立場を読み直して、書けない形にする', async () => {
    const user = setUser();
    const qc = renderScreen();
    await loaded();
    yearStatus = 'closed';
    await user.click(within(await submitCard(user, D_FOOD)).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(cardOf(D_FOOD)).getByTestId('document-error').textContent).toBe('年度が「終了」のため、この操作はできません'));
    expect(h.reloadMembership).toHaveBeenCalled();
    await waitFor(() => expect(qc.getQueryData<YearRow>(queryKeys.yearRow(Y))?.status).toBe('closed'));
    await waitFor(() => expect(screen.getByTestId('document-closed')).toBeTruthy());
    expect(within(cardOf(D_FOOD)).queryByTestId('document-submit')).toBeNull();
  });
});

describe('T19 自団体の提出物：最新でない年度', () => {
  it('上に「最新の年度に切り替える」。提出・取り消し・ファイルの変更の前に確かめ、やめれば送らない', async () => {
    const user = setUser();
    renderScreen({ latest: false });
    await loaded();
    expect(screen.getByTestId('latest-year-switch')).toBeTruthy();
    await user.click(within(cardOf(D_FOOD)).getByTestId('document-submit'));
    let ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('最新でない年度（R8・申請受付中）に提出します。よろしいですか');
    await user.click(within(ask).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(within(cardOf(D_SENT)).getByTestId('document-withdraw'));
    ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('に取り消しします。よろしいですか');
    await user.click(within(ask).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    choose(D_PLAN, [pdf(100)]);
    ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('に変更します。よろしいですか');
    await user.click(within(ask).getByRole('button', { name: 'この年度に変更する' }));
    await waitFor(() => expect(filesOf(D_PLAN)[0]?.getAttribute('data-state')).toBe('uploaded'));
    expect(rpcCalls('submit_document')).toHaveLength(0);
    expect(rpcCalls('withdraw_document')).toHaveLength(0);
  });
});

describe('T19 自団体の提出物：最初に読む JS', () => {
  it('/document の部品は、写真の作り直し・CSV・提出状況の部品を静的に import しない（写真の作り直しは選んだときに動的 import）', () => {
    const g = staticImportGraph('app/(app)/document/page.tsx');
    expect(g.files).toContain('components/documents/document-screen.tsx');
    expect(g.files).not.toContain('lib/modules/documents/image.ts');
    expect(g.files).not.toContain('lib/modules/documents/csv.ts');
    expect(g.files).not.toContain('lib/modules/documents/board.ts');
    expect(g.files).not.toContain('lib/modules/portal.ts');
    expect(g.files.filter((f) => f.startsWith('components/documents/documents-') || f.startsWith('components/documents/doc-'))).toEqual([]);
    expect(g.packages).not.toContain('exceljs');
  });
});
