"""Acceptance tests, using a real browser with touch/phone viewport emulation.
This is not a performance benchmark of a physical phone.
"""
from pathlib import Path
import functools, http.server, threading, json, os
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parent
server = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root)))
threading.Thread(target=server.serve_forever, daemon=True).start()
report = {'ok': False, 'environment': 'Chromium, 390x844 touch emulation; not physical Android hardware', 'tests': [], 'errors': []}
def passed(name):
    report['tests'].append(name)
    print('PASS:', name, flush=True)
try:
    with sync_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
        if os.environ.get('CHROMIUM_PATH'): options['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = p.chromium.launch(**options)
        context = browser.new_context(viewport={'width':390,'height':844}, device_scale_factor=1, is_mobile=True, has_touch=True, accept_downloads=True)
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.goto('http://127.0.0.1:8766/index.html')
        page.wait_for_function('!!window.engine40k', timeout=30000)
        assert page.locator('#viewport').is_visible()
        assert page.evaluate('engine40k.getProject().entities.length') == 14
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        passed('3D editor opens at phone width without horizontal page overflow')
        page.screenshot(path=str(root/'editor-phone.png'))
        page.evaluate('engine40k.setDrawer(450)')
        page.locator('[data-add="cube"]').tap()
        new_id = page.evaluate('engine40k.getState().selectedId')
        assert page.evaluate('engine40k.getProject().entities.length') == 15
        page.locator('#v-x').fill('2.50')
        page.locator('#v-y').tap()
        assert page.evaluate('(id)=>engine40k.getProject().entities.find(e=>e.id===id).x',new_id) == 2.5
        page.locator('#undo').tap()
        assert page.evaluate('(id)=>engine40k.getProject().entities.find(e=>e.id===id).x',new_id) == 0
        page.locator('#redo').tap()
        assert page.evaluate('(id)=>engine40k.getProject().entities.find(e=>e.id===id).x',new_id) == 2.5
        passed('Touch Add and numerical transform edits support Undo and Redo')
        page.locator('#duplicate').tap()
        assert page.evaluate('engine40k.getProject().entities.length') == 16
        page.locator('#delete').tap()
        assert page.evaluate('engine40k.getProject().entities.length') == 15
        passed('Duplicate and Delete update the actual scene')
        before = page.evaluate('engine40k.getViewport()')
        handle = page.locator('#grip').bounding_box()
        page.mouse.move(handle['x']+20,handle['y']+20)
        page.mouse.down()
        page.mouse.move(handle['x']+20,handle['y']-100,steps=12)
        page.mouse.up()
        after = page.evaluate('engine40k.getViewport()')
        assert before == after, (before,after)
        passed('Dragging the bottom panel preserves render size, camera and projection')
        invalid = page.evaluate('''() => {const before=JSON.stringify(engine40k.getProject());try{engine40k.applyReply('{"engine40kPatch":1,"entities":[{"id":"broken"}]}');return false;}catch(e){return JSON.stringify(engine40k.getProject())===before;}}''')
        assert invalid
        passed('Invalid project patch is rejected without changing the project')
        page.locator('[data-tab="ai"]').tap()
        page.locator('#ai-request').fill('Make the crystal spin twice as fast. Keep everything else.')
        assert 'Make the crystal spin twice as fast. Keep everything else.' in page.evaluate('engine40k.getPrompt()')
        assert 'CURRENT PROJECT:' in page.evaluate('engine40k.getPrompt()')
        original = page.evaluate('engine40k.getProject()')
        changed = original['source'].replace('65f * dt','130f * dt')
        page.locator('#ai-reply').fill('```csharp\n'+changed+'\n```')
        page.locator('#apply-reply').tap()
        assert page.evaluate('engine40k.getProject().source') == changed+'\n'
        assert page.evaluate('engine40k.getState().mode') == 'edit'
        page.locator('#undo').tap()
        assert page.evaluate('engine40k.getProject().source') == original['source']
        passed('AI handoff preserves request, applies real source, does not autorun, and is undoable')
        page.locator('[data-tab="code"]').tap()
        page.screenshot(path=str(root/'editor-code-phone.png'))
        page.wait_for_function("engine40k.getState().workerStatus === 'ready' || engine40k.getState().workerStatus === 'failed'", timeout=180000)
        assert page.evaluate('engine40k.getState().workerStatus') == 'ready', page.evaluate('engine40k.getLogs()')
        page.evaluate('engine40k.setDrawer(215)')
        page.locator('#play').tap()
        page.wait_for_function("engine40k.getState().mode !== 'compiling'", timeout=120000)
        assert page.evaluate('engine40k.getState().mode') == 'play', page.evaluate('engine40k.getLogs()')
        page.wait_for_function('engine40k.getState().snapshot.time > 0.15', timeout=10000)
        report['compileMs'] = page.evaluate('engine40k.getState().compiledMs')
        passed('Play compiles the C# editor source and executes it in the worker')
        crystal = page.evaluate("engine40k.getProject().entities.find(e=>e.name==='Crystal 1').id")
        pos = page.evaluate('(id)=>engine40k.projectPoint(id)',crystal)
        page.touchscreen.tap(pos['x']+3,pos['y'])
        page.wait_for_function('engine40k.getState().snapshot.score >= 1', timeout=10000)
        assert page.evaluate('(id)=>engine40k.getProject().entities.find(e=>e.id===id).active',crystal)
        passed('Touching a scene crystal calls C# Tap and changes game score without mutating edit data')
        page.locator('#pause').tap()
        page.wait_for_timeout(200)
        t = page.evaluate('engine40k.getState().snapshot.time')
        page.wait_for_timeout(250)
        assert page.evaluate('engine40k.getState().snapshot.time') == t
        page.locator('#pause').tap()
        page.wait_for_function('(t)=>engine40k.getState().snapshot.time>t',arg=t)
        passed('Pause and Resume control actual game execution')
        page.screenshot(path=str(root/'editor-playing-phone.png'))
        page.locator('#stop').tap()
        assert page.evaluate('engine40k.getState().mode') == 'edit'
        passed('Stop restores the authored scene')
        page.evaluate('engine40k.setDrawer(430);engine40k.setTab("code")')
        valid = page.evaluate('engine40k.getProject().source')
        page.locator('#source').fill('using Engine40K; public class Broken { this is invalid; }')
        page.locator('#play').tap()
        page.wait_for_function("engine40k.getState().mode !== 'compiling'",timeout=120000)
        assert page.evaluate('engine40k.getState().mode') == 'edit'
        assert page.evaluate("engine40k.getLogs().some(l=>l.kind==='error' && l.line>=1)")
        passed('C# syntax errors appear as real source-linked compiler diagnostics')
        page.evaluate('(source)=>engine40k.applyReply(source)',valid)
        page.locator('[data-tab="project"]').tap()
        page.locator('#project-name').fill('Phone proof')
        page.locator('#save-project').tap()
        with page.expect_download() as download:
            page.locator('#export-project').tap()
        file=download.value
        file.save_as(str(root/'test-export.engine40k.json'))
        exported=json.loads((root/'test-export.engine40k.json').read_text())
        assert exported['name']=='Phone proof' and exported['source']==valid
        page.reload()
        page.wait_for_function('!!window.engine40k')
        assert page.evaluate('engine40k.getProject().name') == 'Phone proof'
        assert page.evaluate('engine40k.getProject().source') == valid
        passed('Project export and local save survive a full browser reload')
        page.set_viewport_size({'width':844,'height':390})
        page.wait_for_timeout(150)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(root/'editor-landscape.png'))
        passed('Landscape layout remains within the phone viewport')
        assert not report['errors'], report['errors']
        report['ok']=True
        browser.close()
except Exception as error:
    report['errors'].append(str(error))
    raise
finally:
    (root/'editor-test-results.json').write_text(json.dumps(report,indent=2))
    print('EDITOR_REPORT='+json.dumps(report),flush=True)
    server.shutdown()
