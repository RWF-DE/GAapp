// ルールの内容の文（画面の設計 3.9：ルール画面を開けない立場〔Q1 の staff〕に、検証の項目の下で見せる。T13）。純粋関数。
// ルールは staff も RLS で読める。T12 のルール画面にも同じ役目の関数ができたら、2つ目の画面が要るときに共通に移す（D-32）。
import type { RuleDbRow } from '@/lib/db/types';
import { CATEGORY_LABELS } from '@/lib/labels';
import type { ViewModel } from './view-model';

const CATEGORY: Readonly<Record<string, string>> = CATEGORY_LABELS;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** ルールの1行の説明。params が読めなければ種別だけ */
export function describeRule(rule: Pick<RuleDbRow, 'code' | 'kind' | 'params' | 'enabled' | 'memo'>, vm: ViewModel): string {
  const itemName = (code: unknown) => (typeof code === 'string' ? (vm.items.find((i) => i.code === code)?.name ?? code) : '?');
  const groupName = (id: unknown) => (typeof id === 'string' ? (vm.groupById.get(id)?.name ?? '（消えた団体）') : '?');
  const roomName = (id: unknown) => (typeof id === 'string' ? (vm.roomById.get(id)?.name ?? '（消えた場所）') : '?');
  const p = isRecord(rule.params) ? rule.params : {};
  let body: string;
  switch (rule.kind) {
    case 'substitute': {
      const cats = strs(p.categories).map((c) => CATEGORY[c] ?? c).join('・');
      body = `代替：${itemName(p.from)} の代わりに ${itemName(p.to)}（${cats || '区分なし'}${p.needsConsent === true ? '・了承が要る' : ''}${p.indoorOnly === true ? '・屋内だけ' : ''}）`;
      break;
    }
    case 'source_restrict':
      body = `運び元の制限：${groupName(p.group)} の ${strs(p.items).map(itemName).join('・')} は ${strs(p.rooms).map(roomName).join('・')} からだけ`;
      break;
    case 'fixed_request':
      body = `固定の申請：${groupName(p.group)} が未提出なら ${itemName(p.item)} を ${typeof p.count === 'number' ? p.count : '?'} 台`;
      break;
    case 'keep': {
      const items = isRecord(p.items) ? Object.entries(p.items).map(([c, n]) => `${itemName(c)} ${String(n)}`).join('・') : '';
      body = `残す：${groupName(p.group)} は ${roomName(p.room)} の ${items} を使う`;
      break;
    }
    default:
      body = 'ルール';
  }
  return `${rule.code} ${body}${rule.enabled ? '' : '（無効）'}${rule.memo ? `。メモ：${rule.memo}` : ''}`;
}
