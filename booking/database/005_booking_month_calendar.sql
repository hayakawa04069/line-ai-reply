-- 店舗管理者専用の月間件数取得。既存テーブル・予約・権限は変更しない。
-- 新しい読み取り関数だけを追加する。まずテスト用DBで別途適用する。
begin;

do $$
begin
  if to_regprocedure('public.is_booking_admin()') is null
     or to_regclass('public.reservations') is null then
    raise exception 'Initial booking schema must be applied first';
  end if;
end;
$$;

create function public.get_booking_month_counts(p_month date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_booking_admin() then
    raise exception 'Booking admin required' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1
     or extract(year from p_month) not between 1000 and 9998 then
    raise exception 'Invalid calendar month' using errcode = '23514';
  end if;

  -- 集計は1つのSELECTで完結。個人情報も予約IDも取得・返却しない。
  with daily as (
    select (r.starts_at at time zone 'Asia/Tokyo')::date as day,
      count(*) filter (where r.status = 'confirmed') as confirmed,
      count(*) filter (where r.status = 'completed') as completed,
      count(*) filter (where r.status = 'cancelled') as cancelled
    from public.reservations r
    where r.starts_at >= (p_month::timestamp at time zone 'Asia/Tokyo')
      and r.starts_at < ((p_month + interval '1 month') at time zone 'Asia/Tokyo')
    group by (r.starts_at at time zone 'Asia/Tokyo')::date
  ), dates as (
    select d::date as day from generate_series(
      p_month::timestamp,
      p_month + interval '1 month' - interval '1 day',
      interval '1 day'
    ) as d
  )
  select jsonb_build_object(
    'month', to_char(p_month, 'YYYY-MM'),
    'days', jsonb_agg(jsonb_build_object(
      'date', to_char(d.day, 'YYYY-MM-DD'),
      'confirmed', coalesce(c.confirmed, 0),
      'completed', coalesce(c.completed, 0),
      'cancelled', coalesce(c.cancelled, 0)
    ) order by d.day)
  ) into result from dates d left join daily c on c.day = d.day;
  return result;
end;
$$;

revoke all on function public.get_booking_month_counts(date) from public, anon, authenticated;
grant execute on function public.get_booking_month_counts(date) to authenticated;
notify pgrst, 'reload schema';
commit;
