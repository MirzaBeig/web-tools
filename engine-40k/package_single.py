"""Embed editor, .NET runtime and Roslyn into one offline HTML file."""
from pathlib import Path
import base64,gzip,json,sys,shutil
root=Path(__file__).resolve().parent
fw=root/'runtime-dist/_framework'
payload={}
for f in sorted(fw.iterdir()):
    if f.is_file() and f.suffix in ('.dll','.wasm','.dat','.js'):
        payload[f.name]=base64.b64encode(gzip.compress(f.read_bytes(),compresslevel=9,mtime=0)).decode()
references=[Path(s).name for s in json.loads((root/'runtime-dist/references.json').read_text())]
worker=r'''
(async()=>{
const compressed=__ASSETS__;
const references=__REFERENCES__;
const pendingAssets=new Map(), modules=new Map();
async function bytes(name){
 name=name.split('/').pop();
 if(pendingAssets.has(name))return pendingAssets.get(name);
 if(!compressed[name])throw new Error('Embedded runtime asset missing: '+name);
 const promise=(async()=>{
  const raw=atob(compressed[name]);
  const packed=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)packed[i]=raw.charCodeAt(i);
  const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
 })();
 pendingAssets.set(name,promise);return promise;
}
function base64(data){let s='';for(let i=0;i<data.length;i+=32768)s+=String.fromCharCode(...data.subarray(i,i+32768));return btoa(s);}
async function moduleURL(name){
 if(!modules.has(name)){
  // Blob modules lack a hierarchical base. Give the bundled loader a logical base;
  // withResourceLoader supplies every dependency from embedded bytes, not that URL.
  const source=new TextDecoder().decode(await bytes(name)).replaceAll('import.meta.url',JSON.stringify('https://engine40k.invalid/_framework/'+name));
  modules.set(name,URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
 }
 return modules.get(name);
}
let api;
try{
 if(typeof DecompressionStream!=='function')throw new Error('This browser does not provide gzip decompression. Use a current browser.');
 await moduleURL('dotnet.native.js');await moduleURL('dotnet.runtime.js');
 const {dotnet}=await import(await moduleURL('dotnet.js'));
 const runtime=await dotnet.withDiagnosticTracing(false).withApplicationCulture('en-US')
 .withResourceLoader((type,name,uri,hash,behavior)=>{
  if(type==='dotnetjs'){
   const found=modules.get(name);if(!found)throw new Error('Unexpected runtime module '+name);return found;
  }
  return bytes(name).then(b=>new Response(b,{headers:{'Content-Type':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}}));
 }).create();
 api=(await runtime.getAssemblyExports('EngineRuntime.dll')).Engine40K.Runtime;
 for(let i=0;i<references.length;i++){
  api.Reference(base64(await bytes(references[i])));
  if(i%12===0)postMessage({type:'progress',done:i,total:references.length});
 }
 postMessage({type:'ready',info:api.Info()});
 // Install application messaging only after .NET has initialized.
 onmessage=({data})=>{
  const start=performance.now();
  try{
   const json=data.type==='compile'?api.Compile(data.source,JSON.stringify(data.entities)):api.Tick(data.dt,data.moveX||0,data.moveZ||0,data.tap||'');
   postMessage({type:data.type,id:data.id,ms:performance.now()-start,...JSON.parse(json)});
  }catch(e){postMessage({type:'fatal',error:String(e.stack||e)});}
 };
}catch(e){postMessage({type:'fatal',error:String(e.stack||e)});}
})();
'''.replace('__ASSETS__',json.dumps(payload,separators=(',',':'))).replace('__REFERENCES__',json.dumps(references))
# Classic bootstrap workers support file-origin documents in Chromium; dynamic
# module imports are still used inside that worker for the actual .NET runtime.
bootstrap="window.Engine40KCreateWorker=()=>{const url=URL.createObjectURL(new Blob(["+json.dumps(worker)+"],{type:'text/javascript'}));const w=new Worker(url);const release=()=>URL.revokeObjectURL(url);w.addEventListener('message',release,{once:true});w.addEventListener('error',release,{once:true});const kill=w.terminate.bind(w);w.terminate=()=>{release();kill();};return w;};"
notices=['Three.js\n'+(root/'runtime-dist/THREE-LICENSE.txt').read_text()]
dotnet=shutil.which('dotnet')
if dotnet:
    sdkroot=Path(dotnet).resolve().parent
    for name in ('LICENSE.txt','ThirdPartyNotices.txt'):
        source=sdkroot/name
        if source.exists():
            notices.append('.NET SDK distribution / '+name+'\n'+source.read_text(errors='replace'))
    for package in ('microsoft.codeanalysis.common','microsoft.codeanalysis.csharp'):
        folder=Path.home()/'.nuget/packages'/package/'4.14.0'
        for source in folder.glob('*'):
            if source.is_file() and source.suffix.lower() in ('.txt','.md') and any(t in source.name.lower() for t in ('license','notice')):
                notices.append(package+' / '+source.name+'\n'+source.read_text(errors='replace'))
license_text='\n\n'.join(notices)
(root/'THIRD-PARTY-NOTICES.txt').write_text(license_text)
js=(root/'runtime-dist/three.bundle.js').read_text()
editor=(root/'editor.js').read_text()
def inline(source):return '<script>'+source.replace('</script','<\\/script')+'</script>'
html=(root/'index.html').read_text()
html=html.replace('<script src="runtime-dist/three.bundle.js"></script>',inline(js)+inline(bootstrap))
html=html.replace('<script src="editor.js"></script>',inline(editor))
html=html.replace('</head>','<!-- Bundled dependency notices:\n'+license_text.replace('--','—')+' -->\n</head>')
out=Path(sys.argv[1]) if len(sys.argv)>1 else root/'Engine_40K_v0_1.html'
out.write_text(html)
print('SINGLE_HTML='+str(out)+' ('+str(out.stat().st_size)+' bytes)')
