'use client';

// 書き出しのタブ（画面の設計 3.2「書き出し」・6。T09）。年度データ（JSON）と振り分け表（Excel）。年度末のバックアップに使う。
// どちらもボタンを押したときに年度の全データを読み直して（版を先に読むスナップショット）作る。
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { downloadAllocationXlsx, ExportBlockedError, isBeforeConfirm } from '@/lib/data/export';
import { loadSnapshot } from '@/lib/data/snapshot';
import { brokenRulesNotice, downloadYearJson } from '@/lib/data/year-export';
import { TabHeading, useSettings, useWriteErrorHandler } from './shared';

export function ExportTab() {
  const { year } = useSettings();
  const onError = useWriteErrorHandler();
  const [busy, setBusy] = useState<'json' | 'xlsx' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmXlsx, setConfirmXlsx] = useState(false);

  const exportJson = async () => {
    setBusy('json');
    setNotice(null);
    try {
      const r = await downloadYearJson(year.id);
      const broken = brokenRulesNotice(r.brokenRuleCodes);
      toast.success(`${r.fileName} を保存しました`);
      setNotice(broken);
      if (broken) toast.warning(broken, { duration: 15000 });
    } catch (e) {
      await onError(e, { unknownMessage: null });
    } finally {
      setBusy(null);
    }
  };

  const exportXlsx = async () => {
    setBusy('xlsx');
    try {
      const snapshot = await loadSnapshot(year.id, 'full');
      const { fileName } = await downloadAllocationXlsx(snapshot);
      toast.success(`${fileName} を保存しました`);
    } catch (e) {
      if (e instanceof ExportBlockedError) toast.error(e.message);
      else await onError(e, { unknownMessage: null });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <TabHeading
        title="データの書き出し"
        description="年度末のバックアップに使います。書き出したファイルは総務の共有ドライブに保存してください（手順は README の運用の節）。"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>年度データ（JSON）</CardTitle>
            <CardDescription>
              {year.label} の全データ（場所・品目・団体・在庫・申請・ルール〔無効なものとメモを含む〕・了承・距離・振り分け）。メールアドレスは含めません。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button onClick={() => void exportJson()} disabled={busy !== null} data-testid="export-json">
              {busy === 'json' ? '書き出し中…' : '年度データを書き出す'}
            </Button>
            {notice ? (
              <p role="status" className="text-sm text-amber-800" data-testid="export-broken-rules">
                {notice}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>振り分け表（Excel）</CardTitle>
            <CardDescription>振り分け画面の「Excel出力」と同じファイルです。{isBeforeConfirm(year.status) ? '確定前は「確定前」のファイル名になります。' : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => (isBeforeConfirm(year.status) ? setConfirmXlsx(true) : void exportXlsx())}
              disabled={busy !== null}
              data-testid="export-xlsx"
            >
              {busy === 'xlsx' ? '書き出し中…' : '振り分け表を書き出す'}
            </Button>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmXlsx}
        onOpenChange={setConfirmXlsx}
        title="確定前の振り分けです"
        description="まだ確定していない振り分けを書き出します。ファイル名に「確定前」が付きます。部門員と共有する確定版と取り違えないでください。"
        confirmLabel="書き出す"
        onConfirm={() => exportXlsx()}
      />
    </div>
  );
}
