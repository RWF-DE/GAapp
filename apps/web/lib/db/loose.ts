// lib/db の関数が使う supabase-js の問い合わせの最小の形（表の名前を引数で受けるため、型つきのクライアントを
// ここだけ緩めて使う）。テストの偽のクライアント（lib/testing/fake-supabase.ts）もこの形を満たす。
export interface LooseResult<T> {
  data: T;
  error: unknown;
  status?: number;
}

export interface LooseFilter<T = Record<string, unknown>> extends PromiseLike<LooseResult<T[] | null>> {
  select(columns?: string): LooseFilter<T>;
  match(query: Record<string, unknown>): LooseFilter<T>;
  eq(column: string, value: unknown): LooseFilter<T>;
  maybeSingle(): PromiseLike<LooseResult<T | null>>;
}

export interface LooseTable {
  select(columns?: string): LooseFilter;
  update(values: unknown): LooseFilter;
  delete(): LooseFilter;
}

export interface LooseClient {
  from(table: string): LooseTable;
}
