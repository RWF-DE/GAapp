// アプリの中のブラウザ（LINE・Instagram・Facebook など）を userAgent で見分ける（画面の設計 1.3、04「ログイン」。T09a）。
// Google は埋め込みのブラウザでの OAuth を disallowed_useragent で拒否する（部屋の QR を LINE のカメラで読んだときなど）。
// 見分けは目安なので、ログインの画面は案内を出すだけで Google のボタンは隠さない。

const IN_APP_PATTERNS: readonly RegExp[] = [
  /\bLine\//i, // LINE
  /Instagram/i,
  /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b/i, // Facebook・Messenger
  /\bMicroMessenger\//i, // WeChat
  /\bKAKAOTALK\b/i,
  /\bTwitter(?:Android)?\b/i,
  /\bTikTok\b|\bBytedanceWebview\b|\bmusical_ly\b/i,
  /; wv\)/, // Android の WebView
];

export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return IN_APP_PATTERNS.some((p) => p.test(userAgent));
}
