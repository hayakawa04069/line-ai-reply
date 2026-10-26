export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// DBのupdated_atは小数点以下6桁の場合があるため、Dateへの変換で丸めずに使う。
export const validTimestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
export const validStart = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const japanDate = (now = new Date()) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function dateRange(date) {
  if (!validDate(date)) throw new AppError(400, '日付を選択してください。');
  const start = new Date(`${date}T00:00:00+09:00`);
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}
export function availableSlots({ date, menu, settings, hours, closed, reservations, now = new Date() }) {
  dateRange(date);
  const today = japanDate(now);
  const last = new Date(`${today}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + settings.booking_window_days);
  if (date < today || date > last.toISOString().slice(0, 10) || closed || !hours) return [];
  const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const midnight = Date.parse(`${date}T00:00:00+09:00`);
  const slots = [];
  for (let minute = minutes(hours.opens_at); minute + menu.duration_minutes <= minutes(hours.closes_at); minute += settings.slot_minutes) {
    const start = midnight + minute * 60000;
    const end = start + menu.duration_minutes * 60000;
    if (start <= now.getTime()) continue;
    if (reservations.some(row => Date.parse(row.starts_at) < end && Date.parse(row.ends_at) > start)) continue;
    slots.push(new Date(start).toISOString());
  }
  return slots;
}

export function createServices(config, fetchImpl = fetch) {
  const base = config.supabaseUrl.replace(/\/$/, '');
  async function request(url, options) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new AppError(503, '接続できませんでした。時間をおいてお試しください。'); }
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      if (data?.code === '23P01') throw new AppError(409, '先に予約が入りました。別の時間を選んでください。');
      if (data?.code === '23505') { const error = new AppError(409, '予約を確認できません。再読込してお試しください。'); error.duplicate = true; throw error; }
      if (data?.code === '23514') throw new AppError(400, 'この日時・メニューでは予約できません。空き時間を選び直してください。');
      throw new AppError(503, 'サービスとの接続に失敗しました。設定または接続状況を確認してください。');
    }
    return data;
  }
  async function db(path, { token, method = 'GET', body, prefer } = {}) {
    return request(`${base}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: token ? config.anonKey : config.serviceKey,
        Authorization: `Bearer ${token || config.serviceKey}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const query = (table, params) => `${table}?${new URLSearchParams(params)}`;
  async function settings() {
    const rows = await db('booking_settings?select=store_name,slot_minutes,booking_window_days&singleton=eq.true');
    if (!rows?.length) throw new AppError(503, '店舗の営業設定がまだ登録されていません。');
    return rows[0];
  }
  const summary = row => ({ id: row.id, menu_name: row.menu_name, starts_at: row.starts_at, ends_at: row.ends_at, price_yen: row.price_yen, status: row.status });
  async function slotsFor(date, menuId, token, excludeId) {
    const [start, end] = dateRange(date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const options = token ? { token } : {};
    const reservationQuery = { select: 'starts_at,ends_at', status: 'neq.cancelled', starts_at: `lt.${end}`, ends_at: `gt.${start}` };
    if (excludeId) reservationQuery.id = `neq.${excludeId}`;
    const [stores, menus, hours, closed, reservations] = await Promise.all([
      db('booking_settings?select=store_name,slot_minutes,booking_window_days&singleton=eq.true', options),
      db(query('menus', { select: 'id,name,duration_minutes,price_yen', id: `eq.${menuId}`, active: 'eq.true' }), options),
      db(query('business_hours', { select: 'opens_at,closes_at', weekday: `eq.${weekday}` }), options),
      db(query('closed_days', { select: 'closed_date', closed_date: `eq.${date}` }), options),
      db(query('reservations', reservationQuery), options),
    ]);
    if (!stores?.length) throw new AppError(503, '店舗の営業設定を確認してください。');
    if (!menus?.length) throw new AppError(400, 'このメニューは現在予約できません。');
    return { menu: menus[0], slots: availableSlots({ date, menu: menus[0], settings: stores[0], hours: hours[0], closed: closed.length > 0, reservations }) };
  }
  return {
    async catalog() {
      const [store, menus] = await Promise.all([settings(), db('menus?select=id,name,duration_minutes,price_yen&active=eq.true&order=name')]);
      return { store, menus };
    },
    async slots(date, menuId) {
      return (await slotsFor(date, menuId)).slots;
    },
    async rescheduleSlots(id, date, token) {
      if (!token) throw new AppError(401, '管理者ログインが必要です。');
      if (!uuid(id)) throw new AppError(400, '予約情報を確認してください。');
      dateRange(date);
      const rows = await db(query('reservations', { select: 'id,menu_id,status', id: `eq.${id}` }), { token });
      if (!rows.length) throw new AppError(404, '予約が見つかりません。');
      if (rows[0].status !== 'confirmed') throw new AppError(409, '確定済みの予約だけ日時変更できます。');
      return slotsFor(date, rows[0].menu_id, token, id);
    },
    async rescheduleReservation(id, updatedAt, startsAt, token) {
      if (!token) throw new AppError(401, '管理者ログインが必要です。');
      if (!uuid(id) || !validTimestamp(updatedAt) || !validStart(startsAt)) throw new AppError(400, '変更する日時を確認してください。');
      const rows = await db(query('reservations', {
        select: 'id,status,starts_at,ends_at,updated_at,menu_name,duration_minutes,price_yen',
        id: `eq.${id}`, status: 'eq.confirmed', updated_at: `eq.${updatedAt}`,
      }), { token, method: 'PATCH', body: { starts_at: startsAt }, prefer: 'return=representation' });
      if (rows.length) return rows[0];
      const current = await db(query('reservations', { select: 'id', id: `eq.${id}` }), { token });
      if (!current.length) throw new AppError(404, '予約が見つからないか、閲覧する権限がありません。');
      throw new AppError(409, '予約が変更されています。一覧を読み直して確認してください。');
    },
    async verifyLine(idToken) {
      const response = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: config.lineChannelId }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new AppError(401, 'LINEにログインし直してください。');
      const identity = await response.json();
      if (typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 128 || identity.iss !== 'https://access.line.me' || String(identity.aud) !== config.lineChannelId || !Number.isFinite(identity.exp) || identity.exp * 1000 <= Date.now()) {
        throw new AppError(401, 'LINEの本人確認に失敗しました。');
      }
      return identity.sub;
    },
    async reserve({ lineUserId, displayName, menuId, startsAt, requestId }) {
      // 顧客IDは検証済みLINEユーザーIDからサーバーで決定する。
      const customers = await db(query('customers', { on_conflict: 'line_user_id', select: 'id' }), {
        method: 'POST', body: { line_user_id: lineUserId, display_name: displayName },
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      const customerId = customers[0].id;
      const existing = () => db(query('reservations', { select: 'id,menu_name,starts_at,ends_at,price_yen,status', request_id: `eq.${requestId}`, customer_id: `eq.${customerId}` }));
      const previous = await existing();
      if (previous.length) return summary(previous[0]);
      try {
        const rows = await db('reservations?select=id,menu_name,starts_at,ends_at,price_yen,status', {
          method: 'POST', prefer: 'return=representation',
          body: { customer_id: customerId, menu_id: menuId, starts_at: startsAt, request_id: requestId },
        });
        return summary(rows[0]);
      } catch (error) {
        // 再送が競合した場合も、同じ本人のリクエストだけを再取得。
        if (error.duplicate || error.status === 409) {
          const rows = await existing();
          if (rows.length) return summary(rows[0]);
        }
        throw error;
      }
    },
    async login(email, password) {
      let data;
      try {
        data = await request(`${base}/auth/v1/token?grant_type=password`, {
          method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch { throw new AppError(401, 'メールアドレスまたはパスワードを確認してください。'); }
      return { token: data.access_token, expiresIn: Math.min(data.expires_in || 3600, 3600) };
    },
    async isAdmin(token) {
      try { return await db('rpc/is_booking_admin', { token, method: 'POST', body: {} }) === true; }
      catch { return false; }
    },
    async reservations(date, token) {
      const [start, end] = dateRange(date);
      // 利用者のJWTで取得し、DBのRLSも適用。電話番号とLINE IDは取得しない。
      return db(query('reservations', {
        select: 'id,menu_name,starts_at,ends_at,price_yen,status,updated_at,customers(display_name)',
        starts_at: `gte.${start}`, and: `(starts_at.lt.${end})`, order: 'starts_at',
      }), { token });
    },
    async cancelReservation(id, updatedAt, token) {
      // キャンセルでservice_roleにフォールバックしない。必ず本人のJWTを使用。
      if (typeof token !== 'string' || !token) throw new AppError(401, '管理者ログインが必要です。');
      if (!uuid(id) || !validTimestamp(updatedAt)) throw new AppError(400, '予約情報を読み込み直してください。');
      const select = 'id,status,updated_at';
      const rows = await db(query('reservations', {
        select, id: `eq.${id}`, status: 'eq.confirmed', updated_at: `eq.${updatedAt}`,
      }), { token, method: 'PATCH', body: { status: 'cancelled' }, prefer: 'return=representation' });
      if (rows.length) return rows[0];
      // 同時操作・応答喪失後の再送は、変更せず現在の状態を確認する。
      const current = await db(query('reservations', { select, id: `eq.${id}` }), { token });
      if (!current.length) throw new AppError(404, '予約が見つからないか、閲覧する権限がありません。');
      if (current[0].status === 'cancelled') return current[0];
      throw new AppError(409, '予約が変更されたか、来店済みです。一覧を読み込み直して確認してください。');
    },
  };
}
