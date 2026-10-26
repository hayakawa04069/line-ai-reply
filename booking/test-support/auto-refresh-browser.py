"""Only localhost mocks: auto refresh, protected input, errors and authentication."""
from pathlib import Path
import os, shutil, subprocess
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[2]
proc = subprocess.Popen(['node', str(Path(__file__).with_name('calendar-fixture.mjs'))], cwd=root,
    env={k: os.environ[k] for k in ('PATH', 'SYSTEMROOT') if k in os.environ}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    origin = proc.stdout.readline().strip()
    assert origin.startswith('http://127.0.0.1:')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which('chromium'))
        context = browser.new_context()
        context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(origin + '/') else r.abort())
        page = context.new_page()
        page.add_init_script('''const original = window.setInterval;
          window.setInterval = (fn, ms) => ms === 30000 ? (window.refreshTick = fn, 1) : original(fn, ms);''')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(origin + '/admin')
        page.locator('#email').fill('fake@example.invalid')
        page.locator('#password').fill('fixture-only')
        page.locator('#login').click()
        expect(page.locator('#dashboard')).to_be_visible()
        page.locator('#date').fill('2030-01-07')
        expect(page.locator('.reservation-card')).to_have_count(3)
        page.locator('#open-calendar').click()
        expect(page.locator('.admin-calendar-day')).to_have_count(31)
        page.locator('#admin-month').fill('2030-02')
        expect(page.locator('.admin-calendar-day')).to_have_count(28)
        calls = []
        page.on('request', lambda r: calls.append(r.url) if '/api/admin/reservations?' in r.url else None)
        def tick():
            page.evaluate('window.refreshTick()')
            page.wait_for_timeout(160)
        tick()
        assert len(calls) == 1
        expect(page.locator('#admin-month')).to_have_value('2030-02')
        expect(page.locator('#admin-last-updated')).to_contain_text('最終更新')
        print('PASS timer refresh and selected month preserved')
        def changed_reservations(route):
            response = route.fetch()
            data = response.json()
            data['reservations'].append({**data['reservations'][0], 'id': '10000000-0000-4000-8000-000000000099'})
            route.fulfill(response=response, json=data)
        page.route('**/api/admin/reservations?*', changed_reservations)
        tick(); expect(page.locator('.reservation-card')).to_have_count(4)
        page.unroute('**/api/admin/reservations?*', changed_reservations)
        tick(); expect(page.locator('.reservation-card')).to_have_count(3)
        print('PASS changed reservation data appears without manual reload')

        page.locator('.cancel-reservation').click()
        n = len(calls); tick(); assert len(calls) == n
        expect(page.locator('#cancel-dialog')).to_be_visible()
        page.locator('#cancel-back').click()
        page.locator('.reschedule-reservation').click()
        n = len(calls); tick(); assert len(calls) == n
        page.locator('#reschedule-back').click()
        print('PASS cancellation and rescheduling confirmation protected')
        page.locator('#open-settings').click()
        n = len(calls); tick(); assert len(calls) == n
        page.evaluate('''Object.defineProperty(document, 'hidden', {configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));''')
        tick(); assert len(calls) == n
        page.evaluate('''Object.defineProperty(document, 'hidden', {configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));''')
        expect(page.locator('#dashboard')).to_be_visible()
        expect(page.locator('#settings-panel')).to_be_visible()
        assert len(calls) == n
        page.locator('#settings-close').click()
        print('PASS settings preserved on timer and tab return; hidden tab paused')
        n = len(calls)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.locator('.reservation-card')).to_have_count(3)
        page.wait_for_timeout(160); assert len(calls) == n + 1
        print('PASS window focus refresh')
        page.route('**/api/admin/reservations?*', lambda r: r.abort())
        tick()
        expect(page.locator('#admin-last-updated')).to_contain_text('更新に失敗')
        page.unroute('**/api/admin/reservations?*')
        tick(); expect(page.locator('.reservation-card')).to_have_count(3)
        expect(page.locator('#admin-last-updated')).to_contain_text('最終更新')
        print('PASS network failure and automatic recovery')
        page.route('**/api/admin/reservations?*', lambda r: r.fulfill(status=403, content_type='application/json', body='{"error":"店舗管理者の権限がありません。"}'))
        tick()
        expect(page.locator('#login-panel')).to_be_visible()
        expect(page.locator('.reservation-card')).to_have_count(0)
        expect(page.locator('#admin-month-grid')).to_be_empty()
        n = len(calls); tick(); assert len(calls) == n
        assert not errors, errors
        print('PASS permission revoked clears data and stops refresh')
        browser.close()
finally:
    proc.terminate()
    out, err = proc.communicate(timeout=10)
    assert not err, err
