-- 003_business_settings.sql適用済みのDBへの修正SQL。
-- Supabaseの条件なしDELETEを拒否する保護機能を維持する。
-- 保存関数だけを置き換え、実行時の差分更新に変更する。
-- このSQL自体は予約・営業時間・休業日の行を変更しない。
-- まずline-booking-testで別途適用・確認。本番にはまだ実行しない。
begin;

do $$
begin
  if to_regprocedure('public.save_business_settings(uuid,integer,jsonb,jsonb)') is null then
    raise exception '003_business_settings.sql must be applied first';
  end if;
end;
$$;

create or replace function public.save_business_settings(
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
  -- 新設定から外した曜日だけを削除し、残す曜日は更新する。
  delete from public.business_hours as existing
    where not exists (
      select 1 from jsonb_to_recordset(p_hours)
        as wanted(weekday integer, opens_at time, closes_at time)
      where wanted.weekday = existing.weekday
    );
  insert into public.business_hours as existing(weekday, opens_at, closes_at)
    select h.weekday, h.opens_at, h.closes_at
    from jsonb_to_recordset(p_hours) as h(weekday integer, opens_at time, closes_at time)
    on conflict (weekday) do update
      set opens_at = excluded.opens_at, closes_at = excluded.closes_at
      where existing.opens_at is distinct from excluded.opens_at
         or existing.closes_at is distinct from excluded.closes_at;

  -- 新設定から外した日付だけを削除し、同じ日付は理由だけ更新する。
  delete from public.closed_days as existing
    where not exists (
      select 1 from jsonb_to_recordset(p_closed_days) as wanted(date text, reason text)
      where wanted.date::date = existing.closed_date
    );
  insert into public.closed_days as existing(closed_date, reason)
    select (c.date)::date, c.reason
    from jsonb_to_recordset(p_closed_days) as c(date text, reason text)
    on conflict (closed_date) do update
      set reason = excluded.reason
      where existing.reason is distinct from excluded.reason;
  perform public.assert_business_settings();
  return public.get_business_settings();
end;
$$;

-- CREATE OR REPLACEは既存の所有者・権限を維持する。
-- PUBLIC/anonへの権限追加、RLS解除、保護機能の無効化は行わない。
notify pgrst, 'reload schema';
commit;
