// 締切と予定がダッシュボード（/）に出すもの（D-52・D-54。04「締切と予定」の「ダッシュボードに出すもの」、notes/T18.md「後半（画面）の
// 約束」3。T18）。
// - 欄：締切と予定（'dated'）だけ。要対応・機能ごとのカード・お知らせの欄は作らない（「済んだ」の印を持たないので要対応にできず、
//   カードは欄と同じものを数えるだけになる。後半の判断したことの 13）。年度の行だけで決まる項目もない（fromYear なし）。
// - 読む：dated.ts の欄の読み取り（id・種類・題名・開始・終わり・終日だけ）。1人1回：総務は総務として、閲覧のみは閲覧のみとして、
//   ロールのない店長・副店長は店長・副店長として。店長・副店長も務める管理者・閲覧のみの rep は読まない（総務・閲覧のみとして読む分と
//   同じ結果。RLS は人ごとに同じ行を返す。後半の判断したことの 11）。
// 読み取りの結果を使う欄は締切と予定だけ（query.widgets）なので、この読み込み中・失敗は締切と予定の欄にだけ出る（「締切と予定：…」と
// 「もう一度」）。机椅子の日付（年度の行から作る fromYear）はその間も出たまま。
import { tokyoDate } from '@/lib/datetime';
import { portalQueryOptions, type DatedItem, type PortalProvider } from '../portal';
import type { ModuleId } from '../registry';
import { calendarDatedOptions, type CalendarDatedRow } from './dated';

const MODULE_ID: ModuleId = 'calendar';

/**
 * 予定と締切の行を締切と予定の1件にする。id は `calendar:${row.id}`、行き先は `/calendar?event=${row.id}`（一覧でその項目を目立たせる。
 * 招待されている全員が開ける）。
 * - 終日：at は開始の日（tokyoDate(starts_at)。Asia/Tokyo の日付）、end は終わりの日（tokyoDate(ends_at)）が開始の日と違うときだけ。
 * - 時刻つき：at は starts_at、end は ends_at が starts_at と違う時刻（Date.parse）のときだけ。
 */
export function eventDatedItem(row: CalendarDatedRow): DatedItem {
  const base = { id: `calendar:${row.id}`, moduleId: MODULE_ID, title: row.title, kind: row.kind, href: `/calendar?event=${row.id}` };
  if (row.all_day) {
    const at = tokyoDate(row.starts_at);
    const end = row.ends_at ? tokyoDate(row.ends_at) : '';
    return { ...base, at, ...(end && end !== at ? { end } : {}) };
  }
  const end = row.ends_at && Date.parse(row.ends_at) !== Date.parse(row.starts_at) ? { end: row.ends_at } : {};
  return { ...base, at: row.starts_at, ...end };
}

/**
 * 締切と予定のプロバイダ（providers.ts の PORTAL_PROVIDERS の最後）。総務は 'soumu'、閲覧のみは 'viewer'、ロールのない店長・副店長は
 * 'rep' のキーで、その年度の項目を全部読む（select で締切と予定の1件にする。どれを出すかは欄の upcomingDated）。
 */
export const calendarPortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu', 'viewer', 'rep'],
  query: {
    widgets: ['dated'],
    options: (ctx) =>
      ctx.kind === 'rep' && ctx.role !== null
        ? null
        : portalQueryOptions(calendarDatedOptions(ctx.year.id, ctx.kind), (rows) => ({ card: null, todos: [], dated: rows.map(eventDatedItem) })),
  },
};
