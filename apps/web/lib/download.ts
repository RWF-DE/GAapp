// ファイルとして保存させる（画面の設計 1.5。T09a）。Blob を作り、a 要素の download で保存させる。
// サーバーを持たないので、Excel・JSON・CSV はすべてこの関数でブラウザから保存する。
// イベント（ボタンを押したとき）の中だけで呼ぶ（プリレンダーの間は document がない）。

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
} as const;

/** Uint8Array・文字列を fileName で保存させる */
export function downloadFile(data: Uint8Array | string, fileName: string, mime: string): void {
  // Uint8Array は ArrayBuffer の一部を指すことがあるので、その範囲だけを渡す
  const part: BlobPart = typeof data === 'string' ? data : data.slice().buffer;
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Safari はクリックの直後に消すと保存が始まらないことがあるので、少し待ってから消す
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
