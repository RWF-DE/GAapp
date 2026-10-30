import { describe, expect, it } from 'vitest';
import { allocationHref, parseAllocationQuery } from './allocation-query';

const UUID = '0b6f5c3e-2a1d-4c8e-9f7a-1234567890ab';
const TEMP = `new-${'9d3c1a2b-7e6f-4a5b-8c9d-0e1f2a3b4c5d'}`;
const parse = (s: string) => parseAllocationQuery(new URLSearchParams(s));

describe('URL のクエリ（/allocation）', () => {
  it('既定は品目別。合わない値は捨てる', () => {
    expect(parse('')).toEqual({ view: 'item' });
    expect(parse('view=x&row=abc&group=1')).toEqual({ view: 'item' });
  });

  it('row は DB の行の uuid', () => {
    expect(parse(`row=${UUID}`).row).toBe(UUID);
  });

  it('row は未保存の追加の行の仮の id（new-<uuid>）も受け付け、href と往復する（検証の rowIds に入るため）', () => {
    expect(parse(`row=${TEMP}`).row).toBe(TEMP);
    const href = allocationHref({ view: 'item', tab: 'desk', row: TEMP });
    expect(parse(href.split('?')[1]!)).toEqual({ view: 'item', tab: 'desk', row: TEMP });
  });

  it('new- で始まっても形が合わなければ捨てる', () => {
    expect(parse('row=new-').row).toBeUndefined();
    expect(parse(`row=${encodeURIComponent('new-<script>')}`).row).toBeUndefined();
    expect(parse(`row=new-${'a'.repeat(100)}`).row).toBeUndefined();
  });
});
