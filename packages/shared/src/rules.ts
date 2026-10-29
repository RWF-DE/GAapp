// ルールの params（T12 と T06 が共有する。03「ルールの params と扱い」、設計 2.3）
import { z } from 'zod';
import {
  GROUP_CATEGORIES,
  ITEM_CODE_PATTERN,
  MAX_COUNT,
  MAX_SUBSTITUTE_COST,
  REQUEST_REWRITES,
} from './constants';
import type { Group, InputError, Item, Room } from './model';

const itemCode = z.string().regex(ITEM_CODE_PATTERN, { message: '品目コードの形が正しくありません' });
const category = z.enum(GROUP_CATEGORIES);
const uniq = <T>(a: readonly T[]) => new Set(a).size === a.length;
const UNIQ = { message: '同じ値が重複しています' };

export const substituteParams = z
  .strictObject({
    from: itemCode,
    to: itemCode,
    categories: z.array(category).min(1).refine(uniq, UNIQ),
    /** c_sub。整数でないと目的関数の段の分け方が崩れる */
    cost: z.number().int().min(0).max(MAX_SUBSTITUTE_COST),
    /** 使用場所の rooms.kind が room の団体だけ */
    indoorOnly: z.boolean().default(false),
    /** 了承が declined の団体には作らない */
    needsConsent: z.boolean().default(false),
    /** 同じ距離なら、この区分に先に回す */
    preferCategory: category.optional(),
  })
  .refine((p) => p.from !== p.to, { path: ['to'], message: '代替先が代替元と同じです' })
  .refine((p) => !p.preferCategory || p.categories.includes(p.preferCategory), {
    path: ['preferCategory'],
    message: 'preferCategory は categories のどれかにしてください',
  });

export const sourceRestrictParams = z.strictObject({
  group: z.uuid(),
  /** 申請品目のコード（代替先の品目にも同じ制限がかかる。D-22） */
  items: z.array(itemCode).min(1).refine(uniq, UNIQ),
  rooms: z.array(z.uuid()).min(1).refine(uniq, UNIQ),
});

export const fixedRequestParams = z.strictObject({
  group: z.uuid(),
  item: itemCode,
  count: z.number().int().min(1).max(MAX_COUNT),
});

export const keepParams = z.strictObject({
  group: z.uuid(),
  room: z.uuid(),
  items: z
    .record(itemCode, z.number().int().min(1).max(MAX_COUNT))
    .refine((o) => Object.keys(o).length > 0, { message: '残す品目がありません' }),
});

/** DB の rules.code（length(code) <= 50）と同じ */
const ruleCode = z.string().trim().min(1).max(50);

export const ruleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('substitute'), params: substituteParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('source_restrict'), params: sourceRestrictParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('fixed_request'), params: fixedRequestParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('keep'), params: keepParams }),
]);
export type Rule = z.output<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;
export type SubstituteRule = Extract<Rule, { kind: 'substitute' }>;
export type SourceRestrictRule = Extract<Rule, { kind: 'source_restrict' }>;
export type FixedRequestRule = Extract<Rule, { kind: 'fixed_request' }>;
export type KeepRule = Extract<Rule, { kind: 'keep' }>;

const rowExtra = { enabled: z.boolean(), memo: z.string().nullable() };
/** 画面（T12）が保存する行。enabled と memo を足したもの（id は DB が作る） */
export const ruleRowSchema = z.discriminatedUnion('kind', [
  z.strictObject({ code: ruleCode, kind: z.literal('substitute'), params: substituteParams, ...rowExtra }),
  z.strictObject({ code: ruleCode, kind: z.literal('source_restrict'), params: sourceRestrictParams, ...rowExtra }),
  z.strictObject({ code: ruleCode, kind: z.literal('fixed_request'), params: fixedRequestParams, ...rowExtra }),
  z.strictObject({ code: ruleCode, kind: z.literal('keep'), params: keepParams, ...rowExtra }),
]);
export type RuleRow = z.output<typeof ruleRowSchema>;

/** id のないルール（T12 の新規作成のフォーム） */
export type RuleDraft = Rule extends infer R ? (R extends Rule ? Omit<R, 'id'> : never) : never;

