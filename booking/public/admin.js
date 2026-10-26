import { createSettingsPanel } from './settings.js';
import { createAutoRefresh } from './auto-refresh.js';
import { createAdminCalendar } from './admin-calendar.js';
import { api, message, dateText, timeText, yen, today, node } from './common.js';
const $ = selector => document.querySelector(selector);
let version = 0;
let authVersion = 0;
let cancelling = false;
let cancelTarget = null;
let moveTarget = null;
let slotVersion = 0;
let moveMenu = null;
const settingsPanel = createSettingsPanel(error => { show(false); message(error.message, true); });
let loadingCount = 0;
const protectedInput = () => cancelling || Boolean(cancelTarget || moveTarget) || !$('#settings-panel').hidden;
const calendar = createAdminCalendar({
  onSelect(date) { if (!cancelling && !$('#dashboard').hidden) { $('#date').value = date; load(); $('#count').scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
  onUnauthorized(error) { show(false); message(error.message, true); },
});
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
  calendar.setBusy(cancelling);
  for (const element of document.querySelectorAll('.cancel-reservation, .reschedule-reservation, .date-toolbar button, #date')) element.disabled = cancelling;
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
    authVersion++; version++; closeConfirmation(); closeReschedule(); settingsPanel.reset(); calendar.reset();
    $('#reservation-list').replaceChildren(); $('#count').textContent = '';
    $('#admin-last-updated').textContent = '';
  }
}
async function load(options = {}) {
  const background = options.background === true;
  const request = ++version;
  loadingCount++;
  if (!background) calendar.syncDate($('#date').value, true);
  if (!background) { $('#reservation-list').replaceChildren(); $('#count').textContent = '予約を読み込んでいます…'; }
  try {
    const { reservations } = await api(`/api/admin/reservations?${new URLSearchParams({ date: $('#date').value })}`);
    if (request !== version || (background && protectedInput())) return false;
    $('#reservation-list').replaceChildren();
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
        const change = node('button', '予約日時を変更', 'reschedule-reservation');
        change.type = 'button'; change.disabled = cancelling;
        change.addEventListener('click', () => openReschedule(reservation));
        card.append(change, button);
      }
      $('#reservation-list').append(card);
    }
    $('#admin-last-updated').textContent = `予約一覧の最終更新：${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}（日本時間・30秒ごとに自動更新）`;
    return true;
  } catch (error) {
    if (request !== version) return;
    if (error.status === 401 || error.status === 403) { show(false); message(error.message, true); return false; }
    if (background && protectedInput()) return false;
    $('#reservation-list').replaceChildren();
    $('#count').textContent = '取得できませんでした。';
    $('#admin-last-updated').textContent = '更新に失敗しました。最新情報は未確認です。';
    message(error.message, true);
    return false;
  } finally { loadingCount--; }
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
setInterval(() => { if (!document.hidden && !$('#dashboard').hidden) checkSession(); }, 60000);
const autoRefresh = createAutoRefresh({
  canRefresh: () => !document.hidden && !$('#dashboard').hidden && !protectedInput() && loadingCount === 0,
  refresh: async () => {
    if (await load({ background: true }) && !protectedInput() && !$('#dashboard').hidden) await calendar.refresh();
  },
});
let resumeSession = false;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    resumeSession = !$('#dashboard').hidden;
    if (resumeSession) {
      version++; authVersion++;
      $('#dashboard').hidden = true;
      $('#reservation-list').replaceChildren();
      calendar.suspend();
      for (const dialog of document.querySelectorAll('dialog')) dialog.style.visibility = 'hidden';
    }
    $('#password').value = '';
  } else if (resumeSession) {
    resumeSession = false;
    if (await checkSession()) {
      show(true);
      for (const dialog of document.querySelectorAll('dialog')) dialog.style.visibility = '';
      autoRefresh.tick().catch(() => {});
    } else {
      for (const dialog of document.querySelectorAll('dialog')) dialog.style.visibility = '';
    }
  }
});

