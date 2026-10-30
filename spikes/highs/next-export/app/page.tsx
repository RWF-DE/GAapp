'use client';
import { useEffect, useState } from 'react';

export default function Page() {
  const [out, setOut] = useState('running…');
  useEffect(() => {
    const locate = new URLSearchParams(location.search).get('locate') ?? 'base';
    // Web Worker の URL は new URL(..., import.meta.url) で書く（バンドラが worker を別チャンクにする）
    const w = new Worker(new URL('./solver.worker.ts', import.meta.url));
    w.onmessage = (e) => { (window as any).__result = e.data; setOut(JSON.stringify(e.data)); };
    w.onerror = (e) => { (window as any).__result = { error: e.message }; setOut(`worker error ${e.message}`); };
    // basePath は Next.js が <Link> や next/image には付けるが、public/ のファイルを自分で fetch するときは付けてくれない。自分で足す
    w.postMessage({ basePath: process.env.NEXT_PUBLIC_BASE_PATH, locate });
    return () => w.terminate();
  }, []);
  return <pre id="out">{out}</pre>;
}
