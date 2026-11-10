// @vitest-environment jsdom
// 品目の画像の共通の部品（04「品目の画像の共通の部品」。T23・D-61）：画像なし・URL を作っている間・URL を作れなかった・読み込みの失敗
// （新しい URL なら頭文字のカード、古ければ作り直しを頼む）・押すと大きく出す。写真の欄（accept・capture・注意の文）とダイアログ。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@gaapp/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemImageUrls } from '@/lib/data/item-images';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { initialOf, ItemImage } from './item-image';
import { ITEM_PHOTO_NOTE, ItemPhotoDialog, ItemPhotoField } from './item-photo-field';

afterEach(cleanup);

const P = 'count-items/c1/i1.webp';
const urls = (m: Record<string, string>, pending = false, reportError = () => false): ItemImageUrls => ({ urls: new Map(Object.entries(m)), pending, reportError });

describe('T23 ItemImage', () => {
  it('画像のない物は頭文字のカード（文字は CSS で出し、読み上げない）', () => {
    render(<ItemImage name=" 延長コード" path={null} images={urls({})} />);
    const el = screen.getByTestId('item-image');
    expect(el.dataset.state).toBe('none');
    expect(el.dataset.initial).toBe('延');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('');
    expect(initialOf('')).toBe('？');
    expect(initialOf('𠮷野家')).toBe('𠮷');
  });

  it('URL を作っている間は枠、作れなかったら頭文字のカード', () => {
    const { rerender } = render(<ItemImage name="扇風機" path={P} images={urls({}, true)} />);
    expect(screen.getByTestId('item-image').dataset.state).toBe('loading');
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<ItemImage name="扇風機" path={P} images={urls({}, false)} />);
    expect(screen.getByTestId('item-image').dataset.state).toBe('failed');
  });

  it('URL があれば img（代替の文字は名前）。読み込めたら loaded、失敗したら（作り直さないとき）頭文字のカード', () => {
    render(<ItemImage name="扇風機" path={P} images={urls({ [P]: 'https://x/a' })} />);
    const img = screen.getByRole('img', { name: '扇風機' });
    expect(img.getAttribute('src')).toBe('https://x/a');
    expect(img.getAttribute('loading')).toBe('lazy');
    fireEvent.load(img);
    expect(screen.getByTestId('item-image').dataset.state).toBe('loaded');
    fireEvent.error(img);
    expect(screen.getByTestId('item-image').dataset.state).toBe('failed');
  });

  it('古い URL の読み込みの失敗は作り直しを頼み、新しい URL が来たら出し直す', () => {
    const reportError = vi.fn(() => true);
    const { rerender } = render(<ItemImage name="扇風機" path={P} images={urls({ [P]: 'https://x/old' }, false, reportError)} />);
    fireEvent.error(screen.getByRole('img'));
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://x/old');
    rerender(<ItemImage name="扇風機" path={P} images={urls({ [P]: 'https://x/new' })} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://x/new');
  });

  it('decorative のカードは代替の文字を空にする', () => {
    render(<ItemImage name="扇風機" path={P} images={urls({ [P]: 'https://x/a' })} decorative />);
    expect(screen.getByTestId('item-image').querySelector('img')!.getAttribute('alt')).toBe('');
  });

  it('zoomable は押すと大きく出し、Esc で閉じる', async () => {
    const user = userEvent.setup();
    render(<ItemImage name="扇風機" path={P} images={urls({ [P]: 'https://x/a' })} zoomable />);
    await user.click(screen.getByRole('button', { name: '扇風機の画像を大きく見る' }));
    const large = await screen.findByTestId('item-image-large');
    expect(large.querySelector('img')!.getAttribute('src')).toBe('https://x/a');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('item-image-large')).toBeNull());
  });

  it('item-image.tsx は Supabase と送る部品（upload・作り直し）を読まない', () => {
    const g = staticImportGraph('components/common/item-image.tsx');
    expect(g.packages).not.toContain('@supabase/supabase-js');
    expect(g.files.filter((f) => f.startsWith('lib/item-images/') || f.startsWith('lib/data/'))).toEqual([]);
  });
});

describe('T23 画像の部品を読むページ', () => {
  const IMAGE_FILES = ['components/common/item-image.tsx', 'components/common/item-photo-field.tsx', 'lib/data/item-images.ts'];
  it('ダッシュボード（/）は画像の部品を読まない（D-51）', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    expect(g.files.filter((f) => IMAGE_FILES.includes(f) || f.startsWith('lib/item-images/'))).toEqual([]);
  });

  it('/ が読む共通のファイル（lib/errors.ts など）に品目の画像の文言を入れない（lib/item-images/messages.ts に置く）', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    expect(g.files).toContain('lib/errors.ts');
    const root = path.join(repoRoot(), 'apps', 'web');
    const text = /item_image_denied|送っている途中の写真|画像の置き場/;
    expect(g.files.filter((f) => text.test(readFileSync(path.join(root, f), 'utf8')))).toEqual([]);
  });

  it('在庫入力・申請・マスタ設定は画像の部品を読み、送る部品（作り直し・upload）は動的 import だけで読む', () => {
    for (const page of ['app/(app)/stock/page.tsx', 'app/(app)/request/page.tsx', 'app/(app)/settings/page.tsx']) {
      const g = staticImportGraph(page);
      expect(g.files).toContain('components/common/item-image.tsx');
      expect(g.files.filter((f) => f.startsWith('lib/item-images/'))).toEqual([]);
    }
  });
});

describe('T23 ItemPhotoField・ItemPhotoDialog', () => {
  it('カメラを開く input（accept image/*・capture environment）と注意の文', () => {
    render(<ItemPhotoField file={null} onChange={() => {}} />);
    const input = screen.getByTestId('item-photo-input');
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    expect(screen.getByText(ITEM_PHOTO_NOTE)).toBeTruthy();
    expect(ITEM_PHOTO_NOTE).toBe('人の顔・名前・掲示物が写らないように撮ってください');
  });

  it('ダイアログ：写真を選ぶまで送れず、失敗の文言を出して閉じない。成功したら閉じる。ファイルの名前は出さない', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn<(f: File) => Promise<string | null>>().mockResolvedValueOnce('写真は1枚 1 MB までです').mockResolvedValueOnce(null);
    render(<ItemPhotoDialog open onOpenChange={onOpenChange} title="「扇風機」の写真を足す" onSubmit={onSubmit} />);
    const dialog = await screen.findByTestId('item-photo-dialog');
    const submit = screen.getByTestId('item-photo-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const file = new File(['x'], '山田の写真.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByTestId('item-photo-input'), file);
    expect(dialog.textContent).toContain('写真を選びました');
    expect(dialog.textContent).not.toContain('山田の写真');
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '写真は1枚 1 MB までです');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await user.click(screen.getByTestId('item-photo-submit'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0]![0]).toBe(file);
  });
});
