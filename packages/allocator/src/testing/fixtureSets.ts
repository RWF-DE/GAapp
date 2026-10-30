// 不変条件のテストに流すデータ（設計 12.2）：合成データ fixtures/synthetic/r8like と、あれば本物の fixtures/r8
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ITEM_CODES, type AllocateInput } from '@gaapp/shared';
import { fixtureIndex, fixturePath, readFixtureDir, toAllocateInput, type FixtureData, type FixtureIndex } from '@gaapp/shared/testing';
import { independentRewrite } from './checkInvariants';

export type FixtureSet = {
  label: string;
  fx: FixtureData;
  ix: FixtureIndex;
  input: AllocateInput;
  /** D-08 のテストで使用不可にする部屋（R8 は第一セミナー、合成データは MER） */
  minimalChangeRoom: string;
  /** 合成データだけ、構造で決まる値（置き換え 97 など）を確かめる */
  synthetic: boolean;
};

export const R8_DIR = fixturePath('r8');
export const hasR8 = () => existsSync(path.join(R8_DIR, 'meta.json'));
export const requireR8 = () => process.env.REQUIRE_R8_FIXTURES === '1';

export function loadSet(label: 'r8like' | 'r8'): FixtureSet {
  const fx = readFixtureDir(label === 'r8' ? R8_DIR : fixturePath('synthetic', 'r8like'));
  return {
    label,
    fx,
    ix: fixtureIndex(fx),
    input: toAllocateInput(fx),
    minimalChangeRoom: label === 'r8' ? '第一セミナー' : 'MER',
    synthetic: label !== 'r8',
  };
}

/**
 * 需要の期待値（設計 12.2）。allocate と同じ関数（buildDemand）を使わず、requests.csv（名前のまま）を団体・品目ごとに足し、
 * 読み替え（企業以外の long_desk_3 → long_desk_2）と、未提出の団体の fixed_request（rules.json）をここで明示的に当てる。
 * キーは `${groupId}|${itemId}`。
 */
export function expectedDemand(fx: FixtureData): Map<string, number> {
  const ix = fixtureIndex(fx);
  const groups = new Map(fx.groups.map((g) => [g.name, g]));
  const byName = new Map<string, number>();
  for (const row of fx.requests) {
    const g = groups.get(row.group)!;
    for (const code of ITEM_CODES) {
      const n = row.counts[code];
      if (n <= 0) continue;
      const k = `${row.group}|${independentRewrite(code, g.category)}`;
      byName.set(k, (byName.get(k) ?? 0) + n);
    }
  }
  for (const rule of fx.rules) {
    if (!rule.enabled || rule.kind !== 'fixed_request') continue;
    const p = rule.params as { group: string; item: string; count: number };
    if (groups.get(p.group)!.submittedAt === null) byName.set(`${p.group}|${p.item}`, p.count);
  }
  const out = new Map<string, number>();
  for (const [k, v] of byName) {
    if (v <= 0) continue;
    const [g, code] = k.split('|') as [string, string];
    out.set(`${ix.groupId(g)}|${ix.itemId(code)}`, v);
  }
  return out;
}
