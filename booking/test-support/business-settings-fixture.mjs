// 営業設定の画面テスト用。すべてのSupabase通信をメモリ内で模擬。
import { createBookingServer } from '../server.js';
import { createServices } from '../lib.js';
const mode = process.argv[2] || 'success';
const config = { origin: 'http://localhost', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
let current = { revision: '10000000-0000-4000-8000-000000000001', slotMinutes: 15,
  hours: [1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opens_at: '10:00', closes_at: '18:00' })), closedDays: [] };
let allowed = true, writes = 0;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const services = createServices(config, async (url, options) => {
  const u = new URL(url);
  if (u.hostname !== 'fixture.invalid') throw new Error('External request forbidden');
  const resource = u.pathname.split('/').at(-1);
  if (resource === 'token') return json({ access_token: 'fake-jwt', expires_in: 3600 });
  if (resource === 'is_booking_admin') return json(allowed);
  if (resource === 'reservations') return json([]);
  if (resource === 'get_business_settings') {
    if (mode === 'missing-sql') return json({ code: 'PGRST202' }, 404);
    if (mode === 'revoked') allowed = false;
    return json(current);
  }
  if (resource === 'save_business_settings') {
    writes++;
    await new Promise(resolve => setTimeout(resolve, 250));
    if (mode === 'conflict') return json({ code: 'P2002' }, 400);
    if (mode === 'stale') return json({ code: 'P2001' }, 400);
    if (mode === 'failure') throw new Error('Simulated connection failure');
    const data = JSON.parse(options.body);
    current = { revision: '20000000-0000-4000-8000-000000000001', slotMinutes: data.p_slot_minutes,
      hours: data.p_hours, closedDays: data.p_closed_days };
    if (mode === 'lost-response') throw new Error('Simulated response lost after commit');
    return json(current);
  }
  throw new Error('Unexpected resource');
});
const server = createBookingServer(config, services);
server.listen(0, '127.0.0.1', () => {
  config.origin = `http://127.0.0.1:${server.address().port}`;
  console.log(config.origin);
});
process.on('SIGTERM', () => {
  console.log(`Mock settings save calls: ${writes}`);
  server.close(() => process.exit(0));
});
