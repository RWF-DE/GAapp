// お知らせの入力の zod（04「お知らせ一覧」の書く、notes/T17.md「後半（画面）の約束」4。T17）。
// DB（0014 の save_notice・notices の CHECK）と同じ形：題名は JavaScript の trim の 25 文字を除いて 1〜100 字、本文は 4000 字
// （空白だけなら null）、字数はコードポイント、宛先が指定の団体なら団体は 1〜1000 で重なりなし。
import { describe, expect, it } from 'vitest';
import {
  charCount,
  checkNoticeForm,
  emptyNoticeForm,
  NOTICE_BODY_MAX,
  NOTICE_GROUPS_MAX,
  NOTICE_TITLE_MAX,
  noticeBodySchema,
  noticeFormSchema,
  noticeTitleSchema,
  toSaveNoticeArgs,
  type NoticeFormValues,
} from './notices';

/** JavaScript の trim が除く 25 文字（0014 の c_space・notices_title_check と同じ。notes/T17.md の T17A-1） */
const JS_SPACES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map((c) => String.fromCodePoint(c));
/** JavaScript の trim が除かない、空白に似た文字（DB も除かない） */
const NOT_SPACES = ['\u200b', '\u0085', '\u180e', '\u3164'];
/** 補助面の文字（JavaScript の length は 2、DB の length は 1） */
const EMOJI = '😀';

const form = (over: Partial<NoticeFormValues> = {}): NoticeFormValues => ({ ...emptyNoticeForm(), title: '題名', ...over });

describe('T17 題名（noticeTitleSchema）', () => {
  it('25 文字の空白のどれも前後から除く。全部を前後に並べても除く', () => {
    expect(JS_SPACES).toHaveLength(25);
    for (const sp of JS_SPACES) {
      expect(noticeTitleSchema.parse(`${sp}題名${sp}`), `U+${sp.codePointAt(0)!.toString(16)}`).toBe('題名');
      expect(noticeTitleSchema.safeParse(sp).success, `U+${sp.codePointAt(0)!.toString(16)} だけ`).toBe(false);
    }
    expect(noticeTitleSchema.parse(`${JS_SPACES.join('')}題 名${JS_SPACES.join('')}`)).toBe('題 名');
  });

  it('JavaScript の trim が除かない文字（U+200B など）は除かない', () => {
    for (const c of NOT_SPACES) expect(noticeTitleSchema.parse(`${c}題名${c}`)).toBe(`${c}題名${c}`);
  });

  it('空・空白だけは「題名を入れてください」', () => {
    for (const v of ['', '   ', '\u3000\t\n']) {
      const r = noticeTitleSchema.safeParse(v);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toBe('題名を入れてください');
    }
  });

  it(`${NOTICE_TITLE_MAX} 字まで（コードポイントで数える。補助面の文字も1字）。101 字は「題名は 100 字までです」`, () => {
    expect(NOTICE_TITLE_MAX).toBe(100);
    expect(noticeTitleSchema.safeParse(EMOJI.repeat(100)).success).toBe(true);
    expect(EMOJI.repeat(100).length).toBe(200);
    const r = noticeTitleSchema.safeParse(EMOJI.repeat(101));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('題名は 100 字までです');
    // 前後の空白は数えない
    expect(noticeTitleSchema.safeParse(`  ${'あ'.repeat(100)}\u3000`).success).toBe(true);
    expect(charCount(EMOJI)).toBe(1);
  });
});

describe('T17 本文（noticeBodySchema）', () => {
  it('空白だけ（25 文字のどれでも）なら null。前後の空白・改行は残す', () => {
    expect(noticeBodySchema.parse('')).toBeNull();
    for (const sp of JS_SPACES) expect(noticeBodySchema.parse(`${sp}${sp}`)).toBeNull();
    expect(noticeBodySchema.parse('\n  一行目\n\n  二行目  \n')).toBe('\n  一行目\n\n  二行目  \n');
  });

  it(`${NOTICE_BODY_MAX} 字まで（コードポイント）。4001 字は「本文は 4000 字までです」。空白だけの長い本文は null で通る（DB と同じ）`, () => {
    expect(noticeBodySchema.parse(EMOJI.repeat(4000))).toBe(EMOJI.repeat(4000));
    const r = noticeBodySchema.safeParse('あ'.repeat(4001));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('本文は 4000 字までです');
    expect(noticeBodySchema.parse(' '.repeat(5000))).toBeNull();
  });
});

