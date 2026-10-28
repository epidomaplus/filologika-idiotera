# Headless UI test (needs playwright + Chrome): python ui_test.py http://localhost:3911 /path/to/shots
import sys, random, string
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]; OUT = sys.argv[2]
r = ''.join(random.choices(string.ascii_lowercase, k=6))
T_EMAIL, S_EMAIL = f'ui-teacher-{r}@example.com', f'ui-student-{r}@example.com'
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    pg = b.new_page(viewport={'width': 1300, 'height': 850})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(BASE); pg.wait_for_selector('#auth-screen', state='visible')
    pg.screenshot(path=f'{OUT}/01-login.png')
    pg.fill('#auth-email', T_EMAIL); pg.fill('#auth-password', 'teacherpass1')
    pg.click('#register-btn'); pg.fill('#auth-name', 'ÎœÎ±ÏÎ¯Î± Î¦Î¹Î»ÏŒÎ»Î¿Î³Î¿Ï‚'); pg.click('#register-btn')
    pg.wait_for_selector('#main-app', state='visible')
    # student
    pg.click('[data-page=students]'); pg.click('#add-student-btn')
    pg.fill('#s-name', 'Î“Î¹ÏŽÏÎ³Î¿Ï‚ Î”Î¿ÎºÎ¹Î¼Î±ÏƒÏ„Î¹ÎºÏŒÏ‚'); pg.fill('#s-level', "Î“' Î›Ï…ÎºÎµÎ¯Î¿Ï…"); pg.fill('#s-email', S_EMAIL)
    pg.click('#modal-save'); pg.wait_for_timeout(500)
    # appointment
    pg.click('[data-page=appointments]'); pg.click('#add-appointment-btn')
    pg.select_option('#a-student', index=1); pg.fill('#a-date', '2026-11-05'); pg.click('#modal-save'); pg.wait_for_timeout(500)
    # account
    pg.click('[data-page=students]'); pg.click('text=Î ÏÎ¿Î²Î¿Î»Î®')
    pg.wait_for_selector('#acct-save'); pg.fill('#acct-pass', 'studentpw1'); pg.click('#acct-save'); pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{OUT}/02-student-account.png')
    pg.click('#modal-save'); pg.wait_for_timeout(300)
    # material
    open('/tmp/askisi-test.txt', 'w').write('Î†ÏƒÎºÎ·ÏƒÎ·: Î¼ÎµÏ„Î¬Ï†ÏÎ±ÏƒÎ· ÎžÎµÎ½Î¿Ï†ÏŽÎ½Ï„Î±')
    pg.click('[data-page=materials]'); pg.click('#add-material-btn')
    pg.select_option('#m-kind', 'exercise'); pg.select_option('#m-student', index=1)
    pg.fill('#m-title', 'ÎžÎµÎ½Î¿Ï†ÏŽÎ½ - Î•Î»Î»Î·Î½Î¹ÎºÎ¬'); pg.fill('#m-body', 'ÎœÎµÏ„Î¬Ï†ÏÎ±ÏƒÎµ Ï„Î·Î½ ÎµÎ½ÏŒÏ„Î·Ï„Î± 3.'); pg.set_input_files('#m-files', '/tmp/askisi-test.txt')
    pg.click('#modal-save'); pg.wait_for_selector('#materials-list >> text=ÎžÎµÎ½Î¿Ï†ÏŽÎ½'); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/03-teacher-materials.png')
    pg.click('[data-page=dashboard]'); pg.click('#theme-toggle'); pg.wait_for_timeout(600)
    pg.reload(); pg.wait_for_selector('#main-app', state='visible'); pg.wait_for_timeout(800)
    assert pg.get_attribute('html', 'data-theme') == 'dark', 'theme persisted'
    assert pg.inner_text('#students-count') == '1', 'student persisted after reload'
    pg.screenshot(path=f'{OUT}/04-teacher-dashboard-dark.png')
    pg.click('#logout-btn'); pg.wait_for_selector('#auth-screen', state='visible')
    # student login
    pg.fill('#auth-email', S_EMAIL); pg.fill('#auth-password', 'studentpw1'); pg.click('#login-btn')
    pg.wait_for_selector('#portal-app', state='visible'); pg.wait_for_timeout(1000)
    assert pg.inner_text('#p-upcoming-count') == '1', 'student sees appointment'
    pg.screenshot(path=f'{OUT}/05-student-portal.png')
    pg.click('[data-ppage=p-materials]'); pg.wait_for_timeout(300)
    assert 'ÎžÎµÎ½Î¿Ï†ÏŽÎ½' in pg.inner_text('#p-mat-list'), 'student sees material'
    with pg.expect_download() as dl: pg.click('#p-mat-list a')
    assert 'ÎžÎµÎ½Î¿Ï†ÏŽÎ½Ï„Î±' in open(dl.value.path(), encoding='utf-8').read(), 'download ok'
    pg.screenshot(path=f'{OUT}/06-student-materials.png')
    b.close()
print('UI errors:', errors)
assert not errors
print('UI TEST PASSED')
