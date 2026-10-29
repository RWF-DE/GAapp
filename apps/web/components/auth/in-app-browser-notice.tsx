'use client';

import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { isInAppBrowser } from '@/lib/auth/in-app-browser';

const noopSubscribe = () => () => {};

/**
 * アプリの中のブラウザで開いたと分かるときの案内と、URL のコピーのボタン（04「ログイン」。T09a）。
 * userAgent はブラウザでだけ読む（静的書き出しのプリレンダーでは何も出さない）。
 */
export function InAppBrowserNotice() {
  const inApp = useSyncExternalStore(noopSubscribe, () => isInAppBrowser(navigator.userAgent), () => false);
  const [copied, setCopied] = useState<'ok' | 'ng' | null>(null);
  if (!inApp) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied('ok');
    } catch {
      setCopied('ng');
    }
  };
  return (
    <div role="note" data-testid="in-app-browser-notice" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p>LINE などのアプリの中では Google でログインできません。Safari か Chrome で開いてください。</p>
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        この画面の URL をコピーする
      </Button>
      {copied === 'ok' ? <p role="status">コピーしました。Safari か Chrome に貼り付けて開いてください。</p> : null}
      {copied === 'ng' ? (
        <p role="status">
          コピーできませんでした。メニューの「ブラウザで開く」を使ってください。
        </p>
      ) : null}
    </div>
  );
}
