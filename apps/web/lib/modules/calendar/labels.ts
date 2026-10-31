// 締切と予定の列挙の表示名（02 の列挙型 event_kind・event_audience の表示名。T18・D-54）。/calendar・ダッシュボードの欄・履歴が読む。
// lib/labels.ts に置かないのは、lib/labels.ts がどの画面の最初に読む JS にも丸ごと入るため（/stock・/request・/my を含む。
// notes/T18.md の「後半の実装で決めたこと」）。履歴の表の名前（AUDIT_TABLE_LABELS の events）だけは共有の一覧に1行足す。
// import は型だけ（lib/data/history.ts・components/portal から読む）。
import type { Enums } from '@gaapp/shared';

/** 種類（event_kind）：締切・予定 */
export const EVENT_KIND_LABELS: Readonly<Record<Enums<'event_kind'>, string>> = {
  deadline: '締切',
  event: '予定',
};

/** 対象（event_audience）：総務・団体・全員（お知らせの宛先〔総務内・全団体・指定の団体〕と取り違えない） */
export const EVENT_AUDIENCE_LABELS: Readonly<Record<Enums<'event_audience'>, string>> = {
  soumu: '総務',
  groups: '団体',
  all: '全員',
};
