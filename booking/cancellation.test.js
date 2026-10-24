import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, createServices, japanDate } from './lib.js';
import { createBookingServer } from './server.js';

const id = '10000000-0000-4000-8000-000000000001';
const stamp = '2030-01-01T00:00:00.123456+00:00';
const newer = '2030-01-01T00:00:01.654321+00:00';
const config = { origin: 'http://localhost:3001', supabaseUrl: 'https://test.supabase.co', anonKey: 'test-anon', serviceKey: 'test-server-key' };
const json = data => new Response(JSON.stringify(data));
const cancelled = { id, status: 'cancelled', updated_at: newer };

test('cancellation PATCH uses admin JWT, atomic conditions, original timestamp precision and status only', async () => {
  const services = createServices(config, async (url, options) => {
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.Authorization, 'Bearer admin-jwt');
    assert.equal(options.headers.apikey, config.anonKey);
    assert.equal(options.headers.Prefer, 'return=representation');
    assert.deepEqual(JSON.parse(options.body), { status: 'cancelled' });
    const query = new URL(url).searchParams;
    assert.equal(query.get('id'), `eq.${id}`);
    assert.equal(query.get('status'), 'eq.confirmed');
    assert.equal(query.get('updated_at'), `eq.${stamp}`);
    assert.equal(query.get('select'), 'id,status,updated_at');
    return json([cancelled]);
  });
  assert.deepEqual(await services.cancelReservation(id, stamp, 'admin-jwt'), cancelled);
});

test('cancellation without JWT or with invalid parameters never calls the database', async () => {
  const services = createServices(config, () => assert.fail('Must not access database'));
  await assert.rejects(services.cancelReservation(id, stamp, ''), error => error.status === 401);
  await assert.rejects(services.cancelReservation('invalid', stamp, 'jwt'), error => error.status === 400);
  await assert.rejects(services.cancelReservation(id, 'invalid', 'jwt'), error => error.status === 400);
});

test('already cancelled reservation is returned without another state change', async () => {
  const calls = [];
  const services = createServices(config, async (url, options) => {
    calls.push(options.method);
    assert.equal(options.headers.Authorization, 'Bearer admin-jwt');
    return json(options.method === 'PATCH' ? [] : [cancelled]);
  });
  assert.deepEqual(await services.cancelReservation(id, stamp, 'admin-jwt'), cancelled);
  assert.deepEqual(calls, ['PATCH', 'GET']);
});

test('changed, completed, missing and RLS-hidden reservations are not cancelled', async () => {
  for (const [current, status] of [
    [[{ id, status: 'confirmed', updated_at: newer }], 409],
    [[{ id, status: 'completed', updated_at: newer }], 409], [[], 404],
  ]) {
    const services = createServices(config, async (url, options) => json(options.method === 'PATCH' ? [] : current));
    await assert.rejects(services.cancelReservation(id, stamp, 'jwt'), error => error.status === status);
  }
});

test('simultaneous admin requests converge to one cancellation', async () => {
  let row = { id, status: 'confirmed', updated_at: stamp };
  let changes = 0;
  const services = createServices(config, async (url, options) => {
    await Promise.resolve();
    const query = new URL(url).searchParams;
    if (options.method === 'PATCH') {
      if (row.status !== 'confirmed' || query.get('updated_at') !== `eq.${row.updated_at}`) return json([]);
      row = { ...cancelled }; changes++;
      return json([row]);
    }
    return json([row]);
  });
  const result = await Promise.all([services.cancelReservation(id, stamp, 'admin-1'), services.cancelReservation(id, stamp, 'admin-2')]);
  assert.equal(changes, 1);
  assert.deepEqual(result, [cancelled, cancelled]);
});

test('retry after a lost response does not cancel twice', async () => {
  let changed = false;
  let changes = 0;
  const services = createServices(config, async (url, options) => {
    if (options.method === 'PATCH') {
      if (!changed) { changed = true; changes++; throw new Error('Simulated lost response'); }
      return json([]);
    }
    return json([cancelled]);
  });
  await assert.rejects(services.cancelReservation(id, stamp, 'jwt'), error => error.status === 503);
  assert.deepEqual(await services.cancelReservation(id, stamp, 'jwt'), cancelled);
  assert.equal(changes, 1);
});