// 日時変更も、更新日時による競合検出と管理者セッションを利用する。
function closeReschedule() {
  slotVersion++;
  moveTarget = null; moveMenu = null;
  $('#reschedule-dialog').close();
  $('#reschedule-original').replaceChildren();
  $('#reschedule-preview').replaceChildren();
  $('#reschedule-time').replaceChildren();
  $('#reschedule-message').textContent = '';
}
function moveControls() {
  $('#reschedule-date').disabled = cancelling;
  $('#reschedule-time').disabled = cancelling || !moveMenu;
  $('#reschedule-back').disabled = cancelling;
  $('#reschedule-confirm').disabled = cancelling || !moveTarget || !moveMenu || !$('#reschedule-time').value;
  $('#reschedule-confirm').textContent = cancelling ? '変更処理中…' : '変更を確定';
}
function previewMove() {
  const startsAt = $('#reschedule-time').value;
  $('#reschedule-preview').replaceChildren();
  if (startsAt && moveMenu) {
    const endsAt = new Date(Date.parse(startsAt) + moveMenu.duration_minutes * 60000).toISOString();
    $('#reschedule-preview').append(
      node('p', `変更後：${dateText(startsAt)} 〜 ${timeText(endsAt)}`),
      node('p', `${moveMenu.name} · ${moveMenu.duration_minutes}分 · ${yen(moveMenu.price_yen)}`),
    );
  }
  moveControls();
}
async function loadMoveSlots() {
  const target = moveTarget;
  const request = ++slotVersion;
  const operationAuth = authVersion;
  moveMenu = null;
  $('#reschedule-time').replaceChildren(node('option', '読み込み中…'));
  $('#reschedule-preview').replaceChildren();
  $('#reschedule-message').textContent = '';
  moveControls();
  if (!target) return;
  try {
    const result = await api(`/api/admin/reservations/${target.id}/reschedule-slots?${new URLSearchParams({ date: $('#reschedule-date').value })}`);
    if (request !== slotVersion || operationAuth !== authVersion || !moveTarget) return;
    moveMenu = result.menu;
    const placeholder = node('option', result.slots.length ? '時間を選択してください' : '空き時間がありません');
    placeholder.value = '';
    $('#reschedule-time').replaceChildren(placeholder);
    for (const startsAt of result.slots) {
      if (startsAt === target.starts_at) continue;
      const option = node('option', timeText(startsAt)); option.value = startsAt;
      $('#reschedule-time').append(option);
    }
    if ($('#reschedule-time').options.length === 1) placeholder.textContent = '変更できる空き時間がありません';
    moveControls();
  } catch (error) {
    if (request !== slotVersion || operationAuth !== authVersion || !moveTarget) return;
    $('#reschedule-time').replaceChildren();
    if (error.status === 401 || error.status === 403) { show(false); message(error.message, true); }
    else $('#reschedule-message').textContent = error.message;
    moveControls();
  }
}
function openReschedule(reservation) {
  if (cancelling || $('#dashboard').hidden) return;
  moveTarget = { ...reservation };
  $('#reschedule-original').replaceChildren(
    node('p', `お客様：${reservation.customers?.display_name || 'お客様'}`),
    node('p', `変更前：${dateText(reservation.starts_at)} 〜 ${timeText(reservation.ends_at)}`),
    node('p', `${reservation.menu_name} · ${yen(reservation.price_yen)}`),
  );
  $('#reschedule-date').min = today();
  $('#reschedule-date').value = new Date(Date.parse(reservation.starts_at) + 9 * 3600000).toISOString().slice(0, 10);
  $('#reschedule-dialog').showModal();
  loadMoveSlots();
}
$('#reschedule-date').addEventListener('change', loadMoveSlots);
$('#reschedule-time').addEventListener('change', previewMove);
$('#reschedule-back').addEventListener('click', () => { if (!cancelling) closeReschedule(); });
$('#reschedule-dialog').addEventListener('cancel', event => {
  if (cancelling) event.preventDefault(); else closeReschedule();
});
$('#reschedule-confirm').addEventListener('click', async () => {
  if (cancelling || !moveTarget || !moveMenu || !$('#reschedule-time').value || $('#dashboard').hidden) return;
  const target = moveTarget;
  const startsAt = $('#reschedule-time').value;
  const operationAuth = authVersion;
  cancelling = true; slotVersion++; moveControls(); cancellationControls(); message('');
  $('#reschedule-message').textContent = '変更結果を確認しています。画面を閉じずにお待ちください。';
  try {
    const { reservation } = await api(`/api/admin/reservations/${target.id}/reschedule`, { updatedAt: target.updated_at, startsAt });
    if (operationAuth !== authVersion || $('#dashboard').hidden) return;
    if (reservation?.status !== 'confirmed' || Date.parse(reservation.starts_at) !== Date.parse(startsAt)) throw new Error('変更結果を確認できませんでした。');
    closeReschedule();
    $('#date').value = new Date(Date.parse(startsAt) + 9 * 3600000).toISOString().slice(0, 10);
    const loaded = await load();
    if (operationAuth === authVersion && !$('#dashboard').hidden) message(loaded ? '予約日時を変更しました。' : '変更は完了しました。一覧を再読み込みしてください。', !loaded);
  } catch (error) {
    if (operationAuth !== authVersion || $('#dashboard').hidden) return;
    closeReschedule();
    if (error.status === 401 || error.status === 403) { show(false); message(error.message, true); return; }
    await load();
    if (operationAuth === authVersion && !$('#dashboard').hidden) message(
      error.status === 409 || error.status === 400 || error.status === 404 ? error.message : '変更結果が不明です。再操作の前に、変更前と変更先の日付の一覧を確認してください。', true);
  } finally { cancelling = false; moveControls(); cancellationControls(); }
});
