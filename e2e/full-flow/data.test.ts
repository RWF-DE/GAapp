// 通しの流れ（e2e/serial/full-flow.spec.ts）の入力で、full と最小変更が解け、D-08 の判定が通ることを E2E の前に確かめる
// （画面の設計 7.3 の手順 4。データの選び方の誤りを E2E の失敗と取り違えないため）。DB にはつながない。
import { describe, expect, it } from 'vitest';
import { allocate } from '@gaapp/allocator';
import { checkMinimalChange, getHighs } from '@gaapp/allocator/testing';
import { fixtureIndex } from '@gaapp/shared/testing';
import { syntheticDataset } from '../support/datasets';
import {
  GROUP_A,
  GROUP_B,
  GROUP_C,
  ROOM_M,
  UNMATCHED_NAME,
  UNMATCHED_ROW,
  flowInput,
  importedCounts,
  parseStallCsv,
  requestOf,
  resolveStallCsv,
} from './flow';

const FLOW_GROUPS = [GROUP_A, GROUP_B, GROUP_C];

describe('通しの流れのデータ（7.3）', () => {
  it('団体 A・B・C は r8like の模擬店で、ルール S05・S06・S08 と了承の行がない', () => {
    const fx = syntheticDataset();
    for (const name of FLOW_GROUPS) {
      const g = fx.groups.find((x) => x.name === name);
      expect(g, name).toBeDefined();
      expect(g!.category).toBe('stall');
      expect(g!.submittedAt, `${name} は提出済み`).not.toBeNull();
      expect(fx.consents.filter((c) => c.group === name), `${name} の了承の行`).toEqual([]);
    }
    for (const r of fx.rules) {
      if (r.kind === 'source_restrict' || r.kind === 'fixed_request' || r.kind === 'keep') {
        expect(FLOW_GROUPS, `${r.code} の団体`).not.toContain(r.params.group);
      }
    }
  });

  it('CSV：対応しない行は1つ（マスタにない名前）、B と C に古い回答、A は入っていない。メールと氏名の列は読まない', () => {
    const fx = syntheticDataset();
    const ix = fixtureIndex(fx);
    const parsed = parseStallCsv();
    expect(parsed.rejected).toEqual([]);
    expect(parsed.responses).toHaveLength(4);
    expect(parsed.responses.map((r) => r.groupName)).not.toContain(GROUP_A);
    expect(parsed.ignoredColumns).toEqual(expect.arrayContaining(['代表者氏名', '学籍番号', '電話番号']));
    // r8like の提出日時（2026-07-01）より新しい（取り込みの既定で上書きされる）
    for (const r of parsed.responses) expect(Date.parse(r.submittedAt)).toBeGreaterThan(Date.parse('2026-07-01T12:59:00+09:00'));

    const before = resolveStallCsv(fx, { manual: false });
    expect(before.unmatched).toEqual([{ rowNumber: UNMATCHED_ROW, groupName: UNMATCHED_NAME }]);

    const after = resolveStallCsv(fx);
    expect(after.unmatched).toEqual([]);
    expect(after.superseded).toEqual(
      expect.arrayContaining([
        { groupId: ix.groupId(GROUP_B), keptRow: UNMATCHED_ROW, droppedRows: [3] },
        { groupId: ix.groupId(GROUP_C), keptRow: 4, droppedRows: [2] },
      ]),
    );
    expect(new Set(after.submissions.map((s) => ix.groupName.get(s.groupId)))).toEqual(new Set([GROUP_B, GROUP_C]));
  });

  it('需要を増やさない：B・C の取り込み後の数はどの品目も今の申請以下で、少なくとも1品目は減る', () => {
    const fx = syntheticDataset();
    const imported = importedCounts(fx);
    expect([...imported.keys()].sort()).toEqual([GROUP_B, GROUP_C].sort());
    for (const name of [GROUP_B, GROUP_C]) {
      const now = requestOf(fx, name);
      const next = imported.get(name)!;
      for (const [code, n] of Object.entries(next)) expect(n, `${name} の ${code}`).toBeLessThanOrEqual(now[code] ?? 0);
      const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
      expect(total(next), `${name} の合計`).toBeLessThan(total(now));
    }
  });

  it(
    'この入力で full が解け、MER を使用不可にした最小変更も解けて D-08 の判定が通る',
    async () => {
      const fx = syntheticDataset();
      const ix = fixtureIndex(fx);
      const input = flowInput(fx);
      const solver = await getHighs();
      const full = allocate(input, solver);
      expect(full.ok).toBe(true);

      const M = ix.roomId(ROOM_M);
      const r = checkMinimalChange(input, M, solver);
      if (!r.ok) throw new Error(`最小変更の判定ができません：${r.reason}（full ${r.fullOk ? '解けた' : '解けない'}）`);
      expect(r.fromM).toBeGreaterThan(0);
      expect(r.decreased).toEqual([]);
      expect(r.unrelatedChanged).toEqual([]);
      expect(r.untouchedChanged).toEqual([]);
      // E2E（e2e/serial/full-flow.spec.ts）の annotations と notes/T14.md に同じ数を記録する
      console.info(
        `[full-flow data] MER から ${r.fromM} 行、つながり ${r.comps}（補える ${r.good}・補えない ${r.bad}）、` +
          `補えないつながりで変わった行 ${r.changedInBad}、前回の行が増えた ${r.increased.length}・新しい行 ${r.appeared.length}`,
      );
    },
    120_000,
  );
});
