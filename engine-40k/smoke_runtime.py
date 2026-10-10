from pathlib import Path
import functools, http.server, threading, json
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
(root / 'runtime-probe.html').write_text('''<!doctype html><title>C# runtime probe</title><script>
window.events = []; window.worker = new Worker('./runtime-dist/worker.js', {type:'module'});
worker.onmessage = e => {events.push(e.data); console.log(JSON.stringify(e.data));};
worker.onerror = e => {events.push({type:'fatal', error:e.message});};
</script>''')
report = {'tests': [], 'errors': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width':390, 'height':844}, is_mobile=True, has_touch=True)
        page.on('console', lambda m: print('BROWSER', m.type, m.text[:1800]))
        page.on('pageerror', lambda e: report['errors'].append(str(e)))
        page.goto('http://127.0.0.1:8765/runtime-probe.html')
        page.wait_for_function("events.some(e => e.type === 'ready' || e.type === 'fatal')", timeout=180000)
        ready = page.evaluate('events.find(e => e.type === "ready" || e.type === "fatal")')
        report['runtime'] = ready
        assert ready['type'] == 'ready', ready
        report['tests'].append('Runtime loads in a browser Web Worker')
        source = '''using System; using System.Linq; using Engine40K;
public class Game : GameScript {
  public override void Start() {
    World.Add("Proof", "cube", 1, 2, 3);
    World.Score = Enumerable.Range(1, 10).Sum();
    World.Log("Real C# reflection=" + GetType().Name);
  }
  public override void Update(float dt) { World.Find("Proof")!.X += dt * 10; }
  public override void Tap(Entity target) { World.Score += 7; target.Color = "#ff0000"; }
}'''
        page.evaluate('(source)=>worker.postMessage({type:"compile",id:1,source,entities:[]})', source)
        page.wait_for_function('events.some(e=>e.id===1)', timeout=120000)
        compiled = page.evaluate('events.find(e=>e.id===1)')
        assert compiled['ok'], compiled
        assert compiled['snapshot']['score'] == 55, compiled
        assert 'Real C# reflection=Game' in compiled['snapshot']['logs'], compiled
        report['compileMs'] = compiled['ms']
        report['tests'].append('Roslyn compiles real C# with LINQ, reflection, overrides and typed API')
        entity_id = compiled['snapshot']['entities'][0]['id']
        page.evaluate('(tap)=>worker.postMessage({type:"tick",id:2,dt:0.05,tap})', entity_id)
        page.wait_for_function('events.some(e=>e.id===2)', timeout=20000)
        tick = page.evaluate('events.find(e=>e.id===2)')
        assert tick['ok'], tick
        assert abs(tick['snapshot']['entities'][0]['x'] - 1.5) < 0.001, tick
        assert tick['snapshot']['score'] == 62, tick
        assert tick['snapshot']['entities'][0]['color'] == '#ff0000', tick
        report['tests'].append('C# Update and Tap change scene, transform, material and score')
        page.evaluate('worker.postMessage({type:"compile",id:3,source:"public class broken { this is not valid; }",entities:[]})')
        page.wait_for_function('events.some(e=>e.id===3)', timeout=30000)
        invalid = page.evaluate('events.find(e=>e.id===3)')
        assert not invalid['ok'] and len(invalid['diagnostics']) > 0, invalid
        assert invalid['diagnostics'][0]['line'] >= 1, invalid
        report['tests'].append('Invalid C# produces actual compiler diagnostics with source locations')
        page.evaluate('(source)=>worker.postMessage({type:"compile",id:4,source:source.replace("+= dt * 10", "+= dt * 20"),entities:[]})', source)
        page.wait_for_function('events.some(e=>e.id===4)', timeout=30000)
        assert page.evaluate('events.find(e=>e.id===4).ok')
        page.evaluate('worker.postMessage({type:"tick",id:5,dt:0.05})')
        page.wait_for_function('events.some(e=>e.id===5)', timeout=10000)
        assert abs(page.evaluate('events.find(e=>e.id===5).snapshot.entities[0].x')-2) < 0.001
        report['tests'].append('Editing and recompiling C# changes executed behavior')
        report['ok'] = True
        browser.close()
except Exception as error:
    report['ok'] = False
    report['errors'].append(str(error))
    raise
finally:
    (root / 'runtime-test-results.json').write_text(json.dumps(report, indent=2))
    print('TEST_REPORT=' + json.dumps(report))
    server.shutdown()
