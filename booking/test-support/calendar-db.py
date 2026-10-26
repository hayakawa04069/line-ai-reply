"""月間集計をネットワークなしの使い捨てPostgreSQL17で検証。Supabase接続なし。"""
from pathlib import Path
import json
import os
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ENV = {k: v for k, v in os.environ.items() if k not in (
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
NAME = 'booking-calendar-check-' + uuid.uuid4().hex[:10]
ADMIN = '00000000-0000-4000-8000-000000000001'
USER = '00000000-0000-4000-8000-000000000002'
PREFIX = f"set request.jwt.claim.sub='{ADMIN}'; set role authenticated;\n"
PSQL = DOCKER + ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1']

def run(sql, admin=False, error=None):
    r = subprocess.run(PSQL, input='\\set VERBOSITY verbose\n' + (PREFIX if admin else '') + sql,
                       text=True, capture_output=True, env=ENV, timeout=20)
    assert (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0, r.stderr
    return r.stdout.strip()

def month(value):
    return json.loads(run(f"select public.get_booking_month_counts('{value}-01');", admin=True))

def passed(name):
    print('Calendar DB test passed: ' + name, flush=True)

try:
    subprocess.run(DOCKER + ['run', '--detach', '--pull=never', '--network', 'none', '--name', NAME,
                            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17'],
                   capture_output=True, check=True, env=ENV)
    for _ in range(100):
        r = subprocess.run(DOCKER + ['exec', NAME, 'pg_isready', '-U', 'postgres'], capture_output=True, env=ENV)
        logs = subprocess.run(DOCKER + ['logs', NAME], capture_output=True, text=True, env=ENV)
        if r.returncode == 0 and 'PostgreSQL init process complete' in logs.stdout: break
        time.sleep(0.1)
    else: raise AssertionError('Local PostgreSQL failed to initialize')
    run(f"""
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('{ADMIN}'), ('{USER}');
    """)
    for file in ['001_initial.sql', '002_example_settings.sql', '003_business_settings.sql',
                 '004_business_settings_filtered_writes.sql', '005_booking_month_calendar.sql']:
        run((ROOT / 'booking/database' / file).read_text())
    run(f"insert into public.booking_admins(user_id) values ('{ADMIN}');")
    assert len(month('2028-02')['days']) == 29
    assert len(month('2030-02')['days']) == 28
    assert all(row['confirmed'] == row['completed'] == row['cancelled'] == 0 for row in month('2030-02')['days'])
    passed('empty months return every day including leap day')

    run('set role anon; select public.get_booking_month_counts(\'2030-02-01\');', error='42501')
    run(f"set request.jwt.claim.sub='{USER}'; set role authenticated; select public.get_booking_month_counts('2030-02-01');", error='42501')
    passed('anonymous and authenticated non-admin calls are denied')
    for argument in ["'2030-02-02'", 'null', "'0999-01-01'", "'9999-01-01'"]:
        run(f'select public.get_booking_month_counts({argument});', admin=True, error='23514')
    passed('null, non-first days and unsupported years are rejected')

    # Fixtures only: disable the scheduling trigger during construction of historical
    # and midnight boundary records. This runs solely inside this disposable DB.
    run("""
      insert into public.customers(id,display_name)
        values ('10000000-0000-4000-8000-000000000001','Synthetic fixture');
      alter table public.reservations disable trigger validate_reservation;
      insert into public.reservations(customer_id,menu_id,starts_at,ends_at,menu_name,
                                     duration_minutes,price_yen,status,request_id)
      select '10000000-0000-4000-8000-000000000001',m.id,v.starts,
             v.starts+interval '60 minutes','Fixture',60,3000,v.status,gen_random_uuid()
      from public.menus m cross join (values
        ('2030-01-31 14:59+00'::timestamptz,'cancelled'),
        ('2030-01-31 15:00+00'::timestamptz,'confirmed'),
        ('2030-02-28 14:59+00'::timestamptz,'confirmed'),
        ('2030-02-28 15:00+00'::timestamptz,'cancelled'),
        ('2030-02-10 01:00+00'::timestamptz,'completed'),
        ('2028-02-29 01:00+00'::timestamptz,'cancelled'),
        ('2030-12-31 14:59+00'::timestamptz,'cancelled'),
        ('2030-12-31 15:00+00'::timestamptz,'cancelled')
      ) as v(starts,status);
      insert into public.reservations(customer_id,menu_id,starts_at,ends_at,menu_name,
                                     duration_minutes,price_yen,status,request_id)
      select '10000000-0000-4000-8000-000000000001',m.id,'2030-02-12 01:00+00',
        '2030-02-12 02:00+00','Fixture',60,3000,'cancelled',gen_random_uuid()
      from public.menus m cross join generate_series(1,1205);
      alter table public.reservations enable trigger validate_reservation;
    """)
    feb = month('2030-02')
    assert feb['days'][0]['confirmed'] == 1
    assert feb['days'][-1]['confirmed'] == 1
    assert month('2030-01')['days'][-1]['cancelled'] == 1
    assert month('2030-03')['days'][0]['cancelled'] == 1
    passed('inclusive Japanese midnight and exclusive next-month midnight')
    assert sum(d['confirmed'] for d in feb['days']) == 2
    assert sum(d['completed'] for d in feb['days']) == 1
    assert sum(d['cancelled'] for d in feb['days']) == 1205
    passed('all status counts are separate and over 1000 records are counted')
    assert month('2028-02')['days'][-1]['date'] == '2028-02-29'
    assert month('2028-02')['days'][-1]['cancelled'] == 1
    assert month('2030-12')['days'][-1]['cancelled'] == 1
    assert month('2031-01')['days'][0]['cancelled'] == 1
    passed('leap-day and December-to-January data boundaries')
    for zone in ['UTC', 'Asia/Tokyo', 'Pacific/Honolulu']:
        value = json.loads(run(f"set timezone='{zone}'; select public.get_booking_month_counts('2030-02-01');", admin=True))
        assert value == feb
    passed('aggregation does not depend on the database session timezone')
    assert set(feb) == {'month', 'days'}
    assert all(set(d) == {'date', 'confirmed', 'completed', 'cancelled'} for d in feb['days'])
    before = run('select count(*)::text || max(updated_at)::text from public.reservations;')
    readonly = json.loads(run("begin read only; select public.get_booking_month_counts('2030-02-01'); rollback;", admin=True))
    assert readonly == feb
    assert run('select count(*)::text || max(updated_at)::text from public.reservations;') == before
    passed('read-only transaction succeeds without exposing identifiers or changing records')
    assert run("select count(*) from pg_policies where policyname='admins_only';") == '6'
    assert run("select has_table_privilege('authenticated','public.reservations','DELETE');") == 'f'
    assert run("select prosecdef from pg_proc where oid='public.get_booking_month_counts(date)'::regprocedure;") == 'f'
    assert run("select has_function_privilege('anon','public.get_booking_month_counts(date)','EXECUTE');") == 'f'
    passed('existing RLS, reservation deletion restriction and invoker security remain')
    print('All nine calendar database scenarios passed. No Supabase connection was used.')
finally:
    subprocess.run(DOCKER + ['rm', '-f', NAME], capture_output=True, env=ENV)
