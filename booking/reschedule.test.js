import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, AppError, japanDate } from './lib.js';
import { createBookingServer } from './server.js';

const id = '10000000-0000-4000-8000-000000000001';
const menuId = '20000000-0000-4000-8000-000000000001';
const stamp = '2030-01-01T00:00:00.123456+00:00';
const newer = '2030-01-01T00:01:00.654321+00:00';
const starts = '2030-01-03T02:00:00.000Z';
const config = { origin: 'http://localhost:3001', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const moved = { id, status: 'confirmed', starts_at: starts, updated_at: newer };

test('reschedule uses admin JWT, version and status conditions, and changes only start time', async () => {
  const service = createServices(config, async (url, options) => {
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.apikey, config.anonKey);
    assert.equal(options.headers.Authorization, 'Bearer admin-jwt');
    assert.deepEqual(JSON.parse(options.body), { starts_at: starts });
    const q = new URL(url).searchParams;
    assert.equal(q.get('id'), `eq.${id}`);
    assert.equal(q.get('status'), 'eq.confirmed');
    assert.equal(q.get('updated_at'), `eq.${stamp}`);
    return json([moved]);
  });
  assert.deepEqual(await service.rescheduleReservation(id, stamp, starts, 'admin-jwt'), moved);
});

test('reschedule rejects missing JWT, invalid version, ID and noncanonical date without DB access', async () => {
  const service = createServices(config, () => assert.fail('Unexpected DB access'));
  await assert.rejects(service.rescheduleReservation(id, stamp, starts, ''), e => e.status === 401);
  for (const args of [['bad', stamp, starts], [id, 'bad', starts], [id, stamp, '2030-01-03T11:00:00+09:00'], [id, stamp, '2030-02-30T02:00:00.000Z']]) {
    await assert.rejects(service.rescheduleReservation(...args, 'jwt'), e => e.status === 400);
  }
});

test('reschedule handles stale versions, cancelled/completed rows and hidden rows without overwrite', async () => {
  for (const row of [{ status: 'confirmed' }, { status: 'cancelled' }, { status: 'completed' }, null]) {
    let writes = 0;
    const service = createServices(config, async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer jwt');
      if (options.method === 'PATCH') { writes++; return json([]); }
      return json(row ? [{ id, ...row }] : []);
    });
    await assert.rejects(service.rescheduleReservation(id, stamp, starts, 'jwt'), e => e.status === (row ? 409 : 404));
    assert.equal(writes, 1);
  }
});

test('DB overlap, business-rule and permission errors never leak DB data', async () => {
  for (const [code, status] of [['23P01', 409], ['23514', 400], ['42501', 503]]) {
    const service = createServices(config, async () => json({ code, message: 'private details' }, 400));
    await assert.rejects(service.rescheduleReservation(id, stamp, starts, 'jwt'), e => e.status === status && !e.message.includes('private'));
  }
});

