import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, validateBusinessSettings, AppError } from './lib.js';
import { createBookingServer } from './server.js';

const revision = '10000000-0000-4000-8000-000000000001';
const config = { origin: 'http://localhost:3001', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
const data = () => ({ revision, slotMinutes: 15, hours: [{ weekday: 1, opens_at: '10:00', closes_at: '18:00' }], closedDays: [{ date: '2030-01-02', reason: '' }] });
const json = value => new Response(JSON.stringify(value));

test('business settings accept closed weekdays, empty closure lists and approved schedule', () => {
  assert.equal(validateBusinessSettings(data()).slotMinutes, 15);
  assert.deepEqual(validateBusinessSettings({ ...data(), hours: [], closedDays: [] }).hours, []);
  for (const slotMinutes of [5, 10, 15, 20, 30, 60]) validateBusinessSettings({ ...data(), slotMinutes });
});

test('business settings reject unknown fields, invalid revisions and invalid intervals', () => {
  for (const value of [null, [], {}, { ...data(), extra: true }, { ...data(), revision: 'bad' }, { ...data(), slotMinutes: 17 }, { ...data(), slotMinutes: '15' }]) {
    assert.throws(() => validateBusinessSettings(value), e => e.status === 400);
  }
});

test('business settings reject overlapping weekday definitions, malformed times and overnight hours', () => {
  for (const hours of [
    [{ weekday: 7, opens_at: '10:00', closes_at: '18:00' }],
    [{ weekday: 1, opens_at: '18:00', closes_at: '10:00' }],
    [{ weekday: 1, opens_at: '10:00', closes_at: '10:00' }],
    [{ weekday: 1, opens_at: '10:00:01', closes_at: '18:00' }],
    [{ weekday: 1, opens_at: '10:00', closes_at: '24:00' }],
    [data().hours[0], data().hours[0]], [null],
    [{ ...data().hours[0], unexpected: true }],
  ]) assert.throws(() => validateBusinessSettings({ ...data(), hours }), e => e.status === 400);
});

test('business settings reject duplicate and nonexistent closure dates and excessive reasons', () => {
  for (const closedDays of [
    [{ date: '2030-02-30', reason: '' }],
    [{ date: '2030-01-01', reason: 'x'.repeat(201) }],
    [data().closedDays[0], data().closedDays[0]],
    [{ date: '2030-01-01', reason: null }], [null],
    Array(101).fill(data().closedDays[0]),
  ]) assert.throws(() => validateBusinessSettings({ ...data(), closedDays }), e => e.status === 400);
});

test('business settings retrieval uses admin JWT and no server key', async () => {
  const service = createServices(config, async (url, options) => {
    assert.equal(new URL(url).pathname, '/rest/v1/rpc/get_business_settings');
    assert.equal(options.headers.apikey, 'fake-anon');
    assert.equal(options.headers.Authorization, 'Bearer jwt');
    assert.equal(options.method, 'GET');
    return json(data());
  });
  assert.deepEqual(await service.businessSettings('jwt'), data());
});

test('settings save uses one transactional RPC, expected revision and administrator JWT', async () => {
  let calls = 0;
  const service = createServices(config, async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/rest/v1/rpc/save_business_settings');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.apikey, 'fake-anon');
    assert.equal(options.headers.Authorization, 'Bearer jwt');
    assert.deepEqual(JSON.parse(options.body), { p_revision: revision, p_slot_minutes: 15, p_hours: data().hours, p_closed_days: data().closedDays });
    return json({ ...data(), revision: '20000000-0000-4000-8000-000000000001' });
  });
  const result = await service.saveBusinessSettings(data(), 'jwt');
  assert.notEqual(result.revision, revision);
  assert.equal(calls, 1);
});

test('missing admin token or invalid settings never access the database', async () => {
  const service = createServices(config, () => assert.fail('Unexpected DB access'));
  await assert.rejects(service.businessSettings(''), e => e.status === 401);
  await assert.rejects(service.saveBusinessSettings(data(), ''), e => e.status === 401);
  await assert.rejects(service.saveBusinessSettings({}, 'jwt'), e => e.status === 400);
});

test('settings conflicts and missing migrations return safe actionable messages', async () => {
  for (const [code, status] of [['P2001', 409], ['P2002', 409], ['PGRST202', 503], ['23514', 400], ['22008', 400], ['22P02', 400], ['42501', 503]]) {
    const service = createServices(config, async () => new Response(JSON.stringify({ code, message: 'private SQL details' }), { status: 400 }));
    await assert.rejects(service.saveBusinessSettings(data(), 'jwt'), e => e.status === status && !e.message.includes('private'));
  }
});

test('ambiguous settings save failure does not retry or write individual tables', async () => {
  let calls = 0;
  const service = createServices(config, async () => { calls++; throw new Error('Lost response'); });
  await assert.rejects(service.saveBusinessSettings(data(), 'jwt'), e => e.status === 503);
  assert.equal(calls, 1);
});

