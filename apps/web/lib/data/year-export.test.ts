import { exportYearJson } from '@gaapp/exporter';
import type { Json } from '@gaapp/shared';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleDbRow } from '@/lib/db/types';
import { createFakeSupabase } from '@/lib/testing/fake-supabase';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { brokenRulesNotice, downloadYearJson, toYearExport } from './year-export';

const saved = vi.hoisted(() => ({ files: [] as { data: Uint8Array | string; fileName: string; mime: string }[] }));
vi.mock('@/lib/download', async (orig) => ({
  ...(await orig<typeof import('@/lib/download')>()),
  downloadFile: (data: Uint8Array | string, fileName: string, mime: string) => saved.files.push({ data, fileName, mime }),
}));

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));

beforeEach(() => {
  saved.files.length = 0;
});

const brokenRule = (over: Partial<RuleDbRow> = {}): RuleDbRow => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  year_id: 'y',
  code: 'X99',
  kind: 'keep',
  params: { group: 'not-a-uuid', items: {} } as NonNullable<Json>,
  enabled: true,
  memo: '壊れたルール',
  updated_at: FIXTURE_UPDATED_AT,
  ...over,
});

describe('toYearExport', () => {
  it('合成データ r8like の全部の表を YearExport の形にする（無効なルール・memo・別名・note を含む）', () => {
    const snap = fixtureSnapshot(fx);
    const disabled: RuleDbRow = { ...snap.rules[0]!, id: '00000000-0000-4000-8000-0000000000d1', code: 'Z01', enabled: false, memo: '今年は使わない' };
    const s = {
      ...snap,
      rules: [...snap.rules, disabled],
      submissions: snap.submissions.map((x, k) => (k === 0 ? { ...x, note: '提出の備考' } : x)),
      groups: snap.groups.map((g, k) => (k === 0 ? { ...g, display_name: '  ', is_food: true } : g)),
    };
    const { data, brokenRuleCodes } = toYearExport(s, '2026-10-29T00:00:00.000Z');
    expect(brokenRuleCodes).toEqual([]);
    expect(data.yearLabel).toBe(fx.meta.yearLabel);
    expect(data.exportedAt).toBe('2026-10-29T00:00:00.000Z');
    expect(data.items).toHaveLength(snap.items.length);
    expect(data.rooms).toHaveLength(fx.rooms.length);
    expect(data.groups).toHaveLength(fx.groups.length);
    expect(data.stocks).toHaveLength(snap.stocks.length);
    expect(data.requests).toHaveLength(snap.requests.length);
    expect(data.consents).toHaveLength(snap.consents.length);
    expect(data.distanceOverrides).toHaveLength(fx.distanceOverrides.length);
    // 無効なルールも memo つきで入る
    expect(data.rules.find((r) => r.code === 'Z01')).toMatchObject({ enabled: false, memo: '今年は使わない' });
    expect(data.rules).toHaveLength(snap.rules.length + 1);
    // 空白だけの表示名は null、飲食・別名は DB の値
    expect(data.groups[0]).toMatchObject({ displayName: null, isFood: true });
    expect(data.groups[0]!.aliases).toEqual(snap.groups[0]!.aliases);
    expect(data.submissions[0]!.note).toBe('提出の備考');
    // 場所の使用は room_years（行がなければ使用可）
    for (const r of fx.rooms) {
      expect(data.rooms.find((x) => x.name === r.name)!.usable).toBe(r.usable);
    }
  });

  it('振り分けの行は id・origin・pinned・note を持つ', () => {
    const snap = fixtureSnapshot(fx);
    const g = snap.groups[0]!;
    const s = {
      ...snap,
      allocations: [
        {
          id: '00000000-0000-4000-8000-00000000a001',
          year_id: snap.year.id,
          source_room_id: snap.rooms[0]!.id,
          group_id: g.id,
          item_id: snap.items[0]!.id,
          requested_item_id: snap.items[0]!.id,
          count: 3,
          is_keep: false,
          origin: 'manual' as const,
          pinned: true,
          note: '手で直した',
          updated_at: FIXTURE_UPDATED_AT,
        },
      ],
    };
    const { data } = toYearExport(s);
    expect(data.exportedAt).toBeUndefined();
    expect(data.rows).toEqual([
      {
        id: '00000000-0000-4000-8000-00000000a001',
        sourceRoomId: snap.rooms[0]!.id,
        groupId: g.id,
        itemId: snap.items[0]!.id,
        requestedItemId: snap.items[0]!.id,
        count: 3,
        isKeep: false,
        origin: 'manual',
        pinned: true,
        note: '手で直した',
      },
    ]);
  });

  it('設定の壊れたルールも省かず、DB の params のまま書き出す（書き出しも止めない）', () => {
    const snap = fixtureSnapshot(fx);
    const broken = brokenRule();
    const brokenDisabled = brokenRule({ id: '00000000-0000-4000-8000-0000000000b2', code: 'X98', enabled: false, params: 'oops' as NonNullable<Json> });
    const { data, brokenRuleCodes } = toYearExport({ ...snap, rules: [...snap.rules, broken, brokenDisabled] });
    expect(brokenRuleCodes).toEqual(['X99', 'X98']);
    expect(data.rules.find((r) => r.code === 'X99')!.params).toEqual({ group: 'not-a-uuid', items: {} });
    expect(data.rules.find((r) => r.code === 'X98')!.params).toBe('oops');
    // exporter の JSON にもそのまま入る
    const json = JSON.parse(exportYearJson(data)) as { rules: { code: string; params: unknown; memo: string | null }[] };
    expect(json.rules.find((r) => r.code === 'X99')).toMatchObject({ params: { group: 'not-a-uuid', items: {} }, memo: '壊れたルール' });
    expect(json.rules).toHaveLength(snap.rules.length + 2);
  });

  it('書き出した後の文', () => {
    expect(brokenRulesNotice([])).toBeNull();
    expect(brokenRulesNotice(['X99', 'X98'])).toBe(
      '設定の壊れたルール 2 件（X99、X98）をそのまま書き出しました。ルール画面で直してください',
    );
  });
});

describe('downloadYearJson', () => {
  it('スナップショットを読んで {年度}_年度データ.json を保存させ、メールアドレスを伏せる', async () => {
    const snap = fixtureSnapshot(fx);
    const rules = [...snap.rules, brokenRule({ memo: '連絡先 someone@example.test' })];
    const tables: Record<string, unknown[]> = {
      years: [snap.year],
      items: snap.items,
      rooms: snap.rooms,
      room_years: snap.roomYears,
      groups: snap.groups,
      request_submissions: snap.submissions,
      stocks: snap.stocks,
      requests: snap.requests,
      rules,
      substitution_consents: snap.consents,
      distance_overrides: snap.distanceOverrides,
      allocations: [],
    };
    const { client } = createFakeSupabase((call) => {
      const rows = tables[call.table] ?? [];
      if (call.table === 'years') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    });
    const r = await downloadYearJson(snap.year.id, client);
    expect(r.fileName).toBe(`${fx.meta.yearLabel}_年度データ.json`);
    expect(r.brokenRuleCodes).toEqual(['X99']);
    expect(saved.files).toHaveLength(1);
    const file = saved.files[0]!;
    expect(file.fileName).toBe(r.fileName);
    expect(file.mime).toContain('application/json');
    const text = file.data as string;
    expect(text).not.toContain('someone@example.test');
    expect(JSON.parse(text).rules).toHaveLength(rules.length);
  });
});
