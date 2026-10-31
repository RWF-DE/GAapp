// 列挙の日本語（02_data.md「列挙型」の表示名と同じ。画面の設計 1.5・2.5。T09a）。E2E（Node）からも lib/errors.ts 経由で読むので、`@/` の別名を使わず
// 相対の import とパッケージの import だけにする。
import type { AllocOrigin, ConsentStatus, GroupCategory, RoomKind, RuleKind } from '@gaapp/shared';

// ロール・団体代表の立場（店長・副店長）・年度の状態は T04 の membership.ts にある（ヘッダー・ホームと同じ言い方にするため、ここから出し直す）
export { GROUP_ROLE_LABELS, ROLE_LABELS, YEAR_STATUS_LABELS } from './auth/membership';
export type { AppRole, GroupRole, YearStatus } from './auth/membership';

/** 団体の区分（exporter の CATEGORY_LABELS と同じ。exporter は動的 import だけなのでここに持つ） */
export const CATEGORY_LABELS: Record<GroupCategory, string> = {
  stall: '模擬店',
  department: '部門',
  company: '企業',
  rest_area: '休憩所',
};

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  room: '部屋',
  gym: '体育館',
  outdoor: '屋外',
  other: 'その他',
};

/** キャスター机交換の了承の状況（3.10） */
export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = {
  not_asked: '未依頼',
  asked: '依頼済み',
  accepted: '了承',
  declined: '拒否',
};

export const RULE_KIND_LABELS: Record<RuleKind, string> = {
  substitute: '代替',
  source_restrict: '運び元の制限',
  fixed_request: '固定の申請',
  keep: '残す',
};

export const ORIGIN_LABELS: Record<AllocOrigin, string> = {
  auto: '自動',
  manual: '手動',
};

/** 監査ログの表（履歴の絞り込み。3.12） */
export const AUDIT_TABLE_LABELS: Readonly<Record<string, string>> = {
  requests: '申請',
  request_submissions: '提出',
  stocks: '在庫',
  allocations: '振り分け',
  substitution_consents: '了承',
  rules: 'ルール',
  years: '年度',
  year_roles: 'ロール',
  groups: '団体',
  group_members: '団体代表',
  room_years: '場所の状態',
  rooms: '場所',
  items: '品目',
  distance_overrides: '距離',
};

/** 監査ログの操作（audit_logs.action） */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  INSERT: '追加',
  UPDATE: '変更',
  DELETE: '削除',
};

/**
 * RPC のエラーの details の field・column の日本語名（2.5「入力の形が違います（{欄の日本語名}）」）。
 * 表にないものは名前を出さない（lib/errors.ts）。
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  label: '年度名',
  patch: '年度の項目',
  festival_start: '1日目',
  request_open_at: '受付開始',
  request_close_at: '締切',
  role: 'ロール',
  group_role: '店長・副店長',
  email: 'メールアドレス',
  note: '備考',
  reason: '理由',
  mode: '実行の種類',
  group_id: '団体',
  groupId: '団体',
  op: '変更の種類',
  changes: '振り分けの変更',
  rows: '行',
  submission: '提出',
  submittedAt: '提出日時',
  user_id: '利用者',
  year_id: '年度',
  room_id: '場所',
  item_id: '品目',
  code: 'コード',
  kind: '種類',
  params: '設定',
  name: '名前',
  category: '区分',
  location_room_id: '使用場所',
};

/** 表にない値は、そのまま出さず fallback にする（新しい列挙が増えても画面が壊れない） */
export function labelOf(table: Readonly<Record<string, string>>, key: string | null | undefined, fallback = ''): string {
  if (key === null || key === undefined) return fallback;
  return Object.hasOwn(table, key) ? table[key]! : fallback;
}
