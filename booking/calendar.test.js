import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, monthRange, AppError } from './lib.js';
import { createBookingServer } from './server.js';
const config = { origin: 'http://localhost:3001', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const calendar = month => {
  const [start, end] = monthRange(month);
  return { month, days: Array.from({ length: (Date.parse(end) - Date.parse(start)) / 86400000 }, (_, i) => ({
    date: `${month}-${String(i + 1).padStart(2, '0')}`, confirmed: 0, completed: 0, cancelled: 0,
  })) };
};

test('month boundaries use Japan time, leap years, December rollover and supported extremes', () => {
  assert.deepEqual(monthRange('2028-02'), ['2028-01-31T15:00:00.000Z', '2028-02-29T15:00:00.000Z']);
  assert.deepEqual(monthRange('2026-12'), ['2026-11-30T15:00:00.000Z', '2026-12-31T15:00:00.000Z']);
  assert.equal(calendar('2027-02').days.length, 28);
  assert.equal(calendar('2028-02').days.length, 29);
  assert.equal(calendar('1000-01').days.length, 31);
  assert.equal(monthRange('9998-12')[1], '9998-12-31T15:00:00.000Z');
});

test('invalid and injected months are rejected before accessing the DB', async () => {
  const service = createServices(config, () => assert.fail('Must not access DB'));
  for (const month of [undefined, null, '', '2026-1', '2026-13', '2026-00', '2026-02-01', '0999-12', '9999-01', '2026-01;drop table x']) {
    assert.throws(() => monthRange(month), e => e.status === 400);
    await assert.rejects(service.monthCounts(month, 'jwt'), e => e.status === 400);
  }
});

test('month counts use a single read-only aggregate RPC and administrator JWT', async () => {
  let calls = 0;
  const data = calendar('2028-02'); data.days[0].confirmed = 2; data.days[0].cancelled = 1201;
  const service = createServices(config, async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.apikey, config.anonKey);
    assert.equal(options.headers.Authorization, 'Bearer admin-jwt');
    assert.equal(options.body, undefined);
    const u = new URL(url);
    assert.equal(u.pathname, '/rest/v1/rpc/get_booking_month_counts');
    assert.equal(u.searchParams.get('p_month'), '2028-02-01');
    return response(data);
  });
  assert.deepEqual(await service.monthCounts('2028-02', 'admin-jwt'), data);
  assert.equal(calls, 1);
});

test('month counts never fall back to service_role when the token is missing', async () => {
  const service = createServices(config, () => assert.fail('Must not access DB'));
  for (const token of ['', null, undefined, 1]) await assert.rejects(service.monthCounts('2026-10', token), e => e.status === 401);
});

test('month response contains only date and status counts even if upstream includes private fields', async () => {
  const data = calendar('2026-10');
  data.customers = 'must not leak';
  data.days[0].name = 'must not leak'; data.days[0].id = 'private-id';
  const service = createServices(config, async () => response(data));
  assert.deepEqual(await service.monthCounts('2026-10', 'jwt'), calendar('2026-10'));
});

test('missing, duplicated or unordered days and malformed counts fail without partial results', async () => {
  const variants = [];
  let data = calendar('2026-10'); data.days.pop(); variants.push(data);
  data = calendar('2026-10'); data.month = '2026-11'; variants.push(data);
  data = calendar('2026-10'); data.days[1] = data.days[0]; variants.push(data);
  for (const value of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    data = calendar('2026-10'); data.days[0].confirmed = value; variants.push(data);
  }
  variants.push(null);
  for (const data of variants) {
    const service = createServices(config, async () => response(data));
    await assert.rejects(service.monthCounts('2026-10', 'jwt'), e => e.status === 503);
  }
});

test('missing calendar SQL and database failures produce safe messages without private details', async () => {
  for (const code of ['PGRST202', '42501', 'XX000']) {
    const service = createServices(config, async () => response({ code, message: 'private SQL details' }, 400));
    await assert.rejects(service.monthCounts('2026-10', 'jwt'), e => e.status === 503 && !e.message.includes('private') && (code !== 'PGRST202' || e.message.includes('005')));
  }
});

test('month network failures do not produce zero counts or retry requests', async () => {
  let calls = 0;
  const service = createServices(config, async () => { calls++; throw new Error('Private network details'); });
  await assert.rejects(service.monthCounts('2026-10', 'jwt'), e => e.status === 503 && !e.message.includes('Private'));
  assert.equal(calls, 1);
});

async function app(t, overrides = {}) {
  const server = createBookingServer(config, {
    login: async () => ({ token: 'jwt', expiresIn: 3600 }), isAdmin: async () => true,
    monthCounts: async month => calendar(month), ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = (month, cookie) => fetch(base + '/api/admin/calendar' + (month === undefined ? '' : '?month=' + encodeURIComponent(month)), {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const login = async () => (await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fake@example.invalid', password: 'fake' }),
  })).headers.get('set-cookie');
  return { base, read, login };
}

test('calendar endpoint forwards the validated month and admin JWT with no-store headers', async t => {
  let received;
  const { read, login } = await app(t, { monthCounts: async (...args) => { received = args; return calendar(args[0]); } });
  const r = await read('2028-02', await login());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(received, ['2028-02', 'jwt']);
  assert.deepEqual(await r.json(), calendar('2028-02'));
});

test('anonymous and non-admin callers cannot retrieve calendar counts', async t => {
  const { read, login } = await app(t, { isAdmin: async () => false, monthCounts: () => assert.fail('Must not read') });
  assert.equal((await read('2026-10')).status, 401);
  assert.equal(await login(), null);
  assert.equal((await read('2026-10', 'booking_session=made-up')).status, 401);
});

test('revoked and expired admin sessions cannot retrieve counts', async t => {
  let allowed = true;
  const { read, login } = await app(t, { isAdmin: async () => allowed, monthCounts: () => assert.fail('Must not read') });
  const cookie = await login(); allowed = false;
  assert.equal((await read('2026-10', cookie)).status, 403);
  assert.equal((await read('2026-10', cookie)).status, 401);
  const expired = await app(t, { login: async () => ({ token: 'jwt', expiresIn: -1 }), monthCounts: () => assert.fail('Must not read') });
  assert.equal((await expired.read('2026-10', await expired.login())).status, 401);
});

test('calendar endpoint refuses invalid or missing month before calling services', async t => {
  const { read, login } = await app(t, { monthCounts: () => assert.fail('Must not read') });
  const cookie = await login();
  for (const month of [undefined, '2026-13', 'bad']) assert.equal((await read(month, cookie)).status, 400);
});

test('calendar API failure preserves error status and returns no calendar data', async t => {
  const { read, login } = await app(t, { monthCounts: async () => { throw new AppError(503, 'Safe error'); } });
  const r = await read('2026-10', await login());
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Safe error' });
});

test('calendar assets load without injecting server secrets into the page', async t => {
  const { base } = await app(t);
  for (const path of ['/admin', '/admin-calendar.js']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(body.includes(config.serviceKey), false);
    assert.equal(body.includes(config.anonKey), false);
  }
});
