'use client';

// ダッシュボード（/）の欄のデータ（04「ダッシュボード」の読み込みと失敗、notes/T16.md「固めた約束」5。T16）。
// 欄（要対応・締切と予定・機能ごとのカード）ごとに、自分の要る種類の「プロバイダ × 種類」のうち、その欄が読み取りの結果を使う
// もの（provider.query.widgets）の query を useQueries に並べる（同じキーは TanStack が1回だけ読むので、欄が3つでもリクエストは
// 機能・種類ごとに1回）。欄に出すのは portalSectionOf（query の data があればそれ、なければ fromYear）を機能ごとにまとめたもの
// （mergePortalSections）。data のない query の読み込み中・失敗は機能ごとに返し、欄がその機能の分だけ Skeleton・失敗ともう一度を
// 出す（ほかの機能と fromYear の項目は出したまま）。並べない欄（机椅子の締切と予定。年度の行だけで決まる）には読み込み中・失敗を
// 出さない（T16 の決定 7）。data があって読み直しだけが失敗したときは data を出し続ける（QueryState と同じ考え）。
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  mergePortalSections,
  portalSectionOf,
  portalWidgetQuery,
  type ModulePortalSection,
  type PortalContext,
  type PortalKind,
  type PortalPart,
  type PortalProvider,
  type PortalQueryOptions,
  type PortalWidgetId,
} from '@/lib/modules/portal';
import { PORTAL_PROVIDERS } from '@/lib/modules/providers';
import type { ModuleId } from '@/lib/modules/registry';

/** ダッシュボードの欄（読み込みを分けるもの。型は lib/modules/portal.ts） */
export type { PortalWidgetId } from '@/lib/modules/portal';

/**
 * 欄ごとに使う立場の種類（要対応：総務・団体代表、締切と予定：全部、総務内のお知らせ：総務、お知らせ：閲覧のみ・団体代表〔T17〕、
 * カード：総務・閲覧のみ。04「ダッシュボード」の欄と立場の表）
 */
export const WIDGET_KINDS: Readonly<Record<PortalWidgetId, readonly PortalKind[]>> = {
  todos: ['soumu', 'rep'],
  dated: ['soumu', 'viewer', 'rep'],
  soumuNotices: ['soumu'],
  notices: ['viewer', 'rep'],
  cards: ['soumu', 'viewer'],
};

/** その人にその欄を出すか（立場の種類のどれかが欄の種類に入る） */
export function showsWidget(kinds: readonly PortalKind[], widget: PortalWidgetId): boolean {
  return kinds.some((k) => WIDGET_KINDS[widget].includes(k));
}

/** 欄で使うプロバイダ × 種類と、その欄に並べる query（読まない種類と、その欄が結果を使わない読み取りは null） */
export interface PortalEntry {
  provider: PortalProvider;
  ctx: PortalContext;
  query: PortalQueryOptions | null;
}

/**
 * その欄で使う、プロバイダ × 種類（provider.kinds と欄の種類の両方に入るもの。並びはプロバイダの順 → 種類の順）。
 * query はその欄が読み取りの結果を使うときだけ（portalWidgetQuery。使わない欄は fromYear だけを出す）。
 */
export function widgetEntries(
  ctxs: readonly PortalContext[],
  widget: PortalWidgetId,
  providers: readonly PortalProvider[] = PORTAL_PROVIDERS,
): PortalEntry[] {
  const kinds = WIDGET_KINDS[widget];
  return providers.flatMap((provider) =>
    ctxs
      .filter((ctx) => kinds.includes(ctx.kind) && provider.kinds.includes(ctx.kind))
      .map((ctx) => ({ provider, ctx, query: portalWidgetQuery(provider, ctx, widget) })),
  );
}

/** data のない query の失敗（機能ごと。もう一度で、失敗した query を読み直す） */
export interface ModuleFailure {
  error: unknown;
  retry: () => void;
}

/** 欄の中の1つの機能（まとめた PortalSection と、読み込み中・失敗） */
export interface ModuleWidgetState extends ModulePortalSection {
  /** data がまだない query がある（読み込み中） */
  loading: boolean;
  /** data のない query の失敗。なければ null */
  failure: ModuleFailure | null;
}

/**
 * 欄のデータ（機能ごと。機能の登録の順）。ctxs が空（年度の行の読み込み前）なら空。
 *
 * @example
 * const modules = usePortalWidget(ctxs, 'todos');
 * const todos = sortTodos(modules.flatMap((m) => m.todos));
 */
export function usePortalWidget(
  ctxs: readonly PortalContext[],
  widget: PortalWidgetId,
  providers: readonly PortalProvider[] = PORTAL_PROVIDERS,
): ModuleWidgetState[] {
  const entries = widgetEntries(ctxs, widget, providers);
  const results = useQueries({ queries: entries.flatMap((e) => (e.query ? [e.query] : [])) });

  const parts: PortalPart[] = [];
  const status = new Map<ModuleId, { loading: boolean; failed: { error: unknown; refetch: () => unknown }[] }>();
  let k = 0;
  for (const e of entries) {
    const r = e.query ? results[k++] : undefined;
    const data = r?.data;
    const moduleId = e.provider.moduleId;
    parts.push({ moduleId, kind: e.ctx.kind, section: portalSectionOf(e.provider, e.ctx, data) });
    const st = status.get(moduleId) ?? { loading: false, failed: [] };
    status.set(moduleId, st);
    if (r && data === undefined) {
      if (r.isError) st.failed.push({ error: r.error, refetch: r.refetch });
      else st.loading = true;
    }
  }
  return mergePortalSections(parts).map((m) => {
    const st = status.get(m.moduleId);
    const failed = st?.failed ?? [];
    return {
      ...m,
      loading: st?.loading ?? false,
      failure:
        failed.length > 0
          ? {
              error: failed[0]!.error,
              retry: () => {
                for (const f of failed) void f.refetch();
              },
            }
          : null,
    };
  });
}

/**
 * 欄の query を読み直す関数（エラーの境界の「もう一度」。その欄で使う query をキーで1つずつ読み直す）。
 */
export function useRefetchWidget(
  ctxs: readonly PortalContext[],
  widget: PortalWidgetId,
  providers: readonly PortalProvider[] = PORTAL_PROVIDERS,
): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const e of widgetEntries(ctxs, widget, providers)) {
      if (e.query) void queryClient.refetchQueries({ queryKey: e.query.queryKey, exact: true });
    }
  }, [queryClient, ctxs, widget, providers]);
}