/** E005 だけは allocate で precheck の Issue にする（keep の room が使用場所でない） */
export type RuleCheckError = InputError & { code?: 'E005' };

export type RuleCheckContext = {
  items: readonly Pick<Item, 'code' | 'requestableCategories'>[];
  rooms: readonly Pick<Room, 'id'>[];
  groups: readonly Pick<Group, 'id' | 'category' | 'locationRoomId'>[];
  /** 自分以外の有効なルール（編集中のルール自身は除く。新規なら全部） */
  rules: readonly Rule[];
};

/**
 * ルールの参照と重なりを確かめる（設計 2.3）。T12 のフォーム（保存の前）と allocate の前処理0の両方から呼ぶ。
 * path はルールの中の位置（例：`params.group`）。
 */
export function checkRuleRefs(rule: RuleDraft, ctx: RuleCheckContext): RuleCheckError[] {
  const errors: RuleCheckError[] = [];
  const itemByCode = new Map(ctx.items.map((i) => [i.code, i]));
  const roomIds = new Set(ctx.rooms.map((r) => r.id));
  const groupById = new Map(ctx.groups.map((g) => [g.id, g]));
  const err = (path: string, message: string, code?: 'E005') =>
    errors.push(code ? { path, message, code } : { path, message });
  const needItem = (path: string, code: string) => {
    if (!itemByCode.has(code)) err(path, `品目「${code}」がありません`);
  };
  const needGroup = (path: string, id: string) => {
    const g = groupById.get(id);
    if (!g) err(path, '団体がありません');
    return g;
  };
  /** fixed_request・keep の品目は、対象の団体の区分で申請できるものに限る（読み替えの元の品目も不可） */
  const needRequestable = (path: string, code: string, g: { category: string } | undefined) => {
    const item = itemByCode.get(code);
    if (!item || !g) return;
    if (!item.requestableCategories.includes(g.category as never)) {
      const to = REQUEST_REWRITES[code];
      err(
        path,
        to
          ? `この団体の区分は「${code}」を申請できません。読み替え先の「${to}」を選んでください`
          : `この団体の区分は「${code}」を申請できません`,
      );
    }
  };

  if (ctx.rules.some((r) => r.code.trim() === rule.code.trim())) err('code', `コード「${rule.code}」は他のルールで使われています`);

  switch (rule.kind) {
    case 'substitute': {
      const p = rule.params;
      needItem('params.from', p.from);
      needItem('params.to', p.to);
      for (const other of ctx.rules) {
        if (other.kind !== 'substitute') continue;
        if (other.params.from !== p.from || other.params.to !== p.to) continue;
        if (other.params.categories.some((c) => p.categories.includes(c))) {
          err('params.categories', `同じ代替（${p.from}→${p.to}）で区分が重なるルール ${other.code} があります`);
        }
      }
      break;
    }
    case 'source_restrict': {
      const p = rule.params;
      needGroup('params.group', p.group);
      p.items.forEach((c, k) => needItem(`params.items.${k}`, c));
      p.rooms.forEach((id, k) => {
        if (!roomIds.has(id)) err(`params.rooms.${k}`, '場所がありません');
      });
      break;
    }
    case 'fixed_request': {
      const p = rule.params;
      const g = needGroup('params.group', p.group);
      needItem('params.item', p.item);
      needRequestable('params.item', p.item, g);
      for (const other of ctx.rules) {
        if (other.kind === 'fixed_request' && other.params.group === p.group && other.params.item === p.item) {
          err('params.item', `同じ団体・品目の固定数のルール ${other.code} があります`);
        }
      }
      break;
    }
    case 'keep': {
      const p = rule.params;
      const g = needGroup('params.group', p.group);
      if (!roomIds.has(p.room)) err('params.room', '場所がありません');
      else if (g && g.locationRoomId !== p.room) err('params.room', '「残す」は団体の使用場所の部屋だけです', 'E005');
      for (const c of Object.keys(p.items)) {
        needItem(`params.items.${c}`, c);
        needRequestable(`params.items.${c}`, c, g);
      }
      break;
    }
  }
  return errors;
}
