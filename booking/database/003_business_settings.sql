-- 001_initial.sql、002_example_settings.sql適用後の追加SQL。
-- Supabaseにはまだ実行しないこと。1店舗・1日1営業区間向け。
begin;

alter table public.booking_settings
  add column settings_revision uuid not null default gen_random_uuid();

-- PostgREST標準のREAD COMMITTEDで、ロック待ち後の最新設定を検査する。
-- 古いスナップショットを保持する分離レベルでの書き込みは拒否する。
create function public.require_booking_read_committed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Booking writes require READ COMMITTED' using errcode = '23514';
  end if;
  return null;
end;
$$;
create trigger reservation_isolation before insert or update or delete on public.reservations
  for each statement execute function public.require_booking_read_committed();

-- 設定変更と予約の作成・変更・キャンセルを同時に確定させない。
-- 通常のSELECTは妨げない。トランザクション終了時に自動解放される。
create function public.lock_business_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Settings writes require READ COMMITTED' using errcode = '23514';
  end if;
  if current_user = 'authenticated' and not public.is_booking_admin() then
    raise exception 'Booking admin required' using errcode = '42501';
  end if;
  lock table public.reservations in share row exclusive mode;
  return null;
end;
$$;

create function public.bump_business_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_TABLE_NAME = 'booking_settings' then
    NEW.settings_revision := gen_random_uuid();
    return NEW;
  end if;
  update public.booking_settings set settings_revision = gen_random_uuid()
  where singleton;
  return null;
end;
$$;

-- 予約の氏名等は返さず、矛盾する設定を拒否する。
create function public.assert_business_settings()
returns void language plpgsql set search_path = '' as $$
declare
  settings public.booking_settings%rowtype;
begin
  select * into settings from public.booking_settings where singleton;
  if not found then
    raise exception 'Store settings are required' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.reservations r
    left join public.business_hours h on h.weekday =
      extract(dow from r.starts_at at time zone 'Asia/Tokyo')::integer
    where r.status <> 'cancelled' and r.ends_at > now()
      and (
        h.weekday is null
        or (r.starts_at at time zone 'Asia/Tokyo')::date <>
           (r.ends_at at time zone 'Asia/Tokyo')::date
        or (r.starts_at at time zone 'Asia/Tokyo')::time < h.opens_at
        or (r.ends_at at time zone 'Asia/Tokyo')::time > h.closes_at
        or mod((extract(epoch from (
          (r.starts_at at time zone 'Asia/Tokyo')::time - h.opens_at
        )) / 60)::integer, settings.slot_minutes) <> 0
        or exists (
          select 1 from public.closed_days c
          where c.closed_date = (r.starts_at at time zone 'Asia/Tokyo')::date
        )
      )
  ) then
    raise exception 'Settings conflict with existing reservations' using errcode = 'P2002';
  end if;
end;
$$;

create function public.check_business_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform public.assert_business_settings();
  return null;
end;
$$;

create trigger booking_settings_lock before insert or update or delete on public.booking_settings
  for each statement execute function public.lock_business_settings();
create trigger business_hours_lock before insert or update or delete on public.business_hours
  for each statement execute function public.lock_business_settings();
create trigger closed_days_lock before insert or update or delete on public.closed_days
  for each statement execute function public.lock_business_settings();

create trigger booking_settings_revision before update on public.booking_settings
  for each row execute function public.bump_business_revision();
create trigger business_hours_revision after insert or update or delete on public.business_hours
  for each statement execute function public.bump_business_revision();
create trigger closed_days_revision after insert or update or delete on public.closed_days
  for each statement execute function public.bump_business_revision();

-- RPCが複数テーブルを更新する途中ではなく、最終状態を検査。
create constraint trigger booking_settings_guard after insert or update or delete on public.booking_settings
  deferrable initially deferred for each row execute function public.check_business_settings();
create constraint trigger business_hours_guard after insert or update or delete on public.business_hours
  deferrable initially deferred for each row execute function public.check_business_settings();
create constraint trigger closed_days_guard after insert or update or delete on public.closed_days
  deferrable initially deferred for each row execute function public.check_business_settings();

