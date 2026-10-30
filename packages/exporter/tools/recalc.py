#!/usr/bin/env python3
"""xlsx を LibreOffice (headless, UNO) で開いて全セルを再計算し、結果を JSON で書く。

使い方: recalc.py 入力.xlsx 出力.json
LibreOffice は Excel 形式を開いても再計算しないことがある（kickoff K-18）ので、
calculateAll() を明示的に呼んでから値を読む。各セルは {"v": 値, "f": 数式, "e": エラーコード} 。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.table.CellContentType import EMPTY, FORMULA, TEXT, VALUE


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def connect(pipe, proc):
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    url = f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError("soffice が終了しました")
        try:
            return resolver.resolve(url)
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("soffice に接続できません")


def main(src, dst):
    profile = tempfile.mkdtemp(prefix="lo-profile-")
    pipe = "gaapp" + uuid.uuid4().hex[:12]
    proc = subprocess.Popen(
        [
            os.environ.get("SOFFICE", "soffice"),
            "--headless", "--invisible", "--norestore", "--nologo", "--nodefault",
            f"-env:UserInstallation=file://{profile}",
            f"--accept=pipe,name={pipe};urp;",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ctx = connect(pipe, proc)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(src)), "_blank", 0, (prop("Hidden", True),))
        doc.calculateAll()
        out = {}
        for sheet in doc.Sheets:
            cur = sheet.createCursor()
            cur.gotoEndOfUsedArea(False)
            rows, cols = cur.RangeAddress.EndRow + 1, cur.RangeAddress.EndColumn + 1
            grid = []
            for r in range(rows):
                line = []
                for c in range(cols):
                    cell = sheet.getCellByPosition(c, r)
                    t = cell.Type
                    if t == EMPTY:
                        line.append(None)
                        continue
                    item = {}
                    if t == FORMULA:
                        item["f"] = cell.Formula
                        item["e"] = cell.getError()
                        # FormulaResultType2: 1=値 2=文字列
                        item["v"] = cell.String if cell.FormulaResultType2 == 2 else cell.Value
                        if item["e"]:
                            item["v"] = cell.String
                    elif t == TEXT:
                        item["v"] = cell.String
                    else:
                        item["v"] = cell.Value
                    line.append(item)
                grid.append(line)
            out[sheet.Name] = grid
        doc.close(True)
        with open(dst, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        try:
            desktop.terminate()
        except Exception:
            pass
    finally:
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: recalc.py in.xlsx out.json")
    main(sys.argv[1], sys.argv[2])
