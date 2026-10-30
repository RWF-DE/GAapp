import type { Issue } from '@gaapp/shared';
import { describe, expect, it } from 'vitest';
import { issueTarget, ruleHref } from './issue-target';

const index = {
  rowItem: new Map([['row-1', 'item-desk-ng']]),
  tabByItem: new Map([
    ['item-desk', 'desk'],
    ['item-desk-ng', 'desk'],
    ['item-chair', 'chair'],
  ]),
};
const issue = (refs: Issue['refs']): Pick<Issue, 'refs'> => ({ refs });

describe('issueTarget', () => {
  it('rowIds があればその行（行の品目のタブ）', () => {
    expect(issueTarget(issue({ rowIds: ['row-1'], roomId: 'r', itemId: 'item-chair' }), index, ['admin']).destination).toEqual({
      kind: 'row',
      rowId: 'row-1',
      tab: 'desk',
    });
  });

  it('画面にない行は飛ばして次の行き先（部屋と品目）', () => {
    expect(issueTarget(issue({ rowIds: ['gone'], roomId: 'r', itemId: 'item-chair' }), index, ['admin']).destination).toEqual({
      kind: 'room',
      roomId: 'r',
      tab: 'chair',
    });
  });

  it('groupId だけなら団体別のその団体', () => {
    expect(issueTarget(issue({ groupId: 'g', requestedItemId: 'item-desk' }), index, ['admin']).destination).toEqual({ kind: 'group', groupId: 'g' });
  });

  it('roomId だけなら今のタブの部屋、itemId だけならそのタブ、何もなければ移動しない', () => {
    expect(issueTarget(issue({ roomId: 'r' }), index, ['admin']).destination).toEqual({ kind: 'room', roomId: 'r', tab: null });
    expect(issueTarget(issue({ itemId: 'item-chair' }), index, ['admin']).destination).toEqual({ kind: 'tab', tab: 'chair' });
    expect(issueTarget(issue({}), index, ['admin']).destination).toEqual({ kind: 'none' });
  });

  it('ルール：admin にはルール画面へのリンク', () => {
    const t = issueTarget(issue({ ruleCode: 'S05', groupId: 'g' }), index, ['admin'], 'allocating');
    expect(t.rule).toEqual({ code: 'S05', href: ruleHref('S05') });
    expect(t.rule!.href).toBe('/rules?code=S05');
  });

  it('ルール：staff（Q1）にはリンクにせず、コードだけ（内容の文は画面が出す）', () => {
    const t = issueTarget(issue({ ruleCode: 'S05', groupId: 'g' }), index, ['staff'], 'allocating');
    expect(t.rule).toEqual({ code: 'S05', href: null });
    expect(t.destination).toEqual({ kind: 'group', groupId: 'g' });
  });

  it('ルール：staff と団体代表を兼ねていてもルール画面は開けない。admin を兼ねていれば開ける', () => {
    expect(issueTarget(issue({ ruleCode: 'S07' }), index, ['staff', 'rep']).rule!.href).toBeNull();
    expect(issueTarget(issue({ ruleCode: 'S07' }), index, ['admin', 'rep']).rule!.href).toBe('/rules?code=S07');
  });

  it('ルールのコードは URL に入れるときにエスケープする', () => {
    expect(issueTarget(issue({ ruleCode: 'A&B' }), index, ['admin']).rule!.href).toBe('/rules?code=A%26B');
  });

  it('ruleCode がなければ rule は null', () => {
    expect(issueTarget(issue({ roomId: 'r' }), index, ['admin']).rule).toBeNull();
  });
});
