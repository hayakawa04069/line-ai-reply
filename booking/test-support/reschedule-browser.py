"""日時変更の任意画面テスト。実際のSupabase・LINEには接続しない。"""
from pathlib import Path
from contextlib import contextmanager
import os
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]

@contextmanager
def fixture(mode):
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT') if key in os.environ}
    process = subprocess.Popen(['node', str(Path(__file__).with_name('reschedule-fixture.mjs')), mode],
                               cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
    for mode in ('success', 'conflict', 'overlap', 'failure', 'lost-response', 'revoked'):
        with fixture(mode) as origin:
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/admin')
            page.locator('#email').fill('fake@example.invalid')
            page.locator('#password').fill('fixture-only')
            page.locator('#login').click()
            page.locator('#date').fill('2030-01-07')
            expect(page.locator('.reschedule-reservation')).to_have_count(1)
            page.locator('.reschedule-reservation').click()
            expect(page.locator('#reschedule-original')).to_contain_text('架空 <img src=x>')
            assert page.locator('#reschedule-original img').count() == 0
            page.locator('#reschedule-back').click()
            expect(page.locator('#reschedule-dialog')).not_to_be_visible()
            page.locator('.reschedule-reservation').click()
            page.keyboard.press('Escape')
            expect(page.locator('#reschedule-dialog')).not_to_be_visible()
            page.locator('.reschedule-reservation').click()
            page.locator('#reschedule-date').fill('2030-01-08')
            expect(page.locator('#reschedule-time')).to_be_enabled()
            page.locator('#reschedule-time').select_option('2030-01-08T02:00:00.000Z')
            expect(page.locator('#reschedule-preview')).to_contain_text('11:00')
            expect(page.locator('#reschedule-preview')).to_contain_text('3,000円')
            calls = []
            page.on('request', lambda r: calls.append(r) if r.url.endswith('/reschedule') else None)
            page.locator('#reschedule-confirm').evaluate('(b) => { b.click(); b.click(); }')
            if mode != 'revoked':
                expect(page.locator('#reschedule-confirm')).to_be_disabled()
                expect(page.locator('#reschedule-date')).to_be_disabled()
                page.keyboard.press('Escape')
                expect(page.locator('#reschedule-dialog')).to_be_visible()
            expect(page.locator('#reschedule-dialog')).not_to_be_visible(timeout=10000)
            assert len(calls) == 1
            if mode == 'success':
                expect(page.locator('#message')).to_have_text('予約日時を変更しました。')
                expect(page.locator('#date')).to_have_value('2030-01-08')
                expect(page.locator('.reservation-card')).to_contain_text('11:00')
            elif mode == 'revoked':
                expect(page.locator('#login-panel')).to_be_visible()
                expect(page.locator('.reservation-card')).to_have_count(0)
            elif mode == 'conflict':
                expect(page.locator('#message')).to_contain_text('予約が変更されています')
            elif mode == 'overlap':
                expect(page.locator('#message')).to_contain_text('先に予約が入りました')
            else:
                expect(page.locator('#message')).to_contain_text('変更結果が不明')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            expect(page.locator('#reschedule-original')).to_be_empty()
            expect(page.locator('#reschedule-preview')).to_be_empty()
            if mode != 'revoked':
                page.locator('#logout').click()
            expect(page.locator('#login-panel')).to_be_visible()
            assert not errors, errors
            context.close()
        print('Reschedule browser scenario passed: ' + mode)
    browser.close()
print('All six reschedule browser scenarios passed (no external API access).')
