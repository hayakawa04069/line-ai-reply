import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, availableSlots, createServices, validDate } from './lib.js';
import { createBookingServer } from './server.js';

const menuId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const config = { origin: 'http://localhost:3001', supabaseUrl: 'https://test.supabase.co', anonKey: 'test-public-key', serviceKey: 'test-server-only-key', lineChannelId: '123456', liffId: 'test-liff' };
const booking = { menuId, requestId, displayName: 'テストのお客様', startsAt: '2030-01-07T01:00:00.000Z', idToken: 'test-line-id-token' };
const reservation = { id: requestId, menu_name: 'テストメニュー', starts_at: booking.startsAt, ends_at: '2030-01-07T02:00:00.000Z', price_yen: 3000, status: 'confirmed' };
const slotData = {
  date: '2030-01-07', menu: { duration_minutes: 60 }, settings: { booking_window_days: 60, slot_minutes: 30 },
  hours: { opens_at: '10:00:00', closes_at: '12:00:00' }, closed: false, reservations: [], now: new Date('2030-01-06T01:00:00Z'),
};

test('slots honor Japan time, duration, overlap, and adjacent reservations', () => {
  assert.deepEqual(availableSlots(slotData), ['2030-01-07T01:00:00.000Z', '2030-01-07T01:30:00.000Z', '2030-01-07T02:00:00.000Z']);
  assert.deepEqual(availableSlots({ ...slotData, reservations: [{ starts_at: '2030-01-07T01:00:00Z', ends_at: '2030-01-07T02:00:00Z' }] }), ['2030-01-07T02:00:00.000Z']);
});
test('slots reject closed dates, missing hours, past times, and booking window overflow', () => {
  for (const change of [{ closed: true }, { hours: null }, { date: '2030-04-01' }, { date: '2030-01-01' }, { now: new Date('2030-01-07T03:00:00Z') }]) {
    assert.deepEqual(availableSlots({ ...slotData, ...change }), []);
  }
  assert.equal(validDate('2030-02-30'), false);
  assert.equal(validDate('2030-01-07'), true);
});

