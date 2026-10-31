'use client';

// ダッシュボード（/）の欄ごとのエラーの境界（04「ダッシュボード」の読み込みと失敗、notes/T16.md「固めた約束」5。T16）。
// 欄の中身の描画で例外が起きたら、その欄だけを「この欄を表示できませんでした。」と「もう一度」（portal-widget-error）にする。
// ほかの欄は出したまま。「もう一度」は境界を戻し（中身を描き直す）、onRetry でその欄の query を読み直す。
// 読み込みの失敗（query の error）は欄の中で機能ごとに出す（ModuleError）ので、ここに来るのは描画の例外だけ。
import { AlertTriangle } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface WidgetBoundaryProps {
  children: ReactNode;
  /** 「もう一度」で、境界を戻すのと一緒に呼ぶ（その欄の query を読み直す） */
  onRetry?: () => void;
}

interface WidgetBoundaryState {
  failed: boolean;
}

export class WidgetBoundary extends Component<WidgetBoundaryProps, WidgetBoundaryState> {
  override state: WidgetBoundaryState = { failed: false };

  static getDerivedStateFromError(): WidgetBoundaryState {
    return { failed: true };
  }

  private readonly retry = () => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-testid="portal-widget-error"
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
      >
        <AlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
        <p className="min-w-0 flex-1 text-destructive">この欄を表示できませんでした。</p>
        <Button type="button" size="sm" variant="outline" onClick={this.retry}>
          もう一度
        </Button>
      </div>
    );
  }
}
