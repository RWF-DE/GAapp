export const PACKAGE_NAME = '@gaapp/shared';

// supabase gen types の出力（pnpm gen:types で作り直す。手で直さない）
export { Constants } from './database.types';
export type { Database, Enums, Json, Tables, TablesInsert, TablesUpdate } from './database.types';

export * from './constants';
export * from './order';
export * from './model';
export * from './rules';
export * from './demand';
export * from './groups';
