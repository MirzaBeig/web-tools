#!/usr/bin/env python3
"""Build the static browser runtime. Users only need their browser, not this SDK."""
from pathlib import Path
import json, shutil, subprocess
root = Path(__file__).resolve().parent
project = root / 'runtime'
project.mkdir(exist_ok=True)
def write(name, text): (project / name).write_text(text, encoding='utf-8')
write('EngineRuntime.csproj', '''<Project Sdk="Microsoft.NET.Sdk.WebAssembly">
<PropertyGroup>
<TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType>
<RuntimeIdentifier>browser-wasm</RuntimeIdentifier><AllowUnsafeBlocks>true</AllowUnsafeBlocks>
<Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings>
<PublishTrimmed>false</PublishTrimmed><WasmBuildNative>true</WasmBuildNative>
<RunAOTCompilation>false</RunAOTCompilation><WasmEnableWebcil>false</WasmEnableWebcil>
<WasmFingerprintAssets>false</WasmFingerprintAssets><WasmMainJSPath>main.js</WasmMainJSPath>
<JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
<ItemGroup><PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="4.14.0" /></ItemGroup>
</Project>''')
write('Runtime.cs', r'''using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
namespace Engine40K;
public sealed class Entity
{
 public string Id { get; set; } = Guid.NewGuid().ToString("N");
 public string Name { get; set; } = "Object";
 public string Mesh { get; set; } = "cube";
 public string Color { get; set; } = "#55ccaa";
 public float X { get; set; }
 public float Y { get; set; }
 public float Z { get; set; }
 public float RX { get; set; }
 public float RY { get; set; }
 public float RZ { get; set; }
 public float SX { get; set; } = 1;
 public float SY { get; set; } = 1;
 public float SZ { get; set; } = 1;
 public bool Active { get; set; } = true;
}
public abstract class GameScript
{
 public virtual void Start() { }
 public virtual void Update(float deltaTime) { }
 public virtual void Tap(Entity target) { }
}
public static class World
{
 public static List<Entity> Entities { get; internal set; } = new();
 public static float Time { get; internal set; }
 public static int Score { get; set; }
 public static string Message { get; set; } = "";
 public static float MoveX { get; internal set; }
 public static float MoveZ { get; internal set; }
 internal static readonly List<string> Messages = new();
 public static Entity? Find(string name) => Entities.FirstOrDefault(e => e.Name == name);
 public static Entity Add(string name, string mesh = "cube", float x = 0, float y = 0, float z = 0, string color = "#55ccaa")
 {
  if (Entities.Count >= 4096) throw new InvalidOperationException("Prototype limit: 4096 scene objects.");
  var e = new Entity { Name = name, Mesh = mesh, X = x, Y = y, Z = z, Color = color };
  Entities.Add(e); return e;
 }
 public static void Destroy(Entity e) => Entities.Remove(e);
 public static void Log(object? value) { if (Messages.Count < 200) Messages.Add(value?.ToString() ?? "null"); }
}
public static partial class Runtime
{
 private static readonly List<MetadataReference> References = new();
 private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
 private static GameScript? game;
 private static int compilation;
 public static void Main() { }
 [JSExport] public static string Info() => ".NET " + Environment.Version + " / Roslyn " + typeof(CSharpCompilation).Assembly.GetName().Version;
 [JSExport] public static void Reference(string base64) => References.Add(MetadataReference.CreateFromImage(Convert.FromBase64String(base64)));
 [JSExport] public static string Compile(string source, string scene)
 {
  try {
   if (source.Length > 262144) throw new InvalidOperationException("Prototype source limit: 256 KiB.");
   var syntax = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp13), path: "Game.cs");
   var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release, concurrentBuild: false, allowUnsafe: false);
   var c = CSharpCompilation.Create("Game_" + ++compilation, new[] { syntax }, References, options);
   using var output = new MemoryStream();
   var result = c.Emit(output);
   var diagnostics = result.Diagnostics.Where(d => d.Severity is DiagnosticSeverity.Error or DiagnosticSeverity.Warning).Select(d => {
    var loc = d.Location.GetLineSpan().StartLinePosition;
    return new { id = d.Id, message = d.GetMessage(), severity = d.Severity.ToString(), line = loc.Line + 1, column = loc.Character + 1 };
   }).ToArray();
   if (!result.Success) return JsonSerializer.Serialize(new { ok = false, diagnostics }, Json);
   var assembly = Assembly.Load(output.ToArray());
   var types = assembly.GetTypes().Where(t => typeof(GameScript).IsAssignableFrom(t) && !t.IsAbstract).ToArray();
   if (types.Length != 1) return JsonSerializer.Serialize(new { ok = false, error = "Define exactly one public class derived from Engine40K.GameScript." }, Json);
   var next = (GameScript?)Activator.CreateInstance(types[0]) ?? throw new Exception("The game class needs a public parameterless constructor.");
   World.Entities = JsonSerializer.Deserialize<List<Entity>>(scene, Json) ?? new();
   World.Time = 0; World.Score = 0; World.Message = ""; World.MoveX = World.MoveZ = 0; World.Messages.Clear();
   game = next; game.Start();
   return JsonSerializer.Serialize(new { ok = true, diagnostics, snapshot = State() }, Json);
  } catch (Exception e) { return Failure(e); }
 }
 [JSExport] public static string Tick(float dt, float moveX, float moveZ, string tappedId)
 {
  try {
   if (game is null) throw new InvalidOperationException("No compiled game is running.");
   dt = Math.Clamp(dt, 0, 0.1f);
   World.MoveX = Math.Clamp(moveX, -1, 1); World.MoveZ = Math.Clamp(moveZ, -1, 1);
   World.Time += dt;
   if (!string.IsNullOrEmpty(tappedId)) {
    var target = World.Entities.FirstOrDefault(e => e.Id == tappedId && e.Active);
    if (target != null) game.Tap(target);
   }
   game.Update(dt);
   return JsonSerializer.Serialize(new { ok = true, snapshot = State() }, Json);
  } catch (Exception e) { return Failure(e); }
 }
 private static object State() {
  var logs = World.Messages.ToArray(); World.Messages.Clear();
  return new { entities = World.Entities, time = World.Time, score = World.Score, message = World.Message, logs };
 }
 private static string Failure(Exception e) => JsonSerializer.Serialize(new { ok = false, error = (e.InnerException ?? e).ToString() }, Json);
}''')
write('main.js', "import { dotnet } from './_framework/dotnet.js';\nexport { dotnet };\n")
subprocess.run(['dotnet', 'publish', str(project / 'EngineRuntime.csproj'), '-c', 'Release'], check=True)
loaders = list((project / 'bin/Release').rglob('dotnet.js'))
print('PUBLISHED_LOADERS=' + json.dumps([str(p.relative_to(project)) for p in loaders]))
loaders = [p for p in loaders if p.parent.name == '_framework']
if not loaders:
    print('BUILD_OUTPUTS=' + json.dumps([str(p.relative_to(project)) for p in (project / 'bin/Release').rglob('*') if p.is_file()][:500]))
    raise RuntimeError('No _framework/dotnet.js was published')
