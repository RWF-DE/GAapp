// 入力の配列の並びだけを変える（中身は同じ）。keep の params.items のキーの順も変える（設計 8 章）
import type { AllocateInput } from '@gaapp/shared';
import { mulberry32, shuffle, type Rng } from '@gaapp/shared/testing';

export const SHUFFLED_ARRAYS = [
  'items', 'rooms', 'groups', 'stocks', 'requests', 'rules', 'consents', 'distanceOverrides', 'fixedRows', 'previousRows',
] as const;

export function shuffleInput(input: AllocateInput, seed: number): AllocateInput {
  const r: Rng = mulberry32(seed);
  const out = { ...input } as Record<string, unknown>;
  for (const k of SHUFFLED_ARRAYS) out[k] = shuffle(input[k] as readonly unknown[], r);
  out.rules = (out.rules as AllocateInput['rules']).map((rule) =>
    rule.kind === 'keep'
      ? { ...rule, params: { ...rule.params, items: Object.fromEntries(shuffle(Object.entries(rule.params.items), r)) } }
      : rule,
  );
  return out as AllocateInput;
}

/** 配列の要素の並びを比べるための指紋（要素を JSON にした列） */
export function orderSignature(input: AllocateInput, key: (typeof SHUFFLED_ARRAYS)[number] | 'keepItems'): string {
  if (key === 'keepItems') {
    return JSON.stringify(input.rules.filter((r) => r.kind === 'keep').map((r) => Object.keys(r.params.items)));
  }
  return JSON.stringify((input[key] as readonly unknown[]).map((x) => JSON.stringify(x)));
}
