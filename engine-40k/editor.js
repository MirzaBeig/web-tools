(() => {
'use strict';
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const STORE = 'engine40k.project.v1', BACKUP = 'engine40k.backup.v1';
const MESHES = ['cube','sphere','cylinder','torus','plane'];
const AXES = ['x','y','z','rx','ry','rz','sx','sy','sz'];
const logs = [], history = [], future = [];
let project, selectedId = null, tool = 'select', mode = 'edit', sourceBaseline = '';
let scene, camera, renderer, orbit, transform, outline, actors, grid, THREE;
const objects = new Map();
let worker = null, readyPromise = null, readyResolve, readyReject, workerStatus = 'cold';
let workerGeneration = 0, serial = 0, playEpoch = 0, runCount = 0, pendingTick = false;
let lastSnapshot = null, lastTick = 0, tapQueue = '', movement = {x:0,z:0};
const pending = new Map();
let storageTimer, toastTimer, compiledMs = 0, tickMs = 0;
let gizmoBefore = null, loaded = false;
const apiDoc = `using Engine40K;\npublic class Game : GameScript {\n    public override void Start() { }\n    public override void Update(float deltaTime) { }\n    public override void Tap(Entity target) { }\n}\n\nEntity: string Id, Name, Mesh, Color; bool Active;\nfloat X, Y, Z; float RX, RY, RZ; float SX, SY, SZ;\nPosition is metres; rotation is degrees; scale defaults to 1.\nMesh: cube, sphere, cylinder, torus, plane. Color: #rrggbb.\n\nWorld.Entities: List<Entity> (runtime scene, not editor state).\nWorld.Time: elapsed seconds; World.Score: int; World.Message: string.\nWorld.MoveX / World.MoveZ: joystick input in world X/Z, -1 to 1.\nWorld.Find(string name): Entity?\nWorld.Add(string name, string mesh=\"cube\", float x=0, float y=0,\n          float z=0, string color=\"#55ccaa\"): Entity\nWorld.Destroy(Entity entity); World.Log(object value);\n\nSystem.MathF, LINQ, collections and ordinary C# are available.\nDefine exactly one public non-abstract GameScript with a public\nparameterless constructor. This is NOT the UnityEngine API.\nThe prototype has no physics engine or mesh/texture importer.\nDo not use JavaScript, UnityEngine or invented APIs.`;
const DEMO_SOURCE = `using System;\nusing System.Linq;\nusing Engine40K;\n\npublic class Game : GameScript\n{\n    private Entity? player;\n    private int total;\n    private const float MoveSpeed = 4f;\n\n    public override void Start()\n    {\n        player = World.Find("Player");\n        total = World.Entities.Count(e => e.Name.StartsWith("Crystal") && e.Active);\n        World.Message = "Tap the crystals, or move to collect them.";\n        World.Log("Game.cs compiled and running as C#.");\n    }\n\n    public override void Update(float dt)\n    {\n        if (player != null)\n        {\n            player.X = Math.Clamp(player.X + World.MoveX * MoveSpeed * dt, -5f, 5f);\n            player.Z = Math.Clamp(player.Z + World.MoveZ * MoveSpeed * dt, -5f, 5f);\n            player.RZ -= World.MoveX * 180f * dt;\n            player.RX += World.MoveZ * 180f * dt;\n        }\n\n        foreach (var crystal in World.Entities)\n        {\n            if (!crystal.Active || !crystal.Name.StartsWith("Crystal")) continue;\n            crystal.RY += 65f * dt;\n            crystal.Y = 0.9f + MathF.Sin(World.Time * 2f + crystal.X) * 0.12f;\n\n            if (player != null)\n            {\n                float dx = player.X - crystal.X;\n                float dz = player.Z - crystal.Z;\n                if (dx * dx + dz * dz < 0.7f) Collect(crystal);\n            }\n        }\n    }\n\n    public override void Tap(Entity target)\n    {\n        if (target.Name.StartsWith("Crystal")) Collect(target);\n    }\n\n    private void Collect(Entity target)\n    {\n        if (!target.Active) return;\n        target.Active = false;\n        World.Score++;\n        World.Message = World.Score >= total\n            ? "All collected. Stop to return to editing."\n            : $"{World.Score} / {total} collected";\n    }\n}\n`;
const EMPTY_SOURCE = `using Engine40K;\n\npublic class Game : GameScript\n{\n    public override void Start()\n    {\n        World.Message = "Your game starts here.";\n    }\n\n    public override void Update(float dt)\n    {\n        var cube = World.Find("Cube");\n        if (cube != null) cube.RY += 45f * dt;\n    }\n}\n`;
function uuid(){ return globalThis.crypto?.randomUUID?.() || 'e'+Date.now().toString(36)+Math.random().toString(36).slice(2); }
function entity(name, mesh='cube', x=0,y=0.5,z=0,color='#76dbc0',sx=1,sy=1,sz=1){return {id:uuid(),name,mesh,x,y,z,rx:0,ry:0,rz:0,sx,sy,sz,color,active:true};}
function demo(){
 const entities=[entity('Ground','cube',0,-0.35,0,'#2c3d50',12,0.6,12),entity('Player','sphere',0,0.5,3.6,'#76dbc0',0.85,0.85,0.85)];
 for(let i=0;i<8;i++) entities.push(entity('Crystal '+(i+1),'torus',(i%4)*2-3,0.9,i<4?-2.2:0.8,'#f2c66d',0.65,0.65,0.65));
 for(const [x,z] of [[-5,-5],[5,-5],[-5,5],[5,5]]) entities.push(entity('Beacon','cylinder',x,0.65,z,'#527991',0.22,1.35,0.22));
 return {engine40k:1,name:'Crystal Garden',source:DEMO_SOURCE,entities};
}
function validate(input){
 if(!input || input.engine40k!==1) throw new Error('Not an Engine 40K v1 project.');
 if(typeof input.name!=='string' || !input.name.length || input.name.length>80) throw new Error('Project name must contain 1–80 characters.');
 if(typeof input.source!=='string' || input.source.length>262144) throw new Error('C# source must be text, at most 256 KiB.');
 if(!Array.isArray(input.entities) || input.entities.length>512) throw new Error('The editor prototype supports up to 512 scene objects.');
 const ids=new Set();
 const entities=input.entities.map((e,index)=>{
  if(!e || typeof e!=='object') throw new Error('Invalid scene object '+index);
  if(typeof e.id!=='string' || !e.id || e.id.length>100 || ids.has(e.id)) throw new Error('Object IDs must be unique, nonempty strings.');
  ids.add(e.id);
  if(typeof e.name!=='string' || e.name.length>80) throw new Error('Invalid object name.');
  if(!MESHES.includes(e.mesh)) throw new Error('Unsupported mesh: '+e.mesh);
  if(!/^#[a-f\d]{6}$/i.test(e.color)) throw new Error('Material colors must be #rrggbb.');
  const out={id:e.id,name:e.name,mesh:e.mesh,color:e.color,active:e.active!==false};
  for(const key of AXES){ const v=e[key]??(key.startsWith('s')?1:0); if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>100000 || (key.startsWith('s')&&v<0.02)) throw new Error('Invalid transform '+key+' on '+e.name); out[key]=v; }
  return out;
 });
 return {engine40k:1,name:input.name,source:input.source,entities};
}
function toast(message){ $('toast').textContent=message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3000); }
function log(message,kind='info',line){
 const time=new Date().toLocaleTimeString([], {hour12:false}); logs.push({message:String(message),kind,line,time});
 if(logs.length>200) logs.shift(); renderLogs();
}
function renderLogs(){
 const list=$('console-list'); list.replaceChildren();
 for(const item of logs){ const row=document.createElement('div');row.className='console-entry '+item.kind;const t=document.createElement('span');t.className='console-time';t.textContent=item.time;row.append(t);const text=document.createElement('span');text.className='grow';text.textContent=item.message;row.append(text);if(item.line){const b=document.createElement('button');b.textContent='Line '+item.line;b.onclick=()=>goToLine(item.line);row.append(b);}list.append(row); }
 const count=logs.filter(l=>l.kind==='error').length; $('error-count').textContent=count; $('error-count').hidden=!count;
}
function saveNow(){
 clearTimeout(storageTimer);
 try{ const text=JSON.stringify(project), old=localStorage.getItem(STORE);if(old&&old!==text)localStorage.setItem(BACKUP,old);localStorage.setItem(STORE,text);$('save-state').textContent='Saved locally'; return true; }
 catch(e){$('save-state').textContent='Not saved'; log('Browser storage is unavailable. Export the project to keep it. '+e.message,'error');return false;}
}
function scheduleSave(){ $('save-state').textContent='Saving…';clearTimeout(storageTimer);storageTimer=setTimeout(saveNow,500); }
function take(){return JSON.stringify(project);}
function pushHistory(before){ if(before===take())return;history.push(before);if(history.length>80)history.shift();future.length=0;refreshTransport(); }
function commitCode(){if(sourceBaseline!==project.source){const before=clone(project);before.source=sourceBaseline;pushHistory(JSON.stringify(before));}sourceBaseline=project.source;}
function edit(action){
 if(mode!=='edit'){toast('Stop the game before editing the scene.');return false;}
 commitCode();const before=take(), previousSelection=selectedId;
 try{action();project=validate(project);}catch(error){
  project=JSON.parse(before);selectedId=previousSelection;refreshProject();
  toast(error.message);log('Edit rejected: '+error.message,'error');return false;
 }
 pushHistory(before);sourceBaseline=project.source;refreshProject();scheduleSave();return true;
}
function restore(serialized){project=validate(JSON.parse(serialized));sourceBaseline=project.source;selectedId=project.entities.some(e=>e.id===selectedId)?selectedId:null;refreshProject(true);scheduleSave();}
function undo(){if(mode!=='edit')return;commitCode();if(!history.length)return;future.push(take());restore(history.pop());toast('Undo');}
function redo(){if(mode!=='edit')return;commitCode();if(!future.length)return;history.push(take());restore(future.pop());toast('Redo');}
function setTab(name){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===name+'-panel'));if(name==='code'){lineNumbers();}if(parseFloat(getComputedStyle($('drawer')).height)<180)setDrawer(Math.min(innerHeight*0.55,500));}
function refreshTransport(){const editing=mode==='edit';$('undo').disabled=!editing||!history.length;$('redo').disabled=!editing||!future.length;$('play').disabled=mode==='compiling';$('play').classList.toggle('on',mode==='play');$('pause').disabled=!['play','paused'].includes(mode);$('pause').classList.toggle('on',mode==='paused');$('stop').disabled=editing;document.querySelectorAll('[data-add],#duplicate,#delete,#entity-name,#entity-active,#entity-color,.axis-field input').forEach(b=>b.disabled=!editing);$('source').readOnly=mode==='compiling';$('view-caption').textContent=editing?'SCENE VIEW · PERSPECTIVE':mode==='compiling'?'COMPILING C#':mode==='paused'?'GAME VIEW · PAUSED':'GAME VIEW · C#';$('view-caption').classList.toggle('play-tag',!editing);updateSelection();}
function lineNumbers(){const lines=$('source').value.split('\n').length;$('line-numbers').textContent=Array.from({length:lines},(_,i)=>i+1).join('\n');$('line-numbers').scrollTop=$('source').scrollTop;cursorPosition();}
function cursorPosition(){const a=$('source').value.slice(0,$('source').selectionStart).split('\n');$('source-position').textContent='Ln '+a.length+', Col '+(a.at(-1).length+1);}
function goToLine(line){setTab('code');const text=$('source').value, pos=text.split('\n').slice(0,line-1).join('\n').length+(line>1?1:0);$('source').focus();$('source').setSelectionRange(pos,pos);$('source').scrollTop=Math.max(0,(line-3)*25);cursorPosition();}
function renderHierarchy(){
 $('entity-list').replaceChildren();$('object-count').textContent=project.entities.length;
 for(const e of project.entities){const b=document.createElement('button');b.className='entity-row'+(e.id===selectedId?' selected':'');b.dataset.entity=e.id;const dot=document.createElement('span');dot.className='dot';dot.style.background=e.color;dot.style.opacity=e.active?1:0.3;const name=document.createElement('span');name.className='entity-name';name.textContent=e.name;const mesh=document.createElement('small');mesh.textContent=e.mesh;b.append(dot,name,mesh);b.onclick=()=>select(e.id);$('entity-list').append(b);}
}
function current(){return project.entities.find(e=>e.id===selectedId);}
function renderInspector(){const e=current();$('no-selection').hidden=!!e;$('inspector-fields').hidden=!e;if(!e)return;$('entity-name').value=e.name;$('entity-active').checked=e.active;$('entity-color').value=e.color;$('mesh-name').textContent=e.mesh[0].toUpperCase()+e.mesh.slice(1);for(const key of AXES){$('v-'+key).value=e[key].toFixed(2);}}
function select(id){selectedId=id;renderHierarchy();renderInspector();updateSelection();return current();}
function refreshProject(replaceCode=false){$('heading').textContent=project.name;$('project-name').value=project.name;$('project-summary').textContent=project.entities.length+' scene objects · '+project.source.split('\n').length+' lines of C#';if(replaceCode||document.activeElement!==$('source'))$('source').value=project.source;lineNumbers();renderHierarchy();renderInspector();if(mode==='edit')syncScene(project.entities);refreshTransport();}
function uniqueName(base){let name=base,n=2;while(project.entities.some(e=>e.name===name))name=base+' '+n++;return name;}
function add(mesh){let e;edit(()=>{if(project.entities.length>=512)throw new Error('Object limit reached.');e=entity(uniqueName(mesh==='torus'?'Ring':mesh[0].toUpperCase()+mesh.slice(1)),mesh);project.entities.push(e);selectedId=e.id;});return e;}
function applyProject(value){const next=validate(value);stop(false);commitCode();const before=take();project=next;selectedId=null;pushHistory(before);sourceBaseline=project.source;refreshProject(true);saveNow();toast('Project applied');return clone(project);}
function applyReply(text){
 let content=text;
 const fenced=content.match(/```(?:csharp|cs|json|C#)?\s*\n([\s\S]*?)```/i);if(fenced)content=fenced[1];
 if(!content.trim())throw new Error('Paste a C# script or project patch first.');
 if(content.trimStart().startsWith('{')){
  const data=JSON.parse(content);
  if(data.engine40k===1)return applyProject(data);
  if(data.engine40kPatch!==1)throw new Error('Expected engine40kPatch: 1.');
  if(!('source'in data)&&!('entities'in data)&&!('name'in data))throw new Error('The patch contains no changes.');
  const next=clone(project);for(const key of ['name','source','entities'])if(key in data)next[key]=data[key];return applyProject(next);
 }
 const next=clone(project);next.source=content;return applyProject(next);
}
async function copy(text){try{await navigator.clipboard.writeText(text);}catch{const t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;top:-10000px';document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw new Error('Clipboard access was blocked. Select and copy the text manually.');}toast('Copied');}
function download(name,text,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function prompt(){return 'REQUEST (preserve exactly):\n'+$('ai-request').value+'\n\nYou are editing an Engine 40K browser game. Return either the complete Game.cs in one C# code block, or a JSON object {"engine40kPatch":1,"source":"complete C# source","entities":[optional complete replacement scene]}. Omit fields that do not change. Do not add Markdown commentary. Keep all existing functionality unless the request changes it. The user runs and edits on a phone. Do not use UnityEngine or JavaScript.\n\nGAMEPLAY API:\n'+apiDoc+'\n\nCURRENT PROJECT:\n'+JSON.stringify(project,null,2);}
function setDrawer(height){const max=innerHeight-64;const h=Math.max(108,Math.min(max,height));document.documentElement.style.setProperty('--drawer',h+'px');}
function resetCamera(){
 if(!camera)return;
 // Fit the demo's width in portrait without tying projection to panel size.
 const distance=Math.max(20,17/(2*Math.tan(camera.fov*Math.PI/360)*camera.aspect));
 camera.position.set(10,10,13).normalize().multiplyScalar(Math.min(60,distance));
 orbit.target.set(0,0,0);orbit.update();
}
function focusSelected(){const obj=objects.get(selectedId);if(!obj)return toast('Select an object first.');const size=Math.max(2.4,obj.scale.length()*1.7);const direction=camera.position.clone().sub(orbit.target).normalize();orbit.target.copy(obj.position);camera.position.copy(obj.position).addScaledVector(direction,size);orbit.update();}
function updateSelection(){if(!outline||!transform)return;const obj=objects.get(selectedId);const editing=mode==='edit';outline.visible=!!obj&&obj.visible&&editing;if(outline.visible)outline.setFromObject(obj);if(obj&&editing&&tool!=='select'){transform.setMode(tool);transform.attach(obj);transform.enabled=true;}else{transform.detach();transform.enabled=false;}transform.getHelper().visible=editing&&tool!=='select'&&!!obj;}
function syncScene(entities){
 if(!actors)return;
 if(!Array.isArray(entities)||entities.length>4096)throw new Error('Runtime scene exceeded the 4096-object limit.');
 const existing=new Set();
 for(const e of entities){
  if(typeof e.id!=='string'||!AXES.every(k=>Number.isFinite(e[k])))throw new Error('Runtime returned an invalid transform.');
  existing.add(e.id);let obj=objects.get(e.id);
  const kind=MESHES.includes(e.mesh)?e.mesh:'cube';
  if(obj&&obj.userData.mesh!==kind){actors.remove(obj);obj.material.dispose();objects.delete(e.id);obj=null;}
  if(!obj){obj=new THREE.Mesh(geometry[kind],new THREE.MeshStandardMaterial({roughness:0.43,metalness:0.12}));obj.castShadow=true;obj.receiveShadow=true;obj.userData={id:e.id,mesh:kind};objects.set(e.id,obj);actors.add(obj);}
  obj.visible=e.active!==false;obj.position.set(e.x,e.y,e.z);obj.rotation.set(e.rx*Math.PI/180,e.ry*Math.PI/180,e.rz*Math.PI/180);obj.scale.set(Math.max(.02,e.sx),Math.max(.02,e.sy),Math.max(.02,e.sz));
  const color=/^#[a-f\d]{6}$/i.test(e.color)?e.color:'#ffffff';obj.material.color.set(color);obj.material.emissive.set(color);obj.material.emissiveIntensity=e.name.startsWith('Crystal')?0.14:0.015;
 }
 for(const [id,obj] of objects){if(!existing.has(id)){actors.remove(obj);obj.material.dispose();objects.delete(id);}}
 updateSelection();
}
let geometry;
function init3D(){
 if(!window.Engine40KLib)throw new Error('Graphics assets are missing. Open the complete editor bundle.');
 THREE=window.Engine40KLib.THREE;
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.3;
 renderer.domElement.id='viewport';renderer.domElement.setAttribute('aria-label','3D scene viewport');$('stage').prepend(renderer.domElement);
 scene=new THREE.Scene();scene.fog=new THREE.Fog('#171d27',32,75);camera=new THREE.PerspectiveCamera(42,1,0.05,150);
 const hemi=new THREE.HemisphereLight('#d9f0ff','#222b41',2.4);scene.add(hemi);
 const sun=new THREE.DirectionalLight('#ffe7c6',3.4);sun.position.set(-7,14,8);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-12;sun.shadow.camera.right=12;sun.shadow.camera.top=12;sun.shadow.camera.bottom=-12;sun.shadow.normalBias=.035;sun.shadow.bias=-.00015;scene.add(sun);
 const rim=new THREE.DirectionalLight('#70b8c9',1.6);rim.position.set(8,5,-8);scene.add(rim);
 grid=new THREE.GridHelper(32,32,'#4b647a','#2b3b4c');grid.position.y=-.035;grid.material.transparent=true;grid.material.opacity=.4;scene.add(grid);
 geometry={cube:new THREE.BoxGeometry(1,1,1),sphere:new THREE.SphereGeometry(.5,28,20),cylinder:new THREE.CylinderGeometry(.5,.5,1,24),torus:new THREE.TorusGeometry(.65,.18,12,32),plane:new THREE.BoxGeometry(1,.04,1)};
 actors=new THREE.Group();scene.add(actors);
 orbit=new window.Engine40KLib.OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.dampingFactor=.13;orbit.minDistance=1;orbit.maxDistance=65;orbit.maxPolarAngle=Math.PI*.48;orbit.touches.ONE=THREE.TOUCH.ROTATE;orbit.touches.TWO=THREE.TOUCH.DOLLY_PAN;
 transform=new window.Engine40KLib.TransformControls(camera,renderer.domElement);transform.setSize(.85);scene.add(transform.getHelper());
 transform.addEventListener('dragging-changed',e=>orbit.enabled=!e.value);
 transform.addEventListener('mouseDown',()=>{if(mode==='edit'){commitCode();gizmoBefore=take();}});
 transform.addEventListener('objectChange',()=>{if(mode!=='edit')return;const e=current(),o=transform.object;if(!e||!o)return;[e.x,e.y,e.z]=o.position.toArray();[e.rx,e.ry,e.rz]=[o.rotation.x,o.rotation.y,o.rotation.z].map(v=>v*180/Math.PI);[e.sx,e.sy,e.sz]=o.scale.toArray().map(v=>Math.max(.02,v));for(const k of AXES)e[k]=Math.round(e[k]*10000)/10000;renderInspector();if(outline.visible)outline.update();});
 transform.addEventListener('mouseUp',()=>{if(gizmoBefore){pushHistory(gizmoBefore);gizmoBefore=null;scheduleSave();}});
 outline=new THREE.BoxHelper(new THREE.Mesh(),0xf1d089);outline.material.transparent=true;outline.material.opacity=.75;outline.visible=false;scene.add(outline);
 const ray=new THREE.Raycaster(), point=new THREE.Vector2();let down=null, pointers=new Set();
 renderer.domElement.addEventListener('pointerdown',e=>{pointers.add(e.pointerId);down={x:e.clientX,y:e.clientY,time:performance.now(),multi:pointers.size>1,gizmo:!!transform.axis};},true);
 renderer.domElement.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(!down)return;const d=down;down=null;if(d.multi||d.gizmo||Math.hypot(e.clientX-d.x,e.clientY-d.y)>7||performance.now()-d.time>700)return;const box=renderer.domElement.getBoundingClientRect();point.set((e.clientX-box.left)/box.width*2-1,-(e.clientY-box.top)/box.height*2+1);ray.setFromCamera(point,camera);let hit=ray.intersectObjects([...objects.values()].filter(o=>o.visible),false)[0];
 // A ring's empty centre is still a usable selection target on a touchscreen.
 let nearest=e.pointerType==='touch'?18:9;
 for(const o of objects.values()){
  if(!o.visible||o.userData.mesh!=='torus')continue;
  const projected=o.position.clone().project(camera);
  if(projected.z < -1 || projected.z > 1)continue;
  const px=box.left+(projected.x+1)*box.width/2, py=box.top+(1-projected.y)*box.height/2;
  const distance=Math.hypot(e.clientX-px,e.clientY-py);
  const depth=ray.ray.origin.distanceTo(o.position);
  if(distance<nearest && (!hit||depth<=hit.distance+Math.max(o.scale.x,o.scale.y,o.scale.z))){
   nearest=distance;hit={object:o,distance:depth};
  }
 }
 if(mode==='play'){if(hit)tapQueue=hit.object.userData.id;}else if(mode==='edit')select(hit?.object.userData.id||null);});
 renderer.domElement.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);down=null;});
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();stop(false);log('Graphics context lost. Save or export the project, then reload.','error');toast('Graphics context lost. Reload the editor.');});
 const resize=()=>{const w=$('stage').clientWidth,h=$('stage').clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.setViewOffset(w,h,0,h*0.16,w,h);camera.updateProjectionMatrix();};
 new ResizeObserver(resize).observe($('stage'));resize();resetCamera();
 let frames=0,stamp=performance.now();
 function frame(now){requestAnimationFrame(frame);orbit.update();if(outline.visible)outline.update();if(mode==='play'&&!pendingTick&&workerStatus==='ready'){const dt=Math.min((now-lastTick)/1000,.1);if(dt>=.012){lastTick=now;const tap=tapQueue;tapQueue='';pendingTick=true;const epoch=playEpoch;request({type:'tick',dt,moveX:movement.x,moveZ:movement.z,tap},5000).then(result=>{if(epoch!==playEpoch)return;tickMs=result.ms;if(!result.ok)throw new Error(result.error||'C# runtime exception');applySnapshot(result.snapshot);}).catch(error=>{if(epoch===playEpoch){stop(false);log(error.message,'error');toast('C# stopped. See Console.');}}).finally(()=>{if(epoch===playEpoch)pendingTick=false;});}}
 renderer.render(scene,camera);frames++;if(now-stamp>600){$('fps').textContent=Math.round(frames*1000/(now-stamp))+' FPS';frames=0;stamp=now;}}
 requestAnimationFrame(frame);
}
function applySnapshot(snapshot){lastSnapshot=snapshot;syncScene(snapshot.entities);$('score').textContent=snapshot.score;$('game-message').textContent=snapshot.message;for(const message of snapshot.logs||[])log(message);}
function killWorker(reason='Runtime reset'){
 workerGeneration++;worker?.terminate();worker=null;workerStatus='cold';readyPromise=null;readyReject?.(new Error(reason));readyResolve=null;readyReject=null;
 for(const [,p]of pending){clearTimeout(p.timer);p.reject(new Error(reason));}pending.clear();$('runtime-status').textContent='C# not loaded';
}
function ensureRuntime(){
 if(workerStatus==='ready')return Promise.resolve();if(readyPromise)return readyPromise;
 workerStatus='loading';$('runtime-status').textContent='Loading .NET…';$('runtime-detail').textContent='Loading the C# runtime and compiler into a Web Worker.';
 const generation=++workerGeneration;
 readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timeout=setTimeout(()=>{if(generation===workerGeneration&&workerStatus!=='ready')fatal('C# runtime startup timed out. Check the asset download and retry Play.');},180000);
 const fatal=message=>{if(generation!==workerGeneration)return;clearTimeout(timeout);workerStatus='failed';$('runtime-status').textContent='C# load failed';$('runtime-detail').textContent=message;readyReject?.(new Error(message));readyPromise=null;for(const [,p]of pending){clearTimeout(p.timer);p.reject(new Error(message));}pending.clear();worker?.terminate();worker=null;log(message,'error');};
 try{worker=window.Engine40KCreateWorker?window.Engine40KCreateWorker():new Worker(new URL('./runtime-dist/worker.js',document.baseURI),{type:'module'});
 worker.onerror=e=>fatal(e.message||('The C# worker could not start.'+(e.filename?' '+e.filename+':'+e.lineno:'')));
 worker.onmessage=({data})=>{if(generation!==workerGeneration)return;
  if(data.type==='progress'){$('runtime-status').textContent='C# references '+Math.round(data.done/data.total*100)+'%';return;}
  if(data.type==='ready'){clearTimeout(timeout);workerStatus='ready';$('runtime-status').textContent='C# ready';$('runtime-detail').textContent=data.info+' · separate Web Worker';log(data.info+' ready.','success');readyResolve?.();return;}
  if(data.type==='fatal'){fatal(data.error);return;}
  const p=pending.get(data.id);if(p){clearTimeout(p.timer);pending.delete(data.id);p.resolve(data);}
 };
 }catch(e){fatal(e.message);}
 return readyPromise||Promise.reject(new Error('C# runtime startup failed.'));
}
function request(data,timeout){return new Promise((resolve,reject)=>{if(!worker)return reject(new Error('C# runtime is not loaded.'));const id=++serial;const timer=setTimeout(()=>{if(!pending.has(id))return;killWorker('C# did not return. Its worker was terminated; your edit scene is preserved.');},timeout);pending.set(id,{resolve,reject,timer});worker.postMessage({...data,id});});}
async function play(){
 if(mode==='paused'){togglePause();return;}
 if(mode==='play'){stop(false);}if(mode==='compiling')return;
 commitCode();if(runCount>=8){killWorker('Recycling runtime to release old script assemblies.');runCount=0;}
 const epoch=++playEpoch;mode='compiling';refreshTransport();$('compile-state').textContent='Compiling Game.cs…';
 try{await ensureRuntime();if(epoch!==playEpoch)return;const result=await request({type:'compile',source:project.source,entities:clone(project.entities)},120000);if(epoch!==playEpoch)return;
 for(const d of result.diagnostics||[])log(d.id+': '+d.message,d.severity==='Error'?'error':'info',d.line);
 if(!result.ok){mode='edit';syncScene(project.entities);refreshTransport();$('compile-state').textContent='Compilation failed';if(result.error)log(result.error,'error');setTab('console');return false;}
 compiledMs=result.ms;runCount++;mode='play';pendingTick=false;lastTick=performance.now();applySnapshot(result.snapshot);$('game-hud').hidden=false;$('joystick').hidden=false;$('view-hint').textContent='Tap a crystal · Drag the joystick to move';$('compile-state').textContent='Compiled in '+Math.round(compiledMs)+' ms';refreshTransport();log('Game.cs compiled in '+Math.round(compiledMs)+' ms. Play mode started.','success');return true;
 }catch(e){if(epoch!==playEpoch)return false;mode='edit';syncScene(project.entities);refreshTransport();$('compile-state').textContent='Could not start C#';log(e.message,'error');setTab('console');return false;}
}
function stop(announce=true){
 const old=mode;playEpoch++;mode='edit';pendingTick=false;tapQueue='';movement={x:0,z:0};$('stick').style.transform='';
 if(old==='compiling'||pending.size)killWorker('Stopped by the user.');
 $('game-hud').hidden=true;$('joystick').hidden=true;$('view-hint').textContent='Drag to orbit · Pinch to zoom · Tap to select';if(loaded){syncScene(project.entities);refreshTransport();renderInspector();}if(announce&&old!=='edit')log('Stopped. Original edit scene restored.');
}
function togglePause(){if(mode==='play')mode='paused';else if(mode==='paused'){mode='play';lastTick=performance.now();}movement={x:0,z:0};$('stick').style.transform='';refreshTransport();}
function wire(){
 $('api-doc').textContent=apiDoc;
 const groups={position:['x','y','z'],rotation:['rx','ry','rz'],scale:['sx','sy','sz']};
 for(const [group,keys]of Object.entries(groups))for(const [i,key]of keys.entries()){const label=document.createElement('label');label.className='axis-field';const span=document.createElement('span');span.textContent=['X','Y','Z'][i];const input=document.createElement('input');input.type='number';input.id='v-'+key;input.step=group==='rotation'?'1':'0.1';input.inputMode='decimal';input.setAttribute('aria-label',group+' '+span.textContent);input.onchange=()=>{let value=Number(input.value);if(!Number.isFinite(value)){renderInspector();return;}value=Math.max(group==='scale' ? 0.02 : -100000,Math.min(100000,value));edit(()=>{const e=current();if(e)e[key]=value;});};label.append(span,input);document.querySelector('[data-vector="'+group+'"]').append(label);}
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
 document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{try{add(b.dataset.add);}catch(e){toast(e.message);}});
 document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{tool=b.dataset.tool;document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('selected',x===b));updateSelection();});
 $('play').onclick=()=>play();$('pause').onclick=togglePause;$('stop').onclick=()=>stop();$('reset').onclick=()=>{const active=['play','paused'].includes(mode);stop(false);resetCamera();if(active)play();else toast('Preview reset');};$('undo').onclick=undo;$('redo').onclick=redo;
 $('focus').onclick=focusSelected;$('focus-inspector').onclick=focusSelected;$('home-view').onclick=resetCamera;
 $('entity-name').onchange=e=>edit(()=>{if(current())current().name=e.target.value;});$('entity-active').onchange=e=>edit(()=>{if(current())current().active=e.target.checked;});$('entity-color').onchange=e=>edit(()=>{if(current())current().color=e.target.value;});
 $('snap').onchange=()=>{const value=Number($('snap').value);transform.setTranslationSnap(value||null);transform.setRotationSnap(value?Math.PI/12:null);transform.setScaleSnap(value ? 0.1 : null);};
 $('duplicate').onclick=()=>edit(()=>{const old=current();if(old){const e=clone(old);e.id=uuid();e.name=uniqueName(old.name);e.x+=1;project.entities.push(e);selectedId=e.id;}});
 $('delete').onclick=()=>edit(()=>{project.entities=project.entities.filter(e=>e.id!==selectedId);selectedId=null;});
 $('source').addEventListener('focus',()=>{sourceBaseline=project.source;});$('source').addEventListener('input',()=>{project.source=$('source').value;lineNumbers();scheduleSave();$('compile-state').textContent='Edited · press Play to compile';});$('source').addEventListener('blur',commitCode);$('source').addEventListener('scroll',()=>{$('line-numbers').scrollTop=$('source').scrollTop;});$('source').addEventListener('click',cursorPosition);$('source').addEventListener('keyup',cursorPosition);
 $('source').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,p=t.selectionStart,end=t.selectionEnd;t.setRangeText('    ',p,end,'end');t.dispatchEvent(new Event('input'));}});
 $('copy-source').onclick=()=>copy(project.source).catch(e=>toast(e.message));
 $('copy-prompt').onclick=()=>copy(prompt()).catch(e=>toast(e.message));
 $('paste-reply').onclick=async()=>{try{$('ai-reply').value=await navigator.clipboard.readText();}catch{$('ai-reply').focus();toast('Long-press the response box and choose Paste.');}};
 $('apply-reply').onclick=()=>{try{applyReply($('ai-reply').value);toast('Applied. Review C# and press Play.');}catch(e){toast(e.message);log('Import rejected: '+e.message,'error');}};
 $('project-name').onchange=e=>{const name=e.target.value;if(!name){e.target.value=project.name;return;}edit(()=>project.name=name);};
 $('save-project').onclick=()=>{commitCode();if(saveNow())toast('Saved in this browser');};
 $('export-project').onclick=()=>{commitCode();download((project.name.replace(/[^a-z\d_-]/gi,'_')||'Project')+'.engine40k.json',JSON.stringify(project,null,2));};
 $('export-cs').onclick=()=>download('Game.cs',project.source,'text/plain');
 $('import-project').onclick=()=>$('file-import').click();$('file-import').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('Project file is larger than this prototype supports.');applyProject(JSON.parse(await file.text()));}catch(error){toast(error.message);log(error.message,'error');}finally{e.target.value='';}};
 $('new-project').onclick=()=>{if(confirm('Start an empty project? The current project will remain available in Undo.'))applyProject({engine40k:1,name:'Untitled',source:EMPTY_SOURCE,entities:[]});};
 $('demo-project').onclick=()=>{if(confirm('Load Crystal Garden? The current project will remain available in Undo.')){applyProject(demo());resetCamera();}};
 $('restore-backup').onclick=()=>{try{const backup=localStorage.getItem(BACKUP);if(!backup)throw new Error('No backup exists yet.');applyProject(JSON.parse(backup));}catch(e){toast(e.message);}};
 $('clear-console').onclick=()=>{logs.length=0;renderLogs();};$('about-btn').onclick=()=>$('about').showModal();$('close-about').onclick=()=>$('about').close();
 let drag=null,lastTap=0;
 $('drawer-head').addEventListener('pointerdown',e=>{if(e.target.closest('button')&&e.target.closest('button').id!=='grip')return;drag={id:e.pointerId,y:e.clientY,height:$('drawer').getBoundingClientRect().height};$('drawer-head').setPointerCapture(e.pointerId);e.preventDefault();});
 $('drawer-head').addEventListener('pointermove',e=>{if(drag&&drag.id===e.pointerId)setDrawer(drag.height+drag.y-e.clientY);});
 $('drawer-head').addEventListener('pointerup',e=>{if(!drag)return;const isTap=Math.abs(e.clientY-drag.y)<5;drag=null;if(isTap){const now=performance.now();if(now-lastTap<350){setDrawer($('drawer').getBoundingClientRect().height>160?108:innerHeight*.46);lastTap=0;}else lastTap=now;}});$('drawer-head').addEventListener('pointercancel',()=>drag=null);
 window.addEventListener('resize',()=>{if($('drawer').getBoundingClientRect().height>innerHeight-64)setDrawer(innerHeight-64);});
 let joyId=null;const joy=$('joystick');
 function joyMove(e){const box=joy.getBoundingClientRect(),radius=box.width*.32;let x=(e.clientX-box.left-box.width/2)/radius,z=(e.clientY-box.top-box.height/2)/radius;const len=Math.hypot(x,z);if(len>1){x/=len;z/=len;}$('stick').style.transform=`translate(${x*radius}px,${z*radius}px)`;const forward=new THREE.Vector3();camera.getWorldDirection(forward);forward.y=0;forward.normalize();const right=new THREE.Vector3(-forward.z,0,forward.x);movement.x=right.x*x-forward.x*z;movement.z=right.z*x-forward.z*z;}
 joy.onpointerdown=e=>{joyId=e.pointerId;joy.setPointerCapture(e.pointerId);joyMove(e);e.preventDefault();};joy.onpointermove=e=>{if(e.pointerId===joyId)joyMove(e);};const release=()=>{joyId=null;movement={x:0,z:0};$('stick').style.transform='';};joy.onpointerup=release;joy.onpointercancel=release;
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='play')togglePause();});
 window.addEventListener('beforeunload',()=>saveNow());
 window.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}if(e.key==='Escape')stop();});
}
try{
 let saved;try{saved=localStorage.getItem(STORE);project=saved?validate(JSON.parse(saved)):demo();}catch{project=demo();}
 sourceBaseline=project.source;wire();init3D();loaded=true;selectedId=project.entities.find(e=>e.name==='Player')?.id||null;refreshProject(true);$('loading-card').hidden=true;
 log('Editor ready. Scene editing and project export are local.');
 setTimeout(()=>ensureRuntime().catch(()=>{}),150);
 window.engine40k={version:'0.1.0',getProject:()=>clone(project),applyProject,applyReply,add,select,undo,redo,play,stop,pause:togglePause,save:saveNow,getState:()=>({mode,workerStatus,snapshot:clone(lastSnapshot),compiledMs,tickMs,selectedId,history:history.length,future:future.length}),getLogs:()=>clone(logs),getPrompt:prompt,setDrawer,setTab,resetCamera,projectPoint:(id)=>{const o=objects.get(id);if(!o)return null;const p=o.position.clone().project(camera),r=renderer.domElement.getBoundingClientRect();return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};},getViewport:()=>({width:renderer.domElement.width,height:renderer.domElement.height,aspect:camera.aspect,position:camera.position.toArray(),target:orbit.target.toArray()})};
}catch(error){$('loading-card').hidden=false;$('loading-text').textContent='The editor could not start.';$('load-error').textContent=error.message;console.error(error);}
})();
