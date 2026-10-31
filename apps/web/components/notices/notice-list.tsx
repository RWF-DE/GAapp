'use client';

// お知らせの一覧（/notices の中身。04「お知らせ一覧」の1件に出すもの・形、notes/T17.md「後半（画面）の約束」3。T17・D-53）。
// 広い PC（lg 以上）は CSS grid の表のような並び（列：宛先〔印と宛先の団体〕・題名と本文・書いた人と日時・操作。列の見出しの行は
// aria-hidden）、それより狭ければ1件ずつのカード（印 → 題名 → 本文 → 書いた人と日時 → 操作）。同じ <ul> を幅で並べ替え、DOM を
// 2つ作らない（testid と読み上げを重ねない。後半の判断したことの 16）。md（768px〜）では左のナビの分だけ狭く（本文の幅は 500px ほど）、
// 4つの列が収まらないので、表の並びは lg から（T16 のダッシュボードの欄の並びと同じ。後半の判断したことの 20）。
// 本文は書いたとおりの文字で出す（改行を残し、長い語も折り返す。テキストとして出し、リンクにしない・HTML として読まない。判断 17）。
import { Pin } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { NoticeGroupOption, NoticeRow } from '@/lib/data/notices';
import { formatDateTime, formatDateTimeSeconds } from '@/lib/datetime';
import { NOTICE_AUDIENCE_LABELS } from '@/lib/labels';
import { canDeleteNotice, canEditNotice, canWriteNotices, type NoticeActor } from '@/lib/modules/notices/permissions';
import { cn } from '@/lib/utils';

/** 書いた人の表示名が読めない・記録がないとき */
export const AUTHOR_UNKNOWN = '名前を表示できません';
/** 宛先の団体が団体の削除で 0 になった指定の団体あて */
export const NO_TARGET_GROUPS = '宛先の団体がありません';

export interface NoticeListProps {
  notices: readonly NoticeRow[];
  groups: readonly NoticeGroupOption[];
  /** created_by → 表示名（総務だけ） */
  authors: ReadonlyMap<string, string>;
  /** 書いた人を出すか（総務だけ） */
  showAuthors: boolean;
  actor: NoticeActor;
  /** `?notice=` のお知らせ（目立たせて見える所に送る） */
  highlightId: string | null;
  onEdit: (n: NoticeRow) => void;
  onDelete: (n: NoticeRow) => void;
}

/** 日時（Asia/Tokyo。title に秒まで） */
function NoticeTime({ value, testId }: { value: string; testId: string }) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return <span data-testid={testId}>—</span>;
  return (
    <time data-testid={testId} dateTime={d.toISOString()} title={formatDateTimeSeconds(d)}>
      {formatDateTime(d)}
    </time>
  );
}

export function NoticeList({ notices, groups, authors, showAuthors, actor, highlightId, onEdit, onDelete }: NoticeListProps) {
  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const showActions = canWriteNotices(actor.role, actor.status);
  const cols = showActions ? 'lg:grid-cols-[9rem_minmax(0,1fr)_10rem_8.5rem]' : 'lg:grid-cols-[9rem_minmax(0,1fr)_10rem]';
  return (
    <div className="rounded-lg border bg-card">
      <div aria-hidden className={cn('hidden gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid', cols)}>
        <span>宛先</span>
        <span>題名と本文</span>
        <span>{showAuthors ? '書いた人と日時' : '出した日時'}</span>
        {showActions ? <span className="text-right">操作</span> : null}
      </div>
      <ul data-testid="notices-list" className="divide-y">
        {notices.map((n) => (
          <NoticeItem
            key={n.id}
            notice={n}
            cols={cols}
            groupNames={groupNames}
            author={showAuthors ? (n.created_by ? (authors.get(n.created_by) ?? AUTHOR_UNKNOWN) : AUTHOR_UNKNOWN) : null}
            showActions={showActions}
            canEdit={canEditNotice(n, actor)}
            canDelete={canDeleteNotice(n, actor)}
            highlighted={n.id === highlightId}
            onEdit={() => onEdit(n)}
            onDelete={() => onDelete(n)}
          />
        ))}
      </ul>
    </div>
  );
}

function NoticeItem({
  notice: n,
  cols,
  groupNames,
  author,
  showActions,
  canEdit,
  canDelete,
  highlighted,
  onEdit,
  onDelete,
}: {
  notice: NoticeRow;
  cols: string;
  groupNames: ReadonlyMap<string, string>;
  /** 書いた人の表示名（総務でなければ null で出さない） */
  author: string | null;
  showActions: boolean;
  canEdit: boolean;
  canDelete: boolean;
  highlighted: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  // ダッシュボードの欄から来たお知らせ（?notice=）は、見える所に送る（目立たせるのは data-highlighted と色）
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);
  const names = n.groupIds.map((id) => groupNames.get(id)).filter((x): x is string => !!x);
  const updated = Date.parse(n.updated_at) > Date.parse(n.created_at);
  return (
    <li
      ref={ref}
      data-testid="notice-item"
      data-id={n.id}
      data-audience={n.audience}
      data-pinned={String(n.pinned)}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('grid gap-2 px-4 py-3 lg:gap-4', cols, highlighted && 'bg-amber-50 ring-2 ring-inset ring-amber-300')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:flex-col lg:items-start">
        {n.pinned ? (
          <Badge data-testid="notice-pinned" variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
            <Pin aria-hidden />
            ピン留め
          </Badge>
        ) : null}
        <Badge data-testid="notice-audience" variant="outline">
          {NOTICE_AUDIENCE_LABELS[n.audience]}
        </Badge>
        {n.audience === 'groups' ? (
          names.length > 0 ? (
            // 団体の名前の中では折り返さず「・」の後で折り返す（keep-all。PC の宛先の列〔9rem〕は狭く、「模擬店02・模 / 擬店03」と
            // 名前が割れるため）。区切りのない長い名前だけは anywhere で折り返す
            <span data-testid="notice-groups" className="min-w-0 text-xs text-muted-foreground [word-break:keep-all] [overflow-wrap:anywhere]">
              {names.join('・')}
            </span>
          ) : (
            <span data-testid="notice-groups" data-empty="true" className="text-xs font-medium text-amber-700">
              {NO_TARGET_GROUPS}
            </span>
          )
        ) : null}
      </div>
      <div className="min-w-0 space-y-1">
        <h3 data-testid="notice-title" className="font-semibold [overflow-wrap:anywhere]">
          {n.title}
        </h3>
        {n.body ? (
          <p data-testid="notice-body" className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {n.body}
          </p>
        ) : null}
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {author !== null ? (
          <p data-testid="notice-author" className="[overflow-wrap:anywhere]">
            {author}
          </p>
        ) : null}
        <p>
          <NoticeTime value={n.created_at} testId="notice-time" />
          {updated ? (
            // 日時と「に更新）」の中では折り返さない（PC の書いた人と日時の列〔10rem〕では収まらず、「に更 / 新）」と割れるため）
            <span data-testid="notice-updated" className="block">
              <span className="whitespace-nowrap">
                （<NoticeTime value={n.updated_at} testId="notice-updated-time" />
              </span>{' '}
              <span className="whitespace-nowrap">に更新）</span>
            </span>
          ) : null}
        </p>
      </div>
      {showActions ? (
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {canEdit ? (
            <Button size="sm" variant="outline" onClick={onEdit} aria-label={`「${n.title}」を編集`}>
              編集
            </Button>
          ) : null}
          {canDelete ? (
            <Button size="sm" variant="outline" className="text-destructive" onClick={onDelete} aria-label={`「${n.title}」を削除`}>
              削除
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
