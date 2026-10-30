// /allocation の URL のクエリ（画面の設計 1.1・3.9。T13）。合わない値は無視して既定にする。
import { z } from 'zod';
import { TEMP_ID_PREFIX } from '@/lib/allocation/pending';

/**
 * ?row= の行：DB の行の uuid か、未保存の追加の行の仮の id（`new-<uuid>`。lib/allocation/pending.ts の newTempId）。
 * 検証は未保存の変更を当てた行で回るので、issue の rowIds に仮の id が入る。それへ移れるように両方を受け付ける。
 */
const rowId = z.union([z.uuid(), z.string().regex(new RegExp(`^${TEMP_ID_PREFIX}[0-9a-f-]{1,64}$`))]);

const querySchema = z.object({
  view: z.enum(['item', 'group']).catch('item'),
  tab: z.string().trim().min(1).max(50).optional().catch(undefined),
  row: rowId.optional().catch(undefined),
  group: z.uuid().optional().catch(undefined),
});
export type AllocationQuery = z.output<typeof querySchema>;

export function parseAllocationQuery(params: URLSearchParams): AllocationQuery {
  return querySchema.parse({
    view: params.get('view') ?? undefined,
    tab: params.get('tab') ?? undefined,
    row: params.get('row') ?? undefined,
    group: params.get('group') ?? undefined,
  });
}

export function allocationHref(q: Partial<AllocationQuery>): string {
  const p = new URLSearchParams();
  if (q.view && q.view !== 'item') p.set('view', q.view);
  if (q.tab) p.set('tab', q.tab);
  if (q.row) p.set('row', q.row);
  if (q.group) p.set('group', q.group);
  const s = p.toString();
  return s ? `/allocation?${s}` : '/allocation';
}
