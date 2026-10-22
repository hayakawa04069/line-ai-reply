import { api, message, timeText, yen, today, node } from './common.js';
const $ = selector => document.querySelector(selector);
let version = 0;
function show(loggedIn) {
  $('#login-panel').hidden = loggedIn; $('#dashboard').hidden = !loggedIn;
  if (!loggedIn) { version++; $('#reservation-list').replaceChildren(); $('#count').textContent = ''; }
}
async function load() {
  const request = ++version;
  $('#reservation-list').replaceChildren(); $('#count').textContent = '予約を読み込んでいます…';
  try {
    const { reservations } = await api(`/api/admin/reservations?${new URLSearchParams({ date: $('#date').value })}`);
    if (request !== version) return;
    $('#count').textContent = `${$('#date').value.replaceAll('-', '/')} · ${reservations.length}件`;
    if (!reservations.length) $('#reservation-list').append(node('p', 'この日の予約はありません。', 'empty'));
    for (const reservation of reservations) {
      const card = node('article', undefined, 'reservation-card');
      const status = { confirmed: '確定', cancelled: 'キャンセル', completed: '来店済み' }[reservation.status] || '確認中';
      const heading = node('div', undefined, 'section-heading');
      heading.append(node('strong', `${timeText(reservation.starts_at)} – ${timeText(reservation.ends_at)}`), node('span', status, `badge ${reservation.status}`));
      card.append(heading, node('h3', reservation.customers?.display_name || 'お客様'), node('p', `${reservation.menu_name} · ${yen(reservation.price_yen)}`), node('p', `予約番号：${reservation.id}`, 'muted'));
      $('#reservation-list').append(card);
    }
  } catch (error) {
    if (request !== version) return;
    $('#count').textContent = '取得できませんでした。';
    if (error.status === 401 || error.status === 403) show(false);
    message(error.message, true);
  }
}
$('#date').value = today();
$('#date').addEventListener('change', load);
$('#refresh').addEventListener('click', load);
for (const [id, direction] of [['previous-day', -1], ['next-day', 1]]) {
  $(`#${id}`).addEventListener('click', () => { const date = new Date(`${$('#date').value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + direction); $('#date').value = date.toISOString().slice(0, 10); load(); });
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login').disabled = true; message('');
  try { await api('/api/admin/login', { email: $('#email').value, password: $('#password').value }); $('#password').value = ''; show(true); await load(); }
  catch (error) { $('#password').value = ''; message(error.message, true); }
  finally { $('#login').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', {}); show(false); message('ログアウトしました。'); }
  catch (error) { show(false); message(error.message, true); }
});
api('/api/admin/session').then(() => { show(true); load(); }).catch(error => { show(false); if (error.status !== 401) message(error.message, true); });
// 戻る操作で予約情報が表示され続けないよう、ページ復帰時に再確認する。
window.addEventListener('pageshow', event => { if (event.persisted) { show(false); window.location.reload(); } });
// 開いたままの画面でも期限切れ・権限取り消しを確認し、予約情報を消去する。
async function checkSession() {
  try { await api('/api/admin/session'); return true; }
  catch (error) { show(false); message(error.message, true); return false; }
}
setInterval(() => { if (!$('#dashboard').hidden) checkSession(); }, 60000);
let resumeSession = false;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    resumeSession = !$('#dashboard').hidden;
    if (resumeSession) show(false);
    $('#password').value = '';
  } else if (resumeSession) {
    resumeSession = false;
    if (await checkSession()) { show(true); load(); }
  }
});