create function public.get_business_settings()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_booking_admin() then
    raise exception 'Booking admin required' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'revision', s.settings_revision,
    'slotMinutes', s.slot_minutes,
    'hours', coalesce((select jsonb_agg(jsonb_build_object(
      'weekday', h.weekday,
      'opens_at', to_char(h.opens_at, 'HH24:MI'),
      'closes_at', to_char(h.closes_at, 'HH24:MI')
    ) order by h.weekday) from public.business_hours h), '[]'::jsonb),
    'closedDays', coalesce((select jsonb_agg(jsonb_build_object(
      'date', c.closed_date, 'reason', coalesce(c.reason, '')
    ) order by c.closed_date) from public.closed_days c), '[]'::jsonb)
  ) into result from public.booking_settings s where singleton;
  if result is null then
    raise exception 'Store settings are required' using errcode = '23514';
  end if;
  return result;
end;
$$;

create function public.save_business_settings(
  p_revision uuid, p_slot_minutes integer, p_hours jsonb, p_closed_days jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  current_revision uuid;
  item jsonb;
begin
  if not public.is_booking_admin() then
    raise exception 'Booking admin required' using errcode = '42501';
  end if;
  if p_revision is null or p_slot_minutes is null
     or p_slot_minutes not in (5, 10, 15, 20, 30, 60)
     or p_hours is null or jsonb_typeof(p_hours) <> 'array'
     or p_closed_days is null or jsonb_typeof(p_closed_days) <> 'array' then
    raise exception 'Invalid settings' using errcode = '23514';
  end if;
  if jsonb_array_length(p_hours) > 7 or jsonb_array_length(p_closed_days) > 100 then
    raise exception 'Too many settings' using errcode = '23514';
  end if;
  for item in select value from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Invalid hours' using errcode = '23514';
    end if;
    if (item - array['weekday', 'opens_at', 'closes_at']) <> '{}'::jsonb
       or not (item ?& array['weekday', 'opens_at', 'closes_at'])
       or jsonb_typeof(item->'weekday') <> 'number'
       or (item->>'weekday') !~ '^[0-6]$'
       or jsonb_typeof(item->'opens_at') <> 'string'
       or jsonb_typeof(item->'closes_at') <> 'string'
       or (item->>'opens_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (item->>'closes_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Invalid hours' using errcode = '23514';
    end if;
    if (item->>'opens_at')::time >= (item->>'closes_at')::time then
      raise exception 'Invalid opening interval' using errcode = '23514';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'weekday') from jsonb_array_elements(p_hours)) then
    raise exception 'Duplicate weekday' using errcode = '23514';
  end if;
  for item in select value from jsonb_array_elements(p_closed_days) loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Invalid closed day' using errcode = '23514';
    end if;
    if (item - array['date', 'reason']) <> '{}'::jsonb
       or not (item ?& array['date', 'reason'])
       or jsonb_typeof(item->'date') <> 'string'
       or (item->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(item->'reason') <> 'string'
       or length(item->>'reason') > 200 then
      raise exception 'Invalid closed day' using errcode = '23514';
    end if;
    perform (item->>'date')::date;
  end loop;
  if (select count(*) <> count(distinct value->>'date') from jsonb_array_elements(p_closed_days)) then
    raise exception 'Duplicate closed day' using errcode = '23514';
  end if;

  lock table public.reservations in share row exclusive mode;
  select settings_revision into current_revision from public.booking_settings
    where singleton for update;
  if not found then
    raise exception 'Store settings are required' using errcode = '23514';
  end if;
  if current_revision <> p_revision then
    raise exception 'Settings changed since read' using errcode = 'P2001';
  end if;

  update public.booking_settings set slot_minutes = p_slot_minutes where singleton;
  delete from public.business_hours;
  insert into public.business_hours(weekday, opens_at, closes_at)
    select h.weekday, h.opens_at, h.closes_at
    from jsonb_to_recordset(p_hours) as h(weekday integer, opens_at time, closes_at time);
  delete from public.closed_days;
  insert into public.closed_days(closed_date, reason)
    select (c.date)::date, c.reason
    from jsonb_to_recordset(p_closed_days) as c(date text, reason text);
  perform public.assert_business_settings();
  return public.get_business_settings();
end;
$$;

-- 補助関数は呼び出し経路を限定する。検査関数はSECURITY INVOKERでRLS適用。
revoke all on function public.require_booking_read_committed(), public.lock_business_settings(), public.bump_business_revision(),
  public.check_business_settings() from public, anon, authenticated;
revoke all on function public.assert_business_settings() from public, anon, authenticated;
grant execute on function public.assert_business_settings() to authenticated;
revoke all on function public.get_business_settings(),
  public.save_business_settings(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.get_business_settings(),
  public.save_business_settings(uuid, integer, jsonb, jsonb) to authenticated;

commit;