test('mock DB permission and network errors do not leak database details', async () => {
  for (const status of [401, 403, 500]) {
    const services = createServices(config, async () => new Response(JSON.stringify({ code: '42501', message: 'private database details' }), { status }));
    await assert.rejects(services.cancelReservation(id, stamp, 'jwt'), error => error.status === 503 && !error.message.includes('private'));
  }
});

test('cancelled slot becomes available through the existing slots service', async () => {
  const date = new Date(`${japanDate()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
  const day = date.toISOString().slice(0, 10);
  const starts = new Date(`${day}T10:00:00+09:00`).toISOString();
  let row = { id, starts_at: starts, ends_at: new Date(Date.parse(starts) + 3600000).toISOString(), status: 'confirmed', updated_at: stamp };
  const services = createServices(config, async (url, options) => {
    const path = new URL(url).pathname;
    const query = new URL(url).searchParams;
    if (path.endsWith('/booking_settings')) return json([{ slot_minutes: 30, booking_window_days: 60 }]);
    if (path.endsWith('/menus')) return json([{ duration_minutes: 60 }]);
    if (path.endsWith('/business_hours')) return json([{ opens_at: '10:00:00', closes_at: '12:00:00' }]);
    if (path.endsWith('/closed_days')) return json([]);
    if (options.method === 'PATCH') { row = { ...row, status: 'cancelled', updated_at: newer }; return json([row]); }
    assert.equal(query.get('status'), 'neq.cancelled');
    return json(row.status === 'cancelled' ? [] : [row]);
  });
  assert.equal((await services.slots(day, id)).includes(starts), false);
  await services.cancelReservation(id, stamp, 'jwt');
  assert.equal((await services.slots(day, id)).includes(starts), true);
  assert.equal(row.id, id, 'Reservation record must be retained');
});

async function app(t, overrides = {}) {
  const services = {
    login: async () => ({ token: 'admin-jwt', expiresIn: 3600 }), isAdmin: async () => true,
    cancelReservation: async () => cancelled, ...overrides,
  };
  const server = createBookingServer(config, services);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, data, cookie, origin = config.origin) => fetch(base + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data),
  });
  const login = async () => (await send('/api/admin/login', { email: 'test@example.invalid', password: 'test-only' })).headers.get('set-cookie');
  return { send, login };
}
const path = `/api/admin/reservations/${id}/cancel`;

test('cancellation endpoint verifies admin and passes only expected parameters', async t => {
  let received;
  const { send, login } = await app(t, { cancelReservation: async (...args) => { received = args; return cancelled; } });
  const response = await send(path, { updatedAt: stamp }, await login());
  assert.equal(response.status, 200);
  assert.deepEqual(received, [id, stamp, 'admin-jwt']);
  assert.deepEqual(await response.json(), { reservation: cancelled });
});

test('unauthenticated, revoked and expired admins cannot cancel', async t => {
  let allowed = true;
  const { send, login } = await app(t, { isAdmin: async () => allowed, cancelReservation: () => assert.fail('Must not cancel') });
  assert.equal((await send(path, { updatedAt: stamp })).status, 401);
  const cookie = await login(); allowed = false;
  assert.equal((await send(path, { updatedAt: stamp }, cookie)).status, 403);
  const expired = await app(t, { login: async () => ({ token: 'jwt', expiresIn: -1 }), cancelReservation: () => assert.fail('Must not cancel') });
  assert.equal((await expired.send(path, { updatedAt: stamp }, await expired.login())).status, 401);
});

test('cancellation rejects cross-origin requests, invalid IDs, missing versions and extra fields', async t => {
  const { send, login } = await app(t, { cancelReservation: () => assert.fail('Must not cancel') });
  const cookie = await login();
  assert.equal((await send(path, { updatedAt: stamp }, cookie, 'https://evil.example')).status, 403);
  assert.equal((await send('/api/admin/reservations/bad/cancel', { updatedAt: stamp }, cookie)).status, 400);
  for (const data of [{}, { updatedAt: 'bad' }, { updatedAt: stamp, status: 'completed' }, { updatedAt: stamp, customer_id: id }]) {
    assert.equal((await send(path, data, cookie)).status, 400);
  }
});

test('cancellation endpoint preserves conflict and not-found errors', async t => {
  for (const status of [404, 409, 503]) {
    const { send, login } = await app(t, { cancelReservation: async () => { throw new AppError(status, 'テスト用エラー'); } });
    const response = await send(path, { updatedAt: stamp }, await login());
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: 'テスト用エラー' });
  }
});
