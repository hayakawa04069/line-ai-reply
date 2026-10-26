"""月間カレンダーの画面テスト。外部通信なし、実際のSupabase・LINE接続なし。"""
from contextlib import contextmanager
from pathlib import Path
import os
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]

@contextmanager
def fixture(mode):
    env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT') if k in os.environ}
    process = subprocess.Popen(['node', str(Path(__file__).with_name('calendar-fixture.mjs')), mode], cwd=ROOT,
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        origin = process.stdout.readline().strip()
        assert origin.startswith('http://127.0.0.1:')
        yield origin
    finally:
        process.terminate()
        output, errors = process.communicate(timeout=10)
        assert process.returncode == 0, errors
        assert not errors, errors
        print(output.strip())

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium') or None)
    for mode in ('success', 'race', 'revoked', 'slow-logout', 'failure', 'missing-sql'):
        with fixture(mode) as origin:
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(origin + '/') else r.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/admin')
            page.locator('#email').fill('fake@example.invalid')
            page.locator('#password').fill('fixture-only')
            page.locator('#login').click()
            expect(page.locator('#dashboard')).to_be_visible()
            page.locator('#date').fill('2030-01-07')
            expect(page.locator('.reservation-card')).to_have_count(3)
            page.locator('#open-calendar').click()
            if mode in ('failure', 'missing-sql'):
                expect(page.locator('#admin-month-message')).to_contain_text('005' if mode == 'missing-sql' else '接続できません')
                expect(page.locator('#admin-month-content')).not_to_be_visible()
                expect(page.locator('.reservation-card')).to_have_count(3)
            elif mode == 'slow-logout':
                page.locator('#logout').click()
                page.wait_for_timeout(600)
                expect(page.locator('#login-panel')).to_be_visible()
                expect(page.locator('#admin-month-grid')).to_be_empty()
            elif mode == 'race':
                page.locator('#admin-next-month').click()
                expect(page.locator('.admin-calendar-day')).to_have_count(28)
                page.wait_for_timeout(600)
                expect(page.locator('#admin-month')).to_have_value('2030-02')
                expect(page.locator('#admin-month-total')).to_contain_text('2030年02月')
                expect(page.locator('.admin-calendar-day')).to_have_count(28)
            else:
                expect(page.locator('.admin-calendar-day')).to_have_count(31)
                day = page.locator('[data-date="2030-01-07"]')
                expect(day).to_have_attribute('aria-label', '2030-01-07 確定1件、来店済み1件、キャンセル済み1件')
                expect(day).to_have_attribute('aria-pressed', 'true')
                assert '架空' not in page.locator('#admin-calendar-panel').inner_text()
                assert page.locator('#admin-calendar-panel img').count() == 0
                if mode == 'revoked':
                    page.locator('#admin-month-refresh').click()
                    expect(page.locator('#login-panel')).to_be_visible()
                    expect(page.locator('#admin-month-grid')).to_be_empty()
                    expect(page.locator('.reservation-card')).to_have_count(0)
                else:
                    page.locator('[data-date="2030-01-08"]').click()
                    expect(page.locator('#date')).to_have_value('2030-01-08')
                    expect(page.locator('.reservation-card')).to_have_count(0)
                    expect(page.locator('[data-date="2030-01-08"]')).to_have_attribute('aria-pressed', 'true')
                    page.locator('#admin-month').fill('2028-02')
                    expect(page.locator('.admin-calendar-day')).to_have_count(29)
                    page.locator('#admin-month').fill('2030-12')
                    expect(page.locator('.admin-calendar-day')).to_have_count(31)
                    page.locator('#admin-next-month').click()
                    expect(page.locator('#admin-month')).to_have_value('2031-01')
                    expect(page.locator('#admin-month-total')).to_contain_text('2031年01月')
                    page.locator('#admin-month').fill('1000-01')
                    expect(page.locator('#admin-previous-month')).to_be_disabled()
                    page.locator('#admin-month').fill('9998-12')
                    expect(page.locator('#admin-next-month')).to_be_disabled()
                    page.locator('#date').fill('2030-01-07')
                    expect(page.locator('.reservation-card')).to_have_count(3)
                    page.locator('.reschedule-reservation').click()
                    page.locator('#reschedule-date').fill('2030-02-08')
                    expect(page.locator('#reschedule-time')).to_be_enabled()
                    page.locator('#reschedule-time').select_option('2030-02-08T02:00:00.000Z')
                    page.locator('#reschedule-confirm').click()
                    expect(page.locator('#admin-month')).to_be_disabled()
                    expect(page.locator('#message')).to_contain_text('予約日時を変更しました')
                    expect(page.locator('#admin-month')).to_have_value('2030-02')
                    expect(page.locator('[data-date="2030-02-08"]')).to_have_attribute('aria-label', '2030-02-08 確定1件、来店済み0件、キャンセル済み0件')
                    page.locator('#admin-month').fill('2030-01')
                    expect(page.locator('[data-date="2030-01-07"]')).to_have_attribute('aria-label', '2030-01-07 確定0件、来店済み1件、キャンセル済み1件')
                    page.locator('#admin-month').fill('2030-02')
                    expect(page.locator('[data-date="2030-02-08"]')).to_be_visible()
                    page.locator('.cancel-reservation').click()
                    page.locator('#cancel-confirm').click()
                    expect(page.locator('#message')).to_contain_text('予約をキャンセルしました')
                    expect(page.locator('[data-date="2030-02-08"]')).to_have_attribute('aria-label', '2030-02-08 確定0件、来店済み0件、キャンセル済み1件')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
            if mode not in ('revoked', 'slow-logout'):
                page.locator('#logout').click()
            expect(page.locator('#login-panel')).to_be_visible()
            expect(page.locator('#admin-month-grid')).to_be_empty()
            expect(page.locator('#admin-month-total')).to_be_empty()
            assert not errors, errors
            context.close()
        print('Calendar browser scenario passed: ' + mode)
    browser.close()
print('All six calendar browser scenarios passed (no external API access).')
