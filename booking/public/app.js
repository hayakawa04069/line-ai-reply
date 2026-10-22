import { api, message, dateText, timeText, yen, today, node } from './common.js';
const $ = selector => document.querySelector(selector);
let menus = [], store, menuId, selectedDate, startsAt, requestId, lineReady = false, busy = false, slotVersion = 0;
let month = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
function chosen() { return menus.find(menu => menu.id === menuId); }
function updateSummary() {
  const menu = chosen();
  $('#selection').textContent = menu && startsAt ? `${menu.name} / ${dateText(startsAt)} / ${menu.duration_minutes}分 / ${yen(menu.price_yen)}` : 'メニューと日時を選ぶと、ここに表示されます。';
  $('#reserve').disabled = busy || !lineReady || !menu || !startsAt;
}
function calendar() {
  const current = today();
  const last = new Date(`${current}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + store.booking_window_days);
  const lastDate = last.toISOString().slice(0, 10);
  const year = month.getUTCFullYear(), monthNumber = month.getUTCMonth();
  $('#month-label').textContent = `${year}年${monthNumber + 1}月`;
  $('#prev-month').disabled = month.toISOString().slice(0, 7) <= current.slice(0, 7) || busy;
  $('#next-month').disabled = month.toISOString().slice(0, 7) >= lastDate.slice(0, 7) || busy;
  const grid = $('#calendar'); grid.replaceChildren();
  for (let i = 0; i < month.getUTCDay(); i++) grid.append(node('span'));
  const days = new Date(Date.UTC(year, monthNumber + 1, 0)).getUTCDate();
  for (let day = 1; day <= days; day++) {
    const date = `${year}-${String(monthNumber + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const button = node('button', String(day), date === selectedDate ? 'selected' : '');
    button.type = 'button'; button.disabled = date < current || date > lastDate || busy;
    button.setAttribute('aria-label', `${year}年${monthNumber + 1}月${day}日`);
    button.setAttribute('aria-pressed', String(date === selectedDate));
    button.addEventListener('click', () => { selectedDate = date; calendar(); loadSlots(); }); grid.append(button);
  }
}
function menuCards() {
  const container = $('#menus'); container.replaceChildren();
  if (!menus.length) return container.append(node('p', '現在予約できるメニューがありません。店舗へお問い合わせください。'));
  for (const menu of menus) {
    const button = node('button', undefined, `menu-card${menu.id === menuId ? ' selected' : ''}`);
    button.type = 'button'; button.disabled = busy; button.setAttribute('aria-pressed', String(menu.id === menuId));
    button.append(node('strong', menu.name), node('span', `${menu.duration_minutes}分 · ${yen(menu.price_yen)}`));
    button.addEventListener('click', () => { menuId = menu.id; menuCards(); loadSlots(); }); container.append(button);
  }
}
async function loadSlots() {
  const version = ++slotVersion;
  startsAt = null; requestId = null; updateSummary();
  $('#slots').replaceChildren();
  if (!menuId || !selectedDate) return $('#slots').append(node('p', 'メニューと日付を選んでください。', 'muted'));
  $('#slots-label').textContent = `${selectedDate.replaceAll('-', '/')} の空き時間`;
  $('#slots').append(node('p', '空き状況を確認しています…', 'muted'));
  try {
    const { slots } = await api(`/api/slots?${new URLSearchParams({ date: selectedDate, menu_id: menuId })}`);
    if (version !== slotVersion) return;
    $('#slots').replaceChildren();
    if (!slots.length) $('#slots').append(node('p', 'この日の空き枠はありません。別の日をお選びください。', 'muted'));
    for (const slot of slots) {
      const button = node('button', timeText(slot)); button.type = 'button';
      button.addEventListener('click', () => {
        if (busy) return;
        startsAt = slot; requestId = crypto.randomUUID();
        for (const element of $('#slots').querySelectorAll('button')) { element.classList.remove('selected'); element.setAttribute('aria-pressed', 'false'); }
        button.classList.add('selected'); button.setAttribute('aria-pressed', 'true'); updateSummary();
      });
      button.setAttribute('aria-pressed', 'false'); $('#slots').append(button);
    }
  } catch (error) { if (version === slotVersion) { $('#slots').replaceChildren(node('p', '空き状況を取得できませんでした。日付を選び直してください。')); message(error.message, true); } }
}
$('#prev-month').addEventListener('click', () => { month.setUTCMonth(month.getUTCMonth() - 1); calendar(); });
$('#next-month').addEventListener('click', () => { month.setUTCMonth(month.getUTCMonth() + 1); calendar(); });
$('#line-login').addEventListener('click', () => { if (window.liff && !liff.isLoggedIn()) liff.login({ redirectUri: window.location.origin + '/' }); });
$('#reservation-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !lineReady || !startsAt || !requestId) return;
  busy = true; updateSummary(); menuCards(); calendar();
  for (const button of $('#slots').querySelectorAll('button')) button.disabled = true;
  $('#reserve').textContent = '予約を確認しています…'; message('');
  try {
    const { reservation } = await api('/api/reservations', {
      idToken: liff.getIDToken(), displayName: $('#display-name').value,
      menuId, startsAt, requestId,
    });
    const details = $('#completed-details'); details.replaceChildren();
    details.append(node('p', reservation.menu_name), node('p', `${dateText(reservation.starts_at)} 〜 ${timeText(reservation.ends_at)}`), node('p', yen(reservation.price_yen)), node('p', `予約番号：${reservation.id}`, 'muted'));
    if (reservation.status !== 'confirmed') details.append(node('p', `予約状態：${reservation.status === 'cancelled' ? 'キャンセル済み' : '来店済み'}`));
    $('#booking-flow').hidden = true; $('#completion').hidden = false; $('#completion').focus();
  } catch (error) {
    message(error.message, true);
    if (error.status === 409 || error.status === 400) await loadSlots();
    if (error.status === 401) { lineReady = false; $('#line-login').hidden = false; $('#line-login').textContent = 'LINEにログインし直す'; $('#line-login').onclick = () => { liff.logout(); liff.login({ redirectUri: window.location.origin + '/' }); }; }
  } finally {
    busy = false; updateSummary(); menuCards(); calendar();
    for (const button of $('#slots').querySelectorAll('button')) button.disabled = false;
    $('#reserve').textContent = 'この内容で予約を確定する';
  }
});
$('#new-reservation').addEventListener('click', () => { $('#completion').hidden = true; $('#booking-flow').hidden = false; loadSlots(); });
async function init() {
  try {
    const catalog = await api('/api/catalog'); menus = catalog.menus; store = catalog.store;
    $('#store-name').textContent = store.store_name;
    menuId = menus[0]?.id; selectedDate = today(); menuCards(); calendar(); loadSlots();
  } catch (error) { $('#menus').replaceChildren(node('p', 'メニューを取得できませんでした。再読み込みしてください。')); message(error.message, true); return; }
  try {
    const { liffId } = await api('/api/config');
    if (!window.liff) throw new Error('LINEの接続を読み込めませんでした。ページを開き直してください。');
    await liff.init({ liffId });
    lineReady = liff.isLoggedIn() && !!liff.getIDToken();
    $('#line-login').disabled = false; $('#line-login').hidden = lineReady;
    $('#line-login').textContent = 'LINEでログインして予約する'; updateSummary();
  } catch (error) { $('#line-login').textContent = 'LINE接続を確認できませんでした'; message(error.message, true); }
}
init();
