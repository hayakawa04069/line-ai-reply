-- 任意の試作用設定。実際の営業時間・メニューに書き換えてから使用。
-- 顧客や予約の個人情報は含みません。既存の設定を上書きしません。
begin;
insert into public.booking_settings(singleton, store_name, slot_minutes, booking_window_days)
values (true, 'テスト店舗', 15, 60) on conflict do nothing;

-- 月～土 10:00～18:00、日曜定休の例。
insert into public.business_hours(weekday, opens_at, closes_at)
select weekday, time '10:00', time '18:00' from generate_series(1, 6) as weekday
on conflict do nothing;

insert into public.menus(name, duration_minutes, price_yen)
select 'お試しメニュー', 60, 3000
where not exists (select 1 from public.menus where name = 'お試しメニュー');
commit;