async function app(t, overrides = {}) {
  const server = createBookingServer(config, {
    login: async () => ({ token: 'jwt', expiresIn: 3600 }), isAdmin: async () => true,
    businessSettings: async () => data(), saveBusinessSettings: async value => value,
    ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, cookie, origin = config.origin, path = '/api/admin/business-settings') => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async () => (await send({ email: 'fake@example.invalid', password: 'fake' }, undefined, config.origin, '/api/admin/login')).headers.get('set-cookie');
  return { send, login };
}

test('settings endpoints pass the administrator token and validated payload', async t => {
  const calls = [];
  const { send, login } = await app(t, {
    businessSettings: async token => { calls.push(token); return data(); },
    saveBusinessSettings: async (value, token) => { calls.push(token); assert.deepEqual(value, data()); return value; },
  });
  const cookie = await login();
  assert.equal((await send(undefined, cookie)).status, 200);
  assert.equal((await send(data(), cookie)).status, 200);
  assert.deepEqual(calls, ['jwt', 'jwt']);
});

test('unauthenticated, revoked and expired users cannot read or save settings', async t => {
  let allowed = true;
  const denied = { businessSettings: () => assert.fail('Must not read'), saveBusinessSettings: () => assert.fail('Must not save') };
  const { send, login } = await app(t, { ...denied, isAdmin: async () => allowed });
  assert.equal((await send()).status, 401);
  assert.equal((await send(data())).status, 401);
  const cookie = await login(); allowed = false;
  assert.equal((await send(data(), cookie)).status, 403);
  assert.equal((await send(undefined, cookie)).status, 401);
  const expired = await app(t, { ...denied, login: async () => ({ token: 'jwt', expiresIn: -1 }) });
  assert.equal((await expired.send(data(), await expired.login())).status, 401);
});

test('settings endpoint rejects cross-origin saves and malformed payloads before writes', async t => {
  const { send, login } = await app(t, { saveBusinessSettings: () => assert.fail('Must not save') });
  const cookie = await login();
  assert.equal((await send(data(), cookie, 'https://evil.invalid')).status, 403);
  assert.equal((await send({}, cookie)).status, 400);
  assert.equal((await send({ ...data(), customer_id: revision }, cookie)).status, 400);
});

test('settings errors preserve conflict and migration status without leaking internal exceptions', async t => {
  for (const status of [400, 409, 503]) {
    const { send, login } = await app(t, { saveBusinessSettings: async () => { throw new AppError(status, 'Safe message'); } });
    const r = await send(data(), await login());
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error: 'Safe message' });
  }
});

test('settings body limit allows 100 valid Japanese closure reasons without raising other API limits', async t => {
  const { send, login } = await app(t);
  const closedDays = Array.from({ length: 100 }, (_, i) => ({
    date: new Date(Date.UTC(2030, 0, i + 1)).toISOString().slice(0, 10), reason: '休'.repeat(200),
  }));
  const response = await send({ ...data(), closedDays }, await login());
  assert.equal(response.status, 200);
});

test('customer slots use newly saved opening hours, interval and closure settings', async () => {
  const day = new Date(Date.now() + 86400000);
  const date = new Date(day.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  let current = { ...data(), hours: [{ weekday, opens_at: '10:00', closes_at: '13:00' }], closedDays: [] };
  const service = createServices(config, async (url, options) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    if (resource === 'save_business_settings') {
      const p = JSON.parse(options.body);
      current = { revision, slotMinutes: p.p_slot_minutes, hours: p.p_hours, closedDays: p.p_closed_days };
      return json(current);
    }
    if (resource === 'booking_settings') return json([{ slot_minutes: current.slotMinutes, booking_window_days: 60 }]);
    if (resource === 'business_hours') return json(current.hours);
    if (resource === 'closed_days') return json(current.closedDays);
    if (resource === 'menus') return json([{ duration_minutes: 60 }]);
    if (resource === 'reservations') return json([]);
    assert.fail('Unexpected DB request');
  });
  const start = time => new Date(`${date}T${time}:00+09:00`).toISOString();
  assert.equal((await service.slots(date, revision)).includes(start('10:15')), true);
  await service.saveBusinessSettings({ ...current, slotMinutes: 30, hours: [{ weekday, opens_at: '11:00', closes_at: '13:00' }] }, 'jwt');
  const changed = await service.slots(date, revision);
  assert.equal(changed.includes(start('10:15')), false);
  assert.equal(changed.includes(start('11:00')), true);
  assert.equal(changed.includes(start('11:15')), false);
  await service.saveBusinessSettings({ ...current, closedDays: [{ date, reason: 'Fixture closure' }] }, 'jwt');
  assert.deepEqual(await service.slots(date, revision), []);
});
