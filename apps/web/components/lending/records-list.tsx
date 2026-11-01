'use client';

// 受け渡し・返却の一覧（04「受け渡し・返却」の一覧、notes/T21.md「画面の約束」5。T21・D-57）。スマホ（幅 390px）。
// - 団体（団体の並び）ごとに、表示名・使用場所・割り当ての要約（「テント 2・重し 8」。なければ「割り当てなし」）・状態の印。
// - 既定は割り当て（1以上）か記録のある団体。探す欄（名前・表示名・別名）に入れると、その年度の全部の団体から探す。
// - 状態のチップ（すべて・渡す前・貸し出し中・未返却・返却済み。件数つき）で絞る（`?filter=`）。
import { Search } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { YearRow } from '@/lib/db/types';
import { cellKey, lendingSummaryLine, recordState, sortLendingGroups } from '@/lib/modules/lending/counts';
import { RECORD_STATE_LABELS, RECORD_STATES, type RecordState } from '@/lib/modules/lending/labels';
import type { LendingGroup, LendingRecordsData } from '@/lib/modules/lending/queries';
import { cn } from '@/lib/utils';
import { GroupPlace, groupDisplayName } from './common';

/** 空の表示（04「受け渡し・返却」） */
export const RECORDS_EMPTY_TEXT = 'テント等の割り当てと記録はまだありません';
/** 割り当てがない団体の要約 */
export const NO_ASSIGNMENT_TEXT = '割り当てなし';

/** URL の `?filter=`（知らない値は null＝すべて） */
export function parseRecordsFilter(v: string | null): RecordState | null {
  return v && (RECORD_STATES as readonly string[]).includes(v) ? (v as RecordState) : null;
}

/** 探す欄の比べ方（NFKC・小文字・空白を除く） */
const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 名前・表示名・別名のどれかに含まれるか */
export function matchesGroup(g: Pick<LendingGroup, 'name' | 'display_name' | 'aliases'>, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  return [g.name, g.display_name ?? '', ...(g.aliases ?? [])].some((s) => fold(s).includes(q));
}

/** 一覧の1行 */
export interface RecordsListRow {
  group: LendingGroup;
  state: RecordState;
  /** 割り当ての要約（なければ空） */
  summary: string;
}

/**
 * 一覧に出す団体と状態（団体の並び）：探す語があれば全部の団体から探し、なければ割り当て（1以上）か記録のある団体。
 */
export function recordsListRows(data: LendingRecordsData, year: Pick<YearRow, 'festival_start'>, now: number, query: string): RecordsListRow[] {
  const assigned = new Map(data.assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a.count]));
  const used = new Set([...data.assignments.filter((a) => a.count > 0).map((a) => a.group_id), ...data.records.map((r) => r.group_id)]);
  const q = query.trim();
  return sortLendingGroups(data.groups)
    .filter((g) => (q ? matchesGroup(g, q) : used.has(g.id)))
    .map((g) => ({
      group: g,
      state: recordState(
        data.records.filter((r) => r.group_id === g.id),
        year,
        now,
      ),
      summary: lendingSummaryLine(data.items, (id) => assigned.get(cellKey(g.id, id)) ?? 0),
    }));
}

const STATE_STYLE: Record<RecordState, string> = {
  before: 'border-zinc-300 bg-zinc-50 text-zinc-700',
  lent: 'border-sky-300 bg-sky-50 text-sky-900',
  unreturned: 'border-destructive/50 bg-destructive/10 text-destructive',
  returned: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

/** 状態の印 */
export function RecordStateBadge({ state }: { state: RecordState }) {
  return (
    <Badge variant="outline" data-testid="records-state" className={cn('shrink-0', STATE_STYLE[state])}>
      {RECORD_STATE_LABELS[state]}
    </Badge>
  );
}

const TOGGLE_ON = 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground';
const ALL = 'all';

export function RecordsList({
  data,
  year,
  now,
  filter,
  onFilter,
  onOpen,
}: {
  data: LendingRecordsData;
  year: Pick<YearRow, 'festival_start'>;
  now: number;
  filter: RecordState | null;
  onFilter: (next: RecordState | null) => void;
  onOpen: (groupId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const rows = recordsListRows(data, year, now, query);
  const count = (s: RecordState) => rows.filter((r) => r.state === s).length;
  const shown = filter ? rows.filter((r) => r.state === filter) : rows;

  return (
    <div className="space-y-3">
      <label className="relative block">
        <span className="sr-only">団体を探す（名前・表示名・別名）</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="records-search"
          type="search"
          className="h-11 pl-9 text-base"
          placeholder="団体を探す（名前・表示名・別名）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </label>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={2}
        value={filter ?? ALL}
        onValueChange={(v) => {
          if (v) onFilter(v === ALL ? null : (v as RecordState));
        }}
        aria-label="状態で絞る"
        data-testid="records-filter"
        className="flex-wrap"
      >
        <ToggleGroupItem value={ALL} className={TOGGLE_ON}>
          すべて（{rows.length}）
        </ToggleGroupItem>
        {RECORD_STATES.map((s) => (
          <ToggleGroupItem key={s} value={s} className={TOGGLE_ON}>
            {RECORD_STATE_LABELS[s]}（{count(s)}）
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {shown.length === 0 ? (
        <EmptyState title={query.trim() ? '見つかりません' : filter ? `${RECORD_STATE_LABELS[filter]}の団体はありません` : RECORDS_EMPTY_TEXT} />
      ) : (
        <ul data-testid="records-list" className="divide-y rounded-lg border">
          {shown.map(({ group: g, state, summary }) => (
            <li key={g.id} data-testid="records-group" data-group-id={g.id} data-state={state}>
              <button type="button" className="flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent" onClick={() => onOpen(g.id)}>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-medium [overflow-wrap:anywhere]">{groupDisplayName(g)}</p>
                  <GroupPlace group={g} />
                  <p className="text-sm">{summary || <span className="text-muted-foreground">{NO_ASSIGNMENT_TEXT}</span>}</p>
                </div>
                <RecordStateBadge state={state} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
