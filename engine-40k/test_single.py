from pathlib import Path
import json,os
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent
report={'ok':False,'tests':[],'errors':[],'networkRequests':[],'environment':'Chromium touch emulation, 390x844; offline file URL; not physical phone hardware'}
page=None
try:
 with sync_playwright() as p:
  options={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
  if os.environ.get('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**options)
  context=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
  context.set_offline(True)
  page=context.new_page()
  page.on('pageerror',lambda e:report['errors'].append(str(e)))
  page.on('request',lambda r:report['networkRequests'].append(r.url) if r.url.startswith(('http:','https:')) else None)
  page.goto((root/'Engine_40K_v0_1.html').as_uri(),timeout=30000)
  page.wait_for_function('!!window.engine40k',timeout=30000)
  page.screenshot(path=str(root/'single-phone.png'))
  report['tests'].append('Self-contained 3D editor opens from a file with browser networking disabled')
  page.wait_for_function("['ready','failed'].includes(engine40k.getState().workerStatus)",timeout=120000)
  assert page.evaluate('engine40k.getState().workerStatus')=='ready',page.evaluate('engine40k.getLogs()')
  report['tests'].append('Embedded .NET and Roslyn initialize without downloading dependencies')
  page.locator('#play').tap()
  page.wait_for_function("engine40k.getState().mode!=='compiling'",timeout=120000)
  assert page.evaluate('engine40k.getState().mode')=='play',page.evaluate('engine40k.getLogs()')
  page.wait_for_function('engine40k.getState().snapshot.time>0.1',timeout=15000)
  report['tests'].append('Default Game.cs compiles and executes offline')
  report['compileMs']=page.evaluate('engine40k.getState().compiledMs')
  page.screenshot(path=str(root/'single-playing.png'))
  page.locator('#stop').tap()
  original=page.evaluate('engine40k.getProject()')
  source='using Engine40K; public class Game:GameScript { public override void Start(){World.Score=73;World.Message="Offline C# proof";} public override void Update(float dt){World.Score++;} }'
  page.evaluate('(source)=>engine40k.applyReply(source)',source)
  page.locator('#play').tap()
  page.wait_for_function("engine40k.getState().mode!=='compiling'",timeout=120000)
  assert page.evaluate('engine40k.getState().mode')=='play',page.evaluate('engine40k.getLogs()')
  assert page.evaluate('engine40k.getState().snapshot.score')>=73
  report['tests'].append('New C# source is compiled, not just the prebuilt demonstration')
  page.locator('#stop').tap()
  page.evaluate('(p)=>engine40k.applyProject(p)',original)
  hung='using Engine40K; public class Game:GameScript { public override void Start(){while(true){}} }'
  page.evaluate('(source)=>engine40k.applyReply(source)',hung)
  page.locator('#play').tap()
  page.wait_for_timeout(1500)
  assert page.evaluate('engine40k.getState().mode')=='compiling'
  page.locator('#stop').tap(timeout=5000)
  assert page.evaluate('engine40k.getState().mode')=='edit'
  page.evaluate('(p)=>engine40k.applyProject(p)',original)
  assert page.evaluate('engine40k.getProject().entities.length')==len(original['entities'])
  report['tests'].append('A C# infinite loop does not prevent Stop or destroy the authored project')
  assert not report['networkRequests'],report['networkRequests']
  assert not report['errors'],report['errors']
  report['tests'].append('No HTTP or HTTPS dependency request occurred throughout the offline tests')
  report['ok']=True
  browser.close()
except Exception as e:
 report['errors'].append(str(e))
 if page:
  try:
   report['editorLogs']=page.evaluate('window.engine40k?engine40k.getLogs():document.getElementById("load-error").textContent')
   page.screenshot(path=str(root/'single-failure.png'))
  except Exception:pass
 raise
finally:
 (root/'single-test-results.json').write_text(json.dumps(report,indent=2))
 print('SINGLE_REPORT='+json.dumps(report),flush=True)
