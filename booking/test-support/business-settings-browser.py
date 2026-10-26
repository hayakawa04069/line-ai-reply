"""営業設定の任意画面テスト。外部通信を遮断したローカル模擬環境のみ使用。"""
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
    process = subprocess.Popen(['node', str(Path(__file__).with_name('business-settings-fixture.mjs')), mode],
                               cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        origin = process.stdout.readline().strip()
        assert origin.startswith('http://127.0.0.1:')
        yield origin
    finally:
        process.terminate()
        output, error = process.communicate(timeout=10)
        assert process.returncode == 0, error
        assert not error, error
        print(output.strip())

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium') or None)
    for mode in ('success', 'conflict', 'stale', 'failure', 'lost-response', 'revoked', 'missing-sql'):
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
            page.locator('#open-settings').click()
            expect(page.locator('#settings-panel')).to_be_visible()
            if mode == 'missing-sql':
                expect(page.locator('#settings-message')).to_contain_text('追加SQL')
                expect(page.locator('#settings-review')).to_be_disabled()
            else:
                expect(page.locator('#settings-review')).to_be_enabled()
                expect(page.locator('.hours-row')).to_have_count(7)
                expect(page.locator('.hours-row').nth(0).locator('input[type=checkbox]')).not_to_be_checked()
                expect(page.locator('#settings-slot')).to_have_value('15')
                monday = page.locator('.hours-row').nth(1)
                monday.locator('input[type=time]').nth(1).fill('09:00')
                page.locator('#settings-review').click()
                expect(page.locator('#settings-message')).to_contain_text('開店時刻より後')
                expect(page.locator('#settings-dialog')).not_to_be_visible()
                monday.locator('input[type=time]').nth(1).fill('17:00')
                page.locator('#settings-slot').select_option('30')
                page.locator('#settings-add-day').click()
                page.locator('.closed-row input[type=date]').fill('2030-01-09')
                page.locator('.closed-row input[type=text]').fill('<img src=x>')
                calls = []
                page.on('request', lambda r: calls.append(r) if r.method == 'POST' and r.url.endswith('/business-settings') else None)
                page.locator('#settings-review').click()
                expect(page.locator('#settings-summary')).to_contain_text('月曜：10:00〜17:00')
                expect(page.locator('#settings-summary')).to_contain_text('30分')
                expect(page.locator('#settings-summary')).to_contain_text('<img src=x>')
                assert page.locator('#settings-summary img').count() == 0
                page.locator('#settings-back').click()
                assert len(calls) == 0
                page.locator('#settings-review').click()
                page.keyboard.press('Escape')
                expect(page.locator('#settings-dialog')).not_to_be_visible()
                assert len(calls) == 0
                page.locator('#settings-review').click()
                page.locator('#settings-save').evaluate('(b) => { b.click(); b.click(); }')
                if mode != 'revoked':
                    expect(page.locator('#settings-save')).to_be_disabled()
                    page.keyboard.press('Escape')
                    expect(page.locator('#settings-dialog')).to_be_visible()
                expect(page.locator('#settings-dialog')).not_to_be_visible(timeout=10000)
                assert len(calls) == 1
                if mode == 'revoked':
                    expect(page.locator('#login-panel')).to_be_visible()
                    expect(page.locator('#settings-panel')).not_to_be_visible()
                    expect(page.locator('#settings-hours')).to_be_empty()
                elif mode == 'success':
                    expect(page.locator('#settings-message')).to_contain_text('営業設定を保存しました')
                    expect(page.locator('#settings-slot')).to_have_value('30')
                else:
                    expect(page.locator('#settings-review')).to_be_disabled()
                    expected = {'conflict': '既存の予約と矛盾', 'stale': '他の担当者', 'failure': '再読み込み', 'lost-response': '再読み込み'}[mode]
                    expect(page.locator('#settings-message')).to_contain_text(expected)
                    page.locator('#settings-reload').click()
                    expect(page.locator('#settings-review')).to_be_enabled()
                    expect(page.locator('#settings-slot')).to_have_value('30' if mode == 'lost-response' else '15')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
            if mode != 'revoked':
                page.locator('#logout').click()
            expect(page.locator('#settings-panel')).not_to_be_visible()
            expect(page.locator('#settings-summary')).to_be_empty()
            assert not errors, errors
            context.close()
        print('Settings browser scenario passed: ' + mode)
    browser.close()
print('All seven settings browser scenarios passed (no external API access).')
