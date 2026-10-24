"""任意のローカル画面テスト。Python PlaywrightとChromiumが必要。外部接続なし。"""
from pathlib import Path
from contextlib import contextmanager
import os
import shutil
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_name('cancellation-fixture.mjs')

@contextmanager
def fixture(mode='success'):
    # 本番用の変数・キーはテスト用プロセスに渡さない。
    env = {name: os.environ[name] for name in ('PATH', 'SYSTEMROOT') if name in os.environ}
    process = subprocess.Popen(['node', str(FIXTURE), mode], cwd=ROOT, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        origin = process.stdout.readline().strip()
        assert origin.startswith('http://127.0.0.1:'), 'Fixture failed to start'
        yield origin
    finally:
        process.terminate()
        output, error = process.communicate(timeout=10)
        assert process.returncode == 0, error
        assert not error, error
        print(output.strip())

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium') or None)
    for mode in ('success', 'conflict', 'failure', 'lost-response', 'revoked'):
        with fixture(mode) as origin:
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/admin')
            page.locator('#email').fill('admin@example.invalid')
            page.locator('#password').fill('fixture-password')
            page.locator('#login').click()
            expect(page.locator('.reservation-card')).to_have_count(3)
            expect(page.locator('.cancel-reservation')).to_have_count(1)
            assert page.locator('.reservation-card img').count() == 0
            calls = []
            page.on('request', lambda request: calls.append(request) if request.url.endswith('/cancel') else None)
            page.locator('.cancel-reservation').click()
            expect(page.locator('#cancel-dialog')).to_be_visible()
            expect(page.locator('#cancel-details')).to_contain_text('架空のお客様 <img src=x>')
            expect(page.locator('#cancel-details')).to_contain_text('テストメニュー')
            expect(page.locator('#cancel-details')).to_contain_text('1月7日')
            expect(page.locator('#cancel-details')).to_contain_text('10:00')
            expect(page.locator('#cancel-back')).to_be_focused()
            page.locator('#cancel-back').click()
            expect(page.locator('#cancel-dialog')).not_to_be_visible()
            assert len(calls) == 0, 'Back must not submit'
            page.locator('.cancel-reservation').click()
            page.keyboard.press('Escape')
            expect(page.locator('#cancel-dialog')).not_to_be_visible()
            assert len(calls) == 0, 'Escape must not submit'
            page.locator('.cancel-reservation').click()
            # 同一イベントループ内で連打しても送信は1回だけ。
            page.locator('#cancel-confirm').evaluate('(button) => { button.click(); button.click(); }')
            if mode != 'revoked':
                expect(page.locator('#cancel-confirm')).to_be_disabled()
                page.keyboard.press('Escape')
                expect(page.locator('#cancel-dialog')).to_be_visible()
            expect(page.locator('#cancel-dialog')).not_to_be_visible(timeout=10000)
            assert len(calls) == 1
            if mode == 'revoked':
                expect(page.locator('#login-panel')).to_be_visible()
                expect(page.locator('#message')).to_contain_text('店舗管理者の権限がありません')
                expect(page.locator('.reservation-card')).to_have_count(0)
                expect(page.locator('#cancel-details')).to_be_empty()
            elif mode == 'success':
                expect(page.locator('#message')).to_have_text('予約をキャンセルしました。')
                expect(page.locator('.badge.cancelled')).to_have_count(2)
                expect(page.locator('.cancel-reservation')).to_have_count(0)
            elif mode == 'lost-response':
                expect(page.locator('#message')).to_contain_text('キャンセル結果を確認できませんでした')
                expect(page.locator('.badge.cancelled')).to_have_count(2)
                expect(page.locator('.cancel-reservation')).to_have_count(0)
            else:
                expect(page.locator('#message')).to_contain_text('予約が変更された' if mode == 'conflict' else 'キャンセル結果を確認できませんでした')
                expect(page.locator('.cancel-reservation')).to_have_count(1)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
            # ログアウトで顧客情報と確認画面の内容を消去。
            if mode != 'revoked':
                page.locator('#logout').click()
            expect(page.locator('#login-panel')).to_be_visible()
            expect(page.locator('.reservation-card')).to_have_count(0)
            expect(page.locator('#cancel-details')).to_be_empty()
            assert not errors, errors
            context.close()
        print('Browser scenario passed: ' + mode)
    browser.close()
print('All five browser scenarios passed (no external API access).')
