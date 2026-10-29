'use client';

// 検証の一覧（画面の設計 3.9 の「右：検証の一覧」。T13）。error → warning → info の順（validate の並びのまま）、
// 種類ごとの件数、コードで絞る。押すと issueTarget で行き先へ。ルールは、ルール画面を開ける立場（admin）にはリンク、
// 開けない立場（Q1 の staff）にはコードと内容の文を項目の下に開いて見せる。
import type { InputError, Issue } from '@gaapp/shared';
import { useMemo, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ValidationResult } from '@/lib/data/validation';
import type { IssueTarget } from '@/lib/allocation/issue-target';
import { ruleHref } from '@/lib/allocation/issue-target';
import { cn } from '@/lib/utils';

const SEVERITY_LABELS: Record<Issue['severity'], string> = { error: 'error', warning: 'warning', info: 'info' };

/** ルールのコードと内容の文（ルール画面を開けない立場向け） */
function RuleText({ code, text }: { code: string; text: string | undefined }) {
  return (
    <p className="mt-1 rounded bg-muted/60 px-2 py-1 text-xs" data-testid="rule-text">
      {text ?? `ルール ${code}（内容を読めません）`}
    </p>
  );
}

export function ProblemsList({ problems, ruleText }: { problems: readonly InputError[]; ruleText: (code: string) => string | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section data-testid="input-problems" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <h3 className="font-semibold text-destructive">入力に誤りがあります（自動振り分けと確定はできません）</h3>
      <ul className="space-y-1">
        {problems.map((p, k) => (
          <li key={k}>
            {p.message}
            {p.ruleCode ? (
              <span className="ml-2">
                <AppLink
                  href={ruleHref(p.ruleCode)}
                  className="underline underline-offset-2"
                  fallback={
                    <button type="button" className="underline underline-offset-2" onClick={() => setOpen(open === `${k}` ? null : `${k}`)}>
                      ルール {p.ruleCode}
                    </button>
                  }
                >
                  ルール {p.ruleCode} を開く
                </AppLink>
              </span>
            ) : null}
            {p.ruleCode && open === `${k}` ? <RuleText code={p.ruleCode} text={ruleText(p.ruleCode)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function IssuesPanel({
  validation,
  targetOf,
  onSelect,
  ruleText,
  issueActions,
}: {
  validation: ValidationResult;
  targetOf: (issue: Issue) => IssueTarget;
  onSelect: (issue: Issue, target: IssueTarget) => void;
  ruleText: (code: string) => string | undefined;
  /** 項目の下に出す操作（E002 の「運び元を変える」「行を削除」。段 2） */
  issueActions?: (issue: Issue) => React.ReactNode;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [openRule, setOpenRule] = useState<number | null>(null);
  const issues = validation.issues;
  const codes = useMemo(() => {
    const m = new Map<string, { n: number; severity: Issue['severity'] }>();
    for (const i of issues) m.set(i.code, { n: (m.get(i.code)?.n ?? 0) + 1, severity: i.severity });
    return [...m.entries()];
  }, [issues]);
  const count = (s: Issue['severity']) => issues.filter((i) => i.severity === s).length;
  const shown = code ? issues.filter((i) => i.code === code) : issues;

  return (
    <section aria-labelledby="issues-title" data-testid="issues-panel" className="space-y-3">
      <h2 id="issues-title" className="text-base font-bold">
        検証
      </h2>
      {validation.status === 'unavailable' ? (
        <p className="text-sm text-destructive" data-testid="validation-unavailable">
          検証できません：入力に誤りがあります
        </p>
      ) : null}
      {validation.problems.length > 0 ? <ProblemsList problems={validation.problems} ruleText={ruleText} /> : null}
      {validation.status === 'ok' ? (
        <>
          <p className="flex flex-wrap gap-2 text-sm" data-testid="issue-counts">
            <span data-severity="error" className={cn(count('error') > 0 && 'font-bold text-destructive')}>
              error {count('error')} 件
            </span>
            <span data-severity="warning">warning {count('warning')} 件</span>
            <span data-severity="info">info {count('info')} 件</span>
          </p>
          {codes.length > 0 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="コードで絞る">
              <Button size="sm" variant={code === null ? 'default' : 'outline'} onClick={() => setCode(null)}>
                すべて
              </Button>
              {codes.map(([c, { n, severity }]) => (
                <Button
                  key={c}
                  size="sm"
                  variant={code === c ? 'default' : 'outline'}
                  aria-pressed={code === c}
                  className={cn(severity === 'error' && code !== c && 'border-destructive/60 text-destructive')}
                  onClick={() => setCode(code === c ? null : c)}
                >
                  {c} {n}
                </Button>
              ))}
            </div>
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">検証の結果はありません。</p>
          ) : (
            <ul className="max-h-[70vh] space-y-1 overflow-y-auto pr-1 text-sm">
              {shown.map((issue, k) => {
                const t = targetOf(issue);
                const clickable = t.destination.kind !== 'none';
                return (
                  <li key={k} data-issue-code={issue.code} className="rounded border px-2 py-1">
                    <div className="flex items-start gap-2">
                      <Badge
                        variant={issue.severity === 'error' ? 'destructive' : 'outline'}
                        className={cn(issue.severity === 'warning' && 'border-amber-400')}
                        title={SEVERITY_LABELS[issue.severity]}
                      >
                        {issue.code}
                      </Badge>
                      {clickable ? (
                        <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onSelect(issue, t)}>
                          {issue.message}
                        </button>
                      ) : (
                        <span>{issue.message}</span>
                      )}
                    </div>
                    {issueActions ? issueActions(issue) : null}
                    {t.rule ? (
                      <div className="ml-12 text-xs">
                        {t.rule.href ? (
                          <AppLink href={t.rule.href} className="underline underline-offset-2">
                            ルール {t.rule.code} を開く
                          </AppLink>
                        ) : (
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            aria-expanded={openRule === k}
                            onClick={() => setOpenRule(openRule === k ? null : k)}
                          >
                            ルール {t.rule.code} の内容
                          </button>
                        )}
                        {!t.rule.href && openRule === k ? <RuleText code={t.rule.code} text={ruleText(t.rule.code)} /> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
