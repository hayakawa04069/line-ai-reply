// One read at a time; interaction and visibility guards are evaluated on every tick.
export function createAutoRefresh({ canRefresh, refresh, schedule = setInterval, events = globalThis.window }) {
  let running = false;
  async function tick() {
    if (running || !canRefresh()) return;
    running = true;
    try { await refresh(); } finally { running = false; }
  }
  const run = () => { tick().catch(() => {}); };
  schedule(run, 30000);
  events.addEventListener('focus', run);
  return { tick };
}
