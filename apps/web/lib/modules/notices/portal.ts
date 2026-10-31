// お知らせがダッシュボード（/）に出すもの（D-52・D-53。04「お知らせ一覧」の「ダッシュボードに出すもの」、notes/T17.md
// 「後半（画面）の約束」6。T17）。
// - 欄：総務に「総務内のお知らせ」（soumuNotices）、閲覧のみ・店長・副店長に「お知らせ」（notices）。新着を5件（ピン留めが先）。
// - 読む：latest.ts の新着（id・宛先・題名・ピン留め・出した日時だけ）。総務は総務内、閲覧のみ・店長・副店長は団体あて（RLS の範囲）。
//   閲覧のみで店長・副店長も務める人は、閲覧のみとして1回だけ読む（団体あてで、読める範囲も同じ。後半の判断したことの 13）。
// - 要対応・締切と予定・機能ごとのカードは作らない（既読を持たないので「読んでいないお知らせ」の要対応は作れず、カードは欄と同じ
//   ものを数えるだけになる。後半の判断したことの 3）。年度の行だけで決まる項目もない（fromYear なし）。
// 読み取りの結果を使う欄は2つのお知らせの欄だけ（query.widgets）なので、お知らせの読み込み中・失敗は要対応・締切と予定・カードの欄に
// 出ず、机椅子の読み込み中・失敗もお知らせの欄に出ない。
import { portalQueryOptions, type NoticeDigest, type PortalProvider } from '../portal';
import type { ModuleId } from '../registry';
import { noticesLatestOptions, type NoticeLatestRow } from './latest';

const MODULE_ID: ModuleId = 'notices';

/** 新着の行を欄の1件にする（行き先は一覧でそのお知らせを目立たせる `/notices?notice=<id>`） */
export function noticeDigests(rows: readonly NoticeLatestRow[]): NoticeDigest[] {
  return rows.map((r) => ({
    id: r.id,
    moduleId: MODULE_ID,
    title: r.title,
    at: r.created_at,
    pinned: r.pinned,
    audience: r.audience,
    href: `/notices?notice=${r.id}`,
  }));
}

/**
 * お知らせのプロバイダ（providers.ts の PORTAL_PROVIDERS に並べる）。総務は総務内の新着、閲覧のみは団体あての新着、
 * 店長・副店長は団体あての新着（団体の id つきのキー）。閲覧のみで店長・副店長も務める人の rep は読まない（閲覧のみとして読む分と
 * 同じ結果）。店長・副店長も務める管理者の rep は、管理者として読める団体あての全部（RLS）。
 */
export const noticesPortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu', 'viewer', 'rep'],
  query: {
    widgets: ['soumuNotices', 'notices'],
    options: (ctx) =>
      ctx.kind === 'rep' && ctx.role === 'viewer'
        ? null
        : portalQueryOptions(
            noticesLatestOptions(
              ctx.year.id,
              ctx.kind,
              ctx.kind === 'rep' ? ctx.groups.map((g) => g.id) : [],
            ),
            (rows) => ({ card: null, todos: [], dated: [], notices: noticeDigests(rows) }),
          ),
  },
};
