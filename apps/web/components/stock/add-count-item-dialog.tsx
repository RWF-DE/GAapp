'use client';

// 在庫入力の「＋ その他を足す」のダイアログ（04「在庫入力」の備品〔数えるだけ〕。T22・D-60）。
// 選択肢（最初から出す物と、もう出ている物を除いた count_items。名前で絞れる）から選ぶか、「新しく登録」で名前を書く
// （1〜50 字。同じ名前〔全角・半角と大文字小文字を無視〕があれば、その物を足す。なければ RPC add_count_item。呼ぶ側の onCreate）。
// T23・D-61：選択肢は画像のカード（画像と名前。画像のない物は頭文字のカード。44px 以上の押せる大きさ）。「新しく登録」には写真の欄
// （任意。カメラかファイル。注意の文つき）があり、写真は呼ぶ側が名前を足した後に送る（画像の段で失敗しても名前の登録は残す）。
import { useId, useState } from 'react';
import { ItemImage } from '@/components/common/item-image';
import { ItemPhotoField } from '@/components/common/item-photo-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ItemImagePaths, ItemImageUrls } from '@/lib/data/item-images';
import { addableCountItems, findCountItemByName } from '@/lib/data/stocks';
import type { CountItemRow } from '@/lib/db/types';
import { COUNT_ITEM_NAME_MAX, countItemNameSchema } from '@/lib/schemas/count-items';

export function AddCountItemDialog({
  open,
  onOpenChange,
  countItems,
  shownIds,
  onPick,
  onCreate,
  imagePaths,
  images,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 名前の一覧（最初から出す物も含む。同じ名前を探すのに使う） */
  countItems: readonly CountItemRow[];
  /** もう出ている物の id */
  shownIds: ReadonlySet<string>;
  /** 一覧から選んだ（同じ名前の物を書いたときも） */
  onPick: (countItemId: string) => void;
  /** 新しい名前を足す（RPC。写真があれば続けて送る）。名前を足せなければ文言を返す（足せたら null。ダイアログは閉じる） */
  onCreate: (name: string, photo: File | null) => Promise<string | null>;
  /** 備品（数えるだけ）の id → 画像の path */
  imagePaths: ItemImagePaths;
  images: ItemImageUrls;
}) {
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterId = useId();
  const nameId = useId();
  const errorId = useId();
  const candidates = addableCountItems(countItems, shownIds, filter);

  const close = () => {
    setFilter('');
    setName('');
    setPhoto(null);
    setError(null);
    onOpenChange(false);
  };
  const pick = (id: string) => {
    onPick(id);
    close();
  };
  const create = async () => {
    const parsed = countItemNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '名前を確かめてください');
      return;
    }
    // 同じ名前の物があれば、新しく足さずにその物の行を出す（DB の add_count_item と同じ比べ方）
    const same = findCountItemByName(countItems, parsed.data);
    if (same) {
      pick(same.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await onCreate(parsed.data, photo);
      if (message) setError(message);
      else close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent data-testid="add-count-item-dialog" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>その他を足す</DialogTitle>
          <DialogDescription>一覧から選ぶか、新しく登録してください。足した物は数 0 で行が出ます（「保存」で保存します）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={filterId}>名前で絞る</Label>
          <Input id={filterId} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="例：白椅子" />
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="add-count-item-empty">
              {filter.trim() === '' ? '選べる物はありません。' : '当てはまる物はありません。'}
            </p>
          ) : (
            <ul className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-0.5 sm:grid-cols-4" aria-label="選べる物">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-col items-center gap-1 rounded-md border p-2 text-center text-xs hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    data-testid="add-count-item-option"
                    onClick={() => pick(c.id)}
                  >
                    <ItemImage name={c.name} path={imagePaths.get(c.id)} images={images} size="lg" decorative />
                    <span className="w-full break-words">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <form
          className="space-y-2 border-t pt-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h3 className="text-sm font-semibold">新しく登録</h3>
          <Label htmlFor={nameId}>新しく登録する名前</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={COUNT_ITEM_NAME_MAX + 20}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <p className="text-xs text-muted-foreground">1〜{COUNT_ITEM_NAME_MAX} 字。足した名前は、ほかの場所と翌年も選べます。</p>
          <ItemPhotoField file={photo} onChange={setPhoto} disabled={busy} />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="outline" className="h-11 w-full" disabled={busy}>
            {busy ? '登録しています…' : '新しく登録'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
