-- 0001_init.sql（T02）：列挙型・表・index・ビュー・RLS の有効化・既定の権限の取り消し
-- 文字列と数の上限：団体代表・部員が書ける列も含め、自由記述は 2000 字、名前は 100 字、数は 10000 まで（DB の容量を守る）
create type public.year_status as enum ('preparing','requesting','allocating','confirmed','closed');
create type public.group_category as enum ('stall','department','company','rest_area');
create type public.room_kind as enum ('room','gym','outdoor','other');
create type public.app_role as enum ('admin','staff','viewer');
create type public.rule_kind as enum ('substitute','source_restrict','fixed_request','keep');
create type public.alloc_origin as enum ('auto','manual');
create type public.consent_status as enum ('not_asked','asked','accepted','declined');
create type public.festival_day as enum ('day_minus2','day_minus1','day1','day2');
create type public.delivery_kind as enum ('furniture','tent','weight','side_curtain');
create type public.delivery_status as enum ('pending','done','problem');

create table public.years (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (btrim(label) <> '' and length(label) <= 50),
  festival_start date not null,
  request_open_at timestamptz,
  request_close_at timestamptz,
  status public.year_status not null default 'preparing',
  allocation_version integer not null default 0,
  auto_allocated_at timestamptz,
  prev_year_id uuid references public.years on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (request_open_at is null or request_close_at is null or request_open_at < request_close_at)
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (btrim(name) <> '' and length(name) <= 100),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 20 and length(array_to_string(aliases, '')) <= 1000),
  kind public.room_kind not null default 'room',
  building text check (length(building) <= 50),
  floor smallint,
  is_storage boolean not null default false,
  extra_cost smallint not null default 0 check (extra_cost >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.room_years (
  year_id uuid not null references public.years on delete cascade,
  room_id uuid not null references public.rooms on delete restrict,
  usable boolean not null default true,
  note text check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (year_id, room_id)
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$' and length(code) <= 50),
  name text not null check (btrim(name) <> '' and length(name) <= 100),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 20 and length(array_to_string(aliases, '')) <= 1000),
  requestable_categories public.group_category[] not null default '{}',
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stocks (
  year_id uuid not null references public.years on delete cascade,
  room_id uuid not null references public.rooms on delete restrict,
  item_id uuid not null references public.items on delete restrict,
  count integer not null check (count between 0 and 10000),
  counted_by uuid references auth.users on delete set null,
  counted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (year_id, room_id, item_id)
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 100),
  display_name text check (length(display_name) <= 100),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 20 and length(array_to_string(aliases, '')) <= 1000),
  category public.group_category not null,
  is_food boolean not null default false,
  location_room_id uuid references public.rooms on delete restrict,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year_id, name),
  unique (id, year_id)
);

create table public.year_roles (
  year_id uuid not null references public.years on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (year_id, user_id)
);
create index year_roles_user_id_idx on public.year_roles (user_id);

create table public.group_members (
  group_id uuid not null references public.groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_id_idx on public.group_members (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and length(email) <= 254),
  role public.app_role,
  group_id uuid,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role is null) <> (group_id is null)),
  foreign key (group_id, year_id) references public.groups (id, year_id) on delete cascade
);
create index invitations_email_idx on public.invitations (email);
create index invitations_group_id_idx on public.invitations (group_id);

create table public.request_submissions (
  group_id uuid primary key references public.groups on delete cascade,
  submitted_at timestamptz,
  note text check (length(note) <= 2000),
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.requests (
  group_id uuid not null references public.groups on delete cascade,
  item_id uuid not null references public.items on delete restrict,
  count integer not null check (count between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, item_id)
);

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  code text not null check (btrim(code) <> '' and length(code) <= 50),
  kind public.rule_kind not null,
  params jsonb not null check (jsonb_typeof(params) = 'object' and length(params::text) <= 20000),
  enabled boolean not null default true,
  memo text check (length(memo) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year_id, code)
);

create table public.substitution_consents (
  group_id uuid not null references public.groups on delete cascade,
  from_item_id uuid not null references public.items on delete restrict,
  to_item_id uuid not null references public.items on delete restrict,
  count integer check (count between 0 and 10000),
  status public.consent_status not null default 'not_asked',
  note text check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, from_item_id, to_item_id),
  check (from_item_id <> to_item_id)
);

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  source_room_id uuid not null references public.rooms on delete restrict,
  group_id uuid not null,
  item_id uuid not null references public.items on delete restrict,
  requested_item_id uuid not null references public.items on delete restrict,
  count integer not null check (count between 1 and 10000),
  is_keep boolean not null default false,
  pinned boolean not null default false,
  origin public.alloc_origin not null,
  note text check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (group_id, year_id) references public.groups (id, year_id) on delete cascade
);
create index allocations_year_item_room_idx on public.allocations (year_id, item_id, source_room_id);
create index allocations_year_group_idx on public.allocations (year_id, group_id);

create table public.distance_overrides (
  building_a text not null check (length(building_a) <= 50),
  building_b text not null check (length(building_b) <= 50),
  cost smallint not null check (cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (building_a, building_b),
  -- 建物の組は向きを持たない。トリガー normalize_pair が C の照合順序で小さい方を building_a に入れ替える
  check (building_a collate "C" < building_b collate "C")
);

create table public.slots (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  day public.festival_day not null,
  starts_at time,
  ends_at time,
  label text not null check (btrim(label) <> '' and length(label) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, year_id),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  group_id uuid not null,
  kind public.delivery_kind not null,
  slot_id uuid,
  team smallint check (team between 1 and 100),
  status public.delivery_status not null default 'pending',
  problem_note text check (length(problem_note) <= 2000),
  returned boolean not null default false,
  checked_by uuid references auth.users on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, kind),
  foreign key (group_id, year_id) references public.groups (id, year_id) on delete cascade,
  foreign key (slot_id, year_id) references public.slots (id, year_id) on delete set null (slot_id)
);

create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text not null check (length(display_name) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_pk jsonb not null,
  action text not null check (action in ('insert','update','delete')),
  year_id uuid,
  group_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  user_id uuid,
  at timestamptz not null default now()
);
create index audit_logs_year_at_idx on public.audit_logs (year_id, at desc);
create index audit_logs_table_at_idx on public.audit_logs (table_name, at desc);
create index audit_logs_group_at_idx on public.audit_logs (group_id, at desc) where group_id is not null;

create view public.v_remaining with (security_invoker = true) as
  select s.year_id, s.room_id, s.item_id, s.count as stock,
         coalesce(sum(a.count), 0)::integer as allocated,
         (s.count - coalesce(sum(a.count), 0))::integer as remaining
  from public.stocks s
  left join public.room_years ry on ry.year_id = s.year_id and ry.room_id = s.room_id
  left join public.allocations a
    on a.year_id = s.year_id and a.source_room_id = s.room_id and a.item_id = s.item_id
  where coalesce(ry.usable, true)
  group by s.year_id, s.room_id, s.item_id, s.count;

-- RLS を全表で有効にする（ポリシーは T03。それまでは誰も読めない）
do $$
declare t text;
begin
  foreach t in array array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
    'invitations','request_submissions','requests','rules','substitution_consents','allocations',
    'distance_overrides','slots','deliveries','profiles','audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 既定の権限を外す（表ごとの grant は T03 の 0004 で与える）
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 未使用の招待は (年度・メール) にロール1つ、(年度・メール・団体) に1つ
create unique index invitations_pending_role_key on public.invitations (year_id, email)
  where role is not null and used_at is null;
create unique index invitations_pending_group_key on public.invitations (year_id, email, group_id)
  where group_id is not null and used_at is null;
