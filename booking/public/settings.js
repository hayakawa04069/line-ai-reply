import { api, node } from './common.js';
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const $ = selector => document.querySelector(selector);

export function createSettingsPanel(unauthorized) {
  let revision = null;
  let generation = 0;
  let busy = false;
  let loading = false;
  let pending = null;
  const notice = (text, error = false) => {
    const box = $('#settings-message');
    box.textContent = text; box.hidden = !text; box.classList.toggle('error', error);
  };
  function controls() {
    for (const element of $('#settings-panel').querySelectorAll('button,input,select')) element.disabled = busy || loading;
    $('#settings-review').disabled = busy || loading || !revision;
    $('#settings-add-day').disabled = busy || loading || !revision || $('#settings-closed').children.length >= 100;
    for (const row of $('#settings-hours').children) {
      for (const input of row.querySelectorAll('input[type=time]')) input.disabled = busy || loading || !row.querySelector('input[type=checkbox]').checked;
    }
    $('#settings-save').disabled = busy || !pending;
    $('#settings-back').disabled = busy;
    $('#settings-save').textContent = busy ? '保存処理中…' : '保存を確定';
  }
  function clearDialog() {
    pending = null;
    $('#settings-dialog').close();
    $('#settings-summary').replaceChildren();
    $('#settings-progress').textContent = '';
  }
  function reset() {
    generation++; revision = null; loading = false;
    $('#settings-panel').hidden = true;
    $('#settings-hours').replaceChildren(); $('#settings-closed').replaceChildren();
    $('#settings-slot').value = '15'; clearDialog(); notice('');
  }
  function addClosedDay(day = { date: '', reason: '' }) {
    if ($('#settings-closed').children.length >= 100) return;
    const row = node('div', undefined, 'closed-row');
    const dateLabel = node('label', '日付');
    const date = document.createElement('input'); date.type = 'date'; date.required = true; date.value = day.date;
    dateLabel.append(date);
    const reasonLabel = node('label', '理由（任意・200文字まで）');
    const reason = document.createElement('input'); reason.type = 'text'; reason.maxLength = 200; reason.value = day.reason;
    reasonLabel.append(reason);
    const remove = node('button', 'この休業日を削除', 'secondary'); remove.type = 'button';
    remove.addEventListener('click', () => { if (!busy) { row.remove(); controls(); } });
    row.append(dateLabel, reasonLabel, remove); $('#settings-closed').append(row); controls();
  }
  function render(data) {
    revision = data.revision;
    $('#settings-slot').value = String(data.slotMinutes);
    $('#settings-hours').replaceChildren(); $('#settings-closed').replaceChildren();
    weekdays.forEach((name, weekday) => {
      const h = data.hours.find(item => item.weekday === weekday);
      const row = node('div', undefined, 'hours-row'); row.dataset.weekday = weekday;
      const label = node('label');
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(h);
      label.append(enabled, document.createTextNode(` ${name}曜営業`));
      const openLabel = node('label', '開店'); const closeLabel = node('label', '閉店');
      const open = document.createElement('input'); open.type = 'time'; open.step = '60'; open.required = true; open.value = h?.opens_at || '10:00';
      const close = document.createElement('input'); close.type = 'time'; close.step = '60'; close.required = true; close.value = h?.closes_at || '18:00';
      openLabel.append(open); closeLabel.append(close); enabled.addEventListener('change', controls);
      row.append(label, openLabel, closeLabel); $('#settings-hours').append(row);
    });
    for (const day of data.closedDays) addClosedDay(day);
    if (data.closedDays.length > 100) { revision = null; notice('休業日が100件を超えているため、この画面から保存できません。', true); }
    controls();
  }
  async function load() {
    if (busy) return;
    const request = ++generation;
    revision = null; loading = true; clearDialog(); controls(); notice('読み込み中…');
    try {
      const data = await api('/api/admin/business-settings');
      if (request !== generation || $('#dashboard').hidden) return;
      render(data); if (data.closedDays.length <= 100) notice('');
    } catch (error) {
      if (request !== generation) return;
      if (error.status === 401 || error.status === 403) unauthorized(error);
      else notice(error.message, true);
    } finally { if (request === generation) { loading = false; controls(); } }
  }
  $('#open-settings').addEventListener('click', () => {
    if ($('#dashboard').hidden) return;
    $('#settings-panel').hidden = false; load();
    $('#settings-panel').scrollIntoView({ behavior: 'smooth' });
  });
  $('#settings-close').addEventListener('click', () => { if (!busy) reset(); });
  $('#settings-reload').addEventListener('click', load);
  $('#settings-add-day').addEventListener('click', () => { if (!busy && !loading && revision) addClosedDay(); });
  $('#settings-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || loading || !revision) return;
    const hours = [];
    for (const row of $('#settings-hours').children) {
      if (!row.querySelector('input[type=checkbox]').checked) continue;
      const [open, close] = row.querySelectorAll('input[type=time]');
      if (!open.value || !close.value || open.value >= close.value) { notice('開店時刻より後の閉店時刻を入力してください。', true); return; }
      hours.push({ weekday: Number(row.dataset.weekday), opens_at: open.value, closes_at: close.value });
    }
    const closedDays = [...$('#settings-closed').children].map(row => {
      const [date, reason] = row.querySelectorAll('input'); return { date: date.value, reason: reason.value };
    });
    if (new Set(closedDays.map(day => day.date)).size !== closedDays.length) { notice('同じ休業日が重複しています。', true); return; }
    pending = { revision, slotMinutes: Number($('#settings-slot').value), hours, closedDays };
    $('#settings-summary').replaceChildren(node('p', `予約開始の間隔：${pending.slotMinutes}分`));
    weekdays.forEach((name, weekday) => {
      const h = hours.find(item => item.weekday === weekday);
      $('#settings-summary').append(node('p', `${name}曜：${h ? `${h.opens_at}〜${h.closes_at}` : '定休日'}`));
    });
    $('#settings-summary').append(node('p', `臨時休業日：${closedDays.length}件`));
    for (const day of closedDays) $('#settings-summary').append(node('p', `${day.date} ${day.reason}`));
    controls(); $('#settings-dialog').showModal();
  });
  $('#settings-back').addEventListener('click', () => { if (!busy) clearDialog(); });
  $('#settings-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else clearDialog(); });
  $('#settings-save').addEventListener('click', async () => {
    if (busy || !pending || $('#dashboard').hidden) return;
    const payload = pending;
    const request = generation;
    busy = true; controls();
    $('#settings-progress').textContent = '保存結果を確認しています。画面を閉じずにお待ちください。';
    try {
      const result = await api('/api/admin/business-settings', payload);
      if (request !== generation || $('#dashboard').hidden) return;
      clearDialog(); render(result); notice('営業設定を保存しました。お客様画面は日付を選び直すと反映されます。');
    } catch (error) {
      if (request !== generation || $('#dashboard').hidden) return;
      clearDialog();
      if (error.status === 401 || error.status === 403) { unauthorized(error); return; }
      // 不明な応答の再送や、古い設定による上書きを防ぐ。
      revision = null;
      notice(`${error.message} 保存結果が不明な場合もあるため、保存済み設定を再読み込みしてから操作してください。`, true);
    } finally { busy = false; controls(); }
  });
  return { reset };
}
