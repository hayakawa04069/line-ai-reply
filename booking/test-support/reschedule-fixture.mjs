// 日時変更の画面テスト専用。ネットワーク呼出しをすべて模擬する。
import { createBookingServer } from '../server.js';
import { createServices } from '../lib.js';
const mode = process.argv[2] || 'success';
const id = '10000000-0000-4000-8000-000000000001';
const menuId = '20000000-0000-4000-8000-000000000001';
const stamp = '2030-01-01T00:00:00.123456+00:00';
const row = { id, menu_id: menuId, status: 'confirmed', updated_at: stamp,
  starts_at: '2030-01-07T01:00:00.000Z', ends_at: '2030-01-07T02:00:00.000Z',
  menu_name: 'テストメニュー', price_yen: 3000, customers: { display_name: '架空 <img src=x>' } };
const config = { origin: 'http://localhost', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
let patchCalls = 0;
let allowed = true;
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const services = createServices(config, async (url, options) => {
  const u = new URL(url), q = u.searchParams;
  if (u.hostname !== 'fixture.invalid') throw new Error('External request forbidden');
  const table = u.pathname.split('/').at(-1);
  if (table === 'token') return response({ access_token: 'fake-jwt', expires_in: 3600 });
  if (table === 'is_booking_admin') return response(allowed);
  if (table === 'booking_settings') return response([{ slot_minutes: 30, booking_window_days: 3650 }]);
  if (table === 'menus') return response([{ id: menuId, name: 'テストメニュー', duration_minutes: 60, price_yen: 3000 }]);
  if (table === 'business_hours') {
    if (mode === 'revoked' && q.get('weekday') === 'eq.2') allowed = false;
    return response([{ opens_at: '10:00:00', closes_at: '15:00:00' }]);
  }
  if (table === 'closed_days') return response([]);
  if (table !== 'reservations') throw new Error('Unexpected resource');
  if (options.method === 'PATCH') {
    patchCalls++;
    await new Promise(resolve => setTimeout(resolve, 250));
    if (mode === 'failure') throw new Error('Simulated failure');
    if (mode === 'overlap') return response({ code: '23P01' }, 409);
    if (mode === 'conflict') row.updated_at = '2030-01-01T00:00:01.654321+00:00';
    if (q.get('updated_at') !== `eq.${row.updated_at}` || row.status !== 'confirmed') return response([]);
    row.starts_at = JSON.parse(options.body).starts_at;
    row.ends_at = new Date(Date.parse(row.starts_at) + 3600000).toISOString();
    row.updated_at = '2030-01-01T00:00:02.654321+00:00';
    if (mode === 'lost-response') throw new Error('Simulated response loss after update');
    return response([row]);
  }
  if (options.method !== 'GET') throw new Error('Unexpected mutation');
  if (q.get('id') === `eq.${id}`) {
    return response([row]);
  }
  if (q.get('id') === `neq.${id}`) return response([]);
  const start = q.get('starts_at');
  if (start?.startsWith('gte.')) {
    const lower = Date.parse(start.slice(4));
    if (Date.parse(row.starts_at) < lower || Date.parse(row.starts_at) >= lower + 86400000) return response([]);
  }
  return response([row]);
});
const server = createBookingServer(config, services);
server.listen(0, '127.0.0.1', () => {
  config.origin = `http://127.0.0.1:${server.address().port}`;
  console.log(config.origin);
});
process.on('SIGTERM', () => {
  console.log(`Mock PATCH calls: ${patchCalls}`);
  server.close(() => process.exit(0));
});
