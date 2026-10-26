import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRefresh } from './public/auto-refresh.js';

function setup(refresh, allowed = () => true) {
  const callbacks = {};
  const controller = createAutoRefresh({ canRefresh: allowed, refresh,
    schedule(fn, ms) { assert.equal(ms, 30000); callbacks.timer = fn; },
    events: { addEventListener(name, fn) { callbacks[name] = fn; } },
  });
  return { ...controller, callbacks };
}
test('automatic refresh runs every 30 seconds and on focus', async () => {
  let count = 0;
  const { callbacks } = setup(async () => { count++; });
  callbacks.timer(); await Promise.resolve();
  callbacks.focus(); await Promise.resolve();
  assert.equal(count, 2);
});
test('hidden, logged out, loading or protected input skips refresh', async () => {
  let allowed = false, count = 0;
  const { tick } = setup(async () => { count++; }, () => allowed);
  await tick(); assert.equal(count, 0);
  allowed = true; await tick(); assert.equal(count, 1);
  allowed = false; await tick(); assert.equal(count, 1);
});
test('focus and timer never start overlapping requests', async () => {
  let release, count = 0;
  const { tick } = setup(() => { count++; return new Promise(resolve => { release = resolve; }); });
  const pending = tick(); await tick(); await tick();
  assert.equal(count, 1); release(); await pending;
  const next = tick(); assert.equal(count, 2); release(); await next;
});
test('refresh recovers on next tick after a failed request', async () => {
  let count = 0;
  const { tick } = setup(async () => { if (++count === 1) throw new Error('offline'); });
  await assert.rejects(tick(), /offline/);
  await tick(); assert.equal(count, 2);
});
