"""Apply narrowly checked source corrections; idempotent after source is committed."""
from pathlib import Path
root=Path(__file__).resolve().parent

def replace(path,old,new):
 s=path.read_text()
 if old not in s:
  if new in s:return
  raise RuntimeError('Source correction no longer matches '+path.name+': '+old[:100])
 if s.count(old)!=1:raise RuntimeError('Ambiguous correction in '+path.name)
 path.write_text(s.replace(old,new))

p=root/'editor.js'
replace(p,'if(sourceBaseline && sourceBaseline!==project.source)', 'if(sourceBaseline!==project.source)')
replace(p,
 "function edit(action){if(mode!=='edit'){toast('Stop the game before editing the scene.');return false;}commitCode();const before=take();action();project=validate(project);pushHistory(before);sourceBaseline=project.source;refreshProject();scheduleSave();return true;}",
 """function edit(action){
 if(mode!=='edit'){toast('Stop the game before editing the scene.');return false;}
 commitCode();const before=take(), previousSelection=selectedId;
 try{action();project=validate(project);}catch(error){
  project=JSON.parse(before);selectedId=previousSelection;refreshProject();
  toast(error.message);log('Edit rejected: '+error.message,'error');return false;
 }
 pushHistory(before);sourceBaseline=project.source;refreshProject();scheduleSave();return true;
}""")
replace(p,
 "function resetCamera(){if(!camera)return;camera.position.set(10,10,13);orbit.target.set(0,0,0);orbit.update();}",
 """function resetCamera(){
 if(!camera)return;
 // Fit the demo's width in portrait without tying projection to panel size.
 const distance=Math.max(20,17/(2*Math.tan(camera.fov*Math.PI/360)*camera.aspect));
 camera.position.set(10,10,13).normalize().multiplyScalar(Math.min(60,distance));
 orbit.target.set(0,0,0);orbit.update();
}""")
replace(p,
 "renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();",
 "renderer.setSize(w,h,false);camera.aspect=w/h;camera.setViewOffset(w,h,0,h*0.16,w,h);camera.updateProjectionMatrix();")
replace(p,
 "const hit=ray.intersectObjects([...objects.values()].filter(o=>o.visible),false)[0];if(mode==='play')",
 """let hit=ray.intersectObjects([...objects.values()].filter(o=>o.visible),false)[0];
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
 if(mode==='play')""")
replace(p,"group==='scale'?.02:-100000", "group==='scale' ? 0.02 : -100000")
replace(p,"transform.setScaleSnap(value?.1:null)", "transform.setScaleSnap(value ? 0.1 : null)")
replace(p,"worker.onerror=e=>fatal(e.message||'The C# worker could not start.');",
 "worker.onerror=e=>fatal(e.message||('The C# worker could not start.'+(e.filename?' '+e.filename+':'+e.lineno:'')));")

p=root/'package_single.py'
replace(p,
 "const w=new Worker(url,{type:'module'});setTimeout(()=>URL.revokeObjectURL(url),1000);return w;",
 "const w=new Worker(url);const release=()=>URL.revokeObjectURL(url);w.addEventListener('message',release,{once:true});w.addEventListener('error',release,{once:true});const kill=w.terminate.bind(w);w.terminate=()=>{release();kill();};return w;")
print('Focused source corrections applied or already present.')
