import { api, message, dateText, timeText, yen, today, node } from './common.js';
const $ = selector => document.querySelector(selector);
let version = 0;
let authVersion = 0;
let cancelling = false;
let cancelTarget = null;
function closeConfirmation() {
  $('#cancel-dialog').close();
  cancelTarget = null;
  $('#cancel-details').replaceChildren();
}
function cancellationControls() {
  $('#cancel-confirm').disabled = cancelling || !cancelTarget;
  $('#cancel-back').disabled = cancelling;
  $('#cancel-confirm').textContent = cancelling ? 'キャンセル処理中…' : 'キャンセルを確定';
  $('#cancel-progress').textContent = cancelling ? '予約の状態を確認しています。画面を閉じずにお待ちください。' : '';
  for (const element of document.querySelectorAll('.cancel-reservation, .date-toolbar button, #date')) element.disabled = cancelling;
}
function openConfirmation(reservation) {
  if (cancelling || $('#dashboard').hidden) return;
  cancelTarget = { id: reservation.id, updatedAt: reservation.updated_at };
  $('#cancel-details').replaceChildren(
    node('p', `お客様：${reservation.customers?.display_name || 'お客様'}`),
    node('p', `メニュー：${reservation.menu_name}`),
    node('p', `${dateText(reservation.starts_at)} 〜 ${timeText(reservation.ends_at)}`),
  );
  cancellationControls();
  $('#cancel-dialog').showModal();
}
function show(loggedIn) {
  $('#login-panel').hidden = loggedIn; $('#dashboard').hidden = !loggedIn;
  if (!loggedIn) {
    authVersion++; version++; closeConfirmation();
    $('#reservation-list').replaceChildren(); $('#count').textContent = '';
  }
}
async function load() {
  const request = ++version;
  $('#reservation-list').replaceChildren(); $('#count').textContent = '予約を読み込んでいます…';
  try {
    const { reservations } = await api(`/api/admin/reservations?${new URLSearchParams({ date: $('#date').value })}`);
    if (request !== version) return false;
    $('#count').textContent = `${$('#date').value.replaceAll('-', '/')} · ${reservations.length}件`;
    if (!reservations.length) $('#reservation-list').append(node('p', 'この日の予約はありません。', 'empty'));
    for (const reservation of reservations) {
      const card = node('article', undefined, 'reservation-card');
      const status = { confirmed: '確定', cancelled: 'キャンセル済み', completed: '来店済み' }[reservation.status] || '確認中';
      const heading = node('div', undefined, 'section-heading');
      heading.append(node('strong', `${timeText(reservation.starts_at)} – ${timeText(reservation.ends_at)}`), node('span', status, `badge ${reservation.status}`));
      card.append(heading, node('h3', reservation.customers?.display_name || 'お客様'), node('p', `${reservation.menu_name} · ${yen(reservation.price_yen)}`), node('p', `予約番号：${reservation.id}`, 'muted'));
      if (reservation.status === 'confirmed' && reservation.updated_at) {
        const button = node('button', '予約をキャンセル', 'cancel-reservation');
        button.type = 'button'; button.disabled = cancelling;
        button.addEventListener('click', () => openConfirmation(reservation));
        card.append(button);
      }
      $('#reservation-list').append(card);
    }
    return true;
  } catch (error) {
    if (request !== version) return;
    $('#count').textContent = '取得できませんでした。';
    if (error.status === 401 || error.status === 403) show(false);
    message(error.message, true);
    return false;
  }
}
$('#cancel-back').addEventListener('click', () => { if (!cancelling) closeConfirmation(); });
$('#cancel-dialog').addEventListener('cancel', event => {
  if (cancelling) event.preventDefault();
  else closeConfirmation();
});
$('#cancel-confirm').addEventListener('click', async () => {
  if (cancelling || !cancelTarget || $('#dashboard').hidden) return;
  const target = cancelTarget;
  const operationAuth = authVersion;
  cancelling = true; cancellationControls(); message('');
  try {
    const { reservation } = await api(`/api/admin/reservations/${target.id}/cancel`, { updatedAt: target.updatedAt });
    if (operationAuth !== authVersion || $('#dashboard').hidden) return;
    if (reservation?.status !== 'cancelled') throw new Error('キャンセル結果を確認できませんでした。');
    closeConfirmation();
    const loaded = await load();
    if (operationAuth === authVersion && !$('#dashboard').hidden) {
      message(loaded ? '予約をキャンセルしました。' : 'キャンセルは完了しました。一覧を取得できないため、再読み込みしてください。', !loaded);
    }
  } catch (error) {
    if (operationAuth !== authVersion || $('#dashboard').hidden) return;
    closeConfirmation();
    if (error.status === 401 || error.status === 403) { show(false); message(error.message, true); return; }
    // 通信が途切れてもDBだけ更新済みの可能性があるため、先に一覧を再取得する。
    const loaded = await load();
    if (operationAuth === authVersion && !$('#dashboard').hidden) {
      const text = error.status === 409 || error.status === 404 || error.status === 400
        ? error.message
        : 'キャンセル結果を確認できませんでした。更新後の一覧で状態を確認してください。';
      message(loaded ? text : `${text} 一覧も取得できないため、再読み込みしてください。`, true);
    }
  } finally { cancelling = false; cancellationControls(); }
});
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