describe('T17 入力（noticeFormSchema・checkNoticeForm）', () => {
  it('宛先が指定の団体なら、宛先の団体は 1〜1000 で重なりなし（path は groupIds）', () => {
    const groups = (n: number) => Array.from({ length: n }, (_, k) => `g${k}`);
    const msg = (v: NoticeFormValues) => checkNoticeForm(v).errors.groupIds;
    expect(msg(form({ audience: 'groups', groupIds: [] }))).toBe('宛先の団体を1つ以上選んでください');
    expect(msg(form({ audience: 'groups', groupIds: ['g1'] }))).toBeUndefined();
    expect(NOTICE_GROUPS_MAX).toBe(1000);
    expect(msg(form({ audience: 'groups', groupIds: groups(1000) }))).toBeUndefined();
    expect(msg(form({ audience: 'groups', groupIds: groups(1001) }))).toBe('宛先の団体は 1000 までです');
    expect(msg(form({ audience: 'groups', groupIds: ['g1', 'g2', 'g1'] }))).toBe('同じ団体が重なっています');
  });

  it('ほかの宛先では宛先の団体を確かめない（宛先を切り替えても、選んだ団体をフォームが覚えておける）', () => {
    for (const audience of ['soumu', 'all_groups'] as const) {
      expect(checkNoticeForm(form({ audience, groupIds: [] })).write).not.toBeNull();
      expect(checkNoticeForm(form({ audience, groupIds: ['g1', 'g1'] })).write).not.toBeNull();
    }
  });

  it('欄ごとの最初のエラーを返す（題名と宛先の団体を一度に）。通れば write（題名は除いた形、本文は null か文字列）', () => {
    const bad = checkNoticeForm(form({ audience: 'groups', title: ' ', body: 'あ'.repeat(4001), groupIds: [] }));
    expect(bad.write).toBeNull();
    expect(bad.errors).toEqual({ title: '題名を入れてください', body: '本文は 4000 字までです', groupIds: '宛先の団体を1つ以上選んでください' });
    const ok = checkNoticeForm(form({ title: '\u3000お知らせ ', body: '  ', pinned: true }));
    expect(ok.errors).toEqual({});
    expect(ok.write).toEqual({ audience: 'soumu', title: 'お知らせ', body: null, pinned: true, groupIds: [] });
  });

  it('知らない宛先は通らない', () => {
    expect(noticeFormSchema.safeParse({ ...form(), audience: 'everyone' }).success).toBe(false);
  });

  it('新しく書くときの既定：総務内・題名と本文は空・ピン留めは外す', () => {
    expect(emptyNoticeForm()).toEqual({ audience: 'soumu', title: '', body: '', pinned: false, groupIds: [] });
  });
});

describe('T17 toSaveNoticeArgs（save_notice の引数）', () => {
  const Y = 'y1';
  it('出す：notice_id・base_updated_at を付けない。本文が null なら p_body を入れない。ほかの宛先の団体は空', () => {
    const w = checkNoticeForm(form({ audience: 'all_groups', title: '全団体へ', body: ' ', groupIds: ['g1'] })).write!;
    expect(toSaveNoticeArgs(Y, w, null)).toEqual({ p_year_id: Y, p_audience: 'all_groups', p_title: '全団体へ', p_pinned: false, p_group_ids: [] });
  });

  it('直す：全部の欄と、読んだときの updated_at の文字列をそのまま（Date にしない）。指定の団体は渡した並びのまま', () => {
    const w = checkNoticeForm(form({ audience: 'groups', title: '団体へ', body: '本文\n', pinned: true, groupIds: ['g2', 'g1'] })).write!;
    const at = '2026-10-01T09:00:00.123456+00:00';
    expect(toSaveNoticeArgs(Y, w, { id: 'n1', updatedAt: at })).toEqual({
      p_year_id: Y,
      p_audience: 'groups',
      p_title: '団体へ',
      p_body: '本文\n',
      p_pinned: true,
      p_group_ids: ['g2', 'g1'],
      p_notice_id: 'n1',
      p_base_updated_at: at,
    });
  });
});
