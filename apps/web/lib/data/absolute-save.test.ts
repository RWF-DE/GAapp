import { describe, expect, it } from 'vitest';
import { decideAbsoluteSave, type AbsoluteSaveEntry } from './absolute-save';

type E = AbsoluteSaveEntry<number | null>;
const entry = (input: number | null, base: number | null, fresh: number | null, changed: boolean, byOther?: boolean): E => ({
  input,
  base,
  fresh,
  changed,
  ...(byOther === undefined ? {} : { byOther }),
});

describe('decideAbsoluteSave（絶対値の書き込みの送る前の読み直し。2.6）', () => {
  it('誰も保存していなければ送る（読み込んだ後に変わった行がない）', () => {
    expect(decideAbsoluteSave([entry(5, 3, 3, false), entry(0, null, null, false)])).toBe('send');
  });

  it('数え直し・再提出：値が入力と同じでも、どの行も変わっていなければ送る', () => {
    expect(decideAbsoluteSave([entry(3, 3, 3, false), entry(1, 1, 1, false)])).toBe('send');
  });

  it('前に送って応答が届かなかった保存が通っていた：すべて入力と同じで行が変わっていれば保存されていた', () => {
    expect(decideAbsoluteSave([entry(5, 3, 5, true, false), entry(0, null, 0, true, false)])).toBe('saved');
  });

  it('ほかの人が入力と同じ値にしていた：保存されていた（ほかの人の変更としない）', () => {
    expect(decideAbsoluteSave([entry(5, 3, 5, true, true)])).toBe('saved');
  });

  it('ほかの人が保存していた（在庫の counted_by・提出の記録の updated_by が自分でない）：ダイアログ', () => {
    expect(decideAbsoluteSave([entry(5, 3, 4, true, true), entry(2, 2, 2, true, true)])).toBe('conflict');
  });

  it('自分の書いたもの（応答が届かなかった前の保存）の後に入力を変えた：ほかの人の変更とせず送る', () => {
    // 前に 5 を送って通り、その後で 6 に直して押した
    expect(decideAbsoluteSave([entry(6, 3, 5, true, false), entry(0, 0, 0, true, false)])).toBe('send');
  });

  it('一部の行だけ入力と違う：保存されていたとしない', () => {
    expect(decideAbsoluteSave([entry(5, 3, 5, true, false), entry(1, 0, 0, false)])).toBe('send');
  });

  describe('byOther を省く（申請の行：値が入力の元とも入力とも違えばほかの人）', () => {
    it('値が入力の元とも入力とも違う：ダイアログ', () => {
      expect(decideAbsoluteSave([entry(5, 3, 4, true)])).toBe('conflict');
    });
    it('行は変わったが値は入力の元のまま（ほかの人が同じ数で書いた）：送る', () => {
      expect(decideAbsoluteSave([entry(5, 3, 3, true)])).toBe('send');
    });
    it('値が入力と同じ：保存されていた', () => {
      expect(decideAbsoluteSave([entry(5, 3, 5, true)])).toBe('saved');
    });
    it('行が消えていた（null）：入力の元とも入力とも違うのでダイアログ', () => {
      expect(decideAbsoluteSave([entry(5, 3, null, true)])).toBe('conflict');
    });
  });

  it('変わっていない行の byOther は見ない', () => {
    expect(decideAbsoluteSave([entry(5, 3, 3, false, true)])).toBe('send');
  });

  it('比べるものがなければ送る', () => {
    expect(decideAbsoluteSave([])).toBe('send');
  });

  it('equals を渡せる（申請の品目の数と提出の記録を1つの値にまとめるときなど）', () => {
    type V = { count: number; note: string };
    const eq = (a: V, b: V) => a.count === b.count && a.note === b.note;
    const v = (count: number, note = '') => ({ count, note });
    expect(decideAbsoluteSave([{ input: v(2, 'a'), base: v(1), fresh: v(2, 'a'), changed: true, byOther: false }], eq)).toBe('saved');
    expect(decideAbsoluteSave([{ input: v(2, 'a'), base: v(1), fresh: v(2, 'b'), changed: true }], eq)).toBe('conflict');
  });
});
