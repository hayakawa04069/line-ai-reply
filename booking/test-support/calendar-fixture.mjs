// 月間カレンダーの画面テスト専用。実際の外部通信は行わない。
import { createBookingServer } from '../server.js';
import { createServices, monthRange, japanDate } from '../lib.js';
const mode = process.argv[2] || 'success';
const config = { origin: 'http://localhost', supabaseUrl: 'https://fixture.invalid', anonKey: 'fake-anon', serviceKey: 'fake-service' };
const id = '10000000-0000-4000-8000-000000000001';
const stamp = '2030-01-01T00:00:00.123456+00:00';
const row = { id, menu_id: '20000000-0000-4000-8000-000000000001', starts_at: '2030-01-07T01:00:00.000Z', ends_at: '2030-01-07T02:00:00.000Z',
  status: 'confirmed', updated_at: stamp, menu_name: 'Fixture menu', duration_minutes: 60, price_yen: 3000, customers: { display_name: '架空 <img src=x>' } };
const rows = [row, { ...row, id: id.replace(/1$/, '2'), status: 'completed' }, { ...row, id: id.replace(/1$/, '3'), status: 'cancelled' }];
let allowed = true;
let calendarCalls = 0;
let writes = 0;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const services = createServices(config, async (url, options) => {
  const u = new URL(url), q = u.searchParams, resource = u.pathname.split('/').at(-1);
  if (u.hostname !== 'fixture.invalid') throw new Error('External request forbidden');
  if (resource === 'token') return json({ access_token: 'fake-jwt', expires_in: 3600 });
  if (resource === 'is_booking_admin') return json(allowed);
  if (resource === 'get_booking_month_counts') {
    calendarCalls++;
    const month = q.get('p_month').slice(0, 7);
    if (mode === 'missing-sql') return json({ code: 'PGRST202' }, 404);
    if (mode === 'failure') throw new Error('Simulated network failure');
    if (mode === 'slow-logout' || (mode === 'race' && month === '2030-01')) await new Promise(resolve => setTimeout(resolve, 450));
    const [start, end] = monthRange(month);
    const days = Array.from({ length: (Date.parse(end) - Date.parse(start)) / 86400000 }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`, confirmed: 0, completed: 0, cancelled: 0,
    }));
    for (const r of rows) {
      const day = days.find(day => day.date === japanDate(new Date(r.starts_at)));
      if (day) day[r.status]++;
    }
    if (mode === 'revoked') allowed = false;
    return json({ month, days });
  }
  if (resource === 'booking_settings') return json([{ slot_minutes: 30, booking_window_days: 3650 }]);
  if (resource === 'menus') return json([{ id: row.menu_id, name: row.menu_name, duration_minutes: 60, price_yen: 3000 }]);
  if (resource === 'business_hours') return json([{ opens_at: '10:00:00', closes_at: '18:00:00' }]);
  if (resource === 'closed_days') return json([]);
  if (resource !== 'reservations') throw new Error('Unexpected resource');
  if (options.method === 'PATCH') {
    if (q.get('updated_at') !== `eq.${row.updated_at}` || row.status !== 'confirmed') return json([]);
    const patch = JSON.parse(options.body);
    await new Promise(resolve => setTimeout(resolve, 250));
    Object.assign(row, patch, { updated_at: new Date(Date.parse('2030-01-01T00:00:00Z') + (++writes) * 1000).toISOString() });
    row.ends_at = new Date(Date.parse(row.starts_at) + 3600000).toISOString();
    return json([row]);
  }
  if (q.get('id') === `eq.${id}`) return json([row]);
  if (q.get('id') === `neq.${id}`) return json([]);
  const start = q.get('starts_at');
  if (start?.startsWith('gte.')) {
    const lower = Date.parse(start.slice(4));
    return json(rows.filter(r => Date.parse(r.starts_at) >= lower && Date.parse(r.starts_at) < lower + 86400000));
  }
  return json(rows);
});
const server = createBookingServer(config, services);
server.listen(0, '127.0.0.1', () => {
  config.origin = `http://127.0.0.1:${server.address().port}`;
  console.log(config.origin);
});
process.on('SIGTERM', () => { console.log(`Mock calendar calls: ${calendarCalls}`); server.close(() => process.exit(0)); });
