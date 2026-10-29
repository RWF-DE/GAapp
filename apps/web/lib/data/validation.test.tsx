// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { runValidation, UNVALIDATABLE_PROBLEM, useValidation } from './validation';
import { toYearData } from './year-data';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snapshot = fixtureSnapshot(fx, { version: 12 });

afterEach(() => {
  vi.useRealTimers();
});

describe('runValidation', () => {
  it('検証した版を持つ（確定の流れで「検証した版が v」を確かめる）', () => {
    const v = runValidation(toYearData(snapshot), [], 12);
    expect(v.status).toBe('ok');
    expect(v.version).toBe(12);
    // 行がないので申請の不足（E003）が出る
    expect(v.issues.some((i) => i.code === 'E003')).toBe(true);
  });

  it('validate が例外を投げたら（行が年度にない団体を指す）検証できない', () => {
    const row = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceRoomId: snapshot.rooms[0]!.id,
      groupId: '99999999-9999-4999-8999-999999999999',
      itemId: snapshot.items[0]!.id,
      requestedItemId: snapshot.items[0]!.id,
      count: 1,
      isKeep: false,
      origin: 'manual' as const,
      pinned: false,
      note: null,
    };
    const v = runValidation(toYearData(snapshot), [row]);
    expect(v).toMatchObject({ status: 'unavailable', issues: [], problems: [UNVALIDATABLE_PROBLEM] });
  });
});

describe('useValidation', () => {
  it('スナップショットの行で検証する。viewer（public）とスナップショットなしは検証しない', () => {
    const { result, rerender } = renderHook(({ s }) => useValidation(s), { initialProps: { s: snapshot as typeof snapshot | undefined } });
    expect(result.current.status).toBe('ok');
    expect(result.current.yearData?.validatable).toBe(true);
    rerender({ s: { ...snapshot, part: 'public' } });
    expect(result.current.status).toBe('skipped');
    rerender({ s: undefined });
    expect(result.current).toMatchObject({ status: 'skipped', version: null });
  });

  it('未保存の変更が出た最初は今の行ですぐに検証し、その後の変更は 150 ms まとめて検証する（古い行に今の版を付けない）', () => {
    vi.useFakeTimers();
    const extra = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceRoomId: snapshot.rooms[0]!.id,
        groupId: '99999999-9999-4999-8999-999999999999',
        itemId: snapshot.items[0]!.id,
        requestedItemId: snapshot.items[0]!.id,
        count: 1,
        isKeep: false,
        origin: 'manual' as const,
        pinned: false,
        note: null,
      },
    ];
    const { result, rerender } = renderHook(({ rows }) => useValidation(snapshot, rows), {
      initialProps: { rows: undefined as typeof extra | undefined },
    });
    expect(result.current.status).toBe('ok');
    // 未保存の変更が出た最初：前の行（スナップショットの行）で回さず、今の行ですぐに検証する
    rerender({ rows: extra });
    expect(result.current).toMatchObject({ status: 'unavailable', version: 12 });
    // その後の変更は 150 ms まとめる
    const fixed: typeof extra = [];
    rerender({ rows: fixed });
    act(() => vi.advanceTimersByTime(149));
    expect(result.current.status).toBe('unavailable');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.status).toBe('ok');
    // 変更がなくなって、また出たときも、前の未保存の行（fixed）からではなく今の行から始める
    rerender({ rows: undefined });
    expect(result.current.status).toBe('ok');
    rerender({ rows: extra });
    expect(result.current.status).toBe('unavailable');
  });

  it('スナップショットの版が変わったら、まとめるのを待たずに今の行で検証する（結果の版と行を食い違わせない）', () => {
    vi.useFakeTimers();
    const bad = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceRoomId: snapshot.rooms[0]!.id,
        groupId: '99999999-9999-4999-8999-999999999999',
        itemId: snapshot.items[0]!.id,
        requestedItemId: snapshot.items[0]!.id,
        count: 1,
        isKeep: false,
        origin: 'manual' as const,
        pinned: false,
        note: null,
      },
    ];
    const good: typeof bad = [];
    const { result, rerender } = renderHook(({ s, rows }) => useValidation(s, rows), {
      initialProps: { s: snapshot, rows: bad as typeof bad | undefined },
    });
    expect(result.current).toMatchObject({ status: 'unavailable', version: 12 });
    rerender({ s: { ...snapshot, version: 13 }, rows: good });
    expect(result.current).toMatchObject({ status: 'ok', version: 13 });
  });
});
