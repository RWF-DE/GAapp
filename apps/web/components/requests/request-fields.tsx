'use client';

import { CountStepper } from '@/components/common/count-stepper';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { countOf, extraRowNote, type ExtraRequestRow, type GroupChanges, type RequestField } from '@/lib/data/requests';
import { NOTE_MAX } from '@/lib/schemas/common';
import { cn } from '@/lib/utils';

/**
 * 申請の入力欄（画面の設計 3.5。T11）。申請（/request）と申請一覧の代理入力のシートが使う。
 * その団体の区分で申請できる品目だけを CountStepper で縦に並べ、申請できない品目に残っている 0 でない申請は
 * 読み取り専用の行で下に出す（提出では送らない品目なので、団体代表は直せない）。備考は数に影響しない。
 */
export function RequestFields({
  fields,
  extras,
  edits,
  onCountChange,
  note,
  onNoteChange,
  disabled,
  audience = 'rep',
  idPrefix,
}: {
  fields: readonly RequestField[];
  extras: readonly ExtraRequestRow[];
  edits: Readonly<Record<string, number>>;
  onCountChange: (itemId: string, value: number) => void;
  note: string;
  onNoteChange: (value: string) => void;
  disabled: boolean;
  /** 読み取り専用の行の説明の言い方（団体代表には「総務へ」） */
  audience?: 'rep' | 'admin';
  idPrefix: string;
}) {
  const noteTooLong = note.length > NOTE_MAX;
  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-lg border" aria-label="申請する品目">
        {fields.map((f) => {
          const value = countOf(f, edits);
          const changed = value !== f.current;
          return (
            <li
              key={f.item.id}
              data-testid="request-field"
              data-item-code={f.item.code}
              className={cn('flex items-center justify-between gap-3 px-3 py-2', changed && 'bg-amber-50')}
            >
              <span className="min-w-0 text-sm font-medium">
                {f.item.name}
                {changed ? <span className="ml-2 text-xs font-normal text-amber-800">（今 {f.current}）</span> : null}
              </span>
              <CountStepper
                id={`${idPrefix}-${f.item.code}`}
                label={`${f.item.name}の数`}
                value={value}
                onChange={(v) => onCountChange(f.item.id, v)}
                disabled={disabled}
              />
            </li>
          );
        })}
      </ul>
      {extras.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2" data-testid="request-extras">
          <p className="text-xs text-muted-foreground">入力欄にない品目の申請（読み取り専用）</p>
          <ul className="space-y-1">
            {extras.map((x) => (
              <li key={x.item.id} data-testid="request-extra" data-item-code={x.item.code} className="text-sm">
                {x.item.name} {x.count}台
                <span className="text-muted-foreground">（{extraRowNote(x, audience)}）</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-note`}>備考（数には影響しません）</Label>
        <Textarea
          id={`${idPrefix}-note`}
          value={note}
          disabled={disabled}
          aria-invalid={noteTooLong || undefined}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="伝えたいことがあれば書いてください"
        />
        {noteTooLong ? (
          <p role="alert" className="text-sm text-destructive">
            備考は {NOTE_MAX} 字までです（今 {note.length} 字）
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 編集した後に裏で届いた、ほかの人の変更の知らせ（R1。入力は置き換えない）。/request と代理入力で使う。
 * 「ほかの人の値を読み込む」で、変わった品目と備考を届いた値にする（ほかの入れた数は残す）。
 */
export function RemoteChangeNotice({
  changes,
  items,
  disabled,
  onAdopt,
  testId = 'request-remote-change',
  verb = '提出',
  children,
}: {
  changes: GroupChanges;
  items: readonly { id: string; name: string }[];
  disabled?: boolean;
  onAdopt: () => void;
  testId?: string;
  /** 送る操作の名前（「…するときに、上書きするか見直すかを選べます」） */
  verb?: '提出' | '保存';
  children: React.ReactNode;
}) {
  const name = (id: string) => items.find((i) => i.id === id)?.name ?? '（不明な品目）';
  const list = [...changes.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`), ...(changes.submission ? ['提出日時・備考'] : [])];
  return (
    <div role="status" data-testid={testId} className="mb-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <p>
        {children}。変わったもの：{list.join('、')}。入力はそのまま残しています。{verb}するときに、上書きするか見直すかを選べます。
      </p>
      <Button size="sm" variant="outline" disabled={disabled} onClick={onAdopt}>
        ほかの人の値を読み込む
      </Button>
    </div>
  );
}
