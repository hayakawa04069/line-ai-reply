// ローカル画面テスト専用。実際のSupabase・LINEには接続しない。
import { createBookingServer } from '../server.js';
import { createServices } from '../lib.js';

const id = '10000000-0000-4000-8000-000000000001';
const stamp = '2030-01-01T00:00:00.123456+00:00';
const config = { origin: 'http://localhost', supabaseUrl: 'https://fixture.invalid', anonKey: 'fixture-anon', serviceKey: 'fixture-server-only' };
const mode = process.argv[2] || 'success';
const row = { id, status: 'confirmed', updated_at: stamp, menu_name: 'テストメニュー', price_yen: 3000,
  starts_at: '2030-01-07T01:00:00.000Z', ends_at: '2030-01-07T02:00:00.000Z', customers: { display_name: '架空のお客様 <img src=x>' } };
const rows = [row,
  { ...row, id: '10000000-0000-4000-8000-000000000002', status: 'cancelled' },
  { ...row, id: '10000000-0000-4000-8000-000000000003', status: 'completed' },
];
let patchCalls = 0;
let adminChecks = 0;
const response = data => new Response(JSON.stringify(data));
const services = createServices(config, async (url, options) => {
  const parsed = new URL(url);
  if (parsed.hostname !== 'fixture.invalid') throw new Error('External request forbidden');
  if (parsed.pathname === '/auth/v1/token') return response({ access_token: 'fixture-jwt', expires_in: 3600 });
  if (parsed.pathname === '/rest/v1/rpc/is_booking_admin') return response(!(mode === 'revoked' && ++adminChecks >= 3));
  if (parsed.pathname !== '/rest/v1/reservations') throw new Error('Unexpected test resource');
  if (options.method === 'PATCH') {
    patchCalls++;
    await new Promise(resolve => setTimeout(resolve, 250));
    if (mode === 'conflict') row.updated_at = '2030-01-01T00:00:01.654321+00:00';
    if (mode === 'failure') throw new Error('Simulated connection failure');
    if (row.status !== 'confirmed' || parsed.searchParams.get('updated_at') !== `eq.${row.updated_at}`) return response([]);
    row.status = 'cancelled'; row.updated_at = '2030-01-01T00:00:02.000001+00:00';
    if (mode === 'lost-response') throw new Error('Simulated response lost after update');
    return response([{ id: row.id, status: row.status, updated_at: row.updated_at }]);
  }
  if (options.method !== 'GET') throw new Error('Unexpected mutation');
  if (parsed.searchParams.has('id')) return response(rows.filter(item => `eq.${item.id}` === parsed.searchParams.get('id')));
  return response(rows);
});
const server = createBookingServer(config, services);
server.listen(0, '127.0.0.1', () => {
  // 同じ設定オブジェクトを参照するため、Origin検証用に起動後のポートを反映。
  config.origin = `http://127.0.0.1:${server.address().port}`;
  console.log(config.origin);
});
process.on('SIGTERM', () => { console.log(`Mock PATCH calls: ${patchCalls}`); server.close(() => process.exit(0)); });
