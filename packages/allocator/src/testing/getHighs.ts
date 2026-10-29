// テスト用：highs をファイルごとに1回だけ読み込んで使い回す（Node では既定の場所から wasm を読む）
import loadHighs from 'highs';
import type { LpSolver } from '../solve';

let solver: Promise<LpSolver> | null = null;

export function getHighs(): Promise<LpSolver> {
  // loadHighs に渡すオプションのオブジェクトは呼ぶたびに新しく作る（T00）。ここでは渡さない
  solver ??= loadHighs();
  return solver;
}
