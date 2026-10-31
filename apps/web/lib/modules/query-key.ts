// ダッシュボード（/）のクエリのキー（D-52。notes/T16.md「固めた約束」3）。lib/modules/portal.ts から分けた小さなモジュール：
// / の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートのレイアウトが読む）が使う机椅子のクエリ（furniture/soumu.ts・
// rep.ts）がキーを作るのに、portal.ts（並べ方・締切と予定の絞り込み・まとめ方と lib/datetime）をルートのレイアウトの JS に入れない
// ため。実行時の import をしない（型だけ）。portal.ts が同じ名前で出し直す。
import type { PortalKind } from './portal';
import type { ModuleId } from './registry';

/** ダッシュボードのクエリのキー（queryKeys.yearPart と同じ形。年度の invalidate で一緒に消える） */
export type PortalQueryKey = readonly ['year', string, 'portal', ModuleId, PortalKind, ...string[]];

/**
 * ダッシュボードのクエリのキー：`['year', yearId, 'portal', moduleId, kind, ...extra]`。
 *
 * @example
 * portalQueryKey(yearId, 'furniture', 'rep', ...groupIds)
 */
export function portalQueryKey(yearId: string, moduleId: ModuleId, kind: PortalKind, ...extra: readonly string[]): PortalQueryKey {
  return ['year', yearId, 'portal', moduleId, kind, ...extra];
}
