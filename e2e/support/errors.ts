// 本物の DB の応答を lib/errors.ts の classifyError・messageFor に通して確かめる補助（画面の設計 2.5。T09a）。
// e2e/errors.spec.ts（並行）と e2e/serial/errors.spec.ts（最新の年度が要るもの）が使う。
import { expect } from '@playwright/test';
import { classifyError, messageFor, type ClassifiedError, type ErrorKind, type MessageContext } from '../../apps/web/lib/errors';
import type { RestResult } from './auth';

/** 表にない field・reason のときの文言（これに落ちたら、2.5 の表と DB の details が食い違っている） */
export const GENERIC = ['入力の形が違います', 'この操作はできません', '他の人が先に変更しました。読み直しました', '振り分けに誤りがあります'];

export function classified(r: RestResult<unknown>): ClassifiedError {
  expect(r.error, '失敗するはずの呼び出しが通りました').not.toBeNull();
  return classifyError(r.error, r.status);
}

/** 種類と文言を確かめ、分類したエラーを返す（details の形も確かめるとき用） */
export function expectMessage(r: RestResult<unknown>, kind: ErrorKind, ctx: MessageContext, expected: string | RegExp): ClassifiedError {
  const e = classified(r);
  expect(e.kind, JSON.stringify(r.error)).toBe(kind);
  const m = messageFor(e, ctx);
  expect(GENERIC).not.toContain(m);
  expect(m).not.toMatch(/^予期しないエラー/);
  if (typeof expected === 'string') expect(m).toBe(expected);
  else expect(m).toMatch(expected);
  return e;
}