async function app(t, overrides = {}, customConfig = {}) {
  const services = {
    catalog: async () => ({ store: { store_name: 'テスト店舗' }, menus: [] }), slots: async () => [booking.startsAt],
    verifyLine: async () => 'verified-line-user', reserve: async () => reservation,
    login: async () => ({ token: 'admin-jwt', expiresIn: 3600 }), isAdmin: async token => token === 'admin-jwt',
    reservations: async () => [{ ...reservation, customers: { display_name: 'テストのお客様' } }], ...overrides,
  };
  const server = createBookingServer({ ...config, ...customConfig }, services);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, data, headers = {}) => fetch(base + path, {
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: customConfig.origin || config.origin }), ...headers },
  });
}
test('customer and admin pages load; public configuration does not expose keys', async t => {
  const send = await app(t);
  for (const path of ['/', '/admin', '/style.css', '/app.js', '/admin.js', '/common.js']) assert.equal((await send(path)).status, 200);
  assert.deepEqual(await (await send('/api/config')).json(), { liffId: config.liffId });
  const response = await send('/api/catalog');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await send('/.env')).status, 404);
  assert.equal((await send('/server.js')).status, 404);
});
test('slot API validates date and menu', async t => {
  const send = await app(t);
  assert.equal((await send(`/api/slots?date=2030-01-07&menu_id=${menuId}`)).status, 200);
  assert.equal((await send(`/api/slots?date=2030-02-30&menu_id=${menuId}`)).status, 400);
  assert.equal((await send('/api/slots?date=2030-01-07&menu_id=bad')).status, 400);
});
test('reservation requires verified LINE identity and ignores browser customer IDs', async t => {
  let received;
  const send = await app(t, { reserve: async value => { received = value; return reservation; } });
  const response = await send('/api/reservations', { ...booking, lineUserId: 'attacker', customer_id: 'attacker' });
  assert.equal(response.status, 200);
  assert.equal(received.lineUserId, 'verified-line-user');
  assert.equal(received.customer_id, undefined);
  assert.deepEqual(await response.json(), { reservation });
});
test('invalid LINE authentication stops all database writes', async t => {
  const send = await app(t, { verifyLine: async () => { throw new AppError(401, '再ログインしてください'); }, reserve: () => assert.fail('must not write') });
  assert.equal((await send('/api/reservations', booking)).status, 401);
});
test('cross-origin changes and invalid input are rejected', async t => {
  const send = await app(t, { reserve: () => assert.fail('must not write') });
  assert.equal((await send('/api/reservations', booking, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send('/api/reservations', { ...booking, menuId: 'invalid' })).status, 400);
  assert.equal((await send('/api/reservations', { ...booking, displayName: '' })).status, 400);
});
test('reservation conflicts are returned as 409 without raw database errors', async t => {
  const send = await app(t, { reserve: async () => { throw new AppError(409, '別の時間を選んでください'); } });
  const response = await send('/api/reservations', booking);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '別の時間を選んでください' });
});
test('admin login uses HttpOnly cookie; logout invalidates it', async t => {
  const send = await app(t);
  assert.equal((await send('/api/admin/reservations?date=2030-01-07')).status, 401);
  const login = await send('/api/admin/login', { email: 'test@example.invalid', password: 'test-only-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await login.text()).includes('admin-jwt'), false);
  assert.equal((await send('/api/admin/reservations?date=2030-01-07', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await send('/api/admin/logout', {}, { Cookie: cookie })).status, 200);
  assert.equal((await send('/api/admin/session', undefined, { Cookie: cookie })).status, 401);
});
test('HTTPS session cookie has Secure and __Host prefix', async t => {
  const send = await app(t, {}, { origin: 'https://booking.example' });
  const login = await send('/api/admin/login', { email: 'test@example.invalid', password: 'test' });
  assert.match(login.headers.get('set-cookie'), /^__Host-booking_session=.*; Secure$/);
});
test('non-admin cannot log in and revoked admin loses access immediately', async t => {
  let allowed = false;
  const send = await app(t, { isAdmin: async () => allowed });
  assert.equal((await send('/api/admin/login', { email: 'test@example.invalid', password: 'test' })).status, 403);
  allowed = true;
  const login = await send('/api/admin/login', { email: 'test@example.invalid', password: 'test' });
  allowed = false;
  assert.equal((await send('/api/admin/session', undefined, { Cookie: login.headers.get('set-cookie') })).status, 403);
});
test('login rate limiting blocks repeated attempts', async t => {
  const send = await app(t, { login: async () => { throw new AppError(401, 'invalid'); } });
  for (let i = 0; i < 10; i++) assert.equal((await send('/api/admin/login', { email: 'x', password: 'x' })).status, 401);
  assert.equal((await send('/api/admin/login', { email: 'x', password: 'x' })).status, 429);
});

const response = data => new Response(JSON.stringify(data));
test('LINE token is verified against the configured channel, not decoded locally', async () => {
  const services = createServices(config, async (url, options) => {
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(new URLSearchParams(options.body).get('client_id'), config.lineChannelId);
    return response({ sub: 'line-user', iss: 'https://access.line.me', aud: config.lineChannelId, exp: Math.floor(Date.now() / 1000) + 60 });
  });
  assert.equal(await services.verifyLine('test-id-token'), 'line-user');
  const invalid = createServices(config, async () => response({ sub: 'line-user', iss: 'https://access.line.me', aud: 'wrong', exp: 1 }));
  await assert.rejects(invalid.verifyLine('test'), error => error.status === 401);
});
test('admin reservation queries use the user JWT to preserve RLS', async () => {
  const services = createServices(config, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer admin-jwt');
    assert.equal(options.headers.apikey, config.anonKey);
    const query = new URL(url).searchParams;
    assert.equal(query.get('starts_at'), 'gte.2030-01-06T15:00:00.000Z');
    assert.equal(query.get('and'), '(starts_at.lt.2030-01-07T15:00:00.000Z)');
    assert.equal(query.get('select').includes('line_user_id'), false);
    return response([]);
  });
  assert.deepEqual(await services.reservations('2030-01-07', 'admin-jwt'), []);
});
test('registration uses verified customer ID, DB-triggered snapshots and safe response fields', async () => {
  let count = 0;
  const services = createServices(config, async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${config.serviceKey}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/customers')) {
      assert.deepEqual(JSON.parse(options.body), { line_user_id: 'verified-user', display_name: booking.displayName });
      return response([{ id: 'db-customer' }]);
    }
    if (options.method === 'GET') return response([]);
    count++;
    assert.deepEqual(JSON.parse(options.body), { customer_id: 'db-customer', menu_id: menuId, starts_at: booking.startsAt, request_id: requestId });
    return response([{ ...reservation, customer_id: 'not-exposed', line_user_id: 'not-exposed' }]);
  });
  assert.deepEqual(await services.reserve({ ...booking, lineUserId: 'verified-user' }), reservation);
  assert.equal(count, 1);
});
test('idempotent retry returns only the same customer request without a second insert', async () => {
  const services = createServices(config, async (url, options) => {
    if (new URL(url).pathname.endsWith('/customers')) return response([{ id: 'same-customer' }]);
    assert.equal(options.method, 'GET');
    assert.equal(new URL(url).searchParams.get('customer_id'), 'eq.same-customer');
    assert.equal(new URL(url).searchParams.get('request_id'), `eq.${requestId}`);
    return response([reservation]);
  });
  assert.deepEqual(await services.reserve({ ...booking, lineUserId: 'verified-user' }), reservation);
});
test('database overlap and unique conflicts cannot expose another customer reservation', async () => {
  for (const code of ['23P01', '23505']) {
    const services = createServices(config, async (url, options) => {
      if (new URL(url).pathname.endsWith('/customers')) return response([{ id: 'own-customer' }]);
      if (options.method === 'GET') { assert.equal(new URL(url).searchParams.get('customer_id'), 'eq.own-customer'); return response([]); }
      return new Response(JSON.stringify({ code, message: 'sensitive raw database error' }), { status: 409 });
    });
    await assert.rejects(services.reserve({ ...booking, lineUserId: 'verified-user' }), error => error.status === 409 && !error.message.includes('sensitive'));
  }
});