test('concurrent reschedule requests using one version permit only one change', async () => {
  let row = { id, status: 'confirmed', updated_at: stamp };
  let writes = 0;
  const service = createServices(config, async (url, options) => {
    await Promise.resolve();
    if (options.method !== 'PATCH') return json([row]);
    if (new URL(url).searchParams.get('updated_at') !== `eq.${row.updated_at}`) return json([]);
    writes++;
    row = { ...moved, starts_at: JSON.parse(options.body).starts_at };
    return json([row]);
  });
  const results = await Promise.allSettled([
    service.rescheduleReservation(id, stamp, starts, 'jwt'),
    service.rescheduleReservation(id, stamp, '2030-01-03T03:00:00.000Z', 'jwt'),
  ]);
  assert.equal(writes, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
});

test('lost response and retry do not move a reservation twice', async () => {
  let writes = 0;
  const service = createServices(config, async (url, options) => {
    if (options.method !== 'PATCH') return json([moved]);
    if (!writes) { writes++; throw new Error('Lost response after commit'); }
    return json([]);
  });
  await assert.rejects(service.rescheduleReservation(id, stamp, starts, 'jwt'), e => e.status === 503);
  await assert.rejects(service.rescheduleReservation(id, stamp, starts, 'jwt'), e => e.status === 409);
  assert.equal(writes, 1);
});

test('admin slots exclude only the target reservation and use JWT on every DB read', async () => {
  const day = japanDate(new Date(Date.now() + 86400000));
  let calls = 0;
  const service = createServices(config, async (url, options) => {
    calls++;
    assert.equal(options.headers.apikey, config.anonKey);
    assert.equal(options.headers.Authorization, 'Bearer jwt');
    const u = new URL(url);
    if (u.pathname.endsWith('/reservations')) {
      if (u.searchParams.get('id') === `eq.${id}`) return json([{ id, menu_id: menuId, status: 'confirmed' }]);
      assert.equal(u.searchParams.get('id'), `neq.${id}`);
      assert.equal(u.searchParams.get('status'), 'neq.cancelled');
      return json([{ starts_at: `${day}T11:00:00+09:00`, ends_at: `${day}T12:00:00+09:00` }]);
    }
    if (u.pathname.endsWith('/menus')) return json([{ id: menuId, name: 'Test menu', duration_minutes: 60, price_yen: 3000 }]);
    if (u.pathname.endsWith('/booking_settings')) return json([{ slot_minutes: 30, booking_window_days: 60 }]);
    if (u.pathname.endsWith('/business_hours')) return json([{ opens_at: '10:00:00', closes_at: '13:00:00' }]);
    if (u.pathname.endsWith('/closed_days')) return json([]);
    assert.fail('Unexpected path');
  });
  const result = await service.rescheduleSlots(id, day, 'jwt');
  assert.equal(result.slots.includes(new Date(`${day}T10:00:00+09:00`).toISOString()), true);
  assert.equal(result.slots.includes(new Date(`${day}T11:00:00+09:00`).toISOString()), false);
  assert.equal(result.menu.price_yen, 3000);
  assert.equal(calls, 6);
});

test('admin slots refuse invalid requests, hidden and cancelled reservations', async () => {
  const noDb = createServices(config, () => assert.fail('Unexpected DB access'));
  await assert.rejects(noDb.rescheduleSlots(id, '2030-01-01', ''), e => e.status === 401);
  await assert.rejects(noDb.rescheduleSlots('bad', '2030-01-01', 'jwt'), e => e.status === 400);
  await assert.rejects(noDb.rescheduleSlots(id, 'bad', 'jwt'), e => e.status === 400);
  for (const [data, status] of [[[], 404], [[{ status: 'cancelled' }], 409], [[{ status: 'completed' }], 409]]) {
    const service = createServices(config, async () => json(data));
    await assert.rejects(service.rescheduleSlots(id, '2030-01-01', 'jwt'), e => e.status === status);
  }
});

async function app(t, overrides = {}) {
  const server = createBookingServer(config, {
    login: async () => ({ token: 'jwt', expiresIn: 3600 }),
    isAdmin: async () => true,
    rescheduleReservation: async () => moved,
    rescheduleSlots: async () => ({ slots: [starts], menu: { id: menuId } }),
    ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, data, cookie, origin = config.origin) => fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const login = async () => (await send('/api/admin/login', { email: 'fake@example.invalid', password: 'fake' })).headers.get('set-cookie');
  return { send, login };
}
const path = `/api/admin/reservations/${id}/reschedule`;
const slotsPath = `/api/admin/reservations/${id}/reschedule-slots?date=2030-01-03`;
const data = { updatedAt: stamp, startsAt: starts };

test('reschedule endpoints authenticate and forward only expected fields with JWT', async t => {
  let received;
  const { send, login } = await app(t, { rescheduleReservation: async (...args) => { received = args; return moved; } });
  const cookie = await login();
  const response = await send(path, data, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(received, [id, stamp, starts, 'jwt']);
  assert.equal((await send(slotsPath, undefined, cookie)).status, 200);
});

test('unauthenticated and revoked admins cannot access either reschedule endpoint', async t => {
  let allowed = true;
  const { send, login } = await app(t, {
    isAdmin: async () => allowed,
    rescheduleReservation: () => assert.fail('Must not update'),
    rescheduleSlots: () => assert.fail('Must not read'),
  });
  assert.equal((await send(path, data)).status, 401);
  assert.equal((await send(slotsPath)).status, 401);
  const cookie = await login(); allowed = false;
  assert.equal((await send(path, data, cookie)).status, 403);
  assert.equal((await send(slotsPath, undefined, cookie)).status, 401);
});

test('reschedule rejects CSRF, invalid starts, versions, IDs and extra fields', async t => {
  const { send, login } = await app(t, { rescheduleReservation: () => assert.fail('Must not update') });
  const cookie = await login();
  assert.equal((await send(path, data, cookie, 'https://evil.invalid')).status, 403);
  for (const body of [{}, { ...data, updatedAt: 'bad' }, { ...data, startsAt: 'bad' }, { ...data, status: 'cancelled' }]) {
    assert.equal((await send(path, body, cookie)).status, 400);
  }
  assert.equal((await send('/api/admin/reservations/bad/reschedule', data, cookie)).status, 400);
  assert.equal((await send(slotsPath.replace('2030-01-03', 'bad'), undefined, cookie)).status, 400);
});

test('reschedule endpoint preserves conflict, business rule and missing errors', async t => {
  for (const status of [400, 404, 409, 503]) {
    const { send, login } = await app(t, { rescheduleReservation: async () => { throw new AppError(status, 'Safe message'); } });
    assert.equal((await send(path, data, await login())).status, status);
  }
});

test('moving a reservation frees the original slot, occupies the new slot and preserves its identity', async () => {
  const day = japanDate(new Date(Date.now() + 86400000));
  const original = new Date(`${day}T10:00:00+09:00`).toISOString();
  const destination = new Date(`${day}T12:00:00+09:00`).toISOString();
  let row = { id, customer_id: 'unchanged-customer', request_id: 'unchanged-request', status: 'confirmed', starts_at: original,
    ends_at: new Date(Date.parse(original) + 3600000).toISOString(), updated_at: stamp };
  const service = createServices(config, async (url, options) => {
    const table = new URL(url).pathname.split('/').at(-1);
    if (table === 'booking_settings') return json([{ slot_minutes: 30, booking_window_days: 60 }]);
    if (table === 'menus') return json([{ duration_minutes: 60 }]);
    if (table === 'business_hours') return json([{ opens_at: '10:00:00', closes_at: '14:00:00' }]);
    if (table === 'closed_days') return json([]);
    if (options.method === 'PATCH') {
      row = { ...row, starts_at: JSON.parse(options.body).starts_at, updated_at: newer };
      row.ends_at = new Date(Date.parse(row.starts_at) + 3600000).toISOString();
    }
    return json([row]);
  });
  const before = await service.slots(day, menuId);
  assert.equal(before.includes(original), false);
  assert.equal(before.includes(destination), true);
  await service.rescheduleReservation(id, stamp, destination, 'jwt');
  const after = await service.slots(day, menuId);
  assert.equal(after.includes(original), true);
  assert.equal(after.includes(destination), false);
  assert.equal(row.id, id);
  assert.equal(row.customer_id, 'unchanged-customer');
  assert.equal(row.request_id, 'unchanged-request');
});

test('cancellation and rescheduling of one version cannot both overwrite the reservation', async () => {
  for (const moveFirst of [true, false]) {
    let row = { id, status: 'confirmed', updated_at: stamp };
    let writes = 0;
    const service = createServices(config, async (url, options) => {
      await Promise.resolve();
      if (options.method !== 'PATCH') return json([row]);
      if (row.status !== 'confirmed' || new URL(url).searchParams.get('updated_at') !== `eq.${row.updated_at}`) return json([]);
      writes++;
      row = { ...row, ...JSON.parse(options.body), updated_at: newer };
      return json([row]);
    });
    const move = () => service.rescheduleReservation(id, stamp, starts, 'jwt');
    const cancel = () => service.cancelReservation(id, stamp, 'jwt');
    const results = await Promise.allSettled(moveFirst ? [move(), cancel()] : [cancel(), move()]);
    assert.equal(writes, 1);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal(row.status, moveFirst ? 'confirmed' : 'cancelled');
  }
});

test('expired admin session cannot fetch slots or reschedule', async t => {
  const { send, login } = await app(t, {
    login: async () => ({ token: 'jwt', expiresIn: -1 }),
    rescheduleReservation: () => assert.fail('Must not update'),
    rescheduleSlots: () => assert.fail('Must not read'),
  });
  const cookie = await login();
  assert.equal((await send(path, data, cookie)).status, 401);
  assert.equal((await send(slotsPath, undefined, cookie)).status, 401);
});
