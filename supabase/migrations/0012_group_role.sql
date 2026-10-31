-- 0012_group_role.sql（T15。2026-10-31。D-48）：団体代表の立場（店長・副店長）の型と列を足すだけ
-- 列挙 group_role（manager 店長・deputy_manager 副店長。権限は同じで、表示名だけが違う。人数の上限はない）と、
-- group_members.role・invitations.group_role。
-- 足すだけなので、今の関数（0005 の invite・0009 の apply_invitations）と今の画面はこのファイルの後もそのまま動く
-- （group_members.role には既定の manager が入り、invitations.group_role は null のまま）。
-- 動きを変えるもの（兼任の禁止のトリガー、invitations_group_role_check、今の団体の招待の立場の埋め込み、それを前提にする invite と
-- 招待の受け入れ、3つの段）は、すべて 0013 の1つのトランザクションで入れる。トリガーと CHECK だけが先に確定すると、古い invite
-- （group_role を入れない）が 23514 で、古い受け入れ（兼任を飛ばさない）が role_overlap で失敗し、ログインまで止まるため。
-- 0013 が止まっても、このファイル（と 0011）だけでは何も壊れない（README の「5. 本番 DB への適用」）。

-- ロックは、招待の受け入れ（招待の行 → group_members）と同じ順に、先にまとめて取る（逆の順だと、同時のログインとデッドロック
-- し得る）。待つのは 5 秒まで（lock_timeout。このファイルのトランザクションの間だけ）：超えたら何も残さずに止まり、流し直せば
-- よい（長く待つと、その間のアプリの読み書きがこのファイルの後ろに並んで止まる）。LOCK TABLE は DO の中で取る（CLI はファイルを
-- 明示の BEGIN なしに1つのトランザクションで流すので、トップレベルの LOCK TABLE は 25P01 になる。CLI 2.122.0 で確かめた）
do $$
begin
  perform set_config('lock_timeout', '5s', true);
  lock table public.invitations, public.group_members in access exclusive mode;
end $$;

create type public.group_role as enum ('manager', 'deputy_manager');

-- 団体の招待の立場。団体の招待のときだけ持つ（ロールの招待は null）。0013 が今の団体の招待を店長にしてから、
-- CHECK（group_id があるときだけ持つ）を足す。未使用の招待の一意の索引（invitations_pending_group_key：year_id, email, group_id）は
-- 変えない。同じ団体に立場違いの未使用の招待は2つ作れず、招待し直すと立場が変わる（0013 の invite）
alter table public.invitations add column group_role public.group_role;

-- 今の団体代表は店長になる。既定値つきの not null の追加は表を書き直さず、行の update でもないので監査のトリガーは動かない
alter table public.group_members add column role public.group_role not null default 'manager';
