// 作業一覧（/tasks）の読み取りと書き込み（04「作業一覧」、notes/T20.md「画面の約束」2・3・7。T20・D-56）。
// - 読む：開いている年度の作業の全部（先読みにも使う軽いモジュール lib/modules/shifts/reads.ts の tasksOptions。ここから同じ名前で出し直す）。
// - 書く：作る・直す・消すは画面から直接（RLS。その年度の部門長以上で、年度が終了でないとき）。作るのは画面が作った id で insert（送り直しは
//   主キーの重複〔23505〕で止まる）、直す・消すは読んだときの updated_at の文字列のまま条件に入れる（updateWithLock・deleteChecked）。
//   状態は RPC set_task_status（担当者と部門長以上。読んだときの updated_at を p_base_updated_at に渡す。ミリ秒までで比べる）。
// 応答が届かなかったとき・止められたときの決め方（(B1)）は components/tasks/task-write.ts。
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { deleteChecked } from '@/lib/db/delete-checked';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { toAppError } from '@/lib/errors';
import type { TaskStatus } from '@/lib/modules/shifts/labels';
import { TASKS_SELECT, tasksOptions, type TaskRow } from '@/lib/modules/shifts/reads';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import type { TaskWrite } from '@/lib/schemas/tasks';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

export { loadTasks, TASKS_SELECT, tasksOptions, type TaskRow } from '@/lib/modules/shifts/reads';

/** 行の列を一覧の形にそろえる（updateWithLock・deleteChecked・RPC は全部の列を返すので、一覧のキャッシュに余分な列を入れない） */
export function toTaskRow(row: TaskRow): TaskRow {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    assignee_id: row.assignee_id,
    due_at: row.due_at,
    status: row.status,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** その作業を1行読む（(B1) の読み直し）。なければ（消えた・読めない）null */
export async function readTask(id: string, client: AppSupabaseClient = getSupabase()): Promise<TaskRow | null> {
  const res = await client.from('tasks').select(TASKS_SELECT).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as TaskRow | null) ?? null;
}

/**
 * 作る：画面が作った id で insert し、行を返させる。送り直しは主キーの重複（23505）で止まる。担当者が総務でなければ invalid_input
 * （reason: not_soumu）、書けなければ 42501。
 */
export async function insertTask(yearId: string, id: string, w: TaskWrite, client: AppSupabaseClient = getSupabase()): Promise<TaskRow> {
  const res = await client
    .from('tasks')
    .insert({ id, year_id: yearId, ...w })
    .select(TASKS_SELECT)
    .single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as TaskRow;
}

/** 直す：読んだときの updated_at を条件に入れて、題名・説明・担当者・締切を置き換える（状態は送らない） */
export async function updateTask(row: Pick<TaskRow, 'id' | 'updated_at'>, w: TaskWrite, client: AppSupabaseClient = getSupabase()): Promise<TaskRow> {
  return toTaskRow((await updateWithLock(client, 'tasks', { id: row.id }, row.updated_at, { ...w })) as TaskRow);
}

/** 消す：読んだときの updated_at を条件に入れて delete し、消えた行を受け取る */
export async function deleteTask(row: Pick<TaskRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<TaskRow> {
  return toTaskRow((await deleteChecked(client, 'tasks', { id: row.id }, row.updated_at)) as TaskRow);
}

/** 状態を変える（RPC set_task_status。読んだときの updated_at の文字列をそのまま渡す）。返り値は変えた後の行 */
export async function setTaskStatus(
  row: Pick<TaskRow, 'id' | 'updated_at'>,
  status: TaskStatus,
  client: AppSupabaseClient = getSupabase(),
): Promise<TaskRow> {
  const r = await callRpc('set_task_status', { p_task_id: row.id, p_status: status, p_base_updated_at: row.updated_at }, client);
  return toTaskRow(r as TaskRow);
}

/**
 * 書いた後に読み直すキー：作業の一覧（`['year', y, 'shifts', 'tasks']`）とダッシュボードのシフト・作業（`['year', y, 'portal', 'shifts']`。
 * /calendar の機能の日付も同じキー）
 */
export function tasksInvalidateKeys(yearId: string): QueryKey[] {
  return [queryKeys.yearPart(yearId, 'shifts', 'tasks'), queryKeys.yearPart(yearId, 'portal', 'shifts')];
}

/** 書いた後に読み直す（待たない。画面は先にキャッシュを直している） */
export function invalidateTasks(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of tasksInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}

/** 作った・直した・状態を変えた行を一覧のキャッシュに入れる（読み直しの前に出す）。キャッシュがなければ何もしない */
export function putTaskInCache(queryClient: QueryClient, yearId: string, row: TaskRow): void {
  queryClient.setQueryData(tasksOptions(yearId).queryKey, (old) => {
    if (!old) return old;
    const next = toTaskRow(row);
    return [...old.filter((t) => t.id !== next.id), next].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });
}

/** 消えた作業を一覧のキャッシュから外す */
export function dropTaskFromCache(queryClient: QueryClient, yearId: string, id: string): void {
  queryClient.setQueryData(tasksOptions(yearId).queryKey, (old) => (old ? old.filter((t) => t.id !== id) : old));
}
