// 自動振り分けの ok: false の表示（画面の設計 3.9 の手順5、ロジック設計 14 章。T13）。純粋関数。
// reason ごとに見出しを変える：invalid_input「入力に誤りがあります」、precheck「振り分けの前に直すものがあります」、
// infeasible「解けません」、solver_error「計算できませんでした」。
import type { AllocateResult, Cause, Issue } from '@gaapp/shared';
import type { ViewModel } from './view-model';

type Failure = Extract<AllocateResult, { ok: false }>;

export const FAILURE_TITLES: Record<Failure['reason'], string> = {
  invalid_input: '入力に誤りがあります',
  precheck: '振り分けの前に直すものがあります',
  infeasible: '解けません',
  solver_error: '計算できませんでした',
};

export const STOCK_SHORT_CAUSE = '代替を含めても在庫が足りません';
export const INFEASIBLE_FOOTER = 'ルールを変えるか、申請や固定行を直すかを決めてください';

export interface FailureLine {
  text: string;
  /** ルールのコード（ルール画面へのリンク。開けない立場には文字だけ） */
  ruleCode?: string;
  /** precheck の issue（行・ルールへ移動する） */
  issue?: Issue;
  /** 下に字下げして出す説明（cause の details） */
  details?: string[];
}

export interface FailureSection {
  /** 小見出し（不足・原因など）。なければ出さない */
  heading?: string;
  lines: FailureLine[];
}

export interface FailureView {
  reason: Failure['reason'];
  title: string;
  /** 見出しの下の文（solver_error の message など） */
  message?: string;
  sections: FailureSection[];
  footer?: string;
}

const join = (xs: readonly string[]) => xs.join('・');

function detailText(d: Cause['details'][number], vm: ViewModel, isStockShort: boolean): string {
  const items = (d.itemIds ?? []).map((id) => vm.itemById.get(id)?.name ?? '（不明な品目）');
  const nums = `需要 ${d.demand ?? '?'}`;
  if (isStockShort) return `${join(items)}：${nums}、在庫 ${d.supply ?? '?'}`;
  const group = d.groupId ? (vm.groupById.get(d.groupId)?.name ?? '（不明な団体）') : '';
  const target = `${group}の${join(items)}`.replace(/^の/, '');
  const rooms = (d.roomIds ?? []).map((id) => vm.roomById.get(id)?.name ?? '（不明な場所）');
  const supply = rooms.length > 0 ? `${join(rooms)} の在庫合計 ${d.supply ?? '?'}` : `在庫 ${d.supply ?? '?'}`;
  return `${target}：${nums}、${supply}`;
}

/** ok: false の結果を表示の形にする */
export function failureView(result: Failure, vm: ViewModel): FailureView {
  const title = FAILURE_TITLES[result.reason];
  switch (result.reason) {
    case 'invalid_input':
      return {
        reason: result.reason,
        title,
        sections: [
          {
            lines: result.inputErrors.map((e) => ({
              text: e.ruleCode ? `ルール ${e.ruleCode}：${e.message}` : e.message,
              ...(e.ruleCode ? { ruleCode: e.ruleCode } : {}),
            })),
          },
        ],
      };
    case 'precheck':
      return {
        reason: result.reason,
        title,
        sections: [
          {
            lines: result.issues.map((i) => ({ text: `${i.code} ${i.message}`, issue: i, ...(i.refs.ruleCode ? { ruleCode: i.refs.ruleCode } : {}) })),
          },
        ],
      };
    case 'infeasible': {
      const name = (id: string) => vm.itemById.get(id)?.name ?? '（不明な品目）';
      const whole = result.shortages
        .filter((s) => s.groupId === null)
        .map((s) => ({ text: `${name(s.requestedItemId)}が ${s.demand - s.supply} 台足りません（需要 ${s.demand}、使える在庫 ${s.supply}）` }));
      const perGroup = result.shortages
        .filter((s) => s.groupId !== null)
        .map((s) => ({
          text: `${vm.groupById.get(s.groupId!)?.name ?? '（不明な団体）'}の${name(s.requestedItemId)}：需要 ${s.demand}、使える在庫 ${s.supply}`,
        }));
      const causes: FailureLine[] = result.causes.map((c) => {
        const stockShort = c.ruleCode === null && c.message === STOCK_SHORT_CAUSE;
        const details = c.details.map((d) => detailText(d, vm, stockShort));
        if (c.ruleCode) return { text: `原因のルール ${c.ruleCode}：${c.message}`, ruleCode: c.ruleCode, details };
        return { text: c.message, details };
      });
      const sections: FailureSection[] = [];
      if (whole.length + perGroup.length > 0) sections.push({ heading: '不足', lines: [...whole, ...perGroup] });
      if (causes.length > 0) sections.push({ heading: '原因', lines: causes });
      return { reason: result.reason, title, sections, footer: INFEASIBLE_FOOTER };
    }
    case 'solver_error':
      return { reason: result.reason, title, message: result.message, sections: [] };
  }
}