loader = max(loaders, key=lambda p: ('publish' in p.parts, p.stat().st_mtime))
bundle = loader.parent.parent
out = root / 'runtime-dist'
if out.exists(): shutil.rmtree(out)
shutil.copytree(bundle, out)
refs = ['_framework/' + f.name for f in sorted((out / '_framework').glob('*.dll')) if f.name.startswith(('System.', 'netstandard', 'EngineRuntime', 'mscorlib', 'Microsoft.CSharp'))]
if not any('EngineRuntime' in f for f in refs):
    print('FRAMEWORK_FILES=' + json.dumps([p.name for p in (out / '_framework').iterdir()]))
    raise RuntimeError('Runtime DLLs not found; cannot generate Roslyn reference manifest')
(out / 'references.json').write_text(json.dumps(refs))
(out / 'worker.js').write_text(r'''import { dotnet } from './_framework/dotnet.js';
let api;
function base64(bytes) {
 let s = ''; const b = new Uint8Array(bytes);
 for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
 return btoa(s);
}
try {
 const runtime = await dotnet.withDiagnosticTracing(false).create();
 const exports = await runtime.getAssemblyExports('EngineRuntime.dll');
 api = exports.Engine40K.Runtime;
 const refs = await (await fetch(new URL('./references.json', import.meta.url))).json();
 for (let i = 0; i < refs.length; i++) {
  const response = await fetch(new URL(refs[i], import.meta.url));
  if (!response.ok) throw new Error('Missing C# reference: ' + refs[i]);
  api.Reference(base64(await response.arrayBuffer()));
  if (i % 12 === 0) postMessage({ type: 'progress', done: i, total: refs.length });
 }
 postMessage({ type: 'ready', info: api.Info() });
} catch (error) { postMessage({ type: 'fatal', error: String(error.stack || error) }); }
onmessage = ({ data }) => {
 if (!api) return;
 const start = performance.now();
 try {
  const json = data.type === 'compile' ? api.Compile(data.source, JSON.stringify(data.entities)) : api.Tick(data.dt, data.moveX || 0, data.moveZ || 0, data.tap || '');
  postMessage({ type: data.type, id: data.id, ms: performance.now() - start, ...JSON.parse(json) });
 } catch (error) { postMessage({ type: 'fatal', error: String(error.stack || error) }); }
};
''')
subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--prefix', str(root / 'vendor-build'), 'three@0.180.0', 'esbuild@0.25.10'], check=True)
entry = root / 'vendor-build' / 'entry.js'
entry.write_text("import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; import { TransformControls } from 'three/addons/controls/TransformControls.js'; window.Engine40KLib = { THREE, OrbitControls, TransformControls };\n")
subprocess.run([str(root / 'vendor-build/node_modules/.bin/esbuild'), str(entry), '--bundle', '--minify', '--format=iife', '--outfile=' + str(out / 'three.bundle.js')], check=True)
shutil.copy(root / 'vendor-build/node_modules/three/LICENSE', out / 'THREE-LICENSE.txt')
(out / 'BUILD.json').write_text(json.dumps({'sdk': subprocess.check_output(['dotnet', '--version'], text=True).strip(), 'references': len(refs), 'runtime': 'genuine .NET browser-wasm; Roslyn 4.14.0', 'three': '0.180.0'}, indent=2))
print('RUNTIME_OUTPUT=' + str(out))
