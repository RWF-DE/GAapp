// 決定的な UUIDv5（RFC 4122。設計 3.3）。fixtures の場所・団体・ルールの id を名前から決める
import { createHash } from 'node:crypto';

/** fixtures の名前空間（設計 3.3 で決めた値） */
export const FIXTURE_NAMESPACE = '90d00e37-57c2-4d9a-8daa-d9d2ba50c836';
/** RFC 4122 の DNS 名前空間（テスト用） */
export const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function uuidv5(name: string, namespace: string = FIXTURE_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error(`名前空間が UUID ではありません: ${namespace}`);
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** fixtures の id（設計 3.3 の名前の付け方） */
export const fixtureIds = {
  item: (code: string) => uuidv5(`item:${code}`),
  room: (name: string) => uuidv5(`room:${name}`),
  group: (label: string, name: string) => uuidv5(`group:${label}:${name}`),
  rule: (label: string, code: string) => uuidv5(`rule:${label}:${code}`),
  row: (n: number) => uuidv5(`row:${n}`),
};
