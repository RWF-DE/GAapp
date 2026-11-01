// 受け渡し・返却の印刷用の表（04「受け渡し・返却」の印刷、notes/T21.md「画面の約束」5。T21・D-57）。通信が切れた日に紙で記録する
// ため、A4 縦に、団体ごとの行（区分・団体・使用場所）と備品ごとの「割り当て」「渡した」「返った」の欄（渡した・返ったは空欄）を出す。
// 画面では隠し、印刷のときだけ出す（ヘッダー・ナビ・入力は print:hidden）。確定前なら上に「割り当ては確定前です」。
import { CATEGORY_LABELS } from '@/lib/labels';
import { cellKey, sortLendingGroups, sortLendingItems } from '@/lib/modules/lending/counts';
import { NO_LOCATION_TEXT } from '@/lib/modules/lending/labels';
import type { LendingRecordsData } from '@/lib/modules/lending/queries';
import { groupDisplayName } from './common';

/** 印刷する団体：割り当て（1以上）か記録のある団体（団体の並び） */
export function printGroups(data: LendingRecordsData) {
  const used = new Set([...data.assignments.filter((a) => a.count > 0).map((a) => a.group_id), ...data.records.map((r) => r.group_id)]);
  return sortLendingGroups(data.groups).filter((g) => used.has(g.id));
}

export function RecordsPrint({ data, yearLabel }: { data: LendingRecordsData; yearLabel: string }) {
  const items = sortLendingItems(data.items);
  const groups = printGroups(data);
  const assigned = new Map(data.assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a.count]));
  return (
    <section data-testid="records-print-sheet" aria-label="印刷用の表" className="hidden text-[10pt] text-black print:block">
      <style>{'@media print { @page { size: A4 portrait; margin: 10mm; } }'}</style>
      <h1 className="mb-1 text-base font-bold">テント等の受け渡し・返却（{yearLabel}）</h1>
      {!data.confirmedAt ? <p className="mb-2 font-semibold">割り当ては確定前です</p> : null}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th rowSpan={2} className="border border-black px-1 py-0.5 text-left">
              区分
            </th>
            <th rowSpan={2} className="border border-black px-1 py-0.5 text-left">
              団体
            </th>
            <th rowSpan={2} className="border border-black px-1 py-0.5 text-left">
              使用場所
            </th>
            {items.map((it) => (
              <th key={it.id} colSpan={3} className="border border-black px-1 py-0.5">
                {it.name}（{it.unit}）
              </th>
            ))}
          </tr>
          <tr>
            {items.map((it) => [
              <th key={`${it.id}-a`} className="border border-black px-1 py-0.5 font-normal">
                割り当て
              </th>,
              <th key={`${it.id}-l`} className="border border-black px-1 py-0.5 font-normal">
                渡した
              </th>,
              <th key={`${it.id}-r`} className="border border-black px-1 py-0.5 font-normal">
                返った
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id} className="break-inside-avoid">
              <td className="border border-black px-1 py-1">{CATEGORY_LABELS[g.category]}</td>
              <td className="border border-black px-1 py-1">{groupDisplayName(g)}</td>
              <td className="border border-black px-1 py-1">{g.location?.name ?? NO_LOCATION_TEXT}</td>
              {items.map((it) => [
                <td key={`${it.id}-a`} className="border border-black px-1 py-1 text-right">
                  {assigned.get(cellKey(g.id, it.id)) ?? ''}
                </td>,
                <td key={`${it.id}-l`} className="h-7 w-10 border border-black" />,
                <td key={`${it.id}-r`} className="h-7 w-10 border border-black" />,
              ])}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
