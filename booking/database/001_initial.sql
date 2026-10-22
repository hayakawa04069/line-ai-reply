-- 1店舗・同時受付1組向け。新規DB用。Supabase SQL Editorで管理者として実行する想定。
-- このファイルの作成だけではSupabaseに反映されません。
begin;

create table public.booking_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 管理者の追加はSQL Editorからのみ行います。利用者自身による昇格は禁止。
create function public.is_booking_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.booking_admins where user_id = auth.uid());
$$;
revoke all on function public.is_booking_admin() from public, anon, authenticated;
grant execute on function public.is_booking_admin() to authenticated;

create table public.booking_settings (
  singleton boolean primary key default true check (singleton),
  store_name text not null check (length(trim(store_name)) between 1 and 100),
  timezone text not null default 'Asia/Tokyo' check (timezone = 'Asia/Tokyo'),
  slot_minutes integer not null default 15 check (slot_minutes in (5, 10, 15, 20, 30, 60)),
  booking_window_days integer not null default 60 check (booking_window_days between 1 and 365)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  line_user_id text unique check (line_user_id is null or length(trim(line_user_id)) between 1 and 128),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  -- 任意。運用で不要なら収集しないこと。
  phone text check (phone is null or length(phone) between 1 and 30),
  created_at timestamptz not null default now()
);

create table public.menus (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 100),
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  price_yen integer not null default 0 check (price_yen >= 0),
  active boolean not null default true
);

create table public.business_hours (
  -- 0=日曜、1=月曜、…、6=土曜。行がない曜日は定休日。
  weekday integer primary key check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  check (opens_at < closes_at),
  check (extract(second from opens_at) = 0 and extract(second from closes_at) = 0)
);

create table public.closed_days (
  closed_date date primary key,
  reason text check (reason is null or length(reason) <= 200)
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  menu_id uuid not null references public.menus(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- メニュー変更後も予約時点の内容を残します。トリガーが設定します。
  menu_name text not null,
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  price_yen integer not null check (price_yen >= 0),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed')),
  -- 確定リクエストごとに生成。同じIDで再送しても予約は増えません。
  request_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at = starts_at + duration_minutes * interval '1 minute'),
  -- [開始, 終了)なので10:00-11:00の次に11:00から予約可能。
  -- 同時実行や管理者の変更にも適用。キャンセル済みの時間は解放。
  constraint reservations_no_overlap exclude using gist (
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status <> 'cancelled')
);
create index reservations_customer_idx on public.reservations(customer_id);
create index reservations_starts_idx on public.reservations(starts_at);

create function public.validate_reservation()
returns trigger language plpgsql set search_path = ''
as $$
declare
  selected_menu public.menus%rowtype;
  settings public.booking_settings%rowtype;
  hours public.business_hours%rowtype;
  local_start timestamp;
  local_end timestamp;
  must_validate boolean;
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'confirmed' then
      raise exception 'New reservations must be confirmed' using errcode = '23514';
    end if;
    must_validate := true;
  else
    must_validate := NEW.starts_at is distinct from OLD.starts_at
      or NEW.menu_id is distinct from OLD.menu_id
      or (OLD.status = 'cancelled' and NEW.status <> 'cancelled');
  end if;

  if must_validate then
    if NEW.status <> 'confirmed' then
      raise exception 'Only confirmed reservations can be scheduled' using errcode = '23514';
    end if;
    select * into selected_menu from public.menus where id = NEW.menu_id and active;
    if not found then
      raise exception 'Menu is unavailable' using errcode = '23514';
    end if;
    select * into settings from public.booking_settings where singleton;
    if not found then
      raise exception 'Store settings are missing' using errcode = '23514';
    end if;
    NEW.menu_name := selected_menu.name;
    NEW.duration_minutes := selected_menu.duration_minutes;
    NEW.price_yen := selected_menu.price_yen;
    NEW.ends_at := NEW.starts_at + selected_menu.duration_minutes * interval '1 minute';
    local_start := NEW.starts_at at time zone settings.timezone;
    local_end := NEW.ends_at at time zone settings.timezone;
    if NEW.starts_at <= now()
      or local_start::date > (now() at time zone settings.timezone)::date + settings.booking_window_days
      or local_start::date <> local_end::date
      or extract(second from local_start) <> 0 then
      raise exception 'Reservation date is unavailable' using errcode = '23514';
    end if;
    select * into hours from public.business_hours
      where weekday = extract(dow from local_start)::integer;
    if not found then
      raise exception 'Store is closed on this weekday' using errcode = '23514';
    end if;
    if exists (select 1 from public.closed_days where closed_date = local_start::date)
      or local_start::time < hours.opens_at or local_end::time > hours.closes_at
      or mod((extract(epoch from (local_start::time - hours.opens_at)) / 60)::integer, settings.slot_minutes) <> 0 then
      raise exception 'Reservation is outside available hours or slots' using errcode = '23514';
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.ends_at is distinct from OLD.ends_at
      or NEW.menu_name is distinct from OLD.menu_name
      or NEW.duration_minutes is distinct from OLD.duration_minutes
      or NEW.price_yen is distinct from OLD.price_yen then
      raise exception 'Change menu or start time to reschedule' using errcode = '23514';
    end if;
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;
revoke all on function public.validate_reservation() from public, anon, authenticated;
create trigger validate_reservation before insert or update on public.reservations
  for each row execute function public.validate_reservation();

-- ブラウザーからの匿名アクセスは全テーブル拒否。
-- ログイン済みでも、店舗管理者として登録された人だけを許可。
alter table public.booking_admins enable row level security;
alter table public.booking_settings enable row level security;
alter table public.customers enable row level security;
alter table public.menus enable row level security;
alter table public.business_hours enable row level security;
alter table public.closed_days enable row level security;
alter table public.reservations enable row level security;

revoke all on table public.booking_admins, public.booking_settings, public.customers,
  public.menus, public.business_hours, public.closed_days, public.reservations
  from public, anon, authenticated;
grant select, insert, update, delete on table public.booking_settings, public.customers,
  public.menus, public.business_hours, public.closed_days to authenticated;
-- 店舗操作での予約削除は禁止。キャンセルはstatusの更新で記録を残す。
grant select, insert, update on table public.reservations to authenticated;
grant all on table public.booking_admins, public.booking_settings, public.customers,
  public.menus, public.business_hours, public.closed_days, public.reservations to service_role;

create policy admins_only on public.booking_settings for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));
create policy admins_only on public.customers for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));
create policy admins_only on public.menus for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));
create policy admins_only on public.business_hours for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));
create policy admins_only on public.closed_days for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));
create policy admins_only on public.reservations for all to authenticated
  using ((select public.is_booking_admin())) with check ((select public.is_booking_admin()));

comment on table public.customers is '個人情報。顧客向けAPIから全件公開しない。';
comment on table public.booking_admins is 'SQL Editorで登録する店舗管理者。自己登録不可。';
commit;
