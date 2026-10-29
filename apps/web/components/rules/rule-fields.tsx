'use client';

// ルールのフォームの欄（種別ごと。画面の設計 3.8。T12）。団体・場所は名前で選んで id を持ち、品目はコードで持つ。
// エラーは path（`params.rooms` など）ごとに欄の下に出す（lib/data/rules.ts の checkRuleForm）。
import { useId } from 'react';
import { GROUP_CATEGORIES, MAX_COUNT, MAX_SUBSTITUTE_COST, type GroupCategory } from '@gaapp/shared';
import { EntitySelect, type EntityOption } from '@/components/common/entity-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GroupRow, ItemRow, RoomRow } from '@/lib/db/types';
import { errorsUnder, type RuleFieldErrors, type RuleFormValues, type RulesData } from '@/lib/data/rules';
import { CATEGORY_LABELS, ROOM_KIND_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** 欄の下のエラー（path の下の文言をまとめて出す） */
export function FieldErrors({ errors, path, exact = false }: { errors: RuleFieldErrors; path: string; exact?: boolean }) {
  const list = errorsUnder(errors, path, { exact });
  if (list.length === 0) return null;
  return (
    <ul data-field-error={path} className="space-y-0.5 text-sm text-destructive">
      {list.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

/** 欄の入れ物（見出し・中身・エラー）。data-field に path を出す（E2E とエラーへのスクロールのため） */
export function Field({
  label,
  path,
  errors,
  exact,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: string;
  path: string;
  errors: RuleFieldErrors;
  exact?: boolean;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div data-field={path} className={cn('space-y-1.5', className)}>
      {htmlFor ? (
        <Label htmlFor={htmlFor}>{label}</Label>
      ) : (
        <p className="text-sm font-medium" id={`${path}-label`}>
          {label}
        </p>
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
      <FieldErrors errors={errors} path={path} exact={exact} />
    </div>
  );
}

/** チェックの一覧（区分・品目・場所の複数選択） */
function CheckList<T extends string>({
  name,
  options,
  value,
  onChange,
  disabled,
  invalid,
  columns = 2,
}: {
  name: string;
  options: readonly { value: T; label: string; heading?: string }[];
  value: readonly T[];
  /** 付けた順に足し、外したら抜く */
  onChange: (next: T[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  columns?: 2 | 3 | 4;
}) {
  const base = useId();
  const groups = new Map<string, (typeof options)[number][]>();
  for (const o of options) {
    const k = o.heading ?? '';
    const list = groups.get(k);
    if (list) list.push(o);
    else groups.set(k, [o]);
  }
  const cols = columns === 4 ? 'sm:grid-cols-4' : columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  return (
    <div role="group" aria-label={name} className={cn('space-y-2 rounded-md border p-2', invalid && 'border-destructive')}>
      {[...groups.entries()].map(([heading, list]) => (
        <div key={heading || '_'} className="space-y-1">
          {heading ? <p className="text-xs text-muted-foreground">{heading}</p> : null}
          <div className={cn('grid grid-cols-2 gap-x-3 gap-y-1.5', cols)}>
            {list.map((o) => {
              const id = `${base}-${o.value}`;
              const checked = value.includes(o.value);
              return (
                <div key={o.value} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(c) => onChange(c === true ? [...value.filter((v) => v !== o.value), o.value] : value.filter((v) => v !== o.value))}
                  />
                  <Label htmlFor={id} className="font-normal">
                    {o.label}
                  </Label>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const numberInputProps = { type: 'text', inputMode: 'numeric', autoComplete: 'off' } as const;

const itemOptions = (items: readonly ItemRow[]): EntityOption[] => items.map((i) => ({ id: i.code, name: i.name, keywords: [i.code] }));
const groupOptions = (groups: readonly GroupRow[]): EntityOption[] =>
  groups.map((g) => ({ id: g.id, name: g.name, group: CATEGORY_LABELS[g.category], keywords: [...g.aliases, ...(g.display_name ? [g.display_name] : [])] }));
const roomHeading = (r: RoomRow) => r.building ?? ROOM_KIND_LABELS[r.kind];
const roomOptions = (rooms: readonly RoomRow[]): EntityOption[] =>
  rooms.map((r) => ({ id: r.id, name: r.name, group: roomHeading(r), keywords: [...r.aliases] }));

/** 一覧にない選択中の値（消した団体・場所など）を「見つからない」の選択肢として足す */
function withMissing(options: EntityOption[], value: string | null, label: string): EntityOption[] {
  if (!value || options.some((o) => o.id === value)) return options;
  return [...options, { id: value, name: label, disabled: true }];
}

export interface RuleFieldsProps {
  values: RuleFormValues;
  onChange: (next: RuleFormValues) => void;
  errors: RuleFieldErrors;
  data: RulesData;
  /** 確定中・終了・送信中は params を変えられない */
  disabled: boolean;
}

/** 種別ごとの欄（params） */
export function RuleParamsFields(props: RuleFieldsProps) {
  switch (props.values.kind) {
    case 'substitute':
      return <SubstituteFields {...props} />;
    case 'source_restrict':
      return <SourceRestrictFields {...props} />;
    case 'fixed_request':
      return <FixedRequestFields {...props} />;
    case 'keep':
      return <KeepFields {...props} />;
  }
}

function SubstituteFields({ values, onChange, errors, data, disabled }: RuleFieldsProps) {
  const s = values.substitute;
  const set = (patch: Partial<typeof s>) => onChange({ ...values, substitute: { ...s, ...patch } });
  const costId = useId();
  const preferId = useId();
  const items = itemOptions(data.items);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="元の品目（申請された品目）" path="params.from" errors={errors}>
          <EntitySelect label="元の品目" options={withMissing(items, s.from, s.from ?? '')} value={s.from} onChange={(v) => set({ from: v })} disabled={disabled} />
        </Field>
        <Field label="先の品目（代わりに出す品目）" path="params.to" errors={errors}>
          <EntitySelect label="先の品目" options={withMissing(items, s.to, s.to ?? '')} value={s.to} onChange={(v) => set({ to: v })} disabled={disabled} />
        </Field>
      </div>
      <Field label="区分（この区分の団体にだけ代える）" path="params.categories" errors={errors}>
        <CheckList<GroupCategory>
          name="区分"
          columns={4}
          options={GROUP_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          value={s.categories}
          onChange={(categories) => set({ categories, preferCategory: s.preferCategory && categories.includes(s.preferCategory) ? s.preferCategory : null })}
          disabled={disabled}
          invalid={errorsUnder(errors, 'params.categories').length > 0}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`重さ（0〜${MAX_SUBSTITUTE_COST}）`} path="params.cost" errors={errors} htmlFor={costId} hint="大きいほど代替を使いにくくする">
          <Input
            id={costId}
            {...numberInputProps}
            value={s.cost}
            onChange={(e) => set({ cost: e.target.value })}
            disabled={disabled}
            aria-invalid={errorsUnder(errors, 'params.cost').length > 0 || undefined}
            className="w-28"
          />
        </Field>
        <Field label="優先する区分" path="params.preferCategory" errors={errors} htmlFor={preferId} hint="同じ距離なら、この区分に先に回す">
          <select
            id={preferId}
            value={s.preferCategory ?? ''}
            onChange={(e) => set({ preferCategory: (e.target.value || null) as GroupCategory | null })}
            disabled={disabled}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">なし</option>
            {s.categories.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <CheckOne label="屋内の団体だけ（使用場所が部屋の団体）" checked={s.indoorOnly} onChange={(v) => set({ indoorOnly: v })} disabled={disabled} />
        <CheckOne label="団体の了承が要る" checked={s.needsConsent} onChange={(v) => set({ needsConsent: v })} disabled={disabled} />
      </div>
    </>
  );
}

export function CheckOne({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

function SourceRestrictFields({ values, onChange, errors, data, disabled }: RuleFieldsProps) {
  const s = values.sourceRestrict;
  const set = (patch: Partial<typeof s>) => onChange({ ...values, sourceRestrict: { ...s, ...patch } });
  // 保管場所から選ぶ。保管場所でなくなった場所・消えた場所が選ばれていれば、それも出す（外せるように）
  const roomsShown = data.rooms.filter((r) => r.is_storage || s.rooms.includes(r.id));
  const missingRooms = s.rooms.filter((id) => !data.rooms.some((r) => r.id === id));
  const missingItems = s.items.filter((c) => !data.items.some((i) => i.code === c));
  return (
    <>
      <Field label="団体" path="params.group" errors={errors}>
        <EntitySelect
          label="団体"
          options={withMissing(groupOptions(data.groups), s.group, '（見つからない団体）')}
          value={s.group}
          onChange={(v) => set({ group: v })}
          disabled={disabled}
        />
      </Field>
      <Field label="申請品目（代替先の品目にも同じ制限がかかる）" path="params.items" errors={errors}>
        <CheckList
          name="申請品目"
          columns={3}
          options={[...data.items.map((i) => ({ value: i.code, label: i.name })), ...missingItems.map((c) => ({ value: c, label: c }))]}
          value={s.items}
          onChange={(items) => set({ items })}
          disabled={disabled}
          invalid={errorsUnder(errors, 'params.items').length > 0}
        />
      </Field>
      <Field label="運び元にしてよい場所（保管場所）" path="params.rooms" errors={errors}>
        <CheckList
          name="運び元の場所"
          columns={4}
          options={[
            ...roomsShown.map((r) => ({ value: r.id, label: r.name, heading: roomHeading(r) })),
            ...missingRooms.map((id) => ({ value: id, label: '（見つからない場所）', heading: '見つからない場所' })),
          ]}
          value={s.rooms}
          onChange={(rooms) => set({ rooms })}
          disabled={disabled}
          invalid={errorsUnder(errors, 'params.rooms').length > 0}
        />
      </Field>
    </>
  );
}

/** 団体の区分で申請できる品目（団体を選んでいなければ、どれかの区分で申請できる品目） */
function requestableItems(data: RulesData, groupId: string | null): ItemRow[] {
  const g = data.groups.find((x) => x.id === groupId);
  return data.items.filter((i) => (g ? i.requestable_categories.includes(g.category) : i.requestable_categories.length > 0));
}

function FixedRequestFields({ values, onChange, errors, data, disabled }: RuleFieldsProps) {
  const s = values.fixedRequest;
  const set = (patch: Partial<typeof s>) => onChange({ ...values, fixedRequest: { ...s, ...patch } });
  const countId = useId();
  const items = itemOptions(requestableItems(data, s.group));
  return (
    <>
      <Field label="団体" path="params.group" errors={errors} hint="この団体が申請を出していないとき、下の数を申請したものとして扱う">
        <EntitySelect
          label="団体"
          options={withMissing(groupOptions(data.groups), s.group, '（見つからない団体）')}
          value={s.group}
          onChange={(v) => set({ group: v })}
          disabled={disabled}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="品目（団体の区分で申請できるもの）" path="params.item" errors={errors}>
          <EntitySelect label="品目" options={withMissing(items, s.item, s.item ?? '')} value={s.item} onChange={(v) => set({ item: v })} disabled={disabled} />
        </Field>
        <Field label={`数（1〜${MAX_COUNT}）`} path="params.count" errors={errors} htmlFor={countId}>
          <Input
            id={countId}
            {...numberInputProps}
            value={s.count}
            onChange={(e) => set({ count: e.target.value })}
            disabled={disabled}
            aria-invalid={errorsUnder(errors, 'params.count').length > 0 || undefined}
            className="w-32"
          />
        </Field>
      </div>
    </>
  );
}

function KeepFields({ values, onChange, errors, data, disabled }: RuleFieldsProps) {
  const s = values.keep;
  const set = (patch: Partial<typeof s>) => onChange({ ...values, keep: { ...s, ...patch } });
  const base = useId();
  const group = data.groups.find((g) => g.id === s.group);
  const shownItems = requestableItems(data, s.group);
  // 入っている品目で、一覧に出ないもの（申請できない・消えた品目）も出す（直せるように）
  const extra = Object.keys(s.items).filter((c) => !shownItems.some((i) => i.code === c));
  const location = group?.location_room_id ? data.rooms.find((r) => r.id === group.location_room_id) : undefined;
  return (
    <>
      <Field label="団体" path="params.group" errors={errors}>
        <EntitySelect
          label="団体"
          options={withMissing(groupOptions(data.groups), s.group, '（見つからない団体）')}
          value={s.group}
          onChange={(v) => {
            const g = data.groups.find((x) => x.id === v);
            // 場所の既定は団体の使用場所（まだ選んでいなければ）
            set({ group: v, room: s.room ?? g?.location_room_id ?? null });
          }}
          disabled={disabled}
        />
      </Field>
      <Field
        label="場所（団体の使用場所）"
        path="params.room"
        errors={errors}
        hint={location ? `この団体の使用場所は ${location.name} です` : group ? 'この団体には使用場所がありません' : undefined}
      >
        <EntitySelect
          label="場所"
          options={withMissing(roomOptions(data.rooms), s.room, '（見つからない場所）')}
          value={s.room}
          onChange={(v) => set({ room: v })}
          disabled={disabled}
        />
      </Field>
      <Field label="残す品目と数（残さない品目は空のまま）" path="params.items" errors={errors} exact>
        <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
          {[...shownItems.map((i) => ({ code: i.code, name: i.name })), ...extra.map((c) => ({ code: c, name: c }))].map((i) => {
            const id = `${base}-${i.code}`;
            const path = `params.items.${i.code}`;
            const invalid = errorsUnder(errors, path).length > 0;
            return (
              <div key={i.code} data-field={path} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor={id} className="min-w-24 font-normal">
                    {i.name}
                  </Label>
                  <Input
                    id={id}
                    {...numberInputProps}
                    aria-label={`${i.name}の数`}
                    value={s.items[i.code] ?? ''}
                    onChange={(e) => {
                      const items = { ...s.items };
                      if (e.target.value === '') delete items[i.code];
                      else items[i.code] = e.target.value;
                      set({ items });
                    }}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    className="w-24"
                  />
                </div>
                <FieldErrors errors={errors} path={path} />
              </div>
            );
          })}
        </div>
      </Field>
    </>
  );
}
