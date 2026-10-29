// highs.wasm を public/ に置く（静的ファイルとして公開し、locateFile で URL を渡す）
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../browser/public/', import.meta.url), { recursive: true });
copyFileSync(new URL('../node_modules/highs/build/highs.wasm', import.meta.url), new URL('../browser/public/highs.wasm', import.meta.url));
console.log('copied highs.wasm -> browser/public/highs.wasm');
