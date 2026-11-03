"use client"

// 共有のダイアログ（alert-dialog・dialog・sheet）の覆い（Overlay）と中身（Content）を、1つの portal に覆い → 中身の順で置く
// （04「共通レイアウト」のダイアログの重なり、D-52 の T19 の直し・3。2026-11-03。T09a の部品への足し）。
// Radix の Portal は子ごとに別々の portal を body に付ける。覆いの閉じる動き（150 ms）は中身（200 ms。シートは 300 ms）より先に
// 終わって外れるので、その間に同じダイアログを開き直すと、付け直した覆いが body の最後（自分の中身の後ろ）に付き、同じ z-50 の
// 中身の上に来て押下を受けていた。1つの portal の中の兄弟にすると、React は付け直す覆いを、残っている中身の前に入れる（時間によらない）。
// 初めて開くとき・閉じきってから開くときは、今までどおり body の最後に覆い → 中身の順で付く（ダイアログの上に開いたダイアログは上に来る）。
// portal は閉じている間も置いておく（中身がなければ body には何も付かない）。プリレンダー（静的書き出し）では何も出さず、ブラウザで body に付ける。
import * as React from "react"
import { createPortal } from "react-dom"

const noopSubscribe = () => () => {}

/**
 * 覆いと中身を、この順で body に portal する（Radix の Overlay・Content をそのまま子に置く）。
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
  return container ? createPortal(children, container) : null
}

export { DialogLayer }
