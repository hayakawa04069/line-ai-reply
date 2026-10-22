export async function api(path, data) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '処理できませんでした。'); error.status = response.status; throw error; }
  return result;
}
export function message(text, error = false) {
  const element = document.querySelector('#message');
  element.textContent = text;
  element.classList.toggle('error', error);
  element.hidden = !text;
}
export const dateText = value => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
export const timeText = value => new Date(value).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
export const yen = value => `${Number(value).toLocaleString('ja-JP')}円`;
export const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
