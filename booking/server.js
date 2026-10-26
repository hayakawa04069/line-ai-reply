import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AppError, createServices, dateRange, uuid, validTimestamp, validStart, validateBusinessSettings, monthRange } from './lib.js';

export function createBookingServer(config, services = createServices(config)) {
  const sessions = new Map();
  const limits = new Map();
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/admin', ['admin.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']], ['/admin.js', ['admin.js', 'text/javascript']],
    ['/common.js', ['common.js', 'text/javascript']],
    ['/settings.js', ['settings.js', 'text/javascript']],
    ['/auto-refresh.js', ['auto-refresh.js', 'text/javascript']],
    ['/admin-calendar.js', ['admin-calendar.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
  ]);
  const secure = config.origin.startsWith('https://');
  const cookieName = secure ? '__Host-booking_session' : 'booking_session';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function limit(key, max, milliseconds) {
    const now = Date.now();
    // 期限切れの個人情報・セッションをメモリから除く。
    for (const [key, session] of sessions) if (session.until <= now) sessions.delete(key);
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    const entry = limits.get(key) || { count: 0, until: now + milliseconds };
    if (++entry.count > max) throw new AppError(429, '操作が多すぎます。少し待ってお試しください。');
    limits.set(key, entry);
  }
  async function body(req, maxSize = 16384) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'JSON形式が必要です。');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxSize) throw new AppError(413, '送信内容が大きすぎます。');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new AppError(400, '送信内容を確認してください。'); }
  }
  async function admin(req) {
    const id = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const session = sessions.get(id);
    if (!session || session.until <= Date.now()) { sessions.delete(id); throw new AppError(401, '管理者ログインが必要です。'); }
    if (!await services.isAdmin(session.token)) { sessions.delete(id); throw new AppError(403, '店舗管理者の権限がありません。'); }
    return { ...session, id };
  }
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, config.origin);
      const path = url.pathname;
      if (req.method === 'POST' && req.headers.origin !== config.origin) throw new AppError(403, 'このページから操作し直してください。');
      limit(`ip:${req.socket.remoteAddress}`, 240, 60000);
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      if (req.method === 'GET' && path === '/health') return json(200, { ok: true });
      if (req.method === 'GET' && path === '/api/config') return json(200, { liffId: config.liffId });
      if (req.method === 'GET' && path === '/api/catalog') return json(200, await services.catalog());
      if (req.method === 'GET' && path === '/api/slots') {
        const menuId = url.searchParams.get('menu_id');
        if (!uuid(menuId)) throw new AppError(400, 'メニューを選択してください。');
        dateRange(url.searchParams.get('date'));
        return json(200, { slots: await services.slots(url.searchParams.get('date'), menuId) });
      }
      if (req.method === 'POST' && path === '/api/reservations') {
        const data = await body(req);
        if (!uuid(data.menuId) || !uuid(data.requestId) || typeof data.displayName !== 'string' || !data.displayName.trim() || data.displayName.trim().length > 100
          || typeof data.idToken !== 'string' || data.idToken.length < 10 || data.idToken.length > 10000
          || typeof data.startsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(data.startsAt) || !Number.isFinite(Date.parse(data.startsAt)) || new Date(data.startsAt).toISOString() !== data.startsAt) {
          throw new AppError(400, 'お名前・メニュー・日時を確認してください。');
        }
        const lineUserId = await services.verifyLine(data.idToken);
        limit(`line:${lineUserId}`, 10, 60000);
        const reservation = await services.reserve({ lineUserId, displayName: data.displayName.trim(), menuId: data.menuId, startsAt: data.startsAt, requestId: data.requestId });
        return json(200, { reservation });
      }
      if (req.method === 'POST' && path === '/api/admin/login') {
        limit(`login:${req.socket.remoteAddress}`, 10, 900000);
        const { email, password } = await body(req);
        if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || !password || password.length > 1024) throw new AppError(400, 'ログイン情報を確認してください。');
        const session = await services.login(email.trim(), password);
        if (!await services.isAdmin(session.token)) throw new AppError(403, '店舗管理者の権限がありません。');
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { token: session.token, until: Date.now() + session.expiresIn * 1000 });
        res.setHeader('Set-Cookie', cookie(id, session.expiresIn));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/admin/logout') {
        const session = await admin(req);
        sessions.delete(session.id);
        res.setHeader('Set-Cookie', cookie('', 0));
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/admin/session') { await admin(req); return json(200, { ok: true }); }
      if (req.method === 'GET' && path === '/api/admin/reservations') {
        const session = await admin(req);
        const date = url.searchParams.get('date'); dateRange(date);
        return json(200, { reservations: await services.reservations(date, session.token) });
      }
      if (path === '/api/admin/calendar' && req.method === 'GET') {
        const session = await admin(req);
        const month = url.searchParams.get('month'); monthRange(month);
        return json(200, await services.monthCounts(month, session.token));
      }
      if (path === '/api/admin/business-settings' && req.method === 'GET') {
        const session = await admin(req);
        return json(200, await services.businessSettings(session.token));
      }
      if (path === '/api/admin/business-settings' && req.method === 'POST') {
        const session = await admin(req);
        return json(200, await services.saveBusinessSettings(validateBusinessSettings(await body(req, 98304)), session.token));
      }
      const reschedule = path.match(/^\/api\/admin\/reservations\/([^/]+)\/(reschedule|reschedule-slots)$/);
      if (reschedule && req.method === 'GET' && reschedule[2] === 'reschedule-slots') {
        const session = await admin(req);
        if (!uuid(reschedule[1])) throw new AppError(400, '予約情報を確認してください。');
        const date = url.searchParams.get('date'); dateRange(date);
        return json(200, await services.rescheduleSlots(reschedule[1], date, session.token));
      }
      if (reschedule && req.method === 'POST' && reschedule[2] === 'reschedule') {
        const session = await admin(req);
        const data = await body(req);
        if (!uuid(reschedule[1]) || !validTimestamp(data.updatedAt) || !validStart(data.startsAt)
            || Object.keys(data).length !== 2) throw new AppError(400, '変更する日時を確認してください。');
        return json(200, { reservation: await services.rescheduleReservation(reschedule[1], data.updatedAt, data.startsAt, session.token) });
      }
      const cancellation = path.match(/^\/api\/admin\/reservations\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancellation) {
        const session = await admin(req);
        const data = await body(req);
        if (!uuid(cancellation[1]) || !validTimestamp(data.updatedAt) || Object.keys(data).length !== 1) {
          throw new AppError(400, '予約情報を読み込み直してください。');
        }
        const reservation = await services.cancelReservation(cancellation[1], data.updatedAt, session.token);
        return json(200, { reservation });
      }
      throw new AppError(404, 'ページが見つかりません。');
    } catch (error) {
      // エラー本文や受信データにキー・個人情報が含まれ得るためログには出さない。
      json(error instanceof AppError ? error.status : 503, { error: error instanceof AppError ? error.message : '処理できませんでした。時間をおいてお試しください。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'LINE_LOGIN_CHANNEL_ID', 'LIFF_ID', 'BOOKING_ORIGIN'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) { console.error(`予約アプリの設定が不足しています: ${missing.join(', ')}`); process.exit(1); }
  const origin = new URL(process.env.BOOKING_ORIGIN);
  const db = new URL(process.env.SUPABASE_URL);
  if (origin.origin !== process.env.BOOKING_ORIGIN || (!['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol !== 'https:') || db.protocol !== 'https:') {
    console.error('BOOKING_ORIGINは公開HTTPSのオリジン（ローカルのみHTTP可）、SUPABASE_URLはHTTPSを指定してください。'); process.exit(1);
  }
  const port = Number(process.env.BOOKING_PORT || 3001);
  createBookingServer({ supabaseUrl: db.origin, anonKey: process.env.SUPABASE_ANON_KEY, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    lineChannelId: process.env.LINE_LOGIN_CHANNEL_ID, liffId: process.env.LIFF_ID, origin: origin.origin,
  }).listen(port, '0.0.0.0', () => console.log(`予約アプリをポート${port}で起動しました。`));
}
