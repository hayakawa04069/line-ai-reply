import { api, node, today } from './common.js';
const $ = selector => document.querySelector(selector);
const validMonth = month => typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1000 && Number(month.slice(0, 4)) <= 9998;

export function createAdminCalendar({ onSelect, onUnauthorized }) {
  let generation = 0;
  let selectedDate = today();
  let cached = null;
  let busy = false;
  let focusDate = null;
  const visible = () => !$('#admin-calendar-panel').hidden && !$('#dashboard').hidden;
  const notice = (text, error = false) => {
    $('#admin-month-message').textContent = text;
    $('#admin-month-message').classList.toggle('error', error);
  };
  function controls() {
    for (const element of $('#admin-calendar-panel').querySelectorAll('button,input')) element.disabled = busy;
    $('#open-calendar').disabled = busy;
    $('#admin-previous-month').disabled = busy || $('#admin-month').value === '1000-01';
    $('#admin-next-month').disabled = busy || $('#admin-month').value === '9998-12';
  }
  function clear() {
    cached = null;
    $('#admin-month-grid').replaceChildren();
    $('#admin-month-total').textContent = '';
    $('#admin-month-content').hidden = true;
  }
  function reset() {
    generation++; clear(); notice(''); focusDate = null;
    $('#admin-calendar-panel').hidden = true;
    $('#open-calendar').setAttribute('aria-expanded', 'false');
    $('#open-calendar').textContent = '月間カレンダーを表示';
  }
  function render() {
    if (!cached || !visible()) return;
    const grid = $('#admin-month-grid'); grid.replaceChildren();
    const weekday = new Date(cached.month + '-01T00:00:00Z').getUTCDay();
    for (let i = 0; i < weekday; i++) {
      const blank = node('span'); blank.setAttribute('aria-hidden', 'true'); grid.append(blank);
    }
    const totals = { confirmed: 0, completed: 0, cancelled: 0 };
    for (const day of cached.days) {
      for (const key of Object.keys(totals)) totals[key] += day[key];
      const button = node('button', undefined, 'admin-calendar-day');
      button.type = 'button'; button.dataset.date = day.date;
      button.setAttribute('aria-label', `${day.date} 確定${day.confirmed}件、来店済み${day.completed}件、キャンセル済み${day.cancelled}件`);
      button.setAttribute('aria-pressed', String(day.date === selectedDate));
      button.classList.toggle('selected', day.date === selectedDate);
      if (day.date === today()) button.setAttribute('aria-current', 'date');
      button.append(node('span', String(Number(day.date.slice(-2))), 'day-number'), node('span', `${day.confirmed}件`, 'day-count'));
      if (day.completed) button.append(node('small', `来店${day.completed}`));
      if (day.cancelled) button.append(node('small', `取消${day.cancelled}`));
      button.addEventListener('click', () => {
        if (busy || !visible()) return;
        selectedDate = day.date; focusDate = day.date;
        onSelect(day.date);
      });
      grid.append(button);
    }
    $('#admin-month-total').textContent = `${cached.month.replace('-', '年')}月 · 確定${totals.confirmed}件／来店済み${totals.completed}件／キャンセル済み${totals.cancelled}件`;
    $('#admin-month-content').hidden = false;
    controls();
    if (focusDate) {
      grid.querySelector(`[data-date="${focusDate}"]`)?.focus({ preventScroll: true });
      focusDate = null;
    }
  }
  async function load() {
    if (!visible()) return;
    const request = ++generation;
    const month = $('#admin-month').value;
    clear();
    if (!validMonth(month)) { notice('表示する月を確認してください。', true); controls(); return; }
    notice('月間の予約件数を読み込んでいます…'); controls();
    try {
      const result = await api(`/api/admin/calendar?${new URLSearchParams({ month })}`);
      if (request !== generation || !visible()) return;
      if (result?.month !== month || !Array.isArray(result.days)) throw new Error('月間の件数を確認できませんでした。');
      cached = result; notice(''); render();
    } catch (error) {
      if (request !== generation || !visible()) return;
      clear();
      if (error.status === 401 || error.status === 403) onUnauthorized(error);
      else notice(error.message, true);
    }
  }
  function syncDate(date, refresh = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    selectedDate = date;
    if (!visible()) return;
    const changed = $('#admin-month').value !== date.slice(0, 7);
    $('#admin-month').value = date.slice(0, 7);
    if (changed || refresh || !cached) load(); else render();
  }
  $('#open-calendar').addEventListener('click', () => {
    if (busy || $('#dashboard').hidden) return;
    if (visible()) { reset(); return; }
    $('#admin-calendar-panel').hidden = false;
    $('#open-calendar').setAttribute('aria-expanded', 'true');
    $('#open-calendar').textContent = '月間カレンダーを閉じる';
    const date = $('#date').value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) selectedDate = date;
    $('#admin-month').value = selectedDate.slice(0, 7);
    load();
  });
  $('#admin-month').addEventListener('change', () => { if (!busy) load(); });
  $('#admin-month-refresh').addEventListener('click', () => { if (!busy) load(); });
  $('#admin-current-month').addEventListener('click', () => { if (!busy) { $('#admin-month').value = today().slice(0, 7); load(); } });
  for (const [selector, direction] of [['#admin-previous-month', -1], ['#admin-next-month', 1]]) {
    $(selector).addEventListener('click', () => {
      if (busy || !validMonth($('#admin-month').value)) return;
      const date = new Date($('#admin-month').value + '-01T00:00:00Z');
      date.setUTCMonth(date.getUTCMonth() + direction);
      const month = date.toISOString().slice(0, 7);
      if (!validMonth(month)) return;
      $('#admin-month').value = month; load();
    });
  }
  return { suspend() { generation++; }, refresh: load, reset, syncDate, setBusy(value) { busy = value; controls(); } };
}
