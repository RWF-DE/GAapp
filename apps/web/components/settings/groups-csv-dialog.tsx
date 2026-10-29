'use client';

// 団体の CSV の取り込み（画面の設計 3.2「団体」。T09）。見出し `団体名,表示名,区分,飲食,使用場所,別名,並び順`。
// ファイルを選ぶ → 読み取り（UTF-8、だめなら Shift_JIS）→ プレビュー（追加・変更・変わらない・エラーの件数と行）→ 1回の upsert で保存
// （全部か何もしないか。削除はしない）。ファイルの中身は画面の状態にだけ持ち、閉じたら消す（保存もログ出力もしない）。
import { useState } from 'react';
import { toast } from 'sonner';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readCsvFile, CsvEncodingError } from '@/lib/csv-file';
import { planGroupImport, saveGroupImport, type GroupImportPlan } from '@/lib/data/settings';
import type { GroupRow, RoomRow } from '@/lib/db/types';
import { CATEGORY_LABELS } from '@/lib/labels';
import { GROUP_CSV_HEADERS, parseGroupsCsv, type GroupCsvError } from '@/lib/schemas/settings';
import { settingsKeys, useSettings, useWriteErrorHandler } from './shared';

const ACTION_LABELS = { add: '追加', change: '変更', same: '変わらない' } as const;

export function GroupsCsvDialog({
  groups,
  rooms,
  onClose,
  onSaved,
}: {
  groups: readonly GroupRow[];
  rooms: readonly RoomRow[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { year } = useSettings();
  const onError = useWriteErrorHandler();
  const [fileError, setFileError] = useState<string | null>(null);
  const [errors, setErrors] = useState<GroupCsvError[]>([]);
  const [plan, setPlan] = useState<GroupImportPlan | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(plan !== null);
  const roomName = new Map(rooms.map((r) => [r.id, r.name] as const));

  const read = async (file: File | undefined) => {
    setFileError(null);
    setErrors([]);
    setPlan(null);
    if (!file) return;
    setReading(true);
    try {
      const { text } = await readCsvFile(file);
      const parsed = parseGroupsCsv(text, rooms);
      setErrors(parsed.errors);
      setPlan(parsed.rows.length > 0 ? planGroupImport(parsed.rows, groups) : null);
    } catch (e) {
      setFileError(e instanceof CsvEncodingError ? e.message : 'ファイルを読めませんでした');
    } finally {
      setReading(false);
    }
  };

  const toSave = plan ? plan.counts.add + plan.counts.change : 0;
  const blocked = !plan || errors.length > 0 || plan.nameErrors.length > 0 || toSave === 0;

  const save = async () => {
    if (!plan || blocked) return;
    setSaving(true);
    try {
      const n = await saveGroupImport(year.id, plan);
      toast.success(`団体を ${n} 件取り込みました（追加 ${plan.counts.add}・変更 ${plan.counts.change}）`);
      setPlan(null);
      await onSaved();
    } catch (e) {
      await onError(e, { dataKeys: [settingsKeys.groups(year.id)] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>団体を CSV で取り込む</DialogTitle>
          <DialogDescription>
            見出しは「{GROUP_CSV_HEADERS.join(',')}」。区分は「模擬店・部門・企業・休憩所」、飲食は「はい・いいえ」、使用場所は場所の名前か別名（空は校内に分散）、別名は「|」区切り、並び順は整数（空なら行の順×10）。同じ団体名の団体は上書きし、CSV にない団体は消しません。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="groups-csv-file">CSV ファイル（UTF-8 か Shift_JIS）</Label>
            <Input id="groups-csv-file" type="file" accept=".csv,text/csv" disabled={reading || saving} onChange={(e) => void read(e.target.files?.[0])} />
            {reading ? <p className="text-sm text-muted-foreground">読み取り中…</p> : null}
            {fileError ? (
              <p role="alert" className="text-sm text-destructive">
                {fileError}
              </p>
            ) : null}
          </div>

          {plan || errors.length > 0 ? (
            <div className="space-y-3" data-testid="groups-csv-preview">
              <p className="text-sm" data-testid="groups-csv-counts">
                追加 {plan?.counts.add ?? 0} 件・変更 {plan?.counts.change ?? 0} 件・変わらない {plan?.counts.same ?? 0} 件・エラー {errors.length} 件
              </p>
              {errors.length > 0 ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="groups-csv-errors">
                  <p className="font-medium text-destructive">取り込めない行があります。CSV を直してから選び直してください（何も保存しません）。</p>
                  <ul className="mt-2 list-inside list-disc">
                    {errors.map((e) => (
                      <li key={`${e.line}-${e.message}`}>{e.line > 0 ? `${e.line} 行目：${e.message}` : e.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan && plan.nameErrors.length > 0 ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="groups-csv-name-errors">
                  <p className="font-medium text-destructive">取り込んだ後の団体名に、Excel の集計で区別できない名前があります。</p>
                  <ul className="mt-2 list-inside list-disc">
                    {plan.nameErrors.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan ? (
                <div className="max-h-[40vh] overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b text-left">
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">扱い</th>
                        <th className="px-2 py-1">団体名</th>
                        <th className="px-2 py-1">区分</th>
                        <th className="px-2 py-1">使用場所</th>
                        <th className="px-2 py-1">変わる項目</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.lines.map((l) => (
                        <tr key={l.row.line} className="border-b last:border-0" data-action={l.action}>
                          <td className="px-2 py-1 tabular-nums">{l.row.line}</td>
                          <td className="px-2 py-1">{ACTION_LABELS[l.action]}</td>
                          <td className="px-2 py-1">{l.row.name}</td>
                          <td className="px-2 py-1">{CATEGORY_LABELS[l.row.category]}</td>
                          <td className="px-2 py-1">{l.row.location_room_id ? (roomName.get(l.row.location_room_id) ?? '') : '校内に分散'}</td>
                          <td className="px-2 py-1">{l.changes.join('・')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            やめる
          </Button>
          <Button onClick={() => void save()} disabled={saving || blocked} data-testid="groups-csv-save">
            {saving ? '取り込み中…' : `${toSave} 件を取り込む`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
