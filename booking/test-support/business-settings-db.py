"""使い捨てPostgreSQL17で営業設定SQLと並行処理を検証。Supabaseへは接続しない。
Dockerのローカルpostgres:17イメージが必要。イメージの取得は行わない。
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
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
NAME = 'booking-settings-check-' + uuid.uuid4().hex[:10]
ADMIN = '00000000-0000-4000-8000-000000000001'
USER = '00000000-0000-4000-8000-000000000002'
PREFIX = f"set request.jwt.claim.sub = '{ADMIN}'; set role authenticated;\n"
PSQL = DOCKER + ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1']

def run(sql, admin=False, error=None):
    result = subprocess.run(PSQL, input='\\set VERBOSITY verbose\n' + (PREFIX if admin else '') + sql,
                            text=True, capture_output=True, env=ENV, timeout=20)
    if error:
        assert result.returncode != 0 and error in result.stderr, result.stderr
    else:
        assert result.returncode == 0, result.stderr
    return result.stdout.strip()

def settings():
    return json.loads(run('select public.get_business_settings();', admin=True))

def quoted(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"

def save_sql(data):
    return ("select public.save_business_settings('" + data['revision'] + "'::uuid, " +
            str(data['slotMinutes']) + ', ' + quoted(data['hours']) + ', ' + quoted(data['closedDays']) + ');')

def save(data, error=None):
    return run(save_sql(data), admin=True, error=error)

def passed(name):
    print('DB test passed: ' + name, flush=True)

def holding(sql, admin=False):
    p = subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, env=ENV)
    p.stdin.write((PREFIX if admin else '') + "begin;\n" + sql + "\nselect 'READY'; select pg_sleep(0.6); commit;\n")
    p.stdin.close()
    p.stdin = None
    while True:
        line = p.stdout.readline()
        if line.strip() == 'READY':
            break
        assert line, p.stderr.read()
    return p

def finish(p):
    output, error = p.communicate(timeout=15)
    assert p.returncode == 0, error

try:
    subprocess.run(DOCKER + ['run', '--detach', '--pull=never', '--network', 'none', '--name', NAME,
                            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17'],
                   check=True, capture_output=True, env=ENV)
    for _ in range(100):
        r = subprocess.run(DOCKER + ['exec', NAME, 'pg_isready', '-U', 'postgres'],
                           capture_output=True, env=ENV)
        logs = subprocess.run(DOCKER + ['logs', NAME], capture_output=True, text=True, env=ENV)
        if r.returncode == 0 and 'PostgreSQL init process complete' in logs.stdout:
            break
        time.sleep(0.1)
    else:
        raise AssertionError('Local PostgreSQL failed to start')
    run(f"""
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('{ADMIN}'), ('{USER}');
    """)
    for file in ['001_initial.sql', '002_example_settings.sql']:
        run((ROOT / 'booking/database' / file).read_text())
    run((ROOT / 'booking/database/004_business_settings_filtered_writes.sql').read_text(), error='P0001')
    passed('004 refuses installation before 003 without creating a partial function')
    run((ROOT / 'booking/database/003_business_settings.sql').read_text())
    run(f"insert into public.booking_admins(user_id) values ('{ADMIN}');")
    upgrade_before = run("select row_to_json(s)::text from public.booking_settings s;")
    grants_before = run("select proacl::text || prosecdef::text || proowner::text || proconfig::text from pg_proc where oid='public.save_business_settings(uuid,integer,jsonb,jsonb)'::regprocedure;")
    run((ROOT / 'booking/database/004_business_settings_filtered_writes.sql').read_text())
    assert run("select row_to_json(s)::text from public.booking_settings s;") == upgrade_before
    assert run("select proacl::text || prosecdef::text || proowner::text || proconfig::text from pg_proc where oid='public.save_business_settings(uuid,integer,jsonb,jsonb)'::regprocedure;") == grants_before
    passed('004 upgrade preserves settings values, revision and existing grants')

    original = settings()
    assert original['slotMinutes'] == 15 and len(original['hours']) == 6
    passed('migration and approved default schedule')

    run('set role anon; select public.get_business_settings();', error='42501')
    run(f"set request.jwt.claim.sub = '{USER}'; set role authenticated; select public.get_business_settings();", error='42501')
    run(f"set request.jwt.claim.sub = '{USER}'; set role authenticated; " + save_sql(original), error='42501')
    passed('anonymous and non-admin cannot use settings RPCs')

    today = datetime.now(timezone(timedelta(hours=9))).date()
    monday = today + timedelta(days=(7 - today.weekday()) % 7 + 7)
    customer = '10000000-0000-4000-8000-000000000001'
    run(f"insert into public.customers(id, display_name) values ('{customer}', 'Synthetic fixture');")
    def reservation(day, start='10:15'):
        return f"""insert into public.reservations(customer_id, menu_id, starts_at, request_id)
          values ('{customer}', (select id from public.menus limit 1),
                  '{day} {start}:00+09'::timestamptz, gen_random_uuid());"""
    run(reservation(monday))
    before = settings()
    for kind in ['interval', 'hours', 'closed', 'weekday']:
        candidate = json.loads(json.dumps(before))
        if kind == 'interval': candidate['slotMinutes'] = 30
        if kind == 'hours': candidate['hours'][0]['closes_at'] = '11:00'
        if kind == 'closed': candidate['closedDays'] = [{'date': str(monday), 'reason': 'Test'}]
        if kind == 'weekday': candidate['hours'] = [h for h in candidate['hours'] if h['weekday'] != 1]
        save(candidate, error='P2002')
        assert settings() == before
        passed('conflicting ' + kind + ' change rolls back all tables and revision')

    candidate = settings()
    candidate['hours'][0]['closes_at'] = '19:00'
    result = json.loads(save(candidate))
    assert result['revision'] != candidate['revision']
    assert result['hours'][0]['closes_at'] == '19:00'
    save(candidate, error='P2001')
    passed('valid save and stale revision rejection')
    # A delete audit proves rows that remain in the payload are not deleted/recreated.
    run("""
      create table public.fixture_deletes(table_name text, key text);
      create function public.fixture_track_delete() returns trigger language plpgsql as $$
      begin
        insert into public.fixture_deletes values (TG_TABLE_NAME,
          case when TG_TABLE_NAME='business_hours' then to_jsonb(OLD)->>'weekday'
               else to_jsonb(OLD)->>'closed_date' end);
        return OLD;
      end;
      $$;
      grant insert on public.fixture_deletes to authenticated;
      create trigger fixture_hours_delete after delete on public.business_hours
        for each row execute function public.fixture_track_delete();
      create trigger fixture_days_delete after delete on public.closed_days
        for each row execute function public.fixture_track_delete();
    """)
    payload = settings()
    payload['closedDays'] = [
      {'date': str(monday + timedelta(days=8)), 'reason': 'Keep'},
      {'date': str(monday + timedelta(days=9)), 'reason': 'Remove'},
    ]
    save(payload)
    assert run('select count(*) from public.fixture_deletes;') == '0'
    payload = settings()
    payload['hours'] = [h for h in payload['hours'] if h['weekday'] != 6]
    payload['closedDays'] = [{'date': str(monday + timedelta(days=8)), 'reason': 'Updated'}]
    save(payload)
    deleted = run('select table_name || chr(58) || key from public.fixture_deletes order by table_name;').splitlines()
    assert deleted == ['business_hours:6', 'closed_days:' + str(monday + timedelta(days=9))], deleted
    assert settings()['closedDays'][0]['reason'] == 'Updated'
    restored = settings()
    restored['hours'] = original['hours']
    restored['closedDays'] = []
    save(restored)
    result = settings()
    passed('filtered deletes remove only omitted weekdays/dates; retained rows are updated')


    run("begin; update public.business_hours set closes_at='11:00' where weekday=1; commit;", error='P2002')
    assert settings() == result
    run(f"set request.jwt.claim.sub='{USER}'; set role authenticated; update public.business_hours set closes_at='20:00';", error='42501')
    passed('direct table updates cannot bypass the consistency guard')

    bad = settings(); bad['closedDays'] = [{'date': '2030-02-30', 'reason': ''}]
    save(bad, error='22008')
    bad = settings(); bad['hours'] = [bad['hours'][0], bad['hours'][0]]
    save(bad, error='23514')
    bad = settings(); bad['hours'][0]['opens_at'] = 'not-a-time'
    save(bad, error='23514')
    passed('database independently rejects malformed inputs')
    run("begin isolation level repeatable read; update public.business_hours set closes_at='19:00' where weekday=1; commit;", error='23514')
    run("begin isolation level repeatable read; " + reservation(monday + timedelta(days=4)) + " commit;", error='23514')
    passed('stale-snapshot isolation levels cannot bypass locking checks')

    wednesday = monday + timedelta(days=2)
    candidate = settings()
    candidate['closedDays'].append({'date': str(wednesday), 'reason': 'Race fixture'})
    p = holding(reservation(wednesday))
    save(candidate, error='P2002')
    finish(p)
    assert settings()['closedDays'] == []
    passed('reservation commits first: conflicting settings save is refused')

    thursday = monday + timedelta(days=3)
    candidate = settings()
    candidate['closedDays'].append({'date': str(thursday), 'reason': 'Race fixture'})
    p = holding(save_sql(candidate), admin=True)
    run(reservation(thursday), error='23514')
    finish(p)
    assert settings()['closedDays'] == candidate['closedDays']
    passed('settings commit first: waiting reservation uses new closure and is refused')

    a = settings(); b = json.loads(json.dumps(a))
    a['hours'][0]['closes_at'] = '20:00'
    b['hours'][0]['closes_at'] = '21:00'
    def competing_save(payload):
        return subprocess.run(PSQL, input='\\set VERBOSITY verbose\n' + PREFIX + save_sql(payload),
                              text=True, capture_output=True, env=ENV, timeout=20)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(competing_save, [a, b]))
    assert sum(r.returncode == 0 for r in results) == 1
    assert 'P2001' in next(r.stderr for r in results if r.returncode != 0)
    passed('two administrators sharing a revision cannot overwrite each other')

    run(f"update public.reservations set status='cancelled' where starts_at='{monday} 10:15+09'::timestamptz;")
    candidate = settings(); candidate['closedDays'].append({'date': str(monday), 'reason': 'Cancelled fixture'})
    save(candidate)
    passed('cancelled reservations do not block closure settings')

    assert run("select count(*) from pg_policies where policyname='admins_only';") == '6'
    assert run("select count(*) from pg_class where oid in ('public.booking_admins'::regclass,'public.booking_settings'::regclass,'public.customers'::regclass,'public.menus'::regclass,'public.business_hours'::regclass,'public.closed_days'::regclass,'public.reservations'::regclass) and relrowsecurity;") == '7'
    passed('existing six RLS policies and seven protected tables remain enabled')
    print('All local database scenarios passed. No Supabase connection was used.')
finally:
    subprocess.run(DOCKER + ['rm', '-f', NAME], capture_output=True, env=ENV)
