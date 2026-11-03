"use client"

// 共有のダイアログ（alert-dialog・dialog・sheet）の覆い（Overlay）と中身（Content）を、1つの portal に覆い → 中身の順で置く
// （04「共通レイアウト」のダイアログの重なり、D-52 の T19 の直し・3。2026-11-03。T09a の部品への足し）。
// Radix の Portal は子ごとに別々の portal を body に付ける。覆いの閉じる動き（150 ms）は中身（200 ms。シートは 300 ms）より先に
// 終わって外れるので、その間に同じダイアログを開き直すと、付け直した覆いが body の最後（自分の中身の後ろ）に付き、同じ z-50 の
// 中身の上に来て押下を受けていた。1つの portal の中の兄弟にすると、React は付け直す覆いを、残っている中身の前に入れる（時間によらない）。
// 初めて開くとき・閉じきってから開くときは、今までどおり body の最後に覆い → 中身の順で付く（ダイアログの上に開いたダイアログは上に来る）。
// portal は閉じている間も置いておく（中身がなければ body には何も付かない）。プリレンダー（静的書き出し）では何も出さず、ブラウザで body に付ける。
//
// ダイアログの上にダイアログを開いたときは、いちばん上の覆いだけが後ろを暗くする（04 の同じ項の2つ目。D-52 の FU3 の直し。2026-11-03）。
// 覆いはどれも黒の半分なので、重ねるとページは2枚分（4分の1の明るさ）、1枚だけ掛かる下のシートは半分の明るさになり、
// シートが暗くなっていないように見えていた（提出状況のシートの上の差し戻し・承認のダイアログ）。body の直下の覆いのうち、より後ろ（上）に
// 開いた（data-state="open"）覆いがあるものに印 data-covered を付け、覆いのクラス（data-covered:bg-transparent と、背景色の 150 ms の
// 移り変わり）で透明にする。上の覆いが閉じ始めたら（data-state="closed"）印を外す。1つだけ開いたときは付かない（見た目は今までどおり）。
// 見張り（MutationObserver：body の子の出入りと、覆いの data-state）は、DialogLayer が1つでも置かれている間だけ動かす。
import * as React from "react"
import { createPortal } from "react-dom"

const noopSubscribe = () => () => {}

/** 印を付ける覆い（components/ui の3つのダイアログの Overlay の data-slot） */
const OVERLAY_SLOTS = new Set(["alert-dialog-overlay", "dialog-overlay", "sheet-overlay"])

function isOverlay(el: Element): boolean {
  return OVERLAY_SLOTS.has(el.getAttribute("data-slot") ?? "")
}

/** body の直下の覆いを後ろ（上）から見て、より上に開いた覆いがあるものに data-covered を付け、ないものから外す */
function markCoveredOverlays(body: HTMLElement): void {
  let openAbove = false
  for (let i = body.children.length - 1; i >= 0; i--) {
    const el = body.children[i]!
    if (!isOverlay(el)) continue
    if (el.hasAttribute("data-covered") !== openAbove) el.toggleAttribute("data-covered", openAbove)
    if (el.getAttribute("data-state") === "open") openAbove = true
  }
}

/** body の直下の覆いの data-state を見張り、印を付け直す（同じ要素をもう一度 observe しても、見張りは増えない） */
function syncOverlays(body: HTMLElement, watch: MutationObserver): void {
  for (const el of body.children) {
    if (isOverlay(el)) watch.observe(el, { attributes: true, attributeFilter: ["data-state"] })
  }
  markCoveredOverlays(body)
}

let watchers = 0
let observer: MutationObserver | null = null

/** 覆いの見張りを1つ分借りる（最初の1つで始め、返り値で返す。最後の1つを返したら止める） */
function retainOverlayWatch(): () => void {
  watchers += 1
  if (!observer) {
    const body = document.body
    const watch = new MutationObserver(() => syncOverlays(body, watch))
    watch.observe(body, { childList: true })
    syncOverlays(body, watch)
    observer = watch
  }
  return () => {
    watchers -= 1
    if (watchers === 0 && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

/**
 * 覆いと中身を、この順で body に portal する（Radix の Overlay・Content をそのまま子に置く）。上に開いた覆いがある間は、
 * この覆いに透明にする印（data-covered）が付く。
 *
 * @example
 * <DialogLayer>
 *   <DialogOverlay />
 *   <DialogPrimitive.Content>…</DialogPrimitive.Content>
 * </DialogLayer>
 */
function DialogLayer({ children }: { children: React.ReactNode }) {
  const container = React.useSyncExternalStore(
    noopSubscribe,
    () => document.body,
    () => null
  )
  React.useEffect(() => retainOverlayWatch(), [])
  return container ? createPortal(children, container) : null
}

export { DialogLayer }
